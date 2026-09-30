/**
 * Atomic materialization core for the directed-pair pilot.
 *
 * This module is deliberately isolated from pilot-cohort.ts. It owns the irreversible
 * boundary only: freeze and lock exactly 21 rows, prove every row and receipt is still
 * eligible, re-read the current green/deployed pin, then apply every pilot stamp through
 * one cohort-wide CAS. Any failure rolls the transaction back and returns a durable,
 * explicit abort receipt containing the exact preimages and rollback verification.
 *
 * P-017 stays the canonical receipt authority. The core accepts that authority through
 * CanonicalParticipantReceiptAuthority so the integration seam can call
 * readPilotParticipantReceiptStore + validatePilotParticipantReceiptCohort without
 * duplicating their schema here.
 */

import { randomUUID } from 'node:crypto';
import { assignmentPayloadPatch, assignCohort, type PilotCandidate } from './pilot-arm-assignment';
import { boundedOrgTxn } from './pg-bounded-txn';
import { devDeployState } from './dev-deploy-state';
import { classifyReleaseParity } from './release-parity';
import { ALL_SUCCESSFUL_STATUSES } from './work-item-blocking';

export const PILOT_MATERIALIZATION_COHORT_SIZE = 21;

export const PILOT_MATERIALIZATION_KEYS = [
  'pilotArm',
  'pilotSeed',
  'pilotStratum',
  'pilotBlockIndex',
  'pilotPartialBlock',
  'pilotAssignedAtMs',
  'pilotParticipants',
] as const;

export type PilotMaterializationKey = (typeof PILOT_MATERIALIZATION_KEYS)[number];

export interface FrozenPilotCandidate {
  readonly id: string;
  readonly tier: PilotCandidate['tier'];
  readonly stratum?: string;
  readonly expectedUpdatedTs: number;
  readonly expectedAssignee: string;
  /** Exact WorkItem.takenAt ISO; this is also P-017's canonical claimVersion. */
  readonly expectedTakenAt: string;
}

export interface PilotMaterializationRow {
  readonly id: string;
  readonly status: string;
  readonly kind: string | null;
  readonly updatedTs: number;
  readonly assignee: string | null;
  readonly takenAt: string | null;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface PilotArmBProbeRow {
  readonly id: string;
  readonly status: string;
  readonly updatedTs: number;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface CanonicalReceiptCandidate {
  readonly id: string;
  readonly expectedOwnerId: string;
  readonly expectedClaimVersion: string;
  readonly payload: unknown;
}

export interface CanonicalParticipantReceiptValidation {
  readonly ok: boolean;
  readonly errors: readonly string[];
  /**
   * Canonical participant bindings derived from P-017 receipts, keyed by item id.
   * These become pilotParticipants; callers may not synthesize a second identity list.
   */
  readonly participantsByItem: Readonly<Record<string, readonly unknown[]>>;
}

export interface CanonicalParticipantReceiptAuthority {
  validate(
    candidates: readonly CanonicalReceiptCandidate[],
  ): CanonicalParticipantReceiptValidation | Promise<CanonicalParticipantReceiptValidation>;
}

export interface CurrentReleasePin {
  readonly deployedSha: string | null;
  readonly greenPinSha: string | null;
  readonly capturedAtMs: number;
}

export interface PilotMaterializationPatch {
  readonly id: string;
  readonly expectedUpdatedTs: number;
  readonly expectedAssignee: string;
  readonly expectedTakenAt: string;
  readonly nextUpdatedTs: number;
  readonly payloadPatch: Readonly<Record<PilotMaterializationKey, unknown>>;
}

export interface PilotMaterializationScope {
  readonly workspaceId: string;
  readonly harnessSlug: string;
  /** work_item_deps is coordination-global today and normally uses "default". */
  readonly dependencyWorkspaceId: string;
}

export interface PilotMaterializationTransaction {
  lockRows(scope: PilotMaterializationScope, ids: readonly string[]): Promise<readonly PilotMaterializationRow[]>;
  unresolvedBlockerIds(scope: PilotMaterializationScope, ids: readonly string[]): Promise<readonly string[]>;
  readProbe(scope: PilotMaterializationScope, id: string): Promise<PilotArmBProbeRow | null>;
  casApply(
    scope: PilotMaterializationScope,
    patches: readonly PilotMaterializationPatch[],
  ): Promise<readonly PilotMaterializationRow[]>;
  appendAudit(input: PilotMaterializationAuditInput): Promise<void>;
}

export interface PilotMaterializationStore {
  transaction<T>(fn: (tx: PilotMaterializationTransaction) => Promise<T>): Promise<T>;
  readRows(scope: PilotMaterializationScope, ids: readonly string[]): Promise<readonly PilotMaterializationRow[]>;
  appendAbortAudit(input: PilotMaterializationAuditInput): Promise<void>;
}

export interface MaterializePilotCohortInput {
  readonly workspaceId: string;
  readonly harnessSlug: string;
  readonly dependencyWorkspaceId?: string;
  readonly actor: string;
  readonly seed: string;
  readonly armBProbeItemId: string;
  readonly candidates: readonly FrozenPilotCandidate[];
}

export interface PilotArmBProofReceipt {
  readonly probeItemId: string;
  readonly probeUpdatedTs: number;
  readonly judgementPersisted: true;
  readonly testedSha: string;
  readonly claimedDeployedSha: string;
  readonly actualDeployedSha: string;
  readonly greenPinSha: string;
  readonly currentPinCapturedAtMs: number;
}

export interface PilotCohortMaterializedReceipt {
  readonly kind: 'pilot-cohort-materialized';
  readonly receiptId: string;
  readonly workspaceId: string;
  readonly harnessSlug: string;
  readonly seed: string;
  readonly actor: string;
  readonly materializedAtMs: number;
  readonly ids: readonly string[];
  readonly preimages: readonly PilotMaterializationRow[];
  readonly applied: readonly PilotMaterializationPatch[];
  readonly armBProof: PilotArmBProofReceipt;
}

export interface PilotCohortAbortReceipt {
  readonly kind: 'pilot-cohort-abort';
  readonly receiptId: string;
  readonly workspaceId: string;
  readonly harnessSlug: string;
  readonly seed: string;
  readonly actor: string;
  readonly abortedAtMs: number;
  readonly reason: string;
  readonly ids: readonly string[];
  readonly touchedIds: readonly string[];
  readonly preimages: readonly PilotMaterializationRow[];
  readonly observedAfterRollback: readonly PilotMaterializationRow[];
  readonly rollbackVerified: boolean;
  readonly rollbackMismatches: readonly string[];
  readonly auditPersisted: boolean;
}

export type MaterializePilotCohortResult =
  | { readonly ok: true; readonly receipt: PilotCohortMaterializedReceipt }
  | { readonly ok: false; readonly receipt: PilotCohortAbortReceipt };

export interface PilotMaterializationDependencies {
  readonly store: PilotMaterializationStore;
  readonly receiptAuthority: CanonicalParticipantReceiptAuthority;
  readonly loadCurrentReleasePin?: () => Promise<CurrentReleasePin>;
  /** Test seam for proving a failure after UPDATE still rolls the whole cohort back. */
  readonly afterApply?: (rows: readonly PilotMaterializationRow[]) => void | Promise<void>;
  readonly now?: () => number;
}

export interface PilotMaterializationAuditInput {
  readonly actor: string;
  readonly workspaceId: string;
  readonly action: 'pilot.materialize' | 'pilot.materialize.abort';
  readonly subject: string;
  readonly atMs: number;
  readonly details: PilotCohortMaterializedReceipt | Omit<PilotCohortAbortReceipt, 'auditPersisted'>;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function exactIso(value: unknown): string | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function canonicalSha(value: unknown): string | null {
  return typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value) ? value.toLowerCase() : null;
}

function cloneRow(row: PilotMaterializationRow): PilotMaterializationRow {
  return {
    ...row,
    payload: JSON.parse(JSON.stringify(row.payload)) as Record<string, unknown>,
  };
}

function rowFingerprint(row: PilotMaterializationRow): string {
  return JSON.stringify([row.id, row.status, row.kind, row.updatedTs, row.assignee, row.takenAt, row.payload]);
}

function hasPilotStamp(payload: Readonly<Record<string, unknown>>): boolean {
  return PILOT_MATERIALIZATION_KEYS.some((key) => Object.hasOwn(payload, key));
}

function assertFrozenInput(input: MaterializePilotCohortInput): void {
  if (input.candidates.length !== PILOT_MATERIALIZATION_COHORT_SIZE) {
    throw new Error(
      'frozen cohort must contain exactly ' +
        PILOT_MATERIALIZATION_COHORT_SIZE +
        ' candidates; got ' +
        input.candidates.length,
    );
  }
  const ids = new Set<string>();
  for (const candidate of input.candidates) {
    if (!candidate.id || ids.has(candidate.id)) throw new Error('frozen cohort ids must be non-empty and unique');
    ids.add(candidate.id);
    if (candidate.tier !== 'substantive') {
      throw new Error('pilot candidate ' + candidate.id + ' is not substantive');
    }
    if (!Number.isSafeInteger(candidate.expectedUpdatedTs) || candidate.expectedUpdatedTs < 0) {
      throw new Error('pilot candidate ' + candidate.id + ' has an invalid expectedUpdatedTs');
    }
    if (!candidate.expectedAssignee) throw new Error('pilot candidate ' + candidate.id + ' has no frozen assignee');
    if (exactIso(candidate.expectedTakenAt) !== candidate.expectedTakenAt) {
      throw new Error('pilot candidate ' + candidate.id + ' expectedTakenAt is not an exact ISO timestamp');
    }
  }
}

function assertRowsMatchFrozen(
  rows: readonly PilotMaterializationRow[],
  candidates: readonly FrozenPilotCandidate[],
): void {
  if (rows.length !== candidates.length) {
    throw new Error('frozen cohort row count changed: expected ' + candidates.length + ', got ' + rows.length);
  }
  const rowsById = new Map(rows.map((row) => [row.id, row]));
  for (const candidate of candidates) {
    const row = rowsById.get(candidate.id);
    if (!row) throw new Error('frozen cohort row disappeared: ' + candidate.id);
    if (row.status !== 'open') throw new Error(candidate.id + ' is no longer open');
    if (row.updatedTs !== candidate.expectedUpdatedTs) throw new Error(candidate.id + ' row version changed');
    if (row.assignee !== candidate.expectedAssignee) throw new Error(candidate.id + ' frozen assignee changed');
    if (row.takenAt !== candidate.expectedTakenAt) throw new Error(candidate.id + ' claimVersion/takenAt changed');
    if (row.payload._claimHold === true || row.payload._claimHold === 'true') {
      throw new Error(candidate.id + ' is held by _claimHold');
    }
    if (hasPilotStamp(row.payload)) throw new Error(candidate.id + ' already carries a pilot stamp');
  }
}

function armBProofFrom(probe: PilotArmBProbeRow, release: CurrentReleasePin): PilotArmBProofReceipt {
  if (!ALL_SUCCESSFUL_STATUSES.has(probe.status)) {
    throw new Error('arm-B gate probe is not terminal-successful');
  }
  const proof = record(record(probe.payload.out).pilotArmBGateProbe);
  if (proof.status !== 'passed' || proof.judgementPersisted !== true) {
    throw new Error('arm-B gate probe lacks status=passed and judgementPersisted=true');
  }
  const testedSha = canonicalSha(proof.testedSha);
  const claimedDeployedSha = canonicalSha(proof.deployedSha);
  const actualDeployedSha = canonicalSha(release.deployedSha);
  const greenPinSha = canonicalSha(release.greenPinSha);
  const parity = classifyReleaseParity({
    testedSha,
    claimedDeployedSha,
    actualDeployedSha,
    greenPinSha,
  });
  if (!parity.ok || !testedSha || !claimedDeployedSha || !actualDeployedSha || !greenPinSha) {
    throw new Error('arm-B current-pin proof failed: ' + parity.summary);
  }
  return {
    probeItemId: probe.id,
    probeUpdatedTs: probe.updatedTs,
    judgementPersisted: true,
    testedSha,
    claimedDeployedSha,
    actualDeployedSha,
    greenPinSha,
    currentPinCapturedAtMs: release.capturedAtMs,
  };
}

function assertApplied(rows: readonly PilotMaterializationRow[], patches: readonly PilotMaterializationPatch[]): void {
  if (rows.length !== patches.length) {
    throw new Error('cohort CAS updated ' + rows.length + ' of ' + patches.length + ' rows');
  }
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const patch of patches) {
    const row = byId.get(patch.id);
    if (!row) throw new Error('cohort CAS omitted ' + patch.id);
    if (row.updatedTs !== patch.nextUpdatedTs) throw new Error('cohort CAS version mismatch for ' + patch.id);
    for (const key of PILOT_MATERIALIZATION_KEYS) {
      if (JSON.stringify(row.payload[key]) !== JSON.stringify(patch.payloadPatch[key])) {
        throw new Error('cohort CAS readback mismatch for ' + patch.id + '.' + key);
      }
    }
  }
}

async function defaultCurrentReleasePin(): Promise<CurrentReleasePin> {
  const state = await devDeployState({ useSpawnerSidecar: false });
  return {
    deployedSha: state.deployed?.sha ?? null,
    greenPinSha: state.greenPin?.sha ?? null,
    capturedAtMs: Date.now(),
  };
}

function rollbackComparison(
  preimages: readonly PilotMaterializationRow[],
  observed: readonly PilotMaterializationRow[],
  touchedIds: ReadonlySet<string>,
): { verified: boolean; mismatches: string[] } {
  if (touchedIds.size === 0) return { verified: true, mismatches: [] };
  const before = new Map(preimages.map((row) => [row.id, row]));
  const after = new Map(observed.map((row) => [row.id, row]));
  const mismatches: string[] = [];
  for (const id of touchedIds) {
    const left = before.get(id);
    const right = after.get(id);
    if (!left || !right || rowFingerprint(left) !== rowFingerprint(right)) mismatches.push(id);
  }
  return { verified: mismatches.length === 0, mismatches };
}

export async function materializePilotCohort(
  input: MaterializePilotCohortInput,
  deps: PilotMaterializationDependencies,
): Promise<MaterializePilotCohortResult> {
  const now = deps.now ?? Date.now;
  const scope: PilotMaterializationScope = {
    workspaceId: input.workspaceId,
    harnessSlug: input.harnessSlug,
    dependencyWorkspaceId: input.dependencyWorkspaceId ?? 'default',
  };
  const ids = input.candidates.map((candidate) => candidate.id);
  let preimages: PilotMaterializationRow[] = [];
  const touchedIds = new Set<string>();

  try {
    assertFrozenInput(input);
    return await deps.store.transaction(async (tx) => {
      const locked = await tx.lockRows(scope, ids);
      preimages = locked.map(cloneRow);
      assertRowsMatchFrozen(locked, input.candidates);

      const blockers = await tx.unresolvedBlockerIds(scope, ids);
      if (blockers.length) throw new Error('frozen cohort is blocked: ' + [...new Set(blockers)].sort().join(', '));

      const receiptValidation = await deps.receiptAuthority.validate(
        input.candidates.map((candidate) => ({
          id: candidate.id,
          expectedOwnerId: candidate.expectedAssignee,
          expectedClaimVersion: candidate.expectedTakenAt,
          payload: locked.find((row) => row.id === candidate.id)?.payload,
        })),
      );
      if (!receiptValidation.ok) {
        throw new Error('canonical participant receipts failed: ' + receiptValidation.errors.join('; '));
      }
      for (const id of ids) {
        if (!receiptValidation.participantsByItem[id]?.length) {
          throw new Error('canonical participant receipts produced no participant binding for ' + id);
        }
      }

      const assignment = assignCohort(
        input.candidates.map((candidate) => ({
          id: candidate.id,
          tier: candidate.tier,
          stratum: candidate.stratum,
        })),
        input.seed,
      );
      if (assignment.assignments.length !== ids.length || assignment.skipped.length !== 0) {
        throw new Error('seeded assignment did not cover the exact frozen cohort');
      }

      const probe = await tx.readProbe(scope, input.armBProbeItemId);
      if (!probe) throw new Error('arm-B gate probe row is missing');
      // The live release read occurs after row/receipt/probe validation and immediately
      // before the cohort CAS: this is the irreversible-boundary current-pin receipt.
      const armBProof = armBProofFrom(probe, await (deps.loadCurrentReleasePin ?? defaultCurrentReleasePin)());
      const materializedAtMs = now();
      const nextUpdatedTs = Math.max(
        materializedAtMs,
        ...input.candidates.map((candidate) => candidate.expectedUpdatedTs + 1),
      );
      const assignmentById = new Map(assignment.assignments.map((entry) => [entry.id, entry]));
      const patches: PilotMaterializationPatch[] = input.candidates.map((candidate) => {
        const entry = assignmentById.get(candidate.id);
        if (!entry) throw new Error('seeded assignment omitted ' + candidate.id);
        const base = assignmentPayloadPatch(entry, input.seed);
        return {
          id: candidate.id,
          expectedUpdatedTs: candidate.expectedUpdatedTs,
          expectedAssignee: candidate.expectedAssignee,
          expectedTakenAt: candidate.expectedTakenAt,
          nextUpdatedTs,
          payloadPatch: {
            ...base,
            pilotPartialBlock: entry.partialBlock,
            pilotAssignedAtMs: materializedAtMs,
            pilotParticipants: receiptValidation.participantsByItem[candidate.id],
          },
        };
      });

      const applied = await tx.casApply(scope, patches);
      for (const row of applied) touchedIds.add(row.id);
      assertApplied(applied, patches);
      await deps.afterApply?.(applied);

      const receipt: PilotCohortMaterializedReceipt = {
        kind: 'pilot-cohort-materialized',
        receiptId: randomUUID(),
        workspaceId: input.workspaceId,
        harnessSlug: input.harnessSlug,
        seed: input.seed,
        actor: input.actor,
        materializedAtMs,
        ids: [...ids],
        preimages,
        applied: patches,
        armBProof,
      };
      await tx.appendAudit({
        actor: input.actor,
        workspaceId: input.workspaceId,
        action: 'pilot.materialize',
        subject: 'pilot-cohort:' + input.seed,
        atMs: materializedAtMs,
        details: receipt,
      });
      return { ok: true, receipt };
    });
  } catch (error) {
    const observed = preimages.length ? await deps.store.readRows(scope, ids).catch(() => []) : [];
    const rollback = rollbackComparison(preimages, observed, touchedIds);
    const baseReceipt: Omit<PilotCohortAbortReceipt, 'auditPersisted'> = {
      kind: 'pilot-cohort-abort',
      receiptId: randomUUID(),
      workspaceId: input.workspaceId,
      harnessSlug: input.harnessSlug,
      seed: input.seed,
      actor: input.actor,
      abortedAtMs: now(),
      reason: error instanceof Error ? error.message : String(error),
      ids: [...ids],
      touchedIds: [...touchedIds].sort(),
      preimages,
      observedAfterRollback: observed,
      rollbackVerified: rollback.verified,
      rollbackMismatches: rollback.mismatches,
    };
    let auditPersisted = false;
    try {
      await deps.store.appendAbortAudit({
        actor: input.actor,
        workspaceId: input.workspaceId,
        action: 'pilot.materialize.abort',
        subject: 'pilot-cohort:' + input.seed,
        atMs: baseReceipt.abortedAtMs,
        details: baseReceipt,
      });
      auditPersisted = true;
    } catch {
      // The returned receipt stays explicit when even the separate abort audit cannot persist.
    }
    return { ok: false, receipt: { ...baseReceipt, auditPersisted } };
  }
}

type OrgSql = Parameters<Parameters<typeof boundedOrgTxn>[0]>[0];

interface PgWorkItemRow {
  feature_id: string;
  status: string;
  kind: string | null;
  updated_ts: number | string;
  taken_by: string | null;
  taken_at: Date | string | null;
  payload: Record<string, unknown> | null;
}

function fromPgRow(row: PgWorkItemRow): PilotMaterializationRow {
  return {
    id: row.feature_id,
    status: row.status,
    kind: row.kind,
    updatedTs: Number(row.updated_ts),
    assignee: row.taken_by,
    takenAt: exactIso(row.taken_at),
    payload: record(row.payload),
  };
}

const SELECT_ROWS_SQL =
  "SELECT feature_id, status, kind, updated_ts, taken_by, taken_at, COALESCE(payload, '{}'::jsonb) AS payload " +
  'FROM harness_shared.work_items WHERE workspace_id = $1 AND harness_slug = $2 ' +
  'AND feature_id = ANY($3::text[]) ORDER BY feature_id';

/**
 * "Is this dep's BLOCKER still unsatisfied?" — the blocker-side half of the dependency floor.
 *
 * WI-524909 / WI-521425. Match by SPLITTING the dep-side scalar, never by CONCATENATING the
 * candidate side. The previous form here was
 *   bf.harness_slug || '#' || bf.feature_id = d.blocker_ref
 * which no index can serve: EXPLAIN demoted the probe to an Index Scan whose ONLY Index Cond
 * was workspace_id (~510k rows in harness_features_consolidated), leaving the real selectivity
 * as a post-scan Filter — cost 40,840 and ~592ms PER PROBE. ORed with the issue-family EXISTS
 * it also defeated PostgreSQL's hashed-subplan plan. Splitting instead lets that table's
 * PRIMARY KEY (harness_slug, feature_id) serve the probe.
 *
 * EQUIVALENT: the concatenation is harness_slug + '#' + feature_id and no harness_slug contains
 * '#', so the FIRST '#' is always the separator and splitting exactly inverts the concat. The
 * position() guard keeps the no-'#' case matching nothing, exactly as the concat form did (its
 * output always contains a '#', so it could never equal a ref without one). That invariant is
 * pinned by blocker-ref-join-indexable.test.ts.
 *
 * ONE constant, used by BOTH queries below, deliberately: this predicate previously existed as
 * two byte-identical copies, which is how one of them kept the slow form after the other was
 * fixed. Note this covers only the BLOCKER side — the BLOCKED-side ref form stays per-family
 * (bare for issues, harness-qualified for features) and must NOT be unified, which would
 * over-gate the feature family (D-007's retraction).
 */
const UNSATISFIED_BLOCKER_EXISTS_SQL =
  'EXISTS (SELECT 1 FROM harness_shared.harness_features_consolidated bf ' +
  "WHERE d.blocker_kind = 'feature' AND bf.workspace_id = wi.workspace_id " +
  "AND position('#' in d.blocker_ref) > 0 " +
  "AND bf.harness_slug = split_part(d.blocker_ref, '#', 1) " +
  "AND bf.feature_id = substring(d.blocker_ref from position('#' in d.blocker_ref) + 1) " +
  "AND bf.status NOT IN ('passed','deprecated','done','dropped')) OR " +
  'EXISTS (SELECT 1 FROM harness_shared.engineer_issues bi ' +
  "WHERE d.blocker_kind = 'issue' AND bi.workspace_id = wi.workspace_id " +
  "AND bi.issue_id = d.blocker_ref AND bi.state NOT IN ('resolved','closed','done','dropped'))";

class PgPilotMaterializationTransaction implements PilotMaterializationTransaction {
  constructor(private readonly sql: OrgSql) {}

  async lockRows(
    scope: PilotMaterializationScope,
    ids: readonly string[],
  ): Promise<readonly PilotMaterializationRow[]> {
    const rows = (await this.sql.unsafe(SELECT_ROWS_SQL + ' FOR UPDATE', [
      scope.workspaceId,
      scope.harnessSlug,
      [...ids],
    ])) as unknown as PgWorkItemRow[];
    return rows.map(fromPgRow);
  }

  async unresolvedBlockerIds(scope: PilotMaterializationScope, ids: readonly string[]): Promise<readonly string[]> {
    const rows = (await this.sql.unsafe(
      'SELECT DISTINCT wi.feature_id FROM harness_shared.work_items wi ' +
        "JOIN harness_shared.work_item_deps d ON d.workspace_id = $4 AND d.dep_type = 'blocks' " +
        "AND (d.blocked_ref = wi.feature_id OR d.blocked_ref = wi.harness_slug || '#' || wi.feature_id) " +
        'WHERE wi.workspace_id = $1 AND wi.harness_slug = $2 AND wi.feature_id = ANY($3::text[]) AND (' +
        UNSATISFIED_BLOCKER_EXISTS_SQL +
        ') ORDER BY wi.feature_id',
      [scope.workspaceId, scope.harnessSlug, [...ids], scope.dependencyWorkspaceId],
    )) as unknown as Array<{ feature_id: string }>;
    return rows.map((row) => row.feature_id);
  }

  async readProbe(scope: PilotMaterializationScope, id: string): Promise<PilotArmBProbeRow | null> {
    const rows = (await this.sql.unsafe(
      "SELECT feature_id, status, updated_ts, COALESCE(payload, '{}'::jsonb) AS payload " +
        'FROM harness_shared.work_items WHERE workspace_id = $1 AND harness_slug = $2 AND feature_id = $3 FOR SHARE',
      [scope.workspaceId, scope.harnessSlug, id],
    )) as unknown as Array<{
      feature_id: string;
      status: string;
      updated_ts: number | string;
      payload: Record<string, unknown>;
    }>;
    const row = rows[0];
    return row
      ? { id: row.feature_id, status: row.status, updatedTs: Number(row.updated_ts), payload: record(row.payload) }
      : null;
  }

  async casApply(
    scope: PilotMaterializationScope,
    patches: readonly PilotMaterializationPatch[],
  ): Promise<readonly PilotMaterializationRow[]> {
    const expectedJson = JSON.stringify(
      patches.map((patch) => ({
        id: patch.id,
        expected_updated_ts: patch.expectedUpdatedTs,
        expected_assignee: patch.expectedAssignee,
        expected_taken_at: patch.expectedTakenAt,
        next_updated_ts: patch.nextUpdatedTs,
        patch: patch.payloadPatch,
      })),
    );
    const rows = (await this.sql.unsafe(
      'WITH expected AS MATERIALIZED (' +
        'SELECT * FROM jsonb_to_recordset($5::text::jsonb) AS e(' +
        'id text, expected_updated_ts bigint, expected_assignee text, expected_taken_at timestamptz, ' +
        'next_updated_ts bigint, patch jsonb)), eligible AS MATERIALIZED (' +
        'SELECT wi.feature_id FROM harness_shared.work_items wi JOIN expected e ON e.id = wi.feature_id ' +
        "WHERE wi.workspace_id = $1 AND wi.harness_slug = $2 AND wi.status = 'open' " +
        'AND wi.updated_ts = e.expected_updated_ts AND wi.taken_by = e.expected_assignee ' +
        "AND wi.taken_at = e.expected_taken_at AND COALESCE(wi.payload, '{}'::jsonb)->>'_claimHold' IS DISTINCT FROM 'true' " +
        "AND NOT (COALESCE(wi.payload, '{}'::jsonb) ?| $6::text[]) AND NOT EXISTS (" +
        "SELECT 1 FROM harness_shared.work_item_deps d WHERE d.workspace_id = $3 AND d.dep_type = 'blocks' " +
        "AND (d.blocked_ref = wi.feature_id OR d.blocked_ref = wi.harness_slug || '#' || wi.feature_id) AND (" +
        UNSATISFIED_BLOCKER_EXISTS_SQL +
        ')) FOR UPDATE), cohort_gate AS MATERIALIZED (SELECT count(*)::int AS n FROM eligible), updated AS (' +
        "UPDATE harness_shared.work_items wi SET payload = COALESCE(wi.payload, '{}'::jsonb) || e.patch, " +
        'updated_ts = e.next_updated_ts FROM expected e, eligible el, cohort_gate g ' +
        'WHERE wi.workspace_id = $1 AND wi.harness_slug = $2 AND wi.feature_id = e.id ' +
        'AND el.feature_id = wi.feature_id AND g.n = $4 RETURNING wi.feature_id, wi.status, wi.kind, ' +
        'wi.updated_ts, wi.taken_by, wi.taken_at, wi.payload) SELECT * FROM updated ORDER BY feature_id',
      [
        scope.workspaceId,
        scope.harnessSlug,
        scope.dependencyWorkspaceId,
        patches.length,
        expectedJson,
        [...PILOT_MATERIALIZATION_KEYS],
      ],
    )) as unknown as PgWorkItemRow[];
    return rows.map(fromPgRow);
  }

  async appendAudit(input: PilotMaterializationAuditInput): Promise<void> {
    await this.sql.unsafe(
      'INSERT INTO harness_shared.audit_log (id, ts, actor, action, subject, details, workspace_id) ' +
        'VALUES ($1,$2,$3,$4,$5,$6::text::jsonb,$7)',
      [
        randomUUID(),
        input.atMs,
        input.actor,
        input.action,
        input.subject,
        JSON.stringify(input.details),
        input.workspaceId,
      ],
    );
  }
}

/**
 * Production PG adapter. Cohort stamps and the success audit share one bounded
 * transaction. Abort verification/audit run only after that transaction has rolled back.
 */
export function createPgPilotMaterializationStore(): PilotMaterializationStore {
  const readRows = async (
    scope: PilotMaterializationScope,
    ids: readonly string[],
  ): Promise<readonly PilotMaterializationRow[]> =>
    boundedOrgTxn(async (sql) => {
      const rows = (await sql.unsafe(SELECT_ROWS_SQL, [
        scope.workspaceId,
        scope.harnessSlug,
        [...ids],
      ])) as unknown as PgWorkItemRow[];
      return rows.map(fromPgRow);
    });

  return {
    transaction: (fn) => boundedOrgTxn(async (sql) => fn(new PgPilotMaterializationTransaction(sql))),
    readRows,
    appendAbortAudit: (input) =>
      boundedOrgTxn(async (sql) => {
        await new PgPilotMaterializationTransaction(sql).appendAudit(input);
      }),
  };
}
