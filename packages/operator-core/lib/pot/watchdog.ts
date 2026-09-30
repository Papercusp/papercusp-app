/**
 * watchdog.ts — the pot LIVENESS BACKSTOP
 * (start-hive-wake-orchestration-2026-06-09 Phase 3: P-008…P-012, D-002/D-003/D-004).
 *
 * One invariant (D-002, widened by EI-18096707077291323): **SOME next wake is
 * ALWAYS armed while the pot is started — a time wake, a live event-wake
 * subscription, or both.** The Mug sets her own cadence (pot:declare-wake —
 * including effectively-continuous, or a deliberate event-only/`mode:'none'`
 * dormancy per EI-309's frontier guard); THIS module guarantees a wake
 * mechanism EXISTS when she forgot BOTH — an explicitly-declared event-only
 * wake is not "forgot," it's armed via the event leg (see potLivenessCheck).
 * Pause (started=false) is the only thing allowed to clear it.
 *
 * This is a dead-man's switch, NOT a cadence (D-003): every check is a cheap
 * deterministic SQL read, and the wake it may arm is the exception path. Three
 * seams call in:
 *   - **turn-end** (P-009) — the invoke route, after a `bpkind=pot` launch
 *     finishes: started && no wake armed → arm the fallback.
 *   - **boot** (P-010) — host bootstrap: a started pot with no wake armed
 *     (the process died mid-turn, the turn-end hook never ran) → arm.
 *   - **tick** (P-011) — the 30s routinesTick sweep: started + demand + no wake
 *     + not mid-turn + stale → arm. Belt-and-braces.
 *
 * When she forgot, arm a default SLEEP — never an immediate re-invoke (D-004):
 * a broken-prompt Mug must fail toward "sleeps too long" (cheap), never
 * toward "runs continuously" (expensive). Every fire is recorded in
 * `harness_shared.pot_watchdog_fires` (mig 212) — frequent fires are a Mug
 * prompt bug to FIX, not a mechanism to lean on.
 *
 * Wake-mode composition (P-013): in global `manual` mode the fallback is not a
 * silent self-arm — it routes through `wakeRecipients` to the pinned brain
 * owner, where the SHIPPED gate stages it for owner review like any other wake.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { clearPotTimeWake, declarePotTimeWake, getPotTimeWake, readPotWakeState } from './wake';
import { getPotStarted, listStartedWorkspaceLoops, mugKettleSystemEnabled, setPotStarted } from './started';

// ── tunables (env-overridable, like the wake floor) ──────────────────────────

/** The fallback sleep the watchdog arms when the Mug forgot to declare
 *  (D-004 / OQ-3: default 30 min — failing toward "sleeps too long" is cheap). */
export function watchdogFallbackSleepSec(): number {
  const n = Number(
    process.env.PAPERCUSP_POT_WATCHDOG_SLEEP_SEC ?? process.env.PAPERCUSP_POT_WATCHDOG_SLEEP_SEC ?? 1800,
  );
  return Number.isFinite(n) && n >= 60 ? n : 1800;
}

/** The fallback sleep when the Mug didn't self-arm BUT there is STANDING DEMAND (todo work / started plans).
 *  Much shorter than the idle fallback so a crashed / non-self-arming Mug re-wakes FAST to drain the backlog
 *  (or retry a mid-turn crash) instead of stranding hundreds of open items for up to 30 min (2026-07-01: the
 *  Mug `infra_loss`/`usage_limit`-crashed mid-turn and the fixed 1800s fallback left ~395 open items idle
 *  ~30 min per gap; there was no fast crash re-wake). Floored at the wake floor (60s). The demand GATE (never
 *  wake an empty frontier) still applies, so an IDLE pot keeps the long sleep and isn't hammered. */
export function watchdogDemandSleepSec(): number {
  const n = Number(
    process.env.PAPERCUSP_POT_WATCHDOG_DEMAND_SLEEP_SEC ?? process.env.PAPERCUSP_POT_WATCHDOG_DEMAND_SLEEP_SEC ?? 120,
  );
  return Number.isFinite(n) && n >= 60 ? n : 120;
}

/** How long a started, unarmed, demand-bearing pot must be quiet before the
 *  routinesTick sweep fires (OQ-3: default 15 min). The turn-end + boot seams
 *  don't wait this out — they KNOW the turn just ended / the host just booted. */
export function watchdogStaleSec(): number {
  const n = Number(process.env.PAPERCUSP_POT_WATCHDOG_STALE_SEC ?? process.env.PAPERCUSP_POT_WATCHDOG_STALE_SEC ?? 900);
  return Number.isFinite(n) && n >= 30 ? n : 900;
}

/** EI-16038: the ceiling a geometrically-backed-off debounce window may grow to for a
 *  chronically-repeating (source,reason) premise — a stuck alarm still surfaces at least
 *  this often (never falls silent forever), but never faster than this once it has
 *  demonstrably been re-firing on an UNCHANGED premise. Default 24h; env-tunable. */
export function watchdogBackoffCapHours(): number {
  const n = Number(process.env.PAPERCUSP_WATCHDOG_BACKOFF_CAP_HOURS ?? 24);
  return Number.isFinite(n) && n > 0 ? n : 24;
}

/** Validate the install dimension before a watchdog acts on persisted state.
 * The workspace papercup is synthetic by design; every other slug must still
 * be a registered Pot. A registry read failure is unknown, not proof of a
 * missing Pot, so callers fail safe and retry on the next sweep. */
async function registeredPotState(workspaceId: string, installSlug: string): Promise<boolean | null> {
  if (installSlug === workspaceId) return true;
  try {
    const { isRegisteredHive: isRegisteredPot } = await import('../harness-registry');
    return await isRegisteredPot(workspaceId, installSlug);
  } catch {
    return null;
  }
}

async function alertMissingStartedPot(workspaceId: string, installSlug: string): Promise<void> {
  try {
    const { resolveBrainOwner } = await import('../harness/routines/wake-brain-action');
    const owner = await resolveBrainOwner(workspaceId).catch(() => null);
    if (!owner) return;
    const { wakeRecipients } = await import('../agent-tools/coordination/inbox-wake');
    await wakeRecipients([owner], {
      summary: `⚠️ Self-cleared started Pot "${installSlug}" because it is missing from the workspace registry.`,
      source: 'pot-watchdog:missing-harness',
      workspaceId,
    });
  } catch (e) {
    console.warn(`[pot-watchdog] missing-pot alert failed: ${e instanceof Error ? e.message : e}`);
  }
}

// ── P-008: the pure liveness read ────────────────────────────────────────────

export interface PotLiveness {
  /** D-002's one-row check, widened by EI-18096707077291323: an ACTIVE
   *  pot-wake routine with a next_fire_at, OR at least one live event-wake
   *  subscription — either is a validly-armed next wake. */
  armed: boolean;
  /** true iff armed via the TIME leg specifically (routine row active + next_fire_at). */
  timeArmed: boolean;
  /** true iff armed via the EVENT leg specifically (>=1 persisted subscription). */
  eventArmed: boolean;
  nextFireAt: Date | null;
  lastFiredAt: Date | null;
  /** ms since the last wake activity (launch fire or routine fire); null = never. */
  staleForMs: number | null;
}

/**
 * The one-row liveness check the whole invariant rests on (P-008/D-002,
 * widened by EI-18096707077291323): "is the Mug alive?" ⇒ does an active wake
 * row exist, and how long since the last wake activity if not.
 *
 * EI-18096707077291323: D-002's original invariant treated ONLY a durable
 * time wake as "armed" — a stale read from before `pot:declare-wake` grew a
 * legitimate event-only (or `mode:'none'`) dormancy declaration (EI-309's
 * frontier guard explicitly permits it, e.g. while owner-steering
 * `pauseNewWork` is on). A pot that deliberately declared event-only wakes
 * has a real next-wake mechanism — an armed subscription WILL fire her when
 * its event occurs — so treating it as "forgot to declare" made the turn-end
 * watchdog re-fire every cycle even though the operator correctly declared
 * dormancy (measured: 139 fires/24h on a pot paused for a release). `armed`
 * is now TIME-armed OR EVENT-armed; `timeArmed`/`eventArmed` are exposed
 * separately for callers (e.g. pot:status) that want to distinguish them.
 */
export async function potLivenessCheck(
  sql: Sql,
  installSlug: string,
  opts: { workspaceId?: string; now?: number } = {},
): Promise<PotLiveness> {
  const now = opts.now ?? Date.now();
  // K1 (workspace-scoped-coordination P-003): thread the workspace so the
  // read-fallback resolves the workspace-papercup wake routine when the flag is
  // ON (OFF ⇒ per-pot, unchanged).
  const time = await getPotTimeWake(sql, installSlug, opts.workspaceId ? { workspaceId: opts.workspaceId } : {});
  const state = await readPotWakeState(opts.workspaceId);
  const timeArmed = Boolean(time?.active && time.nextFireAt);
  const eventArmed = state.subscriptions.length > 0;
  const lastActivity = Math.max(state.lastWakeAt ?? 0, time?.lastFiredAt?.getTime() ?? 0);
  return {
    armed: timeArmed || eventArmed,
    timeArmed,
    eventArmed,
    nextFireAt: time?.nextFireAt ?? null,
    lastFiredAt: time?.lastFiredAt ?? null,
    staleForMs: lastActivity > 0 ? Math.max(0, now - lastActivity) : null,
  };
}

// ── demand (the P-011 gate: never wake an empty frontier) ────────────────────

export interface PotDemand {
  demand: boolean;
  todoItems: number;
  startedPlans: number;
}

/** Cheap deterministic demand counts (D-003): queued feature-family work +
 *  started plans. Escalations are not re-checked here — they wake the Mug at
 *  raise time via the P-002 event subscription; the watchdog needs only the
 *  STANDING demand a forgotten wake would strand.
 *
 *  COUNTS ARE WORKSPACE-WIDE. Until P-059 this subtracted STOPPED hives'
 *  backlog via `computePotPlacementSplit` (owner model 2026-07-01: the
 *  start/stop popup was the Mug's scope control). That stop-list was a
 *  tier concept and retired with the Mug/Kettle system — there is no longer
 *  a started/stopped partition to consult. The subtraction is simply gone,
 *  which lands on the branch this function ALREADY took whenever the split
 *  read failed (documented then as "fail-open ⇒ workspace-wide counts"), so
 *  the surviving behaviour is one this path was always specified to produce. */
export async function potDemandCheck(workspaceId: string): Promise<PotDemand> {
  const { sql } = getOrgPg();
  const rows = await sql<Array<{ todo_items: number; started_plans: number }>>`
    SELECT
      -- work-item-status-full-unify (2026-07-19, migration 638): feature-family status
      -- 'todo' was rewritten to the unified claimable token 'open'. This literal was
      -- never updated, so since that migration this demand check has silently
      -- under-counted standing feature-family demand to ~0 (same root cause as
      -- survey.ts's fetchFrontierRows, EI-18690462961089460).
      (SELECT count(*) FROM harness_shared.harness_features_consolidated
        WHERE workspace_id = ${workspaceId} AND status = 'open')::int AS todo_items,
      (SELECT count(*) FROM harness_shared.harness_plans
        WHERE workspace_id = ${workspaceId} AND op_status = 'started')::int AS started_plans
  `;
  const todoItems = Number(rows[0]?.todo_items ?? 0);
  const startedPlans = Number(rows[0]?.started_plans ?? 0);
  return { demand: todoItems > 0 || startedPlans > 0, todoItems, startedPlans };
}

/** Is a tracked pot turn LIVE right now (the invoke route's bpkind=pot
 *  adv_sessions row, not yet ended)? The tick sweep must not arm a "you're
 *  asleep" wake at a Mug who is mid-turn. */
export async function potMidTurn(installSlug: string): Promise<boolean> {
  const { sql } = getOrgPg();
  const rows = await sql`
    SELECT 1 FROM harness_shared.adv_sessions
    WHERE label LIKE ${'pot · ' + installSlug + '/%'} AND ended_at IS NULL
    LIMIT 1`;
  return rows.length > 0;
}

// ── the fallback arm (P-009/P-010/P-011 share; P-012 records) ────────────────

export type WatchdogSource =
  | 'turn-end'
  | 'boot'
  | 'tick'
  | 'paused-recovery'
  | 'scout-draft-review'
  // WI-1574: the ready-plan autostart sweep's decompose-wake (a ratified scout
  // plan with no open items cannot start — the Mug is woken to add items).
  | 'scout-ready-decompose'
  // retire-mug-kettle-su-only-2026-08-09 P-070 (D-064): the SAME sweep's START
  // path, scoped per plan slug. It exists only while the op_status axis is
  // RETIRED: that write used to be the sweep's own once-only latch (a started
  // plan stops matching `op_status <> 'started'`), and gating it away leaves the
  // plan selected on every 30s tick. Re-entry is idempotent, not wrong — so this
  // bounds churn rather than preventing damage, and the geometric backoff is a
  // FEATURE here: items added to an already-ratified plan still reach the queue
  // eventually, which the one-way op_status bit never allowed.
  | 'scout-ready-autostart'
  // GYM-2 (gym-unwedge): the chronic-autoloop-failure escalator's per-(harness,role)
  // 24h debounce (a cycle red >= threshold consecutive fires files an observation).
  | 'autoloop-chronic'
  // WI-1623: the release-deploy staleness recurrence guard — the green pin has
  // sat deployable-but-not-live longer than the threshold (a genuinely wedged
  // pipeline OR a lying deployedAt field; either way, worth an alert).
  | 'release-deploy-staleness'
  // pot-seed-bundle P-008 (D-007): the cold-join canary's per-interval fire —
  // a scheduled FULL cold join (seed disabled) keeps the whole-history join path
  // exercised now that seeded installs only carry the delta. A fire records each
  // canary run (pass or fail) + doubles as the interval debounce clock.
  | 'cold-join-canary'
  // unified-agent-state-plane-2026-07-27 P-010: the intent↔action divergence
  // detector's per-(owner, tool) debounce. Scoped by that key so two different
  // flails page independently rather than one masking the other, and re-read at
  // a longer window to decide whether a finding is a REPEAT (self-correction did
  // not take) and therefore worth the leader's attention.
  | 'intent-action-divergence'
  // dead-target-routine-reaper-2026-08-30 P-004 (EI-19278517916030043): the dead-target
  // reaper's per-install escalation. Fires once per 24h when an install's routines are
  // auto-parked because its tree is structurally unreadable (root gone, or a corrupt git
  // object store) — the condition that burned ~2,400 doomed git-sync attempts over 5 days
  // on ei669-repro-su-b621d before a human noticed and paused them by hand.
  | 'dead-target-reaper'
  // su-ideate-learning-substrate-2026-07-10 P-006: the ungraded su-filings grading
  // backstop — a debounced Mug-triage nudge when su-originated filings sit ungraded
  // past SU_IDEATE_UNGRADED_STALE_SEC (D-013: epoch-floored + batch-capped).
  | 'su-ideate-ungraded'
  // stale-prompt-render-in-live-sessions-2026-08-02 P-004: the live-render material
  // drift notice's per-(owner, drift-fingerprint) debounce. A render cannot change
  // under a running session, so the same finding can only ever recur as noise —
  // hence a long window, scoped by the drift itself so a session stale in two
  // distinct ways still hears about both.
  | 'stale-prompt-render'
  // scorecard-blender-pipeline-fixes-2026-07-11 P-001 (WI-4274): the Scout cycle
  // error-streak pager — N consecutive ERROR ticks fire one debounced @role:mug
  // escalation (the circuit gate backs off but pages nobody).
  | 'scout-error-streak'
  // rubric-system-hardening-2026-07-14 P-004 (EI-12149): the rubric-staleness
  // watchdog — an ACTIVE releaseGating rubric with no COMPLETE scorecard within
  // its threshold window (default 6h) fires one debounced alert + escalation
  // (a release bar nobody is grading is a silent gate, not a green one).
  | 'rubric-staleness'
  // WI-38044: a proposed rubric that outlives the independent-review dwell
  // window without a proposer-independent ratifier.
  | 'rubric-proposal-dwell'
  // session-turn-storage-2026-07-28 P-007 (D-005): the transcript-ingest lag
  // watchdog — an adapter sitting on unconsumed on-disk bytes past its
  // byte_offset for longer than the threshold. SOURCE-RELATIVE by design, not
  // a wall-clock lag threshold: codex read 2d9h "behind" and omp 6d8h on
  // 2026-07-28 while both were caught up and simply unused, so lag alone would
  // have paged twice for nothing. Scoped per source_kind.
  | 'session-ingest-lag'
  // EI-19281872822982156: the SILENTLY-STOPPED autoloop role detector. Distinct from
  // 'autoloop-chronic' above, and the distinction is the whole point: chronic fires on an
  // error STREAK, so a role that stopped firing CLEANLY (no recent fire at all, despite a
  // non-zero consecutive_errors) is invisible to it — it has no ongoing stream of errors to
  // streak on. Debounced per (harness, role) over 24h via the same claimWatchdogFire
  // single-flight the chronic sweep uses.
  | 'autoloop-silent-stop'
  // The learning-loop health sweep's per-blueprint escalation: a learning loop sitting in an
  // unhealthy status (or a 'collision', which the sweep reports in the status slot). Debounced
  // per blueprint over 24h, keyed `learning-loop::<blueprintId>`.
  | 'learning-loop-health'
  // session-turn-storage-2026-07-28 D-008: the COMPLEMENT of session-ingest-lag
  // — an adapter that CONSUMES bytes normally while its faithful-parts writer
  // emits nothing. Invisible to the lag guard by construction (no backlog, so
  // behindFiles is 0 and it reads "fully caught up"), and the worse half of the
  // pair: consumed bytes are never re-read, so the gap is permanent rather than
  // deferred. Scoped per source_kind, and judged only for adapters that
  // implement parseParts — zero parts is the CORRECT steady state for the other
  // three, and alarming on them is the fatigue trap D-006 forbids.
  | 'session-parts-writer'
  // autonomous-loop-prod-audit-2026-07-02 P-006 (SPOF 5b): the Scout
  // outcome-refresh sweep's stale-pending alert — routed ideas whose cached
  // `outcome` has sat NULL/'pending' past the staleness threshold even after
  // an independent (Scout-cadence-decoupled) refresh, i.e. the plan-rail /
  // gym-rail / wi-rail outcome ledger looks genuinely stuck, not just
  // between cycles.
  | 'scout-outcome-stale-pending'
  // EI-12968: the chronic-autoloop-failure sweep's non-escalation SKIP outcomes
  // (skipped-stale/skipped-paused/skipped-drill/skipped-loop-arm) are correct,
  // repeated-tick decisions — a FROZEN watermark row re-reports 'skipped-stale'
  // on every ~30s routines tick forever (measured: ~60k duplicate log lines in
  // one journal since the condition first appeared). The decision doesn't need
  // debouncing (it's re-derived correctly every tick, cheaply); the LOG LINE
  // does — log once per (outcome, harness, role) per hour, not 2880x/day.
  | 'autoloop-chronic-skip-log'
  // EI-13818: a loop:arm loop's resume turn died on a `surfaceToUser` wedge class
  // (usage_limit/auth/permanent) — a class the chronic-autoloop-failure sweep
  // deliberately EXCLUDES (it expects the dead-owner terminal guard to cover
  // loop:arm loops), but a rate-limited-but-ALIVE owner never trips that guard.
  // Fires the FIRST time a wedge is observed for a given loop, debounced 6h —
  // see loop-turn-outcome.ts's `handleLoopResumeTurnExit`.
  | 'loop-wedge-death'
  // owner-wall-ttl-lapse-hardening-2026-07-26 (EI-18669544162414270): a
  // `facts:assert { slot:'wall' }` owner-gated blocker whose TTL expired
  // WITHOUT being retracted — TTL decay always fails toward "clear", the
  // wrong direction for an unremediated risk, so this pages instead of
  // letting the fact silently vanish from folds. Debounced 24h per fact key
  // (wall-lapse-watchdog.ts).
  | 'wall-fact-lapse'
  // EI-19342686127995790: a COMMITTED new-file tsc red that OUTLIVED its author's
  // attention. The gate already computes this finding ~9x/hour and prints it to a
  // stdout nobody reads; the sweep (tsc-red-sweep.ts) files only the reds that
  // DWELL, because the measured base rate is self-healing — 4 of 5 cleared unaided
  // inside 15 minutes on 2026-08-02, so filing on first sight would have minted 5
  // items that day, 4 of them self-closing unread. Debounced 24h per path, keyed
  // `tsc-new-file-red::<path>`.
  | 'tsc-new-file-red'
  // sql-escape-tool-routing-2026-08-12 P-008: the nightly SQL-read census's
  // escalation debounce. Keyed by the ALARM CLASSES that crossed
  // (`no-fall+verdict-drift+uncovered`), never by the run, so a NEW class is
  // never suppressed by an older one still inside its window — the EI-16071
  // failure, whose key was source-only. Debounced 7d: an uncovered cluster that
  // persists for a fortnight is not new news every night, and ~15 clusters on
  // this box already sit above the threshold.
  | 'sql-read-census'
  // agent-launch-context-cost-2026-09-18 P-009(c) / D-016: the standing launch-cost
  // watch. Keyed by the LEG(s) that crossed (`ceiling`, `regression`, or both) for
  // the same EI-16071 reason as the census above — a bad LEVEL that persists must
  // not suppress a REGRESSION crossing for the first time. Debounced 24h: launch
  // cost is measured per UTC day, so a shorter window would re-alarm on the same
  // day's data. This exists because the measurement script was committed, correct,
  // and never RUN, while launch cost drifted 108k -> 306k over five weeks and the
  // only detector that ever fired was a human noticing agents felt slow.
  | 'launch-cost-ceiling'
  // EI-19409061552037718: the stale-routine-executor watchdog — a long-lived host
  // with PAPERCUSP_DBOS_ROUTINES=1 running code frozen at boot while this
  // checkout's tree HEAD has since moved. Debounced per executor identity
  // (`port-<n>` / `pid-<n>`, stale-routine-executor-watchdog.ts's
  // `executorIdentity()`), keyed `stale-routine-executor:<identity>`.
  | 'stale-routine-executor'
  // WI-1565914: the STALE SERVING HOST sweep — the same question as
  // `stale-routine-executor` above, but asked from OUTSIDE every host, off
  // `harness_shared.tool_invocations.serving_build_sha` (migration 1043). It exists as a
  // separate source because it covers a strictly different population: the one above is
  // an in-process SELF-CHECK gated on PAPERCUSP_DBOS_ROUTINES=1, so it can never reach a
  // host that runs no routines (measured: all six :3070 listeners) nor one whose code
  // predates the check itself. Debounced per serving host (`port-<n>` / `pid-<n>`, the
  // shared `hostIdentity()`), keyed `stale-serving-host:<identity>`. Fires only on a
  // CONCLUSIVE verdict — an empty reporting population is reported as inconclusive and
  // never paged, because a page for a measurement that measured nothing is what teaches
  // readers to ignore the page.
  | 'stale-serving-host'
  // EI-19457924854150358: the sync-read payload BUDGET watchdog — reads the
  // `syncReads.audit` snapshot the daily audit routine writes and pages on either
  // of its two failure modes, which need different remedies and so are debounced
  // under different scope keys:
  //   `sync-read-budget:breach:<harness>` — a read is over its ceiling. The
  //     `ratchetRegressions` bucket is the loud one: someone already measured that
  //     read, wrote a number down, and it has since rotted.
  //   `sync-read-budget:blind:<harness>`  — the audit itself stopped producing.
  //     Without this leg the watchdog would be blind exactly when the instrument
  //     dies, which is the ORIGINAL defect (an unrun audit) wearing a new costume.
  // WARNS only — never blocks a deploy (no-http-anywhere-2026-07-28 #D-009/#D-011:
  // a budget warns, an invariant blocks).
  | 'sync-read-budget';

export interface FallbackArmResult {
  /** 'armed' = time wake declared; 'staged' = routed to the manual-mode review
   *  queue; 'skipped' = nothing to do (not started / already armed / no brain
   *  to stage at); 'error' = the arm itself failed (recorded, never thrown). */
  outcome: 'armed' | 'staged' | 'skipped' | 'error';
  at?: string;
  reason: string;
}

export async function recordFire(opts: {
  workspaceId: string;
  installSlug: string;
  source: WatchdogSource;
  reason: string;
  wakeAt: Date | null;
  demand?: PotDemand | null;
  /** repeat_count to persist on this row (default 1 — a fresh, non-backoff-tracked fire). */
  repeatCount?: number;
}): Promise<void> {
  try {
    const { sql } = getOrgPg();
    await sql`
      INSERT INTO harness_shared.pot_watchdog_fires
        (workspace_id, install_slug, source, reason, wake_at, demand, repeat_count)
      VALUES (
        ${opts.workspaceId}, ${opts.installSlug}, ${opts.source}, ${opts.reason},
        ${opts.wakeAt ? opts.wakeAt.toISOString() : null}, ${JSON.stringify(opts.demand ?? {})}::text::jsonb,
        ${opts.repeatCount ?? 1}
      )`;
  } catch (e) {
    // Observability must never break the arm (or boot) — mig 212 may be pending.
    console.warn(`[pot-watchdog] fire record failed: ${e instanceof Error ? e.message : e}`);
  }
}

// ── EI-16038: generalized geometric backoff on an unchanged (source,reason) premise ──
//
// 1,603 recorded fires that armed no wake spanned only 589 distinct (source,reason)
// premises — 69.8% exact repeats, with single objects (one stuck scout draft, one
// itemless ratified plan, one turn-after-turn missing scorecard) re-firing hundreds of
// times at a FIXED cadence over weeks because the debounce window a caller passes is
// static: once a fire lands, the NEXT identical fire is permitted the instant
// `windowHours` elapses, forever, regardless of how many times it has already repeated.
//
// `computeWatchdogBackoff` is the pure decision this generalizes to every source: when
// the current `reason` exactly matches the LAST recorded fire's reason for this
// (workspace, install, source) key, the required quiet window doubles per consecutive
// repeat (capped — see watchdogBackoffCapHours) instead of staying fixed at the caller's
// base window. A CHANGED reason (the premise genuinely moved — a different draft, a
// grown/shrunk count, a new oldest-stale timestamp bucket) resets the streak and fires
// immediately, exactly like today — this only suppresses a alarm that is, byte for byte,
// still complaining about the same unresolved thing it complained about last time.

export interface WatchdogBackoffLast {
  reason: string;
  firedAtMs: number;
  /** repeat_count stamped on that last row (1 = it was itself a fresh/reset fire). */
  repeatCount: number;
}

export interface WatchdogBackoffDecision {
  /** true = suppress: unchanged premise, still within its (possibly grown) window. */
  skip: boolean;
  /** repeat_count the caller should persist if it proceeds (1 = fresh/reset premise). */
  repeatCount: number;
  /** the debounce window (hours) actually applied this decision. */
  effectiveWindowHours: number;
}

/** PURE (no DB, no clock — `now` is an arg): decide whether this fire should be
 *  suppressed. The BASE window always applies from the last fire regardless of its
 *  reason (byte-identical to every existing caller's debounce today — many callers'
 *  `reason` embeds a live counter/timestamp that legitimately drifts every tick, e.g.
 *  autoloop-chronic-failure's `consecutive_errors`, and must stay debounced to its base
 *  window regardless of that drift). Geometric backoff is a strictly ADDITIVE widening
 *  on top of the base window, engaged ONLY when the reason is byte-identical to the
 *  last fire — a changed reason resets the streak and falls back to the base window,
 *  never below it and never skipped outright. `last` is the most recent fire recorded
 *  for this exact (workspaceId, installSlug, source) key, or null if none exists yet. */
export function computeWatchdogBackoff(args: {
  now: number;
  baseWindowHours: number;
  capHours: number;
  last: WatchdogBackoffLast | null;
  reason: string;
}): WatchdogBackoffDecision {
  const baseWindowHours = Number.isFinite(args.baseWindowHours) && args.baseWindowHours > 0 ? args.baseWindowHours : 1;
  if (!args.last) {
    return { skip: false, repeatCount: 1, effectiveWindowHours: baseWindowHours };
  }
  const unchanged = args.last.reason === args.reason;
  const repeatCount = unchanged ? args.last.repeatCount + 1 : 1;
  // Double the window per consecutive identical repeat, capped so a chronic stuck alarm
  // still surfaces at least once per capHours rather than eventually falling silent.
  // `- 2` on the exponent so the FIRST repeat (repeatCount=2) still uses baseWindowHours
  // (a single re-confirmation isn't yet "chronic"); clamp the exponent itself so a
  // years-long streak can't overflow `2 ** n` before the outer cap even applies. A
  // CHANGED reason (unchanged=false) never escalates — it's exactly the base window,
  // matching every existing caller's pre-EI-16038 debounce behavior.
  const exponent = Math.min(Math.max(0, repeatCount - 2), 30);
  const capHours = Number.isFinite(args.capHours) && args.capHours > 0 ? args.capHours : 24;
  const effectiveWindowHours = unchanged
    ? Math.min(baseWindowHours * 2 ** exponent, Math.max(capHours, baseWindowHours))
    : baseWindowHours;
  const elapsedHours = (args.now - args.last.firedAtMs) / 3_600_000;
  return { skip: elapsedHours < effectiveWindowHours, repeatCount, effectiveWindowHours };
}

/** Recent fallback-fire count — the "watchdog fired N times" health signal
 *  (P-012/D-004) surfaced in pot:status.
 *
 *  `scopeKey` (EI-16071) narrows the debounce below the 3-part
 *  (workspaceId, installSlug, source) key to a SUB-CONDITION sharing that
 *  source — e.g. one rubricId among several release-gating rubrics sharing
 *  source `'rubric-staleness'`. Without it, the FIRST stale sub-condition's
 *  fire silently debounces every OTHER sub-condition sharing the source for
 *  the rest of the window (coverage degrades to exactly one alert per
 *  source per window, regardless of how many distinct things are stale).
 *  Matched via a `reason LIKE '%scopeKey%'` substring match — callers must
 *  embed the scope key verbatim in their fire `reason` (as the existing
 *  rubric-staleness reasons already do, quoting the rubricId). Omitted ⇒
 *  today's exact source-only behavior, unchanged. */
/**
 * PURE: guarantee a scoped fire's `reason` actually CONTAINS its `scopeKey`.
 *
 * A `scopeKey` is resolved against the ledger as `reason LIKE '%scopeKey%'`, so a
 * caller that records a reason NOT containing the key builds a debounce that can
 * never match its own prior fires — it re-pages every tick, forever, and silently:
 * the write succeeds, the read returns 0, and nothing anywhere reports a fault.
 *
 * That is not hypothetical. `agent-state-divergence-sweep` recorded the bare alert
 * summary while querying with an `<ownerId>:<toolName>` scope key, and produced
 * 113 fires across only 2 distinct conditions in 37 minutes — ~91% of one agent's
 * inbox — with the leader-escalation backstop equally dead, because `isRepeat`
 * read the same never-matching lookup (EI-18824142520274965).
 *
 * Documenting the contract was not enough to prevent that, so this ENFORCES it:
 * a scoped reason missing its key is prefixed rather than trusted. The warning
 * names the caller so the mismatch is fixed at the source instead of relying on
 * this repair; correct callers (rubric-staleness, which always quotes its
 * rubricId) are untouched, so this can only ever fire on the bug it prevents.
 */
export function scopedFireReason(reason: string, scopeKey: string | undefined, source: WatchdogSource): string {
  if (!scopeKey || reason.includes(scopeKey)) return reason;
  console.warn(
    `[pot-watchdog] '${source}' claimed a fire with scopeKey='${scopeKey}' whose reason does not contain it — ` +
      `the debounce would never match and this alarm would re-fire every tick. Prefixing the reason; ` +
      `fix the caller to embed the key (EI-18824142520274965).`,
  );
  return `[${scopeKey}] ${reason}`;
}

export async function recentWatchdogFires(
  workspaceId: string,
  installSlug: string,
  windowHours = 24,
  source?: WatchdogSource,
  scopeKey?: string,
): Promise<number> {
  try {
    const { sql } = getOrgPg();
    const rows = await sql`
      SELECT count(*)::int AS n FROM harness_shared.pot_watchdog_fires
      WHERE workspace_id = ${workspaceId} AND install_slug = ${installSlug}
        AND fired_at > now() - make_interval(hours => ${windowHours})
        AND ${source ? sql`source = ${source}` : sql`TRUE`}
        AND ${scopeKey ? sql`reason LIKE ${`%${scopeKey}%`}` : sql`TRUE`}`;
    return Number((rows[0] as { n?: number } | undefined)?.n ?? 0);
  } catch {
    return 0; // mig 212 pending → no signal, not an error
  }
}

/**
 * EI-6777: atomically claim the "should I fire?" debounce slot for
 * (workspaceId, installSlug, source, windowHours).
 *
 * `recentWatchdogFires(...) > 0` then, later, `recordFire(...)` is a
 * classic check-then-act race: when multiple sweep ticks/processes race for
 * the SAME debounce key, every one of them can observe "not fired yet" (the
 * SELECT) before any of them commits the INSERT, producing N duplicate
 * escalations instead of 1 (root-caused via EI-6760/6761/6762 — 3
 * near-identical escalations filed within 20ms of each other). There is no
 * unique constraint to lean on here (see mig 212's header: the ledger is
 * plain append-only, and callers use varying, arbitrary `windowHours`
 * sliding windows rather than a fixed calendar bucket a unique index could
 * key on) — so this uses a Postgres advisory transaction lock scoped to the
 * debounce key to serialize the check+insert instead.
 *
 * Callers should use this as a DOUBLE-CHECKED-LOCKING re-verification: do
 * the ordinary cheap `recentWatchdogFires` read first (as before, to decide
 * whether the OTHER, non-debounce conditions — staleness, demand, threshold
 * — even warrant firing at all), and only when that says "yes" call this to
 * atomically re-check + claim the slot immediately before performing the
 * one-time side effect (captureImprovement, alertOwnerPausedOutage, ...).
 * Returns true iff THIS call won the race and recorded the fire — proceed.
 * Returns false iff a fire is already recorded within the window (either
 * from before, or a concurrent racer who claimed it first) — skip the side
 * effect; do NOT also call `recordFire` (this already recorded it).
 *
 * `pg_advisory_xact_lock` auto-releases at transaction end (commit OR
 * rollback) — unlike a session-level `pg_advisory_lock`/`_unlock` pair, a
 * crash or thrown error mid-claim can never leak the lock.
 *
 * Fail-open on any DB error (mirrors recordFire/recentWatchdogFires'
 * existing fail-soft contract — mig 212 may be pending, or a transient PG
 * hiccup; observability must never SUPPRESS a real watchdog escalation, only
 * best-effort dedupe it).
 */
export async function claimWatchdogFire(opts: {
  workspaceId: string;
  installSlug: string;
  source: WatchdogSource;
  reason: string;
  wakeAt: Date | null;
  demand?: PotDemand | null;
  windowHours?: number;
  /** EI-16071: narrows both the advisory-lock key and the debounce check to a
   *  SUB-CONDITION sharing `source` (mirrors `recentWatchdogFires`' `scopeKey`)
   *  — e.g. one rubricId among several release-gating rubrics. Omitted ⇒
   *  today's exact source-only behavior. Matched via `reason LIKE '%scopeKey%'`;
   *  callers must embed the scope key verbatim in `reason`. */
  scopeKey?: string;
}): Promise<boolean> {
  const { workspaceId, installSlug, source, windowHours = 24, scopeKey } = opts;
  // Make the scopeKey↔reason contract SELF-ENFORCING rather than documented-only.
  const reason = scopedFireReason(opts.reason, scopeKey, source);
  try {
    const { sql } = getOrgPg();
    return await sql.begin(async (tx) => {
      // hashtextextended gives a stable 64-bit lock key from the debounce key;
      // `0` (the salt arg) keeps it deterministic across calls. scopeKey (when
      // present) is folded into the lock key too, so two distinct scoped
      // conditions sharing (workspaceId, installSlug, source) never serialize
      // on the same advisory lock.
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`${workspaceId}::${installSlug}::${source}::${scopeKey ?? ''}`}, 0))`;
      // EI-16038: fetch the single most recent matching fire (not just a count) so
      // computeWatchdogBackoff can tell whether it is byte-identical to this one and
      // widen the required quiet window geometrically when it is (a stuck alarm on an
      // unchanged premise) — see the module doc above claimWatchdogFire. Equivalent to
      // the prior count(*)-within-window check when the reason differs or repeats
      // haven't accrued: fired_at is monotonically increasing (append-only ledger), so
      // "the latest matching row is within windowHours" ⇔ "any matching row is".
      const rows = await tx<Array<{ reason: string; fired_at: Date; repeat_count: number }>>`
        SELECT reason, fired_at, repeat_count FROM harness_shared.pot_watchdog_fires
        WHERE workspace_id = ${workspaceId} AND install_slug = ${installSlug}
          AND source = ${source}
          AND ${scopeKey ? sql`reason LIKE ${`%${scopeKey}%`}` : sql`TRUE`}
        ORDER BY fired_at DESC
        LIMIT 1`;
      const lastRow = rows[0];
      const decision = computeWatchdogBackoff({
        now: Date.now(),
        baseWindowHours: windowHours,
        capHours: watchdogBackoffCapHours(),
        last: lastRow
          ? {
              reason: lastRow.reason,
              firedAtMs: new Date(lastRow.fired_at).getTime(),
              repeatCount: lastRow.repeat_count ?? 1,
            }
          : null,
        reason,
      });
      if (decision.skip) return false;
      await tx`
        INSERT INTO harness_shared.pot_watchdog_fires
          (workspace_id, install_slug, source, reason, wake_at, demand, repeat_count)
        VALUES (
          ${workspaceId}, ${installSlug}, ${source}, ${reason},
          ${opts.wakeAt ? opts.wakeAt.toISOString() : null}, ${JSON.stringify(opts.demand ?? {})}::text::jsonb,
          ${decision.repeatCount}
        )`;
      return true;
    });
  } catch (e) {
    console.warn(
      `[pot-watchdog] claimWatchdogFire failed (fail-open — proceeding as if unfired): ${e instanceof Error ? e.message : e}`,
    );
    return true;
  }
}

/**
 * Arm the FALLBACK wake for a started pot with none armed. Idempotent and
 * self-checking: re-verifies started + not-already-armed so racing seams
 * (turn-end vs tick) collapse to one arm. Never throws (every caller is a
 * fail-soft seam — a watchdog that crashes its host guards nothing).
 */
export async function armFallbackPotWake(opts: {
  workspaceId: string;
  installSlug: string;
  source: WatchdogSource;
  /** Why the watchdog fired — becomes the kickoff's self-announcement (D-004). */
  reason: string;
  demand?: PotDemand | null;
  now?: number;
}): Promise<FallbackArmResult> {
  const { workspaceId, installSlug, source } = opts;
  try {
    if (!(await getPotStarted(workspaceId, installSlug))) {
      return { outcome: 'skipped', reason: 'pot not started' };
    }
    const { sql } = getOrgPg();
    const live = await potLivenessCheck(sql, installSlug, { workspaceId, now: opts.now });
    if (live.armed) {
      return { outcome: 'skipped', reason: 'a wake is already armed' };
    }

    const kickoff =
      `Watchdog wake (${source}): ${opts.reason} — your previous turn ended without declaring a wake. ` +
      `You are the Mug/operator in charge; survey the frontier and ALWAYS declare your next wake ` +
      `(pot:declare-wake) before ending a turn. Frequent watchdog wakes are a prompt bug to fix.`;

    // P-013: compose with the wake-mode gate. Global `manual` = the owner wants
    // every wake reviewable — route through wakeRecipients to the pinned brain
    // owner, where the shipped gate STAGES it (pending_wakes) instead of firing.
    const { getDefaultWakeMode } = await import('../agent-tools/coordination/wake-mode');
    if ((await getDefaultWakeMode()) === 'manual') {
      const { resolveBrainOwner } = await import('../harness/routines/wake-brain-action');
      // EI-908: the brain pin is workspace-scoped — thread this pot's workspace
      // through so the manual-mode liveness backstop resolves the RIGHT pinned
      // brain (an unscoped call resolved owner against `undefined` → always null
      // → the backstop silently staged nothing).
      const owner = await resolveBrainOwner(workspaceId).catch(() => null);
      if (!owner) {
        const reason = `${opts.reason} (wake-mode manual, no pinned brain — nothing staged)`;
        await recordFire({ workspaceId, installSlug, source, reason, wakeAt: null, demand: opts.demand });
        return { outcome: 'skipped', reason };
      }
      // EI-312 leg 1: a staged wake arms NO time wake, so without this check
      // the `live.armed` idempotence above never engages in manual mode — every
      // seam (boot, 30s tick, turn-end) staged ANOTHER watchdog wake forever.
      // A watchdog wake already sitting in the owner's review queue IS the
      // armed state; mirror the auto-mode "already armed" skip (no fire record).
      const { hasPendingWakeFromSource } = await import('../agent-tools/coordination/pending-wakes');
      if (await hasPendingWakeFromSource(owner, 'pot-watchdog:').catch(() => false)) {
        return { outcome: 'skipped', reason: 'a watchdog wake is already staged for review' };
      }
      const { wakeRecipients } = await import('../agent-tools/coordination/inbox-wake');
      await wakeRecipients([owner], {
        summary: kickoff,
        source: `pot-watchdog:${source}`,
        workspaceId,
      });
      const reason = `${opts.reason} (staged for review: wake-mode manual)`;
      await recordFire({ workspaceId, installSlug, source, reason, wakeAt: null, demand: opts.demand });
      return { outcome: 'staged', reason };
    }

    // Demand-adaptive fallback (2026-07-01): a crashed / non-self-arming Mug WITH standing demand re-wakes
    // FAST (drain the backlog / retry the crash) instead of idling the full 1800s; an IDLE pot keeps the long
    // sleep (and the demand gate means the watchdog never wakes an empty frontier at all). `opts.demand` is the
    // deterministic demand snapshot the caller already computed for the fire record.
    const fallbackSleepSec = opts.demand?.demand ? watchdogDemandSleepSec() : watchdogFallbackSleepSec();
    const at = new Date((opts.now ?? Date.now()) + fallbackSleepSec * 1_000);
    const armed = await declarePotTimeWake(sql, {
      workspaceId,
      installSlug,
      at,
      kickoff,
      ...(opts.now ? { now: new Date(opts.now) } : {}),
    });
    await recordFire({
      workspaceId,
      installSlug,
      source,
      reason: opts.reason,
      wakeAt: armed.at,
      demand: opts.demand,
    });
    return { outcome: 'armed', at: armed.at.toISOString(), reason: opts.reason };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[pot-watchdog] fallback arm failed (${installSlug}, ${source}): ${msg}`);
    return { outcome: 'error', reason: msg };
  }
}

// ── the three seams ──────────────────────────────────────────────────────────

/**
 * P-009 — turn-end hook. Called by the invoke route after a `bpkind=pot`
 * launch finishes: the Mug's turn just ended; if she left no wake armed,
 * arm the fallback. No staleness/demand gate — "turn ended, nothing armed"
 * IS the violation at this seam (the liveness invariant is unconditional
 * while started, D-002). Fail-soft, fire-and-forget from the route.
 */
export async function potTurnEndCheck(opts: { workspaceId: string; installSlug: string }): Promise<FallbackArmResult> {
  // Thread the standing demand so the fallback sleep is DEMAND-ADAPTIVE (a crashed / non-self-arming Mug with
  // a backlog re-wakes in ~2 min, not 30). This is NOT a gate — the turn-end seam still arms unconditionally
  // (D-002); demand only sizes the SLEEP. Fail-soft: a read error → null → the long idle sleep, unchanged.
  const demand = await potDemandCheck(opts.workspaceId).catch(() => null);
  return armFallbackPotWake({
    ...opts,
    source: 'turn-end',
    reason: 'pot turn finished with no next wake armed',
    demand,
  });
}

/**
 * P-010 — boot check (crash recovery: the turn-end hook can't run if the
 * process died mid-turn). For every STARTED pot with no wake armed, arm the
 * fallback. Fail-soft; never blocks boot.
 */
/**
 * P-007 — the RETIREMENT TRANSITION CLEAR
 * (retire-mug-kettle-su-only-2026-08-09, D-004/D-008).
 *
 * Gating `getPotStarted` stops the watchdog ARMING a new wake, but it cannot
 * un-arm one that was already scheduled before the flip. A time wake armed
 * while the tier was live outlives the flag flip and fires afterwards, which is
 * the one way the retirement leaks: the owner turns the Mug off and it wakes up
 * anyway, once, for reasons nothing in the logs explains.
 *
 * So: while the tier is retired, clear any still-armed pot time wake. This is
 * "once on the transition" BY CONSTRUCTION rather than by bookkeeping — the
 * first pass after the flip clears them and every later pass finds nothing to
 * clear, so there is no marker row to get out of sync with reality (and a pass
 * that fails is simply retried by the next one, which a one-shot marker would
 * not be). No-ops entirely while the tier is enabled, so a testing session that
 * flips the flag ON keeps its wakes.
 */
export async function clearRetiredTierWakes(): Promise<{ cleared: number }> {
  let cleared = 0;
  try {
    if (await mugKettleSystemEnabled()) return { cleared: 0 };
    const loops = await listStartedWorkspaceLoops();
    if (loops.length === 0) return { cleared: 0 };
    const { sql } = getOrgPg();
    for (const { workspaceId, installSlug } of loops) {
      const wake = await getPotTimeWake(sql, installSlug, { workspaceId }).catch(() => null);
      if (!wake) continue;
      await clearPotTimeWake(sql, installSlug, { workspaceId });
      cleared += 1;
      console.warn(
        `[pot-watchdog] mug/kettle tier is RETIRED (papercusp-mug-kettle-system OFF) — cleared a ` +
          `wake armed before the flip for ${workspaceId}/${installSlug}, so it cannot fire post-retirement.`,
      );
    }
  } catch (e) {
    // Never throw into boot or the 30s tick; the next pass retries.
    console.warn(`[pot-watchdog] retired-tier wake clear failed: ${e instanceof Error ? e.message : e}`);
  }
  return { cleared };
}

export async function potBootCheck(): Promise<FallbackArmResult[]> {
  const results: FallbackArmResult[] = [];
  try {
    // P-007: un-arm anything scheduled before the retirement flip, BEFORE the
    // arming pass below (which is itself inert while retired).
    await clearRetiredTierWakes();
    // K1 (workspace-scoped-coordination P-003): the de-duped liveness set — ONE
    // loop per workspace when WORKSPACE_COORDINATION is ON, the raw per-pot set
    // (byte-identical) when OFF.
    for (const { workspaceId, installSlug } of await listStartedWorkspaceLoops()) {
      // Demand-adaptive: a host that booted mid-crash with a backlog re-wakes the Mug fast, not in 30 min.
      const demand = await potDemandCheck(workspaceId).catch(() => null);
      results.push(
        await armFallbackPotWake({
          workspaceId,
          installSlug,
          source: 'boot',
          reason: 'host booted; started pot had no wake armed',
          demand,
        }),
      );
    }
  } catch (e) {
    console.warn(`[pot-watchdog] boot check failed: ${e instanceof Error ? e.message : e}`);
  }
  return results;
}

/**
 * P-011 — the routinesTick sweep (every 30s, zero tokens). Fires ONLY when the
 * full invariant is violated: started + demand + no wake armed + not mid-turn
 * + stale (quiet ≥ watchdogStaleSec, or never woken at all). Every condition
 * is a cheap query; the wake it MAY arm is the exception path, not the engine
 * (D-003).
 */
export async function potWatchdogSweep(opts: { now?: number } = {}): Promise<FallbackArmResult[]> {
  const results: FallbackArmResult[] = [];
  try {
    // K1 (workspace-scoped-coordination P-003): ONE loop per workspace when
    // WORKSPACE_COORDINATION is ON; the raw per-pot set (byte-identical) OFF.
    // P-007: while the tier is retired this sweep does no arming (every path
    // below funnels through armFallbackPotWake, which sees started=false) — but
    // it IS the seam that notices the flip without waiting for a reboot, so it
    // owns the transition clear. Returning here also keeps the retired steady
    // state cheap: no per-pot liveness/registry queries every 30s forever.
    if (!(await mugKettleSystemEnabled())) {
      await clearRetiredTierWakes();
      return results;
    }
    const started = await listStartedWorkspaceLoops();
    if (started.length === 0) return results;
    const { sql } = getOrgPg();
    const now = opts.now ?? Date.now();
    for (const { workspaceId, installSlug } of started) {
      const registryState = await registeredPotState(workspaceId, installSlug);
      if (registryState === null) continue;
      if (!registryState) {
        await setPotStarted(workspaceId, installSlug, false, { deliberate: true });
        await clearPotTimeWake(sql, installSlug, { workspaceId });
        await alertMissingStartedPot(workspaceId, installSlug);
        results.push({ outcome: 'skipped', reason: 'started Pot missing from registry; self-cleared' });
        continue;
      }
      const live = await potLivenessCheck(sql, installSlug, { workspaceId, now });
      if (live.armed) continue;
      // Stale gate: a just-finished turn belongs to the turn-end seam; a fresh
      // boot to the boot seam. The sweep only catches the long-quiet case —
      // EXCEPT a pot that has never woken (staleForMs null), which would
      // otherwise never trip the threshold.
      if (live.staleForMs !== null && live.staleForMs < watchdogStaleSec() * 1_000) continue;
      if (await potMidTurn(installSlug)) continue;
      const demand = await potDemandCheck(workspaceId);
      if (!demand.demand) continue;
      results.push(
        await armFallbackPotWake({
          workspaceId,
          installSlug,
          source: 'tick',
          reason:
            `started pot quiet with demand queued ` +
            `(${demand.todoItems} todo item(s), ${demand.startedPlans} started plan(s)) and no wake armed`,
          demand,
          now,
        }),
      );
    }
  } catch (e) {
    console.warn(`[pot-watchdog] sweep failed: ${e instanceof Error ? e.message : e}`);
  }
  return results;
}

// ── P-003 (autonomous-loop-canary-reliability-2026-06-29): paused-pot recovery ─
// The three seams above are STARTED-only — armFallbackPotWake returns early
// ('pot not started') and listStartedWorkspaceLoops omits paused hives. So a pot
// that is PAUSED while real work is queued is a SILENT OUTAGE: nothing re-arms it
// and the health panel only yellowed (the multi-day daily-canary stall that
// motivated this). This sweep is the missing detector — it alerts the owner and
// (unless disabled) auto-resumes a pot paused past the stale threshold WITH
// standing demand. Like potWatchdogSweep it is a cheap deterministic read on the
// 30s tick; the alert/resume is the exception path, not a cadence.

/** A paused pot quiet THIS long (with demand) is treated as a silent outage, not
 *  a deliberate brief pause. Default 24h; env-tunable; <= 0 DISABLES the whole
 *  paused-recovery sweep (kill switch). */
export function pausedRecoveryStaleSec(): number {
  const n = Number(
    process.env.PAPERCUSP_POT_PAUSED_RECOVERY_SEC ?? process.env.PAPERCUSP_POT_PAUSED_RECOVERY_SEC ?? 86_400,
  );
  return Number.isFinite(n) ? n : 86_400;
}

/** Whether a detected silent-paused-outage is AUTO-RESUMED (default) or only
 *  ALERTED. Set PAPERCUSP_POT_PAUSED_AUTO_RESUME=off to alert-without-resuming
 *  (respect a deliberate long pause while still surfacing it loudly; legacy
 *  PAPERCUSP_POT_PAUSED_AUTO_RESUME still accepted). */
export function pausedRecoveryAutoResume(): boolean {
  const v = (process.env.PAPERCUSP_POT_PAUSED_AUTO_RESUME ?? process.env.PAPERCUSP_POT_PAUSED_AUTO_RESUME ?? 'on')
    .trim()
    .toLowerCase();
  return !(v === 'off' || v === '0' || v === 'false');
}

/**
 * PURE: should the paused-recovery sweep ACT on a paused pot this tick? Acts only
 * when we KNOW when it paused (never act blind on a missing timestamp), it has been
 * paused past the stale threshold, it has standing demand, and we have not already
 * fired within the window (debounce, so alert-only mode does not re-fire every 30s).
 * Whether the act is auto-resume or alert-only is the env's call
 * (pausedRecoveryAutoResume), not this decision's.
 */
export function shouldActOnPausedPot(args: {
  pausedAtMs: number | null;
  now: number;
  thresholdMs: number;
  hasDemand: boolean;
  alreadyFiredRecently: boolean;
}): boolean {
  if (args.pausedAtMs == null) return false;
  if (args.now - args.pausedAtMs < args.thresholdMs) return false;
  if (!args.hasDemand) return false;
  if (args.alreadyFiredRecently) return false;
  return true;
}

/** Whether a paused pot should actually be AUTO-RESUMED this sweep (vs
 *  alert-only) — the global knob AND-ed with "this pause wasn't deliberate"
 *  (WI-3261: an owner-initiated pause, e.g. via pot:pause, is never
 *  auto-resumed regardless of the global PAPERCUSP_POT_PAUSED_AUTO_RESUME
 *  knob — "paused past threshold + demand queued" is exactly what an
 *  intentional pause with queued work looks like, so demand can't be the
 *  resume signal for it). Pure so it's testable without the DB. */
export function effectiveAutoResumeForPause(globalAutoResume: boolean, deliberate: boolean): boolean {
  return globalAutoResume && !deliberate;
}

/** Surface a silent paused-outage to the pinned brain owner (best-effort, never
 *  throws) — the alert the old started-only watchdog never sent. */
async function alertOwnerPausedOutage(opts: {
  workspaceId: string;
  installSlug: string;
  reason: string;
  autoResume: boolean;
}): Promise<void> {
  try {
    const { resolveBrainOwner } = await import('../harness/routines/wake-brain-action');
    const owner = await resolveBrainOwner(opts.workspaceId).catch(() => null);
    if (!owner) return;
    const { wakeRecipients } = await import('../agent-tools/coordination/inbox-wake');
    const tail = opts.autoResume
      ? 'Auto-resuming it now. If the pause was intentional, pot:pause again or set PAPERCUSP_POT_PAUSED_AUTO_RESUME=off.'
      : 'Left paused (auto-resume disabled). pot:start to resume.';
    await wakeRecipients([owner], {
      summary: `⚠️ Pot "${opts.installSlug}" ${opts.reason}. ${tail}`,
      source: 'pot-paused-recovery',
      workspaceId: opts.workspaceId,
    });
  } catch (e) {
    console.warn(`[pot-watchdog] paused-outage alert failed: ${e instanceof Error ? e.message : e}`);
  }
}

export interface PausedRecoveryResult {
  workspaceId: string;
  installSlug: string;
  // 'debounced' (EI-6777): the cheap pre-check said act, but the atomic
  // re-check lost the race to a concurrent claim — a real "another racer
  // already fired this window" outcome, distinct from 'skipped' (the
  // non-debounce staleness/demand gate said not to act at all).
  outcome: 'resumed' | 'alerted' | 'skipped' | 'debounced' | 'error';
  reason: string;
  pausedForMs: number | null;
}

async function isRecoverablePausedPot(workspaceId: string, installSlug: string): Promise<boolean> {
  // Workspace-scoped coordination stores the loop bit under the workspace
  // papercup, not a real project slug. That row is valid and must remain
  // recoverable even though it is absent from the project registry.
  if (installSlug === workspaceId) return true;
  try {
    const { loadHarnessRegistry } = await import('../harness-registry');
    const reg = await loadHarnessRegistry(workspaceId);
    return reg.projects.some((p) => p.slug === installSlug && p.harness_kind === 'hive');
  } catch {
    return true;
  }
}

/**
 * The paused-pot recovery sweep (P-003). For each currently-paused pot with a
 * known pause time, past the stale threshold, WITH standing demand, and not already
 * fired this window: alert the owner and (unless disabled) auto-resume + re-arm the
 * wake (armFallbackPotWake now permits it once started=true). Never throws — a
 * watchdog that crashes its host guards nothing.
 */
export async function pausedPotRecoverySweep(opts: { now?: number } = {}): Promise<PausedRecoveryResult[]> {
  const results: PausedRecoveryResult[] = [];
  const staleSec = pausedRecoveryStaleSec();
  if (staleSec <= 0) return results; // kill switch
  try {
    // P-007 (retire-mug-kettle-su-only-2026-08-09): this sweep exists to undo an
    // ACCIDENTAL pause — it writes setPotStarted(true). A retired tier is a
    // DELIBERATE, permanent pause, so auto-resume must not run against it. The
    // resume would be inert (getPotStarted gates false regardless), but "inert"
    // is not good enough here: it would rewrite the started rows on a timer and,
    // per the WI-3261/WI-3309 history below, a resume write WIPES the deliberate
    // pause provenance — so the owner's pause record would be destroyed by a
    // sweep whose own effect no longer applies. Gate it, don't rely on the
    // downstream read.
    if (!(await mugKettleSystemEnabled())) return results;
    const { listPausedPots, setPotStarted } = await import('./started');
    const paused = await listPausedPots();
    if (paused.length === 0) return results;
    const { isWorkspaceCoordinationOn } = await import('../workspace-brain-scope');
    const wsCoordOn = await isWorkspaceCoordinationOn();
    const now = opts.now ?? Date.now();
    const thresholdMs = staleSec * 1_000;
    const windowHours = Math.max(1, Math.round(staleSec / 3_600));
    const globalAutoResume = pausedRecoveryAutoResume();
    for (const { workspaceId, installSlug, pausedAtMs, deliberate } of paused) {
      const pausedForMs = pausedAtMs == null ? null : Math.max(0, now - pausedAtMs);
      // WI-3309 (the Mug auto-unpause RECURRENCE — how the WI-3261 provenance fix
      // was bypassed): under WORKSPACE_COORDINATION the Mug-loop liveness bit
      // this sweep guards is the WORKSPACE PAPERCUP row (installSlug ===
      // workspaceId) ONLY. Every other hive_started row is the PER-POT
      // placement/display bit — an owner Stop for that one pot, with no watchdog
      // seams keyed on it. "Recovering" one is a category error twice over:
      // setPotStarted collapses the resume write onto the papercup, so it (a)
      // re-started the whole workspace loop the owner had deliberately paused and
      // (b) WIPED the papercup's deliberate provenance bit in the same write.
      // With dozens of stale test-pot rows all "paused with demand" (the demand
      // check is workspace-wide), that flipped the owner's pause back on several
      // times a day. Skip per-pot rows entirely — this also matters because the
      // sweep's deliberate bit below is only recorded at the scope setPotStarted
      // writes, so a per-pot row's provenance CANNOT gate a papercup resume.
      if (wsCoordOn && installSlug !== workspaceId) {
        results.push({
          workspaceId,
          installSlug,
          outcome: 'skipped',
          reason:
            'per-pot placement bit, not the workspace loop bit (WI-3309) — never auto-resume material under workspace coordination',
          pausedForMs,
        });
        continue;
      }
      if (!(await isRecoverablePausedPot(workspaceId, installSlug))) {
        results.push({
          workspaceId,
          installSlug,
          outcome: 'skipped',
          reason: 'pot is no longer registered',
          pausedForMs,
        });
        continue;
      }
      const demand = await potDemandCheck(workspaceId).catch(() => ({
        demand: false,
        todoItems: 0,
        startedPlans: 0,
      }));
      const alreadyFiredRecently =
        (await recentWatchdogFires(workspaceId, installSlug, windowHours, 'paused-recovery')) > 0;
      if (!shouldActOnPausedPot({ pausedAtMs, now, thresholdMs, hasDemand: demand.demand, alreadyFiredRecently })) {
        continue;
      }
      // WI-3261: still fires the debounced alert so the owner is reminded work
      // is piling up behind a hold they set — it just never auto-resumes it.
      const autoResume = effectiveAutoResumeForPause(globalAutoResume, deliberate);
      const reason =
        `paused ${pausedForMs == null ? '?' : Math.round(pausedForMs / 3_600_000)}h with demand queued ` +
        `(${demand.todoItems} todo item(s), ${demand.startedPlans} started plan(s)) — ` +
        (deliberate ? 'deliberate owner pause, work queued behind it' : 'silent outage');
      // EI-6777: the cheap `alreadyFiredRecently` read above only tells us
      // whether the OTHER (non-debounce) conditions warrant firing at all —
      // it is racy against a concurrent tick/process doing the same read.
      // Atomically re-check + claim the debounce slot right before the
      // one-time side effect so only one racer ever proceeds past this line.
      const claimedFire = await claimWatchdogFire({
        workspaceId,
        installSlug,
        source: 'paused-recovery',
        windowHours,
        reason,
        wakeAt: null,
        demand,
      });
      if (!claimedFire) {
        results.push({ workspaceId, installSlug, outcome: 'debounced', reason, pausedForMs });
        continue;
      }
      await alertOwnerPausedOutage({ workspaceId, installSlug, reason, autoResume });
      if (!autoResume) {
        // claimWatchdogFire already recorded the fire atomically above —
        // no separate recordFire call here (that was the race this closes).
        results.push({ workspaceId, installSlug, outcome: 'alerted', reason, pausedForMs });
        continue;
      }
      try {
        await setPotStarted(workspaceId, installSlug, true);
        // armFallbackPotWake records the 'paused-recovery' fire (the debounce row).
        await armFallbackPotWake({
          workspaceId,
          installSlug,
          source: 'paused-recovery',
          reason: `auto-resumed after silent pause: ${reason}`,
          demand,
          now,
        });
        results.push({ workspaceId, installSlug, outcome: 'resumed', reason, pausedForMs });
      } catch (e) {
        results.push({
          workspaceId,
          installSlug,
          outcome: 'error',
          reason: `resume failed: ${e instanceof Error ? e.message : String(e)}`,
          pausedForMs,
        });
      }
    }
  } catch (e) {
    console.warn(`[pot-watchdog] paused-recovery sweep failed: ${e instanceof Error ? e.message : e}`);
  }
  return results;
}
