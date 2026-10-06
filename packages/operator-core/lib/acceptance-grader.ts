/** Dedicated, frozen acceptance-grader launch for the plan completion gate. */
import { createHash } from 'node:crypto';
import { closeSync, fstatSync, openSync, readSync, statSync } from 'node:fs';
import launchAgentTool from './agent-tools/capability/launch-agent';
import { resolveAgentIdentity } from './agent-tools/coordination/identity';
import { ACCEPTANCE_DRAIN_ACTOR } from './agent-tools/plans/acceptance-drain-filing';
import { readPlanBySlug } from './agent-tools/plans/source';
import { resolveAggregatedVettingCritics } from './agent-tools/scorecards/grader-eligibility';
import { areAcceptanceLineageRelated, resolvePlanImplementerIdentities } from './acceptance-author-identity';
import { readAcceptanceGradingSettlement, type AcceptanceGradingSettlement } from './acceptance-grading-authority';
import { getLatestPlanAudit, summarizeCoverage } from './plan-audits';
import { getAcceptanceRubricForPlan } from './rubrics';
import { listWorkItems, type WorkItem } from './work-items';
import { reserveAcceptanceReviewTarget, type AcceptanceReviewReservationRef } from './coord/condition-upsert';
import type { GraderEligibility, GraderEscalation } from './consult/acceptance-grader-select';
// Type-only: erased at runtime, so it does NOT pull the oracle eagerly — the
// VALUE (`resolveSessionStates`) stays behind the dynamic import below.
import type { LivenessVerdict } from './agent-tools/coordination/liveness-oracle';
// Manual citation checks must use the same subject tree as the frozen audit, and
// the fresh-judge prompt and the assigned-grader briefs must say so identically —
// so the guidance is single-sourced beside the briefs, in grading-cascade.ts.
import {
  ACCEPTANCE_GRADING_BAR_SCOPE_GUIDANCE,
  ACCEPTANCE_CITATION_SPOT_CHECK_GUIDANCE,
  acceptanceReviewReservationGuidance,
  GRADING_CASCADE_FLAVOR,
} from './consult/grading-cascade';
import { listTasks } from './task-manager/store';
import { killTask } from './task-manager/control';

type LaunchCtx = Parameters<typeof launchAgentTool.handler>[1];

/**
 * WI-10002156: a REAPED session wears a healthy costume at grader selection.
 *
 * When a session dies uncleanly it never writes `adv_sessions.ended_at`, so the
 * oracle's recorded-live leg still counts it as positive liveness evidence; its
 * coord_presence row is reaped on TTL, but its inbox-wake WATCH ROW outlives the
 * process, so wakeability still reads true. The verdict therefore lands `parked`
 * — which is NOT in DEAD_RESPONDER_STATES and is therefore selectable. The
 * cascade then assigns grading to a session that can never take a turn, and the
 * plan waits on it until the 4h cascade expiry. MEASURED 2026-09-21 on
 * su-ce0b634c-004b-438e-ab1d-cd677fd5c604: no coord_presence row at all, an
 * adv_sessions row open since 07:01Z with a NULL pid, selected `via: 'minimum'`
 * and reported `liveness: 'parked'` by the live ship gate.
 *
 * A watch row and an unclosed session row BOTH outlive the process; neither is a
 * heartbeat. So the honest discriminator at THIS seam is presence: a `parked`
 * verdict that no fresh heartbeat backs is a dead responder, demoted to `ended`
 * FOR SELECTION ONLY. The shared oracle is deliberately left alone — its
 * `parked` is correct for the ~10 other surfaces that read it.
 *
 * Deliberately NOT done, each considered and rejected against measurement:
 *  - widening DEAD_RESPONDER_STATES to include `parked`: a genuinely parked
 *    grader is legitimate BY DESIGN — it reads the request on its next turn.
 *  - `psuHostAuthority: true`: the oracle header restricts that leg to cohorts
 *    known to be psu-pty-hosted; the grader pool is arbitrary routed agents, so
 *    enabling it would mass-demote live candidates to `ended`.
 *  - gating on `selfWake === 'none'`: that axis is about UNPROMPTED self-wake
 *    and the cascade sends an EXTERNAL wake. Measured: ~13 of 24 parked agents
 *    report 'none' and are perfectly reachable; gating on it would halve the
 *    candidate pool.
 *  - gating on `pickupConfirmed`: typed the literal `false` by construction
 *    (inbox-wake.ts), so `=== true` is a compile error, not a check.
 *
 * Failure direction is deliberate: a wrongly-demoted candidate costs a shorter
 * menu (the recruiter falls through to another candidate or a fresh mint), while
 * a wrongly-admitted dead one costs a silently stalled plan.
 */
export function selectableGraderLiveness(
  verdict: Pick<LivenessVerdict, 'sessionState' | 'heartbeatFresh'>,
): LivenessVerdict['sessionState'] {
  if (verdict.sessionState !== 'parked') return verdict.sessionState;
  return verdict.heartbeatFresh ? 'parked' : 'ended';
}

/**
 * Stable in-process principal that owns automatic acceptance-grader recruitment.
 *
 * A rubric author may ask the plan gate to recruit a judge, but a fresh agent
 * launched *by that author* remains in the author's lineage and therefore cannot
 * supply an independent grade.  The gate and the periodic recovery sweep both
 * recruit through this system principal so the spawned judge is outside the
 * author's launch lineage; direct author calls to launchAcceptanceGrader remain
 * fail-closed below.
 */
export const ACCEPTANCE_GRADING_SWEEP_ACTOR = 'system:acceptance-grading-sweep';

/**
 * A task can be a grading request without carrying source-plan provenance: the
 * delegated request path historically stored the plan slug in its prose. Keep
 * this detector deliberately narrow so a normal task that merely belongs to a
 * plan cannot suppress independent acceptance grading.
 */
const ACCEPTANCE_GRADING_REQUEST_MARKERS = [
  /\bacceptance[-\s]+(?:grading|grader|grade)\b/i,
  /\bnon[-\s]?implementer[-\s]+grader\b/i,
  /\bscorecards\s*:\s*emit\b/i,
] as const;

function containsPlanSlug(text: string, planSlug: string): boolean {
  const escaped = planSlug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, 'i').test(text);
}

/**
 * Pure identity predicate for a delegated, non-terminal acceptance-grading task.
 *
 * An acceptance-drain filing is never one, whatever its prose says: it is the
 * implementer's carry item, and it quotes the gate refusal VERBATIM — which names
 * the `scorecards:emit` remedy. Matched on text alone it reads as an in-flight
 * grading request, so the recruiter dedupes against the very item filed to get
 * the plan graded, and nobody is ever recruited (WI-10002453). Authorship, not
 * wording, decides it.
 */
/**
 * Author of consult-expiry pullable-review items (`consultExpiryFileReviewWorkItem`).
 * Kept local rather than imported: that adapter module pulls the task-manager reaper
 * and get-feedback-core at runtime. `acceptance-grader.test.ts` pins this literal to
 * the exported `CONSULT_EXPIRY_SWEEP_OWNER_ID` so the two cannot drift.
 */
export const CONSULT_EXPIRY_REVIEW_AUTHOR = 'system:consult-expiry-sweep';

/** The two titles the consult-expiry filer writes for an ACCEPTANCE-GRADING review
 * (reservation-backed, or a plain `Review needed (acceptance-grading)`). Every other
 * kind it converts — rubric-vetting above all — is not a grading request. */
const CONSULT_EXPIRY_GRADING_TITLE_RE =
  /^(?:Acceptance review-target reservation\b|Review needed \(acceptance-grading\))/;

export function isAcceptanceGradingRequestForPlan(
  workItem: Pick<WorkItem, 'title' | 'summary' | 'createdBy'>,
  planSlug: string,
): boolean {
  const normalizedPlanSlug = planSlug.trim();
  if (!normalizedPlanSlug) return false;
  if (workItem.createdBy === ACCEPTANCE_DRAIN_ACTOR) return false;
  // WI-10003450: a consult-expiry RUBRIC-VETTING review names the plan and quotes
  // `scorecards:emit { vettingWorkItem }` in its instructions, so the prose markers
  // below matched it and an unheld vetting item suppressed grader recruitment for the
  // whole unheld grace window. Same class as the drain filing above: for a
  // system-authored item, its fixed title template decides, never its wording.
  if (workItem.createdBy === CONSULT_EXPIRY_REVIEW_AUTHOR) {
    return (
      CONSULT_EXPIRY_GRADING_TITLE_RE.test(workItem.title ?? '') &&
      containsPlanSlug(`${workItem.title ?? ''}\n${workItem.summary ?? ''}`, normalizedPlanSlug)
    );
  }
  const text = `${workItem.title ?? ''}\n${workItem.summary ?? ''}`;
  return (
    containsPlanSlug(text, normalizedPlanSlug) &&
    ACCEPTANCE_GRADING_REQUEST_MARKERS.some((marker) => marker.test(text))
  );
}

/**
 * How long an UNHELD grading request keeps suppressing dispatch after it was filed
 * (or last progressed). The window is what EI-22678191183363422 protects: a request
 * the scheduler has not placed yet must not be raced by a second grader. It spans
 * several admission (fail-open at 60 min) and claim cycles, so a request still
 * unheld past it has been passed over, not queued. Measured when this was set:
 * every unheld request blocking recruitment was 1–4 WEEKS old (WI-10002453).
 */
export const ACCEPTANCE_GRADING_REQUEST_UNHELD_GRACE_MS = 6 * 60 * 60 * 1000;

/**
 * Is this task a grading request that is actually IN FLIGHT — the only kind that may
 * suppress recruiting a grader? Identity alone is not enough: an unheld request is
 * graded by nobody, and suppressing dispatch behind it strands the plan for good.
 * An unreadable timestamp counts as not-fresh, keeping the guard fail-open.
 *
 * A HELD request is in flight only when its holder could produce an admissible grade.
 * `ineligibleHolders` is the set of holders who cannot (see `ineligibleGradingHolders`):
 * an agent-filed carry item whose prose asks to "request a new non-author acceptance
 * grade" matches the identity markers, and its holder is the one about to call the
 * ship gate — the shipper, whom D-009 excludes from grading. Suppressing behind that
 * item dedupes the recruiter against the implementer's own carry item forever
 * (WI-10002459). A holder who IS eligible keeps suppressing, which is the live grading
 * EI-22678191183363422 protects.
 */
export function isInFlightAcceptanceGradingRequest(
  workItem: Pick<WorkItem, 'title' | 'summary' | 'createdBy' | 'assignee' | 'createdAt' | 'lastProgressAt'>,
  planSlug: string,
  nowMs: number,
  ineligibleHolders?: ReadonlySet<string>,
): boolean {
  if (!isAcceptanceGradingRequestForPlan(workItem, planSlug)) return false;
  if (workItem.assignee) return !ineligibleHolders?.has(workItem.assignee);
  const lastMovedMs = Date.parse(workItem.lastProgressAt ?? workItem.createdAt);
  return Number.isFinite(lastMovedMs) && nowMs - lastMovedMs < ACCEPTANCE_GRADING_REQUEST_UNHELD_GRACE_MS;
}

/**
 * Which of `holders` cannot produce an admissible grade: anyone in the D-009 exclusion
 * set, or the same D-008 party as anyone in it. `partyKeys` maps an identity to its
 * lineage party (an identity absent from the map is its own party), exactly as
 * grader selection collapses its pool, so a holder rebound from the rubric author is
 * excluded here just as it would be refused there.
 */
export function ineligibleGradingHolders(
  holders: readonly string[],
  excluded: readonly string[],
  partyKeys: ReadonlyMap<string, string>,
): Set<string> {
  const partyOf = (id: string) => partyKeys.get(id) ?? id;
  const excludedParties = new Set(excluded.map(partyOf));
  return new Set(holders.filter((holder) => excludedParties.has(partyOf(holder))));
}

/** One entry of the assigned grader MENU, with its selection provenance. */
export type AssignedGrader = {
  ownerId: string;
  score: number;
  liveness: string;
  /** 'floor' = above the relevance floor; 'minimum' = best-available below it
   * (D-002 [owner] minimum-fill). P-004 reads this to stop a 'minimum' card
   * superseding a 'floor' one under the gate's latest-wins pick, so it has to
   * survive out of selection and onto the lifecycle. */
  via: 'floor' | 'minimum';
};

export type AcceptanceGraderLifecycle = {
  /** 'assigned' (P-011/D-009): existing non-excluded, reachable agents were
   * selected by the relevance router — no fresh judge was launched.
   * 'settled' (WI-1699998): nothing was dispatched at all, because this rubric's
   * grading is ALREADY DECIDED at its current revision — see `settlement`. This is
   * a success, not a failure: re-routing a decided grading burns a non-replenishable
   * independent grader. */
  state: 'launched' | 'deduped' | 'failed' | 'assigned' | 'settled';
  /** Existing task/request that made a fresh acceptance dispatch unnecessary. */
  existingWorkItemId?: string;
  /**
   * Holder of {@link existingWorkItemId} when this lifecycle deduped onto an
   * in-flight grading REQUEST (null = unassigned, still inside its grace window).
   * Surfaced so a refusal can name who must grade while automatic recovery is
   * unavailable (EI-24032136322947460); absent for launch-receipt dedupes.
   */
  existingWorkItemAssignee?: string | null;
  idempotencyKey: string;
  label: string;
  launch?: unknown;
  error?: string;
  /**
   * EI-21923986145923904: passthrough of `capability:launch-agent`'s own
   * three-state fresh-launch verdict (see `FreshLaunchVerdict.agentStarted`) —
   * `true` = observed a real turn, `false` = observed silence (booted then
   * never started), `null` = window expired with no session row ever observed
   * (the honest "unconfirmed" case, NOT proof of death). Only set for state
   * 'launched' launches that went through the fresh-launch verification path
   * (the assigned-existing-grader path never launches, so this stays absent
   * there). Previously computed by the launch tool and silently discarded
   * here, so a `plans:set-plan-status` caller reading a 'launched' result had
   * no way to tell a verified launch from one the tool itself could not
   * confirm — the "reports Launched, but the agent never actually starts"
   * failure read as success all the way up to the plan-ship gate. Read this
   * field, not `state === 'launched'` alone, before treating a grader launch
   * as settled; `agentStarted === null` means re-check in ~1 min rather than
   * waiting on it indefinitely.
   */
  agentStarted?: boolean | null;
  /**
   * Discovery outcome (state 'assigned'): the ordered grader MENU, head first.
   * A MENU rather than one grader since
   * unified-responder-selection-critique-and-grading-2026-08-30 D-001/D-003
   * [owner] — bounded by the shared ACCEPTANCE_GRADING_POLICY (see
   * `selection-policies.ts` for the current min/max), and the tail is NOT
   * woken here: grader k+1 is woken by the cascade only after k replies,
   * declines or expires, carrying k's card.
   */
  graders?: AssignedGrader[];
  /** The grading cascade's conversation (state 'assigned') — the thread the
   * graders reply into, and the row whose cursor the cascade advances. */
  conversationId?: string;
  /** D-009 exclusion audit trail (implementers + heavy consult participants +
   * rubric author + shipper) — set whenever discovery ran. */
  excluded?: string[];
  /** D-008 party-collapse audit trail: candidates dropped because a better-ranked
   * candidate was the SAME PARTY (a rebind chain, or a launcher and what it
   * launched). Distinct from `excluded` — these are duplicate faces of an actor
   * already on the menu, not disqualified actors. ABSENT (not empty) when party
   * resolution faulted and selection degraded to raw-ownerId distinctness. */
  partyCollapsed?: string[];
  /** Structured discovery counts, including the known post-exclusion pool. */
  eligibility?: GraderEligibility;
  /** Explicit escalation when the measured post-exclusion pool is empty. */
  escalation?: GraderEscalation;
  /** Why discovery produced an EMPTY menu and fell through to the fresh launch
   * (state launched/deduped). Below-floor is no longer among these reasons —
   * D-002 replaced it with minimum-fill; see acceptance-grader-select.ts. */
  freshReason?: 'no_eligible_non_excluded' | 'all_eligible_unselectable' | 'degraded' | 'discovery_error';
  /** Set only alongside freshReason:'discovery_error' — the caught error's
   * message, truncated, so a discovery throw is distinguishable from a
   * genuinely empty pool instead of presenting identically to a normal
   * fresh-judge launch (EI-21925808460100711). */
  discoveryError?: string;
  /** DISPATCH receipt for the head grader.
   *
   * ⚠ The menu grader is NEVER woken in place (R-11 / D-013): their transcript is
   * FORKED (same backend) or CONVERTED (cross backend) into a new session that
   * grades this one rubric. So `graders[0].ownerId` staying parked is correct, and
   * `answeringOwnerId` — the launched session — is the one to watch (WI-10003786).
   *
   * - `woke` counts dispatches QUEUED by THIS call (a launched fork still booting
   *   counts). 0 with `dispatch:'existing'` is the idempotent re-call: an earlier
   *   call already dispatched and nobody new was needed.
   * - `dispatch` says which: `'new'` (this call opened the cascade) or
   *   `'existing'` (it found the live one). Absent when no cascade opened.
   * - `answeringOwnerId` is the session grading the cascade's current rank, when
   *   one was recorded. Absent while unknown (refused dispatch, not yet stamped).
   *
   * ⚠ DELIVERY, NOT PICKUP (P-003 R-3 / plan D-011 ruling 2): a queued dispatch
   * has not taken a turn, so `woke > 0` must never be read as pickup.
   * `wakeInstant` — stamped only when THIS call dispatched — is the baseline for
   * establishing pickup AFTERWARDS from the answering session's own activity; see
   * `observeGraderPickup` in ./acceptance-grader-pickup.ts. */
  notified?: { woke: number; dispatch?: 'new' | 'existing'; answeringOwnerId?: string; wakeInstant?: string };
  /** The durable typed review-target assignment used by this dispatch. */
  reviewReservation?: AcceptanceReviewReservationRef;
  /** Why dispatch was skipped (state 'settled'), or — on any other state — the
   * not-settled reading that ALLOWED the dispatch. Recorded on both paths on
   * purpose: a skip nobody can see is how this bug class hides, and so is a
   * dispatch whose settlement read silently failed open. */
  settlement?: AcceptanceGradingSettlement;
  /** A stable launch receipt may outlive the judge mission it originally
   * represented. When that receipt pointed at an ended/over-age task, these
   * are the stale task ids bypassed before a fresh deterministic retry. */
  staleRecovery?: { retiredTaskIds: string[]; attempts: number };
  /** A judge can fail before grading at all (a terminal model-limit response,
   * or a bounded connection-startup stall with no first-turn progress). The
   * launcher retires that failed mission and makes one cross-backend retry on
   * the gateway-routed account (`auto`) — WI-10002152: the retry must be able to
   * land on a DIFFERENT pool account than the one that just failed, which the
   * single-credential `default` route cannot do. */
  terminalRecovery?: {
    retiredTaskIds: string[];
    attempts: number;
    codes: AcceptanceGraderTerminalFailureCode[];
    fallback: { agent: 'codex'; model: 'gpt-5.6-sol'; effort: 'high'; account: 'auto' };
  };
};

export const ACCEPTANCE_GRADER_STALE_AFTER_MS = 2 * 60 * 60_000;
const ACCEPTANCE_GRADER_MAX_STALE_RETRIES = 4;
const ACCEPTANCE_GRADER_LOG_TAIL_BYTES = 16_000;
const ACCEPTANCE_GRADER_MAX_TERMINAL_FALLBACKS = 1;
/**
 * A fresh headless launch returns after its spawn/boot verifier, not after the
 * first bytes from the child have necessarily reached its log file. Keep the
 * reconciliation window deliberately small and finite: it catches a terminal
 * first-turn response that races the launch receipt without turning the
 * acceptance path into a background watcher.
 */
export const ACCEPTANCE_GRADER_TERMINAL_LOG_RECHECK_DELAY_MS = 250;
export const ACCEPTANCE_GRADER_TERMINAL_LOG_MAX_RECHECKS = 4;
/**
 * Only an exact connection-startup candidate enters this slower window. A
 * normal launch therefore keeps the one-second terminal-response check above,
 * while a judge that remains on `/rc connecting…` gets one bounded minute to
 * show first-turn progress before the launcher retires it. This is far below
 * the two-hour stale-receipt ceiling without treating an ordinary slow model
 * turn as a connection failure.
 */
export const ACCEPTANCE_GRADER_STARTUP_STALL_RECHECK_DELAY_MS = 2_000;
export const ACCEPTANCE_GRADER_STARTUP_STALL_MAX_RECHECKS = 30;
const ACCEPTANCE_GRADER_FALLBACK = {
  agent: 'codex' as const,
  model: 'gpt-5.6-sol' as const,
  effort: 'high' as const,
  // WI-10002152: `auto`, never `default`. Switching the AGENT (claude -> codex)
  // is not a real escape hatch if both arms keep the same single credential —
  // a usage wall on it fails the fallback exactly like the primary.
  account: 'auto' as const,
};

export type AcceptanceGraderTerminalFailureCode =
  | 'model_quota_exhausted'
  | 'startup_connection_stalled'
  | 'startup_first_turn_stalled'
  | 'inference_gateway_error'
  /**
   * WI-10002155: the launcher's OWN structured receipt said the kickoff was
   * never submitted (`launch.tasks[].kickoffProof.persisted !== true`). This is
   * deliberately NOT derived from the log: `capability:launch-agent` publishes
   * this verdict about THIS launch, so unlike the pty-host log patterns it
   * cannot be forged by a judge's frozen evidence quoting launcher
   * diagnostics — which is exactly why `allowLauncherQuotaDrop` must stay
   * opt-in while this signal can always be trusted.
   */
  | 'launch_kickoff_not_persisted'
  /**
   * WI-10002903 (second leg): psu-pty-host's OWN terminal receipt says it gave
   * up delivering the launch kickoff (`psu-pty-host: launch kickoff DROPPED for
   * … (<reason> within <N>ms over <K> attempt(s))`) for any non-quota reason,
   * and the log shows no first-turn progress. The drop can land AFTER
   * `capability:launch-agent` returned its receipt, so the structured
   * `launch_kickoff_not_persisted` signal above cannot see it; the host process
   * stays kernel-live and a live-task guard would dedupe to it forever. Log
   * derived, so it is opt-in (`allowLauncherKickoffDrop`) like its siblings.
   */
  | 'launch_kickoff_dropped'
  /** A completed grading auditor turn explicitly says it could not reach platform tools. */
  | 'tool_surface_unavailable'
  /** A completed grading auditor turn explicitly declined to emit its audit. */
  | 'grading_audit_refused'
  /**
   * WI-10005295: the auditor finished a turn and then sat idle at its prompt past the
   * reservation TTL while its card stayed pending, whatever the reason it stopped
   * without emitting (misread target, tool error, unrecognised refusal wording).
   */
  | 'parked_without_emit';

export interface AcceptanceGraderTerminalFailure {
  code: AcceptanceGraderTerminalFailureCode;
  evidence: string;
}

type AcceptanceGraderLogTailReader = (path: string) => string | Promise<string>;

/**
 * Read a launch receipt's log more than once, but only inside a bounded
 * post-launch window. `capability:launch-agent` returns when the process is
 * spawned/verified, while a headless CLI can write its first-turn quota screen
 * shortly afterwards. A single read therefore creates a race where a dead
 * judge is left running until the quiet-task reaper. The bounded retry is
 * intentionally local to this launch transaction and stops after a fixed
 * number of reads.
 */
export async function detectAcceptanceGraderTerminalFailure(
  logPath: string | null,
  {
    readLogTail,
    sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    delayMs = ACCEPTANCE_GRADER_TERMINAL_LOG_RECHECK_DELAY_MS,
    maxRechecks = ACCEPTANCE_GRADER_TERMINAL_LOG_MAX_RECHECKS,
    startupStallDelayMs = ACCEPTANCE_GRADER_STARTUP_STALL_RECHECK_DELAY_MS,
    startupStallMaxRechecks = ACCEPTANCE_GRADER_STARTUP_STALL_MAX_RECHECKS,
    allowStandaloneWeeklyLimit = false,
    allowInferenceGatewayError = false,
    allowGatewayErrorWithoutFooter = false,
    allowLauncherQuotaDrop = false,
    allowLauncherWalledPoolRefusal = false,
    allowLauncherKickoffDrop = false,
    allowToolSurfaceRefusal = false,
    allowGradingAuditRefusal = false,
    detectStartupStall = true,
  }: {
    readLogTail: AcceptanceGraderLogTailReader;
    sleep?: (ms: number) => Promise<void>;
    delayMs?: number;
    maxRechecks?: number;
    startupStallDelayMs?: number;
    startupStallMaxRechecks?: number;
    /**
     * A controlled launch brief that cannot itself quote incident evidence may
     * opt into Claude's standalone weekly-limit headline. Acceptance grading
     * leaves this false because its frozen evidence can legitimately contain
     * the same prose; callers must make that ambiguity impossible first.
     */
    allowStandaloneWeeklyLimit?: boolean;
    /**
     * A controlled launch whose prompt cannot quote a terminal gateway screen may
     * opt into the exact gateway-error + completed-turn detector. Keep this false for the
     * general acceptance prompt because frozen evidence can contain error prose.
     */
    allowInferenceGatewayError?: boolean;
    /**
     * Dedicated fire-and-forget launches can stop at the exact gateway error
     * screen without rendering Claude's completed-turn footer. Only controlled
     * callers whose launch brief cannot quote that screen may enable this, and
     * only together with allowInferenceGatewayError.
     */
    allowGatewayErrorWithoutFooter?: boolean;
    /**
     * A fire-and-forget controlled launch may opt into the exact pty-host
     * terminal receipt emitted when its launch kickoff cannot be submitted
     * through a quota wall. General acceptance leaves this false because its
     * frozen evidence may quote launcher diagnostics.
     */
    allowLauncherQuotaDrop?: boolean;
    /**
     * EI-22978598482930667: recognize psu's walled-pool launch REFUSAL (exit 78)
     * as terminal. Forwarded verbatim to the classifier; see its option doc for
     * why this stays opt-in rather than always-on.
     */
    allowLauncherWalledPoolRefusal?: boolean;
    /**
     * WI-10002903: recognize psu-pty-host's non-quota `launch kickoff DROPPED`
     * receipt as terminal when the log shows no first-turn progress. Forwarded
     * verbatim to the classifier; opt-in for the same frozen-evidence reason.
     */
    allowLauncherKickoffDrop?: boolean;
    /** Controlled grading-audit briefs may classify an explicit completed-turn tool-surface refusal. */
    allowToolSurfaceRefusal?: boolean;
    /** Controlled grading-audit briefs may retire an auditor that explicitly finished without emitting. */
    allowGradingAuditRefusal?: boolean;
    /** Some consumers only need terminal quota detection and must not spend the
     * longer connection-stall window inside their synchronous dispatch path. */
    detectStartupStall?: boolean;
  },
): Promise<AcceptanceGraderTerminalFailure | null> {
  if (!logPath) return null;
  const boundedRechecks = Math.max(0, Math.floor(maxRechecks));
  const boundedDelay = Math.max(0, Math.floor(delayMs));
  let latestRawLog = '';
  for (let recheck = 0; recheck <= boundedRechecks; recheck += 1) {
    latestRawLog = await readLogTail(logPath);
    const terminalFailure = classifyAcceptanceGraderTerminalFailure(latestRawLog, {
      allowStandaloneWeeklyLimit,
      allowInferenceGatewayError,
      allowGatewayErrorWithoutFooter,
      allowLauncherQuotaDrop,
      allowLauncherWalledPoolRefusal,
      allowLauncherKickoffDrop,
      allowToolSurfaceRefusal,
      allowGradingAuditRefusal,
    });
    if (terminalFailure) return terminalFailure;
    if (recheck < boundedRechecks) await sleep(boundedDelay);
  }

  if (!detectStartupStall) return null;

  let startupStall = classifyAcceptanceGraderStartupStall(latestRawLog);
  if (!startupStall) return null;

  const boundedStartupRechecks = Math.max(0, Math.floor(startupStallMaxRechecks));
  const boundedStartupDelay = Math.max(0, Math.floor(startupStallDelayMs));
  for (let recheck = 0; recheck < boundedStartupRechecks; recheck += 1) {
    await sleep(boundedStartupDelay);
    latestRawLog = await readLogTail(logPath);
    const terminalFailure = classifyAcceptanceGraderTerminalFailure(latestRawLog, {
      allowStandaloneWeeklyLimit,
      allowInferenceGatewayError,
      allowGatewayErrorWithoutFooter,
      allowLauncherQuotaDrop,
      allowLauncherWalledPoolRefusal,
      allowLauncherKickoffDrop,
      allowToolSurfaceRefusal,
      allowGradingAuditRefusal,
    });
    if (terminalFailure) return terminalFailure;
    startupStall = classifyAcceptanceGraderStartupStall(latestRawLog);
    if (!startupStall) return null;
  }
  return {
    ...startupStall,
    evidence:
      `${startupStall.evidence}; no first-turn progress after ` +
      `${boundedStartupRechecks * boundedStartupDelay}ms bounded recheck`,
  };
}

function normalizeAcceptanceGraderLog(rawLog: string): string {
  return rawLog
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\r/g, '\n');
}

/**
 * A bounded, exact detector for a terminal first turn that can never satisfy the
 * acceptance mission. Keep this narrower than a generic "error" scan: the frozen
 * plan evidence is rendered in the same log, so broad words would create false
 * positives from the material the judge was asked to inspect.
 */
/**
 * WI-10004926: parsers for psu-pty-host's startup-turn drop receipt, which
 * apps/operator/scripts/psu-pty-host.mjs writes ONLY through
 * `formatStartupTurnDroppedLine`. Both are `$`-anchored on the
 * `within <N>ms over <N> attempt(s))` tail. The contract is pinned by
 * apps/operator/lib/psu-pty-host-drop-line-contract.test.ts, which runs every
 * drop reason through the real formatter into these patterns. Non-global, so
 * `String#match` is stateless and the constants are safe to share.
 */
export const LAUNCHER_QUOTA_KICKOFF_DROP_RE =
  /psu-pty-host:\s+launch kickoff DROPPED for [^\n()]{1,200}\s+\(submit verification aborted \(quota-blocked\) within \d+ms over \d+ attempt\(s\)\)$/im;
export const LAUNCHER_KICKOFF_DROP_RE =
  /psu-pty-host:\s+launch kickoff DROPPED for [^\n()]{1,200}\s+\((?!submit verification aborted \(quota-blocked\))[^\n]{1,240}? within \d+ms over \d+ attempt\(s\)\)$/im;

export function classifyAcceptanceGraderTerminalFailure(
  rawLog: string,
  {
    allowStandaloneWeeklyLimit = false,
    allowInferenceGatewayError = false,
    allowGatewayErrorWithoutFooter = false,
    allowLauncherQuotaDrop = false,
    allowLauncherWalledPoolRefusal = false,
    allowLauncherKickoffDrop = false,
    allowToolSurfaceRefusal = false,
    allowGradingAuditRefusal = false,
  }: {
    allowStandaloneWeeklyLimit?: boolean;
    allowInferenceGatewayError?: boolean;
    /** Controlled-launch opt-in for an exact gateway screen that never reaches a completed-turn footer. */
    allowGatewayErrorWithoutFooter?: boolean;
    allowLauncherQuotaDrop?: boolean;
    /**
     * EI-22978598482930667: psu REFUSES a launch whose auto-route pool is
     * provably walled and exits 78
     * rather than spawning a doomed agent. That refusal is terminal for the
     * mission, but nothing classified it, so a fire-and-forget dispatcher read a
     * refused launch as a LAUNCHED one and held its reservation until the TTL.
     * Opt-in for the same reason as the siblings above: a general acceptance
     * brief can quote launcher diagnostics in its frozen evidence.
     */
    allowLauncherWalledPoolRefusal?: boolean;
    /**
     * WI-10002903: psu-pty-host's non-quota `launch kickoff DROPPED` receipt
     * (e.g. "the child never settled to its prompt"). Terminal only when the log
     * also shows no first-turn progress, so a judge whose kickoff did land is
     * never retired. Opt-in: frozen evidence may quote launcher diagnostics.
     */
    allowLauncherKickoffDrop?: boolean;
    allowToolSurfaceRefusal?: boolean;
    allowGradingAuditRefusal?: boolean;
  } = {},
): AcceptanceGraderTerminalFailure | null {
  const normalized = normalizeAcceptanceGraderLog(rawLog);
  const legacyQuota = normalized.match(
    /You've reached your [^\n]{1,120} limit\.[\s\S]{0,240}?Run \/usage-credits to continue or switch models with \/model\./i,
  );
  // EI-22453936824523023: Claude's newer session-limit screen no longer uses
  // the legacy "reached ... limit / switch models" copy. Keep both the exact
  // terminal headline AND one of its recovery prompts in the match: the
  // headline alone can appear in frozen incident evidence, while the paired
  // screen copy is the observable that this running judge cannot grade.
  const sessionQuota = normalized.match(
    /You've hit your session limit\s*·\s*resets [^\n]{1,120}[\s\S]{0,480}?(?:\/usage-credits to finish what you(?:'|’)re working on\.|\/limit-reset to reset your session limit now)/i,
  );
  // EI-22591830493584927: one Claude account tier emits ONLY this headline,
  // with no recovery prompt. It is unsafe for acceptance's frozen-evidence
  // prompt (the phrase can be quoted there), so recognition is explicit and
  // reserved for controlled briefs such as the grading-integrity dispatcher.
  const standaloneWeeklyQuota = allowStandaloneWeeklyLimit
    ? normalized.match(/You've hit your weekly limit\s*·\s*resets [^\n]{1,120}/i)
    : null;
  const quota = legacyQuota ?? sessionQuota ?? standaloneWeeklyQuota;
  if (quota) {
    return {
      code: 'model_quota_exhausted',
      evidence: quota[0].replace(/\s+/g, ' ').trim().slice(0, 400),
    };
  }

  // WI-10000940: psu-pty-host deliberately preserves a general interactive
  // session when its launch kickoff hits a quota wall so discovery can recycle
  // it later. A fire-and-forget grading auditor has no such recovery owner: the
  // host remains kernel-live, the launch dedupes forever, and the audit
  // reservation never settles. Recognize only the host-owned terminal receipt,
  // only for controlled callers, and reuse the existing quota fallback path.
  const launcherQuotaDrop = allowLauncherQuotaDrop ? normalized.match(LAUNCHER_QUOTA_KICKOFF_DROP_RE) : null;
  if (launcherQuotaDrop) {
    return {
      code: 'model_quota_exhausted',
      evidence: launcherQuotaDrop[0].replace(/\s+/g, ' ').trim().slice(0, 400),
    };
  }

  // WI-10002903 (second leg): the same host-owned receipt for every NON-quota
  // reason ("the child never settled to its prompt", "never emitted its
  // startup-ready marker", …). The host has given up: the judge never received
  // its brief and never will, yet the PTY stays kernel-live, so a live-task
  // guard deduped to it for the whole reservation (observed 07:39Z on
  // EI-24118203560334206). The quota variant is excluded here so it keeps its
  // dedicated code and backoff above, and a log that shows any first-turn
  // progress is never retired on this signal alone.
  const launcherKickoffDrop = allowLauncherKickoffDrop ? normalized.match(LAUNCHER_KICKOFF_DROP_RE) : null;
  if (launcherKickoffDrop && !hasAcceptanceGraderFirstTurnProgress(normalized)) {
    return {
      code: 'launch_kickoff_dropped',
      evidence: launcherKickoffDrop[0].replace(/\s+/g, ' ').trim().slice(0, 400),
    };
  }

  // EI-22978598482930667: the launcher's walled-pool refusal (exit 78) is the
  // OTHER half of the same quota wall, and it is the only terminal receipt that
  // carries a machine-readable recovery instant. Match only as far as the
  // horizon clause so the 400-char evidence slice can never drop it — the
  // dispatcher's reset-aware backoff reads the instant back out of this string.
  const launcherWalledPoolRefusal = allowLauncherWalledPoolRefusal
    ? normalized.match(
        /psu: REFUSING TO LAUNCH [—-] [^\n]{1,240}?(?:earliest known recovery \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z|earliest recovery unknown)/i,
      )
    : null;
  if (launcherWalledPoolRefusal) {
    return {
      code: 'model_quota_exhausted',
      evidence: launcherWalledPoolRefusal[0].replace(/\s+/g, ' ').trim().slice(0, 400),
    };
  }

  // EI-22707978312331135 / EI-22785693779266633 / WI-10000940: a headless Claude turn can terminate on a gateway error,
  // render its completed-turn footer, and return to an idle prompt while the
  // enclosing process stays alive. The process ledger therefore says "running"
  // forever, and an idempotent recovery launch dedupes back to the same dead
  // mission. Require BOTH the exact gateway screen and Claude's completed-turn
  // footer, and keep recognition opt-in so quoted error prose in a general frozen
  // acceptance prompt cannot retire a healthy grader.
  const codexOAuthInvalidRefreshError = allowInferenceGatewayError
    ? normalized.match(
        /API Error:\s*(?:unexpected status\s+)?502 Bad Gateway:\s+inference-gateway:\s+codex OAuth token refresh failed:[\s\S]{0,600}?refresh_token_invalidated[\s\S]{0,800}?✻\s*\p{L}{3,24}\s+for [^\n]{1,120}?\s*·\s*done\b/iu,
      )
    : null;
  if (codexOAuthInvalidRefreshError) {
    return {
      code: 'inference_gateway_error',
      evidence: codexOAuthInvalidRefreshError[0].replace(/\s+/g, ' ').trim().slice(0, 400),
    };
  }

  // EI-24761061357755499: a routed judge can land on a model/backend that
  // rejects the system-role frame before the grading brief is processed. The
  // interactive PTY remains live at its prompt after the completed error turn,
  // so task liveness is not mission liveness and the audit repair otherwise
  // dedupes to this dead mission forever. Keep this inside the controlled
  // inference-error opt-in: general acceptance evidence may quote the same
  // provider error, while the grading-integrity brief cannot.
  const unsupportedSystemRole = allowInferenceGatewayError
    ? normalized.match(
        /API Error:\s*400\s+role\s+['"]system['"]\s+is not supported on this model[\s\S]{0,800}?✻\s*\p{L}{3,24}\s+for [^\n]{1,120}?\s*·\s*done\b/iu,
      )
    : null;
  if (unsupportedSystemRole) {
    return {
      code: 'inference_gateway_error',
      evidence: unsupportedSystemRole[0].replace(/\s+/g, ' ').trim().slice(0, 400),
    };
  }

  const gatewayError = allowInferenceGatewayError
    ? normalized.match(
        /API Error:\s*(?:5\d{2}\s+inference-gateway internal error\.|Request rejected \(429\)(?:\s*·\s*inference-gateway:\s*(?:all accounts\s+throttled|account\s+'[^'\n]{1,120}'\s+paced\/paused);\s*retry after \d+s|\s+This request would exceed your\s+account(?:'|’)s rate limit\.\s*Please try again later\.))[\s\S]{0,800}?✻\s*\p{L}{3,24}\s+for [^\n]{1,120}?\s*·\s*done\b/iu,
      ) ??
      (allowGatewayErrorWithoutFooter
        ? normalized.match(
            /API Error:\s*(?:5\d{2}\s+inference-gateway internal error\.|Request rejected \(429\)(?:\s*·\s*inference-gateway:\s*(?:all accounts\s+throttled|account\s+'[^'\n]{1,120}'\s+paced\/paused);\s*retry after \d+s|\s+This request would exceed your\s+account(?:'|’)s rate limit\.\s*Please try again later\.))/i,
          )
        : null)
    : null;
  if (gatewayError) {
    return {
      code: 'inference_gateway_error',
      evidence: gatewayError[0].replace(/\s+/g, ' ').trim().slice(0, 400),
    };
  }

  // EI-24166843217052865: a headless grading auditor can finish its turn by
  // explicitly declining the mission because its platform tools are absent,
  // then sit at a live manual prompt. That task must not suppress every later
  // repair. Require the refusal, its concrete tool-surface cause, and the
  // completed-turn footer. Only controlled grading-audit briefs opt in: a
  // general grader may quote the same prose in frozen evidence.
  const lastAssistantAnswer = normalized.slice(normalized.lastIndexOf('●'));
  const toolSurfaceRefusal = allowToolSurfaceRefusal
    ? lastAssistantAnswer.match(
        /(?:(?:didn't|did not)\s+grade scorecard\s+EI-[A-Za-z0-9-]+[\s\S]{0,300}?(?:didn't|did not)\s+emit a\s+grading-integrity audit|haven(?:'|’)t\s+graded or emitted anything for scorecard\s+EI-[A-Za-z0-9-]+)[\s\S]{0,1800}?(?:platform tools (?:aren't|are not) loaded|no platform tools loaded|no way to reach the\s+platform)[\s\S]{0,6000}?✻\s*\p{L}{3,24}\s+for [^\n]{1,120}?\s*·\s*done\b/iu,
      )
    : null;
  // WI-10003331: PTY redraws can join words and damage the duration prose
  // (observed: "Crunched fo 12s ·done2:29 PM"). The duration is not evidence
  // of refusal. Require the latest assistant's explicit no-audit/no-scorecard
  // statement, a concrete missing-tools cause, and the completed-turn marker.
  // Earlier refusals cannot retire an auditor that has since resumed.
  const compactAnswer = lastAssistantAnswer.replace(/\s+/g, '');
  const compactToolSurfaceRefusal = allowToolSurfaceRefusal &&
    /^●Ihaven(?:'|’)t(?:audited|graded)scorecardEI-[A-Za-z0-9-]+andemittednoscorecard\./i.test(compactAnswer) &&
    /(?:sessiondoesn(?:'|’)thavethetools|noplatformtoolsloaded|nowaytoreachtheplatform|toolsearchfoundnothing)/i.test(compactAnswer) &&
    /✻[^●✻❯]{1,160}·done(?=\d|❯|$)/u.test(compactAnswer);
  if (toolSurfaceRefusal || compactToolSurfaceRefusal) {
    return {
      code: 'tool_surface_unavailable',
      evidence: (toolSurfaceRefusal?.[0] ?? lastAssistantAnswer).replace(/\s+/g, ' ').trim().slice(0, 400),
    };
  }
  // A one-shot auditor may explicitly finish without an emit while its PTY and
  // task-ledger heartbeat stay live. The controlled audit brief cannot contain
  // this final answer. Require the auditor's own answer marker and completed
  // turn footer; a quoted error or a still-working turn is not terminal proof.
  const gradingAuditRefusal = allowGradingAuditRefusal
    ? lastAssistantAnswer.match(
        /●\s+I (?:didn't|did not) emit an audit\b(?:(?!●\s)[\s\S]){0,6000}?\b(?:server refused|audit would be refused|Why I stopped)\b(?:(?!●\s)[\s\S]){0,6000}?✻\s*\p{L}{3,24}\s+for [^\n]{1,120}?\s*·\s*done\b/iu,
      )
    : null;
  if (gradingAuditRefusal) {
    return {
      code: 'grading_audit_refused',
      evidence: gradingAuditRefusal[0].replace(/\s+/g, ' ').trim().slice(0, 400),
    };
  }
  return null;
}

/**
 * True when a normalized judge log shows ANY sign the judge entered its first
 * turn: a platform tool it would call, an MCP/tool-use trace, a thinking/working
 * spinner, or a transcript bullet. Shared by startup-stall and kickoff-drop
 * classifiers plus the TTL-bounded stale-live-task check, so none can retire a
 * judge that actually started.
 */
function hasAcceptanceGraderFirstTurnProgress(normalized: string): boolean {
  return (
    /scorecards:emit|rubrics:get|plans:get|work_items:get|papercusp(?:\.tools:invoke|\/tools:invoke)|\bmcp__|PostToolUse hook|\btool(?:_use| call| invocation)\b/i.test(
      normalized,
    ) ||
    /\b(?:Thinking|Working)\s*(?:\(|·)/.test(normalized) ||
    /^\s*[•└├]\s+/m.test(normalized)
  );
}

/**
 * Candidate-only classifier for the exact Claude startup wedge observed in
 * EI-21646725695632868. Duration is deliberately owned by
 * `detectAcceptanceGraderTerminalFailure`; this pure helper only says whether
 * the current tail is still the connection screen and has no evidence that the
 * judge entered its first turn. False negatives are safer than broad matching:
 * frozen plan evidence shares the same log, so generic "connecting" prose must
 * never retire a healthy judge.
 */
export function classifyAcceptanceGraderStartupStall(rawLog: string): AcceptanceGraderTerminalFailure | null {
  const normalized = normalizeAcceptanceGraderLog(rawLog);
  const connecting = normalized.match(/(?:^|\n)\s*\/rc\s+connecting(?:…|\.{3})/i);
  if (!connecting) return null;

  if (hasAcceptanceGraderFirstTurnProgress(normalized)) return null;

  const overload = normalized.match(/the MCP proxy is overloaded; retrying[^\n]{0,160}/i);
  const evidence = [connecting[0], overload?.[0]]
    .filter((value): value is string => Boolean(value))
    .join(' · ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400);
  return { code: 'startup_connection_stalled', evidence };
}

/**
 * A live task can outlast the grading reservation while its CLI is still
 * parked in startup UI. Process liveness is not first-turn progress: retire
 * only when the task itself and its log have both been quiet for the caller's
 * bounded stale window and the log contains no evidence that grading began.
 *
 * This is candidate-only. Callers must first check explicit terminal receipts,
 * and should keep this opt-in at the stale-live-task recovery seam.
 */
export function classifyAcceptanceGraderNoFirstTurnStall(
  rawLog: string,
  {
    startedAt,
    logMtimeMs,
    nowMs,
    staleAfterMs,
  }: {
    startedAt: string;
    logMtimeMs: number | null;
    nowMs: number;
    staleAfterMs: number;
  },
): AcceptanceGraderTerminalFailure | null {
  const quiet = measureAcceptanceGraderQuietWindow({ startedAt, logMtimeMs, nowMs, staleAfterMs });
  if (!quiet) return null;

  const normalized = normalizeAcceptanceGraderLog(rawLog);
  if (!normalized.trim() || hasAcceptanceGraderFirstTurnProgress(normalized)) return null;

  return {
    code: 'startup_first_turn_stalled',
    evidence:
      `no first-turn progress; task age ${quiet.taskAgeMs}ms and ` +
      `grading log quiet for ${quiet.quietMs}ms`,
  };
}

interface AcceptanceGraderQuietWindowInput {
  startedAt: string;
  logMtimeMs: number | null;
  nowMs: number;
  staleAfterMs: number;
}

/**
 * Both the task AND its log must be older than `staleAfterMs`, measured on sane clocks.
 * A live judge keeps writing its log (Claude's spinner and Codex's `Working ·` status
 * tick while a turn or a long tool call runs), so a quiet log is the precondition every
 * TTL-bounded live-task classifier shares. Any unmeasurable input answers null, which
 * keeps the task: missing evidence is never permission to kill.
 */
function measureAcceptanceGraderQuietWindow({
  startedAt,
  logMtimeMs,
  nowMs,
  staleAfterMs,
}: AcceptanceGraderQuietWindowInput): { taskAgeMs: number; quietMs: number } | null {
  const startedAtMs = Date.parse(startedAt);
  const measuredLogMtimeMs =
    typeof logMtimeMs === 'number' && Number.isFinite(logMtimeMs) ? logMtimeMs : null;
  if (
    !Number.isFinite(startedAtMs) ||
    measuredLogMtimeMs === null ||
    !Number.isFinite(nowMs) ||
    !Number.isFinite(staleAfterMs) ||
    staleAfterMs <= 0 ||
    startedAtMs > nowMs ||
    measuredLogMtimeMs < startedAtMs - 5_000 ||
    measuredLogMtimeMs > nowMs + 5_000 ||
    nowMs - startedAtMs < staleAfterMs ||
    nowMs - measuredLogMtimeMs < staleAfterMs
  ) {
    return null;
  }
  return {
    taskAgeMs: Math.floor(nowMs - startedAtMs),
    quietMs: Math.floor(nowMs - measuredLogMtimeMs),
  };
}

/**
 * Completed-turn markers of the two judge CLIs, matched on whitespace-stripped text
 * because PTY redraws join and split words (WI-10003331). Claude ends a turn with
 * `✻ <Verb> for <duration> · done`. Codex prints `Worked for <duration>` and flips its
 * status bar to `Ready ·` (observed in task 0muqeanqadsbkcjglk2's log:
 * `Worked for 20m 18s • 11:40 PMReady ·GPT-5.6-Sol high`).
 */
const COMPLETED_TURN_MARKERS: readonly RegExp[] = [
  /✻[^●✻❯]{1,160}·done/gu,
  /Workedfor\d+[hms][^●✻❯]{0,120}?Ready·/gu,
];

/** Turn activity that, AFTER the last completed-turn marker, means the judge resumed. */
const RESUMED_TURN_ACTIVITY = /●|Working·|Working\(|Thinking·|Thinking\(|esctointerrupt/u;

/**
 * WI-10005295: a grading auditor that completed its turn and then sat idle at its prompt
 * past `staleAfterMs`. Without this, a live-task guard keeps any such task "viable" and
 * dedupes every later repair to it until a human kills it, whatever the reason the
 * auditor stopped without emitting. The caller owns the "card still pending" premise:
 * it only consults this for a pending audit's live task.
 *
 * Deliberately narrower than "idle": the latest turn-state in the log must be a
 * completed-turn marker with no resumed activity after it, so a judge hung mid-turn
 * (spinner frozen) or still inside a turn is not classified here.
 */
export function classifyAcceptanceGraderParkedWithoutEmit(
  rawLog: string,
  input: AcceptanceGraderQuietWindowInput,
): AcceptanceGraderTerminalFailure | null {
  const quiet = measureAcceptanceGraderQuietWindow(input);
  if (!quiet) return null;

  const compact = normalizeAcceptanceGraderLog(rawLog).replace(/\s+/g, '');
  let markerStart = -1;
  let markerEnd = -1;
  for (const pattern of COMPLETED_TURN_MARKERS) {
    for (const match of compact.matchAll(pattern)) {
      const end = match.index + match[0].length;
      if (end > markerEnd) {
        markerStart = match.index;
        markerEnd = end;
      }
    }
  }
  if (markerEnd < 0) return null;
  if (RESUMED_TURN_ACTIVITY.test(compact.slice(markerEnd))) return null;

  return {
    code: 'parked_without_emit',
    evidence:
      `completed its turn and parked without emitting; task age ${quiet.taskAgeMs}ms, ` +
      `log quiet for ${quiet.quietMs}ms; last marker ${compact.slice(markerStart, markerEnd).slice(0, 120)}`,
  };
}

/** Read a grader log's mtime without turning a missing/unreadable file into evidence. */
export function readAcceptanceGraderLogMtimeMs(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

export function readAcceptanceGraderLogTail(path: string): string {
  let fd: number | null = null;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const length = Math.min(size, ACCEPTANCE_GRADER_LOG_TAIL_BYTES);
    if (length <= 0) return '';
    const buffer = Buffer.allocUnsafe(length);
    const read = readSync(fd, buffer, 0, length, Math.max(0, size - length));
    return buffer.toString('utf8', 0, read);
  } catch {
    return '';
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* already closed */
      }
    }
  }
}

const trim = (value: unknown, max: number): string | null =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;

/** Shared label algebra: scorecards:emit uses this exact prefix to reap the judge. */
export function acceptanceGraderLabelPrefix(rubricRef: string): string {
  const safe = rubricRef
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72);
  return `acceptance-grader:${safe || 'rubric'}:`;
}

export function compactSnapshot(input: {
  plan: NonNullable<Awaited<ReturnType<typeof readPlanBySlug>>>;
  rubric: NonNullable<Awaited<ReturnType<typeof getAcceptanceRubricForPlan>>>;
  audit: NonNullable<Awaited<ReturnType<typeof getLatestPlanAudit>>>;
  workItems: Awaited<ReturnType<typeof listWorkItems>>;
}) {
  const { row } = input.plan;
  const rubric = input.rubric as unknown as Record<string, unknown>;
  const criteria = Array.isArray(rubric.criteria) ? rubric.criteria : [];
  return {
    frozenAt: new Date().toISOString(),
    plan: {
      slug: row.planSlug,
      workspaceId: row.workspaceId,
      harnessSlug: row.harnessSlug,
      version: row.version,
      contentHash: row.contentHash,
      items: row.items.map((i) => ({ id: i.id, status: i.status, text: trim(i.text, 180) })),
      decisions: row.decisions.map((d) => ({ id: d.id, title: trim(d.title, 120), body: trim(d.body, 260) })),
    },
    rubric: {
      rubricId: rubric.rubricId,
      title: trim(rubric.title, 180),
      proposedBy: rubric.proposedBy ?? rubric.createdBy ?? null,
      criteria: criteria.map((raw) => {
        const c = (raw ?? {}) as Record<string, unknown>;
        return { key: c.key, title: trim(c.title ?? c.label, 120), description: trim(c.description, 260) };
      }),
    },
    audit: {
      auditSeq: input.audit.auditSeq,
      createdBy: input.audit.createdBy,
      auditedSha: input.audit.auditedSha,
      summary: trim(input.audit.summary, 500),
      coverage: summarizeCoverage(input.audit.items),
      items: input.audit.items.map((i) => ({
        itemId: i.itemId,
        verdict: i.verdict,
        citations: i.citations.map((c) => ({ kind: c.kind, path: c.path, line: c.line, symbol: c.symbol })),
      })),
    },
    terminalWork: input.workItems.map((w) => ({
      id: w.id,
      state: w.state,
      title: trim(w.title, 140),
      terminalOwner: w.terminalOwner,
      completionRef: trim(w.terminalCompletionRef, 220),
      evidence: w.terminalCompletionEvidence,
    })),
  };
}

export const ACCEPTANCE_SNAPSHOT_CAP_CHARS = 5_800;

/**
 * What a truncated package MUST tell the judge. Without it a judge cannot tell
 * "this field is empty" from "this field was deleted to fit a cap", so it stalls
 * instead of reporting the gap (EI-21615102901369580).
 */
const DEGRADED_SNAPSHOT_NOTICE =
  'TRUNCATED EVIDENCE PACKAGE. Every field named in droppedFields is ABSENT FROM THIS SNAPSHOT. ' +
  'That absence is a limit of this package, NOT evidence that the underlying record is empty. ' +
  'Do NOT rate a criterion from that absence. Follow recovery before returning NOT GRADED; if a ' +
  'canonical read fails or its identity differs from frozenIdentity, name that exact gap and grade the rest.';

/**
 * Fit the frozen evidence package under the size cap.
 *
 * Degrades PROGRESSIVELY and BY VALUE — stopping at the first stage that fits — and
 * always stamps `contextIntegrity` when anything was surrendered.
 *
 * EI-21615102901369580: the previous implementation jumped straight from "full" to a
 * maximally-stripped shape that deleted `audit.items[].citations`, plan item text,
 * decision bodies and terminal-work evidence in a single blanket step, with no marker
 * of any kind. Those are exactly the bytes a grader needs — the class rubrics require
 * it to spot-check the implementer's audit citations — so a judge over the cap got a
 * package that looked complete, carried no evidence, and could only stall. Citations
 * are therefore surrendered LAST, and never silently.
 */
export function boundedSnapshotJson(snapshot: ReturnType<typeof compactSnapshot>): string {
  const cap = ACCEPTANCE_SNAPSHOT_CAP_CHARS;
  const full = JSON.stringify(snapshot);
  if (full.length <= cap) return full;

  const working: Record<string, unknown> = { ...snapshot };
  const dropped: string[] = [];
  const plan = () => working.plan as Record<string, unknown>;
  const audit = () => working.audit as Record<string, unknown>;
  const recovery = {
    frozenIdentity: {
      planVersion: snapshot.plan.version,
      planContentHash: snapshot.plan.contentHash,
      auditSeq: snapshot.audit.auditSeq,
    },
    rule:
      'Before NOT GRADED, recover only with these read-only Papercusp tools. Use recovered evidence only ' +
      'when plans:get still reports frozenIdentity and the completion audit sequence matches.',
    reads: {
      plan: {
        tool: 'plans:get',
        args: {
          slug: snapshot.plan.slug,
          harness: snapshot.plan.harnessSlug,
          mode: 'full',
          shipReadiness: true,
        },
      },
      specEvidence: {
        tool: 'plans:get-spec-evidence',
        args: { slug: snapshot.plan.slug, harness: snapshot.plan.harnessSlug, limit: 500 },
      },
      terminalWork: {
        tool: 'work_items:get',
        args: { harness: snapshot.plan.harnessSlug, detail: true, threadLimit: 10 },
        idsFrom: 'terminalWork[].id',
        payloadTier: "pass 'full' through tools:invoke",
      },
    },
  };
  const render = (): string =>
    JSON.stringify({
      ...working,
      contextIntegrity: {
        degraded: true,
        fullChars: full.length,
        capChars: cap,
        droppedFields: [...dropped],
        notice: DEGRADED_SNAPSHOT_NOTICE,
        recovery,
      },
    });

  // Least decision-relevant bytes first; the grader's spot-check material last.
  const steps: Array<{ label: string; apply: () => void }> = [
    {
      label: 'terminalWork[].evidence',
      apply: () => {
        working.terminalWork = snapshot.terminalWork.map((w) => ({
          id: w.id,
          state: w.state,
          title: w.title,
          terminalOwner: w.terminalOwner,
          completionRef: w.completionRef,
        }));
      },
    },
    {
      label: 'plan.decisions[].body shortened to 120 chars',
      apply: () => {
        working.plan = {
          ...plan(),
          decisions: snapshot.plan.decisions.map((d) => ({ ...d, body: trim(d.body, 120) })),
        };
      },
    },
    {
      label: 'plan.items[].text shortened to 90 chars',
      apply: () => {
        working.plan = { ...plan(), items: snapshot.plan.items.map((i) => ({ ...i, text: trim(i.text, 90) })) };
      },
    },
    {
      label: 'audit.summary shortened to 200 chars',
      apply: () => {
        working.audit = { ...audit(), summary: trim(snapshot.audit.summary, 200) };
      },
    },
    {
      label: 'rubric.criteria[].description shortened to 120 chars',
      apply: () => {
        working.rubric = {
          ...(working.rubric as Record<string, unknown>),
          criteria: snapshot.rubric.criteria.map((c) => ({ ...c, description: trim(c.description, 120) })),
        };
      },
    },
    {
      label: 'terminalWork[].title',
      apply: () => {
        working.terminalWork = snapshot.terminalWork.map((w) => ({
          id: w.id,
          state: w.state,
          terminalOwner: w.terminalOwner,
          completionRef: w.completionRef,
        }));
      },
    },
    {
      label: 'plan.decisions[].body',
      apply: () => {
        working.plan = { ...plan(), decisions: snapshot.plan.decisions.map((d) => ({ id: d.id, title: d.title })) };
      },
    },
    {
      label: 'plan.items[].text',
      apply: () => {
        working.plan = { ...plan(), items: snapshot.plan.items.map((i) => ({ id: i.id, status: i.status })) };
      },
    },
    {
      label: 'terminalWork[].terminalOwner/completionRef',
      apply: () => {
        working.terminalWork = snapshot.terminalWork.map((w) => ({ id: w.id, state: w.state }));
      },
    },
    {
      label: 'audit.items[].citations — LAST RESORT: the grader can no longer spot-check the audit',
      apply: () => {
        working.audit = {
          ...audit(),
          items: snapshot.audit.items.map((i) => ({ itemId: i.itemId, verdict: i.verdict })),
        };
      },
    },
  ];

  for (const step of steps) {
    const candidate = render();
    if (candidate.length <= cap) return candidate;
    step.apply();
    dropped.push(step.label);
  }
  return render();
}

/**
 * D-009 (get-feedback-relevance-consults-2026-08-16, P-011) — discovery-FIRST
 * grader resolution: route the plan + acceptance rubric through the relevance
 * router with the independence exclusion set (implementers + heavy consult
 * participants + rubric author + shipper).
 *
 * SUPERSEDED IN ONE RESPECT by
 * unified-responder-selection-critique-and-grading-2026-08-30 D-001/D-002/D-003
 * [owner]: this no longer resolves ONE above-floor grader. It resolves a MENU
 * bounded by the shared ACCEPTANCE_GRADING_POLICY (see `selection-policies.ts`
 * for the current min/max), below-floor MINIMUM-FILLS rather than minting a
 * fresh session, and delivery is a cascade —
 * only the head is woken here. Fresh-mint survives strictly for an EMPTY menu
 * (nobody eligible, nobody reachable, or relevance unmeasurable). Discovery is
 * still a service, never a new failure mode: any discovery fault falls through
 * to the fresh launch.
 *
 * Same signature as launchAcceptanceGrader so the set-plan-status seam can use
 * either interchangeably (its tests inject their own).
 */
type GraderDiscoveryResult = {
  verdict: 'assigned' | 'fresh';
  /** The ordered menu, head first. Empty exactly when verdict is 'fresh'. */
  graders: AssignedGrader[];
  /** The snapshot to persist on the cascade row (menu provenance + fill pool).
   * Absent when the menu is empty — there is no cascade to open. */
  routing?: unknown;
  excluded: string[];
  /** D-008 party-collapse audit trail; absent when party resolution faulted. */
  partyCollapsed?: string[];
  eligibility?: GraderEligibility;
  escalation?: GraderEscalation;
  freshReason?: 'no_eligible_non_excluded' | 'all_eligible_unselectable' | 'degraded';
};

/**
 * Discovery must exclude the same current-revision vetting critics that the
 * scorecard writer later refuses. The shared resolver covers both supported
 * vetting channels (consult and work-item), so routing cannot select a critic
 * merely because their critique was recorded on a work item instead of in a
 * consult conversation.
 */
/** The plan-level scope a grading DECLINE is remembered against. */
export interface GradingDeclineScope {
  workspaceId: string;
  planSlug: string;
}

/**
 * WI-10002369: every agent who EXPLICITLY declined a grading cascade for this
 * plan+rubric.
 *
 * The router already supports exactly this (`ConsultRouteParams.excludeOwners`
 * — D-007(7): "a decliner is excluded on the requester's re-call, never
 * auto-cascaded"), and `consult:decline`'s own terminal hint tells the
 * requester that "a fresh consult:get_feedback re-routes". That design puts the
 * remembering on the REQUESTER. For acceptance grading the requester is the
 * system sweep, which never remembered anything — so each
 * `plans:set-plan-status` opened a virgin cascade and re-offered the same
 * agent. MEASURED on plan bash-substitution-reachable-ceiling-2026-08-01:
 * su-c03852cb declined conv-mucapfpl at 06:40:52Z and was re-selected by
 * conv-mucb58ib at 06:43:14Z, which then expired.
 *
 * ⚠ Read the decline from `consult_post_meta`, NOT from the two surfaces that
 * look equivalent and are not:
 *  - `consult_state.responder_id` ADVANCES PAST the decliner (always-advance,
 *    D-005). On all three cascades above it reads su-cb56af59 — an agent who
 *    never declined anything. Excluding on it excludes the wrong person.
 *  - `consult_state.cascade_digest` is capped at CASCADE_DIGEST_MAX_ENTRIES
 *    (16, `cascade-core.ts` — `.slice(-16)`), so a long cascade silently drops
 *    its oldest entries. A dropped decline is an under-report, and an
 *    under-reported decliner is re-offered: the exact bug this resolves.
 * `consult_post_meta` is one immutable row per decline post and is neither
 * truncated nor advanced.
 *
 * Scoped to explicit declines only. An `expired` no-show is deliberately NOT
 * treated as a refusal: the agent may simply have been asleep, and the expiry
 * sweep already retries that case.
 */
export async function resolvePriorGradingDecliners(
  scope: GradingDeclineScope,
  rubricId: string,
): Promise<string[]> {
  const { getOrgPg } = await import('@papercusp/db-org');
  const rows = (await getOrgPg().sql`
    SELECT DISTINCT pm.author_id AS owner_id
      FROM harness_shared.consult_post_meta pm
      JOIN harness_shared.consult_state cs
        ON cs.workspace_id = pm.workspace_id
       AND cs.conversation_id = pm.conversation_id
     WHERE pm.workspace_id = ${scope.workspaceId}
       AND pm.kind = 'decline'
       AND pm.author_id IS NOT NULL
       AND cs.routing -> 'cascade' ->> 'flavor' = ${GRADING_CASCADE_FLAVOR}
       AND cs.routing -> 'cascade' ->> 'planSlug' = ${scope.planSlug}
       AND cs.routing -> 'cascade' ->> 'rubricId' = ${rubricId}
  `) as unknown as Array<{ owner_id: string }>;
  return rows.map((row) => row.owner_id);
}

/**
 * EI-24402913315950329 — the discovery exclusion set must be a SUPERSET of every
 * identity `scorecards:emit` would refuse as a grader, or the router recruits a
 * grader who boots, reads the plan and is then refused (or, correctly, declines).
 * Measured on declared-gate-recovery-contract-2026-09-21: the recruiter read
 * vetting critics with (rubricId, revision) only, so the rev-15 vetting card whose
 * currentness depends on criteriaHash/meaningRevision classified as not-current and
 * the sole critic was routed; and it omitted the principal-implementer population
 * the emit guard reads (plan audits, claimant history), so the implementer was
 * routed and forked. Both reads now use the emit guard's OWN functions and inputs.
 */
export async function resolveAcceptanceGraderDiscoveryExtraExclusions(
  rubric: {
    rubricId: string;
    revision?: number | null;
    criteriaHash?: string | null;
    barContract?: { meaningRevision?: number | null } | null;
    proposedBy?: string | null;
    createdBy?: string | null;
  },
  shipperId: string | null,
  /** Required, not optional-with-a-degrade: a missing scope would silently stop
   * excluding decliners, which is indistinguishable from the bug itself. */
  scope: GradingDeclineScope,
  readVettingCritics: typeof resolveAggregatedVettingCritics = resolveAggregatedVettingCritics,
  readPriorDecliners: typeof resolvePriorGradingDecliners = resolvePriorGradingDecliners,
  readPlanImplementers: (
    planSlug: string,
    opts: { workspaceId: string },
  ) => Promise<string[]> = resolvePlanImplementerIdentities,
): Promise<string[]> {
  // Infrastructure faults PROPAGATE here rather than degrading to "no
  // exclusions" — a swallowed read would re-offer to a decliner, and the
  // caller's own degrade path (`freshReason: 'degraded'`) is a fresh mint,
  // which is the safe outcome.
  const [{ critics }, decliners, implementers] = await Promise.all([
    readVettingCritics(
      rubric.rubricId,
      rubric.revision ?? null,
      rubric.criteriaHash ?? null,
      rubric.barContract?.meaningRevision ?? null,
    ),
    readPriorDecliners(scope, rubric.rubricId),
    readPlanImplementers(scope.planSlug, { workspaceId: scope.workspaceId }),
  ]);
  return [
    ...new Set(
      [rubric.proposedBy, rubric.createdBy, shipperId, ...implementers, ...critics, ...decliners]
        .filter((identity): identity is string => typeof identity === 'string')
        .map((identity) => identity.trim())
        .filter(Boolean),
    ),
  ];
}

/**
 * EI-24402913315950329 — the REAL ship-gate caller, carried through the
 * system-actor ctx rewrite in `launchAcceptanceGraderForGate`. That rewrite is
 * correct for launch LINEAGE (a fresh judge must descend from the system actor,
 * not the author), but it also replaced the identity `resolveShipperId` reads, so
 * the shipper D-009 excludes became `system:acceptance-grading-sweep` and the
 * actual shipper — routinely the implementer — stayed routable. This field is an
 * exclusion INPUT only; nothing grants authority from it.
 */
export interface AcceptanceShipperCarrier {
  acceptanceShipperOwnerId?: string | null;
  /** The scorecard the ship gate's BAR judged cohort-stale when it refused
   * `self_graded_only` (WI-10003286). The settlement read must not count it as a
   * settled independent grading, or the recruiter never re-dispatches the fresh
   * grading the gate asked for. An exclusion input only; it grants nothing. */
  acceptanceStaleGradingScorecardId?: string | null;
  /** Every independent scorecard the gate excluded as cohort-stale — the named one
   * plus each older independent card predating it. Excluding only the named id lets
   * the settlement read fall back to an older excluded card and report settled. */
  acceptanceStaleGradingScorecardIds?: readonly string[] | null;
  /** Set by the ship gate's recruit seam (`launchAcceptanceGraderForGate`) — it only
   * recruits on `self_graded_only` / `acceptance_ungraded`, i.e. when the gate has
   * ALREADY resolved identities and found no admissible independent grading. The
   * settlement read skips identity resolution by design, so on this path it must not be
   * allowed to override the gate (WI-10003286: it counted a 'role-…' card the gate
   * excluded and answered "settled" to every ship retry). An exclusion input only. */
  acceptanceGateFoundNoAdmissibleGrading?: boolean | null;
}

/** The union of the carried cohort-stale ids, trimmed and de-duplicated (WI-10003286). */
export function carriedStaleGradingCardIds(ctx: unknown): string[] {
  const carrier = (ctx ?? {}) as AcceptanceShipperCarrier;
  const raw = [carrier.acceptanceStaleGradingScorecardId, ...(carrier.acceptanceStaleGradingScorecardIds ?? [])];
  return [
    ...new Set(
      raw.filter((id): id is string => typeof id === 'string' && id.trim().length > 0).map((id) => id.trim()),
    ),
  ];
}

/** The caller of the ship gate — the shipper D-009 excludes. Null when unattributable;
 * the computed set still excludes implementers. */
export async function resolveShipperId(ctx: LaunchCtx): Promise<string | null> {
  const carried = (ctx as AcceptanceShipperCarrier).acceptanceShipperOwnerId;
  if (typeof carried === 'string' && carried.trim()) return carried.trim();
  try {
    const { resolveAgentIdentity } = await import('./agent-tools/coordination/identity');
    return resolveAgentIdentity(ctx as never).ownerId;
  } catch {
    return null;
  }
}

/** Prod wiring for the in-flight guard's holder check: the SAME exclusion set and
 * party collapse grader discovery applies, read only when a held request matched.
 * Injected as `deps.readIneligibleHolders` in tests — this default reaches the org PG. */
async function prodReadIneligibleGradingHolders(
  plan: NonNullable<Awaited<ReturnType<typeof readPlanBySlug>>>,
  rubric: NonNullable<Awaited<ReturnType<typeof getAcceptanceRubricForPlan>>>,
  ctx: LaunchCtx,
  holders: readonly string[],
): Promise<ReadonlySet<string>> {
  const [{ getOrgPg }, { computeGraderExclusions }, { lineagePartyKeys }] = await Promise.all([
    import('@papercusp/db-org'),
    import('./consult/acceptance-grader-select'),
    import('./acceptance-author-identity'),
  ]);
  const { workspaceId, planSlug } = plan.row;
  const sql = getOrgPg().sql;
  const extra = await resolveAcceptanceGraderDiscoveryExtraExclusions(
    rubric as unknown as Parameters<typeof resolveAcceptanceGraderDiscoveryExtraExclusions>[0],
    await resolveShipperId(ctx),
    { workspaceId, planSlug },
  );
  const excluded = await computeGraderExclusions(sql, workspaceId, planSlug, extra);
  const partyKeys = await lineagePartyKeys([...excluded, ...holders], { sql, workspaceId });
  return ineligibleGradingHolders(holders, excluded, partyKeys);
}

/** Prod discovery wiring: the P-002 router + embedder + liveness oracle behind
 * selectAcceptanceGrader. Injected as `deps.discover` in tests — this default
 * reaches the org PG, which a unit test must never do. */
async function prodDiscoverGrader(
  plan: NonNullable<Awaited<ReturnType<typeof readPlanBySlug>>>,
  rubric: NonNullable<Awaited<ReturnType<typeof getAcceptanceRubricForPlan>>>,
  ctx: LaunchCtx,
): Promise<GraderDiscoveryResult> {
  const [{ getOrgPg }, { routeConsult }, { buildQueryEmbedderResolved }, { resolveProseProfileSelection }, { resolveSessionStates }, { selectAcceptanceGrader }] =
    await Promise.all([
      import('@papercusp/db-org'),
      import('./consult/relevance-router'),
      import('./agent-tools/search/embedder'),
      import('./search/prose-vector-dims'),
      import('./agent-tools/coordination/liveness-oracle'),
      import('./consult/acceptance-grader-select'),
    ]);
  const { lineagePartyKeys } = await import('./acceptance-author-identity');
  const resolved = await buildQueryEmbedderResolved();
  const embeddingProfile = resolved
    ? resolveProseProfileSelection(resolved.mode, resolved.profile)
    : null;
  const r = rubric as unknown as {
    rubricId: string;
    revision?: number | null;
    title?: string;
    proposedBy?: string | null;
    createdBy?: string | null;
    criteria?: Array<{ key?: string; title?: string; model?: string }>;
  };
  const rubricText = [
    r.title ?? r.rubricId,
    ...(Array.isArray(r.criteria)
      ? r.criteria.map((c) => `${c.key ?? ''}: ${c.title ?? ''} ${c.model ?? ''}`.trim())
      : []),
  ].join('\n');
  const extraExclusions = await resolveAcceptanceGraderDiscoveryExtraExclusions(r, await resolveShipperId(ctx), {
    workspaceId: plan.row.workspaceId,
    planSlug: plan.row.planSlug,
  });
  const selection = await selectAcceptanceGrader(
    {
      workspaceId: plan.row.workspaceId,
      planSlug: plan.row.planSlug,
      planContent: plan.row.content,
      rubricText,
      extraExclusions,
    },
    {
      getSql: () => getOrgPg().sql,
      getCandidateRoles: async (workspaceId, ownerIds) => {
        if (ownerIds.length === 0) return new Map<string, string | null>();
        // coord:send admits only COORD_ROLES. Resolve the durable role in the
        // same workspace before allowing the router to assign a blocking ask;
        // absent rows/roles remain absent and are rejected by the selector.
        const rows = await getOrgPg().sql<Array<{ owner_id: string; agent_role: string | null }>>`
          SELECT owner_id, agent_role
            FROM harness_shared.coord_presence
           WHERE workspace_id = ${workspaceId}
             AND owner_id = ANY(${ownerIds}::text[])
        `;
        return new Map(rows.map((row) => [row.owner_id, row.agent_role] as const));
      },
      // D-008: one agent can hold several coordination identities, so the menu
      // has to be distinct by PARTY, not by ownerId. Same ledger the acceptance
      // gate already resolves scorecard authors through.
      getPartyKeys: (workspaceId, ownerIds) => lineagePartyKeys(ownerIds, { sql: getOrgPg().sql, workspaceId }),
      route: (params) =>
        routeConsult(params, {
          getSql: () => getOrgPg().sql,
          embed: resolved?.embed ?? null,
          embeddingProfile,
          embeddingMode: embeddingProfile && resolved ? resolved.mode : null,
          getLiveness: async (ownerIds) => {
            const verdicts = await resolveSessionStates(
              ownerIds.map((ownerId) => ({ ownerId })),
              { hydratePerId: true },
            );
            // WI-10002156: demote a `parked` verdict no live process backs, so
            // the cascade cannot assign grading to a reaped session.
            return Object.fromEntries(
              [...verdicts.values()].map((v) => [v.ownerId, selectableGraderLiveness(v)]),
            );
          },
        }),
    },
  );
  return {
    verdict: selection.verdict,
    graders: selection.graders.map((selected) => ({
      ownerId: selected.candidate.ownerId,
      score: selected.candidate.score,
      liveness: selected.candidate.liveness,
      via: selected.via,
    })),
    ...(selection.routing ? { routing: selection.routing } : {}),
    excluded: selection.excluded,
    ...(selection.partyCollapsed ? { partyCollapsed: selection.partyCollapsed } : {}),
    eligibility: selection.eligibility,
    ...(selection.escalation ? { escalation: selection.escalation } : {}),
    ...(selection.freshReason ? { freshReason: selection.freshReason } : {}),
  };
}

// The grader briefs live in consult/grading-cascade.ts alongside the CASCADE
// copy, so the first grader and the ones the cascade wakes cannot drift into
// being told different things. Re-exported here because this module is where
// every existing importer looks for them.
export { buildAssignedAcceptanceGraderBrief, buildMinimumFillAcceptanceGraderBrief } from './consult/grading-cascade';

/** What opening the grading cascade has to be told, and what it reports back. */
export interface OpenGradingCascadeParams {
  /** The PLAN's workspace, not the shipper's ambient context: the cascade row is
   * workspace-partitioned and every later trigger (the expiry sweep especially)
   * finds it by that partition. */
  workspaceId: string;
  planSlug: string;
  harnessSlug: string | null;
  rubricId: string;
  /** The ordered menu. Only the HEAD is woken; the tail is persisted for the
   * cascade to reach when the head replies, declines or expires. */
  graders: AssignedGrader[];
  /** The routing snapshot to persist (menu provenance + the refill pool). */
  routing: unknown;
  /** The durable typed assignment this cascade is servicing. */
  reservation?: AcceptanceReviewReservationRef;
}
export interface OpenGradingCascadeResult {
  conversationId: string;
  woke: number;
  status: 'active' | 'existing' | 'exhausted' | 'raced';
  /**
   * WI-10003786 — the session actually grading the cascade's CURRENT rank: the
   * fork/convert launched from the menu grader's transcript (R-11 / D-013), read
   * from where `stampAnsweringOwner` persists it. NOT `graders[k].ownerId` — that
   * is the transcript SOURCE, which is never woken and correctly stays parked.
   * Null when the current rank's dispatch produced no session (refused, still
   * booting before the stamp, or the read failed); absent from test doubles.
   */
  answeringOwnerId?: string | null;
}

/**
 * WI-10003786 — the answering session at the cascade's current rank, read from a
 * persisted routing snapshot: `routing.selection.selected[cursor].answeringOwnerId`,
 * the exact location `stampAnsweringOwner` writes. Pure so the read shape is pinned
 * by a unit test; tolerates a JSON-string column and any malformed shape (→ null).
 */
export function answeringOwnerAtCursor(routingRaw: unknown, cursor: unknown): string | null {
  let routing: unknown = routingRaw;
  if (typeof routing === 'string') {
    try {
      routing = JSON.parse(routing) as unknown;
    } catch {
      return null;
    }
  }
  if (typeof cursor !== 'number' || !Number.isInteger(cursor) || cursor < 0) return null;
  const selected = (routing as { selection?: { selected?: unknown } } | null)?.selection?.selected;
  if (!Array.isArray(selected)) return null;
  const owner = (selected[cursor] as { answeringOwnerId?: unknown } | null | undefined)?.answeringOwnerId;
  return typeof owner === 'string' && owner.length > 0 ? owner : null;
}

/**
 * WI-10003451 — how long after a grader's `answer` its cascade still counts as the
 * live dispatch. The grader brief says to emit the card FIRST and reply after, so an
 * answer normally post-dates the card it reports. The window only absorbs a grader
 * who replied before their emit landed: a re-dispatch in those minutes must not
 * route a second grader to a grading that is about to count (D-009 makes the
 * eligible pool non-replenishable, so a redundant grader is a permanent loss).
 */
export const GRADING_CASCADE_ANSWER_GRACE_MS = 10 * 60_000;

/**
 * WI-10003451 — has this OPEN grading cascade already SPENT its dispatch?
 *
 * The recruiter only reaches a cascade open after the settlement guard reported the
 * grading NOT decided, and both of its callers (the ship gate's
 * `acceptance_ungraded`/`self_graded_only` refusal and the stall sweep's gate read)
 * only recruit when no COUNTING independent card exists. So a cascade whose digest
 * already carries an `answer` produced a card that does not count — cohort-stale,
 * lineage-related or incomplete. It is not "the live dispatch" any more: its grader
 * finished, and nobody on its menu will be asked again. Treating it as live deduped
 * every re-dispatch onto a dead conversation until the expiry sweep closed it
 * (~4.5h), which is what stranded identities-v1-2026-08-30 on 2026-09-27 after its
 * evidence cohort moved under a finished grade.
 *
 * Returns the LATEST answer when it is older than the grace window, else null (no
 * answer, a malformed digest, or an answer that may still be about to count).
 */
export function spentGradingCascadeAnswer(
  digestRaw: unknown,
  nowMs: number,
  graceMs: number = GRADING_CASCADE_ANSWER_GRACE_MS,
): { ownerId: string; at: string } | null {
  let digest: unknown = digestRaw;
  if (typeof digest === 'string') {
    try {
      digest = JSON.parse(digest) as unknown;
    } catch {
      return null;
    }
  }
  if (!Array.isArray(digest)) return null;
  let latest: { ownerId: string; at: string; atMs: number } | null = null;
  for (const entry of digest) {
    const e = entry as { kind?: unknown; ownerId?: unknown; at?: unknown } | null;
    if (!e || e.kind !== 'answer' || typeof e.ownerId !== 'string' || typeof e.at !== 'string') continue;
    const atMs = Date.parse(e.at);
    if (!Number.isFinite(atMs)) continue;
    if (!latest || atMs > latest.atMs) latest = { ownerId: e.ownerId, at: e.at, atMs };
  }
  if (!latest || nowMs - latest.atMs < graceMs) return null;
  return { ownerId: latest.ownerId, at: latest.at };
}

/**
 * The dedupe half of {@link prodOpenGradingCascade}, split out so its database
 * behaviour is testable on real PG without the dispatch half (which launches a
 * session). Every open cascade matching this plan + rubric (+ reservation) is read;
 * each one whose answer already spent it ({@link spentGradingCascadeAnswer}) is
 * CLOSED as `closed_answered` with an outcome naming why, and the newest remaining
 * one is returned as the live dispatch. `liveConversationId: null` means the caller
 * must open a fresh cascade.
 *
 * The close is CAS-guarded on the same open states the read matched, so a
 * concurrent decline/expiry/advance that already moved the row wins and this
 * becomes a no-op for it.
 */
export async function reconcileOpenGradingCascades(
  params: Pick<OpenGradingCascadeParams, 'workspaceId' | 'planSlug' | 'rubricId' | 'reservation'>,
  deps: { nowMs?: number } = {},
): Promise<{
  liveConversationId: string | null;
  closedSpent: Array<{ conversationId: string; answeredBy: string; answeredAt: string }>;
}> {
  const { getOrgPg } = await import('@papercusp/db-org');
  const sql = getOrgPg().sql;
  const nowMs = deps.nowMs ?? Date.now();
  const rows = (await sql`
    SELECT conversation_id, cascade_digest
      FROM harness_shared.consult_state
     WHERE workspace_id = ${params.workspaceId}
       AND closed_at IS NULL
       AND state IN ('awaiting_responder', 'active')
       AND routing -> 'cascade' ->> 'flavor' = ${GRADING_CASCADE_FLAVOR}
       AND routing -> 'cascade' ->> 'planSlug' = ${params.planSlug}
       AND routing -> 'cascade' ->> 'rubricId' = ${params.rubricId}
       AND (
         ${params.reservation?.conditionKey ?? null}::text IS NULL
         OR routing -> 'cascade' -> 'reservation' ->> 'conditionKey' = ${params.reservation?.conditionKey ?? null}
         OR NOT (routing -> 'cascade' ? 'reservation')
       )
     ORDER BY created_at DESC
     LIMIT 16
  `) as unknown as Array<{ conversation_id: string; cascade_digest: unknown }>;

  let liveConversationId: string | null = null;
  const closedSpent: Array<{ conversationId: string; answeredBy: string; answeredAt: string }> = [];
  const nowIso = new Date(nowMs).toISOString();
  for (const row of rows) {
    const spent = spentGradingCascadeAnswer(row.cascade_digest, nowMs);
    if (!spent) {
      liveConversationId ??= row.conversation_id;
      continue;
    }
    const closed = (await sql`
      UPDATE harness_shared.consult_state
         SET state = 'closed_answered',
             closed_at = ${nowIso}::timestamptz,
             updated_at = ${nowIso}::timestamptz,
             outcome = jsonb_build_object(
               'source', 'acceptance-recruiter',
               'reason', 'answer_not_counted',
               'answeredBy', ${spent.ownerId}::text,
               'answeredAt', ${spent.at}::text
             )
       WHERE workspace_id = ${params.workspaceId}
         AND conversation_id = ${row.conversation_id}
         AND closed_at IS NULL
         AND state IN ('awaiting_responder', 'active')
      RETURNING conversation_id
    `) as unknown as Array<{ conversation_id: string }>;
    if (closed[0]) {
      closedSpent.push({ conversationId: row.conversation_id, answeredBy: spent.ownerId, answeredAt: spent.at });
    }
  }
  return { liveConversationId, closedSpent };
}

type GradingDispatchFailureEvent = {
  ownerId: string;
  kind: 'dispatch_failed';
  at: string;
  excerpt: string;
};

/**
 * Walk the already-selected grading menu when a transcript cannot produce an
 * answering session. This is the opening-dispatch counterpart of
 * cascade-core's reply/decline/expiry advance: one unreachable transcript costs
 * one menu slot, never the whole acceptance plan. Only a CAS-confirmed terminal
 * write may report `exhausted`; a race is conservatively treated as an existing
 * live cascade so a fresh judge cannot be launched over another dispatcher.
 *
 * @internal Exported for the regression test that guards the orchestration.
 */
export async function advanceUndispatchableGradingCascade(input: {
  graders: readonly Pick<AssignedGrader, 'ownerId'>[];
  initialQueued: number;
  nowIso?: () => string;
  advance: (input: {
    cursor: number;
    digest: GradingDispatchFailureEvent[];
    event: GradingDispatchFailureEvent;
  }) => Promise<{
    advanced: boolean;
    raced: boolean;
    nextOwnerId: string | null;
    queued: number;
  }>;
  markExhausted: (input: {
    cursor: number;
    digest: GradingDispatchFailureEvent[];
  }) => Promise<boolean>;
}): Promise<{ status: 'active' | 'exhausted' | 'raced'; woke: number }> {
  if (input.initialQueued > 0) return { status: 'active', woke: input.initialQueued };

  const nowIso = input.nowIso ?? (() => new Date().toISOString());
  const digest: GradingDispatchFailureEvent[] = [];
  let cursor = 0;
  let ownerId = input.graders[0]?.ownerId ?? null;

  while (ownerId) {
    const event: GradingDispatchFailureEvent = {
      ownerId,
      kind: 'dispatch_failed',
      at: nowIso(),
      excerpt:
        'Every allowed expert model was exhausted for this transcript; advancing to the next selected acceptance grader.',
    };
    const digestAfterFailure = [...digest, event];

    if (cursor + 1 >= input.graders.length) {
      const exhausted = await input.markExhausted({ cursor, digest: digestAfterFailure });
      return exhausted ? { status: 'exhausted', woke: 0 } : { status: 'raced', woke: 0 };
    }

    const step = await input.advance({ cursor, digest: [...digest], event });
    if (step.raced || !step.advanced || !step.nextOwnerId) return { status: 'raced', woke: 0 };
    if (step.queued > 0) return { status: 'active', woke: step.queued };

    digest.push(event);
    cursor += 1;
    ownerId = step.nextOwnerId;
  }

  return { status: 'raced', woke: 0 };
}

/**
 * Open the grading cascade (D-003 + D-005 [owner]). Injected as
 * `deps.openCascade` in tests — this default reaches the org PG.
 *
 * The cascade is a REAL consult row, not a grading-shaped lookalike, and that is
 * the whole point of D-005: `cascade-core`'s advance, the decline verb and the
 * expiry sweep are all already CAS-guarded against exactly this row, so grading
 * inherits every one of them instead of growing a second advance loop that would
 * have to re-derive the same three-way concurrency guard. What makes the row a
 * GRADING cascade is the `cascade` block on its routing snapshot, which is what
 * every trigger reads to render grader-shaped wake copy.
 *
 * The head grader is woken with the brief matching HOW they were selected: an
 * above-floor pick is told the router matched them; a minimum-fill pick is told
 * plainly that it did not (D-002 — a below-floor grader who believes they were
 * matched on expertise grades with unearned confidence).
 */
async function prodOpenGradingCascade(
  params: OpenGradingCascadeParams,
  ctx: LaunchCtx,
): Promise<OpenGradingCascadeResult> {
  // `notifyAgents` is deliberately NOT imported here any more (R-11): the only
  // delivery this function performs is the fork/convert dispatch below, so a
  // wake cannot creep back in through an unused-but-available binding.
  const [
    { getOrgPg },
    { makeConsultReachDispatcher },
    { advanceCascade },
    { resolveAgentIdentity },
    conversations,
    { PROCEED_EXPIRY_MS, stampAnsweringOwner },
    briefs,
  ] = await Promise.all([
    import('@papercusp/db-org'),
    import('./consult/consult-dispatch'),
    import('./consult/cascade-core'),
    import('./agent-tools/coordination/identity'),
    import('./agent-tools/coordination/conversations'),
    import('./consult/get-feedback-core'),
    import('./consult/grading-cascade'),
  ]);
  const identity = resolveAgentIdentity(ctx as never);
  const sql = getOrgPg().sql;

  // WI-10003786: name the session that is ACTUALLY grading, so a caller watches the
  // fork rather than the parked transcript source. Best-effort: a failed read is
  // reported as null (unknown), never thrown into a grading that already opened.
  const readAnsweringOwner = async (conversationId: string): Promise<string | null> => {
    try {
      const rows = (await sql`
        SELECT cascade_cursor, routing
          FROM harness_shared.consult_state
         WHERE workspace_id = ${params.workspaceId} AND conversation_id = ${conversationId}
      `) as unknown as Array<{ cascade_cursor: number | null; routing: unknown }>;
      const row = rows[0];
      return row ? answeringOwnerAtCursor(row.routing, row.cascade_cursor) : null;
    } catch {
      return null;
    }
  };

  // IDEMPOTENT. `resolveAcceptanceGrader` is re-dispatched by the
  // acceptance-grading sweep for any plan still waiting on a grade, and that was
  // harmless while assignment was a single notification — re-notifying the same
  // grader costs nothing. Opening a cascade is NOT harmless: a second row means
  // two cursors over two menus, two independent expiry windows, and a card that
  // advances one chain while the other silently waits. An already-open cascade
  // for this rubric IS the live dispatch, and its own expiry sweep is what
  // retries a silent grader — so re-dispatch reports it rather than duplicating
  // it. (`woke: 0` is honest: nobody was woken by THIS call.)
  //
  // WI-10003451: but an open cascade that already carries an ANSWER is not the live
  // dispatch — its grade did not count (we would not be here otherwise), and the
  // reservation key has no evidence-cohort component, so a cohort-stale re-grade
  // matched it and woke nobody for hours. The reconcile closes spent cascades and
  // only reports a genuinely live one.
  const reconciled = await reconcileOpenGradingCascades(params);
  if (reconciled.closedSpent.length > 0) {
    console.warn(
      `[acceptance-grader] closed ${reconciled.closedSpent.length} answered grading cascade(s) for plan ` +
        `${params.planSlug} (rubric ${params.rubricId}) whose grade no longer counts: ` +
        reconciled.closedSpent.map((c) => `${c.conversationId} answered by ${c.answeredBy} at ${c.answeredAt}`).join('; '),
    );
  }
  if (reconciled.liveConversationId) {
    return {
      conversationId: reconciled.liveConversationId,
      woke: 0,
      status: 'existing',
      answeringOwnerId: await readAnsweringOwner(reconciled.liveConversationId),
    };
  }

  const head = params.graders[0]!;
  const brief =
    head.via === 'minimum'
      ? briefs.buildMinimumFillAcceptanceGraderBrief(
          params.planSlug,
          params.harnessSlug,
          params.rubricId,
          params.reservation,
        )
      : briefs.buildAssignedAcceptanceGraderBrief(
          params.planSlug,
          params.harnessSlug,
          params.rubricId,
          params.reservation,
        );

  const opened = await conversations.openConversation(identity, {
    kind: 'consult',
    title: `Acceptance grading — ${params.planSlug} (${params.rubricId})`,
    body: brief,
    ...(params.harnessSlug ? { harness_slug: params.harnessSlug } : {}),
    // ⚠ EMPTY on purpose (R-11, matching get-feedback-core): openConversation
    // fans a notification out to its addressees, so naming the grader here
    // would wake a live agent through the back door the dispatch below just
    // stopped using. appendPost auto-joins a contributor, so the answering
    // session can post without being enrolled first.
    direct_to: [],
    producer: 'acceptance-gate:grading-cascade',
  });
  const conversationId = opened.conversation.id;

  // The persisted snapshot carries the flavour block, so a decline or an expiry
  // — neither of which knows anything about grading — still wakes grader 2 with
  // grading copy rather than consult copy.
  const routing = {
    ...(params.routing as Record<string, unknown>),
    cascade: {
      flavor: briefs.GRADING_CASCADE_FLAVOR,
      planSlug: params.planSlug,
      rubricId: params.rubricId,
      harnessSlug: params.harnessSlug,
      ...(params.reservation ? { reservation: params.reservation } : {}),
    },
  };
  const expiresAt = new Date(Date.now() + PROCEED_EXPIRY_MS).toISOString();
  await sql`
    INSERT INTO harness_shared.consult_state
      (workspace_id, conversation_id, requester_id, responder_id, state, question,
       latency_contract, origin_task_ref, routing, expires_at, wakes_used, cascade_cursor)
    VALUES
      (${params.workspaceId}, ${conversationId}, ${identity.ownerId}, ${head.ownerId},
       ${'awaiting_responder'}, ${brief}, ${'proceed'}, ${params.planSlug},
       ${sql.json(routing as never)}, ${expiresAt}::timestamptz, 1, 0)
  `;

  // R-11 / D-013: a grading cascade is a consult row (its routing carries
  // GRADING_CASCADE_FLAVOR), so it is bound by "no consult ever messages a live
  // agent". The grader is DISPATCHED — their transcript is forked (same
  // backend) or converted (cross backend) into a session launched to grade this
  // one rubric — never woken in place.
  //
  // ⚠ launchedBy is the SYSTEM actor, not the caller. The caller here can be the
  // rubric's own author asking the plan gate to recruit, and a session they
  // launch stays inside their lineage — which is exactly what the emit-side
  // guard refuses as a non-independent grade. Waking never created a lineage,
  // so this concern arrives WITH the dispatch; ACCEPTANCE_GRADING_SWEEP_ACTOR
  // already exists for precisely this (see its docstring).
  const dispatch = makeConsultReachDispatcher({
    workspaceId: params.workspaceId,
    harnessSlug: params.harnessSlug ?? null,
    launchedBy: ACCEPTANCE_GRADING_SWEEP_ACTOR,
  });
  const res = await dispatch({
    responder: head.ownerId,
    conversationId,
    summary: `⚖️ acceptance grading (grader 1/${params.graders.length}): plan ${params.planSlug}`,
    body: brief,
    // Stamp the answering identity as soon as that session starts, not when the
    // dispatcher returns: it can file its card during the verification wait, and
    // the participant gate refuses an author the row does not name yet.
    onAnsweringOwner: (owner) => stampAnsweringOwner(sql, params.workspaceId, conversationId, 0, owner),
  });
  // Backstop for a dispatcher that never called the hook; no-ops on absent.
  await stampAnsweringOwner(sql, params.workspaceId, conversationId, 0, res.answeringOwnerId);
  // `queued`, not `woke`: a launched-but-still-booting fork already owns the
  // keyboard while reporting woke:0. When nothing was queued, use the SAME
  // cascade-core advance as decline/reply/expiry to try the tail of the menu.
  // If every transcript is undispatchable, make the row honestly terminal so
  // resolveAcceptanceGrader can fall through to the lineage-safe fresh judge.
  const dispatchState = await advanceUndispatchableGradingCascade({
    graders: params.graders,
    initialQueued: res.queued,
    advance: async ({ cursor, digest, event }) => {
      let nextDispatch: Awaited<ReturnType<typeof dispatch>> | undefined;
      const advanced = await advanceCascade(
        {
          workspaceId: params.workspaceId,
          conversationId,
          question: brief,
          latencyContract: 'proceed',
          requesterId: identity.ownerId,
          routing,
          cascadeCursor: cursor,
          digest,
          event,
          stateOnAdvance: 'awaiting_responder',
          nowIso: event.at,
        },
        sql,
        async (opts) => {
          nextDispatch = await dispatch(opts);
          return {
            woke: nextDispatch.queued,
            answeringOwnerId: nextDispatch.answeringOwnerId ?? null,
          };
        },
      );
      return {
        advanced: advanced.advanced,
        raced: advanced.raced,
        nextOwnerId: advanced.next?.ownerId ?? null,
        queued: nextDispatch?.queued ?? advanced.woke,
      };
    },
    markExhausted: async ({ cursor, digest }) => {
      const wrote = (await sql`
        UPDATE harness_shared.consult_state
           SET state = 'no_qualified_responder',
               responder_id = NULL,
               expires_at = NULL,
               cascade_digest = ${sql.json(digest as never)},
               updated_at = ${digest[digest.length - 1]!.at}::timestamptz
         WHERE workspace_id = ${params.workspaceId} AND conversation_id = ${conversationId}
           AND cascade_cursor = ${cursor} AND state = 'awaiting_responder' AND closed_at IS NULL
        RETURNING conversation_id
      `) as unknown as Array<{ conversation_id: string }>;
      return wrote.length > 0;
    },
  });
  return {
    conversationId,
    woke: dispatchState.woke,
    status: dispatchState.status,
    answeringOwnerId: await readAnsweringOwner(conversationId),
  };
}

/**
 * A FILED grading card advances the grading cascade (D-003 [owner]: grader k+1
 * is woken holding grader k's card).
 *
 * WHY THE CARD, AND NOT ONLY A CONSULT REPLY. The cascade already advances on
 * reply, decline and expiry, and a grader who replies gets that for free. But
 * the ACT that discharges a grading is `scorecards:emit`, not a consult reply —
 * a grader who files their card and forgets to reply would otherwise leave the
 * chain parked until the 4h expiry, and grader 2 would then be woken with an
 * EMPTY digest, silently losing the carry that makes latest-wins coherent. So
 * the card itself is a fourth trigger into the SAME advance (D-005 — the
 * mechanism is not duplicated, only entered from one more place).
 *
 * IDEMPOTENT BY CONSTRUCTION, TWICE OVER: it advances only when the emitter is
 * the row's CURRENT responder (the rubric author's later acceptance re-emit, and
 * a card from a grader the cursor has already moved past, both no-op), and
 * `advanceCascade`'s CAS then makes a race with the reply verb or the expiry
 * sweep a clean `raced` no-op rather than a double wake.
 *
 * FAIL-SOFT: the card is the durable truth. Any fault here is swallowed — a
 * missed advance costs the carry and delays grader 2 to the expiry sweep; a
 * throw would fail a scorecard write that already succeeded.
 */
export async function advanceGradingCascadeOnCard(input: {
  workspaceId: string;
  rubricRef: string;
  graderOwnerId: string;
  /** What grader k concluded — carried verbatim (bounded) to grader k+1. */
  cardSummary: string;
}): Promise<{ advanced: boolean; next?: string; reason?: string }> {
  try {
    const [{ getOrgPg }, { advanceCascade, makeDigestEntry }, { makeConsultReachDispatcher }] = await Promise.all([
      import('@papercusp/db-org'),
      import('./consult/cascade-core'),
      import('./consult/consult-dispatch'),
    ]);
    const sql = getOrgPg().sql;
    const rows = (await sql`
      SELECT conversation_id, requester_id, responder_id, question, latency_contract,
             routing, cascade_cursor, cascade_digest
        FROM harness_shared.consult_state
       WHERE workspace_id = ${input.workspaceId}
         AND closed_at IS NULL
         AND routing -> 'cascade' ->> 'flavor' = ${GRADING_CASCADE_FLAVOR}
         AND routing -> 'cascade' ->> 'rubricId' = ${input.rubricRef}
       ORDER BY created_at DESC
       LIMIT 1
    `) as unknown as Array<{
      conversation_id: string;
      requester_id: string;
      responder_id: string | null;
      question: string;
      latency_contract: string;
      routing: unknown;
      cascade_cursor: number;
      cascade_digest: unknown;
    }>;
    const dispatchGrader = makeConsultReachDispatcher({
      workspaceId: input.workspaceId,
      harnessSlug: null,
      // Same reason as the opening dispatch: the system actor owns the launch so
      // grader k+1 cannot inherit the card author's lineage.
      launchedBy: ACCEPTANCE_GRADING_SWEEP_ACTOR,
    });
    const row = rows[0];
    if (!row) return { advanced: false, reason: 'no_open_grading_cascade' };
    if (row.responder_id !== input.graderOwnerId) {
      return { advanced: false, reason: 'not_current_grader' };
    }
    const nowIso = new Date().toISOString();
    const result = await advanceCascade(
      {
        workspaceId: input.workspaceId,
        conversationId: row.conversation_id,
        question: row.question,
        latencyContract: row.latency_contract,
        requesterId: row.requester_id,
        routing: row.routing,
        cascadeCursor: row.cascade_cursor,
        digest: row.cascade_digest,
        event: makeDigestEntry(input.graderOwnerId, 'answer', nowIso, input.cardSummary),
        // A grader engaged, so the row stays 'active' exactly as a reply leaves it.
        stateOnAdvance: 'active',
        nowIso,
      },
      sql,
      async (opts) => {
        // R-11 / D-013, same as the opening dispatch: grader k+1 is FORKED or
        // CONVERTED from their transcript holding grader k's card, never woken.
        const res = await dispatchGrader(opts);
        return {
          // queued, not woke — cascade-core treats 0 as "this rank produced
          // nobody" and advances past them, and a booting fork reports woke:0.
          woke: res.queued,
          answeringOwnerId: res.answeringOwnerId ?? null,
        };
      },
    );
    // The shared cascade records its final answer but deliberately leaves the
    // terminal transition to the trigger. Unlike consult:reply and the expiry
    // sweep, this card trigger is fire-and-forget from the grader's perspective:
    // they are told to emit the card and not reply. Close the row here when the
    // selected menu is complete and its minimum was met, or it stays `active`
    // until the four-hour expiry even though grading has finished.
    if (result.exhausted && !result.raced && !result.underFilled) {
      const closed = (await sql`
        UPDATE harness_shared.consult_state
           SET state = 'closed_answered',
               closed_at = ${nowIso}::timestamptz,
               expires_at = NULL,
               updated_at = ${nowIso}::timestamptz,
               outcome = jsonb_build_object(
                 'source', 'acceptance-grader-card',
                 'reason', 'cascade_complete',
                 'answeredBy', ${input.graderOwnerId}::text,
                 'answeredAt', ${nowIso}::text
               )
         WHERE workspace_id = ${input.workspaceId}
           AND conversation_id = ${row.conversation_id}
           AND responder_id = ${input.graderOwnerId}
           AND cascade_cursor = ${row.cascade_cursor}
           AND state IN ('awaiting_responder', 'active')
           AND closed_at IS NULL
        RETURNING conversation_id
      `) as unknown as Array<{ conversation_id: string }>;
      if (!closed[0]) return { advanced: false, reason: 'raced' };
    }
    return {
      advanced: result.advanced,
      ...(result.next ? { next: result.next.ownerId } : {}),
      ...(result.raced ? { reason: 'raced' } : result.exhausted ? { reason: 'menu_exhausted' } : {}),
    };
  } catch (err) {
    return { advanced: false, reason: `error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export async function resolveAcceptanceGrader(
  planSlug: string,
  ctx: LaunchCtx,
  deps: Parameters<typeof launchAcceptanceGrader>[2] & {
    discover?: typeof prodDiscoverGrader;
    openCascade?: typeof prodOpenGradingCascade;
    readSettlement?: typeof readAcceptanceGradingSettlement;
    reserveReviewTarget?: typeof reserveAcceptanceReviewTarget;
    readIneligibleHolders?: typeof prodReadIneligibleGradingHolders;
    nowMs?: () => number;
  } = {},
): Promise<AcceptanceGraderLifecycle> {
  let settlement: AcceptanceGradingSettlement | undefined;
  let discovery:
    | {
        excluded: string[];
        partyCollapsed?: string[];
        eligibility?: GraderEligibility;
        escalation?: GraderEscalation;
        freshReason: NonNullable<AcceptanceGraderLifecycle['freshReason']>;
        discoveryError?: string;
      }
    | undefined;
  let discoveryRubricId: string | undefined;
  let reviewReservation: AcceptanceReviewReservationRef | undefined;
  try {
    const plan = await (deps.readPlan ?? readPlanBySlug)(planSlug, {
      ...(ctx.harnessSlug && ctx.harnessSlug !== '*' ? { harnessSlug: ctx.harnessSlug } : {}),
      ...(ctx.workspaceId && ctx.workspaceId !== '*' ? { workspaceId: ctx.workspaceId } : {}),
    });
    const rubric = plan ? await (deps.getRubric ?? getAcceptanceRubricForPlan)(planSlug, {
      harnessSlug: plan.row.harnessSlug,
    }) : null;
    const rubricId = rubric ? String((rubric as unknown as { rubricId: string }).rubricId) : null;
    if (rubricId != null) discoveryRubricId = rubricId;
    // `rubric` truthy ⟺ `rubricId != null`, so this is the same condition as before
    // — the extra conjunct only narrows the id for the settlement read below.
    if (plan && rubric && rubricId != null) {
      // ── ALREADY-DECIDED GRADINGS ARE NOT RE-ROUTED (WI-1699998) ──
      // This runs BEFORE discovery, not merely before the cascade open, because
      // selection is the expensive half: it walks the eligible pool and, when it
      // opens a cascade, WAKES a fresh independent grader who is thereafter a
      // party to the plan. D-009 independence makes that pool non-replenishable,
      // so every redundant dispatch permanently shrinks it.
      //
      // The other guard in this file (`prodOpenGradingCascade`'s `closed_at IS
      // NULL` dedup) cannot cover this: it asks whether a cascade is OPEN, and a
      // grading that already COMPLETED has no open row — its evidence lives in
      // scorecards. Two different questions; both guards are needed.
      const staleCardIds = carriedStaleGradingCardIds(ctx);
      settlement = (ctx as AcceptanceShipperCarrier).acceptanceGateFoundNoAdmissibleGrading === true
        ? { settled: false, reason: 'gate_found_no_admissible_grading' }
        : await (deps.readSettlement ?? readAcceptanceGradingSettlement)(
        rubricId,
        {},
        staleCardIds.length > 0 ? { staleCardIds } : {},
      ).catch(
        // Fail OPEN: a settlement read that throws must not suppress a grading.
        // But RECORD the fault rather than returning undefined — a dispatch that
        // happened because the guard could not run must not be indistinguishable
        // from one that happened because nothing was graded yet. That silence is
        // the same shape as the bug this guard exists to fix.
        () => ({ settled: false, reason: 'read_threw' }) as const,
      );
      if (settlement?.settled) {
        return { state: 'settled', idempotencyKey: '', label: '', settlement };
      }

      // A delegated acceptance-grading request can be a plain `task` whose
      // source_plan_slug is NULL. The plan slug is therefore searched in the
      // bounded title/summary population, then the pure identity predicate
      // rejects ordinary plan tasks that merely mention the same slug — and
      // only a request held by an agent who could grade it (or one filed within
      // the grace window) counts as in flight; an abandoned one, or one held by
      // the shipper or another excluded party, grades nothing (WI-10002459).
      let existingGradingRequest: WorkItem | undefined;
      try {
        const candidates = await (deps.listWork ?? listWorkItems)({
          harness: plan.row.harnessSlug,
          kind: 'task',
          notTerminal: true,
          q: planSlug,
          limit: 100,
        });
        const nowMs = (deps.nowMs ?? Date.now)();
        const heldHolders = [
          ...new Set(
            candidates
              .filter((candidate) => candidate.assignee && isAcceptanceGradingRequestForPlan(candidate, planSlug))
              .map((candidate) => candidate.assignee as string),
          ),
        ];
        // Read only when a held request matched — the common case pays nothing. A
        // failed read treats every holder as ineligible: fail-open, like the reads
        // around it, because a wrongly suppressed grading strands the plan for good.
        const ineligibleHolders = heldHolders.length === 0
          ? undefined
          : await (deps.readIneligibleHolders ?? prodReadIneligibleGradingHolders)(plan, rubric, ctx, heldHolders).catch(
              (err: unknown) => {
                console.warn(
                  `[acceptance-grader] grading-request holder eligibility read failed for plan ${planSlug}: ` +
                    `${err instanceof Error ? err.message : String(err)}`,
                );
                return new Set(heldHolders);
              },
            );
        existingGradingRequest = candidates.find((candidate) =>
          isInFlightAcceptanceGradingRequest(candidate, planSlug, nowMs, ineligibleHolders),
        );
      } catch (err) {
        // This read is a duplicate guard, not a prerequisite for grading. A
        // transient listing failure must remain fail-open like the settlement
        // read above, while still leaving an operator-visible breadcrumb.
        console.warn(
          `[acceptance-grader] in-flight grading-request guard failed for plan ${planSlug}: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (existingGradingRequest) {
        return {
          state: 'deduped',
          idempotencyKey: '',
          label: '',
          existingWorkItemId: existingGradingRequest.id,
          existingWorkItemAssignee: existingGradingRequest.assignee ?? null,
        };
      }

      // Launcher idempotency protects a process receipt; this condition-keyed
      // reservation protects the durable reviewer-visible target across retries
      // and concurrent dispatches. The key includes the nullable rubric revision
      // so distinct revisions remain independent.
      const rubricRevision = (rubric as unknown as { revision?: number | null }).revision ?? null;
      const reserved = await (deps.reserveReviewTarget ?? reserveAcceptanceReviewTarget)(
        {
          workspaceId: plan.row.workspaceId,
          harnessSlug: plan.row.harnessSlug ?? null,
          planSlug,
          rubricId,
          revision: rubricRevision,
        },
        {
          title: `Acceptance review-target reservation — ${planSlug} (${rubricId})`,
          summary:
            `Canonical reviewer assignment for acceptance target ${planSlug} at rubric revision ` +
            `${rubricRevision ?? 'legacy'}.`,
        },
      );
      // `created` is an upsert outcome for the caller, not part of the stable
      // reference copied into briefs and persisted routing.
      reviewReservation = { conditionKey: reserved.conditionKey, id: reserved.id };

      const selection = await (deps.discover ?? prodDiscoverGrader)(plan, rubric, ctx);
      if (selection.verdict === 'assigned' && selection.graders.length > 0) {
        // Opening the cascade is BEST-EFFORT in exactly the way the single wake
        // it replaces was: a failure here must not turn a resolvable grading
        // into a failed ship. The difference is that a failure now costs the
        // cascade, not just a notification — so it is reported as woke:0 with no
        // conversation rather than silently looking like a delivered assignment.
        const opened = await (deps.openCascade ?? prodOpenGradingCascade)(
          {
            workspaceId: plan.row.workspaceId,
            planSlug,
            harnessSlug: plan.row.harnessSlug ?? null,
            rubricId,
            graders: selection.graders,
            routing: selection.routing,
            reservation: reviewReservation,
          },
          ctx,
        ).catch(() => null);
        if (opened?.status === 'exhausted') {
          discovery = {
            excluded: selection.excluded,
            ...(selection.partyCollapsed ? { partyCollapsed: selection.partyCollapsed } : {}),
            eligibility: selection.eligibility,
            ...(selection.escalation ? { escalation: selection.escalation } : {}),
            freshReason: 'all_eligible_unselectable',
          };
        } else {
          return {
            state: 'assigned',
            idempotencyKey: '',
            label: '',
            graders: selection.graders,
            ...(opened ? { conversationId: opened.conversationId } : {}),
            excluded: selection.excluded,
            ...(selection.partyCollapsed ? { partyCollapsed: selection.partyCollapsed } : {}),
            eligibility: selection.eligibility,
            ...(selection.escalation ? { escalation: selection.escalation } : {}),
            notified: {
              woke: opened?.woke ?? 0,
              // WI-10003786: whether THIS call dispatched, or found a cascade that
              // an earlier call already dispatched (the idempotent re-call).
              ...(opened ? { dispatch: opened.status === 'existing' ? ('existing' as const) : ('new' as const) } : {}),
              // The session to watch for pickup — the fork, not graders[0].
              ...(opened?.answeringOwnerId ? { answeringOwnerId: opened.answeringOwnerId } : {}),
              // The instant delivery was enqueued — the baseline a LATER pickup
              // observation compares the grader's own activity against
              // (`observeGraderPickup`). Recorded only when THIS call dispatched:
              // with no dispatch there is nothing for a pickup to post-date, and
              // an instant recorded anyway would make every subsequent grader
              // action look like a confirmed pickup. WI-10003786: that includes an
              // 'existing' cascade — stamping re-call time there told the author a
              // fresh, unanswered wake had just gone out.
              ...(opened && opened.status !== 'existing' ? { wakeInstant: new Date().toISOString() } : {}),
            },
            reviewReservation,
            ...(settlement ? { settlement } : {}),
          };
        }
      }
      if (!discovery) {
        discovery = {
          excluded: selection.excluded,
          ...(selection.partyCollapsed ? { partyCollapsed: selection.partyCollapsed } : {}),
          eligibility: selection.eligibility,
          ...(selection.escalation ? { escalation: selection.escalation } : {}),
          freshReason: selection.freshReason ?? 'no_eligible_non_excluded',
        };
      }
    }
  } catch (err) {
    const msg = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    console.warn(
      `[acceptance-grader] discovery failed for plan ${planSlug}` +
        (discoveryRubricId ? ` (rubric ${discoveryRubricId})` : '') +
        `: ${msg}`,
    );
    discovery = { excluded: [], freshReason: 'discovery_error', discoveryError: msg };
  }
  const launched = await launchAcceptanceGrader(planSlug, ctx, { ...deps, reviewReservation });
  return {
    ...launched,
    ...(reviewReservation ? { reviewReservation } : {}),
    ...(discovery ?? {}),
    ...(settlement ? { settlement } : {}),
  };
}

export async function launchAcceptanceGrader(
  planSlug: string,
  ctx: LaunchCtx,
  deps: {
    readPlan?: typeof readPlanBySlug;
    getRubric?: typeof getAcceptanceRubricForPlan;
    getAudit?: typeof getLatestPlanAudit;
    listWork?: typeof listWorkItems;
    /** Injectable for unit tests; production uses the canonical lineage reader. */
    lineageRelated?: typeof areAcceptanceLineageRelated;
    launch?: typeof launchAgentTool.handler;
    listTasks?: typeof listTasks;
    killTask?: typeof killTask;
    readLogTail?: AcceptanceGraderLogTailReader;
    sleep?: (ms: number) => Promise<void>;
    terminalLogRecheckDelayMs?: number;
    terminalLogMaxRechecks?: number;
    startupStallLogRecheckDelayMs?: number;
    startupStallLogMaxRechecks?: number;
    nowMs?: () => number;
    staleAfterMs?: number;
    /** Durable typed assignment to quote in the fresh-judge brief. */
    reviewReservation?: AcceptanceReviewReservationRef;
  } = {},
): Promise<AcceptanceGraderLifecycle> {
  const plan = await (deps.readPlan ?? readPlanBySlug)(planSlug, {
    ...(ctx.harnessSlug && ctx.harnessSlug !== '*' ? { harnessSlug: ctx.harnessSlug } : {}),
    ...(ctx.workspaceId && ctx.workspaceId !== '*' ? { workspaceId: ctx.workspaceId } : {}),
  });
  if (!plan) return { state: 'failed', idempotencyKey: '', label: '', error: `plan '${planSlug}' not found` };
  const [rubric, audit, workItems] = await Promise.all([
    (deps.getRubric ?? getAcceptanceRubricForPlan)(planSlug, { harnessSlug: plan.row.harnessSlug }),
    (deps.getAudit ?? getLatestPlanAudit)(planSlug),
    (deps.listWork ?? listWorkItems)({
      harness: plan.row.harnessSlug,
      sourcePlanSlug: planSlug,
      includeChildren: true,
      limit: 2_000,
    }),
  ]);
  if (!rubric)
    return { state: 'failed', idempotencyKey: '', label: '', error: `acceptance rubric missing for '${planSlug}'` };
  if (!audit) return { state: 'failed', idempotencyKey: '', label: '', error: `plan audit missing for '${planSlug}'` };

  const rubricRecord = rubric as unknown as {
    rubricId: string;
    proposedBy?: string | null;
    createdBy?: string | null;
  };
  // A fresh judge must not be launched by the rubric's own author (or an
  // identity in that author's launch/rebind lineage). Acceptance rubrics
  // written before proposedBy was persisted only have createdBy, so retain
  // that legacy value as the explicit fallback rather than silently disabling
  // the guard for those rows.
  const rubricAuthor = rubricRecord.proposedBy ?? rubricRecord.createdBy ?? null;
  if (rubricAuthor) {
    try {
      const callerOwnerId = resolveAgentIdentity(ctx).ownerId;
      const related = await (deps.lineageRelated ?? areAcceptanceLineageRelated)(rubricAuthor, callerOwnerId, {
        workspaceId: plan.row.workspaceId,
      });
      if (related) {
        return {
          state: 'failed',
          idempotencyKey: '',
          label: '',
          error:
            `acceptance grader launch refused: caller '${callerOwnerId}' is related to ` +
            `rubric author '${rubricAuthor}'`,
        };
      }
    } catch (err) {
      return {
        state: 'failed',
        idempotencyKey: '',
        label: '',
        error:
          `acceptance grader launch refused: could not verify caller lineage: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  const rubricRef = String(rubricRecord.rubricId);
  const identity = createHash('sha256')
    .update(
      [plan.row.workspaceId, plan.row.harnessSlug, planSlug, rubricRef, plan.row.version, plan.row.contentHash].join(
        '\0',
      ),
    )
    .digest('hex');
  const idempotencyKey = `acceptance-grader:${identity}`;
  const label = `${acceptanceGraderLabelPrefix(rubricRef)}${identity.slice(0, 12)}`;
  const snapshot = boundedSnapshotJson(compactSnapshot({ plan, rubric, audit, workItems }));
  const testPaths = audit.items.flatMap((i) =>
    i.citations.filter((c) => c.kind === 'test' && c.path).map((c) => c.path!),
  );
  const rerun = testPaths.length
    ? `npx vitest run ${[...new Set(testPaths)].join(' ')}`
    : 'No test citations were recorded; inspect the frozen audit evidence directly.';
  const brief = [
    `You are the dedicated acceptance judge for plan ${planSlug}. Grade rubric ${rubricRef} as a fresh non-implementer.`,
    'Do not modify implementation files, run shell commands, recruit peers, or broaden scope. Inspect the frozen evidence below, spot-check cited source/tests with read-only tools, and emit exactly one complete scorecards:emit verdict with concrete evidence for every criterion. After a successful create or unchanged-evidence result, the scorecard writer terminates this task automatically.',
    'If FROZEN_ACCEPTANCE_CONTEXT has contextIntegrity.degraded, follow its recovery recipe with read-only Papercusp tools BEFORE returning NOT GRADED. Recovered evidence is admissible only when plans:get still matches frozenIdentity.planVersion/planContentHash and the completion audit still matches frozenIdentity.auditSeq; on a read or identity mismatch, mark only the affected criteria unknown and name the exact gap.',
    ACCEPTANCE_GRADING_BAR_SCOPE_GUIDANCE,
    ACCEPTANCE_CITATION_SPOT_CHECK_GUIDANCE,
    acceptanceReviewReservationGuidance(deps.reviewReservation),
    `Recorded rerun command (for provenance; your judge policy forbids executing Bash): ${rerun}`,
    `FROZEN_ACCEPTANCE_CONTEXT=${snapshot}`,
  ].join('\n\n');

  try {
    const launch = deps.launch ?? launchAgentTool.handler;
    const readTasks = deps.listTasks ?? listTasks;
    const terminateTask = deps.killTask ?? killTask;
    const readLogTail = deps.readLogTail ?? readAcceptanceGraderLogTail;
    const sleep = deps.sleep;
    const nowMs = deps.nowMs ?? Date.now;
    const staleAfterMs = deps.staleAfterMs ?? ACCEPTANCE_GRADER_STALE_AFTER_MS;
    const staleTaskIds: string[] = [];
    const terminalTaskIds: string[] = [];
    const terminalCodes: AcceptanceGraderTerminalFailureCode[] = [];
    let currentIdempotencyKey = idempotencyKey;
    let launchBackend: 'claude' | 'codex' = 'claude';
    let terminalFallbacks = 0;

    const recoveryFields = (attempts: number) => ({
      ...(staleTaskIds.length ? { staleRecovery: { retiredTaskIds: staleTaskIds, attempts } } : {}),
      ...(terminalTaskIds.length
        ? {
            terminalRecovery: {
              retiredTaskIds: terminalTaskIds,
              attempts,
              codes: terminalCodes,
              fallback: ACCEPTANCE_GRADER_FALLBACK,
            },
          }
        : {}),
    });

    for (let attempt = 0; attempt <= ACCEPTANCE_GRADER_MAX_STALE_RETRIES; attempt += 1) {
      const useFallback = launchBackend === ACCEPTANCE_GRADER_FALLBACK.agent;
      const result = (await launch(
        {
          brief,
          harness: plan.row.harnessSlug,
          headless: true,
          // WI-10002152: an unattended headless judge MUST route through the
          // inference gateway (`auto`), never the single system credential
          // (`default`). `default` skips the gateway and therefore cannot fail
          // over, so ONE usage-walled credential drops every grader kickoff at
          // Claude Code's interactive rate-limit picker — which a headless
          // session can never answer — while other pool accounts sit
          // serviceable. Measured: two consecutive judges aborted
          // `submit-verification-aborted-quota-blocked` with claude
          // atCapacity=false and 2 of 3 accounts available.
          account: 'auto',
          agent: launchBackend,
          count: 1,
          independent: true,
          members: [
            useFallback
              ? {
                  role: 'judge',
                  agent: ACCEPTANCE_GRADER_FALLBACK.agent,
                  model: ACCEPTANCE_GRADER_FALLBACK.model,
                  effort: ACCEPTANCE_GRADER_FALLBACK.effort,
                }
              : { role: 'judge' },
          ],
          label,
          idempotencyKey: currentIdempotencyKey,
        } as never,
        ctx,
      )) as {
        isError?: boolean;
        content?: Array<{ text?: string }>;
        data?: { deduped?: boolean; launch?: unknown };
      };
      const launchData = result.data?.launch as
        | {
            tasks?: Array<{
              taskId?: unknown;
              logPath?: unknown;
              /**
               * WI-10002155: the launcher's structured kickoff receipt. Absent
               * when no process was spawned (a discovery 'assigned' launch).
               * `persisted:false` means the native marker was not confirmed by
               * its deadline; only `kickoff-not-submitted:*` is conclusive by
               * itself. Pair other negative receipts with `agentStarted`.
               */
              kickoffProof?: { persisted?: unknown; reason?: unknown } | null;
            }>;
            // EI-21923986145923904: present only when the fresh-launch verification
            // path ran (see FreshLaunchVerdict.agentStarted); absent for a discovery
            // 'assigned' launch, which never spawns.
            agentStarted?: boolean | null;
          }
        | undefined;
      const launchedTask = launchData?.tasks?.[0];
      const taskId = typeof launchedTask?.taskId === 'string' ? launchedTask.taskId : null;
      const logPath = typeof launchedTask?.logPath === 'string' ? launchedTask.logPath : null;

      // WI-10002155: use the launcher's structured kickoff receipt, but do not
      // mistake an expired native-marker deadline for proof that no turn ran.
      // `capability:launch-agent` separately returns `agentStarted`: true is an
      // observed turn, false is observed silence, and null is unconfirmed. A
      // positive start verdict wins over a late negative receipt; an explicit
      // `kickoff-not-submitted:*` receipt or observed silence remains terminal.
      // This keeps WI-10002155's recovery for a genuine dropped kickoff while
      // keeping a working judge alive when native transcript proof arrives late.
      // Absent `kickoffProof` means no spawn happened (a discovery 'assigned'
      // launch), which is not a failure.
      const kickoffProof = launchedTask?.kickoffProof;
      const kickoffNotPersisted = !!kickoffProof && kickoffProof.persisted !== true;
      const kickoffDropReason =
        typeof kickoffProof?.reason === 'string' && kickoffProof.reason ? kickoffProof.reason : 'reason not reported';
      const kickoffNotSubmitted =
        typeof kickoffProof?.reason === 'string' && kickoffProof.reason.startsWith('kickoff-not-submitted:');
      const launchObservedSilence = launchData?.agentStarted === false;
      const launchObservedStarted = launchData?.agentStarted === true;
      const kickoffFailureIsConclusive =
        kickoffNotPersisted &&
        !launchObservedStarted &&
        (launchObservedSilence || kickoffNotSubmitted);

      const terminalFailure: AcceptanceGraderTerminalFailure | null = kickoffFailureIsConclusive
        ? {
            code: 'launch_kickoff_not_persisted',
            evidence:
              `launch receipt reported kickoffProof.persisted !== true (${kickoffDropReason}); ` +
              `agentStarted=${String(launchData?.agentStarted ?? 'unreported')}`,
          }
        : logPath
        ? await detectAcceptanceGraderTerminalFailure(logPath, {
            readLogTail,
            ...(sleep ? { sleep } : {}),
            ...(deps.terminalLogRecheckDelayMs !== undefined ? { delayMs: deps.terminalLogRecheckDelayMs } : {}),
            ...(deps.terminalLogMaxRechecks !== undefined ? { maxRechecks: deps.terminalLogMaxRechecks } : {}),
            ...(deps.startupStallLogRecheckDelayMs !== undefined
              ? { startupStallDelayMs: deps.startupStallLogRecheckDelayMs }
              : {}),
            ...(deps.startupStallLogMaxRechecks !== undefined
              ? { startupStallMaxRechecks: deps.startupStallLogMaxRechecks }
              : {}),
          })
        : null;

      if (terminalFailure) {
        if (!taskId) {
          return {
            state: 'failed',
            idempotencyKey: currentIdempotencyKey,
            label,
            launch: result.data?.launch,
            error:
              `acceptance grader ended on ${terminalFailure.code}, but its launch receipt carried no task id; ` +
              'refusing an untracked fallback',
            ...recoveryFields(attempt + 1),
          };
        }
        const killed = await terminateTask(taskId, { includeSubtree: true, escalateAfterMs: 5_000 });
        if (!killed.ok && killed.error !== 'not_live' && killed.error !== 'task_not_found') {
          return {
            state: 'failed',
            idempotencyKey: currentIdempotencyKey,
            label,
            launch: result.data?.launch,
            error:
              `acceptance grader '${taskId}' ended on ${terminalFailure.code}, but its failed mission ` +
              `could not be retired: ${killed.error}`,
            ...recoveryFields(attempt + 1),
          };
        }
        terminalTaskIds.push(taskId);
        terminalCodes.push(terminalFailure.code);
        if (terminalFallbacks >= ACCEPTANCE_GRADER_MAX_TERMINAL_FALLBACKS) {
          return {
            state: 'failed',
            idempotencyKey: currentIdempotencyKey,
            label,
            launch: result.data?.launch,
            error:
              `acceptance grader fallback also ended on ${terminalFailure.code}; ` +
              'the one-retry ceiling stopped another launch',
            ...recoveryFields(attempt + 1),
          };
        }
        terminalFallbacks += 1;
        launchBackend = ACCEPTANCE_GRADER_FALLBACK.agent;
        const retryIdentity = createHash('sha256')
          .update(`${currentIdempotencyKey}\0${taskId}\0${terminalFailure.code}\0${launchBackend}`)
          .digest('hex')
          .slice(0, 16);
        currentIdempotencyKey = `${idempotencyKey}:recovery:${retryIdentity}`;
        continue;
      }

      if (result.isError) {
        return {
          state: 'failed',
          idempotencyKey: currentIdempotencyKey,
          label,
          launch: result.data?.launch,
          error: result.content?.[0]?.text ?? 'acceptance grader launch failed',
          ...recoveryFields(attempt + 1),
        };
      }

      if (!result.data?.deduped) {
        return {
          state: 'launched',
          idempotencyKey: currentIdempotencyKey,
          label,
          launch: result.data?.launch,
          ...(launchData && 'agentStarted' in launchData ? { agentStarted: launchData.agentStarted } : {}),
          ...recoveryFields(attempt + 1),
        };
      }

      if (!taskId) {
        return {
          state: 'deduped',
          idempotencyKey: currentIdempotencyKey,
          label,
          launch: result.data.launch,
          ...recoveryFields(attempt + 1),
        };
      }
      const task = (await readTasks({ rootTaskId: taskId, includeEnded: true, limit: 50 })).find(
        (row) => row.taskId === taskId,
      );
      if (!task) {
        return {
          state: 'deduped',
          idempotencyKey: currentIdempotencyKey,
          label,
          launch: result.data.launch,
          ...recoveryFields(attempt + 1),
        };
      }
      const live = task.endedAt == null && (task.state === 'pending' || task.state === 'running');
      const startedAtMs = Date.parse(task.startedAt);
      const overAge = Number.isFinite(startedAtMs) && nowMs() - startedAtMs >= staleAfterMs;
      if (live && !overAge) {
        return {
          state: 'deduped',
          idempotencyKey: currentIdempotencyKey,
          label,
          launch: result.data.launch,
          ...recoveryFields(attempt + 1),
        };
      }
      if (live) {
        const killed = await terminateTask(taskId, { includeSubtree: true, escalateAfterMs: 5_000 });
        if (!killed.ok) {
          return {
            state: 'failed',
            idempotencyKey: currentIdempotencyKey,
            label,
            launch: result.data.launch,
            error: `stale acceptance grader '${taskId}' could not be retired: ${killed.error}`,
            ...recoveryFields(attempt + 1),
          };
        }
      }
      staleTaskIds.push(taskId);
      const retryIdentity = createHash('sha256')
        .update(`${currentIdempotencyKey}\0${taskId}`)
        .digest('hex')
        .slice(0, 16);
      currentIdempotencyKey = `${idempotencyKey}:retry:${retryIdentity}`;
    }

    return {
      state: 'failed',
      idempotencyKey: currentIdempotencyKey,
      label,
      error: `acceptance grader stale-dedupe recovery exceeded ${ACCEPTANCE_GRADER_MAX_STALE_RETRIES} retries`,
      staleRecovery: { retiredTaskIds: staleTaskIds, attempts: ACCEPTANCE_GRADER_MAX_STALE_RETRIES + 1 },
      ...(terminalTaskIds.length
        ? {
            terminalRecovery: {
              retiredTaskIds: terminalTaskIds,
              attempts: ACCEPTANCE_GRADER_MAX_STALE_RETRIES + 1,
              codes: terminalCodes,
              fallback: ACCEPTANCE_GRADER_FALLBACK,
            },
          }
        : {}),
    };
  } catch (error) {
    return { state: 'failed', idempotencyKey, label, error: error instanceof Error ? error.message : String(error) };
  }
}
