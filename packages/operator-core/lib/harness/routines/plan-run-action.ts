/**
 * The `system:plan-run` routine action — one fire of a scheduled plan.
 *
 * Plan: scheduled-recurring-plans-2026-06-16 (P-007 sub-step 7c). The plan-level
 * mirror of `system:blueprint-run`.
 *
 * A scheduled plan's materialized routine (materialize-plan-schedule.ts) fires this
 * with `payload_template = { templateSlug, harnessSlug }`. The routinesTick dispatches
 * it INLINE as one durable DBOS step (system-actions.ts), so it must be replay-safe.
 *
 * Per fire it mints a RUN (Option C, D-002): an ephemeral INSTANCE plan
 * (`<template>@run-<token>`, a copy of the template) + a `plan_runs` ledger row
 * (run_type='scheduled') + the instance's items as frontier work_items, run-scoped via
 * `payload.plan_run` + `source_plan_slug`=template (D-016). Work creation goes through
 * the SAME canonical `promotePlanItems` path as `plans:start`; callers may then assign
 * and wake its dependency-safe frontier without a second execution engine.
 *
 * Replay-safety (the durable-step contract): the run token is stable per fire. The
 * instance plan + run ledger commit atomically; canonical promotion is idempotent and
 * re-entered on every replay, so a crash between the two phases heals instead of
 * stranding a run or minting duplicate execution records.
 */
import type { Sql, TransactionSql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';
import { registerSystemAction, type SystemActionCtx } from './system-actions';
import { planScheduleRoutineName } from './materialize-plan-schedule';
import { ACTIVE_FEATURE_FAMILY_KINDS, type ActiveFeatureFamilyKind } from '../../work-items';
import { evaluatePlanStartReadiness, type PlanStartReadiness } from '../../agent-tools/plans/plan-input-validation';
import { readAndEvaluateAcceptanceBarLifecycle } from '../../acceptance-bar-lifecycle-evaluator';
import { checkPlanAdmission, type PlanAdmissionRefusal } from '../../agent-tools/plans/plan-admission-gate';
import { routineStorageSlug } from '../../pot-membership';
import { setFrontmatterScalar } from '../../agent-tools/plans/transfer-owner';
import { planRunInstanceSlug } from '../../agent-tools/plans/run-instance-slug';
import { deriveIndexFromContent, type PlanIndexDecision, type PlanIndexItem } from '../../agent-tools/plans/source';
import { writePlanIndexRows } from '../../agent-tools/plans/plan-index-rows';
import { parsePlan } from '@papercusp/plan-parser';
import { hashPlanContent } from '@papercusp/plan-parser/content-hash';
import {
  invalidPlanDependenciesValue,
  validatePlanCandidateDependencies,
} from '../../agent-tools/plans/plan-candidate-dependencies';
import {
  promotePlanItems,
  type PlanRunPromotionContext,
  type PromotePlanResult,
} from '../../plan-workitem-promotion-run';
import { parseAgenticPlanExecutionTarget, type AgenticPlanExecutionTarget } from '../../agentic-plan-execution-target';
import {
  assignAndWakeActionableWorkItems,
  type ActionableWorkItemDispatchResult,
} from '../../agent-tools/coordination/actionable-work-item-dispatch';

/** launched_by label for a scheduled run's plan_runs row. */
const PLAN_RUN_LAUNCHER = 'system:plan-run';

/**
 * A MANUAL run (plans:run-now) takes a fresh token each call (EI-1369). A module-monotonic
 * counter guarantees a strictly-increasing, unique token even for two run-nows within the same
 * millisecond on one host — so the instance slug never collides and the run never replay-no-ops.
 */
let lastManualToken = 0;
function nextManualToken(): number {
  const t = Math.max(Date.now(), lastManualToken + 1);
  lastManualToken = t;
  return t;
}

export type ScheduledPlanFireRefusalReason =
  | 'template-missing'
  | 'not-startable'
  | 'concurrency-skip'
  /**
   * P-004: the plan's inputs are fine, but the pot's governance has not admitted this
   * exact revision. Kept distinct from 'not-startable' because the remedy is a
   * ratification round, not a repair of the plan document — collapsing them would
   * send whoever reads the refusal to edit a plan that needs no editing.
   */
  | 'not-admitted';

type FailedPlanStartReadiness = Extract<PlanStartReadiness, { ready: false }>;

interface ScheduledPlanFireResultBase {
  instanceSlug: string;
  runId: number;
  runSeq: number;
  minted: number;
  workItemIds: string[];
  actionableWorkItemIds: string[];
  replayed: boolean;
  skippedForConcurrency?: boolean;
  execution?: AgenticPlanExecutionTarget;
}

export interface ScheduledPlanFireStartedResult extends ScheduledPlanFireResultBase {
  /**
   * The success discriminator keeps started and refused fires type-safe at every
   * caller. Injected seams should return `started: true` for successful fires.
   */
  started: true;
  /** Full canonical promotion evidence for a started run. */
  promotion?: PromotePlanResult;
  /** Structured assignment + required-wake result for the initial frontier. */
  dispatch?: ActionableWorkItemDispatchResult;
}

/** A deliberate, non-exceptional reason why a plan fire did not start a run. */
export interface ScheduledPlanFireRefusal extends ScheduledPlanFireResultBase {
  started: false;
  /** The plan was not started; these sentinel fields keep the result shape inspectable. */
  instanceSlug: '';
  runId: -1;
  runSeq: -1;
  minted: 0;
  workItemIds: [];
  actionableWorkItemIds: [];
  replayed: false;
  reason: ScheduledPlanFireRefusalReason;
  /** Human-readable detail computed at the refusal site. */
  detail: string;
  /**
   * Whether the trigger outbox should retry this refusal. Missing required inputs
   * can become startable after the stored plan data is repaired; schema/data
   * mismatches and policy skips are terminal for this event.
   */
  retryable: boolean;
  /** Full start-gate evidence for a not-startable refusal. */
  readiness?: FailedPlanStartReadiness;
  /** Full admission evidence for a 'not-admitted' refusal (P-004). */
  admission?: PlanAdmissionRefusal;
  /** The already-running plan run that caused a concurrency skip. */
  priorRunId?: number;
}

export type ScheduledPlanFireResult = ScheduledPlanFireStartedResult | ScheduledPlanFireRefusal;

interface PreparedPlanRun {
  started: true;
  instanceSlug: string;
  runId: number;
  runSeq: number;
  replayed: boolean;
  skippedForConcurrency?: boolean;
  itemKind: ActiveFeatureFamilyKind;
  runInputs: unknown;
  appHarnessSlug: string;
  execution: AgenticPlanExecutionTarget | null;
}

/** Resolve stale schedule config onto the forward-active work-item kind set. */
export function resolvePlanRunItemKind(rawKind: unknown): ActiveFeatureFamilyKind {
  return typeof rawKind === 'string' && (ACTIVE_FEATURE_FAMILY_KINDS as readonly string[]).includes(rawKind)
    ? (rawKind as ActiveFeatureFamilyKind)
    : 'feature';
}

type PreparedPlanRunOutcome = PreparedPlanRun | ScheduledPlanFireRefusal;

export interface ScheduledPlanFireOptions {
  installSlug: string;
  workspaceId: string;
  templateSlug: string;
  /** What kind of fire this is (plan_runs.trigger). Default 'scheduled'; run-now passes 'manual'. */
  trigger?: 'scheduled' | 'manual' | 'event';
  /** Stable decimal token for a durable non-manual fire. */
  runToken?: number | string;
  /** An operation pin may require this exact plan template revision and content. */
  expectedTemplate?: { revision: string; contentHash: string };
  /** The resolved, start-gate-validated inputs this run executes with. */
  inputs?: unknown;
  /** Binding/manual override; otherwise inherited from schedule.execution. */
  execution?: AgenticPlanExecutionTarget | null;
}

export interface ScheduledPlanFireDeps {
  dispatch?: typeof assignAndWakeActionableWorkItems;
}

/**
 * Mint one run of a scheduled plan. `sql` is an explicit seam (admin pool in prod,
 * the testcontainers client in tests). Returns a typed refusal when the template is
 * missing, the start gate refuses, or concurrency policy deliberately skips the fire;
 * never throws for those expected outcomes (the durable-step contract is enforced by
 * the handler wrapper for unexpected failures).
 */
async function runScheduledPlanFireTx(
  sql: Sql | TransactionSql,
  opts: ScheduledPlanFireOptions,
): Promise<PreparedPlanRunOutcome> {
  const { installSlug, workspaceId, templateSlug, trigger = 'scheduled' } = opts;

  // WI-6978 — `harness_plans` IS re-homed, `plan_runs` is NOT. Two relations, two
  // slugs, in one function; the difference is load-bearing.
  //
  // The plans:* WRITE path resolves a member harness to its Hive home
  // (resolvePlanScope → potHomeSlugForHarness, agent-tools/plans/source.ts:429 —
  // plans are Hive-scoped). A read filtering this routine's RAW `installSlug`
  // therefore matches ZERO ROWS whenever the routine is installed under a member
  // harness or a workspace-global label — and the failure is silent: step 1 below
  // logs "template not found — skip" and the schedule simply never fires again.
  // `routineStorageSlug` reproduces the same resolution (pot-membership.ts:199,
  // pgPotLookup.resolveRealPot collapses member → Pot home) and fails open to the
  // literal slug, so the TEMPLATE read and the plans:* tool path address the same
  // source row. An agentic execution target may then choose a DIFFERENT app
  // harness; its instance plan is resolved through the same storage rule below.
  //
  // ⚠ `plan_runs` is per-install/workspace-scoped and NOT re-homed (audited
  // WI-6978). It therefore keeps the raw execution app harness (or installSlug
  // for an ordinary run), while the copied instance plan uses its resolved Pot
  // home. Mixing those two keys makes replay miss its own ledger row.
  const planStorageSlug = await routineStorageSlug(installSlug, workspaceId);

  // A pinned blueprint operation can crash after its immutable instance and
  // ledger commit but before its invocation receipt points at that run. If the
  // template changes meanwhile, the original fire still has to repair its
  // promotion from the seeded snapshot. The receipt id is a unique decimal
  // run token; this branch applies only to that explicit plan-target path.
  const pinnedToken = opts.runToken === undefined ? null : String(opts.runToken).trim();
  if (opts.expectedTemplate && opts.execution === null && pinnedToken && /^\d+$/.test(pinnedToken)) {
    const instanceSlug = planRunInstanceSlug(templateSlug, pinnedToken);
    const seeded = await sql<Array<{
      run_id: number | string; run_seq: number | null; inputs: unknown;
      plan_content_hash: string; item_kind: string | null; instance_slug: string | null;
    }>>`
      SELECT r.id AS run_id, p.run_seq, r.inputs, r.plan_content_hash,
             r.replay_item_kind AS item_kind, p.plan_slug AS instance_slug
        FROM harness_shared.plan_runs r
        LEFT JOIN harness_shared.harness_plans p
          ON p.workspace_id = r.workspace_id AND p.harness_slug = ${planStorageSlug}
         AND p.plan_slug = r.instance_plan_slug AND p.template_slug = ${templateSlug}
       WHERE r.workspace_id = ${workspaceId} AND r.harness_slug = ${installSlug}
         AND r.plan_slug = ${templateSlug} AND r.instance_plan_slug = ${instanceSlug}
       LIMIT 1
    `;
    if (seeded[0]) {
      const prior = seeded[0];
      if (prior.plan_content_hash !== opts.expectedTemplate.contentHash || !prior.instance_slug) {
        throw new Error(`plan_run_replay_seed_conflict:${instanceSlug}`);
      }
      if (!prior.item_kind || !(ACTIVE_FEATURE_FAMILY_KINDS as readonly string[]).includes(prior.item_kind)) {
        throw new Error(`plan_run_replay_context_missing:${instanceSlug}`);
      }
      return {
        started: true, instanceSlug, runId: Number(prior.run_id), runSeq: prior.run_seq ?? -1,
        replayed: true, itemKind: prior.item_kind as ActiveFeatureFamilyKind,
        runInputs: prior.inputs, appHarnessSlug: installSlug, execution: null,
      };
    }
  }

  // 1. The template plan.
  const tpl = await sql<
    Array<{
      content: string;
      content_hash: string;
      version: number | string;
      title: string | null;
      items: PlanIndexItem[] | null;
      decisions: PlanIndexDecision[] | null;
      schedule: { executorKind?: string; execution?: unknown } | null;
      template: string | null;
      template_data: unknown;
      input_schema: unknown;
      output_schema: unknown;
      acceptance_bar_epoch: number | string | null;
    }>
  >`
    SELECT content, content_hash, version, title, items, decisions, schedule, template, template_data, input_schema,
           output_schema, acceptance_bar_epoch
      FROM harness_shared.harness_plans
     WHERE workspace_id = ${workspaceId} AND harness_slug = ${planStorageSlug}
       AND plan_slug = ${templateSlug}
  `;
  if (!tpl[0]) {
    const detail = `template '${templateSlug}' not found in ${installSlug}`;
    console.warn(`[plan-run] ${detail} — skip`);
    return {
      started: false,
      instanceSlug: '',
      runId: -1,
      runSeq: -1,
      minted: 0,
      workItemIds: [],
      actionableWorkItemIds: [],
      replayed: false,
      reason: 'template-missing',
      detail,
      retryable: false,
    };
  }
  const template = tpl[0];
  if (opts.expectedTemplate &&
      (String(template.version) !== opts.expectedTemplate.revision ||
       template.content_hash !== opts.expectedTemplate.contentHash)) {
    throw new Error(`plan_run_template_pin_mismatch:${templateSlug}`);
  }
  if (template.acceptance_bar_epoch != null) {
    const lifecycle = await readAndEvaluateAcceptanceBarLifecycle(templateSlug, 'pre-start', {
      expectedApplicable: true,
    });
    if (!lifecycle.satisfied) {
      const detail = lifecycle.message ?? 'acceptance BAR contract is not ready for scheduled start';
      console.warn(`[plan-run] template '${templateSlug}' BAR contract is not startable — skip. ${detail}`);
      return {
        started: false,
        instanceSlug: '',
        runId: -1,
        runSeq: -1,
        minted: 0,
        workItemIds: [],
        actionableWorkItemIds: [],
        replayed: false,
        reason: 'not-startable',
        detail,
        retryable: false,
      };
    }
  }
  const execution = parseAgenticPlanExecutionTarget(
    opts.execution !== undefined ? opts.execution : template.schedule?.execution,
  );
  const appHarnessSlug = execution?.appHarnessSlug ?? installSlug;
  const appPlanStorageSlug =
    appHarnessSlug === installSlug ? planStorageSlug : await routineStorageSlug(appHarnessSlug, workspaceId);

  // P-006 start gate on the SCHEDULED fire path. P-008 already refused to arm a plan
  // whose required inputs were unset, but that verdict can go stale: the schema or the
  // values can change while the schedule stays armed. Re-checking here costs nothing
  // and is the difference between a refused fire and a run that executes with no
  // arguments. Refusing returns a typed non-started result so callers can preserve
  // the start-gate diagnosis instead of reconstructing it from the plan later.
  const runInputs = opts.inputs !== undefined ? opts.inputs : (template.template_data ?? null);
  const readiness = evaluatePlanStartReadiness(
    { template: template.template, inputSchema: template.input_schema },
    runInputs,
  );
  if (!readiness.ready) {
    const retryable = readiness.code === 'missing_required';
    const detail =
      readiness.issues.length > 0 ? `${readiness.hint} Issues: ${readiness.issues.join('; ')}` : readiness.hint;
    console.warn(
      `[plan-run] template '${templateSlug}' in ${installSlug} is not startable ` +
        `(${readiness.code}${readiness.missing.length > 0 ? `: missing ${readiness.missing.join(', ')}` : ''}) — skip. ${readiness.hint}`,
    );
    return {
      started: false,
      instanceSlug: '',
      runId: -1,
      runSeq: -1,
      minted: 0,
      workItemIds: [],
      actionableWorkItemIds: [],
      replayed: false,
      reason: 'not-startable',
      detail,
      retryable,
      readiness,
      ...(execution ? { execution } : {}),
    };
  }
  // P-004 admission on the SCHEDULED fire path. This door never touches
  // checkPlanStartable — it holds its own template row and calls the readiness oracle
  // directly — so the admission check placed in the start gate cannot reach it. That
  // makes this the door where enforcement matters MOST, not least: an armed schedule
  // fires unattended, so a revision that lost its ratification (edited, expired,
  // paused, revoked) would otherwise keep running at 03:00 with nobody watching.
  //
  // The hash comes from the template row already read above rather than a second
  // query, so the verdict is about the revision this fire is about to execute.
  const admission = await checkPlanAdmission({
    slug: templateSlug,
    door: 'scheduled',
    opts: { workspaceId, harnessSlug: planStorageSlug },
    planRevisionHash: template.content_hash ?? '',
  });
  if (!admission.admitted) {
    const detail = `${admission.refusal.code}: ${admission.refusal.hint}`;
    console.warn(`[plan-run] template '${templateSlug}' is not admitted to run — skip. ${detail}`);
    return {
      started: false,
      instanceSlug: '',
      runId: -1,
      runSeq: -1,
      minted: 0,
      workItemIds: [],
      actionableWorkItemIds: [],
      replayed: false,
      reason: 'not-admitted',
      detail,
      // Retryable: a ratification round can admit this same revision later without
      // anything about the plan changing, so the trigger outbox should try again —
      // unlike a schema mismatch, which stays refused until the plan is edited.
      retryable: true,
      admission: admission.refusal,
      ...(execution ? { execution } : {}),
    };
  }

  // Executor kind (D-006/P-009): only forward-active feature-family kinds may
  // mint work. Historical `chunk` config is read-compatible but falls back to
  // `feature`, so a stale schedule cannot recreate retired rows.
  const rawKind = template.schedule?.executorKind;
  const itemKind = resolvePlanRunItemKind(rawKind);
  if (rawKind === 'chunk') {
    console.warn(`[plan-run] schedule.executorKind='chunk' is deprecated; using 'feature' for ${templateSlug}`);
  }

  // 2. Run token → instance slug. A SCHEDULED/event fire uses the routine's last_fired_at
  //    (stamped at claim, stable across a DBOS step replay) so a re-executed step is a no-op,
  //    not a double-mint. A MANUAL run (plans:run-now) is independent of the cadence and has no
  //    DBOS replay, so it ALWAYS takes a FRESH token — otherwise, once the routine has fired even
  //    once, every run-now would recompute the SAME slug and replay-no-op instead of minting a new
  //    run (EI-1369).
  const rt = await sql<Array<{ last_fired_at: Date | null; concurrency: string | null }>>`
    SELECT last_fired_at, concurrency FROM harness_shared.routines
     WHERE install_slug = ${installSlug} AND name = ${planScheduleRoutineName(templateSlug)}
  `;
  const suppliedToken = opts.runToken === undefined ? null : String(opts.runToken).trim();
  if (suppliedToken !== null && !/^\d+$/.test(suppliedToken)) {
    throw new Error('plan_run_token_must_be_decimal');
  }
  const token =
    trigger === 'manual'
      ? nextManualToken()
      : suppliedToken !== null
        ? suppliedToken
        : rt[0]?.last_fired_at
          ? new Date(rt[0].last_fired_at).getTime()
          : Date.now();
  const instanceSlug = planRunInstanceSlug(templateSlug, token);

  // Serialize callers racing on the same deterministic fire before the replay
  // check. Combined with the transaction wrapper, this makes the mint both atomic
  // and exactly-once visible even when two workers receive the same event.
  const fireLockKey = `${workspaceId}:${appHarnessSlug}:${instanceSlug}`;
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${fireLockKey}, 0))`;

  // 3. Idempotency: the instance already existing ⇒ recover the SAME ledger
  // row and re-enter canonical promotion after this transaction. A replay is
  // not a promotion no-op: it is the healing path for a crash between the
  // atomic instance+ledger seed and the shared work-item writes.
  const existing = await sql<Array<{ run_seq: number | null; run_id: number | null; inputs: unknown }>>`
    SELECT p.run_seq, r.id AS run_id, r.inputs
      FROM harness_shared.harness_plans p
      LEFT JOIN LATERAL (
        SELECT id, inputs
          FROM harness_shared.plan_runs
         WHERE workspace_id = ${workspaceId}
           AND harness_slug = ${appHarnessSlug}
           AND instance_plan_slug = ${instanceSlug}
         ORDER BY id DESC
         LIMIT 1
      ) r ON TRUE
     WHERE p.workspace_id = ${workspaceId} AND p.harness_slug = ${appPlanStorageSlug}
       AND p.plan_slug = ${instanceSlug}
  `;
  if (existing[0]) {
    if (!existing[0].run_id) {
      throw new Error(`plan_run_replay_missing_ledger:${instanceSlug}`);
    }
    console.log(`[plan-run] ${instanceSlug} already seeded (replay) — repair promotion`);
    return {
      started: true,
      instanceSlug,
      runId: Number(existing[0].run_id),
      runSeq: existing[0].run_seq ?? -1,
      replayed: true,
      itemKind,
      runInputs: existing[0].inputs ?? runInputs,
      appHarnessSlug,
      execution,
    };
  }

  // 3b. EI-1386 — overlap policy (D-014). The schedule's `concurrency` was authored
  // (set-schedule → materializePlanSchedule → routines.concurrency) but nothing at
  // fire time ever read it, so an overrunning template accumulated overlapping runs
  // regardless of policy. 'queue' (default at the DB column, though the app layer
  // defaults new schedules to 'skip') mints unconditionally — unchanged, no check
  // needed. 'skip' now actually skips when a prior run of the SAME template is still
  // 'running'. 'cancel-prev' is intentionally NOT handled here — settling a prior
  // run's still-open work_items needs its own careful design (what happens to
  // in-flight worker output) and is tracked separately; a 'cancel-prev'-authored
  // schedule currently behaves like 'queue' (mints anyway) rather than silently
  // dropping fires, which is the safer of the two unimplemented behaviors.
  const concurrency = rt[0]?.concurrency ?? 'queue';
  if (concurrency === 'skip') {
    const inFlight = await sql<Array<{ id: number }>>`
      SELECT id FROM harness_shared.plan_runs
       WHERE workspace_id = ${workspaceId} AND harness_slug = ${appHarnessSlug}
         AND plan_slug = ${templateSlug} AND status = 'running'
       LIMIT 1
    `;
    if (inFlight[0]) {
      console.log(
        `[plan-run] ${appHarnessSlug}: skipping fire of '${templateSlug}' — prior run ` +
          `${inFlight[0].id} still 'running' (concurrency='skip')`,
      );
      return {
        started: false,
        instanceSlug: '',
        runId: -1,
        runSeq: -1,
        minted: 0,
        workItemIds: [],
        actionableWorkItemIds: [],
        replayed: false,
        skippedForConcurrency: true,
        reason: 'concurrency-skip',
        detail: `prior plan run ${inFlight[0].id} of '${templateSlug}' is still running ` + `(concurrency='skip')`,
        retryable: false,
        priorRunId: Number(inFlight[0].id),
        ...(execution ? { execution } : {}),
      };
    }
  }

  // 4. run_seq = count of prior runs of this template (display ordinal, D-003).
  const seqRow = await sql<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM harness_shared.plan_runs
     WHERE workspace_id = ${workspaceId} AND harness_slug = ${appHarnessSlug} AND plan_slug = ${templateSlug}
  `;
  const runSeq = seqRow[0]?.n ?? 0;
  const now = Date.now();

  // 5. The instance plan — a copy of the template, pinned to it via template_slug.
  //    P-010: the copy now carries the run's ARGUMENTS too (template/template_data/
  //    input_schema). Without them the instance was a plan whose text said "audit each
  //    path in `paths`" while the row itself held no `paths` — the executor could read
  //    the instructions and not the inputs, which is exactly the inertness this plan
  //    exists to fix. `template_data` holds the RESOLVED inputs (overrides merged), so
  //    the instance records what this run actually ran with, not the template default.
  //
  //    EI-19389216343173748: the template's markdown is cloned VERBATIM, frontmatter
  //    included — so left alone, `content`'s self-declared `slug:` stays the PARENT's,
  //    disagreeing with this row's own `plan_slug` (a hard `slug_mismatch` per
  //    plans/lint.ts, and the value ~10 read sites fall back to whenever frontmatter.slug
  //    is present). Rewrite just that one line so the clone's self-declared identity
  //    agrees with its canonical row at the source, and rehash accordingly — the content
  //    hash must reflect what is actually stored, not the template's.
  const runInputsJson = runInputs === null || runInputs === undefined ? null : JSON.stringify(runInputs);
  const inputSchemaJson = template.input_schema == null ? null : JSON.stringify(template.input_schema);
  // WI-10003495: the run's RETURN contract travels with it too. plans:publish-outputs
  // validates against the INSTANCE row's output_schema, so dropping it made every run
  // of an output-declaring template refuse `no_outputs_declared`.
  const outputSchemaJson = template.output_schema == null ? null : JSON.stringify(template.output_schema);
  // The template's `items` jsonb is the canonical derived index consumed by
  // promotePlanItems. Copy it with the content snapshot: historical fixtures
  // (and imported plans) may have a populated index even when their markdown
  // predates strict item-line syntax, and silently dropping it would turn a
  // valid run into a zero-work promotion.
  const instanceContent = setFrontmatterScalar(template.content, 'slug', instanceSlug);
  const instanceContentHash = hashPlanContent(instanceContent);
  // P-009: this raw INSERT bypasses withPlanLock, so it must invoke the same
  // candidate policy explicitly before the active instance or its plan_runs row
  // becomes visible. Treat the clone as executable regardless of copied parent
  // frontmatter; a draft forward ref is not allowable in a running instance.
  const dependencyVerdict = validatePlanCandidateDependencies(parsePlan(instanceContent), 'started');
  if (dependencyVerdict.state === 'rejected') {
    const refusal = invalidPlanDependenciesValue(instanceSlug, dependencyVerdict);
    throw new Error(`${refusal.code}:${instanceSlug}:${refusal.message}`);
  }
  const contentIndex = deriveIndexFromContent(instanceContent);
  // `content` is canonical for current plans, but imported/legacy plans may
  // carry a populated derived JSON index even when their markdown predates the
  // strict structured item/decision syntax. Preserve that same compatibility
  // contract the promotion reader uses: prefer the stored index when present,
  // otherwise derive it from the cloned content.
  const instanceItems =
    Array.isArray(template.items) && template.items.length > 0 ? template.items : contentIndex.items;
  const instanceDecisions =
    Array.isArray(template.decisions) && template.decisions.length > 0 ? template.decisions : contentIndex.decisions;
  const itemsJson = JSON.stringify(instanceItems);
  const decisionsJson = JSON.stringify(instanceDecisions);
  await sql`
    INSERT INTO harness_shared.harness_plans
      (workspace_id, harness_slug, plan_slug, title, status, content, content_hash,
       items, decisions, template_slug, run_seq, origin, template, template_data, input_schema,
       output_schema)
    VALUES (${workspaceId}, ${appPlanStorageSlug}, ${instanceSlug}, ${template.title}, 'active',
            ${instanceContent}, ${instanceContentHash}, ${itemsJson}::text::jsonb, ${decisionsJson}::text::jsonb,
            ${templateSlug}, ${runSeq}, 'local',
            ${template.template}, ${runInputsJson}::text::jsonb, ${inputSchemaJson}::text::jsonb,
            ${outputSchemaJson}::text::jsonb)
    ON CONFLICT (workspace_id, harness_slug, plan_slug) DO NOTHING
  `;
  // Raw instance creation is a plan WRITE and therefore owes the same derived
  // relational index as with-plan-lock and the built-in external-trigger plan
  // writers. Keep it in this transaction, after the parent row exists and while
  // the fire advisory lock is held, so work_items:complete can reflect the root
  // plan item without ever observing a plan whose normalized index is missing.
  await writePlanIndexRows(
    sql as unknown as Parameters<typeof writePlanIndexRows>[0],
    { workspaceId, harnessSlug: appPlanStorageSlug, planSlug: instanceSlug },
    { items: instanceItems, decisions: instanceDecisions },
  );

  // 6. The plan_runs ledger row (run_type='scheduled'). plan_slug = the TEMPLATE so
  //    "all runs of X" = WHERE plan_slug=X (D-003); instance_plan_slug names the copy.
  const runRows = await sql<Array<{ id: number }>>`
    INSERT INTO harness_shared.plan_runs
      (workspace_id, harness_slug, plan_slug, plan_content_hash, session_id, launched_by, launched_at,
       status, title, updated_at, run_type, trigger, instance_plan_slug, run_seq, inputs,
       replay_item_kind)
    VALUES (${workspaceId}, ${appHarnessSlug}, ${templateSlug}, ${template.content_hash}, ${'sched:' + instanceSlug},
            ${PLAN_RUN_LAUNCHER}, ${now}, 'running', ${template.title}, ${now},
            'scheduled', ${trigger}, ${instanceSlug}, ${runSeq}, ${runInputsJson}::text::jsonb,
            ${itemKind})
    RETURNING id
  `;
  const runId = Number(runRows[0].id);

  // Work-item creation is deliberately NOT implemented here. After this
  // transaction commits, runScheduledPlanFire invokes promotePlanItems with
  // the run context. That one implementation owns identity, provenance,
  // blocker edges, lane gating, idempotency, and replay repair.
  return {
    started: true,
    instanceSlug,
    runId,
    runSeq,
    replayed: false,
    itemKind,
    runInputs,
    appHarnessSlug,
    execution,
  };
}

/**
 * Seed the immutable instance+ledger transaction, then invoke canonical
 * promotion. The second phase is replay-healable: every deterministic replay
 * resolves the original run id and re-enters idempotent promotion.
 */
export async function runScheduledPlanFire(
  sql: Sql,
  opts: ScheduledPlanFireOptions,
  deps: ScheduledPlanFireDeps = {},
): Promise<ScheduledPlanFireResult> {
  const prepared = await sql.begin((tx) => runScheduledPlanFireTx(tx, opts));
  if (prepared.started === false) return prepared;

  const planRun: PlanRunPromotionContext = {
    runId: prepared.runId,
    runSeq: prepared.runSeq,
    instancePlanSlug: prepared.instanceSlug,
    templateSlug: opts.templateSlug,
    ...(prepared.runInputs === null || prepared.runInputs === undefined ? {} : { inputs: prepared.runInputs }),
    ...(prepared.execution ? { execution: prepared.execution } : {}),
  };
  const promotion = await promotePlanItems({
    workspaceId: opts.workspaceId,
    harnessSlug: prepared.appHarnessSlug,
    planSlug: prepared.instanceSlug,
    createdBy: PLAN_RUN_LAUNCHER,
    planRun,
    itemKind: prepared.itemKind,
  });
  if (promotion.flagOff) {
    throw new Error(`plan_run_promotion_disabled:${prepared.instanceSlug}`);
  }
  if (promotion.specTriadBlocked) {
    throw new Error(
      `plan_run_spec_triad_blocked:${prepared.instanceSlug}:${promotion.specTriadMissing?.join(',') ?? 'unknown'}`,
    );
  }
  if (promotion.specQualityBlocked) {
    throw new Error(`plan_run_spec_quality_blocked:${prepared.instanceSlug}`);
  }
  if (promotion.dependencyBlocked) {
    throw new Error(
      `plan_run_invalid_dependencies:${prepared.instanceSlug}:` +
        (promotion.dependencyDiagnostics ?? []).map((diagnostic) => diagnostic.message).join('; '),
    );
  }
  const expectedOpenItems = promotion.promoted + promotion.skipped;
  if (promotion.workItems.length !== expectedOpenItems) {
    throw new Error(
      `plan_run_promotion_incomplete:${prepared.instanceSlug}:${promotion.workItems.length}/${expectedOpenItems}`,
    );
  }

  const workItemIds = promotion.workItems.map((item) => item.workItemId);
  const actionableWorkItemIds = promotion.workItems.filter((item) => item.actionable).map((item) => item.workItemId);
  const dispatch = prepared.execution
    ? await (deps.dispatch ?? assignAndWakeActionableWorkItems)({
        workItemIds: actionableWorkItemIds,
        targetAgent: prepared.execution.agentName,
        workspaceId: opts.workspaceId,
        harness: prepared.appHarnessSlug,
        summary: `Plan run ${prepared.instanceSlug} has ${actionableWorkItemIds.length} actionable work-item(s)`,
        source: 'system:plan-run-direct-dispatch',
      })
    : undefined;
  console.log(
    `[plan-run] ${prepared.appHarnessSlug}: ${prepared.replayed ? 'replayed' : 'minted'} run #${prepared.runSeq} ` +
      `of '${opts.templateSlug}' → ${prepared.instanceSlug} (plan_run ${prepared.runId}, ` +
      `${promotion.promoted} new / ${workItemIds.length} total work-item(s), ` +
      `${actionableWorkItemIds.length} actionable)`,
  );
  return {
    started: true,
    instanceSlug: prepared.instanceSlug,
    runId: prepared.runId,
    runSeq: prepared.runSeq,
    minted: promotion.promoted,
    workItemIds,
    actionableWorkItemIds,
    promotion,
    replayed: prepared.replayed,
    ...(prepared.execution ? { execution: prepared.execution } : {}),
    ...(dispatch ? { dispatch } : {}),
  };
}

/** The registered `system:plan-run` handler. Never throws (durable-step contract). */
export async function handlePlanRun(ctx: SystemActionCtx): Promise<void> {
  const templateSlug =
    typeof ctx.payloadTemplate?.templateSlug === 'string' ? ctx.payloadTemplate.templateSlug.trim() : '';
  if (!templateSlug) {
    console.warn('[plan-run] no templateSlug in payload — skip');
    return;
  }
  try {
    // P-028 master switch: the scheduled-plan execution path ships dark.
    if (!(await getFlag(FLAGS.SCHEDULED_PLANS, 'system'))) {
      console.log('[plan-run] papercusp-scheduled-plans flag off — skip');
      return;
    }
    const { sql } = getOrgPg();
    const fired = await runScheduledPlanFire(sql, {
      installSlug: ctx.installSlug,
      workspaceId: ctx.workspaceId,
      templateSlug,
    });
    if (fired.started === true && fired.dispatch && !fired.dispatch.ok) {
      throw new Error(`plan_run_agentic_dispatch_failed:${fired.dispatch.failure?.code ?? 'assignment_failed'}`);
    }
  } catch (e) {
    // Durable-step contract: log + return, never throw (the next cadence fire retries).
    console.warn(
      `[plan-run] ${ctx.installSlug}: run of '${templateSlug}' FAILED: ${e instanceof Error ? e.message : e}`,
    );
  }
}

// `scheduling: 'on-demand'` (EI-18752496371939475): one row per scheduled PLAN, created by
// plans:arm-schedule — not a standing workspace-wide row to seed.
registerSystemAction('plan-run', handlePlanRun, { scheduling: 'on-demand' });
