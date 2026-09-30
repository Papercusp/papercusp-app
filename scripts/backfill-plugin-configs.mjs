/**
 * Backfill ~/.papercusp/harnesses/<slug>/plugin-configs/<plugin>.json into
 * harness_shared.plugin_configs. Idempotent.
 *
 * The substrate plugin loader still reads from the JSON files at runtime,
 * so files remain authoritative. PG is a mirrored index for cross-harness
 * queries + Zero subscriptions.
 */
import { promises as fs, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';

const HARNESSES_DIR = join(homedir(), '.papercusp', 'harnesses');
const sql = postgres('postgresql://harness_app:harness_app_pwd@localhost:5432/papercusp');

async function readJson(p) {
  try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return null; }
}

async function syncOne(harness) {
  const dir = join(HARNESSES_DIR, harness, 'plugin-configs');
  if (!existsSync(dir)) {
    const del = await sql`DELETE FROM harness_shared.plugin_configs WHERE harness_slug = ${harness}`;
    return { harness, upserted: 0, removed: del.count };
  }
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.json'));
  const slugs = files.map((f) => f.replace(/\.json$/, ''));
  let upserted = 0;
  for (const f of files) {
    const slug = f.replace(/\.json$/, '');
    const cfg = (await readJson(join(dir, f))) ?? {};
    await sql`
      INSERT INTO harness_shared.plugin_configs (harness_slug, plugin_slug, config, updated_at)
      VALUES (${harness}, ${slug}, ${cfg}, now())
      ON CONFLICT (harness_slug, plugin_slug) DO UPDATE
        SET config = EXCLUDED.config, updated_at = now()
    `;
    upserted++;
  }
  let removed = 0;
  if (slugs.length === 0) {
    const del = await sql`DELETE FROM harness_shared.plugin_configs WHERE harness_slug = ${harness}`;
    removed = del.count;
  } else {
    const del = await sql`
      DELETE FROM harness_shared.plugin_configs
      WHERE harness_slug = ${harness} AND plugin_slug NOT IN ${sql(slugs)}
    `;
    removed = del.count;
  }
  return { harness, upserted, removed };
}

async function main() {
  if (!existsSync(HARNESSES_DIR)) {
    console.log('no harnesses dir');
    await sql.end();
    return;
  }
  const dirs = (await fs.readdir(HARNESSES_DIR, { withFileTypes: true }))
    .filter((d) => d.isDirectory()).map((d) => d.name);
  let totals = { upserted: 0, removed: 0 };
  for (const h of dirs) {
    const r = await syncOne(h);
    totals.upserted += r.upserted;
    totals.removed += r.removed;
    console.log(`  ${r.harness}: ${r.upserted} upserted, ${r.removed} removed`);
  }
  console.log(`done: ${totals.upserted} upserted, ${totals.removed} removed`);
  await sql.end();
}

await main();
