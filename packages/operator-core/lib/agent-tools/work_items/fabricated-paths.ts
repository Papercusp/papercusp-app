/**
 * P-001 (plan `design-to-code-coverage-seam-2026-09-02`), governed by D-016.
 *
 * Decide whether a completion's `filesChanged` names a path that NEVER EXISTED in this
 * tree — the one cause of path-absence that is a defect rather than a legitimate close.
 *
 * ## Why this is not `unresolvedPathsInCompletion`
 *
 * That detector (complete.ts, EI-20093150500083378) asks "does this path exist NOW?" and
 * is warn-only BY DESIGN, because its own comment names the legitimate reasons a declared
 * path can be absent: "the file was DELETED by this very change, or lives in a submodule
 * that is not checked out". Promoting that nudge to a grade would down-grade exactly the
 * honest refactor and cleanup closes — the population most likely to delete files.
 *
 * So absence has three causes and only ONE may lower a grade:
 *
 *   1. FABRICATED   — never existed here. The measured EI-20093150500083378 case: 8 of 12
 *                     declared paths invented, and MORE conventional than the real ones
 *                     (an `agent-tools/` segment, a `__tests__/` dir this repo does not
 *                     use), which is precisely why review does not catch them.
 *   2. DELETED      — legitimate. Common in the closes we most want to grade well.
 *   3. UNJUDGEABLE  — glob, outside the repo root, no resolvable root, an unchecked-out
 *                     submodule, or any fs/git error.
 *
 * **Git history is the discriminator.** A path absent from disk but KNOWN to git was
 * plausibly deleted (cause 2). A path absent from disk AND unknown to git has never
 * existed in this tree (cause 1). That is the single question this module answers, and it
 * is the question the existing detector cannot ask.
 *
 * ## Biased toward generosity, deliberately
 *
 * A false FABRICATED verdict lowers an honest agent's grade and teaches the fleet that the
 * signal is noise; a false clean verdict merely leaves today's behaviour in place. The two
 * errors are not symmetric, so every ambiguity resolves toward "cannot judge":
 *
 *   - history is checked with `--all`, so a path known to ANY branch counts as real;
 *   - under multiple candidate roots, existence OR history under ANY root clears the path;
 *   - a path under a declared submodule prefix is never judged (the superproject only
 *     tracks the gitlink, so `git log` there is empty for a REAL file — the one shape that
 *     would otherwise manufacture a confident false accusation);
 *   - any throw, any non-zero exit, any unresolvable root is silence, never a finding.
 *
 * This mirrors the safety margin `unresolved-refs.ts` states for its own probe: "a
 * resolver that THROWS is treated as 'cannot judge' and stays silent — only a clean
 * 'resolved to nothing' is ever reported."
 *
 * PURE via injected probes, so every branch above is unit-testable without a real tree.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import nodePath from 'node:path';

import type { CompletionVerificationEvidence } from '../../coord-lifecycle/records';

/**
 * Bounds the git work. A completion naming more paths than this is not judged past the
 * cap — the same bounding discipline `MAX_PATHS_PROBED` applies to the sibling detector.
 */
export const MAX_FABRICATION_PROBES = 12;

/**
 * EI-23439632326954844: bounds the git work ACROSS the whole detector, not per spawn.
 *
 * `git log -1 --all -- <path>` is cheap when the path has history (it stops at the first
 * commit) and a FULL-HISTORY WALK when it has none — which is exactly the case this
 * detector exists to find, and exactly the case an out-of-repo path (a sibling checkout's
 * file, `~/.config/...`) produces under EVERY candidate root. Measured 2026-09-17 on :3170:
 * 3 such paths × ~50 sibling-checkout roots → 25s+ of serial git spawns, past the MCP
 * transport cap, so `work_items:complete` never returned. The per-spawn 5s timeout could
 * not help: no single spawn was slow, the fan-out was. These two caps bound the SUM; once
 * either is spent every remaining path is UNJUDGEABLE (silence), never a finding.
 */
export const FABRICATION_GIT_BUDGET_MS = 3_000;
export const MAX_FABRICATION_GIT_PROBES = 8;

/**
 * `true` = git has history for this path · `false` = git has none · `undefined` = COULD
 * NOT JUDGE. The three-valued return is the whole safety property: a probe that cannot
 * answer must never be collapsed into `false`, which would read as fabrication.
 */
export type GitPathHistoryProbe = (repoRoot: string, relPath: string) => boolean | undefined;

export interface FabricatedPathProbe {
  /** Candidate checkout roots. An explicit empty list means "cannot judge", never "guess". */
  repoRoots?: readonly string[];
  /** Does this absolute path exist on disk? */
  exists?: (abs: string) => boolean;
  /** Does git know this repo-relative path, on any branch? */
  gitKnows?: GitPathHistoryProbe;
  /** Repo-relative submodule directory prefixes; paths under one are never judged. */
  submodulePrefixes?: (repoRoot: string) => readonly string[];
  /** Total wall-clock budget for git probes across ALL paths × roots (default 3s). */
  gitBudgetMs?: number;
  /** Total git spawn cap across ALL paths × roots (default 8). */
  maxGitProbes?: number;
  /** Injectable clock for the budget (tests). */
  now?: () => number;
}

/** `git log -1 --all -- <path>`: any commit on any branch means the path is real. */
const defaultGitKnows: GitPathHistoryProbe = (repoRoot, relPath) => {
  try {
    const out = execFileSync('git', ['-C', repoRoot, 'log', '-1', '--format=%H', '--all', '--', relPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    });
    return out.trim().length > 0;
  } catch {
    return undefined; // not a repo, git missing, timeout → cannot judge
  }
};

/** Submodule prefixes parsed from `.gitmodules`. Failure yields [] — see the caller. */
const defaultSubmodulePrefixes = (repoRoot: string): readonly string[] => {
  try {
    const raw = readFileSync(nodePath.join(repoRoot, '.gitmodules'), 'utf8');
    return [...raw.matchAll(/^\s*path\s*=\s*(.+)$/gm)]
      .map((m) => m[1].trim())
      .filter((p) => p.length > 0);
  } catch {
    return [];
  }
};

/**
 * Paths in `filesChanged` proven never to have existed in this tree.
 *
 * Returns `undefined` when there is nothing confident to say — no declared paths, no
 * usable root, or every absent path was judged deleted or unjudgeable. A caller may treat
 * a returned finding as grade-bearing; `undefined` must always mean "grade as before".
 */
export function fabricatedPathsInCompletion(
  evidence: CompletionVerificationEvidence | null | undefined,
  probe: FabricatedPathProbe = {},
): { neverExisted: string[] } | undefined {
  const declared = evidence?.filesChanged;
  if (!declared?.length) return undefined;

  // `in` rather than `??`, matching unresolvedPathsInCompletion: an EXPLICIT empty roots
  // list means "I could not resolve a root, do not guess", which differs from omitting it.
  const rawRoots = 'repoRoots' in probe ? probe.repoRoots : undefined;
  const repoRoots = [
    ...new Set(
      (rawRoots ?? [])
        .filter((r): r is string => typeof r === 'string' && r.trim().length > 0)
        .map((r) => nodePath.resolve(r)),
    ),
  ];
  if (repoRoots.length === 0) return undefined;

  const exists = probe.exists ?? ((abs: string) => existsSync(abs));
  const gitKnows = probe.gitKnows ?? defaultGitKnows;
  const submodulePrefixes = probe.submodulePrefixes ?? defaultSubmodulePrefixes;

  const submodulesByRoot = new Map<string, readonly string[]>();
  const submodulesFor = (root: string): readonly string[] => {
    if (!submodulesByRoot.has(root)) {
      let prefixes: readonly string[] = [];
      try {
        prefixes = submodulePrefixes(root) ?? [];
      } catch {
        prefixes = [];
      }
      submodulesByRoot.set(root, prefixes);
    }
    return submodulesByRoot.get(root) ?? [];
  };

  const neverExisted: string[] = [];

  // EI-23439632326954844: one budget for the whole detector — see the constants above.
  const now = probe.now ?? (() => Date.now());
  const gitBudgetMs = probe.gitBudgetMs ?? FABRICATION_GIT_BUDGET_MS;
  const maxGitProbes = probe.maxGitProbes ?? MAX_FABRICATION_GIT_PROBES;
  const startedAt = now();
  let gitProbesSpent = 0;
  const gitBudgetLeft = (): boolean => gitProbesSpent < maxGitProbes && now() - startedAt < gitBudgetMs;

  for (const raw of declared.slice(0, MAX_FABRICATION_PROBES)) {
    const declaredPath = (raw ?? '').trim();
    // A glob describes many files; it is not a claim that one path exists.
    if (!declaredPath || declaredPath.includes('*') || declaredPath.includes('?')) continue;
    // An absolute or home-relative (`~/...`) path names another tree we have no standing
    // to judge — and `~` is NOT absolute to node, so without this it was resolved under
    // every candidate root as `<root>/~/...` and history-walked in each (the measured hang).
    if (nodePath.isAbsolute(declaredPath) || declaredPath === '~' || declaredPath.startsWith('~/')) continue;

    let judgedByAnyRoot = false;
    let clearedByAnyRoot = false;

    for (const repoRoot of repoRoots) {
      let abs: string;
      try {
        abs = nodePath.resolve(repoRoot, declaredPath);
      } catch {
        continue;
      }
      // Escapes the root (`../`) → outside our standing to judge.
      if (abs !== repoRoot && !abs.startsWith(repoRoot + nodePath.sep)) continue;

      // Under a submodule the superproject tracks only the gitlink, so `git log` is empty
      // for a REAL file. Judging here would manufacture a confident false accusation.
      const norm = declaredPath.replace(/\\/g, '/').replace(/^\.\//, '');
      if (submodulesFor(repoRoot).some((p) => norm === p || norm.startsWith(p.replace(/\/$/, '') + '/'))) {
        clearedByAnyRoot = true;
        break;
      }

      let onDisk: boolean;
      try {
        onDisk = exists(abs);
        // EI-21850619651553189 / EI-23439632326954844: the conventional cross-repo form
        // `<repoName>/<path>` (how a sibling checkout's file is named in prose) exists
        // under the root whose basename it leads with, once that segment is stripped.
        // Checked alongside the plain form, never instead of it, and BEFORE any git
        // spawn — an existence hit is free where a history walk is the expensive miss.
        if (!onDisk) {
          const prefix = `${nodePath.basename(repoRoot)}/`;
          if (declaredPath.startsWith(prefix) && declaredPath.length > prefix.length) {
            const stripped = nodePath.resolve(repoRoot, declaredPath.slice(prefix.length));
            if (stripped === repoRoot || stripped.startsWith(repoRoot + nodePath.sep)) onDisk = exists(stripped);
          }
        }
      } catch {
        continue; // fs error → cannot judge under this root
      }
      if (onDisk) {
        clearedByAnyRoot = true;
        break;
      }

      // Budget spent → this root cannot judge; a bounded detector stays silent, never accuses.
      if (!gitBudgetLeft()) continue;
      let known: boolean | undefined;
      try {
        gitProbesSpent += 1;
        known = gitKnows(repoRoot, declaredPath);
      } catch {
        known = undefined;
      }
      if (known === undefined) continue; // cannot judge under this root
      judgedByAnyRoot = true;
      if (known) {
        clearedByAnyRoot = true; // absent but known to git → plausibly DELETED, legitimate
        break;
      }
    }

    // Only a path judged under at least one root, and cleared by none, is a finding.
    if (judgedByAnyRoot && !clearedByAnyRoot) neverExisted.push(declaredPath);
  }

  return neverExisted.length > 0 ? { neverExisted } : undefined;
}
