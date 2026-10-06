/**
 * engineer_issues store — the agent-facing issue surface (engineer-issues-2026-06-03, Phase 1).
 *
 * A separate table from the validator pipeline (harness_issues_consolidated). It rides the
 * coordination substrate (migration 123) for the shared capabilities:
 *   - Taggable    → topic tags (PgTaggableStore, coord_links rel='tagged')
 *   - Threadable  → comment timeline (PgThreadStore, coord_threads/_posts)
 *   - Subscribable→ followers (PgEntitySubscriptionStore, coord_entity_subscriptions)
 *   - Linkable    → blocking/relates edges (PgLinkStore, coord_links) — Phase 2
 *   - Claimable   → `assignee` scalar (here)
 *   - Lifecycle   → `state` scalar (here; open|resolved|closed)
 *
 * Every mutation fans out to the issue's subscribers (direct ∪ topic) via the local
 * fan-out (fanoutForObject) — D-009 v1 is workspace-local; harness-scoped federation is
 * the deferred upgrade (a capture trigger + peer-log projection).
 *
 * ObjectRef: kind 'issue', ref the GLOBALLY-unique 'EI-<n>' id (distinct from the
 * pipeline's per-harness 'I-NNNN', so both share the unified 'issue' kind for topic
 * fan-out without a ref collision).
 */
import { getOrgPg } from '@papercusp/db-org';
import type { OrgSql } from './work-items';
import { admittedWhereSql, selfHealOwnNodeOriginIfStranded, type BornAdmission } from './work-items-admission';
import { assertScopeWellFormed, harnessScope, harnessOfScope } from './work-item-scope';
import { harnessPreference, resolveIssuePhysicalSlug } from './work-items-physical-row';
import { resolveWorkItemPot } from './pot-membership';
import { hasActiveStrictHumanAsk } from './hold-registry';
import { ANY_FAMILY_TERMINAL_STATES, ISSUE_TERMINAL_STATES } from './work-item-dispatch-states';
import { neutralizeToolCallTags, sanitizePersistedText } from './text-safety';
import {
  PgTaggableStore,
  PgThreadStore,
  PgEntitySubscriptionStore,
  PgLinkStore,
  type ObjectRef,
  type DeliveryMode,
  type ThreadPostRow,
} from '@papercusp/coordination/capabilities';
import { DEFAULT_COORD_WORKSPACE, withPgContentionRetry } from '@papercusp/coordination/event-log';
import { FLAGS, FLAG_DEFAULTS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { activeWorkspaceId } from './workspace-registry';
import { lazyFlagRefresh } from './lazy-flag-refresh';
import { systemDistinctId } from './flag-distinct-id';
import { type InjectEvent } from './agent-tools/coordination/fanout-delivery';
import { coordScopeWorkspace } from './agent-tools/coordination/log';
import { fanoutForObject } from './sync/hyperbee/fanout-projection';
import { boundedOrgTxn } from './pg-bounded-txn';
import { sealSharedTextInTxOrRefuse } from './personal-vault/shared-store-seal';
import { boundedPgReadTxn } from './pg-read-query';
import { getBuildInfo } from './build-info';
import { createBugFreshnessEnvelope, isFreshnessTrackedKind } from './work-item-claim-freshness';
import { resolveProject } from './harness-core';
import { mintFixFeatureRow } from './promote-issue';
import type { Issue as PipelineIssue } from './harness/issue-types';
import {
  COMPLETION_ATTESTATIONS_KEY,
  TERMINAL_COMPLETION_EVIDENCE_KEY,
  readStoredAssumptions,
  terminalPayloadMergeJson,
} from './coord-lifecycle/records';
import type { CompletionAttestation, StoredAssumptionDeclaration } from './coord-lifecycle/records';
import {
  auditWhereSql,
  completionAuthorityPredicateSql,
  derivedTerminalCompletionAuthority,
  type WorkItemAudit,
} from './completion-audit';
import { dedupSignature } from './harness/improvements/digest';
import type { PersistedCompletionEvidence } from './coord-lifecycle/records';
import {
  isSufficientEvidence,
  isWorkItemCompletionAuthority,
  type WorkItemCompletionAuthority,
} from './work-item-completion-authority';
import { pgTimestampToIso, pgTimestampToIsoOrNull } from './pg-timestamp';
import { clearGoalClaimedIfMatches } from './agent-state-stamp';
import { DEFAULT_SIGNAL_ORIGIN, type SignalOrigin } from './harness/improvements/provenance';
import { createBlockingEdgeReader, ISSUE_TERMINAL_STATUSES } from './work-item-blocking';
import { planItemRef } from './issue-blocks-merge';
import { mirrorWorkItemBlockingEdge, removeMirroredWorkItemBlockingEdge } from './dbos/work-item-deps-store';
import { randomInt } from 'node:crypto';
import { isTransportOnlyIdentity } from './agent-tools/coordination/identity';
import { trackDetached } from './detached-imports';
import { projectWorkItemColumns, type WorkItemReadOptions } from './work-item-read-projection';
import { CLAIM_SUBJECT_BASELINE_KEY } from './claim-subject-baseline';
import { AUTO_CLOSE_DEFAULT_MIN_TICKS, AUTO_CLOSE_ELIGIBLE_SOURCES } from './harness/improvements/auto-close-sources';
import {
  agentReviewNormalExclusionSql,
  createImplementationReadiness,
  agentReviewPendingAdmissionSql,
  isAgentReviewClaimAdmission,
  verificationTaskConflict,
  type AgentReviewClaimAdmission,
} from './harness/improvements/agent-review-policy';
import {
  isLegacyFleetScopeDowngradeAdmission,
  type LegacyFleetScopeDowngradeAdmission,
} from './work-item-fleet-scope-recovery';
import { audienceWhereSql, type WorkAudienceFilter } from './work-nature/agent-work-predicate';

/**
 * EI-217141: a fleet leader's explicit assignment is the one narrow exception to
 * the born-pending admission floor. The capability is minted only after the
 * scheduler admission seam has re-derived the target's current fleet scope,
 * pause state, claim-spec source, and durable current leader. Callers cannot
 * forge a valid capability: claimIssue validates object identity through this
 * module-private WeakSet before using it in the mutation predicate.
 */
export interface LeaderDispatchAdmission {
  readonly itemId: string;
  readonly target: string;
  readonly workspaceId: string;
  readonly assignedBy: string;
}

const leaderDispatchAdmissions = new WeakSet<object>();

function mintLeaderDispatchAdmission(args: {
  itemId: string;
  target: string;
  workspaceId: string;
  assignedBy: string;
}): LeaderDispatchAdmission {
  const admission = Object.freeze({ ...args });
  leaderDispatchAdmissions.add(admission);
  return admission;
}

export function isLeaderDispatchAdmission(value: unknown): value is LeaderDispatchAdmission {
  return typeof value === 'object' && value !== null && leaderDispatchAdmissions.has(value);
}

/**
 * EI-218293: a member's own newly-filed bug is the second narrow exception to the
 * born-pending admission floor. The fleet-scope admission seam already admits that
 * server-attributed fallout bug, but the subsequent claimIssue UPDATE used to have no
 * capability carrying that decision into the SQL predicate.
 *
 * This is intentionally separate from leader dispatch. A self-filed bug must not
 * inherit leader authority, and the SQL claim keeps the durable created_by value in
 * its predicate so a row changed after minting cannot inherit this exception.
 */
export interface SelfFiledFalloutAdmission {
  readonly itemId: string;
  readonly target: string;
  readonly workspaceId: string;
  readonly createdBy: string;
}

const selfFiledFalloutAdmissions = new WeakSet<object>();

function mintSelfFiledFalloutAdmission(args: {
  itemId: string;
  target: string;
  workspaceId: string;
  createdBy: string;
}): SelfFiledFalloutAdmission {
  const admission = Object.freeze({ ...args });
  selfFiledFalloutAdmissions.add(admission);
  return admission;
}

export function isSelfFiledFalloutAdmission(value: unknown): value is SelfFiledFalloutAdmission {
  return typeof value === 'object' && value !== null && selfFiledFalloutAdmissions.has(value);
}

/**
 * EI-22345414208647835: carry a checked force takeover authorization across the
 * claim writer's born-pending admission floor. Object identity is kept in a
 * module-private WeakSet so callers cannot forge this capability by copying its
 * fields. The writer still requires the exact expected-holder CAS, and the
 * feature-family path retains its independent G2/origin floor.
 */
export interface ForceTakeoverAdmission {
  readonly itemId: string;
  readonly target: string;
  readonly expectedAssignee: string;
  readonly workspaceId: string;
}

const forceTakeoverAdmissions = new WeakSet<object>();

export function mintForceTakeoverAdmission(args: {
  itemId: string;
  target: string;
  expectedAssignee: string;
  workspaceId: string;
}): ForceTakeoverAdmission {
  const admission = Object.freeze({ ...args });
  forceTakeoverAdmissions.add(admission);
  return admission;
}

export function isForceTakeoverAdmission(value: unknown): value is ForceTakeoverAdmission {
  return typeof value === 'object' && value !== null && forceTakeoverAdmissions.has(value);
}

/**
 * Derive the internal leader-dispatch capability for a by-id claim. This keeps
 * the exception server-derived and preserves the existing fleet admission
 * ordering: winding-down and the default claim spec still refuse before the
 * current-leader check. A scheduler/fleet-store failure fails closed.
 */
export async function deriveLeaderDispatchAdmission(
  item: Pick<EngineerIssue, 'id' | 'assignedBy'>,
  target: string,
  workspaceId: string,
): Promise<LeaderDispatchAdmission | null> {
  if (!item.assignedBy) return null;
  try {
    const { resolveFleetScopeContext, fleetControlWindDownRefusal, leaderDispatchedAdmission } =
      await import('./scheduler/fleet-scope-admission');
    const scope = await resolveFleetScopeContext(target, workspaceId);
    if (!scope) return null;
    if (await fleetControlWindDownRefusal(scope, workspaceId)) return null;
    if (scope.record.source === 'default') return null;
    if (!(await leaderDispatchedAdmission(item, scope))) return null;
    return mintLeaderDispatchAdmission({
      itemId: item.id,
      target,
      workspaceId,
      assignedBy: item.assignedBy,
    });
  } catch {
    return null;
  }
}

/**
 * Derive the internal self-filed-fallout capability for a by-id claim. This mirrors
 * admitWorkItemForFleetTarget's existing selfFiledFalloutAdmission predicate, but
 * mints a private capability for the later claimIssue UPDATE. A scheduler/fleet-store
 * failure fails closed, and the winding-down refusal keeps precedence.
 */
export async function deriveSelfFiledFalloutAdmission(
  item: Pick<EngineerIssue, 'id' | 'kind' | 'createdBy'>,
  target: string,
  workspaceId: string,
): Promise<SelfFiledFalloutAdmission | null> {
  if (item.kind !== 'bug' || !item.createdBy) return null;
  try {
    const { resolveFleetScopeContext, fleetControlWindDownRefusal, selfFiledFalloutAdmission } =
      await import('./scheduler/fleet-scope-admission');
    const scope = await resolveFleetScopeContext(target, workspaceId);
    if (!scope) return null;
    if (await fleetControlWindDownRefusal(scope, workspaceId)) return null;
    if (!selfFiledFalloutAdmission(item, scope)) return null;
    return mintSelfFiledFalloutAdmission({
      itemId: item.id,
      target,
      workspaceId,
      createdBy: item.createdBy,
    });
  } catch {
    return null;
  }
}

/**
 * Upper bound on rows a single `listIssues` read returns. Kept in lock-step with
 * `WORK_ITEMS_MAX_LIMIT` (work-items.ts) — the unified work-items list requests
 * up to that many, and a lower inner cap here was silently truncating the issue
 * leg (the "938 of 1821" the pane showed: features loaded but issues pinned at
 * 500 while countIssues tallied them all). Declared as a local literal, NOT
 * imported from work-items.ts, because work-items.ts imports listIssues from
 * here — importing back would be a circular dependency. Callers beyond this cap
 * page via infinite scroll (a larger `limit`), so this is a per-read ceiling,
 * not a hard product cap.
 */
const ISSUES_MAX_LIMIT = 2000;

export type IssueSeverity = 'critical' | 'major' | 'minor' | 'nit';
export type IssueSource = 'engineer' | 'su';
// work-item-status-full-unify (P-003 writer-flip): the issue family now stores the UNIFIED
// work-item enum, DECOUPLED from the generic 3-state pubsub LifecycleState
// (open|resolved|closed — a domain-free abstraction we must not repurpose). Legacy
// resolved/closed stay in the union as a TRANSITIONAL superset (aliased to done/dropped on
// write; still accepted from a pre-flip row or an un-upgraded federated peer). The
// resolved/closed→done/dropped nuance is preserved in work_items.terminal_reason.
export type IssueState = 'open' | 'wip' | 'blocked' | 'needs-human' | 'done' | 'dropped' | 'resolved' | 'closed';
/** Work-item kind within the issue kind-table for the issues:* SURFACE
 *  (unify-work-items D-002). bug|change are the user-facing issue kinds. */
export type IssueKind = 'bug' | 'change';
/** Every kind physically stored in engineer_issues (collapse-delegate D-001):
 *  the issue-surface kinds PLUS `task` — a delegated unit of work (retired delegate
 *  durable record). `task` is a work_item kind only; the issues:* surface excludes it. */
export type IssueStoreKind = IssueKind | 'task';

export const ISSUE_KIND = 'issue';
export const ISSUE_SEVERITIES: readonly IssueSeverity[] = ['critical', 'major', 'minor', 'nit'];
export const ISSUE_STATES: readonly IssueState[] = [
  'open',
  'wip',
  'blocked',
  'needs-human',
  'done',
  'dropped',
  'resolved',
  'closed',
];
export const ISSUE_KINDS: readonly IssueKind[] = ['bug', 'change'];
/** Storage kinds (incl. `task`). The default listIssues filter restricts to
 *  ISSUE_KINDS so delegated tasks never leak into the issues:* surface. */
export const ISSUE_STORE_KINDS: readonly IssueStoreKind[] = ['bug', 'change', 'task'];

export interface EngineerIssue {
  id: string;
  kind: IssueStoreKind; // work-item kind: bug | change (unify-work-items D-002) | task (collapse-delegate D-001)
  scope: string; // 'operator' | 'harness:<slug>'
  title: string;
  body: string;
  severity: IssueSeverity;
  source: IssueSource;
  state: IssueState;
  assignee: string | null;
  /** Durable delegator (collapse-delegate D-002): who created+assigned this item. */
  assignedBy: string | null;
  assignedAt: string | null;
  /** WI-2990/WI-3006: the real item-scoped progress signal (agent-activity-liveness-truth
   *  P-001), mirroring the feature-family's last_progress_at. Populated by markIssueProgress()
   *  on a checkpoint; null until the first one. Exposed on the engineer_issues compat view by
   *  migration 509 (it always existed on the unified work_items base table). */
  lastProgressAt: string | null;
  /** Kind-specific data (collapse-delegate D-001): a task's {agentSessionId,origin,backend}. */
  payload: unknown | null;
  /** Parent work-item id for duplicate/child relationships across issue-family rows. */
  parent: string | null;
  /** Federation provenance from the physical work_items row. */
  origin: string | null;
  foundDuring: string | null;
  linkedFeatureId: string | null;
  createdBy: string | null;
  /** Learning-signal provenance (self-learning-frontier P-002/D-002, migration 241):
   *  organic | drill | replay | shadow. Learning consumers filter to organic unless
   *  explicitly opted in (read-items.ts). Distinct from the federation `origin` column. */
  signalOrigin: SignalOrigin;
  /** Position within the ASSIGNEE's ordered work-list (local-hive P-020). null = unranked. */
  assigneeRank: number | null;
  /** Who last set assigneeRank — 'bee' | 'queen' (+ dual-accept twins 'cup' | 'mug';
   *  the propose/dispose audit, D-008). */
  rankWriter: 'cup' | 'mug' | null;
  /** When assigneeRank was last written. */
  rankUpdatedAt: string | null;
  /** Completion-integrity gate (work-item-completion-integrity-2026-07-01 WI-1403):
   *  the claiming principal who drove this issue to its CURRENT terminal state
   *  (resolved|closed), or null if it has never reached one. Set only alongside
   *  a terminal setIssueState transition — never cleared on reopen. */
  terminalOwner: string | null;
  /** Paired with terminalOwner: the completion evidence (summary / commit / coord
   *  or plan-item ref) recorded for the CURRENT terminal state. Both are required
   *  together — a terminal transition without either is rejected by setIssueState. */
  terminalCompletionRef: string | null;
  /** agent-protocol-authority-semantics-2026-07-26 P-004 — how trustworthy this row's
   *  CURRENT terminal claim is, orthogonal to `state`. The DB column is bare
   *  `authority` on the shared `work_items` table this view is built over; the API
   *  surface disambiguates as `completionAuthority` (D-009 — plan items carry an
   *  unrelated `authority: system|owner` axis, and the column is rename-proof).
   *  null = no judgement: open if non-terminal, a legacy close if terminal (D-008). */
  completionAuthority: WorkItemCompletionAuthority | null;
  /** EI-10421: the SHARED backlog priority (`feature_order` on the `work_items` base
   *  row) — the Queen's steer-don't-dispatch lever, DISTINCT from `assigneeRank` (a
   *  per-assignee post-claim queue order). Issue-family items joined the dispatched
   *  backlog under P-007/EI-7407 (`setWorkItemPriority` writes this for bug/change/task
   *  too, and `claimNextIssueWorkItem`'s claim order already reads it unconditionally);
   *  this column exposes that on the read side (was hardcoded null — migration 588).
   *  LOWER = claimed sooner (inverted scale, same convention as feature-family); null =
   *  unprioritized. */
  featureOrder: number | null;
  createdAt: string;
  updatedAt: string;
  /** EI-18820653360383242 — when this item entered its CURRENT terminal state, maintained
   *  by the base-table trigger (migration 698), never by a caller. `null` on a terminal row
   *  means "closed, time unknown": the pre-698 legacy shape, which is most historical rows.
   *  Read it INSTEAD of updatedAt for anything time-of-close — updatedAt moves on any write
   *  and a single bulk write makes it report thousands of ancient rows as just-closed. */
  closedAt: string | null;
  /** WI-37711 — the goal this item was filed under (`work_items.goal_id`, migration 785),
   *  exposed on this compat view by migration 790 so a claim spec can scope a standing
   *  drain fleet to ONE goal. Stamped by stampGoalProvenance at creation; null when the
   *  filing agent held no goal context (the overwhelming majority of historical rows). */
  goalId: string | null;
  /**
   * WI-20288042426947475 — the claim-spec fields projected from the shared
   * work_items base row. Optional preserves the pre-migration distinction:
   * undefined means an older view did not project the column, while null means
   * the current view projected it and the stored value is NULL.
   */
  tags?: string[] | null;
  sourcePlanSlug?: string | null;
  sourcePlanItemIds?: string[] | null;
  redundancy?: number | null;
  expectedCostCents?: number | null;
}

export interface EngineerIssueDetail extends EngineerIssue {
  topics: string[];
  posts: ThreadPostRow[];
  /** Edges OUT of this issue (e.g. blocks → plan_item|feature). */
  links: { rel: string; dst: ObjectRef }[];
}

// ── Workspace scoping has TWO independent axes (EI-2760, the green-gate fix):
//
//  1. The engineer_issues ROWS are DOMAIN data → scoped per-workspace by
//     issuesScopeWorkspace() (workspace-data-isolation-leaks D-001: rows isolate when
//     papercusp-issues-per-workspace is ON, else the legacy shared 'default').
//  2. Their COORD METADATA (tags / threads / subscriptions / links) is SUBSTRATE data —
//     it rides the shared coordination plane and is keyed by the GLOBAL issue id. Every
//     substrate CONSUMER (fanoutForObject, topics-feed, issue-blocks-merge) reads it under
//     the COORD scope (coordScopeWorkspace). So the metadata stores MUST write under that
//     SAME coord scope, NOT the issue-row scope — otherwise, in any non-'default' workspace,
//     writes (issuesScope) and consumers (coordScope) silently desync and fan-out / topic
//     feeds / plan-item blocks all deliver nothing. D-001 scoped BOTH axes by the row scope;
//     that was the regression. Per-workspace issue COORDINATION returns coherently when the
//     substrate itself goes per-workspace (COORD_PER_WORKSPACE) — the rows already isolate.
//
// EI-<n> ids stay GLOBALLY allocated (nextIssueId is unchanged), so the global ObjectRef
// contract that lets metadata key by issue id across workspaces holds. ──────────────────
// EI-19452830964505931: keyed BY WORKSPACE, not one process-global boolean.
//
// The subtlety that makes a global wrong here: the distinctId is `systemDistinctId()`, which is
// machine-stable (`papercusp-host-<hostname>`), so the getFlag call LOOKS workspace-independent.
// It is not — the PG override store underneath is installed with `cacheKey: () => activeWorkspaceId()`
// (flag-override-store.ts) and loads `WHERE workspace_id = activeWorkspaceId()`, so getFlag's ANSWER
// is workspace-dependent even though its arguments are not. A single global therefore lets whichever
// workspace refreshed last serve its value to every other one for the TTL window — re-creating one
// layer up the exact cross-workspace bleed that store's cacheKey exists to prevent.
//
// Live divergence confirmed 2026-08-03: `papercusp-issues-per-workspace` is overridden false in
// 'generic-test' and true in 'shared-hive-test-ownerhandle', while 'default'/'papercusp-workspace' take
// FLAG_DEFAULTS (true). Impact today is LATENT rather than active — 'generic-test' is the only
// workspace whose value differs from the default and it has taken no issue-family write since
// 2026-06-18 — so this is correctness-by-construction, not an incident fix.
//
// Bounded by the workspace registry (4 rows today), so no eviction policy; revisit if workspace ids
// ever become caller-supplied rather than registry-derived.
const issuesPerWorkspaceCache = new Map<string, { on: boolean; readAtMs: number }>();
// Self-heal cadence for the cached flag (EI-1460). Short enough that a flip is
// honoured within a few seconds anywhere; long enough that the PG-backed getFlag
// (itself 5s-TTL-cached) is hit at most ~once per window per process.
const ISSUES_FLAG_TTL_MS = 3_000;
// EI-14108: the catch below is the same fail-CLOSED-but-fail-SILENT pattern as
// schedulerIssuesClaimableEnabled() in work-items.ts — a getFlag failure (flag store
// unreachable, PG pool poisoned) must not vanish silently into "flag is off". This TTL
// cache re-attempts every ISSUES_FLAG_TTL_MS regardless (unlike the other site, there's no
// separate consumer to hand the error to — this cache is read via issuesScopeWorkspace()'s
// boolean projection only), so throttle the log to avoid spamming once per 3s during a
// sustained outage while still surfacing it periodically.
let _lastIssuesPerWorkspaceErrorLoggedAtMs = 0;
const ISSUES_PER_WORKSPACE_FLAG_ERROR_LOG_THROTTLE_MS = 5 * 60_000; // 5 min
async function refreshIssuesPerWorkspace(): Promise<void> {
  // Resolve the key BEFORE the await: activeWorkspaceId() is ambient, and awaiting getFlag can
  // interleave with another workspace's request. Capturing it up front is what keeps the write
  // landing on the workspace this refresh actually read for.
  const ws = activeWorkspaceId();
  try {
    const on = await getFlag(FLAGS.ISSUES_PER_WORKSPACE, systemDistinctId());
    issuesPerWorkspaceCache.set(ws, { on, readAtMs: Date.now() });
  } catch (err) {
    // Fail-CLOSED to the legacy shared partition, and unlike workspace-brain-scope's latch this
    // error value is deliberately allowed to cache: the TTL bounds it to ISSUES_FLAG_TTL_MS, so it
    // self-heals in ~3s rather than pinning the process (cf. EI-19455760069884279).
    issuesPerWorkspaceCache.set(ws, { on: false, readAtMs: Date.now() });
    const now = Date.now();
    if (now - _lastIssuesPerWorkspaceErrorLoggedAtMs >= ISSUES_PER_WORKSPACE_FLAG_ERROR_LOG_THROTTLE_MS) {
      _lastIssuesPerWorkspaceErrorLoggedAtMs = now;
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[issues-engineer] ISSUES_PER_WORKSPACE read FAILED — falling back to the legacy shared ` +
          `'default' coord workspace this call (fail-closed): ${message}`,
      );
    }
  }
}
/**
 * Armed on FIRST USE, not at import (EI-19416650993725684) — SEEDED, which is what finally made
 * that safe (WI-8887). The history is kept because this module was migrated once, measured
 * ALL-GREEN, and REVERTED as wrong; a future reader needs to know which of those two verdicts is
 * the live one and why.
 *
 * ⚠ TWO module-scope flag-binding accesses were removed here, not one — the same shape as
 * `work-item-redundancy.ts`. The eager `void refreshIssuesPerWorkspace()` reached `getFlag`
 * SYNCHRONOUSLY (an async function body runs up to its first await when called), so migrating the
 * `onFlagChange(...)` alone would have turned the source lint green while leaving the module just
 * as unimportable under a partial `@papercusp/flags/server` mock — merely failing on `getFlag`
 * instead. That gap is why this file is listed in `flags-partial-mock-importable.test.ts` rather
 * than trusted to the lint.
 *
 * ## Why the FIRST attempt (2026-08-03) was correctly reverted
 *
 * Lazy arming moves the cache's first population from import to the FIRST READER CALL, and because
 * the refresh is async while the reader is sync, that first call returns the UNPOPULATED value.
 * Unseeded, that was this module's `let issuesPerWorkspaceOn = false` → DEFAULT_COORD_WORKSPACE,
 * i.e. the legacy shared 'default' coord partition — while ISSUES_PER_WORKSPACE is held ON. So the
 * window did not degrade to "an override has not taken effect yet"; it resolved issue scope to a
 * near-dead partition, i.e. the `wi.workspace_id = $issueWs` matches-nothing failure this file's
 * own doc comment below calls "a hard, deterministic, restart-immune zero".
 *
 * ## What changed: the seed, and the two checks that cleared it (WI-8887, both MEASURED)
 *
 * 1. VALUE. The seed populates the cache SYNCHRONOUSLY on arm from `FLAG_DEFAULTS`, which is
 *    `true` for ISSUES_PER_WORKSPACE (measured 2026-08-03) — so the window now serves the ACTIVE
 *    workspace, which is what live production actually does. Verified by EFFECT rather than by
 *    reading a flag value: `harness_shared.work_items` took 387 issue-family rows into
 *    `papercusp-workspace` in one hour (newest 2026-08-03T17:09:39Z) against 0 into 'default', so
 *    every live-writing process resolves this flag ON. The seeded window therefore MATCHES
 *    production instead of contradicting it, and this migration is strictly SAFER than the
 *    module-scope form it replaces: that form's import→first-refresh window served the dead
 *    partition too, and "nothing reads at boot" was an assumption, never a guarantee.
 *      Residual, accepted: a workspace whose override store holds this flag OFF gets the mirror
 *    hazard for one refresh round-trip. Measured, exactly one does — 'generic-test', which holds
 *    9 issue-family rows total and has taken no write since 2026-06-18.
 * 2. READ SITE. The second discriminator (a flag READ has effects beyond its value — it red
 *    `projected-tool-deps.test.ts` for capability-envelope-overrides). Clean here, provably:
 *    `resolveIssuesScopeWorkspace` ALREADY calls `getFlag(ISSUES_PER_WORKSPACE, systemDistinctId())`
 *    from inside the reader on every stale-TTL read (see its first line). Arming adds no flag read
 *    at all — `onFlagChange` is `changeHandlers.add(handler)`, a Set insertion.
 *
 * `resolveIssuesScopeWorkspace` is the ONLY reader of the cache (`issuesScopeWorkspace()` delegates
 * to it), so arming there covers every path. ⚠ Any NEW sync reader must arm too.
 */
const armIssuesFlagRefresh = lazyFlagRefresh(refreshIssuesPerWorkspace, {
  keys: [FLAGS.ISSUES_PER_WORKSPACE],
  // Seed from the flag REGISTRY, not a literal, so a graduation of the flag's default carries here
  // automatically. The deref is LAZY (inside this callback), the form
  // check-no-module-scope-flag-subscribe.mjs documents as correct and does not flag.
  // Seeds the ARMING workspace's entry. `readAtMs: 0` leaves it immediately stale so the first read
  // still kicks a real refresh (the pre-EI-19452830964505931 behaviour: seed, then refresh). Any
  // OTHER workspace gets the same default via the reader's `?? FLAG_DEFAULTS[...]` fallback, so an
  // unseeded workspace never serves a hardcoded literal either.
  seed: () => {
    issuesPerWorkspaceCache.set(activeWorkspaceId(), {
      on: FLAG_DEFAULTS[FLAGS.ISSUES_PER_WORKSPACE],
      readAtMs: 0,
    });
  },
  unpopulated: {
    kind: 'seeded-from-flag-default',
    serves:
      'FLAG_DEFAULTS[ISSUES_PER_WORKSPACE] — currently true, i.e. the ACTIVE workspace, which is ' +
      'what every live-writing process resolves (387 issue rows into papercusp-workspace in one ' +
      "hour vs 0 into 'default', measured 2026-08-03). The window diverges only where a runtime " +
      'OVERRIDE holds the flag OFF, and self-heals within one getFlag round-trip. Since ' +
      'EI-19452830964505931 that divergence is also correctly SCOPED: the cache is keyed by ' +
      'activeWorkspaceId() (the same key the PG override store uses), so an OFF override in one ' +
      "workspace can no longer be served to another — 'generic-test' holds it OFF and " +
      'a second shared-hive test workspace holds it ON in the very same database. An unseeded workspace ' +
      'falls back to FLAG_DEFAULTS in the reader, so it serves the registry default rather than a ' +
      'hardcoded literal. Note this does NOT cover a getFlag FAILURE: that path still fails CLOSED ' +
      "to the legacy 'default' partition (see refreshIssuesPerWorkspace above), bounded by the 3s " +
      'TTL — unchanged by either change.',
  },
});
/** The engineer-issues workspace scope NOW (F): active workspace when the flag is ON,
 *  else the legacy shared `default` coord workspace.
 *
 *  EI-1460: `onFlagChange` is IN-PROCESS only and the registration happens at module
 *  load, so a flip via the PG override store in another operator process — or a flip
 *  that lands before this module is lazily imported — would leave the cached bool stale
 *  FOREVER (the flag would silently never take effect, the symptom that shipped a wrong
 *  data-backfill). Self-heal on a short TTL: a stale read kicks a fire-and-forget
 *  refresh through `getFlag`, which reads the PG-backed override (cross-process-correct).
 *  The sync contract is preserved; the value converges within one getFlag round-trip. */
export function issuesScopeWorkspace(): string {
  return resolveIssuesScopeWorkspace();
}

/**
 * WI-5261: {@link issuesScopeWorkspace} with an optional EXPLICIT override for the
 * "active workspace" leg, for a caller that has already resolved its own workspace and
 * wants to avoid re-deriving it via `activeWorkspaceId()` — which depends on the
 * AsyncLocalStorage request-scope still being intact at the exact point of the call,
 * several `await`s deep into a call chain (get_next tool handler -> getNextForBee ->
 * getNextWorkItem -> claimNextIssueWorkItem). A dropped/lost ALS scope silently falls
 * through to `activeWorkspaceId()`'s own DEFAULT_WORKSPACE_ID fallback ('default'), and
 * since real issue-family rows live under the REAL workspace (never under 'default' for
 * a workspace-scoped install), that makes `wi.workspace_id = $issueWs` match nothing —
 * a hard, deterministic, restart-immune zero (confirmed live for papercusp-workspace,
 * 2026-07-17).
 *
 * The ISSUES_PER_WORKSPACE flag-gate is UNCHANGED: when the flag is off, issues still
 * live under the legacy shared `default` coord workspace regardless of what the caller
 * passes — `explicitActiveWorkspaceId` only ever substitutes for the "flag is ON, use
 * the active workspace" leg, never the gate itself. Omitted ⇒ byte-identical to the
 * original `issuesScopeWorkspace()` (falls back to `activeWorkspaceId()`).
 */
export function resolveIssuesScopeWorkspace(explicitActiveWorkspaceId?: string): string {
  armIssuesFlagRefresh(); // first use seeds the cache + installs the subscription (WI-8887)
  // Read the AMBIENT workspace, never `explicitActiveWorkspaceId`: the override store resolves
  // getFlag against activeWorkspaceId(), so that — not the caller's substitution — is the workspace
  // whose flag value this cache entry represents. `explicit` only substitutes for the ON-branch
  // return below (see this function's doc), never for the gate.
  const flagWorkspace = activeWorkspaceId();
  const entry = issuesPerWorkspaceCache.get(flagWorkspace);
  if (!entry || Date.now() - entry.readAtMs > ISSUES_FLAG_TTL_MS) void refreshIssuesPerWorkspace();
  if (!(entry?.on ?? FLAG_DEFAULTS[FLAGS.ISSUES_PER_WORKSPACE])) return DEFAULT_COORD_WORKSPACE;
  return explicitActiveWorkspaceId ?? activeWorkspaceId();
}

/**
 * WI-4308 interim mitigation: workspace ids to consult for DEDUP-ONLY reads
 * (`searchIssuesForDedup`, `findIssuesByWatchdogKeys`). ~1404 open engineer_issues
 * rows filed before ISSUES_PER_WORKSPACE flipped ON are permanently stuck under
 * workspace_id=DEFAULT_COORD_WORKSPACE ('default') and invisible to a single-scope
 * `issuesScopeWorkspace()` filter, so dedup can no longer see them at all — a
 * detector re-firing the same signal (same watchdogKey, same title) creates a fresh
 * duplicate instead of finding its still-open pre-flip twin. Additive/low-risk
 * stopgap: only widens DEDUP reads (never `searchIssues` itself, which also backs
 * the caller-visible `work_items:search` tool — see WI-4308 for the full
 * row+coord-metadata migration this is a stopgap for, and why a blind backfill of
 * the 1404 rows is NOT done here).
 */
function dedupScopeWorkspaces(): string[] {
  const active = issuesScopeWorkspace();
  return active === DEFAULT_COORD_WORKSPACE ? [active] : [active, DEFAULT_COORD_WORKSPACE];
}

// Substrate stores resolve under the COORD scope (axis 2 above) so writes land where every
// consumer reads. The engineer_issues ROW queries below keep issuesScopeWorkspace() (axis 1).
const coordOpts = {
  getSql: () => getOrgPg().sql,
  ensureSchema: async () => {},
  getWorkspaceId: () => coordScopeWorkspace(),
};
const tags = new PgTaggableStore(coordOpts);
const threads = new PgThreadStore(coordOpts);
const subs = new PgEntitySubscriptionStore(coordOpts);
const links = new PgLinkStore(coordOpts);
const blockingLinks = createBlockingEdgeReader(links);
// (topic-subscriber resolution now lives in fanoutForObject's own stores — A6.)

/**
 * Keep interactive link writes on the bounded admin-pool transaction used by
 * other issue substrate writes. A bare PgLinkStore uses the migration/admin
 * pool directly, which intentionally has no statement_timeout; a stalled
 * duplicate link could outlive the 60s tool handler after terminal completion
 * already committed (EI-23686882821651126).
 */
async function linkIssueRelationBounded(src: ObjectRef, dst: ObjectRef, rel: string, by?: string): Promise<void> {
  await boundedOrgTxn(async (tx) => {
    const txLinks = new PgLinkStore({ ...coordOpts, getSql: () => tx });
    await txLinks.link(src, dst, rel, { created_by: by, created_ts: nowIso() });
  });
}

async function unlinkIssueRelationBounded(src: ObjectRef, dst: ObjectRef, rel: string): Promise<void> {
  await boundedOrgTxn(async (tx) => {
    const txLinks = new PgLinkStore({ ...coordOpts, getSql: () => tx });
    await txLinks.unlink(src, dst, rel);
  });
}

export function issueRef(id: string): ObjectRef {
  return { kind: ISSUE_KIND, ref: id };
}
function threadId(id: string): string {
  return `issue-thread-${id}`;
}
function nowIso(): string {
  return new Date().toISOString();
}

function extractTerminalCompletionEvidence(payload: unknown): PersistedCompletionEvidence | null {
  let obj = payload;
  if (typeof obj === 'string') {
    try {
      obj = JSON.parse(obj) as unknown;
    } catch {
      return null;
    }
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return null;
  let value = (obj as Record<string, unknown>)[TERMINAL_COMPLETION_EVIDENCE_KEY];
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as PersistedCompletionEvidence;
}

export interface IssueRowDb {
  issue_id: string;
  kind: string;
  scope: string;
  title: string;
  body: string;
  severity: string;
  source: string;
  state: string;
  assignee: string | null;
  assigned_by: string | null;
  assigned_at: unknown;
  last_progress_at: unknown;
  payload: unknown;
  origin: string | null;
  found_during: string | null;
  linked_feature_id: string | null;
  created_by: string | null;
  signal_origin: string | null;
  assignee_rank: number | null;
  rank_writer: string | null;
  rank_updated_at: unknown;
  terminal_owner: string | null;
  terminal_completion_ref: string | null;
  /** P-004 — the completion-authority column (D-009: bare `authority` in the DB). */
  authority: string | null;
  feature_order: number | null;
  created_at: unknown;
  updated_at: unknown;
  /** EI-18820653360383242 — bigint epoch-ms on the base table (migration 698). */
  closed_ts: unknown;
  /** WI-37711 — exposed on the engineer_issues view by migration 790. */
  goal_id: string | null;
  /** Parent work-item id, appended to the engineer_issues view by migration 803. */
  parent_id: string | null;
  /** WI-20288042426947475 — claim-spec columns appended by migration 815. */
  tags: unknown;
  source_plan_slug: string | null;
  source_plan_item_ids: string[] | null;
  redundancy: number | string | null;
  expected_cost_cents: number | string | null;
}
// EI-18691099450966094: delegates to the shared pg-timestamp helper — a raw
// Postgres-text timestamptz (e.g. "2026-07-26 03:34:43.647148-04") must be
// parsed and re-emitted as an explicit UTC "...Z" string, never passed
// through as-is (a bare local-offset string reads as ambiguous/UTC and can
// manufacture a false staleness verdict on a live claim).
const tsIso = pgTimestampToIso;
const tsIsoOrNull = pgTimestampToIsoOrNull;
function coerceFiniteNumber(raw: number | string | null | undefined): number | null {
  if (raw == null) return null;
  const n = typeof raw === 'string' ? Number(raw) : raw;
  return Number.isFinite(n) ? n : null;
}

export function toIssue(r: IssueRowDb): EngineerIssue {
  return {
    id: r.issue_id,
    kind: (r.kind as IssueStoreKind) ?? 'bug',
    scope: r.scope,
    title: r.title,
    // Bodyless list projections preserve the row shape with NULL::text.  Keep the
    // public EngineerIssue contract total so downstream mappers can safely use the
    // same object for full and lean reads (WI-42508).
    body: r.body ?? '',
    severity: r.severity as IssueSeverity,
    source: r.source as IssueSource,
    state: r.state as IssueState,
    assignee: r.assignee,
    assignedBy: r.assigned_by,
    assignedAt: tsIsoOrNull(r.assigned_at),
    lastProgressAt: tsIsoOrNull(r.last_progress_at),
    payload: r.payload ?? null,
    parent: r.parent_id,
    origin: r.origin ?? 'local',
    foundDuring: r.found_during,
    linkedFeatureId: r.linked_feature_id,
    createdBy: r.created_by,
    // NULL only on a pre-migration-241 read (the column default backfills) —
    // legacy rows are organic by definition. Junk can't pass the CHECK constraint.
    signalOrigin: (r.signal_origin ?? DEFAULT_SIGNAL_ORIGIN) as SignalOrigin,
    assigneeRank: r.assignee_rank,
    rankWriter: r.rank_writer === 'cup' || r.rank_writer === 'mug' ? r.rank_writer : null,
    rankUpdatedAt: tsIsoOrNull(r.rank_updated_at),
    terminalOwner: r.terminal_owner,
    terminalCompletionRef: r.terminal_completion_ref,
    // A token outside the union can only come from a pre-CHECK row or a hand-edit that
    // evaded it — read it as "no judgement" rather than leaking it to every consumer.
    completionAuthority: isWorkItemCompletionAuthority(r.authority) ? r.authority : null,
    featureOrder: r.feature_order,
    createdAt: tsIso(r.created_at),
    updatedAt: tsIso(r.updated_at),
    closedAt: tsIsoOrNull(r.closed_ts),
    goalId: r.goal_id,
    ...(r.tags !== undefined
      ? {
          tags: Array.isArray(r.tags) ? r.tags.filter((v): v is string => typeof v === 'string') : null,
        }
      : {}),
    ...(r.source_plan_slug !== undefined ? { sourcePlanSlug: r.source_plan_slug } : {}),
    ...(r.source_plan_item_ids !== undefined
      ? {
          sourcePlanItemIds: Array.isArray(r.source_plan_item_ids) ? r.source_plan_item_ids : null,
        }
      : {}),
    ...(r.redundancy !== undefined ? { redundancy: coerceFiniteNumber(r.redundancy) } : {}),
    ...(r.expected_cost_cents !== undefined ? { expectedCostCents: coerceFiniteNumber(r.expected_cost_cents) } : {}),
  };
}

// EI-10489: exported (was module-private) so issue-cols-parity.test.ts can assert this
// stays in sync with IssueRowDb — see ISSUE_ROW_DB_KEYS below for the full rationale.
export const ISSUE_COLS = `issue_id, kind, scope, title, body, severity, source, state, assignee,
  assigned_by, assigned_at, last_progress_at, payload, found_during, linked_feature_id, created_by,
  origin, signal_origin, assignee_rank, rank_writer, rank_updated_at, terminal_owner,
  terminal_completion_ref, authority, feature_order, created_at, updated_at, closed_ts, goal_id,
  parent_id, tags, source_plan_slug, source_plan_item_ids, redundancy, expected_cost_cents`;

/**
 * ISSUE_COLS with `body` replaced by a NULL of the same type — for the readers that
 * provably never touch it (see {@link ListIssuesFilter.includeBody}).
 *
 * DERIVED, not hand-written, on purpose. EI-10489 closed a real drift bug by locking
 * ISSUE_COLS to `IssueRowDb` with a compile-time tuple plus a runtime parity test; a
 * second column list typed out by hand would be a THIRD thing to keep in sync and
 * would re-open exactly that gap. Substituting one token keeps the single source —
 * every column added to ISSUE_COLS lands here automatically, in the same position.
 *
 * `NULL::text` rather than dropping the column outright so the row shape (and so
 * `IssueRowDb`, `toIssue`, and every consumer's destructuring) is unchanged: this is
 * a payload optimization, never a schema variant.
 */
export const ISSUE_COLS_BODYLESS = ISSUE_COLS.replace(/(^|,\s*)body(\s*,)/, '$1NULL::text AS body$2');

/**
 * ISSUE_COLS with the large JSONB payload replaced by a typed NULL.  This is the
 * read-side counterpart to {@link ISSUE_COLS_BODYLESS}: callers that only need the
 * issue identity/state columns must not make postgres-js parse every checkpoint and
 * completion envelope before a later result shaper drops it (WI-42508).
 *
 * Keep this derived from ISSUE_COLS rather than hand-writing a second allowlist.  The
 * row arity and column order remain identical, so {@link IssueRowDb} and
 * {@link toIssue} stay usable for both projections.  Predicates in the list query
 * still reference the real payload where a filter needs it; only the returned column
 * is projected away.
 */
export const ISSUE_COLS_PAYLOADLESS = ISSUE_COLS.replace(/(^|,\s*)payload(\s*,)/, '$1NULL::jsonb AS payload$2');

/** Combined body + payload projection for agent-facing list reads. */
export const ISSUE_COLS_BODYLESS_PAYLOADLESS = ISSUE_COLS_BODYLESS.replace(
  /(^|,\s*)payload(\s*,)/,
  '$1NULL::jsonb AS payload$2',
);

/**
 * Payload dropped EXCEPT for a rebuilt one-field object carrying `watchdogKey`.
 *
 * The whole-corpus recurrence census must group on the stable machine-minted
 * `watchdogKey` (see `recurrenceGroupKey` in harness/improvements/digest.ts), but
 * payload is the LARGEST column in this table (39 MB against 2.8 MB of title,
 * measured 2026-08-30) and not parsing it is the entire point of the payload-less
 * projection. Extracting that one key as text and rebuilding a single-field object
 * keeps the row SHAPE identical for the candidate mapper — which reads
 * `payload.watchdogKey` and type-checks it — while reading none of the rest.
 */
const WATCHDOG_KEY_ONLY_PAYLOAD = "$1jsonb_build_object('watchdogKey', payload->>'watchdogKey') AS payload$2";
export const ISSUE_COLS_BODYLESS_WATCHDOG_KEY_ONLY = ISSUE_COLS_BODYLESS.replace(
  /(^|,\s*)payload(\s*,)/,
  WATCHDOG_KEY_ONLY_PAYLOAD,
);
export const ISSUE_COLS_WATCHDOG_KEY_ONLY = ISSUE_COLS.replace(/(^|,\s*)payload(\s*,)/, WATCHDOG_KEY_ONLY_PAYLOAD);

/** Select the smallest issue row projection requested by a list caller. */
export function issueListColumns(
  filter: Pick<ListIssuesFilter, 'includeBody' | 'includePayload' | 'includeWatchdogKey'>,
): string {
  if (filter.includeBody === false && filter.includePayload === false) {
    return filter.includeWatchdogKey === true ? ISSUE_COLS_BODYLESS_WATCHDOG_KEY_ONLY : ISSUE_COLS_BODYLESS_PAYLOADLESS;
  }
  if (filter.includeBody === false) return ISSUE_COLS_BODYLESS;
  // Honoured on BOTH payload-less branches on purpose: a caller that keeps `body`
  // but drops payload would otherwise set the flag and silently still get no key —
  // the same silent-degradation shape `includePayload` itself is documented for.
  if (filter.includePayload === false) {
    return filter.includeWatchdogKey === true ? ISSUE_COLS_WATCHDOG_KEY_ONLY : ISSUE_COLS_PAYLOADLESS;
  }
  return ISSUE_COLS;
}

/**
 * EI-10489: ISSUE_COLS (the runtime SELECT allowlist above) and IssueRowDb (its TS shape)
 * are two independently hand-maintained lists of the SAME 26 columns — nothing tied them
 * together, so a column added to one without the other silently degraded a real field to
 * `undefined` at runtime (no compile error, no test failure). Two layers close that gap:
 *
 *  1. COMPILE-TIME: this tuple is a literal list of IssueRowDb's own keys. The assertions
 *     right below FAIL TO TYPECHECK the moment IssueRowDb gains or loses a key this tuple
 *     doesn't also have (both directions) — `npx tsc --noEmit` catches an interface change
 *     that forgot to update the tuple.
 *  2. RUNTIME: issue-cols-parity.test.ts parses ISSUE_COLS and asserts it names exactly
 *     this tuple's columns — so a change to ISSUE_COLS alone (without touching this
 *     compile-time-locked tuple) also fails, loudly, at test time instead of silently
 *     returning undefined.
 *
 * Together: ISSUE_COLS <-runtime test-> ISSUE_ROW_DB_KEYS <-compile-time-> IssueRowDb.
 */
export const ISSUE_ROW_DB_KEYS = [
  'issue_id',
  'kind',
  'scope',
  'title',
  'body',
  'severity',
  'source',
  'state',
  'assignee',
  'assigned_by',
  'assigned_at',
  'last_progress_at',
  'payload',
  'origin',
  'found_during',
  'linked_feature_id',
  'created_by',
  'signal_origin',
  'assignee_rank',
  'rank_writer',
  'rank_updated_at',
  'terminal_owner',
  'terminal_completion_ref',
  'authority',
  'feature_order',
  'created_at',
  'updated_at',
  'closed_ts',
  'goal_id',
  'parent_id',
  'tags',
  'source_plan_slug',
  'source_plan_item_ids',
  'redundancy',
  'expected_cost_cents',
] as const;
type IssueRowDbKeysUnion = (typeof ISSUE_ROW_DB_KEYS)[number];
type MissingFromTuple = Exclude<keyof IssueRowDb, IssueRowDbKeysUnion>;
type ExtraInTuple = Exclude<IssueRowDbKeysUnion, keyof IssueRowDb>;
type AssertNoMissingFromTuple = MissingFromTuple extends never
  ? true
  : { ISSUE_ROW_DB_KEYS_is_missing: MissingFromTuple };
type AssertNoExtraInTuple = ExtraInTuple extends never ? true : { ISSUE_ROW_DB_KEYS_has_extra: ExtraInTuple };
// Referenced only for its type-level effect — a real value keeps this from being
// tree-shaken away and dead-code-eliminated before tsc ever sees the assertion.
export const _issueRowDbKeysParityAssertion: [AssertNoMissingFromTuple, AssertNoExtraInTuple] = [true, true];

// P-008 (d): the byte-identical private copy that used to live here (and in
// work-items.ts) is gone — `terminalPayloadMergeJson` in coord-lifecycle/records.ts
// is now the single builder for both families, so the evidence key and the
// assumptions key cannot land differently depending on which family closed.

// EI-13285: a fixed epoch (arbitrary — keeps the millis component shorter) so the
// numeric tail stays well inside a bigint/JS-safe-integer range for centuries.
const EI_ID_EPOCH_MS = Date.UTC(2026, 0, 1);
// 20 random bits (~1M values) appended per millisecond of entropy — same-millisecond
// collision odds are ~1-in-a-million even with ZERO cross-writer coordination.
const EI_ID_RAND_BITS = 20n;
const EI_ID_RAND_SPACE = 2 ** 20;

/**
 * Mint the numeric tail of a fresh, collision-resistant EI-<n> id (EI-13285).
 *
 * Exported so the Hyperbee→PG issue projection (engineer-issues.ts) can mint the
 * SAME kind of id when it needs to re-key a genuinely colliding incoming remote op
 * (see writeToPg's collision guard there) — both callers need the identical
 * "no shared state required" property.
 */
export function newCollisionResistantIssueTail(): string {
  const ms = BigInt(Math.max(0, Date.now() - EI_ID_EPOCH_MS));
  const rand = BigInt(randomInt(0, EI_ID_RAND_SPACE));
  return ((ms << EI_ID_RAND_BITS) + rand).toString();
}

/**
 * Allocate the next globally-unique EI-<n> id.
 *
 * EI-13285 (root cause): this USED TO scan `MAX(existing EI-<n>) + 1` under a local
 * advisory lock. That is only unique WITHIN one Postgres instance — it does nothing
 * to stop a DIFFERENT Hive peer device (its own separate, federation-lagged copy of
 * `engineer_issues`) from independently computing the exact same "next" integer with
 * zero coordination. When the two ops later federate together, the projection's
 * upsert (keyed on the shared issue_id) treats the second writer's op as an EDIT of
 * the first, silently replacing a distinct, unrelated record — proven live: a freshly
 * captured local improvement (EI-13236) was clobbered by an unrelated remote
 * replication-liveness issue that happened to allocate the same id.
 *
 * Fix: derive the id from wall-clock time + a wide random tail (no dependency on
 * scanning replicated, possibly-stale state at all — see
 * {@link newCollisionResistantIssueTail}), then verify LOCAL uniqueness with a bounded
 * retry loop. This is:
 *   - Cross-device collision-SAFE by construction (no shared mutable state to race on).
 *   - Still ordered close to chronologically (useful for the rare human eyeballing an
 *     id), and every id minted this way sorts numerically after every legacy
 *     sequential id (small integers), so existing numeric-sort assumptions hold.
 *   - Locally collision-resistant (the EXISTS-check retry loop avoids reusing an
 *     already-present id, while the base table's composite key remains the final
 *     uniqueness guard). The entropy-backed allocator needs no process-wide lock.
 *
 * Defense-in-depth for a colliding id that federates in anyway (e.g. from a peer
 * still running pre-fix code) lives in the projection's writeToPg — see
 * engineer-issues.ts.
 */
async function nextIssueId(sql = getOrgPg().sql): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const candidate = `EI-${newCollisionResistantIssueTail()}`;
    const rows = await sql<{ taken: boolean }[]>`
      SELECT EXISTS(SELECT 1 FROM harness_shared.engineer_issues WHERE issue_id = ${candidate}) AS taken`;
    if (!rows[0]?.taken) return candidate;
  }
  throw new Error('nextIssueId: exhausted retries allocating a collision-free EI id');
}

/** Per-op notify_kind, as data (mirrors the fanout-projection registry shape —
 *  adopt-event-rules-engines D-005). `resolved` is the one lifecycle resolution. */
const ISSUE_NOTIFY_KINDS = {
  created: 'issue_created',
  updated: 'issue_updated',
  commented: 'issue_commented',
  resolved: 'issue_resolved',
} as const;

async function deliver(
  issue: EngineerIssue,
  op: keyof typeof ISSUE_NOTIFY_KINDS,
  summary: string,
  actor = 'substrate',
): Promise<number> {
  // Fan out to the issue's subscribers (direct ∪ topic), excluding the actor so
  // an agent is never notified of its own action. Routed through the canonical
  // fanoutForObject seam (A6) instead of an inline resolve→deliverInjectMany —
  // behaviour-preserving (it does the same actor-excluded resolve + deliver).
  // The author-exclusion on CREATE still holds: createIssue auto-subscribes the
  // author AFTER its deliver() call, so the author isn't a subscriber yet here.
  const ev: InjectEvent = {
    from: actor,
    subject: `${ISSUE_KIND}:${issue.id}`,
    summary,
    notify_kind: ISSUE_NOTIFY_KINDS[op],
    isResolution: op === 'resolved',
  };
  return fanoutForObject(issueRef(issue.id), ev, { excludeId: actor });
}

export interface CreateIssueInput {
  title: string;
  body?: string;
  severity?: IssueSeverity;
  source?: IssueSource;
  /** Plan provenance carried through the unified work-item create path. */
  sourcePlanSlug?: string | null;
  sourcePlanItemIds?: string[] | null;
  scope?: string; // omit → workspace platform Pot; or 'harness:<slug>'. 'operator'/global auto-homes to the platform Pot (createIssue, P-005).
  foundDuring?: string;
  topics?: string[];
  createdBy?: string;
  /** Work-item kind: bug (default) | change (unify-work-items D-002) | task (collapse-delegate D-001). */
  kind?: IssueStoreKind;
  /** Agent the item is assigned to at creation (collapse-delegate: the delegate session). */
  assignee?: string;
  /** Durable delegator (collapse-delegate D-002): who created+assigned it. Sets assigned_at=now(). */
  assignedBy?: string;
  /** Kind-specific data (collapse-delegate D-001): a task's resume metadata. */
  payload?: unknown;
  /** Parent work-item id for duplicate/child relationships (null clears on update). */
  parent?: string | null;
  /** Learning-signal provenance (frontier P-002/D-002). Default 'organic'; only
   *  frontier loops (vaccination drills, replay, shadow ablation) pass non-organic. */
  signalOrigin?: SignalOrigin;
  /**
   * Explicit id — used by the unified work_items:create path to mint a
   * kind-independent WI-NNN id (D-008). Omit for the legacy issues:create path,
   * which allocates the next EI-<n>.
   */
  id?: string;
  /**
   * Initial state (observation-lane-scorecard-classification-2026-08-16 D-002/D-005).
   * Default 'open'. 'done' files the row ALREADY-TERMINAL — for records that are
   * completed at creation by construction (a rubric scorecard emitted through
   * scorecards:emit is a finished verdict, not pending work). Note migration 698's
   * insert rule: a row arriving terminal carries an honest NULL closed_ts (its
   * created_at ≈ close time); only an UPDATE crossing the terminal boundary stamps one.
   */
  state?: 'open' | 'done';
  /**
   * Admission-gate state to be born with (plan work-queue-admission-and-bulk-dedup-2026-08-24,
   * P-002). 'pending' = born-pending, invisible to claim/place until the promoter judges
   * it; 'auto' = a filing-time bypass. Omit/null ⇒ the column stays NULL, which
   * {@link isAdmitted} reads as admitted (pre-gate back-compat).
   *
   * MUST ride in THIS INSERT, never a post-create UPDATE: an item that lands admitted
   * and is demoted a moment later is claimable in the gap, which is the entire failure
   * born-pending exists to prevent.
   *
   * Reaches the base table via the engineer_issues INSTEAD OF trigger, which carries
   * these three columns only as of migration 946 — before it, a named admission was
   * silently dropped and every issue-family item was born admitted.
   */
  admission?: BornAdmission | null;
  /**
   * WHY this item was admitted at filing time — recorded on `admitted_by` so the stats
   * ledger can tell the bypass classes apart (e.g. 'bypass:source-plan-slug',
   * 'bypass:severity-critical'). Ignored when `admission` is 'pending' or absent:
   * a pending item has not been admitted by anyone yet, so stamping an admitter would
   * be a false provenance record.
   */
  admittedBy?: string | null;
}

/** Create an issue: insert, tag topics, auto-subscribe the author, fan out. */
export async function createIssue(input: CreateIssueInput): Promise<EngineerIssue> {
  const created = nowIso();
  const inputPayload: Record<string, unknown> = input.payload ? { ...input.payload } : {};
  const storageKind = input.kind ?? 'bug';
  if (isFreshnessTrackedKind(storageKind) && inputPayload.freshnessEnvelope == null) {
    const build = getBuildInfo();
    const probation = inputPayload.toolFailureProbation as
      | { directEvidence?: boolean; report?: { schemaRevision?: string } }
      | undefined;
    inputPayload.freshnessEnvelope = createBugFreshnessEnvelope({
      now: created,
      sourceSha: build.sha,
      runtimeSha: build.sha,
      reporterSession: input.createdBy ?? null,
      reporterRuntimeVersion: build.version,
      toolSchemaVersion: probation?.report?.schemaRevision ?? null,
      lastSuccessfulReproductionAt: probation?.directEvidence ? created : null,
      deployBuildIdentity: build.sha ? `${build.sha}@${build.version}` : build.version,
      linkedFixRefs: [],
    });
  }
  // observation-candidate-acceptance-promotion D-009a (P-005): every issue-family
  // writer funnels through this insert, so this is the producer-enrollment seam.
  // A row that arrives without a verdict is enrolled `unknown` — never `ready` —
  // because no acceptance evidence exists yet. Claim floors treat this source as
  // the visible legacy exception until P-007 records the enforcement cutover.
  if (
    // Issue-family membership test (not a freshness check), written as a set
    // lookup so the freshness kind-gate's no-bare-literal guard stays exact.
    (['bug', 'change', 'task'] as const).includes(storageKind as 'bug' | 'change' | 'task') &&
    inputPayload.lane !== 'observation' &&
    !Object.prototype.hasOwnProperty.call(inputPayload, 'implementationReadiness')
  ) {
    inputPayload.implementationReadiness = createImplementationReadiness({
      status: 'unknown',
      source: 'creation-enrollment',
      reason: 'no-acceptance-evidence-at-creation',
      updatedAt: created,
    });
  }
  // unified-work-item-ledger P-001: a harness-attributable item must never be
  // silently filed operator-global via a missing/blank harness. operator stays
  // valid only as the EXPLICIT default; a malformed `harness:` (empty slug) throws.
  // allow-scope-default: 'operator' is the explicit top-level issue scope (vs harness:<slug>), not a workspace.
  let scope = input.scope ?? 'operator';
  assertScopeWellFormed(scope);
  // pot-membership-enforcement-2026-07-20 (P-005): every issue must belong to a REAL
  // Pot (owner directive — 2026-07-20 11:21). Resolve the scope's Pot: an
  // operator / workspace-global scope homes to the workspace platform Pot (so
  // `operator` issues are no longer stored under the non-pot `operator:<ws>` slug),
  // and an explicit `harness:<made-up>` is REJECTED (PotMembershipError). Flag-gated
  // (POT_MEMBERSHIP_ENFORCEMENT, default ON); fails open for an un-potted workspace.
  if (await getFlag(FLAGS.POT_MEMBERSHIP_ENFORCEMENT, 'system')) {
    const pot = await resolveWorkItemPot({
      rawSlug: harnessOfScope(scope),
      workspaceId: issuesScopeWorkspace(),
    });
    scope = pot ? harnessScope(pot) : 'operator';
  }
  // EI-9267: neutralize tool-call-lookalike tags (<invoke>/<parameter>/…) in the
  // free-text title/body BEFORE they are stored — the single choke point every
  // issue-family create path (improvements:capture, work_items:create) funnels
  // through, so a pasted-in or planted fake tool-call block can never later be
  // misread by a reading agent as a live continuation of its own tool stream.
  const safeTitle = sanitizePersistedText(neutralizeToolCallTags(input.title));
  const safeBody = sanitizePersistedText(neutralizeToolCallTags(input.body));
  const safeFoundDuring = sanitizePersistedText(input.foundDuring);
  // Admission gate (P-002). Derived once, here, so the three columns can never
  // disagree: an item is either born 'pending' with no admitter, or born admitted at
  // creation-time by a named bypass. `admitted_at`/`admitted_by` are stamped ONLY for
  // the non-pending case — a pending row that already carries an admitter reads, to
  // every later consumer and to the stats ledger, as an item somebody has judged.
  const bornAdmission: BornAdmission | null = input.admission ?? null;
  const bornAdmittedAt = bornAdmission && bornAdmission !== 'pending' ? created : null;
  const bornAdmittedBy = bornAdmission && bornAdmission !== 'pending' ? (input.admittedBy ?? null) : null;
  const sourcePlanSlug =
    typeof input.sourcePlanSlug === 'string' && input.sourcePlanSlug.trim() ? input.sourcePlanSlug.trim() : null;
  const sourcePlanItemIds = Array.isArray(input.sourcePlanItemIds)
    ? input.sourcePlanItemIds
        .filter((itemId): itemId is string => typeof itemId === 'string' && itemId.trim().length > 0)
        .map((itemId) => itemId.trim())
    : null;
  const issue = await boundedOrgTxn(async (tx) => {
    const id = input.id ?? (await nextIssueId(tx));
    const rows = await tx<IssueRowDb[]>`
      INSERT INTO harness_shared.engineer_issues
        (workspace_id, issue_id, kind, scope, title, body, severity, source, state, assignee,
         assigned_by, assigned_at, payload, found_during, created_by, signal_origin, created_at, updated_at,
         parent_id, source_plan_slug, source_plan_item_ids, admission, admitted_at, admitted_by)
      VALUES (${issuesScopeWorkspace()}, ${id}, ${input.kind ?? 'bug'}, ${scope}, ${safeTitle}, ${safeBody ?? ''},
              ${input.severity ?? 'minor'}, ${input.source ?? 'engineer'}, ${input.state ?? 'open'}, ${input.assignee ?? null},
              ${input.assignedBy ?? null}, ${input.assignedBy ? created : null},
              ${Object.keys(inputPayload).length > 0 ? JSON.stringify(inputPayload) : null}::text::jsonb, ${safeFoundDuring ?? null},
              ${input.createdBy ?? null}, ${input.signalOrigin ?? DEFAULT_SIGNAL_ORIGIN}, ${created}, ${created},
              ${input.parent ?? null}, ${sourcePlanSlug}, ${sourcePlanItemIds}::text[],
              ${bornAdmission}, ${bornAdmittedAt}, ${bornAdmittedBy})
      RETURNING ${tx.unsafe(ISSUE_COLS)}`;
    const inserted = toIssue(rows[0]);
    // The engineer_issues compatibility view exposes these claim-spec columns, but
    // its INSTEAD OF INSERT trigger predates that projection and does not thread them
    // into the base row. Keep the view write for the canonical create path, then fill
    // the indexed base columns in the SAME transaction so issue-family provenance is
    // durable without an externally visible create/update gap.
    if (sourcePlanSlug !== null || sourcePlanItemIds !== null) {
      await tx`
        UPDATE harness_shared.work_items
           SET source_plan_slug = ${sourcePlanSlug},
               source_plan_item_ids = ${sourcePlanItemIds}::text[]
         WHERE workspace_id = ${issuesScopeWorkspace()}
           AND feature_id = ${inserted.id}
           AND item_kind = ${input.kind ?? 'bug'}`;
    }
    // WI-8848: the topic tags + the author subscription commit in the SAME txn as the
    // INSERT. They used to run as bare awaits AFTER this txn had already committed, so
    // each was a fresh pool acquisition against an already-durable row — and a
    // [connect-phase-deadline] in either one threw to the caller while the issue row
    // existed. The caller cannot distinguish that from a total failure, so it retries
    // and DUPLICATES the filing (measured: EI-19448526819046979 was created while its
    // caller saw the error). Same atomicity fix, for the same reason, as the
    // thread/post write below ("no half-write a retry would duplicate").
    // Tx-bound stores reuse the exact tested store SQL on this txn's connection.
    if ((input.topics ?? []).length > 0) {
      const txTags = new PgTaggableStore({ ...coordOpts, getSql: () => tx });
      for (const topic of input.topics ?? []) {
        await txTags.addTag(issueRef(inserted.id), topic, {
          created_by: input.createdBy,
          created_ts: created,
        });
      }
    }
    if (input.createdBy) {
      const txSubs = new PgEntitySubscriptionStore({ ...coordOpts, getSql: () => tx });
      await txSubs.subscribe({
        subscriber_id: input.createdBy,
        target_kind: 'object',
        target_ref: `${ISSUE_KIND}:${inserted.id}`,
        delivery_mode: 'full',
        created_ts: created,
      });
    }
    return inserted;
  });
  const id = issue.id;

  // The ONLY post-commit step, and it provably cannot throw or hang: fanoutForObject is
  // try/catch-absorbed AND withDeadline(...,0)-bounded (fanout-projection.ts), precisely
  // so a fan-out can never break the write that triggered it. The author is excluded
  // EXPLICITLY via excludeId (not by virtue of subscribing after this call), so
  // auto-subscribing the author inside the txn above still does not notify them of
  // their own filing.
  await deliver(
    issue,
    'created',
    `issue ${id} filed (${issue.severity}): ${issue.title}`,
    input.createdBy ?? 'substrate',
  );
  return issue;
}

export interface ListIssuesFilter {
  state?: IssueState;
  /** D-041 (WI-10005358): see ListWorkItemsFilter.audience. Applied by issueShapeWhereSql. */
  audience?: WorkAudienceFilter;
  /** Case-insensitive literal substring matched against title + body. */
  q?: string;
  scope?: string;
  /**
   * Restrict to any of these exact scopes. `scope` wins when both are present;
   * an explicitly empty array matches nothing. This is the set-valued sibling
   * of `scope`, used by inherited pot scopes (selected pot + descendants)
   * without issuing one query per pot.
   */
  scopes?: readonly string[];
  assignee?: string;
  /** Durable delegator filter (collapse-delegate D-002): items this owner assigned. */
  assignedBy?: string;
  /** Restrict to issue-family rows whose parent work-item id matches exactly. */
  parent?: string;
  /**
   * When explicitly false, keep only top-level issue-family rows. Omitted preserves
   * the issue surface's historical all-rows behavior; the unified work-item facade
   * passes an explicit value to apply its top-level-by-default contract.
   */
  includeChildren?: boolean;
  severity?: IssueSeverity;
  /** Explicit severity set; `severity` wins when both are supplied. */
  severities?: readonly IssueSeverity[];
  kind?: IssueStoreKind; // bug | change | task
  /** Explicit kind set. Overrides the default (which restricts to the bug|change
   *  issue surface — `task` items never leak into issues:* unless asked for). */
  kinds?: readonly IssueStoreKind[];
  topic?: string; // issues tagged with this topic
  /**
   * Restrict to rows whose `lane` column equals this value — the CANONICAL way to
   * select the observation population (P-006 / D-031).
   *
   * ⚠ Prefer this over `topic: OBSERVATION_TOPIC`. They are NOT interchangeable, and
   * the topic form is lossy in BOTH directions. `lane` is a STORED GENERATED column
   * (`payload->>'lane'`, WI-6934) that lives ON the row; the topic form joins
   * `coord_links` fenced to `cl.workspace_id = coordScopeWorkspace()`. Measured on the
   * live box 2026-08-09, papercusp-workspace:
   *
   *   lane='observation'                      15,875 rows  (709 older than 30d)
   *   topic join, as this file actually runs it 15,074 rows  (20 of those 709)
   *
   * The 834-row symmetric difference:
   *   471  lane rows with NO tag edge anywhere (461 terminal, 5 open)
   *   330  lane rows whose edge is filed under workspace_id='default' — the legacy
   *        left behind when issues-engineer adopted coordScopeWorkspace() and the old
   *        edges never moved (EI-2760 / WI-4308). ALL 330 are >30d: a one-time cutover.
   *    33  rows tagged but with lane IS NULL, 6 of them OPEN — these were the harmful
   *        ones: `excludeObservationLane` keys on `lane`, so a lane-NULL observation is
   *        NOT excluded and sits in the triage queue as claimable `bug` work, which is
   *        exactly what D-005 says must never happen. Backfilled by migration.
   *
   * The tag is still WRITTEN on capture, but it is a label — not an identity.
   */
  lane?: string;
  /**
   * Exclude RUBRIC-GRADED rows — scorecards — in SQL
   * (observation-lane-scorecard-classification-2026-08-16 D-003/P-004). The predicate
   * is the CANONICAL scorecard discriminator (`payload->'observation'->>'rubricRef'
   * IS NOT NULL`) — the same key scorecards:list selects on — so INCLUDE (scorecards
   * surfaces) and EXCLUDE (raw-observation projections like the Observations pane)
   * can never disagree about what a scorecard is. Applied identically in listIssues,
   * countIssues, countIssuesByState and countObservationsByKind so the list, the
   * total, the state histogram and the kind histogram stay consistent (the WI-6934
   * parity contract).
   */
  excludeRubricGraded?: boolean;
  /**
   * WI-4532: restrict to WATCHDOG-KEYED rows (`payload.watchdogKey` present) in SQL.
   *
   * ⚠ This is a CORRECTNESS filter, not an optimization. This read is
   * `ORDER BY created_at DESC LIMIT n`, so a caller that wants "all watchdog items" and
   * post-filters in JS silently gets "watchdog items among the n NEWEST issues" — a
   * RECENCY WINDOW, not a set. Measured 2026-08-04 on the live box: 17,154 open
   * bug|change issues, so the auto-close sweep's `limit: 500` saw only the newest ~7.5
   * HOURS. Every watchdog item older than that was structurally invisible to the sweep
   * FOREVER — the alarm could be raised but never lowered, which is the exact defect
   * WI-4532 filed (a red-test EI sat open 9 days with 46 recorded passing runs).
   *
   * Raising the cap CANNOT fix it: ISSUES_MAX_LIMIT is 2000 against 17,154 open rows,
   * and the backlog grows. Only filtering in SQL turns the window back into a set
   * (measured: 59 rows, so the limit stops binding at all).
   */
  watchdogKeyed?: boolean;
  /**
   * WI-10005102: narrow a watchdog-keyed read to the rows a closing route can act on,
   * in SQL. Honoured only together with {@link watchdogKeyed}.
   *
   * WHY. `watchdogKeyed` alone stopped being a set. Measured 2026-10-01 on the live box:
   * 11,598 open watchdog-keyed rows (9,615 `repeated-tool-error`, ~1,300
   * `tool-failure-signature`), so the auto-close sweep's capped read saw only the newest
   * ~12 h again, which is the WI-4532 horizon one level down. Only 521 of those rows had
   * any closing route. A row is selected when ANY route can close it:
   *   - a source-level route (absence close, green-run resolution): the key's source
   *     prefix is in `closableSources`;
   *   - positive tool-failure repair: the payload carries
   *     `toolFailureProbation.repairEvidence`;
   * A closing route added to the sweep must be added here too, or its rows stay invisible.
   */
  watchdogCloseRoutes?: { closableSources: readonly string[] };
  /**
   * P-008 (db-performance-remediation-2026-07-26): omit `body` from the read for a
   * caller that never reads it. Default TRUE (unchanged behavior) — a reader opts OUT
   * explicitly, so a new caller can never silently lose a field it depends on.
   *
   * WHY IT IS WORTH A FLAG. Measured 2026-08-01 on the real hot statement (the
   * topic-filtered improvements read, LIMIT 500), EXPLAIN (ANALYZE, SERIALIZE) —
   * output size is deterministic, wall-clock on this box is not (D-005):
   *
   *   all columns            1607 kB   ~87 ms
   *   body dropped            389 kB   ~75 ms   <- this flag
   *   payload dropped        1450 kB   ~75 ms
   *   body + payload dropped  232 kB   ~71 ms
   *
   * `body` is 76% of the bytes. That is the whole prize on this read.
   *
   * ⚠ DO NOT "improve" this by slicing instead of dropping. `left(body, 400)` was
   * measured across four runs at ~90 ms — consistently SLOWER than shipping the whole
   * column (~87 ms) despite emitting 64% fewer bytes, because Postgres must detoast
   * the entire value to slice it and that CPU exceeds the serialization saved. Same
   * mechanism D-005 recorded for narrowing a jsonb column server-side; this measures
   * it for a scalar text column too. Only DROPPING avoids the detoast.
   */
  includeBody?: boolean;
  /**
   * Omit the JSONB payload from the returned row for callers that only need list
   * identity/state.  The WHERE clause still reads payload when a filter requires it;
   * this flag only controls the SELECT projection.  Defaults to included for
   * backwards compatibility and explicit/detail reads (WI-42508).
   */
  includePayload?: boolean;
  /**
   * Keep `payload.watchdogKey` alive across an `includePayload: false` read, as a
   * rebuilt one-field payload (see {@link ISSUE_COLS_BODYLESS_WATCHDOG_KEY_ONLY}).
   *
   * For a whole-corpus pass that must GROUP on the stable signal identity but reads
   * nothing else from payload — the recurrence census. Ignored when payload is kept
   * (the key is already there). No effect on the WHERE clause, only the projection.
   */
  includeWatchdogKey?: boolean;
  /**
   * P-008 (db-performance-remediation-2026-07-26): author + recency predicates, so a
   * caller wanting "how many did *I* file since T" can COUNT in Postgres instead of
   * listing rows and filtering in JS. Both orient hints
   * (orient-capture-miss-hint, orient-ideate-hint) were doing
   * `readObservationItems({})` — up to 500 full candidates including `body` and the
   * whole `payload` — and then `.filter(r => r.createdBy === me && r.createdAt > since).length`,
   * on EVERY orient across the fleet. That was ~931k calls at ~825 rows/call.
   * Applied identically in listIssues / countIssues / countIssuesByState so the
   * list, the total, and the histogram can never disagree (the WI-5512 parity rule).
   */
  createdBy?: string;
  /** ISO timestamp — rows created STRICTLY after it. Pairs with {@link createdBy}. */
  createdAfter?: string;
  /**
   * ISO timestamp — rows created STRICTLY before it (the {@link createdAfter} mirror).
   * WI-39455: the stale-tail selector. This read is `ORDER BY created_at DESC LIMIT n`,
   * so a consumer that wants "rows older than N days" (the hygiene age-out sweep) and
   * post-filters in JS gets a recency WINDOW, not a set — the WI-4532 class: every row
   * older than the newest-`limit` window is structurally invisible to it FOREVER
   * (measured 2026-08-16: 423 age-eligible rows, all below a 5,345-row open backlog's
   * newest-2000 window, so the sweep planned zero actions while the backlog grew).
   * Filtering in SQL turns the window back into a set. Applied identically in
   * listIssues + the count companions (the WI-5512 parity rule).
   */
  createdBefore?: string;
  /**
   * WI-38339 — `state` as a SET, for the question a single-valued `state` cannot ask.
   * Measured over 7d of real agent SQL on this box: 46 hand-written statements filtered
   * `state`/`status` with IN / NOT IN, and the dominant one is "everything not terminal"
   * (`status NOT IN ('done','resolved',…)`) — unanswerable one value at a time, so agents
   * hand-write the query forever. Empty array = no filter (never "match nothing"): an
   * empty IN-list would silently return zero rows, which reads as a real answer.
   *
   * ANDs with {@link state} when both are passed (`state` stays the single-value form for
   * every existing caller); use {@link notTerminal} for the negated set.
   */
  states?: readonly string[];
  /**
   * WI-38339 — the "everything still live" shorthand: excludes every state terminal in
   * EITHER family. DERIVED from {@link ANY_FAMILY_TERMINAL_STATES}, never re-listed here:
   * that constant's own doc records why (EI-18653071581558556 — hand-copied terminal sets
   * drifted, and since every consumer reads "not in the set ⇒ still active", finished work
   * was scored as stranded; ~88% of one live report was phantoms). Uses the cross-family
   * UNION rather than the issue-only set on purpose — a row carrying the other dialect's
   * terminal spelling is exactly the drift case this must not miss.
   */
  notTerminal?: boolean;
  /**
   * WI-38339 — INCLUSIVE created/updated window (`>=`), matching `plans:list`'s
   * established `createdSince`/`updatedSince` (plans/source.ts uses `created_at >= …`).
   *
   * ⚠ Deliberately NOT folded into {@link createdAfter}, which is EXCLUSIVE (`>`).
   * Re-pointing that field at `>=` would silently move an existing caller's boundary,
   * and mapping the new inclusive arg onto the exclusive column predicate would make one
   * `work_items:list` call apply different boundary semantics per family — the sort of
   * quiet inconsistency that is unfalsifiable from the result.
   */
  createdSince?: string;
  /** ISO timestamp — rows updated at or after it (INCLUSIVE). See {@link createdSince}. */
  updatedSince?: string;
  /**
   * WI-38339 — "what work came out of this plan", currently unanswerable without raw SQL
   * (37 hand-written statements over the 7d window). Both relations carry the column.
   */
  sourcePlanSlug?: string;
  /** Learning-signal provenance allowlist (frontier P-002/D-002). Omit = NO origin
   *  filter (the generic work-item surface shows everything); the LEARNING read
   *  seam (read-items.ts) is what defaults to organic-only. */
  signalOrigins?: readonly SignalOrigin[];
  /**
   * Restrict to an EXPLICIT set of issue ids (learning-tab-surface P-001).
   *
   * Exists because "the work the learning loop produced" is not expressible as a
   * column or a single tag — provenance is recorded in THREE places that disagree
   * (payload.sourceRole='Scout' 615 rows · the `improvement-source:Scout` topic 662 ·
   * a `scout_routed_ideas.routed_ref` row 585; union 823, measured 2026-07-27 → WI-6338).
   * The caller resolves that union once and passes the id set here.
   *
   * MUST be a SQL predicate rather than a post-hoc `.filter()` on the caller's side:
   * `limit` is applied in Postgres, so filtering after the fact would take the first
   * N of the UNFILTERED set and then shrink it — silently returning an arbitrary
   * fraction of the real answer.
   *
   * An EMPTY array matches NOTHING (`= ANY('{}')` is false for every row), mirroring
   * `readImprovementItems`' `harnessScopes` empty-set semantics: "a scope with no
   * members has no rows of its own", never "no filter".
   */
  issueIds?: readonly string[];
  limit?: number;
  /**
   * WI-3649: when true, exclude a federated (origin='remote') row — the issue-family
   * counterpart of `listWorkItems`'s feature-family `admissibleOnly` (EI-7841), applying
   * {@link isIssueLocallyClaimable}'s SAME predicate the actual claim path
   * (`claimIssue`'s engineer_issues_view_dml trigger, EI-7833) enforces. Default
   * false/omitted: byte-identical to before (every existing caller keeps seeing the
   * full backlog including remote-authored rows). Opt in for a SELF-SELECT consumer
   * (work_items:list's issue branch) so "claimable" actually means claimable.
   */
  admissibleOnly?: boolean;
  /**
   * fleet-leader-frictions P-005 (the issue-family leg of listWorkItems' audit).
   * EI-10867: the predicate now lives in ONE place ({@link auditWhereSql}) that both
   * families import, so the audit and the write path cannot key on different fields
   * again. P-006/D-003 deleted the 'no-evidence' bareness bucket (evidence is now
   * required at write time — see {@link CompletionAudit} for what survived and why).
   * Composes with an explicit `state`.
   *
   * EI-19320339017813143 widened this to {@link WorkItemAudit}: the STATE SCOPE now
   * travels with the bucket, because `worked-then-abandoned` is defined over OPEN rows
   * and every one of this file's nine call sites used to hard-code a terminal-only
   * clause. Always compose via {@link auditWhereSql} — a hand-written state clause here
   * would silently return zero rows for an open-scope bucket rather than failing.
   */
  audit?: WorkItemAudit;
  /**
   * P-013 — filter TERMINAL rows by the completion-authority judgement P-004 stamps
   * ({@link WorkItemCompletionAuthority}), or `'unjudged'` for a close that carries NO
   * judgement (the `authority` column IS NULL).
   *
   * This is the read half D-012 left open. P-006/D-003 deleted the `no-evidence` audit
   * bucket because evidence became a WRITE-time requirement — but that also removed the
   * only way to LIST under-evidenced closes after the fact. The judgement is now a column,
   * so the honest replacement is a filter over it, NOT a resurrected bareness sweep.
   *
   * `'unjudged'` is the load-bearing value, and it measures the INSTRUMENT rather than the
   * agents: only `work_items:complete` stamps an authority, so every close routed through
   * the bare `setWorkItemState` path lands NULL no matter how well evidenced it was (its
   * evidence goes to `terminal_completion_ref` instead). Measured 2026-07-27: 38.2% of that
   * day's agent closes were gate-judged, 0.1% the day before — so an `'unjudged'` hit means
   * "this close was never judged", NOT "this close was unevidenced". Do not read it as an
   * agent-compliance signal.
   *
   * Non-terminal rows never match (an open item owes no judgement yet), mirroring `audit`.
   */
  completionAuthority?: WorkItemCompletionAuthority | 'unjudged';
  /**
   * EI-10422: exclude a `payload.lane === 'observation'` row — a turn-end reflection /
   * rubric scorecard filed via `improvements:capture { lane:'observation' }` that, by
   * design (D-005), "never enters the work queue/triage/auto-implement — only Scout's
   * corpus-digest + the Observations pane read it". The self-select claim path
   * (claimNextIssueWorkItem, via observationLaneExclusionSql in work-items.ts) already
   * honors this; `listIssues`/`countIssues` did not, so 2,677 open observation notes
   * masqueraded as claimable `change` work in every backlog/triage read that goes
   * through `work_items:list`/`search`/`count` (EI-10422). Default false/omitted:
   * byte-identical to before (a caller that wants the raw issue store, unfiltered,
   * keeps seeing observations) — `listWorkItems`/`countWorkItems` pass this as `true`
   * by default (via `includeObservations`) so the GENERAL work-item surface excludes
   * them; a curation surface reads observations directly via
   * harness/improvements/read-items.ts, not this general path.
   */
  excludeObservationLane?: boolean;
  /**
   * WI-37499: restrict to rows whose `title` starts with this literal prefix.
   *
   * Exists because a DETECTOR's population is identified by the stable title it
   * mints, while `topic` selects on a DERIVED `coord_links` tag — and the two
   * disagree whenever a tag write is missing. Measured 2026-08-09 on the
   * `[replication-liveness]` detector: 60 of its 105 open rows carried no
   * `replication-liveness` topic edge at all, and that missing-tag set contained
   * 100% of the rows its orphan sweep exists to resolve (6, up to 34.8 days old)
   * AND 100% of its duplicate rows (12) — so dedup, the duplicate-collapse pass,
   * and the orphan sweep all went silently blind together, each reading the same
   * tag. A tag is an index over the population, never the definition of it; a
   * sweep that selects its own targets by index can under-select to ZERO and
   * report a clean pass.
   *
   * `LIKE prefix || '%'` with the prefix escaped, so a `%`/`_` in a caller's
   * literal prefix cannot widen the match. Intended to be UNIONed with the
   * `topic` read rather than to replace it — the tag is still authoritative for
   * the rows that carry it (measured: 4 tagged rows do NOT match the detector's
   * title prefix, so a prefix-only read would lose them).
   */
  titlePrefix?: string;
}

/**
 * The narrow filter used by {@link listIssueScopes}. It deliberately mirrors
 * only the population selectors needed by a per-scope learning read rather
 * than pretending to be a second implementation of every listIssues filter.
 */
export interface ListIssueScopesFilter {
  state?: IssueState;
  /** Case-insensitive literal substring matched against title + body. */
  q?: string;
  kind?: IssueStoreKind;
  kinds?: readonly IssueStoreKind[];
  severity?: IssueSeverity;
  severities?: readonly IssueSeverity[];
  scopes?: readonly string[];
  topic?: string;
  lane?: string;
  signalOrigins?: readonly SignalOrigin[];
  issueIds?: readonly string[];
}

/**
 * Return the distinct scopes represented by a population before applying a
 * recency window. A global `ORDER BY created_at DESC LIMIT n` cannot discover
 * older scopes, which makes any subsequent JS grouping a recency window across
 * the whole corpus rather than a window per scope (WI-9454).
 */
export async function listIssueScopes(filter: ListIssueScopesFilter = {}): Promise<string[]> {
  const { sql } = getOrgPg();
  const q = filter.q?.trim();
  const kindSet: readonly IssueStoreKind[] = filter.kind ? [filter.kind] : (filter.kinds ?? ISSUE_KINDS);
  const topicTagsCte = filter.topic
    ? sql`WITH tagged AS MATERIALIZED (
            SELECT cl.src_ref
              FROM harness_shared.coord_links cl
             WHERE cl.workspace_id = ${coordScopeWorkspace()}
               AND cl.rel = 'tagged'
               AND cl.src_kind = ${ISSUE_KIND}
               AND cl.dst_kind = 'topic'
               AND cl.dst_ref = ${filter.topic}
          )`
    : sql``;
  const rows = await sql<{ scope: string }[]>`
    ${topicTagsCte}
    SELECT DISTINCT ei.scope
      FROM harness_shared.engineer_issues ei
     WHERE ei.workspace_id = ${issuesScopeWorkspace()}
       AND ei.kind = ANY(${kindSet as string[]}::text[])
      AND ${filter.state ? sql`ei.state = ${filter.state}` : sql`TRUE`}
      AND ${q ? sql`(COALESCE(ei.title, '') ILIKE ${likeContainsPattern(q)} ESCAPE '\\' OR COALESCE(ei.body, '') ILIKE ${likeContainsPattern(q)} ESCAPE '\\')` : sql`TRUE`}
      AND ${filter.scopes ? sql`ei.scope = ANY(${filter.scopes as string[]}::text[])` : sql`TRUE`}
      AND ${filter.severities ? sql`ei.severity = ANY(${filter.severities as string[]}::text[])` : sql`TRUE`}
      AND ${filter.signalOrigins ? sql`ei.signal_origin = ANY(${filter.signalOrigins as string[]}::text[])` : sql`TRUE`}
       AND ${filter.issueIds ? issueIdsWhereSql(sql, true, filter.issueIds) : sql`TRUE`}
       AND ${filter.topic ? sql`ei.issue_id IN (SELECT src_ref FROM tagged)` : sql`TRUE`}
       AND ${filter.lane ? sql`ei.lane = ${filter.lane}` : sql`TRUE`}
     ORDER BY ei.scope ASC`;
  return rows.map((row) => row.scope);
}

/** WI-37499: `LIKE`-escape a literal prefix so `%`/`_`/`\` in it match literally. */
function likePrefixPattern(prefix: string): string {
  return `${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** work-items:list q: escape LIKE metacharacters for literal substring matching. */
function likeContainsPattern(query: string): string {
  return `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

// Issue-family terminal states for the P-005 audit are imported from the canonical
// work-item-dispatch-states module (EI-18653071581558556 — this was a local literal;
// the same set hand-copied elsewhere had already drifted).

/**
 * WI-4405: the issue-family `admissibleOnly` floor set, extended past the original
 * federated-origin-only gate to also mirror the real self-select claim path's floors
 * (claimNextIssueWorkItem, work-items.ts) that a generic backlog read never applied —
 * the D-005 observation-lane note (observationLaneExclusionSql), a peer's explicit
 * claim-hold (claimHoldExclusionSql), a row requiring a strict owner capability
 * (needsOwnerActionExclusionSql), and a row reserved to an ACTIVELY-driven plan
 * lane / a live plan_item_claims lease (reservedPlanLaneExclusionSql). ROOT CAUSE of a
 * 3-member idle fleet (bug-drain-nonp2p, 2026-07-12): a leader fed a 3-item tranche
 * (EI-10375 observation-lane, WI-3868/WI-4147 plan-reserved) that `admissibleOnly:true`
 * reported as claimable — measured live: 41 rows with admissibleOnly, 41 without, i.e.
 * it filtered NOTHING for that tranche — while `scheduler:get_next` correctly refused
 * all three. "Admissible" now actually means "the claim path would let this be
 * claimed" instead of only "not federated".
 *
 * Deliberately does NOT attempt the readiness/blocking-dep floor, swarm-affinity, or
 * redundancy exclusion here — those need a live bee/claim context (assignee, swarmId)
 * a generic listing read doesn't have, and are lower-value for a "would anyone ever be
 * able to claim this" read than the four unconditional per-row floors above.
 *
 * `aliased` selects the unaliased (bare `engineer_issues` table) vs `ei.`-prefixed
 * (topic-joined subqueries) column form — every call site here uses one or the other.
 */
/**
 * The {@link ListIssuesFilter.issueIds} predicate, in ONE place so the six
 * call sites (list / count / countByState, each in an unaliased and an
 * `ei.`-aliased form) cannot drift apart — the WI-5512 parity rule this file
 * states for `createdBy`/`createdAfter` applies identically here: the list, the
 * total and the histogram must never disagree about what the filter means.
 *
 * `aliased` selects the `ei.`-prefixed column form used inside the topic-joined
 * subqueries, matching {@link issueAdmissibleWhereSql}.
 */
function issueIdsWhereSql(sql: OrgSql, aliased: boolean, ids: readonly string[]) {
  return aliased ? sql`ei.issue_id = ANY(${ids as string[]}::text[])` : sql`issue_id = ANY(${ids as string[]}::text[])`;
}

/**
 * WI-38339 — the SHAPE filters (state SET / notTerminal / created+updated window /
 * source plan) as ONE fragment, so `listIssues` and every COUNT companion apply a
 * byte-identical predicate.
 *
 * A single shared builder rather than the predicate written out at each site, because
 * these filters land at EIGHT call sites here (listIssues, countIssues ×2,
 * countIssuesByState ×2, countObservationsByKind ×2, plus the aliased topic-join
 * variants) and the WI-5512 parity rule already governs them: a predicate applied to a
 * list but missed by its count makes "N of TOTAL" quietly wrong — the numerator honest,
 * the denominator not. Hand-repeating four new predicates across eight sites is a
 * coin-flip per site, and the failure is SILENT (a plausible number, never an error).
 *
 * `aliased` selects the `ei.`-prefixed column form used inside the topic-joined
 * subqueries, matching {@link issueIdsWhereSql} / {@link issueAdmissibleWhereSql}.
 *
 * Returns `TRUE` when no shape filter is set, so a call site can AND it unconditionally.
 */
export function issueShapeWhereSql(sql: OrgSql, aliased: boolean, filter: ListIssuesFilter) {
  const col = (c: string) => sql.unsafe(aliased ? `ei.${c}` : c);
  // An EMPTY `states` array is NO filter, never "match nothing": `= ANY('{}')` is false for
  // every row, so an empty list would return zero rows — indistinguishable from a genuine
  // empty result, which is the failure direction a caller cannot detect.
  const states = filter.states && filter.states.length > 0 ? filter.states : null;
  return sql`
    ${states ? sql`${col('state')} = ANY(${states as string[]}::text[])` : sql`TRUE`}
    AND ${
      filter.notTerminal
        ? sql`NOT (${col('state')} = ANY(${ANY_FAMILY_TERMINAL_STATES as string[]}::text[]))`
        : sql`TRUE`
    }
    AND ${filter.createdSince ? sql`${col('created_at')} >= ${filter.createdSince}::timestamptz` : sql`TRUE`}
    AND ${filter.updatedSince ? sql`${col('updated_at')} >= ${filter.updatedSince}::timestamptz` : sql`TRUE`}
    AND ${
      filter.sourcePlanSlug
        ? sql`(
            ${col('source_plan_slug')} = ${filter.sourcePlanSlug}
            OR ${col('payload')} -> 'plan_item' ->> 'plan_slug' = ${filter.sourcePlanSlug}
          )`
        : sql`TRUE`
    }
    AND ${
      filter.parent
        ? sql`${col('parent_id')} = ${filter.parent}`
        : filter.includeChildren === false
          ? sql`(${col('parent_id')} IS NULL OR ${col('parent_id')} = '')`
          : sql`TRUE`
    }
    AND ${audienceWhereSql(sql, filter.audience, aliased ? 'ei' : null)}`;
}

/**
 * WI-564691 — the MATCH filters (free-text `q`, severity, stable-title prefix,
 * observation-lane exclusion, watchdog-key restriction) as ONE fragment, so the row
 * read and every COUNT companion apply a byte-identical predicate.
 *
 * This is {@link issueShapeWhereSql}'s rule applied to the predicates that had already
 * drifted. Measured 2026-08-29 across the five `ListIssuesFilter` readers, FIVE fields
 * were honoured by some sites and silently dropped by others:
 *
 *                           listIssues  countIssues  byState  bySourceRole  byKind
 *   q                           ✓            ✓          ✗          ✓          ✗
 *   severities                  ✓            ✓          ✗          ✓          ✗
 *   titlePrefix                 ✓            ✓          ✓          ✓          ✗
 *   excludeObservationLane      ✓            ✓          ✓          ✓          ✗
 *   watchdogKeyed               ✓            ✗          ✗          ✗          ✗
 *
 * `q` is the one that reached a caller. `issues:list { q, rollup:'state' }` passes `q`
 * straight through, so the rollup counted the WHOLE issue population while row mode
 * counted 8 — the same filter answering two ways, ~16,000x apart, with no error to
 * notice. What makes that shape dangerous is that it was q-ONLY: severity/kind/scope
 * DID narrow the rollup, so sanity-checking the surface with any other filter returned
 * a correct-looking answer and licensed trusting the broken one.
 *
 * The {@link countIssuesBySourceRole} docblock had ALREADY recorded that byState "omits
 * `q` and `severities`, which is safe for its callers". That safety was a fact about the
 * callers of the day, not a property of the function — and adding one caller that
 * accepts `q` silently invalidated it without touching the SQL. A predicate set that is
 * correct only for the current caller list is not a contract, which is why this is a
 * shared fragment rather than a sixth hand-maintained copy.
 *
 * `aliased` selects the `ei.`-prefixed column form used inside the topic-joined
 * subqueries, matching {@link issueShapeWhereSql} / {@link issueIdsWhereSql}.
 *
 * Returns `TRUE` when no match filter is set, so a call site can AND it unconditionally.
 * Parity is enforced mechanically by issues-engineer-filter-parity.test.ts.
 */
export function issueMatchWhereSql(sql: OrgSql, aliased: boolean, filter: ListIssuesFilter) {
  const col = (c: string) => sql.unsafe(aliased ? `ei.${c}` : c);
  const q = filter.q?.trim();
  return sql`
    ${
      q
        ? sql`(COALESCE(${col('title')}, '') ILIKE ${likeContainsPattern(q)} ESCAPE '\\' OR COALESCE(${col('body')}, '') ILIKE ${likeContainsPattern(q)} ESCAPE '\\')`
        : sql`TRUE`
    }
    AND ${
      filter.severity
        ? sql`${col('severity')} = ${filter.severity}`
        : filter.severities
          ? sql`${col('severity')} = ANY(${filter.severities as string[]}::text[])`
          : sql`TRUE`
    }
    -- WI-37499: stable-title prefix (see ListIssuesFilter.titlePrefix).
    AND ${filter.titlePrefix ? sql`${col('title')} LIKE ${likePrefixPattern(filter.titlePrefix)} ESCAPE '\\'` : sql`TRUE`}
    -- The observation-lane floor, applied wherever the caller opts in (listWorkItems
    -- does, by default, via includeObservations).
    AND ${filter.excludeObservationLane ? sql`${col('lane')} IS DISTINCT FROM 'observation'` : sql`TRUE`}
    -- WI-4532: watchdog-keyed restriction (see ListIssuesFilter.watchdogKeyed). Must be
    -- applied HERE, not in JS after the read: a row read's ORDER BY/LIMIT would make a
    -- JS post-filter a recency window rather than a set.
    AND ${filter.watchdogKeyed ? sql`${col('payload')}->>'watchdogKey' IS NOT NULL` : sql`TRUE`}
    -- WI-10005102: closing-route restriction (see ListIssuesFilter.watchdogCloseRoutes).
    -- Same reason as the line above: in SQL, or the LIMIT makes it a recency window.
    AND ${
      filter.watchdogKeyed && filter.watchdogCloseRoutes
        ? sql`(
            split_part(${col('payload')}->>'watchdogKey', ':', 1)
              = ANY(${filter.watchdogCloseRoutes.closableSources as string[]}::text[])
            OR ${col('payload')}->'toolFailureProbation'->'repairEvidence' IS NOT NULL
          )`
        : sql`TRUE`
    }`;
}

/**
 * Render the watchdog recovery-window floor against the engineer_issues view.
 *
 * `work-items.ts` owns the real claim helper, but it imports this module for the
 * issue facade, so importing that helper back would create a runtime cycle. Keep
 * this view-form renderer structurally identical and cover both forms against
 * real rows in issue-admissible-branch-equivalence.integration.test.ts.
 *
 * The qualifier is an internal literal (`''` or `'ei.'`), never caller input.
 */
function watchdogRecoveryWindowExclusionSqlForIssueView(sql: OrgSql, qualifier: string) {
  const eligibleSources = [...AUTO_CLOSE_ELIGIBLE_SOURCES];
  const minTicks = AUTO_CLOSE_DEFAULT_MIN_TICKS;
  const watchdogKey = `${qualifier}payload ->> 'watchdogKey'`;
  const workspaceId = `${qualifier}workspace_id`;
  return sql`(
    ${sql.unsafe(watchdogKey)} IS NULL
    OR btrim(${sql.unsafe(watchdogKey)}) = ''
    OR position(':' IN ${sql.unsafe(watchdogKey)}) <= 1
    OR btrim(substring(
         ${sql.unsafe(watchdogKey)}
         FROM position(':' IN ${sql.unsafe(watchdogKey)}) + 1
       )) = ''
    OR split_part(${sql.unsafe(watchdogKey)}, ':', 1) <> ALL(${eligibleSources}::text[])
    OR NOT (
      SELECT count(*) = ${minTicks}
         AND count(recovery_ticks.known_open_keys) = ${minTicks}
         AND count(*) FILTER (
               WHERE ${sql.unsafe(watchdogKey)} = ANY(recovery_ticks.known_open_keys)
             ) = 0
        FROM (
          SELECT wt.known_open_keys
            FROM harness_shared.watchdog_ticks wt
           WHERE wt.workspace_id = ${sql.unsafe(workspaceId)}
             AND wt.status = 'ran'
           ORDER BY wt.tick_at DESC, wt.id DESC
           LIMIT ${minTicks}
        ) recovery_ticks
    )
  )`;
}

/**
 * WI-37827: exported ONLY so the runtime equivalence guard
 * (`issue-admissible-branch-equivalence.integration.test.ts`) can evaluate the real
 * fragment each column form returns against real rows, rather than regexing the SQL
 * out of this file's source — a source-text guard would go false-green the moment the
 * branches stopped being two written-out literals, which is exactly what this item did
 * to them. Not part of the module's intended API; call sites live in this file.
 * Same precedent as get-next.ts exporting ALL_ISSUE_CLAIM_FLOORS_PASS for its own guard.
 */
export function issueAdmissibleWhereSql(sql: OrgSql, aliased: boolean) {
  // WI-6934/EI-19286331042101069: the lane leg filters the STORED generated column
  // (migration 721), not the payload jsonb — mirrors observationLaneExclusionSql
  // (work-items.ts). Any `payload ->> 'lane'` here forces the whole payload datum to
  // be fetched and decompressed (payload/_search are large and out-of-line) for every
  // candidate row. WI-7102 / migration 1110 subsequently materialised the two top-level
  // boolean floors (_claimHold and needsOwnerAction) by the same mechanism; this predicate
  // reads their physical columns below. The nested plan_item / externalBlockers shapes and
  // derived created_by still require payload and remain separate follow-up territory rather
  // than silently widening this migration. Same NULL-safety as the COALESCE
  // form: `lane` is NULL both when payload is NULL and when the key is absent, and
  // `NULL IS DISTINCT FROM 'observation'` = TRUE ⇒ included (never excluded).
  //
  // WI-37761: the federation-detector floor. WI-2633 gates auto-filed
  // `[replication-liveness]` detector EIs out of the CLAIM floors
  // (federationDetectorExclusionSql, work-items.ts) and states that gate is
  // "UNCONDITIONAL (no caller bypass): no GENERIC self-select caller legitimately
  // wants one" — but `admissibleOnly` never mirrored it, so every read on this path
  // still ADVERTISED them. Measured live: `coord:orient { intent }` (no `harness`)
  // takes the `work_items:list({ admissibleOnly:true })` leg, and returned a
  // claimable list of 8 containing 2 detector EIs (EI-20083218992626765,
  // EI-20083218888012602) — 97 open rows carry this filer today. The rows are
  // origin='local' with lane NULL, so none of the floors above can catch them.
  //
  // ⚠ COST: `created_by` is NOT a cheap column. engineer_issues is a VIEW over
  // work_items and derives it as `(payload -> '_ei') ->> 'created_by'` (verified
  // against pg_get_viewdef in prod AND test/_work-items-schema.ts — they agree), so
  // this floor touches the same out-of-line payload datum as the `_claimHold` /
  // remaining plan_item / externalBlockers floors below. Do not "optimize" it on the belief
  // that it is a plain column — it is derived from the same TOASTed payload and needs its own
  // generated-column migration + equivalence proof if it moves later.
  //
  // Deriving it from payload is also what makes this floor AGREE BY CONSTRUCTION with
  // federationDetectorExclusionSql (work-items.ts), which reads
  // `wi.payload #>> '{_ei,created_by}'` on the base table — the same datum by another
  // path, so the advertise floor and the claim floor cannot drift apart.
  // The literal is hardcoded rather than imported from RECOVERY_OWNER
  // (sync/hyperbee/replication-stall-ei.ts) because that module FILES issues and so
  // imports this one — importing back would cycle. Same precedent, same reason, as
  // harness/improvements/policy.ts and work-items.ts's own copy.
  //
  // WI-37774: the remaining THREE row-intrinsic claim floors — found by AUDITING the
  // siblings of WI-37761's gap rather than waiting to hit each one. A floor meaning
  // "agents must never get this" has TWO sides — cannot-CLAIM (claimNextIssueWorkItem)
  // and is-not-OFFERED (here) — and each of these was implemented only on the claim side:
  //   - loop-noise (EI-8802, loopIterationNoiseExclusionSql)
  //   - already-terminally-completed (EI-8972, alreadyTerminallyCompletedExclusionSql)
  //   - an ACTIVE typed external blocker (externalBlockersExclusionSql)
  // Every one of those helpers takes ONLY `sql` — no assignee/rigAvailable/swarmId — so
  // they are exactly the "unconditional per-row floors" the WI-4405 contract above already
  // claims to mirror, NOT the readiness/rig/cooldown/swarm/redundancy floors it
  // deliberately omits for needing live claim context. They were missed, not excluded.
  //
  // Measured before the fix (workspace papercusp, state=open, unassigned, passing all six
  // then-current floors): 1517 advertised, of which 14 loop-noise + 1 active-external-blocker
  // + 0 already-completed = 15 rows this path OFFERED and the claim path REFUSED. The
  // loop-noise count independently reproduces EI-19452326548245557's own 2026-08-04 census
  // ("loopNoise (14)"), measured from the other direction. `already-completed` being 0 today
  // is why it is added on this pass rather than when it first bites — it is the one of the
  // three that can appear at any moment.
  //
  // ⚠ This does NOT make `admissibleOnly` the claim verdict, and the flag's description must
  // keep saying so: blocked-dep / rig / cooldown / swarm-affinity / redundancy still are not
  // (and cannot be) evaluated here. `work_items:claimable` remains the only full oracle.
  //
  // ⚠ COST: none of the three adds a datum fetch. `title`, `terminal_owner`,
  // `terminal_completion_ref` and `authority` are real in-line columns on this view, and
  // `title` is already in ISSUE_COLS; the jsonb_path_exists touches the SAME out-of-line
  // payload datum the created_by / plan_item floors still force. The ILIKE pair is the same
  // predicate, at the same cost, the claim path already runs on this table.
  //
  // ⚠ The helpers are written `wi.`-prefixed against the base work_items TABLE, so they are
  // RESTATED here in the view's column form rather than imported — the same deliberate
  // duplication as the other base-table claim floors. `externalBlockers` survives the
  // view's `payload - '_ei'` subtraction because it is a TOP-LEVEL payload key, not an _ei
  // sub-field (verified against WI-5107's live payload).
  // WI-37827: ONE definition, rendered in the caller's column form. These two forms were
  // hand-maintained as two literals until 2026-08-10; measured then, the aliased text with
  // every `ei.` stripped was BYTE-IDENTICAL to the unaliased one (1128 vs 1074 chars, 18
  // prefixes and nothing else), so every floor above had to be stated — and edited — twice.
  // WI-37774 added three floors to both branches by hand for exactly that reason.
  //
  // `c` is the column qualifier, NOT caller input: a hardcoded literal chosen by a boolean,
  // so the `sql.unsafe` here carries the same safety argument as get-next.ts's
  // `${sql.unsafe(ALL_ISSUE_CLAIM_FLOORS_PASS)}` — pure column identifiers, zero bound
  // values (every literal in this predicate is inline), nothing interpolated from a caller.
  // It qualifies only the columns of the row under test; `hp.` / `pic.` inside the plan
  // subqueries belong to those subqueries' own FROM and are deliberately left alone.
  //
  // GUARDED BY `issue-admissible-branch-equivalence.integration.test.ts`, which evaluates
  // BOTH forms against real seeded rows and asserts they admit the same id set — a runtime
  // check, so it survives this refactor and any later one. A source-text guard was
  // considered and rejected: it would have gone false-green the moment this became a
  // rendering rather than two written-out literals, i.e. precisely here.
  const c = aliased ? 'ei.' : '';
  const base = sql.unsafe(`(
        (${c}origin = 'local' OR ${c}origin IS NULL)
        AND ${c}lane IS DISTINCT FROM 'observation'
        AND ${c}created_by IS DISTINCT FROM 'system:replication-liveness'
        AND ${c}claim_hold IS DISTINCT FROM TRUE
        AND ${c}needs_owner_action IS DISTINCT FROM TRUE
        AND COALESCE(${c}title, '') NOT ILIKE 'Loop wake #%'
        AND COALESCE(${c}title, '') NOT ILIKE 'AUTO loop iteration:%'
        AND (
          (${c}terminal_owner IS NULL OR ${c}terminal_owner = '')
          OR (
            (${c}terminal_completion_ref IS NULL OR ${c}terminal_completion_ref = '')
            AND ${c}authority IS NULL
          )
        )
        AND NOT EXISTS (
          SELECT 1
            FROM jsonb_path_query(
              COALESCE(${c}payload, '{}'::jsonb),
              '$.externalBlockers[*]'::jsonpath
            ) blocker
           WHERE lower(COALESCE(blocker ->> 'status', '')) = 'active'
        )
        AND NOT (
          COALESCE(${c}payload, '{}'::jsonb) ? 'plan_item' AND (
            EXISTS (
              SELECT 1 FROM harness_shared.harness_plans hp
               WHERE hp.plan_slug = ${c}payload->'plan_item'->>'plan_slug'
                 AND hp.status = 'active'
            )
            OR EXISTS (
              SELECT 1 FROM harness_shared.plan_item_claims pic
               WHERE pic.plan_slug = ${c}payload->'plan_item'->>'plan_slug'
                 AND pic.item_id  = ${c}payload->'plan_item'->>'item_id'
                 AND pic.expires_ts > now()
            )
          )
        )
      )`);
  return sql`(
    ${base}
    AND ${admittedWhereSql(sql, aliased ? 'ei' : undefined)}
    AND ${watchdogRecoveryWindowExclusionSqlForIssueView(sql, c)}
    AND ${agentReviewNormalExclusionSql(sql, aliased ? 'ei.payload' : 'payload', 'engineer_issues')}
  )`;
}

async function listIssuesWithLimit(filter: ListIssuesFilter, rowLimit: number | null): Promise<EngineerIssue[]> {
  const { sql } = getOrgPg();
  // Kind gate: an explicit single `kind`, else an explicit `kinds` set, else the
  // default = ISSUE_KINDS (bug|change) so `task` work-items never surface as issues.
  const kindSet: readonly IssueStoreKind[] = filter.kind ? [filter.kind] : (filter.kinds ?? ISSUE_KINDS);
  // Topic membership is resolved ONCE, behind a MATERIALIZED optimization fence.
  //
  // ⚠ DO NOT "simplify" this back to a correlated `EXISTS (... cl.src_ref =
  // engineer_issues.issue_id)` in the WHERE clause. That is what this used to be,
  // and combined with the `ORDER BY created_at DESC LIMIT n` below it made the
  // planner believe it could stop early, so it chose a nested-loop semi-join and
  // re-ran the tag probe ONCE PER CANDIDATE ROW. Measured on the live box
  // 2026-08-03 (WI-9252), papercusp-observation topic, LIMIT 500:
  //
  //   correlated EXISTS   111,909 buffers, coord_links loops = 16,984, ~424ms
  //   explicit JOIN       111,909 buffers, loops = 16,984  (planner flattens it — NOT a fix)
  //   IN (uncorrelated)   111,909 buffers, loops = 16,984  (also flattened — NOT a fix)
  //   WITH ... MATERIALIZED 58,054 buffers, loops = 1,      ~290ms   ← this
  //
  // Only an optimization FENCE changes the plan; EXISTS/IN/JOIN are all rewritten
  // to the same semi-join. Row sets verified identical across all four (14,805
  // rows, zero asymmetric difference), and `coord_links.src_ref` is NOT NULLable
  // in practice (0 of 33,071 tag edges), so IN and EXISTS agree on NULL semantics.
  //
  // countIssues below keeps its plain JOIN deliberately: it has no ORDER BY/LIMIT,
  // so the planner already picks a hash join there (measured loops = 1).
  //
  // (Resolving the refs into a JS array and passing them back via ANY() is the
  // OTHER wrong answer — that shipped ~7K ids out of PG and back on every
  // learning.improvements read, WI-5412. This keeps the set server-side.)
  const topicTagsCte = filter.topic
    ? sql`WITH tagged AS MATERIALIZED (
            SELECT cl.src_ref
              FROM harness_shared.coord_links cl
             WHERE cl.workspace_id = ${coordScopeWorkspace()}
               AND cl.rel = 'tagged'
               AND cl.src_kind = ${ISSUE_KIND}
               AND cl.dst_kind = 'topic'
               AND cl.dst_ref = ${filter.topic}
          )`
    : sql``;
  const rows = await sql<IssueRowDb[]>`
    ${topicTagsCte}
    SELECT ${sql.unsafe(issueListColumns(filter))}
      FROM harness_shared.engineer_issues
     WHERE workspace_id = ${issuesScopeWorkspace()}
       AND kind = ANY(${kindSet as string[]}::text[])
       AND ${filter.state ? sql`state = ${filter.state}` : sql`TRUE`}
       AND ${
         filter.scope
           ? sql`scope = ${filter.scope}`
           : filter.scopes
             ? sql`scope = ANY(${filter.scopes as string[]}::text[])`
             : sql`TRUE`
       }
       AND ${filter.assignee ? sql`assignee = ${filter.assignee}` : sql`TRUE`}
       AND ${filter.assignedBy ? sql`assigned_by = ${filter.assignedBy}` : sql`TRUE`}
       AND ${issueMatchWhereSql(sql, false, filter)}
       AND ${filter.signalOrigins ? sql`signal_origin = ANY(${filter.signalOrigins as string[]}::text[])` : sql`TRUE`}
       AND ${filter.createdBy ? sql`created_by = ${filter.createdBy}` : sql`TRUE`}
       AND ${filter.createdAfter ? sql`created_at > ${filter.createdAfter}::timestamptz` : sql`TRUE`}
       AND ${filter.createdBefore ? sql`created_at < ${filter.createdBefore}::timestamptz` : sql`TRUE`}
       AND ${issueShapeWhereSql(sql, false, filter)}
       AND ${filter.issueIds ? issueIdsWhereSql(sql, false, filter.issueIds) : sql`TRUE`}
       AND ${filter.topic ? sql`issue_id IN (SELECT src_ref FROM tagged)` : sql`TRUE`}
       AND ${filter.admissibleOnly ? issueAdmissibleWhereSql(sql, false) : sql`TRUE`}
       AND ${
         filter.audit
           ? auditWhereSql(sql, filter.audit, { stateColumn: 'state', terminalStates: ISSUE_TERMINAL_STATES })
           : sql`TRUE`
       }
       -- P-013: the completion-authority read half (see ListIssuesFilter.completionAuthority).
       -- Scoped to TERMINAL rows for the same reason the audit filter is: a non-terminal row
       -- has no close to judge, so an open row must never answer an 'unjudged' query —
       -- otherwise the whole open backlog (authority NULL by construction) floods the result
       -- and the filter reads as catastrophic under-evidencing instead of measuring closes.
       AND ${
         filter.completionAuthority
           ? sql`(state = ANY(${ISSUE_TERMINAL_STATES as string[]}::text[]) AND ${completionAuthorityPredicateSql(sql, filter.completionAuthority)})`
           : sql`TRUE`
       }
       -- P-006/D-031: positive lane selection — the canonical observation-population
       -- read. Same stored generated column the exclusion above keys on, so INCLUDE and
       -- EXCLUDE can never disagree about what "the observation lane" is.
       AND ${filter.lane ? sql`lane = ${filter.lane}` : sql`TRUE`}
       AND ${filter.excludeRubricGraded ? sql`(payload -> 'observation' ->> 'rubricRef') IS NULL` : sql`TRUE`}
     ORDER BY created_at DESC
     ${rowLimit === null ? sql`` : sql`LIMIT ${rowLimit}`}`;
  return rows.map(toIssue);
}

export async function listIssues(filter: ListIssuesFilter = {}): Promise<EngineerIssue[]> {
  return listIssuesWithLimit(filter, Math.min(filter.limit ?? 100, ISSUES_MAX_LIMIT));
}

/**
 * Complete issue-family read for a file exporter. Normal/UI reads must use
 * {@link listIssues}, whose per-read ceiling protects response and render cost.
 * This path is intentionally not exposed as an agent tool: its caller writes
 * rows to files and returns only counts, so no unbounded result crosses the
 * model transport.
 */
export async function listAllIssuesForFileExport(filter: ListIssuesFilter = {}): Promise<EngineerIssue[]> {
  return listIssuesWithLimit(filter, null);
}

/**
 * Run an internal whole-corpus issue read while enforcing a bounded result at
 * the seam that hands data back to a caller.
 *
 * The ordinary {@link listIssues} ceiling protects UI/model transports, while
 * a few server-side reads genuinely need the complete population to classify,
 * filter, aggregate, and then return a small projection. Historically the only
 * complete reader was named for file export, which tempted those callers either
 * to reuse a misleading surface or to grow the public list limit. This callback
 * form keeps the unbounded array inside this module's call stack and rejects a
 * projector that tries to leak more than its declared bound.
 *
 * The callback may return rows or a one-row aggregate envelope. It must not
 * retain the input array after it resolves.
 */
export async function projectAllIssuesForBoundedRead<T>(
  filter: ListIssuesFilter,
  opts: {
    /** Maximum number of projected rows allowed to leave this seam. */
    maxRows: number;
    project: (issues: readonly EngineerIssue[]) => Promise<readonly T[]> | readonly T[];
  },
): Promise<T[]> {
  if (!Number.isSafeInteger(opts.maxRows) || opts.maxRows < 0) {
    throw new RangeError('projectAllIssuesForBoundedRead: maxRows must be a non-negative safe integer');
  }
  const issues = await listIssuesWithLimit(filter, null);
  const projected = await opts.project(issues);
  if (!Array.isArray(projected)) {
    throw new TypeError('projectAllIssuesForBoundedRead: projector must return an array');
  }
  if (projected.length > opts.maxRows) {
    throw new RangeError(
      `projectAllIssuesForBoundedRead: projector returned ${projected.length} rows (max ${opts.maxRows})`,
    );
  }
  return [...projected];
}

/**
 * COUNT companion to {@link listIssues} — the true total for the same filter,
 * minus order/limit. Lets a capped read render "N of TOTAL" instead of the
 * downloaded length. Topic-filtered counts use the indexed coord_links join
 * directly; re-listing every matching issue here made infinite feeds do twice
 * the payload work for every page-window growth.
 */
export async function countIssues(filter: ListIssuesFilter = {}): Promise<number> {
  const { sql } = getOrgPg();
  const kindSet: readonly IssueStoreKind[] = filter.kind ? [filter.kind] : (filter.kinds ?? ISSUE_KINDS);
  if (filter.topic) {
    const rows = await sql<{ n: number }[]>`
      SELECT count(DISTINCT ei.issue_id)::int AS n
        FROM harness_shared.engineer_issues ei
        JOIN harness_shared.coord_links cl
          ON cl.workspace_id = ${coordScopeWorkspace()}
         AND cl.rel = 'tagged'
         AND cl.src_kind = ${ISSUE_KIND}
         AND cl.src_ref = ei.issue_id
         AND cl.dst_kind = 'topic'
         AND cl.dst_ref = ${filter.topic}
       WHERE ei.workspace_id = ${issuesScopeWorkspace()}
         AND ei.kind = ANY(${kindSet as string[]}::text[])
         AND ${filter.state ? sql`ei.state = ${filter.state}` : sql`TRUE`}
         AND ${
           filter.scope
             ? sql`ei.scope = ${filter.scope}`
             : filter.scopes
               ? sql`ei.scope = ANY(${filter.scopes as string[]}::text[])`
               : sql`TRUE`
         }
         AND ${filter.assignee ? sql`ei.assignee = ${filter.assignee}` : sql`TRUE`}
         AND ${filter.assignedBy ? sql`ei.assigned_by = ${filter.assignedBy}` : sql`TRUE`}
         AND ${issueMatchWhereSql(sql, true, filter)}
         AND ${filter.signalOrigins ? sql`ei.signal_origin = ANY(${filter.signalOrigins as string[]}::text[])` : sql`TRUE`}
         AND ${filter.createdBy ? sql`ei.created_by = ${filter.createdBy}` : sql`TRUE`}
         AND ${filter.createdAfter ? sql`ei.created_at > ${filter.createdAfter}::timestamptz` : sql`TRUE`}
         AND ${filter.createdBefore ? sql`ei.created_at < ${filter.createdBefore}::timestamptz` : sql`TRUE`}
         AND ${issueShapeWhereSql(sql, true, filter)}
         AND ${filter.issueIds ? issueIdsWhereSql(sql, true, filter.issueIds) : sql`TRUE`}
         AND ${filter.admissibleOnly ? issueAdmissibleWhereSql(sql, true) : sql`TRUE`}
         AND ${
           filter.audit
             ? auditWhereSql(sql, filter.audit, {
                 stateColumn: 'state',
                 terminalStates: ISSUE_TERMINAL_STATES,
                 alias: 'ei',
               })
             : sql`TRUE`
         }
         -- P-013: completion-authority filter, alias-qualified for the topic-joined branch.
         AND ${
           filter.completionAuthority
             ? sql`(ei.state = ANY(${ISSUE_TERMINAL_STATES as string[]}::text[]) AND ${completionAuthorityPredicateSql(sql, filter.completionAuthority, 'ei')})`
             : sql`TRUE`
         }
         AND ${filter.lane ? sql`ei.lane = ${filter.lane}` : sql`TRUE`}
         AND ${filter.excludeRubricGraded ? sql`(ei.payload -> 'observation' ->> 'rubricRef') IS NULL` : sql`TRUE`}`;
    return rows[0]?.n ?? 0;
  }
  const rows = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n
      FROM harness_shared.engineer_issues
     WHERE workspace_id = ${issuesScopeWorkspace()}
       AND kind = ANY(${kindSet as string[]}::text[])
       AND ${filter.state ? sql`state = ${filter.state}` : sql`TRUE`}
       AND ${
         filter.scope
           ? sql`scope = ${filter.scope}`
           : filter.scopes
             ? sql`scope = ANY(${filter.scopes as string[]}::text[])`
             : sql`TRUE`
       }
       AND ${filter.assignee ? sql`assignee = ${filter.assignee}` : sql`TRUE`}
       AND ${filter.assignedBy ? sql`assigned_by = ${filter.assignedBy}` : sql`TRUE`}
       AND ${issueMatchWhereSql(sql, false, filter)}
       AND ${filter.signalOrigins ? sql`signal_origin = ANY(${filter.signalOrigins as string[]}::text[])` : sql`TRUE`}
       AND ${filter.createdBy ? sql`created_by = ${filter.createdBy}` : sql`TRUE`}
       AND ${filter.createdAfter ? sql`created_at > ${filter.createdAfter}::timestamptz` : sql`TRUE`}
       AND ${filter.createdBefore ? sql`created_at < ${filter.createdBefore}::timestamptz` : sql`TRUE`}
       AND ${issueShapeWhereSql(sql, false, filter)}
       AND ${filter.issueIds ? issueIdsWhereSql(sql, false, filter.issueIds) : sql`TRUE`}
       AND ${filter.admissibleOnly ? issueAdmissibleWhereSql(sql, false) : sql`TRUE`}
       AND ${
         filter.audit
           ? auditWhereSql(sql, filter.audit, { stateColumn: 'state', terminalStates: ISSUE_TERMINAL_STATES })
           : sql`TRUE`
       }
       -- P-013: completion-authority filter — mirrors listIssues so this COUNT and the LIST
       -- it pairs with can never answer different questions.
       AND ${
         filter.completionAuthority
           ? sql`(state = ANY(${ISSUE_TERMINAL_STATES as string[]}::text[]) AND ${completionAuthorityPredicateSql(sql, filter.completionAuthority)})`
           : sql`TRUE`
       }
       AND ${filter.lane ? sql`lane = ${filter.lane}` : sql`TRUE`}
       AND ${filter.excludeRubricGraded ? sql`(payload -> 'observation' ->> 'rubricRef') IS NULL` : sql`TRUE`}`;
  return rows[0]?.n ?? 0;
}

/**
 * STATE-HISTOGRAM companion to {@link countIssues} — one row per distinct `state`
 * for the same filter, instead of one scalar total. Mirrors countIssues' WHERE
 * exactly (both branches) so the histogram and the total can never disagree.
 *
 * P-008 (db-performance-remediation-2026-07-26): this exists so a caller that
 * wants a state DISTRIBUTION stops materialising rows to count them in JS.
 * `system-health/compute.ts`'s `collectWorkItems` was doing
 * `listWorkItems({ limit: 2000 })` and then `for (const it of items)
 * byState[it.state]++` — shipping ~4.7MB of `body`+`payload` JSONB per call,
 * 761k calls, to derive ~7 integers. Measured with EXPLAIN (ANALYZE, SERIALIZE):
 * 4734 kB / ~195 ms for the list shape vs 1 kB / ~52 ms for this GROUP BY —
 * ~4,700x fewer bytes and ~3.7x faster.
 *
 * It also fixes a CORRECTNESS bug, which is the real reason not to "just add a
 * projection" instead: the 2000-row cap silently truncated the counts. With
 * 25,055 issue-family + 26,814 feature-family rows live, the health panel was
 * reporting `total: 2000` and the state distribution of only the 2000 most
 * recent — wrong by ~26x. An aggregate has no cap to be wrong about.
 */
export async function countIssuesByState(filter: ListIssuesFilter = {}): Promise<Record<string, number>> {
  const { sql } = getOrgPg();
  const kindSet: readonly IssueStoreKind[] = filter.kind ? [filter.kind] : (filter.kinds ?? ISSUE_KINDS);
  const rows = filter.topic
    ? await sql<{ state: string | null; n: number }[]>`
      SELECT ei.state AS state, count(DISTINCT ei.issue_id)::int AS n
        FROM harness_shared.engineer_issues ei
        JOIN harness_shared.coord_links cl
          ON cl.workspace_id = ${coordScopeWorkspace()}
         AND cl.rel = 'tagged'
         AND cl.src_kind = ${ISSUE_KIND}
         AND cl.src_ref = ei.issue_id
         AND cl.dst_kind = 'topic'
         AND cl.dst_ref = ${filter.topic}
       WHERE ei.workspace_id = ${issuesScopeWorkspace()}
         AND ei.kind = ANY(${kindSet as string[]}::text[])
         AND ${filter.state ? sql`ei.state = ${filter.state}` : sql`TRUE`}
         AND ${
           filter.scope
             ? sql`ei.scope = ${filter.scope}`
             : filter.scopes
               ? sql`ei.scope = ANY(${filter.scopes as string[]}::text[])`
               : sql`TRUE`
         }
         AND ${filter.assignee ? sql`ei.assignee = ${filter.assignee}` : sql`TRUE`}
         AND ${filter.assignedBy ? sql`ei.assigned_by = ${filter.assignedBy}` : sql`TRUE`}
         AND ${issueMatchWhereSql(sql, true, filter)}
         AND ${filter.signalOrigins ? sql`ei.signal_origin = ANY(${filter.signalOrigins as string[]}::text[])` : sql`TRUE`}
         AND ${filter.createdBy ? sql`ei.created_by = ${filter.createdBy}` : sql`TRUE`}
         AND ${filter.createdAfter ? sql`ei.created_at > ${filter.createdAfter}::timestamptz` : sql`TRUE`}
         AND ${filter.createdBefore ? sql`ei.created_at < ${filter.createdBefore}::timestamptz` : sql`TRUE`}
         AND ${issueShapeWhereSql(sql, true, filter)}
         AND ${filter.issueIds ? issueIdsWhereSql(sql, true, filter.issueIds) : sql`TRUE`}
         AND ${filter.admissibleOnly ? issueAdmissibleWhereSql(sql, true) : sql`TRUE`}
         AND ${
           filter.audit
             ? auditWhereSql(sql, filter.audit, {
                 stateColumn: 'state',
                 terminalStates: ISSUE_TERMINAL_STATES,
                 alias: 'ei',
               })
             : sql`TRUE`
         }
         -- P-013: completion-authority filter, alias-qualified for the topic-joined branch.
         AND ${
           filter.completionAuthority
             ? sql`(ei.state = ANY(${ISSUE_TERMINAL_STATES as string[]}::text[]) AND ${completionAuthorityPredicateSql(sql, filter.completionAuthority, 'ei')})`
             : sql`TRUE`
         }
         AND ${filter.lane ? sql`ei.lane = ${filter.lane}` : sql`TRUE`}
         AND ${filter.excludeRubricGraded ? sql`(ei.payload -> 'observation' ->> 'rubricRef') IS NULL` : sql`TRUE`}
       GROUP BY ei.state`
    : await sql<{ state: string | null; n: number }[]>`
      SELECT state, count(*)::int AS n
        FROM harness_shared.engineer_issues
       WHERE workspace_id = ${issuesScopeWorkspace()}
         AND kind = ANY(${kindSet as string[]}::text[])
         AND ${filter.state ? sql`state = ${filter.state}` : sql`TRUE`}
         AND ${
           filter.scope
             ? sql`scope = ${filter.scope}`
             : filter.scopes
               ? sql`scope = ANY(${filter.scopes as string[]}::text[])`
               : sql`TRUE`
         }
         AND ${filter.assignee ? sql`assignee = ${filter.assignee}` : sql`TRUE`}
         AND ${filter.assignedBy ? sql`assigned_by = ${filter.assignedBy}` : sql`TRUE`}
         AND ${issueMatchWhereSql(sql, false, filter)}
         AND ${filter.signalOrigins ? sql`signal_origin = ANY(${filter.signalOrigins as string[]}::text[])` : sql`TRUE`}
         AND ${filter.createdBy ? sql`created_by = ${filter.createdBy}` : sql`TRUE`}
         AND ${filter.createdAfter ? sql`created_at > ${filter.createdAfter}::timestamptz` : sql`TRUE`}
       AND ${filter.createdBefore ? sql`created_at < ${filter.createdBefore}::timestamptz` : sql`TRUE`}
         AND ${issueShapeWhereSql(sql, false, filter)}
         AND ${filter.issueIds ? issueIdsWhereSql(sql, false, filter.issueIds) : sql`TRUE`}
         AND ${filter.admissibleOnly ? issueAdmissibleWhereSql(sql, false) : sql`TRUE`}
         AND ${
           filter.audit
             ? auditWhereSql(sql, filter.audit, { stateColumn: 'state', terminalStates: ISSUE_TERMINAL_STATES })
             : sql`TRUE`
         }
         -- P-013: completion-authority filter — keeps this histogram's WHERE identical to
         -- countIssues', which its own contract requires.
         AND ${
           filter.completionAuthority
             ? sql`(state = ANY(${ISSUE_TERMINAL_STATES as string[]}::text[]) AND ${completionAuthorityPredicateSql(sql, filter.completionAuthority)})`
             : sql`TRUE`
         }
         AND ${filter.lane ? sql`lane = ${filter.lane}` : sql`TRUE`}
         AND ${filter.excludeRubricGraded ? sql`(payload -> 'observation' ->> 'rubricRef') IS NULL` : sql`TRUE`}
       GROUP BY state`;
  const out: Record<string, number> = {};
  for (const row of rows) {
    // A NULL state is impossible today (the column is NOT NULL) but folding it to
    // 'unknown' keeps the histogram total equal to countIssues() if that changes.
    out[row.state ?? 'unknown'] = (out[row.state ?? 'unknown'] ?? 0) + row.n;
  }
  return out;
}

/**
 * Count issues by `payload.sourceRole` — the CORPUS-wide histogram of "who filed it".
 *
 * EI-21708963364424082 / WI-471938. A filter control's OPTION SET is a claim about what
 * exists, not about what happens to be loaded. The Learning tab's "Filed by" chips derived
 * their options from the digest's 500-row window, so a source living only in the unloaded
 * tail offered no chip and could not be selected at all. Measured live 2026-08-28 on the
 * loop-output corpus: `system` had 15 rows, ZERO of them inside the newest-500 window (its
 * best rank was 708). This is the same class as WI-39675 — a windowed value read as a
 * corpus value — and the same remedy: ask Postgres for the aggregate instead of tallying
 * whatever the row read happened to fetch.
 *
 * The WHERE mirrors {@link countIssues} — as every reader here now does, via
 * {@link issueMatchWhereSql}. This docblock used to say the WHERE mirrors countIssues
 * "rather than countIssuesByState: the latter omits `q` and `severities`, which is safe
 * for its callers". That was true when written and became false without anyone editing
 * it: `issues:list { q, rollup:'state' }` added a caller that passes `q`, and byState's
 * rollup then counted the whole population (WI-564691). Recording a known divergence in
 * prose is what let it survive — the parity is now a shared fragment plus a mechanical
 * guard (issues-engineer-filter-parity.test.ts), so it cannot silently lapse again.
 *
 * ⚠ COST: `payload ->> 'sourceRole'` is not a cheap column — payload is large and stored
 * out-of-line, so this forces the datum (see WI-7102, which tracks migrating the remaining
 * payload predicates to generated columns). Acceptable here because the only caller runs it
 * once per digest computation, on the precompute path that already runs `countIssues`, over
 * an id-bounded corpus of ~2k rows. Do not add a hot per-request caller without measuring.
 *
 * A row with no `sourceRole` is folded to the `''` key rather than dropped, so the histogram
 * total still equals `countIssues()` over the same filter; callers that want only the
 * selectable option set skip the empty key.
 */
export async function countIssuesBySourceRole(filter: ListIssuesFilter = {}): Promise<Record<string, number>> {
  const { sql } = getOrgPg();
  const kindSet: readonly IssueStoreKind[] = filter.kind ? [filter.kind] : (filter.kinds ?? ISSUE_KINDS);
  const rows = filter.topic
    ? await sql<{ source_role: string | null; n: number }[]>`
      SELECT ei.payload ->> 'sourceRole' AS source_role, count(DISTINCT ei.issue_id)::int AS n
        FROM harness_shared.engineer_issues ei
        JOIN harness_shared.coord_links cl
          ON cl.workspace_id = ${coordScopeWorkspace()}
         AND cl.rel = 'tagged'
         AND cl.src_kind = ${ISSUE_KIND}
         AND cl.src_ref = ei.issue_id
         AND cl.dst_kind = 'topic'
         AND cl.dst_ref = ${filter.topic}
       WHERE ei.workspace_id = ${issuesScopeWorkspace()}
         AND ei.kind = ANY(${kindSet as string[]}::text[])
         AND ${filter.state ? sql`ei.state = ${filter.state}` : sql`TRUE`}
         AND ${
           filter.scope
             ? sql`ei.scope = ${filter.scope}`
             : filter.scopes
               ? sql`ei.scope = ANY(${filter.scopes as string[]}::text[])`
               : sql`TRUE`
         }
         AND ${filter.assignee ? sql`ei.assignee = ${filter.assignee}` : sql`TRUE`}
         AND ${filter.assignedBy ? sql`ei.assigned_by = ${filter.assignedBy}` : sql`TRUE`}
         AND ${issueMatchWhereSql(sql, true, filter)}
         AND ${filter.signalOrigins ? sql`ei.signal_origin = ANY(${filter.signalOrigins as string[]}::text[])` : sql`TRUE`}
         AND ${filter.createdBy ? sql`ei.created_by = ${filter.createdBy}` : sql`TRUE`}
         AND ${filter.createdAfter ? sql`ei.created_at > ${filter.createdAfter}::timestamptz` : sql`TRUE`}
         AND ${filter.createdBefore ? sql`ei.created_at < ${filter.createdBefore}::timestamptz` : sql`TRUE`}
         AND ${issueShapeWhereSql(sql, true, filter)}
         AND ${filter.issueIds ? issueIdsWhereSql(sql, true, filter.issueIds) : sql`TRUE`}
         AND ${filter.admissibleOnly ? issueAdmissibleWhereSql(sql, true) : sql`TRUE`}
         AND ${
           filter.audit
             ? auditWhereSql(sql, filter.audit, {
                 stateColumn: 'state',
                 terminalStates: ISSUE_TERMINAL_STATES,
                 alias: 'ei',
               })
             : sql`TRUE`
         }
         AND ${
           filter.completionAuthority
             ? sql`(ei.state = ANY(${ISSUE_TERMINAL_STATES as string[]}::text[]) AND ${completionAuthorityPredicateSql(sql, filter.completionAuthority, 'ei')})`
             : sql`TRUE`
         }
         AND ${filter.lane ? sql`ei.lane = ${filter.lane}` : sql`TRUE`}
         AND ${filter.excludeRubricGraded ? sql`(ei.payload -> 'observation' ->> 'rubricRef') IS NULL` : sql`TRUE`}
       GROUP BY ei.payload ->> 'sourceRole'`
    : await sql<{ source_role: string | null; n: number }[]>`
      SELECT payload ->> 'sourceRole' AS source_role, count(*)::int AS n
        FROM harness_shared.engineer_issues
       WHERE workspace_id = ${issuesScopeWorkspace()}
         AND kind = ANY(${kindSet as string[]}::text[])
         AND ${filter.state ? sql`state = ${filter.state}` : sql`TRUE`}
           AND ${
             filter.scope
               ? sql`scope = ${filter.scope}`
               : filter.scopes
                 ? sql`scope = ANY(${filter.scopes as string[]}::text[])`
                 : sql`TRUE`
           }
         AND ${filter.assignee ? sql`assignee = ${filter.assignee}` : sql`TRUE`}
         AND ${filter.assignedBy ? sql`assigned_by = ${filter.assignedBy}` : sql`TRUE`}
         AND ${issueMatchWhereSql(sql, false, filter)}
         AND ${filter.signalOrigins ? sql`signal_origin = ANY(${filter.signalOrigins as string[]}::text[])` : sql`TRUE`}
         AND ${filter.createdBy ? sql`created_by = ${filter.createdBy}` : sql`TRUE`}
         AND ${filter.createdAfter ? sql`created_at > ${filter.createdAfter}::timestamptz` : sql`TRUE`}
         AND ${filter.createdBefore ? sql`created_at < ${filter.createdBefore}::timestamptz` : sql`TRUE`}
         AND ${issueShapeWhereSql(sql, false, filter)}
         AND ${filter.issueIds ? issueIdsWhereSql(sql, false, filter.issueIds) : sql`TRUE`}
         AND ${filter.admissibleOnly ? issueAdmissibleWhereSql(sql, false) : sql`TRUE`}
         AND ${
           filter.audit
             ? auditWhereSql(sql, filter.audit, { stateColumn: 'state', terminalStates: ISSUE_TERMINAL_STATES })
             : sql`TRUE`
         }
         AND ${
           filter.completionAuthority
             ? sql`(state = ANY(${ISSUE_TERMINAL_STATES as string[]}::text[]) AND ${completionAuthorityPredicateSql(sql, filter.completionAuthority)})`
             : sql`TRUE`
         }
         AND ${filter.lane ? sql`lane = ${filter.lane}` : sql`TRUE`}
         AND ${filter.excludeRubricGraded ? sql`(payload -> 'observation' ->> 'rubricRef') IS NULL` : sql`TRUE`}
       GROUP BY payload ->> 'sourceRole'`;
  const out: Record<string, number> = {};
  for (const row of rows) {
    const key = row.source_role ?? '';
    out[key] = (out[key] ?? 0) + row.n;
  }
  return out;
}

/**
 * Count observations by kind — returns a map of kind → count for the observations
 * matching the filter. Used by the Observations panel to show signal distribution
 * with real database counts instead of loaded-list-length fallback (WI-4374).
 * Each NULL kind is mapped to 'other'.
 */
export async function countObservationsByKind(filter: ListIssuesFilter = {}): Promise<Record<string, number>> {
  const { sql } = getOrgPg();
  const kindSet: readonly IssueStoreKind[] = filter.kind ? [filter.kind] : (filter.kinds ?? ISSUE_KINDS);
  if (filter.topic) {
    const rows = await sql<{ kind: string | null; count: number }[]>`
      SELECT (ei.payload->'observation'->>'kind')::text AS kind, count(*)::int AS count
        FROM harness_shared.engineer_issues ei
        JOIN harness_shared.coord_links cl
          ON cl.workspace_id = ${coordScopeWorkspace()}
         AND cl.rel = 'tagged'
         AND cl.src_kind = ${ISSUE_KIND}
         AND cl.src_ref = ei.issue_id
         AND cl.dst_kind = 'topic'
         AND cl.dst_ref = ${filter.topic}
       WHERE ei.workspace_id = ${issuesScopeWorkspace()}
         AND ei.kind = ANY(${kindSet as string[]}::text[])
         AND ${filter.state ? sql`ei.state = ${filter.state}` : sql`TRUE`}
         AND ${
           filter.scope
             ? sql`ei.scope = ${filter.scope}`
             : filter.scopes
               ? sql`ei.scope = ANY(${filter.scopes as string[]}::text[])`
               : sql`TRUE`
         }
         AND ${filter.assignee ? sql`ei.assignee = ${filter.assignee}` : sql`TRUE`}
         AND ${filter.assignedBy ? sql`ei.assigned_by = ${filter.assignedBy}` : sql`TRUE`}
         AND ${issueMatchWhereSql(sql, true, filter)}
         AND ${filter.signalOrigins ? sql`ei.signal_origin = ANY(${filter.signalOrigins as string[]}::text[])` : sql`TRUE`}
         AND ${filter.createdBy ? sql`ei.created_by = ${filter.createdBy}` : sql`TRUE`}
         AND ${filter.createdAfter ? sql`ei.created_at > ${filter.createdAfter}::timestamptz` : sql`TRUE`}
         AND ${filter.createdBefore ? sql`ei.created_at < ${filter.createdBefore}::timestamptz` : sql`TRUE`}
         AND ${issueShapeWhereSql(sql, true, filter)}
         AND ${filter.issueIds ? issueIdsWhereSql(sql, true, filter.issueIds) : sql`TRUE`}
         AND ${filter.admissibleOnly ? issueAdmissibleWhereSql(sql, true) : sql`TRUE`}
         AND ${
           filter.audit
             ? auditWhereSql(sql, filter.audit, {
                 stateColumn: 'state',
                 terminalStates: ISSUE_TERMINAL_STATES,
                 alias: 'ei',
               })
             : sql`TRUE`
         }
         -- P-013: completion-authority filter, alias-qualified for the topic-joined branch.
         AND ${
           filter.completionAuthority
             ? sql`(ei.state = ANY(${ISSUE_TERMINAL_STATES as string[]}::text[]) AND ${completionAuthorityPredicateSql(sql, filter.completionAuthority, 'ei')})`
             : sql`TRUE`
         }
         AND ${filter.lane ? sql`ei.lane = ${filter.lane}` : sql`TRUE`}
         AND ${filter.excludeRubricGraded ? sql`(ei.payload -> 'observation' ->> 'rubricRef') IS NULL` : sql`TRUE`}
      -- GROUP BY 1 (the ORDINAL), never 'GROUP BY kind'. 'kind' is BOTH a real
      -- column on engineer_issues AND this SELECT's output alias, and Postgres
      -- resolves a bare name in GROUP BY to the COLUMN, not the alias. So
      -- 'GROUP BY kind' silently grouped by ei.kind, leaving the payload
      -- expression ungrouped — a hard 500 on every call:
      --   column "ei.payload" must appear in the GROUP BY clause
      GROUP BY 1`;
    const result: Record<string, number> = {};
    for (const row of rows) {
      const k = row.kind || 'other';
      result[k] = row.count;
    }
    return result;
  }
  const rows = await sql<{ kind: string | null; count: number }[]>`
    SELECT (payload->'observation'->>'kind')::text AS kind, count(*)::int AS count
      FROM harness_shared.engineer_issues
     WHERE workspace_id = ${issuesScopeWorkspace()}
       AND kind = ANY(${kindSet as string[]}::text[])
       AND ${filter.state ? sql`state = ${filter.state}` : sql`TRUE`}
       AND ${
         filter.scope
           ? sql`scope = ${filter.scope}`
           : filter.scopes
             ? sql`scope = ANY(${filter.scopes as string[]}::text[])`
             : sql`TRUE`
       }
       AND ${filter.assignee ? sql`assignee = ${filter.assignee}` : sql`TRUE`}
       AND ${filter.assignedBy ? sql`assigned_by = ${filter.assignedBy}` : sql`TRUE`}
       AND ${issueMatchWhereSql(sql, false, filter)}
       AND ${filter.signalOrigins ? sql`signal_origin = ANY(${filter.signalOrigins as string[]}::text[])` : sql`TRUE`}
       AND ${filter.createdBy ? sql`created_by = ${filter.createdBy}` : sql`TRUE`}
       AND ${filter.createdAfter ? sql`created_at > ${filter.createdAfter}::timestamptz` : sql`TRUE`}
       AND ${filter.createdBefore ? sql`created_at < ${filter.createdBefore}::timestamptz` : sql`TRUE`}
       AND ${issueShapeWhereSql(sql, false, filter)}
       AND ${filter.issueIds ? issueIdsWhereSql(sql, false, filter.issueIds) : sql`TRUE`}
       AND ${filter.admissibleOnly ? issueAdmissibleWhereSql(sql, false) : sql`TRUE`}
       AND ${
         filter.audit
           ? auditWhereSql(sql, filter.audit, { stateColumn: 'state', terminalStates: ISSUE_TERMINAL_STATES })
           : sql`TRUE`
       }
       -- P-013: completion-authority filter — mirrors the other issue-family reads.
       AND ${
         filter.completionAuthority
           ? sql`(state = ANY(${ISSUE_TERMINAL_STATES as string[]}::text[]) AND ${completionAuthorityPredicateSql(sql, filter.completionAuthority)})`
           : sql`TRUE`
       }
       -- P-006/D-031: without this, a lane-selected caller falls into this
       -- (non-topic) branch UNRESTRICTED and tallies the whole issue store by
       -- observation kind. The selector must bind in BOTH branches, or moving a
       -- caller from the topic filter to the lane filter silently widens it.
       AND ${filter.lane ? sql`lane = ${filter.lane}` : sql`TRUE`}
       AND ${filter.excludeRubricGraded ? sql`(payload -> 'observation' ->> 'rubricRef') IS NULL` : sql`TRUE`}
    -- GROUP BY 1 (the ORDINAL) — same reason as the topic-joined branch above:
    -- 'kind' is both a real column and this SELECT's alias, and the bare name
    -- binds to the column, which leaves 'payload' ungrouped and 500s.
    GROUP BY 1`;
  const result: Record<string, number> = {};
  for (const row of rows) {
    const k = row.kind || 'other';
    result[k] = row.count;
  }
  return result;
}

/**
 * One round trip (WI-10003631). This used to be `resolveIssueWorkspace` followed by
 * `getIssueInWorkspace`, two statements on EVERY `getWorkItem` — including the
 * feature-family path, where both miss. A single ordered read returns the identical
 * row: resolve picked the ambient workspace when it holds the id, else the workspace
 * of the freshest row; the re-read then took the freshest twin in that workspace.
 * `(workspace_id = ambient) DESC, updated_at DESC` is exactly that composition, and a
 * miss is null either way (the ambient fallback re-read also missed).
 */
export async function getIssue(
  id: string,
  opts: WorkItemReadOptions = {},
  client?: ReturnType<typeof getOrgPg>['sql'],
  /**
   * WI-10006010: when the same id exists under more than one harness_slug, PREFER the row in
   * this harness. A preference, never a filter (EI-19393623437103599: callers pass harness
   * loosely, so filtering would turn a rare wrong row into a broad silent null). The order
   * matches `resolveIssuePhysicalSlug`, so the row a caller reads is the row its write pins.
   */
  preferHarness?: string | null,
): Promise<EngineerIssue | null> {
  const ambient = issuesScopeWorkspace();
  const sql = client ?? getOrgPg().sql;
  const columns = projectWorkItemColumns(
    opts.includeBody === false ? ISSUE_COLS_BODYLESS : ISSUE_COLS,
    opts.payloadProjection,
  );
  const want = harnessPreference(preferHarness);
  const bare = want?.startsWith('harness:') ? want.slice('harness:'.length) : want;
  const rows = await sql<IssueRowDb[]>`
    SELECT ${sql.unsafe(columns)} FROM harness_shared.engineer_issues
     WHERE issue_id = ${id}
     ORDER BY (workspace_id = ${ambient}) DESC,
              ${want ? sql`(base_harness_slug IN (${want}, ${bare}, ${`harness:${bare}`})) DESC,` : sql``}
              updated_at DESC NULLS LAST, base_harness_slug ASC
     LIMIT 1`;
  return rows[0] ? toIssue(rows[0]) : null;
}

/**
 * Resolve the workspace an issue-family row ACTUALLY lives under, by id —
 * AMBIENT-INDEPENDENT (does not trust a bare `issuesScopeWorkspace()` derivation).
 *
 * EI-15486 class (dispatch-orphan-rate SLO regression root cause, 2026-07-19): a
 * background/routine WRITE that scopes itself via `issuesScopeWorkspace()` several
 * `await`s deep — with no HTTP request driving it, so there is no ALS request scope
 * to read — silently falls through to the process-global default workspace (the
 * WI-5261 class, "confirmed live for papercusp-workspace 2026-07-17"; same root as
 * EI-15345's work-items.ts fix, "resolve the item's OWN workspace by id (ambient-
 * independent, prefer active-ws row) then scope the write to it — pattern to apply
 * to any similar work-item write"). Concretely: the orphaned-dispatch collector's
 * host-restart thrash breaker (EI-1689) calls `mergeIssuePayload(id, {needsHuman:true})`
 * from a bare routine tick; when the ambient workspace resolved wrong, the UPDATE's
 * `WHERE workspace_id = ambient AND issue_id = id` matched ZERO rows and silently
 * no-op'd (returns null, not a throw) — so the breaker's "routed to human, NOT
 * re-dispatched" note was RECORDED on the dispatch ledger while the issue itself was
 * NEVER flagged, and the SAME item kept re-dispatching every ~30min for 11+ hours,
 * which is exactly what blew the dispatch-orphan-rate SLO past its budget.
 *
 * ⚠ CAVEAT (EI-19393623437103599) — this function's id-uniqueness premise is only
 * HALF true, and the half that fails is the one you are most likely to hit. It used
 * to read simply "issue ids are globally unique (see releaseIssue's EI-6480 comment)".
 * That holds for `EI-<snowflake>` ids. It does NOT hold for `WI-<n>` ids: D-008
 * (migration 142-work-items-unify.sql) began minting them into THIS table from
 * `harness_shared.work_item_seq`, a PER-DATABASE sequence that STARTs at 1 — so
 * `WI-1`/`WI-2`/`WI-3` exist in every long-lived store, and a fresh or recovered store
 * mints exactly those ids first. Resolving such an id "by id alone" can therefore land
 * on a DIFFERENT row than the caller meant, across a workspace OR a harness boundary,
 * and this function will return it without complaint (the `ORDER BY` below just picks
 * one). That is not hypothetical: it silently retargeted ~3h of writes — including a
 * terminal completion — onto a stranger's work-item on 2026-08-03.
 *
 * Kept as-is deliberately rather than filtered: 56 of `getWorkItem`'s 77 non-test call
 * sites pass a harness, many of them loosely, so tightening the lookup here would turn
 * a rare wrong-row into a broad silent `null` ("does not exist"), which is worse. The
 * contradiction is caught one level up instead — see `harnessScopeMismatch()` in
 * work-items.ts, which destructive writes refuse on.
 *
 * So: resolving by id alone — no workspace needed up front — look the row up directly,
 * preferring a match under the ambient/ACTIVE workspace when the id exists in more
 * than one (a legacy federated dupe), else use whichever workspace actually holds
 * the row. Falls back to the ambient workspace when no row is found at all (a
 * brand-new id about to be inserted) — never throws, so an ordinary correctly-
 * ambient-scoped call is byte-identical to the old behavior.
 */
export async function resolveIssueWorkspace(id: string, fallback?: string, client?: OrgSql): Promise<string> {
  const ambient = fallback ?? issuesScopeWorkspace();
  const sql = client ?? getOrgPg().sql;
  const rows = await sql<{ workspace_id: string }[]>`
    SELECT workspace_id FROM harness_shared.engineer_issues
     WHERE issue_id = ${id}
     ORDER BY (workspace_id = ${ambient}) DESC, updated_at DESC NULLS LAST
     LIMIT 1`;
  return rows[0]?.workspace_id ?? ambient;
}

/**
 * WI-10006515: heal an own-node issue row stranded at origin='remote', resolving its workspace by
 * id. `origin` records how a row ARRIVED, not who wrote it (WI-10003565), and every write through
 * the engineer_issues view is a silent no-op while origin='remote' — so a write path that would
 * otherwise route an own-node row to "peer reconciliation" (a peer that is THIS node) heals first.
 * The identity check lives in selfHealOwnNodeOriginIfStranded's WHERE clause: a true peer's row is
 * never touched. Fail-closed: any read or write failure answers false and the refusal stands.
 */
export async function healOwnNodeIssueOrigin(id: string, harness?: string | null): Promise<boolean> {
  try {
    return await selfHealOwnNodeOriginIfStranded(await resolveIssueWorkspace(id), id, harness ?? null);
  } catch {
    return false;
  }
}

/**
 * Read one issue-family row scoped to an EXPLICIT workspace, bypassing the
 * `issuesScopeWorkspace()` re-derivation.
 *
 * EI-6480: the issue-claim path (`claimNextIssueWorkItem`) claims a row via an atomic
 * UPDATE that fixes the workspace to `issueWs = issuesScopeWorkspace()` captured ONCE,
 * then re-reads the claimed row to build its `WorkItem`. If that re-read calls the bare
 * `getIssue()` it re-derives `issuesScopeWorkspace()` a SECOND time — and that value can
 * drift between the two calls (the ISSUES_PER_WORKSPACE flag cache self-heals on a TTL,
 * so a mid-call refresh can flip `default` ⇄ the active workspace). A drift makes the
 * re-read miss the just-claimed row → `getIssue` returns null → the claim path returned
 * null while the row stayed `taken_by`-set: a LEAKED claim reported to the caller as a
 * spurious "ready but a peer raced you (retry)" miss. Re-reading in the SAME captured
 * workspace the row was claimed in removes that drift entirely.
 */
export async function getIssueInWorkspace(
  workspaceId: string,
  id: string,
  opts: { baseHarnessSlug?: string | null } & WorkItemReadOptions = {},
): Promise<EngineerIssue | null> {
  const { sql } = getOrgPg();
  // EI-7808: legacy/federated bugs left duplicate issue-family base rows with the
  // same (workspace_id, issue_id) but different physical harness_slug values (most
  // visibly '' beside operator:<workspace>). A caller that just claimed a specific
  // physical row must be able to re-read THAT row; otherwise this SELECT can return
  // a stale resolved twin and make a successful claim look terminal/no-op.
  //
  // WI-4514: when `baseHarnessSlug` is NOT passed (the plain get-path, e.g. bare
  // getIssue()/getIssueInWorkspace() reads used by the UI/tools), a duplicated
  // (workspace_id, issue_id) previously fell through with no ORDER BY — PG returns
  // an ARBITRARY twin (heap/index scan order) for a bare WHERE match, so a read
  // could non-deterministically flip between a fresh twin and one hours stale.
  // `ORDER BY updated_at DESC NULLS LAST LIMIT 1` makes the get-path deterministic
  // (freshest twin wins) without touching the EI-6480 claim re-read path, which
  // already pins `baseHarnessSlug` to filter to exactly one physical row.
  const columns = projectWorkItemColumns(
    opts.includeBody === false ? ISSUE_COLS_BODYLESS : ISSUE_COLS,
    opts.payloadProjection,
  );
  const rows = await sql<IssueRowDb[]>`
    SELECT ${sql.unsafe(columns)} FROM harness_shared.engineer_issues
     WHERE workspace_id = ${workspaceId} AND issue_id = ${id}
       AND ${opts.baseHarnessSlug != null ? sql`base_harness_slug = ${opts.baseHarnessSlug}` : sql`TRUE`}
     ORDER BY updated_at DESC NULLS LAST
     LIMIT 1`;
  return rows[0] ? toIssue(rows[0]) : null;
}

/**
 * The LAST `limit` posts of an issue's thread, plus its total and topics.
 *
 * The bounded sibling of {@link getIssueDetail}, for cell resolvers and other hot
 * read paths — see PgThreadStore.listRecentPosts for why the count rides the same
 * query as the rows.
 *
 * ⚠ MUST live here rather than in work-items.ts, and this is not organizational
 * taste: the two modules' coord stores are scoped to DIFFERENT workspaces. This
 * one resolves dynamically (`getWorkspaceId: () => coordScopeWorkspace()`), while
 * work-items.ts's hardcodes `DEFAULT_COORD_WORKSPACE` ('default'). Reading an
 * issue thread through that store matches ZERO rows and — because a missing thread
 * legitimately means "nobody has commented" — returns a confident, well-formed
 * `total: 0` instead of an error. Verified live 2026-08-03: WI-6857 (10 real
 * posts) read back as 0/0 through the work-items store before this existed.
 */
export async function getIssueThreadWindow(
  id: string,
  limit: number,
): Promise<{ posts: ThreadPostRow[]; total: number; topics: string[]; createdAt: string } | null> {
  const issue = await getIssue(id);
  if (!issue) return null;
  const [thread, topics] = await Promise.all([threads.getThreadByParent(issueRef(id)), tags.listTags(issueRef(id))]);
  // No thread row is the DEFAULT for an uncommented item (threads are created on
  // first post) — a real measured zero, not a failure.
  const window = thread
    ? await threads.listRecentPosts(thread.thread_id, limit)
    : { posts: [] as ThreadPostRow[], total: 0 };
  return { posts: window.posts, total: window.total, topics, createdAt: issue.createdAt };
}

export async function getIssueDetail(id: string): Promise<EngineerIssueDetail | null> {
  const issue = await getIssue(id);
  if (!issue) return null;
  const topics = await tags.listTags(issueRef(id));
  const thread = await threads.getThreadByParent(issueRef(id));
  const posts = thread ? await threads.listPosts(thread.thread_id) : [];
  const out = await blockingLinks.listOut(issueRef(id));
  return {
    ...issue,
    topics,
    posts,
    links: out.filter((l) => l.rel !== 'tagged').map((l) => ({ rel: l.rel, dst: l.dst })),
  };
}

export interface UpdateIssuePatch {
  title?: string;
  body?: string;
  severity?: IssueSeverity;
  /** Correct a mislabeled work-item kind (issue-surface kinds only — bug|change).
   *  The kind column is load-bearing post close-the-self-improvement-loop D-002
   *  (it picks the auto-implement lane), so mislabels must be fixable via the verb. */
  kind?: IssueKind;
  foundDuring?: string | null;
  linkedFeatureId?: string | null;
  /** Parent work-item id for duplicate/child relationships; null clears the edge. */
  parent?: string | null;
  by?: string;
  /** Skip the subscribe→inject fan-out (cosmetic edits like a generated title). */
  silent?: boolean;
  /** EI-8497: bypass the fat-finger body-shrink guard below — pass true when a large
   *  reduction in body length is genuinely intended (not a mis-call). */
  confirmShrink?: boolean;
}

/**
 * EI-8497 fat-finger guard: a mis-called `work_items:update` silently overwrote a
 * substantial description with a short placeholder body, and there was no revision
 * history to recover the prior text from. Rather than build full body versioning,
 * this stops the destructive class at the door: an edit that would replace a
 * substantial existing body with something far shorter is REJECTED (nothing is
 * written) unless the caller explicitly confirms it. Trips only when BOTH hold —
 * below either threshold a shrink reads as a plausible genuine simplification, not
 * a fat-finger:
 *   - the existing body is at least `BODY_SHRINK_GUARD_MIN_LENGTH` chars (a short
 *     body has little to lose), AND
 *   - the new body keeps less than `BODY_SHRINK_GUARD_RETAIN_RATIO` of that length.
 */
export const BODY_SHRINK_GUARD_MIN_LENGTH = 40;
export const BODY_SHRINK_GUARD_RETAIN_RATIO = 0.15;

export interface ShrinkGuardTripped {
  shrinkGuardTripped: true;
  field: 'body';
  existingLength: number;
  newLength: number;
}

/** Exported for a fast pure-function unit test (no DB) — see issues-engineer.body-shrink-guard.test.ts. */
export function bodyShrinkTripped(existingBody: string | undefined | null, newBody: string): ShrinkGuardTripped | null {
  if (!existingBody || existingBody.length < BODY_SHRINK_GUARD_MIN_LENGTH) return null;
  if (newBody.length >= existingBody.length * BODY_SHRINK_GUARD_RETAIN_RATIO) return null;
  return { shrinkGuardTripped: true, field: 'body', existingLength: existingBody.length, newLength: newBody.length };
}

export async function updateIssue(
  id: string,
  patch: UpdateIssuePatch,
  opts: { workspaceId?: string; harnessSlug?: string | null } = {},
): Promise<EngineerIssue | null | ShrinkGuardTripped> {
  const { sql } = getOrgPg();
  const workspaceId = opts.workspaceId ?? await resolveIssueWorkspace(id);
  const physicalSlug = await resolveIssuePhysicalSlug(sql, workspaceId, id, opts.harnessSlug);
  if (physicalSlug === null) return null;
  if (patch.body !== undefined && !patch.confirmShrink) {
    const existing = await getIssueInWorkspace(workspaceId, id, { baseHarnessSlug: physicalSlug });
    const tripped = existing ? bodyShrinkTripped(existing.body, patch.body) : null;
    if (tripped) return tripped;
  }
  const rows = await sql<IssueRowDb[]>`
    UPDATE harness_shared.engineer_issues SET
      title = ${patch.title ?? sql`title`},
      body = ${patch.body ?? sql`body`},
      severity = ${patch.severity ?? sql`severity`},
      kind = ${patch.kind ?? sql`kind`},
      found_during = ${patch.foundDuring !== undefined ? patch.foundDuring : sql`found_during`},
      linked_feature_id = ${patch.linkedFeatureId !== undefined ? patch.linkedFeatureId : sql`linked_feature_id`},
      parent_id = ${patch.parent !== undefined ? patch.parent : sql`parent_id`},
      origin = 'local',
      updated_at = now()
    WHERE workspace_id = ${workspaceId}
      AND issue_id = ${id}
      AND base_harness_slug = ${physicalSlug}
    RETURNING ${sql.unsafe(ISSUE_COLS)}`;
  if (!rows[0]) return null;
  const issue = toIssue(rows[0]);
  if (!patch.silent) {
    await deliver(issue, 'updated', `issue ${id} updated: ${issue.title}`, patch.by ?? 'substrate');
  }
  return issue;
}

/** Claimable.claim — assign the issue. ATOMIC compare-and-claim (matches the
 *  feature-family path in work-items.ts claimWorkItem): the UPDATE only succeeds
 *  when the issue is UNCLAIMED or already held by THIS assignee (idempotent re-claim).
 *  A competing claim on an already-held issue gets null — exactly one agent wins,
 *  instead of a last-write-wins overwrite that silently stole a live grip. Stamps
 *  assigned_at: the implement lane's stale-claim reclaim (plan-implement.ts inFlight)
 *  ages claims off it — a claim without assigned_at reads as in-flight FOREVER and
 *  wedges the auto lane. */
export async function claimIssue(
  id: string,
  assignee: string,
  opts: {
    /** Server-derived dispatch actor; persist with the claim so reconciliation sees it. */
    assignedBy?: string;
    /**
     * EI-1545: an explicit, ALREADY-RESOLVED issue-scope workspace — pass the SAME
     * value the caller used for its own pre-claim family/existence check (e.g.
     * `resolveIssuesScopeWorkspace()` captured once in `claimWorkItem`). Omitted ⇒
     * byte-identical legacy behavior (re-derives via `issuesScopeWorkspace()` here).
     * See the workspaceId param on {@link claimWorkItem} for the full rationale.
     */
    workspaceId?: string;
    /**
     * EI-20731607691070897 — the CALLER, for an atomic self-held transfer. Widens the
     * CAS below by exactly one disjunct (the caller's OWN claim) so a holder can hand
     * the item to a named peer in the SAME UPDATE, instead of release → peer-claims
     * with a fleet-claimable gap in between. Never moves a third party's claim.
     * Full rationale on {@link claimWorkItem}'s opts.
     */
    fromHolder?: string;
    /**
     * EI-20417350647749715 — the holder the caller's force guard already proved
     * reclaimable. This is an EXPECTED-holder CAS leg, not a general overwrite:
     * the UPDATE may replace exactly this holder and still refuses if the row
     * changes between the guard read and the write.
     */
    expectedAssignee?: string;
    /**
     * EI-217141: private capability minted by deriveLeaderDispatchAdmission.
     * It is deliberately not a boolean or caller-supplied bypass; claimIssue
     * accepts only an object identity minted by this module's server-side
     * admission check, and still CASes the durable assigned_by provenance.
     */
    leaderDispatchAdmission?: LeaderDispatchAdmission;
    /**
     * EI-218293: private capability minted by deriveSelfFiledFalloutAdmission.
     * It is deliberately not caller-supplied; claimIssue validates object identity
     * and CASes the durable created_by provenance.
     */
    selfFiledFalloutAdmission?: SelfFiledFalloutAdmission;
    /**
     * EI-226378: private capability minted by the current fleet leader for an
     * exact legacy fleetScopeDowngrade marker. It only carries the existing
     * row's marker across the issue claim's born-pending SQL predicate.
     */
    legacyFleetScopeDowngradeAdmission?: LegacyFleetScopeDowngradeAdmission;
    /**
     * EI-22345414208647835: private capability minted only after the claim
     * tool's checked force guard authorizes replacing a dead/expired holder.
     * It bypasses only the born-pending admission floor and must agree with
     * the exact holder CAS below.
     */
    forceTakeoverAdmission?: ForceTakeoverAdmission;
    /** Exact reviewer-lane exception for a still-pending agent-review snapshot. */
    agentReviewAdmission?: AgentReviewClaimAdmission;
  } = {},
): Promise<EngineerIssue | null> {
  const { sql } = getOrgPg();
  const ws = opts.workspaceId ?? issuesScopeWorkspace();
  const expectedAssignee = opts.expectedAssignee?.trim() || null;
  const leaderDispatchAdmission =
    isLeaderDispatchAdmission(opts.leaderDispatchAdmission) &&
    opts.leaderDispatchAdmission.itemId === id &&
    opts.leaderDispatchAdmission.target === assignee &&
    opts.leaderDispatchAdmission.workspaceId === ws
      ? opts.leaderDispatchAdmission
      : null;
  const selfFiledFalloutAdmission =
    isSelfFiledFalloutAdmission(opts.selfFiledFalloutAdmission) &&
    opts.selfFiledFalloutAdmission.itemId === id &&
    opts.selfFiledFalloutAdmission.target === assignee &&
    opts.selfFiledFalloutAdmission.workspaceId === ws
      ? opts.selfFiledFalloutAdmission
      : null;
  const legacyFleetScopeDowngradeAdmission =
    isLegacyFleetScopeDowngradeAdmission(opts.legacyFleetScopeDowngradeAdmission) &&
    opts.legacyFleetScopeDowngradeAdmission.itemId === id &&
    opts.legacyFleetScopeDowngradeAdmission.target === assignee &&
    opts.legacyFleetScopeDowngradeAdmission.workspaceId === ws
      ? opts.legacyFleetScopeDowngradeAdmission
      : null;
  const forceTakeoverAdmission =
    isForceTakeoverAdmission(opts.forceTakeoverAdmission) &&
    opts.forceTakeoverAdmission.itemId === id &&
    opts.forceTakeoverAdmission.target === assignee &&
    opts.forceTakeoverAdmission.workspaceId === ws &&
    opts.forceTakeoverAdmission.expectedAssignee === expectedAssignee
      ? opts.forceTakeoverAdmission
      : null;
  const agentReviewAdmission =
    isAgentReviewClaimAdmission(opts.agentReviewAdmission) &&
    opts.agentReviewAdmission.itemId === id &&
    opts.agentReviewAdmission.reviewer === assignee &&
    opts.agentReviewAdmission.submittedBy !== assignee
      ? opts.agentReviewAdmission
      : null;
  const admissionFloor = agentReviewAdmission
    ? sql`(
        ${admittedWhereSql(sql)}
        OR ${agentReviewPendingAdmissionSql(sql, agentReviewAdmission, {
          payload: 'target.payload',
          admission: 'target.admission',
        })}
      )`
    : admittedWhereSql(sql);
  // WI-2142171: capture the prior holder BEFORE the UPDATE, so a NO-OP re-claim does not
  // re-notify every subscriber. Claiming BY ID deliberately bypasses the claim floors (the
  // WI-5826 escape hatch below), and the `assignee = ${assignee}` disjunct in the predicate
  // means an agent re-claiming an item it ALREADY holds matches this UPDATE on every call.
  // Each such no-op then fanned a fresh notify to the FULL subscriber set — and because this
  // path mints a random msg_id (unlike the substrate fan-out's deterministic
  // `fan-<outboxId>-<subscriber>`), the idempotent-delivery dedupe never saw it.
  // Measured over 7d before this guard: 2,888 claim notify rows, 1,712 of them (59%) redundant
  // repeats; worst single item re-claimed 56x over 17h, costing 448 inbox rows against a
  // fleet mean of ~3 per action.
  // Mirrors releaseIssue's identical pre-read of the BASE work_items table (which sidesteps
  // the engineer_issues view's harness_slug encoding split).
  const priorRows = await sql<{ taken_by: string | null; harness_slug: string; payload: unknown }[]>`
    SELECT taken_by, harness_slug, payload
      FROM harness_shared.work_items
     WHERE workspace_id = ${ws}
       AND feature_id = ${id}
       AND item_kind IN ('bug', 'change', 'task')`;
  const priorAssignee = priorRows[0]?.taken_by ?? null;
  const operationClaims = await import('./blueprint/operation-worker-binding');
  const operationClaimRead = await operationClaims.readActiveOperationWorkerClaimBinding(activeWorkspaceId(), assignee);
  if (!priorRows[0] || !operationClaims.matchOperationWorkerClaim(operationClaimRead, {
    id, harness: priorRows[0].harness_slug, payload: priorRows[0].payload,
  }).allowed) return null;
  // P-007 / D-021: a verification task is never held by its own reporter or implementer.
  // claimWorkItem checks this too, but this is the bottom issue writer and some callers
  // (the improvement-runner dispatcher) reach it directly. payload.verification is
  // written once when the task is created, so this pre-read is as good as the UPDATE's.
  if (verificationTaskConflict(priorRows[0].payload, assignee)) return null;
  // A holder's subject must be captured in the SAME atomic UPDATE as the claim.
  // The watchdog coalescer intentionally refreshes an open issue's visible
  // title/body and watchdogKey; a follow-up completion must not silently treat
  // that refreshed row as the subject the holder originally accepted.
  //
  // Exact same-holder reclaims and truncated-assignee self-heals are not new
  // claims. An unchanged subject keeps the payload byte-for-byte idempotent,
  // while a coalescer mutation is accepted only when the holder explicitly
  // re-claims and thereby refreshes the baseline. Blank/"unassigned" sentinels
  // and a genuinely different holder are new-holder claims and receive a fresh
  // stamp.
  const sameHolderPredicate = sql`(
    target.assignee = ${assignee}
    OR (target.assignee IS NOT NULL AND btrim(target.assignee) <> '' AND position(target.assignee in ${assignee}) = 1)
  )`;
  const baselinePayload = sql`CASE
    WHEN jsonb_typeof(target.payload) = 'object' THEN target.payload
    ELSE '{}'::jsonb
  END`;
  const claimSubjectBaseline = sql`
    jsonb_build_object(
      'kind', COALESCE(target.kind, 'bug'),
      'title', COALESCE(target.title, ''),
      'summary', COALESCE(target.body, ''),
      'body', COALESCE(target.body, ''),
      'watchdogKey', CASE
        WHEN jsonb_typeof(target.payload -> 'watchdogKey') = 'string'
          THEN target.payload ->> 'watchdogKey'
        ELSE NULL
      END
    )`;
  const stampedClaimSubjectPayload = sql`
    jsonb_set(
      ${baselinePayload},
      ARRAY[${CLAIM_SUBJECT_BASELINE_KEY}]::text[],
      ${claimSubjectBaseline},
      true
    )`;
  const stampedNewClaimPayload = sql`
    jsonb_set(
      ${stampedClaimSubjectPayload},
      '{claim_history_post_id}',
      to_jsonb(COALESCE((
        SELECT max(post.id)
          FROM harness_shared.coord_thread_posts post
         WHERE post.workspace_id = ${ws}
      ), 0)),
      true
    )`;
  const rows = await withPgContentionRetry(() => sql<IssueRowDb[]>`
    UPDATE harness_shared.engineer_issues AS target SET
      payload = CASE
        WHEN ${sameHolderPredicate}
          AND target.payload -> ${CLAIM_SUBJECT_BASELINE_KEY} IS NOT DISTINCT FROM ${claimSubjectBaseline}
        THEN target.payload
        WHEN ${sameHolderPredicate} THEN ${stampedClaimSubjectPayload}
        ELSE ${stampedNewClaimPayload}
      END,
      assignee = ${assignee}, assigned_by = COALESCE(${opts.assignedBy ?? null}, assigned_by),
      assigned_at = now(), origin = 'local', updated_at = now()
     WHERE workspace_id = ${ws} AND issue_id = ${id}
       AND ${operationClaims.operationWorkerClaimWhereSql(sql, operationClaimRead, {
         payload: 'target.payload', id: 'target.issue_id', harness: 'target.scope',
       })}
       -- EI-15027: a literal 'unassigned' sentinel (case/whitespace-insensitive) — some
       -- federated/legacy writers use it as a "not taken" placeholder instead of NULL/''
       -- (mirrors EI-7939's normalizeTakenBy for the feature-family taken_by column) —
       -- must be claimable, same as NULL/''; without this the row is PERMANENTLY stuck
       -- (this UPDATE never matches it, and classifyClaimFailure then misreports the
       -- resulting no-op as a live claim_conflict against holder:"unassigned").
       -- EI-20731607691070897: the last disjunct is the atomic self-held transfer leg
       -- (fromHolder = the CALLER). Absent, it falls back to the assignee and is a
       -- duplicate of the disjunct before it, leaving this predicate equivalent to
       -- its pre-change behavior.
       --
       -- EI-21921431863111143: the final disjunct self-heals a TRUNCATED assignee
       -- (some assignment path persisted a prefix of the real ownerId instead of the
       -- canonical full one, deadlocking checkpoint/claim against it). A stored
       -- assignee that is a non-empty strict prefix of the incoming assignee can
       -- only realistically BE that same caller's own truncated id (see
       -- isSelfOwnerRecord in work-items.ts), so the match both lets the true owner
       -- re-claim its own row and rewrites assignee to the full id in this UPDATE.
       AND (
         assignee IS NULL OR btrim(assignee) = '' OR lower(btrim(assignee)) = 'unassigned'
         OR assignee = ${assignee}
         OR assignee = ${opts.fromHolder ?? assignee}
         ${expectedAssignee ? sql` OR assignee = ${expectedAssignee}` : sql``}
         OR (assignee IS NOT NULL AND btrim(assignee) <> '' AND position(assignee in ${assignee}) = 1)
       )
       -- Born-pending admission is orthogonal to lifecycle status. A named claim
       -- cannot jump the promoter any more than scheduler:get_next can, EXCEPT
       -- for the two server-derived capabilities: current-leader dispatch and
       -- self-filed fallout. Keep each durable provenance CAS in its exception so
       -- a row changed after capability derivation cannot inherit old authorization.
       AND ${
        leaderDispatchAdmission ||
        selfFiledFalloutAdmission ||
        legacyFleetScopeDowngradeAdmission ||
        forceTakeoverAdmission ||
        agentReviewAdmission
          ? sql`(
               ${admissionFloor}
               ${
                 leaderDispatchAdmission
                   ? sql`OR (
                 admission = 'pending'
                 AND assigned_by = ${leaderDispatchAdmission.assignedBy}
               )`
                   : sql``
               }
              ${
                selfFiledFalloutAdmission
                   ? sql`OR (
                 admission = 'pending'
                 AND kind = 'bug'
                 AND created_by = ${selfFiledFalloutAdmission.createdBy}
               )`
                  : sql``
              }
              ${
                legacyFleetScopeDowngradeAdmission
                  ? sql`OR (
                admission = 'pending'
                AND (assigned_by IS NULL OR btrim(assigned_by) = '')
                AND COALESCE(payload->'fleetScopeDowngrade'->>'requestedAssignee', '') = ${legacyFleetScopeDowngradeAdmission.requestedAssignee}
                AND COALESCE(payload->'fleetScopeDowngrade'->>'reportedBy', '') = ${legacyFleetScopeDowngradeAdmission.reportedBy}
                AND COALESCE(payload->'fleetScopeDowngrade'->>'fleet', '') = ${legacyFleetScopeDowngradeAdmission.fleet}
                AND COALESCE(payload->'fleetScopeDowngrade'->>'code', '') = ${legacyFleetScopeDowngradeAdmission.code}
                AND COALESCE(payload->'fleetScopeDowngrade'->>'at', '') = ${legacyFleetScopeDowngradeAdmission.at}
              )`
                  : sql``
              }
               ${
                 forceTakeoverAdmission
                   ? sql`OR (
                 admission = 'pending'
                 AND assignee = ${forceTakeoverAdmission.expectedAssignee}
               )`
                   : sql``
               }
             )`
           : admissionFloor
       }
       -- P-007 / D-016 (observation-candidate-acceptance-promotion): a by-id or
       -- leader-dispatched NEW holder passes the same acceptance floor as
       -- self-selection, so pending, rejected, stale-approved, unreviewed or
       -- metadata-missing intake cannot be taken by naming it. Exempt: a same-holder
       -- re-claim, the reviewer admission for a pending review, self-filed fallout
       -- (the creator taking its own filing), the submitter's own revision interval,
       -- and a terminal row (the WI-5826 reopen escape hatch below).
       AND (
         ${sameHolderPredicate}
         ${agentReviewAdmission || selfFiledFalloutAdmission ? sql`OR TRUE` : sql``}
         OR target.state = ANY(${ISSUE_TERMINAL_STATES as string[]}::text[])
         OR (
           COALESCE(target.payload, '{}'::jsonb) -> 'agentReview' ->> 'status' = 'revision-requested'
           AND COALESCE(target.payload, '{}'::jsonb) -> 'agentReview' ->> 'submittedBy' = ${assignee}
         )
         OR ${agentReviewNormalExclusionSql(sql, 'target.payload', 'engineer_issues')}
       )
       -- WI-5826 NOTE — deliberately NO terminal-state floor here. Claiming an
       -- already-completed row BY ID is an INTENTIONAL, tested escape hatch (EI-8972:
       -- "a completed row is STILL directly claimable by id — the floor only gates
       -- self-select"), because taking a finished item by name is how you reopen it,
       -- inherit ownership, or attach follow-up work. The self-select path
       -- (claimNextIssueWorkItem) is the one that must never opportunistically serve
       -- finished work, and it enforces that as its alreadyCompleted floor.
       -- The real WI-5826 defect was that the CALLER GOT NO SIGNAL — work_items:claim
       -- returned a bare ok:true on a state='done' row, so an agent could not tell fresh
       -- work from finished work. That is fixed where it belongs, in the claim TOOL's
       -- success path (a loud terminalWarning), not by removing this escape hatch.
    RETURNING ${sql.unsafe(ISSUE_COLS)}`);
  if (!rows[0]) return null;
  const issue = toIssue(rows[0]);
  // The claimer follows the issue.
  await subs.subscribe({
    subscriber_id: assignee,
    target_kind: 'object',
    target_ref: `${ISSUE_KIND}:${id}`,
    delivery_mode: 'full',
    created_ts: nowIso(),
  });
  // WI-2142171: notify ONLY when the claim actually changed the holder (see the pre-read
  // above). A re-claim by the current holder is a no-op for every subscriber — and for the
  // claimer itself, whose own action it is, `deliver` already excludes the actor. The test
  // is exact equality, matching the SQL disjunct that admits the re-claim; a claim that
  // rewrites a NULL/blank/'unassigned' sentinel, or self-heals a truncated id, still differs
  // and still notifies.
  if (priorAssignee !== assignee) {
    await deliver(issue, 'updated', `issue ${id} claimed by ${assignee}`, assignee);
  }
  return issue;
}

/**
 * WI-2990/WI-3006: bump an issue-family (bug/change/task) row's `last_progress_at`
 * to now — the issue-family mirror of {@link ../work-items.markFeatureProgress}.
 *
 * Writes the BASE `harness_shared.work_items` table directly (not through the
 * `engineer_issues` compat view) so it can match by (workspace_id, feature_id)
 * alone — issue ids are globally unique, and matching this way sidesteps the
 * harness_slug encoding split (`<slug>` vs `operator:<workspace_id>`) that a
 * `markFeatureProgress`-style `harness_slug = <caller's harness>` match would
 * get wrong for an operator-scoped issue. Only a CLAIMED row is credited — an
 * unclaimed/terminal row matches 0 rows and is a harmless no-op (mirrors
 * markFeatureProgress's own guard). Fail-soft: swallows errors so a progress
 * bump can never break the caller's primary write (e.g. a checkpoint write).
 *
 * @returns true if a held issue-family row was bumped, false otherwise.
 */
export async function markIssueProgress(id: string): Promise<boolean> {
  if (!id) return false;
  try {
    const { sql } = getOrgPg();
    const res = await sql`
      UPDATE harness_shared.work_items
         SET last_progress_at = now()
       WHERE workspace_id = ${issuesScopeWorkspace()} AND feature_id = ${id}
         AND item_kind IN ('bug', 'change', 'task')
         AND taken_by IS NOT NULL AND taken_by <> ''`;
    return res.count > 0;
  } catch {
    return false;
  }
}

/**
 * Record a release in the keyed cooldown sidecar (migration 1055).
 *
 * The legacy work_items columns can retain only one releasing agent. This write
 * is deliberately best-effort so a runtime that starts before migration 1055 can
 * still release using the legacy stamp; the claim floors retain that stamp as a
 * compatibility fallback. The INSERT derives harness_slug from the base row so
 * operator-scoped and harness-scoped issue encodings cannot diverge from readers.
 */
export async function recordWorkItemReleaseCooldown(opts: {
  workspaceId: string;
  harnessSlug: string;
  featureId: string;
  agentId: string;
}, client?: OrgSql): Promise<void> {
  const agentId = opts.agentId.trim();
  const harnessSlug = opts.harnessSlug.trim();
  if (!agentId || !harnessSlug) return;
  try {
    const write = (sql: OrgSql) => sql`
      INSERT INTO harness_shared.work_item_release_cooldowns
        (workspace_id, harness_slug, feature_id, agent_id, released_at)
      SELECT workspace_id, harness_slug, feature_id, ${agentId}, now()
       FROM harness_shared.work_items
       WHERE workspace_id = ${opts.workspaceId}
         AND harness_slug = ${harnessSlug}
         AND feature_id = ${opts.featureId}
      ON CONFLICT (workspace_id, harness_slug, feature_id, agent_id) DO UPDATE
        SET released_at = EXCLUDED.released_at`;
    if (client) await write(client);
    else await boundedOrgTxn((tx) => write(tx));
  } catch {
    // Migration 1055 may not yet be applied on an older runtime. The legacy
    // columns were written by the same release, so the reader still has a safe
    // compatibility floor until the sidecar is available.
  }
}

export async function releaseIssue(
  id: string,
  opts: { expectedAssignee?: string } = {},
): Promise<EngineerIssue | null> {
  // EI-23215738429986679: resolve the issue workspace, capture its prior holder, perform the
  // compare-and-release UPDATE, and persist release cooldown in ONE bounded admin transaction.
  // The old path used raw getOrgPg() queries before/after the UPDATE; a pool or row-lock stall
  // could therefore outlive the MCP transport and leave the caller with an unknown release
  // outcome even though the mutation eventually landed. Passing the transaction client into
  // the existing workspace/cooldown helpers keeps this change on the canonical surfaces while
  // making the whole issue-family release atomic and fail-fast.
  const released = await boundedOrgTxn(async (tx) => {
    const ws = await resolveIssueWorkspace(id, undefined, tx);
    // EI-6480: capture the prior assignee BEFORE clearing it, so we can clean up that owner's
    // stale per-Hive claim lease below — else the just-freed issue stays lease-poisoned (reads
    // unclaimed yet fails lease arbitration for every new claimer) until the lease TTL lapses.
    const prev = await tx<{ taken_by: string | null; harness_slug: string | null }[]>`
      SELECT taken_by, harness_slug
        FROM harness_shared.work_items
       WHERE workspace_id = ${ws}
         AND feature_id = ${id}
         AND item_kind IN ('bug', 'change', 'task')`;
    const formerAssignee = prev[0]?.taken_by ?? null;
    const formerHarnessSlug = prev[0]?.harness_slug ?? null;
    // EI-7588: when `expectedAssignee` is given (the work_items:release TOOL's holder guard),
    // the UPDATE itself only touches the row when it is unclaimed OR already held by the
    // expected caller — atomic compare-and-release, no fetch-then-write race. A row held by
    // someone ELSE matches 0 rows and this returns null; the caller (release.ts) re-reads to
    // tell the two apart and report an honest `not_holder` + holder.
    // P-003 / D-002: mirror the feature-family release contract. A released issue that was
    // mid-flight must return to the single issue claimable token (open), while parked and
    // terminal states retain their meaning. Without this normalization, an unassigned `wip`
    // issue is outside coord:dispatch's claimable frontier and remains stranded indefinitely.
    const releasePreservedStates = ['open', 'blocked', 'needs-human', ...ISSUE_TERMINAL_STATUSES];
    const rows = await tx<IssueRowDb[]>`
      UPDATE harness_shared.engineer_issues SET
         assignee = NULL,
         assigned_at = NULL,
         -- Preserve parked/terminal lifecycle states; normalize every other release state
         -- (wip, legacy in-progress spellings, and unknown drift) to the claimable "open".
         state = CASE
           WHEN COALESCE(state, '') <> ALL(${releasePreservedStates}::text[]) THEN 'open'
           ELSE state
         END,
         origin = 'local',
         updated_at = now()
       WHERE workspace_id = ${ws} AND issue_id = ${id}
         AND (${opts.expectedAssignee ?? null}::text IS NULL OR assignee IS NULL OR assignee = ${opts.expectedAssignee ?? null})
       RETURNING ${tx.unsafe(ISSUE_COLS)}`;
    if (!rows[0]) return null;
    const issue = toIssue(rows[0]);
    if (formerAssignee && formerHarnessSlug) {
      await recordWorkItemReleaseCooldown(
        {
          workspaceId: ws,
          harnessSlug: formerHarnessSlug,
          featureId: id,
          agentId: formerAssignee,
        },
        tx,
      );
    }
    return { issue, formerAssignee };
  });
  if (!released) return null;
  const { issue, formerAssignee } = released;
  // Direct issue release callers (outside work_items:release) must retire the
  // same cached goal as the unified release path. Compare before clearing so a
  // delayed release cannot erase a newer goal claimed by this owner.
  if (formerAssignee) clearGoalClaimedIfMatches(formerAssignee, id);
  // EI-6480: harness-agnostic (issue ids are globally unique), flag-gated, best-effort lease
  // cleanup so the released issue is IMMEDIATELY re-claimable, not lease-poisoned until TTL.
  // Covers every voluntary release path (work_items:release + the improvement resolve-core
  // paths) and every scope (operator-scope issues, whose bare harness releaseWorkItem can't
  // recover, are the confirmed-failing case). Dynamic import avoids a static cycle.
  if (formerAssignee) {
    // Workspace defaults to activeWorkspaceId() inside releaseIssueClaimLease — the workspace
    // leaseClaimedWorkItem keyed the lease under at acquire (which is NOT necessarily the
    // issue's scope-workspace `ws`); passing `ws` here would miss the lease if they diverge.
    void trackDetached(import('./work-item-claim-lease-wiring'))
      .then((m) => m.releaseIssueClaimLease({ workItemId: id, owner: formerAssignee }))
      .catch(() => {});
  }
  // WI-2142171: notify ONLY when a real holder was actually released. The UPDATE above
  // deliberately matches an already-unassigned row (`assignee IS NULL` is permitted so the
  // state normalization can still run), so a repeated release re-fanned the full subscriber
  // set for a change that did not happen — measured at 233 notify rows for ONE item over
  // 37.6h, and 1,436 of 2,168 release notify rows (66%) redundant across 7d. Every other
  // side-effect above is already guarded on `formerAssignee` for exactly this reason; this
  // was the one that was not. The blank/'unassigned' normalization mirrors the claim
  // predicate's "not taken" sentinels (EI-15027) so both guards agree on what "held" means.
  const releasedARealHolder =
    formerAssignee != null && formerAssignee.trim() !== '' && formerAssignee.trim().toLowerCase() !== 'unassigned';
  if (releasedARealHolder) {
    await deliver(issue, 'updated', `issue ${id} released (unassigned)`);
  }
  return issue;
}

/**
 * Lifecycle.setState — close/resolve/reopen the issue.
 *
 * Completion-integrity gate (work-item-completion-integrity-2026-07-01 WI-1403):
 * a transition INTO a terminal state (resolved|closed, per ISSUE_TERMINAL_STATUSES)
 * must carry both `by` (the claiming principal) and `completionRef` (a completion
 * summary / commit / coord / plan-item reference — any non-empty evidence string).
 * Reject otherwise, so a bare/anonymous flip — e.g. a watchdog dedup marker — can
 * never masquerade as a genuine completion. `opts.skipCompletionGate` is a narrow,
 * explicit bypass for TRUSTED internal restore paths (e.g. the autonomy tripwire
 * reverting to a captured prior state) that are not completions at all.
 */
export async function setIssueState(
  id: string,
  state: IssueState,
  by?: string,
  completionRef?: string,
  opts: {
    completionEvidence?: PersistedCompletionEvidence;
    /** Already validated by the unified work-item completion boundary. */
    blueprintResult?: { operationId: string; specificationRevision: string; output: unknown; evidenceRef: string };
    /** Internal, receipt-fenced DBOS program-root terminal write. */
    acceptedProgramAttempt?: import('./blueprint/operation-worker-binding').AcceptedProgramRootAttempt;
    /**
     * P-008 (d) / D-050 / D-079 — the RESOLVED assumption declaration this close
     * rests on, stored under `TERMINAL_ASSUMPTIONS_KEY`. Optional here for the same
     * reason as on the feature family: this is also the system write path
     * (watchdog auto-close, restore, reconcile), and those are not completions.
     */
    assumptions?: StoredAssumptionDeclaration;
    skipCompletionGate?: boolean;
    /**
     * A deliberate same-terminal correction from work_items:set_state. When a
     * force close supplies only a completionRef, it must not clear the
     * structured record already stored by work_items:complete.
     */
    force?: boolean;
    /**
     * agent-protocol-authority-semantics-2026-07-26 P-004 — the completion-authority
     * judgement the gate reached for THIS close (`authorityForCompletion(evidence)`).
     * Supplying it SATISFIES the completion-integrity gate in place of `completionRef`:
     * a caller that has judged its own evidence has done strictly more than assert a
     * non-empty string, and the consequence of a weak judgement is now `proposed`
     * (invisible to burn-down) rather than a rejection.
     */
    completionAuthority?: WorkItemCompletionAuthority;
    /**
     * Internal handoff from the unified work-items facade. That facade owns the
     * cross-family conflict callback and may already have archived the displaced
     * issue completion before delegating the authoritative write here. Direct
     * callers omit this and continue through this module's own guard.
     */
    secondTerminalCloseHandledByUnified?: boolean;
    /** Legacy terminal spelling supplied by the unified writer; commit with status. */
    terminalReason?: string | null;
    /**
     * WI-10006010: the physical `harness_slug` of the ONE row this write may touch, already
     * pinned by the caller (the unified writer pins it once and shares it with the origin
     * heals). Omitted: pinned here to the row `getIssue` would read. Every statement below is
     * scoped to it, so a sibling row sharing this feature_id is never written.
     */
    harnessSlug?: string | null;
  } = {},
): Promise<EngineerIssue | null> {
  const isTerminal = ISSUE_TERMINAL_STATUSES.has(state);
  if (isTerminal && !opts.skipCompletionGate) {
    if (isTransportOnlyIdentity(by)) {
      throw new Error(
        `completion-integrity: issue '${id}' → '${state}' rejected — '${by}' is a transport-only ` +
          `identity with no live completion owner. Retry through a connected agent session. For an ` +
          `HTTP/MCP loopback replay, add ?client=<ownerId> to the /api/mcp URL; CLI callers may ` +
          `pass --client <ownerId>.`,
      );
    }
    if (!by || !by.trim()) {
      throw new Error(
        `completion-integrity: issue '${id}' → '${state}' rejected — a terminal transition requires an owner (by)`,
      );
    }
    if (!completionRef?.trim() && !opts.completionAuthority) {
      // EI-7119: a bare rejection here sent callers on a 3-call round-trip (complete
      // without state → set_state without completionRef → rejected → re-complete with
      // both). Name the actual fix inline so the FIRST rejection is the last one.
      //
      // P-004 rewrote what this message promises. It used to say work_items:complete
      // "supplies it from completion.summary automatically" — that auto-fill is GONE
      // (it was what made this gate bind on a value that could never be absent). The
      // honest instruction now is to supply real verification evidence, because that is
      // what decides whether the close lands `committed` or `proposed`.
      throw new Error(
        `completion-integrity: issue '${id}' → '${state}' rejected — a terminal transition requires either a ` +
          `completionRef or a completion-authority judgement. Prefer ` +
          `work_items:complete { id, state: "${state}", completion: { summary: "...", verifiedHow: "...", ` +
          `testResult: "..." } } — it judges your evidence and stamps the authority for you. ` +
          `Note that summary ALONE now lands \`proposed\` (recorded, but not counted toward burn-down); ` +
          `\`committed\` needs verifiedHow plus one of testsRun/testResult. ` +
          `Or pass a ref directly (set_state { id, state, completionRef: "..." }). A prior ` +
          `work_items:complete WITHOUT \`state\` does NOT persist anything this call can reuse, so re-call ` +
          `complete with both, not set_state alone.`,
      );
    }
  }
  const ws = await resolveIssueWorkspace(id);
  const operationClaims = !opts.skipCompletionGate
    ? await import('./blueprint/operation-worker-binding') : null;
  const operationEffectRead = operationClaims
    ? opts.acceptedProgramAttempt ? null : by
      ? await operationClaims.readActiveOperationWorkerClaimBinding(ws, by)
      : { status: 'none' as const }
    : null;
  const evidencePayloadJson = terminalPayloadMergeJson(opts.completionEvidence, opts.assumptions, opts.blueprintResult);
  // EI-21184699633369991: work_items:set_state { force:true } accepts a
  // completionRef without structured evidence. Preserve the existing authority
  // on that ref-only correction; otherwise the terminal UPDATE turns a valid
  // completion into an authority:null row. The payload branch below already
  // preserves _completionEvidence when no new evidence is supplied.
  const preserveExistingCompletionRecord =
    Boolean(opts.force) &&
    !opts.skipCompletionGate &&
    !opts.completionAuthority &&
    !(opts.completionEvidence && Object.keys(opts.completionEvidence).length > 0);
  // design-to-code-coverage-seam-2026-09-02 P-003: an AGENT close that satisfied the gate
  // with a bare completionRef judged nothing, and a NULL terminal authority reads as a
  // legacy pre-contract close that COUNTS toward burn-down (D-005). Judge it here, through
  // the same single grader, so no close made under the contract can be filed as predating
  // it. Returns null — today's behaviour, unchanged — for every case in its doc.
  const effectiveCompletionAuthority =
    opts.completionAuthority ??
    derivedTerminalCompletionAuthority({
      isTerminal,
      by,
      skipCompletionGate: opts.skipCompletionGate,
      suppliedAuthority: opts.completionAuthority,
      preserveExistingRecord: preserveExistingCompletionRecord,
      evidence: opts.completionEvidence,
    });
  // EI-19284963139619048: this UPDATE is the state-write half of EVERY issue-family
  // work_items:complete/set_state call — the highest-traffic write in the fleet's
  // completion path. It used to run on the raw, unbounded `getOrgPg()` admin pool
  // (no statement_timeout — see pg-bounded-txn.ts's header, which documents this
  // EXACT symptom class, "work_items:comment hung, then timed out on a blind
  // retry", already fixed there but never migrated here). Under fleet load a stall
  // here (lock wait, CPU-starved backend, slow scan) ran unbounded and hung the
  // MCP call until the client's own 300s idle-timeout killed it blind, requiring a
  // retry with no diagnostic. boundedOrgTxn sets a real statement_timeout +
  // lock_timeout so a stall now fails fast with a typed OrgTxnTimeoutError instead
  // — which the caller (work_items:complete/set_state) already catches and reports
  // as `stateError` (the completion record is never lost, EI-24).
  //
  // EI-20092514168581881 / migration 797: terminal issue transitions deliberately
  // update the unified `work_items` BASE table here, not the `engineer_issues`
  // compatibility view. The view is now a field-edit/read surface whose trigger
  // refuses lifecycle transitions; keeping the gate above this direct base write
  // preserves both genuine completion evidence and trusted skipCompletionGate
  // system paths without adding a trigger bypass.
  let priorAssignee: string | null = null;
  let terminalWriteSucceeded = false;
  let terminalWriteWasAttested = false;
  const rows = await boundedOrgTxn(async (tx) => {
    // WI-10006010: physical identity is (workspace_id, harness_slug, feature_id). Pin ONE row
    // and scope every statement below to it; keyed on feature_id alone, a close of one row
    // rewrote every slug twin (3 done/committed twins flipped to dropped on 2026-10-03).
    // A null/blank harness hint means "use the normal read preference", not "remove the
    // physical-row predicate". Always resolve one slug so reopen and completion updates
    // cannot fan out to same-id twins.
    const slug = await resolveIssuePhysicalSlug(tx, ws, id, opts.harnessSlug);
    const onBaseRow = () => (slug ? tx`AND harness_slug = ${slug}` : tx``);
    const onAliasedRow = () => (slug ? tx`AND wi.harness_slug = ${slug}` : tx``);
    const onViewRow = () => (slug ? tx`AND base_harness_slug = ${slug}` : tx``);
    // Lock the canonical row before any state or completion side effect. A
    // reassignment then waits and observes this write, or wins first and makes
    // the old worker's effect predicate fail.
    const prior = await tx<
        {
          taken_by: string | null;
          harness_slug: string;
          status: string;
          updated_ts: string | number;
          payload: unknown;
          terminal_owner: string | null;
          terminal_completion_ref: string | null;
          authority: string | null;
        }[]
      >`
        SELECT taken_by, harness_slug, status, updated_ts, payload,
               terminal_owner, terminal_completion_ref, authority
          FROM harness_shared.work_items
         WHERE workspace_id = ${ws} AND feature_id = ${id}
           AND item_kind IN ('bug', 'change', 'task')
           AND origin <> 'remote'
           ${onBaseRow()}
        FOR UPDATE`;
    const priorRow = prior[0];
    if (!priorRow) return [] as IssueRowDb[];
    // D-029 (plan unified-bug-pipeline-and-honest-queue-2026-10-05): the bottom issue writer
    // refuses a needs-human park without an answerable owner ask, read off the LOCKED row, so a
    // caller that skips setWorkItemState (resolve-core did) cannot write the hold-with-no-clearer
    // shape. Same predicate as the census and the canonical writer.
    if (state === 'needs-human' && priorRow.status !== 'needs-human' && !hasActiveStrictHumanAsk(priorRow.payload)) {
      throw new Error(
        `work_item '${id}' → 'needs-human' rejected — the item carries no answerable owner ask. Record it first with ` +
          `work_items:set_blocker { id: '${id}', kind: 'human', capability, ref, summary, nextVerb, defaultIfUnanswered }: ` +
          'defaultIfUnanswered says what happens if the owner never answers.',
      );
    }
    if (opts.acceptedProgramAttempt) {
      const payload = priorRow.payload && typeof priorRow.payload === 'object' &&
        !Array.isArray(priorRow.payload) ? priorRow.payload as Record<string, unknown> : {};
      if (Number(priorRow.updated_ts) !== opts.acceptedProgramAttempt.updatedTs ||
          ISSUE_TERMINAL_STATUSES.has(priorRow.status) ||
          Object.prototype.hasOwnProperty.call(payload, 'reopenHistory') ||
          (opts.acceptedProgramAttempt.requireUncancelled &&
            Object.prototype.hasOwnProperty.call(payload, 'blueprintCancellation'))) {
        return [] as IssueRowDb[];
      }
    }
    if (operationClaims && operationEffectRead) {
      const harness = priorRow.harness_slug.startsWith('harness:')
        ? priorRow.harness_slug.slice('harness:'.length) : priorRow.harness_slug;
      const match = operationClaims.matchOperationWorkerClaim(operationEffectRead, {
        id, harness, payload: priorRow.payload,
      });
      if (!match.allowed || (operationEffectRead.status === 'bound' && priorRow.taken_by !== by)) {
        throw new Error(`blueprint operation effect refused: ${match.allowed ? 'current claim holder changed' : match.reason}`);
      }
    }
    const currentEffect = operationClaims && opts.acceptedProgramAttempt
      ? tx`EXISTS (
          SELECT 1 FROM harness_shared.work_items AS wi
           WHERE wi.workspace_id = ${ws} AND wi.feature_id = ${id} ${onAliasedRow()}
             AND ${operationClaims.programRootEffectWhereSql(tx, opts.acceptedProgramAttempt, {
               payload: 'wi.payload', id: 'wi.feature_id', harness: 'wi.harness_slug',
               status: 'wi.status', updated: 'wi.updated_ts',
             })}
        )`
      : operationClaims && operationEffectRead
      ? tx`EXISTS (
          SELECT 1 FROM harness_shared.work_items AS wi
           WHERE wi.workspace_id = ${ws} AND wi.feature_id = ${id} ${onAliasedRow()}
             AND ${operationClaims.operationWorkerEffectWhereSql(tx, operationEffectRead, {
               payload: 'wi.payload', id: 'wi.feature_id', harness: 'wi.harness_slug', holder: 'wi.taken_by',
             })}
        )`
      : tx`TRUE`;
    if (isTerminal) {
      const priorBlueprintPin = priorRow.payload && typeof priorRow.payload === 'object' &&
        !Array.isArray(priorRow.payload) ? (priorRow.payload as Record<string, unknown>).blueprintOperation : null;
      if (!opts.skipCompletionGate && (state === 'done' || state === 'resolved') &&
          priorBlueprintPin && !opts.blueprintResult) {
        throw new Error('blueprint operation completion requires validated outputPayload');
      }
      // Clear the cached goal for the holder this write actually releases.
      priorAssignee = priorRow?.taken_by ?? null;

      // EI-21351699305761113 / EI-18736669939338784: direct issue callers bypass
      // work-items.ts's second-terminal-close guard. Preserve the first completion
      // record here while the row lock is held, so a stale peer cannot overwrite
      // terminal credit, state, or structured evidence. A strictly richer incoming
      // record may supersede the first, but the displaced record is archived rather
      // than discarded.
      const isSecondTerminalClose =
        !opts.secondTerminalCloseHandledByUnified &&
        !opts.force &&
        !opts.skipCompletionGate &&
        Boolean(by?.trim()) &&
        Boolean(priorRow?.terminal_owner) &&
        by !== priorRow?.terminal_owner &&
        ISSUE_TERMINAL_STATUSES.has(priorRow?.status ?? '') &&
        ISSUE_TERMINAL_STATUSES.has(state);
      if (isSecondTerminalClose && priorRow) {
        const existingEvidence = extractTerminalCompletionEvidence(priorRow.payload);
        const incomingEvidence = opts.completionEvidence ?? null;
        const existingSufficient = isSufficientEvidence(existingEvidence);
        const incomingSufficient = isSufficientEvidence(incomingEvidence);
        const upgrade = incomingSufficient && !existingSufficient;
        const existingAuthority = isWorkItemCompletionAuthority(priorRow.authority) ? priorRow.authority : null;
        const attestation: CompletionAttestation = {
          at: new Date().toISOString(),
          by: upgrade ? priorRow.terminal_owner : (by ?? null),
          state: upgrade ? priorRow.status : state,
          completionRef: upgrade ? priorRow.terminal_completion_ref : (completionRef ?? null),
          completionAuthority: upgrade ? existingAuthority : (opts.completionAuthority ?? null),
          evidence: upgrade ? existingEvidence : incomingEvidence,
          assumptions: upgrade ? readStoredAssumptions(priorRow.payload) : (opts.assumptions ?? null),
          outcome: upgrade ? 'superseded' : 'attested',
        };
        const existingAttestations = (priorRow.payload as Record<string, unknown> | null)?.[
          COMPLETION_ATTESTATIONS_KEY
        ];
        const priorAttestations = Array.isArray(existingAttestations) ? existingAttestations : [];
        const mergedAttestations = JSON.stringify({
          [COMPLETION_ATTESTATIONS_KEY]: [...priorAttestations.slice(-4), attestation],
        });
        await tx`
          UPDATE harness_shared.work_items
             SET payload = COALESCE(payload, '{}'::jsonb) || ${mergedAttestations}::text::jsonb,
                 updated_ts = (extract(epoch FROM now()) * 1000)::bigint
           WHERE workspace_id = ${ws} AND feature_id = ${id}
             AND item_kind IN ('bug', 'change', 'task')
             AND origin <> 'remote'
             ${onBaseRow()}`;
        if (!upgrade) {
          terminalWriteWasAttested = true;
          return await tx<IssueRowDb[]>`
            SELECT ${tx.unsafe(ISSUE_COLS)}
              FROM harness_shared.engineer_issues
             WHERE workspace_id = ${ws} AND issue_id = ${id} AND origin <> 'remote'
               ${onViewRow()}
             ORDER BY updated_at DESC NULLS LAST`;
        }
      }
      const updated = await tx<{ feature_id: string }[]>`
        UPDATE harness_shared.work_items
         SET status = ${state},
               terminal_reason = COALESCE(${opts.terminalReason ?? null}, terminal_reason),
               origin = 'local', updated_ts = (extract(epoch FROM now()) * 1000)::bigint,
               taken_by = NULL, taken_at = NULL,
               -- Keep the item-scoped progress signal tied to its claim. A terminal
               -- transition releases the holder, so retaining the old timestamp makes
               -- finished issue-family work look like a cold in-flight claim to readers.
               -- This mirrors the feature-family terminal writer below.
               last_progress_at = NULL,
               -- WI-6218: PRESERVE an existing completion record on a skipCompletionGate
               -- write. Those paths (watchdog auto-close, system sweep, restore) are
               -- documented as "not completions at all" and are deliberately exempt from the
               -- second-terminal-close guard in work-items.ts — but they still reached this
               -- UPDATE and stamped terminal_owner/ref/authority unconditionally, so a sweep
               -- re-closing an already-completed issue took CREDIT for a real agent's
               -- completion and NULLED its ref + authority (these callers pass neither).
               -- A write that is "not a completion" has no business claiming completion
               -- credit — the same reasoning that already forbids it writing a
               -- terminal_completion_ref (WI-1404). Preserve-when-present, so a fresh row
               -- keeps today's behaviour and no restore/sweep caller changes.
               last_released_by = CASE WHEN taken_by IS NOT NULL AND taken_by <> ''
                                       THEN taken_by ELSE last_released_by END,
               last_released_at = CASE WHEN taken_by IS NOT NULL AND taken_by <> ''
                                       THEN now() ELSE last_released_at END,
               terminal_owner = CASE WHEN ${Boolean(opts.skipCompletionGate)}
                                       THEN COALESCE(NULLIF(terminal_owner, ''), ${by ?? null})
                                     ELSE ${by ?? null} END,
               terminal_completion_ref = CASE WHEN ${Boolean(opts.skipCompletionGate)}
                                                THEN COALESCE(NULLIF(terminal_completion_ref, ''), ${completionRef ?? null})
                                              ELSE ${completionRef ?? null} END,
               -- P-004: the authority judgement for THIS close. Left NULL when the caller
               -- supplied none — a legacy-shaped close (D-008), which is exactly right for
               -- the skipCompletionGate system paths.
               -- design-to-code-coverage-seam-2026-09-02 P-003 closed the OTHER half of that
               -- sentence ("any writer not yet migrated"): an AGENT close that satisfied the
               -- gate with a bare ref is now judged by derivedTerminalCompletionAuthority
               -- above, so it can no longer be filed as a pre-contract legacy close. SYSTEM
               -- and transport-only identities still land NULL, deliberately.
               authority = CASE WHEN ${Boolean(opts.skipCompletionGate)}
                                  THEN COALESCE(authority, ${effectiveCompletionAuthority ?? null})
                                WHEN ${preserveExistingCompletionRecord}
                                  THEN authority
                                ELSE ${effectiveCompletionAuthority ?? null} END,
               -- EI-21238720089733298: a terminal issue is no longer eligible for any
               -- claim-hold semantics. Leaving "_claimHold" or either provenance family
               -- behind makes a completed row read like a live compatibility hold, even
               -- though the terminal state and claim release are authoritative. Clear the
               -- hold metadata in this same UPDATE so readers cannot observe a half-closed
               -- row, while preserving unrelated payload and completion evidence.
               payload = CASE
                           WHEN payload IS NULL AND ${evidencePayloadJson}::text::jsonb IS NULL
                             THEN NULL
                           ELSE (
                             CASE WHEN ${evidencePayloadJson}::text::jsonb IS NULL
                                  THEN COALESCE(payload, '{}'::jsonb)
                                  -- WI-42437: sanitize only the INCOMING completion
                                  -- patch. jsonb_strip_nulls is recursive, so applying it
                                  -- after the merge deletes explicit null-valued fields from
                                  -- unrelated existing metadata (for example
                                  -- payload.triage.{judge,judgedAt,mergeInto}).
                                  -- WI-1409142: that same recursion also reached INSIDE the
                                  -- patch's own completion evidence. Stripping the incoming
                                  -- patch protected EXISTING metadata but not the evidence
                                  -- being written, and the evidence IS the patch -- so
                                  -- _completionEvidence.*.contentIdentity[].headBlobSha and
                                  -- .workingTreeBlobSha lost their keys whenever they were
                                  -- legitimately null (a declared path not yet in HEAD, the
                                  -- ordinary state when closing before git-sync sweeps).
                                  -- Those keys are REQUIRED by
                                  -- CompletionSettlementManifestSchema, so the manifest
                                  -- failed safeParse and the settlement reconciler skipped
                                  -- the row silently, stranding the close at 'proposed'.
                                  -- Exempt the evidence subtree; merge it verbatim.
                                  ELSE COALESCE(payload, '{}'::jsonb) || (
                                         jsonb_strip_nulls(
                                           ${evidencePayloadJson}::text::jsonb - '_completionEvidence' - 'blueprintResult'
                                         )
                                         || CASE WHEN ${evidencePayloadJson}::text::jsonb ? '_completionEvidence'
                                                 THEN jsonb_build_object(
                                                        '_completionEvidence',
                                                        ${evidencePayloadJson}::text::jsonb -> '_completionEvidence'
                                                      )
                                                 ELSE '{}'::jsonb
                                            END
                                         || CASE WHEN ${evidencePayloadJson}::text::jsonb ? 'blueprintResult'
                                                 THEN jsonb_build_object(
                                                        'blueprintResult',
                                                        ${evidencePayloadJson}::text::jsonb -> 'blueprintResult'
                                                      )
                                                 ELSE '{}'::jsonb
                                            END
                                       )
                             END
                           ) - '_claimHold' - 'held_open_by' - 'held_open_reason' - 'held_open_at'
                             - 'claim_hold_by' - 'claim_hold_reason' - 'claim_hold_at'
                         END
         WHERE workspace_id = ${ws} AND feature_id = ${id}
           AND item_kind IN ('bug', 'change', 'task')
           AND origin <> 'remote'
           ${onBaseRow()}
           AND ${currentEffect}
        RETURNING feature_id`;
      if (updated.length === 0) return [] as IssueRowDb[];
      terminalWriteSucceeded = true;
      // Read through the view after the base write so the mapper receives the same
      // stable issue-family shape as every other issue read, without invoking its
      // lifecycle-rejecting INSTEAD OF UPDATE trigger.
      return await tx<IssueRowDb[]>`
        SELECT ${tx.unsafe(ISSUE_COLS)}
          FROM harness_shared.engineer_issues
         WHERE workspace_id = ${ws} AND issue_id = ${id} AND origin <> 'remote'
           ${onViewRow()}
         ORDER BY updated_at DESC NULLS LAST`;
    }
    if (state === 'needs-human') {
      // A needs-human issue is deliberately nonterminal, but it is still removed from
      // self-selection immediately. Clear the durable claim in the same view-triggered
      // transaction as the state transition; otherwise the status floor excludes the row
      // while fleet assignment still counts the stale taken_by claim against its holder.
      return await tx<IssueRowDb[]>`
        UPDATE harness_shared.engineer_issues
           SET state = ${state}, assignee = NULL, assigned_at = NULL, last_progress_at = NULL,
               origin = 'local', updated_at = now()
         WHERE workspace_id = ${ws} AND issue_id = ${id}
           ${onViewRow()}
           AND ${currentEffect}
        RETURNING ${tx.unsafe(ISSUE_COLS)}`;
    }
    return await tx<IssueRowDb[]>`
      UPDATE harness_shared.engineer_issues SET state = ${state}, origin = 'local', updated_at = now()
       WHERE workspace_id = ${ws} AND issue_id = ${id}
         ${onViewRow()}
         AND ${currentEffect}
      RETURNING ${tx.unsafe(ISSUE_COLS)}`;
  });
  if (isTerminal && terminalWriteSucceeded && priorAssignee) {
    clearGoalClaimedIfMatches(priorAssignee, id);
    // A terminal issue transition clears the local taken_by claim above. Await the
    // harness-agnostic lease cleanup before returning so work_items:complete cannot
    // report success while its scheduler:get_next/claim_next lease still poisons the
    // item for the next claimant. The lease helper is best-effort and self-catches;
    // the dynamic import preserves the issue/work-items module boundary.
    await trackDetached(
      import('./work-item-claim-lease-wiring')
        .then((m) => m.releaseIssueClaimLease({ workItemId: id, owner: priorAssignee }))
        .catch(() => false),
    );
  }
  if (!rows[0]) return null;
  const issue = toIssue(rows[0]);
  // work-item-status-full-unify: classify via the (transitionally-widened) terminal set so a
  // unified `done`/`dropped` write still delivers the 'resolved' event kind, not 'updated'.
  const resolved = ISSUE_TERMINAL_STATUSES.has(state);
  if (!terminalWriteWasAttested) {
    await deliver(
      issue,
      resolved ? 'resolved' : 'updated',
      `issue ${id} → ${state}: ${issue.title}`,
      by ?? 'substrate',
    );
  }
  return issue;
}

/**
 * P-004 (WI-5679, work-item-claimability-clarity-2026-07-20): route an issue-family item
 * that hit an OPERATIONAL failure — a worker crash / timeout / context-overflow / attempts-
 * exhaustion / host-restart thrash, NOT a genuine human-capability blocker — to the
 * LEADER-TRIAGE lane instead of the owner's inbox.
 *
 * Mechanism: set state='blocked' (excluded from ISSUE_FAMILY_CLAIMABLE_STATES=['open'], so it
 * leaves the auto-dispatch/claim/thrash loop by its stored status — the dispatcher
 * reads readItems({state:'open'}) and every claim path gates on status='open') + stamp
 * payload.blockedReason/blockedAt for the triaging leader — WITHOUT setting
 * payload.needsOwnerAction or enrolling agent review. A fleet leader triages it
 * (work_items:list{state:'blocked'})
 * and either re-opens it (setIssueState 'open') or, for a GENUINE human need, re-routes it with a
 * typed capability.
 *
 * The whole point: 7 of 8 `mergeIssuePayload(id,{needsHuman:true})` SETTERS were routing
 * operational failures to the human queue, over-flagging ~82 agent-fixable bugs out of the drain
 * (WI-5679 diagnosis). Strict credential / physical-device / external-service-action
 * capabilities now use payload.needsOwnerAction; product decisions use agent review.
 *
 * Returns the setIssueState result (EngineerIssue | null). NULL on a no-op UPDATE — a remote-owned
 * row (the engineer_issues INSTEAD OF trigger refuses local mutation) or a missing row — which a
 * caller relying on null-detection (orphaned-dispatch's recoveryNoOps, EI-15486) needs to stay
 * accurate. Does NOT release the claim: that is the caller's separate concern (resolve-core
 * releases explicitly; orphaned-dispatch has a dedicated releaseClaim dep).
 */
export async function markLeaderTriage(
  id: string,
  blockedReason: string,
  by = 'leader-triage',
): Promise<EngineerIssue | null> {
  const updated = await setIssueState(id, 'blocked', by);
  if (updated) {
    await mergeIssuePayload(id, { blockedReason, blockedAt: new Date().toISOString() });
  }
  return updated;
}

// ── There is deliberately NO hard-delete of issue rows in this module ─────────
// `deleteIssues(ids)` and its companion reader `listIssueAgesByTopic` lived here
// until 2026-08-09. They existed for exactly ONE caller — the observation-lane
// retention sweep in harness/improvements/hygiene.ts — which was retired by owner
// directive (plan learning-loop-identity-and-consumption-2026-08-08, D-001:
// "why would we ever want to throw out observations?"; D-005: observations are a
// time series, never bulk-closed or purged). With that caller gone the primitive
// had zero callers, so it was removed rather than left in place: an unused
// hard-delete over engineer_issues is a loaded gun aimed at precisely what D-001
// forbids, and the next agent to want a "storage bound" would have found it and
// used it. Removing it makes observation loss structurally impossible instead of
// merely absent (D-029).
//
// Issues END through the LIFECYCLE close — `setIssueState(id, 'closed', by)` —
// which is what the recurrence matcher recalls as "already decided" on a
// re-capture; a deleted row silently loses that memory. If a storage bound is
// ever genuinely required it must be archive/rollup over rows already marked
// CONSUMED (harness/improvements/observation-consumption.ts), never a DELETE.
// Re-introducing a hard delete here is an owner-level decision, not a local one.

/**
 * Shallow-merge keys into the issue's kind-specific `payload` jsonb (NULL payload
 * treated as `{}`). Silent — no fan-out (payload is loop bookkeeping, e.g. the
 * self-improvement `implementAttempts` / `needsHuman` / `paths` keys, not a
 * subscriber-visible mutation). Set a key to null to store an explicit null.
 */
/** `opts.unset` REMOVES top-level payload keys and is the only correct way to
 * clear one — merging `{ key: null }` leaves the key PRESENT as a JSON null, so
 * existence-shaped readers (`? 'key'`, and `-> 'key' IS NOT NULL`) still match.
 * See mergeWorkItemPayload's note. (EI-20578964155166663) */
export function planItemSourceFromPayloadPatch(
  patch: Record<string, unknown>,
): { planSlug: string; itemId: string } | null {
  const raw = patch.plan_item;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const stamp = raw as Record<string, unknown>;
  const planSlug = typeof stamp.plan_slug === 'string' ? stamp.plan_slug.trim() : '';
  const itemId = typeof stamp.item_id === 'string' ? stamp.item_id.trim() : '';
  return planSlug && itemId ? { planSlug, itemId } : null;
}

export async function mergeIssuePayload(
  id: string,
  patch: Record<string, unknown>,
  opts: { unset?: readonly string[]; harnessSlug?: string | null } = {},
): Promise<EngineerIssue | null> {
  const { sql } = getOrgPg();
  const ws = await resolveIssueWorkspace(id);
  const physicalSlug = await resolveIssuePhysicalSlug(sql, ws, id, opts.harnessSlug);
  if (physicalSlug === null) return null;
  // The claim-subject baseline is server-owned identity, not caller payload.
  // Coalescing and other bookkeeping legitimately merge arbitrary top-level
  // keys, but must never forge, replace, or remove the baseline that protects
  // a holder from stale completion evidence. Strip it before both the shallow
  // merge and the unset list; a claim write is the only producer of this key.
  const payloadPatch = { ...patch };
  delete payloadPatch[CLAIM_SUBJECT_BASELINE_KEY];
  const unset = [...new Set((opts.unset ?? []).filter((key) => key !== CLAIM_SUBJECT_BASELINE_KEY))];
  const clearingPlanItem = unset.includes('plan_item');
  const settingPlanItem = clearingPlanItem ? null : planItemSourceFromPayloadPatch(payloadPatch);
  // EI-21215793636294109: write the CANONICAL base table, never the engineer_issues
  // COMPATIBILITY VIEW — a key removal is not expressible through that view. Its
  // INSTEAD OF trigger re-merges the incoming payload into the stored one
  // (`payload = COALESCE(payload,'{}') || (NEW.payload - '_ei') || _ei`), which is
  // DELIBERATE: a partial-payload UPDATE must not wipe control state like `_claimHold` /
  // `held_open_by` (pinned by work-items-view.integration.test.ts, WI-5493). But that same
  // merge RESTORES any key this function removed, so `opts.unset` computed the right
  // payload and the trigger silently put the key back — while still reporting success.
  // Live symptom: `work_items:update { plan_item: null }` returned ok:true with no error
  // and left payload.plan_item in place, so a mis-stamped item could never be released
  // from the plan-item lane-sync hold. The same silent no-op hit the `needsHuman` legacy
  // -key clear, which routes through this identical unset path.
  // Writing the base table also stops a lossy round-trip: the trigger rebuilds `_ei` from
  // the view's scalar projection, whereas the stored `_ei` is preserved untouched here.
  const updatePayload = (db: OrgSql) => db<{ ok: number }[]>`
    UPDATE harness_shared.work_items
       SET payload = (COALESCE(payload, '{}'::jsonb) || ${JSON.stringify(payloadPatch)}::text::jsonb) - ${unset}::text[],
           -- A promoted issue has TWO row-level admission identities:
           -- payload.plan_item and the normalized source-plan columns. Keep them
           -- in the SAME write on both SET and CLEAR. Before EI-21551365156148780,
           -- work_items:update set the stamp but left these columns NULL, so exact-
           -- plan promotion coverage reported the implementing issue as missing.
           source_plan_slug = CASE
             WHEN ${clearingPlanItem} THEN NULL
             WHEN ${settingPlanItem !== null} THEN ${settingPlanItem?.planSlug ?? null}
             ELSE source_plan_slug
           END,
           source_plan_item_ids = CASE
             WHEN ${clearingPlanItem} THEN NULL
             WHEN ${settingPlanItem !== null} THEN ${settingPlanItem ? [settingPlanItem.itemId] : null}::text[]
             ELSE source_plan_item_ids
           END,
           origin = 'local',
           updated_ts = ${Date.now()}
     WHERE workspace_id = ${ws}
       AND harness_slug = ${physicalSlug}
       AND feature_id = ${id}
       AND item_kind = ANY (ARRAY['bug', 'change', 'task'])
    RETURNING 1 AS ok`;

  let rows: { ok: number }[];
  if (clearingPlanItem) {
    // The coverage edge is the third representation of the link. Snapshot its
    // exact outgoing refs under a row lock, clear the row, and retract only those
    // refs in one bounded transaction. This avoids both half-clears and deleting a
    // separate hand-authored plan relation that was never represented on the row.
    rows = await boundedOrgTxn(async (tx) => {
      const prior = await tx<
        {
          payload_plan_slug: string | null;
          payload_item_id: string | null;
          source_plan_slug: string | null;
          source_plan_item_ids: string[] | null;
        }[]
      >`
        SELECT payload->'plan_item'->>'plan_slug' AS payload_plan_slug,
               payload->'plan_item'->>'item_id' AS payload_item_id,
               source_plan_slug,
               source_plan_item_ids
          FROM harness_shared.work_items
         WHERE workspace_id = ${ws}
           AND harness_slug = ${physicalSlug}
           AND feature_id = ${id}
           AND item_kind = ANY (ARRAY['bug', 'change', 'task'])
         FOR UPDATE`;
      if (!prior[0]) return [];

      const updated = await updatePayload(tx);
      if (!updated[0]) return updated;

      const refs = new Set<string>();
      const before = prior[0];
      if (before.payload_plan_slug && before.payload_item_id) {
        refs.add(planItemRef(before.payload_plan_slug, before.payload_item_id));
      }
      if (before.source_plan_slug) {
        for (const itemId of before.source_plan_item_ids ?? []) {
          if (itemId) refs.add(planItemRef(before.source_plan_slug, itemId));
        }
      }
      if (refs.size > 0) {
        const coordWs = coordScopeWorkspace();
        await tx`
          DELETE FROM harness_shared.coord_links
           WHERE workspace_id = ${coordWs}
             AND src_kind = ${ISSUE_KIND}
             AND src_ref = ${id}
             AND dst_kind = 'plan_item'
             AND dst_ref = ANY (${[...refs]})
             -- Member-written stamps use relates; plan promotion writes
             -- implements. Both assert coverage and both must disappear when
             -- the caller explicitly clears plan_item.
             AND rel = ANY (ARRAY['relates', 'implements'])`;
      }
      return updated;
    });
  } else {
    rows = await updatePayload(sql as OrgSql);
  }
  if (!rows[0]) return null;
  return getIssueInWorkspace(ws, id, { baseHarnessSlug: physicalSlug });
}

/** Threadable.addPost — comment on the issue (creates the thread on first post). */
export async function commentIssue(
  id: string,
  body: string,
  authorId?: string,
  /** `writerOwnerId`: see commentWorkItem — the agent whose own text `body` is (P-012 / D-006). */
  opts: { workspaceId?: string; harness?: string | null; writerOwnerId?: string | null } = {},
): Promise<ThreadPostRow | null> {
  const issue = await getIssue(id);
  if (!issue) return null;
  const created = nowIso();
  // The durable write (get-or-create thread + add post) runs in ONE bounded txn
  // (pg-bounded-txn): ATOMIC so the post row + the coord_threads post_count bump
  // commit together (no half-write a retry would duplicate), and BOUNDED by a
  // SET LOCAL statement_timeout so a stalled query fails fast + typed instead of
  // hanging the MCP call indefinitely (the admin pool has no default
  // statement_timeout). A tx-bound PgThreadStore reuses the exact tested store SQL.
  const post = await boundedOrgTxn(async (tx) => {
    const txThreads = new PgThreadStore({
      ...coordOpts,
      getSql: () => tx,
      getWorkspaceId: () => opts.workspaceId?.trim() || coordScopeWorkspace(),
    });
    // P-012 / D-006: seal in THIS transaction (see commentWorkItem).
    const stored = opts.writerOwnerId?.trim()
      ? await sealSharedTextInTxOrRefuse(tx, {
          workspaceId: opts.workspaceId?.trim() || coordScopeWorkspace(),
          writerOwnerId: opts.writerOwnerId,
          store: 'work-item-comment',
          text: body,
          context: { workItemId: id },
        })
      : null;
    const thread = await txThreads.getOrCreateThread(issueRef(id), {
      thread_id: threadId(id),
      title: issue.title,
      created_by: issue.createdBy ?? undefined,
      created_ts: issue.createdAt,
      harness_slug: opts.harness ?? undefined,
    });
    return txThreads.addPost({ thread_id: thread.thread_id, author_id: authorId, body: stored?.text ?? body, created_ts: created });
  });
  // Fan-out is best-effort + deadline-bounded (fanoutForObject) — it runs AFTER the
  // durable write commits and can never hang or roll back the caller's comment.
  await deliver(
    issue,
    'commented',
    `issue ${id} — new comment${authorId ? ` from ${authorId}` : ''}`,
    authorId ?? 'substrate',
  );
  return post;
}

/** Taggable.addTag / removeTag. */
export async function tagIssue(id: string, topic: string, by?: string): Promise<void> {
  await tags.addTag(issueRef(id), topic, { created_by: by, created_ts: nowIso() });
}
export async function untagIssue(id: string, topic: string): Promise<void> {
  await tags.removeTag(issueRef(id), topic);
}

/** Subscribable.subscribe / unsubscribe to the issue object. */
export async function subscribeIssue(subscriberId: string, id: string, mode: DeliveryMode = 'full'): Promise<void> {
  await subs.subscribe({
    subscriber_id: subscriberId,
    target_kind: 'object',
    target_ref: `${ISSUE_KIND}:${id}`,
    delivery_mode: mode,
    created_ts: nowIso(),
  });
}
export async function unsubscribeIssue(subscriberId: string, id: string): Promise<void> {
  await subs.unsubscribe(subscriberId, 'object', `${ISSUE_KIND}:${id}`);
}

/** Linkable.link — an issue→target edge (rel 'blocks' | 'relates' | 'duplicates' | …). Phase 2. */
export async function linkIssue(
  id: string,
  dst: ObjectRef,
  rel: string,
  by?: string,
  satisfaction?: 'settled' | 'success',
): Promise<void> {
  const src = issueRef(id);
  if (rel === 'blocks' && (dst.kind === 'issue' || dst.kind === 'feature')) {
    await mirrorWorkItemBlockingEdge(src, dst, { createdBy: by, satisfaction });
  } else {
    // Non-work blocks (plan items/events) and every other relation remain on the
    // polymorphic coord_links substrate.
    await linkIssueRelationBounded(src, dst, rel, by);
  }
}
export async function unlinkIssue(id: string, dst: ObjectRef, rel: string): Promise<void> {
  const src = issueRef(id);
  if (rel === 'blocks' && (dst.kind === 'issue' || dst.kind === 'feature')) {
    await removeMirroredWorkItemBlockingEdge(src, dst);
  } else {
    await unlinkIssueRelationBounded(src, dst, rel);
  }
}

/** One outbound edge from an issue, as {@link issuesOutLinksMany} returns it. */
export interface IssueOutLink {
  rel: string;
  dst: ObjectRef;
}

/**
 * Bulk outbound-link read over many issues in ONE batched query (no N+1) —
 * WI-3594 (scorecard→improvement flow): ScorecardDetail needs each scorecard's
 * linked follow-up items, and a per-row `links.listOut` call would be an N+1
 * over a scorecard list. Excludes `tagged` (topic tags are not references,
 * same convention as {@link issueLinkCounts}'s inboundRefs). Every requested id
 * gets an entry (empty array when unlinked).
 */
export async function issuesOutLinksMany(ids: readonly string[]): Promise<Map<string, IssueOutLink[]>> {
  const out = new Map<string, IssueOutLink[]>();
  if (ids.length === 0) return out;
  for (const id of ids) out.set(id, []);
  const rows = await blockingLinks.listOutMany(ids.map(issueRef));
  for (const r of rows) {
    if (r.rel === 'tagged') continue;
    out.get(r.src.ref)?.push({ rel: r.rel, dst: r.dst });
  }
  return out;
}

/**
 * Which of these issues have been SUPERSEDED — i.e. are the DST of a `revises`
 * edge, meaning a later filing incorporated/corrected them
 * (goal-mode-rubric-v2-2026-08-10 P-010).
 *
 * ONE batched, rel-filtered in-edge query, deliberately NOT `issuesOutLinksMany`:
 * that resolves EVERY edge kind and LEFT JOINs engineer_issues + features, and it
 * was measured as the most-called statement on the box (WI-6124), which is exactly
 * why the trend opted out of it. A supersession check needs one bit per id, so it
 * reads one bit per id.
 *
 * Returns only the superseded subset — an id absent from the set is live.
 */
export async function issuesSupersededByRevision(ids: readonly string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (ids.length === 0) return out;
  const rows = await links.listInMany(ids.map(issueRef), { rel: 'revises' });
  for (const r of rows) out.add(r.dst.ref);
  return out;
}

/** Link-degree of one issue, as the blocking-impact ranking reads it
 *  (self-improvement-consume-edges-2026-06-12 P-022). */
export interface IssueLinkCounts {
  /** Outbound `blocks` edges — downstream things THIS issue blocks. */
  blocksOut: number;
  /** Inbound edges from other objects referencing this issue. Excludes `tagged`
   *  (topics are not references) and inbound `blocks` (an upstream dependency —
   *  something blocking THIS issue is not downstream impact). */
  inboundRefs: number;
}

/** Bulk link-degree read over many issues in two batched queries (no N+1).
 *  Every requested id gets an entry (zero counts when unlinked). */
export async function issueLinkCounts(ids: readonly string[]): Promise<Map<string, IssueLinkCounts>> {
  const out = new Map<string, IssueLinkCounts>();
  if (ids.length === 0) return out;
  for (const id of ids) out.set(id, { blocksOut: 0, inboundRefs: 0 });
  const refs = ids.map(issueRef);
  const [outRows, inRows] = await Promise.all([
    blockingLinks.listOutMany(refs, { rel: 'blocks' }),
    blockingLinks.listInMany(refs),
  ]);
  for (const r of outRows) {
    const c = out.get(r.src.ref);
    if (c) c.blocksOut += 1;
  }
  for (const r of inRows) {
    if (r.rel === 'tagged' || r.rel === 'blocks') continue;
    const c = out.get(r.dst.ref);
    if (c) c.inboundRefs += 1;
  }
  return out;
}

export interface PromoteResult {
  issue: EngineerIssue;
  feature: { id: string; title: string };
}

/**
 * issues:promote — mint an F-FIX feature from this issue (reusing the pipeline's
 * mintFixFeatureRow) and link it. Harness-scoped issues mint into their harness;
 * an operator-scope issue must name a target harness. The issue stays open (it
 * resolves when the feature lands); the linked feature is recorded + a note added.
 */
export async function promoteIssue(
  id: string,
  opts: { harness?: string; actor?: string } = {},
): Promise<PromoteResult | { error: string }> {
  const issue = await getIssue(id);
  if (!issue) return { error: 'issue not found' };
  if (issue.linkedFeatureId) return { error: `already promoted to ${issue.linkedFeatureId}` };

  const harness = opts.harness ?? (issue.scope.startsWith('harness:') ? issue.scope.slice('harness:'.length) : null);
  if (!harness) return { error: 'operator-scope issue needs a target harness — pass { harness }' };
  const project = await resolveProject(harness);
  if (!project) return { error: `unknown harness '${harness}'` };

  const pipelineIssue: PipelineIssue = {
    id: issue.id,
    title: issue.title,
    severity: issue.severity,
    source: 'system',
    foundAt: issue.createdAt,
    foundDuring: issue.foundDuring ?? undefined,
    status: 'open',
    evidence: issue.body || undefined,
    attempts: 0,
    notes: [],
  };
  const feature = await mintFixFeatureRow(project, pipelineIssue, { actor: opts.actor ?? 'issue-promote' });

  const updated = await updateIssue(id, { linkedFeatureId: feature.id, by: opts.actor });
  await commentIssue(id, `Promoted to ${feature.id} in harness ${harness}.`, opts.actor);
  const promotedIssue = updated && 'shrinkGuardTripped' in updated ? issue : (updated ?? issue);
  return { issue: promotedIssue, feature: { id: feature.id, title: feature.title } };
}

/**
 * Find the open delegated-task (kind=task) work-item carrying this delegate
 * session id in its payload (collapse-delegate D-001). Used by the historical delegate
 * resume path to re-attach a follow-up turn to its existing work-item.
 */
export async function findTaskBySessionId(agentSessionId: string): Promise<EngineerIssue | null> {
  const { sql } = getOrgPg();
  const rows = await sql<IssueRowDb[]>`
    SELECT ${sql.unsafe(ISSUE_COLS)} FROM harness_shared.engineer_issues
     WHERE workspace_id = ${issuesScopeWorkspace()}
       AND kind = 'task' AND state = 'open'
       AND payload ->> 'agentSessionId' = ${agentSessionId}
     ORDER BY created_at DESC
     LIMIT 1`;
  return rows[0] ? toIssue(rows[0]) : null;
}

/**
 * Full-text search over the issue store. Scoping note (watchdog-audit-2026-06-09
 * P-013): the DEFAULT_COORD_WORKSPACE filter here is BY DESIGN, not a bug — every
 * write path (createIssue) stores into that single coord workspace (see the
 * capability-stores comment above: engineer_issues' workspace_id is a domain
 * column; the coordination layer runs in the one coord workspace). Searching the
 * same constant the writes use keeps dedup consistent. If the store ever becomes
 * genuinely multi-workspace, the WRITE path must change first and this follows.
 */
export async function searchIssues(query: string, limit = 50): Promise<EngineerIssue[]> {
  const { sql } = getOrgPg();
  const rows = await sql<IssueRowDb[]>`
    SELECT ${sql.unsafe(ISSUE_COLS)} FROM harness_shared.engineer_issues
     WHERE workspace_id = ${issuesScopeWorkspace()}
       AND _search @@ websearch_to_tsquery('english', ${query})
     ORDER BY ts_rank(_search, websearch_to_tsquery('english', ${query})) DESC
     LIMIT ${Math.min(limit, 200)}`;
  return rows.map(toIssue);
}

/**
 * EI-18713447977097831: `websearch_to_tsquery` combines bare (unquoted) terms
 * with the implicit AND operator — verified live: `websearch_to_tsquery('english',
 * '<full title A>')` against `to_tsvector('<full title B>')` returned FALSE for
 * two real captures sharing a 47-char verbatim substring + 3 distinctive tokens,
 * while the same tokens OR-joined returned TRUE. capture-core.ts's search-first
 * dedup pass calls `searchIssuesForDedup(input.title, …)` with a full, often
 * multi-clause, natural-language TITLE (not a short query) — ANDing every one
 * of its tokens requires a candidate to contain literally every word of the new
 * capture, which only a near-verbatim duplicate title satisfies. The whole point
 * of this search is to produce a *candidate pool* that titleSimilarity's Jaccard
 * score then filters precisely (capture-core.ts) — so OR the significant tokens
 * instead of ANDing them. Reuses `dedupSignature`'s tokenizer (digest.ts) so
 * "found by this search" and "scored similar by titleSimilarity" agree on what
 * counts as a token.
 */
function dedupSearchQuery(title: string): string {
  const tokens = dedupSignature(title).split(' ').filter(Boolean);
  // Cap token count: an unbounded OR clause from a pathologically long title
  // (e.g. a body accidentally passed as title) would be a needlessly expensive
  // tsquery. Falls back to the raw title when tokenization yields nothing (all
  // tokens ≤2 chars, or an empty title) rather than passing an empty query.
  return tokens.slice(0, 32).join(' or ') || title;
}

/**
 * WI-4308 interim mitigation: the SAME lexical search as `searchIssues`, widened
 * to ALSO match rows still sitting under the legacy DEFAULT_COORD_WORKSPACE
 * (see `dedupScopeWorkspaces`'s doc). For DEDUP READS ONLY — wired into
 * capture-core.ts's search-first pass so a fresh capture can find (and decline
 * to re-duplicate) a still-open pre-flip twin. Deliberately a SEPARATE function
 * rather than widening `searchIssues` in place: `searchIssues` also backs the
 * general, caller-visible `work_items:search` tool (via work-items.ts), which
 * takes short natural-language queries where implicit-AND is the expected
 * search-engine behavior and must NOT start surfacing the pre-flip backlog to
 * ordinary listing/search — only the dedup path's OR-token widening (above)
 * belongs here.
 */
export async function searchIssuesForDedup(query: string, limit = 50): Promise<EngineerIssue[]> {
  const tsQuerySource = dedupSearchQuery(query);
  const rows = await boundedPgReadTxn<IssueRowDb[]>(
    (tx) => tx<IssueRowDb[]>`
      SELECT ${tx.unsafe(ISSUE_COLS)} FROM harness_shared.engineer_issues
       WHERE workspace_id = ANY(${dedupScopeWorkspaces()}::text[])
         AND _search @@ websearch_to_tsquery('english', ${tsQuerySource})
       ORDER BY ts_rank(_search, websearch_to_tsquery('english', ${tsQuerySource})) DESC
       LIMIT ${Math.min(limit, 200)}`,
  );
  return rows.map(toIssue);
}

/**
 * Batch-hydrate issues by id, in the ORDER the ids were given.
 *
 * The hydration half of what used to be `semanticSearchIssues`. That function
 * ranked by cosine and hydrated in one step because it was its own private
 * search leg; since P-016 the ranking is `@papercusp/search`'s job (see
 * `work-items.ts`'s issue `SearchSource`, which ranks BOTH legs directly on
 * the base table) and all that remains here is turning a ranked id list back
 * into issue rows.
 *
 * Reading through the `engineer_issues` view is deliberate: it is the one
 * place the base table's `payload->'_ei'` fold is unpacked into the issue
 * shape, so hydrating anywhere else would re-implement that mapping.
 */
export async function issuesByIds(ids: string[], opts: WorkItemReadOptions = {}): Promise<EngineerIssue[]> {
  if (ids.length === 0) return [];
  const { sql } = getOrgPg();
  const columns = projectWorkItemColumns(
    opts.includeBody === false ? ISSUE_COLS_BODYLESS : ISSUE_COLS,
    opts.payloadProjection,
  );
  const rows = await sql<IssueRowDb[]>`
    SELECT ${sql.unsafe(columns)} FROM harness_shared.engineer_issues
     WHERE workspace_id = ${issuesScopeWorkspace()}
       AND issue_id = ANY(${ids}::text[])`;
  const rank = new Map(ids.map((id, i) => [id, i]));
  return rows.map(toIssue).sort((a, b) => (rank.get(a.id) ?? ids.length) - (rank.get(b.id) ?? ids.length));
}

/**
 * Watchdog-key dedup feed (watchdog-audit-2026-06-09 P-004 / D-001): every issue
 * carrying one of the given `payload.watchdogKey` values — ONE indexed query
 * (engineer_issues_watchdog_key_idx, migration 207). The improvement watchdog
 * pre-filters its collected signals against this BEFORE planning captures, so a
 * standing already-filed signal never consumes the per-tick capture budget.
 *
 * WI-4308 interim mitigation: scoped via `dedupScopeWorkspaces()` (not a bare
 * `issuesScopeWorkspace()`) so a still-open watchdogKey match filed under the
 * legacy DEFAULT_COORD_WORKSPACE is found too — every caller of this function
 * (the improvement watchdog, scorecard-emission-pulse, overwatch's
 * scorecard-backstop, known-open-aging's coalescing sweep, p2p-perf-actions,
 * the calibration resolve-sweep) is itself a dedup/aging/coalescing consumer,
 * never a general caller-visible listing — so widening here is safe by the
 * same reasoning as `searchIssuesForDedup` above.
 */
export async function findIssuesByWatchdogKeys(keys: string[]): Promise<EngineerIssue[]> {
  if (keys.length === 0) return [];
  const { sql } = getOrgPg();
  const rows = await sql<IssueRowDb[]>`
    SELECT ${sql.unsafe(ISSUE_COLS)} FROM harness_shared.engineer_issues
     WHERE workspace_id = ANY(${dedupScopeWorkspaces()}::text[])
       AND payload ? 'watchdogKey'
       AND payload->>'watchdogKey' = ANY(${keys}::text[])
     ORDER BY updated_at DESC`;
  return rows.map(toIssue);
}

/**
 * Tool-failure class lifecycle feed. Unlike `findIssuesByWatchdogKeys`, this
 * deliberately ignores the report-shaped watchdog key and finds every row whose
 * nested probation payload carries the same stable class identity. The capture
 * path uses this to coalesce differently-worded reports into one class item.
 */
export async function findIssuesByToolFailureClassKeys(keys: string[]): Promise<EngineerIssue[]> {
  if (keys.length === 0) return [];
  const { sql } = getOrgPg();
  const rows = await sql<IssueRowDb[]>`
    SELECT ${sql.unsafe(ISSUE_COLS)} FROM harness_shared.engineer_issues
     WHERE workspace_id = ANY(${dedupScopeWorkspaces()}::text[])
       AND payload->'toolFailureProbation'->>'classKey' = ANY(${keys}::text[])
     ORDER BY updated_at DESC`;
  return rows.map(toIssue);
}
