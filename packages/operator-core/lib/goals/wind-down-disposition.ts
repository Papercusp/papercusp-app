/**
 * Wind-down disposition gate (goal-mode-design-intent-hardening-2026-08-16 P-002).
 *
 * A GOAL-mode owner ending its loop (or, loopless, its session) while the goal
 * is still ACTIVE must say what became of the goal — `achieved | killed |
 * handoff` — and the platform then generates the owner report FROM the state
 * the agent already wrote (the loop carry-note + the end reason) and delivers
 * it to the owner inbox. The graded run that motivated this (WI-39531) had all
 * the per-platform evidence sitting in its own loop:end text and sent none of
 * it: the disposition demand is the structural fix, the auto-report is what
 * makes the demand cheap to satisfy.
 *
 * Delivery is an ADVISORY escalation: escalations ARE the owner inbox (the
 * inbox `by_kind` counts them; the drain watchdog pages on the same surface),
 * so no new delivery channel is invented here.
 *
 * The gate's flag check fails CLOSED (gate off on flag-infra errors) — the
 * deliberate opposite of `drainFleetAutoMintEnabled`'s fail-open. A refusal
 * gate on the STOP path must never block on infra errors: you must always be
 * able to stop a loop you armed. loop:end itself stays unflagged for stopping
 * for the same reason.
 */

import { getOrgPg } from '@papercusp/db-org';
import type { GoalSqlTag } from '@papercusp/agent-mcp/goals';

import { getModeSubject } from '../modes/store';
import { openEscalation } from '../agent-tools/coordination/escalations';
import type { AgentIdentity } from '../agent-tools/coordination/identity';
import { areAcceptanceLineageRelated } from '../acceptance-author-identity';
import { rubricVettingConsultHint } from '../consult/selection-policies';
import type { RubricEvidenceCurrentness, RubricEvidenceIdentity } from '../rubrics';

export const GOAL_DISPOSITIONS = ['achieved', 'killed', 'handoff'] as const;
export type GoalDisposition = (typeof GOAL_DISPOSITIONS)[number];

export function isGoalDisposition(v: unknown): v is GoalDisposition {
  return typeof v === 'string' && (GOAL_DISPOSITIONS as readonly string[]).includes(v);
}

/** The owner's still-active goal, or null when the wind-down needs no disposition. */
export interface ActiveGoalRef {
  goalId: string;
  title: string;
  installSlug: string;
  /** A disposition already recorded on the row (metadata.disposition) — the gate
   *  passes when one exists, so a re-entrant wind-down never demands it twice. */
  recordedDisposition: string | null;
  /** The goal's declared output schema (P-021, migration 927) — null when none.
   *  Carried here so the wind-down outputs gate needs no second query. */
  outputSchema: Record<string, unknown> | null;
}

/**
 * Resolve the caller's active goal: the GOAL mode row's subject
 * (`getModeSubject(ws, ownerId, 'goal')`), then the goals row itself, which
 * must still be `status='active'`. Null on every not-applicable case (not in
 * goal mode, subject unset, goal already terminal/paused, row gone) — the gate
 * only ever REFUSES on a positive finding, never on a resolution miss.
 *
 * Takes the org pool by default (never ctx.tx): session:end runs
 * `skipWorkspaceTx` and loop:end must stay callable under a saturated
 * workspace pool.
 */
export async function activeGoalForOwner(opts: {
  workspaceId: string;
  ownerId: string;
  sql?: GoalSqlTag;
}): Promise<ActiveGoalRef | null> {
  const sql = opts.sql ?? (getOrgPg().sql as unknown as GoalSqlTag);
  const goalId = await getModeSubject(
    opts.workspaceId,
    opts.ownerId,
    'goal',
    sql as never,
  ).catch(() => null);
  if (!goalId) return null;
  const rows = await sql<
    Array<{
      id: string;
      title: string;
      install_slug: string;
      disposition: string | null;
      output_schema: Record<string, unknown> | null;
    }>
  >`
    SELECT id, title, install_slug, metadata->>'disposition' AS disposition, output_schema
      FROM harness_shared.goals
     WHERE id = ${goalId} AND workspace_id = ${opts.workspaceId} AND status = 'active'
     LIMIT 1`;
  const row = rows[0];
  if (!row) return null;
  return {
    goalId: row.id,
    title: row.title,
    installSlug: row.install_slug,
    recordedDisposition: row.disposition ?? null,
    outputSchema: row.output_schema ?? null,
  };
}

/**
 * EI-24732367604234855: 'killed' is TERMINAL (goals.status='killed',
 * actionable:false) and nothing reverts it on resume, so an agent that is only
 * PAUSING — an owner system-wide pause, a hold — must not pick it just to get
 * past this gate. A paused goal is not 'active', so `activeGoalForOwner` returns
 * null and loop:end then needs no disposition at all. Named in the refusal
 * because that is the one place the pausing agent is guaranteed to read.
 */
export const PAUSE_NOT_KILL_HINT =
  "Only PAUSING (e.g. an owner system-wide pause), not stopping the goal? Do NOT pick 'killed' — it is " +
  "terminal and a resume does not revert it. Run `goals:update { status:'paused', reason }` first (it " +
  `disarms the goal's loops), then end the loop with no disposition; resume with ` +
  "`goals:update { status:'active', reason }`.";

/**
 * PURE: the refusal both gates return when a goal-mode owner winds down with no
 * disposition. Exported (and pinned by the guard test) because the acceptance
 * criterion is about the WORDS: the refusal must name the missing arg
 * (`disposition`) and all three legal values, or the refused agent has no way
 * forward from the error alone.
 */
export function buildDispositionRefusal(opts: {
  action: 'loop:end' | 'session:end';
  goalId: string;
  goalTitle: string;
}): { ok: false; error: string; goalId: string; dispositions: readonly GoalDisposition[] } {
  return {
    ok: false,
    error:
      `REFUSED — this owner is in GOAL mode and goal ${opts.goalId} (“${opts.goalTitle}”) is still active. ` +
      `${opts.action} requires a \`disposition\`: 'achieved' (the goal is done), 'killed' (deliberately stopped), ` +
      `or 'handoff' (someone else continues — pass handoffTo). Retry with disposition set; ` +
      `the wind-down report to the owner is generated for you. ` +
      PAUSE_NOT_KILL_HINT,
    goalId: opts.goalId,
    dispositions: GOAL_DISPOSITIONS,
  };
}

export interface GoalWindDownReportInput {
  goalId: string;
  goalTitle: string;
  disposition: GoalDisposition;
  endedBy: string;
  /** Which verb wound down — report provenance. */
  action: 'loop:end' | 'session:end';
  reason?: string | null;
  /** The loop carry-note at wind-down — the evidence the report exists to carry. */
  carryNote?: string | null;
  handoffTo?: string | null;
}

/** PURE: render the owner report. The summary is the inbox card line; the body
 *  folds the reason + the final carry-note so the evidence the agent already
 *  wrote actually reaches the owner. */
export function buildGoalWindDownReport(input: GoalWindDownReportInput): {
  summary: string;
  body: string;
} {
  const dispositionLine =
    input.disposition === 'handoff'
      ? `handoff${input.handoffTo ? ` → ${input.handoffTo}` : ''} (goal stays active)`
      : input.disposition;
  const summary = `Goal wind-down [${dispositionLine}]: ${input.goalTitle}`;
  const lines = [
    `Goal ${input.goalId} (“${input.goalTitle}”) was wound down via ${input.action} by ${input.endedBy}.`,
    `Disposition: ${dispositionLine}.`,
  ];
  const reason = input.reason?.trim();
  if (reason) lines.push('', `## End reason`, reason);
  const note = input.carryNote?.trim();
  if (note) lines.push('', `## Final carry-note`, note);
  if (!reason && !note)
    lines.push('', '(No end reason or carry-note was recorded at wind-down.)');
  return { summary, body: lines.join('\n') };
}

/**
 * Record the disposition on the goals row. `achieved`/`killed` flip
 * `status` (both are in GOAL_STATUSES); `handoff` leaves the goal ACTIVE —
 * someone else continues pursuing it. All three stamp
 * `metadata.{disposition,dispositionBy,dispositionAt[,handoffTo]}` and bump
 * `updated_at`: even a handoff is a real lifecycle transition that recency-
 * ordered goal reads must surface.
 * Id+workspace scoped like `deleteGoalRow`: the table is multi-tenant and this
 * write must never reach another tenant's row.
 */
export async function applyGoalDisposition(opts: {
  workspaceId: string;
  goalId: string;
  disposition: GoalDisposition;
  dispositionBy: string;
  handoffTo?: string | null;
  /**
   * The goal's reported outputs (P-021, migration 927), ALREADY validated by
   * the caller against the goal's output_schema via
   * `evaluateGoalWindDownOutputs` — this writer records, it does not judge
   * (the same caller-validates split as insertGoalRow's IO fields). COALESCE'd
   * so a re-entrant wind-down passing none never erases an earlier record.
   */
  outputs?: Record<string, unknown> | null;
  sql?: GoalSqlTag;
}): Promise<void> {
  const sql = opts.sql ?? (getOrgPg().sql as unknown as GoalSqlTag);
  const stamp: Record<string, unknown> = {
    disposition: opts.disposition,
    dispositionBy: opts.dispositionBy,
    dispositionAt: new Date().toISOString(),
  };
  if (opts.disposition === 'handoff' && opts.handoffTo) stamp.handoffTo = opts.handoffTo;
  const nextStatus = opts.disposition === 'handoff' ? null : opts.disposition;
  const outputs =
    opts.outputs && Object.keys(opts.outputs).length ? JSON.stringify(opts.outputs) : null;
  await sql`
    UPDATE harness_shared.goals
       SET status = COALESCE(${nextStatus}::text, status),
           outputs = COALESCE(${outputs}::jsonb, outputs),
           updated_at = now(),
           metadata = COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify(stamp)}::jsonb
     WHERE id = ${opts.goalId} AND workspace_id = ${opts.workspaceId}
  `;
}

/**
 * Deliver the report to the owner inbox as an advisory escalation, deduped per
 * goal (`goal-wind-down` / `<ws>:<goalId>`) so a retried wind-down bumps the
 * card instead of stacking a second one.
 */
export async function deliverGoalWindDownReport(
  identity: AgentIdentity,
  opts: {
    workspaceId: string;
    goalId: string;
    disposition: GoalDisposition;
    summary: string;
    body: string;
  },
): Promise<void> {
  await openEscalation(identity, {
    severity: 'advisory',
    summary: opts.summary,
    body: opts.body,
    meta: {
      dedupKind: 'goal-wind-down',
      subjectSignature: `${opts.workspaceId}:${opts.goalId}`,
      goalId: opts.goalId,
      disposition: opts.disposition,
    },
  });
}

/**
 * FLAGS.GOAL_WINDDOWN_DISPOSITION_GATE, default ON. Fail-CLOSED on flag-infra
 * errors — the deliberate opposite of `drainFleetAutoMintEnabled`: this is a
 * REFUSAL gate on the stop path, and a broken flag read must disable the gate,
 * never wedge an agent that is trying to stop its own loop.
 */
export async function windDownDispositionGateEnabled(): Promise<boolean> {
  try {
    const [{ getFlag }, { FLAGS }] = await Promise.all([
      import('@papercusp/flags/server'),
      import('@papercusp/flags'),
    ]);
    return await getFlag(FLAGS.GOAL_WINDDOWN_DISPOSITION_GATE, 'system');
  } catch {
    return false;
  }
}

// ─── The 'achieved' acceptance gate (consult-min-max-…-2026-08-17 P-009 / D-004 §2) ──
//
// 'achieved' is a CLAIM, and the claim needs acceptance evidence: an acceptance
// rubric (kind:'acceptance', subjectGoal = the goal) authored POST-pursuit by the
// goal-mode agent, VETTED against the meta-rubric (a complete meta-scorecard with a
// linked consult on the CURRENT rubric revision — the same attestation the plan ship
// gate demands), and GRADED by a NON-owner of the goal. 'killed'/'handoff' are
// exempt — you don't grade a goal you abandoned.
//
// Stop-path posture, same as the disposition gate above: the gate refuses only on a
// POSITIVE finding. The flag check fails CLOSED (gate off), and every probe fault
// inside the evaluation resolves toward satisfied — an infra error must never wedge
// an agent that is trying to stop its own loop. The read path mirrors
// plan-acceptance-gate.ts (the plan-side twin); deps are injectable so the verdict
// partition is unit-testable without PG.

export type GoalAcceptanceGateCode =
  | 'goal_acceptance_rubric_missing'
  | 'goal_acceptance_rubric_unvetted'
  | 'goal_acceptance_ungraded'
  | 'goal_self_graded_only';

export interface GoalAcceptanceVerdict {
  satisfied: boolean;
  code?: GoalAcceptanceGateCode;
  /** Teaching refusal — names the full repair flow, since the refused agent's only
   *  way forward is this message. */
  message?: string;
  rubricId?: string;
  gradedBy?: string | null;
}

/** Structural slice of a Rubric the gate reads (keeps the test seam import-free). */
export interface GoalAcceptanceRubricRef {
  rubricId: string;
  revision?: number | null;
  criteriaHash?: string | null;
  barContract?: { meaningRevision?: number | null } | null;
  criteria: unknown[];
  proposedBy?: string | null;
  createdBy?: string | null;
}

/** Structural slice of a scorecard row the gate reads. */
export interface GoalAcceptanceCard {
  createdBy?: string | null;
  rubricRevision?: number | null;
  rubricMeaningRevision?: number | null;
  criteriaHash?: string | null;
  rubricResolved: boolean;
  missingKeys: string[];
  synthesized?: boolean;
  vetting?: {
    consultId?: string | null;
    workItemId?: string | null;
    rubricRevision?: number | null;
    rubricMeaningRevision?: number | null;
    criteriaHash?: string | null;
  } | null;
}

export interface GoalAcceptanceGateDeps {
  gateEnabled: () => Promise<boolean>;
  getRubricForGoal: (goalId: string) => Promise<GoalAcceptanceRubricRef | null>;
  /** Null when no meta-rubric is registered — the vetting check then disables rather
   *  than deadlocking every 'achieved' on a missing prerequisite (mirrors the plan
   *  gate's recorded ruling). */
  getMetaRubric: () => Promise<unknown | null>;
  getRubricRevision: (rubricId: string) => Promise<number | null>;
  classifyRubricCurrentness: (
    recorded: RubricEvidenceIdentity,
    live: RubricEvidenceIdentity,
  ) => RubricEvidenceCurrentness;
  listCards: (filter: { rubricRef: string; subjectRef?: string }) => Promise<GoalAcceptanceCard[]>;
  metaRubricId: string;
  /** Identity relation used to exclude the goal/rubric author's spawn lineage. */
  areLineageRelated?: typeof areAcceptanceLineageRelated;
}

/** FLAGS.GOAL_ACHIEVED_ACCEPTANCE_GATE, default ON. Fail-CLOSED on flag-infra errors —
 *  identical posture to windDownDispositionGateEnabled above. */
export async function goalAchievedAcceptanceGateEnabled(): Promise<boolean> {
  try {
    const [{ getFlag }, { FLAGS }] = await Promise.all([
      import('@papercusp/flags/server'),
      import('@papercusp/flags'),
    ]);
    return await getFlag(FLAGS.GOAL_ACHIEVED_ACCEPTANCE_GATE, 'system');
  } catch {
    return false;
  }
}

/** Prod deps — dynamic-imported so a rubrics/scorecards module fault degrades to
 *  satisfied (via evaluateGoalAcceptanceGate's catch) instead of breaking the
 *  loop:end/session:end module graph. */
async function defaultGoalAcceptanceGateDeps(): Promise<GoalAcceptanceGateDeps> {
  const [rubrics, scorecards] = await Promise.all([import('../rubrics'), import('../scorecards')]);
  return {
    gateEnabled: goalAchievedAcceptanceGateEnabled,
    getRubricForGoal: (goalId) => rubrics.getAcceptanceRubricForGoal(goalId),
    getMetaRubric: () => rubrics.getRubric(rubrics.META_ACCEPTANCE_RUBRIC_ID),
    getRubricRevision: (rubricId) => rubrics.getRubricPlanRevision(rubricId),
    classifyRubricCurrentness: rubrics.classifyRubricEvidenceCurrentness,
    listCards: async (filter) => scorecards.listScorecards({ ...filter, limit: 50 }),
    metaRubricId: rubrics.META_ACCEPTANCE_RUBRIC_ID,
  };
}

/**
 * Evaluate the 'achieved' acceptance gate. Never throws — any probe fault resolves
 * toward `satisfied` (positive-finding-only, the stop-path invariant). Callers run
 * this ONLY for disposition:'achieved'; killed/handoff never reach it.
 */
export async function evaluateGoalAcceptanceGate(
  opts: { goalId: string; goalTitle: string; goalOwner: string; workspaceId: string },
  depsOverride?: GoalAcceptanceGateDeps,
): Promise<GoalAcceptanceVerdict> {
  try {
    const deps = depsOverride ?? (await defaultGoalAcceptanceGateDeps());
    if (!(await deps.gateEnabled())) return { satisfied: true };

    const rubric = await deps.getRubricForGoal(opts.goalId);
    if (!rubric) {
      return {
        satisfied: false,
        code: 'goal_acceptance_rubric_missing',
        message:
          `REFUSED — disposition 'achieved' is a claim, and goal ${opts.goalId} (“${opts.goalTitle}”) carries no ` +
          `acceptance evidence: no acceptance rubric names it. Author it NOW, post-pursuit (it is better informed ` +
          `against what was actually built): rubrics:propose { kind:'acceptance', subjectGoal:'${opts.goalId}', ` +
          `criteria:[3–7 OUTCOMES tracing to the goal's stated outcome + kill criterion — never a restatement of ` +
          `activity performed] }. Then (1) VET it against the meta-rubric (get_feedback critique, then ` +
          `scorecards:emit { rubricRef:'meta-acceptance-rubric', subject:{ kind:'rubric', ref:'<rubric>' }, ` +
          `vettingConsult:'<consult id>' }), (2) a NON-owner of the goal grades it (scorecards:emit), (3) retry ` +
          `with disposition:'achieved'. Or, honestly: 'killed' / 'handoff' need no acceptance evidence.`,
      };
    }
    const rubricRevision = await deps.getRubricRevision(rubric.rubricId);

    // The VETTING attestation (D-001 §3-4): a complete meta-scorecard with a linked
    // consult, on the CURRENT rubric revision. Skipped when no meta-rubric is
    // registered (a workspace without one cannot run the flow — disable, don't
    // deadlock) — the plan gate records the same ruling.
    const meta = await deps.getMetaRubric();
    if (meta && rubric.criteria.length > 0 && rubric.rubricId !== deps.metaRubricId) {
      const metaCards = (await deps.listCards({ rubricRef: deps.metaRubricId, subjectRef: rubric.rubricId })).filter(
        (s) => s.rubricResolved && s.missingKeys.length === 0 && !s.synthesized,
      );
      // WI-41477: either critique channel counts — a get_feedback consult, or the
      // review work-item a launched independent reviewer's comments land on.
      const vettedCards = metaCards.filter((s) => s.vetting?.consultId || s.vetting?.workItemId);
      const current = vettedCards.find(
        (card) =>
          deps.classifyRubricCurrentness(
            {
              revision: card.vetting?.rubricRevision,
              criteriaHash: card.vetting?.criteriaHash,
              meaningRevision: card.vetting?.rubricMeaningRevision,
            },
            {
              revision: rubricRevision,
              criteriaHash: rubric.criteriaHash,
              meaningRevision: rubric.barContract?.meaningRevision,
            },
          ).state === 'current',
      );
      if (!current) {
        const stale = vettedCards.length > 0;
        return {
          satisfied: false,
          code: 'goal_acceptance_rubric_unvetted',
          rubricId: rubric.rubricId,
          message: stale
            ? `REFUSED — goal ${opts.goalId}'s acceptance rubric '${rubric.rubricId}' was vetted at an earlier ` +
              `revision but has changed since — the attestation no longer covers what is being graded. Re-emit the ` +
              `meta-scorecard against the current revision: scorecards:emit { rubricRef:'${deps.metaRubricId}', ` +
              `subject:{ kind:'rubric', ref:'${rubric.rubricId}' }, vettingConsult:'<consult id>', ratings:{…} } ` +
              `(citing the SAME consult is fine when the revision IS the improvement its critique asked for), then ` +
              `retry disposition:'achieved'.`
            : `REFUSED — goal ${opts.goalId}'s acceptance rubric '${rubric.rubricId}' has not been VETTED against ` +
              `the meta-rubric. The rubric AUTHOR vets it before anyone grades the goal: (1) get_feedback critique ` +
              `of the rubric — ${rubricVettingConsultHint()}, (2) improve it from the critique ` +
              `(rubrics:propose), (3) attest: scorecards:emit { rubricRef:'${deps.metaRubricId}', subject:{ ` +
              `kind:'rubric', ref:'${rubric.rubricId}' }, vettingConsult:'<the consult conversation_id>', ` +
              `ratings:{ <every meta criterion, with evidence> } }. Pass is your judgment per criterion — no ` +
              `mechanical score floor. Then retry disposition:'achieved'.`,
        };
      }
    }

    // The GRADING: complete, agent-emitted, by a NON-owner of the goal (and not the
    // rubric's own author — self-graded homework satisfies neither ruling).
    const cards = (await deps.listCards({ rubricRef: rubric.rubricId })).filter(
      (card) =>
        card.rubricResolved &&
        card.missingKeys.length === 0 &&
        !card.synthesized &&
        deps.classifyRubricCurrentness(
          {
            revision: card.rubricRevision,
            criteriaHash: card.criteriaHash,
            meaningRevision: card.rubricMeaningRevision,
          },
          {
            revision: rubricRevision,
            criteriaHash: rubric.criteriaHash,
            meaningRevision: rubric.barContract?.meaningRevision,
          },
        ).state === 'current',
    );
    if (cards.length === 0) {
      return {
        satisfied: false,
        code: 'goal_acceptance_ungraded',
        rubricId: rubric.rubricId,
        message:
          `REFUSED — goal ${opts.goalId}'s acceptance rubric '${rubric.rubricId}' has no complete grading. A ` +
          `NON-owner of the goal (someone other than '${opts.goalOwner}') grades it — scorecards:emit ` +
          `{ rubricRef:'${rubric.rubricId}', ratings:{ <every criterion key> } } with concrete evidence per ` +
          `rating — then retry disposition:'achieved'.`,
      };
    }
    const author = rubric.proposedBy ?? rubric.createdBy ?? null;
    const disqualified = new Set([opts.goalOwner, ...(author ? [author] : [])]);
    const related = deps.areLineageRelated ?? areAcceptanceLineageRelated;
    let independent: GoalAcceptanceCard | undefined;
    for (const card of cards) {
      if (card.createdBy == null || disqualified.has(card.createdBy)) continue;
      const relatedToOwner = await related(opts.goalOwner, card.createdBy, { workspaceId: opts.workspaceId });
      const relatedToAuthor = author
        ? await related(author, card.createdBy, { workspaceId: opts.workspaceId })
        : false;
      if (!relatedToOwner && !relatedToAuthor) {
        independent = card;
        break;
      }
    }
    if (!independent) {
      return {
        satisfied: false,
        code: 'goal_self_graded_only',
        rubricId: rubric.rubricId,
        message:
          `REFUSED — goal ${opts.goalId}'s acceptance rubric '${rubric.rubricId}' is graded only by the goal's ` +
          `own owner${author && author !== opts.goalOwner ? ` or the rubric's author` : ''}, including their ` +
          `spawn/rebind lineage — grader must be lineage-independent (the self-graded-homework guard). Launch or ` +
          `assign an unrelated grader to file the scorecard, then retry disposition:'achieved'.`,
      };
    }
    return { satisfied: true, rubricId: rubric.rubricId, gradedBy: independent.createdBy ?? null };
  } catch {
    // Positive-finding-only: an infrastructure fault is not a finding — never wedge
    // an agent stopping its own loop.
    return { satisfied: true };
  }
}
