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

export interface GoldSetFixture {
  version: string;
  corpusVersion: string;
  frozenAt: string;
  count: number;
  classes: Record<string, number>;
  note: string;
  queries: GoldQuery[];
}

/** Load the frozen gold-set fixture. */
export function loadGoldSetFixture(version: string = GOLD_SET_FIXTURE_VERSION): GoldSetFixture {
  const file = path.join(FIXTURES_DIR, `gold-set.${version}.json`);
  return JSON.parse(fs.readFileSync(file, 'utf8')) as GoldSetFixture;
}
