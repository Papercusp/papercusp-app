/**
 * Transfer-lesson STORE (P-022 / FB-08) — SQL over migration 250
 * (harness_shared.transfer_lessons). Helpers take an injected `Sql`
 * (learning-governor/store.ts style) so the tick glue and tests share one
 * core; SQL is covered by store.integration.test.ts, lifecycle decisions by
 * the pure gate (gate.ts).
 *
 * Timestamps are written SQL-side (`now()`) — the live db-org client rejects
 * JS Date params (agent-insights/db-org-client-rejects-js-date-params).
 */
import type { Sql } from 'postgres';
import { createHash } from 'node:crypto';
import { validateLearningContract, type LearningContract } from '../experiment/types';
import { recordProducerObservation, withProducerLifecycleWrite } from '../experiment/producer-lifecycle-store';
import { resolveLearningPotSlug } from '../learning/pot-scope';
import type { SignalOrigin } from '../harness/improvements/provenance';
import type { GateTransition } from './gate';
import type {
  TransferLesson,
  TransferSourceKind,
  TransferStatus,
  TransferTier,
  TransferReplayEvidence,
} from './types';

type Row = Record<string, unknown>;
const str = (v: unknown): string => String(v);
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const iso = (v: unknown): string => new Date(v as string | Date).toISOString();
const isoOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : iso(v));

/** Identity of the complete immutable lesson artifact, excluding lifecycle counters. */
export function transferLessonArtifactHash(lesson: TransferLesson): string {
  return createHash('sha256').update(JSON.stringify({
    id: lesson.id, signature: lesson.signature, title: lesson.title, lessonText: lesson.lessonText,
    sourceKind: lesson.sourceKind, sourceRef: lesson.sourceRef, signalOrigin: lesson.signalOrigin,
    potSlug: lesson.potSlug, workspaceId: lesson.workspaceId,
  })).digest('hex');
}

/** A scored native verdict is insufficient: bind the common decision to the
 * locked lesson, actual replay cells, execution pins and settled reservation. */
function promotionContract(
  lesson: TransferLesson,
  q: { batteryId: string; delta: number; transition: GateTransition; evaluation?: TransferReplayEvidence },
): LearningContract | null {
  const evaluation = q.evaluation;
  const contract = evaluation?.contract;
  const reservation = evaluation?.reservation;
  if (!evaluation || !contract || !reservation || !Number.isFinite(q.delta) || !validateLearningContract(contract).ok ||
      contract.decision.verdict !== 'accepted' || contract.activation ||
      evaluation.costMeasured !== true || evaluation.budgetExhausted ||
      contract.candidate.id !== lesson.id || contract.candidate.variantHash !== transferLessonArtifactHash(lesson) ||
      contract.candidate.potScope.workspaceId !== lesson.workspaceId || !lesson.potSlug ||
      contract.candidate.potScope.potId !== lesson.potSlug ||
      q.transition.status !== 'passed' || q.transition.passCount !== lesson.passCount + 1 ||
      q.transition.failCount !== lesson.failCount ||
      q.batteryId !== `transfer:${lesson.id}:t${lesson.testCount + 1}` ||
      contract.experiment.batteryId !== q.batteryId || reservation.runRef !== q.batteryId ||
      reservation.workspaceId !== lesson.workspaceId || reservation.potSlug !== lesson.potSlug ||
      reservation.status !== 'settled' || reservation.settledAt === null ||
      contract.spend.unsettledUsd !== 0 ||
      contract.spend.settledAt !== new Date(reservation.settledAt).toISOString() ||
      contract.spend.requestedUsd !== reservation.requestedUsd ||
      contract.spend.reservedUsd !== reservation.reservedUsd || contract.spend.usedUsd !== reservation.usedUsd) return null;
  for (const pin of ['batteryId', 'testId', 'baselineId', 'challengerId', 'taskHash', 'modelHash', 'promptHash', 'rubricHash', 'codeHash', 'repeats'] as const) {
    if (contract.experiment[pin] !== evaluation.experiment[pin]) return null;
  }
  const { baselineId, challengerId, repeats } = contract.experiment;
  const cells = evaluation.outcomes;
  if (cells.length !== repeats * 2 || cells.some((cell) => cell.status !== 'scored' || !cell.replayed ||
      cell.caseId !== lesson.id || !cell.runId || !Number.isInteger(cell.repeat) || cell.repeat < 0 || cell.repeat >= repeats ||
      ![baselineId, challengerId].includes(cell.variantId) ||
      ![cell.d1, cell.d2, cell.d3, cell.composite].every((v) => Number.isFinite(v) && v >= 0 && v <= 10) ||
      ![cell.runUsd, cell.judgeUsd].every((v) => Number.isFinite(v) && v >= 0)) ||
      new Set(cells.map((cell) => `${cell.variantId}:${cell.repeat}`)).size !== repeats * 2) return null;
  const refs = new Set(contract.evidence.flatMap((item) => item.artifactRefs));
  if (!refs.has(`transfer:${lesson.id}`) || !refs.has(`learning-reservation:${reservation.id}`) ||
      cells.some((cell) => !refs.has(`replay-run:${cell.runId}`)) ||
      contract.decision.evidenceIds.length !== contract.evidence.length ||
      contract.evidence.some((item) => !contract.decision.evidenceIds.includes(item.id))) return null;
  const mean = (id: string) => cells.filter((cell) => cell.variantId === id).reduce((sum, cell) => sum + cell.composite, 0) / repeats;
  const delta = mean(challengerId) - mean(baselineId);
  const cost = cells.reduce((sum, cell) => sum + cell.runUsd + cell.judgeUsd, 0);
  if (delta <= 0 || Math.abs(delta - q.delta) > 1e-9 || Math.abs(cost - reservation.usedUsd) > 1e-9) return null;
  return contract;
}

function mapLesson(r: Row): TransferLesson {
  return {
    workspaceId: str(r.workspace_id),
    id: str(r.id),
    signature: str(r.signature),
    title: strOrNull(r.title),
    lessonText: str(r.lesson_text),
    sourceKind: str(r.source_kind) as TransferSourceKind,
    sourceRef: strOrNull(r.source_ref),
    tier: str(r.tier) as TransferTier,
    status: str(r.status) as TransferStatus,
    testCount: Number(r.test_count ?? 0),
    passCount: Number(r.pass_count ?? 0),
    failCount: Number(r.fail_count ?? 0),
    lastTestedAt: isoOrNull(r.last_tested_at),
    lastBatteryId: strOrNull(r.last_battery_id),
    lastDelta: numOrNull(r.last_delta),
    memoryId: strOrNull(r.memory_id),
    packCandidateId: strOrNull(r.pack_candidate_id),
    signalOrigin: str(r.signal_origin) as SignalOrigin,
    potSlug: strOrNull(r.pot_slug),
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

export interface AdmitLessonInput {
  workspaceId: string;
  signature: string;
  title?: string | null;
  lessonText: string;
  sourceKind?: TransferSourceKind;
  sourceRef?: string | null;
  packCandidateId?: string | null;
  /** P-002 (pot-scope-all-learnings): the pot this lesson belongs to. Either pass
   *  it explicitly or pass `harnessSlug` and let the resolver find its owning pot. */
  potSlug?: string | null;
  harnessSlug?: string | null;
}

export type AdmitLessonResult =
  | { admitted: true; lesson: TransferLesson }
  | { admitted: false; reason: 'duplicate-signature'; lesson: TransferLesson | null };

/**
 * Admit one candidate lesson (tier 'probationary', D-006 free admission).
 * Idempotent per signature: a re-distilled duplicate is a no-op that returns
 * the existing row (so the tick can still link/test it).
 */
export async function admitTransferLesson(sql: Sql, q: AdmitLessonInput): Promise<AdmitLessonResult> {
  // P-002: stamp the pot at write time (null when genuinely context-less — see
  // pot-scope.ts for why a plausible-but-wrong default is worse than null).
  const potSlug = await resolveLearningPotSlug({
    workspaceId: q.workspaceId,
    potSlug: q.potSlug ?? null,
    harnessSlug: q.harnessSlug ?? null,
  });
  return withProducerLifecycleWrite(sql, async (sql) => {
  const rows = (await sql`
    INSERT INTO harness_shared.transfer_lessons
      (workspace_id, signature, title, lesson_text, source_kind, source_ref, pack_candidate_id, pot_slug)
    VALUES (${q.workspaceId}, ${q.signature}, ${q.title ?? null}, ${q.lessonText},
      ${q.sourceKind ?? 'transcript'}, ${q.sourceRef ?? null}, ${q.packCandidateId ?? null}, ${potSlug})
    ON CONFLICT ON CONSTRAINT transfer_lessons_signature_uniq DO NOTHING
    RETURNING *`) as Row[];
  if (rows.length > 0) {
    const lesson = mapLesson(rows[0]);
    await recordProducerObservation(sql, { producer: 'transfer', workspaceId: q.workspaceId, sourceId: lesson.id });
    return { admitted: true, lesson };
  }
  const existing = await getLessonBySignature(sql, { workspaceId: q.workspaceId, signature: q.signature });
  return { admitted: false, reason: 'duplicate-signature', lesson: existing };
  });
}

export async function getTransferLesson(
  sql: Sql,
  q: { workspaceId: string; id: string },
): Promise<TransferLesson | null> {
  const rows = (await sql`
    SELECT * FROM harness_shared.transfer_lessons
     WHERE workspace_id = ${q.workspaceId} AND id = ${q.id} LIMIT 1`) as Row[];
  return rows.length ? mapLesson(rows[0]) : null;
}

export async function getLessonBySignature(
  sql: Sql,
  q: { workspaceId: string; signature: string },
): Promise<TransferLesson | null> {
  const rows = (await sql`
    SELECT * FROM harness_shared.transfer_lessons
     WHERE workspace_id = ${q.workspaceId} AND signature = ${q.signature} LIMIT 1`) as Row[];
  return rows.length ? mapLesson(rows[0]) : null;
}

/** The tick's test queue: probationary lessons first (least-recently-tested,
 *  never-tested leading), then stale VALIDATED lessons for re-validation —
 *  the re-runnable memory unit test that makes demotion (gate.ts) live. */
export async function listLessonsForTesting(
  sql: Sql,
  q: { workspaceId: string; limit: number },
): Promise<TransferLesson[]> {
  const limit = Math.min(Math.max(q.limit, 1), 100);
  const rows = (await sql`
    SELECT * FROM harness_shared.transfer_lessons
     WHERE workspace_id = ${q.workspaceId} AND tier IN ('probationary', 'validated')
     ORDER BY (tier = 'probationary') DESC, last_tested_at ASC NULLS FIRST, created_at ASC
     LIMIT ${limit}`) as Row[];
  return rows.map(mapLesson);
}

export async function listTransferLessons(
  sql: Sql,
  q: { workspaceId: string; tier?: TransferTier; limit?: number },
): Promise<TransferLesson[]> {
  const limit = Math.min(Math.max(q.limit ?? 100, 1), 500);
  const rows = (await sql`
    SELECT * FROM harness_shared.transfer_lessons
     WHERE workspace_id = ${q.workspaceId}
       ${q.tier ? sql`AND tier = ${q.tier}` : sql``}
     ORDER BY created_at DESC
     LIMIT ${limit}`) as Row[];
  return rows.map(mapLesson);
}

/** Persist one gate transition (a scored test). */
export async function recordTransferOutcome(
  sql: Sql,
  q: {
    workspaceId: string;
    id: string;
    transition: GateTransition;
    batteryId: string;
    delta: number;
    evaluation?: TransferReplayEvidence;
  },
): Promise<TransferLesson | null> {
  return withProducerLifecycleWrite(sql, async (sql) => {
  const current = (await sql`SELECT * FROM harness_shared.transfer_lessons
    WHERE workspace_id = ${q.workspaceId} AND id = ${q.id} FOR UPDATE`) as Row[];
  if (!current.length) return null;
  const lesson = mapLesson(current[0]);
  const contract = q.transition.tier === 'validated' ? promotionContract(lesson, q) : null;
  const transition = q.transition.tier === 'validated' && !contract
    ? { ...q.transition, tier: lesson.tier, status: 'error' as const,
        passCount: lesson.passCount, failCount: lesson.failCount }
    : q.transition;
  const rows = (await sql`
    UPDATE harness_shared.transfer_lessons
       SET tier = ${transition.tier}, status = ${transition.status},
           pass_count = ${transition.passCount}, fail_count = ${transition.failCount},
           test_count = test_count + 1, last_tested_at = now(),
           last_battery_id = ${q.batteryId}, last_delta = ${q.delta},
           updated_at = now()
     WHERE workspace_id = ${q.workspaceId} AND id = ${q.id}
     RETURNING *`) as Row[];
  if (rows.length) await recordProducerObservation(sql, { producer: 'transfer', workspaceId: q.workspaceId, sourceId: q.id,
    ...(q.evaluation === undefined ? {} : { evaluation: q.evaluation }),
    ...(contract ? { contract } : {}) });
  return rows.length ? mapLesson(rows[0]) : null;
  });
}

/** An un-scored test (battery threw): recorded, never silently dropped. */
export async function markTransferError(
  sql: Sql,
  q: { workspaceId: string; id: string },
): Promise<void> {
  await withProducerLifecycleWrite(sql, async (sql) => {
  const rows = await sql`
    UPDATE harness_shared.transfer_lessons
       SET status = 'error', test_count = test_count + 1, last_tested_at = now(), updated_at = now()
     WHERE workspace_id = ${q.workspaceId} AND id = ${q.id} RETURNING id`;
  if (rows.length) await recordProducerObservation(sql, { producer: 'transfer', workspaceId: q.workspaceId, sourceId: q.id });
  });
}

/** Link the memory_canonical row a lesson was admitted into (null clears). */
export async function setLessonMemoryId(
  sql: Sql,
  q: { workspaceId: string; id: string; memoryId: string | null },
): Promise<void> {
  await withProducerLifecycleWrite(sql, async (sql) => {
  const rows = await sql`
    UPDATE harness_shared.transfer_lessons
       SET memory_id = ${q.memoryId}, updated_at = now()
     WHERE workspace_id = ${q.workspaceId} AND id = ${q.id} RETURNING id`;
  if (rows.length) await recordProducerObservation(sql, { producer: 'transfer', workspaceId: q.workspaceId, sourceId: q.id });
  });
}

/** Link a knowledge_pack_candidates row (the inherit-the-bar edge). */
export async function setLessonPackCandidate(
  sql: Sql,
  q: { workspaceId: string; id: string; packCandidateId: string },
): Promise<void> {
  await withProducerLifecycleWrite(sql, async (sql) => {
  const rows = await sql`
    UPDATE harness_shared.transfer_lessons
       SET pack_candidate_id = ${q.packCandidateId}, updated_at = now()
     WHERE workspace_id = ${q.workspaceId} AND id = ${q.id} RETURNING id`;
  if (rows.length) await recordProducerObservation(sql, { producer: 'transfer', workspaceId: q.workspaceId, sourceId: q.id });
  });
}
