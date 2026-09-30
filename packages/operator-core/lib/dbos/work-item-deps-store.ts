/**
 * work-item-deps-store — read/write the dedicated `work_item_deps` table
 * (work-item-deps-and-readiness-2026-06-22 P-002/P-003) + the acyclicity guard (P-008).
 *
 * This is the NEW backend for the blockersOf() seam (work-item-blocking.ts), replacing
 * coord_links rel='blocks'. Same feature→feature shape as the coord_links reader
 * (feature-blockers-edges.ts) so the seam swap is transparent, but on a dedicated, indexed,
 * single-purpose table. Acyclicity is enforced HERE on write (a CHECK can't see the transitive
 * graph), reusing `detectDependencyCycle`. FK to the unified work_items lands with P-009.
 */
import { getOrgPg, withSerializableRetry, type SerializableRetryOptions } from '@papercusp/db-org';
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';
import type { LinkRow, ObjectRef } from '@papercusp/coordination/capabilities';
import type { Sql } from 'postgres';
import { featureRef, FEATURE_KIND, isQualifiedFeatureRef } from '../issue-blocks-merge';
import { resolveConcreteWorkspaceId } from '../workspace-registry';
import { detectDependencyCycle } from '../feature-deps';
import {
  analyzeDependencyGraph,
  dependencyIdentityKey,
  type DependencyEndpointDefect,
  type DependencyGraphAnalysis,
  type DependencyGraphEdgeInput,
  type DependencyGraphNodeInput,
  type DependencyIdentity,
  type DependencyStrandedNode,
  type DependencyStronglyConnectedComponent,
} from '../scheduler/dependency-graph-analysis';
import { getDependencyPolicy, type DependencyPolicyRule } from '../scheduler/dependency-invariants';
import {
  dependencyGraphPerformanceTelemetry,
  type DependencyGraphPerformanceTelemetry,
} from '../scheduler/dependency-performance-budget';
import { TERMINAL_STATUSES } from './frontier-readiness';
import { isCompletionSettled, type CompletionAuthorityFrom } from '../work-item-completion-authority';

/** The polymorphic endpoints accepted by work_item_deps (issue/feature today). */
export interface WorkItemDepEndpoint {
  kind: string;
  ref: string;
}

export interface WorkItemBlockingEdge {
  blocked_kind: string;
  blocked_ref: string;
  blocker_kind: string;
  blocker_ref: string;
  dep_type: 'blocks';
  satisfaction: DependencySatisfaction;
}

export const DEPENDENCY_SATISFACTIONS = ['settled', 'success'] as const;
export type DependencySatisfaction = (typeof DEPENDENCY_SATISFACTIONS)[number];
export interface WorkItemBlockerRequirement {
  id: string;
  satisfaction: DependencySatisfaction;
}

export type WorkItemDependencyMutation =
  | {
      readonly op: 'add' | 'remove';
      readonly blocked: WorkItemDepEndpoint;
      readonly blocker: WorkItemDepEndpoint;
      readonly createdBy?: string;
      readonly satisfaction?: DependencySatisfaction;
    }
  | {
      readonly op: 'replace';
      readonly blocked: WorkItemDepEndpoint;
      readonly blockers: readonly WorkItemDepEndpoint[];
      readonly createdBy?: string;
      readonly satisfaction?: DependencySatisfaction;
    };

export interface WorkItemDependencyBatchInput {
  /** Edge-table workspace. Existing work-item edges live in DEFAULT_COORD_WORKSPACE. */
  readonly workspaceId: string;
  /** Domain workspace containing the endpoint rows; defaults to `workspaceId`. */
  readonly itemWorkspaceId?: string;
  /** Operations are applied in order to one candidate graph, then committed atomically. */
  readonly mutations: readonly WorkItemDependencyMutation[];
}

export interface WorkItemDependencyAdmissionFinding {
  readonly policy: DependencyPolicyRule;
  readonly cycles: readonly DependencyStronglyConnectedComponent[];
  readonly endpointDefects: readonly DependencyEndpointDefect[];
  readonly stranded: readonly DependencyStrandedNode[];
  readonly lifecycleConflicts?: readonly WorkItemDependencyLifecycleConflict[];
}

export interface WorkItemDependencyLifecycleConflict {
  readonly edge: DependencyGraphEdgeInput;
  readonly dependant: {
    readonly identity: DependencyIdentity;
    readonly status: string;
    readonly takenBy: string | null;
  };
  readonly blocker: {
    readonly identity: DependencyIdentity;
    readonly status: string;
  };
}

export interface WorkItemDependencyBatchResult {
  readonly inserted: number;
  readonly removed: number;
  readonly before: DependencyGraphAnalysis;
  readonly after: DependencyGraphAnalysis;
  readonly telemetry: WorkItemDependencyMutationTelemetry;
}

export interface WorkItemDependencyMutationTelemetry extends DependencyGraphPerformanceTelemetry {
  readonly event: 'dependency-mutation-committed' | 'dependency-mutation-rejected';
  readonly policyCodes: readonly string[];
  readonly inserted?: number;
  readonly removed?: number;
}

/** Shared options for the compatibility facades routed through the canonical mutation seam. */
export interface WorkItemDependencyWriterOptions {
  readonly createdBy?: string;
  readonly satisfaction?: DependencySatisfaction;
  /** Injectable root database handle for real-Postgres tests and explicitly scoped internal callers. */
  readonly sql?: Sql;
  /** Endpoint-row workspace. Edge rows remain in DEFAULT_COORD_WORKSPACE. */
  readonly itemWorkspaceId?: string;
  readonly retry?: SerializableRetryOptions;
}

/**
 * Structured fail-closed result for a rejected candidate graph. Callers can
 * render exact paths/edges without parsing the prose message.
 */
export class WorkItemDependencyAdmissionError extends Error {
  readonly code = 'WORK_ITEM_DEPENDENCY_ADMISSION_REJECTED';
  constructor(
    readonly findings: readonly WorkItemDependencyAdmissionFinding[],
    readonly before: DependencyGraphAnalysis,
    readonly after: DependencyGraphAnalysis,
    readonly telemetry: WorkItemDependencyMutationTelemetry,
  ) {
    const details = findings.flatMap((finding) => [
      ...finding.cycles.map((cycle) => `dependency cycle: ${cycle.cyclePath.map(identityLabel).join(' -> ')}`),
      ...finding.endpointDefects.map((defect) => defect.message),
      ...finding.stranded.flatMap((row) => row.paths.map((path) => path.path.map(identityLabel).join(' -> '))),
      ...(finding.lifecycleConflicts ?? []).map(
        (conflict) =>
          `cannot add unresolved blocker ${identityLabel(conflict.blocker.identity)} ` +
          `(status=${conflict.blocker.status}) behind active dependant ` +
          `${identityLabel(conflict.dependant.identity)} (status=${conflict.dependant.status}, ` +
          `taken_by=${conflict.dependant.takenBy ?? 'null'})`,
      ),
    ]);
    super(`work_item_deps candidate rejected: ${details.join('; ') || 'dependency policy violation'}`);
    this.name = 'WorkItemDependencyAdmissionError';
  }
}

interface StoredDependencyEdge extends DependencyGraphEdgeInput {
  readonly createdBy: string | null;
  readonly satisfaction: DependencySatisfaction;
}

interface WorkItemNodeRow {
  readonly workspace_id: string;
  readonly harness_slug: string;
  readonly feature_id: string;
  readonly item_kind: string;
  readonly status: string | null;
  readonly taken_by: string | null;
  readonly authority: CompletionAuthorityFrom;
}

const ISSUE_ITEM_KINDS = new Set(['bug', 'change', 'task']);
const ISSUE_TERMINAL_STATUSES = new Set(['resolved', 'closed', 'done', 'dropped']);
const ACTIVE_DEPENDANT_STATUSES = new Set(['wip', 'in_progress', 'validating']);

function identityLabel(id: DependencyIdentity): string {
  return `${id.kind}:${id.ref}`;
}

function storedEdgeKey(edge: DependencyGraphEdgeInput): string {
  return JSON.stringify([edge.blocked.kind, edge.blocked.ref, edge.blocker.kind, edge.blocker.ref]);
}

function sortedStoredEdges(edges: Iterable<StoredDependencyEdge>): StoredDependencyEdge[] {
  return [...edges].sort((a, b) => storedEdgeKey(a).localeCompare(storedEdgeKey(b)));
}

function applyDependencyMutations(
  current: readonly StoredDependencyEdge[],
  mutations: readonly WorkItemDependencyMutation[],
): StoredDependencyEdge[] {
  const candidate = new Map(current.map((edge) => [storedEdgeKey(edge), edge]));
  for (const mutation of mutations) {
    if (mutation.op === 'replace') {
      const blockedKey = dependencyIdentityKey(mutation.blocked);
      for (const [key, edge] of candidate) {
        if (dependencyIdentityKey(edge.blocked) === blockedKey) candidate.delete(key);
      }
      for (const blocker of mutation.blockers) {
        const edge: StoredDependencyEdge = {
          blocked: mutation.blocked,
          blocker,
          createdBy: mutation.createdBy ?? null,
          satisfaction: mutation.satisfaction ?? 'settled',
        };
        candidate.set(storedEdgeKey(edge), edge);
      }
      continue;
    }
    const edge: StoredDependencyEdge = {
      blocked: mutation.blocked,
      blocker: mutation.blocker,
      createdBy: mutation.createdBy ?? null,
      satisfaction: mutation.satisfaction ?? 'settled',
    };
    const key = storedEdgeKey(edge);
    if (mutation.op === 'add') candidate.set(key, edge);
    else candidate.delete(key);
  }
  return sortedStoredEdges(candidate.values());
}

function endpointBareId(endpoint: DependencyIdentity): string | null {
  if (endpoint.kind !== ISSUE_ENDPOINT_KIND && endpoint.kind !== FEATURE_KIND) return null;
  return isQualifiedFeatureRef(endpoint.ref) ? endpoint.ref.slice(endpoint.ref.indexOf('#') + 1) : endpoint.ref;
}

function normalizedStatus(row: WorkItemNodeRow): string {
  return (row.status ?? '').trim().toLowerCase();
}

function workItemRowIsTerminal(row: WorkItemNodeRow): boolean {
  const status = normalizedStatus(row);
  const issueFamily = ISSUE_ITEM_KINDS.has(row.item_kind);
  const lifecycleTerminal = issueFamily ? ISSUE_TERMINAL_STATUSES.has(status) : TERMINAL_STATUSES.has(status);
  const abandoned = issueFamily
    ? status === 'closed' || status === 'dropped'
    : status === 'deprecated' || status === 'dropped';
  return isCompletionSettled(row.authority, lifecycleTerminal, abandoned);
}

function workItemRowIsSuccessful(row: WorkItemNodeRow): boolean {
  const status = normalizedStatus(row);
  const successful = ISSUE_ITEM_KINDS.has(row.item_kind)
    ? status === 'resolved' || status === 'done'
    : status === 'passed' || status === 'done';
  return isCompletionSettled(row.authority, successful);
}

function edgeIsSatisfiedByRow(edge: StoredDependencyEdge, row: WorkItemNodeRow): boolean {
  return edge.satisfaction === 'success' ? workItemRowIsSuccessful(row) : workItemRowIsTerminal(row);
}

function workItemRowIsActivelyOwned(row: WorkItemNodeRow): boolean {
  // A blocked item may retain its claim while it waits for an external
  // dependency. That parked claim is not evidence that the item has started
  // progressing, so it must not reject adding the blocker that explains it.
  if (normalizedStatus(row) === 'blocked') return false;
  const holder = row.taken_by?.trim() ?? '';
  return (
    (holder !== '' && holder.toLowerCase() !== 'unassigned') || ACTIVE_DEPENDANT_STATUSES.has(normalizedStatus(row))
  );
}

function rowNode(row: WorkItemNodeRow): DependencyGraphNodeInput {
  const issueFamily = ISSUE_ITEM_KINDS.has(row.item_kind);
  const id: DependencyIdentity = issueFamily
    ? { kind: ISSUE_ENDPOINT_KIND, ref: row.feature_id }
    : { kind: FEATURE_KIND, ref: featureRef(row.harness_slug, row.feature_id) };
  const qualified = featureRef(row.harness_slug, row.feature_id);
  const aliases: DependencyIdentity[] = issueFamily
    ? [
        { kind: FEATURE_KIND, ref: qualified },
        { kind: ISSUE_ENDPOINT_KIND, ref: qualified },
      ]
    : [
        { kind: ISSUE_ENDPOINT_KIND, ref: row.feature_id },
        { kind: FEATURE_KIND, ref: row.feature_id },
      ];
  return {
    id,
    aliases,
    terminal: workItemRowIsTerminal(row),
    scope: `${row.workspace_id}/${row.harness_slug}`,
  };
}

async function loadDependencyNodes(
  tx: Sql,
  workspaceId: string,
  edges: readonly StoredDependencyEdge[],
): Promise<{
  nodes: DependencyGraphNodeInput[];
  lifecycleRows: WorkItemNodeRow[];
  outOfScopeIdentityKeys: ReadonlySet<string>;
}> {
  const bareIds = new Set<string>();
  for (const edge of edges) {
    for (const endpoint of [edge.blocked, edge.blocker]) {
      const id = endpointBareId(endpoint);
      if (id) bareIds.add(id);
    }
  }
  if (bareIds.size === 0) return { nodes: [], lifecycleRows: [], outOfScopeIdentityKeys: new Set() };
  const ids = [...bareIds].sort();
  const rows = await tx<WorkItemNodeRow[]>`
    SELECT workspace_id, harness_slug, feature_id, item_kind, status, taken_by, authority
      FROM harness_shared.work_items
     WHERE feature_id = ANY(${ids}::text[])
     ORDER BY (workspace_id = ${workspaceId}) DESC, workspace_id, harness_slug, feature_id, item_kind`;
  const nodes: DependencyGraphNodeInput[] = [];
  const lifecycleRows: WorkItemNodeRow[] = [];
  const outOfScopeIdentityKeys = new Set<string>();
  for (const row of rows) {
    const node = rowNode(row);
    if (row.workspace_id === workspaceId) {
      nodes.push(node);
      lifecycleRows.push(row);
      continue;
    }
    outOfScopeIdentityKeys.add(dependencyIdentityKey(node.id));
    for (const alias of node.aliases ?? []) outOfScopeIdentityKeys.add(dependencyIdentityKey(alias));
  }
  return { nodes, lifecycleRows, outOfScopeIdentityKeys };
}

function newlyActiveDependantConflicts(
  before: readonly StoredDependencyEdge[],
  after: readonly StoredDependencyEdge[],
  rows: readonly WorkItemNodeRow[],
): WorkItemDependencyLifecycleConflict[] {
  const existing = new Map(before.map((edge) => [storedEdgeKey(edge), edge.satisfaction]));
  const rowsByIdentity = new Map(
    rows.map((row) => {
      const node = rowNode(row);
      return [dependencyIdentityKey(node.id), { row, identity: node.id }] as const;
    }),
  );
  const conflicts: WorkItemDependencyLifecycleConflict[] = [];

  for (const edge of after) {
    if (existing.get(storedEdgeKey(edge)) === edge.satisfaction) continue;
    const dependant = rowsByIdentity.get(dependencyIdentityKey(edge.blocked));
    const blocker = rowsByIdentity.get(dependencyIdentityKey(edge.blocker));
    // Missing, ambiguous, and out-of-workspace endpoints are reported by the canonical
    // graph analyser. Lifecycle admission must not replace that more precise diagnosis.
    if (!dependant || !blocker) continue;
    // A terminal dependant remains advisory history. A terminal blocker is already
    // satisfied, so inserting that retained edge does not change reachability.
    if (workItemRowIsTerminal(dependant.row) || edgeIsSatisfiedByRow(edge, blocker.row)) continue;
    if (!workItemRowIsActivelyOwned(dependant.row)) continue;

    conflicts.push({
      edge,
      dependant: {
        identity: dependant.identity,
        status: dependant.row.status ?? '',
        takenBy: dependant.row.taken_by,
      },
      blocker: {
        identity: blocker.identity,
        status: blocker.row.status ?? '',
      },
    });
  }
  return conflicts;
}

async function loadStoredDependencyEdges(tx: Sql, workspaceId: string): Promise<StoredDependencyEdge[]> {
  const rows = await tx<
    Array<{
      blocked_kind: string;
      blocked_ref: string;
      blocker_kind: string;
      blocker_ref: string;
      created_by: string | null;
      satisfaction: DependencySatisfaction;
    }>
  >`
    SELECT blocked_kind, blocked_ref, blocker_kind, blocker_ref, created_by, satisfaction
      FROM harness_shared.work_item_deps
     WHERE workspace_id = ${workspaceId} AND dep_type = 'blocks'
     ORDER BY blocked_kind, blocked_ref, blocker_kind, blocker_ref`;
  return rows.map((row) => ({
    blocked: { kind: row.blocked_kind, ref: row.blocked_ref },
    blocker: { kind: row.blocker_kind, ref: row.blocker_ref },
    createdBy: row.created_by,
    satisfaction: row.satisfaction,
  }));
}

/**
 * Hold every concrete endpoint named by this mutation stable until the graph
 * transaction commits.
 *
 * SERIALIZABLE protects the read/candidate/write decision from graph write
 * skew, but it does not make a later endpoint DELETE invalid by itself: a
 * history in which the edge commits immediately before the endpoint disappears
 * is serializable and still leaves a dangling application-level graph.  The
 * deletion boundary therefore refuses rows with incident edges (migration 988),
 * and this ordered SHARE lock closes the race between that check and a new edge
 * insert.  It also serializes harness re-home with mutation; migration 734 then
 * re-points any edge that committed first in the same UPDATE transaction.
 *
 * Lock only mutation-declared endpoints, not every node in the stored graph.
 * Existing incident edges are already protected by the delete guard, while
 * locking the whole graph would turn independent mutations into one global
 * critical section.  All matching rows are locked in a deterministic order so
 * batches that name the same endpoints cannot manufacture a row-lock deadlock.
 */
async function lockDependencyMutationEndpoints(
  tx: Sql,
  workspaceId: string,
  mutations: readonly WorkItemDependencyMutation[],
): Promise<void> {
  const bareIds = new Set<string>();
  for (const mutation of mutations) {
    const endpoints =
      mutation.op === 'replace' ? [mutation.blocked, ...mutation.blockers] : [mutation.blocked, mutation.blocker];
    for (const endpoint of endpoints) {
      const bareId = endpointBareId(endpoint);
      if (bareId) bareIds.add(bareId);
    }
  }
  if (bareIds.size === 0) return;
  const ids = [...bareIds].sort();
  await tx`
    SELECT workspace_id, harness_slug, feature_id, item_kind
      FROM harness_shared.work_items
     WHERE workspace_id = ${workspaceId}
       AND feature_id = ANY(${ids}::text[])
     ORDER BY workspace_id, harness_slug, feature_id, item_kind
     FOR SHARE`;
}

function analyseStoredEdges(
  nodes: readonly DependencyGraphNodeInput[],
  edges: readonly StoredDependencyEdge[],
): DependencyGraphAnalysis {
  return analyzeDependencyGraph({ nodes, edges });
}

function cycleSignature(component: DependencyStronglyConnectedComponent): string {
  return component.members.map(dependencyIdentityKey).sort().join('\u0001');
}

function endpointDefectSignature(defect: DependencyEndpointDefect, edges: readonly StoredDependencyEdge[]): string {
  const edge = edges[defect.edgeIndex];
  return JSON.stringify([
    edge ? storedEdgeKey(edge) : null,
    defect.role,
    defect.code,
    dependencyIdentityKey(defect.declared),
    defect.resolvedAs ? dependencyIdentityKey(defect.resolvedAs) : null,
    (defect.candidates ?? []).map(dependencyIdentityKey).sort(),
  ]);
}

function newlyRejectedFindings(
  before: DependencyGraphAnalysis,
  after: DependencyGraphAnalysis,
  beforeEdges: readonly StoredDependencyEdge[],
  afterEdges: readonly StoredDependencyEdge[],
  outOfScopeIdentityKeys: ReadonlySet<string>,
): WorkItemDependencyAdmissionFinding[] {
  const beforeCycles = new Set(before.stronglyConnectedComponents.map(cycleSignature));
  const cycles = after.stronglyConnectedComponents.filter((component) => !beforeCycles.has(cycleSignature(component)));

  const beforeDefects = new Set(before.endpointDefects.map((defect) => endpointDefectSignature(defect, beforeEdges)));
  const endpointDefects = after.endpointDefects.filter(
    (defect) => !beforeDefects.has(endpointDefectSignature(defect, afterEdges)),
  );

  const beforeStranded = new Set(before.stranded.map((row) => dependencyIdentityKey(row.node)));
  const stranded = after.stranded.filter((row) => !beforeStranded.has(dependencyIdentityKey(row.node)));

  const findings: WorkItemDependencyAdmissionFinding[] = [];
  if (cycles.length > 0) {
    findings.push({ policy: getDependencyPolicy('cycle')!, cycles, endpointDefects: [], stranded: [] });
  }
  const crossWorkspace = endpointDefects.filter((defect) =>
    outOfScopeIdentityKeys.has(dependencyIdentityKey(defect.declared)),
  );
  const crossWorkspaceSet = new Set(crossWorkspace);
  if (crossWorkspace.length > 0) {
    findings.push({
      policy: getDependencyPolicy('cross-workspace-inert-edge')!,
      cycles: [],
      endpointDefects: crossWorkspace,
      stranded: [],
    });
  }
  const missing = endpointDefects.filter((defect) => defect.code === 'missing' && !crossWorkspaceSet.has(defect));
  if (missing.length > 0) {
    findings.push({
      policy: getDependencyPolicy('executable-endpoint-missing')!,
      cycles: [],
      endpointDefects: missing,
      stranded: [],
    });
  }
  const identityDefects = endpointDefects.filter(
    (defect) => defect.code !== 'missing' && !crossWorkspaceSet.has(defect),
  );
  if (identityDefects.length > 0) {
    findings.push({
      policy: getDependencyPolicy('endpoint-identity-mismatch')!,
      cycles: [],
      endpointDefects: identityDefects,
      stranded: [],
    });
  }
  if (stranded.length > 0) {
    findings.push({
      policy: getDependencyPolicy('stranded-set-increase')!,
      cycles: [],
      endpointDefects: [],
      stranded,
    });
  }
  return findings;
}

async function applyStoredEdgeDiff(
  tx: Sql,
  workspaceId: string,
  before: readonly StoredDependencyEdge[],
  after: readonly StoredDependencyEdge[],
): Promise<{ inserted: number; removed: number }> {
  const beforeByKey = new Map(before.map((edge) => [storedEdgeKey(edge), edge]));
  const afterByKey = new Map(after.map((edge) => [storedEdgeKey(edge), edge]));
  const removed = [...beforeByKey.entries()].filter(([key]) => !afterByKey.has(key)).map(([, edge]) => edge);
  const inserted = [...afterByKey.entries()].filter(([key]) => !beforeByKey.has(key)).map(([, edge]) => edge);
  const updated = [...afterByKey.entries()]
    .filter(([key, edge]) => beforeByKey.has(key) && beforeByKey.get(key)!.satisfaction !== edge.satisfaction)
    .map(([, edge]) => edge);

  let removedCount = 0;
  for (const edge of removed) {
    const rows = await tx<Array<{ id: string | number }>>`
      DELETE FROM harness_shared.work_item_deps
       WHERE workspace_id = ${workspaceId} AND dep_type = 'blocks'
         AND blocked_kind = ${edge.blocked.kind} AND blocked_ref = ${edge.blocked.ref}
         AND blocker_kind = ${edge.blocker.kind} AND blocker_ref = ${edge.blocker.ref}
      RETURNING id`;
    removedCount += rows.length;
  }
  let insertedCount = 0;
  for (const edge of inserted) {
    const rows = await tx<Array<{ id: string | number }>>`
      INSERT INTO harness_shared.work_item_deps
        (workspace_id, blocked_kind, blocked_ref, blocker_kind, blocker_ref, dep_type, created_by, satisfaction)
      VALUES
        (${workspaceId}, ${edge.blocked.kind}, ${edge.blocked.ref},
         ${edge.blocker.kind}, ${edge.blocker.ref}, 'blocks', ${edge.createdBy}, ${edge.satisfaction})
      ON CONFLICT (workspace_id, blocked_kind, blocked_ref, blocker_kind, blocker_ref, dep_type)
      DO NOTHING
      RETURNING id`;
    insertedCount += rows.length;
  }
  for (const edge of updated) {
    await tx`
      UPDATE harness_shared.work_item_deps
         SET satisfaction = ${edge.satisfaction}
       WHERE workspace_id = ${workspaceId} AND dep_type = 'blocks'
         AND blocked_kind = ${edge.blocked.kind} AND blocked_ref = ${edge.blocked.ref}
         AND blocker_kind = ${edge.blocker.kind} AND blocker_ref = ${edge.blocker.ref}`;
  }
  return { inserted: insertedCount, removed: removedCount };
}

/**
 * Canonical dependency mutation boundary (dependency-graph-admission P-005).
 *
 * The complete read → candidate → analyse → write sequence runs in one
 * SERIALIZABLE transaction. Validation is delta-based: existing invalid data may
 * be repaired or left unchanged, while a mutation that introduces a new SCC,
 * endpoint defect, or stranded nonterminal node is rejected before any write.
 */
export async function mutateWorkItemDependencies(
  input: WorkItemDependencyBatchInput,
  opts: { sql?: Sql; retry?: SerializableRetryOptions } = {},
): Promise<WorkItemDependencyBatchResult> {
  const startedAt = performance.now();
  const sql = opts.sql ?? (getOrgPg().sql as Sql);
  return withWorkItemDependencyAdmissionTransaction(
    sql,
    async (tx) => {
      const itemWorkspaceId = input.itemWorkspaceId ?? input.workspaceId;
      await lockDependencyMutationEndpoints(tx, itemWorkspaceId, input.mutations);
      const current = await loadStoredDependencyEdges(tx, input.workspaceId);
      const candidate = applyDependencyMutations(current, input.mutations);
      const { nodes, lifecycleRows, outOfScopeIdentityKeys } = await loadDependencyNodes(tx, itemWorkspaceId, [
        ...current,
        ...candidate,
      ]);
      const before = analyseStoredEdges(nodes, current);
      const after = analyseStoredEdges(nodes, candidate);
      const findings = newlyRejectedFindings(before, after, current, candidate, outOfScopeIdentityKeys);
      const lifecycleConflicts = newlyActiveDependantConflicts(current, candidate, lifecycleRows);
      if (lifecycleConflicts.length > 0) {
        findings.push({
          policy: getDependencyPolicy('active-dependant-unreconciled')!,
          cycles: [],
          endpointDefects: [],
          stranded: [],
          lifecycleConflicts,
        });
      }
      if (findings.length > 0) {
        throw new WorkItemDependencyAdmissionError(findings, before, after, {
          ...dependencyGraphPerformanceTelemetry({
            operation: 'mutation',
            durationMs: performance.now() - startedAt,
            nodes: after.verdicts.length,
            edges: candidate.length,
          }),
          event: 'dependency-mutation-rejected',
          policyCodes: findings.map((finding) => finding.policy.code),
        });
      }
      const diff = await applyStoredEdgeDiff(tx, input.workspaceId, current, candidate);
      return {
        ...diff,
        before,
        after,
        telemetry: {
          ...dependencyGraphPerformanceTelemetry({
            operation: 'mutation',
            durationMs: performance.now() - startedAt,
            nodes: after.verdicts.length,
            edges: candidate.length,
          }),
          event: 'dependency-mutation-committed',
          policyCodes: [],
          ...diff,
        },
      };
    },
    opts.retry,
  );
}

/**
 * Canonical transaction boundary for any larger writer that can mutate the
 * dependency graph as one of its atomic side effects.
 *
 * Callers that already own an admission merge transaction cannot nest
 * {@link mutateWorkItemDependencies}; wrapping their complete operation here
 * preserves the same SERIALIZABLE + retry contract instead of validating the
 * graph inside postgres.js's default READ COMMITTED transaction.
 */
export async function withWorkItemDependencyAdmissionTransaction<T>(
  sql: Sql,
  fn: (tx: Sql) => Promise<T>,
  retry?: SerializableRetryOptions,
): Promise<T> {
  return withSerializableRetry(sql, fn, { ...DEPENDENCY_ADMISSION_RETRY_DEFAULTS, ...retry });
}

/**
 * WI-10003675: the retry budget for the dependency-graph contention class.
 *
 * A dependency admission txn reads the WHOLE workspace edge set plus its node rows, so
 * under SERIALIZABLE it conflicts with ordinary concurrent work_items writes, not just
 * with other dependency writers. The generic default (6 tries, ~310ms worst-case total
 * backoff) exhausted under 8 concurrent plan promotions (P-013 workload B), and plan
 * promotion then minted a join item with no blocker edges. 12 tries with each sleep
 * capped at 500ms gives ~4s worst-case total backoff. Callers can still override
 * any field.
 */
export const DEPENDENCY_ADMISSION_RETRY_DEFAULTS: Readonly<SerializableRetryOptions> = Object.freeze({
  maxRetries: 11,
  baseDelayMs: 20,
  maxDelayMs: 500,
});

interface RepointDependencyRow {
  id: string | number;
  blocked_kind: string;
  blocked_ref: string;
  blocker_kind: string;
  blocker_ref: string;
  dep_type: 'blocks';
  satisfaction: DependencySatisfaction | null;
  created_by: string | null;
}

export interface WorkItemDependencyRefRewriteReceipt {
  readonly before: Record<string, unknown>;
  readonly after: Record<string, unknown> | null;
  readonly targetPrior: Record<string, unknown> | null;
  readonly disposition: 'removed-self-edge' | 'merged-with-existing-edge' | 'repointed-edge';
}

function repointDependencyReceipt(row: RepointDependencyRow): Record<string, unknown> {
  return {
    id: String(row.id),
    blockedKind: row.blocked_kind,
    blockedRef: row.blocked_ref,
    blockerKind: row.blocker_kind,
    blockerRef: row.blocker_ref,
    depType: row.dep_type,
    satisfaction: row.satisfaction === 'success' ? 'success' : 'settled',
    createdBy: row.created_by ?? null,
  };
}

function normalizeDependencyRefRewrites(
  rewrites: readonly { from: string; to: string }[],
): Map<string, string> {
  const rewriteByRef = new Map<string, string>();
  for (const rewrite of rewrites) {
    if (
      rewrite.from.length === 0 ||
      rewrite.to.length === 0 ||
      rewrite.from.trim() !== rewrite.from ||
      rewrite.to.trim() !== rewrite.to
    ) {
      throw new Error('dependency ref rewrites require non-empty refs without surrounding whitespace');
    }
    // An identity rewrite is a true no-op. Leaving it in the map targets the
    // existing row, upserts that same row, then deletes it by id.
    if (rewrite.from === rewrite.to) continue;
    const priorTarget = rewriteByRef.get(rewrite.from);
    if (priorTarget !== undefined && priorTarget !== rewrite.to) {
      throw new Error(
        `conflicting dependency ref rewrites for ${rewrite.from}: ${priorTarget} and ${rewrite.to}`,
      );
    }
    rewriteByRef.set(rewrite.from, rewrite.to);
  }
  return rewriteByRef;
}

/**
 * Repoint dependency refs inside a caller-owned canonicalization transaction.
 *
 * Admission merges must update work-item identity, occurrence receipts and the
 * dependency graph atomically, so they cannot use the standalone transaction
 * opened by mutateWorkItemDependencies. This facade keeps every raw table write
 * in the store, locks the affected rows, applies the same endpoint/graph/lifecycle
 * admission checks, and returns the before/after rows needed for reversal.
 */
export async function repointWorkItemDependencyRefsInTransaction(
  tx: Sql,
  input: {
    workspaceId: string;
    itemWorkspaceId?: string;
    rewrites: readonly { from: string; to: string }[];
  },
  opts: {
    /** Injectable post-validation barrier for deterministic transaction-race coverage. */
    beforeWrite?: () => Promise<void>;
  } = {},
): Promise<WorkItemDependencyRefRewriteReceipt[]> {
  const startedAt = performance.now();
  const rewriteByRef = normalizeDependencyRefRewrites(input.rewrites);
  if (rewriteByRef.size === 0) return [];
  const rows = await tx<RepointDependencyRow[]>`
    SELECT id, blocked_kind, blocked_ref, blocker_kind, blocker_ref, dep_type, satisfaction, created_by
      FROM harness_shared.work_item_deps
     WHERE workspace_id = ${input.workspaceId}
       AND dep_type = 'blocks'
       AND (blocked_ref = ANY(${[...rewriteByRef.keys()]}::text[])
         OR blocker_ref = ANY(${[...rewriteByRef.keys()]}::text[]))
     ORDER BY id
     FOR UPDATE`;
  if (rows.length === 0) return [];

  const current = await loadStoredDependencyEdges(tx, input.workspaceId);
  const candidateByKey = new Map(current.map((edge) => [storedEdgeKey(edge), edge]));
  const lockMutations: WorkItemDependencyMutation[] = [];
  for (const row of rows) {
    const before: StoredDependencyEdge = {
      blocked: { kind: row.blocked_kind, ref: row.blocked_ref },
      blocker: { kind: row.blocker_kind, ref: row.blocker_ref },
      satisfaction: row.satisfaction === 'success' ? 'success' : 'settled',
      createdBy: row.created_by,
    };
    candidateByKey.delete(storedEdgeKey(before));
    lockMutations.push({ op: 'remove', blocked: before.blocked, blocker: before.blocker });
    const blocked = { ...before.blocked, ref: rewriteByRef.get(before.blocked.ref) ?? before.blocked.ref };
    const blocker = { ...before.blocker, ref: rewriteByRef.get(before.blocker.ref) ?? before.blocker.ref };
    if (dependencyIdentityKey(blocked) === dependencyIdentityKey(blocker)) continue;
    assertDepEndpointRefForm(blocked, 'blocked');
    assertDepEndpointRefForm(blocker, 'blocker');
    const targetPrior = candidateByKey.get(storedEdgeKey({ blocked, blocker }));
    const after: StoredDependencyEdge = {
      blocked,
      blocker,
      satisfaction:
        targetPrior?.satisfaction === 'success' || before.satisfaction === 'success' ? 'success' : 'settled',
      createdBy: targetPrior?.createdBy ?? before.createdBy,
    };
    candidateByKey.set(storedEdgeKey(after), after);
    lockMutations.push({
      op: 'add',
      blocked,
      blocker,
      satisfaction: after.satisfaction,
      createdBy: after.createdBy ?? undefined,
    });
  }

  const itemWorkspaceId = input.itemWorkspaceId ?? input.workspaceId;
  await lockDependencyMutationEndpoints(tx, itemWorkspaceId, lockMutations);
  const candidate = sortedStoredEdges(candidateByKey.values());
  const { nodes, lifecycleRows, outOfScopeIdentityKeys } = await loadDependencyNodes(tx, itemWorkspaceId, [
    ...current,
    ...candidate,
  ]);
  const beforeAnalysis = analyseStoredEdges(nodes, current);
  const afterAnalysis = analyseStoredEdges(nodes, candidate);
  const findings = newlyRejectedFindings(
    beforeAnalysis,
    afterAnalysis,
    current,
    candidate,
    outOfScopeIdentityKeys,
  );
  const lifecycleConflicts = newlyActiveDependantConflicts(current, candidate, lifecycleRows);
  if (lifecycleConflicts.length > 0) {
    findings.push({
      policy: getDependencyPolicy('active-dependant-unreconciled')!,
      cycles: [],
      endpointDefects: [],
      stranded: [],
      lifecycleConflicts,
    });
  }
  if (findings.length > 0) {
    throw new WorkItemDependencyAdmissionError(findings, beforeAnalysis, afterAnalysis, {
      ...dependencyGraphPerformanceTelemetry({
        operation: 'mutation',
        durationMs: performance.now() - startedAt,
        nodes: afterAnalysis.verdicts.length,
        edges: candidate.length,
      }),
      event: 'dependency-mutation-rejected',
      policyCodes: findings.map((finding) => finding.policy.code),
    });
  }

  await opts.beforeWrite?.();

  const receipts: WorkItemDependencyRefRewriteReceipt[] = [];
  for (const dependency of rows) {
    const blockedRef = rewriteByRef.get(dependency.blocked_ref) ?? dependency.blocked_ref;
    const blockerRef = rewriteByRef.get(dependency.blocker_ref) ?? dependency.blocker_ref;
    const before = repointDependencyReceipt(dependency);
    if (dependency.blocked_kind === dependency.blocker_kind && blockedRef === blockerRef) {
      await tx`DELETE FROM harness_shared.work_item_deps WHERE id = ${dependency.id}`;
      receipts.push({ before, after: null, targetPrior: null, disposition: 'removed-self-edge' });
      continue;
    }
    const [targetPrior] = await tx<RepointDependencyRow[]>`
      SELECT id, blocked_kind, blocked_ref, blocker_kind, blocker_ref, dep_type, satisfaction, created_by
        FROM harness_shared.work_item_deps
       WHERE workspace_id = ${input.workspaceId}
         AND blocked_kind = ${dependency.blocked_kind}
         AND blocked_ref = ${blockedRef}
         AND blocker_kind = ${dependency.blocker_kind}
         AND blocker_ref = ${blockerRef}
         AND dep_type = ${dependency.dep_type}
         AND id <> ${dependency.id}
       LIMIT 1`;
    const [after] = await tx<RepointDependencyRow[]>`
      INSERT INTO harness_shared.work_item_deps
        (workspace_id, blocked_kind, blocked_ref, blocker_kind, blocker_ref, dep_type, satisfaction, created_by)
      VALUES (${input.workspaceId}, ${dependency.blocked_kind}, ${blockedRef},
              ${dependency.blocker_kind}, ${blockerRef}, ${dependency.dep_type},
              ${dependency.satisfaction === 'success' ? 'success' : 'settled'}, ${dependency.created_by})
      ON CONFLICT (workspace_id, blocked_kind, blocked_ref, blocker_kind, blocker_ref, dep_type)
      DO UPDATE SET satisfaction = CASE
        WHEN harness_shared.work_item_deps.satisfaction = 'success' OR EXCLUDED.satisfaction = 'success'
          THEN 'success'
        ELSE 'settled'
      END
      RETURNING id, blocked_kind, blocked_ref, blocker_kind, blocker_ref, dep_type, satisfaction, created_by`;
    if (!after) throw new Error(`dependency repoint failed for ${String(dependency.id)}`);
    await tx`DELETE FROM harness_shared.work_item_deps WHERE id = ${dependency.id}`;
    receipts.push({
      before,
      after: repointDependencyReceipt(after),
      targetPrior: targetPrior ? repointDependencyReceipt(targetPrior) : null,
      disposition: targetPrior ? 'merged-with-existing-edge' : 'repointed-edge',
    });
  }
  return receipts;
}

export interface StoredWorkItemDependencyRow {
  id: string | number;
  blocked_kind: string;
  blocked_ref: string;
  blocker_kind: string;
  blocker_ref: string;
  dep_type: string;
  satisfaction: string | null;
  created_by: string | null;
}

/** Canonical bounded dependency-row reader for snapshot/reversal consumers. */
export async function readWorkItemDependenciesForRefs(
  sql: Sql,
  input: { workspaceId: string; refs: readonly string[] },
): Promise<StoredWorkItemDependencyRow[]> {
  const refs = [...new Set(input.refs.filter(Boolean))].sort();
  if (refs.length === 0) return [];
  return sql<StoredWorkItemDependencyRow[]>`
    SELECT d.id, d.blocked_kind, d.blocked_ref, d.blocker_kind, d.blocker_ref,
           d.dep_type, d.satisfaction, d.created_by
      FROM harness_shared.work_item_deps d
     WHERE d.workspace_id = ${input.workspaceId}
       AND d.dep_type = 'blocks'
       AND (d.blocked_ref = ANY(${refs}::text[]) OR d.blocker_ref = ANY(${refs}::text[]))
     ORDER BY d.blocked_kind, d.blocked_ref, d.blocker_kind, d.blocker_ref`;
}

/**
 * Shared active-blocked-ref projection for workspace readiness summaries.
 * Keeping both endpoint-family legs here prevents an owner-facing projection
 * from drifting away from the dependency store's canonical blocking semantics.
 */
export function activeWorkItemDependencyRefsSql(
  sql: Sql,
  input: {
    itemWorkspaceId: string;
    successfulStates: readonly string[];
    terminalStates: readonly string[];
    edgeWorkspaceId?: string;
  },
) {
  const edgeWorkspaceId = input.edgeWorkspaceId ?? DEFAULT_COORD_WORKSPACE;
  return sql`
    SELECT d.blocked_ref
      FROM harness_shared.work_item_deps d
      JOIN harness_shared.work_items blocker
        ON position('#' in d.blocker_ref) = 0
       AND blocker.workspace_id = ${input.itemWorkspaceId}
       AND blocker.feature_id = d.blocker_ref
     WHERE d.workspace_id = ${edgeWorkspaceId}
       AND d.dep_type = 'blocks'
       AND (
         (d.satisfaction = 'success' AND blocker.status <> ALL(${input.successfulStates}::text[]))
         OR (
           d.satisfaction IS DISTINCT FROM 'success'
           AND blocker.status <> ALL(${input.terminalStates}::text[])
         )
       )
    UNION
    SELECT d.blocked_ref
      FROM harness_shared.work_item_deps d
      JOIN harness_shared.work_items blocker
        ON position('#' in d.blocker_ref) > 0
       AND blocker.workspace_id = ${input.itemWorkspaceId}
       AND blocker.harness_slug = split_part(d.blocker_ref, '#', 1)
       AND blocker.feature_id = substring(d.blocker_ref from position('#' in d.blocker_ref) + 1)
     WHERE d.workspace_id = ${edgeWorkspaceId}
       AND d.dep_type = 'blocks'
       AND (
         (d.satisfaction = 'success' AND blocker.status <> ALL(${input.successfulStates}::text[]))
         OR (
           d.satisfaction IS DISTINCT FROM 'success'
           AND blocker.status <> ALL(${input.terminalStates}::text[])
         )
       )`;
}

/** The issue-family endpoint kind, the counterpart of FEATURE_KIND for this table. */
const ISSUE_ENDPOINT_KIND = 'issue';

/** The goal endpoint kind (goal-dag-shared-substrate-2026-08-18) — goals are the table's second
 *  consumer family; their readers/writers live in `@papercusp/agent-mcp/goal-deps`. */
export const GOAL_ENDPOINT_KIND = 'goal';

/**
 * P-005 / D-009 — the kind↔ref-FORM invariant, enforced at the ONE write seam.
 *
 * `work_item_deps` endpoints use a ref form determined by their family, and this is
 * deliberate, not an inconsistency to normalize away (D-009, after measuring all 94 rows /
 * 188 endpoint-sides: zero violations, the form is a pure function of the `*_kind` column):
 *
 *   - `feature` → harness-QUALIFIED `<harness>#<feature_id>`, because a feature's identity is
 *     (harness_slug, feature_id); a bare `F-NNN` would mis-attribute a block to the same id in
 *     another project. Gated by `work_item_is_blocked()` + the `work_item_blocked` sidecar.
 *   - `issue`   → BARE `EI-NNN` / `WI-NNN` (issues:link). Gated by `depsBlockedExclusionSql`,
 *     which keys on the bare `feature_id` because the `wir_*` sidecar triggers do not track
 *     issues. Teaching either predicate to match BOTH forms over-gates the feature family —
 *     that is D-007's retraction, and it is why the two forms must stay distinct.
 *
 * WHY A GUARD RATHER THAN A MIGRATION (the P-005 re-scope). Nothing enforced this: both link
 * doors funnel here, but only `linkWorkItem` checked a ref form, only on the `dst`, and only in
 * the feature direction — `linkIssue` mirrored straight through with no check at all. That is
 * the same shape as D-007 itself: a rule applied at one door instead of at the shared seam, so
 * the unchecked door drifts. A form-mismatched edge is not cosmetic — it is INVISIBLE TO BOTH
 * FLOORS (the issue floor looks for the bare ref and misses; the feature floor matches only the
 * qualified form), i.e. a silently inert dependency that looks recorded and gates nothing. A
 * one-time migration could not prevent it, because the next bad write recreates it.
 *
 * ⚠ WHAT THIS DELIBERATELY DOES **NOT** CATCH — do not read it as more coverage than it has.
 * This validates the ref's FORM against the declared `kind`. It cannot validate that the endpoint
 * RESOLVES to a row of that kind, because that needs a database read and this function is pure
 * (its purity is what lets the invariant be tested exhaustively and applied on every write path
 * without an await). A row can therefore satisfy this guard and still be inert: 3 such rows exist
 * live — `offsite-planner-demo#WI-247/248/249` carry `blocked_kind='feature'` with a properly
 * QUALIFIED ref, but the rows they point at are `item_kind='task'` (issue-family), so the issue
 * floor never matches them (it keys on the bare id) and the feature floor never evaluates them
 * (the sidecar triggers are feature-only). That kind↔TARGET-FAMILY check is a separate, DB-backed
 * guard, tracked separately — this one is its necessary but not sufficient half.
 *
 * Throws rather than returning null: `null` already means "self-edge, skip", and overloading it
 * with "malformed, dropped" would make a caller bug SILENT — the exact failure mode this guards.
 * Both callers already restrict to issue|feature, so any other kind is left alone rather than
 * rejected, keeping this a validator of the ratified convention and not a new kind whitelist.
 */
export function assertDepEndpointRefForm(endpoint: WorkItemDepEndpoint, role: 'blocked' | 'blocker'): void {
  const qualified = isQualifiedFeatureRef(endpoint.ref);
  if (endpoint.kind === FEATURE_KIND && !qualified) {
    throw new Error(
      `work_item_deps ${role} endpoint kind='${FEATURE_KIND}' requires a harness-qualified ref ` +
        `'<harness>#<feature_id>', got '${endpoint.ref}'. A bare ref here is invisible to BOTH ` +
        `blocking floors, so the edge would be silently inert (D-009 / D-007).`,
    );
  }
  if (endpoint.kind === ISSUE_ENDPOINT_KIND && qualified) {
    throw new Error(
      `work_item_deps ${role} endpoint kind='${ISSUE_ENDPOINT_KIND}' requires a BARE ref ` +
        `(e.g. 'EI-123'), got the harness-qualified '${endpoint.ref}'. The issue floor keys on the ` +
        `bare feature_id, so a qualified ref here is silently inert (D-009 / D-007).`,
    );
  }
  // goal endpoints (goal-dag-shared-substrate-2026-08-18 P-001, D-001/D-006): goal ids are
  // bare slug-hex (`ship-paid-app-3f9a1c`, minted by goalId()) and NEVER harness-qualified —
  // `harness_shared.goals` keys on (workspace_id, id), so a qualified ref here would match
  // nothing on the goal read side and mint a silently-inert edge, the same failure shape the
  // two branches above pin for their families. The goal readers/writers live in
  // `@papercusp/agent-mcp/goal-deps`; this seam-level guard exists so a future writer that
  // reaches the table through THIS module's helpers is held to the same convention.
  if (endpoint.kind === GOAL_ENDPOINT_KIND && qualified) {
    throw new Error(
      `work_item_deps ${role} endpoint kind='${GOAL_ENDPOINT_KIND}' requires a bare goal id ` +
        `(e.g. 'ship-paid-app-3f9a1c'), got the harness-qualified '${endpoint.ref}'. Goals key on ` +
        `(workspace_id, id), so a qualified ref is silently inert.`,
    );
  }
}

/**
 * EI-19387076313999646 / D-017 (LINK seam half). The SYNC seam had already learned to resolve
 * endpoint family from the target row; the LINK seam (`mirrorWorkItemBlockingEdge`, and by
 * extension every `work_items:link` / `linkIssue` caller) still trusted the DECLARED kind, so
 * `{ kind:'feature', ref:'<harness>#WI-9002' }` for an issue-family WI-9002 passed
 * `assertDepEndpointRefForm` (a pure ref-FORM check that cannot see the target row) and minted a
 * form-valid but INERT edge — invisible to both blocking floors at once.
 *
 * This is that same "decide the kind from the TARGET, not the caller" fix, shaped for a bare
 * endpoint rather than an (harnessSlug, id) pair: a caller-declared target_kind+target_ref
 * carries no harness for the id it might be about to mis-file under, so the unified work-item
 * row is checked here. The same read returns the endpoint's real workspace: edge rows live in
 * DEFAULT_COORD_WORKSPACE, while candidate analysis must load endpoint rows from their tenant.
 *
 * Only 'issue'/'feature' endpoints are resolved — every other coord ObjectRef kind this store's
 * callers pass through (a plan_item, an event key, a topic) is not a work-item at all, so there
 * is no family to disagree with.
 *
 * ABSENT rows are left AS DECLARED so the canonical analyser can report the exact missing
 * endpoint and reject the batch. The resolver never silently drops or rewrites a missing ref.
 */
interface ResolvedWorkItemDepEndpoint {
  readonly endpoint: WorkItemDepEndpoint;
  readonly workspaceId: string | null;
}

async function resolveActualDepEndpoint(sql: Sql, endpoint: WorkItemDepEndpoint): Promise<ResolvedWorkItemDepEndpoint> {
  if (endpoint.kind !== ISSUE_ENDPOINT_KIND && endpoint.kind !== FEATURE_KIND) {
    return { endpoint, workspaceId: null };
  }
  const bareId =
    endpoint.kind === FEATURE_KIND && isQualifiedFeatureRef(endpoint.ref)
      ? endpoint.ref.slice(endpoint.ref.indexOf('#') + 1)
      : endpoint.ref;
  const issueRows = await sql<Array<{ workspace_id: string }>>`
    SELECT workspace_id
      FROM harness_shared.work_items
     WHERE feature_id = ${bareId}
       AND item_kind IN ('bug', 'change', 'task')
     ORDER BY workspace_id
     LIMIT 1`;
  if (issueRows.length > 0) {
    return {
      endpoint: { kind: ISSUE_ENDPOINT_KIND, ref: bareId },
      workspaceId: issueRows[0]!.workspace_id,
    };
  }
  const requestedHarness =
    endpoint.kind === FEATURE_KIND && isQualifiedFeatureRef(endpoint.ref)
      ? endpoint.ref.slice(0, endpoint.ref.indexOf('#'))
      : '';
  const featureRows = await sql<Array<{ workspace_id: string; harness_slug: string }>>`
    SELECT workspace_id, harness_slug
      FROM harness_shared.work_items
     WHERE feature_id = ${bareId}
       AND item_kind NOT IN ('bug', 'change', 'task')
     ORDER BY (harness_slug = ${requestedHarness}) DESC, workspace_id, harness_slug
     LIMIT 1`;
  if (featureRows.length > 0) {
    return {
      endpoint: { kind: FEATURE_KIND, ref: featureRef(featureRows[0]!.harness_slug, bareId) },
      workspaceId: featureRows[0]!.workspace_id,
    };
  }
  return { endpoint, workspaceId: null };
}

function mutationItemWorkspaceId(resolutions: readonly ResolvedWorkItemDepEndpoint[], explicit?: string): string {
  if (explicit?.trim()) return explicit.trim();
  return resolutions.find((resolution) => resolution.workspaceId !== null)?.workspaceId ?? resolveConcreteWorkspaceId();
}

/** Pure coord_links (blocker → blocked) to work_item_deps (blocked → blocker) mapping. */
export function workItemBlockingEdge(
  blocker: WorkItemDepEndpoint,
  blocked: WorkItemDepEndpoint,
): WorkItemBlockingEdge | null {
  if (blocker.kind === blocked.kind && blocker.ref === blocked.ref) return null;
  // AFTER the self-edge check: a self-edge is a legitimate no-op the callers rely on, so it must
  // stay a quiet `null` even if both its endpoints are malformed.
  assertDepEndpointRefForm(blocked, 'blocked');
  assertDepEndpointRefForm(blocker, 'blocker');
  return {
    blocked_kind: blocked.kind,
    blocked_ref: blocked.ref,
    blocker_kind: blocker.kind,
    blocker_ref: blocker.ref,
    dep_type: 'blocks',
    satisfaction: 'settled',
  };
}

/**
 * Mirror one coord_links `blocks` edge into the scheduler's readiness store.
 * coord_links uses blocker → blocked orientation; work_item_deps stores the
 * same edge as blocked → blocker. Keeping this conversion here gives every
 * work-item link writer one durable mirror primitive.
 */
export async function mirrorWorkItemBlockingEdge(
  blocker: WorkItemDepEndpoint,
  blocked: WorkItemDepEndpoint,
  opts: WorkItemDependencyWriterOptions = {},
): Promise<void> {
  // EI-19387076313999646: resolve BOTH endpoints against their actual target row's family
  // before writing — closes the link-seam half of D-017 (see resolveActualDepEndpoint above).
  const sql = opts.sql ?? (getOrgPg().sql as Sql);
  const [blockerResolution, blockedResolution] = await Promise.all([
    resolveActualDepEndpoint(sql, blocker),
    resolveActualDepEndpoint(sql, blocked),
  ]);
  const resolvedBlocker = blockerResolution.endpoint;
  const resolvedBlocked = blockedResolution.endpoint;
  const edge = workItemBlockingEdge(resolvedBlocker, resolvedBlocked);
  if (!edge) return;
  await mutateWorkItemDependencies(
    {
      workspaceId: DEFAULT_COORD_WORKSPACE,
      itemWorkspaceId: mutationItemWorkspaceId([blockedResolution, blockerResolution], opts.itemWorkspaceId),
      mutations: [
        {
          op: 'add',
          blocked: resolvedBlocked,
          blocker: resolvedBlocker,
          createdBy: opts.createdBy,
          satisfaction: opts.satisfaction,
        },
      ],
    },
    { sql, retry: opts.retry },
  );
}

/** Remove the scheduler-readiness mirror for one coord_links `blocks` edge. */
export async function removeMirroredWorkItemBlockingEdge(
  blocker: WorkItemDepEndpoint,
  blocked: WorkItemDepEndpoint,
  opts: WorkItemDependencyWriterOptions = {},
): Promise<void> {
  // Same resolution as the write path (EI-19387076313999646): an unlink call passing the
  // ORIGINAL (possibly mis-declared) kind+ref must still find the CORRECTED row that was
  // actually inserted, or the edge becomes un-removable through this door.
  const sql = opts.sql ?? (getOrgPg().sql as Sql);
  const [blockerResolution, blockedResolution] = await Promise.all([
    resolveActualDepEndpoint(sql, blocker),
    resolveActualDepEndpoint(sql, blocked),
  ]);
  const resolvedBlocker = blockerResolution.endpoint;
  const resolvedBlocked = blockedResolution.endpoint;
  if (!workItemBlockingEdge(resolvedBlocker, resolvedBlocked)) return;
  await mutateWorkItemDependencies(
    {
      workspaceId: DEFAULT_COORD_WORKSPACE,
      itemWorkspaceId: mutationItemWorkspaceId([blockedResolution, blockerResolution], opts.itemWorkspaceId),
      mutations: [{ op: 'remove', blocked: resolvedBlocked, blocker: resolvedBlocker }],
    },
    { sql, retry: opts.retry },
  );
}

/** blocked feature_id → blocker feature_ids (within `harnessSlug`, prefix-stripped). Pure read. */
export async function getWorkItemDepBlockers(harnessSlug: string): Promise<Map<string, WorkItemBlockerRequirement[]>> {
  const { sql } = getOrgPg();
  const prefix = `${harnessSlug}#`;
  const rows = await sql<{ blocked_ref: string; blocker_ref: string; satisfaction: DependencySatisfaction }[]>`
    SELECT blocked_ref, blocker_ref, satisfaction
      FROM harness_shared.work_item_deps
     WHERE workspace_id = ${DEFAULT_COORD_WORKSPACE}
       AND dep_type = 'blocks'
       AND blocked_kind = ${FEATURE_KIND}
       AND blocker_kind = ${FEATURE_KIND}
       AND blocked_ref LIKE ${prefix + '%'}`;
  const out = new Map<string, WorkItemBlockerRequirement[]>();
  for (const r of rows) {
    if (!r.blocked_ref.startsWith(prefix) || !r.blocker_ref.startsWith(prefix)) continue;
    const blocked = r.blocked_ref.slice(prefix.length);
    const blocker = r.blocker_ref.slice(prefix.length);
    const arr = out.get(blocked) ?? [];
    if (!arr.some((entry) => entry.id === blocker)) arr.push({ id: blocker, satisfaction: r.satisfaction });
    out.set(blocked, arr);
  }
  return out;
}

interface WorkItemDepLinkRowDb {
  id: string | number;
  blocked_kind: string;
  blocked_ref: string;
  blocker_kind: string;
  blocker_ref: string;
  dep_type: string;
  created_by: string | null;
  created_at: unknown;
  satisfaction: DependencySatisfaction;
}

export type WorkItemDependencyLinkRow = LinkRow & { satisfaction: DependencySatisfaction };
function toLinkRow(row: WorkItemDepLinkRowDb): WorkItemDependencyLinkRow {
  return {
    id: Number(row.id),
    src: { kind: row.blocker_kind, ref: row.blocker_ref },
    dst: { kind: row.blocked_kind, ref: row.blocked_ref },
    rel: row.dep_type,
    created_by: row.created_by,
    created_ts:
      row.created_at instanceof Date ? row.created_at.toISOString() : new Date(row.created_at as string).toISOString(),
    satisfaction: row.satisfaction,
  };
}

async function listWorkItemDepEdges(
  side: 'out' | 'in',
  refs: readonly ObjectRef[],
  opts: { rel?: string } = {},
): Promise<LinkRow[]> {
  if (refs.length === 0) return [];
  const { sql } = getOrgPg();
  const byKind = new Map<string, string[]>();
  for (const ref of refs) {
    const values = byKind.get(ref.kind);
    if (values) values.push(ref.ref);
    else byKind.set(ref.kind, [ref.ref]);
  }
  const out: LinkRow[] = [];
  for (const [kind, values] of byKind) {
    const rows =
      side === 'out'
        ? await sql<WorkItemDepLinkRowDb[]>`
            SELECT id, blocked_kind, blocked_ref, blocker_kind, blocker_ref,
                   dep_type, created_by, created_at, satisfaction
              FROM harness_shared.work_item_deps
             WHERE workspace_id = ${DEFAULT_COORD_WORKSPACE}
               AND blocker_kind = ${kind} AND blocker_ref = ANY(${values})
               AND ${opts.rel == null ? sql`TRUE` : sql`dep_type = ${opts.rel}`}
             ORDER BY created_at ASC, id ASC`
        : await sql<WorkItemDepLinkRowDb[]>`
            SELECT id, blocked_kind, blocked_ref, blocker_kind, blocker_ref,
                   dep_type, created_by, created_at, satisfaction
              FROM harness_shared.work_item_deps
             WHERE workspace_id = ${DEFAULT_COORD_WORKSPACE}
               AND blocked_kind = ${kind} AND blocked_ref = ANY(${values})
               AND ${opts.rel == null ? sql`TRUE` : sql`dep_type = ${opts.rel}`}
             ORDER BY created_at ASC, id ASC`;
    out.push(...rows.map(toLinkRow));
  }
  return out;
}

/** LinkRow-shaped reads over the canonical work-item dependency graph.
 * work_item_deps stores blocked→blocker columns; the public edge convention remains
 * blocker src → blocked dst, matching Linkable and the historical coord_links surface. */
export const workItemDepEdgeReader = {
  listOut: (src: ObjectRef, opts?: { rel?: string }) => listWorkItemDepEdges('out', [src], opts),
  listIn: (dst: ObjectRef, opts?: { rel?: string }) => listWorkItemDepEdges('in', [dst], opts),
  listOutMany: (srcs: ObjectRef[], opts?: { rel?: string }) => listWorkItemDepEdges('out', srcs, opts),
  listInMany: (dsts: ObjectRef[], opts?: { rel?: string }) => listWorkItemDepEdges('in', dsts, opts),
};

/**
 * Acyclicity guard (P-008): would REPLACING `blocked`'s blocker set with `newBlockers` create a
 * dependency cycle? Pure (reuses detectDependencyCycle). Replace-semantics matches the writer
 * (delete + insert the blocked item's edges); self-edges are dropped (the no-self-block invariant).
 */
export function wouldCreateCycle(
  current: ReadonlyMap<string, readonly string[]>,
  blocked: string,
  newBlockers: readonly string[],
): boolean {
  const edges = new Map<string, string[]>();
  for (const [k, v] of current) if (k !== blocked) edges.set(k, [...v]);
  edges.set(blocked, Array.from(new Set(newBlockers.filter((b) => b !== blocked))));
  return detectDependencyCycle(edges).hasCycle;
}

/**
 * Set ONE work-item's `blocks` edges in work_item_deps to exactly `blockedBy` (delete + insert),
 * through the canonical P-005 candidate-graph admission transaction. Transactional + idempotent.
 *
 * ⚠ EI-19325959789634791 / D-017 — endpoint kind is resolved from the TARGET ROW'S FAMILY, not
 * assumed to be `feature`. It was assumed for a long time, and the assumption held only because
 * the sole caller (promotion) feeds items it just MINTED, which are always feature-family.
 * P-009's backfill widened the input to the whole `implements` plane — which includes
 * convertPlanItem-created issue-family items — and every edge it wrote for one of those was
 * SILENTLY INERT: written with kind='feature' + a qualified ref, while the issue floor matches a
 * BARE ref, and the feature floor never evaluates an issue row at all. 6 such rows landed live,
 * 3 on genuinely-open items with non-terminal blockers, while every counter reported success.
 *
 * When the target resolves to issue-family, the batch also clears the historical feature-form
 * alias that the old feature-only implementation could have minted. That repair is represented
 * as another mutation in the SAME validated candidate, never as raw pre-admission DML.
 */
export async function syncWorkItemDepEdges(
  harnessSlug: string,
  featureId: string,
  blockedBy: readonly string[],
  opts: WorkItemDependencyWriterOptions = {},
): Promise<void> {
  const sql = opts.sql ?? (getOrgPg().sql as Sql);
  const blockedResolution = await resolveActualDepEndpoint(sql, {
    kind: FEATURE_KIND,
    ref: featureRef(harnessSlug, featureId),
  });
  const blockerResolutions = await Promise.all(
    blockedBy.map((blockerId) =>
      resolveActualDepEndpoint(sql, { kind: FEATURE_KIND, ref: featureRef(harnessSlug, blockerId) }),
    ),
  );
  const blockers = blockerResolutions
    .map((resolution) => resolution.endpoint)
    .filter((blocker) => workItemBlockingEdge(blocker, blockedResolution.endpoint) !== null);
  const mutations: WorkItemDependencyMutation[] = [];
  if (blockedResolution.endpoint.kind === ISSUE_ENDPOINT_KIND) {
    const historicalFeatureAlias = { kind: FEATURE_KIND, ref: featureRef(harnessSlug, featureId) };
    if (dependencyIdentityKey(historicalFeatureAlias) !== dependencyIdentityKey(blockedResolution.endpoint)) {
      mutations.push({ op: 'replace', blocked: historicalFeatureAlias, blockers: [] });
    }
  }
  mutations.push({
    op: 'replace',
    blocked: blockedResolution.endpoint,
    blockers,
    createdBy: opts.createdBy,
    satisfaction: opts.satisfaction,
  });
  await mutateWorkItemDependencies(
    {
      workspaceId: DEFAULT_COORD_WORKSPACE,
      itemWorkspaceId: mutationItemWorkspaceId([blockedResolution, ...blockerResolutions], opts.itemWorkspaceId),
      mutations,
    },
    { sql, retry: opts.retry },
  );
}
