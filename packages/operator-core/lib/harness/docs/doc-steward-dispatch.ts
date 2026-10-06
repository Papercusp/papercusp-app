/**
 * doc-steward-dispatch — the P-008 doc-steward dispatch (docs-corpus-audit WS2). Extracted from
 * sweep-after-sync so it's unit-testable without the sweep's git/PG/coord deps.
 *
 * When the post-git-sync freshness sweep flags newly-drifted docs, dispatch ONE doc-steward agent
 * (gated on `papercusp-doc-steward`) to re-sync them to the current code — the LLM counterpart of
 * the deterministic drift DETECTION. Mirrors git-sync → merge-resolution on conflict.
 */

import { SYNC_TRIGGERED_SCHEDULES } from '../../schedule-descriptors.mjs';

/** Stable inventory identity for the optional LLM repair writer. */
const DOC_STEWARD_DISPATCH_NAME = SYNC_TRIGGERED_SCHEDULES.docStewardDispatch.name;

/** A drifted doc handed to the doc-steward in its `--doc-drift` extra. */
export interface DriftedDoc {
  /** Doc-root-relative path of the stale doc. */
  docId: string;
  /** The CODE file(s) the doc documents — what drifted. */
  anchorPaths: string[];
  /** Why the sweep flagged it (which subject code changed). */
  reason: string;
  /** 'generated' | 'manual' | 'augmented'. */
  source: string;
  /**
   * P-005 (deterministic-commit-workitem-attribution): the work-item(s) that recently changed
   * this doc's anchored code — DERIVED from git_sync_commit_attribution (D-006: no extra agent
   * tool call). Tells the doc-steward WHY the code drifted, so it can read the work-item's intent
   * instead of reverse-engineering the diff. Absent when the change wasn't attributed.
   */
  workItems?: string[];
  /** File-authoritative corpus: edit this repo-relative file, not docs:author. */
  sourceFile?: string;
}

const DOC_STEWARD_ACTIVE_WINDOW_MIN = 50;

/**
 * WI-2104 (token audit 2026-07-03) — batch cap + dispatch cooldown. The dispatcher used to hand
 * ONE steward the ENTIRE due set (dozens of docs) with a ~900s spawn budget, and re-dispatch as
 * soon as the previous steward exited (min observed gap 5.3min): 58% of spawns died at the
 * timeout (exitCode 143 after avg 941s) having burned the full context cost and healed a
 * fraction of the batch — and two spawns failed outright with E2BIG because the batch JSON
 * exceeded the exec arg limit. 62 spawns/day, ~$40/day, mostly wasted.
 *
 *  - MAX_DOCS caps the batch to what a steward FINISHES inside its budget (successful runs
 *    avg 369s). Sliced-out docs are NOT charged an attempt (the caller marks only the
 *    dispatched subset) and re-offer on their retry clock.
 *  - COOLDOWN_MIN paces dispatch starts per harness — the guard rail that bounds the burn
 *    when stewards fail systemically (rate storms, operator restarts). The deterministic
 *    drift DETECTION + digest broadcast stay instant; only the LLM heal is paced.
 */
export const DOC_STEWARD_MAX_DOCS_PER_DISPATCH = 8;
export const DOC_STEWARD_DISPATCH_COOLDOWN_MIN = 45;

async function recentOrActiveDocStewardExists(workspaceId: string, harnessSlug: string): Promise<boolean> {
  const { getOrgPg } = await import('@papercusp/db-org');
  const rows = await getOrgPg().sql<{ n: string }[]>`
    SELECT count(*)::text AS n
      FROM harness_shared.spawned_agents
     WHERE workspace_id = ${workspaceId}
       AND harness_slug = ${harnessSlug}
       AND child_role = 'doc-steward'
       AND (
         (status IN ('running', 'restarting')
           AND started_at > now() - make_interval(mins => ${DOC_STEWARD_ACTIVE_WINDOW_MIN}))
         OR started_at > now() - make_interval(mins => ${DOC_STEWARD_DISPATCH_COOLDOWN_MIN})
       )
  `;
  return Number(rows[0]?.n ?? 0) > 0;
}

/**
 * Dispatch the doc-steward for a batch of newly-drifted docs. DETERMINISTIC trigger; best-effort
 * — a dispatch failure must NEVER wedge the sweep / git-sync. Fires the `docs:drift` launch
 * blueprint with AT MOST `DOC_STEWARD_MAX_DOCS_PER_DISPATCH` docs (callers should order the
 * most-deserving first — newly-drifted before retries). Returns the subset actually handed to
 * the steward ([] when nothing was dispatched) so the caller charges retry attempts ONLY for
 * docs the steward was really asked to work (WI-1661's per-doc accountability, batch-level).
 */
export async function dispatchDocStewardForDrift(
  harnessSlug: string,
  workspaceId: string,
  staleDocs: DriftedDoc[],
): Promise<DriftedDoc[]> {
  if (staleDocs.length === 0) return [];
  try {
    const { getFlag } = await import('@papercusp/flags/server');
    const { FLAGS } = await import('@papercusp/flags');
    if (!(await getFlag(FLAGS.DOC_STEWARD, harnessSlug))) return [];
    if (await recentOrActiveDocStewardExists(workspaceId, harnessSlug)) return [];
    const batch = staleDocs.slice(0, DOC_STEWARD_MAX_DOCS_PER_DISPATCH);
    const { fireLaunchBlueprintForEvent } = await import('../../blueprint/launch-blueprint');
    await fireLaunchBlueprintForEvent('docs:drift', {
      installSlug: harnessSlug,
      workspaceId,
      kickoff: `[${DOC_STEWARD_DISPATCH_NAME}] Re-sync ${batch.length} drifted doc(s) in ${harnessSlug} to the current code: ${batch.map((d) => d.docId).join(', ')}. For entries with sourceFile, edit that canonical repo file under a work-item/file lock, then re-anchor/verify the docId; do NOT copy it into docs:author or publish private docs.`,
      extra: ['--doc-drift', JSON.stringify({ docs: batch })],
    });
    return batch;
  } catch {
    // best-effort: doc-steward dispatch must never break the sweep
    return [];
  }
}
