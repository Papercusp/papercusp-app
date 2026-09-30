/**
 * Memory-feedback learning loop.
 *
 * Reads recent rows from harness_shared.memory_feedback, derives
 * patterns about what users typically edit or delete, and emits a
 * `customInstructions` string for mem0's Memory constructor. mem0
 * splices this into its extraction prompt — so the extractor learns
 * to avoid the kinds of facts users keep rejecting.
 *
 * Patterns we surface (very small for v1; expand as signal accrues):
 *   - High delete rate by kind: "users frequently delete preference
 *     memories — be conservative about claiming user preferences"
 *   - High edit rate by kind: "users frequently edit project memories
 *     — extract them more literally, less inferentially"
 *   - Forget-all: "users have done full memory resets recently — keep
 *     extraction minimal and high-confidence"
 *
 * Returns null when there's no actionable signal (no feedback events
 * yet, or counts below the noise floor). Returning null is correct:
 * unset → mem0 uses its stock prompt.
 */

import { rebuildCustomInstructions, type FeedbackByKind } from './learning-shared';

const NOISE_FLOOR = 3;

export async function buildLearningInstructions(): Promise<string | null> {
  try {
    const { pgClientFields } = await import('./mem0-connection');
    const fields = await pgClientFields();
    if (!fields) return null;
    const { Client } = await import('pg');
    const c = new Client(fields);
    await c.connect();
    try {
      // Pull last-30-day feedback. We don't reach further back because
      // user behavior drifts and old corrections may no longer reflect
      // what they currently want.
      const counts = await c.query<{ action: string; kind: string | null; n: number }>(
        `SELECT action, kind, COUNT(*)::int AS n
           FROM harness_shared.memory_feedback
          WHERE created_at >= now() - interval '30 days'
          GROUP BY action, kind`,
      );
      const byAction: Record<string, number> = {};
      const byKind: FeedbackByKind = { edit: {}, delete: {} };
      for (const r of counts.rows) {
        byAction[r.action] = (byAction[r.action] ?? 0) + r.n;
        if (r.kind && (r.action === 'edit' || r.action === 'delete')) {
          byKind[r.action][r.kind] = (byKind[r.action][r.kind] ?? 0) + r.n;
        }
      }
      return rebuildCustomInstructions({
        totalEdits: byAction.edit ?? 0,
        totalDeletes: (byAction.delete ?? 0) + (byAction.forget_all ?? 0),
        forgetAllCount: byAction.forget_all ?? 0,
        byKind,
        noiseFloor: NOISE_FLOOR,
      });
    } finally {
      await c.end();
    }
  } catch {
    return null;
  }
}
