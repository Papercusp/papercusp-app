/**
 * liveness.ts — the legacy 3-tone HEARTBEAT-AGE display scale, as a
 * DEPENDENCY-FREE leaf.
 *
 * Both the server (@/lib/adv-roster, which carries the compatibility tone for
 * older clients) and the client (the presence UI's LivenessDot fallback) need
 * this. The
 * server module can't be imported from a client component — it pulls in the PG
 * presence store and would leak node builtins into the SPA bundle (the
 * operator-vite blank-page failure mode). So the thresholds + the pure
 * derivation live here, importing nothing.
 *
 * STALE_MS mirrors PRESENCE_STALE_MS in @papercusp/coordination/presence; a
 * unit test (adv-roster.test.ts) asserts they stay equal so this copy can't
 * drift.
 */

/** Heartbeat younger than this = "live" (a tool call within the last minute). */
export const LIVE_MS = 60_000;

/** Heartbeat older than this = "stale" (mirrors coordination's PRESENCE_STALE_MS). */
export const STALE_MS = 600_000;

// 'pending' is NOT derived from a heartbeat — it is stamped on a roster entry
// synthesized from a recorded-but-not-yet-running launch (pui-reactive-session-
// panes D-006). deriveLiveness never returns it.
export type Liveness = 'live' | 'idle' | 'stale' | 'pending';

/**
 * Reduce heartbeat age to the legacy three visual tones. This is PROCESS
 * KEEPALIVE freshness, not an agent-liveness verdict. New verdict consumers
 * must use `resolveSessionStates`; UI code with a roster payload should project
 * its `sessionState` and use this only when that field is unavailable.
 */
export function heartbeatAgeTone(heartbeatAtIso: string, nowMs: number): Liveness {
  const t = new Date(heartbeatAtIso).getTime();
  if (!Number.isFinite(t)) return 'stale';
  const age = nowMs - t;
  if (age < LIVE_MS) return 'live';
  if (age < STALE_MS) return 'idle';
  return 'stale';
}

/**
 * @deprecated Ambiguous name: this derives only a heartbeat-age DISPLAY tone,
 * not liveness. Use `resolveSessionStates` for a verdict or
 * `heartbeatAgeTone` for the explicit compatibility projection.
 */
export function deriveLiveness(heartbeatAtIso: string, nowMs: number): Liveness {
  return heartbeatAgeTone(heartbeatAtIso, nowMs);
}
