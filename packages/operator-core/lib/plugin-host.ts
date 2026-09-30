/**
 * Phase 6b item 4 — gated context construction (server-side).
 *
 * Builds the runtime objects each plugin sees when its hooks fire / its
 * UI mounts / its API routes execute:
 *
 *   - PapercuspContext  — install-scoped paths, log, action registry
 *   - PapercuspApi      — capability-gated DI container (via plugin-loader's
 *                         createPapercuspApi factory, fed real services
 *                         this module wires here)
 *
 * Real services are backed by `@papercusp/db-org` (Postgres) or filesystem.
 * Methods with no canonical backing today (cron-routine upsert that needs a
 * cron parser, comment streams beyond audit) throw `NotYetWiredError` so
 * plugins fail loudly rather than silently no-op.
 *
 * No call site yet — exposing the helpers is item 4; wiring orchestrator
 * lifecycle hooks (item 1) and apiRoutes (item 2) come next and consume
 * `buildPluginRuntime()` per-plugin.
 */

import { promises as fs } from 'node:fs';
import { join, normalize, resolve } from 'node:path';
import {
  type Capability,
  type PapercuspApi,
  type PapercuspContext,
  type Plugin,
  type PluginActionRegistry,
  type PluginDb,
  type PluginStorage,
  type SecretsService,
  type TasksService,
  type GoalsService,
  type GoalRow,
  type PendingEventsService,
  type RoutinesService,
  type CommentsService,
} from '@papercusp/plugin-sdk';
import {
  createPapercuspApi,
  type RealServices,
} from '@papercusp/plugin-loader';
import {
  getOrgPg,
  getFeatureLineage,
  listGoals,
  createGoal,
  listUnconsumedEvents,
  fireRoutine,
  deleteRoutine,
  slugToSchemaName,
} from '@papercusp/db-org';

import { papercuspPath, papercuspRoot } from './papercusp-root';
import { activeWorkspaceId } from './workspace-registry';
function SECRETS_DIR() { return papercuspPath('secrets'); }

class NotYetWiredError extends Error {
  constructor(method: string) {
    super(`${method} not yet wired in the host runtime — see ./plugin-host-runtime.ts`);
    this.name = 'NotYetWiredError';
  }
}

/* ─────────────────────────────────────────────────────────────────────
 * Path helpers
 * ───────────────────────────────────────────────────────────────────── */

function defaultProjectDir(slug: string): string {
  return join(papercuspRoot(), 'harnesses', slug);
}

function defaultStateDir(slug: string): string {
  return join(defaultProjectDir(slug), '.papercusp');
}

function defaultPluginDataDir(slug: string, pluginName: string): string {
  // Plugin name may have package-style chars; normalize to fs-safe.
  const safe = pluginName.replace(/[^a-zA-Z0-9._-]/g, '_');
  return join(defaultStateDir(slug), 'plugins', safe);
}

function pluginSchema(pluginName: string): string {
  return `plugin_${pluginName.replace(/[^a-zA-Z0-9_]/g, '_')}`;
}

/* ─────────────────────────────────────────────────────────────────────
 * Real services — Postgres-backed (using db-org helpers, no raw SQL).
 *
 * Methods that have no current canonical helper throw NotYetWiredError;
 * they'll be filled in as orchestrator hooks (item 1) wire them through.
 * ───────────────────────────────────────────────────────────────────── */

function realTasksService(slug: string): TasksService {
  const orgHandle = getOrgPg();
  const sql = orgHandle.sql;
  const schemaName = slugToSchemaName(slug);
  return {
    async list() {
      // Cap-gated read; plugin-side filtering via opts is allowed but doesn't
      // change the cap — tasks:read covers any list shape.
      throw new NotYetWiredError('tasks.list');
    },
    async get(_id) {
      throw new NotYetWiredError('tasks.get');
    },
    async lineage(id) {
      const lin = await getFeatureLineage(sql, schemaName, slug, id);
      return lin.map((row) => ({
        level: row.level,
        kind: row.kind,
        id: row.id,
        title: row.title,
      }));
    },
    async create(_input) {
      throw new NotYetWiredError('tasks.create');
    },
    async setStatus(_id, _status) {
      throw new NotYetWiredError('tasks.setStatus');
    },
  };
}

function realGoalsService(slug: string): GoalsService {
  const orgHandle = getOrgPg();
  const sql = orgHandle.sql;
  return {
    list: async (): Promise<GoalRow[]> => {
      const rows = await listGoals(sql, slug);
      return rows.map((r) => ({
        id: r.id,
        installSlug: slug,
        title: r.title,
        body: r.body ?? null,
        parentId: r.parentId ?? null,
        budgetCents: r.budgetCents ?? null,
        status: r.status,
      }));
    },
    get: async (id) => {
      const rows = await listGoals(sql, slug);
      const r = rows.find((g) => g.id === id);
      if (!r) return null;
      return {
        id: r.id,
        installSlug: slug,
        title: r.title,
        body: r.body ?? null,
        parentId: r.parentId ?? null,
        budgetCents: r.budgetCents ?? null,
        status: r.status,
      };
    },
    create: async (input) => {
      await createGoal(sql, {
        id: input.id,
        installSlug: slug,
        title: input.title,
        body: input.body ?? null,
        parentId: input.parentId ?? null,
        budgetCents: input.budgetCents ?? null,
      });
      // createGoal returns { id } only; rehydrate via listGoals.
      const rows = await listGoals(sql, slug);
      const r = rows.find((g) => g.id === input.id);
      if (!r) throw new Error(`goals.create: row not found after insert for ${input.id}`);
      return {
        id: r.id,
        installSlug: slug,
        title: r.title,
        body: r.body ?? null,
        parentId: r.parentId ?? null,
        budgetCents: r.budgetCents ?? null,
        status: r.status,
      };
    },
  };
}

function realPendingEventsService(slug: string): PendingEventsService {
  const orgHandle = getOrgPg();
  const sql = orgHandle.sql;
  return {
    listUnconsumed: async () => {
      // P-041: scope to the active workspace (resolved at call time from the
      // request/exec ALS). getOrgPg bypasses RLS and install_slug isn't
      // workspace-unique, so an unscoped read would surface other workspaces'
      // events for a colliding slug.
      const events = await listUnconsumedEvents(sql, slug, { workspaceId: activeWorkspaceId() });
      return events.map((e) => ({
        id: e.id,
        kind: e.kind,
        targetRole: e.targetRole,
        payload: e.payload,
        dueAt: e.dueAt ? new Date(e.dueAt as any).toISOString() : null,
      }));
    },
  };
}

function realRoutinesService(slug: string): RoutinesService {
  const orgHandle = getOrgPg();
  const sql = orgHandle.sql;
  return {
    list: async () => {
      // Direct query — no list-all helper in db-org yet.
      // Workspace-scoped via withWorkspace would be cleaner; for now we
      // rely on harness_admin (RLS-bypass) and the install_slug filter.
      const rows = await sql<any[]>`
        SELECT id, name, trigger_kind, target_role, next_fire_at, active
          FROM harness_shared.routines
         WHERE install_slug = ${slug}
      `;
      return rows.map((r: any) => ({
        id: String(r.id),
        name: r.name,
        triggerKind: r.trigger_kind,
        targetRole: r.target_role,
        nextFireAt: r.next_fire_at ? new Date(r.next_fire_at).toISOString() : null,
        active: !!r.active,
      }));
    },
    upsert: async (_definition) => {
      // Needs a cron parser injected (db-org's upsertRoutine takes a
      // computeNextFireAt callback). v1 of the host runtime keeps this
      // unwired; substrate-managed routines should use the dedicated
      // /api/harness/<slug>/routines endpoint instead.
      throw new NotYetWiredError('routines.upsert (use the substrate routines endpoint)');
    },
    delete: async (name) => {
      await deleteRoutine(sql, slug, name);
    },
    trigger: async (name, payload) => {
      const rows = await sql<any[]>`
        SELECT * FROM harness_shared.routines
         WHERE install_slug = ${slug} AND name = ${name}
         LIMIT 1
      `;
      if (!rows.length) throw new Error(`routine "${name}" not found for ${slug}`);
      const routine = {
        ...rows[0],
        installSlug: rows[0].install_slug,
        triggerKind: rows[0].trigger_kind,
        triggerConfig: rows[0].trigger_config ?? {},
        targetRole: rows[0].target_role,
        payloadTemplate: { ...(rows[0].payload_template ?? {}), ...(payload ?? {}) },
      };
      const fired = await fireRoutine(sql, routine as any, () => null);
      if (!fired) throw new Error(`routine "${name}" was skipped (concurrency policy)`);
      return { eventId: fired.eventId };
    },
  };
}

function realCommentsService(_slug: string): CommentsService {
  return {
    list: async (_taskId) => { throw new NotYetWiredError('comments.list'); },
    create: async (_taskId, _body) => { throw new NotYetWiredError('comments.create'); },
  };
}

function realSecretsService(): SecretsService {
  return {
    read: async (name) => {
      const safe = name.replace(/[^A-Z0-9_]/gi, '_');
      const path = join(SECRETS_DIR(), safe);
      try {
        const v = await fs.readFile(path, 'utf8');
        return v.trimEnd();
      } catch {
        // Fallback to env var (matches existing slack-notifier convention).
        const envVal = process.env[name];
        if (typeof envVal === 'string') return envVal;
        throw new Error(`secret "${name}" not found at ${path} or process.env.${name}`);
      }
    },
  };
}

function realStorage(slug: string, pluginName: string, dataDir: string): PluginStorage {
  void slug; void pluginName;
  const baseDir = dataDir;

  function safe(rel: string): string {
    const target = resolve(baseDir, rel);
    const root = resolve(baseDir);
    const norm = normalize(target);
    if (!norm.startsWith(root + '/') && norm !== root) {
      throw new Error(`storage path escape rejected: "${rel}"`);
    }
    return norm;
  }

  return {
    read: async (path) => {
      try {
        return await fs.readFile(safe(path));
      } catch (e: any) {
        if (e?.code === 'ENOENT') return null;
        throw e;
      }
    },
    write: async (path, data) => {
      const full = safe(path);
      await fs.mkdir(join(full, '..'), { recursive: true });
      await fs.writeFile(full, data);
    },
    delete: async (path) => {
      try { await fs.unlink(safe(path)); } catch (e: any) { if (e?.code !== 'ENOENT') throw e; }
    },
    list: async (prefix) => {
      try {
        const root = prefix ? safe(prefix) : baseDir;
        const out: string[] = [];
        const stack: string[] = [root];
        while (stack.length) {
          const dir = stack.pop()!;
          let entries;
          try { entries = await fs.readdir(dir, { withFileTypes: true }); }
          catch (e: any) { if (e?.code === 'ENOENT') continue; throw e; }
          for (const ent of entries) {
            const full = join(dir, ent.name);
            if (ent.isDirectory()) stack.push(full);
            else out.push(full.slice(baseDir.length + 1));
          }
        }
        return out;
      } catch {
        return [];
      }
    },
  };
}

function realPluginDb(pluginName: string): PluginDb {
  const orgHandle = getOrgPg();
  const sql = orgHandle.sql;
  const schema = pluginSchema(pluginName);
  return {
    query: async <T = unknown>(sqlText: string, params: unknown[] = []) => {
      const wrapped = `SET LOCAL search_path TO ${schema}, public; ${sqlText}`;
      // postgres-js doesn't expose unsafe directly here as a typed surface,
      // but the underlying sql object does. Cast accordingly.
      return await (sql as any).unsafe(wrapped, params) as unknown as T[];
    },
    exec: async (sqlText: string, params: unknown[] = []) => {
      const wrapped = `SET LOCAL search_path TO ${schema}, public; ${sqlText}`;
      await (sql as any).unsafe(wrapped, params);
    },
  };
}

/* ─────────────────────────────────────────────────────────────────────
 * Action registry — minimal in-memory shim for context construction.
 * The real impl lives in @papercusp/plugin-loader/actions.ts; this stub
 * keeps init() callable until that's wired through.
 * ───────────────────────────────────────────────────────────────────── */

interface ActionRegistryHandle extends PluginActionRegistry {
  closeInitWindow: () => void;
}

function makeStubActionRegistry(pluginName: string): ActionRegistryHandle {
  const handlers = new Map<string, unknown>();
  let initClosed = false;
  return {
    register: (name: string, handler: unknown) => {
      if (initClosed) {
        throw new Error(
          `action.register("${name}") called after init() returned for plugin "${pluginName}". ` +
          `Move the registration into init().`
        );
      }
      handlers.set(name, handler);
    },
    closeInitWindow: () => { initClosed = true; },
  } as unknown as ActionRegistryHandle;
}

/* ─────────────────────────────────────────────────────────────────────
 * Public API
 * ───────────────────────────────────────────────────────────────────── */

export interface BuildPluginRuntimeOptions {
  /** Harness slug. */
  slug: string;
  /** Loaded plugin (must have name + capabilities[]). */
  plugin: Plugin;
  /** Optional override for the plugin's data dir. */
  pluginDataDir?: string;
  /** Optional override for the install's project dir. */
  projectDir?: string;
  /** Optional override for the install's state dir. */
  stateDir?: string;
  /** Optional plugin-scoped logger. Defaults to console.log with a prefix. */
  log?: (msg: string) => void;
}

export interface PluginRuntime {
  ctx: PapercuspContext;
  api: PapercuspApi;
  /** Closes the action registration window — call after init() returns. */
  closeInitWindow: () => void;
}

/**
 * Build a per-plugin {ctx, api} pair the host can pass to init() and
 * lifecycle handlers. The ctx + api are scoped to (slug, plugin) — each
 * plugin gets its own gated view; capabilities are checked at method-call
 * time inside the api proxies.
 *
 * Real services are constructed eagerly (cheap — they're just closures over
 * the shared Postgres pool). The proxy wrapping is also cheap. Calls into
 * Postgres only happen when the plugin actually invokes a service method.
 */
export function buildPluginRuntime(opts: BuildPluginRuntimeOptions): PluginRuntime {
  const { slug, plugin } = opts;
  const projectDir = opts.projectDir ?? defaultProjectDir(slug);
  const stateDir = opts.stateDir ?? defaultStateDir(slug);
  const dataDir = opts.pluginDataDir ?? defaultPluginDataDir(slug, plugin.name);
  const log = opts.log ?? ((msg: string) => console.log(`[plugin:${plugin.name}] ${msg}`));

  const actionRegistry = makeStubActionRegistry(plugin.name);

  const ctx: PapercuspContext = {
    installSlug: slug,
    projectDir,
    stateDir,
    pluginDataDir: dataDir,
    log,
    actions: actionRegistry,
  };

  const services: RealServices = {
    tasks: realTasksService(slug),
    goals: realGoalsService(slug),
    pendingEvents: realPendingEventsService(slug),
    routines: realRoutinesService(slug),
    comments: realCommentsService(slug),
    secrets: realSecretsService(),
    storage: realStorage(slug, plugin.name, dataDir),
    db: realPluginDb(plugin.name),
    fetch: globalThis.fetch.bind(globalThis),
  };

  const api = createPapercuspApi({
    ctx: { pluginName: plugin.name, capabilities: (plugin.capabilities ?? []) as Capability[] },
    services,
  });

  return {
    ctx,
    api,
    closeInitWindow: () => actionRegistry.closeInitWindow(),
  };
}

export { NotYetWiredError };
export type { Plugin, PapercuspContext, PapercuspApi };
