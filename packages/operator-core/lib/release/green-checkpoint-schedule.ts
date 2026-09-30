/**
 * The green-checkpoint gate's SCHEDULE — the cron it is seeded with, the fire period
 * that cron implies, and the margin its run budget must leave against that period.
 *
 * WHY THIS IS ITS OWN FILE (WI-39841 follow-on). The cron used to be a bare string
 * literal repeated at every site that seeds the routine, plus a fourth copy exported
 * from `harness/routines/release-actions.ts` for the phase invariant to check. That is
 * the exact mirror-drift shape WI-39841 was filed about, one level up: the invariant
 * test reads the EXPORTED constant, so editing a seed site alone leaves the guard green
 * while the real schedule diverges — and the phase collision the guard exists to catch
 * comes straight back.
 *
 * It cannot live in `release-actions.ts` because that module calls
 * `registerSystemAction()` at import time (green-checkpoint, release-trigger). The seed
 * scripts run standalone under `tsx`; importing 2.5k lines of run orchestration and
 * registering two system actions as a side effect, to read one string, is not a trade
 * worth making. So the schedule facts live HERE, in a leaf with no imports at all, and
 * everything that needs them — seeders, retrofit, the invariant test — depends on this
 * file and nothing else.
 *
 * The run BUDGET lives here too, for the same reason and one better. It used to sit in
 * `release-actions.ts` and be HAND-MIRRORED into three other files — `MANUAL_CHECKPOINT_
 * WATCHDOG_MS`, `MIN_MANUAL_SELF_WATCHDOG_MS`, `SUITE_KILL_BUDGET_MIRROR_MS` — each
 * carrying a comment saying it was copied because importing the canonical module would
 * register two system actions as a side effect. That reason was real and is now gone: a
 * leaf with no imports can be depended on from anywhere, including a gate script running
 * standalone under `tsx` in an isolated checkout. So those three are DERIVED now, not
 * copied, and `release-timing-invariants.test.ts` no longer has to detect a drift that
 * can no longer happen. What it still checks is the part that is a real decision: the
 * ORDERING of the four different numbers in the chain, and the phase relation below.
 */

/**
 * The operator-home cron derived from its install slug. Every seed site calls
 * `greenCheckpointCronForInstall()` with the row's own install slug instead of
 * copying this value, so independent pots spread their hourly fires across the
 * hour instead of stampeding the host-wide materialization barrier.
 * `seed-hive-release-routines.ts`, `apps/operator/lib/release/seed-release-routines.ts`,
 * and `apps/operator/lib/release/retrofit-hive-to-gate.ts`. Hourly at :15, offset from
 * git-sync's every-10-minute ticks.
 *
 * ⚠ Not every routine firing at `0 15 * * * *` is THIS routine. `autoloop-release-readiness-monitor`
 * (seed-autoloop-release-readiness-routine.ts) independently chose the same slot to sit
 * clear of telemetry-retention/hive-canary/cargo-test, and is deliberately NOT wired to
 * this constant — coupling it would mean retuning the gate silently moved an unrelated
 * monitor. Match on the routine NAME before assuming a literal is a copy of this one.
 */
export function greenCheckpointCronForInstall(installSlug: string): string {
  // A position-weighted UTF-8 byte sum is deliberately mirrored in migration
  // 976 so existing rows and future re-seeds converge on the same schedule.
  const bytes = new TextEncoder().encode(installSlug);
  const secondOfHour = bytes.reduce(
    (sum, byte, index) => (sum + byte * (index + 1)) % 3_600,
    0,
  );
  return `${secondOfHour % 60} ${Math.floor(secondOfHour / 60)} * * * *`;
}

export const GREEN_CHECKPOINT_CRON = greenCheckpointCronForInstall('papercusp');

/** The fire period `GREEN_CHECKPOINT_CRON` implies — one hour. */
export const GREEN_CHECKPOINT_FIRE_PERIOD_MS = 60 * 60_000;

/**
 * Minimum gap the suite timeout must leave between a deadline-kill and the next
 * scheduled fire, so the lock is demonstrably free when that fire lands.
 *
 * The slack it is compared against is `(period - (timeout % period)) % period`, and the
 * OUTER modulo is load-bearing: at a timeout that is an exact multiple of the period,
 * `timeout % period === 0` and `period - 0` reads as a FULL period of slack when the
 * truth is zero — the boundary lands epsilon inside the run, which is precisely the
 * refused fire WI-39841 measured. See `release-timing-invariants.test.ts`, which keeps
 * the old 120m value as a permanent control so a "simplification" of that expression
 * fails there instead of in production.
 */
export const GREEN_CHECKPOINT_PHASE_MARGIN_MS = 5 * 60_000;

/**
 * The wall-clock budget for ONE green-checkpoint suite run before runScript SIGTERMs the
 * whole process group (P-007). This MUST track the gate's fork concurrency:
 * GREEN_CHECKPOINT_MAX_FORKS (green-checkpoint.ts) was lowered 8→4→2 for OOM safety on
 * this memory-pressured shared box, which ~doubled the suite's wall-clock — but this
 * budget stayed at the original 25m, so every 2-fork run OVERRAN it and was SIGTERM-killed
 * (exit 143) BEFORE producing any verdict, wedging the green gate (and thus every fleet
 * deploy) for ~18h (green-checkpoint-timeout-vs-forks-2026-06-27). 55m gave a 2-fork run
 * headroom under MODERATE load — but under sustained full-fleet load (46+ sessions) the
 * multi-pass suite measured 60–90m wall-clock, so 55m resumed killing HEALTHY runs
 * pre-verdict: 4 consecutive gate losses on 2026-07-05 froze `main` ~17h (EI-7553 posts
 * 50747/50749 — run verifiably alive at 59m, SIGTERM'd, verdict row null forever). The
 * current value covers that measured worst case with ~25m headroom.
 *
 * INVARIANT: keep this the SMALLEST link in the gate's timing chain —
 *   THIS (115m)  <  SELF_WATCHDOG_MS (180m, green-checkpoint.ts)
 *     <  DEFAULT_STALE_ROUTINE_FIRE_NO_OUTPUT_MS (185m, dbos/dbos-executor-reaper.ts)
 *     <  CHECKPOINT_LOCK_STALE_MS (190m, green-checkpoint.ts)
 * — a run must be killed by THIS timeout (and release its lock) before that lock is
 * stale-reclaimable, else the next hourly fire spawns a SECOND concurrent suite and OOMs
 * the box; and the DBOS reaper's no-output window must sit above the whole run so it
 * cannot cancel a HEALTHY checkpoint's bookkeeping row mid-suite. That last link was
 * MISSING from the list when this budget was raised 55m→120m, so the reaper (still 60m)
 * silently became the tightest bound and reaped healthy runs — WI-6112. Those four are
 * genuinely FOUR numbers in three files, so their ordering is asserted in
 * apps/operator/lib/release/release-timing-invariants.test.ts. The three constants that
 * are merely THIS number restated now import it from here instead.
 *
 * Deeper root (see green-checkpoint.ts GREEN_CHECKPOINT_MAX_FORKS notes): the box's
 * memory BASELINE / the :3070 operator-cluster size. Freeing memory there would let the
 * gate run more forks → finish faster → afford a SHORTER budget. Raising this budget
 * UNWEDGES the gate; it does not remove that deeper cost.
 *
 * SECOND INVARIANT — it must NOT be an integer multiple of the gate's fire period
 * (WI-39841). A scheduled run starts a second or two after its cron fire, so its deadline
 * lands a second or two after a LATER fire, and it is still holding the exclusive run-lock
 * at that moment: the fire that should have replaced it is refused, and the gate sits idle
 * until the following hour. At the old 120m against a 60m period this was not a race that
 * sometimes bit — it was deterministic for every run that went the distance. Measured
 * 2026-08-18: run started 17:15:04.877Z, cron fired 19:15:01.941Z, run SIGTERMed 19:15:04
 * (journal `exited 143`), no run until 20:15. One over-long run therefore cost ~2h of
 * wall-clock, not 2h of work.
 *
 * Hence 115m, not 120m — the LARGEST value that still clears the boundary: a run that
 * starts at HH:15 now dies at HH+1:55 and the HH+2:15 fire finds the lock free, ~5 min of
 * slack. The 5 minutes given up are cheap — a run that needs >115m is a run that was going
 * to be killed mid-suite anyway and record a verdict-less red (the 17:15 run produced
 * NOTHING at its 120m mark) — while the slot recovered is a whole extra hour of gate
 * availability. `phase margin` in release-timing-invariants.test.ts pins it against
 * GREEN_CHECKPOINT_FIRE_PERIOD_MS and GREEN_CHECKPOINT_PHASE_MARGIN_MS above.
 */
export const GREEN_CHECKPOINT_SUITE_TIMEOUT_MS = 115 * 60_000;

/**
 * The SIGKILL grace the scheduled parent allows after the SIGTERM at
 * `GREEN_CHECKPOINT_SUITE_TIMEOUT_MS`. Together they are the full kill window, which the
 * manual launch path transports into the child's own watchdog so a manual run terminates
 * on the same schedule as a scheduled one.
 */
export const GREEN_CHECKPOINT_SIGKILL_GRACE_MS = 15_000;
