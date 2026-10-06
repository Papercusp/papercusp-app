/**
 * P-007 Phase C (D-028): the Postgres-backed deps for completion-verification.ts. Kept apart
 * so the policy module stays pure and unit-testable, and so work_items:complete can load it
 * lazily (its unit tests mock '../../work-items').
 */
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';
import { getOrgPg } from '@papercusp/db-org';
import { createIssue, issueRef, linkIssue } from '../../issues-engineer';
import { claimWorkItem, commentWorkItem, setWorkItemState, TERMINAL_WORK_ITEM_STATES } from '../../work-items';
import {
  acceptCompletionOnSettlement,
  applyCompletionVerdict,
  COMPLETION_SETTLEMENT_ACTOR,
  COMPLETION_VERIFICATION_ACTOR,
  spawnCompletionVerification,
  type CompletionSubject,
  type LiveDependent,
} from './completion-verification';

const terminalStates = () => [...TERMINAL_WORK_ITEM_STATES].map((s) => s.toLowerCase());

async function liveDependents(subjectId: string): Promise<LiveDependent[]> {
  const sql = getOrgPg().sql;
  const rows = await sql<{ kind: string; ref: string }[]>`
    SELECT DISTINCT d.blocked_kind AS kind, d.blocked_ref AS ref
      FROM harness_shared.work_item_deps d
      JOIN harness_shared.work_items w ON w.feature_id = d.blocked_ref
     WHERE d.workspace_id = ${DEFAULT_COORD_WORKSPACE}
       AND d.dep_type = 'blocks'
       AND d.blocker_ref = ${subjectId}
       AND lower(COALESCE(w.status, '')) <> ALL(${terminalStates()}::text[])
     ORDER BY d.blocked_ref`;
  return rows.map((r: { kind: string; ref: string }) => ({ kind: r.kind, ref: r.ref }));
}

async function findOpenTask(subjectId: string): Promise<{ id: string } | null> {
  const sql = getOrgPg().sql;
  const rows = await sql<{ feature_id: string }[]>`
    SELECT feature_id
      FROM harness_shared.work_items
     WHERE payload -> 'verification' ->> 'check' = 'completion'
       AND payload -> 'verification' ->> 'subject' = ${subjectId}
       AND payload ? 'completionVerification'
       AND lower(COALESCE(status, '')) <> ALL(${terminalStates()}::text[])
     ORDER BY created_ts ASC, feature_id ASC
     LIMIT 1`;
  return rows[0] ? { id: rows[0].feature_id } : null;
}

export async function spawnCompletionVerificationForClose(subject: CompletionSubject) {
  return spawnCompletionVerification(subject, {
    liveDependents,
    findOpenTask,
    async createTask(input) {
      const created = await createIssue({
        kind: 'task',
        title: input.title,
        body: input.body,
        ...(input.harness ? { scope: `harness:${input.harness}` } : {}),
        createdBy: COMPLETION_VERIFICATION_ACTOR,
        payload: input.payload,
        // The completion policy sealed acceptance; the task needs no separate review.
        admission: 'auto',
        admittedBy: 'bypass:completion-verification',
      });
      return { id: created.id };
    },
    async addBlockingEdge(taskId, dependent) {
      await linkIssue(taskId, { kind: dependent.kind, ref: dependent.ref }, 'blocks', COMPLETION_VERIFICATION_ACTOR, 'success');
    },
    now: () => new Date(),
  });
}

export async function applyCompletionVerdictForClose(input: { taskPayload: unknown; completion: unknown; verifier: string }) {
  return applyCompletionVerdict(input, {
    async reopenSubject(subjectId, closer, by) {
      await setWorkItemState(subjectId, 'open', { by, force: true, completionRef: `completion verification rejected by ${by}` });
      await claimWorkItem(subjectId, closer, { assignedBy: by });
    },
    async comment(subjectId, body, by) {
      await commentWorkItem(subjectId, body, by);
    },
  });
}

export async function acceptCompletionOnSettlementForSubject(subjectId: string, authority: string) {
  return acceptCompletionOnSettlement(
    { subjectId, authority },
    {
      findOpenTask,
      async closeAccepted(taskId, subject, settledAuthority) {
        await setWorkItemState(taskId, 'done', {
          by: COMPLETION_SETTLEMENT_ACTOR,
          completionRef: `accepted by settlement: ${subject} settled at authority '${settledAuthority}'`,
          skipCompletionGate: true,
        });
      },
    },
  );
}

/** Kept for symmetry with the edge writer: the endpoint a subject id resolves to. */
export const subjectEndpoint = issueRef;
