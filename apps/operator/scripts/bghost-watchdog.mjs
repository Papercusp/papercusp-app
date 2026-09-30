#!/usr/bin/env node
/**
 * bg-host (DBOS routines / git-sync / substrate) ticker watchdog — 2026-06-20; freeze-signal rewritten
 * 2026-06-22 (EI-2421/EI-2434).
 *
 * `papercusp-bg-host`'s event loop can get STARVED under heavy box load, freezing the routines + git-sync
 * ticker: the process stays `active` (so systemd Restart=always NEVER fires) but routines stop firing and
 * git-sync stops committing — ALL fleet work stops persisting to origin/staging (the recurring 2026-06-20
 * overnight freeze). On a real freeze we restart the unit to revive it (working tree is kopia-backed,
 * separate from the user-facing :3070).
 *
 * FREEZE SIGNAL — journald-INDEPENDENT (this is the 2026-06-22 fix). The original detector polled
 * `journalctl -u papercusp-bg-host` and restarted on journal SILENCE. But journald's stdout-socket capture
 * wedged host-wide (EI-2434), so a perfectly HEALTHY, ticking bg-host showed an empty journal → the
 * watchdog false-concluded "frozen" → `systemctl restart` → EI-2186 boot-reconcile reclaimed every
 * in-flight bee spawn (the canary deaths, 2026-06-22). We now read the ticker's ACTUAL liveness directly
 * from Postgres — `MAX(last_fired_at)` across active routines (the SAME signal dev:service_health uses,
 * service-health.ts) — which the bg-host itself advances every tick and which no journald fault can fake.
 * If the newest routine fired > FREEZE_SILENCE_S ago while the unit is active, the ticker is genuinely
 * frozen → restart. If the freshness can't be read (psql/DB down), we treat it as UNKNOWN and skip — we
 * NEVER conclude "frozen" from a missing signal, so a measurement fault can't cause a false restart.
 *
 * SAFE FOR UNATTENDED OPERATION: a restart debounce + a circuit breaker (MAX_RESTARTS_PER_HR per rolling
 * hour, then it STOPS and only logs) so a misfire can't restart-loop the ticker. Decisions are mirrored to
 * a durable file (journald-independent) so a future incident is diagnosable even while journald is wedged.
 *
 * BOOT GRACE (EI-8901, 2026-07-10) — the staleness signal (`MAX(last_fired_at)` / `MAX(created_at)` for
 * routinesTick) is read from Postgres and so SPANS process restarts: a freshly-restarted unit that hasn't
 * ticked yet still reads as "frozen for Nmin" (the age of the LAST tick from the PREVIOUS generation), and
 * papercusp-bg-host takes ~4-5min to boot (ExecStartPre esbuild bundle), longer under load. With
 * DEBOUNCE_MS=5min this manifests as a RESTART STORM: every new generation is judged frozen before it can
 * possibly tick, gets restarted again, forever (until the hourly circuit breaker opens). The fix: after a
 * restart (by us OR anyone else — `systemctl restart papercusp-bg-host` by hand hits the same trap), grant a
 * BOOT GRACE measured from systemd's OWN `ActiveEnterTimestampMonotonic` (restart-attribution-safe,
 * independent of this watchdog's own in-memory state) — skip the freeze judgment entirely while the unit
 * has been active less than BOOT_GRACE_MS. A boot-time-unknown reading (systemctl/proc read failure) does
 * NOT grant grace (fails to the pre-existing behavior, never invents extra suppression from a missing
 * signal — same asymmetry principle as `isFrozen`).
 *
 * BACKOFF + ALERT (WI-3630, 2026-07-10 — completes the restart-storm fix above; EI-8901 landed (a)/(b)).
 * The boot-grace check stops the storm in the common case, but a boot that runs even LONGER than
 * BOOT_GRACE_MS (worse host pressure than observed) would still hit the OLD flat DEBOUNCE_MS and get
 * killed right as it might have finished booting. Each ACTUAL restart now counts as a "consecutive
 * strike": the debounce before the NEXT restart may fire DOUBLES per strike (BACKOFF_MULTIPLIER, capped
 * at MAX_DEBOUNCE_MS) — so an unusually slow boot gets progressively more room instead of being re-killed
 * on the same fixed clock, and the strike counter resets the moment a poll observes the ticker genuinely
 * healthy again. From ALERT_AFTER_RESTARTS consecutive strikes — well before the MAX_RESTARTS_PER_HR
 * circuit breaker — `alertFleet()` best-effort broadcasts to every running agent via
 * `harness_shared.coord_event_log` (the same table `coord:send`/severe-event-broadcast write: to:['*'],
 * surface 'messages', so it lands in coord:inbox for every agent's next turn, journald-independent and
 * independent of THIS watchdog's own log file — the EI-2434 precedent showed a durable log nobody tails
 * is invisible for 44h; a running fleet that could actually intervene should see it).
 *
 * COLLATERAL REPORTING (EI-19485006080051257, 2026-08-04). The alert above is threshold-gated on
 * ALERT_AFTER_RESTARTS consecutive strikes, and the strike counter resets on the first healthy poll — so
 * the ORDINARY case (one freeze, one restart, clean recovery) could never alert at all. That was silent
 * data loss, because a restart tears down the unit's whole cgroup (KillMode=control-group) and that
 * cgroup also holds the agent spawner and the owner's LIVE desktop-app sidecars (they are spawned
 * cgroup-inheriting rather than via managedSpawn/systemd-run --scope — root cause + fix owned separately
 * on EI-19479764372783341). The more cleanly the watchdog worked, the more certainly the damage went
 * unreported. Collateral is therefore reported on the FIRST restart, on its own signal: "is a storm
 * developing?" is a noise question and stays debounced; "did we just destroy something that was not
 * ours?" is an irreversible side effect and never shares that threshold. An unreadable cgroup is UNKNOWN
 * and stays silent (same never-infer-from-a-missing-signal asymmetry as `isFrozen`/`withinBootGrace`).
 *
 * SUSTAINED-HEALTH STRIKE CLEARING + REACHABLE CIRCUIT BREAKER (WI-37501, 2026-08-09). Two compounding
 * defects let a boot that never actually finishes booting restart-loop FOREVER, un-escalating and
 * un-breakered:
 *
 *   (1) The strike counter used to clear on a SINGLE healthy poll (`ticker recovered ... clearing
 *       consecutive-restart strike count`). A process that fires exactly ONE routine early in boot and
 *       then stalls again (observed live, 2026-08-09: strike cleared 60s after a restart, then judged
 *       frozen again 8.5min later) resets to strike #1 every time — the BACKOFF_MULTIPLIER escalation
 *       WI-3630 built specifically for "an unusually slow boot" never engages, because every restart
 *       looks like a first offence. Fix: require `SUSTAINED_HEALTHY_POLLS` CONSECUTIVE healthy polls
 *       (tracked in `healthyStreak`, reset by ANY stale-idleSec observation — frozen, boot-grace-excused,
 *       or saturation-excused alike) before clearing the strike — see `shouldClearStrikes`.
 *
 *   (2) With the strike escalation defeated, the restart period floors at BOOT_GRACE_MS + POLL_MS (the
 *       freeze judgment is suppressed for the whole boot-grace window and only re-evaluated on the next
 *       poll after it lapses) — 510s at the defaults, i.e. 3600/510 = 7.06 restarts/hr. The OLD
 *       MAX_RESTARTS_PER_HR default (8) sat just ABOVE that ceiling, so the circuit breaker built to stop
 *       exactly this storm shape could mathematically never trip against it. Fix: default lowered to 6
 *       (below the reachable ceiling with margin) and `maxReachableRestartsPerHr()` + a startup WARNING
 *       guard against silently reintroducing an unreachable cap if POLL_MS/BOOT_GRACE_MS ever change.
 *
 *   Fixing (1) alone already reduces real-world restart frequency a lot (escalating backoff, capped at
 *   MAX_DEBOUNCE_MS) — but (2) is an independent backstop: it must hold even if a future change
 *   reintroduces a fast-clearing strike counter, so both are fixed rather than relying on one to save the
 *   other.
 *
 * POOL-SHED CORROBORATION (WI-37506, 2026-08-09) — the SATURATION corroboration above
 * (`schedulerIdleSec`) assumes a stale `routinesTick` scheduler signal ALSO means a dead ticker. That
 * assumption breaks under genuine PG-pool starvation: `dbos.workflow_status` — the table BOTH
 * `routineIdleSec` and `schedulerIdleSec` read — lives on the SAME starved pool, so when the pool is
 * critically starved (routines-workflow.ts's `poolPressure()` shed, EI-9935/P-006/W4), DBOS's own
 * bookkeeping writes can stall right alongside the routine fires they're supposed to corroborate.
 * Measured live 2026-08-08/09 (`~/.papercusp/bghost-watchdog.log`): 45 kills in 17+ hours, clustered
 * 2-3 per hour at the 510s boot-grace+poll floor, each restarting a process that was HEALTHY by every
 * OTHER measure (event-loop p50 20ms, 76 harness joins per boot) — i.e. exactly the "both signals stale
 * together, but the ticker is alive and shedding, not dead" case `shouldRestart` cannot distinguish.
 *
 * The durable signal that DOES distinguish them already exists and is already wired into a sibling
 * consumer: `harness_shared.routine_pool_shed_events` (pool-pressure.ts's `recordPoolShedEvent`,
 * migration 627) is written by routinesTickImpl the INSTANT a tick sheds under critical pool pressure —
 * "so an instrument-staleness consumer can tell 'paused by this guardrail' from 'dead'" per that
 * module's own doc comment. `red-queen/engine-death.ts` (WI-5456) already consults it
 * (`hasPoolShedInWindow`) before filing a dead-engine alarm; this watchdog — which actually KILLS the
 * process, the more consequential of the two consumers — did not. `poolShedIdleSec`/
 * `poolShedExplainsFreeze` below close that gap: before restarting on a genuine-freeze verdict, check
 * whether a shed event landed within the freeze window (+ `POOL_SHED_GRACE_S` slack, mirroring
 * engine-death.ts's own grace window) — if so, this is the guardrail doing its job, not a dead ticker,
 * and we do NOT restart.
 *
 * Self-limiting by construction, no new failure mode: `recordPoolShedEvent` is fire-and-forget on the
 * SAME pool it's reporting on, and `poolPressure()`'s own probe is timeout-bounded (PROBE_TIMEOUT_MS,
 * default 3s — a probe that can't finish IS classified critical), so as long as routinesTick can run AT
 * ALL (even just far enough to shed), a fresh shed event lands roughly every POLL cadence throughout the
 * storm. If the pool is EVER so dead that not even a fire-and-forget insert can land (a genuinely
 * different, worse failure), `poolShedIdleSec` goes stale too and this corroboration silently stops
 * explaining the freeze — falling straight back to the pre-existing restart behavior. UNKNOWN
 * (no shed ever recorded, or the query itself fails) never explains a freeze — same
 * never-infer-from-a-missing-signal asymmetry as `isFrozen`/`withinBootGrace` above.
 *
 * ⚠⚠ THE "SELF-LIMITING BY CONSTRUCTION, NO NEW FAILURE MODE" CLAIM ABOVE WAS FALSE, and it cost a
 * ~53min fleet-wide outage the very next day (EI-20025430746362695, 2026-08-10). Read it as a warning,
 * not as reassurance — it is left in place because the reasoning is instructive, and because deleting
 * the wrong claim would hide why the fix below is shaped the way it is.
 *
 * The mechanism it missed is in the PREDICATE, not in the signal: `poolShedExplainsFreeze` asks
 * `shedIdleSec <= idleSec + graceSec` — and `idleSec` is the freeze's own age, so THE WINDOW EXPANDS
 * WITH THE THING IT IS EXPLAINING. A single shed event landing at the ONSET of a freeze satisfies that
 * inequality forever: at 1372s stale a 1372s-old shed still "explains" it, and so does the same event
 * at 3173s. The premise "a fresh shed event lands every poll, else the corroboration goes stale and
 * stops explaining" never had to hold, because staleness was never required to be FRESH. Measured:
 * four consecutive passes, staleness 1372→3173s, each logging "SHEDDING under pool starvation, not
 * dead" while `curl -m 10 :3271/api/health` returned http=000 and git-sync plus every routine were
 * dead fleet-wide. `systemctl` said `active` throughout, so every ordinary liveness signal agreed.
 *
 * Two things were missing, and both are now required before the shed explanation may suppress:
 *   1. POSITIVE LIVENESS — `probeHostLiveness()` asks the host itself on `/api/health`, a deliberately
 *      zero-dependency route (no DB, no auth), which is the whole reason it can separate the two cases:
 *      pool starvation cannot hang it, so shed-but-alive answers and a wedged event loop cannot. A
 *      PG-touching probe would have collapsed exactly the distinction this exists to draw.
 *   2. A BOUND — `POOL_SHED_MAX_SUPPRESS_S`, with an alarm at `POOL_SHED_ALERT_AFTER_S` before it. An
 *      unbounded suppression is a guardrail that can only ever say "not restarting", which is not a
 *      guardrail; it is an off switch that nothing can reach.
 * `poolShedSuppressionHolds` is the pure verdict combining all three conditions.
 *
 * PROGRESS-AWARE BOOT GRACE (EI-20029519971967372, 2026-08-10) — the fixed `BOOT_GRACE_MS` above is a
 * BET on how long a boot takes, and the bet now loses: a cold boot on the current 1.23M-block own log
 * saturates the worker's main thread for LONGER than the 480s grace. Measured live 01:34-02:00Z: two
 * kills EXACTLY 8 min apart (01:42:15Z, 01:50:17Z — the grace period, not a coincidence), on a worker at
 * State=R / RSS 4.43GB / +493 utime ticks per 5s (~99% of one core), sustained 10+ min, emitting no logs
 * and answering no HTTP. The grace lapsed while boot was still correctly running; the watchdog read real
 * staleness and killed a healthy, progressing process; the next boot re-entered the same race. That loop
 * is unbreakable, and it gets WORSE as the log grows — so at current size bg-host was
 * UNRECOVERABLE-BY-RESTART. (Proof it was the watchdog and not the boot: with the watchdog disabled, the
 * SAME boot completed and the endpoint went from hanging to answering in <1s.)
 *
 * The real gap is that a busy boot and a dead process are INDISTINGUISHABLE to this watchdog: both go
 * silent on every signal it reads. So we give it a signal that separates them — forward progress —
 * observed OUT OF PROCESS.
 *
 * ⚠ It MUST be out-of-process, and this is the whole design constraint. The obvious fix — "have boot
 * emit a still-booting liveness beat" — cannot work as an IN-process beat: main-thread saturation is
 * precisely the condition that silences in-process timers (`await` yields to the microtask queue, not to
 * the event loop), so a beat emitted from the saturated thread is unavailable exactly when it is needed.
 * `startBootstrapProgressPoller` (hyperbee/bootstrap-progress-poller.ts) is a 1s setInterval started
 * LATE in boot and recording in-process, and is unusable here for both of those reasons.
 *
 * So `procTreeCpuTicks` reads the answer from /proc, where a saturated process cannot suppress it:
 *   - TWO-SAMPLE DELTA, never single-shot. A single-shot CPU reading is an artifact — this is the same
 *     trap as `top -b -n1 -H`, which prints 0.0% for EVERY thread because %CPU is a delta and `-n1` has
 *     no prior sample to difference against (EI-20017779937060288). Single-shot manufactures a false
 *     "idle" reading on a process burning two full cores.
 *   - SUMMED OVER THE WHOLE PROCESS TREE, because MainPID is only a WRAPPER (utime=0, RSS 82MB) and the
 *     real work happens in a listener CHILD — measuring MainPID alone reports "idle" and is a trap the
 *     filing documents hitting. Summing the tree means never having to pick the right child.
 *   - INCLUDING cutime/cstime, so the sum is conserved when the tree REAPS children between the two
 *     samples (WI-37714). Without them the delta is not a rate at all — it oscillates about zero on a
 *     fork-and-reap tree, and a small positive reading is indistinguishable from a genuinely idle one.
 *   - Walked PID-ANCHORED (/proc/<pid>/task/<tid>/children), never by process-name pattern, so it cannot
 *     self-match a peer agent's diagnostic shell the way `pgrep -f` does.
 *
 * BOUNDED, because the sibling failure is the opposite one. `SATURATION_MAX_SUPPRESS_S` caps how long
 * this evidence may suppress a restart, and past that we restart ANYWAY (loudly, with an alert). That
 * bound is taken directly from EI-20025430746362695, where the pool-shed suppression had NO upper bound:
 * it excused staleness climbing 1372 -> 3173s across four consecutive passes and turned a guardrail into
 * a ~53min fleet-wide outage in silence. An unbounded suppression is not a safer suppression.
 *
 * ⚠ THE BOUND IS MEASURED IN CONTINUOUS SUPPRESSION TIME, NOT THE UNIT'S AGE (EI-20051589102188691).
 * It was originally scoped to a "BOOT WINDOW" — `activeForSec` between `BOOT_GRACE_MS` and a 45min
 * `BOOT_GRACE_MAX_MS` — on the reading that `activeForSec` measured how long boot had been running. It
 * does not: it is the unit's UPTIME, which keeps climbing long after boot finishes, so the window shut
 * permanently 45min into every host's life and took the whole saturated-not-dead protection with it.
 * Measured 2026-08-10T07:34:52Z: a bg-host was killed at 3506s uptime while burning 446 ticks/5s, having
 * logged `boot complete in 40443ms` 57 minutes earlier — the "boot grace" it had exceeded was long over.
 * The replacement clock resets whenever a routine fires, so it can still never excuse a steady-state
 * freeze (a host that produces nothing for `SATURATION_MAX_SUPPRESS_S` dies) while protecting a busy
 * host at ANY age. Note it is STRICTLY TIGHTER than what it replaced: the old window permitted 37min of
 * unbroken suppression (480s->2700s), this permits 900s.
 *
 * UNKNOWN (unreadable /proc, pid reuse, a negative delta) grants NO suppression — the same
 * never-infer-from-a-missing-signal asymmetry as `isFrozen` / `withinBootGrace` /
 * `poolShedExplainsFreeze` above. Placed LAST among the suppressions, immediately before `restart()`,
 * so it costs its sample only when we were otherwise about to kill the process.
 *
 * Env (all optional): PAPERCUSP_BGHOST_WATCHDOG_{UNIT,POLL_MS,SILENCE_S,DEBOUNCE_MS,MAX_RESTARTS_HR,DB_URL,LOG,
 *   BOOT_GRACE_MS,BACKOFF_MULTIPLIER,MAX_DEBOUNCE_MS,ALERT_AFTER_RESTARTS,SUSTAINED_HEALTHY_POLLS,
 *   POOL_SHED_GRACE_S,SATURATION_MAX_SUPPRESS_S,SATURATION_ALERT_AFTER_S,BOOT_PROGRESS_SAMPLE_MS,BOOT_PROGRESS_MIN_TICKS,
 *   HOT_PATH_ACTIVATION_CHECK_MS},
 *   PAPERCUSP_INTEGRATION_ROOT, DATABASE_URL.
 */
import { execFile, execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { cpus, freemem, homedir, hostname, loadavg, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXTERNAL_SCHEDULES } from '../../../packages/operator-core/lib/schedule-descriptors.mjs';

const UNIT = process.env.PAPERCUSP_BGHOST_WATCHDOG_UNIT || 'papercusp-bg-host';
const POLL_MS = Number(process.env.PAPERCUSP_BGHOST_WATCHDOG_POLL_MS) || EXTERNAL_SCHEDULES.bgHostWatchdogPoll.defaultIntervalMs;
const FREEZE_SILENCE_S = Number(process.env.PAPERCUSP_BGHOST_WATCHDOG_SILENCE_S) || 100; // newest routine older than this while active = frozen
const DEBOUNCE_MS = Number(process.env.PAPERCUSP_BGHOST_WATCHDOG_DEBOUNCE_MS) || 5 * 60_000;
// WI-37501: lowered from 8 — at the default BOOT_GRACE_MS(480s)+POLL_MS(30s), the fastest a genuine
// boot-grace-floored restart storm can recur is 510s = 7.06/hr, so 8 sat just ABOVE the reachable
// ceiling and could never trip against that storm shape. 6 leaves real margin below it.
const MAX_RESTARTS_PER_HR = Number(process.env.PAPERCUSP_BGHOST_WATCHDOG_MAX_RESTARTS_HR) || 6;
/** Skip the freeze judgment while the unit has been active less than this long (EI-8901): the observed
 *  boot takes ~4-5min under load; default is a bit over 2x that plus buffer so a slow boot never gets
 *  judged frozen mid-boot. */
const BOOT_GRACE_MS = Number(process.env.PAPERCUSP_BGHOST_WATCHDOG_BOOT_GRACE_MS) || 8 * 60_000;
/** WI-3630: each consecutive restart multiplies the debounce by this much (capped at MAX_DEBOUNCE_MS) — an
 *  unusually slow boot (worse than BOOT_GRACE_MS anticipated) gets progressively more room instead of being
 *  re-killed on the same fixed clock. */
const BACKOFF_MULTIPLIER = Number(process.env.PAPERCUSP_BGHOST_WATCHDOG_BACKOFF_MULTIPLIER) || 2;
const MAX_DEBOUNCE_MS = Number(process.env.PAPERCUSP_BGHOST_WATCHDOG_MAX_DEBOUNCE_MS) || 30 * 60_000;
/** WI-3630: fire `alertFleet()` once consecutive restarts reach this — well before MAX_RESTARTS_PER_HR (the
 *  hard breaker), so a running fleet sees a developing storm instead of only a fully-tripped one. */
const ALERT_AFTER_RESTARTS = Number(process.env.PAPERCUSP_BGHOST_WATCHDOG_ALERT_AFTER_RESTARTS) || 2;
/** WI-37501: consecutive HEALTHY polls required before the strike counter clears — a single healthy poll
 *  is not evidence the boot succeeded (a stalled process can fire exactly one routine early in boot). */
const SUSTAINED_HEALTHY_POLLS = Number(process.env.PAPERCUSP_BGHOST_WATCHDOG_SUSTAINED_HEALTHY_POLLS) || 3;
/** WI-37506: extra slack (seconds) added to the observed freeze window (idleSec) when checking whether a
 *  durable pool-shed guardrail event explains it — mirrors engine-death.ts's own `graceMinutes` window
 *  (WI-5456). A shed event lands the INSTANT a tick's probe crosses critical, which can be a beat before
 *  routine fires / the scheduler themselves cross FREEZE_SILENCE_S, so the window needs a little room. */
const POOL_SHED_GRACE_S = Number(process.env.PAPERCUSP_BGHOST_WATCHDOG_POOL_SHED_GRACE_S) || 120;
/** EI-20025430746362695: the pool-shed suppression's ABSOLUTE BOUND. The shed explanation may excuse
 *  staleness for at most this long; past it we restart regardless and say so loudly. An unbounded
 *  suppression is exactly what turned this guardrail into a 53min fleet-wide outage (staleness climbed
 *  1372→3173s across four passes with no escalation). */
const POOL_SHED_MAX_SUPPRESS_S = Number(process.env.PAPERCUSP_BGHOST_WATCHDOG_POOL_SHED_MAX_SUPPRESS_S) || 900;
/** How long a suppression may hold before it stops being a log line nobody reads and becomes an
 *  operator-visible alarm (still suppressing — this is the warning, not the bound above).
 *
 *  ⚠ Deliberately a DURATION, though the filing asked for ">2 consecutive passes": a pass count is
 *  poll-cadence-dependent, so at POLL_MS=30s "2 passes" is 60s and would alarm on every ordinary brief
 *  shed. The filing's author was counting the 10-min-throttled LOG LINES, not passes — the intent was
 *  "minutes of silence", and a duration expresses that stably even if POLL_MS is retuned later. Same
 *  class of trap as the WI-37501 circuit breaker that went arithmetically unreachable when its
 *  threshold was expressed in units that moved underneath it. */
const POOL_SHED_ALERT_AFTER_S = Number(process.env.PAPERCUSP_BGHOST_WATCHDOG_POOL_SHED_ALERT_AFTER_S) || 300;
/** The host's OWN liveness endpoint. `/api/health` is a deliberately ZERO-DEPENDENCY 200 (no DB, no
 *  auth — see routes/misc/health.ts), which is what makes it the right discriminator here: PG pool
 *  starvation cannot hang it, so a shed-but-alive host still answers, while a wedged event loop cannot
 *  answer at all. A PG-touching probe would have collapsed the two cases this fix exists to separate. */
const BGHOST_HEALTH_URL =
  process.env.PAPERCUSP_BGHOST_WATCHDOG_HEALTH_URL || 'http://127.0.0.1:3271/api/health';
const BGHOST_HEALTH_TIMEOUT_MS =
  Number(process.env.PAPERCUSP_BGHOST_WATCHDOG_HEALTH_TIMEOUT_MS) || 5_000;
/** EI-20051589102188691: the bound on how long CPU evidence may suppress a restart — expressed as
 *  CONTINUOUS SUPPRESSION TIME, deliberately NOT as the unit's age.
 *
 *  ⚠ This replaces `BOOT_GRACE_MAX_MS`, which bounded `activeForSec` (the unit's UPTIME) in the belief
 *  that it measured how long boot had been running. It does not: uptime never stops growing once boot
 *  finishes, so that cap silently expired the whole "saturated, not dead" protection 45min after start
 *  and never restored it — re-arming the exact failure EI-20029519971967372 had just fixed, for every
 *  host older than 45min. Measured 2026-08-10T07:34:52Z: a bg-host was killed at 3506s uptime while its
 *  tree burned 446 ticks/5s, and its own log had recorded `boot complete in 40443ms` — i.e. the "boot
 *  grace" it was judged to have exceeded had ended 57 minutes earlier.
 *
 *  A duration of continuous suppression is the honest bound, because it measures the thing we are
 *  actually worried about (how long we have excused an absent ticker) rather than a proxy that drifts
 *  away from it. It RESETS the moment a routine fires (the healthy path below), so a host that ticks at
 *  all is protected indefinitely at ANY age, while one that burns CPU and produces nothing still dies —
 *  which is a no-forward-progress detector rather than a clock. Bounded for the same reason as its
 *  pool-shed sibling: an unbounded suppression turned that guardrail into a 53min outage
 *  (EI-20025430746362695). Default 900s mirrors `POOL_SHED_MAX_SUPPRESS_S`, and tightens the old
 *  effective ceiling (45min of uptime) rather than loosening it. */
const SATURATION_MAX_SUPPRESS_S =
  Number(process.env.PAPERCUSP_BGHOST_WATCHDOG_SATURATION_MAX_SUPPRESS_S) || 900;
/** How long saturation may suppress before it becomes an operator-visible alarm (still suppressing —
 *  this is the warning, not the bound above). Mirrors POOL_SHED_ALERT_AFTER_S; a duration, not a pass
 *  count, for the reason spelled out there. */
const SATURATION_ALERT_AFTER_S =
  Number(process.env.PAPERCUSP_BGHOST_WATCHDOG_SATURATION_ALERT_AFTER_S) || 300;
/** EI-20029519971967372: wall time between the two /proc CPU samples. A SINGLE sample is meaningless —
 *  CPU usage is a delta (the `top -n1` artifact, EI-20017779937060288). 5s matches the recipe that
 *  measured the real worker at +493 ticks/5s. */
const BOOT_PROGRESS_SAMPLE_MS = Number(process.env.PAPERCUSP_BGHOST_WATCHDOG_BOOT_PROGRESS_SAMPLE_MS) || 5_000;
/** EI-20029519971967372: minimum utime+stime ticks (USER_HZ=100) the process tree must burn across the
 *  sample to count as PROGRESSING. 50 ticks / 5s = 0.1 of a core — an order of magnitude below the
 *  measured 493 (~99% of a core), and far above idle jitter. */
const BOOT_PROGRESS_MIN_TICKS = Number(process.env.PAPERCUSP_BGHOST_WATCHDOG_BOOT_PROGRESS_MIN_TICKS) || 50;
/** Throttled "still monitoring + ticker healthy" line so the durable log proves the watchdog is ACTIVELY
 *  reading freshness (not silently early-returning) — the operability gap that made this whole class
 *  invisible for 44h. First healthy poll logs immediately, then at most every HEARTBEAT_MS. */
const HEARTBEAT_MS = Number(process.env.PAPERCUSP_BGHOST_WATCHDOG_HEARTBEAT_MS) || 10 * 60_000;
/** EI-18133447445064828: committed routine-code activation is deliberately much less frequent than
 * freeze detection. A 30s freeze poll is useful; running two git reads and a cgroup scan every 30s is
 * not. The guard below also prevents an overlapping poll from launching a second coordinated restart. */
const HOT_PATH_ACTIVATION_CHECK_MS =
  Number(process.env.PAPERCUSP_BGHOST_WATCHDOG_HOT_PATH_ACTIVATION_CHECK_MS) || 5 * 60_000;
/** Durable, journald-INDEPENDENT decision log (EI-2434: journald can't be trusted to capture stdout). */
const LOG_FILE = process.env.PAPERCUSP_BGHOST_WATCHDOG_LOG || join(homedir(), '.papercusp', 'bghost-watchdog.log');
/** deploys:vintage self-report sink (fleet-reliability-verification-2026-07-10 P-008) — see the
 *  matching constant in inference-gateway/watchdog.mjs for the rationale (this watchdog is itself
 *  a tracked runtime). Default target :3070 (always-up release operator, two-port model). */
const VINTAGE_URL = process.env.PAPERCUSP_RUNTIME_VINTAGE_URL || 'http://127.0.0.1:3070/api/internal/runtime-vintage';

let lastRestart = 0;
let lastHeartbeat = 0;
const restartTimes = []; // epoch ms, rolling 1h, for the circuit breaker
// WI-3630: consecutive-restart strike count driving the backoff + alert. Resets to 0 the moment a poll
// observes the ticker genuinely healthy (NOT merely "within boot grace" — a storm isn't over until a
// routine actually fires fresh again).
let consecutiveRestarts = 0;
// WI-37501: consecutive HEALTHY polls in a row, right now. Reset to 0 by ANY stale-idleSec observation
// (frozen-and-restarting, frozen-but-boot-grace-excused, or frozen-but-saturation-excused alike) — the
// point is proof of CONTINUOUS good health, not merely "not judged frozen enough times, spread out".
let healthyStreak = 0;
/** EI-20025430746362695: the CURRENT pool-shed suppression streak — when it began (ms epoch, null = no
 *  streak in flight), how many consecutive passes it has held, and whether we have already alarmed for
 *  it. Reset wherever the suppression does not apply, so a later, unrelated shed starts a fresh bound. */
let poolShedSuppressSinceMs = null;
let poolShedSuppressPasses = 0;
let poolShedAlerted = false;
/** When the last shed-SUPPRESSED pass happened. The streak is judged broken by a GAP here rather than
 *  by reset calls sprinkled across poll()'s many early-return paths — one place to get right instead of
 *  six to remember, and self-healing if a new branch is added later. */
let poolShedSuppressLastAtMs = 0;
/** EI-20051589102188691: the CURRENT saturation ("burning CPU, so not dead") suppression streak — the
 *  clock that BOUNDS it, replacing the old unit-age cap. Judged broken by a GAP in `…LastAtMs` rather
 *  than by reset calls sprinkled across poll()'s many early-return paths, mirroring the pool-shed streak
 *  above deliberately: one place to get right instead of six to remember, and self-healing if a new
 *  branch is added later. A gap is exactly what a routine firing produces (the healthy path returns
 *  without touching this), so "the ticker recovered" resets the bound for free. */
let saturationSuppressSinceMs = null;
let saturationSuppressPasses = 0;
let saturationAlerted = false;
let saturationSuppressLastAtMs = 0;
let hotPathActivationCheckInFlight = false;
let lastHotPathActivationCheckMs = 0;
let lastHotPathActivationDecisionKey = null;
let logDirEnsured = false;
const log = (m) => {
  const line = `[bghost-watchdog ${new Date().toISOString()}] ${m}`;
  console.log(line);
  try {
    if (!logDirEnsured) {
      mkdirSync(dirname(LOG_FILE), { recursive: true });
      logDirEnsured = true;
    }
    appendFileSync(LOG_FILE, line + '\n');
  } catch {
    /* durable log unavailable — console.log remains; never let logging crash the watchdog */
  }
};

function sh(cmd, args, opts = {}) {
  return new Promise((resolve_) => {
    const child = execFile(cmd, args, { timeout: opts.timeout ?? 10_000 }, (err, stdout, stderr) =>
      resolve_({ err, stdout: stdout || '', stderr: stderr || '' }),
    );
    // Optional stdin payload (EI-9419: psql only interpolates -v variables in stdin/file
    // input, NEVER in -c strings — callers that need bind-variables must pipe the SQL).
    if (opts.stdin != null && child.stdin) {
      child.stdin.on('error', () => {}); // EPIPE if the child exits early — the execFile callback still fires
      child.stdin.write(opts.stdin);
      child.stdin.end();
    }
  });
}

/** Resolve the bg-host's DATABASE_URL self-contained (no unit/host-config change): explicit override →
 *  process env → parse .env.local at the integration root (the same source the bg-host unit sources),
 *  found relative to THIS script so it works regardless of cwd. Returns null if unresolved (→ UNKNOWN). */
export function resolveDbUrl(readFile = readFileSync) {
  if (process.env.PAPERCUSP_BGHOST_WATCHDOG_DB_URL) return process.env.PAPERCUSP_BGHOST_WATCHDOG_DB_URL;
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    const root = process.env.PAPERCUSP_INTEGRATION_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
    const env = readFile(resolve(root, '.env.local'), 'utf8');
    const m = env.match(/^\s*(?:export\s+)?DATABASE_URL\s*=\s*(.+?)\s*$/m);
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  } catch {
    /* no .env.local / unreadable → unknown */
  }
  return null;
}

/** Parse psql's `-tAqc` scalar output for the routine-idle age in seconds. Empty / NULL (no active
 *  routines or none fired yet) ⇒ null = UNKNOWN (never treat as frozen). */
export function parseIdleSec(stdout) {
  const v = String(stdout ?? '').trim();
  if (v === '' || v.toLowerCase() === 'null') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Pure freeze verdict: a NUMBER idle age over the threshold = frozen; null (unknown) is NEVER frozen. */
export function isFrozen(idleSec, freezeSilenceS = FREEZE_SILENCE_S) {
  return idleSec != null && idleSec > freezeSilenceS;
}

/**
 * Pure restart decision (2026-06-23 — the routines-queue-saturation false-restart fix). A stale routine
 * `last_fired_at` (`routineIdleSec`) alone is AMBIGUOUS: it means a genuine ticker freeze OR merely a
 * SATURATED fire-queue — a few legitimate LONG routines (green-checkpoint ~25m, gym ~90m) holding every
 * `routines`-queue slot stall new claims/completions WITHOUT the event loop being frozen. Restarting THEN is
 * destructive: it kills the in-flight long routines mid-run, DBOS recovers them, they re-saturate → a 5-min
 * restart LOOP that never lets them finish + freezes git-sync (the 2026-06-23 deploy-freeze incident).
 *
 * Corroborate with the SCHEDULER's own liveness (`schedulerIdleSec` = newest `routinesTick` age): the tick
 * fires every ~30s on the SAME event loop but is NOT on the saturable `routines` queue, so a FRESH tick
 * proves the ticker is ALIVE (just busy) → NOT a freeze. Restart only when fires are stale AND the scheduler
 * is not confirmed-fresh (a real freeze stalls BOTH). A null scheduler signal (rare — the routines read
 * succeeded, so the same DB is reachable) falls back to the documented fire-staleness behavior.
 */
export function shouldRestart(idleSec, schedSec, freezeSilenceS = FREEZE_SILENCE_S) {
  if (!isFrozen(idleSec, freezeSilenceS)) return false; // fires unknown or healthy → never a freeze
  if (schedSec != null && !isFrozen(schedSec, freezeSilenceS)) return false; // scheduler alive ⇒ saturation, not a freeze
  return true; // fires stale AND scheduler also stale (or unreadable) ⇒ genuine freeze
}

/** Pure boot-grace verdict (EI-8901): a NUMBER active-for age under the grace window means "still booting,
 *  don't judge" — null/undefined (unknown boot time) is NEVER grace (fails to the pre-existing behavior;
 *  never invents suppression from a missing signal, mirroring `isFrozen`'s null-is-never-frozen asymmetry). */
export function withinBootGrace(activeForSec, bootGraceMs = BOOT_GRACE_MS) {
  return activeForSec != null && activeForSec >= 0 && activeForSec * 1000 < bootGraceMs;
}

/** Pure "saturated, not frozen" verdict (EI-20029519971967372, re-bounded by EI-20051589102188691): may
 *  DEMONSTRATED forward progress suppress a restart? True only when ALL of:
 *    - the unit is past the plain boot grace (below it, `withinBootGrace` already covers us), and
 *    - we have not been suppressing CONTINUOUSLY for `maxSuppressS` (the bound — see below), and
 *    - `cpuTicksDelta` is a NUMBER at or above `minTicks` (positive evidence of work being done).
 *
 *  ⚠ THE BOUND IS A SUPPRESSION DURATION, NOT THE UNIT'S AGE — and that distinction IS the fix. The
 *  previous form took `activeForSec` (uptime) and refused past a 45min cap, reading uptime as "how long
 *  boot has been running". Uptime keeps growing after boot completes, so the refusal became permanent
 *  for any host older than 45min: the saturation protection switched itself off and never came back,
 *  which is how a host burning 446 ticks/5s was killed at 3506s uptime, 57 minutes after its own log
 *  said `boot complete in 40443ms` (EI-20051589102188691).
 *
 *  This is NOT the unbounded-suppression bug sign-flipped (EI-20025430746362695 — a suppression with no
 *  cap excused staleness 1372→3173s and caused a ~53min outage). The cap is still here and is STRICTLY
 *  TIGHTER: the old uptime window permitted 37min of unbroken suppression (480s→2700s), this permits
 *  `maxSuppressS` (900s). It is also self-clearing — the caller resets the clock the moment a routine
 *  fires — so the quantity bounded is "how long we have excused an absent ticker", which is the thing
 *  the sibling outage was actually about, rather than a proxy that drifts away from it.
 *
 *  null/undefined/negative `cpuTicksDelta` is UNKNOWN and grants NOTHING — a /proc read fault, a pid
 *  reused mid-sample, or a tree that shrank must never manufacture suppression from a missing signal
 *  (the same asymmetry as `isFrozen` / `withinBootGrace` / `poolShedExplainsFreeze`). Likewise an
 *  unknown `activeForSec` or an unreadable suppression clock: if we cannot say suppression is still
 *  inside its bound, it is not. */
export function saturationExtendsGrace(
  activeForSec,
  cpuTicksDelta,
  suppressedForSec = 0,
  bootGraceMs = BOOT_GRACE_MS,
  maxSuppressS = SATURATION_MAX_SUPPRESS_S,
  minTicks = BOOT_PROGRESS_MIN_TICKS,
) {
  if (activeForSec == null || !Number.isFinite(activeForSec) || activeForSec < 0) return false;
  if (activeForSec * 1000 < bootGraceMs) return false; // plain boot grace already covers this
  if (suppressedForSec == null || !Number.isFinite(suppressedForSec) || suppressedForSec < 0) return false;
  if (suppressedForSec >= maxSuppressS) return false; // THE BOUND: restart even while progressing
  if (cpuTicksDelta == null || !Number.isFinite(cpuTicksDelta) || cpuTicksDelta < 0) return false;
  return cpuTicksDelta >= minTicks;
}

/** Sum utime+stime+cutime+cstime (clock ticks) across `rootPid` AND every descendant, read straight
 *  from /proc.
 *
 *  Three deliberate shapes (EI-20029519971967372, WI-37714):
 *   - THE WHOLE TREE, because the unit's MainPID is only a wrapper (utime=0) while the real work runs in
 *     a listener child; summing means never having to pick the right pid.
 *   - ALL FOUR TICK FIELDS, so the total is CONSERVED when a child is reaped between two samples (the
 *     kernel moves its ticks into the parent's cutime). ut/st alone makes a fork-and-reap tree read
 *     near-zero or negative while it burns multiple cores — see `ticksOf` for the measurements.
 *   - Children come from /proc/<pid>/task/<tid>/children — PID-anchored, so unlike a `pgrep -f` pattern
 *     it cannot match a peer agent's diagnostic shell that happens to contain the same string.
 *
 *  Returns null (UNKNOWN) only when the ROOT's own stat is unreadable. A descendant that vanishes
 *  mid-walk is normal (processes exit) and is skipped, not escalated to UNKNOWN. Bounded by `maxPids` so
 *  a pathological tree can never stall the poll loop. */
export function procTreeCpuTicks(rootPid, deps = {}) {
  const readFile = deps.readFile ?? readFileSync;
  const readDir = deps.readDir ?? readdirSync;
  const maxPids = deps.maxPids ?? 512;
  if (!Number.isFinite(rootPid) || rootPid <= 0) return null;

  /** utime (14) + stime (15) + cutime (16) + cstime (17) of /proc/<pid>/stat, or null if
   *  unreadable/unparseable.
   *
   *  ⚠ THE c* PAIR IS LOAD-BEARING, NOT DEFENSIVE (WI-37714). Summing only ut/st over the LIVE set makes
   *  the total a sum over a MEMBERSHIP-VARYING set, so differencing two samples is not a rate: a child
   *  reaped between samples takes its contribution to sample A out of sample B. Measured against a
   *  fork-and-reap tree steadily burning ~2.7 cores, ut+st alone yielded 89, -89, 74, -73, 0, 81
   *  ticks/3s — oscillating about zero — while all four yielded 668, 830, 799, 887, 813, 798. The
   *  negative-delta fail-safe does NOT cover that: the small POSITIVE readings are accepted as an honest
   *  measurement of a nearly-idle tree, so a fully-busy host is denied SATURATION_MAX_SUPPRESS_S
   *  protection and killed. The kernel migrates a reaped child's ticks into its parent's cutime on
   *  wait(), so all four CONSERVE ticks across churn. No double-count: a process contributes its own
   *  ut/st only while it is alive and in the walked set, and its parent's cutime credits it only once it
   *  is dead and out of that set.
   *
   *  ⚠ Do NOT "simplify" this to reading the ROOT's cutime alone. Measured against the same tree, that
   *  reports EXACTLY 0 for the whole run whenever the root is not the direct reaper (root -> mid -> …),
   *  because the root does not wait() on anything until the run ends — a worse false-idle than the bug.
   *
   *  The comm field (2) is parenthesised and may itself contain spaces AND parens, so field splitting
   *  must start after the LAST ')' — the classic /proc/stat parsing trap. */
  const ticksOf = (pid) => {
    let raw;
    try {
      raw = String(readFile(`/proc/${pid}/stat`, 'utf8'));
    } catch {
      return null;
    }
    const close = raw.lastIndexOf(')');
    if (close < 0) return null;
    const fields = raw.slice(close + 2).trim().split(/\s+/); // fields[0] is field 3 (state)
    const utime = Number(fields[11]); // field 14
    const stime = Number(fields[12]); // field 15
    const cutime = Number(fields[13]); // field 16 — reaped descendants' utime
    const cstime = Number(fields[14]); // field 17 — reaped descendants' stime
    if (!Number.isFinite(utime) || !Number.isFinite(stime)) return null;
    if (!Number.isFinite(cutime) || !Number.isFinite(cstime)) return null;
    return utime + stime + cutime + cstime;
  };

  const rootTicks = ticksOf(rootPid);
  if (rootTicks == null) return null; // the root itself is gone/unreadable ⇒ genuinely UNKNOWN

  let total = rootTicks;
  const seen = new Set([rootPid]);
  const stack = [rootPid];
  while (stack.length > 0 && seen.size < maxPids) {
    const pid = stack.pop();
    let tids;
    try {
      tids = readDir(`/proc/${pid}/task`);
    } catch {
      continue; // exited mid-walk — ordinary, not UNKNOWN
    }
    for (const tid of tids) {
      let kids;
      try {
        kids = String(readFile(`/proc/${pid}/task/${tid}/children`, 'utf8')).trim();
      } catch {
        continue;
      }
      if (!kids) continue;
      for (const tok of kids.split(/\s+/)) {
        const child = Number(tok);
        if (!Number.isFinite(child) || child <= 0 || seen.has(child)) continue;
        seen.add(child);
        const t = ticksOf(child);
        if (t != null) total += t;
        stack.push(child);
        if (seen.size >= maxPids) break;
      }
    }
  }
  return total;
}

/** The unit's MainPID, or null if systemd cannot tell us (never active, read fault, or 0). */
/** The basename of the marker `cut-seed-quiesced.sh` writes at `$XDG_RUNTIME_DIR/`. MIRRORED from
 *  `packages/operator-core/lib/agent-tools/dev/bg-host-quiesce-guard.ts` — this script is plain
 *  node (no TS loader), so the string cannot be imported from the guard. The two are pinned
 *  together by `bghost-watchdog-quiesce-contract.test.ts`, which fails if either side changes it
 *  alone; do not edit one without the other. */
export const QUIESCE_MARKER_BASENAME = 'papercusp-seed-cut.quiesce';

/** A DELIBERATE quiesce declared by a seed cut, or null when none is declared (EI-22091522428797790).
 *  Returns a short reason string for the log. Fail-soft in the direction that keeps the watchdog
 *  ALIVE: an absent marker is the normal state and an unreadable one is indistinguishable from it,
 *  so both mean "no quiesce" — this must never invent a reason to stop guarding the ticker. */
export function seedCutQuiesce(readFile = readFileSync, env = process.env) {
  const runtimeDir = env.XDG_RUNTIME_DIR || (typeof process.getuid === 'function' ? `/run/user/${process.getuid()}` : '');
  if (!runtimeDir) return null;
  try {
    const raw = String(readFile(join(runtimeDir, QUIESCE_MARKER_BASENAME), 'utf8')).trim();
    if (!raw) return 'marker present, empty';
    return raw.replace(/\s+/g, ' ').slice(0, 200);
  } catch {
    return null;
  }
}

async function unitMainPid() {
  const r = await sh('systemctl', ['--user', 'show', UNIT, '-p', 'MainPID', '--value']);
  if (r.err) return null;
  const pid = Number(r.stdout.trim());
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

/** TWO-SAMPLE CPU delta (ticks) over the unit's whole process tree — the only honest way to ask "is this
 *  process doing work RIGHT NOW". A single sample cannot answer it (that is the `top -n1` 0.0% artifact,
 *  EI-20017779937060288). Returns null (UNKNOWN) on any read fault, and also on a NEGATIVE delta, which
 *  means the tree changed identity under us (a restart / pid reuse) rather than that it went idle. */
async function bootProgressTicks(sampleMs = BOOT_PROGRESS_SAMPLE_MS, deps = {}) {
  const pid = deps.mainPid ?? (await unitMainPid());
  if (pid == null) return null;
  const before = procTreeCpuTicks(pid, deps);
  if (before == null) return null;
  await new Promise((r) => setTimeout(r, sampleMs));
  const after = procTreeCpuTicks(pid, deps);
  if (after == null) return null;
  const delta = after - before;
  return delta >= 0 ? delta : null;
}

/** How long (seconds) the unit has been in its CURRENT active generation — from systemd's own
 *  ActiveEnterTimestampMonotonic (µs since boot) vs. the current boot-relative clock (/proc/uptime),
 *  which sidesteps wall-clock/timezone parsing entirely and is safe even if a restart happened from
 *  outside this watchdog (`systemctl restart` by hand, or a prior watchdog process that has since died).
 *  Returns null (UNKNOWN) on any read fault — property absent/zero (unit never active), unreadable
 *  /proc/uptime, or a non-finite parse. */
async function unitActiveForSec(readFile = readFileSync) {
  let uptimeSec;
  try {
    uptimeSec = parseFloat(String(readFile('/proc/uptime', 'utf8')).trim().split(/\s+/)[0]);
  } catch {
    return null;
  }
  if (!Number.isFinite(uptimeSec)) return null;
  const r = await sh('systemctl', ['--user', 'show', UNIT, '-p', 'ActiveEnterTimestampMonotonic', '--value']);
  if (r.err) return null;
  const activeMonoUsec = Number(r.stdout.trim());
  if (!Number.isFinite(activeMonoUsec) || activeMonoUsec <= 0) return null;
  const activeForSec = uptimeSec - activeMonoUsec / 1_000_000;
  return activeForSec >= 0 ? activeForSec : null;
}

/** Pure exponential-backoff debounce (WI-3630): the debounce before the NEXT restart may fire, given how
 *  many restarts have already happened CONSECUTIVELY (without an intervening healthy poll). Doubles
 *  (default multiplier) per strike, capped at `capMs` so it can't grow unbounded. `consecutiveRestarts <= 0`
 *  (the first restart of a fresh storm) is just the base debounce. */
export function nextDebounceMs(baseMs, consecutiveRestartsArg, multiplier = BACKOFF_MULTIPLIER, capMs = MAX_DEBOUNCE_MS) {
  const strikes = Math.max(0, consecutiveRestartsArg || 0);
  const scaled = baseMs * multiplier ** strikes;
  return Math.min(scaled, capMs);
}

/** Pure (WI-37501): has the ticker been healthy for LONG ENOUGH to treat a restart storm as genuinely
 *  over, vs. one lucky poll mid-freeze? `healthyStreak` is the count of consecutive healthy polls right
 *  now (0 after any stale observation). Only once it reaches `sustainedPolls` do we clear the
 *  consecutive-restart strike count — see the file-header WI-37501 note for the observed failure this
 *  replaces (a single healthy poll cleared the strike, so BACKOFF_MULTIPLIER escalation never engaged). */
export function shouldClearStrikes(healthyStreak, sustainedPolls = SUSTAINED_HEALTHY_POLLS) {
  return healthyStreak >= sustainedPolls;
}

/** Pure (WI-37501): the theoretical MAXIMUM restarts/hr this watchdog's OWN cadence can ever produce. A
 *  storm cannot restart faster than once every (bootGraceMs + pollMs): the freeze judgment is suppressed
 *  for the whole boot-grace window and only re-evaluated on the next poll after it lapses. If
 *  MAX_RESTARTS_PER_HR is set >= this, the circuit breaker can NEVER trip against a boot-grace-floored
 *  storm — exactly the WI-37501 defect (8 vs. a reachable 7.06 at the old defaults). */
export function maxReachableRestartsPerHr(bootGraceMs = BOOT_GRACE_MS, pollMs = POLL_MS) {
  const floorMs = bootGraceMs + pollMs;
  return floorMs > 0 ? 3_600_000 / floorMs : Infinity;
}

/** Pure alert-threshold verdict (WI-3630): true once consecutive restarts reach `alertAfter` — fired well
 *  before the hard MAX_RESTARTS_PER_HR circuit breaker so a developing storm is visible early.
 *  ⚠ This answers "is a STORM developing?", NOT "did this restart destroy anything?" — see
 *  `classifyCollateral` below for why those must never share a threshold (EI-19485006080051257). */
export function shouldAlert(consecutiveRestartsArg, alertAfter = ALERT_AFTER_RESTARTS) {
  return (consecutiveRestartsArg || 0) >= alertAfter;
}

/* ─────────────────────────────────────────────────────────────────────────────
 * COLLATERAL REPORTING (EI-19485006080051257, 2026-08-04)
 *
 * `systemctl restart papercusp-bg-host` tears down the unit's WHOLE cgroup (KillMode=control-group,
 * the systemd default). That cgroup does not hold only bg-host: measured 2026-08-04, it also held the
 * agent spawner (spawner-sidecar.ts) and 5 of the owner's LIVE desktop-app sidecars, because
 * fleet/spawner-sidecar-spawn.ts spawns them with a raw `spawn(..., { detached: false })` that inherits
 * the cgroup instead of routing through managedSpawn/systemd-run --scope (root cause + fix: e15fb on
 * EI-19479764372783341 — this file is deliberately NOT that fix).
 *
 * Until that lands, every restart this watchdog issues is destructive — and it was SILENT. The storm
 * alert above needs ALERT_AFTER_RESTARTS (2) consecutive strikes, and `consecutiveRestarts` resets to 0
 * on the first healthy poll (see poll()), so the ordinary case — one freeze, one restart, clean recovery
 * — could never reach the threshold. The better the watchdog worked, the more certainly the damage went
 * unreported: the owner's desktop app dies, bg-host comes back healthy, and nothing anywhere records it.
 *
 * The defect is NOT that the storm alert debounces. Debouncing "is this freeze noteworthy?" is correct,
 * and is exactly what the 06-30 100s→240s tolerance raise was chasing. The defect is that a debounced
 * counter was also made to gate the reporting of an IRREVERSIBLE SIDE EFFECT. Those are two different
 * questions and only one of them is about noise, so they get two different signals: the storm alert stays
 * threshold-gated, and collateral is reported on the FIRST occurrence, always.
 *
 * Asymmetry, matching `isFrozen`/`withinBootGrace` in this file: an UNREADABLE cgroup yields null and we
 * say nothing. We never infer collateral from a missing signal, and we never let a reporting fault touch
 * the restart decision it accompanies.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Pure: parse a cgroup.procs file (one decimal pid per line) into pids. Junk lines are dropped rather
 *  than throwing — this runs on the restart path and must never be the thing that breaks it. */
export function parseCgroupProcs(text) {
  return String(text ?? '')
    .split('\n')
    .map((l) => Number(l.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
}

/**
 * Pure: classify cgroup occupants into "the unit's own processes" vs. COLLATERAL that a restart destroys.
 *
 * `entries` is [{ pid, cmdline }]. Returns null for a null/empty input (UNKNOWN — say nothing).
 *
 * Categories are deliberately conservative: only processes we can positively identify are named, and
 * everything unrecognised counts as `other` collateral rather than being assumed benign. Getting this
 * wrong in the "assume benign" direction would re-create the exact silence this function exists to end.
 */
export function classifyCollateral(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return null;
  const own = [];
  const spawner = [];
  const desktop = [];
  const other = [];
  for (const e of entries) {
    const cmd = String(e?.cmdline ?? '');
    if (!cmd) continue;
    // The unit's own server + its build helper — expected to die with the unit, not collateral.
    // The bg-host now starts the bundled entry (`node dist-host/hono-host.mjs`) after the
    // 95-bundled-entry drop-in replaced the old tsx command. Keep both launch shapes here:
    // misclassifying the bundled host as collateral makes the committed-hot-path activation
    // guard permanently suppress every safe restart (EI-21678196684867980).
    if (
      cmd.includes('bin/hono-host.ts') ||
      cmd.includes('dist-host/hono-host.mjs') ||
      cmd.includes('esbuild --service')
    )
      own.push(e);
    else if (cmd.includes('spawner-sidecar')) spawner.push(e);
    else if (cmd.includes('Papercusp GUI') || cmd.includes('serve.mjs')) desktop.push(e);
    else other.push(e);
  }
  const collateral = spawner.length + desktop.length + other.length;
  return {
    total: own.length + collateral,
    own: own.length,
    spawner: spawner.length,
    desktop: desktop.length,
    other: other.length,
    collateral,
    // A bounded sample so the alert can name what died without unbounded growth.
    otherSample: other.slice(0, 3).map((e) => `${e.pid}:${String(e.cmdline).slice(0, 60)}`),
  };
}

/** Pure: the fleet-facing collateral notice. Returns null when there is nothing to report — an UNKNOWN
 *  snapshot (null) or a restart that genuinely destroys nothing but the unit itself. */
export function collateralAlertMessage(unit, summary, reason) {
  if (!summary || summary.collateral <= 0) return null;
  const parts = [];
  if (summary.spawner > 0) parts.push(`the AGENT SPAWNER (${summary.spawner} proc${summary.spawner === 1 ? '' : 's'})`);
  if (summary.desktop > 0) parts.push(`${summary.desktop} LIVE desktop-app sidecar${summary.desktop === 1 ? '' : 's'}`);
  if (summary.other > 0) {
    const sample = summary.otherSample.length ? ` [e.g. ${summary.otherSample.join(', ')}]` : '';
    parts.push(`${summary.other} other process${summary.other === 1 ? '' : 'es'}${sample}`);
  }
  return (
    `⚠ ${unit} was RESTARTED by its freeze watchdog and this KILLED ${summary.collateral} process(es) ` +
    `sharing its cgroup: ${parts.join(', ')}. ` +
    `Agent spawns and any in-flight work in those processes died with it. Trigger: ${reason}. ` +
    `This is COLLATERAL, reported on the FIRST restart — it is NOT a restart-storm alert and does not ` +
    `mean the watchdog misfired. Root cause (cgroup-inherited spawns) is EI-19479764372783341.`
  );
}

/** Enumerate the unit's cgroup members. Fail-soft: null (UNKNOWN) on ANY fault — no cgroup path, an
 *  unreadable cgroup.procs, or a vanished /proc entry. Never throws; callers must treat null as "say
 *  nothing", never as "nothing was killed". */
export async function readCollateral(deps = {}) {
  const { sh: shImpl = sh, readFile = readFileSync, unit = UNIT } = deps;
  try {
    const r = await shImpl('systemctl', ['--user', 'show', unit, '-p', 'ControlGroup', '--value']);
    if (r.err) return null;
    const cg = String(r.stdout || '').trim();
    if (!cg || !cg.startsWith('/')) return null;
    const pids = parseCgroupProcs(readFile(`/sys/fs/cgroup${cg}/cgroup.procs`, 'utf8'));
    if (pids.length === 0) return null;
    const entries = [];
    for (const pid of pids) {
      try {
        // A pid that exits between the two reads is simply skipped — it is no longer collateral.
        entries.push({ pid, cmdline: String(readFile(`/proc/${pid}/cmdline`, 'utf8')).replace(/\0/g, ' ').trim() });
      } catch {
        /* process gone mid-scan */
      }
    }
    return classifyCollateral(entries);
  } catch {
    return null;
  }
}

/**
 * Keep this standalone list in parity with service-health.ts's BG_HOST_HOT_PATHS. The watchdog is a
 * plain external Node process and deliberately does not import operator-core TypeScript (doing so would
 * couple the last-resort watchdog's boot to the host it watches). The test suite compares the two lists
 * so this duplication cannot silently drift.
 */
export const BG_HOST_COMMITTED_HOT_PATHS = Object.freeze([
  'packages/operator-core/lib/dbos',
  'packages/operator-core/lib/harness/routines',
  'packages/operator-core/lib/harness/git-sync',
  'packages/operator-core/lib/events',
  'packages/operator-core/lib/agent-tools/loop',
  'packages/operator-core/lib/red-queen',
  'packages/operator-core/lib/release/routine-engine-liveness.ts',
]);
const BG_HOST_COMMITTED_HOT_PATH_SOURCE_PATHS = Object.freeze(
  BG_HOST_COMMITTED_HOT_PATHS.map((path) => path.endsWith('.ts') ? path : `:(glob)${path}/**/*.ts`),
);

/** Pathspec exclusions for the COMMITTED-change read only. A test-only commit does not change the
 * running host's behavior and therefore must not trigger a restart. The cleanliness read below is
 * intentionally stricter: ANY dirty/untracked file under a hot-path directory suppresses activation,
 * including a test file, because it proves a peer is still working in the restart-sensitive lane. */
const BG_HOST_COMMITTED_HOT_PATH_TEST_EXCLUSIONS = Object.freeze([
  ':(exclude,glob)**/*.test.ts',
  ':(exclude,glob)**/*.test.tsx',
  ':(exclude,glob)**/*.spec.ts',
  ':(exclude,glob)**/*.spec.tsx',
  ':(exclude,glob)**/__tests__/**',
]);

/** Pure, fail-closed committed-code activation verdict (EI-18133447445064828).
 *
 * A restart is allowed only when ALL evidence is positive:
 *  - the running generation age is known;
 *  - a committed, non-test hot-path change is newer than that generation;
 *  - every hot-path directory is clean, including untracked files; and
 *  - the cgroup snapshot is known and contains zero collateral processes.
 *
 * Unknown is never reinterpreted as safe. `code` is stable test/log vocabulary. */
export function evaluateCommittedHotPathActivation({
  activeForSec,
  latestCommitMs,
  nowMs,
  dirtyEntries,
  collateral,
}) {
  if (activeForSec == null || !Number.isFinite(activeForSec) || activeForSec < 0) {
    return { activate: false, code: 'generation_unknown' };
  }
  if (nowMs == null || !Number.isFinite(nowMs) || nowMs <= 0) {
    return { activate: false, code: 'clock_unknown' };
  }
  if (latestCommitMs == null || !Number.isFinite(latestCommitMs) || latestCommitMs <= 0) {
    return { activate: false, code: 'commit_unknown' };
  }
  // A future-dated commit is not trustworthy evidence about generation ordering. Fail closed rather
  // than turning workstation clock skew into a fleet-wide restart trigger.
  if (latestCommitMs > nowMs) {
    return { activate: false, code: 'commit_time_future' };
  }
  const bootMs = nowMs - activeForSec * 1000;
  if (!Number.isFinite(bootMs) || bootMs < 0) {
    return { activate: false, code: 'generation_unknown' };
  }
  if (latestCommitMs <= bootMs) {
    return { activate: false, code: 'generation_current', bootMs, latestCommitMs };
  }
  if (!Array.isArray(dirtyEntries)) {
    return { activate: false, code: 'cleanliness_unknown', bootMs, latestCommitMs };
  }
  if (dirtyEntries.length > 0) {
    return {
      activate: false,
      code: 'hot_paths_dirty',
      bootMs,
      latestCommitMs,
      dirtyCount: dirtyEntries.length,
      dirtySample: dirtyEntries.slice(0, 5),
    };
  }
  if (!collateral || !Number.isFinite(collateral.collateral) || collateral.collateral < 0) {
    return { activate: false, code: 'collateral_unknown', bootMs, latestCommitMs };
  }
  if (collateral.collateral !== 0) {
    return {
      activate: false,
      code: 'collateral_present',
      bootMs,
      latestCommitMs,
      collateral: collateral.collateral,
    };
  }
  return { activate: true, code: 'activate', bootMs, latestCommitMs };
}

/** Pure throttle/reentrancy verdict. A separate helper keeps the timing boundary falsifiable without
 * launching git, systemctl, or ptool from tests. */
export function shouldCheckCommittedHotPathActivation({ inFlight, lastCheckMs, nowMs, intervalMs }) {
  if (inFlight === true) return false;
  if (!Number.isFinite(nowMs) || !Number.isFinite(lastCheckMs) || !Number.isFinite(intervalMs)) return false;
  if (intervalMs < 0 || nowMs < lastCheckMs) return false;
  return lastCheckMs === 0 || nowMs - lastCheckMs >= intervalMs;
}

/** Read the newest committed NON-TEST hot-path change and the current hot-path dirtiness. Every read is
 * fail-closed: the caller receives null for the evidence it could not establish. */
export async function readCommittedHotPathState(deps = {}) {
  const shImpl = deps.sh ?? sh;
  let root = deps.root ?? process.env.PAPERCUSP_INTEGRATION_ROOT ?? null;
  if (!root) {
    const scriptDir = dirname(fileURLToPath(import.meta.url));
    const rootRead = await shImpl('git', ['-C', scriptDir, 'rev-parse', '--show-toplevel']);
    if (rootRead.err || !String(rootRead.stdout).trim()) {
      return { root: null, latestCommitMs: null, latestCommitHash: null, dirtyEntries: null, error: 'root_unknown' };
    }
    root = String(rootRead.stdout).trim();
  }

  const [commitRead, dirtyRead] = await Promise.all([
    shImpl('git', [
      '-C',
      root,
      'log',
      '-1',
      '--format=%ct%x00%H',
      '--',
      ...BG_HOST_COMMITTED_HOT_PATH_SOURCE_PATHS,
      ...BG_HOST_COMMITTED_HOT_PATH_TEST_EXCLUSIONS,
    ]),
    shImpl('git', [
      '-C',
      root,
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
      '--',
      ...BG_HOST_COMMITTED_HOT_PATHS,
    ]),
  ]);

  let latestCommitMs = null;
  let latestCommitHash = null;
  if (!commitRead.err) {
    const [epochSec, hash] = String(commitRead.stdout).trim().split('\0');
    const parsedMs = Number(epochSec) * 1000;
    if (Number.isFinite(parsedMs) && parsedMs > 0 && hash?.trim()) {
      latestCommitMs = parsedMs;
      latestCommitHash = hash.trim();
    }
  }
  const dirtyEntries = dirtyRead.err
    ? null
    : String(dirtyRead.stdout)
        .split('\0')
        .map((entry) => entry.trim())
        .filter(Boolean);
  return {
    root,
    latestCommitMs,
    latestCommitHash,
    dirtyEntries,
    error: commitRead.err ? 'commit_unknown' : dirtyRead.err ? 'cleanliness_unknown' : null,
  };
}

function parsePtoolJson(stdout) {
  const raw = String(stdout ?? '').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    // Defensive fallback for a launcher prelude: ptool itself currently emits one JSON line, but the
    // watchdog should not turn a harmless wrapper banner into an UNKNOWN restart outcome.
    const lines = raw.split('\n');
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      try {
        return JSON.parse(lines[i]);
      } catch {
        /* keep scanning */
      }
    }
    return null;
  }
}

/** EI-22089912517133068: seconds this lane WAITS for an in-flight git-sync to drain.
 *
 * `max_drain_sec` and `git_sync_drain_sec` are DIFFERENT arguments and only the first was being
 * passed. dev:restart refuses on `git_sync_collision_operation_in_flight` iff
 * `gitSyncPreflightBlocks(blocked, drainSec) === blocked && drainSec === 0`, so omitting this made
 * the refusal UNCONDITIONAL for the one target that can least afford it: the cgroup check is a
 * PROXY (EI-21930094737784126) and bg-host is itself the git-sync host, so `blocked` is true far
 * more often here than the workspace-wide barrier it stands in for is actually held.
 *
 * Measured over the durable watchdog log (2026-08-25..2026-09-02): 143 activation attempts, 48
 * refused on this exact code (33.6%), longest run 8 consecutive — ~40min in which committed
 * bg-host code did not activate. A fire holds the barrier only ~5-10s, so 20s is ~2x the hold
 * with margin while staying far under the 120s ceiling.
 *
 * Bounded by design: this delay is paid ONLY on the collision path (a free barrier proceeds at
 * once), and only on the 5-minute activation check — never on the 30s freeze poll. Worst case it
 * defers freeze detection by 20s against a 100s FREEZE_SILENCE_S threshold. */
const HOT_PATH_GIT_SYNC_DRAIN_SEC =
  Number(process.env.PAPERCUSP_BGHOST_WATCHDOG_HOT_PATH_GIT_SYNC_DRAIN_SEC) || 20;
/** Derived, never a second literal: the ptool budget must cover the drain we just asked it to wait
 *  out, or a drain that works still lands as `ptool_failed` — trading one refusal code for another. */
const HOT_PATH_PTOOL_TIMEOUT_MS = 30_000 + HOT_PATH_GIT_SYNC_DRAIN_SEC * 1_000;
/** `dev:restart` hands bg-host's detached systemd restart back as soon as it is scheduled. Keep the
 * activation result fail-closed until systemd exposes a different MainPID, otherwise `restarted:true`
 * can mean only that a child was spawned while the old generation continues serving stale code. */
const BG_HOST_RESTART_PID_WAIT_MS =
  Number(process.env.PAPERCUSP_BGHOST_WATCHDOG_RESTART_PID_WAIT_MS) || 30_000;
const BG_HOST_RESTART_PID_POLL_MS =
  Number(process.env.PAPERCUSP_BGHOST_WATCHDOG_RESTART_PID_POLL_MS) || 250;

/**
 * Verify the detached bg-host restart's postcondition. The restart tool returns the MainPID observed
 * BEFORE it spawned systemd; a changed MainPID is the only generation evidence this plain Node watchdog
 * can obtain without importing the TypeScript restart tool. Unknown or unchanged state is never treated
 * as success. The seams keep the bounded poll deterministic and hermetic in tests.
 */
export async function waitForBgHostRestartGeneration(beforePid, deps = {}) {
  const shImpl = deps.sh ?? sh;
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve_) => setTimeout(resolve_, ms)));
  const now = deps.now ?? Date.now;
  const waitMs = Number.isFinite(deps.waitMs) && deps.waitMs >= 0 ? deps.waitMs : BG_HOST_RESTART_PID_WAIT_MS;
  const pollMs = Number.isFinite(deps.pollMs) && deps.pollMs >= 0 ? deps.pollMs : BG_HOST_RESTART_PID_POLL_MS;
  const baseline = Number(beforePid);
  if (!Number.isInteger(baseline) || baseline <= 0) {
    return { verified: false, beforePid: null, observedPid: null, waitedMs: 0, code: 'baseline_unknown' };
  }

  const startedAtMs = now();
  let observedPid = null;
  while (now() - startedAtMs <= waitMs) {
    try {
      const result = await shImpl(
        'systemctl',
        ['--user', 'show', UNIT, '-p', 'MainPID', '--value'],
        { timeout: 3_000 },
      );
      if (!result.err) {
        const pid = Number(String(result.stdout ?? '').trim());
        observedPid = Number.isInteger(pid) && pid > 0 ? pid : null;
      }
    } catch {
      observedPid = null;
    }
    if (observedPid !== null && observedPid !== baseline) {
      return {
        verified: true,
        beforePid: baseline,
        observedPid,
        waitedMs: Math.max(0, now() - startedAtMs),
        code: 'generation_changed',
      };
    }
    const remainingMs = waitMs - (now() - startedAtMs);
    if (remainingMs <= 0) break;
    await sleep(Math.min(pollMs, remainingMs));
  }
  return {
    verified: false,
    beforePid: baseline,
    observedPid,
    waitedMs: Math.max(0, now() - startedAtMs),
    code: observedPid === null ? 'generation_unknown' : 'generation_unchanged',
  };
}

/** Invoke the EXISTING coordinated restart tool, never raw systemctl, for committed-code activation.
 * The wrapper owns boot-integrity, green-gate collision, exclusive-resource drain, audit, and the ~13m
 * bg-host cooldown/coalescing rail. max_drain_sec:0 still makes this automatic lane refuse immediately
 * rather than wait out a live EXCLUSIVE-RESOURCE holder's consequential work; git_sync_drain_sec is the
 * separate, deliberately-bounded wait for a git-sync fire, which is 5-10s of routine sweeping and is
 * the supported way through a merely BUSY host (override_git_sync_collision is NOT — it SIGKILLs a
 * commit mid-flight and strands a peer's uncommitted work, so this lane must never reach for it). */
export async function requestCommittedHotPathRestart(latestCommitHash, deps = {}) {
  const shImpl = deps.sh ?? sh;
  const ptoolScript = deps.ptoolScript ?? join(dirname(fileURLToPath(import.meta.url)), 'ptool.mjs');
  const shortHash = String(latestCommitHash ?? 'unknown').slice(0, 12);
  const args = {
    target: 'bg-host',
    confirm: true,
    authorize: true,
    max_drain_sec: 0,
    git_sync_drain_sec: HOT_PATH_GIT_SYNC_DRAIN_SEC,
    reason: `auto-activate committed bg-host hot-path ${shortHash}; clean tree and zero cgroup collateral`,
  };
  const run = await shImpl(process.execPath, [ptoolScript, 'dev:restart', '--json', '-'], {
    stdin: JSON.stringify(args),
    timeout: HOT_PATH_PTOOL_TIMEOUT_MS,
  });
  if (run.err) {
    return { ok: false, restarted: false, coalesced: false, code: 'ptool_failed', error: run.err.message };
  }
  const body = parsePtoolJson(run.stdout);
  if (!body || body.ok !== true) {
    return {
      ok: false,
      restarted: false,
      coalesced: false,
      code: body?.reason ?? 'ptool_result_unknown',
      body,
    };
  }
  if (body.restarted === true) {
    let verification;
    try {
      const verifyGeneration =
        deps.verifyGeneration ?? ((beforePid) => waitForBgHostRestartGeneration(beforePid, { sh: shImpl }));
      verification = await verifyGeneration(body.restartedFromPid);
    } catch (error) {
      return {
        ok: false,
        restarted: false,
        coalesced: false,
        code: 'restart_verification_failed',
        body,
        verificationError: error instanceof Error ? error.message : String(error),
      };
    }
    if (!verification?.verified) {
      return {
        ok: false,
        restarted: false,
        coalesced: false,
        code: 'restart_unverified',
        body,
        verification,
      };
    }
  }
  return {
    ok: true,
    restarted: body.restarted === true,
    coalesced: body.coalesced === true,
    verified: body.verified,
    code: body.restarted === true ? 'restarted' : body.coalesced === true ? 'coalesced' : 'no_restart',
    body,
  };
}

async function maybeActivateCommittedHotPathCode() {
  const checkStartedAtMs = Date.now();
  if (
    !shouldCheckCommittedHotPathActivation({
      inFlight: hotPathActivationCheckInFlight,
      lastCheckMs: lastHotPathActivationCheckMs,
      nowMs: checkStartedAtMs,
      intervalMs: HOT_PATH_ACTIVATION_CHECK_MS,
    })
  ) {
    return { restartRequested: false, code: 'throttled_or_in_flight' };
  }
  hotPathActivationCheckInFlight = true;
  lastHotPathActivationCheckMs = checkStartedAtMs;
  try {
    const [activeForSec, state] = await Promise.all([
      unitActiveForSec(),
      readCommittedHotPathState(),
    ]);
    // `activeForSec` may have been sampled before the git reads completed. Pairing it with a clock read
    // AFTER both probes moves the inferred boot time later, which is conservative: a borderline change
    // may wait for the next pass, but probe latency can never make an old commit look newer than boot.
    const evidenceNowMs = Date.now();
    // Avoid the cgroup scan unless generation ordering + tree cleanliness already say a restart could
    // be safe. Passing null first makes the pure verdict tell us whether collateral is the only missing
    // proof; every other failure exits without touching /proc.
    let verdict = evaluateCommittedHotPathActivation({
      activeForSec,
      latestCommitMs: state.latestCommitMs,
      nowMs: evidenceNowMs,
      dirtyEntries: state.dirtyEntries,
      collateral: null,
    });
    if (verdict.code === 'collateral_unknown') {
      const collateral = await readCollateral();
      verdict = evaluateCommittedHotPathActivation({
        activeForSec,
        latestCommitMs: state.latestCommitMs,
        nowMs: evidenceNowMs,
        dirtyEntries: state.dirtyEntries,
        collateral,
      });
    }

    // Log only a NEW actionable/suppressed state. A current generation is ordinary and silent; a
    // dirty/collateral suppression is important, but repeating it every 5m adds no information.
    const decisionKey = `${state.latestCommitHash ?? 'unknown'}:${verdict.code}:${verdict.dirtyCount ?? ''}:${verdict.collateral ?? ''}`;
    if (
      verdict.code !== 'generation_current' &&
      decisionKey !== lastHotPathActivationDecisionKey
    ) {
      lastHotPathActivationDecisionKey = decisionKey;
      const dirty = verdict.dirtySample?.length
        ? ` dirty=${verdict.dirtySample.join(' | ')}`
        : '';
      const collateral =
        verdict.collateral == null ? '' : ` collateral=${verdict.collateral}`;
      log(
        `committed hot-path activation ${verdict.activate ? 'READY' : 'SUPPRESSED'} (${verdict.code})` +
          ` commit=${state.latestCommitHash?.slice(0, 12) ?? 'UNKNOWN'}${dirty}${collateral}`,
      );
    }
    if (!verdict.activate) return { restartRequested: false, code: verdict.code };

    const outcome = await requestCommittedHotPathRestart(state.latestCommitHash);
    log(
      outcome.ok
        ? `committed hot-path activation via dev:restart: ${outcome.code} (commit ${state.latestCommitHash?.slice(0, 12)})`
        : `committed hot-path activation REFUSED/FAILED by dev:restart (${outcome.code}) — freeze monitoring continues`,
    );
    return { restartRequested: outcome.restarted === true, code: outcome.code };
  } catch (e) {
    log(`committed hot-path activation probe FAILED CLOSED: ${e instanceof Error ? e.message : String(e)}`);
    return { restartRequested: false, code: 'probe_failed' };
  } finally {
    hotPathActivationCheckInFlight = false;
  }
}

/**
 * Best-effort, fail-soft broadcast to every running agent (WI-3630) — the durable log file (LOG_FILE) is
 * journald-independent but nobody actively tails it (the EI-2434 precedent: a real freeze-storm sat
 * invisible for 44h). Writes DIRECTLY into `harness_shared.coord_event_log` — the same table
 * `coord:send`/`severe-event-broadcast.ts` write (verified shape: surface='messages', body is the
 * CoordEnvelope JSON `sendMessage` builds) — so it surfaces in every agent's `coord:inbox` on their next
 * turn via the EXISTING `coord_event_log_notify_trg` pg_notify wake rail, with zero new infrastructure.
 * Uses psql `-v` bind-variables (never raw string interpolation) so the JSON payload is always safely
 * quoted. Never throws — a broadcast failure must not affect the restart decision it accompanies.
 */
export async function alertFleet(summary, deps = {}) {
  const { sh: shImpl = sh, log: logImpl = log } = deps;
  try {
    // `dbUrl` is only used when the CALLER explicitly passes the key (even as null/'') — tests inject a
    // fixed value (including null, to exercise the "unresolvable" path) without touching the real
    // systemctl/psql resolution; production calls (no `deps`) always fall back to resolveDbUrlAsync().
    const url = Object.prototype.hasOwnProperty.call(deps, 'dbUrl') ? deps.dbUrl : await resolveDbUrlAsync();
    if (!url) {
      logImpl('alertFleet SKIPPED (no DB url resolvable)');
      return false;
    }
    const msgId = `bghost-watchdog-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const body = JSON.stringify({
      ts: new Date().toISOString(),
      msg_id: msgId,
      from: 'system-watchdog',
      to: ['*'],
      kind: 'message',
      summary,
      category: 'severe-event',
    });
    const sql =
      "INSERT INTO harness_shared.coord_event_log (id, workspace_id, surface, writer_key, msg_id, body) " +
      "VALUES (nextval('harness_shared.coord_event_log_id_seq'), 'default', 'messages', 'bghost-watchdog', :'msgid', :'jsonbody'::jsonb)";
    // EI-9419 (2026-07-10 outage postmortem): the SQL MUST go via stdin, never `-c`. psql does
    // NOT interpolate -v variables inside -c command strings — :'msgid'/:'jsonbody' reached the
    // server literally ("syntax error at or near :"), so every alert since WI-3630 landed failed
    // silently and the 63-min DBOS outage went fleet-unalerted. -X skips psqlrc so no user config
    // can alter interpolation; stdin keeps the bind-variable design (no hand-rolled escaping).
    const r = await shImpl('psql', [url, '-X', '-v', `msgid=${msgId}`, '-v', `jsonbody=${body}`, '-f', '-'], { stdin: sql });
    if (r.err) {
      const stderrNote = r.stderr && r.stderr.trim() ? ` | stderr: ${r.stderr.trim()}` : '';
      logImpl(`alertFleet FAILED (non-fatal): ${r.err.message}${stderrNote}`);
      return false;
    }
    return true;
  } catch (e) {
    logImpl(`alertFleet FAILED (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

function hostPressureSnapshot() {
  const cores = Math.max(1, cpus().length || 1);
  const load1 = loadavg()[0] || 0;
  const availableBytes = freemem();
  const totalBytes = totalmem();
  const loadPerCore = load1 / cores;
  const availableRatio = totalBytes > 0 ? availableBytes / totalBytes : 0;
  return {
    cores,
    load1,
    loadPerCore,
    availableRatio,
    hasHeadroom: loadPerCore < 0.85 && availableRatio > 0.10,
  };
}

export function circuitOpenMessage(reason, restartCount, cap, snapshot = hostPressureSnapshot()) {
  const host = snapshot
    ? ` Host snapshot: load1 ${snapshot.load1.toFixed(2)}/${snapshot.cores} cores (${snapshot.loadPerCore.toFixed(2)}/core), memory available ${Math.round(snapshot.availableRatio * 100)}%.`
    : '';
  const diagnosis = snapshot?.hasHeadroom
    ? 'Host has headroom; treat this as a bg-host ticker/event-loop/DBOS stall, not a fleet-wide load problem.'
    : 'Host pressure may be contributing; verify CPU/memory before shedding fleet load.';
  return `CIRCUIT OPEN: ${restartCount} restarts in the last hour >= cap ${cap} — NOT restarting (${reason}).${host} ${diagnosis} Investigate papercusp-bg-host internals; do not use blanket load reduction as the remediation.`;
}

/** Read DATABASE_URL out of a process's /proc/<pid>/environ (same-user readable). The bg-host's ACTUAL
 *  running value — robust against .env.local not defining it literally (it doesn't on this box). */
function readProcEnvUrl(pid, readFile = readFileSync) {
  try {
    for (const kv of readFile(`/proc/${pid}/environ`, 'utf8').split('\0')) {
      if (kv.startsWith('DATABASE_URL=')) return kv.slice('DATABASE_URL='.length);
    }
  } catch {
    /* not readable / process gone */
  }
  return null;
}

/** Async DB-URL resolution: sync sources (override / env / .env.local) first, then the ROBUST fallback —
 *  the bg-host unit's own running DATABASE_URL via its /proc environ. Returns null if all fail (→ UNKNOWN). */
async function resolveDbUrlAsync() {
  const direct = resolveDbUrl();
  if (direct) return direct;
  const r = await sh('systemctl', ['--user', 'show', UNIT, '-p', 'MainPID', '--value']);
  const pid = Number(r.stdout.trim());
  return Number.isFinite(pid) && pid > 0 ? readProcEnvUrl(pid) : null;
}

/** Newest routine fire age (seconds) from Postgres — the bg-host's true liveness. null on any read fault. */
async function routineIdleSec(dbUrl) {
  if (!dbUrl) return null;
  const q =
    'SELECT EXTRACT(EPOCH FROM (now() - MAX(last_fired_at)))::int ' +
    'FROM harness_shared.routines WHERE active = true AND last_fired_at IS NOT NULL';
  const r = await sh('psql', [dbUrl, '-tAqc', q]);
  if (r.err) return null;
  return parseIdleSec(r.stdout);
}

/** Newest `routinesTick` SCHEDULER execution age (seconds) — the TRUE ticker-liveness signal, independent of
 *  `routines`-fire-queue saturation (the tick is a scheduled workflow, NOT enqueued on the saturable queue).
 *  A fresh tick while routine fires are stale = a busy/saturated queue, not a frozen event loop. null on any
 *  read fault ⇒ UNKNOWN (shouldRestart falls back to the documented fire-staleness behavior). */
async function schedulerIdleSec(dbUrl) {
  if (!dbUrl) return null;
  const q =
    "SELECT EXTRACT(EPOCH FROM (now() - to_timestamp(MAX(created_at)/1000.0)))::int " +
    "FROM dbos.workflow_status WHERE name = 'routinesTick'";
  const r = await sh('psql', [dbUrl, '-tAqc', q]);
  if (r.err) return null;
  return parseIdleSec(r.stdout);
}

/** Newest durable critical pool-shed event age (seconds) — `harness_shared.routine_pool_shed_events`,
 *  written by THIS unit's routinesTickImpl (pool-pressure.ts's `recordPoolShedEvent`, migration 627) the
 *  instant a tick sheds under critical PG-pool starvation. null on any read fault OR when no shed event
 *  has EVER been recorded ⇒ UNKNOWN (never explains a freeze on a broken/absent signal — see
 *  `poolShedExplainsFreeze`). Unscoped by workspace, matching `routineIdleSec`/`schedulerIdleSec` above —
 *  this is a THIS-HOST liveness signal, not a per-tenant one. */
async function poolShedIdleSec(dbUrl) {
  if (!dbUrl) return null;
  const q = 'SELECT EXTRACT(EPOCH FROM (now() - MAX(at)))::int FROM harness_shared.routine_pool_shed_events';
  const r = await sh('psql', [dbUrl, '-tAqc', q]);
  if (r.err) return null;
  return parseIdleSec(r.stdout);
}

/** Pure (WI-37506): does a recent durable pool-shed guardrail event EXPLAIN an apparent freeze, rather
 *  than the ticker actually being dead? True when the most recent recorded shed landed within the
 *  observed freeze window (`idleSec`) plus `graceSec` slack. UNKNOWN(null) `shedIdleSec` NEVER
 *  explains — mirrors `isFrozen`'s null-is-never-frozen asymmetry: absence of a clean shed signal must
 *  never suppress a restart that would otherwise be correct. */
export function poolShedExplainsFreeze(idleSec, shedIdleSec, graceSec = POOL_SHED_GRACE_S) {
  if (shedIdleSec == null) return false;
  return shedIdleSec <= (idleSec ?? 0) + graceSec;
}

/** Does the host answer its own zero-dependency liveness endpoint RIGHT NOW (EI-20025430746362695)?
 *
 *  `true` = a response arrived, so the event loop turned — the ONLY positive evidence that a
 *  shed-suppressed host is alive rather than wedged. Any HTTP status counts: a 500 still proves the
 *  process is serving, and this is a liveness probe, not a health grade.
 *  `false` = the probe completed and the host did not answer (timeout / connection refused) — the
 *  wedged case that ran for 53 minutes crediting "shedding, not dead".
 *  `null` = UNKNOWN, the probe itself could not be performed (no fetch, malformed URL).
 *
 *  Never throws. Callers must treat null and false ALIKE (decline to suppress) — see
 *  `poolShedSuppressionHolds`. */
export async function probeHostLiveness(url = BGHOST_HEALTH_URL, timeoutMs = BGHOST_HEALTH_TIMEOUT_MS, deps = {}) {
  const doFetch = deps.fetch ?? globalThis.fetch;
  if (typeof doFetch !== 'function') return { alive: null, why: 'no fetch implementation available' };
  let signal;
  try {
    signal = AbortSignal.timeout(timeoutMs);
  } catch {
    signal = undefined;
  }
  try {
    const res = await doFetch(url, { signal, method: 'GET' });
    const status = typeof res?.status === 'number' ? res.status : 'unknown';
    return { alive: true, why: `answered HTTP ${status} within ${timeoutMs}ms` };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // A TypeError from fetch here means the URL/agent is unusable (config fault), not that the host is
    // wedged — report UNKNOWN so the log does not accuse a host we never actually reached. The DECISION
    // is identical either way; only the diagnosis differs, and a wrong diagnosis is what costs the hours.
    if (e instanceof TypeError) return { alive: null, why: `probe unusable: ${msg}` };
    return { alive: false, why: `no response within ${timeoutMs}ms (${msg})` };
  }
}

/** Pure (EI-20025430746362695): may the pool-shed explanation SUPPRESS a restart on this pass?
 *
 *  The original suppression asked one question — "was there a recent shed event?" — and answered
 *  "don't restart" indefinitely. It had no way to tell alive-but-shedding (the case it was built for,
 *  WI-37506) from wedged, and no bound, so it excused a genuinely dead ticker for ~53min while git-sync
 *  and every routine were dead fleet-wide.
 *
 *  Three conditions now, ALL required:
 *   - a recent shed event explains the staleness (`shedExplains`), and
 *   - the host gave POSITIVE evidence of life (`hostAlive === true`). null/false both decline: the same
 *     never-suppress-on-a-missing-signal asymmetry as `isFrozen` / `withinBootGrace` /
 *     `saturationExtendsGrace`. Getting this wrong costs an outage; an unnecessary restart is cheap.
 *   - the suppression has not already run past `maxSuppressSec`. An UNKNOWN duration does not consume
 *     the budget, but it cannot extend it either — a bound you cannot measure is not a bound, so an
 *     unmeasurable duration declines rather than suppressing forever. */
export function poolShedSuppressionHolds(
  shedExplains,
  hostAlive,
  suppressedForSec,
  maxSuppressSec = POOL_SHED_MAX_SUPPRESS_S,
) {
  if (shedExplains !== true) return false;
  if (hostAlive !== true) return false;
  if (suppressedForSec == null || !Number.isFinite(suppressedForSec) || suppressedForSec < 0) return false;
  return suppressedForSec < maxSuppressSec;
}

/** @param collateral snapshot from `readCollateral()` taken BEFORE the restart is issued (the cgroup is
 *  torn down by the restart, so it cannot be read afterwards); null = UNKNOWN, report nothing. */
function restart(reason, collateral = null) {
  const now = Date.now();
  // WI-3630: the debounce before the NEXT restart backs off exponentially with each consecutive strike
  // (never killed on the same fixed 5min clock through a slower-than-anticipated boot).
  const debounceMs = nextDebounceMs(DEBOUNCE_MS, consecutiveRestarts);
  if (now - lastRestart < debounceMs) {
    log(`SUPPRESS (backoff ${Math.round((debounceMs - (now - lastRestart)) / 1000)}s left, consecutive strike #${consecutiveRestarts}): ${reason}`);
    return;
  }
  while (restartTimes.length && now - restartTimes[0] > 3_600_000) restartTimes.shift();
  if (restartTimes.length >= MAX_RESTARTS_PER_HR) {
    const msg = circuitOpenMessage(reason, restartTimes.length, MAX_RESTARTS_PER_HR);
    log(msg);
    void alertFleet(`⚠ ${UNIT} watchdog CIRCUIT OPEN — ${restartTimes.length} restarts in the last hour, capped. ${msg}`);
    return;
  }
  lastRestart = now;
  restartTimes.push(now);
  consecutiveRestarts += 1;
  const nextBackoffS = Math.round(nextDebounceMs(DEBOUNCE_MS, consecutiveRestarts) / 1000);
  log(`FROZEN -> restarting ${UNIT} (consecutive strike #${consecutiveRestarts}, next backoff ${nextBackoffS}s): ${reason}`);
  if (shouldAlert(consecutiveRestarts)) {
    void alertFleet(
      `⚠ ${UNIT} restarted ${consecutiveRestarts}x in a row (possible restart-storm) — ${reason}. ` +
        `Next restart backed off ${nextBackoffS}s; hard circuit breaker at ${MAX_RESTARTS_PER_HR}/hr. Investigate before it trips.`,
    );
  }
  // EI-19485006080051257: report COLLATERAL on the FIRST restart, independent of the storm threshold
  // above. `shouldAlert` answers "is a storm developing?"; this answers "did we just destroy something
  // that was not ours?" — the ordinary one-restart-and-recover case can never reach the storm threshold
  // (consecutiveRestarts resets on the next healthy poll), which is exactly why this must not share it.
  // A null snapshot is UNKNOWN and stays silent — never infer destruction from a missing signal.
  const collateralMsg = collateralAlertMessage(UNIT, collateral, reason);
  if (collateralMsg) {
    log(collateralMsg);
    void alertFleet(collateralMsg);
  }
  execFile('systemctl', ['--user', 'restart', UNIT], (err) => log(err ? `restart FAILED: ${err.message}` : 'restart issued OK'));
}

async function poll() {
  const act = await sh('systemctl', ['--user', 'is-active', UNIT]);
  if (act.stdout.trim() !== 'active') {
    // not active → a crash; Restart=always handles that. Don't interfere.
    return;
  }
  // EI-22091522428797790. WI-2140796 established a declaration/refusal/force contract for a
  // DELIBERATE bg-host quiesce: a P-101 clean-seed re-cut opens the hyperbee corestore that bg-host
  // fd-locks, so it stops the unit for ~3h and a restart during that window produces repeated
  // boot_fail. `dev:restart` honours that contract (bg-host-quiesce-guard.ts); this watchdog did
  // not, so the contract had only two of its three named parties.
  //
  // The cut STOPPING the unit is already handled by the is-active return above. What this closes is
  // the residual window where the unit is still ACTIVE while a cut is declared: the ticker
  // legitimately stops advancing, which reads here as a freeze and would fire an actuation that
  // fights the cut. Same fail-soft rule as every other signal in this file — a declared quiesce
  // SKIPS the judgment; it never concludes frozen, and an absent/unreadable marker (the normal
  // case) never disables the watchdog.
  const quiesce = seedCutQuiesce();
  if (quiesce) {
    log(`seed-cut quiesce DECLARED (${quiesce}) — skipping freeze judgment (not concluding frozen)`);
    return;
  }
  // EI-18133447445064828: activation is independent of freeze recovery. A HEALTHY bg-host can run
  // stale committed routine code indefinitely, so check it before the PG freshness path. The helper is
  // internally throttled + reentrancy-guarded and can only request a coordinated restart after the
  // fail-closed generation/commit/cleanliness/collateral verdict passes.
  const activation = await maybeActivateCommittedHotPathCode();
  if (activation.restartRequested) return;
  const dbUrl = await resolveDbUrlAsync();
  const idleSec = await routineIdleSec(dbUrl);
  if (idleSec == null) {
    // Liveness UNKNOWN (psql/DB unreadable) — NEVER conclude frozen from a missing signal (that was the
    // EI-2434 false-restart bug). Skip this poll.
    log(`routine-freshness UNKNOWN (psql/DB unreadable) — skipping (not concluding frozen)`);
    return;
  }
  if (isFrozen(idleSec)) {
    // WI-37501: ANY stale-idleSec observation breaks a healthy streak in progress — see shouldClearStrikes.
    healthyStreak = 0;
    // BOOT GRACE (EI-8901): the staleness signal SPANS restarts (it's the last tick's age, from PG) — a
    // freshly-restarted unit that hasn't ticked yet still reads as frozen. Check this FIRST, before the
    // saturation corroboration below, because right after a restart BOTH signals (routine fires AND the
    // routinesTick scheduler) are still stale from the previous generation — corroborating wouldn't help;
    // only the passage of boot time does.
    const activeForSec = await unitActiveForSec();
    if (withinBootGrace(activeForSec)) {
      const now = Date.now();
      if (now - lastHeartbeat >= HEARTBEAT_MS) {
        lastHeartbeat = now;
        log(`within boot grace (unit active ${Math.round(activeForSec)}s < ${Math.round(BOOT_GRACE_MS / 1000)}s) — routine staleness (${idleSec}s) spans the restart, not a fresh freeze. NOT restarting.`);
      }
      return;
    }
    // Routine fires are stale — but corroborate with the SCHEDULER before restarting (2026-06-23 fix). A
    // SATURATED routines fire-queue (legit long routines holding every slot) stalls fires WITHOUT a frozen
    // event loop; restarting then kills them mid-run + re-saturates → the 5-min restart LOOP that froze
    // git-sync + deploys for hours. Only restart if the scheduler (routinesTick) is ALSO stale.
    const schedSec = await schedulerIdleSec(dbUrl);
    if (!shouldRestart(idleSec, schedSec)) {
      const now = Date.now();
      if (now - lastHeartbeat >= HEARTBEAT_MS) {
        lastHeartbeat = now;
        log(`fire-queue SATURATED, not frozen — routine last_fired_at ${idleSec}s stale BUT scheduler (routinesTick) fired ${schedSec}s ago (event loop alive). NOT restarting (would kill in-flight long routines + re-saturate).`);
      }
      return;
    }
    // WI-37506: both signals are stale — before concluding a genuine freeze, check whether a durable
    // pool-shed guardrail event explains it (dbos.workflow_status, which BOTH signals above read, lives
    // on the same pool that a critical shed reports on, so a genuine starvation event can stale BOTH
    // signals without the ticker being dead — see the file-header WI-37506 note).
    const shedIdleSec = await poolShedIdleSec(dbUrl);
    if (poolShedExplainsFreeze(idleSec, shedIdleSec)) {
      const nowMs = Date.now();
      // A gap of >3 polls means the previous streak ended (host recovered, or another branch handled the
      // pass) — start a fresh bound rather than inheriting an old one.
      if (poolShedSuppressSinceMs == null || nowMs - poolShedSuppressLastAtMs > POLL_MS * 3) {
        poolShedSuppressSinceMs = nowMs;
        poolShedSuppressPasses = 0;
        poolShedAlerted = false;
      }
      const suppressedForSec = Math.round((nowMs - poolShedSuppressSinceMs) / 1000);
      // EI-20025430746362695: the shed event alone is NOT evidence the ticker is alive. Ask the host
      // directly, on an endpoint pool starvation cannot hang.
      const liveness = await probeHostLiveness();
      if (poolShedSuppressionHolds(true, liveness.alive, suppressedForSec)) {
        poolShedSuppressPasses += 1;
        poolShedSuppressLastAtMs = nowMs;
        if (nowMs - lastHeartbeat >= HEARTBEAT_MS) {
          lastHeartbeat = nowMs;
          log(`explained by a critical PG-pool-shed guardrail event ${shedIdleSec}s ago (EI-9935/P-006/W4) — routine fires ${idleSec}s stale AND scheduler ${schedSec == null ? 'UNKNOWN' : `${schedSec}s`} stale, but the host ANSWERS ${BGHOST_HEALTH_URL} (${liveness.why}), so the ticker is SHEDDING under pool starvation, not dead. NOT restarting (WI-37506) — suppression held ${suppressedForSec}s of ${POOL_SHED_MAX_SUPPRESS_S}s max, ${poolShedSuppressPasses} passes.`);
        }
        // Visible, not just logged: the outage ran ~53min in silence because nothing escalated.
        if (!poolShedAlerted && suppressedForSec >= POOL_SHED_ALERT_AFTER_S) {
          poolShedAlerted = true;
          const msg =
            `⚠ ${UNIT}: the PG-pool-shed suppression has held for ${suppressedForSec}s (${poolShedSuppressPasses} passes) — routine fires ${idleSec}s stale. ` +
            `The host IS answering ${BGHOST_HEALTH_URL}, so this is still judged shed-not-dead and NO restart has been issued, but a shed this long is its own problem ` +
            `(EI-9935/P-006/W4 pool starvation). Hard bound: restarting anyway at ${POOL_SHED_MAX_SUPPRESS_S}s (EI-20025430746362695).`;
          log(msg);
          void alertFleet(msg);
        }
        return;
      }
      // The suppression DID NOT hold. Name which condition failed — the whole defect was a suppression
      // that could only ever say "not restarting", so the declining path must be at least as loud.
      const why =
        liveness.alive !== true
          ? `the host did NOT answer ${BGHOST_HEALTH_URL} (${liveness.why}) — "shedding, not dead" was never checked against the host itself, and that is exactly how a wedged ticker was excused for ~53min`
          : `the suppression hit its ${POOL_SHED_MAX_SUPPRESS_S}s hard bound (held ${suppressedForSec}s across ${poolShedSuppressPasses} passes)`;
      const msg =
        `⚠ ${UNIT}: pool-shed suppression DECLINED — a shed event ${shedIdleSec}s ago would have explained the freeze, but ${why}. ` +
        `Restarting (EI-20025430746362695).`;
      log(msg);
      void alertFleet(msg);
      poolShedSuppressSinceMs = null;
      poolShedSuppressPasses = 0;
      poolShedAlerted = false;
    }
    // EI-20029519971967372: LAST suppression before the kill — is this process still WORKING? Both PG
    // signals go silent for a saturated process exactly as they do for a dead one, so ask /proc instead:
    // a two-sample CPU delta over the unit's whole process tree. Placed here (rather than beside the
    // plain boot-grace check) so the sample is only paid when we were otherwise about to restart.
    // Bounded by SATURATION_MAX_SUPPRESS_S of CONTINUOUS suppression — past that we kill anyway, loudly,
    // because an unbounded suppression is how the sibling pool-shed guardrail became a 53min outage
    // (EI-20025430746362695). EI-20051589102188691: that bound used to be the unit's AGE, which silently
    // switched this whole suppression off 45min into every host's life — see the header note.
    const progressTicks = await bootProgressTicks();
    const satNowMs = Date.now();
    // Start a fresh streak when there isn't one, or when the last suppressed pass is old enough that the
    // streak is broken (a healthy poll leaves exactly that gap — see the state declaration).
    if (saturationSuppressSinceMs == null || satNowMs - saturationSuppressLastAtMs > POLL_MS * 3) {
      saturationSuppressSinceMs = satNowMs;
      saturationSuppressPasses = 0;
      saturationAlerted = false;
    }
    const satSuppressedForSec = Math.round((satNowMs - saturationSuppressSinceMs) / 1000);
    if (saturationExtendsGrace(activeForSec, progressTicks, satSuppressedForSec)) {
      saturationSuppressPasses += 1;
      saturationSuppressLastAtMs = satNowMs;
      if (satNowMs - lastHeartbeat >= HEARTBEAT_MS) {
        lastHeartbeat = satNowMs;
        log(
          `SATURATED, not frozen (unit active ${Math.round(activeForSec)}s — NOTE: uptime, which says nothing about whether boot finished) — ` +
            `process tree burned ${progressTicks} CPU ticks in ${Math.round(BOOT_PROGRESS_SAMPLE_MS / 1000)}s (>= ${BOOT_PROGRESS_MIN_TICKS}), so routine fires ${idleSec}s stale AND scheduler ${schedSec == null ? 'UNKNOWN' : `${schedSec}s`} stale is CPU SATURATION, not a freeze. ` +
            `NOT restarting (EI-20029519971967372) — suppression held ${satSuppressedForSec}s of ${SATURATION_MAX_SUPPRESS_S}s max across ${saturationSuppressPasses} passes; any routine firing resets that clock (EI-20051589102188691).`,
        );
      }
      // Visible, not just logged, once a suppression stops being brief — mirrors the pool-shed alarm.
      if (!saturationAlerted && satSuppressedForSec >= SATURATION_ALERT_AFTER_S) {
        saturationAlerted = true;
        const msg =
          `⚠ ${UNIT}: CPU-saturation suppression has held for ${satSuppressedForSec}s (${saturationSuppressPasses} passes) — routine fires ${idleSec}s stale while the process tree burns ` +
          `${progressTicks} ticks/${Math.round(BOOT_PROGRESS_SAMPLE_MS / 1000)}s. Judged saturated-not-dead so NO restart has been issued, but a host working this long without firing a routine is its own problem. ` +
          `Hard bound: restarting anyway at ${SATURATION_MAX_SUPPRESS_S}s (EI-20051589102188691).`;
        log(msg);
        void alertFleet(msg);
      }
      return;
    }
    // The suppression DID NOT hold. Name which condition failed — a suppression that can only ever say
    // "not restarting" is how the sibling guardrail hid a 53min outage, so the declining path must be at
    // least as loud. Only speak when there was actually CPU evidence to overrule; a genuinely idle tree
    // is the ordinary freeze the restart line below already explains.
    if (progressTicks != null && progressTicks >= BOOT_PROGRESS_MIN_TICKS) {
      const why =
        satSuppressedForSec >= SATURATION_MAX_SUPPRESS_S
          ? `the suppression hit its ${SATURATION_MAX_SUPPRESS_S}s hard bound (held ${satSuppressedForSec}s across ${saturationSuppressPasses} passes without a single routine firing)`
          : `the unit is still inside its ${Math.round(BOOT_GRACE_MS / 1000)}s plain boot grace, or its active-for age is unreadable`;
      const msg =
        `⚠ ${UNIT}: CPU-saturation suppression DECLINED and we are about to kill a process that is demonstrably working ` +
        `(${progressTicks} ticks/${Math.round(BOOT_PROGRESS_SAMPLE_MS / 1000)}s, ${Math.round(activeForSec ?? -1)}s active) because ${why}. ` +
        `Restarting anyway (bounded suppression, EI-20029519971967372/EI-20051589102188691).`;
      log(msg);
      void alertFleet(msg);
    }
    saturationSuppressSinceMs = null;
    saturationSuppressPasses = 0;
    saturationAlerted = false;
    // Snapshot the cgroup BEFORE restarting — the restart tears it down, so this is unreadable after.
    // Fail-soft (null ⇒ report nothing) and deliberately off the decision path: `restart()` is called
    // with whatever this returns, including null, so a collateral-read fault can never suppress a
    // genuine freeze recovery.
    const collateral = await readCollateral();
    restart(
      `${UNIT} routine fires ${idleSec}s stale AND scheduler (routinesTick) ${schedSec == null ? 'UNKNOWN' : `${schedSec}s`} ago (> ${FREEZE_SILENCE_S}s) while active — ticker genuinely frozen (PG-confirmed, journald-independent)`,
      collateral,
    );
    return;
  }
  // Healthy. WI-37501: a SINGLE healthy poll is not proof the storm is over — a stalled process can fire
  // exactly one routine early in boot and then stall again (the observed failure this replaces). Only
  // once the ticker has been healthy for SUSTAINED_HEALTHY_POLLS polls IN A ROW do we reset the
  // consecutive-strike counter, so a LATER, unrelated freeze starts its backoff from the base debounce —
  // not wherever a past storm left off, and not before the past storm is actually confirmed over.
  healthyStreak += 1;
  // EI-20051589102188691: a routine FIRING is the outcome the saturation suppression was waiting for, so
  // it clears that suppression's bound immediately and explicitly. The GAP mechanism alone would not do
  // it: at POLL_MS=30s a single healthy poll between two suppressed passes leaves a ~60s gap, under the
  // POLL_MS*3 staleness window, so the streak would carry across a recovery and the host would inherit a
  // partly-spent bound it had already earned its way out of. The gap check stays as the self-healing
  // backstop for poll()'s other early-return paths; this is the one that makes "any routine firing resets
  // the clock" true rather than approximately true.
  saturationSuppressSinceMs = null;
  saturationSuppressPasses = 0;
  saturationAlerted = false;
  if (consecutiveRestarts > 0 && shouldClearStrikes(healthyStreak)) {
    log(`ticker sustained-healthy (${healthyStreak} consecutive polls, fired ${idleSec}s ago) — clearing consecutive-restart strike count (was ${consecutiveRestarts})`);
    consecutiveRestarts = 0;
  }
  // Emit a throttled heartbeat so the durable log shows the watchdog is actively monitoring.
  const now = Date.now();
  if (now - lastHeartbeat >= HEARTBEAT_MS) {
    lastHeartbeat = now;
    log(`ticker healthy — newest routine fired ${idleSec}s ago (<= ${FREEZE_SILENCE_S}s)`);
  }
}

/** Mirrors build-info.ts's resolveBuildInfo() sha resolution (see watchdog.mjs's twin helper). */
function resolveTreeSha() {
  const envSha = process.env.PAPERCUSP_BUILD_SHA?.trim();
  if (envSha) return envSha;
  try {
    const dir = dirname(fileURLToPath(import.meta.url));
    const out = execFileSync('git', ['-C', dir, 'rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8',
      timeout: 2_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

/** Best-effort boot self-report into the deploys:vintage ledger (P-008) — never throws/blocks. */
async function reportVintage(unit) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 3_000);
    await fetch(VINTAGE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        unit,
        host: hostname(),
        treeSha: resolveTreeSha(),
        buildTime: new Date().toISOString(),
        pid: process.pid,
      }),
      signal: ctrl.signal,
    });
    clearTimeout(t);
  } catch (e) {
    log(`[runtime-vintage] boot self-report failed (non-fatal): ${e.message}`);
  }
}

function start() {
  log(
    `up — unit ${UNIT}, poll ${POLL_MS}ms, freeze-silence ${FREEZE_SILENCE_S}s, debounce ${DEBOUNCE_MS}ms (backoff x${BACKOFF_MULTIPLIER}, cap ${MAX_DEBOUNCE_MS}ms), ` +
      `boot-grace ${BOOT_GRACE_MS}ms (extendable at ANY unit age while >=${BOOT_PROGRESS_MIN_TICKS} CPU ticks per ${BOOT_PROGRESS_SAMPLE_MS}ms /proc sample, alarms at ${SATURATION_ALERT_AFTER_S}s, hard bound ${SATURATION_MAX_SUPPRESS_S}s of CONTINUOUS suppression — reset by any routine firing), ` +
      `alert-after ${ALERT_AFTER_RESTARTS} consecutive restarts, sustained-healthy ${SUSTAINED_HEALTHY_POLLS} polls, circuit cap ${MAX_RESTARTS_PER_HR}/hr, ` +
      `pool-shed-grace ${POOL_SHED_GRACE_S}s (suppression requires a live ${BGHOST_HEALTH_URL} within ${BGHOST_HEALTH_TIMEOUT_MS}ms, alarms at ${POOL_SHED_ALERT_AFTER_S}s, hard bound ${POOL_SHED_MAX_SUPPRESS_S}s); ` +
      `committed-hot-path activation check ${HOT_PATH_ACTIVATION_CHECK_MS}ms (dev:restart only; clean tree + zero collateral required); ` +
      `signal=PG-routine-freshness (journald-independent); durable log ${LOG_FILE}`,
  );
  // WI-37501: a recurrence guard, not just a fix — if POLL_MS/BOOT_GRACE_MS/MAX_RESTARTS_HR are ever
  // retuned in a way that makes the circuit breaker arithmetically unreachable again, say so loudly at
  // boot instead of silently shipping an unreachable safety valve a second time.
  const reachableCap = maxReachableRestartsPerHr();
  if (MAX_RESTARTS_PER_HR >= reachableCap) {
    log(
      `⚠⚠ MISCONFIGURED: MAX_RESTARTS_PER_HR=${MAX_RESTARTS_PER_HR} >= the reachable ceiling ${reachableCap.toFixed(2)}/hr ` +
        `given BOOT_GRACE_MS=${BOOT_GRACE_MS}+POLL_MS=${POLL_MS} — the circuit breaker can NEVER trip against a ` +
        `boot-grace-floored restart storm (WI-37501). Lower MAX_RESTARTS_PER_HR or the boot-grace/poll cadence.`,
    );
  }
  void reportVintage('bghost-watchdog');
  setInterval(
    () => void poll().catch((e) => log(`poll error: ${e.message}`)),
    POLL_MS,
  );
}

/** Are we the process's ENTRYPOINT (`node bghost-watchdog.mjs`), as opposed to a module someone imported?
 *
 *  This used to be an OPT-OUT (`start()` unless PAPERCUSP_BGHOST_WATCHDOG_NO_AUTOSTART=1), which is the
 *  wrong default for a module whose side effect is a process that runs `systemctl restart` against a
 *  SHARED service: every importer had to remember the env var, and one that forgets silently gets a
 *  SECOND live watchdog polling the real unit with its own independent debounce/circuit state. That is
 *  not hypothetical — it happened to an agent importing `procTreeCpuTicks` for a one-off /proc probe on
 *  2026-08-10, which started a real watchdog against papercusp-bg-host and wrote to the durable log. The
 *  guard is now correct-by-construction: importing this file can no longer start anything, whether or
 *  not the importer knows the env var exists.
 *
 *  ⚠ The FALSE direction is the dangerous one — a guard that wrongly says "imported" under systemd would
 *  leave bg-host with NO freeze recovery, silently. So: `node -e`/REPL (no argv[1]) is not-entrypoint;
 *  an unresolvable path degrades to a plain string compare rather than guessing; and the
 *  not-starting branch LOGS why, so a misfiring guard shows up in the journal instead of as silence. */
function isDirectEntrypoint() {
  const entry = process.argv[1];
  if (!entry) return false; // `node -e "import(...)"`, a REPL, or a worker with no script entry
  const self = fileURLToPath(import.meta.url);
  const target = resolve(entry);
  if (self === target) return true;
  // Symlinked checkout / systemd ExecStart naming a link: compare real paths too.
  try {
    return realpathSync(self) === realpathSync(target);
  } catch {
    return false; // a path that cannot be resolved is not a match we are willing to assert
  }
}

// Auto-start ONLY as the systemd unit's entrypoint. PAPERCUSP_BGHOST_WATCHDOG_NO_AUTOSTART=1 is still
// honored as an explicit kill-switch (tests set it; it now belts-and-braces the guard rather than being
// the only thing standing between an import and a live watchdog).
if (process.env.PAPERCUSP_BGHOST_WATCHDOG_NO_AUTOSTART === '1') {
  // deliberate opt-out — say nothing
} else if (isDirectEntrypoint()) {
  start();
} else {
  // Imported, not run. Never silent: if this branch is ever taken by the systemd unit, this line in the
  // journal is what turns "bg-host lost its watchdog" from a mystery into a one-line diagnosis.
  console.error(
    `[bghost-watchdog] imported as a module — NOT auto-starting the poll loop ` +
      `(entrypoint=${process.argv[1] ?? '<none>'}, module=${fileURLToPath(import.meta.url)}). ` +
      `Run it directly to start the watchdog.`,
  );
}
