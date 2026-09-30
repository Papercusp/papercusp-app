/**
 * precision-alert-ei.ts — durable EI escalation for the memory-precision
 * recall canary (EI-10047).
 *
 * The `memory-precision:bench` routine already replays the frozen gold set
 * against the production hybrid backend on a schedule and records r@10 — but
 * nothing ever ALERTED on a bad number, so a total search outage (schema
 * drift, a dead sidecar, vector-table corruption) presented as "memory
 * recall got quietly worse" with no canary. `precision-alert.ts` classifies
 * whether one run's r@10 is a regression; this module turns that classifier
 * verdict into a durable, dedup'd, auto-resolving EI, mirroring
 * replication-stall-ei.ts / own-log-fork-ei.ts's use of the shared
 * `createEpisodicEscalator` (EI-9030a) seam.
 *
 * One open EI per workspace: the canary condition is workspace-scoped, not
 * per-run, so the stable title keys on workspace only (no numeric values —
 * dedup requires an exact repeated string). Auto-resolves the moment a
 * later run comes back healthy.
 */
import {
  createEpisodicEscalator,
  type EpisodicEiDeps,
} from '../../escalation/episodic-ei';
import type { RecallDropEvaluation } from './precision-alert';

export const MEMORY_RECALL_CANARY_TOPIC = 'memory-recall-canary';

export interface RecallAlertEpisode {
  workspaceId: string;
  backend: string;
  rowId: number;
  evaluation: RecallDropEvaluation;
}

/** What a recovery needs to find + describe the EI it's closing. */
export type RecallAlertRecovery = Pick<RecallAlertEpisode, 'workspaceId' | 'backend' | 'rowId' | 'evaluation'>;

/** Stable, dedup-able title — ONE open EI per workspace regardless of how many runs re-confirm the regression. */
export function recallDropEiTitle(x: { workspaceId: string }): string {
  return `[memory-precision-bench] recall@10 canary regression (production hybrid gold-set bench, workspace=${x.workspaceId})`;
}

function fmt(v: number | null): string {
  return v == null ? '—' : v.toFixed(3);
}

function buildRecallDropBody(episode: RecallAlertEpisode): string {
  const { evaluation: ev } = episode;
  return (
    `Memory-precision recall canary (EI-10047): the scheduled gold-set replay against the ` +
    `production ${episode.backend} backend recorded a recall@10 regression.\n\n` +
    `workspace=${episode.workspaceId} row=harness_shared.memory_precision_bench#${episode.rowId}\n` +
    `latest r@10=${fmt(ev.latest)}  baseline (median of recent runs)=${fmt(ev.baseline)}  ` +
    `delta=${fmt(ev.delta)}  reason=${ev.reason}\n\n` +
    `Meaning: ${
      ev.reason === 'critical-floor' && ev.latest == null
        ? 'the bench itself produced no recall number at all this run — check the routine log for a thrown/skipped bench.'
        : ev.reason === 'critical-floor'
        ? 'recall@10 is at or near zero regardless of history — the classic signature of a TOTAL search outage that the ' +
          'degrade-never-throw backend design silently turns into "no results" instead of a visible error (e.g. ' +
          'schema drift, a dead embed sidecar, vector-table corruption — see the age A/B benchmark schema-drift incident).'
        : 'recall@10 dropped more than 5 points from its recent rolling baseline — a real regression, not per-run noise ' +
          '(the baseline is a median over several prior runs, resistant to a single outlier).'
    }\n\n` +
    `Triage: check the Learning tab memory-precision panel for the trend, and \`harness_shared.memory_precision_bench\` ` +
    `directly for the failing run's byClass/latency breakdown. This EI auto-resolves the next time a run comes back ` +
    `within baseline.`
  );
}

const escalator = createEpisodicEscalator<RecallAlertEpisode, RecallAlertRecovery, 'major'>({
  topic: MEMORY_RECALL_CANARY_TOPIC,
  stableTitle: recallDropEiTitle,
  buildBody: buildRecallDropBody,
  resolveNote: (recovery) =>
    `auto-resolved: recall canary back within baseline — latest r@10=${fmt(recovery.evaluation.latest)} ` +
    `baseline=${fmt(recovery.evaluation.baseline)} (row #${recovery.rowId}).`,
  severity: 'major',
  createdBy: 'system:memory-precision-bench',
  foundDuring: 'memory-precision-bench-recall-canary',
  extraTopics: ['memory', 'observability'],
});

/** DI seam so the dedup+file logic unit-tests without PG. */
export type RecallAlertEiDeps = EpisodicEiDeps<'major'>;

/** Test seam. */
export function _resetRecallDropEiForTests(): void {
  escalator._resetForTests();
}

/**
 * File a durable EI for a recall-drop episode, deduplicating against an open
 * EI for the same workspace. Returns the EI id when filed, null when deduped
 * or on failure (best-effort — the caller never lets this wedge the bench tick).
 */
export function fileRecallDropEi(
  episode: RecallAlertEpisode,
  deps?: RecallAlertEiDeps,
): Promise<string | null> {
  return escalator.file(episode, deps);
}

/**
 * Auto-resolve the open recall-drop EI for this workspace once a run comes
 * back healthy. No-ops when none is open (the normal case).
 */
export function resolveRecallDropEi(
  recovery: RecallAlertRecovery,
  deps?: RecallAlertEiDeps,
): Promise<string[]> {
  return escalator.resolve(recovery, deps);
}
