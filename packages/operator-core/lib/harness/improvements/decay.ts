/**
 * decay.ts — the recurrence-decay VERIFICATION sweep
 * (learning-system-audit-improvements-2026-06-09 P-013; self-learning P-030/D-003).
 *
 * Before this existed, `checkDecayOutcome` had zero production callers: a resolved
 * improvement never graduated to `verified` and a regressed fix never flipped to
 * `recurred`. This sweep is the missing scheduled caller — it rides the
 * `system:improvement-watchdog` cadence (the tick that already sweeps telemetry):
 *
 *   For every RESOLVED/CLOSED item whose lifecycle is `applied`:
 *     - signature recurred AFTER the resolution → `recurred` (any class — a
 *       re-surfaced friction is regression evidence; the watchdog's
 *       `dedupScope:'open'` re-file creates the NEW item, this marks the OLD one);
 *     - quiet ≥ 14 days post-resolution, product class → `verified` (D-003: the
 *       process class never positively verifies by decay — it earns gym A/B).
 *   Legacy resolved items with NO lifecycle get retro-initialized to `applied`
 *   (re-anchored at their resolution time) so the existing backlog enters the
 *   pipeline instead of being permanently invisible.
 *
 * `planDecaySweep` is pure (deterministic given nowMs) — exhaustively testable;
 * `runDecaySweep` is the thin PG glue with the usual injectable deps.
 */

import {
  mergeIssuePayload,
  commentIssue,
  projectAllIssuesForBoundedRead,
  type EngineerIssue,
} from '../../issues-engineer';
import { trackDetached } from '../../detached-imports';
import type { ThreadPostRow } from '@papercusp/coordination/capabilities';
import type { ImprovementCandidate } from './policy';
import {
  projectImprovementItemsForBoundedRead,
  type ProjectImprovementDeps,
} from './read-items';
import { dedupSignature, recurrenceGroupKey } from './digest';
import { checkDecayOutcome, type IdeaLifecyclePayload } from './lifecycle';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Per-sweep cap on persisted actions — bounds tick work on the big legacy backlog. */
export const DEFAULT_MAX_ACTIONS_PER_SWEEP = 50;

export type DecayActionKind = 'verified' | 'recurred' | 'init-applied';

export interface DecayAction {
  id: string;
  kind: DecayActionKind;
  lifecycle: IdeaLifecyclePayload;
  /** Post-resolution recurrence count (recurred actions). */
  recurrences?: number;
  /** Days since resolution (verified actions). */
  decayDays?: number;
}

export interface PlanDecayOpts {
  nowMs?: number;
  maxActions?: number;
}

function lifecycleStateOf(c: ImprovementCandidate): IdeaLifecyclePayload | null {
  return c.ideaLifecycle ?? null;
}

/**
 * Pure sweep planner. `all` should span ALL states (open + resolved + closed) so
 * post-resolution recurrence is visible.
 */
export function planDecaySweep(all: readonly ImprovementCandidate[], opts: PlanDecayOpts = {}): DecayAction[] {
  const nowMs = opts.nowMs ?? Date.now();
  const maxActions = opts.maxActions ?? DEFAULT_MAX_ACTIONS_PER_SWEEP;
  if (maxActions <= 0) return [];

  // Group every candidate by stable signature once.
  const bySig = new Map<string, ImprovementCandidate[]>();
  for (const c of all) {
    // A KEYLESS candidate whose title normalizes to nothing has no identity to
    // group on (the original guard). A KEYED one always has one, so it is never
    // skipped — `recurrenceGroupKey` would otherwise return a truthy bare `sig:`.
    if (!c.watchdogKey && !dedupSignature(c.title)) continue;
    const sig = recurrenceGroupKey(c);
    const arr = bySig.get(sig) ?? [];
    arr.push(c);
    bySig.set(sig, arr);
  }

  const actions: DecayAction[] = [];
  for (const c of all) {
    if (actions.length >= maxActions) break;
    if (!c.watchdogKey && !dedupSignature(c.title)) continue;
    const state = c.state ?? 'open';
    if (state === 'open') continue;

    const resolvedMs = c.updatedAt ? Date.parse(c.updatedAt) : NaN;
    if (!Number.isFinite(resolvedMs)) continue;

    const lifecycle = lifecycleStateOf(c);

    // Legacy resolved item without a lifecycle: retro-enter the pipeline as
    // 'applied', anchored at its resolution time (so decayDays counts from the
    // real resolution, not from this sweep). Graded on a LATER sweep.
    if (!lifecycle) {
      actions.push({
        id: c.id,
        kind: 'init-applied',
        lifecycle: { state: 'applied', stateUpdatedAt: new Date(resolvedMs).toISOString() },
      });
      continue;
    }

    if (lifecycle.state !== 'applied') continue;

    // Post-resolution recurrence: same-signature captures CREATED after this
    // item's resolution (pre-fix duplicates don't count as regression).
    const members = bySig.get(recurrenceGroupKey(c)) ?? [];
    const post = members.filter((m) => {
      if (m.id === c.id) return false;
      const createdMs = m.createdAt ? Date.parse(m.createdAt) : NaN;
      return Number.isFinite(createdMs) && createdMs > resolvedMs;
    });
    const decayDays = Math.round(((nowMs - resolvedMs) / DAY_MS) * 10) / 10;

    const next = checkDecayOutcome(lifecycle, {
      count: post.length + 1,
      decayDays,
      resolvedCount: members.filter((m) => (m.state ?? 'open') !== 'open').length,
    });
    if (!next) continue;

    actions.push({
      id: c.id,
      kind: next.state === 'verified' ? 'verified' : 'recurred',
      lifecycle: next,
      ...(next.state === 'recurred' ? { recurrences: post.length } : {}),
      ...(next.state === 'verified' ? { decayDays } : {}),
    });
  }
  return actions;
}

export interface DecaySweepResult {
  scanned: number;
  verified: number;
  recurred: number;
  initialized: number;
}

export interface DecaySweepPlan {
  scanned: number;
  actions: DecayAction[];
}

/** Injectable dependency seam (unit tests run without PG). */
export interface DecaySweepDeps {
  /**
   * Whole-population read with a bounded projection. A recency-limited list cannot
   * decide whether mature fixes have stayed quiet or regressed.
   */
  projectIssues: ProjectImprovementDeps['projectIssues'];
  mergeIssuePayload: (id: string, patch: Record<string, unknown>) => Promise<EngineerIssue | null>;
  commentIssue: (id: string, body: string, authorId?: string) => Promise<ThreadPostRow | null>;
}

const defaultDeps: DecaySweepDeps = {
  // Use the existing whole-corpus bounded reader: `readImprovementItems` defaults to
  // the newest 500 rows, which silently hides older resolved candidates. The planner
  // consumes payload lifecycle fields, but never candidate.body.
  projectIssues: projectAllIssuesForBoundedRead,
  mergeIssuePayload,
  commentIssue,
};

/** The scheduled entry — called from the improvement-watchdog action after the tick. */
export async function runDecaySweep(
  opts: PlanDecayOpts = {},
  deps: DecaySweepDeps = defaultDeps,
): Promise<DecaySweepResult> {
  const [plan] = await projectImprovementItemsForBoundedRead(
    { includeBody: false },
    {
      // Keep the full population inside the projector; only this one-row summary
      // leaves the bounded read seam.
      maxRows: 1,
      project: (all) => [{ scanned: all.length, actions: planDecaySweep(all, opts) }],
    },
    { projectIssues: deps.projectIssues },
  );
  if (!plan) throw new Error('runDecaySweep: whole-corpus projection returned no plan');
  const result: DecaySweepResult = { scanned: plan.scanned, verified: 0, recurred: 0, initialized: 0 };

  for (const a of plan.actions) {
    await deps.mergeIssuePayload(a.id, { ideaLifecycle: a.lifecycle });
    if (a.kind === 'verified') {
      result.verified += 1;
      await deps.commentIssue(
        a.id,
        `✓ Decay-verified: no same-signature recurrence in ${a.decayDays} day(s) since resolution (product class).`,
        'improvement-decay',
      );
    } else if (a.kind === 'recurred') {
      result.recurred += 1;
      await deps.commentIssue(
        a.id,
        `⟳ Regression signal: the friction signature re-surfaced ${a.recurrences} time(s) after this was resolved — lifecycle marked 'recurred' (the new capture carries the regression).`,
        'improvement-decay',
      );
    } else {
      result.initialized += 1; // silent — retro bookkeeping, not news
    }
  }

  if (result.verified || result.recurred) {
    void trackDetached(
      import('../../sync-sse').then((m) => Promise.all([
        m.notifySyncInvalidate('learning.improvements'),
        m.notifySyncInvalidate('learning.improvements.summary'),
      ])),
    ).catch(() => {});
    // Push-on-write for the Health tab's improvements panel
    // (stop-discarded-dedup-and-audit-server-polling-2026-07-26 P-013 / D-007) —
    // same lazy fire-and-forget discipline as the invalidate above.
    void trackDetached(
      import('../../system-health/compute').then((m) => m.refreshHealthPanel('improvements')),
    ).catch(() => {});
  }
  return result;
}
