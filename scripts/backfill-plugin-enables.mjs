/**
 * Backfill ~/.papercusp/harnesses/<slug>/enabled-plugins.json into
 * harness_shared.plugin_enables. Idempotent — re-running mirrors the
 * current on-disk state into PG (inserts/updates/deletes orphans).
 *
 * Used at backfill time and any time a direct papercusp-CLI invocation
 * outside the operator API drifts JSON ahead of PG.
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
  const file = await readJson(join(HARNESSES_DIR, harness, 'enabled-plugins.json'));
  const enabled = file?.enabled ?? {};
  const slugs = Object.keys(enabled);
  let upserted = 0, removed = 0;
  for (const [pluginSlug, meta] of Object.entries(enabled)) {
    const r = await sql`
      INSERT INTO harness_shared.plugin_enables
        (harness_slug, plugin_slug, version, config_hash, enabled_at, updated_at)
      VALUES (${harness}, ${pluginSlug}, ${meta.version ?? ''}, ${meta.configHash ?? ''},
              ${meta.enabledAt ?? new Date().toISOString()}, now())
      ON CONFLICT (harness_slug, plugin_slug) DO UPDATE
        SET version = EXCLUDED.version,
            config_hash = EXCLUDED.config_hash,
            updated_at = now()
    `;
    upserted++;
  }
  if (slugs.length === 0) {
    const del = await sql`DELETE FROM harness_shared.plugin_enables WHERE harness_slug = ${harness}`;
    removed = del.count;
  } else {
    const del = await sql`
      DELETE FROM harness_shared.plugin_enables
      WHERE harness_slug = ${harness} AND plugin_slug NOT IN ${sql(slugs)}
    `;
    removed = del.count;
  }
  return { harness, upserted, removed };
}

async function main() {
  if (!existsSync(HARNESSES_DIR)) {
    console.log('no harnesses dir at', HARNESSES_DIR);
    await sql.end();
    return;
  }
  const dirs = (await fs.readdir(HARNESSES_DIR, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  let totals = { harnesses: 0, upserted: 0, removed: 0 };
  for (const h of dirs) {
    const r = await syncOne(h);
    totals.harnesses++;
    totals.upserted += r.upserted;
    totals.removed += r.removed;
    console.log(`  ${r.harness}: ${r.upserted} upserted, ${r.removed} removed`);
  }
  console.log(`done: ${totals.harnesses} harnesses, ${totals.upserted} upserted, ${totals.removed} removed`);
  const sample = await sql`SELECT * FROM harness_shared.plugin_enables ORDER BY harness_slug, plugin_slug LIMIT 10`;
  for (const r of sample) console.log('  →', r.harness_slug, r.plugin_slug, r.version);
  await sql.end();
}

await main();
