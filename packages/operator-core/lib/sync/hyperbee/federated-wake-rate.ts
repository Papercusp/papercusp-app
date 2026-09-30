/**
 * federated-wake-rate — per-author budget for the federated wake fans
 * (cross-machine-coord-parity-and-trust-2026-07-01 P-003).
 *
 * A federated wake re-invokes a LOCAL agent — a billable turn — and the EI-279 /
 * P-002 fans fire it for any admitted hive member's remote-origin row. Without a
 * cap, one admitted-then-compromised (or merely runaway) peer device can spend
 * this machine's token budget at will by streaming wake:true messages. This
 * module is the receiving machine's defense: a sliding one-hour window of wake
 * tokens per AUTHOR DEVICE (the op's provenance authorPubkey — the verified
 * source-log identity; never the spoofable body.from).
 *
 * Semantics:
 *   - tryConsumeFederatedWake(author, n) — spend n tokens (one per agent the fan
 *     would re-invoke); false = over budget → the caller SUPPRESSES the wake but
 *     still applies/persists the message (the recipient sees it next natural
 *     turn — delivery is never dropped, only the re-invoke).
 *   - Process-local by design: each machine defends its OWN spend; no
 *     cross-machine state. State resets on restart (a restart already costs more
 *     than it grants).
 *   - Cap: PAPERCUSP_FED_WAKE_MAX_PER_HOUR (default 30/hour/device — generous
 *     for legitimate cross-machine steering, cheap insurance against a stream).
 *   - Warn once per author per window when the cap first trips (no log spam).
 *
 * The local (send-side) fan is NOT gated here — a local sender is this owner's
 * own agent under its own governance; this is specifically the federation
 * boundary. Fail-open on internal error: a budget bug must never break a wake,
 * and the projection already guards the whole fan best-effort.
 */

const WINDOW_MS = 60 * 60 * 1000;

/** Default hourly wake budget per author device (env-tunable at call time). */
export const DEFAULT_FED_WAKE_MAX_PER_HOUR = 30;

/**
 * WI-7043 — which KIND of spend this is. The two draw on the same per-device
 * window, but ambient traffic may not consume the directed reserve.
 *
 *  - `directed`  a wake aimed at a NAMED local agent (the EI-279 addressee fan,
 *                the P-002 reply-wake). Losing one silently fails to re-invoke a
 *                live peer, and — since M5a suppresses the delivery receipt when
 *                nothing was woken — the SENDER reads that as `recipient_absent`.
 *                May use the whole cap.
 *  - `ambient`   rendezvous/courtesy traffic (the P-009 fed_event re-fire, the
 *                P-014 quarantine receipt). High-volume and individually cheap to
 *                lose. Capped BELOW the directed ceiling so it can never starve
 *                a directed wake.
 *
 * Measured on the tower↔Mac rig 2026-08-02: 33 fed_event + 7 directed wakes in one
 * hour against a cap of 30 — the ambient traffic ate the budget and both LIVE-1
 * parity wakes were suppressed while the messages themselves applied fine.
 */
export type FederatedWakeClass = 'directed' | 'ambient';

interface AuthorWindow {
  /** Epoch-ms of each consumed token, pruned to the sliding window. */
  spent: number[];
  /** Window-start of the last cap warn, to warn once per window. */
  warnedAt: number;
}

const windows = new Map<string, AuthorWindow>();

function capPerHour(): number {
  const raw = Number(process.env.PAPERCUSP_FED_WAKE_MAX_PER_HOUR);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_FED_WAKE_MAX_PER_HOUR;
}

/**
 * Tokens held back for `directed` wakes only. Env-tunable
 * (PAPERCUSP_FED_WAKE_DIRECTED_RESERVE, 0 disables the reserve); default a third
 * of the cap, so the shipped 30/hour keeps 10 reserved.
 */
function directedReserve(cap: number): number {
  const raw = Number(process.env.PAPERCUSP_FED_WAKE_DIRECTED_RESERVE);
  const reserve =
    Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : Math.max(1, Math.floor(cap / 3));
  return Math.min(reserve, cap);
}

/** The ceiling this class of spend may reach within the per-device window. */
function ceilingFor(cls: FederatedWakeClass, cap: number): number {
  return cls === 'directed' ? cap : Math.max(0, cap - directedReserve(cap));
}

function windowFor(author: string, now: number): AuthorWindow {
  const key = author || 'unknown';
  let w = windows.get(key);
  if (!w) {
    w = { spent: [], warnedAt: 0 };
    windows.set(key, w);
  }
  const floor = now - WINDOW_MS;
  w.spent = w.spent.filter((t) => t > floor);
  return w;
}

/**
 * Spend `n` wake tokens from `author`'s sliding-hour budget. Returns true when
 * the whole spend fits (tokens recorded); false when it would exceed the ceiling
 * for `cls` (nothing recorded — an over-budget fan is suppressed atomically, not
 * partially).
 *
 * Use this only when the cost is known BEFORE the work: a directed fan bills one
 * token per addressee it is about to re-invoke. When the cost is only knowable
 * afterwards (an emit that may reach no watcher at all), use
 * `federatedWakeAllowance` + `recordFederatedWakeSpend` instead — charging up
 * front for work that wakes nobody is exactly the WI-7043 starvation bug.
 */
export function tryConsumeFederatedWake(
  author: string,
  n: number,
  now: number = Date.now(),
  cls: FederatedWakeClass = 'directed',
): boolean {
  const cap = capPerHour();
  const key = author || 'unknown';
  const w = windowFor(key, now);
  const ceiling = ceilingFor(cls, cap);
  const want = Math.max(1, Math.floor(n));
  if (w.spent.length + want > ceiling) {
    if (now - w.warnedAt > WINDOW_MS) {
      w.warnedAt = now;

      console.warn(
        `[federated-wake-rate] author device ${key.slice(0, 12)}… exceeded its ${cls} ceiling ` +
          `(${ceiling} of ${cap} federated wakes/hour) — further ${cls} wakes suppressed this window ` +
          '(messages still delivered; recipients see them next turn).',
      );
    }
    return false;
  }
  for (let i = 0; i < want; i++) w.spent.push(now);
  return true;
}

/**
 * Tokens `author` may still spend at `cls` in this window — an ADMISSION check
 * that charges nothing.
 *
 * For work whose real cost is only known after the fact: gate on
 * `federatedWakeAllowance(...) > 0`, do the work, then bill what it actually cost
 * via `recordFederatedWakeSpend`. A federated event re-fire that matches no local
 * watcher wakes nobody, so it must cost nothing — the budget exists to bound
 * BILLABLE TURNS, not attempts. (This opens no new flood surface: the row had to
 * pass the P-015 per-member message-rate limiter to be applied at all, and an
 * emit that fires no await is a single bounded lookup.)
 */
export function federatedWakeAllowance(
  author: string,
  cls: FederatedWakeClass = 'directed',
  now: number = Date.now(),
): number {
  const w = windowFor(author || 'unknown', now);
  return Math.max(0, ceilingFor(cls, capPerHour()) - w.spent.length);
}

/**
 * Record `n` tokens actually spent — the post-hoc twin of
 * `tryConsumeFederatedWake`, for a caller that already did the work and now knows
 * its true cost. Never refuses (the wake already happened); `n <= 0` is a no-op,
 * which is the whole point for an emit that reached no watcher.
 */
export function recordFederatedWakeSpend(
  author: string,
  n: number,
  _cls: FederatedWakeClass = 'directed',
  now: number = Date.now(),
): void {
  const spend = Math.floor(n);
  if (!Number.isFinite(spend) || spend <= 0) return;
  const w = windowFor(author || 'unknown', now);
  for (let i = 0; i < spend; i++) w.spent.push(now);
}

/** Test seam: drop all per-author windows. */
export function resetFederatedWakeRate(): void {
  windows.clear();
}
