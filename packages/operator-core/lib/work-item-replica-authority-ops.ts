/**
 * work-item-replica-authority-ops — the AUTHORITY (receiving) side of the
 * redundancy-replica RPC (EI-266; the BOINC analog of
 * work-item-claim-authority-ops.ts).
 *
 * When a non-authority Swarm routes a replica op to the Hive authority
 * (`getWorkItemReplicaAuthority().route(...)` → PeerRpcTransport), the authority's
 * operator receives the `{kind, payload}` envelope and must RUN it against ITS
 * local `work_item_replicas` store — the single home for the redundancy group so
 * the N replicas actually MEET and the judge sees them all. This module registers
 * a handler per op kind that executes the matching `*Local` store function.
 *
 * The JUDGE is special: its grader (`llmCall`) cannot serialize over the wire, so
 * the authority judges with its OWN grader — the production `llmCall`
 * (lazy-imported, mirroring gym/judge.ts + the judge_redundancy tool) unless a
 * test overrides it. This is correct: the judge of record is the authority's, not
 * the caller's.
 *
 * Register ONCE at boot (idempotent) from the work_items tool barrel, exactly as
 * `registerWorkItemClaimAuthorityOps` is.
 */
import { registerAuthorityOp, registeredAuthorityOpKinds } from './authority/authority-op-registry';
import {
  WORK_ITEM_REPLICA_OP_KINDS,
  claimReplicaSlotLocal,
  heartbeatReplicaLocal,
  releaseReplicaLocal,
  recordReplicaResultLocal,
  listReplicasLocal,
  judgeRedundancyGroupLocal,
  type ClaimReplicaOpts,
  type ReplicaLeaseParams,
  type RecordReplicaResultOpts,
  type JudgeRedundancyOpts,
} from './work-item-redundancy';
import type { JudgeLlmCall } from './gym/primitives';

export interface WorkItemReplicaAuthorityOpsOpts {
  /** Override the authority-side judge grader (tests / rigs). Default: the
   *  production `llmCall`, lazy-imported so registration never pulls the
   *  LLM graph (mirrors the judge_redundancy tool). */
  judgeLlmCall?: JudgeLlmCall;
}

function asObj(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== 'object') throw new Error('replica authority op: payload must be an object');
  return payload as Record<string, unknown>;
}
function reqStr(o: Record<string, unknown>, k: string, kind: string): string {
  const v = o[k];
  if (typeof v !== 'string' || v.length === 0) throw new Error(`${kind}: invalid payload (${k} required)`);
  return v;
}

function asClaimOpts(payload: unknown): ClaimReplicaOpts {
  const o = asObj(payload);
  return {
    workspaceId: typeof o.workspaceId === 'string' ? o.workspaceId : undefined,
    harnessSlug: reqStr(o, 'harnessSlug', 'replica.claim-slot'),
    potSlug: (o.potSlug as string | null | undefined) ?? null,
    workItemId: reqStr(o, 'workItemId', 'replica.claim-slot'),
    owner: reqStr(o, 'owner', 'replica.claim-slot'),
    ownerLabel: (o.ownerLabel as string | null | undefined) ?? null,
    holderPubkey: (o.holderPubkey as string | null | undefined) ?? null,
    ttlSec: typeof o.ttlSec === 'number' ? o.ttlSec : undefined,
  };
}

function asLeaseParams(payload: unknown, kind: string): ReplicaLeaseParams {
  const o = asObj(payload);
  if (typeof o.replicaIndex !== 'number') throw new Error(`${kind}: invalid payload (replicaIndex required)`);
  return {
    workspaceId: typeof o.workspaceId === 'string' ? o.workspaceId : undefined,
    harnessSlug: reqStr(o, 'harnessSlug', kind),
    potSlug: (o.potSlug as string | null | undefined) ?? null,
    workItemId: reqStr(o, 'workItemId', kind),
    replicaIndex: o.replicaIndex,
    claimId: reqStr(o, 'claimId', kind),
    owner: reqStr(o, 'owner', kind),
    ttlSecOverride: typeof o.ttlSecOverride === 'number' ? o.ttlSecOverride : undefined,
  };
}

function asRecordOpts(payload: unknown): RecordReplicaResultOpts {
  const o = asObj(payload);
  if (typeof o.replicaIndex !== 'number') throw new Error('replica.record-result: invalid payload (replicaIndex required)');
  if (!o.result || typeof o.result !== 'object') throw new Error('replica.record-result: invalid payload (result required)');
  return {
    workspaceId: typeof o.workspaceId === 'string' ? o.workspaceId : undefined,
    harnessSlug: reqStr(o, 'harnessSlug', 'replica.record-result'),
    potSlug: (o.potSlug as string | null | undefined) ?? null,
    workItemId: reqStr(o, 'workItemId', 'replica.record-result'),
    replicaIndex: o.replicaIndex,
    owner: reqStr(o, 'owner', 'replica.record-result'),
    result: o.result as RecordReplicaResultOpts['result'],
  };
}

function asListPayload(payload: unknown): { workItemId: string; harness: string; workspaceId?: string; potSlug?: string | null } {
  const o = asObj(payload);
  return {
    workItemId: reqStr(o, 'workItemId', 'replica.list'),
    harness: reqStr(o, 'harness', 'replica.list'),
    workspaceId: typeof o.workspaceId === 'string' ? o.workspaceId : undefined,
    potSlug: (o.potSlug as string | null | undefined) ?? null,
  };
}

function asJudgeOpts(payload: unknown): JudgeRedundancyOpts {
  const o = asObj(payload);
  return {
    workspaceId: typeof o.workspaceId === 'string' ? o.workspaceId : undefined,
    harness: reqStr(o, 'harness', 'replica.judge'),
    potSlug: (o.potSlug as string | null | undefined) ?? null,
    workItemId: reqStr(o, 'workItemId', 'replica.judge'),
    intent: typeof o.intent === 'string' ? o.intent : undefined,
    projectContext: typeof o.projectContext === 'string' ? o.projectContext : undefined,
    rubric: o.rubric as JudgeRedundancyOpts['rubric'],
  };
}

/**
 * Register the replica authority op handlers (idempotent — a no-op if the kinds
 * are already registered; the global registry is reset between tests).
 */
export function registerWorkItemReplicaAuthorityOps(opts: WorkItemReplicaAuthorityOpsOpts = {}): void {
  if (registeredAuthorityOpKinds().includes(WORK_ITEM_REPLICA_OP_KINDS.claimSlot)) return;

  registerAuthorityOp(WORK_ITEM_REPLICA_OP_KINDS.claimSlot, async (payload) => claimReplicaSlotLocal(asClaimOpts(payload)));
  registerAuthorityOp(WORK_ITEM_REPLICA_OP_KINDS.heartbeat, async (payload) =>
    heartbeatReplicaLocal(asLeaseParams(payload, 'replica.heartbeat')),
  );
  registerAuthorityOp(WORK_ITEM_REPLICA_OP_KINDS.release, async (payload) =>
    releaseReplicaLocal(asLeaseParams(payload, 'replica.release')),
  );
  registerAuthorityOp(WORK_ITEM_REPLICA_OP_KINDS.recordResult, async (payload) => recordReplicaResultLocal(asRecordOpts(payload)));
  registerAuthorityOp(WORK_ITEM_REPLICA_OP_KINDS.list, async (payload) => {
    const p = asListPayload(payload);
    return listReplicasLocal(p.workItemId, p);
  });
  registerAuthorityOp(WORK_ITEM_REPLICA_OP_KINDS.judge, async (payload) => {
    const judgeOpts = asJudgeOpts(payload);
    const llmCall =
      opts.judgeLlmCall ?? ((await import('./llm-testing/llm-client')).llmCall as unknown as JudgeLlmCall);
    return judgeRedundancyGroupLocal(judgeOpts, { llmCall });
  });
}
