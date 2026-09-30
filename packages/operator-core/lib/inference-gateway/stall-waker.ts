/**
 * stall-waker — auto-wake CLI bees whose turn died on a rate limit, once the account recovers
 * (gateway-rate-limit-stall-autowake P-003/P-004).
 *
 * The gateway (P-002) records a STALL when it sheds an all-throttled 429 to an identified bee
 * (`x-papercusp-owner`), exposing `{ownerId, accountId, soonestResetAt}` on GET /admin/stalls. This loop
 * consumes those, and for each:
 *   1. CONFIRMS the bee actually stalled — it went idle, it did NOT recover on its own CLI retry
 *      (the false-positive guard — otherwise we'd wake bees that were fine).
 *   2. WAITS for the account's `soonestResetAt`, then confirms capacity is genuinely back.
 *   3. WAKES the bee (`coord:send {wake:true}` via `wakeRecipients`), which resumes its session.
 *
 * The gateway stays a thin proxy; ALL the confirm-wait-wake state lives here. Pure + deps-injected so the
 * decision logic is unit-tested without a clock, a gateway, or a DB. `now()` is injectable.
 */

export interface StallEvent {
  ownerId: string;
  accountId: string;
  soonestResetAt: number;
  at: number;
}

export interface StallWakerDeps {
  /** GET /admin/stalls?since=<ms> on the running gateway → the new stall candidates. */
  fetchStalls: (sinceMs: number) => Promise<{ now: number; stalls: StallEvent[] }>;
  /** Last OBSERVED activity for this owner, epoch ms (0 = unknown owner): the max across every liveness
   *  source available — bee stream output, coord presence, and the gateway's per-owner ledger `lastAt`
   *  (ANY request counts, including a retry that got shed another 429). Replaces the old boolean
   *  `ownerIsIdle`: the waker needs the TIMESTAMP so it can compare activity against the stall itself —
   *  "silent for 30s right now" is TRUE for any healthy agent mid-long-tool-call or mid-inference, and
   *  acting on that bare verdict is what mass-ESC'd 17 live agents/min on 2026-08-17 (owner-reported
   *  "agents keep getting interrupted"). Role-agnostic — the same for every caller. */
  ownerLastActivityAt: (ownerId: string) => Promise<number>;
  /** Has the account's budget actually returned (its pause expired + the gateway can serve again)? Guards
   *  against waking a bee straight back into a still-throttled pool. */
  capacityBack: (accountId: string, soonestResetAt: number) => Promise<boolean>;
  /** Fire the targeted coord wake. Returns `woken` (>0 = a watching bee was re-invoked; 0 = nobody home —
   *  the bee process is gone, not a resumable session). Honors the hive pause/manual gate internally. */
  wake: (ownerId: string, summary: string) => Promise<{ woken: number }>;
  /** FAST un-wedge (owner-requested 2026-06-23): ESC the owner's dead turn NOW (no wake), decoupled from the
   *  capacity gate. A turn that DIED on a gateway error is WEDGED — its CLI can't receive ANY message (not even
   *  a wake) until the dead turn is ESC'd. This re-arms it immediately so it's reachable again, WITHOUT shoving
   *  it back into a still-throttled pool (the capacity-gated `wake` below does the resume once budget returns).
   *  Optional — omit to keep only the legacy capacity-gated ESC+wake.
   *
   *  Resolves `{ ok }` — `true` only when the ESC genuinely landed, `false` on ANY refusal/failure — plus an
   *  `expected` flag: `true` when the ESC found NOTHING to interrupt (no live pty + no session pid — the owner
   *  is idle or already ended its turn, i.e. NOT actually wedged). tick() uses `expected` to stay quiet for
   *  that non-event (it recurs every cooldown for the same gone owners → host-log spam) while still warning
   *  on a genuine refusal (e.g. storm-guard rate-limit). Never throw to signal failure (root-cause fix,
   *  2026-07-01, gateway-mass-outage-storm-guard: the underlying `turn:interrupt` core never throws, it
   *  returns `{ok:false, error:...}` as a normal value, so a `Promise<void>` shape here silently swallowed
   *  every refused/failed ESC — `tick()` logged "un-wedged … reachable again" and armed the cooldown even
   *  though nothing was delivered, masking the exact failures a correlated gateway outage produces). */
  unwedge?: (ownerId: string) => Promise<{ ok: boolean; expected?: boolean }>;
  now: () => number;
  log: (level: 'info' | 'warn', msg: string) => void;
}

export interface StallWakerOptions {
  /** A bee that hasn't gone idle within this window after its stall RECOVERED on its own → drop it. Default 2 min. */
  confirmWindowMs?: number;
  /** Don't re-wake the same bee within this cooldown. Default 60 s. */
  wakeCooldownMs?: number;
  /** Don't re-fast-ESC (un-wedge) the same wedged owner within this cooldown — so a session that keeps
   *  erroring isn't ESC-stormed. Default 45 s. */
  unwedgeCooldownMs?: number;
  /** Give up on a bee after this many wake attempts (it isn't resuming). Default 3. */
  maxWakesPerBee?: number;
  /** Forget a pending stall entirely after this long (bound the map; the reset never came). Default 2 h. */
  pendingTtlMs?: number;
  /** Forget an owner's wake/unwedge cooldown + attempt-count breadcrumbs (lastWokeAt/
   *  lastUnwedgeAt/wakeCount) once it has had NO wake/unwedge activity for this long AND
   *  is no longer pending (WI-1582, sub-item 3: these three maps were never pruned —
   *  bee-1 stalls once, decades of ownerIds accumulate one entry each, forever). Long by
   *  design so it never resets an ACTIVE bee's maxWakesPerBee "give up" cap mid-session —
   *  it only reclaims memory from an owner that's been silent this long (its session is
   *  surely over). Default 24 h. */
  breadcrumbTtlMs?: number;
  /** Silence needed before an owner counts as IDLE (wake-able / possibly wedged). Was the loop-side
   *  IDLE_SILENCE_MS threshold buried inside the old ownerIsIdle dep; it lives here now so the state
   *  machine that acts on it is the thing that owns it. Default 30 s. */
  idleSilenceMs?: number;
  /** 2026-08-17 mass-interrupt root cause: a turn may be declared DEAD (fast-ESC-able) only once the
   *  owner's stall stream AND all observed activity have BOTH been quiet this long past the LATEST
   *  stall. The gateway records a stall per shed request, and every request (retries included) bumps
   *  the owner ledger — so an alive CLI in 429 retry-backoff keeps refreshing both signals and can
   *  never be declared dead mid-retry. The old code ESC'd after 30s of bare silence, which is exactly
   *  a backoff gap — it was killing healthy retrying turns. Default 2 min. */
  deadQuietMs?: number;
  /** Post-stall activity must be this much LATER than the stall to count as recovery — the stall
   *  write itself bumps the gateway ledger's lastAt, so an equal-ish timestamp is the shed, not
   *  evidence the owner survived it. Default 5 s. */
  recoveryGraceMs?: number;
}

interface Pending {
  accountId: string;
  soonestResetAt: number;
  recordedAt: number;
  /** When this owner's LATEST stall was shed — the reference point for both the recovered check
   *  (activity after it ⇒ the turn survived) and the dead-quiet gate (silence since it ⇒ dead). */
  lastStallAt: number;
  /** One fast-ESC per stall episode: latched once an ESC landed (or found no live session), reset
   *  only by a strictly NEWER stall (fresh evidence of a fresh death). Without this the waker
   *  re-ESC'd the same owner every unwedgeCooldownMs for up to pendingTtlMs while capacity stayed
   *  walled — the 2026-08-17 every-45s interrupt hammering. */
  unwedged: boolean;
}

const DEFAULTS: Required<StallWakerOptions> = {
  confirmWindowMs: 2 * 60_000,
  wakeCooldownMs: 60_000,
  unwedgeCooldownMs: 45_000,
  maxWakesPerBee: 3,
  pendingTtlMs: 2 * 60 * 60_000,
  breadcrumbTtlMs: 24 * 60 * 60_000,
  idleSilenceMs: 30_000,
  deadQuietMs: 2 * 60_000,
  recoveryGraceMs: 5_000,
};

export class StallWaker {
  private since = 0;
  /** ownerId → the pending stall we're waiting to act on (one per bee; soonestReset = the max seen). */
  private readonly pending = new Map<string, Pending>();
  private readonly lastWokeAt = new Map<string, number>();
  private readonly lastUnwedgeAt = new Map<string, number>();
  private readonly wakeCount = new Map<string, number>();
  private readonly opt: Required<StallWakerOptions>;

  constructor(private readonly deps: StallWakerDeps, opts: StallWakerOptions = {}) {
    this.opt = { ...DEFAULTS, ...opts };
  }

  /** Observability: how many bees are currently waiting for a wake. */
  get pendingCount(): number {
    return this.pending.size;
  }

  /** Observability (WI-1582): how many DISTINCT owners currently have a wake/unwedge
   *  breadcrumb (lastWokeAt/lastUnwedgeAt/wakeCount) tracked — the count sweepBreadcrumbs
   *  bounds. Union across the three maps, since an owner can appear in only one or two. */
  get breadcrumbCount(): number {
    return new Set<string>([...this.lastWokeAt.keys(), ...this.lastUnwedgeAt.keys(), ...this.wakeCount.keys()]).size;
  }

  /** One pass: pull new stalls, then re-evaluate every pending bee. Never throws (each step is guarded);
   *  returns what it pulled + which bees it woke this tick. */
  async tick(): Promise<{ pulled: number; woken: string[]; dropped: string[]; unwedged: string[] }> {
    const woken: string[] = [];
    const dropped: string[] = [];
    const unwedged: string[] = [];
    const now = this.deps.now();

    // 1. Pull new stall candidates and fold them into `pending` (one entry per bee).
    let pulled = 0;
    try {
      const res = await this.deps.fetchStalls(this.since);
      for (const s of res.stalls) {
        this.since = Math.max(this.since, s.at);
        pulled++;
        const ex = this.pending.get(s.ownerId);
        if (!ex) {
          this.pending.set(s.ownerId, {
            accountId: s.accountId,
            soonestResetAt: s.soonestResetAt,
            recordedAt: now,
            lastStallAt: s.at,
            unwedged: false,
          });
        } else {
          ex.soonestResetAt = Math.max(ex.soonestResetAt, s.soonestResetAt); // a later stall pushes the wait out
          if (s.at > ex.lastStallAt) {
            ex.lastStallAt = s.at;
            ex.unwedged = false; // a NEWER stall = fresh death evidence — re-arm the one-shot un-wedge
          }
        }
      }
    } catch (e) {
      this.deps.log('warn', `stall-waker: fetchStalls failed: ${(e as Error).message}`);
    }

    // 2. Re-evaluate each pending bee.
    for (const [ownerId, info] of [...this.pending]) {
      // Bound the map: a stall whose reset never arrives is forgotten.
      if (now - info.recordedAt > this.opt.pendingTtlMs) {
        this.pending.delete(ownerId);
        dropped.push(ownerId);
        continue;
      }

      // 2a. FALSE-POSITIVE GUARDS — establish what the owner has DONE, not just whether it is quiet.
      let lastAct = 0;
      try {
        lastAct = await this.deps.ownerLastActivityAt(ownerId);
      } catch (e) {
        this.deps.log('warn', `stall-waker: ownerLastActivityAt(${ownerId}) failed: ${(e as Error).message}`);
        continue; // unknown → re-check next tick, don't wake blindly
      }

      // 2a-i. RECOVERED — the owner demonstrably acted AFTER its latest stall (a successful gateway
      //       request, a coord call, bee stream output), so the shed 429 did NOT kill its turn. Drop it:
      //       a live turn must never be ESC'd or woken. (The grace excludes the stall's own ledger bump.)
      //       This is the check the old 30s-silence heuristic could not make — an agent 31s into a long
      //       tool call read as "idle" and got its healthy turn ESC'd (2026-08-17 mass-interrupt).
      if (lastAct > info.lastStallAt + this.opt.recoveryGraceMs) {
        this.pending.delete(ownerId);
        dropped.push(ownerId);
        this.deps.log('info', `stall-waker: ${ownerId} active after its last stall (recovered on its own) — dropped`);
        continue;
      }

      // 2a-ii. IDLE — quiet long enough to be wake-able. An unknown owner (lastAct 0: no bee row, no
      //        coord presence, no gateway ledger) is never idle → falls to the confirm-window drop.
      const idle = lastAct > 0 && now - lastAct > this.opt.idleSilenceMs;
      if (!idle) {
        if (now - info.recordedAt > this.opt.confirmWindowMs) {
          this.pending.delete(ownerId);
          dropped.push(ownerId);
          this.deps.log('info', `stall-waker: ${ownerId} never went idle (recovered on its own) — dropped`);
        }
        continue;
      }

      // 2a-FAST. UN-WEDGE (owner-requested 2026-06-23): ESC the dead turn so the wedged CLI re-arms its
      // inbox-wake watch, decoupled from the capacity gate. Guarded three ways (2026-08-17 mass-interrupt
      // root-cause fix — the ESC is a keystroke into a live session, so a false positive KILLS real work):
      //   (a) ONE ESC per stall episode (`info.unwedged`) — never the old every-cooldown hammering;
      //   (b) the death must be CORROBORATED: stall stream AND activity both quiet ≥ deadQuietMs past the
      //       latest stall — an alive CLI in 429 retry-backoff refreshes both, so it can't be ESC'd mid-retry;
      //   (c) the recovered check above already dropped anyone who acted after the stall.
      // Cooldown retained for retry-after-REFUSAL (storm guard etc.) only.
      if (
        this.deps.unwedge &&
        !info.unwedged &&
        now - info.lastStallAt >= this.opt.deadQuietMs &&
        now - (this.lastUnwedgeAt.get(ownerId) ?? 0) >= this.opt.unwedgeCooldownMs
      ) {
        // The OUTCOME decides what happens next (2026-07-01 root-cause fix, extended 2026-08-17):
        // ok → the ESC landed; the episode is un-wedged, LATCH it — repeating the keystroke would
        //   only kill whatever fresh turn the ESC (or a wake, or the owner) started.
        // expected (no live session) → nothing to ESC; equally latched — only a NEW stall re-arms.
        // refusal (storm guard etc.) → stays un-latched, retried after unwedgeCooldownMs.
        this.lastUnwedgeAt.set(ownerId, now);
        try {
          const res = await this.deps.unwedge(ownerId);
          if (res.ok) {
            info.unwedged = true;
            unwedged.push(ownerId);
            this.deps.log('info', `stall-waker: fast-ESC un-wedged ${ownerId} (turn died on a gateway error) — reachable again`);
          } else if (res.expected) {
            // EXPECTED non-event: the "stalled" owner has no live turn to ESC (idle, or already ended its turn)
            // — it is NOT wedged. Non-actionable and silent (this was the ~27×/15min `[stall-waker] … no live
            // interruptible session` host-log spam). Latched: re-attempting every cooldown is what turned a
            // stale pending entry into a standing threat to the owner's NEXT live turn.
            info.unwedged = true;
          } else {
            this.deps.log(
              'warn',
              `stall-waker: unwedge(${ownerId}) did NOT land (refused — e.g. storm-guard rate-limit) — owner stays wedged, retrying after the ${this.opt.unwedgeCooldownMs}ms cooldown`,
            );
          }
        } catch (e) {
          this.deps.log('warn', `stall-waker: unwedge(${ownerId}) threw: ${(e as Error).message}`);
        }
      }

      // 2b. Wait for the account's reset.
      if (now < info.soonestResetAt) continue;

      // 2c. Confirm capacity is genuinely back (don't wake into a still-throttled pool).
      let back = false;
      try {
        back = await this.deps.capacityBack(info.accountId, info.soonestResetAt);
      } catch (e) {
        this.deps.log('warn', `stall-waker: capacityBack(${info.accountId}) failed: ${(e as Error).message}`);
      }
      if (!back) continue;

      // 2d. Cooldown + attempt cap.
      if (now - (this.lastWokeAt.get(ownerId) ?? 0) < this.opt.wakeCooldownMs) continue;
      if ((this.wakeCount.get(ownerId) ?? 0) >= this.opt.maxWakesPerBee) {
        this.pending.delete(ownerId);
        dropped.push(ownerId);
        this.deps.log('info', `stall-waker: ${ownerId} hit the wake cap — giving up`);
        continue;
      }

      // 2e. Wake.
      try {
        // "capacity recovered", NOT "rate limit recovered" (WI-3310): capacityBack passing means the
        // account can serve again — which is only sometimes a rate-limit reset. Claiming a rate limit
        // recovered on an account that was (or still could be) usage-walled misled owners into thinking
        // the gateway conflates the two meters.
        const r = await this.deps.wake(ownerId, `capacity recovered on ${info.accountId} — resume your turn`);
        this.lastWokeAt.set(ownerId, now);
        this.wakeCount.set(ownerId, (this.wakeCount.get(ownerId) ?? 0) + 1);
        if (r.woken > 0) {
          woken.push(ownerId);
          this.pending.delete(ownerId);
          this.deps.log('info', `stall-waker: woke ${ownerId} (capacity back on ${info.accountId})`);
        } else {
          // Nobody watching the wake key — the bee process is gone (a one-shot turn that exited), not a
          // resumable session. Drop it; re-SPAWN-on-stall is future scope.
          this.pending.delete(ownerId);
          dropped.push(ownerId);
          this.deps.log('info', `stall-waker: ${ownerId} wake fired but nobody home (woken:0) — bee gone, dropped`);
        }
      } catch (e) {
        this.deps.log('warn', `stall-waker: wake(${ownerId}) failed: ${(e as Error).message}`);
      }
    }

    // WI-1582 (bg-host residual RSS growth, sub-item 3): bound the breadcrumb maps —
    // see sweepBreadcrumbs for why this is TTL-based rather than tied to a pending-drop.
    this.sweepBreadcrumbs(now);

    return { pulled, woken, dropped, unwedged };
  }

  /**
   * Forget lastWokeAt/lastUnwedgeAt/wakeCount for any owner that (a) is NOT currently
   * pending — sweeping a live owner would reset its maxWakesPerBee cap and wake/unwedge
   * cooldowns mid-episode, a real behavior change, not just a memory fix — and (b) has had
   * no wake/unwedge activity for `breadcrumbTtlMs`. Deliberately NOT tied to the moment an
   * owner drops out of `pending`: that would reset the "give up" cap on every repeated
   * stall episode within a session's lifetime, silently undoing maxWakesPerBee (see the
   * "wake cap" test). Only a long-silent owner (its session is surely over) is reclaimed.
   */
  private sweepBreadcrumbs(now: number): void {
    const ids = new Set<string>([
      ...this.lastWokeAt.keys(),
      ...this.lastUnwedgeAt.keys(),
      ...this.wakeCount.keys(),
    ]);
    for (const id of ids) {
      if (this.pending.has(id)) continue; // still active — never sweep a live owner
      const lastTouched = Math.max(this.lastWokeAt.get(id) ?? 0, this.lastUnwedgeAt.get(id) ?? 0);
      if (now - lastTouched > this.opt.breadcrumbTtlMs) {
        this.lastWokeAt.delete(id);
        this.lastUnwedgeAt.delete(id);
        this.wakeCount.delete(id);
      }
    }
  }
}
