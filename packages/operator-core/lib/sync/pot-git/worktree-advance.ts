/**
 * pot-git/worktree-advance.ts — ff-only worktree advance (Phase 7 G-7c/G-7b,
 * cross-machine-coord-parity-and-trust-2026-07-01 / P-040 + P-036, D-010/D-011).
 *
 * THE INVARIANT (G-7c, hole 4): a machine's working tree advances to a new
 * canonical `staging` ONLY when that staging is a FAST-FORWARD of the local
 * worktree head — and the advance NEVER touches a file the local user has
 * dirty/uncommitted (G-7b). Anything else is REFUSED AND SURFACED as a typed
 * result ("diverged, manual" / "deferred, dirty overlap"), never clobbered.
 * This module MUST NEVER run `reset --hard` (or any tree-wide discard): the
 * shared checkout carries every fleet member's in-flight, not-yet-committed
 * work, and a hard reset silently destroys it (the 2026-06-21 incident class).
 *
 * DECISION vs APPLY: `decideAdvance` is a PURE function over precomputed facts
 * (head shas, ancestry bits, dirty + incoming path sets) so the policy is
 * unit-testable with no git; `advanceWorktree` gathers those facts from a real
 * worktree via the injected RunGit seam and applies the decision with
 * `git merge --ff-only <target>` — which git itself refuses non-fast-forward
 * (second-line defense for the ancestry check) and refuses when it would
 * overwrite local changes (second-line defense for the dirty check, closing
 * the status→merge race window).
 *
 * Outcomes:
 *   - advanced        — worktree ff-updated to the target.
 *   - noop            — already at the target, or local is AHEAD of it (staging
 *                       never rewinds a receiver; the integrator catches up).
 *   - diverged-manual — target is not a ff of the local head; a human (or the
 *                       member's own rebase-and-republish loop) must resolve.
 *   - deferred-dirty  — dirty ∩ incoming ≠ ∅; deferred to the next sweep after
 *                       the local autocommit picks the dirty files up. With the
 *                       lock system serializing writes this is the uncommon case.
 *   - error           — environment/plumbing failure (target object missing,
 *                       not a worktree, git failure) — surfaced, never thrown.
 *
 * Fail-soft by contract: `advanceWorktree` never throws; every failure resolves
 * as `{ outcome: 'error' | ... , detail }` for the bridge (G-7) to surface.
 */

import { type RunGit, defaultRunGit } from './storage';

/** The pure decision over precomputed facts. */
export type AdvanceDecision =
  | { kind: 'advance' }
  | { kind: 'noop'; reason: 'identical' | 'local-ahead' }
  | { kind: 'diverged' }
  | { kind: 'deferred-dirty'; overlap: string[] };

export interface AdvanceDecisionInput {
  /** Local worktree HEAD commit (null = unborn HEAD, e.g. a fresh joiner). */
  localHead: string | null;
  /** The incoming canonical staging commit. */
  target: string;
  /** `merge-base --is-ancestor target localHead` — target already contained. */
  targetContainedInLocal: boolean;
  /** `merge-base --is-ancestor localHead target` — ff is possible. */
  localContainedInTarget: boolean;
  /** Locally dirty paths: staged + unstaged + untracked (renames = both sides). */
  dirtyPaths: string[];
  /** Paths the advance would write: diff(localHead → target); full target tree
   *  when HEAD is unborn. */
  incomingPaths: string[];
}

/**
 * G-7c decision, pure: ff-only, dirty-overlap-safe, never-rewind.
 * An unborn HEAD (null) is trivially contained in any target — ff-eligible —
 * and the dirty-overlap rule alone protects whatever is lying in the tree.
 */
export function decideAdvance(input: AdvanceDecisionInput): AdvanceDecision {
  if (input.localHead === input.target) return { kind: 'noop', reason: 'identical' };
  if (input.localHead !== null) {
    // Local already contains the target (we are ahead or equal): NEVER rewind.
    if (input.targetContainedInLocal) return { kind: 'noop', reason: 'local-ahead' };
    // Not a fast-forward of the local head: refuse — manual resolution.
    if (!input.localContainedInTarget) return { kind: 'diverged' };
  }
  const incoming = new Set(input.incomingPaths);
  const overlap = input.dirtyPaths.filter((p) => incoming.has(p));
  if (overlap.length > 0) return { kind: 'deferred-dirty', overlap };
  return { kind: 'advance' };
}

export type WorktreeAdvanceOutcome =
  | 'advanced'
  | 'noop'
  | 'diverged-manual'
  | 'deferred-dirty'
  | 'error';

export interface WorktreeAdvanceResult {
  outcome: WorktreeAdvanceOutcome;
  /** The local head before the attempt (null = unborn). */
  from: string | null;
  /** The target staging sha the advance was asked to reach. */
  to: string;
  /** For deferred-dirty: the dirty paths the target would have overwritten. */
  dirtyOverlap?: string[];
  /** Human-readable diagnostics (git stderr, refusal reason). */
  detail?: string;
}

/**
 * Parse `git status --porcelain -z` output into the set of locally dirty paths
 * (staged, unstaged, untracked; for a rename/copy BOTH sides count as dirty).
 * NUL-separated records: `XY <path>` and, when X or Y is R/C, a following
 * NUL-separated original path.
 */
export function parseStatusPorcelainZ(raw: string): string[] {
  const out: string[] = [];
  const tokens = raw.split('\0');
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.length < 4 || t[2] !== ' ') continue; // "XY <path>"
    const xy = t.slice(0, 2);
    out.push(t.slice(3));
    if (/[RC]/.test(xy)) {
      // Rename/copy record: the next token is the ORIGINAL path.
      const orig = tokens[i + 1];
      if (orig) {
        out.push(orig);
        i++;
      }
    }
  }
  return [...new Set(out)];
}

/** Locally dirty paths of a worktree, or null when status itself fails (bare
 *  repo / not a git dir) — the caller surfaces that as an error. */
export async function listDirtyPaths(
  worktreePath: string,
  runGit: RunGit = defaultRunGit,
): Promise<string[] | null> {
  const r = await runGit(['status', '--porcelain', '-z'], worktreePath);
  if (r.code !== 0) return null;
  return parseStatusPorcelainZ(r.stdout);
}

/** Paths an advance localHead→target would write. Unborn HEAD → the full
 *  target tree. Null when git fails. */
async function listIncomingPaths(
  worktreePath: string,
  localHead: string | null,
  target: string,
  runGit: RunGit,
): Promise<string[] | null> {
  const r = localHead
    ? await runGit(['diff', '--name-only', '-z', localHead, target], worktreePath)
    : await runGit(['ls-tree', '-r', '--name-only', '-z', target], worktreePath);
  if (r.code !== 0) return null;
  return r.stdout.split('\0').filter((p) => p.length > 0);
}

/**
 * G-7c apply: advance `worktreePath` to `targetSha`, ff-only + dirty-safe.
 * The target commit must already be present in the worktree's object database
 * (the bridge fetches before advancing) — a missing object is an `error`
 * outcome, not an implicit fetch. Never throws; never rewinds; NEVER resets.
 */
export async function advanceWorktree(
  worktreePath: string,
  targetSha: string,
  opts: { runGit?: RunGit } = {},
): Promise<WorktreeAdvanceResult> {
  const runGit = opts.runGit ?? defaultRunGit;
  try {
    // The target must be a commit we already have (fetch-before-advance).
    const have = await runGit(['cat-file', '-e', `${targetSha}^{commit}`], worktreePath);
    if (have.code !== 0) {
      return {
        outcome: 'error',
        from: null,
        to: targetSha,
        detail: `target commit not present in the worktree ODB (fetch before advancing): ${have.stderr.trim()}`,
      };
    }

    const headR = await runGit(['rev-parse', '--verify', '-q', 'HEAD^{commit}'], worktreePath);
    const localHead = headR.code === 0 && headR.stdout.trim() ? headR.stdout.trim() : null;

    let targetContainedInLocal = false;
    let localContainedInTarget = true; // unborn HEAD: trivially contained
    if (localHead !== null && localHead !== targetSha) {
      targetContainedInLocal =
        (await runGit(['merge-base', '--is-ancestor', targetSha, localHead], worktreePath)).code === 0;
      localContainedInTarget =
        (await runGit(['merge-base', '--is-ancestor', localHead, targetSha], worktreePath)).code === 0;
    }

    const dirtyPaths = await listDirtyPaths(worktreePath, runGit);
    if (dirtyPaths === null) {
      return { outcome: 'error', from: localHead, to: targetSha, detail: 'git status failed — not a worktree?' };
    }
    const incomingPaths =
      localHead === targetSha ? [] : await listIncomingPaths(worktreePath, localHead, targetSha, runGit);
    if (incomingPaths === null) {
      return { outcome: 'error', from: localHead, to: targetSha, detail: 'failed to compute incoming paths' };
    }

    const decision = decideAdvance({
      localHead,
      target: targetSha,
      targetContainedInLocal,
      localContainedInTarget,
      dirtyPaths,
      incomingPaths,
    });

    if (decision.kind === 'noop') {
      return { outcome: 'noop', from: localHead, to: targetSha, detail: decision.reason };
    }
    if (decision.kind === 'diverged') {
      return {
        outcome: 'diverged-manual',
        from: localHead,
        to: targetSha,
        detail: 'target staging is not a fast-forward of the local head — manual resolution required',
      };
    }
    if (decision.kind === 'deferred-dirty') {
      return {
        outcome: 'deferred-dirty',
        from: localHead,
        to: targetSha,
        dirtyOverlap: decision.overlap,
        detail: 'locally dirty files overlap the incoming change — deferred to the next sweep',
      };
    }

    // decision.kind === 'advance' → apply with git's own ff-only merge. git
    // re-checks BOTH invariants (non-ff refused; local-overwrite refused), so a
    // race between our checks and the apply degrades to a refusal, never a clobber.
    const merged = await runGit(['merge', '--ff-only', targetSha], worktreePath);
    if (merged.code !== 0) {
      const stderr = merged.stderr.trim();
      if (/local changes|would be overwritten/i.test(stderr)) {
        return {
          outcome: 'deferred-dirty',
          from: localHead,
          to: targetSha,
          dirtyOverlap: [],
          detail: `git refused the ff (dirty race): ${stderr}`,
        };
      }
      if (/not possible to fast-forward|unable to fast-forward|diverg/i.test(stderr)) {
        return {
          outcome: 'diverged-manual',
          from: localHead,
          to: targetSha,
          detail: `git refused the ff: ${stderr}`,
        };
      }
      return { outcome: 'error', from: localHead, to: targetSha, detail: `merge --ff-only failed: ${stderr}` };
    }
    return { outcome: 'advanced', from: localHead, to: targetSha };
  } catch (e) {
    return {
      outcome: 'error',
      from: null,
      to: targetSha,
      detail: e instanceof Error ? e.message : String(e),
    };
  }
}
