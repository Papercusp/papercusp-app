/**
 * scheduler:get_next — the bee's spec-driven self-select (hybrid-bee-scheduler-work-stealing-2026-06-22).
 *
 * The bee calls get_next; the resolver loads the bee's Queen-issued claim spec (mig 372
 * bee_claim_specs; DEFAULT_CLAIM_SPEC when none) and atomically claims the single next eligible
 * work-item: the GLOBAL FLOORS (ready/blocking, lease, admission, swarm-affinity, dedup) AND the
 * spec's view.filter, ordered by the spec's rank, FOR UPDATE SKIP LOCKED. The spec can only
 * narrow + reorder within the floors (D-002); it can never claim a blocked/taken item.
 *
 * The richer sibling of work_items:claim_next (which is plain oldest-first, spec-blind): here the
 * Queen's scheduling judgment, expressed as the bee's spec, decides WHICH item; pickup stays the
 * bee's (self-selection, the blackboard result).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { resolveAgentIdentity, type AgentIdentity } from '../coordination/identity';
import { getPresence, writePresence } from '../coordination/presence';
import { COORD_ROLES } from '../coordination/roles';
import {
  getNextForBee,
  resolveClaimSpecWorkspace,
  getClaimSpecRecord,
  clearClaimSpec,
  readClaimConcurrency,
  fleetSpecBeeKey,
} from '../../scheduler/claim-spec-store';
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';
import { CURRENT_SPEC_VERSION } from '../../scheduler/claim-spec';
import { CLAIM_STATES_ALLOWLIST, familyOf, releaseWorkItem } from '../../work-items';
import { workItemClaimLeaseEnabled, leaseClaimedWorkItem } from '../../work-item-claim-lease-wiring';
import { getBuildInfo } from '../../build-info';
import {
  assessClaimFreshness,
  isFreshnessTrackedKind,
  type ClaimFreshnessVerdict,
} from '../../work-item-claim-freshness';
import {
  defaultHarnessScopeInheritanceReaders,
  readBriefHarnessBinding,
  readClaimHarnessBinding,
  readFleetHarnessBinding,
  readPlanHarnessBinding,
  resolveInheritedHarnessScope,
} from '../_harness-scope';
import { getActiveClaimForOwner } from '../../work-item-claims';
import { getSessionBrief } from '../../session-brief';
import { planHarnessesForSlugs } from '../plans/source';
import { loadHarnessRegistry } from '../../harness-registry';
import { cancelClaimableAwaits } from '../../events/await/store';
import { withBoundedTimeout } from '../../bounded-timeout';
import { OrgTxnTimeoutError } from '../../pg-bounded-txn';
import { liveLockedPaths } from '../locks/live-lock-paths';

/** The claimable-state subset diagnoseClaimNextMiss accepts (mirrors CLAIM_STATES_ALLOWLIST). */
type ClaimNextStates = ('open' | 'failing')[] | undefined;
import { matchRoutingGateHint } from '../../routing-gate-hints';
import {
  fleetScopedMiss,
  reconcileFleetScopeClaims,
  readFleetPauseState,
  diagnoseFleetScopeCooldownMiss,
  diagnoseFleetScopeIssueFloorMiss,
  diagnoseFleetScopeFeatureFamilyMatch,
  diagnoseFleetScopeTerminalExhaustion,
  diagnoseFleetScopePlanTerminality,
  diagnoseFleetScopeLeaderLiveness,
  fleetLeaderUnavailableRefusal,
} from '../../scheduler/fleet-scope-admission';
import { getClaimTimeRetractionAdvisory } from '../work_items/retraction-advisory';
import {
  fetchContextPressure,
  resolveContextPressureRecoveryPath,
  resolveContextPressureHeadroom,
} from '../coordination/context-pressure';
import { decideContextPressureGate, contextCriticalRefusalResult } from '../../scheduler/context-pressure-claim-gate';
import type { ContextPressureBucket } from '../coordination/context-pressure';
import { autoBenchContextCriticalCaller as autoBenchContextCriticalCallerCore } from '../../fleet/context-critical-bench';
import { registerBenchPark } from '../../fleet/bench-park';
import { listParkedAwaitsForSubscribers as listParkedAwaitsForSubscribersStore } from '../../events/await/store';
import { registerAwait as registerAwaitStore } from '../../events/await/store';
import { captureWakeHandleForOwner as captureWakeHandleForOwnerStore } from '../../events/await/handle';
import { decideGoalStewardGate, goalStewardRefusalResult } from '../../scheduler/goal-steward-claim-gate';
import { readGoalHolderAuthority } from '../../goals/holder-authority';
import { getOrgPg } from '@papercusp/db-org';

/**
 * EI-20099413453852234 — declare the caller's intent for the item it just claimed.
 *
 * This tool CLAIMS an item but used to leave the claimant's declared intent untouched,
 * so from the instant of the claim `coord_presence` held a live claim beside a stale
 * intent and presence computed `intentDivergent: true` for an agent that was actively
 * mid-implementation. Peers use exactly that signal to judge whether a claim is real:
 * one read it and offered to take an item out from under its holder, who was mid-fix on
 * that very item. An agent in a get_next loop re-claims every wake, so its intent was
 * stale BY CONSTRUCTION unless it remembered a second, entirely optional call each time.
 * The divergence is also invisible from INSIDE the agent that causes it and visible only
 * to peers — the worst shape for a self-correcting signal — so it is fixed HERE, at the
 * claim, rather than left to per-agent discipline.
 *
 * ⚠ READ-MODIFY-WRITE, DELIBERATELY — do not "simplify" this to a bare write.
 * `PgPresenceStore.write()`'s ON CONFLICT sets `current_plan_slug = EXCLUDED.current_plan_slug`,
 * a BARE assignment, so a write that OMITS it CLEARS it. A naive `writePresence(ident,
 * { intent })` would therefore wipe the declared plan slug of every self-pulling agent on
 * every claim — strictly worse than the stale intent it set out to fix. Every OTHER field
 * is safe to omit: `currentFiles` is COALESCEd against the existing row, `agentRole` /
 * `potSlug` / `capabilityTags` are populate-once-then-keep, and `host` / `pid` / `tty`
 * reset-then-repopulate from the psu supervisor beat by design.
 *
 * Fail-soft, like the `cancelClaimableAwaits` call it sits beside: the claim is already
 * COMMITTED by the time this runs, so dropping the caller's result over a presence hiccup
 * would be far worse than a stale intent.
 */
async function declareIntentForClaim(
  identity: AgentIdentity,
  workItem: unknown,
  harnessSlug?: string | null,
): Promise<void> {
  const wi = workItem as { id?: string | null; title?: string | null } | null;
  const id = typeof wi?.id === 'string' && wi.id.length > 0 ? wi.id : null;
  if (!id) return;
  const prev = await getPresence(identity.ownerId).catch(() => null);
  // Never clobber an intent the caller set DELIBERATELY for this same item: a re-pull of
  // an item you already declared should keep your richer wording, not flatten it to the
  // generated form. Also makes the write idempotent across repeated claims of one item.
  if (prev?.intent && prev.intent.includes(id)) return;
  const title = typeof wi?.title === 'string' ? wi.title.trim() : '';
  const clipped = title.length > 120 ? `${title.slice(0, 119)}…` : title;
  await writePresence(
    identity,
    {
      intent: clipped ? `${id}: ${clipped}` : id,
      // The one field that MUST be carried — see the ON CONFLICT note above.
      currentPlanSlug: prev?.currentPlanSlug ?? null,
    },
    harnessSlug ?? null,
  );
}

/**
 * P-006/P-007 (composable-event-awaits-2026-07-11): the idle-puller recipe, delivered at
 * the exact moment it applies — an EMPTY pull. Retires the ~60s idle re-poll cadence:
 * register a standing wake watch over the canonical `work-item:claimable` key
 * (P-007 dual-emit — it fires on every created-unclaimed / claim-released /
 * last-blocker-cleared transition, collapsing the 3-leaf composed any-spec this recipe
 * originally taught); payload carries {id,kind,severity,harness,title,state,reason,plan,
 * tags,goal} so `payload_filter` narrows it to your claim spec's view (including
 * goal-scoped lanes), with `wake:true, once:false` so it remains armed after each wake.
 * The wake is a HINT, never a claim — get_next stays the single authoritative claim path,
 * so a spurious/racing wake costs one cheap re-miss, never a double-claim.
 * Exported for the recurrence-guard pin test (idle-loop-recipe-pin.test.ts).
 */
export const IDLE_PULL_MISS_ADVICE =
  'Idle recipe (composable-event-awaits P-006/P-007): do NOT re-poll on a timer — register the standing wake watch and END YOUR TURN: ' +
  'watch:create { pattern: "work-item:claimable", wake:true, once:false, payload_filter: { harness: { eq: "<your-harness>" } } /* narrow to your claim spec\'s view — id/kind/title/plan/tags/goal are carried */ } ' +
  '— work-item:claimable fires on every created-unclaimed / claim-released / unblocked transition; the standing watch re-invokes you on each matching transition and remains armed after a re-miss. ' +
  'The wake is a HINT that work may exist, never a claim: scheduler:get_next stays the AUTHORITATIVE claim on the wake turn; ' +
  'do not pass targetKind with wake:true, and a re-miss does not require re-registering the watch.';

/**
 * EI-18167154191955470: internal budget for the get_next DB path. During a fleet-drain cold
 * wake, a routine scheduler:get_next hung with ZERO response/progress for the full 300s MCP
 * idle timeout and was aborted by the client; an immediate retry of the identical call
 * succeeded (a floor-gated miss) in ~2s. The signature of PG pool contention: a query stuck
 * waiting on a pool connection blocks silently — no error, no progress — until a connection
 * frees. This budget bounds the heaviest DB legs (the atomic claim + the miss-diagnosis
 * fan-out) so such a stall returns a FAST, clean, retryable error WELL under the 300s idle
 * abort instead of the observed silent-hang failure mode. 30s is ~15x the normal ~2s latency
 * (so it never false-fires on a healthy-but-busy call) and 10x under the idle abort (so the
 * client NEVER hard-aborts first). The underlying pool-saturation root cause is tracked
 * separately (EI-18147753127456018); this closes the bad-failure-mode half.
 */
export const GET_NEXT_BUDGET_MS = 30_000;

/**
 * Whole-handler wall-clock ceiling. Individual 30s phase budgets used to stack
 * sequentially (preflight + claim + recheck), so two healthy fail-fast guards
 * could still exceed the MCP transport's ~55s clamp. Every bounded phase now
 * consumes only the time remaining from this one deadline.
 */
export const GET_NEXT_TOTAL_BUDGET_MS = 45_000;

/**
 * Leave enough headroom inside the whole-handler ceiling for the final miss
 * response after the database-side issue-floor diagnosis settles. The
 * diagnosis itself also owns a shorter PostgreSQL statement/acquire bound;
 * this outer watchdog is the last-resort handler guarantee if that helper (or
 * a test double) never settles.
 */
export const GET_NEXT_ISSUE_DIAG_BUDGET_MS = 12_000;

/**
 * EI-22737570207805341: a JavaScript watchdog does not cancel the in-flight claim promise.
 * Give the caller a short, separate window to inspect the caller's held rows before returning
 * the timeout. This is deliberately much shorter than the claim budget: it is a best-effort
 * reconciliation, not a second chance to wait for the abandoned claim.
 */
export const GET_NEXT_TIMEOUT_RECONCILIATION_BUDGET_MS = 2_000;

export type ClaimTimeoutReconciliationStatus = 'held' | 'none-observed' | 'unknown';

export interface ClaimTimeoutReconciliation {
  status: ClaimTimeoutReconciliationStatus;
  heldIds: string[];
}

/**
 * EI-21863190622583520: the budget for the OPTIONAL per-floor miss breakdown — applied to the
 * caller (`withBoundedTimeout`) and to PostgreSQL (`statement_timeout`) from this single
 * constant, so the two can never drift into a window where the database keeps computing a
 * result the only consumer has already discarded. This breakdown is a diagnostic garnish on an
 * already-decided miss, so exceeding it degrades to a plain miss rather than failing the pull.
 */
export const MISS_BREAKDOWN_BUDGET_MS = 1_500;

/**
 * The fast, self-describing miss the tool returns when its DB path exceeds GET_NEXT_BUDGET_MS,
 * instead of hanging until the MCP client's 300s idle-timeout abort (EI-18167154191955470).
 * Distinct `error: 'timeout'` + `retryable: true` so a caller can distinguish it from a genuine
 * "no claimable work" miss. The response also carries a best-effort held-claim reconciliation;
 * callers must inspect it before retrying because the abandoned claim may still commit.
 */
export function getNextTimeoutResult(
  budgetMs = GET_NEXT_BUDGET_MS,
  reconciliation: ClaimTimeoutReconciliation = { status: 'unknown', heldIds: [] },
): {
  ok: false;
  error: 'timeout';
  retryable: true;
  budgetMs: number;
  possiblyClaimed: true;
  heldIds: string[];
  claimReconciliation: ClaimTimeoutReconciliationStatus;
  message: string;
} {
  const reconciliationNote =
    reconciliation.status === 'held'
      ? `A best-effort held-claim read observed ${reconciliation.heldIds.length} claim(s) for this caller; ` +
        'the timed-out claim may be among them.'
      : reconciliation.status === 'none-observed'
        ? 'A best-effort held-claim read observed no claims for this caller at that instant, but that is not proof the abandoned claim cannot commit later.'
        : 'The best-effort held-claim read was inconclusive; do not infer that no claim was made.';
  return {
    ok: false,
    error: 'timeout',
    retryable: true,
    budgetMs,
    possiblyClaimed: true,
    heldIds: reconciliation.heldIds,
    claimReconciliation: reconciliation.status,
    message:
      `scheduler:get_next exceeded its ${budgetMs}ms internal budget (likely transient PG pool ` +
      `contention) and returned a fast error instead of hanging until the MCP client's 300s ` +
      `idle-timeout abort (EI-18167154191955470). The claim promise may still commit after this ` +
      `response, so possiblyClaimed is true. ${reconciliationNote} Reconcile the held ids before ` +
      `retrying; if the timeout persists, the account/PG pool may be saturated (see ` +
      `accounts:status / dev:rate_governor_status).`,
  };
}

/**
 * EI-20228674494907304: the claim watchdog does not cover the fleet/preflight reads that run
 * before `getNextForBee` starts. A stalled reconciliation, pause-state, flag, or lock snapshot
 * therefore used to leave the whole tool silent until the MCP client's 300s idle timeout. Keep
 * this result distinct from the claim-path timeout so callers know no claim was attempted.
 */
export function getNextPreflightTimeoutResult(
  budgetMs = GET_NEXT_BUDGET_MS,
  reason: 'timeout' | 'aborted' | 'error' = 'timeout',
  errorMessage?: string,
  lastPreflightStep?: string,
): {
  ok: false;
  error: 'timeout';
  retryable: true;
  phase: 'preflight';
  budgetMs: number;
  lastPreflightStep?: string;
  message: string;
} {
  const detail =
    reason === 'error' && errorMessage
      ? ` failed before the claim path: ${errorMessage}`
      : reason === 'aborted'
        ? ' was aborted before the claim path'
        : ` exceeded its ${budgetMs}ms internal budget`;
  return {
    ok: false,
    error: 'timeout',
    retryable: true,
    phase: 'preflight',
    budgetMs,
    ...(lastPreflightStep ? { lastPreflightStep } : {}),
    message:
      `scheduler:get_next pre-claim setup${detail}` +
      (lastPreflightStep ? ` at preflight step "${lastPreflightStep}"` : '') +
      ` (fleet reconciliation, pause-state, flag, or ` +
      `lock snapshot) and returned a fast retryable error instead of hanging until the MCP ` +
      `client's 300s idle-timeout abort. No claim was attempted; retry now.`,
  };
}

/**
 * Return a structured retryable result for a bounded admin-pool transaction that hit a
 * PostgreSQL statement/lock timeout. This is distinct from the JS watchdog result above:
 * the database has already rejected the transaction, so preserving its typed message (and
 * blocker hint, when available) gives the caller the actual contention diagnosis instead of
 * converting it into a generic MCP `handler_error`.
 */
export function getNextContentionResult(error: OrgTxnTimeoutError): {
  ok: false;
  error: 'timeout';
  retryable: true;
  pgCode: string;
  timeoutSource: 'pg' | 'caller-budget';
  message: string;
} {
  // EI-21831306274538775: `pgCode: '57014'` here does NOT prove PostgreSQL timed out. The
  // claim ladder SYNTHESIZES the same typed error when its own wall-clock budget expires,
  // so that an abandoned claim can never be misread as "nothing matched" — deliberate, but
  // it made the two causes indistinguishable to whoever triages the result. This item was
  // filed as reproduced PG contention on the strength of that code alone, pointing triage
  // at the connection pool for a budget that ran out inside the scheduler. Both remain
  // retryable and keep the same code; they no longer claim the same cause.
  const callerBudget = error.timeoutSource === 'caller-budget';
  return {
    ok: false,
    error: 'timeout',
    retryable: true,
    pgCode: error.pgCode,
    timeoutSource: error.timeoutSource,
    message: callerBudget
      ? `scheduler:get_next abandoned its claim after exhausting the scheduler's OWN budget (reported as ${error.pgCode}; PostgreSQL did not time out): ${error.message}. ` +
        'Retry now; no claim was returned. Repeated occurrences point at claim-ladder cost or backlog shape — NOT at PG pool saturation.'
      : `scheduler:get_next claim hit transient PostgreSQL contention (${error.pgCode}): ${error.message}. ` +
        'Retry now; the failed transaction was rolled back and no claim was returned.',
  };
}

/** WI-4413: pull the ids a claim spec NAMES (the leader-tranche shape) out of its view filter. */
export function specNamedIds(spec: unknown): string[] {
  const view = (spec as { view?: { filter?: { all?: unknown[] } } } | undefined)?.view;
  const clauses = Array.isArray(view?.filter?.all) ? view.filter.all : [];
  for (const c of clauses) {
    const cl = c as { field?: string; op?: string; value?: unknown };
    if (cl?.field === 'id' && cl?.op === 'in' && Array.isArray(cl.value)) {
      return cl.value.filter((v): v is string => typeof v === 'string');
    }
  }
  return [];
}

/** The kinds whose claim path runs through the ISSUE-family diagnostic
 *  (diagnoseClaimNextMiss / explainIssueClaimFloors / aggregateIssueClaimExclusions,
 *  all imported below) — mirrors buildFleetKindClaimSpec's ISSUE_FAMILY_CLAIM_KINDS
 *  in fleet_registry/launch-on-plan.ts (not re-exported from there to avoid a
 *  fleet_registry → agent-tools/scheduler import edge for one literal set). */
const ISSUE_FAMILY_KINDS = new Set(['bug', 'change', 'task']);

/**
 * EI-18741395910746959: pull the `kind in [...]` leaf's value out of a claim spec's
 * view filter (top-level or nested one level inside an `all`) — the sibling of
 * specNamedIds, used to tell whether THIS diagnosis (which is issue-family-only,
 * see the doc comment below) is even on-topic for the caller's spec.
 */
export function specKindFilterValues(spec: unknown): string[] | undefined {
  const view = (spec as { view?: { filter?: unknown } } | undefined)?.view;
  const filter = view?.filter as { field?: string; op?: string; value?: unknown; all?: unknown[] } | undefined;
  if (!filter) return undefined;
  const candidates = Array.isArray(filter.all) ? filter.all : [filter];
  for (const c of candidates) {
    const cl = c as { field?: string; op?: string; value?: unknown };
    if (cl?.field === 'kind' && cl?.op === 'in' && Array.isArray(cl.value)) {
      return cl.value.filter((v): v is string => typeof v === 'string');
    }
  }
  return undefined;
}

/**
 * True when the spec's OWN kind filter (if any) restricts EXCLUSIVELY to issue-family
 * kinds (bug/change/task) — i.e. the issue-family-only diagnostic below is the WHOLE
 * story for this caller. False when the filter has no kind restriction at all (both
 * families are structurally reachable) or explicitly includes a non-issue kind
 * (feature/chunk/research-task/…) — in either case a "0 issue-family rows" diagnosis
 * is not the whole picture and the caller needs to be told so explicitly (the exact
 * confusion reported in EI-18741395910746959: a feature-only plan's claim spec has no
 * kind leaf at all, so its miss diagnosis silently talked ONLY about the issue-family
 * side, which the plan's items never touch, and never mentioned the feature-family
 * claim path at all).
 */
export function specIsIssueFamilyOnly(spec: unknown): boolean {
  const kinds = specKindFilterValues(spec);
  if (!kinds || kinds.length === 0) return false;
  return kinds.every((k) => ISSUE_FAMILY_KINDS.has(k));
}

/**
 * EI-22143638502920491: pure text for the SHADOWED-FLEET-SPEC note appended to a miss
 * diagnosis when the caller's effective spec is a per-bee override (`source:'cup'`) that
 * permanently shadows an inherited fleet spec — confirmed live: a `plans:start`-installed
 * per-bee spec whose own plan later drained left a DRAIN fleet leader idling beside 2,493
 * claimable items its OWN fleet spec matched, with nothing in the miss diagnosis saying so
 * (the fleet spec is never even consulted once a per-bee row exists — getClaimSpecRecord
 * returns the moment it finds one). Kept pure + exported so the message text is
 * unit-testable without a live DB fetch; the DB-side lookup (fleet membership, the fleet's
 * own spec record, its match count) lives in buildMissDiagnosis, which calls this only once
 * it already has the three concrete numbers below.
 */
export function shadowedFleetSpecNote(args: {
  ownerId: string;
  fleetSlug: string;
  revision: number | null;
  matchedByFilter: number;
}): string {
  const { ownerId, fleetSlug, revision, matchedByFilter } = args;
  return (
    ` ⚠ SHADOWED FLEET SPEC: your effective spec is a PER-BEE OVERRIDE (source:'cup'), which ` +
    `always wins over an inherited fleet spec and was NEVER consulted. Your fleet '${fleetSlug}'` +
    (revision !== null ? ` (rev ${revision})` : '') +
    ` has its own sentinel spec whose filter matches ${matchedByFilter} issue-family row(s) your ` +
    `current spec's filter does not — this is very likely why you are idling. Remedy: ` +
    `scheduler:set_claim_spec { cupId: '${ownerId}', clear:true } to drop the override and inherit ` +
    `the fleet spec (scheduler:get_claim_spec { fleet: '${fleetSlug}' } for detail).`
  );
}

/**
 * WI-6409: the ONE cap-led refusal EVERY miss branch returns when the caller is at its
 * concurrency cap — shared so the fleet-scoped and non-fleet branches cannot drift.
 *
 * Why it is shared rather than inlined at the (previously single) call site: EI-19931420102632438
 * fixed exactly this misattribution on the NON-fleet branch — "lead with the CAP, never with the
 * lane-empty phrase" — but a fleet member's miss routes to `fleetScopedMiss` instead, which never
 * consulted concurrency at all. So the identical defect survived on the branch every fleet member
 * actually takes, where it is strictly worse: `fleetScopedMiss` does not merely say "lane empty",
 * it pronounces CLAIM-PATH/READ-PATH DIVERGENCE, calls the breakdown "the reproduction", and
 * instructs the member to file a claim-path bug and NOT stand down.
 *
 * Measured live 2026-08-09 (this item's own reproduction, pool held constant): holding 1/1, two
 * consecutive `scheduler:get_next` calls returned `divergenceRecheck:"confirmed-twice"` with
 * "232 of 411 rows pass every floor"; releasing to 0 claims and re-calling seconds later SERVED an
 * item under the same spec (rev 7). The claim path was healthy the whole time.
 *
 * Note the divergence RE-CHECK cannot discriminate this case by construction: it re-runs the same
 * claim, which is still cap-blocked, so "confirmed-twice" is GUARANTEED rather than corroborating —
 * which is why the false verdict reads as rigorously confirmed. Hence the check below runs BEFORE
 * the re-check, not merely before the verdict.
 */
function concurrencyBlockedRefusal(concurrency: {
  activeClaims: number;
  maxConcurrentClaims: number;
  heldIds: string[];
}): { error: string; diagnosis: Record<string, unknown> } {
  return {
    // EI-19931420102632438: lead with the CAP, never with a lane-contents claim. A caller refused
    // on its own cap had the lane never consulted at all.
    error:
      `claim cap reached: you already hold ${concurrency.activeClaims}/${concurrency.maxConcurrentClaims} ` +
      `concurrent claim(s) — release or complete one before claiming another; ` +
      `held: ${concurrency.heldIds.join(', ')}. (The claim lane itself was NOT evaluated — this is ` +
      `not a statement about lane contents.)`,
    diagnosis: {
      concurrencyBlocked: true,
      activeClaims: concurrency.activeClaims,
      maxConcurrentClaims: concurrency.maxConcurrentClaims,
      heldIds: concurrency.heldIds,
    },
  };
}

/**
 * EI-21238986333755666: a declared plan is a control-plane scope, not merely presence
 * decoration. A non-fleet caller with no authored claim spec must not fall through to
 * DEFAULT_CLAIM_SPEC, because that spec ranges over the whole harness and can atomically
 * claim an unrelated plan's work. Keep this refusal distinct from a drained/wind-down miss:
 * no claim was attempted and the caller needs a spec, not an idle-loop stand-down.
 */
export function planScopeMissingRefusal(planSlug: string, cupId: string, harness?: string) {
  const recoveryArgs = {
    cupId,
    ...(harness ? { harness } : {}),
    spec: {
      specVersion: CURRENT_SPEC_VERSION,
      specId: `declared-plan:${planSlug}`,
      revision: 1,
      view: { filter: { field: 'plan', op: '=', value: planSlug } },
      rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
    },
  };
  return {
    ok: false as const,
    error: 'plan_scope_missing' as const,
    reason: 'declared_plan_without_claim_spec' as const,
    retryable: true as const,
    noClaim: true as const,
    windDown: false as const,
    recoverable: true as const,
    declaredPlanSlug: planSlug,
    claimSpecSource: 'default' as const,
    message:
      `caller declares plan '${planSlug}' but has no per-bee or inherited claim spec; ` +
      'scheduler:get_next is blocked before claim so DEFAULT_CLAIM_SPEC cannot widen the pull to unrelated work.',
    recovery: {
      tool: 'scheduler:set_claim_spec',
      args: recoveryArgs,
    },
  };
}

/**
 * Recover the one plan slug from the exact per-owner claim-spec shape `plans:start`
 * authors. This is intentionally NOT a generic "contains a plan predicate" walk:
 * automatically deleting a user-authored union such as `any:[plan,id]` when the
 * plan retires would discard the still-live id lane and silently widen the caller to
 * DEFAULT_CLAIM_SPEC. Only the two shapes buildExactPlanClaimSpec emits qualify.
 */
export function plansStartExactPlanBinding(spec: unknown): string | null {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return null;
  const record = spec as { specId?: unknown; view?: { filter?: unknown } };
  if (typeof record.specId !== 'string' || !record.specId.startsWith('plans-start-')) return null;
  const planSlug = record.specId.slice('plans-start-'.length);
  if (!planSlug) return null;
  const isPlanLeaf = (node: unknown): boolean => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return false;
    const leaf = node as { field?: unknown; op?: unknown; value?: unknown };
    return leaf.field === 'plan' && leaf.op === '=' && leaf.value === planSlug;
  };
  const isKindLeaf = (node: unknown): boolean => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return false;
    const leaf = node as { field?: unknown; op?: unknown; value?: unknown };
    return (
      leaf.field === 'kind' &&
      leaf.op === 'in' &&
      Array.isArray(leaf.value) &&
      leaf.value.length > 0 &&
      leaf.value.every((value) => typeof value === 'string')
    );
  };
  const filter = record.view?.filter;
  if (isPlanLeaf(filter)) return planSlug;
  if (!filter || typeof filter !== 'object' || Array.isArray(filter)) return null;
  const all = (filter as { all?: unknown }).all;
  if (!Array.isArray(all) || all.length !== 2) return null;
  return all.some(isPlanLeaf) && all.some(isKindLeaf) ? planSlug : null;
}

/**
 * EI-22003108135602428: a terminal plan can remain in presence after its last
 * turn. That declaration is no longer a useful scope boundary, but blindly
 * falling through to DEFAULT_CLAIM_SPEC would make an active plan declaration
 * unsafe. Only clear it after the plan store positively proves terminality (or
 * that no non-terminal plan items remain), and require the presence write to
 * succeed before allowing the generic pull to continue.
 */
async function clearStaleTerminalPlanDeclaration(args: {
  identity: AgentIdentity;
  presence: { intent?: string | null };
  planSlug: string;
  harness: string;
}): Promise<boolean> {
  // Presence and claim specs both use the coordination default when an
  // unscoped identity carries no concrete workspace. Keep the terminality
  // read on that same partition instead of leaving an unscoped stale plan
  // declaration permanently fail-closed.
  const workspaceId = resolveClaimSpecWorkspace(args.identity.workspaceId) ?? 'default';
  try {
    const { planTerminalityInWorkspace } = await import('../plans/source');
    const terminality = await planTerminalityInWorkspace(workspaceId, args.planSlug);
    if (
      !terminality ||
      (terminality.status !== 'shipped' && terminality.status !== 'superseded' && terminality.hasOpenItems)
    ) {
      return false;
    }
    await writePresence(
      args.identity,
      {
        intent: args.presence.intent ?? '',
        currentPlanSlug: null,
      },
      args.harness,
    );
    return true;
  } catch {
    // A failed terminality or presence read/write is unknown, not proof that a
    // plan is safe to widen past. Preserve the existing fail-closed refusal.
    return false;
  }
}

/**
 * WI-4413: build the self-explaining miss. Two layers:
 *  1. AGGREGATE — the POOL/READY split from diagnoseClaimNextMiss (already the source of truth
 *     shared with the claim itself). Distinguishes "genuinely drained, idling is correct" from
 *     "the backlog is FULL but every row is gated" — a distinction the old static string erased.
 *  2. PER-ID — when the spec NAMES ids, which floor refuses each. This is the leader's case:
 *     they authored the tranche, so "WI-2749: claim-hold (held open by another agent)" is
 *     directly actionable, where an aggregate count is not.
 *
 * FAILS SOFT — a diagnosis is an annotation on a miss, never a new way for the claim path to
 * throw. Any error degrades to the original static message.
 */
/**
 * WI-7316: one row per work-item the claim path CLAIMED on this pull, found plan-lane-blocked,
 * released and retried past — kept only when the blocking plan item carried a `staleBlockedHint`.
 */
export interface StaleBlockedLaneRow {
  workItemId: string;
  planSlug: string;
  itemId: string;
  hint: string;
}

/**
 * WI-7316: the SOLO/LEADER rendering of those bounces — the counterpart to what
 * `fleetScopedMiss` already renders for a fleet MEMBER (see its `staleBlockedLane` option).
 *
 * Exported for its own unit test rather than left inline in the handler: the handler's miss
 * path needs a live claim + a fleet-scope reconciliation to reach at all, so the one thing
 * worth pinning here — that a stale bounce turns a bare "nothing matched" into an actionable
 * instruction, and that an ordinary block changes nothing — would otherwise be reachable only
 * through a fixture far more elaborate than the string it is checking.
 *
 * Bounded to the first 3 rows plus a count: the structured `staleBlockedLane` field on the same
 * payload carries the rest, and a miss message that grows with the lane is one nobody reads.
 */
export function renderStaleBlockedSoloNote(rows: readonly StaleBlockedLaneRow[]): string {
  if (rows.length === 0) return '';
  return (
    ` ⚠ STALE PLAN-ITEM BLOCK, NOT A DRAINED LANE (WI-7316): ${rows.length} row(s) WERE claimed on this pull and ` +
    `released again because their linked plan item reads 'blocked' while every one of its blocked-by dependencies ` +
    `has ALREADY resolved. Nothing is gating them and nothing will lift — the stored token is sticky until a human ` +
    `clears it, so re-polling this lane cannot help. Clear the plan item(s) with plans:set-status, then re-pull: ` +
    rows
      .slice(0, 3)
      .map((b) => `${b.workItemId} (${b.planSlug}#${b.itemId} — ${b.hint})`)
      .join('; ') +
    (rows.length > 3 ? `; +${rows.length - 3} more (see staleBlockedLane)` : '') +
    '.'
  );
}

async function buildMissDiagnosis(args: {
  ownerId: string;
  workspaceId: string | null;
  harness: string;
  states?: string[];
  rigAvailable?: boolean;
}): Promise<{ error: string; diagnosis?: unknown; floors?: unknown }> {
  const STATIC = 'no claimable work-item matched your spec within the floors';
  try {
    const { diagnoseClaimNextMiss, explainIssueClaimFloors } = await import('../../work-items');
    let floors: unknown;
    let namedSummary = '';
    const resolvedWorkspace = resolveClaimSpecWorkspace(args.workspaceId);
    const rec = await getClaimSpecRecord({
      cupId: args.ownerId,
      workspaceId: resolvedWorkspace,
    }).catch(() => null);

    // WI-5276: getNextForBee fails CLOSED before any claim query when the caller is
    // mid-fleet-transition (source 'default' + a named fleetSlug marker: the latest
    // membership fact names a fleet whose sentinel spec is missing/invalid). The
    // member-role shape returns a fleetScopedMiss upstream, but a non-member role
    // (e.g. just promoted to leader of the new fleet — the original WI-4770 incident)
    // reaches THIS diagnosis, which would otherwise report pool counts as if the
    // items were reachable ("N pass the floors") while the true cause is the guard.
    // Mirror getNextForBee's own check order: this guard fires before concurrency.
    if (rec?.source === 'default' && rec.fleetSlug) {
      return {
        // EI-19931420102632438: this is a PRE-LANE refusal — the claim lane was never
        // evaluated — so the headline must not claim anything about lane contents (the
        // old `${STATIC}. Diagnosis: …` prefix read as "the lane is empty", which is a
        // statement about a different subsystem than the one that actually refused).
        error:
          `blocked: you are mid-fleet-transition — your latest membership fact names ` +
          `fleet '${rec.fleetSlug}' but no valid per-bee or inherited fleet claim spec exists, so ` +
          `self-select fails CLOSED (WI-4770) regardless of pool size. (The claim lane itself was ` +
          `NOT evaluated — this is not a statement about lane contents.) Escape: have the leader ` +
          `install the fleet sentinel (scheduler:set_claim_spec { fleet }), set your own per-bee ` +
          `spec, or fleet:leave to settle to solo default pulls.`,
        diagnosis: { fleetTransitionBlocked: true, fleetSlug: rec.fleetSlug },
      };
    }

    // EI-12095: getNextForBee short-circuits BEFORE the claim query whenever the caller
    // already holds >= its spec's maxConcurrentClaims (default 1) — a parked/held item
    // still counts (it retains `taken_by`). That miss has NOTHING to do with pool/floor
    // admissibility, so running diagnoseClaimNextMiss for it produces a real, expensive
    // false signal ("N admissible" while the true cause is "you're at your concurrency
    // limit") — a live incident burned a fleet leader hours bisecting the claim query for
    // exactly this. Check it FIRST and, when true, report it plainly (with the held ids,
    // so the caller can act immediately) instead of computing floors at all.
    // EI-19313376980892266: goes through the shared oracle (evaluateClaimConcurrency) so
    // this diagnosis, getNextWorkItem's refusal, fleet:leader-brief's idle accounting and
    // work_items:claim's WARNING cannot disagree about who is at capacity.
    //
    // "Warning", not "gate", and the distinction is load-bearing: work_items:claim is a
    // by-id door and stays ungated (claim-door-census.test.ts, `by-id-ungated`) — it reports
    // this same verdict on a successful claim (concurrencyClaimWarning) rather than refusing.
    // Sharing the ORACLE is what this item is about; sharing the BEHAVIOUR would break the
    // deliberate override.
    const concurrency = await readClaimConcurrency({
      cupId: args.ownerId,
      workspaceId: resolvedWorkspace,
      maxConcurrentClaims: rec?.spec.limits?.maxConcurrentClaims,
    }).catch(() => null);
    if (concurrency?.blocked) {
      // WI-6409: the message + diagnosis now live in `concurrencyBlockedRefusal` so the
      // fleet-scoped branch returns the IDENTICAL verdict instead of a false divergence.
      return concurrencyBlockedRefusal(concurrency);
    }

    // D-002 (drain-claim-spec-hardening-2026-07-13, fixes EI-11300): mirror getNextWorkItem's
    // own states resolution (per-call override wins; else the spec's `states`; else the
    // ['todo'] floor default) so the miss diagnosis reflects the SAME pool the real claim
    // attempt just ran under — a diagnosis computed under a different `states` than the
    // claim itself would mislead the caller about why it missed.
    const effectiveStates = args.states ?? (rec?.spec as { states?: string[] } | undefined)?.states;
    const diag = await diagnoseClaimNextMiss({
      harness: args.harness,
      assignee: args.ownerId,
      states: effectiveStates as ClaimNextStates,
      rigAvailable: args.rigAvailable,
    });
    const ids = specNamedIds(rec?.spec);
    if (ids.length > 0) {
      const attributed = await explainIssueClaimFloors(args.harness, ids, {
        assignee: args.ownerId,
        rigAvailable: args.rigAvailable,
      });
      const refused = attributed.filter((a) => !a.admissible);
      // EI-20268301668126253: keep scheduler miss diagnostics data-plane-only.
      // The already-decided floor rows are sufficient to explain the miss. The
      // optional holder annotation fans out through holder-goal reads and
      // agent_facts folds, so running it from this hot self-select surface can
      // amplify the same shared-pool contention that caused the miss. Other
      // friction surfaces retain the shared holder advisory; scheduler:get_next
      // deliberately omits this non-authoritative decoration.
      floors = attributed;
      if (refused.length === ids.length) {
        // The whole tranche is floored — the leader's spec is the thing that needs fixing, and
        // saying so plainly is the entire point of this diagnosis.
        namedSummary =
          ` Your spec NAMES ${ids.length} id(s) and NONE of them are claim-path admissible — ` +
          `this is a SPEC problem, not an empty queue: ` +
          refused.map((r) => `${r.id} (${r.refusedBy ?? 'unknown'})`).join(', ') +
          `. Tell your fleet leader; they must re-feed the spec.`;
      } else if (refused.length > 0) {
        namedSummary = ` ${refused.length}/${ids.length} named id(s) are floored: ${refused
          .map((r) => `${r.id} (${r.refusedBy ?? 'unknown'})`)
          .join(', ')}.`;
      }
    }

    // EI-22143638502920491: a per-bee override (source:'cup') ALWAYS wins over an inherited
    // fleet spec, and getClaimSpecRecord stops looking the instant it finds one — so nothing
    // in this diagnosis, until now, ever told a shadowed caller that a DIFFERENT spec (their
    // own fleet's) would have matched. Confirmed live: a plans:start-installed per-bee spec
    // whose plan later drained left a DRAIN fleet leader idling beside 2,493 claimable items
    // its OWN fleet spec matched — while `diag` above (floor-only, filter-agnostic) correctly
    // reported a healthy readyUnclaimed pool, giving no hint that the caller's FILTER, not the
    // floors, was the actual cause. Skip when the pool is genuinely drained: no spec would help.
    let shadowedFleetNote = '';
    let shadowedFleetSpec: { fleetSlug: string; revision: number | null; matchedByFilter: number } | undefined;
    if (rec?.source === 'cup' && !diag.drained) {
      try {
        const { latestFleetMembership } = await import('../../fleet-membership-store');
        const membership = await latestFleetMembership(resolvedWorkspace ?? DEFAULT_COORD_WORKSPACE, args.ownerId);
        if (membership?.fleetSlug) {
          const fleetRec = await getClaimSpecRecord({
            cupId: fleetSpecBeeKey(membership.fleetSlug),
            workspaceId: resolvedWorkspace,
          }).catch(() => null);
          if (fleetRec && fleetRec.source === 'fleet') {
            const { aggregateIssueClaimExclusions } = await import('../../scheduler/get-next');
            const fleetFilter = (fleetRec.spec as { view?: { filter?: unknown } } | undefined)?.view?.filter;
            const agg = await withBoundedTimeout(
              aggregateIssueClaimExclusions(fleetFilter as never, {
                harness: args.harness,
                states: effectiveStates,
                assignee: args.ownerId,
                rigAvailable: args.rigAvailable,
                statementTimeoutMs: MISS_BREAKDOWN_BUDGET_MS,
              }),
              { fallback: null, timeoutMs: MISS_BREAKDOWN_BUDGET_MS, label: 'get_next:shadowedFleetSpec' },
            );
            if (agg.value && agg.value.matchedByFilter > 0) {
              shadowedFleetSpec = {
                fleetSlug: membership.fleetSlug,
                revision: fleetRec.revision,
                matchedByFilter: agg.value.matchedByFilter,
              };
              shadowedFleetNote = shadowedFleetSpecNote({
                ownerId: args.ownerId,
                fleetSlug: membership.fleetSlug,
                revision: fleetRec.revision,
                matchedByFilter: agg.value.matchedByFilter,
              });
            }
          }
        }
      } catch {
        /* best-effort enrichment only — never let this break the miss diagnosis */
      }
    }

    const aggregate = diag.drained
      ? 'the backlog is genuinely DRAINED (0 unclaimed items in the pool) — idling is correct'
      : `the backlog is NOT drained: ${diag.pendingUnclaimed} unclaimed item(s) in the pool, but ${diag.readyUnclaimed} pass the floors` +
        (diag.readyUnclaimed === 0
          ? ' — every one of them is GATED (blocked / held / needs-human / not-work), so idling is correct but the backlog is not empty'
          : '');
    // EI-14108: a flag-READ failure (fail-closed) reads identically to "the issue-claimable
    // flag is off" otherwise — say so explicitly so this never presents as a drained/out-of-
    // scope pool when it's actually an unreadable flag store.
    const flagReadErrorNote = diag.flagReadError
      ? ` NOTE: issue-claim flag UNREADABLE this call (SCHEDULER_ISSUES_CLAIMABLE: ${diag.flagReadError}) — fail-closed, so the counts above EXCLUDE the whole issue family (bug/change/task) rather than reflecting it being off/empty.`
      : '';

    // EI-13965: a BROAD spec (no named ids for explainIssueClaimFloors to attribute) that
    // is genuinely stranded (pool non-empty, nothing ready) gets the same self-explaining
    // treatment via an AGGREGATE per-floor breakdown instead of per-id — "pool empty" vs
    // "pool stranded, and by WHICH floor" for the common member-scoped-miss shape.
    let excludedBreakdown: unknown;
    let breakdownSummary = '';
    if (ids.length === 0 && !diag.drained && diag.readyUnclaimed === 0) {
      const { aggregateIssueClaimExclusions } = await import('../../scheduler/get-next');
      // EI-21863190622583520: ONE budget drives BOTH halves on purpose. `withBoundedTimeout`
      // bounds only this caller — its docstring is explicit that the query "still runs to
      // completion in the background even after a timeout degrades the caller" — so before the
      // server-side cap below, every miss left the system's most expensive aggregate running
      // unbounded on a pooled connection (measured >=180s) for a result this path had already
      // thrown away at 1.5s. There is no value in letting the database outrun the deadline its
      // only consumer abandons at, so the statement cap is the SAME number, not a larger one.
      const agg = await withBoundedTimeout(
        aggregateIssueClaimExclusions(
          (rec?.spec as { view?: { filter?: unknown } } | undefined)?.view?.filter as never,
          {
            harness: args.harness,
            states: effectiveStates,
            assignee: args.ownerId,
            rigAvailable: args.rigAvailable,
            statementTimeoutMs: MISS_BREAKDOWN_BUDGET_MS,
          },
        ),
        { fallback: null, timeoutMs: MISS_BREAKDOWN_BUDGET_MS, label: 'get_next:missBreakdown' },
      );
      if (agg.value) {
        excludedBreakdown = agg.value;
        const top = Object.entries(agg.value.excluded)
          .filter(([, n]) => (n as number) > 0)
          .sort((a, b) => (b[1] as number) - (a[1] as number));
        breakdownSummary =
          top.length > 0
            ? ` Your spec's filter matches ${agg.value.matchedByFilter} issue-family row(s); stranded by: ` +
              top.map(([k, n]) => `${k}=${n}`).join(', ') +
              ' (buckets are independent, a row can count under more than one). Not covered here: the ' +
              "plan-item-lane-guard's per-item blocked/cycle check (post-claim, JS-side) — zero above does " +
              'not rule that out.'
            : agg.value.matchedByFilter === 0
              ? " Your spec's filter matches 0 issue-family rows at all — the SPEC itself is the problem, not a floor."
              : '';
      }
    }

    // EI-18741395910746959: everything above (diag.pendingUnclaimed/readyUnclaimed,
    // explainIssueClaimFloors, aggregateIssueClaimExclusions) is computed EXCLUSIVELY over
    // the issue-family (bug/change/task) claim path — it structurally cannot see a
    // feature-family miss. When the caller's OWN spec does not restrict to issue-family
    // kinds only (no kind filter at all, or one that includes feature/chunk/research-task/…),
    // this whole diagnosis may be silently irrelevant to why THEIR claim actually missed. Say
    // so plainly instead of letting "matches 0 issue-family row(s)" read as the whole picture.
    const issueFamilyOnly = specIsIssueFamilyOnly(rec?.spec);
    const familyScopeNote = issueFamilyOnly
      ? ''
      : ' NOTE: this diagnosis (pendingUnclaimed/readyUnclaimed/floors/excludedBreakdown above) covers ONLY the ' +
        "issue-family (bug/change/task) claim path — your spec's filter does not restrict to issue-family kinds " +
        'only, so if the item(s) you expected to claim are feature-family (kind:"feature"), this diagnosis says ' +
        'nothing about why THAT claim missed; check the plan/feature directly (plans:items / work_items:get) ' +
        'rather than trusting an issue-family-only 0 here.';

    return {
      error: `${STATIC}. Diagnosis: ${aggregate}.${shadowedFleetNote}${namedSummary}${breakdownSummary}${flagReadErrorNote}${familyScopeNote}`,
      diagnosis: {
        drained: diag.drained,
        pendingUnclaimed: diag.pendingUnclaimed,
        readyUnclaimed: diag.readyUnclaimed,
        issueFamilyOnlyDiagnosis: issueFamilyOnly,
        ...(diag.flagReadError ? { flagReadError: diag.flagReadError } : {}),
        ...(shadowedFleetSpec ? { shadowedFleetSpec } : {}),
      },
      floors,
      ...(excludedBreakdown ? { excludedBreakdown } : {}),
    };
  } catch {
    return { error: STATIC };
  }
}

/**
 * EI-20243251614343957: assemble a successful self-pull response in the order the
 * result-door should preserve. The door keeps the PREFIX of an oversized serialized
 * result, so the committed claim receipt and claim-time governing decisions must
 * precede the bulky work-item echo. A self-pull is destructive before this response
 * is serialized; if the tail is cut, the caller must still know which item was
 * committed and must not blindly retry get_next.
 *
 * Keep this pure and exported so the regression test exercises the production
 * assembly rather than a mirrored fixture. The remaining fields retain their former
 * order and conditional presence.
 */
export function assembleSchedulerClaimResult(legs: {
  workItem: unknown;
  claimedUnder: unknown;
  freshness?: unknown;
  warning?: unknown;
  /** EI-22344661292350991: explicit claim-time independence marker and advisory. */
  requiresIndependenceFrom?: unknown;
  independenceWarning?: string;
  routingHint?: unknown;
  memory?: unknown;
  checkpoint?: unknown;
  checkpointAgeMs?: unknown;
  checkpointWarning?: unknown;
  checkpointBgJobWarning?: unknown;
  retractionWarning?: string | null;
  priorWork?: unknown;
  priorWorkWarning?: unknown;
  authorshipRevalidation?: unknown;
  authorshipRevalidationWarning?: unknown;
  planItemContradiction?: unknown;
  planItemContradictionWarning?: unknown;
  /**
   * EI-18713141708830049: the plan item is still OPEN while a settled sibling already
   * implements it — the mirror of planItemContradiction above, not a duplicate of it.
   */
  planItemLanded?: unknown;
  planItemLandedWarning?: unknown;
  /**
   * EI-19329513980117751: another work-item shares this one's stored payload paths and
   * has already landed. A PATH check, not a similarity score — the measured duplicate
   * pairs diverge in prose and agree only on paths.
   */
  siblingPathOverlap?: unknown;
  siblingPathOverlapWarning?: unknown;
  /**
   * EI-19418245218824265: the tree already cites this item's own id — the signal
   * every row-based leg above is blind to when the implementer never claimed the row.
   */
  sourceCitation?: unknown;
  sourceCitationWarning?: unknown;
  planDecisions?: readonly unknown[] | null;
  planDecisionsNote?: string | null;
  priorAttemptBrief?: unknown;
  premises?: unknown;
  premisesNote?: string | null;
  /** EI-21267393427094356: dead-at-HEAD payload paths, resolved to current locations. */
  pathHints?: unknown;
  pathHintsNote?: string | null;
  /** EI-20049758099997696: unresolved repo paths cited in title/summary prose. */
  stalePathRefs?: unknown;
  stalePathRefsNote?: string | null;
  /**
   * P-011: WHICH behavior clauses this claim puts the agent on the hook for, at
   * WHICH revision. ⚠ ADVISORY (D-017) — reported, never enforced here; P-013 owns
   * any refusal, so a consumer must not render it as a blocker.
   */
  behaviorContract?: unknown;
  behaviorContractNote?: string;
}): Record<string, unknown> {
  const workItemRecord =
    legs.workItem && typeof legs.workItem === 'object' ? (legs.workItem as { id?: unknown }) : null;
  const claimSpecRecord =
    legs.claimedUnder && typeof legs.claimedUnder === 'object'
      ? (legs.claimedUnder as { specId?: unknown; revision?: unknown })
      : null;
  const workItemId = typeof workItemRecord?.id === 'string' && workItemRecord.id.length > 0 ? workItemRecord.id : null;
  const claimReceipt = {
    committed: true,
    ...(workItemId ? { workItemId } : {}),
    ...(typeof claimSpecRecord?.specId === 'string' ? { specId: claimSpecRecord.specId } : {}),
    ...(typeof claimSpecRecord?.revision === 'number' ? { revision: claimSpecRecord.revision } : {}),
  };

  return {
    ok: true,
    // This compact receipt must remain first: result-door truncation is
    // prefix-preserving, while the claim has already committed before this
    // response is rendered.
    claimReceipt,
    ...(legs.retractionWarning ? { retractionWarning: legs.retractionWarning } : {}),
    // Keep this before workItem: result-door truncation is prefix-preserving, and
    // governing decisions are safety-critical while the work-item echo is bulky.
    ...(legs.planDecisions
      ? { planDecisions: legs.planDecisions, planDecisionsNote: legs.planDecisionsNote as string }
      : {}),
    ...(legs.priorAttemptBrief ? { priorAttemptBrief: legs.priorAttemptBrief } : {}),
    // Stale-path hints join the prefix block: a caller that loses the response tail must
    // still know which stored paths are fossils before it starts work (EI-21267393427094356).
    ...(legs.pathHints ? { pathHints: legs.pathHints, pathHintsNote: legs.pathHintsNote } : {}),
    ...(legs.stalePathRefs ? { stalePathRefs: legs.stalePathRefs, stalePathRefsNote: legs.stalePathRefsNote } : {}),
    workItem: legs.workItem,
    claimedUnder: legs.claimedUnder,
    ...(legs.freshness ? { freshness: legs.freshness } : {}),
    ...(legs.warning ? { warning: legs.warning } : {}),
    ...(legs.requiresIndependenceFrom
      ? {
          requiresIndependenceFrom: legs.requiresIndependenceFrom,
          ...(legs.independenceWarning ? { independenceWarning: legs.independenceWarning } : {}),
        }
      : {}),
    ...(legs.routingHint ? { routingHint: legs.routingHint } : {}),
    ...(legs.memory ? { memory: legs.memory } : {}),
    ...(legs.checkpoint
      ? {
          checkpoint: legs.checkpoint,
          checkpointAgeMs: legs.checkpointAgeMs,
          checkpointWarning:
            legs.checkpointWarning ??
            'A PRIOR holder left an in-flight checkpoint on this item — it may already be DONE or partly done. Read it before building: verify against the tree/tests first, do not assume greenfield (EI-529).',
          ...(legs.checkpointBgJobWarning ? { checkpointBgJobWarning: legs.checkpointBgJobWarning } : {}),
        }
      : {}),
    ...(legs.priorWork
      ? {
          priorWork: legs.priorWork,
          priorWorkWarning: legs.priorWorkWarning,
        }
      : {}),
    ...(legs.authorshipRevalidation
      ? {
          authorshipRevalidation: legs.authorshipRevalidation,
          authorshipRevalidationWarning: legs.authorshipRevalidationWarning,
        }
      : {}),
    ...(legs.planItemContradiction
      ? {
          planItemContradiction: legs.planItemContradiction,
          planItemContradictionWarning: legs.planItemContradictionWarning,
        }
      : {}),
    ...(legs.planItemLanded
      ? {
          planItemLanded: legs.planItemLanded,
          planItemLandedWarning: legs.planItemLandedWarning,
        }
      : {}),
    ...(legs.siblingPathOverlap
      ? {
          siblingPathOverlap: legs.siblingPathOverlap,
          siblingPathOverlapWarning: legs.siblingPathOverlapWarning,
        }
      : {}),
    ...(legs.sourceCitation
      ? {
          sourceCitation: legs.sourceCitation,
          sourceCitationWarning: legs.sourceCitationWarning,
        }
      : {}),
    ...(legs.premises ? { premises: legs.premises, premisesNote: legs.premisesNote } : {}),
  };
}

// EI-20245892539908894: a successful self-pull can be larger than the text
// result door. Advertise the response as an object and return the claim payload
// through `data` so MCP programmatic callers can receive lossless
// `structuredContent` even when the model-facing text is capped.
const schedulerResultSchema = z.object({ ok: z.boolean() }).passthrough();

/** The claim-spec identity (specId@revision) a disposition can be attributed to — present
 *  whenever the caller's spec was actually resolved (fleet-scoped claim, or a fleet-scoped
 *  miss diagnosed against a specific spec). Omitted rather than null when unresolved, so a
 *  reader distinguishes "no spec identity" from "spec identity, but we don't know it". */
export interface SchedulerDispositionSpecHead {
  specId: string;
  revision: number | null;
}

export type SchedulerDispositionMetadata =
  | ({ kind: 'claimed'; workItemId: string } & Partial<SchedulerDispositionSpecHead>)
  | ({ kind: 'no-claim'; reason: string } & Partial<SchedulerDispositionSpecHead>);

function compactSchedulerNoClaimReason(payload: Record<string, unknown>): string {
  const diagnosis =
    payload.diagnosis && typeof payload.diagnosis === 'object' ? (payload.diagnosis as Record<string, unknown>) : null;
  const candidate = [payload.reason, payload.error, diagnosis?.reason, diagnosis?.error, payload.message].find(
    (value): value is string => typeof value === 'string' && value.trim().length > 0,
  );
  return (candidate?.trim() || 'no_claimable_work_item').slice(0, 500);
}

/**
 * EI-7014: pull the `specId@revision` a disposition is attributable to, out of whichever
 * source actually has it — a successful claim's own `claimedUnder` (the resolver's exact
 * provenance, {@link import('../../scheduler/get-next').GetNextResult}), or a fleet-scoped
 * miss's resolved `ClaimSpecRecord`. Neither is a NEW read: both are already computed on the
 * hot path before this function runs, so recording them costs nothing extra per call — the
 * whole reason `scheduler:pull_ledger` can be a cheap read over `tool_invocations` instead of
 * a live re-resolution per row.
 */
function specHeadFrom(
  source:
    | {
        specId?: string | null;
        revision?: number | null;
      }
    | null
    | undefined,
): SchedulerDispositionSpecHead | undefined {
  const specId = source?.specId?.trim();
  return specId ? { specId, revision: source?.revision ?? null } : undefined;
}

/** One durable outcome vocabulary for the invocation ledger's final branch. */
export function schedulerDispositionMetadata(
  workItem: unknown,
  payload: Record<string, unknown>,
  specHead?: { specId?: string | null; revision?: number | null } | null,
): SchedulerDispositionMetadata {
  const workItemRecord = workItem && typeof workItem === 'object' ? (workItem as { id?: unknown }) : null;
  const workItemId = typeof workItemRecord?.id === 'string' ? workItemRecord.id.trim() : '';
  const head = specHeadFrom(specHead);
  return workItemId
    ? { kind: 'claimed', workItemId, ...head }
    : { kind: 'no-claim', reason: compactSchedulerNoClaimReason(payload), ...head };
}

export default defineTool({
  name: 'scheduler:get_next',
  profile: 'engineer',
  description:
    "Atomically claim the next eligible item under global floors plus the stored claim-spec filter/rank (SKIP LOCKED). A fleet member without an inherited spec fails closed (windDown:true); a non-fleet caller without a declared plan and without a spec uses warned default ordering, while a plan-bound caller fails closed. Returns the claimed item or a diagnosed miss. A successful claim also declares the caller's WI-/EI- intent; specId and revision are result provenance, not request arguments.",
  guidance: {
    when: 'A self-pulling su fleet member pulls from the leader claim spec instead of scanning. Pass { harness, heldPaths?, states?, rigAvailable? }; do NOT pass specId, revision, fleet, workspace, or claimSpec; claimedUnder reports it. This call returns at most one claim and has no `limit` argument.',
    notWhen:
      'Coding-factory roles are pushed a FEATURE_ID and do not self-pull. For a specific id use work_items:claim; for plain non-fleet oldest-first use work_items:claim_next.',
    chaining:
      'After a claim, set state and eventually release/complete it; leaders re-steer with scheduler:set_claim_spec. On a fleet miss with windDown:true, checkpoint/release and park until a spec revision or claimable event. windDown:false plus excludedBreakdown.claimable>0 is a claim-path bug.',
    seeAlso: [
      'work_items:claimable (how many / which items are claimable, WITHOUT claiming — same oracle, no side-effect)',
      'work_items:claim_next (plain oldest-first self-select, no spec)',
      'work_items:claim (claim a SPECIFIC item by id)',
      'scheduler:set_claim_spec (the spec your fleet leader steers you with)',
    ],
  },
  capability: 'work_items:write',
  requirePrincipal: false,
  result: schedulerResultSchema,
  // EI-20219220087119072: this self-pull handler never reads ctx.tx. Its claim,
  // scope-reconciliation, and miss-diagnosis legs use their own DB accessors and
  // can await several independent reads; retaining the dispatcher's ambient
  // workspace transaction pins an org-app pool slot for the whole call and lets
  // fleet contention starve subsequent scheduler pulls at the acquisition seam.
  skipWorkspaceTx: true,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    harness: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Harness to pull from. OPTIONAL — defaults to the session's own harness when it has exactly one. " +
          'Pass it explicitly only to pull from a DIFFERENT harness than the session is scoped to.',
      ),
    heldPaths: z
      .array(z.string())
      .max(500)
      .optional()
      .describe('paths you already hold open — the affinity rank-term input (default: none)'),
    // WI-1912: clamped to the claimable allowlist — a free-string `states` let a caller
    // widen past the resolver-owned floors (a member passed ['todo','open','blocked'] and
    // pulled a leader-triage-only blocked item). The claim-spec validator rejects a
    // `blocked` filter TERM for exactly this reason (D-002); the arg gets the same wall.
    states: z
      .array(z.enum(CLAIM_STATES_ALLOWLIST as unknown as [string, ...string[]]))
      .max(20)
      .optional()
      .describe(
        "claimable states — subset of ['open','failing']. Omit to inherit your claim spec's own `states` (drain-claim-spec-hardening-2026-07-13 D-002/EI-11300 — a fleet leader sets it once via scheduler:set_claim_spec, every member inherits it), else ['open']. `open` is the unified claimable token for BOTH families now (feature `todo` retired). Passing this EXPLICITLY always wins over the spec. 'blocked'/'cursed' are resolver-owned floors (blocked items are leader-triage-only) and terminal states are settled — neither is requestable (D-002 / WI-1912).",
      ),
    rigAvailable: z
      .boolean()
      .optional()
      .describe(
        'WI-2796: pass true ONLY when you actually have/coordinate a live ≥2-machine or Hetzner federation rig. Default (false/omitted): items tagged payload.needs_2_machine_rig are excluded — a single-box caller cannot execute them anyway.',
      ),
    ignoreContextPressure: z
      .boolean()
      .optional()
      .describe(
        'WI-5940 escape hatch: proceed even though your CACHED context-pressure bucket reads critical. Pass true only when your OWN live context gauge contradicts it — the cached bucket is refreshed by a ~2-minute watchdog sweep, so it lags your per-turn reading and can read critical while you are fine. Not a way to skip a compaction you actually need.',
      ),
  }),
  async handler(rawArgs, ctx) {
    const handlerStartedAt = Date.now();
    const remainingBudgetMs = (phaseCapMs = GET_NEXT_BUDGET_MS): number =>
      Math.max(1, Math.min(phaseCapMs, GET_NEXT_TOTAL_BUDGET_MS - (Date.now() - handlerStartedAt)));
    // WI-38059 — default `harness` from the session instead of requiring it.
    //
    // WHY: this was filed FIVE separate times by different agents before anyone
    // fixed it (EI-14940, EI-20184580886728084, EI-20186903579866871,
    // EI-20193064803605796, plus the Gemini grading pass S4). The shape of the
    // failure is always identical: an agent is told "pull work via
    // scheduler:get_next", calls it, and gets
    // `invalid_args: harness: expected string, received undefined` on its FIRST
    // action after a wake — the single worst moment to spend a round-trip, and
    // the reason it kept getting re-filed rather than learned.
    //
    // A session already knows its harness; making the caller restate it bought
    // nothing. Cross-harness pulls still work by passing it explicitly, so this
    // widens behaviour without removing any.
    const ident = resolveAgentIdentity(ctx);
    const ctxHarness = (ctx as { harnessSlug?: string | null }).harnessSlug;
    const inheritedHarness = await resolveInheritedHarnessScope(
      {
        explicitHarness: rawArgs.harness,
        ownerId: ident.ownerId,
        workspaceId: ident.workspaceId,
        sessionHarness: ctxHarness,
      },
      {
        ...defaultHarnessScopeInheritanceReaders,
        claim: (input) => readClaimHarnessBinding(input, getActiveClaimForOwner),
        plan: (input) => readPlanHarnessBinding(input, getPresence, planHarnessesForSlugs),
        fleet: (input) => readFleetHarnessBinding(input, getClaimSpecRecord),
        brief: (input) => readBriefHarnessBinding(input, (ownerId) => getSessionBrief({ ownerId })),
      },
    );
    if (inheritedHarness.kind !== 'harness') {
      // Reachable from an unscoped operator/cross-workspace session with no durable
      // binding, an explicit wildcard, or a stale/ambiguous durable binding. Preserve
      // the canonical resolver's candidates so the caller can correct the binding
      // instead of guessing a harness and crossing an isolation boundary.
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              error: 'harness_required',
              reason: inheritedHarness.kind === 'all' ? 'operator_scope_not_concrete' : inheritedHarness.reason,
              ...('source' in inheritedHarness && inheritedHarness.source
                ? { resolverSource: inheritedHarness.source }
                : {}),
              candidates: inheritedHarness.candidates,
              conflictingBindings: inheritedHarness.conflictingBindings,
              ...('detail' in inheritedHarness && inheritedHarness.detail
                ? { resolverDetail: inheritedHarness.detail }
                : {}),
              detail:
                'No unique concrete harness can be inherited for this pull. Pass `harness` explicitly, ' +
                'or repair the stale/ambiguous claimed-work, plan, fleet, or session binding named above.',
            }),
          },
        ],
        isError: true,
      };
    }
    // Re-bind so every downstream `args.harness` stays a definite string — the
    // alternative (renaming ~15 call sites) would also have caught the unrelated
    // `args.harness` inside buildMissDiagnosis, which has its own `args` param.
    const args = { ...rawArgs, harness: inheritedHarness.slug };
    // workspace-work-scope-policy-2026-09-04 P-006: a pull from a harness the workspace
    // policy excludes is refused at the door — the work stays filed, never deleted.
    {
      const { gateWorkScope, workScopeRefusal } = await import('../../work-scope-policy');
      const scope = await gateWorkScope('scheduler:get_next', { harness: args.harness, actor: ident.ownerId });
      if (!scope.allowed) {
        return {
          content: [
            { type: 'text' as const, text: JSON.stringify(workScopeRefusal(scope, { tool: 'scheduler:get_next' })) },
          ],
        };
      }
    }
    // P-016: reconcile ALL incompatible pre-existing claims before the next
    // pickup. The sweep is batch-shaped (one pass, one leader alert), so a dead
    // lane cannot drip one stale claim per wake. Only fleet MEMBERS are scoped;
    // leaders supervise rather than consume the member lane.
    //
    // EI-20228674494907304: all of these reads precede the claim watchdog. Run them under one
    // shared budget so a pool stall in any preflight leg cannot leave the MCP request silent for
    // 300s. A single budget also prevents four sequential 30s leg budgets from stretching the
    // caller's failure window to 120s. The timeout fallback is deliberately fail-closed: without
    // a resolved fleet scope it is unsafe to continue into the generic claim path.
    type PreflightState =
      | {
          /** WI-5940: caller is at CRITICAL context pressure — serve a compact-first verdict. */
          kind: 'context-critical';
          refusal: ReturnType<typeof contextCriticalRefusalResult>;
          /** P-009: the bucket that justified the refusal, carried out so the auto-bench
           *  decision runs on the SAME reading rather than re-reading pressure. */
          bucket: ContextPressureBucket | null;
        }
      | {
          /** WI-2092233: caller holds active GOAL-steward authority — serve a route-it-instead verdict. */
          kind: 'goal-steward';
          refusal: ReturnType<typeof goalStewardRefusalResult>;
        }
      | {
          kind: 'scoped-miss';
          reconciliation: Awaited<ReturnType<typeof reconcileFleetScopeClaims>>;
        }
      | {
          kind: 'paused';
          reconciliation: Awaited<ReturnType<typeof reconcileFleetScopeClaims>>;
          pause: Awaited<ReturnType<typeof readFleetPauseState>>;
        }
      | {
          kind: 'leader-unavailable';
          reconciliation: Awaited<ReturnType<typeof reconcileFleetScopeClaims>>;
        }
      | {
          /** A completed plan takes precedence over dead-leader recovery. */
          kind: 'plan-complete';
          reconciliation: Awaited<ReturnType<typeof reconcileFleetScopeClaims>>;
          planTerminality: import('../../scheduler/fleet-scope-admission').FleetScopePlanTerminality;
        }
      | {
          kind: 'plan-scope-missing';
          planSlug: string;
        }
      | {
          kind: 'ready';
          reconciliation: Awaited<ReturnType<typeof reconcileFleetScopeClaims>>;
          specOn: boolean;
          contendedPaths: string[];
        };
    let currentPreflightStep = 'context-pressure-flag';
    const preflightBudgetMs = remainingBudgetMs();
    const preflight = await withBoundedTimeout<PreflightState | null>(
      async () => {
        // WI-5940: refuse to SERVE a critical-context caller, with a compact-first verdict.
        //
        // FIRST inside the preflight, so it runs before any claim — the acceptance is "and no
        // item is claimed", and a check after the claim would already have taken the row.
        //
        // INSIDE this closure rather than above it, deliberately: these are two more pre-claim
        // reads, and the block comment above is the rule they have to obey — ONE shared budget.
        // Hoisting them out (the first way I wrote this) put two unbounded awaits in front of the
        // budget and broke the guard that exists to catch exactly that: `bounds the scheduler flag
        // read before any claim attempt` hung for 60s instead of returning the bounded timeout.
        // Giving them their own second budget would be just as wrong — that is the sequential-30s
        // stretch this comment forbids.
        //
        // The decision lives in `decideContextPressureGate` so this surface and
        // `work_items:claim_next` cannot drift apart — the failure mode `concurrencyBlockedRefusal`
        // records from WI-6409, where a refusal existed on one branch only.
        //
        // Fails OPEN: an unreadable flag or presence row leaves the bucket unknown and the pull
        // proceeds exactly as today. Withholding work on an unproven reading would manufacture the
        // false drain this gate exists to prevent (see the gate module's hazard note).
        currentPreflightStep = 'context-pressure-flag';
        const gateEnabled = await getFlag(FLAGS.SCHEDULER_CONTEXT_PRESSURE_GATE, ident.ownerId).catch(() => true);
        currentPreflightStep = 'context-pressure-read';
        const contextBucket = gateEnabled
          ? await fetchContextPressure([ident.ownerId])
              .then((m) => m.get(ident.ownerId) ?? null)
              .catch(() => null)
          : null;
        // EI-23744538757758407: headroom answers what `recovery` cannot — whether this caller's
        // soft limit is SATISFIABLE at all. A session whose fixed per-turn baseline already
        // exceeds it can never clear the band by compacting (a fresh context boots at the same
        // baseline), so it must be told to raise the limit instead of to discard its work.
        //
        // PARALLEL, and still inside the ONE shared budget this closure owns: the block comment
        // above forbids both hoisting these awaits out and giving them a second budget, so this
        // adds a concurrent leg rather than a sequential hop. Both fire only when already refusing.
        currentPreflightStep = 'context-recovery-headroom';
        const [contextRecovery, contextHeadroom] =
          contextBucket === 'critical' && rawArgs.ignoreContextPressure !== true
            ? await Promise.all([
                resolveContextPressureRecoveryPath(ident.ownerId, ident.workspaceId).catch(() => null),
                resolveContextPressureHeadroom(ident.ownerId).catch(() => null),
              ])
            : [null, null];
        const contextGate = decideContextPressureGate({
          bucket: contextBucket,
          override: rawArgs.ignoreContextPressure === true,
          enabled: gateEnabled,
          overrideArg: 'ignoreContextPressure',
          recovery: contextRecovery,
          headroom: contextHeadroom,
        });
        if (contextGate.refuse) {
          // P-009: the auto-bench is deliberately NOT armed here. This closure is the
          // SHARED bounded preflight budget, and arming a park needs two more IO ops
          // (wake-handle capture + registerAwait). D-009 upheld that instinct: wire the
          // bench to the existing park surface, do not open-code an await at this site.
          // The bench is registered on the refusal RETURN path below, where the claim
          // decision is already made and nothing is racing this budget.
          return {
            kind: 'context-critical',
            refusal: contextCriticalRefusalResult(contextGate),
            bucket: contextBucket,
          };
        }
        // WI-2092233: refuse to SERVE a caller holding active GOAL-steward authority — the GOAL
        // contract is categorical (the holder never implements; every execution unit is a
        // launched agent), and the filed breach is exactly a steward self-pull through this tool.
        // Same shared-decision shape as the context gate above so this surface and
        // `work_items:claim_next` cannot drift apart. Fails OPEN: an unreadable flag or authority
        // leaves the verdict unknown and the pull proceeds — withholding work on an unproven
        // reading would manufacture a false drain (see the gate module's hazard note).
        currentPreflightStep = 'goal-steward-flag';
        const stewardGateEnabled = await getFlag(FLAGS.SCHEDULER_GOAL_STEWARD_GATE, ident.ownerId).catch(() => true);
        // try/catch rather than .catch(): a synchronous getOrgPg() throw (no org pool in a
        // unit-test harness) must fail open too, not escape past the promise chain.
        let stewardAuthority = null as Awaited<ReturnType<typeof readGoalHolderAuthority>> | null;
        if (stewardGateEnabled && ident.workspaceId) {
          currentPreflightStep = 'goal-holder-authority';
          try {
            stewardAuthority = await readGoalHolderAuthority(getOrgPg().sql, ident.workspaceId, ident.ownerId);
          } catch {
            stewardAuthority = null;
          }
        }
        const stewardGate = decideGoalStewardGate({
          authority: stewardAuthority,
          enabled: stewardGateEnabled,
        });
        if (stewardGate.refuse) {
          return { kind: 'goal-steward', refusal: goalStewardRefusalResult(stewardGate) };
        }
        currentPreflightStep = 'fleet-scope-reconciliation';
        const reconciliation = await reconcileFleetScopeClaims({
          ownerId: ident.ownerId,
          workspaceId: ident.workspaceId,
          identity: ident,
        });
        if (reconciliation.scope?.record.source === 'default') {
          return { kind: 'scoped-miss', reconciliation };
        }
        // EI-12832: a paused fleet (control_state='winding-down') floors the SELECT side too —
        // a member woken during the pause must stand down, not pull the next item (even one
        // its spec matches). The by-id claim path is gated at admission; this closes the
        // self-select sibling seam with the same durable-control-state read.
        if (reconciliation.scope) {
          currentPreflightStep = 'fleet-pause-state';
          const pause = await readFleetPauseState(reconciliation.scope, ident.workspaceId);
          if (pause.windingDown) return { kind: 'paused', reconciliation, pause };
          // EI-22422975002985083: terminal plan work is already a successful
          // wind-down, even when the registered leader is no longer live. Check
          // this before routing the caller into fleet:take-leadership; a terminal
          // lane has nothing left for a replacement leader to drive.
          currentPreflightStep = 'fleet-plan-terminality';
          const planTerminality = await diagnoseFleetScopePlanTerminality({ scope: reconciliation.scope });
          if (planTerminality?.allTerminal) {
            return { kind: 'plan-complete', reconciliation, planTerminality };
          }
          // EI-21079515303301272: member self-pulls are leader-owned work. If the
          // registry/roster read proves there is no live leader, refuse BEFORE the
          // atomic claim instead of allowing members to continue into a lane whose
          // terminal acceptance and wind-down have no live driver. A null reading is
          // deliberately fail-open; only a successful negative blocks new work.
          currentPreflightStep = 'fleet-leader-liveness';
          const leaderLiveness = await diagnoseFleetScopeLeaderLiveness({
            scope: reconciliation.scope,
            ...(reconciliation.fleetAssignmentRows
              ? { fleetAssignmentRows: reconciliation.fleetAssignmentRows }
              : {}),
          });
          if (leaderLiveness === false) return { kind: 'leader-unavailable', reconciliation };
        }
        // SCHEDULER_SPEC_CLAIM kill-switch (default ON; fail-open): OFF ⇒ ignore the bee's stored
        // spec and claim by the DEFAULT ordering (a no-breakage degrade to claim_next behavior).
        // A fleet member is the exception: scope is a correctness boundary, not a feature
        // preference, so the kill-switch may disable scheduler steering but cannot widen a
        // member into the generic backlog.
        currentPreflightStep = 'scheduler-spec-flag';
        const specOn = await getFlag(FLAGS.SCHEDULER_SPEC_CLAIM, ident.ownerId).catch(() => true);
        // EI-21238986333755666: coord:declare-intent persists currentPlanSlug even for a
        // non-fleet caller, but the old default-spec path ignored it and let DEFAULT_CLAIM_SPEC
        // claim any harness row. Read the declaration and effective spec source in this bounded
        // preflight, then fail closed before getNextForBee whenever the effective pull would be
        // generic. An unreadable presence/spec read is deliberately fail-open here — without
        // positive evidence of a declared plan or a disabled spec path, do not invent a false
        // control-plane block for an otherwise valid solo pull.
        if (!reconciliation.scope) {
          currentPreflightStep = 'declared-plan-presence';
          const presence = await getPresence(ident.ownerId).catch(() => null);
          const declaredPlanSlug = presence?.currentPlanSlug?.trim() || null;
          if (declaredPlanSlug) {
            currentPreflightStep = 'declared-plan-claim-spec';
            const record = await getClaimSpecRecord({
              cupId: ident.ownerId,
              workspaceId: resolveClaimSpecWorkspace(ident.workspaceId),
            }).catch(() => null);
            const effectiveDefault = !specOn || record?.source === 'default';
            if (effectiveDefault) {
              currentPreflightStep = 'clear-stale-plan-declaration';
              const stalePlanCleared = await clearStaleTerminalPlanDeclaration({
                identity: ident,
                presence: { intent: presence?.intent },
                planSlug: declaredPlanSlug,
                harness: args.harness,
              });
              if (!stalePlanCleared) return { kind: 'plan-scope-missing', planSlug: declaredPlanSlug };
            }
          }
        }
        // P-015: authoritative lock-plane snapshot, holders only and excluding this
        // caller. Fail-soft is implemented by liveLockedPaths; cap the SQL parameter so
        // a pathological lock storm cannot inflate a claim request without bound.
        currentPreflightStep = 'live-lock-paths';
        const contendedPaths = (await liveLockedPaths({ excludeOwner: ident.ownerId })).slice(0, 500);
        return { kind: 'ready', reconciliation, specOn, contendedPaths };
      },
      { fallback: null, timeoutMs: preflightBudgetMs, label: 'scheduler:get_next:preflight' },
    );
    if (preflight.degraded || !preflight.value) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              getNextPreflightTimeoutResult(
                preflightBudgetMs,
                preflight.reason,
                preflight.errorMessage,
                currentPreflightStep,
              ),
            ),
          },
        ],
      };
    }
    const preflightState = preflight.value;
    // WI-5940: the compact-first verdict. Returned BEFORE every claim path below, so the
    // filing's "and no item is claimed" holds by construction rather than by inspection.
    if (preflightState.kind === 'context-critical') {
      // P-009: park the refused member so a critical-context refusal converges instead of
      // spinning. Before this, a refused member was told to compact and left to re-pull on
      // its own, and NOTHING observed whether it ever came back — the member's own loop
      // simply re-fired into the same refusal. The bench makes the park visible to the
      // leader (fleet:bench { list:true } / leader-brief) and gives it a deadline.
      //
      // Wake key: `session:compacted:<owner>`. It is the member's OWN recovery condition —
      // it was refused because its context is critical, and compaction is what fixes that.
      // It also cannot self-defeat the park, which is why the two obvious keys were
      // rejected (D-009): `work-item:claimable` re-wakes immediately because the member
      // pulled BECAUSE work exists, and the fleet `controlResumeGate` is null on an active
      // fleet, so benching on it is a no-op dressed as a feature.
      //
      // FAIL-SOFT, always: the refusal is the load-bearing behaviour and ships unchanged
      // whether or not the bench registers. A bench failure must never convert a clean
      // compact-first verdict into an error.
      const benchOutcome = await autoBenchContextCriticalCallerCore(
        { ownerId: ident.ownerId, bucket: preflightState.bucket },
        {
          listParkedAwaitsForSubscribers: listParkedAwaitsForSubscribersStore,
          registerBenchPark,
          captureWakeHandleForOwner: captureWakeHandleForOwnerStore,
          registerAwait: registerAwaitStore,
        },
      );
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ ...preflightState.refusal, ...(benchOutcome ? { bench: benchOutcome } : {}) }),
          },
        ],
      };
    }
    // WI-2092233: the route-it-instead verdict for an active GOAL steward. Returned BEFORE every
    // claim path below, so "and no item is claimed" holds by construction.
    if (preflightState.kind === 'goal-steward') {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(preflightState.refusal) }],
      };
    }
    if (preflightState.kind === 'scoped-miss') {
      const { reconciliation } = preflightState;
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              fleetScopedMiss(reconciliation.scope!, reconciliation.quarantinedIds, { harness: args.harness }),
            ),
          },
        ],
      };
    }
    if (preflightState.kind === 'paused') {
      const { reconciliation, pause } = preflightState;
      // EI-15777: a member parked on `events:await('work-item:claimable')` from
      // BEFORE the pause is otherwise still woken by a peer's compliant
      // stand-down release (the admission gate only refuses the CLAIM, not the
      // wake itself) — a full session-resume cycle wasted every time, the
      // "post-mission wake churn" this closes. Retire the caller's own standing
      // claimable await(s) right here so no future release re-wakes them for a
      // pull they're forbidden to make anyway. Self/subscriber-scoped + best-effort,
      // same posture as the successful-claim cancel below.
      const claimableAwaitsCancelled = await cancelClaimableAwaits(ident.ownerId).catch(() => 0);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              fleetScopedMiss(reconciliation.scope!, reconciliation.quarantinedIds, {
                pausedReason: pause.reason,
                claimableAwaitsCancelled,
                harness: args.harness,
              }),
            ),
          },
        ],
      };
    }
    if (preflightState.kind === 'leader-unavailable') {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(fleetLeaderUnavailableRefusal(preflightState.reconciliation.scope!)),
          },
        ],
      };
    }
    if (preflightState.kind === 'plan-complete') {
      const { reconciliation, planTerminality } = preflightState;
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              fleetScopedMiss(reconciliation.scope!, reconciliation.quarantinedIds, {
                planTerminality,
                harness: args.harness,
              }),
            ),
          },
        ],
      };
    }
    if (preflightState.kind === 'plan-scope-missing') {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(planScopeMissingRefusal(preflightState.planSlug, ident.ownerId, args.harness)),
          },
        ],
      };
    }
    const { reconciliation, specOn, contendedPaths } = preflightState;
    // P-004 / D-002 (D-007 hybrid): scheduler:get_next is the primary self-pull surface,
    // so its local claim must be arbitrated by the same per-Hive lease as claim_next. Without
    // this bridge the handler could return committed:true while no work_item_claims row existed,
    // allowing another Swarm to receive the same item on its next pull (WI-39730).
    const leaseOn = workItemClaimLeaseEnabled();
    const arbitrateSchedulerClaim = async <T extends Awaited<ReturnType<typeof getNextForBee>>>(
      candidate: T,
    ): Promise<T> => {
      if (!candidate || !leaseOn) return candidate;
      const leased = await leaseClaimedWorkItem({
        harness: args.harness,
        workItemId: candidate.workItem.id,
        owner: ident.ownerId,
      });
      if (leased) return candidate;
      // The local claim is already committed when the authority lease loses. Release it before
      // treating this as a miss; otherwise the local row remains assigned without a durable
      // lease and can be stranded until the normal stale-claim sweep.
      await releaseWorkItem(candidate.workItem.id, {
        harness: args.harness,
        expectedAssignee: ident.ownerId,
      });
      return null as T;
    };
    // EI-18167154191955470: the atomic claim is the heaviest single DB op in this path — an
    // UPDATE ... FOR UPDATE SKIP LOCKED that must acquire both a pool connection and a row lock,
    // the most likely place to block under PG pool saturation. Bound it so a stall fails FAST
    // with a clean, retryable error instead of the observed failure mode: a silent 300s hang,
    // aborted by the MCP client idle-timeout, whose immediate retry then succeeded in ~2s.
    // NOTE (see withBoundedTimeout's own doc): this is a Promise.race and does NOT cancel the
    // query, so a claim UPDATE that commits in the background AFTER the deadline is a possible
    // orphan — but that orphan is self-healing (reconcileFleetScopeClaims + the lease reclaim
    // run at the TOP of the very next get_next sweep it) AND it already existed under today's
    // 300s hang; we only fail faster. A real throw is re-surfaced loudly, never a silent miss.
    // WI-7316: the post-claim plan-lane bounce is the ONE miss cause every other diagnosis on
    // this path is structurally blind to. getNextForBee CLAIMS a row, runs planItemLaneBlockReason,
    // finds it blocked, releases it and retries — so by the time we build a miss, the SQL floors
    // have already counted that row as claimable and nothing anywhere records why it was refused.
    // `onPlanLaneBlocked` (claim-spec-store.ts) hands us each bounce as it happens; we keep only
    // the ones whose plan item carries a `staleBlockedHint` — a CONTRADICTION the resolver can
    // see (canonically a sticky stored 'blocked' token whose every blocked-by dependency has
    // already resolved) but cannot safely auto-clear. That distinction is what makes this worth
    // reporting: an ordinary block self-clears when its blocker lifts, so "re-poll and wait" is
    // correct advice for it; a stale token clears only when a human runs plans:set-status, so the
    // same advice sends a member into an idle-park on a lane that can never clear itself.
    //
    // Collected across ALL THREE getNextForBee calls below (initial claim + the two recheck
    // retries) — a bounce on a retry is the same evidence as one on the first pull.
    const planLaneBounces: StaleBlockedLaneRow[] = [];
    const onPlanLaneBlocked = (block: {
      workItemId: string;
      planSlug: string;
      itemId: string;
      staleBlockedHint: string | null;
    }): void => {
      if (!block.staleBlockedHint) return;
      // De-dupe by work-item: the divergence recheck can legitimately re-claim and re-bounce the
      // same row, and reporting it twice would inflate the count a caller reads as a row count.
      if (planLaneBounces.some((b) => b.workItemId === block.workItemId)) return;
      planLaneBounces.push({
        workItemId: block.workItemId,
        planSlug: block.planSlug,
        itemId: block.itemId,
        hint: block.staleBlockedHint,
      });
    };
    const claimBudgetMs = remainingBudgetMs();
    const claim = await withBoundedTimeout(
      (signal) =>
        getNextForBee({
          cupId: ident.ownerId,
          onPlanLaneBlocked,
          // EI-21830839826880925: ordinary MCP reads can occupy every slot on the
          // process-wide org pool. Keep pickup on its own tiny transactional pool so a
          // fleet member does not spend the whole 30s claim budget waiting behind them.
          useDedicatedClaimPool: true,
          // WI-1564: MUST match the partition scheduler:set_claim_spec writes
          // (same resolveClaimSpecWorkspace helper) — a reader left on 'default'
          // while the queen writes the workspace partition (or a federated spec
          // arrives under the booted workspace) silently falls back to
          // DEFAULT_CLAIM_SPEC and the steer never lands.
          workspaceId: resolveClaimSpecWorkspace(ident.workspaceId),
          harness: args.harness,
          heldPaths: args.heldPaths,
          contendedPaths,
          states: args.states,
          rigAvailable: args.rigAvailable,
          ignoreStoredSpec: !specOn && !reconciliation.scope,
          // P-006 (fleet-leader-frictions-six-improvements-2026-07-10, WI-3763): this is
          // THE live fleet-member self-pull surface — a miss here is the real "claim-spec
          // view is empty" signal a fleet leader wants pushed, so opt in.
          checkIdleDrainOnMiss: true,
          signal,
        }),
      // fallback:null is a type-correct member of getNextForBee's return (`... | null`) and is
      // NEVER read — we branch on `claim.degraded` before ever touching `claim.value`.
      { fallback: null, timeoutMs: claimBudgetMs, label: 'scheduler:get_next:claim', signal: ctx.signal },
    );
    // A genuine underlying error surfaces loudly (preserving today's behavior where a thrown
    // getNextForBee propagates), never degraded into a false "no claimable work" miss. Typed
    // PostgreSQL contention is the exception: it is a bounded, retryable condition and must
    // not become a generic `handler_error` that strands the fleet pull loop (EI-20224136729541724).
    if (claim.degraded && claim.reason === 'error') {
      if (claim.error instanceof OrgTxnTimeoutError) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(getNextContentionResult(claim.error)) }],
        };
      }
      throw new Error(claim.errorMessage ?? 'scheduler:get_next claim failed');
    }
    // Budget exceeded: return the fast, retryable timeout miss instead of hanging to the abort.
    if (claim.degraded) {
      // EI-22737570207805341: withBoundedTimeout is a Promise.race and does not cancel the
      // abandoned claim. The resolver can therefore commit after this watchdog fires. Read the
      // caller's held rows before responding, but preserve UNKNOWN when that read fails or also
      // times out — an empty/failed observation is never proof that no claim exists.
      const reconciliationBudgetMs = remainingBudgetMs(GET_NEXT_TIMEOUT_RECONCILIATION_BUDGET_MS);
      const reconciliation = await withBoundedTimeout(
        readClaimConcurrency({
          cupId: ident.ownerId,
          workspaceId: resolveClaimSpecWorkspace(ident.workspaceId),
        }),
        {
          fallback: null,
          timeoutMs: reconciliationBudgetMs,
          label: 'scheduler:get_next:timeoutReconciliation',
        },
      );
      const timeoutReconciliation: ClaimTimeoutReconciliation =
        reconciliation.degraded || !reconciliation.value
          ? { status: 'unknown', heldIds: [] }
          : {
              status: reconciliation.value.heldIds.length > 0 ? 'held' : 'none-observed',
              heldIds: reconciliation.value.heldIds,
            };
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(getNextTimeoutResult(claimBudgetMs, timeoutReconciliation)),
          },
        ],
      };
    }
    let res = await arbitrateSchedulerClaim(claim.value);
    let retiredSoloPlanSpec: { planSlug: string; specId: string; revision: number; cleared: boolean } | undefined;
    // WI-6409: a caller at its CONCURRENCY CAP never had the lane evaluated — getNextForBee
    // short-circuits before the claim query (EI-12095) — so this miss says NOTHING about pool
    // admissibility. Answer it here, for EVERY caller, before the divergence machinery runs.
    //
    // This check used to exist only inside `buildMissDiagnosis`, which line ~839 skips entirely
    // when `reconciliation.scope` is set — i.e. it never ran for a FLEET MEMBER, whose miss is
    // routed to `fleetScopedMiss` instead. The result was a confident false verdict on the branch
    // every fleet member takes: "CLAIM-PATH/READ-PATH DIVERGENCE … 232 of 411 rows pass every
    // floor … this is an internal inconsistency in the claim path's own spec narrowing", with
    // advice to file a claim-path bug and "do not stand down". Reproduced live on this fleet
    // 2026-08-09 with the pool held constant (see concurrencyBlockedRefusal's doc comment).
    //
    // Placed BEFORE the WI-5947 re-check on purpose, for two reasons:
    //  1. CORRECTNESS — the re-check re-runs the same cap-blocked claim, so it can only ever
    //     return `divergenceRecheck:"confirmed-twice"`. The mechanism meant to distinguish a real
    //     defect from lane churn is, for this cause, guaranteed to affirm. Running it first would
    //     dress the false verdict in its strongest possible evidence.
    //  2. COST — it also avoids a second claim attempt plus two full oracle reads per capped pull,
    //     on the path a saturated fleet hits most often.
    // Fails SOFT (a read error leaves `res` null and the ordinary miss reporting stands): a
    // diagnosis must never become a new way for the claim path to fail.
    if (!res) {
      const capRec = await getClaimSpecRecord({
        cupId: ident.ownerId,
        workspaceId: resolveClaimSpecWorkspace(ident.workspaceId),
      }).catch(() => null);
      const capped = await readClaimConcurrency({
        cupId: ident.ownerId,
        workspaceId: resolveClaimSpecWorkspace(ident.workspaceId),
        maxConcurrentClaims: capRec?.spec.limits?.maxConcurrentClaims,
      }).catch(() => null);
      if (capped?.blocked) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ ok: false, ...concurrencyBlockedRefusal(capped) }),
            },
          ],
        };
      }

      // EI-22773843177950284: plans:start binds a SOLO starter to one exact plan,
      // but nothing retired that per-owner row after the plan shipped. Every later
      // claimable wake re-ran the same terminal filter, missed, and re-parked forever.
      // Repair on MISS only (zero cost on successful pulls), and only for the exact
      // plans:start-authored shape above. Fleet specs remain leader-owned and keep
      // their existing explicit retired-plan diagnosis/re-steer semantics.
      const boundPlan =
        specOn && !reconciliation.scope && capRec?.source === 'cup' ? plansStartExactPlanBinding(capRec.spec) : null;
      if (boundPlan && capRec?.revision !== null && capRec?.revision !== undefined) {
        const terminality = await import('../plans/source')
          .then((m) =>
            m.planTerminalityInWorkspace(
              resolveClaimSpecWorkspace(ident.workspaceId) ?? DEFAULT_COORD_WORKSPACE,
              boundPlan,
            ),
          )
          .catch(() => null);
        if (terminality?.status === 'shipped' || terminality?.status === 'superseded') {
          const cleared = await clearClaimSpec({
            cupId: ident.ownerId,
            workspaceId: resolveClaimSpecWorkspace(ident.workspaceId),
            expectedHead: { specId: capRec.spec.specId, revision: capRec.revision },
          }).catch(() => null);
          if (cleared) {
            retiredSoloPlanSpec = {
              planSlug: boundPlan,
              specId: capRec.spec.specId,
              revision: capRec.revision,
              cleared: cleared.cleared,
            };
            // `cleared:false` means the compare-and-delete lost to a concurrent
            // re-steer (or another cleaner). Re-resolve either way: the stale head
            // we inspected is no longer authoritative, and the new/default spec may
            // have work immediately available.
            const retryBudgetMs = remainingBudgetMs();
            const retry = await withBoundedTimeout(
              (signal) =>
                getNextForBee({
                  cupId: ident.ownerId,
                  onPlanLaneBlocked,
                  useDedicatedClaimPool: true,
                  workspaceId: resolveClaimSpecWorkspace(ident.workspaceId),
                  harness: args.harness,
                  heldPaths: args.heldPaths,
                  contendedPaths,
                  states: args.states,
                  rigAvailable: args.rigAvailable,
                  checkIdleDrainOnMiss: true,
                  signal,
                }),
              {
                fallback: null,
                timeoutMs: retryBudgetMs,
                label: 'scheduler:get_next:retiredSoloPlanRetry',
                signal: ctx.signal,
              },
            );
            if (!retry.degraded && retry.value) res = await arbitrateSchedulerClaim(retry.value);
          }
        }
      }
    }
    // WI-5947: RE-CONFIRM before letting a divergence verdict be pronounced.
    //
    // `fleetScopedMiss` reports CLAIM-PATH/READ-PATH DIVERGENCE when the claim above returned
    // nothing while the shared oracle reports claimable > 0. Those are two observations at two
    // DIFFERENT INSTANTS against a table the whole fleet is mutating: any row that becomes
    // claimable in the window between them (a peer releasing, a claim-hold lapsing, a detector
    // filing a new bug) makes a perfectly healthy miss look like a narrowing defect. The verdict
    // is not merely noisy — its advice INSTRUCTS the reader to file a claim-path bug in the
    // EI-10062 / WI-4309 / WI-5275 / WI-5822 class and calls the breakdown "the reproduction",
    // so a member following its tooling correctly files a fabricated bug against healthy code.
    // Observed live 2026-07-26 05:18Z on fleet nonp2p-bug-drain-0725 during a 0->2->4 claimable
    // burst; the claim path was correct throughout.
    //
    // The ground truth for "can the claim path actually select a row" is the CLAIM PATH, asked
    // again — not a second read. So on a would-be-divergent miss we retry the claim exactly once:
    //   - it succeeds  => the miss was a race, and the caller gets the work it came for (this is
    //                     the common case, and it is strictly better than any error message);
    //   - it misses    => re-read the breakdown; only if that STILL reports survivors do we let
    //                     the divergence stand, now attested across two claim attempts.
    // Placed HERE, before every `res?.workItem`-gated enrichment below, so a retry that lands
    // flows through the ordinary success path unchanged (recall port, checkpoint hint, await
    // cancellation) — there is no second, divergent success path to keep in sync.
    //
    // Cost is confined to the rare miss-with-survivors case: a normal drained miss (claimable
    // === 0, the overwhelmingly common shape) never enters this block and pays nothing.
    let issueBreakdown: import('../../scheduler/get-next').IssueClaimExclusionBreakdown | null = null;
    let divergenceRecheck: 'resolved-by-retry' | 'confirmed-twice' | undefined;
    // WI-7151 (EI-19318364531323846): the tier-1 (feature-family) match count, computed ONLY
    // when the issue-family breakdown would otherwise certify a false `spec_matches_nothing` —
    // see diagnoseFleetScopeFeatureFamilyMatch's doc comment. Left null for every other miss
    // shape (zero extra cost on the common paths).
    let featureFamilyMatched: number | null = null;
    let terminalExhaustion: import('../../scheduler/fleet-scope-admission').FleetScopeTerminalExhaustion | null = null;
    let planTerminality: import('../../scheduler/fleet-scope-admission').FleetScopePlanTerminality | null = null;
    let leaderLiveness: boolean | null = null;
    const diagnoseIssueFloorMissWithinBudget = async () => {
      const budgetMs = remainingBudgetMs(GET_NEXT_ISSUE_DIAG_BUDGET_MS);
      const diagnosis = await withBoundedTimeout(
        diagnoseFleetScopeIssueFloorMiss({
          scope: reconciliation.scope!,
          harness: args.harness,
          workspaceId: ident.workspaceId,
          states: args.states,
          rigAvailable: args.rigAvailable,
          totalBudgetMs: budgetMs,
        }),
        {
          fallback: null,
          timeoutMs: budgetMs,
          label: 'scheduler:get_next:issueFloorMiss',
        },
      );
      return diagnosis.value;
    };
    if (!res && reconciliation.scope) {
      issueBreakdown = await diagnoseIssueFloorMissWithinBudget();
      if (issueBreakdown && issueBreakdown.claimable > 0) {
        const divergenceBudgetMs = remainingBudgetMs();
        const retry = await withBoundedTimeout(
          (signal) =>
            getNextForBee({
              cupId: ident.ownerId,
              onPlanLaneBlocked,
              // EI-22708243422971631: retries are still claim-path work. Keep them on the
              // scheduler-only pool too; otherwise miss diagnosis can move the second claim
              // onto the contended process-wide pool and consume the remaining handler budget.
              useDedicatedClaimPool: true,
              workspaceId: resolveClaimSpecWorkspace(ident.workspaceId),
              harness: args.harness,
              heldPaths: args.heldPaths,
              contendedPaths,
              states: args.states,
              rigAvailable: args.rigAvailable,
              ignoreStoredSpec: !specOn && !reconciliation.scope,
              checkIdleDrainOnMiss: true,
              signal,
            }),
          {
            fallback: null,
            timeoutMs: divergenceBudgetMs,
            label: 'scheduler:get_next:divergenceRecheck',
            signal: ctx.signal,
          },
        );
        // A degraded retry (timeout/error) proves nothing either way — leave the original
        // breakdown in place and let the miss report itself exactly as it would have.
        if (!retry.degraded && retry.value) {
          res = await arbitrateSchedulerClaim(retry.value);
          divergenceRecheck = 'resolved-by-retry';
        } else if (!retry.degraded) {
          // Still nothing claimable to the claim path. Take a FRESH reading: if the pool moved
          // on (the racing row is now taken), this collapses to an ordinary floor-gated miss.
          const recheck = await diagnoseIssueFloorMissWithinBudget();
          if (recheck) issueBreakdown = recheck;
          if (recheck && recheck.claimable > 0) divergenceRecheck = 'confirmed-twice';
        }
      } else if (issueBreakdown && issueBreakdown.matchedByFilter === 0) {
        // WI-7151: the issue-family breakdown reports a confident zero — but it is
        // STRUCTURALLY blind to the feature family (bug/change/task only). Check tier-1
        // before letting this certify a false `spec_matches_nothing` (e.g. a plan-scoped
        // spec whose promoted items are feature-family, per D-009).
        [featureFamilyMatched, terminalExhaustion, planTerminality, leaderLiveness] = await Promise.all([
          diagnoseFleetScopeFeatureFamilyMatch({
            scope: reconciliation.scope,
            harness: args.harness,
            workspaceId: ident.workspaceId,
            states: args.states,
            rigAvailable: args.rigAvailable,
          }),
          diagnoseFleetScopeTerminalExhaustion({
            scope: reconciliation.scope,
            harness: args.harness,
            workspaceId: ident.workspaceId,
          }),
          diagnoseFleetScopePlanTerminality({ scope: reconciliation.scope }),
          diagnoseFleetScopeLeaderLiveness({
            scope: reconciliation.scope,
            ...(reconciliation.fleetAssignmentRows
              ? { fleetAssignmentRows: reconciliation.fleetAssignmentRows }
              : {}),
          }),
        ]);
        if (featureFamilyMatched && featureFamilyMatched > 0) {
          // A genuine tier-1 candidate exists even though the claim (which just queried
          // this exact table) missed moments ago — retry once, same shape as the
          // claimable>0 divergence recheck above.
          const featureRecheckBudgetMs = remainingBudgetMs();
          const retry = await withBoundedTimeout(
            (signal) =>
              getNextForBee({
                cupId: ident.ownerId,
                onPlanLaneBlocked,
                // EI-22708243422971631: the feature-family retry has the same claim-path
                // contention risk as the divergence retry above.
                useDedicatedClaimPool: true,
                workspaceId: resolveClaimSpecWorkspace(ident.workspaceId),
                harness: args.harness,
                heldPaths: args.heldPaths,
                contendedPaths,
                states: args.states,
                rigAvailable: args.rigAvailable,
                ignoreStoredSpec: !specOn && !reconciliation.scope,
                checkIdleDrainOnMiss: true,
                signal,
              }),
            {
              fallback: null,
              timeoutMs: featureRecheckBudgetMs,
              label: 'scheduler:get_next:featureFamilyRecheck',
              signal: ctx.signal,
            },
          );
          if (!retry.degraded && retry.value) {
            res = await arbitrateSchedulerClaim(retry.value);
            featureFamilyMatched = null; // claimed on retry — nothing left to explain
          }
        }
      } else if (!issueBreakdown) {
        // EI-22179902813950215: diagnoseFleetScopeIssueFloorMiss FAILS SOFT (returns null) on
        // any query error/timeout — by design, a diagnosis must never turn a clean miss into a
        // thrown error. But every diagnosis gated on it above — including plan terminality,
        // whose OWN read (diagnoseFleetScopePlanTerminality) does not query the issue-floor
        // breakdown at all — silently goes unset when that happens, collapsing a genuine
        // plan-complete wind-down into the least-informative generic "no claimable work-item
        // matched fleet scope" miss on the very next retry against an UNCHANGED terminal plan
        // (observed live: two scheduler:get_next calls ~4 minutes apart, same claim spec, same
        // terminal plan — the first correctly reported `reason:"plan_complete"` with stand-down
        // advice, the second reported the generic miss and told the member to park a
        // work-item:claimable await that a terminal plan can never satisfy). Recompute the
        // plan-terminality signal here on its own; it fails soft to null exactly like every
        // other diagnosis in this block, so a caller with no plan predicate (or a
        // further-degraded read) pays one cheap extra query for nothing worse than today's
        // behavior.
        planTerminality = await diagnoseFleetScopePlanTerminality({ scope: reconciliation.scope });
      }
    }
    // EI-8579: a self-puller with NEITHER a per-bee NOR an inherited fleet spec resolves to
    // DEFAULT_CLAIM_SPEC with its built-in p2p/federation safety fence. It can still draw
    // owner-deferred work (a paused/de-scoped category) that a curated spec would exclude.
    // Advisory only (the claim already happened): nudge the caller to set its own spec,
    // same non-blocking posture as set_claim_spec's EI-6079 wakeability warning.
    const warning =
      res && res.specSource === 'default'
        ? 'You have no per-bee or fleet claim spec — this claim used DEFAULT_CLAIM_SPEC with the built-in p2p/federation safety fence, but it can still hand you owner-deferred work (e.g. a paused/de-scoped category). Consider scheduler:set_claim_spec {cupId: you} to scope your own pulls.'
        : undefined;
    // EI-8809 (routing-gate hint at dispatch): most items are already stamped
    // payload.routingHint at creation (work_items:create / plans:promote); this is
    // the render-time FALLBACK for an item created before that wiring landed.
    // Hint only — never blocks, never overrides a stamped value.
    let routingHint: unknown;
    let freshness: ClaimFreshnessVerdict | null = null;
    if (res?.workItem) {
      const wi = res.workItem as { kind?: string; title?: string; summary?: string; payload?: unknown };
      const existing =
        wi.payload && typeof wi.payload === 'object' && !Array.isArray(wi.payload)
          ? (wi.payload as Record<string, unknown>).routingHint
          : undefined;
      routingHint = existing ?? matchRoutingGateHint(wi.title) ?? undefined;
      // EI-20264587083609474: this was `wi.kind === 'bug'`, one of THREE independent
      // copies of the freshness policy — STAMP (`issues-engineer.createIssue`), this
      // SCORE site, and MEASURE (the source-generation leg below). All three now
      // consult the SAME predicate. (This comment said "two" until WI-2145579: the
      // original fix missed the MEASURE copy, which left a `change` claim holding a
      // verdict whose only item-specific axis was never computed.)
      // `change` is the repo's default kind for a
      // code edit, so it is exactly as susceptible to "already built" as a bug —
      // measured on that item, half the already-built evidence its filer cited was a
      // `change`, and this gate is why a `change` claimant was told nothing.
      if (isFreshnessTrackedKind(wi.kind)) {
        const build = getBuildInfo();
        // EI-22283949842250645: `headSha` was ALSO fed `build.sha` here, which is the
        // RUNTIME identity — so the freshness scorer's two axes received one value and
        // its source axis ("has this been fixed in the tree since it was reported?")
        // compared a value against itself and always affirmed. The source axis is now
        // measured path-scoped in the bounded enrichment tail below; until that lands
        // it is declared UNMEASURED rather than affirmed, so a timed-out tail degrades
        // to an honest "not checked" instead of back to the false "matches current".
        freshness = assessClaimFreshness(wi.payload, {
          headSha: null,
          runtimeSha: build.sha,
          runtimeVersion: build.version,
          sourceSignal: { kind: 'unmeasured', reason: 'source generation not yet measured' },
        });
      }
    }
    /**
     * EI-21834503221873518: every advisory read and idle->working side effect below runs
     * AFTER the atomic claim has committed. Before this guard, a single post-claim read
     * (memory, checkpoint/prior-work, or one of the parallel claim-time hints) could hang
     * until the MCP client's ~60s dispatch deadline, leaving the caller unable to reconcile
     * the committed claim and likely to retry a destructive self-select.
     *
     * Keep ONE remaining-deadline guard around the whole successful-claim tail, rather than
     * stacking per-leg budgets: several individually "bounded" reads can still exceed the
     * transport deadline in aggregate. `withBoundedTimeout` also swallows late rejection from
     * the abandoned advisory promise, so the handler returns the committed claim receipt even
     * when a backing read never settles. The enrichment variables intentionally remain
     * fail-soft/nullable; a timed-out advisory tail only omits optional hints.
     */
    /*
     * ⚠ Every enrichment variable below is written INSIDE `enrichSuccessfulClaim`, which is
     * handed to `withBoundedTimeout` as a VALUE rather than called inline. TypeScript's control
     * flow analysis does not follow writes through that boundary, so with the ordinary
     * `let x: T | null = null` form CFA narrows each one to exactly `null` at every read below.
     * The reads then use `x?.prop`, optional chaining short-circuits the whole `null` type away,
     * and the remainder is `never` — which is why this file collected a run of
     * "Property 'prop' does not exist on type 'never'" errors that describe nothing wrong at
     * runtime (the enrichment is awaited before the payload is assembled).
     *
     * Writing the initializer as `null as T | null` makes the ASSIGNED expression carry the full
     * union, so CFA narrows to `T | null` — the declared type — instead of to `null`. It is a
     * widening of the initializer only: a genuinely wrong property access is still an error
     * (proved with a `@ts-expect-error` control, so this cannot silently rot into `any`).
     *
     * Do NOT "fix" this by restructuring the writes into a return value. The write-into-closure
     * shape is deliberate and load-bearing: `withBoundedTimeout` may abandon the tail, and the
     * contract (see the comment above) is that whatever landed before the deadline is KEPT while
     * the rest stay null. A return value would discard partial enrichment on timeout.
     */
    let memory = null as string | null;
    let checkpointHint = null as import('../../work-item-checkpoint').ClaimTimeCheckpointHint | null;
    let checkpointReadFailed = false as boolean;
    let priorWorkHint = null as { priorWork: unknown; priorWorkWarning: string } | null;
    const bgJobWarning: { detected: boolean; reason?: string } = { detected: false };
    let planDecisions = null as import('../../plan-decisions-claim-port').ClaimTimePlanDecisionsBrief | null;
    let planDecisionsNote = null as string | null;
    let priorAttemptBrief: unknown = null;
    let premises = null as import('../../premises-claim-port').ClaimTimePremisesBrief | null;
    let retractionWarning = null as string | null;
    let authorshipRevalidationHint = null as {
      authorshipRevalidation: unknown;
      authorshipRevalidationWarning: string;
    } | null;
    let planContradictionHint = null as {
      planItemContradiction: unknown;
      planItemContradictionWarning: string;
    } | null;
    let behaviorContractHint = null as {
      behaviorContract: unknown;
      behaviorContractNote: string;
    } | null;
    let pathHintsHint = null as import('../../stale-path-hints-claim-port').ClaimTimeStalePathAdvisory | null;
    let planItemLandedHint = null as {
      planItemLanded: unknown;
      planItemLandedWarning: string;
    } | null;
    let siblingPathOverlapHint = null as {
      siblingPathOverlap: unknown;
      siblingPathOverlapWarning: string;
    } | null;
    let sourceCitationHint = null as {
      sourceCitation: unknown;
      sourceCitationWarning: string;
    } | null;
    // EI-22344661292350991: explicit, report-only independence enrichment. The claim is
    // already committed; this advisory must never reject/release it or make the self-pull
    // path depend on a successful lineage lookup.
    let independenceHint = null as import('../../independence-claim-port').ClaimTimeIndependenceAdvisory | null;
    // EI-22283949842250645: the measured source axis for the freshness verdict above.
    // Lives in the bounded tail because it costs one `git log` per cited path; a
    // timeout leaves the verdict at its honest "unmeasured" rather than affirming.
    let sourceGenerationSignal = null as import('../../work-item-claim-freshness').SourceGenerationSignal | null;

    const enrichSuccessfulClaim = async (): Promise<void> => {
      // Claim-time recall port (memory-delivery-unification-2026-07-12 P-008 /
      // D-006): on a hit, piggyback a targeted memory recall for the claimed
      // item — deadline-bounded, epoch-deduped (port 'claim'), never-throws.
      // This is THE live fleet-member self-pull surface, so it's the port that
      // matters most. Dynamic import keeps the memory chain off the static graph.
      if (res?.workItem) {
        const wi = res.workItem as { id?: string; title?: string; summary?: string; harness?: string | null };
        memory = await import('../../memory/claim-port')
          .then((m) =>
            m.buildClaimRecallBlock({ sessionId: ident.ownerId, workspaceId: ident.workspaceId, items: [wi] }),
          )
          .catch(() => null);
      }
      // EI-529: this is the primary self-pull surface (every fleet member / cup claims
      // through it) — surface a prior holder's checkpoint AT CLAIM TIME so a re-dispatch
      // after a dead/quiet session doesn't silently re-implement already-shipped work.
      // Omitted entirely when null (the common case: no prior holder ever checkpointed).
      if (res?.workItem) {
        const wi = res.workItem as { id: string; harness?: string | null };
        checkpointHint = await import('../../work-item-checkpoint')
          .then((m) =>
            m.getClaimTimeCheckpointHint({
              harness: wi.harness ?? null,
              workItemId: wi.id,
              workspaceId: ident.workspaceId ?? undefined,
            }),
          )
          .catch(() => {
            checkpointReadFailed = true;
            return null;
          });
      }
      // P-001/P-004 (fleet-leadership-continuity-and-actuation-2026-08-01): the prior-work banner,
      // wired here too. P-001 named THREE surfaces — work_items:claim, work_items:get and THIS one —
      // but only the first two got it, which left the biggest hole of the three: get_next is the
      // primary SELF-PULL surface every fleet member and cup claims through, so an
      // already-worked-but-checkpoint-less item was still indistinguishable from fresh work on the
      // path most agents actually take. (P-004's cross-surface test is what surfaced the omission —
      // it exists precisely because a guard wired into some-but-not-all read surfaces looks done.)
      // Escalates its wording when NO checkpoint exists, since that is the case no other guard here
      // can catch. Fail-soft + omitted entirely when null, exactly like the checkpoint hint above.
      if (res?.workItem) {
        const wi = res.workItem as { id: string; harness?: string | null };
        priorWorkHint = await import('../../work-item-prior-work')
          .then(async (m) => {
            const raw = await m.getClaimTimePriorWorkHint({
              harness: wi.harness ?? null,
              workItemId: wi.id,
              workspaceId: ident.workspaceId ?? undefined,
              currentClaimant: ident.ownerId,
            });
            if (!raw) return null;
            const priorWork = {
              ...raw,
              // WI-6737: never assert absence from a read that never ran.
              hasCheckpoint: checkpointReadFailed ? ('unknown' as const) : checkpointHint != null,
            };
            const warning = m.priorWorkWarning(priorWork);
            return warning ? { priorWork, priorWorkWarning: warning } : null;
          })
          .catch(() => null);
      }
      // EI-18654296679612119: a SEPARATE, CONDITIONAL warning — only when the checkpoint text
      // itself cites a background job/task as evidence — rather than growing the EI-529
      // checkpointWarning below unconditionally (which would fire on every checkpointed claim,
      // background job or not). See checkpoint-bg-job-claim.ts for why this can't be a live PID
      // check here (a claimant may be on a different host/process than the checkpoint's writer).
      if (checkpointHint) {
        Object.assign(
          bgJobWarning,
          await import('../../checkpoint-bg-job-claim')
            .then((m) => m.detectBgJobCheckpointClaim(checkpointHint!.checkpoint))
            .catch(() => ({ detected: false as const })),
        );
      }
      // agent-trap-guards-2026-07-26 P-003b: this is the primary self-pull surface, so
      // it's the port that matters most for surfacing a plan's governing Decisions at
      // CLAIM time — a cross-lane ruling recorded via plans:add-decision is auditable
      // and re-readable, but only for a claimant who thinks to go look. Fail-soft +
      // omitted entirely when null (no plan_item, unresolved slug, or zero decisions —
      // the common case for most plans).
      if (res?.workItem) {
        const wi = res.workItem as {
          id?: string | null;
          kind?: string | null;
          payload?: unknown;
          harness?: string | null;
          title?: string | null;
          summary?: string | null;
          sourcePlanSlug?: string | null;
          sourcePlanItemIds?: string[] | null;
          family?: 'feature' | 'issue' | null;
        };
        [
          [planDecisions, planDecisionsNote],
          priorAttemptBrief,
          premises,
          retractionWarning,
          authorshipRevalidationHint,
          planContradictionHint,
          behaviorContractHint,
          pathHintsHint,
          planItemLandedHint,
          siblingPathOverlapHint,
          sourceCitationHint,
          independenceHint,
          sourceGenerationSignal,
        ] = await Promise.all([
          import('../../plan-decisions-claim-port')
            .then(async (m) => {
              const brief = await m.getClaimTimePlanDecisions({
                workItem: { payload: wi.payload },
                harness: wi.harness ?? args.harness,
                workspaceId: ident.workspaceId ?? undefined,
              });
              return [brief, brief ? m.renderPlanDecisionsNote(brief) : null] as const;
            })
            .catch(() => [null, null] as const),
          import('../../prior-attempt-context')
            .then((m) =>
              m.getClaimTimePriorAttemptBrief({
                workItem: {
                  ...(wi.id ? { id: wi.id } : {}),
                  payload: wi.payload,
                  harness: wi.harness,
                  sourcePlanSlug: wi.sourcePlanSlug,
                  sourcePlanItemIds: wi.sourcePlanItemIds,
                },
                harness: wi.harness ?? args.harness,
              }),
            )
            .catch(() => null),
          import('../../premises-claim-port')
            .then((m) =>
              m.getClaimTimePremises({
                workItem: { id: wi.id, payload: wi.payload, title: wi.title, summary: wi.summary },
                harness: wi.harness ?? args.harness,
                workspaceId: ident.workspaceId,
              }),
            )
            .catch(() => null),
          getClaimTimeRetractionAdvisory(wi, wi.harness ?? args.harness)
            .then((advisory) => advisory?.retractionWarning ?? null)
            .catch(() => null),
          import('../../work-item-prior-work')
            .then(async (m) => {
              const authorshipRevalidation = await m.getClaimTimeAuthorshipRevalidationHint({
                harness: wi.harness ?? args.harness,
                workItemId: wi.id ?? '',
                workspaceId: ident.workspaceId ?? undefined,
              });
              const authorshipRevalidationWarning = m.authorshipRevalidationWarning(authorshipRevalidation);
              return authorshipRevalidation && authorshipRevalidationWarning
                ? { authorshipRevalidation, authorshipRevalidationWarning }
                : null;
            })
            .catch(() => null),
          import('../../work-item-plan-contradiction')
            .then(async (m) => {
              const hint = await m.getClaimTimePlanItemContradiction({
                workItemId: wi.id ?? '',
                payload: wi.payload,
              });
              const warning = m.planItemContradictionWarning(hint, wi.id ?? '');
              return hint && warning ? { planItemContradiction: hint, planItemContradictionWarning: warning } : null;
            })
            .catch(() => null),
          wi.id
            ? import('../../behavior-contract-claim-port')
                .then((m) =>
                  m.getClaimTimeBehaviorContract(
                    {
                      id: wi.id as string,
                      payload: wi.payload,
                      harness: wi.harness,
                      sourcePlanSlug: wi.sourcePlanSlug,
                      sourcePlanItemIds: wi.sourcePlanItemIds,
                    },
                    wi.harness ?? args.harness,
                  ),
                )
                .catch(() => null)
            : Promise.resolve(null),
          wi.payload || wi.title || wi.summary
            ? import('../../stale-path-hints-claim-port')
                .then(async (m) => {
                  return m.getClaimTimeStalePathAdvisory({ workItem: wi });
                })
                .catch(() => null)
            : Promise.resolve(null),
          wi.id
            ? import('../../work-item-plan-item-landed')
                .then(async (m) => {
                  const hint = await m.getClaimTimePlanItemLanded({
                    workItemId: wi.id as string,
                    payload: wi.payload,
                    sourcePlanSlug: wi.sourcePlanSlug,
                    sourcePlanItemIds: wi.sourcePlanItemIds,
                    workspaceId: ident.workspaceId ?? undefined,
                  });
                  const warning = m.planItemLandedWarning(hint, wi.id as string);
                  return hint && warning ? { planItemLanded: hint, planItemLandedWarning: warning } : null;
                })
                .catch(() => null)
            : Promise.resolve(null),
          // EI-19329513980117751: a DIFFERENT work-item shares this one's stored paths
          // and has already landed. Reaches the sibling WITHOUT a plan, unlike every
          // other sibling-finding leg here — the measured duplicate-filing instances
          // are all plan-less, so those legs are structurally silent for exactly the
          // population that suffers this. Same fail-soft seam as every leg above.
          wi?.id
            ? import('../../sibling-path-overlap-claim-port')
                .then(async (m) => {
                  const hint = await m.getClaimTimeSiblingPathOverlap({
                    workItemId: wi.id as string,
                    payload: wi.payload,
                    workspaceId: ident.workspaceId ?? undefined,
                  });
                  const warning = m.siblingPathOverlapWarning(hint, wi.id as string);
                  return hint && warning ? { siblingPathOverlap: hint, siblingPathOverlapWarning: warning } : null;
                })
                .catch(() => null)
            : Promise.resolve(null),
          // EI-19418245218824265: the only leg that reads the TREE. Needs nothing but
          // the id, so it still fires for an item implemented by an agent who never
          // claimed the row — the shape all ten row-based legs are silent for.
          wi?.id
            ? import('../../source-citation-claim-port')
                .then(async (m) => {
                  const hint = await m.getClaimTimeSourceCitation({
                    workItemId: wi.id as string,
                    workspaceId: ident.workspaceId ?? undefined,
                    harness: wi.harness ?? args.harness,
                    family: wi.family ?? familyOf(wi.kind ?? ''),
                  });
                  const warning = m.sourceCitationWarning(hint, wi.id as string);
                  return hint && warning ? { sourceCitation: hint, sourceCitationWarning: warning } : null;
                })
                .catch(() => null)
            : Promise.resolve(null),
          // EI-22344661292350991: preserve an explicit independence marker on the
          // successful claim response and add a warning only when the claimant is
          // actually in the recorded contributor lineage (including descendants /
          // predecessors). This is intentionally the last row-based advisory leg:
          // it is fully fail-soft and never participates in claim eligibility.
          wi?.id
            ? import('../../independence-claim-port')
                .then((m) =>
                  m.getClaimTimeIndependenceAdvisory({
                    workItem: {
                      id: wi.id,
                      payload: wi.payload,
                      harness: wi.harness,
                      sourcePlanSlug: wi.sourcePlanSlug,
                      sourcePlanItemIds: wi.sourcePlanItemIds,
                    },
                    claimant: ident.ownerId,
                    workspaceId: ident.workspaceId ?? undefined,
                  }),
                )
                .catch(() => null)
            : Promise.resolve(null),
          // EI-22283949842250645: measure the freshness verdict's source axis —
          // "do this item's own paths carry commits newer than the generation it
          // was observed against?". Meaningful for exactly the kinds that carry a
          // freshness envelope, which is why this consults the shared predicate
          // rather than a literal.
          //
          // WI-2145579: this was the THIRD hand-written `kind === 'bug'` copy of
          // the freshness policy, and it survived EI-20264587083609474 — which
          // unified the other two (STAMP in `issues-engineer.createIssue`, SCORE
          // below) and then asserted in its own guard that the lane had "two
          // enforcement points". It has three, and this is the MEASURE point.
          // Left behind, it half-changed the gate in the direction that hides:
          // a `change` claim got a `freshness` key from the SCORE site whose only
          // item-specific axis was permanently unmeasured, because the signal
          // feeding the re-score below was never computed for it. The old comment
          // here justified the literal as "the only family that carries a
          // freshness envelope" — a premise the STAMP change had already falsified.
          // The measurement itself is kind-agnostic: it needs only
          // `payload.freshnessEnvelope` (source-generation-claim-port reads
          // `observedSourceSha ?? observedRuntimeSha` and returns `unmeasured`
          // without one). The one real cost note — a `git log` per cited path —
          // is stated above and applies to `bug` identically, so it was never a
          // kind distinction.
          isFreshnessTrackedKind(wi?.kind)
            ? import('../../source-generation-claim-port')
                .then((m) => m.getClaimTimeSourceGenerationSignal({ workItem: wi }))
                .catch(() => null)
            : Promise.resolve(null),
        ]);
      }
      // EI-10541: a successful self-pull means this agent is transitioning idle -> working, so
      // cancel its standing `work-item:claimable` idle-park await(s) — holding a claim and waiting
      // for claimable work are mutually exclusive, and a pre-claim await left armed (e.g. this claim
      // came from a leader-fed spec bump, not the await firing) otherwise keeps firing spurious ~30-min
      // timeout wakes while the agent is busy. Best-effort + subscriber-scoped: a cancel failure must
      // never break the claim path (fails soft, like the recall port above).
      await cancelClaimableAwaits(ident.ownerId).catch(() => 0);
      // EI-20099413453852234: the same idle -> working transition also makes the caller's
      // DECLARED INTENT stale, which peers read as "this holder isn't really working it".
      // Declared here rather than left to the agent, for the reasons on the helper. Same
      // fail-soft posture as the cancel above — the claim is already committed.
      await declareIntentForClaim(ident, res?.workItem, args.harness).catch(() => {});
    };
    if (res?.workItem) {
      await withBoundedTimeout(enrichSuccessfulClaim, {
        fallback: undefined,
        timeoutMs: remainingBudgetMs(),
        label: 'scheduler:get_next:postClaimEnrichment',
      });
      // EI-22283949842250645: re-score the freshness verdict now that the source axis
      // has an actual measurement behind it. Pure CPU over an already-fetched payload,
      // so it sits OUTSIDE the deadline guard; if the leg above timed out or failed,
      // `sourceGenerationSignal` stays null and the honest "unmeasured" verdict from
      // the pre-enrichment pass is what the caller receives.
      if (freshness && sourceGenerationSignal) {
        const build = getBuildInfo();
        freshness = assessClaimFreshness((res.workItem as { payload?: unknown }).payload, {
          headSha: null,
          runtimeSha: build.sha,
          runtimeVersion: build.version,
          sourceSignal: sourceGenerationSignal,
        });
      }
    }
    // EI-16057: on a MISS ONLY, resolve `harness` against the registry before deciding
    // between "genuinely drained" (fleetScopedMiss / missDiagnosis below) and "the
    // `harness` arg itself never resolved" (a workspace id passed by mistake, a typo,
    // a slug from the wrong workspace) — the actual EI-16057 bug. An unresolvable
    // harness silently matches zero rows in the claim query, so left unchecked it
    // renders as `windDown:true`, the SAME authoritative "your lane is genuinely
    // drained" signal a real empty queue produces — a fleet member reading that stands
    // its loop down and reports a false all-clear to its leader. Checked HERE (only on
    // a miss, never on the hot successful-claim path) so a correct pull never pays the
    // extra read. Cached (loadHarnessRegistry); a read hiccup fails OPEN — "can't
    // verify" must never block/mis-report a claim path it's only annotating.
    const invalidHarnessKnownSlugs = !res
      ? await loadHarnessRegistry(ident.workspaceId && ident.workspaceId !== '*' ? ident.workspaceId : undefined)
          .then((registry) =>
            registry.projects.some((p) => p.slug === args.harness)
              ? null
              : registry.projects.map((p) => p.slug).slice(0, 30),
          )
          .catch(() => null)
      : null;
    // WI-4413: a MISS must explain itself. `work_items:claim_next` has run diagnoseClaimNextMiss
    // on a miss since EI-5803 — but THIS path (the one every fleet member self-pulls through, and
    // the one a leader's claim spec drives) returned a static, floor-blind string. Live cost
    // (bug-drain-nonp2p 2026-07-12): three consecutive leader tranches were 100% floored, by three
    // DIFFERENT floors, and each took a manual payload dig to find while members idled.
    // FAILS SOFT: any error here degrades to exactly the old static message — a diagnosis must
    // never be able to break the claim path it is only annotating.
    // WI-7316: every getNextForBee call has resolved by this point, so the list is final.
    const staleBlockedSoloNote = renderStaleBlockedSoloNote(planLaneBounces);
    const missDiagnosis =
      res || reconciliation.scope || invalidHarnessKnownSlugs
        ? { error: '' as string, diagnosis: undefined, floors: undefined }
        : // EI-18167154191955470: the miss diagnosis fans out to several unbounded PG reads
          // (getClaimSpecRecord / readClaimConcurrency / diagnoseClaimNextMiss / …) — bound it
          // too so a pool stall HERE can't reproduce the 300s hang. buildMissDiagnosis already
          // fails soft to the STATIC message, so the timeout fallback is exactly that static miss.
          (
            await withBoundedTimeout(
              buildMissDiagnosis({
                ownerId: ident.ownerId,
                workspaceId: ident.workspaceId,
                harness: args.harness,
                states: args.states,
                rigAvailable: args.rigAvailable,
              }),
              {
                fallback: {
                  error: 'no claimable work-item matched your spec within the floors',
                  diagnosis: undefined,
                  floors: undefined,
                },
                timeoutMs: remainingBudgetMs(15_000),
                label: 'scheduler:get_next:missDiagnosis',
              },
            )
          ).value;
    // EI-13520: a genuine (non-paused) scoped miss may be a release-cooldown artifact,
    // not a real scope/spec problem — check before reporting a bare fleetScopedMiss so
    // the caller (and the leader they'd otherwise flag a false spec bug to) gets the
    // true cause. Only reached when reconciliation.scope is set AND res is null AND we
    // did not already return early on the paused/default-source branches above.
    const cooldownDiag =
      !res && reconciliation.scope && !invalidHarnessKnownSlugs
        ? await diagnoseFleetScopeCooldownMiss({
            scope: reconciliation.scope,
            harness: args.harness,
            workspaceId: ident.workspaceId,
            states: args.states,
          })
        : null;
    // WI-5561: the issue-family floor-breakdown sibling of cooldownDiag above — surfaces WHY a
    // fleet-scoped miss happened (federation-detector / owner-action / claim-hold / … floors)
    // instead of the bare "no claimable work-item matched fleet scope" a member previously got
    // with zero explanation. Always attempted alongside cooldownDiag (independent signals, both
    // fail soft); fleetScopedMiss itself suppresses it while paused.
    // WI-5947: computed ABOVE (before the divergence re-check, which needs it to decide whether
    // to retry at all) and reused verbatim here — re-reading it would be a third unsynchronized
    // observation of the same churning pool, i.e. the very defect this fix removes.
    // `invalidHarnessKnownSlugs` still suppresses it: an unresolvable harness matches zero rows
    // for reasons that have nothing to do with the floors.
    const issueBreakdownForMiss = !res && reconciliation.scope && !invalidHarnessKnownSlugs ? issueBreakdown : null;
    // WI-7151: same suppression as issueBreakdownForMiss — irrelevant once res is set (claimed
    // on a retry) or when the miss isn't fleet-scoped/is an invalid-harness miss.
    const featureFamilyMatchedForMiss =
      !res && reconciliation.scope && !invalidHarnessKnownSlugs ? featureFamilyMatched : null;
    // EI-20186990913643457: same suppression as the other miss annotations — terminal
    // exhaustion only describes an actual fleet-scoped miss under a valid harness.
    const terminalExhaustionForMiss =
      !res && reconciliation.scope && !invalidHarnessKnownSlugs ? terminalExhaustion : null;
    // EI-20260781488788952: enrich the zero-match branch with plan terminality and leader
    // liveness. Both reads fail soft and are only useful when the issue-family breakdown would
    // otherwise certify `spec_matches_nothing`; preserving null keeps the old diagnosis intact.
    const planTerminalityForMiss = !res && reconciliation.scope && !invalidHarnessKnownSlugs ? planTerminality : null;
    const leaderLivenessForMiss = !res && reconciliation.scope && !invalidHarnessKnownSlugs ? leaderLiveness : null;
    const basePayload = res
      ? assembleSchedulerClaimResult({
          workItem: res.workItem,
          claimedUnder: res.claimedUnder,
          freshness,
          warning,
          requiresIndependenceFrom: independenceHint?.requiresIndependenceFrom,
          independenceWarning: independenceHint?.independenceWarning,
          routingHint,
          memory,
          checkpoint: checkpointHint?.checkpoint,
          checkpointAgeMs: checkpointHint?.checkpointAgeMs,
          checkpointWarning: checkpointHint
            ? 'A PRIOR holder left an in-flight checkpoint on this item — it may already be DONE or partly done. Read it before building: verify against the tree/tests first, do not assume greenfield (EI-529).'
            : undefined,
          checkpointBgJobWarning: bgJobWarning.detected ? bgJobWarning.reason : undefined,
          retractionWarning,
          priorWork: priorWorkHint?.priorWork,
          priorWorkWarning: priorWorkHint?.priorWorkWarning,
          authorshipRevalidation: authorshipRevalidationHint?.authorshipRevalidation,
          authorshipRevalidationWarning: authorshipRevalidationHint?.authorshipRevalidationWarning,
          planItemContradiction: planContradictionHint?.planItemContradiction,
          planItemContradictionWarning: planContradictionHint?.planItemContradictionWarning,
          planItemLanded: planItemLandedHint?.planItemLanded,
          planItemLandedWarning: planItemLandedHint?.planItemLandedWarning,
          siblingPathOverlap: siblingPathOverlapHint?.siblingPathOverlap,
          siblingPathOverlapWarning: siblingPathOverlapHint?.siblingPathOverlapWarning,
          sourceCitation: sourceCitationHint?.sourceCitation,
          sourceCitationWarning: sourceCitationHint?.sourceCitationWarning,
          behaviorContract: behaviorContractHint?.behaviorContract,
          behaviorContractNote: behaviorContractHint?.behaviorContractNote,
          pathHints: pathHintsHint?.pathHints,
          pathHintsNote: pathHintsHint?.pathHintsNote ?? undefined,
          stalePathRefs: pathHintsHint?.stalePathRefs,
          stalePathRefsNote: pathHintsHint?.stalePathRefsNote ?? undefined,
          // EI-19396519606401168: this note used to be built from the
          // POST-CAP length, so a capped brief announced itself as the
          // complete set. The shared helper still renders the true total
          // and says when older decisions are not shown.
          planDecisions: planDecisions?.decisions,
          planDecisionsNote,
          priorAttemptBrief,
          premises: premises?.rendered,
          premisesNote: premises?.note,
        })
      : invalidHarnessKnownSlugs
        ? {
            ok: false,
            error: 'invalid_input',
            reason: 'harness_not_found',
            message:
              `harness '${args.harness}' does not resolve to a registered harness in this workspace — ` +
              "pass the harness SLUG (e.g. 'papercusp'), not a workspace id or typo; see harness:list " +
              'for valid slugs. This is a scope/argument problem, not a drained queue, so it is reported ' +
              'as invalid_input and windDown is never set for it.',
            passedHarness: args.harness,
            knownHarnesses: invalidHarnessKnownSlugs,
          }
        : reconciliation.scope
          ? fleetScopedMiss(reconciliation.scope, reconciliation.quarantinedIds, {
              cooldownDiag,
              issueBreakdown: issueBreakdownForMiss,
              featureFamilyMatched: featureFamilyMatchedForMiss,
              terminalExhaustion: terminalExhaustionForMiss,
              planTerminality: planTerminalityForMiss,
              leaderLiveness: leaderLivenessForMiss,
              divergenceRecheck,
              harness: args.harness,
              // WI-7316: the bounces collected above. fleetScopedMiss turns a non-empty list
              // into `reason: 'stale_plan_item_block'` AND — the part that changes behaviour
              // rather than wording — `windDown: false`, so a member is never told to stand
              // down over a lane that is one plans:set-status call from claimable.
              staleBlockedLane: planLaneBounces,
            })
          : {
              ok: false,
              // WI-7316: appended HERE rather than inside buildMissDiagnosis on purpose — that
              // call is wrapped in withBoundedTimeout, whose fallback is the bare STATIC string,
              // so a diagnosis that times out would silently drop the one cause the caller most
              // needs. This concatenation runs whichever way the diagnosis resolved. (The fleet
              // MEMBER path gets the same evidence through fleetScopedMiss's staleBlockedLane
              // above, where it also flips windDown off; this is the solo/leader counterpart,
              // which has no windDown to flip.)
              error: missDiagnosis.error + staleBlockedSoloNote,
              // WI-4413: the miss now EXPLAINS itself — aggregate POOL/READY split, plus
              // (when the spec names ids) the exact floor refusing each one.
              ...(planLaneBounces.length > 0 ? { staleBlockedLane: planLaneBounces } : {}),
              ...(missDiagnosis.diagnosis ? { diagnosis: missDiagnosis.diagnosis } : {}),
              ...(missDiagnosis.floors ? { floors: missDiagnosis.floors } : {}),
              // P-006: teach the composed-await idle recipe exactly where the idle
              // moment happens, instead of leaving the caller to a 60s re-poll.
              advice: IDLE_PULL_MISS_ADVICE,
            };
    const payload = retiredSoloPlanSpec ? { ...basePayload, retiredSoloPlanSpec } : basePayload;
    // P-003: `tool_invocations` has no inline result JSON. Stamp the one fact a
    // later launch verifier needs — claimed vs diagnosed no-claim — onto the
    // invocation's existing metadata writer. This is intentionally the only
    // ctx.metadata call on the final path: metadata is last-write-wins.
    // EI-7014: attribute the disposition to the spec that produced it — a claim's own
    // provenance (`res.claimedUnder`, the resolver's exact record) when one landed, else the
    // fleet-scoped miss's resolved spec record. Both are already-computed values on this hot
    // path (see specHeadFrom's doc comment) — no extra read.
    const dispositionSpecHead =
      res?.claimedUnder ??
      (reconciliation.scope
        ? { specId: reconciliation.scope.record.spec?.specId, revision: reconciliation.scope.record.revision }
        : null);
    ctx.metadata?.({
      schedulerDisposition: schedulerDispositionMetadata(res?.workItem, payload, dispositionSpecHead),
    });
    // The claim committed before this response was rendered. Keep the existing
    // bounded text projection for ordinary model callers, but give programmatic
    // callers the complete object so they can reconcile without blind retry.
    if (res) return { data: payload };
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
    };
  },
});
