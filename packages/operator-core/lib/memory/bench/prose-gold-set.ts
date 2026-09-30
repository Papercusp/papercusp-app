/**
 * Frozen PROSE gold-set loader
 * (prose-embedding-384-untrained-mrl-fix-2026-08-02 P-001).
 *
 * Mirror of `gold-set.ts` for the prose surfaces. Expected keys bind to the
 * SAME-version prose corpus fixture — regenerate both together as a new
 * version, never in place. Authoring + validation lives in
 * `prose-gold-set-build.ts`; this module only reads the frozen artifact.
 */
import fs from 'node:fs';
import path from 'node:path';

import type { GoldQuery } from '@papercusp/memory/bench';

export const PROSE_GOLD_SET_VERSION = 'v1';

const FIXTURES_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures');

export interface ProseGoldSetFixture {
  version: string;
  corpusVersion: string;
  frozenAt: string;
  count: number;
  classes: Record<string, number>;
  note: string;
  queries: GoldQuery[];
}

/** Load the frozen prose gold-set fixture. */
export function loadProseGoldSetFixture(version: string = PROSE_GOLD_SET_VERSION): ProseGoldSetFixture {
  const file = path.join(FIXTURES_DIR, `prose-gold-set.${version}.json`);
  return JSON.parse(fs.readFileSync(file, 'utf8')) as ProseGoldSetFixture;
}
