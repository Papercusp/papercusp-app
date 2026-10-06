/**
 * work_items:claim — Claimable (D-003). Assigns the work-item to an agent
 * (feature-family → taken_by; issue-family → assignee) and subscribes the claimer.
 *
 * Bulk by default (bulk-endpoint-standardization-2026-06-21): claim ONE inline
 * ({ id, assignee? }), MANY for the SAME assignee (ids:[…] + assignee?), or MANY
 * heterogeneous (items:[{ id, assignee?, harness? }]) → { ok, results:[{ ok, id,
 * workItem? | error… }], counts }. Each result self-describes its id; a
 * claim_conflict on one item never fails the rest (top-level ok = "the batch ran",
 * counts.failed is the truth — D-005). The claim lifecycle emit fires per claimed
 * item (D-007).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import {
  resolveAgentIdentity,
  SUPERUSER_FALLBACK_CLIENT_ID,
  isEphemeralMcpCallIdentity,
  type AgentIdentity,
} from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import {
  bindWorkItemDirectiveRef,
  claimWorkItem,
  classifyClaimFailure,
  commentWorkItem,
  explainIssueClaimFloors,
  getWorkItem,
  readNonAgentWorkCategory,
  readUnresolvedDepBlockers,
  type ClaimFloorAttribution,
  type UnresolvedDepBlocker,
} from '../../work-items';
import { notAgentWorkClaimHint } from '../../work-nature/not-agent-work-hint';
import { verificationTaskConflict } from '../../harness/improvements/agent-review-policy';
import { mintForceTakeoverAdmission } from '../../issues-engineer';
import { lookupWorkItem } from './_lookup';
import { runBulk, bulkContent, type BulkItemResult } from '../_bulk';
import { holderContextReader, resolveHolderAdvisory } from '../coordination/holder-advisory';
import type { CellReader } from '../../cell-registry';
import { shapeWorkItemWriteEcho } from './write-echo-shape';
import {
  admitWorkItemForFleetTarget,
  notifyFleetScopeRefusal,
  fleetScopeLeaderRemedy,
  renderFleetDependencyEscape,
} from '../../scheduler/fleet-scope-admission';
import { getClaimTimeCheckpointHint } from '../../work-item-checkpoint';
import {
  authorshipRevalidationWarning,
  getClaimTimeAuthorshipRevalidationHint,
  getClaimTimePriorWorkHint,
  priorWorkWarning,
} from '../../work-item-prior-work';
import { planItemClaimCollision } from '../../scheduler/plan-item-claim-collision';
import {
  getClaimTimePlanItemContradiction,
  planItemContradictionWarning,
} from '../../work-item-plan-contradiction';
import {
  getClaimTimePlanItemLanded,
  planItemLandedWarning,
} from '../../work-item-plan-item-landed';
import { detectBgJobCheckpointClaim } from '../../checkpoint-bg-job-claim';
import { ANY_FAMILY_TERMINAL_STATES } from '../../work-item-dispatch-states';
import { getClaimTimeRetractionAdvisory } from './retraction-advisory';
import {
  assessForceRelease,
  forceRefusalHint,
  notifyForceTransition,
  recordForceTransitionAudit,
  type ForceReleaseBasis,
} from './release-force-guard';
import {
  readWorkItemReleaseRequest,
  resolveWorkItemReleaseRequest,
  type WorkItemReleaseRequest,
} from '../../work-items-release-request';
// TYPE-only: erased at runtime, so it adds no import edge and cannot reintroduce an ESM
// cycle with the scheduler (the VALUE side is dynamically imported at its use site below,
// the same way fleet:leader-brief reaches this store).
import type { ClaimConcurrencyVerdict } from '../../scheduler/claim-spec-store';
import { suggestedWatchesForItemBlockers } from '../../interest-profiles';
import {
  persistPilotParticipantBindingReceipt,
  PILOT_PARTICIPANT_ROLES,
  type PilotParticipantBindingReceipt,
  type PilotParticipantRole,
} from '../../pilot-participant-receipts';
import { canonicalizeAssigneeOwnerId, resolveHolderOwnerId } from '../../work-item-holder-identity';
import { resolveExplicitAgentOwnerId } from '../coordination/recipient-resolve';

interface ClaimItem {
  id: string;
  assignee?: string;
  harness?: string;
  force?: boolean;
  reason?: string;
  pilotRole?: PilotParticipantRole;
  /** P-005: the owner directive this claim is taking the item on in order to
   *  carry out. Bound AFTER the claim lands — see the bind below. */
  directiveRef?: number;
}

/**
 * WI-5826: the warning a by-id claim MUST carry when the claimed row is already terminal.
 *
 * Claiming a finished item by id is deliberately ALLOWED (EI-8972 — "a completed row is STILL
 * directly claimable by id; the floor only gates self-select"): naming a finished item is how you
 * reopen it, inherit ownership, or attach follow-up work. What was missing is any SIGNAL — the
 * tool returned a bare ok:true on a state='done' row, so an agent could not distinguish fresh work
 * from finished work. Confirmed live 2026-07-26: work_items:claim{id:'EI-18645423267952485'} came
 * back ok:true on a row already done with terminalCompletionRef stamped, and was caught only
 * because that agent happened to read the returned workItem closely.
 *
 * EI-529 saw this class and mitigated it with a checkpointWarning, but that fires only when a
 * prior CHECKPOINT happens to exist; a completed item without one — the common case — still looked
 * like fresh work. This keys on the item's own terminal state instead, so it cannot be missed.
 *
 * Pure + exported so the guarantee is directly testable: the claim must keep SUCCEEDING (EI-8972's
 * decision) AND keep WARNING (this fix), and a future edit must not be able to silently drop one.
 */
export function terminalClaimWarning(
  workItem:
    | {
        state?: string | null;
        terminalOwner?: string | null;
        terminalCompletionRef?: string | null;
      }
    | null
    | undefined,
): string | null {
  if (!workItem) return null;
  const state = String(workItem.state ?? '').trim();
  const owner = String(workItem.terminalOwner ?? '').trim();
  const ref = String(workItem.terminalCompletionRef ?? '').trim();

  // "Finished" has TWO independent expressions here and the warning must catch both, because
  // the live miss and the pre-existing test each exhibit a DIFFERENT one:
  //   (a) a terminal `state` (done/resolved/closed/…) — the shape reported live 2026-07-26;
  //   (b) terminal_owner AND terminal_completion_ref both stamped — the shape EI-8972's
  //       self-select floor keys on, which can sit on a row whose state is still 'open'.
  // Keying on (a) alone silently missed (b) — caught by the guard test below, which seeds
  // exactly that row. EI-8972 is deliberate that BOTH columns are required for (b): a row with
  // only ONE set is NOT a genuine completion (it has its own two tests asserting it stays
  // claimable by self-select), so requiring both here keeps this warning consistent with the
  // floor instead of inventing a second, stricter notion of "done".
  const stateTerminal = state !== '' && ANY_FAMILY_TERMINAL_STATES.includes(state.toLowerCase());
  const genuinelyCompleted = owner !== '' && ref !== '';
  if (!stateTerminal && !genuinelyCompleted) return null;

  const label = stateTerminal ? state.toUpperCase() : 'COMPLETED';
  return (
    `⚠ THIS ITEM IS ALREADY ${label}` +
    (ref ? ` (completed: "${ref}"${owner ? ` by ${owner}` : ''})` : '') +
    '. The claim SUCCEEDED — claiming a finished item by id is allowed on purpose (reopen / inherit ' +
    'ownership / attach follow-up) — but this is NOT fresh work. Do NOT rebuild it: read the ' +
    'completion first and verify against the tree. If you wanted new work, release this and use ' +
    'scheduler:get_next instead.'
  );
}

/**
 * P-013 (work-item-dependency-edges-2026-08-02): the warning a by-id claim MUST carry when the
 * claimed row has UNRESOLVED BLOCKERS. The exact parallel of `terminalClaimWarning` above, for
 * the same reason and with the same contract.
 *
 * D-008 settled that dependency-blocking is a READINESS floor, so it gates SELF-SELECT only and
 * the by-id claim stays the deliberate operator override: naming a blocked item is how you take
 * ownership OF it in order to unblock it, and adding a floor here would break EI-8972's tested
 * escape hatch and make blocked work unreopenable by name. But the by-id claimer was then told
 * NOTHING — `scheduler:get_next` will not serve this item, and the claim returned a bare ok:true
 * that is indistinguishable from claiming ready work. That is the WI-5826 defect class exactly:
 * not a missing floor, a missing SIGNAL, fixed in the claim TOOL's response rather than in the
 * UPDATE.
 *
 * Pure + exported so both halves of the guarantee are directly testable — the claim must keep
 * SUCCEEDING (D-008) AND keep WARNING (this) — and so a future edit cannot silently drop one.
 * Takes the already-read blockers rather than reading them itself, which is what keeps it pure;
 * `readUnresolvedDepBlockers` is the read, shared with the floor's own predicate so this can
 * never name a blocker the queue does not gate on.
 */
export function blockedClaimWarning(blockers: readonly UnresolvedDepBlocker[] | null | undefined): string | null {
  if (!blockers || blockers.length === 0) return null;
  const named = blockers.map((b) => b.ref).filter((r) => r.trim() !== '');
  if (named.length === 0) return null;
  const shown = named.slice(0, 8);
  const more = named.length - shown.length;
  return (
    `⚠ THIS ITEM IS BLOCKED by ${named.length} unresolved ${named.length === 1 ? 'dependency' : 'dependencies'}: ` +
    `${shown.join(', ')}${more > 0 ? `, +${more} more` : ''}. ` +
    'The claim SUCCEEDED — a by-id claim deliberately overrides readiness floors, which is how you ' +
    'take ownership of blocked work in order to unblock it (D-008) — but scheduler:get_next will ' +
    'NOT serve this item, so do not read the successful claim as "ready to build". Either work the ' +
    'blockers first, or — if the edge is stale — drop it with work_items:link { id:<blocker>, ' +
    'rel:"blocks", target_id:<this item>, remove:true } (the BLOCKER is the source of a blocks edge).'
  );
}

/**
 * EI-19313376980892266: the warning a by-id claim MUST carry when the claimer is ALREADY at
 * its `maxConcurrentClaims` cap. The THIRD member of the terminalClaimWarning /
 * blockedClaimWarning set, for the same reason and with the same contract.
 *
 * ⚠ THE FILING THAT PRODUCED THIS ITEM ASKED FOR A GATE HERE. That prescription was WRONG and
 * is retracted. It read `work_items:claim`'s non-enforcement of the concurrency cap as the
 * fourth divergent behaviour in a "one oracle" bug — but the governing ruling is
 * `work-item-dependency-edges-2026-08-02#D-008`: "EXEMPT the by-id claim from the blocking
 * floor and SIGNAL instead — READINESS floors gate self-select only; SECURITY floors gate
 * everywhere." A concurrency cap is squarely a readiness floor (it is about the claimer's
 * capacity, not its authorization), so it gates self-select and signals here.
 *
 * claim-door-census.test.ts encodes the same ruling as an executable classification
 * (`claimWorkItem` → `by-id-ungated`) and names the trap verbatim: "a census that demanded
 * every door gate would encode the wrong invariant and fail working code — which is worse than
 * no census, because someone would then 'fix' the code to satisfy it." Adding a refusal here
 * would have been exactly that fix, and would have broken the legitimate flows the by-id path
 * exists for: a leader dispatching a specific item to a specific member, and a drain leader
 * claiming a swath via { ids:[…] }.
 *
 * ⚠ CITATION NOTE, because this cost four lookups to resolve: D-008 lives on
 * `work-item-dependency-edges-2026-08-02`, NOT on the similarly-named
 * `dependency-subsystem-thorough-testing-2026-08-02` (whose decisions are D-001/D-002 and
 * D-018-D-021). Two dependency plans of the same date, each with a P-009 and a P-013. Always
 * cite this one as `<planSlug>#D-NNN`.
 *
 * What was genuinely missing is what was missing in the other two cases: not a floor, a
 * SIGNAL. `scheduler:get_next` refuses to serve an at-cap bee (get_next.ts, concurrencyBlocked)
 * and `fleet:leader-brief` now reports it, but a by-id claim returned a bare ok:true — so an
 * over-cap lane could be built up one named claim at a time with nothing ever saying so, and
 * the holder's own next `get_next` would then refuse them with a diagnosis that reads as a
 * surprise. THAT is the divergence worth closing, and a warning closes it without touching the
 * override.
 *
 * Takes the already-read verdict rather than reading it itself, which is what keeps it pure —
 * and the verdict comes from the shared `evaluateClaimConcurrency`, so this can never name a
 * cap the queue does not actually refuse on.
 */
export function concurrencyClaimWarning(
  verdict: ClaimConcurrencyVerdict | null | undefined,
  claimedId: string,
  targetOwnerId: string,
  dispatchedAssignee?: string | null,
): string | null {
  if (!verdict?.blocked) return null;
  // The verdict is PRE-claim, so the item just claimed is not in `heldIds` — subtract it
  // anyway rather than trust that, so a retry/re-claim of an item the caller already holds
  // can never be reported as if it were an additional lane.
  const held = verdict.heldIds.filter((id) => id !== claimedId);
  const shown = held.slice(0, 8);
  const more = held.length - shown.length;
  const isDispatch = Boolean(dispatchedAssignee);
  const subject = dispatchedAssignee ?? 'you';
  const possessive = isDispatch ? 'their' : 'your';
  const serveSubject = isDispatch ? subject : 'you';
  return (
    `⚠ ${isDispatch ? `${subject} WAS ALREADY AT THEIR` : 'YOU WERE ALREADY AT YOUR'} CONCURRENCY CAP ` +
    `(${verdict.activeClaims}/${verdict.maxConcurrentClaims}) ` +
    `BEFORE THIS CLAIM` +
    (shown.length > 0 ? `, holding: ${shown.join(', ')}${more > 0 ? `, +${more} more` : ''}` : '') +
    '. The claim SUCCEEDED — a by-id claim deliberately overrides self-select readiness floors, ' +
    'which is how a leader dispatches a specific item and how { ids:[…] } takes a swath — but ' +
    `scheduler:get_next WILL now refuse to serve ${serveSubject} (concurrencyBlocked), so do not read this ` +
    `success as "the queue agrees ${subject} ${isDispatch ? 'has' : 'have'} capacity". Either release/complete a held item ` +
    '(work_items:release / work_items:complete), or — if this lane genuinely needs more than ' +
    'one item at a time — raise the per-target cap deliberately. First read the existing spec with ' +
    `scheduler:get_claim_spec { cupId: '${targetOwnerId}' }, then preserve it in ` +
    `scheduler:set_claim_spec { cupId: '${targetOwnerId}', spec: { ...current.spec, ` +
    'limits: { ...current.spec.limits, maxConcurrentClaims: N } } }. The write requires exactly one ' +
    'target selector (cupId or fleet) and a full replacement spec; limits belongs inside spec. ' +
    'Do not accumulate past the cap one claim at a time. ' +
    `A PARKED item still counts: it retains taken_by; ${subject} must account for it under ${possessive} cap.`
  );
}

/**
 * Claim ONE item, returning the self-describing result. On the compare-and-claim
 * loss, re-read + classify (EI-2197) so the agent gets an accurate, actionable
 * error (claim_conflict + holder, not_found, or not_claimable) rather than a
 * phantom "not found".
 */
async function claimOne(itRaw: ClaimItem, identity: AgentIdentity, reader: CellReader | null): Promise<BulkItemResult> {
  const claimerDefault = identity.ownerId;
  // EI-9274: a literal `'self'` assignee is treated identically to an OMITTED one
  // (resolved to the caller) — including for the implicit-identity guards below, so
  // `assignee: 'self'` under a loopback/ephemeral identity is refused the same way an
  // omitted assignee would be, instead of bypassing the guard and silently orphaning
  // the claim under an unmatchable literal "self" ownerId (previously stored verbatim —
  // WI-3881).
  const it: ClaimItem = { ...itRaw, assignee: itRaw.assignee === 'self' ? undefined : itRaw.assignee };
  if (!it.assignee && claimerDefault === SUPERUSER_FALLBACK_CLIENT_ID) {
    return {
      ok: false,
      id: it.id,
      error: 'missing_client_identity',
      hint: 'Implicit work-item claims require a real per-session or spawn owner. This request arrived as the shared su-loopback fallback, so it was refused before mutating the claim. Reconnect with a client identity or pass an explicit assignee.',
    };
  }
  // EI-8509: refuse an IMPLICIT claim under scripts/mcp-call.mjs's auto-generated
  // fallback identity (`mcp-call-<pid>`) — a one-shot stateless call with zero
  // liveness behind it, never a real spawned cup. Left unguarded, this is exactly
  // how "placed" work silently rots with nothing ever executing it (fleet_assignments
  // showed 4 such claims: assignee set, lastProgressAt/heartbeatAt null, sessionState
  // 'ended'). An explicit `assignee` (naming a real agent on purpose) still passes.
  if (!it.assignee && isEphemeralMcpCallIdentity(claimerDefault)) {
    return {
      ok: false,
      id: it.id,
      error: 'ephemeral_mcp_call_identity',
      hint: 'Refused: this call arrived under scripts/mcp-call.mjs\'s auto-generated fallback identity (mcp-call-<pid>), a one-shot process with no liveness/heartbeat and no fleet cup behind it — claiming here would silently "place" work that nothing executes (EI-8509). Spawn a real cup (fleet:spawn / bee:spawn) and let IT claim, or pass an explicit `assignee` naming the real agent that will do the work.',
    };
  }
  // EI-23701433507513915: an explicit short-form assignee (`su-851c1a7a`, copied from a coord
  // glyph handle) is expanded to the unique full ownerId BEFORE it becomes `claimer`, or refused
  // here with a typed reason naming the fix. Left to the claimWorkItem backstop it came back
  // null, which this path reported as a phantom claim conflict. A full id, a non-su identity,
  // and any other value pass through byte-identical, with no lookup.
  if (it.assignee !== undefined) {
    const canonical = await canonicalizeAssigneeOwnerId(it.assignee, { workspaceId: identity.workspaceId ?? null });
    if (!canonical.ok) return { ok: false, id: it.id, error: canonical.code, hint: canonical.message };
    const resolved = await resolveExplicitAgentOwnerId(
      canonical.ownerId,
      identity.ownerId,
      identity.workspaceId ?? null,
    );
    if (!resolved.ok) return { ok: false, id: it.id, error: resolved.code, hint: resolved.message };
    it.assignee = resolved.ownerId;
  }
  const claimer = it.assignee ?? claimerDefault;
  if (it.pilotRole && claimer !== claimerDefault) {
    return {
      ok: false,
      id: it.id,
      error: 'pilot_binding_requires_self_claim',
      hint: 'pilotRole is accepted only for the caller\'s own run-owned claim; dispatching a named assignee cannot mint their identity receipt.',
    };
  }
  // EI-19313376980892266: start the concurrency read NOW, the moment the claimer is known, and
  // await it only in the success branch — it is independent of admission, the pre-claim lookup
  // and the claim itself, so overlapping them keeps this off the claim's critical path.
  //
  // PRE-claim on purpose. `evaluateClaimConcurrency` answers "would the scheduler refuse this
  // bee another item", i.e. `activeClaims >= max`. Read AFTER the claim landed, an ordinary
  // single claim under a cap of 1 satisfies that (1 >= 1) and would warn on every normal claim
  // — the warning has to key on the state the caller was in when they asked, which is exactly
  // the state get_next would have judged.
  //
  // Resolves the claimer's OWN effective limit (getClaimSpecRecord applies the bee → fleet →
  // DEFAULT inheritance). Defaulting to 1 here would be the easy wiring and would be WRONG in
  // the expensive direction: a member legitimately running under a leader-authored
  // concurrency > 1 would be warned it is over a cap that does not exist, which is the
  // false-positive mirror of the false-negative that produced this item.
  //
  // Fail-soft to null (never a fabricated verdict): this is a signal, not a floor, so a
  // degraded spec/claims read must cost the warning and never the claim.
  const concurrencyBefore = (async (): Promise<ClaimConcurrencyVerdict | null> => {
    try {
      const { readClaimConcurrency, getClaimSpecRecord } = await import('../../scheduler/claim-spec-store');
      const rec = await getClaimSpecRecord({
        cupId: claimer,
        workspaceId: identity.workspaceId ?? undefined,
      }).catch(() => null);
      return await readClaimConcurrency({
        cupId: claimer,
        workspaceId: identity.workspaceId ?? undefined,
        maxConcurrentClaims: rec?.spec.limits?.maxConcurrentClaims,
      });
    } catch {
      return null;
    }
  })();
  // Read the canonical row before the workspace-scope gate. Exact plan exceptions
  // are keyed by the item's persisted source_plan_slug, not by the caller's optional
  // harness argument. Keeping this read distinct from a missing row also preserves
  // the force/CAS guard's fail-closed unreadable behavior below.
  const preClaim = await lookupWorkItem(it.id, it.harness);
  if (preClaim.status === 'unreadable') {
    return {
      ok: false,
      id: it.id,
      error: 'work_item_unreadable',
      hint:
        `${it.id} could not be read, so its current claim state is UNKNOWN — the read failed (${preClaim.error}). ` +
        'Refusing the claim rather than make a holder/force decision from an unreadable row. This is a READ FAILURE, not a missing item: retry, ' +
        'and if it persists check database health (dev:pg_health) rather than the item.',
    };
  }
  const preClaimItem = preClaim.status === 'found' ? preClaim.item : null;
  const claimScopeHarness = preClaimItem?.harness ?? it.harness;
  const claimScopePlan =
    typeof preClaimItem?.sourcePlanSlug === 'string' && preClaimItem.sourcePlanSlug.trim()
      ? preClaimItem.sourcePlanSlug.trim()
      : undefined;
  // workspace-work-scope-policy-2026-09-04 P-006: an item homed outside the workspace
  // work-scope policy is refused for EVERY claimant (solo or fleet) before fleet admission
  // runs. The item is untouched — held, never deleted; the denial lands on the policy
  // ledger. No policy ⇒ one cached read, byte-identical behaviour.
  {
    const { gateWorkScope, workScopeRefusal } = await import('../../work-scope-policy');
    const scope = await gateWorkScope('work_items:claim', {
      harness: claimScopeHarness,
      plan: claimScopePlan,
      workItem: it.id,
      actor: claimer,
    });
    if (!scope.allowed) return workScopeRefusal(scope, { id: it.id });
  }
  const admission = await admitWorkItemForFleetTarget({
    target: claimer,
    workItemId: it.id,
    harness: it.harness,
    workspaceId: identity.workspaceId,
    actor: identity.ownerId,
  });
  if (!admission.allowed) {
    // WI-6326: reuse the SAME liveness read notifyFleetScopeRefusal just performed for
    // the leader notification — never a second lookup — so the caller-facing hint's
    // "route elsewhere" advice is code-conditional too, not just the leader's copy.
    // EI-19484346966003625 (R1): pass the item's harness so the notice can report whether
    // the spec is refusing a CLASS. This is the seam that produced the original evidence —
    // WI-7264 was refused here twice under one spec revision, and the advice both times was
    // to widen for that row.
    const { liveRouteTarget, classRefusal, dependencyEscape } =
      (await notifyFleetScopeRefusal(identity, admission, `work_items:claim ${it.id} → ${claimer}`, {
        harness: it.harness,
        // EI-18680302159738037: name the pair structurally so fleet:leader-brief can
        // list this block instead of leaving it to be buried as ordinary inbox mail.
        subject: { itemId: it.id, member: claimer },
      })) ?? {};
    return {
      ok: false,
      id: it.id,
      error: admission.code,
      ...(dependencyEscape ? { dependencyEscape } : {}),
      // EI-18673501896258575: surface the SAME concrete remedy the fleet leader was just
      // notified with, to the CALLER too — previously only fleetScopeLeaderRemedy's text
      // reached the leader (via notifyFleetScopeRefusal); the refused caller saw only the
      // bare reason and had no way to know "widen the spec" was even an option, let alone
      // the exact scheduler:set_claim_spec call shape, so a member acting on an explicit
      // leader directive had to file the work unclaimed and wait, blind, for their leader
      // to notice the notification.
      hint:
        `${admission.reason}. The claim was refused before mutation. ` +
        // EI-21906739799895413: pass the refused id so the remedy renders an EXECUTABLE
        // fence-preserving widen rather than describing one.
        `${fleetScopeLeaderRemedy(admission, liveRouteTarget, classRefusal, null, it.id)}` +
      (dependencyEscape ? ` ${renderFleetDependencyEscape(dependencyEscape)}` : ''),
    };
  }
  const legacyFleetScopeDowngradeAdmission =
    admission.scoped ? admission.legacyFleetScopeDowngradeAdmission : undefined;
  // D-008: readiness/lifecycle floors, including claim-hold, gate self-select only. A named
  // by-id claim is the deliberate operator override, so do not apply a claim-hold refusal here.
  // Reuse the pre-read above for the separate checked cross-holder takeover below: force:true
  // must compare against the exact holder it read before claimWorkItem's CAS. WI-6746 still
  // requires the read to fail closed rather than turning an unreadable holder into an apparent
  // vacancy.
  // EI-20417350647749715: `force:true` is a checked cross-holder takeover, not a
  // bypass of claimWorkItem's compare-and-claim. Reuse the release force guard's
  // liveness/authority decision, then pass the exact holder into the UPDATE as an
  // expected-assignee CAS leg. If the holder changes after this read, the CAS
  // refuses the claim rather than stealing the new holder's work.
  let forced:
    | { holder: string; basis: ForceReleaseBasis; reason: string; releaseRequest?: WorkItemReleaseRequest }
    | undefined;
  // EI-23701433507513915: compare holders by CANONICAL owner id. A short-form holder stored
  // before assignments were canonicalized (`su-851c1a7a`) is expanded to the unique full id
  // it prefixes; an ambiguous or unknown prefix stays as stored, so authority never widens.
  // The CAS below still compares the RAW stored string, which is what `taken_by` holds.
  const storedHolder = preClaimItem?.assignee?.trim() || undefined;
  const currentHolder = storedHolder
    ? await resolveHolderOwnerId(storedHolder, { workspaceId: identity.workspaceId ?? null })
    : undefined;
  // The caller's OWN legacy short-form claim: widen the CAS by exactly that stored string
  // (`fromHolder`) so the self re-claim lands — and rewrites `taken_by` to the full id —
  // instead of being refused as a conflict and routed to the force path.
  const legacySelfHolder =
    storedHolder && storedHolder !== identity.ownerId && currentHolder === identity.ownerId ? storedHolder : undefined;
  if (it.force && storedHolder && currentHolder && currentHolder !== identity.ownerId) {
    const reason = (it.reason ?? '').trim();
    if (!reason) {
      return {
        ok: false,
        id: it.id,
        error: 'force_requires_reason',
        holder: currentHolder,
        hint: `force would replace ${currentHolder}'s claim — pass a \`reason\` the holder and owner can audit (WI-20417350647749715).`,
      };
    }
    const releaseRequest = readWorkItemReleaseRequest(preClaimItem?.payload);
    const verdict = await assessForceRelease({
      callerOwnerId: identity.ownerId,
      holderOwnerId: currentHolder,
      workspaceId: identity.workspaceId ?? '',
      itemLastProgressAt: preClaimItem?.lastProgressAt ?? null,
      releaseRequest,
    });
    if (!verdict.allowed) {
      return {
        ok: false,
        id: it.id,
        error: 'force_unauthorized',
        holder: currentHolder,
        holderLiveness: verdict.holderLiveness,
        hint: forceRefusalHint(currentHolder),
      };
    }
    forced = {
      // The CAS leg must match `taken_by` byte-for-byte: the RAW stored holder, not its
      // canonical expansion (EI-23701433507513915).
      holder: storedHolder,
      basis: verdict.basis as ForceReleaseBasis,
      reason,
      ...(verdict.basis === 'announced-release-request-expired' && releaseRequest ? { releaseRequest } : {}),
    };
  }
  // EI-19313376980892266: RESOLVE the concurrency verdict BEFORE the claim mutates the rows it
  // counts. Starting the read early is not enough — it is `getActiveClaimsForBee` against the
  // same `taken_by` column the claim below writes, so awaiting it later (e.g. in the hint batch)
  // is a genuine race: if the claim's UPDATE commits first the read returns the just-claimed row
  // and an ORDINARY first claim reports itself as "1/1, already at cap". That is a false positive
  // on every claim, and it is what the batch test caught. Awaiting here costs nothing measurable
  // because the read has been in flight across admission + the pre-claim lookup already.
  const concurrency = await concurrencyBefore;
  // EI-22345414208647835: carry the force guard's authorization into the claim writer
  // as a server-minted capability. The core CAS still requires the exact expected holder
  // at UPDATE time; this only releases the orthogonal born-pending admission floor for
  // the checked takeover.
  const forceTakeoverAdmission = forced
    ? mintForceTakeoverAdmission({
        itemId: it.id,
        target: claimer,
        expectedAssignee: forced.holder,
        workspaceId: identity.workspaceId ?? '',
      })
    : undefined;
  // EI-20731607691070897: `fromHolder` lets a caller hand an item THEY hold to a named
  // `assignee` in this same compare-and-claim, instead of being refused and left with
  // release → peer-claims (which exposes the item to the whole fleet in between). When
  // no `assignee` was passed, `claimer` IS `claimerDefault`, so this is a no-op.
  const workItem = await claimWorkItem(it.id, claimer, {
    harness: it.harness,
    fromHolder: legacySelfHolder ?? claimerDefault,
    ...(forced ? { expectedAssignee: forced.holder } : {}),
    ...(forceTakeoverAdmission ? { forceTakeoverAdmission } : {}),
    ...(legacyFleetScopeDowngradeAdmission ? { legacyFleetScopeDowngradeAdmission } : {}),
  });
  // P-005: bind the owner-directive provenance AFTER the holder-CAS has landed.
  // Order is load-bearing in both directions: binding first would stamp a
  // directive onto an item this caller may fail to claim, and skipping the bind
  // on a failed claim is exactly right — the link means "someone is on it", so
  // it must not outlive the claim that justified it.
  //
  // A conflict does NOT fail the claim. The claim is a separate, already-
  // committed fact, and swallowing it to report a provenance problem would lose
  // the ownership mutation. It is surfaced on the result instead.
  let directiveBindWarning: string | null = null;
  if (workItem && it.directiveRef != null) {
    const bound = await bindWorkItemDirectiveRef(
      identity.workspaceId ?? '',
      workItem.id ?? it.id,
      it.directiveRef,
    );
    if (!bound.ok) {
      directiveBindWarning =
        bound.error === 'not_found'
          ? `Claim landed, but directiveRef ${it.directiveRef} was NOT bound: work-item ${workItem.id ?? it.id} was not readable in this workspace.`
          : `Claim landed, but directiveRef ${it.directiveRef} was NOT bound: this item already carries directive ${bound.existing}. Directive provenance is write-once — file a separate work-item for the second directive rather than re-pointing this one.`;
    }
  }
  if (workItem && forced) {
    // The CAS has landed; leave both a durable audit row and the same holder/owner
    // notification trail as a forced release, but identify this mutation as a claim
    // and include the replacement assignee for an accurate forensic record.
    await recordForceTransitionAudit(claimerDefault, it.id, 'claim', {
      holder: forced.holder,
      basis: forced.basis,
      reason: forced.reason,
      harness: workItem.harness ?? it.harness ?? null,
      replacementAssignee: claimer,
    });
    await notifyForceTransition(identity, {
      itemId: it.id,
      holder: forced.holder,
      basis: forced.basis,
      reason: forced.reason,
      harness: workItem.harness ?? it.harness ?? null,
      operation: 'claim',
      replacementAssignee: claimer,
    });
    // The manual claim path can now execute an expired announced reclaim. Resolve
    // the exact request row only AFTER the holder-CAS claim lands; a requester refresh
    // racing this call is protected by expectedDeadlineAt. Bookkeeping is best-effort
    // because the ownership mutation already committed.
    if (forced.basis === 'announced-release-request-expired' && forced.releaseRequest) {
      try {
        const req = forced.releaseRequest;
        const resolved = await resolveWorkItemReleaseRequest(it.id, {
          harness: workItem.harness ?? it.harness ?? undefined,
          resolution: 'consequence-reclaim',
          expectedBy: req.by,
          expectedHolder: req.holder,
          expectedDeadlineAt: req.deadlineAt,
        });
        if (resolved) {
          await commentWorkItem(
            it.id,
            `⏰ Release request from ${resolved.by} → ${resolved.holder} EXPIRED unanswered — announced onSilence:"reclaim" fired via work_items:claim; replacement assignee: ${claimer}.`,
            claimerDefault,
            { harness: workItem.harness ?? it.harness ?? undefined },
          ).catch(() => {});
        }
      } catch {
        /* best-effort — never turn a landed holder-CAS claim into a reported failure */
      }
    }
  }
  if (workItem) {
    let pilotBindingReceipt: PilotParticipantBindingReceipt | undefined;
    if (it.pilotRole) {
      const claimVersion = workItem.takenAt;
      const harnessSlug = workItem.harness ?? it.harness;
      if (!identity.workspaceId || !harnessSlug || !claimVersion) {
        return {
          ok: false,
          id: it.id,
          error: 'pilot_binding_receipt_failed',
          claimLanded: true,
          workItem,
          hint: 'The work-item claim landed, but its workspace/harness/takenAt claimVersion could not be resolved; no pilot binding receipt was persisted.',
        };
      }
      try {
        pilotBindingReceipt = await persistPilotParticipantBindingReceipt({
          workspaceId: identity.workspaceId,
          harnessSlug,
          itemId: it.id,
          ownerId: claimerDefault,
          claimVersion,
          role: it.pilotRole,
        });
      } catch (error) {
        return {
          ok: false,
          id: it.id,
          error: 'pilot_binding_receipt_failed',
          claimLanded: true,
          workItem,
          hint:
            'The work-item claim landed, but canonical pilot binding persistence failed: ' +
            (error instanceof Error ? error.message : String(error)),
        };
      }
    }
    // WI-5826: see terminalClaimWarning — a by-id claim of a finished row stays ALLOWED
    // (EI-8972) but can no longer be mistaken for fresh work.
    const terminalWarning = terminalClaimWarning(workItem);
    // EI-529: this is the NAMED-assignee dispatch path (a leader/dispatcher assigning a
    // SPECIFIC item to a SPECIFIC agent) — exactly the shape the report's "brief dispatch
    // re-assigns already-completed work" pattern hit. Surface a prior holder's checkpoint
    // (when one exists) so the new assignee starts in verify-mode instead of rebuilding.
    // P-001 (fleet-leadership-continuity-and-actuation-2026-08-01): the THIRD guard in this set.
    // EI-529 above fires only when a checkpoint exists; terminalClaimWarning only when the row is
    // finished. An item that is open, unassigned, checkpoint-less AND already worked slips both —
    // the WI-6096 shape, where a compaction released the claim and lost the checkpoint on a
    // fully-built, CI-wired feature. Fetched in PARALLEL with the checkpoint hint (independent
    // reads; no reason to pay two round-trips serially), then told whether a checkpoint exists so
    // it can escalate its wording when one does not.
    // P-007 (same plan): the FOURTH guard, and the one about a PEER rather than the past.
    // The three above all ask "has this item been worked before?"; this asks "is someone else
    // holding its plan lane RIGHT NOW?" — the work-item was unassigned and claimable, yet its
    // linked plan item can be held by a live peer, because the two are separate records with
    // separate ownership. `work_items:get` has surfaced this since agent-trap-guards-2026-07-26,
    // but CLAIM — the one call that actually starts the duplicated work — did not, so the drift
    // was only ever discoverable by an agent who thought to look first. Same detector, same
    // fail-open contract, wired at the moment the decision is made.
    //
    // Compares against the POST-claim row, whose assignee is now the claimer, so a lane held by
    // this same agent (the normal, non-diverged case) is correctly silent.
    // WI-6737: record that the checkpoint read FAILED, rather than letting its `null` be read as
    // "no checkpoint exists" a few lines below. The hint itself stays fail-soft (`null`) — only
    // the reason is now recoverable.
    // P-013: the FIFTH guard, and the only one about the item's FUTURE rather than its past.
    // The four above ask "has this been worked, or is a peer on it?"; this asks "can this item
    // even proceed?" — a by-id claim of a dependency-blocked row succeeds by design (D-008) but
    // the queue will never serve it, and nothing said so. Joins the same parallel batch (an
    // independent read; no reason to pay a serial round-trip) and is fail-soft for the reason
    // given on readUnresolvedDepBlockers: saying nothing here asserts nothing.
    let checkpointReadFailed = false;
    const [
      hint,
      priorRaw,
      authorshipRevalidation,
      laneCollision,
      unresolvedBlockers,
      premises,
      planDecisionsResult,
      priorAttemptBrief,
      retractionAdvisory,
      planContradiction,
      behaviorContractHint,
      pathHintsResult,
      planItemLanded,
      siblingPathOverlapResult,
      sourceCitationResult,
    ] = await Promise.all([
      getClaimTimeCheckpointHint({
        harness: workItem.harness ?? it.harness ?? null,
        workItemId: it.id,
        workspaceId: identity.workspaceId ?? undefined,
      }).catch(() => {
        checkpointReadFailed = true;
        return null;
      }),
      getClaimTimePriorWorkHint({
        harness: workItem.harness ?? it.harness ?? null,
        workItemId: it.id,
        workspaceId: identity.workspaceId ?? undefined,
        currentClaimant: claimer,
      }).catch(() => null),
      getClaimTimeAuthorshipRevalidationHint({
        harness: workItem.harness ?? it.harness ?? null,
        workItemId: it.id,
        workspaceId: identity.workspaceId ?? undefined,
      }).catch(() => null),
      planItemClaimCollision(workItem).catch(() => null),
      readUnresolvedDepBlockers(it.id, workItem.harness ?? it.harness ?? undefined).catch(() => null),
      // false-premise-in-prescriptive-artifacts-2026-08-02 P-001: the item's own
      // load-bearing premises, surfaced at the moment before the cost is paid.
      // Joins this same parallel batch (an independent read) and is fail-soft for
      // the reason every sibling hint here is: saying nothing asserts nothing.
      import('../../premises-claim-port')
        .then((m) =>
          m.getClaimTimePremises({
            workItem: {
              id: workItem.id ?? it.id,
              payload: workItem.payload,
              title: workItem.title,
              summary: workItem.summary,
            },
            harness: workItem.harness ?? it.harness ?? null,
            workspaceId: identity.workspaceId ?? undefined,
          }),
        )
        .catch(() => null),
      // EI-19387745408924340: agent-trap-guards-2026-07-26 P-003b's plan-Decisions
      // brief was wired at scheduler:get_next ONLY — a by-id claim (this surface)
      // of a plan-bound item saw no governing decisions at all. Same fail-soft
      // seam as every other hint above; rendered via the shared helper so the
      // note text cannot drift from scheduler:get_next's copy.
      import('../../plan-decisions-claim-port')
        .then(async (m) => {
          const brief = await m.getClaimTimePlanDecisions({
            workItem: { payload: workItem.payload },
            harness: workItem.harness ?? it.harness ?? null,
            workspaceId: identity.workspaceId ?? undefined,
          });
          return brief ? { decisions: brief.decisions, note: m.renderPlanDecisionsNote(brief) } : null;
        })
        .catch(() => null),
      import('../../prior-attempt-context')
        .then((m) =>
          m.getClaimTimePriorAttemptBrief({
            workItem,
            harness: workItem.harness ?? it.harness ?? null,
          }),
        )
        .catch(() => null),
      getClaimTimeRetractionAdvisory(workItem, workItem.harness ?? it.harness ?? undefined),
      // WI-39498: the plan-says-done contradiction — the linked plan item is already
      // terminal (often annotated "← <this id> completed") while THIS row is still open,
      // so the work may already be finished. The one hint priorWorkWarning cannot carry
      // (it keys on prior-holder history, not on the plan/work-item contradiction). Same
      // fail-soft seam as every sibling hint above: saying nothing asserts nothing.
      getClaimTimePlanItemContradiction({
        workItemId: workItem.id ?? it.id,
        payload: workItem.payload,
      }).catch(() => null),
      // P-011: WHICH behavior clauses this claim puts the agent on the hook for, at
      // WHICH revision. Advisory (D-017) — reported, never enforced; P-013 owns any
      // refusal. Same port the completion gate uses, so what a claimant is told here
      // cannot drift from what they will be refused on later. Same fail-soft seam as
      // every sibling hint above.
      import('../../behavior-contract-claim-port')
        .then((m) =>
          m.getClaimTimeBehaviorContract(
            {
              id: workItem.id ?? it.id,
              payload: workItem.payload,
              harness: workItem.harness ?? it.harness ?? null,
              sourcePlanSlug: workItem.sourcePlanSlug,
              sourcePlanItemIds: workItem.sourcePlanItemIds,
            },
            workItem.harness ?? it.harness ?? null,
          ),
        )
        .catch(() => null),
      // EI-21267393427094356: which stored payload paths are dead at HEAD, and where each
      // moved to. Same fail-soft seam as every sibling hint above: saying nothing asserts
      // nothing.
      import('../../stale-path-hints-claim-port')
        .then(async (m) => {
          return m.getClaimTimeStalePathAdvisory({ workItem });
        })
        .catch(() => null),
      // EI-18713141708830049: the MIRROR of the planContradiction hint above — the linked
      // plan item is still OPEN while a settled sibling already implements it, so the work
      // may already be in the tree. That is the measured failure mode of routing off the
      // ledger instead of the tree: four items on one plan misreported their real state,
      // and the cost when the re-investigation is skipped is duplicate implementation.
      // Same fail-soft seam as every sibling hint above: saying nothing asserts nothing.
      getClaimTimePlanItemLanded({
        workItemId: workItem.id ?? it.id,
        payload: workItem.payload,
        sourcePlanSlug: workItem.sourcePlanSlug,
        sourcePlanItemIds: workItem.sourcePlanItemIds,
        workspaceId: identity.workspaceId ?? undefined,
      }).catch(() => null),
      // EI-19329513980117751: a DIFFERENT work-item shares this one's stored paths and
      // has already landed. Every other sibling-finding hint above reaches its sibling
      // through the PLAN; this one needs no plan, which is the point — the measured
      // duplicate-filing instances are all plan-less, so the plan-linked hints are
      // structurally silent for exactly the population that suffers this. Same fail-soft
      // seam as every hint above: saying nothing asserts nothing.
      import('../../sibling-path-overlap-claim-port')
        .then(async (m) => {
          const hint = await m.getClaimTimeSiblingPathOverlap({
            workItemId: workItem.id ?? it.id,
            payload: workItem.payload,
            harness: workItem.harness ?? it.harness ?? null,
            workspaceId: identity.workspaceId ?? undefined,
          });
          const warning = m.siblingPathOverlapWarning(hint, workItem.id ?? it.id);
          return hint && warning
            ? { siblingPathOverlap: hint, siblingPathOverlapWarning: warning }
            : null;
        })
        .catch(() => null),
      // EI-19418245218824265: the tree already cites this id. The only hint here that
      // reads the TREE rather than the row, so it is the only one that fires when the
      // implementer never claimed the row — the row then looks never-started to all
      // the others. Advisory: a citation can be a reference, not an implementation.
      import('../../source-citation-claim-port')
        .then(async (m) => {
          const id = workItem.id ?? it.id;
          const hint = await m.getClaimTimeSourceCitation({
            workItemId: id,
            workspaceId: identity.workspaceId ?? undefined,
            harness: workItem.harness ?? it.harness ?? null,
            family: workItem.family,
          });
          const warning = m.sourceCitationWarning(hint, id);
          return hint && warning
            ? { sourceCitation: hint, sourceCitationWarning: warning }
            : null;
        })
        .catch(() => null),
    ]);
    const blockedWarning = blockedClaimWarning(unresolvedBlockers);
    // A named assignee means the warning is being read by the dispatching caller, not the
    // assignee whose capacity was measured. Pass that identity through so the prose cannot
    // make the leader think its own lane changed (EI-21731818164781453).
    const dispatchedAssignee = claimer !== claimerDefault ? claimer : null;
    const concurrencyWarning = concurrencyClaimWarning(concurrency, it.id, claimer, dispatchedAssignee);
    const suggestedWatches = suggestedWatchesForItemBlockers({
      itemId: it.id,
      blockers: workItem.externalBlockers,
    });
    // WI-6737: `hint` is null for BOTH "no checkpoint exists" and "the checkpoint read threw"
    // (the .catch above), so it cannot decide `hasCheckpoint` alone — collapsing the failure into
    // `false` makes priorWorkWarning assert "NO checkpoint was ever written" during an outage.
    // Re-derive the failure explicitly instead of inferring absence from a swallowed error.
    const priorWork = priorRaw
      ? { ...priorRaw, hasCheckpoint: checkpointReadFailed ? ('unknown' as const) : hint != null }
      : null;
    const priorWorkWarn = priorWorkWarning(priorWork);
    const authorshipRevalidationWarn = authorshipRevalidationWarning(authorshipRevalidation);
    // EI-18654296679612119: a SEPARATE, CONDITIONAL warning — only when the checkpoint text
    // itself cites a background job/task as evidence — rather than growing the EI-529 text
    // above unconditionally (which would fire on every checkpointed claim, background job or
    // not). See detectBgJobCheckpointClaim for why this can't be a live PID check here.
    const bgJobWarning = hint ? detectBgJobCheckpointClaim(hint.checkpoint) : { detected: false };
    // EI-19464910043764424: the checkpointWarning below is about COMPLETENESS ("may already
    // be done"); it says nothing about whether the checkpoint's own cited evidence still
    // EXISTS. Scan the checkpoint body for repo paths that are gone, through the same port
    // the stored-payload hints already use. Fail-soft: saying nothing asserts nothing.
    const checkpointStalePathWarning = hint?.checkpoint
      ? await import('../../stale-path-hints-claim-port')
          .then(async (m) => {
            const subjectId = workItem.id ?? it.id;
            const bySource = await m.getStalePathRefsBySourceForSubjects([
              // Checkpoint ONLY — title/summary refs are already reported by the sibling
              // leg above, and repeating them here would double-warn for one dead path.
              { id: subjectId, checkpoint: hint.checkpoint },
            ]);
            return m.staleCheckpointPathsNote(bySource[subjectId] ?? null);
          })
          .catch(() => null)
      : null;
    const planContradictionWarn = planItemContradictionWarning(planContradiction, workItem.id ?? it.id);
    const planItemLandedWarn = planItemLandedWarning(planItemLanded, workItem.id ?? it.id);
    return hint
      ? {
          ok: true,
          id: it.id,
          workItem,
          ...(pilotBindingReceipt ? { pilotBindingReceipt } : {}),
          ...(forced ? { forced } : {}),
          // A cross-plan affects warning is execution authority. Keep the shared
          // decisions bundle before plan-local checkpoint prose in serialized order.
          ...(planDecisionsResult
            ? { planDecisions: planDecisionsResult.decisions, planDecisionsNote: planDecisionsResult.note }
            : {}),
          ...(directiveBindWarning ? { directiveBindWarning } : {}),
          checkpoint: hint.checkpoint,
          checkpointAgeMs: hint.checkpointAgeMs,
          checkpointWarning:
            'A PRIOR holder left an in-flight checkpoint on this item — it may already be DONE or partly done. Read it before building: verify against the tree/tests first, do not assume greenfield (EI-529).',
          ...(bgJobWarning.detected ? { checkpointBgJobWarning: bgJobWarning.reason } : {}),
          ...(terminalWarning ? { terminalWarning } : {}),
          ...(retractionAdvisory ? { retractionWarning: retractionAdvisory.retractionWarning } : {}),
          ...(blockedWarning ? { blockedWarning, blockedBy: unresolvedBlockers } : {}),
          ...(suggestedWatches.length > 0 ? { suggestedWatches } : {}),
          ...(concurrencyWarning
            ? {
                concurrencyWarning,
                concurrency: {
                  activeClaims: concurrency!.activeClaims,
                  maxConcurrentClaims: concurrency!.maxConcurrentClaims,
                  heldIds: concurrency!.heldIds,
                  ...(dispatchedAssignee ? { subject: dispatchedAssignee } : {}),
                },
              }
            : {}),
          ...(priorWorkWarn ? { priorWork, priorWorkWarning: priorWorkWarn } : {}),
          ...(planContradictionWarn
            ? { planItemContradiction: planContradiction, planItemContradictionWarning: planContradictionWarn }
            : {}),
          ...(planItemLandedWarn
            ? { planItemLanded, planItemLandedWarning: planItemLandedWarn }
            : {}),
          ...(authorshipRevalidationWarn
            ? { authorshipRevalidation, authorshipRevalidationWarning: authorshipRevalidationWarn }
            : {}),
          ...(laneCollision ? { planItemClaimCollision: laneCollision } : {}),
          ...(premises ? { premises: premises.rendered, premisesNote: premises.note } : {}),
          ...(priorAttemptBrief ? { priorAttemptBrief } : {}),
          ...(behaviorContractHint
            ? {
                behaviorContract: behaviorContractHint.behaviorContract,
                behaviorContractNote: behaviorContractHint.behaviorContractNote,
              }
            : {}),
          ...(pathHintsResult ?? {}),
          ...(siblingPathOverlapResult ?? {}),
          ...(sourceCitationResult ?? {}),
        }
      : {
          ok: true,
          id: it.id,
          workItem,
          ...(pilotBindingReceipt ? { pilotBindingReceipt } : {}),
          ...(forced ? { forced } : {}),
          ...(directiveBindWarning ? { directiveBindWarning } : {}),
          ...(terminalWarning ? { terminalWarning } : {}),
          ...(retractionAdvisory ? { retractionWarning: retractionAdvisory.retractionWarning } : {}),
          ...(blockedWarning ? { blockedWarning, blockedBy: unresolvedBlockers } : {}),
          ...(suggestedWatches.length > 0 ? { suggestedWatches } : {}),
          ...(concurrencyWarning
            ? {
                concurrencyWarning,
                concurrency: {
                  activeClaims: concurrency!.activeClaims,
                  maxConcurrentClaims: concurrency!.maxConcurrentClaims,
                  heldIds: concurrency!.heldIds,
                  ...(dispatchedAssignee ? { subject: dispatchedAssignee } : {}),
                },
              }
            : {}),
          ...(priorWorkWarn ? { priorWork, priorWorkWarning: priorWorkWarn } : {}),
          ...(planContradictionWarn
            ? { planItemContradiction: planContradiction, planItemContradictionWarning: planContradictionWarn }
            : {}),
          ...(planItemLandedWarn
            ? { planItemLanded, planItemLandedWarning: planItemLandedWarn }
            : {}),
          ...(authorshipRevalidationWarn
            ? { authorshipRevalidation, authorshipRevalidationWarning: authorshipRevalidationWarn }
            : {}),
          ...(laneCollision ? { planItemClaimCollision: laneCollision } : {}),
          ...(premises ? { premises: premises.rendered, premisesNote: premises.note } : {}),
          ...(planDecisionsResult
            ? { planDecisions: planDecisionsResult.decisions, planDecisionsNote: planDecisionsResult.note }
            : {}),
          ...(priorAttemptBrief ? { priorAttemptBrief } : {}),
          ...(behaviorContractHint
            ? {
                behaviorContract: behaviorContractHint.behaviorContract,
                behaviorContractNote: behaviorContractHint.behaviorContractNote,
              }
            : {}),
          ...(pathHintsResult ?? {}),
          ...(siblingPathOverlapResult ?? {}),
          ...(sourceCitationResult ?? {}),
        };
  }
  // claimWorkItem returns a bare null for THREE distinct outcomes — re-read + classify.
  const current = await getWorkItem(it.id, it.harness);
  // EI-22074465800337362: a force-reclaim's CAS already matched the liveness/authority
  // leg (claimWorkItem was called with `expectedAssignee: forced.holder`), yet the UPDATE
  // still returned 0 rows. `admittedWhereSql`/`autoPickableWhereSql` are applied to EVERY
  // claim UPDATE unconditionally (claimIssue/claimWorkItem — the only bypasses are the
  // server-derived leaderDispatchAdmission/selfFiledFalloutAdmission capabilities, which a
  // force takeover never mints), so a WIP item whose holder died while the item was still
  // admission-pending (e.g. a fleet-leader dispatch of a pending item, which durably assigns
  // WITHOUT flipping admission — see the leader-dispatch-pending fixtures in
  // work-items-claim.integration.test.ts) is refused here even though the force guard already
  // proved the holder is not live. If the row's assignee is UNCHANGED from the exact holder
  // the force guard authorized against, this is NOT a live peer conflict — falling through to
  // the generic classifyClaimFailure path below would misreport it as `claim_conflict` with a
  // hint pointing the caller back at "the stale-claim reclaim lane frees it", i.e. the exact
  // force takeover they just tried and had silently refused. Diagnose it honestly instead.
  if (forced && current?.assignee?.trim() === forced.holder) {
    let claimFloor: ClaimFloorAttribution | null = null;
    if (current.family === 'issue') {
      const issueHarness = current.harness ?? it.harness;
      if (issueHarness) {
        try {
          const [floor] = await explainIssueClaimFloors(issueHarness, [it.id], { assignee: claimer });
          claimFloor = floor && !floor.admissible && floor.refusedBy ? floor : null;
        } catch {
          claimFloor = null;
        }
      }
    }
    const retryHint = claimFloor?.retry
      ? ` It CLEARS ON ITS OWN — typically within ~${Math.round(claimFloor.retry.expectedWithinSec / 60)}m, ` +
        `at the latest ~${Math.round(claimFloor.retry.guaranteedWithinSec / 60)}m (${claimFloor.retry.basis}). Retry then.`
      : '';
    return {
      ok: false,
      id: it.id,
      error: 'force_blocked_by_claim_floor',
      holder: forced.holder,
      workItem: current,
      ...(claimFloor ? { claimFloor } : {}),
      hint:
        `The force takeover was AUTHORIZED (${forced.basis}: ${forced.holder} is not live) but the claim write still refused it. ` +
        `${forced.holder} still holds it UNCHANGED — this is NOT a live peer conflict, so do not retry the takeover blind or coordinate ` +
        `with ${forced.holder} (they are the dead holder you were reclaiming from). ` +
        (claimFloor
          ? `The claim floor is ${claimFloor.refusedBy}: ${claimFloor.detail ?? 'the item is not claim-path admissible'}. ` +
            `This gate applies to every claim path INCLUDING a force takeover — liveness/authority authorization does not bypass it.${retryHint}`
          : "Likely the item's admission/trust gate (still pending duplicate screening, or an un-admitted remote/untrusted origin) — " +
            'check its admission/origin/auditVerdict directly (dev:pg_query) rather than retrying the takeover blind.'),
    };
  }
  // P-007 / D-021: claimWorkItem refuses a verification task to its own reporter or
  // implementer. That refusal is PERMANENT for this claimant (waiting or retrying cannot
  // clear it), so name it rather than letting it read as a peer conflict or a gate.
  const verificationRole = current ? verificationTaskConflict(current.payload, claimer) : null;
  if (verificationRole) {
    return {
      ok: false,
      id: it.id,
      error: 'verification_conflict',
      role: verificationRole,
      workItem: current,
      hint:
        `${it.id} is a verification task and ${claimer} is its ${verificationRole}. ` +
        'Verification must be done by an independent agent, never the reporter or the implementer, ' +
        'so this refusal is permanent for you: leave it for a verifier and pick other work.',
    };
  }
  const failure = classifyClaimFailure(current, claimer);
  if (failure.reason === 'not_found') {
    return { ok: false, id: it.id, error: `work_item '${it.id}' not found` };
  }
  if (failure.reason === 'conflict') {
    // P-027 / D-055 A2 — THE contention point: the caller is blocked BY a named
    // holder and is deciding whether to wait, escalate, or go elsewhere. The
    // refusal already names WHO; this names what they are DOING, which is the
    // input that decision actually turns on.
    //
    // ⚠ ADVISORY ONLY, AND STRICTLY AFTER THE VERDICT. `failure.reason` is
    // already decided above; nothing here can promote a conflict to a grant. It
    // is also total (`resolveHolderAdvisory` never throws), so a dead facts store
    // costs the explanation and never the refusal — P-026 rule (f).
    //
    // D-094: the subject is subtracted, so the holder is never reported as
    // "also competing on" the very item being refused.
    const holderContext = await resolveHolderAdvisory({
      holder: failure.holder,
      reader,
      subjectRef: it.id,
    });
    // EI-20731607691070897: the holder can be the CALLER. `claimer` is the ASSIGNEE
    // when one was passed, so a caller handing off an item THEY hold classifies as a
    // conflict against themselves. That transfer now lands atomically (the `fromHolder`
    // leg above), so reaching here self-held means the write was refused for some OTHER
    // reason (the feature-family admission gate, or the row moving under the re-read) —
    // never "someone else took it". The generic hint below is written entirely for the
    // someone-ELSE-holds-it case and every branch of it misfires here: it tells the
    // caller to coord:send themselves, or to wait for their own death. Worst of all,
    // the obvious next move it leaves is work_items:release — which clears the assignee
    // and makes the item fleet-claimable, the exact race a deliberate handoff avoids.
    const selfHeld = failure.holder === claimerDefault;
    return {
      ok: false,
      id: it.id,
      error: 'claim_conflict',
      holder: failure.holder,
      workItem: current,
      ...(holderContext ? { holderContext } : {}),
      hint: selfHeld
        ? `You already hold ${it.id} — nobody else took it, so this is NOT a peer conflict. Handing it to ${claimer} is normally atomic; this write was refused by an admission/trust gate on the item, or the row changed under the re-read. ⚠ Do NOT work_items:release to hand it over: that clears the assignee and makes the item claimable by the WHOLE fleet, so a self-selecting peer can take it before ${claimer} does. Re-check with work_items:get, then have ${claimer} claim it by id once the gate is satisfied.`
        : `Already claimed by ${failure.holder} — the item exists (get/observe/comment/complete resolve it). Coordinate with the holder via coord:send, or pick another item; if that agent is dead, the stale-claim reclaim lane frees it. Do not blind-retry with a different harness.`,
    };
  }
  // EI-21637135941119450: a named issue claim can be refused by the same durable
  // admission floor as self-select (most notably a born-pending duplicate screen),
  // but the old response collapsed that refusal into an opaque `not_claimable`.
  // Reuse the per-id oracle rather than re-deriving admission here. This is advisory
  // and fail-soft: a diagnostic read must never change the refusal or turn a read
  // outage into a fabricated floor.
  // P-009 / D-024: the feature-family claim UPDATE gates on the CATEGORY half of the work
  // predicate (nature 'work' AND audience 'agent'). A record, document, event or human-audience
  // row (e.g. an email-draft-proposal) is never claimable, by id or otherwise, so name it:
  // unlike the admission floors below, waiting or retrying cannot help. Diagnostic only and
  // fail-soft; a read outage falls through to the generic refusal, never to a grant.
  const categoryHarness = current?.harness ?? it.harness;
  if (current && current.family !== 'issue' && categoryHarness) {
    let category: { nature: string; audience: string | null } | null = null;
    try {
      category = await readNonAgentWorkCategory(it.id, categoryHarness);
    } catch {
      category = null;
    }
    if (category) {
      return {
        ok: false,
        id: it.id,
        error: 'not_agent_work',
        workItem: current,
        nature: category.nature,
        audience: category.audience,
        hint: notAgentWorkClaimHint(category.nature, category.audience),
      };
    }
  }
  let claimFloor: ClaimFloorAttribution | null = null;
  if (current?.family === 'issue') {
    const issueHarness = current.harness ?? it.harness;
    if (issueHarness) {
      try {
        const [floor] = await explainIssueClaimFloors(issueHarness, [it.id], { assignee: claimer });
        claimFloor = floor && !floor.admissible && floor.refusedBy ? floor : null;
      } catch {
        claimFloor = null;
      }
    }
  }
  // EI-21973318733042066: when the floor CLEARS ON ITS OWN, say so with its bound and its
  // remedy. Without them a caller cannot tell "not yet" from "never" and has no basis to choose
  // between waiting and abandoning — the measured cost being a launched reviewer refused twice
  // on an item that stayed unclaimable for 22.5 minutes, outliving its own 9-minute lifetime.
  // Both clauses are strictly ADDITIVE: a floor that advertises neither renders exactly the
  // pre-existing hint, so no other floor's wording changes.
  const retryHint = claimFloor?.retry
    ? ` This floor CLEARS ON ITS OWN — typically within ~${Math.round(claimFloor.retry.expectedWithinSec / 60)}m, ` +
      `and at the latest ~${Math.round(claimFloor.retry.guaranteedWithinSec / 60)}m (${claimFloor.retry.basis}). ` +
      'So this is a WAIT, not a permanent refusal — but only wait if you expect to outlive it; ' +
      'a short-lived agent should proceed unclaimed and say so rather than retry.'
    : '';
  const remedyHint = claimFloor?.remedy ? ` ${claimFloor.remedy}` : '';
  const floorHint = claimFloor
    ? ` The claim floor is ${claimFloor.refusedBy}: ${claimFloor.detail ?? 'the item is not claim-path admissible'}.` +
      `${retryHint}${remedyHint}`
    : '';
  return {
    ok: false,
    id: it.id,
    error: 'not_claimable',
    workItem: current,
    ...(claimFloor ? { claimFloor } : {}),
    hint:
      `Item exists but the claim was refused by a trust/admission gate, or it was released between the claim and this re-read — re-check with work_items:get / work_items:observe.${floorHint}`,
  };
}

export default defineTool({
  name: 'work_items:claim',
  profile: 'engineer',
  // PROMPT-WEIGHT (EI-10966): this tool was 2054 chars — 454 over the 1600 HARD CAP — which
  // REDS the green gate and freezes deploys fleet-wide. Trimmed to the load-bearing contract;
  // the rationale that used to live in the prompt now lives here, where it costs no context:
  //   · claim_conflict → a LIVE peer holds it. Coordinate via coord:send; do NOT blind-retry.
  //     A DEAD holder is freed automatically by the stale-claim lane, so retrying only races.
  //   · Readiness/lifecycle floors (including claim-hold, blockers, and terminal state) gate
  //     self-select only; a named by-id claim is the deliberate operator override. The
  //     successful response carries advisory signals for the caller to inspect.
  //   · There is no work_items:heartbeat — ANY papercusp-su call refreshes liveness, which is
  //     what the stale-claim reaper reads. The one gap is a long stretch of PURELY-LOCAL tool
  //     use (Bash/Read/vitest, zero platform calls) inside a >10–15min claim (EI-6772); call
  //     work_items:checkpoint partway, which is both a progress note and a liveness pulse.
  description:
    'Claim one or many work-items for yourself or an assignee. Single: { id, assignee? }; many: ids:[…] or items:[{ id, assignee?, harness? }]. Results are independent. Fleet members receive only items matching their claim spec. Named claims override readiness/lifecycle floors and report advisories, not fleet scope or born-pending admission/trust; server-derived dispatch/force may bypass pending rows. `force:true` is an audited, liveness-checked takeover requiring reason.',
  guidance: {
    when: 'Before editing: claim to prevent duplicate work. Use ids:[…] for a swath. By-id claims override readiness/lifecycle floors, not fleet scope or ordinary born-pending admission/trust; server-derived dispatch/force may bypass pending rows.',
    notWhen:
      '`claim_conflict` means a live peer holds it: coordinate, do not retry. `force_unauthorized` means takeover refused. `work_item_unreadable` means the pre-claim read failed. Never claim non-work or human-audience rows: data or a person\'s job.',
    chaining:
      'work_items:list → claim → set_state → release/close. No heartbeat; platform calls refresh liveness. During long local-only work, checkpoint (EI-6772).',
    seeAlso: [
      'work_items:claim_next (self-select the next claimable item instead of naming an id)',
      'work_items:observe (check claimability before taking)',
      'work_items:release (drop the claim if you stop working it)',
    ],
  },
  capability: 'work_items:write',
  // Claiming the same item for the same assignee is an atomic no-op on the
  // assignment (claimWorkItem's compare-and-claim contract). If the handler
  // commits before a transport timeout, surface that completed claim instead
  // of making the caller retry an already-landed write.
  idempotent: true,
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      id: z.string().min(1).optional().describe('single-claim shorthand: the work-item id'),
      assignee: z
        .string()
        .max(120)
        .optional()
        .describe(
          'default: you (also resolves the literal "self" to you). Applies to the inline id / every id in `ids`.',
        ),
      ids: z
        .array(z.string().min(1))
        .min(1)
        .max(200)
        .optional()
        .describe('claim MANY items for the same `assignee` (homogeneous)'),
      items: z
        .array(
          z.object({
            id: z.string().min(1),
            assignee: z.string().max(120).optional(),
            harness: z.string().max(80).optional(),
            force: z.boolean().optional(),
            reason: z.string().max(500).optional(),
            pilotRole: z.enum(PILOT_PARTICIPANT_ROLES).optional(),
            directiveRef: z.number().int().positive().optional(),
          }),
        )
        .min(1)
        .max(200)
        .optional()
        .describe('claim many work-items at once — each { id, assignee?, harness?, force?, reason? }'),
      harness: z.string().max(80).optional().describe('default harness for the inline id / ids / items that omit one'),
      force: z
        .boolean()
        .optional()
        .describe(
          'default for the inline id / every id in `ids`: checked-reclaim another agent\'s claim with `reason`; self-select readiness/lifecycle floors are already overridden by naming an id, but ordinary born-pending admission remains enforced. An authorized force takeover mints the exact pending-row exception, and every cross-holder takeover is audited + notifies the holder and owner.',
        ),
      reason: z
        .string()
        .max(500)
        .optional()
        .describe(
          'default for the inline id / every id in `ids`: required when `force:true` replaces another agent\'s claim; recorded in the forced result, audit, and holder/owner notifications.',
        ),
      pilotRole: z
        .enum(PILOT_PARTICIPANT_ROLES)
        .optional()
        .describe('directed-pair pilot only: mint a server-issued canonical binding receipt for this caller-owned claim'),
      directiveRef: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          'owner-directive provenance (orders id): bind this already-existing item to the directive you are claiming it to carry out. Write-once — a claim on an item already bound to a DIFFERENT directive still claims, and reports directiveBindWarning rather than re-pointing it. Use work_items:create { directiveRef } instead when the item does not exist yet.',
        ),
    })
    .refine((a) => (a.items?.length ?? 0) > 0 || (a.ids?.length ?? 0) > 0 || Boolean(a.id), {
      message: 'pass { id } for one, or { ids:[…] } / items:[{ id }] for many',
    }),
  // context-trimming-tiers P-025 (write-echo diet): trimmed/standard sessions
  // get a compact workItem ref per result instead of the full echoed row;
  // outcome fields (ok/error/holder/hint/reflect) pass through verbatim —
  // see write-echo-shape.ts.
  shape: {
    standard: (data) => shapeWorkItemWriteEcho(data, 'standard'),
    trimmed: (data) => shapeWorkItemWriteEcho(data, 'trimmed'),
  },
  async handler(args, ctx) {
    const ident = resolveAgentIdentity(ctx);
    // P-027: resolved ONCE for the whole batch — the advisory is reader-relative,
    // and every item in this call shares one reader. Guarded, so an
    // unattributable caller gets no advisory rather than a failed claim.
    const reader = holderContextReader(ctx as Parameters<typeof holderContextReader>[0]);
    const list: ClaimItem[] = args.items?.length
      ? args.items.map((it) => ({
          id: it.id,
          assignee: it.assignee ?? args.assignee,
          harness: it.harness ?? args.harness,
          force: it.force ?? args.force,
          reason: it.reason ?? args.reason,
          pilotRole: it.pilotRole ?? args.pilotRole,
          directiveRef: it.directiveRef ?? args.directiveRef,
        }))
      : args.ids?.length
        ? args.ids.map((id) => ({
            id,
            assignee: args.assignee,
            harness: args.harness,
            force: args.force,
            reason: args.reason,
            pilotRole: args.pilotRole,
            directiveRef: args.directiveRef,
          }))
        : [
            {
              id: args.id as string,
              assignee: args.assignee,
              harness: args.harness,
              force: args.force,
              reason: args.reason,
              pilotRole: args.pilotRole,
              directiveRef: args.directiveRef,
            },
          ];
    const env = await runBulk(list, (it) => claimOne(it, ident, reader), {
      keyOf: (it) => ({ id: it.id }),
    });
    // Claim-time recall port (memory-delivery-unification-2026-07-12 P-008 /
    // D-006): piggyback a targeted memory recall for the just-claimed item(s)
    // on the response — deadline-bounded, epoch-deduped (port 'claim'),
    // never-throws (dynamic import keeps the memory chain off this module's
    // static graph — see _bulk.ts's ESM-cycle note).
    const claimedItems = env.results
      .filter((r) => r.ok && r.workItem != null)
      .map((r) => r.workItem as { id?: string; title?: string; summary?: string; harness?: string | null });
    const memory = claimedItems.length
      ? await import('../../memory/claim-port')
          .then((m) =>
            m.buildClaimRecallBlock({
              sessionId: ident.ownerId,
              workspaceId: ident.workspaceId,
              items: claimedItems,
            }),
          )
          .catch(() => null)
      : null;
    return bulkContent(memory ? { ...env, memory } : env);
  },
});
