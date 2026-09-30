/**
 * @papercupai/postgres-manager — reference plugin for the db:plugin-schema
 * capability. Reserves a per-plugin schema so other plugins can store
 * harness-local data without colliding with substrate tables.
 *
 * Demonstrates 3 server-runtime actions sharing a single capability:
 *   - migrate:  apply pending DDL files (idempotent via SCHEMA migration table)
 *   - inspect:  list the tables in the plugin schema
 *   - reset:    DROP SCHEMA CASCADE + recreate (gated by params.confirm)
 *
 * The handler reads the substrate-provided db:plugin-schema connection from
 * env (substrate is responsible for opening + scoping). For this reference
 * plugin we use HARNESS_DATABASE_URL + an explicit schema search_path.
 */
import type { Plugin, PapercuspContext } from '@papercusp/plugin-sdk';

// Resolve embedded-PG URL from discovery file (~/.papercusp/embedded-pg.json,
// written by desktop's Rust main on PG ready). Returns null if no file.
function readDiscoveryUrl(role: 'app' | 'admin'): string | null {
  if (process.env.PAPERCUSP_SKIP_PG_DISCOVERY === '1') return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('node:fs') as typeof import('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const os = require('node:os') as typeof import('node:os');
    const raw = fs.readFileSync(`${os.homedir()}/.papercusp/embedded-pg.json`, 'utf8');
    const parsed = JSON.parse(raw) as { host?: string; port?: number; user?: string; password?: string };
    if (!parsed?.host || !parsed?.port) return null;
    if (role === 'admin' && parsed.user && parsed.password) {
      return `postgresql://${parsed.user}:${parsed.password}@${parsed.host}:${parsed.port}/papercusp`;
    }
    return `postgresql://harness_app:harness_app_pwd@${parsed.host}:${parsed.port}/papercusp`;
  } catch {
    return null;
  }
}

interface Config {
  schemaName?: string;
}

async function readConfig(ctx: PapercuspContext): Promise<Config> {
  const { promises: fs } = await import('node:fs');
  const { join } = await import('node:path');
  try {
    return JSON.parse(await fs.readFile(join(ctx.pluginDataDir, 'config.json'), 'utf8')) as Config;
  } catch {
    return {};
  }
}

function isValidSchemaName(s: string): boolean {
  return /^[a-z][a-z0-9_]{0,63}$/.test(s);
}

async function withClient<T>(fn: (sql: any) => Promise<T>): Promise<T> {
  // We open a fresh connection per action invocation so the substrate's
  // global pool isn't held. Caller is responsible for `await sql.end()`.
  const pg = await import('postgres');
  // Some host loaders (notably Next/Turbopack) hand back the CJS function
  // directly without a `.default` namespace wrapper, while native Node ESM
  // wraps it. Tolerate both shapes.
  const postgresFn = ((pg as any).default ?? pg) as (url: string, opts?: unknown) => any;
  const url = process.env.HARNESS_DATABASE_URL
    ?? readDiscoveryUrl('app')
    ?? 'postgresql://harness_app:harness_app_pwd@localhost:5432/papercusp';
  const sql = postgresFn(url, {
    onnotice: () => {},
    max: 1,
    idle_timeout: 1,
    connect_timeout: 5,
  });
  try {
    return await fn(sql);
  } finally {
    await sql.end({ timeout: 1 });
  }
}

const plugin: Plugin = {
  kind: 'plugin',
  name: '@papercupai/postgres-manager',
  version: '0.1.0',
  papercusp: '^0.1.0',
  description: 'Reserve a per-plugin Postgres schema and run migrations against it.',
  capabilities: ['db:plugin-schema'],
  actions: [
    {
      name: 'migrate',
      label: 'Run pending migrations',
      surfaces: ['harness-toolbar'],
      capabilities: ['db:plugin-schema'],
      serverHandler: { timeoutSec: 30 },
    },
    {
      name: 'inspect',
      label: 'Inspect schema',
      surfaces: ['harness-toolbar'],
      capabilities: ['db:plugin-schema'],
      serverHandler: { timeoutSec: 5 },
    },
    {
      name: 'reset',
      label: 'Drop + recreate schema',
      surfaces: ['harness-toolbar'],
      capabilities: ['db:plugin-schema'],
      serverHandler: { timeoutSec: 15 },
    },
  ],
  async init(ctx) {
    ctx.actions.register('inspect', async (innerCtx) => {
      const cfg = await readConfig(innerCtx);
      const schema = cfg.schemaName ?? 'plugin_local';
      if (!isValidSchemaName(schema)) {
        return { ok: false, error: `postgres-manager: invalid schemaName "${schema}"` };
      }
      try {
        return await withClient(async (sql) => {
          const tables = await sql<Array<{ table_name: string }>>`
            SELECT table_name
              FROM information_schema.tables
              WHERE table_schema = ${schema}
              ORDER BY table_name
          `;
          return { ok: true, result: { schema, tables: tables.map((t: any) => t.table_name) } };
        });
      } catch (e: any) {
        return { ok: false, error: `postgres-manager: ${e?.message ?? e}` };
      }
    });

    ctx.actions.register('migrate', async (innerCtx, params) => {
      const cfg = await readConfig(innerCtx);
      const schema = cfg.schemaName ?? 'plugin_local';
      if (!isValidSchemaName(schema)) {
        return { ok: false, error: `postgres-manager: invalid schemaName "${schema}"` };
      }
      const dryRun = ((params ?? {}) as { dryRun?: boolean }).dryRun === true;
      try {
        return await withClient(async (sql) => {
          if (dryRun) {
            // Dry-run: just check the schema exists.
            const exists = await sql<Array<{ exists: boolean }>>`
              SELECT EXISTS (
                SELECT 1 FROM information_schema.schemata WHERE schema_name = ${schema}
              ) AS exists
            `;
            return { ok: true, result: { dryRun: true, schemaExists: Boolean(exists[0]?.exists), schema } };
          }
          // Real path: ensure schema + bookkeeping table exist.
          await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
          await sql.unsafe(`CREATE TABLE IF NOT EXISTS "${schema}"._migrations (
            id BIGSERIAL PRIMARY KEY,
            name TEXT NOT NULL UNIQUE,
            applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )`);
          return { ok: true, result: { schema, applied: ['__bootstrap__'] } };
        });
      } catch (e: any) {
        return { ok: false, error: `postgres-manager: ${e?.message ?? e}` };
      }
    });

    ctx.actions.register('reset', async (innerCtx, params) => {
      const cfg = await readConfig(innerCtx);
      const schema = cfg.schemaName ?? 'plugin_local';
      if (!isValidSchemaName(schema)) {
        return { ok: false, error: `postgres-manager: invalid schemaName "${schema}"` };
      }
      const confirm = ((params ?? {}) as { confirm?: boolean }).confirm === true;
      if (!confirm) {
        return { ok: false, error: 'postgres-manager: reset requires params.confirm=true (destructive)' };
      }
      try {
        return await withClient(async (sql) => {
          await sql.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
          await sql.unsafe(`CREATE SCHEMA "${schema}"`);
          return { ok: true, result: { schema, action: 'dropped+recreated' } };
        });
      } catch (e: any) {
        return { ok: false, error: `postgres-manager: ${e?.message ?? e}` };
      }
    });
  },
};

export default plugin;
