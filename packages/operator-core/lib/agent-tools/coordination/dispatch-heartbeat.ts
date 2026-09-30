/**
 * dispatch-heartbeat — the turn-level presence beat at the projected-tool
 * dispatch seam (agent-liveness-heartbeat-hardening-2026-06-12 P-001).
 *
 * Gap: `coord_presence.heartbeat_at` bumped ONLY on coord:declare-intent and
 * coord:inbox reads, so a session agent in a long stretch of non-coord
 * platform calls (locks from the per-edit hook, plans:*, work_items:*) read
 * as presence-stale to every liveness consumer — the stale-claims sweep's
 * presence leg, the roster, fleet:assignments. This module beats presence for
 * ANY authenticated projected dispatch, throttled per owner, so the lock
 * traffic of an actively-editing agent is itself the heartbeat.
 *
 * Beat method: `touchActivity` — a projected tool dispatch IS genuine activity,
 * so it bumps `last_active_at` (AND heartbeat_at), distinct from the 60s
 * keepalive which bumps heartbeat_at only (presence-v2 D-003). Like
 * `touchHeartbeat` it is a no-op when no presence row exists (NOT
 * `heartbeatPresence`/ensure-row) — so one-shot HTTP callers never mint roster
 * rows (agent-liveness-heartbeat-hardening D-003); agents that matter declare
 * intent at session start.
 *
 * Placement: called from `recordInvocationImpl` (projected-tool-deps.ts),
 * which the dispatcher's telemetry finally-block invokes on every settled
 * dispatch (success, gate denial, error, timeout). Dispatches without a
 * quota windowKey skip telemetry and therefore skip the beat — acceptable:
 * the beat is breadth, not a guarantee, and the catalog tools that matter
 * are quota-tracked.
 *
 * The throttle Map is module-scope deliberately: it is pure rate-limiting
 * (losing it on restart costs at most one extra indexed UPDATE per owner),
 * not durable state, so the storage policy's no-module-scoped-state rule
 * does not apply.
 */
import { resolveAgentIdentity, type ResolveIdentityCtx } from './identity';
import { touchActivity } from './presence';
import { reactivateAdvSessionByOwner } from '../../adv-sessions';
import {
  createPresenceBeatThrottle,
  PRESENCE_BEAT_INTERVAL_MS,
} from './presence-beat-throttle';

/** Minimum gap between beats for one owner. Presence staleness windows are
 *  60s (roster LIVE_MS) and 10min (claims sweep) — 45s keeps both fresh
 *  while costing at most ~1.3 UPDATEs/min per busy agent. */
export const DISPATCH_BEAT_INTERVAL_MS = PRESENCE_BEAT_INTERVAL_MS;

/** The dispatch beat's own throttle instance (EI-6797: shared factory, private
 *  Map — never suppresses the sibling inbox heartbeat throttle). */
const throttle = createPresenceBeatThrottle(DISPATCH_BEAT_INTERVAL_MS);

/** Test seam: reset throttle state between cases. */
export function __resetDispatchHeartbeatThrottle(): void {
  throttle.reset();
}

/**
 * Best-effort presence beat for the dispatch's resolved owner. Never throws;
 * never blocks the dispatch (fire-and-forget write). Anonymous/unresolvable
 * callers are skipped — identity resolution failures are EXPECTED here (the
 * public catch-all, malformed contexts) and must not become errors.
 *
 * Injectable `beat` (default touchActivity) + `now` keep the unit tests
 * pure — no PG, no fake timers fighting the fire-and-forget promise.
 */
export function maybeBeatPresenceOnDispatch(
  ctx: unknown,
  opts: {
    beat?: (ownerId: string) => Promise<void>;
    reactivate?: (ownerId: string) => Promise<boolean>;
    now?: () => number;
  } = {},
): void {
  const beat = opts.beat ?? touchActivity;
  const reactivate = opts.reactivate ?? reactivateAdvSessionByOwner;
  const nowFn = opts.now ?? Date.now;

  let ownerId: string | null;
  try {
    ownerId = resolveAgentIdentity(ctx as ResolveIdentityCtx).ownerId;
  } catch {
    return;
  }
  if (!ownerId) return;

  if (!throttle.shouldBeat(ownerId, nowFn())) return;

  void Promise.resolve()
    .then(async () => {
      // A stateless MCP recovery call can keep coord_presence alive after a
      // transport drop without ever re-running coord:declare-intent. Revive
      // the matching ended adv_sessions row alongside that genuine activity
      // so fleet chrome follows the same liveness signal.
      await Promise.all([beat(ownerId), reactivate(ownerId)]);
    })
    .catch(() => {
      /* a missed beat/reactivation must never surface — the next dispatch retries */
    });
}
