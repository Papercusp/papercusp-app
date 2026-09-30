/**
 * decision-owed-source.ts — "possibly-unrecorded owner decision" detector
 * (EI-147: "Owner decisions made in conversation aren't reliably recorded
 * into plans").
 *
 * EI-147's root complaint is a PROCESS gap, not a mechanical one: the
 * `plans:*` write path is reliable (EI-117's silent-revert bug is fixed —
 * CAS'd writes, revision-chain intact), but recording a decision still
 * depends on whichever agent is in the conversation remembering to call
 * `plans:add-decision`. This module builds the mechanical (no-LLM-judgment)
 * half of the ticket's ask — "surface a 'decisions owed' checklist to the
 * conversing agent" — from infrastructure that already exists:
 *
 *   1. `session_pending_gates` (owner-inbox-single-pane-2026-07-17 P-002,
 *      fed by gate-watch.ts): a CLOSED `ask` gate is an AskUserQuestion /
 *      ExitPlanMode the owner actually answered — a decision-shaped
 *      exchange, detected purely from the transcript, no LLM required.
 *   2. `harness_shared.adv_sessions` (coord_owner_id ↔ native session_id):
 *      resolves which coordination identity (su-…) was running that
 *      session.
 *   3. `harness_shared.tool_invocations.coord_owner_id` (migration 427):
 *      whether that identity called `plans:add-decision` /
 *      `plans:ratify-decision` AFTER the gate closed.
 *
 * A closed ask with no matching decision-recording call in the window is
 * "possibly owed" — a heuristic NUDGE (false positives are expected: not
 * every answered question is a plan-worthy decision), never an auto-write.
 * The full "extract + auto-record" half of EI-147 stays explicitly out of
 * scope (it needs an LLM judgment pass over the answer content, a genuine
 * product-direction call on cost/latency/false-positive-rate) — this is the
 * scoped, mechanical slice.
 *
 * Consumed by `plans:attention` (the unified owner Inbox — attention.ts
 * source #16) and directly callable for a single session's own checklist
 * (e.g. a conversing agent checking itself before it compacts/ends).
 */

import { getOrgPg } from '@papercusp/db-org';
import { listClosedAskGatesSince, type PendingGateRow } from './gate-store';

const DECISION_RECORDING_TOOLS = ['plans:add-decision', 'plans:ratify-decision'] as const;

export interface DecisionOwedCandidate {
  sessionId: string;
  refId: string;
  client: string;
  question: string | null;
  options: Array<{ label: string; description?: string }> | null;
  closedAt: string;
  ownerId: string | null;
  harnessSlug: string | null;
}

export interface DecisionRecordEvent {
  ownerId: string;
  invokedAt: string;
}

/**
 * PURE: which candidates have NO decision-recording call, by the SAME owner,
 * between the candidate's `closedAt` and `asOfIso`. A candidate with no
 * resolvable `ownerId` is dropped (unattributable — never false-flagged).
 */
export function findUnmatchedDecisionGates(
  gates: DecisionOwedCandidate[],
  decisionEvents: DecisionRecordEvent[],
  asOfIso: string,
): DecisionOwedCandidate[] {
  const asOfMs = Date.parse(asOfIso);
  const byOwner = new Map<string, number[]>();
  for (const e of decisionEvents) {
    const t = Date.parse(e.invokedAt);
    if (!e.ownerId || !Number.isFinite(t)) continue;
    const arr = byOwner.get(e.ownerId) ?? [];
    arr.push(t);
    byOwner.set(e.ownerId, arr);
  }
  return gates.filter((g) => {
    if (!g.ownerId) return false;
    const closedMs = Date.parse(g.closedAt);
    if (!Number.isFinite(closedMs)) return false;
    const times = byOwner.get(g.ownerId);
    if (!times || times.length === 0) return true;
    return !times.some((t) => t >= closedMs && t <= asOfMs);
  });
}

export interface ReadDecisionsOwedOptions {
  workspaceId: string;
  /** How far back to scan closed asks + decision calls. Default 24h. */
  lookbackHours?: number;
  /** Narrow to one session (e.g. the conversing agent's own self-check). */
  sessionId?: string;
  limit?: number;
}

/**
 * Read + resolve: closed asks in the lookback window → owner-resolved via
 * adv_sessions → filtered against `plans:add-decision`/`ratify-decision`
 * calls by that owner. Best-effort by construction (every query is narrow +
 * indexed); throws propagate to the caller, which — per every other
 * `plans:attention` source — treats this as a best-effort try/catch leg.
 */
export async function readDecisionsOwed(opts: ReadDecisionsOwedOptions): Promise<DecisionOwedCandidate[]> {
  const { sql } = getOrgPg();
  const lookbackHours = opts.lookbackHours ?? 24;
  const sinceIso = new Date(Date.now() - lookbackHours * 3_600_000).toISOString();
  const nowIso = new Date().toISOString();

  const gateRows: PendingGateRow[] = await listClosedAskGatesSince({
    workspaceId: opts.workspaceId,
    sinceIso,
    limit: opts.limit ?? 100,
  });
  const scoped = opts.sessionId ? gateRows.filter((g) => g.session_id === opts.sessionId) : gateRows;
  if (scoped.length === 0) return [];

  const sessionIds = [...new Set(scoped.map((g) => g.session_id))];
  const ownerRows = await sql<Array<{ session_id: string; coord_owner_id: string | null }>>`
    SELECT DISTINCT ON (session_id) session_id, coord_owner_id
    FROM harness_shared.adv_sessions
    WHERE session_id = ANY(${sessionIds})
    ORDER BY session_id, started_at DESC
  `;
  const ownerBySession = new Map(ownerRows.map((r) => [r.session_id, r.coord_owner_id]));

  const candidates: DecisionOwedCandidate[] = scoped.map((g) => ({
    sessionId: g.session_id,
    refId: g.ref_id,
    client: g.client,
    question: g.question,
    options: g.options,
    closedAt: g.closed_at as string,
    ownerId: ownerBySession.get(g.session_id) ?? g.owner_id ?? null,
    harnessSlug: g.harness_slug,
  }));

  const ownerIds = [...new Set(candidates.map((c) => c.ownerId).filter((x): x is string => Boolean(x)))];
  if (ownerIds.length === 0) return [];

  const invRows = await sql<Array<{ coord_owner_id: string; invoked_at: string }>>`
    SELECT coord_owner_id, invoked_at::text AS invoked_at
    FROM harness_shared.tool_invocations
    WHERE coord_owner_id = ANY(${ownerIds})
      AND tool_name = ANY(${[...DECISION_RECORDING_TOOLS]})
      AND invoked_at >= ${sinceIso}
  `;
  const decisionEvents: DecisionRecordEvent[] = invRows
    .filter((r) => r.coord_owner_id)
    .map((r) => ({ ownerId: r.coord_owner_id, invokedAt: r.invoked_at }));

  return findUnmatchedDecisionGates(candidates, decisionEvents, nowIso);
}
