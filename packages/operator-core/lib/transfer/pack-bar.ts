/**
 * The knowledge-pack transfer bar (P-022 / FB-08, D-006: "knowledge-pack
 * candidates inherit the passing-transfer-test bar") — consulted by
 * decideKnowledgePackCandidate at ADOPTION time.
 *
 * Semantics (deliberately narrow — the bar blocks PROVEN failures, it never
 * wedges the owner's curation queue on an idle loop):
 *
 *   - flag papercusp-transfer-harness OFF ⇒ no gating, byte-identical
 *     adoption behavior (the flag is default-ON since the 2026-07-19 P-004
 *     ratification — the LEARNING GOVERNOR's budget, not this flag, is the
 *     loop's arming gate, so with the flag ON but the loop unbudgeted the
 *     bar can only ever see untested/candidate lessons, which never block);
 *   - no transfer_lessons row matches the candidate (by pack_candidate_id or
 *     signature) ⇒ no gating — a candidate with no replayable source task is
 *     untestable, and an untested candidate is the owner's call;
 *   - a matching lesson with tier 'validated' ⇒ allow (it passed);
 *   - a matching lesson with status 'failed' or tier 'retired' ⇒ BLOCK —
 *     the student-transfer test proved the lesson doesn't transfer; adopting
 *     it into the fleet pack would ship disproven wisdom. (status 'error' is
 *     test-infra failure, not lesson failure — never blocks.)
 *
 * Deps injectable (the registrants.ts seam pattern) so candidates tests run
 * with zero flags/PG IO.
 */
import type { Sql } from 'postgres';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import type { TransferLesson } from './types';

export interface PackBarDeps {
  enabled?: () => Promise<boolean>;
  getSql?: () => Promise<Sql>;
  log?: (msg: string) => void;
}

const defaultDeps: Required<PackBarDeps> = {
  enabled: () => getFlag(FLAGS.TRANSFER_HARNESS, 'knowledge-pack-transfer-bar'),
  // Lazy: the pool module must not load (or throw) before the flag check.
  getSql: async () => (await import('@papercusp/db-org')).getOrgPg().sql,
  log: (m) => console.log(`[transfer-bar] ${m}`),
};

export type PackTransferBarVerdict =
  | { blocked: false }
  | { blocked: true; detail: string; lesson: Pick<TransferLesson, 'id' | 'tier' | 'status' | 'failCount' | 'lastDelta'> };

/**
 * Fail-OPEN by design: a flags/PG hiccup must never block the owner's
 * curation queue (the bar is an advisory hard-stop on proven failures, not a
 * liveness-critical gate).
 */
export async function packCandidateTransferBar(
  q: { workspaceId: string; candidateId: string; signature: string },
  deps?: PackBarDeps,
): Promise<PackTransferBarVerdict> {
  const d = { ...defaultDeps, ...deps };
  try {
    if (!(await d.enabled())) return { blocked: false };
    const sql = await d.getSql();
    const rows = (await sql`
      SELECT id, tier, status, fail_count, last_delta
        FROM harness_shared.transfer_lessons
       WHERE workspace_id = ${q.workspaceId}
         AND (pack_candidate_id = ${q.candidateId} OR signature = ${q.signature})
       ORDER BY (pack_candidate_id = ${q.candidateId}) DESC
       LIMIT 1`) as Array<Record<string, unknown>>;
    const row = rows[0];
    if (!row) return { blocked: false };
    const tier = String(row.tier);
    const status = String(row.status);
    if (tier === 'retired' || status === 'failed') {
      const lesson = {
        id: String(row.id),
        tier: tier as TransferLesson['tier'],
        status: status as TransferLesson['status'],
        failCount: Number(row.fail_count ?? 0),
        lastDelta: row.last_delta === null || row.last_delta === undefined ? null : Number(row.last_delta),
      };
      return {
        blocked: true,
        lesson,
        detail:
          `transfer test ${tier === 'retired' ? 'retired' : 'failed'} this lesson ` +
          `(lesson ${lesson.id}: ${lesson.failCount} fail(s), last delta ${lesson.lastDelta ?? 'n/a'}) — `
          + 'a fresh student with it did not beat one without it on the source task (D-006)',
      };
    }
    return { blocked: false };
  } catch (e) {
    d.log(`bar check failed — failing OPEN: ${e instanceof Error ? e.message : e}`);
    return { blocked: false };
  }
}
