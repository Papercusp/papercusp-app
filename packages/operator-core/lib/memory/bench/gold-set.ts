/**
 * Frozen gold-set loader (memory-backend-benchmark-2026-06-05 P-005,
 * D-003): ~150 query→expected-corpus-key pairs across the four
 * adversarial classes, frozen as a versioned fixture so runs are
 * comparable over time. Expected keys bind to the SAME-version corpus
 * fixture — regenerate both together as a new version, never in place.
 */
import fs from 'node:fs';
import path from 'node:path';

import type { GoldQuery } from '@papercusp/memory/bench';

export const GOLD_SET_FIXTURE_VERSION = 'v1';

const FIXTURES_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures');

/** Every fixture version on disk, oldest first. CLIs validate `--gold` against this. */
export const GOLD_SET_FIXTURE_VERSIONS = ['v1', 'v2'] as const;

/**
 * A hard negative added after v1 carries `absentTerms`: distinctive phrases
 * from its query that appear in NO bound-corpus entry. gold-set.test.ts pins
 * that absence, so a corpus change that starts covering the topic fails loudly
 * instead of silently turning the negative into a mislabeled positive.
 */
export type GoldSetQuery = GoldQuery & { readonly absentTerms?: readonly string[] };

export interface GoldSetFixture {
  version: string;
  corpusVersion: string;
  frozenAt: string;
  count: number;
  classes: Record<string, number>;
  note: string;
  queries: GoldSetQuery[];
  /** Set only when the version extends another: the parent version's query ids, in order. */
  inheritedIds?: readonly string[];
}

/** On-disk shape of a version that extends an earlier one instead of copying it. */
interface ExtendingFixtureFile {
  version: string;
  extends: string;
  corpusVersion: string;
  frozenAt: string;
  note: string;
  add: GoldSetQuery[];
}

/**
 * Load the frozen gold-set fixture. A version that `extends` another (v2 extends
 * v1) is composed here — parent queries verbatim, then the additions — so the
 * inherited queries can never drift from the parent file.
 */
export function loadGoldSetFixture(version: string = GOLD_SET_FIXTURE_VERSION): GoldSetFixture {
  const file = path.join(FIXTURES_DIR, `gold-set.${version}.json`);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as GoldSetFixture | ExtendingFixtureFile;
  if (!('extends' in raw)) return raw;
  const parent = loadGoldSetFixture(raw.extends);
  if (parent.corpusVersion !== raw.corpusVersion) {
    throw new Error(`gold-set.${version} binds corpus ${raw.corpusVersion} but extends ${raw.extends} (corpus ${parent.corpusVersion})`);
  }
  const queries = [...parent.queries, ...raw.add];
  const classes: Record<string, number> = {};
  for (const q of queries) classes[q.class] = (classes[q.class] ?? 0) + 1;
  return {
    version: raw.version,
    corpusVersion: raw.corpusVersion,
    frozenAt: raw.frozenAt,
    count: queries.length,
    classes,
    note: raw.note,
    queries,
    inheritedIds: parent.queries.map((q) => q.id),
  };
}
