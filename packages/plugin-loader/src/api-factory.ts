/**
 * Phase 6b item 3 — DI container factory.
 *
 * Builds a `PapercuspApi` for a single plugin by wrapping host-provided
 * "real services" with capability-checking proxies. The factory itself is
 * storage-agnostic — it never sees Postgres, files, or the network.
 * The host (apps/papercusp/...) passes in concrete service implementations.
 *
 * Architecture:
 *
 *   host-side service implementations (Postgres-backed)
 *                  │
 *                  ▼
 *   createPapercuspApi({ ctx, services })
 *                  │
 *                  ▼  wraps each real service in a capability-checking Proxy
 *                  │  (using `wrapServiceWithCaps` from ./capabilities)
 *                  │
 *                  ▼
 *   PapercuspApi exposed to the plugin via init() / hooks
 *
 * Capability checks happen at method-call time, not service-construct time.
 * Plugins receive the wrapped API and call methods normally; the proxy
 * throws `MissingCapabilityError` if the plugin's manifest didn't declare
 * the cap the method requires.
 *
 * Service definitions (the ServiceDef shapes below) are the canonical
 * mapping between SDK service interfaces and capability strings. Adding a
 * new method to a service interface = adding it to the matching def here.
 */

import type {
  Capability,
  PapercuspApi,
  TasksService,
  GoalsService,
  PendingEventsService,
  RoutinesService,
  CommentsService,
  SecretsService,
  PluginFetch,
  PluginStorage,
  PluginDb,
  ServiceDef,
} from '@papercusp/plugin-sdk';
import {
  type CapabilityCheckContext,
  wrapServiceWithCaps,
  makeFetchProxy,
  makeSecretsProxy,
} from './capabilities';

/* ─────────────────────────────────────────────────────────────────────
 * Service definitions — capability-check metadata for each typed service.
 * Each method names the capability the plugin needs to invoke it.
 * ───────────────────────────────────────────────────────────────────── */

export const TasksServiceDef: ServiceDef = {
  name: 'tasks',
  methods: {
    list:      { capability: 'tasks:read' },
    get:       { capability: 'tasks:read' },
    lineage:   { capability: 'tasks:read' },
    create:    { capability: 'tasks:write' },
    setStatus: { capability: 'tasks:write' },
  },
};

export const GoalsServiceDef: ServiceDef = {
  name: 'goals',
  methods: {
    list:   { capability: 'goals:read' },
    get:    { capability: 'goals:read' },
    create: { capability: 'goals:write' },
  },
};

export const PendingEventsServiceDef: ServiceDef = {
  name: 'pendingEvents',
  // Reading the pending-events queue is part of the orchestrator's
  // input set — gating it on tasks:read keeps the cap surface small.
  methods: {
    listUnconsumed: { capability: 'tasks:read' },
  },
};

export const RoutinesServiceDef: ServiceDef = {
  name: 'routines',
  methods: {
    list:    { capability: 'routines:read' },
    upsert:  { capability: 'routines:write' },
    delete:  { capability: 'routines:write' },
    trigger: { capability: 'routines:write' },
  },
};

export const CommentsServiceDef: ServiceDef = {
  name: 'comments',
  methods: {
    list:   { capability: 'comments:read' },
    create: { capability: 'comments:write' },
  },
};

// Secrets uses a resource-scoped capability — `secrets:read:<NAME>`. Each
// call's required cap depends on the runtime arg, so we use a function form.
export const SecretsServiceDef: ServiceDef = {
  name: 'secrets',
  methods: {
    read: {
      capability: ((name: string) => `secrets:read:${name}` as Capability) as ServiceDef['methods']['read']['capability'],
    },
  },
};

// PluginStorage is always granted (per SDK comment). We still use the proxy
// so plugins can't poke at non-declared methods.
export const PluginStorageDef: ServiceDef = {
  name: 'storage',
  methods: {
    read:   { capability: 'storage:plugin-private' },
    write:  { capability: 'storage:plugin-private' },
    delete: { capability: 'storage:plugin-private' },
    list:   { capability: 'storage:plugin-private' },
  },
};

export const PluginDbDef: ServiceDef = {
  name: 'db',
  methods: {
    query: { capability: 'db:plugin-schema' },
    exec:  { capability: 'db:plugin-schema' },
  },
};

/* ─────────────────────────────────────────────────────────────────────
 * Real-services bundle — host implements these and hands them to the
 * factory. Each must satisfy the matching SDK service interface.
 * ───────────────────────────────────────────────────────────────────── */

export interface RealServices {
  tasks: TasksService;
  goals: GoalsService;
  pendingEvents: PendingEventsService;
  routines: RoutinesService;
  comments: CommentsService;
  secrets: SecretsService;
  storage: PluginStorage;
  db: PluginDb;
  /** Real fetch — usually `globalThis.fetch`. */
  fetch?: typeof fetch;
}

export interface CreatePapercuspApiInput {
  /** Plugin name + capability list. */
  ctx: CapabilityCheckContext;
  /** Host-built real services to wrap. */
  services: RealServices;
}

/**
 * Build a capability-gated PapercuspApi for a single plugin.
 *
 * The plugin receives the returned object via `ctx.api` in its UI components
 * and via the hook-bus payload in its `init()` and lifecycle handlers.
 *
 * Method calls flow:  plugin → proxy.method() → cap check → real service
 *
 * Cap violations throw synchronously (`MissingCapabilityError`); plugins
 * can `try/catch` if they want to degrade gracefully when a cap is missing.
 */
export function createPapercuspApi(input: CreatePapercuspApiInput): PapercuspApi {
  const { ctx, services } = input;
  const realFetch = services.fetch ?? globalThis.fetch.bind(globalThis);

  const tasks       = wrapServiceWithCaps(ctx, services.tasks         as any, TasksServiceDef)         as unknown as TasksService;
  const goals       = wrapServiceWithCaps(ctx, services.goals         as any, GoalsServiceDef)         as unknown as GoalsService;
  const pendingEvts = wrapServiceWithCaps(ctx, services.pendingEvents as any, PendingEventsServiceDef) as unknown as PendingEventsService;
  const routines    = wrapServiceWithCaps(ctx, services.routines      as any, RoutinesServiceDef)      as unknown as RoutinesService;
  const comments    = wrapServiceWithCaps(ctx, services.comments      as any, CommentsServiceDef)      as unknown as CommentsService;
  const storage     = wrapServiceWithCaps(ctx, services.storage       as any, PluginStorageDef)        as unknown as PluginStorage;
  const db          = wrapServiceWithCaps(ctx, services.db            as any, PluginDbDef)             as unknown as PluginDb;

  // Secrets + fetch use their own non-method-proxy gates (cap is per-call,
  // resource-scoped on a runtime arg). makeSecretsProxy expects a resolver
  // function, not a service; rebind the host service's read() into a fn.
  const secretResolver = (name: string) => services.secrets.read(name);
  const secrets: SecretsService = makeSecretsProxy(ctx, secretResolver) as SecretsService;
  const pluginFetch: PluginFetch = makeFetchProxy(ctx, realFetch);

  return {
    tasks,
    goals,
    pendingEvents: pendingEvts,
    routines,
    comments,
    secrets,
    fetch: pluginFetch,
    storage,
    db,
    capabilities: () => [...ctx.capabilities],
  };
}
