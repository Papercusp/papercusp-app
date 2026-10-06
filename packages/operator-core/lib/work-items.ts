/**
 * work-items — the UNIFIED work-item surface (plan unify-work-items-2026-06-04).
 *
 * One `work_item` TYPE discriminated by `kind` (D-001). This module is the canonical
 * code-level interface (D-007: "the type is the API, the table is an implementation
 * detail"); it is a facade over the two per-kind tables the codebase already has
 * (D-010=(b) — per-kind tables behind a unifying surface):
 *
 *   feature-family kinds {feature, research-task, chunk} → harness_features_consolidated
 *   issue-family    kinds {bug, change}                   → engineer_issues
 *
 * Reads MERGE across both tables; writes DISPATCH by kind. New ids are the
 * kind-independent WI-NNN scheme (D-008, allocated from harness_shared.work_item_seq
 * via next_work_item_id()); existing F-NNN / EI-NNN rows keep their ids (the bulk
 * in-place re-id is a supervised, pipeline-drained follow-on — see the plan Risks).
 *
 * Capabilities (D-003) ride the same coord substrate stores issues use — but keyed
 * on the per-family ObjectRef so the unified surface operates on the SAME coord rows
 * as features:* / issues:* (a true facade, not a parallel store):
 *   - issue-family  → ObjectRef {kind:'issue',   ref: id}                  (issues-engineer.ts)
 *   - feature-family→ ObjectRef {kind:'feature',  ref:'<harness>#<id>'}     (issue-blocks-merge.featureRef)
 * Cross-kind blocking (a bug blocks a feature) is a canonical work_item_deps row between
 * the two ObjectRefs (D-003). The public Linkable view merges it with polymorphic coord_links
 * relations so callers do not depend on the physical split.
 *
 * Fan-out: issue-family writes fan out synchronously via issues-engineer.deliver();
 * feature-family writes fan out + federate via the hfc capture_substrate_outbox CDC
 * trigger (already wired) — so neither path needs an extra fan-out call here.
 */
import { getOrgPg } from '@papercusp/db-org';
import type { GoalSqlTag } from '@papercusp/agent-mcp/goals';
import { healOrphanedRemoteOriginIfAuthorEnded } from './work-items-orphan-author';
import { selfHealTerminalOwnerOriginIfStranded } from './work-items-terminal-owner-origin-heal';
import type { Fragment, TransactionSql } from 'postgres';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { systemDistinctId } from './flag-distinct-id';
import { harnessScope, harnessOfScope } from './work-item-scope';
import { resolveWorkItemPot } from './pot-membership';
import {
  PgTaggableStore,
  PgThreadStore,
  PgEntitySubscriptionStore,
  PgLinkStore,
  LIFECYCLE_STATES,
  type ObjectRef,
  type DeliveryMode,
  type ThreadPostRow,
} from '@papercusp/coordination/capabilities';
import { DEFAULT_COORD_WORKSPACE, withPgContentionRetry } from '@papercusp/coordination/event-log';
// Embedding-coverage awareness (WI-9393). The SURFACE-level door, deliberately not
// `assessSourceCoverage`: this consumer is not a registered `SearchSource`, and
// SEARCH_SOURCE_SURFACES is asserted exhaustive in both directions against
// SEARCH_SOURCES (coverage-gate.test.ts), so adding a key there would fail the suite.
import { assessSurfaceCoverage, type CoverageSnapshot, type SourceCoverageAssessment } from './search/coverage-gate';
import { activeWorkspaceId } from './workspace-registry';
import { canonicalizeAssigneeOwnerId } from './work-item-holder-identity';
import { checkAndEscalateSteeringChurn } from './steering-churn';
import { checkSteeringLease, recordSteeringProposal } from './steering-lease';
import { featureRef, FEATURE_KIND, isQualifiedFeatureRef, implementsLinkScopes } from './issue-blocks-merge';
import { type InjectEvent } from './agent-tools/coordination/fanout-delivery';
import { fanoutForObject } from './sync/hyperbee/fanout-projection';
import { normalizeTakenBy } from './sync/hyperbee/projections/harness-features';
import { boundedOrgTxn } from './pg-bounded-txn';
import type { ActiveOperationWorkerClaimRead } from './blueprint/operation-worker-binding';
import { sealSharedTextInTxOrRefuse } from './personal-vault/shared-store-seal';
import {
  admittedWhereSql,
  admittedWhereSqlWi,
  admissionFailOpenSec,
  admissionFailOpenGuaranteedSec,
  admissionPendingCreateRemedy,
  admissionPendingExplanation,
  admissionPromoterTickSec,
  admissionPromoterStall,
  admissionStallBasis,
  autoPickableWhereSql,
  type BornAdmission,
  isWorkItemDuplicateAdmitted,
  isAutoPickable,
  isIssueLocallyClaimable,
  isIssueLocallyClaimableWhereSql,
  isOwnNodeAuthoredRemoteRow,
  liveGateOpsSelfSelectExclusionSql,
  liveGateOpsSelfSelectExplanation,
  loadTrustedGithubUserIds,
  selfHealOwnNodeOriginIfStranded,
  STOP_THE_LINE_RED_HOURS,
  stopTheLineExclusionSql,
} from './work-items-admission';
import { resolveIssuePhysicalSlug } from './work-items-physical-row';
import { frontierPlacementKindClause } from './datatype-frontier-placement';
import { hasGenericKind, type DatatypeNature } from './datatype-registry-store';
import {
  ANY_FAMILY_TERMINAL_STATES,
  FEATURE_NON_REQUEUE_STATES,
  FEATURE_TERMINAL_STATES,
  normalizeFeatureStateInput,
} from './work-item-dispatch-states';
import { createBlockingEdgeReader, ISSUE_TERMINAL_STATUSES } from './work-item-blocking';
import { mirrorWorkItemBlockingEdge, removeMirroredWorkItemBlockingEdge } from './dbos/work-item-deps-store';
import {
  COMPLETION_ATTESTATIONS_KEY,
  TERMINAL_ASSUMPTIONS_KEY,
  TERMINAL_COMPLETION_EVIDENCE_KEY,
  readStoredAssumptions,
  terminalPayloadMergeJson,
} from './coord-lifecycle/records';
import type { StoredAssumptionDeclaration } from './coord-lifecycle/records';
import type { TopicTagMirrorOutcome, TopicTagMirrorResult } from './work-item-topic-tags';
import {
  auditWhereSql,
  completionAuthorityPredicateSql,
  derivedTerminalCompletionAuthority,
  type WorkItemAudit,
} from './completion-audit';
import type { CompletionAttestation, PersistedCompletionEvidence } from './coord-lifecycle/records';
import { isWorkItemCompletionAuthority, type WorkItemCompletionAuthority } from './work-item-completion-authority';
// EI-19362441037986499: the DECISION lives in a leaf module so it is exercisable without PG
// or a wholesale module mock; this file keeps only the write that acts on it. Deliberately
// NOT re-exported — the leaf is the import site for anyone who needs the decision itself.
import { classifySettledCompletionEvidence } from './work-item-settled-completion-evidence';
import { liveDriveTerminalRefusal } from './turn-provenance/owner-visible-surface-acceptance';
import { readExternalBlockers, updateExternalBlockerHistory, type ExternalBlockerRecord } from './external-blockers';
import { pgTimestampToIso, pgTimestampToIsoOrNull } from './pg-timestamp';
import { clearGoalClaimedIfMatches, noteGoalClaimed, readAgentStateStamp } from './agent-state-stamp';
import { isTransportOnlyIdentity } from './agent-tools/coordination/identity';
import { AUTO_CLOSE_DEFAULT_MIN_TICKS, AUTO_CLOSE_ELIGIBLE_SOURCES } from './harness/improvements/auto-close-sources';
import {
  agentReviewPendingAdmissionSql,
  agentReviewNormalExclusionSql,
  matchesAgentReviewClaimAdmission,
  readAgentReviewState,
  verificationTaskConflict,
  verificationTaskConflictSql,
  type AgentReviewClaimAdmission,
} from './harness/improvements/agent-review-policy';
import { hasActiveStrictHumanAsk } from './hold-registry';
import { hasResourceGovernorReceiptPayload, ResourceGovernorReleaseRequiredError } from './resource-governor/queue';
import { projectWorkItemColumns, type WorkItemReadOptions } from './work-item-read-projection';
import type { LegacyFleetScopeDowngradeAdmission } from './work-item-fleet-scope-recovery';

/**
 * Release cleanup is only needed on the explicit release paths. Keep the
 * cross-Swarm claim-lease wiring out of this facade's eager import graph (it
 * pulls the boot/orchestrator tree) and load it at the call site instead.
 * Cleanup is best-effort by contract, so a failed lazy load must remain a
 * no-op just like the implementation's own failure handling.
 */
async function releaseWorkItemLease(opts: {
  harness: string;
  workItemId: string;
  owner: string | null | undefined;
}): Promise<void> {
  try {
    const { releaseWorkItemLease: release } = await import('./work-item-claim-lease-wiring');
    await release(opts);
  } catch {
    // A stale lease is temporary; never let cleanup block the release itself.
  }
}
export { activeExternalBlockers, readExternalBlockers, updateExternalBlockerHistory } from './external-blockers';
export type {
  ExternalBlockerCapability,
  ExternalBlockerCapabilityPolicy,
  ExternalBlockerKind,
  ExternalBlockerRecord,
} from './external-blockers';
import {
  ISSUE_KIND,
  type IssueKind,
  type IssueStoreKind,
  type IssueState,
  type IssueSeverity,
  createIssue,
  getIssue,
  getIssueInWorkspace,
  getIssueDetail,
  getIssueThreadWindow,
  listIssues,
  listAllIssuesForFileExport,
  countIssues,
  countIssuesByState,
  setIssueState,
  claimIssue,
  releaseIssue,
  linkIssue,
  unlinkIssue,
  tagIssue,
  untagIssue,
  commentIssue,
  updateIssue,
  issuesByIds,
  promoteIssue,
  issuesScopeWorkspace,
  resolveIssuesScopeWorkspace,
  resolveIssueWorkspace,
  deriveLeaderDispatchAdmission,
  isLeaderDispatchAdmission,
  deriveSelfFiledFalloutAdmission,
  isSelfFiledFalloutAdmission,
  isForceTakeoverAdmission,
  type ForceTakeoverAdmission,
  mergeIssuePayload,
  planItemSourceFromPayloadPatch,
  markIssueProgress,
  recordWorkItemReleaseCooldown,
  type EngineerIssue,
  type ListIssuesFilter,
} from './issues-engineer';
// The prose column width contract — ONE source, not a restated `384` (D-005 §5).
import {
  fitsProseColumns,
  proseProfilePredicateSql,
  resolveProseProfileSelection,
  type ProseProfileSelection,
} from './search/prose-vector-dims';
import {
  chunkAwareVectorLegSql,
  runHybridSearch,
  withIterativeScan,
  type ChunkLegScan,
  type ChunkSurface,
  type PgHandle,
  type SearchSource,
  type SearchSourceParams,
  type Listing,
  type SearchLegs,
  type AppliedDefaults,
} from '@papercusp/search';
import { WORK_ITEMS_CHUNK_SURFACE } from './search/chunks/registry';
// Installs papercusp's engine-level ranking policy (P-017) on import — the
// same side-effect import every other engine caller uses. Without it this
// surface would call the engine and inherit NO floor, which is the exact
// hand-propagation failure P-016 removes.
import './search/configure-search-defaults';
import {
  createQueryEmbedderWarmup,
  type QueryEmbedderResolver as SharedQueryEmbedderResolver,
  type ResolvedQueryEmbedder as SharedResolvedQueryEmbedder,
} from './search/query-embedder-warmup';

/** Per-query embed budget for a work-item search (see `searchWorkItems`). */
const WORK_ITEM_EMBED_TIMEOUT_MS = 4000;

export { markIssueProgress };

// ── Kinds ───────────────────────────────────────────────────────────────────────
/** Storage/read union. `chunk` is retained only for historical compatibility. */
export type FeatureFamilyKind = 'feature' | 'chunk';
export type WorkItemKind = FeatureFamilyKind | IssueStoreKind;
export type WorkItemFamily = 'feature' | 'issue';
/** Design lifecycle values stored on feature-family work-item rows. */
export type WorkItemDesignStatus = 'pending' | 'accepted' | 'ignored';

export function isWorkItemDesignStatus(value: unknown): value is WorkItemDesignStatus {
  return value === 'pending' || value === 'accepted' || value === 'ignored';
}

export const FEATURE_FAMILY_KINDS: readonly FeatureFamilyKind[] = ['feature', 'chunk'];
/** Forward-active feature kind; `chunk` remains in the read union for history. */
export const ACTIVE_FEATURE_FAMILY_KINDS: readonly ['feature'] = ['feature'];
export type ActiveFeatureFamilyKind = (typeof ACTIVE_FEATURE_FAMILY_KINDS)[number];
/** Public work-item kinds whose forward write path is retired. */
export const DEPRECATED_WORK_ITEM_KINDS: readonly ['chunk'] = ['chunk'];

export function isDeprecatedWorkItemKind(kind: string): kind is 'chunk' {
  return (DEPRECATED_WORK_ITEM_KINDS as readonly string[]).includes(kind);
}
// research-task was MERGED INTO `task` 2026-07-05 (WI-2874): research is non-code
// work, which is what `task` now means. It is no longer a feature-family kind; the
// sentinel deep-delegate + Queen route-to-research now spawn `task` (issue-family),
// scoped by the `payload.deep_delegation` tag. Historical terminal research-task
// rows are left in place (harmless); active ones were migrated to task.
// `task` (collapse-delegate D-001) is an issue-family work_item kind — the operator's
// delegated-work record. It lives in engineer_issues alongside bug|change but is
// excluded from the issues:* surface (listIssues default).
// P-009 / D-022: the single routing list lives in work-nature/agent-work-predicate.ts.
export const ISSUE_FAMILY_KINDS: readonly IssueStoreKind[] = ISSUE_FAMILY_ROUTE_KINDS;

/**
 * Hard ceiling for a single work-items LIST read (both families). Local desktop
 * app + a virtualized grid (RichGrid `virtualMode`) means render cost no longer
 * scales with row count, so this is generous — it exists only to bound the
 * per-invalidation re-assembly + serialization of the LIVE sync query, not the
 * UI. A read that hits this ceiling is reported honestly via `countWorkItems`
 * ("N of TOTAL"), never silently truncated-as-total.
 */
export const WORK_ITEMS_MAX_LIMIT = 2000;
export const WORK_ITEM_KINDS: readonly WorkItemKind[] = [...FEATURE_FAMILY_KINDS, ...ISSUE_FAMILY_KINDS];

export function familyOf(kind: string): WorkItemFamily {
  return kind === 'bug' || kind === 'change' || kind === 'task' ? 'issue' : 'feature';
}
export function isWorkItemKind(k: string): k is WorkItemKind {
  return (WORK_ITEM_KINDS as readonly string[]).includes(k);
}

// ── Unified shape ─────────────────────────────────────────────────────────────────
export interface WorkItem {
  id: string;
  kind: WorkItemKind;
  family: WorkItemFamily;
  harness: string | null;
  title: string;
  summary: string;
  /** Design-phase lifecycle carried by feature-family rows. */
  needsDesign?: boolean;
  designStatus?: WorkItemDesignStatus | null;
  /** Canonical `harness_design_artifacts.id` pointer for an accepted spec. */
  designSpecId?: string | null;
  discardedDesignWork?: boolean;
  /** Kind-specific lifecycle state (feature: status; issue: open|resolved|closed). */
  state: string;
  /** Claimable (D-003): feature → taken_by; issue → assignee. */
  assignee: string | null;
  /** Lifecycle-scoped, machinery-armed wake registrations created with this claim. */
  interestWatch?: import('./interest-auto-arm').InterestAutoArmHandle;
  /** When the item was claimed (feature → taken_at; issue → assigned_at; ISO). null when unclaimed.
   *  The grace anchor for {@link ./item-activity}.classifyItemActivity. */
  takenAt: string | null;
  /**
   * Last REAL item-scoped progress — a state transition (setWorkItemState) or a
   * checkpoint write — as an ISO string; null = no progress recorded yet.
   * Issue-family rows currently have no dedicated progress column; their checkpoint
   * progress refreshes assigned_at, surfaced as takenAt, until that schema grows one.
   * (agent-activity-liveness-truth-2026-06-21 P-001). DISTINCT from the holder's
   * presence heartbeat and the lease keepalive: a claim/heartbeat proves a
   * RESERVATION / a live PROCESS, not that the WORK is advancing. Feed it to
   * classifyItemActivity to tell progressing from stalled.
   */
  lastProgressAt: string | null;
  /** Durable delegator (collapse-delegate D-002): who created+assigned it.
   *  Issue-family only today (feature-family has no assigned_by column). */
  assignedBy: string | null;
  /**
   * WI-6822-follow-up (EI-19313515375179600): the ORIGINAL AUTHOR's ownerId — issue-family
   * only today (engineer_issues.created_by; feature-family has no equivalent column, so this
   * is always null there). Identity-based, NOT origin-derived: this is the caller-comparable
   * field the `origin==='remote'` mutation guards should check FIRST (createdBy === the calling
   * ownerId ⇒ the caller genuinely IS the authoring peer, regardless of what `origin` currently
   * reads) — `origin` can flip local→remote well after creation (an unresolved federation/
   * replay-provenance defect, still under investigation) and stranded the true author when the
   * guards trusted `origin` alone.
   */
  createdBy: string | null;
  /** Issue-family only. */
  severity: string | null;
  /**
   * WI-37711: the goal this item was filed under — `work_items.goal_id` (migration 785 /
   * P-002), stamped by `stampGoalProvenance` when a goal-mode agent creates work. Null on
   * the (currently vast) majority of rows, which have no goal.
   *
   * Present on BOTH families: goal_id is a column on the shared base table, so unlike
   * `severity` this is not an issue-family-only notion. It is the field a per-goal STANDING
   * DRAIN FLEET scopes its claim spec by (`{ field:'goal', op:'=', value:<goalId> }`), which
   * is why it must be mapped here rather than read ad hoc — the claim-spec JS evaluator
   * (`claim-spec-match.ts`) reads it from this mapped shape, and the SQL compiler
   * (`get-next.ts`) reads the same column, so the two admission paths cannot diverge.
   */
  goalId: string | null;
  /**
   * WI-38326 — the five CLAIM-SPEC filter fields the SQL compiler reads as COLUMNS
   * (get-next.ts FIELD_MAP: `tags`, `plan`, `plan_item`, `redundancy`, `est_cost`).
   *
   * OPTIONAL on purpose, and the reason is not style. Making any of these required would
   * strand every hand-built `WorkItem` literal in the suite — the exact break
   * EI-20088447516583546 recorded when `goalId` went in as required ahead of its projection
   * (a COMMITTED tsc red). Optional also gives the resolution below its correct semantics:
   * `undefined` means "this family's projection does not carry the column", which must fall
   * back to the payload leg, whereas `null` means "the column is present and NULL".
   *
   * Both family projections carry these fields after migration 815. Optional remains important
   * for older callers and hand-built test literals, and preserves the undefined-vs-null source
   * distinction while a rolling deployment is crossing the view migration.
   */
  tags?: string[] | null;
  sourcePlanSlug?: string | null;
  sourcePlanItemIds?: string[] | null;
  redundancy?: number | null;
  expectedCostCents?: number | null;
  /** Parent work-item id (a chunk's parent, D-004). */
  parent: string | null;
  payload: unknown | null;
  /** First-class non-work-item dependencies. Internal work dependencies remain
   * coord `blocks` edges / plan `blocked-by` history; these records cover event,
   * gate, runtime, and human conditions without flattening them into prose. */
  externalBlockers?: ExternalBlockerRecord[];
  /**
   * Provenance (shared-hive-trust-admission P-005). `origin`: 'local' = authored on this
   * install, 'remote' = federated from a peer. `auditVerdict`: the G2 auditor's verdict on
   * a remote item ('admit'|'reject'|'pending'|null). The pair drives isAutoPickable — surfaced
   * so the Queen/UI can see "remote · pending-audit" and the placement gather can exclude
   * un-admitted remote work. Issue-family: origin reported 'local' (bug/change run inline, not
   * the autonomous remote-dispatch surface), auditVerdict null.
   */
  origin: string | null;
  auditVerdict: string | null;
  /**
   * P-008 (shared-hive-trust-admission): the github_user_id resolved from this
   * remote item's author_pubkey via a VERIFIED, non-revoked hive_members device
   * attestation — null for local/unverified/revoked rows (never a self-claimed
   * id). Surfaced so the placement-gather JS leg can apply the trust fast-path
   * (isAutoPickable) against the owner's local trust list.
   */
  verifiedAuthorGithubUserId: number | null;
  /**
   * Position within this item's ASSIGNEE's ordered work-list (local-hive P-020/D-004).
   * Lower = nearer head-of-line; null = unranked. Only meaningful relative to the other
   * items the SAME assignee holds — two bees' lists are independent. The Queen places
   * ranked work; the bee owns its sequencing (propose/dispose, D-008).
   */
  rank: number | null;
  /** Who last set `rank` — the propose/dispose audit (D-008). 'cup' (the default,
   *  cup-authored) | 'mug' (Mug overlay). null when unranked. */
  rankWriter: RankWriter | null;
  /** When `rank` was last written (tiebreak + audit). */
  rankUpdatedAt: string | null;
  /**
   * The SHARED backlog priority (`feature_order`) the decentralized claim path
   * (claimNextWorkItem) orders by — LOWER = claimed sooner; null = unprioritized
   * (sorts last). The Queen's steer-don't-dispatch lever (`work_items:set_priority`,
   * B7). Distinct from `rank`, which is a single bee's per-assignee work-list order.
   * Feature-family only; issue-family items are not the dispatched backlog → always null.
   */
  priority: number | null;
  /** Completion-integrity gate (work-item-completion-integrity-2026-07-01 WI-1403):
   *  the claiming principal who drove this item to its CURRENT terminal state
   *  (feature: passed|deprecated; issue: resolved|closed), or null if it has never
   *  reached one. Set only alongside a terminal setWorkItemState transition. */
  terminalOwner: string | null;
  /** Paired with terminalOwner: the completion evidence (summary / commit / coord
   *  or plan-item ref) recorded for the CURRENT terminal state. A terminal
   *  transition without both is rejected by setWorkItemState / setIssueState. */
  terminalCompletionRef: string | null;
  /** Queryable persisted completion record: verification evidence plus non-authority narrative fields. */
  terminalCompletionEvidence: PersistedCompletionEvidence | null;
  /**
   * agent-protocol-authority-semantics-2026-07-26 P-004 — how TRUSTWORTHY this row's
   * CURRENT terminal claim is, orthogonal to the lifecycle `state`. Written by the
   * completion gate from the evidence supplied at close time
   * (see `work-item-completion-authority.ts`).
   *
   * The DB column is bare `authority`; this API surface disambiguates as
   * `completionAuthority` deliberately (D-009) — plan items carry an unrelated
   * `authority: 'system' | 'owner'` axis meaning WHO MAY ACT, and the column cannot be
   * renamed to match (a consolidated-view column is rename-proof: 2,485 dependent views).
   *
   * `null` is NOT a sixth value — it is the ABSENCE of a judgement, read against `state`:
   * non-terminal + null = the item is open and owes no claim yet; terminal + null = a
   * LEGACY close made before this contract, which counts toward burn-down and is never
   * nagged or reclassified (D-005/D-008).
   */
  completionAuthority: WorkItemCompletionAuthority | null;
  createdAt: string;
  updatedAt: string;
  /** EI-18820653360383242 — when this item entered its CURRENT terminal state, maintained
   *  by the base-table trigger (migration 698), never by a caller. `null` on a terminal row
   *  means "closed, time unknown": the pre-698 legacy shape, which is most historical rows.
   *  Read it INSTEAD of updatedAt for anything time-of-close — updatedAt moves on any write
   *  and a single bulk write makes it report thousands of ancient rows as just-closed. */
  closedAt: string | null;
}

/** The propose/dispose author of a work-item's rank (local-hive D-008).
 *  pot-rename CONTRACT (SLICE-2 wave 2a): `cup`/`mug` are the canonical ids —
 *  the old `bee`/`queen` twins are removed here; the S2 role-contract migration
 *  backfills stored rows and tightens the `rank_writer` CHECK to match. Until
 *  that migration applies, a pre-backfill 'queen' row simply fails isRankWriter
 *  on read (display-only, self-heals at backfill). */
export type RankWriter = 'cup' | 'mug';
export const RANK_WRITERS: readonly RankWriter[] = ['cup', 'mug'];
export function isRankWriter(v: unknown): v is RankWriter {
  return v === 'cup' || v === 'mug';
}

// ── Capability stores (shared coord workspace, mirrors issues-engineer) ────────────
// Resolve the workspace at call time: feature rows and their coord threads are
// both written/read in the request's active workspace. Keep the construction-time
// default as the no-request fallback used by standalone callers and fixtures.
const coordOpts = {
  getSql: () => getOrgPg().sql,
  ensureSchema: async () => {},
  workspaceId: DEFAULT_COORD_WORKSPACE,
  getWorkspaceId: () => activeWorkspaceId(),
};

/**
 * EI-19398986978436931: `tags`/`threads` below are feature-family stores and must not
 * receive issue-family ObjectRefs. They resolve the active workspace dynamically,
 * matching feature work-item reads and comment writes; the construction-time
 * DEFAULT_COORD_WORKSPACE fallback is retained for standalone callers. Routing an
 * issue-family ObjectRef through these stores would still be a silent wrong-family
 * read/write, because an absent thread/tag-set legitimately means "nothing yet".
 * See the doc comment on {@link getWorkItemThreadWindow} for the dispatch contract.
 *
 * Every CURRENT call site in this file already dispatches issue-family work to
 * issues-engineer.ts BEFORE ever reaching `tags`/`threads` (confirmed by re-reading
 * every call site as of this fix) — so there is no live bug today. This guard exists
 * for the NEXT author who adds a `tags.`/`threads.` call site and forgets the family
 * dispatch: instead of silently matching zero rows, it throws loudly, at the call,
 * naming the mistake.
 *
 * Kept local to work-items.ts (not lifted into the shared/generic
 * @papercusp/coordination store library) — "issue family" is an app-level (papercusp)
 * concept, not something the generic coord-store package should know about.
 */
function guardAgainstIssueRef<T extends object>(store: T, storeName: string): T {
  return new Proxy(store, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        for (const arg of args) {
          if (arg && typeof arg === 'object' && (arg as { kind?: unknown }).kind === ISSUE_KIND) {
            throw new Error(
              `work-items.ts: ${storeName}.${String(prop)}() was called with an issue-family ObjectRef ` +
                `(${JSON.stringify(arg)}). This store is for feature-family refs only — dispatch ` +
                `issue-family reads/writes to ` +
                `issues-engineer.ts instead (see EI-19398986978436931).`,
            );
          }
        }
        return Reflect.apply(value as (...a: unknown[]) => unknown, target, args);
      };
    },
  });
}

const tags = guardAgainstIssueRef(new PgTaggableStore(coordOpts), 'tags');
const threads = guardAgainstIssueRef(new PgThreadStore(coordOpts), 'threads');
const subs = new PgEntitySubscriptionStore(coordOpts);
const links = new PgLinkStore(coordOpts);
const blockingLinks = createBlockingEdgeReader(links);

/** Bound feature-family coord relation writes so an interactive work_items:link
 * cannot hold the tool open on the unbounded admin pool after terminal work has
 * already committed (EI-23686882821651126). Work-item blocking edges use their
 * own serializable seam below and are intentionally not routed here. */
async function linkFeatureRelationBounded(src: ObjectRef, dst: ObjectRef, rel: string, by?: string): Promise<void> {
  await boundedOrgTxn(async (tx) => {
    const txLinks = new PgLinkStore({ ...coordOpts, getSql: () => tx });
    await txLinks.link(src, dst, rel, { created_by: by, created_ts: nowIso() });
  });
}

async function unlinkFeatureRelationBounded(src: ObjectRef, dst: ObjectRef, rel: string): Promise<void> {
  await boundedOrgTxn(async (tx) => {
    const txLinks = new PgLinkStore({ ...coordOpts, getSql: () => tx });
    await txLinks.unlink(src, dst, rel);
  });
}

/** The ObjectRef a work-item presents to the coord substrate (per family). */
export function workItemObjectRef(wi: Pick<WorkItem, 'family' | 'harness' | 'id'>): ObjectRef {
  if (wi.family === 'issue') return { kind: ISSUE_KIND, ref: wi.id };
  // feature-family: harness-qualified ref (a bare id is not unique across harnesses).
  // A feature-family item is harness-scoped by construction (harness_features_consolidated
  // .harness_slug is NOT NULL; work_items:create requires `harness` for feature/research-
  // task/chunk — verified 0/667 live rows have an empty harness). So a missing harness here
  // is a bug, not a default: `feature:<id>` with an empty harness would collide across
  // harnesses and corrupt coord dedup. Fail loud instead of `?? ''` (workspace-data-
  // isolation-leaks P-003).
  const harness = wi.harness?.trim();
  if (!harness) {
    throw new Error(
      `workItemObjectRef: feature-family work-item ${wi.id} has no harness — its ObjectRef ` +
        `would collide across harnesses (coord dedup corruption). A feature work-item must ` +
        `carry its harness.`,
    );
  }
  return { kind: FEATURE_KIND, ref: featureRef(harness, wi.id) };
}

function nowIso(): string {
  return new Date().toISOString();
}
// EI-18691099450966094: delegates to the shared pg-timestamp helper so a
// raw Postgres-text timestamptz (no parsed Date, e.g. from a UNION leg that
// casts for type parity across the feature/issue facade) is parsed and
// re-emitted as an explicit UTC "...Z" string rather than passed through
// as an ambiguous local-offset string.
const tsIso = pgTimestampToIso;
/** Nullable sibling — closed_ts is legitimately NULL on a pre-698 terminal row
 *  ("closed, time unknown"), and that must survive as null rather than becoming
 *  an empty string that a consumer would read as a real value. */
const tsIsoOrNull = pgTimestampToIsoOrNull;

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
  let v = (obj as Record<string, unknown>)[TERMINAL_COMPLETION_EVIDENCE_KEY];
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v) as unknown;
    } catch {
      return null;
    }
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  return v as PersistedCompletionEvidence;
}

/** Allocate the next kind-independent WI-NNN id (D-008). */
export async function nextWorkItemId(): Promise<string> {
  const { sql } = getOrgPg();
  const rows = await sql<{ id: string }[]>`SELECT harness_shared.next_work_item_id() AS id`;
  return rows[0].id;
}

/** Exported (WI-5213) so a targeted, server-side-filtered `listIssues` read (e.g.
 *  severity='critical') can be projected into the SAME `WorkItem` shape
 *  `matchesWorkItemClaimSpec` expects, without re-deriving this mapping or paying
 *  `listWorkItems`'s recency-capped, unfiltered-by-severity cross-family scan. */
export function issueToWorkItem(i: EngineerIssue): WorkItem {
  const externalBlockers = readExternalBlockers(i.payload);
  return {
    id: i.id,
    kind: i.kind,
    family: 'issue',
    harness: harnessOfScope(i.scope),
    title: i.title,
    summary: i.body,
    state: i.state,
    // EI-15027: collapse the "unassigned" sentinel (a legacy/foreign "not taken"
    // placeholder, EI-7939) to null here too — the canonical row-mapping layer, not
    // just the federation-ingest boundary — so classifyClaimFailure and every other
    // `!wi.assignee` truthiness check treat it as unclaimed instead of a live holder.
    assignee: normalizeTakenBy(i.assignee),
    // Issue-family uses engineer_issues.assigned_at as its claim-time anchor.
    // The unified work-item surface must expose it as takenAt so assignment
    // views/reapers do not read a live issue claim as unanchored.
    takenAt: i.assignedAt,
    // WI-3006: mirrors the takenAt fix above — engineer_issues.last_progress_at (migration 509)
    // is the real item-scoped progress signal for issue-family, bumped by markIssueProgress()
    // on a checkpoint. Was hardcoded null (issue-family checkpoints never advanced it), which
    // made classifyItemActivity fall back to takenAt forever and degrade any issue-family claim
    // held >STALE_MS with zero checkpoints to 'stalled' even while actively worked.
    lastProgressAt: i.lastProgressAt,
    assignedBy: i.assignedBy,
    createdBy: i.createdBy,
    severity: i.severity,
    // WI-37711: migration 790 exposes goal_id on the engineer_issues view; ISSUE_COLS
    // selects it, so the issue family (the one a goal-scoped drain fleet actually claims)
    // now carries its goal into matchesWorkItemClaimSpec instead of resolving null forever.
    goalId: i.goalId,
    // WI-20288042426947475 / migration 815: carry the issue view's claim-spec columns through
    // without collapsing an unprojected legacy view (undefined) into a projected NULL (null).
    ...(i.tags !== undefined
      ? {
          tags: Array.isArray(i.tags) ? i.tags.filter((t): t is string => typeof t === 'string') : null,
        }
      : {}),
    ...(i.sourcePlanSlug !== undefined ? { sourcePlanSlug: i.sourcePlanSlug } : {}),
    ...(i.sourcePlanItemIds !== undefined ? { sourcePlanItemIds: i.sourcePlanItemIds } : {}),
    ...(i.redundancy !== undefined ? { redundancy: i.redundancy } : {}),
    ...(i.expectedCostCents !== undefined ? { expectedCostCents: i.expectedCostCents } : {}),
    parent: i.parent,
    payload: i.payload ?? null,
    ...(externalBlockers.length ? { externalBlockers } : {}),
    rank: i.assigneeRank,
    rankWriter: i.rankWriter,
    rankUpdatedAt: i.rankUpdatedAt,
    // EI-10421: was hardcoded null with the (stale, pre-P-007/EI-7407) comment "issue-family
    // isn't the dispatched backlog — no feature_order". Issue-family items HAVE been part of
    // the dispatched backlog and steerable via `feature_order` since SCHEDULER_ISSUES_CLAIMABLE
    // (setWorkItemPriority writes it, claimNextIssueWorkItem's claim order reads it
    // unconditionally) — this read path was the one place left not reflecting that (the
    // `engineer_issues` view never selected the column; fixed alongside, migration 588).
    priority: i.featureOrder,
    terminalOwner: i.terminalOwner,
    terminalCompletionRef: i.terminalCompletionRef,
    terminalCompletionEvidence: extractTerminalCompletionEvidence(i.payload),
    completionAuthority: i.completionAuthority,
    // Federated issue-family rows are replicated facts owned by the authoring peer.
    // Surface the physical-row provenance so mutators can fail loud instead of
    // reporting "not found" after the engineer_issues view deliberately no-ops.
    origin: i.origin ?? 'local',
    auditVerdict: null,
    verifiedAuthorGithubUserId: null, // local-origin ⇒ never verified-stamped (P-008)
    createdAt: i.createdAt,
    updatedAt: i.updatedAt,
    closedAt: i.closedAt,
  };
}

/** The porsager `sql` instance type the org-scoped pool hands back — shared by the
 *  composable WHERE-fragment builders (claimFloorsWhereSql) + the spec-driven resolver. */
export type OrgSql = ReturnType<typeof getOrgPg>['sql'];

export interface FeatureRowDb {
  feature_id: string;
  item_kind: string | null;
  harness_slug: string;
  title: string | null;
  summary: string | null;
  status: string | null;
  needs_design?: boolean | null;
  design_status?: string | null;
  design_spec_id?: string | null;
  discarded_design_work?: boolean | null;
  taken_by: string | null;
  taken_at: unknown;
  last_progress_at: unknown;
  parent_id: string | null;
  payload: unknown;
  assignee_rank: number | null;
  rank_writer: string | null;
  rank_updated_at: unknown;
  feature_order: number | null;
  created_ts: unknown;
  updated_ts: unknown;
  origin: string | null;
  audit_verdict: string | null;
  verified_author_github_user_id: number | string | null;
  terminal_owner: string | null;
  terminal_completion_ref: string | null;
  /** P-004 — the completion-authority column (D-009: bare `authority` in the DB). */
  authority: string | null;
  /** EI-18820653360383242 — bigint epoch-ms on the base table (migration 698). */
  closed_ts: unknown;
  /** WI-37711 — the goal this item was filed under (migration 785). Already exposed by the
   *  `harness_features_consolidated` view, so this needed no migration of its own. */
  goal_id: string | null;
  // WI-38326 — the five claim-spec filter columns. All already exist on the base table
  // (`tags` jsonb, `source_plan_slug` text, `source_plan_item_ids` text[], `redundancy` integer,
  // `expected_cost_cents` bigint), so this needed no migration. `expected_cost_cents` is typed
  // `number | string` deliberately: postgres-js hands a bigint back as a STRING, the same trap
  // `coerceGithubUserId` exists for — a `number`-only type here would compile while silently
  // comparing a string at runtime.
  tags: unknown;
  source_plan_slug: string | null;
  source_plan_item_ids: string[] | null;
  redundancy: number | string | null;
  expected_cost_cents: number | string | null;
}
export function featureRowToWorkItem(r: FeatureRowDb): WorkItem {
  const externalBlockers = readExternalBlockers(r.payload);
  return {
    id: r.feature_id,
    kind: (r.item_kind as FeatureFamilyKind) || 'feature',
    family: 'feature',
    harness: r.harness_slug,
    title: r.title ?? '',
    summary: r.summary ?? '',
    needsDesign: r.needs_design ?? false,
    designStatus: isWorkItemDesignStatus(r.design_status) ? r.design_status : null,
    designSpecId: r.design_spec_id ?? null,
    discardedDesignWork: r.discarded_design_work ?? false,
    // work-item-status-full-unify P-007: the unified claimable token is 'open'
    // (feature `todo`→`open`). A null status defaults to the unified claimable
    // token, not the legacy 'todo' spelling (no row should sit at 'todo' post-backfill).
    state: r.status ?? 'open',
    // EI-15027: same sentinel-collapse as issueToWorkItem above — taken_by can carry
    // the same "unassigned" placeholder as engineer_issues.assignee.
    assignee: normalizeTakenBy(r.taken_by),
    // agent-activity-liveness-truth P-001: the claim time (grace anchor) + last REAL
    // item-scoped progress. Reset on holder-change (claim/release); bumped on a state
    // transition / checkpoint. Feed both to classifyItemActivity (item-activity.ts).
    takenAt: r.taken_at == null ? null : tsIso(r.taken_at),
    lastProgressAt: r.last_progress_at == null ? null : tsIso(r.last_progress_at),
    assignedBy: null, // feature-family has no assigned_by column (collapse-delegate D-002)
    createdBy: null, // feature-family has no equivalent authorship column
    severity: null,
    // WI-37711: unlike severity, goal_id is NOT an issue-family-only notion — it is a column
    // on the shared base table `work_items`, already exposed by the
    // harness_features_consolidated view (so this half needed no migration; only the
    // engineer_issues view did, migration 790).
    goalId: r.goal_id ?? null,
    // WI-38326 — carry the five claim-spec filter columns onto the mapped shape so the JS
    // evaluator resolves them from the SAME logical source the SQL compiler filters on.
    // `tags` is jsonb: postgres-js parses it to a real array, but a hand-seeded row can hold a
    // scalar or object, so narrow to string[] rather than trusting the column's shape.
    tags: Array.isArray(r.tags) ? r.tags.filter((t): t is string => typeof t === 'string') : null,
    sourcePlanSlug: r.source_plan_slug ?? null,
    sourcePlanItemIds: Array.isArray(r.source_plan_item_ids) ? r.source_plan_item_ids : null,
    // Numeric columns arrive as strings from postgres-js when the underlying type is bigint
    // (`expected_cost_cents`), so coerce both rather than typing the runtime problem away.
    redundancy: coerceFiniteNumber(r.redundancy),
    expectedCostCents: coerceFiniteNumber(r.expected_cost_cents),
    parent: r.parent_id,
    payload: r.payload ?? null,
    ...(externalBlockers.length ? { externalBlockers } : {}),
    rank: r.assignee_rank,
    rankWriter: isRankWriter(r.rank_writer) ? r.rank_writer : null,
    rankUpdatedAt: r.rank_updated_at == null ? null : tsIso(r.rank_updated_at),
    priority: r.feature_order,
    origin: r.origin ?? 'local',
    auditVerdict: r.audit_verdict,
    verifiedAuthorGithubUserId: coerceGithubUserId(r.verified_author_github_user_id),
    terminalOwner: r.terminal_owner,
    terminalCompletionRef: r.terminal_completion_ref,
    terminalCompletionEvidence: extractTerminalCompletionEvidence(r.payload),
    // A value outside the union can only arrive from a row written before the CHECK
    // constraint, or by a hand-edit that evaded it — read it as "no judgement" rather
    // than surfacing an unparseable token to every consumer.
    completionAuthority: isWorkItemCompletionAuthority(r.authority) ? r.authority : null,
    createdAt: tsIso(r.created_ts),
    updatedAt: tsIso(r.updated_ts),
    closedAt: tsIsoOrNull(r.closed_ts),
  };
}

/** Coerce a bigint-projected github_user_id (postgres-js may hand back a string)
 *  to a finite number, or null. P-008. */
function coerceGithubUserId(raw: number | string | null | undefined): number | null {
  if (raw == null) return null;
  const n = typeof raw === 'string' ? Number(raw) : raw;
  return Number.isFinite(n) ? n : null;
}

/** WI-38326 — same bigint-as-string coercion as above, for the numeric claim-spec filter
 *  columns (`redundancy` integer, `expected_cost_cents` bigint). Kept separate from
 *  `coerceGithubUserId` only because that one's name states a subject it no longer shares. */
function coerceFiniteNumber(raw: number | string | null | undefined): number | null {
  if (raw == null) return null;
  const n = typeof raw === 'string' ? Number(raw) : raw;
  return Number.isFinite(n) ? n : null;
}

// WI-38326: `tags, source_plan_slug, source_plan_item_ids, redundancy, expected_cost_cents` are
// selected for the CLAIM-SPEC evaluator, not for display. The SQL compiler (get-next.ts FIELD_MAP)
// filters on these five as COLUMNS; until they were projected here, `featureRowToWorkItem` could not
// see them and `claimSpecSubjectFromWorkItem` was left reading a payload-only fallback — so one spec
// admitted a row on the SQL path and refused it on the JS path (124 of 1600 probe x row verdict pairs
// disagreed; `redundancy` on 100% of rows). Keep this list and FIELD_MAP's column legs in step: a
// field the SQL side filters on by column and this projection omits is, by construction, invisible to
// the JS evaluator. Guarded by claim-spec-evaluator-parity.integration.test.ts.
export const FEATURE_COLS = `feature_id, item_kind, harness_slug, title, summary, status, taken_by,
  taken_at, last_progress_at,
  parent_id, payload, needs_design, design_status, design_spec_id, discarded_design_work,
  assignee_rank, rank_writer, rank_updated_at, feature_order, created_ts, updated_ts,
  origin, audit_verdict, verified_author_github_user_id, terminal_owner, terminal_completion_ref,
  authority, closed_ts, goal_id,
  tags, source_plan_slug, source_plan_item_ids, redundancy, expected_cost_cents`;

/**
 * FEATURE_COLS with the large JSONB payload projected away for list callers that
 * only need identity/state.  Keep the same arity and aliases as FEATURE_COLS so
 * featureRowToWorkItem can consume either shape without a second mapper.  SQL
 * predicates in listWorkItemsWithLimit still read the real payload where a filter
 * requires it; this only prevents postgres-js from parsing and retaining every
 * checkpoint/completion envelope before the agent result shaper drops it (WI-42508).
 */
export const FEATURE_COLS_PAYLOADLESS = FEATURE_COLS.replace(/(^|,\s*)payload(\s*,)/, '$1NULL::jsonb AS payload$2');

interface PlanItemClaimIdentity {
  planSlug: string;
  itemId: string;
  lockKey: string;
}

type PlanItemClaimRow = Pick<
  FeatureRowDb,
  'feature_id' | 'harness_slug' | 'payload' | 'source_plan_slug' | 'source_plan_item_ids'
>;

/**
 * Resolve the canonical plan-item identities carried by a claimed row. The indexed
 * source columns are authoritative when the pair is complete; older issue rows and
 * hand-authored fixtures can carry only the payload back-pointer, which remains the
 * compatibility fallback. Keep this pure and row-local so the claim transaction does
 * not perform a second lookup on a different connection.
 */
function planItemClaimIdentities(row: PlanItemClaimRow, workspaceId: string): PlanItemClaimIdentity[] {
  const sourcePlanSlug = typeof row.source_plan_slug === 'string' ? row.source_plan_slug.trim() : '';
  const sourceItemIds = Array.isArray(row.source_plan_item_ids)
    ? row.source_plan_item_ids
        .filter((itemId): itemId is string => typeof itemId === 'string')
        .map((itemId) => itemId.trim())
        .filter(Boolean)
    : [];

  let planSlug = sourcePlanSlug;
  let itemIds = sourceItemIds;
  if (!planSlug || itemIds.length === 0) {
    let payload = row.payload;
    if (typeof payload === 'string') {
      try {
        payload = JSON.parse(payload) as unknown;
      } catch {
        payload = null;
      }
    }
    const raw =
      payload && typeof payload === 'object' && !Array.isArray(payload)
        ? (payload as Record<string, unknown>).plan_item
        : null;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const plan = (raw as Record<string, unknown>).plan_slug;
      const item = (raw as Record<string, unknown>).item_id;
      planSlug = typeof plan === 'string' ? plan.trim() : '';
      itemIds = typeof item === 'string' && item.trim() ? [item.trim()] : [];
    } else {
      planSlug = '';
      itemIds = [];
    }
  }

  if (!planSlug || itemIds.length === 0) return [];
  return [...new Set(itemIds)].map((itemId) => ({
    planSlug,
    itemId,
    lockKey: `scheduler:plan-item-sibling:${workspaceId}:${planSlug}:${itemId}`,
  }));
}

/**
 * Serialize and validate a provisional self-select claim against all sibling rows
 * implementing the same canonical plan-item. Both feature and issue claim doors call
 * this from their bounded transaction, after their row-level SKIP LOCKED UPDATE.
 *
 * The advisory locks are deliberately acquired in sorted order. A row can implement
 * multiple plan-items, and a deterministic order prevents two multi-item claims from
 * deadlocking each other. The sibling SELECT is a separate READ COMMITTED statement
 * after the lock acquisition: a concurrent claimant that committed first is therefore
 * visible to the second claimant, which clears its provisional claim before commit.
 */
export async function guardPlanItemSiblingClaim(
  tx: OrgSql,
  row: PlanItemClaimRow,
  opts: { workspaceId: string; assignee: string; family: 'feature' | 'issue' },
): Promise<boolean> {
  const identities = planItemClaimIdentities(row, opts.workspaceId).sort((a, b) => a.lockKey.localeCompare(b.lockKey));
  if (identities.length === 0) return true;

  for (const identity of identities) {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${identity.lockKey}, 0))`;
  }

  const matches = identities.map(({ planSlug, itemId }) => {
    const sourceLinkComplete = tx`(
      NULLIF(btrim(wi.source_plan_slug), '') IS NOT NULL
      AND EXISTS (
        SELECT 1
          FROM unnest(COALESCE(wi.source_plan_item_ids, ARRAY[]::text[])) AS source_item(item_id)
         WHERE btrim(source_item.item_id) <> ''
      )
    )`;
    return tx`(
      (
        ${sourceLinkComplete}
        AND btrim(wi.source_plan_slug) = ${planSlug}
        AND EXISTS (
          SELECT 1
            FROM unnest(COALESCE(wi.source_plan_item_ids, ARRAY[]::text[])) AS source_item(item_id)
           WHERE btrim(source_item.item_id) = ${itemId}
        )
      )
      OR (
        NOT ${sourceLinkComplete}
        AND COALESCE(wi.payload, '{}'::jsonb) -> 'plan_item' ->> 'plan_slug' = ${planSlug}
        AND COALESCE(wi.payload, '{}'::jsonb) -> 'plan_item' ->> 'item_id' = ${itemId}
      )
    )`;
  });

  const sibling = await tx<{ feature_id: string }[]>`
    SELECT wi.feature_id
      FROM harness_shared.work_items wi
     WHERE wi.workspace_id = ${opts.workspaceId}
       AND wi.feature_id <> ${row.feature_id}
       AND wi.taken_by IS NOT NULL
       AND btrim(wi.taken_by) <> ''
       AND lower(btrim(wi.taken_by)) <> 'unassigned'
       AND wi.status NOT IN ('passed', 'deprecated', 'resolved', 'closed', 'done', 'dropped')
       AND (${matches.reduce((acc, match, index) => (index === 0 ? match : tx`${acc} OR ${match}`))})
     LIMIT 1`;
  if (sibling.length === 0) return true;

  // The provisional UPDATE and this cleanup share the same transaction. Use the
  // original relation for feature rows so the hfc DML triggers remain in the path;
  // issue rows are owned directly by the unified work_items base table.
  if (opts.family === 'feature') {
    await tx`
      UPDATE harness_shared.harness_features_consolidated
         SET taken_by = NULL, taken_at = NULL, last_progress_at = NULL, updated_ts = ${Date.now()}
       WHERE workspace_id = ${opts.workspaceId}
         AND harness_slug = ${row.harness_slug}
         AND feature_id = ${row.feature_id}
         AND taken_by = ${opts.assignee}`;
  } else {
    await tx`
      UPDATE harness_shared.work_items
         SET taken_by = NULL, taken_at = NULL, last_progress_at = NULL, updated_ts = ${Date.now()}
       WHERE workspace_id = ${opts.workspaceId}
         AND feature_id = ${row.feature_id}
         AND taken_by = ${opts.assignee}`;
  }
  return false;
}

// ── Reads ─────────────────────────────────────────────────────────────────────────
export interface ListWorkItemsFilter {
  harness?: string;
  /**
   * Restrict to any of these exact harness slugs. `harness` wins when both are
   * present; an explicitly empty array matches nothing. This is the set-valued
   * sibling used by the /adv inherited pot scope (selected pot + descendants).
   */
  harnesses?: readonly string[];
  /** Case-insensitive literal substring matched against title + body/summary. */
  q?: string;
  kind?: WorkItemKind;
  /**
   * P-010 / D-011: restrict to rows of these natures (work | record | document | event).
   * Unset or empty means nature 'work' only, UNLESS `kind` names one kind: naming a kind is
   * an explicit ask, so `kind: 'pipeline-deal'` still returns its record rows. The issue
   * family is bug/change/task, all nature 'work' (D-013), so a set without 'work' drops it.
   */
  natures?: readonly DatatypeNature[];
  /**
   * D-041 (WI-10005358): 'agent' keeps only rows the write doors accept (the shared
   * agentWorkCategoryWhereSql predicate); 'human' keeps human-audience rows; unset or 'any'
   * applies no audience filter. Applied in BOTH family shape fragments, so list and both
   * counts agree (WI-5512 parity). The work_items:list TOOL chooses the agent default.
   */
  audience?: WorkAudienceFilter;
  state?: string;
  /**
   * WI-38339 — `state` as a SET, for the question a single value cannot ask. Measured
   * over 7d of real agent SQL on this box: 46 hand-written statements filtered
   * `state`/`status` with IN / NOT IN, the dominant one being "everything not terminal".
   *
   * ADDITIVE rather than widening {@link state} to `string | string[]`: every existing
   * read site casts that field (`filter.state as IssueState`), and several pass it
   * straight into `status = ${…}`, so a union type would have to be re-checked at each
   * one — a wide blast radius for no gain. `states` ANDs with `state` when both are set.
   * Empty array = NO filter, never "match nothing".
   */
  states?: readonly string[];
  /**
   * WI-38339 — "everything still live": excludes every state terminal in EITHER family,
   * DERIVED from {@link ANY_FAMILY_TERMINAL_STATES} (never re-listed — that constant's
   * header records why: hand-copied terminal sets drifted and scored ~88% of finished
   * units as stranded, because every consumer reads "not in the set ⇒ still active").
   */
  notTerminal?: boolean;
  /**
   * WI-38339 — INCLUSIVE (`>=`) created/updated window, matching `plans:list`'s
   * established `createdSince`/`updatedSince`. 61 hand-written statements over the 7d
   * window carried a time predicate, against a tool with no time argument at all.
   *
   * ⚠ The issue family's pre-existing `createdAfter` is EXCLUSIVE (`>`) and is
   * deliberately NOT reused: mapping this onto it would make ONE list call apply
   * different boundary semantics per family — an inconsistency invisible in the result.
   */
  createdSince?: string;
  /** ISO timestamp — rows updated at or after it (INCLUSIVE). See {@link createdSince}. */
  updatedSince?: string;
  /** WI-38339 — "what work came out of this plan" (37 hand-written statements/7d).
   *  Both relations carry the column: features `source_plan_slug`, issues the same. */
  sourcePlanSlug?: string;
  /** Filter to items assigned to this agent (feature → taken_by; issue → assignee). */
  assignee?: string;
  /** Filter to items this owner delegated (collapse-delegate D-002). Issue-family only. */
  assignedBy?: string;
  /** Return children of this parent id (a chunk listing). Default: top-level only. */
  parent?: string;
  /** Include child items (chunks) in the default list. Default false (D-004). */
  includeChildren?: boolean;
  /**
   * Order by per-assignee `rank` ascending (NULLs last) instead of updatedAt DESC
   * (local-hive P-021). Only meaningful with an `assignee` filter — it returns that
   * agent's ordered work-list (head-of-line first). Default false.
   */
  orderByRank?: boolean;
  limit?: number;
  /**
   * EI-7841: when true, apply the SAME feature-family G2 admission/trust gate
   * (autoPickableWhereSql) the claim paths (`claimWorkItem` / `claimFloorsWhereSql`)
   * enforce — a remote, un-admitted item is excluded rather than listed as if
   * claimable. Default false/omitted: byte-identical to before (every existing
   * caller — dashboards, leader overviews, general `work_items:list` calls — keeps
   * seeing the full backlog including gated items). Opt in for a SELF-SELECT
   * consumer (e.g. coord:orient's claimable backlog) so "claimable" actually means
   * claimable.
   */
  admissibleOnly?: boolean;
  /**
   * Completion-integrity diagnostics. See {@link CompletionAudit} in completion-audit.ts
   * for the per-bucket contract; the buckets themselves are declared there, once.
   *
   * P-006/D-003 DELETED the 'no-evidence' bareness sweep: P-004 made structured evidence
   * required at WRITE time (an evidence-less close lands `authority:'proposed'`, out of
   * burn-down and still owned by its closer), so there is no longer a wrong value for a
   * later pass to re-verify. D-012 kept the remaining buckets because each fires on rows
   * that PASS that gate — an evidence-SHAPE defect ('geometry-unverified',
   * 'intermittent-underevidenced'), a gate-BYPASS alarm ('no-completion-record',
   * '-suspicious'), or an actor whose closes are never independently verified
   * ('reconciler-sourced') — none of which P-004 closes.
   *
   * Composes with `state` (an explicit state narrows the audit to it); without `state`
   * each bucket spans its own scope. Results are ordered newest-first, so recent closes
   * surface above the pre-gate legacy backlog.
   *
   * ⚠ THE STATE SCOPE BELONGS TO THE BUCKET, NOT TO THIS CALL SITE. Most buckets judge a
   * CLOSE and match only terminal rows (an open item owes no evidence yet); the
   * {@link OPEN_WORK_ITEM_AUDITS} set — currently `worked-then-abandoned` — judges an
   * OPEN row's lifecycle and matches only NON-terminal ones. Never re-derive that here:
   * {@link auditWhereSql} emits the state clause together with the predicate precisely so
   * a scope mismatch cannot produce a permanently-empty result that reads as "clean".
   */
  audit?: WorkItemAudit;
  /**
   * P-013 — filter TERMINAL rows by the completion-authority judgement P-004 stamps
   * ({@link WorkItemCompletionAuthority}), or `'unjudged'` for a close carrying NO
   * judgement (`authority IS NULL`). The read half D-012 left open: P-006/D-003 deleted
   * the `no-evidence` audit bucket once evidence became a WRITE-time requirement, which
   * also removed the only way to LIST under-evidenced closes. The judgement is a column
   * now, so the replacement is a filter over it — not a resurrected bareness sweep.
   *
   * ⚠ `'unjudged'` measures the INSTRUMENT, not the agents: only `work_items:complete`
   * stamps an authority, so a close routed through the bare `setWorkItemState` path lands
   * NULL however well evidenced it was (its evidence goes to `terminal_completion_ref`
   * instead, and `work_items:complete`'s own structured evidence lands in
   * `payload._completionEvidence` — three different places, so no single column is a
   * complete evidence test). Measured 2026-07-27: 38.2% of that day's agent closes were
   * gate-judged vs 0.1% the day before. An `'unjudged'` hit means "never judged", NOT
   * "unevidenced".
   *
   * Scoped to terminal rows, mirroring `audit`. Threaded to both families.
   */
  completionAuthority?: WorkItemCompletionAuthority | 'unjudged';
  /**
   * EI-10422/WI-4405: when true, INCLUDE `payload.lane === 'observation'` rows (default
   * false ⇒ EXCLUDED). Threaded to {@link listIssues}'s `excludeObservationLane`
   * (`!includeObservations`) — until this field existed, work_items:list's tool layer
   * (agent-tools/work_items/list.ts) passed `includeObservations` in an object literal
   * this interface didn't declare: a live `tsc --noEmit` TS2353 excess-property error
   * (the type checker caught it; the untyped runtime call silently dropped the field
   * anyway, since `listWorkItems` never read it) — so EI-10422's "exclude observations
   * by default" fix never actually reached this general read path. `admissibleOnly`
   * ALSO forces exclusion regardless of this flag (an observation is never claimable).
   */
  includeObservations?: boolean;
  /**
   * Omit the JSONB payload from returned feature/issue rows when the caller only
   * needs list identity/state.  Predicates continue to use the real payload where
   * necessary; this flag controls the SELECT projection only.  Defaults to true
   * for backwards-compatible internal/detail reads (WI-42508).
   */
  includePayload?: boolean;
  /**
   * Omit the issue-family body/summary from returned rows.  Feature summaries are
   * unaffected by this flag.  The agent-facing list sets both body and payload
   * false before the post-handler tier shaper runs (WI-42508).
   */
  includeBody?: boolean;
}

/**
 * The cross-family TERMINAL state set (P-005) — a row in any of these owes completion
 * evidence. Union of both families' closes (feature: done/passed/dropped/deprecated;
 * issue: resolved/closed/deprecated). Exported so audit consumers (work_items:list,
 * burn_down) share ONE definition.
 */
/**
 * The cross-family terminal set. DERIVED, never hand-listed (P-028 / D-067).
 *
 * This was a literal 6-element copy of exactly what `ANY_FAMILY_TERMINAL_STATES`
 * already computes as `FEATURE_TERMINAL_STATES ∪ ISSUE_TERMINAL_STATES` — and that
 * module is imported into THIS file already, so the copy bought nothing and could
 * only drift. Measured equal at the moment of collapse (both
 * `[closed, deprecated, done, dropped, passed, resolved]`), so this is a pure
 * de-duplication with no behaviour change.
 *
 * Why it matters that it was a copy rather than merely redundant: this exact class
 * has bitten here twice, and both are recorded next to the union's own definition —
 * placement-watchdog's hand-copied union went stale across the 2026-07-19 status
 * unification (EI-18653071581558556), and `ISSUE_TERMINAL_STATES` itself omitted
 * `dropped` for over a month while 4,322 live issue-family rows carried it
 * (EI-21921121818266895). A copy of a derived truth is a future drift with a date
 * on it; the ladder's first rung is to derive it instead.
 */
export const TERMINAL_WORK_ITEM_STATES: readonly string[] = ANY_FAMILY_TERMINAL_STATES;

/**
 * Recency comparator — newest `updatedAt` first. The default work-item order.
 */
export function compareByRecency(a: WorkItem, b: WorkItem): number {
  return a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0;
}

/**
 * Head-of-line comparator for an assignee's ordered work-list — the swarm
 * scheduler's BUFFERED-DRAIN order (swarm-coordination-architecture P-005 /
 * D-006). Ranked items first by `rank` ASC, unranked (`rank == null`) sink to
 * the tail (treated as +∞), and ties break by recency (newest first). This is
 * how the Queen places several items ahead and a bee drains them head-of-line
 * without waiting on the brain's cadence; it MERGES across families (a bee's
 * feature-family + issue-family items interleave by rank into one list).
 *
 * Pure + total so it is unit-testable in isolation; `listWorkItems` applies it
 * after the cross-family fetch.
 */
export function compareByHeadOfLine(a: WorkItem, b: WorkItem): number {
  const ar = a.rank ?? Number.POSITIVE_INFINITY;
  const br = b.rank ?? Number.POSITIVE_INFINITY;
  if (ar !== br) return ar - br;
  return compareByRecency(a, b);
}

/**
 * Feature-family `item_kind` filter that ALSO admits workspace-registered GENERIC-KIND
 * datatypes (reflexive-platform-extensibility-datatypes-2026-06-24 P-001). A generic-kind
 * item (e.g. a `bet`) lives in the feature family (`familyOf` → 'feature') but its kind is
 * not one of the built-ins, so a bare `IN ('feature','chunk')` would
 * HIDE it from list/count/search. This admits the built-ins OR any active generic-kind
 * registered for `workspaceId`. DARK until a datatype is declared — the subquery is empty
 * otherwise, so the live fleet's reads are byte-identical.
 *
 * SCOPE: this is the user/agent-facing VISIBILITY filter (list/count/search). The Queen's
 * autonomous PLACEMENT frontier (claimFloorsWhereSql / survey.fetchFrontierRows /
 * wake-frontier-guard) is a SEPARATE clause — `frontierPlacementKindClause`
 * (datatype-frontier-placement.ts) — gated on the `hive-placement` opt-in tag, because a
 * datatype is visible without necessarily auto-placing a bee per instance (placement is opt-in).
 */
function featureFamilyKindClause(sql: OrgSql, workspaceId: string, opts: { includeDeprecatedChunk?: boolean } = {}) {
  // Compute the visible kinds once so PG can use hfc_item_kind_idx's item_kind
  // key. A builtin OR a hashed registry subplan instead scans the whole table
  // (EI-24109951788640754), even though only a small feature-family slice matches.
  // UNION preserves set semantics when a registered kind repeats a builtin.
  const builtIn = opts.includeDeprecatedChunk
    ? sql`SELECT 'feature'::text UNION SELECT 'chunk'::text`
    : sql`SELECT 'feature'::text`;
  return sql`item_kind = ANY(ARRAY(
         ${builtIn}
         UNION
         SELECT work_item_kind FROM harness_shared.datatype_registry
          WHERE workspace_id = ${workspaceId} AND tier = 'generic-kind' AND status = 'active'
            AND work_item_kind IS NOT NULL
       ))`;
}

/** Escape LIKE metacharacters so a free-text list query remains a literal substring. */
function likeContainsPattern(query: string): string {
  return `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** Cross-kind list. Default = top-level items only (chunks surface under their parent, D-004). */
/**
 * WI-38339 — the SHAPE filters (state SET / notTerminal / created+updated window /
 * source plan) as ONE fragment for the FEATURE relation, mirroring
 * {@link issueShapeWhereSql} for the issue relation.
 *
 * TWO separate builders, on purpose — and the reason is stronger than naming. The two
 * relations differ in the column TYPE, not just the spelling:
 *
 *   harness_features_consolidated : status / created_ts / updated_ts  → BIGINT epoch-ms
 *   engineer_issues               : state  / created_at / updated_at  → timestamptz
 *
 * So the SAME inclusive `>=` window compiles to two different comparisons, and the
 * feature side must convert the caller's ISO instant to epoch-ms. Writing
 * `created_ts >= '…'::timestamptz` there is not a subtle mistake but a hard Postgres
 * error (no bigint >= timestamptz operator) — invisible to tsc, which cannot see inside
 * a SQL template. Verified against information_schema rather than inferred from the
 * `_ts`/`_at` suffix, which is the tell but not the proof.
 * What they DO share is the semantics, which is where drift would actually hurt: both
 * derive notTerminal from ANY_FAMILY_TERMINAL_STATES and both use INCLUSIVE `>=`, so
 * one work_items:list call cannot apply different boundaries to its two families.
 *
 * Called by listWorkItems AND both COUNT companions (the WI-5512 parity rule): a
 * predicate applied to the list but missed by a count makes "N of TOTAL" quietly
 * wrong — numerator honest, denominator not, and no error to notice.
 *
 * Returns `TRUE` when nothing is set, so a call site can AND it unconditionally.
 */
/**
 * P-010 / D-011 — the default-read nature boundary, ONE definition for list, both counts
 * and search. Non-empty `natures` → that set. Otherwise an explicit `kind` → no nature
 * filter (the caller named the kind). Otherwise only nature 'work', so a record-, document-
 * or event-nature row never surfaces in a default work read. `nature` is stamped on every
 * work_items row by the 1322 trigger from datatype_registry (D-018).
 */
export function natureWhereSql(
  sql: OrgSql,
  natures: readonly DatatypeNature[] | undefined,
  kind: string | undefined,
) {
  if (natures && natures.length > 0) return sql`nature = ANY(${natures as string[]}::text[])`;
  if (kind) return sql`TRUE`;
  return sql`nature = 'work'`;
}

/** Whether a `natures` filter admits the issue family (bug/change/task are nature 'work'). */
export function naturesAdmitWork(natures: readonly DatatypeNature[] | undefined): boolean {
  return !natures || natures.length === 0 || natures.includes('work');
}

function featureShapeWhereSql(sql: OrgSql, filter: ListWorkItemsFilter) {
  // An EMPTY `states` array is NO filter, never "match nothing": `= ANY('{}')` is false
  // for every row, so an empty list would return zero rows — indistinguishable from a
  // genuine empty result, which is the direction a caller cannot detect.
  const states = filter.states && filter.states.length > 0 ? filter.states : null;
  return sql`
    ${states ? sql`status = ANY(${states as string[]}::text[])` : sql`TRUE`}
    AND ${filter.notTerminal ? sql`NOT (status = ANY(${ANY_FAMILY_TERMINAL_STATES as string[]}::text[]))` : sql`TRUE`}
    AND ${
      filter.createdSince
        ? sql`created_ts >= (EXTRACT(EPOCH FROM ${filter.createdSince}::timestamptz) * 1000)::bigint`
        : sql`TRUE`
    }
    AND ${
      filter.updatedSince
        ? sql`updated_ts >= (EXTRACT(EPOCH FROM ${filter.updatedSince}::timestamptz) * 1000)::bigint`
        : sql`TRUE`
    }
    AND ${
      filter.sourcePlanSlug
        ? sql`(
            source_plan_slug = ${filter.sourcePlanSlug}
            OR payload -> 'plan_item' ->> 'plan_slug' = ${filter.sourcePlanSlug}
          )`
        : sql`TRUE`
    }
    AND ${natureWhereSql(sql, filter.natures, filter.kind)}
    AND ${audienceWhereSql(sql, filter.audience)}`;
}

/**
 * WI-38339 — the new SHAPE filters as they cross into the ISSUE family. One place, so
 * the three delegating call sites (listIssues / countIssues / countIssuesByState) cannot
 * thread different subsets of them — the same parity hazard the SQL helpers close, one
 * layer up.
 */
function issueShapeFilterArgs(filter: ListWorkItemsFilter) {
  return {
    states: filter.states,
    notTerminal: filter.notTerminal,
    createdSince: filter.createdSince,
    updatedSince: filter.updatedSince,
    sourcePlanSlug: filter.sourcePlanSlug,
    audience: filter.audience,
  };
}

/**
 * Append every mapped row onto `out` without ever calling a function with one
 * argument per row.
 *
 * EI-22068903877831794: `out.push(...rows.map(fn))` builds a SINGLE call frame
 * carrying `rows.length` arguments. V8 caps that argument count well below the
 * row counts a full-harness, unbounded (`rowLimit === null`) file export can
 * return — this harness alone holds >150k issue-family rows — so the spread
 * form throws `RangeError: Maximum call stack size exceeded` past the ceiling
 * (observed ~10s in, on the issue-family branch) instead of scaling with the
 * export's whole reason for existing: an uncapped read. A `for` loop calls
 * `push` once per row (O(1) arguments each time, never O(n)), so it has no
 * such ceiling and costs nothing extra over the spread form it replaces.
 */
export function pushMapped<Row, Out>(out: Out[], rows: readonly Row[], mapRow: (row: Row) => Out): void {
  for (const row of rows) out.push(mapRow(row));
}

async function listWorkItemsWithLimit(filter: ListWorkItemsFilter, rowLimit: number | null): Promise<WorkItem[]> {
  const { sql } = getOrgPg();
  const q = filter.q?.trim();
  // assignedBy is an issue-family-only concept, so it excludes all feature rows.
  const wantFeature = (!filter.kind || familyOf(filter.kind) === 'feature') && !filter.assignedBy;
  const wantIssue = (!filter.kind || familyOf(filter.kind) === 'issue') && naturesAdmitWork(filter.natures);
  const out: WorkItem[] = [];

  if (wantFeature) {
    const ws = activeWorkspaceId();
    const rows = await sql<FeatureRowDb[]>`
      SELECT ${sql.unsafe(filter.includePayload === false ? FEATURE_COLS_PAYLOADLESS : FEATURE_COLS)}
        FROM harness_shared.harness_features_consolidated
         WHERE ${featureFamilyKindClause(sql, ws, {
           includeDeprecatedChunk: filter.kind === 'chunk' || Boolean(filter.parent) || filter.includeChildren === true,
         })}
         AND workspace_id = ${ws}
         AND ${
           filter.harness
             ? sql`harness_slug = ${filter.harness}`
             : filter.harnesses
               ? sql`harness_slug = ANY(${filter.harnesses as string[]}::text[])`
               : sql`TRUE`
         }
         AND ${q ? sql`(COALESCE(title, '') ILIKE ${likeContainsPattern(q)} ESCAPE '\\' OR COALESCE(summary, '') ILIKE ${likeContainsPattern(q)} ESCAPE '\\')` : sql`TRUE`}
         AND ${filter.kind && familyOf(filter.kind) === 'feature' ? sql`item_kind = ${filter.kind}` : sql`TRUE`}
         AND ${filter.state ? sql`status = ${filter.state}` : sql`TRUE`}
         AND ${featureShapeWhereSql(sql, filter)}
         AND ${filter.assignee ? sql`taken_by = ${filter.assignee}` : sql`TRUE`}
         AND ${
           filter.parent
             ? sql`parent_id = ${filter.parent}`
             : filter.includeChildren
               ? sql`TRUE`
               : sql`(parent_id IS NULL OR parent_id = '')`
         }
         AND ${
           filter.admissibleOnly
             ? sql`(
                 ${autoPickableWhereSql(sql, ws)}
                 AND ${admittedWhereSql(sql)}
                 -- WI-5343: mirror claimFloorsWhereSql's FEATURE-family floors here too — a
                 -- claim-held (_claimHold) or plan-lane-reserved feature item is not actually
                 -- claimable, so "admissible" must exclude it the same way the issue-family
                 -- branch (issueAdmissibleWhereSql, WI-4405) already does. No owner-exemption
                 -- for the plan-lane floor here (generic list read, no specific claiming
                 -- assignee) — mirrors issueAdmissibleWhereSql's own list-context shape.
                 AND ${claimHoldExclusionSql(sql, 'payload')}
                 AND ${reservedPlanLaneExclusionSql(sql, '', 'payload')}
                 AND ${agentReviewNormalExclusionSql(sql, 'payload')}
               )`
             : sql`TRUE`
         }
         AND ${
           filter.audit
             ? auditWhereSql(sql, filter.audit, {
                 stateColumn: 'status',
                 terminalStates: TERMINAL_WORK_ITEM_STATES,
               })
             : sql`TRUE`
         }
         -- P-013: see ListWorkItemsFilter.completionAuthority. Terminal-scoped for the same
         -- reason the audit filter is — an OPEN row has no close to judge and carries
         -- authority NULL by construction, so letting it answer 'unjudged' would return the
         -- whole open backlog and read as mass under-evidencing, not a measure of closes.
         AND ${
           filter.completionAuthority
             ? sql`(status = ANY(${TERMINAL_WORK_ITEM_STATES as string[]}::text[]) AND ${completionAuthorityPredicateSql(sql, filter.completionAuthority)})`
             : sql`TRUE`
         }
       ORDER BY ${filter.orderByRank ? sql`assignee_rank ASC NULLS LAST, updated_ts DESC` : sql`updated_ts DESC NULLS LAST`}
       ${rowLimit === null ? sql`` : sql`LIMIT ${rowLimit}`}`;
    pushMapped(out, rows, featureRowToWorkItem);
  }

  // Issue-family rows can also carry parent edges (duplicates/delegated children). The
  // shared issue filter applies the same parent/includeChildren semantics as features.
  if (wantIssue) {
    const issueFilter: ListIssuesFilter = {
      // A specific issue-family kind, else ALL issue-family kinds (incl. `task`) — the
      // unified surface includes delegated tasks; the issues:* surface (its own default)
      // does not.
      kind: filter.kind && familyOf(filter.kind) === 'issue' ? (filter.kind as IssueStoreKind) : undefined,
      kinds: filter.kind && familyOf(filter.kind) === 'issue' ? undefined : ISSUE_FAMILY_KINDS,
      scope: filter.harness ? `harness:${filter.harness}` : undefined,
      scopes: filter.harness ? undefined : filter.harnesses?.map((harness) => `harness:${harness}`),
      state: (filter.state as IssueState) || undefined,
      ...issueShapeFilterArgs(filter),
      q,
      assignee: filter.assignee,
      assignedBy: filter.assignedBy,
      parent: filter.parent,
      includeChildren: filter.includeChildren === true,
      // WI-3649: mirror the feature branch's admissibleOnly gate (line ~530) so
      // "claimable backlog" excludes federated (origin='remote') issue-family rows
      // that the write path (claimNextIssueWorkItem / the engineer_issues_view_dml
      // trigger) will never actually let a local claim succeed against.
      admissibleOnly: filter.admissibleOnly,
      // WI-4405: admissibleOnly ALSO forces exclusion (an observation is never
      // claimable, regardless of includeObservations) — otherwise honor the flag.
      excludeObservationLane: filter.admissibleOnly ? true : !filter.includeObservations,
      // WI-42508: the unified agent list never needs issue body/payload while
      // shaping a placement row. Keep the flags explicit so direct/internal
      // callers retain the full projection by default.
      includeBody: filter.includeBody,
      includePayload: filter.includePayload,
      audit: filter.audit,
      completionAuthority: filter.completionAuthority,
    };
    const issues =
      rowLimit === null
        ? await listAllIssuesForFileExport(issueFilter)
        : await listIssues({ ...issueFilter, limit: rowLimit });
    pushMapped(out, issues, issueToWorkItem);
  }

  out.sort(filter.orderByRank ? compareByHeadOfLine : compareByRecency);
  return rowLimit === null ? out : out.slice(0, rowLimit);
}

export async function listWorkItems(filter: ListWorkItemsFilter = {}): Promise<WorkItem[]> {
  return listWorkItemsWithLimit(filter, Math.min(filter.limit ?? 100, WORK_ITEMS_MAX_LIMIT));
}

/**
 * Complete cross-family read for file-backed exporters. Unlike
 * {@link listWorkItems}, this does not apply the UI/result-payload ceiling.
 * Callers must keep the rows off the model transport and return bounded
 * metadata only.
 */
export async function listAllWorkItemsForFileExport(filter: ListWorkItemsFilter = {}): Promise<WorkItem[]> {
  return listWorkItemsWithLimit(filter, null);
}

/**
 * COUNT companion to {@link listWorkItems} — the true total across BOTH families
 * for the same filter, minus limit/order. A capped list read pairs with this to
 * show "N of TOTAL" instead of letting the downloaded length masquerade as the
 * total. Two cheap COUNT(*)s (one per family), mirroring listWorkItems' WHERE
 * exactly so the total is consistent with what the list would return uncapped.
 */
export async function countWorkItems(filter: ListWorkItemsFilter = {}): Promise<number> {
  const { sql } = getOrgPg();
  const wantFeature = (!filter.kind || familyOf(filter.kind) === 'feature') && !filter.assignedBy;
  const wantIssue = (!filter.kind || familyOf(filter.kind) === 'issue') && naturesAdmitWork(filter.natures);
  let total = 0;

  if (wantFeature) {
    const ws = activeWorkspaceId();
    const rows = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n
        FROM harness_shared.harness_features_consolidated
       WHERE ${featureFamilyKindClause(sql, ws, {
         includeDeprecatedChunk: filter.kind === 'chunk' || Boolean(filter.parent) || filter.includeChildren === true,
       })}
         AND workspace_id = ${ws}
         AND ${
           filter.harness
             ? sql`harness_slug = ${filter.harness}`
             : filter.harnesses
               ? sql`harness_slug = ANY(${filter.harnesses as string[]}::text[])`
               : sql`TRUE`
         }
         AND ${filter.kind && familyOf(filter.kind) === 'feature' ? sql`item_kind = ${filter.kind}` : sql`TRUE`}
         AND ${filter.state ? sql`status = ${filter.state}` : sql`TRUE`}
         AND ${featureShapeWhereSql(sql, filter)}
         AND ${filter.assignee ? sql`taken_by = ${filter.assignee}` : sql`TRUE`}
         AND ${
           filter.parent
             ? sql`parent_id = ${filter.parent}`
             : filter.includeChildren
               ? sql`TRUE`
               : sql`(parent_id IS NULL OR parent_id = '')`
         }
         AND ${
           filter.admissibleOnly
             ? sql`(
                 ${autoPickableWhereSql(sql, ws)}
                 AND ${admittedWhereSql(sql)}
                 -- WI-5512: mirror listWorkItems' admissibleOnly branch (WI-5343) here too —
                 -- this COUNT must apply the same claim-hold/plan-lane floors as the LIST it
                 -- pairs with, or "N of TOTAL" undercounts-as-overcounts (numerator honest,
                 -- denominator not).
                 AND ${claimHoldExclusionSql(sql, 'payload')}
                 AND ${reservedPlanLaneExclusionSql(sql, '', 'payload')}
                 AND ${agentReviewNormalExclusionSql(sql, 'payload')}
               )`
             : sql`TRUE`
         }
         -- P-013: the audit and completionAuthority filters are terminal-row DIAGNOSTICS, and
         -- this COUNT applied NEITHER — the same count-vs-list parity bug WI-5512 fixed for
         -- admissibleOnly, still live for the audit branch (pre-existing) and about to be
         -- live for completionAuthority. Unfixed, a caller filtering to a handful of flagged
         -- closes is told the denominator is the WHOLE backlog, which reads as "0.1% of items
         -- are flagged" when the honest figure is "N of the M closes we filtered". Both are
         -- mirrored here, so numerator and denominator answer the same question.
         AND ${
           filter.audit
             ? auditWhereSql(sql, filter.audit, {
                 stateColumn: 'status',
                 terminalStates: TERMINAL_WORK_ITEM_STATES,
               })
             : sql`TRUE`
         }
         AND ${
           filter.completionAuthority
             ? sql`(status = ANY(${TERMINAL_WORK_ITEM_STATES as string[]}::text[]) AND ${completionAuthorityPredicateSql(sql, filter.completionAuthority)})`
             : sql`TRUE`
         }`;
    total += rows[0]?.n ?? 0;
  }

  // Keep issue-family count semantics identical to listWorkItems.
  if (wantIssue) {
    total += await countIssues({
      kind: filter.kind && familyOf(filter.kind) === 'issue' ? (filter.kind as IssueStoreKind) : undefined,
      kinds: filter.kind && familyOf(filter.kind) === 'issue' ? undefined : ISSUE_FAMILY_KINDS,
      scope: filter.harness ? `harness:${filter.harness}` : undefined,
      scopes: filter.harness ? undefined : filter.harnesses?.map((harness) => `harness:${harness}`),
      state: (filter.state as IssueState) || undefined,
      ...issueShapeFilterArgs(filter),
      assignee: filter.assignee,
      assignedBy: filter.assignedBy,
      parent: filter.parent,
      includeChildren: filter.includeChildren === true,
      // WI-5512: countWorkItems' issue-family call never threaded this through, even
      // though countIssues itself already supports it (issueAdmissibleWhereSql) and
      // listWorkItems' issue branch already passes it — same count-vs-list parity gap
      // as the feature-family fix above, same fix.
      admissibleOnly: filter.admissibleOnly,
      excludeObservationLane: filter.admissibleOnly ? true : !filter.includeObservations,
      // P-013: same count-vs-list parity fix as the feature-family branch above — the
      // issue-family COUNT ignored both diagnostic filters too.
      audit: filter.audit,
      completionAuthority: filter.completionAuthority,
    });
  }

  return total;
}

/**
 * STATE-HISTOGRAM companion to {@link countWorkItems} — `state -> count` across BOTH
 * families for the same filter, mirroring its WHERE exactly (so the histogram's sum
 * equals countWorkItems' scalar).
 *
 * P-008 (db-performance-remediation-2026-07-26). Use this instead of listing rows and
 * tallying them in JS. `system-health/compute.ts`'s `collectWorkItems` did
 * `listWorkItems({ limit: 2000 })` then `for (const it of items) byState[it.state]++`,
 * shipping ~4.7MB of `body`+`payload` JSONB per call across 761k calls to derive ~7
 * integers — the single largest live consumer of this database (22.6% of live DB time,
 * measured by delta not by lifetime totals; see plan decision D-007).
 *
 * Two reasons this is an aggregate rather than the "add a column projection" the plan
 * item originally proposed:
 *  1. Projection was NOT AVAILABLE here. Both hot callers genuinely read the heavy
 *     columns — `issueToWorkItem` maps `summary: i.body` and `payload: i.payload`, and
 *     `issueToCandidate` destructures ~10 fields out of payload. Dropping them from the
 *     SELECT would have silently degraded both to undefined. (Same trap as P-006/D-005,
 *     where the "obvious" projection measured as a pessimization and was reverted.)
 *  2. The list shape was also WRONG, not just slow — the 2000-row cap silently truncated
 *     the tally, so the panel reported `total: 2000` against ~51,869 real rows. An
 *     aggregate cannot be truncated.
 *
 * Measured, EXPLAIN (ANALYZE, SERIALIZE), 3 runs each: list shape 4734 kB / ~195 ms vs
 * this GROUP BY 1 kB / ~52 ms — ~4,700x fewer bytes, ~3.7x faster.
 */
export async function countWorkItemsByState(filter: ListWorkItemsFilter = {}): Promise<Record<string, number>> {
  const { sql } = getOrgPg();
  const wantFeature = (!filter.kind || familyOf(filter.kind) === 'feature') && !filter.assignedBy;
  const wantIssue = (!filter.kind || familyOf(filter.kind) === 'issue') && naturesAdmitWork(filter.natures);
  const byState: Record<string, number> = {};
  const add = (state: string | null | undefined, n: number) => {
    const k = state ?? 'unknown';
    byState[k] = (byState[k] ?? 0) + n;
  };

  if (wantFeature) {
    const ws = activeWorkspaceId();
    const rows = await sql<{ state: string | null; n: number }[]>`
      SELECT status AS state, count(*)::int AS n
        FROM harness_shared.harness_features_consolidated
       WHERE ${featureFamilyKindClause(sql, ws, {
         includeDeprecatedChunk: filter.kind === 'chunk' || Boolean(filter.parent) || filter.includeChildren === true,
       })}
         AND workspace_id = ${ws}
         AND ${
           filter.harness
             ? sql`harness_slug = ${filter.harness}`
             : filter.harnesses
               ? sql`harness_slug = ANY(${filter.harnesses as string[]}::text[])`
               : sql`TRUE`
         }
         AND ${filter.kind && familyOf(filter.kind) === 'feature' ? sql`item_kind = ${filter.kind}` : sql`TRUE`}
         AND ${filter.state ? sql`status = ${filter.state}` : sql`TRUE`}
         AND ${featureShapeWhereSql(sql, filter)}
         AND ${filter.assignee ? sql`taken_by = ${filter.assignee}` : sql`TRUE`}
         AND ${
           filter.parent
             ? sql`parent_id = ${filter.parent}`
             : filter.includeChildren
               ? sql`TRUE`
               : sql`(parent_id IS NULL OR parent_id = '')`
         }
         AND ${
           filter.admissibleOnly
             ? sql`(
                 ${autoPickableWhereSql(sql, ws)}
                 AND ${admittedWhereSql(sql)}
                 AND ${claimHoldExclusionSql(sql, 'payload')}
                 AND ${reservedPlanLaneExclusionSql(sql, '', 'payload')}
                 AND ${agentReviewNormalExclusionSql(sql, 'payload')}
               )`
             : sql`TRUE`
         }
       GROUP BY status`;
    for (const r of rows) add(r.state, r.n);
  }

  // Keep the state histogram's issue-family parent semantics identical to the list/count.
  if (wantIssue) {
    const issueStates = await countIssuesByState({
      kind: filter.kind && familyOf(filter.kind) === 'issue' ? (filter.kind as IssueStoreKind) : undefined,
      kinds: filter.kind && familyOf(filter.kind) === 'issue' ? undefined : ISSUE_FAMILY_KINDS,
      scope: filter.harness ? `harness:${filter.harness}` : undefined,
      scopes: filter.harness ? undefined : filter.harnesses?.map((harness) => `harness:${harness}`),
      state: (filter.state as IssueState) || undefined,
      ...issueShapeFilterArgs(filter),
      assignee: filter.assignee,
      assignedBy: filter.assignedBy,
      parent: filter.parent,
      includeChildren: filter.includeChildren === true,
      admissibleOnly: filter.admissibleOnly,
      excludeObservationLane: filter.admissibleOnly ? true : !filter.includeObservations,
    });
    for (const [state, n] of Object.entries(issueStates)) add(state, n);
  }

  return byState;
}

/** Resolve one work-item by id, searching both kind-tables (ids are disjoint across families). */
export async function getWorkItem(
  id: string,
  harness?: string,
  opts: WorkItemReadOptions = {},
  client?: ReturnType<typeof getOrgPg>['sql'],
): Promise<WorkItem | null> {
  // ⚠ `harness` is NOT applied to the issue-family branch — see harnessScopeMismatch()
  // below for why that is deliberate, and for the guard that covers what it leaves open.
  //
  // This used to read "Issue-family ids (EI-* or a WI-* that lives in engineer_issues)
  // are globally unique", which justified the unscoped read. That premise is TRUE for
  // `EI-<snowflake>` ids and FALSE for `WI-<n>` ids: D-008 (migration
  // 142-work-items-unify.sql) started minting WI ids into this same table from
  // `harness_shared.work_item_seq`, a PER-DATABASE sequence that STARTs at 1. So
  // WI-1/WI-2/WI-3 exist in every long-lived store and a fresh one mints exactly those.
  // `getFeatureWorkItemOnly` 12 lines below already states the correct rule (F-B3: "a
  // bare WI/F id is unique only within a (workspace, harness), not globally") — the two
  // halves of one id space disagreed, and the issue half was the one being trusted.
  // WI-10006010: `harness` is a PREFERENCE among same-id slug twins, never a filter.
  const issue = await getIssue(id, opts, client, harness);
  if (issue) {
    const issueItem = issueToWorkItem(issue);
    // WI-10006534: the preference must also hold ACROSS families. When the caller named a
    // harness, the issue row that came back belongs to a DIFFERENT harness, and that named
    // harness owns a FEATURE-family row with the same id, the caller's row is the feature
    // row. Returning the issue row made the feature row unreachable by any tool (measured
    // 2026-10-06: email's WI-10000680 could not be dropped; set_state wrote papercusp's
    // WI-10000680 instead). Still a preference, not a filter: with no exact-harness
    // feature row, the issue row is returned exactly as before (harnessScopeMismatch warns).
    if (harness && harnessScopeMismatchLeaf(issueItem, harness)) {
      const exact = await getFeatureWorkItemOnly(id, harness, opts, client);
      if (exact) return exact;
    }
    return issueItem;
  }
  return getFeatureWorkItemOnly(id, harness, opts, client);
}

/**
 * Cross-harness retarget detection (EI-19393623437103599) — see the note on
 * `getWorkItem` above for why `harness` is not applied to the issue-family branch.
 *
 * Re-exported here so it is discoverable beside `getWorkItem`, but it LIVES in a leaf
 * module: the write verbs that need it mock this module wholesale in their unit tests
 * (a `vi.mock` factory replaces every export), so a guard defined here would be
 * `undefined` at precisely the call sites it exists to protect.
 */
export { harnessScopeMismatch, type HarnessScopeMismatch } from './work-items-harness-scope';
import { harnessScopeMismatch as harnessScopeMismatchLeaf } from './work-items-harness-scope';
// EI-21919769900781478: kept in a LEAF module (the write verbs mock this file wholesale
// in their unit tests), re-exported here so it stays discoverable beside
// `selfHealAuthorOriginIfStranded`, which handles the sibling stranding.
export {
  decideOrphanAuthorClose,
  lookupRemoteAuthorEndedAt,
  healOrphanedRemoteOriginIfAuthorEnded,
  type OrphanAuthorCloseReason,
} from './work-items-orphan-author';
// EI-22189521072988065: same LEAF-module rule as the block above, re-exported here
// so it stays discoverable beside `selfHealAuthorOriginIfStranded` — the sibling
// stranding for a row whose closer (terminal_owner) is not its original creator.
export {
  decideTerminalOwnerOriginHeal,
  selfHealTerminalOwnerOriginIfStranded,
  type TerminalOwnerOriginHealReason,
} from './work-items-terminal-owner-origin-heal';
import { trackDetached } from './detached-imports';
import {
  ISSUE_FAMILY_ROUTE_KINDS,
  agentWorkCategoryWhereSql,
  audienceWhereSql,
  issueFamilyRouteSql,
  type WorkAudienceFilter,
} from './work-nature/agent-work-predicate';

/**
 * The FEATURE-family half of {@link getWorkItem} (its issue-family half is a bare
 * `getIssue`/`getIssueInWorkspace` call) — split out (EI-1545) so `claimWorkItem`
 * can reuse it directly instead of re-invoking the full `getWorkItem` (which would
 * redundantly re-run the issue-family lookup a claimer has already resolved).
 */
async function getFeatureWorkItemOnly(
  id: string,
  harness?: string,
  opts: WorkItemReadOptions = {},
  client?: ReturnType<typeof getOrgPg>['sql'],
): Promise<WorkItem | null> {
  const sql = client ?? getOrgPg().sql;
  // F-B3 (workspace-data-isolation-leaks): a bare WI/F id is unique only within a
  // (workspace, harness), not globally — scope to the active workspace so an id
  // collision across workspaces can't return the wrong row (getOrgPg bypasses RLS).
  const rows = await sql<FeatureRowDb[]>`
    SELECT ${sql.unsafe(projectWorkItemColumns(FEATURE_COLS, opts.payloadProjection))}
      FROM harness_shared.harness_features_consolidated
     WHERE feature_id = ${id}
       AND workspace_id = ${activeWorkspaceId()}
       AND ${harness ? sql`harness_slug = ${harness}` : sql`TRUE`}
     ORDER BY updated_ts DESC NULLS LAST
     LIMIT 1`;
  return rows[0] ? featureRowToWorkItem(rows[0]) : null;
}

export interface WorkItemDetail extends WorkItem {
  topics: string[];
  posts: ThreadPostRow[];
  /** Edges OUT of this work-item (e.g. blocks → feature|plan_item), excluding tag edges. */
  links: { rel: string; dst: ObjectRef }[];
}

/** The last-N slice of a work-item's thread, plus what frames it. */
export interface WorkItemThreadWindow {
  posts: ThreadPostRow[];
  /** TOTAL posts in the thread — from the same snapshot as `posts`. */
  total: number;
  /** Topic slugs this item is tagged into (areas, not messages). */
  topics: string[];
  /** The item's creation — the incident-start a topic read should be scoped to. */
  createdAt: string;
}

/**
 * The LAST `limit` posts of a work-item's thread, bounded, plus its total and topics.
 *
 * The bounded sibling of {@link getWorkItemDetail}, which reads a thread in FULL
 * because it backs a full render. This exists for cell resolvers and other hot
 * read paths, where pulling a 121-post thread to display 3 is the over-fetch the
 * performance doc lists — see PgThreadStore.listRecentPosts for why the count
 * rides the same query rather than a second one.
 *
 * ⚠ DISPATCHES BY FAMILY, exactly like {@link getWorkItemDetail} — and the reason
 * is a trap worth stating, because getting it wrong FAILS SILENTLY. The two
 * families use different ObjectRef namespaces and separate family-owned stores;
 * an issue ref sent to the feature store would look like an empty thread rather
 * than an error. Both stores resolve the active workspace dynamically, so a
 * feature comment written in a request-scoped workspace is read from that same
 * workspace rather than the legacy DEFAULT_COORD_WORKSPACE fallback.
 *
 * Returns null when the item does not exist — distinct from a real empty thread,
 * which returns `total: 0`.
 */
export async function getWorkItemThreadWindow(
  id: string,
  limit: number,
  harness?: string,
  // Seam for the dispatch guard — production always takes the real defaults, and
  // the real path is verified live rather than only through this seam.
  deps: {
    getWorkItem?: typeof getWorkItem;
    getIssueThreadWindow?: typeof getIssueThreadWindow;
  } = {},
): Promise<WorkItemThreadWindow | null> {
  const wi = await (deps.getWorkItem ?? getWorkItem)(id, harness);
  if (!wi) return null;
  // Issue-family: the correctly-scoped store lives in issues-engineer.
  if (wi.family === 'issue') return (deps.getIssueThreadWindow ?? getIssueThreadWindow)(id, limit);
  const ref = workItemObjectRef(wi);
  const [thread, topics] = await Promise.all([threads.getThreadByParent(ref), tags.listTags(ref)]);
  // No thread row at all is the DEFAULT for an item nobody has commented on
  // (threads are created on first post), not a failure — a real, measured zero.
  const window = thread
    ? await threads.listRecentPosts(thread.thread_id, limit)
    : { posts: [] as ThreadPostRow[], total: 0 };
  return { posts: window.posts, total: window.total, topics, createdAt: wi.createdAt };
}

/** A work-item plus its coord-substrate detail (topics, thread posts, outgoing links). */
export async function getWorkItemDetail(id: string, harness?: string): Promise<WorkItemDetail | null> {
  const wi = await getWorkItem(id, harness);
  if (!wi) return null;
  if (wi.family === 'issue') {
    const d = await getIssueDetail(id);
    return { ...wi, topics: d?.topics ?? [], posts: d?.posts ?? [], links: d?.links ?? [] };
  }
  const ref = workItemObjectRef(wi);
  const topics = await tags.listTags(ref);
  const thread = await threads.getThreadByParent(ref);
  const posts = thread ? await threads.listPosts(thread.thread_id) : [];
  const out = await blockingLinks.listOut(ref);
  return {
    ...wi,
    topics,
    posts,
    links: out.filter((l) => l.rel !== 'tagged').map((l) => ({ rel: l.rel, dst: l.dst })),
  };
}

/**
 * WI-41477: the work-item counterpart of `readVettingConsultCritique`
 * (consult/get-feedback-core.ts) — the scorecards:emit vetting gate's second
 * evidence channel. A LAUNCHED independent reviewer cannot post into a consult
 * (participants are router-assigned by consult:get_feedback), so critique
 * recorded per D-049 (learning-loop-backlog-triage-2026-08-22) lands as
 * work-item comments instead. Mirrors the consult predicate clause for clause:
 * only posts with a non-null author OUTSIDE `excludeAuthors` (the emitter and
 * the vetted rubric's author — the parties whose "critique" would be
 * self-review) count; distinct qualifying authors become the critics list.
 * Work-item threads have no 'decline' post kind, so there is no declinePosts
 * half and no waiver path on this channel — zero third-party comments simply
 * refuses at emit.
 */
export interface VettingWorkItemCritique {
  /** false ⇒ no such work-item: a dangling link, not an un-commented item. */
  exists: boolean;
  /** Third-party comments that constitute critique. */
  critiquePosts: number;
  /** Distinct authors of those comments, so the stamp can name the critics. */
  critics: string[];
}

export async function readVettingWorkItemCritique(
  id: string,
  excludeAuthors: readonly (string | null | undefined)[],
  harness?: string,
  // Seam for unit tests — production always takes the real default.
  deps: { getWorkItemDetail?: typeof getWorkItemDetail } = {},
): Promise<VettingWorkItemCritique> {
  const detail = await (deps.getWorkItemDetail ?? getWorkItemDetail)(id, harness);
  if (!detail) return { exists: false, critiquePosts: 0, critics: [] };
  const excluded = new Set(excludeAuthors.filter((a): a is string => typeof a === 'string' && a.length > 0));
  const critics = new Set<string>();
  let critiquePosts = 0;
  for (const post of detail.posts) {
    const author = post.author_id;
    if (!author || excluded.has(author)) continue;
    critiquePosts += 1;
    critics.add(author);
  }
  return { exists: true, critiquePosts, critics: [...critics].sort() };
}

/* The prose column width lives in `search/prose-vector-dims` (imported at the
 * top of this file). It used to be a hand-copied local const, justified because
 * importing embed-backfill's `EMBEDDER_DIM` would have pulled the whole embed
 * stack (configure/sidecar/admission) into this module's static graph. That
 * reason no longer applies: `prose-vector-dims` is a leaf module whose only
 * import is the dims declaration itself. The embedder is still dynamic-imported
 * inside the leg, for the original reason. */

/** Test seam for the P-008 semantic leg: the query-embedder resolver to use
 *  (defaults to the real `buildQueryEmbedderResolved`). Injectable because the
 *  real one lazy-loads an ONNX model — a unit test must never pay that. */
export type QueryEmbedderResolver = SharedQueryEmbedderResolver;

/**
 * Process-local query-embedder warm state for `searchWorkItems`.
 *
 * Keep this surface's warm latch in the shared helper so every interactive
 * prose search makes the same identity guarantee: the engine receives the
 * exact stamped embedder instance, or a throw-only signal while cold.
 */
const workItemEmbedderWarmup = createQueryEmbedderWarmup<SharedResolvedQueryEmbedder>({
  warmupText: 'work-items search embedder warmup',
  retryTokenPrefix: 'work-items-embedder-warmup',
  resolve: async () => {
    const { buildQueryEmbedderResolved } = await import('./agent-tools/search/embedder');
    return await buildQueryEmbedderResolved();
  },
  validate: (resolved) =>
    fitsProseColumns(resolved.dims)
      ? null
      : `query embedder dims ${resolved.dims} do not fit the prose embedding columns`,
  retryAfterMs: 1_000,
});

/**
 * Pre-warm the exact query embedder state used by `searchWorkItems`.
 *
 * The generic transcript-search warmup also exercises `buildQueryEmbedder`,
 * but `searchWorkItems` has a separate warm latch so it can report a truthful
 * retry receipt while a cold model loads. Boot must warm that latch, not merely
 * the shared model, or the first semantic dedup search still degrades.
 */
export async function warmWorkItemQueryEmbedder(resolver?: QueryEmbedderResolver): Promise<boolean> {
  return await workItemEmbedderWarmup.warm(resolver);
}

/** Test seam: clear process-local warm state between search-work-item cases. */
export function resetWorkItemEmbedderWarmup(): void {
  workItemEmbedderWarmup.reset();
}

/** Domain filters both work-item search sources honour — applied IN SQL, so the
 *  per-source `limit` is spent on rows that can actually be returned. */
interface WorkItemSearchFilters {
  harness?: string;
  /** Already narrowed to the source's own family by the caller (see `searchWorkItems`). */
  kind?: WorkItemKind;
  includeObservations?: boolean;
  /** P-010: see {@link ListWorkItemsFilter.natures}; same default (work only unless `kind`). */
  natures?: readonly DatatypeNature[];
}

/** Ranker/source labels. Stable — they appear in `legs.failures[].source`. */
const SOURCE_ISSUES = 'work_items_issues';
const SOURCE_FEATURES = 'work_items_features';

const searchExcerpt = (title: string, body: string | null): string =>
  `${title}${body ? ` — ${body}` : ''}`.slice(0, 200);

/**
 * `harness` is DERIVED on the issue family, not stored: the `engineer_issues`
 * view computes `scope` as `'harness:'||harness_slug` — except a blank or
 * `operator:%` slug, which becomes the literal `'operator'` — and
 * `harnessOfScope` reads the slug back out, returning null for `'operator'`.
 * So `WorkItem.harness === h` holds iff the base row's `harness_slug` is `h`
 * AND does not fall into that operator bucket. Stated in SQL here so the
 * filter runs BEFORE the row cap instead of on an already-truncated page.
 */
function issueHarnessClause(sql: OrgSql, harness: string) {
  return sql`(harness_slug = ${harness} AND harness_slug <> '' AND harness_slug NOT LIKE 'operator:%')`;
}

/**
 * work_items:search's semantic leg (generic-rag-chunking P-011, D-015): each item
 * ranked by the nearer of its own vector (title + first 2,000 characters) and its
 * window chunks, so an item whose only match lies past the cut is still found.
 * `parent` is the relation a family ranks over — the base table, or the
 * feature-family view, which keeps the base table's key names — and `filter` is
 * that family's scope, applied inside both legs before their LIMIT.
 */
async function workItemChunkLeg(
  pg: PgHandle,
  opts: {
    parent: ChunkSurface['parent'];
    filter: (sql: OrgSql) => Fragment;
    selection: ProseProfileSelection | null;
    qVec: string;
    limit: number;
    /** 'exact' for a family whose filter keeps a small slice (see featureSearchSource). */
    scan?: ChunkLegScan;
  },
): Promise<Array<{ id: string; title: string; body: string | null; score: number }>> {
  return withIterativeScan(pg, async (handle) => {
    const sql = handle as unknown as OrgSql;
    const space = (profile: string | null, mode: string | null) =>
      profile && mode ? proseProfilePredicateSql(sql, opts.selection, profile, mode) : sql`FALSE`;
    return sql<Array<{ id: string; title: string; body: string | null; score: number }>>`
      WITH best AS (${chunkAwareVectorLegSql(handle, {
        surface: { ...WORK_ITEMS_CHUNK_SURFACE, parent: opts.parent },
        parentAlias: 'w',
        qVec: opts.qVec,
        limit: opts.limit,
        mode: 'retrieve',
        scan: opts.scan ?? 'ann',
        parentFilter: opts.filter(sql),
        // D-011: the embedding-space rule stays here; the helper only names the
        // qualified columns. A missing column fails closed.
        spaceFilter: (cols) => space(cols.profileColumn, cols.modeColumn),
      })})
      SELECT w.feature_id AS id, w.title, w.summary AS body, 1 - b.distance AS score
        FROM best b
        JOIN ${sql.unsafe(opts.parent.table)} w
          ON w.harness_slug = b.harness_slug AND w.feature_id = b.feature_id
    ORDER BY b.distance, w.feature_id
       LIMIT ${opts.limit}`;
  });
}

/**
 * The issue-family `SearchSource` — ranked over the BASE table
 * `harness_shared.work_items`, not the `engineer_issues` view: the view is a
 * straight projection of that table (verified against `pg_get_viewdef`) and
 * the embedding columns live only on the base table, so ranking there lets
 * BOTH legs share one set of predicates. `feature_id` is the view's
 * `issue_id`, so `source_id` joins straight back through it at hydration.
 *
 * Ignores the engine's `workspaceId`/`scopeFilter` deliberately: the issue
 * family resolves its own workspace (`issuesScopeWorkspace()`), which is not
 * always `activeWorkspaceId()`, and harness scoping is a derived expression
 * rather than a column (see `issueHarnessClause`).
 */
function issueSearchSource(f: WorkItemSearchFilters, selection: ProseProfileSelection | null): SearchSource {
  const ws = issuesScopeWorkspace();
  const scoped = (sql: OrgSql) => sql`
          workspace_id = ${ws}
      AND item_kind IN ('bug', 'change', 'task')
      AND ${f.kind ? sql`item_kind = ${f.kind}` : sql`TRUE`}
      AND ${f.harness ? issueHarnessClause(sql, f.harness) : sql`TRUE`}
      AND ${f.includeObservations ? sql`TRUE` : sql`lane IS DISTINCT FROM 'observation'`}
      AND ${naturesAdmitWork(f.natures) ? sql`TRUE` : sql`FALSE`}`;
  const toListing = (
    rows: Array<{ id: string; title: string; body: string | null; score: number }>,
    ranker: string,
  ): Listing =>
    rows.map((r) => ({
      key: `${SOURCE_ISSUES}:${r.id}`,
      score: Number(r.score),
      row: {
        source: SOURCE_ISSUES,
        source_id: r.id,
        excerpt: searchExcerpt(r.title, r.body),
        highlight: r.title,
        score: Number(r.score),
        rankers: [ranker],
      },
    }));
  return {
    name: SOURCE_ISSUES,
    async lexical({ sql: pg, query, limit }: SearchSourceParams): Promise<Listing> {
      const sql = pg as OrgSql;
      // `ts_rank` (not `ts_rank_cd`) preserves the pre-migration ordering
      // exactly; no lexical floor is registered, so nothing downstream depends
      // on which of the two this is (see search/prose-min-score.ts).
      const rows = await sql<Array<{ id: string; title: string; body: string | null; score: number }>>`
        SELECT feature_id AS id, title, summary AS body,
               ts_rank(_search, websearch_to_tsquery('english', ${query})) AS score
          FROM harness_shared.work_items
         WHERE ${scoped(sql)}
           AND _search @@ websearch_to_tsquery('english', ${query})
      ORDER BY score DESC
         LIMIT ${limit}`;
      return toListing(rows, 'lexical');
    },
    ...(selection
      ? {
          async embedding({ sql: pg, limit, qVec }): Promise<Listing> {
            const rows = await workItemChunkLeg(pg, {
              parent: WORK_ITEMS_CHUNK_SURFACE.parent,
              filter: scoped,
              selection,
              qVec,
              limit,
            });
            return toListing(rows, 'embeddings');
          },
        }
      : {}),
  };
}

/**
 * The feature-family `SearchSource` over `harness_features_consolidated`.
 * `featureFamilyKindClause` keeps registered generic-kind datatypes visible
 * here exactly as it does for list/count.
 */
function featureSearchSource(f: WorkItemSearchFilters, selection: ProseProfileSelection | null): SearchSource {
  const ws = activeWorkspaceId();
  const scoped = (sql: OrgSql) => sql`
          ${featureFamilyKindClause(sql, ws, { includeDeprecatedChunk: f.kind === 'chunk' })}
      AND workspace_id = ${ws}
      AND ${f.kind ? sql`item_kind = ${f.kind}` : sql`TRUE`}
      AND ${f.harness ? sql`harness_slug = ${f.harness}` : sql`TRUE`}
      AND ${natureWhereSql(sql, f.natures, f.kind)}`;
  const toListing = (
    rows: Array<{ id: string; title: string; body: string | null; score: number }>,
    ranker: string,
  ): Listing =>
    rows.map((r) => ({
      key: `${SOURCE_FEATURES}:${r.id}`,
      score: Number(r.score),
      row: {
        source: SOURCE_FEATURES,
        source_id: r.id,
        excerpt: searchExcerpt(r.title, r.body),
        highlight: r.title,
        score: Number(r.score),
        rankers: [ranker],
      },
    }));
  return {
    name: SOURCE_FEATURES,
    async lexical({ sql: pg, query, limit }: SearchSourceParams): Promise<Listing> {
      const sql = pg as OrgSql;
      const rows = await sql<Array<{ id: string; title: string; body: string | null; score: number }>>`
        SELECT feature_id AS id, title, summary AS body,
               ts_rank(_search, websearch_to_tsquery('english', ${query})) AS score
          FROM harness_shared.harness_features_consolidated
         WHERE ${scoped(sql)}
           AND _search @@ websearch_to_tsquery('english', ${query})
      ORDER BY score DESC
         LIMIT ${limit}`;
      return toListing(rows, 'lexical');
    },
    ...(selection
      ? {
          async embedding({ sql: pg, limit, qVec }): Promise<Listing> {
            // The feature-family view is a straight projection of work_items
            // under the same key names, so it is the chunk leg's parent here.
            // 'exact' (generic-rag-chunking D-032): the family is about 2% of
            // work_items and of the surface's chunks, so an HNSW scan discards
            // about 20k rows per query to fill the LIMIT (131 ms measured on
            // 2026-09-30); ranking the filtered slice exhaustively does not.
            const rows = await workItemChunkLeg(pg, {
              parent: { table: 'harness_shared.harness_features_consolidated', key: WORK_ITEMS_CHUNK_SURFACE.parent.key },
              filter: scoped,
              selection,
              qVec,
              limit,
              scan: 'exact',
            });
            return toListing(rows, 'embeddings');
          },
        }
      : {}),
  };
}

/** Batch-hydrate feature-family rows by id (order is restored by the caller). */
async function featuresByIds(
  ids: string[],
  harness?: string,
  opts: WorkItemReadOptions = {},
): Promise<WorkItem[]> {
  if (ids.length === 0) return [];
  const { sql } = getOrgPg();
  const columns = projectWorkItemColumns(FEATURE_COLS, opts.payloadProjection);
  const rows = await sql<FeatureRowDb[]>`
    SELECT ${sql.unsafe(columns)}
      FROM harness_shared.harness_features_consolidated
       WHERE workspace_id = ${activeWorkspaceId()}
       AND ${harness ? sql`harness_slug = ${harness}` : sql`TRUE`}
       AND feature_id = ANY(${ids}::text[])`;
  return rows.map(featureRowToWorkItem);
}

/**
 * Batch-hydrate the unified work-item facade by id.
 *
 * The ordinary get path deliberately preserves its issue-first lookup semantics,
 * but a projected multi-id read should not repeat that two-table lookup once per
 * id. Under pool pressure six ids otherwise fan out to twelve independent reads
 * (issue lookup + feature fallback), which can exhaust the org pool before the
 * shared work_items:get budget expires. Keep this helper set-based: one issue
 * query, one feature query for ids not found in the issue family, then restore the
 * caller's order. The optional read projection is used by the completion-evidence
 * census and keeps the large JSONB payload narrow at the source.
 */
export async function getWorkItemsByIds(
  ids: string[],
  harness?: string,
  opts: WorkItemReadOptions = {},
): Promise<WorkItem[]> {
  if (ids.length === 0) return [];
  const uniqueIds = [...new Set(ids)];
  const issues = await issuesByIds(uniqueIds, opts);
  const byId = new Map<string, WorkItem>(issues.map((issue) => [issue.id, issueToWorkItem(issue)]));
  const featureIds = uniqueIds.filter((id) => !byId.has(id));
  const features = await featuresByIds(featureIds, harness, opts);
  for (const feature of features) byId.set(feature.id, feature);
  return ids.flatMap((id) => {
    const item = byId.get(id);
    return item ? [item] : [];
  });
}

/** The label this consumer's coverage verdict is reported under (WI-9393). */
const WORK_ITEM_SEARCH_COVERAGE_SOURCE = 'work_items:search';
/**
 * The vector surfaces this search actually reads — ONE, despite two families.
 *
 * VERIFIED against the catalog rather than assumed: the feature-family source
 * selects from `harness_shared.harness_features_consolidated`, which is a VIEW
 * (`pg_class.relkind='v'`) defined as
 *   `SELECT …, embedding, embedding_mode, … FROM harness_shared.work_items
 *      WHERE item_kind <> ALL (ARRAY['bug','change','task'])`
 * — the SAME physical table and the SAME `embedding` column the issue-family
 * source reads. So one surface honestly covers both legs.
 *
 * This is why the surface list is NOT the two-element union the call sites
 * suggest. `assessSurfaceCoverage` resolves a multi-surface list to its BEST
 * leg (the P-034 parent+chunk union, where a row is findable if EITHER carries
 * its vector). That is the wrong operator for two INDEPENDENT corpora — it
 * would report the healthier table and mask a blind one. Here the question does
 * not arise, because there is only one table.
 *
 * The view is a filtered SUBSET, so a table-level percentage is strictly an
 * approximation for the feature leg; measured 2026-09-05 the split is immaterial
 * (feature-family 3470/3520 = 98.6%, issue-family 166798/173392 = 96.2%, table
 * 96.3%). Re-measure before relying on that if the families ever diverge.
 */
const WORK_ITEM_SEARCH_SURFACES = ['harness_shared.work_items.embedding'] as const;

/** What a work-item search reports — the matches AND how they were ranked. */
export interface WorkItemSearchResult {
  items: WorkItem[];
  /**
   * P-020: which ranking legs actually ran and what each contributed to
   * fusion. Surfaced rather than discarded on purpose — a `work_items:search`
   * that silently degraded to lexical-only (embedder down, embeddings not
   * backfilled, a floor calibrated for another space) is otherwise
   * indistinguishable from a healthy one, which is the failure this whole
   * plan exists to remove. Read `legs.degraded`, never `embedderAvailable`.
   */
  legs: SearchLegs;
  /** P-017: which engine-level ranking defaults were in force for this search. */
  applied: AppliedDefaults;
  /**
   * WI-9393 / D-018: whether the CORPUS this search ranked against is actually
   * embedded — the other half of the honesty `legs` above provides.
   *
   * `legs` answers "did the semantic leg RUN"; it cannot answer "did it run over
   * a fully-embedded corpus". The docstring on `legs` already names "embeddings
   * not backfilled" as a degradation it exists to expose, but a leg that runs
   * perfectly against a 60%-embedded table reports `status:'ran'` and looks
   * healthy — which is exactly the silent miss this field closes.
   *
   * Absent when the semantic leg was never wanted (a deliberate lexical-only
   * search is healthy, not un-assessed) and when the assessment could not be
   * attempted at all. An `unknown` verdict is the distinct statement "we looked
   * and the sampler knows nothing" — never collapse the two.
   */
  coverage?: SourceCoverageAssessment;
  /**
   * A stable, process-local retry receipt while the query embedder is warming.
   * The lexical result remains usable for availability, but callers must not
   * treat a degraded zero-hit page as a verified dedup miss. The token is
   * shared by concurrent searches in the same warmup flight, so a caller can
   * retry once after `afterMs` without creating a duplicate warmup request.
   */
  retry?: {
    token: string;
    afterMs: number;
    reason: 'query_embedder_warming';
  };
}

/** Cross-kind hybrid search over both kind-tables (parity with issues:search).
 *
 * P-016: runs on `@papercusp/search`'s `runHybridSearch` rather than the
 * hand-rolled legs this used to carry, so it inherits every engine-level
 * guarantee by EXISTING instead of by hand-propagation — the P-017 minScore
 * floor, the P-020 per-leg execution report, and whatever lands next.
 *
 * Three things measurably change, all of them fixes:
 *
 *  1. **The legs are FUSED (RRF), not concatenated.** The old shape ran the
 *     lexical legs, then appended de-duplicated semantic hits to the END of
 *     the list — so a rank-1 semantic match (the rephrased query this leg
 *     exists to serve) landed below every weak lexical match, and was cut
 *     entirely whenever the lexical legs already filled `limit`.
 *  2. **The filters run in SQL.** The issue leg used to call
 *     `searchIssues(query, limit)`, which takes no filters, and then drop
 *     rows in JS for harness / kind / observation-lane. Those rows had
 *     already consumed the row cap, so a harness-scoped search could return
 *     far fewer than `limit` — or nothing — while matches existed. The
 *     observation lane alone is ~44% of issue-family rows.
 *  3. **The embedding leg is floored.** Measured on this corpus
 *     (gemma@768, real query→doc direction, 2026-08-04): in-domain top-10
 *     similarity ran 0.5808–0.7359 against off-domain 0.4265–0.5423, so the
 *     registered 0.45 floor sits below every in-domain hit observed and
 *     removes part of the off-domain tail. It is a noise reducer here, not a
 *     classifier — see search/prose-min-score.ts.
 *
 * Still strictly fail-open: no embedder / no embedding column / a throwing
 * leg degrades to what the other legs found, and now SAYS SO in `legs`. The
 * semantic leg still defaults OFF under vitest (an implicit ONNX load in an
 * unrelated test is the WI-3792 load-scar class) — pass `semantic: true`.
 */
export async function searchWorkItems(
  query: string,
  opts: {
    harness?: string;
    kind?: WorkItemKind;
    /**
     * Restrict to ONE family without also pinning an exact `kind`.
     *
     * `kind` could already narrow the family, but only by fixing the kind too —
     * so "every feature-family row" (feature + chunk + any workspace-registered
     * generic kind) was previously inexpressible: you got one exact kind, or
     * both families. `family: 'feature'` is exactly the predicate the
     * `harness_features_consolidated` compat view applies
     * (`item_kind <> ALL('bug','change','task')`, i.e. {@link familyOf}), which
     * is what lets a caller searching that view delegate here without changing
     * which rows it can see.
     *
     * Composes with `kind` by INTERSECTION; a contradictory pair
     * (`family:'feature', kind:'bug'`) selects no sources and returns no
     * matches rather than silently widening to one of them.
     */
    family?: WorkItemFamily;
    limit?: number;
    /** Default on (off under VITEST); `false` = lexical-only. */
    semantic?: boolean;
    /** Test seam — see QueryEmbedderResolver. */
    embedderResolver?: QueryEmbedderResolver;
    /**
     * EI-10422/WI-4405: by default a `lane === 'observation'` row is EXCLUDED
     * from matches (D-005 — it never enters the work queue/triage). Pass true to
     * include raw observations in search results.
     */
    includeObservations?: boolean;
    /** P-010 / D-011: nature set to match; unset → nature 'work' only unless `kind` is named. */
    natures?: readonly DatatypeNature[];
    /**
     * Test seam for the WI-9393 coverage assessment, mirroring `embedderResolver`.
     * Injecting it also OPTS IN under vitest, where the assessment is otherwise
     * inert (see `loadWorkItemSearchCoverage`).
     */
    loadCoverage?: () => Promise<CoverageSnapshot>;
  } = {},
): Promise<WorkItemSearchResult> {
  const limit = Math.min(opts.limit ?? 50, 200);
  // `family` and `kind` intersect: each may independently rule a family out,
  // and neither may add one back. Written as one predicate so the two filters
  // cannot drift apart the way two hand-maintained booleans would.
  const kindFamily = opts.kind ? familyOf(opts.kind) : null;
  const wants = (f: WorkItemFamily): boolean =>
    (!opts.family || opts.family === f) && (!kindFamily || kindFamily === f);
  const wantFeature = wants('feature');
  const wantIssue = wants('issue');
  const filters: WorkItemSearchFilters = {
    ...(opts.harness ? { harness: opts.harness } : {}),
    // The caller picks the sources by family, so a `kind` reaching a source is
    // always one that source can match.
    ...(opts.kind ? { kind: opts.kind } : {}),
    ...(opts.includeObservations ? { includeObservations: true } : {}),
    ...(opts.natures && opts.natures.length > 0 ? { natures: opts.natures } : {}),
  };

  // Resolve the query embedder BEFORE building the sources: its mode is the
  // embedding SPACE each vector leg must restrict to (cosine across spaces is
  // noise, not a weaker match), and a resolver that yields nothing simply
  // leaves the sources without an `embedding` method — which the engine then
  // reports as a semantic leg that never ran, rather than one that found
  // nothing. Failing to resolve is never an error (fail-open).
  let embedder: ((t: string) => Promise<number[]>) | null = null;
  let embeddingSelection: ProseProfileSelection | null = null;
  let retry:
    | {
        token: string;
        afterMs: number;
        reason: 'query_embedder_warming';
      }
    | undefined;
  if (opts.semantic ?? !process.env.VITEST) {
    /**
     * The semantic leg was WANTED. If it cannot run, hand the engine an
     * embedder that rejects with the reason rather than `null`.
     *
     * This is not a trick — it is the only way to say the true thing with the
     * engine's own vocabulary. `embedder: null` means "no semantic leg was
     * ever wanted" and reports `status: 'not-run'`, which `summariseLegs`
     * deliberately does NOT flag as degraded (an intentionally lexical-only
     * search is healthy). A dead embedder reported that way would therefore
     * be indistinguishable from `semantic: false` — the precise silent
     * degradation this plan exists to remove. A rejecting embedder instead
     * sets `legs.semantic.blocked = 'query embed failed: <reason>'`, which
     * IS flagged, and carries the reason to the caller.
     */
    const selection = workItemEmbedderWarmup.select(opts.embedderResolver);
    embedder = selection.embedder;
    embeddingSelection = selection.resolved?.profile
      ? resolveProseProfileSelection(selection.resolved.mode, selection.resolved.profile)
      : null;
    retry = selection.retry;
  }

  const sources: SearchSource[] = [
    ...(wantIssue ? [issueSearchSource(filters, embeddingSelection)] : []),
    ...(wantFeature ? [featureSearchSource(filters, embeddingSelection)] : []),
  ];
  const { sql } = getOrgPg();
  const { results, legs, applied } = await runHybridSearch(sources, {
    sql,
    query,
    // Each source resolves its own workspace + harness scoping (the two
    // families do not share one), so the engine's are non-filtering here.
    workspaceId: '',
    scopeFilter: null,
    limit,
    mode: 'hybrid',
    embedder,
    // Bound the per-query embed the way every other interactive surface does:
    // a dedup-before-filing search must not be able to turn a ~20ms lexical
    // read into a multi-second wait on a cold or degraded embedder.
    embedTimeoutMs: WORK_ITEM_EMBED_TIMEOUT_MS,
  });

  // Hydrate the fused ids back to full rows in ONE read per family, then
  // restore the fused order (the engine's neutral SearchHit deliberately does
  // not carry a domain row).
  const issueIds = results.filter((r) => r.source === SOURCE_ISSUES).map((r) => r.source_id);
  const featureIds = results.filter((r) => r.source === SOURCE_FEATURES).map((r) => r.source_id);
  const [issueRows, featureRows] = await Promise.all([
    issueIds.length ? issuesByIds(issueIds).then((rows) => rows.map(issueToWorkItem)) : Promise.resolve([]),
    featuresByIds(featureIds),
  ]);
  const byId = new Map<string, WorkItem>();
  for (const w of [...issueRows, ...featureRows]) byId.set(w.id, w);
  const items = results.map((r) => byId.get(r.source_id)).filter((w): w is WorkItem => w !== undefined);

  // WI-9393 / D-018. DELIBERATELY after the search and in its own try/catch: coverage is
  // a diagnostic ABOUT the ranking, so it must never be able to cost a caller a result.
  //
  // Assessed ONLY when the semantic leg was wanted. A deliberate lexical-only search is
  // healthy — the same reason `summariseLegs` does not flag `status:'not-run'` as
  // degraded — so attaching a corpus verdict to one would be noise rather than honesty.
  let coverage: SourceCoverageAssessment | undefined;
  if (embedder !== null) {
    try {
      const snapshot = await loadWorkItemSearchCoverage(opts.loadCoverage);
      // `null` = do not assess at all (no key). An EMPTY map is the DIFFERENT statement
      // "we looked and the sampler knows nothing", which the shared logic renders as
      // `unknown`. Collapsing the two would make a skipped assessment read as a measured
      // one; keep them distinct exactly as the dupe guard does.
      if (snapshot !== null) {
        coverage = assessSurfaceCoverage(WORK_ITEM_SEARCH_COVERAGE_SOURCE, WORK_ITEM_SEARCH_SURFACES, snapshot);
      }
    } catch {
      // Leave undefined: not assessed. Never a hand-written verdict object, which could
      // drift from the shared logic that owns what healthy/degraded/unknown mean.
    }
  }

  return {
    items,
    legs,
    applied,
    ...(coverage ? { coverage } : {}),
    ...(retry ? { retry } : {}),
  };
}

/** The snapshot for {@link WORK_ITEM_SEARCH_SURFACES}. A failed READ yields an EMPTY
 *  map, which `assessSurfaceCoverage` already renders as `unknown` — never as healthy.
 *  `null` means "do not assess at all", which is a different statement entirely. */
async function loadWorkItemSearchCoverage(seam?: () => Promise<CoverageSnapshot>): Promise<CoverageSnapshot | null> {
  if (seam) {
    try {
      return await seam();
    } catch {
      return new Map();
    }
  }
  // Inert under vitest unless a test injects the seam. `searchWorkItems` already holds an
  // org PG handle, so this is not about affording the connection — it is that adding an
  // always-present result key silently broke a pre-existing whole-result assertion when
  // the dupe guard was wired (consumer A), and the honest fix there was to leave existing
  // test paths untouched rather than to loosen their assertions.
  if (process.env.VITEST) return null;
  try {
    const { loadCoverageSnapshotCached } = await import('./search/coverage-gate');
    const { sql } = getOrgPg();
    return await loadCoverageSnapshotCached(sql, activeWorkspaceId());
  } catch {
    return new Map();
  }
}

// ── Writes ─────────────────────────────────────────────────────────────────────────
export interface CreateWorkItemInput {
  /** Internal caller-reserved identity for a replayable create. Ordinary
   * public creates omit it and use next_work_item_id(). */
  id?: string;
  kind: WorkItemKind;
  title: string;
  /** Free-text body/summary (issue body, feature summary). */
  summary?: string;
  harness?: string;
  severity?: IssueSeverity; // issue-family
  parent?: string; // parent work-item id (feature-family chunk or issue-family duplicate/child)
  payload?: unknown; // kind-specific data (feature-family + issue-family `task`)
  topics?: string[];
  /**
   * Explicit target workspace (EI-728). Feature-family items omit `workspace_id`
   * and let the `fill_workspace_id_from_projects` BEFORE-INSERT trigger derive it
   * from the harness's `projects` row (fallback 'default'). When the request
   * carries a workspace (the MCP `?workspace=` / an explicit `workspace` arg /
   * the hive's own workspace), pass it here so the write lands there instead of
   * silently falling back to 'default' when the projects lookup misses — the
   * trigger fills ONLY when workspace_id is NULL/'', so a provided value wins.
   * Omit (or pass '*'/'') to keep the trigger-derived default behavior.
   */
  workspaceId?: string;
  createdBy?: string;
  /**
   * ATOMIC create+claim (loop-routines P-007 / D-008, B-LOOP-4): the agent id to
   * assign the new item to AT CREATION, in the same DB write — no separate claim,
   * no create→claim race window. General: any agent id (self-assign = own id; a
   * Queen create+place onto a bee = the bee's id). Honored for BOTH families —
   * feature-family stamps `taken_by`/`taken_at` in the INSERT, issue-family writes
   * the `assignee` column (collapse-delegate: the delegate session). Omit ⇒ the
   * item lands unclaimed (the prior default).
   */
  assignee?: string;
  /** Durable delegator (collapse-delegate D-002). Issue-family only (the
   *  feature table has no assigned_by column). */
  assignedBy?: string;
  /**
   * URGENT enqueue (swarm-coordination P-006/D-005): wake the Pot operator (the
   * brain) immediately instead of waiting out its slow cadence. Floor-debounced +
   * coalesced (a burst of urgent creates collapses to one wake); fire-and-forget
   * (the create never fails because the wake path failed). Enqueue-time wake
   * semantics only — nothing durable is stamped on the item (severity/rank are
   * the durable priority surfaces).
   */
  urgent?: boolean;
  /**
   * Source plan provenance (queen-steering-panel-2026-06-15 P-008): the plan slug
   * this work-item was minted FROM — set at plan-item→work_item conversion
   * (`convertPlanItem`). Written to the indexed `source_plan_slug` column for both
   * families so plan-scoped placement and completion can identify the source lane.
   * Issue-family rows reach the same base columns through `createIssue`; feature-family
   * rows write them directly. Omit ⇒ unplanned/standalone work
   * (`source_plan_slug` stays NULL).
   */
  sourcePlanSlug?: string | null;
  /** Plan-item ids covered by this work-item; paired with sourcePlanSlug for both families. */
  sourcePlanItemIds?: string[] | null;
  /**
   * Owner-directive provenance (directive-visibility-and-ownership-2026-09-22, P-005):
   * `harness_shared.owner_directives.id` this work-item was created to carry out.
   *
   * Deliberately the SAME SHAPE as `sourcePlanSlug` above — "where did this
   * work-item come from" — rather than a new linking surface. The reference is
   * LATE-BINDING and one-directional: the directive exists first and cannot know
   * what it will spawn, so the work-item points back and the directive row is
   * never written after capture (D-005). Omit ⇒ NULL, which is the DEFAULT and
   * the common case, not a degenerate one: a directive is visible and actionable
   * long before any work-item exists.
   */
  directiveRef?: number | null;
  /** Feature-family design lifecycle copied from accepted-spec provenance. */
  needsDesign?: boolean;
  designStatus?: WorkItemDesignStatus | null;
  /** Canonical `harness_design_artifacts.id` pointer used by get_accepted_spec. */
  designSpecId?: string | null;
  discardedDesignWork?: boolean;
  /**
   * ADMISSION GATE (plan work-queue-admission-and-bulk-dedup-2026-08-24, P-002) — the
   * state this item is BORN with. 'pending' = born-pending, invisible to claim/place
   * until the promoter judges it (duplicate screening only, never merit); 'auto' = a
   * filing-time bypass the caller can justify (plan-promoted / critical severity).
   * Omit ⇒ the column stays NULL, which {@link isAdmitted} reads as admitted — the
   * pre-gate back-compat default that keeps every direct caller working unchanged.
   *
   * STAMPED IN THE INSERT FOR BOTH FAMILIES, never as a post-create UPDATE. A
   * create-then-demote sequence leaves the row admitted and claimable in the gap
   * between the two writes, which is precisely the race born-pending exists to close.
   */
  admission?: BornAdmission | null;
  /** WHY it was admitted at filing time (e.g. 'bypass:source-plan-slug'). Recorded on
   *  `admitted_by`; ignored for 'pending', which nobody has admitted yet. */
  admittedBy?: string | null;
  /** Internal-only migration/test escape hatch for reconstructing old chunk rows. */
  allowDeprecatedChunk?: boolean;
}

/** Fire the urgent brain wake for an urgent enqueue (P-006). Lazy import +
 *  fire-and-forget: same pattern as the settled-events emit — a wake-path
 *  failure must never break the write. */
function maybeFireUrgentWake(input: CreateWorkItemInput, wi: WorkItem): void {
  if (!input.urgent) return;
  void trackDetached(import('./pot/urgent-wake'))
    .then((m) =>
      m.requestUrgentPotWake({
        reason: `urgent work_item ${wi.id} (${wi.kind}) enqueued: ${wi.title}`,
        harness: wi.harness,
      }),
    )
    .catch(() => {});
}

/**
 * Fire `work-item:claimed:<id>` for an ATOMIC create+claim (loop-routines P-007 /
 * D-008, B-LOOP-4): when `createWorkItem` was given an `assignee`, the row lands
 * already-claimed, so emit the SAME awaited-event `claimWorkItem` fires — a
 * Queen→bee place (or any `events:await` leg on the claim) observes it identically
 * to a separate claim. Lazy import (work-items-events imports this module
 * statically) + fire-and-forget: an emit-path failure must never break the write.
 */
function maybeFireClaimedEvent(assignTo: string | null, wi: WorkItem): void {
  if (!assignTo) return;
  void trackDetached(import('./work-items-events')
    .then((m) => m.emitWorkItemClaimedEvent(wi, assignTo)))
    .catch(() => {});
}

/** Arm only the concrete claim/blocker edges D-018 permits; callers fail soft. */
export async function armWorkItemHolderInterests(
  wi: WorkItem,
  ownerId: string,
): Promise<import('./interest-auto-arm').InterestAutoArmHandle | undefined> {
  try {
    const { holderBlockerInterestEventKeys, reconcileInterestEventAwaits, retireInterestEventAwaits } =
      await import('./interest-auto-arm');
    // `claim:released:<id>` is for a delegator/leader waiting for this holder to
    // put the item back in the pool. The holder itself must never await that key:
    // only the sleeping holder can release its own claim, so this is a guaranteed
    // self-deadlock. Retire stale registrations left by the pre-fix path too.
    await retireInterestEventAwaits({ kind: 'work-item-claim', ref: wi.id }, ownerId);
    const blockers = await readUnresolvedDepBlockers(wi.id, wi.harness ?? undefined);
    const blockerIds = blockers.map(({ ref }) => ref.slice(ref.lastIndexOf('#') + 1));
    const blocked = await reconcileInterestEventAwaits({
      ownerId,
      eventKeys: holderBlockerInterestEventKeys(wi.id, blockerIds),
      boundTo: { kind: 'work-item-blocked', ref: wi.id },
      note: `blocked-item-holder auto-arm for ${wi.id}`,
    });
    return blocked;
  } catch {
    return undefined;
  }
}

/**
 * Fire `work-item:created[:<severity>]` for EVERY new work item (EI-8296) —
 * lazy import (work-items-events imports this module statically) +
 * fire-and-forget: an emit-path failure must never break the create.
 */
function maybeFireCreatedEvent(wi: WorkItem): void {
  // P-007: emitWorkItemCreatedEvent internally co-fires the canonical
  // `work-item:claimable` key for an unclaimed-claimable create — one hook here.
  void trackDetached(import('./work-items-events')
    .then((m) => m.emitWorkItemCreatedEvent(wi)))
    .catch(() => {});
}

/** Create a work-item of any kind, minting a kind-independent WI-NNN id (D-008). */
export async function createWorkItem(input: CreateWorkItemInput): Promise<WorkItem> {
  // Public chunk creation is retired. Historical rows remain readable through
  // the feature-family read union; only explicitly marked migration/fixture
  // writes may reconstruct one, and ordinary producers fail before allocation.
  if (isDeprecatedWorkItemKind(input.kind) && input.allowDeprecatedChunk !== true) {
    throw new Error(
      "work_item kind 'chunk' is deprecated and cannot be created; use a feature or change work-item. " +
        'Existing chunk rows remain readable for history and compatibility.',
    );
  }
  // P-001 generic-kind: accept a built-in kind OR a workspace-registered generic-kind
  // datatype (familyOf maps it to the feature family → the feature table). The
  // work_items:create gate (_create-core) already validated this, but createWorkItem is
  // also a direct entry point, so it re-checks the registry rather than hard-rejecting —
  // the live gap that let the gate pass an instance the insert then refused.
  if (!isWorkItemKind(input.kind)) {
    const registered = input.workspaceId
      ? await hasGenericKind(getOrgPg().sql, input.workspaceId, input.kind).catch(() => false)
      : false;
    if (!registered) throw new Error(`unknown work_item kind '${input.kind}'`);
  }
  const explicitId = input.id?.trim();
  if (input.id !== undefined && (!explicitId || explicitId.length > 120)) {
    throw new Error('createWorkItem: explicit id must be 1-120 characters');
  }
  // WI-10003631: the feature family allocates its id concurrently with the pot
  // resolution below (independent autocommit reads, one latency instead of two).
  let id: string;

  // ATOMIC create+claim (loop-routines P-007 / D-008, B-LOOP-4): a non-empty
  // `assignee` makes the row land already-claimed by that agent — no separate
  // claim call, no create→claim race window (a competing claim_next can't grab the
  // row in the gap). Issue-family claims via createIssue's assignee/assigned_by
  // columns; feature-family stamps taken_by/taken_at in the INSERT below. A
  // freshly-created row is origin='local' ⇒ always admissible, so no auditor guard.
  // A pending row cannot be born already claimed: that would bypass the promoter
  // inside the INSERT even though every later claim door correctly refuses it.
  const requestedAssignee = typeof input.assignee === 'string' && input.assignee.trim() ? input.assignee.trim() : null;
  const assignTo = input.admission === 'pending' ? null : requestedAssignee;

  if (familyOf(input.kind) === 'issue') {
    id = explicitId ?? await nextWorkItemId();
    const issue = await createIssue({
      id,
      kind: input.kind as IssueStoreKind,
      title: input.title,
      body: input.summary ?? '',
      severity: input.severity,
      scope: input.harness ? harnessScope(input.harness) : 'operator',
      topics: input.topics,
      createdBy: input.createdBy,
      assignee: assignTo ?? undefined,
      assignedBy: assignTo ? input.assignedBy : undefined,
      parent: input.parent,
      payload: input.payload,
      sourcePlanSlug: input.sourcePlanSlug,
      sourcePlanItemIds: input.sourcePlanItemIds,
      // P-002: the born-admission rides in createIssue's own INSERT (which reaches the
      // base columns through the engineer_issues INSTEAD OF trigger as of migration
      // 946) — never a post-create UPDATE from here, which would leave the row
      // admitted and claimable between the two writes.
      admission: input.admission,
      admittedBy: input.admittedBy,
    });
    const created = issueToWorkItem(issue);
    // EI-18654138087054247: createIssue tags the coord topic store, which the
    // claim-spec evaluator does not read — mirror each topic into `payload.tags`
    // so a created-with-topics item is claim-admissible, not just create-time
    // admissible (the asymmetry that produced "worked a minute ago, now
    // fleet_scope_violation").
    for (const topic of input.topics ?? []) {
      await mirrorTopicTagToClaimTags(created, topic);
    }
    if (assignTo) created.interestWatch = await armWorkItemHolderInterests(created, assignTo);
    maybeFireUrgentWake(input, created);
    maybeFireClaimedEvent(assignTo, created);
    maybeFireCreatedEvent(created);
    return created;
  }

  // feature-family — harness-scoped row in harness_features_consolidated.
  // unified-work-item-ledger P-001: reject a blank/whitespace harness too (not just
  // a missing one), so a feature can never land with an empty harness_slug.
  if (!input.harness || !input.harness.trim()) {
    throw new Error(`work_item kind '${input.kind}' requires a non-empty harness`);
  }
  const { sql } = getOrgPg();
  const now = Date.now();
  // workspace_id (workspace-data-isolation P-002 / dogfood fix): RESOLVE it here and
  // ALWAYS write it explicitly — do NOT leave it NULL for the fill_ws_features_trg
  // BEFORE-INSERT trigger. That trigger's lookup hits only the sparse `projects` table
  // and then falls back to 'default', stranding fleet work-items in a workspace the READ
  // path never reads (confirmed dogfood: 168/661 rows in 'default', invisible to the
  // operator's queue). Precedence:
  //   1. an explicit workspace (EI-728 — the '*' SU-wildcard is treated as "none")
  //   2. else activeWorkspaceId() — the operator's OWN active workspace, which is EXACTLY
  //      the scope every work-item READ path uses (claimNextWorkItem / listWorkItems /
  //      getWorkItem all scope by activeWorkspaceId()). Writing here guarantees the item
  //      is visible to the queue — never the trigger's stale 'default'.
  // Positional $N::jsonb is the operator's proven jsonb write on the org pool
  // (prepare:false mis-binds sql.json()).
  const explicitWs =
    typeof input.workspaceId === 'string' && input.workspaceId.trim() && input.workspaceId !== '*'
      ? input.workspaceId.trim()
      : null;
  const resolvedWs = explicitWs ?? activeWorkspaceId();
  // pot-membership-enforcement-2026-07-20 (P-005): a feature-family row must belong to
  // a REAL Pot (owner directive — 2026-07-20 11:21). Resolve input.harness against
  // harness_shared.pots: canonicalize + collapse a member harness to its Pot home; an
  // explicit made-up slug is REJECTED (PotMembershipError propagates to the caller).
  // Flag-gated (default ON); fails open (keeps input.harness) for an un-potted workspace.
  let featureHarness = input.harness;
  const featureRawHarness = input.harness;
  const [allocatedId, pot] = await Promise.all([
    explicitId ? Promise.resolve(explicitId) : nextWorkItemId(),
    (async () => (await getFlag(FLAGS.POT_MEMBERSHIP_ENFORCEMENT, 'system'))
      ? resolveWorkItemPot({ rawSlug: featureRawHarness, workspaceId: resolvedWs })
      : null)(),
  ]);
  id = allocatedId;
  if (pot) featureHarness = pot;
  // queen-steering-panel P-008: stamp the source plan slug so the Queen's survey can
  // HARD-filter the frontier by owner eligible-plans. source_plan_slug is ALWAYS written
  // (NULL when unplanned — the column is nullable). workspace_id is now ALSO always
  // written (the resolvedWs above) so the leaky trigger never decides it. The text params cast ::text — the org pool
  // runs prepare:false, so a bare trailing param leaves the server unable to infer its
  // type ("could not determine data type of parameter $N"), same as the $6::jsonb cast.
  const sourcePlanSlug =
    typeof input.sourcePlanSlug === 'string' && input.sourcePlanSlug.trim() ? input.sourcePlanSlug.trim() : null;
  const sourcePlanItemIds = Array.isArray(input.sourcePlanItemIds)
    ? input.sourcePlanItemIds
        .filter((itemId): itemId is string => typeof itemId === 'string' && itemId.trim().length > 0)
        .map((itemId) => itemId.trim())
    : null;
  // The fixed base columns/values (params $1..$12). $6 jsonb, $11 text, and $12
  // text[] carry explicit casts because the org pool runs prepare:false (a bare
  // param leaves the server unable to infer its type). The two INDEPENDENT optionals — taken_by/
  // taken_at (B-LOOP-4 atomic claim) and workspace_id (EI-728) — are appended in a
  // fixed order with each param index computed off `params.length`, so they never
  // collide on a positional slot regardless of which (or both) is present.
  const params: (string | number | string[] | boolean | null)[] = [
    featureHarness,
    id,
    input.title,
    input.summary ?? null,
    input.kind,
    input.payload != null ? JSON.stringify(input.payload) : null,
    input.parent ?? null,
    now,
    now,
    now,
    sourcePlanSlug,
    sourcePlanItemIds,
  ];
  const cols = [
    'harness_slug',
    'feature_id',
    'title',
    'summary',
    'status',
    'attempts',
    'item_kind',
    'payload',
    'parent_id',
    'needs_human_review',
    'ts',
    'created_ts',
    'updated_ts',
    'source_plan_slug',
    'source_plan_item_ids',
  ];
  const vals = [
    '$1',
    '$2',
    '$3',
    '$4',
    // work-item-status-full-unify P-004/P-005: a fresh feature-family row lands at the
    // UNIFIED claimable token 'open' (was 'todo'). 'open' is the single claimable status
    // across both families now, and the narrowed claim floor (['open']) only admits it —
    // writing 'todo' here would strand every new feature. Paired with the floor narrow so
    // the create-path and the claim floor stay consistent (no starvation window).
    `'open'`,
    '0',
    '$5',
    // WI-5343: `::text::jsonb`, NOT a bare `::jsonb` cast — params[5] is already a
    // JSON-encoded STRING (JSON.stringify(input.payload) below), and postgres.js's
    // parameter serializer infers the bind param's OID from this cast (jsonb) and
    // JSON.stringifies whatever JS value it's given for that OID REGARDLESS of the
    // value's own JS type — so a bare `::jsonb` here double-encodes an
    // already-stringified payload into a jsonb SCALAR STRING (e.g. `"{\"a\":1}"`)
    // instead of the jsonb OBJECT `{"a":1}`. Every other jsonb write in this file
    // that binds a pre-stringified JSON string via a placeholder already routes
    // through this exact `::text::jsonb` double-cast (see e.g. the `${patch}::text::jsonb`
    // / `${history}::text::jsonb` sites below) — casting the bind param to `text` first
    // defeats postgres.js's jsonb auto-serialization (the inferred OID becomes `text`,
    // sent as plain text, and Postgres itself performs the text→jsonb parse via the
    // explicit `::jsonb` cast). This path was the one write site missing it: because
    // pre-WI-5343 no caller ever created a feature-family item WITH a payload (the
    // original P-020 migration comment assumed payload was "NULL for features"), the
    // corruption was never observed — every feature's `payload._claimHold` /
    // `payload.plan_item` tag silently round-tripped as an opaque scalar string, so
    // every `payload ->> 'x'` / `payload ? 'x'` read (incl. claimFloorsWhereSql's
    // pre-existing _claimHold floor) against a feature created with a payload here
    // ALWAYS evaluated as if the payload were empty.
    '$6::text::jsonb',
    '$7',
    'FALSE',
    '$8',
    '$9',
    '$10',
    '$11::text',
    '$12::text[]',
  ];
  params.push(input.needsDesign ?? false, input.designStatus ?? null, input.designSpecId ?? null, input.discardedDesignWork ?? false);
  cols.push('needs_design', 'design_status', 'design_spec_id', 'discarded_design_work');
  vals.push(
    `$${params.length - 3}::boolean`,
    `$${params.length - 2}::text`,
    `$${params.length - 1}::text`,
    `$${params.length}::boolean`,
  );
  if (assignTo) {
    // Atomic create+claim: stamp the owner + lease time in the SAME INSERT (mirrors
    // claimWorkItem's `taken_by = …, taken_at = now()`), so the row is never
    // momentarily unclaimed for a competing claim_next to steal.
    params.push(assignTo);
    cols.push('taken_by', 'taken_at');
    vals.push(`$${params.length}::text`, 'now()');
  }
  // ADMISSION GATE (P-002) — stamped in THIS INSERT, for the same reason taken_by is:
  // the row must never exist in an admitted state it is about to be demoted out of.
  // Appended with the same params.length-computed indices as the optionals above, so
  // it cannot collide with a positional slot regardless of which others are present.
  // Omitted entirely when the caller passes no admission, leaving the column NULL =
  // admitted (pre-gate back-compat) rather than writing a value nobody asked for.
  const bornAdmission: BornAdmission | null = input.admission ?? null;
  if (bornAdmission) {
    params.push(bornAdmission);
    cols.push('admission');
    vals.push(`$${params.length}::text`);
    // A 'pending' row has been admitted by nobody: leaving admitted_at/admitted_by
    // NULL is what lets the promoter (and the stats ledger) tell an unjudged item
    // apart from one a filing-time bypass already cleared.
    if (bornAdmission !== 'pending') {
      cols.push('admitted_at');
      vals.push('now()');
      params.push(input.admittedBy ?? null);
      cols.push('admitted_by');
      vals.push(`$${params.length}::text`);
    }
  }
  // OWNER-DIRECTIVE PROVENANCE (P-005) — appended with the same params.length-computed
  // index as taken_by/admission above, NOT spliced into the fixed positional block at the
  // top of this function: every value there is bound by a hand-written `$N`, so inserting
  // a column mid-list silently renumbers the ones after it.
  //
  // Stamped in THIS INSERT rather than as a follow-up UPDATE for the same reason
  // `taken_by` is: the derivation that reads it (deriveDirectiveStatus) answers "is anyone
  // on this directive", and a row that exists for even one tick without its ref reads as
  // UNCLAIMED — which is exactly the window in which a second agent picks the directive up.
  if (input.directiveRef != null) {
    params.push(input.directiveRef);
    cols.push('directive_ref');
    vals.push(`$${params.length}::bigint`);
  }
  // Always write the resolved workspace explicitly (never rely on the trigger's stale
  // 'default' fallback — see the resolution comment above).
  params.push(resolvedWs);
  cols.push('workspace_id');
  vals.push(`$${params.length}::text`);
  // The sequence-floor trigger normally keeps the allocator above imported WI-N
  // rows, but a stale sequence can still occur on an older database or after an
  // administrative repair. `ON CONFLICT DO NOTHING` must not be treated as a
  // successful create: returning the allocated id after a suppressed insert lets
  // the caller's goal-provenance stamp (and every later side effect) target the
  // incumbent row. Retry with the next allocated id until this create actually
  // inserts and return the database-confirmed identity.
  const insertSql = `INSERT INTO harness_shared.work_items (${cols.join(', ')})
     VALUES (${vals.join(', ')})
     ON CONFLICT (harness_slug, feature_id) DO NOTHING
     RETURNING feature_id`;
  // EI-21829617047179388: retrying a suppressed insert is correct, but the retry
  // must be BOUNDED. Unbounded, a persistently-empty result — a stale sequence that
  // never walks clear, or an org-PG seam answering [] for every `.unsafe` — spins
  // this loop forever, allocating on each iteration, and exhausts the V8 heap at
  // ANY --max-old-space-size instead of failing with a diagnosis. That is not a
  // hypothetical: it OOM'd `test:lane-stateful` at both the 2240MB default and at
  // 8192MB, presenting as an unattributed worker crash that named no test.
  const MAX_INSERT_ID_ATTEMPTS = 25;
  let inserted: Array<{ feature_id: string }> = [];
  for (let attempt = 1; ; attempt += 1) {
    params[1] = id;
    inserted = await sql.unsafe<Array<{ feature_id: string }>>(insertSql, params);
    if (inserted.length > 0) {
      id = inserted[0].feature_id;
      break;
    }
    if (explicitId) {
      throw new Error(`createWorkItem: explicit id '${explicitId}' already exists in '${featureHarness}'`);
    }
    if (attempt >= MAX_INSERT_ID_ATTEMPTS) {
      throw new Error(
        `createWorkItem: the work_items INSERT returned no row after ${MAX_INSERT_ID_ATTEMPTS} freshly allocated ` +
          `ids (harness=${featureHarness}, last attempted id=${id}). ON CONFLICT DO NOTHING is suppressing every ` +
          `insert. Either the feature-id sequence is stale behind existing rows, or the org-PG seam is returning ` +
          `an empty result for every sql.unsafe — a test fake must answer this INSERT with its RETURNING shape, ` +
          `[{ feature_id }].`,
      );
    }
    id = await nextWorkItemId();
  }
  const wi: WorkItem = {
    id,
    kind: input.kind,
    family: 'feature',
    harness: featureHarness,
    title: input.title,
    summary: input.summary ?? '',
    needsDesign: input.needsDesign ?? false,
    designStatus: input.designStatus ?? null,
    designSpecId: input.designSpecId ?? null,
    discardedDesignWork: input.discardedDesignWork ?? false,
    // work-item-status-full-unify P-004/P-005: mirrors the INSERT above — a fresh
    // feature-family row is at the unified claimable token 'open' (was 'todo').
    state: 'open',
    // work-item-completion-integrity-2026-07-01 WI-1403: a freshly-inserted row has
    // never taken a terminal transition, so both are unset (the INSERT above doesn't
    // write them — they default to SQL NULL).
    terminalOwner: null,
    terminalCompletionRef: null,
    terminalCompletionEvidence: null, // freshly-inserted row never took a terminal transition (peer added this required field to the WorkItem type but missed this construction site)
    // P-004: same reasoning — a row that has never been closed owes no authority
    // judgement. non-terminal + null is the OPEN reading, not the legacy-close one.
    completionAuthority: null,
    assignee: assignTo, // B-LOOP-4: created already-claimed when `assignee` was given
    // P-001: an atomic create+claim stamps taken_at=now() (the grace anchor); a fresh
    // row has no item-scoped progress yet, so last_progress_at stays null.
    takenAt: assignTo ? tsIso(now) : null,
    lastProgressAt: null,
    assignedBy: null, // feature-family has no assigned_by column (collapse-delegate D-002)
    createdBy: null, // feature-family has no equivalent authorship column
    severity: null,
    // WI-37711: null at construction BY CONSTRUCTION — `stampGoalProvenance` runs AFTER the
    // insert (it UPDATEs work_items.goal_id and returns the id separately, which
    // _create-core.ts folds onto its result), so a row cannot carry a goal at this point.
    goalId: null,
    parent: input.parent ?? null,
    payload: input.payload ?? null,
    rank: null,
    rankWriter: null,
    rankUpdatedAt: null,
    priority: null, // freshly created → unprioritized until the Queen sets feature_order
    origin: 'local', // created here ⇒ local-authored; no auditor screening needed
    auditVerdict: null,
    verifiedAuthorGithubUserId: null, // created here ⇒ local-authored, never verified-stamped (P-008)
    createdAt: tsIso(now),
    updatedAt: tsIso(now),
    closedAt: null,
  };
  // Capabilities: tag topics + auto-subscribe the creator (the hfc CDC trigger handles
  // the change fan-out + federation, so no explicit deliver() here).
  for (const topic of input.topics ?? []) {
    await tags.addTag(workItemObjectRef(wi), topic, { created_by: input.createdBy, created_ts: nowIso() });
    // EI-18654138087054247: also maintain the `tags` COLUMN the feature-family
    // claim-spec SQL reads — the coord tag store alone is invisible to it.
    await mirrorTopicTagToClaimTags(wi, topic);
  }
  if (input.createdBy) {
    await subs.subscribe({
      subscriber_id: input.createdBy,
      target_kind: 'object',
      target_ref: `${FEATURE_KIND}:${workItemObjectRef(wi).ref}`,
      delivery_mode: 'full',
      created_ts: nowIso(),
    });
  }
  if (assignTo) wi.interestWatch = await armWorkItemHolderInterests(wi, assignTo);
  maybeFireUrgentWake(input, wi);
  maybeFireClaimedEvent(assignTo, wi);
  maybeFireCreatedEvent(wi);
  return wi;
}

/**
 * The issue family's agent-settable lifecycle states — the validation allowlist in
 * `normalizeWorkItemState`'s issue branch.
 *
 * work-item-status-full-unify (P-003 writer-flip): DECOUPLED from the generic 3-state
 * pubsub `LIFECYCLE_STATES` (`open|resolved|closed`, a domain-free abstraction we must not
 * repurpose). The issue family now STORES the UNIFIED work-item enum directly
 * (open|wip|blocked|needs-human|done|dropped) — there is no engineer_issues status CHECK
 * (work_items is the base table; the view maps status↔state verbatim), so the old
 * "collapse everything to open|resolved|closed" is gone. Legacy `resolved`/`closed` stay
 * as a TRANSITIONAL superset so a pre-flip row or an un-upgraded federated peer's value
 * still validates; the cleanup pass drops them.
 */
export const ISSUE_FAMILY_STATES: readonly string[] = [
  'open',
  'wip',
  'blocked',
  'needs-human',
  'done',
  'dropped',
  // legacy issue terminals (transitional — aliased to done/dropped on write, but still
  // recognized so a pre-flip/federated value validates)
  'resolved',
  'closed',
];

/**
 * The cross-family TERMINAL/settled state set. The single source of truth for "this work_item
 * is done, one way or another" (WI-1400); was previously an inline literal array duplicated at
 * each call site.
 *
 * work-item-status-full-unify (2026-07-19): the vocabulary is collapsing to a unified enum whose
 * terminals are `done`/`dropped` (feature `passed`→`done`+terminal_reason, `deprecated`→`dropped`;
 * issue `resolved`→`done`, `closed`→`dropped`). This set carries BOTH the legacy per-family terminals
 * AND the unified ones as a TRANSITIONAL SUPERSET, so terminal-detection stays correct on either side
 * of the status-backfill migration (no re-serve of an already-settled row during the cutover window).
 * Once the migration has applied everywhere + the cleanup pass lands, narrow this to `['done','dropped']`.
 */
export const SETTLED_WORK_ITEM_STATES: readonly string[] = [
  'passed',
  'deprecated',
  'resolved',
  'closed',
  'done',
  'dropped',
];

/** Is `state` one of the cross-family settled/terminal states? */
export function isSettledWorkItemState(state: string | null | undefined): boolean {
  return !!state && SETTLED_WORK_ITEM_STATES.includes(state);
}

/**
 * Cross-dialect + drift-variant aliases → canonical issue-family state (mirrors
 * `FEATURE_STATE_ALIASES` in work-item-dispatch-states.ts, the feature-family twin).
 * Hoisted to module scope (was inline in `normalizeWorkItemState`) + exported so
 * the positional-write misalignment guard (EI-7927) can derive the FULL known
 * `state`-column vocabulary — union of this + `ISSUE_FAMILY_STATES` +
 * `FEATURE_FAMILY_STATES` + `FEATURE_STATE_ALIASES` — without hand-duplicating
 * the literal list (which would silently drift out of sync with this one).
 */
export const ISSUE_STATE_ALIASES: Record<string, string> = {
  // work-item-status-full-unify (P-003 writer-flip): INVERTED. The issue family now STORES
  // the UNIFIED enum, so the unified in-flight tokens (wip|blocked|needs-human) pass through
  // as IDENTITY (no entry) instead of collapsing to `open`. Only legacy/drift spellings map:
  //   • legacy issue terminals → unified terminals (resolved→done, closed→dropped);
  //   • the feature-terminal spellings a mis-targeted caller might pass → unified;
  //   • legacy `todo` → the single claimable token `open`;
  //   • separator/case drift for the in-flight tokens → their unified canonical form.
  // The resolved↔done / closed↔dropped nuance is preserved in work_items.terminal_reason
  // (stamped by setWorkItemState). EI-450 (the old 3-state CHECK refusal) no longer applies:
  // there is no engineer_issues status CHECK, so blocked/needs-human/wip store directly.
  resolved: 'done',
  closed: 'dropped',
  passed: 'done',
  deprecated: 'dropped',
  todo: 'open',
  in_progress: 'wip',
  'in-progress': 'wip',
  inprogress: 'wip',
  'in progress': 'wip',
  needs_human: 'needs-human',
  needshuman: 'needs-human',
  'needs human': 'needs-human',
  'need-human': 'needs-human',
};

/**
 * The work-item id shapes admitted by the positional claim guard (D-008): every
 * NEW work-item mints a kind-independent `WI-NNN` id; pre-D-008 rows keep their
 * legacy `F-NNN` (feature) / `EI-NNN` (issue) ids; promoted issue-fix features
 * use `F-FIX-NNN`; scheduled plan-run frontier rows use `PR-<run>-P-<item>`
 * (the parser's plan-item ids are `P-NNN`). This exact allowlist is used by the
 * positional-write misalignment guard (EI-7927) to catch a swapped-row id
 * column carrying an obviously-wrong value (e.g. a state string in id's slot)
 * without rejecting a real scheduled-run item.
 */
export const WORK_ITEM_ID_PATTERN = '^(?:(?:WI|F|EI)-\\d+|F-FIX-\\d+|PR-\\d+-P-\\d+)$';

/**
 * Normalize a requested lifecycle state onto the UNIFIED work-item enum
 * (open | wip | blocked | needs-human | done | dropped) for BOTH families
 * (work-item-status-full-unify, P-003 writer-flip). Legacy per-family spellings + the
 * canonical/drift dialects fold to unified via {@link FEATURE_STATE_ALIASES} /
 * {@link ISSUE_STATE_ALIASES}; an unmappable state is a typed refusal LISTING the valid
 * set (the GAP-5 typo guard). The families no longer store distinct native vocabularies —
 * both persist the same enum; the passed/resolved vs deprecated/closed nuance is carried in
 * work_items.terminal_reason. The DBOS pipeline still writes feature PHASE statuses
 * (scoping/building/…) via raw SQL and bypasses this path (D-004); trusted restores bypass
 * via setWorkItemState's allowNonCanonical.
 */
export function normalizeWorkItemState(
  family: WorkItemFamily,
  state: string,
): { ok: true; state: string } | { ok: false; valid: readonly string[] } {
  if (family === 'feature') {
    return normalizeFeatureStateInput(state);
  }
  const mapped = ISSUE_STATE_ALIASES[state] ?? state;
  if (ISSUE_FAMILY_STATES.includes(mapped)) return { ok: true, state: mapped };
  return { ok: false, valid: ISSUE_FAMILY_STATES };
}

/**
 * Bump a feature work-item's `last_progress_at` to now — the REAL item-scoped
 * progress signal (agent-activity-liveness-truth-2026-06-21 P-001, D-001/D-004).
 *
 * Call this ONLY on genuine item-scoped work that ISN'T already a state transition
 * (a checkpoint write is the canonical case — {@link setWorkItemState} folds the
 * bump into its own transition UPDATE, so it must NOT also call this). NEVER call it
 * on a bare presence heartbeat or a lease keepalive — bumping progress on a mere
 * keepalive is exactly the false "the work is advancing" signal D-001 forbids
 * (`work_item_claims.last_activity_ts` already conflates the two; this column must
 * stay clean). Only a CLAIMED feature row is credited — an unclaimed/terminal/issue
 * row matches 0 rows and is a harmless no-op (the classifier ignores progress on a
 * holderless item anyway). Fail-soft: returns false on any error so a progress bump
 * can never break the caller's primary write.
 *
 * @returns true if a held feature row was bumped, false otherwise (no match / error).
 */
export async function markFeatureProgress(harness: string, id: string): Promise<boolean> {
  if (!harness || !id) return false;
  try {
    const { sql } = getOrgPg();
    const res = await sql`
      UPDATE harness_shared.harness_features_consolidated
         SET last_progress_at = now()
       WHERE harness_slug = ${harness} AND feature_id = ${id}
         AND taken_by IS NOT NULL AND taken_by <> ''`;
    return res.count > 0;
  } catch {
    return false;
  }
}

/**
 * WI-4531: is this hold-open dead residue — and if so, LIFT it.
 *
 * The held-open guard below refuses a non-holder's terminal transition. That guard was
 * unconditional, so a hold left behind by a dead session blocked the item forever (WI-4445 sat
 * behind a hold placed by an agent that `coord:send` could not even resolve; measured live: 50
 * NON-TERMINAL items were starved out of the claimable pool this way). A hold must not outlive
 * its holder — so before refusing, re-derive the same liveness rule the 60s sweep uses and, if
 * the hold is expired, clear it and let the caller through.
 *
 * FAILS CLOSED: any error (config read, PG, a clear that does not land) returns false ⇒ the
 * hold stays enforced ⇒ the pre-WI-4531 refusal. A liveness check that cannot run must never
 * become a way to punch through a LIVE holder's gate — the EI-8993 dup-close guard is the whole
 * point of the hold.
 *
 * Dynamic imports: keeps coord-liveness-config / work-items-hold-open off this module's static
 * graph (work-items.ts is imported very widely), so no import cycle is possible.
 */
async function isStaleHoldOpenAndCleared(
  id: string,
  heldOpen: { by: string; reason: string | null; at: string | null },
  harness?: string,
  /** The row's `origin` — a peer-written ('remote') row's holder is never judged here (WI-10005916). */
  origin?: string | null,
): Promise<boolean> {
  try {
    const [{ isHoldOpenExpired }, { readCoordLivenessConfig }] = await Promise.all([
      import('./work-items-hold-open'),
      import('./coord-liveness-config'),
    ]);
    const cfg = await readCoordLivenessConfig();
    const { sql } = getOrgPg();
    const expired = await isHoldOpenExpired(sql, heldOpen.by, heldOpen.at, {
      graceMs: cfg.reclaimGraceMs,
      parkedGraceMs: cfg.reclaimParkedGraceMs,
      holdOpenGraceMs: cfg.holdOpenGraceMs,
      origin,
    });
    if (!expired) return false;
    // Lift it for real — not just "ignore it this once". Leaving the stamp in place would keep
    // the item excluded from claim_next/scheduler self-select (the `_claimHold` half of the
    // hold), which is the other half of the same bug. leaseOnly: an automated liveness lift
    // must preserve a coexisting durable park (claim_hold_by).
    const cleared = await setWorkItemClaimHold(id, false, { harness, leaseOnly: true });
    if (!cleared) return false;
    console.warn(
      `[hold-open] lifted EXPIRED hold on ${id}: holder ${heldOpen.by} is not live and the hold ` +
        `(${heldOpen.at ?? 'no timestamp'}) is past grace — a hold must not outlive its holder (WI-4531). ` +
        `Reason was: ${heldOpen.reason ?? '(none)'}`,
    );
    return true;
  } catch (e: unknown) {
    // Still fails closed, but never silently: a liveness check that cannot run looks
    // exactly like a LIVE holder, so say why the dead-hold lift was skipped.
    console.warn(
      `[hold-open] liveness check for ${id} (holder ${heldOpen.by}) could not run; hold stays enforced: ` +
        (e instanceof Error ? e.message : String(e)),
    );
    return false;
  }
}

/**
 * EI-18736669939338784 — what happened when a SECOND terminal close met an item that was
 * already completed by SOMEONE ELSE, reported back to the caller.
 *
 * `outcome`:
 *  · `attested`  — the STORED record stands; this close was filed under
 *    `payload._completionAttestations` and did NOT become authoritative.
 *  · `upgraded`  — this close carried strictly richer evidence, became authoritative, and
 *    the record it replaced was archived as an attestation rather than deleted.
 */
export interface TerminalCompletionConflict {
  outcome: 'attested' | 'upgraded';
  /** The principal already credited with the item's completion. */
  existingOwner: string | null;
  existingAuthority: WorkItemCompletionAuthority | null;
  /** Did the STORED record meet the `committed` evidence bar? */
  existingEvidenceSufficient: boolean;
  /** Did the INCOMING close meet it? */
  incomingEvidenceSufficient: boolean;
  /** Caller-facing explanation — surfaced verbatim by work_items:complete. */
  note: string;
}

interface WorkItemPhysicalRow {
  workspaceId: string;
  harnessSlug: string;
}

/** Pin a follow-up write to the physical row returned by getWorkItem. */
async function resolveWorkItemPhysicalRow(
  wi: WorkItem,
  preferredHarness?: string | null,
): Promise<WorkItemPhysicalRow> {
  const workspaceId = wi.family === 'issue' ? await resolveIssueWorkspace(wi.id) : activeWorkspaceId();
  const harnessSlug = wi.family === 'issue'
    ? await resolveIssuePhysicalSlug(getOrgPg().sql, workspaceId, wi.id, preferredHarness ?? wi.harness)
    : wi.harness;
  if (harnessSlug === null) {
    throw new Error(`work_item '${wi.id}' has no harness_slug for a row-scoped write`);
  }
  return { workspaceId, harnessSlug };
}

/**
 * Record a non-authoritative terminal close beside the authoritative one.
 *
 * Writes through `harness_shared.work_items`, which is UPDATE-able for BOTH families (the
 * feature side is an auto-updatable view, the issue side has an INSTEAD OF trigger) — the
 * same surface the reopen-history archive below uses, which is why this needs no
 * per-family branching.
 *
 * Bounded to the newest 5, newest-last, mirroring `reopenHistory`.
 */
async function appendCompletionAttestation(
  id: string,
  priorPayload: unknown,
  entry: CompletionAttestation,
  physicalRow: WorkItemPhysicalRow,
): Promise<void> {
  const existing = (priorPayload as Record<string, unknown> | null)?.[COMPLETION_ATTESTATIONS_KEY];
  const prior = Array.isArray(existing) ? existing : [];
  const merged = JSON.stringify({ [COMPLETION_ATTESTATIONS_KEY]: [...prior.slice(-4), entry] });
  const { sql } = getOrgPg();
  await sql`
    UPDATE harness_shared.work_items
       SET payload = COALESCE(payload, '{}'::jsonb) || ${merged}::text::jsonb,
           updated_ts = ${Date.now()}
     WHERE feature_id = ${id}
       AND workspace_id = ${physicalRow.workspaceId}
       AND harness_slug = ${physicalRow.harnessSlug}`;
}

/**
 * What {@link attachCompletionEvidenceToSettledItem} did.
 *
 * `recorded`   — the row carried no competing completion record (or the caller IS the
 *                credited closer), so this record was installed as the authoritative one.
 * `upgraded`   — a peer's record was stored but this one is strictly richer: installed,
 *                and theirs ARCHIVED as an attestation.
 * `attested`   — a peer's record stands; this one was filed beside it.
 * `not-terminal` / `not-found` / `nothing-to-record` — nothing was written.
 */
export interface AttachedCompletionEvidence {
  outcome: 'recorded' | 'upgraded' | 'attested' | 'not-terminal' | 'not-found' | 'nothing-to-record';
  /** The re-read row after a write; the pre-call row when nothing was written. */
  workItem: WorkItem | null;
}

/**
 * EI-19362441037986499 — attach a completion record to an ALREADY-TERMINAL item without
 * writing state and without firing the settled-event fan-out.
 *
 * THE GAP THIS FILLS. `work_items:complete` persists evidence ONLY inside its
 * `else if (effectiveState)` arm, and `completion.status:'done'` can never infer a close
 * state (it IS the schema default, so inferring from it would auto-close every bare
 * completion). So a record-only completion arriving for a row some watchdog already
 * auto-resolved took no persistence branch at all: `ok:true`, the completion echoed back,
 * ZERO rows written, and — because that tool's `stateWarning` is suppressed whenever the
 * final state IS terminal — zero warning. Measured on EI-20692923474318761: a full
 * structured close left `updated_ts` unchanged and both `authority` and the completion ref
 * untouched. The evidence an agent had actually verified was discarded success-shaped.
 *
 * WHY THIS IS ITS OWN WRITER, and not a terminal→same-terminal re-assert through
 * {@link setWorkItemState}: the settled-event emit on that path gates only on
 * `isSettledWorkItemState(result.state)` with NO state-changed guard — contrast the status
 * transition emit one block above it, which checks `result.state !== wi.state`. A re-assert
 * would therefore re-fire `work-item:done:<id>`, the derived-blocker-subscription cleanup and
 * the sentinel handoff report on EVERY record-only completion of an already-closed item,
 * waking whatever is parked on it. The `attested` branch of the second-terminal-close reshape
 * dodges that only by returning early. The re-assert is not a cheaper version of this
 * function; it is a different and wrong behaviour.
 *
 * WHAT IT DELIBERATELY DOES NOT DECIDE. The upgrade-vs-attest evaluation is the EXISTING
 * one — `isSufficientEvidence` on both sides, richer supersedes, and a TIE leaves the FIRST
 * record standing because the property being defended is "a second write must not destroy
 * the first", not "the newest wins". It is read off the same helper the state-write path
 * uses and is deliberately neither restated nor re-tuned here (the bar has moved once
 * already; a copy would have become a false description of the check it describes). Whether
 * a human-verified test record ought to outrank a watchdog's "N consecutive green runs" is a
 * separate judgement, and is not quietly made inside this fix.
 *
 * Nor does it invent a policy for the case where the row holds NO completion record at all
 * (`terminal_completion_ref` and `authority` both unset — the shape every `watchdog-auto-close`
 * row has). It mirrors what the state-write path already does there: nothing is being
 * protected, so the incoming record is installed. That keeps the two paths' behaviour
 * identical rather than making this one stricter for no stated reason.
 *
 * TWO DELIBERATE DIVERGENCES from the terminal UPDATE in {@link setWorkItemState}:
 *  1. No `jsonb_strip_nulls` over the merged payload. That write applies it to the payload
 *     as a WHOLE, which would reach inside the attestation this function may have just
 *     archived (its entries carry meaningful explicit nulls) and flatten "explicitly none"
 *     into "absent" in the very record being preserved.
 *  2. `terminal_completion_ref`/`authority` are written from the caller's values, exactly as
 *     that path does — but this function only ever reaches the write when the stored record
 *     is absent, is the caller's own, or has just been archived. So replacing them cannot
 *     erase an unarchived peer record, which is the harm the second-terminal-close reshape
 *     exists to prevent.
 */
export async function attachCompletionEvidenceToSettledItem(
  id: string,
  opts: {
    harness?: string;
    by: string;
    completionRef?: string;
    completionEvidence?: PersistedCompletionEvidence;
    assumptions?: StoredAssumptionDeclaration;
    completionAuthority?: WorkItemCompletionAuthority | null;
    /** Same callback shape the state-write path uses, so callers reuse one result field. */
    onTerminalConflict?: (info: TerminalCompletionConflict) => void;
  },
): Promise<AttachedCompletionEvidence> {
  const wi = await getWorkItem(id, opts.harness);
  if (!wi) return { outcome: 'not-found', workItem: null };
  // The caller decides WHEN this applies; this is the backstop that keeps a non-terminal
  // row from being stamped with a terminal record by a path that writes no state.
  if (!isSettledWorkItemState(wi.state)) return { outcome: 'not-terminal', workItem: wi };
  const physicalRow = await resolveWorkItemPhysicalRow(wi, opts.harness);

  const evidencePayloadJson = terminalPayloadMergeJson(opts.completionEvidence, opts.assumptions);
  // Nothing to record ⇒ nothing to write. Without this, a bare call would reassign
  // `terminal_owner` — taking CREDIT for someone's completion — while carrying no evidence.
  if (!evidencePayloadJson && !opts.completionRef?.trim() && !opts.completionAuthority) {
    return { outcome: 'nothing-to-record', workItem: wi };
  }

  const decision = classifySettledCompletionEvidence({
    by: opts.by,
    terminalOwner: wi.terminalOwner,
    terminalCompletionRef: wi.terminalCompletionRef,
    completionAuthority: wi.completionAuthority,
    incomingCompletionAuthority: opts.completionAuthority,
    storedEvidence: wi.terminalCompletionEvidence,
    incomingEvidence: opts.completionEvidence,
  });

  const install = async (): Promise<WorkItem | null> => {
    const { sql } = getOrgPg();
    await sql`
      UPDATE harness_shared.work_items
         SET terminal_owner = ${opts.by},
             terminal_completion_ref = ${opts.completionRef ?? null},
             authority = ${opts.completionAuthority ?? null},
             payload = CASE WHEN ${evidencePayloadJson}::text::jsonb IS NULL
                            THEN payload
                            ELSE COALESCE(payload, '{}'::jsonb) || ${evidencePayloadJson}::text::jsonb
                       END,
             updated_ts = ${Date.now()}
       WHERE workspace_id = ${physicalRow.workspaceId}
         AND harness_slug = ${physicalRow.harnessSlug}
         AND feature_id = ${id}`;
    return (await getWorkItem(id, opts.harness)) ?? wi;
  };

  if (decision.outcome === 'recorded') {
    return { outcome: 'recorded', workItem: await install() };
  }

  const { existingSufficient, incomingSufficient } = decision;
  const upgrade = decision.outcome === 'upgraded';
  const attestation: CompletionAttestation = {
    at: new Date().toISOString(),
    by: upgrade ? wi.terminalOwner : opts.by,
    // No state was requested on this path, so both sides of the archive carry the state
    // that stands — unlike the state-write path, where they can legitimately differ.
    state: wi.state,
    completionRef: upgrade ? wi.terminalCompletionRef : (opts.completionRef ?? null),
    completionAuthority: upgrade ? wi.completionAuthority : (opts.completionAuthority ?? null),
    evidence: upgrade ? wi.terminalCompletionEvidence : (opts.completionEvidence ?? null),
    assumptions: upgrade ? readStoredAssumptions(wi.payload) : (opts.assumptions ?? null),
    outcome: upgrade ? 'superseded' : 'attested',
  };
  // ARCHIVE BEFORE INSTALL, and best-effort on the attested path — the same order and the
  // same tolerance as the state-write reshape. The order is what matters: if the install
  // failed after a successful archive the loser is merely stored twice, whereas installing
  // first and failing to archive would destroy the record this function exists to keep.
  await appendCompletionAttestation(id, wi.payload, attestation, physicalRow).catch(() => {});
  if (!upgrade) {
    opts.onTerminalConflict?.({
      outcome: 'attested',
      existingOwner: wi.terminalOwner,
      existingAuthority: wi.completionAuthority,
      existingEvidenceSufficient: existingSufficient,
      incomingEvidenceSufficient: incomingSufficient,
      note:
        `work_item '${id}' was ALREADY completed by ${wi.terminalOwner}` +
        `${wi.completionAuthority ? ` (authority:${wi.completionAuthority})` : ''}, and this completion ` +
        `requested no state change. Your record was FILED AS A SECOND ATTESTATION ` +
        `(payload.${COMPLETION_ATTESTATIONS_KEY}) and did NOT replace theirs — ` +
        `${
          incomingSufficient
            ? 'both records meet the evidence bar, and a tie leaves the first standing'
            : 'it does not meet the bar to supersede a stored record (`committed` needs verifiedHow plus one of testsRun/testResult)'
        }. ` +
        `The item's authoritative completion record and terminal state are unchanged. If ${wi.terminalOwner}'s ` +
        `completion is WRONG, correct it deliberately with work_items:set_state { id: '${id}', state: '${wi.state}', force: true } ` +
        `(work_items:complete has no \`force\` arg — WI-4530), or coordinate with them via coord:send.`,
    });
    // The stored record stands, so there is nothing further to write. Re-read so the caller
    // sees the attestation that was just filed rather than the pre-call snapshot.
    return { outcome: 'attested', workItem: (await getWorkItem(id, opts.harness)) ?? wi };
  }
  const upgradeDescription =
    decision.upgradeBasis === 'authority'
      ? `equally sufficient evidence with authority:${opts.completionAuthority}, which outranks the stored ` +
        `authority:${wi.completionAuthority}`
      : `strictly richer evidence (verifiedHow plus test results, which theirs lacked)`;
  opts.onTerminalConflict?.({
    outcome: 'upgraded',
    existingOwner: wi.terminalOwner,
    existingAuthority: wi.completionAuthority,
    existingEvidenceSufficient: existingSufficient,
    incomingEvidenceSufficient: incomingSufficient,
    note:
      `work_item '${id}' was already completed by ${wi.terminalOwner}, but your record carries ${upgradeDescription} — ` +
      `it is now the AUTHORITATIVE completion ` +
      `record. Their record was ARCHIVED to payload.${COMPLETION_ATTESTATIONS_KEY} rather than discarded, and ` +
      `the item's terminal state is unchanged.`,
  });
  return { outcome: 'upgraded', workItem: await install() };
}

/**
 * EI-19313515375179600 (WI-6822 follow-up) — self-heal a locally-authored issue-family row
 * whose `origin` incorrectly flipped to 'remote' after creation (root cause not yet found;
 * candidates include a federation/replay-provenance defect around the substrate's own
 * capture-log echo — see the work-item's own body for what has and hasn't been established).
 *
 * Resets `origin` back to 'local' directly on the BASE table (`harness_shared.work_items`) —
 * bypassing the `engineer_issues` view's INSTEAD OF trigger entirely, since that trigger
 * (migration 655, `engineer_issues_view_dml()`) is exactly what would otherwise block this
 * reset: it unconditionally no-ops any UPDATE while `origin='remote'`, with no identity
 * check of its own. This function IS the identity check the trigger cannot perform —
 * scoped tight in its own WHERE clause so it can only ever heal a row whose OWN recorded
 * `created_by` matches the caller (never a row genuinely owned by a different peer):
 * a caller who is NOT the recorded author gets zero rows affected, a no-op.
 *
 * Callers MUST re-verify identity (`createdBy === callerOwnerId`) themselves before calling
 * this — it is a narrow, mechanical reset, not a policy decision — and should update their
 * in-memory `origin` to 'local' on a truthy return so subsequent logic in the same call
 * sees the healed state without an extra round-trip.
 *
 * Returns true iff a row was actually healed (false: not remote, not this caller's row, or
 * the id doesn't resolve to an issue-family row in the base table).
 */
export async function selfHealAuthorOriginIfStranded(
  id: string,
  callerOwnerId: string,
  /** WI-10006010: only this resolved physical row may be healed. */
  physicalRow: { workspaceId: string; harnessSlug: string },
): Promise<boolean> {
  if (!id || !callerOwnerId || !physicalRow.workspaceId || !physicalRow.harnessSlug) return false;
  const { sql } = getOrgPg();
  const rows = await sql<{ feature_id: string }[]>`
    UPDATE harness_shared.work_items
       SET origin = 'local'
     WHERE workspace_id = ${physicalRow.workspaceId}
       AND harness_slug = ${physicalRow.harnessSlug}
       AND feature_id = ${id}
       AND origin = 'remote'
       AND payload #>> '{_ei,created_by}' = ${callerOwnerId}
    RETURNING feature_id`;
  return rows.length > 0;
}

/** Lifecycle.setState — feature → status; issue → state. The requested state is
 *  normalized onto the family's native vocabulary first (EI-24); an unmappable
 *  state throws a typed error naming the valid set.
 *
 * Completion-integrity gate (work-item-completion-integrity-2026-07-01 WI-1403,
 * contract C-1): a transition INTO a terminal state (feature: passed|deprecated;
 * issue: resolved|closed) must carry both `opts.by` (the claiming principal) and
 * `opts.completionRef` (a completion summary / commit / coord / plan-item
 * reference — any non-empty evidence string). Reject otherwise, so a bare/
 * anonymous flip — e.g. a watchdog dedup marker — can never masquerade as a
 * genuine completion. `opts.skipCompletionGate` is a narrow, explicit bypass for
 * TRUSTED internal restore / system-sweep paths that are not completions at all
 * (mirrors `setIssueState`'s identical gate/bypass shape). */
export async function setWorkItemState(
  id: string,
  state: string,
  opts: {
    harness?: string;
    by?: string;
    /** The item's family, when the caller has already read it from the `work_items`
     *  row in `harness`. `'feature'` skips the issue-family probe (WI-10003631). */
    family?: WorkItemFamily;
    /**
     * Internal dispatch-first handoff: suppress only the broad
     * `work-item:claimable` co-fire when this state transition enters the pool.
     * The item-scoped status event still fires. Default true/omitted preserves
     * every ordinary lifecycle caller; the plan-run lane reconciler passes
     * false while it restores then deterministically assigns the stable agent.
     */
    announceClaimable?: boolean;
    allowNonCanonical?: boolean;
    completionRef?: string;
    completionEvidence?: PersistedCompletionEvidence;
    /** Typed output for a successful accepted blueprint operation. */
    outputPayload?: unknown;
    /** Trusted DBOS program-root close. The immutable receipt and admission
     * epoch are checked again in the terminal UPDATE; never exposed as a tool arg. */
    acceptedProgramAttempt?: import('./blueprint/operation-worker-binding').AcceptedProgramRootAttempt;
    /**
     * P-008 (d) / D-050 / D-079 — the RESOLVED assumption declaration this close
     * rests on, stored under {@link TERMINAL_ASSUMPTIONS_KEY}.
     *
     * Optional HERE, required at the two agent-facing commitment tools, because
     * this function is also the system write path (watchdog auto-close, restore,
     * reconcile sweeps) and those are documented as "not completions at all" —
     * forcing a declaration on them would manufacture assumption records for
     * closes no agent made.
     */
    assumptions?: StoredAssumptionDeclaration;
    skipCompletionGate?: boolean;
    /**
     * agent-protocol-authority-semantics-2026-07-26 P-004 — the completion-authority
     * judgement the gate reached for THIS close (`authorityForCompletion(evidence)`).
     * Supplying it SATISFIES the completion-integrity gate in place of `completionRef`:
     * a caller that has judged its own evidence has done strictly more than assert a
     * non-empty string, and the consequence of a weak judgement is now `proposed`
     * (recorded, but not counted toward burn-down) rather than a rejection.
     */
    completionAuthority?: WorkItemCompletionAuthority;
    /**
     * EI-7125 / WI-2573: fired synchronously when the REQUESTED state aliases
     * to a DIFFERENT canonical state before the write (e.g. issue-family
     * 'blocked'/'needs-human'/'in_progress'/'wip' all collapse to 'open' —
     * EI-450, the issue family's 3-state CHECK has no richer representation).
     * Lets a caller (work_items:set_state) surface a loud note instead of the
     * silent `ok:true, state unchanged from the caller's PoV` surprise that
     * caused a real reclaim ping-pong (a caller asked for 'blocked', got back
     * 'open', with nothing distinguishing that from a no-op). Never called
     * when the requested state is already canonical.
     */
    onAlias?: (info: { requested: string; resolved: string }) => void;
    /**
     * EI-18736669939338784: fired when this write was a SECOND terminal close, by a
     * DIFFERENT principal, of an item that already carried a completion — so the write was
     * reshaped to preserve the stronger record instead of overwriting it.
     *
     * Exists because the SILENCE was the bug: both callers were told `ok:true` while one of
     * their records was destroyed. A caller that cannot learn which record the ledger now
     * carries has no way to know its evidence needs re-posting.
     */
    onTerminalConflict?: (info: TerminalCompletionConflict) => void;
    /**
     * EI-7422: a target that is ALREADY terminally completed (terminalOwner +
     * terminalCompletionRef stamped, e.g. via a peer's work_items:complete that
     * raced past a stale claimable/orient snapshot) requires an explicit `force`
     * to reopen into a non-terminal state. Without this, a stale-claim caller
     * silently stomps a peer's completion (no claim_conflict fires because the
     * peer completed without holding a claim) — the item flips back open with
     * no signal that another session's finished work was just discarded.
     */
    force?: boolean;
  } = {},
): Promise<WorkItem | null> {
  // WI-10003631: a caller that already read the row's family from work_items (the
  // accepted-program settle) skips the issue-view probe that always misses for a
  // feature-family item.
  const wi = opts.family === 'feature'
    ? await getFeatureWorkItemOnly(id, opts.harness)
    : await getWorkItem(id, opts.harness);
  if (!wi) return null;
  // The feature writer below uses this same receipt inside its UPDATE. Check
  // before any completion attestation or other pre-write side effect as well.
  // Trusted recovery paths with skipCompletionGate keep their existing reaper
  // authority; that option is not exposed as an agent tool argument.
  if (opts.acceptedProgramAttempt && (opts.skipCompletionGate || !isSettledWorkItemState(state))) {
    throw new Error('accepted program attempt requires a governed terminal transition');
  }
  const operationClaims = (wi.family === 'feature' || opts.acceptedProgramAttempt) && !opts.skipCompletionGate
    ? await import('./blueprint/operation-worker-binding') : null;
  if (opts.acceptedProgramAttempt && operationClaims) {
    await operationClaims.validateAcceptedProgramRootAttempt(opts.acceptedProgramAttempt, wi);
  }
  const operationEffectRead = operationClaims
    ? opts.acceptedProgramAttempt ? null : opts.by
      ? await operationClaims.readActiveOperationWorkerClaimBinding(activeWorkspaceId(), opts.by)
      : { status: 'none' as const }
    : null;
  if (operationClaims && operationEffectRead) {
    const match = operationClaims.matchOperationWorkerClaim(operationEffectRead, wi);
    if (!match.allowed || (operationEffectRead.status === 'bound' && wi.assignee !== opts.by)) {
      throw new Error(`blueprint operation effect refused: ${match.allowed ? 'current claim holder changed' : match.reason}`);
    }
  }
  const requestedState = state;
  const norm = normalizeWorkItemState(wi.family, state);
  if (norm.ok) {
    state = norm.state;
    if (state !== requestedState) opts.onAlias?.({ requested: requestedState, resolved: state });
  } else if (opts.allowNonCanonical && wi.family === 'feature') {
    // Trusted internal restore (e.g. autonomy tripwire revert restoring a CAPTURED
    // prior DB state, possibly a raw-SQL pipeline phase): the feature family has no DB
    // CHECK, so a non-canonical restore safely bypasses the agent-typo guard (D-010).
    // The issue family is NOT bypassable — it has a real DB CHECK that would reject it.
    state = state.trim();
  } else {
    throw new Error(
      `work_item '${id}' (kind=${wi.kind}) cannot take state '${state}' — valid: ${norm.valid.join(', ')}`,
    );
  }
  const requestedTerminalReason = /^(passed|resolved|deprecated|closed)$/i.test(requestedState.trim())
    ? requestedState.trim().toLowerCase()
    : null;
  const blueprintPin = wi.payload && typeof wi.payload === 'object' && !Array.isArray(wi.payload)
    ? (wi.payload as Record<string, unknown>).blueprintOperation : null;
  let blueprintResult: Awaited<ReturnType<typeof import('./blueprint/operation-service').prepareDirectOperationCompletion>> | undefined;
  if (!opts.skipCompletionGate && (state === 'done' || state === 'passed' || state === 'resolved') && blueprintPin) {
    const priorResult = wi.payload && typeof wi.payload === 'object' && !Array.isArray(wi.payload)
      ? (wi.payload as Record<string, unknown>).blueprintResult : null;
    const priorOutput = isSettledWorkItemState(wi.state) && priorResult &&
      typeof priorResult === 'object' && !Array.isArray(priorResult)
      ? (priorResult as Record<string, unknown>).output : undefined;
    const { prepareDirectOperationCompletion } = await import('./blueprint/operation-service');
    blueprintResult = await prepareDirectOperationCompletion(
      getOrgPg().sql, activeWorkspaceId(), wi,
      opts.outputPayload === undefined ? priorOutput : opts.outputPayload,
    );
  }
  // D-029: the ONE needs-human precondition every writer applies — a structured owner ask that is
  // also answerable (defaultIfUnanswered says what happens if the owner never replies).
  if (state === 'needs-human' && !hasActiveStrictHumanAsk(wi.payload)) {
    throw new Error(
      `work_item '${id}' → 'needs-human' rejected — the item carries no answerable owner ask. ` +
        `Record the ask first with work_items:set_blocker { id: '${id}', kind: 'human', ` +
        `capability: 'credential' | 'physical-device' | 'external-service-action', ref, summary, nextVerb, ` +
        `defaultIfUnanswered }. That typed blocker records the question, asker/time, responsible owner ` +
        `capability, what unblocks the item, and what happens if the owner never answers.`,
    );
  }
  if (state === 'needs-human') {
    // EI-13766: the structured ask is necessary but cannot override the plan,
    // which is the readiness authority. Dynamic import keeps this canonical
    // lifecycle writer free of the scheduler module's static work-items cycle.
    const { planItemNeedsHumanContradiction } = await import('./scheduler/plan-item-lane-guard');
    const contradiction = await planItemNeedsHumanContradiction(wi);
    if (contradiction) {
      throw new Error(
        `work_item '${id}' → 'needs-human' rejected — ${contradiction.reason}. ` +
          `Update the linked plan item first; a work-item owner park may not contradict plan readiness truth.`,
      );
    }
  }
  if (!opts.skipCompletionGate && isSettledWorkItemState(state) && isTransportOnlyIdentity(opts.by)) {
    throw new Error(
      `completion-integrity: work_item '${id}' → '${state}' rejected — '${opts.by}' is a transport-only ` +
        `identity with no live completion owner. Retry through a connected agent session. For an ` +
        `HTTP/MCP loopback replay, add ?client=<ownerId> to the /api/mcp URL; CLI callers may ` +
        `pass --client <ownerId>.`,
    );
  }
  // EI-7422: refuse to silently REOPEN an item that is already terminally
  // completed by SOMEONE ELSE (terminalOwner + terminalCompletionRef stamped
  // by a different `by`) unless the caller explicitly forces it. A stale-claim
  // caller (claimed off a snapshot that predates a peer's completion) hits
  // this the same way a live claim hits claim_conflict — the peer's finished
  // work is evidence another session beat you to it, not something a plain
  // set_state should be able to discard. The item's OWN terminal owner
  // reopening its own completion (a self-correction — e.g. "actually not
  // done") is NOT gated: that is a legitimate, common lifecycle move (see the
  // resolved→open fan-out test right below) and carries no double-placement
  // risk since no second session's work is being discarded.
  //
  // P-004 widened the second conjunct. This guard used to require `terminalCompletionRef`,
  // which work_items:complete auto-filled on every close — so "has a completion ref" was a
  // reliable proxy for "was genuinely completed". That auto-fill is now deleted, and a
  // close made through the completion gate stamps an AUTHORITY instead. Left as-is, this
  // guard would have stopped firing for every new completion the day P-004 landed, silently
  // re-opening the EI-7422 hole (a stale-claim peer discarding finished work) — the exact
  // class of collateral damage a "delete the auto-fill" change invites. Either signal means
  // the same thing: someone recorded a real completion here.
  if (
    !opts.force &&
    wi.terminalOwner &&
    (wi.terminalCompletionRef || wi.completionAuthority) &&
    opts.by !== wi.terminalOwner &&
    isSettledWorkItemState(wi.state) &&
    !isSettledWorkItemState(state)
  ) {
    throw new Error(
      `work_item '${id}' is already terminally completed (by ${wi.terminalOwner}: ` +
        `"${wi.terminalCompletionRef ?? `authority:${wi.completionAuthority}`}") — ` +
        `reopening into '${state}' would silently discard that completion. To deliberately reopen it (e.g. the ` +
        `completion was wrong), use work_items:set_state { id: '${id}', state: '${state}', force: true } — ` +
        `NOTE work_items:complete does NOT accept a \`force\` arg, so passing one there is silently ignored (WI-4530). ` +
        `Otherwise investigate the peer's completion first.`,
    );
  }
  // EI-18736669939338784 — THE SAME HARM AS THE GUARD ABOVE, BY A SHORTER PATH. That arm
  // stops a peer DISCARDING a completion by REOPENING it; its condition carries
  // `!isSettledWorkItemState(state)`, so a terminal→terminal RE-CLOSE sails straight past
  // it and overwrites the stored record instead. The terminal UPDATE stamps
  // `terminal_owner`/`terminal_completion_ref`/`authority` unconditionally, and merges
  // evidence with jsonb `||` — a TOP-LEVEL key merge, so an incoming `_completionEvidence`
  // REPLACES the stored object wholesale rather than deep-merging it.
  //
  // Proven live on WI-6112 (tool_invocations, ORDER BY invoked_at ASC): a rich structured
  // close (verifiedHow:'integration', testsRun, 4 filesChanged) landed at 15:30:03.446, and
  // a bare-string close from a DIFFERENT agent landed 1.9s later and is what survived —
  // leaving the row reading as an unverified assertion. Both callers were told ok:true.
  //
  // WHY THIS DIRECTION IS THE DANGEROUS ONE: completion-integrity audits read whatever
  // closed LAST, so absent this guard the WEAKER record wins by arriving later — a bare
  // assertion ERASES a verification.
  //
  // Measured over 30 days before the fix: 27 items took a cross-owner second close. ALL 27
  // had terminal_owner reassigned away from the first closer; 12 lost or degraded their
  // evidence; and 15 ended up MIS-ATTRIBUTED — crediting closer B while still carrying
  // closer A's verification, which reads as a clean well-evidenced close and passes every
  // check we have. That last group is why this keys on `terminalOwner` + a different `by`
  // rather than on "would evidence be overwritten": the evidence-loss reading would have
  // covered 12 of 27 and missed the 15 worst.
  //
  // UNLIKE THE REOPEN ARM, THIS DOES NOT THROW. The item is ALREADY terminal, so refusing
  // gives the caller nothing to do with the refusal. Instead the write is reshaped to keep
  // the stronger record and the loser is preserved as an attestation — the reporter's
  // stated preference (merge/append over refuse), and strictly more information than either
  // a throw or the old silent clobber.
  //
  // `skipCompletionGate` is deliberately exempt: those are trusted internal restore/sweep
  // paths documented as "not completions at all", and reshaping them would change behaviour
  // this change has not audited. That leaves a narrower hole (a system sweep can still
  // reassign credit) tracked separately as WI-6218, rather than widened into here.
  //
  // A legacy/system close can still carry a terminalOwner with neither a ref nor an authority
  // (the watchdog-auto-close and improvement-hygiene shape). Null authority means "legacy
  // close", not "there is no record to protect". Treat the durable owner stamp as sufficient
  // to enter this reshape, while leaving the upgrade decision to the evidence comparison below;
  // this preserves the null-authority semantics and never manufactures an authority.
  const isSecondTerminalClose =
    !opts.force &&
    !opts.skipCompletionGate &&
    Boolean(opts.by?.trim()) &&
    Boolean(wi.terminalOwner) &&
    opts.by !== wi.terminalOwner &&
    isSettledWorkItemState(wi.state) &&
    isSettledWorkItemState(state);
  if (isSecondTerminalClose) {
    // Reuse the record-only writer's PURE comparison. `storedRecordPresent:true` preserves
    // this path's older owner-only legacy protection while keeping the record-only path's
    // narrower ref-or-authority definition unchanged.
    const decision = classifySettledCompletionEvidence({
      by: opts.by!,
      terminalOwner: wi.terminalOwner,
      terminalCompletionRef: wi.terminalCompletionRef,
      completionAuthority: wi.completionAuthority,
      incomingCompletionAuthority: opts.completionAuthority,
      storedRecordPresent: true,
      storedEvidence: wi.terminalCompletionEvidence,
      incomingEvidence: opts.completionEvidence,
    });
    const { existingSufficient, incomingSufficient } = decision;
    const upgrade = decision.outcome === 'upgraded';
    const attestation: CompletionAttestation = {
      at: new Date().toISOString(),
      by: upgrade ? wi.terminalOwner : (opts.by ?? null),
      state: upgrade ? wi.state : state,
      completionRef: upgrade ? wi.terminalCompletionRef : (opts.completionRef ?? null),
      completionAuthority: upgrade ? wi.completionAuthority : (opts.completionAuthority ?? null),
      evidence: upgrade ? wi.terminalCompletionEvidence : (opts.completionEvidence ?? null),
      // P-008 (d) / D-079 R4. On an UPGRADE the stored record is the one being
      // archived, so the attestation carries what is already on the row; otherwise
      // it carries THIS close's declaration, which is the one the `||` merge would
      // otherwise drop on the floor.
      assumptions: upgrade ? readStoredAssumptions(wi.payload) : (opts.assumptions ?? null),
      outcome: upgrade ? 'superseded' : 'attested',
    };
    // Best-effort, and deliberately so on the ATTESTED path: failing to file the second
    // record must not turn a harmless duplicate close into a hard error for the caller. The
    // authoritative record is untouched either way, which is the property that matters.
    await appendCompletionAttestation(
      id,
      wi.payload,
      attestation,
      await resolveWorkItemPhysicalRow(wi, opts.harness),
    ).catch(() => {});
    if (!upgrade) {
      opts.onTerminalConflict?.({
        outcome: 'attested',
        existingOwner: wi.terminalOwner,
        existingAuthority: wi.completionAuthority,
        existingEvidenceSufficient: existingSufficient,
        incomingEvidenceSufficient: incomingSufficient,
        note:
          `work_item '${id}' was ALREADY completed by ${wi.terminalOwner}` +
          `${wi.completionAuthority ? ` (authority:${wi.completionAuthority})` : ''}. Your close was RECORDED ` +
          `AS A SECOND ATTESTATION (payload.${COMPLETION_ATTESTATIONS_KEY}) and did NOT replace theirs — ` +
          `${incomingSufficient ? 'both records meet the evidence bar, and a tie leaves the first standing' : `it does not meet the bar to supersede a stored record (\`committed\` needs verifiedHow plus one of testsRun/testResult)`}. ` +
          `The item's authoritative completion record and terminal state are unchanged. If ${wi.terminalOwner}'s ` +
          `completion is WRONG, correct it deliberately with work_items:set_state { id: '${id}', state: '${state}', force: true } ` +
          `(work_items:complete has no \`force\` arg — WI-4530), or coordinate with them via coord:send.`,
      });
      // The stored record stands, so there is nothing further to write. Returning the
      // re-read row (not the pre-call snapshot) so the caller sees the attestation that was
      // just filed. The settled-event fan-out below is skipped deliberately: the item's
      // state did not change, and a duplicate close should not re-fire `work-item:done`.
      return (await getWorkItem(id, opts.harness)) ?? wi;
    }
    const upgradeDescription =
      decision.upgradeBasis === 'authority'
        ? `equally sufficient evidence with authority:${opts.completionAuthority}, which outranks the stored ` +
          `authority:${wi.completionAuthority}`
        : `strictly richer evidence (verifiedHow plus test results, which theirs lacked)`;
    opts.onTerminalConflict?.({
      outcome: 'upgraded',
      existingOwner: wi.terminalOwner,
      existingAuthority: wi.completionAuthority,
      existingEvidenceSufficient: existingSufficient,
      incomingEvidenceSufficient: incomingSufficient,
      note:
        `work_item '${id}' was already completed by ${wi.terminalOwner}, but your close carries ${upgradeDescription} — ` +
        `it is now the AUTHORITATIVE record. ` +
        `Their record was ARCHIVED to payload.${COMPLETION_ATTESTATIONS_KEY} rather than discarded.`,
    });
    // Fall through: the normal terminal write below installs this richer record.
  }
  // P-006 (fleet-deltas-leader-primitives, EI-8993): an item HELD OPEN by someone
  // (payload.held_open_by — a leader gating it on a release criterion / owner
  // decision) refuses a terminal transition by ANYONE ELSE unless forced. This is
  // the dup-close guard: WI-3546-class items were "held open" only as checkpoint
  // prose, so a well-meaning peer (or a dup-close audit) closed them as stale —
  // the hold is now a FIELD this chokepoint enforces (complete + set_state both
  // route through here). The holder closing their own held item is NOT gated.
  const heldOpen = readWorkItemHeldOpenBy(wi.payload);
  if (
    !opts.force &&
    heldOpen &&
    opts.by !== heldOpen.by &&
    !isSettledWorkItemState(wi.state) &&
    isSettledWorkItemState(state) &&
    // WI-4531: a hold must not outlive its holder. Before refusing, re-derive the SAME
    // liveness rule the 60s sweep uses (work-items-hold-open.ts): if the holder is neither
    // live nor briefly-parked AND the hold is past grace, it is dead residue — lift it inline
    // and let the transition through, rather than making a blocked agent go discover the
    // leader force-clear. Enforcing here (not only in the sweep) means the guard still holds
    // when the sweep is wedged or has not ticked — which is exactly the failure this fixes.
    // Only reached on the rare refusal path, so the extra round-trip costs nothing hot.
    !(await isStaleHoldOpenAndCleared(id, heldOpen, wi.harness ?? undefined, wi.origin))
  ) {
    // WI-4530: name the REAL verbs. This message used to say "or { force: true }", which is
    // true for work_items:set_state but NOT for work_items:complete (it has no `force` arg) —
    // and complete is the tool most callers are holding when they hit this. An error that names
    // an arg the caller's tool does not accept is worse than one that names nothing: it sends
    // them to pass a flag that is silently dropped, and the item stays open.
    // EI-20212312963549018: the caller can reach this branch through a transport identity
    // alias even when the hold is theirs. Lead with the unprivileged self-clear path so the
    // refusal does not teach a holder to use a leader override against their own hold.
    throw new Error(
      `work_item '${id}' is HELD OPEN by ${heldOpen.by}${heldOpen.reason ? ` ("${heldOpen.reason}")` : ''} — ` +
        `closing it into '${state}' requires the holder. ` +
        `If this is your own hold, clear it first without force: ` +
        `work_items:hold_open { id: '${id}', clear: true } — no force needed, then close normally. ` +
        `If the hold is STALE (holder gone/finished), CLEAR it first: ` +
        `work_items:hold_open { id: '${id}', clear: true, force: true, reason: '<why it is stale>' } ` +
        `(leader override — audited, and the holder is notified), then close normally. ` +
        `To close PAST the hold without clearing it: work_items:set_state { id: '${id}', state: '${state}', force: true } ` +
        `— NOTE work_items:complete does NOT accept a \`force\` arg, so passing one there is silently ignored. ` +
        `Otherwise coordinate with the holder (coord:send).`,
    );
  }
  // EI-13715: blockedness has TWO sources of truth for a plan-linked work-item —
  // this item's own `state` column, and its linked plan-item's `effectiveStatus`
  // (payload.plan_item back-pointer; see scheduler/plan-item-lane-guard.ts, the
  // SAME check work_items:claim_next / scheduler:get_next already enforce at
  // claim time). Skipping the plan layer is exactly how a plan-supervised gate
  // gets skipped: a real work-item was unblocked off `externalBlockers: null`
  // while its plan item was still `blocked` on five unresolved drill legs, and
  // the cup it spawned flipped a live hive ahead of the gate whose entire
  // purpose was to precede that flip (reverted within 5 minutes, but only
  // because the completion made the contradiction visible after the fact).
  // Fails OPEN (planItemLaneBlockReason itself fails open on any lookup error,
  // and a non-triggering prior/next state pair skips this read entirely — the
  // common case pays nothing extra).
  //
  // EI-13715 fast-follow #3: the ORIGINAL guard only fired on `isUnblockingTransition`
  // (blocked -> anything else) — it said nothing about an item that was unblocked
  // EARLIER (never literally 'blocked' at this moment: 'todo'/'in_progress') and is
  // now being COMPLETED (work_items:complete, todo -> done/resolved/…) while its
  // linked plan-item is STILL effectively blocked/needs-human (the WI-3503 shape).
  // That gap left work_items:complete free to terminalize an item whose plan gate
  // was never re-checked at the second transition, silently leaving the
  // contradiction for a later reader instead of warning at completion time.
  // `isCompletingTransition` closes it: fire on ANY transition INTO a settled/
  // terminal state when the PRIOR state was not already settled, independent of
  // whether that prior state was literally 'blocked'. work_items:complete has no
  // `force` arg (WI-4530), so the refusal always points callers at
  // work_items:set_state { force: true } instead.
  const isUnblockingTransition = wi.state === 'blocked' && state !== 'blocked';
  const isCompletingTransition = !isSettledWorkItemState(wi.state) && isSettledWorkItemState(state);
  if (!opts.force && (isUnblockingTransition || isCompletingTransition)) {
    const { planItemLaneBlockReason } = await import('./scheduler/plan-item-lane-guard');
    const block = await planItemLaneBlockReason(wi).catch(() => null);
    if (block && block.effectiveStatus !== 'done' && block.effectiveStatus !== 'dropped') {
      const verb = isUnblockingTransition ? 'unblocking' : 'completing';
      const stateDesc = isUnblockingTransition ? `is blocked, and its` : `is not settled, and its`;
      throw new Error(
        `work_item '${id}' ${stateDesc} linked plan-item ${block.planSlug}#${block.itemId} is STILL ` +
          `effectively '${block.effectiveStatus}' (${block.reason}) — ${verb} it into '${state}' now would race ` +
          `ahead of that plan gate. Verify the plan item's blockers are actually resolved first ` +
          `(plans:get-item { slug: '${block.planSlug}', item: '${block.itemId}' }); if they are (or the plan is ` +
          `wrong), override with work_items:set_state { id: '${id}', state: '${state}', force: true } ` +
          `— NOTE work_items:complete does NOT accept a \`force\` arg, so passing one there is silently ignored (WI-4530).`,
      );
    }
  }
  // ── D-019 / P-007 (WI-37958): the REFUSING tier of the live-drive acceptance ──
  // The WARN tier lives at work_items:complete (`liveDriveEvidenceWarning`). It cannot
  // refuse: complete.ts:1108-1116 (D-005 / EI-24) makes that seam record-and-warn by
  // contract, because rejecting the CALL discards the agent's only written account of
  // what it did — a gate that destroys evidence to enforce evidence is self-defeating.
  //
  // THIS seam has the property that one lacks: the completion is already recorded by the
  // time we get here, so refusing the TERMINAL FLIP preserves the evidence, leaves the
  // item open, and tells the agent why. That is what satisfies P-007's "a checklist
  // nobody runs is worth less than a gate that refuses" without violating EI-24.
  //
  // Scoped to OWNER_VISIBLE_SURFACE_FILES (8 named files), NOT every close in the fleet:
  // a gate that fires on everything is one people learn to route around, and a
  // routed-around gate is the checklist this replaces. Keeping the registry small is what
  // buys the refusal its legitimacy.
  //
  // Bypasses, both deliberate: `skipCompletionGate` (trusted system paths — restore,
  // watchdog sweeps, reconcile: "not completions at all", so they carry no evidence to
  // judge) and `force` (the caller asserts the change cannot alter what is rendered).
  const liveDriveRefusal = liveDriveTerminalRefusal({
    id,
    state,
    isCompletingTransition,
    force: opts.force,
    skipCompletionGate: opts.skipCompletionGate,
    evidence: opts.completionEvidence,
  });
  if (liveDriveRefusal) throw new Error(liveDriveRefusal);
  let result: WorkItem | null;
  // Terminal state writes clear the claim before returning the post-state row.
  // Keep the pre-write holder only for the event fanout; the returned WorkItem
  // must continue to report the truthful, unclaimed terminal state.
  const priorAssignee = wi.assignee;
  if (wi.family === 'issue') {
    // WI-10006010: pin the ONE physical row (workspace_id, harness_slug, feature_id) this write
    // may touch — the same row `wi` was read from — and scope every origin heal AND the state
    // write to it. Keyed on feature_id alone, closing one slug twin rewrote all of them.
    const issueWorkspaceId = await resolveIssueWorkspace(id);
    const issueSlug = await resolveIssuePhysicalSlug(
      getOrgPg().sql,
      issueWorkspaceId,
      id,
      opts.harness,
    );
    if (issueSlug === null) return null;
    // EI-19313515375179600 (WI-6822 follow-up): `origin` can flip local→remote well after
    // creation (an unresolved federation/replay-provenance defect, still under investigation —
    // see the work-item's own body). Trusting `origin` ALONE here strands the true author: they
    // wrote the item, `origin` later mislabels it 'remote', and the refusal below sends them to
    // "their authoring peer" — which IS them, on the only node they have.
    //
    // A bare app-level bypass here is NOT enough: `setIssueState` below writes through the
    // `engineer_issues` VIEW, whose INSTEAD OF UPDATE trigger (migration 655,
    // `harness_shared.engineer_issues_view_dml()`) unconditionally no-ops ANY write while the
    // BASE TABLE's `origin='remote'` — it has no identity check at all. Skipping only this
    // app-level guard would silently swap a clear, honest error for a confusing "not found"
    // (the trigger returns 0 rows / NULL). So when the caller IS the recorded author
    // (`createdBy` === `opts.by`), self-heal the base-table `origin` back to 'local' FIRST
    // (scoped tight: only ever touches a row whose OWN recorded author matches the caller —
    // never a row genuinely owned by a different peer) — this un-blocks the trigger for the
    // write that follows.
    if (wi.origin === 'remote' && opts.by && wi.createdBy && opts.by === wi.createdBy) {
      const healed = await selfHealAuthorOriginIfStranded(id, opts.by, {
        workspaceId: issueWorkspaceId,
        harnessSlug: issueSlug,
      });
      if (healed) wi.origin = 'local';
    }
    // EI-22189521072988065: a THIRD stranding, sibling to the two below — the caller
    // is not the row's original creator but IS its recorded `terminal_owner`,
    // re-affirming/upgrading completion evidence on a row that was ALREADY
    // terminal BEFORE this call (`wasAlreadySettled`, computed from `wi.state` as
    // read above — never from the requested `state`, so this can never widen into
    // a fresh-completion bypass). This is exactly the re-send work_items:complete's
    // own advisory instructs after a content-mismatch `proposed` close; the origin
    // flip must not revoke the only repair path the close itself named.
    if (wi.origin === 'remote' && opts.by && wi.terminalOwner && opts.by === wi.terminalOwner) {
      const healed = await selfHealTerminalOwnerOriginIfStranded(id, opts.by, {
        origin: wi.origin,
        wasAlreadySettled: isSettledWorkItemState(wi.state),
        terminalOwner: wi.terminalOwner,
        harnessSlug: issueSlug,
      });
      if (healed) wi.origin = 'local';
    }
    // EI-21919769900781478: the OTHER stranding — the recorded author is a different
    // peer whose session has permanently ENDED, so the refusal below names an authority
    // that no longer exists and the row can never reach a terminal state (while still
    // being served as claimable work). Scoped to TERMINAL closes only via
    // `isCompletingTransition`, so this is not a general remote-mutation bypass, and
    // fail-closed: anything short of a positively observed `ended_at` leaves the refusal
    // standing. Heals the base-table origin (the view trigger noted above) + stamps the
    // close as an orphan-close in the same statement.
    if (wi.origin === 'remote' && isCompletingTransition) {
      const orphan = await healOrphanedRemoteOriginIfAuthorEnded(id, {
        isCompletingTransition,
        by: opts.by ?? null,
        harnessSlug: issueSlug,
      });
      if (orphan.healed) wi.origin = 'local';
    }
    // WI-10003565: the row's author key is one THIS workspace has written locally, so this
    // node IS the authoring peer the refusal below would send the caller to — the same own-node
    // rule the claim gate applies (issueOwnAuthorWhereSql). Without this a system-filed row
    // (createdBy="system:*", matching none of the caller-identity hatches above) whose origin
    // flipped could be claimed but never closed. The UPDATE's WHERE clause is the identity check.
    if (wi.origin === 'remote' && (await selfHealOwnNodeOriginIfStranded(issueWorkspaceId, id, issueSlug))) {
      wi.origin = 'local';
    }
    if (wi.origin === 'remote') {
      throw new Error(
        `work_item '${id}' is remote-authored and cannot be mutated locally; ` +
          `its authoring peer must claim/resolve it, and this node will receive the ` +
          `terminal state through federation.`,
      );
    }
    const updated = await setIssueState(id, state as IssueState, opts.by, opts.completionRef, {
      completionEvidence: opts.completionEvidence,
      blueprintResult,
      acceptedProgramAttempt: opts.acceptedProgramAttempt,
      // P-008 (d): forwarded, or the issue family would silently drop every
      // assumption declaration while the feature family persisted it — a
      // half-verification across FAMILIES, the same defect D-050 forbids across
      // TOOLS.
      assumptions: opts.assumptions,
      skipCompletionGate: opts.skipCompletionGate,
      completionAuthority: opts.completionAuthority,
      force: opts.force,
      // WI-41355: the unified guard above already archives an upgraded
      // issue-family second close before falling through to this writer. Tell
      // the direct-writer guard not to archive that same displaced record a
      // second time; direct setIssueState callers omit the bit and stay guarded.
      secondTerminalCloseHandledByUnified: isSecondTerminalClose,
      terminalReason: requestedTerminalReason,
      harnessSlug: issueSlug,
    });
    result = updated ? issueToWorkItem(updated) : null;
  } else {
    const isTerminal = FEATURE_TERMINAL_STATES.includes(state);
    if (isTerminal && !opts.skipCompletionGate) {
      if (!opts.by || !opts.by.trim()) {
        throw new Error(
          `completion-integrity: work_item '${id}' → '${state}' rejected — a terminal transition requires an owner (by)`,
        );
      }
      // P-004: EITHER a completionRef OR a completion-authority judgement satisfies the
      // gate. The ref half is unchanged for the bare set_state path; the authority half
      // is what work_items:complete now supplies, having DELETED the auto-fill that used
      // to manufacture a ref from completion.summary — which is precisely why this gate
      // could never fail for that path. The judgement is not a softer bar: an absent or
      // partial evidence object now lands `proposed`, which does not count toward
      // burn-down, instead of a `committed` close that reads as finished work.
      if (!opts.completionRef?.trim() && !opts.completionAuthority) {
        throw new Error(
          `completion-integrity: work_item '${id}' → '${state}' rejected — a terminal transition requires ` +
            `either a completionRef or a completion-authority judgement. Prefer work_items:complete ` +
            `{ id, state: '${state}', completion: { summary: '...', verifiedHow: '...', testResult: '...' } }, ` +
            `which judges your evidence and stamps the authority for you.`,
        );
      }
    }
    const evidencePayloadJson = terminalPayloadMergeJson(opts.completionEvidence, opts.assumptions, blueprintResult);
    // EI-21184699633369991 (issue-family twin): a force ref-only correction must not turn a
    // valid completion into an authority:null row. Hoisted out of the SQL below so the
    // derivation and the CASE arm that honours it read the SAME condition.
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
        by: opts.by,
        skipCompletionGate: opts.skipCompletionGate,
        suppliedAuthority: opts.completionAuthority,
        preserveExistingRecord: preserveExistingCompletionRecord,
        evidence: opts.completionEvidence,
      });
    // D-007: a genuine terminal success/drop resets the stale-reclaim requeue
    // counter, so a later legitimate re-open starts fresh with the full cap.
    const resetRequeue = isTerminal;
    // EI-19284963139619048: this UPDATE is the state-write half of EVERY feature-family
    // work_items:complete/set_state call. It used to run on the raw, unbounded
    // `getOrgPg()` admin pool (no statement_timeout — see pg-bounded-txn.ts's header,
    // which documents this EXACT symptom class, "work_items:comment hung, then timed
    // out on a blind retry", already fixed there but never migrated to this equally-hot
    // sibling). Under fleet load a stall here (lock wait, CPU-starved backend, slow
    // scan) ran unbounded and hung the MCP call until the client's own 300s
    // idle-timeout killed it blind, requiring a retry with no diagnostic. boundedOrgTxn
    // sets a real statement_timeout + lock_timeout so a stall now fails fast with a
    // typed OrgTxnTimeoutError instead — which the caller (work_items:complete/
    // set_state) already catches and reports as `stateError` (the completion record is
    // never lost, EI-24).
    const rows = await boundedOrgTxn(async (tx) =>
      isTerminal
        ? await tx<FeatureRowDb[]>`
      UPDATE harness_shared.harness_features_consolidated
         SET status = ${state},
             terminal_reason = COALESCE(${requestedTerminalReason}, terminal_reason),
             requeue_count = 0,
             taken_by = NULL,
             taken_at = NULL,
             -- agent-activity-liveness-truth P-001 (D-001/D-004): a state transition is
             -- REAL item-scoped progress — bump last_progress_at so a held item reads as
             -- progressing, not stalled. A TERMINAL row also releases its claim immediately,
             -- so the progress signal must clear with the holder instead of lingering until a
             -- later stale-claim/placement sweep.
             last_progress_at = NULL,
             updated_ts = ${Date.now()},
             -- WI-6218: a skipCompletionGate write is documented as "not a completion at
             -- all" (watchdog auto-close, system sweep, restore), and the isSecondTerminalClose
             -- guard above deliberately exempts it. But it still reached this UPDATE and
             -- stamped terminal_owner/ref/authority UNCONDITIONALLY — so a system sweep
             -- re-closing an already-completed row took CREDIT for a real agent's completion,
             -- and, because these callers pass no ref/authority, NULLED both alongside it.
             -- There is already a test forbidding such a flip to write a terminal_completion_ref,
             -- on the reasoning that it must stay DISTINGUISHABLE from a genuine completion
             -- (WI-1404); terminal_owner and authority escaped the same reasoning.
             --
             -- PRESERVE-WHEN-PRESENT, not never-stamp: a fresh row keeps today's behaviour
             -- (some restore/sweep callers may legitimately rely on the stamp, and that audit
             -- is not done), while a row already carrying a completion is left alone. Measured
             -- before the fix: 0 damaged rows in 30 days across both arms, so this closes a
             -- LATENT hole rather than repairing live damage — see WI-6222 for the separate
             -- agent-vs-agent damage the guard above now prevents.
             terminal_owner = CASE WHEN ${Boolean(opts.skipCompletionGate)}
                                     THEN COALESCE(NULLIF(terminal_owner, ''), ${opts.by ?? null})
                                   ELSE ${opts.by ?? null} END,
             terminal_completion_ref = CASE WHEN ${Boolean(opts.skipCompletionGate)}
                                              THEN COALESCE(NULLIF(terminal_completion_ref, ''), ${opts.completionRef ?? null})
                                            ELSE ${opts.completionRef ?? null} END,
             -- P-004: the authority judgement for THIS close. NULL when the caller
             -- supplied none — a legacy-shaped close (D-008), which is the right reading
             -- for the skipCompletionGate system paths.
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
             -- WI-1409142: sanitize only the INCOMING patch, and never its completion
             -- evidence. Two separate defects lived in the old
             -- jsonb_strip_nulls(payload || delta):
             --   1. It reached the WHOLE merged payload, deleting explicit nulls from
             --      unrelated EXISTING metadata -- the hazard already documented on
             --      attachCompletionEvidenceToSettledItem and fixed for the issue family
             --      by WI-42437, leaving this path the last one still doing it.
             --   2. jsonb_strip_nulls is RECURSIVE, so it also reached INSIDE the evidence
             --      and deleted _completionEvidence.*.contentIdentity[].headBlobSha and
             --      .workingTreeBlobSha whenever they were legitimately null (a declared
             --      path not yet in HEAD -- the ordinary state when an agent closes before
             --      git-sync sweeps). Those keys are REQUIRED by
             --      CompletionSettlementManifestSchema, so the stored manifest failed
             --      safeParse and completion-settlement-reconciler.ts skipped the row in
             --      silence: 110 closes could never settle out of authority='proposed'.
             -- Stripping the patch minus the evidence keeps WI-42437's intent while the
             -- evidence subtree is merged verbatim, nulls and all.
             payload = CASE WHEN ${evidencePayloadJson}::text::jsonb IS NULL
                            THEN payload
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
       WHERE harness_slug = ${wi.harness} AND feature_id = ${id}
         AND ${opts.acceptedProgramAttempt && operationClaims
           ? operationClaims.programRootEffectWhereSql(tx, opts.acceptedProgramAttempt, {
               payload: 'payload', id: 'feature_id', harness: 'harness_slug',
               status: 'status', updated: 'updated_ts',
             }) : tx`TRUE`}
         AND ${operationClaims && operationEffectRead
           ? operationClaims.operationWorkerEffectWhereSql(tx, operationEffectRead, {
               payload: 'payload', id: 'feature_id', harness: 'harness_slug', holder: 'taken_by',
             }) : tx`TRUE`}
      RETURNING ${tx.unsafe(FEATURE_COLS)}`
        : await tx<FeatureRowDb[]>`
      UPDATE harness_shared.harness_features_consolidated
         SET status = ${state},
             requeue_count = CASE WHEN ${resetRequeue} THEN 0 ELSE requeue_count END,
             last_progress_at = CASE WHEN taken_by IS NOT NULL AND taken_by <> '' THEN now() ELSE last_progress_at END,
             updated_ts = ${Date.now()}
       WHERE harness_slug = ${wi.harness} AND feature_id = ${id}
         AND ${operationClaims && operationEffectRead
           ? operationClaims.operationWorkerEffectWhereSql(tx, operationEffectRead, {
               payload: 'payload', id: 'feature_id', harness: 'harness_slug', holder: 'taken_by',
             }) : tx`TRUE`}
      RETURNING ${tx.unsafe(FEATURE_COLS)}`,
    );
    result = rows[0] ? featureRowToWorkItem(rows[0]) : null;
    // A terminal feature write releases the PRE-write holder. Clear only that
    // holder's matching cached goal: the same owner may have claimed newer work
    // before a delayed lifecycle callback reaches this point.
    if (result && isSettledWorkItemState(result.state) && priorAssignee) {
      clearGoalClaimedIfMatches(priorAssignee, id);
      // Keep the feature-family terminal path symmetric with issue-family terminal
      // writes: taken_by is cleared above, so the claim-next lease must be retired
      // before completion returns or the item remains lease-poisoned until TTL.
      if (wi.harness) {
        await releaseWorkItemLease({ harness: wi.harness, workItemId: id, owner: priorAssignee });
      }
    }
  }
  // P-006 (fleet-deltas-leader-primitives, EI-8973): a REOPEN (settled → non-settled,
  // forced or holder-self) must CLEAR the terminal stamps — a reopened item still
  // carrying terminalOwner/terminalCompletionRef reads as "terminally completed" to
  // every later auditor/peer, which re-closes or releases it as a stale duplicate
  // (the exact loop EI-8973 reports). The stamps are ARCHIVED into
  // payload.reopenHistory (bounded, newest-last) so the audit trail survives the
  // clear. Best-effort: the reopen itself already committed; a failed clear leaves
  // the pre-P-006 behavior (stamps linger) rather than failing the state change.
  //
  // P-004 adds the authority half. A reopen CONTRADICTS the completion that was
  // recorded, and the state table has exactly one honest edge for that: → `invalid`.
  // Note what is deliberately NOT done here: the authority is never cleared back to
  // NULL. `null` on a terminal row means "legacy close, made before this contract" and
  // is exempt from nagging and reclassification (D-005/D-008) — so a live code path that
  // could write NULL would manufacture that exemption on demand, which is the one thing
  // the state table forbids ("nothing returns to null").
  //
  // The converse is equally deliberate: a row whose authority is ALREADY null is a real
  // legacy close, and it stays null through the reopen. Stamping it `invalid` would be
  // retroactively judging a close made in good faith under the old rules — the exact
  // reclassification D-005 exists to prevent.
  //
  // EI-19393880133572803: the archive above used to be PARTIAL — it moved
  // terminalOwner/terminalCompletionRef/completionAuthority into reopenHistory but left
  // payload._completionEvidence (TERMINAL_COMPLETION_EVIDENCE_KEY) and payload._assumptions
  // (TERMINAL_ASSUMPTIONS_KEY) live on the row, because the UPDATE below only ever ADDED
  // reopenHistory via a top-level `||` merge — it never REMOVED those two keys. So a
  // reopened, non-terminal item kept reading as fully verified by a completion that was
  // just retracted (terminalCompletionEvidence is derived straight from
  // payload._completionEvidence at read time — see extractTerminalCompletionEvidence — so it
  // survived untouched). Both are now archived into the SAME entry and stripped from the
  // live payload, so "state != terminal ⇒ no live completion evidence" holds.
  if (
    result &&
    isSettledWorkItemState(wi.state) &&
    !isSettledWorkItemState(result.state) &&
    (wi.terminalOwner || wi.terminalCompletionRef || wi.completionAuthority)
  ) {
    try {
      const { sql } = getOrgPg();
      const prevHistory = Array.isArray((wi.payload as Record<string, unknown> | null)?.reopenHistory)
        ? ((wi.payload as Record<string, unknown>).reopenHistory as unknown[])
        : [];
      const entry = {
        at: new Date().toISOString(),
        by: opts.by ?? null,
        force: opts.force === true,
        prevState: wi.state,
        terminalOwner: wi.terminalOwner,
        terminalCompletionRef: wi.terminalCompletionRef,
        completionAuthority: wi.completionAuthority,
        terminalCompletionEvidence: wi.terminalCompletionEvidence,
        assumptions: readStoredAssumptions(wi.payload),
      };
      const history = JSON.stringify({ reopenHistory: [...prevHistory.slice(-4), entry] });
      // Only a close made UNDER the authority contract can be contradicted into
      // 'invalid'; a legacy (null) close is left exactly as it was. See the block
      // comment above — this ternary is D-005 expressed as a write, not a policy.
      const reopenedAuthority: WorkItemCompletionAuthority | null = wi.completionAuthority === null ? null : 'invalid';
      await sql`
        UPDATE harness_shared.work_items
           SET terminal_owner = NULL,
               terminal_completion_ref = NULL,
               authority = ${reopenedAuthority},
               -- work-item-status-full-unify (P-003): a reopened item is no longer terminal,
               -- so its collapsed-nuance reason must clear too (else a later plain done/dropped
               -- would inherit a stale passed/resolved reason).
               terminal_reason = NULL,
               -- EI-19393880133572803: STRIP the two terminal-only evidence keys before
               -- merging in reopenHistory, so they cannot survive the reopen live on the
               -- row (they were just archived into the entry above).
               payload = (COALESCE(payload, '{}'::jsonb)
                            - ${TERMINAL_COMPLETION_EVIDENCE_KEY}::text
                            - ${TERMINAL_ASSUMPTIONS_KEY}::text)
                         || ${history}::text::jsonb,
               updated_ts = ${Date.now()}
         WHERE feature_id = ${id}
           AND workspace_id IN (${issuesScopeWorkspace()}, ${activeWorkspaceId()})`;
      // Reflect the clear in the returned row so callers see the truth this turn.
      (result as { terminalOwner?: string | null }).terminalOwner = null;
      (result as { terminalCompletionRef?: string | null }).terminalCompletionRef = null;
      (result as { completionAuthority?: WorkItemCompletionAuthority | null }).completionAuthority = reopenedAuthority;
      (result as { terminalCompletionEvidence?: PersistedCompletionEvidence | null }).terminalCompletionEvidence = null;
    } catch {
      /* best-effort — see above */
    }
  }
  // event-await-discoverability-and-coverage P-101: EVERY real status transition
  // fires the general `work-item:status:<id>` — the "wake me on any change of
  // WI-X" signal (a dependency's progress, a peer's item). Complements the
  // specific done/blocked/unblocked/claimed keys below; the catalog's
  // one-entry-one-family model keeps them from being awaited together, so no
  // double-wake. Fire-and-forget + lazy import — an emit failure never breaks
  // the write.
  if (result && result.state !== wi.state) {
    const transitioned = result;
    const prevState = wi.state;
    // EI-21342578761370279: LEAVING a settled state retires that terminal
    // cycle's `work-item:done:<id>` fire latch — left in place it reports
    // `fired_undeclared` against a LIVE (reopened) item and makes the done-gate
    // look already-satisfied. Bounded to latches recorded before this
    // transition so a fast close→reopen→close cannot erase the NEW cycle's
    // row. Unlike the notifications below, this clear is part of the reopen
    // completion boundary: work-item:await may run immediately after this
    // promise resolves, and its registration latch must not observe the retired
    // terminal cycle (EI-21463649981229718). Keep the lazy import to avoid the
    // work-items-events cycle, but await the bounded delete before returning.
    if (isSettledWorkItemState(prevState ?? '')) {
      const reopenedAtMs = Date.now();
      await trackDetached(import('./events/await/store'))
        .then((m) => m.clearKeyFire(`work-item:done:${id}`, { firedBefore: reopenedAtMs }))
        .catch(() => {});
    }
    // WI-10003882: track the whole emit chain, not just the import, so a test's
    // drainDetached() waits for the latch write before it TRUNCATEs or tears down.
    void trackDetached(import('./work-items-events')
      .then((m) =>
        m.emitWorkItemStatusEvent(transitioned, prevState, {
          announceClaimable: opts.announceClaimable,
        }),
      ))
      .catch(() => {});
  }
  // await-event-primitive P-012/P-013: a SETTLED item fires
  // `work-item:done:<id>` (+ `work-item:unblocked:<dep>` for dependents whose
  // last blocker cleared). Fire-and-forget + lazy import (work-items-events
  // imports this module statically) — an emit failure never breaks the write.
  if (result && isSettledWorkItemState(result.state)) {
    const settled = result;
    // state-plane-interest-and-hardening P-013 / D-003: a terminal item (and
    // its linked plan lane) no longer justifies any machinery-armed watches.
    // Await this cleanup: a fire-and-forget miss after the terminal write would
    // have no later lifecycle edge on which to retry.
    // EI-22414305411561114: close the routed-idea feedback loop at the same
    // lifecycle chokepoint used by both work_items:complete and
    // work_items:set_state. The refresh sweep remains the reconciliation
    // backstop, but a freshly terminalized wi: route must not stay actionable
    // until the next sweep. Lazy import avoids a static work-items ↔ Scout
    // module cycle; failures remain best-effort and never undo the close.
    // WI-10003631: the two cleanups are independent, so they run concurrently;
    // both still complete before the settled events below are emitted.
    await Promise.all([
      retireLifecycleBindingsForWorkItem(settled),
      trackDetached(import('./scout/routed-ledger'))
        .then((m) =>
          m.propagateWorkItemOutcome({
            workItemId: settled.id,
            state: settled.state,
            workspaceId: activeWorkspaceId(),
            harnessSlug: settled.harness ?? wi.harness ?? opts.harness ?? null,
          }),
        )
        .catch(() => {}),
    ]);
    void trackDetached(import('./work-items-events')
      .then((m) => m.emitWorkItemSettledEvents(settled, { priorAssignee })))
      .catch(() => {});
    // WI-4119: generated blocker follows are no longer useful once this
    // blocker settles. Keep cleanup on the lifecycle write path so it does not
    // depend on a subscriber's next turn or on the event fan-out succeeding.
    void removeDerivedBlockerSubscriptionsForSettledTarget(workItemObjectRef(settled)).catch(() => {});
    // WI-10003631: both watches below gate on the settled item's topics only. Each
    // used to call getWorkItemDetail (issue probe + row + tags + thread + posts +
    // links, ~6 round trips) just to read `topics`; one shared tag read is
    // equivalent (getWorkItemDetail/getIssueDetail read topics via the same
    // tags.listTags(workItemObjectRef)) and costs one round trip per settle.
    let settledTopics: Promise<string[]> | undefined;
    const readSettledTopics = () => (settledTopics ??= tags.listTags(workItemObjectRef(settled)));
    // sentinel-herald P-016: when a SETTLED item is a Sentinel handoff (carries
    // the `user-requested` topic), report its landing back to the operator via
    // the hindsight "[While you were away]" channel. Same fire-and-forget +
    // lazy-import shape as the settled-events emit; the watch module reads the
    // item's topics (the cheap gate) and no-ops for any non-handoff item.
    void trackDetached(import('./operator-sentinel-handoff-watch'))
      .then((m) =>
        m.reportHandoffLandingIfTracked(
          { id: settled.id, title: settled.title, state: settled.state, harness: settled.harness },
          readSettledTopics,
        ),
      )
      .catch(() => {});
    // voice-unified-sentinel-pipeline P-006: when a SETTLED item is a deep-thinking
    // delegation (carries the `deep-delegation` topic), inject its completion
    // summary back into the Sentinel pane as `[deep-answer WI-NNN] …` so the
    // answer is presented + spoken through the one pipeline. Same fire-and-forget
    // + lazy-import shape; the watch gates on the topic and no-ops otherwise.
    void trackDetached(import('./papercup/papercup-deep-watch'))
      .then((m) =>
        m.injectDeepAnswerIfTracked(
          {
            id: settled.id,
            title: settled.title,
            state: settled.state,
            harness: settled.harness,
            terminalCompletionRef: (settled as { terminalCompletionRef?: string | null }).terminalCompletionRef ?? null,
          },
          readSettledTopics,
        ),
      )
      .catch(() => {});
  }
  // plugin-system-hive-port P-004: a transition INTO `blocked` fires
  // `work-item:blocked:<id>` (notifying the delegator) so blocked work is a
  // durable signal, not a prose message. Same fire-and-forget shape.
  if (result && result.state === 'blocked' && wi.state !== 'blocked') {
    const blocked = result;
    void trackDetached(import('./work-items-events')
      .then((m) => m.emitWorkItemBlockedEvent(blocked)))
      .catch(() => {});
  }
  // EI-15461: a feature transitioning INTO `passed` that was minted by
  // promote-issue.ts (metadata.sourceIssueId) auto-resolves its SOURCE issue —
  // otherwise the promoted issue lingers `open` forever (nothing previously
  // reverse-synced it) and gets re-served to every drain/auto-implement pass
  // as if it were still unfixed. Best-effort + fire-and-forget, same shape as
  // the other post-write hooks above: a failure here never breaks the
  // feature's own settle.
  // work-item-status-full-unify: fire on entering EITHER success-terminal spelling ('passed'
  // legacy, 'done' unified) so the auto-resolve keeps working across the status migration.
  const successTerminal = (s: string | null | undefined) => s === 'passed' || s === 'done';
  if (result && result.family === 'feature' && successTerminal(result.state) && !successTerminal(wi.state)) {
    void autoResolveSourceIssueOnFeaturePassed(id, wi.harness ?? undefined).catch(() => {});
  }
  return result;
}

/**
 * EI-15461: when a promoted F-FIX-NNN feature (minted by promote-issue.ts,
 * which stamps `metadata.sourceIssueId` on the feature row — a column NOT
 * exposed through the generic work-item `payload`/getWorkItem read path, so a
 * dedicated lookup is required) reaches `passed`, auto-resolve the issue it
 * was promoted from. Idempotent (skips an already-terminal issue) and
 * best-effort — every failure is swallowed by the caller.
 */
export async function autoResolveSourceIssueOnFeaturePassed(
  featureId: string,
  harness: string | undefined,
): Promise<void> {
  if (!harness) return;
  const { sql } = getOrgPg();
  const rows = await sql<{ source_issue_id: string | null }[]>`
    SELECT metadata ->> 'sourceIssueId' AS source_issue_id
      FROM harness_shared.harness_features_consolidated
     WHERE harness_slug = ${harness} AND feature_id = ${featureId}
     LIMIT 1`;
  const sourceIssueId = rows[0]?.source_issue_id;
  if (!sourceIssueId) return;
  const issue = await getIssue(sourceIssueId);
  if (!issue || ISSUE_TERMINAL_STATUSES.has(issue.state)) return;
  // work-item-status-full-unify (P-003 writer-flip completeness, caught by the P-008
  // live-verify): route through the UNIFIED writer instead of a raw setIssueState('resolved').
  // setWorkItemState folds 'resolved' → the unified terminal 'done' AND stamps
  // terminal_reason='resolved' (loss-free, consistent with every other resolved→done row) —
  // whereas the direct setIssueState call stored the legacy 'resolved' token verbatim with a
  // NULL terminal_reason, and was the last HOT writer still leaking pre-unification vocab into
  // new rows (~240 fresh 'resolved'-status rows/day at the time of the flip). Fire-and-forget:
  // the caller's `.catch(() => {})` absorbs the writer's completion/remote/plan-lane guards (a
  // remote source issue cannot be resolved locally anyway; a genuinely plan-blocked source
  // issue should not be silently force-terminated).
  await setWorkItemState(sourceIssueId, 'resolved', {
    by: 'system:auto-issue-resolve',
    completionRef: `Auto-resolved: source feature ${featureId} passed (EI-15461).`,
    harness,
  });
}

/** The alias/no-op discriminator every lifecycle verb's result row should carry (EI-7712). */
export interface LifecycleAliasInfo {
  /** True when the item's PERSISTED state (post-write, read back off the row) differs
   *  from what the caller asked for — an ok:true response can still mean "not what you asked". */
  aliased: boolean;
  /** Exactly what the caller passed, before any normalization. */
  requestedState: string;
  /** The state actually persisted (workItem.state read back after the write), or null
   *  when the item was not found (setWorkItemState returned null — a separate failure
   *  mode from aliasing, surfaced by the caller's own `ok:false` path). */
  appliedState: string | null;
  /** Present only when aliased — a human-readable one-liner (kept for callers/tests
   *  already matching on this string; `aliased`/`appliedState` are the structured form). */
  aliasNote?: string;
}

/**
 * EI-9360 (rewired for work-item-status-full-unify P-003): an issue set to a "durably gated"
 * lifecycle state gets a belt-and-suspenders self-select exclusion FLAG applied automatically.
 *
 * Pre-unify, the issue family had no native representation for blocked/needs-human
 * (ISSUE_STATE_ALIASES collapsed them to 'open'), so a caller who correctly marked an item
 * needs_human/blocked got back ok:true with the item STILL in the claimable pool
 * (`scheduler:get_next`/`claim_next` kept offering it — the M4 DRAIN incident where a foreign
 * fleet's fallback spec picked up an owner-gated "rotate the production credential" item). The
 * writer-flip fixes the ROOT cause: the issue now STORES `blocked`/`needs-human` directly, and
 * the claim floor (status = ANY(['open'])) excludes it by status. These payload flags
 * are now the belt-and-suspenders + the surface the EXISTING consumers still read:
 *   - needs-human → the stored status itself excludes the row; strict owner capabilities also
 *     carry `payload.needsOwnerAction:true` ({@link needsOwnerActionExclusionSql}) and report as
 *     fully DRAINED in {@link diagnoseClaimNextMiss}.
 *   - blocked → the WI-2797 self-select claim hold ({@link claimHoldExclusionSql} /
 *     {@link setWorkItemClaimHold}), which also carries the `release{claimHold:false}` un-park
 *     affordance. Reports as pending-BUT-gated (drained:false).
 * Applied by APPLIED state (not the old alias-to-'open' event, which no longer fires). Still
 * directly claimable BY ID. Best-effort — never fails/blocks the primary lifecycle write.
 */

/**
 * setWorkItemState wrapped to ALWAYS report the alias/no-op discriminator (EI-7712,
 * extending the EI-7125/WI-2573 onAlias plumbing that only fired for the ONE mismatch
 * class `normalizeWorkItemState` itself detects). This compares the ACTUAL persisted
 * `workItem.state` read back after the write against what the caller asked for — a
 * strictly BROADER check than trusting `onAlias` alone, so a future silent-divergence
 * bug in a DIFFERENT layer (not the normalize step) still shows up as `aliased:true`
 * instead of a repeat of the WI-2381 incident (ok:true, state silently stayed 'open',
 * only discovered by an unrelated list read 10min later).
 *
 * The shared helper both work_items:set_state and work_items:complete call, so every
 * lifecycle verb inherits the SAME contract instead of each hand-rolling its own
 * onAlias wiring (which is how the gap stayed needs-human-only for as long as it did).
 */
export async function setWorkItemStateWithAliasInfo(
  id: string,
  requestedState: string,
  opts: Parameters<typeof setWorkItemState>[2] = {},
): Promise<{ workItem: WorkItem | null } & LifecycleAliasInfo> {
  const requestedLower = requestedState.trim().toLowerCase().replaceAll('_', '-');
  // Keep the pre-write row for transition-specific cleanup below. The row returned by
  // setWorkItemState is already post-transition, so it cannot tell us whether the
  // blocked auto-gate lease was the state that this call just left.
  const priorWorkItem = await getWorkItem(id, opts.harness);
  let stateToApply = requestedState;
  if (requestedLower === 'needs-human') {
    const current = priorWorkItem;
    if (current?.family === 'issue') {
      const review = readAgentReviewState(current.payload);
      // WI-10006515: `origin` records how a row ARRIVED, not who wrote it. An own-node row
      // stranded at origin='remote' is ours; the canonical writer below heals it, so it must
      // not be short-circuited here as "remote-owned".
      const remoteOwned =
        current.origin === 'remote' &&
        !(await isOwnNodeAuthoredRemoteRow(await resolveIssueWorkspace(id), id));
      if (remoteOwned || review?.status === 'pending' || review?.status === 'revision-requested') {
        return {
          workItem: current,
          aliased: current.state !== requestedState,
          requestedState,
          appliedState: current.state,
          aliasNote:
            remoteOwned
              ? "requested state 'needs-human' was ignored because this item is remote-owned and must reconcile on its authoring peer."
              : "requested state 'needs-human' was ignored because this item is already in agent review.",
        };
      }
      // The canonical writer below refuses unless the existing payload carries a
      // complete structured owner ask. Keep this wrapper free of a second policy.
    }
  }
  let onAliasInfo: { requested: string; resolved: string } | undefined;
  let workItem = await setWorkItemState(id, stateToApply, {
    ...opts,
    onAlias: (info) => {
      onAliasInfo = info;
      opts.onAlias?.(info);
    },
  });
  const appliedState = workItem ? workItem.state : null;
  const aliased = appliedState !== null && appliedState !== requestedState;
  // EI-9360 (rewired, work-item-status-full-unify P-003): key the durable-gate flags on the
  // APPLIED state — the issue now STORES blocked/needs-human directly, so the old
  // alias-to-'open' event no longer fires. Awaited (not fire-and-forget): callers rely on the
  // note meaning the item is ALREADY durably parked by the time this resolves. See the doc
  // comment above. Issue-family only (the feature claim floor honors the status directly).
  let autoGateNote: string | null = null;
  const appliedLower = (appliedState ?? '').trim().toLowerCase();
  if (workItem && workItem.family === 'issue') {
    try {
      if (appliedLower === 'needs-human') {
        await mergeIssuePayload(id, { needsOwnerAction: true }, {
          unset: ['needsHuman'],
          harnessSlug: opts.harness ?? workItem.harness,
        });
        autoGateNote =
          " Its stored status='needs-human' is reserved for a strict typed owner capability; payload.needsOwnerAction is the admission floor and legacy payload.needsHuman was removed.";
        // WI-5689: mergeIssuePayload durably persists payload.needsHuman, but the
        // `workItem` snapshot above was captured BEFORE this write — echoing it back
        // as-is silently reports the STALE pre-merge payload (needsHuman still false)
        // even though the DB row is already correct, indistinguishable from the
        // update.ts sibling bug where the write never landed at all. Re-fetch so the
        // caller's response reflects what was actually persisted.
        const refreshed = await getWorkItem(id, opts.harness);
        if (refreshed) workItem = refreshed;
      } else if (appliedLower === 'blocked') {
        const held = await setWorkItemClaimHold(id, true, { harness: opts.harness, by: opts.by, reason: 'blocked' });
        if (held?.applicable) {
          autoGateNote =
            ' It has been auto-parked (claim hold) out of claim_next/scheduler:get_next self-selection until released — see work_items:release{claimHold:false}.';
        }
      } else if (
        // The blocked auto-gate is a temporary lease, not a durable park. Once the
        // applied state leaves blocked, remove only that lease so an intentional
        // claim_hold_* park can continue to exclude the item from self-selection.
        priorWorkItem?.state === 'blocked' &&
        appliedLower !== 'blocked' &&
        (priorWorkItem.payload as Record<string, unknown> | null)?.held_open_reason === 'blocked'
      ) {
        const cleared = await setWorkItemClaimHold(id, false, { harness: opts.harness, leaseOnly: true });
        if (cleared?.applicable) {
          // setWorkItemState returned the row before this best-effort cleanup. Re-read
          // so callers do not receive a stale `_claimHold`/held_open_* projection after
          // the blocked gate was cleared (or after a durable park was preserved).
          const refreshed = await getWorkItem(id, opts.harness);
          if (refreshed) workItem = refreshed;
        }
      }
    } catch {
      /* best-effort — never fail the primary lifecycle write over the auto-gate */
    }
  } else if (workItem && appliedLower === 'blocked') {
    // EI-19397599078921465: a FEATURE-family item moving to `blocked` recorded NOTHING — no audit
    // row, no payload provenance — so 59 of them sat blocked with no trace of who moved them or
    // when. This is chained as `else if` off the issue branch DELIBERATELY: an issue's blocked
    // transition already audits via the auto-park above (`work_items:claim_hold:set`
    // reason='blocked'), and double-writing would make ONE transition read as TWO in the unified
    // history — worse than the gap it closes. Fire-and-forget, exactly like that auto-park's own
    // audit write; a lifecycle write must never fail over its own bookkeeping.
    const { sql } = getOrgPg();
    void recordWorkItemBlockedAudit(sql, id, {
      to: appliedState ?? 'blocked',
      requested: requestedState,
      family: workItem.family,
      by: opts.by ?? null,
      harness: opts.harness ?? null,
      activeWorkspaceId: activeWorkspaceId(),
    });
  }
  // Surface a note when the state was aliased OR an auto-gate flag was applied (the gate can
  // now fire WITHOUT aliasing, since blocked/needs-human store verbatim post-flip).
  const effectiveAliased = aliased || stateToApply !== requestedState;
  const note = effectiveAliased
    ? onAliasInfo
      ? `requested state '${onAliasInfo.requested}' has no distinct representation for this item's family — recorded as '${onAliasInfo.resolved}' instead.${autoGateNote ?? ''}`
      : `requested state '${requestedState}' was not applied verbatim — recorded as '${appliedState}' instead.`
    : (autoGateNote ?? undefined);
  return {
    workItem,
    aliased: effectiveAliased,
    requestedState,
    appliedState,
    ...(note ? { aliasNote: note } : {}),
  };
}

// ── completion-integrity metric (work-item-completion-integrity-2026-07-01 WI-1405,
// contract C-1 consumer) ─────────────────────────────────────────────────────────
//
// setWorkItemState/setIssueState (above) enforce that a terminal transition carries
// BOTH terminal_owner AND terminal_completion_ref UNLESS the caller explicitly passed
// skipCompletionGate (the watchdog/hygiene/revert dedup-marker paths — WI-1404). That
// means the RAW terminal-state count silently blends genuine completions with dedup
// flips; this read separates them so fleet-facing status never counts a dedup flip as
// real work.

export interface CompletionIntegrityStats {
  harness: string;
  /** Every work-item (both families) currently sitting in a terminal state. */
  terminalTotal: number;
  /** Terminal AND carrying terminal_owner PLUS either a terminal_completion_ref or an
   *  authority judgement — the ONLY rows the completion-integrity gate would have accepted
   *  without skipCompletionGate. P-004 added the authority half: the gate now accepts a
   *  judgement in place of the ref (and work_items:complete no longer supplies a ref at
   *  all), so a ref-only test would report every post-P-004 completion as `dedupOrUnverified`
   *  — a metric that measures the deleted auto-fill rather than completion integrity.
   *  This is NOT a count of new code or durable changes. */
  genuineCompletions: number;
  /** terminalTotal - genuineCompletions — watchdog/hygiene/revert dedup flips (or any
   *  other skipCompletionGate write, or a pre-migration-432 historical row with the
   *  columns still null). */
  dedupOrUnverified: number;
  /**
   * P-013 — terminal rows carrying an `authority` judgement: the count the P-004 gate has
   * actually JUDGED (`work_items:complete` stamps it; the bare state-write path does not).
   *
   * This is the honest completion-integrity KPI, and it is deliberately NOT
   * "% of closes with no evidence" — that rate measures 0.00% and always will. Evidence
   * lands in three different places (the `authority` judgement, `payload._completionEvidence`,
   * and `terminal_completion_ref`), so "does this row have an evidence object" is true for
   * essentially every close — precisely the weak check P-004 replaced ("an 'is the object
   * present?' test passes every one of them", complete.ts). What the metric can honestly
   * report is COVERAGE: how much of the close traffic the judge ever sees.
   *
   * ⚠ `gateJudged` is NOT a compliance score. A close routed through `setWorkItemState`
   * lands unjudged however well evidenced it was, so a low ratio here means "the instrument
   * covers little of the traffic", NOT "agents are closing without evidence". Measured
   * 2026-07-27: 38.2% of that day's agent closes were judged, vs 0.1% the day before.
   */
  gateJudged: number;
  /** Exact terminal-row counts from the closer's optional declaration. The unknown
   *  bucket includes legacy omissions and unrecognized values; it is never imputed
   *  from filesChanged or completion authority. */
  declaredWorkOutcomes: {
    introducedChange: number;
    verifiedExisting: number;
    duplicate: number;
    invalidOrExpected: number;
    otherNoNewChange: number;
    unknown: number;
  };
}

/**
 * Read the genuine-vs-dedup completion split for one harness. Feature-family rows are
 * scoped by activeWorkspaceId() + harness_slug (mirrors setWorkItemState's own scope);
 * issue-family rows by issuesScopeWorkspace() (mirrors setIssueState's own scope) — the
 * two families use different workspace conventions today (F-B2 / ISSUES_PER_WORKSPACE),
 * so a single workspace_id filter would silently miss or leak rows for one family.
 */
export async function getCompletionIntegrityStats(harness: string): Promise<CompletionIntegrityStats> {
  const { sql } = getOrgPg();
  type StatsRow = {
    terminal_total: string;
    genuine: string;
    judged: string;
    introduced_change: string;
    verified_existing: string;
    duplicate: string;
    invalid_or_expected: string;
    other_no_new_change: string;
  };
  const [featureRows, issueRows] = await Promise.all([
    sql<StatsRow[]>`
      SELECT
        count(*) FILTER (WHERE status = ANY(${FEATURE_TERMINAL_STATES}::text[])) AS terminal_total,
        count(*) FILTER (
          WHERE status = ANY(${FEATURE_TERMINAL_STATES}::text[])
            AND terminal_owner IS NOT NULL AND terminal_owner <> ''
            AND ((terminal_completion_ref IS NOT NULL AND terminal_completion_ref <> '') OR authority IS NOT NULL)
        ) AS genuine,
        count(*) FILTER (
          WHERE status = ANY(${FEATURE_TERMINAL_STATES}::text[]) AND authority IS NOT NULL
        ) AS judged,
        count(*) FILTER (WHERE status = ANY(${FEATURE_TERMINAL_STATES}::text[])
          AND payload #>> '{_completionEvidence,workOutcome}' = 'introduced-change') AS introduced_change,
        count(*) FILTER (WHERE status = ANY(${FEATURE_TERMINAL_STATES}::text[])
          AND payload #>> '{_completionEvidence,workOutcome}' = 'verified-existing') AS verified_existing,
        count(*) FILTER (WHERE status = ANY(${FEATURE_TERMINAL_STATES}::text[])
          AND payload #>> '{_completionEvidence,workOutcome}' = 'duplicate') AS duplicate,
        count(*) FILTER (WHERE status = ANY(${FEATURE_TERMINAL_STATES}::text[])
          AND payload #>> '{_completionEvidence,workOutcome}' = 'invalid-or-expected') AS invalid_or_expected,
        count(*) FILTER (WHERE status = ANY(${FEATURE_TERMINAL_STATES}::text[])
          AND payload #>> '{_completionEvidence,workOutcome}' = 'other-no-new-change') AS other_no_new_change
      FROM harness_shared.harness_features_consolidated
      WHERE workspace_id = ${activeWorkspaceId()} AND harness_slug = ${harness}`,
    sql<StatsRow[]>`
      SELECT
        count(*) FILTER (WHERE state = ANY(${[...ISSUE_TERMINAL_STATUSES]}::text[])) AS terminal_total,
        count(*) FILTER (
          WHERE state = ANY(${[...ISSUE_TERMINAL_STATUSES]}::text[])
            AND terminal_owner IS NOT NULL AND terminal_owner <> ''
            AND ((terminal_completion_ref IS NOT NULL AND terminal_completion_ref <> '') OR authority IS NOT NULL)
        ) AS genuine,
        count(*) FILTER (
          WHERE state = ANY(${[...ISSUE_TERMINAL_STATUSES]}::text[]) AND authority IS NOT NULL
        ) AS judged,
        count(*) FILTER (WHERE state = ANY(${[...ISSUE_TERMINAL_STATUSES]}::text[])
          AND payload #>> '{_completionEvidence,workOutcome}' = 'introduced-change') AS introduced_change,
        count(*) FILTER (WHERE state = ANY(${[...ISSUE_TERMINAL_STATUSES]}::text[])
          AND payload #>> '{_completionEvidence,workOutcome}' = 'verified-existing') AS verified_existing,
        count(*) FILTER (WHERE state = ANY(${[...ISSUE_TERMINAL_STATUSES]}::text[])
          AND payload #>> '{_completionEvidence,workOutcome}' = 'duplicate') AS duplicate,
        count(*) FILTER (WHERE state = ANY(${[...ISSUE_TERMINAL_STATUSES]}::text[])
          AND payload #>> '{_completionEvidence,workOutcome}' = 'invalid-or-expected') AS invalid_or_expected,
        count(*) FILTER (WHERE state = ANY(${[...ISSUE_TERMINAL_STATUSES]}::text[])
          AND payload #>> '{_completionEvidence,workOutcome}' = 'other-no-new-change') AS other_no_new_change
      FROM harness_shared.engineer_issues
      WHERE workspace_id = ${issuesScopeWorkspace()} AND scope = ${`harness:${harness}`}`,
  ]);
  const terminalTotal = Number(featureRows[0]?.terminal_total ?? 0) + Number(issueRows[0]?.terminal_total ?? 0);
  const genuineCompletions = Number(featureRows[0]?.genuine ?? 0) + Number(issueRows[0]?.genuine ?? 0);
  const gateJudged = Number(featureRows[0]?.judged ?? 0) + Number(issueRows[0]?.judged ?? 0);
  const outcomeCount = (key: keyof Pick<StatsRow,
    'introduced_change' | 'verified_existing' | 'duplicate' | 'invalid_or_expected' | 'other_no_new_change'>) =>
    Number(featureRows[0]?.[key] ?? 0) + Number(issueRows[0]?.[key] ?? 0);
  const introducedChange = outcomeCount('introduced_change');
  const verifiedExisting = outcomeCount('verified_existing');
  const duplicate = outcomeCount('duplicate');
  const invalidOrExpected = outcomeCount('invalid_or_expected');
  const otherNoNewChange = outcomeCount('other_no_new_change');
  return {
    harness,
    terminalTotal,
    genuineCompletions,
    dedupOrUnverified: terminalTotal - genuineCompletions,
    gateJudged,
    declaredWorkOutcomes: {
      introducedChange,
      verifiedExisting,
      duplicate,
      invalidOrExpected,
      otherNoNewChange,
      unknown: terminalTotal - introducedChange - verifiedExisting - duplicate - invalidOrExpected - otherNoNewChange,
    },
  };
}

// ── live-verified marker (release-pipeline-resilience-2026-06-09 P-013) ──────────
//
// "done" on a pipeline/operator work-item means code-on-staging; its VALUE only exists once
// DEPLOYED + exercised. live_verified is an ADDITIVE payload marker (NOT a new lifecycle state —
// the core enum is deliberately untouched, D-013 sketch) recording that a human/agent confirmed the
// change live: { at, by, testedSha?, deployedSha?, greenPinSha?, parity?, evidence? }. Feature-family only (the dispatched backlog the
// plan targets); issue-family items report applicable:false without writing.

/**
 * The narrow refresh seam for plan-item text rewrites. General feature-family
 * updates deliberately remain pipeline-owned; this writer is only for the
 * post-commit plan-drift path, where the plan editor has already established
 * the new semantic text.
 *
 * One UPDATE keeps title, summary, the plan-item fingerprint, and the compiled
 * brief on the same row-version. The WHERE clause is intentionally redundant:
 * the physical feature-family table is the family guard, while the exact
 * payload/source predicates prevent a plan edit from retargeting an unrelated
 * work-item with a reused id. A source-column-only row gets a complete payload
 * stamp; an existing payload stamp is patched only at its hash leaf, so all
 * other stamp fields and unrelated payload keys survive unchanged.
 */
export interface RefreshPlanLinkedFeatureWorkItemInput {
  workItemId: string;
  harnessSlug: string;
  planSlug: string;
  itemId: string;
  itemText: string;
  /**
   * The freshly compiled plan-context brief. Omitted means preserve the
   * existing brief; null/empty removes a previously compiled brief whose plan
   * context no longer has enrichment.
   */
  compiledBrief?: string | null;
}

/** Return true when the guarded refresh matched and updated one feature row. */
export async function refreshPlanLinkedFeatureWorkItem(input: RefreshPlanLinkedFeatureWorkItemInput): Promise<boolean> {
  const workItemId = input.workItemId.trim();
  const harnessSlug = input.harnessSlug.trim();
  const planSlug = input.planSlug.trim();
  const itemId = input.itemId.trim();
  if (!workItemId || !harnessSlug || !planSlug || !itemId) return false;

  // These helpers live in plan-items/convert, which imports this facade for
  // the mint path. Keep the dependency lazy so loading the facade cannot form
  // an initialization cycle; the module is cached after the first refresh.
  const [{ planItemTitle }, { planItemTextHash }] = await Promise.all([
    import('./plan-items/convert'),
    import('./plan-items/text-drift'),
  ]);
  const title = planItemTitle(input.itemText);
  const itemTextHash = planItemTextHash(input.itemText);
  const { sql } = getOrgPg();

  const existingStampPayload =
    itemTextHash !== undefined
      ? sql`
          jsonb_set(
            COALESCE(payload, '{}'::jsonb),
            '{plan_item,item_text_hash}',
            ${JSON.stringify(itemTextHash)}::text::jsonb,
            true
          )
        `
      : sql`
          COALESCE(payload, '{}'::jsonb) #- '{plan_item,item_text_hash}'
        `;
  // The ::text casts below are load-bearing, not style. jsonb_build_object is VARIADIC "any",
  // so an uncast parameter is rejected at PARSE time ("could not determine data type of
  // parameter $N") on every call — postgres.js sends OID 0 for a JS string (inferType), so only
  // the cast supplies a type. Without them this whole refresh threw unconditionally, and
  // text-drift-report's `catch {}` swallowed it silently, so plan-item text drift never
  // refreshed the linked work-item. See sql-variadic-any-uncast-param.test.ts.
  const sourceStamp =
    itemTextHash !== undefined
      ? sql`
          jsonb_build_object(
            'plan_slug', ${planSlug}::text,
            'item_id', ${itemId}::text,
            'harness_slug', ${harnessSlug}::text,
            'item_text_hash', ${JSON.stringify(itemTextHash)}::text::jsonb
          )
        `
      : sql`
          jsonb_build_object(
            'plan_slug', ${planSlug}::text,
            'item_id', ${itemId}::text,
            'harness_slug', ${harnessSlug}::text
          )
        `;
  const stampedPayload = sql`
    CASE
      WHEN COALESCE(payload, '{}'::jsonb) ? 'plan_item' THEN ${existingStampPayload}
      ELSE COALESCE(payload, '{}'::jsonb) || jsonb_build_object('plan_item', ${sourceStamp})
    END
  `;
  const nextPayload =
    input.compiledBrief === undefined
      ? stampedPayload
      : input.compiledBrief
        ? sql`
            jsonb_set(
              ${stampedPayload},
              '{brief}',
              ${JSON.stringify(input.compiledBrief)}::text::jsonb,
              true
            )
          `
        : sql`${stampedPayload} - 'brief'`;

  const rows = await sql<{ feature_id: string }[]>`
    UPDATE harness_shared.harness_features_consolidated
       SET title = ${title},
           summary = ${input.itemText},
           payload = ${nextPayload},
           updated_ts = ${Date.now()}
     WHERE workspace_id = ${activeWorkspaceId()}
       AND harness_slug = ${harnessSlug}
       -- This table is the feature-family relation. Keep the item-kind guard
       -- explicit as defense in depth for compatibility-view regressions;
       -- generic feature kinds and historical research-task rows remain valid.
       AND (item_kind IS NULL OR item_kind <> ALL(${ISSUE_FAMILY_KINDS as string[]}::text[]))
       AND feature_id = ${workItemId}
       AND (
         (
           COALESCE(payload, '{}'::jsonb)->'plan_item'->>'plan_slug' = ${planSlug}
           AND COALESCE(payload, '{}'::jsonb)->'plan_item'->>'item_id' = ${itemId}
         )
         OR (
           NOT (COALESCE(payload, '{}'::jsonb) ? 'plan_item')
           AND source_plan_slug = ${planSlug}
           AND ${itemId} = ANY(COALESCE(source_plan_item_ids, ARRAY[]::text[]))
         )
       )
     RETURNING feature_id
  `;
  return rows.length > 0;
}

export interface WorkItemLiveVerified {
  /** epoch ms the live-verification was recorded. */
  at: number;
  /** who confirmed it (ownerId / actor). */
  by: string;
  /** the exact commit whose gate/test verdict is being relied upon. */
  testedSha?: string | null;
  /** the deployed commit verified against (from release:deploy status / dev:pipeline_position). */
  deployedSha?: string | null;
  /** the green pin independently read when the marker was recorded. */
  greenPinSha?: string | null;
  /** present only for markers that passed the tested = deployed = green parity guard. */
  parity?: 'matched' | null;
  /** free-text proof — what was exercised, where. */
  evidence?: string | null;
}

export interface WorkItemLiveVerifiedResult {
  id: string;
  /** false ⇒ a non-feature-family item (no dispatched-backlog payload to mark); nothing was written. */
  applicable: boolean;
  liveVerified: WorkItemLiveVerified | null;
}

/** Read the live_verified marker off a work-item payload (null if unset / malformed). */
export function readWorkItemLiveVerified(payload: unknown): WorkItemLiveVerified | null {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const lv = (payload as Record<string, unknown>).live_verified;
    if (lv && typeof lv === 'object' && !Array.isArray(lv)) {
      const m = lv as Record<string, unknown>;
      if (typeof m.at === 'number' && typeof m.by === 'string') {
        return {
          at: m.at,
          by: m.by,
          testedSha: typeof m.testedSha === 'string' ? m.testedSha : null,
          deployedSha: typeof m.deployedSha === 'string' ? m.deployedSha : null,
          greenPinSha: typeof m.greenPinSha === 'string' ? m.greenPinSha : null,
          parity: m.parity === 'matched' ? 'matched' : null,
          evidence: typeof m.evidence === 'string' ? m.evidence : null,
        };
      }
    }
  }
  return null;
}

/**
 * Set (marker) or clear (marker=null) a work-item's live_verified payload marker. An additive JSONB
 * merge that PRESERVES the rest of the payload (e.g. the plan_item back-pointer); clear removes only
 * the `live_verified` key. Feature-family only — a non-feature item returns applicable:false without
 * writing. Returns null when the item does not exist. Does NOT touch the lifecycle state column.
 */
export async function setWorkItemLiveVerified(
  id: string,
  marker: WorkItemLiveVerified | null,
  opts: { harness?: string } = {},
): Promise<WorkItemLiveVerifiedResult | null> {
  const wi = await getWorkItem(id, opts.harness);
  if (!wi) return null;
  if (wi.family !== 'feature') {
    return { id: wi.id, applicable: false, liveVerified: readWorkItemLiveVerified(wi.payload) };
  }
  const { sql } = getOrgPg();
  let rows: FeatureRowDb[];
  if (marker === null) {
    rows = await sql<FeatureRowDb[]>`
      UPDATE harness_shared.harness_features_consolidated
         SET payload = COALESCE(payload, '{}'::jsonb) - 'live_verified',
             updated_ts = ${Date.now()}
       WHERE harness_slug = ${wi.harness} AND feature_id = ${id}
      RETURNING ${sql.unsafe(FEATURE_COLS)}`;
  } else {
    const patch = JSON.stringify({ live_verified: marker });
    rows = await sql<FeatureRowDb[]>`
      UPDATE harness_shared.harness_features_consolidated
         SET payload = COALESCE(payload, '{}'::jsonb) || ${patch}::text::jsonb,
             updated_ts = ${Date.now()}
       WHERE harness_slug = ${wi.harness} AND feature_id = ${id}
      RETURNING ${sql.unsafe(FEATURE_COLS)}`;
  }
  const updated = rows[0] ? featureRowToWorkItem(rows[0]) : null;
  if (!updated) return null;
  return { id: updated.id, applicable: true, liveVerified: readWorkItemLiveVerified(updated.payload) };
}

/**
 * EI-7214 — persist a completion's `outputPayload` onto the work-item row (under
 * `payload.out`), so it becomes a self-serve, queryable read surface (e.g. the
 * harness `GET /api/harness/:slug/work-items` route, which already returns
 * `payload`) instead of existing ONLY as a transient field on the `emits` event
 * result. Before this, every harness sidecar needing to pull a completed item's
 * structured output (oddsmith's bet-analysis Signal, quartermaster's sidecar⇄
 * papercusp seam) had to hand-roll its OWN reaction-rule bridge to capture the
 * event at completion time — `fetchCompleted` shipped as a permanent TODO for
 * exactly this reason. One additive JSONB merge here removes that whole class
 * of per-harness boilerplate.
 *
 * Additive (mirrors `setWorkItemLiveVerified`): preserves every other payload
 * key (e.g. the plan_item back-pointer). Best-effort from the caller's
 * perspective — never throws; a merge failure must not fail the completion
 * that already recorded the completion record. Works across BOTH families
 * (feature-family rows live in harness_features_consolidated; issue-family
 * rows route through the existing `mergeIssuePayload`).
 */
export async function mergeWorkItemOutputPayload(
  id: string,
  outputPayload: unknown,
  opts: { harness?: string } = {},
): Promise<void> {
  try {
    const wi = await getWorkItem(id, opts.harness);
    if (!wi) return;
    if (wi.family === 'issue') {
      await mergeIssuePayload(id, { out: outputPayload }, { harnessSlug: opts.harness ?? wi.harness });
      return;
    }
    const { sql } = getOrgPg();
    const patch = JSON.stringify({ out: outputPayload });
    await sql`
      UPDATE harness_shared.harness_features_consolidated
         SET payload = COALESCE(payload, '{}'::jsonb) || ${patch}::text::jsonb,
             updated_ts = ${Date.now()}
       WHERE harness_slug = ${wi.harness} AND feature_id = ${id}`;
  } catch {
    // Best-effort: the completion record itself already succeeded/emitted;
    // a failed payload-persist must never surface as a failed completion.
  }
}

/** Additively merge a top-level payload patch across BOTH work-item families.
 * Unlike the completion-specific wrapper above this is strict: callers need to
 * know whether the typed state was persisted.
 *
 * `opts.unset` REMOVES top-level keys, and it is the only correct way to clear
 * one. Merging `{ key: null }` does NOT clear a key — jsonb `||` stores a JSON
 * null, so the key REMAINS PRESENT and every existence-shaped reader still sees
 * a stamp (measured: `'{"plan_item":{…}}'::jsonb || '{"plan_item":null}'::jsonb`
 * leaves `? 'plan_item'` TRUE *and* `-> 'plan_item' IS NOT NULL` TRUE, because
 * `->` yields `'null'::jsonb`, which is not SQL NULL). Both idioms are live in
 * this repo — `? 'plan_item'` in the claim floors and `IS NOT NULL` in
 * plan-item-coverage — so a null-merge produces a stamp that still admits/holds
 * the row while its `->>'plan_slug'` reads NULL: a corrupt half-stamp that is
 * strictly worse than the wrong stamp it meant to remove. (EI-20578964155166663)
 *
 * Unset is applied AFTER the merge in the same statement, so a key named in both
 * ends up removed, and merge+unset stay atomic (no read-modify-write race). */
export async function mergeWorkItemPayload(
  id: string,
  patchValue: Record<string, unknown>,
  opts: { harness?: string; unset?: readonly string[] } = {},
): Promise<WorkItem | null> {
  const wi = await getWorkItem(id, opts.harness);
  if (!wi) return null;
  const unset = [...new Set(opts.unset ?? [])];
  const clearingPlanItem = unset.includes('plan_item');
  const settingPlanItem = clearingPlanItem ? null : planItemSourceFromPayloadPatch(patchValue);
  if (wi.family === 'issue') {
    await mergeIssuePayload(id, patchValue, { unset, harnessSlug: opts.harness ?? wi.harness });
  } else {
    const featureHarness = wi.harness?.trim();
    if (!featureHarness) {
      throw new Error(`mergeWorkItemPayload: feature-family work-item ${id} has no harness`);
    }
    const { sql } = getOrgPg();
    const patch = JSON.stringify(patchValue);
    const workspaceId = activeWorkspaceId();
    const updatePayload = (db: OrgSql) => db<{ ok: number }[]>`
      UPDATE harness_shared.harness_features_consolidated
         SET payload = (COALESCE(payload, '{}'::jsonb) || ${patch}::text::jsonb) - ${unset}::text[],
             -- A promoted feature has the same three admission identities as an
             -- issue: payload.plan_item, normalized source-plan columns, and a
             -- coord coverage edge. Keep the row representations atomic on both
             -- SET and CLEAR (EI-21551365156148780 / EI-21215740738650819).
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
             updated_ts = ${Date.now()}
       WHERE workspace_id = ${workspaceId}
         AND harness_slug = ${featureHarness}
         AND feature_id = ${id}
      RETURNING 1 AS ok`;

    if (clearingPlanItem) {
      // Snapshot only the row-represented refs under a lock, clear all row
      // identities, then retract only their relates/implements coverage edges
      // in the same bounded transaction. A separate hand-authored plan edge is
      // preserved because its ref is absent from this exact outgoing snapshot.
      await boundedOrgTxn(async (tx) => {
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
            FROM harness_shared.harness_features_consolidated
           WHERE workspace_id = ${workspaceId}
             AND harness_slug = ${featureHarness}
             AND feature_id = ${id}
           FOR UPDATE`;
        if (!prior[0]) return;

        const updated = await updatePayload(tx);
        if (!updated[0]) return;

        const refs = new Set<string>();
        const before = prior[0];
        if (before.payload_plan_slug && before.payload_item_id) {
          refs.add(`${before.payload_plan_slug}#${before.payload_item_id}`);
        }
        if (before.source_plan_slug) {
          for (const itemId of before.source_plan_item_ids ?? []) {
            if (itemId) refs.add(`${before.source_plan_slug}#${itemId}`);
          }
        }
        if (refs.size > 0) {
          await tx`
            DELETE FROM harness_shared.coord_links
             WHERE workspace_id = ANY(${implementsLinkScopes()})
               AND src_kind = ${FEATURE_KIND}
               AND src_ref = ${featureRef(featureHarness, id)}
               AND dst_kind = 'plan_item'
               AND dst_ref = ANY (${[...refs]})
               AND rel = ANY (ARRAY['relates', 'implements'])`;
        }
      });
    } else {
      await updatePayload(sql as OrgSql);
    }
  }
  return getWorkItem(id, opts.harness);
}

/**
 * Rebind a plan-promoted feature lane whose fleet reservation points at a fleet
 * that was never created.
 *
 * `fleet:launch-on-plan` reserves promoted rows before its admission gate and
 * creates the fleet only after that gate passes. A refused launch can therefore
 * leave an open, unclaimed row stamped for a fleet that does not exist. A later
 * launch under a different fleet slug must be able to adopt that orphan, but it
 * must never steal a reservation from a persisted fleet.
 *
 * Keep the proof and write in ONE statement: the row must still be open,
 * unclaimed, plan-promoted, stamped to a different fleet, and that currently
 * stamped fleet must have no durable registry row. The compare-and-set shape
 * also prevents a stale application read from authorizing the mutation.
 */
export async function rebindOrphanedPlanFleetReservation(input: {
  id: string;
  harness: string;
  workspaceId: string;
  fleetSlug: string;
}): Promise<boolean> {
  const fleetSlug = input.fleetSlug.trim();
  if (!fleetSlug) throw new Error('rebindOrphanedPlanFleetReservation: empty fleetSlug');
  const { sql } = getOrgPg();
  const rows = await sql<{ feature_id: string }[]>`
    UPDATE harness_shared.harness_features_consolidated AS feature
       SET payload = jsonb_set(
             COALESCE(feature.payload, '{}'::jsonb),
             '{fleet_slug}'::text[],
             to_jsonb(${fleetSlug}::text),
             true
           ),
           updated_ts = ${Date.now()}
     WHERE feature.workspace_id = ${input.workspaceId}
       AND feature.harness_slug = ${input.harness}
       AND feature.feature_id = ${input.id}
       AND (CASE WHEN feature.status = 'todo' THEN 'open' ELSE feature.status END) = 'open'
       AND (feature.taken_by IS NULL OR feature.taken_by = '')
       AND COALESCE(feature.payload, '{}'::jsonb) ? 'plan_item'
       AND COALESCE(feature.payload, '{}'::jsonb) ? 'fleet_slug'
       AND feature.payload ->> 'fleet_slug' IS DISTINCT FROM ${fleetSlug}
       AND NOT EXISTS (
         SELECT 1
           FROM harness_shared.agent_fleets registered
          WHERE registered.workspace_id = feature.workspace_id
            AND registered.fleet_slug = feature.payload ->> 'fleet_slug'
       )
    RETURNING feature.feature_id`;
  return rows.length > 0;
}

/**
 * Claimable.claim — the tuple-space atomic `in` for a SPECIFIC item (feature → taken_by;
 * issue → assignee). Atomic compare-and-claim (fleet-as-supervised-blackboard D-004):
 * the feature-family UPDATE only succeeds when the item is unclaimed OR already held by
 * this same assignee (idempotent). A competing claim on a held item gets null — exactly
 * one agent wins, instead of the old last-write-wins overwrite where both "won".
 */
export async function claimWorkItem(
  id: string,
  assignee: string,
  opts: {
    harness?: string;
    /** Authenticated assigning actor, supplied by a dispatch after admission checks. */
    assignedBy?: string;
    /**
     * EI-20731607691070897 — ATOMIC SELF-HELD TRANSFER. The compare-and-claim below
     * only matches an UNHELD row, so a holder handing their own item to a named peer
     * (`work_items:claim { id, assignee: peer }`) was refused as `claim_conflict`
     * against THEMSELVES. The only path left was release → peer-claims, and that
     * release drops the item to UNASSIGNED and fleet-claimable: on a fleet with a
     * scheduler actively handing out claimable work, the peer can lose it to a third
     * agent in the gap. There is no other transfer primitive (`coord:handoff` records
     * a transition note; `work_items:request_release` is the OPPOSITE direction;
     * `work_items:update` has no assignee), so the gap could not be closed elsewhere.
     *
     * Passing the CALLER here widens the CAS by exactly one disjunct — the caller's
     * OWN claim — so the handoff lands in the SAME UPDATE that would have claimed an
     * unheld row: no release window, nothing observable in between. It can never move
     * a THIRD party's claim: the row still has to match `= fromHolder`.
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
     * EI-22345414208647835 — opaque capability minted by work_items:claim
     * after its checked force guard authorizes replacing the exact holder.
     * It bypasses only the born-pending admission floor; the expected-holder
     * CAS and feature-family G2/origin floor still apply.
     */
    forceTakeoverAdmission?: ForceTakeoverAdmission;
    /** EI-226378: scheduler-minted authorization for one exact legacy downgrade marker. */
    legacyFleetScopeDowngradeAdmission?: LegacyFleetScopeDowngradeAdmission;
    /** Agent-review-only exception for the exact pending review snapshot being picked up. */
    agentReviewAdmission?: AgentReviewClaimAdmission;
  } = {},
): Promise<WorkItem | null> {
  // EI-23701433507513915: the WRITE backstop — a truncated su- owner id is never persisted as
  // `taken_by`. Every assign path funnels through here (the claim tool's `assignee`,
  // plan-items:assign, dispatch): expand to the unique full owner id, or refuse the claim
  // (null, this function's existing refusal) rather than store a prefix that every exact
  // holder check will later mistake for someone else.
  {
    let scopeWorkspace: string | null = null;
    try {
      scopeWorkspace = activeWorkspaceId() ?? null;
    } catch {
      scopeWorkspace = null; // unscoped lookup: an ambiguous prefix still refuses
    }
    const canonical = await canonicalizeAssigneeOwnerId(assignee, { workspaceId: scopeWorkspace });
    if (!canonical.ok) return null;
    assignee = canonical.ownerId;
  }
  // EI-1545: resolve the issue-scope workspace ONCE, up front, and reuse that SAME
  // value for both the existence/family check below AND the actual claimIssue()
  // write. resolveIssuesScopeWorkspace()/issuesScopeWorkspace() re-derive their
  // answer on every call (a cached ISSUES_PER_WORKSPACE flag that self-heals on a
  // 3s TTL via a fire-and-forget refresh, layered on activeWorkspaceId()'s own
  // request-scope-dependent resolution — see its WI-5261 doc comment). Calling it
  // TWICE in one claim — once here via getIssueInWorkspace, once more inside a
  // bare claimIssue() — let the two calls legitimately disagree a few ms apart:
  // the pre-check would find the row under one resolved workspace while the
  // UPDATE (and, upstream in work_items:claim, the post-failure re-read) used a
  // DIFFERENT one, missing a row that plainly exists — reported as a bare "not
  // found" for an item `work_items:get`/`work_items:complete` (each a single,
  // standalone lookup) still resolve fine. Already fixed for the self-select path
  // (claimNextIssueWorkItem, EI-6480/WI-5261's explicitActiveWorkspaceId); this
  // applies the same one-resolve-per-operation discipline to the by-id path.
  const issueWs = resolveIssuesScopeWorkspace();
  const issue = await getIssueInWorkspace(issueWs, id);
  let claimed: WorkItem | null;
  let prior: WorkItem | null = null;
  if (issue) {
    prior = issueToWorkItem(issue);
    // P-007 / D-021: a verification task (payload.verification) is never claimable by
    // its own reporter or implementer. This is the by-id writer every assign path
    // funnels through, so the refusal holds for claim, assign and dispatch alike.
    if (verificationTaskConflict(prior.payload, assignee)) return null;
    const agentReviewAdmission = matchesAgentReviewClaimAdmission(opts.agentReviewAdmission, prior, assignee)
      ? opts.agentReviewAdmission
      : null;
    // EI-217141: thread only the server-derived current-leader dispatch
    // capability into the issue mutation. Feature-family rows have no
    // assignedBy provenance, so they never mint this exception and keep the
    // ordinary admission floor below unchanged.
    const leaderDispatchAdmission = prior.assignedBy
      ? await deriveLeaderDispatchAdmission(prior, assignee, issueWs)
      : null;
    // EI-218293: the fleet admission seam already allows a member to absorb a
    // server-attributed bug it filed itself, but claimIssue also has to carry that
    // decision across its born-pending SQL floor. Keep this separate from leader
    // dispatch: a self-filed bug is not leader-authorized work.
    const selfFiledFalloutAdmission =
      prior.kind === 'bug' && prior.createdBy
        ? await deriveSelfFiledFalloutAdmission(
            // `prior` is a WorkItem, whose `kind` spans the whole work-item union;
            // the helper takes the narrower EngineerIssue shape. The guard above has
            // already narrowed BOTH discriminants (`kind` to 'bug', `createdBy` to
            // non-null), but that narrowing applies to the properties, not to the
            // object type, so `prior` itself is still the wider shape. Hand over
            // exactly the three fields the helper reads rather than widening its
            // parameter — widening would let a feature-family row reach a path whose
            // first act is to assert `kind === 'bug'`.
            { id: prior.id, kind: prior.kind, createdBy: prior.createdBy },
            assignee,
            issueWs,
          )
        : null;
    const updated = await claimIssue(id, assignee, {
      workspaceId: issueWs,
      ...(opts.assignedBy ? { assignedBy: opts.assignedBy } : {}),
      fromHolder: opts.fromHolder,
      expectedAssignee: opts.expectedAssignee,
      forceTakeoverAdmission: opts.forceTakeoverAdmission,
      ...(isLeaderDispatchAdmission(leaderDispatchAdmission) ? { leaderDispatchAdmission } : {}),
      ...(isSelfFiledFalloutAdmission(selfFiledFalloutAdmission) ? { selfFiledFalloutAdmission } : {}),
      ...(opts.legacyFleetScopeDowngradeAdmission
        ? { legacyFleetScopeDowngradeAdmission: opts.legacyFleetScopeDowngradeAdmission }
        : {}),
      ...(agentReviewAdmission ? { agentReviewAdmission } : {}),
    });
    claimed = updated ? issueToWorkItem(updated) : null;
  } else {
    const wi = await getFeatureWorkItemOnly(id, opts.harness);
    if (!wi) return null;
    prior = wi;
    if (verificationTaskConflict(prior.payload, assignee)) return null;
    const operationClaims = await import('./blueprint/operation-worker-binding');
    const operationClaimRead = await operationClaims.readActiveOperationWorkerClaimBinding(activeWorkspaceId(), assignee);
    if (!operationClaims.matchOperationWorkerClaim(operationClaimRead, wi).allowed) return null;
    const agentReviewAdmission = matchesAgentReviewClaimAdmission(opts.agentReviewAdmission, prior, assignee)
      ? opts.agentReviewAdmission
      : null;
    const { sql } = getOrgPg();
    const expectedAssignee = opts.expectedAssignee?.trim() || null;
    // ws scopes the P-010 trust subquery in autoPickableWhereSql (D-004 — explicit,
    // never RLS-reliant). The UPDATE itself keys on (harness_slug, feature_id) (the PK).
    const ws = activeWorkspaceId();
    const admissionFloor = agentReviewAdmission
      ? sql`(
          ${admittedWhereSql(sql)}
          OR ${agentReviewPendingAdmissionSql(sql, agentReviewAdmission, {
            payload: 'target.payload',
            admission: 'target.admission',
          })}
        )`
      : admittedWhereSql(sql);
    const rows = await withPgContentionRetry(() => sql<FeatureRowDb[]>`
      UPDATE harness_shared.harness_features_consolidated AS target
         SET payload = CASE
               WHEN target.taken_by = ${assignee}
                 OR (target.taken_by IS NOT NULL AND target.taken_by <> '' AND position(target.taken_by in ${assignee}) = 1)
               THEN target.payload
               ELSE jsonb_set(
                 COALESCE(target.payload, '{}'::jsonb),
                 '{claim_history_post_id}',
                 to_jsonb(COALESCE((
                   SELECT max(post.id)
                     FROM harness_shared.coord_thread_posts post
                    WHERE post.workspace_id = ${ws}
                 ), 0)),
                 true
               )
             END,
             taken_by = ${assignee}, taken_at = now(),
             -- P-001: a NEW holder starts with a clean progress slate (so the grace
             -- window anchors on the fresh taken_at, not a prior holder's stale
             -- last_progress_at); a re-claim by the SAME agent (including a
             -- EI-21921431863111143 self-heal of a truncated ownerId) keeps its progress.
             last_progress_at = CASE
               WHEN taken_by = ${assignee}
                 OR (taken_by IS NOT NULL AND taken_by <> '' AND position(taken_by in ${assignee}) = 1)
               THEN last_progress_at ELSE NULL END,
             updated_ts = ${Date.now()}
       WHERE harness_slug = ${wi.harness} AND feature_id = ${id}
         AND ${operationClaims.operationWorkerClaimWhereSql(sql, operationClaimRead, {
           payload: 'target.payload', id: 'target.feature_id', harness: 'target.harness_slug',
         })}
         -- EI-20731607691070897: fromHolder (the CALLER) is the atomic self-held
         -- transfer leg -- see the opts doc on claimWorkItem. When it is absent it
         -- falls back to the assignee, making this disjunct a duplicate of the one
         -- before it, so the predicate stays equivalent to its pre-change behavior.
         --
         -- EI-21921431863111143: the last disjunct self-heals a TRUNCATED taken_by
         -- (some assignment path persisted a prefix of the real ownerId instead of
         -- the canonical full one). A stored taken_by that is a non-empty strict
         -- prefix of the incoming assignee can only realistically BE that same
         -- caller's own truncated id (ownerId collisions of this shape are not a
         -- realistic risk — see isSelfOwnerRecord), so the match both lets the true
         -- owner re-claim its own item and rewrites taken_by to the full id here.
         AND (
           taken_by IS NULL OR taken_by = ''
           OR taken_by = ${assignee}
           OR taken_by = ${opts.fromHolder ?? assignee}
           ${expectedAssignee ? sql` OR taken_by = ${expectedAssignee}` : sql``}
           OR (taken_by IS NOT NULL AND taken_by <> '' AND position(taken_by in ${assignee}) = 1)
         )
         -- G2 admission (shared-hive-trust-admission P-003): an explicit named claim
         -- can't bypass the auditor either — remote, un-admitted stays unclaimable
         -- (unless its verified author is trusted — P-010 trust leg, ws-scoped).
         AND ${autoPickableWhereSql(sql, ws)}
         -- P-009 / D-022 pt 4 / D-024: a named claim cannot take a row that is not agent
         -- work at all (a record, document or event, or human-audience work such as
         -- email-draft-proposal). Category half only: readiness floors stay off this path.
         AND ${agentWorkCategoryWhereSql(sql, 'target')}
         -- P-002 born-pending: duplicate screening is a second, orthogonal gate.
         AND ${(() => {
           const forceAdmission =
             isForceTakeoverAdmission(opts.forceTakeoverAdmission) &&
             opts.forceTakeoverAdmission.itemId === id &&
             opts.forceTakeoverAdmission.target === assignee &&
             opts.forceTakeoverAdmission.workspaceId === ws &&
             opts.forceTakeoverAdmission.expectedAssignee === expectedAssignee
               ? opts.forceTakeoverAdmission
               : null;
          return forceAdmission
            ? sql`(
                  ${admissionFloor}
                  OR (admission = 'pending' AND taken_by = ${forceAdmission.expectedAssignee})
                )`
             : admissionFloor;
         })()}
      RETURNING ${sql.unsafe(FEATURE_COLS)}`);
    claimed = rows[0] ? featureRowToWorkItem(rows[0]) : null;
  }
  // plugin-system-hive-port P-004: a successful claim fires `work-item:claimed:<id>`
  // (events:await leg; reaction rules observe the claim tools via postInvoke).
  if (claimed) {
    const won = claimed;
    const priorHolder = prior?.assignee?.trim() || null;
    const explicitTransferHolder =
      priorHolder &&
      priorHolder !== assignee &&
      ([opts.fromHolder?.trim(), opts.expectedAssignee?.trim()].includes(priorHolder) ? priorHolder : null);
    // EI-21190135248554341: an atomic prior-holder transfer bypasses the stale-claim
    // sweep, so release only that holder's declared paths here. The helper is dynamic
    // and fail-open: a side lock-store outage must not turn a successful CAS transfer
    // into a failed claim, and the lock TTL remains the fallback for that outage.
    if (explicitTransferHolder) {
      try {
        const [{ releaseReclaimedWorkItemLocks }, { readWorkItemPaths }] = await Promise.all([
          import('./work-item-lock-release'),
          import('./work-items-release-request'),
        ]);
        const lockRelease = await releaseReclaimedWorkItemLocks({
          ownerId: explicitTransferHolder,
          paths: readWorkItemPaths(prior?.payload),
          goalRef: won.id,
        });
        if (lockRelease.failures > 0) {
          console.warn(
            `[claim] ${won.id}: targeted lock release had ${lockRelease.failures} failure(s); transfer continues with lock TTL fallback`,
          );
        }
      } catch (error) {
        console.warn(
          `[claim] ${won.id}: targeted lock cleanup unavailable; transfer continues with lock TTL fallback (${error instanceof Error ? error.message : String(error)})`,
        );
      }
    }
    if (priorHolder && priorHolder !== assignee) {
      const events = await import('./work-items-events');
      await events.emitClaimReleasedEventAwaited(prior!, { announceClaimable: false });
      await import('./interest-auto-arm')
        .then(({ retireInterestEventAwaits }) =>
          retireInterestEventAwaits({ kind: 'work-item-claim', ref: won.id }, priorHolder),
        )
        .catch(() => {});
    }
    won.interestWatch = await armWorkItemHolderInterests(won, assignee);
    void trackDetached(import('./work-items-events')
      .then((m) => m.emitWorkItemClaimedEvent(won, assignee)))
      .catch(() => {});
    // P-009 / D-011 / D-014: "claiming IS declaring the goal" — so the goal ref
    // is stamped from here, the ONE chokepoint every by-id claim path funnels
    // through (work_items:claim, claim_next, pickup, scheduler:get_next), rather
    // than hand-patched into each tool. Same durability argument as the `auto`
    // stamp in coordination/messages.ts: the next claim path anyone adds is
    // covered for free and cannot silently leave the goal unstamped.
    noteGoalClaimed(assignee, won.id);
  }
  return claimed;
}

/**
 * True when a recorded holder/assignee string identifies the SAME agent as
 * `caller`'s own full ownerId — either an exact match, or `recorded` is a
 * non-empty STRICT PREFIX of `caller` (EI-21921431863111143). Some assignment
 * paths (observed: a fleet leader's dispatch write) persist a truncated
 * ownerId instead of the canonical full one, which previously deadlocked the
 * item against its own assignee: `not_holder`/`claim_conflict` did a strict
 * string comparison and reported the caller as a DIFFERENT, live peer.
 *
 * A prefix collision with a genuinely different agent is not a realistic risk:
 * ownerIds are `su-<uuid>`-shaped, so two independently-generated ids sharing
 * an identical prefix is astronomically unlikely, and the match can only ever
 * be true for the ONE caller whose own id the truncated form is a prefix of.
 */
export function isSelfOwnerRecord(recorded: string | null | undefined, caller: string): boolean {
  const holder = recorded?.trim();
  if (!holder) return false;
  if (holder === caller) return true;
  return caller.length > holder.length && caller.startsWith(holder);
}

/**
 * Why did `claimWorkItem`/`claimIssue` return null? (EI-2197.)
 *
 * The compare-and-claim returns a bare `null` for THREE very different outcomes,
 * and the claim TOOLS historically flattened all of them into the single
 * misleading message `work_item '<id>' not found` — which sent agents into a
 * pointless retry-with-harness dance (the id WAS resolvable via get/observe/
 * comment/complete) and HID the real signal (lost a race / a dead claim needs
 * taking over). This classifier re-reads the item's CURRENT state and names the
 * outcome so the tool can return an accurate, actionable error:
 *
 *   • not_found — genuinely absent (get also returns null).
 *   • conflict  — exists, held by ANOTHER agent. The caller lost the
 *     compare-and-claim race, OR the holder is dead (→ the stale-claim reclaim
 *     lane frees it; don't blind-retry — coordinate, or take over once freed).
 *   • gated     — exists, NOT held, but the claim was refused by the
 *     feature-family admission/trust gate (autoPickableWhereSql), or a race just
 *     released it between the failed claim and this re-read.
 *
 * Pure over the already-fetched row so it unit-tests without a DB. A self-held
 * item re-claims idempotently (claim would have SUCCEEDED), so reaching here with
 * holder === claimer is not a real conflict — reported as `gated` for safety.
 * EI-21921431863111143: "self-held" is decided by `isSelfOwnerRecord`, so a
 * recorded holder that is a truncated prefix of the caller's own id is treated
 * the same as an exact match, not as a live peer's conflicting claim.
 */
export type ClaimFailure =
  | { reason: 'not_found'; holder: null }
  | { reason: 'conflict'; holder: string }
  | { reason: 'gated'; holder: null };

/**
 * P-009 / D-024 — explain a by-id claim refused by the CATEGORY half of the work predicate.
 * Returns the row's nature/audience when the feature-family row exists and is NOT agent work
 * by category (nature 'work' AND audience 'agent'); null when it is agent work or absent.
 * The test is the same SQL function the claim UPDATE applies (agentWorkCategoryWhereSql), so
 * the explanation cannot disagree with the refusal. Read-only and diagnostic: it never
 * changes a claim verdict, it only names one.
 */
export async function readNonAgentWorkCategory(
  id: string,
  harness: string,
): Promise<{ nature: string; audience: string | null } | null> {
  const { sql } = getOrgPg();
  const rows = await sql<{ nature: string; audience: string | null }[]>`
    SELECT nature, audience FROM harness_shared.work_items
     WHERE workspace_id = ${activeWorkspaceId()} AND harness_slug = ${harness} AND feature_id = ${id}
       AND NOT ${agentWorkCategoryWhereSql(sql, null)}
     LIMIT 1`;
  return rows[0] ?? null;
}

export function classifyClaimFailure(current: { assignee?: string | null } | null, claimer: string): ClaimFailure {
  if (!current) return { reason: 'not_found', holder: null };
  // EI-15027: normalize the "unassigned" sentinel here too (defense-in-depth: the
  // row-mapping layer — issueToWorkItem/featureRowToWorkItem — already does this via
  // normalizeTakenBy, but this function's `current` param is a bare structural type
  // any caller can pass directly, not necessarily one that went through the mapping).
  const holder = normalizeTakenBy(current.assignee ?? null)?.trim();
  if (holder && !isSelfOwnerRecord(holder, claimer)) return { reason: 'conflict', holder };
  return { reason: 'gated', holder: null };
}

export interface ClaimNextFilter {
  harness: string;
  assignee: string;
  /** Restrict to one feature-family kind (default: any feature-family). */
  kind?: FeatureFamilyKind;
  /** Claimable states (default ['open'] — the unified claimable token, work-item-status-full-unify). */
  states?: string[];
  /**
   * THIS Swarm's id (hive-coordination-model P-002, the co-location lever). When set,
   * the claim HONORS each item's `swarm_affinity`: work affined to a DIFFERENT Swarm is
   * skipped, and work affined to THIS Swarm is preferred over unaffined work. The caller
   * passes this ONLY when the per-Hive claim lease is active
   * (the `WORKITEM_CLAIM_LEASE` flag); omitted (the single-instance default) the claim
   * is byte-identical to before — oldest-first, affinity ignored.
   */
  swarmId?: string;
  /**
   * Skip HIGH-STAKES (redundancy > 1) items so they are NOT exclusively claimed
   * (decentralized-dispatch-scaling P-014). A redundant item is dispatched via
   * `work_items:claim_replica` to N Swarms instead — claim_next grabbing it exactly-once
   * would defeat the redundancy. The caller passes this ONLY when the redundancy flag is on
   * (`PAPERCUSP_WORKITEM_REDUNDANCY=1`); omitted (the default) the claim never reads the
   * `redundancy` column, byte-identical to before.
   */
  excludeRedundant?: boolean;
  /**
   * WI-2796: the caller actually has (or coordinates) a live ≥2-machine / Hetzner
   * federation rig, so items carrying `payload.needs_2_machine_rig:true` should NOT be
   * excluded from self-select for it. Omitted (the single-box default) ⇒ those items
   * are excluded — see {@link crossMachineRigExclusionSql}.
   */
  rigAvailable?: boolean;
  /** EI-13524: claimant fleet authorized to draw its own fleet-stamped plan lane. */
  claimantFleetSlug?: string;
  /** EI-13524: the active claim spec structurally names `fleet` and may adopt that lane. */
  claimSpecReferencesFleet?: boolean;
  /** EI-21398324268952860: the spec structurally names `goal` and may adopt that plan lane. */
  claimSpecReferencesGoal?: boolean;
}

/**
 * The GLOBAL HARD FLOORS of a feature-family self-select, as ONE composable `sql`
 * WHERE fragment (hybrid-bee-scheduler-work-stealing-2026-06-22 D-002/D-010). These
 * are the system-enforced eligibility gates a bee's claim-spec can NARROW + REORDER
 * but can NEVER override or re-assert: workspace + feature-family kind, G2 admission,
 * unclaimed, claimable status, swarm affinity, redundancy fan-out, and the readiness
 * `NOT EXISTS` blocking clause (P-005, the F1 split-brain fix).
 *
 * Extracted so the deterministic spec-driven resolver (`scheduler/get-next.ts`) ANDs
 * in the IDENTICAL floors — there is exactly one definition, so a floor can never
 * drift between the two claim paths. The fragment references columns UNQUALIFIED
 * (and the blocking subquery references the table by its full name), so it is only
 * valid composed into an inner SELECT over `harness_shared.harness_features_consolidated`.
 *
 * The active built-in kind floor lives in `frontierPlacementKindClause`: `feature`
 * plus explicitly opted-in generic datatypes. Historical `chunk` rows are never in
 * this self-selection frontier, regardless of a caller-supplied narrowing.
 */
export interface ClaimFloorsOpts {
  harness: string;
  /** The active workspace id (scopes both the row filter and the admission trust leg). */
  workspaceId: string;
  /** Claimable statuses (default ['open'] — the unified claimable token, work-item-status-full-unify). */
  states?: string[];
  /** THIS Swarm's id — when set, honors per-item swarm_affinity (per-Hive lease). */
  swarmId?: string;
  /** Skip high-stakes (redundancy > 1) items (redundancy flag on). */
  excludeRedundant?: boolean;
  /**
   * work-item-deps-and-readiness P-005: when true (SCHEDULER_MAINTAINED_READY on), read readiness
   * from the maintained `work_item_blocked` sidecar (an indexed anti-join) instead of the inline
   * per-claim NOT EXISTS over work_item_deps + statuses. Behavior-identical; a performance cutover.
   * Both claim entry points (claimNextWorkItem + getNextWorkItem) resolve the flag and pass it here,
   * so the two paths can never drift (D-002). Default/false ⇒ the inline predicate (byte-identical).
   */
  useMaintainedReady?: boolean;
  /**
   * Release-cooldown floor (fleet-scheduler-hardening-2026-07-03 P-005 / EI-6956): when set to
   * the CLAIMING agent's ownerId, a row THIS agent voluntarily released within the cooldown
   * window is excluded — for this agent only; every other agent can claim it instantly. Kills
   * the claim/release ping-pong (release resets a row to `todo`, and under a stable rank it
   * sorts right back to the top for the same bee). Both claim entry points thread their
   * claimant here, so the two paths share one cooldown.
   */
  cooldownAssignee?: string;
  /**
   * EI-14806 / WI-2796: the caller has/coordinates a live ≥2-machine rig. When omitted/false
   * (the single-box default), a feature-family row tagged `payload.needs_2_machine_rig:true`
   * is excluded from self-select (see {@link crossMachineRigExclusionSql}); true makes the
   * floor a no-op so rig work surfaces. Threaded from every feature-family claim entry point
   * (getNextWorkItem, claimNextWorkItem) + the READY leg of diagnoseClaimNextMiss, so the
   * feature-family floor matches the long-standing issue-family one and the two never drift.
   */
  rigAvailable?: boolean;
  /** EI-13524: claimant fleet authorized to draw its own fleet-stamped plan lane. */
  claimantFleetSlug?: string;
  /** EI-13524: the active claim spec structurally names `fleet` and may adopt that lane. */
  claimSpecReferencesFleet?: boolean;
  /** EI-21398324268952860: the spec structurally names `goal` and may adopt that plan lane. */
  claimSpecReferencesGoal?: boolean;
}

/** Release-cooldown window (seconds). Env-overridable; small on purpose — the floor only
 *  has to outlast one release→re-pull cycle, not park the item. */
export function releaseCooldownSec(): number {
  const v = Number(process.env.PAPERCUSP_RELEASE_COOLDOWN_SEC ?? 300);
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 300;
}

/** WI-5939 — FILING-GRACE window (seconds): how long a newly-filed issue-family row is held
 *  back from EVERY agent EXCEPT its filer. Env-overridable; 0 disables the leg entirely.
 *
 *  WHY: filing IS publishing. An agent that files a bug and then starts fixing it without
 *  claiming it first races the whole drain fleet, and the race is decided in seconds — it has
 *  been lost twice in one session by agents who knew the rule. `work_items:create` /
 *  `improvements:capture` both take `assign_to:'self'` (the atomic, zero-window fix, and still
 *  the right one), but nothing protected the filer who does not yet KNOW they will fix it. */
export function filingGraceSec(): number {
  const v = Number(process.env.PAPERCUSP_FILING_GRACE_SEC ?? 600);
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 600;
}

/**
 * THE per-claim cooldown floor for the ISSUE family — one fragment, `wi.`-qualified, shared by
 * every issue-family claim/preview/diagnosis site so they cannot drift apart. Two reasons, ONE
 * floor (WI-5939 is explicit: "extend the EXISTING cooldown floor … do not add a parallel
 * mechanism", and its acceptance names `excludedBreakdown.cooldown`):
 *
 *   (a) RELEASE cooldown (mig 499 / EI-6956) — THIS caller released the row moments ago, so it
 *       is gated for THIS caller only, long enough to outlast one release→re-pull cycle.
 *   (b) FILING grace (WI-5939) — someone ELSE filed the row moments ago; its filer gets a head
 *       start to claim their own file-then-fix before the pool takes it.
 *
 * Both legs are caller-relative, which is why neither lives in the SQL SSOT
 * (`harness_shared.work_item_claim_floors` takes no claimant and documents itself as the
 * UNCONDITIONAL floors "modulo per-claim rig/swarm/redundancy/cooldown"). Do NOT add this to
 * migration 759's function or the `work_items_claimable` view: that view answers "claimable by
 * SOMEONE", and a claimant-relative floor there would be wrong for every reader.
 *
 * FAIL-OPEN in every unknown: no assignee, no filer recorded, or no `created_ts` all ADMIT the
 * row. The failure mode being avoided is a permanently unclaimable item nobody can diagnose.
 * The filer's id lives at `payload->'_ei'->>'created_by'` — the base table has no `created_by`
 * column at all; the `engineer_issues` VIEW derives it from that same `_ei` fold (mig 374).
 */
export function issueCooldownExclusionSql(
  sql: OrgSql,
  assignee: string | undefined,
  cooldownSec: number = releaseCooldownSec(),
  graceSec: number = filingGraceSec(),
) {
  const legacyReleaseLeg =
    assignee && cooldownSec > 0
      ? sql`(wi.last_released_by IS NULL
             OR wi.last_released_by <> ${assignee}
             OR wi.last_released_at IS NULL
             OR wi.last_released_at < now() - make_interval(secs => ${cooldownSec}))`
      : sql`TRUE`;
  // Migration 1055: the legacy columns are a compatibility fallback, while the
  // keyed sidecar preserves cooldowns for every releasing agent independently.
  // Both predicates must pass so a peer release cannot erase this caller's row.
  const sidecarReleaseLeg =
    assignee && cooldownSec > 0
      ? sql`NOT EXISTS (
          SELECT 1
            FROM harness_shared.work_item_release_cooldowns rc
           WHERE rc.workspace_id = wi.workspace_id
             AND rc.harness_slug = wi.harness_slug
             AND rc.feature_id = wi.feature_id
             AND rc.agent_id = ${assignee}
             AND rc.released_at >= now() - make_interval(secs => ${cooldownSec})
        )`
      : sql`TRUE`;
  const releaseLeg = sql`(${legacyReleaseLeg} AND ${sidecarReleaseLeg})`;
  const filingGraceLeg =
    assignee && graceSec > 0
      ? sql`(wi.payload -> '_ei' ->> 'created_by' IS NULL
             OR wi.payload -> '_ei' ->> 'created_by' = ${assignee}
             OR wi.created_ts IS NULL
             OR to_timestamp(wi.created_ts / 1000.0) < now() - make_interval(secs => ${graceSec}))`
      : sql`TRUE`;
  return sql`(${releaseLeg} AND ${filingGraceLeg})`;
}

/**
 * The watchdog AUTO-CLOSE recovery-window floor for ISSUE-family self-selection
 * (EI-20106946822538304). A watchdog-sourced item is not useful work while the
 * auto-close sweep is still gathering enough evidence to decide whether its signal
 * recovered. This fragment is an INCLUDE/PASS predicate: it excludes only an
 * eligible `<source>:<key>` candidate whose exact newest six ran ticks all have
 * non-NULL `known_open_keys` and none contain that key.
 *
 * Every malformed, keyless, ineligible, short, NULL-bearing, or key-present history
 * fails OPEN. Empty arrays are valid absence evidence. The candidate's workspace is
 * used for the tick history so one workspace cannot suppress another. Keep this in
 * the cycle-safe work-items leaf: importing auto-close.ts here would cycle through
 * issues-engineer.ts. The source allowlist and six-tick window are shared from the
 * leaf constants module instead.
 */
export function watchdogRecoveryWindowExclusionSql(sql: OrgSql) {
  const eligibleSources = [...AUTO_CLOSE_ELIGIBLE_SOURCES];
  const minTicks = AUTO_CLOSE_DEFAULT_MIN_TICKS;
  const watchdogKey = `COALESCE(wi.payload, '{}'::jsonb) ->> 'watchdogKey'`;
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
           WHERE wt.workspace_id = wi.workspace_id
             AND wt.status = 'ran'
           ORDER BY wt.tick_at DESC, wt.id DESC
           LIMIT ${minTicks}
        ) recovery_ticks
    )
  )`;
}

export function claimFloorsWhereSql(sql: OrgSql, opts: ClaimFloorsOpts) {
  // work-item-status-full-unify (2026-07-19) P-004/P-005: the claimable-floor DEFAULT is the
  // single unified token ['open'] — `open` is the claimable status for BOTH families now
  // (feature `todo`→`open` applied by migration 638; the create-path + reaper write 'open';
  // migration 642 rewrote every stored spec's `states` todo→open). The transitional
  // ['todo','open'] union is retired. An explicit opts.states still narrows further.
  //
  // ⚠ This comment used to add "no writer produces 'todo' and no row sits at it". BOTH
  // halves were false. Two raw INSERTs bypassing createWorkItem
  // were doing exactly that (EI-21460610464031791) — the plan-run minter stranded 15
  // trigger/heartbeat rows between 2026-08-12 and 2026-08-25 before it was rewritten onto
  // canonical promotion (4b0d4cc344), and blueprint-run-action's work-item mode was armed
  // with the same defect. MEASURED 2026-08-26: 28 feature-family rows still sit at 'todo'
  // (the settled 2026-06/07 legacy set FEATURE_NON_REQUEUE_STATES deliberately protects).
  // Read-fold the retired feature-family alias below so a regressed writer cannot mint a
  // PERMANENTLY UNCLAIMABLE row. Keep the public caller allowlist canonical (`open`, not
  // `todo`): the compatibility belongs at this storage boundary, not in every claim spec.
  // Do NOT drop the 'todo' entry from FEATURE_NON_REQUEUE_STATES on the strength of this
  // comment — verify against the table:
  //   SELECT status, count(*) FROM harness_shared.work_items
  //    WHERE item_kind IN ('feature','chunk') GROUP BY status;
  const states = opts.states ?? ['open'];
  const cooldown = releaseCooldownSec();
  const releaseCooldownFloor =
    opts.cooldownAssignee && cooldown > 0
      ? sql`(
          (
            last_released_by IS NULL
            OR last_released_by <> ${opts.cooldownAssignee}
            OR last_released_at IS NULL
            OR last_released_at < now() - make_interval(secs => ${cooldown})
          )
          AND NOT EXISTS (
            SELECT 1
              FROM harness_shared.work_item_release_cooldowns rc
             WHERE rc.workspace_id = harness_shared.harness_features_consolidated.workspace_id
               AND rc.harness_slug = harness_shared.harness_features_consolidated.harness_slug
               AND rc.feature_id = harness_shared.harness_features_consolidated.feature_id
               AND rc.agent_id = ${opts.cooldownAssignee}
               AND rc.released_at >= now() - make_interval(secs => ${cooldown})
          )
        )`
      : sql`TRUE`;
  return sql`
    harness_slug = ${opts.harness}
    AND workspace_id = ${opts.workspaceId}
    -- Release-cooldown floor (mig 485 / EI-6956 + migration 1055): retain the
    -- legacy single-stamp fallback and AND the keyed per-agent sidecar anti-join.
    -- Rows released by another agent remain eligible for this caller; a peer can
    -- no longer overwrite this caller's cooldown in the shared row stamp.
    AND ${releaseCooldownFloor}
    -- Feature-family agent work only: not issue-routed, and nature work / audience agent
    -- through the single work predicate (frontierPlacementKindClause, P-009 / D-022).
    AND ${frontierPlacementKindClause(sql, opts.workspaceId)}
    -- G2 admission (shared-hive-trust-admission P-002): never self-select a remote,
    -- un-admitted item — the same gate the feature frontier enforces (P-010 trust leg,
    -- ws-scoped via the same ws this query filters on).
    AND ${autoPickableWhereSql(sql, opts.workspaceId)}
    -- P-002 born-pending: pending items stay out of every feature self-select path.
    AND ${admittedWhereSql(sql)}
    -- P-013/D-012 stop-the-line: while this harness's gate-red-streak condition item has
    -- been open >24h, feature-family self-select on the harness pauses entirely (the
    -- consolidated view has no condition_key column and placement kinds carry no repair
    -- lane — repair flows through the issue family's exempt classes). By-id claims and
    -- other harnesses are unaffected. Same shared fragment as the issue family's
    -- ok_stop_line, composed for this relation's unaliased context.
    AND ${stopTheLineExclusionSql(sql, 'feature-consolidated')}
    AND (taken_by IS NULL OR taken_by = '')
    AND (CASE WHEN status = 'todo' THEN 'open' ELSE status END) = ANY(${states}::text[])
    -- P-006 (fleet-deltas-leader-primitives): the claim-hold floor, extended to the
    -- FEATURE family. The issue-family claim already honors payload._claimHold
    -- (claimHoldExclusionSql, WI-2797) — but the incident class that motivated
    -- held_open_by (EI-8993: a leader-held FEATURE like WI-3548 getting claim_next'd
    -- off the leader the moment its claim lapsed) lived on THIS path, which never
    -- read the tag. Same COALESCE-for-NULL-safety shape, unaliased (this fragment
    -- runs in harness_features_consolidated context).
    AND COALESCE(payload, '{}'::jsonb) ->> '_claimHold' IS DISTINCT FROM 'true'
    -- D-003/P-004: work awaiting peer review, or returned to its submitter for revision,
    -- belongs exclusively to the agent-review lifecycle. Approval re-admits the row.
    AND ${agentReviewNormalExclusionSql(sql, 'payload')}
    -- EI-19441925633833456: the HIVE-CANARY floor. A canary (payload.canary=true) is a
    -- MEASUREMENT INSTRUMENT for "does the autonomous loop carry queued work end-to-end?",
    -- so an agent self-selecting it and completing it does not answer that question — it
    -- fabricates a pass. Observed: scheduler:get_next served F-CANARY-20260803 to an su on
    -- 2026-08-03, and F-CANARY-20260802 was su-completed 58s after creation while the Hive
    -- was owner-paused and no cup could possibly have run.
    --
    -- ⚠ This floor belongs HERE (self-select) and NOWHERE ELSE. Do NOT add it to
    -- fetchFrontierRows (pot/survey.ts) and do NOT express it via payload._claimHold: that tag is
    -- honored by BOTH this path and the Mug's placement frontier, so using it would make the
    -- canary un-placeable and the detector would report a loop failure every day, forever —
    -- breaking the instrument in the exact way it exists to detect. The requirement is
    -- deliberately asymmetric: agents NO, cups YES.
    --
    -- NULL-safe via COALESCE, and scoped to a key only canary rows carry, so every ordinary
    -- item passes unchanged. A canary remains claimable by explicit id for maintenance.
    AND COALESCE(payload, '{}'::jsonb) ->> 'canary' IS DISTINCT FROM 'true'
    -- WI-5343: the reserved-plan-lane floor, extended to the FEATURE family. The issue-family
    -- claim has honored a plan-active / live-plan_item_claims-lease reservation since WI-2118 —
    -- but this path (getNextWorkItem tiers 1/2 + claimNextWorkItem) never read the payload.plan_item
    -- back-pointer, so a feature-family item promoted onto a live plan lane (e.g. WI-5137, bound to
    -- an active plan) was self-selectable out from under the lane's own driving agent. Same
    -- predicate as the issue family (reservedPlanLaneExclusionSql), unaliased (runs in
    -- harness_features_consolidated context). opts.cooldownAssignee already carries the claiming
    -- agent's ownerId (see its own doc comment) so it doubles for free as the owner-exemption arg —
    -- a lease THIS agent itself holds must not block its own re-claim.
    AND ${reservedPlanLaneExclusionSql(sql, opts.cooldownAssignee ?? '', 'payload', {
      claimantFleetSlug: opts.claimantFleetSlug,
      claimSpecReferencesFleet: opts.claimSpecReferencesFleet,
      claimSpecReferencesGoal: opts.claimSpecReferencesGoal,
    })}
    -- P-007 / D-021: a verification task never self-selects to its own reporter or
    -- implementer. Claimant-specific, so it is a claim-door filter, not a claim floor.
    AND NOT ${verificationTaskConflictSql(sql, opts.cooldownAssignee ?? '', 'payload')}
    -- EI-14806: the cross-machine-rig floor, extended to the FEATURE family. The issue-family
    -- claim has honored payload.needs_2_machine_rig since WI-2796, but a FEATURE-family item can
    -- ALSO carry the tag (WI-3487, a p2p rig-readiness feature) and this path — getNextWorkItem
    -- tiers 1/2 + claimNextWorkItem — never read it, so a no-rig caller (DEFAULT_CLAIM_SPEC or any
    -- feature-view spec) self-selected un-runnable rig work. Same predicate as the issue family,
    -- unaliased (runs in harness_features_consolidated context). Omitted rigAvailable ⇒ excluded.
    AND ${crossMachineRigExclusionSql(sql, opts.rigAvailable, 'payload')}
    AND ${opts.swarmId ? sql`(swarm_affinity IS NULL OR swarm_affinity = ${opts.swarmId})` : sql`TRUE`}
    -- P-014: under the redundancy flag, high-stakes (redundancy > 1) items fan out via
    -- claim_replica to N Swarms, so an exactly-once claim must NOT grab them. Flag OFF ⇒
    -- clause omitted, the claim never reads the redundancy column, byte-identical to before.
    AND ${opts.excludeRedundant ? sql`(redundancy IS NULL OR redundancy <= 1)` : sql`TRUE`}
    -- P-005 (F1 fix): RESPECT blocking — never self-select a row that has a PRESENT,
    -- NON-TERMINAL blocker, the SAME readiness the orchestrator frontier enforces
    -- (frontier-readiness.ts / work-item-blocking.ts). The block edges live in the
    -- dedicated work_item_deps table (dep_type='blocks'), keyed by harness-qualified refs
    -- ('<harness>#<feature_id>' for features, bare 'EI-<n>' for issues — featureRef /
    -- issues:link), in the single coordination workspace ('default'). A blocker is
    -- SATISFIED iff TERMINAL or ABSENT; we exclude the row only when a present blocker is
    -- non-terminal — feature terminal = status IN ('passed','deprecated','done','dropped');
    -- issue terminal = state IN ('resolved','closed','done','dropped') (the cross-family set,
    -- transitional legacy∪unified per work-item-status-full-unify — narrow to done/dropped at
    -- cleanup). An
    -- absent blocker ref (no matching feature/issue row) never blocks.
    --
    -- P-005 maintained-readiness cutover (SCHEDULER_MAINTAINED_READY): when ON, the SAME predicate
    -- is read from the maintained work_item_blocked sidecar (an indexed anti-join, presence = not
    -- ready) the wir_ triggers keep exact, instead of recomputing the correlated subquery per claim.
    -- The two forms are equivalent (the sidecar is materialized from this exact predicate + a
    -- reconciliation oracle); OFF is the byte-identical inline form.
    AND ${
      opts.useMaintainedReady
        ? sql`NOT EXISTS (
      SELECT 1
        FROM harness_shared.work_item_blocked wb
       WHERE wb.workspace_id = harness_shared.harness_features_consolidated.workspace_id
         AND wb.harness_slug = harness_shared.harness_features_consolidated.harness_slug
         AND wb.feature_id   = harness_shared.harness_features_consolidated.feature_id
    )`
        : sql`NOT EXISTS (
      SELECT 1
        FROM harness_shared.work_item_deps d
       WHERE d.workspace_id = 'default'
         AND d.dep_type = 'blocks'
         AND d.blocked_ref = harness_shared.harness_features_consolidated.harness_slug
                               || '#' || harness_shared.harness_features_consolidated.feature_id
         AND (
           -- Migration 719: BOTH blocker legs resolve within the BLOCKED item's own
           -- workspace. The issue leg used to hardcode 'default' — where 147 of 28,049
           -- issues live — so the blocker was never found, "an absent blocker never
           -- blocks" applied, and EVERY issue-family blocking edge was inert
           -- (EI-19313459163394127: 32/32 dead, 10 with a live non-terminal blocker).
           -- Keep this predicate identical to harness_shared.work_item_is_blocked(),
           -- which materializes the sidecar the useMaintainedReady branch above reads;
           -- if the two drift, the flag silently changes claim behavior.
           EXISTS (
             SELECT 1 FROM harness_shared.harness_features_consolidated bf
              WHERE bf.workspace_id = harness_shared.harness_features_consolidated.workspace_id
                -- EI-218628: split the dep-side scalar so the work_items primary key can
                -- serve both identity columns. Keep this aligned with unsatisfiedBlockerSql
                -- and migration 1087.
                AND position('#' in d.blocker_ref) > 0
                AND bf.harness_slug = split_part(d.blocker_ref, '#', 1)
                AND bf.feature_id = substring(d.blocker_ref from position('#' in d.blocker_ref) + 1)
                AND (
                  (bf.authority IS NOT NULL AND bf.authority NOT IN ('committed', 'validated')
                    AND lower(COALESCE(bf.status, '')) NOT IN ('deprecated', 'dropped'))
                  OR (d.satisfaction = 'settled' AND bf.status NOT IN ('passed', 'deprecated', 'done', 'dropped'))
                  OR (d.satisfaction = 'success' AND bf.status NOT IN ('passed', 'done'))
                )
           )
           OR EXISTS (
             SELECT 1 FROM harness_shared.engineer_issues bi
              WHERE bi.workspace_id = harness_shared.harness_features_consolidated.workspace_id
                AND bi.issue_id = d.blocker_ref
                AND (
                  (bi.authority IS NOT NULL AND bi.authority NOT IN ('committed', 'validated')
                    AND lower(COALESCE(bi.state, '')) NOT IN ('closed', 'dropped'))
                  OR (d.satisfaction = 'settled' AND bi.state NOT IN ('resolved', 'closed', 'done', 'dropped'))
                  OR (d.satisfaction = 'success' AND bi.state NOT IN ('resolved', 'done'))
                )
           )
         )
    )`
    }`;
}

/**
 * The tuple-space associative `in` (D-004) + work-stealing claim (D-007): atomically
 * claim the OLDEST unclaimed feature-family work-item matching the template, via
 * `SELECT … FOR UPDATE SKIP LOCKED`. Competing consumers each grab a DIFFERENT row
 * (skip-locked, no blocking, no double-claim); ordering by created_ts ASC steals the
 * most-starved tail of the queue, which balances load AND prevents old-item starvation.
 * Returns the claimed item, or null when nothing matches.
 *
 * The eligibility floors are the shared {@link claimFloorsWhereSql} fragment — the
 * SAME floors the spec-driven `scheduler/get-next.ts` resolver ANDs in, so the two
 * claim paths can never diverge (D-002).
 */
/**
 * Whether the scheduler claim reads the maintained `work_item_blocked` sidecar (an indexed
 * anti-join) vs the inline NOT EXISTS predicate — the SCHEDULER_MAINTAINED_READY cutover (P-005).
 * Resolved async at BOTH claim entry points (claimNextWorkItem + getNextWorkItem) so the two paths
 * can never drift (D-002). Fail-CLOSED to the inline predicate (false) on any flag-store error —
 * the proven path is the safe default.
 */
export async function schedulerMaintainedReadyEnabled(): Promise<boolean> {
  try {
    return await getFlag(FLAGS.SCHEDULER_MAINTAINED_READY, systemDistinctId());
  } catch {
    return false;
  }
}

/**
 * Whether the scheduler may SELF-PICK issue-family work-items (bug|change|task) —
 * the SCHEDULER_ISSUES_CLAIMABLE gate (work-item-deps-and-readiness-2026-06-22 P-007).
 *
 * DEFAULT OFF (owner-authority): adding the issue family to the dispatched backlog is a
 * brand-new SOURCE of work the autonomous fleet picks up, which the owner ratifies. When
 * OFF the issue-claim branch + the issue-applicable steer levers are inert, so the claim
 * path + set_priority / co_locate stay BYTE-IDENTICAL to feature-only behavior. Fail-CLOSED
 * to OFF (false) on any flag-store error — the proven feature-only path is the safe default.
 */
// EI-14108: fail-CLOSED (return false) is the right posture for a flag-read error, but
// fail-SILENT is not — a getFlag failure (flag store unreachable, PG pool poisoned; cf. the
// 2026-07-17 embedded-pg.json hijack) must not present identically to "the flag is genuinely
// off" / "the pool is genuinely empty". Track the most recent read's outcome so a caller that
// cares (diagnoseClaimNextMiss) can tell the two apart, and log the failure itself — throttled,
// so a sustained outage doesn't spam — rather than swallowing it entirely.
let _lastIssuesClaimableFlagError: { atMs: number; message: string } | null = null;
let _lastIssuesClaimableFlagErrorLoggedAtMs = 0;
const ISSUES_CLAIMABLE_FLAG_ERROR_LOG_THROTTLE_MS = 5 * 60_000; // 5 min

export async function schedulerIssuesClaimableEnabled(): Promise<boolean> {
  try {
    const enabled = await getFlag(FLAGS.SCHEDULER_ISSUES_CLAIMABLE, systemDistinctId());
    _lastIssuesClaimableFlagError = null;
    return enabled;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const now = Date.now();
    _lastIssuesClaimableFlagError = { atMs: now, message };
    if (now - _lastIssuesClaimableFlagErrorLoggedAtMs >= ISSUES_CLAIMABLE_FLAG_ERROR_LOG_THROTTLE_MS) {
      _lastIssuesClaimableFlagErrorLoggedAtMs = now;
      console.error(
        `[scheduler] SCHEDULER_ISSUES_CLAIMABLE read FAILED — tier-3 issue claims disabled this call: ${message}`,
      );
    }
    return false;
  }
}

/** EI-14108: was the MOST RECENT {@link schedulerIssuesClaimableEnabled} call (within the last
 *  few seconds — a fresh call, not a stale one from a since-recovered outage) a flag-READ
 *  failure rather than a genuine off/empty state? `diagnoseClaimNextMiss` calls this
 *  immediately after its own `schedulerIssuesClaimableEnabled()` call, so "fresh" here just
 *  guards against reading a leftover error from an unrelated, older call in the same process. */
export function lastIssuesClaimableFlagReadError(): string | null {
  if (!_lastIssuesClaimableFlagError) return null;
  if (Date.now() - _lastIssuesClaimableFlagError.atMs > 30_000) return null;
  return _lastIssuesClaimableFlagError.message;
}

/**
 * WI-2118 (the P-009 leak): the "reserved plan-lane" self-select EXCLUSION floor for issue-family
 * claims. An issue-family work-item can carry a `payload.plan_item` back-pointer binding it to a
 * plan-item LANE (P-NNN of some plan). When that lane is being ACTIVELY driven — the parent plan is
 * operationally `started`/`paused`, or an ordinary plan is in a non-executable lifecycle state
 * (`paused`/`active`), or the plan-item is under a LIVE lease or durable assignment held by
 * ANOTHER agent — the
 * item belongs to that lane's own dispatch, NOT the general backlog-clearance drain. Without this
 * floor the drain SCOOPS such an item into the shared claim pool; members that know the lane is reserved (its plan's
 * `## Now`) correctly REFUSE + release it, and the scheduler immediately re-serves it — the
 * claim→refuse→re-serve CHURN the owner flagged (WI-2118 was served to 3 different members in
 * minutes). The floor is the durable fix: a reserved-lane item is never offered to self-select at all.
 *
 * SOUND + narrow: it fires ONLY when (a) the linked plan is under execution — operationally
 * `op_status IN ('started','paused')` — or is an ordinary plan in a non-executable lifecycle
 * state (`status IN ('paused','active')`), (b) a non-lapsed `plan_item_claims` lease is
 * held by a DIFFERENT owner, or (c) an active `plan_item_assignments` row reserves the item
 * to a DIFFERENT owner/name. An ordinary `ready` plan with NULL/`done` op_status, or a per-run
 * instance whose lifecycle state is covered only by the template row, is NOT excluded — those
 * items drain normally (no starvation of genuinely-free backlog). A member can still claim a
 * reserved item DIRECTLY by id (the named-claim floor bypass) when it legitimately owns the lane.
 *
 * ⚠ "Under execution" is the OPERATIONAL axis (`op_status`) FIRST — see the inline comment on the
 * predicate. This floor read the lifecycle `status` alone until EI-19409397800537963, which made it
 * miss ~87% of genuinely-running plans (`plans:start` writes op_status and leaves `status` at
 * 'ready'), miss `paused` entirely (breaking plans:pause's own "no new features are picked"
 * contract on the scheduler path), and match plan rows in OTHER workspaces. If you are adding a
 * third execution signal, add it HERE — the orchestrator frontier
 * (`dbos/orchestrator-loop.ts`) and this floor are the two dispatchers that must agree on what
 * "running" means, and they silently disagreed for as long as this read the wrong column.
 *
 * WI-5343: `payloadCol` selects aliased (`wi.payload`, issue-family, the default — every
 * pre-existing call site runs in a `FROM … work_items wi` context) vs unaliased (`payload`,
 * FEATURE-family, `harness_features_consolidated`) — same dual-form shape as
 * {@link crossMachineRigExclusionSql}. Now ALSO shared by {@link claimFloorsWhereSql} (the
 * feature-family claim), which previously never read `payload.plan_item` at all — a feature
 * promoted onto a live plan lane was self-selectable out from under it (see WI-5137).
 *
 * ONE source of truth, shared by {@link claimNextIssueWorkItem} + {@link claimFloorsWhereSql}
 * (the claims) and {@link diagnoseClaimNextMiss} (the READY count), so the "why did I miss"
 * diagnosis can never disagree with what the claim actually serves.
 *
 * ⚠ EI-13738: this fragment now carries FOUR exclusion legs, not two — the plan is under
 * execution, OR a live lease is held by another owner, OR the plan-ITEM is blocked-by an
 * unfinished sibling in `harness_plans.items[].blockedBy[]`, OR the linked plan-item is already
 * terminal in the normalized `plan_items` index. The latter two are genuinely different
 * concepts from the "reserved lane" the name describes: one asks *is this work even ready?*,
 * the other asks *has this lane already finished?*. They live here anyway, and deliberately so
 * — this is the one predicate every issue-family AND feature-family claim path composes, so
 * adding a floor here reaches all 8+ call sites at once and structurally avoids EI-14806 ("a
 * floor added to only one claim path silently leaks in the other"). Do NOT hand-add it per call
 * site, and do NOT split it back out without keeping every caller covered.
 */
export function reservedPlanLaneExclusionSql(
  sql: OrgSql,
  assignee: string,
  // WI-5343: which payload column this predicate reads. The issue-family callers run in a
  // `FROM … work_items wi` context (aliased `wi.payload`, the default); a FEATURE-family
  // caller (harness_features_consolidated, unaliased) passes 'payload' — same dual-form
  // shape as {@link crossMachineRigExclusionSql}. A closed literal union, never interpolated
  // user input, so composing it via sql.unsafe is injection-safe.
  payloadCol: 'wi.payload' | 'payload' = 'wi.payload',
  authorization: {
    claimantFleetSlug?: string;
    claimSpecReferencesFleet?: boolean;
    /**
     * EI-21398324268952860: the GOAL analogue of `claimSpecReferencesFleet`. A per-goal
     * standing DRAIN FLEET scopes its claim spec by `{ field:'goal', op:'=', value:<goalId> }`
     * (see `WorkItem.goalId`), so when its own steward mints plan-stamped work FOR it, the
     * plan-lane floor reserved that work away from the very fleet the lane belongs to:
     * `matchedByFilter=7, claimable=0, planLaneReserved=7`, and the drain stalled fleet-wide.
     *
     * ⚠ This does NOT reuse `claimSpecReferencesFleet`'s `authorized` flag, deliberately.
     * A goal is BROADER than a fleet, so a goal match must never let one fleet adopt an item
     * another fleet explicitly reserved with a `fleet_slug` stamp. Goal authorization
     * therefore satisfies ONLY the plan-lifecycle leg below, never the fleet-stamp leg.
     *
     * There is deliberately NO `claimantGoalId` counterpart to `claimantFleetSlug`: a fleet
     * slug is carried on the claimant's own presence row, but an agent has no equivalent
     * standing goal identity, so such a parameter would have no caller and no reachable
     * branch. Authorization here is spec-derived only.
     */
    claimSpecReferencesGoal?: boolean;
  } = {},
) {
  // COALESCE the payload so a NULL-payload row (no plan_item back-pointer) reads as
  // `'{}'::jsonb ? 'plan_item'` = FALSE ⇒ NOT(FALSE AND …) = TRUE ⇒ the row is INCLUDED
  // (never excluded). A bare `NULL ? 'plan_item'` would yield NULL and wrongly drop the row.
  // The sibling subquery also has a payload column. Qualify the candidate so
  // feature callers cannot accidentally compare a claimed sibling to itself
  // and reserve unrelated plan items (EI-22532026672585665).
  const col = sql.unsafe(
    payloadCol === 'wi.payload' ? payloadCol : 'harness_shared.harness_features_consolidated.payload',
  );
  // EI-19409397800537963: the tenant scope for the two subqueries below. Both
  // `harness_plans` and `plan_item_claims` are keyed on (workspace_id, harness_slug,
  // plan_slug[, item_id]) and BOTH subqueries used to match on `plan_slug` ALONE — so a
  // slug that exists in another workspace could satisfy (or fail) the predicate for an
  // item that has nothing to do with it. Measured 2026-08-03: 7 plan slugs each exist in
  // 3 different workspaces. `(workspace_id, plan_slug)` IS unique (0 dupes over the whole
  // table), so scoping on the workspace alone is exact — and it deliberately does NOT
  // also key on harness_slug, because the `plan_item` back-pointer's OWN harness_slug has
  // drifted from the plan row's (migration 656 canonicalized plan harness slugs without
  // rewriting the back-pointers; e.g. WI-5751 carries 'oddsmith' for a plan row now at
  // 'oddsmith-hive'), so keying on it would silently un-reserve real lanes.
  //
  // The column is correlated, not a parameter, so every caller is scoped without a
  // signature change: `payloadCol` already encodes which relation this fragment is
  // composed into — 'wi.payload' ⇒ `FROM harness_shared.work_items wi`, 'payload' ⇒
  // `FROM harness_shared.harness_features_consolidated` (verified at all 8 call sites) —
  // the same correlated-reference shape claimFloorsWhereSql's readiness anti-join uses.
  const wsCol = sql.unsafe(
    payloadCol === 'wi.payload' ? 'wi.workspace_id' : 'harness_shared.harness_features_consolidated.workspace_id',
  );
  const idCol = sql.unsafe(
    payloadCol === 'wi.payload' ? 'wi.feature_id' : 'harness_shared.harness_features_consolidated.feature_id',
  );
  const claimantFleetSlug = authorization.claimantFleetSlug?.trim();
  const authorized = authorization.claimSpecReferencesFleet
    ? sql`TRUE`
    : claimantFleetSlug
      ? sql`(${col}->>'fleet_slug' = ${claimantFleetSlug})`
      : sql`FALSE`;
  // EI-21398324268952860: the goal leg. Unlike `fleet_slug` (a PAYLOAD key), the goal is a
  // real COLUMN on both relations (`goal_id`, text, present on work_items AND
  // harness_features_consolidated after migration 785/815) — so it uses the same correlated
  // -column form as `wsCol`/`idCol` above, keyed off `payloadCol`, rather than a payload read.
  const goalCol = sql.unsafe(
    payloadCol === 'wi.payload' ? 'wi.goal_id' : 'harness_shared.harness_features_consolidated.goal_id',
  );
  // TIGHTER than the fleet precedent on purpose: where `claimSpecReferencesFleet` resolves to
  // a bare TRUE, referencing the goal field additionally requires the row to actually CARRY a
  // goal. A spec may reference `goal` with a negative operator (e.g. `{op:'!='}`), and a bare
  // TRUE would then authorize goal-LESS rows the spec never meant to adopt.
  const goalAuthorized = authorization.claimSpecReferencesGoal ? sql`(${goalCol} IS NOT NULL)` : sql`FALSE`;
  return sql`NOT (
    COALESCE(${col}, '{}'::jsonb) ? 'plan_item' AND (
      -- EI-13524: a fleet stamp is a reservation in its own right, independently of
      -- plan lifecycle. The owning fleet, or a spec that explicitly references the
      -- fleet field (and therefore still must pass the compiled filter), may adopt it.
      (NOT (${authorized}) AND COALESCE(${col}, '{}'::jsonb) ? 'fleet_slug')
      -- EI-21398324268952860: the goal leg joins HERE and nowhere else. The fleet-stamp leg
      -- above deliberately still reads the fleet authorization alone, so a goal-scoped drain
      -- fleet can adopt work on its own goal's plan lane WITHOUT being able to take an item
      -- that another fleet explicitly reserved to itself with a fleet_slug stamp.
      OR (NOT (${authorized} OR ${goalAuthorized}) AND EXISTS (
        SELECT 1 FROM harness_shared.harness_plans p
         WHERE p.workspace_id = ${wsCol}
           AND p.plan_slug = ${col}->'plan_item'->>'plan_slug'
           -- EI-19409397800537963: "is this plan under execution" is the OPERATIONAL axis
           -- (op_status, written by plans:start / plans:pause), NOT the lifecycle
           -- frontmatter status this floor used to read alone. plans:start sets
           -- op_status='started' and deliberately leaves status untouched (it only READS
           -- it, to refuse a terminal plan), so a started plan normally sits at
           -- status='ready' — which this predicate used to score as unreserved.
           --
           -- Measured on live papercusp 2026-08-03, and the leak was the common case, not
           -- an edge: of 16 op_status='started' plans only 2 were also status='active', and
           -- of 83 open plan-bound work-items just 19 were reserved where 51 should be. The
           -- 31 feature-family items on 12 genuinely-running plans were fully self-selectable
           -- — exactly the claim→refuse→re-serve churn WI-2118 created this floor to stop
           -- (WI-6292 was handed to two different agents inside one hour, ~20 min lost each).
           --
           -- 'paused' is reserved for the same reason plans:pause exists: its documented
           -- contract is "no new features are picked until plans:start", and the orchestrator
           -- frontier (dbos/orchestrator-loop.ts) already honors op_status. Only the SCHEDULER
           -- self-select path did not, so pausing a plan stopped one dispatcher and left the
           -- other handing the same work out — owner-stopped work reaching an AUTO agent that
           -- has every reason to read a scheduler hand-off as in-scope.
           --
           -- Ordinary plans in lifecycle paused/active are also reserved: these are
           -- explicitly non-executable/owner-controlled states, and their plan_item rows must not
           -- leak into a generic drain while the plan is paused or actively running outside
           -- op_status tracking. A DRAFT plan is deliberately NOT reserved here (EI-21859942410973983):
           -- a draft with no live lease has no actual occupant, and over-excluding it starved
           -- genuinely-claimable issues (WI-RES-2/WI-RES-4) for as long as any plan sat in draft —
           -- the separate plan_item_claims lease leg (below) still reserves a draft plan's lane the
           -- moment someone actually holds it. A ready plan with NULL op_status, and a plan whose
           -- operation is done, remain free controls. The lifecycle leg is qualified by
           -- template_slug IS NULL below so scheduled per-run instance plans do not deadlock their
           -- own minted work.
           -- op_status is nullable, but a NULL only makes the IN NULL and the row unmatched by
           -- EXISTS — the lifecycle leg supplies the ordinary-plan reservation where appropriate.
           --
           -- WI-38258: the lifecycle leg is qualified by "template_slug IS NULL" — i.e. it does
           -- NOT apply to a per-run INSTANCE plan (template@run-token, minted by system:plan-run).
           -- That mint is a DEADLOCK BY CONSTRUCTION otherwise: it inserts the instance at
           -- status='active' AND stamps each minted work-item's payload.plan_item at that same
           -- instance, so this floor reserves the item for the instance's driving agent — and a
           -- scheduled run HAS no driving agent, by design ("the harness's existing dispatcher
           -- executes those work_items — no second execution engine",
           -- harness/routines/plan-run-action.ts:12-21). The plan stays 'active' because its item
           -- never completes; the item is unclaimable because the plan is 'active'. Neither side
           -- can move first. Measured 2026-08-12: of the 52 instance plans ever minted here, the 2
           -- that carried items had BOTH items stuck todo/unclaimed (one for 18h); the other 50
           -- minted zero items and so never reached the floor — and were bulk-flipped to
           -- 'superseded' by hand in a single minute 17 days after their runs, which is the
           -- absence of any self-clearing exit path stated as evidence.
           --
           -- ⚠ It is the LIFECYCLE leg only. op_status IN ('started','paused') still reserves an
           -- instance, so an agent that DOES deliberately drive one (plans:start on the instance)
           -- keeps its lane — the reservation now tracks an actual occupant rather than the mere
           -- act of minting. "template_slug IS NOT NULL" is the established column-level test for
           -- "per-run instance, not an ordinary plan", already used by plan-acceptance-gate.ts:65,
           -- rubrics.ts (5 sites) and plans:list (source.ts:985, D-003) — never a slug-shape match
           -- on the @run- token.
           AND (
             p.op_status IN ('started', 'paused')
             OR (p.status IN ('paused', 'active') AND p.template_slug IS NULL)
           )
      ))
      OR (NOT (${authorized}) AND EXISTS (
        SELECT 1 FROM harness_shared.plan_item_claims c
         WHERE c.workspace_id = ${wsCol}
           AND c.plan_slug = ${col}->'plan_item'->>'plan_slug'
           AND c.item_id  = ${col}->'plan_item'->>'item_id'
           AND c.expires_ts > now()
           AND c.owner <> ${assignee}
      ))
      -- EI-22040912157347872: ASSIGNMENT is the durable ownership intent underneath the
      -- leased claim. A route-owning plan session can legitimately be between claims while
      -- its assignment remains active; without this leg a generic kind-drain claims the
      -- linked work-item, reads the plan ruling, releases it, and the scheduler serves it
      -- again. That happened twice to WI-1801547 after its P-008 handoff.
      --
      -- Reserve an active assignment from every OTHER claimant. The assigned owner may
      -- still self-select through either identity axis the plan-item claim door accepts:
      -- the raw ownerId stored directly as assignee_name, or a stable adopted name resolved
      -- through agent_name_sessions. A soft release ("released_ts") is the explicit return
      -- to the generic pool; the existing dead/stalled assignment reapers perform that same
      -- release after their grace windows, so this adds no parallel ownership mechanism.
      OR EXISTS (
        SELECT 1 FROM harness_shared.plan_item_assignments a
         WHERE a.workspace_id = ${wsCol}
           AND a.plan_slug = ${col}->'plan_item'->>'plan_slug'
           AND a.item_id = ${col}->'plan_item'->>'item_id'
           AND a.released_ts IS NULL
           AND NULLIF(BTRIM(a.assignee_name), '') IS NOT NULL
           AND a.assignee_name <> ${assignee}
           AND NOT EXISTS (
             SELECT 1 FROM harness_shared.agent_name_sessions ans
              WHERE ans.workspace_id = a.workspace_id
                AND ans.session_owner_id = ${assignee}
                AND ans.agent_name = a.assignee_name
           )
      )
      -- EI-22040898205841125: a claimed WORK-ITEM sibling is the live ownership
      -- evidence the transaction guard already enforces, but until now it was absent
      -- from every pre-claim read. The ranked selector could therefore pick the same
      -- duplicate implementation repeatedly, provisionally claim it, have
      -- guardPlanItemSiblingClaim clear it, and return a bare miss. The claimability
      -- oracle still counted that row, so scheduler:get_next misreported a
      -- claim-path/read-path divergence even with hundreds of unrelated candidates.
      --
      -- Make the existing reserved-plan-lane floor see that ownership before UPDATE.
      -- Match a sibling's canonical source columns when present; only fall back to its
      -- legacy payload identity when those columns are incomplete, mirroring
      -- guardPlanItemSiblingClaim. The outer candidate identity stays payload.plan_item
      -- because that is this floor's established contract at every caller. The
      -- transaction guard remains mandatory for concurrent races and source-only
      -- candidates: this predicate is the churn/diagnosis floor, not the mutex.
      OR EXISTS (
        SELECT 1
          FROM harness_shared.work_items sibling
         WHERE sibling.workspace_id = ${wsCol}
           AND sibling.feature_id <> ${idCol}
           AND sibling.taken_by IS NOT NULL
           AND btrim(sibling.taken_by) <> ''
           AND lower(btrim(sibling.taken_by)) <> 'unassigned'
           AND sibling.status NOT IN ('passed', 'deprecated', 'resolved', 'closed', 'done', 'dropped')
           AND (
             (
               NULLIF(btrim(sibling.source_plan_slug), '') IS NOT NULL
               AND EXISTS (
                 SELECT 1
                   FROM unnest(COALESCE(sibling.source_plan_item_ids, ARRAY[]::text[])) AS sibling_item(item_id)
                  WHERE btrim(sibling_item.item_id) <> ''
               )
               AND btrim(sibling.source_plan_slug) = ${col}->'plan_item'->>'plan_slug'
               AND ${col}->'plan_item'->>'item_id' = ANY(
                 COALESCE(sibling.source_plan_item_ids, ARRAY[]::text[])
               )
             )
             OR (
               NOT (
                 NULLIF(btrim(sibling.source_plan_slug), '') IS NOT NULL
                 AND EXISTS (
                   SELECT 1
                     FROM unnest(COALESCE(sibling.source_plan_item_ids, ARRAY[]::text[])) AS sibling_item(item_id)
                    WHERE btrim(sibling_item.item_id) <> ''
                 )
               )
               AND COALESCE(sibling.payload, '{}'::jsonb)->'plan_item'->>'plan_slug'
                     = ${col}->'plan_item'->>'plan_slug'
               AND COALESCE(sibling.payload, '{}'::jsonb)->'plan_item'->>'item_id'
                     = ${col}->'plan_item'->>'item_id'
             )
           )
      )
      -- EI-20467873456529090: a completed plan-item is terminal residue, not generic backlog.
      -- planItemLaneBlockReason already rejects this after a claim, but that is too late for
      -- claimable previews, aggregate diagnostics, and fleet:bench. The normalized index is the
      -- derived, indexed status surface for canonical plan content; scope by workspace +
      -- plan/item identity just like the plan-lane floors above (the payload harness_slug copy
      -- is allowed to drift during plan-harness canonicalization).
      OR EXISTS (
        SELECT 1 FROM harness_shared.plan_items pi
         WHERE pi.workspace_id = ${wsCol}
           AND pi.plan_slug = ${col}->'plan_item'->>'plan_slug'
           AND pi.item_id = ${col}->'plan_item'->>'item_id'
           AND pi.status IN ('done', 'dropped')
      )
      -- EI-13738: the PLAN dependency graph — the third exclusion leg, and the one nothing
      -- read until now. Readiness lives in TWO stores and only one of them gated the claim:
      -- the WORK-ITEM store (state + work_item_deps 'blocks' edges) is enforced by
      -- claimFloorsWhereSql's readiness anti-join, while the PLAN store
      -- (harness_plans.items[].blockedBy[], what plans:get-item reports as
      -- effectiveStatus:'blocked') was enforced NOWHERE. So a work-item bound to a
      -- plan-item that is blocked-by an unfinished sibling passed every floor and was
      -- served to self-select. Two independent agents hit this within one hour from
      -- opposite directions; the filing near-miss was a 10-agent dispatch.
      --
      -- The legs above do NOT already cover it: they fire only when the plan is under
      -- execution (op_status started/paused, or ordinary lifecycle paused/active) or under
      -- a live lease.
      -- A plan that was never started reserves nothing, so its blocked lanes stayed fully
      -- claimable — floor #11 is a mitigation for this bug, not the fix.
      --
      -- ONE LEVEL IS ENOUGH — deliberately NOT a recursive CTE. An item is blocked iff some
      -- blockedBy sibling is unsatisfied, and transitivity is automatic: a blocker that is
      -- itself blocked is by definition not yet done. Verified on real PG (P-003→P-002→P-001:
      -- P-003 excluded, P-001 admitted).
      --
      -- SATISFIED = 'done' OR 'dropped', mirroring the canonical TS predicate verbatim
      -- (plan-parser effective-status.ts L178) and floor #12's own terminal sets.
      -- ⚠ NOT "<> 'done'": measured 2026-08-04 there are 209 live plan-items at 'dropped',
      -- and counting those as blockers would PERMANENTLY STARVE every item behind them.
      -- 'needs-human' and 'blocked' are correctly NOT satisfied and keep blocking.
      --
      -- The item's OWN status must also be non-terminal (EI-19412899868617052: a terminal
      -- stored token wins over the blocked-by graph — the graph gates work that has NOT
      -- happened, it must never re-open work that has).
      --
      -- A DANGLING ref fails OPEN (the sibling join finds nothing ⇒ not excluded). That is a
      -- deliberate divergence from plan-parser, which counts a missing ref as unresolved: it
      -- matches the established claim-floor convention ("an ABSENT / dangling blocker ref does
      -- NOT block (no deadlock)" — claim-respects-blocking.integration.test.ts case 4), because
      -- the alternative failure mode is an item nobody can claim and nobody can diagnose.
      -- Measured: exactly 1 dangling ref exists across all plans.
      --
      -- Both element scans are jsonb_typeof-guarded because jsonb_array_elements RAISES on a
      -- non-array input, and this fragment gates EVERY claim on the fleet — one malformed plan
      -- row would take out claiming entirely, not just its own lane. (items is 'array' on 982
      -- plans and NULL on 52 today; NULL is already safe via strict-SRF, the guard makes the
      -- property structural rather than incidental.)
      --
      -- MUST stay in step with floor #13 of the SQL SSOT (migration 759); the pair is bound by
      -- claim-ssot-agreement.integration.test.ts.
      OR EXISTS (
        SELECT 1
          FROM harness_shared.harness_plans bp,
               LATERAL jsonb_array_elements(
                 CASE WHEN jsonb_typeof(bp.items) = 'array' THEN bp.items ELSE '[]'::jsonb END) self_it,
               LATERAL jsonb_array_elements_text(
                 CASE WHEN jsonb_typeof(self_it->'blockedBy') = 'array'
                      THEN self_it->'blockedBy' ELSE '[]'::jsonb END) dep_id,
               LATERAL jsonb_array_elements(
                 CASE WHEN jsonb_typeof(bp.items) = 'array' THEN bp.items ELSE '[]'::jsonb END) dep_it
         WHERE bp.workspace_id = ${wsCol}
           AND bp.plan_slug = ${col}->'plan_item'->>'plan_slug'
           AND self_it->>'id' = ${col}->'plan_item'->>'item_id'
           AND COALESCE(self_it->>'status', '') NOT IN ('done', 'dropped')
           AND dep_it->>'id' = dep_id
           AND COALESCE(dep_it->>'status', '') NOT IN ('done', 'dropped')
      )
    )
    -- WI-10006159 extends WI-41737 at the existing decision writer/read seam.
    -- A direct execution master may be ad-hoc, and a solo authorization may have
    -- an ordinary title. Keep this OUTSIDE the plan_item gate. Require affirmative
    -- route language; extract only explicit "WI-N owns execution" clauses, never
    -- every WI mentioned in the body. The token lookup uses migration 1364's GIN
    -- index. Item refs, tenant scope and deliberate by-id pickup remain unchanged.
    -- The real-PG SSOT agreement suite binds this to migration 1364.
    OR EXISTS (
      SELECT 1 FROM harness_shared.plan_decisions d
      WHERE d.workspace_id = ${wsCol}
        AND (
          (
            d.plan_slug = ${col}->'plan_item'->>'plan_slug'
            AND (
              cardinality(COALESCE(d.item_refs, ARRAY[]::text[])) = 0
              OR ${col}->'plan_item'->>'item_id' = ANY(COALESCE(d.item_refs, ARRAY[]::text[]))
            )
          )
          OR (
            regexp_split_to_array(d.body, '[^A-Za-z0-9_-]+') @> ARRAY[${idCol}]::text[]
            AND EXISTS (
              SELECT 1 FROM regexp_matches(d.body,
                '(^|[^A-Za-z0-9_-])(WI-[0-9]+)[[:space:]]+owns execution([[:space:]]+and([[:space:]]|$)|[.;]|$)', 'g') AS master(ref)
              WHERE master.ref[2] = ${idCol}
            )
          )
        )
        AND (
          LOWER(d.title) LIKE '%self-only execution route%'
          OR (
            LOWER(BTRIM(d.title)) = 'direct execution route'
            AND (
              LOWER(d.body) LIKE '%implements the plan directly%'
              OR LOWER(d.body) LIKE '%implement it itself%'
              OR LOWER(d.body) LIKE '%no fleet%'
              OR LOWER(d.body) LIKE '%no subagents%'
            )
          )
          OR LOWER(d.body) ~ '(^|[^a-z0-9_-])su-[a-f0-9-]{8,36} is the (single|sole) implementer([[:space:].;]|$)'
          OR LOWER(d.body) ~ '(^|[^a-z0-9_-])route is this session implementing directly, without (a new )?fleet([[:space:].;]|$)'
        )
    )
    -- WI-10006417: an explicit Route A sentence names one session as the plan's
    -- implementer, so it reserves the whole plan even when the decision's itemRefs
    -- describe only its other clauses (D-006's refs omit P-002). The durable
    -- plan_item_assignments surface is per-item and is not populated by this ruling.
    OR EXISTS (
      SELECT 1 FROM harness_shared.plan_decisions d
      WHERE d.workspace_id = ${wsCol}
        AND d.plan_slug = ${col}->'plan_item'->>'plan_slug'
        AND LOWER(d.body) ~ '(^|[^a-z0-9_-])route[[:space:]]+a:[[:space:]]+this session[[:space:]]+[(]su-[a-f0-9-]{8,36}[)][[:space:]]+implements the plan([[:space:].;]|$)'
    )
  )`;
}

/**
 * WI-2796: the "cross-machine rig required" self-select EXCLUSION floor. Some work-items carry
 * `payload.needs_2_machine_rig: true` because their actual execution needs a LIVE ≥2-machine /
 * Hetzner federation rig a single-box fleet member cannot provide. Without this floor a
 * single-box drain member self-selects one via claim_next / scheduler:get_next, discovers it is
 * un-doable solo, and releases it — pure recycle churn (WI-2796 observed 19 such items cycling
 * this way during the 2026-07-04 backlog-clearance drain).
 *
 * `rigAvailable` is the caller-declared bypass: a fleet that DOES have/coordinate a real
 * multi-machine rig passes `rigAvailable:true` and the floor becomes a no-op (`TRUE`) so
 * those items surface to it normally. Omitted/false (the default, single-box case) ⇒ any
 * `needs_2_machine_rig:true` row is excluded from self-select. A member can still claim
 * such an item DIRECTLY BY ID (the named-claim floor bypass, same shape as the reserved-
 * plan-lane floor above) when it legitimately has rig access.
 *
 * EI-14806: originally scoped to the ISSUE family only, on the assumption the tag rode only
 * task-kind p2p Briefs. But a FEATURE-family item can carry it too (WI-3487, a p2p rig-readiness
 * feature), and the feature-family claim path (getNextWorkItem tiers 1/2 + claimNextWorkItem, via
 * {@link claimFloorsWhereSql}) never read the tag — so a no-rig caller drawing DEFAULT_CLAIM_SPEC
 * (or any feature-view spec) self-selected un-runnable rig work. It is now a GLOBAL admission
 * floor across BOTH families: {@link claimFloorsWhereSql} applies it (unaliased `payload`) for
 * the feature family, and the issue-family callers below keep applying it (aliased `wi.payload`).
 *
 * ONE source of truth, shared by {@link claimFloorsWhereSql} (feature family) +
 * {@link claimNextIssueWorkItem} (the issue claim) and {@link diagnoseClaimNextMiss} (the READY
 * count) so the miss diagnosis can never disagree with what the claim actually serves.
 */
export function crossMachineRigExclusionSql(
  sql: OrgSql,
  rigAvailable: boolean | undefined,
  // EI-14806: which payload column this predicate reads. The issue-family callers run in a
  // `FROM … work_items wi` context (aliased `wi.payload`, the default); the FEATURE-family
  // floor (claimFloorsWhereSql, over harness_features_consolidated) runs UNALIASED, so it
  // passes 'payload'. A closed literal union — never interpolated user input — so composing
  // it via sql.unsafe is injection-safe.
  payloadCol: 'wi.payload' | 'payload' = 'wi.payload',
) {
  if (rigAvailable) return sql`TRUE`;
  // COALESCE the payload so a NULL-payload row (no rig tag) reads as '{}'::jsonb->>'...' =
  // NULL, and `NULL IS DISTINCT FROM 'true'` = TRUE ⇒ the row is INCLUDED (never excluded).
  return sql`COALESCE(${sql.unsafe(payloadCol)}, '{}'::jsonb) ->> 'needs_2_machine_rig' IS DISTINCT FROM 'true'`;
}

/**
 * WI-2797: the "claim hold" self-select EXCLUSION floor for issue-family claims. Some
 * issue-family items must NOT be opportunistically self-picked (e.g. one flagged "needs a
 * dedicated gateway-owning agent, do not pick up" — the WI-652 ping-pong that motivated this)
 * yet the issue-family state dialect has only open|resolved|closed, so there is no non-terminal
 * "parked" state to move it to. Rather than widen the shared generic LifecycleState enum (a
 * wide-blast-radius change touching every consumer of that borrowable primitive — see the
 * WI-2797 thread's investigation), a `payload._claimHold: true` tag is a scoped, additive,
 * no-migration lever: set it (setWorkItemClaimHold) and the item disappears from self-select
 * while staying fully visible/editable/commentable and still directly claimable BY ID (the same
 * named-claim bypass the reserved-plan-lane and cross-machine-rig floors already allow).
 *
 * Mirrors {@link crossMachineRigExclusionSql}'s shape exactly (same COALESCE-for-NULL-safety
 * pattern) and is likewise ONE source of truth shared by {@link claimNextIssueWorkItem} (the
 * claim) and {@link diagnoseClaimNextMiss} (the READY count) so the miss diagnosis can never
 * disagree with what the claim actually serves.
 */
export function claimHoldExclusionSql(
  sql: OrgSql,
  // WI-5343: which payload column this predicate reads. The issue-family callers run in a
  // `FROM … work_items wi` context (aliased `wi.payload`, the default); a FEATURE-family
  // caller (harness_features_consolidated, unaliased) passes 'payload'; the stranded
  // checkpoint reader uses the explicit `ei` view alias. A closed literal union, never
  // interpolated user input, so composing it via sql.unsafe is injection-safe.
  payloadCol: 'wi.payload' | 'payload' | 'ei.payload' = 'wi.payload',
) {
  // COALESCE the payload so a NULL-payload row (no hold tag) reads as '{}'::jsonb->>'...' =
  // NULL, and `NULL IS DISTINCT FROM 'true'` = TRUE ⇒ the row is INCLUDED (never excluded).
  return sql`COALESCE(${sql.unsafe(payloadCol)}, '{}'::jsonb) ->> '_claimHold' IS DISTINCT FROM 'true'`;
}

/**
 * JS-form counterpart of {@link claimHoldExclusionSql} — for an ALREADY-LOADED row
 * (event-emission guards, placement gather), the single source of truth for "is this
 * row deliberately parked out of self-select via `payload._claimHold`" (WI-2797).
 * Text-compare (`String(...) === 'true'`) mirrors the SQL `->>` extraction, matching
 * both the boolean `true` {@link setWorkItemClaimHold} writes and a legacy string
 * `'true'`. Canonical home for this predicate — `../fleet/placement-gather`'s
 * `isClaimHoldParked` re-exports this; `work-items-events.ts`'s claimable-event guard
 * uses it directly (EI-18128621906886568: that guard used to check only `assignee` +
 * claimable-state, so a claim-hold-parked row with no live assignee still fired
 * `work-item:claimable` on every release/requeue/unblock — waking the whole fleet on
 * work that was never actually claimable, and inviting an "inadvertent re-claim" via
 * the still-open claim-BY-ID path).
 */
export function isClaimHoldParked(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false;
  return String((payload as Record<string, unknown>)._claimHold) === 'true';
}

/**
 * The OBSERVATION-LANE self-select EXCLUSION floor for issue-family claims. A
 * `payload.lane:'observation'` row is a turn-end-reflection / rubric scorecard filed via
 * `improvements:capture { lane:'observation' }` (D-005): by DESIGN it "never enters the work
 * queue/triage/auto-implement — only Scout's corpus-digest + the Observations pane read it".
 * But these rows land in `harness_shared.work_items` as issue-family `change`-kind rows, so
 * WITHOUT this floor the oldest-first self-select serves them like real work — a single-box
 * drain member claims a scorecard, finds there is nothing to DO (its payload IS the whole
 * deliverable), and releases it: pure recycle churn. This was the dominant pool pollutant
 * (922 open observation rows vs 854 real issue/feature items, 2026-07-05) and the root of the
 * recurring "claim_next keeps surfacing lane:observation scorecards" friction
 * (EI-7503/EI-7587/EI-7741). This floor makes the claim path HONOR the D-005 "never enters the
 * work queue" contract the capture tool already advertises.
 *
 * UNCONDITIONAL (unlike the rig floor's caller bypass): no self-select caller legitimately
 * wants an observation record — the Observations pane / Scout digest read them directly, never
 * by claiming. Still directly claimable BY ID (the same named-claim bypass every issue floor
 * allows), so an operator can still inspect/edit one.
 *
 * Mirrors {@link claimHoldExclusionSql}'s shape (same COALESCE-for-NULL-safety pattern) and is
 * likewise ONE source of truth shared by {@link claimNextIssueWorkItem} (the claim) and
 * {@link diagnoseClaimNextMiss} (both the POOL and READY counts) so the miss diagnosis can
 * never disagree with what the claim actually serves. Applied to the POOL count too (not just
 * READY, as the rig/claimHold floors are) because an observation row is not work-queue
 * material AT ALL (D-005) — a queue of only scorecards must read `drained:true` so a drainer
 * idles, rather than the "pending-but-gated, don't idle" verdict a held-but-real item gets.
 */
export function observationLaneExclusionSql(
  sql: OrgSql,
  // Issue-family callers run in a `FROM … work_items wi` context by default. The
  // other callers pass the alias whose payload they are evaluating. Keep this a
  // closed literal union: the value is trusted SQL structure, never user input.
  payloadCol: 'wi.payload' | 'payload' | 'ei.payload' = 'wi.payload',
) {
  // WI-524804: read the STORED generated column, NOT `payload ->> 'lane'`. Migration 721
  // (WI-6934) added `lane text GENERATED ALWAYS AS (payload ->> 'lane') STORED` expressly so
  // this floor filters without a per-row JSONB detoast, and this floor is evaluated over the
  // ENTIRE candidate population — the largest single population any floor touches.
  //
  // This was reverted to the payload form on a MISDIAGNOSIS. EI-21580597231511770 saw
  // "column wi.lane does not exist" and concluded the column had been dropped. It had not:
  // information_schema still reports lane text, is_generated=ALWAYS, generation_expression
  // (payload ->> 'lane') on harness_shared.work_items, and harness_shared.engineer_issues
  // exposes lane too (both re-verified 2026-08-30). The real cause was that
  // issueClaimCandidateSubquery's claimability-snapshot projection did not project the
  // column, so on the filterPushdown path — the only path that repro reached, via a spec —
  // the outer FROM-source is a CTE that genuinely lacks it. Fixed at the projection.
  //
  // Alias-aware by construction: every caller evaluates this against a relation that HAS the
  // column (work_items base, the now-corrected snapshot CTE, or engineer_issues), so the lane
  // column tracks whatever alias the caller's payload column names. Semantics are unchanged
  // and still NULL-safe — the column is NULL exactly when payload ->> 'lane' would be, and
  // IS DISTINCT FROM keeps a NULL lane INCLUDED.
  const laneCol = payloadCol === 'payload' ? 'lane' : `${payloadCol.split('.')[0]}.lane`;
  return sql`${sql.unsafe(laneCol)} IS DISTINCT FROM 'observation'`;
}

/**
 * The strict OWNER-ACTION self-select exclusion floor. This key is written only for a typed
 * capability an agent cannot supply: credential, physical-device, or external-service-action.
 * Migration 864 retired the ambiguous payload.needsHuman admission floor; owner action and
 * peer review now have independent, typed destinations.
 */
export function needsOwnerActionExclusionSql(sql: OrgSql) {
  return sql`COALESCE(wi.payload, '{}'::jsonb) ->> 'needsOwnerAction' IS DISTINCT FROM 'true'`;
}

/** Typed external blockers are queue gates, not prose annotations. An issue with
 * any active event/gate/runtime/human dependency stays visible and directly
 * claimable by id, but is excluded from opportunistic self-selection until the
 * blocker is explicitly cleared. Feature-family rows are also moved to their
 * native `blocked` state by work_items:set_blocker. */
export function externalBlockersExclusionSql(sql: OrgSql) {
  return sql`NOT EXISTS (
    SELECT 1
      FROM jsonb_path_query(
        COALESCE(wi.payload, '{}'::jsonb),
        '$.externalBlockers[*]'::jsonpath
      ) blocker
     WHERE lower(COALESCE(blocker ->> 'status', '')) = 'active'
  )`;
}

/**
 * Reconcile a settled announced event with the typed external blockers that
 * wait on it. Event settlement and blocker clearing must share the caller's
 * transaction: otherwise the announcement can become superseded while the
 * work item remains parked, which strands it outside scheduler self-select.
 *
 * Only the matching active event blocker is cleared. The record remains in
 * the payload history, and unrelated blockers continue to gate the item. An
 * issue-family row that was auto-parked by `work_items:set_blocker` is restored
 * to `open` only after the last active blocker is gone; a durable claim park is
 * preserved while its temporary blocked lease is removed. Feature-family
 * lifecycle state is intentionally untouched here.
 */
export async function reconcileEventExternalBlockers(
  tx: OrgSql | TransactionSql,
  eventKey: string,
  actor?: string,
  now = new Date().toISOString(),
): Promise<{ cleared: number; restored: number }> {
  const ref = eventKey.trim();
  if (!ref) return { cleared: 0, restored: 0 };

  const settledBy = actor?.trim() || 'system:event-settlement';
  const parsedNow = Date.parse(now);
  const updatedTs = Number.isFinite(parsedNow) ? parsedNow : Date.now();
  const rows = await tx<
    {
      workspace_id: string;
      feature_id: string;
      item_kind: string | null;
      status: string | null;
      payload: unknown;
    }[]
  >`
    SELECT workspace_id, feature_id, item_kind, status, payload
      FROM harness_shared.work_items
     WHERE COALESCE(payload, '{}'::jsonb) @> jsonb_build_object(
       'externalBlockers',
       jsonb_build_array(jsonb_build_object('kind', 'event', 'ref', ${ref}::text, 'status', 'active'))
     )
     FOR UPDATE
  `;

  let cleared = 0;
  let restored = 0;
  for (const row of rows) {
    const payload =
      row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload)
        ? (row.payload as Record<string, unknown>)
        : {};
    const history = updateExternalBlockerHistory(payload, { kind: 'event', ref, clear: true }, settledBy, now);
    if (!history.changed) continue;

    const activeBlockers = history.blockers.some((blocker) => blocker.status === 'active');
    const issueFamily = ['bug', 'change', 'task'].includes(String(row.item_kind));
    const autoBlockedIssue =
      issueFamily && String(row.status ?? '').toLowerCase() === 'blocked' && payload.held_open_reason === 'blocked';
    const restoreIssue = autoBlockedIssue && !activeBlockers;
    const nextPayload: Record<string, unknown> = {
      ...payload,
      externalBlockers: history.blockers,
    };

    if (restoreIssue) {
      delete nextPayload.held_open_by;
      delete nextPayload.held_open_at;
      delete nextPayload.held_open_reason;
      // A durable claim park may coexist with the temporary blocked lease.
      // Match setWorkItemClaimHold(..., { leaseOnly:true }) and retain it.
      if (typeof payload.claim_hold_by !== 'string' || payload.claim_hold_by.trim() === '') {
        delete nextPayload._claimHold;
      }
      restored += 1;
    }

    await tx`
      UPDATE harness_shared.work_items
         SET payload = ${JSON.stringify(nextPayload)}::text::jsonb,
             status = CASE WHEN ${restoreIssue} THEN 'open' ELSE status END,
             updated_ts = ${updatedTs}
       WHERE workspace_id = ${row.workspace_id}
         AND feature_id = ${row.feature_id}
    `;
    cleared += 1;
  }

  return { cleared, restored };
}

/**
 * The `work_item_deps` BLOCKING floor for ISSUE-family SELF-SELECT, as ONE shared
 * fragment. Assumes the candidate row is aliased `wi` (feature_id / workspace_id in
 * scope), like every sibling floor helper here.
 *
 * ISSUE-family only, and the ref form is load-bearing: an issue's `blocked_ref` is its
 * BARE feature_id (issues:link), whereas the FEATURE family stores a harness-qualified
 * ref and is gated by `harness_shared.work_item_is_blocked()` + the maintained
 * `work_item_blocked` sidecar instead (the wir_* triggers don't track issues, so the
 * sidecar would report a blocked issue as ready). Do NOT "unify" the two by matching
 * both ref forms here — that would over-gate the feature family (D-007).
 *
 * SELF-SELECT only, by design: dependency-blocking is a READINESS floor, and per D-008
 * readiness floors gate self-select while the by-id claim (`claimWorkItem`/`claimIssue`)
 * is the deliberate operator override — taking a blocked item by name is how you take
 * ownership in order to unblock it. Security/admission floors (autoPickableWhereSql)
 * are the ones that hold at every door.
 *
 * Extracted for D-007. This predicate had drifted into a SIXTH inline copy in
 * scheduler/get-next.ts, and it was the ONLY floor in that subquery not calling into
 * this file — so while every sibling floor stayed in sync, that copy silently kept the
 * `bi.workspace_id = 'default'` hardcode migration 719 removed everywhere else.
 * Measured live before this extraction: across the 10 open issue-family
 * papercusp-workspace items carrying an edge, the get-next copy reported 0 blocked
 * while this predicate reported 5 — so `work_items:claimable` advertised 5 items the
 * real claim path refuses, and an agent burned a wake on each.
 *
 * `d.workspace_id` stays pinned to the coordination workspace 'default' — that is where
 * the edge table itself is keyed, NOT a blocker scope; scoping it to the item's own
 * workspace would match zero edges and disable blocking entirely.
 */
export function depsBlockedExclusionSql(sql: OrgSql) {
  return sql`NOT EXISTS (
    SELECT 1 FROM harness_shared.work_item_deps d
     WHERE d.workspace_id = 'default'
       AND d.dep_type = 'blocks'
       AND d.blocked_ref = wi.feature_id
       AND ${unsatisfiedBlockerSql(sql)}
  )`;
}

/**
 * "This blocker is UNSATISFIED" — the inner leg of the blocking floor above, as ONE fragment.
 * Assumes a `work_item_deps` row aliased `d` and the blocked candidate aliased `wi`.
 *
 * A blocker is SATISFIED iff TERMINAL or ABSENT, in its own family's vocabulary (feature =
 * passed/deprecated/done/dropped; issue = resolved/closed/done/dropped), resolved within the
 * BLOCKED item's own workspace (migration 719 — see the floor's header).
 *
 * Extracted for P-013, and for exactly the reason D-007 existed: `readUnresolvedDepBlockers`
 * below has to NAME the blockers the claim path considers blocking, so it must not carry its
 * own copy of "is this blocker done?". With two copies, the warning drifts from the floor and
 * starts naming blockers the queue does not gate on (or stays silent on ones it does) — which
 * is worse than no warning, because a warning that disagrees with the floor teaches the reader
 * to distrust both. Note the split this deliberately does NOT touch: the BLOCKED-side ref form
 * stays per-family (bare for issues, harness-qualified for features) — unifying that would
 * over-gate the feature family (D-007's retraction). Only the BLOCKER side is shared.
 */
function unsatisfiedBlockerSql(sql: OrgSql) {
  return sql`(
    EXISTS (
      SELECT 1 FROM harness_shared.harness_features_consolidated bf
       WHERE bf.workspace_id = wi.workspace_id
         -- WI-521425 -- match by SPLITTING the dep-side scalar, never by CONCATENATING the
         -- candidate side. The previous form, (bf.harness_slug || '#' || bf.feature_id) =
         -- d.blocker_ref, is not indexable: EXPLAIN demoted this probe to an Index Scan using
         -- hfc_workspace_idx whose ONLY Index Cond was workspace_id = wi.workspace_id
         -- (~510k rows), with the real selectivity left as a post-scan Filter -- cost 40,840
         -- and ~592ms PER PROBE. ORed with the issue-family EXISTS below it also defeated
         -- PostgreSQL's hashed-subplan plan (a hashed Join Filter at total cost 172,851
         -- degraded to EXISTS(SubPlan 1) OR EXISTS(SubPlan 2) at 6,462,357). That made this
         -- ONE floor exceed the 15s statement cap on its own, and is what timed out
         -- work_items:claimable in papercusp. Splitting the scalar instead lets the base
         -- table's PRIMARY KEY (harness_slug, feature_id) serve the probe: the whole floor
         -- went from TIMEOUT@15s to 582ms over the full 72,005-row population.
         --
         -- EQUIVALENT, and provably so rather than by sampling: the concatenation is
         -- harness_slug + '#' + feature_id and no harness_slug contains '#' (measured: 0 of
         -- 217 distinct slugs), so the FIRST '#' is always the separator and splitting on it
         -- exactly inverts the concat -- including a blocker_ref carrying further '#'s, which
         -- maps to the same (slug, rest) pair under both forms. The position() guard keeps
         -- the no-'#' case matching nothing, exactly as the concat form did (its output
         -- always contains a '#', so it could never equal a ref without one).
         -- WARNING: a harness_slug containing '#' WOULD diverge these two forms; that
         -- invariant is pinned by blocker-ref-join-indexable.test.ts.
         AND position('#' in d.blocker_ref) > 0
         AND bf.harness_slug = split_part(d.blocker_ref, '#', 1)
         AND bf.feature_id = substring(d.blocker_ref from position('#' in d.blocker_ref) + 1)
         AND (
           (d.satisfaction = 'settled' AND bf.status NOT IN ('passed', 'deprecated', 'done', 'dropped'))
           OR (d.satisfaction = 'success' AND bf.status NOT IN ('passed', 'done'))
         )
    )
    OR EXISTS (
      SELECT 1 FROM harness_shared.engineer_issues bi
       WHERE bi.workspace_id = wi.workspace_id
         AND bi.issue_id = d.blocker_ref
         AND (
           (d.satisfaction = 'settled' AND bi.state NOT IN ('resolved', 'closed', 'done', 'dropped'))
           OR (d.satisfaction = 'success' AND bi.state NOT IN ('resolved', 'done'))
         )
    )
  )`;
}

/** One unresolved blocker of a work-item, as stored on the `work_item_deps` edge. */
export interface UnresolvedDepBlocker {
  /** The blocker's ref AS STORED on the edge: bare for an issue, harness-qualified for a feature. */
  ref: string;
  /** The edge's own `blocker_kind` ('issue' | 'feature') — read off the edge, never re-derived. */
  kind: string;
  /** Omitted only by legacy/injected readers; persisted rows always project the settled default. */
  satisfaction?: 'settled' | 'success';
}

/** One active item a member already holds that is blocked by a refused dependency. */
export interface DependencyEscapeBlockedItem {
  id: string;
  kind: string;
  harness: string | null;
}

/**
 * The dependency relationship that turns an ordinary fleet-scope refusal into a
 * control-plane escape: the refused row is an unresolved blocker of work the same
 * member already owns.
 */
export interface HeldDependencyEscapeContext {
  dependencyId: string;
  /** The edge writer's canonical endpoint family (`issue` | `feature`). */
  dependencyKind: string;
  blockedHeldItems: DependencyEscapeBlockedItem[];
}

/**
 * NAME the unresolved blockers of ONE work-item (P-013) — the read behind
 * `blockedClaimWarning` in work_items:claim.
 *
 * This is a REPORTING read, not a floor: per D-008 the dependency-blocking floor gates
 * SELF-SELECT only, and the by-id claim is the deliberate operator override (taking a blocked
 * item by name is how you take ownership in order to unblock it). So this never refuses
 * anything — it exists so the claim can SUCCEED and still tell the claimer what it walked into,
 * which is the WI-5826 remedy shape (the defect there was a missing SIGNAL, not a missing floor).
 *
 * The blocked-side ref form is chosen PER FAMILY, matching the two floors exactly: issue-family
 * rows are keyed by their BARE feature_id (`depsBlockedExclusionSql`), feature-family rows by
 * `<harness>#<feature_id>` (`harness_shared.work_item_is_blocked`). The CASE picks exactly one
 * form per row, so this never matches both and never over-reports.
 *
 * Fail-soft is the CALLER's contract, not this function's: it throws like any other read, and
 * `claim.ts` degrades to no-warning. That direction is deliberate — an advisory that fires
 * spuriously during a PG blip would be worse than silence. It differs from WI-6737's checkpoint
 * case for a concrete reason: that warning ASSERTED "no checkpoint was ever written", so its
 * swallowed error became a false positive claim; this one asserts nothing when it says nothing.
 */
export async function readUnresolvedDepBlockers(id: string, harness?: string): Promise<UnresolvedDepBlocker[]> {
  const { sql } = getOrgPg();
  const rows = await sql<{ blocker_ref: string; blocker_kind: string; satisfaction: 'settled' | 'success' }[]>`
    SELECT DISTINCT d.blocker_ref, d.blocker_kind, d.satisfaction
      FROM harness_shared.work_items wi
      JOIN harness_shared.work_item_deps d
        ON d.workspace_id = 'default'
       AND d.dep_type = 'blocks'
       AND d.blocked_ref = CASE
             WHEN ${issueFamilyRouteSql(sql, 'wi')} THEN wi.feature_id
             ELSE wi.harness_slug || '#' || wi.feature_id
           END
     WHERE wi.feature_id = ${id}
       AND wi.workspace_id = ${activeWorkspaceId()}
       AND ${harness ? sql`wi.harness_slug = ${harness}` : sql`TRUE`}
       AND ${unsatisfiedBlockerSql(sql)}
     ORDER BY d.blocker_ref
     LIMIT 25`;
  return rows.map((r) => ({ ref: r.blocker_ref, kind: r.blocker_kind, satisfaction: r.satisfaction }));
}

/** One unresolved `blocks` edge on an item the reader holds — see `readHeldUnresolvedDepBlockers`. */
export interface HeldUnresolvedDepBlocker {
  /** The held (blocked) item's feature_id. */
  featureId: string;
  /** The edge's blocker ref, in the blocker family's own form (bare issue id, or `<harness>#<id>`). */
  blockerRef: string;
  blockerKind: string;
  /** When the edge was written, so a reader can age the wait. */
  since: string | null;
}

/**
 * Every unresolved `blocks` edge on the work items `ownerId` currently holds — the EDGE-side
 * twin of the held-item `externalBlockers` read in `derive-awaiting.ts` (WI-10005020, plan
 * feature-drain-delivery-readiness-and-outcome-accounting-2026-10-01 D-008 §4a). R-15 moves
 * work-item-ref external blockers onto `work_item_deps` edges; without this read a migrated item
 * silently drops out of the sender's `awaiting` stamp.
 *
 * It uses the same per-family blocked-ref form and the same `unsatisfiedBlockerSql` predicate as
 * the claim floor, so it names exactly the edges that gate the queue: a `settled` edge whose
 * blocker is done OR dropped is satisfied and is not listed. Bounded; throws like any read — the
 * caller owns fail-soft.
 */
export async function readHeldUnresolvedDepBlockers(args: {
  ownerId: string;
  workspaceId: string;
  limit: number;
}): Promise<HeldUnresolvedDepBlocker[]> {
  if (!args.ownerId || !args.workspaceId || args.limit <= 0) return [];
  const { sql } = getOrgPg();
  const rows = await sql<{ feature_id: string; blocker_ref: string; blocker_kind: string; created_at: Date | string | null }[]>`
    SELECT wi.feature_id, d.blocker_ref, d.blocker_kind, d.created_at
      FROM harness_shared.work_items wi
      JOIN harness_shared.work_item_deps d
        ON d.workspace_id = 'default'
       AND d.dep_type = 'blocks'
       AND d.blocked_ref = CASE
             WHEN wi.item_kind IN ('bug', 'change', 'task') THEN wi.feature_id
             ELSE wi.harness_slug || '#' || wi.feature_id
           END
     WHERE wi.workspace_id = ${args.workspaceId}
       AND wi.taken_by = ${args.ownerId}
       AND wi.status NOT IN ('done', 'resolved', 'deprecated', 'dropped')
       AND ${unsatisfiedBlockerSql(sql)}
     ORDER BY d.created_at DESC NULLS LAST, wi.feature_id, d.blocker_ref
     LIMIT ${args.limit}`;
  return rows.map((r) => ({
    featureId: r.feature_id,
    blockerRef: r.blocker_ref,
    blockerKind: r.blocker_kind,
    since: r.created_at == null ? null : new Date(r.created_at).toISOString(),
  }));
}

/**
 * Find active work held by `member` whose unresolved blocker is `dependencyId`.
 *
 * This is the read-side proof for the fleet dependency-escape lane. It reuses the
 * same per-family ref convention and the same `unsatisfiedBlockerSql` predicate as
 * the scheduler readiness floor, so the refusal cannot call something a dependency
 * that the queue itself considers satisfied. One bounded query covers every held
 * item; no per-claim/N+1 reads.
 */
export async function readHeldDependencyEscapeContext(args: {
  dependencyId: string;
  /** Canonical fleet-member owner id resolved by admission. */
  member: string;
  /** Stable-name/raw claim targets that may already be stored verbatim as `taken_by`. */
  memberAliases?: readonly string[];
  harness?: string | null;
}): Promise<HeldDependencyEscapeContext | null> {
  const dependencyId = args.dependencyId.trim();
  const member = args.member.trim();
  if (!dependencyId || !member) return null;
  const memberRefs = [...new Set([member, ...(args.memberAliases ?? []).map((alias) => alias.trim()).filter(Boolean)])];
  const { sql } = getOrgPg();
  const rows = await sql<
    {
      dependency_kind: string;
      blocked_id: string;
      blocked_kind: string;
      blocked_harness: string | null;
    }[]
  >`
    WITH refused AS (
      SELECT feature_id, item_kind, harness_slug,
             CASE
               WHEN item_kind IN ('bug', 'change', 'task') THEN feature_id
               ELSE harness_slug || '#' || feature_id
             END AS dependency_ref
        FROM harness_shared.work_items
       WHERE workspace_id = ${activeWorkspaceId()}
         AND feature_id = ${dependencyId}
         AND ${args.harness ? sql`harness_slug = ${args.harness}` : sql`TRUE`}
       LIMIT 1
    )
    SELECT DISTINCT d.blocker_kind AS dependency_kind,
           wi.feature_id AS blocked_id,
           wi.item_kind AS blocked_kind,
           wi.harness_slug AS blocked_harness
      FROM refused r
      JOIN harness_shared.work_item_deps d
        ON d.workspace_id = 'default'
       AND d.dep_type = 'blocks'
       AND d.blocker_ref = r.dependency_ref
      JOIN harness_shared.work_items wi
        ON wi.workspace_id = ${activeWorkspaceId()}
       AND d.blocked_ref = CASE
             WHEN wi.item_kind IN ('bug', 'change', 'task') THEN wi.feature_id
             ELSE wi.harness_slug || '#' || wi.feature_id
           END
     WHERE wi.taken_by = ANY(${memberRefs}::text[])
       AND NOT (wi.status = ANY(${ANY_FAMILY_TERMINAL_STATES as string[]}::text[]))
       AND ${unsatisfiedBlockerSql(sql)}
     ORDER BY wi.feature_id
     LIMIT 25`;
  if (rows.length === 0) return null;
  return {
    dependencyId,
    dependencyKind: rows[0]?.dependency_kind ?? 'unknown',
    blockedHeldItems: rows.map((row) => ({
      id: row.blocked_id,
      kind: row.blocked_kind,
      harness: row.blocked_harness,
    })),
  };
}

/**
 * The FEDERATION-DETECTOR self-select EXCLUSION floor for issue-family claims (WI-2633). The
 * replication-liveness detector (replication-stall-ei.ts, P-004/WI-1840) auto-files durable EIs
 * for connected-but-dead peers (no_replicator / frozen / connected_never_replicated /
 * drain_stalled / drain_backlog_stalled / drain_orphan_tail). These land in the GENERAL
 * papercusp backlog every fleet member self-pulls through, but a generic backlog-drain worker
 * structurally CANNOT resolve one: verifying the current verdict needs the p2p-release-readiness
 * fleet's live IN-PROCESS getReplicationLiveness()/dogfood-substrate-status (not PG-queryable),
 * or design judgment on core swarm-join code that fleet owns. So each generic pickup can only
 * ever close it as gated-to-another-fleet after a live-status check it can't cheaply make —
 * burning a wake every time (WI-2633 observed this repeatedly). Compounding it, recovery
 * auto-resolve (resolveReplicationStallEi, EI-7110) is edge-triggered on OBSERVING the same
 * (harness,log,kind) recover, so an EI whose harness/log never re-boots sits open indefinitely
 * and keeps re-surfacing to self-selectors.
 *
 * Keys on the `_ei` envelope work_items mirrors from engineer_issues — `_ei.created_by` is the
 * detector's stable filer identity ('system:replication-liveness', == RECOVERY_OWNER) — so it
 * covers every already-open detector EI with NO backfill/migration/filer change. Mirrors
 * {@link needsOwnerActionExclusionSql}'s shape/placement exactly (same NULL-safe COALESCE, same
 * POOL+READY+claim call sites) so an all-federation-EI backlog also reads `drained:true`
 * instead of idling a generic drainer on unpickable rows. UNCONDITIONAL (no caller bypass):
 * no GENERIC self-select caller legitimately wants one — still directly claimable BY ID, so the
 * p2p fleet (or an operator) can act on it via its own topic:'federation' triage.
 */
export function federationDetectorExclusionSql(sql: OrgSql) {
  // COALESCE + nested #>> so a NULL-payload / no-_ei row reads NULL, and
  // `NULL IS DISTINCT FROM 'system:replication-liveness'` = TRUE ⇒ the row is INCLUDED.
  return sql`COALESCE(wi.payload, '{}'::jsonb) #>> '{_ei,created_by}' IS DISTINCT FROM 'system:replication-liveness'`;
}

/**
 * The LOOP-ITERATION-NOISE self-select EXCLUSION floor for issue-family claims (EI-8802). An
 * AUTO-loop iteration's own progress-tracking marker — titled "Loop wake #N: continue backlog
 * drain..." or "AUTO loop iteration: claim and process next backlog item (su-XXXXX, <date>)" —
 * is the agent's PRIVATE carry-note misfiled via `work_items:create` instead of
 * `loop:checkpoint` (which is private and never enters the shared queue). Self-selecting one
 * wastes a full claim cycle for zero real work: WI-3077 (filed 2026-07-05, su-a5da9b5a) and
 * WI-3078 (filed 2026-07-05, su-40106c58) both sat open 4 days, each independently claimed and
 * resolved as noise, before this floor existed.
 *
 * Title-pattern ILIKE rather than a payload tag (unlike observation-lane/owner-action/federation-
 * detector, above): these rows predate any tagging convention and a new agent can still
 * accidentally recreate the pattern even after `improvements:capture`/`loop:checkpoint` guidance
 * — a durable floor stops the CLASS from recurring regardless of whether every agent's loop
 * discipline is fixed. UNCONDITIONAL (no caller bypass): no generic self-select caller
 * legitimately wants one — still directly claimable BY ID (the same named-claim bypass every
 * issue floor allows), so an operator can still inspect/close a stray marker that slips through.
 *
 * Mirrors {@link observationLaneExclusionSql}'s shape/placement exactly (same POOL+READY+claim
 * call sites) so an all-loop-noise backlog also reads `drained:true` instead of idling a
 * generic drainer on unpickable rows, and is likewise ONE source of truth shared by
 * {@link claimNextIssueWorkItem} (the claim) and {@link diagnoseClaimNextMiss} (both counts).
 */
export function loopIterationNoiseExclusionSql(sql: OrgSql) {
  // COALESCE so a NULL title can't NULL-out the whole AND chain (defensive — title is normally
  // required, but this floor must never silently exclude a legitimate untitled row).
  return sql`(
    COALESCE(wi.title, '') NOT ILIKE 'Loop wake #%'
    AND COALESCE(wi.title, '') NOT ILIKE 'AUTO loop iteration:%'
  )`;
}

/**
 * The ALREADY-TERMINALLY-COMPLETED self-select EXCLUSION floor for issue-family claims
 * (EI-8972). `work_items:complete` records a structured completion (terminal_owner +
 * terminal_completion_ref) but a caller can omit the top-level `state` — the tool warns
 * about it (`stateWarning`) but does not reject it, so the row's `status` can be left
 * sitting in a non-terminal value (e.g. 'open') even though it has genuinely been
 * completed/diagnosed. Without this floor that row stays in the claimable pool and a
 * DIFFERENT agent (possibly a different fleet) self-selects it fresh, re-discovering work
 * a peer already finished — observed live: WI-3646, completed+terminal-owned by one agent
 * as a duplicate, re-claimed whole by another via claim_next minutes later because `state`
 * was never flipped off 'open'. A non-null terminal_owner + terminal_completion_ref is
 * itself a strong "already settled, don't re-place" signal independent of `status` — pool-
 * exclude it (like observation/owner-action/federation-detector/loop-noise above) so an
 * all-already-completed backlog also reads `drained:true` instead of idling a drainer on
 * unpickable rows. Still directly claimable BY ID (e.g. to formally flip its `state`).
 *
 * P-004: the "was genuinely completed" signal is now EITHER a completion ref OR an
 * authority judgement. work_items:complete used to auto-fill terminal_completion_ref on
 * every close, which is what made the ref a reliable proxy; that auto-fill is deleted and
 * the gate stamps `authority` instead. Keying on the ref alone would have quietly re-armed
 * EI-8972 for every completion made after P-004 landed — a completed-but-not-flipped row
 * sliding back into the claimable pool for a second agent to redo.
 *
 * `proposed` counts here just as `committed` does, and deliberately so: D-007 holds that an
 * under-evidenced close stays OWNED BY ITS CLOSER and is nagged, never re-queued for a peer
 * to pick up. Excluding it from the pool is exactly that rule.
 */
export function alreadyTerminallyCompletedExclusionSql(sql: OrgSql) {
  return sql`(
    (wi.terminal_owner IS NULL OR wi.terminal_owner = '')
    OR (
      (wi.terminal_completion_ref IS NULL OR wi.terminal_completion_ref = '')
      AND wi.authority IS NULL
    )
  )`;
}

/**
 * Set (or clear) a work-item's self-select claim hold (WI-2797; extended to BOTH families by
 * fleet-deltas-leader-primitives P-006). A held item is excluded from
 * `claim_next`/`scheduler:get_next` self-selection (issue family: {@link claimHoldExclusionSql};
 * feature family: the `_claimHold` floor in {@link claimFloorsWhereSql}) but stays otherwise
 * normal — visible, commentable, and claimable directly BY ID. With `opts.by`, the hold is a
 * named HOLD-OPEN: `held_open_by`/`held_open_reason` are stamped so `setWorkItemState`'s
 * held-open guard can refuse a terminal transition by anyone else (EI-8993).
 *
 * TWO provenance modes — the lease/park split (WI-321 boomerang fix):
 *   - `opts.by` → a LEASE (`held_open_*`): gates non-holder terminal transitions and is
 *     liveness-bound — the WI-4531 reaper lifts it (hold + `_claimHold`) once the holder is
 *     dead past grace. Right for hold_open and the blocked-issue auto-hold, where a lapsed
 *     gate self-heals by letting the pool retry.
 *   - `opts.parkedBy` → a DURABLE PARK (`claim_hold_*`): records who parked it and why but
 *     is NOT a lease — no reaper touches it and it never gates a terminal transition, so it
 *     survives its parker's session ending. Right for `release {claimHold:true}` ("do not
 *     self-select this again"), whose whole point outlives the ephemeral agent that judged
 *     it: before this split, eight agents in 27h re-claimed the SAME parked umbrella item
 *     (WI-321) because each park lapsed ~2h after its parker's session died. Cleared only
 *     deliberately (`claimHold:false` / hold-clear) — visible for triage via the
 *     burn_down 'claim-hold' bucket, never starved invisibly.
 */
export async function setWorkItemClaimHold(
  id: string,
  hold: boolean,
  opts: {
    harness?: string;
    /** P-006 (fleet-deltas-leader-primitives, EI-8993): stamp WHO holds the item
     *  open (`held_open_by`) + why (`held_open_reason`) alongside `_claimHold`,
     *  so a terminal transition by a NON-holder can refuse (setWorkItemState's
     *  held-open guard) and peers can see whose gate it is. Omitted ⇒ the legacy
     *  anonymous hold (tag only). */
    by?: string;
    reason?: string;
    /** Durable-park provenance (`claim_hold_by`/`claim_hold_at`) — who parked the item out
     *  of self-select, WITHOUT lease semantics: not reaped on parker death, never gates a
     *  terminal transition. */
    parkedBy?: string;
    parkedReason?: string;
    /** Typed, evidence-bearing release condition for a durable park. The public
     *  park writer resolves this from the event ledger rather than trusting a
     *  caller-supplied reachability assertion (WI-141378 / D-025). */
    releaseContract?: {
      condition: string;
      owner: string;
      trigger: string;
      reachability: 'reachable' | 'blocked' | 'unreachable' | 'satisfied';
      evidence: string;
    };
    /** Clear ONLY the `held_open_*` lease, preserving a coexisting durable park
     *  (`_claimHold` + `claim_hold_*`). For AUTOMATED liveness-triggered lifts (the inline
     *  expired-lease chokepoint); explicit agent clears stay full. */
    leaseOnly?: boolean;
    /** When clearing a lease, require the stored `held_open_by` to match this holder.
     *  Consequence reclaims pass the holder captured by the due-row read so a raced
     *  successor's lease cannot be cleared accidentally. */
    expectedLeaseHolder?: string;
  } = {},
): Promise<{ id: string; harness: string | null; hold: boolean; applicable: boolean } | null> {
  const { sql } = getOrgPg();
  // EI-15345: resolve the item's ACTUAL workspace by id, AMBIENT-INDEPENDENT. The old path
  // derived the write scope from a bare `activeWorkspaceId()` / `issuesScopeWorkspace()` and a
  // `getWorkItem(id)` lookup that pins to `activeWorkspaceId()` — both resolved several awaits
  // deep in the release-tool call chain (release handler -> releaseOne -> here). When the
  // AsyncLocalStorage request scope is lost there (the WI-5261 class, "confirmed live for
  // papercusp-workspace, 2026-07-17" — the exact WI-1281 incident date), `activeWorkspaceId()`
  // silently falls through to the process-global default. When that did NOT match the item's own
  // workspace, `getWorkItem` returned null and this whole function no-op'd: the `release
  // {claimHold:true}` call reported success but `_claimHold` was NEVER persisted, so
  // `scheduler:get_next` (already WI-5261-hardened to resolve the correct workspace, and it
  // DOES apply the `_claimHold` feature floor via `claimFloorsWhereSql`) kept re-serving the item.
  //
  // Locate the row by id from the ONE work_items surface — PREFER the active-workspace row when
  // present (unchanged behavior for the healthy case + disambiguates a cross-workspace id
  // collision, F-B3), else take the row regardless of ambient scope. Both families live in the
  // work_items view; the write below targets it scoped by the row's OWN (workspace_id, feature_id).
  const located = await sql<{ harness_slug: string | null; workspace_id: string }[]>`
    SELECT harness_slug, workspace_id
      FROM harness_shared.work_items
     WHERE feature_id = ${id}
       AND ${opts.harness ? sql`harness_slug = ${opts.harness}` : sql`TRUE`}
     ORDER BY (workspace_id = ${activeWorkspaceId()}) DESC, updated_ts DESC NULLS LAST
     LIMIT 1`;
  if (!located[0]) return null;
  const ws = located[0].workspace_id;
  const expectedLeaseHolder = opts.expectedLeaseHolder?.trim() || null;
  const holdPatch = JSON.stringify({
    _claimHold: true,
    ...(opts.by ? { held_open_by: opts.by, held_open_at: new Date().toISOString() } : {}),
    ...(opts.reason ? { held_open_reason: opts.reason } : {}),
    ...(opts.parkedBy ? { claim_hold_by: opts.parkedBy, claim_hold_at: new Date().toISOString() } : {}),
    ...(opts.parkedReason ? { claim_hold_reason: opts.parkedReason } : {}),
    ...(opts.releaseContract ? { claim_hold_release: opts.releaseContract } : {}),
  });
  const rows = await sql<{ payload: Record<string, unknown> | null }[]>`
    UPDATE harness_shared.work_items
       SET payload = CASE
             WHEN ${hold} THEN COALESCE(payload, '{}'::jsonb) || ${holdPatch}::text::jsonb
             WHEN ${opts.leaseOnly === true} AND COALESCE(payload, '{}'::jsonb) ? 'claim_hold_by'
             THEN COALESCE(payload, '{}'::jsonb) - 'held_open_by' - 'held_open_reason' - 'held_open_at'
             ELSE COALESCE(payload, '{}'::jsonb) - '_claimHold' - 'held_open_by' - 'held_open_reason' - 'held_open_at'
                    - 'claim_hold_by' - 'claim_hold_reason' - 'claim_hold_at' - 'claim_hold_release'
           END,
           updated_ts = ${Date.now()}
     WHERE workspace_id = ${ws} AND feature_id = ${id}
       AND (
         ${hold}
         OR ${expectedLeaseHolder}::text IS NULL
         OR COALESCE(payload, '{}'::jsonb) ->> 'held_open_by' = ${expectedLeaseHolder}
       )
     RETURNING payload`;
  if (!rows[0]) return null;
  // EI-18672701535825889 finding #3: a floor that hides work from a whole fleet had ZERO
  // audit_log rows — a leader auditing "why is my claim-hold count non-zero" via audit:list
  // saw nothing, forcing a per-row payload dig. Fire-and-forget (mirrors
  // release-force-guard.ts's recordForceReleaseAudit; never blocks/throws the caller).
  const auditActor = opts.by ?? opts.parkedBy ?? null;
  void sql
    .unsafe(
      `INSERT INTO harness_shared.audit_log (id, ts, actor, action, subject, details, workspace_id)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
      [
        `wi-claim-hold-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        Date.now(),
        auditActor ?? 'system',
        hold ? 'work_items:claim_hold:set' : 'work_items:claim_hold:clear',
        id,
        JSON.stringify({
          mode: opts.by ? 'held_open' : opts.parkedBy ? 'claim_hold' : opts.leaseOnly ? 'lease_only_clear' : 'clear',
          by: auditActor,
          reason: opts.reason ?? opts.parkedReason ?? null,
          releaseContract: opts.releaseContract ?? null,
          leaseOnly: opts.leaseOnly === true,
        }),
        ws,
      ],
    )
    .catch((err: unknown) => {
      // Swallow "relation does not exist" (Postgres 42P01) quietly — many lightweight test
      // fixtures (createFreshPgDb + a hand-picked DDL subset, not the full baseline) never
      // create harness_shared.audit_log, and this write is genuinely fire-and-forget/optional
      // (never blocks or fails the actual hold). A vitest-fail-on-console guard elsewhere in
      // the suite fails a test on ANY console.warn, so warning here on an EXPECTED-missing
      // table in a test fixture would regress every claim-hold test using that fixture; still
      // warn on anything else (a real prod audit-write failure stays visible).
      const code = (err as { code?: string } | undefined)?.code;
      if (code === '42P01') return;
      console.warn('[setWorkItemClaimHold] audit write failed:', (err as Error)?.message);
    });
  return { id, harness: located[0].harness_slug ?? null, hold, applicable: true };
}

/**
 * EI-19397599078921465: the audit-log write for a `→ blocked` transition on a FEATURE-family
 * work-item — the one genuine hole in lifecycle attribution.
 *
 * The ISSUE family already audits this transition, indirectly: {@link setWorkItemStateWithAliasInfo}
 * auto-parks a blocked issue via {@link setWorkItemClaimHold}, whose own audit write lands a
 * `work_items:claim_hold:set` row with `reason='blocked'` (71 such rows measured live). The FEATURE
 * family has no auto-park, so its blocked-transitions wrote nothing anywhere — measured 2026-08-03:
 * **59 feature items sitting at `blocked` with no record of who moved them or when**. That is the
 * gap this closes, and it is deliberately the ONLY transition audited here: a blanket
 * every-transition log was rejected on volume (audit_log holds ~9.1k rows total against ~13.7k
 * work-items touched in a single day).
 *
 * Contract mirrors {@link setWorkItemClaimHold}'s audit write: fire-and-forget, NEVER throws, and
 * swallows Postgres 42P01 quietly — many lightweight test fixtures (`createFreshPgDb` + a
 * hand-picked DDL subset, not the full baseline) never create `harness_shared.audit_log`, and a
 * console.warn there would red every test using such a fixture via the fail-on-console guard.
 *
 * `sql` is INJECTED rather than resolved internally via `getOrgPg()` — matching
 * {@link recordBulkHoldClearAudit}, not {@link setWorkItemClaimHold} — precisely so this is
 * unit-testable with a fake `{ unsafe }` and needs no PG fixture. Do not "simplify" it to an
 * internal `getOrgPg()`; that trades a 8-assertion unit test for an integration test.
 *
 * Read back by `work-item-lifecycle-history.ts`, which parses exactly the `work_items:state:blocked`
 * action token written below — the two halves must not drift.
 */
export async function recordWorkItemBlockedAudit(
  sql: { unsafe: ReturnType<typeof getOrgPg>['sql']['unsafe'] },
  id: string,
  info: {
    /** The state actually APPLIED (post-alias) — normally 'blocked'. */
    to: string;
    /** What the caller ASKED for, which may differ when the family aliased it. */
    requested: string;
    family: string;
    by?: string | null;
    harness?: string | null;
    /** The ambient workspace, used ONLY to disambiguate a cross-workspace id collision. */
    activeWorkspaceId?: string | null;
  },
): Promise<void> {
  try {
    // EI-15345: resolve the row's OWN workspace_id — never write the audit row against a bare
    // `activeWorkspaceId()`, which silently falls through to the process-global default when the
    // AsyncLocalStorage request scope is lost. A row landed in the wrong tenant reads as ABSENT,
    // which is the exact "nothing was recorded" failure this whole write exists to end.
    const located = await sql.unsafe(
      `SELECT workspace_id
         FROM harness_shared.work_items
        WHERE feature_id = $1 AND ($2::text IS NULL OR harness_slug = $2)
        ORDER BY (workspace_id = $3) DESC, updated_ts DESC NULLS LAST
        LIMIT 1`,
      [id, info.harness ?? null, info.activeWorkspaceId ?? null],
    );
    const ws = (located as unknown as Array<{ workspace_id?: string }>)[0]?.workspace_id;
    if (!ws) return;
    await sql.unsafe(
      `INSERT INTO harness_shared.audit_log (id, ts, actor, action, subject, details, workspace_id)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
      [
        `wi-state-blocked-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        Date.now(),
        info.by ?? 'system',
        'work_items:state:blocked',
        id,
        JSON.stringify({
          to: info.to,
          requested: info.requested,
          family: info.family,
          by: info.by ?? null,
        }),
        ws,
      ],
    );
  } catch (err) {
    const code = (err as { code?: string } | undefined)?.code;
    if (code === '42P01') return; // no audit_log table in this fixture — expected, non-fatal.
    console.warn('[recordWorkItemBlockedAudit] audit write failed:', (err as Error)?.message);
  }
}

/**
 * WI-6774: the structural audit-log write for a BULK, liveness-triggered hold-open clear —
 * `reclaimStaleHoldOpens` and `sweepDeadOwnerControlState` are raw multi-row `UPDATE`s that
 * never went through {@link setWorkItemClaimHold}, so their clears left NO `audit_log` row at
 * all (the incident this closes: a policy-tier fence on a live-money item vanished with zero
 * trace anywhere audit-searchable). Mirrors `setWorkItemClaimHold`'s own audit write —
 * fire-and-forget, never throws, swallows the "table doesn't exist" case some lightweight test
 * fixtures hit — so a sweep's clear is now audit-visible exactly like an explicit one, just
 * tagged with its own actor id instead of an agent's.
 */
export async function recordBulkHoldClearAudit(
  sql: { unsafe: ReturnType<typeof getOrgPg>['sql']['unsafe'] },
  rows: ReadonlyArray<{ id: string; workspaceId: string; formerHolder: string | null }>,
  opts: { actor: string; sweepName: string },
): Promise<void> {
  if (rows.length === 0) return;
  await Promise.all(
    rows.map((r) =>
      sql
        .unsafe(
          `INSERT INTO harness_shared.audit_log (id, ts, actor, action, subject, details, workspace_id)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
          [
            `wi-claim-hold-${opts.sweepName}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
            Date.now(),
            opts.actor,
            'work_items:claim_hold:clear',
            r.id,
            JSON.stringify({ mode: 'lease_only_clear', sweep: opts.sweepName, formerHolder: r.formerHolder }),
            r.workspaceId,
          ],
        )
        .catch((err: unknown) => {
          const code = (err as { code?: string } | undefined)?.code;
          if (code === '42P01') return; // no audit_log table in this fixture — expected, non-fatal.
          console.warn(`[${opts.sweepName}] audit write failed for ${r.id}:`, (err as Error)?.message);
        }),
    ),
  );
}

/** P-006: who holds a work-item OPEN (payload.held_open_by), or null.
 *  WI-4531: also carries `at` (payload.held_open_at) — the hold's lease anchor, which the
 *  expiry rule (work-items-hold-open.ts) needs to tell a fresh hold from dead residue. */
export function readWorkItemHeldOpenBy(
  payload: unknown,
): { by: string; reason: string | null; at: string | null } | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.held_open_by !== 'string' || !p.held_open_by) return null;
  return {
    by: p.held_open_by,
    reason: typeof p.held_open_reason === 'string' ? p.held_open_reason : null,
    at: typeof p.held_open_at === 'string' ? p.held_open_at : null,
  };
}

/** Durable-park provenance (payload.claim_hold_by), or null. Sibling reader to
 *  {@link readWorkItemHeldOpenBy} for the OTHER `_claimHold` provenance convention
 *  (`release {claimHold:true}`'s park — no lease, no reaper, survives the parker's
 *  session ending; see {@link setWorkItemClaimHold}'s doc comment for the split). */
export function readWorkItemClaimHoldParkedBy(
  payload: unknown,
): { by: string; reason: string | null; at: string | null } | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.claim_hold_by !== 'string' || !p.claim_hold_by) return null;
  return {
    by: p.claim_hold_by,
    reason: typeof p.claim_hold_reason === 'string' ? p.claim_hold_reason : null,
    at: typeof p.claim_hold_at === 'string' ? p.claim_hold_at : null,
  };
}

/**
 * EI-18672701535825889: a UNIFIED read across BOTH `_claimHold` provenance conventions
 * (`held_open_*` lease vs `claim_hold_*` durable park — see {@link setWorkItemClaimHold}'s
 * doc comment). Any surface that reports "who/why is this held" — burn_down's parked-row
 * reason, an ad-hoc audit query, a leader's held-open census — must check BOTH, or a
 * durably-parked row (deliberately gated, e.g. a policy-tier human hold) reads as
 * unattributed corruption when queried by only one convention's field names (the exact
 * near-miss this item documents: 65 policy-gated rows misread as stale, one force-cleared).
 * `attributed` is true when EITHER convention names a holder — the row is NOT a genuine
 * unknown; only rows with `attributed:false` are real unattributed-hold triage candidates.
 */
export function readWorkItemClaimHoldProvenance(payload: unknown): {
  heldOpen: { by: string; reason: string | null; at: string | null } | null;
  parked: { by: string; reason: string | null; at: string | null } | null;
  attributed: boolean;
} {
  const heldOpen = readWorkItemHeldOpenBy(payload);
  const parked = readWorkItemClaimHoldParkedBy(payload);
  return { heldOpen, parked, attributed: Boolean(heldOpen || parked) };
}

/**
 * EI-18698328828208444: `payload._claimHold` can enter a work-item at CREATE time via the
 * caller-supplied `payload: z.record(...)` on `work_items:create` (`_create-core.ts`) — a
 * path that never goes through {@link setWorkItemClaimHold}, so its attribution stamps
 * (`claim_hold_by`/`claim_hold_reason`/`claim_hold_at` or `held_open_by`) never get written.
 * The result is an ANONYMOUS hold: UNREVIEWABLE (no basis for anyone to judge whether it's
 * safe to unpark) and UNEXPIRABLE (every hold-age/audit sweep keys on `claim_hold_at`, which
 * is null here, so the row is invisible to them — excluded from the claim pool forever by
 * default, indistinguishable from a silent delete). Confirmed live: 30 papercusp items this
 * way, oldest untouched ~9 days, every one of them carrying its REAL reason only in a
 * sibling field (`ideaLifecycle.triageReason`, `plan_item`) the claim-hold provenance readers
 * never look at.
 *
 * Call this on any payload about to be PERSISTED where `_claimHold` may have been set by the
 * caller directly rather than through {@link setWorkItemClaimHold}: if the payload sets
 * `_claimHold` truthy and {@link readWorkItemClaimHoldProvenance} finds NEITHER provenance
 * convention, stamp a durable park (`claim_hold_by`/`claim_hold_reason`/`claim_hold_at`) using
 * the acting identity — so a hold can never enter the system anonymous at the source, closing
 * the gap regardless of which caller/lever set the raw flag. A no-op (returns `payload`
 * unchanged, by reference) when `_claimHold` isn't set or is already attributed.
 */
export function ensureClaimHoldAttribution(
  payload: Record<string, unknown> | undefined,
  actorOwnerId: string,
  originNote: string,
): Record<string, unknown> | undefined {
  if (!payload || String(payload._claimHold) !== 'true') return payload;
  if (readWorkItemClaimHoldProvenance(payload).attributed) return payload;
  return {
    ...payload,
    claim_hold_by: actorOwnerId,
    claim_hold_reason: originNote,
    claim_hold_at: new Date().toISOString(),
  };
}

/**
 * EI-18672701535825889 / WI-5946: a claim-hold reason naming a deliberate policy-tier human
 * gate (a `D-NNN` decision id, the triage gate's own `triageDecision:"gate"` marker, or the
 * literal phrase "policy-tier") must not be bypassable by a bare `force:true` — that is the
 * exact near-miss both this predicate's callers exist to stop (a force-adjacent clear of a
 * security gate on a false "unattributed" reading; a by-id claim silently overriding an
 * owner-gated hold with zero friction). `ownerOverride:true` is a second, distinct, audited
 * assertion required in addition to `force`. Shared by `work_items:hold_open`'s clear guard
 * and `work_items:claim`'s claim-hold guard — one predicate, never two copies to drift.
 */
export function looksLikePolicyGate(reason: string | null): boolean {
  if (!reason) return false;
  return (
    /\bD-\d{3}\b/i.test(reason) || /triageDecision\s*[:=]\s*["']?gate["']?/i.test(reason) || /policy-tier/i.test(reason)
  );
}

/**
 * WI-6774: the SAME three patterns {@link looksLikePolicyGate} tests, as POSIX regex source
 * strings for a Postgres `~* ANY(...)` predicate — so the LIVENESS SWEEPS
 * (`reclaimStaleHoldOpens`, `sweepDeadOwnerControlState`) can exclude a policy-tier hold from
 * their bulk raw-SQL clear WITHOUT a second, hand-copied regex list that could silently drift
 * from the JS predicate above (exactly the kind of drift this codebase's other "one predicate,
 * never two copies" comments warn about).
 *
 * Why this exists at all: `looksLikePolicyGate` was, before WI-6774, checked ONLY at the
 * explicit `work_items:hold_open` clear call site. The two liveness sweeps clear
 * `held_open_*`/`_claimHold` via a bulk `UPDATE ... WHERE` keyed purely on holder-liveness +
 * hold age — with NO reason check at all — so a policy-tier fence (set specifically to survive
 * ordinary liveness/session churn, e.g. a live-money trading control) was silently stripped the
 * moment its holder's session went stale past grace, same as any ordinary hold. Measured
 * live 2026-07-28: a policy-tier hold on a critical, owner-gated live-money item was cleared
 * ~35s after crossing the 2h hold-open grace threshold, with no audit_log row anywhere.
 */
export const POLICY_GATE_REASON_SQL_PATTERNS: readonly string[] = [
  String.raw`\yD-\d{3}\y`,
  String.raw`triageDecision\s*[:=]\s*"?'?gate"?'?`,
  String.raw`policy-tier`,
];

/**
 * The issue family's CLAIMABLE statuses — the not-yet-settled `open` state (the issue
 * dialect's single in-flight state; the engineer_issues CHECK has only open|resolved|closed).
 * The scheduler issue-claim branch self-picks an `open`, unblocked issue; terminal
 * (resolved|closed) issues are excluded by status, blocked ones by the readiness predicate.
 */
export const ISSUE_FAMILY_CLAIMABLE_STATES: readonly string[] = ['open'];

/**
 * The FULL set of statuses a pull-tool caller may request via its `states` arg
 * (scheduler:get_next / work_items:claim_next). Feature family: `todo` (fresh) +
 * `failing` (re-drive); issue family: `open`. Everything else is either a resolver
 * FLOOR (`blocked` — leader-triage-only; `cursed`) or terminal — and a caller-supplied
 * `states` must NOT be able to widen past a floor. The claim-spec validator already
 * rejects a `blocked` filter TERM for exactly this reason (D-002); this allowlist
 * closes the identical hole on the sibling `states` arg (WI-1912: a fleet member
 * passed states:['todo','open','blocked'] and pulled a leader-triage-only item).
 *
 * Re-exported from `./scheduler/claim-states` (drain-claim-spec-hardening-2026-07-13,
 * EI-11300/circular-import fix) — that leaf module has zero imports, so
 * `scheduler/claim-spec.ts` can depend on it without closing the long-standing
 * transitive cycle that runs back through this file. Kept as a re-export here so every
 * existing `from '../work-items'` / `from './work-items'` importer of this symbol
 * keeps working unchanged.
 */
export { CLAIM_STATES_ALLOWLIST } from './scheduler/claim-states';

/**
 * fleet-backlog-lessons-2026-07-01 P-005 (WI-1407): the claim-next FALLBACK LADDER. A
 * member's claim loop used to EXIT the moment its first tier read empty — most visibly
 * when a caller NARROWED to one feature-family `kind` (e.g. `kind:'feature'`): the
 * `!filter.kind` gate below used to skip the issue-family fallback ENTIRELY for that
 * caller, even when the flag was on and an issue sat there claimable. That killed members
 * while lower-tier work remained. The ladder now widens through THREE tiers, in order,
 * and only reports a genuine miss once ALL of them are dry:
 *
 *   1. the caller's exact request — `filter.kind` if narrowed, else the whole feature family.
 *   2. (only when tier 1 narrowed by kind) the REST of the feature family — the other
 *      placeable kinds `claimFloorsWhereSql` already admits (`feature` or an opted-in
 *      generic kind). A `kind` is a caller NARROWING, never a floor, so
 *      draining it must widen back out before giving up.
 *   3. the ISSUE family (bug/change/task) — unconditional on `filter.kind` now (it never
 *      applied there anyway: `claimNextIssueWorkItem` doesn't read `filter.kind`), still
 *      gated behind `SCHEDULER_ISSUES_CLAIMABLE` (owner-authority — a brand-new work
 *      SOURCE, the owner ratifies turning it on).
 *
 * Each tier only runs its query when the previous tier came up empty (SKIP LOCKED means a
 * hit ends the ladder immediately), so the OFF-path / kindless / feature-hit cases stay
 * exactly as cheap as before (one UPDATE, zero extra queries).
 */
export async function claimNextWorkItem(filter: ClaimNextFilter): Promise<WorkItem | null> {
  const { sql } = getOrgPg();
  const ws = activeWorkspaceId();
  const useMaintainedReady = await schedulerMaintainedReadyEnabled();
  const operationClaims = await import('./blueprint/operation-worker-binding');
  const operationClaimRead = await operationClaims.readActiveOperationWorkerClaimBinding(ws, filter.assignee);
  if (operationClaimRead.status === 'unavailable') {
    throw new Error(`operation claim authority unavailable: ${operationClaimRead.reason}`);
  }

  // One feature-family claim attempt, optionally narrowed to `kind` — the shared shape
  // for tier 1 (as the caller asked) and tier 2 (widened, kind stripped).
  const claimFeatureRow = async (kind: FeatureFamilyKind | undefined): Promise<WorkItem | null> => {
    // Co-location affinity (P-002): only when the caller passes its Swarm id (it does so
    // only under the per-Hive claim lease, default OFF). Skip work affined to ANOTHER Swarm
    // and prefer work affined to THIS one over unaffined work. Omitted ⇒ affinity-blind,
    // byte-identical to the pre-P-002 claim.
    const rows = await sql<FeatureRowDb[]>`
      UPDATE harness_shared.harness_features_consolidated AS target
         -- P-001: self-select only ever grabs an UNCLAIMED row (the inner WHERE pins
         -- taken_by IS NULL/''), so a fresh holder always starts with a clean progress slate.
         SET payload = jsonb_set(
               COALESCE(target.payload, '{}'::jsonb),
               '{claim_history_post_id}',
               to_jsonb(COALESCE((
                 SELECT max(post.id)
                   FROM harness_shared.coord_thread_posts post
                  WHERE post.workspace_id = ${ws}
               ), 0)),
               true
             ),
             taken_by = ${filter.assignee}, taken_at = now(), last_progress_at = NULL, updated_ts = ${Date.now()}
       WHERE (harness_slug, feature_id) = (
         SELECT harness_slug, feature_id
           FROM harness_shared.harness_features_consolidated
          WHERE ${claimFloorsWhereSql(sql, {
            harness: filter.harness,
            workspaceId: ws,
            states: filter.states,
            swarmId: filter.swarmId,
            excludeRedundant: filter.excludeRedundant,
            useMaintainedReady,
            cooldownAssignee: filter.assignee,
            // EI-14806: feature-family rig floor — same rigAvailable the issue tier already honors.
            rigAvailable: filter.rigAvailable,
            claimantFleetSlug: filter.claimantFleetSlug,
            claimSpecReferencesFleet: filter.claimSpecReferencesFleet,
            claimSpecReferencesGoal: filter.claimSpecReferencesGoal,
          })}
            AND ${operationClaims.operationWorkerClaimWhereSql(sql, operationClaimRead, {
              payload: 'payload', id: 'feature_id', harness: 'harness_slug',
            })}
            -- caller-supplied NARROWING (not a floor): restrict to one feature-family kind.
            AND ${kind ? sql`item_kind = ${kind}` : sql`TRUE`}
          -- P-010: when activated (swarmId present ⇒ the per-Hive claim lease is on), claim_next
          -- RESPECTS the Mug's priority — affinity match first, then lower feature_order (the
          -- per-harness wave/plan order the Mug steers, D-003/D-009), then oldest-first
          -- (anti-starvation). Flag OFF ⇒ plain oldest-first, byte-identical to before.
          ORDER BY ${filter.swarmId ? sql`(swarm_affinity = ${filter.swarmId}) DESC NULLS LAST, feature_order ASC NULLS LAST,` : sql``} created_ts ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED
       )
      RETURNING ${sql.unsafe(FEATURE_COLS)}`;
    return rows[0] ? featureRowToWorkItem(rows[0]) : null;
  };

  // Tier 1: exactly what the caller asked for.
  let claimed = await claimFeatureRow(filter.kind);

  // Tier 2: the caller narrowed to one kind and it's dry — widen to the rest of the
  // ACTIVE placement family before giving up. Retired chunk rows remain outside the
  // floor, even when an old caller still supplies kind:'chunk'.
  if (!claimed && filter.kind) {
    claimed = await claimFeatureRow(undefined);
  }

  // Tier 3 — work-item-deps-and-readiness P-007 (SCHEDULER_ISSUES_CLAIMABLE): the whole
  // feature family is exhausted — ADDITIVELY fall through to the issue family too, an
  // UNBLOCKED, unclaimed, open bug/change/task. Previously gated behind `!filter.kind`,
  // which meant a kind-narrowed caller NEVER reached this tier even when otherwise
  // eligible — the same premature-exit bug as tier 2, one family further out (`filter.kind`
  // is a feature-family type and was never read by `claimNextIssueWorkItem` anyway, so
  // dropping the gate changes nothing about WHICH issues are eligible).
  if (!claimed && (await schedulerIssuesClaimableEnabled())) {
    claimed = await claimNextIssueWorkItem(filter, ws);
  }
  // plugin-system-hive-port P-004: same claimed-event as claimWorkItem.
  if (claimed) {
    claimed.interestWatch = await armWorkItemHolderInterests(claimed, filter.assignee);
    void trackDetached(import('./work-items-events')
      .then((m) => m.emitWorkItemClaimedEvent(claimed!, filter.assignee)))
      .catch(() => {});
  }
  return claimed;
}

/**
 * Why did `claimNextWorkItem` return null? (EI-5919.) A bare null CONFLATES two very
 * different states, and the claim tool historically flattened both into the single message
 * "no claimable work-item":
 *   • DRAINED — there is genuinely no unclaimed work in a claimable state (idling is correct).
 *   • PRESENT-but-UNCLAIMABLE — unclaimed items DO exist, but every one is currently gated
 *     out of self-select: BLOCKED (a non-terminal blocker), affined to another Swarm,
 *     high-stakes/redundant (fans out via claim_replica), or a race just took the last ready
 *     one. The queue is NOT drained — a bee that idles here caps fleet throughput on a full
 *     backlog (the EI-5803 "fleet saturated with work still queued" signal).
 *
 * A self-select being STRICTER than a NAMED `work_items:claim(id)` is BY DESIGN, not a
 * defect: the named claim deliberately bypasses the status / readiness / placeable-kind
 * floors (the named-assignment exception), so an item that is directly claimable by id can
 * be legitimately un-self-selectable. This read-only diagnosis — run ONLY on a claim MISS,
 * never on the hot path — names WHY the self-select missed so the caller can act instead of
 * blindly idling.
 *
 *   • pendingUnclaimed — the admissible, unclaimed, claimable-status, placeable-kind POOL
 *     for this harness/workspace, BEFORE the readiness/affinity/redundancy floors. >0 ⇒ work
 *     exists here; the miss was a gate, not an empty queue. drained === (pendingUnclaimed===0).
 *   • readyUnclaimed — of that pool, how many pass ALL the floors claim_next enforces (the
 *     SAME `claimFloorsWhereSql`, incl. readiness). >0 on a miss ⇒ a race / lost lease
 *     (transient — retry); 0 with pendingUnclaimed>0 ⇒ the rest is genuinely blocked/gated
 *     (don't idle, but don't hot-retry either).
 *
 * fleet-backlog-lessons-2026-07-01 P-005 (WI-1407): `claimNextWorkItem` no longer exits on
 * an empty kind-narrowed tier — it widens through the fallback LADDER (rest of the feature
 * family, then the issue family) before truly missing, so this diagnosis is only ever run
 * once ALL tiers are dry. It mirrors that ladder rather than narrowing by `filter.kind` (a
 * kind-narrowed pool alone would misreport `drained:true` while the wider family still had
 * work claim_next would have widened into) and folds in the issue-family pool whenever the
 * `SCHEDULER_ISSUES_CLAIMABLE` gate is on, so `drained` means "every tier claim_next would
 * try is empty", never just the caller's first, narrowest ask.
 */
export interface ClaimMissDiagnosis {
  drained: boolean;
  pendingUnclaimed: number;
  readyUnclaimed: number;
  /** EI-14108: non-null iff the `SCHEDULER_ISSUES_CLAIMABLE` flag read FAILED (fail-closed,
   *  tier-3 issue-family counts below were skipped this call) rather than the flag genuinely
   *  being off — so a caller can say "issue-claim flag UNREADABLE" instead of implying the
   *  issue-family pool is empty/out-of-scope. */
  flagReadError: string | null;
}

export async function diagnoseClaimNextMiss(filter: ClaimNextFilter): Promise<ClaimMissDiagnosis> {
  const { sql } = getOrgPg();
  const ws = activeWorkspaceId();
  // work-item-status-full-unify P-004/P-005: default to the unified claimable token ['open'].
  const states = filter.states ?? ['open'];
  const useMaintainedReady = await schedulerMaintainedReadyEnabled();
  // POOL: admissible + unclaimed + claimable-status + placeable-kind, WITHOUT the
  // readiness / affinity / redundancy floors — "is there work here a bee shouldn't idle on".
  // NOT narrowed by `filter.kind`: a kind is claim_next's tier-1 NARROWING, and the ladder
  // above widens past it before actually missing, so the diagnosis must look at the same
  // full family a genuine miss already exhausted.
  const poolRows = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n
      FROM harness_shared.harness_features_consolidated
     WHERE harness_slug = ${filter.harness}
       AND workspace_id = ${ws}
       AND ${frontierPlacementKindClause(sql, ws)}
       AND ${autoPickableWhereSql(sql, ws)}
       AND (taken_by IS NULL OR taken_by = '')
       AND status = ANY(${states}::text[])`;
  // READY: passes ALL the floors claim_next enforces (the SAME source of truth — no drift).
  const readyRows = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n
      FROM harness_shared.harness_features_consolidated
     WHERE ${claimFloorsWhereSql(sql, {
       harness: filter.harness,
       workspaceId: ws,
       states: filter.states,
       swarmId: filter.swarmId,
       excludeRedundant: filter.excludeRedundant,
       useMaintainedReady,
       // EI-14806: mirror the claim's feature-family rig floor so READY never over-counts a
       // rig-gated feature the claim would skip for a no-rig caller (same as the issue leg below).
       rigAvailable: filter.rigAvailable,
       claimantFleetSlug: filter.claimantFleetSlug,
       claimSpecReferencesFleet: filter.claimSpecReferencesFleet,
       claimSpecReferencesGoal: filter.claimSpecReferencesGoal,
     })}`;
  let pendingUnclaimed = poolRows[0]?.n ?? 0;
  let readyUnclaimed = readyRows[0]?.n ?? 0;

  // Tier 3 of the same ladder: fold in the issue-family counts when the gate is on, so an
  // issue-only backlog is never reported as a drained queue (claim_next would have widened
  // into it too before missing). BOTH halves must count issues, not just the POOL: the
  // feature `readyRows` above reads only harness_features_consolidated, so an issue-only
  // backlog that is READY (unblocked) would leave readyUnclaimed=0 while pendingUnclaimed>0
  // — the "genuinely blocked/gated, don't hot-retry" verdict — even though claim_next's
  // issue tier would have served it (a lost-lease/race that SHOULD retry). Count the ready
  // issue pool with the SAME floors claimNextIssueWorkItem enforces (affinity + redundancy +
  // the inline blocker-terminality readiness) so readyUnclaimed reflects the whole ladder.
  const issuesClaimableEnabled = await schedulerIssuesClaimableEnabled();
  // EI-14108: capture whether THAT call failed (fail-closed) vs. genuinely returned false, so
  // the diagnosis below never silently presents an unreadable flag as an empty issue pool.
  const flagReadError = lastIssuesClaimableFlagReadError();
  if (issuesClaimableEnabled) {
    const issueWs = issuesScopeWorkspace();
    const operatorScopeSlug = `operator:${issueWs}`;
    const issueCooldown = releaseCooldownSec();
    // EI-19370051676057812: honor an explicit `states` override on the ISSUE legs too. Both
    // counts below used to hardcode ISSUE_FAMILY_CLAIMABLE_STATES while the FEATURE legs above
    // read `filter.states ?? ['open']`, so a caller passing e.g. states:['failing'] got its
    // feature counts filtered and its issue counts NOT — silently blended into one
    // pendingUnclaimed/readyUnclaimed/drained verdict with no error. That made THIS diagnostic
    // disagree with the claim path it exists to explain: explainIssueClaimFloors (below) already
    // computes `filter.states?.length ? filter.states : ISSUE_FAMILY_CLAIMABLE_STATES`, and
    // claimNextIssueWorkItem honors a states override, so a state-specific miss was diagnosed
    // against a pool the claim would never serve. Same shape as :4521 — one source of truth.
    const issueStates = filter.states?.length ? [...filter.states] : [...ISSUE_FAMILY_CLAIMABLE_STATES];
    const issuePoolRows = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n
        FROM harness_shared.work_items wi
       WHERE wi.item_kind IN ('bug', 'change', 'task')
         AND wi.workspace_id = ${issueWs}
         AND (wi.harness_slug = ${filter.harness} OR wi.harness_slug = ${operatorScopeSlug})
         AND (wi.taken_by IS NULL OR btrim(wi.taken_by) = '' OR lower(btrim(wi.taken_by)) = 'unassigned')
         AND wi.status = ANY(${issueStates}::text[])
         -- D-005: observation-lane rows never enter the work queue, so they are NOT part of the
         -- "work here a bee shouldn't idle on" POOL — excluding them here (not just from READY,
         -- as the rig/claimHold floors are) lets a scorecard-only backlog read drained:true.
         AND ${observationLaneExclusionSql(sql)}
         AND ${needsOwnerActionExclusionSql(sql)}
         -- D-003/P-004: pending/revision-requested rows are owned by the reviewer/revision
         -- lifecycle, not the normal implementation pool. Approval re-admits them.
         AND ${agentReviewNormalExclusionSql(sql)}
         AND ${externalBlockersExclusionSql(sql)}
         -- WI-2633: an auto-filed replication-liveness detector EI is gated to the p2p fleet and
         -- unactionable by a generic self-selector — pool-exclude it too (like observation/
         -- needsHuman) so an all-federation-EI backlog reads drained:true instead of idling a
         -- drainer on unpickable rows.
         AND ${federationDetectorExclusionSql(sql)}
         -- EI-8802: a stray AUTO-loop-iteration bookkeeping marker is likewise not work-queue
         -- material AT ALL — pool-exclude it too, same rationale as observation/owner-action.
         AND ${loopIterationNoiseExclusionSql(sql)}
         -- EI-8972: a row already carrying a genuine terminal completion (terminal_owner +
         -- terminal_completion_ref both set) is likewise not work-queue material AT ALL, even
         -- if its status was never flipped terminal — pool-exclude it too.
         AND ${alreadyTerminallyCompletedExclusionSql(sql)}`;
    pendingUnclaimed += issuePoolRows[0]?.n ?? 0;

    // READY issue count — mirrors claimNextIssueWorkItem's WHERE exactly: the pool floors
    // above PLUS swarm affinity, the excludeRedundant floor, and the inline readiness
    // predicate (no PRESENT non-terminal blocker across BOTH families). One readiness source
    // of truth with the issue-claim path, so this never drifts from what claim_next serves.
    const issueReadyRows = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n
        FROM harness_shared.work_items wi
       WHERE wi.item_kind IN ('bug', 'change', 'task')
         AND wi.workspace_id = ${issueWs}
         AND (wi.harness_slug = ${filter.harness} OR wi.harness_slug = ${operatorScopeSlug})
         AND (wi.taken_by IS NULL OR btrim(wi.taken_by) = '' OR lower(btrim(wi.taken_by)) = 'unassigned')
         AND wi.status = ANY(${issueStates}::text[])
         -- work-item-status-full-unify: mirror claimNextIssueWorkItem's origin floor (own-node aware)
         -- so READY counts what the claim actually serves. Previously this query had NO origin floor
         -- at all → it over-counted true-remote issues as ready while the claim (origin='local')
         -- refused them (a "ready>0 but claim keeps missing" hot-retry mismatch). Now both admit
         -- exactly (origin local/null OR our own-node author key).
         AND ${isIssueLocallyClaimableWhereSql(sql, issueWs)}
         AND ${admittedWhereSqlWi(sql)}
         -- EI-22685972259555805: live gate-control condition singletons belong to the
         -- one registered LIVE_GATE_OPS fixer, never the opportunistic issue pool.
         -- Keep them in POOL (real work exists) but out of READY; an explicit by-id
         -- claim remains the ownership-aware escape.
         AND ${liveGateOpsSelfSelectExclusionSql(sql)}
         AND ${filter.swarmId ? sql`(wi.swarm_affinity IS NULL OR wi.swarm_affinity = ${filter.swarmId})` : sql`TRUE`}
         AND ${filter.excludeRedundant ? sql`(wi.redundancy IS NULL OR wi.redundancy <= 1)` : sql`TRUE`}
         -- The blocking floor, from the ONE shared definition (D-007). This is the READY
         -- diagnosis, so it must apply exactly what claimNextIssueWorkItem enforces — the
         -- same reason the reserved-plan-lane comment below gives: "the miss diagnosis never
         -- disagrees with what claim_next actually serves". Sharing the fragment is what
         -- makes that promise structural rather than a convention two copies have to keep.
         AND ${depsBlockedExclusionSql(sql)}
         -- WI-2118 (P-009 leak): a reserved-plan-lane item is NOT ready to self-select — count it
         -- as pending-but-gated (present in the POOL above, excluded here), the SAME floor the claim
         -- applies, so the miss diagnosis never disagrees with what claim_next actually serves.
         AND ${reservedPlanLaneExclusionSql(sql, filter.assignee, 'wi.payload', {
           claimantFleetSlug: filter.claimantFleetSlug,
           claimSpecReferencesFleet: filter.claimSpecReferencesFleet,
           claimSpecReferencesGoal: filter.claimSpecReferencesGoal,
         })}
         -- WI-2796: a cross-machine-rig-gated item is likewise pending-but-gated for a
         -- single-box caller — same floor the claim applies.
         AND ${crossMachineRigExclusionSql(sql, filter.rigAvailable)}
         -- WI-2797: a claim-held item is likewise pending-but-gated — same floor the claim applies.
         AND ${claimHoldExclusionSql(sql)}
         -- D-005: an observation-lane row is not work-queue material — same floor the claim applies.
         AND ${observationLaneExclusionSql(sql)}
         AND ${needsOwnerActionExclusionSql(sql)}
         AND ${agentReviewNormalExclusionSql(sql)}
         AND NOT ${verificationTaskConflictSql(sql, filter.assignee, 'wi.payload')}
         AND ${externalBlockersExclusionSql(sql)}
         -- WI-2633: a replication-liveness detector EI is gated to the p2p fleet — same floor the
         -- claim applies (below), so the miss diagnosis never disagrees with what it serves.
         AND ${federationDetectorExclusionSql(sql)}
         -- EI-8802: a stray AUTO-loop-iteration bookkeeping marker is not work-queue material
         -- either — same floor the claim applies (below), so the miss diagnosis never disagrees.
         AND ${loopIterationNoiseExclusionSql(sql)}
         -- EI-8972: an already-genuinely-terminally-completed row is not work-queue material
         -- either — same floor the claim applies (below), so the miss diagnosis never disagrees.
         AND ${alreadyTerminallyCompletedExclusionSql(sql)}
         -- EI-20106946822538304: while an eligible watchdog signal is inside its recovery
         -- evidence window, the auto-close sweep still owns the decision. Keep it in POOL so
         -- the diagnosis says work exists, but out of READY so claim_next cannot burn a wake
         -- proving a phantom needs no action. The shared fragment fails OPEN on incomplete
         -- history and is deliberately issue-family-only.
         AND ${watchdogRecoveryWindowExclusionSql(sql)}
         -- Mig 499 + WI-5939: a row cooling down FOR THIS CALLER — either this caller released it
         -- recently, or someone else filed it within the filing-grace window — is likewise
         -- pending-but-gated here; same one fragment claimNextIssueWorkItem applies.
         AND ${issueCooldownExclusionSql(sql, filter.assignee, issueCooldown)}`;
    readyUnclaimed += issueReadyRows[0]?.n ?? 0;
  }

  return { drained: pendingUnclaimed === 0, pendingUnclaimed, readyUnclaimed, flagReadError };
}

/** Why ONE named id is not claim-path admissible (WI-4413). `null` reason ⇒ it IS admissible. */
export interface ClaimFloorAttribution {
  id: string;
  admissible: boolean;
  /** The FIRST floor that refuses it, in the order the claim path applies them. */
  refusedBy: string | null;
  /** Operator-facing explanation of that floor. */
  detail: string | null;
  /**
   * P-027 / D-055 A2 — the owner id currently holding the row, present ONLY when
   * `refusedBy === 'already-taken'`.
   *
   * The `already-taken` floor is the one refusal in this list that is caused by
   * ANOTHER AGENT rather than by the row's own properties, so it is the only one
   * where "who, and are they actually working on it?" is an actionable question.
   * `scheduler:get_next` resolves this into the holder's goal; every other floor
   * leaves it absent because there is no holder to name.
   *
   * ⚠ OPTIONAL ON PURPOSE. This is a shared interface with fixtures constructed
   * across the tree (set_claim_spec builds `unknownRows` by hand), and a REQUIRED
   * field here would go stale in files this change never touches — the exact trap
   * the repo conventions call out for shared-interface widening.
   */
  heldBy?: string | null;
  /**
   * EI-21973318733042066 — present ONLY on a floor that clears with NOBODY ACTING, carrying the
   * bound it clears within.
   *
   * The floor names in this list mix two populations that read identically to a caller:
   * TEMPORAL ones (admission-pending) and PERMANENT properties of the row (observation-lane,
   * federation-detector, already-completed, origin). A refusal that cannot say WHICH is
   * indistinguishable from a permanent one, so the caller either abandons work that was minutes
   * from claimable or blocks forever on work that never will be — the measured cost of exactly
   * that: a launched reviewer's review item stayed unclaimable for 22.5 minutes, outliving the
   * entire 9-minute life of the agent it was created for.
   *
   * ⚠ ABSENT means "this floor advertises no bound", NEVER "this floor is permanent". Only
   * floors whose bound the code actually KNOWS populate it; inferring permanence from absence
   * would re-create the ambiguity this field exists to remove.
   *
   * ⚠ OPTIONAL ON PURPOSE, for the same reason `heldBy` above is: `ClaimFloorAttribution` is a
   * shared interface with fixtures constructed across the tree (set_claim_spec builds
   * `unknownRows` by hand), and a REQUIRED field here would strand files this change never
   * touches.
   */
  retry?: {
    readonly clearsOnItsOwn: true;
    /** Seconds until the mechanism that normally clears it next runs. */
    readonly expectedWithinSec: number;
    /** Seconds until the independent backstop clears it even if that mechanism is dead. */
    readonly guaranteedWithinSec: number;
    /** What produces those two numbers, so a caller can check the claim rather than trust it. */
    readonly basis: string;
  };
  /**
   * EI-21973318733042066 — what the caller (or whoever created the item) can DO about this
   * floor, when a documented way to avoid it already exists. Optional for the same shared-
   * interface reason as `retry`, and absent wherever there is no remedy to name.
   */
  remedy?: string;
}

/** The floors, in claim-path order, as (name, predicate-is-SATISFIED) pairs + why a miss means. */
/**
 * Every floor label `explainIssueClaimFloors` can report, mapped to what it means.
 *
 * EXPORTED (WI-2141964) so the structural/transient classification in
 * `claim-floor-classification.ts` can be PINNED against this vocabulary rather than
 * restating it: its guard test asserts every key here is classified, so a floor added to
 * the claim path cannot silently reach consumers unclassified. Keep it the complete set —
 * a floor with no entry here also reports `detail: null` to every caller.
 */
export const ISSUE_FLOOR_EXPLANATIONS: Record<string, string> = {
  'not-found': 'no such work-item in this harness/workspace',
  'not-claimable-status': 'status is terminal or otherwise not in the claimable set',
  'already-taken': 'already claimed by another agent',
  // EI-21973318733042066: DERIVED from the promoter cadence, never restated here. The old text
  // was 'wait for admitted/unreviewed' — an unbounded instruction to wait, which is what left a
  // refused caller unable to tell "not yet" from "never".
  'admission-pending': admissionPendingExplanation(),
  'observation-lane': 'payload.lane = "observation" — a captured NOTE, never work-queue material (D-005)',
  'needs-owner-action':
    'payload.needsOwnerAction = true — a typed credential, physical-device, or external-service-action capability requires the owner',
  'agent-review':
    'payload.agentReview is pending/revision-requested, or payload.implementationReadiness is enrolled without a ready verdict — reserved to review/validation until approved',
  'external-blocker': 'payload.externalBlockers contains an active typed capability dependency',
  'claim-hold':
    'payload._claimHold = true — deliberately held (WI-2797). TWO provenance conventions, both must be checked before ' +
    'assuming a row is unattributed: `held_open_by`/`held_open_reason` (a liveness-bound LEASE, work_items:hold_open) or ' +
    "`claim_hold_by`/`claim_hold_reason` (a durable PARK that outlives its parker's session, release{claimHold:true}) — " +
    'see readWorkItemClaimHoldProvenance / EI-18672701535825889.',
  'plan-lane-reserved': 'payload.plan_item — reserved to its own plan lane while that plan is active (WI-2118/WI-3667)',
  'federation-detector': 'an auto-filed replication-liveness detector, gated to the p2p fleet (WI-2633)',
  'loop-noise': 'an AUTO-loop-iteration bookkeeping marker, not work (EI-8802)',
  'already-completed': 'already carries a terminal completion record (EI-8972)',
  'watchdog-recovery-window':
    'eligible watchdog signal is still inside the auto-close recovery evidence window; wait for six complete ran ticks',
  'cross-machine-rig': 'needs a ≥2-machine rig this caller does not have (WI-2796)',
  'blocked-dep': 'has a PRESENT, non-terminal blocker (work_item_deps)',
  origin:
    "a true-peer federated row (origin not local/null, and not one of this workspace's own " +
    'substrate-log author keys) — not self-selectable from this node (isIssueLocallyClaimableWhereSql)',
  cooldown:
    'cooling down FOR THIS CALLER — either released by THIS caller within the release-cooldown window ' +
    '(mig 499 / EI-6956), or FILED BY SOMEONE ELSE within the filing-grace window (WI-5939: the filer ' +
    'gets a head start to claim their own file-then-fix). Both clear on their own; the filer can claim ' +
    'its own row immediately, and PAPERCUSP_FILING_GRACE_SEC=0 disables the grace leg.',
  'live-gate-ops': liveGateOpsSelfSelectExplanation(),
  // EI-22172757071586188: the 4th floor (after WI-37356's ok_no_blocker/ok_cooldown/ok_origin)
  // found missing from this oracle. Generic on purpose — unlike stopTheLineExplanation(harness),
  // this static map has no harness in scope; a caller wanting the harness-named verdict text
  // calls that function directly with refusedBy === 'stop-line'.
  'stop-line':
    `P-013/D-012 stop-the-line: this harness's release gate has been red for over ${STOP_THE_LINE_RED_HOURS}h ` +
    '(an open gate-red-streak condition item older than the threshold), so non-repair issue-family work is ' +
    'not served for self-select. Bugs and alarm-condition items stay exempt, and a leader/owner can still ' +
    'dispatch this row by id. Clears on its own once the gate greens.',
};

/**
 * The `ok_*` floor-boolean SELECT list shared by every candidate row {@link explainIssueClaimFloors}
 * explains — factored out of that function so a test can read its LIVE result-column metadata
 * (never a source-text scan — same reasoning as `get-next-exclusion-breakdown.integration.test.ts`'s
 * identical technique for {@link issueClaimCandidateSubquery} in scheduler/get-next.ts) and assert
 * it against {@link ALL_ISSUE_CLAIM_FLOORS_PASS} imported from there. `explainIssueClaimFloors` is
 * the only other caller, so these booleans are computed in exactly one place.
 *
 * Deliberately EXCLUDES `ok_status`: that floor exists only in the oracle (a named id may be in
 * any status, so "not-claimable-status" must be an explicit floor there), never in the claim
 * path's own candidate population (which filters status via its base `WHERE` instead) — so it is
 * correctly absent from {@link ALL_ISSUE_CLAIM_FLOORS_PASS} too, and the parity test asserts a
 * SUPERSET relation (oracle ⊇ bar), not exact equality.
 *
 * EI-22172757071586188: `ok_stop_line` was the 4th floor found missing from this oracle (after
 * WI-37356 fixed three siblings: `ok_no_blocker`, `ok_cooldown`, `ok_origin`) — the SET here had
 * been hand-maintained separately from {@link ALL_ISSUE_CLAIM_FLOORS_PASS} with no guard, so a
 * floor added to the real claim path silently never reached this oracle. This factoring plus its
 * paired test is the recurrence guard that would have caught all four instances.
 */
export function issueClaimBarFloorColumnsSql(
  sql: OrgSql,
  opts: {
    issueWs: string;
    assignee: string;
    cooldown: number;
    rigAvailable?: boolean;
    claimantFleetSlug?: string;
    claimSpecReferencesFleet?: boolean;
    claimSpecReferencesGoal?: boolean;
  },
) {
  const {
    issueWs,
    assignee,
    cooldown,
    rigAvailable,
    claimantFleetSlug,
    claimSpecReferencesFleet,
    claimSpecReferencesGoal,
  } = opts;
  return sql`
    (wi.taken_by IS NULL OR wi.taken_by = '')                              AS ok_untaken,
    (${isIssueLocallyClaimableWhereSql(sql, issueWs)})                     AS ok_origin,
    (${admittedWhereSqlWi(sql)})                                           AS ok_admission,
    (${liveGateOpsSelfSelectExclusionSql(sql)})                            AS ok_live_gate_ops,
    (${observationLaneExclusionSql(sql)})                                  AS ok_observation,
    (${needsOwnerActionExclusionSql(sql)})                                 AS ok_needs_owner_action,
    (${agentReviewNormalExclusionSql(sql)})                                AS ok_agent_review,
    (${externalBlockersExclusionSql(sql)})                                 AS ok_external_blocker,
    (${claimHoldExclusionSql(sql)})                                        AS ok_claim_hold,
    (${reservedPlanLaneExclusionSql(sql, assignee, 'wi.payload', {
      claimantFleetSlug,
      claimSpecReferencesFleet,
      claimSpecReferencesGoal,
    })})                                                                  AS ok_plan_lane,
    (${federationDetectorExclusionSql(sql)})                               AS ok_federation,
    (${loopIterationNoiseExclusionSql(sql)})                               AS ok_loop_noise,
    (${alreadyTerminallyCompletedExclusionSql(sql)})                       AS ok_completed,
    (${watchdogRecoveryWindowExclusionSql(sql)})                           AS ok_watchdog_recovery,
    (${crossMachineRigExclusionSql(sql, rigAvailable)})                    AS ok_rig,
    (${depsBlockedExclusionSql(sql)})                                      AS ok_no_blocker,
    (${issueCooldownExclusionSql(sql, assignee, cooldown)})                AS ok_cooldown,
    (${stopTheLineExclusionSql(sql, 'issue-wi')})                          AS ok_stop_line
  `;
}

/**
 * WI-4413: explain, PER NAMED ID, which claim floor refuses it — the missing half of
 * `diagnoseClaimNextMiss` (which returns only aggregate POOL/READY counts).
 *
 * A fleet leader authors a claim spec that NAMES ids (the tranche shape). When `get_next`
 * misses, "no claimable work-item matched your spec within the floors" tells the leader
 * nothing: not which id, not which floor. Live cost (bug-drain-nonp2p 2026-07-12): THREE
 * consecutive tranches were 100% floored — by three DIFFERENT floors (observation-lane,
 * plan-lane reservation, _claimHold/owner-action) — and each took a manual payload
 * archaeology dig to find, while members sat idle. This makes the claim path self-explaining.
 *
 * DRIFT-PROOF BY CONSTRUCTION: every floor below is the SAME exported `sql` fragment the
 * claim itself ANDs in — evaluated as a boolean column instead of a WHERE clause. A new floor
 * added to the claim path and not to this list shows up as `admissible: true` on an id that
 * still will not claim, which is a loud, testable disagreement rather than a silent one.
 * (The floor-parity pin test asserts exactly that.)
 */
export async function explainIssueClaimFloors(
  harness: string,
  ids: readonly string[],
  opts: {
    assignee?: string;
    rigAvailable?: boolean;
    states?: readonly string[];
    claimantFleetSlug?: string;
    claimSpecReferencesFleet?: boolean;
    claimSpecReferencesGoal?: boolean;
    /**
     * Scope-authoring preview ONLY: evaluate the remaining shared floors for rows
     * already held by these verified target-fleet members. Never used by a claim
     * acquisition door; omitting it preserves the ordinary already-taken floor.
     */
    scopeHeldBy?: readonly string[];
  } = {},
): Promise<ClaimFloorAttribution[]> {
  if (ids.length === 0) return [];
  const { sql } = getOrgPg();
  const issueWs = issuesScopeWorkspace();
  const operatorScopeSlug = `operator:${issueWs}`;
  const assignee = opts.assignee ?? '';
  const states = opts.states ?? ISSUE_FAMILY_CLAIMABLE_STATES;

  const cooldown = releaseCooldownSec();
  const rows = await sql<
    {
      id: string;
      taken_by: string | null;
      ok_status: boolean;
      ok_untaken: boolean;
      ok_origin: boolean;
      ok_admission: boolean;
      ok_live_gate_ops: boolean;
      ok_observation: boolean;
      ok_needs_owner_action: boolean;
      ok_agent_review: boolean;
      ok_external_blocker: boolean;
      ok_claim_hold: boolean;
      ok_plan_lane: boolean;
      ok_federation: boolean;
      ok_loop_noise: boolean;
      ok_completed: boolean;
      ok_watchdog_recovery: boolean;
      ok_rig: boolean;
      ok_no_blocker: boolean;
      ok_cooldown: boolean;
      ok_stop_line: boolean;
    }[]
  >`
    SELECT wi.feature_id AS id,
           wi.taken_by                                                            AS taken_by,
           (wi.status = ANY(${[...states]}::text[]))                              AS ok_status,
           ${issueClaimBarFloorColumnsSql(sql, {
             issueWs,
             assignee,
             cooldown,
             rigAvailable: opts.rigAvailable,
             claimantFleetSlug: opts.claimantFleetSlug,
             claimSpecReferencesFleet: opts.claimSpecReferencesFleet,
             claimSpecReferencesGoal: opts.claimSpecReferencesGoal,
           })}
      FROM harness_shared.work_items wi
     WHERE wi.workspace_id = ${issueWs}
       AND (wi.harness_slug = ${harness} OR wi.harness_slug = ${operatorScopeSlug})
       AND wi.item_kind IN ('bug', 'change', 'task')
       AND wi.feature_id = ANY(${[...ids]}::text[])`;

  const byId = new Map(rows.map((r) => [r.id, r]));
  // EI-22166155287498355: only pay for the promoter-health lookup when at least one
  // named id is actually floored on admission-pending — the common case (a fleet
  // leader diagnosing a mix of floors) never touches it.
  const anyAdmissionPending = rows.some((r) => !r.ok_admission);
  const promoterStall = anyAdmissionPending
    ? await admissionPromoterStall(issueWs)
    : ({ stalled: false } as const);
  return ids.map((id) => {
    const r = byId.get(id);
    const refusedBy = !r
      ? 'not-found'
      : // Order MATTERS: report the floor a human would act on first.
        !r.ok_status
        ? 'not-claimable-status'
        : !r.ok_untaken && !(r.taken_by && opts.scopeHeldBy?.includes(r.taken_by))
          ? 'already-taken'
          : !r.ok_origin
            ? 'origin'
            : !r.ok_admission
              ? 'admission-pending'
              : !r.ok_live_gate_ops
                ? 'live-gate-ops'
                : !r.ok_observation
                  ? 'observation-lane'
                  : !r.ok_needs_owner_action
                    ? 'needs-owner-action'
                    : !r.ok_agent_review
                      ? 'agent-review'
                      : !r.ok_external_blocker
                        ? 'external-blocker'
                        : !r.ok_claim_hold
                          ? 'claim-hold'
                          : !r.ok_plan_lane
                            ? 'plan-lane-reserved'
                            : !r.ok_federation
                              ? 'federation-detector'
                              : !r.ok_loop_noise
                                ? 'loop-noise'
                                : !r.ok_completed
                                  ? 'already-completed'
                                  : !r.ok_watchdog_recovery
                                    ? 'watchdog-recovery-window'
                                    : !r.ok_rig
                                      ? 'cross-machine-rig'
                                      : !r.ok_no_blocker
                                        ? 'blocked-dep'
                                        : !r.ok_cooldown
                                          ? 'cooldown'
                                          : !r.ok_stop_line
                                            ? 'stop-line'
                                            : null;
    return {
      id,
      admissible: refusedBy === null,
      refusedBy,
      detail: refusedBy ? (ISSUE_FLOOR_EXPLANATIONS[refusedBy] ?? null) : null,
      // Only the already-taken floor has a holder to name (P-027). Every other
      // refusal is a property of the ROW, so `heldBy` stays absent rather than
      // carrying a stale `taken_by` that had nothing to do with the refusal.
      ...(refusedBy === 'already-taken' && r?.taken_by ? { heldBy: r.taken_by } : {}),
      // EI-21973318733042066: admission-pending is the one floor here whose clearing is on a
      // SCHEDULE the code owns, so it is the one that can honestly publish a bound. Both numbers
      // and the remedy are derived (from the promoter cadence and from ADMISSION_CREATE_BYPASSES
      // respectively) — a hand-written "30 minutes" or a second copy of the bypass list would be
      // the drift this whole attribution exists to prevent.
      ...(refusedBy === 'admission-pending'
        ? {
            // EI-22166155287498355: a promoter whose last fire ERRORED (LLM account
            // exhaustion, most commonly) is `active:true` with a fresh `lastFiredAt`
            // on every liveness surface, so the ONLY honest thing this floor can do
            // is stop quoting its healthy-cadence figure once that failure is
            // visible — otherwise the refusal text and reality silently diverge for
            // as long as the promoter keeps erroring.
            //
            // EI-23383710942512978: WHY the promoter is stalled is classified rather
            // than collapsed to "errored". All stalled causes share this fail-open
            // bound — the bound was never the problem — but naming a deliberate
            // owner pause as a fault invites the reader to re-arm an LLM-spending
            // loop the owner deliberately stopped. The attribution is the fix.
            retry: promoterStall.stalled
              ? {
                  clearsOnItsOwn: true as const,
                  expectedWithinSec: admissionFailOpenSec(),
                  guaranteedWithinSec: admissionFailOpenGuaranteedSec(),
                  basis: admissionStallBasis(promoterStall),
                }
              : {
                  clearsOnItsOwn: true as const,
                  expectedWithinSec: admissionPromoterTickSec(),
                  guaranteedWithinSec: admissionFailOpenGuaranteedSec(),
                  basis: admissionStallBasis(promoterStall),
                },
            remedy: admissionPendingCreateRemedy(),
          }
        : {}),
    };
  });
}

/**
 * The ISSUE-family half of self-selection (SCHEDULER_ISSUES_CLAIMABLE, P-007) — atomically
 * claim the oldest UNBLOCKED, unclaimed `open` bug/change/task, mirroring the feature claim's
 * `UPDATE … WHERE pk = (SELECT … FOR UPDATE SKIP LOCKED)` shape but over the `work_items`
 * BASE for issue-family kinds (the engineer_issues VIEW doesn't expose feature_order, and the
 * feature view excludes these rows). KEPT SEPARATE from the feature claim so that path is never
 * rewritten — this runs ONLY when the flag is on AND no feature was claimable (callers guard).
 * EXPORTED (fleet-backlog-lessons-2026-07-01 P-005) so the spec-driven `scheduler/get-next.ts`
 * resolver can reuse it as ITS ladder's tier 3 too — one issue-claim implementation, never two.
 *
 * Readiness uses the SAME work_item_deps predicate as the feature floor, with the issue's
 * blocked_ref being its BARE id (issues:link), and a blocker SATISFIED iff TERMINAL/ABSENT
 * (feature terminal = passed|deprecated; issue terminal = resolved|closed). Priority honors
 * feature_order (the Queen can now steer issues too, P-007), then oldest-first.
 *
 * `opts.ids` (WI-4309): when the caller extracted a closed-world `id in [...]` set from the
 * spec, narrows the claim to exactly those ids — see the inline comment at its use site.
 */
export async function claimNextIssueWorkItem(
  filter: ClaimNextFilter,
  explicitActiveWorkspaceId: string,
  opts: {
    /** Optional caller-owned client; scheduler:get_next uses its isolated claim pool. */
    client?: OrgSql;
    /** Reuse the scheduler's bounded authority read across candidate families. */
    operationClaimRead?: ActiveOperationWorkerClaimRead;
    issueKinds?: readonly IssueStoreKind[];
    ids?: readonly string[];
    /** WI-5258: ids the caller's spec NEGATIVELY excludes (e.g. `not:{id in [...]}` —
     *  "already handled, skip these") — extracted by get-next.ts's tier 3 caller.
     *  Without this, a fleet leader's exclusion clause silently vanished the moment
     *  tier 1/2 missed and tier 3 took over: claimNextIssueWorkItem previously had no
     *  way to see it, so the very ids a spec meant to skip came right back through the
     *  fallback. Undefined/empty ⇒ no exclusion, unchanged behavior. */
    excludeIds?: readonly string[];
    /** The caller's FULL claim-spec filter, already compiled to a SQL fragment by
     *  get-next.ts's `compileFilter` (passed DOWN rather than imported, so this module
     *  keeps its existing get-next → work-items import direction and no cycle forms).
     *
     *  Why this exists: `issueKinds`/`ids`/`excludeIds` above can only express the kind
     *  and id legs of a spec. Every OTHER leg — `paths` globs, `plan`, `title`, `tags`,
     *  and any `any`/`not` combination of them — used to be invisible to this claim
     *  query, so tier 3 would atomically claim a row the spec never admitted and rely on
     *  claim-spec-store.ts's post-claim `matchesWorkItemClaimSpec` re-check to release it
     *  and retry. That retry shares MAX_PLAN_LANE_ATTEMPTS (5), a budget whose own comment
     *  sizes it for a DIFFERENT failure mode (consecutive plan-lane-BLOCKED candidates).
     *  For a narrow fleet lane that budget is nowhere near enough: measured on
     *  p2p-release-lane@9, 26 of 1073 lane-wide claimable rows matched the spec (2.4%), so
     *  P(>=1 match in 5 draws) ~ 11.6% — i.e. ~88% of scheduler:get_next pulls returned a
     *  FALSE "no claimable work", indistinguishable from a genuinely drained lane. Three
     *  separate fleet members independently misreported that as "floor-gated" while
     *  work_items:claimable (which DOES compile the full filter, via
     *  issueClaimCandidateSubquery) correctly reported 26 claimable.
     *
     *  Threading the compiled filter here makes the claim path select a SPEC-MATCHING row
     *  atomically on the first attempt, which re-unifies claim with read and removes the
     *  quarantine claim-then-release round-trip for ALL spec shapes (that dance also caused
     *  the EI-15019 / EI-14837 spurious-wake incidents). The post-claim re-check stays as
     *  defense-in-depth. Undefined ⇒ unrestricted, exactly the previous behavior. */
    specFilterSql?: unknown;
    /** The caller's compiled `spec.rank` ORDER BY, passed DOWN pre-compiled for the SAME
     *  cycle-avoidance reason as `specFilterSql` above (get-next → work-items is the one
     *  permitted direction; see claim-spec.ts:4649).
     *
     *  Why this exists (EI-19497592871345016 / EI-19485419686452678): this query's ORDER BY
     *  was HARDCODED, so the issue family — every bug/change/task, i.e. the entire claimable
     *  pool — silently ignored `spec.rank` while still HONORING `spec.view.filter`. A spec
     *  could therefore NARROW but never REORDER, contradicting scheduler:get_next's own
     *  contract ("ordered by spec.rank") and the provenance it stamps on every claim.
     *
     *  The visible cost: `feature_order` is NULL across the issue pool, so the hardcoded
     *  `feature_order ASC NULLS LAST, created_ts ASC` collapsed to plain OLDEST-FIRST.
     *  Measured 2026-08-04: scheduler:get_next served EI-8600 (minor, created 2026-07-07)
     *  while work_items:claimable — the same floor oracle — reported 1,675 claimable with
     *  SEVEN criticals at the head, none claim-held. It also made the `severity_rank` term
     *  added to DEFAULT_CLAIM_SPEC by EI-19286355119013384 INERT for the very family its own
     *  comment says it was added to fix ("Net effect is scoped to issue-family rows").
     *
     *  Undefined ⇒ the previous hardcoded ordering, byte-identical — so the legacy
     *  `claimNextWorkItem` tier-3 caller (which has no spec) is unchanged. Note that when a
     *  spec IS supplied its rank is AUTHORITATIVE: it replaces the feature_order/created_ts
     *  legs rather than composing with them. DEFAULT_CLAIM_SPEC reproduces both exactly
     *  (`priority desc` compiles to `feature_order ASC NULLS LAST` via FIELD_MAP's inversion,
     *  `age asc` to `created_ts ASC`), so the default path gains ONLY the severity leg. A
     *  hand-authored spec that omits `priority` does forgo EI-7407's Mug `set_priority`
     *  steering for that lane — that is the spec author's explicit choice, which is what
     *  authoring a rank means. */
    specOrderSql?: unknown;
    /**
     * EI-21288979130080074: an atomic cross-family priority boundary. When set,
     * an issue with an explicit feature_order may preempt the feature-family
     * ladder only when its priority is strictly better than every eligible
     * feature candidate.
     */
    priorityBeforeFeature?: {
      /** The caller's compiled filter over the feature-family relation. */
      featureFilterSql?: unknown;
      /** The feature-family readiness implementation selected by the caller. */
      useMaintainedReady?: boolean;
    };
    /** Abort the active claim transaction when the scheduler caller's deadline fires. */
    signal?: AbortSignal;
  } = {},
): Promise<WorkItem | null> {
  const sql = opts.client ?? getOrgPg().sql;
  // Scope the issue-claim to the canonical ISSUE workspace (resolveIssuesScopeWorkspace —
  // honors the ISSUES_PER_WORKSPACE flag), NOT the feature activeWorkspaceId(), so the
  // UPDATE and the getIssue() re-read below agree on the same partition (they'd diverge
  // when ISSUES_PER_WORKSPACE is OFF: issues live in 'default' while the feature scope is
  // the active workspace).
  //
  // WI-5261: the 2nd positional param (`explicitActiveWorkspaceId`, née the dead `_ws`)
  // is now ACTUALLY USED — as the "active workspace" leg's override, not a blind swap for
  // issueWs itself (the ISSUES_PER_WORKSPACE gate must still apply). The caller
  // (get-next.ts's getNextWorkItem) already resolved its own workspace via
  // opts.workspaceId when the fleet-scoped caller passed one; threading it here avoids
  // re-deriving via activeWorkspaceId(), which silently falls to 'default' if the
  // AsyncLocalStorage request-scope was lost anywhere in the awaits between the tool
  // handler and this call — a hard, deterministic, restart-immune false miss (confirmed
  // live 2026-07-17, WI-5261).
  const issueWs = resolveIssuesScopeWorkspace(explicitActiveWorkspaceId || undefined);
  const operationClaims = await import('./blueprint/operation-worker-binding');
  const operationClaimRead = opts.operationClaimRead ?? await operationClaims.readActiveOperationWorkerClaimBinding(
    explicitActiveWorkspaceId, filter.assignee,
  );
  if (operationClaimRead.status === 'unavailable') {
    throw new Error(`operation claim authority unavailable: ${operationClaimRead.reason}`);
  }
  // Issue-family rows carry harness_slug = 'harness:<slug>' → <slug> (harness-scoped) or
  // 'operator:<workspace_id>' (operator scope, migration 382 — the harness_slug='' sentinel
  // it replaced is gone in current data). EI-5919 / WI-1406: this query used to match ONLY
  // `wi.harness_slug = filter.harness`, so it could see harness-scoped issues but NOT
  // operator-scope ones — which is ~90% of the open bug/change/task backlog (2326/2596 rows
  // for papercusp-workspace, verified 2026-07-01). Every harness-scoped claim_next call was
  // structurally blind to that backlog: "40+ ready unclaimed todos exist" yet claim_next
  // reported no claimable work-item. Also accept the operator-scope encoding for the SAME
  // resolved issue workspace, so operator-wide issues become self-pickable by any harness.
  const operatorScopeSlug = `operator:${issueWs}`;
  // Claimable issue status = 'open' by default; terminal (resolved|closed) excluded by
  // status, blocked ones by readiness (below).
  //
  // WI-6453 follow-up (2026-08-02): this UNCONDITIONALLY ignored `filter.states` (the
  // caller/spec's own states override, e.g. `states:['open','failing']` from
  // scheduler:set_claim_spec — CLAIM_STATES_ALLOWLIST explicitly allows 'failing') and
  // always claimed status='open' only — the ONE place in this whole subsystem that did.
  // Every sibling read/diagnose path honors it: aggregateIssueClaimExclusions and 4 other
  // helpers in scheduler/get-next.ts all compute `opts.states ?? ISSUE_FAMILY_CLAIMABLE_STATES`,
  // and explainIssueClaimFloors is unit-tested to honor a states:['failing'] override
  // (get-next-miss-diagnosis.integration.test.ts). So a fleet leader who set
  // `states:['open','failing']` on a claim spec (to also self-select re-triable failing
  // issue-family work) got a READ oracle (work_items:claimable / the miss-diagnosis
  // breakdown) that correctly counted 'failing' rows as claimable, while THIS — the real
  // scheduler:get_next self-select path — could never actually claim one: a textbook
  // claim-path/read-path divergence in the same class as EI-10062/WI-4309/WI-5275/WI-5822,
  // just triggered by a states override instead of a filter shape. Found while investigating
  // WI-6453 (no live repro for that report's original AND-shaped-exclusion spec after two
  // prior deep investigations); this is a distinct, independently-confirmed bug in the same
  // subsystem. See claim-next-issue-honors-states.integration.test.ts.
  const states = filter.states?.length ? filter.states : ISSUE_FAMILY_CLAIMABLE_STATES;
  const issueKinds = opts.issueKinds?.length ? [...opts.issueKinds] : [...ISSUE_FAMILY_KINDS];
  // WI-4309: when the caller (get-next.ts tier 3) extracted a closed-world `id in [...]`
  // set from the spec, narrow the claim to EXACTLY those ids instead of either ignoring
  // the constraint (the original EI-10062 leak — served ANY open issue once the named ids
  // were exhausted) or refusing to run at all (an earlier fix that made tier 3 skip
  // entirely whenever an id constraint was present — which meant an issue-only id-allowlist
  // spec, e.g. a leader's hand-curated bug-drain wave of EI-/WI- ids, could NEVER be served
  // by get_next even while its named items sat open+unclaimed, since tier 1 only queries the
  // feature-family table and can't match an issue-family id). Undefined ⇒ no id constraint
  // (or one the caller couldn't safely extract) ⇒ unrestricted, as before.
  const idFilter = opts.ids?.length ? [...opts.ids] : undefined;
  // WI-5258: the negative counterpart of idFilter — ids the spec explicitly excludes.
  const excludeIdFilter = opts.excludeIds?.length ? [...opts.excludeIds] : undefined;
  // The caller's full compiled claim-spec filter (see `specFilterSql` on opts for the
  // measured rationale). `compileFilter` emits UNQUALIFIED column references (feature_id,
  // source_plan_slug, payload->'paths', …) which resolve against `wi` — the only table in
  // the inner SELECT's scope — so the fragment drops in as one more AND leg alongside the
  // id/kind narrowings. Undefined ⇒ TRUE ⇒ unrestricted, the pre-existing behavior.
  const specFilterSql = (opts.specFilterSql ?? undefined) as ReturnType<OrgSql> | undefined;
  // The caller's compiled spec.rank (see `specOrderSql` on opts). Like the filter above,
  // `compileRank` emits UNQUALIFIED column references (payload->'_ei'->>'severity',
  // feature_order, created_ts, …) which resolve against `wi` — the only table in the inner
  // SELECT's scope. Undefined ⇒ the pre-existing hardcoded ordering.
  const specOrderSql = (opts.specOrderSql ?? undefined) as ReturnType<OrgSql> | undefined;
  // EI-21288979130080074: this filter is compiled against the feature relation and is
  // intentionally separate from specFilterSql, whose feature-only kind leaves are stripped
  // for the issue-family relation.
  const priorityFeatureFilterSql = (opts.priorityBeforeFeature?.featureFilterSql ?? undefined) as
    | ReturnType<OrgSql>
    | undefined;
  // Mig 499: the SAME release-cooldown floor claimFloorsWhereSql applies for the
  // feature family (mig 485/EI-6956) — without it, an agent that releases an
  // issue-family item immediately re-claims that EXACT row on its very next
  // scheduler:get_next/claim_next call whenever it's still the oldest/highest-
  // ranked eligible row (the confirmed-live WI-652/WI-2381-class ping-pong).
  const cooldown = releaseCooldownSec();
  // EI-18806283145814329: run the claim UPDATE inside a bounded admin-pool txn (mirrors
  // get-next.ts tiers 1/2 — EI-18805386252364731) so a stall here surfaces as a typed
  // OrgTxnTimeoutError instead of hanging the caller indefinitely: getOrgPg()'s raw
  // `harness_admin` pool carries a role-default lock_timeout but DELIBERATELY NO
  // statement_timeout (migrations share the pool and must run unbounded on it), and
  // postgres-js cannot cancel an in-flight query from JS once it stalls. Every SQL
  // fragment below is compiled against the TRANSACTION client `tx` — not the outer
  // `sql` — so it belongs to the same connection that carries the SET LOCAL timeouts.
  const rows = await boundedOrgTxn(
    async (tx) => {
      // Cross-family priority comparison (EI-21288979130080074): an issue may jump ahead of
      // the feature-family ladder only when it has an explicit priority and no eligible
      // feature with an equal-or-better (lower) feature_order exists. Build the feature side
      // from the SAME claimFloorsWhereSql fragment used by the real feature claim path, and
      // evaluate it inside this UPDATE so the comparison and issue claim share one snapshot.
      const priorityBeforeFeature = opts.priorityBeforeFeature
        ? claimFloorsWhereSql(tx, {
            harness: filter.harness,
            workspaceId: explicitActiveWorkspaceId,
            states: filter.states,
            swarmId: filter.swarmId,
            excludeRedundant: filter.excludeRedundant,
            useMaintainedReady: opts.priorityBeforeFeature.useMaintainedReady,
            cooldownAssignee: filter.assignee,
            rigAvailable: filter.rigAvailable,
            claimantFleetSlug: filter.claimantFleetSlug,
            claimSpecReferencesFleet: filter.claimSpecReferencesFleet,
            claimSpecReferencesGoal: filter.claimSpecReferencesGoal,
          })
        : tx`TRUE`;
      const rows = await tx<FeatureRowDb[]>`
    UPDATE harness_shared.work_items AS target
       SET payload = jsonb_set(
             COALESCE(target.payload, '{}'::jsonb),
             '{claim_history_post_id}',
             to_jsonb(COALESCE((
               SELECT max(post.id)
                 FROM harness_shared.coord_thread_posts post
                WHERE post.workspace_id = ${issueWs}
             ), 0)),
             true
           ),
           taken_by = ${filter.assignee}, taken_at = now(), last_progress_at = NULL, updated_ts = ${Date.now()}
     WHERE (workspace_id, harness_slug, feature_id) = (
       SELECT workspace_id, harness_slug, feature_id
         FROM harness_shared.work_items wi
        WHERE wi.item_kind = ANY(${issueKinds}::text[])
          AND wi.workspace_id = ${issueWs}
          AND ${operationClaims.operationWorkerClaimWhereSql(tx, operationClaimRead, {
            payload: 'wi.payload', id: 'wi.feature_id', harness: 'wi.harness_slug',
          })}
          -- WI-4309: narrow to the spec's closed-world id set, when one was extracted.
          AND ${idFilter ? tx`wi.feature_id = ANY(${idFilter}::text[])` : tx`TRUE`}
          -- WI-5258: exclude ids the spec negatively excludes (a not-wrapped id leaf).
          AND ${excludeIdFilter ? tx`NOT (wi.feature_id = ANY(${excludeIdFilter}::text[]))` : tx`TRUE`}
          -- The FULL compiled claim-spec filter: the paths/plan/title/tag legs (and any
          -- any/not combination) that the kind/id narrowings above structurally cannot
          -- express. Without this the claim path served spec-violating rows and leaned on a
          -- 5-attempt post-claim release-and-retry, which false-reported a narrow lane as
          -- drained ~88% of the time. See opts.specFilterSql.
          AND ${specFilterSql ?? tx`TRUE`}
          -- EI-21288979130080074: only an explicitly prioritized issue can preempt the
          -- feature-family ladder, and only when no eligible feature has equal-or-better
          -- priority. The feature relation is intentionally unaliased because
          -- claimFloorsWhereSql is the shared unqualified fragment for that relation.
          AND ${
            opts.priorityBeforeFeature
              ? tx`wi.feature_order IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
              FROM harness_shared.harness_features_consolidated
             WHERE ${priorityBeforeFeature}
               AND ${priorityFeatureFilterSql ?? tx`TRUE`}
               AND feature_order <= wi.feature_order
          )`
              : tx`TRUE`
          }
          AND (wi.harness_slug = ${filter.harness} OR wi.harness_slug = ${operatorScopeSlug})
          AND (wi.taken_by IS NULL OR btrim(wi.taken_by) = '' OR lower(btrim(wi.taken_by)) = 'unassigned')
          AND wi.status = ANY(${[...states]}::text[])
          -- WI-3649 (EI-7841's issue-family half): this base-table UPDATE bypasses the
          -- engineer_issues VIEW/trigger entirely, so unlike the single-id work_items:claim
          -- path (gated by engineer_issues_view_dml's EI-7833 remote-skip) it had NO origin
          -- guard at all — a self-select could actually SUCCEED in locally mutating taken_by
          -- on a federated row, violating the "authoring peer owns it" LWW invariant.
          -- work-item-status-full-unify (owner 2026-07-20): own-node aware — a self-authored row
          -- that round-tripped federation (origin='remote' but OUR own substrate author key) IS
          -- self-selectable (the issue-family analog of the feature family's ownAuthorWhereSql leg;
          -- without it, node-identity drift permanently strands this box's own bugs). A true-peer
          -- remote row stays excluded. Shared with the READY diagnose so the two never diverge.
          AND ${isIssueLocallyClaimableWhereSql(tx, issueWs)}
          -- P-002 born-pending: the promoter owns this lifecycle transition.
          AND ${admittedWhereSqlWi(tx)}
          -- EI-22685972259555805: the gate-red-streak:/green-stall: singleton is
          -- exclusive LIVE_GATE_OPS control-plane work. Ordinary repair bugs still
          -- flow, while the registered fixer retains the explicit by-id claim path.
          AND ${liveGateOpsSelfSelectExclusionSql(tx)}
          -- P-013/D-012 stop-the-line: while this harness's gate-red-streak condition item
          -- has been open >24h, non-repair rows are not self-selectable (bugs and
          -- alarm-condition items exempt; a named by-id claim still bypasses, which is the
          -- owner-directed escape). SAME shared fragment as the claimability preview's
          -- ok_stop_line (issueClaimCandidateSubquery), so read and claim cannot diverge.
          AND ${stopTheLineExclusionSql(tx, 'issue-wi')}
          -- swarm affinity (P-002): under the per-Hive lease, honor the issue's affinity too.
          AND ${filter.swarmId ? tx`(wi.swarm_affinity IS NULL OR wi.swarm_affinity = ${filter.swarmId})` : tx`TRUE`}
          -- P-014: skip high-stakes (redundancy>1) items under the redundancy flag.
          AND ${filter.excludeRedundant ? tx`(wi.redundancy IS NULL OR wi.redundancy <= 1)` : tx`TRUE`}
          -- Readiness (P-005/P-007): never self-select a row with a PRESENT, NON-TERMINAL blocker.
          -- The issue's blocked_ref is its BARE feature_id (issues:link), and both blocker legs
          -- scope to the blocked item's OWN workspace (migration 719 / EI-19313459163394127 —
          -- before that the issue leg was pinned to 'default' and never matched, so this floor
          -- passed everything). Deliberately NOT the maintained work_item_blocked sidecar, which
          -- is FEATURE-FAMILY ONLY (the wir_* triggers don't track issues, so the sidecar would
          -- report a blocked issue as ready).
          --
          -- D-007: this predicate now lives in ONE place, depsBlockedExclusionSql, and the
          -- claimability PREVIEW (scheduler/get-next.ts) calls the same helper. It was previously
          -- inlined at both sites, and the copy in get-next.ts silently kept the pre-719 'default'
          -- hardcode — so the preview advertised as claimable 5 items this path refuses.
          AND ${depsBlockedExclusionSql(tx)}
          -- WI-2118 (P-009 leak): never self-select an item reserved by another active plan lane.
          AND ${reservedPlanLaneExclusionSql(tx, filter.assignee, 'wi.payload', {
            claimantFleetSlug: filter.claimantFleetSlug,
            claimSpecReferencesFleet: filter.claimSpecReferencesFleet,
            claimSpecReferencesGoal: filter.claimSpecReferencesGoal,
          })}
          -- WI-2796: never self-select a cross-machine-rig-gated item unless the caller
          -- declared it has rig access.
          AND ${crossMachineRigExclusionSql(tx, filter.rigAvailable)}
          -- WI-2797: never self-select an item a peer has explicitly claim-held (do-not-
          -- opportunistically-claim) — still directly claimable by id.
          AND ${claimHoldExclusionSql(tx)}
          -- D-005: never self-select a lane:'observation' scorecard/reflection — by design it
          -- "never enters the work queue" (only the Observations pane + Scout digest read it).
          AND ${observationLaneExclusionSql(tx)}
          AND ${needsOwnerActionExclusionSql(tx)}
          -- D-003/P-004: normal self-selection cannot take pending review work or the
          -- submitter-owned revision interval. The dedicated reviewer tool is the only
          -- selector for pending; approved rows pass this floor again.
          AND ${agentReviewNormalExclusionSql(tx)}
          -- P-007 / D-021: never self-select a verification task to its reporter or implementer.
          AND NOT ${verificationTaskConflictSql(tx, filter.assignee, 'wi.payload')}
          AND ${externalBlockersExclusionSql(tx)}
          -- WI-2633: never self-select an auto-filed replication-liveness detector EI
          -- (payload._ei.created_by='system:replication-liveness'). A generic backlog-drain
          -- worker structurally cannot action it — verifying the current verdict needs the
          -- p2p-release-readiness fleet's live in-process getReplicationLiveness()/dogfood-
          -- substrate diagnostics — so it would only ever close it as gated-to-another-fleet,
          -- burning a wake each time. Still directly claimable BY ID (the p2p fleet's triage).
          AND ${federationDetectorExclusionSql(tx)}
          -- EI-8802: never self-select a stray AUTO-loop-iteration bookkeeping marker (a
          -- misfiled loop:checkpoint substitute) — pure recycle churn for zero real work.
          -- Still directly claimable BY ID.
          AND ${loopIterationNoiseExclusionSql(tx)}
          -- EI-8972: never self-select a row that already carries a genuine terminal
          -- completion (terminal_owner + terminal_completion_ref both set) even if its
          -- status was never flipped terminal — a peer already finished/diagnosed it
          -- (work_items:complete's own stateWarning documents this exact gap: a caller can
          -- omit state and leave the row claimable). Still directly claimable BY ID.
          AND ${alreadyTerminallyCompletedExclusionSql(tx)}
          -- EI-20106946822538304: an eligible watchdog signal is not actionable while
          -- auto-close is still gathering its six-ran-tick recovery window. Keep the row
          -- in the pool, but fail the READY/claim floor until the same live evidence
          -- shows the signal survived that window. The helper is fail-open for every
          -- incomplete or malformed history, so a real problem cannot be hidden by a
          -- telemetry gap.
          AND ${watchdogRecoveryWindowExclusionSql(tx)}
          -- Mig 499 + WI-5939: the per-claim cooldown floor (issueCooldownExclusionSql) — the
          -- SAME fragment the preview (get-next), the miss diagnosis and the per-id explainer
          -- apply, so the claim door and every read of it can no longer disagree. NULL-safe in
          -- both legs: only "released by ME within the release window" or "filed by SOMEONE
          -- ELSE within the filing-grace window" excludes the row from MY OWN self-select.
          AND ${issueCooldownExclusionSql(tx, filter.assignee, cooldown)}
        -- EI-7407: feature_order steering must be UNCONDITIONAL for issue-family claims (per
        -- this function's own doc above — "the Mug can now steer issues too, P-007" — with
        -- no swarmId/Multi-Swarm-lease caveat, unlike the feature-family path's P-010-gated
        -- behavior). The swarm-affinity tie-break stays swarmId-gated (meaningless without
        -- it); the fix moves feature_order OUT of that ternary so a plain, lease-less
        -- work_items:set_priority actually changes this query's pull order instead of
        -- silently no-op'ing on ordering while still reporting written:true.
        -- EI-19497592871345016: when the caller compiled a claim spec, its rank is
        -- AUTHORITATIVE here (see opts.specOrderSql) — this ORDER BY used to be hardcoded, so
        -- the whole issue family honored a spec's FILTER while silently discarding its RANK.
        -- Undefined ⇒ the legacy ordering below, byte-identical for the no-spec caller.
        ORDER BY ${filter.swarmId ? tx`(wi.swarm_affinity = ${filter.swarmId}) DESC NULLS LAST,` : tx``} ${specOrderSql ?? tx`wi.feature_order ASC NULLS LAST, wi.created_ts ASC`}
        LIMIT 1
        FOR UPDATE SKIP LOCKED
     )
    RETURNING ${tx.unsafe(FEATURE_COLS)}`;
      if (!rows[0]) return rows;
      return (await guardPlanItemSiblingClaim(tx, rows[0], {
        workspaceId: issueWs,
        assignee: filter.assignee,
        family: 'issue',
      }))
        ? rows
        : [];
    },
    { client: sql, signal: opts.signal },
  );
  // RETURNING the base row uses the feature column shape; the row IS an issue-family row, so
  // map it through the issue facade (state dialect, no claim-time columns) for a consistent
  // WorkItem. featureRowToWorkItem would mislabel family/state, so re-read via the issue path.
  if (!rows[0]) return null;
  // EI-6480: the UPDATE above has ALREADY committed the claim (taken_by is set) on a row in
  // `issueWs`. Re-read in that SAME captured workspace — NOT via bare getIssue(), which
  // re-derives issuesScopeWorkspace() and can drift (its flag cache self-heals on a TTL), so a
  // mid-call flip would make the re-read miss the just-claimed row. A null there historically
  // returned null: the claim LEAKED (row stayed taken_by-set, out of the pool) and the caller
  // saw a spurious "ready but a peer raced you (retry)" miss even though the claim succeeded —
  // the reported EI-6480 symptom (a self-consistent miss with readyUnclaimed>0). Reading in the
  // exact claimed workspace makes that null impossible for a live claim.
  const issue = await getIssueInWorkspace(issueWs, rows[0].feature_id, { baseHarnessSlug: rows[0].harness_slug });
  if (issue) return issueToWorkItem(issue);
  // Defense in depth: the row we just claimed is, by construction, present in `issueWs` (the
  // UPDATE filtered on it and committed the mutation), so a null here is a genuine anomaly, NOT
  // a race. Do not leak the claim or misreport it as a retryable miss: RELEASE it (return the
  // row to the pool) and surface an honest error so the fault is visible, not disguised. Clear
  // the claim with a workspace-EXACT UPDATE (not releaseWorkItem, which re-derives the scope via
  // getIssue and would hit the same drift) so the undo can't itself leak. Bounded for the same
  // reason as the claim UPDATE above — a write on this pool must never hang unboundedly.
  await boundedOrgTxn(
    (tx) => tx`
    UPDATE harness_shared.work_items
       SET taken_by = NULL, taken_at = NULL, last_progress_at = NULL, updated_ts = ${Date.now()}
     WHERE workspace_id = ${issueWs} AND harness_slug = ${rows[0].harness_slug} AND feature_id = ${rows[0].feature_id}`,
    { client: sql },
  );
  throw new Error(
    `claimNextIssueWorkItem: claimed issue ${rows[0].feature_id} in workspace '${issueWs}' but could ` +
      `not re-read it (getIssueInWorkspace returned null); released the claim. This is an anomaly, ` +
      `not a peer race.`,
  );
}

export interface WorkItemObservation {
  item: WorkItem;
  /** Unclaimed AND not refused by the G2 admission/trust gate — i.e. a claim would
   *  actually succeed. False for both "someone holds it" and "unclaimed but gated". */
  available: boolean;
  claimedBy: string | null;
  /** Current applied operation receipt prevents this target from claiming. */
  operationClaimDenied?: string;
  /**
   * EI-7841: true when the item is UNCLAIMED (or revalidateHeld was requested)
   * yet still not-`available` because
   * the feature-family G2 admission/trust gate (autoPickableWhereSql /
   * isAutoPickable — the same gate `work_items:claim` and `claim_next` enforce)
   * would refuse it: a remote, un-admitted, untrusted-author item. Omitted (not just
   * false) when the gate doesn't apply, so existing `available`-only callers are
   * unaffected. Lets a self-selecting agent see WHY an apparently-free item can't be
   * claimed instead of discovering it only via a `not_claimable` claim failure.
   */
  gated?: boolean;
  /**
   * EI-22122824405906276: set when the item is UNCLAIMED (or revalidateHeld was
   * requested) yet gated by the admission /
   * duplicate-screening floor (`isWorkItemDuplicateAdmitted` — the FIRST floor checked
   * below, and the only one of the `gated:true` cases here that carried no distinguishing
   * field at all before this). Rendered from the SAME {@link admissionPendingExplanation} /
   * {@link admissionPendingCreateRemedy} the claim-refusal path (`explainIssueClaimFloors`'s
   * `'admission-pending'` floor) already renders, so a caller reading `work_items:observe`
   * — or `coord:dispatch`'s `actionable-work-item-dispatch.ts`, which folds this into its
   * `admission_gated` skip reason — sees the SAME "clears on its own" explanation and the
   * SAME one-argument remedy instead of rediscovering it by hand. Measured cost of the gap
   * this closes: ~8 tool calls and five refuted hypotheses to rediscover a documented fix.
   */
  admissionPending?: { reason: string; remedy: string };
  /**
   * WI-3667/P-003: set when the item is UNCLAIMED yet carries a plan-item back-pointer
   * (payload.plan_item) whose linked plan lane is effectively `blocked` or needs a human
   * decision (see scheduler/plan-item-lane-guard.ts) — the same check
   * work_items:claim_next / scheduler:get_next already enforce at claim time (they
   * silently claim-then-release and retry the next row). Surfacing the reason here lets a
   * self-selecting agent — or anything reading `work_items:observe` before deciding to
   * claim — see WHY an apparently-free item isn't really claimable, instead of only
   * discovering it via a claim that bounces back to the pool.
   */
  planItemBlocked?: { reason: string; planSlug: string; itemId: string; effectiveStatus: string };
  /**
   * WI-5343 (secondary ask): true when the item is UNCLAIMED yet carries a
   * `payload._claimHold` durable park (WI-2797 — `work_items:release { claimHold:true }` /
   * a `blocked` state auto-applies it) that excludes it from `scheduler:get_next` /
   * `claim_next` self-select just like the G2 gate and the plan-lane block above. Before
   * this field existed, a claim-held item read back as `available:true` here (and in the
   * `work_items:list { admissibleOnly:true }` fold this function backs, pre the WI-5343
   * floor-parity fix) — a caller weighing "should I claim this by id" had no way to see
   * the hold short of a bounced `claim_hold_blocked` claim attempt.
   */
  claimHoldParked?: boolean;
  /**
   * WI-5343 (the "live lane claim" gap): set when the item is UNCLAIMED yet its
   * linked plan item is currently held by a LIVE `plan_item_claims` lease —
   * `effectiveStatus` (the `planItemBlocked` check above) is a structural
   * blocked-by-graph computation and says nothing about who currently holds
   * the pen, so this catches the case that check does not: an unassigned
   * work-item whose plan item someone is actively executing right now.
   * Distinct from `plan-item-claim-collision.ts`'s drift check (which fires on
   * an ASSIGNED item whose plan item has since drifted to a DIFFERENT owner);
   * this is the pre-claim question of whether the plan item is already spoken
   * for by anyone at all.
   */
  planItemLiveClaimed?: {
    reason: string;
    planSlug: string;
    itemId: string;
    claimedBy: string;
    claimedByLabel: string | null;
  };
}

/**
 * The tuple-space `rd` (D-004): OBSERVE a work-item without claiming it — the read
 * primitive, kept DISTINCT from the `in` of claim. Reports claimability so a self-
 * selecting agent can decide before taking. (list/get are the bulk rd surface; this is
 * the explicit single-item observe-with-claimability.)
 *
 * EI-7841: `work_items:list` (→ coord:orient's claimable backlog) and this observe
 * read historically reported `available: true` for ANY unclaimed row, while the two
 * claim paths (`claimWorkItem` / `claimFloorsWhereSql`) additionally enforce the G2
 * admission/trust gate (autoPickableWhereSql) for feature-family items — so a
 * remote, un-admitted item looked claimable here and then bounced with
 * `not_claimable` on the actual claim, burning a wake cycle. This applies the SAME
 * gate (via the pure-JS `isAutoPickable`, mirroring placement-gather's usage — no
 * extra per-row query beyond the one-off trust-list load) so `available` here
 * matches what `work_items:claim` will actually do.
 */
export async function observeWorkItem(
  id: string,
  opts: { harness?: string; revalidateHeld?: boolean; assignee?: string } = {},
): Promise<WorkItemObservation | null> {
  const wi = await getWorkItem(id, opts.harness);
  if (!wi) return null;
  // EI-15027: treat the literal 'unassigned' sentinel the same as NULL/empty. `wi` came
  // through getWorkItem's mapping layer (normalizeTakenBy already applied there), so this
  // is belt-and-suspenders — mirrors classifyClaimFailure's own defense-in-depth call.
  const unclaimed = !normalizeTakenBy(wi.assignee);
  // Dispatch replay preserves ownership but must re-read admission/trust/origin.
  // Ordinary rd callers retain the historical holder-only observation contract.
  const checkAdmission = unclaimed || opts.revalidateHeld === true;
  if (checkAdmission) {
    const payload = wi.payload && typeof wi.payload === 'object' && !Array.isArray(wi.payload)
      ? wi.payload as Record<string, unknown> : null;
    if (opts.assignee || payload?.blueprintOperation !== undefined) {
      const operationClaims = await import('./blueprint/operation-worker-binding');
      const read = opts.assignee
        ? await operationClaims.readActiveOperationWorkerClaimBinding(activeWorkspaceId(), opts.assignee)
        : { status: 'none' as const };
      const match = operationClaims.matchOperationWorkerClaim(read, wi);
      if (!match.allowed) return {
        item: wi, available: false, claimedBy: wi.assignee,
        gated: true, operationClaimDenied: match.reason,
      };
    }
  }
  if (
    checkAdmission &&
    !(await isWorkItemDuplicateAdmitted(id, {
      workspaceId: wi.family === 'issue' ? issuesScopeWorkspace() : activeWorkspaceId(),
    }))
  ) {
    return {
      item: wi,
      available: false,
      claimedBy: wi.assignee,
      gated: true,
      admissionPending: { reason: admissionPendingExplanation(), remedy: admissionPendingCreateRemedy() },
    };
  }
  if (checkAdmission && wi.family === 'feature') {
    // Cheap path first — local/admitted items (the vast majority) resolve without
    // touching the DB at all; only a remote+un-admitted item needs the trust-list
    // read to check the Phase-3 fast-path before concluding it's truly gated.
    let pickable = isAutoPickable(wi.origin, wi.auditVerdict, wi.verifiedAuthorGithubUserId, undefined);
    if (!pickable) {
      const trusted = await loadTrustedGithubUserIds(activeWorkspaceId()).catch(() => new Set<number>());
      pickable = isAutoPickable(wi.origin, wi.auditVerdict, wi.verifiedAuthorGithubUserId, trusted);
    }
    if (!pickable) return { item: wi, available: false, claimedBy: wi.assignee, gated: true };
  }
  // WI-3649: the issue-family (bug/change/task) half of the same EI-7841 class — a
  // federated (origin='remote') issue-family row is never locally claimable (its
  // authoring peer's core owns it, EI-7833/mig-521), so `available` must say so here
  // too, not just report unclaimed and let the real claim bounce with not_claimable.
  //
  // EI-19340398119001086 (WI-7096 follow-up): the bare isIssueLocallyClaimable(origin)
  // check above is own-node UNAWARE — it treats a row THIS workspace authored, which
  // simply round-tripped federation (origin='remote' but carrying one of OUR OWN
  // author_pubkeys), the same as a true peer-owned row. Every other implementation of
  // this floor already has the own-node escape hatch (isIssueLocallyClaimableWhereSql,
  // used by claim_next/scheduler:get_next/work_items:claimable; and, since migration
  // 728, the claim-by-id DB trigger itself) — this JS-level diagnostic was the one
  // chokepoint left behind, so `work_items:observe`/`work_items:get` reported
  // available:false/gated:true for ~3,800 open rows (measured 2026-08-02) that a real
  // claim-by-id would actually succeed on. Cheap path first: only a remote row needs
  // the extra DB round-trip, and a DB error fails SAFE (still reported gated).
  if (checkAdmission && wi.family === 'issue' && !isIssueLocallyClaimable(wi.origin)) {
    let ownNodeClaimable = false;
    if (wi.origin === 'remote') {
      try {
        const { sql } = getOrgPg();
        const ws = issuesScopeWorkspace();
        const rows = await sql<{ ok: number }[]>`
          SELECT 1 AS ok FROM harness_shared.work_items wi
           WHERE wi.workspace_id = ${ws} AND wi.feature_id = ${id}
             AND ${isIssueLocallyClaimableWhereSql(sql, ws)}`;
        ownNodeClaimable = rows.length > 0;
      } catch {
        ownNodeClaimable = false;
      }
    }
    if (!ownNodeClaimable) return { item: wi, available: false, claimedBy: wi.assignee, gated: true };
  }
  // WI-5343 (secondary ask): an unclaimed row can still carry a durable WI-2797
  // claim-hold (payload._claimHold) — the same floor claimFloorsWhereSql /
  // claimHoldExclusionSql enforce at claim time (both families). Surface it here
  // too, same shape as the G2/origin gates above and the plan-lane block below, so
  // a caller sees WHY a claim-by-id would bounce with claim_hold_blocked instead of
  // discovering it only via that bounce.
  if (unclaimed && isClaimHoldParked(wi.payload)) {
    return { item: wi, available: false, claimedBy: wi.assignee, gated: true, claimHoldParked: true };
  }
  // WI-3667/P-003: an unclaimed row can still carry a plan-item back-pointer whose
  // linked lane is effectively `blocked`/needs-human even though it cleared every SQL
  // floor above — the same case work_items:claim_next / scheduler:get_next already
  // catch at claim time via a silent claim-then-release retry (see
  // scheduler/plan-item-lane-guard.ts). Surface it here too, so a caller deciding
  // whether to claim (or auditing "why is this item not really claimable") sees the
  // SAME reason instead of only discovering it via a bounced claim. Lazy import to
  // avoid a module-cycle with the scheduler layer (which imports work-items types).
  if (unclaimed) {
    const { planItemLaneBlockReason, planItemLiveClaimReason } = await import('./scheduler/plan-item-lane-guard');
    const blocked = await planItemLaneBlockReason(wi);
    if (blocked) {
      return {
        item: wi,
        available: false,
        claimedBy: wi.assignee,
        gated: true,
        planItemBlocked: blocked,
      };
    }
    // WI-5343: effectiveStatus alone misses a plan item that is currently LIVE-
    // CLAIMED by an agent (structural status vs "who holds the pen right now") —
    // an unassigned work-item whose linked plan item is mid-flight under a live
    // claim is not really open to a self-selector even though every structural
    // floor above passed. Surface it the same way (see planItemLiveClaimReason's
    // doc comment for the WI-5137 incident this closes).
    const liveClaim = await planItemLiveClaimReason(wi);
    if (liveClaim) {
      return {
        item: wi,
        available: false,
        claimedBy: wi.assignee,
        gated: true,
        planItemLiveClaimed: liveClaim,
      };
    }
  }
  return { item: wi, available: unclaimed, claimedBy: wi.assignee };
}

/**
 * Lifecycle bindings that cease to be true when a work-item is released or
 * settled. The plan-lane form is included because releaseWorkItem already
 * releases that linked lane at the same boundary.
 */
export function lifecycleBindingsForWorkItem(
  wi: Pick<WorkItem, 'id' | 'sourcePlanSlug' | 'sourcePlanItemIds'>,
): Array<{ kind: string; ref: string }> {
  const bindings: Array<{ kind: string; ref: string }> = [
    { kind: 'work-item', ref: wi.id },
    { kind: 'work-item-claim', ref: wi.id },
    { kind: 'work-item-blocked', ref: wi.id },
  ];
  if (wi.sourcePlanSlug) {
    for (const itemId of wi.sourcePlanItemIds ?? []) {
      bindings.push({ kind: 'plan-lane', ref: `${wi.sourcePlanSlug}#${itemId}` });
    }
  }
  return bindings;
}

async function retireLifecycleBindingsForWorkItem(
  wi: Pick<WorkItem, 'id' | 'sourcePlanSlug' | 'sourcePlanItemIds'>,
): Promise<void> {
  const { retireLifecycleBoundWatches } = await import('./events/await/store');
  // One statement for every binding (WI-10003631) — not one txn per binding.
  await retireLifecycleBoundWatches(lifecycleBindingsForWorkItem(wi));
}

/**
 * A holder's auto-armed claim-release watch is meant to report an involuntary
 * release (for example, session cleanup), not wake the same owner immediately
 * after that owner deliberately releases the claim. Retire only the releasing
 * holder's claim-bound watch, and only after the release UPDATE succeeded so a
 * compare-and-release race cannot cancel a watch for a claim that remains held.
 *
 * The owner is explicit rather than inferred from expectedAssignee: internal
 * reaper and claim-then-release callers also pass an expected holder, but must
 * preserve the holder notification semantics.
 */
async function retireVoluntaryReleaseClaimWatch(
  wi: Pick<WorkItem, 'id' | 'assignee'>,
  releasingOwnerId: string | undefined,
): Promise<void> {
  const ownerId = releasingOwnerId?.trim();
  if (!ownerId || !wi.assignee || wi.assignee !== ownerId) return;
  try {
    const { retireLifecycleBoundWatches } = await import('./events/await/store');
    await retireLifecycleBoundWatches({ kind: 'work-item-claim', ref: wi.id }, { ownerIds: [ownerId] });
  } catch {
    // A coordination-store failure must never fail a release or prevent the
    // normal claim:released event from reaching other waiters.
  }
}

export async function releaseWorkItem(
  id: string,
  opts: {
    harness?: string;
    expectedAssignee?: string;
    /** EI-15019 (default true — unchanged for every existing caller): pass false for
     *  an INTERNAL claim-then-immediate-release round-trip (e.g. claim-spec-store.ts's
     *  tier-3 quarantine of a spec-mismatched issue) that never exposed any observable
     *  claimability change, so the broad `work-item:claimable` pool-wide wake is
     *  suppressed — see emitClaimReleasedEvent's doc comment. `claim:released:<id>`
     *  (the targeted, id-scoped key) still always fires. */
    announceClaimable?: boolean;
    /** WI-6678: receive the PRE-release holder, read from the SAME row-read this
     *  function already performs below. A caller that needs to distinguish a real
     *  release from a semantic no-op (`ok:true` on an already-unassigned item) must
     *  NOT re-read the row itself: a call-site pre-read is both a redundant second
     *  round-trip AND racy — the assignee can change between the caller's read and
     *  the one here, so the reported `previousAssignee` would describe a state the
     *  release never acted on. Fires exactly once, before any UPDATE, whenever the
     *  row exists (including when it is already free, so `wasClaimed:false` is
     *  observable). Never fires when the row is not found — that is the `null`
     *  return. Fail-soft: a throwing callback must not break the release. */
    onPriorState?: (prior: { assignee: string | null; wasClaimed: boolean }) => void;
    /**
     * Identity of the owner deliberately releasing its own claim. When it
     * matches the pre-release holder, that holder's claim-bound auto-arm is
     * retired before `claim:released:<id>` is emitted. Omit for reaper and
     * other involuntary/internal release paths so the holder is notified.
     */
    releasingOwnerId?: string;
  } = {},
): Promise<WorkItem | null> {
  const wi = await boundedOrgTxn((tx) => getWorkItem(id, opts.harness, {}, tx), { readOnly: true });
  if (!wi) return null;
  if (hasResourceGovernorReceiptPayload(wi.payload)) {
    throw new ResourceGovernorReleaseRequiredError(id);
  }
  // Only a release of an actually-CLAIMED item is a `claim:released` transition —
  // releasing an already-free row is a no-op and must not wake pool-waiters.
  const wasClaimed = Boolean(wi.assignee);
  if (opts.onPriorState) {
    try {
      opts.onPriorState({ assignee: wi.assignee ?? null, wasClaimed });
    } catch {
      /* a caller's delta bookkeeping must never fail the release itself */
    }
  }
  // EI-6832: this item is about to RETURN to the unclaimed pool — clear any lease a
  // prior claim_next left on it under the WORKITEM_CLAIM_LEASE flag, so it doesn't sit
  // visibly-unclaimed-yet-lease-poisoned for up to the lease TTL. Await the
  // already-fail-soft cleanup so the release promise's contract is honest: when
  // it resolves, both the work-item row and its coordination claim ledger have
  // settled (see releaseWorkItemLease's doc comment for the bounded no-throw path).
  if (wi.harness) await releaseWorkItemLease({ harness: wi.harness, workItemId: id, owner: wi.assignee });
  // P-105: claim:released:<id> — wake anyone awaiting this item's claim to free, the
  // moment it returns to the pool (both the voluntary work_items:release tool AND the
  // stale-claim reaper route through here). Fire-and-forget + lazy import (work-items-
  // events imports THIS module statically — the lazy import breaks the cycle).
  const emitReleased = async (released: WorkItem | null): Promise<void> => {
    if (released && wasClaimed) {
      await retireVoluntaryReleaseClaimWatch(wi, opts.releasingOwnerId);
      // P-009: the agent has put this work DOWN — clear its goal stamp so later
      // calls are not attributed to a goal it no longer holds. Only when the
      // released item is the one currently stamped: a release of some OTHER item
      // must not wipe the goal the agent is actually working under. `wi.assignee`
      // is the PRE-release holder (read above, before the UPDATE).
      const priorHolder = wi.assignee;
      if (priorHolder) clearGoalClaimedIfMatches(priorHolder, released.id);
      // P-007: emitClaimReleasedEvent internally co-fires `work-item:claimable`
      // for a row that returned to a claimable state — one hook here. EI-15019:
      // thread announceClaimable through so an internal quarantine release can
      // suppress that broad co-fire.
      await import('./work-items-events')
        .then((m) => m.emitClaimReleasedEventAwaited(released, { announceClaimable: opts.announceClaimable }))
        .catch(() => {});
      // P-009 / D-008: the FLEET-scoped counterpart. `claim:released:<id>` above is
      // id-scoped, so it only serves someone already waiting on THIS id — a leader
      // does not know which of its fleet's items will free next. This fires
      // `fleet:claim-released:<slug>` for the PRIOR holder's fleet so the leader can
      // sleep instead of polling fleet:assignments for a claim that dropped.
      // `priorHolder` is the pre-release assignee read above (never re-read: the
      // released row no longer carries it). Suppressed for the same internal
      // claim-then-immediate-release round-trip the broad co-fire skips — it exposes
      // no real change, so it is not a transition a leader should be woken for.
      if (opts.announceClaimable !== false) {
        void trackDetached(import('./fleet-transition-events'))
          .then((m) => m.announceFleetClaimReleased(priorHolder, released))
          .catch(() => {});
      }
      // EI-18734870651452334: a released claim with NO agent-written checkpoint
      // is indistinguishable from never-started work — the fast SessionEnd
      // force-release path (P-002) and the stale-claim reaper backstop (P-001)
      // both route through THIS function, same as the voluntary release tool,
      // so this one hook covers all three. Skipped for the internal
      // claim-then-immediate-release round-trip (announceClaimable:false) —
      // that path never exposes real held-work to lose. Fire-and-forget,
      // bounded, fail-soft: never blocks or fails the release itself.
      if (priorHolder && opts.announceClaimable !== false) {
        void trackDetached(import('./turn-end-tracking-io'))
          .then((m) =>
            m.checkpointOnRelease({
              releasingOwnerId: priorHolder,
              workspaceId: wi.family === 'issue' ? issuesScopeWorkspace() : activeWorkspaceId(),
              harness: released.harness ?? null,
              workItemId: released.id,
            }),
          )
          .catch(() => {});
      }
    }
  };
  // P-006 (fleet-leadership-continuity-and-actuation-2026-08-01): release the linked PLAN LANE
  // together with the work-item, not separately. Holding a work-item is not holding its plan
  // item, so releasing only this half left the lane still naming the departed holder — the next
  // claimant then collides with a lane it cannot take (the agent-trap-guards-2026-07-26 P-006
  // incident, where the collision surfaced only at close time, after a duplicated-work window).
  //
  // AWAITED and ordered BEFORE the UPDATE below, deliberately. The two stores cannot share a
  // transaction (the plan claim routes through a possibly-REMOTE claim authority), so what we
  // actually control is WHICH half-state a mid-way failure can reach. Lane-first leaves the
  // RECOVERABLE one — lane free, item still mine, retryable. The reverse leaves the damaging one,
  // where the item is already back in the pool for a peer to collide on. Fail-soft inside, so a
  // claims-store hiccup can never wedge a release: this same function carries the voluntary
  // release tool, the SessionEnd force-release, AND the stale-claim reaper.
  if (wasClaimed) {
    await import('./plan-items/release-linked-lane')
      .then((m) => m.releaseLinkedPlanLane(wi, wi.assignee))
      .catch(() => null);
  }
  if (wi.family === 'issue') {
    const updated = await releaseIssue(id, { expectedAssignee: opts.expectedAssignee });
    const released = updated ? issueToWorkItem(updated) : null;
    await emitReleased(released);
    if (released) await retireLifecycleBindingsForWorkItem(released);
    return released;
  }
  const { sql } = getOrgPg();
  // P-003 / D-002: a VOLUNTARY release mirrors the reaper — a freed mid-flight
  // (requeueable) row resets → `todo` so it returns to the claimable pool, since
  // an agent releasing in-flight work wants it picked up again, not stranded in a
  // non-dispatchable status. No requeue_count bump (voluntary release is not a
  // failure / poison-loop). Terminal (`passed`/`deprecated`), `blocked`, and
  // already-`todo` rows keep their status. Done in SQL off the live column so it
  // never depends on the JS-side state mapping.
  const nonRequeue = [...FEATURE_NON_REQUEUE_STATES];
  const rows = await sql<FeatureRowDb[]>`
    UPDATE harness_shared.harness_features_consolidated
       -- P-001: release clears the progress signal too — the next claimant starts fresh
       -- (a stale last_progress_at must not outlive the holder that earned it).
       SET taken_by = NULL, taken_at = NULL, last_progress_at = NULL,
           -- Release-cooldown provenance (mig 485 / EI-6956): remember WHO freed this row
           -- so the claim floors keep the RELEASING bee off it for a short cooldown
           -- (claim/release ping-pong guard). SET's RHS reads the OLD row, so taken_by
           -- here is the releasing holder; an already-free release keeps prior provenance.
           last_released_by = CASE WHEN taken_by IS NOT NULL AND taken_by <> '' THEN taken_by ELSE last_released_by END,
           last_released_at = CASE WHEN taken_by IS NOT NULL AND taken_by <> '' THEN now() ELSE last_released_at END,
           -- work-item-status-full-unify P-004/P-005: a stranded mid-flight feature is
           -- requeued to the unified claimable token 'open' (was 'todo') so it is claimable
           -- under the narrowed ['open'] floor. FEATURE_NON_REQUEUE_STATES already treats
           -- both 'open' and legacy 'todo' as non-requeue, so this only fires for genuinely
           -- mid-flight rows (in_progress/validating/wip/failing).
           status = CASE WHEN status <> ALL(${nonRequeue}::text[]) THEN 'open' ELSE status END,
           updated_ts = ${Date.now()}
     WHERE harness_slug = ${wi.harness} AND feature_id = ${id}
       -- EI-7588: same atomic compare-and-release guard as the issue-family path above —
       -- a row held by someone OTHER than expectedAssignee matches 0 rows (null return),
       -- not a silent steal.
       AND (${opts.expectedAssignee ?? null}::text IS NULL OR taken_by IS NULL OR taken_by = ${opts.expectedAssignee ?? null})
    RETURNING ${sql.unsafe(FEATURE_COLS)}`;
  const released = rows[0] ? featureRowToWorkItem(rows[0]) : null;
  if (released && wasClaimed && wi.assignee && wi.harness) {
    await recordWorkItemReleaseCooldown({
      workspaceId: activeWorkspaceId(),
      harnessSlug: wi.harness,
      featureId: released.id,
      agentId: wi.assignee,
    });
  }
  await emitReleased(released);
  if (released) await retireLifecycleBindingsForWorkItem(released);
  return released;
}

/* ── Co-location affinity (hive-coordination-model P-002) ──────────────────────────
 * The Queen's co-location lever: stamp/read a work-item's `swarm_affinity` (the Swarm
 * device-pubkey its tightly-coupled work should run on). Feature-family only — the
 * issue-family table has no affinity (bugs/changes aren't placed by the Queen). The
 * value is honored by claimNextWorkItem only under the per-Hive claim lease (P-002).
 */
export interface SwarmAffinityResult {
  id: string;
  harness: string | null;
  /** The affinity now stored — a Swarm id, or null when cleared / no affinity. */
  swarmAffinity: string | null;
}

/** Set (or clear, with `swarm: null`) a feature-family work-item's Swarm affinity. */
export async function setWorkItemSwarmAffinity(
  id: string,
  swarm: string | null,
  opts: { harness?: string } = {},
): Promise<SwarmAffinityResult | null> {
  const wi = await getWorkItem(id, opts.harness);
  if (!wi) return null;
  if (wi.family !== 'feature') {
    // P-007 (SCHEDULER_ISSUES_CLAIMABLE): once issues join the dispatched backlog the Queen
    // can co-locate them too — write swarm_affinity on the work_items BASE (the engineer_issues
    // view doesn't expose it), keyed by (workspace_id, feature_id) since an issue's harness_slug
    // may be ''. Flag OFF ⇒ issues aren't Queen-placed (no affinity column to set), byte-identical.
    if (!(await schedulerIssuesClaimableEnabled())) {
      return { id, harness: wi.harness, swarmAffinity: null };
    }
    const { sql } = getOrgPg();
    const rows = await sql<{ swarm_affinity: string | null }[]>`
      UPDATE harness_shared.work_items
         SET swarm_affinity = ${swarm}, updated_ts = ${Date.now()}
       WHERE workspace_id = ${issuesScopeWorkspace()} AND feature_id = ${id}
         AND item_kind IN ('bug', 'change', 'task')
      RETURNING swarm_affinity`;
    if (!rows[0]) return null;
    return { id, harness: wi.harness, swarmAffinity: rows[0].swarm_affinity };
  }
  const { sql } = getOrgPg();
  const rows = await sql<{ swarm_affinity: string | null }[]>`
    UPDATE harness_shared.harness_features_consolidated
       SET swarm_affinity = ${swarm}, updated_ts = ${Date.now()}
     WHERE harness_slug = ${wi.harness} AND feature_id = ${id}
    RETURNING swarm_affinity`;
  if (!rows[0]) return null;
  return { id, harness: wi.harness, swarmAffinity: rows[0].swarm_affinity };
}

/** Read a feature-family work-item's current Swarm affinity (null when none / issue-family). */
export async function getWorkItemSwarmAffinity(
  id: string,
  opts: { harness?: string } = {},
): Promise<SwarmAffinityResult | null> {
  const wi = await getWorkItem(id, opts.harness);
  if (!wi) return null;
  if (wi.family !== 'feature') {
    // P-007: read the issue's stored affinity off the base when issues are claimable; else null
    // (byte-identical to the feature-only behavior).
    if (!(await schedulerIssuesClaimableEnabled())) return { id, harness: wi.harness, swarmAffinity: null };
    const { sql } = getOrgPg();
    const rows = await sql<{ swarm_affinity: string | null }[]>`
      SELECT swarm_affinity FROM harness_shared.work_items
       WHERE workspace_id = ${issuesScopeWorkspace()} AND feature_id = ${id}
         AND item_kind IN ('bug', 'change', 'task') LIMIT 1`;
    return { id, harness: wi.harness, swarmAffinity: rows[0]?.swarm_affinity ?? null };
  }
  const { sql } = getOrgPg();
  const rows = await sql<{ swarm_affinity: string | null }[]>`
    SELECT swarm_affinity FROM harness_shared.harness_features_consolidated
     WHERE harness_slug = ${wi.harness} AND feature_id = ${id} LIMIT 1`;
  return { id, harness: wi.harness, swarmAffinity: rows[0]?.swarm_affinity ?? null };
}

/* ── Backlog priority (the Queen's steer-don't-dispatch lever) ──────────────────────
 * The Queen STEERS the SHARED backlog by setting each feature-family item's
 * `feature_order` — the column the decentralized claim path (claimNextWorkItem) orders
 * by (ASC NULLS LAST: LOWER feature_order = claimed sooner; NULL = unprioritized, sorts
 * last). This is the "sets priorities" half of the steering loop
 * (autoloop-pot-operator-rebuild B7 / decentralized-dispatch-scaling D-003/D-004 + P-009/
 * P-010): she reads the rolled-up change feed and reorders the backlog the fleet claims
 * against, never assigning item-by-item.
 *
 * It is DISTINCT from `reorderWorkItem` (work_items:reorder), which ranks ONE bee's
 * already-CLAIMED work-list (`assignee_rank`). Priority = the GLOBAL backlog order
 * (pre-claim); rank = a per-assignee queue (post-claim). Was feature-family only when
 * this comment was first written; since SCHEDULER_ISSUES_CLAIMABLE (P-007/EI-7407)
 * joined issue-family (bug/change/task) into the SAME dispatched backlog,
 * `setWorkItemPriority`/`getWorkItemPriority` apply to them too (writing/reading
 * `feature_order` on the shared `harness_shared.work_items` base row) — `applicable:
 * false` now means only "the SCHEDULER_ISSUES_CLAIMABLE flag is off", not "issue-family
 * is categorically excluded". EI-10421: the READ side of this (issueToWorkItem /
 * `engineer_issues` view) lagged this fix until migration 588 — see its comment.
 */
export interface WorkItemPriorityResult {
  id: string;
  harness: string | null;
  /** The backlog priority (`feature_order`) now stored — LOWER = higher priority; null = unprioritized. */
  priority: number | null;
  /** Whether backlog priority APPLIES — feature-family (the dispatched backlog) = true; issue-family = false. */
  applicable: boolean;
  /**
   * P-011 steering lease (D-004): true when THIS Swarm does not hold its Hive's
   * single-steerer lease — the write was NOT committed (priority echoes the
   * stored value); a PROPOSAL was recorded (work-item comment + advisory coord
   * escalation) for the holding Queen to dispose. Local placement (assignee
   * ranks, claims) is never lease-gated.
   */
  proposed?: boolean;
  /** The lease holder's label (set with `proposed`). */
  steeringHolder?: string;
}

/** Set (or clear, with `priority: null`) a feature-family work-item's backlog priority (`feature_order`). */
export async function setWorkItemPriority(
  id: string,
  priority: number | null,
  opts: { harness?: string } = {},
): Promise<WorkItemPriorityResult | null> {
  const wi = await getWorkItem(id, opts.harness);
  if (!wi) return null;
  if (wi.family !== 'feature') {
    // P-007 (SCHEDULER_ISSUES_CLAIMABLE): issues join the dispatched backlog, so the Queen's
    // feature_order steer applies to them too — write it on the work_items BASE (the
    // engineer_issues view doesn't expose feature_order), keyed by (workspace_id, feature_id).
    // No steering-lease arbitration: an issue isn't the per-Hive harness frontier the lease
    // single-writers. Flag OFF ⇒ applicable:false (no feature_order), byte-identical.
    if (!(await schedulerIssuesClaimableEnabled())) {
      return { id, harness: wi.harness, priority: null, applicable: false };
    }
    const ordIssue = priority === null ? null : Math.trunc(priority);
    const { sql } = getOrgPg();
    const rows = await sql<{ feature_order: number | null }[]>`
      UPDATE harness_shared.work_items
         SET feature_order = ${ordIssue}, updated_ts = ${Date.now()}
       WHERE workspace_id = ${issuesScopeWorkspace()} AND feature_id = ${id}
         AND item_kind IN ('bug', 'change', 'task')
      RETURNING feature_order`;
    if (!rows[0]) return null;
    return { id, harness: wi.harness, priority: rows[0].feature_order, applicable: true };
  }
  const ord = priority === null ? null : Math.trunc(priority);
  const { sql } = getOrgPg();
  // P-011 single-steerer lease (D-004, hive-network-surface): cross-Swarm
  // priority writes are single-writer — the lease rides the per-Hive lock
  // authority. A non-holder's steer becomes a PROPOSAL (comment + advisory
  // escalation; the holding Queen disposes) and the row is NOT written.
  // checkSteeringLease never throws and FAILS OPEN (non-Hive harness, N=1,
  // partition, missing fixture tables → holder:true), so behavior is unchanged
  // everywhere except a live multi-Swarm Hive where another Swarm holds it.
  if (wi.harness) {
    const lease = await checkSteeringLease(activeWorkspaceId(), wi.harness);
    if (!lease.holder) {
      await recordSteeringProposal({
        workspaceId: activeWorkspaceId(),
        harnessSlug: wi.harness,
        featureId: id,
        requestedOrder: ord,
        potSlug: lease.potSlug ?? 'unknown',
        holderLabel: lease.holderLabel ?? 'an unidentified peer Swarm',
      }).catch(() => undefined);
      const cur = await sql<{ feature_order: number | null }[]>`
        SELECT feature_order FROM harness_shared.harness_features_consolidated
         WHERE harness_slug = ${wi.harness} AND feature_id = ${id} LIMIT 1`;
      return {
        id,
        harness: wi.harness,
        priority: cur[0]?.feature_order ?? null,
        applicable: true,
        proposed: true,
        steeringHolder: lease.holderLabel ?? 'an unidentified peer Swarm',
      };
    }
  }
  const rows = await sql<{ feature_order: number | null }[]>`
    UPDATE harness_shared.harness_features_consolidated
       SET feature_order = ${ord}, updated_ts = ${Date.now()}
     WHERE harness_slug = ${wi.harness} AND feature_id = ${id}
    RETURNING feature_order`;
  if (!rows[0]) return null;
  // B-12 steering-churn tripwire (hive-network-surface-2026-06-11 P-010 / D-004):
  // the AFTER trigger (mig 232) has just recorded this steer into the ledger;
  // check whether the SAME item has been re-steered by a DIFFERENT writer (another
  // Queen) within the window and raise a debounced owner escalation above
  // threshold. Best-effort — a telemetry/escalation failure must NEVER break the
  // steer, and the ledger table is absent in isolated unit fixtures (42P01 →
  // silently skip; the periodic sweep is the catch-all when it exists).
  if (wi.harness) {
    // Swallow ALL errors silently: the steer is the contract here, telemetry is
    // not, and the periodic sweep (dbos/periodic-workflows.ts) is the backstop for
    // anything this check misses (incl. the ledger table being absent in isolated
    // unit fixtures — 42P01).
    await checkAndEscalateSteeringChurn({
      workspaceId: activeWorkspaceId(),
      harnessSlug: wi.harness,
      featureId: id,
    }).catch(() => undefined);
  }
  return { id, harness: wi.harness, priority: rows[0].feature_order, applicable: true };
}

/**
 * Bump a feature-family work-item to the HEAD or TAIL of its harness's backlog by setting
 * `feature_order` just past the current extreme (top = min−1, bottom = max+1, over the OTHER
 * feature-family items in the harness). The ergonomic steering verb — the Queen thinks "make
 * this the most urgent", not in absolute order integers. Empty/all-null backlog ⇒ 0.
 */
export async function bumpWorkItemPriority(
  id: string,
  position: 'top' | 'bottom',
  opts: { harness?: string } = {},
): Promise<WorkItemPriorityResult | null> {
  const wi = await getWorkItem(id, opts.harness);
  if (!wi) return null;
  if (wi.family !== 'feature') {
    // P-007: bump an issue to the head/tail of the ISSUE backlog (the work_items base, issue
    // kinds, same workspace) when issues are claimable; else applicable:false (byte-identical).
    if (!(await schedulerIssuesClaimableEnabled())) {
      return { id, harness: wi.harness, priority: null, applicable: false };
    }
    const { sql } = getOrgPg();
    const issueWs = issuesScopeWorkspace();
    const extI = await sql<{ min_ord: number | null; max_ord: number | null }[]>`
      SELECT MIN(feature_order) AS min_ord, MAX(feature_order) AS max_ord
        FROM harness_shared.work_items
       WHERE workspace_id = ${issueWs}
         AND item_kind IN ('bug', 'change', 'task')
         AND feature_id <> ${id}`;
    const minI = extI[0]?.min_ord ?? null;
    const maxI = extI[0]?.max_ord ?? null;
    const targetI = position === 'top' ? (minI === null ? 0 : minI - 1) : maxI === null ? 0 : maxI + 1;
    return setWorkItemPriority(id, targetI, opts);
  }
  const { sql } = getOrgPg();
  const ws = activeWorkspaceId();
  const ext = await sql<{ min_ord: number | null; max_ord: number | null }[]>`
    SELECT MIN(feature_order) AS min_ord, MAX(feature_order) AS max_ord
      FROM harness_shared.harness_features_consolidated
     WHERE harness_slug = ${wi.harness}
       AND workspace_id = ${ws}
       AND item_kind IN ('feature', 'chunk')
       AND feature_id <> ${id}`;
  const min = ext[0]?.min_ord ?? null;
  const max = ext[0]?.max_ord ?? null;
  const target = position === 'top' ? (min === null ? 0 : min - 1) : max === null ? 0 : max + 1;
  return setWorkItemPriority(id, target, opts);
}

/** Read a feature-family work-item's current backlog priority (`feature_order`; null when none / issue-family). */
export async function getWorkItemPriority(
  id: string,
  opts: { harness?: string } = {},
): Promise<WorkItemPriorityResult | null> {
  const wi = await getWorkItem(id, opts.harness);
  if (!wi) return null;
  if (wi.family !== 'feature') {
    // P-007: read the issue's feature_order off the base when issues are claimable; else
    // applicable:false (byte-identical to the feature-only behavior).
    if (!(await schedulerIssuesClaimableEnabled()))
      return { id, harness: wi.harness, priority: null, applicable: false };
    const { sql } = getOrgPg();
    const rows = await sql<{ feature_order: number | null }[]>`
      SELECT feature_order FROM harness_shared.work_items
       WHERE workspace_id = ${issuesScopeWorkspace()} AND feature_id = ${id}
         AND item_kind IN ('bug', 'change', 'task') LIMIT 1`;
    return { id, harness: wi.harness, priority: rows[0]?.feature_order ?? null, applicable: true };
  }
  const { sql } = getOrgPg();
  const rows = await sql<{ feature_order: number | null }[]>`
    SELECT feature_order FROM harness_shared.harness_features_consolidated
     WHERE harness_slug = ${wi.harness} AND feature_id = ${id} LIMIT 1`;
  return { id, harness: wi.harness, priority: rows[0]?.feature_order ?? null, applicable: true };
}

export interface ReorderWorkItemResult {
  /** The item moved. */
  id: string;
  /** Its assignee — whose ordered queue this reorder operated on. */
  assignee: string;
  /** The rank the item now holds (0-based; clamped to the queue length). */
  rank: number;
  /** The propose/dispose author stamped on the move (D-008). */
  writer: RankWriter;
  /** The assignee's full ordered queue after the move (head-of-line first). */
  queue: { id: string; rank: number; title: string }[];
}

/**
 * The per-assignee work-list REORDER (local-hive P-020 / D-004): place one work-item at
 * `target` rank within its assignee's ordered queue, shifting peers down (insert-at-rank
 * — what the Queen's "inject at a rank" and a bee's "move this up" both need). Atomic via
 * the `harness_shared.reorder_work_item` SQL fn (one transaction, renumbers densely, spans
 * both base tables). `writer` ('cup'|'mug') stamps the propose/dispose audit (D-008);
 * the Queen-vs-bee write balance is gated by the EXISTING automation tier at the tool
 * layer (P-022), not here.
 *
 * The item must already be CLAIMED (have an assignee) — rank is meaningless on an
 * unassigned item. Returns the new rank + the assignee's ordered queue, or null when the
 * item doesn't exist / isn't assigned.
 */
export async function reorderWorkItem(
  id: string,
  target: number,
  opts: { writer?: RankWriter; harness?: string } = {},
): Promise<ReorderWorkItemResult | { error: string }> {
  const writer: RankWriter = opts.writer ?? 'cup';
  const wi = await getWorkItem(id, opts.harness);
  if (!wi) return { error: `work_item '${id}' not found` };
  // EI-15027: a literal 'unassigned' sentinel assignee is unclaimed too, not a real holder.
  const assignee = normalizeTakenBy(wi.assignee);
  if (!assignee) {
    return { error: `work_item '${id}' is unassigned — claim it before ranking` };
  }

  const { sql } = getOrgPg();
  // The work_items view carries workspace_id; resolve it for this item so the reorder is
  // scoped to the right (workspace, assignee) queue.
  const wsRows = await sql<{ workspace_id: string }[]>`
    SELECT workspace_id FROM harness_shared.work_items WHERE feature_id = ${id} LIMIT 1`;
  const workspace = wsRows[0]?.workspace_id ?? activeWorkspaceId();

  const rankRows = await sql<{ rank: number }[]>`
    SELECT harness_shared.reorder_work_item(
      ${workspace}, ${assignee}, ${id}, ${Math.trunc(target)}, ${writer}
    ) AS rank`;
  const rank = Number(rankRows[0]?.rank ?? 0);

  const queueRows = await sql<{ feature_id: string; assignee_rank: number; title: string | null }[]>`
    SELECT feature_id, assignee_rank, title
      FROM harness_shared.work_items
     WHERE workspace_id = ${workspace} AND taken_by = ${assignee}
     ORDER BY assignee_rank ASC NULLS LAST, updated_ts DESC`;
  return {
    id,
    assignee,
    rank,
    writer,
    queue: queueRows.map((r) => ({ id: r.feature_id, rank: r.assignee_rank, title: r.title ?? '' })),
  };
}

/** Linkable.link — an edge from this work-item to a target ObjectRef (rel blocks|relates|duplicates|fixes|…). */
/**
 * WI-4119: materialize the one-hop blocker follows for every direct subscriber
 * that opted in on `target`. The generated row points back to `target`, so an
 * unlink or blocker settlement can cancel only the derived edge. A direct
 * subscription already present on a blocker wins the unique-key race and is
 * never rewritten as derived.
 */
async function syncDerivedBlockerSubscriptions(target: ObjectRef): Promise<void> {
  const [blockers, subscribers] = await Promise.all([
    blockingLinks.listIn(target, { rel: 'blocks' }),
    subs.listTargetSubscribers('object', `${target.kind}:${target.ref}`),
  ]);
  const optedIn = subscribers.filter((row) => row.follow_blockers && !row.derived_from);
  if (!optedIn.length) return;
  const created = nowIso();
  for (const subscriber of optedIn) {
    for (const edge of blockers) {
      await subs.subscribeDerived({
        subscriber_id: subscriber.subscriber_id,
        target: edge.src,
        derived_from: target,
        delivery_mode: subscriber.delivery_mode,
        created_ts: created,
      });
    }
  }
}

/** WI-4119: clear generated rows when a direct follow is explicitly disabled. */
async function removeDerivedBlockerSubscriptionsForDependent(target: ObjectRef, subscriberId: string): Promise<void> {
  await subs.unsubscribeDerivedForDependent(subscriberId, target);
}

/** WI-4119: clear every generated row whose blocker has reached a terminal state. */
export async function removeDerivedBlockerSubscriptionsForSettledTarget(target: ObjectRef): Promise<void> {
  await subs.unsubscribeDerivedForTarget(target);
}

/** Linkable.link — an edge from this work-item to a target ObjectRef (rel blocks|relates|duplicates|fixes|…). */
export async function linkWorkItem(
  id: string,
  dst: ObjectRef,
  rel: string,
  opts: { harness?: string; by?: string; satisfaction?: 'settled' | 'success' } = {},
): Promise<{ ok: true } | { error: string }> {
  const wi = await getWorkItem(id, opts.harness);
  if (!wi) return { error: `work_item '${id}' not found` };
  if (dst.kind === FEATURE_KIND && !isQualifiedFeatureRef(dst.ref)) {
    return { error: `feature target ref must be '<harness>#<id>' (got '${dst.ref}')` };
  }
  if (wi.family === 'issue') {
    await linkIssue(id, dst, rel, opts.by, opts.satisfaction);
  } else {
    const src = workItemObjectRef(wi);
    if (rel === 'blocks' && (dst.kind === 'issue' || dst.kind === 'feature')) {
      await mirrorWorkItemBlockingEdge(src, dst, { createdBy: opts.by, satisfaction: opts.satisfaction });
    } else {
      await linkFeatureRelationBounded(src, dst, rel, opts.by);
    }
  }
  if (rel === 'blocks') await syncDerivedBlockerSubscriptions(dst);
  if (rel === 'blocks') {
    const dependentRef = await import('./work-items-events').then((m) => m.workItemIdFromRef(dst));
    if (dependentRef) {
      const dependent = await getWorkItem(dependentRef.id, dependentRef.harness);
      if (dependent?.assignee)
        dependent.interestWatch = await armWorkItemHolderInterests(dependent, dependent.assignee);
    }
  }
  return { ok: true };
}

export async function unlinkWorkItem(
  id: string,
  dst: ObjectRef,
  rel: string,
  opts: { harness?: string } = {},
): Promise<{ ok: true } | { error: string }> {
  const wi = await getWorkItem(id, opts.harness);
  if (!wi) return { error: `work_item '${id}' not found` };
  if (wi.family === 'issue') await unlinkIssue(id, dst, rel);
  else {
    const src = workItemObjectRef(wi);
    if (rel === 'blocks' && (dst.kind === 'issue' || dst.kind === 'feature')) {
      await removeMirroredWorkItemBlockingEdge(src, dst);
    } else {
      await unlinkFeatureRelationBounded(src, dst, rel);
    }
  }
  if (rel === 'blocks') await subs.unsubscribeDerivedForEdge(dst, workItemObjectRef(wi));
  // WI-4034 (the unlink gap): removing a `blocks` edge can be the dependent's
  // LAST live blocker clearing — the same condition emitWorkItemSettledEvents
  // fires `work-item:unblocked:<dst>` for when the blocker SETTLES. Before this,
  // an unlink (vs. a settle) never re-checked it, so an events:await registrant
  // silently strands to its 30-min timeout-wake. Fire-and-forget + lazy import
  // (mirrors the settle-path call above) — never blocks or fails this write.
  if (rel === 'blocks') {
    void trackDetached(import('./work-items-events')
      .then((m) => m.emitUnblockedOnEdgeRemoved(dst, id)))
      .catch(() => {});
  }
  return { ok: true };
}

/** Resolve a target work-item id to its coord ObjectRef (for cross-kind linking). */
export async function resolveWorkItemRef(targetId: string, harness?: string): Promise<ObjectRef | null> {
  const wi = await getWorkItem(targetId, harness);
  return wi ? workItemObjectRef(wi) : null;
}

/**
 * EI-18654138087054247: mirror a topic tag into the tag field the CLAIM-SPEC
 * evaluators read (`tags` column for feature-family, `payload.tags` for
 * issue-family). Without this, a tag lands ONLY in the coord tag store, which
 * neither evaluator reads — so `work_items:tag` reported ok, `work_items:get
 * { detail:true }`.topics showed the topic, and the item still failed fleet
 * admission with `fleet_scope_violation`. Shared by tag/untag AND the create
 * path, so a topic is claim-visible however it was applied.
 */
async function mirrorTopicTagToClaimTags(
  wi: WorkItem,
  topic: string,
  opts: { remove?: boolean } = {},
): Promise<TopicTagMirrorResult> {
  const { syncTopicTagToClaimTags } = await import('./work-item-topic-tags');
  const workspaceId =
    wi.family === 'issue' ? await resolveIssueWorkspace(wi.id, activeWorkspaceId()) : activeWorkspaceId();
  return await syncTopicTagToClaimTags({
    id: wi.id,
    family: wi.family,
    workspaceId,
    harness: wi.harness,
    topic,
    remove: opts.remove === true,
  });
}

/**
 * EI-18810823481386446: the topic-store write and the claim-tag mirror can now
 * DISAGREE, so the result says so. On a federated (origin='remote') row the topic
 * tag lands — that store is not origin-gated and routing a federated item to a
 * topic's subscribers is legitimate — while the claim-visible mirror is refused,
 * because the authoring peer owns that row. That is why this is `ok:true` +
 * `mirrored:false` rather than the flat refusal `work_items:update` gives: the call
 * DID do something, just not the thing a claim-spec reads. Callers steering
 * admission must branch on `mirrored`, never on `ok`.
 *
 * The origin guard itself lives in syncTopicTagToClaimTags' statement (not here),
 * so it holds for every caller of that module rather than only this path.
 */
export interface TagWorkItemResult {
  ok: true;
  /** true ⇒ the claim-spec-visible `tags` field now reflects this call. */
  mirrored: boolean;
  mirrorOutcome: TopicTagMirrorOutcome;
}

/** Taggable.addTag / removeTag (topic tags via coord_links rel='tagged'). */
export async function tagWorkItem(
  id: string,
  topic: string,
  opts: { harness?: string; by?: string } = {},
): Promise<TagWorkItemResult | { error: string }> {
  const wi = await getWorkItem(id, opts.harness);
  if (!wi) return { error: `work_item '${id}' not found` };
  if (wi.family === 'issue') await tagIssue(id, topic, opts.by);
  else await tags.addTag(workItemObjectRef(wi), topic, { created_by: opts.by, created_ts: nowIso() });
  const mirror = await mirrorTopicTagToClaimTags(wi, topic);
  return { ok: true, mirrored: mirror.mirrored, mirrorOutcome: mirror.outcome };
}
export async function untagWorkItem(
  id: string,
  topic: string,
  opts: { harness?: string } = {},
): Promise<TagWorkItemResult | { error: string }> {
  const wi = await getWorkItem(id, opts.harness);
  if (!wi) return { error: `work_item '${id}' not found` };
  if (wi.family === 'issue') await untagIssue(id, topic);
  else await tags.removeTag(workItemObjectRef(wi), topic);
  const mirror = await mirrorTopicTagToClaimTags(wi, topic, { remove: true });
  return { ok: true, mirrored: mirror.mirrored, mirrorOutcome: mirror.outcome };
}

/** Subscribable.subscribe. */
export async function subscribeWorkItem(
  subscriberId: string,
  id: string,
  mode: DeliveryMode = 'full',
  opts: { harness?: string; followBlockers?: boolean } = {},
): Promise<{ ok: true } | { error: string }> {
  const wi = await getWorkItem(id, opts.harness);
  if (!wi) return { error: `work_item '${id}' not found` };
  const target = workItemObjectRef(wi);
  await subs.subscribe({
    subscriber_id: subscriberId,
    target_kind: 'object',
    target_ref: `${target.kind}:${target.ref}`,
    delivery_mode: mode,
    follow_blockers: opts.followBlockers ?? false,
    created_ts: nowIso(),
  });
  if (opts.followBlockers) await syncDerivedBlockerSubscriptions(target);
  else await removeDerivedBlockerSubscriptionsForDependent(target, subscriberId);
  return { ok: true };
}

/** Threadable.addPost (D-003) — comment on a work-item (creates the thread on first post). */
export async function commentWorkItem(
  id: string,
  body: string,
  authorId?: string,
  opts: {
    workspaceId?: string;
    harness?: string;
    /**
     * personal-data-reader-set-labels P-012 / D-006: the agent that authored
     * `body`. While it holds a restricted Personal Vault disclosure the post is a
     * sealed stub (personal:open-sealed opens it). Pass it wherever an agent's own
     * text is posted; omit for system-templated comments.
     */
    writerOwnerId?: string | null;
  } = {},
): Promise<ThreadPostRow | null> {
  const wi = await getWorkItem(id, opts.harness);
  if (!wi) return null;
  const workspaceId = opts.workspaceId?.trim() && opts.workspaceId.trim() !== '*' ? opts.workspaceId.trim() : undefined;
  const harness = opts.harness ?? wi.harness;
  // issue-family: commentIssue already creates the thread + fires the issue_commented fan-out.
  if (wi.family === 'issue') {
    return commentIssue(id, body, authorId, { workspaceId, harness, writerOwnerId: opts.writerOwnerId });
  }
  // feature-family: thread on the feature ObjectRef + fan out to the work-item's subscribers.
  const ref = workItemObjectRef(wi);
  // Durable write (get-or-create thread + add post) in ONE bounded txn: ATOMIC
  // (post row + post_count bump commit together) + BOUNDED (SET LOCAL
  // statement_timeout) so a stalled admin-pool query fails fast + typed rather
  // than hanging the MCP call. Mirrors commentIssue. See pg-bounded-txn.ts.
  const post = await boundedOrgTxn(async (tx) => {
    const txThreads = new PgThreadStore({
      ...coordOpts,
      getSql: () => tx,
      getWorkspaceId: () => workspaceId ?? activeWorkspaceId(),
    });
    // P-012 / D-006: seal in THIS transaction, so the sealed row and its stub post
    // commit together and the authored text never reaches coord_thread_posts.
    const stored = opts.writerOwnerId?.trim()
      ? await sealSharedTextInTxOrRefuse(tx, {
          workspaceId: workspaceId ?? activeWorkspaceId(),
          writerOwnerId: opts.writerOwnerId,
          store: 'work-item-comment',
          text: body,
          context: { workItemId: id },
        })
      : null;
    const thread = await txThreads.getOrCreateThread(ref, {
      thread_id: `work-item-thread-${id}`,
      title: wi.title,
      created_by: authorId ?? undefined,
      created_ts: wi.createdAt,
      harness_slug: harness ?? undefined,
    });
    return txThreads.addPost({ thread_id: thread.thread_id, author_id: authorId, body: stored?.text ?? body, created_ts: nowIso() });
  });
  const ev: InjectEvent = {
    from: authorId ?? 'substrate',
    subject: `${FEATURE_KIND}:${ref.ref}`,
    summary: `work_item ${id} — new comment${authorId ? ` from ${authorId}` : ''}`,
    notify_kind: 'work_item_commented',
  };
  await fanoutForObject(ref, ev, { excludeId: authorId });
  return post;
}

/** The mutable fields a work-item field-edit can touch. Goal attribution is shared by
 * both families; the remaining metadata fields are issue-family-only. */
export interface UpdateWorkItemPatch {
  title?: string;
  body?: string;
  severity?: IssueSeverity;
  kind?: IssueKind;
  foundDuring?: string | null;
  linkedFeatureId?: string | null;
  /** Parent work-item id for issue-family duplicate/child relationships; null clears it. */
  parent?: string | null;
  /** WI-37892 — adopt this existing item into a goal's drain lane, or clear with null. */
  goal?: string | null;
  /** EI-8497: bypass the fat-finger body-shrink guard (see updateIssue) — pass true
   *  when a large reduction in body length is genuinely intended. */
  confirmShrink?: boolean;
}

type WorkItemGoalIdentity =
  | { family: 'issue'; kind: IssueKind }
  | { family: 'feature'; harness: string | null }
  | { family: 'source'; harness: string };

/** The one base-table writer for `work_items.goal_id`. Issue-family's compat view
 * deliberately preserves this column on UPDATE, so every path uses this writer. */
async function writeWorkItemGoalColumn(
  sql: GoalSqlTag,
  opts: {
    id: string;
    workspaceId: string | null;
    goal: string | null;
    identity: WorkItemGoalIdentity;
    /** When supplied, compare-and-set this exact prior value (including null). */
    expectedGoalId?: string | null;
  },
): Promise<boolean> {
  const identityWhere = opts.identity.family === 'issue'
    ? sql`item_kind = ${opts.identity.kind}`
    : sql`harness_slug = ${opts.identity.harness}`;
  const expectedWhere = opts.expectedGoalId !== undefined
    ? sql`AND goal_id IS NOT DISTINCT FROM ${opts.expectedGoalId}`
    : sql``;
  const rows = await sql<{ feature_id: string }[]>`
    UPDATE harness_shared.work_items
       SET goal_id = ${opts.goal}, updated_ts = ${Date.now()}
     WHERE workspace_id = ${opts.workspaceId}
       AND feature_id = ${opts.id}
       AND ${identityWhere}
       ${expectedWhere}
     RETURNING feature_id`;
  return rows.length > 0;
}

/** Persist goal attribution through the canonical base-table writer. */
async function updateWorkItemGoal(id: string, wi: WorkItem, goal: string | null): Promise<WorkItem | null> {
  const sql = getOrgPg().sql as unknown as GoalSqlTag;
  const workspaceId = wi.family === 'issue' ? issuesScopeWorkspace() : activeWorkspaceId();
  const written = await writeWorkItemGoalColumn(sql, {
    id,
    workspaceId,
    goal,
    identity: wi.family === 'issue'
      ? { family: 'issue', kind: wi.kind as IssueKind }
      : { family: 'feature', harness: wi.harness },
  });
  if (!written) return null;
  return getWorkItem(id, wi.family === 'feature' ? (wi.harness ?? undefined) : undefined);
}

export type GoalStartWorkItemStampResult =
  | { ok: true; changed: boolean }
  | { ok: false; reason: 'not_found' | 'wrong_harness' | 'already_attributed' | 'changed' };

/** Attribute a goal's explicit source item before its goal-drain fleet is minted.
 * The caller supplies its goal SQL handle; the conditional UPDATE is the actual
 * compare-and-set, so concurrent autocommit callers cannot both claim a NULL goal_id.
 * This deliberately refuses cross-harness links and never reparents an item already
 * owned by another goal. */
export async function stampWorkItemGoalAtStart(
  tx: GoalSqlTag,
  opts: { id: string; workspaceId: string; harness: string; goalId: string },
): Promise<GoalStartWorkItemStampResult> {
  const rows = await tx<{ goal_id: string | null; harness_slug: string | null }[]>`
    SELECT goal_id, harness_slug
      FROM harness_shared.work_items
     WHERE workspace_id = ${opts.workspaceId} AND feature_id = ${opts.id}
     FOR UPDATE`;
  const existing = rows[0];
  if (!existing) return { ok: false, reason: 'not_found' };
  if (existing.harness_slug !== opts.harness) return { ok: false, reason: 'wrong_harness' };
  if (existing.goal_id === opts.goalId) return { ok: true, changed: false };
  if (existing.goal_id !== null) return { ok: false, reason: 'already_attributed' };

  const changed = await writeWorkItemGoalColumn(tx, {
    id: opts.id,
    workspaceId: opts.workspaceId,
    goal: opts.goalId,
    identity: { family: 'source', harness: opts.harness },
    expectedGoalId: null,
  });
  return changed ? { ok: true, changed: true } : { ok: false, reason: 'changed' };
}

/** Compensate a source-item stamp if goals:start later has to roll the goal back.
 * The compare-and-set ensures the rollback never clears a newer/different attribution. */
export async function clearWorkItemGoalAtStart(
  tx: GoalSqlTag,
  opts: { id: string; workspaceId: string; harness: string; goalId: string },
): Promise<boolean> {
  return writeWorkItemGoalColumn(tx, {
    id: opts.id,
    workspaceId: opts.workspaceId,
    goal: null,
    identity: { family: 'source', harness: opts.harness },
    expectedGoalId: opts.goalId,
  });
}

function hasIssueFieldPatch(patch: UpdateWorkItemPatch): boolean {
  return (
    patch.title !== undefined ||
    patch.body !== undefined ||
    patch.severity !== undefined ||
    patch.kind !== undefined ||
    patch.foundDuring !== undefined ||
    patch.linkedFeatureId !== undefined ||
    patch.parent !== undefined
  );
}

/**
 * Field-edit a work-item's mutable metadata (title / body / severity / kind /
 * found-during / linked-feature / goal). Replaces the retired issues:update onto the
 * unified work_items surface. Dispatches by family:
 *   - issue-family (bug | change | task) → engineer-issues updateIssue (notifies subs).
 *   - feature-family (feature | research-task | chunk) → goal-only updates are supported;
 *     other fields remain owned by the pipeline (scoper/architect), not direct edits.
 * Returns the refreshed WorkItem on success, or a typed reason on failure — including
 * `body_shrink_guard` (EI-8497) when the edit would replace a substantial existing
 * body with something far shorter and the caller didn't pass `confirmShrink`.
 */
export async function updateWorkItem(
  id: string,
  patch: UpdateWorkItemPatch,
  by?: string,
  opts: { harness?: string } = {},
): Promise<
  | { ok: true; item: WorkItem }
  | { ok: false; reason: 'not_found' | 'unsupported_family' | 'remote_origin_not_editable' }
  | { ok: false; reason: 'body_shrink_guard'; existingLength: number; newLength: number }
> {
  const wi = await getWorkItem(id, opts.harness);
  if (!wi) return { ok: false, reason: 'not_found' };
  // Goal attribution is the one shared field that can be edited on a feature-family
  // item. Keep every other feature metadata edit on the existing pipeline-owned path.
  if (wi.family !== 'issue') {
    if (hasIssueFieldPatch(patch) || patch.goal === undefined) return { ok: false, reason: 'unsupported_family' };
    const updated = await updateWorkItemGoal(id, wi, patch.goal);
    return updated ? { ok: true, item: updated } : { ok: false, reason: 'not_found' };
  }
  const issueWorkspaceId = await resolveIssueWorkspace(id);
  const issueSlug = await resolveIssuePhysicalSlug(
    getOrgPg().sql,
    issueWorkspaceId,
    id,
    opts.harness ?? wi.harness,
  );
  if (issueSlug === null) return { ok: false, reason: 'not_found' };
  // EI-14948: a federated (origin='remote') issue-family row is owned by its authoring
  // peer's core — the engineer_issues view's INSTEAD OF trigger (516/521) deliberately
  // no-ops a local UPDATE against it and reports 0 rows affected (RETURN NULL) so the
  // caller doesn't get a false-success. Left unhandled, that NULL propagated all the way
  // out as the generic 'not_found' reason below — even though getWorkItem (called one
  // line above, and by work_items:get / work_items:comment) resolves the SAME id fine —
  // a misleading "not found" for a row that plainly exists. Detect it BEFORE attempting
  // the write (mirrors the identical guard in setWorkItemState / work_items:complete) so
  // the caller gets an honest, specific reason instead.
  //
  // EI-19313515375179600 (WI-6822 follow-up): `origin` can flip local→remote well after
  // creation. When the caller IS the recorded author, self-heal the base-table origin
  // back to 'local' first (see selfHealAuthorOriginIfStranded's docblock) so the write
  // that follows isn't ALSO silently blocked by the same trigger.
  if (wi.origin === 'remote' && by && wi.createdBy && by === wi.createdBy) {
    const healed = await selfHealAuthorOriginIfStranded(id, by, {
      workspaceId: issueWorkspaceId,
      harnessSlug: issueSlug,
    });
    if (healed) wi.origin = 'local';
  }
  // WI-10006515: the same own-node rule setWorkItemState applies (WI-10003565). A row whose
  // author key THIS workspace has written locally is ours however it last arrived, so a
  // system-filed row (createdBy="system:*", which no caller can match) is healed, not refused.
  // The UPDATE's WHERE clause is the identity check; a true peer row is left untouched.
  if (wi.origin === 'remote' && (await selfHealOwnNodeOriginIfStranded(issueWorkspaceId, id, issueSlug))) {
    wi.origin = 'local';
  }
  if (wi.origin === 'remote') return { ok: false, reason: 'remote_origin_not_editable' };
  // `goal` is written against the base table after the issue-family metadata update:
  // the compat view's trigger deliberately does not carry NEW.goal_id, so including it
  // in the view patch would be a silent no-op. Destructuring also keeps the issue writer's
  // patch contract honest and makes this separation compile-time visible.
  const { goal, ...issuePatch } = patch;
  const issue = await updateIssue(id, { ...issuePatch, by }, {
    workspaceId: issueWorkspaceId,
    harnessSlug: issueSlug,
  });
  if (issue === null) return { ok: false, reason: 'not_found' };
  if ('shrinkGuardTripped' in issue) {
    return { ok: false, reason: 'body_shrink_guard', existingLength: issue.existingLength, newLength: issue.newLength };
  }
  if (goal !== undefined) {
    const updated = await updateWorkItemGoal(id, wi, goal);
    return updated ? { ok: true, item: updated } : { ok: false, reason: 'not_found' };
  }
  const refreshed = await getWorkItem(id, opts.harness);
  return refreshed ? { ok: true, item: refreshed } : { ok: false, reason: 'not_found' };
}

export interface PromoteToPipelineResult {
  workItem: WorkItem;
  feature: { id: string; title: string };
}

/**
 * promote-to-pipeline — give a non-pipeline work-item (a filed bug/change) a feature
 * pipeline run, by minting an F-FIX feature (reusing issues:promote's mintFixFeatureRow)
 * and linking it. A feature-family work-item already IS a pipeline item — no-op.
 */
export async function promoteToPipeline(
  id: string,
  opts: { harness?: string; actor?: string } = {},
): Promise<PromoteToPipelineResult | { error: string }> {
  const wi = await getWorkItem(id, opts.harness);
  if (!wi) return { error: `work_item '${id}' not found` };
  if (wi.family === 'feature') {
    return { error: `work_item '${id}' (kind=${wi.kind}) is already a pipeline work-item` };
  }
  const res = await promoteIssue(id, { harness: opts.harness, actor: opts.actor });
  if ('error' in res) return res;
  return { workItem: issueToWorkItem(res.issue), feature: res.feature };
}

/** Outcome of binding an existing work-item to an owner directive. */
export type BindDirectiveRefResult =
  | { ok: true; changed: boolean }
  | { ok: false; error: 'not_found' }
  | { ok: false; error: 'directive_ref_conflict'; existing: number };

/**
 * Bind an EXISTING work-item to the owner directive it is carrying out
 * (directive-visibility-and-ownership-2026-09-22, P-005).
 *
 * `work_items:create { directiveRef }` covers the case where the work-item is
 * minted for the directive. This covers the other half the plan names: an item
 * that already exists and is being CLAIMED to carry a directive out. Both write
 * the same column; neither ever writes the directive row (D-005).
 *
 * WRITE-ONCE, NEVER OVERWRITE. The guarded `IS NULL` makes the first bind win
 * and a re-bind to the SAME id a no-op success (`changed:false`), while a bind
 * to a DIFFERENT id is refused rather than silently rewriting provenance. That
 * asymmetry is the point: provenance whose value can change under a later
 * caller is not provenance, and a conflicting bind is a real signal — two
 * directives both believing they own one item — that a silent overwrite would
 * destroy.
 */
export async function bindWorkItemDirectiveRef(
  workspaceId: string,
  workItemId: string,
  directiveRef: number,
): Promise<BindDirectiveRefResult> {
  const { sql } = getOrgPg();
  const rows = (await sql`
    UPDATE harness_shared.work_items
       SET directive_ref = ${directiveRef}
     WHERE workspace_id = ${workspaceId}
       AND feature_id = ${workItemId}
       AND directive_ref IS NULL
 RETURNING feature_id
  `) as unknown as Array<{ feature_id: string }>;
  if (rows.length > 0) return { ok: true, changed: true };
  // Nothing updated: either the row does not exist, or it already carries a ref.
  // Those are different answers and the caller acts differently on each, so read
  // the row rather than collapsing both into one failure.
  const existing = (await sql`
    SELECT directive_ref
      FROM harness_shared.work_items
     WHERE workspace_id = ${workspaceId}
       AND feature_id = ${workItemId}
     LIMIT 1
  `) as unknown as Array<{ directive_ref: string | number | null }>;
  if (existing.length === 0) return { ok: false, error: 'not_found' };
  // postgres.js returns bigint as a STRING — compare as numbers, or an
  // idempotent re-bind reads as a conflict.
  const held = existing[0].directive_ref == null ? null : Number(existing[0].directive_ref);
  if (held === directiveRef) return { ok: true, changed: false };
  // `held === null` here means the row lost a race between the two statements;
  // report it as a conflict rather than inventing a value we did not observe.
  return { ok: false, error: 'directive_ref_conflict', existing: held ?? directiveRef };
}

/** One work-item carrying `directive_ref`, projected to exactly what the
 *  directive-status derivation consumes. */
export interface DirectiveLinkedWorkItemRow {
  directiveRef: number;
  id: string;
  state: string;
  assignee: string | null;
}

/**
 * Every work-item pointing back at one of `directiveIds`
 * (directive-visibility-and-ownership-2026-09-22, P-005/P-006).
 *
 * DELIBERATELY NOT ROUTED THROUGH `FEATURE_COLS` / `featureRowToWorkItem`. Those
 * carry a documented parity contract with the claim-spec evaluator's FIELD_MAP,
 * and widening them for a field the evaluator never filters on would put a
 * guarded invariant at risk to serve a read that needs three columns. This
 * projects only what `deriveDirectiveStatus` consumes, so nothing downstream can
 * come to depend on a shape this query does not promise.
 *
 * BATCHED BY DESIGN: the caller renders N directives per turn on the turn-start
 * hot path, under a hard wall. One query for the whole banner, never one per row.
 *
 * Returns ALL linked rows including terminal ones — the derivation, not this
 * reader, decides what terminal means. A reader that pre-filtered to live rows
 * would silently destroy the `workedButUndispositioned` distinction, and it
 * would do so invisibly, since the verdict would still be `unclaimed`.
 */
export async function listWorkItemsByDirective(
  workspaceId: string,
  directiveIds: readonly number[],
): Promise<DirectiveLinkedWorkItemRow[]> {
  if (directiveIds.length === 0) return [];
  const { sql } = getOrgPg();
  const rows = (await sql`
    SELECT directive_ref, feature_id, status, taken_by
      FROM harness_shared.work_items
     WHERE workspace_id = ${workspaceId}
       AND directive_ref = ANY(${directiveIds as number[]}::bigint[])
     ORDER BY directive_ref, created_ts
  `) as unknown as Array<{
    directive_ref: string | number;
    feature_id: string;
    status: string;
    taken_by: string | null;
  }>;
  return rows.map((r) => ({
    // postgres.js returns bigint as a STRING; the caller keys a Map by this, so a
    // mixed string/number key set would silently miss every lookup.
    directiveRef: Number(r.directive_ref),
    id: r.feature_id,
    state: r.status,
    assignee: r.taken_by ?? null,
  }));
}
