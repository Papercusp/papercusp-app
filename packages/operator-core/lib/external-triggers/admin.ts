/**
 * Shared data/mutation seam for the external-trigger admin surface (P-004).
 *
 * The HTTP pane and the upcoming triggers:* agent verbs both consume these
 * functions. Keeping SQL here prevents a dashboard-only interpretation of armed
 * state, storm policy, or recent-run outcomes from drifting away from the tool
 * surface.
 */
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type postgres from 'postgres';
import {
  EMAIL_DRAFT_PROPOSAL_HARNESS,
  EMAIL_DRAFT_PROPOSAL_KIND,
  parseStormPolicy,
} from './binding-engine';
import { keyMatchesPattern, payloadMatchesFilter } from '../events/await/pattern';
import { getDatatype } from '../datatype-registry-store';
import { defaultSocialStormPolicyForSourceKind, socialStormPolicyFor } from './social/storm-policy';
import { getSocialPlatform, isSocialPlatformVerified } from './social/platform-registry';
import { socialCursorFreshness, type SocialCursorFreshness } from './social/cursor-freshness';
import type { PlanSchedule } from '../agent-tools/plans/source';
import { planScheduleRoutineName } from '../harness/routines/materialize-plan-schedule';
import { redactSensitiveValue } from '../sensitive-text';
import { parseAgenticPlanExecutionTarget, type AgenticPlanExecutionTarget } from '../agentic-plan-execution-target';

type Db = postgres.Sql | postgres.TransactionSql;

const SOURCE_KIND_RE = /^[a-z0-9][a-z0-9-]*$/;
const SOURCE_STATUSES = new Set(['unconfigured', 'ready', 'connecting', 'connected', 'degraded', 'error', 'disabled']);

export interface CreateExternalTriggerSourceInput {
  kind: string;
  config?: Record<string, unknown>;
  credentialRef?: string | null;
  status?: string;
  createdBy?: string | null;
}

export interface CreatedExternalTriggerSource {
  id: string;
  kind: string;
  status: string;
  config: Record<string, unknown>;
  credentialRef: string | null;
  cursor: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface CreateExternalTriggerBindingInput {
  sourceId: string;
  /** Plan target — required unless `goalId` is given (exactly one target, migration 921). */
  planHarnessSlug?: string | null;
  planSlug?: string | null;
  /**
   * Goal target (work-on-everything-goal-2026-08-23 P-020): the binding's
   * matches ACTIVATE this goal (action type `start-goal`, dispatched through
   * `startGoalById`) instead of launching a plan.
   */
  goalId?: string | null;
  /** Direct bounded work-item target (P-018). Both fields are required together. */
  workItemHarnessSlug?: string | null;
  workItemKind?: string | null;
  /** Registered blueprint-operation target (P-016). Both fields are paired. */
  operationHarnessSlug?: string | null;
  operationId?: string | null;
  /** Literal input merged over the redacted event routing envelope at dispatch. */
  operationInput?: Record<string, unknown>;
  /** Internal compatibility marker: the legacy plan binding this replacement preserves. */
  operationMigrationFromBindingId?: string | null;
  /**
   * Literal input overlaid on the redacted routing envelope when a PLAN target
   * launches (P-012, D-013 §5) — the same overlay the operation path applies.
   */
  planInput?: Record<string, unknown>;
  /** Portable binding (P-012): queue only canonical events of this datatype. */
  datatypeId?: string | null;
  /** The trigger-pack installation that owns this binding (P-012). */
  packInstallationId?: string | null;
  eventPattern: string;
  eventFilter?: Record<string, unknown>;
  stormPolicy?: Record<string, unknown>;
  createdBy?: string | null;
  /** Optional stable-agent direct execution contract for plan-targeted bindings. */
  execution?: AgenticPlanExecutionTarget | null;
}

export interface CreatedExternalTriggerBinding {
  id: string;
  sourceId: string;
  sourceKind: string;
  /** Null on a goal-targeted binding (exactly one of plan / goal, migration 921). */
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
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Platform facts a social trigger source carries beyond the generic row (P-027).
 *
 * Present only when the source's `kind` resolves to a registry platform — a
 * social source's kind IS its platform id, so `getSocialPlatform(kind)` is the
 * whole mapping. Non-social sources (gmail, gcal, slack, …) keep `social: null`
 * and render exactly as they did before.
 *
 * These are all DERIVED at read time from the registry and the persisted cursor.
 * Nothing here is a second copy of state: recording, say, a platform's rate
 * budget on the source row would be a value describing code that drifts the
 * moment the registry is corrected.
 */
export interface ExternalTriggerSocialAdminFacts {
  platformId: string;
  label: string;
  wave: 'A' | 'B' | 'C';
  /** Registry row verified against its cited sources. */
  verified: boolean;
  /**
   * The owner-side wall, when the platform declares one (Meta app review, a
   * TikTok audit, a paid tier). Surfaced because "not connected" and "cannot be
   * connected until the owner clears a review" are different problems, and only
   * one of them is worth an owner's attention today.
   */
  blockedOn: string | null;
  authMode: string;
  /**
   * Null when the platform cannot be read at any grant tier we hold — a
   * write-only row (`read: null`). Distinct from an unknown: the registry has
   * verified that no readable stream exists.
   */
  readTransport: string | null;
  /** Cursor freshness; see cursor-freshness.ts for why not a nullable date. */
  cursor: SocialCursorFreshness;
  /**
   * The storm cap this platform's rate budget funds, and whether a provider
   * throttle currently HOLDS all launches. `hold` is not `maxRuns: 0`: a cap of
   * zero says rationed-to-nothing, a hold says the provider told us to stop.
   */
  rateBudget: {
    maxRuns: number;
    windowSeconds: number;
    basis: string;
    hold: { reason: string; retryForbidden: boolean; untilMs: number | null } | null;
  };
  /** Write path verified separately from the row (a row can read before it can write). */
  writeVerified: boolean;
  writeVerbs: string[];
}

export interface ExternalTriggerSourceAdminRow {
  id: string;
  kind: string;
  status: string;
  config: Record<string, unknown>;
  credentialRef: string | null;
  cursor: Record<string, unknown>;
  lastConnectedAt: string | null;
  lastError: string | null;
  bindingCount: number;
  armedBindingCount: number;
  failedDeliveries24h: number;
  /** Null for every non-social source kind. */
  social: ExternalTriggerSocialAdminFacts | null;
}

export interface ExternalTriggerBindingAdminRow {
  id: string;
  sourceId: string;
  sourceKind: string;
  sourceStatus: string;
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
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  lastRun: {
    id: string;
    status: string;
    triggeredAt: string;
    completedAt: string | null;
    error: string | null;
  } | null;
  /**
   * The trigger pack that owns this binding (P-013, D-016 §7). Arming an
   * unreviewed pack binding goes through the pack review, not the toggle.
   * Absent/null for hand-bound bindings; the admin snapshot always sets it.
   */
  pack?: { installationId: string; pluginName: string; reviewed: boolean } | null;
}

export type ExternalTriggerRunDisposition =
  | 'ran'
  | 'running'
  | 'queued'
  | 'dropped'
  | 'deduped'
  | 'coalesced'
  | 'failed';

export interface ExternalTriggerOutcomeLink {
  kind: 'gmail-draft' | 'slack-thread';
  label: string;
  href: string | null;
}

export interface ExternalTriggerTimelineStep {
  stage: 'received' | 'matched' | 'policy' | 'launched' | 'completed';
  at: string | null;
  status: 'done' | 'active' | 'pending' | 'failed' | 'dropped';
  detail: string;
}

/**
 * One trigger-run visibility record shared by the global Activity view, the
 * per-plan Runs tab, and the existing RunDetailPanel. It is a projection of the
 * canonical trigger/plan-run ledgers — never a parallel activity store.
 */
export interface ExternalTriggerRunVisibility {
  id: string;
  bindingId: string;
  sourceKind: string;
  eventPattern: string;
  planHarnessSlug: string | null;
  planSlug: string | null;
  goalId: string | null;
  workItemHarnessSlug: string | null;
  workItemKind: string | null;
  status: string;
  attempts: number;
  dedupeKey: string;
  triggeredAt: string;
  startedAt: string | null;
  completedAt: string | null;
  planRunRef: string | null;
  error: string | null;
  causeSummary: string;
  policyDisposition: ExternalTriggerRunDisposition;
  policyDetail: string;
  eventFilter: Record<string, unknown>;
  stormPolicy: Record<string, unknown>;
  redactedPayload: Record<string, unknown>;
  action: Record<string, unknown>;
  blueprintOperation: {
    workspaceId: string;
    harnessSlug: string;
    receiptId: number;
    operationId: string;
    specificationRevision: string;
    target:
      | { kind: 'work-item'; id: string; status: string | null }
      | { kind: 'plan'; runId: number; instanceSlug: string; status: string | null; outcome: string | null };
  } | null;
  outcomeLinks: ExternalTriggerOutcomeLink[];
  timeline: ExternalTriggerTimelineStep[];
  planRun: {
    id: number;
    instancePlanSlug: string | null;
    status: string;
    launchedBy: string | null;
    workItems: { total: number; passed: number; failed: number; open: number };
    agents: string[];
    durationMs: number | null;
    costUsd: number;
  } | null;
}

type ExternalTriggerRunAdminBase = Pick<
  ExternalTriggerRunVisibility,
  | 'id'
  | 'bindingId'
  | 'sourceKind'
  | 'eventPattern'
  | 'planHarnessSlug'
  | 'planSlug'
  | 'workItemHarnessSlug'
  | 'workItemKind'
  | 'status'
  | 'attempts'
  | 'triggeredAt'
  | 'completedAt'
  | 'planRunRef'
  | 'error'
>;

/** Backward-compatible global snapshot row; new readers receive every field. */
export type ExternalTriggerRunAdminRow = ExternalTriggerRunAdminBase &
  Partial<Omit<ExternalTriggerRunVisibility, keyof ExternalTriggerRunAdminBase>>;

export interface ExternalTriggerAdminSnapshot {
  enabled: boolean;
  counts: {
    sources: number;
    bindings: number;
    armed: number;
    recentFailures: number;
  };
  sources: ExternalTriggerSourceAdminRow[];
  bindings: ExternalTriggerBindingAdminRow[];
  recentRuns: ExternalTriggerRunAdminRow[];
}

/** Per-plan schedule/manual state folded into the existing trigger admin read. */
export interface ExternalTriggerPlanAdminSnapshot {
  harnessSlug: string;
  planSlug: string;
  schedule: PlanSchedule | null;
  scheduleActive: boolean;
  scheduledAt: string | null;
  expiresAt: string | null;
  tzid: string | null;
  lastFire: string | null;
  nextFire: string | null;
  manualSource: 'input-schema' | 'template' | null;
}

export interface ExternalTriggerLastEventTestRun {
  id: string;
  bindingId: string;
  /**
   * The prior trigger-run this replay copied its envelope from, or `null` when
   * the binding had no settled run of its own and the envelope was rebuilt from
   * the source's last matching delivery (`eventSource: 'source-delivery'`).
   */
  sourceTriggerRunId: string | null;
  sourceDeliveryId: string;
  providerDedupeKey: string;
  /**
   * Which ledger row supplied the replayed event. `binding-run` copies an
   * already-validated `args.trigger` from this binding's own history;
   * `source-delivery` rebuilds it from the newest delivered event on the
   * binding's source that matches its pattern and filter, which is what lets a
   * freshly installed replacement binding be proven before it is armed.
   */
  eventSource: 'binding-run' | 'source-delivery';
  status: 'pending';
  triggeredAt: string;
  requestedBy: string;
  /**
   * The plan reached by this run may perform a provider write (for example a
   * Gmail draft or Slack thread reply). The caller must surface this before it
   * asks for confirmation; this flag keeps that consequence in the response.
   */
  providerWritePossible: true;
}

export type QueueExternalTriggerLastEventTestResult =
  | { ok: true; run: ExternalTriggerLastEventTestRun }
  | {
      ok: false;
      error: 'binding_not_found' | 'unsupported_binding_action' | 'no_last_event';
      bindingId: string;
      detail: string;
    };

interface SourceDbRow {
  id: string;
  kind: string;
  status: string;
  config: Record<string, unknown>;
  credentialRef: string | null;
  cursor: Record<string, unknown>;
  lastConnectedAt: Date | string | null;
  lastError: string | null;
  bindingCount: number;
  armedBindingCount: number;
  failedDeliveries24h: number;
}

interface BindingDbRow {
  id: string;
  sourceId: string;
  sourceKind: string;
  sourceStatus: string;
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
  createdBy: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
  lastRunId: string | null;
  lastRunStatus: string | null;
  lastRunTriggeredAt: Date | string | null;
  lastRunCompletedAt: Date | string | null;
  lastRunError: string | null;
  packInstallationId: string | null;
  packPluginName: string | null;
  packReviewed: boolean | null;
}

interface RunVisibilityDbRow {
  id: string;
  bindingId: string;
  sourceKind: string;
  sourceConfig: Record<string, unknown>;
  eventPattern: string;
  eventFilter: Record<string, unknown>;
  stormPolicy: Record<string, unknown>;
  planHarnessSlug: string | null;
  planSlug: string | null;
  goalId: string | null;
  workItemHarnessSlug: string | null;
  workItemKind: string | null;
  status: string;
  attempts: number;
  dedupeKey: string;
  args: Record<string, unknown>;
  outcome: Record<string, unknown>;
  action: Record<string, unknown>;
  triggeredAt: Date | string;
  startedAt: Date | string | null;
  completedAt: Date | string | null;
  planRunRef: string | null;
  error: string | null;
  deliveryPayload: Record<string, unknown> | null;
  receivedAt: Date | string | null;
  planRunId: number | string | null;
  instancePlanSlug: string | null;
  planRunStatus: string | null;
  planRunLaunchedBy: string | null;
  planRunLaunchedAt: number | string | null;
  planRunFinishedAt: number | string | null;
  workItemTotal: number | string;
  workItemPassed: number | string;
  workItemFailed: number | string;
  agents: unknown;
  costUsd: number | string;
  operationTargetStatus: string | null;
  operationTargetOutcome: string | null;
}

interface PlanTriggerDbRow {
  harnessSlug: string;
  planSlug: string;
  schedule: PlanSchedule | null;
  scheduleActive: boolean;
  scheduledAt: Date | string | null;
  expiresAt: Date | string | null;
  tzid: string | null;
  template: string | null;
  hasInputSchema: boolean;
}

interface RoutineFireDbRow {
  lastFire: Date | string | null;
  nextFire: Date | string | null;
}

function iso(value: Date | string | number | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function finiteNumber(value: unknown): number | null {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function short(value: unknown, max = 120): string {
  const normalized = text(value).replace(/\s+/g, ' ');
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function payloadString(payload: Record<string, unknown>, key: string): string {
  const direct = short(payload[key]);
  if (direct) return direct;
  for (const container of ['message', 'event', 'email', 'data']) {
    const nested = short(object(payload[container])[key]);
    if (nested) return nested;
  }
  return '';
}

export function summarizeExternalTriggerCause(
  sourceKind: string,
  eventPattern: string,
  payload: Record<string, unknown>,
): string {
  const subject = payloadString(payload, 'subject') || payloadString(payload, 'title');
  const sender = payloadString(payload, 'from') || payloadString(payload, 'sender');
  if (subject && sender) return short(`${subject} · ${sender}`);
  if (subject) return subject;
  const summary = payloadString(payload, 'summary') || payloadString(payload, 'text');
  if (summary) return summary;
  const channel = payloadString(payload, 'channelName') || payloadString(payload, 'channelId');
  if (channel) return short(`${sourceKind} · ${channel}`);
  return short(`${sourceKind} · ${eventPattern}`);
}

export function externalTriggerDisposition(
  status: string,
  outcome: Record<string, unknown>,
  error: string | null,
): { disposition: ExternalTriggerRunDisposition; detail: string } {
  const coalesced = finiteNumber(outcome.coalescedCount);
  if (coalesced && coalesced > 0) {
    return { disposition: 'coalesced', detail: `coalesced×${Math.floor(coalesced)}` };
  }
  const deduped = finiteNumber(outcome.dedupedCount ?? outcome.dedupeCount);
  if (deduped && deduped > 0) {
    return { disposition: 'deduped', detail: `deduped×${Math.floor(deduped)}` };
  }
  if (status === 'pending') return { disposition: 'queued', detail: 'queued' };
  if (status === 'running') return { disposition: 'running', detail: 'running' };
  if (status === 'succeeded') return { disposition: 'ran', detail: 'ran' };
  if (status === 'failed') {
    return { disposition: 'failed', detail: error ? `failed · ${short(error, 100)}` : 'failed' };
  }
  if (status === 'skipped') {
    const storm = error?.startsWith('external_trigger_storm_limit:')
      ? error.slice('external_trigger_storm_limit:'.length)
      : null;
    return { disposition: 'dropped', detail: storm ? `dropped · storm limit ${storm}` : 'dropped' };
  }
  return { disposition: 'dropped', detail: status === 'cancelled' ? 'dropped · cancelled' : `dropped · ${status}` };
}

function outcomeLinks(
  outcome: Record<string, unknown>,
  sourceConfig: Record<string, unknown>,
): ExternalTriggerOutcomeLink[] {
  const result: ExternalTriggerOutcomeLink[] = [];
  const gmail = object(outcome.gmailDraft);
  const draftId = text(gmail.draftId);
  if (draftId) {
    result.push({
      kind: 'gmail-draft',
      label: text(gmail.subject) || `Gmail draft ${draftId}`,
      href: `https://mail.google.com/mail/u/0/#drafts/${encodeURIComponent(draftId)}`,
    });
  }
  const slack = object(outcome.slackThreadReply);
  const channelId = text(slack.channelId);
  const threadId = text(slack.threadId);
  const teamId = text(sourceConfig.teamId);
  if (channelId && threadId) {
    const href = teamId
      ? `https://app.slack.com/client/${encodeURIComponent(teamId)}/${encodeURIComponent(channelId)}/thread-${encodeURIComponent(channelId)}-${encodeURIComponent(threadId.replace('.', ''))}`
      : null;
    result.push({
      kind: 'slack-thread',
      label: `Slack thread ${channelId}`,
      href,
    });
  }
  return result;
}

function blueprintOperationOutcome(
  outcome: Record<string, unknown>,
  targetStatus: string | null,
  targetOutcome: string | null,
): ExternalTriggerRunVisibility['blueprintOperation'] {
  const operation = object(outcome.blueprintOperation);
  const target = object(operation.target);
  const kind = text(target.kind);
  const receiptId = finiteNumber(operation.receiptId);
  const common = {
    workspaceId: text(operation.workspaceId),
    harnessSlug: text(operation.harnessSlug),
    receiptId: receiptId === null ? 0 : Math.floor(receiptId),
    operationId: text(operation.operationId),
    specificationRevision: text(operation.specificationRevision),
  };
  if (
    !common.workspaceId ||
    !common.harnessSlug ||
    common.receiptId <= 0 ||
    !common.operationId ||
    !common.specificationRevision
  ) {
    return null;
  }
  if (kind === 'work-item') {
    const id = text(target.id);
    return id ? { ...common, target: { kind, id, status: targetStatus } } : null;
  }
  if (kind === 'plan') {
    const runId = finiteNumber(target.runId);
    const instanceSlug = text(target.instanceSlug);
    return runId !== null && runId > 0 && instanceSlug
      ? {
          ...common,
          target: {
            kind,
            runId: Math.floor(runId),
            instanceSlug,
            status: targetStatus,
            outcome: targetOutcome,
          },
        }
      : null;
  }
  return null;
}

function mapRunVisibility(row: RunVisibilityDbRow): ExternalTriggerRunVisibility {
  const args = object(row.args);
  const trigger = object(args.trigger);
  const rawPayload = row.deliveryPayload ?? object(trigger.payload);
  const redactedPayload = object(redactSensitiveValue(rawPayload));
  const outcome = object(row.outcome);
  const blueprintOperation = blueprintOperationOutcome(outcome, row.operationTargetStatus, row.operationTargetOutcome);
  const policy = externalTriggerDisposition(row.status, outcome, row.error);
  const total = Number(row.workItemTotal ?? 0);
  const passed = Number(row.workItemPassed ?? 0);
  const failed = Number(row.workItemFailed ?? 0);
  const planRunId = row.planRunId == null ? null : Number(row.planRunId);
  const planRunFinishedAt = row.planRunFinishedAt == null ? null : Number(row.planRunFinishedAt);
  const planRunLaunchedAt = row.planRunLaunchedAt == null ? null : Number(row.planRunLaunchedAt);
  const planRun =
    planRunId == null || !Number.isFinite(planRunId)
      ? null
      : {
          id: planRunId,
          instancePlanSlug: row.instancePlanSlug,
          status: row.planRunStatus ?? 'unknown',
          launchedBy: row.planRunLaunchedBy,
          workItems: { total, passed, failed, open: Math.max(0, total - passed - failed) },
          agents: Array.isArray(row.agents)
            ? row.agents.filter((agent): agent is string => typeof agent === 'string' && agent.length > 0)
            : [],
          durationMs:
            planRunLaunchedAt == null || planRunFinishedAt == null
              ? null
              : Math.max(0, planRunFinishedAt - planRunLaunchedAt),
          costUsd: Number(row.costUsd ?? 0),
        };
  const receivedAt = iso(row.receivedAt);
  const triggeredAt = iso(row.triggeredAt) as string;
  const startedAt = iso(row.startedAt);
  const completedAt = iso(row.completedAt);
  const planCompletedAt = planRunFinishedAt == null ? null : iso(planRunFinishedAt);
  const operationTarget = blueprintOperation?.target ?? null;
  const operationTerminal =
    operationTarget?.kind === 'work-item'
      ? ['done', 'passed', 'resolved', 'failed', 'dropped', 'deprecated', 'closed'].includes(
          operationTarget.status ?? '',
        )
      : operationTarget?.kind === 'plan'
        ? operationTarget.status === 'done' || operationTarget.status === 'failed'
        : false;
  const operationFailed =
    operationTarget?.kind === 'work-item'
      ? ['failed', 'dropped', 'deprecated', 'closed'].includes(operationTarget.status ?? '')
      : operationTarget?.kind === 'plan'
        ? operationTarget.status === 'failed' ||
          (operationTarget.status === 'done' && operationTarget.outcome !== 'success')
        : false;
  const timeline: ExternalTriggerTimelineStep[] = [
    {
      stage: 'received',
      at: receivedAt,
      status: receivedAt ? 'done' : 'pending',
      detail: receivedAt ? 'Provider event normalized and deduplicated' : 'Provider delivery unavailable',
    },
    {
      stage: 'matched',
      at: triggeredAt,
      status: 'done',
      detail: `${row.eventPattern} matched binding ${row.bindingId}`,
    },
    {
      stage: 'policy',
      at: triggeredAt,
      status: policy.disposition === 'failed' ? 'failed' : policy.disposition === 'dropped' ? 'dropped' : 'done',
      detail: policy.detail,
    },
    {
      stage: 'launched',
      at: planRunLaunchedAt == null ? startedAt : iso(planRunLaunchedAt),
      status: blueprintOperation || planRun ? 'done' : row.status === 'running' ? 'active' : 'pending',
      detail: blueprintOperation
        ? `Blueprint operation ${blueprintOperation.harnessSlug}#${blueprintOperation.operationId} accepted`
        : planRun
          ? `Plan run #${planRun.id} launched`
          : 'Target not launched',
    },
    {
      stage: 'completed',
      at: blueprintOperation ? null : planCompletedAt,
      status: blueprintOperation
        ? operationTerminal
          ? operationFailed
            ? 'failed'
            : 'done'
          : operationTarget?.status
            ? 'active'
            : 'pending'
        : planCompletedAt
          ? planRun?.status === 'failed'
            ? 'failed'
            : 'done'
          : planRun?.status === 'running'
            ? 'active'
            : 'pending',
      detail: blueprintOperation
        ? operationTarget?.kind === 'work-item'
          ? `Work item ${operationTarget.id} · ${operationTarget.status ?? 'status unavailable'}`
          : operationTarget?.kind === 'plan'
            ? `Plan ${operationTarget.instanceSlug} · ${operationTarget.status ?? 'status unavailable'}` +
              (operationTarget.outcome ? ` · ${operationTarget.outcome}` : '')
            : 'Operation target unavailable'
        : planCompletedAt
          ? `Plan run ${planRun?.status ?? 'completed'}`
          : 'Plan run has not completed',
    },
  ];
  return {
    id: row.id,
    bindingId: row.bindingId,
    sourceKind: row.sourceKind,
    eventPattern: row.eventPattern,
    planHarnessSlug: row.planHarnessSlug,
    planSlug: row.planSlug,
    goalId: row.goalId,
    workItemHarnessSlug: row.workItemHarnessSlug,
    workItemKind: row.workItemKind,
    status: row.status,
    attempts: Number(row.attempts),
    dedupeKey: row.dedupeKey,
    triggeredAt,
    startedAt,
    completedAt,
    planRunRef: row.planRunRef,
    error: row.error,
    causeSummary: summarizeExternalTriggerCause(row.sourceKind, row.eventPattern, redactedPayload),
    policyDisposition: policy.disposition,
    policyDetail: policy.detail,
    eventFilter: object(redactSensitiveValue(row.eventFilter)),
    stormPolicy: object(row.stormPolicy),
    redactedPayload,
    action: object(row.action),
    blueprintOperation,
    outcomeLinks: outcomeLinks(outcome, row.sourceConfig),
    timeline,
    planRun,
  };
}

export async function loadExternalTriggerRunVisibilities(
  sql: Db,
  workspaceId: string,
  opts: {
    planHarnessSlug?: string;
    planSlug?: string;
    planRunRef?: string;
    limit?: number;
  } = {},
): Promise<ExternalTriggerRunVisibility[]> {
  const harnessFilter = opts.planHarnessSlug ? sql`AND b.plan_harness_slug = ${opts.planHarnessSlug}` : sql``;
  const planFilter = opts.planSlug ? sql`AND b.plan_slug = ${opts.planSlug}` : sql``;
  const planRunFilter = opts.planRunRef ? sql`AND tr.plan_run_ref = ${opts.planRunRef}` : sql``;
  const limit = Math.min(5_000, Math.max(1, Math.floor(opts.limit ?? 50)));
  const rows = await sql<RunVisibilityDbRow[]>`
    SELECT tr.id::text,
           tr.binding_id::text AS "bindingId",
           s.kind AS "sourceKind",
           s.config AS "sourceConfig",
           b.event_pattern AS "eventPattern",
           b.event_filter AS "eventFilter",
           b.storm_policy AS "stormPolicy",
           b.plan_harness_slug AS "planHarnessSlug",
           b.plan_slug AS "planSlug",
           b.goal_id AS "goalId",
           b.work_item_harness_slug AS "workItemHarnessSlug",
           b.work_item_kind AS "workItemKind",
           tr.status,
           tr.attempts,
           tr.dedupe_key AS "dedupeKey",
           tr.args,
           tr.outcome,
           b.action,
           tr.triggered_at AS "triggeredAt",
           tr.started_at AS "startedAt",
           tr.completed_at AS "completedAt",
           tr.plan_run_ref AS "planRunRef",
           tr.error,
           d.payload AS "deliveryPayload",
           d.received_at AS "receivedAt",
           pr.id AS "planRunId",
           pr.instance_plan_slug AS "instancePlanSlug",
           pr.status AS "planRunStatus",
           pr.launched_by AS "planRunLaunchedBy",
           pr.launched_at AS "planRunLaunchedAt",
           pr.finished_at AS "planRunFinishedAt",
           (SELECT count(*)::int
              FROM harness_shared.harness_features_consolidated w
             WHERE w.workspace_id = tr.workspace_id
               AND w.harness_slug = b.plan_harness_slug
               AND w.payload -> 'plan_run' ->> 'runId' = pr.id::text) AS "workItemTotal",
           (SELECT count(*)::int
              FROM harness_shared.harness_features_consolidated w
             WHERE w.workspace_id = tr.workspace_id
               AND w.harness_slug = b.plan_harness_slug
               AND w.payload -> 'plan_run' ->> 'runId' = pr.id::text
               AND w.status IN ('passed', 'done', 'resolved', 'closed')) AS "workItemPassed",
           (SELECT count(*)::int
              FROM harness_shared.harness_features_consolidated w
             WHERE w.workspace_id = tr.workspace_id
               AND w.harness_slug = b.plan_harness_slug
               AND w.payload -> 'plan_run' ->> 'runId' = pr.id::text
               AND w.status IN ('failed', 'dropped', 'deprecated')) AS "workItemFailed",
           COALESCE((
             SELECT jsonb_agg(agent ORDER BY agent)
               FROM (
                 SELECT DISTINCT w.taken_by AS agent
                   FROM harness_shared.harness_features_consolidated w
                  WHERE w.workspace_id = tr.workspace_id
                    AND w.harness_slug = b.plan_harness_slug
                    AND w.payload -> 'plan_run' ->> 'runId' = pr.id::text
                    AND w.taken_by IS NOT NULL
               ) assigned_agents
           ), '[]'::jsonb) AS agents,
           (SELECT COALESCE(sum(t.cost_usd), 0)
              FROM harness_shared.plan_run_turns t
             WHERE t.workspace_id = tr.workspace_id AND t.plan_run_id = pr.id) AS "costUsd",
           COALESCE(op_wi.status, op_pr.status) AS "operationTargetStatus",
           op_pr.outcome AS "operationTargetOutcome"
      FROM harness_shared.trigger_runs tr
      JOIN harness_shared.trigger_bindings b
        ON b.workspace_id = tr.workspace_id AND b.id = tr.binding_id
      JOIN harness_shared.data_sources s
        ON s.workspace_id = b.workspace_id AND s.id = b.source_id
      LEFT JOIN harness_shared.trigger_deliveries d
        ON d.workspace_id = tr.workspace_id AND d.id = tr.delivery_id
      LEFT JOIN harness_shared.plan_runs pr
        ON pr.workspace_id = tr.workspace_id AND pr.id::text = tr.plan_run_ref
      LEFT JOIN harness_shared.work_items op_wi
        ON tr.outcome #>> '{blueprintOperation,target,kind}' = 'work-item'
       AND op_wi.workspace_id = tr.workspace_id
       AND op_wi.harness_slug = tr.outcome #>> '{blueprintOperation,harnessSlug}'
       AND op_wi.feature_id = tr.outcome #>> '{blueprintOperation,target,id}'
      LEFT JOIN harness_shared.plan_runs op_pr
        ON tr.outcome #>> '{blueprintOperation,target,kind}' = 'plan'
       AND op_pr.workspace_id = tr.workspace_id
       AND op_pr.harness_slug = tr.outcome #>> '{blueprintOperation,harnessSlug}'
       AND op_pr.id = CASE
         WHEN tr.outcome #>> '{blueprintOperation,target,runId}' ~ '^[1-9][0-9]*$'
           THEN (tr.outcome #>> '{blueprintOperation,target,runId}')::bigint
         ELSE NULL
       END
     WHERE tr.workspace_id = ${workspaceId}
       ${harnessFilter}
       ${planFilter}
       ${planRunFilter}
     ORDER BY tr.triggered_at DESC, tr.id DESC
     LIMIT ${limit}`;
  return rows.map(mapRunVisibility);
}

function required(value: string | null | undefined, field: string): string {
  const normalized = value?.trim() ?? '';
  if (!normalized) throw new Error(`external_trigger_${field}_required`);
  return normalized;
}

/**
 * Persist BOTH halves of the policy, always. The stored row previously omitted
 * `maxRuns` whenever the caller left it unset, which is how a live binding came
 * to read `{"windowSeconds":60}` — a window with no cap — in every dump anyone
 * inspected (EI-21500982767775449). `parseStormPolicy` now resolves the cap, so
 * writing it back is what makes the row state its own effective policy instead
 * of depending on a reader applying the same default.
 */
function normalizedStormPolicy(raw: Record<string, unknown> = {}): Record<string, unknown> {
  const parsed = parseStormPolicy(raw);
  return {
    windowSeconds: parsed.windowSeconds,
    maxRuns: parsed.maxRuns,
    maxAgeSeconds: parsed.maxAgeSeconds,
  };
}

/** Create a non-secret source definition. Provider credentials remain opaque references. */
export async function createExternalTriggerSource(
  sql: postgres.Sql,
  workspaceId: string,
  input: CreateExternalTriggerSourceInput,
): Promise<CreatedExternalTriggerSource> {
  const kind = required(input.kind, 'source_kind');
  if (!SOURCE_KIND_RE.test(kind)) throw new Error(`external_trigger_invalid_source_kind:${kind}`);
  const status = input.status?.trim() || 'unconfigured';
  if (!SOURCE_STATUSES.has(status)) throw new Error(`external_trigger_invalid_source_status:${status}`);
  const config = JSON.stringify(input.config ?? {});
  const rows = await sql<
    Array<
      Omit<CreatedExternalTriggerSource, 'createdAt' | 'updatedAt'> & {
        createdAt: Date | string;
        updatedAt: Date | string;
      }
    >
  >`
    INSERT INTO harness_shared.data_sources
      (workspace_id, kind, config, credential_ref, status, created_by)
    VALUES (
      ${required(workspaceId, 'workspace_id')}, ${kind}, ${config}::text::jsonb,
      ${input.credentialRef?.trim() || null}, ${status}, ${input.createdBy?.trim() || null}
    )
    RETURNING id::text,
              kind,
              status,
              config,
              credential_ref AS "credentialRef",
              cursor,
              created_at AS "createdAt",
              updated_at AS "updatedAt"`;
  if (!rows[0]) throw new Error('external_trigger_source_create_failed');
  return {
    ...rows[0],
    createdAt: iso(rows[0].createdAt) as string,
    updatedAt: iso(rows[0].updatedAt) as string,
  };
}

/** Install an external-event binding. Installed bindings always begin disarmed. */
export async function createExternalTriggerBinding(
  sql: Db,
  workspaceId: string,
  input: CreateExternalTriggerBindingInput,
): Promise<CreatedExternalTriggerBinding> {
  const ws = required(workspaceId, 'workspace_id');
  const sourceId = required(input.sourceId, 'source_id');
  const goalId = input.goalId?.trim() || null;
  const workItemHarnessSlug = input.workItemHarnessSlug?.trim() || null;
  const workItemKind = input.workItemKind?.trim() || null;
  const directGiven = Boolean(workItemHarnessSlug || workItemKind);
  const operationHarnessSlug = input.operationHarnessSlug?.trim() || null;
  const operationId = input.operationId?.trim() || null;
  const operationGiven = Boolean(operationHarnessSlug || operationId);
  // Exactly one target (mirrors migration 1016's CHECK, refused here so the
  // caller gets a named error instead of a constraint violation).
  const planGiven = Boolean(input.planSlug?.trim() || input.planHarnessSlug?.trim());
  const targetCount = Number(planGiven) + Number(Boolean(goalId)) + Number(directGiven) + Number(operationGiven);
  if (targetCount > 1) throw new Error('external_trigger_binding_both_targets');
  if (targetCount === 0) throw new Error('external_trigger_binding_no_target');
  if (directGiven && (!workItemHarnessSlug || !workItemKind)) {
    throw new Error('external_trigger_direct_target_incomplete');
  }
  if (operationGiven && (!operationHarnessSlug || !operationId)) {
    throw new Error('external_trigger_blueprint_operation_target_incomplete');
  }
  const planHarnessSlug = goalId || directGiven || operationGiven ? null : required(input.planHarnessSlug, 'plan_harness_slug');
  const planSlug = goalId || directGiven || operationGiven ? null : required(input.planSlug, 'plan_slug');
  const eventPattern = required(input.eventPattern, 'event_pattern');
  const sources = await sql<Array<{ kind: string }>>`
    SELECT kind FROM harness_shared.data_sources
     WHERE workspace_id = ${ws} AND id = ${sourceId}::uuid
     LIMIT 1`;
  if (!sources[0]) throw new Error(`external_trigger_unknown_source:${sourceId}`);
  const expectedPrefix = `ext:${sources[0].kind}:`;
  if (!eventPattern.startsWith(expectedPrefix)) {
    throw new Error(`external_trigger_pattern_source_mismatch:${expectedPrefix}`);
  }
  if (directGiven) {
    if (workItemHarnessSlug !== EMAIL_DRAFT_PROPOSAL_HARNESS || workItemKind !== EMAIL_DRAFT_PROPOSAL_KIND) {
      throw new Error(`external_trigger_unsupported_direct_target:${workItemHarnessSlug}/${workItemKind}`);
    }
    if (sources[0].kind !== 'gmail') {
      throw new Error(`external_trigger_direct_source_mismatch:gmail:${sources[0].kind}`);
    }
    const datatype = await getDatatype(sql, ws, EMAIL_DRAFT_PROPOSAL_KIND);
    if (
      !datatype ||
      datatype.status !== 'active' ||
      datatype.tier !== 'generic-kind' ||
      datatype.workItemKind !== EMAIL_DRAFT_PROPOSAL_KIND
    ) {
      throw new Error(`external_trigger_unknown_work_item_kind:${EMAIL_DRAFT_PROPOSAL_KIND}`);
    }
  } else if (goalId) {
    const goals = await sql<Array<{ exists: boolean }>>`
      SELECT EXISTS (
        SELECT 1 FROM harness_shared.goals
         WHERE workspace_id = ${ws} AND id = ${goalId}
      ) AS exists`;
    if (!goals[0]?.exists) throw new Error(`external_trigger_unknown_goal:${goalId}`);
  } else if (!operationGiven) {
    const plans = await sql<Array<{ exists: boolean }>>`
      SELECT EXISTS (
        SELECT 1 FROM harness_shared.harness_plans
         WHERE workspace_id = ${ws}
           AND harness_slug = ${planHarnessSlug}
           AND plan_slug = ${planSlug}
      ) AS exists`;
    if (!plans[0]?.exists) throw new Error(`external_trigger_unknown_plan:${planHarnessSlug}/${planSlug}`);
  }

  const eventFilter = JSON.stringify(input.eventFilter ?? {});
  const execution = parseAgenticPlanExecutionTarget(input.execution);
  if ((goalId || directGiven || operationGiven) && execution) throw new Error('external_trigger_non_plan_binding_execution_unsupported');
  if (input.planInput !== undefined && (goalId || directGiven || operationGiven)) {
    throw new Error('external_trigger_plan_input_requires_plan_target');
  }
  if (
    input.planInput !== undefined &&
    (input.planInput === null || typeof input.planInput !== 'object' || Array.isArray(input.planInput))
  ) {
    throw new Error('external_trigger_plan_input_invalid');
  }
  const datatypeId = input.datatypeId?.trim() || null;
  if (datatypeId) {
    const datatype = await getDatatype(sql, ws, datatypeId);
    if (!datatype) throw new Error(`external_trigger_unknown_datatype:${datatypeId}`);
  }
  const packInstallationId = input.packInstallationId?.trim() || null;
  const action = JSON.stringify({
    type: operationGiven
      ? 'blueprint-operation'
      : directGiven
        ? 'create-work-item'
        : goalId
          ? 'start-goal'
          : 'launch-plan',
    ...(operationGiven
      ? {
          operationHarnessSlug,
          operationId,
          ...(input.operationInput ? { input: input.operationInput } : {}),
          ...(input.operationMigrationFromBindingId?.trim()
            ? { migrationFromBindingId: input.operationMigrationFromBindingId.trim() }
            : {}),
        }
      : {}),
    ...(planGiven && input.planInput && Object.keys(input.planInput).length > 0 ? { input: input.planInput } : {}),
    ...(execution ? { execution } : {}),
  });
  // A binding with no explicit storm policy is UNBOUNDED under the landed
  // default (parseStormPolicy yields maxRuns:null). That is tolerable for mail,
  // where volume is bounded by how fast humans write, and unsafe for social,
  // where one viral post can produce thousands of genuinely-distinct inbound
  // comments. So a social source falls back to its per-platform coalesce-with-cap
  // default (P-023) instead of to unbounded. An explicit caller-supplied policy
  // still wins, and non-social sources are untouched.
  //
  // A policy that states ONLY the dispatch validity window (maxAgeSeconds,
  // WI-10004920) says nothing about rate, so it must not displace that rate
  // default either: the window is overlaid on the social default instead.
  const stated = input.stormPolicy;
  const statedMaxAge = stated?.maxAgeSeconds ?? stated?.max_age_seconds;
  const statesRate =
    stated !== undefined &&
    Object.keys(stated).some((key) => key !== 'maxAgeSeconds' && key !== 'max_age_seconds');
  const socialDefault = statesRate ? null : defaultSocialStormPolicyForSourceKind(sources[0].kind);
  const stormPolicy = socialDefault
    ? {
        ...socialDefault,
        ...(statedMaxAge === undefined || statedMaxAge === null
          ? {}
          : { maxAgeSeconds: parseStormPolicy({ maxAgeSeconds: statedMaxAge }).maxAgeSeconds }),
      }
    : normalizedStormPolicy(stated);
  const stormPolicyJson = JSON.stringify(stormPolicy);
  const rows = await sql<
    Array<
      Omit<CreatedExternalTriggerBinding, 'sourceKind' | 'createdAt' | 'updatedAt'> & {
        createdAt: Date | string;
        updatedAt: Date | string;
      }
    >
  >`
    INSERT INTO harness_shared.trigger_bindings
      (workspace_id, source_id, plan_harness_slug, plan_slug, goal_id,
       work_item_harness_slug, work_item_kind, event_pattern, event_filter,
       action, armed, storm_policy, created_by, datatype_id, pack_installation_id)
    VALUES (
      ${ws}, ${sourceId}::uuid, ${planHarnessSlug}, ${planSlug}, ${goalId},
      ${workItemHarnessSlug}, ${workItemKind}, ${eventPattern},
      ${eventFilter}::text::jsonb, ${action}::text::jsonb, FALSE,
      ${stormPolicyJson}::text::jsonb, ${input.createdBy?.trim() || null},
      ${datatypeId}, ${packInstallationId}::uuid
    )
    RETURNING id::text,
              source_id::text AS "sourceId",
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
              created_by AS "createdBy",
              created_at AS "createdAt",
              updated_at AS "updatedAt"`;
  if (!rows[0]) throw new Error('external_trigger_binding_create_failed');
  return {
    ...rows[0],
    sourceKind: sources[0].kind,
    createdAt: iso(rows[0].createdAt) as string,
    updatedAt: iso(rows[0].updatedAt) as string,
  };
}

export interface ExternalTriggerOperationMigration {
  legacyBindingId: string;
  replacement: CreatedExternalTriggerBinding;
  replayed: boolean;
  parity: {
    sourceId: string;
    eventPattern: string;
    eventFilter: Record<string, unknown>;
    stormPolicy: Record<string, unknown>;
    legacyArmed: boolean;
    replacementArmed: false;
    legacyTarget: { harnessSlug: string; planSlug: string };
    operationTarget: { harnessSlug: string; operationId: string };
    legacyExecution: AgenticPlanExecutionTarget | null;
  };
}

interface MigrationBindingDbRow {
  id: string;
  sourceId: string;
  sourceKind: string;
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
  createdBy: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

async function migrationBindingRow(
  sql: Db,
  workspaceId: string,
  where: { id?: string; migrationFromBindingId?: string },
): Promise<MigrationBindingDbRow | null> {
  const idFilter = where.id ? sql`AND b.id = ${where.id}::uuid` : sql``;
  const migrationFilter = where.migrationFromBindingId
    ? sql`AND b.action->>'migrationFromBindingId' = ${where.migrationFromBindingId}`
    : sql``;
  const rows = await sql<MigrationBindingDbRow[]>`
    SELECT b.id::text,
           b.source_id::text AS "sourceId",
           s.kind AS "sourceKind",
           b.plan_harness_slug AS "planHarnessSlug",
           b.plan_slug AS "planSlug",
           b.goal_id AS "goalId",
           b.work_item_harness_slug AS "workItemHarnessSlug",
           b.work_item_kind AS "workItemKind",
           b.event_pattern AS "eventPattern",
           b.event_filter AS "eventFilter",
           b.action,
           b.armed,
           b.storm_policy AS "stormPolicy",
           b.created_by AS "createdBy",
           b.created_at AS "createdAt",
           b.updated_at AS "updatedAt"
      FROM harness_shared.trigger_bindings b
      JOIN harness_shared.data_sources s
        ON s.workspace_id = b.workspace_id AND s.id = b.source_id
     WHERE b.workspace_id = ${workspaceId}
       AND b.detached_at IS NULL
       ${idFilter}
       ${migrationFilter}
     ORDER BY b.created_at, b.id
     LIMIT 2`;
  if (rows.length > 1) throw new Error('external_trigger_binding_migration_ambiguous');
  return rows[0] ?? null;
}

function createdBindingFromMigrationRow(row: MigrationBindingDbRow): CreatedExternalTriggerBinding {
  return {
    ...row,
    createdAt: iso(row.createdAt) as string,
    updatedAt: iso(row.updatedAt) as string,
  };
}

/**
 * Install (or replay) a DISARMED blueprint-operation replacement for one
 * legacy launch-plan binding. Source/filter/storm policy are copied under one
 * advisory lock; the legacy row is unchanged. Prove the replacement with
 * run-with-last-event, then switch arming through the existing explicit controls.
 */
export async function migrateExternalTriggerPlanBindingToOperation(
  sql: postgres.Sql,
  workspaceId: string,
  input: {
    bindingId: string;
    operationHarnessSlug: string;
    operationId: string;
    operationInput?: Record<string, unknown>;
    createdBy?: string | null;
  },
): Promise<ExternalTriggerOperationMigration> {
  const ws = required(workspaceId, 'workspace_id');
  const bindingId = required(input.bindingId, 'binding_id');
  const operationHarnessSlug = required(input.operationHarnessSlug, 'operation_harness_slug');
  const operationId = required(input.operationId, 'operation_id');
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`external-trigger-operation-migration:${ws}:${bindingId}`}, 0))`;
    const legacy = await migrationBindingRow(tx, ws, { id: bindingId });
    if (!legacy) throw new Error(`external_trigger_binding_not_found:${bindingId}`);
    const legacyActionType = text(legacy.action.type) || 'launch-plan';
    if (legacyActionType !== 'launch-plan' || !legacy.planHarnessSlug || !legacy.planSlug) {
      throw new Error('external_trigger_binding_migration_requires_legacy_plan_target');
    }
    const existing = await migrationBindingRow(tx, ws, { migrationFromBindingId: bindingId });
    let replacement: CreatedExternalTriggerBinding;
    let replayed = false;
    if (existing) {
      if (
        existing.action.type !== 'blueprint-operation' ||
        existing.action.operationHarnessSlug !== operationHarnessSlug ||
        existing.action.operationId !== operationId ||
        !isDeepStrictEqual(object(existing.action.input), input.operationInput ?? {})
      ) {
        throw new Error('external_trigger_binding_migration_target_conflict');
      }
      replacement = createdBindingFromMigrationRow(existing);
      replayed = true;
    } else {
      replacement = await createExternalTriggerBinding(tx, ws, {
        sourceId: legacy.sourceId,
        operationHarnessSlug,
        operationId,
        operationInput: input.operationInput,
        operationMigrationFromBindingId: bindingId,
        eventPattern: legacy.eventPattern,
        eventFilter: legacy.eventFilter,
        stormPolicy: legacy.stormPolicy,
        createdBy: input.createdBy,
      });
    }
    if (
      replacement.armed ||
      replacement.sourceId !== legacy.sourceId ||
      replacement.eventPattern !== legacy.eventPattern ||
      !isDeepStrictEqual(replacement.eventFilter, legacy.eventFilter) ||
      // Parity is about the EFFECTIVE policy, not the stored bytes: a new binding is
      // written fully normalized (every bounded default stated, incl. maxAgeSeconds —
      // WI-10004920), while a legacy row may still carry the older, shorter shape.
      !isDeepStrictEqual(
        normalizedStormPolicy(replacement.stormPolicy),
        normalizedStormPolicy(legacy.stormPolicy),
      )
    ) {
      throw new Error('external_trigger_binding_migration_parity_failed');
    }
    return {
      legacyBindingId: bindingId,
      replacement,
      replayed,
      parity: {
        sourceId: legacy.sourceId,
        eventPattern: legacy.eventPattern,
        eventFilter: legacy.eventFilter,
        stormPolicy: legacy.stormPolicy,
        legacyArmed: legacy.armed,
        replacementArmed: false,
        legacyTarget: { harnessSlug: legacy.planHarnessSlug, planSlug: legacy.planSlug },
        operationTarget: { harnessSlug: operationHarnessSlug, operationId },
        legacyExecution: parseAgenticPlanExecutionTarget(legacy.action.execution),
      },
    };
  });
}

/**
 * Idempotently install one semantic source→plan binding.
 *
 * `trigger_bindings` intentionally permits multiple bindings between the same
 * source and plan because users may author distinct filters. Connection-time
 * provisioning needs a narrower guarantee: reconnecting (or two concurrent
 * OAuth callbacks) must not multiply the one built-in Calendar binding. A
 * transaction-scoped advisory lock serializes that exact semantic key, then an
 * equality read reuses the installed row. The binding remains disarmed; arming
 * is still an explicit, separately-governed operation.
 */
export async function ensureExternalTriggerBinding(
  sql: postgres.Sql,
  workspaceId: string,
  input: CreateExternalTriggerBindingInput,
): Promise<CreatedExternalTriggerBinding> {
  const ws = required(workspaceId, 'workspace_id');
  const sourceId = required(input.sourceId, 'source_id');
  // Plan-only by design: this door serves connection-time provisioning of the
  // built-in plan bindings. A goal binding has no such provisioning caller —
  // use createExternalTriggerBinding directly (P-020).
  if (input.goalId?.trim()) throw new Error('external_trigger_goal_binding_ensure_unsupported');
  const planHarnessSlug = required(input.planHarnessSlug, 'plan_harness_slug');
  const planSlug = required(input.planSlug, 'plan_slug');
  const eventPattern = required(input.eventPattern, 'event_pattern');
  const eventFilter = JSON.stringify(input.eventFilter ?? {});
  const execution = parseAgenticPlanExecutionTarget(input.execution);
  const action = JSON.stringify({ type: 'launch-plan', ...(execution ? { execution } : {}) });
  const lockKey = ['external-trigger-binding', ws, sourceId, planHarnessSlug, planSlug, eventPattern].join(':');

  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
    const rows = await tx<
      Array<
        Omit<CreatedExternalTriggerBinding, 'createdAt' | 'updatedAt'> & {
          createdAt: Date | string;
          updatedAt: Date | string;
        }
      >
    >`
      SELECT b.id::text,
             b.source_id::text AS "sourceId",
             s.kind AS "sourceKind",
             b.plan_harness_slug AS "planHarnessSlug",
             b.plan_slug AS "planSlug",
             b.goal_id AS "goalId",
             b.work_item_harness_slug AS "workItemHarnessSlug",
             b.work_item_kind AS "workItemKind",
             b.event_pattern AS "eventPattern",
             b.event_filter AS "eventFilter",
             b.action,
             b.armed,
             b.storm_policy AS "stormPolicy",
             b.created_by AS "createdBy",
             b.created_at AS "createdAt",
             b.updated_at AS "updatedAt"
        FROM harness_shared.trigger_bindings b
        JOIN harness_shared.data_sources s
          ON s.workspace_id = b.workspace_id AND s.id = b.source_id
       WHERE b.workspace_id = ${ws}
         AND b.source_id = ${sourceId}::uuid
         AND b.plan_harness_slug = ${planHarnessSlug}
         AND b.plan_slug = ${planSlug}
         AND b.event_pattern = ${eventPattern}
         AND b.event_filter = ${eventFilter}::text::jsonb
         AND b.detached_at IS NULL
       ORDER BY b.created_at, b.id
       LIMIT 1`;
    if (rows[0]) {
      const updated = await tx<
        Array<
          Omit<CreatedExternalTriggerBinding, 'createdAt' | 'updatedAt'> & {
            createdAt: Date | string;
            updatedAt: Date | string;
          }
        >
      >`
        UPDATE harness_shared.trigger_bindings b
           SET action = ${action}::text::jsonb, updated_at = now()
         WHERE b.workspace_id = ${ws} AND b.id = ${rows[0].id}::uuid
           AND b.action IS DISTINCT FROM ${action}::text::jsonb
        RETURNING b.id::text,
                  b.source_id::text AS "sourceId",
                  (SELECT kind FROM harness_shared.data_sources s
                    WHERE s.workspace_id = ${ws} AND s.id = b.source_id) AS "sourceKind",
                  b.plan_harness_slug AS "planHarnessSlug",
                  b.plan_slug AS "planSlug",
                  b.goal_id AS "goalId",
                  b.work_item_harness_slug AS "workItemHarnessSlug",
                  b.work_item_kind AS "workItemKind",
                  b.event_pattern AS "eventPattern",
                  b.event_filter AS "eventFilter",
                  b.action,
                  b.armed,
                  b.storm_policy AS "stormPolicy",
                  b.created_by AS "createdBy",
                  b.created_at AS "createdAt",
                  b.updated_at AS "updatedAt"`;
      const row = updated[0] ?? rows[0];
      return {
        ...row,
        createdAt: iso(row.createdAt) as string,
        updatedAt: iso(row.updatedAt) as string,
      };
    }
    return createExternalTriggerBinding(tx, ws, input);
  });
}

export function disabledExternalTriggerAdminSnapshot(): ExternalTriggerAdminSnapshot {
  return {
    enabled: false,
    counts: { sources: 0, bindings: 0, armed: 0, recentFailures: 0 },
    sources: [],
    bindings: [],
    recentRuns: [],
  };
}

/**
 * Derive a social source's platform facts, or null for a non-social kind.
 *
 * Exported for direct testing: the pane's correctness rests on this returning
 * null for every kind the registry does not know, so that a gmail or slack
 * source can never pick up a social platform's rate budget by accident.
 */
export function socialAdminFacts(kind: string, cursor: unknown, nowMs: number): ExternalTriggerSocialAdminFacts | null {
  const row = getSocialPlatform(kind);
  if (!row) return null;
  // `read` for the cap: the poll loop is what spends budget continuously, and
  // it is the spend an owner watching this pane is deciding about.
  const policy = socialStormPolicyFor(row, 'read');
  return {
    platformId: row.id,
    label: row.label,
    wave: row.wave,
    verified: isSocialPlatformVerified(row),
    blockedOn: row.blockedOn ?? null,
    authMode: row.auth.mode,
    readTransport: row.read?.transport ?? null,
    // A write-only platform has no cursor to classify, and letting it fall
    // through would render `never-synced` — permanently true, permanently
    // alarming, and not actionable by anyone. See the `not-readable` note in
    // cursor-freshness.ts: only a caller holding the row can tell these apart.
    cursor:
      row.read === null
        ? {
            state: 'not-readable' as const,
            at: null,
            ageMs: null,
            position: null,
            detail:
              'this platform has no readable content stream at any grant tier we hold — it is write-only, so there is nothing to sync',
          }
        : socialCursorFreshness(cursor, nowMs),
    rateBudget: {
      maxRuns: policy.maxRuns,
      windowSeconds: policy.windowSeconds,
      basis: policy.basis.kind,
      hold: policy.hold
        ? {
            reason: policy.hold.reason,
            retryForbidden: policy.hold.retryForbidden,
            untilMs: policy.hold.untilMs,
          }
        : null,
    },
    writeVerified: typeof row.write.verifiedAt === 'string' && row.write.verifiedAt.length > 0,
    writeVerbs: [...row.write.verbs],
  };
}

/** Read the one workspace-scoped snapshot rendered by /admin/triggers. */
export async function loadExternalTriggerAdminSnapshot(
  sql: postgres.Sql,
  workspaceId: string,
): Promise<ExternalTriggerAdminSnapshot> {
  const [sourceRows, bindingRows, recentRuns, failureRows] = await Promise.all([
    sql<SourceDbRow[]>`
      SELECT s.id::text,
             s.kind,
             s.status,
             s.config,
             s.credential_ref AS "credentialRef",
             s.cursor,
             s.last_connected_at AS "lastConnectedAt",
             s.last_error AS "lastError",
             count(DISTINCT b.id)::int AS "bindingCount",
             count(DISTINCT b.id) FILTER (WHERE b.armed)::int AS "armedBindingCount",
             count(DISTINCT d.id) FILTER (
               WHERE d.outcome = 'failed'
                 AND d.received_at >= now() - interval '24 hours'
             )::int AS "failedDeliveries24h"
        FROM harness_shared.data_sources s
        LEFT JOIN harness_shared.trigger_bindings b
          ON b.workspace_id = s.workspace_id
         AND b.source_id = s.id
         AND b.detached_at IS NULL
        LEFT JOIN harness_shared.trigger_deliveries d
          ON d.workspace_id = s.workspace_id AND d.source_id = s.id
       WHERE s.workspace_id = ${workspaceId}
       GROUP BY s.workspace_id, s.id
       ORDER BY s.kind, s.created_at, s.id`,
    sql<BindingDbRow[]>`
      SELECT b.id::text,
             b.source_id::text AS "sourceId",
             s.kind AS "sourceKind",
             s.status AS "sourceStatus",
             b.plan_harness_slug AS "planHarnessSlug",
             b.plan_slug AS "planSlug",
             b.work_item_harness_slug AS "workItemHarnessSlug",
             b.work_item_kind AS "workItemKind",
             b.event_pattern AS "eventPattern",
             b.event_filter AS "eventFilter",
             b.action,
             b.armed,
             b.storm_policy AS "stormPolicy",
             b.created_by AS "createdBy",
             b.created_at AS "createdAt",
             b.updated_at AS "updatedAt",
             lr.id::text AS "lastRunId",
             lr.status AS "lastRunStatus",
             lr.triggered_at AS "lastRunTriggeredAt",
             lr.completed_at AS "lastRunCompletedAt",
             lr.error AS "lastRunError",
             pi.id::text AS "packInstallationId",
             pi.plugin_name AS "packPluginName",
             (pi.reviewed_fingerprint IS NOT NULL) AS "packReviewed"
        FROM harness_shared.trigger_bindings b
        JOIN harness_shared.data_sources s
          ON s.workspace_id = b.workspace_id AND s.id = b.source_id
        LEFT JOIN harness_shared.trigger_pack_installations pi
          ON pi.workspace_id = b.workspace_id AND pi.id = b.pack_installation_id
        LEFT JOIN LATERAL (
          SELECT tr.id, tr.status, tr.triggered_at, tr.completed_at, tr.error
            FROM harness_shared.trigger_runs tr
           WHERE tr.workspace_id = b.workspace_id AND tr.binding_id = b.id
           ORDER BY tr.triggered_at DESC, tr.id DESC
           LIMIT 1
        ) lr ON TRUE
       WHERE b.workspace_id = ${workspaceId}
         AND b.detached_at IS NULL
       ORDER BY b.created_at, b.id`,
    loadExternalTriggerRunVisibilities(sql, workspaceId, { limit: 50 }),
    sql<Array<{ count: number }>>`
      SELECT (
        (SELECT count(*)::int
           FROM harness_shared.trigger_deliveries
          WHERE workspace_id = ${workspaceId}
            AND outcome = 'failed'
            AND received_at >= now() - interval '24 hours')
        +
        (SELECT count(*)::int
           FROM harness_shared.trigger_runs
          WHERE workspace_id = ${workspaceId}
            AND status = 'failed'
            AND triggered_at >= now() - interval '24 hours')
      )::int AS count`,
  ]);

  const nowMs = Date.now();
  const sources = sourceRows.map((row) => ({
    ...row,
    lastConnectedAt: iso(row.lastConnectedAt),
    social: socialAdminFacts(row.kind, row.cursor, nowMs),
  }));
  const bindings = bindingRows.map(
    (row): ExternalTriggerBindingAdminRow => ({
      id: row.id,
      sourceId: row.sourceId,
      sourceKind: row.sourceKind,
      sourceStatus: row.sourceStatus,
      planHarnessSlug: row.planHarnessSlug,
      planSlug: row.planSlug,
      goalId: row.goalId,
      workItemHarnessSlug: row.workItemHarnessSlug,
      workItemKind: row.workItemKind,
      eventPattern: row.eventPattern,
      eventFilter: row.eventFilter,
      action: row.action,
      armed: row.armed,
      stormPolicy: row.stormPolicy,
      createdBy: row.createdBy,
      createdAt: iso(row.createdAt) as string,
      updatedAt: iso(row.updatedAt) as string,
      lastRun:
        row.lastRunId && row.lastRunStatus && row.lastRunTriggeredAt
          ? {
              id: row.lastRunId,
              status: row.lastRunStatus,
              triggeredAt: iso(row.lastRunTriggeredAt) as string,
              completedAt: iso(row.lastRunCompletedAt),
              error: row.lastRunError,
            }
          : null,
      pack:
        row.packInstallationId && row.packPluginName
          ? { installationId: row.packInstallationId, pluginName: row.packPluginName, reviewed: row.packReviewed === true }
          : null,
    }),
  );
  return {
    enabled: true,
    counts: {
      sources: sources.length,
      bindings: bindings.length,
      armed: bindings.filter((binding) => binding.armed).length,
      recentFailures: failureRows[0]?.count ?? 0,
    },
    sources,
    bindings,
    recentRuns,
  };
}

/** Read the schedule/manual half of one plan's unified trigger model. */
export async function loadExternalTriggerPlanAdminSnapshot(
  sql: postgres.Sql,
  workspaceId: string,
  harnessSlug: string,
  planSlug: string,
): Promise<ExternalTriggerPlanAdminSnapshot | null> {
  const ws = required(workspaceId, 'workspace_id');
  const harness = required(harnessSlug, 'plan_harness_slug');
  const plan = required(planSlug, 'plan_slug');
  const [planRows, routineRows] = await Promise.all([
    sql<PlanTriggerDbRow[]>`
      SELECT harness_slug AS "harnessSlug",
             plan_slug AS "planSlug",
             schedule,
             schedule_active AS "scheduleActive",
             scheduled_at AS "scheduledAt",
             expires_at AS "expiresAt",
             tzid,
             template,
             (input_schema IS NOT NULL) AS "hasInputSchema"
        FROM harness_shared.harness_plans
       WHERE workspace_id = ${ws}
         AND harness_slug = ${harness}
         AND plan_slug = ${plan}
       LIMIT 1`,
    sql<RoutineFireDbRow[]>`
      SELECT last_fired_at AS "lastFire", next_fire_at AS "nextFire"
        FROM harness_shared.routines
       WHERE workspace_id = ${ws}
         AND install_slug = ${harness}
         AND name = ${planScheduleRoutineName(plan)}
       LIMIT 1`,
  ]);
  const row = planRows[0];
  if (!row) return null;
  const routine = routineRows[0];
  return {
    harnessSlug: row.harnessSlug,
    planSlug: row.planSlug,
    schedule: row.schedule,
    scheduleActive: row.scheduleActive,
    scheduledAt: iso(row.scheduledAt),
    expiresAt: iso(row.expiresAt),
    tzid: row.tzid,
    lastFire: iso(routine?.lastFire ?? null),
    nextFire: iso(routine?.nextFire ?? null),
    manualSource: row.hasInputSchema ? 'input-schema' : row.template ? 'template' : null,
  };
}

/**
 * Queue a distinct test execution from the latest settled provider event that
 * reached one binding.
 *
 * This deliberately does NOT re-ingest the provider event: doing that would
 * either be swallowed by delivery dedupe or, worse, require weakening the
 * provider replay invariant. Instead the new trigger-run references the same
 * canonical delivery and copies the already-validated `args.trigger` envelope.
 * Its own test-scoped dedupe key makes repeated, explicitly confirmed tests
 * distinct while the original provider dedupe key remains inside the copied
 * trigger payload for correlation and anchored response handling.
 */
export async function queueExternalTriggerLastEventTestRun(
  sql: postgres.Sql,
  workspaceId: string,
  input: { bindingId: string; requestedBy: string },
): Promise<QueueExternalTriggerLastEventTestResult> {
  const ws = required(workspaceId, 'workspace_id');
  const bindingId = required(input.bindingId, 'binding_id');
  const requestedBy = required(input.requestedBy, 'requested_by');
  return sql.begin(async (tx) => {
    const bindings = await tx<
      Array<{
        id: string;
        planHarnessSlug: string | null;
        planSlug: string | null;
        workItemHarnessSlug: string | null;
        workItemKind: string | null;
        sourceId: string;
        eventPattern: string;
        eventFilter: Record<string, unknown> | null;
        action: Record<string, unknown>;
      }>
    >`
      SELECT id::text,
             plan_harness_slug AS "planHarnessSlug",
             plan_slug AS "planSlug",
             work_item_harness_slug AS "workItemHarnessSlug",
             work_item_kind AS "workItemKind",
             source_id::text AS "sourceId",
             event_pattern AS "eventPattern",
             event_filter AS "eventFilter",
             action
        FROM harness_shared.trigger_bindings
       WHERE workspace_id = ${ws}
         AND id = ${bindingId}::uuid
         AND detached_at IS NULL
       FOR SHARE`;
    const binding = bindings[0];
    if (!binding) {
      return {
        ok: false,
        error: 'binding_not_found',
        bindingId,
        detail: 'The external-trigger binding does not exist in this workspace or was detached.',
      };
    }
    const action = typeof binding.action.type === 'string' ? binding.action.type.trim() : 'launch-plan';
    // Both canonical dispatch shapes are replayable: `launch-plan` mints a plan
    // run, and `create-work-item` (P-018/D-014) mints one bounded direct work
    // item. `dispatchPendingTriggerRuns` already handles both, so refusing the
    // direct shape here left Email's canonical ingress with no audited test
    // route at all.
    const isPlanBinding = action === 'launch-plan' && !!binding.planHarnessSlug && !!binding.planSlug;
    const isDirectWorkItemBinding =
      action === 'create-work-item' && !!binding.workItemHarnessSlug && !!binding.workItemKind;
    if (!isPlanBinding && !isDirectWorkItemBinding) {
      return {
        ok: false,
        error: 'unsupported_binding_action',
        bindingId,
        detail:
          `Run with last event supports launch-plan and create-work-item bindings with a complete target; ` +
          `this binding declares action '${action}' with no complete plan or work-item target.`,
      };
    }

    const sourceRuns = await tx<
      Array<{
        id: string;
        deliveryId: string;
        providerDedupeKey: string;
        args: Record<string, unknown>;
      }>
    >`
      SELECT tr.id::text,
             tr.delivery_id::text AS "deliveryId",
             tr.dedupe_key AS "providerDedupeKey",
             tr.args
        FROM harness_shared.trigger_runs tr
        JOIN harness_shared.trigger_deliveries d
          ON d.workspace_id = tr.workspace_id AND d.id = tr.delivery_id
       WHERE tr.workspace_id = ${ws}
         AND tr.binding_id = ${bindingId}::uuid
         AND tr.status IN ('succeeded', 'failed', 'skipped')
         AND d.sink_kind = 'event-bus'
         AND d.sink_ref = 'workspace'
         AND d.outcome = 'delivered'
         AND jsonb_typeof(tr.args -> 'trigger') = 'object'
         AND NOT (tr.outcome ? 'runWithLastEvent')
       ORDER BY d.received_at DESC, tr.triggered_at DESC, tr.id DESC
       LIMIT 1
       FOR SHARE OF tr, d`;

    let resolved: {
      triggerRunId: string | null;
      deliveryId: string;
      providerDedupeKey: string;
      args: Record<string, unknown>;
      eventSource: 'binding-run' | 'source-delivery';
    } | null = sourceRuns[0]
      ? {
          triggerRunId: sourceRuns[0].id,
          deliveryId: sourceRuns[0].deliveryId,
          providerDedupeKey: sourceRuns[0].providerDedupeKey,
          args: sourceRuns[0].args,
          eventSource: 'binding-run',
        }
      : null;

    if (!resolved) {
      // A binding that has never fired has no trigger_runs of its own, so the
      // binding-scoped lookup above cannot bootstrap it — which made the
      // binding you most need to prove (a freshly installed replacement, still
      // disarmed) the one binding that could never be tested. Fall back to the
      // newest delivered event on this binding's SOURCE that its own pattern
      // and filter accept, and rebuild the canonical `args.trigger` envelope
      // from that delivery. Matching is done with the same two predicates the
      // live enqueue path uses, so a replay can never reach a binding that the
      // real event would not have reached.
      const deliveries = await tx<
        Array<{
          id: string;
          dedupeKey: string;
          datatypeId: string | null;
          eventKey: string;
          payload: Record<string, unknown> | null;
          sourceId: string;
          sourceKind: string;
        }>
      >`
        SELECT d.id::text,
               d.dedupe_key AS "dedupeKey",
               d.datatype_id AS "datatypeId",
               d.event_key AS "eventKey",
               d.payload,
               d.source_id::text AS "sourceId",
               s.kind AS "sourceKind"
          FROM harness_shared.trigger_deliveries d
          JOIN harness_shared.data_sources s
            ON s.workspace_id = d.workspace_id AND s.id = d.source_id
         WHERE d.workspace_id = ${ws}
           AND d.source_id = ${binding.sourceId}::uuid
           AND d.sink_kind = 'event-bus'
           AND d.sink_ref = 'workspace'
           AND d.outcome = 'delivered'
         ORDER BY d.received_at DESC, d.id DESC
         LIMIT 200
         FOR SHARE OF d`;
      const match = deliveries.find(
        (row) =>
          keyMatchesPattern(binding.eventPattern, row.eventKey)
          && payloadMatchesFilter(binding.eventFilter, row.payload ?? {}),
      );
      if (match) {
        const payload = (match.payload ?? {}) as Record<string, unknown>;
        const prefix = `ext:${match.sourceKind}:`;
        const eventName = match.eventKey.startsWith(prefix)
          ? match.eventKey.slice(prefix.length)
          : match.eventKey.split(':').slice(2).join(':');
        resolved = {
          triggerRunId: null,
          deliveryId: match.id,
          providerDedupeKey: match.dedupeKey,
          args: {
            trigger: {
              key: match.eventKey,
              source: match.sourceKind,
              event: eventName,
              sourceId: match.sourceId,
              externalId: typeof payload.id === 'string' ? payload.id : null,
              occurredAt: typeof payload.occurredAt === 'string' ? payload.occurredAt : null,
              datatypeId: match.datatypeId,
              dedupeKey: match.dedupeKey,
              payload,
            },
          },
          eventSource: 'source-delivery',
        };
      }
    }

    if (!resolved) {
      return {
        ok: false,
        error: 'no_last_event',
        bindingId,
        detail:
          'No settled provider event is available for this binding yet: it has no settled run of its own, '
          + "and no delivered event on its source matches this binding's event pattern and filter.",
      };
    }
    const source = resolved;

    const runId = randomUUID();
    const requestedAt = new Date().toISOString();
    // The dedupe key stays test-scoped and unique per replay. When the envelope
    // was rebuilt from a source delivery there is no originating trigger-run to
    // name, so anchor it on that delivery instead — never on a fixed literal,
    // which would collide across replays of different events.
    const testDedupeKey = `test:${source.triggerRunId ?? `delivery:${source.deliveryId}`}:${runId}`;
    const audit = {
      runWithLastEvent: {
        sourceTriggerRunId: source.triggerRunId,
        sourceDeliveryId: source.deliveryId,
        providerDedupeKey: source.providerDedupeKey,
        eventSource: source.eventSource,
        requestedBy,
        requestedAt,
      },
    };
    const inserted = await tx<Array<{ id: string; triggeredAt: Date | string }>>`
      INSERT INTO harness_shared.trigger_runs
        (workspace_id, id, binding_id, delivery_id, dedupe_key, status, args, outcome, updated_at)
      VALUES (
        ${ws}, ${runId}::uuid, ${bindingId}::uuid, ${source.deliveryId}::uuid,
        ${testDedupeKey}, 'pending', ${JSON.stringify(source.args)}::text::jsonb,
        ${JSON.stringify(audit)}::text::jsonb, now()
      )
      RETURNING id::text, triggered_at AS "triggeredAt"`;
    if (!inserted[0]) throw new Error('external_trigger_last_event_test_insert_failed');
    return {
      ok: true,
      run: {
        id: inserted[0].id,
        bindingId,
        sourceTriggerRunId: source.triggerRunId,
        sourceDeliveryId: source.deliveryId,
        providerDedupeKey: source.providerDedupeKey,
        eventSource: source.eventSource,
        status: 'pending',
        triggeredAt: iso(inserted[0].triggeredAt) as string,
        requestedBy,
        providerWritePossible: true,
      },
    };
  });
}

/**
 * Arming a binding a trigger pack owns needs the pack's review (P-013, D-016 §3).
 * `code` is stable for callers to map: the agent tool returns it, the admin route
 * answers 409 with the installation so the Workflows tab can open the pack review.
 */
export class TriggerPackReviewRequiredError extends Error {
  readonly code = 'trigger_pack_review_required';
  constructor(
    readonly bindingId: string,
    readonly installationId: string,
    readonly pluginName: string,
  ) {
    super(
      `binding ${bindingId} belongs to trigger pack ${pluginName}, which has no current review; ` +
        'review the pack and arm it with trigger-packs:arm',
    );
    this.name = 'TriggerPackReviewRequiredError';
  }
}

/**
 * The single arm chokepoint (triggers:arm, triggers:disarm, the Workflows toggle).
 * Disarming is always allowed. Arming a pack-owned binding requires its
 * installation to carry a review; the check sits inside the UPDATE itself, so a
 * concurrent return-to-review (which clears the review before disarming) cannot
 * be raced past.
 */
export async function setExternalTriggerBindingArmed(
  sql: postgres.Sql,
  workspaceId: string,
  id: string,
  armed: boolean,
): Promise<{ id: string; armed: boolean; updatedAt: string } | null> {
  const rows = await sql<Array<{ id: string; armed: boolean; updatedAt: Date | string }>>`
    UPDATE harness_shared.trigger_bindings b
       SET armed = ${armed}, updated_at = now()
     WHERE b.workspace_id = ${workspaceId} AND b.id = ${id}::uuid
       AND b.detached_at IS NULL
       AND (
         ${armed}::boolean = FALSE
         OR b.pack_installation_id IS NULL
         OR EXISTS (
           SELECT 1 FROM harness_shared.trigger_pack_installations i
            WHERE i.workspace_id = b.workspace_id
              AND i.id = b.pack_installation_id
              AND i.reviewed_fingerprint IS NOT NULL
         )
       )
     RETURNING b.id::text, b.armed, b.updated_at AS "updatedAt"`;
  if (!rows[0]) {
    if (armed) {
      const [pack] = await sql<Array<{ installationId: string; pluginName: string }>>`
        SELECT i.id::text AS "installationId", i.plugin_name AS "pluginName"
          FROM harness_shared.trigger_bindings b
          JOIN harness_shared.trigger_pack_installations i
            ON i.workspace_id = b.workspace_id AND i.id = b.pack_installation_id
         WHERE b.workspace_id = ${workspaceId} AND b.id = ${id}::uuid
           AND b.detached_at IS NULL
           AND i.reviewed_fingerprint IS NULL`;
      if (pack) throw new TriggerPackReviewRequiredError(id, pack.installationId, pack.pluginName);
    }
    return null;
  }
  return { ...rows[0], updatedAt: iso(rows[0].updatedAt) as string };
}

/**
 * Soft-detach a binding: stop execution immediately while preserving every run
 * that references the binding. Repeating the detach is an idempotent miss.
 */
export async function detachExternalTriggerBinding(
  sql: postgres.Sql,
  workspaceId: string,
  id: string,
): Promise<{ id: string; detachedAt: string; updatedAt: string } | null> {
  return sql.begin(async (tx) => {
    const rows = await tx<Array<{ id: string; detachedAt: Date | string; updatedAt: Date | string }>>`
      UPDATE harness_shared.trigger_bindings
         SET armed = FALSE,
             detached_at = now(),
             updated_at = now()
       WHERE workspace_id = ${workspaceId}
         AND id = ${id}::uuid
         AND detached_at IS NULL
       RETURNING id::text,
                 detached_at AS "detachedAt",
                 updated_at AS "updatedAt"`;
    if (!rows[0]) return null;
    // A detached binding must not leave queued work that can still launch later.
    // Running attempts are allowed to settle; only not-yet-started rows cancel.
    await tx`
      UPDATE harness_shared.trigger_runs
         SET status = 'cancelled',
             completed_at = now(),
             updated_at = now(),
             error = COALESCE(error, 'binding detached before dispatch')
       WHERE workspace_id = ${workspaceId}
         AND binding_id = ${id}::uuid
         AND status = 'pending'`;
    return {
      id: rows[0].id,
      detachedAt: iso(rows[0].detachedAt) as string,
      updatedAt: iso(rows[0].updatedAt) as string,
    };
  });
}

export async function updateExternalTriggerBindingStormPolicy(
  sql: postgres.Sql,
  workspaceId: string,
  id: string,
  // `maxRuns: null` stays ACCEPTED at the boundary (the admin route's schema
  // still nulls it) but no longer MEANS unbounded — parseStormPolicy resolves
  // it to the bounded default, and the row is written with that cap.
  input: { maxRuns: number | null; windowSeconds: number; maxAgeSeconds?: number },
): Promise<{ id: string; stormPolicy: Record<string, unknown>; updatedAt: string } | null> {
  const normalized = normalizedStormPolicy({
    maxRuns: input.maxRuns,
    windowSeconds: input.windowSeconds,
    ...(input.maxAgeSeconds === undefined ? {} : { maxAgeSeconds: input.maxAgeSeconds }),
  });
  // An update that does not mention maxAgeSeconds must not reset a stored custom
  // window to the default (WI-10004920): omit it here and let the jsonb merge below
  // keep whatever the row already carries.
  const stormPolicy: Record<string, unknown> =
    input.maxAgeSeconds === undefined
      ? { windowSeconds: normalized.windowSeconds, maxRuns: normalized.maxRuns }
      : normalized;
  const rows = await sql<
    Array<{
      id: string;
      stormPolicy: Record<string, unknown>;
      updatedAt: Date | string;
    }>
  >`
    UPDATE harness_shared.trigger_bindings
       SET storm_policy = COALESCE(storm_policy, '{}'::jsonb) || ${JSON.stringify(stormPolicy)}::text::jsonb,
           updated_at = now()
     WHERE workspace_id = ${workspaceId} AND id = ${id}::uuid
       AND detached_at IS NULL
     RETURNING id::text, storm_policy AS "stormPolicy", updated_at AS "updatedAt"`;
  if (!rows[0]) return null;
  return { ...rows[0], updatedAt: iso(rows[0].updatedAt) as string };
}
