/**
 * insight-staleness.ts — the agent-insights staleness collector
 * (learning-system-audit-improvements-2026-06-09 P-051).
 *
 * Insights (the procedural runbooks under agent-insights/) only go stale
 * MANUALLY today — someone must notice a runbook cites code that no longer
 * exists and flip its frontmatter `status`. Nothing sweeps for it, so wrong
 * runbooks keep being injected into agent preludes.
 *
 * This collector closes that edge as just-another-objective-signal: an ACTIVE
 * insight whose body cites repo files that no longer exist files a
 * `kind=change` minor improvement ("review for superseded") through the
 * normal watchdog capture path — search-first dedup, per-tick caps, the
 * triage routine then routes it. Queue-as-memory applies: rejecting the
 * capture records the decidedReason for the next sweep.
 *
 * Pure core (`scanInsightStaleness`) + thin fs glue (`collectInsightStalenessSignals`).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { WatchdogSignal } from './watchdog';

/** A loaded insight file: slug + frontmatter status + the raw body. */
export interface InsightFileForScan {
  slug: string;
  status: string;
  raw: string;
  /** Frontmatter `discovered:` date (YYYY-MM-DD), if present — drives the recency guard. */
  discovered?: string;
}

/**
 * Backticked tokens that look like specific repo files: anchored at a known
 * top-level dir, no globs/placeholders, and a real file extension. Deliberately
 * conservative — a missed citation is fine, a false "stale" capture is noise.
 */
const REPO_PATH_RE = /^(?:apps|packages|libs|scripts|bin)\/[\w@./-]+\.[a-z]{1,5}$/;

/**
 * Words that mark a backticked path as a HISTORICAL reference — the insight is
 * narrating a file it MOVED OFF / that was removed/replaced, not asserting a live
 * dependency. A path in such context must not be flagged "stale": that's the
 * dominant false positive for migration/retirement runbooks (EI-510 Class 1; the
 * "code insights bind knowledge to code paths" complaint EI-449). Conservative,
 * consistent with the module's stated posture (a missed citation is fine; a
 * false "stale" capture is noise).
 *
 * Matched against the path's enclosing SENTENCE, not its own line (EI-18680208809300804).
 * Line scope silently depends on where prose happens to wrap:
 * `plans-egress-is-poll-frequency-not-payload` says
 *
 *     - Meta-gotcha …: `libs/generic/sync/src/transports/polling/batch-fetcher.ts`
 *       (deleted 2026-07-26; the delta wiring now lives in its replacement, …)
 *
 * — an explicit acknowledgement sitting one line below the path, invisible to a
 * line-scoped test, so the insight was flagged for citing a file it documents as
 * deleted.
 *
 * The sentence is the right unit because it is what BINDS a marker to a path.
 * Widening only to the paragraph would over-suppress the opposite case, which is
 * equally real: "An old file was removed.\nSee `packages/x/live.ts`." is one
 * paragraph in which the marker belongs to a DIFFERENT file, and `live.ts` must
 * still be checked. A sentence boundary separates those two; a line break does
 * not reliably separate either.
 *
 * These are STRONG markers: each is a deliberate statement ABOUT A FILE, so one
 * occurrence suppresses that path everywhere in the doc (see the per-PATH rule in
 * extractCitedPaths).
 */
const REMOVAL_MARKER_RE =
  /\b(?:used to|moved (?:off|from|to|onto)|moved the|no longer|removed|deleted|retired|replaced|superseded|since deleted|migrated (?:off|from|onto)|formerly|previously|was (?:at|in)|lived (?:at|in)|old(?:er)? (?:path|location)|deprecated)\b/i;

/**
 * WEAK markers — words that mean "removed" HERE but are ordinary English elsewhere,
 * so they suppress only the sentence they appear in and never the whole document.
 *
 * `gone` earns its place by measurement (EI-20565868233772131).
 * `starlight-migration-2026-05-20` says, under a heading reading "Both fumadocs
 * setups were removed":
 *
 *     `apps/operator/source.config.ts`, `apps/operator/lib/source.ts`, … are all gone.
 *
 * Every strong marker the sentence could have used sits in a NEIGHBOURING sentence
 * ("removed" in the heading, "retired" in the next line), and sentence scope
 * correctly refuses to reach either — so the runbook was flagged for citing two
 * files it exists to document as deleted, escalated, severity-bumped minor→major,
 * and survived a triage round that read the flag as genuine.
 *
 * It is WEAK because the same word is routine prose about non-files, and the
 * per-PATH rule would then erase a live citation elsewhere in the doc. Measured
 * over all 784 insights: treating `gone` as strong retired 2 false positives but
 * HID 2 real ones — `pg-connection-exhaustion-too-many-clients` cites
 * `libs/papercusp/libs/db/src/connection.ts` twice, once in a sentence about a
 * network peer ("the client is gone"), and `federation-public-release-known-
 * limitations` cites `bin/local-matrix.sh` three times the same way. Sentence-local
 * scoping keeps both flagged while still silencing the runbook above.
 *
 * Add a word here, not to REMOVAL_MARKER_RE, whenever it is a word people also use
 * about things that are not files.
 */
const WEAK_REMOVAL_MARKER_RE = /\bgone\b/i;

/**
 * Sentence-terminator followed by whitespace. Applied to backtick-MASKED text so a
 * filename's own dots (`batch-fetcher.ts`) can never read as a sentence boundary.
 */
const SENTENCE_BREAK_RE = /[.!?](?=\s)/g;

export function extractCitedPaths(raw: string): string[] {
  const clean = new Set<string>();
  const acknowledgedRemoved = new Set<string>();
  // Mask every backticked span with same-length filler ONCE, so offsets still line
  // up with `raw` while filenames contribute neither sentence breaks nor marker
  // words (a file literally named `removed.ts` must not self-suppress).
  const masked = raw.replace(/`[^`]*`/g, (s) => ' '.repeat(s.length));
  for (const m of raw.matchAll(/`([^`\n]+)`/g)) {
    const token = m[1].trim();
    // Exclude globs (`*`), placeholders (`<x>`), spaces, and ELLIPSIS placeholders
    // (`apps/operator/app/.../page.tsx` — an author's "some path under here", EI-510):
    // any run of ≥2 dots is a path elision, never a real filename component.
    if (token.includes('*') || token.includes('<') || token.includes(' ') || token.includes('..'))
      continue;
    // node_modules is an installed dependency tree, not repo source: gitignored,
    // pnpm/npm-hoist-variable, and never a runbook citation that meaningfully "goes
    // stale" — citing a dep's .d.ts shouldn't perpetually flag the insight (EI-510).
    if (token.includes('/node_modules/')) continue;
    if (!REPO_PATH_RE.test(token)) continue;
    // Class 1 (EI-510): a path the insight ACKNOWLEDGES as removed/moved is a
    // historical reference, not a live dependency. Detect a removal/move marker in
    // the path's enclosing SENTENCE — a wrapped sentence puts the marker on the
    // next line, while a sentence boundary is what actually separates a marker
    // about a DIFFERENT file (see REMOVAL_MARKER_RE).
    const idx = m.index ?? 0;
    // Never look past a blank line: a paragraph break ends a sentence even without
    // punctuation (a bullet list, a heading).
    const blockStart = masked.lastIndexOf('\n\n', idx);
    const blockEndRaw = masked.indexOf('\n\n', idx);
    const lo = blockStart === -1 ? 0 : blockStart + 2;
    const hi = blockEndRaw === -1 ? masked.length : blockEndRaw;
    let sentStart = lo;
    let sentEnd = hi;
    SENTENCE_BREAK_RE.lastIndex = lo;
    for (let b = SENTENCE_BREAK_RE.exec(masked); b && b.index < hi; b = SENTENCE_BREAK_RE.exec(masked)) {
      if (b.index < idx) sentStart = b.index + 1;
      else {
        sentEnd = b.index + 1;
        break;
      }
    }
    const prose = masked.slice(sentStart, sentEnd);
    if (REMOVAL_MARKER_RE.test(prose)) acknowledgedRemoved.add(token);
    // A WEAK marker suppresses only THIS occurrence: the token is neither trusted
    // as a live citation nor added to the doc-wide acknowledged set, so a path
    // cited cleanly elsewhere survives. A path whose ONLY occurrences are
    // weak-marked never reaches `clean`, so it is still dropped.
    else if (WEAK_REMOVAL_MARKER_RE.test(prose)) continue;
    else clean.add(token);
  }
  // Per-PATH (not per-occurrence): a path the insight marks as removed/moved ANYWHERE
  // is dropped even when it also appears on a clean line — e.g. a runbook that both
  // documents "`x.ts` was removed" AND shows the removed file in an example. Otherwise
  // the clean occurrence keeps re-flagging an insight that already acknowledges the
  // removal (the live-pg-regression-sentinel false positive). EI-510.
  return [...clean].filter((p) => !acknowledgedRemoved.has(p));
}

/**
 * Build a suffix-aware existence check from the repo's tracked-file list. A cited
 * path resolves when it exists EXACTLY or is a path-suffix of a real file — the
 * DROPPED-PREFIX shorthand authors use (`bin/hono-host.ts` for the real
 * `apps/operator/bin/hono-host.ts`), the dominant insight-staleness false positive
 * (EI-510 "stale path prefixes"; relight-self-learning-edges P-011). A genuinely
 * deleted/moved file has no suffix match and is still flagged. Strongly biased
 * toward NOT flagging — the module's stated posture ("a false 'stale' capture is
 * noise"). Matching is on whole path components (the `/`-anchored suffix), so
 * `core/loopback-fetch.ts` does NOT match `.../lib/loopback-fetch.ts`.
 */
export function makeRepoPathResolver(
  trackedFiles: readonly string[],
): (repoRelPath: string) => boolean {
  const exact = new Set(trackedFiles);
  const byBasename = new Map<string, string[]>();
  for (const f of trackedFiles) {
    const base = f.slice(f.lastIndexOf('/') + 1);
    const list = byBasename.get(base);
    if (list) list.push(f);
    else byBasename.set(base, [f]);
  }
  return (p) => {
    if (exact.has(p)) return true;
    const base = p.slice(p.lastIndexOf('/') + 1);
    const candidates = byBasename.get(base);
    if (!candidates) return false;
    const suffix = `/${p}`;
    return candidates.some((f) => f.endsWith(suffix));
  };
}

/**
 * Basename-only existence: does a file with this path's basename exist ANYWHERE in
 * the repo? Looser than makeRepoPathResolver's `/`-anchored suffix match — used ONLY
 * as a guard against a WRONGFUL apoptotic "supersede" (EI-510 Class 2). When every
 * cited path is "missing" by the strict suffix check but their basenames exist
 * elsewhere, the insight almost certainly has path-prefix drift (e.g. `core/x.ts`
 * for the real `.../lib/x.ts`), not a vanished evidence base — so the verdict should
 * be "repoint", never "retire a current, valid runbook".
 */
export function makeRepoBasenameResolver(
  trackedFiles: readonly string[],
): (repoRelPath: string) => boolean {
  const basenames = new Set<string>();
  for (const f of trackedFiles) basenames.add(f.slice(f.lastIndexOf('/') + 1));
  return (p) => basenames.has(p.slice(p.lastIndexOf('/') + 1));
}

/**
 * Compose the three ways a cited path can legitimately resolve, in one place.
 *
 * The third leg is the one that is easy to miss (EI-16474). A path can be
 * GITIGNORED **and** absent from disk and still be a perfectly live citation —
 * a runtime artifact the runbook teaches you to read while diagnosing a
 * failure. `apps/operator-vite/.vite-build-failure.json` is the case that
 * exposed it: it is dropped beside `dist/` only by a FAILED build, so it is
 * never tracked and is absent exactly when the tree is healthy.
 *
 * That makes the tracked-or-on-disk test structurally unable to settle the
 * question: the condition under which the file would exist is the condition the
 * runbook exists to help you escape, so the signal re-files forever and no
 * amount of resolving it sticks. The on-disk fallback was already reaching for
 * this class ("gitignored-but-present files … e.g. `apps/operator/.env.local`")
 * but only catches it when the file happens to be materialised.
 *
 * An ignore RULE, unlike the file's momentary presence, is a stable statement
 * that the path is generated rather than source — so a path matching one is
 * never evidence that a runbook has gone stale.
 */
export function makeCitationResolver(opts: {
  /** `git ls-files` output, or null when git is unavailable (packaged build). */
  trackedFiles?: readonly string[] | null;
  /** Paths matching a .gitignore rule — generated, so absence proves nothing. */
  ignoredPaths?: readonly string[];
  /** On-disk existence check (repo-relative). */
  existsOnDisk?: (repoRelPath: string) => boolean;
}): (repoRelPath: string) => boolean {
  const trackedResolver = opts.trackedFiles ? makeRepoPathResolver(opts.trackedFiles) : null;
  const ignored = new Set(opts.ignoredPaths ?? []);
  const existsOnDisk = opts.existsOnDisk ?? (() => false);
  return (p) => (trackedResolver ? trackedResolver(p) : false) || ignored.has(p) || existsOnDisk(p);
}

/**
 * Resolution cooldown for insight-staleness signals (EI-441 / EI-427). After an
 * insight-staleness item is resolved, the fix lands on the source-of-truth tree
 * (staging) but the live operator scans the release/green checkout, which lags
 * by the deploy window — so the same citation still reads as missing and the
 * signal re-files under a new id (the EI-413→EI-430 loop). Suppressing re-files
 * for this window after a resolution lets the fix propagate. 7 days comfortably
 * covers a normal deploy (and the abnormal green-checkpoint stalls seen during
 * alpha) while still re-surfacing a fix that genuinely never deployed.
 */
export const DEFAULT_INSIGHT_RESOLUTION_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

export interface ScanOpts {
  /** Cap signals per sweep (the watchdog has its own per-tick cap on top). */
  maxSignals?: number;
  /** Cooldown (ms) stamped on each signal. Default DEFAULT_INSIGHT_RESOLUTION_COOLDOWN_MS. */
  resolutionCooldownMs?: number;
  /** "Now" for the recency guard. Default Date.now(). */
  nowMs?: number;
  /**
   * Skip insights discovered within this window — a freshly-written insight may
   * cite files that exist on the source tree (staging) but not yet on the scanned
   * green/release tree (deploy lag), the new-insight analog of the post-resolution
   * cooldown. Default DEFAULT_INSIGHT_RESOLUTION_COOLDOWN_MS (EI-510 / P-011).
   */
  recencyGuardMs?: number;
  /**
   * Basename-only existence guard for the apoptotic verdict (EI-510 Class 2). When
   * EVERY cited path is missing by the strict suffix check but a basename match exists
   * elsewhere in the repo, the insight has path-prefix drift — so DOWNGRADE the
   * "supersede" verdict to "repoint" rather than wrongly retire a valid runbook. Omit
   * to keep the legacy strict apoptotic verdict (every-citation-missing ⇒ supersede).
   */
  basenameExistsFn?: (repoRelPath: string) => boolean;
}

/**
 * Pure: which active insights cite files that no longer exist?
 * `existsFn` takes a repo-relative path.
 */
export function scanInsightStaleness(
  insights: InsightFileForScan[],
  existsFn: (repoRelPath: string) => boolean,
  opts: ScanOpts = {},
): WatchdogSignal[] {
  const maxSignals = opts.maxSignals ?? 5;
  const resolutionCooldownMs = opts.resolutionCooldownMs ?? DEFAULT_INSIGHT_RESOLUTION_COOLDOWN_MS;
  const nowMs = opts.nowMs ?? Date.now();
  const recencyGuardMs = opts.recencyGuardMs ?? DEFAULT_INSIGHT_RESOLUTION_COOLDOWN_MS;
  const signals: WatchdogSignal[] = [];
  for (const insight of insights) {
    if (signals.length >= maxSignals) break;
    const status = (insight.status || 'active').toLowerCase();
    if (status === 'retired' || status === 'superseded') continue;
    // Recency guard (EI-510 / P-011): a newly-written insight's citations may not
    // have deployed to the scanned (green/release) tree yet — the new-insight
    // analog of the post-resolution deploy-lag cooldown. Skip until the window passes.
    if (insight.discovered) {
      const d = Date.parse(insight.discovered);
      if (!Number.isNaN(d) && nowMs - d < recencyGuardMs) continue;
    }
    const cited = extractCitedPaths(insight.raw);
    if (cited.length === 0) continue;
    const missing = cited.filter((p) => !existsFn(p));
    if (missing.length === 0) continue;
    // Apoptosis (EI-441): EVERY cited file is gone → the runbook's whole evidence
    // base has evaporated, so the guidance is almost certainly obsolete. Surface
    // it as a clean "supersede" (not "repoint") so the resolver retires it rather
    // than hunting for moved files. Partial loss stays a repoint-or-supersede review.
    //
    // Class-2 guard (EI-510): never declare apoptosis when a missing path's BASENAME
    // exists elsewhere in the repo — that's path-prefix drift, not a vanished evidence
    // base. Downgrade to a "repoint" review so a valid runbook is never wrongly retired
    // over a moved file the strict suffix check didn't catch.
    const apoptotic =
      missing.length === cited.length &&
      !(opts.basenameExistsFn !== undefined && missing.some((p) => opts.basenameExistsFn!(p)));
    signals.push({
      source: 'insight-staleness',
      key: insight.slug,
      // STABLE title (no counts) — the cross-tick search-first dedup matches on it.
      title: apoptotic
        ? `Agent insight '${insight.slug}' is obsolete — all cited files are gone (supersede)`
        : `Agent insight '${insight.slug}' cites files that no longer exist — review for superseded`,
      body: apoptotic
        ? `The active agent-insight runbook \`${insight.slug}\` cites repo file(s) that are ALL missing:\n` +
          missing.map((p) => `  - \`${p}\``).join('\n') +
          `\n\n(${missing.length} of ${cited.length} cited paths missing — every citation is gone.)\n` +
          `Its entire evidence base has been deleted or moved, so the guidance is almost certainly ` +
          `obsolete. Set frontmatter \`status: superseded\` (do NOT hunt for moved files) so it stops ` +
          `being injected into agent preludes.`
        : `The active agent-insight runbook \`${insight.slug}\` cites repo file(s) that are missing:\n` +
          missing.map((p) => `  - \`${p}\``).join('\n') +
          `\n\n(${missing.length} of ${cited.length} cited paths missing.)\n` +
          `Review the runbook: update the paths if the code moved, or set frontmatter ` +
          `\`status: superseded\` if the guidance no longer applies — a wrong runbook keeps ` +
          `being injected into agent preludes until this is done.`,
      severity: 'minor',
      kind: 'change',
      paths: [`apps/operator-docs/src/content/docs/agent-insights/${insight.slug}.mdx`],
      latestAt: new Date().toISOString(),
      // EI-427: suppress re-files for the deploy-propagation window after a
      // resolution (the scanned release tree lags the staging fix).
      resolutionCooldownMs,
    });
  }
  return signals;
}

/**
 * Tracked files at `root` incl. submodules, via `git ls-files` (cheap — git's
 * index is cached — and it excludes node_modules/.gitignore). Returns null when
 * git is unavailable (a packaged build) so the caller falls back to exact existsSync.
 */
async function listTrackedFiles(root: string): Promise<string[] | null> {
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    const { stdout } = await run('git', ['-C', root, 'ls-files', '--recurse-submodules'], {
      maxBuffer: 64 * 1024 * 1024,
    });
    const files = stdout.split('\n').filter(Boolean);
    return files.length ? files : null;
  } catch {
    return null;
  }
}

/**
 * Upper bound on how many paths we will ask git about, so a pathological docs
 * tree can never turn this collector into hundreds of subprocess calls. Only
 * paths that fail EVERY cheap check reach here, so in practice this is a
 * handful.
 */
const MAX_IGNORE_PROBES = 200;

/**
 * Which of `candidates` match a .gitignore rule at `root`.
 *
 * `git check-ignore` consults the ignore RULES, not the filesystem, so it
 * answers for a path that does not exist — which is the whole point here
 * (EI-16474): the runtime artifacts this guards are absent precisely when the
 * tree is healthy.
 *
 * ⚠ Deliberately ONE PATH PER CALL, not the far cheaper `--stdin` batch. git
 * resolves the whole batch as a single pathspec set and ABORTS ALL OF IT with
 * exit 128 on the first path that lives in a submodule ("fatal: Pathspec
 * 'libs/generic/sync/src/query-fetcher.ts' is in submodule 'libs/generic/sync'").
 * This repo has dozens of submodules, so the batch form returned zero results
 * for all 609 cited paths — indistinguishable from "nothing is ignored", which
 * is precisely the silent no-op this function exists to prevent.
 *
 * Exit codes: 0 = ignored, 1 = not ignored, 128 = pathspec error. Anything
 * other than 0 is treated as NOT ignored, so the collector degrades to the
 * previous tracked-or-on-disk behaviour rather than suppressing a real signal.
 */
async function listIgnoredPaths(root: string, candidates: readonly string[]): Promise<Set<string>> {
  const ignored = new Set<string>();
  if (candidates.length === 0) return ignored;
  try {
    const { execFile } = await import('node:child_process');
    const isIgnored = (p: string) =>
      new Promise<boolean>((resolve) => {
        execFile('git', ['-C', root, 'check-ignore', '-q', '--', p], (err) => resolve(!err));
      });
    for (const p of candidates.slice(0, MAX_IGNORE_PROBES)) {
      if (await isIgnored(p)) ignored.add(p);
    }
  } catch {
    /* git unavailable → no ignore data; existence falls back to tracked/on-disk */
  }
  return ignored;
}

/** Thin fs glue — reads the agent-insights dir + checks cited paths against the repo tree. */
export async function collectInsightStalenessSignals(): Promise<WatchdogSignal[]> {
  // Lazy-import so the pure scan stays import-cheap for tests.
  const { DOCS_CONTENT_ROOT, REPO_ROOT } = await import('../../agent-tools/docs/_repo-paths');
  const dir = path.join(DOCS_CONTENT_ROOT, 'agent-insights');
  let names: string[] = [];
  try {
    names = (await fs.promises.readdir(dir)).filter((n) => n.endsWith('.mdx') || n.endsWith('.md'));
  } catch {
    return []; // docs tree absent (packaged build) → nothing to scan
  }
  const insights: InsightFileForScan[] = [];
  for (const name of names) {
    try {
      const raw = await fs.promises.readFile(path.join(dir, name), 'utf8');
      const statusMatch = raw.match(/^status:\s*["']?([\w-]+)["']?\s*$/m);
      const discoveredMatch = raw.match(/^discovered:\s*["']?([\d-]+)["']?\s*$/m);
      insights.push({
        slug: name.replace(/\.mdx?$/, ''),
        status: statusMatch?.[1] ?? 'active',
        discovered: discoveredMatch?.[1],
        raw,
      });
    } catch {
      /* unreadable file → skip */
    }
  }
  // Suffix-aware existence (EI-510): resolve a cited path against the repo's tracked
  // files so a dropped-prefix shorthand isn't a false "stale". Fall back to an exact
  // existsSync at REPO_ROOT when git is unavailable (packaged build).
  const tracked = await listTrackedFiles(REPO_ROOT);
  // A cited path resolves if it's tracked (exact/suffix shorthand), matches a
  // .gitignore rule (generated — absence proves nothing, EI-16474), OR is present
  // on disk. The on-disk leg (EI-510) catches gitignored-but-present files that
  // `git ls-files` omits — e.g. `apps/operator/.env.local`; the ignore-rule leg
  // catches the same class when the artifact is legitimately ABSENT, which is the
  // steady state for a failure-only artifact. "Missing" now means not-tracked AND
  // not-ignored AND not-on-disk = genuinely gone.
  const existsOnDisk = (p: string) => fs.existsSync(path.join(REPO_ROOT, p));
  // Ask git ONLY about paths that fail every cheap check — that keeps the
  // one-call-per-path probe (see listIgnoredPaths) down to a handful.
  const cheapResolver = makeCitationResolver({ trackedFiles: tracked, existsOnDisk });
  const cited = [...new Set(insights.flatMap((i) => extractCitedPaths(i.raw)))];
  const unresolved = cited.filter((p) => !cheapResolver(p));
  const ignoredPaths = [...(await listIgnoredPaths(REPO_ROOT, unresolved))];
  const existsFn = makeCitationResolver({
    trackedFiles: tracked,
    ignoredPaths,
    existsOnDisk,
  });
  // Class-2 apoptosis guard (EI-510): only available with the tracked-file list; the
  // packaged-build fallback can't enumerate basenames, so apoptosis stays strict there.
  const basenameExistsFn = tracked ? makeRepoBasenameResolver(tracked) : undefined;
  return scanInsightStaleness(insights, existsFn, { basenameExistsFn });
}
