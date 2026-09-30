/**
 * service-up-edge — the ONE predicate behind every surface that can arm a
 * `service:up:<name>` wait.
 *
 * EI-20268841604319803 (MEASURED 2026-08-12): an agent armed
 * `events:await { event:'service:up:inference-gateway', timeout_sec:21600 }`,
 * the gateway demonstrably restarted 5h27m later (old listener pid gone, new
 * MainPID, fresh ExecMainStartTimestamp, /stats 200) — and the await never
 * fired. It surfaced ~56 minutes after the restart as a TIMEOUT.
 *
 * WHY: `service:up:<name>` is emitted from a `diffHealth` UP-TRANSITION
 * (unhealthy→healthy). A restart that completes without the health tick ever
 * SAMPLING an unhealthy state produces no transition, so it emits nothing.
 * For a flap-damped name (`DOWN_CONFIRM_TICKS`) that is not merely likely but
 * STRUCTURAL: damping exists precisely to swallow short restart blips, so the
 * very services that restart routinely are the ones whose restarts can never
 * produce the edge.
 *
 * WHY IT NEEDED A SHARED PREDICATE RATHER THAN ONE MORE CHECK. The knowledge
 * was already in the tree and already correct — `service:await-up` (sugar.ts)
 * probes the named service at arm time, short-circuits when it is already
 * healthy, and even reconciles a recovery that lands mid-registration. Its
 * own comment stated the rule outright: "a service-up key is an EDGE, so it
 * cannot satisfy a waiter when the service is already healthy." But the RAW
 * `events:await` path — the one the incident used — shared none of it and
 * armed a dead edge wait in silence.
 *
 * That is the failure this module is shaped against: one key, two surfaces,
 * opposite safety, and the unprotected surface's SILENCE is indistinguishable
 * from a clean bill of health. Copying the condition into the second caller
 * would make them agree today and drift tomorrow, so both now call these
 * functions instead, and `service-up-edge.test.ts` asserts they agree.
 *
 * Every probe here FAILS OPEN: an unreadable or slow health read must preserve
 * the caller's normal wait rather than manufacture an all-clear.
 */

import { withBoundedTimeout } from '../../bounded-timeout';
import { DOWN_CONFIRM_TICKS, probeNamedService, type ProbeResult } from '../../service-health';

/** Literal prefix of the service-up family's key template. */
export const SERVICE_UP_KEY_PREFIX = 'service:up:';

/**
 * Short, fail-open budget for the arm-time health probe. A slow probe must
 * never delay registration meaningfully, and must never be read as "down".
 */
export const SERVICE_UP_PROBE_TIMEOUT_MS = 1_500;

/**
 * Pure: the service name in a LITERAL `service:up:<name>` key, else null.
 *
 * Deliberately rejects a glob (`service:up:*`). A pattern await is an
 * intentional wake-on-ANY-instance subscription, so "is one specific service
 * healthy right now" is not a question that can be asked about it, and every
 * other key guard in await.ts skips patterns for the same reason.
 */
export function parseServiceUpKey(eventKey: string): string | null {
  if (!eventKey.startsWith(SERVICE_UP_KEY_PREFIX)) return null;
  const name = eventKey.slice(SERVICE_UP_KEY_PREFIX.length);
  if (name.length === 0) return null;
  if (name.includes('*')) return null;
  return name;
}

/** Pure: is this service's DOWN detection flap-damped (`DOWN_CONFIRM_TICKS`)? */
export function isFlapDamped(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(DOWN_CONFIRM_TICKS, name);
}

export interface ServiceUpProbeDeps {
  probe?: typeof probeNamedService;
}

/**
 * Bounded, FAIL-OPEN probe of one named service. Returns the probe result only
 * when the service is affirmatively healthy AND present; returns null for
 * "down", "absent", "unknown", "timed out" and "probe threw" alike.
 *
 * Collapsing those cases is intentional: every caller uses a non-null return
 * to say something STRONGER than a wait ("you are already there"), so an
 * unreadable probe must land on the side that preserves the wait.
 */
export async function probeServiceUpLatch(
  name: string,
  deps: ServiceUpProbeDeps = {},
): Promise<ProbeResult | null> {
  const probeFn = deps.probe ?? probeNamedService;
  const probe = await withBoundedTimeout(() => probeFn(name), {
    fallback: null,
    timeoutMs: SERVICE_UP_PROBE_TIMEOUT_MS,
    label: 'service-up-edge:healthLatch',
  });
  const result = probe.value;
  return result && result.up && result.present !== false ? result : null;
}

/**
 * Pure: the advisory for a raw `events:await` that arms a service-up wait on a
 * service which is healthy RIGHT NOW.
 *
 * Advisory, never a refusal — consistent with every other key guard in
 * await.ts. Arming this deliberately is legitimate (an agent about to cause a
 * long outage genuinely wants the recovery edge); what is NOT legitimate is
 * arming it by accident and learning only at the deadline.
 */
export function buildServiceUpEdgeAdvice(name: string, opts: { damped: boolean }): string {
  const damping = opts.damped
    ? ` "${name}" is also flap-damped (DOWN_CONFIRM_TICKS), which suppresses short down-blips BY DESIGN — so a brief restart of this service structurally cannot produce the edge, no matter how the tick lands.`
    : '';
  return (
    `Service "${name}" is HEALTHY right now, and "${SERVICE_UP_KEY_PREFIX}${name}" fires only on an ` +
    `unhealthy→healthy TRANSITION — so nothing can fire until the health tick first OBSERVES it unhealthy. ` +
    `A restart that completes between health ticks never produces that observation and emits NOTHING, so ` +
    `this await CANNOT confirm a restart: it will simply time out (measured: EI-20268841604319803, a real ` +
    `gateway restart slept through a 6h await).${damping}` +
    ` If you want "wake me when it recovers", use service:await-up { name: "${name}" } instead — it ` +
    `short-circuits when the service is already healthy and closes the recovery-during-registration race. ` +
    `If you want "wake me when it RESTARTS", health polarity is the wrong signal: verify the unit's identity ` +
    `(MainPID / ExecMainStartTimestamp) instead. Registered anyway — this is a warning, not a refusal, so ` +
    `pair it with on_timeout:'wake' if you keep it.`
  );
}
