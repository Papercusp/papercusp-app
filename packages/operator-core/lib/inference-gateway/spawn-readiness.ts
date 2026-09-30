/**
 * spawn-readiness.ts — the DETERMINISTIC gateway-readiness predicate for the
 * spawn-admission gate (WI-390 layer 1 / fleet-concurrency-first-prompt-policy P-004).
 *
 * Owner insight (ownerhandle, live): "don't place bees when the gateway can't serve" is
 * PURE DETERMINISTIC LOGIC and belongs in CODE — not a 5-min LLM health loop. This
 * file IS that logic: given the gateway's already-tracked signals (serviceable
 * account count + the admission queue depth vs its shed cap), decide whether a NEW
 * bee spawn should be ADMITTED now or DEFERRED (re-enqueued with backoff) so it
 * never boots into an unservable gateway and wedges as a 0-invocation corpse (the
 * observed failure: alive in ep_poll, 0 invocations).
 *
 * PURE — no I/O. The caller fetches the signals (a cheap `gateway:ready` endpoint /
 * gateway:status) and feeds them here; this only DECIDES, so the rule is unit-tested
 * deterministically and the cross-process fetch + the defer/re-enqueue wiring (the
 * hot-path slice that needs an attended live-verify before it ENFORCES) compose it.
 * The rule mirrors the gateway's OWN serviceable-admission clamp model
 * (inference-gateway/gateway.ts: live admission is clamped to serviceableAccounts ×
 * PER_ACCOUNT_ADMISSION, and the bounded PriorityAdmissionQueue load-sheds at
 * DEFAULT_MAX_QUEUED) — so the spawn gate and the request gate agree on "servable".
 *
 * STATUS: the deterministic core (this file) is landed + tested. The SHADOW wiring
 * into the spawn path (`fetchGatewayReadinessSignals` + `logSpawnReadinessShadow`,
 * called from `spawnAgentInHarness` in operator-spawn.ts) is landed and logs "would
 * defer" — it does NOT block or re-enqueue any spawn. The ENFORCING half (actually
 * DEFER + re-enqueue with backoff on a not-ready decision) is still the follow-up
 * slice, and must stay unshipped until an attended live-verify of the shadow log
 * confirms the decision only fires on genuine pool exhaustion (an enforcement bug
 * defers EVERY spawn → wedges the fleet, the exact failure this gate exists to
 * prevent). See WI-390.
 */

/** The gateway-readiness signals the spawn gate decides on — exactly the values the
 *  gateway already tracks (account-failover.liveCount + the admission queue). */
export interface GatewayReadinessSignals {
  /** Accounts that can serve a request RIGHT NOW for the spawn's model class — not
   *  circuit-paused (exhaustedUntil), not usage-capped, not egress-paused. The
   *  gateway's account-failover.available()/liveCount denominator. */
  serviceableAccounts: number;
  /** Requests currently WAITING for an admission slot — the depth of the gateway's
   *  bounded PriorityAdmissionQueue. */
  admissionQueued: number;
  /** The shed cap: at/above it the gateway is load-shedding (429 + retry-after), so
   *  admitting a spawn into that backlog only deepens it. (gateway DEFAULT_MAX_QUEUED,
   *  default 256.) A value ≤ 0 disables the shedding check (unknown cap ⇒ don't gate). */
  admissionMaxQueued: number;
}

/** Why a spawn was deferred (for the re-enqueue log / metric). */
export type SpawnDeferReason = 'no_serviceable_account' | 'admission_shedding';

export type SpawnAdmissionDecision =
  | { admit: true }
  | { admit: false; defer: true; reason: SpawnDeferReason; retryAfterMs: number };

/** Default backoff before a deferred spawn is reconsidered — short, since the pool
 *  recovers as paused accounts come back / the backlog drains. Env-tunable by the
 *  wiring slice; the pure core just carries the default. */
export const DEFAULT_SPAWN_DEFER_BACKOFF_MS = 5_000;

/**
 * PURE: should a new bee spawn be admitted NOW? DEFER when the gateway can't serve
 * it — (a) ZERO serviceable accounts (every account paused/usage-capped → a booted
 * bee gets no first token and wedges), or (b) the admission queue is already AT/OVER
 * its shed cap (the gateway is shedding load → a new bee only deepens the backlog).
 * Otherwise ADMIT. Deferral is deterministic backpressure: the spawn re-enqueues
 * after `retryAfterMs` rather than booting a corpse. No I/O — `signals` injected.
 */
export function decideSpawnAdmission(
  signals: GatewayReadinessSignals,
  opts: { backoffMs?: number } = {},
): SpawnAdmissionDecision {
  const retryAfterMs = opts.backoffMs ?? DEFAULT_SPAWN_DEFER_BACKOFF_MS;
  // (a) no account can serve → defer (the dominant wedge cause: bee boots, gets no
  // first inference within the deadline, dies a 0-invocation corpse).
  if (!Number.isFinite(signals.serviceableAccounts) || signals.serviceableAccounts < 1) {
    return { admit: false, defer: true, reason: 'no_serviceable_account', retryAfterMs };
  }
  // (b) the gateway is already load-shedding → don't pile a new bee onto the backlog.
  if (
    Number.isFinite(signals.admissionMaxQueued) &&
    signals.admissionMaxQueued > 0 &&
    signals.admissionQueued >= signals.admissionMaxQueued
  ) {
    return { admit: false, defer: true, reason: 'admission_shedding', retryAfterMs };
  }
  return { admit: true };
}

/** Convenience boolean (the `gateway:ready` shape): is the gateway servable for a new
 *  spawn right now? */
export function isGatewayReadyForSpawn(signals: GatewayReadinessSignals): boolean {
  return decideSpawnAdmission(signals).admit;
}

/**
 * WIRING SLICE (WI-390 layer 1, live-verify pending): fetch the gateway's own `GET /stats` and
 * translate it into `GatewayReadinessSignals` — the ONE place that turns the gateway's live
 * process state into the pure predicate's input, so `decideSpawnAdmission` never has to know the
 * gateway is an HTTP process. `healthyAccounts` is the pool.healthyCount() denominator the
 * serviceable-admission clamp already computes (gateway.ts stats()); `admission.queued` /
 * `maxQueued` are the same bounded-queue load-shed signals `DEFAULT_MAX_QUEUED` gates on.
 *
 * FAIL-OPEN by design: an unreachable/malformed gateway response returns `null` (not a synthetic
 * "not ready") — a transient probe hiccup must never itself defer every spawn (that would be the
 * exact wedge this gate exists to prevent, self-inflicted by the gate). The caller treats `null`
 * as "no opinion" and admits.
 */
export async function fetchGatewayReadinessSignals(opts: {
  timeoutMs?: number;
  gatewayBase?: string;
} = {}): Promise<GatewayReadinessSignals | null> {
  const base = opts.gatewayBase ?? `http://127.0.0.1:${Number(process.env.PAPERCUSP_GATEWAY_PORT) || 8788}`;
  try {
    const r = await fetch(`${base}/stats`, { signal: AbortSignal.timeout(opts.timeoutMs ?? 3000) });
    if (!r.ok) return null;
    const s = (await r.json().catch(() => null)) as {
      healthyAccounts?: unknown;
      admission?: { queued?: unknown };
      maxQueued?: unknown;
    } | null;
    if (!s || typeof s.healthyAccounts !== 'number') return null;
    return {
      serviceableAccounts: s.healthyAccounts,
      admissionQueued: typeof s.admission?.queued === 'number' ? s.admission.queued : 0,
      admissionMaxQueued: typeof s.maxQueued === 'number' ? s.maxQueued : 0,
    };
  } catch {
    return null; // gateway unreachable / probe timeout — fail-open, see doc comment above
  }
}

/**
 * SHADOW-mode readiness check for the spawn path (WI-390 layer 1 wiring, non-enforcing). Fetches
 * live signals, runs the pure decision, and — on a "would defer" verdict — LOGS it via `logFn`
 * (default `console.warn`) tagged `[spawn-readiness][SHADOW]` for the attended live-verify this
 * gate needs before it ever blocks a real spawn (see the file-header STATUS note). Never throws,
 * never returns a decision the caller is expected to act on — it is pure telemetry until a
 * follow-up flips a caller-side enforce switch. Disable entirely via
 * `PAPERCUSP_SPAWN_READINESS_SHADOW=0` (e.g. a noisy dev box) — logging is ON by default because it
 * is inert (no spawn is ever blocked by this function).
 */
export async function logSpawnReadinessShadow(
  context: { role: string; spawnId?: string },
  logFn: (msg: string) => void = (msg) => console.warn(msg),
): Promise<void> {
  if (process.env.PAPERCUSP_SPAWN_READINESS_SHADOW === '0') return;
  try {
    const signals = await fetchGatewayReadinessSignals();
    if (!signals) return; // no opinion — gateway unreachable or a non-gateway backend
    const decision = decideSpawnAdmission(signals);
    if (!decision.admit) {
      logFn(
        `[spawn-readiness][SHADOW] would DEFER spawn role=${context.role}${context.spawnId ? ` spawnId=${context.spawnId}` : ''} ` +
          `reason=${decision.reason} retryAfterMs=${decision.retryAfterMs} signals=${JSON.stringify(signals)} ` +
          `— NOT enforced (WI-390 shadow mode; see spawn-readiness.ts STATUS)`,
      );
    }
  } catch {
    /* best-effort telemetry only — never let the readiness probe affect a spawn */
  }
}
