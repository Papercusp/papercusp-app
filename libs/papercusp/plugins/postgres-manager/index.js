"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
async function readConfig(ctx) {
    const { promises: fs } = await Promise.resolve().then(() => __importStar(require('node:fs')));
    const { join } = await Promise.resolve().then(() => __importStar(require('node:path')));
    try {
        return JSON.parse(await fs.readFile(join(ctx.pluginDataDir, 'config.json'), 'utf8'));
    }
    catch {
        return {};
    }
}
function isValidSchemaName(s) {
    return /^[a-z][a-z0-9_]{0,63}$/.test(s);
}
async function withClient(fn) {
    // We open a fresh connection per action invocation so the substrate's
    // global pool isn't held. Caller is responsible for `await sql.end()`.
    const pg = await Promise.resolve().then(() => __importStar(require('postgres')));
    // Some host loaders (notably Next/Turbopack) hand back the CJS function
    // directly without a `.default` namespace wrapper, while native Node ESM
    // wraps it. Tolerate both shapes.
    const postgresFn = (pg.default ?? pg);
    const url = process.env.HARNESS_DATABASE_URL
        ?? 'postgresql://harness_app:harness_app_pwd@localhost:5432/papercusp';
    const sql = postgresFn(url, {
        onnotice: () => { },
        max: 1,
        idle_timeout: 1,
        connect_timeout: 5,
    });
    try {
        return await fn(sql);
    }
    finally {
        await sql.end({ timeout: 1 });
    }
}
const plugin = {
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
                    const tables = await sql `
            SELECT table_name
              FROM information_schema.tables
              WHERE table_schema = ${schema}
              ORDER BY table_name
          `;
                    return { ok: true, result: { schema, tables: tables.map((t) => t.table_name) } };
                });
            }
            catch (e) {
                return { ok: false, error: `postgres-manager: ${e?.message ?? e}` };
            }
        });
        ctx.actions.register('migrate', async (innerCtx, params) => {
            const cfg = await readConfig(innerCtx);
            const schema = cfg.schemaName ?? 'plugin_local';
            if (!isValidSchemaName(schema)) {
                return { ok: false, error: `postgres-manager: invalid schemaName "${schema}"` };
            }
            const dryRun = (params ?? {}).dryRun === true;
            try {
                return await withClient(async (sql) => {
                    if (dryRun) {
                        // Dry-run: just check the schema exists.
                        const exists = await sql `
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
            }
            catch (e) {
                return { ok: false, error: `postgres-manager: ${e?.message ?? e}` };
            }
        });
        ctx.actions.register('reset', async (innerCtx, params) => {
            const cfg = await readConfig(innerCtx);
            const schema = cfg.schemaName ?? 'plugin_local';
            if (!isValidSchemaName(schema)) {
                return { ok: false, error: `postgres-manager: invalid schemaName "${schema}"` };
            }
            const confirm = (params ?? {}).confirm === true;
            if (!confirm) {
                return { ok: false, error: 'postgres-manager: reset requires params.confirm=true (destructive)' };
            }
            try {
                return await withClient(async (sql) => {
                    await sql.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
                    await sql.unsafe(`CREATE SCHEMA "${schema}"`);
                    return { ok: true, result: { schema, action: 'dropped+recreated' } };
                });
            }
            catch (e) {
                return { ok: false, error: `postgres-manager: ${e?.message ?? e}` };
            }
        });
    },
};
exports.default = plugin;
