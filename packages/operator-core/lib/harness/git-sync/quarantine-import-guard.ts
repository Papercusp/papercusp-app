/**
 * The git-sync QUARANTINE-IMPORT guard (EI-19932544083689229 remedy #1 — ATOMICITY).
 *
 * content-guard.ts and deletion-import-guard.ts already EXCLUDE ("quarantine") a
 * broken dirty file from this commit's `git add -A` (D-001: quarantine-don't-stall).
 * But quarantining a file P ALONE is unsafe when this SAME commit also contains a
 * clean file that imports P: the importer commits (nothing wrong with ITS text),
 * P does not (still dirty on disk), and HEAD now carries an unresolvable relative
 * import with no local recovery — every ISOLATED checkout (what green-checkpoint
 * builds candidates from) gets the importer WITHOUT its subject and fails
 * deterministically on every candidate, forever, while every standard staleness
 * probe reads "stale red, ignore it" (the working tree still has P sitting right
 * there, undetectably to `git log`/`git status`, which know nothing about it).
 *
 * MEASURED LIVE 2026-08-09 (EI-19932544083689229): content-guard quarantined a
 * NUL-byte source (`cup-spawn-health-watchdog.ts`); its clean sibling
 * `cup-spawn-health-watchdog.test.ts` — which `import`s it via a relative
 * specifier — committed anyway. This red-pinned the fleet's release gate for ~6h.
 * Neither content-guard (per-file, never looks at OTHER dirty files) nor
 * deletion-import-guard (only checks DELETIONS, not quarantines) catches this — it
 * needs a THIRD cross-file check: does any surviving dirty file import an
 * ALREADY-QUARANTINED file?
 *
 * Mirrors deletion-import-guard's shape and reuses its specifier extraction/
 * resolution helpers, but:
 *   - the "at risk" set is the QUARANTINED-OFFENDER set (oversized + content +
 *     deletion offenders already computed this tick), not deletions;
 *   - candidates are drawn from THIS TICK's DIRTY files only (an already-committed
 *     importer sitting in HEAD cannot import a file that has never been committed —
 *     there is nothing to protect there), never a repo-wide `git grep` — cheaper
 *     and exactly scoped to the class this guard exists for;
 *   - it runs to a FIXED POINT so a chain (C imports B imports quarantined A) is
 *     caught too, not just the direct importer (quarantine the WHOLE infected
 *     component, never just one edge of it).
 *
 * Feeds the SAME `ContentOffender`/exclude-pathspec pipeline `commitOneRepo`
 * already wires through content-guard + deletion-guard — no new commit-path
 * plumbing. Same fail-open posture throughout: a read error skips that file,
 * never blocks the commit (a guard bug must never wedge the whole fleet's commit).
 */
import type { ContentOffender } from './content-guard';
import { extractRelativeImportSpecifiers, resolveRelativeSpecifier, normalizeModulePath, RESOLVABLE_EXTS } from './deletion-import-guard';

export interface QuarantineImportGuardDeps {
  /** Read a repo-relative file's CURRENT working-tree text; null when unreadable/gone
   *  (a deletion in the dirty set, or a genuinely unreadable file — either way, nothing
   *  to scan for imports). */
  readText: (relPath: string) => Promise<string | null>;
  /** The dirty file paths under consideration for THIS commit (same path-space as
   *  content-guard/deletion-guard's `git status --porcelain -z -uall` listing — may
   *  include deletions; `readText` naturally returns null for those and they're
   *  skipped). */
  dirtyFiles: string[];
  /** Paths ALREADY excluded from this commit before this guard runs (oversized +
   *  content-guard + deletion-guard offenders) — the "infectious" set an importer
   *  must be held back alongside. */
  alreadyQuarantined: string[];
  /** Whether a quarantined path still resolves from the committed HEAD tree. A
   *  tracked-but-modified dependency remains available to an importer in HEAD,
   *  so it is safe for that importer to commit while the dependency stays dirty.
   *  When omitted, the historical conservative behavior treats every quarantined
   *  path as absent from HEAD (useful for the pure guard tests). */
  isResolvableAtHead?: (relPath: string) => Promise<boolean>;
  /** Human-readable source of the exclusion for the diagnostic; defaults to the
   *  historical content/deletion guard wording. */
  exclusionLabel?: string;
  log?: (m: string) => void;
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

/** Only resolvable JS/TS source is worth scanning for import specifiers — mirrors
 *  deletion-import-guard's `isCheckedModuleDeletion` extension gate (no `.d.ts`, since
 *  a type-only declaration file is not what breaks a runtime `import`). */
function isScannableCandidate(path: string): boolean {
  if (path.endsWith('.d.ts')) return false;
  return RESOLVABLE_EXTS.some((ext) => path.endsWith(ext));
}

/**
 * Detect dirty files that (transitively) import an already-quarantined path. Returns
 * `ContentOffender`-shaped records so `commitOneRepo` can fold them into the SAME
 * exclude/quarantine/escalation pipeline as an oversized blob, a broken .mdx, or an
 * unsafe deletion — no new commit-path plumbing.
 */
export async function detectQuarantineImporters(deps: QuarantineImportGuardDeps): Promise<ContentOffender[]> {
  const {
    readText,
    dirtyFiles,
    alreadyQuarantined,
    isResolvableAtHead,
    exclusionLabel = 'content/deletion guard',
    log,
  } = deps;
  if (alreadyQuarantined.length === 0) return [];
  // A quarantined file that is already present in HEAD is not infectious: the
  // importer committed by this tick still resolves the prior, committed copy.
  // Only a dependency absent from HEAD can make an importer unresolvable in an
  // isolated checkout. Keep the conservative old behavior when the HEAD seam is
  // omitted by a caller that only wants the pure detector semantics.
  const infectiousPaths: string[] = [];
  for (const path of [...new Set(alreadyQuarantined)]) {
    let presentAtHead = false;
    if (isResolvableAtHead) {
      try {
        presentAtHead = await isResolvableAtHead(path);
      } catch (e) {
        log?.(`[quarantine-import-guard] could not check ${path} in HEAD — treating it as absent (fail safe): ${errMsg(e)}`);
      }
    }
    if (!presentAtHead) infectiousPaths.push(path);
  }
  if (infectiousPaths.length === 0) return [];

  const quarantined = new Set(infectiousPaths);
  // Normalized targets an importer's resolved specifier must match — precomputed once.
  const quarantinedNormalized = new Set(infectiousPaths.map((p) => normalizeModulePath(p)));

  const candidates = [...new Set(dirtyFiles)].filter((f) => isScannableCandidate(f) && !quarantined.has(f));
  if (candidates.length === 0) return [];

  // Read every candidate's specifiers ONCE (fixed-point iteration below reuses this —
  // no re-reading a file just because it wasn't infected on an earlier pass).
  const specsByFile = new Map<string, string[]>();
  await mapPool(candidates, MAX_READ_CONCURRENCY, async (file) => {
    let text: string | null;
    try {
      text = await readText(file);
    } catch (e) {
      log?.(`[quarantine-import-guard] could not read ${file} — skipping (not blocking): ${errMsg(e)}`);
      return;
    }
    if (text == null) return; // gone/unreadable (e.g. a deletion in the dirty set)
    specsByFile.set(file, extractRelativeImportSpecifiers(text));
  });

  const offenders: ContentOffender[] = [];
  // Fixed point: newly-quarantined importers can themselves be imported by another
  // dirty file, so keep sweeping until a pass adds nothing new.
  let changed = true;
  while (changed) {
    changed = false;
    for (const file of candidates) {
      if (quarantined.has(file)) continue;
      const specs = specsByFile.get(file);
      if (!specs || specs.length === 0) continue;
      for (const spec of specs) {
        const resolved = resolveRelativeSpecifier(file, spec);
        if (!quarantinedNormalized.has(resolved)) continue;
        // Which already-quarantined path this resolves to (for the error message —
        // several could normalize the same; report the first match).
        const target = infectiousPaths.find((p) => normalizeModulePath(p) === resolved) ?? resolved;
        quarantined.add(file);
        quarantinedNormalized.add(normalizeModulePath(file));
        offenders.push({
          file,
          detectorKey: 'quarantined-importer',
          error:
            `imports '${spec}' → '${target}', which is EXCLUDED from this commit (${exclusionLabel}). ` +
            `Committing this file alone could leave HEAD without the dependency changes its import needs — ` +
            `holding it back until '${target}' is resolved.`,
          fixerRole: 'content-fixer',
        });
        changed = true;
        break; // one match is enough to quarantine this file; move to the next candidate
      }
    }
  }
  return offenders;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
