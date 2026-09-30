/**
 * P-024 (frozen-candidate-stays-frozen-through-all-fixes-2026-09-03, D-003 / D-011):
 * the gate's stale-red RE-TRIAGE re-runs the failing legs at a second sha and, when they pass
 * there, REFIRES the whole gate on that sha. Before this module that sha was always the
 * integration tip (`deps.resolveTip()`), even while a repair queue row was frozen — measured
 * 2026-09-04 12:23:16Z: queue frozen at 97c0b102 @ repairHead a93a1cab, re-triage refired at
 * 88b78003, a sha that does NOT descend from the lineage and IS an ancestor of staging. A fresh
 * cut at tip taken while the freeze was held: the fourth un-freezing path (WI-2144110), same
 * class as the deleted age / stall / fossil retirements.
 *
 * RULE. While a queue row exists — in the run's own snapshot OR persisted since the run started
 * — the only sha re-triage may re-run at, and the only sha it may refire on, is the frozen
 * lineage's head (`repairHead`, which advances ONLY by path-exact admission, D-002). The
 * integration tip is never consulted on that branch, and a head that does not descend from the
 * frozen candidate is refused rather than judged. Only when no row exists anywhere does the
 * resolver answer with the integration tip, which is today's un-frozen behaviour unchanged.
 *
 * Pure by construction: every read is an injected callback, so the property is testable
 * without git and the gate cannot fall back to a moving object by accident.
 */
import type { FrozenCandidateRepairQueue } from './frozen-candidate-repair-queue';

export type RetriageTarget =
  /** No queue row anywhere: re-triage at the integration tip (null when it could not be read). */
  | { kind: 'integration-tip'; ref: string | null; queueSource: 'none' }
  /** A queue row exists: re-triage at the lineage head, never the tip. */
  | { kind: 'lineage-head'; ref: string; candidate: string; queueSource: 'fresh' | 'snapshot' }
  /** A queue row exists but its head could not be trusted: re-triage is DECLINED, never widened to the tip. */
  | {
      kind: 'declined';
      ref: null;
      candidate: string;
      queueSource: 'fresh' | 'snapshot';
      reason: 'not-a-lineage-descendant' | 'descendant-check-failed';
      detail: string;
    };

export type RetriageTargetInput = {
  /** The row the run read before its suite — may be stale: an admission can move repairHead mid-run. */
  repairQueue: FrozenCandidateRepairQueue | null;
  /** Re-read the persisted row right now (the WI-2141375 idiom). A throw or null falls back to the snapshot. */
  readFreshQueue?: () => Promise<FrozenCandidateRepairQueue | null>;
  /** The integration branch tip — consulted ONLY when no queue row exists anywhere. */
  resolveIntegrationTip?: () => Promise<string | null>;
  /** `git merge-base --is-ancestor <candidate> <ref>`: does `ref` descend from the frozen candidate? */
  isLineageDescendant?: (candidate: string, ref: string) => Promise<boolean>;
};

/**
 * Prefer the persisted row over the run's pre-suite snapshot: a peer's admission may have advanced
 * `repairHead` while the suite ran, and re-triaging at the OLD head would re-run legs the peer
 * already fixed. Fail CLOSED: a read fault, or a null read while the snapshot holds a row, keeps the
 * snapshot — a freeze is never dropped because a reader blinked (P-025: unreadable is not absent).
 */
async function currentQueueRow(
  input: RetriageTargetInput,
): Promise<{ queue: FrozenCandidateRepairQueue; source: 'fresh' | 'snapshot' } | null> {
  let fresh: FrozenCandidateRepairQueue | null = null;
  if (input.readFreshQueue) {
    try {
      fresh = await input.readFreshQueue();
    } catch {
      fresh = null;
    }
  }
  if (fresh) return { queue: fresh, source: 'fresh' };
  if (input.repairQueue) return { queue: input.repairQueue, source: 'snapshot' };
  return null;
}

export async function resolveRetriageTarget(input: RetriageTargetInput): Promise<RetriageTarget> {
  const row = await currentQueueRow(input);
  if (!row) {
    let tip: string | null = null;
    if (input.resolveIntegrationTip) {
      try {
        tip = await input.resolveIntegrationTip();
      } catch {
        tip = null;
      }
    }
    return { kind: 'integration-tip', ref: tip, queueSource: 'none' };
  }
  const { queue, source } = row;
  const head = queue.repairHead;
  if (input.isLineageDescendant) {
    let descends: boolean;
    try {
      descends = await input.isLineageDescendant(queue.candidate, head);
    } catch (e) {
      return {
        kind: 'declined',
        ref: null,
        candidate: queue.candidate,
        queueSource: source,
        reason: 'descendant-check-failed',
        detail:
          `re-triage declined: could not prove repairHead ${head.slice(0, 8)} descends from frozen candidate ` +
          `${queue.candidate.slice(0, 8)} (${e instanceof Error ? e.message : String(e)}); the tip is never the fallback`,
      };
    }
    if (!descends) {
      return {
        kind: 'declined',
        ref: null,
        candidate: queue.candidate,
        queueSource: source,
        reason: 'not-a-lineage-descendant',
        detail:
          `re-triage declined: repairHead ${head.slice(0, 8)} does not descend from frozen candidate ` +
          `${queue.candidate.slice(0, 8)} — refusing to judge a sha outside the lineage`,
      };
    }
  }
  return { kind: 'lineage-head', ref: head, candidate: queue.candidate, queueSource: source };
}

/** One line for the gate log naming what the re-triage will run at and why. */
export function describeRetriageTarget(target: RetriageTarget): string {
  switch (target.kind) {
    case 'integration-tip':
      return target.ref
        ? `re-triage target: integration tip ${target.ref.slice(0, 8)} (no repair queue row exists)`
        : 're-triage target: integration tip could not be resolved (no repair queue row exists)';
    case 'lineage-head':
      return (
        `re-triage target: frozen lineage head ${target.ref.slice(0, 8)} of candidate ` +
        `${target.candidate.slice(0, 8)} (${target.queueSource} queue row) — the integration tip is never judged while a row exists (P-024)`
      );
    case 'declined':
      return target.detail;
  }
}
