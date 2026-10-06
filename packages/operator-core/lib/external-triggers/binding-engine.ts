/**
 * Durable external-trigger binding engine (external-triggers P-003).
 *
 * Ingestion records one `trigger-bindings` sink delivery after the event-bus sink.
 * That sink evaluates armed bindings and writes one idempotent trigger_runs outbox
 * row per match. A tier:durable system routine drains the outbox through the
 * canonical plan-run writer. Provider/request processes never need to host DBOS.
 */
import { createHash } from 'node:crypto';
import type postgres from 'postgres';
import { emitAwaitedEvent } from '../events/await/engine';
import { keyMatchesPattern, payloadMatchesFilter } from '../events/await/pattern';
import {
  runScheduledPlanFire,
  type ScheduledPlanFireOptions,
  type ScheduledPlanFireRefusal,
  type ScheduledPlanFireResult,
  type ScheduledPlanFireStartedResult,
} from '../harness/routines/plan-run-action';
import type { CanonicalExternalEvent, ExternalTriggerSink } from './ingestion';
import { redactTriggerArgsForPlanInputs, type TriggerRunArgs } from './plan-run-payload';
import { startGoalById, type StartGoalByIdResult } from '../goals/start-goal-by-id';
import { parseAgenticPlanExecutionTarget } from '../agentic-plan-execution-target';
import { openEscalation, resolveEscalation } from '../agent-tools/coordination/escalations';
import type { AgentIdentity } from '../agent-tools/coordination/identity';
import { createWorkItem, type CreateWorkItemInput, type WorkItem } from '../work-items';
import { getDatatype } from '../datatype-registry-store';
import { validateDatatypePayload } from '../datatype-payload-validation';
import {
  submitBlueprintOperation,
  type BlueprintOperationHandle,
  type SubmitBlueprintOperationInput,
} from '../blueprint/operation-service';

type Db = postgres.Sql | postgres.TransactionSql;

const DEFAULT_STORM_WINDOW_SECONDS = 60;
/**
 * EVERY binding gets a cap. An ABSENT `maxRuns` used to mean UNBOUNDED, which
 * made `{ windowSeconds: 60 }` — the exact shape the admin composer persists
 * when the caller states no policy — a rate window with nothing to rate-limit
 * against. On 2026-08-26 a Gmail poller closed a 2h35m resync gap and that
 * binding minted 228 autonomous plan runs in 68s (~3.4/s), each one a real
 * agent launch, until it was disarmed by hand (EI-21500982767775449).
 *
 * Half-specified config is more dangerous than absent config: `windowSeconds`
 * alone READS as configured in every dump of the row, so the missing cap is
 * invisible while the present field looks like rate limiting. That is why the
 * repair is a DEFAULT rather than a refusal — a refusal protects rows written
 * after it lands and leaves every already-stored row uncapped.
 *
 * 12 runs / 60s is ~720/hour: far above any human-paced source, far below a
 * replayed backlog, and the same magnitude as the social conservative default
 * (`FALLBACK_MAX_RUNS`, 12/300s), so the system tells ONE story about a safe
 * autonomous launch rate. Overflow is recorded as a `skipped` trigger_run
 * carrying `external_trigger_storm_limit`, so a throttled burst stays visible
 * rather than being silently dropped. A caller that genuinely needs more says
 * so with an explicit `maxRuns`; asking for unbounded is deliberately not
 * expressible.
 */
const DEFAULT_STORM_MAX_RUNS = 12;
/**
 * EVERY binding also gets a dispatch-time validity window (WI-10004920). The storm
 * cap above is applied at ENQUEUE time, so it cannot see a backlog that piled up
 * while the drain was down: on 2026-09-15 the dispatcher routine was paused for two
 * weeks while ingestion kept queuing (122 runs), and nothing stopped a re-arm from
 * firing every armed binding's backlog at batch speed — e.g. launching plans for
 * calendar events that had already happened.
 *
 * A run that was NEVER attempted and is older than `maxAgeSeconds` (measured from
 * `triggered_at`) is closed `skipped` with `external_trigger_stale` at claim time
 * instead of dispatched, so the drop stays visible in the run ledger. Runs that
 * already began dispatch keep their own retry policy: their intent was acted on in
 * time, and what remains is finishing it. Same shape as the storm cap: absent means
 * the bounded default, and unbounded is deliberately not expressible.
 */
const DEFAULT_MAX_RUN_AGE_SECONDS = 24 * 60 * 60;
const MAX_RUN_AGE_CEILING_SECONDS = 31 * 24 * 60 * 60;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_STALE_AFTER_SECONDS = 60;
/** Slow parked cadence after the ordinary retry budget is exhausted. */
const RECOVERABLE_RETRY_AFTER_SECONDS = 15 * 60;

const EXTERNAL_TRIGGER_IDENTITY: AgentIdentity = {
  ownerId: 'system:external-trigger-dispatch',
  ownerLabel: 'system · external-trigger-dispatch',
  source: 'principal',
  workspaceId: null,
  userId: null,
};

/**
 * The action vocabulary (work-on-everything-goal-2026-08-23 P-020, D-006).
 * `launch-plan` mints a plan run; `start-goal` ACTIVATES the binding's target
 * goal through the one goal-activation primitive (`startGoalById`) — never a
 * second spawn path; `create-work-item` writes one bounded item through the
 * canonical work_items facade.
 */
const SUPPORTED_TRIGGER_ACTIONS: ReadonlySet<string> = new Set([
  'launch-plan',
  'start-goal',
  'create-work-item',
  'blueprint-operation',
]);

/** The Email direct-ingress contract owned by the registered datatype. */
export const EMAIL_DRAFT_PROPOSAL_KIND = 'email-draft-proposal';
export const EMAIL_DRAFT_PROPOSAL_HARNESS = 'email';
export const EMAIL_DRAFT_PROPOSAL_SCHEMA_VERSION = 'email-draft-proposal/v1';

interface DirectWorkItemTarget {
  harnessSlug: string;
  kind: string;
}

interface DirectWorkItemProvenance {
  schemaVersion: string;
  eventKey: string;
  triggerRef: string;
  dedupeKey: string;
  sourceId: string;
  externalId: string;
  triggerRunId: string;
}

interface BindingRow {
  id: string;
  sourceId: string;
  /** Nullable since migration 921: a binding targets EXACTLY ONE of plan / goal. */
  planHarnessSlug: string | null;
  planSlug: string | null;
  goalId: string | null;
  workItemHarnessSlug: string | null;
  workItemKind: string | null;
  eventPattern: string;
  eventFilter: Record<string, unknown>;
  action: Record<string, unknown>;
  armed: boolean;
  stormPolicy: Record<string, unknown>;
  /** Portable binding datatype (P-012, D-013 §2); NULL matches any datatype. */
  datatypeId: string | null;
}

/** The internal source that stitches trigger-pack edges (P-012, D-013 §5). */
export const TRIGGER_PACK_EDGE_SOURCE_KIND = 'trigger-pack-edge';
export const TRIGGER_PACK_EDGE_EVENT = 'binding-run-completed';
export const TRIGGER_RUN_COMPLETION_DATATYPE = 'trigger-run-completion';

interface ClaimedTriggerRun {
  id: string;
  workspaceId: string;
  bindingId: string;
  planHarnessSlug: string | null;
  planSlug: string | null;
  goalId: string | null;
  workItemHarnessSlug: string | null;
  workItemKind: string | null;
  args: TriggerRunArgs;
  action: Record<string, unknown>;
  attempts: number;
  outcome: Record<string, unknown>;
}

// The envelope type and the "what is private in it" projection both live in
// ./plan-run-payload, so exactly one module decides what may leave trust level 1.


export interface StormPolicy {
  /**
   * Always a positive integer. `null` is deliberately NOT representable: an
   * unbounded policy is the defect `DEFAULT_STORM_MAX_RUNS` exists to remove,
   * and making the type express that is what stops a future caller from
   * reintroducing it one `?? null` at a time.
   */
  maxRuns: number;
  windowSeconds: number;
  /**
   * Dispatch-time validity window for a never-attempted run, in seconds.
   * Always bounded — see `DEFAULT_MAX_RUN_AGE_SECONDS`.
   */
  maxAgeSeconds: number;
}

export interface BindingEnqueueResult {
  matched: number;
  queued: number;
  deduped: number;
  skippedForStorm: number;
  failed: number;
  triggerRunIds: string[];
}

export interface TriggerDispatchResult {
  claimed: number;
  succeeded: number;
  failed: number;
  /**
   * `start-goal` runs closed TERMINALLY without an activation (goal gone /
   * not-active / no harness / already held) — refusals a re-firing trigger
   * treats as settled, never retried. Plan runs never land here.
   */
  skipped: number;
  /** Recoverable rows parked beyond the ordinary retry budget this pass. */
  deferred: number;
  triggerRunIds: string[];
}

type RunPlan = (sql: postgres.Sql, opts: ScheduledPlanFireOptions) => Promise<ScheduledPlanFireResult>;

export interface TriggerDispatchDeps {
  runPlan?: RunPlan;
  /** The goal-activation primitive (P-020) — injectable for tests, `startGoalById` in production. */
  startGoal?: (
    sql: postgres.Sql,
    input: { workspaceId: string; goalId: string; launcherOwnerId: string },
  ) => Promise<StartGoalByIdResult>;
  announceRunWork?: (sql: postgres.Sql, workspaceId: string, runId: number) => Promise<void>;
  openEscalation?: typeof openEscalation;
  resolveEscalation?: typeof resolveEscalation;
  /** Canonical work-item writer for direct bindings; injectable for isolated tests. */
  createWorkItem?: typeof createWorkItem;
  /** Canonical blueprint-operation admission writer; injectable for integration seams. */
  submitOperation?: (
    sql: postgres.Sql,
    input: SubmitBlueprintOperationInput,
  ) => Promise<BlueprintOperationHandle>;
  batchSize?: number;
  staleAfterSeconds?: number;
}

type AgenticDispatchResult = NonNullable<ScheduledPlanFireStartedResult['dispatch']>;

function planRunRefusalError(refusal: ScheduledPlanFireRefusal): string {
  if (refusal.reason === 'concurrency-skip') {
    return 'external_trigger_plan_run_skipped:concurrency-skip';
  }
  return `external_trigger_plan_run_refused:${refusal.reason}:${refusal.readiness?.code ?? 'unknown'}`;
}

function planRunRefusalOutcome(refusal: ScheduledPlanFireRefusal): Record<string, unknown> {
  return {
    planRunRefusal: {
      reason: refusal.reason,
      detail: refusal.detail,
      retryable: refusal.retryable,
      ...(refusal.readiness ? { readiness: refusal.readiness } : {}),
      ...(refusal.priorRunId === undefined ? {} : { priorRunId: refusal.priorRunId }),
    },
  };
}

class ExternalTriggerPlanRunRefusalError extends Error {
  constructor(readonly refusal: ScheduledPlanFireRefusal) {
    super(planRunRefusalError(refusal));
  }
}

class ExternalTriggerAgenticDispatchError extends Error {
  constructor(readonly dispatch: AgenticDispatchResult) {
    super(`external_trigger_agentic_dispatch_failed:${dispatch.failure?.code ?? 'assignment_failed'}`);
  }
}

interface PersistedDispatchFailure {
  code: string;
  target: string | null;
  recoverable: boolean;
  queuePreserved: boolean;
  message: string | null;
}

function persistedDispatchFailure(cause: unknown): PersistedDispatchFailure | null {
  if (!(cause instanceof ExternalTriggerAgenticDispatchError)) return null;
  const failure = cause.dispatch.failure;
  return {
    code: failure?.code ?? 'assignment_failed',
    target: failure?.target ?? cause.dispatch.target.ownerId ?? null,
    recoverable: failure?.recoverable === true,
    queuePreserved: failure?.queuePreserved === true,
    message: failure?.message ?? cause.dispatch.warning ?? null,
  };
}

function persistedPlanRunRefusal(cause: unknown): ScheduledPlanFireRefusal | null {
  return cause instanceof ExternalTriggerPlanRunRefusalError ? cause.refusal : null;
}

function retryEscalationMsgId(outcome: Record<string, unknown>): string | null {
  const value = outcome.retryEscalationMsgId;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

async function openRecoverableRetryEscalation(
  row: ClaimedTriggerRun,
  failure: PersistedDispatchFailure,
  open: typeof openEscalation,
): Promise<string> {
  const escalation = await open(
    { ...EXTERNAL_TRIGGER_IDENTITY, workspaceId: row.workspaceId },
    {
      severity: 'advisory',
      summary: `External trigger binding ${row.bindingId} is parked: target ${failure.target ?? 'unknown'} unavailable after ${row.attempts} attempts`,
      body:
        `Trigger run ${row.id} remains durably queued; the provider event was not discarded. ` +
        `Its required wake failed with ${failure.code} after ${row.attempts} attempts and will retry every ` +
        `${Math.round(RECOVERABLE_RETRY_AFTER_SECONDS / 60)} minutes while recoverable work remains preserved.\n\n` +
        `Binding: ${row.bindingId}\nTarget: ${failure.target ?? 'unknown'}\n` +
        `Action: restore/relaunch the stable target or correct/disarm the binding. The escalation auto-resolves ` +
        `after the binding has no remaining recoverable failed rows.`,
      ...(row.planHarnessSlug ? { harness_slug: row.planHarnessSlug } : {}),
      meta: {
        subjectSignature: `external-trigger-retry:${row.workspaceId}:${row.bindingId}`,
        dedupKind: 'external-trigger-retry',
      },
    },
  );
  return escalation.msg_id;
}

async function resolveRetryEscalationIfRecovered(
  sql: postgres.Sql,
  row: ClaimedTriggerRun,
  resolve: typeof resolveEscalation,
): Promise<void> {
  const msgId = retryEscalationMsgId(row.outcome);
  if (!msgId) return;
  const outstanding = await sql<Array<{ count: number }>>`
    SELECT count(*)::int AS count
      FROM harness_shared.trigger_runs
     WHERE workspace_id = ${row.workspaceId}
       AND binding_id = ${row.bindingId}
       AND id <> ${row.id}
       AND status = 'failed'
       AND outcome #>> '{dispatchFailure,recoverable}' = 'true'
       AND outcome #>> '{dispatchFailure,queuePreserved}' = 'true'`;
  if ((outstanding[0]?.count ?? 0) > 0) return;
  await resolve({
    msg_id: msgId,
    choice: 'recovered',
    note: `External trigger binding ${row.bindingId} recovered on run ${row.id}.`,
    resolver: EXTERNAL_TRIGGER_IDENTITY.ownerId,
  });
}

function positiveInteger(value: unknown, field: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`external_trigger_invalid_${field}`);
  }
  return parsed;
}

/**
 * Parse the small, explicit v1 storm-policy vocabulary. An empty or
 * cap-less policy resolves to the bounded default, never to unbounded —
 * see `DEFAULT_STORM_MAX_RUNS`.
 */
export function parseStormPolicy(raw: Record<string, unknown>): StormPolicy {
  const maxRaw = raw.maxRuns ?? raw.max_runs;
  const windowRaw = raw.windowSeconds ?? raw.window_seconds;
  const maxAgeRaw = raw.maxAgeSeconds ?? raw.max_age_seconds;
  const maxAgeSeconds =
    maxAgeRaw === undefined || maxAgeRaw === null
      ? DEFAULT_MAX_RUN_AGE_SECONDS
      : positiveInteger(maxAgeRaw, 'storm_max_age_seconds');
  if (maxAgeSeconds > MAX_RUN_AGE_CEILING_SECONDS) {
    throw new Error('external_trigger_invalid_storm_max_age_seconds');
  }
  return {
    maxRuns:
      maxRaw === undefined || maxRaw === null ? DEFAULT_STORM_MAX_RUNS : positiveInteger(maxRaw, 'storm_max_runs'),
    windowSeconds:
      windowRaw === undefined || windowRaw === null
        ? DEFAULT_STORM_WINDOW_SECONDS
        : positiveInteger(windowRaw, 'storm_window_seconds'),
    maxAgeSeconds,
  };
}

/** Stable decimal token accepted by the canonical `<plan>@run-<digits>` grammar. */
export function triggerRunPlanToken(triggerRunId: string): string {
  const hex = createHash('sha256').update(triggerRunId).digest('hex').slice(0, 15);
  return BigInt(`0x${hex}`).toString(10);
}

function triggerArgs(event: CanonicalExternalEvent): TriggerRunArgs {
  return {
    trigger: {
      key: event.key,
      source: event.source,
      event: event.event,
      sourceId: event.sourceId,
      externalId: event.externalId,
      occurredAt: event.occurredAt ?? null,
      datatypeId: event.datatypeId,
      dedupeKey: event.dedupeKey,
      payload: event.payload,
    },
  };
}

function actionType(action: Record<string, unknown>): string {
  const type = typeof action.type === 'string' ? action.type.trim() : '';
  return type || 'launch-plan';
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function blueprintOperationTarget(action: Record<string, unknown>): {
  harnessSlug: string;
  operationId: string;
  input: Record<string, unknown>;
} {
  const harnessSlug = typeof action.operationHarnessSlug === 'string'
    ? action.operationHarnessSlug.trim()
    : '';
  const operationId = typeof action.operationId === 'string' ? action.operationId.trim() : '';
  if (!harnessSlug || !operationId) throw new Error('external_trigger_blueprint_operation_target_invalid');
  if (action.input !== undefined && (action.input === null || Array.isArray(action.input) || typeof action.input !== 'object')) {
    throw new Error('external_trigger_blueprint_operation_input_invalid');
  }
  return { harnessSlug, operationId, input: record(action.input) };
}

function directWorkItemTarget(row: Pick<BindingRow, 'workItemHarnessSlug' | 'workItemKind'>): DirectWorkItemTarget | null {
  const harnessSlug = row.workItemHarnessSlug?.trim() || null;
  const kind = row.workItemKind?.trim() || null;
  if ((harnessSlug === null) !== (kind === null)) {
    throw new Error('external_trigger_direct_target_incomplete');
  }
  return harnessSlug && kind ? { harnessSlug, kind } : null;
}

/** Stable reference written into the strict Email payload and used for retry lookup. */
export function directWorkItemTriggerRef(triggerRunId: string, bindingId: string): string {
  return `external-trigger:${bindingId}:${triggerRunId}`;
}

function requiredEmailPayloadString(payload: Record<string, unknown>, field: string): string {
  const value = payload[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`external_trigger_email_draft_${field}_required`);
  }
  return value;
}

function requiredEmailPayloadStringArray(payload: Record<string, unknown>, field: string): string[] {
  const value = payload[field];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry.trim().length === 0)) {
    throw new Error(`external_trigger_email_draft_${field}_array_required`);
  }
  return value.map((entry) => entry as string);
}

/**
 * Map the normalized Gmail event into the registered, versioned Email kind.
 * Event key and provider dedupe remain immutable trigger-run fields; only the
 * stable trigger reference is admitted by the strict work-item payload schema.
 */
async function directEmailWorkItem(
  sql: postgres.Sql,
  row: ClaimedTriggerRun,
  target: DirectWorkItemTarget,
): Promise<{ input: CreateWorkItemInput; provenance: DirectWorkItemProvenance }> {
  if (target.harnessSlug !== EMAIL_DRAFT_PROPOSAL_HARNESS || target.kind !== EMAIL_DRAFT_PROPOSAL_KIND) {
    throw new Error(`external_trigger_unsupported_direct_target:${target.harnessSlug}/${target.kind}`);
  }
  const trigger = row.args.trigger;
  if (trigger.key !== 'ext:gmail:message.received' || trigger.source !== 'gmail' || trigger.event !== 'message.received') {
    throw new Error('external_trigger_email_event_mismatch');
  }
  const datatype = await getDatatype(sql, row.workspaceId, EMAIL_DRAFT_PROPOSAL_KIND);
  if (
    !datatype ||
    datatype.status !== 'active' ||
    datatype.tier !== 'generic-kind' ||
    datatype.workItemKind !== EMAIL_DRAFT_PROPOSAL_KIND
  ) {
    throw new Error(`external_trigger_unknown_work_item_kind:${EMAIL_DRAFT_PROPOSAL_KIND}`);
  }
  const triggerRef = directWorkItemTriggerRef(row.id, row.bindingId);
  const sourcePayload = trigger.payload;
  const payload: Record<string, unknown> = {
    messageId: requiredEmailPayloadString(sourcePayload, 'messageId'),
    threadId: requiredEmailPayloadString(sourcePayload, 'threadId'),
    from: requiredEmailPayloadString(sourcePayload, 'from'),
    to: requiredEmailPayloadStringArray(sourcePayload, 'to'),
    subject: requiredEmailPayloadString(sourcePayload, 'subject'),
    text: requiredEmailPayloadString(sourcePayload, 'text'),
    policy: { draftOnly: true },
    triggerRef,
  };
  const validation = validateDatatypePayload(datatype.payloadSchema, payload);
  if (!validation.ok) {
    throw new Error(`external_trigger_invalid_work_item_payload:${validation.errors.join('; ')}`);
  }
  const subject = String(payload.subject);
  const provenance: DirectWorkItemProvenance = {
    schemaVersion: EMAIL_DRAFT_PROPOSAL_SCHEMA_VERSION,
    eventKey: trigger.key,
    triggerRef,
    dedupeKey: trigger.dedupeKey,
    sourceId: trigger.sourceId,
    externalId: trigger.externalId,
    triggerRunId: row.id,
  };
  return {
    input: {
      kind: EMAIL_DRAFT_PROPOSAL_KIND as CreateWorkItemInput['kind'],
      title: `Draft reply: ${subject}`,
      summary: `Prepare a draft-only reply for Gmail message ${payload.messageId} in thread ${payload.threadId}.`,
      harness: target.harnessSlug,
      workspaceId: row.workspaceId,
      payload,
      createdBy: EXTERNAL_TRIGGER_IDENTITY.ownerId,
    },
    provenance,
  };
}

async function existingDirectWorkItemId(
  sql: postgres.Sql,
  row: ClaimedTriggerRun,
  target: DirectWorkItemTarget,
  triggerRef: string,
): Promise<string | null> {
  const rows = await sql<Array<{ id: string }>>`
    SELECT feature_id AS id
      FROM harness_shared.harness_features_consolidated
     WHERE workspace_id = ${row.workspaceId}
       AND harness_slug = ${target.harnessSlug}
       AND item_kind = ${target.kind}
       AND payload ->> 'triggerRef' = ${triggerRef}
     ORDER BY created_ts, feature_id
     LIMIT 1`;
  return rows[0]?.id ?? null;
}

async function loadBindingForUpdate(tx: Db, workspaceId: string, id: string): Promise<BindingRow | null> {
  const rows = await tx<BindingRow[]>`
    SELECT id,
           source_id AS "sourceId",
           plan_harness_slug AS "planHarnessSlug",
           plan_slug AS "planSlug",
           goal_id AS "goalId",
           work_item_harness_slug AS "workItemHarnessSlug",
           work_item_kind AS "workItemKind",
           event_pattern AS "eventPattern",
           event_filter AS "eventFilter",
           action,
           armed,
           storm_policy AS "stormPolicy",
           datatype_id AS "datatypeId"
      FROM harness_shared.trigger_bindings
     WHERE workspace_id = ${workspaceId} AND id = ${id}
       AND detached_at IS NULL
     FOR UPDATE`;
  return rows[0] ?? null;
}

async function insertTerminalTriggerRun(
  tx: Db,
  input: {
    event: CanonicalExternalEvent;
    binding: BindingRow;
    deliveryId: string;
    status: 'failed' | 'skipped';
    error: string;
  },
): Promise<{ id: string; inserted: boolean; status: string }> {
  const args = JSON.stringify(triggerArgs(input.event));
  const rows = await tx<Array<{ id: string; status: string }>>`
    INSERT INTO harness_shared.trigger_runs
      (workspace_id, binding_id, delivery_id, dedupe_key, status, args,
       error, completed_at, updated_at)
    VALUES (${input.event.workspaceId}, ${input.binding.id}, ${input.deliveryId},
            ${input.event.dedupeKey}, ${input.status}, ${args}::text::jsonb,
            ${input.error}, now(), now())
    ON CONFLICT (workspace_id, binding_id, dedupe_key) DO NOTHING
    RETURNING id, status`;
  if (rows[0]) return { ...rows[0], inserted: true };
  const existing = await tx<Array<{ id: string; status: string }>>`
    SELECT id, status FROM harness_shared.trigger_runs
     WHERE workspace_id = ${input.event.workspaceId}
       AND binding_id = ${input.binding.id}
       AND dedupe_key = ${input.event.dedupeKey}`;
  if (!existing[0]) throw new Error('external_trigger_run_insert_lost');
  return { ...existing[0], inserted: false };
}

async function queueOneBinding(
  sql: postgres.Sql,
  event: CanonicalExternalEvent,
  bindingId: string,
  deliveryId: string,
): Promise<{ id: string; inserted: boolean; status: string } | null> {
  return sql.begin(async (tx) => {
    const binding = await loadBindingForUpdate(tx, event.workspaceId, bindingId);
    if (!binding?.armed) return null;
    if (!keyMatchesPattern(binding.eventPattern, event.key)) return null;
    // A portable pack binding is bound to a datatype, not a provider event
    // name: a source emitting several datatypes queues only the declared one.
    if (binding.datatypeId && binding.datatypeId !== event.datatypeId) return null;
    if (!payloadMatchesFilter(binding.eventFilter, event.payload)) return null;

    if (!SUPPORTED_TRIGGER_ACTIONS.has(actionType(binding.action))) {
      return insertTerminalTriggerRun(tx, {
        event,
        binding,
        deliveryId,
        status: 'failed',
        error: `external_trigger_unsupported_action:${actionType(binding.action)}`,
      });
    }

    let storm: StormPolicy;
    try {
      storm = parseStormPolicy(binding.stormPolicy);
    } catch (cause) {
      return insertTerminalTriggerRun(tx, {
        event,
        binding,
        deliveryId,
        status: 'failed',
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }

    // Unconditional: `parseStormPolicy` always yields a cap, so there is no
    // longer a policy shape that skips this check.
    const recent = await tx<Array<{ count: number }>>`
      SELECT count(*)::int AS count
        FROM harness_shared.trigger_runs
       WHERE workspace_id = ${event.workspaceId}
         AND binding_id = ${binding.id}
         AND status <> 'cancelled'
         AND triggered_at >= now() - (${storm.windowSeconds} * interval '1 second')`;
    if ((recent[0]?.count ?? 0) >= storm.maxRuns) {
      return insertTerminalTriggerRun(tx, {
        event,
        binding,
        deliveryId,
        status: 'skipped',
        error: `external_trigger_storm_limit:${storm.maxRuns}/${storm.windowSeconds}s`,
      });
    }

    const args = JSON.stringify(triggerArgs(event));
    const inserted = await tx<Array<{ id: string; status: string }>>`
      INSERT INTO harness_shared.trigger_runs
        (workspace_id, binding_id, delivery_id, dedupe_key, status, args, updated_at)
      VALUES (${event.workspaceId}, ${binding.id}, ${deliveryId}, ${event.dedupeKey},
              'pending', ${args}::text::jsonb, now())
      ON CONFLICT (workspace_id, binding_id, dedupe_key) DO NOTHING
      RETURNING id, status`;
    if (inserted[0]) return { ...inserted[0], inserted: true };
    const existing = await tx<Array<{ id: string; status: string }>>`
      SELECT id, status FROM harness_shared.trigger_runs
       WHERE workspace_id = ${event.workspaceId}
         AND binding_id = ${binding.id}
         AND dedupe_key = ${event.dedupeKey}`;
    if (!existing[0]) throw new Error('external_trigger_run_queue_lost');
    return { ...existing[0], inserted: false };
  });
}

/** Match armed bindings and durably queue one trigger_run per match. */
export async function queueExternalTriggerBindings(
  sql: postgres.Sql,
  event: CanonicalExternalEvent,
): Promise<BindingEnqueueResult> {
  const deliveries = await sql<Array<{ id: string }>>`
    SELECT id FROM harness_shared.trigger_deliveries
     WHERE workspace_id = ${event.workspaceId}
       AND source_id = ${event.sourceId}
       AND dedupe_key = ${event.dedupeKey}
       AND sink_kind = 'event-bus' AND sink_ref = 'workspace'
       AND outcome = 'delivered'
     LIMIT 1`;
  if (!deliveries[0]) throw new Error('external_trigger_event_bus_delivery_required');

  const candidates = await sql<Array<{ id: string }>>`
    SELECT id FROM harness_shared.trigger_bindings
     WHERE workspace_id = ${event.workspaceId}
       AND source_id = ${event.sourceId}
       AND armed = TRUE
       AND detached_at IS NULL
     ORDER BY created_at, id`;

  const result: BindingEnqueueResult = {
    matched: 0,
    queued: 0,
    deduped: 0,
    skippedForStorm: 0,
    failed: 0,
    triggerRunIds: [],
  };
  for (const candidate of candidates) {
    const queued = await queueOneBinding(sql, event, candidate.id, deliveries[0].id);
    if (!queued) continue;
    result.matched += 1;
    result.triggerRunIds.push(queued.id);
    if (!queued.inserted) result.deduped += 1;
    else if (queued.status === 'pending') result.queued += 1;
    else if (queued.status === 'skipped') result.skippedForStorm += 1;
    else result.failed += 1;
  }
  return result;
}

/** The default ingestion sink; its own trigger_deliveries row dedupes enqueue. */
export function createTriggerBindingSink(sql: postgres.Sql): ExternalTriggerSink {
  return {
    kind: 'trigger-bindings',
    ref: 'workspace',
    deliver: (event) => queueExternalTriggerBindings(sql, event),
  };
}

async function claimPendingTriggerRuns(
  sql: postgres.Sql,
  batchSize: number,
  staleAfterSeconds: number,
): Promise<ClaimedTriggerRun[]> {
  return sql.begin(async (tx) => {
    // WI-10004920: a never-attempted run older than its binding's validity window.
    // Written once and used twice — the expiring CTE and the candidates CTE MUST stay
    // disjoint, because two data-modifying CTEs touching the same row in one statement
    // is undefined in Postgres. A malformed stored value falls back to the default
    // rather than aborting the whole claim transaction on a bad cast.
    const stale = tx`(
      tr.status = 'pending'
      AND tr.attempts = 0
      AND tr.triggered_at < now() - (
        CASE WHEN binding.storm_policy->>'maxAgeSeconds' ~ '^[0-9]{1,9}$'
             THEN GREATEST(1, LEAST((binding.storm_policy->>'maxAgeSeconds')::int, ${MAX_RUN_AGE_CEILING_SECONDS}))
             ELSE ${DEFAULT_MAX_RUN_AGE_SECONDS}
        END * interval '1 second'))`;
    return tx<ClaimedTriggerRun[]>`
    WITH expired_stale AS (
      UPDATE harness_shared.trigger_runs tr
         SET status = 'skipped',
             completed_at = now(),
             updated_at = now(),
             error = 'external_trigger_stale: never dispatched within the binding maxAgeSeconds'
        FROM harness_shared.trigger_bindings binding
       WHERE binding.workspace_id = tr.workspace_id
         AND binding.id = tr.binding_id
         AND binding.detached_at IS NULL
         AND binding.armed = TRUE
         AND ${stale}
      RETURNING tr.workspace_id, tr.id
    ), cancelled_disarmed AS (
      UPDATE harness_shared.trigger_runs tr
         SET status = 'cancelled',
             completed_at = now(),
             updated_at = now(),
             next_attempt_at = now(),
             error = COALESCE(tr.error, 'binding disarmed before dispatch')
        FROM harness_shared.trigger_bindings binding
       WHERE binding.workspace_id = tr.workspace_id
         AND binding.id = tr.binding_id
         AND binding.detached_at IS NULL
         AND binding.armed = FALSE
         AND (
           tr.status IN ('pending', 'failed')
           OR (tr.status = 'running'
               AND tr.started_at < now() - (${staleAfterSeconds} * interval '1 second'))
         )
      RETURNING tr.workspace_id, tr.id
    ), candidates AS (
      SELECT tr.workspace_id, tr.id
        FROM harness_shared.trigger_runs tr
        JOIN harness_shared.trigger_bindings binding
          ON binding.workspace_id = tr.workspace_id
         AND binding.id = tr.binding_id
         AND binding.detached_at IS NULL
         AND binding.armed = TRUE
       WHERE tr.next_attempt_at <= now()
         AND NOT ${stale}
         AND (
           (tr.attempts < ${DEFAULT_MAX_ATTEMPTS}
            AND (
              tr.status IN ('pending', 'failed')
              OR (tr.status = 'running'
                  AND tr.started_at < now() - (${staleAfterSeconds} * interval '1 second'))
            ))
           OR (
             tr.status = 'failed'
             AND (
               (tr.outcome #>> '{dispatchFailure,recoverable}' = 'true'
                AND tr.outcome #>> '{dispatchFailure,queuePreserved}' = 'true')
               -- One rescue claim for rows written before structured failure
               -- persistence existed. The new attempt decides from live truth:
               -- queue-preserved failures stay eligible; others stop again.
               OR (tr.attempts = ${DEFAULT_MAX_ATTEMPTS}
                   AND tr.outcome -> 'dispatchFailure' IS NULL
                   AND tr.error IN (
                     'external_trigger_agentic_dispatch_failed:target_dead',
                     'external_trigger_agentic_dispatch_failed:target_absent',
                     'external_trigger_agentic_dispatch_failed:target_unwakeable',
                     'external_trigger_agentic_dispatch_failed:wake_delivery_unknown'
                   ))
             )
           )
         )
       ORDER BY tr.triggered_at, tr.id
       FOR UPDATE SKIP LOCKED
       LIMIT ${batchSize}
    ), claimed AS (
      UPDATE harness_shared.trigger_runs tr
         SET status = 'running', attempts = tr.attempts + 1, error = NULL,
             started_at = now(), completed_at = NULL, updated_at = now()
        FROM candidates c
       WHERE tr.workspace_id = c.workspace_id AND tr.id = c.id
      RETURNING tr.*
    )
    SELECT c.id,
           c.workspace_id AS "workspaceId",
           c.binding_id AS "bindingId",
           b.plan_harness_slug AS "planHarnessSlug",
           b.plan_slug AS "planSlug",
           b.goal_id AS "goalId",
           b.work_item_harness_slug AS "workItemHarnessSlug",
           b.work_item_kind AS "workItemKind",
           c.args,
           b.action,
           c.attempts,
           c.outcome
      FROM claimed c
      JOIN harness_shared.trigger_bindings b
        ON b.workspace_id = c.workspace_id
       AND b.id = c.binding_id
       AND b.detached_at IS NULL
     ORDER BY c.triggered_at, c.id`;
  });
}

async function resolvePlanRunId(
  sql: postgres.Sql,
  workspaceId: string,
  harnessSlug: string,
  instanceSlug: string,
  reportedId: number,
): Promise<number> {
  if (reportedId > 0) return reportedId;
  const rows = await sql<Array<{ id: number }>>`
    SELECT id FROM harness_shared.plan_runs
     WHERE workspace_id = ${workspaceId}
       AND harness_slug = ${harnessSlug}
       AND instance_plan_slug = ${instanceSlug}
     ORDER BY id DESC LIMIT 1`;
  if (!rows[0]) throw new Error('external_trigger_plan_run_replay_missing');
  return Number(rows[0].id);
}

async function announceRunWork(sql: postgres.Sql, workspaceId: string, runId: number): Promise<void> {
  const rows = await sql<
    Array<{
      id: string;
      kind: string;
      title: string;
      harness: string;
      state: string;
      plan: string | null;
    }>
  >`
    SELECT feature_id AS id, item_kind AS kind, title, harness_slug AS harness,
           status AS state, source_plan_slug AS plan
      FROM harness_shared.work_items
     WHERE workspace_id = ${workspaceId}
       AND payload -> 'plan_run' ->> 'runId' = ${String(runId)}
       AND status = 'todo' AND taken_by IS NULL`;
  for (const row of rows) {
    const payload = {
      id: row.id,
      kind: row.kind,
      severity: null,
      harness: row.harness,
      title: row.title,
      state: row.state,
      reason: 'created',
      plan: row.plan,
      tags: [],
    };
    await emitAwaitedEvent({
      key: 'work-item:created',
      summary: `${row.id} created (${row.kind}): ${row.title}`,
      payload,
      source: 'external-trigger',
    });
    await emitAwaitedEvent({
      key: 'work-item:claimable',
      summary: `${row.id} claimable (created): ${row.title}`,
      payload,
      source: 'external-trigger',
    });
  }
}

/**
 * Stitch trigger-pack edges (P-012, D-013 §5). When an upstream run succeeds
 * and some binding on the workspace's internal `trigger-pack-edge` source
 * filters on it, ingest one `ext:trigger-pack-edge:binding-run-completed`
 * event through the ordinary ingestion seam. Downstream bindings therefore get
 * the same outbox, storm cap, max-age and retry as any external event; there is
 * no second dispatcher. Dedupe is per upstream run, and correlation is
 * inherited, so a chain reads as one workflow. A failure is recorded on the
 * upstream run's outcome rather than failing a run whose own target succeeded.
 */
async function emitTriggerPackEdge(
  sql: postgres.Sql,
  row: ClaimedTriggerRun,
  details: { actionType: string; planRunId?: number | null; instancePlanSlug?: string | null },
): Promise<void> {
  const edgeSources = await sql<Array<{ sourceId: string }>>`
    SELECT DISTINCT b.source_id::text AS "sourceId"
      FROM harness_shared.trigger_bindings b
      JOIN harness_shared.data_sources s
        ON s.workspace_id = b.workspace_id AND s.id = b.source_id
     WHERE b.workspace_id = ${row.workspaceId}
       AND s.kind = ${TRIGGER_PACK_EDGE_SOURCE_KIND}
       AND b.detached_at IS NULL
       AND b.event_filter ->> 'upstreamBindingId' = ${row.bindingId}`;
  if (edgeSources.length === 0) return;
  const upstreamPayload = record(row.args?.trigger?.payload);
  const correlationId =
    typeof upstreamPayload.correlationId === 'string' && upstreamPayload.correlationId
      ? upstreamPayload.correlationId
      : row.id;
  const packInstallation = await sql<Array<{ id: string | null }>>`
    SELECT pack_installation_id::text AS id FROM harness_shared.trigger_bindings
     WHERE workspace_id = ${row.workspaceId} AND id = ${row.bindingId}`;
  const payload: Record<string, unknown> = {
    upstreamBindingId: row.bindingId,
    upstreamTriggerRunId: row.id,
    correlationId,
    actionType: details.actionType,
    planRunId: details.planRunId ?? null,
    instancePlanSlug: details.instancePlanSlug ?? null,
    completedAt: new Date().toISOString(),
    ...(packInstallation[0]?.id ? { packInstallationId: packInstallation[0].id } : {}),
  };
  const errors: string[] = [];
  const { ingestExternalTriggerEvent } = await import('./ingestion');
  for (const { sourceId } of edgeSources) {
    try {
      const ingested = await ingestExternalTriggerEvent(sql, {
        workspaceId: row.workspaceId,
        sourceId,
        source: TRIGGER_PACK_EDGE_SOURCE_KIND,
        event: TRIGGER_PACK_EDGE_EVENT,
        externalId: row.id,
        datatypeId: TRIGGER_RUN_COMPLETION_DATATYPE,
        adapterPayload: payload,
        normalize: (value) => value as Record<string, unknown>,
        dedupeKey: `${TRIGGER_PACK_EDGE_SOURCE_KIND}:${row.id}`,
      });
      if (!ingested.ok) {
        errors.push(
          ingested.validationErrors?.join('; ') ??
            ingested.deliveries.filter((d) => d.outcome === 'failed').map((d) => d.error).join('; '),
        );
      }
    } catch (cause) {
      errors.push(cause instanceof Error ? cause.message : String(cause));
    }
  }
  if (errors.length > 0) {
    await sql`
      UPDATE harness_shared.trigger_runs
         SET outcome = outcome || ${JSON.stringify({ triggerPackEdgeError: errors.join(' | ').slice(0, 500) })}::text::jsonb,
             updated_at = now()
       WHERE workspace_id = ${row.workspaceId} AND id = ${row.id}`;
  }
}

/** Claim and execute a bounded batch from the durable trigger_runs outbox. */
export async function dispatchPendingTriggerRuns(
  sql: postgres.Sql,
  deps: TriggerDispatchDeps = {},
): Promise<TriggerDispatchResult> {
  const batchSize = Math.min(200, positiveInteger(deps.batchSize ?? DEFAULT_BATCH_SIZE, 'batch_size'));
  const staleAfterSeconds = positiveInteger(
    deps.staleAfterSeconds ?? DEFAULT_STALE_AFTER_SECONDS,
    'stale_after_seconds',
  );
  const rows = await claimPendingTriggerRuns(sql, batchSize, staleAfterSeconds);
  const runPlan = deps.runPlan ?? runScheduledPlanFire;
  const startGoal = deps.startGoal ?? startGoalById;
  const announce = deps.announceRunWork ?? announceRunWork;
  const create = deps.createWorkItem ?? createWorkItem;
  const submitOperation = deps.submitOperation ?? submitBlueprintOperation;
  const escalate = deps.openEscalation ?? openEscalation;
  const resolveEscalationFn = deps.resolveEscalation ?? resolveEscalation;
  const result: TriggerDispatchResult = {
    claimed: rows.length,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    deferred: 0,
    triggerRunIds: rows.map((row) => row.id),
  };

  for (const row of rows) {
    try {
      const type = actionType(row.action);
      if (!SUPPORTED_TRIGGER_ACTIONS.has(type)) {
        throw new Error(`external_trigger_unsupported_action:${type}`);
      }

      // ── blueprint-operation (P-016 / D-020) ──────────────────────────────
      // The event receipt is already durable and idempotent. Reuse its stable
      // id as the operation request key, so a lost response or stale-running
      // retry resolves the same canonical operation receipt and target.
      if (type === 'blueprint-operation') {
        const target = blueprintOperationTarget(row.action);
        const routing = redactTriggerArgsForPlanInputs(row.args);
        const handle = await submitOperation(sql, {
          workspaceId: row.workspaceId,
          harnessSlug: target.harnessSlug,
          callerId: `trigger-binding:${row.bindingId}`,
          operationId: target.operationId,
          requestKey: `trigger-run:${row.id}`,
          // Only the redacted routing envelope leaves trigger_runs. The
          // authored literal overlay is configuration, never provider payload.
          input: { ...routing, ...target.input },
        });
        await sql`
          UPDATE harness_shared.trigger_runs
             SET status = 'succeeded',
                 plan_run_ref = ${handle.target.kind === 'plan' ? String(handle.target.runId) : null},
                 outcome = outcome || ${JSON.stringify({ blueprintOperation: handle })}::text::jsonb,
                 error = NULL, completed_at = now(), updated_at = now()
           WHERE workspace_id = ${row.workspaceId} AND id = ${row.id}`;
        result.succeeded += 1;
        await resolveRetryEscalationIfRecovered(sql, row, resolveEscalationFn).catch(() => undefined);
        await emitTriggerPackEdge(sql, row, { actionType: 'blueprint-operation' }).catch(() => undefined);
        continue;
      }

      // ── create-work-item (P-018): direct Email ingress ───────────────────
      // The trigger receipt/outbox remains the idempotency boundary. A retry
      // after a successful canonical create but a failed status update finds
      // the same triggerRef and adopts that item instead of minting a sibling.
      if (type === 'create-work-item') {
        const target = directWorkItemTarget(row);
        if (!target) throw new Error('external_trigger_missing_direct_target');
        const direct = await directEmailWorkItem(sql, row, target);
        const existingId = await existingDirectWorkItemId(sql, row, target, direct.provenance.triggerRef);
        let workItemId = existingId;
        let created: WorkItem | null = null;
        if (!workItemId) {
          created = await create(direct.input);
          workItemId = created?.id ?? null;
          if (!workItemId) throw new Error('external_trigger_direct_work_item_create_missing_id');
        }
        await sql`
          UPDATE harness_shared.trigger_runs
             SET status = 'succeeded', plan_run_ref = NULL,
                 outcome = outcome || ${JSON.stringify({
                   directWorkItemId: workItemId,
                   directWorkItem: {
                     ...direct.provenance,
                     workItemId,
                     harnessSlug: target.harnessSlug,
                     kind: target.kind,
                   },
                 })}::text::jsonb,
                 error = NULL, completed_at = now(), updated_at = now()
           WHERE workspace_id = ${row.workspaceId} AND id = ${row.id}`;
        result.succeeded += 1;
        await resolveRetryEscalationIfRecovered(sql, row, resolveEscalationFn).catch(() => undefined);
        await emitTriggerPackEdge(sql, row, { actionType: 'create-work-item' }).catch(() => undefined);
        continue;
      }

      // ── start-goal (P-020): activate the binding's target goal ──────────
      // The primitive owns every guard; this leg only maps its verdict onto
      // the outbox row. plan_run_ref stays NULL — a goal run's handle is
      // outcome.goalId + outcome.agentOwnerId, never a plan-run ref.
      if (type === 'start-goal') {
        if (!row.goalId) throw new Error('external_trigger_missing_goal_target');
        const started = await startGoal(sql, {
          workspaceId: row.workspaceId,
          goalId: row.goalId,
          launcherOwnerId: `trigger-binding:${row.bindingId}`,
        });
        if (started.ok) {
          await sql`
            UPDATE harness_shared.trigger_runs
               SET status = 'succeeded',
                   outcome = outcome || ${JSON.stringify({
                     goalId: started.goalId,
                     agentOwnerId: started.ownerId,
                     ...(started.warnings.length ? { warnings: started.warnings } : {}),
                   })}::text::jsonb,
                   error = NULL, completed_at = now(), updated_at = now()
             WHERE workspace_id = ${row.workspaceId} AND id = ${row.id}`;
          result.succeeded += 1;
          await resolveRetryEscalationIfRecovered(sql, row, resolveEscalationFn).catch(() => undefined);
          await emitTriggerPackEdge(sql, row, { actionType: 'start-goal' }).catch(() => undefined);
        } else if (started.reason === 'holder-unknown' || started.reason === 'not-ready') {
          // Heal-able refusals: liveness evidence recovers, prerequisites
          // complete. Throw → 'failed' → the outbox retries under attempts.
          throw new Error(`external_trigger_goal_start_refused:${started.reason}:${started.detail}`);
        } else {
          // Terminal refusals (not-found / not-active / no-harness /
          // already-held): the trigger's intent is settled — never retried.
          await sql`
            UPDATE harness_shared.trigger_runs
               SET status = 'skipped',
                   outcome = outcome || ${JSON.stringify({ goalId: row.goalId, refusal: started.reason })}::text::jsonb,
                   error = ${started.detail}, completed_at = now(), updated_at = now()
             WHERE workspace_id = ${row.workspaceId} AND id = ${row.id}`;
          result.skipped += 1;
        }
        continue;
      }

      // ── launch-plan (the original path) ─────────────────────────────────
      if (!row.planHarnessSlug || !row.planSlug) {
        throw new Error('external_trigger_missing_plan_target');
      }
      const execution = parseAgenticPlanExecutionTarget(row.action.execution);
      const launched = await runPlan(sql, {
        installSlug: row.planHarnessSlug,
        workspaceId: row.workspaceId,
        templateSlug: row.planSlug,
        trigger: 'event',
        runToken: triggerRunPlanToken(row.id),
        // `inputs` lands in work_items.payload.plan_run.inputs, which FEDERATES.
        // `row.args` keeps the owner's private ingest and stays in trigger_runs
        // (local); only the routing envelope crosses (WI-2143575). The agent
        // pulls the payload back with `triggers:read-payload` by planRunId.
        // The authored literal overlay (a pack's installer inputs, D-013 §5) is
        // configuration, never provider payload — the same overlay the
        // blueprint-operation path applies.
        inputs: { ...redactTriggerArgsForPlanInputs(row.args), ...record(row.action.input) },
        ...(execution ? { execution } : {}),
      });
      if (launched.started === false) {
        const refusalError = planRunRefusalError(launched);
        if (launched.retryable) {
          // A missing required input can become startable after the plan is
          // repaired. Preserve the typed diagnosis through the ordinary
          // failed/retry path instead of collapsing it into an opaque error.
          throw new ExternalTriggerPlanRunRefusalError(launched);
        }
        // Missing templates, schema/data mismatches, and policy skips are
        // settled outcomes for this trigger receipt. They must not burn the
        // outbox retry budget.
        await sql`
          UPDATE harness_shared.trigger_runs
             SET status = 'skipped', plan_run_ref = NULL,
                 outcome = outcome || ${JSON.stringify(planRunRefusalOutcome(launched))}::text::jsonb,
                 error = ${refusalError}, next_attempt_at = now(),
                 completed_at = now(), updated_at = now()
           WHERE workspace_id = ${row.workspaceId} AND id = ${row.id}`;
        result.skipped += 1;
        continue;
      }
      if (!launched) {
        // Defensive compatibility for an injected/legacy seam. Production
        // runScheduledPlanFire now returns a typed refusal instead of null.
        throw new Error('external_trigger_plan_run_not_started');
      }
      if (execution && (!launched.dispatch || !launched.dispatch.ok)) {
        if (launched.dispatch) throw new ExternalTriggerAgenticDispatchError(launched.dispatch);
        throw new Error('external_trigger_agentic_dispatch_failed:missing_dispatch_result');
      }
      const planRunId = await resolvePlanRunId(
        sql,
        row.workspaceId,
        row.planHarnessSlug,
        launched.instanceSlug,
        launched.runId,
      );
      if (execution && launched.dispatch!.assignment.executionWorkItemIds.length === 0) {
        await sql`
          UPDATE harness_shared.trigger_runs
             SET status = 'skipped', plan_run_ref = ${String(planRunId)},
                 outcome = outcome || ${JSON.stringify({
                   instancePlanSlug: launched.instanceSlug,
                   planRunId,
                   minted: launched.minted,
                   replayed: launched.replayed,
                   execution,
                   dispatch: launched.dispatch,
                   noConsumer: true,
                 })}::text::jsonb,
                 error = 'external_trigger_agentic_dispatch_no_consumer',
                 completed_at = now(), updated_at = now()
           WHERE workspace_id = ${row.workspaceId} AND id = ${row.id}`;
        result.skipped += 1;
        continue;
      }
      if (!execution) await announce(sql, row.workspaceId, planRunId);
      await sql`
        UPDATE harness_shared.trigger_runs
           SET status = 'succeeded', plan_run_ref = ${String(planRunId)},
               outcome = outcome || ${JSON.stringify({
                 instancePlanSlug: launched.instanceSlug,
                 planRunId,
                 minted: launched.minted,
                 replayed: launched.replayed,
                 ...(execution ? { execution, dispatch: launched.dispatch } : {}),
               })}::text::jsonb,
               error = NULL, completed_at = now(), updated_at = now()
         WHERE workspace_id = ${row.workspaceId} AND id = ${row.id}`;
      result.succeeded += 1;
      await resolveRetryEscalationIfRecovered(sql, row, resolveEscalationFn).catch(() => undefined);
      await emitTriggerPackEdge(sql, row, {
        actionType: 'launch-plan',
        planRunId,
        instancePlanSlug: launched.instanceSlug,
      }).catch(() => undefined);
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : String(cause);
      const dispatchFailure = persistedDispatchFailure(cause);
      const planRunRefusal = persistedPlanRunRefusal(cause);
      const deferred = Boolean(
        dispatchFailure?.recoverable && dispatchFailure.queuePreserved && row.attempts >= DEFAULT_MAX_ATTEMPTS,
      );
      const retryAfterSeconds = deferred ? RECOVERABLE_RETRY_AFTER_SECONDS : 0;
      const outcomePatch = dispatchFailure
        ? {
            dispatchFailure,
            retry: {
              deferred,
              retryAfterSeconds,
              attempts: row.attempts,
            },
          }
        : planRunRefusal
          ? planRunRefusalOutcome(planRunRefusal)
          : {};
      await sql`
        UPDATE harness_shared.trigger_runs
           SET status = 'failed', error = ${error},
               outcome = outcome || ${JSON.stringify(outcomePatch)}::text::jsonb,
               next_attempt_at = now() + make_interval(secs => ${retryAfterSeconds}),
               completed_at = now(), updated_at = now()
         WHERE workspace_id = ${row.workspaceId} AND id = ${row.id}`;
      if (deferred && dispatchFailure) {
        result.deferred += 1;
        try {
          const msgId = await openRecoverableRetryEscalation(row, dispatchFailure, escalate);
          await sql`
            UPDATE harness_shared.trigger_runs
               SET outcome = outcome || ${JSON.stringify({ retryEscalationMsgId: msgId })}::text::jsonb,
                   updated_at = now()
             WHERE workspace_id = ${row.workspaceId} AND id = ${row.id}`;
        } catch (escalationError) {
          console.error(
            `[external-trigger-dispatch] recoverable retry escalation failed for ${row.id}: ` +
              `${escalationError instanceof Error ? escalationError.message : String(escalationError)}`,
          );
        }
      }
      result.failed += 1;
    }
  }
  return result;
}
