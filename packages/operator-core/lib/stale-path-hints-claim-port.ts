/**
 * stale-path-hints-claim-port — the claim-time "DEAD PATH HINT" guard
 * (EI-21267393427094356).
 *
 * THE CLASS THIS SURFACES: a work-item's `payload.paths` are hints frozen at
 * filing time, but modules MOVE — P-064 renamed hive/* → pot/* repo-wide while
 * EI-5927's recipe kept citing lib/hive/watchdog.ts, and any literal affected-
 * path check on the stored hint fails into a repository-wide fallback search.
 * This guard resolves each dead hint to its CURRENT location at the moment of
 * the claim, so scheduler-admitted items stop handing successors dead paths.
 *
 * RESOLUTION, bounded: for a stored path that no longer exists, find the commit that
 * DELETED it, then diff that commit against its parent WITHOUT a pathspec — a bare
 * `git log -- <dead>` can never see both sides of a rename (the destination is outside
 * the pathspec, so every status reads D), and `--follow` rewrites names but reports
 * A/D pairs against the original. The un-pathspec'd diff is where git's rename
 * detection pairs old→new (`R100<tab><old><tab><new>`); walk forward up to
 * MAX_RENAME_HOPS times until a live path is found. A delete without any rename
 * honestly reports status 'missing' rather than guessing.
 *
 * Fail-soft by design, mirroring every sibling port: a claim must never fail
 * because an advisory lookup did. If the repo is not a git work tree (or git
 * is unavailable) the leg stays SILENT for every path — "the probe could not
 * run" must never render as "every path is missing" (the WI-6737 lesson).
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { deriveRepoPathsFromText } from './agent-tools/work_items/_derive-paths';

export interface ClaimTimeStalePathHint {
  /** The stored hint exactly as filed. */
  requested: string;
  /**
   * 'moved'   = resolvedTo names the current location.
   * 'missing' = the path WAS here and was deleted, with no rename chain found.
   * 'unknown' = the path is absent AND this checkout has no history for it at all,
   *             so it was never here. See `hasAnyHistory` for why that is not 'missing'.
   */
  status: 'moved' | 'missing' | 'unknown';
  /** The current canonical path, when follow-resolution succeeded. */
  resolvedTo?: string;
}

/**
 * The title/summary counterpart to `payload.paths` hints. These are deliberately
 * plain repo-relative strings: unlike a stored path hint, a prose citation has no
 * authoritative rename history or intended disposition. Its only safe verdict is
 * that the cited path cannot be resolved in the current tree.
 */
export type ClaimTimeStalePathRef = string;

export interface ClaimTimeStalePathAdvisory {
  pathHints?: ClaimTimeStalePathHint[];
  pathHintsNote?: string;
  stalePathRefs?: ClaimTimeStalePathRef[];
  stalePathRefsNote?: string;
}

/** Bounded so a pathological rename chain can never stall the claim path. */
const MAX_RENAME_HOPS = 3;

/** Globs cannot be validated against the tree or walked through renames — skip silently. */
function isConcretePath(p: string): boolean {
  return p.length > 0 && !/[*?[\]{}]/.test(p);
}

function isContainedRepoPath(root: string, path: string): boolean {
  if (!isConcretePath(path) || isAbsolute(path)) return false;
  const candidate = resolve(root, path);
  const rel = relative(root, candidate);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

async function resolveRepoRoot(repoRoot?: string): Promise<string | null> {
  const defaultRoot = process.env.PAPERCUSP_INTEGRATION_ROOT || process.cwd();
  const candidate = resolve(repoRoot ?? defaultRoot);
  // The integration root and explicit fixture roots are already repository
  // roots. A worktree has a .git file there; an ordinary checkout has a .git
  // directory. Avoid forking `git rev-parse` for every plans:get full read,
  // where the caller asks this advisory to check many plan-item citations.
  // Nested caller paths still take the Git fallback to find their actual root.
  if (existsSync(join(candidate, '.git'))) return candidate;
  return (await git(['rev-parse', '--show-toplevel'], candidate))?.trim() || null;
}

/**
 * Exported so `sibling-path-overlap-claim-port` reads `payload.paths` through the SAME
 * accessor this guard does. Two claim-time guards keying on the same stored field must
 * not disagree about what counts as a usable path list.
 */
export function pathsOfPayload(payload: unknown): string[] | null {
  const raw = (payload as { paths?: unknown } | null | undefined)?.paths;
  if (!Array.isArray(raw)) return null;
  const paths = raw.filter((p): p is string => typeof p === 'string' && p.length > 0);
  return paths.length > 0 ? paths : null;
}

function git(args: readonly string[], cwd: string): Promise<string | null> {
  return new Promise((resolvePromise) => {
    execFile('git', args, { cwd, maxBuffer: 1 << 20 }, (err, stdout) => {
      resolvePromise(err ? null : String(stdout));
    });
  });
}

/**
 * The commit that deleted `cur` → the new name git's rename detection paired it with,
 * or null when the deletion was not a rename (or history cannot answer here).
 */
async function nextRename(cur: string, cwd: string): Promise<string | null> {
  const delCommit = (await git(['log', '--diff-filter=D', '--format=%H', '-n', '1', '--', cur], cwd))?.trim();
  if (!delCommit) return null;
  const out = await git(['diff-tree', '-r', '-M50%', '--name-status', `${delCommit}^`, delCommit], cwd);
  if (!out) return null;
  for (const line of out.split('\n')) {
    const parts = line.split('\t');
    // R100 <tab> old <tab> new — the old side must BE the path we are chasing, so an
    // unrelated rename elsewhere in the same commit can never redirect us.
    if (parts.length >= 3 && parts[0].startsWith('R') && parts[1] === cur) return parts[2];
  }
  return null;
}

/**
 * Does this checkout have ANY history for `p`? This is the discriminator between the
 * two very different situations that both present as "the file is not on disk":
 *
 *   - history EXISTS  → the path was genuinely here and is gone. 'missing' is true.
 *   - history ABSENT  → the path was NEVER in this checkout. Saying 'missing' is a FALSE
 *                       ABSENCE, and it is the failure this guard exists to avoid.
 *
 * EI-21930229853756240: measured 2026-08-31, a claim reported two present, HEAD-tracked
 * files as 'missing'. Neither was deleted — the resolver had resolved against the RELEASE
 * checkout (pinned to green `main`, which had not advanced in days), where files added to
 * staging afterwards have never existed. `existsSync` answered correctly about the WRONG
 * TREE. Both flagged paths returned no deletion commit AND no history whatsoever, while a
 * genuinely deleted file returned its deletion commit — so this check separates them
 * exactly, without the guard having to know which checkout it is standing in.
 *
 * That generality is the point: a stale deploy is only one way to end up in the wrong
 * tree, and the guard should not have to enumerate them.
 */
async function hasAnyHistory(p: string, cwd: string): Promise<boolean> {
  const out = await git(['log', '--format=%H', '-n', '1', '--', p], cwd);
  return Boolean(out && out.trim());
}

/** Resolve one dead path forward through its rename chain; null ⇒ unresolvable here. */
async function resolveMovedPath(requested: string, cwd: string): Promise<string | null> {
  let cur = requested;
  for (let hop = 0; hop < MAX_RENAME_HOPS; hop += 1) {
    const next = await nextRename(cur, cwd);
    if (!next || !isConcretePath(next)) return null;
    if (existsSync(join(cwd, next))) return next;
    cur = next;
  }
  return null;
}

/**
 * Which of the claimed item's stored payload paths no longer exist at HEAD, and
 * where each moved to. Null when: the subject carries no usable `payload.paths`
 * (the overwhelmingly common case — a normal claim is completely unaffected),
 * every stored path still exists, the repo probe cannot run (total silence —
 * see the header), or any unexpected error escapes (fail-soft, like siblings).
 */
export async function getClaimTimeStalePathHints(ref: {
  workItem?: { payload?: unknown } | null;
  payload?: unknown;
  repoRoot?: string;
}): Promise<ClaimTimeStalePathHint[] | null> {
  const payload = ref.payload ?? ref.workItem?.payload ?? null;
  const requestedPaths = pathsOfPayload(payload);
  if (!requestedPaths) return null;
  try {
    // Resolve against the WORK-TREE ROOT, not process.cwd(): the host may run
    // from any depth inside the checkout, and stored paths are repo-relative.
    //
    // EI-21895925841807401: `process.cwd()` alone is also the WRONG CHECKOUT on
    // :3070 — that operator's cwd is the release checkout (papercup-release,
    // pinned to green `main`, days stale by design), not the staging tree the
    // agent actually edits. `PAPERCUSP_INTEGRATION_ROOT` is exported into both
    // the :3070 and :3170 operator units specifically to name the staging root
    // (mirrors dev-deploy-state.ts's `resolveConfig()`, which resolves the same
    // integration root the same way for the identical reason). Honoring it here
    // fixes every current caller (scheduler:get_next, work_items:claim,
    // work_items:claim_next, claim-time-enrichment) without touching any of
    // them; `ref.repoRoot` — when a caller does supply it, e.g. these tests —
    // still wins over both.
    const topLevel = await resolveRepoRoot(ref.repoRoot);
    if (!topLevel) return null;
    const candidates = requestedPaths.filter(
      (p) => isContainedRepoPath(topLevel, p) && !existsSync(join(topLevel, p)),
    );
    if (candidates.length === 0) return null;
    const hints = await Promise.all(
      candidates.map(async (requested): Promise<ClaimTimeStalePathHint> => {
        try {
          const resolvedTo = await resolveMovedPath(requested, topLevel);
          if (resolvedTo) return { requested, status: 'moved', resolvedTo };
          // Absent AND never here ⇒ 'unknown', never 'missing'. Failing toward "I could
          // not tell" is the only safe direction: the note tells the agent to distrust
          // the stored path AND not to search for it, so a false 'missing' closes both
          // exits at once and leaves them with nowhere to go.
          return (await hasAnyHistory(requested, topLevel))
            ? { requested, status: 'missing' }
            : { requested, status: 'unknown' };
        } catch {
          // Fail-soft in the same direction as everything else here: an errored probe is
          // an unanswered question, not a dead path.
          return { requested, status: 'unknown' };
        }
      }),
    );
    if (hints.length === 0) return null;
    // EVERY candidate unknown is the signature of standing in the wrong tree entirely —
    // a stale release checkout, a partial clone, a work-item whose files are not created
    // yet. Report nothing at all, exactly as the not-a-git-work-tree case already does:
    // "the probe could not run" must never render as "every path is missing" (WI-6737).
    if (hints.every((h) => h.status === 'unknown')) return null;
    return hints;
  } catch {
    return null;
  }
}

export interface StalePathRefSubject {
  id: string;
  title?: string | null;
  summary?: string | null;
  /**
   * The re-injected CHECKPOINT body, when the caller has one (EI-19464910043764424).
   *
   * Scanned SEPARATELY from title/summary, never concatenated with them. A checkpoint
   * presents as a verified done-list — often ending in an instruction to close — so a
   * dead path cited THERE is a different and sharper signal than one in a filing's
   * prose, where describing a file yet to be created is normal and expected.
   */
  checkpoint?: string | null;
}

/** Unresolved prose-cited paths, split by WHICH text cited them. */
export interface StalePathRefsBySource {
  /** Cited in title/summary — the filing's own prose. */
  prose: ClaimTimeStalePathRef[];
  /** Cited in the checkpoint body, and not already reported under `prose`. */
  checkpoint: ClaimTimeStalePathRef[];
  /** How many repo-relative paths the checkpoint cited in total, resolved or not. */
  checkpointCitedTotal: number;
}

/**
 * The one scan both public entry points share, so prose and checkpoint can never
 * drift apart in how they resolve — only in how they are REPORTED. One tree lookup.
 */
function splitForSubjects(
  subjects: readonly StalePathRefSubject[],
  topLevel: string,
): Record<string, StalePathRefsBySource> {
  const unresolvedOf = (text: string): ClaimTimeStalePathRef[] =>
    deriveRepoPathsFromText(text).filter(
      (path) => isContainedRepoPath(topLevel, path) && !existsSync(join(topLevel, path)),
    );

  const bySource: Record<string, StalePathRefsBySource> = {};
  for (const subject of subjects) {
    const prose = unresolvedOf(`${subject.title ?? ''}\n${subject.summary ?? ''}`);
    const checkpointText = subject.checkpoint ?? '';
    // Total CITED (not just unresolved) — the "N of M" denominator, and the flag that
    // distinguishes "this checkpoint cites no paths" (stay silent) from "all of its
    // paths resolve" (also silent, but for a different reason).
    const checkpointCitedTotal = checkpointText ? deriveRepoPathsFromText(checkpointText).length : 0;
    const checkpoint = checkpointText
      ? unresolvedOf(checkpointText).filter((path) => !prose.includes(path))
      : [];
    bySource[subject.id] = { prose, checkpoint, checkpointCitedTotal };
  }
  return bySource;
}

/**
 * Same resolution as `getStalePathRefsForSubjects`, but keeping the SOURCE of each
 * unresolved path (EI-19464910043764424). Callers that re-inject a checkpoint use this
 * so the warning can say the dead path came from the checkpoint itself — the artifact
 * presenting as verified evidence — rather than burying it in the filing's prose.
 */
export async function getStalePathRefsBySourceForSubjects(
  subjects: readonly StalePathRefSubject[],
  repoRoot?: string,
): Promise<Record<string, StalePathRefsBySource>> {
  if (subjects.length === 0) return {};
  try {
    const topLevel = await resolveRepoRoot(repoRoot);
    if (!topLevel) return {};
    return splitForSubjects(subjects, topLevel);
  } catch {
    // Advisory-only, same contract as every sibling leg: a filesystem/git failure is
    // absence of evidence, never a clean bill of health (WI-6737).
    return {};
  }
}

/**
 * Render the checkpoint half as the reader-facing warning.
 *
 * Returns null when the checkpoint cited no paths at all, AND when every path it cited
 * resolves — both are silence, deliberately: a checkpoint that names no files must
 * never grow a spurious warning, which is the sequencing note the filing called out.
 */
export function staleCheckpointPathsNote(split: StalePathRefsBySource | null): string | null {
  if (!split || split.checkpoint.length === 0) return null;
  const n = split.checkpoint.length;
  const noun = n === 1 ? 'path' : 'paths';
  const verb = n === 1 ? 'does' : 'do';
  return (
    `⚠ ${n} of ${split.checkpointCitedTotal} ${noun} cited by this CHECKPOINT ${verb} not ` +
    `exist in the current tree: ${split.checkpoint.map((p) => `'${p}'`).join(', ')}. ` +
    `A checkpoint reads as verified evidence, so treat this as a directed question — what ` +
    `replaced the file, and did the work it describes survive that change? Do NOT read it as ` +
    `proof the work was dropped: the file may simply have been renamed, and the fix carried ` +
    `forward with it. Advisory and unresolved-paths-only; absence of this warning does not ` +
    `verify the checkpoint. [EI-19464910043764424]`
  );
}

/**
 * Resolve prose-cited repo paths for several subjects against ONE tree lookup.
 *
 * This is the shared seam used by claim-time enrichment (one subject) and
 * `plans:get` (many structured plan items). Missing paths are advisory: an item
 * may intentionally describe a file to create. A successful stat proves only
 * existence, never that the surrounding prose is semantically current.
 */
export async function getStalePathRefsForSubjects(
  subjects: readonly StalePathRefSubject[],
  repoRoot?: string,
  timings?: Record<string, number>,
): Promise<Record<string, ClaimTimeStalePathRef[]>> {
  if (subjects.length === 0) return {};
  try {
    const rootStartedAt = timings ? performance.now() : 0;
    const topLevel = await resolveRepoRoot(repoRoot);
    if (timings) timings['stalePaths.resolveRoot'] = Math.max(0, performance.now() - rootStartedAt);
    if (!topLevel) return {};
    const scanStartedAt = timings ? performance.now() : 0;
    const byId: Record<string, ClaimTimeStalePathRef[]> = {};
    for (const [id, split] of Object.entries(splitForSubjects(subjects, topLevel))) {
      const unresolved = [...split.prose, ...split.checkpoint];
      if (unresolved.length > 0) byId[id] = unresolved;
    }
    if (timings) timings['stalePaths.scan'] = Math.max(0, performance.now() - scanStartedAt);
    return byId;
  } catch {
    // Advisory-only. A filesystem/git failure is absence of evidence, not a clean bill
    // of health and not a reason to fail a claim or a plan read.
    return {};
  }
}

export async function getClaimTimeStalePathRefs(ref: {
  workItem?: { id?: string | null; title?: string | null; summary?: string | null } | null;
  title?: string | null;
  summary?: string | null;
  repoRoot?: string;
}): Promise<ClaimTimeStalePathRef[] | null> {
  const subject = {
    id: ref.workItem?.id || 'claim-subject',
    title: ref.title ?? ref.workItem?.title,
    summary: ref.summary ?? ref.workItem?.summary,
  };
  const byId = await getStalePathRefsForSubjects([subject], ref.repoRoot);
  return byId[subject.id] ?? null;
}

export function stalePathRefsNote(refs: ClaimTimeStalePathRef[] | null): string | null {
  if (!refs || refs.length === 0) return null;
  const noun = refs.length === 1 ? 'path' : 'paths';
  return (
    `⚠ UNRESOLVABLE PATH REFS: ${refs.length} repo-relative ${noun} cited in this item's ` +
    `title/summary do not resolve in the current tree: ${refs.map((ref) => `'${ref}'`).join(', ')}. ` +
    `Advisory only: an item may intentionally describe a file to CREATE. This detects unresolved ` +
    `paths only, not semantic staleness; absence of this field does not verify the item. ` +
    `[EI-20049758099997696]`
  );
}

/**
 * One fail-soft context object for the existing claim-time stale-path leg. Keeping
 * payload hints and title/summary refs in the same registered leg means every claim
 * surface gains the new advisory without creating a second hand-wired registry.
 */
export async function getClaimTimeStalePathAdvisory(ref: {
  workItem?: {
    id?: string | null;
    payload?: unknown;
    title?: string | null;
    summary?: string | null;
  } | null;
  payload?: unknown;
  title?: string | null;
  summary?: string | null;
  repoRoot?: string;
}): Promise<ClaimTimeStalePathAdvisory | null> {
  const [hints, refs] = await Promise.all([
    getClaimTimeStalePathHints({
      workItem: ref.workItem,
      payload: ref.payload,
      repoRoot: ref.repoRoot,
    }),
    getClaimTimeStalePathRefs({
      workItem: ref.workItem,
      title: ref.title,
      summary: ref.summary,
      repoRoot: ref.repoRoot,
    }),
  ]);
  if (!hints && !refs) return null;
  return {
    ...(hints
      ? { pathHints: hints, pathHintsNote: stalePathHintsNote(hints) ?? undefined }
      : {}),
    ...(refs
      ? { stalePathRefs: refs, stalePathRefsNote: stalePathRefsNote(refs) ?? undefined }
      : {}),
  };
}

/**
 * Render the hints as the note an agent reads at claim time. Pure + exported so
 * the guarantee is directly testable and a future edit cannot silently weaken it
 * — the same shape planItemContradictionWarning chose, and for the same reason.
 */
export function stalePathHintsNote(hints: ClaimTimeStalePathHint[] | null): string | null {
  if (!hints || hints.length === 0) return null;
  const moved = hints.filter((h): h is ClaimTimeStalePathHint & { resolvedTo: string } =>
    Boolean(h.status === 'moved' && h.resolvedTo),
  );
  const missingCount = hints.filter((h) => h.status === 'missing').length;
  // Counted and worded SEPARATELY from `missing`. An 'unknown' path may be perfectly
  // valid in the agent's own tree, so the note must not claim it is gone, and must not
  // forbid working from it — the whole defect in EI-21930229853756240 was a note that
  // did both about files that were present all along.
  const unknown = hints.filter((h) => h.status === 'unknown');
  const affirmed = moved.length + missingCount;
  const movedText = moved.map((h) => `'${h.requested}' → '${h.resolvedTo}'`).join('; ');
  if (affirmed === 0) return null;
  return (
    `⚠ STALE PATH HINTS: ${affirmed} stored payload path(s) no longer exist at HEAD` +
    (movedText ? ` — ${movedText}` : '') +
    (missingCount > 0 ? ` (${missingCount} unresolved)` : '') +
    '. Work from the resolvedTo locations; do NOT take a stored path literally or fall back to a ' +
    'repository-wide search. [EI-21267393427094356]' +
    (unknown.length > 0
      ? ` — SEPARATELY, ${unknown.length} path(s) could not be checked here (absent from this ` +
        `checkout with no history for them, so this is probably not the tree they live in): ` +
        `${unknown.map((h) => `'${h.requested}'`).join(', ')}. Treat these as UNVERIFIED, not ` +
        `dead — verify with \`git rev-parse --verify --quiet staging:<path>\` before abandoning one. ` +
        `[EI-21930229853756240]`
      : '')
  );
}
