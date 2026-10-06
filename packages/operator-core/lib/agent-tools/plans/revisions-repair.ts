/**
 * Transactional maintenance for immutable plan-revision snapshots.
 *
 * This module deliberately knows nothing about rubric semantics. A caller
 * supplies an exact plan baseline and the exact revision rows it intends to
 * rewrite; the apply path re-reads both under the normal plan + revision
 * advisory locks and refuses a stale or changed chain. Only
 * `content_snapshot` is updated, so revision ids, sequence numbers, hashes,
 * authorship, session provenance, and timestamps remain immutable.
 */
import { withWorkspace } from '@papercusp/db-org';
import { isDeepStrictEqual } from 'node:util';
import {
  acquirePlanAdvisoryLock,
  planAdvisoryLockKey,
} from './plan-lock-key';
import {
  acquirePlanRevisionAdvisoryLock,
  recordPlanRevisionInTransaction,
  type PlanRevisionSql,
} from './revisions';
import type { AgentIdentity } from '../coordination/identity';

export interface PlanRevisionRepairScope {
  workspaceId: string;
  harnessSlug: string;
  planSlug: string;
}

export interface PlanRevisionRepairPlan {
  workspaceId: string;
  harnessSlug: string;
  planSlug: string;
  version: number;
  contentHash: string;
  content: string;
  owner: string | null;
  template: string | null;
  templateSlug: string | null;
  archived: boolean;
  templateData: unknown;
}

export interface PlanRevisionRepairRevision {
  id: number;
  seq: number;
  contentHash: string;
  contentSnapshot: string;
  authorKind: string;
  authorId: string;
  sessionId: string | null;
  sessionKind: string | null;
  createdAt: number;
}

export interface PlanRevisionRepairTarget {
  plan: PlanRevisionRepairPlan;
  revisions: PlanRevisionRepairRevision[];
}

export interface PlanRevisionRepairExpectedPlan {
  version: number;
  contentHash: string;
  content: string;
  owner: string | null;
  template: string | null;
  templateSlug: string | null;
  archived: boolean;
  /** Optional exact structured state for repairs whose proof depends on it. */
  templateData?: unknown;
}

export interface PlanRevisionSnapshotReplacement {
  id: number;
  seq: number;
  expectedContentSnapshot: string;
  replacementContentSnapshot: string;
}

export interface PlanRevisionSnapshotRepairSpec {
  scope: PlanRevisionRepairScope;
  expectedPlan: PlanRevisionRepairExpectedPlan;
  expectedRevisionIds: number[];
  replacements: PlanRevisionSnapshotReplacement[];
}

/** Append-only repair of a missing snapshot for the exact current plan version. */
export interface PlanRevisionSnapshotBackfillPlan {
  scope: PlanRevisionRepairScope;
  expectedPlan: PlanRevisionRepairExpectedPlan & { templateData: unknown };
  expectedRevisionIds: number[];
  contentSnapshot: string;
  rationale: string;
}

export interface PlanRevisionSnapshotBackfillSpec extends PlanRevisionSnapshotBackfillPlan {
  identity: AgentIdentity;
}

export type PlanRevisionSnapshotBackfillResult =
  | { status: 'recorded'; revisionSeq: number }
  | { status: 'not_found' }
  | { status: 'cas_lost'; reason: string }
  | { status: 'error'; reason: string };

export type PlanRevisionSnapshotRepairResult =
  | { status: 'repaired'; revisionsRepaired: number }
  | { status: 'already_repaired'; revisionsRepaired: 0 }
  | { status: 'not_found'; revisionsRepaired: 0 }
  | { status: 'cas_lost'; revisionsRepaired: 0; reason: string }
  | { status: 'error'; revisionsRepaired: 0; reason: string };

/** Pure plan-baseline CAS comparison, exported for recurrence tests. */
export function planRevisionRepairPlanMatches(
  expected: PlanRevisionRepairExpectedPlan,
  actual: Pick<PlanRevisionRepairPlan, keyof PlanRevisionRepairExpectedPlan>,
): boolean {
  return (
    actual.version === expected.version &&
    actual.contentHash === expected.contentHash &&
    actual.content === expected.content &&
    actual.owner === expected.owner &&
    actual.template === expected.template &&
    actual.templateSlug === expected.templateSlug &&
    actual.archived === expected.archived &&
    (expected.templateData === undefined || isDeepStrictEqual(actual.templateData, expected.templateData))
  );
}

/** Pure revision-chain identity comparison, exported for recurrence tests. */
export function planRevisionRepairRevisionIdsMatch(
  expectedRevisionIds: readonly number[],
  actualRevisions: readonly Pick<PlanRevisionRepairRevision, 'id'>[],
): boolean {
  if (expectedRevisionIds.length !== actualRevisions.length) return false;
  const expected = new Set(expectedRevisionIds);
  return expected.size === expectedRevisionIds.length && actualRevisions.every((row) => expected.has(row.id));
}

function mapPlanRow(row: {
  workspace_id: string;
  harness_slug: string;
  plan_slug: string;
  version: string | number;
  content_hash: string;
  content: string;
  owner: string | null;
  template: string | null;
  template_slug: string | null;
  archived: boolean;
  template_data: unknown;
}): PlanRevisionRepairPlan {
  return {
    workspaceId: row.workspace_id,
    harnessSlug: row.harness_slug,
    planSlug: row.plan_slug,
    version: Number(row.version),
    contentHash: row.content_hash,
    content: row.content,
    owner: row.owner,
    template: row.template,
    templateSlug: row.template_slug,
    archived: row.archived,
    templateData: row.template_data,
  };
}

function mapRevisionRow(row: {
  id: string | number;
  seq: string | number;
  content_hash: string;
  content_snapshot: string;
  author_kind: string;
  author_id: string;
  session_id: string | null;
  session_kind: string | null;
  created_at: string | number;
}): PlanRevisionRepairRevision {
  return {
    id: Number(row.id),
    seq: Number(row.seq),
    contentHash: row.content_hash,
    contentSnapshot: row.content_snapshot,
    authorKind: row.author_kind,
    authorId: row.author_id,
    sessionId: row.session_id,
    sessionKind: row.session_kind,
    createdAt: Number(row.created_at),
  };
}

/** Read the exact plan row and complete revision chain used to prepare a repair. */
export async function readPlanRevisionRepairTarget(
  scope: PlanRevisionRepairScope,
): Promise<PlanRevisionRepairTarget | null> {
  return withWorkspace(scope.workspaceId, async (tx) => {
    const planRows = await tx<
      {
        workspace_id: string;
        harness_slug: string;
        plan_slug: string;
        version: string | number;
        content_hash: string;
        content: string;
        owner: string | null;
        template: string | null;
        template_slug: string | null;
        archived: boolean;
        template_data: unknown;
      }[]
    >`
      SELECT workspace_id, harness_slug, plan_slug, version, content_hash, content,
             owner, template, template_slug, archived, template_data
        FROM harness_shared.harness_plans
       WHERE workspace_id = ${scope.workspaceId}
         AND harness_slug = ${scope.harnessSlug}
         AND plan_slug = ${scope.planSlug}
       LIMIT 1
    `;
    const planRow = planRows[0];
    if (!planRow) return null;

    const revisionRows = await tx<
      {
        id: string | number;
        seq: string | number;
        content_hash: string;
        content_snapshot: string;
        author_kind: string;
        author_id: string;
        session_id: string | null;
        session_kind: string | null;
        created_at: string | number;
      }[]
    >`
      SELECT id, seq, content_hash, content_snapshot,
             author_kind, author_id, session_id, session_kind, created_at
        FROM harness_shared.plan_revisions
       WHERE workspace_id = ${scope.workspaceId}
         AND harness_slug = ${scope.harnessSlug}
         AND plan_slug = ${scope.planSlug}
       ORDER BY seq ASC
    `;
    return {
      plan: mapPlanRow(planRow),
      revisions: revisionRows.map(mapRevisionRow),
    };
  });
}

/**
 * Apply a prepared repair under both shared advisory locks. The plan baseline
 * and complete revision-id set are rechecked before any update, and every
 * individual snapshot update carries its own old-bytes CAS predicate. Any
 * mismatch aborts the transaction and returns `cas_lost` without a partial
 * chain.
 */
export async function applyPlanRevisionSnapshotRepair(
  spec: PlanRevisionSnapshotRepairSpec,
): Promise<PlanRevisionSnapshotRepairResult> {
  if (spec.replacements.length === 0) return { status: 'already_repaired', revisionsRepaired: 0 };

  try {
    return await withWorkspace(spec.scope.workspaceId, async (tx) => {
      await acquirePlanAdvisoryLock(
        tx,
        planAdvisoryLockKey(spec.scope.workspaceId, spec.scope.harnessSlug, spec.scope.planSlug),
      );
      await acquirePlanRevisionAdvisoryLock(
        tx as unknown as PlanRevisionSql,
        spec.scope.workspaceId,
        spec.scope.harnessSlug,
        spec.scope.planSlug,
      );

      const planRows = await tx<
        {
          workspace_id: string;
          harness_slug: string;
          plan_slug: string;
          version: string | number;
          content_hash: string;
          content: string;
          owner: string | null;
          template: string | null;
          template_slug: string | null;
          archived: boolean;
          template_data: unknown;
        }[]
      >`
        SELECT workspace_id, harness_slug, plan_slug, version, content_hash, content,
               owner, template, template_slug, archived, template_data
          FROM harness_shared.harness_plans
         WHERE workspace_id = ${spec.scope.workspaceId}
           AND harness_slug = ${spec.scope.harnessSlug}
           AND plan_slug = ${spec.scope.planSlug}
         FOR UPDATE
      `;
      const planRow = planRows[0];
      if (!planRow) return { status: 'not_found', revisionsRepaired: 0 };
      const currentPlan = mapPlanRow(planRow);
      if (!planRevisionRepairPlanMatches(spec.expectedPlan, currentPlan)) {
        return {
          status: 'cas_lost',
          revisionsRepaired: 0,
          reason: 'current plan version, content, or identity changed after preparation',
        };
      }

      const revisionRows = await tx<
        {
          id: string | number;
          seq: string | number;
          content_hash: string;
          content_snapshot: string;
          author_kind: string;
          author_id: string;
          session_id: string | null;
          session_kind: string | null;
          created_at: string | number;
        }[]
      >`
        SELECT id, seq, content_hash, content_snapshot,
               author_kind, author_id, session_id, session_kind, created_at
          FROM harness_shared.plan_revisions
         WHERE workspace_id = ${spec.scope.workspaceId}
           AND harness_slug = ${spec.scope.harnessSlug}
           AND plan_slug = ${spec.scope.planSlug}
         ORDER BY seq ASC
         FOR UPDATE
      `;
      const currentRevisions = revisionRows.map(mapRevisionRow);
      if (!planRevisionRepairRevisionIdsMatch(spec.expectedRevisionIds, currentRevisions)) {
        return {
          status: 'cas_lost',
          revisionsRepaired: 0,
          reason: 'revision chain changed after preparation',
        };
      }

      const byId = new Map(currentRevisions.map((row) => [row.id, row] as const));
      for (const replacement of spec.replacements) {
        const current = byId.get(replacement.id);
        if (!current || current.seq !== replacement.seq || current.contentSnapshot !== replacement.expectedContentSnapshot) {
          return {
            status: 'cas_lost',
            revisionsRepaired: 0,
            reason: `revision ${replacement.id} changed after preparation`,
          };
        }
      }

      let revisionsRepaired = 0;
      for (const replacement of spec.replacements) {
        const updated = await tx<{ id: string | number }[]>`
          UPDATE harness_shared.plan_revisions
             SET content_snapshot = ${replacement.replacementContentSnapshot}
           WHERE workspace_id = ${spec.scope.workspaceId}
             AND harness_slug = ${spec.scope.harnessSlug}
             AND plan_slug = ${spec.scope.planSlug}
             AND id = ${replacement.id}
             AND seq = ${replacement.seq}
             AND content_snapshot = ${replacement.expectedContentSnapshot}
           RETURNING id
        `;
        if (updated.length !== 1) {
          throw new Error(`revision ${replacement.id} snapshot CAS lost during update`);
        }
        revisionsRepaired += 1;
      }
      return { status: 'repaired', revisionsRepaired };
    });
  } catch (error) {
    return {
      status: 'error',
      revisionsRepaired: 0,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Append a repaired snapshot for one missing CURRENT plan version. The live plan
 * and complete prior revision-id set are rechecked under the same plan/revision
 * lock order used by ordinary writers. The old history is left byte-for-byte
 * intact, and the new row records the actual repair actor and rationale.
 */
export async function applyPlanRevisionSnapshotBackfill(
  spec: PlanRevisionSnapshotBackfillSpec,
): Promise<PlanRevisionSnapshotBackfillResult> {
  try {
    return await withWorkspace(spec.scope.workspaceId, async (tx) => {
      await acquirePlanAdvisoryLock(
        tx,
        planAdvisoryLockKey(spec.scope.workspaceId, spec.scope.harnessSlug, spec.scope.planSlug),
      );
      await acquirePlanRevisionAdvisoryLock(
        tx as unknown as PlanRevisionSql,
        spec.scope.workspaceId,
        spec.scope.harnessSlug,
        spec.scope.planSlug,
      );

      const planRows = await tx<
        {
          workspace_id: string;
          harness_slug: string;
          plan_slug: string;
          version: string | number;
          content_hash: string;
          content: string;
          owner: string | null;
          template: string | null;
          template_slug: string | null;
          archived: boolean;
          template_data: unknown;
        }[]
      >`
        SELECT workspace_id, harness_slug, plan_slug, version, content_hash, content,
               owner, template, template_slug, archived, template_data
          FROM harness_shared.harness_plans
         WHERE workspace_id = ${spec.scope.workspaceId}
           AND harness_slug = ${spec.scope.harnessSlug}
           AND plan_slug = ${spec.scope.planSlug}
         FOR UPDATE
      `;
      const planRow = planRows[0];
      if (!planRow) return { status: 'not_found' };
      if (!planRevisionRepairPlanMatches(spec.expectedPlan, mapPlanRow(planRow))) {
        return {
          status: 'cas_lost',
          reason: 'current plan version, body, structured data, or identity changed after preparation',
        };
      }

      const revisionRows = await tx<{ id: string | number }[]>`
        SELECT id
          FROM harness_shared.plan_revisions
         WHERE workspace_id = ${spec.scope.workspaceId}
           AND harness_slug = ${spec.scope.harnessSlug}
           AND plan_slug = ${spec.scope.planSlug}
         ORDER BY seq ASC
         FOR UPDATE
      `;
      const currentRevisionIds = revisionRows.map((row) => ({ id: Number(row.id) }));
      if (!planRevisionRepairRevisionIdsMatch(spec.expectedRevisionIds, currentRevisionIds)) {
        return { status: 'cas_lost', reason: 'revision chain changed after preparation' };
      }

      const recorded = await recordPlanRevisionInTransaction(tx as unknown as PlanRevisionSql, {
        workspaceId: spec.scope.workspaceId,
        harnessSlug: spec.scope.harnessSlug,
        planSlug: spec.scope.planSlug,
        content: spec.contentSnapshot,
        contentHash: spec.expectedPlan.contentHash,
        rationale: spec.rationale,
        identity: spec.identity,
      });
      return { status: 'recorded', revisionSeq: recorded.seq };
    });
  } catch (error) {
    return {
      status: 'error',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
