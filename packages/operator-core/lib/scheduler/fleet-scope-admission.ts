/**
 * Hard fleet-scope assignment admission (agent-operability P-016).
 *
 * A live fleet member may only receive work selected by its authoritative
 * per-member/inherited fleet claim spec. The boundary is enforced at every
 * assignment seam and is independent of the scheduler kill-switch. Existing
 * incompatible claims are quarantined by releasing them in one reconciliation
 * sweep and notifying the fleet leader.
 */
import { getOrgPg } from '@papercusp/db-org';
import type { AgentIdentity } from '../agent-tools/coordination/identity';
import type { FleetAssignmentRow } from '../fleet/assignments';
import {
  ISSUE_FAMILY_KINDS,
  type HeldDependencyEscapeContext,
  type WorkItem,
} from '../work-items';
import type { ClaimSpecRecord } from './claim-spec-store';
import { resolveClaimSpecWorkspace } from './claim-spec-workspace';
import {
  matchesClaimSpecFilter,
  matchesWorkItemClaimSpec,
  type ClaimSpecSubject,
} from './claim-spec-match';
import { claimSpecFilterToClaimablePayloadFilter } from './claim-spec-payload-filter';
import { claimSpecReferencesField, formatSpecRef, type ClaimSpec } from './claim-spec';
import { boundedPgReadTxn, PG_READ_QUERY_CALL_OVERHEAD_MS } from '../pg-read-query';
import { interpretFleetClaimability } from '../fleet/lane-health';
import {
  mintLegacyFleetScopeDowngradeAdmission,
  readFleetScopeDowngradeMarker,
  type LegacyFleetScopeDowngradeAdmission,
} from '../work-item-fleet-scope-recovery';

/**
 * EI-19393442073558754: pull the `kind in [...]` / `kind = ...` leaf's value out of a claim spec's
 * view filter (top-level or nested one level inside an `all`) — the SAME shape
 * `specKindFilterValues` in agent-tools/scheduler/get_next.ts extracts (duplicated
 * here rather than imported, to avoid a fleet-scope-admission -> agent-tools import
 * edge for one small pure walk; `ISSUE_FAMILY_KINDS` above IS the shared canonical
 * kind set, imported from `../work-items` rather than re-declared).
 */
function specKindFilterValues(spec: unknown): string[] | undefined {
  const view = (spec as { view?: { filter?: unknown } } | undefined)?.view;
  const filter = view?.filter as { field?: string; op?: string; value?: unknown; all?: unknown[] } | undefined;
  if (!filter) return undefined;
  const candidates = Array.isArray(filter.all) ? filter.all : [filter];
  for (const c of candidates) {
    const cl = c as { field?: string; op?: string; value?: unknown };
    if (cl?.field === 'kind' && cl?.op === 'in' && Array.isArray(cl.value)) {
      return cl.value.filter((v): v is string => typeof v === 'string');
    }
    if (cl?.field === 'kind' && cl?.op === '=' && typeof cl.value === 'string') {
      return [cl.value];
    }
  }
  return undefined;
}

/**
 * EI-19393442073558754: true when the spec's OWN kind filter (if any) restricts
 * EXCLUSIVELY to issue-family kinds (bug/change/task) — i.e. an issue-family
 * `matchedByFilter: 0` genuinely means "this spec matches nothing", since the
 * issue family is the ONLY family such a spec could ever reach. False when the
 * filter has no kind restriction at all (both families structurally reachable —
 * the `fleet:launch-on-plan` plan-scoped shape with no `claimKinds`, D-009) or
 * explicitly includes a non-issue kind: in either case a bare issue-family zero
 * is EXPECTED BY CONSTRUCTION, not evidence the spec itself is mis-authored. See
 * `nonIssueSpecEmpty` in {@link fleetScopedMiss} for what this gates.
 */
function specIsIssueFamilyOnly(spec: unknown): boolean {
  const kinds = specKindFilterValues(spec);
  if (!kinds || kinds.length === 0) return false;
  const issueKinds = new Set<string>(ISSUE_FAMILY_KINDS);
  return kinds.every((k) => issueKinds.has(k));
}

/**
 * EI-19393442073558754: true when the spec's filter tree references `plan` or
 * `plan_item` ANYWHERE (top-level or nested under `all`/`any`/`not`). A plan/
 * plan-item predicate is the SPECIFIC, structurally-understood mechanism behind
 * the false-alarm class this gates: `plans:start` promotion always mints a
 * FEATURE-family row for a plan item unless the item's own kind is bug/change/
 * task (D-009), so a plan-scoped spec routinely and correctly matches 0
 * issue-family rows while genuinely admitting feature-family work — that is
 * EXPECTED, not a spec-authoring bug. Deliberately narrower than "any filter
 * with no kind restriction": an id/tag/title-only filter has no such documented
 * family correlation, so those keep the loud `specEmpty` escalation (a stale id
 * allowlist genuinely does mean the spec is broken, per EI-18663622382734446).
 */
function specHasPlanPredicate(spec: unknown): boolean {
  function walk(node: unknown): boolean {
    if (node === null || typeof node !== 'object') return false;
    const obj = node as { field?: unknown; all?: unknown; any?: unknown; not?: unknown };
    if (typeof obj.field === 'string') return obj.field === 'plan' || obj.field === 'plan_item';
    if (Array.isArray(obj.all)) return obj.all.some(walk);
    if (Array.isArray(obj.any)) return obj.any.some(walk);
    if ('not' in obj) return walk(obj.not);
    return false;
  }
  const view = (spec as { view?: { filter?: unknown } } | undefined)?.view;
  return walk(view?.filter);
}

export interface FleetScopeContext {
  ownerId: string;
  fleetSlug: string;
  fleetRole: 'member';
  record: ClaimSpecRecord;
  /** EI-16710: the CONCRETE workspace this scope was resolved under (the same
   *  one `resolveFleetScopeContext` validated via `resolveClaimSpecWorkspace`
   *  before it would even return a non-null scope). Every scope-matching check
   *  must key off THIS value, never the ambient `activeWorkspaceId()` — see
   *  `featureMatchesRecord` for why. */
  workspaceId: string;
}

export type FleetScopeAdmission =
  | { allowed: true; scoped: false }
  | {
      allowed: true;
      scoped: true;
      scope: FleetScopeContext;
      /** Opaque leader authorization for one exact legacy downgrade marker. */
      legacyFleetScopeDowngradeAdmission?: LegacyFleetScopeDowngradeAdmission;
    }
  | {
      allowed: false;
      scoped: true;
      code: 'fleet_scope_missing' | 'fleet_scope_violation' | 'fleet_winding_down';
      reason: string;
      scope: FleetScopeContext;
      /** Server-derived original author, when the refused subject is an existing work-item. */
      reporter?: string | null;
    };

export type FleetDependencyEscapeCall = {
  tool: string;
  args: Record<string, unknown>;
};

/**
 * Typed, persisted escape contract for a blocker the fleet member cannot claim
 * because the blocker sits outside its lane. The member keeps its held work;
 * the leader chooses exactly one route for the dependency.
 */
export interface FleetDependencyEscape {
  kind: 'dependency_escape';
  dependency: { id: string; kind: string };
  blockedHeldItems: Array<{ id: string; kind: string; harness: string | null }>;
  blockedHeldItemIds: string[];
  member: string;
  ownershipPreserved: true;
  routes: [
    {
      kind: 'spec_widen';
      calls: [FleetDependencyEscapeCall, FleetDependencyEscapeCall];
    },
    {
      kind: 'outside_lane_placement';
      substitute: { liveNonMemberAssignee: string };
      calls: [FleetDependencyEscapeCall, FleetDependencyEscapeCall];
    },
    {
      kind: 'leader_claim';
      calls: [FleetDependencyEscapeCall];
    },
  ];
}

/**
 * PURE: the FENCE-PRESERVING widen — admit one more id WITHOUT tearing down the filter
 * that is already there.
 *
 * WHY THIS IS A NAMED, SHARED HELPER (EI-21906739799895413): this composition is the ONE
 * answer to "my lane is plan-scoped but this ad-hoc row has to go somewhere", and it
 * existed here for a while as an inline expression reachable only from the verified
 * dependency-edge path. The generic refusal — the seam an author actually hits — offered
 * prose instead ("…whose view.filter admits this work"), so the author had to invent the
 * syntax. Measured: a leader guessed `{ op:'any', of:[...] }`, was refused "unknown filter
 * op 'any'", and concluded from that single refusal that the DSL has NO boolean
 * composition at all — filing this bug asking for a disjunction that has always existed.
 * Four blocked calls and two idled agents came out of a shape nobody could name.
 *
 * Two properties make it the right default, and both are why prose could not substitute:
 *  - it KEEPS the existing fence (`{ any: [ <current>, <id leaf> ] }`), so a leader is not
 *    forced to choose between admitting one row and holding the whole plan scope; and
 *  - a bare `id` leaf when there is no current filter, so the no-fence case stays trivial.
 *
 * NOT a licence to widen per-row: see the class-refusal guard at the call site, which
 * withholds this when the spec is refusing a CLASS rather than a row.
 */
export function fencePreservingWidenFilter(
  currentFilter: ClaimSpec['view']['filter'],
  subjectId: string,
): ClaimSpec['view']['filter'] {
  const idLeaf = { field: 'id' as const, op: '=' as const, value: subjectId };
  return currentFilter ? { any: [currentFilter, idLeaf] } : idLeaf;
}

/** PURE: turn a verified dependency edge into the three executable recovery routes. */
export function buildFleetDependencyEscape(args: {
  admission: Extract<FleetScopeAdmission, { allowed: false }>;
  context: HeldDependencyEscapeContext;
  harness?: string | null;
}): FleetDependencyEscape {
  const { admission, context } = args;
  const current = admission.scope.record.spec;
  const currentFilter = current.view.filter;
  const proposed: ClaimSpec = {
    ...current,
    specId: admission.scope.record.source === 'default'
      ? `${admission.scope.fleetSlug}-lane`
      : current.specId,
    revision: current.revision + 1,
    view: {
      ...current.view,
      filter: fencePreservingWidenFilter(currentFilter, context.dependencyId),
    },
  };
  const scopedHarness = args.harness?.trim() || undefined;
  const harnessArg = scopedHarness ? { harness: scopedHarness } : {};
  const outsideAssignee = '<live-non-member-owner-id>';
  return {
    kind: 'dependency_escape',
    dependency: { id: context.dependencyId, kind: context.dependencyKind },
    blockedHeldItems: context.blockedHeldItems,
    blockedHeldItemIds: context.blockedHeldItems.map((item) => item.id),
    member: admission.scope.ownerId,
    ownershipPreserved: true,
    routes: [
      {
        kind: 'spec_widen',
        calls: [
          {
            tool: 'scheduler:preview_spec_delta',
            args: { fleet: admission.scope.fleetSlug, proposed, ...harnessArg },
          },
          {
            tool: 'scheduler:set_claim_spec',
            args: { fleet: admission.scope.fleetSlug, spec: proposed, ...harnessArg },
          },
        ],
      },
      {
        kind: 'outside_lane_placement',
        substitute: { liveNonMemberAssignee: outsideAssignee },
        calls: [
          {
            tool: 'work_items:claim',
            args: { id: context.dependencyId, assignee: outsideAssignee, ...harnessArg },
          },
          {
            tool: 'coord:send',
            args: {
              to: [outsideAssignee],
              expects: 'action',
              wake: 'required',
              body: [{
                text: `Claim dependency ${context.dependencyId}; it blocks ${context.blockedHeldItems.map((item) => item.id).join(', ')} held by ${admission.scope.ownerId}.`,
                forYouBecause: { relation: 'owns', ref: context.dependencyId },
              }],
            },
          },
        ],
      },
      {
        kind: 'leader_claim',
        calls: [{
          tool: 'work_items:claim',
          // No assignee on purpose: invoked by the fleet leader, this bypasses the
          // MEMBER-only lane without changing/releasing the blocked member's claim.
          args: { id: context.dependencyId, ...harnessArg },
        }],
      },
    ],
  };
}

export function renderFleetDependencyEscape(escape: FleetDependencyEscape): string {
  return (
    `DEPENDENCY ESCAPE: ${escape.dependency.id} (${escape.dependency.kind}) blocks held ` +
    `${escape.blockedHeldItemIds.join(', ')} for ${escape.member}; ownership is preserved. ` +
    'Choose one typed route from dependencyEscape.routes: preview+apply spec_widen, place with a live ' +
    'non-member and wake them, or have the fleet leader claim the dependency directly.'
  );
}

/** Resolve only MEMBER scope. Leaders supervise fleets but do not consume their member lane. */
export async function resolveFleetScopeContext(
  ownerIdOrName: string,
  workspaceId?: string | null,
): Promise<FleetScopeContext | null> {
  // Lazy seams keep assignment-tool unit tests from loading the entire scheduler /
  // coord graph merely because they import a handler. The calls still reuse the
  // canonical stores; only module evaluation is deferred until admission is needed.
  const { latestFleetMembership } = await import('../fleet-membership-store');
  const { listFleetAssignments } = await import('../fleet/assignments');
  const ws = resolveClaimSpecWorkspace(workspaceId);
  // No specific workspace (null / '*' / empty) ⇒ no fleet-member scope to resolve.
  if (!ws) return null;
  let ownerId = ownerIdOrName;
  // A failed authority read is UNKNOWN, never evidence of an unscoped caller.
  let membership = await latestFleetMembership(ws, ownerId);

  // plan_items:assign addresses a stable agent-name. Resolve it through the
  // canonical assignment/presence view before consulting append-only membership.
  if (!membership?.fleetSlug) {
    const rows = await listFleetAssignments({ workspaceId: ws, agent: ownerIdOrName, activeOnly: true });
    const row = rows.find((r) => r.agentId && r.fleetSlug && r.fleetRole === 'member');
    if (row?.agentId) {
      ownerId = row.agentId;
      membership = { fleetSlug: row.fleetSlug ?? null, fleetRole: row.fleetRole ?? null };
    }
  }

  if (!membership?.fleetSlug || membership.fleetRole !== 'member') return null;
  const { getClaimSpecRecord } = await import('./claim-spec-store');
  const record = await getClaimSpecRecord({ cupId: ownerId, workspaceId: ws });
  return { ownerId, fleetSlug: membership.fleetSlug, fleetRole: 'member', record, workspaceId: ws };
}

/**
 * EI-16710: takes `workspaceId` EXPLICITLY — never resolve it ambiently via
 * `activeWorkspaceId()` here. This function is reached through
 * `reconcileFleetScopeClaims`/`admitWorkItemForFleetTarget`, both of which
 * already threaded a caller-supplied, request-scoped workspaceId all the way
 * down to build `scope` — falling back to the process-ambient resolver at the
 * very last SQL call silently re-introduces the "wrong workspace" class
 * per-window-workspace-context (P-021) exists to kill: a caller whose request
 * carried the RIGHT workspace still gets evaluated against whatever
 * `activeWorkspaceId()` happens to resolve to (a different ALS layer, the
 * process-global default, ...), so a genuinely in-scope item spuriously
 * fails the match and reconcileFleetScopeClaims wrongly releases (and
 * re-arms the release-cooldown floor on) a fleet member's own valid claim —
 * every single call, since nothing about the mismatch ever self-corrects.
 */
async function featureMatchesRecord(
  item: WorkItem,
  record: ClaimSpecRecord,
  workspaceId: string,
): Promise<boolean> {
  const { sql } = getOrgPg();
  const { compileFilter } = await import('./get-next');
  const filter = compileFilter(sql, record.spec.view.filter);
  const rows = await sql<{ matched: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
        FROM harness_shared.harness_features_consolidated
       WHERE workspace_id = ${workspaceId}
         AND feature_id = ${item.id}
         AND ${item.harness ? sql`harness_slug = ${item.harness}` : sql`TRUE`}
         AND ${filter}
    ) AS matched`;
  return Boolean(rows[0]?.matched);
}

async function itemMatchesScope(item: WorkItem, scope: FleetScopeContext): Promise<boolean> {
  if (item.family === 'feature') return featureMatchesRecord(item, scope.record, scope.workspaceId);
  return matchesWorkItemClaimSpec(item, scope.record.spec);
}

/**
 * EI-18732199386440540: a fleet whose claim spec is scoped to its plan's item set
 * cannot absorb the FALLOUT BUGS THE FLEET ITSELF FILES mid-run.
 *
 * The live repro (fleet mail-retirement, 2026-07-26): a member finished its lane, ran
 * the affected suite, found the fleet's own plan had turned a test RED, filed the bug —
 * and then could not claim the item it had just created, because a freshly-filed EI
 * carries no plan/plan_item stamp and so matches neither branch of
 * {@link itemMatchesScope}. A fleet doing removal/refactor work GENERATES fallout; that
 * is the normal case, not an edge case, and today every instance costs a leader
 * round-trip while the shared gate stays red.
 *
 * WHY THIS IS SAFER THAN THE REFUSAL IT REPLACES — the refusal never prevented the
 * work, only its ATTRIBUTION. `fleet:launch-on-plan` says so in its own words when it
 * refuses a kickoff/spec mismatch (launch-on-plan.ts): a member that cannot claim
 * "would do the work anyway unclaimed: assignee stays NULL, fleet:assignments shows it
 * holding nothing, and the death-resilience reclaim-on-death net never engages". So the
 * status quo buys no containment; it just loses the ledger edge and the reclaim net.
 *
 * WHY `createdBy` AND NOT A NEW PROVENANCE STAMP: `createdBy` is server-derived from
 * the calling identity — persisted as engineer_issues.created_by after creation, and
 * passed directly from resolveAgentIdentity during atomic create+assign admission.
 * It is never caller-supplied, so a member cannot forge it in its payload — the
 * property a `foundDuring`-style free-text match could not offer. It is issue-family
 * only (feature rows are always null), which is exactly the population that can be
 * filed mid-run anyway.
 *
 * DELIBERATELY NARROW — `kind === 'bug'` only. A member may absorb something it filed
 * as BROKEN; it may not file itself a `change`/`feature` and thereby self-authorize
 * out-of-lane work. Widening past `bug` is a real decision about lane containment and
 * should be made on its own evidence, not inherited from this fix.
 *
 * ORDERING IS LOAD-BEARING: this is consulted only AFTER the winding-down gate
 * (EI-12832 — a paused fleet takes no new work whatever its spec says). For a
 * `source === 'default'` record it is the only exception to `denyMissing`, and it
 * remains narrow to a server-attributed self-filed bug; peer/non-bug items still
 * receive the no-spec refusal.
 */
export function selfFiledFalloutAdmission(
  item: {
    kind: ClaimSpecSubject['kind'];
    createdBy: WorkItem['createdBy'];
  },
  scope: FleetScopeContext,
): boolean {
  if (item.kind !== 'bug') return false;
  if (!item.createdBy) return false;
  return item.createdBy === scope.ownerId;
}

/**
 * EI-20426366154081065: the sentence a refused member reads when it filed the item
 * itself but under a kind the carve-out does not admit.
 *
 * THE DEFECT THIS REPLACES — the refusal PUBLISHED ITS OWN BYPASS, and the bypass was
 * the dangerous path. The previous wording ended `File genuine fallout as a bug, or ask
 * the leader to widen the spec.`, which reads as a one-call fix under an agent's bias
 * toward unblocking itself. Measured twice in 45 minutes on 2026-08-14, both routed to
 * one fleet leader: at 10:18:45Z su-6843fb67 was refused on a kind:'task' row, took the
 * suggestion, re-filed the same work as kind:'bug' (WI-38771) — and it PASSED, because
 * {@link selfFiledFalloutAdmission} asks only `kind === 'bug' && createdBy === self`.
 * Had they then acted on it they would have fired `release:checkpoint-run` during a live
 * auto-refire window, discarding the rescue and costing the fleet a fresh ~55min suite
 * (green-checkpoint.ts's own stand-down warning). Only a leader wake at 10:26:49Z stopped
 * it; the same sequence began again at 11:00Z with a different agent.
 *
 * So the failure mode was not "blocks useful work". It was: block the SAFE framing (own
 * the tracked incident, with its history), while recommending a re-file that produces the
 * UNSAFE one (a fresh row carrying none of that history, whose obvious next action
 * destroys a running rescue). A guard that routes people from the safe path to the
 * dangerous path is worse than one that simply refuses.
 *
 * WHY THE TEXT AND NOT THE PREDICATE: the loophole is inherent to the carve-out — no
 * server-derived field distinguishes "I found this broken" from "I want to do this", so
 * any member can self-authorize out-of-lane work by choosing kind:'bug'. Narrowing the
 * predicate would break the live repro the carve-out exists for (EI-18732199386440540:
 * a fleet must absorb the fallout bugs it files mid-run). What turns a latent loophole
 * into an actively-walked path is the advertisement, which is what this removes.
 *
 * Returns '' when the hint does not apply, so the caller can concatenate unconditionally.
 */
export function selfFiledKindRefusalHint(
  item: {
    kind: ClaimSpecSubject['kind'];
    createdBy: WorkItem['createdBy'];
  },
  scope: FleetScopeContext,
): string {
  if (!item.createdBy || item.createdBy !== scope.ownerId) return '';
  if (item.kind === 'bug') return '';
  return (
    ` (you filed this item as kind:'${item.kind}', and the self-filed carve-out admits kind:'bug' only. ` +
    `Do NOT re-file the same work as a bug to get past this check — the carve-out is for fallout you found ` +
    `ALREADY BROKEN while working your own lane, so a relabel both self-authorizes out-of-lane work and ` +
    `strands this row's context on a duplicate the next actor then acts on blind. Take one of the routes ` +
    `below instead: have the leader widen the lane, or do the work WITHOUT holding the row — the item stays ` +
    `filed and unassigned on the ledger for whichever lane next admits it.)`
  );
}

/**
 * EI-203723: a fleet leader may dispatch an explicitly assigned issue-family
 * item to a member even when the member's claim spec is narrower than that item.
 *
 * `assignedBy` is server-derived when the item is created or assigned, so the
 * exception is tied to durable delegation provenance rather than a caller's
 * claim about who authorized the work. The leader is read from the durable
 * fleet registry on every admission; a stale former leader, a peer, or a
 * degraded registry read never widens a member's lane.
 */
export async function leaderDispatchedAdmission(
  item: Pick<WorkItem, 'assignedBy'>,
  scope: FleetScopeContext,
): Promise<boolean> {
  if (!item.assignedBy) return false;
  const { getFleet } = await import('../agent-fleets-store');
  const fleet = await getFleet(scope.workspaceId, scope.fleetSlug).catch(() => null);
  return Boolean(fleet?.leaderOwnerId && fleet.leaderOwnerId === item.assignedBy);
}

/**
 * EI-226378: derive the one recovery capability that may cross the born-pending
 * floor for an old fleet-scope downgrade row.
 *
 * The marker is durable evidence, not authorization. Authorization is re-derived
 * from the current member scope, active fleet state, and the current durable fleet
 * leader. The requested target must be the exact target that resolved to this member
 * (allowing the stable name and canonical owner id aliases used by dispatch), and
 * the marker reporter must still be the current leader. The returned object is
 * WeakSet-backed and therefore cannot be forged by copying the marker fields.
 */
export async function deriveLegacyFleetScopeDowngradeAdmission(
  item: Pick<WorkItem, 'id' | 'payload' | 'createdBy'>,
  target: string,
  scope: FleetScopeContext,
  actor?: string | null,
): Promise<LegacyFleetScopeDowngradeAdmission | null> {
  const marker = readFleetScopeDowngradeMarker(item.payload);
  if (!marker) return null;
  if (marker.fleet !== scope.fleetSlug) return null;
  if (marker.requestedAssignee !== target && marker.requestedAssignee !== scope.ownerId) return null;
  if (!item.createdBy || marker.reportedBy !== item.createdBy) return null;

  const { getFleet } = await import('../agent-fleets-store');
  const fleet = await getFleet(scope.workspaceId, scope.fleetSlug).catch(() => null);
  if (fleet?.controlState === 'winding-down') return null;
  const leaderOwnerId = fleet?.leaderOwnerId?.trim();
  if (!leaderOwnerId || marker.reportedBy !== leaderOwnerId || actor !== leaderOwnerId) return null;

  return mintLegacyFleetScopeDowngradeAdmission({
    ...marker,
    itemId: item.id,
    target,
    workspaceId: scope.workspaceId,
    leaderOwnerId,
  });
}

/**
 * EI-18862608742257943: the same feature/issue-family branch as {@link itemMatchesScope},
 * but against a RAW `ClaimSpec` rather than a live {@link FleetScopeContext} — usable
 * BEFORE any bee has joined a fleet, when there is no membership row for
 * `resolveFleetScopeContext` to resolve. Reused by `fleet:launch-on-plan`'s pre-launch
 * check: does the claim spec this launch is ABOUT TO APPLY actually admit the
 * work-item(s) the leader's own kickoff brief names? (The bug this closes: a member
 * launched with a kickoff naming ONE work-item as "your only job" could not claim it —
 * the free-text brief and the enforced claim spec were authored independently and
 * nothing reconciled them, so the member did the work unclaimed: `assignee` stayed
 * NULL, `fleet:assignments` showed it holding nothing, and the death-resilience net
 * never engaged.) A minimal stub `ClaimSpecRecord` is built inline — only `.spec` is
 * ever read by `featureMatchesRecord`, so the other fields are placeholders.
 */
export async function itemMatchesRawClaimSpec(
  item: WorkItem,
  spec: ClaimSpecRecord['spec'],
  workspaceId: string,
): Promise<boolean> {
  if (item.family === 'feature') {
    return featureMatchesRecord(
      item,
      { source: 'fleet', spec, revision: null, updatedBy: null, updatedAt: null },
      workspaceId,
    );
  }
  return matchesWorkItemClaimSpec(item, spec);
}

function denyMissing(scope: FleetScopeContext): FleetScopeAdmission {
  return {
    allowed: false,
    scoped: true,
    code: 'fleet_scope_missing',
    scope,
    reason:
      `fleet member ${scope.ownerId} belongs to '${scope.fleetSlug}' but has no explicit per-member or inherited fleet claim spec; ` +
      'assignment refused instead of falling through to the generic backlog',
  };
}

/**
 * EI-12832: while a fleet is paused (control_state='winding-down', set by
 * fleet:pause / fleet:wind-down), a member must NOT acquire NEW work — not via a
 * direct by-id claim, not via a leader/self assign, not via a self-select pull.
 *
 * The prior gap: the winding-down state floored the SELECT-side (get_next), but a
 * member parked on `events:await('work-item:claimable')` from before the pause
 * would still be woken by a peer's compliant stand-down release and then claim the
 * released item by id — the claim path only checked spec-match (in-spec ⇒ passed),
 * never the fleet's control state — so a release performed BECAUSE of the pause
 * recruited the next member (observed live 2026-07-15, fleet
 * nonp2p-bug-drain-0715).
 *
 * Consulting the durable registry control state (mig 575) at every fleet-scope
 * admission seam closes the class: a refusal here reaches work_items:claim,
 * plan_items:assign, and work_items:create's assign-on-create. Returns the loud,
 * leader-addressed refusal when winding-down, else null (allowed).
 *
 * FAIL-OPEN: an unresolvable workspace or a control-state read error returns null
 * (allowed). A registry-read hiccup must never wedge normal claiming — the pause
 * gate is a floor on new work, not a hard dependency of the claim path.
 */
export async function readFleetPauseState(
  scope: FleetScopeContext,
  workspaceId?: string | null,
): Promise<{ windingDown: boolean; reason: string | null }> {
  const ws = resolveClaimSpecWorkspace(workspaceId);
  if (!ws) return { windingDown: false, reason: null };
  const { getFleet } = await import('../agent-fleets-store');
  const fleet = await getFleet(ws, scope.fleetSlug);
  if (fleet?.controlState !== 'winding-down') return { windingDown: false, reason: null };
  return { windingDown: true, reason: fleet.controlReason };
}

/** The admission-seam form: a loud, leader-addressed refusal when paused, else null. */
export async function fleetControlWindDownRefusal(
  scope: FleetScopeContext,
  workspaceId?: string | null,
): Promise<Extract<FleetScopeAdmission, { allowed: false }> | null> {
  const { windingDown, reason } = await readFleetPauseState(scope, workspaceId);
  if (!windingDown) return null;
  return {
    allowed: false,
    scoped: true,
    code: 'fleet_winding_down',
    scope,
    reason:
      `fleet '${scope.fleetSlug}' is winding-down (paused${reason ? `: ${reason}` : ''}); ` +
      `member ${scope.ownerId} may not acquire NEW work until a fleet:resume (control_state=active) lands. ` +
      'A release performed as part of the stand-down must not recruit the next member',
  };
}

export async function admitWorkItemForFleetTarget(args: {
  target: string;
  workItemId: string;
  harness?: string;
  workspaceId?: string | null;
  /** Server-derived caller identity; required for legacy leader recovery. */
  actor?: string | null;
}): Promise<FleetScopeAdmission> {
  const scope = await resolveFleetScopeContext(args.target, args.workspaceId);
  if (!scope) return { allowed: true, scoped: false };
  // EI-12832: a paused fleet's member takes no NEW work, whatever its spec says.
  const paused = await fleetControlWindDownRefusal(scope, args.workspaceId);
  if (paused) return paused;
  const { getWorkItem } = await import('../work-items');
  const item = await getWorkItem(args.workItemId, args.harness);
  const legacyFleetScopeDowngradeAdmission = item
    ? await deriveLegacyFleetScopeDowngradeAdmission(item, args.target, scope, args.actor)
    : null;
  if (legacyFleetScopeDowngradeAdmission) {
    return {
      allowed: true,
      scoped: true,
      scope,
      legacyFleetScopeDowngradeAdmission,
    };
  }
  // A fleet with no authored spec may still absorb a bug it filed itself. Read the
  // server-backed item before the no-spec refusal so this narrow provenance exception
  // applies to by-id claims too; peer-filed and non-bug items remain denied.
  if (scope.record.source === 'default') {
    if (item && selfFiledFalloutAdmission(item, scope)) {
      return { allowed: true, scoped: true, scope };
    }
    return denyMissing(scope);
  }
  if (!item) return { allowed: true, scoped: true, scope }; // the claim seam returns not_found
  if (await itemMatchesScope(item, scope)) return { allowed: true, scoped: true, scope };
  // EI-18732199386440540: a fleet absorbs the fallout bugs it filed itself. For an
  // authored spec this is consulted AFTER normal scope matching; for source:'default'
  // it is the narrow exception handled immediately above. The winding-down gate keeps
  // precedence in both cases. See selfFiledFalloutAdmission for why `createdBy` (not
  // a caller-supplied field) and why `bug` only.
  if (selfFiledFalloutAdmission(item, scope)) return { allowed: true, scoped: true, scope };
  if (await leaderDispatchedAdmission(item, scope)) return { allowed: true, scoped: true, scope };
  return {
    allowed: false,
    scoped: true,
    code: 'fleet_scope_violation',
    scope,
    // Preserve the item's server-derived author for the caller-facing refusal hint. A
    // cross-fleet tracker can be completed without acquiring the item, but only when the
    // claimant knows which reporter can close the ledger row against the result.
    reporter: item.createdBy,
    reason:
      `work-item ${item.id} does not match ${formatSpecRef(scope.record.spec.specId, scope.record.spec.revision)} ` +
      `for fleet '${scope.fleetSlug}'` +
      // Tell a refused member WHY the self-filed carve-out did not apply, so the next
      // move is obvious instead of a leader round-trip to find out. EI-20426366154081065:
      // the wording is load-bearing and lives in `selfFiledKindRefusalHint` — the earlier
      // inline text recommended a re-file that PASSES this very carve-out, i.e. the guard
      // published its own bypass, and the bypass was the dangerous path.
      selfFiledKindRefusalHint(item, scope),
  };
}

/**
 * EI-21659493450381888: the loop's optional auto-claim must honor an authored
 * scheduler spec even when the caller is not a named fleet member. The existing
 * fleet admission seam intentionally returns `scoped:false` for a solo caller,
 * which is correct for the deliberate `work_items:claim` by-id override but was
 * too wide for a cold loop's goal-detected candidate: a per-cup plan-only spec
 * could exclude the candidate while loop:arm still claimed it directly.
 *
 * `enforceSchedulerSpec` is supplied only for an AUTO-DETECTED candidate. An
 * explicit loop `workItem` remains the deliberate by-id override for solo callers;
 * named-fleet members still pass through the existing fleet admission regardless.
 */
export type LoopWorkItemAdmission =
  | FleetScopeAdmission
  | {
      allowed: false;
      scoped: false;
      code: 'scheduler_spec_violation';
      reason: string;
      specId: string;
      revision: number | null;
    };

export async function admitWorkItemForLoopTarget(args: {
  target: string;
  workItemId: string;
  harness?: string;
  workspaceId?: string | null;
  enforceSchedulerSpec: boolean;
}): Promise<LoopWorkItemAdmission> {
  const fleetAdmission = await admitWorkItemForFleetTarget(args);
  // Named fleet membership is already evaluated against the effective bee/fleet
  // spec above. A refusal must remain authoritative, and an explicit solo pin is
  // intentionally not narrowed by the scheduler's self-select spec.
  if (!fleetAdmission.allowed || fleetAdmission.scoped || !args.enforceSchedulerSpec) return fleetAdmission;

  const workspaceId = resolveClaimSpecWorkspace(args.workspaceId);
  // An unscoped caller has no safe partition in which to read a per-cup spec. Keep
  // the pre-existing best-effort behavior rather than guessing a workspace here;
  // concrete scoped sessions take the guarded path below.
  if (!workspaceId) return fleetAdmission;

  const { getClaimSpecRecord } = await import('./claim-spec-store');
  const record = await getClaimSpecRecord({ cupId: args.target, workspaceId });
  // No authored per-cup/fleet spec means there is no narrower scheduler lane to
  // enforce. The scheduler's default ordering remains a valid solo override.
  if (record.source === 'default') return fleetAdmission;

  const { getWorkItem } = await import('../work-items');
  const item = await getWorkItem(args.workItemId, args.harness);
  // Preserve the existing not-found handling in claimWorkItem; this guard only
  // rejects a candidate whose current row proves it is outside the active spec.
  if (!item || (await itemMatchesRawClaimSpec(item, record.spec, workspaceId))) return fleetAdmission;

  return {
    allowed: false,
    scoped: false,
    code: 'scheduler_spec_violation',
    specId: record.spec.specId,
    revision: record.revision,
    reason:
      `work-item ${item.id} does not match active scheduler spec ${formatSpecRef(record.spec.specId, record.spec.revision)} ` +
      `for ${args.target}; the loop auto-claim was refused before mutation`,
  };
}

export async function admitSubjectForFleetTarget(args: {
  target: string;
  subject: ClaimSpecSubject;
  /** Server-derived creator identity for atomic create+assign; never caller input. */
  createdBy?: string | null;
  /** Server-derived delegator identity for atomic create+assign; never caller input. */
  assignedBy?: string | null;
  workspaceId?: string | null;
}): Promise<FleetScopeAdmission> {
  const scope = await resolveFleetScopeContext(args.target, args.workspaceId);
  if (!scope) return { allowed: true, scoped: false };
  // EI-12832: a paused fleet's member takes no NEW work, whatever its spec says.
  const paused = await fleetControlWindDownRefusal(scope, args.workspaceId);
  if (paused) return paused;
  // A fleet with no authored spec may still absorb a bug it filed itself. The creator
  // identity is server-derived, so this remains narrow: peer-filed and non-bug creates
  // still receive the normal no-spec refusal.
  if (scope.record.source === 'default') {
    if (
      selfFiledFalloutAdmission(
        { kind: args.subject.kind, createdBy: args.createdBy ?? null },
        scope,
      )
    ) {
      return { allowed: true, scoped: true, scope };
    }
    return denyMissing(scope);
  }
  if (matchesClaimSpecFilter(args.subject, scope.record.spec.view.filter)) {
    return { allowed: true, scoped: true, scope };
  }
  // The item does not exist yet on the atomic create+assign path, so apply the same
  // narrow predicate to the server-derived creator + requested kind. This keeps
  // work_items:create { kind:'bug', assign_to:'self' } atomic instead of filing the
  // fallout unassigned and requiring a second work_items:claim round-trip.
  if (
    selfFiledFalloutAdmission(
      { kind: args.subject.kind, createdBy: args.createdBy ?? null },
      scope,
    )
  ) {
    return { allowed: true, scoped: true, scope };
  }
  if (await leaderDispatchedAdmission({ assignedBy: args.assignedBy ?? null }, scope)) {
    return { allowed: true, scoped: true, scope };
  }
  return {
    allowed: false,
    scoped: true,
    code: 'fleet_scope_violation',
    scope,
    // The create+assign seam has no row yet, but its creator is server-derived and is the
    // same reporter that will be persisted if the item is downgraded to unassigned.
    reporter: args.createdBy ?? null,
    reason:
      `assignment does not match ${formatSpecRef(scope.record.spec.specId, scope.record.spec.revision)} ` +
      `for fleet '${scope.fleetSlug}'`,
  };
}

/**
 * WI-6326 (residual half of EI-18784357226895330): does ANY OTHER agent in this
 * fleet — the leader, or a different member — look genuinely reachable right now?
 * Reuses the SAME fleet_assignment-backed presence read fleet-idle-drain.ts's
 * `allFleetMembersIdle` already treats as this codebase's shared liveness oracle
 * (`present && alive`, the view's own heartbeat-freshness fields), rather than
 * inventing a second heuristic. Deliberately does NOT require `speaking`/recent
 * tool-call activity — an idle-but-alive parked agent is still a legitimate
 * routing target; the question here is reachability, not current activity.
 *
 * The incident this closes: a refused member found "route the work elsewhere"
 * unconditionally in the remedy text, checked coord:presence, and found the
 * fleet was themself plus one member idle 22h40m — no live target anywhere —
 * and had to escalate by hand to discover the exit was closed.
 *
 * FAILS SOFT (same philosophy as every other diagnosis in this file): any lookup
 * error, or an unresolvable workspace, returns null (UNKNOWN) rather than a false
 * negative — a liveness-check hiccup must never turn a refusal into a thrown
 * error, and 'unknown' degrades {@link fleetScopeLeaderRemedy} to its ORIGINAL
 * unconditional wording rather than asserting a live target does not exist.
 */
export async function hasLiveFleetRouteTarget(
  fleetSlug: string,
  workspaceId?: string | null,
  excludeOwnerId?: string,
): Promise<boolean | null> {
  try {
    const ws = resolveClaimSpecWorkspace(workspaceId);
    if (!ws) return null;
    const { listFleetAssignments, groupByAgent } = await import('../fleet/assignments');
    const rows = await listFleetAssignments({ workspaceId: ws });
    const members = groupByAgent(rows).filter(
      (a) => a.fleetSlug === fleetSlug && a.agentId !== excludeOwnerId,
    );
    return members.some((m) => m.present && m.alive);
  } catch {
    return null;
  }
}

/**
 * EI-18221674485894260: the CONCRETE, ready-to-run leader remedy for a fleet-scope
 * admission refusal. The prior notification said only "Re-steer the member's claim
 * spec or route the work elsewhere" — naming neither the TOOL nor the call shape, so
 * a leader who searched their toolset for the widen mechanism came up empty (the tool
 * DOES exist — `scheduler:set_claim_spec` — but ToolSearch/`tools:find` did not surface
 * it, and nothing in the refusal itself pointed at it), and every out-of-spec item then
 * needed manual leader intervention instead of a one-call re-steer. This turns the
 * refusal into that one-call widen action.
 *
 * Code-conditional: a `fleet_winding_down` refusal is NEVER widened — the fleet is
 * paused, so the member must stand down, and the remedy is `fleet:resume`, not a spec
 * bump. Pure (no I/O) so it is unit-testable and reused by the member-facing hint path
 * — `liveRouteTarget` is the CALLER's own I/O result ({@link hasLiveFleetRouteTarget}),
 * never fetched here, so this function itself stays synchronous/pure.
 *
 * WI-6326: `liveRouteTarget` is code-conditional on that presence read. `false` (no
 * live agent found anywhere in the fleet) replaces the unconditional "(Or route the
 * work elsewhere / complete it yourself.)" with an honest statement that the exit is
 * closed AND the concrete fallback that survives regardless (the item stays filed,
 * on the ledger, reachable by whichever lane/agent next admits it). `true` or
 * `null`/undefined (a live target exists, or the check could not run) keep the
 * original wording — an unknown result must never manufacture a false "no target"
 * claim.
 */
/**
 * EI-19484346966003625 (R1): is this spec refusing a CLASS, or just this one row?
 *
 * The refusal notice's only advice used to be "WIDEN the fleet lane … whose view.filter
 * admits THIS work", which trains a per-ROW patch. Measured cost of that framing, live on
 * fleet `opencode-omp-research`: the leader bumped its spec rev 1→6 over 42h, blocking one
 * member 12 times, and rev 6 still refused 4 of the 6 rows — because the dominant shape it
 * kept missing (`severity: minor`) was never what any single row's widen touched. Each
 * patch was a correct fix for the row in front of it and a non-fix for the class behind it.
 *
 * The pool-vs-spec reading that settles it already exists — `aggregateIssueClaimExclusions`
 * powers the MISS path (see {@link diagnoseFleetScopeIssueFloorMiss} / `fleetScopedMiss`).
 * The REFUSAL path simply never asked it, so the two seams answered the same question with
 * very different rigour. This runs the spec's OWN `view.filter` over the pool, and the same
 * aggregate again UNFILTERED (`filter: undefined`) for the denominator, so the notice can
 * state a ratio instead of implying the refusal is a one-off.
 *
 * ISSUE-FAMILY ONLY — that is what the aggregate covers. A spec scoping the feature family
 * reads as a low ratio here, which is why {@link fleetScopeClassRefusalNote} reports the two
 * counts and never certifies "your spec is wrong" on its own.
 *
 * FAIL-SOFT: any error, or an unresolvable workspace, returns null and the notice degrades
 * to exactly its previous wording. A diagnosis is an enrichment of a refusal that has
 * already been decided — it must never be able to change or block that refusal.
 */
export interface FleetScopeClassRefusal {
  /** Pool rows the spec's own `view.filter` MATCHES (before taken/floors). */
  matchedByFilter: number;
  /** Pool rows at all — the same aggregate with no spec filter. The denominator. */
  poolTotal: number;
  /** `matchedByFilter === 0`: the spec admits NOTHING, so no per-row widen can help. */
  specEmpty: boolean;
}

export async function diagnoseFleetScopeClassRefusal(args: {
  scope: FleetScopeContext;
  harness: string;
}): Promise<FleetScopeClassRefusal | null> {
  try {
    const spec = args.scope.record?.spec;
    if (!spec) return null;
    const { aggregateIssueClaimExclusions } = await import('./get-next');
    const opts = { harness: args.harness, states: spec.states, assignee: args.scope.ownerId };
    const [scoped, pool] = await Promise.all([
      aggregateIssueClaimExclusions(spec.view.filter, opts),
      aggregateIssueClaimExclusions(undefined, opts),
    ]);
    if (!scoped || !pool) return null;
    return {
      matchedByFilter: scoped.matchedByFilter,
      poolTotal: pool.matchedByFilter,
      specEmpty: scoped.matchedByFilter === 0,
    };
  } catch {
    return null;
  }
}

/**
 * EI-20263410682554156: a plan-scoped fleet lane becomes permanently empty when
 * its plan is shipped or superseded, but the claim spec remains valid and keeps
 * pointing at that terminal plan.  The ordinary zero-match diagnosis can name
 * the symptom without naming this cause, so inspect the plan lifecycle before
 * composing the leader remedy.
 *
 * This is deliberately a best-effort enrichment.  Admission has already been
 * decided by the caller; a plan-table read failure must preserve the refusal and
 * fall back to the generic spec-widen guidance rather than wedge claiming.
 */
export interface FleetScopeRetiredPlan {
  planSlug: string;
  status: 'shipped' | 'superseded';
}

/** Extract positive plan predicates from any nested filter branch. */
export function planPredicateValues(spec: unknown): string[] {
  const values = new Set<string>();
  function walk(node: unknown): void {
    if (node === null || typeof node !== 'object') return;
    const obj = node as { field?: unknown; op?: unknown; value?: unknown; all?: unknown; any?: unknown; not?: unknown };
    if (obj.field === 'plan' && (obj.op === '=' || obj.op === 'in')) {
      if (typeof obj.value === 'string') values.add(obj.value);
      if (Array.isArray(obj.value)) {
        for (const value of obj.value) if (typeof value === 'string') values.add(value);
      }
    }
    if (Array.isArray(obj.all)) obj.all.forEach(walk);
    if (Array.isArray(obj.any)) obj.any.forEach(walk);
    // A negated plan predicate does not pin a lane to that plan, so it cannot
    // explain why every candidate disappeared after that plan retired.
    // Do not recurse through `not` for this diagnosis.
  }
  walk((spec as { view?: { filter?: unknown } } | undefined)?.view?.filter);
  return [...values];
}

export async function diagnoseFleetScopeRetiredPlans(args: {
  scope: FleetScopeContext;
}): Promise<FleetScopeRetiredPlan[]> {
  const planSlugs = planPredicateValues(args.scope.record?.spec);
  if (planSlugs.length === 0) return [];
  try {
    const { sql } = getOrgPg();
    const rows = (await sql`
      SELECT plan_slug, status
        FROM harness_shared.harness_plans
       WHERE workspace_id = ${args.scope.workspaceId}
         AND plan_slug = ANY(${planSlugs}::text[])
         AND status = ANY(${['shipped', 'superseded']}::text[])
    `) as Array<{ plan_slug: string; status: string }>;
    return rows.flatMap((row) =>
      (row.status === 'shipped' || row.status === 'superseded') && typeof row.plan_slug === 'string'
        ? [{ planSlug: row.plan_slug, status: row.status }]
        : [],
    );
  } catch {
    return [];
  }
}

/**
 * EI-20260781488788952: determine whether every positive plan predicate in a
 * fleet member's spec points at a terminal plan. The row-level terminality
 * read below is intentionally narrower: it can miss a completed plan when the
 * plan's promoted rows belong to the other work-item family. This plan-level
 * read closes that blind spot without treating an unreadable/missing plan as
 * terminal.
 *
 * `allTerminal:false` is a useful, known negative: at least one bound plan is
 * still live. `null` means the diagnostic could not establish the answer and
 * must preserve the existing spec-miss wording (fail soft).
 */
export interface FleetScopePlanTerminality {
  planSlugs: string[];
  terminalPlanSlugs: string[];
  allTerminal: boolean;
}

export async function diagnoseFleetScopePlanTerminality(args: {
  scope: FleetScopeContext;
}): Promise<FleetScopePlanTerminality | null> {
  const planSlugs = planPredicateValues(args.scope.record?.spec);
  if (planSlugs.length === 0) return null;
  try {
    const { planTerminalityInWorkspace } = await import('../agent-tools/plans/source');
    const terminality = await Promise.all(
      planSlugs.map((slug) => planTerminalityInWorkspace(args.scope.workspaceId, slug)),
    );
    // A missing plan row, an unresolved owner, or a failed read is UNKNOWN —
    // never silently promote it to a completed mission.
    if (terminality.some((reading) => reading == null)) return null;
    const terminalPlanSlugs = planSlugs.filter((_, index) => {
      const reading = terminality[index]!;
      return reading.status === 'shipped' || reading.status === 'superseded' || !reading.hasOpenItems;
    });
    return { planSlugs, terminalPlanSlugs, allTerminal: terminalPlanSlugs.length === planSlugs.length };
  } catch {
    return null;
  }
}

/**
 * EI-20260781488788952: read the fleet's LEADER specifically, rather than
 * answering the weaker question "is anyone else alive?". The fleet registry's
 * `leaderOwnerId` is authoritative: one owner may lead several fleets while its
 * soft presence row can carry only ONE `fleetSlug`/`fleetRole` label
 * (EI-20379918871807679). Resolve that owner first, then ask the shared roster
 * liveness oracle whether the owner is present and alive without requiring the
 * presence label to match this fleet. A successful read with no live registered
 * leader is `false`; a registry/roster failure is unknown (`null`) so the old
 * escalation wording remains safe.
 */
export async function diagnoseFleetScopeLeaderLiveness(args: {
  scope: FleetScopeContext;
  /** Reuse the workspace roster snapshot already read during member reconciliation. */
  fleetAssignmentRows?: FleetAssignmentRow[];
}): Promise<boolean | null> {
  try {
    const ws = resolveClaimSpecWorkspace(args.scope.workspaceId);
    if (!ws) return null;
    const { getFleet } = await import('../agent-fleets-store');
    const fleet = await getFleet(ws, args.scope.fleetSlug);
    const leaderOwnerId = fleet?.leaderOwnerId ?? null;
    if (!leaderOwnerId) return false;
    const { listFleetAssignments, groupByAgent } = await import('../fleet/assignments');
    const rows =
      args.fleetAssignmentRows ??
      (await listFleetAssignments({ workspaceId: ws, agent: leaderOwnerId }));
    const leader = groupByAgent(rows).find((agent) => agent.agentId === leaderOwnerId);
    return Boolean(leader?.present && leader.alive);
  } catch {
    return null;
  }
}

/**
 * EI-21079515303301272: a member must not keep self-pulling an active fleet's
 * leader-owned terminal lane when the registry has no live leader.  This is a
 * recoverable control-plane block, not a drain verdict: the lane may still have
 * claimable work, but no live session can receive the completion/acceptance
 * transition or perform fleet wind-down.
 */
export function fleetLeaderUnavailableRefusal(scope: FleetScopeContext) {
  const fleet = scope.fleetSlug;
  return {
    ok: false as const,
    error: 'fleet_leader_unavailable' as const,
    reason: 'registered_leader_not_live' as const,
    retryable: true as const,
    noClaim: true as const,
    // Deliberately false: this is not evidence that the member lane is drained.
    windDown: false as const,
    recoverable: true as const,
    leaderLiveness: false as const,
    fleetScope: {
      fleet,
      member: scope.ownerId,
      specId: scope.record.spec.specId,
      revision: scope.record.spec.revision,
      source: scope.record.source,
    },
    message:
      `fleet '${fleet}' is active but has no live registered leader; member self-pull is blocked ` +
      'before claim so leader-owned acceptance/terminal work cannot be stranded.',
    recovery: {
      tool: 'fleet:take-leadership',
      args: { fleet },
      note:
        'Verify the former leader is gone, then take leadership through the audited handoff. ' +
        'Retry scheduler:get_next only after a live leader is registered; do not treat this as an empty queue.',
    },
    advice:
      `Recover '${fleet}' with fleet:take-leadership { fleet: "${fleet}" } (or another audited ` +
      'live-driver handoff), then retry scheduler:get_next. Keep existing held work intact while the ' +
      'leadership transition is made. Do not treat this as an empty queue or a successful drain.',
  };
}

/**
 * The CLASS sentence prepended to the leader remedy, or '' when the reading does not
 * support one. Deliberately conservative — it reports the two measured counts and lets the
 * leader judge, rather than asserting the spec is wrong:
 *
 *  - `specEmpty` (matches 0) is the one unambiguous case: a per-row widen provably cannot
 *    help, because the filter admits nothing at all.
 *  - a LOW ratio is stated as a ratio, with the class question posed, not answered.
 *  - a HIGH ratio, or a pool too small for the ratio to mean anything, yields '' — the
 *    refusal really may be a one-off, and a class warning there is noise that would teach
 *    leaders to ignore this line.
 */
export function fleetScopeClassRefusalNote(reading: FleetScopeClassRefusal | null | undefined): string {
  if (!reading) return '';
  const { matchedByFilter, poolTotal, specEmpty } = reading;
  if (specEmpty) {
    return (
      `⚠ CLASS REFUSAL — this spec's view.filter currently matches ZERO of the ${poolTotal} open issue-family ` +
      `row(s) in this harness, not merely this one. A revision bump shaped around THIS item cannot fix that: ` +
      `the filter admits nothing, so the next row will be refused too. Fix the filter's shape (kind / severity / ` +
      `plan / tag scoping), then re-check with scheduler:preview_spec_delta before bumping. `
    );
  }
  // Below ~half the pool, with enough rows for the ratio to carry information.
  if (poolTotal >= 10 && matchedByFilter * 2 < poolTotal) {
    return (
      `⚠ POSSIBLE CLASS REFUSAL — this spec's view.filter matches ${matchedByFilter} of ${poolTotal} open ` +
      `issue-family row(s), so it is refusing far more than the row in front of you. Before bumping a revision ` +
      `for THIS item, check whether the ${poolTotal - matchedByFilter} it excludes share a shape (a severity ` +
      `floor and a kind list are the two that recur) — widening per-row against a class costs a revision per ` +
      `row and still leaves the member blocked. scheduler:preview_spec_delta shows the delta before you commit it. `
    );
  }
  return '';
}

export function fleetScopeLeaderRemedy(
  admission: Extract<FleetScopeAdmission, { allowed: false }>,
  liveRouteTarget?: boolean | null,
  classRefusal?: FleetScopeClassRefusal | null,
  retiredPlans?: FleetScopeRetiredPlan[] | null,
  /** The refused work-item id, when the caller knows it (claim/create do). Lets the notice
   *  render an EXECUTABLE fence-preserving widen instead of describing one — see
   *  {@link fencePreservingWidenFilter}. Omitted: the wording degrades to the prose form. */
  subjectId?: string | null,
): string {
  const fleetSlug = admission.scope.fleetSlug;
  if (admission.code === 'fleet_winding_down') {
    return (
      `This fleet is PAUSED (winding-down) — do NOT widen its claim spec; the member must stand down. ` +
      `When you intend it to resume, lift the pause: fleet:resume { fleet: "${fleetSlug}" }.`
    );
  }
  const spec = admission.scope.record?.spec;
  const specRef = spec?.specId ? formatSpecRef(spec.specId, spec.revision) : 'the fleet lane (no authored spec yet — default)';
  const planScoped = specHasPlanPredicate(spec);
  const retiredPlanNote = retiredPlans?.length
    ? `⚠ RETIRED PLAN PIN — this spec still filters on ${retiredPlans
        .map((plan) => `'${plan.planSlug}' (status: ${plan.status})`)
        .join(', ')}. A shipped/superseded plan is terminal, so keeping it as the member's lane can match ZERO rows ` +
      `without the spec being malformed. Re-steer the fleet to a live plan (or another positive filter) with ` +
      `scheduler:set_claim_spec; do not keep bumping this revision for individual rows. `
    : '';
  // EI-21884167889601047: this note used to LEAD the refusal, ahead of the safer
  // "widen the lane" / "complete it yourself" remedies — the one-call fix reads as
  // THE intended path under an agent's bias toward unblocking itself, and the
  // "do not stamp a mere blocker" guard that followed it lost to that framing.
  // The stamp is not a neutral relabel: it creates a coverage edge, so closing the
  // plan item later auto-resolves the stamped work-item as residue — a false stamp
  // on a blocker silently makes the blocker disappear. Demoted to LAST, phrased as
  // a conditional test rather than an instruction, with the consequence stated
  // inline instead of left for the reader to infer at the decision point.
  const planStampNote = planScoped && !retiredPlans?.length
    ? (() => {
        const plans = planPredicateValues(spec);
        const planScope = plans.length
          ? plans.map((plan) => `'${plan}'`).join(', ')
          : 'a plan/plan-item predicate';
        const planSlug = plans.length === 1 ? `"${plans[0]}"` : '"<plan-slug>"';
        return (
          ` LAST RESORT — this member's lane is plan-scoped to ${planScope}. ONLY if the refused work-item's own ` +
          `body describes it as IMPLEMENTING one of that plan's items (never a blocker merely discovered while ` +
          `working the plan — leave that unlinked and route it via the options above instead), you may backfill ` +
          `it before changing the lane: work_items:update { id: "<work-item-id>", plan_item: { slug: ${planSlug}, ` +
          `item: "<P-NNN>" } } — the existing claim can then succeed without a spec revision. ⚠ CONSEQUENCE: the ` +
          `stamp creates a coverage edge, so closing that plan item later auto-resolves this work-item as residue ` +
          `even if its own work was never done — a wrong stamp on a blocker silently makes the blocker disappear.`
        );
      })()
    : '';
  // EI-21906739799895413: "…whose view.filter admits this work" describes a repair without
  // naming it, and the shape it omits is exactly the one authors cannot guess — a leader who
  // needs to keep a plan fence AND admit one ad-hoc row invented `{ op:'any', of:[...] }`,
  // read the resulting "unknown filter op 'any'" as proof the DSL has no disjunction, and
  // filed a bug asking for a feature that already shipped. Render the executable filter when
  // we know the id, so the notice ENDS the guessing instead of starting it.
  //
  // WITHHELD on a class refusal on purpose: `fleetScopeClassRefusalNote` leads the notice
  // telling the leader NOT to patch per-row (measured: rev 1→6 over 42h, still refusing),
  // and a concrete one-row widen printed underneath would license precisely what that
  // warning exists to stop. A class problem needs the filter's SHAPE fixed, not one more id.
  // Gate on the note this notice ACTUALLY emits, never on the raw reading: a plan-scoped
  // lane suppresses the class note entirely (a deliberate fence is SUPPOSED to match few
  // rows, so a low ratio is not evidence of a malformed filter there). Keying off the
  // reading instead would withhold the widen on precisely the plan-scoped refusal this
  // change exists to fix, while no class warning was printed either — prose and silence,
  // the worst of both. Computed once and reused below so the two can never drift apart.
  const classNote = planScoped ? '' : fleetScopeClassRefusalNote(classRefusal);
  const concreteWiden =
    subjectId && spec && !classNote
      ? JSON.stringify(fencePreservingWidenFilter(spec.view?.filter, subjectId))
      : null;
  const laneAction = retiredPlans?.length
    ? `RE-STEER the fleet lane in ONE call: ` +
      `scheduler:set_claim_spec { fleet: "${fleetSlug}", spec: { … a revision bump of ${specRef} ` +
      `whose view.filter points at a live plan (or another positive filter) and admits this work } }`
    : concreteWiden
      ? `WIDEN the fleet lane in ONE call, KEEPING the fence you already have — ` +
        `\`any\` is a top-level COMBINATOR key, not a leaf op, so this admits the row without ` +
        `abandoning the existing filter: scheduler:set_claim_spec { fleet: "${fleetSlug}", spec: ` +
        `{ … a revision bump of ${specRef} with view.filter = ${concreteWiden} } } ` +
        `(preview it first with scheduler:preview_spec_delta).` +
        (planScoped
          ? ` Your lane is PLAN-scoped, and an ad-hoc row carries no plan — so it can never match ` +
            `that fence on its own. Do NOT reach for plan_item stamping to force a match: the stamp ` +
            `creates a coverage edge, so closing the plan item later auto-resolves this row as residue ` +
            `even if its own work was never done.`
          : '')
      : `WIDEN the fleet lane in ONE call: ` +
        `scheduler:set_claim_spec { fleet: "${fleetSlug}", spec: { … a revision bump of ${specRef} ` +
        `whose view.filter admits this work } }`;
  const routeElsewhereNote =
    liveRouteTarget === false
      ? `Do NOT rely on "route the work elsewhere" — no other live agent (leader or member) was found in fleet ` +
        `'${fleetSlug}' right now. The work-item is NOT lost: it stays filed, unassigned, on the ledger — it will ` +
        `surface to whichever lane/agent next admits it — or complete it yourself.`
      : `(Or route the work elsewhere / complete it yourself.)`;
  // EI-20271090543139343: a tracker row may be deliberately out of the claimant's lane
  // because the actual deliverable is an independent tool call. When the server-derived
  // reporter is a different agent, expose that third route in the same refusal hint. Keep
  // it silent for self-authored rows (the reporter already owns the ledger decision) and
  // unknown authors (there is no safe recipient to name).
  const reporter = admission.reporter?.trim();
  const trackerNote =
    reporter && reporter !== admission.scope.ownerId
      ? `If this item only TRACKS work you can perform without holding it, do the work and ask the reporter ` +
        `(${reporter}) to close the item against your result.`
      : '';
  return (
    // EI-19484346966003625 (R1): the class reading LEADS, because it can invalidate the
    // per-row advice that follows it — a leader who reads only the first sentence must not
    // walk away with "bump a revision for this row" when the spec matches nothing.
    // Plan-scoped lanes are intentionally narrow: their exclusion ratio is not evidence of
    // a malformed class filter — but see EI-21884167889601047 below for why the plan-item
    // stamp itself is demoted to LAST rather than treated as the safe row-local remedy.
    `${retiredPlanNote}${classNote}` +
    `To let this member self-claim it, ${laneAction} — the member picks it up on its next scheduler:get_next, ` +
    `no re-dispatch. ${routeElsewhereNote}${trackerNote ? ` ${trackerNote}` : ''}${planStampNote}`
  );
}

export async function notifyFleetScopeRefusal(
  identity: AgentIdentity,
  admission: Extract<FleetScopeAdmission, { allowed: false }>,
  action: string,
  // EI-19484346966003625 (R1): the harness the refused subject belongs to, so the class
  // reading can be taken. OPTIONAL and additive — a caller that does not pass it gets
  // exactly the previous behaviour (classRefusal: null ⇒ empty note), never an error.
  //
  // EI-18680302159738037: `subject` names the refused item + member STRUCTURALLY, so
  // fleet:leader-brief can surface this block on the surface a leader actually reads
  // every wake instead of leaving it to be buried as ordinary inbox mail. Also
  // OPTIONAL and additive: a caller that omits it sends the byte-identical message
  // minus the stamp, and the reader SKIPS an unstamped row rather than prose-parsing
  // `action` — a guessed itemId on a leader's dashboard is worse than an absent one.
  opts?: { harness?: string | null; subject?: { itemId?: string | null; member?: string | null } },
): Promise<{
  liveRouteTarget: boolean | null;
  classRefusal: FleetScopeClassRefusal | null;
  dependencyEscape?: FleetDependencyEscape;
}> {
  // WI-6326: irrelevant while winding-down (that remedy branch never mentions
  // "route elsewhere" at all) — skip the extra lookup.
  const windingDown = admission.code === 'fleet_winding_down';
  const itemId = opts?.subject?.itemId?.trim() ?? '';
  const member = opts?.subject?.member?.trim() ?? '';
  const [liveRouteTarget, classRefusal, retiredPlans, dependencyContext] = await Promise.all([
    windingDown
      ? Promise.resolve(null)
      : hasLiveFleetRouteTarget(admission.scope.fleetSlug, admission.scope.workspaceId, admission.scope.ownerId),
    // A paused fleet's remedy is "stand down", never "widen" — a class reading there would
    // be measured, correct and actively misleading, so it is not taken at all.
    windingDown || !opts?.harness
      ? Promise.resolve(null)
      : diagnoseFleetScopeClassRefusal({ scope: admission.scope, harness: opts.harness }),
    windingDown ? Promise.resolve([]) : diagnoseFleetScopeRetiredPlans({ scope: admission.scope }),
    windingDown || !itemId || !member
      ? Promise.resolve(null)
      : import('../work-items')
          .then((m) => m.readHeldDependencyEscapeContext({
            dependencyId: itemId,
            // Admission has already resolved a stable agent name to the canonical
            // owner id. Query both because claimWorkItem stores explicit assignees
            // verbatim, so older held work may use either representation.
            member: admission.scope.ownerId,
            memberAliases: [member],
            harness: opts?.harness,
          }))
          .catch(() => null),
  ]);
  const dependencyEscape = dependencyContext
    ? buildFleetDependencyEscape({ admission, context: dependencyContext, harness: opts?.harness })
    : null;
  const { sendMessage } = await import('../agent-tools/coordination/messages');
  // Lazy, like every other agent-tools seam in this file: the constants live with
  // the READER (agent-tools/coordination), and a static edge would drag the coord
  // graph into every unit test that merely imports admission.
  const { FLEET_ADMISSION_BLOCK_CATEGORY, FLEET_ADMISSION_BLOCK_STAMP } = await import(
    '../agent-tools/coordination/fleet-scope-admission-blocks'
  );
  // EI-18680302159738037: stamp the block structurally alongside the prose. Only
  // when the caller named BOTH item and member — the reader requires the pair, so a
  // half stamp would be dead weight on the envelope.
  const stamp = itemId && member
    ? {
        [FLEET_ADMISSION_BLOCK_STAMP]: {
          itemId,
          member,
          specId: admission.scope.record.spec.specId,
          specRevision: admission.scope.record.spec.revision,
          code: admission.code,
          action,
          reason: admission.reason,
          ...(dependencyEscape ? { dependencyEscape } : {}),
          // EI-24439258189705130: the subject's harness, so the reader can revalidate
          // a bare WI-/F- id for a fleet with no claim spec (hence no harness of its own).
          ...(opts?.harness?.trim() ? { harness: opts.harness.trim() } : {}),
        },
      }
    : undefined;
  await sendMessage(identity, {
    to: [`@fleet-leader:${admission.scope.fleetSlug}`],
    summary: `fleet-scope admission blocked ${action}`,
    body:
      `${admission.reason}. The assignment was not mutated. ` +
      // EI-21906739799895413: the LEADER is the one who actually bumps the spec, so this
      // notice most of all must carry the executable widen rather than describe it. `itemId`
      // is already resolved above and is '' when the caller sent no subject stamp, which
      // degrades to the prose wording exactly as the other call sites do.
      `${fleetScopeLeaderRemedy(admission, liveRouteTarget, classRefusal, retiredPlans, itemId || null)}` +
      (dependencyEscape ? ` ${renderFleetDependencyEscape(dependencyEscape)}` : ''),
    category: FLEET_ADMISSION_BLOCK_CATEGORY,
    ...(stamp ? { extra: stamp } : {}),
  }).catch(() => undefined);
  return {
    liveRouteTarget,
    classRefusal,
    ...(dependencyEscape ? { dependencyEscape } : {}),
  };
}

export interface FleetScopeReconciliation {
  scope: FleetScopeContext | null;
  quarantinedIds: string[];
  /** The single workspace roster read used by reconciliation and downstream diagnostics. */
  fleetAssignmentRows: FleetAssignmentRow[];
}

/** Release every incompatible claim in one bounded sweep; never drip one per wake. */
export async function reconcileFleetScopeClaims(args: {
  ownerId: string;
  workspaceId?: string | null;
  identity?: AgentIdentity;
}): Promise<FleetScopeReconciliation> {
  const scope = await resolveFleetScopeContext(args.ownerId, args.workspaceId);
  if (!scope) return { scope: null, quarantinedIds: [], fleetAssignmentRows: [] };
  const { listFleetAssignments } = await import('../fleet/assignments');
  const { getWorkItem, releaseWorkItem } = await import('../work-items');
  const rows = await listFleetAssignments({
    workspaceId: resolveClaimSpecWorkspace(args.workspaceId),
    activeOnly: true,
  });
  // The workspace snapshot serves two consumers: this member's claim cleanup and
  // leader-liveness diagnosis. Filter the member's rows in memory so the latter
  // does not issue a second fleet_assignment query during scheduler preflight.
  const memberRows = rows.filter((r) => r.agentId === scope.ownerId || r.agentName === scope.ownerId);
  const ids = [
    ...new Set(
      memberRows.filter((r) => r.source === 'work_item_claim' && r.workItemId).map((r) => r.workItemId as string),
    ),
  ];
  const quarantinedIds: string[] = [];
  for (const id of ids) {
    const item = await getWorkItem(id);
    // EI-18732199386440540: the reconciliation sweep MUST honour the same self-filed
    // fallout carve-out the admission seam applies. Without this the two disagree and
    // the fix is worse than useless: the member is allowed to claim the bug it filed,
    // then the next sweep quarantines that very claim and messages the leader about an
    // "out-of-scope" item the system itself just admitted.
    const matches =
      item && scope.record.source !== 'default'
        ? (await itemMatchesScope(item, scope)) ||
          selfFiledFalloutAdmission(item, scope) ||
          (await leaderDispatchedAdmission(item, scope))
        : false;
    if (matches) continue;
    const released = await releaseWorkItem(id, { expectedAssignee: scope.ownerId });
    if (released) quarantinedIds.push(id);
  }
  if (quarantinedIds.length > 0 && args.identity) {
    const { sendMessage } = await import('../agent-tools/coordination/messages');
    await sendMessage(args.identity, {
      to: [`@fleet-leader:${scope.fleetSlug}`],
      summary: `quarantined ${quarantinedIds.length} out-of-scope fleet claim(s)`,
      body:
        `Released in one reconciliation sweep from ${scope.ownerId}: ${quarantinedIds.join(', ')}. ` +
        `Authoritative scope is ${formatSpecRef(scope.record.spec.specId, scope.record.spec.revision)}; re-steer or reassign deliberately.`,
      category: 'fleet-scope-admission',
    }).catch(() => undefined);
  }
  return { scope, quarantinedIds, fleetAssignmentRows: rows };
}

/**
 * EI-13520: result of {@link diagnoseFleetScopeCooldownMiss} — non-null only when the
 * scoped miss is (at least partly) explained by THIS bee's own release-cooldown floor,
 * not by the claim spec being genuinely empty.
 */
export interface CooldownMissDiagnosis {
  /** Rows that match spec + every OTHER floor and are excluded SPECIFICALLY by this
   *  bee's own release-cooldown floor (last_released_by = me AND still within the
   *  cooldown window) — i.e. the true SET DIFFERENCE between the with-cooldown and
   *  without-cooldown floors, not a bare without-cooldown count (WI-5303: the prior
   *  bare count over-attributed rows excluded by a different floor / a TOCTOU race
   *  to cooldown). */
  cooldownExcluded: number;
  /** Earliest cooldown expiry (ms since epoch) among this bee's own recently-released
   *  matching rows that are STILL within the cooldown window. Always non-null when
   *  cooldownExcluded > 0 (both are now computed from the same restricted row set —
   *  WI-5303: previously an unrestricted MIN could lock onto an already-expired
   *  release and report an expiry stuck in the past, i.e. a cooldownExpirySec of 0
   *  forever). */
  earliestExpiryMs: number | null;
  /** EI-16519: the work-item id whose `last_released_at` PRODUCES `earliestExpiryMs` —
   *  i.e. the argmin, not just the min. `last_released_at` is only ever written by an
   *  actual release-of-a-claimed-row (releaseWorkItem's UPDATE, gated on `taken_by IS
   *  NOT NULL` — see EI-16475's code trace + regression tests), so a SINGLE row's
   *  timestamp can never advance without a genuine re-claim+re-release of THAT row.
   *  When `cooldownExcluded > 1`, the reported `earliestExpiryMs` is a MIN over
   *  MULTIPLE different rows this bee released at different times — as the currently-
   *  earliest one ages out of the window, the MIN jumps to the next-earliest (a
   *  DIFFERENT row), which looks like "the cooldown clock keeps re-arming" but is
   *  ordinary multi-row churn from a bee that has released more than one in-spec row
   *  recently, not a livelock. Comparing `earliestRowId` across successive polls is the
   *  mechanical test: the SAME id with an advancing expiry is the genuine EI-14615
   *  livelock; a DIFFERENT id each poll is healthy churn, not a bug. Null only when
   *  cooldownExcluded is 0. */
  earliestRowId: string | null;
}

/**
 * EI-13520: best-effort tier-1 diagnosis for a fleet-scoped self-select MISS — does the
 * spec's primary feature-family view have candidate rows that would be admissible once
 * this bee's own release-cooldown floor (claimFloorsWhereSql's `cooldownAssignee` leg) is
 * dropped? When yes, the miss is a COOLDOWN artifact, not a scope/spec problem — re-authoring
 * the claim spec cannot fix it (see the fleet-livelock incident this closes: 6 agents thrashed
 * for hours re-authoring a spec that was never the cause).
 *
 * Scope of the check: the spec's TIER-1 view against `harness_features_consolidated`, the
 * SAME table + floors `getNextWorkItem`'s tier-1 attempt queries. Deliberately does not
 * replicate tiers 2/3 (the widened-kind or adjacent-issue-family fallbacks) — this is an
 * ANNOTATION on the already-failed claim, not a second claim attempt, so tier-1 fidelity is
 * enough to catch the dominant livelock shape (a bee's own just-released rows sorting back
 * to the top of a stable rank).
 *
 * WI-5303 fix: the row set is restricted, up front, to rows this bee itself released AND
 * that are still inside the cooldown window (`last_released_at >= now() - cooldown`) — the
 * exact predicate the WITH-cooldown floor uses to EXCLUDE a row. That makes `cnt` the true
 * set difference (rows the without-cooldown floor admits that the with-cooldown floor does
 * not, attributable to cooldown alone — not to a different floor or a race), and `earliest`
 * (MIN release time among only-still-active rows) can never lock onto an already-expired
 * release, so the derived `cooldownExpirySec` can never be stuck at 0 while cnt > 0.
 *
 * FAILS SOFT, same philosophy as `buildMissDiagnosis` (agent-tools/scheduler/get_next.ts):
 * any query error returns null — a diagnosis only ever annotates a miss, it must never be
 * able to turn a clean miss response into a thrown error.
 */
export async function diagnoseFleetScopeCooldownMiss(args: {
  scope: FleetScopeContext;
  harness: string;
  workspaceId?: string | null;
  states?: string[];
}): Promise<CooldownMissDiagnosis | null> {
  try {
    const ws = resolveClaimSpecWorkspace(args.workspaceId);
    if (!ws) return null;
    const spec = args.scope.record.spec;
    if (!spec.view.filter) return null;
    const { sql } = getOrgPg();
    const { claimFloorsWhereSql, releaseCooldownSec } = await import('../work-items');
    const { compileFilter } = await import('./get-next');
    const cooldownSec = releaseCooldownSec();
    if (cooldownSec <= 0) return null;
    // The WITHOUT-cooldown leg: identical floors, `cooldownAssignee` simply omitted so
    // that clause compiles to `TRUE` (see claimFloorsWhereSql) instead of excluding this
    // bee's recently-released rows.
    const floorsNoCooldown = claimFloorsWhereSql(sql, {
      harness: args.harness,
      workspaceId: ws,
      states: args.states ?? spec.states,
    });
    const filter = compileFilter(sql, spec.view.filter);
    // WI-5303: restrict directly to the rows the WITH-cooldown floor would exclude for
    // THIS bee (self-released, still within the window) — same query, same filter, plus
    // the exact cooldown-exclusion predicate — instead of a bare without-cooldown count.
    // EI-16519: fetch feature_id alongside last_released_at (not a bare MIN aggregate)
    // so the argmin row is identifiable — a caller/leader can then tell "the SAME row
    // keeps re-arming" (genuine livelock) apart from "a DIFFERENT row is earliest each
    // poll" (ordinary churn across this bee's own multiple recent releases). `count(*)
    // OVER()` is computed over the FULL matching set before ORDER BY/LIMIT clip which
    // row is returned, so `cnt` stays the exact total (no under-count from the LIMIT 1)
    // while a single row round-trip gives us the argmin directly.
    const rows = await sql<{ feature_id: string; last_released_at: Date; cnt: number }[]>`
      SELECT feature_id, last_released_at, count(*) OVER()::int AS cnt
        FROM harness_shared.harness_features_consolidated
       WHERE ${floorsNoCooldown}
         AND ${filter}
         AND last_released_by = ${args.scope.ownerId}
         AND last_released_at IS NOT NULL
         AND last_released_at >= now() - make_interval(secs => ${cooldownSec})
       ORDER BY last_released_at ASC
       LIMIT 1`;
    const cnt = rows[0]?.cnt ?? 0;
    if (cnt === 0) return null;
    const earliest = rows[0]!.last_released_at;
    const earliestExpiryMs = new Date(earliest).getTime() + cooldownSec * 1000;
    return { cooldownExcluded: cnt, earliestExpiryMs, earliestRowId: rows[0]!.feature_id };
  } catch {
    return null;
  }
}

/**
 * WI-7151 (EI-19318364531323846): does the spec's TIER-1 (feature-family) view have ANY
 * candidate rows when the issue-family-only breakdown (`diagnoseFleetScopeIssueFloorMiss`,
 * backed by `aggregateIssueClaimExclusions`) reports `matchedByFilter === 0`?
 *
 * That breakdown is STRUCTURALLY blind to the feature family — it scopes to
 * `item_kind IN ('bug','change','task')` by design (WI-5561: built for issue-family
 * kind-scoped drain fleets). A PLAN-scoped spec with no `kind` narrowing (the shape
 * `fleet:launch-on-plan` authors when `claimKinds` is omitted — `buildFleetPlanClaimSpec`)
 * admits BOTH families, and every plan-promoted item is feature-family by construction
 * (D-009: `promotePlanItems` → `createWorkItem` always mints a feature-family row for a
 * plan item unless the item's own kind is bug/change/task). So a plan whose items are
 * ALL feature-family makes the issue-family breakdown report a confident `matchedByFilter:
 * 0` — and `fleetScopedMiss` was, before this fix, certifying that as `reason:
 * 'spec_matches_nothing'` + `windDown: true`, even while the real TIER-1 pool (the exact
 * table `getNextWorkItem`'s first claim attempt just queried) had open, unclaimed,
 * spec-matching rows sitting right there. Live incident 2026-08-02: an opencode-omp-research
 * fleet member read exactly this false verdict on its first wake and correctly-per-doctrine
 * stood down, while the plan's 8 claimable items sat untouched (only completed because the
 * reporting agent broke the documented pull contract and claimed by id instead).
 *
 * Uses the SAME floors + filter compiler `getNextWorkItem`'s tier-1 attempt runs
 * (claimFloorsWhereSql + compileFilter over harness_features_consolidated — the release-
 * cooldown floor included, via `cooldownAssignee`, so this can't itself be fooled by the
 * EI-13520 cooldown-livelock shape into over-reporting a candidate the real claim would
 * also have excluded), so a nonzero count here PROVES the issue-family `matchedByFilter: 0`
 * cannot be read as "the spec matches nothing" — only "nothing in the issue family". The
 * caller (scheduler:get_next) retries the claim once on a nonzero count (mirroring the
 * pre-existing `issueBreakdown.claimable > 0` divergence-recheck) and, on a persistent
 * miss, threads the count into `fleetScopedMiss` so it reports the honest (non-drain,
 * non-spec-authoring) verdict instead of a false `spec_matches_nothing`.
 *
 * FAILS SOFT, same philosophy as every other diagnosis in this file: any query error
 * returns null and the caller falls back to the pre-existing (issue-family-only) verdict —
 * this annotates a miss, it must never be able to turn one into a thrown error.
 */
export interface FeatureFamilyClaimExclusionBreakdown {
  matchedByFilter: number;
  claimable: number;
  /** reservedPlanLane is an overlapping subset of the unique claimFloors total. */
  excluded: { claimFloors: number; reservedPlanLane: number };
}

type FeatureFamilyDiagnosticArgs = {
  scope: FleetScopeContext;
  harness: string;
  workspaceId?: string | null;
  states?: string[];
  rigAvailable?: boolean;
  /**
   * Override the claimant used by caller-relative floors. Omit to preserve the
   * historical per-member behavior; explicit null requests a population count.
   */
  cooldownAssignee?: string | null;
};

export async function diagnoseFleetScopeFeatureFamilyExclusions(
  args: FeatureFamilyDiagnosticArgs,
): Promise<FeatureFamilyClaimExclusionBreakdown | null> {
  try {
    const ws = resolveClaimSpecWorkspace(args.workspaceId);
    if (!ws) return null;
    const spec = args.scope.record.spec;
    const filterNode = spec.view.filter;
    if (!filterNode) return null;
    const { sql } = getOrgPg();
    const { claimFloorsWhereSql, reservedPlanLaneExclusionSql } = await import('../work-items');
    const { compileFilter } = await import('./get-next');
    // Keep the diagnostic's shared floors identical to getNextWorkItem's feature claim:
    // a fleet-stamped plan lane is admissible to its owning fleet, and a spec that
    // explicitly references `fleet` authorizes the matching stamped lane itself.
    const claimSpecReferencesFleet = claimSpecReferencesField(spec, 'fleet');
    // EI-21398324268952860: and the same for `goal`. This MUST be derived here too, or this
    // diagnostic reports `reserved_plan_lane` for rows the claim would now hand over — the
    // exact false `claimable=0` that filing was opened for, just moved into the read side.
    const claimSpecReferencesGoal = claimSpecReferencesField(spec, 'goal');
    const cooldownAssignee = args.cooldownAssignee === null
      ? undefined
      : args.cooldownAssignee ?? args.scope.ownerId;
    const floors = claimFloorsWhereSql(sql, {
      harness: args.harness,
      workspaceId: ws,
      states: args.states ?? spec.states,
      cooldownAssignee,
      rigAvailable: args.rigAvailable,
      claimantFleetSlug: args.scope.fleetSlug,
      claimSpecReferencesFleet,
      claimSpecReferencesGoal,
    });
    const filter = compileFilter(sql, filterNode);
    const states = [...(args.states ?? spec.states ?? ['open'])];
    const candidate = sql`
      harness_slug = ${args.harness}
      AND workspace_id = ${ws}
      AND (CASE WHEN status = 'todo' THEN 'open' ELSE status END) = ANY(${states}::text[])
    `;
    const reservationEligible = reservedPlanLaneExclusionSql(sql, cooldownAssignee ?? '', 'payload', {
      claimantFleetSlug: args.scope.fleetSlug,
      claimSpecReferencesFleet,
      claimSpecReferencesGoal,
    });
    const rows = await sql<{ matched: number; claimable: number; reserved_plan_lane: number }[]>`
      SELECT count(*) FILTER (WHERE ${filter})::int AS matched,
             count(*) FILTER (WHERE ${floors} AND ${filter})::int AS claimable,
             count(*) FILTER (WHERE ${filter} AND NOT (${reservationEligible}))::int AS reserved_plan_lane
        FROM harness_shared.harness_features_consolidated
       WHERE ${candidate}`;
    const matchedByFilter = rows[0]?.matched ?? 0;
    const claimable = rows[0]?.claimable ?? 0;
    return {
      matchedByFilter,
      claimable,
      excluded: {
        claimFloors: Math.max(0, matchedByFilter - claimable),
        reservedPlanLane: rows[0]?.reserved_plan_lane ?? 0,
      },
    };
  } catch {
    return null;
  }
}

/** Compatibility count used by scheduler miss diagnosis; lane-health consumes the richer sibling. */
export async function diagnoseFleetScopeFeatureFamilyMatch(args: FeatureFamilyDiagnosticArgs): Promise<number | null> {
  return (await diagnoseFleetScopeFeatureFamilyExclusions(args))?.claimable ?? null;
}

/**
 * WI-5561: the fleet-scoped sibling of `buildMissDiagnosis`'s EI-13965 aggregate floor
 * breakdown. A fleet MEMBER's `scheduler:get_next` miss never ran `aggregateIssueClaimExclusions`
 * at all (only a non-fleet caller did — `buildMissDiagnosis` short-circuits to an empty
 * diagnosis whenever `reconciliation.scope` is set), so a member scoped to an issue-family
 * `kind` filter (e.g. a bug-drain fleet's `{kind:'bug'}`) got a bare "no claimable work-item
 * matched fleet scope" with NO explanation — even when the true cause is a fully floor-gated
 * pool (confirmed live: fleet bug-drain-200k, 302 open+unclaimed+local bugs, ALL excluded by
 * legitimate floors — 169 federation-detector, 80 needs-human, 33 claim-hold, 21
 * observation-lane), not a scope/spec mismatch. Reuses the SAME `aggregateIssueClaimExclusions`
 * the non-fleet path already relies on — one source of truth, never a second implementation.
 * FAILS SOFT (same philosophy as `diagnoseFleetScopeCooldownMiss` / `buildMissDiagnosis`): any
 * error, or an unresolvable workspace, returns null and the miss degrades to the pre-existing
 * bare message.
 *
 * EI-18663622382734446: a `matchedByFilter === 0` result (the spec's OWN filter admits zero
 * rows, e.g. a stale `id in [...]` allowlist or an over-narrow plan/kind scope) used to be
 * folded into the SAME null return as "diagnosis unavailable" — collapsing "genuinely
 * floor-gated pool" and "the spec itself matches nothing" into one indistinguishable bare
 * miss. That is precisely the failure this ticket documents: `scheduler:set_claim_spec`'s own
 * `previousMatched` report already computes this number at WRITE time, but it was silently
 * absent at PULL time, where the fleet member actually stands. `matchedByFilter === 0` is now
 * returned (not swallowed) so `fleetScopedMiss` can name the case loudly — a member confidently
 * self-diagnosing "no work available, not a spec bug" while its spec matches literally nothing
 * of a nonempty pool is the exact starvation observed live (2026-07-25, fleet p2p-release,
 * spec `p2p-release-lane@8` matched 0 of 1250 rows for 4.5h while two members separately ruled
 * out a spec bug in good faith).
 */
/**
 * Smallest whole-call budget that can safely START the bounded issue-family
 * diagnostic. boundedPgReadTxn owns two independently floored DB legs
 * (acquisition + statement, 100ms each) plus its fixed cleanup allowance.
 * Callers below this threshold must report the read as unavailable instead of
 * launching work that their own deadline will abandon.
 */
export const FLEET_SCOPE_ISSUE_DIAG_MIN_TOTAL_BUDGET_MS = PG_READ_QUERY_CALL_OVERHEAD_MS + 200;

export async function diagnoseFleetScopeIssueFloorMiss(args: {
  scope: FleetScopeContext;
  harness: string;
  workspaceId?: string | null;
  states?: string[];
  rigAvailable?: boolean;
  /** Whole-call allowance supplied by the handler. Acquisition, statement execution,
   *  and boundedPgReadTxn's fixed cleanup overhead must all fit inside this slice. */
  totalBudgetMs?: number;
}): Promise<import('./get-next').IssueClaimExclusionBreakdown | null> {
  try {
    const ws = resolveClaimSpecWorkspace(args.workspaceId);
    if (!ws) return null;
    const totalBudgetMs = Number.isFinite(args.totalBudgetMs)
      ? Math.trunc(args.totalBudgetMs as number)
      : FLEET_SCOPE_ISSUE_DIAG_DEFAULT_TOTAL_BUDGET_MS;
    // boundedPgReadTxn clamps each leg to at least 100ms. Do not start a transaction
    // when those two minimums plus its fixed whole-call overhead cannot fit inside
    // the caller's remaining allowance.
    if (totalBudgetMs < FLEET_SCOPE_ISSUE_DIAG_MIN_TOTAL_BUDGET_MS) return null;
    const databaseBudgetMs = totalBudgetMs - PG_READ_QUERY_CALL_OVERHEAD_MS;
    const acquireTimeoutMs = Math.max(100, Math.floor(databaseBudgetMs / 4));
    const timeoutMs = databaseBudgetMs - acquireTimeoutMs;
    const spec = args.scope.record.spec;
    const { aggregateIssueClaimExclusions } = await import('./get-next');
    const agg = await boundedPgReadTxn(
      (tx) =>
        aggregateIssueClaimExclusions(spec.view.filter, {
          harness: args.harness,
          workspaceId: ws,
          states: args.states ?? spec.states,
          assignee: args.scope.ownerId,
          rigAvailable: args.rigAvailable,
          client: tx,
        }),
      { acquireTimeoutMs, timeoutMs },
    );
    // EI-18663622382734446: matchedByFilter === 0 is returned, not swallowed — see the
    // doc comment above. Only a genuinely missing/errored aggregate degrades to null.
    return agg ?? null;
  } catch {
    return null;
  }
}

/** Default DB cancellation slice for callers that do not own a tighter handler budget. */
export const FLEET_SCOPE_ISSUE_DIAG_DEFAULT_TOTAL_BUDGET_MS = 12_000;

/**
 * EI-20186990913643457: count the rows a fleet spec matches WITHOUT applying the
 * claimable-state floor, and count how many of those rows are terminal.
 *
 * `diagnoseFleetScopeIssueFloorMiss` intentionally scopes its aggregate to the rows a
 * self-selector could claim (`states: ['open']` by default). That is the right input for
 * floor attribution, but it makes an all-terminal id tranche look identical to a typo: the
 * terminal rows disappear before `matchedByFilter` is counted, so `fleetScopedMiss` emits the
 * leader-alerting `spec_matches_nothing` verdict after a successful drain. This companion read
 * asks the same compiled filter against the unified work-item base with no status floor. The
 * caller only treats it as exhaustion when every matching row is terminal; a mix of terminal and
 * non-terminal rows therefore keeps the existing zero-match diagnosis honest.
 *
 * The query covers both families with the same workspace split as their claim paths: issue rows
 * include the operator-scope alias, while feature/generic rows use the resolved claim workspace.
 * It is annotation-only and fails soft like the other fleet miss diagnostics.
 */
export interface FleetScopeTerminalExhaustion {
  matchedByFilter: number;
  terminalMatchedByFilter: number;
}

export async function diagnoseFleetScopeTerminalExhaustion(args: {
  scope: FleetScopeContext;
  harness: string;
  workspaceId?: string | null;
}): Promise<FleetScopeTerminalExhaustion | null> {
  try {
    const ws = resolveClaimSpecWorkspace(args.workspaceId);
    if (!ws) return null;
    const spec = args.scope.record.spec;
    const { sql } = getOrgPg();
    const [{ SETTLED_WORK_ITEM_STATES }, { issuesScopeWorkspace }, { compileFilter }] = await Promise.all([
      import('../work-items'),
      import('../issues-engineer'),
      import('./get-next'),
    ]);
    const issueWs = issuesScopeWorkspace();
    const operatorScopeSlug = `operator:${issueWs}`;
    const issueKinds = [...ISSUE_FAMILY_KINDS];
    const filter = compileFilter(sql, spec.view.filter);
    const rows = await sql<{ matched: number; terminal: number }[]>`
      SELECT
        count(*) FILTER (WHERE ${filter})::int AS matched,
        count(*) FILTER (
          WHERE ${filter}
            AND wi.status = ANY(${[...SETTLED_WORK_ITEM_STATES]}::text[])
        )::int AS terminal
        FROM harness_shared.work_items wi
       WHERE (
         (
           wi.item_kind = ANY(${issueKinds}::text[])
           AND wi.workspace_id = ${issueWs}
           AND (wi.harness_slug = ${args.harness} OR wi.harness_slug = ${operatorScopeSlug})
         )
         OR (
           wi.item_kind <> ALL(${issueKinds}::text[])
           AND wi.workspace_id = ${ws}
           AND wi.harness_slug = ${args.harness}
         )
       )`;
    const matchedByFilter = rows[0]?.matched ?? 0;
    if (matchedByFilter === 0) return null;
    return {
      matchedByFilter,
      terminalMatchedByFilter: rows[0]?.terminal ?? 0,
    };
  } catch {
    return null;
  }
}

export function fleetScopedMiss(
  scope: FleetScopeContext,
  quarantinedIds: string[] = [],
  // EI-12832: when the miss is because the fleet is PAUSED (winding-down), the item
  // may well match the spec — the member just must not pull. Say so honestly instead
  // of the "no item matched scope" message (which would be actively misleading during
  // a pause), and give the stand-down (not the re-steer) advice.
  //
  // EI-13520: `cooldownDiag` (ignored while paused — the pause message already fully
  // explains the miss) reattributes a cooldown-only miss so the caller — and the fleet
  // leader they'd otherwise report a false spec problem to — is told the true cause.
  //
  // EI-14615: a cooldown-only miss also carries `cooldownExpiryAt` (the ABSOLUTE expiry
  // instant), and the advice distinguishes a NORMAL one-time cooldown (expiry holds
  // steady, re-poll and it clears) from a LIVELOCKED one (expiry keeps ADVANCING because
  // the fleet round-robin re-releases permanently-unfit rows faster than the window
  // lapses — the relative `~Ns` reads a perpetually-fresh ~300s and never clears). The
  // old advice told the member NOT to escalate; for the livelock case that was exactly
  // wrong — a leader spec-revision to exclude those rows is the only fix.
  // EI-15777: how many of the CALLER's own standing `work-item:claimable` idle-park
  // await(s) were just cancelled server-side as part of reporting this paused miss
  // (see the cancelClaimableAwaits call at both self-pull call sites). Only
  // meaningful while `paused` — a normal/cooldown miss must keep re-parking.
  opts?: {
    pausedReason?: string | null;
    cooldownDiag?: CooldownMissDiagnosis | null;
    claimableAwaitsCancelled?: number;
    /** WI-5561: the issue-family floor breakdown (see {@link diagnoseFleetScopeIssueFloorMiss}) —
     *  ignored while paused (the pause message already fully explains the miss), and only ever
     *  surfaced alongside (not instead of) the cooldown-only message when both are present. */
    issueBreakdown?: import('./get-next').IssueClaimExclusionBreakdown | null;
    /**
     * WI-7151 (EI-19318364531323846): the TIER-1 (feature-family) candidate count from
     * {@link diagnoseFleetScopeFeatureFamilyMatch}, computed by the caller ONLY when
     * `issueBreakdown.matchedByFilter === 0` (the case that would otherwise certify
     * `specEmpty`). A positive count proves the spec is NOT "matches nothing" — the
     * issue-family breakdown is merely blind to the feature family — so it suppresses the
     * false `spec_matches_nothing` verdict below in favor of an honest, non-drain report.
     * `null`/`undefined`/`0` ⇒ no change from the pre-existing issue-family-only behavior.
    */
    featureFamilyMatched?: number | null;
    /**
     * EI-20186990913643457: status-floor-free match counts for the spec. A positive count is
     * only an exhaustion verdict when every matching row is terminal; a partial terminal count
     * must not suppress the existing zero-match/spec-authoring diagnosis.
     */
    terminalExhaustion?: FleetScopeTerminalExhaustion | null;
    /**
     * EI-20260781488788952: plan-level terminality for positive plan predicates. Only an
     * explicitly positive all-terminal result may turn a plan-scoped zero-match into a
     * completed-plan wind-down; false and null preserve the existing miss diagnosis.
     */
    planTerminality?: FleetScopePlanTerminality | null;
    /**
     * EI-20260781488788952: liveness of this fleet's registered leader. False means a
     * successful roster read found no live leader; null is unreadable/unknown and preserves
     * the existing escalation wording.
     */
    leaderLiveness?: boolean | null;
    /**
     * WI-5947: the caller's verdict on a would-be claim/read divergence, after re-asking the
     * CLAIM path (the only oracle that can settle it). `'confirmed-twice'` — two claim attempts
     * missed while survivors persisted across two readings — is the only value that licenses
     * the loud EI-10062-class divergence report. Absent (or any other value) means the
     * suspicion was never confirmed, and the miss is reported as a transient pool change the
     * caller should simply re-pull against. See the `divergent` derivation below.
     */
    divergenceRecheck?: 'resolved-by-retry' | 'confirmed-twice';
    /**
     * EI-18674160393981819: the caller's OWN harness — the `args.harness` every self-select
     * call site already requires. AND'd into the derived `claimablePayloadFilter` below so the
     * returned `payloadFilter` (which the miss advice recommends copying verbatim into an
     * `events:await('work-item:claimable')` idle-park) only fires on SAME-HARNESS emits. Without
     * this, a harness-scoped fleet whose claim spec's `view.filter` doesn't itself reference
     * `harness` (the common case — the spec narrows on kind/plan/tags, and harness scoping comes
     * from the `args.harness` the caller passes to scheduler:get_next, never from the spec tree)
     * derived an payload_filter with NO harness term, so the idle-park woke the member on every
     * OTHER harness's claimable bug too (observed: a papercusp-scoped fleet woken by an
     * oddsmith-hive bug) — a real turn spent confirming nothing changed in its own lane.
     * Optional so a caller with no harness in scope (there is none today, but the field stays
     * defensive) degrades to the pre-fix unscoped-by-harness derivation, never a hard failure.
     */
    harness?: string;
    /**
     * WI-7316: rows the claim path DID claim this pull, found plan-lane-blocked, released, and
     * retried past — narrowed to those whose blocking plan item carries a `staleBlockedHint`
     * (see PlanItemLaneBlock.staleBlockedHint). Empty/absent ⇒ no change from the pre-existing
     * behavior.
     *
     * This is the one miss shape where every OTHER diagnosis here is structurally blind. The
     * bounce happens AFTER the claim, so the SQL floors never see it: the issue-family
     * breakdown counts the row as claimable, and the caller is handed either the generic
     * "no claimable work-item matched fleet scope" or — worse — the `floorGated` message, whose
     * advice is "it very likely self-clears once the gating condition lifts, with no spec change
     * required". For a stale token that advice is precisely backwards: nothing is gating it and
     * nothing will lift, because every blocked-by dependency ALREADY resolved and the stored
     * token is deliberately sticky until a human clears it. A member that believes it re-polls
     * a lane that can never clear itself, then stands down reporting a drained queue.
     */
    staleBlockedLane?: Array<{ workItemId: string; planSlug: string; itemId: string; hint: string }> | null;
  },
) {
  const paused = opts?.pausedReason !== undefined;
  const cooldown = !paused ? (opts?.cooldownDiag ?? null) : null;
  // WI-5561: surfaced alongside the generic/cooldown message (never while paused — the pause
  // message already fully explains the miss).
  const breakdown = !paused ? (opts?.issueBreakdown ?? null) : null;
  // EI-18666093519248020: the INVARIANT this whole diagnosis rests on — `breakdown.claimable`
  // is, per its own contract (see IssueClaimExclusionBreakdown.claimable), "the count a
  // self-selecting caller would actually see as claimable RIGHT NOW ... the ONE number the
  // whole claimability-clarity plan makes trustworthy — the `0 claimable` a wind-down / drain
  // decision hinges on". So `claimed nothing` AND `claimable > 0` is not a drained lane and
  // not a floor story: it is the CLAIM path disagreeing with the READ path, i.e. a bug in the
  // claim path's own narrowing.
  //
  // That exact disagreement has now shipped FOUR times — EI-10062 (id-allowlist spec claimed
  // any row), WI-4309 (issue-only id-allowlist could never be served), WI-5275 (an `id` leaf
  // under a positive `any` skipped tier 3 entirely, starving a whole fleet), WI-5822 (the claim
  // path could only ever see the kind/id legs, so paths/plan/title/tag specs matched nothing and
  // ~88% of pulls reported a false drain). Every one was fixed by patching the narrowing; the
  // invariant itself was never asserted, which is why recurrence #4 was as invisible as #1 and
  // was found only because a member hand-compared this response against work_items:claimable.
  //
  // Reporting `windDown:true` + "checkpoint, release, loop:end" in that state is the harmful
  // part: a member that obeys stands its loop down while its own lane still has claimable rows,
  // and a fleet can go quiet while every surface looks correct. So when claimable > 0 we refuse
  // to certify a drain — no windDown, no stand-down advice — and instead name the divergence
  // loudly enough that the NEXT recurrence is a one-line report instead of an investigation.
  //
  // WI-5947: the invariant above is sound only if the two observations describe the SAME
  // instant. They do not: `breakdown` is read AFTER the claim attempt already failed, against a
  // table the whole fleet mutates continuously. Any row that becomes claimable in that window —
  // a peer releasing, a claim-hold lapsing, a detector filing a new bug — reproduces "claimed
  // nothing AND claimable > 0" with a completely healthy claim path. Because the verdict below
  // does not merely report but INSTRUCTS ("report this verdict to your fleet leader as a
  // CLAIM-PATH BUG ... it is the reproduction"), that race manufactured fabricated bug reports
  // against healthy code, complete with a plausible repro (observed live 2026-07-26 05:18Z,
  // fleet nonp2p-bug-drain-0725, during a 0->2->4 claimable burst).
  //
  // So a bare `claimable > 0` is now only a SUSPICION. The caller (scheduler:get_next) settles
  // it the only way it can be settled — by asking the claim path again — and reports the
  // outcome as `divergenceRecheck`:
  //   'resolved-by-retry' : the retry claimed an item; never reaches here (that is a success).
  //   'confirmed-twice'   : two claim attempts missed while survivors persisted across two
  //                         independent readings. THAT is the real EI-10062-class signal.
  //   undefined           : no re-check ran (the retry timed out/errored, or the caller does not
  //                         perform one) — unproven, and must not be asserted as a defect.
  const survivorsReported = breakdown != null && breakdown.claimable > 0;
  const divergent = survivorsReported && opts?.divergenceRecheck === 'confirmed-twice';
  // Survivors reported but the divergence was never confirmed. Still NOT a drained lane (so
  // windDown stays off and the member must not stand down), but the honest read is "the pool
  // moved under you — pull again", not "you have found a bug in the claim path".
  const unconfirmedSurvivors = survivorsReported && !divergent;
  // EI-18663622382734446: the spec's OWN view.filter matches zero issue-family rows at all —
  // a SPEC-AUTHORING problem (stale id allowlist, over-narrow plan/kind scope, a typo), not a
  // drained or floor-gated pool. Distinct from `divergent` (which requires matchedByFilter > 0
  // survivors) — the two are mutually exclusive by construction. Must be named LOUDLY: this is
  // the exact shape that let a starved fleet confidently self-diagnose "not a spec bug" for
  // 4.5h (see diagnoseFleetScopeIssueFloorMiss's doc comment).
  // WI-7151 (EI-19318364531323846): a positive tier-1 (feature-family) match count PROVES
  // the issue-family-only `matchedByFilter === 0` cannot be trusted as "the spec matches
  // nothing" — see diagnoseFleetScopeFeatureFamilyMatch's doc comment. Mutually exclusive
  // with `specEmpty` by construction (both require the same `matchedByFilter === 0` base).
  const featureFamilyMiss =
    !paused && breakdown != null && breakdown.matchedByFilter === 0 && !!(opts?.featureFamilyMatched && opts.featureFamilyMatched > 0);
  // WI-7316: rows bounced this pull by a plan item stuck on a STALE block. Ranked below the
  // claim-path signals above (divergence/unconfirmed survivors are statements about the claim
  // path itself and must keep precedence) but ABOVE every "your spec is done/broken/gated"
  // verdict below, because those are all inferred from SQL-floor counts that structurally
  // cannot see a post-claim bounce — so on this miss they are confidently wrong, not merely
  // incomplete. Suppressed while paused, like every other diagnosis here: the pause message
  // already fully explains the miss.
  const staleBlockedRows = !paused ? (opts?.staleBlockedLane ?? []) : [];
  const staleBlockedLane = staleBlockedRows.length > 0;
  // EI-20260781488788952: a plan-level terminality read closes the family blind spot in the
  // row-level exhaustion check. Only an explicitly positive all-terminal result is trusted;
  // false/null/absent leaves the old miss diagnosis in place.
  //
  // EI-22179902813950215: `breakdown` (the issue-floor diagnosis) FAILS SOFT to null on any
  // query error/timeout — a transient failure of that UNRELATED query used to silently
  // suppress this whole diagnosis, because it originally hard-required `breakdown != null`.
  // Plan terminality is read directly from the plan's own lifecycle
  // (diagnoseFleetScopePlanTerminality) and does not depend on the issue-floor breakdown at
  // all, so a null breakdown must not veto it — only a breakdown that SUCCEEDED and reported a
  // nonzero matchedByFilter should (a live row still matching the spec would genuinely
  // contradict "every bound plan is terminal"). Before this fix, two scheduler:get_next calls
  // against the SAME unchanged terminal plan could report materially different diagnoses
  // depending only on whether that one query happened to time out, with the degraded call
  // falling all the way through to the generic "no claimable work-item matched fleet scope"
  // miss and its unfollowable park-a-work-item:claimable-await advice.
  const planComplete =
    !paused &&
    !featureFamilyMiss &&
    (breakdown == null || breakdown.matchedByFilter === 0) &&
    opts?.planTerminality?.allTerminal === true;
  // EI-20186990913643457: terminal rows leave the claimable-state universe before the issue
  // breakdown counts `matchedByFilter`, so an all-terminal tranche otherwise looks like a stale
  // or typo'd spec. Only call it exhausted when the status-floor-free read proves that EVERY
  // matching row is terminal. A mixed terminal/non-terminal set remains a genuine zero-match
  // diagnosis (or a family blind spot), never a false success-shaped drain.
  const specExhausted =
    !paused &&
    !featureFamilyMiss &&
    !planComplete &&
    breakdown != null &&
    breakdown.matchedByFilter === 0 &&
    opts?.terminalExhaustion != null &&
    opts.terminalExhaustion.matchedByFilter > 0 &&
    opts.terminalExhaustion.terminalMatchedByFilter === opts.terminalExhaustion.matchedByFilter;
  // EI-19393442073558754: a spec whose filter references `plan`/`plan_item` and is NOT
  // itself restricted to issue-family kinds can genuinely, correctly admit ONLY
  // feature-family rows for long stretches (D-009: a plan-promoted item is feature-family
  // unless its own kind is bug/change/task) — so `matchedByFilter: 0` on the issue-family
  // side is EXPECTED there, not evidence of a spec-authoring bug. Distinct from
  // `featureFamilyMiss` (which requires a CONFIRMED positive tier-1 count): this fires
  // whenever the tier-1 check came back EMPTY too (0, a genuine drain) or could not run at
  // all (null/undefined, diagnosis unavailable) — in both sub-cases the "SPEC MATCHES
  // NOTHING ... escalate your leader NOW" framing below is simply the wrong story for a
  // spec whose plan predicate makes it structurally reach the feature family instead. Live
  // repro (2026-08-03): fleet opencode-omp-research's plan-scoped spec correctly served two
  // feature-family claims minutes earlier, then reported `spec_matches_nothing` on an
  // ordinary drain (2 items done, 1 blocked) purely because the issue-family breakdown —
  // which that spec structurally can never satisfy — read zero. Deliberately narrower than
  // "no kind restriction at all": an id/tag/title-only filter (no plan predicate) keeps the
  // loud `specEmpty` escalation, since a stale id allowlist genuinely is a spec bug
  // (EI-18663622382734446) and has no such documented family correlation.
  const specIssueOnly = specIsIssueFamilyOnly(scope.record.spec);
  const specPlanScoped = !specIssueOnly && specHasPlanPredicate(scope.record.spec);
  const nonIssueSpecEmpty =
    !paused &&
    breakdown != null &&
    breakdown.matchedByFilter === 0 &&
    !featureFamilyMiss &&
    !specExhausted &&
    !planComplete &&
    specPlanScoped;
  const specEmpty =
    !paused &&
    breakdown != null &&
    breakdown.matchedByFilter === 0 &&
    !featureFamilyMiss &&
    !specExhausted &&
    !planComplete &&
    !specPlanScoped;
  // EI-18741523426513509: the spec's filter DID match real rows, but every one is presently
  // excluded by a TRANSIENT claim floor (an uncleared plan-lane blocker, a peer's claim-hold,
  // needs-human, a federation-detector gate, …) — the pool is legitimately, honestly empty
  // RIGHT NOW and will very likely clear on its own the moment the gating condition lifts
  // (observed live: an externalBlocker plan-lane gate cleared in ~90s with two idle members
  // claiming unaided the instant it did). This is the OPPOSITE remedy from `specEmpty`: await
  // or re-poll, never rewrite the spec. Naming it distinctly (instead of leaving `reason`
  // absent, indistinguishable-by-shape from "diagnosis merely unavailable") is what stops a
  // member from inventing a spec-authoring hypothesis for what is actually ordinary floor
  // gating, and stops a leader from "fixing" a claim spec that was never broken.
  // Deliberately excludes divergent/unconfirmedSurvivors (those require breakdown.claimable >
  // 0 survivors; this requires exactly 0) and cooldown (reported as its own distinct reason
  // below, since a cooldown clears on a known wall-clock schedule rather than an event).
  const floorGated =
    !paused &&
    !cooldown &&
    !divergent &&
    !unconfirmedSurvivors &&
    !specEmpty &&
    breakdown != null &&
    breakdown.matchedByFilter > 0 &&
    breakdown.claimable === 0;
  // EI-15185: derive the ready-made `payload_filter` for a `work-item:claimable`
  // idle-park await from the member's OWN claim-spec view — the missing "how do I
  // scope this await" answer that led members to register an UNSCOPED await and
  // get woken on every system-wide release. This is a SOUND CANDIDATE filter, not
  // a complete admission predicate: the claimable event does not carry every
  // global floor (rig availability, plan reservations, owner-action gates, holds,
  // dependencies), and its lifecycle snapshot can race a later state change.
  // `undefined` ⇒ the spec narrows only on fields the claimable payload does not
  // carry, so the advice below must NOT recommend an unscoped await (the other
  // half of the fix).
  const specDerivedPayloadFilter = claimSpecFilterToClaimablePayloadFilter(scope.record.spec.view.filter);
  // EI-18674160393981819: the claimable payload always carries `harness` (see
  // claim-spec-payload-filter.ts's PAYLOAD_FILTERABLE_FIELDS doc comment — it is payload-only,
  // no claim-spec leaf ever references it), so AND it in directly from the caller's own
  // harness whenever known, independent of whatever the spec's view.filter narrowed. This can
  // only ever narrow (never widen) what a bare spec-derived filter would already admit — sound
  // by the same "the derived filter must never suppress an item the spec would admit" contract
  // claim-spec-payload-filter.ts documents, since a fleet member's own claim path is ALWAYS
  // scoped to a single harness (args.harness) regardless of what the spec filter narrows on.
  const claimablePayloadFilter = opts?.harness
    ? ({
        all: [
          { harness: { equals: opts.harness } },
          ...(specDerivedPayloadFilter ? [specDerivedPayloadFilter] : []),
        ],
      } as const)
    : specDerivedPayloadFilter;
  const cooldownExpirySec = cooldown?.earliestExpiryMs != null ? Math.max(0, Math.round((cooldown.earliestExpiryMs - Date.now()) / 1000)) : null;
  // EI-14615: surface the ABSOLUTE cooldown expiry instant, not just the relative
  // `~Ns` (which is recomputed against Date.now() every poll and so reads the same
  // "~300s" whether the window is decaying normally OR being externally re-stamped).
  // A member can compare this absolute timestamp across successive polls: if it holds
  // steady the cooldown is decaying normally and will clear; if it keeps ADVANCING the
  // window is being re-stamped by the fleet round-robin re-releasing these rows faster
  // than the cooldown lapses (the livelock this ticket documents) — it will NEVER clear
  // on its own, and the do-not-escalate advice below is corrected to say so.
  const cooldownExpiryAt = cooldown?.earliestExpiryMs != null ? new Date(cooldown.earliestExpiryMs).toISOString() : null;
  // WI-2146345 / P-001: the old miss contract exposed a zero plus several
  // independent hints, leaving every caller to infer whether it meant pause,
  // filter-zero, floor gating, or a completed lane. Preserve the original fields
  // for compatibility, but add one bounded aggregate whose state is explicit and
  // whose exactness says when the issue-family diagnostic is only a lower bound.
  const statusFreeEmpty = opts?.terminalExhaustion?.matchedByFilter === 0;
  const evidenceComplete = specIssueOnly || statusFreeEmpty;
  const claimableValue = breakdown
    ? breakdown.claimable + (opts?.featureFamilyMatched ?? 0)
    : null;
  const matchedByFilter = breakdown?.matchedByFilter ?? null;
  const excluded = breakdown?.excluded as Record<string, number> | null ?? null;
  const claimabilityInterpretation = interpretFleetClaimability({
    claimable: claimableValue,
    matchedByFilter,
    excluded,
    fleetPaused: paused,
    planScoped: specPlanScoped,
    drainConfirmed: planComplete || specExhausted,
    evidenceComplete,
  });
  const claimability = {
    value: claimableValue,
    population: {
      kind: 'fleet-claim-spec' as const,
      fleet: scope.fleetSlug,
      harness: opts?.harness ?? scope.record.harnessSlug ?? null,
      spec: {
        ref: formatSpecRef(scope.record.spec.specId, scope.record.spec.revision),
        revision: scope.record.spec.revision,
        source: scope.record.source,
        planScoped: specPlanScoped,
      },
      basis: evidenceComplete ? (specIssueOnly ? 'issue-family' : 'issue+feature-family') : 'partial-family',
      matchedByFilter,
      excluded,
      families: {
        issue: breakdown
          ? {
              claimable: breakdown.claimable,
              matchedByFilter: breakdown.matchedByFilter,
              excluded: breakdown.excluded,
            }
          : null,
        feature: opts?.featureFamilyMatched == null
          ? null
          : {
              claimable: opts.featureFamilyMatched,
              matchedByFilter: statusFreeEmpty ? 0 : null,
              excluded: statusFreeEmpty ? { claimFloors: 0, reservedPlanLane: 0 } : null,
            },
      },
    },
    interpretation: claimabilityInterpretation,
  };
  return {
    ok: false as const,
    error: paused
      ? `fleet '${scope.fleetSlug}' is winding-down (paused${opts?.pausedReason ? `: ${opts.pausedReason}` : ''}); ` +
        'do NOT pull new work from this fleet\'s lanes — stand down until a fleet:resume (control_state=active) lands'
      : divergent
        ? `CLAIM-PATH/READ-PATH DIVERGENCE: the claim path selected nothing, but the shared claimability oracle reports ` +
          `${breakdown!.claimable} of ${breakdown!.matchedByFilter} in-spec issue-family row(s) passing spec_match AND every claim floor ` +
          `for fleet scope ${formatSpecRef(scope.record.spec.specId, scope.record.spec.revision)}. Your lane is NOT drained and NOT floor-gated — ` +
          'this is an internal inconsistency in the claim path\'s own spec narrowing (the EI-10062 / WI-4309 / WI-5275 / WI-5822 class). ' +
          'CONFIRMED across TWO claim attempts with survivors present in two independent readings, so this is not lane churn. ' +
          'windDown is deliberately NOT set: do not stand down.'
        : unconfirmedSurvivors
        ? `POOL CHANGED UNDER YOU (not a drained lane, not a bug): the claim path selected nothing, but a reading taken just ` +
          `afterwards reports ${breakdown!.claimable} of ${breakdown!.matchedByFilter} in-spec row(s) passing every claim floor for fleet scope ` +
          `${formatSpecRef(scope.record.spec.specId, scope.record.spec.revision)}. Those are two different instants on a table your whole ` +
          'fleet is mutating, so the likeliest explanation by far is that a row became claimable in between (a peer released, a claim-hold ' +
          'lapsed, a detector filed) — NOT a defect. This was NOT confirmed by a second claim attempt, so do not report it as one ' +
          '(WI-5947). windDown is NOT set: there may well be work — just pull again.'
        : featureFamilyMiss
          ? `ISSUE-FAMILY DIAGNOSIS BLIND SPOT (WI-7151 / EI-19318364531323846): the claim path selected nothing, and the ` +
            `issue-family-only breakdown reports 0 matching row(s) — but ${opts?.featureFamilyMatched} FEATURE-family row(s) ` +
            `(the family every plans:start promotion mints) match claim spec ${formatSpecRef(scope.record.spec.specId, scope.record.spec.revision)}'s ` +
            'view.filter and pass every claim floor. The issue-family breakdown is STRUCTURALLY blind to the feature family ' +
            '(it only ever queries bug/change/task rows), so its `matchedByFilter: 0` is NOT evidence your spec matches ' +
            'nothing — it only means "nothing in the issue family". This is NOT a drained lane and NOT a spec-authoring ' +
            'problem: it is either a transient race (pull again) or a genuine claim-path defect in the tier-1 (feature-family) ' +
            'narrowing. windDown is deliberately NOT set: do not stand down, and do not re-author the claim spec on this alone.'
        : staleBlockedLane
          ? `STALE PLAN-ITEM BLOCK, NOT A DRAINED LANE (WI-7316): ${staleBlockedRows.length} row(s) matched your scope and were ` +
            'CLAIMED on this pull, then released because their linked plan item is effectively `blocked` — while every one of that ' +
            "item's blocked-by dependencies has ALREADY resolved. The stored `blocked` token is deliberately sticky (it is reserved " +
            'for external blockers the graph cannot see), so it does NOT self-clear and re-polling will not help: ' +
            `${staleBlockedRows
              .slice(0, 3)
              .map((r) => `${r.workItemId} → ${r.planSlug}#${r.itemId}`)
              .join('; ')}` +
            `${staleBlockedRows.length > 3 ? `; +${staleBlockedRows.length - 3} more` : ''}. ` +
            'FIX (one call, not a wait): if the block really was blocked-by-derived, clear it with `plans:set-status` and pull again; ' +
            'if the item is deliberately still blocked for a reason the graph cannot see, record that in a plan Decision so the next ' +
            'member reads a cause instead of rediscovering this. windDown is deliberately NOT set: this lane is NOT drained — it is ' +
            'one status write away from claimable, so standing down here abandons real work.'
        : planComplete
          ? `PLAN COMPLETE (EI-20260781488788952): claim spec ${formatSpecRef(scope.record.spec.specId, scope.record.spec.revision)} ` +
            `is bound to plan predicate(s) ${opts!.planTerminality!.terminalPlanSlugs.join(', ')} and every bound plan is terminal. ` +
            'This is a successful completed-plan wind-down, not a spec-authoring problem; checkpoint, release, and stop pulling.'
        : specExhausted
          ? `SPEC EXHAUSTED (EI-20186990913643457): claim spec ${formatSpecRef(scope.record.spec.specId, scope.record.spec.revision)}'s ` +
            `view.filter matched ${opts!.terminalExhaustion!.matchedByFilter} row(s) without the claimable-state floor, and all ` +
            `${opts!.terminalExhaustion!.terminalMatchedByFilter} matching row(s) are terminal. This is a successful drain, not a ` +
            'spec-authoring problem: the lane is complete, so stand down and do not re-author or escalate the spec.'
        : nonIssueSpecEmpty
          ? `ORDINARY DRAIN, NOT A SPEC-AUTHORING PROBLEM (EI-19393442073558754): claim spec ${formatSpecRef(scope.record.spec.specId, scope.record.spec.revision)}'s ` +
            'view.filter references a plan/plan-item and is not restricted to issue-family kinds — a plan-scoped spec routinely and ' +
            'correctly admits ONLY feature-family rows for long stretches (D-009: a plan-promoted item is feature-family unless its ' +
            'own kind is bug/change/task), so the issue-family breakdown\'s `matchedByFilter: 0` is EXPECTED BY CONSTRUCTION here, ' +
            'not a sign the spec itself is broken. ' +
            (opts?.featureFamilyMatched === 0
              ? 'The feature-family (tier-1) pool was ALSO checked and is genuinely empty right now — this is an ordinary drain.'
              : 'The feature-family (tier-1) pool could not be confirmed on this pull — treat this as a likely drain, but verify ' +
                'via plans:items / work_items:claimable before reporting a spec-authoring problem to your fleet leader.') +
            ' Do NOT re-author this claim spec off this signal alone.'
        : specEmpty
          ? `SPEC MATCHES NOTHING (EI-18663622382734446): claim spec ${formatSpecRef(scope.record.spec.specId, scope.record.spec.revision)}'s ` +
            'view.filter matches 0 issue-family row(s) in this harness/workspace at all — this is a SPEC-AUTHORING problem ' +
            '(a stale id allowlist, an over-narrow plan/kind/tag scope, or a typo), NOT a genuinely drained or floor-gated queue. ' +
            (opts?.leaderLiveness === false
              ? 'The registered fleet leader is not live, so do not route this to a dead leader: take leadership as the sole live member or escalate to the fleet launcher/owner, quoting this spec id/revision. '
              : 'ESCALATE to your fleet leader NOW quoting this spec id/revision; ') +
            'do not silently treat this as a normal drain — a zero-match spec never self-heals the way a drained pool eventually does.'
        : cooldown
        ? `${cooldown.cooldownExcluded} in-spec row(s) matched fleet scope ${formatSpecRef(scope.record.spec.specId, scope.record.spec.revision)} ` +
          `but ${cooldown.cooldownExcluded === 1 ? 'is' : 'are'} excluded ONLY by YOUR OWN release-cooldown floor` +
          (cooldownExpirySec != null ? ` (earliest expiry in ~${cooldownExpirySec}s)` : '') +
          '; this is NOT a scope/spec mismatch — do not re-author the claim spec for this miss.'
        : floorGated
          ? `POOL BLOCKED, NOT SPEC-BROKEN (EI-18741523426513509): claim spec ${formatSpecRef(scope.record.spec.specId, scope.record.spec.revision)}'s ` +
            `view.filter matched ${breakdown!.matchedByFilter} issue-family row(s), but every one is presently excluded by a claim floor ` +
            '(see `excludedBreakdownSummary`) — an uncleared plan-lane blocker, a peer\'s claim-hold, needs-human, or similar. This is an ' +
            'EFFECT (the pool is momentarily gated), not a CAUSE (a wrong/over-narrow spec) — the two have opposite remedies (await/re-poll ' +
            'vs. rewrite the spec), so do NOT treat this as a spec-authoring problem: it very likely self-clears once the gating condition ' +
            'lifts, with no spec change required.'
        : `no claimable work-item matched fleet scope ${formatSpecRef(scope.record.spec.specId, scope.record.spec.revision)}; ` +
          'the member was NOT allowed to fall through to the generic backlog',
    fleetScope: {
      fleet: scope.fleetSlug,
      specId: scope.record.spec.specId,
      revision: scope.record.spec.revision,
      source: scope.record.source,
    },
    claimability,
    quarantinedIds,
    // EI-18666093519248020: a claim-path/read-path divergence is NOT a drained lane, so it must
    // never be certified as one. `windDown` is THE signal a member stands its loop down on, so
    // it stays false while the oracle still reports claimable rows.
    // WI-5947: an UNCONFIRMED survivor reading is equally disqualifying for a drain stamp. It may
    // not be a claim-path defect, but it is certainly not evidence of an empty lane — certifying
    // windDown off the back of it is the same harmful call, reached by a different route.
    // WI-7151: same for a confirmed tier-1 (feature-family) match the issue-family breakdown
    // could not see — a real candidate exists, so a member must not stand down off this miss.
    // WI-7316: same call, third route. A lane whose candidates were bounced by a STALE plan-item
    // block is not drained — the rows exist, matched, and were claimable enough to claim; a
    // sticky token that will never self-clear is all that stands between the member and them.
    // Certifying a drain here is the most harmful variant of the three, because unlike a
    // transient divergence it never resolves on its own: every member re-pulls, re-bounces, and
    // stands down in turn, and the fleet goes quiet with work still on the board.
    windDown: !divergent && !unconfirmedSurvivors && !featureFamilyMiss && !staleBlockedLane,
    // EI-15185: the ready-made payload_filter derived from THIS member's own claim
    // spec — present only when the spec can be narrowed over the claimable payload's
    // fields (id/kind/title/plan/tags/goal). It is a candidate hint, not proof that
    // the authoritative claim path will admit the row; copy it verbatim into the
    // idle-park await below and always re-run scheduler:get_next after waking.
    ...(claimablePayloadFilter ? { payloadFilter: claimablePayloadFilter } : {}),
    ...(paused ? { paused: true as const } : {}),
    // EI-15777: surface how many of the caller's OWN pre-pause `work-item:claimable`
    // idle-park await(s) were just cancelled — so the caller (and anyone reading the
    // response) can see the standing wake that would have fired on a peer's next
    // compliant release was actually retired, not merely refused-if-it-fires.
    ...(paused ? { claimableAwaitsCancelled: opts?.claimableAwaitsCancelled ?? 0 } : {}),
    ...(cooldown ? { cooldownOnly: true as const, cooldownExcluded: cooldown.cooldownExcluded, cooldownExpirySec, cooldownExpiryAt, cooldownEarliestRowId: cooldown.earliestRowId } : {}),
    // EI-18663622382734446: named, top-level reason so a caller (or a leader reading a
    // relayed report) can branch on this WITHOUT digging into excludedBreakdown.matchedByFilter.
    // Absent for every other miss shape — this is deliberately the loud, rare case.
    ...(specExhausted
      ? { reason: 'spec_exhausted' as const, terminalExhaustion: opts?.terminalExhaustion }
      : {}),
    ...(planComplete
      ? { reason: 'plan_complete' as const, planTerminality: opts?.planTerminality }
      : {}),
    ...(specEmpty ? { reason: 'spec_matches_nothing' as const } : {}),
    // WI-7316: named, top-level reason + the offending rows, so a caller (or a leader reading a
    // relayed report) can branch on this WITHOUT parsing the error prose — and so the remedy is
    // addressable: each entry names the exact plan item to clear. Deliberately distinct from
    // `all_matches_gated`, whose whole point is "wait, it self-clears"; this one is its opposite.
    ...(staleBlockedLane
      ? { reason: 'stale_plan_item_block' as const, staleBlockedLane: staleBlockedRows }
      : {}),
    // WI-7151 (EI-19318364531323846): named, top-level reason for the issue-family-diagnosis
    // blind spot — a caller (or a leader reading a relayed report) can branch on this WITHOUT
    // digging into excludedBreakdown, and it is DELIBERATELY DISTINCT from `spec_matches_nothing`
    // (opposite remedy: this one means real work exists, do not touch the spec).
    ...(featureFamilyMiss ? { reason: 'issue_family_diagnosis_blind_spot' as const, featureFamilyMatched: opts?.featureFamilyMatched ?? 0 } : {}),
    // EI-19393442073558754: named, top-level reason for the non-issue-only-spec empty case —
    // deliberately distinct from `spec_matches_nothing` (opposite framing: this one means the
    // spec was never broken, only structurally incapable of matching the family it was judged
    // against). `featureFamilyMatched` is surfaced as-observed (0 = confirmed empty, null/undefined
    // = the tier-1 check did not run) so a caller can tell "confirmed drain" from "unconfirmed".
    ...(nonIssueSpecEmpty ? { reason: 'ordinary_drain' as const, featureFamilyMatched: opts?.featureFamilyMatched ?? null } : {}),
    // EI-18741523426513509: named, top-level reason for the floor-gated (transient) case — the
    // effect-vs-cause counterpart of `spec_matches_nothing` above. A caller (or a leader reading
    // a relayed report) can branch on this WITHOUT digging into excludedBreakdown to tell "your
    // spec is wrong, fix it" apart from "your spec is fine, the pool is momentarily gated, wait".
    ...(floorGated ? { reason: 'all_matches_gated' as const } : {}),
    // WI-5947: quotable provenance for the survivor reading — 'confirmed-twice' is what makes a
    // divergence report credible, and its ABSENCE is what tells a reader (or a leader receiving a
    // relayed report) that the claim was never confirmed. Present whenever survivors were seen.
    ...(survivorsReported ? { divergenceRecheck: opts?.divergenceRecheck ?? ('unconfirmed' as const) } : {}),
    ...(opts?.leaderLiveness !== null && opts?.leaderLiveness !== undefined
      ? { leaderLiveness: opts.leaderLiveness }
      : {}),
    // WI-5561: the issue-family floor breakdown — present whenever the diagnosis ran (including
    // the EI-18663622382734446 zero-match case: a genuine query/workspace-resolution failure is
    // the only thing that keeps this absent now, not a `matchedByFilter === 0` result).
    ...(breakdown
      ? {
          excludedBreakdown: breakdown,
          excludedBreakdownSummary: featureFamilyMiss
            ? `Your spec's filter matches 0 issue-family row(s), but ${opts?.featureFamilyMatched} FEATURE-family row(s) match it and ` +
              "pass every claim floor — this breakdown only ever queries bug/change/task rows, so its 0 says nothing about your " +
              'spec\'s feature-family matches. Do NOT treat this as a spec-authoring problem; see the top-level error/advice.'
            : nonIssueSpecEmpty
            ? "Your spec's filter matches 0 issue-family row(s), but the spec is not restricted to issue-family kinds, so this is " +
              'EXPECTED BY CONSTRUCTION (e.g. a plan-scoped spec whose plan\'s items are feature-family) — NOT evidence the spec ' +
              'itself is broken. See the top-level error/advice for whether the feature-family pool was also confirmed empty.'
            : planComplete
            ? `Your spec's plan predicate(s) are all terminal (${opts!.planTerminality!.terminalPlanSlugs.join(', ')}), so the ` +
              'fleet completed its scoped plan; this is a successful wind-down, not a spec-authoring failure.'
            : specExhausted
            ? `Your spec's status-floor-free filter read matched ${opts!.terminalExhaustion!.matchedByFilter} row(s), and all ` +
              `${opts!.terminalExhaustion!.terminalMatchedByFilter} are terminal — the fleet completed its scoped tranche; this is ` +
              'ordinary successful exhaustion, not a spec-authoring failure.'
            : specEmpty
            ? "Your spec's filter matches 0 issue-family row(s) at all — there is nothing for any floor to exclude. " +
              'The SPEC ITSELF is the problem (an over-narrow filter, a stale id allowlist, wrong plan/kind scoping), not the pool.'
            : `Your spec's filter matches ${breakdown.matchedByFilter} issue-family row(s); stranded by: ` +
            Object.entries(breakdown.excluded)
              .filter(([, n]) => (n as number) > 0)
              .sort((a, b) => (b[1] as number) - (a[1] as number))
              .map(([k, n]) => `${k}=${n}`)
              .join(', ') +
            (divergent
              ? ` — BUT ${breakdown.claimable} of them survive ALL floors, so this pool is NOT floor-gated. The floors below are ` +
                'informational only; they are not why you got nothing. The claim path failed to select rows the shared oracle ' +
                'reports as claimable, across two attempts (buckets are independent, a row can count under more than one).'
              : unconfirmedSurvivors
                ? ` — and ${breakdown.claimable} of them survived ALL floors at read time, so the pool is NOT floor-gated. This ` +
                  'reading was taken AFTER the claim attempt, so it describes a later instant; treat it as "the pool moved", not ' +
                  'as a floor story and not as a defect (WI-5947). Re-pull rather than re-authoring the spec.'
                : ' (buckets are independent, a row can count under more than one; 0 candidates surviving ALL floors means the pool is genuinely floor-gated, not a scope/spec bug — re-authoring the claim spec will not help).'),
        }
      : {}),
    advice: paused
      ? 'Fleet is paused (winding-down): finish only the atomic step in hand, work_items:checkpoint + release your claims/locks, then call loop:end { acknowledgeOpenDirectives: true, acknowledgeWakeLessAutonomy: true } for any armed loop if AUTO (or another autonomy-implying mode) remains active without a deliberate independent event await, and ack your leader. Do NOT re-park a work-item:claimable await while paused (any pre-pause await of yours was just cancelled server-side, EI-15777 — a peer\'s compliant release will no longer re-wake you for nothing). Resume normal pull cadence only after a fleet:resume cue.'
      : divergent
        ? 'DO NOT STAND DOWN, and do NOT re-author the claim spec — neither is the problem. TWO claim attempts returned nothing while ' +
          'two independent readings of the shared claimability oracle (the SAME floors, via aggregateIssueClaimExclusions) both reported ' +
          'rows passing every one of them, so lane churn is ruled out and this is a genuine defect in the claim path\'s spec narrowing. ' +
          'To keep working RIGHT NOW: list with work_items:claimable { harness, spec: <your fleet slug> } and take a specific row with ' +
          'work_items:claim { id } — the by-id path does not depend on the narrowing that is failing here (note a by-id claim has no ' +
          'terminal-state floor by design, EI-8972, so check the returned item\'s state before building on it; and note the list itself ' +
          'can come back EMPTY under a churning lane even when the count is nonzero — WI-5947 — so re-read it rather than concluding ' +
          'the workaround is broken too). ' +
          'Then report this verdict to your fleet leader as a CLAIM-PATH BUG (the EI-10062 / WI-4309 / WI-5275 / WI-5822 class), ' +
          'quoting excludedBreakdown.claimable AND divergenceRecheck:"confirmed-twice" — that pair is the reproduction, and the ' +
          'confirmation is what distinguishes it from ordinary churn. State it as an observation with its evidence, not as a settled ' +
          'diagnosis: verify the claim path against the CURRENT tree before anyone acts on it, since a relayed report hardens into ' +
          'certainty on each hop and no one re-checks a claim that already carries someone else\'s confidence (WI-3532).'
        : unconfirmedSurvivors
          ? 'PULL AGAIN — that is the whole remedy. Do NOT stand down, do NOT re-author the claim spec, and do NOT report a claim-path ' +
            'bug: the survivor count was read AFTER your claim attempt, so it describes a later instant on a table your fleet is ' +
            'actively mutating, and an unconfirmed reading is not evidence of a defect (WI-5947). Call scheduler:get_next again now; ' +
            'if a row really did free up you will simply get it. Only a miss carrying divergenceRecheck:"confirmed-twice" — two claim ' +
            'attempts against two readings that both showed survivors — is worth escalating.'
          : featureFamilyMiss
          ? `PULL AGAIN, and do NOT re-author the claim spec: ${opts?.featureFamilyMatched} feature-family row(s) match your spec and pass ` +
            'every claim floor (WI-7151 / EI-19318364531323846) — the issue-family-only breakdown above cannot see them, so its ' +
            '`matchedByFilter: 0` is not proof of a spec bug. This claim already retried once against the real tier-1 pool; if it ' +
            'still misses after a couple more pulls, report it to your fleet leader as a possible claim-path defect in the tier-1 ' +
            '(feature-family) narrowing — quoting `reason: "issue_family_diagnosis_blind_spot"` and `featureFamilyMatched` — rather ' +
            'than a spec-authoring problem (do NOT quote spec_matches_nothing; that has the opposite remedy). Do NOT stand down.'
          : staleBlockedLane
          ? 'CLEAR THE STALE BLOCK — do NOT stand down and do NOT just re-poll (WI-7316). ' +
            `${staleBlockedRows.length} row(s) in your lane were CLAIMED on this pull and released because their linked plan item reads ` +
            "`blocked` while every one of its blocked-by dependencies has already resolved. That token is sticky BY DESIGN (it is " +
            'reserved for external blockers the dependency graph cannot see), so re-polling this lane will return the same miss forever: ' +
            'nothing is going to clear it but a person or an agent deciding to. ' +
            `Take one: ${staleBlockedRows
              .slice(0, 3)
              .map((r) => `plans:set-status { slug: "${r.planSlug}", item: "${r.itemId}", status: "todo" }`)
              .join(' · ')}` +
            `${staleBlockedRows.length > 3 ? ` (+${staleBlockedRows.length - 3} more — see staleBlockedLane)` : ''}, ` +
            'then scheduler:get_next again and the rows become claimable. ' +
            'If instead the item IS still genuinely blocked on something the graph cannot express, leave the token and record the ' +
            'cause as a plan Decision (plans:add-decision) — that turns a permanent silent miss into a reason the next member can ' +
            'read, and is the ONLY case where standing down on this lane is correct. Do NOT re-author the claim spec: your spec is ' +
            'fine, and widening it would only pull the same blocked rows in under a different filter.'
          : planComplete
          ? 'PLAN COMPLETE (EI-20260781488788952): every plan named by the claim spec is terminal. Checkpoint any final progress, release remaining lane resources, call loop:end { acknowledgeOpenDirectives: true, acknowledgeWakeLessAutonomy: true }, and report the successful completed-plan wind-down. Do NOT escalate, widen, or re-author the claim spec.'
          : specExhausted
          ? 'LANE COMPLETE: the status-floor-free check found only terminal rows for this spec (reason: "spec_exhausted"). ' +
            'Checkpoint any final progress, release remaining lane resources, call loop:end { acknowledgeOpenDirectives: true, acknowledgeWakeLessAutonomy: true }, and report the successful drain to your ' +
            'fleet leader. ' +
            (claimablePayloadFilter
              ? 'If new work later enters your scope, park the standing watch `watch:create { pattern: "work-item:claimable", wake:true, once:false, payload_filter: <the `payloadFilter` returned in this response> }` and end your turn — do not pass targetKind with wake:true; the watch remains armed after a re-miss, the wake is a HINT, and scheduler:get_next remains authoritative.'
              : 'Do NOT park an UNSCOPED work-item:claimable await — this response has no safe payload filter.') +
            ' Do NOT escalate, widen, or re-author the claim spec.'
          : nonIssueSpecEmpty
          ? 'Do NOT escalate this as a spec-authoring problem, and do NOT re-author the claim spec (EI-19393442073558754): your ' +
            'spec is not restricted to issue-family kinds, so an issue-family `matchedByFilter: 0` is expected by construction, ' +
            'not a sign the spec is broken. Checkpoint any atomic progress, release remaining lane resources, and call ' +
            'loop:end { acknowledgeOpenDirectives: true, acknowledgeWakeLessAutonomy: true } if AUTO (or another autonomy-implying mode) remains active without ' +
            'a deliberate independent event await — otherwise the wake-less stop will be refused. Quote `reason: "ordinary_drain"` ' +
            'if you report it. If you have reason to believe real work should exist, verify ' +
            'directly with plans:items / work_items:claimable before escalating.'
          : specEmpty
          ? opts?.leaderLiveness === false
            ? 'The registered fleet leader is not live (EI-20260781488788952), so do not route this miss to a dead leader. This remains a leader-alert-worthy spec-authoring bug: quote `reason: "spec_matches_nothing"` and excludedBreakdown.matchedByFilter=0 plus your spec id/revision, then take leadership as the sole live member or escalate to the fleet launcher/owner. You may checkpoint any atomic progress, release lane resources, and call loop:end { acknowledgeOpenDirectives: true, acknowledgeWakeLessAutonomy: true } while that handoff is made — but do NOT quietly treat this as "the queue is drained"; unlike a genuine drain, a zero-match spec never clears on its own.'
            : 'ESCALATE to your fleet leader NOW (EI-18663622382734446) — this is a leader-alert-worthy spec-authoring bug, not a ' +
              'normal drain: quote `reason: "spec_matches_nothing"` and excludedBreakdown.matchedByFilter=0 plus your spec id/revision. ' +
              'The leader\'s remedy is scheduler:set_claim_spec { fleet, spec: <a revision whose view.filter actually admits work> } — ' +
              'see fleetScopeLeaderRemedy for the exact one-call widen. You may checkpoint any atomic progress, release remaining lane ' +
              'resources, and call loop:end { acknowledgeOpenDirectives: true, acknowledgeWakeLessAutonomy: true } while you wait — but do NOT quietly treat this as "the queue is drained"; unlike a genuine ' +
              'drain, a zero-match spec never clears on its own no matter how long you wait.'
        : cooldown
          ? 'Cooldown-only miss (EI-13520): the row(s) excluding you are held off ONLY by your own recent-release cooldown (PAPERCUSP_RELEASE_COOLDOWN_SEC, default 300s), not a scope/spec mismatch — for a NORMAL one-time cooldown, re-poll ONCE after cooldownExpiryAt (or park on the standing work-item:claimable watch) and the row clears (or any OTHER fleet member can claim it immediately); do NOT re-author the claim spec for that. ' +
          '`cooldownEarliestRowId` names the SPECIFIC row driving `cooldownExpirySec` — compare it, not just the number, across polls (EI-16519): a mere advancing/never-shrinking `~Ns` is NOT by itself a livelock signal — `last_released_at` can only change via a genuine release-of-a-claimed-row (EI-16475), so when `cooldownExcluded > 1` the reported expiry is a MIN over MULTIPLE rows YOU released at different times, and it legitimately jumps to a LATER instant as the earlier one ages out and a fresher row becomes the new earliest (ordinary churn from actively completing/releasing several in-spec items, not a bug — keep polling, no escalation needed). Only escalate to your leader as a genuine EI-14615 livelock when `cooldownEarliestRowId` stays the SAME id across successive polls while its expiry keeps advancing — that combination is the one that cannot happen without something repeatedly re-claiming and re-releasing that exact row out from under you.'
        : breakdown
          ? 'This is a FLOOR-GATED miss (WI-5561 / EI-18741523426513509), not a scope/spec mismatch — quote `reason: "all_matches_gated"` if you report it (do NOT quote spec_matches_nothing; that is a different, spec-authoring problem with the opposite remedy). See `excludedBreakdownSummary` for which floors (federation-detector / owner-action / claim-hold / observation-lane / plan-lane externalBlocker / …) are excluding your spec\'s matched rows — these floors are commonly TRANSIENT (e.g. an uncleared plan-lane gate that clears the moment a dependency plan-item closes) and often self-resolve within seconds to minutes with no intervention. Checkpoint, release, call loop:end { acknowledgeOpenDirectives: true, acknowledgeWakeLessAutonomy: true }, and report the breakdown to your fleet leader if it persists — a floor-gated pool needs a DIFFERENT lane/scope (or the gating condition itself resolved by whoever owns it), not a claim-spec re-author. ' +
            (claimablePayloadFilter
              ? 'You may still park the standing watch `watch:create { pattern: "work-item:claimable", wake:true, once:false, payload_filter: <the `payloadFilter` returned in this response> }` in case a floor lifts (a claim-hold or owner-action gate clears) and end your turn — do not pass targetKind with wake:true; its wake is a HINT and the watch remains armed.'
              : 'Do NOT park an UNSCOPED work-item:claimable await — it would fire on every system-wide release for nothing (EI-15185).')
          : claimablePayloadFilter
            ? 'Checkpoint any atomic progress, release remaining lane resources, and call loop:end { acknowledgeOpenDirectives: true, acknowledgeWakeLessAutonomy: true }. To wake on payload candidates matching your claim spec (and the caller harness when present), rather than every system-wide release (EI-15185), park the standing watch `watch:create { pattern: "work-item:claimable", wake:true, once:false, payload_filter: <the `payloadFilter` returned in this response> }` and end your turn. This is a CANDIDATE HINT, not a full admission predicate: claim floors, rig availability, and lifecycle races may still reject a matching wake, so scheduler:get_next stays the authoritative claim; do not pass targetKind with wake:true, and a re-miss does not require re-registering the watch.'
            : 'Checkpoint any atomic progress, release remaining lane resources, call loop:end { acknowledgeOpenDirectives: true, acknowledgeWakeLessAutonomy: true }, and report the scoped miss to the fleet leader. Do NOT park an UNSCOPED work-item:claimable await — your spec narrows only on fields the claimable event payload does not carry, so an unscoped await would fire (and waste a full wake) on every system-wide release (EI-15185). Resume only after a claim-spec revision or a leader/inbox wake.',
  };
}
