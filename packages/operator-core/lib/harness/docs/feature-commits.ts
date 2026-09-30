/**
 * feature-commits — resolve a `feature` subject ref (F-NNN / WI-NNN) to its
 * already-recorded implementing commit SHA(s), via
 * harness_features_consolidated.completion_ref.commit_sha.
 *
 * Plan: harness-docs-integration-2026-06-05 (P-001/D-001 feature strategy). This
 * is the FeatureCommitLookup the drift resolver injects — provenance the worker
 * already records on push, not something we reverse-engineer.
 */

import { getOrgPg } from '@papercusp/db-org';
import { DEFAULT_WORKSPACE_ID } from '../../workspace-id-constant';
import { isCompletionRef } from '../completion-ref-types';
import type { FeatureCommitLookup } from './subject-ref';

/**
 * Build a lookup bound to one harness. Returns the feature's recorded
 * implementing commit SHA(s), or [] when the feature is unknown / has no
 * completion_ref yet (→ the resolver reports 'unresolved-feature', never a
 * false verdict).
 */
export function makeFeatureCommitLookup(
  harnessSlug: string,
  workspaceId: string = DEFAULT_WORKSPACE_ID,
): FeatureCommitLookup {
  return async (ref: string): Promise<string[]> => {
    const { sql } = getOrgPg();
    const rows = await sql<{ completion_ref: unknown }[]>`
      SELECT completion_ref
        FROM harness_shared.harness_features_consolidated
       WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug} AND feature_id = ${ref}
       LIMIT 1`;
    const cr = rows[0]?.completion_ref;
    if (cr && isCompletionRef(cr) && cr.commit_sha) return [cr.commit_sha];
    return [];
  };
}
