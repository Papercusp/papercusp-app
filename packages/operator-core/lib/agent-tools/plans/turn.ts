/**
 * executePlanAgentTurn — the shared "run one turn of a plan agent"
 * core. plan-agent-launch-2026-05-21, Phase 3.
 *
 * `plans:launch` (P-012) and `plans:resume` (P-013) differ only at the
 * edges: launch mints a `plan_runs` row + a fresh session id, resume
 * looks an existing run up and reuses its session id. Everything
 * between — persist the user turn, stream the agent, persist the
 * assistant turn, settle the run status — is identical. That shared
 * middle lives here so the two tools cannot drift apart.
 *
 * The runner (`runPlanAgent`) is `sessionMode: 'force'` (create-or-
 * resume), so this same function drives both the first turn and every
 * continuation (D-010).
 */

import { runPlanAgent } from './runner';
import {
  appendPlanRunTurn,
  setPlanRunStatus,
  type PlanRunStatus,
  type PlanRunTurnRole,
} from './runs';
import { trackDetached } from '../../detached-imports';

/**
 * Append a transcript turn, best-effort — the run has already streamed
 * to the caller, so a lost `plan_run_turns` row must not fail the
 * tool. The DAL throws on DB failure; this swallows + logs it.
 */
async function persistTurn(
  runId: number,
  turn: {
    role: PlanRunTurnRole;
    content: string;
    tokensIn?: number;
    tokensOut?: number;
    costUsd?: number;
  },
): Promise<void> {
  try {
    await appendPlanRunTurn({ planRunId: runId, ...turn });
  } catch (err) {
    console.warn(
      `[plans] failed to persist ${turn.role} turn for run ${runId}: ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }
}

export interface ExecutePlanTurnOptions {
  /** The `plan_runs` row this turn belongs to. */
  runId: number;
  /** The run's stable session id (`runAgentChat` session == `?plan_run=`). */
  sessionId: string;
  /** The launch seed — the P-009 context bundle, sent as SYSTEM prompt.
   *  Re-passed on every turn: the agent backend applies it per-spawn
   *  (`--append-system-prompt`), so a resumed turn is re-seeded with
   *  the *current* plan. */
  systemPromptText: string;
  /** This turn's user message — launch note / default kickoff, or the
   *  resume continuation message. */
  promptText: string;
  /** Working directory — the workspace root (D-008). */
  cwd: string;
  /** Browser-tab client id, when the turn originated from a tab. */
  uiClientId?: string | null;
  /**
   * Gateway admission-tier label (gateway-priority-tiers WI-4542/WI-5676) —
   * forwarded verbatim to `runPlanAgent` → `runAgentChat`. See
   * `RunPlanAgentOptions.priority` for the full contract. Omitted → the
   * runner's own 'su' default applies.
   */
  priority?: string;
  /** Cancellation — forwarded to the spawned process. */
  signal?: AbortSignal;
  /** Wire-event sink — `delta` / `tool_call` / `cost` / `error`. */
  emit: (name: string, data: unknown) => void;
}

export interface ExecutePlanTurnResult {
  /** Settled run status — `idle` (resumable) or `failed`. */
  status: PlanRunStatus;
  /** This turn's cost in USD. */
  costUsd: number;
  /** The assistant's full reply text. */
  finalText: string;
}

/**
 * Run one turn of a plan agent: persist the user turn, stream the
 * agent (emitting `delta` / `tool_call` / `cost` / `error`), persist
 * the assistant turn, and settle the run's status. Never throws — a
 * backend failure is reported as `status: 'failed'` + an `error`
 * event, so the caller can always finish cleanly.
 */
export async function executePlanAgentTurn(
  opts: ExecutePlanTurnOptions,
): Promise<ExecutePlanTurnResult> {
  // 1. Persist the user turn (the kickoff / note / continuation).
  await persistTurn(opts.runId, { role: 'user', content: opts.promptText });

  // 2. Run the agent, streaming events and accumulating the reply.
  let finalText = '';
  let costUsd = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let status: PlanRunStatus = 'idle';
  try {
    for await (const ev of runPlanAgent({
      sessionId: opts.sessionId,
      systemPromptText: opts.systemPromptText,
      promptText: opts.promptText,
      cwd: opts.cwd,
      uiClientId: opts.uiClientId ?? null,
      priority: opts.priority,
      signal: opts.signal,
    })) {
      if (ev.type === 'delta') {
        opts.emit('delta', { text: ev.text });
        finalText += ev.text;
      } else if (ev.type === 'tool_call') {
        opts.emit('tool_call', { name: ev.name, input: ev.input });
      } else if (ev.type === 'result') {
        costUsd = ev.costUsd;
        tokensIn = ev.tokensIn;
        tokensOut = ev.tokensOut;
        // runAgentChat's terminal result.finalText can be more complete
        // than the streamed accumulation — prefer the longer.
        if (ev.finalText.length > finalText.length) finalText = ev.finalText;
        opts.emit('cost', { usd: ev.costUsd });
      } else if (ev.type === 'error') {
        status = 'failed';
        opts.emit('error', {
          message: ev.stderr
            ? `${ev.message}: ${ev.stderr.slice(0, 400)}`
            : ev.message,
        });
      }
    }
  } catch (err) {
    status = 'failed';
    opts.emit('error', {
      message: err instanceof Error ? err.message : String(err),
    });
  }

  // 3. Persist the assistant turn.
  await persistTurn(opts.runId, {
    role: 'assistant',
    content: finalText,
    tokensIn,
    tokensOut,
    costUsd,
  });

  // 4. Settle the run status: idle (resumable — D-010) or failed.
  try {
    await setPlanRunStatus(opts.runId, status);
  } catch (err) {
    console.warn(
      `[plans] failed to set final status for run ${opts.runId}: ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }

  // await-event-primitive-2026-06-05 P-014 (D-006 #6): a settled plan-run turn
  // is an awaitable event — `events:await { event: 'plan-run:finished:<runId>' }`
  // wakes the waiter instead of the old poll-the-sweep pattern (the sweep in
  // runs.ts stays as the orphan-lease backstop). Fire-and-forget; lazy import
  // (the engine's plan-run wake channel imports THIS module).
  void trackDetached(import('../../events/await/engine'))
    .then(({ emitAwaitedEvent }) =>
      emitAwaitedEvent({
        key: `plan-run:finished:${opts.runId}`,
        summary: `plan run ${opts.runId} turn settled → ${status}`,
        payload: { runId: opts.runId, status, costUsd },
        source: 'plan-runs',
      }),
    )
    .catch(() => {});

  return { status, costUsd, finalText };
}
