'use client';

/**
 * presence-ui — shared liveness primitives for the agent-presence surfaces:
 * the /coord dashboard and the /adv Sessions roster.
 *
 * Only the genuinely style-neutral atom is shared — the 3-state LivenessDot +
 * the client-side liveness derivation. The two surfaces' ROW markup differs too
 * much (dark Tailwind dashboard vs the pc-* roster) to share a single row
 * component without a leaky props API, so each builds its own row on this dot.
 *
 * The liveness thresholds come from the dep-free leaf @/lib/liveness (the same
 * source the server roster endpoint uses), so client + server can't drift.
 */

import { heartbeatAgeTone, type Liveness } from '@papercusp/operator-core/lib/liveness';
import type { SessionState } from '@papercusp/operator-core/lib/agent-tools/coordination/presence-wakeability';
import type { CSSProperties } from 'react';
import styles from './presence-ui.module.css';

export type { Liveness, SessionState };

/** Explicit heartbeat-age DISPLAY tone for old/degraded payloads. */
export function heartbeatToneFromTimestamp(heartbeatAtIso: string, nowMs: number = Date.now()): Liveness {
  return heartbeatAgeTone(heartbeatAtIso, nowMs);
}

/**
 * @deprecated Ambiguous name: this is heartbeat freshness, not an agent
 * liveness verdict. Prefer the roster's `sessionState` (or pass it to
 * `LivenessDot`); use `heartbeatToneFromTimestamp` only as a compatibility
 * fallback when the oracle field is unavailable.
 */
export function livenessFromHeartbeat(heartbeatAtIso: string, nowMs: number = Date.now()): Liveness {
  return heartbeatToneFromTimestamp(heartbeatAtIso, nowMs);
}

export const LIVENESS_TITLE: Record<Liveness, string> = {
  live: 'Active — tool call < 1 min ago',
  idle: 'Idle — no recent tool call (may be mid-reasoning), not gone',
  stale: 'Stale — no heartbeat in > 10 min',
};

const SESSION_STATES: ReadonlySet<SessionState> = new Set([
  'live',
  'parked',
  'draining',
  'suspect',
  'ended',
  'recorded',
]);

/**
 * Keep the dot's existing three visual tones while making the coordinator's
 * richer session-state vocabulary visible to the caller. Heartbeat freshness
 * remains the fallback for older/degraded roster payloads; when the oracle
 * provides a state, it is authoritative.
 */
export function livenessForSessionState(sessionState: SessionState): Liveness {
  switch (sessionState) {
    case 'live':
      return 'live';
    case 'parked':
    case 'recorded':
      return 'idle';
    case 'draining':
    case 'suspect':
    case 'ended':
      return 'stale';
  }
}

/** Accept only the coordinator's known vocabulary from a JSON roster payload. */
export function normalizeSessionState(value: string | null | undefined): SessionState | null {
  return value && SESSION_STATES.has(value as SessionState) ? (value as SessionState) : null;
}

/**
 * A small 3-state liveness indicator. Portable across both styling systems
 * and tokenized through CSS so route chrome can skin it without hardcoded
 * colors. `title` overrides the default per-state tooltip.
 */
export function LivenessDot({
  liveness,
  sessionState,
  title,
  size = 8,
}: {
  liveness: Liveness;
  sessionState?: SessionState | null;
  title?: string;
  size?: number;
}): React.JSX.Element {
  const displayLiveness = sessionState ? livenessForSessionState(sessionState) : liveness;
  return (
    <span
      role="img"
      aria-label={`${sessionState ?? displayLiveness} agent`}
      data-liveness={displayLiveness}
      data-session-state={sessionState ?? undefined}
      className={styles.dot}
      title={title ?? (sessionState ? `Session state: ${sessionState}` : LIVENESS_TITLE[liveness])}
      style={{
        '--liveness-dot-size': `${size}px`,
      } as CSSProperties}
    />
  );
}
