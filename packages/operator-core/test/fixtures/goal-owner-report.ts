import type { GoalOwnerReportSnapshotV1 } from '@papercusp/chat-protocol';
import type { Sql } from 'postgres';
import { hostname } from 'node:os';

/** Match the production holder oracle with the actual living fixture process.
 * A goal mode and registered await alone do not establish holder liveness.
 * Callers supply only a disposable test database.
 */
export async function seedGoalReportFixturePresence(sql: Sql, workspaceId: string, ownerId: string, at: string): Promise<void> {
  await sql`INSERT INTO harness_shared.coord_presence
    (workspace_id,owner_id,owner_label,source,host,pid,heartbeat_at,last_active_at)
    VALUES (${workspaceId},${ownerId},'Isolated report assertion','isolated-report-assertion',
      ${hostname()},${process.pid},${at}::timestamptz,${at}::timestamptz)`;
  // The oracle derives liveTurn from recorded work, not presence heartbeat.
  // This records the assertion that this real process is now executing.
  await sql`INSERT INTO harness_shared.agent_activity (workspace_id,owner_id,kind,summary,created_at)
    VALUES (${workspaceId},${ownerId},'tool','Isolated canonical report assertion',${at}::timestamptz)`;
}

/** Run the real browser fetch without modifying Tauri's read-only internals.
 * The exact returned pin is the workspace/routing control. IPC transmission is
 * explicitly unknown: a failed assignment to invoke cannot measure it.
 */
export function goalReportBrowserFeedProbeScript(request: string): string {
  return `(()=>{window.__goalReportFeedProbe={done:false};
    const descriptor=Object.getOwnPropertyDescriptor(window.__TAURI_INTERNALS__??{},'invoke');
    const ipcTransmission={status:'unknown',reason:'Tauri invoke is not an instrumented transport seam',
      invokeWritable:descriptor?.writable??null,invokeConfigurable:descriptor?.configurable??null};
    (async()=>{try{const response=await fetch(${JSON.stringify(request)});
      window.__goalReportFeedProbe={done:true,status:response.status,data:await response.json(),
        browserWorkspace:window.__PAPERCUSP_WS__??null,url:location.href,request:${JSON.stringify(request)},ipcTransmission};
    }catch(error){window.__goalReportFeedProbe={done:true,error:String(error),url:location.href,ipcTransmission}}})();return true})()`;
}

/** Approved experiment: long report, three exact actions, receipts and unknowns. */
export function goalOwnerReportFixture(workspaceId: string): GoalOwnerReportSnapshotV1 {
  const observedAt = '2026-10-03T10:00:00.000Z';
  return {
    schemaVersion: 1, workspaceId, goalId: 'goal-expandable-reports', observedAt,
    sources: [
      { ref: 'goal:goal-expandable-reports', revision: 'goal-generation-7', observedAt, measuredAt: observedAt, availability: 'value' },
      { ref: 'legacy-spend', revision: 'unavailable-1', observedAt, measuredAt: null, availability: 'unknown', unknownReason: 'Legacy receipts have not been priced.' },
    ],
    moved: [
      { ref: 'WI-completed', state: 'done', stateObservedAt: observedAt,
        successfulMutations: [{ receiptRef: 'receipt:complete-19', operation: 'work_items:complete', persistedAt: '2026-10-03T09:59:00.000Z' }],
        completionEvidenceRefs: ['test-run:19', 'artifact:verified-19'], verification: 'verified' },
      { ref: 'WI-observed', state: 'wip', stateObservedAt: observedAt, successfulMutations: [], completionEvidenceRefs: [], verification: 'unverified' },
    ],
    cost: { spentCents: 125.5, budgetCents: 1000, budgetWindowSec: 3600, sourceRef: 'goal-lineage:spend', sourceRevision: 'spend-generation-4', measuredAt: '2026-10-03T09:59:30.000Z', readAt: observedAt, coverage: 'partial; legacy unpriced', unknownReason: 'Historical unpriced receipts excluded.' },
    ownerWalls: [
      { itemRef: 'WI-wall-1', exactAction: 'Approve €50 for the isolated migration rehearsal.', decisionRefs: ['D-001'], artifactRefs: ['artifact:rehearsal'], sourceRevision: 'wall-1-v2' },
      { itemRef: 'WI-wall-2', exactAction: 'Choose retention of 7 days or 30 days for audit evidence.', decisionRefs: ['D-002'], artifactRefs: ['artifact:retention'], sourceRevision: 'wall-2-v1' },
      { itemRef: 'WI-wall-3', exactAction: 'Provide the service account with read access to project reports.', decisionRefs: ['D-003'], artifactRefs: ['artifact:access'], sourceRevision: 'wall-3-v3' },
    ],
    coverage: { checkedRefs: ['WI-completed', 'WI-observed'], uncheckedRefs: ['WI-unread'], notApplicableRefs: ['WI-archived'], unknowns: [{ ref: 'legacy-spend', reason: 'Historical cost coverage is incomplete.' }], residueRefs: ['WI-unread'] },
    killed: [{ ref: 'plan:old-direction', disposition: 'stopped: duplicate surface', evidenceRefs: ['decision:stop-3'], at: '2026-10-02T08:00:00.000Z' }],
    nextWake: { kind: 'loop', ref: 'loop:goal-holder', expectedAt: '2026-10-03T10:01:00.000Z', evidenceRef: 'loop-status:receipt-7' },
  };
}
