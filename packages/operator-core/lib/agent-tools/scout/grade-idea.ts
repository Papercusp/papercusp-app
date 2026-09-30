/**
 * blender:grade-idea — record a human/automated grade (1–5 + optional critique) on a
 * routed Scout idea (scout-idea-grading-2026-06-12 B-03 / P-003, contract C-3).
 *
 * The thin tool projection over the C-2 write seam ({@link gradeRoutedIdea}).
 * Two invariants live HERE rather than in any prompt:
 *
 *   - `gradedBy` is DERIVED from the caller, never caller-supplied (D-004):
 *     a Mug/Queen spawn ctx grades as the neutral 'auto-grader'; an identified SU/psu agent grades
 *     under its resolved ownerId; only an unidentifiable human-surface call
 *     falls back to the literal 'owner'.
 *   - The idea key is `ideaId` OR the routed artifact's change-feed ref
 *     `routedRef` ("plan:<slug>" | "wi:<id>" | "gym:<id>"), exactly one
 *     (D-007): the Queen triages routed artifacts and holds only the ref;
 *     snapshot/UI callers hold the ideaId.
 *
 * Grades are a pure learning signal (D-005): fractional win credit in the
 * lens weights (C-5) + labelled feedback in ideator priming (C-4); they never
 * touch the routed artifact itself.
 *
 * su-ideate-learning-substrate-2026-07-10 P-005 adds the grade→revise WAKE (the
 * Queen↔Scout revision loop, su-shaped): post-write, a grade at or below
 * {@link REVISION_WAKE_MAX_GRADE} WITH feedback on an origin='su-ideate' row
 * wakes the originator (created_by) to revise or defend; a higher grade with
 * feedback delivers an unwoken FYI (D-008). Delivery is BEST-EFFORT: the durable
 * coord note is the reliable half and the wake the bonus (the WI-963 lesson) —
 * a wake that reaches nobody degrades to the unwoken pot-inbox note
 * (revisionWake.fallback), and a send failure NEVER fails the grade.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';

import { gradeRoutedIdea, type GradeRoutedIdeaInput, type GradeRoutedIdeaResult } from '../../scout/routed-ledger';
import { getWorkItem, type WorkItem } from '../../work-items';
import {
  preflightAgentReviewGrade,
  reconcileAgentReviewGrade,
  type AgentReviewGradePreflight,
  type AgentReviewReconcileOutcome,
} from '../../harness/improvements/agent-review';
import { softText, clampText, LIMITS } from '../limits';
import { resolveAgentIdentity, type ResolveIdentityCtx } from '../coordination/identity';

/** Grader attribution vocabulary (C-1 / D-004) — the seam's input type is the pin. */
export type GradedBy = GradeRoutedIdeaInput['gradedBy'];

/**
 * C-3: derive grader attribution from the caller — never from args. The Mug's
 * spawn ctx carries role 'mug' and grades under the neutral machine id
 * 'auto-grader' (the retired 'Queen' label was migrated — WI-39481). Identified
 * agent callers retain their resolved ownerId so autonomous grades cannot
 * consume the human owner's sovereign slot; an unidentifiable human-surface
 * call is the only literal 'owner' fallback.
 */
export function deriveGradedBy(ctx: { role?: string; ownerId?: string | null } | undefined): GradedBy {
  if (ctx?.role === 'mug') return 'auto-grader';
  const ownerId = ctx?.ownerId?.trim();
  return ownerId || 'owner';
}

/** Post-write summary of the graded ledger row, returned to the caller (C-3). */
export interface GradedIdeaSummary {
  ideaId: string;
  lens: string | null;
  rail: string | null;
  routedRef: string | null;
  title: string | null;
  routedAt: string | null;
  humanGrade: number | null;
  humanFeedback: string | null;
  gradedBy: string | null;
  gradedAt: string | null;
  /** P-005: origin partition + originator + home workspace of the ledger row —
   *  the revision-notice decision inputs (and caller-useful attribution). */
  origin: string | null;
  createdBy: string | null;
  workspaceId: string | null;
}

/** The read-side evidence attached when a key misses the routed-idea ledger. */
export type GradeIdeaResolutionProbeStatus = 'not-attempted' | 'absent' | 'unavailable' | 'found';

export interface GradeIdeaResolutionDiagnostic {
  /** Stable discriminator for consumers that need to branch on the diagnostic. */
  code: 'ledger-resolution-miss';
  /** Every value the resolver can compare for the supplied key. */
  attempted: {
    ideaId: string[];
    routedRef: string[];
  };
  /** Positive work-item evidence is separate from the ledger result. */
  workItem: {
    candidateId: string | null;
    status: GradeIdeaResolutionProbeStatus;
    family: WorkItem['family'] | null;
    kind: WorkItem['kind'] | null;
  };
  /** Present only when the existing issue-family candidate needs routing first. */
  remedy?: 'blender:route-idea';
}

export interface WorkItemExistenceProbeResult {
  id: WorkItem['id'];
  family: WorkItem['family'];
  kind: WorkItem['kind'];
}

/** Injectable probe used by the resolution-miss diagnostic (default: getWorkItem). */
export type WorkItemExistenceProbe = (id: string) => Promise<WorkItemExistenceProbeResult | null>;

/** The C-2 result + attribution + row summary — the tool's full payload. */
export interface GradeIdeaOutcome extends Omit<GradeRoutedIdeaResult, 'reason'> {
  /**
   * The C-2 seam's reasons PLUS the tool-layer 'no-self-grade' refusal (D-012):
   * a guard that lives ABOVE the write seam — the ledger's gradeRoutedIdea never
   * produces it — so it widens `reason` only here, keeping the seam type clean.
   */
  reason?:
    | GradeRoutedIdeaResult['reason']
    | 'no-self-grade'
    | 'not-routed'
    | NonNullable<AgentReviewGradePreflight['refusal']>;
  gradedBy: GradedBy;
  /** The resolved ledger key (null when a routedRef resolved to nothing). */
  ideaId: string | null;
  /** Post-write row state; on an owner-grade-sovereign no-op this carries the standing owner grade. */
  idea: GradedIdeaSummary | null;
  /** Resolution evidence when neither key form matched the routed-idea ledger. */
  diagnostic?: GradeIdeaResolutionDiagnostic;
  /** P-005: revision-notice delivery report — present iff a notice was attempted
   *  (an APPLIED grade on a su-ideate row with feedback + a known originator). */
  revisionWake?: RevisionWakeOutcome;
  /** D-003: work-item routing transition driven by this standing ledger grade. */
  agentReview?: AgentReviewReconcileOutcome;
}

export const gradeIdeaArgs = z
  .object({
    /** The routed idea's ledger id. Pass this OR routedRef, not both. */
    ideaId: z.string().min(1).max(256).optional(),
    /**
     * Alternate key (D-007): the routed artifact's change-feed ref —
     * "plan:<slug>" | "wi:<id>" | "gym:<id>" — for callers that hold the
     * artifact but not the scout ideaId (the Queen's triage path).
     */
    routedRef: z.string().min(1).max(512).optional(),
    /** 1–5 integer (D-001): 5 = clear win, 3 = neutral, 1 = clear loss. */
    grade: z.number().int().min(1).max(5),
    /** Free-text critique shown to next cycles' ideators (C-4). Omitting it on a regrade clears the stored feedback. */
    feedback: softText(LIMITS.ANNOTATION).optional(),
  })
  .refine((a) => (a.ideaId == null) !== (a.routedRef == null), {
    message: 'Pass exactly one of ideaId or routedRef.',
  });
export type GradeIdeaArgs = z.infer<typeof gradeIdeaArgs>;

interface SummaryRow {
  idea_id: string;
  lens: string | null;
  rail: string | null;
  routed_ref: string | null;
  title: string | null;
  routed_at: string | number | null;
  human_grade: number | string | null;
  human_feedback: string | null;
  graded_by: string | null;
  graded_at: string | Date | null;
  origin: string | null;
  created_by: string | null;
  workspace_id: string | null;
}

function toIso(v: string | number | Date | null): string | null {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * routedRef → ideaId (D-007). PK-adjacent lookup, deliberately NOT
 * workspace-narrowed — same EI-346 reasoning as {@link gradeRoutedIdea} /
 * readScoutPlanRefs: in-process tool dispatch runs under the 'default' ALS
 * workspace while ledger rows carry the active one, so a workspace clause
 * here would silently strand every ref-keyed grade. Newest routed_at wins
 * if a ref was ever routed twice.
 *
 * EI-21864158051054483: an agent-review caller routinely holds only the
 * BARE work-item id (`EI-19991080208681012`) — the id the review round
 * itself is keyed by — not the canonical `wi:<id>` change-feed ref this
 * function's docstring calls "the accepted reference format". A bare id
 * passed as `routedRef` used to miss the exact-match query above and
 * silently return `not-found`, even though the exact same bare-id
 * tolerance already exists one function down for `ideaId`
 * ({@link resolveIdeaIdFromKey}, EI-15389). This mirrors that fix for the
 * `routedRef` path: try the exact ref first (so a real `plan:`/`wi:`/`gym:`
 * ref never changes behavior), then fall back to the `wi:`/`gym:`-prefixed
 * forms and a direct `idea_id` match for a bare id. Exact-ref match wins a
 * tie; newest `routed_at` breaks any remaining tie.
 */
async function resolveIdeaIdFromRef(routedRef: string): Promise<string | null> {
  const { sql } = getOrgPg();
  const rows = await sql<{ idea_id: string }[]>`
    SELECT idea_id FROM harness_shared.scout_routed_ideas
     WHERE routed_ref = ${routedRef}
        OR routed_ref = ${`wi:${routedRef}`}
        OR routed_ref = ${`gym:${routedRef}`}
        OR idea_id = ${routedRef}
     ORDER BY (routed_ref = ${routedRef}) DESC, routed_at DESC
     LIMIT 1`;
  return rows[0]?.idea_id ?? null;
}

/**
 * EI-15389: resolve an `ideaId`-keyed call to the real ledger PK. A caller
 * routinely holds the routed WORK-ITEM id (`EI-15375`, `SP-002`), NOT the
 * cycle-prefixed ledger idea_id (`scout-<ts>:scout-idea-…`). A Scout-dispatched
 * row is keyed by that full idea_id and found only via its `routed_ref`
 * (`wi:EI-15375` for a work item, `gym:SP-002` for a gym idea); a su re-route
 * row is keyed by the bare work-item id DIRECTLY. So a natural `{ ideaId: 'EI-…' }`
 * used to silently no-op (the direct idea_id lookup missed → grades vanished,
 * the ungraded backlog grew). This unifies both: a direct idea_id match OR a
 * routed_ref match, direct winning ties, newest routed_at breaking a ref tie.
 * Returns null only when NOTHING matches — the caller then surfaces a LOUD
 * not-found (isError) rather than a success-shaped no-op. Deliberately NOT
 * workspace-narrowed — same EI-346 reasoning as {@link resolveIdeaIdFromRef}
 * (in-process dispatch runs under the 'default' ALS workspace).
 */
async function resolveIdeaIdFromKey(ideaId: string): Promise<string | null> {
  const { sql } = getOrgPg();
  const rows = await sql<{ idea_id: string }[]>`
    SELECT idea_id FROM harness_shared.scout_routed_ideas
     WHERE idea_id = ${ideaId}
        OR routed_ref = ${`wi:${ideaId}`}
        OR routed_ref = ${`gym:${ideaId}`}
        OR routed_ref = ${ideaId}
     ORDER BY (idea_id = ${ideaId}) DESC, routed_at DESC
     LIMIT 1`;
  return rows[0]?.idea_id ?? null;
}

const WORK_ITEM_ID_PREFIX = /^(?:WI|EI|F|PR)-/i;

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/**
 * The exact key forms considered by the two resolver paths. Keeping this pure
 * makes the diagnostic stable and keeps the probe from inventing a lookup that
 * the ledger resolver never attempted.
 */
export function gradeIdeaResolutionAttempts(args: GradeIdeaArgs): GradeIdeaResolutionDiagnostic['attempted'] {
  const key = args.ideaId ?? args.routedRef;
  if (!key) {
    return { ideaId: [], routedRef: [] };
  }
  return {
    ideaId: [key],
    routedRef: unique([key, `wi:${key}`, `gym:${key}`]),
  };
}

/** Only work-item-shaped keys are candidates; plan:/gym: refs are artifact refs. */
export function candidateWorkItemId(args: GradeIdeaArgs): string | null {
  const key = args.ideaId ?? args.routedRef;
  if (!key || /^(?:plan|gym):/i.test(key)) return null;
  const candidate = key.replace(/^wi:/i, '');
  return WORK_ITEM_ID_PREFIX.test(candidate) ? candidate : null;
}

function diagnosticForMiss(
  attempted: GradeIdeaResolutionDiagnostic['attempted'],
  workItem: GradeIdeaResolutionDiagnostic['workItem'],
  remedy?: GradeIdeaResolutionDiagnostic['remedy'],
): GradeIdeaResolutionDiagnostic {
  return {
    code: 'ledger-resolution-miss',
    attempted,
    workItem,
    ...(remedy ? { remedy } : {}),
  };
}

/**
 * Resolve the actionable distinction behind a null ledger lookup. A probe
 * failure is deliberately represented as unavailable, never as evidence that
 * the candidate is absent.
 */
async function diagnoseResolutionMiss(
  args: GradeIdeaArgs,
  deps: Pick<GradeIdeaDeps, 'getWorkItem'>,
): Promise<{ reason: 'not-found' | 'not-routed'; diagnostic: GradeIdeaResolutionDiagnostic }> {
  const attempted = gradeIdeaResolutionAttempts(args);
  const candidateId = candidateWorkItemId(args);
  if (!candidateId) {
    return {
      reason: 'not-found',
      diagnostic: diagnosticForMiss(attempted, {
        candidateId: null,
        status: 'not-attempted',
        family: null,
        kind: null,
      }),
    };
  }

  try {
    const candidate = await deps.getWorkItem(candidateId);
    if (!candidate) {
      return {
        reason: 'not-found',
        diagnostic: diagnosticForMiss(attempted, {
          candidateId,
          status: 'absent',
          family: null,
          kind: null,
        }),
      };
    }

    const workItem = {
      candidateId,
      status: 'found' as const,
      family: candidate.family,
      kind: candidate.kind,
    };
    if (candidate.family === 'issue') {
      return {
        reason: 'not-routed',
        diagnostic: diagnosticForMiss(attempted, workItem, 'blender:route-idea'),
      };
    }
    return { reason: 'not-found', diagnostic: diagnosticForMiss(attempted, workItem) };
  } catch {
    return {
      reason: 'not-found',
      diagnostic: diagnosticForMiss(attempted, {
        candidateId,
        status: 'unavailable',
        family: null,
        kind: null,
      }),
    };
  }
}

/**
 * Read back the (post-write) row for the result summary. PK-keyed and not
 * workspace-narrowed for the same reason as the resolver above; the ledger's
 * list reader (readRoutedIdeas) stays the home for scoped multi-row reads.
 */
async function readIdeaSummary(ideaId: string): Promise<GradedIdeaSummary | null> {
  const { sql } = getOrgPg();
  const rows = await sql<SummaryRow[]>`
    SELECT idea_id, lens, rail, routed_ref, title, routed_at,
           human_grade, human_feedback, graded_by, graded_at,
           origin, created_by, workspace_id
      FROM harness_shared.scout_routed_ideas
     WHERE idea_id = ${ideaId}`;
  const r = rows[0];
  if (!r) return null;
  return {
    ideaId: r.idea_id,
    lens: r.lens,
    rail: r.rail,
    routedRef: r.routed_ref,
    title: r.title,
    routedAt: toIso(r.routed_at),
    humanGrade: r.human_grade == null ? null : Number(r.human_grade),
    humanFeedback: r.human_feedback,
    gradedBy: r.graded_by,
    gradedAt: toIso(r.graded_at),
    origin: r.origin,
    createdBy: r.created_by,
    workspaceId: r.workspace_id,
  };
}

/**
 * D-012 pre-write lookup: the row's ORIGINATOR (created_by), read BEFORE the grade
 * write so the no-self-grade guard can refuse without ever touching the ledger.
 * PK-keyed and deliberately NOT workspace-narrowed for the same EI-346 reason as
 * the readers above. Returns null for an absent row (the write's own not-found path
 * handles that) or a row with no recorded originator.
 */
async function readCreatedBy(ideaId: string): Promise<string | null> {
  const { sql } = getOrgPg();
  const rows = await sql<{ created_by: string | null }[]>`
    SELECT created_by FROM harness_shared.scout_routed_ideas WHERE idea_id = ${ideaId}`;
  return rows[0]?.created_by ?? null;
}

// ── P-005: the grade→revise notice (su-ideate-learning-substrate D-008) ───────

/** D-008 named threshold: a grade AT OR BELOW this + feedback wakes the
 *  originator to revise or defend; above it, feedback delivers an unwoken FYI. */
export const REVISION_WAKE_MAX_GRADE = 3;

/** P-005 delivery report on the tool result — present iff a notice was attempted. */
export interface RevisionWakeOutcome {
  /** The durable coord note landed (the reliable half — an inbox row survives a dead originator). */
  sent: boolean;
  /** Wake awaits actually fired (always 0 on the FYI branch). */
  woken: number;
  /** A revision wake reached nobody (woken 0 / dead originator) and degraded to
   *  the unwoken pot-inbox note — the durable half above still stands. */
  fallback: boolean;
}

/** One originator-addressed notice: a durable coord note + (wake branch) an inbox wake. */
export interface RevisionNotice {
  to: string[];
  summary: string;
  body: string;
  /** true = revision branch (grade ≤ {@link REVISION_WAKE_MAX_GRADE}): also fire the inbox wake. */
  wake: boolean;
  /** The ledger ROW's workspace — coord delivery must run under IT, not the
   *  in-process ALS default (same EI-346 reasoning as the readers above). */
  workspaceId: string | null;
}

/** The injectable send port — fake-send-port tests drive both D-008 branches. */
export type RevisionNoticePort = (notice: RevisionNotice) => Promise<{ woken: number }>;

/** PURE: which delivery this grade earns. 'none' unless the write APPLIED to an
 *  origin='su-ideate' row with a known originator and non-empty feedback. */
export function revisionNoticeMode(args: {
  applied: boolean;
  origin: string | null;
  createdBy: string | null;
  feedback: string | null;
  grade: number;
}): 'wake' | 'fyi' | 'none' {
  if (!args.applied) return 'none';
  if (args.origin !== 'su-ideate') return 'none';
  if (!args.createdBy) return 'none';
  if (!args.feedback?.trim()) return 'none';
  return args.grade <= REVISION_WAKE_MAX_GRADE ? 'wake' : 'fyi';
}

/** PURE: render the notice — critique + routedRef + (wake branch) the revise-or-defend ask. */
export function buildRevisionNotice(
  mode: 'wake' | 'fyi',
  row: {
    createdBy: string;
    gradedBy: GradedBy;
    grade: number;
    feedback: string;
    ideaId: string;
    routedRef: string | null;
    title: string | null;
    workspaceId: string | null;
  },
): RevisionNotice {
  const ref = row.routedRef ?? row.ideaId;
  const head =
    `${row.gradedBy} graded your su-ideate filing ${ref} — ${row.grade}/5.` +
    (row.title ? `\nIdea: ${row.title}` : '') +
    `\nCritique: ${row.feedback}`;
  if (mode === 'wake') {
    return {
      to: [row.createdBy],
      summary: `Grade ${row.grade}/5 on your su-ideate filing ${ref} — revise or defend`,
      body:
        `${head}\n\nRevise or defend. To revise, file a new improvements:capture and include ` +
        `observation.linkTo: [{ targetId: '${ref.replace(/^wi:/, '')}', rel: 'revises' }] so the feedback→revision lineage is recorded; ` +
        `otherwise coord:send a reply defending this one.`,
      wake: true,
      workspaceId: row.workspaceId,
    };
  }
  return {
    to: [row.createdBy],
    summary: `FYI: grade ${row.grade}/5 + feedback on your su-ideate filing ${ref}`,
    body:
      `${head}\n\nFYI only (grade above ${REVISION_WAKE_MAX_GRADE} — D-008): no action forced; ` +
      `the critique is primed into your future IDEATE passes.`,
    wake: false,
    workspaceId: row.workspaceId,
  };
}

/**
 * Production port: durable coord note FIRST (the reliable half — it lands in the
 * originator's pot inbox whether or not any session is live), then the wake as a
 * best-effort bonus (the WI-963 lesson: an event-key wake alone fires into the
 * void when the originator's session already ended). A wake error is swallowed
 * to woken:0 — the caller reads that as the unwoken-note fallback. Lazy imports
 * keep the tool's import graph PG-only for unit tests.
 */
async function deliverRevisionNotice(notice: RevisionNotice): Promise<{ woken: number }> {
  const [{ sendMessage }, { wakeRecipients }, { runWithWorkspace }] = await Promise.all([
    import('../coordination/messages'),
    import('../coordination/inbox-wake'),
    import('../../workspace-als'),
  ]);
  const identity = {
    ownerId: 'su-ideate-revision-wake',
    ownerLabel: 'blender:grade-idea',
    source: 'static-client' as const,
    workspaceId: notice.workspaceId,
    userId: null,
  };
  const send = () => sendMessage(identity, { to: notice.to, summary: notice.summary, body: notice.body });
  if (notice.workspaceId) await runWithWorkspace(notice.workspaceId, send);
  else await send();
  if (!notice.wake) return { woken: 0 };
  try {
    const res = await wakeRecipients(notice.to, {
      summary: notice.summary,
      source: 'su-ideate-revision-wake',
      ...(notice.workspaceId ? { workspaceId: notice.workspaceId } : {}),
    });
    return { woken: res.woken };
  } catch {
    return { woken: 0 };
  }
}

/** Injectable PG + coord seams — unit tests run the full flow with fakes (gym-tools pattern). */
export interface GradeIdeaDeps {
  gradeRoutedIdea: typeof gradeRoutedIdea;
  resolveIdeaIdFromRef: typeof resolveIdeaIdFromRef;
  /** EI-15389: resolve an ideaId-keyed call (bare work-item id or full idea_id) to the ledger PK. */
  resolveIdeaIdFromKey: typeof resolveIdeaIdFromKey;
  /** Resolution-miss probe; a positive issue-family row is an unrouted candidate. */
  getWorkItem: WorkItemExistenceProbe;
  readIdeaSummary: typeof readIdeaSummary;
  /** D-012: pre-write originator lookup for the no-self-grade guard. */
  readCreatedBy: typeof readCreatedBy;
  /** P-005: the revision-notice delivery port (durable note + optional wake). */
  sendRevisionNotice: RevisionNoticePort;
  /** D-003: refuse unactionable/non-pending review grades before touching the ledger. */
  preflightAgentReviewGrade: typeof preflightAgentReviewGrade;
  /** D-003: converge work-item routing state from the standing ledger grade after the write. */
  reconcileAgentReviewGrade: typeof reconcileAgentReviewGrade;
}

const defaultDeps: GradeIdeaDeps = {
  gradeRoutedIdea,
  resolveIdeaIdFromRef,
  resolveIdeaIdFromKey,
  getWorkItem: async (id) => getWorkItem(id),
  readIdeaSummary,
  readCreatedBy,
  sendRevisionNotice: deliverRevisionNotice,
  preflightAgentReviewGrade,
  reconcileAgentReviewGrade,
};

/** The testable core: resolve key → C-2 write → row read-back. */
export async function runGradeIdea(
  args: GradeIdeaArgs,
  ctx: { role?: string; ownerId?: string | null } | undefined,
  deps: GradeIdeaDeps = defaultDeps,
): Promise<GradeIdeaOutcome> {
  const gradedBy = deriveGradedBy(ctx);
  const feedback = clampText(args.feedback, LIMITS.ANNOTATION);

  // EI-15389: resolve the key to the real ledger PK. An ideaId-keyed call may
  // carry a bare routed work-item id (`EI-15375`) rather than the cycle-prefixed
  // idea_id — resolveIdeaIdFromKey handles both (direct idea_id OR routed_ref
  // match), so a natural `{ ideaId: 'EI-15375' }` lands instead of silently
  // no-op'ing. An unresolvable key returns null → the LOUD not-found below.
  const ideaId =
    args.ideaId != null
      ? await deps.resolveIdeaIdFromKey(args.ideaId)
      : await deps.resolveIdeaIdFromRef(args.routedRef as string);
  if (ideaId == null) {
    const miss = await diagnoseResolutionMiss(args, deps);
    return { applied: false, ...miss, gradedBy, ideaId: null, idea: null };
  }

  // D-012 (owner 2026-07-10, BINDING) — the no-self-grade guard. An ideator grading
  // its OWN routed filing is a self-licking loop: a self-authored grade would feed
  // fractional win credit into the lens weights (C-5), prime the ideator with its own
  // critique (C-4), and could self-trigger the P-005 grade→revise wake. When the caller
  // AUTHORED this row (created_by === caller ownerId) we REFUSE before the write — no
  // self grade ever reaches the ledger, so none of the learning seams are polluted.
  // Caller-attributed ONLY: an unattributable ctx (no ownerId) cannot be a proven
  // self-grade, so it falls through unchanged (the pre-D-012 behavior).
  const callerOwnerId = ctx?.ownerId ?? null;
  if (callerOwnerId) {
    const createdBy = await deps.readCreatedBy(ideaId);
    if (createdBy && createdBy === callerOwnerId) {
      return { applied: false, reason: 'no-self-grade', gradedBy, ideaId, idea: null };
    }
  }

  // D-003/P-004: an agent-review grade is a work-item lifecycle command, not
  // merely a learning signal. Refuse low grades without actionable feedback and
  // grades against a non-pending round BEFORE the ledger write. General Scout and
  // su-ideate rows return applicable:false and retain their existing semantics.
  const agentReviewPreflight = await deps.preflightAgentReviewGrade({
    ideaId,
    grade: args.grade,
    ...(feedback !== undefined ? { feedback } : {}),
  });
  if (agentReviewPreflight.refusal) {
    return {
      applied: false,
      reason: agentReviewPreflight.refusal,
      gradedBy,
      ideaId,
      idea: null,
    };
  }

  const result = await deps.gradeRoutedIdea({
    ideaId,
    grade: args.grade,
    ...(feedback !== undefined ? { feedback } : {}),
    gradedBy,
  });

  // Post-write read-back (PK-keyed, total). On applied=true it shows exactly
  // what was written; on owner-grade-sovereign it shows the standing owner
  // grade the caller lost to. Best-effort: a summary miss never fails a write.
  let idea: GradedIdeaSummary | null = null;
  try {
    idea = await deps.readIdeaSummary(ideaId);
  } catch {
    if (result.applied) {
      idea = {
        ideaId,
        lens: null,
        rail: null,
        routedRef: args.routedRef ?? null,
        title: null,
        routedAt: null,
        humanGrade: args.grade,
        humanFeedback: feedback ?? null,
        gradedBy,
        gradedAt: new Date().toISOString(),
        // Origin/originator unknown when the read-back is down — the revision
        // notice below deliberately stays silent rather than guessing (P-005).
        origin: null,
        createdBy: null,
        workspaceId: null,
      };
    }
  }

  // The ledger remains the grade authority. Reconcile the work-item payload from
  // that standing row after either an applied write OR an owner-sovereign retry;
  // this is the idempotent recovery seam required when the two stores cannot share
  // one transaction. A preflight that said "applicable" followed by a missing
  // reconciliation target is a consistency failure, so surface it and let retry
  // converge instead of returning a false success.
  let agentReview: AgentReviewReconcileOutcome | undefined;
  if (agentReviewPreflight.applicable && result.reason !== 'not-found') {
    const reconciled = await deps.reconcileAgentReviewGrade({ ideaId, gradedBy });
    if (!reconciled) throw new Error(`agent-review-reconcile-missing:${ideaId}`);
    agentReview = reconciled;
  }

  // P-005 (D-008): a graded su-ideate filing notifies its originator — grade at
  // or below REVISION_WAKE_MAX_GRADE with feedback WAKES them to revise or
  // defend; a higher grade with feedback is an unwoken FYI. Best-effort by
  // contract: a delivery failure NEVER fails the grade.
  let revisionWake: RevisionWakeOutcome | undefined;
  if (!agentReviewPreflight.applicable && idea?.createdBy && feedback) {
    const mode = revisionNoticeMode({
      applied: result.applied,
      origin: idea.origin,
      createdBy: idea.createdBy,
      feedback,
      grade: args.grade,
    });
    if (mode !== 'none') {
      const notice = buildRevisionNotice(mode, {
        createdBy: idea.createdBy,
        gradedBy,
        grade: args.grade,
        feedback,
        ideaId,
        routedRef: idea.routedRef,
        title: idea.title,
        workspaceId: idea.workspaceId,
      });
      try {
        const { woken } = await deps.sendRevisionNotice(notice);
        revisionWake = { sent: true, woken, fallback: mode === 'wake' && woken === 0 };
      } catch (e) {
        console.warn(`[grade-idea] revision notice failed: ${e instanceof Error ? e.message : e}`);
        revisionWake = { sent: false, woken: 0, fallback: false };
      }
    }
  }

  return {
    ...result,
    gradedBy,
    ideaId,
    idea,
    ...(revisionWake ? { revisionWake } : {}),
    ...(agentReview ? { agentReview } : {}),
  };
}

/** Map the outcome onto the tool result envelope (isError ONLY for not-found — a sovereign no-op is designed behavior). */
export function toToolResult(out: GradeIdeaOutcome): {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
} {
  return {
    content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
    ...(out.reason === 'not-found' || out.reason === 'not-routed' ? { isError: true } : {}),
  };
}

/**
 * D-012: best-effort caller ownerId for the no-self-grade guard. resolveAgentIdentity
 * THROWS on an unattributable ctx — the guard then FAILS OPEN (null ownerId ⇒ no
 * self-grade comparison, i.e. exactly the pre-D-012 behavior), so an attribution miss
 * never blocks a legitimate cross-author grade.
 */
function resolveCallerOwnerId(ctx: ResolveIdentityCtx | undefined): string | null {
  try {
    return resolveAgentIdentity((ctx ?? {}) as ResolveIdentityCtx).ownerId;
  } catch {
    return null;
  }
}

export default defineTool({
  name: 'blender:grade-idea',
  description:
    'Grade a routed Blender idea 1–5 with optional feedback (≤2000 chars). Grades steer learning: fractional win credit in lens weights + critique primed into later ideator prompts. Key by ideaId or routedRef. On a su-ideate filing, a grade ≤3 with feedback wakes the originator to revise or defend (higher grades + feedback deliver an unwoken FYI) — best-effort, reported as revisionWake.',
  capability: 'harness:write',
  guidance: {
    when: "You want to score a routed Blender idea 1–5 (optional one-line critique) so Blender learns which lenses to favor. Key by ideaId (Blender view / learning.scout snapshot callers) or by routedRef — the routed artifact's change-feed ref 'plan:<slug>' | 'wi:<id>' | 'gym:<id>' — when you hold the artifact but not the ideaId (the triage path: grade each ungraded routed draft).",
    notWhen:
      'Not an accept/reject of the routed artifact — a grade is a pure learning signal; the draft proceeds through normal triage regardless. Never pass grader attribution: gradedBy is derived from the caller identity (resolved agent ownerId, or the human owner surface).',
    chaining:
      "Nothing to chain: weights update on the next refreshScoutOutcomes pass and feedback enters ideator priming automatically. The originator auto-notify is reported as revisionWake (thresholds in the description). applied:false + reason 'owner-grade-sovereign' (an agent regrading an owner-graded row) is expected, not an error — owner grades are sovereign; the returned summary carries the standing grade.",
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: gradeIdeaArgs,
  async handler(args, ctx) {
    // Thread the caller's coord ownerId (D-012 self-grade guard) alongside the role
    // (C-3 attribution). Both are DERIVED from ctx here, never caller-supplied.
    const ownerId = resolveCallerOwnerId(ctx as ResolveIdentityCtx | undefined);
    const role = (ctx as { role?: string } | undefined)?.role;
    return toToolResult(await runGradeIdea(args, { role, ownerId }));
  },
});
