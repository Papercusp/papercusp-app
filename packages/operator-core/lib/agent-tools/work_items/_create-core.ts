/**
 * _create-core — the per-item work-item CREATION core, extracted from
 * `work_items/create.ts` WITHOUT behavior change (work-queue-completeness Phase B,
 * unified-work-item-ledger). `work_items:create` is now dual-arity
 * (bulk-endpoint-standardization-2026-06-21 P-002): its single-spec path and its
 * `items:[…]` bulk loop both call `createOneWorkItem` so the mirror-guard, workspace
 * resolution, and hive-scope gate are applied IDENTICALLY per item. (This core is
 * what let the old `work_items:create_batch` multiplexer fold back into create.)
 *
 * It performs (in order, exactly as create.ts did inline):
 *   1. EI-316 mirror-duplicate guard (flag-gated) — refuse a title embedding an OPEN id.
 *   2. EI-728 workspace resolution — explicit arg → ctx.workspaceId (concrete) → undefined.
 *   3. D-019/D-020 hive-scope gate — a pipeline kind must resolve to a hive.
 *   4. createWorkItem incl. the B-LOOP-4 atomic create+claim (assignee/assignedBy).
 *
 * Returns a discriminated result so the caller maps it onto its own envelope —
 * `{ ok: true, workItem }` or `{ ok: false, error, message?, existing? }`. It does
 * NOT throw; createWorkItem rejections are caught and returned as `{ ok: false }`.
 */
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { createWorkItem, getWorkItem, linkWorkItem, resolveWorkItemRef, isWorkItemKind, isDeprecatedWorkItemKind, setWorkItemState, ensureClaimHoldAttribution, familyOf, type WorkItem, type WorkItemKind } from '../../work-items';
import { planItemRef, PLAN_ITEM_KIND } from '../../issue-blocks-merge';
import type { PlanItemStamp } from '../../plan-items/convert';
import { findMirroredOpenItem } from './mirror-guard';
import { findSemanticDupes, type SemanticDupeCandidate } from './semantic-dupe-guard';
import { reportSemanticDedupProbeUnavailable } from './semantic-dedup-probe-alarm';
import { findRecentLexicalDupes } from './recent-lexical-dupe-guard';
import { findFulltextLexicalDupes } from './fulltext-lexical-dupe-guard';
import { persistDedupEdges } from './dedup-edges';
import type { DedupCandidateStamp } from './dedup-candidates-stamp';
import { resolvePotScope, POT_REQUIRED_DETAIL } from '../_pot-scope';
import { resolveConcreteHarnessSlug } from '../_harness-scope';
import { getOrgPg } from '@papercusp/db-org';
// The goal-provenance stamp is SHARED with improvements:capture (WI-2140701 (b)):
// every door that mints a work-item row stamps goal_id the same way.
import { stampGoalProvenance } from '../../goals/provenance-stamp';
import { getGenericKindDatatype } from '../../datatype-registry-store';
import { validateDatatypePayload } from '../../datatype-payload-validation';
import { matchRoutingGateHint, type RoutingGateIntent } from '../../routing-gate-hints';
import { loadHarnessRegistry, resolveHarnessContentPath } from '../../harness-registry';
import { discoverKnownHiveCheckoutRoots } from '../testing/run';
import { selectUnambiguousEvidenceRoot, type EvidenceRootCandidate } from '../../evidence-root-selection';
import {
  deriveRepoPathsFromText,
  explicitRepoPathsWarning,
  validateExplicitRepoPaths,
} from './_derive-paths';
import { resolveAgentWorkspaceRoot } from '../capability/base-dir';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { admissionIdentity, type AdmissionIdentity } from '../../harness/improvements/digest';
import { ANY_FAMILY_TERMINAL_STATES } from '../../work-item-dispatch-states';
import type { AdmissionBypassReason } from '../../work-items-admission';
import {
  adoptConditionIncumbent,
  settleConditionClaim,
  CONDITION_UPSERT_MARKER,
} from '../../coord/condition-upsert';
import {
  decideIssueAdmissionCircuit,
  readIssueAdmissionPressure,
  recordIssueOccurrence,
  selectCanonicalIssue,
  type IssueAdmissionPressure,
  type IssueOccurrenceKind,
} from '../../issue-occurrence-ledger';

/**
 * PIPELINE work-item kinds that belong to a HIVE's fleet queue (D-020): a fresh one
 * must resolve to a hive (auto-resolve-then-require). Issue kinds (bug/change) are
 * deliberately EXCLUDED — they may stay workspace-global (the issues surface).
 */
export const HIVE_GATED_KINDS: ReadonlySet<string> = new Set(['feature', 'chunk']);

/** One per-item create spec — the shared shape `create.ts` accepts (single + items[]). */
export interface CreateOneWorkItemArgs {
  kind: string;
  title: string;
  summary?: string;
  harness?: string;
  pot?: string;
  workspace?: string;
  severity?: 'critical' | 'major' | 'minor' | 'nit';
  parent?: string;
  topics?: string[];
  payload?: Record<string, unknown>;
  /** Explicit papercusp-way routing row; body prose is never classified. */
  routing_intent?: RoutingGateIntent;
  /** Required for routing_intent='schedule-recurrence'. */
  cadence?: string;
  urgent?: boolean;
  force?: boolean;
  /** Internal DRAIN rail derived by the tool handler from live mode state. */
  requireCompleteDedupCoverage?: boolean;
  /** Internal GOAL rail (P-004, goal-mode-design-intent-hardening-2026-08-16),
   *  derived by the tool handler from the creator's RESOLVED goal context — never a
   *  tool argument (same operative rule as requireCompleteDedupCoverage above and
   *  the goal-provenance stamps: self-report is what this replaces). When set, the
   *  dedup probes run even under force:true, and a create whose SEMANTIC leg is
   *  down fails CLOSED ('dedup_unavailable') unless force is passed — the WI-39373
   *  relapse was exactly a goal-mode create failing OPEN on a down semantic leg. */
  goalDedupGate?: boolean;
  /** Atomic create+claim target (B-LOOP-4): the agent id to own the new item. */
  assign_to?: string;
  /**
   * Server-derived admission reason for a create whose requested assignment was
   * deliberately removed at the fleet-scope seam. This preserves the explicit
   * assignment's born-admitted property without granting the out-of-scope claim;
   * only the create tool handler sets it after the admission check succeeds.
   */
  admissionBypass?: AdmissionBypassReason;
  /**
   * EI-10897: initial lifecycle state — e.g. `wip` for an ad-hoc unit the creator is
   * starting right now (the shape the su persona already prescribes:
   * `{ title, assign_to:'self', state:'wip' }`). Applied as a transition immediately
   * after the create, so it flows through the normal state machine + its fan-out
   * rather than writing a raw status column. Terminal states are refused at the tool
   * boundary (they would bypass the completion-integrity gate).
   */
  state?: string;
  /** Forward edge (plan-item-coverage): the plan item this work-item ADDRESSES.
   *  Writes a coord_links work→plan_item `relates` edge on create, so the item
   *  rolls up into that plan item's coverage and `plans:items` stops showing it as
   *  unworked. Non-fatal — an edge failure never blocks the create. */
  targetPlanItem?: { slug: string; itemId: string };
  /** Inline typed links (WI-3956): edges written from the NEW work-item to targets
   *  right after creation — the general form of `targetPlanItem` (the plan-coverage
   *  special case). Each targets another work-item (target_id) OR any coord ObjectRef
   *  (target_kind + target_ref, e.g. an event key or plan_item). Best-effort + non-fatal,
   *  exactly like the plan-coverage edge: a bad/unresolvable target is skipped and never
   *  turns a successful create into an error (the manual work_items:link path stays
   *  available to retry). The tool layer (work_items:create) pins `rel` to the LINK_RELS
   *  vocabulary; the core stays permissive (rel: string), mirroring linkWorkItem. */
  links?: Array<{ rel: string; target_id?: string; target_kind?: string; target_ref?: string; target_harness?: string; satisfaction?: 'settled' | 'success' }>;
  /** WI-39604: recurring-detector filing identity. When set, the create routes
   *  through the WI-39594 condition upsert: an OPEN item already holding this key
   *  is refreshed (title/summary → this reading, occurrence bump) and returned
   *  instead of a sibling being filed, and a fresh mint claims the key under
   *  migration 741's unique index (lost race ⇒ adopt the winner, settle our row).
   *  For single-host system filers (gates, routines, seeders) — NOT for producers
   *  whose rows federate in from other machines (see condition-upsert.ts header). */
  conditionKey?: string;
  /**
   * Owner-directive provenance (directive-visibility-and-ownership-2026-09-22,
   * P-005): `harness_shared.owner_directives.id` this work-item is being created
   * to carry out. LATE-BINDING and one-directional — the directive exists first
   * and is never written back (D-005), so the reference rides in on the INSERT
   * of the row that is created second.
   *
   * Omit ⇒ NULL, which is the DEFAULT and the common case: a directive is
   * visible and actionable long before any work-item exists, so zero linked
   * work-items is a healthy directive, never a degenerate one.
   */
  directiveRef?: number | null;
}

/** The acting agent identity the core needs (resolved by the caller from ctx). */
export interface CreateOneWorkItemCtx {
  /** The creator's owner id (resolveAgentIdentity(ctx).ownerId). */
  ownerId: string;
  /** The request's concrete workspace (ctx.workspaceId) — '*' / undefined = none. */
  workspaceId?: string | null;
  /** The acting session's harness (ctx.harnessSlug) — used to auto-resolve the hive. */
  harnessSlug?: string | null;
  /** The acting session's project tree, used to validate auto-derived repo paths. */
  projectDir?: string;
}

export interface WorkItemDedupCoverage {
  lexical: 'ok' | 'unavailable' | 'skipped';
  semantic: 'ok' | 'unavailable' | 'skipped';
  degraded: boolean;
}

export type CreateOneWorkItemResult =
  | {
      ok: true;
      workItem: WorkItem;
      /** P-002 (work-queue-admission-and-bulk-dedup-2026-08-24), item d: how many
       *  prescreen similarity edges this create persisted into
       *  `harness_shared.dedup_edges`.
       *
       *  This REPLACED the advisory `similarOpen` list that a SUCCESSFUL create used
       *  to return. Under born-pending admission the caller is no longer the thing
       *  that adjudicates duplication — the P-003 promoter is — so the candidates go
       *  where the promoter reads them instead of into a tool result nobody acts on.
       *  `similarOpen` remains on the REFUSAL branch below, where it is load-bearing:
       *  it names the item the caller should work instead. */
      dedupEdges?: number;
      /** EI-10897: set when `state` was requested but the follow-on transition did not
       *  apply. The item EXISTS (ok:true) — this reports the state write's failure loudly
       *  instead of letting it be a silent no-op. Retry with work_items:set_state. */
      stateError?: string;
      /** The goal this item was attributed to, when the ambient goal context resolved
       *  AND the stamp landed. ABSENT is the common, correct case (most agents are not
       *  running under a goal) — which is exactly why its failure needs its own field
       *  below rather than being inferred from this one's absence.
       *  (Returned at runtime since P-002; declared here by EI-20075667133396690, which
       *  is also why goal-provenance-stamp.integration.test.ts had to cast to read it.) */
      goalId?: string;
      /** EI-20075667133396690: set when the goal-provenance stamp THREW. The creation
       *  still succeeded (ok:true) — the stamp is a best-effort decoration and failing a
       *  creation because provenance could not be recorded would be worse. But a thrown
       *  stamp must not look like one that correctly DECLINED: declining is the
       *  overwhelming majority case, so a silently-broken UPDATE would hide inside it
       *  forever. Mirrors `degradedReasons` in goal-launch-settings.ts. */
      goalStampError?: string;
      admissionIdentity?: AdmissionIdentity;
      dedupCoverage?: WorkItemDedupCoverage;
      /** P-005 exact rolling pressure observation when a soft canonical candidate
       *  made the queue-admission circuit relevant to this create. */
      queueAdmission?: IssueAdmissionPressure;
      /** EI-20191260047847804: explicit payload.paths that could not be resolved
       *  against the selected project tree. Warn-only; the item was still created. */
      explicitPathsWarning?: string;
      /** Inline links are best-effort, but a schema-valid link with an unsupported
       *  satisfaction requirement must not disappear silently. The edge is retained
       *  when its relation is otherwise valid and this carries the per-link warning. */
      inlineLinkWarnings?: string[];
      /** WI-39604: set when `conditionKey` resolved to an OPEN incumbent —
       *  `workItem` is that incumbent (refreshed to this reading), NOT a new row.
       *  `duplicateLeftOpen` reports a lost-race stand-down that failed. */
      conditionUpsert?: { adopted: true; id: string; duplicateLeftOpen?: string };
    }
  | {
      ok: false;
      error: string;
      message?: string;
      existing?: { id: string; state: string };
      /** dedup refusals: the OPEN items the new title cosine-matched. */
      similarOpen?: SemanticDupeCandidate[];
      admissionIdentity?: AdmissionIdentity;
      dedupCoverage?: WorkItemDedupCoverage;
      /** P-005: present on a losslessly coalesced low-diversity burst report. */
      queueAdmission?: IssueAdmissionPressure;
    };

/**
 * EI-18816637571744179: does this create DECLARE a relationship to the item its
 * title names?
 *
 * The EI-316 guard below keys on "the title names an open work-item id", which
 * is a genuine accidental-mirror signal — but it is equally the signature of a
 * FOLLOW-UP naming its parent for lineage, which is the opposite thing. A mirror
 * duplicates a parent's scope; a follow-up records the scope the parent
 * deliberately excluded, and is typically filed exactly when the parent is being
 * CLOSED, so the guard's "work that item directly" advice is then not merely
 * unhelpful but impossible.
 *
 * An explicit typed link to that same id is the discriminator, and it was
 * already on the call: writing one is a deliberate act that demonstrates the
 * author knows the item exists, which is precisely what an ACCIDENTAL mirror
 * does not.
 *
 * `duplicates` is excluded on purpose — "this duplicates WI-9" is the very
 * condition the guard names, so it must not be the thing that switches it off.
 */
function hasDeclaredLineageTo(
  links: CreateOneWorkItemArgs['links'],
  id: string,
): boolean {
  const target = id.trim().toLowerCase();
  return (links ?? []).some(
    (l) => l.rel !== 'duplicates' && (l.target_id ?? '').trim().toLowerCase() === target,
  );
}

export type ExplicitRepoPathRootSource = 'caller-workspace' | 'target-harness' | 'hive-checkout';

export interface SelectedExplicitRepoPathRoot {
  root: string;
  source: ExplicitRepoPathRootSource;
}

function explicitPathsResolveAtRoot(paths: readonly string[], root: string): boolean {
  try {
    if (!statSync(root).isDirectory()) return false;
  } catch {
    return false;
  }
  return validateExplicitRepoPaths(paths, { repoRoot: root }) === undefined;
}

/**
 * Select the tree used by the explicit-path advisory. A concrete target harness
 * owns the evidence when the caller names one; the ambient caller tree is only
 * the preferred tree when no target can be resolved. If a registered target path
 * is stale, exactly one discovered Hive checkout may recover it. Ambiguity never
 * chooses a tree, and the returned fallback keeps the old warn-only behavior.
 */
export async function selectExplicitRepoPathRoot(
  paths: readonly string[],
  ctx: CreateOneWorkItemCtx,
  requestedHarness?: string | null,
): Promise<SelectedExplicitRepoPathRoot> {
  const ambientRoot = resolveAgentWorkspaceRoot(ctx);
  const targetHarness = resolveConcreteHarnessSlug(requestedHarness, ctx);
  let targetRoot: string | undefined;

  if (targetHarness) {
    try {
      const registry = await loadHarnessRegistry(
        ctx.workspaceId && ctx.workspaceId !== '*' ? ctx.workspaceId : undefined,
      );
      targetRoot = resolveHarnessContentPath(registry, targetHarness);
    } catch {
      // Registry access is advisory here; discovered roots and the caller tree
      // still provide safe, fail-open behavior for creation.
    }
  }

  const preferred: EvidenceRootCandidate<ExplicitRepoPathRootSource> = targetRoot
    ? { root: targetRoot, source: 'target-harness' }
    : { root: ambientRoot, source: 'caller-workspace' };
  const discovered: EvidenceRootCandidate<ExplicitRepoPathRootSource>[] = targetHarness
    ? discoverKnownHiveCheckoutRoots().map((root) => ({ root, source: 'hive-checkout' }))
    : [];
  const selected = selectUnambiguousEvidenceRoot({
    preferred,
    candidates: discovered,
    resolvesEvery: (root) => {
      // When a target was requested but its registry path is unavailable, the
      // ambient root is not evidence for that target. Let a discovered checkout
      // win, or fall back to the ambient tree only after selection fails.
      if (targetHarness && !targetRoot && resolve(root) === resolve(ambientRoot)) return false;
      return explicitPathsResolveAtRoot(paths, root);
    },
  });
  return selected ?? (targetRoot ? preferred : { root: ambientRoot, source: 'caller-workspace' });
}

/**
 * Create ONE work-item, applying the mirror-guard + workspace resolution + hive-scope
 * gate, then the createWorkItem call (incl. the atomic create+claim). Never throws.
 */
function workItemOccurrenceEvidence(
  args: CreateOneWorkItemArgs,
  similarOpen: readonly SemanticDupeCandidate[] | undefined,
  dedupCoverage: WorkItemDedupCoverage | undefined,
  queueAdmission?: IssueAdmissionPressure,
): Record<string, unknown> {
  return {
    kind: args.kind,
    summary: args.summary ?? null,
    severity: args.severity ?? null,
    parent: args.parent ?? null,
    topics: args.topics ?? [],
    payload: args.payload ?? null,
    urgent: args.urgent ?? false,
    force: args.force ?? false,
    assignTo: args.assign_to ?? null,
    similarOpen: similarOpen ?? [],
    dedupCoverage: dedupCoverage ?? null,
    ...(queueAdmission ? { queueAdmission } : {}),
  };
}

/** Occurrence evidence never changes the create verdict. The shared recorder
 * is already fail-open; the catch also protects mocked/alternate recorders. */
async function appendWorkItemOccurrence(
  args: CreateOneWorkItemArgs,
  ctx: CreateOneWorkItemCtx,
  identity: AdmissionIdentity,
  reportKind: IssueOccurrenceKind,
  canonicalId: string,
  canonicalHarness: string | null | undefined,
  similarOpen?: readonly SemanticDupeCandidate[],
  dedupCoverage?: WorkItemDedupCoverage,
  queueAdmission?: IssueAdmissionPressure,
): Promise<void> {
  await recordIssueOccurrence({
    canonicalId,
    ...(canonicalHarness ? { canonicalHarness } : {}),
    reporter: ctx.ownerId,
    sourceTool: 'work_items:create',
    reportKind,
    reportedTitle: args.title,
    evidence: workItemOccurrenceEvidence(args, similarOpen, dedupCoverage, queueAdmission),
    admissionIdentity: identity,
  }).catch(() => null);
}

interface PlanItemIdentity {
  planSlug: string;
  itemId: string;
}

interface PlanItemCollisionRow {
  feature_id: string;
  status: string;
}

interface FleetScopeDowngradeMarker {
  requestedAssignee: string;
  reportedBy: string;
  fleet: string;
  code: string;
  at: string;
}

interface PendingAdmissionRepairRow {
  feature_id: string;
}

function readPlanItemIdentity(raw: unknown): PlanItemIdentity | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const planSlug = typeof value.plan_slug === 'string' ? value.plan_slug.trim() : '';
  const itemId = typeof value.item_id === 'string' ? value.item_id.trim() : '';
  return planSlug && itemId ? { planSlug, itemId } : null;
}

/**
 * D-046: one live work-item per plan lane. Promoted rows prove the lane through
 * source_plan_slug/source_plan_item_ids, while ad-hoc rows use payload.plan_item as
 * their only durable stamp. Read both before INSERT so a caller-supplied stamp cannot
 * bypass the canonical plan-link path. The terminal predicate deliberately preserves
 * history: a finished row does not prevent a later follow-up from addressing a lane.
 */
async function findOpenPlanItemCollision(
  workspaceId: string | undefined,
  identities: readonly PlanItemIdentity[],
): Promise<PlanItemCollisionRow | null> {
  if (!workspaceId || identities.length === 0) return null;

  const { sql } = getOrgPg();
  const matches = identities.map(({ planSlug, itemId }) => sql`(
    (
      NULLIF(btrim(wi.source_plan_slug), '') IS NOT NULL
      AND EXISTS (
        SELECT 1
          FROM unnest(COALESCE(wi.source_plan_item_ids, ARRAY[]::text[])) AS source_item(item_id)
         WHERE btrim(source_item.item_id) <> ''
      )
      AND btrim(wi.source_plan_slug) = ${planSlug}
      AND EXISTS (
        SELECT 1
          FROM unnest(COALESCE(wi.source_plan_item_ids, ARRAY[]::text[])) AS source_item(item_id)
         WHERE btrim(source_item.item_id) = ${itemId}
      )
    )
    OR (
      wi.payload->'plan_item' IS NOT NULL
      AND wi.payload->'plan_item'->>'plan_slug' = ${planSlug}
      AND wi.payload->'plan_item'->>'item_id' = ${itemId}
    )
  )`);
  const exactMatch = matches.slice(1).reduce((acc, next) => sql`${acc} OR ${next}`, matches[0]);
  const rows = await sql<PlanItemCollisionRow[]>`
    SELECT wi.feature_id, wi.status
      FROM harness_shared.work_items wi
     WHERE wi.workspace_id = ${workspaceId}
       AND NOT (wi.status = ANY(${ANY_FAMILY_TERMINAL_STATES as string[]}::text[]))
       AND (${exactMatch})
     ORDER BY wi.created_ts ASC NULLS LAST, wi.feature_id ASC
     LIMIT 1`;
  return rows[0] ?? null;
}

/**
 * Repair the one create-time duplicate that the admission remedy promises to
 * repair. The INSERT path cannot help here: exact identity is discovered before
 * createWorkItem, so a re-file reaches this function with the existing row still
 * pending. Keep the authorization predicates separate from the CAS predicate:
 * an explicit fresh assignment may promote + claim atomically, while a server
 * stamped fleet-scope downgrade may promote without granting the refused claim.
 */
function readFleetScopeDowngradeMarker(
  args: CreateOneWorkItemArgs,
  ctx: CreateOneWorkItemCtx,
): FleetScopeDowngradeMarker | null {
  if (args.admissionBypass !== 'bypass:explicit-assignment') return null;
  const raw = args.payload?.fleetScopeDowngrade;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const marker = raw as Record<string, unknown>;
  const requestedAssignee = typeof marker.requestedAssignee === 'string' ? marker.requestedAssignee.trim() : '';
  const reportedBy = typeof marker.reportedBy === 'string' ? marker.reportedBy.trim() : '';
  const fleet = typeof marker.fleet === 'string' ? marker.fleet.trim() : '';
  const code = typeof marker.code === 'string' ? marker.code.trim() : '';
  const at = typeof marker.at === 'string' ? marker.at.trim() : '';
  // `fleetScopeDowngrade` is server-stamped by create.ts. Requiring the marker's
  // reporter to be this request's actor prevents a caller from carrying a
  // different agent's downgrade into an unrelated re-file.
  if (!requestedAssignee || !reportedBy || reportedBy !== ctx.ownerId || !fleet || !code || !at) return null;
  if (!Number.isFinite(Date.parse(at))) return null;
  return { requestedAssignee, reportedBy, fleet, code, at };
}

async function repairPendingExactIdentityDuplicate(
  args: CreateOneWorkItemArgs,
  ctx: CreateOneWorkItemCtx,
  workspaceId: string | undefined,
  identity: AdmissionIdentity,
  exactIdentity: Pick<SemanticDupeCandidate, 'id'>,
): Promise<WorkItem | null> {
  const assignee = args.assign_to?.trim() || null;
  const downgrade = readFleetScopeDowngradeMarker(args, ctx);
  if (!assignee && !downgrade) return null;
  // A wildcard/unresolved workspace must never authorize a cross-workspace repair.
  if (!workspaceId) return null;

  const { sql } = getOrgPg();
  const rows = assignee
    ? await sql<PendingAdmissionRepairRow[]>`
        UPDATE harness_shared.work_items
           SET admission = 'auto',
               admitted_at = now(),
               admitted_by = 'bypass:explicit-assignment',
               taken_by = ${assignee},
               taken_at = now(),
               updated_ts = (extract(epoch FROM now()) * 1000)::bigint,
               payload =
                 (CASE WHEN jsonb_typeof(payload) = 'object' THEN payload ELSE '{}'::jsonb END)
                 || jsonb_build_object(
                      '_ei',
                      (CASE WHEN jsonb_typeof(payload->'_ei') = 'object' THEN payload->'_ei' ELSE '{}'::jsonb END)
                      || jsonb_build_object('assigned_by', ${ctx.ownerId}::text)
                    )
         WHERE workspace_id = ${workspaceId}
           AND feature_id = ${exactIdentity.id}
           AND item_kind IN ('bug', 'change', 'task')
           AND status = 'open'
           AND NOT (status = ANY(${ANY_FAMILY_TERMINAL_STATES}::text[]))
           AND admission = 'pending'
           AND payload->'admissionIdentity'->>'schemaVersion' = ${identity.schemaVersion}
           AND payload->'admissionIdentity'->>'titleKey' = ${identity.titleKey}
           AND payload->'admissionIdentity'->>'signalKey' IS NOT DISTINCT FROM ${identity.signalKey ?? null}::text
           AND taken_by IS NULL
           AND taken_at IS NULL
         RETURNING feature_id`
    : await sql<PendingAdmissionRepairRow[]>`
        UPDATE harness_shared.work_items
           SET admission = 'auto',
               admitted_at = now(),
               admitted_by = 'bypass:explicit-assignment',
               updated_ts = (extract(epoch FROM now()) * 1000)::bigint
         WHERE workspace_id = ${workspaceId}
           AND feature_id = ${exactIdentity.id}
           AND item_kind IN ('bug', 'change', 'task')
           AND status = 'open'
           AND NOT (status = ANY(${ANY_FAMILY_TERMINAL_STATES}::text[]))
           AND admission = 'pending'
           AND payload->'admissionIdentity'->>'schemaVersion' = ${identity.schemaVersion}
           AND payload->'admissionIdentity'->>'titleKey' = ${identity.titleKey}
           AND payload->'admissionIdentity'->>'signalKey' IS NOT DISTINCT FROM ${identity.signalKey ?? null}::text
           AND taken_by IS NULL
           AND taken_at IS NULL
         RETURNING feature_id`;
  const repairedId = rows[0]?.feature_id;
  if (!repairedId) return null;
  return (await getWorkItem(repairedId, args.harness)) ?? (await getWorkItem(repairedId));
}

export async function createOneWorkItem(
  args: CreateOneWorkItemArgs,
  ctx: CreateOneWorkItemCtx,
): Promise<CreateOneWorkItemResult> {
  try {
    if (isDeprecatedWorkItemKind(args.kind)) {
      return {
        ok: false,
        error: 'deprecated_kind',
        message:
          "work-item kind 'chunk' is deprecated and cannot be created through the public queue. " +
          'Use a feature for a top-level capability or a change for a direct code modification. ' +
          'Existing chunk rows remain readable for history and compatibility.',
      };
    }
    const issueAdmission = familyOf(args.kind) === 'issue';
    const signalKey =
      args.payload && typeof args.payload.watchdogKey === 'string' ? args.payload.watchdogKey : undefined;
    const identity = admissionIdentity(args.title, signalKey);
    // EI-728: route the write to the request's workspace. Precedence: explicit
    // `workspace` arg → the request's concrete workspace (ctx.workspaceId) →
    // undefined (keep the trigger-derived default). '*' (unscoped SU) ⇒ "no workspace".
    // (Resolved up here — before the guards — because the WI-39604 condition-key
    // adopt path below needs the workspace-scoped read; see condition-upsert.ts.)
    const workspaceId =
      (typeof args.workspace === 'string' && args.workspace.trim()) ? args.workspace.trim()
        : (ctx.workspaceId && ctx.workspaceId !== '*') ? ctx.workspaceId
          : undefined;
    // WI-39604: a conditionKey routes this create through the WI-39594 condition
    // upsert. Adoption is checked FIRST — it cannot create a row, so the dedup
    // screens below have nothing to screen, and a recurring detector's steady-state
    // re-fire stays one indexed read + one refresh write.
    const conditionKey = args.conditionKey?.trim() || undefined;
    // EI-21827949941920236: an urgent condition-keyed filing is itself the
    // durable detector signal that must reach the queue when the semantic probe
    // is unavailable. The condition upsert still provides deterministic
    // recurrence deduplication; keep the ordinary goal-mode rail fail-closed.
    const urgentConditionKeyEscape = Boolean(args.urgent && conditionKey);
    if (conditionKey) {
      const incumbent = await adoptConditionIncumbent(conditionKey, {
        title: args.title,
        summary: args.summary,
        workspaceId,
      });
      if (incumbent) {
        // The incumbent may live under a normalized (pot-home) harness — retry
        // the read unscoped before treating the adoption as a miss.
        const adopted = (await getWorkItem(incumbent, args.harness)) ?? (await getWorkItem(incumbent));
        if (adopted) {
          if (issueAdmission) {
            await appendWorkItemOccurrence(args, ctx, identity, 'coalesced', adopted.id, adopted.harness);
          }
          return { ok: true, workItem: adopted, conditionUpsert: { adopted: true, id: incumbent } };
        }
      }
    }
    // EI-316 mirror-duplicate guard: a title embedding an existing OPEN work-item id
    // ("WI-118: …") is almost always an accidental mirror — refuse with the live id
    // (override: force:true). Flag-gated so a misfire is instantly reversible.
    if (!args.force && (await getFlag(FLAGS.WORK_ITEM_MIRROR_GUARD, 'system'))) {
      const mirror = await findMirroredOpenItem(args.title, async (id) => {
        const wi = await getWorkItem(id, args.harness);
        return wi ? { id: wi.id, state: wi.state } : null;
      });
      // EI-18816637571744179: an explicit typed link to the named item declares
      // lineage (a follow-up), which is the opposite of the accidental mirror
      // this guard catches — so consult it before refusing.
      if (mirror && !hasDeclaredLineageTo(args.links, mirror.id)) {
        if (issueAdmission) {
          await appendWorkItemOccurrence(
            args,
            ctx,
            identity,
            'duplicate',
            mirror.id,
            args.harness,
          );
        }
        return {
          ok: false,
          error: 'duplicate_mirror',
          message:
            `title references existing OPEN work-item ${mirror.id} (state: ${mirror.state}) — ` +
            `if this is the SAME work, work that item directly (work_items:claim ${mirror.id} / ` +
            `work_items:set_state) rather than mirroring it. ` +
            `If it is a FOLLOW-UP (different scope — e.g. what ${mirror.id} deliberately left undone), ` +
            `declare that by passing links:[{ rel:'relates', target_id:'${mirror.id}' }] and it will be ` +
            `created; force:true also overrides.`,
          existing: mirror,
        };
      }
    }
    // P-008 semantic dupe prescreen (shared-embedding-sidecar-and-enrichment-2026-07-10):
    // cosine-rank the new title+summary against OPEN items' migration-548 embeddings —
    // the detector the 2026-07-10 30-dupe storm needed (differently-worded titles the
    // EI-316 lexical mirror-guard above cannot see). STRICTLY fail-open: null =
    // "no verdict" = proceed.
    // P-002 (silent-intake-central-resolution-2026-09-01, D-001): both bands are now
    // advisory — hard matches stamp 'semantic-hard' and merge into the same
    // `similarOpen` set as soft matches; no create is refused on a match (the
    // duplicate_semantic veto, and WI-39824's force-override carve-out of it, are
    // retired — the guard's own calibration block records that cosine alone cannot
    // separate duplicates from distinct filings in this corpus at any cut, so the
    // verdict belongs to the central resolver, not a filer gate). `shouldScreen`
    // survives the veto's retirement: force (the caller asserting distinctness) may
    // skip the probes for speed, but DRAIN (requireCompleteDedupCoverage) and the
    // P-004 goal gate still force the MEASUREMENT so the coverage verdict +
    // candidates are recorded on the item either way.
    const shouldScreen =
      !args.force || Boolean(args.requireCompleteDedupCoverage) || Boolean(args.goalDedupGate);
    let semanticLeg: WorkItemDedupCoverage['semantic'] = issueAdmission ? 'skipped' : 'skipped';
    let lexicalLeg: WorkItemDedupCoverage['lexical'] = issueAdmission ? 'skipped' : 'skipped';
    let similarOpen: SemanticDupeCandidate[] | undefined;
    let burstCandidates: SemanticDupeCandidate[] = [];
    // P-001 (silent-intake-central-resolution-2026-09-01): hard-band semantic hits that
    // a force:true create rode past — tracked so the payload stamp below records them
    // as 'semantic-hard' rather than misfiling them in the advisory band.
    let hardSemanticIds: ReadonlySet<string> = new Set();
    if (shouldScreen) {
      const dupes = await findSemanticDupes({
        title: args.title,
        summary: args.summary,
        harness: args.harness ?? ctx.harnessSlug ?? undefined,
      });
      // P-004: under the goal gate the semantic leg's health matters for EVERY kind
      // (the gate's whole point is "the probe actually ran"), not only issue-family.
      if (issueAdmission || args.goalDedupGate) {
        semanticLeg = dupes ? 'ok' : 'unavailable';
        // EI-22170937574367219: every failure path in semantic-dupe-guard.ts was
        // silent (fail-open by design, but with no publisher) — the only signal was
        // whichever agent happened to hit the goal-gate's dedup_unavailable refusal.
        // Fire-and-forget, deduplicated (bumps one open escalation's repeat count
        // rather than spamming); never awaited on the create's hot path.
        if (semanticLeg === 'unavailable') {
          // Resolve through the shared scope helper, not `args.harness ?? ctx.harnessSlug`:
          // a raw `*` is TRUTHY but is not a registered harness, so it would tag this
          // escalation with a slug that resolves to nothing and read as a clean empty result.
          void reportSemanticDedupProbeUnavailable({
            harnessSlug: resolveConcreteHarnessSlug(args.harness, ctx) ?? undefined,
          }).catch(() => {});
        }
      }
      if (dupes && dupes.soft.length > 0) {
        burstCandidates = dupes.soft;
        similarOpen = dupes.soft;
      }
      // P-001/P-002 (silent-intake-central-resolution-2026-09-01, D-001): the hard
      // band's duplicate_semantic REFUSAL is retired — every filing is accepted and
      // the central resolver merges twins. The detection still happened and these
      // are the strongest twins this filing has: merge them into the advisory set
      // UNCONDITIONALLY so they ride the same persistence rails
      // (payload.dedupCandidates 'semantic-hard' + persistDedupEdges + occurrence
      // evidence); the burst circuit deliberately still reads dupes.soft only.
      if (dupes && dupes.hard.length > 0) {
        hardSemanticIds = new Set(dupes.hard.map((c) => c.id));
        const seen = new Set((similarOpen ?? []).map((c) => c.id));
        const fresh = dupes.hard.filter((c) => !seen.has(c.id));
        if (fresh.length > 0) similarOpen = [...(similarOpen ?? []), ...fresh];
      }
    }
    // EI-9940 recent-lexical dupe prescreen: catches a near-duplicate title created
    // moments ago, BEFORE the async embed-backfill sweep has indexed it — exactly the
    // gap that let WI-4242 duplicate WI-4241 one minute after it landed (2026-07-12).
    // Advisory-only, never blocks; merged into the same `similarOpen` field, deduped
    // against anything the semantic guard already found.
    if (shouldScreen) {
      const recentDupes = await findRecentLexicalDupes({
        title: args.title,
        // Summary feeds the measurement-overlap signal (plan
        // duplicate-screening-keys-on-authored-prose…-2026-09-05, P-002).
        summary: args.summary,
        harness: args.harness ?? ctx.harnessSlug ?? undefined,
      });
      if (recentDupes && recentDupes.length > 0) {
        const seen = new Set((similarOpen ?? []).map((c) => c.id));
        const fresh = recentDupes.filter((c) => !seen.has(c.id));
        if (fresh.length > 0) similarOpen = [...(similarOpen ?? []), ...fresh];
      }
    }
    // EI-19298062354262754: the unified work-item full-text search-first prescreen
    // (searchWorkItems with semantic:false + title/summary Jaccard) is reused here
    // rather than a second divergent implementation. Advisory-only, merged into the
    // same `similarOpen` field, deduped against anything the guards above already
    // found. It intentionally spans both work-item families.
    let fulltextDupes: SemanticDupeCandidate[] | null = null;
    if (shouldScreen && issueAdmission) {
      fulltextDupes = await findFulltextLexicalDupes({ title: args.title, summary: args.summary });
      lexicalLeg = fulltextDupes === null ? 'unavailable' : 'ok';
      if (fulltextDupes && fulltextDupes.length > 0) {
        const seen = new Set((similarOpen ?? []).map((c) => c.id));
        const fresh = fulltextDupes.filter((c) => !seen.has(c.id));
        if (fresh.length > 0) similarOpen = [...(similarOpen ?? []), ...fresh];
      }
    }
    // P-004: coverage is now computed for FEATURE-family creates too when the goal
    // gate is on. The full-text lexical leg only queries engineer_issues (no
    // feature/chunk rows), so for feature-family it is legitimately 'skipped' and
    // must NOT count as degraded — only the semantic leg (the one that catches
    // reworded titles across every kind) carries the verdict there.
    const dedupCoverage: WorkItemDedupCoverage | undefined = issueAdmission
      ? {
          lexical: lexicalLeg,
          semantic: semanticLeg,
          degraded: lexicalLeg !== 'ok' || semanticLeg !== 'ok',
        }
      : args.goalDedupGate
        ? { lexical: 'skipped', semantic: semanticLeg, degraded: semanticLeg !== 'ok' }
        : undefined;
    // P-002 (silent-intake-central-resolution-2026-09-01, D-001): the DRAIN
    // degraded-coverage refusal is retired — a degraded probe files anyway, with
    // the degradation stamped on the row (payload.dedupCoverage below). The
    // requireCompleteDedupCoverage arg still forces the MEASUREMENT (shouldScreen
    // above); only the veto is gone.
    // P-004 (goal-mode-design-intent-hardening-2026-08-16): a GOAL-mode create whose
    // dedup probe could not actually run fails CLOSED instead of open. The WI-39373
    // relapse this hardens against: the probes RAN but semantic coverage was
    // 'unavailable' — the ONLY leg that catches a reworded title — so the duplicate
    // was admitted with a degraded marker stamped where nobody looks. Unlike DRAIN
    // above, force:true remains an explicit escape for work that must land now; the
    // coverage verdict + any candidates still come back on the result either way.
    if (
      args.goalDedupGate
      && !args.force
      && dedupCoverage?.degraded
      && !urgentConditionKeyEscape
    ) {
      return {
        ok: false,
        error: 'dedup_unavailable',
        message:
          `goal-mode create requires a LIVE dedup probe and the semantic leg is down ` +
          `(lexical=${dedupCoverage.lexical}, semantic=${dedupCoverage.semantic}) — a reworded ` +
          `duplicate cannot be screened, which is how WI-39373 relapsed. No work-item was ` +
          `created: retry when the probe is back, or pass force:true if this must land now ` +
          `(the degraded coverage is then recorded on the item).`,
        ...(similarOpen ? { similarOpen } : {}),
        ...(issueAdmission ? { admissionIdentity: identity } : {}),
        dedupCoverage,
      };
    }
    const exactIdentity = fulltextDupes?.find(
      (candidate) => admissionIdentity(candidate.title).titleKey === identity.titleKey,
    );
    // EI-20449994308545912: exact normalized identity is a synchronous writer-side
    // invariant, not a DRAIN-only policy. A rapid `items:[…]` batch is processed
    // sequentially, but the semantic embedding for the first row is not available
    // before the next item runs. The full-text leg already sees that fresh row and
    // computes `exactIdentity`; ignoring it outside DRAIN admitted every repeated
    // report as a new canonical work item. Preserve every repeat as an occurrence
    // on the first row instead. `force:true` remains the explicit escape for genuinely
    // distinct work; DRAIN's complete-coverage contract intentionally overrides force.
    if (exactIdentity && args.requireCompleteDedupCoverage) {
      await appendWorkItemOccurrence(
        args,
        ctx,
        identity,
        'duplicate',
        exactIdentity.id,
        exactIdentity.harness,
        [exactIdentity],
        dedupCoverage,
      );
      return {
        ok: false,
        error: 'duplicate_identity',
        message:
          `stable admission identity matches OPEN work-item ${exactIdentity.id} "${exactIdentity.title}" — ` +
          (args.requireCompleteDedupCoverage
            ? 'work that item instead; DRAIN does not admit another bug with the same normalized identity.'
            : 'work that item instead, or pass force:true if this is genuinely distinct work.'),
        existing: { id: exactIdentity.id, state: exactIdentity.state },
        similarOpen: [exactIdentity],
      };
    }
    // The ordinary duplicate refusal is also the create-time admission-repair
    // seam. DRAIN deliberately returned above; force still gets one repair attempt
    // and only falls through to its existing distinct-work escape on a CAS miss.
    if (exactIdentity) {
      const repaired = await repairPendingExactIdentityDuplicate(args, ctx, workspaceId, identity, exactIdentity);
      if (repaired) return { ok: true, workItem: repaired, admissionIdentity: identity, dedupCoverage };
    }
    if (exactIdentity && !args.force) {
      await appendWorkItemOccurrence(
        args,
        ctx,
        identity,
        'duplicate',
        exactIdentity.id,
        exactIdentity.harness,
        [exactIdentity],
        dedupCoverage,
      );
      return {
        ok: false,
        error: 'duplicate_identity',
        message:
          `stable admission identity matches OPEN work-item ${exactIdentity.id} \"${exactIdentity.title}\" — ` +
          'work that item instead, or pass force:true if this is genuinely distinct work.',
        existing: { id: exactIdentity.id, state: exactIdentity.state },
        similarOpen: [exactIdentity],
      };
    }
    // P-005: a SOFT semantic sibling is advisory during normal flow, but becomes
    // a lossless occurrence home when BOTH canonical-cluster and emitter entropy
    // collapse in the exact rolling ledger. Recent/full-text lexical candidates
    // stay advisory-only: their looser metrics are not strong enough to suppress
    // a new row. Critical novelty and force bypass this circuit; a missing reader
    // verdict fails open. The coalesced outcome is returned as a non-creation so
    // the handler never emits a false `work item created` demand event.
    let queueAdmission: IssueAdmissionPressure | undefined;
    if (issueAdmission && !args.force && args.severity !== 'critical' && burstCandidates.length > 0) {
      const candidates = burstCandidates.map((candidate) => ({
        id: candidate.id,
        title: candidate.title,
        similarity: candidate.similarity,
        canonicalHarness: candidate.harness,
        eligible: true,
      }));
      const pressureCandidate = selectCanonicalIssue(identity, candidates);
      if (pressureCandidate) {
        queueAdmission = (await readIssueAdmissionPressure({
          canonicalId: pressureCandidate.id,
          canonicalHarness: pressureCandidate.canonicalHarness,
        }).catch(() => null)) ?? undefined;
        const decision = decideIssueAdmissionCircuit({
          identity,
          candidates,
          pressure: queueAdmission ?? null,
          severity: args.severity,
          force: args.force,
        });
        if (decision.action === 'coalesce' && decision.canonical) {
          const canonical = burstCandidates.find((candidate) => candidate.id === decision.canonical?.id);
          await appendWorkItemOccurrence(
            args,
            ctx,
            identity,
            'coalesced',
            decision.canonical.id,
            decision.canonical.canonicalHarness,
            similarOpen,
            dedupCoverage,
            queueAdmission,
          );
          return {
            ok: false,
            error: 'coalesced',
            message:
              `low-diversity admission burst: preserved this report as an occurrence on ` +
              `${decision.canonical.id}; no new scheduler row was created`,
            existing: { id: decision.canonical.id, state: canonical?.state ?? 'open' },
            ...(similarOpen ? { similarOpen } : {}),
            admissionIdentity: identity,
            dedupCoverage,
            queueAdmission,
          };
        }
      }
    }
    // (EI-728 workspace resolution now happens at the top of this function —
    // the WI-39604 condition-key adopt path needs it before the guards.)
    // P-001 generic-kind gate (reflexive-platform-extensibility-datatypes-2026-06-24):
    // accept a BUILT-IN kind OR a workspace-registered generic-kind datatype. Built-ins
    // pass via the cheap in-memory check with NO DB query, so every existing caller is
    // byte-identical; only a NON-built-in kind hits the registry (today always rejected
    // here — now a registered generic-kind passes). Dark until a datatype is declared, so
    // there is no behavior change until meta:define-datatype registers a kind. This is the
    // platform-side registration path the oddsmith F1 gap needed (oddsmith D-017/P-021).
    if (!isWorkItemKind(args.kind)) {
      const datatype = workspaceId
        ? await getGenericKindDatatype(getOrgPg().sql, workspaceId, args.kind).catch(() => null)
        : null;
      if (!datatype) {
        return {
          ok: false,
          error: 'unknown_kind',
          message:
            `unknown work-item kind "${args.kind}" — use a built-in kind ` +
            `(feature, chunk, bug, change, task), or first declare it via ` +
            `meta:define-datatype (generic-kind tier) in this workspace, then create instances with that kind.`,
        };
      }
      // P-001 payload validation — the core reason a datatype exists: an instance must
      // satisfy the datatype's declared payload_schema (a malformed `bet` is rejected, not
      // stored as an untyped blob). No schema ⇒ no constraint; declare-time compilation
      // guarantees the schema is well-formed so this never fail-opens in practice.
      const pv = validateDatatypePayload(datatype.payloadSchema, args.payload);
      if (!pv.ok) {
        return {
          ok: false,
          error: 'invalid_payload',
          message: `payload does not match datatype "${args.kind}": ${pv.errors.join('; ')}`,
        };
      }
    }
    // Hive-scope gate (D-019/D-020): a PIPELINE work-item belongs to a hive's fleet
    // queue, so it must resolve to a hive — auto-resolve-then-require from the explicit
    // `pot` arg, else the item's harness, else the session's harness. Issue kinds
    // (bug/change) are NOT gated — they may stay workspace-global (D-020).
    let harnessForItem = args.harness;
    if (HIVE_GATED_KINDS.has(args.kind)) {
      const potScope = await resolvePotScope(args.pot, {
        workspaceId: ctx.workspaceId,
        harnessSlug: args.harness ?? ctx.harnessSlug,
      });
      if (potScope.kind === 'none') {
        return { ok: false, error: 'hive_required', message: POT_REQUIRED_DETAIL };
      }
      harnessForItem = args.harness ?? potScope.slug;
    }
    // EI-8809 (routing-gate hint at dispatch): a cheap, non-blocking keyword match
    // against the papercusp-way trigger rows — the item's claimer sees the
    // prescribed mechanism in payload.routingHint instead of having to re-derive it
    // from a raw title mid-flow. Hint only, never a validation gate; a caller's
    // OWN payload.routingHint (if ever explicitly set) is never clobbered.
    const routingHint = matchRoutingGateHint(args.title, {
      ownerIntent: args.routing_intent,
      cadence: args.cadence,
    });
    // P-001 (silent-intake-central-resolution-2026-09-01, D-003): persist the file-time
    // candidates on the row beside the coverage verdict — the central resolver's input,
    // never the filer's business. Non-empty only; payload.dedupCoverage separates
    // "checked clean" from "could not check". Same stamping policy as dedupCoverage:
    // issue admission always, goal-gated feature-family too.
    const dedupCandidateStamps: DedupCandidateStamp[] | undefined =
      similarOpen && similarOpen.length > 0
        ? similarOpen.map(
            (c): DedupCandidateStamp => ({
              id: c.id,
              similarity: c.similarity,
              method: hardSemanticIds.has(c.id)
                ? 'semantic-hard'
                : c.source === 'lexical-recent'
                  ? 'lexical-recent'
                  : c.source === 'lexical-fulltext'
                    ? 'lexical-fulltext'
                    : c.source === 'measurement-overlap'
                      ? 'measurement-overlap'
                      : 'semantic-soft',
            }),
          )
        : undefined;
    const payloadWithAdmission = issueAdmission
      ? {
          ...(args.payload ?? {}),
          admissionIdentity: identity,
          dedupCoverage,
          ...(dedupCandidateStamps ? { dedupCandidates: dedupCandidateStamps } : {}),
        }
      : // P-004: a goal-gated feature-family create records its coverage verdict on
        // the row too (admissionIdentity stays issue-only — it keys the occurrence
        // ledger, which has no feature rows).
        args.goalDedupGate && dedupCoverage
        ? {
            ...(args.payload ?? {}),
            dedupCoverage,
            ...(dedupCandidateStamps ? { dedupCandidates: dedupCandidateStamps } : {}),
          }
        : args.payload;
    const payloadWithHint =
      routingHint && !(payloadWithAdmission && 'routingHint' in payloadWithAdmission)
        ? { ...(payloadWithAdmission ?? {}), routingHint }
        : payloadWithAdmission;
    // EI-16028: the scheduler's live `affinity(bee.held_paths, item.paths)` rank term
    // reads `payload.paths`, but that field is caller-supplied only — ~90% of
    // work-items never set it, so affinity silently collapses to NEUTRAL for almost
    // the entire claimable pool. Fall back to paths extracted from the item's own
    // title/summary text ONLY when the caller supplied none explicitly (never
    // overrides/clobbers an explicit — including explicit-empty — `payload.paths`).
    const explicitPaths = Array.isArray(payloadWithHint?.paths)
      ? (payloadWithHint.paths as unknown[]).filter((p): p is string => typeof p === 'string')
      : undefined;
    let explicitPathsWarning: string | undefined;
    if (explicitPaths !== undefined && explicitPaths.length > 0) {
      try {
        const rootSelection = await selectExplicitRepoPathRoot(explicitPaths, ctx, args.harness);
        const unresolved = validateExplicitRepoPaths(explicitPaths, {
          repoRoot: rootSelection.root,
        });
        explicitPathsWarning = unresolved
          ? explicitRepoPathsWarning(unresolved.missing, {
              rootSource: rootSelection.source,
              root: rootSelection.root,
            })
          : undefined;
      } catch {
        // EI-20191260047847804: this check is an advisory. A root-resolution or fs
        // failure must never turn a successful create into a failure.
      }
    }
    const payloadWithPaths =
      explicitPaths === undefined
        ? (() => {
            const derived = deriveRepoPathsFromText(`${args.title}\n${args.summary ?? ''}`, {
              repoRoot: resolveAgentWorkspaceRoot(ctx),
            });
            return derived.length > 0 ? { ...(payloadWithHint ?? {}), paths: derived } : payloadWithHint;
          })()
        : payloadWithHint;
    // EI-18698328828208444: a caller-supplied `payload._claimHold:true` bypasses
    // setWorkItemClaimHold entirely (this create path never calls it), so it would
    // otherwise land with NO claim_hold_by/held_open_by attribution — unreviewable and
    // unexpirable (see ensureClaimHoldAttribution's doc comment). Stamp it at the source
    // instead of letting an anonymous hold enter the system.
    const payloadFinal = ensureClaimHoldAttribution(
      payloadWithPaths,
      ctx.ownerId,
      'auto-attributed at create (EI-18698328828208444): payload._claimHold was set directly ' +
        'in work_items:create\'s payload arg with no claim_hold_by/held_open_by — stamped to the creator.',
    );
    // EI-19390496242545842: `targetPlanItem` (the `plan_item:{slug,item}` create arg) used
    // to write ONLY the coord_links coverage edge below — but work_items:complete's
    // plan-item auto-flip (synchronizeFinishWork → finishPlanStamp) reads a SEPARATE
    // mechanism: a `payload.plan_item` STAMP ({ plan_slug, item_id, harness_slug }). Every
    // OTHER path that mints a work-item FOR a plan item (plan-run scheduled minting in
    // plan-run-action.ts, plan launch/promotion in plan-workitem-promotion-run.ts,
    // convert-at-pickup in plan-items/convert.ts) writes this stamp; this one never did — so
    // an item created via work_items:create{plan_item} could NEVER auto-flip its plan item's
    // status at completion, no matter how the coverage edge below turned out. It always
    // reported `planItem:'not-linked'` in the completion receipt. Stamp it here too, so
    // `work_items:complete` can find it. Never clobbers an explicit caller-supplied
    // `payload.plan_item` (a caller who set it deliberately knows what they're doing).
    const planItemStampHarness = harnessForItem ?? ctx.harnessSlug ?? undefined;
    const payloadWithPlanStamp =
      args.targetPlanItem?.slug && args.targetPlanItem?.itemId && planItemStampHarness &&
      !(payloadFinal && typeof payloadFinal === 'object' && 'plan_item' in payloadFinal)
        ? {
            ...(payloadFinal ?? {}),
            plan_item: {
              plan_slug: args.targetPlanItem.slug,
              item_id: args.targetPlanItem.itemId,
              harness_slug: planItemStampHarness,
            } satisfies PlanItemStamp,
          }
        : payloadFinal;
    // WI-39604: a condition-keyed mint carries the upsert marker from birth, so
    // occurrence counting reads identically whether the row was minted here or
    // by upsertConditionWorkItem (refreshIncumbent COALESCEs a missing marker,
    // but a stamped one keeps the first occurrence visible).
    const payloadForCreate = conditionKey
      ? {
          ...(payloadWithPlanStamp ?? {}),
          [CONDITION_UPSERT_MARKER]: {
            conditionKey,
            occurrences: 1,
            lastSeenAt: new Date().toISOString(),
          },
        }
      : payloadWithPlanStamp;
    const planItemIdentities = new Map<string, PlanItemIdentity>();
    const stampedPlanItem = readPlanItemIdentity(payloadForCreate?.plan_item);
    if (stampedPlanItem) {
      planItemIdentities.set(`${stampedPlanItem.planSlug}#${stampedPlanItem.itemId}`, stampedPlanItem);
    }
    if (args.targetPlanItem?.slug && args.targetPlanItem.itemId) {
      const targetPlanItem = {
        planSlug: args.targetPlanItem.slug.trim(),
        itemId: args.targetPlanItem.itemId.trim(),
      };
      if (targetPlanItem.planSlug && targetPlanItem.itemId) {
        planItemIdentities.set(`${targetPlanItem.planSlug}#${targetPlanItem.itemId}`, targetPlanItem);
      }
    }
    const planItemCollision = await findOpenPlanItemCollision(workspaceId, [...planItemIdentities.values()]);
    if (planItemCollision) {
      return {
        ok: false,
        error: 'duplicate_plan_item',
        message:
          `plan item coverage already exists on OPEN work-item ${planItemCollision.feature_id} ` +
          `(state=${planItemCollision.status}); continue that item instead of creating a sibling`,
        existing: { id: planItemCollision.feature_id, state: planItemCollision.status },
      };
    }
    // ── ADMISSION GATE (plan work-queue-admission-and-bulk-dedup-2026-08-24, P-002) ──
    // Born-pending is UNIVERSAL here, not conditional on this filing having found
    // similar items. Every kind this path can mint is feature|chunk|bug|change|task —
    // observations have their own writer (work_items:observe) and never reach here — so
    // "every non-observation filing path lands pending" is, at this choke point, simply
    // "every item, minus the bypasses below".
    //
    // The gate judges DUPLICATION ONLY, never merit (plan charter: redundancy kappa
    // 0.679 vs merit kappa 0.289). Two bypasses, both meaning "already reviewed by
    // something with more context than a similarity score":
    //   * plan provenance — the item implements a plan item, so it passed plan review;
    //   * critical severity / a security topic — promote now, review post-hoc, because
    //     the cost of delaying a real one dominates the cost of a duplicate.
    // An explicit assignment is a third, mechanical bypass: pending rows cannot carry
    // an assignee (createWorkItem deliberately strips claims from pending rows), while
    // B-LOOP-4 requires assign_to to claim atomically in the INSERT. Marking that
    // deliberate owner handoff as an attributable auto admission keeps the no-race
    // contract without a post-create claim window. Keep this after the existing
    // bypasses so their admission reasons remain stable when a caller also assigns.
    //
    // `args.force` is DELIBERATELY NOT a bypass. force means "file despite the hard
    // dedup refusals", which is a claim about THIS filing's duplicates — exactly the
    // question the promoter re-asks with corpus-wide evidence. Letting it also skip the
    // gate would make the gate opt-out by the one flag every blocked filer already
    // reaches for. A forced item lands pending and is promoted on the normal tick; if
    // the promoter is dead or lagging, the fail-open path admits it as 'unreviewed'
    // rather than starving the queue.
    // EI-21973318733042066: typed against ADMISSION_CREATE_BYPASSES rather than `string`, so
    // the reasons this path mints and the remedy the claim-path refusal RENDERS from that same
    // record cannot drift apart — dropping an entry there is a compile error here.
    const admissionBypass: AdmissionBypassReason | null =
      planItemIdentities.size > 0
        ? 'bypass:plan-item'
        : args.severity === 'critical'
          ? 'bypass:severity-critical'
          : args.topics?.some((t) => t.trim().toLowerCase() === 'security')
            ? 'bypass:topic-security'
            : args.assign_to?.trim()
              ? 'bypass:explicit-assignment'
              : args.admissionBypass ?? null;
    const bornAdmission: 'pending' | 'auto' = admissionBypass ? 'auto' : 'pending';
    let workItem = await createWorkItem({
      kind: args.kind as WorkItemKind,
      title: args.title,
      summary: args.summary,
      harness: harnessForItem,
      workspaceId,
      severity: args.severity,
      parent: args.parent,
      topics: args.topics,
      payload: payloadForCreate,
      sourcePlanSlug: args.targetPlanItem?.slug,
      sourcePlanItemIds: args.targetPlanItem?.itemId ? [args.targetPlanItem.itemId] : undefined,
      // P-005: owner-directive provenance, deliberately the same shape as
      // sourcePlanSlug above — "where did this work-item come from" — and
      // written in the same INSERT rather than a post-create UPDATE, so a row
      // is never briefly visible as unlinked work for a directive it carries.
      directiveRef: args.directiveRef,
      createdBy: ctx.ownerId,
      urgent: args.urgent,
      // B-LOOP-4 (loop-routines P-007 / D-008): atomic create+claim. `assign_to`
      // stamps the owner in the same write — no create→claim race. The creator is
      // the durable delegator (`assignedBy`, issue-family only).
      assignee: args.assign_to,
      assignedBy: args.assign_to ? ctx.ownerId : undefined,
      // P-002: rides in the INSERT for both families — never a post-create UPDATE,
      // which would leave the row admitted and claimable in the gap between writes.
      admission: bornAdmission,
      admittedBy: admissionBypass,
    });
    // WI-39604: claim the condition key for the fresh mint. A lost race means a
    // concurrent filer's row is the incumbent: this reading is refreshed onto the
    // WINNER, our row is settled, and the winner is returned — before any of the
    // decorations below, which must only ever land on the row that is kept.
    if (conditionKey) {
      const settled = await settleConditionClaim(workItem.id, conditionKey, {
        title: args.title,
        summary: args.summary,
        workspaceId,
        harness: harnessForItem,
      });
      if (!settled.won) {
        const winner = settled.winnerId
          ? ((await getWorkItem(settled.winnerId, args.harness)) ?? (await getWorkItem(settled.winnerId)))
          : null;
        if (issueAdmission) {
          await appendWorkItemOccurrence(
            args,
            ctx,
            identity,
            'coalesced',
            settled.winnerId ?? workItem.id,
            winner?.harness ?? harnessForItem,
            similarOpen,
            dedupCoverage,
          );
        }
        // P-002 item d: the candidates belong to the row that SURVIVES the race, not
        // to ours (which is now settled). Best-effort, like every decoration here.
        const adoptedId = settled.winnerId ?? workItem.id;
        const winnerEdges = await persistDedupEdges({
          itemId: adoptedId,
          harness: resolveConcreteHarnessSlug(winner?.harness ?? harnessForItem, ctx) ?? undefined,
          workspaceId,
          candidates: similarOpen,
        }).catch(() => 0);
        return {
          ok: true,
          workItem: winner ?? workItem,
          conditionUpsert: {
            adopted: true,
            id: adoptedId,
            ...(settled.duplicateLeftOpen ? { duplicateLeftOpen: settled.duplicateLeftOpen } : {}),
          },
          ...(winnerEdges > 0 ? { dedupEdges: winnerEdges } : {}),
          ...(explicitPathsWarning ? { explicitPathsWarning } : {}),
          ...(issueAdmission ? { admissionIdentity: identity, dedupCoverage } : {}),
        };
      }
    }
    if (issueAdmission) {
      await appendWorkItemOccurrence(
        args,
        ctx,
        identity,
        'canonical-created',
        workItem.id,
        workItem.harness ?? harnessForItem,
        similarOpen,
        dedupCoverage,
        queueAdmission,
      );
    }
    // EI-10897: apply the requested initial state as a real transition (not a raw
    // column write), so it goes through the same state machine, guards and fan-out as
    // any other set_state. Best-effort + NON-FATAL, exactly like the edges below: the
    // item already exists, and turning a successful create into an error because the
    // follow-on transition failed would be the worse outcome — the caller can always
    // retry with work_items:set_state. The failure is reported on the result instead
    // of being swallowed, so it is never a SILENT no-op.
    let stateError: string | undefined;
    if (args.state && args.state !== workItem.state) {
      try {
        const moved = await setWorkItemState(workItem.id, args.state, {
          by: ctx.ownerId,
          harness: harnessForItem,
        });
        if (moved) workItem = moved;
        else stateError = `created, but the initial state '${args.state}' did not apply (item not found on the state write)`;
      } catch (e) {
        stateError = `created, but the initial state '${args.state}' was refused: ${
          e instanceof Error ? e.message : String(e)
        }`;
      }
    }

    // Forward edge: link the new work-item to the plan item it addresses (coverage
    // rollup). Non-fatal — the item is already created; an edge write that fails
    // must not turn a successful create into an error (the manual work_items:link
    // path stays available to retry).
    if (args.targetPlanItem?.slug && args.targetPlanItem?.itemId) {
      try {
        await linkWorkItem(
          workItem.id,
          { kind: PLAN_ITEM_KIND, ref: planItemRef(args.targetPlanItem.slug, args.targetPlanItem.itemId) },
          'relates',
          { harness: harnessForItem, by: ctx.ownerId },
        );
      } catch {
        // Non-fatal — coverage edge is best-effort.
      }
    }
    // Inline typed links (WI-3956): declare "this new item investigates EI-x / is about
    // <event key> / …" at birth, so the relationship is queryable in work_items:get
    // { detail:true } without a separate work_items:link round-trip. Each edge is
    // best-effort + non-fatal — identical contract to the plan-coverage edge above: an
    // unresolvable target is skipped, never turning a successful create into an error.
    const inlineLinkWarnings: string[] = [];
    for (const l of args.links ?? []) {
      try {
        const dst = l.target_id
          ? await resolveWorkItemRef(l.target_id, l.target_harness ?? harnessForItem)
          : l.target_kind && l.target_ref
            ? { kind: l.target_kind, ref: l.target_ref }
            : null;
        if (dst) {
          const supportsSatisfaction =
            !l.satisfaction || (l.rel === 'blocks' && (dst.kind === 'issue' || dst.kind === 'feature'));
          const linked = await linkWorkItem(workItem.id, dst, l.rel, {
            harness: harnessForItem,
            by: ctx.ownerId,
            ...(supportsSatisfaction && l.satisfaction ? { satisfaction: l.satisfaction } : {}),
          });
          if ('error' in linked) {
            inlineLinkWarnings.push(
              `inline link ${l.rel} → ${dst.kind}:${dst.ref} was not written: ${linked.error}`,
            );
          } else if (!supportsSatisfaction) {
            inlineLinkWarnings.push(
              `inline link ${l.rel} → ${dst.kind}:${dst.ref} was written without satisfaction '${l.satisfaction}'; ` +
                'satisfaction is supported only for blocks edges to work-item targets',
            );
          }
        }
      } catch {
        // Non-fatal — an inline edge is best-effort, like the coverage edge. Known
        // semantic refusals are surfaced above; unexpected exceptions retain the
        // historical fail-open behavior for create itself.
      }
    }
    // ── Goal provenance (goal-mode-2026-08-07 P-016) ────────────────────
    // Stamp goal_id from SESSION CONTEXT — the `subject` of the creator's GOAL
    // mode, set by goals:create — rather than asking the agent to pass it.
    //
    // This is the whole provenance mechanism, and the reason it reads from the
    // mode rather than from an argument is that agent self-report does not
    // survive a compaction: an agent three days into a goal, on its fifth
    // session, has no memory of the goal id and will simply omit it. Before
    // this, `work_items.goal_id` was NULL on all 65,462 rows, so "what belongs
    // to this goal?" had no answer at all.
    //
    // Applied as a follow-on UPDATE rather than threaded through
    // `createWorkItem`, because the two families take different write paths
    // (feature-family INSERTs the table directly; issue-family goes through
    // `createIssue` and the engineer_issues INSTEAD-OF trigger) and this one
    // statement covers both. It is a DECORATION: best-effort and non-fatal,
    // exactly like the edges above — losing provenance is bad, but failing a
    // creation because provenance could not be recorded is worse.
    let goalStamp: string | undefined;
    let goalStampError: string | undefined;
    try {
      const stampedGoal = await stampGoalProvenance(workItem, workspaceId, ctx.ownerId);
      if (stampedGoal) goalStamp = stampedGoal;
    } catch (e) {
      // EI-20075667133396690 — RECORD, do not raise.
      //
      // Staying non-fatal is right: the item exists, and failing a creation because
      // provenance could not be recorded is worse than losing the attribution. But
      // this catch used to be EMPTY, and that made a stamp that THREW indistinguishable
      // from one that correctly DECLINED — and declining is the overwhelming majority
      // case (most agents are not running under a goal), so a broken UPDATE would hide
      // inside that majority forever. It nearly did: `goal_id` was NULL on all 37,579
      // work-items, and from the data alone "never exercised" could not be told apart
      // from "silently broken every time" without booting real Postgres.
      goalStampError = e instanceof Error ? e.message : String(e);
      console.warn(
        `[work_items:create] goal provenance stamp failed for ${workItem.id}:`,
        goalStampError,
      );
    }
    // ── P-002 item d: prescreen edges → the promoter's substrate ──────────
    // The create succeeded, so `similarOpen` stops being the caller's business and
    // becomes the P-003 promoter's evidence: persist the cosine edges into
    // `harness_shared.dedup_edges` instead of returning an advisory list. Cosine-only
    // and non-fatal — see dedup-edges.ts for why the lexical legs are excluded.
    const dedupEdges = await persistDedupEdges({
      itemId: workItem.id,
      harness: resolveConcreteHarnessSlug(workItem.harness ?? harnessForItem, ctx) ?? undefined,
      workspaceId,
      candidates: similarOpen,
    }).catch(() => 0);
    return {
      ok: true,
      workItem,
      ...(goalStamp ? { goalId: goalStamp } : {}),
      ...(goalStampError ? { goalStampError } : {}),
      ...(dedupEdges > 0 ? { dedupEdges } : {}),
      ...(issueAdmission ? { admissionIdentity: identity, dedupCoverage } : {}),
      // P-004: a goal-gated feature-family create returns its coverage verdict too.
      ...(!issueAdmission && args.goalDedupGate && dedupCoverage ? { dedupCoverage } : {}),
      ...(queueAdmission ? { queueAdmission } : {}),
      ...(stateError ? { stateError } : {}),
      ...(explicitPathsWarning ? { explicitPathsWarning } : {}),
      ...(inlineLinkWarnings.length > 0 ? { inlineLinkWarnings } : {}),
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
