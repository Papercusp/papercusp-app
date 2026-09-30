/**
 * ready-plan-autostart.ts — the Queen↔Scout feedback-loop MISSING CONSUMER of
 * `ready` (WI-1574, 2026-07-02).
 *
 * ⚠ WHO RATIFIES, POST-RETIREMENT (blender-su-grade-integration-2026-08-11 P-012/D-008).
 * "Ratifying IS the approval signal" — the premise this whole sweep rests on — named the
 * QUEEN as the ratifier. She is retired, which briefly left that premise with nobody
 * behind it: a `ready` flip still auto-promotes items into the claimable pool with no
 * second gate, but nothing said who may perform the flip.
 *
 * The named approver is now the Blender STEWARD (the GOAL holder). There is NO SIZE
 * LIMIT on what it may ratify [owner 2026-08-11] — a draft of any item count is
 * eligible — but TWO conditions still bind: nothing in the dangerous set (irreversible
 * migration / outward-facing publish/send / fleet-autonomy escalation / auth/security /
 * kill-switch), and never a draft whose idea the steward filed itself. Anything failing
 * either check escalates to the owner instead of being ratified.
 *
 * ⚠ Those two conditions are the ENTIRE safety margin — the item cap that used to sit in
 * front of them was lifted deliberately. They now have DIFFERENT enforcement status, and
 * conflating them (as this comment did until 2026-09-05) reads as though neither is live:
 *
 *   - (2) never a self-filed draft — ENFORCED since WI-38047, though not HERE. The check
 *     runs upstream at the `ready` flip itself (`plans:set-plan-status` →
 *     `scout/ratification-gate.ts`), which refuses BEFORE the write, so a self-ratified
 *     plan never reaches this sweep. Nothing below inspects who originated a plan because
 *     by this point it cannot be a self-ratification.
 *   - (1) nothing in the dangerous set — ACCEPTED DOCTRINE [D-026, 2026-09-05, WI-38057],
 *     enforced by the steward's adherence alone. Accepted on a measurement, not a shrug:
 *     keyword classification of the live plan-rail corpus flagged 30/30 with 0 true
 *     positives (precision 0.00), because the dangerous-set vocabulary is this codebase's
 *     ordinary vocabulary. It is NOT pending implementation — see ratification-gate.ts's
 *     header for the full rationale and what would reopen it.
 *
 * So: a known-and-ACCEPTED gap on (1), a live guard on (2) — neither is a guarantee that
 * a ratified draft is safe to promote. The decompose-wake
 * below (`source='scout-ready-decompose'`) likewise now targets the nudge ladder rather
 * than a Queen lookup. Read every "Queen" below as "the ratifying steward".
 *
 * THE DEAD END (root cause this closes): the review loop's terminal state is
 * `ready` ("Queen promotes to greenlight") — but NOTHING ever consumed `ready`.
 * Evidence at time of writing: scout_routed_ideas rail='plan' had 6 routes, all
 * outcome='pending' since 2026-06-11; harness_plans had scout plans at
 * ready/active/shipped; yet ZERO work_items in history carried
 * `source_plan_slug like 'scout-%'`. The Queen ratified drafts and the chain
 * stopped there: no `plans:start`, so `promotePlanItems` never ran, so the
 * Queen's survey never saw a single item from a scout-born plan — the full
 * circuit (observation → scout → plan → queen places → bee completes) has
 * NEVER closed through the plan rail.
 *
 * Two teeth were missing:
 *   1. No consumer of `ready` — closed HERE: a deterministic, zero-token sweep
 *      on the 30s routinesTick (the draft-review-watchdog shape) auto-STARTS a
 *      ratified (status='ready', never-started) scout plan: op_status='started'
 *      + `promotePlanItems` → work_items (stamped with source_plan_slug) → the
 *      Queen's normal survey/demand path takes over. Ratifying IS the approval
 *      signal (mirrors plans:start's own "starting is the approval" doctrine),
 *      so auto-starting a ratified plan fakes nothing.
 *   2. Drafts carried no items (the template deferred them to "once greenlit",
 *      which nobody did) — closed in scout-plan-draft.ts: the template now
 *      seeds P-001 from the proposal so a ratified plan is startable. A ready
 *      plan that STILL has no open items is not startable — the sweep fires a
 *      debounced Queen wake to decompose it (source='scout-ready-decompose')
 *      instead of silently skipping (no new dead end).
 *
 * WORKSPACE NUANCE (latent trap found during WI-1574): scout plan rows live
 * under the hive's OWN workspace (e.g. 'papercusp-workspace'), while the
 * `plans:start` tool's UPDATE is pinned to DEFAULT_WORKSPACE_ID — so even a
 * dutiful Queen calling plans:start would MISS the scout plan's op-status row.
 * This sweep scopes every read/write to the started hive's own workspaceId
 * (same as readScoutDraftCandidates).
 *
 * Watchdog conventions (mirrors draft-review-watchdog.ts): pure deciders split
 * from the PG sweep, env kill switch, per-hive debounce over
 * `hive_watchdog_fires` for the WAKE path, fail-soft throughout.
 *
 * ⚠ THE op_status WRITE IS GATED (retire-mug-kettle-su-only-2026-08-09 P-070 /
 * D-064), mirroring plans:start (P-047 / D-010). op_status is the OPERATIONAL
 * axis — it RESERVES a plan's items from su self-selection on the premise that a
 * dispatcher hands them out — and it retires with the Mug/Kettle tier. While the
 * tier is retired (the delivered default) this sweep does everything it always
 * did EXCEPT write op_status: it still reads the row, still calls
 * `promotePlanItems`, still fires the decompose-wake. Promotion is the
 * su-SERVING half and is what closes WI-1574's dead end; the axis write is the
 * half that would strand what it just promoted.
 *
 * THE LATCH, and why the retired branch needs a different one. The START path
 * used to need no debounce because the op_status write WAS the latch: a started
 * plan stops matching the selector (`op_status <> 'started'`), so the sweep was
 * naturally once-only. Skip the write and that latch disappears — the plan stays
 * selected and the 30s routinesTick re-enters it forever. So the retired branch
 * claims a per-plan debounce over the same `pot_watchdog_fires` ledger the WAKE
 * path uses (`source: 'scout-ready-autostart'`, scoped by plan slug). Re-entry is
 * not incorrect — `promotePlanItems` is idempotent (`listCoveredPlanItemRefs`
 * skips anything already covered by an implements/relates edge or a
 * `payload.plan_item` stamp) — it is UNBOUNDED, which is the thing worth
 * stopping. The debounce's geometric backoff on an unchanged premise makes the
 * retired latch strictly BETTER than the op_status one it replaces: items added
 * to an already-ratified plan eventually reach the queue instead of being locked
 * out forever by a one-way bit.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import {
  listBlenderMaintenanceScopes,
  listBlenderMaintenanceWorkspaceIds,
  mugKettleSystemEnabled,
} from '../pot/started';
import { resolveMugOwner } from '../pot/placement-watchdog';
import { deliverScoutNudge } from './nudge-recipient';
import { claimWatchdogFire, recentWatchdogFires } from '../pot/watchdog';
import { promotePlanItems } from '../plan-workitem-promotion-run';
import { routineStorageSlug } from '../pot-membership';
import { BLENDER_PLAN_SQL_PATTERN } from '../agent-tools/plans/plan-provenance';
import { checkPlanAdmission, type PlanAdmissionRefusal } from '../agent-tools/plans/plan-admission-gate';

// ── tunables ──────────────────────────────────────────────────────────────────

/** Kill switch: PAPERCUSP_SCOUT_READY_AUTOSTART=0 disables the whole sweep. */
export function scoutReadyAutostartEnabled(): boolean {
  return process.env.PAPERCUSP_SCOUT_READY_AUTOSTART !== '0';
}

// ── pure deciders (unit-tested with no DB) ────────────────────────────────────

/** One ratified-but-never-started scout plan (status='ready', op_status ≠ 'started'). */
export interface ScoutReadyCandidate {
  planSlug: string;
  title: string | null;
  /** Does the plan body contain at least one open item (`- **P-NNN** \`todo|wip\``) to promote? */
  hasOpenItems: boolean;
  /** Does the body contain any canonical P-NNN item, including terminal ones? */
  hasAnyItems: boolean;
}

/** PURE: split ready candidates into startable (open items → auto-start), truly
 * itemless (zero items ever → decompose), and finished (items exist but all are
 * terminal → completion flow owns them; never add work at the ship gate). */
export function partitionReadyCandidates(candidates: readonly ScoutReadyCandidate[]): {
  startable: ScoutReadyCandidate[];
  itemless: ScoutReadyCandidate[];
  finished: ScoutReadyCandidate[];
} {
  const startable: ScoutReadyCandidate[] = [];
  const itemless: ScoutReadyCandidate[] = [];
  const finished: ScoutReadyCandidate[] = [];
  for (const c of candidates) {
    if (c.hasOpenItems) startable.push(c);
    else if (!c.hasAnyItems) itemless.push(c);
    else finished.push(c);
  }
  return { startable, itemless, finished };
}

// ── the PG sweep ──────────────────────────────────────────────────────────────

interface ReadyRow {
  plan_slug: string;
  title: string | null;
  has_open_items: boolean;
  has_any_items: boolean;
}

/** Read this hive's ratified-but-never-started scout plans. Same scoping rules as
 *  readScoutDraftCandidates: the hive's OWN workspaceId; scout-origin read from the
 *  plan's own frontmatter.
 *
 *  ⚠ `planStorageSlug` is the slug plans are STORED under, NOT a routine's raw
 *  `installSlug` (WI-6978). harness_plans is Hive-scoped: the write path collapses a
 *  member harness to its Hive home (resolvePlanScope → potHomeSlugForHarness), so a
 *  member's raw slug matches zero rows here — silently, since "no ready plans" is
 *  also the healthy answer. The sweep resolves it once via routineStorageSlug and
 *  passes the result in; keep it that way rather than re-deriving from installSlug. */
export async function readScoutReadyCandidates(
  sql: Sql,
  planWorkspaceId: string,
  planStorageSlug: string,
  opts: { limit?: number } = {},
): Promise<ScoutReadyCandidate[]> {
  const limit = opts.limit ?? 20;
  // Item syntax note (verified live 2026-07-02): plans:add-item writes
  // `- **P-001** \`todo\` <text>` — NOT a `- [ ]` checkbox. Match the canonical
  // marker with an OPEN status (todo|wip).
  const rows = await sql<ReadyRow[]>`
    SELECT plan_slug, title,
           (content ~ ('- [*][*]P-[0-9]+[*][*] ' || chr(96) || '(todo|wip)' || chr(96))) AS has_open_items,
           (content ~ '- [*][*]P-[0-9]+[*][*] ') AS has_any_items
      FROM harness_shared.harness_plans
     WHERE workspace_id = ${planWorkspaceId}
       AND harness_slug = ${planStorageSlug}
       AND status = 'ready'
       AND archived = false
       AND (op_status IS NULL OR op_status <> 'started')
       AND content LIKE ${BLENDER_PLAN_SQL_PATTERN}
       AND (
         content ~ ('- [*][*]P-[0-9]+[*][*] ' || chr(96) || '(todo|wip)' || chr(96))
         OR NOT (content ~ '- [*][*]P-[0-9]+[*][*] ')
       )
     ORDER BY updated_at ASC
     LIMIT ${limit}`;
  return rows.map((r) => ({
    planSlug: r.plan_slug,
    title: r.title,
    hasOpenItems: Boolean(r.has_open_items),
    hasAnyItems: Boolean(r.has_any_items),
  }));
}

/**
 * What one ratified scout plan's start attempt actually DID. An outcome rather
 * than a boolean, deliberately (the P-071 lesson): the retired branch promotes
 * WITHOUT entering the axis, and a two-valued `transitioned` cannot express that
 * — it collapses "promoted, axis retired" into the same `false` as "already
 * started, did nothing", which is how a caller ends up reporting a no-op for a
 * call that just filled the queue.
 */
export type ReadyScoutStartOutcome =
  /** Axis LIVE: op_status='started' written + items promoted. */
  | 'started'
  /** Axis RETIRED: items promoted, op_status deliberately NOT written. */
  | 'promoted'
  /** The row is already on the axis (a race, or a pre-retirement start). */
  | 'already-started'
  /** No such plan row in this workspace/harness. */
  | 'plan-not-found'
  /**
   * P-004: the pot's governance has not admitted this exact plan revision. Distinct
   * from every other outcome here because nothing was attempted — no promotion, no
   * axis write — and the remedy is a ratification round rather than anything about
   * this sweep.
   */
  | 'not-admitted';

export interface ReadyScoutStartResult {
  outcome: ReadyScoutStartOutcome;
  promoted: number;
  /** PLAN_WORKITEM_PROMOTION is OFF — promotion ran but minted nothing. */
  flagOff: boolean;
  /** Did THIS call put the plan onto the retired op_status axis? */
  axisWritten: boolean;
  /** Promotion was refused because the plan is missing required spec-triad legs. */
  specTriadBlocked?: true;
  /** The missing spec-triad legs, when promotion was refused. */
  specTriadMissing?: string[];
  /** The repair work-item filed by the promotion refusal, if any. */
  specTriadWorkItem?: string | null;
  /** Full admission evidence for a 'not-admitted' outcome (P-004). */
  admission?: PlanAdmissionRefusal;
}

/** Start ONE ratified scout plan in the hive's own workspace: promote its items
 *  into work_items, and — only while the Mug/Kettle tier is live — mark
 *  op_status='started' (idempotent: COALESCE keeps the first started_at).
 *  Mirrors plans:start's core (P-047 gate included) but workspace-correct for
 *  scout plans (see module header).
 *
 *  ⚠ The gate is FAIL-CLOSED and defaults to reading the flag itself, so a future
 *  caller that forgets to pass `deps` gets the SAFE behaviour rather than an
 *  ungated write. `mugKettleSystemEnabledFn` exists for the sweep (which resolves
 *  the flag once per sweep instead of once per plan) and for tests. */
export async function startReadyScoutPlan(
  sql: Sql,
  args: { workspaceId: string; planStorageSlug: string; planSlug: string },
  deps: { mugKettleSystemEnabledFn?: () => Promise<boolean> } = {},
): Promise<ReadyScoutStartResult> {
  // P-004 admission, FIRST — before the axis read, the promotion, and the
  // op_status='started' write below. This sweep is the one door with no human in
  // front of it: it turns a `ready` flip into claimable work on its own schedule, so
  // an unadmitted revision here becomes work the whole fleet picks up before anyone
  // notices. It reaches none of the other wiring sites (it runs its own SQL and calls
  // no plan-start-gate entrypoint), which is exactly why it needs its own call.
  //
  // The revision hash is read through THIS function's own `sql` rather than left to
  // the gate's default loader. Two reasons, and the second is the load-bearing one:
  // the gate's loader opens its own connection (which this sweep's caller does not
  // own), and a separate read could return a NEWER revision than the one this sweep
  // is about to promote — admitting a revision nobody is starting.
  const revRows = await sql<{ content_hash: string | null }[]>`
    SELECT content_hash
      FROM harness_shared.harness_plans
     WHERE workspace_id = ${args.workspaceId}
       AND harness_slug = ${args.planStorageSlug}
       AND plan_slug    = ${args.planSlug}`;
  if (revRows.length === 0)
    return { outcome: 'plan-not-found', promoted: 0, flagOff: false, axisWritten: false };
  const admission = await checkPlanAdmission({
    slug: args.planSlug,
    door: 'autostart',
    opts: { workspaceId: args.workspaceId, harnessSlug: args.planStorageSlug },
    planRevisionHash: revRows[0].content_hash ?? '',
  });
  if (!admission.admitted) {
    return {
      outcome: 'not-admitted',
      promoted: 0,
      flagOff: false,
      axisWritten: false,
      admission: admission.refusal,
    };
  }

  // P-070 / D-064: op_status is the OPERATIONAL axis and retires with the tier.
  // Fail-CLOSED — mugKettleSystemEnabled's own catch resolves an unreadable flag
  // to retired, because a false `true` reserves freshly-promoted items for a
  // dispatcher that no longer runs, while a false `false` merely leaves a
  // deliberately-retired axis unwritten.
  const axisLive = deps.mugKettleSystemEnabledFn
    ? await deps.mugKettleSystemEnabledFn()
    : await mugKettleSystemEnabled();
  const now = new Date().toISOString();
  // Both branches return the row's PRIOR op_status under the same column name, so
  // the already-started race check below is identical either way. The retired
  // branch is a plain read: same rows, same scoping, no write.
  const rows = axisLive
    ? await sql<{ prev_op_status: string | null }[]>`
        UPDATE harness_shared.harness_plans AS p
           SET op_status     = 'started',
               op_started_at = COALESCE(p.op_started_at, ${now}),
               op_updated_at = ${now}
          FROM (
            SELECT plan_slug, op_status AS prev_op_status
              FROM harness_shared.harness_plans
             WHERE workspace_id = ${args.workspaceId}
               AND harness_slug = ${args.planStorageSlug}
               AND plan_slug    = ${args.planSlug}
               FOR UPDATE
          ) prev
         WHERE p.workspace_id = ${args.workspaceId}
           AND p.harness_slug = ${args.planStorageSlug}
           AND p.plan_slug    = prev.plan_slug
        RETURNING prev.prev_op_status`
    : await sql<{ prev_op_status: string | null }[]>`
        SELECT op_status AS prev_op_status
          FROM harness_shared.harness_plans
         WHERE workspace_id = ${args.workspaceId}
           AND harness_slug = ${args.planStorageSlug}
           AND plan_slug    = ${args.planSlug}`;
  if (rows.length === 0)
    return { outcome: 'plan-not-found', promoted: 0, flagOff: false, axisWritten: false };
  // Kept in BOTH branches, not just the live one: a row already carrying
  // 'started' was promoted when it was started, so re-promoting it under the
  // retired branch would be pure churn.
  if (rows[0].prev_op_status === 'started')
    return { outcome: 'already-started', promoted: 0, flagOff: false, axisWritten: false };
  // NOT gated on the axis — promotion is the su-serving half (the P-044 lesson),
  // and it is exactly what plans:start keeps running while retired.
  const result = await promotePlanItems({
    workspaceId: args.workspaceId,
    harnessSlug: args.planStorageSlug,
    planSlug: args.planSlug,
    createdBy: 'scout-ready-autostart',
  });
  return {
    outcome: axisLive ? 'started' : 'promoted',
    promoted: result.promoted,
    flagOff: result.flagOff === true,
    axisWritten: axisLive,
    ...(result.specTriadBlocked
      ? {
          specTriadBlocked: true as const,
          specTriadMissing: result.specTriadMissing,
          specTriadWorkItem: result.specTriadWorkItem,
        }
      : {}),
  };
}

export interface ScoutReadyAutostartResult {
  workspaceId: string;
  installSlug: string;
  /** `promoted` = items reached work_items with the op_status axis RETIRED (P-070);
   *  `latched` = the retired-branch per-plan debounce is still inside its quiet
   *  window, so this tick deliberately did nothing. */
  outcome:
    | 'started'
    | 'promoted'
    | 'spec-triad-blocked'
    | 'latched'
    | 'decompose-nudged'
    | 'skipped'
    | 'error';
  planSlug?: string;
  promoted?: number;
  reason: string;
}

/** Debounced Queen wake for a ready-but-ITEMLESS scout plan: she must decompose
 *  items (plans:add-item) — the next sweep then auto-starts it. */
async function fireDecomposeWake(
  workspaceId: string,
  queenOwner: string | null,
  itemless: readonly ScoutReadyCandidate[],
  harnessSlug: string | null = null,
): Promise<void> {
  const list = itemless
    .slice(0, 5)
    .map((c) => `• ${c.planSlug}${c.title ? ` — ${c.title}` : ''}`)
    .join('\n');
  // P-034: routed, not Mug-only — see nudge-recipient.ts.
  await deliverScoutNudge({
    workspaceId,
    mugOwner: queenOwner,
    summary:
      `Scout ready-plan autostart: ${itemless.length} RATIFIED scout plan(s) have NO open items, so ` +
      `they cannot start (nothing to promote to work_items). Decompose each into 1–5 concrete items ` +
      `(plans:add-item) — the autostart sweep then starts it and promotes the items into your ` +
      `surveyable frontier automatically. Do not leave a ratified plan itemless (that is the plan-rail ` +
      `dead end, WI-1574).\n\n${list}`,
    payload: { kind: 'scout-ready-decompose', slugs: itemless.map((c) => c.planSlug) },
    source: 'scout-ready-decompose',
    body: `${list}`,
    harnessSlug,
  });
}

/**
 * Tell the steward why a ratified scout plan did not reach the work-item queue.
 * Promotion already files the repair item; this nudge makes the refusal visible at
 * the same boundary where the steward was told that adding items would be enough.
 */
async function fireSpecTriadWake(
  sql: Sql,
  workspaceId: string,
  installSlug: string,
  planSlug: string,
  missing: readonly string[] | undefined,
  repairWorkItem: string | null | undefined,
): Promise<void> {
  const missingText = missing?.length ? missing.join(', ') : 'required sections';
  const repairText = repairWorkItem
    ? `Repair work-item: ${repairWorkItem}.`
    : 'No repair work-item was returned; inspect the promotion refusal directly.';
  const summary =
    `Steward action required: ratified scout plan ${planSlug} was not promoted because ` +
    `its spec triad is incomplete (missing: ${missingText}). ${repairText}`;

  await deliverScoutNudge({
    workspaceId,
    mugOwner: await resolveMugOwner(sql, workspaceId, installSlug),
    summary,
    payload: {
      kind: 'scout-ready-spec-triad-blocked',
      planSlug,
      missing: missing ?? [],
      repairWorkItem: repairWorkItem ?? null,
    },
    source: 'scout-ready-spec-triad',
    body:
      `${summary} Add the missing ## sections to the plan, then rerun promotion ` +
      `(plans:start or the next ready-plan sweep).`,
    harnessSlug: installSlug,
  });
}

/**
 * The ready-plan autostart sweep. For each registered Blender Hive: auto-start every ratified
 * (ready, never-started) scout plan that has open items — promoting its items into
 * work_items under the hive's own workspace — and fire a debounced decompose-wake
 * for ratified plans with no items. Never throws. DEFAULT-SAFE: nothing ready ⇒
 * nothing happens. Kill switch: PAPERCUSP_SCOUT_READY_AUTOSTART=0.
 */
/** DI seams for the empty-population probe — mirrors outcome-refresh-sweep's deps shape. */
export interface ScoutReadyAutostartSweepDeps {
  listBlenderMaintenanceWorkspaceIds?: typeof listBlenderMaintenanceWorkspaceIds;
  countEligibleReadyPlans?: (workspaceId: string) => Promise<number>;
}

/**
 * How many ready scout plans WOULD this sweep have started, workspace-wide? Deliberately
 * the same selector `readScoutReadyCandidates` uses, minus the per-harness narrowing —
 * an alarm must count the population the sweep was supposed to serve, not a proxy.
 */
async function countEligibleReadyPlans(workspaceId: string): Promise<number> {
  const { sql } = getOrgPg();
  const rows = await sql<{ n: string }[]>`
    SELECT count(*)::text AS n
      FROM harness_shared.harness_plans
     WHERE workspace_id = ${workspaceId}
       AND status = 'ready'
       AND archived = false
       AND (op_status IS NULL OR op_status <> 'started')
       AND content LIKE ${BLENDER_PLAN_SQL_PATTERN}
       AND (
         content ~ ('- [*][*]P-[0-9]+[*][*] ' || chr(96) || '(todo|wip)' || chr(96))
         OR NOT (content ~ '- [*][*]P-[0-9]+[*][*] ')
       )`;
  return Number(rows[0]?.n ?? 0);
}

export async function scoutReadyAutostartSweep(
  deps: ScoutReadyAutostartSweepDeps = {},
): Promise<ScoutReadyAutostartResult[]> {
  const results: ScoutReadyAutostartResult[] = [];
  if (!scoutReadyAutostartEnabled()) return results;
  try {
    const scopes = await listBlenderMaintenanceScopes();
    if (scopes.length === 0) {
      // THE SILENT-NO-OP PROBE (D-074, and the gap an independent acceptance grade
      // caught: this was the ONE of five retained sweeps that early-returned bare).
      // An empty scope list is ORDINARY when there is nothing to do, and an ALARM only
      // when it hides eligible work — so probe workspace-wide for ready scout plans
      // this sweep would have started, and stay silent unless some exist. Without this
      // the sweep is indistinguishable from healthy while a ratified plan waits
      // forever, which is exactly the failure D-074 named, re-keyed onto the new
      // registry-derived population.
      let eligibleBacklogCount = 0;
      try {
        const workspaceIds = (deps.listBlenderMaintenanceWorkspaceIds ?? listBlenderMaintenanceWorkspaceIds)();
        const countFn = deps.countEligibleReadyPlans ?? countEligibleReadyPlans;
        for (const workspaceId of workspaceIds) {
          eligibleBacklogCount += await countFn(workspaceId);
        }
      } catch {
        // Fail SILENT, never loud: the probe exists to add an alarm, so a probe that
        // cannot read must not manufacture one (nor fail the sweep it is auditing).
        return results;
      }
      if (eligibleBacklogCount > 0) {
        const reason =
          `${eligibleBacklogCount} ready scout plan(s) are eligible for autostart, but no ` +
          'registered Blender scopes were evaluated';
        console.warn(`[scout-ready-autostart] ALERT: ${reason}`);
        results.push({
          workspaceId: '*',
          installSlug: '*',
          outcome: 'error',
          reason,
        });
      }
      return results;
    }
    // P-070: resolve the retirement gate ONCE per sweep, not once per plan — the
    // flag cannot meaningfully change inside a single 30s tick, and the per-plan
    // read would be N PostHog/flag reads for one answer.
    const axisLive = await mugKettleSystemEnabled();
    const { sql } = getOrgPg();
    for (const { workspaceId, installSlug } of scopes) {
      try {
        // WI-6978: plans are stored under the Pot/Hive HOME, not a member harness's
        // own slug — resolve once here rather than in each helper, so the read and the
        // op_status UPDATE below can never drift onto different rows. Fails open to
        // the literal slug, so a resolver hiccup degrades to today's behaviour rather
        // than silently disabling the sweep. `installSlug` stays the right value for
        // the watchdog keys + log lines further down (stable alarm identity).
        const planStorageSlug = await routineStorageSlug(installSlug, workspaceId);
        const candidates = await readScoutReadyCandidates(sql, workspaceId, planStorageSlug);
        if (candidates.length === 0) continue;
        const { startable, itemless } = partitionReadyCandidates(candidates);
        for (const plan of startable) {
          try {
            // THE REPLACEMENT LATCH (P-070, module header). While the axis is
            // live the op_status write is itself the latch — the plan stops
            // matching the selector — so this claim is skipped entirely and the
            // live path stays byte-identical to pre-P-070 behaviour. While it is
            // retired nothing removes the plan from the selector, so a per-plan
            // debounce over the shared fires ledger is what keeps the 30s tick
            // from re-entering it forever.
            if (!axisLive) {
              const claimed = await claimWatchdogFire({
                workspaceId,
                installSlug,
                source: 'scout-ready-autostart',
                scopeKey: plan.planSlug,
                windowHours: 1,
                reason: `ready scout plan ${plan.planSlug} promoted with the op_status axis retired`,
                wakeAt: null,
              });
              if (!claimed) {
                results.push({
                  workspaceId,
                  installSlug,
                  outcome: 'latched',
                  planSlug: plan.planSlug,
                  reason: 'retired-axis debounce still inside its quiet window',
                });
                continue;
              }
            }
            const r = await startReadyScoutPlan(
              sql,
              { workspaceId, planStorageSlug, planSlug: plan.planSlug },
              { mugKettleSystemEnabledFn: async () => axisLive },
            );
            if (r.specTriadBlocked) {
              await fireSpecTriadWake(
                sql,
                workspaceId,
                installSlug,
                plan.planSlug,
                r.specTriadMissing,
                r.specTriadWorkItem,
              );
            }
            const promotedSomething = r.outcome === 'started' || r.outcome === 'promoted';
            results.push({
              workspaceId,
              installSlug,
              outcome: r.specTriadBlocked
                ? 'spec-triad-blocked'
                : promotedSomething
                  ? r.axisWritten
                    ? 'started'
                    : 'promoted'
                  : 'skipped',
              planSlug: plan.planSlug,
              promoted: r.promoted,
              reason: r.specTriadBlocked
                ? `promotion refused by spec triad (missing: ${r.specTriadMissing?.join(', ') || 'required sections'})` +
                  (r.specTriadWorkItem ? `; repair ${r.specTriadWorkItem}` : '')
                : promotedSomething
                ? r.flagOff
                  ? 'promotion no-oped: PLAN_WORKITEM_PROMOTION flag is OFF — items will NOT reach the queue until it is flipped'
                  : r.axisWritten
                    ? `auto-started ratified scout plan; promoted ${r.promoted} item(s)`
                    : `promoted ${r.promoted} item(s) from a ratified scout plan; op_status NOT written — ` +
                      'the operational axis is RETIRED (papercusp-mug-kettle-system is OFF, the delivered ' +
                      'state), so su agents self-select these items via scheduler:get_next'
                : r.outcome === 'plan-not-found'
                  ? 'plan row vanished between the candidate read and the start'
                  : 'already started (race)',
            });
          } catch (e) {
            results.push({
              workspaceId,
              installSlug,
              outcome: 'error',
              planSlug: plan.planSlug,
              reason: e instanceof Error ? e.message : String(e),
            });
          }
        }
        if (itemless.length > 0) {
          // Debounce the WAKE (1h base window) — the plans stay selected until items
          // land, so without the debounce every 30s tick would re-wake the Queen.
          // EI-16038: cheap non-atomic pre-check first (avoid the transaction
          // round-trip on the common already-fired tick); the atomic claim below is
          // authoritative and backs off geometrically once the SAME itemless plan set
          // has re-fired unchanged (previously: a fixed 1h window forever — one stuck
          // itemless plan re-woke the Queen ~186 times over 15.9 days).
          const alreadyFired =
            (await recentWatchdogFires(workspaceId, installSlug, 1, 'scout-ready-decompose')) > 0;
          if (!alreadyFired) {
            const reason = `${itemless.length} ratified itemless scout plan(s): ${itemless
              .slice(0, 5)
              .map((c) => c.planSlug)
              .join(', ')}`;
            const claimed = await claimWatchdogFire({
              workspaceId,
              installSlug,
              source: 'scout-ready-decompose',
              windowHours: 1,
              reason,
              wakeAt: null,
            });
            if (claimed) {
              const queenOwner = await resolveMugOwner(sql, workspaceId, installSlug);
              await fireDecomposeWake(workspaceId, queenOwner, itemless, installSlug);
              results.push({
                workspaceId,
                installSlug,
                outcome: 'decompose-nudged',
                reason: `${itemless.length} itemless ready plan(s)`,
              });
            }
          }
        }
      } catch (e) {
        results.push({
          workspaceId,
          installSlug,
          outcome: 'error',
          reason: e instanceof Error ? e.message : String(e),
        });
      }
    }
  } catch (e) {
    console.warn(`[scout-ready-autostart] sweep failed: ${e instanceof Error ? e.message : e}`);
  }
  return results;
}
