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
import { resolveLearningPotSlug } from '../learning/pot-scope';
import type { SignalOrigin } from '../harness/improvements/provenance';
import type { GateTransition } from './gate';
import type {
  TransferLesson,
  TransferSourceKind,
  TransferStatus,
  TransferTier,
} from './types';

type Row = Record<string, unknown>;
const str = (v: unknown): string => String(v);
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const iso = (v: unknown): string => new Date(v as string | Date).toISOString();
const isoOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : iso(v));

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
  const rows = (await sql`
    INSERT INTO harness_shared.transfer_lessons
      (workspace_id, signature, title, lesson_text, source_kind, source_ref, pack_candidate_id, pot_slug)
    VALUES (${q.workspaceId}, ${q.signature}, ${q.title ?? null}, ${q.lessonText},
      ${q.sourceKind ?? 'transcript'}, ${q.sourceRef ?? null}, ${q.packCandidateId ?? null}, ${potSlug})
    ON CONFLICT ON CONSTRAINT transfer_lessons_signature_uniq DO NOTHING
    RETURNING *`) as Row[];
  if (rows.length > 0) return { admitted: true, lesson: mapLesson(rows[0]) };
  const existing = await getLessonBySignature(sql, { workspaceId: q.workspaceId, signature: q.signature });
  return { admitted: false, reason: 'duplicate-signature', lesson: existing };
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
  },
): Promise<TransferLesson | null> {
  const rows = (await sql`
    UPDATE harness_shared.transfer_lessons
       SET tier = ${q.transition.tier}, status = ${q.transition.status},
           pass_count = ${q.transition.passCount}, fail_count = ${q.transition.failCount},
           test_count = test_count + 1, last_tested_at = now(),
           last_battery_id = ${q.batteryId}, last_delta = ${q.delta},
           updated_at = now()
     WHERE workspace_id = ${q.workspaceId} AND id = ${q.id}
     RETURNING *`) as Row[];
  return rows.length ? mapLesson(rows[0]) : null;
}

/** An un-scored test (battery threw): recorded, never silently dropped. */
export async function markTransferError(
  sql: Sql,
  q: { workspaceId: string; id: string },
): Promise<void> {
  await sql`
    UPDATE harness_shared.transfer_lessons
       SET status = 'error', test_count = test_count + 1, last_tested_at = now(), updated_at = now()
     WHERE workspace_id = ${q.workspaceId} AND id = ${q.id}`;
}

/** Link the memory_canonical row a lesson was admitted into (null clears). */
export async function setLessonMemoryId(
  sql: Sql,
  q: { workspaceId: string; id: string; memoryId: string | null },
): Promise<void> {
  await sql`
    UPDATE harness_shared.transfer_lessons
       SET memory_id = ${q.memoryId}, updated_at = now()
     WHERE workspace_id = ${q.workspaceId} AND id = ${q.id}`;
}

/** Link a knowledge_pack_candidates row (the inherit-the-bar edge). */
export async function setLessonPackCandidate(
  sql: Sql,
  q: { workspaceId: string; id: string; packCandidateId: string },
): Promise<void> {
  await sql`
    UPDATE harness_shared.transfer_lessons
       SET pack_candidate_id = ${q.packCandidateId}, updated_at = now()
     WHERE workspace_id = ${q.workspaceId} AND id = ${q.id}`;
}
