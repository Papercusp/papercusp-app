/**
 * Pipeline event emissions — the post-run-loop plugin fire-point set
 * (plugin-system-hive-port-2026-06-11 P-004, D-003).
 *
 * The retired bash/TS run-loop fired a rich typed-hook set at lifecycle points
 * (pre-worker / post-worker / on-smoke-pass / … — `known-hooks.ts`'s `lost`
 * rows). Per D-003 the NEW pipeline fire-points are EVENT EMISSIONS only — no
 * new typed hooks. One emission is paid once and serves three consumers
 * simultaneously:
 *
 *   1. **reaction rules** (plugins / blueprints / the Events file) — the
 *      synthetic-event leg feeds the one matcher via `emitSystemEvent`, keyed
 *      `pipeline:<name>` with the payload as `args` / `result.data`;
 *   2. **`events:await`** — the awaited-event leg fires exact keys
 *      (`pipeline:done:<slug>:<feature>` …) so agents can sleep on a pipeline
 *      transition instead of polling;
 *   3. **UI / notify** — the awaited-event leg's notify half (inbox messages
 *      for `to:`-listed audiences; none by default).
 *
 * Vocabulary (the `name` axis):
 *   `launch`     — a harness run was launched              key `pipeline:launch:<slug>`
 *   `step-start` — a spine role dispatch is starting        key `pipeline:step-start:<slug>:<feature>:<role>`
 *   `step-done`  — a spine role dispatch finished           key `pipeline:step-done:<slug>:<feature>:<role>`
 *   `done`       — a feature pipeline finalized DONE        key `pipeline:done:<slug>:<feature>`
 *   `escalate`   — a feature pipeline finalized ESCALATE    key `pipeline:escalate:<slug>:<feature>`
 *
 * Replay-safety: call sites live INSIDE checkpointed DBOS steps (the invoke
 * runner, the finalize step), so a workflow replay does not re-fire completed
 * steps' emissions; a crash mid-step re-fires at most once (at-least-once,
 * same as every awaited-event source). Both legs are best-effort — an emit
 * failure never breaks the pipeline.
 */

import { emitAwaitedEvent, type EmitAwaitedEventOpts } from './await/engine';
import { emitSystemEvent } from './engine';

export type PipelineEventName = 'launch' | 'step-start' | 'step-done' | 'done' | 'escalate';

export interface PipelineEventInput {
  name: PipelineEventName;
  harnessSlug: string;
  /** Required for every name except `launch`. */
  featureId?: string;
  /** The spine role (step events). */
  role?: string;
  /** The agent run's idempotency key (step events) — correlates with usage events. */
  runId?: string;
  /** The role run's exit code (`step-done`). */
  exitCode?: number;
  /** The role run's wall-clock duration (`step-done`). */
  durationMs?: number;
  /** The escalation reason (`escalate`). */
  reason?: string;
  workspaceId?: string;
}

/** Injectable seams for tests. */
export interface PipelineEventDeps {
  emit?: (opts: EmitAwaitedEventOpts) => Promise<unknown>;
  system?: typeof emitSystemEvent;
}

/** The exact `events:await` key for a pipeline event. Exported for awaiters/tests. */
export function pipelineEventKey(e: Pick<PipelineEventInput, 'name' | 'harnessSlug' | 'featureId' | 'role'>): string {
  switch (e.name) {
    case 'launch':
      return `pipeline:launch:${e.harnessSlug}`;
    case 'step-start':
    case 'step-done':
      return `pipeline:${e.name}:${e.harnessSlug}:${e.featureId ?? '-'}:${e.role ?? '-'}`;
    case 'done':
    case 'escalate':
      return `pipeline:${e.name}:${e.harnessSlug}:${e.featureId ?? '-'}`;
  }
}

function summarize(e: PipelineEventInput): string {
  switch (e.name) {
    case 'launch':
      return `harness ${e.harnessSlug} launched`;
    case 'step-start':
      return `${e.harnessSlug}/${e.featureId}: ${e.role} starting`;
    case 'step-done':
      return `${e.harnessSlug}/${e.featureId}: ${e.role} finished (exit=${e.exitCode ?? '?'})`;
    case 'done':
      return `${e.harnessSlug}/${e.featureId}: pipeline DONE`;
    case 'escalate':
      return `${e.harnessSlug}/${e.featureId}: pipeline ESCALATED${e.reason ? ` — ${e.reason}` : ''}`;
  }
}

/**
 * Fire one pipeline event on both legs (awaited-event + reaction matcher).
 * Fire-and-forget shape: never throws, never rejects.
 */
export function emitPipelineEvent(e: PipelineEventInput, deps: PipelineEventDeps = {}): void {
  const payload: Record<string, unknown> = {
    name: e.name,
    harness: e.harnessSlug,
    ...(e.featureId !== undefined ? { feature: e.featureId } : {}),
    ...(e.role !== undefined ? { role: e.role } : {}),
    ...(e.runId !== undefined ? { runId: e.runId } : {}),
    ...(e.exitCode !== undefined ? { exitCode: e.exitCode } : {}),
    ...(e.durationMs !== undefined ? { durationMs: e.durationMs } : {}),
    ...(e.reason !== undefined ? { reason: e.reason } : {}),
  };

  // Leg 1 — reaction rules (synchronous up to the schedule point; never throws).
  try {
    (deps.system ?? emitSystemEvent)({
      tool: `pipeline:${e.name}`,
      args: payload,
      harnessSlug: e.harnessSlug,
      ...(e.workspaceId ? { workspaceId: e.workspaceId } : {}),
    });
  } catch (err) {
    console.warn(`[pipeline-events] reaction leg failed for ${e.name}: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Leg 2 — awaited event (wakes + notify). Async, best-effort.
  void Promise.resolve()
    .then(() =>
      (deps.emit ?? emitAwaitedEvent)({
        key: pipelineEventKey(e),
        summary: summarize(e),
        payload,
        source: 'pipeline',
        ...(e.workspaceId ? { workspaceId: e.workspaceId } : {}),
      }),
    )
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      // A missing event_awaits relation = a partial test schema — fail-soft.
      if (/does not exist/.test(msg)) return;
      console.warn(`[pipeline-events] await leg failed for ${e.name}: ${msg}`);
    });
}
