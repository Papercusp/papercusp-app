#!/usr/bin/env -S npx tsx
/**
 * Release-cut step: export the shipped doc corpora's vectors as a doc vector
 * seed (WI-10004455, plan ship-precomputed-doc-vectors-2026-10-01 P-001).
 *
 * The Server applies the seed at boot (doc-vector-seed.ts
 * applyShippedDocVectorSeed, via PAPERCUSP_DOC_VECTOR_SEED_DIR), so a fresh
 * install embeds only the doc sections the seed does not cover instead of all
 * ~12.8k of them.
 *
 * Cut flow, against a build database whose doc_sections were synced from the
 * release tree:
 *   1. --previous <dir>  apply the previous release's seed first, so unchanged
 *                        sections (same page_sha) are not re-embedded;
 *   2. let embed-backfill embed what is left (a normal Server/operator sweep);
 *   3. run this script with --out <dir>. It refuses (exit 1) while any section
 *      of the exported corpora has no vector in the target space, unless
 *      --allow-uncovered is passed.
 *
 * The target space is the CURRENT prose profile of --mode (default gemma, the
 * Server's embedder), judged by the same predicate the backfill sweep uses.
 *
 * Usage:
 *   npx tsx scripts/export-doc-vector-seed.mts --out <dir> [--previous <dir>]
 *        [--mode gemma] [--dsn <postgres url>] [--allow-uncovered]
 */
import postgres from 'postgres';
import { getHarnessAdminUrl } from '../packages/operator-core/lib/embedded-pg-discovery';
import {
  applyDocVectorSeed,
  countUnembeddedDocSections,
  exportDocVectorSeed,
  readDocVectorSeed,
  SEEDED_DOC_SOURCE_KEYS,
  writeDocVectorSeed,
} from '../packages/operator-core/lib/search/doc-vector-seed';
import { resolveCurrentProseProfileSelection } from '../packages/operator-core/lib/search/prose-vector-dims';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<number> {
  const out = arg('out');
  if (!out) {
    console.error('usage: export-doc-vector-seed.mts --out <dir> [--previous <dir>] [--mode gemma] [--dsn <url>] [--allow-uncovered]');
    return 2;
  }
  const mode = arg('mode') ?? 'gemma';
  const selection = resolveCurrentProseProfileSelection(mode);
  if (!selection) {
    console.error(`no prose-storable current profile for mode '${mode}'`);
    return 2;
  }
  const space = { mode, selection };
  const sql = postgres(arg('dsn') ?? getHarnessAdminUrl(), { max: 1, onnotice: () => {} });
  try {
    const previous = arg('previous');
    if (previous) {
      const before = await countUnembeddedDocSections(sql, SEEDED_DOC_SOURCE_KEYS);
      const r = await applyDocVectorSeed(sql, await readDocVectorSeed(previous), space);
      console.log(`previous seed ${previous}: ${JSON.stringify(r)} (unembedded before: ${before})`);
    }
    const { seed, uncovered } = await exportDocVectorSeed(sql, space);
    const bytes = seed.vectors.length * 4;
    console.log(
      `export: ${seed.manifest.rows.length} rows, ${mode}/${selection.profileId}, ` +
        `${(bytes / 1e6).toFixed(1)} MB vectors, uncovered ${uncovered}`,
    );
    if (uncovered > 0 && !process.argv.includes('--allow-uncovered')) {
      console.error(
        `refusing to write: ${uncovered} section(s) have no ${mode} vector yet — let embed-backfill finish, ` +
          `or pass --allow-uncovered to ship a partial seed`,
      );
      return 1;
    }
    await writeDocVectorSeed(out, seed);
    console.log(`wrote ${out}`);
    return 0;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
