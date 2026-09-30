/**
 * turn-start-orientation.ts — orientation that ARRIVES instead of being asked for
 * (fleet-deltas-leader-primitives-2026-07-10 item P-004; D-004 ruling 3).
 *
 * THE PROBLEM THIS SOLVES. `coord:orient` is mandated in the MCP `initialize`
 * instructions, restated in the su playbook, and graded by a dedicated LLM assert
 * (`S17-orient-bootstrap`) — three separate mechanisms whose only job is to make an
 * agent CALL something. Measured 2026-08-11 (`harness_shared.tool_invocations`, 7d,
 * `workspace_id='papercusp-workspace'`, grouped by `coord_owner_id` — NOT `spawn_id`,
 * which is per-call on that table): of 378 owners with >=5 tool calls, 240 (64.5%)
 * ever called `coord:orient`, and **119 (31.5%) issued no coordination read of ANY
 * kind** — no orient, no inbox, no catch-up, no feed. Instruction is not delivery.
 *
 * So the READ half of orientation moves onto the rail that already fires every turn
 * (`POST /api/agent-mcp/turn-start-memory`, which already carries the CTRL transition
 * and a server-built memory recall). The WRITE half stays an explicit agent call,
 * because it genuinely needs the agent: `coord:declare-intent(intent)` requires an
 * agent-authored one-line intent, and the lane claim requires knowing which items you
 * are taking. Neither can be synthesized server-side, and inventing a placeholder
 * intent to broadcast to peers would be worse than not declaring one.
 *
 * ── THREE CONSTRAINTS, ALL INHERITED RATHER THAN INVENTED ────────────────────────
 *
 * 1. FAIL-SOFT BY CONTRACT. The host endpoint answers `{ ok: true, text: '' }` on
 *    every failure path — a hook must never surface an error into a turn. Every
 *    function here returns a string (possibly empty) and never throws.
 * 2. THE 2.5s WALL. `userpromptsubmit-memory.sh` holds a hard wall on the whole
 *    turn-start request, so this fold must never be the reason a turn stalls. All
 *    IO runs in ONE `Promise.all` with per-source `.catch()`, and a missing source
 *    degrades that line rather than the block.
 * 3. ITS OWN BUDGET. Turn-start's 4000 chars belong to the MEMORY block, and
 *    injected lines compound in a warm session. This fold gets a separate, much
 *    smaller budget so the two can never cannibalize each other.
 *
 * ── WHY ALL-OR-NOTHING, NOT A PARTIAL DIFF ───────────────────────────────────────
 *
 * The delta is computed against the server-side read cursor (`read-cursors.ts`,
 * surface `orientation`), but when anything has changed the FULL block is emitted,
 * not just the changed lines. That is deliberate and follows the rule
 * `orient-list-delta.ts` already established: partial deltas are safe only for
 * "read-only informational streams where 'nothing new' is a safe, fully-actionable
 * answer", and were deliberately NOT applied to orient's `claimable`/`facts` folds
 * because omitting unchanged content from a SELF-SELECT or BINDING-CONTEXT surface
 * risks an agent acting on stale knowledge. Orientation is binding-context: an agent
 * shown only "unread: 6" with its held items elided would reasonably conclude it
 * holds nothing. So the choice is between the whole block and silence.
 *
 * The economy still holds, because silence is the common case: a turn that changed
 * nothing costs zero characters.
 */

import type { CursorState } from './agent-tools/coordination/read-cursors';
import type { ScoredItem } from './harness/improvements/digest';
import type { Sql } from 'postgres';
import { createHash, randomUUID } from 'node:crypto';
import { renderCarryBlindWindowLine, type CarryBlindWindow } from './carry-blind-window';
import { capPreservingOperativeDetailed } from './operative-clause';
import { workItemFetchHint } from './work-item-fetch-hint';
import {
  ANY_FAMILY_TERMINAL_STATES,
  FEATURE_TERMINAL_STATES,
  ISSUE_TERMINAL_STATES,
} from './work-item-dispatch-states';
import { projectAgentTurnStartObligationBrief, type AgentObligationBrief } from './agent-obligation-reader';
import { formatAgentObligationLine, type AgentObligation } from './agent-obligations';
import type { GoalPlacementTurnReceiptDeps } from './goal-placement-turn-receipts';
import { trackDetached } from './detached-imports';
import { withBoundedTimeout } from './bounded-timeout';
import type { OwnerDirectiveRow } from './owner-directives';
import {
  deriveDirectiveStatus,
  directiveNeedsAction,
  directiveStatusLabel,
  type DirectiveStatus,
} from './owner-directive-status';
import { alsoSentToNote, directiveDisplayText, directiveNeedsSummary, shortOwner } from './owner-directive-display';

/** A held work-item, reduced to what the fold actually prints. */
export interface OrientationHeldItem {
  id: string;
  /** EI-20451119672468393: the item's CANONICAL harness (may differ from the
   *  session's scope); null/absent ⇒ operator-scoped. Qualifies the re-fetch
   *  hint so a cross-harness held item resolves on the first try. */
  harness?: string | null;
  status?: string | null;
  /** In-flight state written through work_items:checkpoint. */
  checkpoint?: string | null;
  /** Write time for the absolute-staleness verdict below. */
  checkpointUpdatedAtMs?: number | null;
  /** True only when the shared turn-end checkpoint rule proves this snapshot old. */
  checkpointStale?: boolean;
}

/**
 * Compact owner-directive context delivered on the deterministic turn-start rail.
 *
 * ⚠ THIS INTERFACE IS WHERE THE 2026-09-22 CROSS-SESSION DIRECTIVE LEAK LIVED
 * (WI-10002426, plan `directive-visibility-and-ownership-2026-09-22` D-006).
 * It carried exactly `{ id, captureStatus, verbatimText }`, so `recordedBy` was
 * dropped by the TYPE one hop before the renderer — the renderer never had the
 * field to print, and a workspace-wide rail rendered an ADDRESSED imperative
 * ("orders:resolve-pending first.") with no addressee. Agents then carried out,
 * and dismissed, other sessions' directives.
 *
 * The rail being workspace-wide is CORRECT and deliberate — the owner asked for
 * every agent to see every directive (D-004), and this reader is typed
 * `(workspaceId)` with no `ownerId` by construction. What was missing was the
 * LABEL, not a filter. So do not "fix" a future leak by scoping this reader.
 *
 * Keep `recordedBy` and `capturedByHook` populated: the parallel obligation rail
 * (`agent-obligation-reader.ts`) has always carried both, and the divergence
 * between the two rails at exactly the field that identifies the addressee is
 * what made this bug possible.
 */
export interface OrientationOwnerDirective {
  id: number;
  verbatimText: string;
  /**
   * The agent-written summary of an over-cap directive and its author (D-004 of
   * owner-directive-delivery-redesign-2026-09-22). Rendered in place of the
   * verbatim text when the directive is too long to show whole — never a cut
   * fragment of the owner's words.
   */
  summaryText?: string | null;
  summaryBy?: string | null;
  /**
   * The session the owner was ADDRESSING (`orders.recordedBy`). Accurate at
   * capture and never mutated afterwards — directive rows are immutable owner
   * speech. This is the field that decides which bucket the line renders in.
   */
  recordedBy: string;
  /**
   * TRUE when a provenance hook captured this from a real owner turn; FALSE when
   * an agent asserted it. Rendered as `owner-candidate` rather than as owner
   * speech, because conflating hook-captured with agent-asserted "is exactly how
   * a note-to-self becomes an owner directive".
   */
  capturedByHook: boolean;
  /**
   * Whether `recordedBy` is THIS session — decided in the reader, which has the
   * ownerId, because a segment `render` receives only (state, committed).
   * Optional, and `undefined` deliberately renders as NOT-mine: an undecided
   * addressing must never produce a carry-out imperative.
   */
  addressedToMe?: boolean;
  /**
   * TRUE when a directive addressed to ANOTHER session touches this session's
   * work: the addressee has declared the same current plan (R-3 of
   * owner-directive-delivery-redesign-2026-09-22). Decided in the reader.
   */
  relatedToMe?: boolean;
  /**
   * The addressee's session state and current declared intent, for the grouped
   * render (directive-ownership-clarity-2026-09-23 P-003 / D-001): another
   * session's directives are shown UNDER that session, next to what it is doing,
   * so where a directive appears says whose it is. Optional: a failed read only
   * loses the context, never the directive.
   */
  addresseeState?: string | null;
  addresseeIntent?: string | null;
  /**
   * How many OTHER sessions hold an open copy of this exact text (D-004(1) of
   * directive-ownership-clarity-2026-09-23) — rendered as "also sent to N other
   * sessions" so a text match is never mistaken for ownership. Optional: absent
   * renders no note.
   */
  alsoSentTo?: number;
  /**
   * The derived status of the directive (P-006). Optional so a sink that cannot
   * afford the work-item join still renders a correctly LABELLED line; absent
   * means "not derived", never "unclaimed".
   */
  status?: DirectiveStatus;
}

/**
 * ONE carried claim the reader must FALSIFY before relying on it, or one still-open
 * external blocker — each delivered WITH the probe that settles it (P-010).
 *
 * This is the compaction contract's "[inferred] until re-probed" rule mechanised.
 * That rule already exists in prose, and `loop:checkpoint { checks }` already stores
 * `{ claim, recheck, verified }` rows precisely so a probe travels with its claim —
 * but nothing put the UNVERIFIED ones in front of the agent at the moment it acts.
 * A claim whose probe is delivered gets re-checked; a claim that arrives bare gets
 * INHERITED, and an inherited false claim is indistinguishable from a measured one.
 *
 * Root observation (first-hand, 2026-09-22, and the reason this class exists): a cold
 * wake carried NINE checks, every one PREDICTED, each with a real re-check probe — and
 * the turn-start block surfaced NONE of them. Two were already FALSE at wake time
 * (their subjects had gone terminal). The carry note even renders a `?` legend the
 * turn-start reader never sees.
 */
export interface OrientationOpenCheck {
  /** Stable row identity (`carryRowKey`) where the source carries one, else a
   *  source-qualified ordinal — so the same row keeps one identity across turns. */
  id: string;
  /** What the row asserts. Excerpted for the line; the pointer carries the rest. */
  claim: string;
  /** The probe that SETTLES the row. Absent ⇒ the row is unfalsifiable as stored,
   *  which the line states outright rather than implying a probe exists. */
  recheck?: string;
  /** Where to read/settle the row — the loop carry-note or a specific work-item. */
  pointer: string;
  /** `blocker` rows are open external blockers (`work_items:set_blocker`), not
   *  carried claims: they are already known-open, so they need no falsifying. */
  kind: 'check' | 'blocker';
  /** Supplied evidence CONTRADICTS the claim (the carry-note CONTESTED state).
   *  Strictly worse than merely unverified — a claim with disproof attached — so
   *  it is surfaced ahead of the plain PREDICTED rows. */
  contested?: boolean;
}

/**
 * How many work-items the `openChecks` resolver will scan for open external
 * blockers. Bounded because this runs inside the 2.5s orientation wall on EVERY
 * turn; an owner holding more than this many items has a lane problem the block
 * cannot fix by rendering more rows.
 */
export const OPEN_CHECKS_BLOCKER_SCAN_LIMIT = 25;

/**
 * Hard cap on resolved rows. The renderer already shows 2 and summarizes the
 * tail, so this exists to bound the WATERMARK (the fingerprint hashes the rows,
 * not the rendered lines) — an unbounded row set would make the dedup key churn
 * on rows nobody ever sees.
 */
export const OPEN_CHECKS_MAX_ROWS = 20;

/** Post-claim discussion changes that the holder has not necessarily seen yet. */
export interface OrientationHistoryUpdate {
  workItemId: string;
  harness?: string | null;
  count: number;
  newestPostId: number;
}

/** Post-claim revisions on the held work's bounded plan/goal ancestry. */
export interface OrientationEffortUpdate {
  level: 'plan' | 'goal';
  ref: string;
  count: number;
  newestPostId: number;
}

/** Actionable inbox context from the same primitive as fleet:leader-brief. */
export interface OrientationInboxEntry {
  msgId: string;
  from: string;
  summary?: string;
}

/** A declared, still-unfired gate visible in this caller's current scope. */
export interface OrientationAnnouncedGate {
  event: string;
  note?: string | null;
  /** Stable logical gate identity, when the declarer supplied one. */
  logical_gate?: string | null;
  /** Number of live non-announce awaits on this event key, when measured. */
  live_awaiters?: number;
  /** Live successors that can declare a replacement for a stale binding. */
  live_successor_ids?: string[];
  /** True only when the declarer ended and no live successor owns the binding. */
  stale_owner?: boolean;
  /** Actionable warning about a stranded or ambiguous announced gate. */
  warning?: string;
}

/**
 * Plan-item-shaped gate names are dangerous when announced globally: a bare
 * `p006-complete` is easy to mistake for the completion edge of the current
 * plan even when another plan owns it. Keep this detector deliberately narrow
 * so ordinary `phase3-open`/`p2p-ready` event names do not become warnings.
 */
export function isPlanItemLikeGateName(value: string | null | undefined): boolean {
  return typeof value === 'string' && /^p-?\d+(?:[-_:.\/].*)?$/i.test(value.trim());
}

/** Build the shared, concise warning rendered by both orientation surfaces. */
export function buildAnnouncedGateWarning(input: {
  event: string;
  logical_gate?: string | null;
  scope?: string | null;
  announcedBy?: string | null;
  stale_owner?: boolean;
}): string | undefined {
  const warnings: string[] = [];
  if (input.stale_owner) {
    warnings.push(
      `STALE announced gate "${input.event}": declarer ${input.announcedBy ?? 'unknown'} ended and no live successor holds its binding; do not await it.`,
    );
  }
  const global = !input.scope || input.scope === 'global';
  const ambiguousName = [input.event, input.logical_gate].find(isPlanItemLikeGateName);
  if (global && ambiguousName) {
    warnings.push(
      `AMBIGUOUS GLOBAL announced gate "${ambiguousName}": its name resembles a plan-item key; verify the plan/owner before awaiting.`,
    );
  }
  return warnings.length > 0 ? warnings.join(' ') : undefined;
}

/**
 * WI-2142142: the SENDER-side mirror of `unansweredDirected` — directed
 * messages THIS agent sent, expecting a reply, that the recipient has not
 * yet answered. `unansweredDirected` is "what do I still owe?"; this is
 * "what am I still owed?", and the block previously had no line for it at
 * all. `oldestTo` is computed directly by fetchOpenAsks, not derived from a
 * capped list, so it stays correct even when `count` exceeds any display cap.
 */
export interface OrientationOpenAsk {
  count: number;
  oldestAgeMs: number;
  oldestTo: string;
}

/** The one actionable captured-improvement row worth injecting this turn. */
export interface OrientationImprovementTriage {
  /** Untriaged rows in the same bounded window that produced `top`. */
  pending: number;
  /** Improvement rows the bounded read actually considered. */
  considered: number;
  /** True when the read hit its cap, so `pending` is only a lower bound. */
  lowerBound: boolean;
  top: {
    id: string;
    title: string;
    lane: 'human' | 'auto';
  };
}

/** The exact-plan fleet frontier, reduced to the edge this fold can deliver. */
export interface OrientationExecutableFrontier {
  planSlug: string;
  executableWidth: number;
}

/**
 * Reduce the existing triage lanes to the one row worth injecting at turn
 * start. `humanQueue` arrives in the one ranker's order; `selectUntriaged`
 * sorts its argument in place by the legacy triage score, so call it on copies
 * and use only its membership result for that lane. Otherwise merely filtering
 * lifecycle state silently destroys the ranker's order before `top` is chosen.
 */
export function selectOrientationImprovementTriage(
  digest: { humanQueue: ScoredItem[]; autoEligible: ScoredItem[] },
  selectUntriaged: (scored: ScoredItem[], max: number) => ScoredItem[],
  population: { considered: number; lowerBound: boolean },
): OrientationImprovementTriage | null {
  const untriagedHumanIds = new Set(
    selectUntriaged([...digest.humanQueue], digest.humanQueue.length).map((item) => item.id),
  );
  const human = digest.humanQueue.filter((item) => untriagedHumanIds.has(item.id));
  const auto = selectUntriaged([...digest.autoEligible], digest.autoEligible.length);
  const top = human[0] ?? auto[0];
  if (!top) return null;
  return {
    pending: human.length + auto.length,
    considered: population.considered,
    lowerBound: population.lowerBound,
    top: {
      id: top.id,
      title: top.title,
      lane: human[0] ? 'human' : 'auto',
    },
  };
}

/**
 * Everything the fold can say, resolved once per turn.
 *
 * ⚠ `claimable` is deliberately ABSENT in v1. The claimable set has real
 * semantics — `work_items:claimable` exists precisely because a raw
 * `status='open'` query overcounts by ~13x — and a wrong count injected into
 * every turn is worse than no count. Add it by calling that tool's underlying
 * read, never by hand-writing a floor query here.
 */
/**
 * Evidence that this agent's MCP tool surface loaded EMPTY (EI-21308269358666878).
 *
 * A psu session can come up with ZERO papercusp tools and never notice: it keeps
 * heartbeating, presence stays 'live', and it looks healthy to every peer — while
 * being unable to claim, checkpoint, complete, or control its own loop. The tool
 * list is fetched once at MCP connect and never re-listed, so the condition is
 * PERMANENT for that session's life: it cannot self-heal, and retrying inside the
 * session cannot fix it. That is why this warns instead of waiting.
 *
 * The signal is the CALL-ORIGIN SPLIT, not a call count. Hook calls reach the
 * operator over plain HTTP, BYPASSING the agent MCP surface, so they keep flowing
 * while agent-issued calls stop dead. Measured on the confirmed incident
 * (su-b39c3537, sessions cdcdc38c + ed80eafe, 2026-08-24): 355+ hook calls against
 * 0 agent calls, over ~4 hours — a state its own transcript describes as "no
 * papercusp tools registered". That asymmetry also rules out "merely idle": an
 * idle session is not being handed turn-start blocks at all.
 *
 * ⚠ A raw invocation COUNT does not work and was tried first: the sanctioned
 * `scripts/mcp-call.mjs` fallback and the hooks both write rows, so a toolless
 * agent still logs plenty of invocations. Only the split separates them.
 *
 * Present ⇒ toolless. `null` is BOTH "healthy" and "cannot tell", deliberately:
 * every unknown degrades to silence, never to a false alarm on a working agent.
 */
export interface OrientationToolSurface {
  /** Hook-origin calls since the context generation began — proves the operator is reachable. */
  hookCalls: number;
  /** Minutes since the context generation began, so the line can say how long. */
  windowMinutes: number;
}

/**
 * One ACTIVE mode row, reduced to the fields the attribution line needs
 * (P-012). Deliberately NOT the full `ModeRow`: `setAt` is excluded because a
 * time-derived component would re-emit the line every turn and defeat the very
 * diff this class exists to be — the same rule `openAsks` and `frontier`
 * already follow above.
 */
export interface OrientationModeState {
  /** The axis this mode occupies; part of the identity because axes are exclusive. */
  axisKey: string;
  mode: string;
  reason: string;
  /** The actor that set it — the "setting actor" the acceptance bar requires. */
  setBy: string;
  /**
   * Whether `setBy` IS this agent. Resolved in the deps layer, which knows the
   * ownerId, because a segment's render signature is (value, state, committed)
   * and carries no identity — so the self-vs-peer split cannot be decided at
   * render time. Collapsing a peer-set mode into "self-set" would attribute a
   * flip the agent never made to the agent itself.
   */
  setBySelf: boolean;
  ownerDirected: boolean;
  /** The SOURCE mode when an implication cascade inserted this row, else null. */
  impliedBy: string | null;
}

/**
 * The three INSTRUCTION-PRECEDENCE decisions that define this agent's authority
 * (P-013), reduced to the values the transition line needs.
 *
 * ⚠ DELIBERATELY NOT `InstructionPrecedenceTrace.watermark` (D-073). The item
 * text said to diff on that watermark; measured, it is strictly WIDER than the
 * verdict it would gate — `stableRuntimeContext` hashes `scope.items` and
 * `loop.intervalSec`, both of which move on every plan-item claim/release and
 * every loop re-arm, while all three decision values stay byte-identical. A
 * watermark-keyed line therefore reappears verbatim on a turn where the agent's
 * authority did not change — the same defect D-071 diagnosed for `modes`,
 * reached by a different route. The trace stays an implementation detail of the
 * resolver and is NOT carried here, so a later author cannot key on it and
 * silently reintroduce this.
 *
 * Each field is the decision's `effective.value`, or the literal `'conflict'`
 * when `status === 'conflict'`. A conflicting authority is the single most
 * action-worthy state this class has and must never encode as empty.
 */
export interface OrientationAuthorityVerdict {
  /** `execution-authorization`: act-with-disclosure / confirm-before-execution / … */
  executionAuthorization: string;
  /** `mission`: the effective mission constraint. */
  mission: string;
  /** `ideation`: invent-and-implement / invent-and-propose / direct-improvements-only. */
  ideation: string;
}

/**
 * P-014: one plan Decision, reduced to what a turn-start line needs.
 *
 * `ref` is the DIFF KEY, and deliberately so (D-081 ruling 1). The shared
 * reader this class reuses — `getClaimTimePlanDecisions` — projects
 * `{ id, title, snippet, sourcePlanSlug?, ref?, relation? }` and DISCARDS the
 * `updated_at` / `seq` it orders by, so there is no timestamp on the row to
 * compare against a cursor. Keying on a timestamp would therefore require
 * widening `ClaimTimePlanDecision` across four claim paths; keying on the ref
 * needs nothing and is monotonic per plan.
 */
export interface OrientationPlanDecision {
  /** Globally citable `<plan>#D-NNN`. The diff key — see the interface doc. */
  ref: string;
  planSlug: string;
  /** The in-plan id (`D-NNN`), for the rendered line. */
  id: string;
  title: string;
}

/**
 * P-014: the decisions in scope, WITH the disclosures that stop the bounded
 * window being read as the whole set.
 */
export interface OrientationPlanDecisions {
  decisions: OrientationPlanDecision[];
  /**
   * D-081 ruling 2: decisions that exist but fell OUTSIDE the reader's bounded
   * recency window, summed across plans. The window is a real omission source,
   * so it is DISCLOSED rather than hidden — the underlying brief carries
   * `totalDecisions` / `totalLocalDecisions` / `totalAffectedDecisions` for
   * exactly this reason (EI-19396519606401168, where a window read as the whole
   * set told a claimer it had seen the governing rulings when it had not).
   */
  omitted: number;
  /**
   * D-081 ruling 3: the reverse-authority read failed for at least one plan, so
   * inbound decisions from other plans may be missing. Absence must not be
   * interpreted as no inbound authority.
   */
  authorityReadFailed: boolean;
}

/**
 * P-015: one lock TRANSITION for this owner — never a row of the lock table.
 *
 * The two transitions this class exists for are the ones an agent cannot
 * observe from its own tool results: a grant that lands while the agent is
 * parked (it queued, ended its turn, and the lock became its own), and the
 * moment it becomes blocked behind a peer. A lock that was already held and
 * still is has no transition and MUST render nothing — that steady state is
 * the full-lock-table read this class refuses to be.
 *
 * `key` is the DIFF KEY and is deliberately IDENTITY-derived, never a
 * timestamp (P-012 / D-071, the same rule `modes` carries): `acquired_ts` and
 * `queued_ts` are on the rows, and keying on either would re-emit an unchanged
 * holding every turn purely because the clock moved.
 */
export interface OrientationLockTransition {
  /** `granted` — a path this owner was BLOCKED on is now held by it.
   *  `blocked` — this owner is newly waiting behind another holder. */
  kind: 'granted' | 'blocked';
  /** Repo-relative path (or the reserved `@external/*` key acquire assigns). */
  path: string;
  /**
   * The lock namespace the row was observed in. Load-bearing for `blocked`:
   * `readQueue` is called with `coordinationDomain: null` (the documented
   * diagnostic read — correct here because `owner` is globally unique), and a
   * cross-domain read may only attribute a blocker WITHIN a domain, never
   * across one. Two checkouts are two different files.
   */
  coordinationDomain: string;
  /** `blocked` only: who holds it, their intent, and when their hold expires —
   *  the three things that decide whether to wait, pivot, or ask. Absent on a
   *  `granted` row, and absent when the holder read could not attribute one. */
  holder?: { owner: string; ownerLabel: string | null; intent: string; expiresTs: string };
}

/**
 * P-015: this owner's lock position as a MEASURED CURRENT OBSERVATION — NOT a
 * pre-computed diff.
 *
 * The split matters and was got wrong once: STATE is what is true right now,
 * and the DIFF against `committed` happens in `render`, exactly as
 * `planDecisions`, `authorityVerdict` and `modes` do it. `resolveOrientationState`
 * has no access to the committed cursor, so a state shape that already knew
 * which rows "changed" would have to plumb the cursor through a seam that
 * deliberately has none.
 *
 * `undefined` on the state field means UNREADABLE and renders nothing; empty
 * `held`/`blocked` arrays are the measured-empty value and are a different,
 * true claim. The distinction is load-bearing here for the same reason it is
 * on `planDecisions`: the watermark preserves the committed token on
 * unreadable, so a transient failure cannot erase the cursor and re-emit every
 * standing block as if it were fresh.
 */
export interface OrientationLockTransitions {
  /**
   * `kind:'granted'` CANDIDATE rows — every lock this owner holds RIGHT NOW.
   * A row renders only when the render-time diff says the owner was QUEUED on
   * it last turn; a lock it already held, or one its own tool call just
   * returned, is steady state and renders nothing.
   */
  held: OrientationLockTransition[];
  /**
   * `kind:'blocked'` CANDIDATE rows — every ticket this owner is waiting on,
   * carrying the holder attributed within the same coordination domain.
   */
  blocked: OrientationLockTransition[];
  /**
   * The owner's full held+waiting IDENTITY set as observed this turn
   * (`h:<domain>:<path>` per held row, `b:<domain>:<path>` per waiting row),
   * which is what the watermark token encodes. It is carried SEPARATELY from
   * the rows on purpose: the token must describe the whole observed state (so
   * the next turn can diff against it), while only a subset of the rows ever
   * renders. Encoding the token from the RENDERED rows alone would make a
   * released lock invisible and re-emit its grant forever.
   */
  observed: string[];
}

/**
 * P-016: one coupled peer and the intent it is CURRENTLY declaring.
 *
 * Coupling is opt-in and already paid for — `coord:couple` is an explicit act,
 * and the pair pays for the edge on BOTH sides — so this class spends nothing
 * on an agent that never coupled. It is the read that justifies the edge: the
 * point of coupling is to see what the other agent is doing, and until now
 * that required asking.
 */
export interface OrientationCoupledPeer {
  ownerId: string;
  /** Short display handle; `null` when presence carries no label. */
  ownerLabel: string | null;
  /**
   * The peer's currently declared intent line. Never a timestamp: the token
   * this feeds (see `fingerprintOrientation`) must be an IDENTITY, so an
   * unchanged intent produces a byte-identical token and the class stays
   * silent. `intent_declared_at` would re-emit on every RE-declaration of the
   * SAME intent — exactly the noise this class is defined to avoid.
   */
  intent: string;
}

/** R-4 / D-032: the obligations reader's marker that an experiment arm withheld the agenda. */
export interface ObligationsWithheldByArm {
  withheldBy: 'experiment-arm';
}

/**
 * Split the obligations read into state. An arm-withheld read becomes
 * `obligations: null` — every existing reader sees exactly what an empty agenda
 * looks like, so nothing renders — plus the `obligationsWithheldBy` modifier the
 * su.mode-goal receipt uses to stamp the omission honestly.
 */
export function splitObligationsRead(
  read: AgentObligationBrief | ObligationsWithheldByArm | null | undefined,
): Pick<OrientationState, 'obligations' | 'obligationsWithheldBy'> {
  if (read && 'withheldBy' in read) return { obligations: null, obligationsWithheldBy: read.withheldBy };
  return { obligations: read };
}

export interface OrientationState {
  /** Non-terminal work-items assigned to this agent. */
  held: OrientationHeldItem[];
  /** The held-item read failed; an empty array then cannot prove there is no claim. */
  heldReadFailed?: boolean;
  /** Unresolved explicit directives and hook-captured pending owner turns. */
  ownerDirectives?: OrientationOwnerDirective[];
  /** `undefined` means the read failed and must preserve the prior cursor token. */
  historyUpdates?: OrientationHistoryUpdate[];
  /** `undefined` means unreadable; preserve the previous delivery token. */
  effortUpdates?: OrientationEffortUpdate[];
  /**
   * Carried claims still UNVERIFIED, and still-open external blockers, each with
   * its settling probe. `undefined` means the read failed and must preserve the
   * prior cursor token — measured-empty ("nothing to re-check") and unreadable
   * ("I could not tell") must not collapse, because only the first is a verdict.
   */
  openChecks?: OrientationOpenCheck[];
  /** Directed messages awaiting THIS agent's reply, from a sender who is not
   *  positively dead — the population that genuinely outranks your own work. */
  unansweredDirected: number;
  /**
   * EI-20085805220385722: still-unanswered asks whose SENDER has ended. Split
   * OUT of `unansweredDirected` (nobody is blocked behind them, so they must
   * not preempt) but still REPORTED, because a silently vanished obligation is
   * the worse failure — this file's own `unanswered` primitive was reshaped
   * once already after a false ZERO lost a real commitment.
   */
  unansweredStale: number;
  /** Newest actionable inbox headlines; count remains `unansweredDirected`. */
  inboxRecent: OrientationInboxEntry[];
  /** Directed messages THIS agent sent that await a PEER's reply; null means
   *  none or unreadable. See {@link OrientationOpenAsk}. */
  openAsks: OrientationOpenAsk | null;
  /** Declared-but-unfired gates visible to the caller's fleet/plan/harness. */
  announcedGates: OrientationAnnouncedGate[];
  /** Active modes with their attribution; null means unreadable, `[]` means
   *  genuinely none. The distinction is load-bearing — see
   *  `fingerprintOrientation`, which preserves the committed token on null so a
   *  transient read failure cannot erase the cursor and fake a fresh transition
   *  on recovery. */
  modes: OrientationModeState[] | null;
  /**
   * P-013: the effective authority verdict; `null` means UNREADABLE, never
   * "no authority". The distinction is load-bearing for the same reason it is
   * on `modes` — `fingerprintOrientation` preserves the committed token on
   * null so a transient control-state read failure cannot erase the cursor and
   * fake a fresh transition on recovery.
   */
  authorityVerdict: OrientationAuthorityVerdict | null;
  /**
   * P-014: plan Decisions governing the plans this owner holds claimed items on.
   *
   * `undefined` means UNREADABLE (no reader, or the read threw) and renders
   * NOTHING — never "no new decisions". D-081 ruling 3: a turn-start silence
   * built on a failed read is the same false-negative class this plan keeps
   * finding, and here it would assert the agent has seen every governing ruling
   * when it has seen none. An empty `decisions` array is the MEASURED-empty
   * value and is a different, true claim.
   */
  planDecisions: OrientationPlanDecisions | undefined;
  /**
   * P-015: this owner's CURRENT lock position — held rows, waiting rows, and
   * the observed identity set. The transition is computed in `render` by
   * diffing this observation against the committed cursor; the state itself
   * never sees that cursor.
   *
   * `undefined` means UNREADABLE (no reader, or the read threw) and renders
   * NOTHING — never "no lock changed". The same rule `planDecisions` above
   * carries, and it bites harder here: a false silence on the GRANTED half
   * strands an agent that queued and parked, waiting for a wake about a lock
   * it already owns. Empty `held`/`blocked` arrays are the measured-empty value.
   */
  lockTransitions: OrientationLockTransitions | undefined;
  /**
   * P-016: the peers this owner is COUPLED to, each with the intent it is
   * currently declaring. The transition is computed in `render` by diffing
   * this observation against the committed cursor; the state never sees that
   * cursor — the same split `lockTransitions` above carries.
   *
   * `null` means UNREADABLE and renders NOTHING — never "no peer changed
   * intent". `[]` is the MEASURED-empty value (this owner coupled to nobody,
   * the overwhelmingly common case) and is equally silent. The distinction is
   * load-bearing for the reason `modes` states: `fingerprintOrientation`
   * preserves the committed token on null, so a transient presence-read
   * failure cannot erase the cursor and re-emit every coupled peer's standing
   * intent as a fresh change on recovery.
   */
  coupledPeers: OrientationCoupledPeer[] | null;
  /** Whether an engine loop is armed — i.e. whether a wake source exists. */
  loopArmed: boolean;
  /** Whether the armed loop's most recent fire was withheld before delivery. */
  loopFireWithheld: boolean;
  /** Ranked, still-untriaged improvement signal; null means none or unreadable. */
  improvementTriage: OrientationImprovementTriage | null;
  /** Canonical P-011 executable width; null means inapplicable or unreadable. */
  executableFrontier: OrientationExecutableFrontier | null;
  /**
   * Shared policy agenda. `null` means measured with no actionable entries;
   * `undefined` means the optional read was unavailable and preserves the last
   * cursor token instead of manufacturing a cleared obligation.
   */
  obligations?: AgentObligationBrief | null;
  /**
   * R-4 / D-032. Set only when the owner's goal runs an experiment arm that
   * withholds the per-turn agenda. `obligations` is then null (nothing renders),
   * and this field is what lets the su.mode-goal receipt stamp the omission
   * 'experiment-arm' instead of 'ineligible', so an arm-withheld agenda stays
   * distinguishable from a genuinely empty one. A modifier of the goal binding,
   * not a class of its own.
   */
  obligationsWithheldBy?: 'experiment-arm';
  /**
   * KEYS of the never-drop standing facts (`dead-end:` / `wall:` / `guard-rail:`).
   *
   * These exist to OVERRIDE a stale plan, which is the whole reason they are
   * folded into a block this small. EI-18725816532600240 established exactly
   * this rule for coord:orient's monitor tick, after a cold wake was told to
   * implement an approach a `dead-end:` fact had ALREADY falsified — "the
   * antidote was absent precisely where the poison was strongest". This fold
   * fires even more often than that one and did not inherit the lesson
   * (EI-21309540201944554).
   *
   * KEYS ONLY. The bodies are what make the full fold expensive, and a key is
   * enough to answer the only question this line needs to answer: "is there a
   * settled do-not-repeat about the thing I am about to do?"
   */
  neverDropFacts: string[];
  /**
   * Set when this agent's MCP tool surface is observably EMPTY; null when it is
   * healthy OR unreadable. See OrientationToolSurface for why unknown ⇒ null.
   */
  toolSurface: OrientationToolSurface | null;
  /**
   * EI-21442716425230784: what the carry document could NOT have seen — the work
   * the predecessor did between the carry snapshot and the cut. Present only on a
   * fresh successor whose window was measured and NON-EMPTY; null otherwise,
   * which covers "no recent cut", "the window was empty", and "unreadable"
   * alike, because none of those is something to spend a line on.
   *
   * This is the first-turn line a just-respawned agent most needs and can least
   * derive: the carry doc warns that a blind window exists but carries no signal
   * about THIS one, so a successor cannot tell an empty window from one holding
   * the single most owner-salient act of the session.
   */
  carryBlindWindow: CarryBlindWindow | null;
}

/**
 * Default budget for the compact turn-start delta.
 *
 * This block is cursor-deduplicated, so the full budget is spent only when an
 * orientation signal changes (or a new context epoch starts), not on every
 * prompt. 1,000 characters leaves room for the recovery/action lines that
 * routinely fell beyond the old 600-character ceiling while remaining a small
 * fraction of the turn-start memory budget.
 */
export const ORIENTATION_BUDGET_CHARS = 1_000;

export const ORIENTATION_CURSOR_SURFACE = 'orientation';

/**
 * DELIBERATELY TERSE. This is paid on every turn that changes anything, and it
 * competes with the CONTENT for the budget. An earlier 62-char heading
 * ("Your orientation (delivered — you did not have to ask for it)") consumed
 * enough of a tight budget that the highest-priority line no longer fit and the
 * fold emitted NOTHING — going silent in exactly the case it exists for. Caught
 * by the budget test; keep this short.
 */
const HEADING = 'Orientation';

/** Held items printed in full before collapsing to a count — keeps the line
 *  useful under pressure instead of dropping it wholesale. */
const HELD_DISPLAY_CAP = 5;
const CHECKPOINT_DISPLAY_CAP = 2;
const CHECKPOINT_EXCERPT_CHARS = 150;
const GATE_DISPLAY_CAP = 3;
const INBOX_DISPLAY_CAP = 2;
/** Two keys is enough to say "a do-not-repeat exists here"; the count carries the
 *  rest. Kept small because composeOrientationBlock BREAKS on the first line that
 *  does not fit, so an overlong line here silently truncates every line below it. */
const FACT_DISPLAY_CAP = 2;
const FACT_KEY_CHARS = 38;
const IMPROVEMENT_TRIAGE_WINDOW_LIMIT = 100;
/**
 * Hook-origin calls required before the toolless warning fires (EI-21308269358666878).
 *
 * MEASURED, not guessed. Among active agent owners with ZERO agent-origin calls since
 * their context epoch, the hook-call distribution has a hard cliff — 355, 96, then 12,
 * 8, 8, 5, 4, 3, 2… — so every threshold in 20..90 selects the same set, and 20 keeps
 * margin above the low-activity noise floor while still firing within a few turns of
 * onset. Live 6h sample: 1 flagged of 243 active agent owners (0.41%).
 */
export const TOOLLESS_HOOK_THRESHOLD = 20;

/** One owner whose call-origin split proves its Papercusp MCP surface loaded
 * empty. Kept beside OrientationToolSurface so every consumer uses the same
 * units, epoch anchor, threshold, and deliberately-unscoped invocation query. */
export interface OrientationToolSurfaceOwner extends OrientationToolSurface {
  ownerId: string;
}

/**
 * Read the call-origin split for one or many owners in one bounded SQL shape.
 *
 * This is the shared source of truth for both the turn-start warning and the
 * mcp-dark watchdog's recovery consumer. Keeping the query here prevents the
 * two from drifting on the three load-bearing constraints above: anchor on the
 * current context epoch, require zero agent-origin calls, and NEVER filter by
 * harness/workspace (workspace-global tools legitimately record `*`).
 */
export async function readOrientationToolSurfaces(
  sql: Sql,
  ownerIds: string[],
): Promise<OrientationToolSurfaceOwner[]> {
  if (ownerIds.length === 0) return [];
  const rows = await sql<Array<{ owner_id: string; hook_calls: string | number; window_minutes: string | number }>>`
    WITH anchors AS (
      SELECT session_id AS owner_id, bumped_at
        FROM harness_shared.memory_session_epochs
       WHERE session_id = ANY(${ownerIds})
    ), silent AS (
      SELECT a.owner_id, a.bumped_at
        FROM anchors a
       WHERE NOT EXISTS (
               SELECT 1
                 FROM harness_shared.tool_invocations t
                WHERE t.coord_owner_id = a.owner_id
                  AND t.invoked_at >= a.bumped_at
                  AND t.call_origin = 'agent'
             )
    )
    SELECT s.owner_id,
           count(*) FILTER (WHERE t.call_origin = 'hook') AS hook_calls,
           floor(extract(epoch FROM (now() - s.bumped_at)) / 60)::int AS window_minutes
      FROM silent s
      LEFT JOIN harness_shared.tool_invocations t
        ON t.coord_owner_id = s.owner_id
       AND t.invoked_at >= s.bumped_at
     GROUP BY s.owner_id, s.bumped_at
  `;
  return rows.flatMap((row) => {
    const hookCalls = Number(row.hook_calls);
    if (!Number.isFinite(hookCalls) || hookCalls < TOOLLESS_HOOK_THRESHOLD) return [];
    const windowMinutes = Number(row.window_minutes);
    return [
      {
        ownerId: row.owner_id,
        hookCalls,
        windowMinutes: Number.isFinite(windowMinutes) ? windowMinutes : 0,
      },
    ];
  });
}

/**
 * P-002: is any delivered obligation still UNDISCHARGED?
 *
 * A class-B row is discharged by DISPOSITION, not by DELIVERY. `agenda.primary`
 * is already exactly the actionable set — `evaluateAgentObligations` filters it
 * with `agentObligationIsActionable`, and each entry carries its own
 * `clearsWhen` predicate naming the effect that ends it. So the discharge
 * question is answered by the canonical agenda, never re-derived here.
 *
 * Reading `primary` rather than `projection.entries` is deliberate: a row the
 * outer budget OMITTED is still undischarged, and the "+N omitted — <detailRef>"
 * pointer must keep rendering while it is.
 */
export function hasUndischargedObligations(state: OrientationState): boolean {
  return (state.obligations?.primary.length ?? 0) > 0;
}

/**
 * The reduced state used when every class is unchanged but an obligation is
 * still undischarged: obligations ONLY.
 *
 * Re-emitting the WHOLE block each turn for one standing row would repeat held
 * items, gates and facts that genuinely have not changed — manufacturing the
 * exact signal decay D-003 withdrew the improvement-triage line for. The item
 * says an obligation ROW renders every turn, not the block, so this keeps the
 * re-injection as narrow as the contract requires.
 *
 * `loopArmed: true` is the QUIET value, not an assertion about the loop: the
 * renderer warns on a loop that is NOT armed, so `false` here would fabricate a
 * "not armed" line on a healthy session every time a directive went unsettled.
 */
function undischargedObligationsOnly(state: OrientationState): OrientationState {
  return {
    held: [],
    unansweredDirected: 0,
    unansweredStale: 0,
    inboxRecent: [],
    openAsks: null,
    announcedGates: [],
    // `[]`, not null: the QUIET value. Empty renders no transition line, which
    // is right for an obligations-only re-emit — the modes have not changed, so
    // repeating their attribution would be the signal decay this projection
    // exists to avoid. null would mean "unreadable", which is a different and
    // untrue claim on a turn where we simply did not look.
    modes: [],
    // `null` is the QUIET value HERE, and — unlike `modes` above — it carries no
    // "unreadable" claim, because this projection is RENDER-ONLY: composeOrientationBlock
    // fingerprints the FULL state before building it, so nothing in here reaches a cursor.
    // There is no empty AuthorityVerdict to use instead (the type is three required
    // strings, and a blank-valued one would render `- authority: exec  …` on a first
    // turn), so null — which renders unconditionally nothing — is the honest choice.
    authorityVerdict: null,
    // `undefined` is the QUIET value for this class (renders nothing), and is
    // the honest one here for the same reason as `authorityVerdict: null`
    // above: this projection did not look, so it must not claim a measured
    // empty. `{ decisions: [] }` would be the "no new decisions" assertion
    // D-081 ruling 3 forbids building on anything but a real read.
    planDecisions: undefined,
    // `undefined` for the same reason as `planDecisions` directly above: this
    // projection did not read the lock queue, so it must not claim the
    // measured-empty `{ held: [], blocked: [], observed: [] }`. That value would
    // assert "nothing about your locks changed" from a read that never
    // happened — and, worse than for decisions, it would WRITE an empty
    // observed-set token, so the next real read would see every standing hold
    // as new.
    lockTransitions: undefined,
    // `[]` — the MEASURED-empty value — is right here, and the asymmetry with
    // `lockTransitions: undefined` directly above is deliberate, not an
    // oversight. That field must be `undefined` because it WRITES a watermark
    // token (`observed`), so a projection claiming measured-empty would erase
    // the cursor. `coupledPeers` in THIS projection reaches no cursor at all —
    // it is a render-only view — so the preserve-on-unreadable argument does
    // not apply, and `[]` both renders nothing and asserts nothing. Same
    // convention as `modes: []`.
    coupledPeers: [],
    loopArmed: true,
    loopFireWithheld: false,
    improvementTriage: null,
    executableFrontier: null,
    neverDropFacts: [],
    toolSurface: null,
    carryBlindWindow: null,
    obligations: state.obligations,
  };
}

/**
 * P-006 of owner-directive-delivery-redesign-2026-09-22 (D-005): the addressed
 * agent's reminder cadence for its own open owner directives.
 *
 * Every other class-B row re-emits every turn it stays undischarged (P-002 above).
 * An owner directive does not: its obligation row is delivered ONCE per context
 * epoch, and after that the agent gets ONE line naming the directives still open
 * each time its context has grown by {@link OWNER_DIRECTIVE_REMINDER_TOKENS}.
 * The owner's words for "why": a standing row every turn is the per-turn cost
 * directive #200 asked to remove, and the verbatim text already rides once per
 * epoch in the ownerDirectives class.
 *
 * The cursor carries the bookkeeping as `directiveReminder`: which directive rows
 * this epoch has already delivered, the context size at the last delivery, and
 * how many reminders have gone unanswered. It is carried state only — deliberately
 * NOT compared by {@link orientationUnchanged}, so a reminder never re-emits the
 * rest of the block.
 */
export const OWNER_DIRECTIVE_REMINDER_TOKENS = 50_000;
/** Without a context-size reading, fall back to a wall-clock cadence. */
export const OWNER_DIRECTIVE_REMINDER_FALLBACK_MS = 30 * 60_000;
/** Reminders ignored this many times escalate their wording. */
export const OWNER_DIRECTIVE_REMINDER_ESCALATE_AFTER = 3;

interface DirectiveReminderMark {
  epoch: number;
  /** Obligation ids whose full row this epoch has already delivered. */
  ids: string[];
  /** Context size at the last delivery (full row or reminder); null when unknown. */
  tokens: number | null;
  /** Wall-clock of the last delivery, for the unknown-size fallback. */
  at: string;
  /** Reminders delivered since the open set last shrank. */
  reminders: number;
}

function openDirectiveObligations(state: OrientationState): AgentObligation[] {
  return (state.obligations?.primary ?? []).filter(
    (entry) => entry.family === 'owner-directive' && entry.status === 'due',
  );
}

function directiveNumber(entry: AgentObligation): string {
  const match = /owner-directive:(\d+)/.exec(entry.authority.sourceRef ?? '');
  return match ? `#${match[1]}` : entry.id;
}

function readDirectiveMark(committed: CursorState | null, epoch: number): DirectiveReminderMark | null {
  const raw = committed?.directiveReminder;
  if (!raw || typeof raw !== 'object') return null;
  const mark = raw as Partial<DirectiveReminderMark>;
  // A new context epoch forgets everything it delivered: the agent's context no
  // longer holds those rows, so they are due again in full.
  if (mark.epoch !== epoch || !Array.isArray(mark.ids)) return null;
  return {
    epoch,
    ids: mark.ids.filter((id): id is string => typeof id === 'string'),
    tokens: typeof mark.tokens === 'number' ? mark.tokens : null,
    at: typeof mark.at === 'string' ? mark.at : '',
    reminders: typeof mark.reminders === 'number' ? mark.reminders : 0,
  };
}

export interface OwnerDirectiveReminderPlan {
  /** Open directive rows already delivered this epoch — left out of the render. */
  withheld: Set<string>;
  /** The one reminder line to add this turn, or null. */
  reminder: string | null;
}

/**
 * Decide, for one composition, which directive rows to withhold and whether the
 * reminder line is due. Pure over (state, committed, epoch, contextTokens), so the
 * composer and the delivered-fingerprint reach the SAME answer without passing it
 * along. `contextTokens` is the agent's context size (null = unknown), an input to
 * the cadence like `epoch` is to the dedup — which is why neither is on
 * OrientationState, whose every field is a rendered class.
 */
export function planOwnerDirectiveReminder(
  state: OrientationState,
  committed: CursorState | null,
  epoch: number,
  contextTokens: number | null = null,
): OwnerDirectiveReminderPlan {
  const open = openDirectiveObligations(state);
  const mark = readDirectiveMark(committed, epoch);
  if (open.length === 0 || !mark) return { withheld: new Set(), reminder: null };
  const delivered = new Set(mark.ids);
  const withheld = open.filter((entry) => delivered.has(entry.id));
  if (withheld.length === 0) return { withheld: new Set(), reminder: null };
  const now = state.obligations?.evaluatedAt ?? '';
  const grown =
    contextTokens != null && mark.tokens != null
      ? contextTokens - mark.tokens >= OWNER_DIRECTIVE_REMINDER_TOKENS
      : Date.parse(now) - Date.parse(mark.at) >= OWNER_DIRECTIVE_REMINDER_FALLBACK_MS;
  return {
    withheld: new Set(withheld.map((entry) => entry.id)),
    reminder: grown ? renderDirectiveReminder(withheld, mark.reminders + 1) : null,
  };
}

function renderDirectiveReminder(entries: AgentObligation[], nth: number): string {
  // Ascending by number: the agenda's own order tie-breaks on hashed obligation
  // ids, which would shuffle the same set between otherwise identical sessions.
  const ids = entries
    .map(directiveNumber)
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
    .join(', ');
  const noun = entries.length === 1 ? 'owner directive' : 'owner directives';
  if (nth > OWNER_DIRECTIVE_REMINDER_ESCALATE_AFTER) {
    return (
      `- ⚠ reminder ${nth}, still unanswered: ${noun} ${ids} addressed to you — do it now, ` +
      `or close it with orders:disposition (declined + reason if you will not)`
    );
  }
  return `- 📌 reminder: ${noun} ${ids} still open and yours — carry out, then orders:disposition`;
}

/**
 * The state the composer RENDERS once the withheld directive rows are removed:
 * the obligation brief is re-projected through the same turn-start sink contract,
 * so the remaining rows get the budget the withheld ones no longer take.
 */
export function withoutWithheldDirectiveRows(state: OrientationState, withheld: Set<string>): OrientationState {
  const brief = state.obligations;
  if (!brief || withheld.size === 0) return state;
  const primary = brief.primary.filter((entry) => !withheld.has(entry.id));
  if (primary.length === brief.primary.length) return state;
  if (primary.length === 0) return { ...state, obligations: null };
  return {
    ...state,
    obligations: projectAgentTurnStartObligationBrief({
      schemaVersion: brief.schemaVersion,
      evaluatedAt: brief.evaluatedAt,
      sourceGeneration: brief.sourceGeneration,
      evaluations: brief.evaluations,
      primary,
      conflicts: [],
    }),
  };
}

/**
 * The mark to carry forward after a delivery. A directive row counts as delivered
 * only if its line is in the block, and the reminder only if its line is: budget
 * truncation must never mark something seen that the agent was not shown.
 */
function nextDirectiveMark(
  state: OrientationState,
  committed: CursorState | null,
  epoch: number,
  block: string,
  contextTokens: number | null,
): DirectiveReminderMark | undefined {
  // An unreadable agenda says nothing about directives: keep the last mark.
  if (state.obligations === undefined) {
    const kept = readDirectiveMark(committed, epoch);
    return kept ?? undefined;
  }
  const open = openDirectiveObligations(state);
  if (open.length === 0) return undefined;
  const mark = readDirectiveMark(committed, epoch);
  const plan = planOwnerDirectiveReminder(state, committed, epoch, contextTokens);
  const openIds = new Set(open.map((entry) => entry.id));
  const kept = (mark?.ids ?? []).filter((id) => openIds.has(id));
  const fresh = open
    .filter((entry) => !plan.withheld.has(entry.id))
    .filter((entry) => block.includes(formatAgentObligationLine(entry, 'action')))
    .map((entry) => entry.id);
  const reminded = plan.reminder !== null && block.includes(plan.reminder);
  const now = state.obligations?.evaluatedAt ?? mark?.at ?? '';
  const touched = reminded || fresh.length > 0 || !mark;
  const shrank = (mark?.ids.length ?? 0) > kept.length;
  return {
    epoch,
    ids: [...kept, ...fresh].sort(),
    tokens: touched ? (contextTokens ?? mark?.tokens ?? null) : (mark?.tokens ?? null),
    at: touched ? now : (mark?.at ?? now),
    reminders: shrank ? 0 : (mark?.reminders ?? 0) + (reminded ? 1 : 0),
  };
}

/** True when there is genuinely nothing worth spending a single character on. */
export function isEmptyOrientation(state: OrientationState): boolean {
  return (
    state.held.length === 0 &&
    !state.heldReadFailed &&
    (!state.ownerDirectives || state.ownerDirectives.length === 0) &&
    (!state.historyUpdates || state.historyUpdates.length === 0) &&
    (!state.effortUpdates || state.effortUpdates.length === 0) &&
    (!state.openChecks || state.openChecks.length === 0) &&
    state.unansweredDirected === 0 &&
    state.unansweredStale === 0 &&
    state.openAsks === null &&
    state.inboxRecent.length === 0 &&
    state.announcedGates.length === 0 &&
    // A mode row holds the block OPEN, exactly like `loopArmed` beside it.
    // Without this conjunct an agent whose only signal is its posture (a fresh
    // AUTO session holding nothing, with an empty inbox) is judged "nothing
    // worth saying" and returns '' BEFORE the watermark is ever consulted — so
    // the transition line could never render at all. Holding the block open is
    // safe: `orientationUnchanged` still suppresses it on every later turn.
    (state.modes?.length ?? 0) === 0 &&
    // Same rule as the mode row above (P-013): a READABLE authority verdict holds
    // the block open. Without this conjunct an agent whose only signal is its
    // authority — the common shape on a first turn: nothing held, empty inbox, no
    // mode set, so the verdict is the generic confirm-first posture — returns ''
    // BEFORE the watermark is consulted, and the line could never render at all.
    // Holding it open is safe: `orientationUnchanged` suppresses every later turn,
    // and composeOrientationBlock still emits '' when no line survives.
    state.authorityVerdict === null &&
    // Same rule as the two rows above: a READABLE, non-empty decisions set holds
    // the block OPEN. Without this conjunct an agent whose only signal is a new
    // governing ruling on its plan returns '' before the watermark is consulted,
    // and the line could never render at all. An UNREADABLE read (`undefined`)
    // must NOT hold it open — that would spend a block on a class that renders
    // nothing.
    (state.planDecisions?.decisions.length ?? 0) === 0 &&
    // P-015: the same `?? 0` shape, and for the same reason — an UNREADABLE
    // read must NOT hold the block open, because the class renders nothing on
    // it and the block would have no visible cause. A measured-empty set is
    // likewise quiet: no transition means no line, which is the steady state
    // this class is defined to stay silent through.
    (state.lockTransitions?.held.length ?? 0) +
      (state.lockTransitions?.blocked.length ?? 0) ===
      0 &&
    // P-016: the same `?? 0` shape, and for the same reason — an UNREADABLE
    // read (`null`) must NOT hold the block open, because the class renders
    // nothing on it and the block would have no visible cause. A coupled peer
    // whose intent is unchanged is likewise quiet: no transition, no line,
    // which is the steady state this class is defined to stay silent through.
    (state.coupledPeers?.length ?? 0) === 0 &&
    !state.loopArmed &&
    !state.loopFireWithheld &&
    // improvementTriage is NOT a conjunct here (P-017): it no longer renders,
    // so letting it hold the block open would emit a block whose only reason
    // for existing is invisible to the reader.
    state.executableFrontier === null &&
    !state.obligations &&
    state.neverDropFacts.length === 0 &&
    state.toolSurface === null &&
    state.carryBlindWindow === null
  );
}

/**
 * The durable loop-status discriminator for a fire that never reached the wake
 * ladder. A withhold deliberately leaves `lastFiredAt` alone, so the signal is
 * current only when its timestamp is at or after the latest fire. Invalid or
 * incomplete status is fail-open: orientation must not call an armed loop dead
 * merely because observability is unavailable.
 */
export function isLoopFireWithheld(
  status:
    | {
        active: boolean;
        lastFiredAt?: string | null;
        lastWithheldAt?: string | null;
      }
    | null
    | undefined,
): boolean {
  if (!status?.active || !status.lastFiredAt || !status.lastWithheldAt) return false;
  const lastFiredMs = Date.parse(status.lastFiredAt);
  const lastWithheldMs = Date.parse(status.lastWithheldAt);
  return Number.isFinite(lastFiredMs) && Number.isFinite(lastWithheldMs) && lastWithheldMs >= lastFiredMs;
}

/**
 * PURE: the compact fingerprint this turn's orientation is diffed against.
 *
 * The held-item key is `id:status`, so this fingerprint CAN re-emit on a
 * wip→blocked move — but ⚠ v1 DOES NOT: `defaultOrientationDeps.held` populates
 * `{ id }` only (see the note at its definition — `CarryBriefHeldItem` has no
 * `status` field), so in v1 every status collapses to `''` and only a CLAIM or
 * RELEASE re-emits. The `:status` half is the seam a status-carrying source
 * drops into, not a description of current behaviour — do not cite it as one.
 *
 * ── WHY `epoch` IS PART OF THE KEY (P-023 / D-008) ───────────────────────────
 *
 * The cursor this fingerprint is stored under is keyed `(workspace_id, owner_id,
 * surface)` — the OWNER. But what the fold actually dedups against is the
 * agent's CONTEXT: the block is suppressed because "you were already told", and
 * that is only true while the context it was told into still exists. Wherever
 * those two diverge — the owner id survives but the context does not — the fold
 * went silent for a successor that knew nothing, which is precisely the boundary
 * it exists to serve.
 *
 * That divergence is not hypothetical and not rare. A carry-respawn and a cold
 * loop wake both preserve the owner id and discard the context, and both are the
 * cases where orientation state is MOST likely to be byte-identical to the
 * predecessor's last turn (nothing changed — the process merely restarted). So
 * the suppression was ANTI-CORRELATED with need: the more cleanly the boundary
 * preserved state, the more certain the successor was told nothing.
 *
 * `epoch` is `memory_session_epochs.epoch` — the context generation the memory
 * surfaced-ledger already dedups on for exactly this reason (D-002/D-006). Both
 * folds ride the same rail; keying them the same way is what stops them
 * disagreeing about what a boundary means.
 *
 * A committed value written before this key existed has no `epoch` field, so it
 * compares unequal and re-emits once. That is the intended migration: fail-open,
 * one extra block, never a silent stale suppression.
 *
 * Keep this small — it is stored per agent per turn, and its only job is to
 * answer "same as last time, in the same context?".
 */
function encodeExecutableFrontier(frontier: OrientationExecutableFrontier): string {
  return JSON.stringify([frontier.planSlug, frontier.executableWidth]);
}

function encodeAnnouncedGate(gate: OrientationAnnouncedGate): string {
  return JSON.stringify([
    gate.event,
    gate.note ?? null,
    gate.logical_gate ?? null,
    gate.live_awaiters === undefined ? null : gate.live_awaiters,
    gate.live_successor_ids === undefined ? null : [...gate.live_successor_ids].sort(),
    gate.stale_owner === undefined ? null : gate.stale_owner,
    gate.warning ?? null,
  ]);
}

function decodeExecutableFrontier(value: unknown): OrientationExecutableFrontier | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [planSlug, executableWidth] = parsed;
    if (
      typeof planSlug !== 'string' ||
      !planSlug ||
      !Number.isSafeInteger(executableWidth) ||
      (executableWidth as number) < 0
    ) {
      return null;
    }
    return { planSlug, executableWidth: executableWidth as number };
  } catch {
    return null;
  }
}

export function fingerprintOrientation(
  state: OrientationState,
  epoch: number,
  committed: CursorState | null = null,
): CursorState {
  return {
    held: state.heldReadFailed ? '!unavailable' : state.held
      .map(
        (h) =>
          `${h.id}:${h.status ?? ''}:${h.checkpoint ? 1 : 0}:` +
          `${h.checkpointUpdatedAtMs ?? ''}:${h.checkpointStale ? 1 : 0}`,
      )
      .sort()
      .join(','),
    // Directive rows are immutable owner speech, so a token changes only when a
    // directive appears, closes, gains its summary, or changes hands.
    ownerDirectives: (state.ownerDirectives ?? [])
      .map((d) => `${d.id}:${d.status ? directiveStatusLabel(d.status) : ''}:${d.summaryText ?? ''}`)
      .join('|'),
    historyUpdates:
      state.historyUpdates === undefined
        ? typeof committed?.historyUpdates === 'string'
          ? committed.historyUpdates
          : ''
        : state.historyUpdates
            .map((u) => `${u.workItemId}:${u.count}:${u.newestPostId}`)
            .sort()
            .join(','),
    effortUpdates:
      state.effortUpdates === undefined
        ? typeof committed?.effortUpdates === 'string'
          ? committed.effortUpdates
          : ''
        : state.effortUpdates
            .map((u) => `${u.level}:${u.ref}:${u.count}:${u.newestPostId}`)
            .sort()
            .join(','),
    // Same UNKNOWN-preserving rule as the two above. The token deliberately keys on
    // `contested` as well as identity: a row flipping PREDICTED → CONTESTED is the
    // single most action-worthy transition this class has (evidence arrived that
    // DISPROVES a claim the agent may already be acting on), and a token keyed on
    // identity alone would suppress it as "the same row, still open".
    // It does NOT key on the claim text: re-wording a row is not new information,
    // and `carryRowKey` exists precisely so identity survives a rewrite (P-013).
    openChecks:
      state.openChecks === undefined
        ? typeof committed?.openChecks === 'string'
          ? committed.openChecks
          : ''
        : state.openChecks
            .map((c) => `${c.kind}:${c.id}:${c.contested ? 1 : 0}`)
            .sort()
            .join(','),
    unanswered: state.unansweredDirected,
    // EI-20085805220385722: its own token, not folded into `unanswered` — the
    // two move independently (a sender DYING demotes an ask from one to the
    // other with the total unchanged, and that transition is exactly what the
    // reader needs re-emitted).
    unansweredStale: state.unansweredStale,
    // COUNT ONLY, mirroring `unanswered` above (not identity, not age): a
    // fingerprint keyed on oldestAgeMs would re-emit every turn purely
    // because time passed, defeating the whole point of the diff.
    openAsks: state.openAsks ? state.openAsks.count : 0,
    inbox: state.inboxRecent.map((entry) => `${entry.msgId}:${entry.from}:${entry.summary ?? ''}`).join('|'),
    gates: state.announcedGates
      .map(encodeAnnouncedGate)
      .sort()
      .join('|'),
    // IDENTITY, never `setAt` (P-012 / D-071): a time-derived component would
    // re-emit every turn purely because time passed — the trap `openAsks` and
    // `frontier` are already commented against in this same function.
    //
    // UNKNOWN preserves the last known token, exactly like `frontier` below. A
    // transient failure to read the mode store must not erase the cursor, or
    // the next successful read would re-render an unchanged posture as if it
    // were a fresh transition.
    modes: state.modes
      ? encodeModeStates(state.modes)
      : typeof committed?.modes === 'string'
        ? committed.modes
        : '',
    // P-013 / D-073: keyed on the three DECISION VALUES, never on the
    // InstructionPrecedenceTrace watermark. That watermark hashes `scope.items`
    // and `loop.intervalSec`, so it moves on every plan-item claim/release and
    // every loop re-arm while the verdict text is byte-identical — a strictly
    // wider key than the thing it would gate, which re-emits an unchanged line.
    //
    // UNKNOWN preserves the last known token, exactly like `modes` above: a
    // transient control-state read failure must not erase the cursor and make an
    // unchanged authority look like a fresh transition on the next good read.
    // P-014 / D-081 ruling 1: the token is the sorted REF SET, not a timestamp
    // — the reader projects no recordedAt/seq to compare (see
    // {@link OrientationPlanDecision}). Same preserve-on-unreadable rule as
    // `authority` below: an UNREADABLE read (`undefined`) carries the committed
    // token forward, so a transient failure cannot erase the cursor and make
    // every already-seen decision re-render as new on recovery. That failure
    // mode is worse here than for a scalar: it would re-emit the whole set.
    planDecisions: state.planDecisions
      ? state.planDecisions.decisions
          .map((d) => d.ref)
          .sort()
          .join(',')
      : typeof committed?.planDecisions === 'string'
        ? committed.planDecisions
        : '',
    // P-015: the token is the whole OBSERVED held+waiting identity set, sorted
    // — NOT the transitions, and NOT a timestamp (P-012 / D-071). Three
    // properties follow, and all three are load-bearing:
    //   1. IDENTITY, so a lock held unchanged across turns produces a
    //      byte-identical token and the class stays silent — the steady state
    //      this class is defined by.
    //   2. The WHOLE observed set, so a RELEASE moves the token too. Encoding
    //      only the transitions would leave a released lock in the cursor
    //      forever and re-emit its grant on the next acquire.
    //   3. Preserve-on-unreadable, exactly as `planDecisions` above: an
    //      UNREADABLE read carries the committed token forward, so a transient
    //      queue-read failure cannot erase the cursor and re-emit every
    //      standing hold as a fresh grant on recovery.
    locks: state.lockTransitions
      ? [...state.lockTransitions.observed].sort().join(',')
      : typeof committed?.locks === 'string'
        ? committed.locks
        : '',
    // P-016: the token is the WHOLE observed coupled set — one `id:digest` per
    // peer, sorted — for the same three reasons the `locks` token above lists:
    //   1. IDENTITY, so a peer whose intent is unchanged across turns produces
    //      a byte-identical token and the class stays silent.
    //   2. The WHOLE set, so a DECOUPLE moves the token too. Encoding only the
    //      CHANGED peers would leave a dropped edge in the cursor forever and
    //      re-emit its intent on the next re-couple.
    //   3. Preserve-on-unreadable, exactly as `locks` and `planDecisions`
    //      above: an UNREADABLE read carries the committed token forward, so a
    //      transient presence-read failure cannot erase the cursor and re-emit
    //      every coupled peer's standing intent as a fresh change on recovery.
    coupledPeers: state.coupledPeers
      ? state.coupledPeers.map(encodeCoupledPeer).sort().join('|')
      : typeof committed?.coupledPeers === 'string'
        ? committed.coupledPeers
        : '',
    authority: state.authorityVerdict
      ? encodeAuthorityVerdict(state.authorityVerdict)
      : typeof committed?.authority === 'string'
        ? committed.authority
        : '',
    loop: state.loopArmed ? 1 : 0,
    loopWithheld: state.loopFireWithheld ? 1 : 0,
    // `triage` is deliberately ABSENT from the watermark (P-017). It stopped
    // rendering, and a component for an unrendered class would re-mark the
    // block as changed for a signal the reader can no longer see — a re-emit
    // with no visible cause, which is worse than the row it replaced.
    // UNKNOWN preserves the last known frontier token. A transient read failure
    // must not erase the cursor and make the same stable width look like a new
    // edge on the next successful turn.
    frontier: state.executableFrontier
      ? encodeExecutableFrontier(state.executableFrontier)
      : typeof committed?.frontier === 'string'
        ? committed.frontier
        : '',
    obligations:
      state.obligations === undefined
        ? typeof committed?.obligations === 'string'
          ? committed.obligations
          : ''
        : (state.obligations?.sourceGeneration ?? ''),
    // A NEWLY asserted guard-rail / dead-end / wall MUST re-emit the block. It is
    // most valuable on the very turn it first applies, and a fingerprint blind to
    // it would suppress the fold for an agent already mid-mistake — the same
    // "absent where it is needed most" failure EI-18725816532600240 describes.
    facts: state.neverDropFacts.slice().sort().join('|'),
    // MUST VARY WHILE THE CONDITION PERSISTS. `hookCalls` strictly increases on
    // every turn a toolless agent takes — the hooks are precisely what keep firing
    // — so this token changes each turn and the warning RE-EMITS. A constant token
    // (a bare boolean, say) would make the single most important line in this block
    // a ONE-SHOT: shown once, then suppressed as "unchanged" for the rest of a
    // session that cannot act. That is the `facts` trap noted below, in the one
    // case where the agent has no way to recover the information for itself.
    toolSurface: state.toolSurface ? `${state.toolSurface.hookCalls}` : '',
    // A one-shot BY CONSTRUCTION, not by suppression: both endpoints and the
    // count are bounded at the CUT, so the token is frozen the moment the
    // successor boots and the line renders exactly once per respawn. (An
    // unbounded count would keep growing with the successor's own calls and
    // re-emit a different line every turn — the noise this token's stability
    // buys us.) The epoch bump at the boundary guarantees the first emission.
    carryBlind: state.carryBlindWindow ? `${state.carryBlindWindow.cutAtMs}:${state.carryBlindWindow.callsAfter}` : '',
    epoch,
  };
}

/** PURE: is `committed` the same orientation this fingerprint describes? */
export function orientationUnchanged(committed: CursorState | null, next: CursorState): boolean {
  if (!committed || typeof committed !== 'object') return false;
  const a = committed as Record<string, unknown>;
  const b = next as Record<string, unknown>;
  return (
    a.held === b.held &&
    a.ownerDirectives === b.ownerDirectives &&
    (a.historyUpdates ?? '') === (b.historyUpdates ?? '') &&
    (a.effortUpdates ?? '') === (b.effortUpdates ?? '') &&
    // REQUIRED, and the easiest line in this file to omit: writing the `openChecks`
    // token in fingerprintOrientation does NOTHING unless it is compared here. Drop
    // this and the class degrades to a one-shot with no visible symptom — a newly
    // CONTESTED claim is silently suppressed as "unchanged", which is precisely the
    // inherit-instead-of-falsify failure the class exists to prevent.
    (a.openChecks ?? '') === (b.openChecks ?? '') &&
    a.unanswered === b.unanswered &&
    // REQUIRED, same rule as `unanswered` beside it: writing the token in
    // fingerprintOrientation does nothing unless it is compared here.
    (a.unansweredStale ?? 0) === (b.unansweredStale ?? 0) &&
    (a.openAsks ?? 0) === (b.openAsks ?? 0) &&
    a.inbox === b.inbox &&
    a.gates === b.gates &&
    a.loop === b.loop &&
    a.loopWithheld === b.loopWithheld &&
    // REQUIRED, and the single easiest line in this change to omit: writing the
    // `modes` token in fingerprintOrientation does NOTHING unless it is
    // compared HERE. Drop this and a mode transition never makes the block
    // eligible to emit on its own — the line then appears only when some
    // unrelated token happens to change, which is precisely the one-shot-with-
    // no-visible-symptom failure the comments above describe three times over.
    (a.modes ?? '') === (b.modes ?? '') &&
    // REQUIRED for exactly the reason the `modes` line above is (P-013 / D-071
    // ruling 1): the `authority` token written in fingerprintOrientation is INERT
    // unless it is compared HERE. Drop this and an authority TRANSITION — the
    // owner flipping AUTO on, a fleet route changing the mission, the mode
    // registry going unreadable and the verdict falling to `conflict` — never
    // makes the block eligible to emit on its own. The line would then appear
    // only when some unrelated token happened to change, i.e. a one-shot with no
    // visible symptom, on the class describing what the agent is ALLOWED TO DO.
    (a.authority ?? '') === (b.authority ?? '') &&
    // P-014, and the SAME required pairing as `authority` above and `openChecks`
    // higher up: the `planDecisions` token written in fingerprintOrientation is
    // INERT unless it is compared HERE. Drop this line and a newly recorded
    // governing ruling is silently suppressed as "unchanged" — the class would
    // pass every render test while never firing on the turn that matters.
    (a.planDecisions ?? '') === (b.planDecisions ?? '') &&
    // P-015, and the SAME required pairing every token above carries: the
    // `locks` token written in fingerprintOrientation is INERT unless it is
    // compared HERE. Drop this line and a grant that lands while the agent is
    // parked is suppressed as "unchanged" — the class would pass every render
    // test while never firing on the one turn it exists for.
    (a.locks ?? '') === (b.locks ?? '') &&
    // P-016, and the SAME required pairing every token above carries: the
    // `coupledPeers` token written in fingerprintOrientation is INERT unless it
    // is compared HERE. Drop this line and a peer changing intent never makes
    // the block eligible to emit on its own — the line would appear only when
    // some unrelated token happened to change, i.e. the one-shot-with-no-
    // visible-symptom failure this file now warns about five times over, on the
    // class whose entire purpose is to fire on that one transition.
    (a.coupledPeers ?? '') === (b.coupledPeers ?? '') &&
    (a.obligations ?? '') === (b.obligations ?? '') &&
    // REQUIRED, and easy to omit: fingerprintOrientation writing a `facts` token
    // does nothing on its own — this whitelist is what decides re-emission. Without
    // the comparison a newly-landed guard rail is suppressed as "unchanged",
    // which is the silent half of the bug this fold exists to fix.
    a.facts === b.facts &&
    // REQUIRED for the same reason `facts` is: writing the fingerprint token above
    // does NOTHING unless it is compared HERE. Omitting this line reinstates the
    // one-shot warning with no visible symptom — the block simply goes quiet.
    a.toolSurface === b.toolSurface &&
    // Same rule again (EI-21442716425230784): the token is inert unless compared
    // here. It also matters in the OTHER direction — a measured blind window
    // arriving on a turn whose every other token is unchanged (the common shape:
    // a successor's first turn holding the same items its predecessor did) must
    // still re-emit the block, or the one warning that cannot be re-derived is
    // the one that is suppressed.
    (a.carryBlind ?? '') === (b.carryBlind ?? '') &&
    a.triage === b.triage &&
    (a.frontier ?? '') === (b.frontier ?? '') &&
    a.epoch === b.epoch
  );
}

function renderExecutableFrontierLine(
  frontier: OrientationExecutableFrontier | null,
  committed: CursorState | null,
): string | null {
  if (!frontier) return null;
  const previous = decodeExecutableFrontier(committed?.frontier);
  if (previous?.planSlug === frontier.planSlug && previous.executableWidth === frontier.executableWidth) {
    return null;
  }
  if (!previous) return `- frontier: ${frontier.executableWidth} executable (${frontier.planSlug}).`;
  if (previous.planSlug === frontier.planSlug) {
    return `- frontier: ${previous.executableWidth} -> ${frontier.executableWidth} executable (${frontier.planSlug}).`;
  }
  return (
    `- frontier: ${previous.planSlug}@${previous.executableWidth} -> ` +
    `${frontier.planSlug}@${frontier.executableWidth} executable.`
  );
}

/**
 * The attribution IDENTITY of one mode row — the unit the P-012 diff is keyed
 * on. Excludes `setAt` deliberately (see {@link OrientationModeState}) and
 * `reason` incidentally: a reason is free text, and a watermark component that
 * can grow without bound is a cursor that can outgrow the row it describes.
 */
function encodeModeState(row: OrientationModeState): string {
  return [row.axisKey, row.mode, row.setBy, row.ownerDirected ? '1' : '0', row.impliedBy ?? ''].join(':');
}

function encodeModeStates(rows: readonly OrientationModeState[]): string {
  return rows.map(encodeModeState).sort().join('|');
}

/**
 * P-012 / D-071: the lines for modes that are NEW SINCE the committed cursor.
 *
 * This comparison — NOT the `modes` watermark token — is what satisfies "does
 * not render again while the mode is unchanged". `composeOrientationBlock` is
 * all-or-nothing by design: when ANY token changes, every class re-renders. So
 * a mode line gated only on its own token would reappear verbatim on the next
 * turn an unrelated inbox message arrived. `renderExecutableFrontierLine`
 * above solves the identical problem the identical way.
 */
function renderModeTransitionLines(
  modes: OrientationModeState[] | null,
  committed: CursorState | null,
): string[] {
  // null is UNREADABLE, not "no modes": say nothing rather than assert a
  // posture we could not read.
  if (!modes || modes.length === 0) return [];
  const encoded = typeof committed?.modes === 'string' ? committed.modes : '';
  const previous = new Set(encoded ? encoded.split('|') : []);
  return modes
    .filter((row) => !previous.has(encodeModeState(row)))
    .map((row) => {
      const reason = row.reason.replace(/\s+/g, ' ').trim();
      const suffix = reason ? ` (reason: ${compactHeadline(reason)})` : '';
      // MOST SPECIFIC FIRST. An implied row still carries a `setBy`, and may
      // also carry `ownerDirected` inherited from the directive that triggered
      // the cascade — so testing either of those first would render a derived
      // posture as a decision the actor took directly, and the "implied by"
      // shape the item explicitly names could never appear.
      if (row.impliedBy) return `- mode ${row.mode} ON — implied by ${row.impliedBy}${suffix}.`;
      if (row.ownerDirected) return `- mode ${row.mode} ON — owner-directed${suffix}.`;
      if (row.setBySelf) return `- mode ${row.mode} ON — self-set${suffix}.`;
      return `- mode ${row.mode} ON — set by ${compactActor(row.setBy)}${suffix}.`;
    });
}

/**
 * The three authority decisions, in the order a reader needs them, each with the
 * short label the line renders. Declared ONCE so the encoding, the change
 * detection and the rendered text cannot drift into describing different sets.
 */
const AUTHORITY_DECISIONS: ReadonlyArray<readonly [keyof OrientationAuthorityVerdict, string]> = [
  ['executionAuthorization', 'exec'],
  ['mission', 'mission'],
  ['ideation', 'ideation'],
];

/**
 * P-013 / D-073: the verdict's diff key is its three VALUES — `exec:mission:ideation`.
 *
 * Deliberately not `InstructionPrecedenceTrace.watermark`, which also hashes
 * `scope.items` and `loop.intervalSec` and therefore moves on turns where the
 * agent's authority did not change. Every value is a closed-set kebab literal
 * from `buildInstructionPrecedenceTrace` (or the literal `conflict`), so `:`
 * cannot appear inside one and stays an unambiguous separator.
 */
/**
 * P-016 token for ONE coupled peer: its id plus a BOUNDED DIGEST of the intent
 * it is declaring. Used by BOTH `fingerprintOrientation` and
 * `renderCoupledPeerIntentLines` — they must agree byte-for-byte, or the
 * watermark and the render disagree about what "already seen" means.
 *
 * HASHED, not truncated, and that choice is load-bearing. Truncating the
 * intent makes two intents differing only PAST the cut encode identically, so
 * a real intent change reads as "unchanged" and the line never renders. That
 * is the silent half of this class's failure mode and the harder half to
 * notice, because every fixture with short intents still passes. A digest is
 * bounded just as tightly without the collision.
 *
 * Whitespace is normalised first so a reflowed-but-identical intent cannot
 * fabricate a transition.
 */
function encodeCoupledPeer(peer: OrientationCoupledPeer): string {
  const normalised = peer.intent.replace(/\s+/g, ' ').trim();
  return `${peer.ownerId}:${createHash('sha256').update(normalised).digest('hex').slice(0, 12)}`;
}

function encodeAuthorityVerdict(verdict: OrientationAuthorityVerdict): string {
  return AUTHORITY_DECISIONS.map(([key]) => verdict[key]).join(':');
}

/**
 * Recover the PREVIOUS verdict from the committed cursor, or null when there is
 * none. A malformed or legacy token also yields null, which renders the full
 * verdict rather than a bogus transition — loud and correct beats a silently
 * fabricated `-> `.
 */
function decodeAuthorityVerdict(token: unknown): OrientationAuthorityVerdict | null {
  if (typeof token !== 'string' || token === '') return null;
  const parts = token.split(':');
  if (parts.length !== AUTHORITY_DECISIONS.length) return null;
  return { executionAuthorization: parts[0]!, mission: parts[1]!, ideation: parts[2]! };
}

/**
 * P-013 / D-071 ruling 1: the line for an authority verdict that is NEW SINCE
 * the committed cursor.
 *
 * This comparison — NOT the `authority` watermark token — is what satisfies
 * "unchanged verdict renders nothing". `composeOrientationBlock` is
 * all-or-nothing by design: when ANY token changes, every class re-renders, so a
 * verdict gated only on its own token would reappear verbatim on the next turn
 * an unrelated inbox message arrived. `renderModeTransitionLines` and
 * `renderExecutableFrontierLine` above solve the identical problem identically.
 *
 * Only the CHANGED decisions render on a transition (D-073 ruling 3). Spelling
 * all three on every change costs ~110 chars against a block that STOPS at the
 * first line that does not fit, so the unchanged two would evict a line below
 * them; all three render only when there is no prior cursor to diff against.
 */
/** Max decision rows this class renders; the rest are disclosed as `+N`. */
const PLAN_DECISION_DISPLAY_CAP = 3;

/**
 * P-014: the lines for plan Decisions that are NEW SINCE THE COMMITTED CURSOR.
 *
 * This comparison — NOT the `planDecisions` watermark token — is what makes the
 * class a diff rather than a per-turn re-emit, exactly as for the authority
 * verdict below. The token decides whether the BLOCK is worth building; this
 * decides which decisions the reader has not already been shown.
 */
function renderPlanDecisionLines(
  planDecisions: OrientationPlanDecisions | undefined,
  committed: CursorState | null,
): string[] {
  // UNREADABLE is not "no new decisions" (D-081 ruling 3). Saying nothing is the
  // only honest option: rendering an all-clear here would tell an agent it has
  // seen every governing ruling on its plan at exactly the moment we failed to
  // look — the false-negative class this plan keeps finding.
  if (!planDecisions) return [];
  const seen = new Set(
    typeof committed?.planDecisions === 'string' && committed.planDecisions.length > 0
      ? committed.planDecisions.split(',')
      : [],
  );
  const fresh = planDecisions.decisions.filter((d) => !seen.has(d.ref));
  const lines: string[] = [];
  if (fresh.length > 0) {
    const shown = fresh.slice(0, PLAN_DECISION_DISPLAY_CAP);
    const rest = fresh.length - shown.length;
    for (const d of shown) lines.push(`- plan ${d.planSlug} ${d.id}: ${d.title}`);
    if (rest > 0) {
      lines.push(`- +${rest} more new decision(s) — plans:get { slug, heading:'Decisions' }.`);
    }
  }
  // The two disclosures ride on the turns that render decisions, so they cannot
  // become a standing per-turn nag; both describe why the list above may be
  // INCOMPLETE, which is only actionable next to the list itself.
  if (fresh.length > 0 && planDecisions.omitted > 0) {
    lines.push(
      `- ⚠ ${planDecisions.omitted} older decision(s) fell outside the read window — ` +
        `this is NOT the whole set; plans:get { slug, heading:'Decisions' }.`,
    );
  }
  if (fresh.length > 0 && planDecisions.authorityReadFailed) {
    lines.push('- ⚠ inbound-decision read FAILED — absence here is not evidence of no inbound authority.');
  }
  return lines;
}

/**
 * P-015: how many transition rows render before the `+N more` pointer takes
 * over. Deliberately small — this class exists to say "something changed under
 * you", not to reproduce `locks:queue`.
 */
const COUPLED_PEER_DISPLAY_CAP = 3;
/** Display-only bound on the echoed intent. The TOKEN digests the full string
 *  (see `encodeCoupledPeer`), so clipping here cannot collide two intents. */
const COUPLED_PEER_INTENT_CHARS = 120;

/**
 * P-016 render: one line per coupled peer whose intent CHANGED since the
 * committed cursor.
 *
 * A peer is rendered when its `id:digest` token is NOT in the committed set,
 * which is true in exactly two cases: the intent changed, or the edge is newly
 * coupled. Both are news. Steady state — coupled, intent unchanged — renders
 * NOTHING, and that silence is the point of the class, not a gap in it.
 *
 * A DECOUPLED peer cannot render at all: `resolveCoupledPeers` applies
 * suppression upstream, so a suppressed edge never reaches this function.
 *
 * UNREADABLE (`null`) is not "nothing changed" — the same rule every class
 * above carries. It renders nothing AND preserves the committed token, so the
 * next good read diffs against what the agent actually last saw rather than
 * re-announcing every standing intent.
 */
function renderCoupledPeerIntentLines(
  coupledPeers: OrientationCoupledPeer[] | null,
  committed: CursorState | null,
): string[] {
  if (!coupledPeers) return [];
  const seen = new Set(
    typeof committed?.coupledPeers === 'string' && committed.coupledPeers.length > 0
      ? committed.coupledPeers.split('|')
      : [],
  );
  // The SAME encoder the watermark uses — if these two ever drift, the cursor
  // and the render disagree about what "already seen" means.
  const changed = coupledPeers.filter((peer) => !seen.has(encodeCoupledPeer(peer)));
  if (changed.length === 0) return [];
  const shown = changed.slice(0, COUPLED_PEER_DISPLAY_CAP);
  const lines = shown.map((peer) => {
    const intent =
      peer.intent.length > COUPLED_PEER_INTENT_CHARS
        ? `${peer.intent.slice(0, COUPLED_PEER_INTENT_CHARS)}…`
        : peer.intent;
    return `- coupled ${peer.ownerLabel ?? peer.ownerId} → ${intent}`;
  });
  if (changed.length > shown.length) {
    lines.push(`- +${changed.length - shown.length} more coupled peer(s) changed intent — coord:presence`);
  }
  return lines;
}

const LOCK_TRANSITION_DISPLAY_CAP = 3;

/**
 * P-015: the lines for lock TRANSITIONS since the committed cursor.
 *
 * The whole class lives in this diff. `lockTransitions` is the CURRENT
 * observation — everything this owner holds and everything it waits on — and
 * emitting that set would be the full lock table the item forbids. What
 * renders is only what CHANGED:
 *
 *   GRANTED  `h:<d>:<p>` observed now AND `b:<d>:<p>` ∈ seen AND `h:<d>:<p>` ∉ seen
 *   BLOCKED  `b:<d>:<p>` observed now AND ∉ seen
 *
 * The `b ∈ seen` conjunct on GRANTED is load-bearing and is what keeps the
 * item's word "QUEUED" true: a lock acquired INSTANTLY by this agent's own
 * `locks:acquire` call was already reported to it by that call's own result,
 * so re-announcing it is noise. Only a grant that landed while the agent was
 * PARKED — it queued, ended its turn, and the lock became its own — is news it
 * cannot otherwise have.
 *
 * Steady state (held last turn, still held) therefore renders NOTHING. That
 * silence is the point of the class, not a gap in it.
 */
function renderLockTransitionLines(
  lockTransitions: OrientationLockTransitions | undefined,
  committed: CursorState | null,
): string[] {
  // UNREADABLE is not "nothing changed" — the same rule `planDecisions` above
  // carries. A false all-clear here strands the exact agent this class exists
  // for: one that queued on a lock, parked, and is waiting to be told it now
  // owns it.
  if (!lockTransitions) return [];
  const seen = new Set(
    typeof committed?.locks === 'string' && committed.locks.length > 0
      ? committed.locks.split(',')
      : [],
  );
  const lines: string[] = [];

  const granted = lockTransitions.held.filter((row) => {
    const heldToken = `h:${row.coordinationDomain}:${row.path}`;
    const waitedToken = `b:${row.coordinationDomain}:${row.path}`;
    return seen.has(waitedToken) && !seen.has(heldToken);
  });
  const newlyBlocked = lockTransitions.blocked.filter(
    (row) => !seen.has(`b:${row.coordinationDomain}:${row.path}`),
  );

  // BLOCKED first: it is the row that stops the agent's next action, where a
  // grant merely enables one.
  const rows = [...newlyBlocked, ...granted];
  const shown = rows.slice(0, LOCK_TRANSITION_DISPLAY_CAP);
  for (const row of shown) {
    if (row.kind === 'granted') {
      lines.push(`- lock granted: ${row.path}`);
      continue;
    }
    if (!row.holder) {
      // Never invent a holder. "You are blocked here" is the load-bearing
      // half and still renders; the recovery verb supplies the rest.
      lines.push(
        `- blocked on ${row.path} — holder not attributed; locks:queue { paths: ['${row.path}'] }.`,
      );
      continue;
    }
    const who = row.holder.ownerLabel ?? row.holder.owner;
    lines.push(
      `- blocked on ${row.path} — held by ${who} (${row.holder.intent}, expires ${row.holder.expiresTs})`,
    );
  }
  const rest = rows.length - shown.length;
  if (rest > 0) {
    lines.push(`- +${rest} more lock transition(s) — locks:queue { paths }.`);
  }
  return lines;
}

function renderAuthorityVerdictLine(
  verdict: OrientationAuthorityVerdict | null,
  committed: CursorState | null,
): string[] {
  // null is UNREADABLE, not "no authority": say nothing rather than assert a
  // mandate we could not read. Asserting the generic confirm-first default from
  // a failed read would be a false statement about what the agent may do.
  if (!verdict) return [];
  const previous = decodeAuthorityVerdict(committed?.authority);
  if (!previous) {
    return [`- authority: ${AUTHORITY_DECISIONS.map(([key, label]) => `${label} ${verdict[key]}`).join(' · ')}.`];
  }
  const changed = AUTHORITY_DECISIONS.filter(([key]) => previous[key] !== verdict[key]);
  if (changed.length === 0) return [];
  return [
    `- authority: ${changed.map(([key, label]) => `${label} ${previous[key]} -> ${verdict[key]}`).join(' · ')}.`,
  ];
}

function compactIds(ids: string[], cap: number): string {
  const shown = ids.slice(0, cap);
  const rest = ids.length - shown.length;
  return `${shown.join(', ')}${rest > 0 ? ` +${rest} more` : ''}`;
}

function compactActor(actor: string): string {
  return actor.length <= 18 ? actor : `${actor.slice(0, 15)}…`;
}

/** Terse age for a budget-constrained line — "38m" / "17h", never a full
 *  duration formatter. Deliberately not shared with the fuller `humanAge`
 *  helpers elsewhere (carry-respawn-outcome.ts, release-deploy-staleness-
 *  watchdog.ts): both already duplicate the same tiny shape locally, and a
 *  cross-module import here would cost more than the six lines it saves. */
function compactAgeHours(ageMs: number): string {
  if (!Number.isFinite(ageMs) || ageMs < 0) return '?';
  const minutes = ageMs / 60_000;
  if (minutes < 90) return `${Math.max(1, Math.round(minutes))}m`;
  return `${Math.round(minutes / 60)}h`;
}

/** Truncate the SLUG, never the type prefix (`guard-rail:` / `wall:` / `dead-end:`):
 *  the prefix is the half that says how much authority the fact carries, so a key
 *  clipped down to a bare "guard-r…" would cost the reader the only part that is
 *  legible at a glance. */
function compactFactKey(key: string): string {
  return key.length <= FACT_KEY_CHARS ? key : `${key.slice(0, FACT_KEY_CHARS - 1)}…`;
}

function compactHeadline(summary: string | undefined): string {
  const text = (summary ?? '(no summary)').replace(/\s+/g, ' ').trim();
  return text.length <= 72 ? text : `${text.slice(0, 71)}…`;
}

function renderCheckpointLine(item: OrientationHeldItem): string | null {
  const raw = item.checkpoint?.replace(/\s+/g, ' ').trim();
  if (!raw) return null;
  const excerpt = capPreservingOperativeDetailed(raw, CHECKPOINT_EXCERPT_CHARS, {
    inlineNotice: true,
    more: workItemFetchHint(item.id, item.harness),
    maxChars: 40,
    maxClauses: 1,
  }).text;
  return `- checkpoint ${item.id}: ${excerpt}`;
}

/**
 * A prompt surface that renders orientation state categories.
 *
 * D-015 (plan turn-start-memory-two-class-2026-09-21) ruled that the three
 * briefs must NOT merge their payloads — they answer different questions with
 * different watermark semantics. What they share is the DECLARATION of what
 * each category IS; each surface then SELECTS from that shared declaration at
 * its own budget. Turn-start keeps its cursor/watermark semantics via
 * `watermarkTokens`; leader-brief is read-on-demand and uses none.
 *
 * REGISTERED CONSUMERS TODAY: `turn-start` (every class), `leader-brief`
 * (`neverDropFacts` via P-025's `readLeaderNeverDropFacts`, `announcedGates` via
 * P-027) and `carry-brief` (`neverDropFacts` via P-029's
 * `readCarryNeverDropFacts` in carry-brief.ts). All three sinks are now claimed
 * by at least one entry, so `SINK_COVERAGE` in the class-coverage guard carries
 * a per-class decision for each — there is no longer a `pending` column.
 *
 * The rule that governs adding one has NOT changed: an `applicableSinks` naming
 * a surface which does not consume the registry would be a false declaration,
 * and the whole point of this table is that a category is declared once,
 * truthfully. Declaration and consumption land in the SAME change.
 *
 * ⚠ CONSUMPTION IS NOT ALWAYS A LINE (D-053). Turn-start is a text block and
 * consumes `segments[].render`. The leader brief is a STRUCTURED, field-capped
 * payload and consumes a class through `id` (typed `keyof OrientationState`),
 * emitting its own field — pushing a rendered line into that JSON would be the
 * "second copy of the line" this table exists to prevent. Both are truthful;
 * reading `applicableSinks` as "renders it as a line" would have made the
 * leader-brief and carry-brief sinks permanently unimplementable.
 */
/**
 * A surface that renders orientation classes FROM THIS DECLARATION.
 *
 * `agent-orders` is the HUD conversation popup's Orders rail (P-018). It is
 * named for its data path, not its pixels: the popup is `SessionChatModal`,
 * addressed entirely through the `hudsession` URL param, and its Orders rail
 * reads the `agentOrders.byOwner` sync query → `getAgentOrders`
 * (`adv-agent-orders.ts`). That is the observer's answer to "what was this
 * agent told", and before P-018 it was built by a SECOND builder
 * (`buildCarryBrief`, shaped inline in `getAgentOrders`) that shared no code
 * with the block the agent actually received. Two builders, two answers.
 *
 * Unlike `leader-brief` and `carry-brief` — structured payloads that consume a
 * class through `RegisteredOrientationClass.id` (D-053) — this sink consumes
 * `segments[].render`, the SAME call turn-start makes, and carries the rendered
 * row verbatim. That is deliberate and is what P-018's acceptance test asserts:
 * one fixture must produce the same ROWS on both surfaces, not merely rows
 * derived from the same declaration.
 */
export type OrientationSink = 'turn-start' | 'leader-brief' | 'carry-brief' | 'agent-orders';

/**
 * One ordered emission of a class.
 *
 * ⚠ A CLASS MAY OWN SEVERAL SEGMENTS, AND THAT IS THE WHOLE REASON THIS TYPE
 * EXISTS. `renderOrientationLines` is NOT one block per category: `held`
 * emits at FOUR distinct priorities (stale checkpoints, missing checkpoints,
 * the holding line, checkpoint excerpts) and `loopArmed` at TWO (the not-armed
 * WARNING near the top, the reassuring ARMED line last), interleaved with
 * other categories. A registry keyed one-entry-per-category therefore CANNOT
 * reproduce the emitted order — and it would scramble it SILENTLY, because
 * the class-coverage guard asserts that each class reaches a rendered line, not
 * WHERE it lands. `order` is the thing that keeps the priority rule below
 * intact; it is asserted unique and order-preserving by the registry tests.
 */
export interface OrientationClassSegment<T> {
  /** Ascending emission order. Spaced by 10 so a segment can be inserted between two. */
  readonly order: number;
  /** PURE: the lines this segment contributes; `[]` when it has nothing to say. */
  readonly render: (value: T, state: OrientationState, committed: CursorState | null) => string[];
}

/**
 * P-019: the hard per-class row ceiling, and the verb that recovers what it evicts.
 *
 * WHY A CEILING AT ALL, given the composer already has a character budget: the
 * outer budget in {@link composeOrientationBlock} BREAKS on the first line that
 * does not fit, so a chatty class does not truncate ITSELF — it evicts every
 * class ordered after it. Two classes are genuinely unbounded without this:
 * `obligations` spreads whatever its provider returns (it TRUSTS the reader's
 * `maxEntries`, it does not enforce it), and `announcedGates` emits one warning
 * line per gate with no cap. Either one, given a runaway provider, silently
 * starves `neverDropFacts` — the guard-rail class whose whole contract is that
 * it is never dropped. A per-class ceiling is what makes the emission order in
 * this registry SAFE, which is why P-019 pairs the two.
 *
 * REQUIRED, never optional. An optional ceiling reproduces exactly the defect it
 * exists to prevent: the next class lands unbounded because nobody thought about
 * it, and nothing fails. Required makes that omission a COMPILE error instead
 * (the same rule D-073 ruling 5 applied to `OrientationDeps`).
 *
 * The ceiling counts rows across ALL of a class's segments, because "per class"
 * is the unit P-019 names and the unit a reader experiences — `held` contributes
 * four segments that are one paragraph to the agent reading them.
 */
export interface OrientationRowCeiling {
  /** Max rows this class may contribute, summed over its segments. */
  readonly maxRows: number;
  /**
   * The verb a reader runs to recover rows the ceiling evicted, rendered into
   * the `+N omitted` disclosure. Required even for a class that cannot reach
   * its ceiling today: the disclosure must never be the first place someone
   * discovers that recovery was never worked out.
   */
  readonly recoveryVerb: string;
}

/**
 * The shared, sink-parameterized declaration of ONE orientation state category:
 * its data source (`populate`), its rendering (`segments`), its watermark token
 * and the prompt surfaces it applies to.
 */
export interface OrientationClassEntry<T> {
  /** The `OrientationState` field this class is declared by. Exactly one entry per field. */
  readonly id: keyof OrientationState;
  /**
   * The `CursorState` keys this class contributes to, as produced by
   * {@link fingerprintOrientation}. Empty means DELIBERATELY unwatermarked —
   * see `improvementTriage`, whose token was withdrawn with its line (P-017).
   * Plural because a class can own more than one token (`loopArmed` owns both
   * `loop` and, through its ARMED variant, nothing else — while
   * `loopFireWithheld` owns `loopWithheld`); a singular field would have to
   * lie for at least one entry, and these are pinned against the real
   * fingerprint keys by test.
   */
  readonly watermarkTokens: readonly string[];
  /** The surfaces that render this class FROM THIS DECLARATION. */
  readonly applicableSinks: readonly OrientationSink[];
  /** DATA SOURCE: select this class's slice out of the orientation state. */
  readonly populate: (state: OrientationState) => T;
  /** RENDERING: ordered segments; see {@link OrientationClassSegment}. */
  readonly segments: readonly OrientationClassSegment<T>[];
  /** P-019: the hard row ceiling for this class. REQUIRED — see {@link OrientationRowCeiling}. */
  readonly rowCeiling: OrientationRowCeiling;
  /**
   * Set when the class is declared but deliberately renders NOTHING, carrying
   * the reason. A dropped class is a decision, not a coverage gap.
   */
  readonly unrenderedReason?: string;
}

/** A registry row with its `populate` type erased and bound into its segments. */
export interface RegisteredOrientationClass {
  readonly id: keyof OrientationState;
  readonly watermarkTokens: readonly string[];
  readonly applicableSinks: readonly OrientationSink[];
  /** P-019: see {@link OrientationRowCeiling}. Required, so a new class cannot land unbounded. */
  readonly rowCeiling: OrientationRowCeiling;
  readonly unrenderedReason?: string;
  readonly segments: readonly {
    readonly order: number;
    readonly render: (state: OrientationState, committed: CursorState | null) => string[];
  }[];
}

/**
 * Bind one authored entry into the registry, erasing `T` by composing
 * `populate` into each segment's `render`. Authoring stays fully typed per
 * class; the table itself stays a flat, iterable list.
 */
function orientationClass<T>(entry: OrientationClassEntry<T>): RegisteredOrientationClass {
  return {
    id: entry.id,
    watermarkTokens: entry.watermarkTokens,
    applicableSinks: entry.applicableSinks,
    rowCeiling: entry.rowCeiling,
    ...(entry.unrenderedReason === undefined ? {} : { unrenderedReason: entry.unrenderedReason }),
    segments: entry.segments.map((segment) => ({
      order: segment.order,
      render: (state: OrientationState, committed: CursorState | null) =>
        segment.render(entry.populate(state), state, committed),
    })),
  };
}

const TURN_START: readonly OrientationSink[] = ['turn-start'];

/**
 * P-018: the OBLIGATION + DELTA classes, which the HUD conversation popup's
 * Orders rail renders from this same declaration.
 *
 * ⚠ This is deliberately NOT every turn-start class. The popup is an OBSERVER
 * surface and may legitimately render MORE than the agent was told (liveness,
 * locks, a dossier) — but the question P-018 makes single-answered is narrower:
 * "what standing obligation, and what changed, was this agent told about?" So
 * exactly the classes that answer THAT carry this sink, and an operator-only
 * embellishment stays outside the shared object rather than being smuggled into
 * it. Adding a class here is a decision about what counts as an obligation, not
 * a formatting choice.
 *
 * The membership traces to P-019's eviction order — owner directives > walls >
 * waiting-on > directed messages — plus the obligation agenda itself:
 *   - `ownerDirectives`     → owner directives (verbatim, undischarged)
 *   - `neverDropFacts`      → walls / dead-ends / guard-rails
 *   - `openChecks`          → waiting-on (open external blockers + carried claims)
 *   - `unansweredDirected`  → directed messages awaiting this agent's answer
 *   - `obligations`         → the bounded obligation agenda (`AgentObligationBrief`)
 */
const TURN_START_AND_AGENT_ORDERS: readonly OrientationSink[] = ['turn-start', 'agent-orders'];

/**
 * P-025: classes the LEADER BRIEF also renders from this declaration.
 *
 * ⚠ The leader brief is a STRUCTURED, field-capped payload, not a text block, so
 * it consumes a class through `RegisteredOrientationClass.id` (typed
 * `keyof OrientationState`) rather than through `segments[].render` — pushing a
 * rendered line into that JSON would be the "second copy of the line" this
 * registry exists to prevent. Plan decision D-053 rules that both are truthful
 * consumption of the shared declaration; `applicableSinks` means "renders this
 * class FROM THIS DECLARATION", not "renders it as a line".
 *
 * Consumer: `readLeaderNeverDropFacts` in `agent-tools/fleet/leader-brief.ts`,
 * which reads this very table for applicability — so withdrawing a sink here
 * turns the field off with no second edit.
 */
const TURN_START_AND_LEADER_BRIEF: readonly OrientationSink[] = ['turn-start', 'leader-brief'];

/**
 * P-029: classes the CARRY DOCUMENT also renders from this declaration —
 * currently `neverDropFacts` alone.
 *
 * A separate const rather than widening {@link TURN_START_AND_LEADER_BRIEF},
 * because that one is shared with `announcedGates`: extending it in place would
 * silently hand the carry document a class P-029 never decided on, and the
 * whole point of this table is that each cell is a decision. Adding a second
 * class to this sink should be its own edit with its own recorded reason.
 *
 * Consumer: `readCarryNeverDropFacts` in `carry-brief.ts`, which reads this very
 * table for applicability — so withdrawing the sink here turns the section off
 * with no second edit there. Like the leader brief (D-053) the carry document is
 * a STRUCTURED payload rendered by its own renderer, so it consumes the class
 * through `RegisteredOrientationClass.id` rather than `segments[].render`.
 *
 * ⚠ WHY THIS SINK NEEDS THE CLASS AT ALL, given it already carries `facts`: the
 * carry document's general fact fold is OWNER-SCOPED ONLY, while this class is
 * folded at WORKSPACE + owner. A fleet-wide guard rail is asserted at workspace
 * scope in practice, so it reached turn-start and the leader brief and never the
 * carry document — whose reader is the COLDEST in the system and rebuilds from
 * the document alone. The gap was the missing SELECTOR, not the projection,
 * which is why "carry-brief already carries facts" reads like coverage and is not.
 */
const TURN_START_LEADER_BRIEF_AND_CARRY: readonly OrientationSink[] = [
  'turn-start',
  'leader-brief',
  'carry-brief',
];

/**
 * P-018: `neverDropFacts` on every sink above PLUS the HUD Orders rail.
 *
 * A separate const rather than pushing `'agent-orders'` into
 * {@link TURN_START_LEADER_BRIEF_AND_CARRY}, for the reason that const itself
 * gives: each cell of this table is a decision, and widening a shared const in
 * place hands the sink to whichever other classes happen to reference it. Here
 * that is not hypothetical — walls are the class the observer most needs
 * (P-019 ranks them second only to owner directives), and the leader brief and
 * carry document have their own, different reasons for carrying them.
 */
const TURN_START_LEADER_BRIEF_CARRY_AND_AGENT_ORDERS: readonly OrientationSink[] = [
  'turn-start',
  'leader-brief',
  'carry-brief',
  'agent-orders',
];

/**
 * The ownerDirectives class's lines, split by whose they are.
 *
 * D-027 (goal-brief-to-claimed-plan-work-2026-09-23): the composer BREAKS on the
 * first row that does not fit, so rendering other sessions' FYI groups at order 20
 * spent the whole budget before a session's OWN work. Measured on a goal holder:
 * three peer groups (~850 chars) filled the block and its plan-placement obligation
 * (order 120) never rendered. Own directives keep order 20; peer groups render at
 * order 185, after your own work classes, and stay recoverable via orders:list.
 */
function renderOwnerDirectiveLines(directives: OrientationOwnerDirective[]): { own: string[]; peers: string[] } {
  if (directives.length === 0) return { own: [], peers: [] };
  // A directive already settled by disposition renders in NO imperative
  // bucket (P-006 / D-007). Dropping it here rather than at the reader is
  // deliberate: the reader's job is to report the row, this class's job is
  // to decide whether it is still ASKING for something.
  const live = directives.filter((d) => !d.status || directiveNeedsAction(d.status));
  if (live.length === 0) return { own: [], peers: [] };
  // Your own directives first: they are the only ones that carry an obligation.
  const ordered = [
    ...live.filter((d) => d.addressedToMe === true),
    ...live.filter((d) => d.addressedToMe !== true),
  ];
  const own: string[] = [];
  const peers: string[] = [];
  // directive-ownership-clarity-2026-09-23 P-003 / D-001: another session's
  // directives render as ONE line per addressee — that agent, its state and
  // current work, then its directives — so where a directive appears says
  // whose it is. The flat list (a one-word YOURS/team label per row) is what
  // an agent misread on 2026-09-23. Groups collect here and flush after the
  // loop; the 5-directive cap is unchanged, and a group is never more lines.
  const groups = new Map<string, { head: OrientationOwnerDirective; parts: string[]; routes: number[]; related: boolean }>();
  for (const directive of ordered.slice(0, 5)) {
    // DEFENSIVE, and load-bearing rather than belt-and-braces: this render
    // runs on the turn-start hot path inside projectOrientationRows, which
    // has NO per-segment error isolation — `for (const text of render(...))`
    // propagates, so ONE throw here blanks the ENTIRE orientation banner
    // (every class, every row) for that agent, on every turn. The blast
    // radius of a malformed row is the whole block, not one line.
    //
    // A row with a missing/NULL recordedBy is REACHABLE, not hypothetical:
    // WI-10002437 measured 41 damaged directive rows, and this very failure
    // is how it surfaced — a coverage fixture written before P-007 added the
    // required fields left recordedBy absent, and `.length` threw. So each
    // field read here degrades to a labelled value instead of throwing.
    const rawText = typeof directive.verbatimText === 'string' ? directive.verbatimText : '';
    // D-004: full verbatim under the cap, the labelled agent summary over it,
    // never a cut fragment of the owner's words.
    const shown = rawText.trim()
      ? directiveDisplayText({
          id: directive.id,
          verbatimText: rawText,
          summaryText: directive.summaryText ?? null,
          summaryBy: directive.summaryBy ?? null,
        })
      : '(no text recorded)';
    // `unknown` is deliberately NOT a session id: it can never equal an
    // ownerId, so an unattributable row can only ever render as NOT-mine.
    const recordedBy =
      typeof directive.recordedBy === 'string' && directive.recordedBy.length > 0
        ? directive.recordedBy
        : null;
    const by = recordedBy === null ? 'unknown' : shortOwner(recordedBy);
    // NOTE: a segment `render` receives only (state, committed) — no ownerId
    // — so addressing is resolved in the READER, which does have it, and
    // arrives here as a decided boolean. Undecided (`undefined`) must fall to
    // the NOT-mine branch: the expensive error is claiming a foreign
    // directive, never being over-cautious about your own.
    const mine = directive.addressedToMe === true;
    const claimedBy = directive.status?.kind === 'claimed' ? directive.status.claimedBy : undefined;
    // `capturedByHook: false` means an AGENT asserted this, not the owner.
    // Labelled, never silently promoted to owner speech.
    const origin = directive.capturedByHook ? '' : ' [owner-candidate]';
    // D-004(1): the same pasted text is open for other sessions too — say so,
    // so the reader closes THIS id and never the look-alikes.
    const sentTo = alsoSentToNote(directive.alsoSentTo);

    if (mine) {
      // OBLIGATION framing — only ever for the session the owner addressed
      // (R-3). An over-cap directive without a summary asks for one: the
      // summary is what every OTHER agent will see (D-004).
      const summaryAsk =
        rawText.trim() && directiveNeedsSummary({ verbatimText: rawText }) && !directive.summaryText
          ? ` It is long: write what other agents will see first — orders:summarize { id: ${directive.id}, summary }.`
          : '';
      own.push(
        `- 📌 YOURS · owner directive #${directive.id}${origin}: ${shown}${sentTo} — carry out, then orders:disposition { id: ${directive.id}, status, note }.${summaryAsk}`,
      );
      continue;
    }
    // AWARENESS framing for every other session's directive (D-003): the
    // owner wants the whole team to know what everyone is working on, but
    // a line here is never an obligation — acting on another session's
    // directive without taking it is how rows got destroyed
    // (WI-10002426 / WI-10002437).
    const group = groups.get(by) ?? { head: directive, parts: [], routes: [], related: false };
    group.related ||= directive.relatedToMe === true;
    // A directive a peer already holds carries no route at all: offering
    // work_items:create there is how in-flight work gets duplicated.
    if (claimedBy) {
      group.parts.push(
        'owner directive #' +
          directive.id +
          origin +
          ' (claimed by ' +
          shortOwner(claimedBy) +
          ' — awareness only, already taken; do not act on or resolve it.): ' +
          shown +
          sentTo,
      );
    } else {
      group.parts.push('owner directive #' + directive.id + origin + ': ' + shown + sentTo);
      group.routes.push(directive.id);
    }
    groups.set(by, group);
  }
  // Related-to-your-work groups first; otherwise first-appearance order.
  const orderedGroups = [...groups.entries()].sort(([, a], [, b]) => Number(b.related) - Number(a.related));
  for (const [by, group] of orderedGroups) {
    const state = typeof group.head.addresseeState === 'string' && group.head.addresseeState ? group.head.addresseeState : null;
    const rawIntent = typeof group.head.addresseeIntent === 'string' ? group.head.addresseeIntent.trim() : '';
    const intent = rawIntent.length > 80 ? `${rawIntent.slice(0, 80)}…` : rawIntent;
    const context = [state, intent ? `working on: ${intent}` : null].filter(Boolean).join('; ');
    const related = group.related ? ' [related to your work]' : '';
    const route =
      group.routes.length === 0
        ? ''
        : ` — NOT yours to resolve; take one only via work_items:create { directiveRef: ${group.routes.length === 1 ? group.routes[0] : `<${group.routes.join('|')}>`} }.`;
    peers.push(
      '- 👥 ' +
        by +
        (context ? ' (' + context + ')' : '') +
        related +
        ' — THEIR open owner directives addressed to ' +
        by +
        ': ' +
        group.parts.join(' · ') +
        route,
    );
  }
  if (ordered.length > 5) peers.push(`- 📌 +${ordered.length - 5} more open owner directives — orders:list { open: true }.`);
  return { own, peers };
}

/**
 * THE SHARED CLASS REGISTRY (P-023; mechanism per D-015).
 *
 * Every orientation state category is declared here exactly once, and every
 * applicable surface renders it from this declaration. Adding a category to a
 * surface is a change to `applicableSinks`, not a second copy of the line.
 *
 * The `order` values encode the playbook's own priority rule, highest-priority
 * first so budget truncation drops the least important thing rather than an
 * arbitrary tail: a directed message awaiting your answer outranks your own
 * work, so it leads; the no-wake-source warning is next because an agent that
 * cannot be re-woken silently halts, which is the most expensive failure on
 * this list.
 */
export const ORIENTATION_CLASS_REGISTRY: readonly RegisteredOrientationClass[] = [
  orientationClass<OrientationToolSurface | null>({
    id: 'toolSurface',
    rowCeiling: { maxRows: 1, recoveryVerb: 'agent_tools:list' },
    watermarkTokens: ['toolSurface'],
    applicableSinks: TURN_START,
    populate: (state) => state.toolSurface,
    segments: [
      {
        // FIRST, above even the directed-message line. An agent whose tool surface is
        // empty cannot act on ANY line below this one — it cannot claim, checkpoint, or
        // even answer the directed message that otherwise leads. Deliberately terse: the
        // composer BREAKS on the first line that does not fit, so length spent here is
        // taken from every line after it.
        order: 10,
        render: (toolSurface) =>
          toolSurface
            ? [
                `- 🚨 MCP TOOLS NOT REGISTERED — 0 tool calls in ${toolSurface.windowMinutes}m vs ` +
                  `${toolSurface.hookCalls} harness beats OK. Tool list loaded EMPTY; it cannot ` +
                  `self-heal. RESTART THE SESSION (EI-21308269358666878).`,
              ]
            : [],
      },
    ],
  }),

  orientationClass<OrientationOwnerDirective[]>({
    id: 'ownerDirectives',
    // Up to 5 directives + the class's own "+N more" line. Every session's open
    // directives are visible to every agent (D-003 of
    // owner-directive-delivery-redesign-2026-09-22) — naturally capped by the
    // speed of one human typing — and the epoch-keyed cursor delivers each set
    // once per context rather than every turn.
    rowCeiling: { maxRows: 6, recoveryVerb: 'orders:list { open: true }' },
    watermarkTokens: ['ownerDirectives'],
    applicableSinks: TURN_START_AND_AGENT_ORDERS,
    populate: (state) => state.ownerDirectives ?? [],
    segments: [
      {
        order: 20,
        render: (directives) => renderOwnerDirectiveLines(directives).own,
      },
      {
        // D-027: other sessions' directives are awareness, not your work — they
        // follow every class that is (see renderOwnerDirectiveLines).
        order: 185,
        render: (directives) => renderOwnerDirectiveLines(directives).peers,
      },
    ],
  }),

  orientationClass<CarryBlindWindow | null>({
    id: 'carryBlindWindow',
    rowCeiling: { maxRows: 1, recoveryVerb: "sessions:search { session:'self' }" },
    watermarkTokens: ['carryBlind'],
    applicableSinks: TURN_START,
    populate: (state) => state.carryBlindWindow,
    segments: [
      {
        // Second, and above the directed-message line for one reason: it is the only
        // line here that DECAYS. Every other line describes state the agent can re-read
        // at any point in the session; this one describes turns that exist solely in a
        // dead predecessor's transcript, and an owner-salient deliverable stranded there
        // (EI-21442716425230784: an OAuth consent URL the owner was told to act on) is
        // discovered late or never. It renders once per respawn, so the cost is bounded.
        order: 30,
        render: (carryBlindWindow) => (carryBlindWindow ? [renderCarryBlindWindowLine(carryBlindWindow)] : []),
      },
    ],
  }),

  orientationClass<OrientationOpenCheck[] | undefined>({
    id: 'openChecks',
    // 2 claim/blocker rows + the class's own "+N more" line.
    rowCeiling: { maxRows: 3, recoveryVerb: 'loop:status / work_items:get' },
    watermarkTokens: ['openChecks'],
    applicableSinks: TURN_START_AND_AGENT_ORDERS,
    populate: (state) => state.openChecks,
    segments: [
      {
        // Directly after `carryBlindWindow` (30) and ahead of the post-claim update
        // lines, because it shares that class's decay property and worsens it. A
        // blind-window line describes turns the agent cannot read; THIS describes
        // conclusions it CAN read and will act on while they are wrong. The damage
        // from an inherited false claim lands on the agent's first action of the
        // turn, which is upstream of everything the lines below prompt it to do.
        order: 35,
        render: (openChecks) => {
          if (!openChecks || openChecks.length === 0) return [];
          // CONTESTED first (disproof already attached), then the remaining
          // unverified claims, then blockers — worst-first, so budget truncation
          // drops the least actionable tail rather than an arbitrary one.
          const rank = (row: OrientationOpenCheck): number =>
            row.contested ? 0 : row.kind === 'check' ? 1 : 2;
          const ordered = openChecks.slice().sort((a, b) => rank(a) - rank(b));
          const lines: string[] = [];
          for (const row of ordered.slice(0, 2)) {
            const claim = row.claim.replace(/\s+/g, ' ').trim();
            const excerpt = claim.length > 90 ? `${claim.slice(0, 89)}…` : claim;
            // The probe is the POINT of the row — an unprobed claim is reported as
            // unfalsifiable rather than silently rendered as if a probe existed.
            const probe = row.recheck?.replace(/\s+/g, ' ').trim();
            const settle = probe
              ? `run recheck: ${probe.length > 90 ? `${probe.slice(0, 89)}…` : probe}`
              : row.kind === 'blocker'
                ? 'no next verb recorded — re-read the blocker before waiting on it'
                : 'NO PROBE STORED — treat as [inferred]; do not rely on it';
            const badge = row.contested ? '⚠ CONTESTED' : row.kind === 'blocker' ? 'open blocker' : '? UNVERIFIED';
            lines.push(`- 🔎 ${badge} ${JSON.stringify(excerpt)} — ${settle} [${row.pointer}]`);
          }
          if (ordered.length > 2) {
            const rest = ordered.length - 2;
            lines.push(
              `- 🔎 +${rest} more unverified claim(s)/open blocker(s) — loop:status / work_items:get carry the rows.`,
            );
          }
          return lines;
        },
      },
    ],
  }),

  orientationClass<OrientationHistoryUpdate[] | undefined>({
    id: 'historyUpdates',
    rowCeiling: { maxRows: 2, recoveryVerb: 'work_items:get' },
    watermarkTokens: ['historyUpdates'],
    applicableSinks: TURN_START,
    populate: (state) => state.historyUpdates,
    segments: [
      {
        order: 40,
        render: (updates) => {
          if (!updates || updates.length === 0) return [];
          const shown = updates.slice(0, 2);
          const total = updates.reduce((sum, update) => sum + update.count, 0);
          const refs = shown.map((update) => workItemFetchHint(update.workItemId, update.harness)).join('; ');
          return [`- ⚠ ${total} post-claim history update(s) on held work — read current context: ${refs}`];
        },
      },
    ],
  }),

  orientationClass<OrientationEffortUpdate[] | undefined>({
    id: 'effortUpdates',
    rowCeiling: { maxRows: 1, recoveryVerb: 'plans:get' },
    watermarkTokens: ['effortUpdates'],
    applicableSinks: TURN_START,
    populate: (state) => state.effortUpdates,
    segments: [
      {
        order: 50,
        render: (updates) => {
          if (!updates || updates.length === 0) return [];
          const total = updates.reduce((sum, update) => sum + update.count, 0);
          const refs = updates.slice(0, 3).map((update) => `${update.level}:${update.ref}`).join(', ');
          return [`- ⚠ ${total} post-claim plan/goal revision(s) (${refs}) — re-read the current plan/goal context.`];
        },
      },
    ],
  }),

  orientationClass<number>({
    id: 'unansweredDirected',
    rowCeiling: { maxRows: 1, recoveryVerb: 'coord:inbox { unanswered: true }' },
    watermarkTokens: ['unanswered'],
    applicableSinks: TURN_START_AND_AGENT_ORDERS,
    populate: (state) => state.unansweredDirected,
    segments: [
      {
        order: 60,
        render: (unansweredDirected) =>
          unansweredDirected > 0
            ? [`- ⚠ ${unansweredDirected} directed msg(s) awaiting YOUR reply — answer first.`]
            : [],
      },
    ],
  }),

  orientationClass<number>({
    id: 'unansweredStale',
    rowCeiling: { maxRows: 1, recoveryVerb: 'coord:inbox { unanswered: true }' },
    watermarkTokens: ['unansweredStale'],
    applicableSinks: TURN_START,
    populate: (state) => state.unansweredStale,
    segments: [
      {
        // EI-20085805220385722: reported, but deliberately NOT as "answer first" —
        // the sender is gone, so nobody is blocked and answering costs a turn nobody
        // reads. Shown so the obligation is visible rather than silently vanished.
        order: 70,
        render: (unansweredStale) =>
          unansweredStale > 0
            ? [`- ${unansweredStale} more from ENDED senders — no one is waiting; close them out, don't prioritise.`]
            : [],
      },
    ],
  }),

  orientationClass<OrientationOpenAsk | null>({
    id: 'openAsks',
    rowCeiling: { maxRows: 1, recoveryVerb: 'coord:inbox' },
    watermarkTokens: ['openAsks'],
    applicableSinks: TURN_START,
    populate: (state) => state.openAsks,
    segments: [
      {
        // The reciprocal counter (WI-2142142): asks THIS agent made that a peer has
        // not yet answered. Lower priority than the line above (an ask you are
        // owed never outranks an ask you owe), so it renders second.
        order: 80,
        render: (openAsks) => {
          if (!openAsks) return [];
          const { count, oldestAgeMs, oldestTo } = openAsks;
          return [`- ${count} open ask(s) sent, oldest ${compactAgeHours(oldestAgeMs)} — awaiting ${compactActor(oldestTo)}.`];
        },
      },
    ],
  }),

  orientationClass<{ authorityVerdict: OrientationAuthorityVerdict | null }>({
    id: 'authorityVerdict',
    rowCeiling: { maxRows: 1, recoveryVerb: 'mode:get' },
    watermarkTokens: ['authority'],
    applicableSinks: TURN_START,
    populate: (state) => ({ authorityVerdict: state.authorityVerdict }),
    segments: [
      {
        // Just ABOVE the mode attribution line. The verdict is what the agent
        // may DO; the mode row below is WHY. A reader who sees only the first
        // line of a budget-clipped block should get the mandate, not its cause.
        order: 84,
        render: ({ authorityVerdict }, _state, committed) => renderAuthorityVerdictLine(authorityVerdict, committed),
      },
    ],
  }),

  orientationClass<{ planDecisions: OrientationPlanDecisions | undefined }>({
    id: 'planDecisions',
    // PLAN_DECISION_DISPLAY_CAP decision rows + the `+N more` line + the two
    // incompleteness disclosures, which render only alongside a non-empty list.
    rowCeiling: { maxRows: PLAN_DECISION_DISPLAY_CAP + 3, recoveryVerb: "plans:get { slug, heading:'Decisions' }" },
    watermarkTokens: ['planDecisions'],
    applicableSinks: TURN_START,
    populate: (state) => ({ planDecisions: state.planDecisions }),
    segments: [
      {
        // Just BELOW the authority/mode rows and ABOVE the held-item rows: a
        // governing ruling constrains HOW the held work may be done, so it has
        // to be read before the list of that work, but after the mandate that
        // frames both.
        //
        // 95, NOT 90 (WI-10002446). This segment shipped at 90 — an order
        // `loopArmed` already held. A duplicated `order` leaves the emitted
        // sequence non-deterministic BETWEEN ENGINES, which is the precise
        // failure the registry's unique-order guard exists to prevent, so the
        // collision was a live instability rather than a cosmetic tie. 95
        // satisfies the stated intent above unchanged (below modes:85 and
        // loopArmed:90, above held:100) while leaving loopArmed's long-pinned
        // slot alone — the fix is one number, not a re-homing of a segment
        // another lane placed deliberately.
        order: 95,
        render: ({ planDecisions }, _state, committed) => renderPlanDecisionLines(planDecisions, committed),
      },
    ],
  }),

  orientationClass<{ lockTransitions: OrientationLockTransitions | undefined }>({
    id: 'lockTransitions',
    // LOCK_TRANSITION_DISPLAY_CAP transition rows + the `+N more` pointer. No
    // disclosure rows to budget for: an unreadable observation renders NOTHING
    // here (see renderLockTransitionLines), so unlike `planDecisions` there is
    // no partial-read line that can appear alongside the list.
    rowCeiling: { maxRows: LOCK_TRANSITION_DISPLAY_CAP + 1, recoveryVerb: 'locks:queue { paths }' },
    watermarkTokens: ['locks'],
    applicableSinks: TURN_START,
    populate: (state) => ({ lockTransitions: state.lockTransitions }),
    segments: [
      {
        // 97: below the governing ruling (planDecisions:95) and above the
        // held-item rows (100). A lock transition is a fact about whether the
        // agent can ACT on the work listed below it — a grant unblocks one of
        // those rows, a block stops one — so it belongs with that work, not
        // with the mandate that frames it.
        //
        // 96 and 98 are equally free; 97 leaves a slot on either side for a
        // future neighbour without re-homing anyone. Orders are unique-guarded
        // (WI-10002446): a duplicate leaves the emitted sequence
        // non-deterministic between engines.
        order: 97,
        render: ({ lockTransitions }, _state, committed) => renderLockTransitionLines(lockTransitions, committed),
      },
    ],
  }),

  orientationClass<{ coupledPeers: OrientationCoupledPeer[] | null }>({
    id: 'coupledPeers',
    // COUPLED_PEER_DISPLAY_CAP rows + the `+N more` pointer. No disclosure row
    // to budget for: an unreadable read renders NOTHING here (see
    // renderCoupledPeerIntentLines), so unlike `planDecisions` there is no
    // partial-read line that can appear alongside the list.
    rowCeiling: { maxRows: COUPLED_PEER_DISPLAY_CAP + 1, recoveryVerb: 'coord:presence' },
    watermarkTokens: ['coupledPeers'],
    applicableSinks: TURN_START,
    populate: (state) => ({ coupledPeers: state.coupledPeers }),
    segments: [
      {
        // 98: directly below the lock transition (97) and above the held-item
        // rows (100). A peer changing intent is context for the work listed
        // below it — it can mean a peer just took, or just left, something
        // adjacent to your lane — so it belongs with that work.
        //
        // 85/90/95/97/100 are taken; 98 is free and leaves 99 open for a future
        // neighbour. Orders are unique-guarded (WI-10002446): a duplicate makes
        // the emitted sequence non-deterministic between engines.
        order: 98,
        render: ({ coupledPeers }, _state, committed) => renderCoupledPeerIntentLines(coupledPeers, committed),
      },
    ],
  }),

  orientationClass<{ modes: OrientationModeState[] | null }>({
    id: 'modes',
    rowCeiling: { maxRows: 1, recoveryVerb: 'mode:get' },
    watermarkTokens: ['modes'],
    applicableSinks: TURN_START,
    populate: (state) => ({ modes: state.modes }),
    segments: [
      {
        // Just ABOVE the loop warning: posture is the frame the reader needs
        // before the lines that depend on it, and a transition is rare enough
        // to earn a high slot on the turns it does appear.
        order: 85,
        render: ({ modes }, _state, committed) => renderModeTransitionLines(modes, committed),
      },
    ],
  }),

  orientationClass<{ armed: boolean; withheld: boolean }>({
    id: 'loopArmed',
    // two segments (armed line + the wake-source warning).
    rowCeiling: { maxRows: 2, recoveryVerb: 'loop:status' },
    watermarkTokens: ['loop'],
    applicableSinks: TURN_START,
    populate: (state) => ({ armed: state.loopArmed, withheld: state.loopFireWithheld }),
    segments: [
      {
        // A missing wake source can strand every line below it, so the WARNING is
        // high-priority. The reassuring ARMED line is cheap context and goes last.
        order: 90,
        render: ({ armed }) =>
          armed ? [] : ['- ⚠ engine loop: not armed — loop:arm open-ended work or you halt silently after this turn.'],
      },
      {
        order: 190,
        render: ({ armed, withheld }) =>
          armed
            ? [
                withheld
                  ? '- engine loop: ARMED — fire pending, withheld for interactive turn.'
                  : '- engine loop: ARMED (a wake source exists).',
              ]
            : [],
      },
    ],
  }),

  orientationClass<OrientationHeldItem[]>({
    id: 'held',
    // four segments: stale/missing/held/checkpoint.
    rowCeiling: { maxRows: 4, recoveryVerb: 'work_items:get' },
    watermarkTokens: ['held'],
    applicableSinks: TURN_START,
    populate: (state) => state.held,
    segments: [
      {
        order: 100,
        render: (held) => {
          const stale = held.filter((h) => Boolean(h.checkpoint?.trim()) && h.checkpointStale).map((h) => h.id);
          return stale.length > 0
            ? [`- ⚠ stale checkpoint: ${compactIds(stale, HELD_DISPLAY_CAP)} — verify current files/state before trusting it.`]
            : [];
        },
      },
      {
        order: 110,
        render: (held) => {
          const missing = held.filter((h) => !h.checkpoint?.trim()).map((h) => h.id);
          return missing.length > 0
            ? [`- ⚠ no checkpoint: ${compactIds(missing, HELD_DISPLAY_CAP)} — read work_items:get before acting.`]
            : [];
        },
      },
      {
        order: 150,
        render: (held, state) => {
          if (state.heldReadFailed) return ['- ⚠ held work-items: unavailable — check work_items:get before editing.'];
          if (held.length === 0) return ['- holding: nothing — claim before your first edit.'];
          const shown = held.slice(0, HELD_DISPLAY_CAP);
          const rest = held.length - shown.length;
          const line = shown.map((h) => (h.status ? `${h.id} (${h.status})` : h.id)).join(', ');
          return [`- holding: ${line}${rest > 0 ? ` +${rest} more` : ''}`];
        },
      },
      {
        order: 170,
        render: (held) =>
          held
            .slice(0, CHECKPOINT_DISPLAY_CAP)
            .map((item) => renderCheckpointLine(item))
            .filter((line): line is string => line !== null),
      },
    ],
  }),

  orientationClass<AgentObligationBrief | null | undefined>({
    id: 'obligations',
    // detailRef line + the provider's projected actions. The reader's own
    // maxEntries is 3, but it is the PROVIDER's number and this class only
    // spreads whatever it returns - this ceiling is what actually enforces it.
    rowCeiling: { maxRows: 4, recoveryVerb: 'orders:list { open: true }' },
    watermarkTokens: ['obligations'],
    applicableSinks: TURN_START_AND_AGENT_ORDERS,
    populate: (state) => state.obligations,
    segments: [
      {
        // ABOVE the "what to work on" lines (frontier / triage) on purpose. These say
        // "not that way", and a do-not-repeat is worth almost nothing once the agent
        // has already picked an approach — which is exactly what the lines below help
        // it do. Deliberately short: the composer BREAKS on the first line that does
        // not fit, so length spent here is taken from every line after it.
        order: 120,
        render: (obligations) => {
          if (!obligations) return [];
          const lines: string[] = [];
          const projectedLines = obligations.projection.text.split('\n').filter(Boolean);
          const omitted = obligations.projection.receipt.entriesOmitted;
          if (omitted > 0) {
            lines.push(`- obligations: +${omitted} omitted — ${obligations.detailRef}`);
          } else if (projectedLines.length > 0) {
            // An inner-complete projection can still lose its action at the outer
            // budget. Keep recovery ahead of that action without claiming an omission
            // that the final composer has not yet measured.
            lines.push(`- obligations: ${obligations.detailRef}`);
          }
          lines.push(...projectedLines);
          return lines;
        },
      },
    ],
  }),

  orientationClass<string[]>({
    id: 'neverDropFacts',
    rowCeiling: { maxRows: 1, recoveryVerb: 'facts:list' },
    watermarkTokens: ['facts'],
    // P-025: also declared for the leader-brief sink, which genuinely selects it
    // (see TURN_START_AND_LEADER_BRIEF above). A fleet leader has the widest
    // blast radius on the pot and previously received NO wall / dead-end /
    // guard-rail facts at all — the "antidote absent where the poison is
    // strongest" failure EI-18725816532600240 established for cold wakes.
    //
    // P-029: and ALSO for the carry document, which is that same failure one
    // sink further out — its reader is the coldest of the three (it rebuilds
    // from the document alone) and its own fact fold is owner-scoped, so
    // workspace-scoped rails never reached it. See
    // TURN_START_LEADER_BRIEF_AND_CARRY above; consumer is
    // `readCarryNeverDropFacts` in carry-brief.ts.
    applicableSinks: TURN_START_LEADER_BRIEF_CARRY_AND_AGENT_ORDERS,
    populate: (state) => state.neverDropFacts,
    segments: [
      {
        // A never-drop fact still precedes plan/frontier/work lines, but a current
        // obligation recovery route must fit first: if the outer budget drops the
        // obligation action, this exact reader is the only truthful way to recover it.
        order: 130,
        render: (neverDropFacts) =>
          neverDropFacts.length > 0
            ? [`- 🛡️ never-drop facts: ${compactIds(neverDropFacts.map(compactFactKey), FACT_DISPLAY_CAP)} — facts:list before you plan.`]
            : [],
      },
    ],
  }),

  orientationClass<OrientationExecutableFrontier | null>({
    id: 'executableFrontier',
    rowCeiling: { maxRows: 1, recoveryVerb: 'plans:items { actionable: true }' },
    watermarkTokens: ['frontier'],
    applicableSinks: TURN_START,
    populate: (state) => state.executableFrontier,
    segments: [
      {
        order: 140,
        render: (executableFrontier, _state, committed) => {
          const frontierLine = renderExecutableFrontierLine(executableFrontier, committed);
          return frontierLine ? [frontierLine] : [];
        },
      },
    ],
  }),

  orientationClass<OrientationAnnouncedGate[]>({
    id: 'announcedGates',
    // one line per gate WARNING (uncapped in the renderer) + the gate list.
    rowCeiling: { maxRows: 3, recoveryVerb: 'events:catalog' },
    watermarkTokens: ['gates'],
    // P-027: the leader brief ALREADY rendered announced gates, but from an
    // undeclared read — so this table under-reported which surfaces carry the
    // class, which is exactly what P-024's (class x sink) matrix flagged.
    // Declaring it here makes `readLeaderAnnouncedGates` consume the
    // declaration (D-053: a structured sink consumes by `id`, not by
    // `segments[].render`), so withdrawing the sink is a ONE-LINE change here
    // and turns the leader field off with no second edit.
    applicableSinks: TURN_START_AND_LEADER_BRIEF,
    populate: (state) => state.announcedGates,
    segments: [
      {
        order: 160,
        render: (announcedGates) => {
          if (announcedGates.length === 0) return [];
          const lines: string[] = [];
          for (const warning of announcedGates.map((gate) => gate.warning).filter(Boolean)) {
            lines.push(`- ⚠ ${compactHeadline(warning)}`);
          }
          lines.push(
            `- announced gates: ${compactIds(
              announcedGates.map((gate) => gate.event),
              GATE_DISPLAY_CAP,
            )}${announcedGates.length > GATE_DISPLAY_CAP ? ' — events:catalog for all' : ''}`,
          );
          return lines;
        },
      },
    ],
  }),

  orientationClass<OrientationInboxEntry[]>({
    id: 'inboxRecent',
    rowCeiling: { maxRows: 1, recoveryVerb: 'coord:inbox' },
    watermarkTokens: ['inbox'],
    applicableSinks: TURN_START,
    populate: (state) => state.inboxRecent,
    segments: [
      {
        order: 180,
        render: (inboxRecent) =>
          inboxRecent
            .slice(0, INBOX_DISPLAY_CAP)
            .map((entry) => `- inbox ${compactActor(entry.from)}: ${compactHeadline(entry.summary)}`),
      },
    ],
  }),

  orientationClass<boolean>({
    id: 'loopFireWithheld',
    rowCeiling: { maxRows: 1, recoveryVerb: 'loop:status' },
    watermarkTokens: ['loopWithheld'],
    applicableSinks: TURN_START,
    populate: (state) => state.loopFireWithheld,
    segments: [],
    unrenderedReason:
      'Rendered as a VARIANT of the loopArmed ARMED line (order 190), not as a line of its own — see the loopArmed entry. ' +
      'It keeps its OWN watermark token (`loopWithheld`) because the variant it selects is a visible change the reader must be re-shown.',
  }),

  orientationClass<OrientationImprovementTriage | null>({
    id: 'improvementTriage',
    // P-017 withdrew the line; the class renders nothing by decision.
    rowCeiling: { maxRows: 0, recoveryVerb: 'improvements:capture' },
    watermarkTokens: [],
    applicableSinks: TURN_START,
    populate: (state) => state.improvementTriage,
    segments: [],
    unrenderedReason:
      'DELIBERATELY NOT RENDERED (plan turn-start-memory-two-class-2026-09-21, P-017; rationale in D-003). It rendered on every ' +
      'turn and produced zero observed action — the canonical signal-decay case: a row that is always present teaches the reader ' +
      'to skip the whole block. The provider and `OrientationState.improvementTriage` REMAIN so the full coord:orient payload ' +
      'keeps serving it on demand; only the unconditional per-turn line is withdrawn. Its watermark token was withdrawn WITH the ' +
      'line: a component for an unrendered class would re-mark the block as changed for a signal the reader can no longer see. ' +
      'The class-coverage guard records this as an entry in DELIBERATELY_UNRENDERED, because a dropped class is a decision, not ' +
      'a coverage gap.',
  }),
];

/**
 * PURE: the segments an individual surface renders, in emission order.
 *
 * This is the SELECT half of the mechanism — each brief calls it with its own
 * sink and spends its own budget on the result.
 */
export function selectOrientationSegments(
  sink: OrientationSink,
  registry: readonly RegisteredOrientationClass[] = ORIENTATION_CLASS_REGISTRY,
): readonly { readonly order: number; readonly render: (state: OrientationState, committed: CursorState | null) => string[] }[] {
  return registry
    .filter((entry) => entry.applicableSinks.includes(sink))
    .flatMap((entry) => entry.segments)
    .slice()
    .sort((a, b) => a.order - b.order);
}

/**
 * PURE: render the block, highest-priority line first so budget truncation drops
 * the least important thing rather than an arbitrary tail.
 *
 * The ORDER encodes the playbook's own priority rule: a directed message awaiting
 * your answer outranks your own work, so it leads. The no-wake-source warning is
 * next because an agent that cannot be re-woken silently halts, which is the most
 * expensive failure on this list. That order now lives in the `order` field of
 * {@link ORIENTATION_CLASS_REGISTRY}, which is where it is asserted.
 */
export function renderOrientationLines(state: OrientationState, committed: CursorState | null = null): string[] {
  return projectOrientationRows(state, 'turn-start', committed).map((row) => row.text);
}

/**
 * ONE rendered obligation/delta row, carrying the class that produced it.
 *
 * `text` is the line VERBATIM — the exact string turn-start emits, not a
 * re-spelling for the screen. That identity is the point of P-018: an observer
 * reading the HUD Orders rail is reading what the agent was told, character for
 * character, so a report of "the popup says X but the agent saw Y" cannot be a
 * rendering artifact.
 *
 * `classId` and `order` ride along because a consumer that groups or evicts
 * needs them: P-019's per-class ceilings and eviction order are applied to THIS
 * row list, and a bare `string[]` gives a bounder nothing to bound BY.
 */
export interface OrientationRow {
  /** The registry class that emitted this row (`keyof OrientationState`). */
  readonly classId: keyof OrientationState;
  /** The class segment's emission order — ascending, the shared priority rule. */
  readonly order: number;
  /** The rendered line, verbatim. */
  readonly text: string;
}

/**
 * PURE: THE SHARED OBLIGATION + DELTA PROJECTION (P-018).
 *
 * Every surface that answers "what was this agent told" renders from this one
 * call — turn-start through {@link renderOrientationLines}, the HUD Orders rail
 * through `getAgentOrders` — so the question has a single answer by
 * construction rather than by two builders agreeing.
 *
 * ⚠ The SINK is what differs between callers, never the projection. A sink that
 * wants fewer classes withdraws itself from `applicableSinks`; it does not get
 * its own row builder. That is the whole mechanism: the moment a surface
 * post-processes these rows into different text, the guarantee is gone and the
 * P-018 equality test is what fails.
 */
export function projectOrientationRows(
  state: OrientationState,
  sink: OrientationSink,
  committed: CursorState | null = null,
  registry: readonly RegisteredOrientationClass[] = ORIENTATION_CLASS_REGISTRY,
): OrientationRow[] {
  const rows: OrientationRow[] = [];
  for (const { classId, order, render } of selectOrientationClassSegments(sink, registry)) {
    for (const text of render(state, committed)) {
      rows.push({ classId, order, text });
    }
  }
  return boundOrientationRows(rows, registry);
}

/**
 * PURE: enforce each class's {@link OrientationRowCeiling} on a projected row list,
 * disclosing what it evicted (P-019).
 *
 * Applied INSIDE {@link projectOrientationRows} rather than at each sink, so every
 * surface is bounded by construction and the P-018 "same rows everywhere" equality
 * still holds — a sink that bounded itself would be the second row builder that
 * registry exists to prevent.
 *
 * EVICTION ORDER is the registry's own ascending `order`, NOT a second ranking.
 * P-019's parenthetical (owner directives > walls > waiting-on > directed msgs)
 * reads as a rival cross-class order, and implementing it literally would have put
 * `neverDropFacts` second while the registry deliberately places it at 130, after
 * the obligation recovery route that must fit first (see that class's comment).
 * Two contradictory priority rules in one file is the defect, not the fix. What the
 * parenthetical was actually reaching for — walls must not be starved by a chattier
 * class — is delivered by the ceiling itself: once `obligations` and `announcedGates`
 * cannot run away, the classes ordered after them stop being collateral. See D-079.
 *
 * WITHIN a class the leading rows are kept, which is each renderer's own priority
 * order (openChecks sorts contested-first; ownerDirectives emits newest-first) — the
 * bounder cannot re-derive recency from a rendered string and does not pretend to.
 */
export function boundOrientationRows(
  rows: readonly OrientationRow[],
  registry: readonly RegisteredOrientationClass[] = ORIENTATION_CLASS_REGISTRY,
): OrientationRow[] {
  const ceilings = new Map(registry.map((entry) => [entry.id, entry.rowCeiling] as const));
  const kept: OrientationRow[] = [];
  const seen = new Map<keyof OrientationState, number>();
  const evicted = new Map<keyof OrientationState, { count: number; order: number }>();

  for (const row of rows) {
    const ceiling = ceilings.get(row.classId);
    // An unregistered class is left ALONE rather than silently dropped: this is a
    // bounder, and a row it cannot find a ceiling for is a registry gap for the
    // coverage test to report, not content for this function to delete.
    if (!ceiling) {
      kept.push(row);
      continue;
    }
    const count = seen.get(row.classId) ?? 0;
    if (count >= ceiling.maxRows) {
      const prior = evicted.get(row.classId);
      evicted.set(row.classId, { count: (prior?.count ?? 0) + 1, order: prior?.order ?? row.order });
      continue;
    }
    seen.set(row.classId, count + 1);
    kept.push(row);
  }

  if (evicted.size === 0) return kept;

  const out = [...kept];
  for (const [classId, info] of evicted) {
    const ceiling = ceilings.get(classId);
    if (!ceiling) continue;
    const disclosure: OrientationRow = {
      classId,
      order: info.order,
      text: `- ${classId}: +${info.count} omitted — ${ceiling.recoveryVerb}`,
    };
    // Anchor the disclosure to its OWN class so it inherits that class's priority
    // under the outer character budget: a recovery route that outlives the rows it
    // describes, or one that drifts to the tail and is trimmed, are both useless.
    let lastIndex = -1;
    for (let i = out.length - 1; i >= 0; i -= 1) {
      if (out[i].classId === classId) {
        lastIndex = i;
        break;
      }
    }
    if (lastIndex >= 0) {
      out.splice(lastIndex + 1, 0, disclosure);
      continue;
    }
    // maxRows: 0 — nothing of the class survived to anchor to, so fall back to the
    // order slot its first row would have occupied.
    const insertAt = out.findIndex((row) => row.order > info.order);
    out.splice(insertAt < 0 ? out.length : insertAt, 0, disclosure);
  }
  return out;
}

/**
 * PURE: {@link selectOrientationSegments} with the emitting class preserved.
 *
 * The public `selectOrientationSegments` flattens the class away, which is
 * correct for a caller that only concatenates lines and fatal for one that must
 * bound or evict per class (P-019). Both sort by the SAME `order`, so the two
 * views cannot disagree about emission sequence.
 */
function selectOrientationClassSegments(
  sink: OrientationSink,
  registry: readonly RegisteredOrientationClass[] = ORIENTATION_CLASS_REGISTRY,
): readonly {
  readonly classId: keyof OrientationState;
  readonly order: number;
  readonly render: (state: OrientationState, committed: CursorState | null) => string[];
}[] {
  return registry
    .filter((entry) => entry.applicableSinks.includes(sink))
    .flatMap((entry) =>
      entry.segments.map((segment) => ({
        classId: entry.id,
        order: segment.order,
        render: segment.render,
      })),
    )
    .slice()
    .sort((a, b) => a.order - b.order);
}


/** Named so {@link composeOrientationBlock} and {@link composeOrientationBlockWithRows}
 *  cannot drift apart: one composer, one input contract. */
export interface ComposeOrientationBlockInput {
  state: OrientationState;
  committed: CursorState | null;
  /**
   * The CONTEXT GENERATION this composition belongs to (see
   * `fingerprintOrientation`). REQUIRED rather than defaulted: a caller that
   * forgets it silently reinstates the epoch-blind suppression this parameter
   * exists to remove, and a default would make that omission invisible. 0 is
   * the honest value for "no generation known" (an unbumped or unreadable
   * ledger), which degrades to the pre-P-023 behaviour rather than to noise.
   */
  epoch: number;
  /** The agent's context size in tokens, for the owner-directive reminder
   *  cadence (see planOwnerDirectiveReminder). Omitted/null = unknown. */
  contextTokens?: number | null;
  budgetChars?: number;
}

/**
 * PURE: compose the final injected block, or '' for "say nothing this turn".
 *
 * Returns '' in all three silence cases — unchanged since last turn, nothing worth
 * saying, or a budget too small to fit even one line — so the caller can splice the
 * result unconditionally.
 */
export function composeOrientationBlock(input: ComposeOrientationBlockInput): string {
  return composeOrientationBlockWithRows(input).block;
}

/**
 * The same composition, ALSO returning the rows that survived the budget.
 *
 * Exists for P-020's REACH telemetry, which must count what the agent was
 * actually TOLD rather than what the projection produced. The composer breaks
 * on the first line that does not fit, so the surviving set is only knowable
 * here — a caller re-running {@link projectOrientationRows} would count classes
 * the budget dropped, and a starved class would then read as a healthy one.
 *
 * {@link composeOrientationBlock} delegates to this, so there is ONE composer
 * and the block a telemetry reader describes is byte-identical to the block the
 * agent received, by construction rather than by two functions agreeing.
 */
export function composeOrientationBlockWithRows(input: ComposeOrientationBlockInput): {
  block: string;
  rows: OrientationRow[];
} {
  /**
   * The CONTEXT GENERATION this composition belongs to (see
   * `fingerprintOrientation`). REQUIRED rather than defaulted: a caller that
   * forgets it silently reinstates the epoch-blind suppression this parameter
   * exists to remove, and a default would make that omission invisible. 0 is
   * the honest value for "no generation known" (an unbumped or unreadable
   * ledger), which degrades to the pre-P-023 behaviour rather than to noise.
   */
  const { state, committed, epoch } = input;
  const budget = input.budgetChars ?? ORIENTATION_BUDGET_CHARS;
  if (isEmptyOrientation(state)) return { block: '', rows: [] };
  // P-002 — CLASS-B RE-INJECT POLICY. An obligation row is discharged by
  // DISPOSITION, not by DELIVERY, so the unchanged-fingerprint comparison must
  // not govern it: a standing owner directive that rendered once and was then
  // suppressed as "unchanged" is a one-shot, which is the defect this item
  // names. Undischarged rows are therefore EXCLUDED from that comparison.
  //
  // When everything else really is unchanged, re-emit the ROW and not the whole
  // block: repeating held items, gates and facts that have not moved would
  // manufacture the exact signal decay D-003 withdrew the improvement-triage
  // line for.
  //
  // P-006 (owner-directive-delivery-redesign-2026-09-22) narrows that for OWNER
  // DIRECTIVES: a directive row this epoch already delivered is withheld, and a
  // one-line reminder stands in for it on the cadence planOwnerDirectiveReminder
  // decides. Every other undischarged family keeps the P-002 per-turn re-emit.
  const unchanged = orientationUnchanged(committed, fingerprintOrientation(state, epoch, committed));
  const directives = planOwnerDirectiveReminder(state, committed, epoch, input.contextTokens ?? null);
  const shown = withoutWithheldDirectiveRows(state, directives.withheld);
  const undischarged = hasUndischargedObligations(shown);
  if (unchanged && !undischarged && !directives.reminder) return { block: '', rows: [] };
  const renderState = unchanged ? undischargedObligationsOnly(shown) : shown;

  const header = `## ${HEADING}`;
  // Rows, not bare lines: identical text, but each carries the class that
  // emitted it, which is what lets the budget loop below report WHICH classes
  // survived. `renderOrientationLines` is this same call with `.map(r => r.text)`.
  // The reminder leads: an owner directive outranks everything else here.
  const projected: OrientationRow[] = [
    ...(directives.reminder ? [{ classId: 'obligations' as const, order: 0, text: directives.reminder }] : []),
    ...projectOrientationRows(renderState, 'turn-start', committed),
  ];
  const out: string[] = [header];
  const kept: OrientationRow[] = [];
  let used = header.length;
  let next = 0;
  for (; next < projected.length; next += 1) {
    const row = projected[next]!;
    const cost = row.text.length + 1; // + the newline joining it
    if (used + cost > budget) break;
    out.push(row.text);
    kept.push(row);
    used += cost;
  }
  // D-027: the break above used to drop every remaining row with no trace, so an
  // agent could not tell "nothing is owed" from "it did not fit". Say what was cut,
  // evicting kept rows from the tail until the marker fits. The marker is not a
  // class's row: it is never credited as delivery of anything it names.
  if (next < projected.length) {
    const omitted = projected.slice(next);
    const marker = () => {
      const classes = [...new Set(omitted.map((row) => row.classId))];
      const named = classes.slice(0, 3).join(', ') + (classes.length > 3 ? `, +${classes.length - 3}` : '');
      return `- +${omitted.length} orientation rows omitted (${named}) — coord:orient`;
    };
    while (kept.length > 0 && used + marker().length + 1 > budget) {
      const row = kept.pop()!;
      out.pop();
      omitted.unshift(row);
      used -= row.text.length + 1;
    }
    if (used + marker().length + 1 <= budget) out.push(marker());
  }
  // Header alone says nothing — emit only if at least one real line survived.
  // A header-only composition delivered NOTHING, so its rows are dropped too:
  // reporting them as reach would credit a class for a block nobody received.
  return out.length > 1 ? { block: out.join('\n'), rows: kept } : { block: '', rows: [] };
}

/** Fingerprint only obligation content that survived the final outer budget.
 * A provider receipt describes its inner projection; this check closes the
 * second budget boundary before the shared cursor is staged. */
/** The exact obligation projection the final outer budget actually delivered.
 * Both the cursor and identity receipt use this verdict, so a trimmed line
 * cannot be acknowledged or pinned as though the agent saw it. */
export function deliveredObligationProjection(
  state: OrientationState,
  committed: CursorState | null,
  epoch: number,
  block: string,
  contextTokens: number | null = null,
): { text: string | null; delivered: boolean } {
  if (!state.obligations) return { text: null, delivered: false };
  const obligations = withoutWithheldDirectiveRows(
    state,
    planOwnerDirectiveReminder(state, committed, epoch, contextTokens).withheld,
  ).obligations;
  if (!obligations) return { text: null, delivered: false };
  const projectedLines = obligations.projection.text.split('\n').filter(Boolean);
  const actionsDelivered = projectedLines.every((line) => block.includes(line));
  const recoveryDelivered = obligations.projection.receipt.entriesOmitted === 0 ||
    block.includes(obligations.detailRef);
  return { text: obligations.projection.text, delivered: actionsDelivered && recoveryDelivered };
}

export function fingerprintDeliveredOrientation(
  state: OrientationState,
  epoch: number,
  committed: CursorState | null,
  block: string,
  contextTokens: number | null = null,
): CursorState {
  let deliveredState = state;
  if (state.historyUpdates?.length) {
    const delivered = block.includes('post-claim history update(s)');
    if (!delivered) deliveredState = { ...deliveredState, historyUpdates: undefined };
  }
  if (state.effortUpdates?.length) {
    const delivered = block.includes('post-claim plan/goal revision(s)');
    if (!delivered) deliveredState = { ...deliveredState, effortUpdates: undefined };
  }
  // Budget-truncated ⇒ NOT delivered ⇒ do not advance the token. Without this the
  // first turn that trims this line marks the rows "seen" forever, and the agent
  // inherits a claim it was never shown — a silent failure indistinguishable from
  // the row having been re-checked.
  if (state.openChecks?.length) {
    const delivered = block.includes('🔎');
    if (!delivered) deliveredState = { ...deliveredState, openChecks: undefined };
  }
  const directiveMark = nextDirectiveMark(state, committed, epoch, block, contextTokens);
  const withMark = (fingerprint: CursorState): CursorState =>
    directiveMark ? { ...fingerprint, directiveReminder: directiveMark } : fingerprint;
  if (!state.obligations) return withMark(fingerprintOrientation(deliveredState, epoch, committed));
  const obligationDelivery = deliveredObligationProjection(state, committed, epoch, block, contextTokens);
  return withMark(
    fingerprintOrientation(
      obligationDelivery.delivered ? deliveredState : { ...deliveredState, obligations: undefined },
      epoch,
      committed,
    ),
  );
}

/**
 * Injectable IO seam (mirrors orient-capture-miss-hint.ts's deps pattern), so the
 * composition above stays unit-testable without PG and each source can be faulted
 * independently in a test.
 */
export interface OrientationDeps {
  held: (ownerId: string, workspaceId: string) => Promise<OrientationHeldItem[]>;
  /**
   * ⚠ `ownerId` LABELS, it never FILTERS. This reader returns EVERY directive in
   * the workspace — that is what the owner asked for (D-004: "agents seeing all
   * the directives so that agent knows what needs to be done/is being done").
   * The id is here only so `addressedToMe` can be decided, because a segment
   * `render` receives (state, committed) and has no way to know whose turn it is.
   * A future reader that narrows the QUERY by ownerId reintroduces the opposite
   * bug — directives invisible to everyone but their addressee.
   */
  ownerDirectives?: (workspaceId: string, ownerId: string) => Promise<OrientationOwnerDirective[]>;
  historyUpdates: (ownerId: string, workspaceId: string) => Promise<OrientationHistoryUpdate[]>;
  effortUpdates: (ownerId: string, workspaceId: string) => Promise<OrientationEffortUpdate[]>;
  /**
   * P-010: unverified carried claims + open external blockers, each with its probe.
   *
   * REQUIRED, and deliberately so. It briefly shipped OPTIONAL — the class was
   * declared, registered, watermarked and rendered while `defaultOrientationDeps()`
   * implemented no reader, so production populated NOTHING. An optional dep is
   * exactly what let that pass for finished: the P-001 coverage guard supplies the
   * state itself, so it proves the RENDER path and is structurally blind to a
   * missing RESOLVER (EI-23953846527835643). Keeping this required means a future
   * reader-less landing fails to typecheck instead of rendering silence forever.
   */
  openChecks: (ownerId: string, workspaceId: string) => Promise<OrientationOpenCheck[]>;
  /**
   * P-014: governing plan Decisions for the plans this owner holds items on.
   *
   * REQUIRED for the same reason `openChecks` above is, and learned from the
   * same incident (EI-23953846527835643): an OPTIONAL dep lets a class land
   * declared, registered, watermarked and rendered while production populates
   * NOTHING, because the coverage guard supplies the state itself and so proves
   * only the RENDER path. Required means a reader-less landing fails to
   * typecheck instead of rendering silence forever.
   */
  planDecisions: (ownerId: string, workspaceId: string) => Promise<OrientationPlanDecisions | undefined>;
  /**
   * P-015: this owner's lock transitions, from the SHARED `readQueue` reader —
   * never a query against the lock tables.
   *
   * REQUIRED for the third time in this interface, and for the same reason
   * `openChecks` and `planDecisions` above are (EI-23953846527835643): an
   * OPTIONAL dep lets a class land declared, registered, watermarked and
   * rendered while production populates NOTHING, because the coverage guard
   * supplies the state itself and so proves only the RENDER path.
   */
  lockTransitions: (
    ownerId: string,
    workspaceId: string,
  ) => Promise<OrientationLockTransitions | undefined>;
  /**
   * P-016. REQUIRED for the fourth time in this interface, and for the same
   * reason (EI-23953846527835643): an OPTIONAL dep lets a class land declared,
   * registered, watermarked and rendered while production populates NOTHING,
   * because the coverage guard supplies the state itself and so proves only
   * the RENDER path. `null` is UNREADABLE; `[]` is measured-empty.
   */
  coupledPeers: (ownerId: string, workspaceId: string) => Promise<OrientationCoupledPeer[] | null>;
  inbox: (ownerId: string) => Promise<{
    count: number;
    newest: OrientationInboxEntry[];
    /** EI-20085805220385722: asks whose SENDER is positively ended. Optional so
     *  an older/stubbed seam still satisfies this contract (absent ⇒ 0). */
    staleCount?: number;
  }>;
  announcedGates: (ownerId: string, workspaceId: string) => Promise<OrientationAnnouncedGate[]>;
  /** WI-2142142: directed messages this agent sent that a peer has not yet
   *  answered; null for none/unreadable — same fail-soft contract as every
   *  other source here. */
  openAsks: (ownerId: string) => Promise<OrientationOpenAsk | null>;
  /** Active modes with attribution; null for unreadable (never `[]`, which
   *  means genuinely none). */
  modes: (ownerId: string, workspaceId: string) => Promise<OrientationModeState[] | null>;
  /**
   * P-013: the effective authority verdict; null for unreadable (never a
   * fabricated confirm-first default, which would be a false statement about
   * what this agent may do).
   *
   * REQUIRED, and deliberately so — the same rule `openChecks` above carries.
   * The resolver-coverage guard enumerates `keyof OrientationDeps`, so a
   * required dep makes a reader-less landing a COMPILE error instead of the
   * P-010 trap: declared, registered, watermarked and rendered while production
   * populates nothing, with the render-coverage guard staying green because it
   * supplies the state itself (EI-23953846527835643).
   */
  authorityVerdict: (ownerId: string, workspaceId: string) => Promise<OrientationAuthorityVerdict | null>;
  loopArmed: (ownerId: string) => Promise<boolean>;
  loopFireWithheld: (ownerId: string) => Promise<boolean>;
  /** Existing improvement triage/ranking path, reduced to one bounded row. */
  improvementTriage: (workspaceId: string) => Promise<OrientationImprovementTriage | null>;
  /** P-011 exact-plan executable width, or null when paused/unknown/broad. */
  executableFrontier: (ownerId: string, workspaceId: string) => Promise<OrientationExecutableFrontier | null>;
  /** Same evaluated agenda fleet:leader-brief consumes, projected to this sink's tighter cap. */
  /** A `{ withheldBy }` result means an R-4 experiment arm withheld the agenda. */
  obligations: (ownerId: string, workspaceId: string) => Promise<AgentObligationBrief | ObligationsWithheldByArm | null>;
  /** KEYS of never-drop standing facts in this agent's scopes (workspace + owner). */
  neverDropFacts: (ownerId: string, workspaceId: string) => Promise<string[]>;
  /**
   * Evidence that this agent's MCP tool surface loaded EMPTY, or null for
   * healthy/unreadable. Takes only `ownerId`: the detector deliberately scopes by
   * NOTHING else (see the default reader for why a workspace/harness predicate
   * manufactures false positives here).
   */
  toolSurface: (ownerId: string) => Promise<OrientationToolSurface | null>;
  /**
   * The measured carry blind window (EI-21442716425230784), or null when there
   * is no recent cut, the window was empty, or it could not be read — all three
   * render as silence, because a window manufactured from a failed read would
   * send a successor hunting turns that do not exist.
   */
  carryBlindWindow: (ownerId: string, workspaceId: string) => Promise<CarryBlindWindow | null>;
  /**
   * The agent's CONTEXT GENERATION (P-023 / D-008) — NOT part of the rendered
   * state, only of the dedup key, which is why it is not on `OrientationState`.
   * Reads `memory_session_epochs`, the same counter the memory surfaced-ledger
   * dedups on, so the two folds on this rail cannot disagree about what a
   * context boundary is.
   */
  contextEpoch: (ownerId: string) => Promise<number>;
  /**
   * The agent's context size in tokens (P-006 reminder cadence). Like
   * `contextEpoch`, an input to the dedup rather than rendered state, so it is
   * not on OrientationState. Optional so an injected deps object without it
   * falls back to the default reader; a failed reading is null, which switches
   * the cadence to wall-clock.
   */
  contextTokens?: (ownerId: string) => Promise<number | null>;
}

/**
 * Resolve this turn's orientation. EVERY source is independently `.catch()`ed and
 * the whole set runs in ONE `Promise.all`, because of the 2.5s wall: a slow or
 * broken source must degrade its own line, never the block and never the turn.
 * A failed `held` read yields [] and a failed count yields 0 — both of which
 * simply say less, and neither of which can throw into the endpoint.
 */
export async function resolveOrientationState(
  ownerId: string,
  workspaceId: string,
  deps: Partial<OrientationDeps> = {},
): Promise<OrientationState> {
  const d = { ...defaultOrientationDeps(), ...deps };
  const ownerDirectivesReader = d.ownerDirectives ?? (async () => [] as OrientationOwnerDirective[]);
  const [
    held,
    ownerDirectives,
    historyUpdates,
    effortUpdates,
    openChecks,
    inbox,
    announcedGates,
    openAsks,
    modes,
    authorityVerdict,
    planDecisions,
    lockTransitions,
    coupledPeers,
    loopArmed,
    loopFireWithheld,
    improvementTriage,
    executableFrontier,
    obligations,
    neverDropFacts,
    toolSurface,
    carryBlindWindow,
  ] = await Promise.all([
    d.held(ownerId, workspaceId).catch(() => null),
    ownerDirectivesReader(workspaceId, ownerId).catch(() => [] as OrientationOwnerDirective[]),
    // Unknown must remain distinct from measured-empty. Otherwise a transient
    // read failure advances the shared cursor past history the agent never saw.
    d.historyUpdates(ownerId, workspaceId).catch(() => undefined),
    d.effortUpdates(ownerId, workspaceId).catch(() => undefined),
    // Same unknown-vs-measured-empty rule. It matters MORE here than for the two
    // above: an empty list reads as "nothing left to falsify", which is the exact
    // false reassurance this class exists to deny. A read failure must stay silent
    // and preserve the prior token, never assert the all-clear.
    // An ABSENT reader and a FAILED read are the same thing to this class, and both
    // must resolve `undefined` rather than `[]` — see the dep's doc comment. `[]`
    // would assert "nothing left to falsify", the false all-clear this class denies.
    d.openChecks ? d.openChecks(ownerId, workspaceId).catch(() => undefined) : Promise.resolve(undefined),
    d.inbox(ownerId).catch(() => ({ count: 0, newest: [] as OrientationInboxEntry[] })),
    d.announcedGates(ownerId, workspaceId).catch(() => [] as OrientationAnnouncedGate[]),
    // Fail-soft to null, same rule as toolSurface below: "cannot tell" must
    // render as silence, never as a false "nothing outstanding".
    d.openAsks(ownerId).catch(() => null as OrientationOpenAsk | null),
    // Fail-soft to NULL, not `[]`: "could not read" must stay distinguishable
    // from "no modes set", or the fingerprint erases the cursor and fakes a
    // fresh transition on recovery.
    d.modes(ownerId, workspaceId).catch(() => null as OrientationModeState[] | null),
    // Fail-soft to NULL, and it matters more here than anywhere else in this set:
    // a fabricated verdict is a false statement about what the agent is ALLOWED
    // to do. "Could not read" must stay distinguishable from a real verdict, or
    // the fingerprint erases the cursor and fakes a fresh transition on recovery.
    d.authorityVerdict(ownerId, workspaceId).catch(() => null as OrientationAuthorityVerdict | null),
    // Fail-soft to UNDEFINED, never `{ decisions: [] }` (D-081 ruling 3). A
    // measured-empty here would assert "no governing decisions" from a read that
    // did not happen, and the fingerprint would then advance the cursor past
    // rulings the agent never saw — so the decisions would never re-render.
    d.planDecisions(ownerId, workspaceId).catch(() => undefined),
    // P-015: fail-soft to UNDEFINED, never a measured-empty
    // `{ held: [], blocked: [], observed: [] }`. The empty value is worse here
    // than for decisions: `observed` is what the watermark token encodes, so a
    // failed read that claimed measured-empty would WRITE an empty token — and
    // the next GOOD read would then see every standing hold as newly granted.
    d.lockTransitions(ownerId, workspaceId).catch(() => undefined),
    // P-016: fail-soft to NULL (the `modes` convention), never `[]`. A failed
    // read that claimed measured-empty would WRITE an empty token, and the next
    // good read would then re-render every coupled peer's standing intent as new.
    d.coupledPeers(ownerId, workspaceId).catch(() => null as OrientationCoupledPeer[] | null),
    d.loopArmed(ownerId).catch(() => false),
    d.loopFireWithheld(ownerId).catch(() => false),
    d.improvementTriage(workspaceId).catch(() => null),
    d.executableFrontier(ownerId, workspaceId).catch(() => null),
    // Undefined is distinct from measured-empty: preserve the prior cursor on
    // an optional read failure so a transient outage cannot fake resolution.
    d.obligations(ownerId, workspaceId).catch(() => undefined),
    // Degrades to "say nothing about facts", never to a thrown turn — same rule
    // as every other source here. A failed read must not be able to suppress the
    // block that carries the other agents' warnings.
    d.neverDropFacts(ownerId, workspaceId).catch(() => [] as string[]),
    // Fail-soft to null — "cannot tell" renders as SILENCE, never as a verdict. A
    // slow or broken read here must not be able to accuse a working agent of being
    // toolless; the cost of a missed warning is one more turn, the cost of a false
    // one is an agent restarting a session that was fine.
    d.toolSurface(ownerId).catch(() => null as OrientationToolSurface | null),
    // Same fail-soft rule, and it matters here specifically: the reader spans a
    // host event log and a PG count, either of which can be unavailable on the
    // very turn a successor boots.
    d.carryBlindWindow(ownerId, workspaceId).catch(() => null as CarryBlindWindow | null),
  ]);
  return {
    held: held ?? [],
    ...(held === null ? { heldReadFailed: true } : {}),
    ...(ownerDirectives.length > 0 ? { ownerDirectives } : {}),
    historyUpdates,
    effortUpdates,
    openChecks,
    unansweredDirected: inbox.count,
    // `in` rather than a plain read: an injected seam (tests, an older deps
    // object) may legitimately omit the field, and the union type says so.
    // Absent ⇒ 0 ⇒ nothing demoted, which is the fail-open direction.
    unansweredStale: 'staleCount' in inbox ? (inbox.staleCount ?? 0) : 0,
    inboxRecent: inbox.newest,
    announcedGates,
    openAsks,
    modes,
    authorityVerdict,
    planDecisions,
    lockTransitions,
    coupledPeers,
    loopArmed,
    loopFireWithheld,
    improvementTriage,
    executableFrontier,
    ...splitObligationsRead(obligations),
    neverDropFacts,
    toolSurface,
    carryBlindWindow,
  };
}

/** Default readers — each one is an EXISTING shared primitive, never a new query.
 *  Dynamic imports keep them off the module graph until a turn actually needs them. */
export function defaultOrientationDeps(): OrientationDeps {
  return {
    /**
     * P-014. Reuse-first: the decisions themselves come from
     * `getClaimTimePlanDecisions`, the SHARED reader already behind
     * work_items:claim / claim_next / plan-items:claim / scheduler:get_next —
     * NOT a new decisions query (D-081).
     *
     * `undefined` on ANY failure, never a measured-empty: see the dep's
     * declaration and D-081 ruling 3.
     */
    planDecisions: async (ownerId, workspaceId) => {
      try {
        const [{ getOrgPg }, { resolveConcreteWorkspaceId }, { getClaimTimePlanDecisions }] = await Promise.all([
          import('@papercusp/db-org'),
          import('./workspace-registry'),
          import('./plan-decisions-claim-port'),
        ]);
        const ws = resolveConcreteWorkspaceId(workspaceId);
        // The plans this owner holds a claimed, NON-TERMINAL item on. Bounded:
        // an owner working many plans at once is the rare case, and the row
        // ceiling already truncates the rendered set.
        const rows = (await getOrgPg().sql`
          SELECT DISTINCT source_plan_slug, harness_slug
            FROM harness_shared.work_items
           WHERE workspace_id = ${ws}
             AND taken_by = ${ownerId}
             AND source_plan_slug IS NOT NULL
             AND lane IS DISTINCT FROM 'observation'
             AND NOT (status = ANY(${[...ANY_FAMILY_TERMINAL_STATES]}::text[]))
           LIMIT 8
        `) as { source_plan_slug: string; harness_slug: string | null }[];
        if (rows.length === 0) return { decisions: [], omitted: 0, authorityReadFailed: false };
        const briefs = await Promise.all(
          rows.map((row) =>
            getClaimTimePlanDecisions({
              planSlug: row.source_plan_slug,
              harness: row.harness_slug,
              workspaceId: ws,
            }).catch(() => null),
          ),
        );
        const decisions: OrientationPlanDecision[] = [];
        let omitted = 0;
        let authorityReadFailed = false;
        for (const brief of briefs) {
          // A per-plan read that FAILED contributes the failure flag, not a
          // silent zero — otherwise one bad plan reads as "nothing governing".
          if (!brief) {
            authorityReadFailed = true;
            continue;
          }
          if (brief.authorityReadFailed) authorityReadFailed = true;
          // The window is bounded; disclose what it could not show rather than
          // letting `decisions.length` stand in for the whole set.
          omitted += Math.max(0, brief.totalDecisions - brief.decisions.length);
          for (const d of brief.decisions) {
            decisions.push({
              ref: d.ref ?? `${d.sourcePlanSlug ?? brief.planSlug}#${d.id}`,
              planSlug: d.sourcePlanSlug ?? brief.planSlug,
              id: d.id,
              title: d.title,
            });
          }
        }
        return { decisions, omitted, authorityReadFailed };
      } catch {
        return undefined;
      }
    },
    /**
     * P-015: this owner's CURRENT lock position, via the SHARED `readQueue`
     * reader `locks:queue` itself uses — never a query against the lock tables.
     *
     * `coordinationDomain: null` is the documented cross-checkout DIAGNOSTIC
     * read (su-lock-store.ts), and is correct for an owner-scoped question
     * because `owner` is globally unique. But a BLOCKER may only be attributed
     * WITHIN a domain: two checkouts holding the same repo-relative path are
     * two different files, so the holder join below is keyed on
     * `(coordinationDomain, path)` and never on path alone.
     *
     * Cost: ONE owner-scoped read on the common path. `WaiterRow` does not
     * carry the holder's owner/intent (only `holder_expires_ts`), so a SECOND,
     * paths-scoped read supplies the holder — fired only when this owner is
     * actually waiting on something, which is the rare case. That is what
     * keeps the class off the turn-start budget.
     */
    lockTransitions: async (ownerId, _workspaceId) => {
      try {
        const { ensureBootstrap, getTxPool, readQueue } = await import(
          './agent-tools/locks/su-lock-store'
        );
        await ensureBootstrap();
        const sql = getTxPool();
        const mine = await readQueue(sql, { coordinationDomain: null, owner: ownerId });

        const held: OrientationLockTransition[] = mine.active_locks.map((row) => ({
          kind: 'granted' as const,
          path: row.path,
          coordinationDomain: row.coordination_domain,
        }));

        // One waiter TICKET can span several paths; each path is its own
        // potential block, so the rows are per-path, not per-ticket.
        const waiting = mine.waiting.flatMap((row) =>
          row.paths.map((path) => ({ path, coordinationDomain: row.coordination_domain })),
        );

        let blocked: OrientationLockTransition[] = waiting.map((w) => ({
          kind: 'blocked' as const,
          path: w.path,
          coordinationDomain: w.coordinationDomain,
        }));

        // Only now — and only if this owner is waiting on anything — pay for
        // the holder read. A `blocked` line without its holder still renders:
        // "you are blocked here" is the load-bearing half, and a holder the
        // read could not attribute must NOT be invented.
        if (waiting.length > 0) {
          try {
            const holders = await readQueue(sql, {
              coordinationDomain: null,
              paths: [...new Set(waiting.map((w) => w.path))],
            });
            // JSON-encoded pair rather than a joined string: the key must be
            // injective over (domain, path), and both halves are filesystem
            // text that can contain any separator one might pick.
            const byPathDomain = new Map<string, (typeof holders.active_locks)[number]>();
            for (const row of holders.active_locks) {
              // Never map this owner's own row onto a peer's: a self-held path
              // is not a block on this owner.
              if (row.owner === ownerId) continue;
              byPathDomain.set(JSON.stringify([row.coordination_domain, row.path]), row);
            }
            blocked = blocked.map((row) => {
              const holder = byPathDomain.get(
                JSON.stringify([row.coordinationDomain, row.path]),
              );
              return holder
                ? {
                    ...row,
                    holder: {
                      owner: holder.owner,
                      ownerLabel: holder.owner_label ?? null,
                      intent: holder.intent,
                      // `expires_ts` comes back as a Date from the lock store.
                      // The line is read by an agent, so normalise to ISO-8601
                      // here rather than letting a locale-dependent
                      // `toString()` decide at template-interpolation time.
                      expiresTs:
                        holder.expires_ts instanceof Date
                          ? holder.expires_ts.toISOString()
                          : String(holder.expires_ts),
                    },
                  }
                : row;
            });
          } catch {
            // The holder read is an ENRICHMENT. Losing it must not lose the
            // block itself, and must not downgrade the whole class to
            // unreadable — that would erase the cursor over a detail.
          }
        }

        return {
          held,
          blocked,
          // The token set: the WHOLE observed position, held and waiting
          // alike. Sorting happens at the fingerprint; membership is what the
          // render diff tests.
          observed: [
            ...held.map((row) => `h:${row.coordinationDomain}:${row.path}`),
            ...blocked.map((row) => `b:${row.coordinationDomain}:${row.path}`),
          ],
        };
      } catch {
        return undefined;
      }
    },
    /**
     * P-016: the current intent of every peer this owner is coupled to by an
     * opt-in `coord:couple` edge.
     *
     * Reuse-first, per D-078(b)/D-081 (no private notion of "coupled"): the edge
     * set comes from `listCouplingsFor` and is resolved through the SHARED
     * `resolveCoupledPeers` predicate, which applies decouple SUPPRESSION — so a
     * decoupled peer never reaches the render. `derived` is passed EMPTY on
     * purpose: the item names the declared `coord:couple` edges (coupling that is
     * opt-in and already paid for). Passing `[]` narrows the INPUT; it does not
     * re-implement the union.
     *
     * The intent itself has no existing owner-scoped reader (presence-fleet
     * selects none, coupling-sources selects none), so it is ONE bounded read of
     * `coord_presence.intent` for exactly those peer ids. `intent_declared_at` is
     * deliberately NOT read: a re-declaration of the SAME intent bumps it, and
     * encoding it would re-render an unchanged intent on every re-declare.
     *
     * Fail-soft to NULL (unreadable), never `[]` — see the resolver's call site.
     */
    coupledPeers: async (ownerId, workspaceId) => {
      try {
        const [{ getOrgPg }, { resolveConcreteWorkspaceId }, { listCouplingsFor, resolveCoupledPeers }] =
          await Promise.all([
            import('@papercusp/db-org'),
            import('./workspace-registry'),
            import('./coord/couplings'),
          ]);
        const ws = resolveConcreteWorkspaceId(workspaceId);
        const edges = await listCouplingsFor(ownerId, ws);
        const peerIds = [
          ...new Set(resolveCoupledPeers(ownerId, [], edges).map((peer) => peer.ownerId)),
        ].filter((id) => id !== ownerId);
        if (peerIds.length === 0) return [];
        // DISTINCT ON owner_id so the read is correct whatever the table's key
        // is: the freshest presence row per peer carries its current intent.
        const rows = (await getOrgPg().sql`
          SELECT DISTINCT ON (owner_id) owner_id, owner_label, intent
            FROM harness_shared.coord_presence
           WHERE owner_id = ANY(${peerIds})
           ORDER BY owner_id, last_active_at DESC NULLS LAST
           LIMIT 32
        `) as { owner_id: string; owner_label: string | null; intent: string | null }[];
        const peers: OrientationCoupledPeer[] = [];
        for (const row of rows) {
          const intent = (row.intent ?? '').replace(/\s+/g, ' ').trim();
          // No declared intent = nothing to tell the agent. It is not a change.
          if (intent.length === 0) continue;
          peers.push({ ownerId: row.owner_id, ownerLabel: row.owner_label, intent });
        }
        return peers.sort((a, b) => a.ownerId.localeCompare(b.ownerId));
      } catch {
        return null;
      }
    },
    ownerDirectives: async (workspaceId, ownerId) => {
      const { listOpenOwnerDirectives } = await import('./owner-directives');
      // P-008 / D-008: the banner is rendered FOR this session, so rows it has
      // cleared off its own agenda are excluded — here and nowhere else. The
      // directive itself is untouched for its addressee and every peer, which
      // is what makes clearing a foreign directive a safe, expected action
      // rather than the erase-a-peer's-order defect D-009 measured.
      const live: OwnerDirectiveRow[] = await listOpenOwnerDirectives(workspaceId, 12, undefined, ownerId);
      if (live.length === 0) return [];

      // "Related to your work" (R-3): another session's directive is flagged when
      // its addressee has declared the same current plan as this session. One
      // batched presence read; failure only loses the flag, never the line.
      let relatedAddressees = new Set<string>();
      // P-003 (directive-ownership-clarity-2026-09-23): each addressee's current
      // intent rides the SAME presence read; its session state comes from the one
      // liveness oracle (via the routing deps), never re-derived here.
      let intents = new Map<string, string | null>();
      let states = new Map<string, string | null>();
      const addressees = [...new Set(live.map((r) => r.recordedBy).filter((id) => id && id !== ownerId))];
      try {
        const { getOrgPg } = await import('@papercusp/db-org');
        if (addressees.length > 0) {
          const plans = (await getOrgPg().sql`
            SELECT DISTINCT ON (owner_id) owner_id, current_plan_slug, intent
              FROM harness_shared.coord_presence
             WHERE owner_id = ANY(${[ownerId, ...addressees]})
             ORDER BY owner_id, last_active_at DESC NULLS LAST
          `) as { owner_id: string; current_plan_slug: string | null; intent: string | null }[];
          intents = new Map(plans.map((p) => [p.owner_id, p.intent ?? null]));
          const myPlan = plans.find((p) => p.owner_id === ownerId)?.current_plan_slug ?? null;
          if (myPlan) {
            relatedAddressees = new Set(
              plans.filter((p) => p.owner_id !== ownerId && p.current_plan_slug === myPlan).map((p) => p.owner_id),
            );
          }
        }
      } catch {
        relatedAddressees = new Set();
      }
      if (addressees.length > 0) {
        try {
          const { defaultDirectiveRoutingDeps } = await import('./owner-directive-routing');
          states = await defaultDirectiveRoutingDeps().sessionStates(addressees);
        } catch {
          states = new Map();
        }
      }

      // ONE batched join for the whole banner, never one query per row: this runs on
      // the turn-start hot path under a hard 2.5s wall shared with every other source.
      // Failure DEGRADES the line rather than the block — an undecorated directive is
      // still correctly LABELLED with recordedBy, which is the half that prevents the
      // leak; only the claimed/unclaimed split is lost.
      let byDirective = new Map<number, Array<{ id: string; state: string; assignee: string | null }>>();
      try {
        const { listWorkItemsByDirective } = await import('./work-items');
        const linked = await listWorkItemsByDirective(workspaceId, live.map((r) => r.id));
        byDirective = linked.reduce((acc, item) => {
          const bucket = acc.get(item.directiveRef);
          if (bucket) bucket.push(item);
          else acc.set(item.directiveRef, [item]);
          return acc;
        }, new Map<number, Array<{ id: string; state: string; assignee: string | null }>>());
      } catch {
        byDirective = new Map();
      }

      return live.map((row) => ({
        id: row.id,
        verbatimText: row.verbatimText,
        summaryText: row.summaryText ?? null,
        summaryBy: row.summaryBy ?? null,
        relatedToMe: relatedAddressees.has(row.recordedBy),
        // The two fields whose absence WAS the bug (D-006). The parallel obligation
        // rail has always mapped both; this is the same mapping, not a new source.
        recordedBy: row.recordedBy,
        capturedByHook: row.capturedByHook === true,
        // LABEL, not filter — every row is returned either way (D-004).
        addressedToMe: row.recordedBy === ownerId,
        addresseeState: row.recordedBy === ownerId ? null : (states.get(row.recordedBy) ?? null),
        addresseeIntent: row.recordedBy === ownerId ? null : (intents.get(row.recordedBy) ?? null),
        alsoSentTo: row.otherSessionCopies,
        status: deriveDirectiveStatus(row, byDirective.get(row.id) ?? []),
      }));
    },
    effortUpdates: async (ownerId, workspaceId) => {
      const [{ getOrgPg }, { resolveConcreteWorkspaceId }] = await Promise.all([
        import('@papercusp/db-org'),
        import('./workspace-registry'),
      ]);
      const { sql } = getOrgPg();
      const ws = resolveConcreteWorkspaceId(workspaceId);
      const rows = await sql<Array<{
        level: 'plan' | 'goal';
        effort_ref: string;
        post_count: number | string;
        newest_post_id: number | string;
      }>>`
        WITH held AS (
          SELECT feature_id, harness_slug, taken_by, source_plan_slug, goal_id, payload
            FROM harness_shared.work_items
           WHERE workspace_id = ${ws}
             AND taken_by = ${ownerId}
             AND taken_at IS NOT NULL
             AND ((item_kind IN ('bug', 'change', 'task') AND NOT (status = ANY(${[...ISSUE_TERMINAL_STATES]}::text[])))
               OR (item_kind IN ('feature', 'chunk') AND NOT (status = ANY(${[...FEATURE_TERMINAL_STATES]}::text[]))))
           ORDER BY feature_id DESC
           LIMIT 6
        ), ancestry AS (
          SELECT h.*,
                 COALESCE(h.goal_id, p.goal_id) AS effective_goal_id
            FROM held h
            LEFT JOIN harness_shared.harness_plans p
              ON p.workspace_id = ${ws}
             AND p.harness_slug = h.harness_slug
             AND p.plan_slug = h.source_plan_slug
        ), relevant AS (
          SELECT 'plan'::text AS level,
                 a.source_plan_slug AS effort_ref,
                 a.payload,
                 t.thread_id
            FROM ancestry a
            JOIN harness_shared.coord_threads t
              ON t.workspace_id = ${ws}
             AND t.parent_kind = 'plan'
             AND t.parent_ref = a.harness_slug || ':' || a.source_plan_slug
           WHERE a.source_plan_slug IS NOT NULL
          UNION ALL
          SELECT 'goal'::text AS level,
                 a.effective_goal_id AS effort_ref,
                 a.payload,
                 t.thread_id
            FROM ancestry a
            JOIN harness_shared.coord_threads t
              ON t.workspace_id = ${ws}
             AND t.parent_kind = 'goal'
             AND t.parent_ref = a.effective_goal_id
           WHERE a.effective_goal_id IS NOT NULL
        )
        SELECT r.level,
               r.effort_ref,
               count(DISTINCT p.id)::int AS post_count,
               max(p.id)::bigint AS newest_post_id
          FROM relevant r
          JOIN harness_shared.coord_thread_posts p
            ON p.workspace_id = ${ws}
           AND p.thread_id = r.thread_id
           AND p.id > COALESCE(NULLIF(r.payload ->> 'claim_history_post_id', '')::bigint, 0)
         GROUP BY r.level, r.effort_ref
         ORDER BY max(p.id) DESC
      `;
      return rows.map((row) => ({
        level: row.level,
        ref: row.effort_ref,
        count: Number(row.post_count),
        newestPostId: Number(row.newest_post_id),
      }));
    },
    historyUpdates: async (ownerId, workspaceId) => {
      const [{ getOrgPg }, { resolveConcreteWorkspaceId }] = await Promise.all([
        import('@papercusp/db-org'),
        import('./workspace-registry'),
      ]);
      const { sql } = getOrgPg();
      const ws = resolveConcreteWorkspaceId(workspaceId);
      const rows = await sql<Array<{
        work_item_id: string;
        harness_slug: string | null;
        post_count: number | string;
        newest_post_id: number | string;
      }>>`
        WITH held AS (
          SELECT feature_id, harness_slug, item_kind, taken_at, payload
            FROM harness_shared.work_items
           WHERE workspace_id = ${ws}
             AND taken_by = ${ownerId}
             AND taken_at IS NOT NULL
             AND ((item_kind IN ('bug', 'change', 'task') AND NOT (status = ANY(${[...ISSUE_TERMINAL_STATES]}::text[])))
               OR (item_kind IN ('feature', 'chunk') AND NOT (status = ANY(${[...FEATURE_TERMINAL_STATES]}::text[]))))
           ORDER BY feature_id DESC
           LIMIT 6
        ), relevant_threads AS (
          SELECT h.feature_id,
                 h.harness_slug,
                 h.taken_at,
                 h.payload,
                 t.thread_id
            FROM held h
            JOIN harness_shared.coord_threads t
              ON t.workspace_id = ${ws}
             AND (
               (t.parent_kind = 'issue' AND h.item_kind IN ('bug', 'change', 'task') AND t.parent_ref = h.feature_id)
               OR (t.parent_kind = 'feature' AND h.item_kind IN ('feature', 'chunk') AND t.parent_ref = h.harness_slug || '#' || h.feature_id)
             )
        )
        SELECT r.feature_id AS work_item_id,
               r.harness_slug,
               count(*)::int AS post_count,
               max(p.id)::bigint AS newest_post_id
          FROM relevant_threads r
          JOIN harness_shared.coord_thread_posts p
           ON p.workspace_id = ${ws}
           AND p.thread_id = r.thread_id
           AND p.id > COALESCE(
             NULLIF(r.payload ->> 'claim_history_post_id', '')::bigint,
             -- Legacy claims predate the atomic watermark. Reconstruct the
             -- best truthful baseline from posts that already existed by the
             -- claim instant; new claims never use this timestamp fallback.
             (SELECT max(before.id)
                FROM harness_shared.coord_thread_posts before
               WHERE before.workspace_id = ${ws}
                 AND before.thread_id = r.thread_id
                 AND before.created_at <= r.taken_at),
             0
           )
         GROUP BY r.feature_id, r.harness_slug
         ORDER BY max(p.id) DESC
      `;
      return rows.map((row) => ({
        workItemId: row.work_item_id,
        harness: row.harness_slug,
        count: Number(row.post_count),
        newestPostId: Number(row.newest_post_id),
      }));
    },
    // The SAME primitive coord:orient folds this tier with (foldNeverDropFacts,
    // narrowed in SQL to NEVER_DROP_KEY_PREFIXES), so the per-turn block and the
    // orient fold cannot drift on "what counts as a never-drop fact".
    //
    // Scoped to workspace + owner, matching orient's own selector set minus the
    // harness leg — this fold has no harness argument to pass, and a guard rail
    // worth interrupting a turn for is asserted at workspace scope in practice.
    neverDropFacts: async (ownerId, workspaceId) => {
      const { foldNeverDropFacts } = await import('./agent-facts/store');
      const selectors = [
        { scope: 'workspace' as const },
        ...(ownerId ? [{ scope: 'owner' as const, scopeRef: ownerId }] : []),
      ];
      const facts = await foldNeverDropFacts(selectors, { workspaceId });
      const keys = facts.map((f) => f.key).filter((k): k is string => Boolean(k));
      // Deduped because the same key can legitimately resolve from two selectors;
      // sorted so the fingerprint is stable across fold order.
      return [...new Set(keys)].sort();
    },
    // carry-brief.ts's reader, already extracted so this fold and orient's
    // post-compaction recovery fold cannot drift on "what am I holding".
    //
    // ⚠ v1 CARRIES NO STATUS. `CarryBriefHeldItem` is { id, title, body, harness,
    // checkpoint } — there is no `status` field, so nothing here can populate one
    // without a SECOND query. The consequence is precise and worth knowing: an
    // item moving wip→blocked does NOT re-emit the block (the fingerprint sees an
    // unchanged id list); an item being CLAIMED or RELEASED does. That is the
    // right trade for a per-turn fold, but do not read the absence of a re-emit
    // as "nothing about my items changed".
    held: async (ownerId, workspaceId) => {
      const [{ readHeldWorkItems }, { isStaleHeldCheckpoint }] = await Promise.all([
        import('./carry-brief'),
        import('./turn-end-tracking'),
      ]);
      const rows = await readHeldWorkItems(ownerId, workspaceId);
      const nowMs = Date.now();
      return rows
        .map((r) => ({
          id: r.id,
          harness: r.harness,
          checkpoint: r.checkpoint,
          checkpointUpdatedAtMs: r.checkpointUpdatedAtMs,
          checkpointStale: Boolean(r.checkpoint?.trim()) && isStaleHeldCheckpoint(r, nowMs),
        }))
        .filter((r) => Boolean(r.id));
    },
    /**
     * P-010 (WI-10002221): the two "do not inherit this claim" sources, each
     * carrying the probe that settles it.
     *
     * RESCUE NOTE — why this reads as an afterthought and is not one. The class
     * landed DECLARED, registered, watermarked and rendered-if-populated, with no
     * resolver at all, so in production it populated nothing: the exact
     * 0-renders-in-334-turns failure this plan exists to prevent, reproduced one
     * level up inside the machinery built to detect it. The P-001 coverage guard
     * is structurally blind to it because the guard SUPPLIES the state itself, so
     * only a resolver-side check can see a missing reader (EI-23953846527835643).
     *
     * Both halves REUSE the canonical readers their owning surfaces already use —
     * `getLoopStatus` + `getLoopCarryNoteWithMeta` + `splitCarryNoteChecks` for the
     * carry-note rows, `activeExternalBlockers` for the payload rows — so this sink
     * cannot disagree with the carry document about what is carried, nor with the
     * blocked-items card about why something is blocked.
     *
     * Each half is caught INDEPENDENTLY: this file's contract is that a slow or
     * broken source degrades its own line and never the block (see
     * `resolveOrientationState`), and one unreadable half must not silently
     * suppress the other.
     */
    openChecks: async (ownerId, workspaceId) => {
      const out: OrientationOpenCheck[] = [];
      // HALF 1 — carried claims that are NOT settled. A row holding `verified`
      // evidence with no contradiction is done with; everything else is either
      // PREDICTED (no evidence attached) or CONTESTED (evidence that disagrees
      // with its own claim). Both are conclusions a successor will otherwise act
      // on while they are wrong, which is the whole point of the class.
      try {
        const [{ getLoopStatus }, carryNote] = await Promise.all([
          import('./harness/routines/loop'),
          import('./carry-note'),
        ]);
        const loop = await getLoopStatus(ownerId);
        if (loop) {
          const meta = await carryNote.getLoopCarryNoteWithMeta({ harness: loop.harnessSlug, ownerId });
          // `readFailed` is NOT "no rows" — a failed read must render silence
          // rather than a manufactured all-clear.
          if (!meta.readFailed && meta.note) {
            for (const row of carryNote.splitCarryNoteChecks(meta.note).checks) {
              const contested = Boolean(row.contested);
              if (row.verified && !contested) continue;
              const claim = (row.claim ?? '').trim();
              if (!claim) continue;
              const recheck = row.recheck?.trim();
              out.push({
                id: carryNote.carryRowKey(row),
                claim,
                ...(recheck ? { recheck } : {}),
                pointer: 'loop:status',
                kind: 'check',
                ...(contested ? { contested: true } : {}),
              });
            }
          }
        }
      } catch {
        // Fail-soft by design: say less, never throw into the turn.
      }
      // HALF 2 — open external blockers on items this owner HOLDS. Deliberately
      // NOT keyed on `status='blocked'`: `work_items:set_blocker` records an
      // active blocker without necessarily parking the item, so keying on the
      // status would miss exactly the rows that are still nominally in progress
      // while actually waiting on something external.
      try {
        const [{ getOrgPg }, { resolveConcreteWorkspaceId }, { activeExternalBlockers }, { ALL_TERMINAL_STATUSES }] =
          await Promise.all([
            import('@papercusp/db-org'),
            import('./workspace-registry'),
            import('./external-blockers'),
            import('./work-item-blocking'),
          ]);
        const { sql } = getOrgPg();
        const ws = resolveConcreteWorkspaceId(workspaceId);
        const terminal = [...ALL_TERMINAL_STATUSES];
        const rows = await sql<
          Array<{ feature_id: string; harness_slug: string | null; payload: unknown }>
        >`
          SELECT feature_id, harness_slug, payload
            FROM harness_shared.work_items
           WHERE workspace_id = ${ws}
             AND taken_by = ${ownerId}
             AND NOT (status = ANY(${terminal}::text[]))
           ORDER BY updated_ts DESC NULLS LAST
           LIMIT ${OPEN_CHECKS_BLOCKER_SCAN_LIMIT}`;
        for (const row of rows) {
          for (const blocker of activeExternalBlockers(row.payload)) {
            const summary = blocker.summary.trim();
            if (!summary) continue;
            const nextVerb = blocker.nextVerb?.trim();
            out.push({
              // Blocker refs are unique only WITHIN an item, so the identity is
              // item-qualified; otherwise two items waiting on the same gate
              // would collapse into one row and one of them would go unseen.
              id: `blocker:${row.feature_id}:${blocker.ref}`,
              claim: summary,
              ...(nextVerb ? { recheck: nextVerb } : {}),
              pointer: `work_items:get ${row.feature_id}`,
              kind: 'blocker',
            });
          }
        }
      } catch {
        // Fail-soft, independently of HALF 1.
      }
      return out.slice(0, OPEN_CHECKS_MAX_ROWS);
    },
    // The SAME primitive fleet:assignments / leader-brief count with, so this
    // number can never disagree with the one a leader sees.
    inbox: async (ownerId) => {
      const { fetchUnansweredDirected } = await import('./agent-tools/coordination/unanswered-directed');
      const map = await fetchUnansweredDirected([ownerId]);
      const summary = map.get(ownerId);
      return summary
        ? {
            count: summary.count,
            staleCount: summary.staleCount,
            newest: summary.newest.map((entry) => ({
              msgId: entry.msgId,
              from: entry.from,
              ...(entry.summary ? { summary: entry.summary } : {}),
            })),
          }
        : { count: 0, staleCount: 0, newest: [] };
    },
    // WI-2142142: the sender-side mirror of `inbox` above, from the SAME
    // module (unanswered-directed.ts) so the two definitions of "answered"
    // cannot drift apart.
    openAsks: async (ownerId) => {
      const { fetchOpenAsks } = await import('./agent-tools/coordination/unanswered-directed');
      const map = await fetchOpenAsks([ownerId]);
      const summary = map.get(ownerId);
      return summary && summary.count > 0
        ? { count: summary.count, oldestAgeMs: summary.oldestAgeMs, oldestTo: summary.oldestTo }
        : null;
    },
    // D-004 keeps event discovery a directory. Reuse the SAME announcement
    // store + visibility predicate as coord:orient/events:catalog, deriving the
    // caller scope from its durable brief and live fleet label. Never copy gate
    // keys into a hand-maintained table.
    announcedGates: async (ownerId, workspaceId) => {
      const [
        { listActiveAnnouncements, countActiveAwaitsByPrefixes },
        { selectVisibleAnnouncements },
        { getSessionBrief },
        { fetchPresenceFleet },
        { resolveAnnouncementOwnership },
        timeout,
      ] =
        await Promise.all([
          import('./events/await/store'),
          import('./events/await/announced-gate-view'),
          import('./session-brief'),
          import('./agent-tools/coordination/presence-fleet'),
          import('./agent-tools/events/status'),
          import('./bounded-timeout'),
        ]);
      // The scope is not known until the brief and fleet membership resolve, so
      // the announcement read stays CONCURRENT with them and the scoping is
      // applied after. P-027 / D-063: the scoping itself is the shared unit
      // (`selectVisibleAnnouncements`), used by the leader-brief sink too, so
      // the two sinks cannot drift on what a reader may see. `unfiredOnly: true`
      // is this sink's own choice — a fired gate is not something to await, and
      // an always-present row is the signal decay P-017/D-003 ruled against.
      const [announcements, brief, memberships] = await Promise.all([
        listActiveAnnouncements({ unfiredOnly: true, limit: 50 }),
        getSessionBrief({ ownerId }),
        fetchPresenceFleet([ownerId]),
      ]);
      const fleet = memberships.get(ownerId)?.fleetSlug ?? null;
      const visible = selectVisibleAnnouncements(announcements, {
        fleetSlug: fleet,
        planSlug: brief?.currentPlanSlug ?? null,
        harnessSlug: brief?.harnessSlug ?? null,
      });
      // Metadata is advisory and independently bounded. A failure omits only
      // the affected optional fields; it must not erase the gate directory.
      const [countsResult, ownershipResult] = await Promise.all([
        timeout.withBoundedTimeout(countActiveAwaitsByPrefixes(visible.map((announcement) => announcement.eventKey)), {
          fallback: null as Map<string, number> | null,
          timeoutMs: 1_000,
          label: 'turn-start:announcedGateAwaiters',
        }),
        timeout.withBoundedTimeout(resolveAnnouncementOwnership(visible, workspaceId), {
          fallback: null as Map<number, { liveSuccessorIds: string[]; staleOwner: boolean }> | null,
          timeoutMs: 1_000,
          label: 'turn-start:announcedGateOwnership',
        }),
      ]);
      const counts = countsResult.value;
      const ownership = ownershipResult.value;
      return visible
        .filter((announcement) =>
          Boolean(announcement.eventKey),
        )
        .map((announcement) => ({
          event: announcement.eventKey,
          logical_gate: announcement.logicalGateKey ?? null,
          note: announcement.note,
          ...(counts ? { live_awaiters: counts.get(announcement.eventKey) ?? 0 } : {}),
          ...(ownership?.get(announcement.id)?.liveSuccessorIds.length
            ? { live_successor_ids: ownership.get(announcement.id)!.liveSuccessorIds }
            : {}),
          ...(ownership?.get(announcement.id)?.staleOwner ? { stale_owner: true } : {}),
          ...(buildAnnouncedGateWarning({
            event: announcement.eventKey,
            logical_gate: announcement.logicalGateKey ?? null,
            scope: announcement.scopeKind ? `${announcement.scopeKind}${announcement.scopeRef ? ':' + announcement.scopeRef : ''}` : 'global',
            announcedBy: announcement.subscriberId,
            stale_owner: ownership?.get(announcement.id)?.staleOwner,
          })
            ? {
                warning: buildAnnouncedGateWarning({
                  event: announcement.eventKey,
                  logical_gate: announcement.logicalGateKey ?? null,
                  scope: announcement.scopeKind ? `${announcement.scopeKind}${announcement.scopeRef ? ':' + announcement.scopeRef : ''}` : 'global',
                  announcedBy: announcement.subscriberId,
                  stale_owner: ownership?.get(announcement.id)?.staleOwner,
                }),
              }
            : {}),
        }));
    },
    // P-012: reuse the mode store's own reader rather than re-querying
    // agent_modes here — the registry is already the single source for posture,
    // and a second query would be a second truth to keep in step.
    modes: async (ownerId, workspaceId) => {
      const { getModes } = await import('./modes/store');
      const rows = await getModes(workspaceId, ownerId);
      return rows.map((row) => ({
        axisKey: row.axisKey,
        mode: row.mode,
        reason: row.reason,
        setBy: row.setBy,
        // Resolved HERE because render has no identity (see OrientationModeState).
        setBySelf: row.setBy === ownerId,
        ownerDirected: row.ownerDirected,
        impliedBy: row.impliedBy?.mode ?? null,
      }));
    },
    // P-013: REUSE, not a second truth. `buildControlAnchorState` already
    // assembles this owner's modes + route + scope + loop from the authoritative
    // stores, and `buildInstructionPrecedenceTrace` is PURE given that state — it
    // costs one function call and no IO of its own. `adv-agent-orders.ts` already
    // performs exactly this pairing for the HUD Orders rail; this is the same
    // composition at a second sink, so the two surfaces cannot disagree about
    // what the agent's authority is.
    authorityVerdict: async (ownerId, workspaceId) => {
      const [{ buildControlAnchorState }, { buildInstructionPrecedenceTrace }] = await Promise.all([
        import('./agent-tools/coordination/control-anchor'),
        import('./instruction-lint'),
      ]);
      const control = await buildControlAnchorState(ownerId, workspaceId);
      const trace = buildInstructionPrecedenceTrace({
        // The trace's `source` is a closed union of the surfaces that build one.
        // We derive ours from the control-anchor state, so we declare it honestly
        // rather than widening the union for one more reader.
        source: 'control-anchor',
        ownerId,
        modes: control.modes,
        route: control.route,
        scope: control.scope,
        loop: control.loop,
      });
      const byKey = new Map(trace.decisions.map((decision) => [decision.key, decision]));
      // `conflict` is a VALUE, never an omission: an unreadable mode registry
      // resolves execution-authorization to a conflict, and that is the single
      // most action-worthy state this class has. A decision genuinely absent
      // from the trace yields '' — say nothing about it rather than assert one.
      const valueOf = (key: string): string => {
        const decision = byKey.get(key);
        if (!decision) return '';
        return decision.status === 'conflict' ? 'conflict' : (decision.effective?.value ?? 'conflict');
      };
      return {
        executionAuthorization: valueOf('execution-authorization'),
        mission: valueOf('mission'),
        ideation: valueOf('ideation'),
      };
    },
    loopArmed: async (ownerId) => {
      const { activeLoopOwners } = await import('./adv-roster');
      return (await activeLoopOwners()).has(ownerId);
    },
    loopFireWithheld: async (ownerId) => {
      const { getLoopStatus } = await import('./harness/routines/loop');
      return isLoopFireWithheld(await getLoopStatus(ownerId));
    },
    // P-013: filing already works; consumption did not. Reuse the exact bounded
    // triage window, policy split, and ONE human-queue ranker rather than adding
    // a second queue or reviving the paused scheduled routine. Duplicate
    // clustering is deliberately skipped: this per-turn consumer needs only the
    // ranked top row, and the fold's 2.5s wall makes unused O(n²) work a defect.
    improvementTriage: async (workspaceId) => {
      const [read, digestModule, grant, ranker, triageCore] = await Promise.all([
        import('./harness/improvements/read-items'),
        import('./harness/improvements/digest'),
        import('./harness/improvements/full-autonomy-grant'),
        import('./queue-ranker/human-queue'),
        import('./harness/improvements/triage-core'),
      ]);
      const [items, ownerFullAutonomy] = await Promise.all([
        read.readImprovementItems({ state: 'open', limit: IMPROVEMENT_TRIAGE_WINDOW_LIMIT }),
        grant.readOwnerFullAutonomyGrant(workspaceId),
      ]);
      const digest = await ranker.applyHumanQueueRanking(
        digestModule.buildDigest(items, {
          nowMs: Date.now(),
          ownerFullAutonomy,
          nearDuplicates: false,
        }),
        { candidates: items },
      );

      return selectOrientationImprovementTriage(digest, triageCore.selectUntriaged, {
        considered: items.length,
        // A full window may be the whole corpus or a slice; only a separate
        // count could distinguish them, so report the conservative lower bound.
        lowerBound: items.length === IMPROVEMENT_TRIAGE_WINDOW_LIMIT,
      });
    },
    // P-007 / D-005: reuse P-011's exact-plan + family-complete executable
    // width. This is deliberately bounded well inside the hook's 2.5s wall;
    // a slow graph/lane read is silence, not a delayed turn and not zero.
    executableFrontier: async (ownerId, workspaceId) => {
      const [frontier, timeout] = await Promise.all([
        import('./fleet/executable-frontier'),
        import('./bounded-timeout'),
      ]);
      const { value } = await timeout.withBoundedTimeout(
        frontier.readFleetExecutableFrontier({ ownerId, workspaceId }),
        {
          fallback: null as OrientationExecutableFrontier | null,
          timeoutMs: 900,
          label: 'turn-start executable frontier',
        },
      );
      return value ? { planSlug: value.planSlug, executableWidth: value.executableWidth } : null;
    },
    obligations: async (ownerId, workspaceId) => {
      const { readAgentObligationAgenda, projectAgentTurnStartObligationBrief, PLAN_CONTEXT_MAX } = await import(
        './agent-obligation-reader'
      );
      const { agenda, observedAt, portfolio, goalId } = await readAgentObligationAgenda({ workspaceId, ownerId });
      // Record new verified member effects and recover durable completed-turn
      // receipts. Reads and heartbeats cannot advance the effect clock; the
      // read-only agenda consumes persisted progress on subsequent reads.
      if (goalId && portfolio) {
        void trackDetached(import('./goal-placement-progress-store').then((module) =>
          module.reconcileGoalPlacementProgress({ workspaceId, ownerId, goalId,
            portfolio: { ...portfolio, worklist: portfolio.worklist.slice(0, PLAN_CONTEXT_MAX) } }))).catch(() => {});
      }
      // R-4 / D-032: a goal running the 'baseline' or 'brief-only' experiment
      // arm withholds the per-turn agenda AND its reminder projection. The
      // effect clock above keeps running in every arm — it is measurement, not
      // a reminder — so the arms stay comparable on the same instrument.
      if (goalId) {
        const { goalWithholdsTurnStartReminders } = await import('./goal-launch-settings');
        if (await goalWithholdsTurnStartReminders(goalId)) return { withheldBy: 'experiment-arm' };
      }
      // P-005: project the SAME evaluated agenda onto the existing durable await
      // plane. Reconciliation is fail-soft internally, so an unavailable optional
      // reminder can never suppress the load-bearing guidance rendered below.
      const { reconcileAgentObligationReminders } = await import('./agent-obligation-reminders');
      await reconcileAgentObligationReminders({ ownerId, agenda, now: new Date(observedAt) });
      if (agenda.primary.length === 0) return null;
      return projectAgentTurnStartObligationBrief(agenda);
    },
    // P-023 / D-008. The memory ledger's own epoch reader, reused rather than
    // re-derived: `currentSessionEpoch` is already best-effort by contract
    // (0 on a missing relation or a failed read, cached process-wide), and 0
    // is exactly the right degradation here — a generation that never moves
    // reproduces the pre-P-023 dedup rather than emitting on every turn.
    //
    // ⚠ The ledger is keyed by `session_id`, and the turn-start memory port
    // already passes the OWNER id as that key (`session: { sessionId: owner }`).
    // Passing the same value here is what makes the two folds share one
    // generation; a different key would silently give each its own.
    // EI-21308269358666878. DERIVED from two EXISTING ledgers — no new record, and
    // deliberately so: a server-side "we served tools/list" row would measure the
    // SERVER'S INTENT to serve, and goes blind in exactly the failure it is meant to
    // catch (the operator answers, the response dies in the proxy). Counting what
    // the CLIENT observably completed cannot be fooled that way.
    //
    // ⚠⚠ FILTER NEITHER harness_slug NOR workspace_id. Both legitimately hold the
    // literal '*' for workspace-global tools (coord:*, work_items:*) — 11k+ and 1k+
    // rows respectively in a 6h window — so scoping either DROPS most agent calls
    // and MANUFACTURES toolless-looking sessions. Measured, not theoretical: a
    // harness-scoped draft of this query flagged three healthy agents that had 379,
    // 432 and 331 agent calls. Only coord_owner_id + invoked_at + call_origin belong
    // in it. The same trap has a sibling — grouping by (owner, role) instead of
    // owner splits an owner's calls across role-slices and fakes a zero.
    //
    // The epoch row IS the guard, not just the window: no row ⇒ no anchor ⇒ no
    // verdict. That is what keeps a re-identified process (a carry-respawn whose
    // agent calls moved to a NEW ownerId while hook beats kept landing on the old
    // one) from reading as permanently toolless.
    toolSurface: async (ownerId) => {
      const [{ getOrgPg }, timeout] = await Promise.all([import('@papercusp/db-org'), import('./bounded-timeout')]);
      const { sql } = getOrgPg();
      const read = async (): Promise<OrientationToolSurface | null> => {
        const row = (await readOrientationToolSurfaces(sql, [ownerId]))[0];
        return row ? { hookCalls: row.hookCalls, windowMinutes: row.windowMinutes } : null;
      };
      const { value } = await timeout.withBoundedTimeout(read(), {
        fallback: null as OrientationToolSurface | null,
        timeoutMs: 700,
        label: 'turn-start tool surface',
      });
      return value;
    },
    // EI-21442716425230784. Both endpoints of the window are ALREADY recorded —
    // the carry snapshot is the caller's own session:request-compaction row, the
    // cut is the per-owner host event log's verdict — so this reader adds no
    // write at the boundary and no new state anywhere.
    carryBlindWindow: async (ownerId, workspaceId) => {
      const { readCarryBlindWindow } = await import('./carry-blind-window');
      return await readCarryBlindWindow(ownerId, { workspaceId });
    },
    contextEpoch: async (ownerId) => {
      const [{ currentSessionEpoch }, { getOrgPg }] = await Promise.all([
        import('./memory/session-epoch-ledger'),
        import('@papercusp/db-org'),
      ]);
      const { sql } = getOrgPg();
      return await currentSessionEpoch(sql, ownerId);
    },
    contextTokens: async (ownerId) => {
      const { readContextTokens } = await import('./agent-tools/coordination/context-pressure');
      return await readContextTokens(ownerId);
    },
  };
}

export const TURN_START_IDENTITY_DELIVERY_KEY = 'identityComponentDeliveryV1';

type SuAssignmentPresence = Pick<
  import('./agent-tools/coordination/presence').PresenceRecord,
  'ownerId' | 'workspaceId' | 'intent' | 'currentPlanSlug' | 'stale'
>;

/** Bind only values the existing turn-start producers already computed. This
 * candidate rides the existing proof cursor; the next confirmed token promotes
 * it with the same ACK that proves the block was printed. */
export async function bindTurnStartIdentityOutputs(input: {
  ownerId: string;
  workspaceId: string;
  state: OrientationState;
  committed: CursorState | null;
  epoch: number;
  contextTokens: number | null;
  block: string;
  deliveryToken: string | null;
}, binder?: typeof import('./agent-identities/source').bindSelectedIdentityOutputs,
  assignmentReader?: (ownerId: string) => Promise<SuAssignmentPresence | null>) {
  const bind = binder ?? (await import('./agent-identities/source')).bindSelectedIdentityOutputs;
  const readAssignment = assignmentReader ?? (async (ownerId: string) =>
    (await import('./agent-tools/coordination/presence')).getPresence(ownerId));
  const observedAt = new Date().toISOString();
  const failure = (identityId: string, errorRef: string, error: unknown) => ({
    identityId, status: 'unavailable', errorRef,
    detail: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200),
  });
  const practicePromise = bind({
    identityId: 'su.practice', sourceTier: 'builtin',
    outputs: [{ contributionId: 'turn-start-orientation', value: input.block }],
    scope: { workspace: input.workspaceId, ownerId: input.ownerId, sink: 'turn-start' },
    observedAt,
  }).catch((error) => failure('su.practice', 'turn-start:practice-binding-failed', error));
  const rootPromise = input.state.modes === null
    ? Promise.resolve({ identityId: 'su', status: 'unavailable',
        errorRef: 'turn-start:mode-state-unavailable' })
    : Promise.resolve().then(async () => {
        const presence = await readAssignment(input.ownerId);
        if (!presence || presence.stale || presence.ownerId !== input.ownerId ||
          presence.workspaceId !== input.workspaceId) {
          throw new Error('current assignment presence is absent, stale or mismatched');
        }
        return bind({
          identityId: 'su', sourceTier: 'builtin',
          outputs: [
            { contributionId: 'turn-start-orientation', value: input.block },
            { contributionId: 'current-mode-state', value: input.state.modes },
            { contributionId: 'current-assignment', value: {
              ownerId: presence.ownerId, intent: presence.intent,
              currentPlanSlug: presence.currentPlanSlug,
            } },
          ],
          scope: { workspace: input.workspaceId, ownerId: input.ownerId, sink: 'turn-start' },
          observedAt,
        });
      }).catch((error) => failure('su', 'turn-start:root-binding-failed', error));
  const goalMode = input.state.modes?.some((mode) => mode.mode === 'goal');
  const obligation = deliveredObligationProjection(
    input.state, input.committed, input.epoch, input.block, input.contextTokens,
  );
  const goalPromise = input.state.modes === null
    ? Promise.resolve({ identityId: 'su.mode-goal', status: 'unavailable',
        errorRef: 'turn-start:mode-state-unavailable' })
    : goalMode
      ? bind({
          identityId: 'su.mode-goal', sourceTier: 'selected',
          outputs: [
            { contributionId: 'current-mode-state', value: input.state.modes },
            { contributionId: 'goal-kickoff', omission: { reason: 'not-requested' } },
            { contributionId: 'goal-portfolio', omission: { reason: 'not-requested' } },
            obligation.delivered && obligation.text
              ? { contributionId: 'goal-obligations', value: obligation.text }
              : { contributionId: 'goal-obligations', omission: input.state.obligationsWithheldBy
                  ? { reason: input.state.obligationsWithheldBy }
                  : input.state.obligations
                    ? { reason: 'unavailable', errorRef: 'turn-start:obligation-budget-trimmed' }
                    : { reason: 'ineligible' } },
          ],
          scope: { workspace: input.workspaceId, ownerId: input.ownerId, sink: 'turn-start' },
          observedAt,
        }).catch((error) => failure('su.mode-goal', 'turn-start:goal-binding-failed', error))
      : Promise.resolve(null);
  const [root, practice, goal] = await Promise.all([rootPromise, practicePromise, goalPromise]);
  return { version: 1, offeredAt: observedAt, token: input.deliveryToken,
    proofMode: input.deliveryToken ? 'token' : 'arrival', root, practice, goal };
}

/** What one turn-start orientation call delivered. */
export interface TurnStartOrientationDelivery {
  /** The rendered block; '' on every failure and every silence case. */
  block: string;
  /**
   * Set only when the caller asked for ACK-ON-PROOF and `block` was staged: the
   * caller echoes it back as `confirmedDeliveryToken` once it has emitted `block`.
   */
  deliveryToken: string | null;
}

const NO_ORIENTATION: TurnStartOrientationDelivery = { block: '', deliveryToken: null };

/**
 * The endpoint entry point: resolve, diff against the server-side cursor, render.
 * Returns an empty block on every failure and every silence case, so the caller can
 * splice it unconditionally into its section list.
 *
 * The cursor is advanced with the SPLIT-PHASE pair rather than the fused
 * `ackAndAdvance` for the same reason `coord:inbox` needs it — but note the phases
 * are cheap here, so the ordering is what matters: `stage` runs only AFTER a
 * non-empty block has actually been composed, so a turn that emits nothing does not
 * move the floor, and a turn that dies before injection re-emits next time.
 *
 * `confirmedDeliveryToken` opts into ACK-ON-PROOF (read-cursors.ts; P-005 of
 * owner-directive-delivery-redesign-2026-09-22). Omitted, the call's arrival acks
 * the previous block. Passed (a string, or null when the caller can prove nothing),
 * the previous block is acked only if the caller confirms the token it was staged
 * under, so a hook killed between the server staging and the client printing gets
 * the block again instead of losing it.
 */
export async function buildTurnStartOrientationBlock(input: {
  ownerId: string;
  workspaceId: string;
  budgetChars?: number;
  confirmedDeliveryToken?: string | null;
  deps?: Partial<OrientationDeps>;
  /** Test seam only; production always uses the receipt module's real writers. */
  progressReceiptDeps?: GoalPlacementTurnReceiptDeps;
  /** Test seam only; production uses the selected identity compiler. */
  identityBinder?: typeof import('./agent-identities/source').bindSelectedIdentityOutputs;
  /** Test seam only; production reads the caller's authoritative presence row. */
  identityAssignmentReader?: (ownerId: string) => Promise<SuAssignmentPresence | null>;
}): Promise<TurnStartOrientationDelivery> {
  try {
    const { ownerId, workspaceId } = input;
    if (!ownerId) return NO_ORIENTATION;
    const proof = input.confirmedDeliveryToken !== undefined;
    // The epoch read joins the SAME Promise.all as the state read — it is one
    // indexed single-row lookup, but the 2.5s wall makes "one more await" a real
    // cost, and serializing it behind the state resolve would spend that wall for
    // nothing. Independently `.catch()`ed to 0 for the same reason every other
    // source is: a broken generation read must degrade the dedup to its old
    // behaviour, never fail the block or the turn.
    const { contextEpoch: epochDep, contextTokens: tokensDep } = { ...defaultOrientationDeps(), ...(input.deps ?? {}) };
    const [{ ackAndRead, stage }, state, epoch, contextTokens, progressReceipts] = await Promise.all([
      import('./agent-tools/coordination/read-cursors'),
      resolveOrientationState(ownerId, workspaceId, input.deps ?? {}),
      epochDep(ownerId).catch(() => 0),
      // P-006 reminder cadence; same fail-soft as the epoch: unknown ⇒ null,
      // which falls back to a wall-clock cadence rather than failing the block.
      tokensDep ? tokensDep(ownerId).catch(() => null) : Promise.resolve(null),
      proof ? import('./goal-placement-turn-receipts') : Promise.resolve(null),
    ]);
    if (isEmptyOrientation(state) && !proof) return NO_ORIENTATION;
    const ack = await ackAndRead(
      ownerId,
      ORIENTATION_CURSOR_SURFACE,
      proof ? { confirmedToken: input.confirmedDeliveryToken ?? null } : undefined,
    ).catch(() => null);
    // A completed plan can leave no new orientation rows. Still settle its
    // previously emitted receipt; an empty next block must not erase evidence.
    if (progressReceipts && ack?.committed?.[progressReceipts.GOAL_PLACEMENT_DELIVERY_KEY]) {
      void trackDetached(progressReceipts.confirmGoalPlacementDelivery({
        ownerId, workspaceId, confirmedToken: input.confirmedDeliveryToken,
        candidate: ack.committed[progressReceipts.GOAL_PLACEMENT_DELIVERY_KEY],
        brief: state.obligations,
      }, input.progressReceiptDeps)).catch(() => {});
    }
    if (isEmptyOrientation(state)) return NO_ORIENTATION;
    const composed = composeOrientationBlockWithRows({
      state,
      // A failed cursor read ⇒ treat as baseline and DELIVER. Fail-open: a delta
      // must never make orientation worse than no delta.
      committed: ack?.committed ?? null,
      epoch,
      contextTokens,
      ...(input.budgetChars === undefined ? {} : { budgetChars: input.budgetChars }),
    });
    const block = composed.block;
    // P-020 REACH + ACTION. Fire-and-forget, and deliberately NOT awaited into
    // the return path: a telemetry write must never be able to cost an agent
    // its orientation. Recorded on EVERY turn that composed, including a silent
    // one — a turn where nothing was delivered is exactly the evidence that a
    // class's reach is lower than its projection suggests.
    void (async () => {
      const [{ recordOrientationTurn, selectObligationTelemetry }, { getOrgPg }] = await Promise.all([
        import('./orientation-telemetry'),
        import('@papercusp/db-org'),
      ]);
      const renderedRowsByClass = new Map<string, number>();
      for (const row of composed.rows) {
        renderedRowsByClass.set(row.classId, (renderedRowsByClass.get(row.classId) ?? 0) + 1);
      }
      const { rows: obligationRows, evaluatedClasses } = selectObligationTelemetry(state);
      await recordOrientationTurn(getOrgPg().sql, {
        workspaceId,
        ownerId,
        sink: 'turn-start',
        renderedRowsByClass,
        obligationRows,
        evaluatedClasses,
      });
    })().catch(() => {});
    if (!block) return NO_ORIENTATION;
    // Staged with the SAME epoch the block was composed against — never a
    // re-read. A second read here could land after a boundary and commit a
    // generation the agent was never actually told about, which would
    // reproduce the exact stale suppression this change removes.
    const deliveryToken = proof ? randomUUID() : undefined;
    const deliveredFingerprint = fingerprintDeliveredOrientation(state, epoch, ack?.committed ?? null, block, contextTokens);
    const identityToken = deliveryToken ?? randomUUID();
    const pendingIdentity = {
      version: 1, token: identityToken, deliveryToken: deliveryToken ?? null,
      status: 'pending', offeredAt: new Date().toISOString(),
      outputRevision: createHash('sha256').update(block).digest('hex'),
    };
    deliveredFingerprint[TURN_START_IDENTITY_DELIVERY_KEY] = pendingIdentity;
    if (progressReceipts && deliveryToken) {
      const rows = progressReceipts.deliveredGoalPlacementRows({ ownerId, workspaceId, brief: state.obligations, block });
      if (rows.length) {
        const measured = await withBoundedTimeout(
          progressReceipts.prepareGoalPlacementDelivery({ ownerId, workspaceId, token: deliveryToken,
            brief: state.obligations, block }, input.progressReceiptDeps),
          { fallback: null, timeoutMs: 250, label: 'goal-placement-delivery-baseline' },
        );
        deliveredFingerprint[progressReceipts.GOAL_PLACEMENT_DELIVERY_KEY] = measured.value ?? {
          version: 1, unavailable: true, rows,
          reason: measured.reason ?? 'native-baseline-unavailable',
        };
      }
    }
    const staged = await stage(
      ownerId,
      ORIENTATION_CURSOR_SURFACE,
      deliveredFingerprint,
      deliveryToken ? { deliveryToken } : {},
    ).then(
      () => true,
      () => false,
    );
    if (staged) {
      // Optional provenance must never consume the hook's 2.5s response wall.
      // The token-guarded update works whether native proof has already moved
      // this candidate from pending to committed or it is still pending.
      void trackDetached((async () => {
        const measured = await withBoundedTimeout<Awaited<ReturnType<typeof bindTurnStartIdentityOutputs>> | null>(
          bindTurnStartIdentityOutputs({
            ownerId, workspaceId, state, committed: ack?.committed ?? null, epoch, contextTokens,
            block, deliveryToken: deliveryToken ?? null,
          }, input.identityBinder, input.identityAssignmentReader),
          { fallback: null, timeoutMs: 5_000, label: 'turn-start:identity-bind-background' },
        );
        const unavailable = (part: unknown) => !!part && typeof part === 'object' &&
          (part as { status?: unknown }).status === 'unavailable';
        const receipt = measured.value
          ? { ...measured.value, token: identityToken, deliveryToken: deliveryToken ?? null,
              outputRevision: pendingIdentity.outputRevision,
              status: unavailable(measured.value.practice) && unavailable(measured.value.root)
                ? 'unavailable'
                : unavailable(measured.value.root) || unavailable(measured.value.practice) ||
                    unavailable(measured.value.goal) ? 'partial' : 'bound' }
          : { ...pendingIdentity, status: 'unavailable', reason: measured.reason ?? 'binding-unavailable' };
        const { annotateReadCursorByToken } = await import('./agent-tools/coordination/read-cursors');
        await annotateReadCursorByToken(
          ownerId, ORIENTATION_CURSOR_SURFACE, TURN_START_IDENTITY_DELIVERY_KEY, identityToken, receipt,
        );
      })()).catch(() => {});
    }
    // A token whose stage failed names no pending, so confirming it could never
    // promote anything; reporting none keeps the caller's ledger honest.
    return { block, deliveryToken: staged && deliveryToken ? deliveryToken : null };
  } catch {
    // Fail-soft by contract — the endpoint must never surface an error into a turn.
    return NO_ORIENTATION;
  }
}
