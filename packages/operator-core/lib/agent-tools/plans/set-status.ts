/**
 * plans:set-status — flip one OR many items' stored status token.
 *
 * Per agent-plan-tracking-2026-05-20.md §4.2.
 *
 * Surgical line edit: find the item line by its P-NNN id, swap the
 * backticked status token. Whitespace, item text, blocked-by, and
 * decision refs are preserved verbatim.
 *
 * Writes inside a lock. Auto-bumps frontmatter updated:.
 *
 * Bulk by default (the house keyed-array contract, bulk-endpoint-standardization-
 * 2026-06-21): single { slug, itemId, status }, many of one plan to one status
 * { slug, itemIds:[…], status }, or heterogeneous items:[{ slug, itemId, status, …
 * }] → { ok, results:[{ ok, slug, itemId, oldStatus, newStatus, … | error }],
 * counts }. Correlate by { slug, itemId } not array position; a per-item
 * claim_conflict (or any failure) never fails the rest — top-level ok = "the batch
 * ran", counts.failed is the truth. Each result embeds what the single call returned
 * (claim, claimReleased, assignmentReleased, noteTruncated, …). The wip auto-claim,
 * auto-convert, needs-human push, and terminal-grip release run PER ITEM.
 */

import { z } from 'zod';
import { defineTool, AGENT_ROLES, HarnessRequiredError, type UnifiedToolContext } from '@papercusp/agent-mcp';
import type { RefusalContract } from '../../capability-envelope/refusal-contract-types';
import { resolveCtxHarnessSlug } from './_ctx-opts';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { withPlanLock, bumpUpdatedDate } from './with-plan-lock';
import {
  findTerminalPlanChildMutations,
  ITEM_STATUSES,
  maskFences,
  parsePlan,
  NOTE_SUFFIX_RE,
  type Importance,
  type TerminalPlanChildMutation,
} from './parser';
import { emitPlanEventForCaller } from '../coordination/plan-events';
import { emitPlanItemDoneEvent } from './plan-item-events';
import { isPlanDrained, emitFleetDrainedForPlan } from '../../fleet-drained-events';
import { planRevisionCapture, type PlanRevisionCtx } from './revisions';
import { resolveAgentIdentity, isEphemeralMcpCallIdentity, type AgentIdentity } from '../coordination/identity';
import { resolvePlanScope } from './source';
import { recoverHarnessFromSlugs, requireUnambiguousSlugScope, slugScopeErrorResult } from './slug-scope';
import { claimForWork, releaseOwnClaim } from '../../plan-items/claim-discipline';
import { getClaim } from '../../plan-items/claims';
import { autoConvertClaimIntent } from '../../plan-items/claim-holder';
import {
  convertPlanItem,
  findConvertedWorkItemByStamp,
  findCoverageWorkItems,
  looksLikeResidualClosure,
  TERMINAL_WORK_ITEM_STATES,
} from '../../plan-items/convert';
import {
  findAllLinkedWorkItems,
  reconcileLinkedWorkItemsForPlanItem,
  resyncDependentPlanItemLanesNow,
  resyncPlanItemLaneNow,
  type ReconcileLinkedWorkItemsResult,
} from '../../plan-items/reconcile-linked-work-items';
import { RECONCILER_SYSTEM_ACTOR } from '../../completion-audit';
import { setWorkItemState } from '../../work-items';
import { unassignItem } from '../../plan-items/assignments';
import { bestEffortOwnerUser, resolveAdoptedName } from '../../plan-items/agent-names';
import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';
import { runBulk, bulkContent, type BulkItemResult } from '../_bulk';
import { holderContextReader, resolveHolderAdvisory } from '../coordination/holder-advisory';
// ⚠ THE CANONICAL MINTER, not a `${slug}#${item}` literal. `competing` is built by
// THIS function (agent-goal-ref.ts), so using it here is what makes the two sides
// of D-094's subtraction structurally unable to disagree — see the call sites below.
import { planItemRef } from '../../agent-goal-ref';
import { softText } from '../limits';
import {
  CompletionVerificationEvidenceSchema,
  type CompletionVerificationEvidence,
} from '../../coord-lifecycle/records';
import { typeEvidenceGapInCompletion } from '../type-evidence-gap';
import { ensureAcceptanceDrainCarryInTransaction } from './acceptance-drain-filing';
import { planDrainTransitionMutation } from './plan-drain-transition';
import { reevaluateBarReadinessOnScopeWrite, type BarReadinessResult } from './plan-scope-cascade';
import { defaultBarReadinessDeps } from './plan-scope-cascade-deps';
import { attestLandedPlanItemStatus } from './plan-item-consumer-view';
import { planItemConsumerReaderFor } from './plan-item-consumer-read';

// Most-permissive (owner directive 2026-06-25): open to every role; the capability envelope is the
// real backstop. Was [...SU_ROLES, 'bee'].
const SU_BEE_ROLES = [...AGENT_ROLES] as const;

const STATUS = z.enum([...ITEM_STATUSES] as [string, ...string[]]);
const TYPE_EVIDENCE = CompletionVerificationEvidenceSchema.pick({
  filesChanged: true,
  testsRun: true,
  testResult: true,
  verifiedHow: true,
  addedTests: true,
}).describe(
  'Verification evidence for a `done` flip. Supply filesChanged + verifiedHow + testsRun/testResult so the response can challenge a unit-only TypeScript close; advisory only.',
);

const NOTE = softText(8000).describe(
  'Optional SHORT comment appended inline to the item line — REQUIRED when status is `dropped` unless a nonblank `rationale` is supplied. REPLACES any note this same tool previously injected on the item (a repeat call to fix a typo overwrites, never stacks; EI-384). Anything beyond ~1000 chars is TRUNCATED inline (with a `…` marker + a noteTruncated flag), never rejected. For a longer explanation of WHY the status changed, use `rationale` instead — it is stored on the plan revision, not spliced into the item line.',
);

const itemSpec = z.object({
  slug: z.string().min(1),
  item: z.string().regex(/^P-\d{3,}$/, 'P-NNN form required'),
  status: STATUS.optional().describe('per-item status (else the batch `status`)'),
  note: NOTE.optional(),
  harness: harnessArg.describe('per-item harness (else the batch `harness` default)'),
  rationale: z
    .string()
    .optional()
    .describe(
      'per-item revision rationale (else the batch `rationale`); satisfies the required reason for status `dropped`',
    ),
  onlyIfNotTerminal: z.boolean().optional(),
  onlyIfNotBlocked: z.boolean().optional(),
  onlyIfNoOtherOpenCoverage: z.boolean().optional(),
  onlyIfNoOtherInFlightCoverage: z.boolean().optional(),
  onlyIfNotCompleted: z.boolean().optional(),
  onlyIfBlockAttributedTo: z.string().min(1).optional(),
  expectedStatus: STATUS.optional(),
  verification: TYPE_EVIDENCE.optional(),
});

const argsSchema = z
  .object({
    harness: harnessArg,
    slug: z.string().min(1).optional(),
    item: z
      .string()
      .regex(/^P-\d{3,}$/, 'P-NNN form required')
      .optional(),
    status: STATUS.optional(),
    note: NOTE.optional(),
    itemIds: z
      .array(z.string().regex(/^P-\d{3,}$/, 'P-NNN form required'))
      .min(1)
      .max(200)
      .optional()
      .describe('flip MANY items of the SAME plan `slug` to the same `status` (homogeneous)'),
    items: z
      .array(itemSpec)
      .min(1)
      .max(200)
      .optional()
      .describe('flip many items at once — each { slug, item, status, note?, harness?, rationale? }'),
    rationale: z
      .string()
      .optional()
      .describe(
        'Optional except when status is `dropped`, where either a nonblank `note` or `rationale` is REQUIRED. Supply rationale when the *why* is too long for the inline item note. Stored on the plan revision (D-009).',
      ),
    onlyIfNotTerminal: z
      .boolean()
      .optional()
      .describe(
        'Non-destructive flip: SKIP any item that is already done/dropped instead of moving it off terminal (reported `skipped:"terminal_guard"`, ok:true). For AUTOMATED reflections that must never un-finish shipped work; a human reopening an item deliberately just omits it.',
      ),
    onlyIfNotBlocked: z
      .boolean()
      .optional()
      .describe(
        'Non-destructive flip: SKIP an item already `blocked`/`needs-human` instead of weakening its explicit gate (reported `skipped:"blocked_guard"`, ok:true). For AUTOMATED ownership reflections; a human reopening or completing the gate deliberately omits it.',
      ),
    onlyIfNoOtherOpenCoverage: z
      .boolean()
      .optional()
      .describe(
        'On `done`/`dropped`, skip if another non-terminal work-item covers this plan item via implements, relates, or payload.plan_item. Prevents one sibling from clearing live shared work. No effect on other statuses; automated reflections use this, while deliberate human closure omits it.',
      ),
    onlyIfNoOtherInFlightCoverage: z
      .boolean()
      .optional()
      .describe(
        'Non-destructive TODO flip: SKIP it (reported `skipped:"in_flight_coverage_guard"`, ok:true) if ANOTHER linked work-item is non-terminal and currently assigned. Protects a parent plan lane when releasing one child is only an ownership event; a current assignee is the authoritative in-flight signal. No effect on other statuses. For AUTOMATED release reflections; a human deliberately returning the lane to `todo` omits it.',
      ),
    onlyIfNotCompleted: z
      .boolean()
      .optional()
      .describe(
        'Non-destructive DROP: SKIP a `done` → `dropped` flip (reported `skipped:"completed_guard"`, ok:true) instead of downgrading finished work. Complements `onlyIfNotTerminal`, which by design permits terminal→terminal, and `onlyIfNoOtherOpenCoverage`, which only counts NON-terminal siblings and so cannot see the DONE work-item that actually completed the item (EI-20129670928216719). No effect on any status other than `dropped`. For AUTOMATED reflections; a human deliberately reclassifying finished work as abandoned just omits it.',
      ),
    onlyIfBlockAttributedTo: z
      .string()
      .min(1)
      .optional()
      .describe(
        'ATTRIBUTED CLEAR: the work-item id permitted to LIFT this item\'s block. Use on the →todo flip that mirrors a blocker CLEARING, INSTEAD of `onlyIfNotBlocked` (which would skip every such flip, the item being blocked by construction). Narrower than `onlyIfNotBlocked:false`: the flip proceeds only if the item\'s live injected note attributes the block to THIS work-item (reported `skipped:"block_attribution_guard"`, ok:true otherwise) AND no OTHER linked work-item is still blocked/needs-human (reported `skipped:"blocked_coverage_guard"`). `needs-human` is never cleared by this path at all. So a gate set for any other reason is left standing, and a 1:N lane is not un-blocked by one of its blockers clearing.',
      ),
    expectedStatus: STATUS.optional().describe(
      'Compare-and-set: FAIL (`ok:false, code:"expected_status_mismatch"`) if the item is not on this status when the lock is taken. For applying a RECORDED observation whose `from` may have gone stale; unlike the `onlyIf*` guards this is an error, not a skip.',
    ),
    verification: TYPE_EVIDENCE.optional(),
  })
  .refine(
    (a) =>
      (a.items?.length ?? 0) > 0 ||
      (Boolean(a.slug) && Boolean(a.status) && ((a.itemIds?.length ?? 0) > 0 || Boolean(a.item))),
    {
      message:
        'pass { slug, item, status } for one, { slug, itemIds:[…], status } for many of one plan, or items:[{ slug, item, status }] for heterogeneous',
    },
  );

interface StatusItem {
  slug: string;
  itemId: string;
  status: string;
  note?: string;
  harness?: string;
  rationale?: string;
  /** Skip (don't flip) when the item is ALREADY terminal and this flip is non-terminal —
   *  for automated reflections that must never un-finish shipped work. See the guard
   *  inside the plan lock. */
  onlyIfNotTerminal?: boolean;
  /** Skip (don't flip) when the item is already blocked/needs-human and this
   *  automated reflection would weaken its explicit gate. */
  onlyIfNotBlocked?: boolean;
  /** Skip (don't flip) a →done/→dropped flip when another non-terminal work-item still
   *  covers this plan item — for automated reflections cascading a single work-item's
   *  terminal state (WI-38908 widened this from drop-only). See the coverage guard below. */
  onlyIfNoOtherOpenCoverage?: boolean;
  /** Skip a →todo flip when another linked non-terminal work-item still has a
   * current assignee. Used by the automated release reflection so releasing a
   * child cannot reset a held parent plan lane. */
  onlyIfNoOtherInFlightCoverage?: boolean;
  /** Skip (don't flip) a `done` →`dropped` flip — an automated cascade must never
   *  downgrade finished work. See `completedGuardTrips`. */
  onlyIfNotCompleted?: boolean;
  /** ATTRIBUTED CLEAR (deterministic-plan-state-derivation-2026-08-31 D-001). The
   *  work-item id whose reflection is allowed to lift this item's block. Set on the
   *  →todo flip that mirrors a blocker being CLEARED, in place of `onlyIfNotBlocked`
   *  (which would skip every such flip, since the item is blocked by construction).
   *
   *  Two independent conditions, both required, deliberately NOT collapsible into
   *  `onlyIfNotBlocked:false`:
   *    1. ATTRIBUTION (in-lock, `blockAttributionTrips`) — the item's current injected
   *       note must name THIS work-item as the blocker. Notes replace rather than stack
   *       (EI-384), so the live note is the live attribution: a block recorded for any
   *       other reason (a deliberate gate, another work-item) is left alone.
   *    2. NO OTHER BLOCKING COVERAGE (pre-lock, alongside the other coverage guards) —
   *       no OTHER linked work-item may still be blocked/needs-human, so clearing one
   *       blocker on a 1:N lane cannot un-block an item the rest still gate.
   *
   *  `needs-human` is never auto-cleared by this path regardless: that is the human
   *  band, and only a human takes an item out of it. */
  onlyIfBlockAttributedTo?: string;
  /** COMPARE-AND-SET (bulk-review-report-legibility-and-lifecycle-2026-08-31
   *  P-011). The status the caller believes the item is on RIGHT NOW. Checked
   *  inside the plan lock; a mismatch FAILS the write.
   *
   *  Unlike every `onlyIf*` guard above — which are non-destructive SKIPS for
   *  automated cascades — this one is an ERROR, because its caller is applying
   *  a RECORDED observation. A bulk clean-up run scans, sits in a report for
   *  hours, and is then applied; `from` is what the scanner saw, not what is
   *  there now. Without the precondition the write silently overwrites whatever
   *  the item became in between. */
  expectedStatus?: string;
  /** Structured proof accompanying a direct →done flip. Advisory only. */
  verification?: CompletionVerificationEvidence;
}

/** Result payload — explicit so `withPlanLock`'s `T` is fixed by the
 *  type argument below rather than inferred from a union-returning
 *  mutator (which TS narrows to the first branch, leaving `T` unknown). */
type SetStatusValue =
  | {
      ok: true;
      oldStatus: string | null;
      newStatus: string;
      itemId: string;
      importance: Importance;
      /** WI-1830: computed inside the lock (race-safe) — this →done flip left the plan with
       *  zero open items, so the fleet's lane drained. False for every non-→done flip. */
      drainedPlan: boolean;
      acceptanceCarry?: { outcome: 'created' | 'already-open'; id: string | null };
      /** memory-delivery-unification-2026-07-12 P-008: the item's text, captured
       *  inside the lock ONLY on a real →wip edge, so the claim-time recall port
       *  can query it without a second read. Undefined on every other flip. */
      wipItemText?: string;
    }
  | { ok: false; code: 'not_found' | 'item_not_found' }
  | {
      ok: false;
      code: 'terminal_parent_child_mutation';
      parentStatus: string;
      changes: TerminalPlanChildMutation[];
    }
  /** `onlyIfNotTerminal` tripped: the item is already done/dropped and the caller
   *  asked for a non-destructive flip. Carries the CURRENT status so the caller can
   *  report what it left alone. Not an error — see the `terminal_guard` branch below. */
  | { ok: false; code: 'terminal_guard'; currentStatus: string | null }
  /** `onlyIfNotBlocked` tripped: the item is already blocked/needs-human and the caller
   *  asked for a non-destructive flip. Carries the CURRENT status so the caller can
   *  report what it left alone. Not an error — see the `blocked_guard` branch below. */
  | { ok: false; code: 'blocked_guard'; currentStatus: string | null; refusal: RefusalContract }
  /** `onlyIfNotCompleted` tripped: the item is `done` and an automated cascade tried to
   *  drop it. Not an error — see the `completed_guard` branch below. */
  | { ok: false; code: 'completed_guard'; currentStatus: string | null }
  /** `onlyIfBlockAttributedTo` tripped: the item is blocked, but its live note does not
   *  attribute that block to the work-item whose blocker just cleared — so the block was
   *  set for some other reason and is left standing. Not an error — see the
   *  `block_attribution_guard` branch below. */
  | { ok: false; code: 'block_attribution_guard'; currentStatus: string | null }
  /** `expectedStatus` mismatched: the item is NOT on the status the caller
   *  recorded, so newer work would be overwritten. Unlike the guards above this
   *  IS an error — the caller must re-read and decide (P-011). */
  | {
      ok: false;
      code: 'expected_status_mismatch';
      currentStatus: string | null;
      expectedStatus: string;
    };

/**
 * Extract one item's `importance` from the plan body, glyph-agnostically,
 * the same way the parser does (the `importance:` keyword on the item line,
 * default `normal`). The response exposes this value on every successful
 * status flip, and the needs-human transition also uses it to decide the
 * push gate.
 */
export function itemImportance(body: string, itemId: string): Importance {
  const re = new RegExp(String.raw`^\s*[-*]\s+\*\*\s*` + itemId.replace(/-/g, '\\-') + String.raw`\s*\*\*[^\n]*$`, 'm');
  const m = re.exec(maskFences(body));
  if (!m) return 'normal';
  const im = /\bimportance:\s*(urgent|high|normal|low)\b/i.exec(m[0]);
  return im ? (im[1]!.toLowerCase() as Importance) : 'normal';
}

/**
 * P-020 push gate: notify only when an item TRANSITIONS into needs-human
 * (not a re-set of an already-needs-human item) and its importance is at
 * least `high`. Pure so it's unit-testable without the lock/IO path.
 */
export function shouldPushNeedsHuman(oldStatus: string | null, newStatus: string, importance: Importance): boolean {
  return (
    newStatus === 'needs-human' && oldStatus !== 'needs-human' && (importance === 'urgent' || importance === 'high')
  );
}

/**
 * EI-20204821380371591 — a direct plan-item close must not be the evidence-free
 * bypass around work_items:complete's TypeScript advisory. The flip stays
 * warn-only, but a real →done edge either challenges the supplied evidence with
 * the shared guard or makes the missing evidence explicit.
 */
export function typeEvidenceWarningForPlanItem(args: {
  ref: string;
  oldStatus: string | null;
  newStatus: string;
  verification?: CompletionVerificationEvidence;
}): string | undefined {
  if (args.newStatus !== 'done' || args.oldStatus === 'done') return undefined;
  if (!args.verification) {
    return (
      `plan item ${args.ref} was closed without structured verification evidence, so this terminal path cannot ` +
      'tell whether a green unit suite silently missed TypeScript errors. Pass `verification:{ verifiedHow, ' +
      'testsRun, testResult, filesChanged }` on the done flip; Vitest transforms via esbuild and NEVER typechecks.'
    );
  }
  const gap = typeEvidenceGapInCompletion(args.verification);
  if (!gap) return undefined;
  return (
    `plan item ${args.ref} rests on a TEST RUN (` +
    `\`verifiedHow: '${args.verification.verifiedHow}'\`) and changed ${gap.tsFiles.length} TypeScript file(s), ` +
    'but cites no typecheck. Vitest transforms via esbuild and NEVER typechecks — a green suite is SILENT about ' +
    `types. If this close asserts the code COMPILES, run the owning repository typecheck for: ${gap.tsFiles.join(', ')}. ` +
    'If it only asserts BEHAVIOUR, ignore this.'
  );
}

/**
 * EI-14699 — plan-item status → linked work_item state SYNC (the reverse of
 * reflect-rules.ts's work_item → plan-item direction).
 *
 * A plan item converted/promoted to a work_item stamps `payload.plan_item`; the
 * reflect rules mirror the WORK_ITEM's lifecycle onto the plan item. The reverse
 * had no path: flipping the PLAN ITEM to `blocked`/`needs-human` independently
 * (e.g. an owner-gated blocker recorded via plans:set-status) left the linked
 * work_item's own `state` untouched — so `scheduler:get_next` / the
 * `work-item:claimable` gate (which read work_item.state, not the plan item's
 * status) kept serving the item as claimable. Each fleet member then claimed it,
 * re-discovered the owner-gated blocker, released it, and the cycle repeated —
 * perpetual claim/release ping-pong that burned real fleet cycles (WI-3475,
 * WI-3467 each cycled 8+ times).
 *
 * This pure decider says which work_item state (if any) a plan-status flip must
 * reflect, given the work_item's CURRENT state so we never disturb work that is
 * already correctly placed:
 *   - plan → blocked/needs-human, while the work_item still sits CLAIMABLE
 *     (todo/open) ⇒ set the work_item `blocked` (for a feature-family item this
 *     populates the scheduler's `work_item_blocked` sidecar, ending the ping-pong).
 *   - plan reopened → todo FROM a blocked/needs-human status, while the work_item
 *     is still `blocked` (i.e. blocked by THIS sync) ⇒ return it to `todo`.
 * Every other flip maps to null — done/dropped (terminal-grip release), wip
 * (auto-claim), a re-set of the same status, or a work_item already elsewhere in
 * its lifecycle are all left to their existing owners. Transition-gated so a
 * routine re-set never yanks a work_item. Pure/injectable like shouldPushNeedsHuman
 * / reflectedStatus so the rule is unit-tested without the lock/PG path.
 */
export const PLAN_BLOCKED_STATUSES = new Set(['blocked', 'needs-human']);
/** The work_item states a claimable item can be in before we block it. work-item-status-full-unify
 *  (P-004/P-005): `open` is now the SINGLE claimable token for BOTH families; `todo` is retired but
 *  kept here as a TOLERANT read-superset so a not-yet-backfilled legacy row still blocks correctly. */
export const CLAIMABLE_WORK_ITEM_STATES = new Set(['todo', 'open']);
export function planSyncWorkItemState(
  oldPlanStatus: string | null,
  newPlanStatus: string,
  currentWorkItemState: string,
): 'blocked' | 'open' | null {
  if (newPlanStatus === oldPlanStatus) return null;
  if (PLAN_BLOCKED_STATUSES.has(newPlanStatus)) {
    return CLAIMABLE_WORK_ITEM_STATES.has(currentWorkItemState) ? 'blocked' : null;
  }
  if (
    newPlanStatus === 'todo' &&
    oldPlanStatus !== null &&
    PLAN_BLOCKED_STATUSES.has(oldPlanStatus) &&
    currentWorkItemState === 'blocked'
  ) {
    // work-item-status-full-unify (P-005): re-open onto the UNIFIED claimable token `open`
    // directly (was `todo`, which only reached 'open' via the legacy alias-fold + mis-reported
    // workItemSynced.state). The plan-item status stays `todo` (its own vocabulary is unchanged).
    return 'open';
  }
  return null;
}

/** Caller-DX (watchdog P-006): the inline note is spliced into a single plan
 *  item line, so an over-long note bloats the file. Truncate-with-marker
 *  instead of rejecting — the agent never bounces; the long form belongs in
 *  `rationale` (stored on the plan revision). */
const NOTE_INLINE_MAX = 1000;
export function truncateInlineNote(note: string | undefined): {
  note: string | undefined;
  truncated: boolean;
} {
  if (note === undefined) return { note: undefined, truncated: false };
  if (note.length <= NOTE_INLINE_MAX) return { note, truncated: false };
  return { note: note.slice(0, NOTE_INLINE_MAX - 1) + '…', truncated: true };
}

/** D-002/P-007: departing from a plan is legitimate, but never silent. Keep this
 * per-item (rather than a whole-args schema refinement) so one malformed drop in a
 * heterogeneous bulk call fails only itself under the house bulk contract. */
export function droppedReasonMissing(input: { status: string; note?: string; rationale?: string }): boolean {
  return (
    input.status === 'dropped' &&
    !(typeof input.note === 'string' && input.note.trim().length > 0) &&
    !(typeof input.rationale === 'string' && input.rationale.trim().length > 0)
  );
}

/** A terminal status — the item is finished; it is held + assigned by no one. */
export function isTerminalStatus(status: string): boolean {
  return status === 'done' || status === 'dropped';
}

/**
 * Should a non-destructive flip be SKIPPED because the item is already finished?
 *
 * Pure + exported (same posture as `terminalFlipConflict` below) so the rule is unit-tested
 * without the PG/lock path. True ⇒ leave the item exactly as it is.
 *
 * The invariant: an AUTOMATED reflection must never move a plan item from terminal to
 * NON-terminal, because the event driving it may carry no information about completion at
 * all — `work_items:release` is ownership, not doneness. Terminal→terminal (done→dropped)
 * is a legitimate reclassification and is NOT skipped; a caller that omits the flag (a human
 * deliberately reopening an item) is unaffected.
 */
/**
 * COMPARE-AND-SET precondition (P-011), pure so the policy is pinned without a
 * plan lock or a database.
 *
 * `null` current status means the flip helper could not read one; that is
 * indistinguishable from "it changed", so it fails closed.
 */
export function expectedStatusMismatch(opts: {
  expectedStatus: string | undefined;
  currentStatus: string | null;
}): boolean {
  if (opts.expectedStatus === undefined) return false;
  return opts.currentStatus !== opts.expectedStatus;
}

export function terminalGuardTrips(opts: {
  onlyIfNotTerminal: boolean | undefined;
  currentStatus: string | null;
  nextStatus: string;
}): boolean {
  if (!opts.onlyIfNotTerminal) return false;
  if (opts.currentStatus === null) return false;
  return isTerminalStatus(opts.currentStatus) && !isTerminalStatus(opts.nextStatus);
}

/**
 * Should a non-destructive flip be SKIPPED because the item is already explicitly
 * blocked or waiting for a human decision?
 *
 * Pure + exported so it is unit-tested without the PG/lock path. True means leave
 * the item exactly as it is. A blocked→needs-human or needs-human→blocked transition
 * keeps the item gated and is therefore allowed; only a transition out of the
 * blocked/needs-human family trips the guard.
 */
export function blockedGuardTrips(opts: {
  onlyIfNotBlocked: boolean | undefined;
  currentStatus: string | null;
  nextStatus: string;
}): boolean {
  if (!opts.onlyIfNotBlocked) return false;
  if (opts.currentStatus === null) return false;
  return PLAN_BLOCKED_STATUSES.has(opts.currentStatus) && !PLAN_BLOCKED_STATUSES.has(opts.nextStatus);
}

/**
 * Should an AUTOMATED drop be SKIPPED because the plan item is already FINISHED?
 *
 * EI-20129670928216719. The invariant: a cascade must never downgrade `done` → `dropped`.
 * A `done` plan item is shipped, verified work; the drop of SOME linked work-item is never
 * evidence that it became abandoned.
 *
 * This is a THIRD guard because the case falls between the existing two, by each one's own
 * contract — patching either in isolation is wrong:
 *   - `terminalGuardTrips` deliberately permits terminal→terminal (see its docstring), and
 *     that behaviour is PINNED by set-status.test.ts ('done'→'dropped' ⇒ false). Widening it
 *     would break a deliberate, tested contract.
 *   - the coverage guard counts only NON-terminal siblings, so the DONE work-item that
 *     actually completed the plan item never registers as coverage.
 *
 * Observed live: dropping WI-37872 — a follow-on merely `relates`-linked to
 * fix-0014-platform-defects-2026-08-10#P-005 — flipped that already-`done` item to
 * `dropped` 67ms later. P-005's real completer, the sibling WI-37735, was `done` and so
 * invisible to the coverage guard. The same asymmetry was already fixed for the sibling
 * `plan-item-reflect:release` rule (EI-19295826179470465); this closes it for the drop path.
 *
 * SAFETY (why this can never fire on the item that triggered it): the reflect drop cascade
 * only runs when the triggering work-item's state maps to `dropped` — `deprecated|closed|
 * dropped`, never `done` (plan-items/reflect-rules.ts `reflectedStatus`). So the guard needs
 * no self-exclusion, unlike the coverage guard.
 *
 * Pure + exported so the rule is unit-tested without the PG/lock path. Evaluated INSIDE the
 * plan lock, where `currentStatus` is race-safe — the coverage guard's pre-lock read would
 * not be. True ⇒ leave the item exactly as it is.
 */
export function completedGuardTrips(opts: {
  onlyIfNotCompleted: boolean | undefined;
  currentStatus: string | null;
  nextStatus: string;
}): boolean {
  if (!opts.onlyIfNotCompleted) return false;
  return opts.currentStatus === 'done' && opts.nextStatus === 'dropped';
}

/**
 * Work-item ids explicitly named by a routed/follow-up clause.
 *
 * A plan-item drop is allowed to reconcile its own stale execution record, but
 * that same record must not also be the destination of an obligation the drop
 * note says was routed elsewhere. The route is currently prose (D-019 requires
 * it to be cited in the item note), so keep the detector deliberately narrow:
 * only WI-/EI- ids in text carrying an unmistakable routing marker qualify.
 * Bare citations remain ordinary evidence and do not change existing drops.
 */
const ROUTED_WORK_ITEM_REF = /\b((?:WI|EI|F)-\d+)\b/gi;
const ROUTING_MARKER =
  /\b(?:rout(?:e|ed|ing)|re-?rout(?:e|ed|ing)|follow[-\s]?up|standing home|owning item|unperformed(?:\s+\w+){0,4}\s+to)\b/i;

/** Pure extraction seam for the routed-follow-up drop guard. */
export function routedWorkItemRefs(text: string | undefined): string[] {
  if (!text || !ROUTING_MARKER.test(text)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  // Keep the work-item id associated with the same sentence/clause as the
  // routing marker. A later historical mention of another work-item in the
  // rationale must not accidentally turn that item into the routed target.
  const segments = text
    .split(/\r?\n/)
    .flatMap((line) => line.split(/(?<=[.!?;])\s+/))
    .map((segment) => segment.trim())
    .filter(Boolean);
  for (const segment of segments) {
    if (!ROUTING_MARKER.test(segment)) continue;
    ROUTED_WORK_ITEM_REF.lastIndex = 0;
    for (const match of segment.matchAll(ROUTED_WORK_ITEM_REF)) {
      const id = match[1]?.toUpperCase();
      if (id && !seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
    }
  }
  return out;
}

/**
 * Should an automated drop be refused because its prose routes an obligation
 * to a still-live work-item that the dropped plan item would reconcile?
 *
 * The linked-row read is intentionally performed before the plan lock, like the
 * existing coverage guard. A terminal target is safe (there is no obligation
 * left to preserve), and an unlinked target is safe because the plan-item
 * reconciler cannot reach it. Only the dangerous composition — an explicit route
 * marker naming a non-terminal row in this plan-item's reconciliation set —
 * refuses.
 */
export function routedFollowUpConflict(
  text: string | undefined,
  linked: ReadonlyArray<{
    id: string;
    state: string;
    family?: 'feature' | 'issue';
    assignee?: string | null;
    viaImplementsEdge?: boolean;
  }>,
): {
  id: string;
  state: string;
} | null {
  const routed = new Set(routedWorkItemRefs(text));
  if (routed.size === 0) return null;
  return (
    linked.find(
      (wi) =>
        routed.has(wi.id.toUpperCase()) &&
        !TERMINAL_WORK_ITEM_STATES.has(wi.state) &&
        !wi.assignee &&
        // The reconciler deliberately preserves issue-family stamp-only rows:
        // a `plan_item` stamp can mean "discovered while working", not
        // "implements". Feature-family rows remain stamp-borne by design.
        (wi.family !== 'issue' || wi.viaImplementsEdge === true),
    ) ?? null
  );
}

/** The minimal claim shape the terminal-flip guard reads (a subset of PlanItemClaim). */
export interface HolderInfo {
  owner: string;
  ownerLabel: string | null;
  intent: string;
  expiresTs: string;
  expired: boolean;
}

/**
 * WI-2156 (completion-integrity, terminal-flip holdership): decide whether an AGENT's
 * terminal flip (done/dropped) must be REFUSED because a LIVE peer holds the item's
 * claim. The `wip` path claims-before-work and rejects a live peer claim, but the close
 * path historically skipped the check — so any agent could terminal-flip an item a live
 * peer was mid-verifying, voiding its lease and recording a completion the flipper never
 * did (ornith run-10: one member bulk-flipped 6 items its sibling held). This is the
 * prevention leg; the behaviour-suite only catches such bare flips post-hoc.
 *
 * Pure + injectable (like shouldPushNeedsHuman / releaseTerminalGrips) so the rule is
 * unit-tested without the PG/lock path. Returns the blocking holder, or null to ALLOW.
 * Allow when: the flip is non-terminal; there is no agent caller (a human / `principal`
 * session — the guard binds agents, not the owner); the item is unheld; the claim is
 * expired/lapsed (a dead peer must never wedge closure — the SAME liveness the wip path
 * uses); or the caller IS the holder (closing your own held item is the completion path).
 */
export function terminalFlipConflict(opts: {
  status: string;
  agentOwnerId: string | null;
  holder: HolderInfo | null;
}): { owner: string; ownerLabel: string | null; intent: string; expiresTs: string } | null {
  if (!isTerminalStatus(opts.status)) return null;
  if (!opts.agentOwnerId) return null;
  const h = opts.holder;
  if (!h || h.expired || h.owner === opts.agentOwnerId) return null;
  return { owner: h.owner, ownerLabel: h.ownerLabel, intent: h.intent, expiresTs: h.expiresTs };
}

/**
 * Terminal-flip cleanup (claim-discipline + EI-2298). A done/dropped item must
 * carry NEITHER a live claim NOR a durable assignment:
 *  - the CLAIM is the caller's live lease — only an attributable agent holds one,
 *    so it's released by the caller's ownerId (null caller / principal → skip);
 *  - the ASSIGNMENT is item-level and may belong to a DIFFERENT agent than the
 *    one closing the item (e.g. a verify-first `done` set by a peer). If it is
 *    left dangling the item sits done+assigned-idle forever and any dispatcher
 *    that re-pokes assigned-idle items re-targets the stale assignee endlessly
 *    (EI-2298). So clear it UNCONDITIONALLY on a terminal flip.
 * Deps are injected so the invariant is unit-testable without the lock/PG path
 * (mirrors shouldPushNeedsHuman / truncateInlineNote). Both legs are fail-safe:
 * a release hiccup is logged and reported as not-released, never thrown.
 */
export async function releaseTerminalGrips(opts: {
  status: string;
  agentOwnerId: string | null;
  scope: { workspaceId: string; harnessSlug: string };
  slug: string;
  itemId: string;
  releaseClaim: (
    workspaceId: string,
    harnessSlug: string,
    planSlug: string,
    itemId: string,
    owner: string,
  ) => Promise<boolean>;
  clearAssignment: (
    workspaceId: string,
    harnessSlug: string,
    planSlug: string,
    itemId: string,
  ) => Promise<unknown | null>;
}): Promise<{ claimReleased: boolean; assignmentReleased: boolean }> {
  if (!isTerminalStatus(opts.status)) {
    return { claimReleased: false, assignmentReleased: false };
  }
  let claimReleased = false;
  if (opts.agentOwnerId) {
    claimReleased = await opts
      .releaseClaim(opts.scope.workspaceId, opts.scope.harnessSlug, opts.slug, opts.itemId, opts.agentOwnerId)
      .catch((e) => {
        console.warn('[plans:set-status] claim release failed:', (e as Error)?.message ?? e);
        return false;
      });
  }
  const assignmentReleased = await opts
    .clearAssignment(opts.scope.workspaceId, opts.scope.harnessSlug, opts.slug, opts.itemId)
    .then((released) => released != null)
    .catch((e) => {
      console.warn('[plans:set-status] assignment release failed:', (e as Error)?.message ?? e);
      return false;
    });
  return { claimReleased, assignmentReleased };
}

/**
 * →todo claim release (EI-5822). A →todo flip is the documented "hand it back
 * to the pool" affordance, but historically only released the item's stored
 * STATUS token — the caller's live coord CLAIM LEASE (what actually blocks a
 * peer's next wip-flip with claim_conflict) survived until its TTL expired.
 * Net: "released via →todo, all yours" was a false affordance — the next
 * claimant had to wait out the lease or ask for an explicit release.
 *
 * Release ONLY the caller's OWN claim (releaseClaim no-ops if the caller
 * doesn't hold it — this must never void a LIVE PEER's lease); unlike a
 * terminal flip, do NOT touch the durable assignment: →todo means "I'm done
 * working it right now", not "I'm done owning it" — the item may legitimately
 * stay assigned while its lease frees up for the assignee (or anyone) to
 * re-claim. Deps injected so this is unit-testable without the PG/lock path
 * (mirrors releaseTerminalGrips). Fail-safe: a release hiccup is logged and
 * reported as not-released, never thrown.
 */
export async function releaseTodoClaim(opts: {
  status: string;
  agentOwnerId: string | null;
  scope: { workspaceId: string; harnessSlug: string };
  slug: string;
  itemId: string;
  releaseClaim: (
    workspaceId: string,
    harnessSlug: string,
    planSlug: string,
    itemId: string,
    owner: string,
  ) => Promise<boolean>;
}): Promise<{ claimReleased: boolean }> {
  if (opts.status !== 'todo' || !opts.agentOwnerId) {
    return { claimReleased: false };
  }
  const claimReleased = await opts
    .releaseClaim(opts.scope.workspaceId, opts.scope.harnessSlug, opts.slug, opts.itemId, opts.agentOwnerId)
    .catch((e) => {
      console.warn('[plans:set-status] todo claim release failed:', (e as Error)?.message ?? e);
      return false;
    });
  return { claimReleased };
}

/** The marker `flipStatusInBody` injects for a caller-supplied `note` (EI-384) —
 *  matches from the marker to end-of-line so a REPEAT call replaces the whole
 *  previously-injected note instead of appending another one. Re-exported (as
 *  the historical local name) from the canonical `@papercusp/plan-parser`
 *  definition (EI-522) — the parser needs this SAME pattern to exclude a
 *  note's free prose from structured D-NNN ref extraction, so it is now the
 *  single source of truth; this file must never redefine its own copy. */
export const NOTE_MARKER_RE = NOTE_SUFFIX_RE;

/**
 * Does the item's LIVE injected note attribute its current block to `workItemId`?
 *
 * The attribution half of the attributed clear (deterministic-plan-state-derivation-
 * 2026-08-31 D-001). This is sound only because a note REPLACES the previous one rather
 * than stacking (EI-384, see `flipStatusInBody` below): the single note present is the
 * most recent reflection, so it is the live attribution rather than one entry in a
 * history. If notes ever start accumulating, this predicate silently weakens — hence
 * the property test in the sibling spec pinning replace-not-append.
 *
 * Deliberately reuses `NOTE_MARKER_RE` (the parser's single source of truth) instead of
 * re-deriving the " — note: " literal, and searches WITHIN the matched suffix: the
 * marker text contains neither a work-item id nor a status word, so scanning the whole
 * matched span cannot false-positive on the marker itself.
 */
export function noteAttributesBlockTo(itemText: string | undefined, workItemId: string): boolean {
  if (!itemText || !workItemId) return false;
  const matched = itemText.match(NOTE_MARKER_RE);
  if (!matched) return false;
  const note = matched[0].toLowerCase();
  if (!note.includes(workItemId.toLowerCase())) return false;
  return note.includes('blocked') || note.includes('needs-human');
}

/**
 * Should an attributed clear be SKIPPED because the block is not this work-item's to lift?
 *
 * Returns true (skip) when the item is blocked but the block is NOT attributable to
 * `onlyIfBlockAttributedTo`. Governs ONLY the blocked→unblocked edge; every other
 * transition is another guard's business and falls through untouched.
 *
 * `needs-human` always skips regardless of attribution: that band means a human owes a
 * decision, and no automated cascade takes an item out of it. (A work-item blocker whose
 * capability is human reflects INTO `needs-human`, so this is the deliberate one-way
 * door — it goes in automatically and only ever comes out by hand.)
 */
export function blockAttributionTrips(opts: {
  onlyIfBlockAttributedTo: string | undefined;
  currentStatus: string | null;
  nextStatus: string;
  currentItemText: string | undefined;
}): boolean {
  if (!opts.onlyIfBlockAttributedTo) return false;
  if (opts.currentStatus === null) return false;
  // Only ever governs LIFTING a block.
  if (!PLAN_BLOCKED_STATUSES.has(opts.currentStatus)) return false;
  if (PLAN_BLOCKED_STATUSES.has(opts.nextStatus)) return false;
  if (opts.currentStatus === 'needs-human') return true;
  return !noteAttributesBlockTo(opts.currentItemText, opts.onlyIfBlockAttributedTo);
}

export function flipStatusInBody(
  body: string,
  itemId: string,
  newStatus: string,
  note?: string,
): { newBody: string; found: boolean; oldStatus: string | null } {
  // Match a specific item id by anchoring on it.
  const re = new RegExp(
    String.raw`^(\s*[-*]\s+\*\*\s*` + itemId.replace(/-/g, '\\-') + String.raw`\s*\*\*\s+\x60)([a-z-]+)(\x60\s+.*)$`,
    'm',
  );

  // `## Now` can contain a presentation line like `- **P-001** `done` ...`
  // before the real phase item. It is intentionally excluded from
  // parsePlan().items and from the derived index, but a document-wide first
  // regex match would edit it and leave the actual item unchanged. Resolve the
  // same canonical occurrence the index writer sees (last parsed occurrence for
  // duplicate ids), then use its physical line. Keep the legacy raw-line
  // fallback for bodies without a parser-recognized phase item.
  const matchingItems = parsePlan(body).items.filter((item) => item.id === itemId);
  const parsedItem = matchingItems[matchingItems.length - 1];
  const lines = body.split('\n');
  const maskedLines = maskFences(body).split('\n');

  // parsePlan() numbers lines in the body after frontmatter. Translate that to
  // the original source line so the exact canonical row is edited in place.
  let frontmatterLineOffset = 0;
  if (body.startsWith('---')) {
    const close = body.indexOf('\n---', 3);
    if (close !== -1) {
      const afterClose = body.indexOf('\n', close + 4);
      if (afterClose !== -1) {
        frontmatterLineOffset = (body.slice(0, afterClose + 1).match(/\n/g) ?? []).length;
      }
    }
  }
  const lineIndex = parsedItem
    ? frontmatterLineOffset + parsedItem.lineNumber - 1
    : maskedLines.findIndex((line) => re.test(line));
  const m = lineIndex >= 0 && lineIndex < maskedLines.length ? re.exec(maskedLines[lineIndex] ?? '') : null;
  if (!m) return { newBody: body, found: false, oldStatus: null };

  const oldStatus = m[2] ?? '';
  let rest = m[3] ?? '';
  if (note) {
    // EI-384: two bugs in the old `rest = \`${rest} (${note.replace(/[()]/g, '')})\``
    // form — (1) it silently stripped parens from the caller's OWN note text
    // (turning "(a)" into "a" — a meaning-changing mangle, not cosmetic), and
    // (2) a repeat set-status call on the same item (e.g. fixing a typo'd note)
    // APPENDED a second parenthetical instead of replacing the first, so notes
    // accumulated without bound. Fixed by (1) never touching the note's own
    // characters, and (2) using a distinctive, unambiguous " — note: " marker so
    // an existing INJECTED note (this function's own prior output) can be found
    // and replaced — never appended to — while ordinary item text that happens
    // to end in parens is left alone (it never matches this marker).
    rest = rest.replace(NOTE_MARKER_RE, '');
    rest = `${rest} — note: ${note}`;
  }
  const newLine = `${m[1] ?? ''}${newStatus}${rest}`;
  // Index-based splice rather than body.replace(re, newLine): a string
  // replacement argument would interpret dollar-sign substitution
  // sequences in the item text as patterns. The selected physical line came
  // from the fence-masked body, which preserves length. Preserve CRLF input.
  const trailingCarriageReturn = lines[lineIndex]!.endsWith('\r') ? '\r' : '';
  lines[lineIndex] = `${newLine}${trailingCarriageReturn}`;
  const newBody = lines.join('\n');
  return { newBody, found: true, oldStatus };
}

export type RestorePlanItemStatusResult =
  | 'restored'
  | 'already_restored'
  | 'not_found'
  | 'item_not_found'
  | 'source_changed'
  | 'busy';

/**
 * The edge gate for `plan-item:done:<slug>:<id>`: fire ONLY on a real todo/wip → done
 * transition, never on a re-set of an already-done item.
 *
 * Extracted as a pure predicate (EI-22377738415938641) because the whole awaiter contract
 * rests on it and nothing tested it. `events/await.ts`'s plan-item-done LATCH resolves an
 * await immediately when the item's live status is already `done`, and it is allowed to do
 * that ONLY because this key "fires exactly once, on the real →done edge" — so if this gate
 * ever regressed to firing on every set, awaiters would take spurious wakes AND the latch's
 * equivalence ("live-status==done" ≡ "the event already fired") would silently stop holding.
 *
 * The call site fires this AFTER the durable status write returns, inside the same lock —
 * which is the ordering EI-22377738415938641 suspected was violated. It is not: the
 * event ledger recorded exactly ONE fire for the reported item
 * (plan-item:done:identities-v1-2026-08-30:P-040, 2026-09-05T00:02:33.815Z), 560ms AFTER its
 * work-item went terminal, with the plan row already `done`. The transient the reporter saw
 * — work-item done, plan item still todo, plan claim retained — is the gap BEFORE this fires,
 * because completion converges the work-item and the plan item in separate steps rather than
 * one transaction. That window is real, but it closes at this emit, which is exactly why the
 * event REMAINS trustworthy as proof of the plan row's terminal state.
 */
export function shouldFirePlanItemDone(nextStatus: string, oldStatus: string | null | undefined): boolean {
  return nextStatus === 'done' && oldStatus !== 'done';
}

export function planItemCompensationMutation(
  current: string | null,
  input: {
    itemId: string;
    expectedStatus: string;
    priorStatus: string;
    now?: Date;
  },
): {
  newBody: string | null;
  value: Exclude<RestorePlanItemStatusResult, 'busy'>;
} {
  if (current === null) return { newBody: null, value: 'not_found' };
  const probe = flipStatusInBody(current, input.itemId, input.priorStatus);
  if (!probe.found) return { newBody: null, value: 'item_not_found' };
  if (probe.oldStatus === input.priorStatus) {
    return { newBody: null, value: 'already_restored' };
  }
  if (probe.oldStatus !== input.expectedStatus) {
    return { newBody: null, value: 'source_changed' };
  }
  return {
    newBody: bumpUpdatedDate(probe.newBody, input.now ?? new Date()),
    value: 'restored',
  };
}

/**
 * Compare-and-set inverse used by the bounded Inbox bulk compensation path.
 *
 * This restores only the plan item's canonical status token. The immutable
 * bulk receipt is the audit record, so this helper does not append a second
 * plan-revision explanation. It still uses the same advisory-lock RMW, parser
 * and updated-date writer as plans:set-status; a newer status always wins.
 */
export async function restorePlanItemStatusForCompensation(input: {
  workspaceId: string;
  harnessSlug?: string | null;
  slug: string;
  itemId: string;
  expectedStatus: string;
  priorStatus: string;
}): Promise<RestorePlanItemStatusResult> {
  const result = await withPlanLock<Exclude<RestorePlanItemStatusResult, 'busy'>>(
    null,
    {
      slug: input.slug,
      intent: `attention bulk compensation ${input.itemId} → ${input.priorStatus}`,
      workspaceId: input.workspaceId,
      ...(input.harnessSlug ? { harnessSlug: input.harnessSlug } : {}),
    },
    async (current) =>
      planItemCompensationMutation(current, {
        itemId: input.itemId,
        expectedStatus: input.expectedStatus,
        priorStatus: input.priorStatus,
      }),
  );
  return result.kind === 'busy' ? 'busy' : result.value;
}

/**
 * Flip ONE item's status, returning the self-describing bulk result. This carries the
 * FULL single-call logic per item — wip auto-claim (+ claim_conflict reject as a
 * per-item failure), best-effort auto-convert, the surgical line edit inside the
 * lock, the needs-human push gate, terminal-grip release, and the sync invalidate.
 * The prior early-returns (claim_conflict, busy, not_found/item_not_found) all become
 * this item's { ok:false, … } result; one failure never fails the rest.
 */
async function setStatusOne(it: StatusItem, ctx: UnifiedToolContext): Promise<BulkItemResult> {
  if (droppedReasonMissing(it)) {
    return {
      ok: false,
      slug: it.slug,
      itemId: it.itemId,
      error: 'dropped_reason_required',
      hint: "status:'dropped' records an intentional departure from the plan and requires a nonblank `note` (preferred; visible inline forever) or `rationale` (stored on the plan revision)",
    };
  }

  // WI-10002659: a completed status batch outlived the MCP deadline, but the
  // invocation ledger could only report its total wall time. Keep a bounded,
  // low-noise phase trace on successful slow calls so the next occurrence can
  // distinguish claim/coverage, the plan write, conversion, reconciliation,
  // and finalization before anyone guesses at a cause.
  const startedAtMs = performance.now();
  let lastPhaseAtMs = startedAtMs;
  const phasesMs: Record<string, number> = {};
  const markPhase = (phase: string): void => {
    const now = performance.now();
    phasesMs[phase] = Math.round(Math.max(0, now - lastPhaseAtMs));
    lastPhaseAtMs = now;
  };

  let sctx: UnifiedToolContext & { harnessSlug: string };
  try {
    sctx = harnessScopedCtx(it.harness, ctx);
  } catch (error) {
    if (!(error instanceof HarnessRequiredError)) throw error;
    // An exact plan slug is sufficient to recover a workspace-scoped write,
    // provided the canonical index identifies one unambiguous owning harness.
    // Explicit or session harness bindings still take the normal scoped path.
    const recovered = await recoverHarnessFromSlugs(ctx, [it.slug]);
    const decision = requireUnambiguousSlugScope(
      recovered,
      ((ctx as { workspaceId?: string }).workspaceId ?? '').trim(),
    );
    if (decision.status !== 'resolved') {
      const failure = JSON.parse(slugScopeErrorResult('plans:set-status', decision).content[0].text) as {
        error: string;
        detail: string;
      };
      return { ok: false, ...failure, slug: it.slug, itemId: it.itemId };
    }
    sctx = { ...ctx, harnessSlug: decision.harnessSlug };
    (ctx as { metadata?: (d: Record<string, unknown>) => void }).metadata?.({
      harnessAutoResolved: decision.bySlug,
    });
  }
  const harnessSlug = resolveCtxHarnessSlug(sctx);

  // Caller-DX (P-006): truncate an over-long inline note instead of rejecting.
  const { note: inlineNote, truncated: noteTruncated } = truncateInlineNote(it.note);

  // Claim discipline (claim-discipline-enforcement-2026-06-10): the flip IS
  // the claim. An agent flipping an item to `wip` auto-claims it here, and a
  // LIVE peer claim rejects the flip — the collision the lease exists to
  // stop. Terminal flips (done/dropped) release the caller's claim: a
  // finished item is held by no one (and done NEVER auto-claims — owner
  // decision). Humans are exempt: a caller with no attributable agent
  // identity OR a `principal` one (the kanban drag / in-process UI path)
  // skips the discipline entirely — it binds agents, not the owner.
  let agentId: AgentIdentity | null = null;
  try {
    agentId = resolveAgentIdentity(ctx);
  } catch {
    agentId = null;
  }
  if (agentId?.source === 'principal') agentId = null;
  // EI-8509: a →wip flip auto-claims the item under the CALLER's own identity — refuse
  // it outright when the caller is scripts/mcp-call.mjs's auto-generated fallback
  // identity (`mcp-call-<pid>`), a one-shot stateless process with no liveness behind
  // it. Left unguarded, the very same "placed but nothing ever executes it" failure
  // EI-8509 found on work_items:claim happens here too (this tool auto-claims on wip).
  if (agentId && it.status === 'wip' && isEphemeralMcpCallIdentity(agentId.ownerId)) {
    return {
      ok: false,
      slug: it.slug,
      itemId: it.itemId,
      error: 'ephemeral_mcp_call_identity',
      hint: "Refused: →wip auto-claims under the caller's identity, and this call arrived as scripts/mcp-call.mjs's auto-generated fallback (mcp-call-<pid>) — a one-shot process with no heartbeat/liveness and no fleet cup behind it (EI-8509). Spawn a real cup and let IT flip this item to wip.",
    };
  }
  let claim: { claimId: string; autoClaimed: boolean } | null = null;
  let claimScope: Awaited<ReturnType<typeof resolvePlanScope>> | null = null;
  let claimOwnerName: string | null = null;
  /**
   * EI-22427741014249929: the wip auto-convert's outcome, surfaced instead of
   * discarded. The convert call below is best-effort and its result was thrown
   * away entirely, so when it transferred the linked work-item off another agent
   * the response mentioned no work-item at all — `claim:{ autoClaimed:true }`
   * reads as "I claimed the PLAN ITEM" and the execution-record handover was
   * invisible to both agents. Now the caller is told either that a live holder
   * kept it, or which record was taken and from whom.
   */
  let executionRecord:
    | { outcome: 'held-by-live-peer'; workItemId: string | null; heldBy: string; note: string }
    | { outcome: 'taken-over'; workItemId: string; priorHolder: string; basis: string }
    | null = null;
  if (agentId && it.status === 'wip') {
    const scope = await resolvePlanScope(harnessSlug ? { harnessSlug } : {});
    const ownerName = await resolveAdoptedName(scope.workspaceId, agentId.ownerId).catch(() => null);
    claimScope = scope;
    claimOwnerName = ownerName;
    const outcome = await claimForWork({
      workspaceId: scope.workspaceId,
      harnessSlug: scope.harnessSlug,
      planSlug: it.slug,
      itemId: it.itemId,
      owner: agentId.ownerId,
      ownerLabel: agentId.ownerLabel,
      ownerName,
      ownerUser: bestEffortOwnerUser(ctx),
      intent: `plans:set-status ${it.itemId} → wip`,
    });
    if (!outcome.ok) {
      // P-027 / D-055 A5 — the PLAN-ITEM analog of the work-item claim conflict.
      // Holder context explains an actual plan-item lease; a linked _claimHold
      // refusal is a different floor and must not be presented as a live peer.
      // Advisory + total: the refusal above is already decided and cannot be changed here.
      //
      // D-094: the plan-item ref is the subject, so the holder is never reported
      // as also competing on the very item whose refusal is being explained.
      const holderContext = await resolveHolderAdvisory({
        holder: outcome.holder?.owner,
        reader: holderContextReader(ctx as Parameters<typeof holderContextReader>[0]),
        // ⚠ THE QUALIFIED REF, NOT THE BARE ITEM ID — found by the LIVE exercise,
        // invisible to every fixture. `competing` holds plan-item refs in
        // `<planSlug>#<itemId>` form, so passing `it.itemId` ('P-006') compared a
        // bare id against a qualified ref, the subtraction never fired, and the
        // holder was reported as competing on the very item being refused: D-094's
        // exact defect, surviving at this surface because the SUBJECT was in a
        // different notation than the REF. A fixture cannot catch it — the author
        // picks both sides of the comparison.
        subjectRef: planItemRef(it.slug, it.itemId),
      });
      let hint: string;
      if (outcome.holder) {
        const holderLabel = outcome.holder.ownerLabel ?? outcome.holder.owner;
        hint =
          'the item has a plan-item claim lease for ' + holderLabel + '; check coord:presence { owner: "' +
          outcome.holder.owner + '" } and coordinate with the holder if that session is live (coord:send), or pick another item; ' +
          'fleet:assignments { plan } shows who holds what';
      } else if (outcome.claimHold) {
        const provenanceNotes: string[] = [];
        if (outcome.claimHold.provenance.heldOpen) {
          const lease = outcome.claimHold.provenance.heldOpen;
          provenanceNotes.push(
            'held_open lease by ' + lease.by + '; reason=' + (lease.reason ?? 'not recorded') + '; at=' + (lease.at ?? 'not recorded'),
          );
        }
        if (outcome.claimHold.provenance.parked) {
          const park = outcome.claimHold.provenance.parked;
          provenanceNotes.push(
            'durable park by ' + park.by + '; reason=' + (park.reason ?? 'not recorded') + '; at=' + (park.at ?? 'not recorded'),
          );
        }
        const provenanceNote =
          provenanceNotes.length > 0 ? provenanceNotes.join('; ') : 'no hold holder, reason, or timestamp is recorded';
        hint =
          'the linked work item ' + outcome.claimHold.workItemId + ' is excluded by _claimHold (' + provenanceNote + '); ' +
          'this refusal did not identify a plan-item lease holder. Inspect the hold state, then clear it only if it is no longer needed with ' +
          'work_items:hold_open { id: "' + outcome.claimHold.workItemId + '", clear: true, force: true }; ' +
          'a policy-tier reason also requires ownerOverride: true';
      } else {
        hint =
          'the claim was refused without a plan-item holder: ' + outcome.reason +
          '; check the assignment or work-group requirement before retrying';
      }
      return {
        ok: false,
        slug: it.slug,
        itemId: it.itemId,
        error: 'claim_conflict',
        reason: outcome.reason,
        holder: outcome.holder ?? null,
        ...(holderContext ? { holderContext } : {}),
        ...(outcome.claimHold ? { claimHold: outcome.claimHold } : {}),
        hint,
      };
    }
    claim = { claimId: outcome.claimId, autoClaimed: !outcome.alreadyHeld };
  }

  const releaseNewWipClaim = async (): Promise<{ claimReleased?: boolean; claimReleaseError?: string }> => {
    if (!agentId || !claim?.autoClaimed || !claimScope) return {};
    try {
      return {
        claimReleased: await releaseOwnClaim(
          claimScope.workspaceId,
          claimScope.harnessSlug,
          it.slug,
          it.itemId,
          agentId.ownerId,
        ),
      };
    } catch (error) {
      const message = (error as Error)?.message ?? String(error);
      console.warn(`[plans:set-status] failed wip-claim rollback ${it.slug}#${it.itemId}:`, message);
      return { claimReleased: false, claimReleaseError: message };
    }
  };

  // EI-19972048649686949: dropping ONE work-item linked to a plan item must not
  // cascade `dropped` onto the plan item when ANOTHER non-terminal work-item still
  // covers it (e.g. dropping a hand-filed duplicate of an already-claimed
  // implementer left the real coverage silently de-queued). Opt-in — automated
  // reflections only, see plan-items/reflect-rules.ts — and read-only, so it is
  // checked OUTSIDE the plan lock, before it, like the claim-conflict check above.
  // `findAllLinkedWorkItems` unions all three linkage truth sources (`implements`
  // conversion edge, `relates` coverage edge, `payload.plan_item` stamp), unlike
  // the residual-coverage advisory below which only reads `relates`. By the time
  // this reaction fires, the triggering work-item's OWN state is already committed
  // terminal, so it self-excludes from `stillCovered` without any special-casing.
  // Best-effort: a lookup hiccup must never block a legitimate flip.
  //
  // WI-38908 WIDENED THIS FROM `dropped` TO EITHER TERMINAL STATUS. It was originally
  // drop-only on the assumption that a `done` cascade means the work genuinely finished
  // — true only when ONE work-item implements the plan item. For a 1:N lane (a fix-loop
  // item with many bugs stamped to it) completing the FIRST sibling flipped the whole
  // item `done` while the rest were still open, which both hides open blockers from the
  // release criteria and — because a plan-scoped claim spec admits through that item —
  // stops anyone claiming them. Live: sidestage-public-release-testing-2026-08-14#P-009
  // auto-closed 3x in ~1h with 8+ non-terminal stamped bugs; a leader hand-restored it
  // each time. Marking terminal and abandoning are the same hazard here: both de-queue
  // an item other live work still covers, so both take the guard. When the LAST sibling
  // goes terminal, coverage is empty and the flip proceeds — 1:1 behaviour is unchanged.
  if (it.onlyIfNoOtherOpenCoverage && (it.status === 'dropped' || it.status === 'done')) {
    try {
      const linked = await findAllLinkedWorkItems(it.slug, it.itemId);
      const stillCovered = linked.filter((wi) => !TERMINAL_WORK_ITEM_STATES.has(wi.state));
      if (stillCovered.length > 0) {
        return {
          ok: true,
          slug: it.slug,
          itemId: it.itemId,
          skipped: 'coverage_guard',
          coveredBy: stillCovered.map((wi) => wi.id),
          reason:
            `left open — ${stillCovered.length} other linked work-item(s) ` +
            `(${stillCovered.map((wi) => wi.id).join(', ')}) still cover this plan item; ` +
            `marking it ${it.status} would de-queue work that is not finished`,
        };
      }
    } catch (e) {
      console.warn(`[plans:set-status] coverage guard ${it.slug}#${it.itemId} failed:`, (e as Error)?.message ?? e);
    }
  }

  // WI-2156 (completion-integrity, terminal-flip holdership): a done/dropped flip by an
  // AGENT who is NOT the item's live claim holder is REFUSED with the same per-item
  // claim_conflict shape as the wip path — you cannot close (and silently void the lease
  // on) an item a live peer is mid-verifying. Humans/principal callers are exempt
  // (agentId is null for them, above). This check follows the open-coverage guard so a
  // harmless automated reflection can report `coverage_guard` before claim ownership is
  // considered; it still runs before the plan lock and the actual status write.
  // The TTL liveness means a dead peer's lapsed claim never wedges closure. A getClaim
  // hiccup fails OPEN (holder null → allow) so a coordination-store blip never blocks a
  // legitimate completion.
  if (agentId && isTerminalStatus(it.status)) {
    const scope = await resolvePlanScope(harnessSlug ? { harnessSlug } : {});
    const holder = await getClaim(scope.workspaceId, scope.harnessSlug, it.slug, it.itemId).catch(() => null);
    const conflict = terminalFlipConflict({ status: it.status, agentOwnerId: agentId.ownerId, holder });
    if (conflict) {
      // P-027: the same disclosure on the TERMINAL-flip refusal. This is the
      // sharper of the two cases — you believe the item is finished and the
      // holder does not, so what they are still doing on it is exactly the
      // disagreement to resolve before escalating.
      const holderContext = await resolveHolderAdvisory({
        holder: conflict.owner,
        reader: holderContextReader(ctx as Parameters<typeof holderContextReader>[0]),
        // The qualified ref — same reason as the wip-claim path above.
        subjectRef: planItemRef(it.slug, it.itemId),
      });
      return {
        ok: false,
        slug: it.slug,
        itemId: it.itemId,
        error: 'claim_conflict',
        reason: `${it.status} refused — ${conflict.ownerLabel ?? conflict.owner} holds a live claim on this item; only the holder closes it`,
        holder: conflict,
        ...(holderContext ? { holderContext } : {}),
        hint: 'a live peer is working this item — coordinate with the holder (coord:send) and let them close it, or pick another item; fleet:assignments { plan } shows who holds what',
      };
    }
  }

  // EI-21233859539099062: releasing ONE linked work-item is an ownership event,
  // not evidence that the parent lane is free. A plan item can have a released
  // child plus another non-terminal linked work-item that is still actively held.
  // Only a CURRENT assignee is treated as in-flight here; a stale progress stamp
  // without a holder is not enough to keep a plan item out of the pool. This is
  // opt-in for automated release reflections and intentionally applies only to
  // the →todo path.
  //
  // Best-effort, matching the terminal coverage guard above: a lookup failure is
  // warned about but does not turn a legitimate release into a hard error.
  if (it.onlyIfNoOtherInFlightCoverage && it.status === 'todo') {
    try {
      const linked = await findAllLinkedWorkItems(it.slug, it.itemId);
      const stillInFlight = linked.filter(
        (wi) =>
          !TERMINAL_WORK_ITEM_STATES.has(wi.state) &&
          typeof wi.assignee === 'string' &&
          wi.assignee.trim().length > 0 &&
          wi.assignee.trim().toLowerCase() !== 'unassigned',
      );
      if (stillInFlight.length > 0) {
        return {
          ok: true,
          slug: it.slug,
          itemId: it.itemId,
          skipped: 'in_flight_coverage_guard',
          coveredBy: stillInFlight.map((wi) => wi.id),
          reason:
            `left open — ${stillInFlight.length} other linked work-item(s) ` +
            `(${stillInFlight.map((wi) => wi.id).join(', ')}) still have a current assignee; ` +
            'releasing this work-item must not reset the held parent plan lane to `todo`',
        };
      }
    } catch (e) {
      console.warn(
        `[plans:set-status] in-flight coverage guard ${it.slug}#${it.itemId} failed:`,
        (e as Error)?.message ?? e,
      );
    }
  }

  // ATTRIBUTED CLEAR, coverage half (D-001). The in-lock `blockAttributionTrips` asks
  // "is this block MINE to lift?"; this asks the independent question "is anyone ELSE
  // still blocking?". Both must pass, because they fail in different directions: a 1:N
  // lane can hold the clearing work-item's own attribution note while OTHER stamped
  // siblings remain blocked, and lifting on attribution alone would then re-queue an
  // item the rest still gate — the same 1:N hazard WI-38908 fixed for terminal flips.
  //
  // Pre-lock and best-effort, matching the two coverage guards above: a linked-row
  // lookup hiccup must never turn a legitimate clear into a hard error.
  if (it.onlyIfBlockAttributedTo && it.status === 'todo') {
    try {
      const linked = await findAllLinkedWorkItems(it.slug, it.itemId);
      const stillBlocking = linked.filter(
        (wi) => wi.id !== it.onlyIfBlockAttributedTo && PLAN_BLOCKED_STATUSES.has(wi.state),
      );
      if (stillBlocking.length > 0) {
        return {
          ok: true,
          slug: it.slug,
          itemId: it.itemId,
          skipped: 'blocked_coverage_guard',
          coveredBy: stillBlocking.map((wi) => wi.id),
          reason:
            `left blocked — ${stillBlocking.length} other linked work-item(s) ` +
            `(${stillBlocking.map((wi) => wi.id).join(', ')}) are still blocked; ` +
            `clearing ${it.onlyIfBlockAttributedTo}'s blocker must not un-block a plan item ` +
            'the others still gate',
        };
      }
    } catch (e) {
      console.warn(
        `[plans:set-status] blocked coverage guard ${it.slug}#${it.itemId} failed:`,
        (e as Error)?.message ?? e,
      );
    }
  }

  // EI-21817168412278643: D-019 permits a dropped operational plan item only
  // when its unperformed obligation remains owned by a NON-TERMINAL follow-up.
  // The existing terminal reconciler correctly closes a dropped item's linked
  // feature work-item as stale residue. If the drop note routes the obligation
  // to that same linked row, those two correct rules compose into silent loss.
  // Refuse before the plan lock so the caller must route to an independently
  // owned/unbound follow-up instead. A normal automated drop reflection does
  // not trip this: its note says "completed", not "routed/follow-up".
  if (it.status === 'dropped') {
    const routeText = [it.note, it.rationale].filter(Boolean).join('\n');
    if (routedWorkItemRefs(routeText).length > 0) {
      try {
        const linked = await findAllLinkedWorkItems(it.slug, it.itemId);
        const conflict = routedFollowUpConflict(routeText, linked);
        if (conflict) {
          return {
            ok: false,
            slug: it.slug,
            itemId: it.itemId,
            error: 'routed_follow_up_conflict',
            routedWorkItem: conflict.id,
            routedWorkItemState: conflict.state,
            reason:
              `drop refused — routed follow-up ${conflict.id} is still non-terminal ` +
              `(${conflict.state}) and is also linked to ${it.slug}#${it.itemId}; ` +
              'dropping this plan item would reconcile that obligation as stale residue. ' +
              'Route the obligation to an independently owned/unbound follow-up first.',
          };
        }
      } catch (e) {
        // This is a safety guard, not a best-effort advisory: when the caller
        // explicitly says the drop routes an obligation, an unreadable linked
        // set cannot prove that the target is safe to destroy.
        console.warn(
          `[plans:set-status] routed follow-up guard ${it.slug}#${it.itemId} failed:`,
          (e as Error)?.message ?? e,
        );
        return {
          ok: false,
          slug: it.slug,
          itemId: it.itemId,
          error: 'routed_follow_up_unreadable',
          reason:
            `drop refused — could not verify whether the routed follow-up for ${it.slug}#${it.itemId} ` +
            'is also linked to this plan item; retry after the linked-work-item read succeeds.',
        };
      }
    }
  }

  const rev = planRevisionCapture(ctx as PlanRevisionCtx, it.slug, it.rationale, harnessSlug ? { harnessSlug } : {});
  let carryRequired = false;
  markPhase('preWrite');
  const result = await withPlanLock<SetStatusValue>(
    ctx as never,
    {
      slug: it.slug,
      intent: `plans:set-status ${it.itemId} → ${it.status}`,
      ...(harnessSlug ? { harnessSlug } : {}),
      afterWrite: rev.afterWrite,
      inTransaction: async (tx, _writtenBody, scope, value) => {
        if (value.ok && carryRequired) {
          const carry = await ensureAcceptanceDrainCarryInTransaction(tx, {
            workspaceId: scope.workspaceId,
            harnessSlug: scope.harnessSlug,
            planSlug: it.slug,
            accountableOwnerId: agentId && !agentId.ownerId.startsWith('system:') &&
              !isEphemeralMcpCallIdentity(agentId.ownerId) ? agentId.ownerId : null,
          });
          value.acceptanceCarry = { outcome: carry.outcome, id: carry.id };
        }
      },
    },
    async (current): Promise<{ newBody: string | null; value: SetStatusValue }> => {
      if (current === null) {
        return { newBody: null, value: { ok: false, code: 'not_found' } };
      }
      const { newBody, found, oldStatus } = flipStatusInBody(current, it.itemId, it.status, inlineNote);
      if (!found) {
        return { newBody: null, value: { ok: false, code: 'item_not_found' } };
      }
      // COMPARE-AND-SET first (P-011): when the caller recorded what it saw,
      // a divergence means the report is stale and the write would overwrite
      // newer work. Evaluated ahead of the onlyIf* guards because it is the
      // stronger statement — those ask "is this flip safe in general", this
      // asks "is the world still what I measured".
      if (expectedStatusMismatch({ expectedStatus: it.expectedStatus, currentStatus: oldStatus })) {
        return {
          newBody: null,
          value: {
            ok: false,
            code: 'expected_status_mismatch',
            currentStatus: oldStatus,
            expectedStatus: it.expectedStatus as string,
          },
        };
      }
      const parentStatus = parsePlan(current, { filePath: it.slug + '.md' }).frontmatter.status;
      const parentChildChanges = findTerminalPlanChildMutations(
        parentStatus,
        [{ id: it.itemId, status: oldStatus }],
        [{ id: it.itemId, status: it.status }],
      );
      if (parentStatus && parentChildChanges.length > 0) {
        return {
          newBody: null,
          value: {
            ok: false,
            code: 'terminal_parent_child_mutation',
            parentStatus,
            changes: parentChildChanges,
          },
        };
      }
      // Non-destructive flip: refuse to move an item OFF a terminal status.
      // Read INSIDE the lock (like drainedPlan/wipItemText above) so the decision is
      // race-safe against a concurrent flip rather than a stale pre-lock read.
      //
      // Why this exists: an AUTOMATED reflection must never un-finish shipped work.
      // `work_items:release` is an OWNERSHIP event — it carries no information about
      // completion — but plan-items/reflect-rules.ts reflected it as a flat
      // `status:'todo'`, guarded only on the WORK-ITEM's state, never the plan item's.
      // So releasing a stale non-terminal work-item silently de-completed an already
      // `done` plan item, which then re-entered the claimable pool (duplicate work) and
      // dragged every item blocked-by it into a false `blocked`. Observed live on
      // memory-write-latency-2026-07-26#P-007 (deployed and serving, reverted to `todo`
      // by the release of WI-6211).
      //
      // Only NON-terminal targets are guarded: a terminal→terminal correction
      // (done→dropped) is a legitimate reclassification and still goes through.
      if (
        terminalGuardTrips({
          onlyIfNotTerminal: it.onlyIfNotTerminal,
          currentStatus: oldStatus,
          nextStatus: it.status,
        })
      ) {
        return { newBody: null, value: { ok: false, code: 'terminal_guard', currentStatus: oldStatus } };
      }
      // Non-destructive flip: refuse to weaken an explicit blocked/needs-human gate.
      // Read INSIDE the lock (like the terminal/completed guards above) so a concurrent
      // gate or reopen cannot make this decision from a stale pre-lock status.
      if (
        blockedGuardTrips({
          onlyIfNotBlocked: it.onlyIfNotBlocked,
          currentStatus: oldStatus,
          nextStatus: it.status,
        })
      ) {
        return {
          newBody: null,
          value: {
            ok: false,
            code: 'blocked_guard',
            currentStatus: oldStatus,
            refusal: {
              observed: { currentStatus: oldStatus, requestedStatus: it.status, onlyIfNotBlocked: String(it.onlyIfNotBlocked ?? false) },
              liftsWhen: 'the item leaves blocked/needs-human (its explicit gate is lifted), or the flip is made without onlyIfNotBlocked by a caller deliberately reopening or completing the gate',
              whoCanMakeItTrue: ['owner', 'another-agent'],
            },
          },
        };
      }
      // ATTRIBUTED CLEAR (D-001). The mirror of the guard above: `onlyIfNotBlocked`
      // protects a block from being weakened, this one permits exactly ONE reflection to
      // lift the block it is responsible for. Read INSIDE the lock, from `current` (the
      // PRE-flip body) — the note is what we are attributing on, and the flip about to be
      // written would overwrite it.
      //
      // Without an attributed clear the blocker reflection is one-way: `setStatusArgs`
      // sets `onlyIfNotBlocked` on every reflection, so a plan item parked by a blocker
      // could never be un-parked by that blocker clearing. Shipping the park half alone
      // would have parked ~45 measured plan items with no automatic route back to `todo`.
      if (
        blockAttributionTrips({
          onlyIfBlockAttributedTo: it.onlyIfBlockAttributedTo,
          currentStatus: oldStatus,
          nextStatus: it.status,
          currentItemText: parsePlan(current).items.find((pi) => pi.id === it.itemId)?.text,
        })
      ) {
        return {
          newBody: null,
          value: { ok: false, code: 'block_attribution_guard', currentStatus: oldStatus },
        };
      }
      // EI-20129670928216719: an automated cascade must never downgrade FINISHED work.
      // Checked here, inside the lock, because it reads the PLAN ITEM's current status —
      // the coverage guard's pre-lock read would race a concurrent flip. See
      // `completedGuardTrips` for why neither existing guard covers this.
      if (
        completedGuardTrips({
          onlyIfNotCompleted: it.onlyIfNotCompleted,
          currentStatus: oldStatus,
          nextStatus: it.status,
        })
      ) {
        return { newBody: null, value: { ok: false, code: 'completed_guard', currentStatus: oldStatus } };
      }
      // Return the item's actual importance on every successful flip. The
      // needs-human push gate uses the same value, but callers also rely on
      // this response field for routine and terminal status updates.
      const importance = itemImportance(current, it.itemId);
      // A repeated reflection can ask for the status and note the item already has.
      // Treat byte-identical content as a successful no-op so an idempotent call does
      // not bump `updated`, the plan version, or the BAR approval subject revision.
      if (newBody === current) {
        return {
          newBody: null,
          value: {
            ok: true,
            oldStatus,
            newStatus: it.status,
            itemId: it.itemId,
            importance,
            drainedPlan: false,
          },
        };
      }
      let finalBody = bumpUpdatedDate(newBody);
      // Preserve accountability BEFORE releasing the implementation claim. The
      // same parser-owned transition serves direct writes and the backstop;
      // final item + lifecycle + carry filing commit together or not at all.
      if (isTerminalStatus(it.status) !== (oldStatus !== null && isTerminalStatus(oldStatus))) {
        const drain = planDrainTransitionMutation(finalBody);
        if (drain.newBody !== null) finalBody = drain.newBody;
        carryRequired = drain.value.to === 'awaiting-acceptance' &&
          parsePlan(finalBody).frontmatter.template !== 'rubric';
      }
      // WI-1830: on a real →done edge, does this flip leave the plan with zero open
      // (non-terminal) items? Computed here, INSIDE the lock, off the just-written body so
      // it is race-safe against concurrent flips (the plan lock serializes writes). The
      // parse runs only on a →done edge, so routine flips skip it.
      const drainedPlan =
        it.status === 'done' && oldStatus !== 'done' ? isPlanDrained(parsePlan(finalBody).items) : false;
      // P-008: capture the item text ONLY on a real →wip edge (the "picking up
      // work" signal) so the claim-time recall port can query it — no second
      // read, and no parse cost on routine flips.
      const wipItemText =
        it.status === 'wip' && oldStatus !== 'wip'
          ? parsePlan(finalBody).items.find((pi) => pi.id === it.itemId)?.text
          : undefined;
      return {
        newBody: finalBody,
        value: {
          ok: true,
          oldStatus,
          newStatus: it.status,
          itemId: it.itemId,
          importance,
          drainedPlan,
          ...(wipItemText ? { wipItemText } : {}),
        },
      };
    },
  );
  markPhase('planWrite');

  if (result.kind === 'busy') {
    const claimRollback = await releaseNewWipClaim();
    return {
      ok: false,
      slug: it.slug,
      itemId: it.itemId,
      error: 'busy',
      ...claimRollback,
      busy: result.busy.map((b) => ({
        path: b.path,
        owner_label: b.owner_label,
        intent: b.intent,
        expires_ts: b.expires_ts,
      })),
    };
  }

  if (!result.value.ok) {
    const claimRollback = await releaseNewWipClaim();
    // A tripped terminal guard is a deliberate NO-OP, not a failure: the caller asked
    // for a non-destructive flip and the item was already finished. Reported ok:true so
    // an automated reflection does not read as broken (and does not get retried), but
    // with `skipped` so the no-op is visible rather than silent.
    if (result.value.code === 'terminal_guard') {
      return {
        ok: true,
        slug: it.slug,
        itemId: it.itemId,
        skipped: 'terminal_guard',
        currentStatus: result.value.currentStatus,
        ...claimRollback,
        reason: `left at \`${result.value.currentStatus}\` — already terminal, and this flip (\`${it.status}\`) would have un-finished it`,
      };
    }
    // Same posture as the terminal guard: a deliberate NO-OP, reported ok:true with
    // `skipped` so an automated reflection neither reads as broken nor gets retried.
    if (result.value.code === 'blocked_guard') {
      return {
        ok: true,
        slug: it.slug,
        itemId: it.itemId,
        skipped: 'blocked_guard',
        currentStatus: result.value.currentStatus,
        refusal: result.value.refusal,
        ...claimRollback,
        reason:
          `left at \`${result.value.currentStatus}\` — this explicit gate was preserved; ` +
          `the automated flip (\`${it.status}\`) would have weakened it`,
      };
    }
    // Attributed clear declined (D-001): the item IS blocked, but not by the work-item
    // asking to lift it. Same ok:true posture as every other guard — a deliberate no-op,
    // reported so it is visible rather than silent.
    if (result.value.code === 'block_attribution_guard') {
      return {
        ok: true,
        slug: it.slug,
        itemId: it.itemId,
        skipped: 'block_attribution_guard',
        currentStatus: result.value.currentStatus,
        ...claimRollback,
        reason:
          `left at \`${result.value.currentStatus}\` — the live note does not attribute this ` +
          `block to ${it.onlyIfBlockAttributedTo}` +
          (result.value.currentStatus === 'needs-human'
            ? ', and `needs-human` is never cleared automatically'
            : ', so it was set for another reason and only that reason should lift it'),
      };
    }
    // Same posture as the terminal guard: a deliberate NO-OP, reported ok:true with
    // `skipped` so the automated reflection neither reads as broken nor gets retried.
    if (result.value.code === 'completed_guard') {
      return {
        ok: true,
        slug: it.slug,
        itemId: it.itemId,
        skipped: 'completed_guard',
        currentStatus: result.value.currentStatus,
        ...claimRollback,
        reason:
          'left at `done` — finished work is never downgraded to `dropped` by an automated ' +
          'cascade; the work-item being dropped is not the one that completed this item',
      };
    }
    // COMPARE-AND-SET refusal (P-011). ok:FALSE, unlike every guard above: the
    // caller asked to write a recorded observation and the world moved, so this
    // is a real failure it must surface and re-check — not a no-op to swallow.
    // Carries both statuses so the caller can say what changed without a re-read.
    if (result.value.code === 'expected_status_mismatch') {
      return {
        ok: false,
        slug: it.slug,
        itemId: it.itemId,
        error: 'expected_status_mismatch',
        currentStatus: result.value.currentStatus,
        expectedStatus: result.value.expectedStatus,
        ...claimRollback,
        reason:
          `not applied — this item was \`${result.value.expectedStatus}\` when the report was ` +
          `written and is \`${result.value.currentStatus ?? 'unknown'}\` now; applying it would ` +
          'have overwritten newer work',
      };
    }
    if (result.value.code === 'terminal_parent_child_mutation') {
      return {
        ok: false,
        slug: it.slug,
        itemId: it.itemId,
        error: result.value.code,
        parentStatus: result.value.parentStatus,
        changes: result.value.changes,
        ...claimRollback,
        reason:
          'not applied — the parent plan remains ' +
          result.value.parentStatus +
          '; change its lifecycle status explicitly before reopening this item',
      };
    }
    return { ok: false, slug: it.slug, itemId: it.itemId, error: result.value.code, ...claimRollback };
  }

  // `result.value` is now narrowed to the ok-variant by the guard above.
  // A wip auto-conversion is a second durable side effect. Run it only after the
  // plan/item write succeeded: an unknown plan or item must leave neither a lease
  // nor a converted work-item behind (WI-10002606).
  if (agentId && claim && it.status === 'wip' && claimScope) {
    const autoConvert = await getFlag(FLAGS.PLAN_ITEM_CLAIM_AUTO_CONVERT, 'system').catch(() => false);
    if (autoConvert) {
      const converted = await convertPlanItem({
        workspaceId: claimScope.workspaceId,
        harnessSlug: claimScope.harnessSlug,
        planSlug: it.slug,
        itemId: it.itemId,
        owner: agentId.ownerId,
        ownerLabel: agentId.ownerLabel,
        ownerName: claimOwnerName,
        ownerUser: bestEffortOwnerUser(ctx),
        // Built by the shared helper, not a literal, so the non-conflict holder
        // projection can tell this MECHANISM string apart from a declared goal
        // (P-029/D-060) without a detector that drifts from the writer.
        intent: autoConvertClaimIntent(it.itemId),
      }).catch((e) => {
        console.warn(`[plans:set-status] auto-convert ${it.slug}#${it.itemId} failed:`, (e as Error)?.message ?? e);
        return null;
      });
      // EI-22427741014249929: report what the auto-convert did to the EXECUTION
      // RECORD. Both branches were previously silent — the refusal because the
      // result was discarded, the takeover because it did not exist as a concept.
      if (converted?.status === 'refused' && converted.assignee) {
        executionRecord = {
          outcome: 'held-by-live-peer',
          workItemId: null,
          heldBy: converted.assignee,
          note: converted.reason,
        };
      } else if (
        (converted?.status === 'resumed' || converted?.status === 'converted') &&
        converted.executionRecordTakeover
      ) {
        const t = converted.executionRecordTakeover;
        executionRecord = {
          outcome: 'taken-over',
          workItemId: t.workItemId,
          priorHolder: t.priorHolder,
          basis: t.basis,
        };
      }
    }
  }
  markPhase('autoConvert');

  if (result.value.oldStatus !== it.status) {
    await emitPlanEventForCaller(ctx, {
      planSlug: it.slug,
      event: 'item_status_changed',
      before: result.value.oldStatus,
      after: it.status,
      detail: it.itemId,
    });
  }

  // See `shouldFirePlanItemDone` for the edge gate this call depends on.
  // P-105: plan-item:done:<slug>:<id> — wake anyone awaiting this item (a peer's lane,
  // a cross-plan blocking dependency) the moment it flips to done, instead of polling
  // plans:get. Transition-gated: a real →done edge only, never a re-set of an
  // already-done item. Fire-and-forget; never fails the flip.
  if (shouldFirePlanItemDone(it.status, result.value.oldStatus)) {
    emitPlanItemDoneEvent(it.slug, it.itemId);
    // WI-1830: if that →done flip drained the whole plan (zero open items left, computed
    // race-safe inside the lock above), fire `fleet:drained:<slug>` for each fleet whose
    // lane thereby drained — so a leader awaiting it wakes exactly once, instead of polling
    // fleet:assignments. Fire-and-forget; never fails the flip.
    if (result.value.drainedPlan) {
      emitFleetDrainedForPlan(it.slug);
    }
  }

  // EI-14699: reflect a plan-item block/unblock onto its linked work_item so the
  // two tracking surfaces can't drift apart. Without this, flipping the plan item
  // to blocked/needs-human left the converted work_item's own `state` claimable,
  // so scheduler:get_next / work-item:claimable kept re-serving it → perpetual
  // claim/release ping-pong (WI-3475/WI-3467 each cycled 8+ times). Transition- and
  // current-state-gated by planSyncWorkItemState so a routine re-set never disturbs
  // a work_item already placed correctly (wip/terminal/etc). Awaited but fully
  // fail-safe: a lookup/write hiccup NEVER fails the plan-status flip.
  let workItemSynced: { id: string; state: 'blocked' | 'open' } | undefined;
  {
    // Cheap pre-gate: only a block/unblock EDGE can ever sync, so skip the PG lookup
    // for every other flip (done/wip/re-set) — the vast majority. The authoritative
    // decision is planSyncWorkItemState re-run below with the work_item's REAL state.
    const isBlockEdge = PLAN_BLOCKED_STATUSES.has(it.status) && result.value.oldStatus !== it.status;
    const isUnblockEdge =
      it.status === 'todo' && result.value.oldStatus !== null && PLAN_BLOCKED_STATUSES.has(result.value.oldStatus);
    if (isBlockEdge || isUnblockEdge) {
      try {
        const scope = await resolvePlanScope(harnessSlug ? { harnessSlug } : {});
        const linked = await findConvertedWorkItemByStamp(it.slug, it.itemId, scope.harnessSlug);
        if (linked && !TERMINAL_WORK_ITEM_STATES.has(linked.state)) {
          const target = planSyncWorkItemState(result.value.oldStatus, it.status, linked.state);
          if (target && target !== linked.state) {
            const updated = await setWorkItemState(linked.id, target, {
              harness: linked.harness ?? undefined,
              by: 'plan-item-status-sync',
            });
            if (updated) workItemSynced = { id: linked.id, state: target };
          }
        }
      } catch (e) {
        console.warn(
          `[plans:set-status] work_item block-sync ${it.slug}#${it.itemId} → ${it.status} failed:`,
          (e as Error)?.message ?? e,
        );
      }
    }
  }

  // WI-40558: run the canonical lane reconciler only AFTER withPlanLock has
  // returned, which is the commit boundary. The post-invoke reaction rules stay
  // as the generic/backstop path, but they are scheduled while this tool's
  // dispatch transaction is still settling; their fresh plan re-read can race
  // the commit and classify the OLD lane. Live repro left P-007 effective=wip
  // with blockers=0 while its linked WI-40447 retained an active plan-lane gate.
  //
  // Reuse the same resync functions the reaction builtin calls. This is
  // transition-gated, awaited, and fail-soft: the caller sees committed plan
  // state before we reconcile the item itself and any direct dependents whose
  // readiness changed on a terminality edge.
  // EI-22178190387074148: captured so the caller-visible result can REPORT this
  // cascade (which linked work-items it terminal-closed, and which it left open
  // because their own state is the authority) instead of the mutation happening
  // silently — the caller previously had no signal that a second, consequential
  // write occurred and had to independently re-read the linked item to discover it.
  let cascade: ReconcileLinkedWorkItemsResult | undefined;
  if (result.value.oldStatus !== it.status) {
    try {
      const terminalStatus = it.status === 'done' || it.status === 'dropped' ? it.status : null;
      if (terminalStatus) {
        // EI-21662817593464724: a terminal plan-item edge must settle its linked
        // work-items before this write returns. The event reaction + periodic orphan
        // sweep remain backstops, but leaving the only direct call on the non-terminal
        // lane synchronizer created a deterministic stale-open window after every
        // plans:set-status →done/→dropped. Reuse the canonical reconciler so its
        // current-assignee and proof guards remain the single safety policy.
        cascade = await reconcileLinkedWorkItemsForPlanItem(
          { planSlug: it.slug, itemId: it.itemId, harnessSlug: harnessSlug ?? null },
          { knownTerminalStatus: terminalStatus },
        );
      } else {
        await resyncPlanItemLaneNow(it.slug, it.itemId, harnessSlug ?? null);
      }
      const oldTerminal = result.value.oldStatus !== null && isTerminalStatus(result.value.oldStatus);
      if (oldTerminal !== isTerminalStatus(it.status)) {
        await resyncDependentPlanItemLanesNow(it.slug, it.itemId, harnessSlug ?? null);
      }
    } catch (e) {
      console.warn(
        `[plans:set-status] post-commit lane resync ${it.slug}#${it.itemId} failed:`,
        (e as Error)?.message ?? e,
      );
    }
  }
  markPhase('eventAndReconcile');

  // Push the new item state to any live `useSyncQuery('planItems.byPlan')`
  // subscriber (the Create-tab kanban). The `items` jsonb was already
  // re-projected synchronously inside the lock above, so a re-pull is fresh.
  // Fire-and-forget + fail-safe: a sync-bus hiccup never fails a status flip,
  // and this is the SAME path the UI drag and an agent's plans:set-status both
  // take, so the board moves live for either.
  void (async () => {
    const { notifySyncInvalidate } = await import('../../sync-sse');
    await notifySyncInvalidate('planItems.byPlan', { planSlug: it.slug });
  })().catch((e) => console.warn('[plans:set-status] sync invalidate failed:', (e as Error)?.message ?? e));

  // P-020 (planning-attention-importance): push a notification when an
  // item transitions INTO needs-human at importance >= high — the
  // urgent/high human-decision signal that has no push trigger today (the
  // device-intervention-watcher only covers escalation / smoke / plan-
  // review, which are all already high-importance). Additive: a plan item
  // is a source the watcher never polls, so there's no overlap and no
  // double-fire. Transition-gated (a re-set of an already-needs-human item
  // won't re-push) and fully fail-safe (a push error never fails the
  // status flip). Reuses the proven mobile notifyWorkspace delivery, which
  // is a no-op when no device is paired. Retiring the watcher's 60s poll
  // in favour of producer-time emits for its own triggers is P-021; a
  // desktop-native Tauri notification channel is D-007 — both still open.
  const v = result.value;
  if (shouldPushNeedsHuman(v.oldStatus, v.newStatus, v.importance)) {
    void (async () => {
      const { notifyAttention } = await import('../../attention-notify');
      await notifyAttention({
        kind: 'needs-human',
        title: v.importance === 'urgent' ? 'Urgent: needs your decision' : 'Needs your attention',
        body: `${it.slug} · ${it.itemId} (${v.importance}) is waiting on you.`,
        importance: v.importance,
        data: { plan: it.slug, item: it.itemId },
      });
    })().catch((e) => console.warn('[plans:set-status] needs-human push failed:', (e as Error)?.message ?? e));
  }

  // EI-18655063958515097 (residual-coverage guard): "a residual split off a closing
  // plan item silently leaves the lane — no plan link, not claimable, parent reads
  // done while its acceptance ask is unmet". Non-blocking (mirrors the
  // duplicateOfWarning convention in work_items/complete.ts) — never refuses the
  // flip, just surfaces the mismatch in the response the instant it happens instead
  // of it surfacing later as an orphaned untracked item at release time. Two cases:
  //   1. A work-item already COVERS this plan item (via plan_item/targetPlanItem's
  //      `relates` edge) but is still non-terminal — closing anyway means the plan
  //      will read as fully satisfied while that linked work remains open.
  //   2. Nothing covers this plan item, but the closer's own note/rationale reads
  //      like an unmet acceptance criterion was split off — the exact "bare residual,
  //      no plan link" failure the bug describes.
  // Best-effort: a lookup hiccup never fails the status flip.
  let residualWarning: string | undefined;
  if (isTerminalStatus(it.status) && result.value.oldStatus !== it.status) {
    try {
      const coverage = await findCoverageWorkItems(it.slug, it.itemId);
      const openCoverage = coverage.filter((wi) => !TERMINAL_WORK_ITEM_STATES.has(wi.state));
      if (openCoverage.length > 0) {
        // The done reaction runs after this tool returns and may reconcile some
        // linked coverage rows as residue. Reporting every row as work that must
        // stay open is backwards for those rows (EI-20391344760498156): the
        // warning was observed immediately before the same operation auto-closed
        // WI-38675. Keep the warning conservative when the proof lookup fails,
        // but distinguish rows the reconciler will actually settle from rows it
        // deliberately preserves for follow-up.
        let reconciledAsResidue = new Set<string>();
        if (it.status === 'done') {
          try {
            const linked = await findAllLinkedWorkItems(it.slug, it.itemId);
            const linkedById = new Map(linked.map((wi) => [wi.id, wi]));
            reconciledAsResidue = new Set(
              openCoverage
                .filter((wi) => {
                  const candidate = linkedById.get(wi.id);
                  if (!candidate || candidate.assignee || wi.assignee) return false;
                  // EI-22178190387074148: mirrors the reconciler's gated-state
                  // guard too — a `blocked`/`needs-human` linked item is left
                  // open, not reconciled as residue.
                  if (candidate.state === 'blocked' || candidate.state === 'needs-human') return false;
                  // This mirrors reconcileLinkedWorkItemsForPlanItem: feature
                  // rows are stamp-borne by design; issue rows need an explicit
                  // `implements` edge so a discovered bug is never buried.
                  return candidate.family !== 'issue' || candidate.viaImplementsEdge;
                })
                .map((wi) => wi.id),
            );
          } catch (e) {
            console.warn(
              `[plans:set-status] residual-reconcile classification ${it.slug}#${it.itemId} failed:`,
              (e as Error)?.message ?? e,
            );
          }
        }

        const reconciledIds = openCoverage.filter((wi) => reconciledAsResidue.has(wi.id)).map((wi) => wi.id);
        const retainedIds = openCoverage.filter((wi) => !reconciledAsResidue.has(wi.id)).map((wi) => wi.id);
        if (reconciledIds.length > 0) {
          residualWarning =
            `${it.itemId} is closing (${it.status}) while ${reconciledIds.length} linked coverage work-item(s) ` +
            `(${reconciledIds.join(', ')}) are non-terminal at check time and will be auto-resolved as residue ` +
            `by the terminal plan-item reaction.`;
          if (retainedIds.length > 0) {
            residualWarning +=
              ` The remaining linked item(s) (${retainedIds.join(', ')}) are not eligible for that reconciliation ` +
              `and require follow-up.`;
          }
        } else {
          residualWarning =
            `${it.itemId} is closing (${it.status}) while ${openCoverage.length} linked coverage work-item(s) ` +
            `(${openCoverage.map((w) => w.id).join(', ')}) remain non-terminal — the plan will read as fully ` +
            `satisfied even though that work is still open. Confirm they're genuinely out of scope, or hold this ` +
            `item open until they close.`;
        }
      } else if (looksLikeResidualClosure(`${it.note ?? ''} ${it.rationale ?? ''}`)) {
        residualWarning =
          `${it.itemId}'s note/rationale reads like an unmet acceptance criterion was split off, but no ` +
          `linked work-item covers this plan item — file it via work_items:create { plan_item: { slug: ` +
          `'${it.slug}', item: '${it.itemId}' } } (or targetPlanItem) so the residual stays claimable and ` +
          `tracked instead of surfacing later as an orphaned, untracked item (EI-18655063958515097).`;
      }
    } catch (e) {
      console.warn(
        `[plans:set-status] residual-coverage check ${it.slug}#${it.itemId} failed:`,
        (e as Error)?.message ?? e,
      );
    }
  }

  // Terminal flip → release the caller's claim AND clear the item's durable
  // assignment (claim-discipline: done means nobody holds it; EI-2298: a
  // done/dropped item must also be assigned to no one — otherwise it sits
  // assigned-idle forever and a dispatcher that re-pokes assigned-idle items
  // re-targets the stale assignee endlessly). Scope is resolved only on a
  // terminal flip; both legs are awaited but fail-safe.
  let claimReleased = false;
  let assignmentReleased = false;
  if (isTerminalStatus(it.status)) {
    const scope = await resolvePlanScope(harnessSlug ? { harnessSlug } : {});
    ({ claimReleased, assignmentReleased } = await releaseTerminalGrips({
      status: it.status,
      agentOwnerId: agentId?.ownerId ?? null,
      scope,
      slug: it.slug,
      itemId: it.itemId,
      releaseClaim: releaseOwnClaim,
      clearAssignment: unassignItem,
    }));
  } else if (agentId && it.status === 'todo') {
    const scope = await resolvePlanScope(harnessSlug ? { harnessSlug } : {});
    ({ claimReleased } = await releaseTodoClaim({
      status: it.status,
      agentOwnerId: agentId.ownerId,
      scope,
      slug: it.slug,
      itemId: it.itemId,
      releaseClaim: releaseOwnClaim,
    }));
  }

  // Claim-time recall port (memory-delivery-unification-2026-07-12 P-008 /
  // D-006): a →wip flip auto-claims the item — the "picking up work" signal —
  // so piggyback a targeted memory recall for that item on the response.
  // Deadline-bounded, epoch-deduped (port 'claim'), never-throws. Only when the
  // flip actually auto-claimed (agentId + wip) and captured the item text.
  let memory: string | null = null;
  if (agentId && claim && result.value.ok && result.value.wipItemText) {
    memory = await import('../../memory/claim-port')
      .then((m) =>
        m.buildClaimRecallBlock({
          sessionId: agentId.ownerId,
          workspaceId: agentId.workspaceId,
          items: [
            {
              id: it.itemId,
              title: result.value.ok ? result.value.wipItemText : undefined,
              harness: harnessSlug ?? null,
            },
          ],
        }),
      )
      .catch(() => null);
  }

  const typeEvidenceWarning = typeEvidenceWarningForPlanItem({
    ref: `${it.slug}#${it.itemId}`,
    oldStatus: result.value.oldStatus,
    newStatus: it.status,
    verification: it.verification,
  });

  // P-031 (merged into P-030 by D-005): dropping an item is a SCOPE write — it can leave a
  // BAR mapped only to dropped items (bar_snapshot_mapping_dropped_only). Re-read the live
  // BAR readiness in this same call, restamp the plan's Now (which orient folds), and carry
  // the codes on the response. Runs after the plan lock is released; never throws.
  let barReadiness: BarReadinessResult | undefined;
  const lockScope = result.scope as typeof result.scope | undefined;
  if (it.status === 'dropped' && result.value.oldStatus !== 'dropped' && lockScope) {
    let actor = 'system:scope-write-cascade';
    try {
      actor = resolveAgentIdentity(ctx).ownerId;
    } catch {
      /* unattributable caller: the Now stamp falls back to the system actor */
    }
    barReadiness = await reevaluateBarReadinessOnScopeWrite(
      {
        workspaceId: lockScope.workspaceId,
        harnessSlug: lockScope.harnessSlug,
        planSlug: it.slug,
        cause: 'item-dropped',
      },
      defaultBarReadinessDeps(ctx, actor),
    );
  }

  // WI-10005199 (generalizing EI-23770243810745552): `ok` here proves only that the plan BODY
  // write landed. Every consumer (plans:get-item / plans:items / lane derivation / the ship
  // gate) reads the derived `items` index + blocked-by graph instead, so re-read it the way a
  // consumer does and surface a `consumerView` ONLY when it disagrees with what was written.
  // One bounded, fail-soft read per landed flip (never memoized across a batch — item N+1's
  // write invalidates a row cached after N); exception-only so an agreeing flip is unchanged.
  const consumerAttestation = result.value.ok
    ? await attestLandedPlanItemStatus({
        slug: it.slug,
        itemId: it.itemId,
        status: it.status,
        read: planItemConsumerReaderFor(sctx),
      })
    : undefined;
  markPhase('consumerView');

  markPhase('finalize');
  const totalMs = Math.round(Math.max(0, lastPhaseAtMs - startedAtMs));
  const slowPathTiming = totalMs >= 10_000 ? { totalMs, phasesMs } : null;
  if (slowPathTiming) {
    console.warn(`[plans:set-status] slow ${it.slug}#${it.itemId} ${JSON.stringify(slowPathTiming)}`);
  }

  return {
    slug: it.slug,
    ...result.value,
    filePath: result.filePath,
    revision: rev.recorded.current ? { seq: rev.recorded.current.seq } : null,
    ...(claim ? { claim } : {}),
    ...(executionRecord ? { executionRecord } : {}),
    ...(claimReleased ? { claimReleased } : {}),
    ...(assignmentReleased ? { assignmentReleased } : {}),
    ...(workItemSynced ? { workItemSynced } : {}),
    ...(memory ? { memory } : {}),
    // EI-22178190387074148: report the terminal-reconcile cascade instead of
    // leaving it silent — ids it actually closed (with the system actor that
    // closed them, `RECONCILER_SYSTEM_ACTOR`), and ids it deliberately left open
    // because their own state (`blocked`/`needs-human`) is the authority.
    ...(cascade && cascade.reconciled.length > 0
      ? { cascadeReconciled: cascade.reconciled, cascadeReconciledBy: RECONCILER_SYSTEM_ACTOR }
      : {}),
    ...(cascade && cascade.skippedGatedState.length > 0
      ? { cascadeSkippedGatedState: cascade.skippedGatedState }
      : {}),
    ...(residualWarning ? { residualWarning } : {}),
    ...(typeEvidenceWarning ? { typeEvidenceWarning } : {}),
    ...(barReadiness ? { barReadiness } : {}),
    ...(consumerAttestation ?? {}),
    ...(slowPathTiming ? { slowPathTiming } : {}),
    ...(noteTruncated
      ? {
          noteTruncated: true,
          noteHint:
            'inline note truncated to 1000 chars — put the long form in `rationale` (stored on the plan revision, not the item line).',
        }
      : {}),
  };
}

export default defineTool({
  name: 'plans:set-status',
  description:
    "Flip one or many item statuses; auto-bumps frontmatter `updated:`. `dropped` requires a nonblank `note` or `rationale`; `done` accepts structured `verification` and returns advisory `typeEvidenceWarning` for missing or unit-only TypeScript evidence. `wip` auto-claims; `done`/`dropped` release the claim and clear assignment. A live peer claim yields per-item `claim_conflict`. Single: { slug, item, status }. Same-plan batch: { slug, itemIds:[…], status }. Mixed batch: items:[{ slug, item, status }]. Returns { ok, results:[{ ok, slug, itemId, oldStatus, newStatus, … | error }], counts } — correlate by { slug, itemId }, not position; one failure never fails the batch.",
  guidance: {
    when: "An item's status changes — picking up (todo→wip, which also claims it), completing (wip→done), intentionally departing (→dropped with `note` preferred or `rationale` required), gating on a human (→needs-human), or recording external blockage (→blocked). Flip several at once via itemIds:[…] (one plan) or items:[…].",
    notWhen:
      'You want to add a brand-new item — use plans:add-item. Or to change scope of the work — edit the item text directly in the file.',
    chaining:
      'plans:items { actionable: true } → plans:set-status { item, status: "wip" } when picking up (the wip flip claims it — no separate plan_items:claim needed). On claim_conflict, coordinate only when a holder is returned; if claimHold is present, inspect its provenance and use work_items:hold_open only when clearing the park is appropriate.',
    seeAlso: [
      'plans:set-now (narrate the state change for the human-facing Now)',
      'plans:add-item (add a brand-new item rather than flip an existing one)',
      'plans:set-importance (re-rank an item without changing its status)',
    ],
  },
  capability: 'plans:write',
  // Idempotent-completion (backend-reliability-100pct-2026-07-03 W6/P-007): a status flip
  // sets the item's status token to a FIXED value (todo/wip/done/…) — re-applying is a
  // no-op, so a write that COMMITTED but whose wall-clock beat the deadline under load is
  // surfaced as its truthful success instead of a spurious `timeout`. This is the fix for
  // the ~280 `plans:set-status` false-timeouts (the write landed; the agent was told it
  // failed and re-dispatched). Inert except in the dispatch abort-race branch.
  idempotent: true,
  requirePrincipal: false,
  agentRoles: [...SU_BEE_ROLES],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    const list: StatusItem[] = args.items?.length
      ? args.items.map((it) => ({
          slug: it.slug,
          itemId: it.item,
          status: (it.status ?? args.status) as string,
          note: it.note ?? args.note,
          harness: it.harness ?? args.harness,
          rationale: it.rationale ?? args.rationale,
          onlyIfNotTerminal: it.onlyIfNotTerminal ?? args.onlyIfNotTerminal,
          onlyIfNotBlocked: it.onlyIfNotBlocked ?? args.onlyIfNotBlocked,
          onlyIfNoOtherOpenCoverage: it.onlyIfNoOtherOpenCoverage ?? args.onlyIfNoOtherOpenCoverage,
          onlyIfNoOtherInFlightCoverage: it.onlyIfNoOtherInFlightCoverage ?? args.onlyIfNoOtherInFlightCoverage,
          onlyIfNotCompleted: it.onlyIfNotCompleted ?? args.onlyIfNotCompleted,
          expectedStatus: it.expectedStatus ?? args.expectedStatus,
          verification: it.verification ?? args.verification,
        }))
      : args.itemIds?.length
        ? args.itemIds.map((itemId) => ({
            slug: args.slug as string,
            itemId,
            status: args.status as string,
            note: args.note,
            harness: args.harness,
            rationale: args.rationale,
            onlyIfNotTerminal: args.onlyIfNotTerminal,
            onlyIfNotBlocked: args.onlyIfNotBlocked,
            onlyIfNoOtherOpenCoverage: args.onlyIfNoOtherOpenCoverage,
            onlyIfNoOtherInFlightCoverage: args.onlyIfNoOtherInFlightCoverage,
            onlyIfNotCompleted: args.onlyIfNotCompleted,
            expectedStatus: args.expectedStatus,
            verification: args.verification,
          }))
        : [
            {
              slug: args.slug as string,
              itemId: args.item as string,
              status: args.status as string,
              note: args.note,
              harness: args.harness,
              rationale: args.rationale,
              onlyIfNotTerminal: args.onlyIfNotTerminal,
              onlyIfNotBlocked: args.onlyIfNotBlocked,
              onlyIfNoOtherOpenCoverage: args.onlyIfNoOtherOpenCoverage,
              onlyIfNoOtherInFlightCoverage: args.onlyIfNoOtherInFlightCoverage,
              onlyIfNotCompleted: args.onlyIfNotCompleted,
              expectedStatus: args.expectedStatus,
              verification: args.verification,
            },
          ];
    const env = await runBulk(list, (it) => setStatusOne(it, ctx), {
      keyOf: (it) => ({ slug: it.slug, itemId: it.itemId }),
    });
    return bulkContent(env);
  },
});
