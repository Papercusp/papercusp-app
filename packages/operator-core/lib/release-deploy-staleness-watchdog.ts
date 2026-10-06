/**
 * release-deploy-staleness-watchdog.ts — the release-pipeline stall/staleness
 * RECURRENCE GUARD (WI-1623).
 *
 * WI-1623 root cause (documented in full on the work-item + mug-notify.ts's
 * sibling fix WI-963): the deploy pipeline itself was found to be healthy — the
 * green-checkpoint/release-trigger routines were correctly advancing the green
 * pin and re-deploying `papercup-release` — but the `deployedAtMs` field
 * `release:deploy op:status` / the Deploy panel surface to an agent/operator can
 * get PERSISTENTLY STUCK on a stale value (confirmed live: frozen at the
 * worktree-pointer file's one-time creation mtime instead of the real, per-deploy
 * `HEAD` mtime) with NOTHING catching it — so "the deploy pipeline looks dead"
 * went unnoticed for ~a month even though nothing in the pipeline's OWN state
 * (gate/pin/routine health) was actually red. That silence is the gap this
 * watchdog closes: a deterministic, zero-cost-when-healthy sweep that raises a
 * loud, debounced alert whenever the green pin has been deployable-but-not-live
 * for an unreasonable amount of wall-clock time — REGARDLESS of whether the
 * true cause is a genuinely wedged deploy or (as it turned out here) a lying
 * status field. Either way, an operator should see it, not discover it a month
 * later while chasing something else.
 *
 * Deliberately reuses the EXISTING pure pipeline-status computation
 * (`release-deploy-launch.ts`'s `computeDeployStatus`) rather than re-deriving
 * "is a deploy pending" logic — this watchdog only adds the staleness CLOCK +
 * the alerting/debounce shell around it (same split as the other hive watchdogs:
 * a pure decider unit-tested with no DB, a thin PG sweep wired into the shared
 * 30s `routinesTick`, fail-soft throughout, a `<=0` kill switch).
 *
 * EI-16537 — WHERE THE ALERT GOES. For its first months this sweep's entire output
 * on a stale finding was a `console.warn` plus a `pot_watchdog_fires` ledger row, and
 * that is not an alert: nobody tails server stdout, and the ledger is only read by the
 * improvement collector, which files an EI onto a 1,200-deep backlog. Measured on this
 * box: the sweep fired correctly and repeatedly while the green pin sat 78h → 96h
 * deployable-but-not-live, `harness_escalations` held no row for it, and the EI it did
 * produce went unclaimed for 8 days. So it now ALSO raises the same three rails every
 * sibling pipeline watchdog uses — urgent owner `notifyAttention`, a fleet-wide
 * `broadcastSevereEvent` any running agent can claim, and a durable
 * `harness_escalations` row — one-shot until recovery, with a matching all-clear when
 * the pin ships. See `raiseDeployStalenessAlarm` / `clearDeployStalenessAlarm`.
 */
import { gitPipelineSnapshot } from './git-pipeline-stats';
import { computeDeployStatus, type DeployStateKind } from './release-deploy-launch';
import { claimWatchdogFire, recentWatchdogFires } from './pot/watchdog';
import { operatorHomeHarnessSlug } from './harness/operator-home-harness';

// ── paging rails (EI-16537) ────────────────────────────────────────────────────

/** `harness_escalations.phase` for this watchdog's durable escalation row — its OWN
 *  phase, so it never clobbers the sibling pipeline watchdogs' rows
 *  (`green-checkpoint-watchdog`, `main-behind-staging-watchdog`,
 *  `release-trigger-freeze-watchdog`, `origin-freshness-watchdog`). */
const WATCHDOG_PHASE = 'release-deploy-staleness-watchdog';

/** Stable condition-lifecycle key (WI-1444) — the alarm and its recovery MUST share
 *  it, or the all-clear never supersedes the alarm and a late reader keeps chasing a
 *  condition that cleared hours ago. */
function conditionKeyFor(installSlug: string): string {
  return `release-deploy-staleness:${installSlug}`;
}

// ── tunable (env-overridable, like the other watchdog floors) ─────────────────

/** How long the green pin may sit deployable-but-not-live before this watchdog
 *  alerts. Default 3h (well past the documented ≤15-min auto-deploy cadence —
 *  wide enough to absorb a slow/retrying checkpoint without false-alarming).
 *  `<=0` DISABLES the whole sweep (kill switch). */
export function deployStalenessThresholdSec(): number {
  const n = Number(process.env.PAPERCUSP_DEPLOY_STALENESS_THRESHOLD_SEC ?? 10_800);
  return Number.isFinite(n) ? n : 10_800;
}

// ── pure decider (unit-tested with no DB) ──────────────────────────────────────

export interface DeployStalenessInput {
  /** The pipeline state computed by `computeDeployStatus` — only 'green-deployable'
   *  (green code ahead of live, deployable right now) is a staleness candidate;
   *  every other state (up-to-date, gate-red, gate-wedged, staging-buffered,
   *  unknown) means either nothing is pending or something ELSE already explains
   *  the delay, so this watchdog stays out of their way. */
  state: DeployStateKind;
  /** Epoch ms the live :3070 was last deployed, or null if unresolvable. Since
   *  EI-20101010229759029 this is only the FALLBACK clock (see below). */
  deployedAtMs: number | null;
  /**
   * EI-20101010229759029 — epoch ms at which the pipeline ENTERED `green-deployable`
   * (the transition watermark `recordGreenDeployableTransition` keeps), or null when
   * unresolvable.
   *
   * THIS is the clock the threshold is actually about. The decider's question is
   * "how long has green code been deployable but not live", and `deployedAtMs` age
   * cannot answer it: that clock also runs during RED-GATE windows, when nothing was
   * deployable at all. Measured live 2026-08-10: a 6h red gate went green, the state
   * flipped to `green-deployable`, and `now - deployedAtMs` was ALREADY 5h — so the
   * watchdog fired instantly, reported "deployable but NOT live for 5h", and pulled an
   * agent into diagnosing a wedge that did not exist. The real wait was ~3 MINUTES.
   *
   * That defeats the 3h default's own documented rationale ("well past the ≤15-min
   * auto-deploy cadence — wide enough to absorb a slow/retrying checkpoint without
   * false-alarming"): after any red window longer than the threshold, the alarm is
   * pre-tripped before auto-serve gets a single chance to ship.
   */
  greenDeployableSinceMs?: number | null;
  /** epoch ms "now" — injected so the decider is deterministic in tests. */
  now: number;
  thresholdMs: number;
}

/** WHICH clock produced `ageMs` — a measured wait vs. the inferred fallback. */
export type DeployStalenessAgeBasis = 'green-deployable-since' | 'deployed-at-fallback';

export interface DeployStalenessVerdict {
  stale: boolean;
  /** Human-readable reason — becomes the alert body / the "why not" for a healthy read. */
  reason: string;
  /** How long the condition has held, in ms (null when nothing was measurable). */
  ageMs: number | null;
  /**
   * EI-20101010229759029: which clock `ageMs` came from. 'green-deployable-since' is a
   * MEASURED wait; 'deployed-at-fallback' is an UPPER BOUND that also ran while the gate
   * was red. A reader rendering the age MUST NOT present the fallback as measured — the
   * whole cost of this bug was an inferred number read as an observation.
   */
  ageBasis?: DeployStalenessAgeBasis | null;
}

/** Compact duration for alert prose — hours once past 1h, minutes below it (a fresh
 *  watermark otherwise renders a useless "0h" under a small/env-overridden threshold). */
function formatAge(ms: number): string {
  const hours = ms / 3_600_000;
  if (hours >= 1) return `${Math.round(hours)}h`;
  return `${Math.max(1, Math.round(ms / 60_000))}m`;
}

/**
 * PURE: is the green pin deployable-but-not-live for longer than the threshold?
 * `thresholdMs <= 0` is the kill switch (never stale). A null `deployedAtMs`
 * while green code is waiting is ALSO flagged — "unknown how long" is itself a
 * signal worth surfacing (an unresolvable deploy timestamp on a pipeline that
 * SHOULD be shipping is not a healthy silence).
 */
export function evaluateDeployStaleness(input: DeployStalenessInput): DeployStalenessVerdict {
  if (input.thresholdMs <= 0)
    return { stale: false, reason: 'kill switch (thresholdMs <= 0)', ageMs: null, ageBasis: null };
  if (input.state !== 'green-deployable') {
    return {
      stale: false,
      reason: `pipeline state is '${input.state}', not green-deployable`,
      ageMs: null,
      ageBasis: null,
    };
  }

  // EI-20101010229759029: prefer the CONDITION's own clock; fall back to deployedAt age
  // only when the watermark is unresolvable — and say so downstream, never silently.
  const since = input.greenDeployableSinceMs;
  const haveWatermark = since != null && Number.isFinite(since);
  const haveDeployedAt = input.deployedAtMs != null && Number.isFinite(input.deployedAtMs);

  if (!haveWatermark && !haveDeployedAt) {
    return {
      stale: true,
      reason:
        'green pin is deployable but BOTH clocks are unresolvable (no deployable-since watermark and a null ' +
        'live deploy timestamp) — cannot confirm the pipeline is actually shipping; treating an unknown wait ' +
        'as stale rather than assuming health.',
      ageMs: null,
      ageBasis: null,
    };
  }

  const ageBasis: DeployStalenessAgeBasis = haveWatermark ? 'green-deployable-since' : 'deployed-at-fallback';
  const ageMs = input.now - (haveWatermark ? (since as number) : (input.deployedAtMs as number));
  const thresholdHours = Math.max(1, Math.round(input.thresholdMs / 3_600_000));

  if (ageMs < input.thresholdMs) {
    return {
      stale: false,
      reason: haveWatermark
        ? `green code has been deployable for ${formatAge(ageMs)} — under the ${thresholdHours}h threshold`
        : `deployedAt age ${formatAge(ageMs)} is under the threshold (no deployable-since watermark; inferred)`,
      ageMs,
      ageBasis,
    };
  }

  if (!haveWatermark) {
    // The honest rendering of the fallback: an upper bound, explicitly not a measured wait.
    return {
      stale: true,
      reason:
        `green pin is deployable but the deployable-since watermark is unresolvable, so this age is measured ` +
        `from the LAST DEPLOY (${formatAge(ageMs)}) — an UPPER BOUND that also runs while the gate is red, ` +
        `NOT a measured wait. It is >= the ${thresholdHours}h threshold, but treat the duration as inferred: ` +
        `check the gate's own red/green history for this window before concluding the pipeline is wedged.`,
      ageMs,
      ageBasis,
    };
  }

  return {
    stale: true,
    reason:
      `green pin has been deployable-but-not-live for ${formatAge(ageMs)} (>= the ${thresholdHours}h threshold) — ` +
      `the release-trigger routine (documented ≤15-min cadence) should have shipped it long ago. Either the ` +
      `pipeline is genuinely wedged (check routines:list for release-trigger/green-checkpoint health) or the ` +
      `deployedAt field itself is stale/lying (compare against the release checkout's actual git state ` +
      `on disk before assuming a real stall).`,
    ageMs,
    ageBasis,
  };
}

// ── the green-deployable transition watermark (EI-20101010229759029) ───────────

/** `operator_settings` KV key for the deployable-since watermark. Keyed by install
 *  slug ALONE — the same scope as this watchdog's `harness_escalations` latch row, and
 *  the scope the read-only collector (`release-deploy-staleness-detect.ts`) can build
 *  without a workspaceId it deliberately does not carry. */
function greenSinceKey(installSlug: string): string {
  return `release_deploy_green_deployable_since:${installSlug}`;
}

function parseWatermark(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * READ the deployable-since watermark without touching it — for consumers that only
 * report on the condition (the improvement collector) rather than tick it.
 */
export async function readGreenDeployableSince(installSlug: string): Promise<number | null> {
  try {
    const { getOrgPg } = await import('@papercusp/db-org');
    const { sql } = getOrgPg();
    const rows = await sql<{ value?: string }[]>`
      SELECT value FROM harness_shared.operator_settings WHERE key = ${greenSinceKey(installSlug)} LIMIT 1`;
    return parseWatermark((rows[0] as { value?: string } | undefined)?.value);
  } catch {
    return null; // fail-soft: an unreadable watermark degrades to the labelled fallback clock
  }
}

/**
 * TICK the watermark and return the effective deployable-since epoch ms.
 *
 * The sweep owns this clock: while the pipeline sits in `green-deployable` the FIRST
 * observation of the current contiguous run is retained; any other state ends the run and
 * clears it, so re-entry always starts a fresh clock. Accuracy is therefore one sweep tick
 * (~30s) against a 3h default threshold.
 *
 * Reuses the existing `operator_settings` KV + its `ON CONFLICT (key)` upsert (the home of
 * `hive_started` / the overwatch control bits) — no migration, per the storage policy.
 *
 * The clearing DELETE matches zero rows on a routinely-healthy tick, exactly like
 * `clearDeployStalenessAlarm`'s UPDATE — a PK-indexed no-op, not a per-tick cost worth
 * avoiding. Fail-soft: any KV failure returns null, and a null degrades to the FALLBACK
 * clock, which labels itself as inferred rather than pretending to be measured.
 */
export async function recordGreenDeployableTransition(opts: {
  workspaceId: string;
  installSlug: string;
  state: DeployStateKind;
  now: number;
}): Promise<number | null> {
  const { workspaceId, installSlug, state, now } = opts;
  const key = greenSinceKey(installSlug);
  try {
    const { getOrgPg } = await import('@papercusp/db-org');
    const { sql } = getOrgPg();
    if (state !== 'green-deployable') {
      await sql`DELETE FROM harness_shared.operator_settings WHERE key = ${key}`;
      return null;
    }
    const rows = await sql<{ value?: string }[]>`
      SELECT value FROM harness_shared.operator_settings WHERE key = ${key} LIMIT 1`;
    const prev = parseWatermark((rows[0] as { value?: string } | undefined)?.value);
    if (prev != null) return prev;
    // First tick of this run (or a repair of a garbage value). Two sweeps racing the entry
    // tick can differ by at most one tick, and the later value only ever makes the watchdog
    // MORE conservative (younger age ⇒ less likely to fire) — the safe direction for a bug
    // whose entire cost was false alarms.
    await sql`
      INSERT INTO harness_shared.operator_settings (key, value, description, updated_at, workspace_id)
      VALUES (${key}, ${String(now)}, ${'epoch ms the release pipeline entered green-deployable (EI-20101010229759029)'}, ${now}, ${workspaceId})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`;
    return now;
  } catch (e) {
    console.warn(
      `[release-deploy-staleness] deployable-since watermark failed (non-fatal): ${e instanceof Error ? e.message : e}`,
    );
    return null;
  }
}

// ── the PG sweep ────────────────────────────────────────────────────────────────

export interface DeployStalenessSweepResult {
  outcome: 'alerted' | 'skipped' | 'healthy' | 'error';
  verdict?: DeployStalenessVerdict;
  reason: string;
  /** EI-16537: this pass raised the paging rails (owner toast + fleet broadcast +
   *  escalation row). `false` on an `alerted` outcome means the episode was already
   *  paged — the rails are one-shot until recovery, unlike the ledger leg. */
  paged?: boolean;
  /** EI-16537: this pass RETRACTED a previously-raised page (the pipeline caught up). */
  recovered?: boolean;
}

/**
 * EI-16537 — raise the rails that actually reach somebody: an urgent owner
 * `notifyAttention`, a fleet-wide severe-event broadcast any running agent can claim,
 * and a durable `harness_escalations` row. Exactly the trio every sibling pipeline
 * watchdog already uses (`checkGreenStall`, `checkMainBehindStaging`,
 * `checkOriginFreshness`, `checkGitSyncStall`).
 *
 * Why it had to be added: this sweep's ONLY output on a stale finding was a
 * `console.warn` plus a `pot_watchdog_fires` ledger row. Neither reaches a human or an
 * agent — server stdout nobody tails, and a ledger only the improvement collector
 * reads. That is not a theory: on this box the sweep fired correctly and repeatedly
 * while the green pin sat **78h → 96h** deployable-but-not-live (ledger rows
 * 2026-07-24/25), `harness_escalations` never held a single row for this phase, and
 * the one artifact it did produce — EI-16537 — sat unclaimed for 8 days and had to be
 * severity-bumped to critical by an aging sweep before anyone looked. A detector whose
 * output nobody reads is not a detector.
 *
 * ONE-SHOT until recovery — the escalation row's own presence is the latch, the same
 * idiom as `checkMainBehindStaging`. The ledger/EI leg keeps its independent 3h
 * debounce + geometric backoff untouched; the human/fleet page fires once per episode
 * instead of on every backoff tick. Fail-soft throughout: a paging failure must never
 * break the sweep that raised it.
 */
async function raiseDeployStalenessAlarm(opts: {
  workspaceId: string;
  installSlug: string;
  verdict: DeployStalenessVerdict;
  now: number;
}): Promise<boolean> {
  const { workspaceId, installSlug, verdict, now } = opts;
  try {
    const { getOrgPg } = await import('@papercusp/db-org');
    const { sql } = getOrgPg();
    const existing = await sql<{ escalation: unknown }[]>`
      SELECT escalation FROM harness_shared.harness_escalations
       WHERE harness_slug = ${installSlug} AND phase = ${WATCHDOG_PHASE}`;
    if (existing.length > 0 && existing[0].escalation != null) return false; // already paged this episode

    const ageHours = verdict.ageMs != null ? Math.round(verdict.ageMs / 3_600_000) : null;
    // EI-20101010229759029: the broadcast's own summary line was the sentence that read
    // FALSE ("deployable but NOT live for 5h" when the real wait was ~3 minutes). Never
    // state a fallback age as an observation — the qualifier travels with the number.
    const ageText =
      verdict.ageMs == null
        ? 'an unknown length of time'
        : verdict.ageBasis === 'deployed-at-fallback'
          ? `an unmeasured time (last deploy was ${formatAge(verdict.ageMs)} ago — an upper bound, not the wait)`
          : formatAge(verdict.ageMs);

    try {
      const { notifyAttention } = await import('./attention-notify');
      await notifyAttention({
        kind: 'intervention',
        title: 'Release pipeline STALLED — green code is deployable but not live',
        body: verdict.reason,
        importance: 'urgent',
        workspaceId,
        harnessSlug: installSlug,
        data: { ageHours, installSlug },
      });
    } catch (e) {
      console.warn(`[release-deploy-staleness] notify failed: ${e instanceof Error ? e.message : e}`);
    }

    const { broadcastSevereEvent } = await import('./severe-event-broadcast');
    await broadcastSevereEvent({
      summary:
        `release deploy STALLED on ${installSlug} — green code has been deployable but NOT live for ${ageText}; ` +
        `owner-facing features may be invisible right now.`,
      body:
        `${verdict.reason}\n\nClaim it: check \`routines:list\` for release-trigger / green-checkpoint health, then ` +
        `compare the release checkout's ACTUAL on-disk git state against the reported deployedAt before assuming a ` +
        `genuinely wedged pipeline — WI-1623's original root cause was a LYING deployedAt field, not a stalled ` +
        `deploy, and the two need opposite fixes. Once you know which it is, force the deploy with ` +
        `\`PAPERCUSP_ALLOW_DEV_RESTART=1 npx tsx apps/operator/lib/release/deploy-cli.ts --execute\`.`,
      category: 'severe-event',
      conditionKey: conditionKeyFor(installSlug),
      // WI-6228: one-shot until recovery (the escalation-row latch above). Declaring it
      // stops the condition-staleness reconciler from reading this sweep's deliberate
      // silence as "the pin shipped" — a guaranteed false green for any one-shot
      // condition outlasting the reconciler's absence window.
      oneShot: true,
    });

    try {
      await sql`
        INSERT INTO harness_shared.harness_escalations (harness_slug, phase, escalation, mtime_ms, workspace_id)
        VALUES (${installSlug}, ${WATCHDOG_PHASE}, ${JSON.stringify({
          kind: WATCHDOG_PHASE,
          harness_slug: installSlug,
          ageHours,
          detail: verdict.reason,
          emitted_at: now,
        })}, ${now}, ${workspaceId})
        ON CONFLICT (harness_slug, phase)
        DO UPDATE SET escalation = EXCLUDED.escalation, mtime_ms = EXCLUDED.mtime_ms`;
    } catch (e) {
      console.warn(`[release-deploy-staleness] escalation write failed: ${e instanceof Error ? e.message : e}`);
    }
    return true;
  } catch (e) {
    console.warn(`[release-deploy-staleness] alarm failed (non-fatal): ${e instanceof Error ? e.message : e}`);
    return false;
  }
}

/**
 * EI-16537 — the recovery leg. A pipeline that caught back up must RETRACT its page,
 * or an agent waking hours later burns a turn investigating a dead condition (the exact
 * cost WI-1444's condition lifecycle exists to remove).
 *
 * Idempotent and cheap: one indexed UPDATE that matches zero rows on a routinely-healthy
 * tick, so a healthy pipeline still broadcasts nothing. The UPDATE's own row count is the
 * "were we alarmed?" test — no check-then-act read to race against a concurrent sweep.
 */
async function clearDeployStalenessAlarm(opts: { installSlug: string; now: number }): Promise<boolean> {
  const { installSlug, now } = opts;
  try {
    const { getOrgPg } = await import('@papercusp/db-org');
    const { sql } = getOrgPg();
    const cleared = await sql`
      UPDATE harness_shared.harness_escalations
         SET escalation = NULL, mtime_ms = ${now}
       WHERE harness_slug = ${installSlug}
         AND phase = ${WATCHDOG_PHASE}
         AND escalation IS NOT NULL`;
    if (cleared.count === 0) return false;
    const { broadcastSevereEventResolved } = await import('./severe-event-broadcast');
    await broadcastSevereEventResolved({
      conditionKey: conditionKeyFor(installSlug),
      summary:
        `release deploy RECOVERED on ${installSlug} — the green pin is live again; the earlier stall alarm is stale.`,
    });
    return true;
  } catch (e) {
    console.warn(`[release-deploy-staleness] recovery failed (non-fatal): ${e instanceof Error ? e.message : e}`);
    return false;
  }
}

/**
 * The release-deploy staleness sweep. Reuses `gitPipelineSnapshot` +
 * `computeDeployStatus` (no re-derived pipeline logic), evaluates staleness, and
 * — debounced per the existing `hive_watchdog_fires` ledger (source
 * 'release-deploy-staleness') — durably records + logs a loud alert. Never
 * throws (a watchdog that crashes its host guards nothing); default-safe (a
 * healthy pipeline is a complete no-op). Kill switch:
 * PAPERCUSP_DEPLOY_STALENESS_THRESHOLD_SEC <= 0.
 */
export async function releaseDeployStalenessSweep(opts: {
  now?: number;
  workspaceId?: string;
  installSlug?: string;
}): Promise<DeployStalenessSweepResult> {
  const thresholdSec = deployStalenessThresholdSec();
  if (thresholdSec <= 0) return { outcome: 'skipped', reason: 'kill switch' };
  const workspaceId = opts.workspaceId ?? 'papercusp-workspace';
  const installSlug = opts.installSlug ?? (process.env.RELEASE_ROUTINE_SLUG ?? operatorHomeHarnessSlug());
  const now = opts.now ?? Date.now();
  try {
    const snap = await gitPipelineSnapshot(installSlug);
    const status = computeDeployStatus(snap);
    // EI-20101010229759029: tick the condition's own clock BEFORE deciding — entering
    // green-deployable starts it, leaving it (a shipped pin, a red gate) clears it.
    const greenDeployableSinceMs = await recordGreenDeployableTransition({
      workspaceId,
      installSlug,
      state: status.state,
      now,
    });
    const verdict = evaluateDeployStaleness({
      state: status.state,
      deployedAtMs: status.deploy.deployedAtMs,
      greenDeployableSinceMs,
      now,
      thresholdMs: thresholdSec * 1_000,
    });
    if (!verdict.stale) {
      // EI-16537: "not stale" includes transient states such as deploy-in-flight and
      // gate-red; those do not prove that :3070 has caught up to the green pin. Retract
      // the page only when the measured live-to-pin gap is exactly zero. A positive or
      // unknown gap keeps the existing alarm latched until the pin is actually live.
      const recovered =
        status.deploy.deployedBehindGreenPin === 0
          ? await clearDeployStalenessAlarm({ installSlug, now })
          : false;
      return { outcome: 'healthy', verdict, reason: verdict.reason, recovered };
    }

    const windowHours = Math.max(1, Math.round(thresholdSec / 3_600));
    // EI-16038: cheap non-atomic pre-check (avoid the transaction round-trip on the
    // common healthy-pipeline tick) — the atomic claim below is authoritative and also
    // applies geometric backoff when the staleness reason keeps re-firing unchanged.
    const alreadyFiredRecently =
      (await recentWatchdogFires(workspaceId, installSlug, windowHours, 'release-deploy-staleness')) > 0;
    if (alreadyFiredRecently) {
      return { outcome: 'skipped', verdict, reason: 'debounced' };
    }

    const reason = `deploy staleness: ${verdict.reason}`;
    // EI-6777/EI-16038: claim the atomic debounce slot (closes the check-then-act race
    // the old recentWatchdogFires+recordFire pattern had, and backs off geometrically
    // once this exact reason has repeated) BEFORE alerting — only the winner alerts.
    const claimed = await claimWatchdogFire({ workspaceId, installSlug, source: 'release-deploy-staleness', windowHours, reason, wakeAt: null });
    if (!claimed) {
      return { outcome: 'skipped', verdict, reason: 'debounced (raced or backed off)' };
    }
    // EI-16537: the alert must LEAVE this process. The console.warn below is kept as the
    // local trace; the paging rails are what a human or an agent actually sees.
    const paged = await raiseDeployStalenessAlarm({ workspaceId, installSlug, verdict, now });
    console.warn(`[release-deploy-staleness] ALERT: ${reason}`);
    return { outcome: 'alerted', verdict, reason, paged };
  } catch (e) {
    return { outcome: 'error', reason: e instanceof Error ? e.message : String(e) };
  }
}
