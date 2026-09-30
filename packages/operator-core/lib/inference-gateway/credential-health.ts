/**
 * credential-health.ts — the PURE decision logic behind the gateway's
 * dead-credential alert (#5 PART A).
 *
 * Today a dead/expired inference credential fails SILENTLY: the gateway's 401
 * handler drops + refreshes the cached token (`active.invalidateToken?.()`), but
 * when the refresh yields the SAME genuinely-dead credential it just keeps
 * 401'ing with NO fleet alert — so a live 401 silently breaks spawns/evals
 * ("produced no turn") with nobody paged.
 *
 * The fix is a per-credential consecutive-401 counter in the gateway hot path:
 * increment on each 401 (the refresh ran but the credential is STILL bad), reset
 * on the next successful auth (a 2xx for that credential). When the streak
 * crosses a threshold the credential is DEAD (not merely stale-cached), and the
 * gateway fires a loud `credential-health` alert ONCE per dead-credential
 * episode.
 *
 * This module holds ONLY the threshold decision — a pure function, so it is
 * unit-testable in isolation and the gateway's hot-path change stays a counter
 * increment + a fire-and-forget call (never blocks or throws in the request
 * path).
 */

/** Default consecutive-401 streak that marks a credential DEAD (vs stale-cached). A genuinely-stale
 *  cached token recovers on the FIRST refresh (so its streak never climbs past 1); a streak this high
 *  means the refresh produced the same invalid credential N times in a row — i.e. it is dead/expired,
 *  not stale. Env-tunable; small so a live 401 is surfaced fast, not after a long silent outage. */
export const DEFAULT_CREDENTIAL_401_DEAD_THRESHOLD =
  Number(process.env.PAPERCUSP_GATEWAY_CREDENTIAL_401_THRESHOLD) || 3;

/**
 * Should the gateway fire its (once-per-episode) dead-credential alert for a credential whose
 * consecutive-401 streak just reached `streak`, given the dead threshold `threshold`?
 *
 * Returns `true` EXACTLY at the crossing tick (`streak === threshold`) and `false` otherwise — so a
 * caller that invokes this on every 401 (after incrementing the streak) alerts ONCE per episode:
 *  - `streak < threshold`  → still within the stale-cached tolerance (the refresh may yet recover it).
 *  - `streak === threshold` → the crossing: the credential is dead → ALERT (this single tick).
 *  - `streak > threshold`  → already alerted this episode → stay quiet (no re-alert per request).
 *
 * The "reset on the next successful auth" half lives in the gateway (clearing the streak to 0), which
 * re-arms this crossing for the NEXT episode. A non-positive threshold disables alerting entirely.
 */
export function classifyCredential401Streak(streak: number, threshold: number): boolean {
  if (!Number.isFinite(streak) || !Number.isFinite(threshold)) return false;
  if (threshold <= 0) return false;
  return streak === threshold;
}
