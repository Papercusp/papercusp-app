/**
 * seed-doc-tracking — register a harness's EXISTING docs as drift-tracked records at
 * create time, so a NEW hive (e.g. from the `coding` blueprint) is doc-honest FROM
 * BIRTH. This is the doc-integrity TWIN of the git-sync seed (owner 2026-06-22; plans
 * deterministic-commit-workitem-attribution-2026-06-20 + docs-corpus-audit WS2).
 *
 * DETERMINISTIC + reuse-first + best-effort: resolveHarnessDocPaths → listDocBodies →
 * anchorManualDoc per doc. NO LLM, no extra agent tool call (D-006) — `anchorManualDoc`
 * reads each doc's `documents:` frontmatter, falling back to inferring anchors from the
 * body's code-path mentions, then upserts a source=manual record. Idempotent: the upsert
 * keys on (workspace, harness, doc_id), so a re-run (or the post-sync sweep registering
 * the same doc) is a harmless overwrite, and an existing human overlay is preserved.
 *
 * The freshness sweep (sweep-after-sync.ts) self-bootstraps docs ADDED later; this seeds
 * the docs the repo already had at create time. Both reuse this same per-doc registration.
 */

import { resolveHarnessDocPaths } from './harness-repo';
import { listDocBodies } from './doc-fs';
import { anchorManualDoc } from './manual-anchor';
import { resolveWorkspaceForHarness } from '../workspace-for-harness';

export interface SeedDocTrackingOutcome {
  seeded: boolean;
  /** Docs successfully registered (anchored or visibly-untracked). */
  registered?: number;
  /** Total .md/.mdx files found under docsRoot. */
  total?: number;
  reason?: 'no_docs_root' | 'no_docs' | 'error';
  message?: string;
}

/**
 * Seed doc-tracking records for every .md/.mdx under the harness's docsRoot.
 *
 * `verify:true` sets each anchored doc's baseline to the current HEAD — a freshly-created
 * hive's docs are assumed current as of clone, so drift is measured from NOW (future code
 * changes flag them). An un-anchored doc still registers, visibly 'untracked', so the
 * old silent-rot mode is made VISIBLE rather than hidden.
 */
export async function seedHarnessDocTracking(opts: {
  harnessSlug: string;
  workspaceId?: string;
}): Promise<SeedDocTrackingOutcome> {
  try {
    const paths = await resolveHarnessDocPaths(opts.harnessSlug);
    if (!paths) return { seeded: false, reason: 'no_docs_root' };
    const docIds = await listDocBodies(paths.docsRoot);
    if (docIds.length === 0) return { seeded: false, reason: 'no_docs', total: 0 };
    const workspaceId = await resolveWorkspaceForHarness(opts.harnessSlug, opts.workspaceId);
    let registered = 0;
    for (const docId of docIds) {
      const res = await anchorManualDoc({ harnessSlug: opts.harnessSlug, docId, verify: true, workspaceId });
      if (res.ok) registered++;
    }
    return { seeded: true, registered, total: docIds.length };
  } catch (e) {
    return { seeded: false, reason: 'error', message: (e instanceof Error ? e.message : String(e)).slice(0, 300) };
  }
}
