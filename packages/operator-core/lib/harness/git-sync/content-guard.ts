/**
 * The git-sync CONTENT GUARD (git-sync-content-guard-2026-06-13 P-001).
 *
 * Before git-sync's `git add -A && commit`, this enumerates the dirty
 * content-bearing files and runs each registered content detector whose scope
 * matches. Offenders ({ file, detectorKey, error }) are returned so the commit
 * path can EXCLUDE them (D-001: quarantine-don't-stall) and the action layer can
 * escalate + dispatch a content-fixer — instead of git-sync auto-committing a
 * file that hard-fails a downstream build (EI-438: a bare `<date>` broke every
 * agent's docs build for hours).
 *
 * PURE + seam-injected (runGit, readText, detectors) so it unit-tests without a
 * real repo. FAILS OPEN by design: a detector — or a file read — that THROWS is
 * logged and skipped (the file commits normally), so a content-check bug can
 * never wedge the whole fleet's commit. Only a clean "this file is broken"
 * verdict excludes a file.
 */
import { createHash } from 'node:crypto';
import type { RunGit } from './run-git-sync';
import type { ContentDetector, ContentDetectorContext } from '../../content-lint/registry';

/** One dirty file that failed a content detector — excluded from the commit + handed to the fixer. */
export interface ContentOffender {
  /** Repo-relative path within the (sub)repo. */
  file: string;
  /** Which detector flagged it (e.g. 'mdx', 'smart-quotes'). */
  detectorKey: string;
  /** Human-readable error — fed to the escalation body + the content-fixer prompt. */
  error: string;
  /** The role git-sync dispatches to fix this offender (the detector's fixerRole). */
  fixerRole: string;
  /**
   * SHA-256 of the exact working-tree text that produced this finding.
   * Optional because structural guards (deletion/import findings) have no
   * content snapshot to hash.
   */
  contentHash?: string;
  /**
   * SHA-256 of the detector identity + result that produced this finding.
   * Binding the result as well as the text prevents a dispatch from silently
   * following a detector whose verdict changed while the work was queued.
   */
  detectorResultHash?: string;
}

/** Stable content CAS token shared by the guard and action-layer revalidation. */
export function contentSnapshotHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Stable detector-result token shared by the guard and action-layer revalidation. */
export function detectorResultHash(detectorKey: string, error: string): string {
  return createHash('sha256')
    .update(JSON.stringify({ detectorKey, error }), 'utf8')
    .digest('hex');
}

export interface ContentGuardDeps {
  runGit: RunGit;
  /** Absolute path of the (sub)repo being guarded. */
  repoPath: string;
  /** Read a repo-relative file's working-tree text; null when unreadable/gone. */
  readText: (relPath: string) => Promise<string | null>;
  /**
   * Write a repo-relative file's working-tree text (WI-276 deterministic pre-pass).
   * When provided, an offender whose detector declares an `autoFix` that FULLY
   * resolves the error is repaired in place — written back so it commits this tick
   * instead of being quarantined for the LLM fixer. Omit to disable auto-repair
   * (the guard then only detects + quarantines, exactly as before).
   */
  writeText?: (relPath: string, text: string) => Promise<void>;
  /** The registered content detectors to run (default registry in production). */
  detectors: ContentDetector[];
  log?: (m: string) => void;
}

/**
 * Parse `git status --porcelain -z -uall` into the dirty, content-bearing
 * repo-relative paths. Skips DELETIONS (no content to check) and resolves the
 * `-z` rename/copy pair encoding ("XY new\0old") — the SAME parse
 * findOversizedDirtyFiles uses, kept independent so neither well-tested path
 * perturbs the other.
 */
export function parseDirtyPaths(porcelainZ: string): string[] {
  const entries = porcelainZ.split('\0').filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.length < 4) continue;
    const xy = e.slice(0, 2);
    const path = e.slice(3);
    if (xy.includes('R') || xy.includes('C')) i++; // -z renames: "XY new\0old" — skip the origin path
    if (xy.includes('D')) continue; // deletion — no working-tree blob to check
    out.push(path);
  }
  return out;
}

/** Bounded-concurrency map (avoid a serial fs loop — CLAUDE.md perf anti-patterns). */
async function mapPool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const idx = next++;
      await fn(items[idx]);
    }
  });
  await Promise.all(workers);
}

const MAX_READ_CONCURRENCY = 16;

/**
 * Run every registered detector whose `matches` is true over the dirty files,
 * collecting offenders. Only reads files at least one detector targets (no fs
 * cost for the rest). FAILS OPEN — a throwing detector/read is skipped, never an
 * offender.
 */
export async function detectContentOffenders(deps: ContentGuardDeps): Promise<ContentOffender[]> {
  const { runGit, repoPath, readText, writeText, detectors, log } = deps;
  if (detectors.length === 0) return [];

  // EI-19381677675617429 — honour `repoScope`. git-sync runs this guard for the
  // superproject AND for every submodule with the SAME detector list, while `matches`
  // only ever sees a path relative to whichever repo is being guarded — so a
  // superproject-only rule cannot scope itself and must be filtered here, where
  // `repoPath` is known.
  //
  // Resolved ONCE per invocation and ONLY when some detector actually asks, so a repo
  // with no scoped detector pays no extra git call. FAILS OPEN IN THE SAFE DIRECTION:
  // "unknown" is treated like "submodule" and DROPS the scoped detector, because the
  // costly mistake is the other way round — 45 submodule files carry identity literals
  // by design (redacted at tar time), so wrongly running a superproject-only detector
  // inside a submodule would quarantine them from every commit, fleet-wide.
  let active = detectors;
  if (detectors.some((d) => d.repoScope === 'superproject-only')) {
    const superproject = await isSuperprojectRepo(runGit, repoPath, log);
    if (!superproject) {
      active = detectors.filter((d) => d.repoScope !== 'superproject-only');
      log?.(
        `[content-guard] ${repoPath}: skipping ${detectors.length - active.length} ` +
          `superproject-only detector(s) here`,
      );
    }
  }
  if (active.length === 0) return [];

  const r = await runGit(['status', '--porcelain', '-z', '-uall'], repoPath);
  if (r.code !== 0) return []; // can't list — fail open (the commit proceeds as today)

  // Pair each dirty path with the detectors that target it; drop paths no detector wants.
  const targets: Array<{ file: string; dets: ContentDetector[] }> = [];
  for (const file of parseDirtyPaths(r.stdout)) {
    const dets: ContentDetector[] = [];
    for (const d of active) {
      try {
        if (await d.matches(file, { repoPath })) dets.push(d);
      } catch (e) {
        log?.(`[content-guard] detector "${d.key}" match() threw on ${file} — skipping: ${errMsg(e)}`);
      }
    }
    if (dets.length > 0) targets.push({ file, dets });
  }

  const offenders: ContentOffender[] = [];
  await mapPool(targets, MAX_READ_CONCURRENCY, async ({ file, dets }) => {
    let text: string | null;
    try {
      text = await readText(file);
    } catch (e) {
      log?.(`[content-guard] could not read ${file} — skipping (not blocking): ${errMsg(e)}`);
      return;
    }
    if (text == null) return; // gone/unreadable — nothing to check
    // The working-tree text we detected on — the CAS baseline for a deterministic
    // auto-repair write, so we never clobber a concurrent editor's newer content.
    let baseline = text;
    for (const d of dets) {
      try {
        const error = await d.detect(file, text, { repoPath });
        if (!error) continue;
        // WI-276 deterministic pre-pass: try the detector's own safe repair BEFORE
        // quarantining + dispatching the LLM fixer. Applied only to an ALREADY-failing
        // file, and kept only when it FULLY resolves the error (re-detect clean).
        if (d.autoFix && writeText) {
          const repaired = await tryAutoFix(d, file, text, baseline, { repoPath }, { readText, writeText, log });
          if (repaired != null) {
            text = repaired; // subsequent detectors see the repaired text
            baseline = repaired; // and future writes CAS against the just-written content
            continue; // no offender recorded — the file commits normally this tick
          }
        }
        // Not (fully) auto-repairable — quarantine + dispatch the LLM fixer, as before.
        offenders.push({
          file,
          detectorKey: d.key,
          error,
          fixerRole: d.fixerRole,
          contentHash: contentSnapshotHash(text),
          detectorResultHash: detectorResultHash(d.key, error),
        });
      } catch (e) {
        // FAIL OPEN — a content-check bug must never block the whole tree's commit.
        log?.(`[content-guard] detector "${d.key}" threw on ${file} — skipping (not blocking): ${errMsg(e)}`);
      }
    }
  });
  return offenders;
}

/**
 * Attempt the detector's deterministic `autoFix` on an already-failing file (WI-276).
 * Returns the repaired text (already written to the working tree) when the fix FULLY
 * resolves the error, or null to fall through to quarantine + the LLM fixer. Never
 * throws (a write/read failure logs + returns null so the file is quarantined instead).
 *
 * CAS-guarded: re-reads the file right before writing and only writes when it still
 * equals `baseline` — so a concurrent editor's newer content is never clobbered (the
 * broken file is simply re-evaluated on the next tick). FAIL-SAFE by construction: the
 * write happens only when the repaired text passes the SAME `detect`, so the guard can
 * never commit a file it would otherwise have quarantined.
 */
async function tryAutoFix(
  d: ContentDetector,
  file: string,
  text: string,
  baseline: string,
  context: ContentDetectorContext,
  io: {
    readText: (relPath: string) => Promise<string | null>;
    writeText: (relPath: string, text: string) => Promise<void>;
    log?: (m: string) => void;
  },
): Promise<string | null> {
  if (!d.autoFix) return null;
  let fixed: string;
  let changed: boolean;
  try {
    ({ fixed, changed } = d.autoFix(text, file));
  } catch (e) {
    io.log?.(`[content-guard] "${d.key}" autoFix threw on ${file} — quarantining instead: ${errMsg(e)}`);
    return null;
  }
  if (!changed) return null; // nothing the deterministic fixer could repair
  // Keep the repair ONLY if it fully clears the error — else the LLM fixer must look.
  let stillErr: string | null;
  try {
    stillErr = await d.detect(file, fixed, context);
  } catch (e) {
    io.log?.(`[content-guard] "${d.key}" re-detect threw on ${file} — quarantining instead: ${errMsg(e)}`);
    return null;
  }
  if (stillErr) return null; // partial fix — leave the whole file for the LLM fixer
  // CAS: never clobber a concurrent edit — only write if the file is unchanged since we read it.
  let onDisk: string | null;
  try {
    onDisk = await io.readText(file);
  } catch {
    onDisk = null;
  }
  if (onDisk !== baseline) {
    io.log?.(`[content-guard] ${file} changed under us mid-tick — skipping auto-repair (re-evaluated next tick)`);
    return null;
  }
  try {
    await io.writeText(file, fixed);
  } catch (e) {
    io.log?.(`[content-guard] auto-repair write failed for ${file} — quarantining instead: ${errMsg(e)}`);
    return null;
  }
  io.log?.(`[content-guard] auto-repaired ${file} [${d.key}] deterministically — committing this tick (no LLM fixer / no build block)`);
  return fixed;
}

/**
 * Is `repoPath` the SUPERPROJECT (rather than a submodule checkout)?
 *
 * `git rev-parse --show-superproject-working-tree` prints the parent's working tree
 * inside a submodule and NOTHING in the superproject — the cheapest reliable
 * discriminator, and it needs no knowledge of where the superproject actually is.
 *
 * @returns true only when we POSITIVELY established this is the superproject. A
 *   non-zero exit or a throw returns false, so the caller drops superproject-only
 *   detectors rather than risk running them where they do not belong.
 */
async function isSuperprojectRepo(
  runGit: RunGit,
  repoPath: string,
  log?: (m: string) => void,
): Promise<boolean> {
  try {
    const r = await runGit(['rev-parse', '--show-superproject-working-tree'], repoPath);
    if (r.code !== 0) {
      log?.(`[content-guard] ${repoPath}: could not resolve repo kind — treating as submodule`);
      return false;
    }
    return r.stdout.trim().length === 0;
  } catch (e) {
    log?.(`[content-guard] ${repoPath}: repo-kind probe threw — treating as submodule: ${errMsg(e)}`);
    return false;
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
