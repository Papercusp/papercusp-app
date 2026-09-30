/**
 * Apply a {@link WholeCorpusVerdict} to the durable work-item store.
 *
 * Pure orchestration over INJECTED deps (mirrors the `runWholeCorpusPass` /
 * `ScoutLlmCall` decoupling in `whole-corpus-pass.ts`): every real write goes
 * through `work-items.ts`'s existing core functions
 * (`linkWorkItem`/`setWorkItemState`/`commentWorkItem`/`createOneWorkItem`),
 * wired in by the routine action (`resolver-whole-corpus-action.ts`). This
 * file owns no I/O, so it is unit-testable with in-memory fakes.
 *
 * Merge semantics (reuse-first — the vocabulary already exists):
 * `duplicates` (src duplicates dst; dst stays canonical) + terminal state
 * `dropped` + `completionRef` pointing at the canonical id. A duplicate that
 * is already terminal, or a canonical that cannot be found, is skipped with a
 * reason rather than silently dropped.
 *
 * Cluster semantics (D-004 — the durable OUTPUT of the over-budget chunking
 * fallback, and of the plain whole-corpus pass alike): one cluster PARENT
 * work item per distinct member set, tagged with a durable
 * `payload.resolverCluster` marker so P-008 can find it later without a
 * migration. `clusterKeyFor` makes cluster creation idempotent across repeat
 * daily runs — a cluster with the same member set is never re-created.
 */
import { createHash } from 'node:crypto';
import type { ObjectRef } from '@papercusp/coordination/capabilities';
import { ALL_TERMINAL_STATUSES } from '../work-item-blocking';
import type { WholeCorpusCluster, WholeCorpusMerge, WholeCorpusVerdict } from './whole-corpus-pass';

export const RESOLVER_CLUSTER_SCHEMA_VERSION = 'resolver-cluster-v1';
/**
 * Numeric, assignment-ready projection of resolver-cluster membership. The
 * whole-corpus resolver computes it once; the scheduler's `cluster_priority`
 * rank term only reads it. Keeping the projection on every member (and the
 * parent) avoids rebuilding the cluster graph on each claim.
 */
export const RESOLVER_CLUSTER_PRIORITY_PAYLOAD_KEY = 'clusterPriority';

export interface ClusterParentPayload {
  schemaVersion: typeof RESOLVER_CLUSTER_SCHEMA_VERSION;
  clusterKey: string;
  label: string;
  suspectedGenerator: string;
  memberIds: string[];
}

/**
 * Deterministic identity for a cluster's member SET, independent of member
 * order or the label/generator text — so the same underlying group of items
 * reproduces the same key across daily runs, even if the model rewords the
 * label or names the generator slightly differently the second time.
 */
export function clusterKeyFor(memberIds: readonly string[]): string {
  const sorted = [...new Set(memberIds)].sort();
  if (sorted.length < 2) throw new RangeError('clusterKeyFor requires at least 2 distinct member ids');
  return createHash('sha256').update(sorted.join('|')).digest('hex').slice(0, 16);
}

// ── Injected dependencies ───────────────────────────────────────────────────

/** The minimal work-item shape this module needs to decide skip-vs-apply. */
export interface ApplyWorkItemLike {
  id: string;
  state: string;
  payload?: Record<string, unknown> | null;
}

export type ApplyOutcome = { ok: true } | { ok: false; error: string };

export interface CreateClusterParentInput {
  title: string;
  summary: string;
  payload: ClusterParentPayload;
}

export type CreateClusterParentOutcome = { ok: true; id: string } | { ok: false; error: string };

export interface ApplyWholeCorpusDeps {
  getWorkItem: (id: string) => Promise<ApplyWorkItemLike | null>;
  resolveWorkItemRef: (id: string) => Promise<ObjectRef | null>;
  linkWorkItem: (id: string, dst: ObjectRef, rel: 'duplicates' | 'relates') => Promise<ApplyOutcome>;
  setState: (id: string, state: 'dropped', opts: { completionRef: string }) => Promise<ApplyOutcome>;
  /** Best-effort audit trail; a comment failure never blocks the merge/cluster it explains. */
  comment: (id: string, body: string) => Promise<void>;
  /** Idempotency check: an existing OPEN cluster parent carrying this exact key, if any. */
  findExistingClusterParentByKey: (clusterKey: string) => Promise<string | null>;
  createClusterParent: (input: CreateClusterParentInput) => Promise<CreateClusterParentOutcome>;
  /** Additively merge a payload projection across either work-item family. */
  mergePayload: (id: string, patch: Record<string, unknown>) => Promise<ApplyOutcome>;
}

// ── Result shape ─────────────────────────────────────────────────────────────

export interface MergeApplied {
  canonicalId: string;
  duplicateId: string;
}

export type MergeSkipReason =
  | 'canonical-not-found'
  | 'duplicate-not-found'
  | 'already-terminal'
  | 'link-failed'
  | 'state-failed';

export interface MergeSkipped {
  canonicalId: string;
  duplicateId: string;
  reason: MergeSkipReason;
  detail?: string;
}

export interface ClusterCreated {
  clusterKey: string;
  parentId: string;
  memberIds: string[];
  /** Members whose 'relates' link to the new parent failed — the parent still exists. */
  linkFailures: string[];
}

export type ClusterSkipReason = 'already-exists' | 'create-failed';

export interface ClusterSkipped {
  clusterKey: string;
  reason: ClusterSkipReason;
  detail?: string;
  /** Populated when reason is 'already-exists'. */
  existingParentId?: string;
}

export interface ApplyWholeCorpusResult {
  merged: MergeApplied[];
  skippedMerges: MergeSkipped[];
  clustersCreated: ClusterCreated[];
  clustersSkipped: ClusterSkipped[];
  errors: string[];
}

function emptyResult(): ApplyWholeCorpusResult {
  return { merged: [], skippedMerges: [], clustersCreated: [], clustersSkipped: [], errors: [] };
}

function clusterPriorityFromPayload(payload: Record<string, unknown> | null | undefined): number {
  const value = payload?.[RESOLVER_CLUSTER_PRIORITY_PAYLOAD_KEY];
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

/**
 * Persist the largest cluster this item belongs to. A verdict may legitimately
 * mention one defect under more than one suspected generator, so a later,
 * smaller cluster must never lower the rank projection written by an earlier
 * one in the same pass.
 */
async function stampClusterPriority(
  id: string,
  clusterSize: number,
  deps: ApplyWholeCorpusDeps,
  result: ApplyWholeCorpusResult,
): Promise<void> {
  const item = await deps.getWorkItem(id);
  if (!item) {
    result.errors.push(`cluster priority: work-item '${id}' not found`);
    return;
  }
  const current = clusterPriorityFromPayload(item.payload);
  if (current >= clusterSize) return;
  const merged = await deps.mergePayload(id, { [RESOLVER_CLUSTER_PRIORITY_PAYLOAD_KEY]: clusterSize });
  if (!merged.ok) result.errors.push(`cluster priority: failed to stamp ${id}: ${merged.error}`);
}

async function applyOneMerge(merge: WholeCorpusMerge, deps: ApplyWholeCorpusDeps, result: ApplyWholeCorpusResult): Promise<void> {
  const canonical = await deps.getWorkItem(merge.canonicalId);
  if (!canonical) {
    for (const duplicateId of merge.duplicateIds) {
      result.skippedMerges.push({ canonicalId: merge.canonicalId, duplicateId, reason: 'canonical-not-found' });
    }
    return;
  }
  const dst = await deps.resolveWorkItemRef(merge.canonicalId);
  if (!dst) {
    for (const duplicateId of merge.duplicateIds) {
      result.skippedMerges.push({ canonicalId: merge.canonicalId, duplicateId, reason: 'canonical-not-found' });
    }
    return;
  }

  for (const duplicateId of merge.duplicateIds) {
    const dup = await deps.getWorkItem(duplicateId);
    if (!dup) {
      result.skippedMerges.push({ canonicalId: merge.canonicalId, duplicateId, reason: 'duplicate-not-found' });
      continue;
    }
    if (ALL_TERMINAL_STATUSES.has(dup.state)) {
      result.skippedMerges.push({ canonicalId: merge.canonicalId, duplicateId, reason: 'already-terminal' });
      continue;
    }
    const linkResult = await deps.linkWorkItem(duplicateId, dst, 'duplicates');
    if (!linkResult.ok) {
      result.skippedMerges.push({ canonicalId: merge.canonicalId, duplicateId, reason: 'link-failed', detail: linkResult.error });
      continue;
    }
    const stateResult = await deps.setState(duplicateId, 'dropped', { completionRef: merge.canonicalId });
    if (!stateResult.ok) {
      result.skippedMerges.push({ canonicalId: merge.canonicalId, duplicateId, reason: 'state-failed', detail: stateResult.error });
      continue;
    }
    await deps
      .comment(duplicateId, `Resolved as a duplicate of ${merge.canonicalId} by the whole-corpus resolver pass: ${merge.reason}`)
      .catch(() => undefined);
    result.merged.push({ canonicalId: merge.canonicalId, duplicateId });
  }
}

async function applyOneCluster(
  cluster: WholeCorpusCluster,
  deps: ApplyWholeCorpusDeps,
  result: ApplyWholeCorpusResult,
): Promise<void> {
  const clusterKey = clusterKeyFor(cluster.memberIds);
  const memberIds = [...new Set(cluster.memberIds)].sort();
  const clusterSize = memberIds.length;
  const existing = await deps.findExistingClusterParentByKey(clusterKey);
  if (existing) {
    // P-008 can roll out after P-007 has already materialized parents. Replaying
    // the same verdict backfills the rank projection without creating a second
    // parent or recomputing cluster structure in the scheduler.
    await stampClusterPriority(existing, clusterSize, deps, result);
    for (const memberId of memberIds) await stampClusterPriority(memberId, clusterSize, deps, result);
    result.clustersSkipped.push({ clusterKey, reason: 'already-exists', existingParentId: existing });
    return;
  }

  const payload: ClusterParentPayload = {
    schemaVersion: RESOLVER_CLUSTER_SCHEMA_VERSION,
    clusterKey,
    label: cluster.label,
    suspectedGenerator: cluster.suspectedGenerator,
    memberIds,
  };
  const created = await deps.createClusterParent({
    title: `Cluster: ${cluster.label}`,
    summary: `Suspected shared generator: ${cluster.suspectedGenerator}. Members: ${memberIds.join(', ')}.`,
    payload,
  });
  if (!created.ok) {
    result.clustersSkipped.push({ clusterKey, reason: 'create-failed', detail: created.error });
    return;
  }

  await stampClusterPriority(created.id, clusterSize, deps, result);
  const parentRef = await deps.resolveWorkItemRef(created.id);
  const linkFailures: string[] = [];
  for (const memberId of memberIds) {
    if (!parentRef) {
      linkFailures.push(memberId);
      continue;
    }
    const linkResult = await deps.linkWorkItem(memberId, parentRef, 'relates');
    if (!linkResult.ok) {
      linkFailures.push(memberId);
      continue;
    }
    await stampClusterPriority(memberId, clusterSize, deps, result);
    await deps
      .comment(
        memberId,
        `Grouped under cluster parent ${created.id} (suspected generator: ${cluster.suspectedGenerator}) by the whole-corpus resolver pass.`,
      )
      .catch(() => undefined);
  }
  if (linkFailures.length > 0) {
    result.errors.push(`cluster ${clusterKey} (${created.id}): failed to link member(s) ${linkFailures.join(', ')}`);
  }
  result.clustersCreated.push({ clusterKey, parentId: created.id, memberIds, linkFailures });
}

/**
 * Apply every merge, then every cluster, of one whole-corpus verdict.
 * Merges and clusters are independent of each other; a failure in one never
 * blocks the others. Idempotent: re-applying the same verdict skips already-
 * terminal duplicates and already-existing cluster parents (by clusterKey).
 */
export async function applyWholeCorpusVerdict(
  verdict: WholeCorpusVerdict,
  deps: ApplyWholeCorpusDeps,
): Promise<ApplyWholeCorpusResult> {
  const result = emptyResult();
  for (const merge of verdict.merges) await applyOneMerge(merge, deps, result);
  for (const cluster of verdict.clusters) await applyOneCluster(cluster, deps, result);
  return result;
}
