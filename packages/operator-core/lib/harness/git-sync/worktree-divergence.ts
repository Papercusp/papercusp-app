/**
 * WI-10006476 / plan agent-capacity-and-cost-gcp-2026-09-30 D-055 — the persisted
 * `routines.metadata.worktree_divergence` state of a pot-git member, and the one
 * function allowed to build it.
 *
 * WHY: a real content conflict between a member's work and the hive head forks
 * the member silently and permanently. The integrator parks the member head
 * ("leave for the member to rebase", integrator.ts) and the member's ff-only
 * worktree advance returns `diverged-manual`, which the catch-up sweep did not
 * log. Nothing recorded the fork: S6 (P-525) ran 55+ min with the tower and a
 * joiner each missing the other's work and no line anywhere saying so.
 *
 * WHAT this records: only a divergence that will NOT resolve on its own, i.e.
 * one whose 3-way merge conflicts (`conflictPaths` non-empty). A clean
 * divergence is the normal window before the integrator merges this member's
 * head, so recording it would flag every member after every commit.
 *
 * A separate top-level key, not a field of `worktree_bridge`:
 * `patchRoutineMetadata` is a top-level jsonb merge (see worktree-bridge-state.ts),
 * so a field added there must be re-stated by every writer of that object. This
 * key has exactly one writer (`recordWorktreeDivergence` in git-sync-action.ts).
 */

/** The persisted shape (null = not diverged on a conflict). */
export interface WorktreeDivergence {
  /** First observation of THIS divergence (ms epoch). Kept while it persists,
   *  even as both heads move, so its age is readable. */
  since: number;
  /** Last tick that observed it (ms epoch). */
  lastSeenAt: number;
  /** The member worktree head at the last observation. */
  localHead: string;
  /** The accepted hive head (the watermark) at the last observation. */
  hiveSha: string;
  /** Conflicting paths, sorted. Never empty in a persisted value. */
  paths: string[];
}

/** What one catch-up tick learned about the member worktree. */
export type DivergenceObservation =
  /** The worktree contains the hive head (current / advanced / noop). */
  | { kind: 'contained' }
  /** Diverged. `paths: []` = merges cleanly (transient); `null` = probe failed. */
  | { kind: 'diverged'; localHead: string; hiveSha: string; paths: string[] | null }
  /** Nothing learned (dirty deferral, a transport error): keep the prior state. */
  | { kind: 'unknown' };

/** What the caller should log for this transition. */
export type DivergenceLog = 'started' | 'paths-changed' | 'cleared' | null;

export interface DivergenceTransition {
  next: WorktreeDivergence | null;
  log: DivergenceLog;
  /** Whether the persisted value must be written this tick. */
  write: boolean;
}

/** Refresh `lastSeenAt` at most this often while nothing else changes, so a
 *  long divergence is not one metadata write per tick. */
export const DIVERGENCE_REFRESH_MS = 5 * 60_000;

function samePaths(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((p, i) => p === b[i]);
}

/** Read a persisted value defensively (hand-edited or older rows). */
export function parseWorktreeDivergence(raw: unknown): WorktreeDivergence | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const paths = Array.isArray(r.paths) ? r.paths.filter((p): p is string => typeof p === 'string') : [];
  if (
    typeof r.since !== 'number' ||
    typeof r.lastSeenAt !== 'number' ||
    typeof r.localHead !== 'string' ||
    typeof r.hiveSha !== 'string' ||
    paths.length === 0
  ) {
    return null;
  }
  return { since: r.since, lastSeenAt: r.lastSeenAt, localHead: r.localHead, hiveSha: r.hiveSha, paths };
}

/** Pure transition: prior state + this tick's observation → next state. */
export function nextWorktreeDivergence(
  prior: WorktreeDivergence | null,
  obs: DivergenceObservation,
  now: number,
): DivergenceTransition {
  if (obs.kind === 'unknown') return { next: prior, log: null, write: false };
  if (obs.kind === 'diverged' && obs.paths === null) return { next: prior, log: null, write: false };

  const conflictPaths = obs.kind === 'diverged' ? [...(obs.paths as string[])].sort() : [];
  if (conflictPaths.length === 0) {
    // Contained, or a clean (self-resolving) divergence: no conflict fork.
    return prior ? { next: null, log: 'cleared', write: true } : { next: null, log: null, write: false };
  }

  const d = obs as Extract<DivergenceObservation, { kind: 'diverged' }>;
  const next: WorktreeDivergence = {
    since: prior?.since ?? now,
    lastSeenAt: now,
    localHead: d.localHead,
    hiveSha: d.hiveSha,
    paths: conflictPaths,
  };
  if (!prior) return { next, log: 'started', write: true };
  if (!samePaths(prior.paths, conflictPaths)) return { next, log: 'paths-changed', write: true };
  const headsMoved = prior.localHead !== d.localHead || prior.hiveSha !== d.hiveSha;
  const stale = now - prior.lastSeenAt >= DIVERGENCE_REFRESH_MS;
  if (headsMoved || stale) return { next, log: null, write: true };
  return { next: prior, log: null, write: false };
}

/** The operator-facing line for a logged transition (null = nothing to log). */
export function describeDivergenceTransition(
  slug: string,
  prior: WorktreeDivergence | null,
  t: DivergenceTransition,
  now: number,
): string | null {
  if (t.log === null) return null;
  if (t.log === 'cleared') {
    const mins = prior ? Math.round((now - prior.since) / 60_000) : 0;
    return (
      `[git-sync] ${slug}: worktree divergence from the hive head CLEARED after ~${mins}m ` +
      `(was conflicting on ${prior?.paths.length ?? 0} path(s)).`
    );
  }
  const n = t.next as WorktreeDivergence;
  const shown = n.paths.slice(0, 5).join(', ') + (n.paths.length > 5 ? `, +${n.paths.length - 5} more` : '');
  return (
    `[git-sync] ${slug}: worktree DIVERGED from the hive head ${n.hiveSha.slice(0, 12)} ` +
    `(local ${n.localHead.slice(0, 12)}) with a content conflict on ${n.paths.length} path(s): ${shown}. ` +
    `The integrator parks this member's work and this worktree cannot follow hive changes until the ` +
    `conflict is resolved on this member (plan agent-capacity-and-cost-gcp-2026-09-30 D-055). ` +
    `State: routines.metadata.worktree_divergence.` +
    (t.log === 'paths-changed' ? ' (conflicting path set changed)' : '')
  );
}
