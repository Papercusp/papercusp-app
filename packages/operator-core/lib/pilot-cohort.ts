/**
 * Production runtime for the directed-pair three-arm pilot
 * (`directed-pair-work-items-2026-08-25`, P-007 / D-023 / D-027).
 *
 * P-006 deliberately shipped the pure assignment/statistics instruments first and
 * deferred the database collector until P-007. This module is that missing seam. It
 * reuses the canonical work-item, scorecard, session and usage ledgers; it creates no
 * parallel experiment store.
 */
import { getOrgPg } from '@papercusp/db-org';
import {
  asPilotArm,
  assignCohort,
  type AssignmentPlan,
  type PilotArm,
  type PilotCandidate,
  type PilotTier,
  verifyAssignments,
} from './pilot-arm-assignment.js';
import { buildPilotReport, type ArmObservation, type PilotReport } from './pilot-metrics.js';
import { listScorecards, type ListScorecardsFilter, type ScorecardRow } from './scorecards.js';
import { getWorkItem, TERMINAL_WORK_ITEM_STATES, type WorkItem } from './work-items.js';
import { ALL_SUCCESSFUL_STATUSES } from './work-item-blocking.js';
import {
  materializePilotCohort as materializePilotCohortAtomic,
  createPgPilotMaterializationStore,
  type FrozenPilotCandidate,
  type MaterializePilotCohortResult as AtomicMaterializePilotCohortResult,
  type PilotMaterializationDependencies,
} from './pilot-materialization-core.js';
import {
  readPilotParticipantReceiptStore,
  validatePilotParticipantReceiptCohort,
  type CanonicalPilotParticipant,
  type PilotParticipantRole,
} from './pilot-participant-receipts.js';
import {
  derivePilotReceiptCostWindows,
  validatePilotGradeBindings,
  validatePilotGradeReceipt,
  type PilotCollectionGuardGapCode,
  type PilotGradeBinding,
} from './pilot-collection-guards.js';
import {
  buildPilotFanInPlan,
  validatePilotComposedFanInReceipts,
  validatePilotExactCompletionReceipts,
  type PilotComposedAwaitReceipt,
  type PilotExactCompletionAwaitReceipt,
  type PilotFanInPlan,
  type PilotFanInReceiptGapCode,
} from './pilot-fan-in-guards.js';

export const DEFAULT_PILOT_RUBRIC = 'directed-pair-pilot-item-quality';
export const DEFAULT_ARM_B_PROBE_ITEM = 'WI-41764';

export type { PilotParticipantRole } from './pilot-participant-receipts.js';

/** Canonical P-017 identity stored in the pilot stamp; callers never author it. */
export type PilotParticipantBinding = CanonicalPilotParticipant;

export interface PilotAssignmentCandidate {
  id: string;
  tier: PilotTier;
  stratum?: string;
  /** Required only at confirm: exact frozen work-item row version (updated_ts). */
  expectedUpdatedTs?: number;
  /** Required only at confirm: exact run-owned claim holder. */
  expectedAssignee?: string;
  /** Required only at confirm: exact taken_at ISO / P-017 claimVersion. */
  expectedTakenAt?: string;
}

export interface PilotStamp {
  arm: PilotArm;
  seed: string;
  stratum: string;
  blockIndex: number;
  partialBlock: boolean;
  assignedAtMs: number;
  participants: readonly PilotParticipantBinding[];
}

export const PILOT_STAMP_KEYS = [
  'pilotArm',
  'pilotSeed',
  'pilotStratum',
  'pilotBlockIndex',
  'pilotPartialBlock',
  'pilotAssignedAtMs',
  'pilotParticipants',
] as const;

export interface ArmBGateProbeProof {
  status: 'passed';
  testedSha: string;
  deployedSha: string;
  judgementPersisted: true;
}

export interface PilotGap {
  itemId: string;
  code:
    | 'missing-item'
    | 'not-terminal'
    | 'missing-stamp'
    | 'invalid-participants'
    | 'invalid-window'
    | 'missing-scorecard'
    | 'non-independent-scorecard'
    | 'incomplete-scorecard'
    | 'missing-cost'
    | 'mixed-seed'
    | 'assignment-mismatch'
    | 'missing-grade-card-receipt'
    | 'duplicate-grade-card-receipt'
    | 'participant-stamp-mismatch'
    | 'invalid-fan-in-route'
    | PilotCollectionGuardGapCode
    | PilotFanInReceiptGapCode;
  detail: string;
}

export interface ParticipantCost {
  key: string;
  sampleCount: number;
  unpricedCount: number;
  costUsd: number | null;
}

export interface PilotCollectedItem {
  itemId: string;
  arm: PilotArm;
  scorecardId: string;
  grader: string;
  participantCosts: readonly ParticipantCost[];
  observation: ArmObservation;
}

export interface PilotCollectionResult {
  ok: true;
  complete: boolean;
  rubricRef: string;
  itemCount: number;
  observationCount: number;
  assignmentVerification: {
    seed: string | null;
    ok: boolean;
    mismatches: readonly { id: string; recorded: string; expected: PilotArm }[];
    unverifiable: readonly string[];
  };
  items: PilotCollectedItem[];
  observations: ArmObservation[];
  gaps: PilotGap[];
  fanInPlan: PilotFanInPlan | null;
  report: PilotReport;
}

export type PilotCohortDeps = {
  getWorkItem: typeof getWorkItem;
  listScorecards: (filter: ListScorecardsFilter) => Promise<ScorecardRow[]>;
  readUsageCosts: (workspaceId: string, windows: readonly UsageWindow[]) => Promise<Map<string, ParticipantCost>>;
};

const DEFAULT_DEPS: PilotCohortDeps = {
  getWorkItem,
  listScorecards,
  readUsageCosts: readPilotUsageCosts,
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function finiteNumber(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(n) ? n : null;
}

function readParticipants(value: unknown): PilotParticipantBinding[] | null {
  if (!Array.isArray(value)) return null;
  const out: PilotParticipantBinding[] = [];
  for (const entry of value) {
    const row = record(entry);
    const ownerId = typeof row?.ownerId === 'string' ? row.ownerId.trim() : '';
    const sessionId = typeof row?.sessionId === 'string' ? row.sessionId.trim() : '';
    const role = row?.role;
    const bindingReceiptId = typeof row?.bindingReceiptId === 'string' ? row.bindingReceiptId.trim() : '';
    const dispatchReceiptId = typeof row?.dispatchReceiptId === 'string' ? row.dispatchReceiptId.trim() : '';
    if (
      !ownerId ||
      !sessionId ||
      (role !== 'solo' && role !== 'director' && role !== 'implementer') ||
      !bindingReceiptId ||
      !dispatchReceiptId
    ) {
      return null;
    }
    out.push({ ownerId, sessionId, role, bindingReceiptId, dispatchReceiptId });
  }
  return out;
}

export function readPilotStamp(payload: unknown): PilotStamp | null {
  const p = record(payload);
  if (!p) return null;
  const arm = asPilotArm(typeof p.pilotArm === 'string' ? p.pilotArm : undefined);
  const seed = typeof p.pilotSeed === 'string' ? p.pilotSeed.trim() : '';
  const stratum = typeof p.pilotStratum === 'string' ? p.pilotStratum.trim() : '';
  const blockIndex = finiteNumber(p.pilotBlockIndex);
  const assignedAtMs = finiteNumber(p.pilotAssignedAtMs);
  const participants = readParticipants(p.pilotParticipants);
  if (
    !arm ||
    !seed ||
    !stratum ||
    blockIndex === null ||
    blockIndex < 0 ||
    !Number.isInteger(blockIndex) ||
    assignedAtMs === null ||
    assignedAtMs <= 0 ||
    participants === null
  ) {
    return null;
  }
  return {
    arm,
    seed,
    stratum,
    blockIndex,
    partialBlock: p.pilotPartialBlock === true,
    assignedAtMs,
    participants,
  };
}

function terminal(item: WorkItem): boolean {
  return TERMINAL_WORK_ITEM_STATES.includes(item.state);
}

/**
 * The successful terminal probe's structured output is written by work_items:complete under payload.out.
 * Requiring tested===deployed closes the stale-process loophole: a local passing test
 * against staging is not proof that the live completion verb ran the gate.
 */
export function readArmBGateProbeProof(item: WorkItem | null): ArmBGateProbeProof | null {
  if (!item || !ALL_SUCCESSFUL_STATUSES.has(item.state)) return null;
  const out = record(record(item.payload)?.out);
  const proof = record(out?.pilotArmBGateProbe);
  const testedSha = typeof proof?.testedSha === 'string' ? proof.testedSha.trim() : '';
  const deployedSha = typeof proof?.deployedSha === 'string' ? proof.deployedSha.trim() : '';
  if (proof?.status !== 'passed' || proof.judgementPersisted !== true || !testedSha || testedSha !== deployedSha) {
    return null;
  }
  return { status: 'passed', testedSha, deployedSha, judgementPersisted: true };
}

function participantsFitArm(arm: PilotArm, participants: readonly PilotParticipantBinding[]): boolean {
  if (arm === 'A' || arm === 'B') {
    return participants.length === 1 && participants[0]?.role === 'solo';
  }
  if (participants.length !== 2) return false;
  const roles = participants.map((p) => p.role).sort();
  return roles[0] === 'director' && roles[1] === 'implementer';
}

export interface MaterializePilotInput {
  workspaceId: string;
  harnessSlug: string;
  actor: string;
  seed: string;
  candidates: readonly PilotAssignmentCandidate[];
  probeItemId?: string;
  rubricRef?: string;
  confirm?: boolean;
}

export interface MaterializePilotResult {
  ok: boolean;
  committed: boolean;
  plan: AssignmentPlan;
  fanInPlan: PilotFanInPlan;
  applied: string[];
  rolledBack: string[];
  receipt?: AtomicMaterializePilotCohortResult['receipt'];
  error?: string;
}

/**
 * Preview or materialize one cohort. The write path is fail-closed on participant
 * attribution and arm-B live proof, then verifies the persisted assignment. A failed
 * multi-row write removes only the pilot keys it just added, so a cohort never remains
 * silently half-stamped.
 */
export async function materializePilotCohort(
  input: MaterializePilotInput,
  deps?: PilotMaterializationDependencies,
): Promise<MaterializePilotResult> {
  const seed = input.seed.trim();
  if (!seed) throw new Error('pilot seed must be non-empty');
  const ids = input.candidates.map((c) => c.id);
  if (new Set(ids).size !== ids.length) throw new Error('pilot candidates contain duplicate ids');
  const candidates: PilotCandidate[] = input.candidates.map((candidate) => ({
    id: candidate.id,
    tier: candidate.tier,
    ...(candidate.stratum ? { stratum: candidate.stratum } : {}),
  }));
  const plan = assignCohort(candidates, seed);
  const fanInPlan = buildPilotFanInPlan({ itemIds: ids, rubricRef: input.rubricRef ?? DEFAULT_PILOT_RUBRIC });
  if (!input.confirm) return { ok: true, committed: false, plan, fanInPlan, applied: [], rolledBack: [] };

  const frozen: FrozenPilotCandidate[] = input.candidates.map((candidate) => {
    if (
      candidate.expectedUpdatedTs === undefined ||
      candidate.expectedAssignee === undefined ||
      candidate.expectedTakenAt === undefined
    ) {
      throw new Error(`${candidate.id} confirm requires expectedUpdatedTs, expectedAssignee, and expectedTakenAt`);
    }
    return {
      id: candidate.id,
      tier: candidate.tier,
      ...(candidate.stratum ? { stratum: candidate.stratum } : {}),
      expectedUpdatedTs: candidate.expectedUpdatedTs,
      expectedAssignee: candidate.expectedAssignee,
      expectedTakenAt: candidate.expectedTakenAt,
    };
  });
  const result = await materializePilotCohortAtomic(
    {
      workspaceId: input.workspaceId,
      harnessSlug: input.harnessSlug,
      actor: input.actor,
      seed,
      armBProbeItemId: input.probeItemId ?? DEFAULT_ARM_B_PROBE_ITEM,
      candidates: frozen,
    },
    deps ?? {
      store: createPgPilotMaterializationStore(),
      receiptAuthority: { validate: validatePilotParticipantReceiptCohort },
    },
  );
  return result.ok
    ? {
        ok: true,
        committed: true,
        plan,
        fanInPlan,
        applied: result.receipt.applied.map((entry) => entry.id),
        rolledBack: [],
        receipt: result.receipt,
      }
    : {
        ok: false,
        committed: false,
        plan,
        fanInPlan,
        applied: [...result.receipt.touchedIds],
        rolledBack: result.receipt.rollbackVerified ? [...result.receipt.touchedIds] : [],
        receipt: result.receipt,
        error: result.receipt.reason,
      };
}

export interface UsageWindow {
  key: string;
  sessionId: string;
  startMs: number;
  endMs: number;
}

/** One indexed query for every participant window; no N-per-item usage reads. */
export async function readPilotUsageCosts(
  workspaceId: string,
  windows: readonly UsageWindow[],
): Promise<Map<string, ParticipantCost>> {
  if (!windows.length) return new Map();
  const { sql } = getOrgPg();
  const encoded = JSON.stringify(
    windows.map((window) => ({
      key: window.key,
      session_id: window.sessionId,
      start_ms: window.startMs,
      end_ms: window.endMs,
    })),
  );
  const rows = await sql<
    Array<{
      key: string;
      sample_count: number | string;
      unpriced_count: number | string;
      cost_usd: number | string;
    }>
  >`
    WITH windows AS (
      SELECT *
        FROM jsonb_to_recordset(${encoded}::text::jsonb)
          AS w(key text, session_id text, start_ms bigint, end_ms bigint)
    )
    SELECT w.key,
           COUNT(u.id)::int AS sample_count,
           COUNT(*) FILTER (WHERE u.id IS NOT NULL AND u.cost_usd IS NULL)::int AS unpriced_count,
           COALESCE(SUM(u.cost_usd), 0)::float8 AS cost_usd
      FROM windows w
      LEFT JOIN harness_shared.agent_usage_samples u
        ON u.workspace_id = ${workspaceId}
       AND u.session_id = w.session_id
       AND u.ts >= w.start_ms
       AND u.ts <= w.end_ms
     GROUP BY w.key`;

  return new Map(
    rows.map((row) => {
      const sampleCount = Number(row.sample_count);
      const unpricedCount = Number(row.unpriced_count);
      const cost = Number(row.cost_usd);
      return [
        row.key,
        {
          key: row.key,
          sampleCount,
          unpricedCount,
          costUsd: sampleCount > 0 && unpricedCount === 0 && Number.isFinite(cost) ? cost : null,
        },
      ];
    }),
  );
}

function reopenAfter(payload: unknown, startMs: number): boolean {
  const entries = record(payload)?.reopenHistory;
  if (!Array.isArray(entries)) return false;
  return entries.some((entry) => {
    const at = record(entry)?.at;
    const atMs = typeof at === 'string' ? Date.parse(at) : Number.NaN;
    return Number.isFinite(atMs) && atMs >= startMs;
  });
}

export interface PilotGradeCardReceiptInput {
  itemId: string;
  cardId: string;
}

export interface CollectPilotCohortInput {
  workspaceId: string;
  itemIds: readonly string[];
  harness?: string;
  rubricRef?: string;
  operatorOwnerId: string;
  runbookAuthorOwnerId: string;
  gradeBindings: readonly PilotGradeBinding[];
  gradeCardReceipts: readonly PilotGradeCardReceiptInput[];
  completionExactReceipts?: readonly PilotExactCompletionAwaitReceipt[];
  completionComposedReceipts?: readonly PilotComposedAwaitReceipt[];
  gradingComposedReceipts: readonly PilotComposedAwaitReceipt[];
}

function canonicalParticipants(value: readonly PilotParticipantBinding[]): string {
  return JSON.stringify(
    [...value]
      .map((participant) => ({ ...participant }))
      .sort((a, b) => a.bindingReceiptId.localeCompare(b.bindingReceiptId)),
  );
}

function guardGap(itemId: string, code: PilotGap['code'], detail: string): PilotGap {
  return { itemId, code, detail };
}

export async function collectPilotCohort(
  input: CollectPilotCohortInput,
  deps: PilotCohortDeps = DEFAULT_DEPS,
): Promise<PilotCollectionResult> {
  const rubricRef = input.rubricRef ?? DEFAULT_PILOT_RUBRIC;
  const ids = [...new Set(input.itemIds)];
  const gaps: PilotGap[] = [];
  let fanInPlan: PilotFanInPlan | null = null;
  try {
    fanInPlan = buildPilotFanInPlan({ itemIds: ids, rubricRef });
  } catch (error) {
    gaps.push(guardGap('*', 'invalid-cohort', error instanceof Error ? error.message : String(error)));
  }

  if (fanInPlan) {
    const hasExact = (input.completionExactReceipts?.length ?? 0) > 0;
    const hasComposed = (input.completionComposedReceipts?.length ?? 0) > 0;
    if (hasExact === hasComposed) {
      gaps.push(
        guardGap(
          '*',
          'invalid-fan-in-route',
          'supply exactly one completion registration route: 21 exact receipts OR composed 20+1 receipts',
        ),
      );
    } else {
      const completionValidation = hasExact
        ? validatePilotExactCompletionReceipts(fanInPlan, input.completionExactReceipts ?? [])
        : validatePilotComposedFanInReceipts(fanInPlan.completionRoots, input.completionComposedReceipts ?? []);
      for (const gap of completionValidation.gaps) {
        gaps.push(guardGap(gap.itemId ?? '*', gap.code, gap.detail));
      }
    }
    const gradingValidation = validatePilotComposedFanInReceipts(fanInPlan.gradingRoots, input.gradingComposedReceipts);
    for (const gap of gradingValidation.gaps) {
      gaps.push(guardGap(gap.itemId ?? '*', gap.code, gap.detail));
    }
  }

  const rows = await Promise.all(ids.map((id) => deps.getWorkItem(id, input.harness)));
  const valid: Array<{
    item: WorkItem;
    stamp: PilotStamp;
    closedAtMs: number;
    receiptStore: ReturnType<typeof readPilotParticipantReceiptStore>;
  }> = [];

  for (let i = 0; i < ids.length; i++) {
    const item = rows[i];
    if (!item) {
      gaps.push({ itemId: ids[i]!, code: 'missing-item', detail: 'work item was not found' });
      continue;
    }
    if (!terminal(item) || !item.closedAt) {
      gaps.push({ itemId: item.id, code: 'not-terminal', detail: `state=${item.state}; closedAt is required` });
      continue;
    }
    const stamp = readPilotStamp(item.payload);
    if (!stamp) {
      gaps.push({
        itemId: item.id,
        code: 'missing-stamp',
        detail: 'pilot assignment/participant stamp is absent or malformed',
      });
      continue;
    }
    if (!participantsFitArm(stamp.arm, stamp.participants)) {
      gaps.push({
        itemId: item.id,
        code: 'invalid-participants',
        detail: `participant roles do not fit arm ${stamp.arm}`,
      });
      continue;
    }
    const closedAtMs = Date.parse(item.closedAt);
    if (!Number.isFinite(closedAtMs) || closedAtMs <= 0) {
      gaps.push({
        itemId: item.id,
        code: 'invalid-window',
        detail: 'canonical closedAt is absent or invalid',
      });
      continue;
    }
    valid.push({ item, stamp, closedAtMs, receiptStore: readPilotParticipantReceiptStore(item.payload) });
  }

  const receiptCandidates = valid.map(({ item, stamp, receiptStore }) => {
    const expectedOwnerId = item.assignee ?? stamp.participants[0]?.ownerId ?? '';
    const expectedBinding = receiptStore.pilotBindingReceipts.find(
      (binding) => binding.itemId === item.id && binding.ownerId === expectedOwnerId,
    );
    return {
      id: item.id,
      expectedOwnerId,
      expectedClaimVersion: item.takenAt ?? expectedBinding?.claimVersion ?? '',
      payload: item.payload,
    };
  });
  const receiptCohort = validatePilotParticipantReceiptCohort(receiptCandidates);
  for (const error of receiptCohort.errors) {
    const [possibleItemId] = error.split(':', 1);
    gaps.push(guardGap(ids.includes(possibleItemId ?? '') ? possibleItemId! : '*', 'invalid-participants', error));
  }
  for (const { item, stamp } of valid) {
    const canonical = receiptCohort.participantsByItem[item.id] ?? [];
    if (canonicalParticipants(stamp.participants) !== canonicalParticipants(canonical)) {
      gaps.push(
        guardGap(
          item.id,
          'participant-stamp-mismatch',
          'pilotParticipants does not exactly match the canonical binding/dispatch receipt projection',
        ),
      );
    }
  }

  const participantOwnerIds = valid.flatMap(({ stamp }) =>
    stamp.participants.map((participant) => participant.ownerId),
  );
  const gradeBindingValidation = validatePilotGradeBindings({
    itemIds: ids,
    bindings: input.gradeBindings,
    participantOwnerIds,
    operatorOwnerId: input.operatorOwnerId,
    runbookAuthorOwnerId: input.runbookAuthorOwnerId,
  });
  for (const gap of gradeBindingValidation.gaps) gaps.push(guardGap(gap.itemId, gap.code, gap.detail));

  const sinceMs = valid.length ? Math.min(...valid.map((v) => v.closedAtMs)) : null;
  const cards = await deps.listScorecards({
    rubricRef,
    ...(sinceMs !== null ? { since: new Date(sinceMs).toISOString() } : {}),
    limit: 500,
  });
  const cardsByItem = new Map<string, ScorecardRow[]>();
  for (const card of cards) {
    const ref = card.subject?.ref;
    if (!ref) continue;
    const bucket = cardsByItem.get(ref);
    if (bucket) bucket.push(card);
    else cardsByItem.set(ref, [card]);
  }

  const receiptWindowsByItem = new Map<string, ReturnType<typeof derivePilotReceiptCostWindows>['windows']>();
  const windows: UsageWindow[] = [];
  for (const { item, stamp, closedAtMs, receiptStore } of valid) {
    const derived = derivePilotReceiptCostWindows({
      itemId: item.id,
      arm: stamp.arm,
      closedAtMs,
      bindings: receiptStore.pilotBindingReceipts,
      dispatches: receiptStore.pilotDispatchReceipts,
    });
    for (const gap of derived.gaps) gaps.push(guardGap(gap.itemId, gap.code, gap.detail));
    receiptWindowsByItem.set(item.id, derived.windows);
    windows.push(
      ...derived.windows.map((window) => ({
        key: window.key,
        sessionId: window.sessionId,
        startMs: window.startMs,
        endMs: window.endMs,
      })),
    );
  }
  const costs = await deps.readUsageCosts(input.workspaceId, windows);
  const items: PilotCollectedItem[] = [];

  for (const { item, stamp, closedAtMs } of valid) {
    const binding = gradeBindingValidation.accepted.find((candidate) => candidate.itemId === item.id);
    if (!binding) continue;
    const cardReceipts = input.gradeCardReceipts.filter((receipt) => receipt.itemId === item.id);
    if (cardReceipts.length === 0) {
      gaps.push(guardGap(item.id, 'missing-grade-card-receipt', 'no exact scorecard writer receipt was supplied'));
      continue;
    }
    if (cardReceipts.length !== 1) {
      gaps.push(
        guardGap(item.id, 'duplicate-grade-card-receipt', `expected one writer receipt; found ${cardReceipts.length}`),
      );
      continue;
    }
    const gradeValidation = validatePilotGradeReceipt({
      binding,
      returnedCardId: cardReceipts[0]!.cardId,
      rubricRef,
      closedAtMs,
      cards: cardsByItem.get(item.id) ?? [],
    });
    for (const gap of gradeValidation.gaps) gaps.push(guardGap(gap.itemId, gap.code, gap.detail));
    if (!gradeValidation.receipt) continue;
    const card = (cardsByItem.get(item.id) ?? []).find(
      (candidate) => candidate.issueId === gradeValidation.receipt!.cardId,
    );
    if (!card || card.score10 === null) continue;

    const receiptWindows = receiptWindowsByItem.get(item.id) ?? [];
    const participantCosts = receiptWindows.map((window) => {
      const key = window.key;
      return costs.get(key) ?? { key, sampleCount: 0, unpricedCount: 0, costUsd: null };
    });
    if (participantCosts.some((cost) => cost.costUsd === null)) {
      gaps.push({
        itemId: item.id,
        code: 'missing-cost',
        detail: participantCosts
          .filter((cost) => cost.costUsd === null)
          .map((cost) => `${cost.key} samples=${cost.sampleCount} unpriced=${cost.unpricedCount}`)
          .join('; '),
      });
      continue;
    }

    const startMs = Math.min(...receiptWindows.map((window) => window.startMs));
    const observation: ArmObservation = {
      itemId: item.id,
      arm: stamp.arm,
      score: card.score10!,
      wallClockMs: closedAtMs - startMs,
      agentCostsUsd: participantCosts.map((cost) => cost.costUsd!),
      reopened: reopenAfter(item.payload, startMs),
      authorityProposed: item.completionAuthority === 'proposed',
    };
    items.push({
      itemId: item.id,
      arm: stamp.arm,
      scorecardId: card.issueId,
      grader: gradeValidation.receipt.graderOwnerId,
      participantCosts,
      observation,
    });
  }

  const seeds = new Set(valid.map((v) => v.stamp.seed));
  let assignmentVerification: PilotCollectionResult['assignmentVerification'] = {
    seed: seeds.size === 1 ? [...seeds][0]! : null,
    ok: false,
    mismatches: [],
    unverifiable: [],
  };
  if (seeds.size !== 1) {
    gaps.push({
      itemId: '*',
      code: 'mixed-seed',
      detail: `expected one seed, found ${[...seeds].join(', ') || 'none'}`,
    });
  } else {
    const seed = [...seeds][0]!;
    const verification = verifyAssignments(
      valid.map(({ item, stamp }) => ({
        id: item.id,
        tier: 'substantive',
        stratum: stamp.stratum,
        payload: item.payload,
      })),
      seed,
    );
    assignmentVerification = { seed, ...verification };
    if (!verification.ok || verification.unverifiable.length) {
      gaps.push({
        itemId: '*',
        code: 'assignment-mismatch',
        detail: `mismatches=${verification.mismatches.length}; unverifiable=${verification.unverifiable.join(',') || 'none'}`,
      });
    }
  }

  const observations = items.map((item) => item.observation);
  return {
    ok: true,
    complete: gaps.length === 0 && observations.length === ids.length,
    rubricRef,
    itemCount: ids.length,
    observationCount: observations.length,
    assignmentVerification,
    items,
    observations,
    gaps,
    fanInPlan,
    report: buildPilotReport(observations),
  };
}
