/**
 * agent-run-evidence-record.ts — the SERVER-DERIVED evidence record stamped on
 * every `scorecards:emit` card whose subject is `{ kind:'agent-run', ref:<holder> }`.
 *
 * Acceptance clause R-1 of goal-agent-behavior-feedback-2026-09-06
 * (AUTO-BAR-R-1-P-001/P-002/P-014): "Each sampled run has an evidence record
 * containing its goal, holder, observation window, source generation and
 * instruction exposure." Falsifier: "Any sampled run lacks its actual consumed
 * payload, subject/window or source/runtime generation."
 *
 * WI-10003539 measured the live gap: every live goal-mode-e2e card carried
 * holder + window, but 0/10 carried a goal id and 0/10 carried a structured
 * instruction exposure, because the emit subject schema is strict
 * `{ kind, ref, windowStart, windowEnd }` and nothing derived the rest.
 *
 * Design rules:
 *  - DERIVED, never grader-typed. The grader cannot supply this record: the
 *    emit args have no slot for it, and emit writes it after the subject.
 *  - The goal link is read from the most window-specific source first (see
 *    `findGoal`): the holder's own goal-stamped `tool_invocations` inside the
 *    window, then its `agent_modes` goal-lease row, then
 *    `goals.metadata.agentOwnerId`. That last field names only the agent that
 *    STARTED the goal and is never updated when the lease moves (plan
 *    goal-holder-plans-ideation-truthful-reports-2026-10-03 D-003), so reading
 *    it first mapped a former holder to a goal it no longer held and gave a
 *    lease successor no metadata link at all. `goalSource` names which one answered.
 *    Exposure comes from the holder's launch record
 *    (`adv_sessions.launch_spec.specificationRevision` = the lowercase sha256
 *    of the compiled specification artifact the holder was launched with, and
 *    `stateRevision` = its mode/state generation).
 *  - An absent source is recorded as ABSENT (`not-recorded` / `not-found`),
 *    never fabricated. A grader reading `instructionExposure.status !==
 *    'recorded'` must rate exposure-dependent criteria unknown.
 *  - A failed derivation never fails the emit: it yields `derivation-failed`.
 */

/** Minimal tagged-template SQL seam (postgres.js `Sql`, or a fake in unit tests). */
export type EvidenceRecordSql = <T = Record<string, unknown>>(
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<T[]>;

export type GoalSource =
  | 'tool_invocations'
  | 'agent_modes'
  | 'goals.agentOwnerId'
  | 'not-found'
  | 'derivation-failed';

export type InstructionExposure =
  | {
      status: 'recorded';
      /** The holder's control-state generation at launch (launch_spec.stateRevision). */
      generation: string;
      /** `sha256:<launch_spec.specificationRevision>` — hash of the compiled instructions the holder consumed. */
      consumedPayloadHash: string;
      source: 'adv_sessions.launch_spec';
      /** The exposure is the one delivered at this launch; a later in-session re-activation is not reflected. */
      observedAt: 'launch';
    }
  | { status: 'not-recorded'; reason: string }
  | { status: 'derivation-failed'; reason: string };

export interface AgentRunSourceGeneration {
  /** adv_sessions.id of the holder's launch that was running at the window end. */
  advSessionId: string;
  startedAt: string;
  model: string | null;
}

export interface AgentRunEvidenceRecord {
  schemaVersion: 1;
  derivedBy: 'server';
  holder: string;
  window: { start: string | null; end: string | null };
  goalId: string | null;
  goalSource: GoalSource;
  sourceGeneration: AgentRunSourceGeneration | null;
  instructionExposure: InstructionExposure;
}

export interface DeriveAgentRunEvidenceRecordInput {
  sql: EvidenceRecordSql;
  workspaceId: string;
  holder: string;
  windowStart?: string | null;
  windowEnd?: string | null;
}

const SHA256_RE = /^[0-9a-f]{64}$/;

/** A subject window bound is advisory text; only a parseable instant narrows the lookup. */
function instantOrNull(value: string | null | undefined): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function isoOrString(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

interface InvocationGoalRow {
  goal_id: string | null;
}
interface GoalRow {
  id: string;
}
interface ModeRow {
  subject: string | null;
}
interface SessionRow {
  id: string | number;
  started_at: Date | string;
  specification_revision: string | null;
  state_revision: string | null;
  model: string | null;
}

/**
 * Which goal the holder was pursuing in the graded window. Sources in order, most
 * window-specific first; the first that answers wins and is named in `goalSource`:
 *
 *  1. `tool_invocations`: the goal the holder's own goal-stamped calls served INSIDE
 *     the window (most calls, then most recent). Durable and scoped to exactly the
 *     graded window. Needs both bounds: an owner scan without a window is not an
 *     answer about this window.
 *  2. `agent_modes`: the holder's goal-lease row set no later than the window end.
 *     Right for a lease successor, whom goals.metadata never names. It is current
 *     state and can be reaped once the holder exits, which is why it is not first.
 *  3. `goals.metadata.agentOwnerId`: the agent that STARTED a goal created by the
 *     window end. goals/start.ts writes it once and lease succession never updates
 *     it (D-003: at 2026-10-03 02:50Z it named su-6aab097a while su-9e72a11f held
 *     lease epoch 18), so it is the weakest link and only a last resort.
 */
async function findGoal(
  sql: EvidenceRecordSql,
  workspaceId: string,
  holder: string,
  windowStart: string | null,
  windowEnd: string | null,
): Promise<{ goalId: string | null; goalSource: GoalSource }> {
  if (windowStart && windowEnd) {
    const calls = await sql<InvocationGoalRow>`
      SELECT goal_id
        FROM harness_shared.tool_invocations
       WHERE coord_owner_id = ${holder}
         AND workspace_id = ${workspaceId}
         AND invoked_at BETWEEN ${windowStart}::timestamptz AND ${windowEnd}::timestamptz
         AND goal_id IS NOT NULL
       GROUP BY goal_id
       ORDER BY count(*) DESC, max(invoked_at) DESC
       LIMIT 1`;
    if (calls[0]?.goal_id) return { goalId: String(calls[0].goal_id), goalSource: 'tool_invocations' };
  }

  const modes = await sql<ModeRow>`
    SELECT subject
      FROM harness_shared.agent_modes
     WHERE workspace_id = ${workspaceId}
       AND owner_id = ${holder}
       AND mode = 'goal'
       AND subject IS NOT NULL
       AND (${windowEnd}::timestamptz IS NULL OR set_at <= ${windowEnd}::timestamptz)
     ORDER BY set_at DESC
     LIMIT 1`;
  if (modes[0]?.subject) return { goalId: String(modes[0].subject), goalSource: 'agent_modes' };

  const goals = await sql<GoalRow>`
    SELECT id
      FROM harness_shared.goals
     WHERE workspace_id = ${workspaceId}
       AND metadata ->> 'agentOwnerId' = ${holder}
       AND (${windowEnd}::timestamptz IS NULL OR created_at <= ${windowEnd}::timestamptz)
     ORDER BY created_at DESC
     LIMIT 1`;
  if (goals[0]?.id) return { goalId: String(goals[0].id), goalSource: 'goals.agentOwnerId' };
  return { goalId: null, goalSource: 'not-found' };
}

async function findLaunch(
  sql: EvidenceRecordSql,
  workspaceId: string,
  holder: string,
  windowEnd: string | null,
): Promise<SessionRow | null> {
  const rows = await sql<SessionRow>`
    SELECT id,
           started_at,
           launch_spec ->> 'specificationRevision' AS specification_revision,
           launch_spec ->> 'stateRevision' AS state_revision,
           launch_spec ->> 'model' AS model
      FROM harness_shared.adv_sessions
     WHERE workspace_id = ${workspaceId}
       AND coord_owner_id = ${holder}
       AND started_at IS NOT NULL
       AND (${windowEnd}::timestamptz IS NULL OR started_at <= ${windowEnd}::timestamptz)
     ORDER BY started_at DESC
     LIMIT 1`;
  return rows[0] ?? null;
}

function exposureOf(launch: SessionRow | null): InstructionExposure {
  if (!launch) {
    return { status: 'not-recorded', reason: 'no launch record (adv_sessions) for the holder at or before the window end' };
  }
  const spec = launch.specification_revision?.trim() ?? '';
  const state = launch.state_revision?.trim() ?? '';
  if (!spec || !state) {
    return {
      status: 'not-recorded',
      reason: `launch record ${String(launch.id)} carries no specificationRevision/stateRevision (launched before specification artifacts were recorded)`,
    };
  }
  if (!SHA256_RE.test(spec)) {
    return {
      status: 'not-recorded',
      reason: `launch record ${String(launch.id)} specificationRevision is not a lowercase sha256`,
    };
  }
  return {
    status: 'recorded',
    generation: state,
    consumedPayloadHash: `sha256:${spec}`,
    source: 'adv_sessions.launch_spec',
    observedAt: 'launch',
  };
}

/** Derive the evidence record for one graded agent run. Throws only on a DB error. */
export async function deriveAgentRunEvidenceRecord(
  input: DeriveAgentRunEvidenceRecordInput,
): Promise<AgentRunEvidenceRecord> {
  const windowStart = instantOrNull(input.windowStart);
  const windowEnd = instantOrNull(input.windowEnd);
  const [goal, launch] = await Promise.all([
    findGoal(input.sql, input.workspaceId, input.holder, windowStart, windowEnd),
    findLaunch(input.sql, input.workspaceId, input.holder, windowEnd),
  ]);
  return {
    schemaVersion: 1,
    derivedBy: 'server',
    holder: input.holder,
    window: { start: windowStart, end: windowEnd },
    goalId: goal.goalId,
    goalSource: goal.goalSource,
    sourceGeneration: launch
      ? { advSessionId: String(launch.id), startedAt: isoOrString(launch.started_at), model: launch.model ?? null }
      : null,
    instructionExposure: exposureOf(launch),
  };
}

export type DeriveAgentRunEvidenceRecordSafeInput = Omit<DeriveAgentRunEvidenceRecordInput, 'sql'> & {
  /**
   * Resolved INSIDE the guard, so failing to obtain the pool is contained too. A thunk,
   * not a handle: a postgres.js `Sql` is itself callable, so the two cannot be told apart.
   */
  getSql: () => EvidenceRecordSql;
};

/**
 * Emit-path wrapper: never throws. A DB failure — including failing to obtain the
 * pool at all — yields an explicit `derivation-failed` record so the card still
 * lands and the gap stays visible.
 */
export async function deriveAgentRunEvidenceRecordSafe(
  input: DeriveAgentRunEvidenceRecordSafeInput,
): Promise<AgentRunEvidenceRecord> {
  try {
    const { getSql, ...rest } = input;
    return await deriveAgentRunEvidenceRecord({ ...rest, sql: getSql() });
  } catch (err) {
    const reason = `evidence-record derivation failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 400);
    return {
      schemaVersion: 1,
      derivedBy: 'server',
      holder: input.holder,
      window: { start: instantOrNull(input.windowStart), end: instantOrNull(input.windowEnd) },
      goalId: null,
      goalSource: 'derivation-failed',
      sourceGeneration: null,
      instructionExposure: { status: 'derivation-failed', reason },
    };
  }
}
