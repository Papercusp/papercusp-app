/** Exact goal-plan exposure + native final-turn receipts, on existing stores. */
import { z } from 'zod';
import { formatAgentObligationLine } from './agent-obligations';
import type { AgentObligationBrief, AgentObligationAgendaRead } from './agent-obligation-reader';
import type { TranscriptTailTurn } from './turn-journal';
import type { SelfSession } from './search/self-session';
import type { ActivityRecord } from '@papercusp/activity-bridge';
import type { ExactPlanAdmissionReason } from './agent-tools/plans/plan-admission-preflight';
import type { GovernorStateSnapshot } from './resource-governor/state-snapshot';
import type { GoalPlacementOpportunity } from './goal-placement-progress';

export const GOAL_PLACEMENT_DELIVERY_KEY = 'goalPlacementDeliveryV1';
const nonempty = z.string().trim().min(1).max(1000);
const dateTime = z.string().datetime({ offset: true });
const planRefSchema = z.string().regex(/^plan:[^/\s]+\/\S+$/);
const launchSchema = z.object({ fleetSlug: nonempty, requestedSeats: z.number().int().min(1).max(100) }).strict();
const admissionSchema = z.object({
  version: z.literal(1), planRef: planRefSchema, observedAt: dateTime,
  launch: launchSchema.optional(),
  planReason: z.enum(['ready', 'plan-not-found', 'no-actionable-plan-items', 'promotion-lag', 'duplicate-coverage',
    'lane-unknown', 'floor-diagnostics-unavailable', 'floor-gated', 'family-disagreement', 'insufficient-executable-width', 'unknown']),
  governor: z.enum(['open', 'restricted', 'unknown']),
  attempts: z.enum(['none', 'present', 'unknown']), evidenceRefs: z.array(nonempty).max(24),
}).strict();
export type GoalPlacementAdmissionObservation = z.infer<typeof admissionSchema>;
const rowSchema = z.object({
  goalId: nonempty, planSlug: nonempty, planRef: planRefSchema,
  obligationId: nonempty, sourceGeneration: nonempty, ruleRevision: nonempty,
  launch: launchSchema.optional(), admission: admissionSchema.optional(),
}).strict();
export const goalPlacementDeliverySchema = z.object({
  version: z.literal(1), ownerId: nonempty, workspaceId: nonempty, token: nonempty,
  offeredAt: z.string().datetime({ offset: true }), nativeSessionId: nonempty,
  sourceKind: z.enum(['claude', 'codex', 'omp']), baselineTurnRef: nonempty.nullable(),
  rows: z.array(rowSchema).min(1).max(3),
}).strict();
export type GoalPlacementDelivery = z.infer<typeof goalPlacementDeliverySchema>;
type PlacementRow = GoalPlacementDelivery['rows'][number];
type AdmissionInput = { ownerId: string; workspaceId: string; row: PlacementRow;
  window?: { offeredAt: string; completedAt: string } };

export interface GoalPlacementAdmissionDeps {
  preflight: (input: AdmissionInput) => Promise<{ ready: boolean; reason: ExactPlanAdmissionReason; plan: string }>;
  governor: (workspaceId: string) => Promise<GovernorStateSnapshot | null>;
  attempts: (input: AdmissionInput, now: number) => Promise<string[]>;
  now: () => number;
}

/** Read the existing governor receipts, including the legacy overlap. This is
 * an exclusion census, never an admission request or a fabricated lease. */
export async function readGoalPlacementAdmissionAttempts(input: AdmissionInput, now: number): Promise<string[]> {
  const { getOrgPg } = await import('@papercusp/db-org');
  const { sql } = getOrgPg();
  const from = input.window ? Date.parse(input.window.offeredAt) : now;
  const to = input.window ? Date.parse(input.window.completedAt) : now;
  const rows = await sql<Array<{ ref: string }>>`
    WITH receipts AS (
      SELECT receipt_id AS ref, record FROM harness_shared.resource_governor_admissions
        WHERE workspace_id = ${input.workspaceId} AND admission_class = 'agent'
      UNION ALL
      SELECT feature_id AS ref, payload->'resource_governor' AS record FROM harness_shared.work_items
        WHERE workspace_id = ${input.workspaceId} AND payload->'resource_governor'->>'admissionClass' = 'agent'
    ) SELECT ref FROM receipts
      WHERE record->'metadata'->>'launchedBy' = ${input.ownerId}
        AND record->'metadata'->>'fleetSlug' = ${input.row.launch!.fleetSlug}
        AND (record->>'enqueuedAtMs')::double precision <= ${to}
        AND ((record->>'enqueuedAtMs')::double precision >= ${from}
          OR (record->>'updatedAtMs')::double precision >= ${from}
          OR record->>'state' IN ('queued', 'eligible', 'leased', 'running'))
      LIMIT 21`;
  if (rows.length > 20) throw new Error('scoped admission receipt census exceeds its bound');
  return rows.map((row) => row.ref);
}

/** Eligibility evidence at one observation, not permission to launch. Actual
 * launch admission still runs at the canonical fleet/process doors. */
export async function observeGoalPlacementAdmission(input: AdmissionInput, deps: GoalPlacementAdmissionDeps = {
  preflight: async ({ ownerId, workspaceId, row }) => {
    const { preflightExactPlanAdmission } = await import('./agent-tools/plans/plan-admission-preflight');
    return preflightExactPlanAdmission({ workspaceId, harnessSlug: row.planRef.slice(5).split('/')[0]!,
      planSlug: row.planSlug, actor: ownerId, specId: `goal-placement:${row.goalId}:${row.planSlug}`,
      fleetSlug: row.launch!.fleetSlug, requestedSeats: row.launch!.requestedSeats });
  },
  governor: async (workspaceId) => (await (await import('./resource-governor/state-snapshot'))
    .readGovernorStateSnapshot(workspaceId))?.payload ?? null,
  attempts: readGoalPlacementAdmissionAttempts, now: Date.now,
}): Promise<GoalPlacementAdmissionObservation> {
  const now = deps.now();
  const out: GoalPlacementAdmissionObservation = { version: 1, planRef: input.row.planRef,
    observedAt: new Date(now).toISOString(), planReason: 'unknown', governor: 'unknown', attempts: 'unknown', evidenceRefs: [],
    ...(input.row.launch ? { launch: { ...input.row.launch } } : {}) };
  if (!input.row.launch || (input.window && (!Number.isFinite(Date.parse(input.window.offeredAt)) ||
    !Number.isFinite(Date.parse(input.window.completedAt)) || Date.parse(input.window.offeredAt) > Date.parse(input.window.completedAt)))) return out;
  const [plan, governor, attempts] = await Promise.allSettled([
    deps.preflight(input), deps.governor(input.workspaceId), deps.attempts(input, now),
  ]);
  if (plan.status === 'fulfilled' && plan.value.plan === input.row.planSlug &&
    plan.value.ready === (plan.value.reason === 'ready')) {
    out.planReason = plan.value.reason;
    out.evidenceRefs.push(`exact-plan:${input.row.planRef}:${plan.value.reason}`);
  }
  if (governor.status === 'fulfilled' && governor.value) {
    const snapshot = governor.value;
    if (Number.isFinite(snapshot.observedAtMs) && snapshot.observedAtMs <= deps.now() && snapshot.validUntilMs >= deps.now() &&
      snapshot.admission.state !== null && snapshot.evidenceRef) {
      out.governor = snapshot.admission.state === 'paused' ||
        (snapshot.admission.state === 'constrained' && snapshot.admission.constrainedClasses.includes('agent')) ? 'restricted' : 'open';
      out.evidenceRefs.push(snapshot.evidenceRef);
    }
  }
  if (attempts.status === 'fulfilled') {
    out.attempts = attempts.value.length ? 'present' : 'none';
    out.evidenceRefs.push(...attempts.value);
  }
  out.observedAt = new Date(deps.now()).toISOString();
  return admissionSchema.parse(out);
}

/** A delayed journal must not relabel today's state as an old turn's state. */
export const GOAL_PLACEMENT_TURN_END_MAX_LAG_MS = 60_000;
/** The Stop hook can read the transcript before the client flushes the final response
 * (measured 2026-09-29: the hook's read 170ms after the final entry's stamp still ended on
 * the request's PROGRESS turn), so a progress tail is polled briefly before it is refused. */
export const GOAL_PLACEMENT_TURN_END_SETTLE_POLLS = 10;
export const GOAL_PLACEMENT_TURN_END_SETTLE_POLL_MS = 200;
export interface GoalPlacementTurnEndDeps extends Pick<GoalPlacementTurnReceiptDeps, 'current' | 'tail' | 'append' | 'now'> {
  goalSubject: (ownerId: string, workspaceId: string) => Promise<string | null>;
  agenda: (ownerId: string, workspaceId: string) => Promise<AgentObligationAgendaRead>;
  pending?: (ownerId: string, workspaceId: string) => Promise<unknown>;
  admission?: (input: AdmissionInput) => Promise<GoalPlacementAdmissionObservation>;
  sleep?: (ms: number) => Promise<void>;
}

export interface GoalPlacementTurnReceiptDeps {
  current: (ownerId: string) => Promise<SelfSession | null>;
  lookup: (ownerId: string, sessionId: string) => Promise<SelfSession | null>;
  tail: (session: SelfSession) => Promise<TranscriptTailTurn[]>;
  append: (record: ActivityRecord) => Promise<unknown>;
  now: () => number;
  admission?: (input: AdmissionInput) => Promise<GoalPlacementAdmissionObservation>;
  settle?: (input: { ownerId: string; workspaceId: string; nativeSessionId: string; receipt: unknown }) => Promise<unknown>;
}
const defaults: GoalPlacementTurnReceiptDeps = {
  current: async (ownerId) => (await import('./search/self-session')).resolveSelfSession(ownerId),
  lookup: async (ownerId, sessionId) => {
    const resolver = await import('./search/self-session');
    const current = await resolver.resolveSelfSession(ownerId);
    return current?.sessionId === sessionId ? current : resolver.resolveOwnerIsolatedSessionByPrefix(ownerId, sessionId);
  },
  tail: async (session) => (await import('./turn-journal')).readVerbatimTail(session.filePath, session.sourceKind, 50),
  append: async (record) => (await import('./activity-pg-store')).createPgTelemetryStore().append(record),
  now: Date.now,
  admission: observeGoalPlacementAdmission,
  settle: settleGoalPlacementTurn,
};

async function readPendingDelivery(ownerId: string, workspaceId: string): Promise<unknown> {
  const [{ getOrgPg }, { ORIENTATION_CURSOR_SURFACE }] = await Promise.all([
    import('@papercusp/db-org'), import('./turn-start-orientation'),
  ]);
  const rows = await getOrgPg().sql<Array<{ candidate: unknown }>>`
    SELECT pending->${GOAL_PLACEMENT_DELIVERY_KEY} AS candidate FROM harness_shared.coord_read_cursors
      WHERE workspace_id = ${workspaceId} AND owner_id = ${ownerId} AND surface = ${ORIENTATION_CURSOR_SURFACE}`;
  return rows[0]?.candidate ?? null;
}

function completedRef(session: SelfSession, turn: TranscriptTailTurn): string | null {
  if (turn.speaker !== 'assistant' || turn.responseDisposition !== 'delivered' ||
    !turn.requestId || !turn.ts || !Number.isFinite(turn.ts.getTime())) return null;
  return `${session.sourceKind}:${session.sessionId}:${turn.requestId}`;
}

function latestCompletedDecision(session: SelfSession, turns: TranscriptTailTurn[]): TranscriptTailTurn | null {
  // A newer user request or progress response is a LIVE call, not completion
  // of the last delivered response still visible earlier in the tail.
  const latest = turns[turns.length - 1];
  return latest && completedRef(session, latest) ? latest : null;
}

/** Sample policy at the native turn-end seam, independently of the next-turn ACK.
 * This is descriptive policy evidence, not a grade or a delivery receipt. Its
 * observedAt remains explicit; a later replay cannot masquerade as timely proof. */
export async function recordGoalPlacementTurnEnd(input: {
  ownerId: string; workspaceId: string; nativeSessionId: string; sourceKind: SelfSession['sourceKind'];
}, deps: GoalPlacementTurnEndDeps = { ...defaults,
  pending: readPendingDelivery,
  goalSubject: async (ownerId, workspaceId) =>
    (await import('./agent-obligation-reader')).defaultAgentObligationReaderDeps().goalSubject(workspaceId, ownerId),
  agenda: async (ownerId, workspaceId) => (await import('./agent-obligation-reader')).readAgentObligationAgenda({ ownerId, workspaceId }),
}): Promise<{ recorded: boolean; reason: string }> {
  // Most journal callers do not hold a GOAL. One indexed mode read avoids
  // transcript and portfolio IO for them; missing scope is never inferred.
  const goalId = await deps.goalSubject(input.ownerId, input.workspaceId);
  if (!goalId) return { recorded: false, reason: 'no-canonical-goal' };
  const session = await deps.current(input.ownerId);
  if (!session || session.sessionId !== input.nativeSessionId || session.sourceKind !== input.sourceKind) {
    return { recorded: false, reason: 'native-session-mismatch' };
  }
  let tail = await deps.tail(session);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  // The Stop hook can read the transcript before the final response flushes. The unflushed
  // tail then ends on a progress response, or — when the turn's assistant entries were
  // tool-only — on the user request itself (measured live: final at 00:33:17.925Z, hook read
  // at 00:33:18.226Z, tail ended on the wake prompt). Both settle; nothing else is polled.
  const unflushed = (last: TranscriptTailTurn | undefined) => last?.speaker === 'user' ||
    (last?.speaker === 'assistant' && last.responseDisposition === 'progress');
  for (let poll = 0; poll < GOAL_PLACEMENT_TURN_END_SETTLE_POLLS && !latestCompletedDecision(session, tail) &&
    unflushed(tail[tail.length - 1]); poll++) {
    await sleep(GOAL_PLACEMENT_TURN_END_SETTLE_POLL_MS);
    tail = await deps.tail(session);
  }
  const completed = latestCompletedDecision(session, tail);
  if (!completed) return { recorded: false, reason: 'native-decision-not-complete' };
  const endedAt = completed.ts!.getTime();
  const timely = (now: number) => Number.isFinite(now) && now >= endedAt && now - endedAt <= GOAL_PLACEMENT_TURN_END_MAX_LAG_MS;
  if (!timely(deps.now())) return { recorded: false, reason: 'turn-end-observation-stale' };
  const read = await deps.agenda(input.ownerId, input.workspaceId);
  if (!read.goalId) return { recorded: false, reason: 'no-canonical-goal' };
  if (read.goalId !== goalId) return { recorded: false, reason: 'goal-scope-changed-during-observation' };
  const observedAt = Date.parse(read.observedAt);
  if (!timely(observedAt) || !timely(deps.now()) || observedAt > deps.now()) {
    return { recorded: false, reason: 'turn-end-observation-stale' };
  }
  const again = latestCompletedDecision(session, await deps.tail(session));
  if (!again || completedRef(session, again) !== completedRef(session, completed)) {
    return { recorded: false, reason: 'native-decision-advanced-during-observation' };
  }
  const rows = read.agenda.evaluations.filter((row) => row.family === 'plan-placement' &&
    row.scope.ownerId === input.ownerId && row.scope.workspaceId === input.workspaceId && row.scope.goalId === read.goalId)
    .map((row) => ({ planSlug: row.scope.planSlug ?? null,
      planRef: row.action?.targetRef?.startsWith('plan:') ? row.action.targetRef : null,
      status: row.status, applicableDemand: row.applicableDemand, actionKind: row.action?.kind ?? null,
      obligationId: row.id, sourceGeneration: row.sourceGeneration, ruleRevision: row.ruleRevision,
      // An `unknown` row is only diagnosable with its reason: without the code a
      // no-opportunity trial cannot tell a failed read from a genuinely unplaced plan.
      ...(row.measurementFailure ? { measurementFailure: {
        code: row.measurementFailure.code, detail: row.measurementFailure.detail.slice(0, 500) } } : {}) }));
  if (!rows.length) return { recorded: false, reason: 'placement-policy-unmeasured' };
  const parsedDelivery = goalPlacementDeliverySchema.safeParse(await deps.pending?.(input.ownerId, input.workspaceId));
  const delivery = parsedDelivery.success && parsedDelivery.data.ownerId === input.ownerId &&
    parsedDelivery.data.workspaceId === input.workspaceId && parsedDelivery.data.nativeSessionId === session.sessionId &&
    parsedDelivery.data.sourceKind === session.sourceKind && Date.parse(parsedDelivery.data.offeredAt) <= endedAt
    ? parsedDelivery.data : null;
  const admissionRows = delivery && deps.admission ? await Promise.all(delivery.rows.filter((row) => row.goalId === goalId)
    .map(async (row) => ({ planRef: row.planRef, admission: await deps.admission!({ ownerId: input.ownerId,
      workspaceId: input.workspaceId, row, window: { offeredAt: delivery.offeredAt, completedAt: completed.ts!.toISOString() } }) }))) : [];
  // Admission IO can span a new request or exceed the native observation window.
  // Recheck after that IO too; an earlier policy sample alone cannot prove this.
  const afterAdmission = latestCompletedDecision(session, await deps.tail(session));
  if (!timely(deps.now()) || !afterAdmission || completedRef(session, afterAdmission) !== completedRef(session, completed)) {
    return { recorded: false, reason: 'native-decision-advanced-during-observation' };
  }
  await deps.append({ workspaceId: input.workspaceId, owner: input.ownerId, agent: session.sourceKind,
    sessionId: session.sessionId, scope: read.portfolio?.worklist[0]?.harness ?? null,
    kind: 'lifecycle', toolName: null, phase: null, toolUseId: `goal-placement-turn-end:${completedRef(session, completed)}`,
    summary: 'Goal placement policy observed at native turn end', status: 'ok', cwd: null,
    detail: { goalPlacementTurnEnd: { version: 1, goalId: read.goalId,
      completedTurnRef: completedRef(session, completed), completedAt: completed.ts!.toISOString(),
      observedAt: read.observedAt, rows,
      ...(delivery ? { deliveryToken: delivery.token, admissions: admissionRows } : {}) } },
  });
  return { recorded: true, reason: 'turn-end-policy-recorded-not-yet-graded' };
}

/** Fail-soft bounded extension of the existing journal hook. No new Stop hook,
 * local token file, model call or background routine is introduced. */
export async function boundedRecordGoalPlacementTurnEnd(input: Parameters<typeof recordGoalPlacementTurnEnd>[0]) {
  const [{ withBoundedTimeout }, { trackDetached }] = await Promise.all([
    import('./bounded-timeout'), import('./detached-imports'),
  ]);
  return (await withBoundedTimeout(trackDetached(recordGoalPlacementTurnEnd(input)), {
    // Settle polling (<=2s) plus the agenda read (0.65-0.92s measured live) must both fit, and
    // the detached Stop hook's 5s HTTP budget still has to cover the journal leg after this.
    timeoutMs: 3_500, label: 'goal-placement-turn-end', fallback: { recorded: false, reason: 'turn-end-read-unavailable' },
  })).value;
}

/** Only whole, actually rendered actionable rows may become receipt candidates. */
export function deliveredGoalPlacementRows(input: {
  ownerId: string; workspaceId: string; brief: AgentObligationBrief | null | undefined; block: string;
}): GoalPlacementDelivery['rows'] {
  return (input.brief?.projection.entries ?? []).flatMap((row) => {
    if (row.family !== 'plan-placement' || row.status !== 'due' || row.applicableDemand <= 0 ||
      row.scope.ownerId !== input.ownerId || row.scope.workspaceId !== input.workspaceId ||
      !row.scope.goalId || !row.scope.planSlug || !row.action ||
      !['delegate', 'continue', 'repair'].includes(row.action.kind) ||
      !input.block.includes(formatAgentObligationLine(row, 'action'))) return [];
    const parsed = rowSchema.safeParse({ goalId: row.scope.goalId, planSlug: row.scope.planSlug,
      planRef: row.action.targetRef, obligationId: row.id, sourceGeneration: row.sourceGeneration,
      ruleRevision: row.ruleRevision,
      ...(((row.action.kind === 'delegate' && row.action.tool === 'fleet:launch-on-plan') ||
        (row.action.kind === 'repair' && row.action.tool === undefined)) &&
        typeof row.action.args?.name === 'string' && row.action.args?.plan === row.scope.planSlug &&
        row.action.targetRef === `plan:${row.action.args?.harness}/${row.scope.planSlug}`
        ? { launch: { fleetSlug: row.action.args.name, requestedSeats: row.action.args.count ?? 1 } } : {}) });
    return parsed.success ? [parsed.data] : [];
  }).slice(0, 3);
}

export async function prepareGoalPlacementDelivery(input: {
  ownerId: string; workspaceId: string; token: string;
  brief: AgentObligationBrief | null | undefined; block: string;
}, deps: GoalPlacementTurnReceiptDeps = defaults): Promise<GoalPlacementDelivery | null> {
  const rows = deliveredGoalPlacementRows(input);
  if (!rows.length) return null;
  const session = await deps.current(input.ownerId);
  if (!session) return null;
  const turns = await deps.tail(session);
  const baseline = [...turns].reverse().find((turn) => completedRef(session, turn) !== null);
  // Without a retained baseline, a truncated tail cannot prove this is the
  // first decision of a session. Missing evidence is not zero prior decisions.
  if (!baseline && turns.some((turn) => turn.requestHistoryStatus === 'truncated')) return null;
  const observedRows = deps.admission ? await Promise.all(rows.map(async (row) => ({ ...row,
    admission: await deps.admission!({ ownerId: input.ownerId, workspaceId: input.workspaceId, row }) }))) : rows;
  const now = deps.now();
  if (!Number.isFinite(now) || (baseline?.ts && baseline.ts.getTime() > now)) return null;
  return goalPlacementDeliverySchema.parse({ version: 1, ownerId: input.ownerId,
    workspaceId: input.workspaceId, token: input.token, offeredAt: new Date(now).toISOString(),
    nativeSessionId: session.sessionId, sourceKind: session.sourceKind,
    baselineTurnRef: baseline ? completedRef(session, baseline) : null, rows: observedRows });
}

/**
 * Record evidence, NOT an eligible-opportunity count or an agent grade. Later
 * progress readers must still join canonical effects and typed exclusions.
 * The current observation is named "at confirmation", never backdated to
 * the native completion timestamp.
 */
export async function confirmGoalPlacementDelivery(input: {
  ownerId: string; workspaceId: string; confirmedToken: string | null | undefined;
  candidate: unknown; brief: AgentObligationBrief | null | undefined;
}, deps: GoalPlacementTurnReceiptDeps = defaults): Promise<{ recorded: number; reason: string }> {
  const parsed = goalPlacementDeliverySchema.safeParse(input.candidate);
  if (!parsed.success || !input.confirmedToken) return { recorded: 0, reason: 'no-exact-proof-candidate' };
  const candidate = parsed.data;
  if (candidate.ownerId !== input.ownerId || candidate.workspaceId !== input.workspaceId ||
    candidate.token !== input.confirmedToken) return { recorded: 0, reason: 'scope-or-token-mismatch' };
  const session = await deps.lookup(input.ownerId, candidate.nativeSessionId);
  if (!session || session.sessionId !== candidate.nativeSessionId || session.sourceKind !== candidate.sourceKind) {
    return { recorded: 0, reason: 'native-session-unavailable' };
  }
  const turns = await deps.tail(session);
  let baseline = -1;
  if (candidate.baselineTurnRef !== null) {
    for (let index = turns.length - 1; index >= 0; index -= 1) {
      if (completedRef(session, turns[index]!) === candidate.baselineTurnRef) {
        baseline = index;
        break;
      }
    }
  }
  if ((candidate.baselineTurnRef !== null && baseline < 0) ||
    (candidate.baselineTurnRef === null && turns.some((turn) => turn.requestHistoryStatus === 'truncated'))) {
    return { recorded: 0, reason: 'native-window-incomplete' };
  }
  const now = deps.now();
  const completed = turns.slice(baseline + 1).find((turn) => {
    const ref = completedRef(session, turn);
    return ref !== null && ref !== candidate.baselineTurnRef && turn.ts!.getTime() >= Date.parse(candidate.offeredAt)
      && turn.ts!.getTime() <= now;
  });
  if (!completed) return { recorded: 0, reason: 'no-completed-native-decision' };
  let recorded = 0;
  for (const row of candidate.rows) {
    const current = input.brief?.evaluations.find((entry) => entry.family === 'plan-placement' &&
      entry.scope.ownerId === input.ownerId && entry.scope.workspaceId === input.workspaceId &&
      entry.scope.goalId === row.goalId && entry.scope.planSlug === row.planSlug);
    const receipt = { version: 1, ...row, deliveryToken: candidate.token,
      offeredAt: candidate.offeredAt, completedAt: completed.ts!.toISOString(),
      completedTurnRef: completedRef(session, completed), confirmedAt: new Date(now).toISOString(),
      atConfirmation: current ? { status: current.status, obligationId: current.id,
        sourceGeneration: current.sourceGeneration, ruleRevision: current.ruleRevision } : null };
    await deps.append({ workspaceId: input.workspaceId, owner: input.ownerId, agent: session.sourceKind,
      sessionId: session.sessionId, scope: row.planRef.slice(5).split('/')[0]!, kind: 'lifecycle',
      toolName: null, phase: null, toolUseId: `goal-placement:${candidate.token}:${row.obligationId}`,
      summary: 'Confirmed goal-plan delivery with a native completed decision', status: 'ok', cwd: null,
      detail: { goalPlacementTurn: receipt },
    });
    await deps.settle?.({ ownerId: input.ownerId, workspaceId: input.workspaceId,
      nativeSessionId: session.sessionId, receipt });
    recorded += 1;
  }
  return { recorded, reason: 'native-decision-recorded-not-yet-graded' };
}

const confirmedTurnSchema = rowSchema.extend({ version: z.literal(1), deliveryToken: nonempty,
  offeredAt: dateTime, completedAt: dateTime, completedTurnRef: nonempty, confirmedAt: dateTime }).passthrough();
const turnEndSchema = z.object({ version: z.literal(1), goalId: nonempty, completedTurnRef: nonempty,
  completedAt: dateTime, observedAt: dateTime, deliveryToken: nonempty.optional(),
  rows: z.array(z.object({ planSlug: nonempty.nullable(), planRef: planRefSchema.nullable(),
    status: z.enum(['due', 'in-progress', 'blocked', 'satisfied', 'not-applicable', 'unknown']),
    applicableDemand: z.number(), actionKind: z.string().nullable(), obligationId: nonempty,
    sourceGeneration: nonempty, ruleRevision: nonempty,
    measurementFailure: z.object({ code: nonempty, detail: z.string() }).optional() })),
  admissions: z.array(z.object({ planRef: planRefSchema, admission: admissionSchema })).optional(),
});

function admissionEligibility(observation: GoalPlacementAdmissionObservation | undefined): boolean | null {
  if (!observation) return null;
  if (observation.attempts === 'present' || observation.governor === 'restricted') return false;
  if (!['ready', 'unknown', 'lane-unknown', 'floor-diagnostics-unavailable'].includes(observation.planReason)) return false;
  if (observation.planReason !== 'ready' || observation.governor === 'unknown' || observation.attempts === 'unknown') return null;
  return true;
}

/** Pure proof join. A later confirmation policy is deliberately absent from
 * this calculation. Missing evidence remains unknown and cannot add debt. */
export function qualifyGoalPlacementTurn(input: {
  receipt: unknown; turnEnd: unknown; nativeSessionId: string;
}): GoalPlacementOpportunity | null {
  const a = confirmedTurnSchema.safeParse(input.receipt);
  const b = turnEndSchema.safeParse(input.turnEnd);
  if (!a.success || !b.success) return null;
  const receipt = a.data, end = b.data;
  const matchesLaunch = (observation: GoalPlacementAdmissionObservation | undefined) =>
    receipt.launch !== undefined && observation?.launch !== undefined &&
    observation.launch.fleetSlug === receipt.launch.fleetSlug &&
    observation.launch.requestedSeats === receipt.launch.requestedSeats;
  if (!['claude', 'codex', 'omp'].some((kind) => receipt.completedTurnRef.startsWith(`${kind}:${input.nativeSessionId}:`)) ||
    end.goalId !== receipt.goalId || end.deliveryToken !== receipt.deliveryToken ||
    end.completedTurnRef !== receipt.completedTurnRef || end.completedAt !== receipt.completedAt) return null;
  const offeredAt = Date.parse(receipt.offeredAt), completedAt = Date.parse(receipt.completedAt);
  const observedAt = Date.parse(end.observedAt), confirmedAt = Date.parse(receipt.confirmedAt);
  if (offeredAt > completedAt || completedAt > confirmedAt || observedAt < completedAt ||
    observedAt > confirmedAt || observedAt - completedAt > GOAL_PLACEMENT_TURN_END_MAX_LAG_MS) return null;
  const rows = end.rows.filter((row) => row.planRef === receipt.planRef && row.planSlug === receipt.planSlug);
  if (rows.length !== 1 || rows[0]!.ruleRevision !== receipt.ruleRevision) return null;
  const row = rows[0]!;
  const offer = receipt.admission;
  if (!offer || !matchesLaunch(offer) || offer.planRef !== receipt.planRef || Date.parse(offer.observedAt) > offeredAt ||
    offeredAt - Date.parse(offer.observedAt) > GOAL_PLACEMENT_TURN_END_MAX_LAG_MS) return null;
  const eligibleAtOffer = admissionEligibility(offer);
  let eligibleAtCompletion: boolean | null;
  if (row.status === 'unknown') return null;
  if (row.status !== 'due' || row.applicableDemand <= 0 || !['delegate', 'repair'].includes(row.actionKind ?? '')) {
    eligibleAtCompletion = false;
  } else {
    if (row.obligationId !== receipt.obligationId || row.sourceGeneration !== receipt.sourceGeneration) return null;
    const admissions = end.admissions?.filter((entry) => entry.planRef === receipt.planRef) ?? [];
    if (admissions.length !== 1) return null;
    const finish = admissions[0]!.admission;
    const at = Date.parse(finish.observedAt);
    if (!matchesLaunch(finish) || finish.planRef !== receipt.planRef || at < completedAt || at > confirmedAt ||
      at - completedAt > GOAL_PLACEMENT_TURN_END_MAX_LAG_MS) return null;
    eligibleAtCompletion = admissionEligibility(finish);
  }
  if (eligibleAtOffer === null || eligibleAtCompletion === null) return null;
  return { deliveryToken: receipt.deliveryToken, completedTurnRef: receipt.completedTurnRef,
    offeredAt: receipt.offeredAt, completedAt: receipt.completedAt, eligibleAtOffer, eligibleAtCompletion };
}

/** Settle only the earliest durable turn-end observation of this exact native
 * decision. A later replay cannot upgrade an unmeasured/blocked first sample. */
export async function settleGoalPlacementTurn(input: {
  ownerId: string; workspaceId: string; nativeSessionId: string; receipt: unknown;
}): Promise<{ recorded: boolean; reason: string }> {
  const parsed = confirmedTurnSchema.safeParse(input.receipt);
  if (!parsed.success) return { recorded: false, reason: 'invalid-confirmed-receipt' };
  const receipt = parsed.data;
  const { getOrgPg } = await import('@papercusp/db-org');
  const rows = await getOrgPg().sql<Array<{ turn_end: unknown }>>`
    SELECT detail->'goalPlacementTurnEnd' AS turn_end FROM harness_shared.agent_activity
      WHERE workspace_id = ${input.workspaceId} AND owner_id = ${input.ownerId}
        AND session_id = ${input.nativeSessionId}
        AND tool_use_id = ${`goal-placement-turn-end:${receipt.completedTurnRef}`}
      ORDER BY agent_activity.id ASC LIMIT 1`;
  const opportunity = qualifyGoalPlacementTurn({ receipt, turnEnd: rows[0]?.turn_end, nativeSessionId: input.nativeSessionId });
  if (!opportunity) return { recorded: false, reason: 'completed-eligibility-unmeasured' };
  const { recordCompletedGoalPlacementOpportunity } = await import('./goal-placement-progress-store');
  const recorded = await recordCompletedGoalPlacementOpportunity({ scope: { ownerId: input.ownerId,
    workspaceId: input.workspaceId, goalId: receipt.goalId, planRef: receipt.planRef },
    now: receipt.confirmedAt, opportunity });
  return { recorded, reason: recorded ? 'completed-opportunity-reduced' : 'receipt-replayed-or-superseded' };
}

/** Recover a failed immediate reduction on a later orientation/cold successor.
 * Source receipts stay in activity; replay is cheap and the cursor deduplicates
 * by exact delivery/native decision under the same lock as effect writes. */
export async function reconcileConfirmedGoalPlacementTurns(input: {
  ownerId: string; workspaceId: string; goalId: string;
}): Promise<number> {
  const { getOrgPg } = await import('@papercusp/db-org');
  const rows = await getOrgPg().sql<Array<{ session_id: string; receipt: unknown }>>`
    SELECT session_id, receipt FROM (
      SELECT id, session_id, detail->'goalPlacementTurn' AS receipt FROM harness_shared.agent_activity
        WHERE workspace_id = ${input.workspaceId} AND owner_id = ${input.ownerId}
          AND detail->'goalPlacementTurn'->>'goalId' = ${input.goalId}
        ORDER BY agent_activity.id DESC LIMIT 32
    ) recent ORDER BY id ASC`;
  let recorded = 0;
  for (const row of rows) {
    const result = await settleGoalPlacementTurn({ ...input, nativeSessionId: row.session_id, receipt: row.receipt });
    if (result.recorded) recorded += 1;
  }
  return recorded;
}
