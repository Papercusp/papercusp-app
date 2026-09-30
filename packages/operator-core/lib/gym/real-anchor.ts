/**
 * Real-feature correlation anchor (P-028, D-014).
 *
 * A small FIXED set of real shipped features, replayed as `real-anchor` tasks at
 * the commit BEFORE each feature was implemented. Scored but NEVER optimized — the
 * falsifiability check answering "does gym score move with real-feature success?".
 * If the gym score climbs while the real-anchor stays flat, the loop is optimizing
 * an Opus-judged proxy, and that is surfaced.
 *
 * This is the pure mapper. The curated descriptor list (which real features, at
 * which base commits) is supplied by config + populated at the P-014 real run.
 */
import { isPinnedCommit } from './clone';
import type { GeneratedTaskRecord } from './task-generator';

export interface RealFeatureDescriptor {
  /** The harness the real feature shipped in. */
  harnessSlug: string;
  /** The real feature id. */
  featureId: string;
  /** The substrate repo (path/url). */
  repoUrl: string;
  /** The commit immediately BEFORE the feature was implemented (a pinned SHA). */
  baseCommit: string;
  /** The high-level intent of the real feature. */
  intent: string;
  /** The (real) spec the feature was built from. */
  spec: string;
}

/**
 * Map a real shipped feature to a gym task at its base commit. Defaults to the
 * `real-anchor` pool (P-028, scored-never-optimized falsifiability check); pass
 * `'train'` to replay real features as a TRAINING source (P-026, importance low).
 */
export function realFeatureToAnchorTask(
  desc: RealFeatureDescriptor,
  pool: 'real-anchor' | 'train' = 'real-anchor',
): GeneratedTaskRecord {
  if (!isPinnedCommit(desc.baseCommit)) {
    throw new Error(`real-anchor base commit must be a pinned hex SHA, got: ${JSON.stringify(desc.baseCommit)}`);
  }
  const intent = desc.intent.trim();
  const spec = desc.spec.trim();
  if (!intent) throw new Error('real-anchor descriptor requires a non-empty intent');
  if (!spec) throw new Error('real-anchor descriptor requires a non-empty spec');

  return {
    taskId: `real-${desc.harnessSlug}-${desc.featureId}`,
    pool,
    repoUrl: desc.repoUrl,
    repoCommit: desc.baseCommit,
    intent,
    spec,
    generatedBy: 'real-feature-replay',
  };
}
