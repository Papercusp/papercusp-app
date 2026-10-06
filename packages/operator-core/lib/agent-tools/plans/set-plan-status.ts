/**
 * plans:set-plan-status — flip a plan's PLAN-LEVEL frontmatter status,
 * the lifecycle gate the /adv Plans tab surfaces as buckets:
 *
 *   draft → ready      (approve — unlocks Start; does NOT start the plan)
 *   ready → draft      (demote — reverse approval)
 *   any  → shipped     (ship)
 *   any  → superseded  (reject; refuses non-terminal items — EI-19403437795858863)
 *
 * The agent-facing counterpart of the UI's approve / demote / reject
 * affordances — gives scoper/operator/etc. parity with the buttons in
 * PlanActions. Surgical edit of the frontmatter `status:` line only;
 * body + every other frontmatter key preserved verbatim. Writes inside
 * the SU lock, auto-bumps `updated:`, captures a plan revision, and
 * emits a `status_changed` plan-event.
 *
 * NOT for item (P-NNN) status — that's plans:set-status. NOT for legacy
 * plans without frontmatter — convert with plans:set-frontmatter first.
 */

import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { resolveCtxHarnessSlug, resolveEffectiveHarnessSlug } from './_ctx-opts';
import { harnessArg, harnessScopedCtx, resolveHarnessScope } from '../_harness-scope';
import { withPlanLock, bumpUpdatedDate } from './with-plan-lock';
import { emitPlanEventForCaller } from '../coordination/plan-events';
import { planRevisionCapture, type PlanRevisionCtx } from './revisions';
import { clearStartedForTerminalPlan, isTerminalPlanStatus } from './plan-start-state';
import { stampTerminalNowBlock } from './terminal-now-stamp';
import { stampGreenlitNowBlock } from './greenlit-now-stamp';
import { stampForcedPastWaiver, type ForcedPastRecord } from './forced-past-stamp';
import {
  evaluateSupersedeItemGate,
  shouldEvaluateSupersedeItemGate,
} from './supersede-item-gate';
import { resolveAgentIdentity } from '../coordination/identity';
import { emitDeprecateLearnings, type DeprecateLearnings } from '../../harness/improvements/deprecate-learnings';
import { ObservationEvidenceError } from '../../harness/improvements/observation-types';
import {
  evaluatePlanAcceptanceGate,
  type CitationDeployment,
  type PlanAcceptanceRepairAction,
} from '../../plan-acceptance-gate';
import { evidenceCurrentInputSchema } from './spec-evidence-store';
import {
  ACCEPTANCE_GRADING_SWEEP_ACTOR,
  launchAcceptanceGrader,
  resolveAcceptanceGrader,
  type AcceptanceGraderLifecycle,
} from '../../acceptance-grader';
import {
  readAcceptanceGradingSweepState,
  type AcceptanceGradingSweepState,
} from '../../acceptance-grading-sweep-state';
import { evaluateScoutRatificationGate } from '../../scout/ratification-gate';
import { checkPlanAdmission } from './plan-admission-gate';
import { resolvePlanScope } from './source';
import { retireAcceptanceRubricForPlan } from '../../rubrics';
import { restoreHistoricalShipment } from './restore-historical-shipment';
import {
  settleAcceptanceReviewReservationsForPlan,
  type AcceptanceReviewReservationSettlement,
} from '../../coord/condition-upsert';
import {
  reconcileActivationAuditRepairFilingForTerminalPlan,
  type ActivationAuditRepairReconciliation,
} from './activation-audit-repair';
import { bulkContent, mergeIds, runBulk } from '../_bulk';
import { domainFailureMessage } from './plan-activation-gate';
import { PLAN_STATUSES } from './parser';
import { propagatePlanScopeWrite, type PlanScopeCascadeResult } from './plan-scope-cascade';
import { defaultPlanScopeCascadeDeps } from './plan-scope-cascade-deps';
import {
  recoverHarnessFromSlugs,
  requireUnambiguousSlugScope,
  slugScopeErrorResult,
} from './slug-scope';

/** Canonical settable plan-level lifecycle targets — what we WRITE. */
const SETTABLE = ['draft', 'ready', 'shipped', 'superseded'] as const;
/** Statuses a caller may guard on via `expectedCurrent` — the parser's full
 * vocabulary, including the derived `awaiting-acceptance` state and legacy
 * `active`. Keeping this sourced from PLAN_STATUSES prevents a new lifecycle
 * state from being writable but impossible to guard against. */
const GUARDABLE = PLAN_STATUSES;
/** Caller-DX (watchdog P-006): aliases agents reach for, mapped to the
 *  canonical settable status instead of being zod-rejected. `active` is the
 *  legacy synonym for `ready` (bucketOf treats it as approved). `done` is the
 *  ITEM-status word — at PLAN level a "done" plan is `shipped`. Accept + map
 *  (echo `mappedFrom`) so the confusing reject (vs plans:set-status) stops
 *  recurring. */
const STATUS_ALIASES: Record<string, (typeof SETTABLE)[number]> = {
  active: 'ready',
  done: 'shipped',
};
/** Accepted on the wire = canonical + the mapped aliases. */
const ACCEPTED = ['draft', 'ready', 'shipped', 'superseded', 'active', 'done'] as const;

/** Pure (watchdog P-006): map an accepted status to its canonical settable form,
 *  reporting the alias that was mapped (for the `mappedFrom` echo). */
export function normalizePlanStatus(status: string): { status: string; mappedFrom?: string } {
  const mapped = STATUS_ALIASES[status];
  return mapped ? { status: mapped, mappedFrom: status } : { status };
}

const argsSchema = z
  .object({
    harness: harnessArg,
    current: z.array(evidenceCurrentInputSchema).max(2000).optional()
      .describe('ship proof: freshly measured evidence fingerprints, as in plans:get-spec-evidence; missing currentness never establishes fulfillment'),
    slug: z.string().min(1).optional(),
    slugs: z
      .array(z.string().min(1))
      .min(1)
      .max(200)
      .optional()
      .describe('Plan slugs to move to the same lifecycle status in one call.'),
    status: z
      .enum(ACCEPTED)
      .describe(
        "Target plan-level status. Canonical: draft | ready | shipped | superseded. Aliases accepted + mapped: 'active'→ready, 'done'→shipped (the item-status words agents reach for). For a P-NNN item's status use plans:set-status instead.",
      ),
    expectedCurrent: z
      .enum([...GUARDABLE] as [string, ...string[]])
      .optional()
      .describe(
        'Optional transition guard — only flip if the current status matches. e.g. approve passes `draft` so it never overwrites an already-shipped plan.',
      ),
    rationale: z
      .string()
      .optional()
      .describe(
        'Optional note on why the lifecycle moved. Stored on the plan revision (D-009), not in the frontmatter.',
      ),
    restoreShippedRevision: z.object({
      seq: z.number().int().positive(),
      contentHash: z.string().regex(/^[a-f0-9]{64}$/),
      expectedVersion: z.number().int().positive(),
      expectedContentHash: z.string().regex(/^[a-f0-9]{64}$/),
    }).optional().describe(
      'Restore an exact previously shipped revision after an unrecorded remote rollback. Requires the latest revision to be that shipment, the current body to equal its immediate predecessor, a local shipment capture, and the original rubric retirement with shipment. Refuses authored reopenings or changed work; does not reopen acceptance or recruit a grader.',
    ),
    // ── queen-scout-feedback-loop-2026-06-20 P-006 / B10: the DEPRECATE path.
    learnings: z
      .object({
        tried: z.string().min(1).describe('what approach / premise was attempted on the draft'),
        stalled: z.string().min(1).describe("why it stalled — the reason it won't reach ready"),
        salvageable: z
          .string()
          .min(1)
          .describe("what's salvageable — the reusable signal a future Blender cycle can re-ideate from"),
      })
      .optional()
      .describe(
        "ONLY honored on status='superseded' (a DEPRECATE): the free-text learnings (what was tried / why it stalled / what's salvageable). Providing it makes the deprecate ALSO emit a structured, source-tagged 'learnings' observation into the observation lane, so a dead draft still feeds Scout's corpus-digest (queen-scout-feedback-loop P-006 — 'no dead ends'). Omit on a plain reject.",
      ),
    sourceHive: z
      .string()
      .max(120)
      .optional()
      .describe(
        "deprecate-learnings only: the observation's source hive (the hive the draft belonged to). Defaults to the plan's harness.",
      ),
    evidence: z
      .array(z.string().max(200))
      .max(12)
      .optional()
      .describe('deprecate-learnings only: refs grounding the learnings (the deprecated plan ref is always included).'),
    // The acceptance gate has implemented `force` since D-003 and EVERY one of its
    // refusals tells the caller to "pass force:{ reason }" — but the key was never
    // declared here and never threaded to evaluatePlanAcceptanceGate, so the schema
    // rejected it as an unrecognized key. The advertised escape hatch did not exist,
    // which is half of EI-20430092702151575: a plan that could not satisfy the gate
    // could not force past it either, and so could not ship at all.
    force: z
      .object({
        reason: z.string().min(1).max(2000),
        acceptanceBarProofMetadata: z.boolean().optional().describe(
          'Narrow ship-only waiver for bar_snapshot_proof_inadequate and bar_snapshot_proof_stale. When true, the reason applies only to these metadata codes: code-truth checks, other BAR codes, contract gaps, rubric checks, and non-waivable gates still block. The waived codes are recorded in forcedPast.',
        ),
      })
      .optional()
      .describe(
        "status='shipped' or 'superseded': pass the applicable gate with a reason recorded on the plan (`forcedPast`). A normal force reason retains the existing code-truth waiver and supersede unfinished-items waiver. Set acceptanceBarProofMetadata:true for a narrow ship waiver of only BAR proof inadequacy/staleness metadata; code-truth checks, other BAR codes, rubric gates, and independent gates still block.",
      ),
  })
  .refine((a) => Boolean(a.slug) || (a.slugs?.length ?? 0) > 0, {
    message: 'pass `slug` or `slugs`',
  })
  .refine((a) => !a.force?.acceptanceBarProofMetadata || normalizePlanStatus(a.status).status === 'shipped', {
    message: 'force.acceptanceBarProofMetadata is only valid for a shipped target',
    path: ['force', 'acceptanceBarProofMetadata'],
  })
  .refine((a) => !a.restoreShippedRevision || (
    normalizePlanStatus(a.status).status === 'shipped' && Boolean(a.slug) && !a.slugs &&
    Boolean(a.expectedCurrent) && !a.force
  ), {
    message: 'restoreShippedRevision requires one slug, status shipped, expectedCurrent, and no force',
    path: ['restoreShippedRevision'],
  });

type SetPlanStatusValue =
  | {
      ok: true;
      oldStatus: string | null;
      newStatus: string;
      changed: boolean;
      nowStamped?: boolean;
      /** True when this write appended a forced-ship waiver — see forced-past-stamp.ts. */
      forcedPastStamped?: boolean;
    }
  | { ok: false; code: 'not_found' | 'no_status_line' | 'unexpected_status'; current?: string | null };

/** Frontmatter `status:` line, captured value in group 2, trailing ws in group 3. */
const STATUS_LINE_RE = /^(status:[ \t]*)([A-Za-z][\w-]*)([ \t]*)$/m;

/**
 * Pure decision function — flip the frontmatter `status:` line within
 * the leading `---`…`---` block only. Exported for unit testing
 * (mirrors `flipStatusInBody` in set-status.ts).
 *
 * Returns `newBody: null` with a `code` when nothing should be written:
 *   - no_status_line   — missing/legacy frontmatter, or no `status:` key
 *   - unexpected_status — `expectedCurrent` given and didn't match
 *   - noop             — already at the target (success, no write)
 */
export function flipPlanFrontmatterStatus(
  body: string,
  target: string,
  expectedCurrent?: string,
): { newBody: string | null; oldStatus: string | null; code?: 'no_status_line' | 'unexpected_status' | 'noop' } {
  if (!body.startsWith('---')) return { newBody: null, oldStatus: null, code: 'no_status_line' };
  const close = body.indexOf('\n---', 3);
  if (close === -1) return { newBody: null, oldStatus: null, code: 'no_status_line' };
  const fm = body.slice(0, close);
  const rest = body.slice(close);
  const m = STATUS_LINE_RE.exec(fm);
  if (!m) return { newBody: null, oldStatus: null, code: 'no_status_line' };
  const oldStatus = m[2] ?? null;
  if (expectedCurrent && oldStatus !== expectedCurrent) {
    return { newBody: null, oldStatus, code: 'unexpected_status' };
  }
  if (oldStatus === target) {
    return { newBody: null, oldStatus, code: 'noop' };
  }
  // String replacement: `target` is an enum value (no `$` substitution
  // sequences), trailing whitespace ($3) preserved.
  const newFm = fm.replace(STATUS_LINE_RE, `$1${target}$3`);
  return { newBody: newFm + rest, oldStatus };
}

/**
 * Apply a plan-level lifecycle target and the Now-block invariants as one pure
 * mutation. Unlike {@link flipPlanFrontmatterStatus}, an already-terminal (or
 * already-`ready`) target is not necessarily a no-op: it repairs an unstamped
 * `## Now` block. That makes the existing bulk status verb a safe, idempotent
 * backfill path for BOTH directions — a plan that closed while its Now still
 * read live, and a greenlit draft whose Now still reads "not active until
 * greenlit" (WI-39804).
 */
export function applyPlanStatusBody(
  body: string,
  target: string,
  expectedCurrent?: string,
  today: Date = new Date(),
): {
  newBody: string | null;
  oldStatus: string | null;
  code?: 'no_status_line' | 'unexpected_status' | 'noop';
  changed: boolean;
  nowStamped: boolean;
} {
  const flip = flipPlanFrontmatterStatus(body, target, expectedCurrent);
  if (flip.code === 'no_status_line' || flip.code === 'unexpected_status') {
    return { ...flip, changed: false, nowStamped: false };
  }

  const statusChanged = flip.code !== 'noop';
  const candidate = flip.newBody ?? body;
  // The two stamps are mutually exclusive by target — terminal covers
  // shipped/superseded, greenlit covers ready — so the first non-null wins and
  // neither can ever see a body the other rewrote.
  const stamped =
    stampTerminalNowBlock(candidate, target, today) ??
    stampGreenlitNowBlock(candidate, target, today);
  if (!statusChanged && stamped === null) {
    return { ...flip, changed: false, nowStamped: false };
  }
  return {
    newBody: stamped ?? flip.newBody,
    oldStatus: flip.oldStatus,
    changed: statusChanged,
    nowStamped: stamped !== null,
  };
}

/**
 * Whether the acceptance gate must run before a lifecycle write.
 *
 * A caller that supplies expectedCurrent:'shipped' is performing the
 * idempotent terminal-Now repair pass (WI-38303), not entering the shipped
 * state.  The CAS guard is enforced inside the plan lock, so skipping the
 * preflight here is safe: a plan that is not already shipped simply refuses
 * with `unexpected_status` and is never mutated.  Without this distinction a
 * repair replay needlessly evaluates the completion gate (and may launch an
 * acceptance grader) for every already-shipped plan in the corpus.
 */
export function shouldEvaluateAcceptanceGate(status: string, expectedCurrent?: string): boolean {
  return status === 'shipped' && expectedCurrent !== 'shipped';
}

export interface TerminalPlanTidyDeps {
  retire: typeof retireAcceptanceRubricForPlan;
  settle: typeof settleAcceptanceReviewReservationsForPlan;
  reconcileActivationRepair: typeof reconcileActivationAuditRepairFilingForTerminalPlan;
}

export interface TerminalPlanTidyResult {
  /** Id of the acceptance rubric this call retired; absent when none was live. */
  acceptanceRubricRetired?: string;
  /** Present only when a reservation was settled or failed, or the settle itself threw. */
  acceptanceReviewReservations?: AcceptanceReviewReservationSettlement | { error: string };
  /** Present only when an open activation-repair filing was closed or the close failed. */
  activationAuditRepair?: ActivationAuditRepairReconciliation;
}

/**
 * Lifecycle tidy-up for a plan that just reached a terminal status. Every artifact
 * here was FILED for the plan's pre-terminal lifecycle and has no other close once
 * the plan is terminal, so the filer side owns closing it (EI-24746042684666503):
 *
 *  - the acceptance rubric archives WITH its subject plan
 *    (acceptance-rubrics-on-every-plan-2026-08-11 P-005); best-effort, a busy lock is
 *    skipped and the rubric remains resolvable by id;
 *  - the recruiter's review-target reservations are settled (EI-24654801606034099):
 *    condition-upsert filings have no auto-settle, so a grader who graded through their
 *    own item otherwise leaves one open forever;
 *  - an activation-audit repair filing is closed: its own reconcile fires only on a
 *    clean audit, which a plan that ships without one never records.
 *
 * Runs on `superseded` even when unchanged (a repeat write repairs older terminal rows),
 * and on `shipped` only when the status changed. Failures are reported on the result,
 * never thrown. Exported with injectable deps so the wiring is unit-tested (WI-10004531).
 */
export async function tidyFilingsForTerminalPlan(
  input: {
    slug: string;
    status: string;
    changed: boolean;
    ownerId: () => string;
    scope: { workspaceId: string; harnessSlug?: string | null };
  },
  deps: TerminalPlanTidyDeps = {
    retire: retireAcceptanceRubricForPlan,
    settle: settleAcceptanceReviewReservationsForPlan,
    reconcileActivationRepair: reconcileActivationAuditRepairFilingForTerminalPlan,
  },
): Promise<TerminalPlanTidyResult> {
  const { slug, status, changed, scope } = input;
  if (!(status === 'superseded' || (status === 'shipped' && changed))) return {};
  const terminalStatus: 'shipped' | 'superseded' = status;
  const harnessSlug = scope.harnessSlug ?? null;

  const retired = await deps.retire(slug, input.ownerId(), {
    ...(harnessSlug ? { harnessSlug } : {}),
    terminalStatus,
  });

  let reservations: AcceptanceReviewReservationSettlement | { error: string };
  try {
    reservations = await deps.settle(slug, { workspaceId: scope.workspaceId, harnessSlug, terminalStatus });
  } catch (err) {
    reservations = { error: err instanceof Error ? err.message : String(err) };
  }
  const reportReservations =
    'error' in reservations || reservations.settled.length > 0 || reservations.failed.length > 0;

  // The activation-repair condition key is harness-qualified; without a harness there
  // is no key to reconcile.
  const activation = harnessSlug
    ? await deps.reconcileActivationRepair({
        workspaceId: scope.workspaceId,
        harnessSlug,
        planSlug: slug,
        terminalStatus,
      })
    : null;

  return {
    ...(retired ? { acceptanceRubricRetired: retired } : {}),
    ...(reportReservations ? { acceptanceReviewReservations: reservations } : {}),
    ...(activation && (activation.closed || activation.error) ? { activationAuditRepair: activation } : {}),
  };
}

/**
 * WI-38047 / D-015: best-effort caller ownerId for the no-self-ratification guard.
 * `resolveAgentIdentity` THROWS on an unattributable ctx — the guard then FAILS OPEN
 * (null ownerId ⇒ no originator comparison), which is exactly the rule D-012 set for
 * the sibling self-grade guard: an unattributed caller cannot be a PROVEN
 * self-ratification, and an attribution miss must never block a legitimate
 * cross-author approval. Elsewhere in this file identity is resolved unguarded, on
 * paths that already ran the write; this one runs BEFORE it and must not throw there.
 */
function resolveRatifierOwnerId(ctx: unknown): string | null {
  try {
    return resolveAgentIdentity(ctx as Parameters<typeof resolveAgentIdentity>[0]).ownerId;
  } catch {
    return null;
  }
}

/** Exported so the acceptance-grading stall sweep can PIN its own copy of this set
 * against the definition the live gate actually uses, instead of the two drifting
 * apart silently (acceptance-grading-stall-sweep-2026-08-26 P-001). */
export const ACCEPTANCE_GRADER_GATE_CODES = new Set(['acceptance_ungraded', 'self_graded_only']);

/** D-006: a grading refusal recruits one grader. Keeping this decision in a
 * small exported seam makes the trigger independently testable and prevents
 * unrelated acceptance failures from spawning agents.
 *
 * P-011 (get-feedback-relevance-consults D-009): the default recruit is now
 * DISCOVERY-FIRST — resolveAcceptanceGrader routes the plan + rubric through
 * the relevance router and ASSIGNS an existing above-floor, non-excluded,
 * reachable agent; only when discovery says fresh (below floor / all excluded /
 * all dead / degraded) does it fall through to the original fresh-judge launch. */
export async function launchAcceptanceGraderForGate(
  slug: string,
  gate: { satisfied: boolean; code?: string; staleGradingScorecardId?: string; staleGradingScorecardIds?: readonly string[] },
  ctx: Parameters<typeof launchAcceptanceGrader>[1],
  harness: string | undefined,
  launch: typeof launchAcceptanceGrader = resolveAcceptanceGrader,
): Promise<AcceptanceGraderLifecycle | undefined> {
  if (gate.satisfied || !gate.code || !ACCEPTANCE_GRADER_GATE_CODES.has(gate.code)) return undefined;
  // The tool accepts a per-call harness override. Keep the scoping at this
  // launch seam so the acceptance grader cannot accidentally resolve the plan
  // against the caller's ambient harness (EI-20482865818772113).
  const scopedCtx = harnessScopedCtx(harness, ctx);
  const workspaceId = scopedCtx.workspaceId?.trim();
  if (!workspaceId || workspaceId === '*') {
    // A system principal needs a concrete workspace. Preserve the existing
    // caller path when scope is unavailable; launchAcceptanceGrader's lineage
    // guard will still fail closed for an author rather than fabricating scope.
    return launch(slug, scopedCtx);
  }

  // Automatic gate recruitment is a SYSTEM effect, not the rubric author's
  // personal launch. If the discovery menu is empty, the fresh judge must be
  // descended from this independent system actor; otherwise the launch-side
  // lineage guard correctly rejects it as the author's child. The same actor
  // owns the periodic recovery sweep, so immediate and recovery paths share one
  // auditable origin instead of weakening the direct-author guard. Idempotent
  // ship retries therefore re-enter the same launcher's terminal-log recovery
  // (including its one-shot backend fallback) under that stable system origin.
  //
  // EI-24402913315950329: the rewrite replaces the CALLER too, so the recruiter's
  // D-009 shipper exclusion read the system actor and the real shipper (routinely
  // the implementer) stayed routable — measured on
  // declared-gate-recovery-contract-2026-09-21, where the router forked the
  // implementer as its "independent" grader. Carry the caller's identity through
  // as an exclusion input; it grants nothing.
  const acceptanceShipperOwnerId = resolveRatifierOwnerId(scopedCtx);
  // WI-10003286: every independent card the gate excluded as cohort-stale (the named one
  // AND each older one that predates it) must not read as settled, or the recruiter
  // answers the gate's "re-grade" with "already done" on every retry.
  const staleIds = [
    ...new Set(
      [gate.staleGradingScorecardId, ...(gate.staleGradingScorecardIds ?? [])].filter(
        (id): id is string => typeof id === 'string' && id.trim().length > 0,
      ),
    ),
  ];
  return launch(slug, {
    ...scopedCtx,
    acceptanceShipperOwnerId,
    ...(gate.staleGradingScorecardId ? { acceptanceStaleGradingScorecardId: gate.staleGradingScorecardId } : {}),
    ...(staleIds.length > 0 ? { acceptanceStaleGradingScorecardIds: staleIds } : {}),
    // WI-10003286: this seam only runs for ACCEPTANCE_GRADER_GATE_CODES, where the gate
    // has already resolved identities and found no admissible independent grading. The
    // recruiter's identity-free settlement read must not override that verdict.
    acceptanceGateFoundNoAdmissibleGrading: true,
    uiClientId: null,
    isSuperuser: false,
    isPowerUser: false,
    principal: {
      kind: 'system',
      slug: ACCEPTANCE_GRADING_SWEEP_ACTOR,
      workspaceId,
    },
    ownerId: ACCEPTANCE_GRADING_SWEEP_ACTOR,
    ownerLabel: 'acceptance grading sweep',
    userId: null,
  } as never);
}

/** Why a stalled acceptance grading will NOT be recovered automatically, and the
 * route that still works (EI-24032136322947460). */
export type AcceptanceGraderRecovery = {
  code: 'grading_sweep_paused' | 'grading_sweep_inactive';
  sweep: Extract<AcceptanceGradingSweepState, { status: 'paused' | 'inactive' }>;
  instruction: string;
};

const NO_PARALLEL_REVIEWER = 'Do not self-grade or launch a parallel reviewer.';
const RETRY = 'retry plans:set-plan-status — each call re-runs recruitment';

/**
 * The recruiter dispatches once per ship attempt; the acceptance-grading-sweep is
 * what re-dispatches and escalates a grading that stalls afterwards. When that
 * sweep is paused or inactive, the refusal must say so and name the manual route
 * instead of implying recovery is automatic (EI-24032136322947460: it sat paused
 * under an owner hold while plans deduped onto an unassigned request, silently).
 * Undefined = recovery is automatic, unknown, or the grading is already settled.
 */
export function acceptanceGraderRecovery(
  lifecycle: AcceptanceGraderLifecycle,
  sweep: AcceptanceGradingSweepState | undefined,
): AcceptanceGraderRecovery | undefined {
  if (lifecycle.state === 'settled' || !sweep) return undefined;
  if (sweep.status !== 'paused' && sweep.status !== 'inactive') return undefined;

  const why = sweep.status === 'paused'
    ? `The acceptance-grading-sweep routine is paused` +
      (sweep.reason ? ` (${sweep.reason})` : '') +
      (sweep.pausedBy ? ` by ${sweep.pausedBy}` : '') +
      (sweep.pausedAt ? ` since ${sweep.pausedAt}` : '') +
      (sweep.autoResumesAt ? `, auto-resuming ${sweep.autoResumesAt}` : ', with no auto-resume') +
      ', so it will not re-dispatch or escalate this grading. Do not re-arm the sweep to unblock this ship: it is a deliberate hold.'
    : 'The acceptance-grading-sweep routine is inactive with no recorded pause, so it will not re-dispatch or ' +
      'escalate this grading; an unexplained stop is worth investigating (routines:list { name: "acceptance-grading-sweep" }).';

  let route: string;
  switch (lifecycle.state) {
    case 'deduped': {
      const id = lifecycle.existingWorkItemId;
      const holder = lifecycle.existingWorkItemAssignee;
      route = !id
        ? `This ship deduped onto an existing grader launch; confirm it is taking turns, and if it is not, ${RETRY}.`
        // review-routing-through-relevance-router-2026-09-26 D-001: the recruiter
        // owns who grades. The remedy waits on the routed request or re-runs the
        // recruiter; it never tells the shipper to message or pick a grader.
        : holder
          ? `This ship deduped onto grading request ${id}, held by ${holder}. Do not message the holder or pick ` +
            `another grader: if ${holder} is live, events:await work-item:done:${id}; if that session has ended, ` +
            `work_items:release ${id} so the request goes unheld, and once it has sat unheld past the recruiter's ` +
            `grace window, ${RETRY}.`
          : `This ship deduped onto grading request ${id}, which is unassigned. Do not pick a grader yourself: the ` +
            `recruiter stops deduping onto an unheld request after its grace window, so ${RETRY} then.`;
      break;
    }
    case 'assigned': {
      // Render owner ids: joining AssignedGrader objects printed "[object Object]",
      // so the shipper could not tell whom to confirm with.
      const graders = lifecycle.graders?.map((grader) => grader.ownerId) ?? [];
      const thread = lifecycle.conversationId ? ` ${lifecycle.conversationId}` : '';
      route = `Graders were assigned${graders.length ? ` (${graders.join(', ')})` : ''}; ` +
        `confirm one picks up the grading conversation${thread}, and if none does, ${RETRY}.`;
      break;
    }
    case 'launched':
      route = lifecycle.agentStarted === false
        ? `A fresh judge was launched but never started; ${RETRY}.`
        : `A fresh judge was launched${lifecycle.agentStarted === null ? ' (start unconfirmed)' : ''}; ` +
          `confirm it is taking turns, and if it stalls, ${RETRY}.`;
      break;
    default:
      route = `Recruitment failed${lifecycle.error ? `: ${lifecycle.error}` : ''}; ${RETRY}.`;
  }

  return {
    code: sweep.status === 'paused' ? 'grading_sweep_paused' : 'grading_sweep_inactive',
    sweep,
    instruction: `${why} ${route} ${NO_PARALLEL_REVIEWER}`,
  };
}

/** The refusal fields a recruited grader contributes. `repairAction` is only
 * present when recovery is NOT automatic — then its instruction is replaced by the
 * recovery route; its kind and retry verb are kept, since a retry still re-runs
 * recruitment. The top-level refusal code is untouched: routing keys on it. */
export function acceptanceGraderRefusalFields(
  repairAction: PlanAcceptanceRepairAction | undefined,
  lifecycle: AcceptanceGraderLifecycle | undefined,
  sweep: AcceptanceGradingSweepState | undefined,
): {
  repairAction?: PlanAcceptanceRepairAction;
  acceptanceGrader?: AcceptanceGraderLifecycle & { recovery?: AcceptanceGraderRecovery };
} {
  if (!lifecycle) return {};
  const recovery = acceptanceGraderRecovery(lifecycle, sweep);
  if (!recovery) return { acceptanceGrader: lifecycle };
  return {
    ...(repairAction ? { repairAction: { ...repairAction, instruction: recovery.instruction } } : {}),
    acceptanceGrader: { ...lifecycle, recovery },
  };
}

export default defineTool({
  name: 'plans:set-plan-status',
  description:
    "Change a plan's lifecycle status: draft→ready, ready→draft, →shipped, or →superseded. draft→ready/active requires `plans:audit { phase:'activation' }`; shipped/`done` is post-implementation: author the plan-specific rubric from as-built reality, run `plans:audit { phase:'completion' }`, then get a peer grade. Plan frontmatter, not item status.",
  guidance: {
    when: "Lifecycle changes. Before draft→ready/active, re-read the COMPLETE source conversation (not memory/summary), repair omissions, and record `plans:audit { phase:'activation' }`. Before shipped/`done`, author the acceptance rubric AFTER implementation from as-built outcomes, run `plans:audit { phase:'completion', items:[...] }`, then get a peer grade. Other moves: ready→draft or supersede.",
    notWhen:
      "Not for P-NNN item status (use plans:set-status) or legacy plans without frontmatter (use plans:set-frontmatter). `learnings` applies only to superseded; shipped has code-truth and rubric gates.",
    chaining:
      "Activation: sessions:search/read → repair → `plans:audit { phase:'activation' }` → ready (`expectedCurrent:'draft'`). Completion: implementation → as-built acceptance rubric → `plans:audit { phase:'completion', items:[...] }` → peer grade → shipped/`done`. Re-audit after semantic edits, not cosmetic ones.",
  },
  capability: 'plans:write',
  // Idempotent-completion (backend-reliability-100pct-2026-07-03 W6/P-007):
  // the locked frontmatter write can commit just before the transport deadline,
  // leaving the caller with an ambiguous timeout even though a retry is safe.
  // Opt into the dispatch abort-race reconciliation so a committed lifecycle
  // flip is surfaced as truthful success instead of a false timeout.
  idempotent: true,
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  modality: ['text'],
  // A shipped-gate refusal can synchronously recruit a fresh headless judge.
  // That bounded path can spend 6s in boot, 30s on native kickoff proof and
  // 25s verifying its first turn (61s total). The default status-tool deadline
  // expires first, hiding the launcher's failure/recovery receipt from the
  // recruiter; match the launcher budget so the structured outcome is returned.
  timeoutSec: 90,
  args: argsSchema,
  async handler(args, ctx) {
    // Caller-DX (P-006): map a friendly alias (active→ready, done→shipped) to canonical.
    const { status, mappedFrom } = normalizePlanStatus(args.status);
    const slugs = mergeIds(args.slug, args.slugs);
    // EI-21405955283990151: lifecycle closeout already names exact plan slugs,
    // so reuse the PG-canonical recovery used by plans:get/items instead of
    // demanding a harness the caller cannot discover from a workspace-bound
    // session. Writes are stricter than reads: a slug present in >1 harness is
    // fail-loud rather than taking the most-recently-updated candidate.
    const scope = resolveHarnessScope(args.harness, ctx);
    let sctx: typeof ctx & { harnessSlug: string };
    if (scope.kind === 'none') {
      const recovered = await recoverHarnessFromSlugs(ctx, slugs);
      const decision = requireUnambiguousSlugScope(
        recovered,
        ((ctx as { workspaceId?: string }).workspaceId ?? '').trim(),
      );
      if (decision.status !== 'resolved') return slugScopeErrorResult('plans:set-plan-status', decision);
      sctx = { ...ctx, harnessSlug: decision.harnessSlug };
      (ctx as { metadata?: (d: Record<string, unknown>) => void }).metadata?.({
        harnessAutoResolved: decision.bySlug,
      });
    } else {
      sctx = harnessScopedCtx(args.harness, ctx);
    }
    const harnessSlug = resolveCtxHarnessSlug(sctx);
    const env = await runBulk(
      slugs,
      async (slug) => {
        if (args.restoreShippedRevision) {
          const restored = await restoreHistoricalShipment(sctx, {
            slug,
            harnessSlug,
            expectedCurrent: args.expectedCurrent!,
            ...args.restoreShippedRevision,
          });
          return { slug, ...restored };
        }
        // Completion gate (acceptance-rubrics-on-every-plan-2026-08-11 P-004/P-005):
        // shipping requires a graded acceptance rubric — the refusal message IS the
        // authoring nudge (author it post-implementation, D-007; grader ≠ implementer,
        // D-005). Flag ACCEPTANCE_RUBRIC_COMPLETION_GATE (default ON); rubric-template
        // plans + scheduled template instances are exempt inside the gate.
        // Hoisted out of the `shipped` branch: the gate decides the waiver, but
        // the WRITE below is what makes it permanent, so the record has to
        // survive the branch that produced it.
        let forcedPast: ForcedPastRecord | undefined;
        // EI-22181490624100467 — hoisted for the same reason as `forcedPast`: the gate
        // measures it, but this result is what tells the shipper their code-truth
        // evidence was (or was not) live. A ship on undeployed evidence is allowed and
        // must never be SILENT.
        let citationDeployment: CitationDeployment | undefined;
        let acceptanceGateSatisfied = false;
        if (shouldEvaluateAcceptanceGate(status, args.expectedCurrent)) {
          // Match withPlanLock's member → Hive-home resolution. The caller's
          // harness can name a member, while the subject row lives at its home.
          const subjectScope = await resolvePlanScope({
            harnessSlug,
            ...((sctx as { workspaceId?: string }).workspaceId
              ? { workspaceId: (sctx as { workspaceId?: string }).workspaceId } : {}),
          });
          // EI-22181490624100467 — this is the ONE caller that asks for the citation
          // deployment probe. It is a rare write, unlike the sync resolver and the
          // grading sweep which call this same gate on hot/periodic paths.
          const gate = await evaluatePlanAcceptanceGate(slug, {
            harnessSlug: subjectScope.harnessSlug,
            probeCitationDeployment: true,
            ...(args.current ? { current: args.current } : {}),
            ...(args.force ? { force: args.force } : {}),
            readGradingAuditDispatchSuppression: async (targetOwnerId) => {
              const { readGradingAuditDispatchSuppression } = await import('../../grading-integrity');
              return readGradingAuditDispatchSuppression(subjectScope.workspaceId, { targetOwnerId });
            },
          });
          citationDeployment = gate.citationDeployment;
          if (gate.forcedPast) {
            const actor = resolveAgentIdentity(ctx);
            forcedPast = {
              ...gate.forcedPast,
              forcedAt: new Date().toISOString(),
              forcedBy: { ownerId: actor.ownerId, ownerLabel: actor.ownerLabel },
            };
          }
          if (!gate.satisfied) {
            const acceptanceGrader = await launchAcceptanceGraderForGate(slug, gate, ctx, harnessSlug);
            // EI-24032136322947460: say whether a stall will be recovered
            // automatically. Read only when a grader is in play and unsettled.
            const sweep = acceptanceGrader && acceptanceGrader.state !== 'settled'
              ? await readAcceptanceGradingSweepState()
              : undefined;
            return {
              // Keep canonical BAR attribution, grading identity, and the safe
              // repair route. A hand-picked code/message subset loses the very
              // context that distinguishes a contract defect from a read fault.
              ...gate,
              ok: false as const,
              slug,
              error: gate.code ?? 'acceptance_gate_failed',
              ...acceptanceGraderRefusalFields(gate.repairAction, acceptanceGrader, sweep),
            };
          }
          acceptanceGateSatisfied = true;
        }
        // EI-19403437795858863 — the deprecate counterpart. The acceptance gate above
        // fires only on `shipped`, so until now a supersede could strand every one of
        // its non-terminal items silently; measured 2026-09-04, that is 266 stranded
        // items under 26 superseded plans versus 38 under 17 shipped. This runs ONLY
        // the unfinished-items leg (see supersede-item-gate.ts for why widening
        // shouldEvaluateAcceptanceGate instead would demand a graded acceptance rubric
        // to deprecate a dead draft), and shares `forcedPast` with the ship path so a
        // waived deprecate is stamped on the plan by the same writer below.
        if (shouldEvaluateSupersedeItemGate(status, args.expectedCurrent)) {
          const gate = await evaluateSupersedeItemGate(slug, {
            ...(args.force ? { force: args.force } : {}),
            // A candidate only — the gate confirms the plan's home harness (WI-10005174).
            harnessSlug,
          });
          if (gate.forcedPast) {
            const actor = resolveAgentIdentity(ctx);
            forcedPast = {
              ...gate.forcedPast,
              forcedAt: new Date().toISOString(),
              forcedBy: { ownerId: actor.ownerId, ownerLabel: actor.ownerLabel },
            };
          }
          if (!gate.satisfied) {
            return {
              ok: false as const,
              slug,
              error: gate.code ?? 'supersede_gate_failed',
              message: gate.message,
            };
          }
        }
        // Ratification gate (blender-su-grade-integration-2026-08-11 D-015, WI-38047):
        // a `ready` flip IS the approval on the scout rail — ready-plan-autostart
        // promotes the draft's items straight into the claimable pool with no second
        // gate — so a steward may never ratify a draft whose idea it filed itself.
        // Mirrors blender:grade-idea's no-self-grade refusal (D-012), including its
        // fail-open-on-unattributable rule. Silent for non-scout plans.
        if (status === 'ready') {
          const gate = await evaluateScoutRatificationGate({
            planSlug: slug,
            callerOwnerId: resolveRatifierOwnerId(ctx),
          });
          if (!gate.satisfied) {
            return {
              ok: false as const,
              slug,
              error: gate.code ?? 'ratification_gate_failed',
              message: gate.message,
              ...(gate.ideaId ? { ideaId: gate.ideaId } : {}),
            };
          }
        }
        // P-004 admission on the two status flips that are execution signals.
        // ACTIVATION ('active') is when the orchestrator may start picking work off
        // the plan; PROMOTION ('shipped') is when its result becomes the accepted
        // record. Every other flip (draft/ready/superseded/deprecated) moves the
        // document without running or accepting anything, so gating them would refuse
        // edits governance has no interest in — and would make repairing a
        // revision-mismatch impossible, since repair goes through a status write.
        //
        // Placed BEFORE planRevisionCapture deliberately: the capture stamps a new
        // revision, and a refusal must leave the plan exactly as it was, not stamped
        // with a revision that never took effect.
        const admissionDoor = status === 'active' ? 'status' : status === 'shipped' ? 'promotion' : null;
        if (admissionDoor) {
          const admission = await checkPlanAdmission({
            slug,
            door: admissionDoor,
            opts: {
              ...(harnessSlug ? { harnessSlug } : {}),
              ...(((sctx as { workspaceId?: string }).workspaceId ?? '').trim()
                ? { workspaceId: ((sctx as { workspaceId?: string }).workspaceId ?? '').trim() }
                : {}),
            },
          });
          if (!admission.admitted) {
            return {
              ok: false as const,
              slug,
              error: admission.refusal.error,
              code: admission.refusal.code,
              message: admission.refusal.hint,
              detail: admission.refusal.detail,
              planRevisionHash: admission.refusal.planRevisionHash,
              policyVersion: admission.refusal.policyVersion,
            };
          }
        }
        const rev = planRevisionCapture(
          ctx as PlanRevisionCtx,
          slug,
          args.rationale,
          harnessSlug ? { harnessSlug } : {},
        );
        const result = await withPlanLock<SetPlanStatusValue>(
          ctx as never,
          {
            slug,
            intent: `plans:set-plan-status → ${status}`,
            ...(harnessSlug ? { harnessSlug } : {}),
            afterWrite: rev.afterWrite,
            // Keep the rich acceptance policy in TypeScript. The deferred DB
            // constraint only verifies that this exact plan transition carries
            // a receipt from this successful gate evaluation in the same xact.
            inTransaction: acceptanceGateSatisfied
              ? async (tx, _writtenBody, scope, value) => {
                  if (!value.ok || value.newStatus !== 'shipped' || value.changed !== true) return;
                  await tx`
                    SELECT set_config(
                      'papercusp.plan_shipment_acceptance_gate_receipt',
                      jsonb_build_object(
                        'schemaVersion', 1,
                        'transactionId', txid_current()::text,
                        'workspaceId', ${scope.workspaceId}::text,
                        'harnessSlug', ${scope.harnessSlug}::text,
                        'planSlug', ${slug}::text
                      )::text,
                      true
                    )
                  `;
                }
              : undefined,
          },
          async (current): Promise<{ newBody: string | null; value: SetPlanStatusValue }> => {
            if (current === null) {
              return { newBody: null, value: { ok: false, code: 'not_found' } };
            }
            const mutation = applyPlanStatusBody(current, status, args.expectedCurrent);
            if (mutation.code === 'no_status_line') {
              return { newBody: null, value: { ok: false, code: 'no_status_line' } };
            }
            if (mutation.code === 'unexpected_status') {
              return {
                newBody: null,
                value: { ok: false, code: 'unexpected_status', current: mutation.oldStatus },
              };
            }
            // A forced ship records its waiver in this SAME locked write, so a
            // plan can never be observed as shipped-clean when it was shipped
            // forced — the gate's `forcedPast` contract ("permanent and
            // visible, never a silent bypass"). Applied to the post-flip body
            // when there is one, and to `current` when the flip itself is a
            // no-op: an idempotent re-application must still not lose the
            // waiver. See forced-past-stamp.ts.
            const waived = stampForcedPastWaiver(mutation.newBody ?? current, forcedPast);
            const finalBody = waived ?? mutation.newBody;
            if (finalBody === null) {
              // Already at the target and already stamped (or non-terminal),
              // with no waiver to record — success, nothing written.
              return {
                newBody: null,
                value: {
                  ok: true,
                  oldStatus: mutation.oldStatus,
                  newStatus: status,
                  changed: false,
                  nowStamped: false,
                  forcedPastStamped: false,
                },
              };
            }
            return {
              // A terminal flip — or an idempotent re-application to an old
              // terminal plan — stamps the cold-resume anchor in this SAME
              // locked write. See terminal-now-stamp.ts / WI-38303.
              newBody: bumpUpdatedDate(finalBody),
              value: {
                ok: true,
                oldStatus: mutation.oldStatus,
                newStatus: status,
                changed: mutation.changed,
                nowStamped: mutation.nowStamped,
                forcedPastStamped: waived !== null,
              },
            };
          },
        );

        if (result.kind === 'busy') {
          return {
            ok: false as const,
            slug,
            error: 'busy',
            busy: result.busy.map((b) => ({
              path: b.path,
              owner_label: b.owner_label,
              intent: b.intent,
              expires_ts: b.expires_ts,
            })),
          };
        }

        // Domain failures return ok:false as a normal result so callers read
        // per-item status instead of catching.
        if (!result.value.ok) {
          const message = domainFailureMessage(result.value);
          return {
            ok: false as const,
            slug,
            error: result.value.code,
            current: result.value.current ?? null,
            ...(message ? { message } : {}),
          };
        }

        if (result.value.changed) {
          await emitPlanEventForCaller(ctx, {
            planSlug: slug,
            event: 'status_changed',
            before: result.value.oldStatus,
            after: status,
          });
        }

        if (isTerminalPlanStatus(status)) {
          try {
            await clearStartedForTerminalPlan(result.scope.workspaceId, result.scope.harnessSlug, slug);
          } catch {
            /* recovered by reconcileStartStatus on the next plans:list read */
          }
        }

        // P-030 (review-system-rework-reduction-2026-09-23): superseding a plan makes every
        // "Ship <slug>" carrier in ANOTHER plan moot. Park those out of claim_next and
        // re-evaluate their plans' BAR readiness in this same call, surfacing the gate code
        // in each carrier plan's Now. Never throws into the status write; the result rides
        // the response so the caller sees what was parked.
        let scopeCascade: PlanScopeCascadeResult | undefined;
        if (status === 'superseded' && result.value.changed) {
          let actor = 'system:plan-supersede-cascade';
          try {
            actor = resolveAgentIdentity(ctx).ownerId;
          } catch {
            /* unattributable caller: park provenance falls back to the system actor */
          }
          scopeCascade = await propagatePlanScopeWrite(
            {
              workspaceId: result.scope.workspaceId,
              harnessSlug: result.scope.harnessSlug,
              subjectSlug: slug,
              cause: 'superseded',
              actor,
            },
            defaultPlanScopeCascadeDeps(ctx, actor),
          );
        }

        // Terminal tidy-up: retire the acceptance rubric, settle review-target
        // reservations, close an activation-repair filing (see tidyFilingsForTerminalPlan).
        const terminalTidy = await tidyFilingsForTerminalPlan({
          slug,
          status,
          changed: result.value.changed,
          ownerId: () => resolveAgentIdentity(ctx).ownerId,
          scope: { workspaceId: result.scope.workspaceId, harnessSlug: result.scope.harnessSlug },
        });

        let learningsObservation:
          | { emitted: true; created: boolean; issueId?: string }
          | { emitted: false; error: string }
          | undefined;
        if (status === 'superseded' && args.learnings) {
          const id = resolveAgentIdentity(ctx);
          const ctxRole = (ctx as { role?: string } | undefined)?.role;
          const deprecatedBy = ctxRole === 'mug' ? 'Queen' : 'owner';
          try {
            const obs = await emitDeprecateLearnings({
              planSlug: slug,
              deprecatedBy,
              learnings: args.learnings as DeprecateLearnings,
              sourceHive: args.sourceHive ?? resolveEffectiveHarnessSlug(sctx),
              ...(args.evidence ? { evidence: args.evidence } : {}),
              createdBy: id.ownerId,
            });
            learningsObservation = {
              emitted: true,
              created: obs.created,
              ...(obs.issue ? { issueId: obs.issue.id } : {}),
            };
          } catch (err) {
            const error =
              err instanceof ObservationEvidenceError ? err.message : err instanceof Error ? err.message : String(err);
            learningsObservation = { emitted: false, error };
          }
        }

        return {
          ...result.value,
          ok: true as const,
          slug,
          filePath: result.filePath,
          ...(mappedFrom ? { mappedFrom } : {}),
          ...(learningsObservation ? { learningsObservation } : {}),
          ...terminalTidy,
          ...(scopeCascade ? { scopeCascade } : {}),
          // A forced ship is loud in the RESPONSE too, not only in the plan
          // file: the caller who waived the gate should not have to re-read the
          // plan to see what they waived.
          ...(forcedPast ? { forcedPast: { reason: forcedPast.reason, checks: [...forcedPast.checks] } } : {}),
          // EI-22181490624100467 — same principle as `forcedPast` above: the shipper
          // should not have to run `dev:pipeline_position` per cited path to learn that
          // the code-truth evidence they just shipped on is not live. Absent means NOT
          // MEASURED (a non-ship status change), never "deployed".
          ...(citationDeployment ? { citationDeployment } : {}),
          revision: result.value.changed && rev.recorded.current ? { seq: rev.recorded.current.seq } : null,
        };
      },
      { keyOf: (slug) => ({ slug }) },
    );

    return bulkContent(env);
  },
});
