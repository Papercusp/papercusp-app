/**
 * PROSE-surface benchmark corpus
 * (prose-embedding-384-untrained-mrl-fix-2026-08-02 P-001).
 *
 * The memory bench corpus (`corpus.ts`) snapshots the owner's Claude file
 * memory: ~150 short, topically-scattered facts. The PROSE surfaces are a
 * different distribution by three orders of magnitude — ~394k session_turns,
 * ~6.3k doc_sections, ~1k harness_plans — so the memory gold set does NOT
 * transfer and neither does its corpus. This module snapshots the real prose
 * surfaces instead.
 *
 * ## Why the sample is CLUSTER-preserving, not row-random
 *
 * The whole point of the corpus is to make retrieval *as hard as it really
 * is*, because the P-002 verdict is "is the 384 cut's loss outside noise?" and
 * a corpus that is too easy answers "within noise" for EVERY leg — a ceiling
 * artifact indistinguishable from a real null result, which would terminate
 * the plan on a measurement that never measured anything.
 *
 * Measured 2026-08-02 against the live pgvector index: a doc section's nearest
 * neighbours are overwhelmingly its OWN PAGE's sibling sections —
 *
 *   'Revisions › Round 4'                        vs '› Round 5'          cos .7299
 *   'Performance — rules every agent must follow › 5. Never animate …'
 *                                                vs '› 4. Animate only …' cos .7227
 *   'Memory topology … › Why (the evidence)'      vs '› The shape'        cos .8294
 *
 * Those siblings ARE the hard part of the task: telling "Round 4" from
 * "Round 5" is what a degraded embedding gets wrong first. Sampling individual
 * rows at random scatters the clusters, deletes the confusable material, and
 * flatters every leg. So the unit of sampling is the CLUSTER — a whole doc
 * page, a whole session, a whole plan — and every member of a picked cluster
 * is kept.
 *
 * Rejected alternative: mine hard distractors by nearest-neighbour lookup in
 * the live embeddings. It also preserves difficulty, but the neighbours are
 * found in GEMMA'S OWN vector space, so the corpus would be built out of the
 * incumbent's confusions and would bias the verdict against it. Clustering by
 * page/session/plan is a STRUCTURAL property of the corpus — no embedding
 * space involved, so no circularity.
 *
 * ## Freezing
 *
 * Same discipline as the memory corpus: a fixture version is frozen and the
 * gold set's expected keys bind to it. Regenerate a NEW version (corpus.v2 +
 * a gold-set rev) deliberately, never in place.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import type { CorpusEntry } from '@papercusp/memory/bench';

// The SAME module the three gate lints and the edit-time hook import — so the scrub applied at
// generation time and the leak definition enforced at commit time cannot drift (WI-6992).
import { redactIdentityLeaks } from '../../../../../scripts/lib/identity-leak-patterns.mjs';

export const PROSE_CORPUS_FIXTURE_VERSION = 'v1';

const FIXTURES_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures');

/** The prose surfaces sampled, and the row budget each contributes. */
export interface ProseSurfaceQuota {
  /** Surface tag, also the corpus-key prefix (`doc:`, `turn:`, `plan:`). */
  surface: 'doc' | 'turn' | 'plan';
  /** Target number of rows drawn from this surface. */
  budget: number;
  /**
   * Cap on rows taken from ONE cluster, so a single 400-section page or a
   * 3000-turn session cannot swallow the surface's whole budget. Members are
   * kept in their natural order, so a capped cluster is still a run of true
   * siblings.
   */
  maxClusterRows: number;
}

/**
 * The frozen composition. Weighted toward doc_sections (the richest prose and
 * the primary `docs:search` surface) while keeping a substantial session_turns
 * share, because that surface is both the largest in production and the
 * messiest distribution — short, conversational, heavily self-similar.
 *
 * ~2000 rows total is a deliberate ceiling: measured gemma throughput on this
 * host is 353ms/doc uncached and batching buys NOTHING (batch=32 is 390ms/doc),
 * so 2000 rows costs ~12 min per model pass. P-002 + P-003 need roughly four
 * distinct passes, i.e. ~50 min — affordable. Ten thousand rows would not be.
 */
export const PROSE_CORPUS_QUOTAS: readonly ProseSurfaceQuota[] = [
  { surface: 'doc', budget: 900, maxClusterRows: 40 },
  { surface: 'turn', budget: 700, maxClusterRows: 25 },
  { surface: 'plan', budget: 400, maxClusterRows: 1 },
];

/** A candidate cluster: its stable key and how many rows it would contribute. */
export interface ClusterCandidate {
  key: string;
  size: number;
}

/**
 * Deterministically pick WHOLE clusters until the row budget is met.
 *
 * Ordering is by `sha1(seed + key)` rather than by anything in the data, so
 * the sample is stable across runs and independent of table order, insertion
 * time, or row count drift. Clusters are taken intact; the budget may
 * overshoot by less than one capped cluster, which is the price of never
 * splitting one.
 */
export function pickClusters(
  candidates: readonly ClusterCandidate[],
  budget: number,
  maxClusterRows: number,
  seed: string,
): { keys: string[]; rows: number } {
  const ordered = [...candidates].sort((a, b) => {
    const ha = crypto.createHash('sha1').update(`${seed}:${a.key}`).digest('hex');
    const hb = crypto.createHash('sha1').update(`${seed}:${b.key}`).digest('hex');
    return ha < hb ? -1 : ha > hb ? 1 : a.key.localeCompare(b.key);
  });

  const keys: string[] = [];
  let rows = 0;
  for (const c of ordered) {
    if (rows >= budget) break;
    keys.push(c.key);
    rows += Math.min(c.size, maxClusterRows);
  }
  return { keys, rows };
}

/** Stable corpus key for a row, namespaced by surface. */
export function proseCorpusKey(surface: ProseSurfaceQuota['surface'], parts: readonly string[]): string {
  return `${surface}:${parts.join('#')}`;
}

export interface ProseCorpusFixture {
  version: string;
  snapshotAt: string;
  count: number;
  /** Row counts per surface, so a drifted regeneration is visible at a glance. */
  bySurface: Record<string, number>;
  /** Cluster counts per surface — the difficulty-preservation signal. */
  clustersBySurface: Record<string, number>;
  seed: string;
  note: string;
  entries: CorpusEntry[];
}

/** Load the frozen prose corpus fixture. */
export function loadProseCorpusFixture(version: string = PROSE_CORPUS_FIXTURE_VERSION): CorpusEntry[] {
  const file = path.join(FIXTURES_DIR, `prose-corpus.${version}.json`);
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as ProseCorpusFixture;
  return parsed.entries;
}

/** Load the full fixture envelope (metadata included). */
export function loadProseCorpusFixtureMeta(
  version: string = PROSE_CORPUS_FIXTURE_VERSION,
): ProseCorpusFixture {
  const file = path.join(FIXTURES_DIR, `prose-corpus.${version}.json`);
  return JSON.parse(fs.readFileSync(file, 'utf8')) as ProseCorpusFixture;
}

/**
 * Scrub identity leaks out of a harvested fixture, in place, returning a new envelope.
 *
 * ## Why this exists (WI-6992)
 *
 * The corpus is harvested from LIVE workspace prose — doc pages, session transcripts, plans —
 * and that prose legitimately contains real names, home paths and this box's git identity. The
 * fixture is then COMMITTED SOURCE, and tracked source is packed into the release bundle
 * (source.tar.zst), so every one of those is a leak the moment it lands.
 *
 * It is not hypothetical. The v1 snapshot shipped 26 named provenance tags, 113 bare box
 * literals and 24 home paths, red-pinning all three identity lints and holding `main` for the
 * whole fleet ~6.8h on 2026-08-02. The generator had no redaction at all, so the artifact was
 * scrubbed by hand — which fixes one file and leaves the trap armed for the next regeneration.
 * This is the durable half: the scrub now happens at the single point every fixture write goes
 * through, so a corpus cannot be generated dirty.
 *
 * The redactor is imported from the SAME module as the three gate matchers rather than
 * reimplemented here, so "what is a leak" has exactly one definition (see the header of
 * scripts/lib/identity-leak-patterns.mjs).
 *
 * ## Keys are verified, never rewritten
 *
 * `prose-gold-set.v1.json` binds its expected keys to this corpus version — "regenerate BOTH
 * together, never in place". Silently redacting a KEY would therefore break the gold set in a
 * way that surfaces as an unrelated retrieval-scoring failure much later. So keys are CHECKED
 * and a leak in one is a loud throw: it needs a deliberate decision (re-key the entry, or
 * regenerate both fixtures together), not a quiet rewrite.
 */
export function redactProseCorpusFixture(
  fixture: ProseCorpusFixture,
  /**
   * Resolved identity literals, defaulting to this box's. Injectable for the same reason
   * `redactIdentityLeaks` takes them: a test is tracked source and may not spell a real box
   * identity, so it must be able to scrub against SYNTHETIC literals.
   */
  literals?: [string, string][],
): ProseCorpusFixture {
  const offendingKeys: string[] = [];
  const entries = fixture.entries.map((e) => {
    if (redactIdentityLeaks(e.key, literals) !== e.key) offendingKeys.push(e.key);
    const text = redactIdentityLeaks(e.text, literals);
    const description =
      typeof e.description === 'string'
        ? redactIdentityLeaks(e.description, literals)
        : e.description;
    return { ...e, text, ...(description !== undefined ? { description } : {}) };
  });

  if (offendingKeys.length > 0) {
    throw new Error(
      `prose corpus: ${offendingKeys.length} entry KEY(s) carry an identity leak, e.g. ` +
        `${offendingKeys.slice(0, 3).join(', ')}. Keys are not auto-redacted because the gold ` +
        `set binds to them — re-key those entries or regenerate corpus + gold set together.`,
    );
  }

  return { ...fixture, note: redactIdentityLeaks(fixture.note, literals), entries };
}

/**
 * Write a prose corpus snapshot as a frozen fixture (deliberate versioning).
 *
 * Redaction is applied HERE, at the single choke point, rather than in the snapshot CLI — so a
 * second generator (or a future re-sampler) cannot reintroduce the leak by forgetting to call
 * it. See `redactProseCorpusFixture` for the incident behind this.
 */
export function writeProseCorpusFixture(fixture: ProseCorpusFixture): string {
  const file = path.join(FIXTURES_DIR, `prose-corpus.${fixture.version}.json`);
  fs.mkdirSync(FIXTURES_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(redactProseCorpusFixture(fixture), null, 2) + '\n', 'utf8');
  return file;
}
