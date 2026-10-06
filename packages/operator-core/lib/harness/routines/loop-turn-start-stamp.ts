/**
 * loop-turn-start-stamp.ts — the real-time "this loop fire became a turn" signal
 * (EI-24791346664119438).
 *
 * `reconcile-loop-routines` decides whether a delivered loop wake produced a
 * loop turn from `session_turns`, which is INGESTED from transcripts after the
 * turn. Measured 2026-10-02 over 24h: 64 of 334 'delivered-wake-no-loop-turn'
 * settles were real loop turns (loop-fire prompt ~70s after the fire, mean turn
 * 329s) whose rows were ingested 500-600s after the reconciler had already
 * scored the fire an error. Presence could not rescue them: 1 of 64 had any
 * activity in the 60s before the settle (a long silent Bash or text generation
 * is quiet), and the Stop-hook journal only lands at turn END.
 *
 * The turn-start endpoint receives every UserPromptSubmit in real time,
 * including the prompt head that carries the `⟦turn-origin:loop-fire …⟧`
 * envelope. When it does, this module appends one `kind:'lifecycle'` activity
 * row with LOOP_TURN_START_MARKER, which the reconciler reads as
 * `loop_turn_started_at`. Reuses the existing agent_activity store and its
 * TelemetryStore seam: no new table, no migration.
 *
 * Fail-silent by contract: it runs inside the turn-start hook request, whose
 * whole rule is that it must never cost the agent's turn.
 */
import type { ActivityRecord, TelemetryStore } from '@papercusp/activity-bridge';
import { LOOP_TURN_START_MARKER } from '../../agent-tools/activity/lifecycle-markers';
import { parseEnvelope } from '../../turn-provenance/turn-provenance';

/** True when the prompt OPENS with a loop-fire turn-origin envelope. Uses the one
 *  shared envelope grammar (`parseEnvelope`), so an envelope quoted mid-text, or
 *  any other origin, never stamps. */
export function isLoopFirePrompt(prompt: string): boolean {
  return parseEnvelope(prompt ?? '')?.origin === 'loop-fire';
}

export interface LoopTurnStartInput {
  owner: string;
  prompt: string;
  workspaceId: string;
  cwd?: string | null;
  client?: string | null;
}

/** Build the activity row for a loop-fire turn start, or null when the prompt is
 *  not a loop-fire turn. Pure: the route test and the reconciler both rely on the
 *  summary being EXACTLY LOOP_TURN_START_MARKER. */
export function loopTurnStartRecord(input: LoopTurnStartInput): ActivityRecord | null {
  const owner = (input.owner ?? '').trim();
  if (!owner || !isLoopFirePrompt(input.prompt)) return null;
  const envelope = parseEnvelope(input.prompt);
  return {
    owner,
    agent: input.client || null,
    sessionId: null,
    scope: null,
    kind: 'lifecycle',
    toolName: null,
    phase: null,
    toolUseId: null,
    summary: LOOP_TURN_START_MARKER,
    status: null,
    detail: envelope ? { origin: envelope.origin, nonce: envelope.nonce, source: 'turn-start' } : null,
    cwd: input.cwd ?? null,
    workspaceId: input.workspaceId,
  };
}

/** Append the stamp when the prompt is a loop-fire turn. Never throws; returns
 *  whether a row was appended (for tests and diagnostics). */
export async function recordLoopTurnStart(
  input: LoopTurnStartInput,
  store?: Pick<TelemetryStore, 'append'>,
): Promise<boolean> {
  const record = loopTurnStartRecord(input);
  if (!record) return false;
  try {
    const target = store ?? (await import('../../activity-pg-store')).createPgTelemetryStore();
    await target.append(record);
    return true;
  } catch {
    return false;
  }
}
