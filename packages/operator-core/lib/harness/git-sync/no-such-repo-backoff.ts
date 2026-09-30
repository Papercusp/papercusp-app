/**
 * no-such-repo-backoff.ts — EI-15333: don't re-dial a peer that definitively
 * said it does not have the store.
 *
 * `no-such-repo` is serve-wiring's `pathExists(join(repoPath, 'HEAD'))` verdict:
 * the peer genuinely does not have this repo's store on disk. That is not a
 * transient dial/connectivity failure, so re-dialing on the git-sync tick
 * cadence cannot change it — the answer only changes when something about the
 * PEER'S store changes, which does not happen on a ~5-minute clock.
 *
 * Both dialing legs share this state, and that is the point. It is the same
 * store on the same peer, so a refusal learned on either leg is evidence for
 * both:
 *
 *   - `runBootstrapLeg` — where EI-15333 originally landed. It returns early on
 *     an already-seeded store, so it storms only while a store is missing.
 *   - `runRefAnnounceLeg` — the leg that actually storms. It re-drives EVERY
 *     pending announcement on EVERY tick, and the fed-event cursor is HELD below
 *     the oldest failed row (EI-15335), so a permanently-refused announcement
 *     pins the cursor and the held backlog is re-dialed forever, growing as new
 *     announcements accumulate behind it. Live-caught 2026-08-02 on the tower:
 *     `hello-world-3-pot` held its cursor at 7431042 and re-dialed nine
 *     announcements from `Lm1ABoMRKVoo` every tick, each refused `no-such-repo`,
 *     for 8470 minutes (~5.9 days) without local progress. Wiring the backoff
 *     into the bootstrap leg alone was itself the bug — structurally the same
 *     miss as WI-6364 (fix C): a repair the stuck machine cannot reach is not a
 *     repair.
 *
 * BACKOFF, NOT CURSOR-ADVANCE. Advancing the fed-event cursor past a refused
 * announcement would silently drop a namespace that was never mirrored, which is
 * exactly what EI-15335's cursor hold exists to prevent. The hold is correct;
 * re-dialing INSIDE the hold is what was wrong. One dial per window still
 * self-heals the moment the peer gains the store.
 *
 * In-memory, per-process: resets harmlessly on restart (one extra dial next tick
 * costs nothing).
 */

/** 30 min ≈ 6 ticks at the ~5-min git-sync cadence: long enough to stop the
 *  spam and the wasted handshakes, short enough that a peer which later gains
 *  the store is picked up without operator action. */
export const NO_SUCH_REPO_BACKOFF_MS = 30 * 60 * 1000;

/**
 * Keyed by `repoKey`, the FEDERATED cross-device repo identity (WI-5168,
 * repo-identity.ts's `canonicalRepoKey`) — NOT the local install slug, which can
 * differ per device for the same repo. Pairing it with the peer's device pubkey
 * is what makes "this peer does not have THIS store" the unit being suppressed,
 * rather than the peer or the repo alone.
 */
export function noSuchRepoBackoffKey(repoKey: string, peerDevicePubkeyBase64: string): string {
  return `${repoKey}:${peerDevicePubkeyBase64}`;
}

/**
 * WI-10003594: how far a peer's announcement clock may trail ours and still
 * count as "announced after we armed". The announcement `ts` is the PEER's wall
 * clock, so an NTP-synced pair can still disagree by a few seconds; a peer that
 * recreated its store moments after our refusal must not be missed because its
 * clock runs slightly behind. The cost of the allowance is bounded: an
 * announcement can lift a window at most ONCE (`liftedThroughTs` below), so a
 * stale announcement inside the allowance costs a single extra dial, never a
 * storm.
 */
export const NO_SUCH_REPO_LIFT_CLOCK_SKEW_MS = 60 * 1000;

interface NoSuchRepoBackoffState {
  /** Local time the refusal armed (or last re-armed) the window. */
  armedAtMs: number;
  /** Local time the window expires. */
  untilMs: number;
  /**
   * Newest announcement `ts` that has already lifted a window for this pair.
   * Survives re-arming on purpose: it is what stops one announcement from
   * lifting, re-dialing, being refused and lifting again on every tick.
   */
  liftedThroughTs: number;
}

const backoffState = new Map<string, NoSuchRepoBackoffState>();

/** Is this exact (repoKey, peer) pair inside its backoff window right now? */
export function isNoSuchRepoBackoffActive(key: string, nowMs: number = Date.now()): boolean {
  const state = backoffState.get(key);
  return state !== undefined && state.untilMs > nowMs;
}

/** Seconds left in the window — for the operator line that explains the skip. */
export function noSuchRepoBackoffSecondsLeft(key: string, nowMs: number = Date.now()): number {
  const state = backoffState.get(key);
  return state === undefined ? 0 : Math.max(0, Math.ceil((state.untilMs - nowMs) / 1000));
}

/** Arm (or re-arm) the window for a pair that just refused. */
export function armNoSuchRepoBackoff(key: string, nowMs: number = Date.now()): void {
  const prior = backoffState.get(key);
  backoffState.set(key, {
    armedAtMs: nowMs,
    untilMs: nowMs + NO_SUCH_REPO_BACKOFF_MS,
    liftedThroughTs: prior?.liftedThroughTs ?? Number.NEGATIVE_INFINITY,
  });
}

/** What a lift decision saw — returned so the operator line can explain it. */
export interface NoSuchRepoBackoffLift {
  armedAtMs: number;
  announcedTsMs: number;
}

/**
 * WI-10003594: lift an active window because the peer has SINCE announced this
 * exact store.
 *
 * The 30-minute window was sized for a peer that will not gain the store on its
 * own. It is wrong for a peer that just did: the P-505 Phase A drill quarantines
 * the VM's store, the tower learns `no-such-repo` within about a second, and the
 * VM re-bootstraps within about three minutes. With the window in force the tower
 * did not dial again for 30 minutes, longer than the drill's 20-minute verdict
 * deadline, so Phase A could never converge.
 *
 * A signed announcement carrying our `repoKey` is direct evidence the peer now
 * holds the store: a device only announces after building sigrefs IN that store.
 * Callers must pass only announcements whose `repo_key` equals the backoff's
 * repoKey; legacy announcements without a `repo_key` never lift, which is exactly
 * the population EI-15333's storm came from.
 *
 * Lifts only when the announcement is newer than the arm (less the clock-skew
 * allowance) AND newer than any announcement that already lifted this pair.
 * The second test keeps the EI-15333 guarantee: a peer that keeps refusing is
 * re-dialed at most once per NEW announcement, never once per tick.
 *
 * Returns the lift details when it cleared an active window, otherwise null.
 */
export function liftNoSuchRepoBackoffOnFreshAnnouncement(
  key: string,
  announcedTsMs: number,
  nowMs: number = Date.now(),
): NoSuchRepoBackoffLift | null {
  if (!Number.isFinite(announcedTsMs)) return null;
  const state = backoffState.get(key);
  if (!state || state.untilMs <= nowMs) return null;
  if (announcedTsMs <= state.liftedThroughTs) return null;
  if (announcedTsMs <= state.armedAtMs - NO_SUCH_REPO_LIFT_CLOCK_SKEW_MS) return null;
  backoffState.set(key, { ...state, untilMs: nowMs, liftedThroughTs: announcedTsMs });
  return { armedAtMs: state.armedAtMs, announcedTsMs };
}

/**
 * Newest announcement `ts` per announcing device, counting only announcements
 * that name `repoKey`. Pure; the ref-announce leg feeds it the receive batch
 * before it dials. Legacy announcements (no `repo_key`) are skipped on purpose,
 * see `liftNoSuchRepoBackoffOnFreshAnnouncement`.
 */
export function newestAnnouncementTsByDevice(
  announcements: readonly { device_pubkey: string; ts: number; repo_key?: string }[],
  repoKey: string,
): Map<string, number> {
  const newest = new Map<string, number>();
  for (const a of announcements) {
    if (a.repo_key !== repoKey) continue;
    if (!Number.isFinite(a.ts)) continue;
    const prior = newest.get(a.device_pubkey);
    if (prior === undefined || a.ts > prior) newest.set(a.device_pubkey, a.ts);
  }
  return newest;
}

/** A fetch failure as the arming decision needs to see it. */
export interface NoSuchRepoFailure {
  device: string;
  stderr: string;
}

/**
 * Which devices from this tick's failures should have their backoff armed.
 *
 * `dialed` is LOAD-BEARING, not defensive. A backoff SKIP is itself surfaced as
 * a fetch failure whose stderr NAMES `no-such-repo` — it has to, because that is
 * the diagnosis the operator needs to read. So arming off the stderr alone would
 * push the deadline to `now + WINDOW` on every single tick and the window would
 * never expire: a bounded backoff silently becomes PERMANENT suppression, and
 * the pair would never be retried even after the peer gains the store. Requiring
 * a real dial is the only thing that separates "the peer just told us" from "we
 * are quoting ourselves".
 *
 * Returned rather than applied so the decision is assertable without reaching
 * into module state.
 */
export function devicesToArmForNoSuchRepo(
  failures: readonly NoSuchRepoFailure[],
  dialed: ReadonlySet<string>,
): string[] {
  const armed: string[] = [];
  for (const f of failures) {
    if (!dialed.has(f.device)) continue;
    if (!f.stderr.includes('no-such-repo')) continue;
    if (!armed.includes(f.device)) armed.push(f.device);
  }
  return armed;
}

/** Test-only: clear all backoff state so cases don't leak into each other. */
export function __resetNoSuchRepoBackoffForTest(): void {
  backoffState.clear();
}
