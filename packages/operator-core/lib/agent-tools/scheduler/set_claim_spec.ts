/**
 * scheduler:set_claim_spec — the Queen's steer-don't-dispatch lever
 * (hybrid-bee-scheduler-work-stealing-2026-06-22).
 *
 * The Queen expresses her scheduling judgment for a bee as a versioned claim SPEC
 * (view.filter + rank, from the prioritization-primitive vocabulary). The bee's
 * scheduler:get_next then deterministically pulls per this spec within the global floors.
 * Re-steering a running bee is a spec bump (the revision increments) — not micro-dispatch.
 * The spec is validated (validateClaimSpec) before it is stored (mig 372 bee_claim_specs);
 * global hard floors (blocked/ready/dedup) are NOT spec-settable — the resolver always enforces them.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { resolveClaimSpecWorkspace, setClaimSpec } from '../../scheduler/claim-spec-store';
import type { ClaimSpecRecord } from '../../scheduler/claim-spec-store';
import { resolveClaimSpecPotSlug } from '../../scheduler/claim-spec-workspace';
export { resolveClaimSpecPotSlug } from '../../scheduler/claim-spec-workspace';
import { resolveWorkspaceHiveScope } from '../coordination/federation-scope';
import { fetchWakeability } from '../coordination/presence-wakeability';
import { claimSpecSchema, claimSpecReferencesField, positiveIdCohortIds, validateClaimSpec, type ClaimSpec } from '../../scheduler/claim-spec';
import type { ClaimFloorAttribution } from '../../work-items';
import { evaluateGoalFenceGuardForIncumbent } from '../../scheduler/spec-pool-preview';

/**
 * The coding-FACTORY push-pipeline roles: each is HANDED a FEATURE_ID by the orchestrator
 * spine (NEXT_SCOPER/NEXT_ARCHITECT/… all carry `FEATURE_ID=`) and NEVER calls
 * scheduler:get_next, so a claim-spec set on one is INERT — the exact bee-vs-scoper conflation
 * this advisory guards (coding-hive-bee-vs-coding-factory-scoper-2026-06-23).
 *
 * This is deliberately the INVERSE of a self-pulling allowlist (the prior `{bee,queen}` denylist).
 * A self-puller is a coding-hive bee, the queen, OR an su fleet LEADER/MEMBER instructed to pull
 * via get_next (su-loop-capability-parity P-001/P-003) — plus a plain su session with no nursery
 * row. NONE of those appear here, so none trip the advisory: the fix for the false-positive that
 * fired 'INERT spec' on every SU fleet member. We warn ONLY for a spawned role that is a genuine
 * factory push-role. Mirrors FACTORY_PIPELINE_ROLES in fleet/operator-spawn.ts; kept local (and
 * inclusive of `worker`, which that set omits because it validates a worker via chunk-presence
 * instead) because a worker also never self-pulls, so a spec on one is equally inert.
 */
const FACTORY_PUSH_ROLES = new Set([
  'scoper',
  'architect',
  'worker',
  'validator',
  'reviewer',
  'debugger',
  'documenter',
  'curator',
  'director',
]);

/**
 * Pure advisory decision (unit-testable without the nursery): given the target's spawned role
 * (from lookupSpawnedRole — or null when no spawn row resolves: a plain su session, an su fleet
 * member launched as a bare collaborator, a queen), return the prominent INERT-spec warning ONLY
 * when the role is a coding-FACTORY push role. A null/unknown role, a bee/queen, or an su fleet
 * leader/member returns null — no false-positive on every SU fleet member (su-loop-capability-parity
 * P-003). Exported for the advisory unit test.
 */
export function claimSpecInertWarning(cupId: string, spawnedRole: string | null): string | null {
  if (!spawnedRole || !FACTORY_PUSH_ROLES.has(spawnedRole)) return null;
  return (
    `cupId "${cupId}" was spawned as role="${spawnedRole}", a coding-FACTORY push-pipeline role ` +
    'that is HANDED a FEATURE_ID and never calls scheduler:get_next — so this claim-spec is INERT ' +
    '(it will never select any work). Claim-specs steer SELF-PULLING agents: an su fleet ' +
    'leader/member instructed to pull via get_next. ' +
    'Did you mean to push a FEATURE_ID to this factory role, or to steer a self-puller instead?'
  );
}

/**
 * Pure advisory decision (unit-testable without PG): EI-6079 — `fleet:assignments`
 * can show a bee as alive/present (a fresh nursery heartbeat, or presence written
 * at launch) while it has NOT YET registered a live `coord:inbox-wake:<id>` await
 * (e.g. a just-spawned session still in its launch→first-await window — the
 * `recorded` sessionState in presence-wakeability.ts) or has already lost it (a
 * dead/reaped row). Either way, `scheduler:set_claim_spec` steering that bee looks
 * like it worked (the spec write itself always succeeds — the resolver doesn't
 * care whether anyone will ever apply it), but a SUBSEQUENT `coord:send { wake:
 * "required" }` warm-inject silently returns `woken:0`: the placement layer
 * believes warm reuse is available when the wake layer cannot actually reach the
 * session. Surfacing that mismatch HERE, at spec-set time, is the earliest point
 * a caller can catch it — instead of discovering it only after a wake attempt
 * fails. Advisory only (mirrors claimSpecInertWarning): never blocks the write,
 * since the bee may simply not have reached its first await YET and will be
 * wakeable moments later.
 */
export function claimSpecWakeabilityWarning(cupId: string, wakeable: boolean | null): string | null {
  if (wakeable !== false) return null; // true, or unknown (null) — never cry wolf on a lookup miss
  return (
    `cupId "${cupId}" has NO live coord:inbox-wake standing await right now — a subsequent ` +
    'coord:send { wake:"required" } warm-inject to this bee will return woken:0 even though ' +
    "fleet:assignments may show it alive (EI-6079: a fresh spawn hasn't reached its first await " +
    'yet, or the session already ended/was reaped). The spec is stored regardless (it applies ' +
    'whenever the bee next calls scheduler:get_next), but do not rely on warm-injecting THIS bee ' +
    'until coord:presence shows it wakeable — relaunch/re-check instead of assuming reuse.'
  );
}

export interface ClaimSpecAdmissionPreview {
  mode: 'dynamic' | 'fixed-cohort';
  checked: boolean;
  cohortIds?: string[];
  checkedIssueIds?: string[];
  uncheckedFeatureIds?: string[];
  unknownIds?: string[];
  /** New-acquisition eligibility, never inflated by the target fleet's existing claims. */
  admissibleIds?: string[];
  /** Scope can also include admissible work already held by a verified target-fleet member. */
  scopeAdmissibleIds?: string[];
  alreadyHeldIds?: string[];
  floored?: ClaimFloorAttribution[];
  effectiveStates?: readonly string[];
  reason?: string;
  /**
   * WI-5212: dynamic specs get a write-time POOL-EFFECT count (the fixed-cohort path has
   * WI-4429's admission check instead): how many claimable rows the filter matches, vs the
   * pool, vs the previously-stored spec at the same target. `previewError` = the count
   * failed and the guard FAILED OPEN (the spec was still stored).
   */
  poolEffect?: {
    matched: number;
    pool: number;
    states: string[];
    harness: string | null;
    previousMatched: number | null;
    previousSource: 'authored' | 'default';
    /**
     * WI-38283: the OTHER half of the before/after story. `previousMatched` says the lane
     * moved; this says WHICH guaranteed `not:` predicates the revision stopped carrying —
     * the destructive-widening shape `confirmCollapse` is blind to. Empty when none were
     * dropped; absent when there was no authored incumbent to diff against.
     */
    droppedExclusions?: string[];
    /** True when the revision matched strictly more rows than the authored incumbent. */
    widened?: boolean;
  };
  previewError?: string;
}

type ExplainIssueFloors = typeof import('../../work-items').explainIssueClaimFloors;

type ResolveWorkItemFamily = (id: string, harness: string) => Promise<'issue' | 'feature' | null>;

/**
 * WI-4429: reject a fixed issue cohort that is already 0-admissible BEFORE the
 * spec is stored. Reuses explainIssueClaimFloors (the claim path's own SQL floor
 * fragments) and the same conservative ID extractor the issue fallback uses.
 * EI-25159722494650027: storing a fleet's scope is not acquiring a new claim.
 * A verified member's existing claim can keep the cohort alive, but only after
 * the shared evaluator checks every remaining floor in that member's context.
 */
export async function previewClaimSpecAdmission(args: {
  spec: ClaimSpec;
  harness?: string;
  assignee: string;
  fleet?: string;
  explain?: ExplainIssueFloors;
  resolveFamily?: ResolveWorkItemFamily;
  resolveFleetMembers?: (fleet: string) => Promise<string[]>;
}): Promise<{ preview: ClaimSpecAdmissionPreview; errors: string[]; warning?: string }> {
  const cohortIds = positiveIdCohortIds(args.spec.view.filter);
  if (cohortIds === null) {
    return {
      preview: {
        mode: 'dynamic',
        checked: false,
        reason:
          'no conservatively-extractable positive ID cohort; admissibility remains live and is evaluated at pull time',
      },
      errors: [],
    };
  }

  // `WI-*` is NOT a family discriminator: plan-promoted feature-family work-items
  // also receive WI ids. Resolve every ambiguous id through the unified work-item
  // reader before applying issue-only floors, otherwise a valid WI feature reads as
  // `not-found` in engineer_issues and a 0/N preview falsely rejects the spec.
  const ambiguousIds = cohortIds.filter((id) => /^(?:WI|EI)-/i.test(id));
  if (ambiguousIds.length === 0) {
    return {
      preview: {
        mode: 'fixed-cohort',
        checked: false,
        cohortIds,
        checkedIssueIds: [],
        uncheckedFeatureIds: cohortIds,
        reason: 'cohort contains no WI-/EI- ids; feature-family floors remain enforced at pull time',
      },
      errors: [],
    };
  }
  if (!args.harness) {
    return {
      preview: {
        mode: 'fixed-cohort',
        checked: false,
        cohortIds,
        checkedIssueIds: [],
        reason: 'a concrete harness is required to resolve WI-/EI- work-item families and evaluate issue claim floors',
      },
      errors: [
        'harness is required when a claim spec names WI-/EI- ids — the write-time floor preview cannot safely infer their scope',
      ],
    };
  }

  const resolveFamily =
    args.resolveFamily ??
    (async (id: string, harness: string) => {
      const { getWorkItem } = await import('../../work-items');
      return (await getWorkItem(id, harness))?.family ?? null;
    });
  const resolved = await Promise.all(
    ambiguousIds.map(async (id) => ({ id, family: await resolveFamily(id, args.harness as string) })),
  );
  const issueIds = resolved.filter((row) => row.family === 'issue').map((row) => row.id);
  const featureIds = [
    ...cohortIds.filter((id) => !/^(?:WI|EI)-/i.test(id)),
    ...resolved.filter((row) => row.family === 'feature').map((row) => row.id),
  ];
  const unknownIds = resolved.filter((row) => row.family === null).map((row) => row.id);

  // Mirrors claimFloorsWhereSql's unified ['open'] default (work-item-status-full-unify P-004/P-005).
  const effectiveStates = args.spec.states ?? ['open'];
  const explain = args.explain ?? (await import('../../work-items')).explainIssueClaimFloors;
  const rows =
    issueIds.length > 0
      ? await explain(args.harness, issueIds, {
          assignee: args.assignee,
          states: effectiveStates,
        })
      : [];
  const unknownRows: ClaimFloorAttribution[] = unknownIds.map((id) => ({
    id,
    admissible: false,
    refusedBy: 'not-found',
    detail: 'no such work-item in either family for this harness/workspace',
  }));
  const admissibleIds = rows.filter((row) => row.admissible).map((row) => row.id);
  const scopeRows = new Map(rows.map((row) => [row.id, row]));
  const alreadyHeldIds: string[] = [];
  let heldPreviewError: string | undefined;
  const heldRows = rows.filter((row) => row.refusedBy === 'already-taken' && row.heldBy);
  if (args.fleet && heldRows.length > 0) {
    try {
      // Reuse the binding-control roster, NOT the delivery audience: muted/digest
      // members still own fleet work. Never infer membership from the writer.
      const resolveMembers = args.resolveFleetMembers ??
        (await import('../coordination/audience-host')).listFleetControlMembers;
      const members = new Set(await resolveMembers(args.fleet));
      const byHolder = new Map<string, string[]>();
      for (const row of heldRows) {
        if (!members.has(row.heldBy!)) continue;
        const ids = byHolder.get(row.heldBy!) ?? [];
        ids.push(row.id);
        byHolder.set(row.heldBy!, ids);
      }
      for (const [holder, ids] of byHolder) {
        // already-taken is the FIRST refusal. Merely waiving that attribution
        // would conceal claim-hold, admission, blockers, etc. Recheck through
        // the SAME SQL floors, with this holder's cooldown/plan-lane context.
        const checked = await explain(args.harness, ids, {
          assignee: holder,
          states: effectiveStates,
          scopeHeldBy: [holder],
          claimantFleetSlug: args.fleet,
          claimSpecReferencesFleet: claimSpecReferencesField(args.spec, 'fleet'),
          claimSpecReferencesGoal: claimSpecReferencesField(args.spec, 'goal'),
        });
        for (const row of checked) {
          if (!ids.includes(row.id)) continue;
          scopeRows.set(row.id, row);
          if (row.admissible) alreadyHeldIds.push(row.id);
        }
      }
    } catch (err) {
      // Unknown membership/floors never authorize held work. Preserve the
      // ordinary attributions and disclose the failed preview, not a false zero.
      heldPreviewError = `could not verify target-fleet held-cohort admission: ${err instanceof Error ? err.message : String(err)}`;
      scopeRows.clear();
      for (const row of rows) scopeRows.set(row.id, row);
      alreadyHeldIds.length = 0;
    }
  }
  const scopeAdmissibleIds = rows.filter((row) => scopeRows.get(row.id)?.admissible).map((row) => row.id);
  const floored = [...scopeRows.values()].filter((row) => !row.admissible).concat(unknownRows);
  const preview: ClaimSpecAdmissionPreview = {
    mode: 'fixed-cohort',
    checked: featureIds.length === 0,
    cohortIds,
    checkedIssueIds: issueIds,
    uncheckedFeatureIds: featureIds,
    unknownIds,
    admissibleIds,
    scopeAdmissibleIds,
    alreadyHeldIds,
    floored,
    effectiveStates,
    ...(heldPreviewError ? { previewError: heldPreviewError } : {}),
    ...(featureIds.length > 0 ? { reason: 'feature-family claim floors remain enforced at pull time' } : {}),
  };
  const floorSummary = floored.map((row) => `${row.id}:${row.refusedBy ?? 'unknown'}`).join(', ');
  const noUncheckedFeatureCandidate = featureIds.length === 0;
  if (noUncheckedFeatureCandidate && scopeAdmissibleIds.length === 0) {
    return {
      preview,
      errors: [
        `claim spec names ${cohortIds.length} id(s); 0 are claim-path admissible under states=[${effectiveStates.join(',')}]: ${floorSummary}`,
        ...(heldPreviewError ? [heldPreviewError] : []),
      ],
    };
  }
  const warningParts: string[] = [];
  if (alreadyHeldIds.length > 0) {
    warningParts.push(
      `${alreadyHeldIds.length} cohort id(s) are already held by target fleet "${args.fleet}" and accepted for scope authoring only, not new acquisition: ${alreadyHeldIds.join(',')}`,
    );
  }
  if (heldPreviewError) warningParts.push(heldPreviewError);
  if (floored.length > 0) {
    warningParts.push(
      `${floored.length}/${issueIds.length + unknownIds.length} checked issue/unknown id(s) are currently floored ` +
        `under states=[${effectiveStates.join(',')}]: ${floorSummary}`,
    );
  }
  if (featureIds.length > 0) {
    warningParts.push(
      `${featureIds.length} feature-family id(s) were not rejected at write time; their shared floors remain authoritative at pull time: ${featureIds.join(',')}`,
    );
  }
  return {
    preview,
    errors: [],
    ...(warningParts.length > 0 ? { warning: warningParts.join('\n') } : {}),
  };
}

/**
 * Best-effort: resolve the role a `cupId` was spawned as, by looking it up in the nursery
 * (harness_shared.spawned_agents). `cupId` is the bee's session/owner id, which the nursery records
 * under ANY of spawn_id / session_owner / session_id (the fleet-assignment-view alias set), so match
 * all three. Returns null when no spawn row resolves (a plain session id with no nursery record, a
 * superuser, etc.) — the caller then skips the warning. Swallows every lookup error: a claim-spec
 * write must never fail on this advisory probe.
 */
async function lookupSpawnedRole(cupId: string): Promise<string | null> {
  try {
    const sql = getOrgPg().sql;
    const rows = (await sql`
      SELECT child_role
        FROM harness_shared.spawned_agents
       WHERE spawn_id = ${cupId} OR session_owner = ${cupId} OR session_id = ${cupId}
       ORDER BY started_at DESC
       LIMIT 1`) as Array<{ child_role: string | null }>;
    return rows[0]?.child_role ?? null;
  } catch {
    return null;
  }
}

/**
 * EI-20079462322478221: a claim-spec write is a control-plane change, so it must
 * wake a member parked on the value-derived `work-item:claimable` filter even
 * when no future claimable payload can satisfy that old snapshot. The event
 * engine owns the atomic await claim + durable delivery; this seam only resolves
 * the affected subscribers. A fleet target uses the live fleet audience so a
 * departed owner is never accidentally woken after it joins another fleet.
 *
 * Best-effort by design: the spec write is already durable and scheduler:get_next
 * remains authoritative. A roster/await-plane failure is surfaced to the caller,
 * rather than turning a successful spec write into a false failure.
 */
export async function wakeClaimableAwaitersAfterSpecChange(input: {
  cupId: string;
  fleet?: string;
  specId?: string | null;
  revision?: number | null;
}): Promise<{ woken: number; warning?: string }> {
  try {
    const subscriberIds = input.fleet
      ? await (await import('../coordination/audience-host')).hostAudienceResolvers.listFleetMembers(input.fleet)
      : [input.cupId];
    const { wakeClaimableAwaitersForSubscribers } = await import('../../events/await/engine');
    return {
      woken: await wakeClaimableAwaitersForSubscribers({
        subscriberIds,
        specId: input.specId,
        revision: input.revision,
      }),
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      woken: 0,
      warning: `claim-spec revision stored, but parked claimable awaiters could not be woken: ${detail}`,
    };
  }
}

export default defineTool({
  name: 'scheduler:set_claim_spec',
  profile: 'engineer',
  description:
    "Steer a SELF-PULLING agent — a coding-hive bee or an su fleet member — by setting/replacing its versioned claim spec (view.filter + rank). The agent's scheduler:get_next then pulls deterministically per this spec within the global floors. Re-steer a running puller by setting a new spec (the revision bumps; it's picked up on the next get_next) — not by micro-dispatching. Validates the spec; returns { ok, errors, revision, warning? } (EI-6079: a `warning` can flag the bee as not currently wakeable — the spec still stored, but a warm-inject wake to it may return woken:0).",
  guidance: {
    when: 'Steer a SELF-PULLING agent that calls scheduler:get_next: a coding-hive bee or an su fleet member. Set a property-filtered view plus rank for a standing lane; use `id in [...]` only for a static pinned wave. Re-steer by bumping the spec, not by micro-dispatching.',
    notWhen:
      'A coding-FACTORY push role (scoper/architect/worker/validator): it is handed a FEATURE_ID and never calls get_next, so a spec is inert. Not for hand-picked micro-dispatch, or for overriding global floors (blocked/ready/dedup/cursed) — the resolver enforces those.',
    chaining: 'scheduler:set_claim_spec → the puller applies it on the next scheduler:get_next.',
    seeAlso: [
      // EI-20185841251188914 — see the same note on scheduler:get_claim_spec. In seeAlso
      // rather than when/notWhen/chaining because seeAlso is outside the prompt-weight
      // budget; pinned by scope-args-contract.test.ts.
      'scheduler:get_claim_spec (read back the spec you just wrote — MIRROR SCOPE ARGS: it takes workspace and NO harness, this write takes harness and NO workspace, so do not copy a scope key across the get→set→get chain)',
      'scheduler:preview_spec_delta (dry-run this revision first — the scope superset: cupId|fleet plus BOTH harness and workspace)',
      'scheduler:get_next (the puller pulls per this spec)',
      'scheduler:running (what is executing now)',
      'fleet:assignments (drill into a member/bee)',
    ],
  },
  capability: 'work_items:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      cupId: z
        .string()
        .min(1)
        .optional()
        .describe('the cup to steer (its session/owner id) — exactly one of cupId | fleet'),
      fleet: z
        .string()
        .min(1)
        .optional()
        .describe(
          'a FLEET slug to steer as a whole (fleet-scheduler-hardening P-002): stores the spec under the fleet:<slug> sentinel; every member WITHOUT a per-bee spec inherits it on their next get_next (bee spec → fleet spec → default). The standing-lane lever for fleet relaunches — fresh members inherit the lane with no per-bee re-authoring. A per-bee spec always wins over the fleet spec.',
        ),
      harness: z
        .string()
        .min(1)
        .optional()
        .describe(
          'harness used by the WRITE-TIME admission preview for a fixed WI-/EI- cohort. Required for a named issue cohort unless the caller is harness-scoped; dynamic/property specs do not need it.',
        ),
      clear: z
        .boolean()
        .optional()
        .describe(
          'EI-12830: DELETE the target row instead of setting a spec, so the target falls back to fleet inheritance (bee spec → fleet spec → DEFAULT). Use on a `cupId` to drop a per-bee override that permanently shadows every later fleet-level `{ fleet }` re-steer, or on a `fleet` to retire the whole fleet lane back to default. Idempotent (clearing an absent row reports cleared:false); `spec` is not required (and is ignored) when clear:true. The delete tombstones any hive-federated row so remote peers drop the stale spec too.',
        ),
      confirmCollapse: z
        .boolean()
        .optional()
        .describe(
          'WI-5212 pool-collapse override: a dynamic spec is REFUSED at write time when it matches 0 rows of a nonempty claimable pool, or a revision craters the match count vs the stored spec (the two fleet-starvation shapes, EI-13306). Pass true ONLY after reading the refusal’s reported counts and confirming the narrowing is intended (e.g. a pre-staged lane whose items are not promoted yet).',
        ),
      confirmGoalFenceDrop: z
        .boolean()
        .optional()
        .describe(
          'EI-22389918023611568 sovereignty override: a replacement is REFUSED when an existing authored claim lane guarantees a positive `goal` filter and the proposed filter drops that guarantee, even if the pool count increases. Pass true ONLY after verifying the replacement is an explicit active-goal exclusion fence (goal_id IS NULL, this goal, or deactivated-goal work); a positive zero-match fence may be an intentional stand-down brake.',
        ),
      spec: claimSpecSchema
        .optional()
        .describe(
          'the claim spec: { specVersion, specId, revision, view:{ filter }, rank:{ mode, terms }, limits?, states? } — validated by validateClaimSpec. ' +
            'CONCRETE SHAPES (EI-4832 — get these wrong and the write is rejected): ' +
            'specVersion is the STRING "1.0" (not "1" or a number). ' +
            'view.filter is a FILTER NODE: either one LEAF predicate { field, op, value } OR a combinator { all:[nodes...] } / { any:[nodes...] } / { not:node }; ' +
            'field is one of priority|tags|kind|risk_tier|paths|plan|plan_item|age|redundancy|est_cost|assignee|id|title|severity|goal (never blocked/cursed; those are global floors); ' +
            '`title` (WI-3268) is for durable keyword EXCLUSION when `tags` is unpopulated — e.g. `{ not:{ field:"title", op:"word", value:"p2p" } }` to stop a fleet re-encountering excluded work; not rankable. Prefer `word` (whole-word) over `glob`\'s `*p2p*` (bare substring — false-positives on a title merely CONTAINING "p2p", e.g. a fleet named "nonp2p-..."). ' +
            'op is one of = | != | < | <= | > | >= | in | contains | glob | word. ' +
            'rank.mode is "lexicographic" (terms break ties in order) or "weighted" (each term needs a numeric `weight`; only priority|age|est_cost|redundancy and numeric functions may be summed). ' +
            'rank.terms is an ARRAY of { expr, dir }, NOT { field, order }; functions include affinity(bee.held_paths,item.paths) | severity_rank | dependency_unlock_score | cluster_priority | model_fit(bee.model,item) | tag_weight(tags) | redundancy_need. dependency_unlock_score is the number of downstream items for which this candidate is the last unresolved blocker; work_items:claimable exposes the same value as dependencyUnlockScore. cluster_priority reads the resolver-computed numeric payload.clusterPriority projection (largest persisted cause-cluster first with { expr:"cluster_priority", dir:"desc" }); it never computes clustering at assignment time, and missing/malformed values are neutral. Bare id|title|severity|risk_tier are not rankable; use severity_rank desc for critical-first ordering, or a severity filter to scope the lane. ' +
            'EXAMPLE: { specVersion:"1.0", specId:"bugs", revision:1, view:{ filter:{ field:"kind", op:"in", value:["bug","change"] } }, rank:{ mode:"lexicographic", terms:[{ expr:"severity_rank", dir:"desc" }, { expr:"age", dir:"asc" }] } }. ' +
            'OPTIONAL view.fence (WI-6050): named fences expand server-side from the shared P2P_LANE_EXCLUSION_TERMS source and AND onto any filter. `p2p-lane` matches title, summary, and source plan; `p2p-plan-lane` matches only the structured source-plan field (source_plan_slug plus its supported payload fallback), avoiding summary-only false positives while blocking P2P plan scope. The plan-only form preserves an existing title filter without broadening it to arbitrary summary text. ' +
            "OPTIONAL `states` (drain-claim-spec-hardening-2026-07-13, D-002/EI-11300): a claimable-status subset — same allowlist as scheduler:get_next's own `states` arg (open|failing). `open` is the unified claimable token for BOTH families now (feature `todo` retired, work-item-status-full-unify), and it is the floor default — so an unqualified spec already matches every open bug AND feature; set `states` only to restrict further (e.g. add `failing` for re-drive). A member's explicit get_next {states} still wins over this.",
        ),
    })
    .refine((a) => Boolean(a.cupId) !== Boolean(a.fleet), {
      message: 'pass exactly ONE of cupId (steer one cup) or fleet (steer the whole fleet via inheritance)',
    })
    .refine((a) => a.clear === true || a.spec !== undefined, {
      message:
        'spec is required unless clear:true (clear deletes the target row so it falls back to fleet inheritance)',
    }),
  async handler(args, ctx) {
    const ident = resolveAgentIdentity(ctx);
    // EI-12830: CLEAR path — delete the target's per-bee (or fleet-sentinel) row so
    // it falls back to fleet inheritance (bee → fleet → default). No spec to validate
    // and no admission preview; the store's DELETE tombstones any hive-federated row.
    if (args.clear) {
      const { clearClaimSpec, fleetSpecBeeKey } = await import('../../scheduler/claim-spec-store');
      const fleetSlug = args.fleet?.trim();
      const targetBeeId = fleetSlug ? fleetSpecBeeKey(fleetSlug) : (args.cupId as string);
      const cleared = await clearClaimSpec({
        cupId: targetBeeId,
        workspaceId: resolveClaimSpecWorkspace(ident.workspaceId),
      });
      const wake = cleared.cleared
        ? await wakeClaimableAwaitersAfterSpecChange({
            cupId: targetBeeId,
            fleet: fleetSlug,
            specId: null,
            revision: null,
          })
        : { woken: 0 };
      return {
        data: {
          ...cleared,
          claimableAwaitersWoken: wake.woken,
          ...(wake.warning ? { warning: wake.warning } : {}),
          target: fleetSlug ? { fleet: fleetSlug, beeKey: targetBeeId } : { cupId: targetBeeId },
        },
      };
    }
    const validated = validateClaimSpec(args.spec);
    if (!validated.ok || !validated.spec) {
      return { data: { ok: false, errors: validated.errors } };
    }
    const ctxHarnessRaw = (ctx as { harnessSlug?: unknown }).harnessSlug;
    const resolvedHarness = resolveClaimSpecPotSlug(args.harness, ctxHarnessRaw);
    // Fleet target (P-002): validate the fleet exists (mirrors WI-1408 — a typo'd slug
    // must fail loud, not store a spec no member will ever inherit), then store under
    // the sentinel key. Membership-spec resolution happens bee-side in getClaimSpec.
    let targetBeeId = args.cupId as string;
    if (args.fleet) {
      const fleetSlug = args.fleet.trim();
      const wsForFleet = ident.workspaceId && ident.workspaceId !== '*' ? ident.workspaceId : undefined;
      const { getFleet } = await import('../../agent-fleets-store');
      const { activeWorkspaceId } = await import('../../workspace-registry');
      const record = await getFleet(wsForFleet ?? activeWorkspaceId(), fleetSlug);
      if (!record) {
        return {
          data: {
            ok: false,
            errors: [
              `fleet \`${fleetSlug}\` does not exist in this workspace — a fleet-level spec for it would never be inherited (check the slug, or create the fleet first)`,
            ],
          },
        };
      }
      const { fleetSpecBeeKey } = await import('../../scheduler/claim-spec-store');
      targetBeeId = fleetSpecBeeKey(fleetSlug);
    }
    const admission = await previewClaimSpecAdmission({
      spec: validated.spec,
      harness: resolvedHarness,
      assignee: ident.ownerId,
      fleet: args.fleet?.trim(),
    });
    if (admission.errors.length > 0) {
      return {
        data: {
          ok: false,
          errors: admission.errors,
          admissibilityPreview: admission.preview,
        },
      };
    }

    // EI-22389918023611568: a replacement can widen a GOAL-scoped lane while
    // increasing its pool count (so the generic collapse guard is intentionally
    // silent). Read the incumbent effective row once and protect its positive
    // goal fence before any pool preview or write. A zero-match positive fence
    // may be a deliberate stand-down brake; it is not permission to broaden a
    // live fleet into the whole kind backlog. The explicit acknowledgement is
    // separate from confirmCollapse so a starvation override cannot accidentally
    // waive this ownership boundary.
    let incumbentRecord: ClaimSpecRecord | null = null;
    let goalFenceWarning: string | undefined;
    try {
      const { getClaimSpecRecord } = await import('../../scheduler/claim-spec-store');
      incumbentRecord = await getClaimSpecRecord({
        cupId: targetBeeId,
        workspaceId: resolveClaimSpecWorkspace(ident.workspaceId),
      });
      const goalFence = evaluateGoalFenceGuardForIncumbent({
        incumbent: incumbentRecord,
        candidateFilter: validated.spec.view.filter,
        confirm: args.confirmGoalFenceDrop === true,
      });
      if (goalFence.refuse) {
        return {
          data: {
            ok: false,
            errors: goalFence.errors,
            admissibilityPreview: admission.preview,
          },
        };
      }
      goalFenceWarning = goalFence.warning;
    } catch (err) {
      // This is a diagnostic guard around an already-valid write. If the
      // incumbent cannot be read, preserve the existing fail-open posture but
      // say so loudly; the caller must not mistake an uninspected replacement
      // for a verified sovereignty-safe one.
      const detail = err instanceof Error ? err.message : String(err);
      goalFenceWarning = `positive goal-fence guard could not inspect the incumbent spec (write proceeds fail-open): ${detail}`;
    }

    // WI-5212: write-time POOL-EFFECT preview + collapse guard for DYNAMIC specs (the
    // fixed-cohort path already has WI-4429's admission check above). Both 2026-07-16/17
    // fleet starvations were specs that VALIDATED fine and matched (nearly) nothing —
    // a kind scope with zero rows, and a NULL-poisoned not:{plan} fence (EI-13306) that
    // hid 99% of the pool. Measure the effect with the SAME compiled filter get_next
    // runs, refuse the two starvation shapes unless confirmCollapse:true, and FAIL OPEN
    // on any preview error (the guard must never become the new way to block a write).
    let poolEffect: ClaimSpecAdmissionPreview['poolEffect'];
    let poolEffectError: string | undefined;
    let poolEffectWarning: string | undefined;
    // WI-38283: the widening direction the collapse guard does not cover — reported, never refused.
    let wideningWarning: string | undefined;
    if (admission.preview.mode === 'dynamic') {
      try {
        const { previewSpecPoolEffect, evaluateCollapseGuard, evaluateWideningDisclosure } = await import('../../scheduler/spec-pool-preview');
        const { activeWorkspaceId } = await import('../../workspace-registry');
        const wsForCount = ident.workspaceId && ident.workspaceId !== '*' ? ident.workspaceId : activeWorkspaceId();
        const countScope = { workspaceId: wsForCount, harness: resolvedHarness ?? null };
        const current = await previewSpecPoolEffect(validated.spec, countScope);
        // Effective-BEFORE at the same target key (bee row → fleet inheritance → default).
        // 'default' means nobody authored this lane — narrowing from default is normal
        // lane-authoring and never refuses; only a cratered AUTHORED lane does.
        let previousMatched: number | null = null;
        let previousSource: 'authored' | 'default' = 'default';
        let previousFilter: ClaimSpec['view']['filter'] | undefined;
        if (incumbentRecord && incumbentRecord.source !== 'default') {
          previousSource = 'authored';
          previousMatched = (await previewSpecPoolEffect(incumbentRecord.spec, countScope)).matched;
          previousFilter = incumbentRecord.spec.view.filter;
        }
        poolEffect = { ...current, previousMatched, previousSource };
        const verdict = evaluateCollapseGuard({
          matched: current.matched,
          pool: current.pool,
          previousMatched,
          previousSource,
          confirm: args.confirmCollapse === true,
          filter: validated.spec.view.filter,
          previousFilter,
        });
        if (verdict.refuse) {
          return {
            data: {
              ok: false,
              errors: verdict.errors,
              admissibilityPreview: { ...admission.preview, checked: true, poolEffect },
            },
          };
        }
        poolEffectWarning = verdict.warning;

        // WI-38283: the write is going to be STORED past this point, so diff the incumbent's
        // guaranteed exclusions and say what this revision stopped carrying. Reported on the
        // RESULT (poolEffect.droppedExclusions) as well as in `warning`, so a caller can branch
        // on it instead of regex-ing prose. The undo selector is the FLEET SLUG / cupId the
        // caller addressed, never targetBeeId — that is a sentinel key get_claim_spec cannot read.
        const disclosure = evaluateWideningDisclosure({
          matched: current.matched,
          previousMatched,
          previousSource,
          filter: validated.spec.view.filter,
          previousFilter,
          target: args.fleet
            ? { kind: 'fleet', id: args.fleet.trim() }
            : { kind: 'cup', id: args.cupId as string },
        });
        poolEffect = {
          ...poolEffect,
          widened: disclosure.widened,
          ...(previousSource === 'authored'
            ? { droppedExclusions: disclosure.droppedExclusions.map((d) => d.describe) }
            : {}),
        };
        wideningWarning = disclosure.warning;
      } catch (err) {
        poolEffectError = err instanceof Error ? err.message : String(err);
      }
    }

    // P-016 (cross-machine-coord-parity): federate the spec when the queen is in a
    // single shared-hive workspace, so a bee pulling on ANOTHER machine sees it.
    // An explicit harness wins (including when tools:invoke is dispatched from an
    // unscoped operator context); else inherit the concrete ctx harness; else the
    // workspace's one shared hive; else null (operator-scope / local-only — today's
    // behavior). Best-effort:
    // a scope-resolve failure degrades to local (never blocks the spec write).
    let potSlug: string | null = resolvedHarness ?? null;
    try {
      if (!potSlug && ident.workspaceId && ident.workspaceId !== '*') {
        const scope = await resolveWorkspaceHiveScope(ident.workspaceId);
        if (scope.kind === 'one') potSlug = scope.homeSlug;
      }
    } catch {
      potSlug = null;
    }
    // WI-1564 (LIVE-1 D5): thread the caller's workspace — omitting it landed
    // the row under DEFAULT_COORD_WORKSPACE 'default', whose (workspace, hive)
    // outbox handle no drain serves, so a hive-scoped spec NEVER federated.
    // The reader (scheduler:get_next) resolves through the SAME helper.
    const res = await setClaimSpec({
      cupId: targetBeeId,
      workspaceId: resolveClaimSpecWorkspace(ident.workspaceId),
      spec: args.spec,
      updatedBy: ident.ownerId,
      potSlug,
    });
    const wake = await wakeClaimableAwaitersAfterSpecChange({
      cupId: targetBeeId,
      fleet: args.fleet?.trim(),
      specId: validated.spec.specId,
      revision: res.revision ?? null,
    });

    // Best-effort inert-spec guard (coding-hive-bee-vs-coding-factory-scoper-2026-06-23): a claim
    // spec only STEERS a SELF-PULLING agent (a coding-hive bee, the queen, or an su fleet
    // leader/member instructed to pull) that calls scheduler:get_next. The observed mistake was
    // setting claim-specs on a coding-FACTORY role (scoper/architect/worker/…), which never calls
    // get_next — the spec just sits there, INERT. Resolve the cupId's spawned role and, when it's a
    // factory push-role, attach a prominent `warning`. Advisory ONLY (not a hard reject): the cupId
    // may be a session id with no nursery row, a queen, or an su fleet member — none of which warn
    // (su-loop-capability-parity P-003: no false-positive on every SU fleet member).
    // (Skipped for a FLEET target — the sentinel key is not a spawned agent.)
    const spawnedRole = args.fleet ? null : await lookupSpawnedRole(targetBeeId);
    const out: Record<string, unknown> = { ...res };
    // Surface validateClaimSpec's own warnings (e.g. a lexicographic "weight ignored",
    // or the EI-18699032970141084 broad-kind-disjunct-footgun advisory) — these were
    // previously computed and then silently DROPPED on the success path.
    if (validated.warnings.length > 0) {
      out.warning = out.warning
        ? `${out.warning as string}\n${validated.warnings.join('\n')}`
        : validated.warnings.join('\n');
    }
    if (goalFenceWarning) {
      out.warning = out.warning ? `${out.warning as string}\n${goalFenceWarning}` : goalFenceWarning;
    }
    out.admissibilityPreview = {
      ...admission.preview,
      ...(poolEffect ? { checked: true, poolEffect } : {}),
      ...(poolEffectError ? { previewError: poolEffectError } : {}),
    } satisfies ClaimSpecAdmissionPreview;
    if (admission.warning) {
      out.warning = out.warning ? `${out.warning as string}\n${admission.warning}` : admission.warning;
    }
    if (poolEffectWarning) {
      out.warning = out.warning ? `${out.warning as string}\n${poolEffectWarning}` : poolEffectWarning;
    }
    if (wideningWarning) {
      out.warning = out.warning ? `${out.warning as string}\n${wideningWarning}` : wideningWarning;
    }
    if (poolEffectError) {
      const failOpen = `pool-effect preview failed OPEN (spec stored; collapse guard not evaluated): ${poolEffectError}`;
      out.warning = out.warning ? `${out.warning as string}\n${failOpen}` : failOpen;
    }
    const roleWarning = args.fleet ? null : claimSpecInertWarning(targetBeeId, spawnedRole);
    if (roleWarning) {
      // Append — never clobber the store's WI-1564 strand warning.
      out.warning = out.warning ? `${out.warning as string}\n${roleWarning}` : roleWarning;
    }
    out.claimableAwaitersWoken = wake.woken;
    if (wake.warning) {
      out.warning = out.warning ? `${out.warning as string}\n${wake.warning}` : wake.warning;
    }

    // EI-6079: best-effort wakeability check, same advisory-only posture as the
    // role warning above — a lookup failure or unknown result NEVER warns (null
    // reads as "don't know", not "not wakeable"), so this can never cry wolf on a
    // transient PG hiccup or a resolution the wakeability query doesn't cover.
    if (!args.fleet) {
      let wakeable: boolean | null = null;
      try {
        wakeable = (await fetchWakeability([targetBeeId])).get(targetBeeId)?.wakeable ?? null;
      } catch {
        wakeable = null;
      }
      const wakeWarning = claimSpecWakeabilityWarning(targetBeeId, wakeable);
      if (wakeWarning) {
        out.warning = out.warning ? `${out.warning as string}\n${wakeWarning}` : wakeWarning;
      }
    }

    return { data: out };
  },
});
