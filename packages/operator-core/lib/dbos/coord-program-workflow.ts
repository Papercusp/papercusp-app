/**
 * `coordProgramWorkflow` — the durable executor for a coord-op **program**
 * (`coordination-ops-as-blueprint-primitives-2026-06-04` P-005 / D-005). The
 * program-mode sibling of `featurePipelineImpl`: where that runs a decider loop
 * (`deriveNext`), this runs a declarative `steps` + `gate` program (the pure
 * `runProgramCore`), invoking each coord op as a checkpointed DBOS step. So a
 * deliberation (open thread → spawn voters → collect → aggregate → resolve)
 * **survives a restart** — a crash mid-collect resumes from the last completed
 * step (D-003), the durability the plan calls load-bearing.
 *
 * Two entry surfaces share `runProgramCore` (P-005):
 *   - **durable top-level** — `startCoordProgram` → this workflow → DBOS-step runOp.
 *     The event-triggered / fire-and-forget deliberation path (D-007).
 *   - **inline** — `coord:vote`/`coord:deliberate` ops → `caps.runProgram` → inline
 *     runOp. The direct-call (D-009) + recursion (D-008) path.
 *
 * Flag-gated like the orchestrator workflow: registered only when the DBOS
 * bootstrap imports it. The agent spawn runner is injected
 * (`setCoordSpawnRunner`, prod-caps.ts), so this module pulls in no agent-spawn
 * plumbing and the workflow stays directly testable.
 */
import { DBOS, WorkflowQueue } from '@dbos-inc/dbos-sdk';
import { setTimeout as delay } from 'node:timers/promises';
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { idempotentRegisterWorkflow, idempotentWorkflowQueue } from './idempotent-register-workflow';
import { queueConcurrency } from './queue-concurrency';
import { BlueprintSchema, loadBuiltinBlueprint, operationFromSpecification, pinnedOperationProgramBlueprint, type Blueprint } from '@papercusp/orchestrator/blueprint';
import { ANY_FAMILY_TERMINAL_STATES } from '../work-item-dispatch-states';
import { runWithWorkspace } from '../workspace-als';
import '../coord-ops/index.js'; // register every coord op
import '../blueprint-steps/index.js'; // register every deterministic step-op (P-010)
import { requireCoordOp } from '../coord-ops/registry.js';
import { awaitChildArgsSchema, invokeChildArgsSchema } from '../coord-ops/ops/blueprint-child.js';
import { runProgramCore, type RunOp } from '../coord-ops/program-runner.js';
import { buildCoordOpCtx, setProgramBlueprintResolver, type ProgramBlueprintResolver } from '../coord-ops/prod-caps.js';
import type { ProgramOutcome } from '../coord-ops/types.js';
import {
  BLUEPRINT_PROGRAM_COMPLETION_OWNER, blueprintProgramCompletionRef,
  cancelBlueprintOperation, getBlueprintOperationResult, getBlueprintOperationStatus,
  projectBlueprintOperationStatus, readAcceptedProgramRootGuard, submitBlueprintOperation,
  type BlueprintOperationHandle, type BlueprintOperationStatus,
} from '../blueprint/operation-service.js';
import { readBlueprintSpecificationSnapshot } from '../blueprint/project-to-pg.js';
import { setWorkItemState } from '../work-items.js';

export interface CoordProgramInput {
  /** Built-in (vote/deliberate) or resolved blueprint id whose program runs. */
  blueprintId: string;
  /** The decision payload (question, options, lenses, quorum, …). */
  payload: Record<string, unknown>;
  /** The agent/owner who invoked the program (resolve notifies them). */
  callerId: string;
  callerLabel?: string;
  workspaceId?: string;
  harnessSlug?: string;
  /** The decision work-item id this program resolves (optional). */
  workItemId?: string;
  /** A stable run id for the workflow id / dedup. */
  runId: string;
  /** Composition depth (top-level = 0). */
  depth?: number;
  /** An accepted operation root runs its retained definition, never today's
   * mutable blueprint pointer. The canonical work item remains the result. */
  acceptedOperation?: BlueprintOperationHandle;
  /** The canonical root row's admission epoch, captured before enqueue and
   * retained in DBOS input. Reopen or unrelated mutation fences a stale run. */
  acceptedAttemptUpdatedTs?: number;
}

/**
 * The blueprint resolver the workflow uses (also installed as the prod-caps
 * resolver so nested `runProgram` calls resolve the same way). Default: built-in
 * vote/deliberate. The operator can override with a PG-cache / forked resolver.
 */
let _resolver: ProgramBlueprintResolver = async (id) => loadBuiltinBlueprint(id).blueprint;
export function setCoordProgramBlueprintResolver(fn: ProgramBlueprintResolver): void {
  _resolver = fn;
  setProgramBlueprintResolver(fn);
}

/** Resolve an accepted program through its durable receipt and immutable
 * specification. A caller cannot turn an ordinary work item into a program or
 * replace the program definition by moving the harness blueprint pointer. */
export async function loadAcceptedCoordProgramBlueprint(
  sql: Sql,
  handle: BlueprintOperationHandle,
  callerId: string,
): Promise<Blueprint> {
  return (await loadAcceptedCoordProgram(sql, handle, callerId)).blueprint;
}

/** {@link loadAcceptedCoordProgramBlueprint} plus the canonical result read it
 * validates the receipt with. WI-10003631: the program start used to validate
 * with a status read and then immediately repeat the same canonical read for its
 * crash-replay check; both run `readValidatedCanonicalOperation`, so one read
 * serves both and the start costs one canonical read instead of two.
 * Then: the receipt proof and root liveness come from ONE guard statement, and
 * the full canonical result read (~10 statements) runs only when the root has
 * already settled — the only case the crash-replay check acts on. `prior` is
 * null for a live root. */
async function loadAcceptedCoordProgram(
  sql: Sql,
  handle: BlueprintOperationHandle,
  callerId: string,
): Promise<{ blueprint: Blueprint; prior: Awaited<ReturnType<typeof getBlueprintOperationResult>> | null }> {
  if (handle.target.kind !== 'work-item') {
    throw new Error('accepted coord program requires a canonical root work item');
  }
  return runWithWorkspace(handle.workspaceId, async () => {
    const guard = await readAcceptedProgramRootGuard(sql, handle, callerId);
    const prior = guard.terminal ? await getBlueprintOperationResult(sql, handle, callerId) : null;
    const specification = await readBlueprintSpecificationSnapshot(
      sql, handle.workspaceId, handle.harnessSlug, handle.specificationRevision,
    );
    if (!specification) throw new Error('accepted coord program specification snapshot is missing');
    const { operation } = operationFromSpecification(specification, handle.operationId);
    if (operation.target.kind !== 'work-item' || operation.execution?.kind !== 'program') {
      throw new Error('accepted blueprint operation is not a work-item program');
    }
    const blueprint = pinnedOperationProgramBlueprint(operation, specification.inputs) ??
      BlueprintSchema.parse(specification.configuration);
    if (!blueprint.spine.steps) throw new Error('accepted coord program has no program spine');
    return { blueprint, prior };
  });
}

/** Recheck the canonical attempt on every effect and after every durable wait.
 * A DBOS checkpoint cannot stand in for a current work-item row. */
async function requireCurrentAcceptedCoordProgramRoot(
  sql: Sql, parent: CoordProgramInput,
): Promise<BlueprintOperationHandle & { target: { kind: 'work-item'; id: string } }> {
  const root = parent.acceptedOperation;
  if (!root || root.target.kind !== 'work-item' || parent.workItemId !== root.target.id ||
      parent.workspaceId !== root.workspaceId || parent.harnessSlug !== root.harnessSlug ||
      !Number.isSafeInteger(parent.acceptedAttemptUpdatedTs) || !parent.acceptedAttemptUpdatedTs) {
    throw new Error('program child invocation requires a current accepted root attempt');
  }
  const rootId = root.target.id;
  return runWithWorkspace(root.workspaceId, async () => {
    const status = await getBlueprintOperationStatus(sql, root, parent.callerId);
    if (status.phase === 'terminal' || status.cancellationRequested) {
      throw new Error('program root is terminal or cancellation was requested');
    }
    const rows = await sql<Array<{ updated_ts: string | number }>>`
      SELECT updated_ts FROM harness_shared.work_items
       WHERE workspace_id = ${root.workspaceId}
         -- WI-10004562 / D-045: a pot member's root is stored under the slug the receipt
         -- records; a pre-1282 receipt (NULL) keeps the operation harness slug.
         AND harness_slug IN (COALESCE((
               SELECT r.target_harness_slug FROM harness_shared.blueprint_operation_invocations AS r
                WHERE r.id = ${root.receiptId} AND r.workspace_id = ${root.workspaceId}
                  AND r.harness_slug = ${root.harnessSlug}
             ), ${root.harnessSlug}), ${`harness:${root.harnessSlug}`})
         AND feature_id = ${rootId}
         AND status <> ALL(${ANY_FAMILY_TERMINAL_STATES as string[]}::text[])
         AND payload->'blueprintOperation'->>'operationId' = ${root.operationId}
         AND payload->'blueprintOperation'->>'specificationRevision' = ${root.specificationRevision}
         AND NOT (payload ? 'blueprintCancellation')
    `;
    if (Number(rows[0]?.updated_ts) !== parent.acceptedAttemptUpdatedTs) {
      throw new Error('program root attempt changed before child invocation');
    }
    return { ...root, target: { kind: 'work-item' as const, id: rootId } };
  });
}

/** A child program's receipt points at its parent receipt in its request key.
 * Count that durable lineage before creating another program root, so a chain
 * of different operation IDs cannot reset the spine's recursion limit. */
async function acceptedProgramDepth(sql: Sql, root: BlueprintOperationHandle): Promise<number> {
  const seen = new Set<number>();
  let receiptId = root.receiptId;
  let depth = 0;
  for (;;) {
    if (seen.has(receiptId) || depth > 16) throw new Error('program receipt ancestry is cyclic or too deep');
    seen.add(receiptId);
    const rows = await sql<Array<{ request_key: string }>>`
      SELECT request_key FROM harness_shared.blueprint_operation_invocations
       WHERE id = ${receiptId} AND workspace_id = ${root.workspaceId}
         AND harness_slug = ${root.harnessSlug}
    `;
    const key = rows[0]?.request_key;
    if (!key) throw new Error('program receipt ancestry is missing');
    const parent = /^program:([1-9][0-9]*):[a-zA-Z][a-zA-Z0-9_-]{0,79}$/.exec(key);
    if (!parent) return depth;
    receiptId = Number(parent[1]);
    if (!Number.isSafeInteger(receiptId)) throw new Error('program receipt ancestry is invalid');
    depth++;
  }
}

/** Invoke a declared child against the root's retained specification. The
 * receipt ID and authored step ID are the durable child identity: repeating a
 * DBOS step after a lost reply recovers the same direct item or plan run. */
export async function submitAcceptedCoordProgramChild(
  sql: Sql,
  parent: CoordProgramInput,
  child: { stepId: string; operationId: string; input: Record<string, unknown>; title?: string; summary?: string },
): Promise<BlueprintOperationHandle> {
  if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/.test(child.stepId)) {
    throw new Error('program child invocation requires a bounded authored step ID');
  }
  const root = await requireCurrentAcceptedCoordProgramRoot(sql, parent);
  if (!child.operationId || child.operationId === root.operationId) {
    throw new Error('program child invocation requires a distinct declared operation');
  }
  return runWithWorkspace(root.workspaceId, async () => {
    const blueprint = await loadAcceptedCoordProgramBlueprint(sql, root, parent.callerId);
    const specification = await readBlueprintSpecificationSnapshot(
      sql, root.workspaceId, root.harnessSlug, root.specificationRevision,
    );
    if (!specification) throw new Error('program root specification snapshot is missing');
    const { operation } = operationFromSpecification(specification, child.operationId);
    if (operation.execution?.kind === 'program' &&
        await acceptedProgramDepth(sql, root) >= Math.min(blueprint.recursion?.maxDepth ?? 1, 16)) {
      throw new Error('program child invocation exceeds the accepted recursion depth');
    }
    return submitBlueprintOperation(sql, {
      workspaceId: root.workspaceId, harnessSlug: root.harnessSlug,
      callerId: parent.callerId, operationId: child.operationId,
      requestKey: `program:${root.receiptId}:${child.stepId}`,
      input: child.input, title: child.title, summary: child.summary,
    }, { expectedSpecificationRevision: root.specificationRevision });
  });
}

/** Resolve only a child of this exact root and authored invocation step. The
 * receipt is durable across a lost step response; a handle supplied through
 * interpolated payload cannot redirect the wait to another operation. */
export async function loadAcceptedCoordProgramChild(
  sql: Sql, parent: CoordProgramInput, invokeStepId: string, operationId: string,
): Promise<BlueprintOperationHandle> {
  const root = parent.acceptedOperation;
  if (!root || root.target.kind !== 'work-item' || !/^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/.test(invokeStepId) ||
      parent.workspaceId !== root.workspaceId || parent.harnessSlug !== root.harnessSlug ||
      parent.workItemId !== root.target.id) {
    throw new Error('program child wait requires an accepted root and authored invocation step');
  }
  return runWithWorkspace(root.workspaceId, async () => {
    const rows = await sql<Array<{ id: string | number; target_kind: string; target_ref: string | null }>>`
      SELECT id, target_kind, target_ref
        FROM harness_shared.blueprint_operation_invocations
       WHERE workspace_id = ${root.workspaceId} AND harness_slug = ${root.harnessSlug}
         AND caller_id = ${parent.callerId} AND operation_id = ${operationId}
         AND request_key = ${`program:${root.receiptId}:op-${invokeStepId}`}
         AND specification_revision = ${root.specificationRevision}
    `;
    const row = rows[0];
    const receiptId = Number(row?.id);
    if (!row || !Number.isSafeInteger(receiptId) || receiptId <= 0 || !row.target_ref) {
      throw new Error('program child invocation receipt is missing or incomplete');
    }
    if (row.target_kind === 'work-item') {
      return { workspaceId: root.workspaceId, harnessSlug: root.harnessSlug,
        receiptId, operationId, specificationRevision: root.specificationRevision,
        target: { kind: 'work-item', id: row.target_ref } };
    }
    if (row.target_kind !== 'plan') throw new Error('program child receipt has an unknown target');
    const runs = await sql<Array<{ id: string | number }>>`
      SELECT id FROM harness_shared.plan_runs
       WHERE workspace_id = ${root.workspaceId} AND harness_slug = ${root.harnessSlug}
         AND instance_plan_slug = ${row.target_ref}
       LIMIT 1
    `;
    const runId = Number(runs[0]?.id);
    if (!Number.isSafeInteger(runId) || runId <= 0) throw new Error('program child plan run is missing');
    return { workspaceId: root.workspaceId, harnessSlug: root.harnessSlug,
      receiptId, operationId, specificationRevision: root.specificationRevision,
      target: { kind: 'plan', runId, instanceSlug: row.target_ref } };
  });
}

/** Canonical reads are deliberately outside DBOS.runStep so replay sees a
 * reopened child or newly cancelled root. The delay is not a DBOS operation:
 * recording a conditional DBOS.sleep would make replay diverge when current
 * state changes across a crash. DBOS recovers the workflow and re-reads state. */
export async function awaitAcceptedCoordProgramChild(
  sql: Sql, parent: CoordProgramInput,
  child: { invokeStepId: string; operationId: string; deadlineAt: string },
  sleep: (ms: number) => Promise<void> = (ms) => delay(ms),
): Promise<{ state: 'ready'; output: unknown; evidenceRef: string }> {
  const deadline = Date.parse(child.deadlineAt);
  if (!Number.isFinite(deadline)) throw new Error('program child wait requires an absolute deadline');
  const root = await requireCurrentAcceptedCoordProgramRoot(sql, parent);
  await loadAcceptedCoordProgramBlueprint(sql, root, parent.callerId);
  const handle = await loadAcceptedCoordProgramChild(sql, parent, child.invokeStepId, child.operationId);
  for (;;) {
    await requireCurrentAcceptedCoordProgramRoot(sql, parent);
    const result = await getBlueprintOperationResult(sql, handle, parent.callerId);
    if (result.state === 'ready') {
      await requireCurrentAcceptedCoordProgramRoot(sql, parent);
      return { state: 'ready', output: result.output, evidenceRef: result.evidenceRef };
    }
    if (result.state !== 'pending') {
      throw new Error(`program child ${child.invokeStepId} settled without validated success: ${result.state}`);
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`program child ${child.invokeStepId} did not settle before its deadline`);
    await sleep(Math.min(10_000, remaining));
  }
}

/** A cancelled root owns the cancellation handoff to children it already
 * accepted. The receipt request key identifies direct children even after a
 * lost DBOS step response. Nested programs repeat this for their own children. */
async function cancelAcceptedCoordProgramChildren(sql: Sql, input: CoordProgramInput): Promise<void> {
  const root = input.acceptedOperation;
  if (!root || root.target.kind !== 'work-item' || !input.workspaceId || !input.harnessSlug ||
      root.workspaceId !== input.workspaceId || root.harnessSlug !== input.harnessSlug ||
      root.target.id !== input.workItemId) {
    throw new Error('program child cancellation requires the accepted root');
  }
  const prefix = `program:${root.receiptId}:op-`;
  let afterId = 0;
  for (;;) {
    const children = await runWithWorkspace(root.workspaceId, () => sql<Array<{
      receipt_id: string; request_key: string; operation_id: string;
    }>>`
      SELECT i.id::text AS receipt_id, i.request_key, i.operation_id
        FROM harness_shared.blueprint_operation_invocations i
       WHERE i.workspace_id = ${root.workspaceId} AND i.harness_slug = ${root.harnessSlug}
         AND i.caller_id = ${input.callerId}
         AND i.specification_revision = ${root.specificationRevision}
         AND i.request_key LIKE ${`${prefix}%`} AND i.id > ${afterId}
       ORDER BY i.id LIMIT 8
    `);
    if (children.length === 0) return;
    for (const child of children) {
      const receiptId = Number(child.receipt_id);
      if (!Number.isSafeInteger(receiptId) || receiptId <= afterId) {
        throw new Error('program child cancellation found an invalid receipt id');
      }
      afterId = receiptId;
      const invokeStepId = child.request_key.slice(prefix.length);
      if (!child.request_key.startsWith(prefix) || !/^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/.test(invokeStepId)) {
        throw new Error('program child cancellation found an invalid receipt key');
      }
      const handle = await loadAcceptedCoordProgramChild(sql, input, invokeStepId, child.operation_id);
      const status = await getBlueprintOperationStatus(sql, handle, input.callerId);
      if (status.phase === 'terminal') continue;
      try {
        await cancelBlueprintOperation(sql, handle, input.callerId, {
          requestKey: `program-parent:${root.receiptId}:cancel`,
          reason: `parent program ${root.receiptId} was cancelled`,
        });
      } catch (error) {
        // A child can settle after the status read. Its completed result is
        // already canonical, and a cancellation must not rewrite it.
        if (!(error instanceof Error) || error.message !== 'cannot cancel a terminal blueprint operation') {
          throw error;
        }
      }
    }
  }
}

/** Admission's canonical receipt is the durable launch intent. This bounded
 * query is the recovery source for the routines tick once root settlement is
 * wired. A DBOS workflow row removes the accepted root from future scans. */
export async function findUnstartedAcceptedCoordPrograms(sql: Sql, limit = 32): Promise<CoordProgramInput[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('program launch scan limit must be 1..100');
  // WI-10003631: retire FINISHED receipts from the launch scan first. A receipt
  // is stamped only when its workflow exists AND its target work item is
  // terminal, which is a state the SELECT below already excludes. An in-flight
  // receipt is never stamped, so a non-terminal target whose workflow row
  // disappears stays launchable, exactly as before. Both statements ride the
  // partial index blueprint_operation_invocations_unstarted_idx (migration
  // 1237), so each pass costs O(unfinished receipts), not O(all receipts ever
  // accepted).
  await sql`
    UPDATE harness_shared.blueprint_operation_invocations i
       SET program_started_at = now()
     WHERE i.target_kind = 'work-item'
       AND i.program_started_at IS NULL
       AND ((EXISTS (
               SELECT 1 FROM dbos.workflow_status wf
                WHERE wf.workflow_uuid = 'coord-program:operation:' || i.workspace_id || ':' || i.id::text)
             AND EXISTS (
               SELECT 1 FROM harness_shared.work_items wi
                WHERE wi.workspace_id = i.workspace_id
                  AND wi.harness_slug IN (COALESCE(i.target_harness_slug, i.harness_slug),
                                          'harness:' || i.harness_slug)
                  AND wi.feature_id = i.target_ref
                  AND wi.status = ANY(${ANY_FAMILY_TERMINAL_STATES as string[]}::text[])))
            -- Direct work-item operations (not programs) can never be launched
            -- by this scan, whatever their state, so they leave it at once.
            OR NOT EXISTS (
               SELECT 1 FROM harness_shared.blueprint_specifications s
                CROSS JOIN LATERAL jsonb_array_elements(s.artifact->'configuration'->'operations') op
                WHERE s.workspace_id = i.workspace_id AND s.harness_slug = i.harness_slug
                  AND s.specification_revision = i.specification_revision
                  AND op->>'id' = i.operation_id
                  AND op->'execution'->>'kind' = 'program'))
  `;
  const rows = await sql<Array<{
    receipt_id: string; workspace_id: string; harness_slug: string;
    caller_id: string; operation_id: string; specification_revision: string;
    work_item_id: string; blueprint_id: string; input: unknown; updated_ts: string | number;
  }>>`
    SELECT i.id::text AS receipt_id, i.workspace_id, i.harness_slug,
           i.caller_id, i.operation_id, i.specification_revision,
           wi.feature_id AS work_item_id,
           COALESCE(op->'execution'->'blueprint'->>'ref',
                    s.artifact->'configuration'->>'id') AS blueprint_id,
           wi.payload->'blueprintOperation'->'input' AS input,
           wi.updated_ts
      FROM harness_shared.blueprint_operation_invocations i
      JOIN harness_shared.work_items wi
        ON wi.workspace_id = i.workspace_id
       -- WI-10004562 / D-045: a pot member's root is stored under the pot home slug.
       AND wi.harness_slug IN (COALESCE(i.target_harness_slug, i.harness_slug), 'harness:' || i.harness_slug)
       AND wi.feature_id = i.target_ref
      JOIN harness_shared.blueprint_specifications s
        ON s.workspace_id = i.workspace_id AND s.harness_slug = i.harness_slug
       AND s.specification_revision = i.specification_revision
      CROSS JOIN LATERAL jsonb_array_elements(s.artifact->'configuration'->'operations') op
      LEFT JOIN dbos.workflow_status wf
        ON wf.workflow_uuid = 'coord-program:operation:' || i.workspace_id || ':' || i.id::text
     WHERE i.target_kind = 'work-item'
       AND i.program_started_at IS NULL
       AND wi.status <> ALL(${ANY_FAMILY_TERMINAL_STATES as string[]}::text[])
       AND wf.workflow_uuid IS NULL
       AND wi.payload->'blueprintOperation'->>'operationId' = i.operation_id
       AND wi.payload->'blueprintOperation'->>'specificationRevision' = i.specification_revision
       AND jsonb_typeof(wi.payload->'blueprintOperation'->'input') = 'object'
       AND op->>'id' = i.operation_id
       AND op->'execution'->>'kind' = 'program'
       AND op->'target'->>'kind' = 'work-item'
     ORDER BY i.id LIMIT ${limit}
  `;
  return rows.map((row) => {
    const receiptId = Number(row.receipt_id);
    if (!Number.isSafeInteger(receiptId) || receiptId <= 0 ||
        !Number.isSafeInteger(Number(row.updated_ts)) ||
        !row.blueprint_id || !row.caller_id || !row.work_item_id) {
      throw new Error('accepted coord program launch candidate is malformed');
    }
    return {
      blueprintId: row.blueprint_id, payload: row.input as Record<string, unknown>,
      callerId: row.caller_id, workspaceId: row.workspace_id,
      harnessSlug: row.harness_slug, workItemId: row.work_item_id,
      runId: `receipt:${receiptId}`,
      acceptedAttemptUpdatedTs: Number(row.updated_ts),
      acceptedOperation: {
        workspaceId: row.workspace_id, harnessSlug: row.harness_slug,
        receiptId, operationId: row.operation_id,
        specificationRevision: row.specification_revision,
        target: { kind: 'work-item', id: row.work_item_id },
      },
    };
  });
}

/** Settle the root through the canonical work-item writer. Its guarded SQL
 * checks receipt, pinned program, admission epoch, reopen history and a
 * concurrent cancellation before it writes output or terminal state. */
export async function settleAcceptedCoordProgram(
  sql: Sql,
  input: CoordProgramInput,
  outcome: ProgramOutcome,
): Promise<BlueprintOperationStatus> {
  const handle = input.acceptedOperation;
  const updatedTs = input.acceptedAttemptUpdatedTs;
  if (!handle || handle.target.kind !== 'work-item' ||
      !Number.isSafeInteger(updatedTs) || !updatedTs ||
      input.workItemId !== handle.target.id || input.workspaceId !== handle.workspaceId ||
      input.harnessSlug !== handle.harnessSlug) {
    throw new Error('accepted coord program settlement has no current root attempt');
  }
  const rootId = handle.target.id;
  return runWithWorkspace(handle.workspaceId, async () => {
    // WI-10003631: one-round-trip guard first; the full validated status read is
    // needed only to RETURN an already-terminal root.
    const current = await readAcceptedProgramRootGuard(sql, handle);
    if (current.terminal) {
      const settled = await getBlueprintOperationStatus(sql, handle, input.callerId);
      if (settled.outcome === 'cancelled') await cancelAcceptedCoordProgramChildren(sql, input);
      return settled;
    }
    // WI-10004562 / D-045: a pot member's root is stored under the pot home slug, so the
    // settle/cancel writes address the row by the slug the guard actually read it under.
    const rootHarness = current.storageHarnessSlug;
    const attempt = {
      workspaceId: handle.workspaceId, harnessSlug: handle.harnessSlug,
      storageHarnessSlug: rootHarness,
      workItemId: rootId, receiptId: handle.receiptId,
      operationId: handle.operationId, specificationRevision: handle.specificationRevision,
      updatedTs, requireUncancelled: true,
    };
    let closedByCancel = false;
    const cancel = async () => {
      closedByCancel = true;
      return setWorkItemState(rootId, 'dropped', {
        harness: rootHarness, family: current.family, by: BLUEPRINT_PROGRAM_COMPLETION_OWNER,
        completionRef: `blueprint-program:cancelled:receipt:${handle.receiptId}`,
        completionAuthority: 'validated',
        acceptedProgramAttempt: { ...attempt, requireUncancelled: false },
      });
    };
    let closed = current.cancellationRequested ? await cancel() : null;
    let rejectedResult: string | null = null;
    if (!current.cancellationRequested) {
      if (outcome.resolved) {
        const output = { outcome: outcome.outcome, resolved: true,
          ...(outcome.decision === undefined ? {} : { decision: outcome.decision }) };
        try {
          closed = await setWorkItemState(rootId, 'done', {
            harness: rootHarness, family: current.family, by: BLUEPRINT_PROGRAM_COMPLETION_OWNER,
            completionRef: blueprintProgramCompletionRef(handle, 'succeeded'),
            completionAuthority: 'validated', outputPayload: output,
            acceptedProgramAttempt: attempt,
          });
        } catch (error) {
          if (!(error instanceof Error) ||
              (!error.message.startsWith('blueprint operation output is invalid:') &&
               !error.message.startsWith('blueprint operation acceptance failed:'))) throw error;
          rejectedResult = error.message;
        }
      }
      if (!closed) {
        const reread = await getBlueprintOperationStatus(sql, handle, input.callerId);
        if (reread.phase === 'terminal') return reread;
        if (reread.cancellationRequested) closed = await cancel();
        else {
          closed = await setWorkItemState(rootId, 'dropped', {
            harness: rootHarness, family: current.family, by: BLUEPRINT_PROGRAM_COMPLETION_OWNER,
            completionRef: blueprintProgramCompletionRef(handle, 'failed'),
            completionAuthority: 'validated', acceptedProgramAttempt: attempt,
            ...(rejectedResult ? { completionEvidence: { summary: rejectedResult } } : {}),
          });
        }
      }
    }
    if (!closed) throw new Error('accepted coord program root attempt changed before terminal settlement');
    // WI-10003631: the guarded writer returned the settled root row, and the
    // receipt/program pin were validated before the write, so project the
    // terminal status from it instead of a four-round-trip canonical re-read.
    // `wait` is null for every terminal projection; cancellation is what this
    // settlement observed (a cancel after a `done` write cannot change it).
    const projected = projectBlueprintOperationStatus(handle, [closed], null,
      { cancellationRequested: closedByCancel, wait: null });
    const terminal = projected.phase === 'terminal'
      ? projected : await getBlueprintOperationStatus(sql, handle, input.callerId);
    if (terminal.outcome === 'cancelled') await cancelAcceptedCoordProgramChildren(sql, input);
    return terminal;
  });
}

async function coordProgramImpl(input: CoordProgramInput): Promise<ProgramOutcome> {
  const accepted = input.acceptedOperation;
  if (accepted && (accepted.target.kind !== 'work-item' ||
      input.workspaceId !== accepted.workspaceId ||
      input.harnessSlug !== accepted.harnessSlug || input.workItemId !== accepted.target.id)) {
    throw new Error('accepted coord program scope differs from its canonical operation handle');
  }
  const loaded = accepted ? await loadAcceptedCoordProgram(getOrgPg().sql, accepted, input.callerId) : null;
  const blueprint: Blueprint = loaded
    ? loaded.blueprint
    : await _resolver(input.blueprintId, {
        workspaceId: input.workspaceId,
        harnessSlug: input.harnessSlug,
      });
  if (accepted && blueprint.id !== input.blueprintId) {
    throw new Error('accepted coord program blueprint id differs from its retained definition');
  }
  if (accepted && loaded) {
    // A crash after canonical completion but before DBOS records the workflow
    // return must replay the canonical result, never re-enter the program steps.
    // The loader's validating read IS that canonical result read (WI-10003631).
    const prior = loaded.prior;
    if (prior?.state === 'ready') {
      const output = prior.output;
      if (!output || typeof output !== 'object' || Array.isArray(output) ||
          typeof (output as Record<string, unknown>).outcome !== 'string' ||
          (output as Record<string, unknown>).resolved !== true) {
        throw new Error('canonical accepted program result has invalid workflow output');
      }
      return output as ProgramOutcome;
    }
    if (prior && prior.status.phase === 'terminal') {
      if (prior.status.outcome === 'cancelled') {
        await cancelAcceptedCoordProgramChildren(getOrgPg().sql, input);
      }
      return { outcome: prior.status.outcome ?? prior.state, resolved: false };
    }
  }

  const ctx = buildCoordOpCtx({
    identity: { ownerId: input.callerId, ownerLabel: input.callerLabel },
    workspaceId: input.workspaceId,
    harnessSlug: input.harnessSlug,
    callerId: input.callerId,
    workItemId: input.workItemId,
    depth: input.depth ?? 0,
  });

  // Top-level runOp: each op is a checkpointed DBOS step (durable + replay-safe).
  // The step name is the program-unique `op-<id>` / `gate-<op>` label.
  const runOp: RunOp = async (call, c) => {
    if (accepted && call.op === 'blueprint:invoke-child') {
      const parsed = invokeChildArgsSchema.parse(call.args);
      return DBOS.runStep(
        () => submitAcceptedCoordProgramChild(getOrgPg().sql, input, {
          stepId: call.label, ...parsed,
        }),
        { name: call.label },
      );
    }
    if (accepted && call.op === 'blueprint:await-child') {
      const parsed = awaitChildArgsSchema.parse(call.args);
      const deadlineAt = await DBOS.runStep(
        async () => new Date(Date.now() + parsed.timeoutSec * 1000).toISOString(),
        { name: `${call.label}:deadline` },
      );
      return awaitAcceptedCoordProgramChild(getOrgPg().sql, input, { ...parsed, deadlineAt });
    }
    return DBOS.runStep(
      async () => {
        // A live cancellation check must be inside the checkpointed step:
        // replay must first consume its recorded step name and output.
        // One-round-trip root guard (WI-10003631): the full status read cost
        // four round trips per step; the handle was validated at workflow start.
        if (accepted) {
          const guard = await readAcceptedProgramRootGuard(getOrgPg().sql, accepted);
          if (guard.terminal || guard.cancellationRequested) {
            throw new Error('accepted coord program is terminal or cancellation was requested');
          }
        }
        const op = requireCoordOp(call.op);
        const parsed = op.argsSchema.parse(call.args);
        return op.run(parsed, c);
      },
      { name: call.label },
    );
  };

  let outcome: ProgramOutcome;
  try {
    outcome = await runProgramCore({ blueprint, payload: input.payload, ctx, runOp });
  } catch (error) {
    if (!accepted) throw error;
    const status = await getBlueprintOperationStatus(getOrgPg().sql, accepted, input.callerId);
    if (status.cancellationRequested) outcome = { outcome: 'cancelled', resolved: false };
    else {
      console.warn(`[coord-program] accepted root ${accepted.receiptId} failed: ${error instanceof Error ? error.message : error}`);
      outcome = { outcome: 'failed', resolved: false };
    }
  }
  if (accepted) {
    const terminal = await DBOS.runStep(() => settleAcceptedCoordProgram(getOrgPg().sql, input, outcome),
      { name: 'settle-accepted-root' });
    if (terminal.outcome !== 'succeeded') {
      return { outcome: terminal.outcome ?? 'failed', resolved: false };
    }
  }
  // Drop the (potentially large) scope from the durable workflow's recorded
  // output — the decision + outcome are what matters to the caller.
  return { outcome: outcome.outcome, resolved: outcome.resolved, decision: outcome.decision };
}

export const coordProgramWorkflow = idempotentRegisterWorkflow('coordProgram', () =>
  DBOS.registerWorkflow(coordProgramImpl, {
    name: 'coordProgram',
    maxRecoveryAttempts: 10,
  }),
);

// WI-4015: idempotentWorkflowQueue guards the module-top-level-DBOS-singleton class
// (see idempotent-register-workflow.ts's doc comment).
/** P-013 D-025 (same mechanism as D-023): DBOS polls each queue every
 *  minPollingIntervalMs (default 1000 ms) and no enqueue wakes the runner, so
 *  every coord program waited U(0,1 s) before its first step. 50 ms costs about
 *  20 idle dequeue reads/s per executor. Pinned by coord-program-queue.test.ts. */
export const COORD_PROGRAM_QUEUE_MIN_POLL_MS = 50;

export const coordProgramQueue = idempotentWorkflowQueue('coord-program', () =>
  new WorkflowQueue('coord-program', {
    concurrency: queueConcurrency(4),
    minPollingIntervalMs: COORD_PROGRAM_QUEUE_MIN_POLL_MS,
  }),
);

/**
 * Start (or resume) a durable coord-op program. An accepted operation uses its
 * immutable receipt as the identity; legacy event programs keep their existing
 * harness/run/blueprint key. The dedup id guards a concurrent double-start.
 * Returns the workflow id without blocking on the program lifetime.
 */
export function coordProgramWorkflowId(input: CoordProgramInput): string {
  const accepted = input.acceptedOperation;
  return accepted
    ? `coord-program:operation:${accepted.workspaceId}:${accepted.receiptId}`
    : `coord-program:${input.harnessSlug ?? 'op'}:${input.runId}:${input.blueprintId}`;
}

export async function startCoordProgram(input: CoordProgramInput): Promise<string> {
  const workflowID = coordProgramWorkflowId(input);
  await DBOS.startWorkflow(coordProgramWorkflow, {
    workflowID,
    queueName: coordProgramQueue.name,
    enqueueOptions: { deduplicationID: workflowID },
  })(input);
  return workflowID;
}

/**
 * The event-rule firing seam (D-007): resolve an event key (e.g.
 * `coordination-op:vote`) to its program blueprint and start a durable run. This
 * is the function an [[event-reaction-system-2026-06-04]] rule's `fire` invokes —
 * "when <condition>, fire coordination-op:vote with <derived payload>". Returns
 * the workflow id, or null when no blueprint declares that event key.
 */
export async function startCoordProgramForEvent(
  eventKey: string,
  input: Omit<CoordProgramInput, 'blueprintId'>,
): Promise<string | null> {
  const { resolveCoordOpTrigger } = await import('../coord-ops/trigger.js');
  const blueprintId = resolveCoordOpTrigger(eventKey);
  if (!blueprintId) {
    console.warn(`[coord-program] no blueprint declares trigger event "${eventKey}"`);
    return null;
  }
  return startCoordProgram({ ...input, blueprintId });
}
