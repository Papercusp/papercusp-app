/**
 * bulk-run-store — the durable record of an Inbox BULK RESOLVE run
 * (inbox-bulk-resolve-2026-08-23, P-001; migration 912).
 *
 * The owner clicks the Inbox pane's command strip; one resolver agent (D-002)
 * works the exact set of attention items the pane was displaying, auto-resolving
 * what it can settle and pre-recommending the rest for a one-click review pass.
 * This module is the whole persistence surface for that: the run's phase +
 * counters, and one outcome row per item.
 *
 * Two properties are load-bearing and easy to lose, so they live here rather
 * than in a caller:
 *
 *  - **Membership is a SNAPSHOT, never a re-derived query.** `plans.attention`
 *    is a live SSE-invalidated feed, so re-running the owner's filter would
 *    resolve against a set that has moved since they looked. `createRun` takes
 *    the concrete item list the client was rendering; `filterSnapshot` is
 *    human-readable provenance only.
 *  - **Counters are derived from the item rows, never incremented blind.**
 *    `reportOutcomes` recomputes them inside the same statement batch, so a
 *    retried or re-reported item cannot double-count (the resolver reports at
 *    least once per item and may re-report after a consult reply lands).
 *
 * Access mirrors triage-store.ts: plain `getOrgPg().sql` with an explicit
 * workspace_id predicate. The org PG handle connects as the table owner, so the
 * RLS policy is enforced for the runtime app role and bypassed here, exactly as
 * every other operator-state table does it.
 */

import { randomUUID } from 'node:crypto';
import { getOrgPg } from '@papercusp/db-org';
import type { Sql, TransactionSql } from 'postgres';
import { activeWorkspaceId } from '../workspace-registry';
import type { BulkResolverCarryMode, LaunchAgentBackend, ModelEffort } from '../agent-config-constants';
import {
  DEFAULT_TRIPWIRE_WINDOW_HOURS,
  type RevertHandle,
} from '../autonomy/tripwire/core';
import {
  bulkAutomationSnapshot,
  canonicalDispositionForRow,
  type BulkAutomationPolicy,
  type BulkConfidence,
  type BulkDispositionKind,
  type BulkRecommendation,
  type BulkRecommendationKind,
  type BulkResponsibility,
  type BulkIntakeDecision,
  isBulkDispositionKind,
  normalizeBulkAutomationPolicy,
  readIntakeDecision,
} from './bulk-dispositions';
import { readStandingBulkAutomationPolicy } from './automation-policy';
import { deliverUnattendedRunOwnerDigest, UNATTENDED_BULK_REQUESTER } from './bulk-run-owner-digest';

/** Lifecycle of a run. `review` means the agent is done and the owner has
 *  recommendations waiting; `complete` means nothing is left to act on. */
export type BulkRunPhase = 'pending' | 'running' | 'review' | 'complete' | 'failed';

/**
 * What KIND of bulk run this row is (migration 937, cleanup-report-flows P-002).
 * 'inbox-resolve' is the original 912 behavior — membership in the
 * attention_bulk_run_items snapshot. 'plan-cleanup' seeds from `seedRefs` (the
 * plan slugs the Plans pane was rendering at click time) and records outcomes
 * in plan_cleanup_run_findings (plan-cleanup/run-store.ts) instead of the items
 * table. Single-flight is per (workspace, kind): one of EACH may run at once,
 * never two of a kind.
 *
 * 'intake-triage' (migration 1305, observation-candidate plan P-008 / D-020) is
 * the registered drain for awaiting observations and unverified candidates. Its
 * membership and outcomes use the same items snapshot as 'inbox-resolve'; it is
 * a separate kind only so it never contends with the Inbox run's single-flight
 * slot and its reports can be read apart from accepted-work delivery.
 */
export type BulkRunKind = 'inbox-resolve' | 'plan-cleanup' | 'intake-triage';

export const BULK_RUN_KINDS: readonly BulkRunKind[] = ['inbox-resolve', 'plan-cleanup', 'intake-triage'] as const;

/** Kinds whose membership is the attention_bulk_run_items snapshot. */
export function isItemSnapshotRunKind(kind: BulkRunKind): boolean {
  return kind !== 'plan-cleanup';
}

/** The pre-937 rows' kind, and the default everywhere a caller does not say —
 *  which is what keeps every existing inbox call site's behavior unchanged. */
export const DEFAULT_RUN_KIND: BulkRunKind = 'inbox-resolve';

/** Per-item terminal disposition. `pending` is the pre-report state — an item
 *  still carrying it when a run ends was never reached (Requirement 2 makes
 *  that visible rather than silently absent). */
export type BulkItemOutcome = 'pending' | 'auto_resolved' | 'recommended' | 'skipped' | 'failed' | 'dismissed';

/**
 * Keep unattended Inbox compensation on the same bounded clock as the autonomy
 * tripwire plane it extends. One owner-facing concept must not quietly acquire
 * two different undo windows in two stores.
 */
export const BULK_ITEM_REVERSAL_WINDOW_HOURS = DEFAULT_TRIPWIRE_WINDOW_HOURS;

/** One extension kind in the existing autonomy revert-executor vocabulary. */
export const ATTENTION_BULK_ITEM_REVERT_HANDLE_KIND = 'attention-bulk-item' as const;

/**
 * The per-item row is the immutable compensation receipt: it owns the source
 * ref, action id, rationale and outcome. Pointing at it keeps the tripwire
 * handle small and prevents those fields drifting across two audit records.
 */
export function attentionBulkItemRevertHandle(input: {
  workspaceId: string;
  runId: string;
  itemId: string;
}): RevertHandle {
  return {
    kind: ATTENTION_BULK_ITEM_REVERT_HANDLE_KIND,
    version: 1,
    workspaceId: input.workspaceId,
    runId: input.runId,
    itemId: input.itemId,
  };
}

/** Non-terminal phases — a run in one of these is still the pane's current run. */
export const ACTIVE_PHASES: readonly BulkRunPhase[] = ['pending', 'running', 'review'] as const;

/** Terminal phases — nothing further will be written by the resolver. */
export const TERMINAL_PHASES: readonly BulkRunPhase[] = ['complete', 'failed'] as const;

/**
 * Phases in which a run is EXCLUSIVE — an agent is acting, or is about to.
 * `review` is deliberately absent: a run in review is waiting on the OWNER, not
 * working, so it must not block a new run behind a review list the owner may
 * never return to. Migration 915's partial unique index is keyed on exactly
 * this set; keep the two in step.
 */
export const RUNNING_PHASES: readonly BulkRunPhase[] = ['pending', 'running'] as const;

/**
 * Phases in which the resolver's outcome reports are still accepted. Same set
 * as RUNNING_PHASES today, but named separately because it answers a different
 * question ("may this write land?" rather than "may a new run start?") and the
 * two are free to diverge.
 */
const ACCEPTING_REPORTS: readonly BulkRunPhase[] = RUNNING_PHASES;

/**
 * WI-41012 — a start was refused because a run is already pending/running in
 * this workspace. Typed rather than a bare Error so the route can answer with a
 * useful `run_already_active` (naming the run already in flight) instead of a
 * 500, and so the pre-check and the DB rail are indistinguishable to a caller.
 */
export class BulkRunAlreadyActiveError extends Error {
  readonly code = 'run_already_active';
  constructor(
    readonly activeRunId: string | null,
    readonly activePhase: BulkRunPhase | null,
    readonly runKind: BulkRunKind = DEFAULT_RUN_KIND,
  ) {
    super(
      activeRunId
        ? `a ${runKind} bulk run is already active (${activeRunId}, phase ${activePhase ?? 'unknown'})`
        : `a ${runKind} bulk run is already active in this workspace`,
    );
    this.name = 'BulkRunAlreadyActiveError';
  }
}

/** Is this error the single-flight index (migration 915) refusing a second run? */
function isSingleFlightViolation(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  if (code !== '23505') return false;
  const detail = `${(e as { constraint_name?: unknown } | null)?.constraint_name ?? ''} ${
    e instanceof Error ? e.message : ''
  }`;
  return detail.includes('one_active_per_workspace');
}

/** The filters in force when the owner clicked — provenance for the record and
 *  the review header, never the source of membership. */
export interface BulkRunFilterSnapshot {
  /** The tier chip (`opci`): needs | alerts | all. */
  tier?: string | null;
  /** Selected kind facets (`opck`). */
  kinds?: string[];
  /** The text search (`opcq`). */
  query?: string | null;
  /** What the pane said it was showing — cross-checked against items.length. */
  shownCount?: number | null;
}

/**
 * The effective resolver launch settings AS LAUNCHED, captured once when the run
 * row is created (migration 943).
 *
 * This is deliberately a snapshot rather than a join to the owner's stored
 * per-kind profile: `resolverProfiles` is mutable, so re-reading it would render
 * last week's run with today's defaults — the same drift `filterSnapshot`
 * already prevents for membership.
 *
 * `backend` is the CLI backend derived from `model` at click time. Recording it
 * does not contradict the rule that backend is derived from the model and never
 * a second independently editable truth: that governs the mutable PROFILE, while
 * this row is an immutable record of what actually ran.
 *
 * Every field is optional because a run created before 943 — or by an older
 * deployed release that does not post launch settings — stores `{}`. Readers
 * MUST treat an absent field as "inherit the launcher default", never as an
 * assertion that the run used `null`.
 */
export interface BulkRunLaunchSnapshot {
  model?: string | null;
  effort?: ModelEffort | null;
  account?: string | null;
  carry?: BulkResolverCarryMode | null;
  backend?: LaunchAgentBackend | null;
  /** Owner-selected confidence/automation floor, added by migration 1015. */
  automationPolicy?: BulkAutomationPolicy | null;
}

/** One item as the client was displaying it at click time. */
export interface BulkRunSeedItem {
  itemId: string;
  kind?: string | null;
  title?: string | null;
  /** The item's dispatch coordinates (msgId / slug+itemId / issueId / …).
   *  Attention items are projections with no row to reference, so re-dispatch
   *  later depends entirely on this snapshot. */
  ref?: Record<string, unknown> | null;
  ownerAgentId?: string | null;
}

export interface BulkRunRow {
  runId: string;
  workspaceId: string;
  harnessSlug: string | null;
  requestedBy: string | null;
  resolverOwner: string | null;
  phase: BulkRunPhase;
  runKind: BulkRunKind;
  /** Click-time membership snapshot for kinds without an items list — for
   *  'plan-cleanup', the plan slugs the pane was rendering. '[]' for inbox. */
  seedRefs: string[];
  filterSnapshot: BulkRunFilterSnapshot;
  /** Click-time snapshot of the effective launch settings (migration 943).
   *  `{}` for runs created before 943 or by a release that posts no settings. */
  launchSnapshot: BulkRunLaunchSnapshot;
  /** Normalized owner policy; legacy rows use Safe high-confidence defaults. */
  automationPolicy?: BulkAutomationPolicy;
  totalItems: number;
  autoResolved: number;
  recommended: number;
  skipped: number;
  failed: number;
  error: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  /**
   * Last liveness report from the resolver process owning this run (migration 945).
   *
   * `null` means NEVER REPORTED — a run created before 945, or one that has not begun
   * executing yet. That is deliberately distinguishable from "reported, but long ago":
   * the two warrant different owner-facing language, and collapsing them is exactly the
   * conflation a stored `stale` flag would force. Staleness is DERIVED from this value
   * (see {@link classifyRunLiveness}), never persisted.
   */
  heartbeatAt: string | null;
}

export interface BulkRunItemRow {
  runId: string;
  itemId: string;
  position: number;
  kind: string | null;
  title: string | null;
  ref: Record<string, unknown>;
  ownerAgentId: string | null;
  outcome: BulkItemOutcome;
  actionId: string | null;
  rationale: string | null;
  draftAnswer: string | null;
  confidence: 'low' | 'high' | null;
  consulted: boolean;
  consultReply: string | null;
  error: string | null;
  decidedAt: string | null;
  /** Typed handle consumed by the shared autonomy revert-executor registry. */
  revertHandle: RevertHandle | null;
  /** Exclusive owner undo deadline. Historical pre-1063 rows legitimately lack one. */
  reversalWindowUntil: string | null;
  /** Successful compensation metadata; the original outcome remains immutable. */
  revertedAt: string | null;
  revertNote: string | null;
  /** Canonical disposition; legacy `skipped` rows are classified on read. */
  disposition?: BulkDispositionKind;
  /** Raw DB value when it differs from the canonical compatibility projection. */
  legacyDisposition?: string | null;
  recommendation?: BulkRecommendation | null;
  recommendationKind?: BulkRecommendationKind | null;
  recommendationLabel?: string | null;
  recommendationRationale?: string | null;
  evidenceBasis?: string[];
  responsibility?: BulkResponsibility | null;
  confidenceLevel?: BulkConfidence | null;
  retryCondition?: string | null;
  /** Typed intake decision for an intake input (P-004); null until decided. */
  intakeDecision?: BulkIntakeDecision | null;
}

/** What the resolver reports back for one item. */
export interface BulkOutcomeReport {
  itemId: string;
  outcome: Exclude<BulkItemOutcome, 'pending'>;
  actionId?: string | null;
  rationale?: string | null;
  draftAnswer?: string | null;
  confidence?: 'low' | 'high' | null;
  confidenceLevel?: BulkConfidence | null;
  recommendationKind?: BulkRecommendationKind | null;
  recommendationLabel?: string | null;
  recommendationRationale?: string | null;
  evidenceBasis?: string[] | null;
  responsibility?: BulkResponsibility | null;
  retryCondition?: string | null;
  consulted?: boolean;
  consultReply?: string | null;
  error?: string | null;
  /** Canonical typed disposition. Required for new non-terminal reports; old
   *  callers may omit it and retain legacy outcome semantics. */
  disposition?: BulkDispositionKind | null;
  /** Validated intake decision (bulk-dispositions parseIntakeDecision). */
  intakeDecision?: BulkIntakeDecision | null;
}

function dispositionForReport(report: BulkOutcomeReport): BulkDispositionKind {
  if (report.disposition && isBulkDispositionKind(report.disposition)) {
    return report.disposition;
  }
  if (report.outcome === 'skipped') return 'legacy_skipped';
  return report.outcome;
}

function iso(v: Date | string | null | undefined): string | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

/** Validate before crossing the SQL boundary. Migration 1063 repeats this as a
 * CHECK constraint so a non-TypeScript writer cannot bypass the guarantee. */
function serializedRevertHandle(handle: RevertHandle | null | undefined, source: string): string {
  if (!handle || typeof handle !== 'object' || Array.isArray(handle)) {
    throw new Error(`${source}: auto_resolved requires an object revertHandle`);
  }
  const kind = typeof handle.kind === 'string' ? handle.kind.trim() : '';
  if (!kind) throw new Error(`${source}: revertHandle.kind must be a non-empty string`);
  return JSON.stringify({ ...handle, kind });
}

/** seed_refs normalizer — a jsonb string[] (parsed or still-serialized). */
function asStringArray(v: unknown): string[] {
  const arr = Array.isArray(v)
    ? v
    : typeof v === 'string'
      ? (() => {
          try {
            const parsed = JSON.parse(v);
            return Array.isArray(parsed) ? parsed : [];
          } catch {
            return [];
          }
        })()
      : [];
  return arr.filter((x): x is string => typeof x === 'string' && x !== '');
}

/** Postgres `jsonb` comes back parsed by the driver, but a legacy/text column
 *  or a hand-written row can still hand us a string — normalize both. */
function asObject(v: unknown): Record<string, unknown> {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      /* fall through to {} */
    }
  }
  return {};
}

interface RawRunRow {
  run_id: string;
  workspace_id: string;
  harness_slug: string | null;
  requested_by: string | null;
  resolver_owner: string | null;
  phase: BulkRunPhase;
  run_kind: BulkRunKind | null;
  seed_refs: unknown;
  filter_snapshot: unknown;
  launch_snapshot: unknown;
  automation_policy: unknown;
  total_items: number | string;
  auto_resolved: number | string;
  recommended: number | string;
  skipped: number | string;
  failed: number | string;
  error: string | null;
  created_at: Date | string | null;
  updated_at: Date | string | null;
  started_at: Date | string | null;
  finished_at: Date | string | null;
  heartbeat_at: Date | string | null;
}

function mapRun(r: RawRunRow): BulkRunRow {
  const launchSnapshot = asObject(r.launch_snapshot) as BulkRunLaunchSnapshot;
  if (launchSnapshot.automationPolicy) {
    launchSnapshot.automationPolicy = normalizeBulkAutomationPolicy(launchSnapshot.automationPolicy);
  }
  return {
    runId: r.run_id,
    workspaceId: r.workspace_id,
    harnessSlug: r.harness_slug,
    requestedBy: r.requested_by,
    resolverOwner: r.resolver_owner,
    phase: r.phase,
    runKind: r.run_kind ?? DEFAULT_RUN_KIND,
    seedRefs: asStringArray(r.seed_refs),
    filterSnapshot: asObject(r.filter_snapshot) as BulkRunFilterSnapshot,
    launchSnapshot,
    automationPolicy: normalizeBulkAutomationPolicy(asObject(r.automation_policy) as Partial<BulkAutomationPolicy>),
    totalItems: Number(r.total_items ?? 0),
    autoResolved: Number(r.auto_resolved ?? 0),
    recommended: Number(r.recommended ?? 0),
    skipped: Number(r.skipped ?? 0),
    failed: Number(r.failed ?? 0),
    error: r.error,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    startedAt: iso(r.started_at),
    finishedAt: iso(r.finished_at),
    heartbeatAt: iso(r.heartbeat_at),
  };
}

interface RawItemRow {
  run_id: string;
  item_id: string;
  position: number | string;
  item_kind: string | null;
  item_title: string | null;
  item_ref: unknown;
  owner_agent_id: string | null;
  outcome: BulkItemOutcome;
  action_id: string | null;
  rationale: string | null;
  draft_answer: string | null;
  confidence: 'low' | 'high' | null;
  consulted: boolean;
  consult_reply: string | null;
  error: string | null;
  decided_at: Date | string | null;
  revert_handle: unknown;
  reversal_window_until: Date | string | null;
  reverted_at: Date | string | null;
  revert_note: string | null;
  disposition: string | null;
  recommendation_kind: BulkRecommendationKind | null;
  recommendation_label: string | null;
  recommendation_rationale: string | null;
  evidence_basis: unknown;
  responsibility: BulkResponsibility | null;
  confidence_level: BulkConfidence | null;
  retry_condition: string | null;
  intake_decision?: unknown;
}

function mapItem(r: RawItemRow): BulkRunItemRow {
  const rawDisposition = r.disposition;
  const canonical = canonicalDispositionForRow({
    outcome: r.outcome,
    disposition: rawDisposition as BulkDispositionKind | null,
    itemKind: r.item_kind,
    title: r.item_title,
    error: r.error,
    rationale: r.rationale,
    itemId: r.item_id,
  });
  const hasPersistedRecommendation =
    r.recommendation_kind != null && r.recommendation_label != null && r.recommendation_rationale != null;
  const recommendation = hasPersistedRecommendation
    ? {
        kind: r.recommendation_kind!,
        label: r.recommendation_label!,
        rationale: r.recommendation_rationale!,
        evidenceBasis: asStringArray(r.evidence_basis),
        confidence: r.confidence_level ?? 'insufficient',
        responsibility: r.responsibility ?? 'unknown',
        actionId: r.action_id,
        retryCondition: r.retry_condition,
        targetRef: r.item_id,
      }
    : canonical.recommendation;
  const rawRevertHandle = asObject(r.revert_handle);
  const revertHandle =
    typeof rawRevertHandle.kind === 'string' && rawRevertHandle.kind.trim()
      ? ({ ...rawRevertHandle, kind: rawRevertHandle.kind.trim() } as RevertHandle)
      : null;
  return {
    runId: r.run_id,
    itemId: r.item_id,
    position: Number(r.position ?? 0),
    kind: r.item_kind,
    title: r.item_title,
    ref: asObject(r.item_ref),
    ownerAgentId: r.owner_agent_id,
    outcome: r.outcome,
    actionId: r.action_id,
    rationale: r.rationale,
    draftAnswer: r.draft_answer,
    confidence: r.confidence,
    consulted: r.consulted === true,
    consultReply: r.consult_reply,
    error: r.error,
    decidedAt: iso(r.decided_at),
    revertHandle,
    reversalWindowUntil: iso(r.reversal_window_until),
    revertedAt: iso(r.reverted_at),
    revertNote: r.revert_note,
    disposition: canonical.disposition,
    legacyDisposition: rawDisposition && rawDisposition !== canonical.disposition ? rawDisposition : null,
    recommendation,
    recommendationKind: r.recommendation_kind ?? recommendation?.kind ?? null,
    recommendationLabel: r.recommendation_label ?? recommendation?.label ?? null,
    recommendationRationale: r.recommendation_rationale ?? recommendation?.rationale ?? null,
    evidenceBasis: asStringArray(r.evidence_basis ?? recommendation?.evidenceBasis),
    responsibility: r.responsibility ?? recommendation?.responsibility ?? null,
    confidenceLevel: r.confidence_level ?? recommendation?.confidence ?? null,
    retryCondition: r.retry_condition ?? recommendation?.retryCondition ?? null,
    intakeDecision: readIntakeDecision(r.intake_decision),
  };
}

const RUN_COLUMNS = `run_id, workspace_id, harness_slug, requested_by, resolver_owner, phase,
                     run_kind, seed_refs, filter_snapshot, launch_snapshot,
                     automation_policy,
                     total_items, auto_resolved, recommended, skipped, failed,
                     error, created_at, updated_at, started_at, finished_at, heartbeat_at`;

const ITEM_COLUMNS = `run_id, item_id, position, item_kind, item_title, item_ref, owner_agent_id,
                      outcome, action_id, rationale, draft_answer, confidence, consulted,
                      consult_reply, error, decided_at, revert_handle, reversal_window_until,
                      reverted_at, revert_note, disposition, recommendation_kind,
                      recommendation_label, recommendation_rationale, evidence_basis,
                      responsibility, confidence_level, retry_condition, intake_decision`;

type BulkSql = Sql | TransactionSql;

async function recomputeCounters(sql: BulkSql, runId: string, workspaceId: string): Promise<void> {
  await sql`
    UPDATE harness_shared.attention_bulk_runs r
       SET auto_resolved = c.auto_resolved,
           recommended = c.recommended,
           skipped = c.skipped,
           failed = c.failed,
           updated_at = now()
      FROM (
        SELECT
          COUNT(*) FILTER (WHERE outcome = 'auto_resolved')::int AS auto_resolved,
          COUNT(*) FILTER (WHERE outcome = 'recommended')::int  AS recommended,
          COUNT(*) FILTER (WHERE outcome IN ('skipped', 'dismissed'))::int AS skipped,
          COUNT(*) FILTER (WHERE outcome = 'failed')::int       AS failed
          FROM harness_shared.attention_bulk_run_items
         WHERE workspace_id = ${workspaceId} AND run_id = ${runId}
      ) c
     WHERE r.workspace_id = ${workspaceId} AND r.run_id = ${runId}
  `;
}

async function recomputeCleanupCounters(sql: BulkSql, runId: string, workspaceId: string): Promise<void> {
  await sql`
    UPDATE harness_shared.attention_bulk_runs r
       SET auto_resolved = c.auto_resolved,
           recommended = c.recommended,
           skipped = c.skipped,
           failed = c.failed,
           updated_at = now()
      FROM (
        SELECT
          COUNT(*) FILTER (WHERE outcome IN ('auto_applied', 'accepted'))::int AS auto_resolved,
          COUNT(*) FILTER (WHERE outcome = 'recommended')::int AS recommended,
          COUNT(*) FILTER (WHERE outcome IN ('dismissed', 'skipped'))::int AS skipped,
          COUNT(*) FILTER (WHERE outcome = 'failed')::int AS failed
          FROM harness_shared.plan_cleanup_run_findings
         WHERE workspace_id = ${workspaceId} AND run_id = ${runId}
      ) c
     WHERE r.workspace_id = ${workspaceId} AND r.run_id = ${runId}
  `;
}

/**
 * Execute one irreversible terminal action while holding the run's revocable
 * authority token. Stop/settle takes the same row lock, so exactly one ordering
 * wins: either the action (including audit + outcome + counters) commits first,
 * or Stop commits first and the callback is never entered.
 */
export async function executeBulkRunAction<T>(input: {
  runId: string;
  itemId: string;
  actionId: string;
  rationale: string;
  draftAnswer?: string | null;
  confidence?: 'low' | 'high' | null;
  confidenceLevel?: BulkConfidence | null;
  recommendationKind?: BulkRecommendationKind | null;
  recommendationLabel?: string | null;
  recommendationRationale?: string | null;
  evidenceBasis?: string[] | null;
  responsibility?: BulkResponsibility | null;
  retryCondition?: string | null;
  consulted?: boolean;
  consultReply?: string | null;
  /** When present, the irreversible action is accepted only from the resolver
   * currently named on the run. Restart rotates that owner before spawning the
   * replacement, so a late prior resolver cannot act on the new generation. */
  resolverOwner?: string | null;
  workspaceId?: string;
  execute: () => Promise<T>;
  /**
   * REQUIRED, not optional. The audit write joins this transaction, so a
   * failure rolls the run outcome back instead of reporting a clean, unaudited
   * success — that rollback IS the fix for WI-41023, and it only holds if the
   * callback is actually supplied.
   *
   * Optional would have made the guarantee rest on every future caller
   * REMEMBERING to pass it, which is the convention-tier enforcement WI-41023
   * was filed about in the first place (its swallowed `catch {}` was the same
   * bug one layer down). Requiring it moves the rule to the structural tier:
   * a caller that omits the audit does not compile. A terminal action that
   * genuinely needs no audit row must say so explicitly with a no-op.
   */
  audit: (sql: TransactionSql) => Promise<void>;
}): Promise<{
  actionResult: T | null;
  item: BulkRunItemRow | null;
  run: BulkRunRow | null;
  refused:
    | { reason: 'run_authority_revoked'; phase: BulkRunPhase }
    | { reason: 'resolver_owner_mismatch'; phase: BulkRunPhase }
    | { reason: 'run_not_found'; phase: null }
    | { reason: 'item_not_in_run'; phase: BulkRunPhase }
    | null;
}> {
  const { sql } = getOrgPg();
  const ws = input.workspaceId ?? activeWorkspaceId();

  return await sql.begin(async (tx) => {
    const runRows = await tx<RawRunRow[]>`
      SELECT ${tx.unsafe(RUN_COLUMNS)}
        FROM harness_shared.attention_bulk_runs
       WHERE workspace_id = ${ws} AND run_id = ${input.runId}
       FOR UPDATE
    `;
    const run = runRows[0] ? mapRun(runRows[0]) : null;
    if (!run)
      return { actionResult: null, item: null, run: null, refused: { reason: 'run_not_found' as const, phase: null } };
    if (input.resolverOwner && run.resolverOwner !== input.resolverOwner) {
      return {
        actionResult: null,
        item: null,
        run,
        refused: { reason: 'resolver_owner_mismatch' as const, phase: run.phase },
      };
    }
    if (!ACCEPTING_REPORTS.includes(run.phase)) {
      return {
        actionResult: null,
        item: null,
        run,
        refused: { reason: 'run_authority_revoked' as const, phase: run.phase },
      };
    }

    const itemRows = await tx<RawItemRow[]>`
      SELECT ${tx.unsafe(ITEM_COLUMNS)}
        FROM harness_shared.attention_bulk_run_items
       WHERE workspace_id = ${ws} AND run_id = ${input.runId} AND item_id = ${input.itemId}
       FOR UPDATE
    `;
    if (!itemRows[0]) {
      return {
        actionResult: null,
        item: null,
        run,
        refused: { reason: 'item_not_in_run' as const, phase: run.phase },
      };
    }

    const actionResult = await input.execute();
    const revertHandle = serializedRevertHandle(
      attentionBulkItemRevertHandle({
        workspaceId: ws,
        runId: input.runId,
        itemId: input.itemId,
      }),
      `executeBulkRunAction(${input.runId}/${input.itemId})`,
    );
    // No `?.` — the audit is part of the success contract (see the type above).
    await input.audit(tx);
    const updatedRows = await tx<RawItemRow[]>`
      UPDATE harness_shared.attention_bulk_run_items
         SET outcome = 'auto_resolved',
             action_id = ${input.actionId},
             rationale = ${input.rationale},
             draft_answer = ${input.draftAnswer ?? null},
             confidence = ${input.confidence ?? null},
             consulted = ${input.consulted === true},
             consult_reply = ${input.consultReply ?? null},
             disposition = 'auto_resolved',
             recommendation_kind = ${input.recommendationKind ?? null},
             recommendation_label = ${input.recommendationLabel ?? null},
             recommendation_rationale = ${input.recommendationRationale ?? null},
             evidence_basis = ${JSON.stringify(input.evidenceBasis ?? [])}::jsonb,
             responsibility = ${input.responsibility ?? null},
             confidence_level = ${input.confidenceLevel ?? (input.confidence === 'high' ? 'high' : input.confidence === 'low' ? 'low' : null)},
             retry_condition = ${input.retryCondition ?? null},
             error = NULL,
             decided_at = now(),
             revert_handle = ${revertHandle}::jsonb,
             reversal_window_until = now() + make_interval(hours => ${BULK_ITEM_REVERSAL_WINDOW_HOURS}),
             reverted_at = NULL,
             revert_note = NULL,
             updated_at = now()
       WHERE workspace_id = ${ws} AND run_id = ${input.runId} AND item_id = ${input.itemId}
      RETURNING ${tx.unsafe(ITEM_COLUMNS)}
    `;
    await recomputeCounters(tx, input.runId, ws);
    const afterRows = await tx<RawRunRow[]>`
      SELECT ${tx.unsafe(RUN_COLUMNS)}
        FROM harness_shared.attention_bulk_runs
       WHERE workspace_id = ${ws} AND run_id = ${input.runId}
    `;
    return {
      actionResult,
      item: updatedRows[0] ? mapItem(updatedRows[0]) : null,
      run: afterRows[0] ? mapRun(afterRows[0]) : null,
      refused: null,
    };
  });
}

/**
 * Create a run from the owner's SNAPSHOT of filtered items. Returns the created
 * run row. An empty item list is rejected: a run over nothing is always a caller
 * bug (the strip is disabled at zero), and creating one would leave the pane in
 * a `review` state with nothing to review.
 */
export async function createRun(input: {
  items: BulkRunSeedItem[];
  filterSnapshot?: BulkRunFilterSnapshot;
  requestedBy?: string | null;
  harnessSlug?: string | null;
  workspaceId?: string;
  runId?: string;
  /** Which machinery this run rides (migration 937). Defaults to the original
   *  inbox behavior so every existing call site is unchanged. */
  runKind?: BulkRunKind;
  /** REQUIRED for 'plan-cleanup': the click-time membership snapshot (the plan
   *  slugs the pane was rendering). Ignored for 'inbox-resolve', whose
   *  membership is the `items` snapshot. */
  seedRefs?: string[];
  /** The effective launch settings this run was started with (migration 943).
   *  Optional so every existing call site is unchanged: omitting it stores `{}`,
   *  which readers render as "launcher default", exactly as before. */
  launchSnapshot?: BulkRunLaunchSnapshot;
  /** Owner-selected automation policy; legacy callers use Safe high-confidence. */
  automationPolicy?: Partial<BulkAutomationPolicy> | null;
}): Promise<BulkRunRow> {
  const runKind = input.runKind ?? DEFAULT_RUN_KIND;
  const items = input.items ?? [];
  const seedRefs = [...new Set((input.seedRefs ?? []).filter((s) => typeof s === 'string' && s !== ''))];
  // Same "a run over nothing is a caller bug" rule, per kind: an inbox run needs
  // its item snapshot; a plan-cleanup run needs its plan-slug snapshot.
  if (isItemSnapshotRunKind(runKind) && items.length === 0) {
    throw new Error('createRun: refusing to create a bulk run with zero items');
  }
  if (runKind === 'plan-cleanup' && seedRefs.length === 0) {
    throw new Error('createRun: refusing to create a plan-cleanup run with zero seed plan slugs');
  }

  const { sql } = getOrgPg();
  const ws = input.workspaceId ?? activeWorkspaceId();
  const runId = input.runId ?? `bulk-${randomUUID()}`;
  // P-006: owner routes pass no policy override. Resolve the standing
  // workspace policy once and persist its normalized launch receipt. The
  // legacy input remains accepted for old programmatic callers only.
  const automationPolicy = input.automationPolicy
    ? normalizeBulkAutomationPolicy(input.automationPolicy)
    : bulkAutomationSnapshot(await readStandingBulkAutomationPolicy(ws));
  const launchSnapshot = input.launchSnapshot
    ? ({ ...input.launchSnapshot, automationPolicy } as BulkRunLaunchSnapshot)
    : ({} as BulkRunLaunchSnapshot);

  // WI-41012 — single-flight. Starting a run LAUNCHES A REAL HEADLESS AGENT with
  // terminal authority over the owner's attention items, so two live runs means
  // two agents racing on overlapping items: the same item resolved twice, its
  // asker woken twice, two audit trails for one owner intention. This check is
  // the friendly half; migration 915's partial unique index is the rail that
  // makes it TRUE rather than likely (a check-then-insert races exactly as wide
  // as its own round trip, which is where a double-click lands).
  const live = await getRunningRun(ws, runKind);
  if (live) throw new BulkRunAlreadyActiveError(live.runId, live.phase, runKind);

  // De-dupe defensively: the client builds this list from a virtualized render,
  // and a duplicate id would violate the (workspace, run, item) key mid-insert
  // and abort the whole seed.
  const seen = new Set<string>();
  const unique = items.filter((i) => {
    if (!i?.itemId || seen.has(i.itemId)) return false;
    seen.add(i.itemId);
    return true;
  });
  if (isItemSnapshotRunKind(runKind) && unique.length === 0) {
    throw new Error('createRun: no valid item ids in the snapshot');
  }
  // total_items: the run's unit count for the strip — items for inbox runs,
  // seed plans for plan-cleanup (its findings accrue during the run and are
  // counted on their own table, plan-cleanup/run-store.ts).
  const totalItems = runKind === 'plan-cleanup' ? seedRefs.length : unique.length;

  let rows: RawRunRow[];
  try {
    // The run row and its complete membership snapshot are one durable unit.
    // If any item seed fails, rolling back the transaction prevents a pending
    // run with a partial manifest from occupying the single-flight slot.
    rows = await sql.begin(async (tx) => {
      const inserted = await tx<RawRunRow[]>`
        INSERT INTO harness_shared.attention_bulk_runs
          (workspace_id, run_id, harness_slug, requested_by, phase, run_kind, seed_refs,
           filter_snapshot, launch_snapshot, automation_policy, total_items)
        VALUES (${ws}, ${runId}, ${input.harnessSlug ?? null}, ${input.requestedBy ?? null},
                'pending', ${runKind}, ${JSON.stringify(seedRefs)}::jsonb,
                ${JSON.stringify(input.filterSnapshot ?? {})}::jsonb,
                ${JSON.stringify(launchSnapshot)}::jsonb,
                ${JSON.stringify(automationPolicy)}::jsonb, ${totalItems})
        RETURNING ${tx.unsafe(RUN_COLUMNS)}
      `;

      for (let i = 0; i < unique.length; i += 1) {
        const it = unique[i]!;
        await tx`
          INSERT INTO harness_shared.attention_bulk_run_items
            (workspace_id, run_id, item_id, position, item_kind, item_title, item_ref, owner_agent_id,
             outcome, disposition)
          VALUES (${ws}, ${runId}, ${it.itemId}, ${i}, ${it.kind ?? null}, ${it.title ?? null},
                  ${JSON.stringify(it.ref ?? {})}::jsonb, ${it.ownerAgentId ?? null}, 'pending', 'pending')
          ON CONFLICT (workspace_id, run_id, item_id) DO NOTHING
        `;
      }

      return inserted;
    });
  } catch (e) {
    // The rail firing (migration 916→937) means a concurrent start won the race
    // between our check above and this insert. Re-read and report it as the
    // SAME typed refusal, so the caller cannot tell the two paths apart and a
    // race never surfaces to the owner as a 500.
    if (isSingleFlightViolation(e)) {
      const live = await getRunningRun(ws, runKind);
      throw new BulkRunAlreadyActiveError(live?.runId ?? null, live?.phase ?? null, runKind);
    }
    throw e;
  }

  return mapRun(rows[0]!);
}

/** Read one run (no items). Null when it does not exist in this workspace. */
export async function getRun(runId: string, workspaceId?: string): Promise<BulkRunRow | null> {
  const { sql } = getOrgPg();
  const ws = workspaceId ?? activeWorkspaceId();
  const rows = await sql<RawRunRow[]>`
    SELECT ${sql.unsafe(RUN_COLUMNS)}
      FROM harness_shared.attention_bulk_runs
     WHERE workspace_id = ${ws} AND run_id = ${runId}
  `;
  return rows[0] ? mapRun(rows[0]) : null;
}

/** One run's items, in the order the owner was looking at them. */
export async function getRunItems(runId: string, workspaceId?: string): Promise<BulkRunItemRow[]> {
  const { sql } = getOrgPg();
  const ws = workspaceId ?? activeWorkspaceId();
  const rows = await sql<RawItemRow[]>`
    SELECT ${sql.unsafe(ITEM_COLUMNS)}
      FROM harness_shared.attention_bulk_run_items
     WHERE workspace_id = ${ws} AND run_id = ${runId}
     ORDER BY position ASC
  `;
  return rows.map(mapItem);
}

export type BulkRunItemReversalRefusal =
  | 'item_not_found'
  | 'not_auto_resolved'
  | 'missing_revert_handle'
  | 'unsupported_revert_handle'
  | 'already_reverted'
  | 'window_expired';

/**
 * Run one compensation under the item-row lock, then append its result to the
 * immutable audit row. Database time decides the deadline; client clocks never
 * get to extend the owner window. The callback receives the caller-owned SQL
 * transaction so DB-backed compensations can join the same success boundary.
 */
export async function executeBulkRunItemReversal<T>(input: {
  runId: string;
  itemId: string;
  workspaceId?: string;
  execute: (
    item: BulkRunItemRow,
    sql: TransactionSql,
  ) => Promise<{ result: T; note: string }>;
}): Promise<{
  result: T | null;
  item: BulkRunItemRow | null;
  refused: BulkRunItemReversalRefusal | null;
}> {
  const { sql } = getOrgPg();
  const ws = input.workspaceId ?? activeWorkspaceId();
  return await sql.begin(async (tx) => {
    const rows = await tx<Array<RawItemRow & { reversal_open: boolean }>>`
      SELECT ${tx.unsafe(ITEM_COLUMNS)},
             COALESCE(reversal_window_until > now(), false) AS reversal_open
        FROM harness_shared.attention_bulk_run_items
       WHERE workspace_id = ${ws}
         AND run_id = ${input.runId}
         AND item_id = ${input.itemId}
       FOR UPDATE
    `;
    if (!rows[0]) return { result: null, item: null, refused: 'item_not_found' as const };

    const item = mapItem(rows[0]);
    if (item.outcome !== 'auto_resolved') {
      return { result: null, item, refused: 'not_auto_resolved' as const };
    }
    if (!item.revertHandle) {
      return { result: null, item, refused: 'missing_revert_handle' as const };
    }
    if (item.revertHandle.kind !== ATTENTION_BULK_ITEM_REVERT_HANDLE_KIND) {
      return { result: null, item, refused: 'unsupported_revert_handle' as const };
    }
    if (item.revertedAt) {
      return { result: null, item, refused: 'already_reverted' as const };
    }
    if (!rows[0].reversal_open) {
      return { result: null, item, refused: 'window_expired' as const };
    }

    const compensation = await input.execute(item, tx);
    const note = compensation.note.trim();
    if (!note) throw new Error('executeBulkRunItemReversal: compensation note must be non-empty');

    const updated = await tx<RawItemRow[]>`
      UPDATE harness_shared.attention_bulk_run_items
         SET reverted_at = now(),
             revert_note = ${note},
             updated_at = now()
       WHERE workspace_id = ${ws}
         AND run_id = ${input.runId}
         AND item_id = ${input.itemId}
      RETURNING ${tx.unsafe(ITEM_COLUMNS)}
    `;
    return {
      result: compensation.result,
      item: updated[0] ? mapItem(updated[0]) : item,
      refused: null,
    };
  });
}

/**
 * The pane's opening question: the workspace's most recent run, if any. The
 * strip renders idle when this is null or terminal, and running/review from its
 * phase otherwise — which is what makes a run survive a reload (Requirement 7).
 */
export async function getLatestRun(
  workspaceId?: string,
  kind: BulkRunKind | null = DEFAULT_RUN_KIND,
): Promise<BulkRunRow | null> {
  const { sql } = getOrgPg();
  const ws = workspaceId ?? activeWorkspaceId();
  const rows = await sql<RawRunRow[]>`
    SELECT ${sql.unsafe(RUN_COLUMNS)}
      FROM harness_shared.attention_bulk_runs
     WHERE workspace_id = ${ws}
       AND (${kind ?? null}::text IS NULL OR run_kind = ${kind ?? null})
     ORDER BY created_at DESC
     LIMIT 1
  `;
  return rows[0] ? mapRun(rows[0]) : null;
}

/**
 * The run that currently OWNS the workspace: pending or running — i.e. one an
 * agent is acting on. Distinct from getActiveRun, which also counts `review`
 * (owner-waiting) and answers "what should the pane show". This one answers
 * "may a new run start" and "is this run still accepting the resolver's work",
 * and is keyed on the same set as migration 915's single-flight index.
 */
export async function getRunningRun(
  workspaceId?: string,
  kind: BulkRunKind | null = DEFAULT_RUN_KIND,
): Promise<BulkRunRow | null> {
  const { sql } = getOrgPg();
  const ws = workspaceId ?? activeWorkspaceId();
  const rows = await sql<RawRunRow[]>`
    SELECT ${sql.unsafe(RUN_COLUMNS)}
      FROM harness_shared.attention_bulk_runs
     WHERE workspace_id = ${ws} AND phase IN ('pending', 'running')
       AND (${kind ?? null}::text IS NULL OR run_kind = ${kind ?? null})
     ORDER BY created_at DESC
     LIMIT 1
  `;
  return rows[0] ? mapRun(rows[0]) : null;
}

/**
 * Item ids that already sit in a run of `kind` still waiting on the OWNER
 * (phase `review`), excluding rows the resolver fully auto-resolved — the same
 * "still owner work" predicate as getPendingReviewItems, widened from one run
 * to the workspace. A dismissed row in a still-open review counts as held too:
 * the owner just declined that recommendation, and regenerating it minutes
 * later is the churn this exists to stop.
 *
 * Why: once a `review` run stopped gating the scheduled backstop
 * (getRunningRun, WI-10004720), every fire re-seeded the SAME top-200 feed
 * items — 13 runs in 3h on 2026-10-01, 194–200 of each run's 200 items already
 * in an earlier run, each costing a resolver pass and adding 200 duplicate
 * recommendations to the owner's review queue. The seeder skips these ids so a
 * fire moves on to items nobody has looked at yet.
 */
export async function getItemIdsAwaitingOwnerReview(
  workspaceId?: string,
  kind: BulkRunKind | null = DEFAULT_RUN_KIND,
): Promise<Set<string>> {
  const { sql } = getOrgPg();
  const ws = workspaceId ?? activeWorkspaceId();
  const rows = await sql<{ item_id: string }[]>`
    SELECT DISTINCT i.item_id
      FROM harness_shared.attention_bulk_run_items i
      JOIN harness_shared.attention_bulk_runs r
        ON r.workspace_id = i.workspace_id AND r.run_id = i.run_id
     WHERE r.workspace_id = ${ws} AND r.phase = 'review'
       AND (${kind ?? null}::text IS NULL OR r.run_kind = ${kind ?? null})
       AND i.outcome <> 'auto_resolved'
  `;
  return new Set(rows.map((row) => row.item_id));
}

/**
 * The newest runs a given requester started, read newest-first until the first
 * one whose resolver DID report: how many consecutive runs failed without a
 * single heartbeat, and when the newest of those was created.
 *
 * A run that failed with `heartbeat_at IS NULL` never got a working resolver at
 * all (a refused launch, a walled account, a crash before the first tool call).
 * Measured 2026-10-01: four scheduled runs in a row died that way while the
 * launch account sat at its session limit, one every 15 minutes, each costing a
 * resolver launch and re-seeding the same items (WI-10004887). The scheduled
 * launcher reads this to back off instead of repeating a launch that cannot work.
 */
export async function readConsecutiveNeverBeatRuns(input: {
  workspaceId?: string;
  kind?: BulkRunKind | null;
  requestedBy: string;
  /** How many recent runs to inspect. Default 10. */
  window?: number;
}): Promise<{ consecutive: number; newestCreatedAt: string | null }> {
  const { sql } = getOrgPg();
  const ws = input.workspaceId ?? activeWorkspaceId();
  const kind = input.kind === undefined ? DEFAULT_RUN_KIND : input.kind;
  const window = Math.max(1, Math.min(50, input.window ?? 10));
  const rows = await sql<{ phase: BulkRunPhase; heartbeat_at: Date | string | null; created_at: Date | string }[]>`
    SELECT phase, heartbeat_at, created_at
      FROM harness_shared.attention_bulk_runs
     WHERE workspace_id = ${ws}
       AND requested_by = ${input.requestedBy}
       AND (${kind ?? null}::text IS NULL OR run_kind = ${kind ?? null})
     ORDER BY created_at DESC
     LIMIT ${window}
  `;
  return countConsecutiveNeverBeat(
    rows.map((r) => ({ phase: r.phase, heartbeatAt: iso(r.heartbeat_at), createdAt: iso(r.created_at) })),
  );
}

/** PURE half of {@link readConsecutiveNeverBeatRuns}; rows newest-first. */
export function countConsecutiveNeverBeat(
  rows: ReadonlyArray<{ phase: BulkRunPhase; heartbeatAt: string | null; createdAt: string | null }>,
): { consecutive: number; newestCreatedAt: string | null } {
  let consecutive = 0;
  for (const row of rows) {
    // An executing run has not failed yet, and a run whose resolver ever beat
    // proves the launch route worked; either ends the streak.
    if (row.phase !== 'failed' || row.heartbeatAt) break;
    consecutive += 1;
  }
  return { consecutive, newestCreatedAt: consecutive > 0 ? (rows[0]?.createdAt ?? null) : null };
}

export async function getActiveRun(
  workspaceId?: string,
  kind: BulkRunKind | null = DEFAULT_RUN_KIND,
): Promise<BulkRunRow | null> {
  const { sql } = getOrgPg();
  const ws = workspaceId ?? activeWorkspaceId();
  const rows = await sql<RawRunRow[]>`
    SELECT ${sql.unsafe(RUN_COLUMNS)}
      FROM harness_shared.attention_bulk_runs
     WHERE workspace_id = ${ws} AND phase IN ('pending', 'running', 'review')
       AND (${kind ?? null}::text IS NULL OR run_kind = ${kind ?? null})
     ORDER BY created_at DESC
     LIMIT 1
  `;
  return rows[0] ? mapRun(rows[0]) : null;
}

/**
 * P-010's one pass-ending delivery seam.  Run mutation stays authoritative even
 * when notification rails are unavailable; replay is safe because the digest
 * derives deterministic inbox/attention keys from runId.
 */
async function deliverPassDigest(run: BulkRunRow | null): Promise<void> {
  if (!run || run.runKind !== 'inbox-resolve' || run.requestedBy !== UNATTENDED_BULK_REQUESTER) return;
  try {
    await deliverUnattendedRunOwnerDigest(run, await getRunItems(run.runId, run.workspaceId));
  } catch (error) {
    console.warn(
      `[bulk-run-store] unattended owner digest failed for ${run.runId}:`,
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * Move a run's phase. `started_at` is stamped on the first transition into
 * `running` and `finished_at` on any terminal phase, so duration is derivable
 * without the caller tracking it.
 *
 * `complete` is deliberately NOT settable here. It is the only phase that reads
 * as SUCCESS, so it has to be EARNED — derived from the run's own item/finding
 * rows by {@link settleRunPhase} via {@link deriveSettleOutcome}, never asserted
 * by a caller. Three pre-guard runs settled 'complete' with 100% of their items
 * still `pending` (WI-2104919, repaired by migration 1064); this type exclusion
 * is what keeps a future caller from quietly re-minting that shape. Tests that
 * must fabricate a terminal run use {@link unsafeSetRunPhaseForFixtures}.
 */
export async function setRunPhase(input: {
  runId: string;
  phase: Exclude<BulkRunPhase, 'complete'>;
  resolverOwner?: string | null;
  error?: string | null;
  workspaceId?: string;
}): Promise<BulkRunRow | null> {
  return writeRunPhase(input);
}

/**
 * TEST FIXTURES ONLY: the raw phase write without the earned-`complete`
 * exclusion. Production code must never complete a run directly — that is
 * {@link settleRunPhase}'s job (see {@link setRunPhase}'s doc for why). This
 * exists because fixtures legitimately need to fabricate historical shapes —
 * e.g. the watchdog test proves an already-terminal complete-with-pending run
 * is left alone, a shape production code can no longer produce.
 */
export async function unsafeSetRunPhaseForFixtures(input: {
  runId: string;
  phase: BulkRunPhase;
  resolverOwner?: string | null;
  error?: string | null;
  workspaceId?: string;
}): Promise<BulkRunRow | null> {
  return writeRunPhase(input);
}

async function writeRunPhase(input: {
  runId: string;
  phase: BulkRunPhase;
  resolverOwner?: string | null;
  error?: string | null;
  workspaceId?: string;
}): Promise<BulkRunRow | null> {
  const { sql } = getOrgPg();
  const ws = input.workspaceId ?? activeWorkspaceId();
  const terminal = TERMINAL_PHASES.includes(input.phase);
  const rows = await sql<RawRunRow[]>`
    UPDATE harness_shared.attention_bulk_runs
       SET phase = ${input.phase},
           resolver_owner = COALESCE(${input.resolverOwner ?? null}, resolver_owner),
           error = ${input.error ?? null},
           started_at = CASE WHEN ${input.phase === 'running'} AND started_at IS NULL
                             THEN now() ELSE started_at END,
           finished_at = CASE WHEN ${terminal} THEN now() ELSE finished_at END,
           updated_at = now()
     WHERE workspace_id = ${ws} AND run_id = ${input.runId}
    RETURNING ${sql.unsafe(RUN_COLUMNS)}
  `;
  const run = rows[0] ? mapRun(rows[0]) : null;
  if (run && ['review', 'complete', 'failed'].includes(run.phase)) {
    await deliverPassDigest(run);
  }
  return run;
}

/**
 * Fail a run because its resolver process ended, but ONLY while that process
 * can still own the run. The phase guard is the important part: a headless psu
 * normally outlives its first turn, so an eventual clean process exit may race
 * with `settleRunPhase`. A stale exit observer must never turn an already
 * reviewed/completed run back into `failed`.
 *
 * Returns the failed row when this call won, otherwise null (missing run or a
 * resolver/owner already settled it). This is intentionally one conditional
 * UPDATE rather than getRun → setRunPhase; the latter has a check/write race.
 */
export async function failRunIfExecuting(input: {
  runId: string;
  error: string;
  resolverOwner?: string | null;
  workspaceId?: string;
}): Promise<BulkRunRow | null> {
  const { sql } = getOrgPg();
  const ws = input.workspaceId ?? activeWorkspaceId();
  const rows = await sql<RawRunRow[]>`
    UPDATE harness_shared.attention_bulk_runs
       SET phase = 'failed',
           resolver_owner = COALESCE(resolver_owner, ${input.resolverOwner ?? null}),
           error = ${input.error.slice(0, 4000)},
           finished_at = now(),
           updated_at = now()
     WHERE workspace_id = ${ws}
       AND run_id = ${input.runId}
       AND phase IN ('pending', 'running')
       AND (${input.resolverOwner ?? null}::text IS NULL
            OR resolver_owner IS NULL
            OR resolver_owner = ${input.resolverOwner ?? null})
    RETURNING ${sql.unsafe(RUN_COLUMNS)}
  `;
  const run = rows[0] ? mapRun(rows[0]) : null;
  await deliverPassDigest(run);
  return run;
}

/**
 * How long a run may go without evidence of life before it reads as stale.
 *
 * Deliberately generous relative to any sane heartbeat cadence: the cost of calling a
 * working resolver stale (an owner restarts a run that was fine, losing in-flight work)
 * is far higher than the cost of noticing a dead one a minute later.
 */
export const RUN_HEARTBEAT_STALE_MS = 5 * 60_000;

/**
 * The longest a run may go without a RUN heartbeat while its resolver's other
 * activity keeps it alive (WI-10004887). Run tools beat on every manifest and
 * report, so a resolver that is busy for this long without touching one is not
 * advancing the run, however many other tool calls it makes.
 */
export const RESOLVER_ACTIVITY_MAX_SILENCE_MS = 30 * 60_000;

export type RunLiveness =
  /** Terminal, or `review` — the run is not executing, so liveness is not a question. */
  | { state: 'not-executing'; phase: BulkRunPhase }
  /** Executing and reporting. */
  | { state: 'live'; ageMs: number; measuredFrom: 'heartbeat' }
  /** Executing, but nothing has reported for longer than the threshold. */
  | { state: 'stale'; ageMs: number; measuredFrom: 'heartbeat' | 'start' };

/**
 * DERIVE whether an executing run is still alive. Never stored — see migration 945.
 *
 * ⚠ The subtlety worth keeping: staleness is measured from the last EVIDENCE OF LIFE,
 * which is `heartbeat_at` when the resolver has reported and the run's own start time
 * when it has not. Measuring a never-reported run from `heartbeat_at` alone would make
 * it either permanently stale (NULL reads as infinitely old) or permanently live (NULL
 * skipped) — the first restarts a run that launched two seconds ago and has not had a
 * chance to beat yet, the second never notices a resolver that died before its first
 * heartbeat. Both are real failures; COALESCE across the two is what avoids each.
 *
 * `measuredFrom` is reported rather than inferred so a caller (and an owner-facing
 * diagnostic) can say "never reported since launch" instead of the much weaker "stale",
 * which is the distinction the nullable column exists to preserve.
 */
export function classifyRunLiveness(
  run: Pick<BulkRunRow, 'phase' | 'heartbeatAt' | 'startedAt' | 'createdAt'>,
  nowMs: number = Date.now(),
  staleAfterMs: number = RUN_HEARTBEAT_STALE_MS,
): RunLiveness {
  if (!RUNNING_PHASES.includes(run.phase)) return { state: 'not-executing', phase: run.phase };

  const measuredFrom = run.heartbeatAt ? 'heartbeat' : 'start';
  const since = run.heartbeatAt ?? run.startedAt ?? run.createdAt;
  // No timestamp at all is not something a live row can produce (created_at is NOT
  // NULL); treat it as stale rather than inventing liveness we cannot evidence.
  if (!since) return { state: 'stale', ageMs: Number.POSITIVE_INFINITY, measuredFrom };

  const ageMs = nowMs - Date.parse(since);
  if (!Number.isFinite(ageMs)) return { state: 'stale', ageMs: Number.POSITIVE_INFINITY, measuredFrom };
  return ageMs > staleAfterMs
    ? { state: 'stale', ageMs, measuredFrom }
    : { state: 'live', ageMs, measuredFrom: 'heartbeat' };
}

/**
 * Record that the resolver owning this run is alive.
 *
 * Conditional on an EXECUTING phase, exactly like {@link failRunIfExecuting}: a
 * heartbeat arriving after the owner pressed Stop, or after the run settled, must not
 * resurrect any part of it. Returns `null` when it did not apply, which is the signal
 * the caller should stop — it means the run is no longer theirs.
 *
 * ⚠ Deliberately does NOT touch `updated_at`. A heartbeat is liveness, not a state
 * change, and `updated_at` is what readers key on to decide something happened; bumping
 * it every cadence would turn a silent keep-alive into a steady stream of spurious
 * "this run changed" signals through the sync layer.
 */
export async function recordRunHeartbeat(input: {
  runId: string;
  resolverOwner?: string | null;
  workspaceId?: string;
}): Promise<BulkRunRow | null> {
  const { sql } = getOrgPg();
  const ws = input.workspaceId ?? activeWorkspaceId();
  const rows = await sql<RawRunRow[]>`
    UPDATE harness_shared.attention_bulk_runs
       SET heartbeat_at = now(),
           resolver_owner = COALESCE(resolver_owner, ${input.resolverOwner ?? null})
     WHERE workspace_id = ${ws}
       AND run_id = ${input.runId}
       AND phase IN ('pending', 'running')
       AND (${input.resolverOwner ?? null}::text IS NULL
            OR resolver_owner IS NULL
            OR resolver_owner = ${input.resolverOwner ?? null})
    RETURNING ${sql.unsafe(RUN_COLUMNS)}
  `;
  return rows[0] ? mapRun(rows[0]) : null;
}

export type RestartRunResult =
  | { ok: true; run: BulkRunRow; preservedOutcomes: number }
  | { ok: false; reason: 'run_not_found' | 'not_restartable'; phase: BulkRunPhase | null };

export type ResumeReviewRunResult =
  | {
      ok: true;
      run: BulkRunRow;
      requeuedIds: string[];
      preservedOutcomes: number;
    }
  | {
      ok: false;
      reason: 'run_not_found' | 'not_in_review' | 'no_unresolved_items';
      phase: BulkRunPhase | null;
    };

/**
 * Selectively hand an OWNER-review run back to a fresh resolver generation.
 * This is deliberately distinct from restartRun: restart repairs a dead
 * executing process and never resets outcomes; resume is an explicit owner
 * decision that resets only named unresolved rows from review.
 */
export async function resumeReviewRun(input: {
  runId: string;
  itemIds: readonly string[];
  resolverOwner: string;
  workspaceId?: string;
}): Promise<ResumeReviewRunResult> {
  const { sql } = getOrgPg();
  const ws = input.workspaceId ?? activeWorkspaceId();
  const ids = [...new Set(input.itemIds.map((id) => id.trim()).filter(Boolean))];
  if (ids.length === 0) {
    const current = await getRun(input.runId, ws);
    return { ok: false, reason: 'no_unresolved_items', phase: current?.phase ?? null };
  }

  return await sql.begin(async (tx) => {
    const rows = await tx<RawRunRow[]>`
      SELECT ${tx.unsafe(RUN_COLUMNS)}
        FROM harness_shared.attention_bulk_runs
       WHERE workspace_id = ${ws} AND run_id = ${input.runId}
       FOR UPDATE
    `;
    if (!rows[0]) return { ok: false as const, reason: 'run_not_found' as const, phase: null };
    const current = mapRun(rows[0]);
    if (current.phase !== 'review') {
      return { ok: false as const, reason: 'not_in_review' as const, phase: current.phase };
    }

    let requeuedIds: string[] = [];
    if (current.runKind === 'plan-cleanup') {
      const updated = await tx<Array<{ finding_id: string }>>`
        UPDATE harness_shared.plan_cleanup_run_findings
           SET outcome = 'pending', error = NULL, decided_at = NULL, updated_at = now()
         WHERE workspace_id = ${ws} AND run_id = ${input.runId}
           AND finding_id = ANY(${ids})
           AND outcome NOT IN ('auto_applied', 'accepted', 'dismissed')
        RETURNING finding_id
      `;
      requeuedIds = updated.map((row) => row.finding_id);
      if (requeuedIds.length > 0) await recomputeCleanupCounters(tx, input.runId, ws);
    } else {
      const updated = await tx<Array<{ item_id: string }>>`
        UPDATE harness_shared.attention_bulk_run_items
           SET outcome = 'pending', action_id = NULL, rationale = NULL,
               draft_answer = NULL, confidence = NULL, consulted = FALSE,
               consult_reply = NULL, error = NULL, decided_at = NULL,
               disposition = 'pending', recommendation_kind = NULL,
               recommendation_label = NULL, recommendation_rationale = NULL,
               evidence_basis = '[]'::jsonb, responsibility = NULL,
               confidence_level = NULL, retry_condition = NULL,
               intake_decision = NULL,
               updated_at = now()
         WHERE workspace_id = ${ws} AND run_id = ${input.runId}
           AND item_id = ANY(${ids})
           AND outcome NOT IN ('auto_resolved', 'dismissed')
        RETURNING item_id
      `;
      requeuedIds = updated.map((row) => row.item_id);
      if (requeuedIds.length > 0) await recomputeCounters(tx, input.runId, ws);
    }
    if (requeuedIds.length === 0) {
      return { ok: false as const, reason: 'no_unresolved_items' as const, phase: current.phase };
    }

    const resumedRows = await tx<RawRunRow[]>`
      UPDATE harness_shared.attention_bulk_runs
         SET phase = 'pending', resolver_owner = ${input.resolverOwner}, error = NULL,
             finished_at = NULL, heartbeat_at = NULL, updated_at = now()
       WHERE workspace_id = ${ws} AND run_id = ${input.runId}
      RETURNING ${tx.unsafe(RUN_COLUMNS)}
    `;
    const preservedOutcomes =
      current.runKind === 'plan-cleanup'
        ? Number(
            (
              await tx<Array<{ count: number | string }>>`
          SELECT COUNT(*)::int AS count FROM harness_shared.plan_cleanup_run_findings
           WHERE workspace_id = ${ws} AND run_id = ${input.runId} AND outcome <> 'pending'
        `
            )[0]?.count ?? 0,
          )
        : Number(
            (
              await tx<Array<{ count: number | string }>>`
          SELECT COUNT(*)::int AS count FROM harness_shared.attention_bulk_run_items
           WHERE workspace_id = ${ws} AND run_id = ${input.runId} AND outcome <> 'pending'
        `
            )[0]?.count ?? 0,
          );
    return {
      ok: true as const,
      run: mapRun(resumedRows[0]!),
      requeuedIds,
      preservedOutcomes,
    };
  });
}

/**
 * Hand a stranded run to a fresh resolver WITHOUT losing what the previous one achieved.
 *
 * Three guarantees, each of which is a way this could go wrong:
 *
 * 1. ONLY a stale-executing or failed run is restartable. A healthy executing run is
 *    refused — restarting one would race a resolver that is still working and produce
 *    two agents acting on the same items. The staleness test lives INSIDE the UPDATE's
 *    WHERE clause rather than in a preceding read, so a resolver that beats between a
 *    check and a write wins the race and the restart cleanly does nothing.
 * 2. COMPLETED OUTCOMES ARE NEVER RESET. This function does not write to
 *    `attention_bulk_run_items` at all. Counters are recomputed from the surviving item
 *    rows by {@link reportCountersOnly}, so already-resolved items stay resolved and
 *    stay counted; only `outcome = 'pending'` items are left for the new resolver.
 * 3. MEMBERSHIP IS NEVER WIDENED — for the same reason `reportOutcomes` ignores unknown
 *    item ids: the run must keep acting on exactly what the owner saw when they clicked.
 *
 * The launch settings are NOT re-derived from current defaults: `launch_snapshot` stays
 * on the row untouched (D-003), so the restarted run relaunches with the owner's
 * click-time configuration rather than whatever the defaults happen to be now.
 */
export async function restartRun(input: {
  runId: string;
  resolverOwner?: string | null;
  workspaceId?: string;
  staleAfterMs?: number;
}): Promise<RestartRunResult> {
  const { sql } = getOrgPg();
  const ws = input.workspaceId ?? activeWorkspaceId();
  const staleSecs = Math.max(0, input.staleAfterMs ?? RUN_HEARTBEAT_STALE_MS) / 1000;

  const rows = await sql<RawRunRow[]>`
    UPDATE harness_shared.attention_bulk_runs
       SET phase = 'pending',
           resolver_owner = ${input.resolverOwner ?? null},
           error = NULL,
           finished_at = NULL,
           heartbeat_at = NULL,
           updated_at = now()
     WHERE workspace_id = ${ws}
       AND run_id = ${input.runId}
       AND (
             phase = 'failed'
             OR (
                  phase IN ('pending', 'running')
                  -- last evidence of life: the heartbeat, else when the run started.
                  -- Same COALESCE as classifyRunLiveness, and it must stay in step.
                  AND COALESCE(heartbeat_at, started_at, created_at)
                        < now() - make_interval(secs => ${staleSecs})
                )
           )
    RETURNING ${sql.unsafe(RUN_COLUMNS)}
  `;

  if (!rows[0]) {
    // Distinguish "no such run" from "refused because it is healthy" — an owner-facing
    // diagnostic must not report a live run as missing.
    const current = await getRun(input.runId, ws);
    return current
      ? { ok: false, reason: 'not_restartable', phase: current.phase }
      : { ok: false, reason: 'run_not_found', phase: null };
  }

  // Counters are DERIVED from the surviving item rows, so this both preserves completed
  // outcomes and re-states them correctly on the restarted run.
  await reportCountersOnly(input.runId, ws);
  const refreshed = (await getRun(input.runId, ws)) ?? mapRun(rows[0]);
  const items = await getRunItems(input.runId, ws);
  return {
    ok: true,
    run: refreshed,
    preservedOutcomes: items.filter((i) => i.outcome !== 'pending').length,
  };
}

/**
 * Record the resolver's outcomes for one or more items, then RECOMPUTE the run's
 * counters from the item rows.
 *
 * The recompute (rather than an increment) is the point: the resolver reports at
 * least once per item and may legitimately re-report one — an item first marked
 * `recommended` becomes `auto_resolved` when a consulted asker answers in time.
 * Incrementing would double-count that; deriving cannot.
 *
 * Unknown item ids are ignored rather than inserted: an outcome for an item that
 * is not in this run's snapshot is a resolver bug, and silently widening the run
 * would break the "acts on exactly what the owner saw" guarantee.
 */
export async function reportOutcomes(input: {
  runId: string;
  outcomes: BulkOutcomeReport[];
  resolverOwner?: string | null;
  workspaceId?: string;
}): Promise<{
  updated: string[];
  unknown: string[];
  run: BulkRunRow | null;
  refused:
    | { reason: 'run_not_accepting_reports'; phase: BulkRunPhase | null }
    | { reason: 'resolver_owner_mismatch'; phase: BulkRunPhase }
    | null;
}> {
  const { sql } = getOrgPg();
  const ws = input.workspaceId ?? activeWorkspaceId();
  // WI-41013/WI-41022 — the stop rail. The owner's Stop settles the run; the resolver is
  // a separate process and may not have noticed yet. Refuse its writes rather
  // than letting them land, so a stopped run cannot keep growing.
  //
  // REFUSE, never silently drop: the resolver has usually ALREADY performed the
  // terminal action it is reporting, so swallowing the write would leave it
  // believing the action was recorded when the record shows nothing. A refusal
  // it can read is what lets it stop instead of continuing down the manifest.
  //
  // This is a backstop, not the whole fix: it bounds the DAMAGE (no further
  // writes) but cannot un-take an action already taken, which is why the
  // manifest also reports `stopped` so a well-behaved resolver halts first.
  return await sql.begin(async (tx) => {
    const updated: string[] = [];
    const unknown: string[] = [];
    const runRows = await tx<RawRunRow[]>`
      SELECT ${tx.unsafe(RUN_COLUMNS)}
        FROM harness_shared.attention_bulk_runs
       WHERE workspace_id = ${ws} AND run_id = ${input.runId}
       FOR UPDATE
    `;
    const before = runRows[0] ? mapRun(runRows[0]) : null;
    if (before && input.resolverOwner && before.resolverOwner !== input.resolverOwner) {
      return {
        updated: [],
        unknown: (input.outcomes ?? []).map((o) => o?.itemId).filter((id): id is string => !!id),
        run: before,
        refused: { reason: 'resolver_owner_mismatch' as const, phase: before.phase },
      };
    }
    if (before && !ACCEPTING_REPORTS.includes(before.phase)) {
      return {
        updated: [],
        unknown: (input.outcomes ?? []).map((o) => o?.itemId).filter((id): id is string => !!id),
        run: before,
        refused: { reason: 'run_not_accepting_reports' as const, phase: before.phase },
      };
    }

    for (const o of input.outcomes ?? []) {
      if (!o?.itemId) continue;
      const disposition = dispositionForReport(o);
      const revertHandle =
        o.outcome === 'auto_resolved'
          ? serializedRevertHandle(
              attentionBulkItemRevertHandle({ workspaceId: ws, runId: input.runId, itemId: o.itemId }),
              `reportOutcomes(${input.runId}/${o.itemId})`,
            )
          : null;
      const rows = await tx<{ item_id: string }[]>`
      UPDATE harness_shared.attention_bulk_run_items
         SET outcome = ${o.outcome},
             action_id = ${o.actionId ?? null},
             rationale = ${o.rationale ?? null},
             draft_answer = ${o.draftAnswer ?? null},
             confidence = ${o.confidence ?? null},
             consulted = ${o.consulted === true},
             consult_reply = ${o.consultReply ?? null},
             disposition = ${disposition},
             recommendation_kind = ${o.recommendationKind ?? null},
             recommendation_label = ${o.recommendationLabel ?? null},
             recommendation_rationale = ${o.recommendationRationale ?? o.rationale ?? null},
             evidence_basis = ${JSON.stringify(o.evidenceBasis ?? [])}::jsonb,
             responsibility = ${o.responsibility ?? null},
             confidence_level = ${o.confidenceLevel ?? (o.confidence === 'high' ? 'high' : o.confidence === 'low' ? 'low' : null)},
             retry_condition = ${o.retryCondition ?? null},
             intake_decision = ${o.intakeDecision ? JSON.stringify(o.intakeDecision) : null}::jsonb,
             error = ${o.error ?? null},
             decided_at = now(),
             revert_handle = CASE
               WHEN ${o.outcome} = 'auto_resolved' THEN ${revertHandle}::jsonb
               ELSE revert_handle
             END,
             reversal_window_until = CASE
               WHEN ${o.outcome} = 'auto_resolved'
                 THEN now() + make_interval(hours => ${BULK_ITEM_REVERSAL_WINDOW_HOURS})
               ELSE reversal_window_until
             END,
             reverted_at = CASE WHEN ${o.outcome} = 'auto_resolved' THEN NULL ELSE reverted_at END,
             revert_note = CASE WHEN ${o.outcome} = 'auto_resolved' THEN NULL ELSE revert_note END,
             updated_at = now()
       WHERE workspace_id = ${ws} AND run_id = ${input.runId} AND item_id = ${o.itemId}
      RETURNING item_id
    `;
      if (rows[0]) updated.push(rows[0].item_id);
      else unknown.push(o.itemId);
    }

    await recomputeCounters(tx, input.runId, ws);
    const afterRows = await tx<RawRunRow[]>`
      SELECT ${tx.unsafe(RUN_COLUMNS)}
        FROM harness_shared.attention_bulk_runs
       WHERE workspace_id = ${ws} AND run_id = ${input.runId}
    `;
    return { updated, unknown, run: afterRows[0] ? mapRun(afterRows[0]) : null, refused: null };
  });
}

/**
 * Materialize the deterministic P-001 classification onto legacy skipped rows.
 * This is an audited metadata-only operation: the original `outcome`, run
 * membership, and every terminal outcome remain unchanged. It exists so an old
 * run (including the owner's 158-item run) gains the same typed recommendation
 * fields as a new run without requiring a second resolver pass.
 */
export async function reclassifyLegacySkipped(input: {
  runId: string;
  itemIds?: readonly string[];
  workspaceId?: string;
}): Promise<{
  updated: BulkRunItemRow[];
  run: BulkRunRow | null;
  refused: 'run_not_found' | 'not_in_review' | null;
}> {
  const { sql } = getOrgPg();
  const ws = input.workspaceId ?? activeWorkspaceId();
  const requested = [...new Set((input.itemIds ?? []).map((id) => id.trim()).filter(Boolean))];
  return await sql.begin(async (tx) => {
    const runRows = await tx<RawRunRow[]>`
      SELECT ${tx.unsafe(RUN_COLUMNS)}
        FROM harness_shared.attention_bulk_runs
       WHERE workspace_id = ${ws} AND run_id = ${input.runId}
       FOR UPDATE
    `;
    if (!runRows[0]) return { updated: [], run: null, refused: 'run_not_found' as const };
    const run = mapRun(runRows[0]);
    if (run.phase !== 'review') return { updated: [], run, refused: 'not_in_review' as const };
    const rows = await tx<RawItemRow[]>`
      SELECT ${tx.unsafe(ITEM_COLUMNS)}
        FROM harness_shared.attention_bulk_run_items
       WHERE workspace_id = ${ws} AND run_id = ${input.runId}
         AND outcome = 'skipped'
         AND (disposition IS NULL OR disposition IN ('legacy_skipped', 'skipped'))
         AND (${requested.length === 0} OR item_id = ANY(${requested}))
       ORDER BY position ASC
       FOR UPDATE
    `;
    const updated: BulkRunItemRow[] = [];
    for (const row of rows) {
      const classified = canonicalDispositionForRow({
        outcome: row.outcome,
        disposition: 'legacy_skipped',
        itemKind: row.item_kind,
        title: row.item_title,
        error: row.error,
        rationale: row.rationale,
        itemId: row.item_id,
      });
      const rec = classified.recommendation;
      if (!rec) continue;
      const changed = await tx<RawItemRow[]>`
        UPDATE harness_shared.attention_bulk_run_items
           SET disposition = ${classified.disposition},
               recommendation_kind = ${rec.kind},
               recommendation_label = ${rec.label},
               recommendation_rationale = ${rec.rationale},
               evidence_basis = ${JSON.stringify(rec.evidenceBasis)}::jsonb,
               responsibility = ${rec.responsibility},
               confidence_level = ${rec.confidence},
               retry_condition = ${rec.retryCondition ?? null},
               updated_at = now()
         WHERE workspace_id = ${ws} AND run_id = ${input.runId} AND item_id = ${row.item_id}
        RETURNING ${tx.unsafe(ITEM_COLUMNS)}
      `;
      if (changed[0]) updated.push(mapItem(changed[0]));
    }
    const refreshed = await tx<RawRunRow[]>`
      SELECT ${tx.unsafe(RUN_COLUMNS)}
        FROM harness_shared.attention_bulk_runs
       WHERE workspace_id = ${ws} AND run_id = ${input.runId}
    `;
    return {
      updated,
      run: refreshed[0] ? mapRun(refreshed[0]) : run,
      refused: null,
    };
  });
}

/**
 * Items still awaiting the OWNER. A resolver report is not an owner decision:
 * recommended, skipped, failed and never-reached rows all remain review work
 * until the owner resolves, retries, or explicitly dismisses them.
 */
export async function getPendingReviewItems(runId: string, workspaceId?: string): Promise<BulkRunItemRow[]> {
  const items = await getRunItems(runId, workspaceId);
  return items.filter((i) => i.outcome !== 'auto_resolved' && i.outcome !== 'dismissed');
}

/**
 * Mark one recommended item as accepted by the owner — it becomes
 * `auto_resolved` with the audit trail naming the owner as the actor, because
 * from the record's point of view the resolution did happen, and hiding who
 * performed it would defeat the audit requirement.
 */
export async function markItemAccepted(input: {
  runId: string;
  itemId: string;
  actionId: string;
  note?: string | null;
  workspaceId?: string;
}): Promise<BulkRunItemRow | null> {
  const { sql } = getOrgPg();
  const ws = input.workspaceId ?? activeWorkspaceId();
  const revertHandle = serializedRevertHandle(
    attentionBulkItemRevertHandle({ workspaceId: ws, runId: input.runId, itemId: input.itemId }),
    `markItemAccepted(${input.runId}/${input.itemId})`,
  );
  return await sql.begin(async (tx) => {
    // Owner review writes are admitted only while the run is actually awaiting
    // owner work. Without the shared row lock a late/manual reconciliation can
    // rewrite an executing generation or an already-settled audit record.
    const runs = await tx<Array<{ phase: BulkRunPhase; run_kind: BulkRunKind | null }>>`
      SELECT phase, run_kind
        FROM harness_shared.attention_bulk_runs
       WHERE workspace_id = ${ws} AND run_id = ${input.runId}
       FOR UPDATE
    `;
    if (!runs[0] || runs[0].phase !== 'review' || (runs[0].run_kind ?? DEFAULT_RUN_KIND) !== 'inbox-resolve') {
      return null;
    }
    const rows = await tx<RawItemRow[]>`
      UPDATE harness_shared.attention_bulk_run_items
         SET outcome = 'auto_resolved',
             action_id = ${input.actionId},
             disposition = 'auto_resolved',
             rationale = COALESCE(${input.note ?? null}, rationale),
             decided_at = now(),
             revert_handle = ${revertHandle}::jsonb,
             reversal_window_until = now() + make_interval(hours => ${BULK_ITEM_REVERSAL_WINDOW_HOURS}),
             reverted_at = NULL,
             revert_note = NULL,
             updated_at = now()
       WHERE workspace_id = ${ws} AND run_id = ${input.runId} AND item_id = ${input.itemId}
         AND outcome NOT IN ('auto_resolved', 'dismissed')
      RETURNING ${tx.unsafe(ITEM_COLUMNS)}
    `;
    if (!rows[0]) return null;
    // Keep the run counters honest in the same transaction as the disposition.
    await recomputeCounters(tx, input.runId, ws);
    return mapItem(rows[0]);
  });
}

/**
 * Record the OWNER deliberately declining one unresolved Inbox row. Resolver
 * `skipped` is evidence that the resolver could not act; it is not permission
 * to silently count the row as complete. This distinct outcome is what lets
 * settlement tell those states apart without overloading the resolver verdict.
 */
export async function markItemDismissed(input: {
  runId: string;
  itemId: string;
  note?: string | null;
  workspaceId?: string;
}): Promise<BulkRunItemRow | null> {
  const { sql } = getOrgPg();
  const ws = input.workspaceId ?? activeWorkspaceId();
  return await sql.begin(async (tx) => {
    const runs = await tx<Array<{ phase: BulkRunPhase; run_kind: BulkRunKind | null }>>`
      SELECT phase, run_kind
        FROM harness_shared.attention_bulk_runs
       WHERE workspace_id = ${ws} AND run_id = ${input.runId}
       FOR UPDATE
    `;
    if (!runs[0] || runs[0].phase !== 'review' || (runs[0].run_kind ?? DEFAULT_RUN_KIND) !== 'inbox-resolve') {
      return null;
    }
    const rows = await tx<RawItemRow[]>`
      UPDATE harness_shared.attention_bulk_run_items
         SET outcome = 'dismissed',
             disposition = 'dismissed',
             rationale = COALESCE(${input.note?.trim() || null}, rationale),
             error = NULL,
             decided_at = now(),
             updated_at = now()
       WHERE workspace_id = ${ws} AND run_id = ${input.runId} AND item_id = ${input.itemId}
         AND outcome NOT IN ('auto_resolved', 'dismissed')
      RETURNING ${tx.unsafe(ITEM_COLUMNS)}
    `;
    if (!rows[0]) return null;
    await recomputeCounters(tx, input.runId, ws);
    return mapItem(rows[0]);
  });
}

/** Recompute a run's counters from its item rows without reporting an outcome. */
export async function reportCountersOnly(runId: string, workspaceId?: string): Promise<void> {
  const { sql } = getOrgPg();
  const ws = workspaceId ?? activeWorkspaceId();
  await recomputeCounters(sql, runId, ws);
}

/**
 * The settle decision, split out PURE so the rule is testable without a ctx, PG
 * or a live resolver — the same convention as attention/sources.ts.
 *
 * `complete` is the only outcome that reads as SUCCESS, so it is the one that
 * has to be earned. Two ways a run can reach "nothing is awaiting the owner"
 * without having done anything, both of which used to settle `complete`:
 *
 *  1. EMPTY STATE SET. `[].some()` is `false`, so a run with no rows at all fell
 *     straight through to `complete` — a run whose membership never
 *     materialized reported itself as successfully finished, indistinguishable
 *     from one that genuinely settled every row. The empty set means DIFFERENT
 *     things per kind, so this is deliberately not one rule:
 *       - `inbox-resolve`: createRun seeds the whole membership snapshot in the
 *         SAME transaction as the run row and refuses a zero-item run outright,
 *         so zero rows here is impossible-by-construction — the manifest was
 *         lost, or we are reading a different scope. Never success.
 *       - `plan-cleanup`: findings ACCRUE during the run, so zero findings is
 *         the legitimate "scanned it, nothing to clean" result — provided the
 *         resolver actually ran, which is what (2) establishes.
 *  2. NO EVIDENCE OF LIFE. A run that recorded nothing AND never once beat its
 *     heartbeat has not demonstrated that it scanned anything, so "nothing to
 *     do" cannot be distinguished from "never started". Both resolver tool
 *     paths (inbox/bulk-run.ts, plans/cleanup-run.ts) heartbeat before they
 *     settle, so this never fires on a working run; it fires on the dead one.
 *
 * Refusing settles the run `failed` with a specific reason rather than minting a
 * new phase: `failed` already frees the single-flight slot and is restartable,
 * and the reason string is what makes an abandoned run distinguishable from a
 * genuine failure without a migration or a new vocabulary every reader must
 * learn (plan autonomous-inbox-resolution-2026-08-31 D-003, D-007).
 *
 * This matters far more once runs are UNATTENDED: a scheduled pass that dies
 * before doing anything and reports `complete` is a silent no-op that looks
 * healthy, which is exactly the failure a schedule cannot afford.
 * (EI-22013650201095388.)
 */
export function deriveSettleOutcome(input: {
  runKind: BulkRunKind;
  /** Every state row for the run — item outcomes, or plan-cleanup findings. */
  outcomes: readonly string[];
  /** Has the resolver ever reported life for this run? */
  everReportedLife: boolean;
  /**
   * The caller itself just completed a full scan of the run's seed plans
   * in-process (the deterministic plan-cleanup pass). That IS the evidence of
   * life rule (2) asks for: the scan ran, so zero findings means "nothing to
   * clean", not "never started". Without it a clean scan settled `failed`,
   * because the deterministic pass settles before any resolver exists to beat
   * the heartbeat (WI-10004729). Honoured for `plan-cleanup` only — an inbox
   * run's empty set is impossible-by-construction regardless of who settles.
   */
  scanCompleted?: boolean;
}): { phase: BulkRunPhase; refusedReason: string | null } {
  const { runKind, outcomes } = input;
  const everReportedLife = input.everReportedLife || (runKind === 'plan-cleanup' && input.scanCompleted === true);
  const terminal =
    runKind === 'plan-cleanup' ? ['auto_applied', 'accepted', 'dismissed'] : ['auto_resolved', 'dismissed'];
  const awaitingOwner = outcomes.some((o) => !terminal.includes(o));
  const recordedNothing = outcomes.length === 0;

  if (recordedNothing && runKind !== 'plan-cleanup') {
    return {
      phase: 'failed',
      refusedReason:
        'settle refused: this inbox run has zero item rows. Its membership snapshot is seeded in the same transaction as the run row and a zero-item run is refused at creation, so an empty set means the manifest was lost — never that every row settled.',
    };
  }
  if (recordedNothing && !everReportedLife) {
    return {
      phase: 'failed',
      refusedReason:
        'settle refused: this run recorded no outcomes and never reported a heartbeat, so there is no evidence the resolver ran. "Nothing to do" is not distinguishable from "never started" here.',
    };
  }
  return { phase: awaitingOwner ? 'review' : 'complete', refusedReason: null };
}

/**
 * Close out a run: `review` when recommendations are waiting for the owner,
 * `complete` when nothing is left to act on. Derived from the item rows rather
 * than trusted from the caller, so a resolver that miscounts cannot park the
 * pane in a review state with an empty list (or, worse, mark a run complete
 * while items still need the owner).
 *
 * The `complete`-vs-refuse rule itself lives in {@link deriveSettleOutcome}.
 */
export async function settleRunPhase(input: {
  runId: string;
  resolverOwner?: string | null;
  workspaceId?: string;
  /** See {@link deriveSettleOutcome}: the caller completed a full in-process scan. */
  scanCompleted?: boolean;
}): Promise<BulkRunRow | null> {
  const { sql } = getOrgPg();
  const ws = input.workspaceId ?? activeWorkspaceId();
  const run = await sql.begin(async (tx) => {
    const locked = await tx<RawRunRow[]>`
      SELECT ${tx.unsafe(RUN_COLUMNS)}
        FROM harness_shared.attention_bulk_runs
       WHERE workspace_id = ${ws} AND run_id = ${input.runId}
       FOR UPDATE
    `;
    if (!locked[0]) return null;
    const lockedRun = mapRun(locked[0]);
    if (input.resolverOwner && lockedRun.resolverOwner !== input.resolverOwner) {
      return null;
    }
    // Kind-aware "is anything still waiting on the OWNER?": inbox runs derive
    // from their item rows; plan-cleanup runs from their findings rows
    // (migration 937 — same recommended/pending semantics, different table).
    const runKind = locked[0].run_kind ?? DEFAULT_RUN_KIND;
    const states =
      runKind === 'plan-cleanup'
        ? await tx<{ outcome: string }[]>`
            SELECT outcome
              FROM harness_shared.plan_cleanup_run_findings
             WHERE workspace_id = ${ws} AND run_id = ${input.runId}
          `
        : await tx<{ outcome: string }[]>`
            SELECT outcome
              FROM harness_shared.attention_bulk_run_items
             WHERE workspace_id = ${ws} AND run_id = ${input.runId}
          `;
    // `complete` is the only SUCCESS outcome, so it has to be earned: an empty
    // state set or a run that never reported life settles `failed` with a
    // reason instead of silently reading as finished (EI-22013650201095388).
    const { phase, refusedReason } = deriveSettleOutcome({
      runKind,
      outcomes: states.map((i) => i.outcome),
      everReportedLife: locked[0].heartbeat_at != null,
      scanCompleted: input.scanCompleted,
    });
    const rows = await tx<RawRunRow[]>`
      UPDATE harness_shared.attention_bulk_runs
         SET phase = ${phase},
             resolver_owner = COALESCE(resolver_owner, ${input.resolverOwner ?? null}),
             error = ${refusedReason},
             -- Review ends the resolver pass even though the owner workflow
             -- remains open. Stamp it so elapsed time stops growing forever.
             finished_at = now(),
             updated_at = now()
       WHERE workspace_id = ${ws} AND run_id = ${input.runId}
      RETURNING ${tx.unsafe(RUN_COLUMNS)}
    `;
    return rows[0] ? mapRun(rows[0]) : null;
  });
  await deliverPassDigest(run);
  return run;
}

/* ── P-002: the watchdog's two reads and its one write ────────────────────────
 *
 * The decision logic lives in `bulk-run-watchdog.ts` (pure). These are the DB
 * halves it injects. Both handle BOTH run kinds: an `inbox-resolve` run records
 * outcomes in `attention_bulk_run_items`, a `plan-cleanup` run in
 * `plan_cleanup_run_findings`, and the counter-drift case that motivated this
 * item (`bulk-7d35ee41` — counters claiming 5 auto + 19 recommended against ZERO
 * rows) is a cleanup run, so a read that covered only the items table would miss
 * exactly the population it was written for.
 */

/** One run's facts for the watchdog, with counters DERIVED from its own rows. */
export interface WatchdogRunRow {
  runId: string;
  runKind: BulkRunKind;
  phase: BulkRunPhase;
  heartbeatAt: string | null;
  startedAt: string | null;
  createdAt: string | null;
  /** The resolver's coord ownerId, whose own activity is a second witness of life. */
  resolverOwner: string | null;
  undecided: number;
  stored: { autoResolved: number; recommended: number; skipped: number; failed: number };
  derived: { autoResolved: number; recommended: number; skipped: number; failed: number };
}

/**
 * Read the runs worth examining: everything still EXECUTING (any age — a run
 * stuck in `running` is the whole point) plus anything touched recently, so a
 * terminal run whose counters are wrong is still reachable for reconciliation
 * without scanning the full history every tick.
 */
export async function readWatchdogRunRows(input?: {
  workspaceId?: string;
  /** How far back to look for non-executing runs. Default 7 days. */
  lookbackMs?: number;
  limit?: number;
}): Promise<WatchdogRunRow[]> {
  const { sql } = getOrgPg();
  const ws = input?.workspaceId ?? activeWorkspaceId();
  const lookbackSecs = Math.max(0, input?.lookbackMs ?? 7 * 24 * 60 * 60_000) / 1000;
  const limit = Math.max(1, Math.min(500, input?.limit ?? 200));

  const rows = await sql<
    Array<{
      run_id: string;
      run_kind: BulkRunKind;
      phase: BulkRunPhase;
      heartbeat_at: Date | string | null;
      started_at: Date | string | null;
      created_at: Date | string | null;
      resolver_owner: string | null;
      auto_resolved: number;
      recommended: number;
      skipped: number;
      failed: number;
      d_undecided: number;
      d_auto: number;
      d_recommended: number;
      d_skipped: number;
      d_failed: number;
    }>
  >`
    SELECT r.run_id, r.run_kind, r.phase, r.heartbeat_at, r.started_at, r.created_at,
           r.resolver_owner,
           r.auto_resolved, r.recommended, r.skipped, r.failed,
           COALESCE(i.undecided, f.undecided, 0)::int      AS d_undecided,
           COALESCE(i.auto_resolved, f.auto_resolved, 0)::int AS d_auto,
           COALESCE(i.recommended, f.recommended, 0)::int  AS d_recommended,
           COALESCE(i.skipped, f.skipped, 0)::int          AS d_skipped,
           COALESCE(i.failed, f.failed, 0)::int            AS d_failed
      FROM harness_shared.attention_bulk_runs r
      -- The two legs mirror recomputeCounters / recomputeCleanupCounters EXACTLY.
      -- They are the definition of the stored columns, so any divergence here
      -- would report drift the reconcile then "fixes" back to the wrong value.
      LEFT JOIN LATERAL (
        SELECT COUNT(*) FILTER (WHERE outcome = 'pending')::int       AS undecided,
               COUNT(*) FILTER (WHERE outcome = 'auto_resolved')::int AS auto_resolved,
               COUNT(*) FILTER (WHERE outcome = 'recommended')::int   AS recommended,
               COUNT(*) FILTER (WHERE outcome IN ('skipped', 'dismissed'))::int AS skipped,
               COUNT(*) FILTER (WHERE outcome = 'failed')::int        AS failed
          FROM harness_shared.attention_bulk_run_items
         WHERE workspace_id = r.workspace_id AND run_id = r.run_id
      ) i ON r.run_kind <> 'plan-cleanup'
      LEFT JOIN LATERAL (
        SELECT COUNT(*) FILTER (WHERE outcome = 'pending')::int AS undecided,
               COUNT(*) FILTER (WHERE outcome IN ('auto_applied', 'accepted'))::int AS auto_resolved,
               COUNT(*) FILTER (WHERE outcome = 'recommended')::int AS recommended,
               COUNT(*) FILTER (WHERE outcome IN ('dismissed', 'skipped'))::int AS skipped,
               COUNT(*) FILTER (WHERE outcome = 'failed')::int AS failed
          FROM harness_shared.plan_cleanup_run_findings
         WHERE workspace_id = r.workspace_id AND run_id = r.run_id
      ) f ON r.run_kind = 'plan-cleanup'
     WHERE r.workspace_id = ${ws}
       AND (
             r.phase IN ('pending', 'running')
             OR r.updated_at > now() - make_interval(secs => ${lookbackSecs})
           )
     ORDER BY r.created_at DESC
     LIMIT ${limit}
  `;

  return rows.map((r) => ({
    runId: r.run_id,
    runKind: r.run_kind,
    phase: r.phase,
    heartbeatAt: iso(r.heartbeat_at),
    startedAt: iso(r.started_at),
    createdAt: iso(r.created_at),
    resolverOwner: r.resolver_owner ?? null,
    undecided: Number(r.d_undecided ?? 0),
    stored: {
      autoResolved: Number(r.auto_resolved ?? 0),
      recommended: Number(r.recommended ?? 0),
      skipped: Number(r.skipped ?? 0),
      failed: Number(r.failed ?? 0),
    },
    derived: {
      autoResolved: Number(r.d_auto ?? 0),
      recommended: Number(r.d_recommended ?? 0),
      skipped: Number(r.d_skipped ?? 0),
      failed: Number(r.d_failed ?? 0),
    },
  }));
}

/** Recompute one run's stored counters from its own rows, whichever table holds them. */
export async function reconcileRunCounters(runId: string, workspaceId?: string): Promise<void> {
  const { sql } = getOrgPg();
  const ws = workspaceId ?? activeWorkspaceId();
  const run = await getRun(runId, ws);
  if (!run) return;
  if (run.runKind === 'plan-cleanup') await recomputeCleanupCounters(sql, runId, ws);
  else await recomputeCounters(sql, runId, ws);
}

/**
 * Fail a STRANDED run and mark its never-decided items, so abandoned work stops
 * being indistinguishable from work the resolver has not reached yet.
 *
 * Three properties worth stating, because each is a way this could go wrong:
 *
 * 1. THE STALENESS TEST IS IN THE WRITE, not in a preceding read — the same
 *    discipline `restartRun` uses. A resolver that heartbeats between the
 *    watchdog's decision and this UPDATE wins the race, the WHERE matches
 *    nothing, and the strand cleanly does nothing (`marked: 0`). Checking first
 *    and writing after would abandon a resolver that had just come back.
 * 2. DECIDED OUTCOMES ARE NEVER TOUCHED. Only `outcome = 'pending'` rows move,
 *    so everything the dead resolver actually achieved survives — and survives a
 *    later `restartRun`, which does not write the items table at all.
 * 3. FAILING IS RECOVERABLE. `restartRun` explicitly accepts `phase = 'failed'`,
 *    so this hands the run to the owner (or to P-009's scheduler) in a state that
 *    can resume, rather than deleting it or silently leaving it 'running' forever.
 */
export async function strandStaleRun(input: {
  runId: string;
  reason: string;
  workspaceId?: string;
  staleAfterMs?: number;
  /** Ceiling on the resolver-activity rescue; default RESOLVER_ACTIVITY_MAX_SILENCE_MS. */
  resolverMaxSilenceMs?: number;
}): Promise<{ marked: number; phase: BulkRunPhase | null }> {
  const { sql } = getOrgPg();
  const ws = input.workspaceId ?? activeWorkspaceId();
  const staleSecs = Math.max(0, input.staleAfterMs ?? RUN_HEARTBEAT_STALE_MS) / 1000;
  const maxSilenceSecs =
    Math.max(0, input.resolverMaxSilenceMs ?? RESOLVER_ACTIVITY_MAX_SILENCE_MS) / 1000;

  return await sql.begin(async (tx) => {
    const claimed = await tx<Array<{ run_id: string; run_kind: BulkRunKind; phase: BulkRunPhase }>>`
      UPDATE harness_shared.attention_bulk_runs AS r
         SET phase = 'failed',
             error = ${input.reason},
             finished_at = now(),
             updated_at = now()
       WHERE r.workspace_id = ${ws}
         AND r.run_id = ${input.runId}
         AND r.phase IN ('pending', 'running')
         -- Same COALESCE as classifyRunLiveness and restartRun; these three must
         -- stay in step or a run reads stale to one and live to another.
         AND COALESCE(r.heartbeat_at, r.started_at, r.created_at)
               < now() - make_interval(secs => ${staleSecs})
         -- WI-10004887: the resolver's own activity is a second witness of life.
         -- It is re-checked HERE, not only in the watchdog's read, so a resolver
         -- that acts between that read and this write wins the race exactly as a
         -- heartbeat does. Mirrors resolverKeepsRunAlive (bulk-run-watchdog.ts):
         -- activity within the heartbeat threshold, and the run's own last beat
         -- within the silence ceiling, so a resolver busy on unrelated work cannot
         -- hold a run open forever. Both activity sources are the ones
         -- fetchWakeability reads for coord:presence.
         AND NOT (
               r.resolver_owner IS NOT NULL
               AND COALESCE(r.heartbeat_at, r.started_at, r.created_at)
                     >= now() - make_interval(secs => ${maxSilenceSecs})
               AND (
                     EXISTS (
                       SELECT 1 FROM harness_shared.tool_invocations ti
                        WHERE ti.coord_owner_id = r.resolver_owner
                          AND ti.invoked_at >= now() - make_interval(secs => ${staleSecs})
                     )
                     -- COALESCE is load-bearing: with no agent_activity row the
                     -- scalar subquery is NULL, so (false OR NULL) is NULL, NOT(NULL)
                     -- fails the WHERE, and a resolver that NEVER acted protected its
                     -- run for the whole silence ceiling (measured 2026-10-01 on
                     -- bulk-e6dc3abf: refused every sweep with zero activity rows).
                     OR COALESCE((
                       SELECT aa.created_at FROM harness_shared.agent_activity aa
                        WHERE aa.owner_id = r.resolver_owner
                        ORDER BY aa.id DESC
                        LIMIT 1
                     ), '-infinity'::timestamptz) >= now() - make_interval(secs => ${staleSecs})
                   )
             )
      RETURNING r.run_id, r.run_kind, r.phase
    `;
    if (!claimed[0]) return { marked: 0, phase: null };

    const marked =
      claimed[0].run_kind === 'plan-cleanup'
        ? await tx<Array<{ finding_id: string }>>`
            UPDATE harness_shared.plan_cleanup_run_findings
               SET outcome = 'failed',
                   disposition = 'failed',
                   recommendation_kind = COALESCE(recommendation_kind, 'retry_needed'),
                   retry_condition = COALESCE(retry_condition, 'restart the run'),
                   error = ${input.reason},
                   decided_at = now(),
                   updated_at = now()
             WHERE workspace_id = ${ws} AND run_id = ${input.runId} AND outcome = 'pending'
            RETURNING finding_id
          `
        : await tx<Array<{ item_id: string }>>`
            UPDATE harness_shared.attention_bulk_run_items
               SET outcome = 'failed',
                   disposition = 'failed',
                   -- The honest next step for an abandoned item is a retry, and
                   -- saying so here is what lets the owner's report distinguish
                   -- "the resolver judged this unresolvable" from "nobody looked".
                   recommendation_kind = COALESCE(recommendation_kind, 'retry_needed'),
                   retry_condition = COALESCE(retry_condition, 'restart the run'),
                   error = ${input.reason},
                   decided_at = now(),
                   updated_at = now()
             WHERE workspace_id = ${ws} AND run_id = ${input.runId} AND outcome = 'pending'
            RETURNING item_id
          `;

    if (claimed[0].run_kind === 'plan-cleanup') await recomputeCleanupCounters(tx, input.runId, ws);
    else await recomputeCounters(tx, input.runId, ws);

    return { marked: marked.length, phase: 'failed' as const };
  });
}
