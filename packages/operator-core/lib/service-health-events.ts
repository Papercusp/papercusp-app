/**
 * service-health-events — bridge service up/down TRANSITIONS to the await primitive
 * (event-await-discoverability-and-coverage-2026-07-03 P-104).
 *
 * `runServiceHealthTick` (service-health.ts) already detects TRANSITION-ONLY up/down
 * changes per monitored service (the pure `diffHealth`) and broadcasts a coord message.
 * This ALSO fires an awaitable key on each transition, so an agent can
 *
 *   events:await { event: "service:up:substrate-sidecar" }   // block until recovered
 *   events:await { event: "service:down:operator" }          // wake the moment it drops
 *
 * instead of re-polling `dev:service_health`. The service name lives IN the key (a
 * required param), so a waiter for one service wakes only for THAT service — no payload
 * filtering. The transition source is grounded in code, not the plan's prose: the plan
 * named coord:conditions, but conditions.ts is a read-only FOLD (it derives open/resolved
 * on demand, it never fires on a transition); the actual up/down TRANSITION is `diffHealth`
 * inside the health tick, which is also exactly the state `dev:service_health` reads.
 *
 * Called fire-and-forget from the health tick; an emit failure can never break the sweep.
 * A duplicate emit (a re-probe that re-detects the same edge) is benign: await keys are
 * one-shot WAKE subscriptions, so a second fire with no live waiter is a no-op.
 */

import { emitAwaitedEvent } from './events/await/engine';

/**
 * Errors that are EXPECTED for a best-effort, fire-and-forget notification and so must
 * never warn (vitest-fail-on-console would then flake any rig test): a partial test schema
 * (a projection table the emit touches is absent → "… does not exist"), or the emit's async
 * query outliving the Postgres pool it ran on (a rig tearing down mid-emit → postgres.js
 * CONNECTION_ENDED/CONNECTION_DESTROYED). Anything else is a real surprise.
 */
function failSoft(scope: string, e: unknown): void {
  const msg = e instanceof Error ? e.message : String(e);
  if (/does not exist/.test(msg)) return;
  const code = (e as { code?: unknown } | null)?.code;
  if (
    code === 'CONNECTION_ENDED' ||
    code === 'CONNECTION_DESTROYED' ||
    /CONNECTION_ENDED|CONNECTION_DESTROYED|Connection ended/i.test(msg)
  ) {
    return;
  }
  console.warn(`[service-health-events] ${scope} emit failed: ${msg}`);
}

/** Injectable seam for tests. */
export interface ServiceHealthEventsDeps {
  emit?: typeof emitAwaitedEvent;
}

/**
 * Fire the awaitable key for one monitored-service health transition. `to:'up'` ⇒
 * `service:up:<name>` (recovered → HEALTHY); `to:'down'` ⇒ `service:down:<name>`
 * (→ UNHEALTHY). `detail` (the probe's note, when any) rides the summary + payload so a
 * woken waiter sees WHY without a follow-up probe. Fire-and-forget; never throws.
 */
export function emitServiceHealthTransitionEvent(
  name: string,
  to: 'up' | 'down',
  detail?: string,
  deps: ServiceHealthEventsDeps = {},
): void {
  const emit = deps.emit ?? emitAwaitedEvent;
  void Promise.resolve()
    .then(async () => {
      const key = `service:${to}:${name}`;
      const summary =
        to === 'up'
          ? `service "${name}" recovered`
          : `service "${name}" is DOWN${detail ? ` — ${detail}` : ''}`;
      await emit({ key, summary, payload: { name, to, detail: detail ?? null }, source: 'service-health' });
    })
    .catch((e: unknown) => failSoft(`${to}-event for ${name}`, e));
}
