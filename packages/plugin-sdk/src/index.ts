/**
 * @papercusp/plugin-sdk — type definitions for Papercusp plugins.
 *
 * Plugins extend a Papercusp install with MCP tools, lifecycle hooks,
 * dashboard tabs, API routes, Postgres schemas, full UI panels, and event
 * hooks. Capabilities (declarative permissions) gate every non-trivial
 * action. (The run-loop-era roles + routines axes were retired 2026-06-12 —
 * plugin-system-hive-port D-004; blueprints + event-reaction rules are the
 * successors.)
 *
 * Stability: pre-1.0. Spec at apps/papercusp-spec/ (dev: http://localhost:4324/).
 */

import type { ComponentType } from 'react';
// Wire types — the transport-facing shapes — are owned by the tool framework.
// Imported for local use; re-exported below so plugin-sdk consumers are
// unaffected. Dependency inversion: plan papercusp-tooldef-extraction (D-004).
import type {
  AgentRole,
  RolesQuota,
  ToolResult,
  ProgressCallback,
  EmitCallback,
} from '@papercusp/tooldef';

/* ─────────────────────────────────────────────────────────────────────
 * Capabilities — declarative permission strings.
 *
 * Format: namespace:action[:resource]
 *
 * - Manifest declares them up-front
 * - DI container enforces at every service-method call
 * - Iframe sandbox enforces network ones via CSP
 * - Install-time consent prompts the user
 *
 * See §10 of the Papercusp spec (apps/papercusp-spec/, /spec/capabilities/) for the full model.
 * ───────────────────────────────────────────────────────────────────── */

export type Capability =
  // Data access (the DI container's read/write methods are gated by these).
  | 'tasks:read' | 'tasks:write'
  | 'features:read' | 'features:write'
  | 'comments:read' | 'comments:write'
  | 'goals:read' | 'goals:write'
  | 'projects:read' | 'projects:write'

  // Plugin's own resources (always granted; declarative for clarity).
  | 'storage:plugin-private'
  | 'db:plugin-schema'

  // Routines.
  | 'routines:read' | 'routines:write'

  // UI surfaces this plugin claims.
  | 'ui:dashboard-tab'
  | 'ui:sidebar-item'
  | 'ui:harness-route'         // owns /harness/<install-slug>
  | 'ui:tui-pane'             // contributes a terminal pane hosted by the pui (D-002)

  // Network — manifest declares allowed domains; iframe CSP enforces.
  // Use as: 'http:fetch:youtube.com', 'http:fetch:*.googleapis.com'
  | `http:fetch:${string}`

  // Secrets — by name, no wildcard. e.g. 'secrets:read:YOUTUBE_API_KEY'.
  | `secrets:read:${string}`
  | `secrets:write:${string}`

  // Events. `events:emit:<name>` gates plugin-emitted events (WASM event
  // sink / cross-plugin signals); `events:listen:<trigger>` gates a reaction
  // rule's `on` trigger (each rule's trigger key must be declared — the
  // consent surface for what the plugin watches).
  | `events:emit:${string}`
  | `events:listen:${string}`

  // Roles. e.g. 'roles:register:narrator'.
  | `roles:register:${string}`

  // Subprocess execution — manifest declares each binary the plugin's
  // `ctx.spawn(bin, args)` may invoke. e.g. 'compute:exec:ffmpeg'.
  // Wildcards (`compute:exec:py-*`) match the binary basename.
  | `compute:exec:${string}`

  // MCP tools contributed to agents. Manifest declares each tool by name;
  // the agent-mcp host gates per-call invocations against the plugin's
  // declared `tools:<name>` capability. Tool names use dotted prefixes
  // (e.g. 'tools:repomix:pack', 'tools:gitnexus:impact').
  | `tools:${string}`

  // Orchestrator agent-spawn capability — per-role gating. e.g.
  // 'tools:orchestrator:spawn:worker' allows spawning a worker child.
  // Distinct from the generic `tools:<name>` because spawn is meta-tool
  // requiring its own risk-tier review at install time.
  | `tools:orchestrator:spawn:${string}`;


/* ─────────────────────────────────────────────────────────────────────
 * Plugin context passed at load time and on every hook invocation.
 * ───────────────────────────────────────────────────────────────────── */

/**
 * Lifecycle context: filesystem paths + log surface.
 */
export interface PapercuspContext {
  /** Slug of the harness install this plugin instance is running inside. */
  installSlug: string;
  /** Absolute path to the install's project root. */
  projectDir: string;
  /** Absolute path to the install's `.papercusp/` directory (legacy file state). */
  stateDir: string;
  /** Plugin-private storage path under `<stateDir>/plugins/<plugin-name>/`. */
  pluginDataDir: string;
  /** Plugin-scoped logger; output goes to the harness run log. */
  log: (msg: string) => void;
  /**
   * Action registry — plugins call `ctx.actions.register(name, handler)` from
   * `init()` to bind handlers for the actions declared in their manifest.
   * Sealed by the host after `init()` returns. Optional because `fire-hook`
   * CLI invocations don't need it; the in-process host always provides it.
   */
  actions?: PluginActionRegistry;

  /**
   * Capability-gated subprocess spawn. Plugins call
   * `ctx.spawn('ffmpeg', ['-i', input, output], { cwd, env, stdin })`
   * and receive `{stdout, stderr, code}` after the process exits.
   *
   * The host enforces `compute:exec:<binary-basename>` against the plugin's
   * declared capabilities before invoking. The provided `bin` is resolved
   * via PATH; absolute paths are rejected (use the binary name + caps).
   *
   * Optional — `fire-hook` CLI invocations don't get a spawn surface.
   */
  spawn?: PluginSpawn;

  /**
   * Plugin-private key/value store. Optional because `fire-hook` CLI
   * invocations don't have a backing store; the in-process operator
   * host always provides it. See `PluginKv` for quota semantics.
   */
  kv?: PluginKv;

  /**
   * OAuth helper — acquires a fresh access token for the named provider,
   * refreshing the stored refresh-token if the access token has expired.
   * Concurrent callers share a single in-flight refresh Promise to avoid
   * a refresh storm. Returns null if the user has not yet connected.
   *
   * Spec: /docs/snapshots/oauth-integration.
   */
  oauth?: {
    token(provider: string): Promise<string | null>;
  };

  /**
   * Record a resource the plugin's setup script just created so the
   * substrate can replay it on teardown. Idempotent on the
   * `(kind, externalId)` pair — duplicate calls update `metadata` only.
   *
   * Spec: /docs/snapshots/build-scripts#recovery.
   */
  recordResource?(input: {
    kind: string;
    externalId: string;
    metadata?: Record<string, unknown>;
  }): Promise<void>;
}

export interface PluginSpawnOptions {
  /** Working directory; defaults to `pluginDataDir`. */
  cwd?: string;
  /** Additional env vars merged on top of process.env. */
  env?: Record<string, string>;
  /** Stdin payload to write before closing stdin. */
  stdin?: string | Uint8Array;
  /** Hard timeout in ms; SIGKILL on expiry. Default 30s. */
  timeoutMs?: number;
  /** Max captured stdout/stderr size in bytes. Default 1 MiB each. */
  maxBufferBytes?: number;
}

export interface PluginSpawnResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** True if the process was killed by the host (timeout, abort). */
  killed: boolean;
}

export type PluginSpawn = (
  bin: string,
  args: readonly string[],
  opts?: PluginSpawnOptions,
) => Promise<PluginSpawnResult>;

/**
 * Plugin-private key/value store with quotas.
 *
 * Each plugin sees its own namespace; cross-plugin access is impossible.
 * Values are serialised as JSON. Per-key + per-plugin byte quotas are
 * enforced by the host (defaults: 10 KB/key, 1 MB/plugin). Quota
 * violations throw `KvQuotaError`.
 *
 * Backed by Postgres in production (operator) so state survives reloads
 * and is observable from the operator UI. Use `pluginDataDir` (file
 * paths) for blobs > 10 KB, code, or anything that doesn't need to be
 * scanned/aggregated.
 *
 * Surface deliberately small: `get / set / delete / list`. No
 * transactions, no atomics — high contention isn't a goal; plugins that
 * need it should use their own per-plugin PG schema.
 */
export interface PluginKv {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  /**
   * List keys with the given prefix (lexicographic). Returns at most
   * `limit` keys (default 100, max 500). Use cursor-based pagination
   * (`afterKey`) if more are needed.
   */
  list(opts?: { prefix?: string; limit?: number; afterKey?: string }): Promise<string[]>;
}

/** Thrown by `ctx.kv.set` when the per-key or per-plugin byte quota is exceeded. */
export class KvQuotaError extends Error {
  constructor(
    message: string,
    public readonly kind: 'per-key' | 'per-plugin',
    public readonly limit: number,
    public readonly attempted: number,
  ) {
    super(message);
    this.name = 'KvQuotaError';
  }
}

/**
 * Per-plugin handle for binding action implementations during `init()`.
 *
 * The host validates each `register()` call against the plugin's
 * manifest-declared `actions[]` and `capabilities[]`, then seals the
 * registry after `init()` returns. Subsequent `register()` calls throw.
 */
export interface PluginActionRegistry {
  register(
    name: string,
    handler: (
      ctx: PapercuspContext,
      params: unknown,
      signal: AbortSignal,
    ) => Promise<{ ok: boolean; result?: unknown; error?: string }> | { ok: boolean; result?: unknown; error?: string },
  ): void;
}


/* ─────────────────────────────────────────────────────────────────────
 * Lifecycle hooks — host calls these at well-known phases.
 * ───────────────────────────────────────────────────────────────────── */

export interface PluginHooks {
  /** Fires once when the plugin is loaded. */
  onLoad?(ctx: PapercuspContext): Promise<void>;
  /** Fires when the plugin is being unloaded (uninstall, host shutdown). */
  onUnload?(ctx: PapercuspContext): Promise<void>;

  /**
   * Fires once when a new harness is created (after `papercusp init`
   * succeeds; before any role runs). Plugins use this to provision
   * external resources tied to the harness — e.g. create a GitHub repo,
   * Linear team, etc. Per-harness plugin config is already on disk by
   * this point, so handlers can `readConfig(ctx)` safely.
   */
  onHarnessCreated?(ctx: PapercuspContext): Promise<void>;
  /** Fires before the harness loop's first iteration. */
  beforeMissionStart?(ctx: PapercuspContext): Promise<void>;
  /** Fires when the orchestrator decides DONE. */
  afterDone?(ctx: PapercuspContext): Promise<void>;

  /** Fires after a feature transitions to `passed`. */
  onFeaturePassed?(ctx: PapercuspContext, featureId: string): Promise<void>;
  /** Fires after `apply_proposal_to_spec` accepts a reviewer-approved proposal. */
  onProposalAccepted?(ctx: PapercuspContext, proposalPath: string): Promise<void>;

  /** Fires after the orchestrator role completes. Receives its decision verb. */
  onPostOrchestrator?(ctx: PapercuspContext, decision: string): Promise<void>;
  /** Fires after a worker role completes. Receives the feature it worked on. */
  onPostWorker?(ctx: PapercuspContext, featureId: string): Promise<void>;
  /** Fires after a validator role completes. */
  onPostValidator?(ctx: PapercuspContext, featureId: string, status: 'passed' | 'failing'): Promise<void>;

  /**
   * Operator suggestion source. Fires when the Operator scans a
   * workspace; plugins can return additional suggestions to merge into
   * the LLM's output. Each returned object follows the operator
   * suggestion schema (3 variants: send_directive | navigate | inform);
   * the Operator pipeline tier-classifies + de-dupes them like LLM
   * output, and applies the same auto_dispatch policy.
   *
   * Plugins use this to surface deterministic prompts (e.g. "Linear
   * has 3 unanswered comments on F-001") without relying on the LLM
   * to notice. Tier=high results land as ask-first by default; the
   * user can grant a standing approval to auto-dispatch.
   */
  contributeOperatorSuggestions?(
    ctx: PapercuspContext,
  ): Promise<PluginOperatorSuggestion[]>;

  /**
   * Hot-reload state preservation (Tier 3 from Batch F roadmap).
   *
   * If declared, the host calls `getStateForReload` just before the
   * plugin is unloaded for a reload (uninstall doesn't trigger this;
   * use `onUnload` for cleanup). The returned value must be
   * JSON-serialisable and ≤ 64 KiB. The host stashes it keyed by
   * (plugin_id, harness_slug); on the next `init()` for that pair,
   * `restoreFromReload(state)` is called BEFORE any other hook.
   *
   * Opt-in: the plugin's manifest must declare `hotReload:
   * { preserveState: true }`. Without that flag, the host won't call
   * either hook (avoids surprising plugin authors who didn't
   * design for it).
   *
   * Use cases: in-flight WebSocket connections that need to survive a
   * config edit, debounce timers that shouldn't reset on every code
   * change, accumulated counters that haven't been flushed to ctx.kv yet.
   */
  getStateForReload?(ctx: PapercuspContext): Promise<unknown>;
  restoreFromReload?(ctx: PapercuspContext, state: unknown): Promise<void>;
}

/**
 * Shape a plugin returns from `contributeOperatorSuggestions`. The host
 * normalizes these into the same `<suggestion>` JSON the LLM emits.
 * `id` should be deterministic so a re-scan dedups against the prior.
 */
export type PluginOperatorSuggestion =
  | {
      action: 'send_directive';
      id: string;
      title: string;
      why: string;
      reason: string;
      tier: 'low' | 'medium' | 'high';
      capability: 'messages:write';
      target_harness: string;
      directive_kind: 'Directive' | 'Decision' | 'Priority';
      directive_subject: string;
      directive_body: string;
    }
  | {
      action: 'navigate';
      id: string;
      title: string;
      why: string;
      reason: string;
      tier: 'low' | 'medium' | 'high';
      capability: null;
      target_harness: string;
      target_resource: string;
    }
  | {
      action: 'inform';
      id: string;
      title: string;
      why: string;
      reason: string;
      tier: 'low' | 'medium' | 'high';
      capability: null;
      body: string;
    };


/* ─────────────────────────────────────────────────────────────────────
 * UI contributions.
 *
 * Six axes (matching the spec):
 *   1. ui  — full route at /harness/<slug>; owns the harness's dashboard
 *   2. dashboardTabs — tabs inside the harness's dashboard
 *   3. sidebarItems — top-nav additions
 *
 * v1: React components compiled into the host bundle (Backstage style).
 * v2: Iframe-loaded bundles with capability-checked postMessage RPC
 *     (Figma style). Same manifest, different loader.
 * ───────────────────────────────────────────────────────────────────── */

export interface UiContribution {
  /** URL slug — mounted at /harness/<slug>. Must match the install's slug. */
  slug: string;
  /** Display name in the harness picker + nav. */
  label: string;
  /** Optional icon: lucide-react name (v1) or URL (v2 iframe). */
  icon?: string;
  /** Lazy-loaded React component (v1). */
  component: () => Promise<{ default: ComponentType<HarnessUIProps> }>;
  /** Optional sub-routes mounted at /harness/<slug>/<sub>. */
  subRoutes?: SubRouteContribution[];
}

export interface SubRouteContribution {
  path: string;                    // e.g. 'briefings' → /harness/<slug>/briefings
  label: string;
  component: () => Promise<{ default: ComponentType<HarnessUIProps> }>;
}

/** Props the host passes to every UI component */
export interface HarnessUIProps {
  /** Slug of the harness install. */
  slug: string;
  /** DI container — read host state via this. Capability-scoped. */
  api: PapercuspApi;
  /** Read-only? (e.g., on the public site). */
  readOnly: boolean;
}

/**
 * Structural subset of Hono's API used by the plugin host. Plugins ship
 * `app: Hono` and assert `apiRoutes: app satisfies PluginApiRoutes`. The
 * host pins Hono ^4.12; major bumps break this contract.
 */
export interface PluginApiRoutes {
  fetch(request: Request, env?: unknown, executionCtx?: unknown): Response | Promise<Response>;
}

export interface DashboardTab {
  id: string;
  label: string;
  icon?: string;
  /** React component rendered when the tab is active. */
  component: ComponentType<{ slug: string; api: PapercuspApi; readOnly: boolean }>;
}

export interface SidebarItem {
  id: string;
  label: string;
  href: string;
  icon?: string;
  /** Optional badge value (count, status). */
  badge?: () => Promise<string | number | null>;
}


/* ─────────────────────────────────────────────────────────────────────
 * Dependency-injection container exposed to plugins.
 *
 * Plugins receive this via HarnessUIProps.api or via createContext() in
 * server-side hooks. Every method is a typed proxy; the runtime checks
 * the plugin's declared capabilities before delegating to real services.
 * ───────────────────────────────────────────────────────────────────── */

export interface PapercuspApi {
  tasks: TasksService;
  goals: GoalsService;
  pendingEvents: PendingEventsService;
  routines: RoutinesService;
  comments: CommentsService;
  secrets: SecretsService;
  fetch: PluginFetch;
  storage: PluginStorage;
  db: PluginDb;
  /** Inspector — what capabilities this plugin actually has. */
  capabilities: () => Capability[];
}

export interface TaskRow {
  id: string;
  title: string;
  status: string;
  parentId: string | null;
  goalId: string | null;
  attempts: number;
  takenBy: string | null;
  expiresAt: string | null;
  metadata?: Record<string, unknown>;
}

export interface TasksService {
  /** Cap: tasks:read */
  list(opts?: { status?: string; goalId?: string; parentId?: string }): Promise<TaskRow[]>;
  /** Cap: tasks:read */
  get(id: string): Promise<TaskRow | null>;
  /** Cap: tasks:read */
  lineage(id: string): Promise<{ level: number; kind: 'task' | 'goal'; id: string; title: string }[]>;
  /** Cap: tasks:write */
  create(input: Partial<TaskRow> & { title: string }): Promise<TaskRow>;
  /** Cap: tasks:write */
  setStatus(id: string, status: string): Promise<TaskRow>;
}

export interface GoalRow {
  id: string;
  installSlug: string;
  title: string;
  body: string | null;
  parentId: string | null;
  budgetCents: number | null;
  status: string;
}

export interface GoalsService {
  /** Cap: goals:read */
  list(): Promise<GoalRow[]>;
  /** Cap: goals:read */
  get(id: string): Promise<GoalRow | null>;
  /** Cap: goals:write */
  create(input: Partial<GoalRow> & { id: string; title: string }): Promise<GoalRow>;
}

export interface PendingEventsService {
  /** Cap: tasks:read (events are part of the orchestrator's input set) */
  listUnconsumed(): Promise<{ id: string; kind: string; targetRole: string; payload: unknown; dueAt: string | null }[]>;
}

export interface RoutinesService {
  /** Cap: routines:read */
  list(): Promise<{ id: string; name: string; triggerKind: string; targetRole: string; nextFireAt: string | null; active: boolean }[]>;
  /** Cap: routines:write */
  upsert(definition: {
    name: string;
    trigger:
      | { kind: 'cron'; expr: string }
      | { kind: 'webhook'; tokenEnv?: string }
      | { kind: 'api'; method?: 'POST' | 'GET' };
    targetRole: string;
    payloadTemplate?: Record<string, unknown>;
    concurrency?: 'queue' | 'skip' | 'cancel-prev';
    catchup?: 'skip-old' | 'run-all-backlog';
  }): Promise<{ id: string }>;
  /** Cap: routines:write */
  delete(name: string): Promise<void>;
  /** Cap: routines:write — manually fire (inserts a pending_event) */
  trigger(name: string, payload?: Record<string, unknown>): Promise<{ eventId: string }>;
}

export interface CommentsService {
  /** Cap: comments:read */
  list(taskId: string): Promise<{ id: string; body: string; createdAt: string; author: string }[]>;
  /** Cap: comments:write */
  create(taskId: string, body: string): Promise<{ id: string }>;
}

export interface SecretsService {
  /** Cap: secrets:read:<NAME> for the specific name */
  read(name: string): Promise<string>;
}

/** Cap-checked fetch. Domain must appear in `http:fetch:<domain>` capability. */
export type PluginFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface PluginStorage {
  /** Cap: storage:plugin-private (always granted). Path is namespaced under plugin's dir. */
  read(path: string): Promise<Buffer | null>;
  write(path: string, data: Buffer | string): Promise<void>;
  delete(path: string): Promise<void>;
  list(prefix?: string): Promise<string[]>;
}

export interface PluginDb {
  /** Cap: db:plugin-schema. Returns a Drizzle-compatible client scoped to plugin_<name>. */
  query<T = unknown>(sql: string, params?: unknown[]): Promise<T[]>;
  exec(sql: string, params?: unknown[]): Promise<void>;
}


/* ─────────────────────────────────────────────────────────────────────
 * Event-reaction rules — the plugin extension surface for "when X, fire Y"
 * (plugin-system-hive-port-2026-06-11 D-003; event-reaction-system D-012).
 *
 * The WordPress-style hook bus (addAction/addFilter) was RETIRED 2026-06-12:
 * it had zero registered consumers and its invocations bypassed dispatch
 * (no audit, no capability gating at fire time). Plugins now hook the host
 * by declaring REACTION RULES: when trigger `on` settles (a tool invocation
 * observed at the dispatcher, or a host emission like `pipeline:step-done`),
 * the host fires the rule's target tool through NORMAL dispatch — auth-gated,
 * quota'd, audited, loop-protected. The fire target must be one of the
 * plugin's OWN tools, and the rule runs under a principal holding only the
 * rule's capability.
 * ───────────────────────────────────────────────────────────────────── */

/**
 * The event a plugin rule's `when` / `args` functions see. A flattened
 * tool-invocation (or host-emitted synthetic event): `tool` is the trigger
 * key, `result.data` the trigger's parsed return value (for a host emission,
 * the emission payload).
 */
export interface PluginReactionEvent {
  tool: string;
  args: unknown;
  result: { ok: boolean; data?: unknown; error?: { code: string; message: string } };
}

/**
 * A declarative reaction rule a plugin contributes. Entry-point plugins may
 * use function forms for `when` / `args`; manifest-only plugins are limited
 * to the declarative forms (a data-match object / a static args object).
 *
 * Capability contract:
 *  - the manifest must declare `events:listen:<on>` for each trigger key;
 *  - `fire` must name one of THIS plugin's projected tools (`<plugin>.<verb>`);
 *  - the reaction runs sandboxed to `capability` (default: the fired tool's
 *    declared capability), so the rule can only do what the plugin could.
 */
export interface PluginReactionRule {
  /** Unique within the plugin. The host registers it as `plugin:<name>:<id>`. */
  id: string;
  /** Trigger key(s): a tool MCP name (`work_items:complete`) or a host emission (`pipeline:step-done`). */
  on: string | string[];
  /**
   * Optional condition. Declarative data-match object (see `@papercusp/rules`
   * — e.g. `{ 'args.role': { equals: 'worker' } }`), or a predicate function
   * (entry-point plugins only).
   */
  when?: Record<string, unknown> | ((event: PluginReactionEvent) => boolean);
  /** The plugin tool to fire — must be this plugin's own (`<plugin>.<verb>`). */
  fire: string;
  /** The fire args: a static object, or a function deriving them from the event. */
  args?: Record<string, unknown> | ((event: PluginReactionEvent) => Record<string, unknown>);
  /** Skip when the trigger errored. Default true. */
  onlyOnSuccess?: boolean;
  /**
   * Capability the reaction is sandboxed to. Must be one of the plugin's
   * manifest capabilities. Default: the fired tool's declared capability.
   */
  capability?: string;
}


/* ─────────────────────────────────────────────────────────────────────
 * Events as a dependency axis (cupboard-public-release-2026-07-12 D-003 /
 * P-005). A distribution unit can DECLARE the awaitable event-key families it
 * PROVIDES and the ones it DEPENDS ON, mirroring the provides_tools /
 * dependencies.tools axis (tool-distribution-granularity-2026-06-05 D-002).
 *
 * These declarations are pure DATA: a runtime-less `kind:'pack'` may carry them
 * (they are not runtime-bearing surfaces, so the loader's pack-purity check
 * allows them). Actually EMITTING a family or REACTING to one is runtime that
 * rides a plugin — `reactions`/`hooks` stay pack-forbidden — but a pack's js
 * tool handler may still emit, which is why a pack is allowed to declare what
 * it provides.
 *
 * `ManifestProvidedEvent` is a structural subset of operator-core's
 * `EventCatalogEntry` (events/await/catalog.ts): the installed-tier
 * `events:catalog` merge (P-006) lifts these over the builtin registry with
 * provenance, and the resolver (P-007) answers "who provides family X?".
 * ───────────────────────────────────────────────────────────────────── */

/** A `<placeholder>` slot in a provided family's key template. */
export interface ManifestEventParam {
  /** Placeholder name as it appears in the template, e.g. `id` for `foo:done:<id>`. */
  name: string;
  /** Must a caller supply it to build a concrete key? An omitted OPTIONAL param collapses its `:<name>` segment. */
  required: boolean;
  /** One line for the catalog + sugar arg docs. */
  describe: string;
}

/** One awaitable event-key FAMILY a unit declares it provides (D-003, P-005). */
export interface ManifestProvidedEvent {
  /** Stable family id — the catalog lookup key + `buildKey` handle. Unique within `provides.events`. */
  family: string;
  /** Exact key TEMPLATE with `<param>` placeholders. A no-param family is a literal key. */
  keyTemplate: string;
  /** Placeholders the template interpolates, in order. Every `<name>` in `keyTemplate` needs one, and vice versa. */
  params?: ManifestEventParam[];
  /** What firing this key MEANS (one line), for the catalog. */
  describe?: string;
}

/**
 * One event-family DEPENDENCY a unit requires (D-003, P-005). Resolved at
 * Cupboard install time (P-007) against `provides.events` across the pack
 * catalog: an installed provider → satisfied, a Cupboard provider →
 * installable, neither → HARD failure like an unresolvable tool dep — UNLESS
 * `optional`, which marks a listen-if-present soft dep that never blocks.
 */
export interface ManifestEventDependency {
  /** The provided family id this unit needs. */
  family: string;
  /** optional:true = listen-if-present soft dep (an unresolvable optional dep is non-blocking). */
  optional?: boolean;
}

/** Unit-level provisions surfaced to the Cupboard catalog + dependency resolver (D-003). */
export interface ManifestProvides {
  /** Event-key families this unit provides. */
  events?: ManifestProvidedEvent[];
}

/**
 * Unit-level dependencies resolved at Cupboard install time against the host's
 * pack catalog (same shape as a blueprint's `dependencies`; the JSON manifest
 * has carried tools/packs/plugins since tool-distribution-granularity D-003).
 * `events` (D-003, P-005) joins them.
 */
export interface ManifestDependencies {
  tools?: string[];
  packs?: string[];
  plugins?: string[];
  events?: ManifestEventDependency[];
}

/* ─────────────────────────────────────────────────────────────────────
 * Trigger packs (external-triggers-gmail-slack-2026-08-22 P-012).
 *
 * A trigger pack is PURE MANIFEST DATA carried by a normal plugin
 * (`kind:'plugin'`, usually with no entry point). It packages the reusable
 * half of a workflow: plan|recipe targets, single-target bindings, internal
 * event edges, declared inputs, OAuth requirements, and storm policy. It is
 * deliberately NOT `kind:'pack'`: that discriminator means n>=1 executable
 * code tools and the loader correctly rejects runtime/reaction surfaces there.
 *
 * Installation only makes this declaration available to the host. It never
 * arms the binding; the existing trigger arm gate remains a separate,
 * autonomy-governed action.
 * ───────────────────────────────────────────────────────────────────── */

export interface PluginTriggerPackPlanTarget {
  id: string;
  kind: 'plan';
  /** Relative path to the bundled structured plan template. */
  path: string;
  /** Plan-authored JSON Schema delivered with every instantiated template. */
  inputSchema: Record<string, unknown>;
}

export interface PluginTriggerPackRecipeTarget {
  id: string;
  kind: 'recipe';
  /** Stable recipe ref; a one-step recipe is how the UI stores "call a tool". */
  ref: string;
  /** Optional pinned recipe revision. */
  revision?: number;
  /** Declared deterministic args used to prove complete field mapping. */
  argsSchema: Record<string, unknown>;
}

export type PluginTriggerPackTarget = PluginTriggerPackPlanTarget | PluginTriggerPackRecipeTarget;

/**
 * An external pack source names its provider in one of two ways
 * (generalized-integrations D-013 §1):
 *
 * - provider-pinned: `sourceKind` (`gmail`, `slack`, `gcal`, ...). The pattern
 *   starts `ext:<sourceKind>:`. First-party packs use this.
 * - portable: `datatype` (+ optional `capabilities`). The pattern starts
 *   `ext:*:`. At install the host binds it to an installer-chosen local data
 *   source whose registered provider produces that datatype and serves every
 *   listed capability, and rewrites the `*` to that source's kind. The pack
 *   never names a provider, account or source id.
 */
export type PluginTriggerPackExternalSource = {
  kind: 'external';
  /**
   * Optional configSchema property that acquires the source credential
   * through OAuth. Cross-validation requires explicit secret/share/snapshot
   * semantics plus matching inline/top-level provider + scopes.
   */
  oauthField?: string;
} & (
  | {
      /** Canonical trigger-source kind (`gmail`, `slack`, `gcal`, ...). */
      sourceKind: string;
      datatype?: never;
      capabilities?: never;
    }
  | {
      sourceKind?: never;
      /** Canonical datatype id the bound source must produce (`email-message`, ...). */
      datatype: string;
      /** Provider capabilities the bound source must serve (`mail.read`, ...). */
      capabilities?: string[];
    }
);

export type PluginTriggerPackSource =
  | PluginTriggerPackExternalSource
  | { kind: 'internal'; event: 'binding-run-completed' | 'plan-completed' }
  /**
   * @deprecated Trigger packs do not consume schedules. Use a `manual` binding
   * and arm the instantiated plan with `plans:set-schedule` followed by
   * `plans:arm-schedule`.
   */
  | { kind: 'schedule'; scheduleRef: string }
  | { kind: 'manual' };

export interface PluginTriggerPackMapping {
  /** D-015's rigor ladder. payload-context is valid for plan targets only. */
  mode: 'type-match' | 'fields' | 'payload-context';
  /** target arg → source field path, required for explicit field mapping. */
  fields?: Record<string, string>;
}

export interface PluginTriggerPackBinding {
  id: string;
  source: PluginTriggerPackSource;
  /** One target per binding; chains are event-stitched through `edges`. */
  target: string;
  /** Required for external sources; optional derived key/pattern for internal sources. */
  eventPattern?: string;
  /** Payload matcher passed to the existing external-trigger binding engine. */
  filter?: Record<string, unknown>;
  mapping?: PluginTriggerPackMapping;
  /** Per-binding override of the pack default. */
  stormPolicy?: {
    maxRuns?: number;
    windowSeconds?: number;
  };
  /** Deterministic-target failure policy (plan targets self-recover through the agent). */
  retry?: {
    maxAttempts: number;
    backoffSeconds?: number;
    /** Exhausted deterministic runs are retained and surfaced in Activity. */
    onExhausted: 'dead-letter';
  };
}

export interface PluginTriggerPackEdge {
  /** Upstream binding id. */
  from: string;
  /** Downstream binding id; it must declare an internal source. */
  to: string;
  event: 'binding-run-completed' | 'plan-completed';
  /** Correlation is inherited so Runs reconstructs the chain as one workflow. */
  correlation: 'inherit';
}

export interface PluginTriggerPack {
  /** Workflow-level install/runtime inputs (JSON Schema). */
  inputs: Record<string, unknown>;
  /** Pack-wide default; a binding may override it. */
  defaultStormPolicy?: {
    maxRuns?: number;
    windowSeconds?: number;
  };
  /** Graph nodes. v1 examples have one, but the schema is N-target from day one. */
  targets: PluginTriggerPackTarget[];
  /** Each binding invokes exactly one target. */
  bindings: PluginTriggerPackBinding[];
  /** Event-stitched graph edges. A one-node v1 pack declares `[]`. */
  edges: PluginTriggerPackEdge[];
}

function triggerPackObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function triggerPackScopes(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((scope): scope is string => typeof scope === 'string' && scope.length > 0)
    : [];
}

/**
 * Cross-field validation the JSON schema cannot express. The manifest schema
 * proves the local shapes; this proves the references agree, so a pack cannot
 * look installable while silently leaking its credential or requesting a
 * different OAuth grant than the config UI displays.
 */
export function validateTriggerPackDeclaration(manifest: {
  kind?: string;
  triggerPack?: PluginTriggerPack;
  configSchema?: Record<string, unknown>;
  oauth?: PluginOAuthRequirement[];
}): string[] {
  const pack = manifest.triggerPack;
  if (!pack) return [];

  const issues: string[] = [];
  if (manifest.kind === 'pack') {
    issues.push('triggerPack must ride kind "plugin" — kind "pack" is reserved for executable code-tool packs');
  }

  const targetById = new Map<string, PluginTriggerPackTarget>();
  for (const target of pack.targets ?? []) {
    if (targetById.has(target.id)) issues.push(`triggerPack.targets declares duplicate id "${target.id}"`);
    targetById.set(target.id, target);
    if (target.kind !== 'plan') continue;
    const pathSegments = target.path.split('/');
    if (
      !target.path ||
      target.path.startsWith('/') ||
      target.path.includes('\\') ||
      pathSegments.some((segment) => segment === '' || segment === '.' || segment === '..') ||
      !target.path.endsWith('.md')
    ) {
      issues.push(`triggerPack target "${target.id}" path must be a safe relative .md path`);
    }
  }

  const bindingById = new Map<string, PluginTriggerPackBinding>();
  const checkedOauthFields = new Set<string>();
  for (const binding of pack.bindings ?? []) {
    if (bindingById.has(binding.id)) issues.push(`triggerPack.bindings declares duplicate id "${binding.id}"`);
    bindingById.set(binding.id, binding);
    const target = targetById.get(binding.target);
    if (!target) {
      issues.push(`triggerPack binding "${binding.id}" references unknown target "${binding.target}"`);
    } else if (target.kind === 'recipe') {
      if (!binding.mapping || binding.mapping.mode === 'payload-context') {
        issues.push(`triggerPack recipe binding "${binding.id}" requires deterministic type-match or fields mapping`);
      }
      if (!binding.retry || binding.retry.onExhausted !== 'dead-letter') {
        issues.push(`triggerPack recipe binding "${binding.id}" requires an explicit dead-letter retry policy`);
      }
      if (binding.mapping?.mode === 'fields') {
        const args = triggerPackObject(target.argsSchema);
        const properties = triggerPackObject(args.properties);
        const required = Array.isArray(args.required)
          ? args.required.filter((arg): arg is string => typeof arg === 'string')
          : [];
        const mapped = Object.keys(binding.mapping.fields ?? {});
        const missing = required.filter((arg) => !mapped.includes(arg));
        if (missing.length > 0) {
          issues.push(
            `triggerPack recipe binding "${binding.id}" fields mapping is missing required args: ${missing.join(', ')}`,
          );
        }
        const unknown = mapped.filter((arg) => !(arg in properties));
        if (unknown.length > 0) {
          issues.push(
            `triggerPack recipe binding "${binding.id}" fields mapping declares unknown args: ${unknown.join(', ')}`,
          );
        }
      }
    } else if (binding.retry) {
      issues.push(`triggerPack plan binding "${binding.id}" must not declare retry policy; plans self-recover through the agent`);
    }

    if (binding.mapping?.mode === 'fields' && Object.keys(binding.mapping.fields ?? {}).length === 0) {
      issues.push(`triggerPack binding "${binding.id}" fields mapping must declare at least one field`);
    }
    const bindingSourceKind = (binding.source as { kind?: unknown }).kind;
    if (bindingSourceKind === 'schedule') {
      issues.push(
        `triggerPack binding "${binding.id}" declares source kind "schedule", which has no runtime consumer — arm the cadence on the instantiated plan with plans:set-schedule + plans:arm-schedule`,
      );
      continue;
    }
    if (binding.source.kind !== 'external') continue;
    const eventPattern = binding.eventPattern?.trim() ?? '';
    const sourceKind = typeof binding.source.sourceKind === 'string' ? binding.source.sourceKind.trim() : '';
    const datatype = typeof binding.source.datatype === 'string' ? binding.source.datatype.trim() : '';
    if (Boolean(sourceKind) === Boolean(datatype)) {
      issues.push(
        `triggerPack binding "${binding.id}" external source must declare exactly one of sourceKind or datatype`,
      );
    } else if (sourceKind) {
      if (!eventPattern.startsWith(`ext:${sourceKind}:`)) {
        issues.push(`triggerPack binding "${binding.id}" eventPattern must start with "ext:${sourceKind}:"`);
      }
    } else if (!eventPattern.startsWith('ext:*:') || eventPattern.length <= 'ext:*:'.length) {
      // A portable source names no provider: the host rewrites `*` to the
      // installer-chosen local source's kind at install time.
      issues.push(`triggerPack binding "${binding.id}" portable datatype source eventPattern must start with "ext:*:"`);
    }
    if (!sourceKind && binding.source.capabilities !== undefined) {
      const capabilities = binding.source.capabilities;
      if (
        !Array.isArray(capabilities) ||
        capabilities.some((capability) => typeof capability !== 'string' || capability.trim() === '')
      ) {
        issues.push(`triggerPack binding "${binding.id}" capabilities must be non-empty strings`);
      }
    }

    const oauthField = binding.source.oauthField?.trim() ?? '';
    if (!oauthField || checkedOauthFields.has(oauthField)) continue;
    checkedOauthFields.add(oauthField);
    const properties = triggerPackObject(triggerPackObject(manifest.configSchema).properties);
    const field = triggerPackObject(properties[oauthField]);
    if (Object.keys(field).length === 0) {
      issues.push(`triggerPack oauthField "${oauthField}" is absent from configSchema.properties`);
      continue;
    }
    if (field.secret !== true) issues.push(`configSchema.properties.${oauthField}.secret must be true`);
    if (field.snapshotPolicy !== 'strip') {
      issues.push(`configSchema.properties.${oauthField}.snapshotPolicy must be "strip"`);
    }
    if (field.shareable !== false) issues.push(`configSchema.properties.${oauthField}.shareable must be false`);

    const inlineOauth = triggerPackObject(field.oauth);
    const requirement = (manifest.oauth ?? []).find((candidate) => candidate.fieldName === oauthField);
    if (!requirement) {
      issues.push(`oauth[] must declare fieldName "${oauthField}"`);
      continue;
    }
    if (typeof inlineOauth.provider !== 'string' || inlineOauth.provider !== requirement.provider) {
      issues.push(`configSchema.properties.${oauthField}.oauth.provider must match oauth[].provider`);
    }
    const inlineScopes = triggerPackScopes(inlineOauth.scopes).sort();
    const declaredScopes = triggerPackScopes(requirement.scopes).sort();
    if (declaredScopes.length === 0) {
      issues.push(`oauth[] entry for "${oauthField}" must declare at least one scope`);
    } else if (
      inlineScopes.length !== declaredScopes.length ||
      inlineScopes.some((scope, index) => scope !== declaredScopes[index])
    ) {
      issues.push(`configSchema.properties.${oauthField}.oauth.scopes must match oauth[].scopes`);
    }
  }

  const incomingInternal = new Set<string>();
  const adjacency = new Map<string, string[]>();
  for (const edge of pack.edges ?? []) {
    const from = bindingById.get(edge.from);
    const to = bindingById.get(edge.to);
    if (!from) issues.push(`triggerPack edge references unknown from binding "${edge.from}"`);
    if (!to) issues.push(`triggerPack edge references unknown to binding "${edge.to}"`);
    if (edge.from === edge.to) issues.push(`triggerPack edge "${edge.from}" → "${edge.to}" is a self-cycle`);
    if (to && to.source.kind !== 'internal') {
      issues.push(`triggerPack edge destination "${edge.to}" must declare source.kind "internal"`);
    }
    if (to && to.source.kind === 'internal' && to.source.event !== edge.event) {
      issues.push(`triggerPack edge event must match internal source event on binding "${edge.to}"`);
    }
    if (from && edge.event === 'plan-completed') {
      const sourceTarget = targetById.get(from.target);
      if (sourceTarget?.kind !== 'plan') {
        issues.push(`triggerPack plan-completed edge source "${edge.from}" must target a plan`);
      }
    }
    incomingInternal.add(edge.to);
    adjacency.set(edge.from, [...(adjacency.get(edge.from) ?? []), edge.to]);
  }
  for (const binding of pack.bindings ?? []) {
    if (binding.source.kind === 'internal' && !incomingInternal.has(binding.id)) {
      issues.push(`triggerPack internal binding "${binding.id}" requires an incoming edge`);
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const next of adjacency.get(id) ?? []) if (visit(next)) return true;
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  if ([...bindingById.keys()].some((id) => visit(id))) {
    issues.push('triggerPack.edges must form an acyclic event-stitched graph');
  }
  return issues;
}


/* ─────────────────────────────────────────────────────────────────────
 * Plugin schema — Postgres DDL the plugin owns.
 * ───────────────────────────────────────────────────────────────────── */

export interface PluginSchemaDef {
  /** Postgres schema name. Convention: plugin_<plugin-name-with-underscores>. */
  schemaName: string;
  /** Path (relative to plugin root) to the DDL file. */
  ddlPath: string;
}

/**
 * Manifest.schema field — accepted shapes (the install path normalizes them).
 *
 * Canonical: a single PluginSchemaDef or an array of them. Legacy: a bare
 * string array of DDL paths (no schemaName association). New plugins should
 * use the canonical form.
 */
export type PluginSchemaField =
  | PluginSchemaDef
  | PluginSchemaDef[]
  | string[];


/* ─────────────────────────────────────────────────────────────────────
 * The main plugin shape.
 *
 *   import plugin from './plugins/briefings';
 *   await loader.register(plugin);
 *
 * The loader validates: name unique, semver matches manifest, capabilities
 * resolve, schema DDL applies cleanly, UI components import.
 * ───────────────────────────────────────────────────────────────────── */

/**
 * Action declaration — appears in `Plugin.actions[]` AND in `papercusp.json`.
 * Server-runtime actions are registered imperatively from `init()` via
 * `ctx.actions.register(name, handler)`. The host dispatches surface events
 * (toolbar clicks, mission-done, etc.) to the registered handler.
 */
export interface ActionDefinition {
  /** Action name. Must match a key registered via ctx.actions.register(). */
  name: string;
  /** Human-readable button label for harness-toolbar etc. */
  label?: string;
  /** Where this action surfaces in the host UI / lifecycle. */
  surfaces?: ('mission-done' | 'harness-toolbar' | 'feature-row' | 'plugin-detail' | string)[];
  /** Capabilities this action additionally requires beyond the plugin's own. */
  capabilities?: Capability[];
  /** Server-side handler hints. */
  serverHandler?: {
    /** Per-invocation timeout in seconds (host enforces via AbortSignal). */
    timeoutSec?: number;
  };
  /** JSON-Schema for the params object the handler receives. */
  paramsSchema?: Record<string, unknown>;
}

export interface Plugin {
  /**
   * Manifest discriminator. Mirrors the `kind` field in papercusp.json so
   * `Plugin` literals in source can match. The loader treats `'plugin'` as
   * default; `'pack'` marks a runtime-less code-tool pack (tools only — the
   * loader rejects ui/roles/routines/actions/non-js runtimes on packs;
   * tool-distribution-granularity-2026-06-05 D-001/D-004). `'template'` is a
   * harness/project template (papercusp CLI). `'snapshot'`/`'service'`/`'theme'`/
   * `'harness'` reserve room for future package types (the loader treats every
   * non-`'pack'` value as a default plugin). KEEP IN SYNC with the `kind` enum in
   * papercusp-plugin.schema.json (EI-29: the two had drifted — `'template'` was
   * live in the CLI but missing here; `'service'`/`'theme'`/`'harness'` were here
   * but missing from the schema).
   */
  kind?: 'plugin' | 'pack' | 'template' | 'snapshot' | 'service' | 'theme' | 'harness';
  /** Unique plugin name (filesystem dir + Postgres schema prefix). */
  name: string;
  /** Plugin semver. */
  version: string;
  /** Required Papercusp framework semver range. */
  papercusp: string;
  /**
   * Plugin runtime descriptor. Defaults to `{ kind: 'js' }` when omitted.
   * For Plugin literals exported from TS source, you can usually leave this
   * unset (JS implied). For WASM and daemon plugins, the runtime descriptor
   * is declared in `papercusp.json`, not here — Plugin literals don't exist
   * for those runtimes. Kept on the interface so authors who DO want to be
   * explicit can be. See {@link PluginRuntime}.
   */
  runtime?: PluginRuntime;
  /**
   * Discovery-time budget (ms) for `getDynamicTools()`. MCP-proxy plugins
   * (gitnexus, ast-grep) spawn an external child to enumerate tools at load;
   * the loader bounds that probe so a hung child can't wedge host startup.
   * The default is 10s — generous for a cached binary, but a cold start
   * (first `npx` fetch, a large code-graph index loading) can exceed it,
   * tripping the timeout → 0 tools + a load error. Such plugins declare a
   * larger budget here. Clamped by the loader to a sane ceiling.
   * (revive-plugin-system-2026-06-04 D-003.)
   */
  discoveryTimeoutMs?: number;
  /** Optional human-readable description shown in the marketplace + admin. */
  description?: string;
  /**
   * Plugin-author opt-in for files in the per-plugin work-dir
   * (`~/.papercusp/plugins/<id>/_work/`) that should travel with
   * snapshots. Default behavior (this field absent or empty): the
   * entire work-dir is stripped on capture. Files explicitly listed
   * here are included.
   *
   * Use cases for daemon plugins (Batch I): seeding state, pre-built
   * indexes, model files small enough to ship inline. Anything large
   * or sensitive should NOT be listed — daemon plugins should
   * regenerate/refetch on first run instead.
   *
   * `redact: 'strip'` writes the file as a zero-byte placeholder so
   * the restore-side knows it was intentional but excluded
   * (vs. plain absence which means "never existed"). Default is to
   * include the file as-is; explicit redaction needed for "include
   * the path stub but not the content."
   *
   * Path is relative to the plugin's work-dir root. Globs supported
   * (forward-slash + minimatch syntax).
   */
  snapshot?: {
    include?: { path: string; redact?: 'strip' }[];
  };

  /**
   * @internal Build-pipeline only — DO NOT set this in your plugin's
   * manifest. The operator install pipeline stamps `bundled: true`
   * on plugins that ship pre-installed with the operator (e.g.
   * the bundled slack-notifier). Capture excludes bundled plugins
   * from `snapshot.plugins[]` because they're substrate, not user
   * state — a fork's new install will already have them via its own
   * bundled set.
   *
   * Lint should reject author-set `bundled: true`. Plugin authors
   * who try to ship `bundled: true` are either confused or trying to
   * smuggle their plugin into "no consent needed" status; both wrong.
   */
  bundled?: boolean;

  /** When true, the plugin is hidden from the marketplace listing UI. The
   *  plugin still loads, enables, and runs — this only suppresses its
   *  appearance in the marketplace catalog cards. Use for in-development
   *  plugins that are functional but not yet ready for public discovery. */
  hidden?: boolean;
  /** Optional human-readable reason shown in admin tools when `hidden` is true. */
  hiddenReason?: string;
  /** Action declarations. Each must be registered from `init()` to be invocable. */
  actions?: ActionDefinition[];

  /**
   * MCP tool handlers contributed by this plugin. Keys must match
   * `tools[].name` entries in the plugin's `papercusp.json` manifest.
   *
   * Loader cross-validates manifest ↔ handlers at load time:
   * - every manifest tool must have a handler key
   * - no orphan handlers (handler with no manifest entry)
   * - each manifest tool's `capabilities` must subset `plugin.capabilities`
   *
   * For plugins whose tool catalog is only known at runtime (e.g. an
   * MCP-proxy plugin that introspects an external server's `tools/list`),
   * leave `tools` empty and implement `getDynamicTools` instead — the
   * loader skips static cross-validation in that case.
   *
   * Spec: apps/operator/docs/plugin-mcp-host-design.md.
   */
  tools?: PluginToolMap;

  /**
   * Dynamic tool registration — for MCP-proxy plugins (GitNexus, ast-grep,
   * etc.) whose tool list comes from an external runtime catalog. Called
   * once during plugin-host startup. Returns the live `ToolDefinition[]`
   * + matching handler map; the host wires them through
   * `registerProjectedTool` exactly like static tools.
   *
   * When this is present, `tools` and `manifest.tools[]` are not required
   * (the loader skips static cross-validation). Either provide both
   * static + dynamic, or neither — the host calls `getDynamicTools` and
   * merges with anything in static `tools`.
   *
   * The handler map keys returned must match the `definitions[].name`.
   * Capabilities still need to be declared in `plugin.capabilities` —
   * dynamic registration doesn't bypass capability gating.
   *
   * Spec: apps/operator/docs/plugin-mcp-host-design.md (D2 dynamic-tools
   * extension).
   */
  getDynamicTools?: () => Promise<{
    definitions: ToolDefinition[];
    handlers: PluginToolMap;
  }>;

  /** Declarative permission manifest. Loader enforces these at every API call. */
  capabilities: Capability[];

  /**
   * Optional per-capability tier overrides for the Operator.
   *
   * The Operator pipeline classifies a capability into low/medium/high
   * via `lookupTier()` against the substrate `tier-table.json`. For
   * plugin-defined caps not in the substrate table, the Operator
   * defaults to `high` (fail-safe → always ask). A plugin can declare
   * a more permissive tier here for caps it owns:
   *
   *   tierMap: {
   *     'http:fetch:slack.com': 'low',          // safe webhook
   *     'compute:exec:my-validator': 'medium',  // common, batched
   *   }
   *
   * High-tier substrate caps cannot be downgraded — the Operator
   * pipeline ignores any entry that maps a substrate cap to a lower
   * tier than the substrate table specifies.
   */
  tierMap?: Partial<Record<string, 'low' | 'medium' | 'high'>>;

  /** Lifecycle init — runs once on plugin load. */
  init?(ctx: PapercuspContext): Promise<void>;

  /**
   * Lifecycle hooks. FROZEN surface (plugin-system-hive-port D-003): the
   * existing fire-points stay for back-compat but no new ones will be added —
   * new host fire-points are event emissions; subscribe via `reactions`.
   */
  hooks?: PluginHooks;

  /**
   * Event-reaction rules — the extension surface for "when X happens, invoke
   * my tool" (plugin-system-hive-port D-003). Each rule is capability-scoped
   * and fires through normal dispatch. Manifest `reactions` entries (the
   * declarative subset) merge with these; on id collision the code rule wins.
   */
  reactions?: PluginReactionRule[];

  /**
   * Event-key families this unit PROVIDES — the provider half of the
   * events-as-a-dependency axis (D-003, cupboard-public-release-2026-07-12
   * P-005). Pure data: declaring is `kind:'pack'`-legal; emitting/reacting is
   * runtime that rides a plugin. See {@link ManifestProvides}.
   */
  provides?: ManifestProvides;

  /**
   * Unit-level tool/pack/plugin/event dependencies, resolved at Cupboard
   * install time against the host's pack catalog (mirrors a blueprint's
   * `dependencies`; the JSON manifest has carried tools/packs/plugins for a
   * while — the typed field surfaces them for `Plugin` literals too). The
   * `events` axis is D-003 / P-005. See {@link ManifestDependencies}.
   */
  dependencies?: ManifestDependencies;

  /**
   * Pure-data external source → plan-template package. Discovery exposes the
   * descriptor after install; arming remains an explicit trigger action.
   */
  triggerPack?: PluginTriggerPack;

  /**
   * Integration provider descriptor (pure data, validated at load/install).
   * See `./provider` and plan generalized-integrations-…-2026-10-05 D-006.
   */
  provider?: import('./provider').ProviderDescriptor;

  /**
   * Adapter implementing the provider contract. `js` providers export it
   * in-process; daemon providers serve the same three methods over JSON-RPC.
   * Providers never receive tokens — network access goes through `host.fetch`.
   */
  providerAdapter?: import('./provider').ProviderAdapter;

  /** Full-route UI mounted at /harness/<slug>. */
  ui?: UiContribution;
  /** Tabs added to a host's harness dashboard. */
  dashboardTabs?: DashboardTab[];
  /** Top-nav sidebar items. */
  sidebarItems?: SidebarItem[];

  /**
   * API routes contributed by the plugin. The runtime mounts this Hono
   * sub-app at `/api/plugins/<plugin-name>/`.
   *
   * The type is intentionally a structural subset of `Hono` — `.fetch` is
   * the only method the host calls. We avoid a hard `import type { Hono
   * } from 'hono'` so plugins that don't ship API routes don't pay the
   * Hono peer-dep cost. Plugins that DO ship routes should import their
   * own `Hono` and assert `apiRoutes: app satisfies PluginApiRoutes`.
   * The host pins Hono ^4.12 — major bumps will breaking-change here.
   */
  apiRoutes?: PluginApiRoutes;

  /** Postgres schema this plugin owns. */
  schema?: PluginSchemaField;

  /**
   * JSON-Schema describing config keys this plugin accepts under
   * the install's plugin config. Used for validation + config UIs.
   *
   * Supported manifest declarations for config fields:
   *   - `secret: true`            credential declaration
   *   - `snapshotPolicy: "strip" | "include" | "warn-and-prompt"`
   *                                intended handling for a secret field
   *   - `shareable: false`        publisher-specific identifier declaration
   *   - `oauth: { provider, scopes }` OAuth metadata paired with `oauth[]`
   *   - `aliases: (string | null)[]`  schema-evolution rename/removal
   *
   * These are declarations, not a live snapshot redaction mechanism. The
   * former snapshot exporter and fork UI are retired. The live SDK validator
   * enforces `secret`, `snapshotPolicy: "strip"`, and `shareable: false` when
   * a trigger-pack binding identifies an OAuth field; other consumers must
   * interpret the declarations explicitly.
   *
   * Spec: /docs/snapshots/share-semantics.
   */
  configSchema?: Record<string, unknown>;

  /**
   * Provisioning scripts — the substrate runs these on the host with
   * full visibility (xterm pane, audit log) at well-known lifecycle
   * points. Captured by snapshots so a forker can recreate the
   * underlying infrastructure.
   *
   * Spec: /docs/snapshots/build-scripts.
   */
  provision?: PluginProvision;

  /**
   * OAuth providers this plugin uses. The substrate offers
   * `ctx.oauth.token(provider)` to acquire/refresh tokens.
   *
   * Spec: /docs/snapshots/oauth-integration.
   */
  oauth?: PluginOAuthRequirement[];

  /**
   * @deprecated v1 only. Use `versionPin` instead.
   *
   * Loader still reads this for back-compat:
   *   `pluginVersionPinned: true`  → equivalent to `versionPin: { mode: 'exact' }`
   *   `pluginVersionPinned: false` → equivalent to `versionPin: { mode: 'semver' }`
   *
   * Spec: /docs/snapshots/share-semantics#schema-evolution.
   */
  pluginVersionPinned?: boolean;

  /**
   * v2 (rev3 plan G+2): explicit per-plugin version-pinning policy.
   *
   * - `mode`:
   *   - `'semver'` — accept any version satisfying captured semver range. Default for JS plugins.
   *   - `'exact'`  — restore must use the exact version captured. Equivalent to legacy `pluginVersionPinned: true`.
   *   - `'hash'`   — content-addressed (WASM/daemon default). Different binary = different identity.
   * - `allowOverride`:
   *   - `'security-patch'` — marketplace-flagged security patches can supersede pinned version (default).
   *   - `'always'`         — any newer version supersedes (rare; user opt-in).
   *   - `'never'`          — strict pinning even through CVE updates.
   *
   * When both `versionPin` and `pluginVersionPinned` are set, `versionPin` wins.
   */
  versionPin?: {
    mode: 'semver' | 'exact' | 'hash';
    allowOverride?: 'security-patch' | 'always' | 'never';
  };
}

/* ─────────────────────────────────────────────────────────────────────
 * Provision lifecycle (build scripts)
 * ───────────────────────────────────────────────────────────────────── */

export interface PluginProvision {
  setup?: ProvisionScript;
  teardown?: ProvisionScript;
  verify?: ProvisionScript;
  cloudProvider?: { id: 'aws' | 'gcp' | 'azure' | 'cloudflare'; region?: string; regions?: string[] };
  allowedHosts?: string[];
  skipReprovisionOnPatch?: boolean;
  auditLogCapMb?: number;
}

export interface ProvisionScript {
  path: string;
  timeoutSec?: number;
  runAt?: 'fork' | 'install' | 'first-action';
  /**
   * Human label shown on the consent surface (the settings ProvisionPanel)
   * before the user runs the script. Falls back to the phase name.
   */
  displayName?: string;
  /**
   * One-paragraph explanation of what the script creates/changes, shown to
   * the user before they approve the run. Strongly recommended for `setup`.
   */
  description?: string;
}

/* ─────────────────────────────────────────────────────────────────────
 * OAuth providers
 * ───────────────────────────────────────────────────────────────────── */

export interface PluginOAuthRequirement {
  provider: string;
  scopes?: string[];
  fieldName: string;
  refreshFieldName?: string;
  expiresAtFieldName?: string;
}


/* ─────────────────────────────────────────────────────────────────────
 * MCP tools — agent-callable functions contributed by plugins.
 *
 * A plugin may contribute zero or more tools via its manifest's
 * `tools[]` array + a typed `tools` export. The agent-mcp host merges
 * built-in tools with plugin-contributed tools per request, filtered
 * by the calling role's allowlist and per-window quota.
 *
 * Spec: apps/operator/docs/plugin-mcp-host-design.md.
 * ───────────────────────────────────────────────────────────────────── */

// `AgentRole` is owned by `@papercusp/tooldef` and configured by the host
// (plan P-010 / D-005). The framework keeps it `string`-assignable; the
// Papercusp host registers its built-in roles (scoper…curator, operator,
// experts) via `RoleRegistry` augmentation in `@papercusp/agent-mcp`, which
// shapes the autocomplete suggestions program-wide. Plugins still contribute
// custom roles at runtime (namespaced `<plugin>:<role>`), typed as `string`.
// plugin-sdk no longer hand-maintains a (perpetually stale) literal union —
// it re-exports the framework's seam. See D-003 (no-shim) / D-004 (invert).
//
// `RolesQuota`, `ToolResult`, `ProgressCallback`, and `EmitCallback` likewise
// live in `@papercusp/tooldef`; re-exported here so existing plugin-sdk
// consumers keep importing them unchanged.
export type { AgentRole, RolesQuota, ToolResult, ProgressCallback, EmitCallback };

/**
 * Per-invocation context passed to every tool handler. Different from
 * `PapercuspContext` (lifecycle context) because tool calls have a
 * specific calling agent (role/feature/chunk/spawn) attached.
 */
export interface ToolContext {
  /** Workspace ID this invocation belongs to. */
  workspaceId: string;
  /** Harness slug. */
  harnessSlug: string;
  /** Absolute path to the harness's project root. */
  projectDir: string;
  /** Absolute path to `<projectDir>/.papercusp/`. */
  stateDir: string;
  /** Calling agent role. */
  role: AgentRole;
  /** Feature ID the calling spawn is working on (null for some non-worker roles). */
  featureId: string | null;
  /** Chunk ID, set for worker spawns. */
  chunkId: string | null;
  /** Orchestrator run ID. */
  runId: string;
  /** Unique per-spawn ID. Use this for log correlation and audit. */
  spawnId: string;
  /** Parent spawn ID, set when this spawn was created by another agent's `orchestrator.spawn` call. */
  parentSpawnId: string | null;
  /** Stream progress events. See ProgressCallback. Alias for `ctx.emit('progress', { progress, total, message? })`. */
  progress: ProgressCallback;
  /** Emit a typed named event. See EmitCallback. No-op when transport has no event channel attached. */
  emit: EmitCallback;
  /** Plugin-scoped logger; output goes to the harness run log. */
  log: (msg: string) => void;
  /** Capability-gated subprocess spawn. Same shape as PapercuspContext.spawn. */
  spawn: PluginSpawn;
  /** Capability-gated secret access. Returns null if not configured. */
  secret: (name: string) => Promise<string | null>;
  /** Abort signal — fires on per-tool timeout, parent cancellation, or shutdown. */
  signal: AbortSignal;
}

/**
 * Tool handler signature. Plugins export a `tools` map keyed by tool
 * name; each handler receives validated input + a per-invocation
 * ToolContext, and returns a ToolResult.
 *
 * The host validates `input` against the manifest-declared
 * `inputSchema` before invoking. Handlers should throw on
 * unrecoverable errors; the host wraps and returns a structured
 * MCP error to the agent.
 */
export type ToolHandler<TInput = unknown> = (
  input: TInput,
  ctx: ToolContext,
) => Promise<ToolResult>;

/**
 * HTTP exposure declaration. Path is mounted under operator's
 * /api/plugins/[...path] catch-all. Default methods is ['POST'].
 */
export interface ToolExposureHttp {
  path: string;
  methods?: ReadonlyArray<'POST' | 'GET' | 'PUT' | 'PATCH' | 'DELETE'>;
}

/**
 * MCP exposure declaration. The agent sees the tool by `name`. Optional
 * flags (`streaming`, `largeOutput`) tune transport-side behavior.
 */
export interface ToolExposureMcp {
  name: string;
  streaming?: boolean;
  largeOutput?: boolean;
}

/**
 * Slash-exposure overrides (slash-exposure-tool-catalog-2026-06-12) —
 * mirrors tooldef's `ToolExposureSlash`. Controls how the tool projects
 * onto the MCP prompts surface (agent-client slash commands).
 */
export interface ToolExposureSlash {
  /** Override the prompt-name suffix (full name is always `tool:<suffix>`). */
  name?: string;
  /** Override the slash listing's description. */
  description?: string;
  /** Restrict which top-level scalar input fields surface as prompt args. */
  args?: readonly string[];
}

/** At least one of `http`/`mcp` must be set. */
export interface ToolExposure {
  http?: ToolExposureHttp;
  mcp?: ToolExposureMcp;
  /**
   * Slash-command exposure via MCP prompts. DEFAULT ON for every
   * MCP-exposed tool; `false` hides the tool from the slash surface,
   * an object overrides naming/description/args.
   */
  slash?: boolean | ToolExposureSlash;
}

/**
 * Manifest-declared tool definition. The manifest is the source of
 * truth for the tool's contract; plugin code provides only the
 * handler function via the plugin's `tools` export.
 *
 * Example manifest entry:
 * ```json
 * "tools": [
 *   {
 *     "name": "pack",
 *     "description": "...",
 *     "inputSchema": {...},
 *     "capabilities": ["tools:repomix:pack"],
 *     "roles": ["scoper", "architect", "worker"],
 *     "rolesQuota": { "worker": { "perChunk": 1 } },
 *     "expose": {
 *       "http": { "path": "/api/plugins/repomix/pack" },
 *       "mcp":  { "name": "repomix.pack" }
 *     }
 *   }
 * ]
 * ```
 */
/**
 * Per-tool guidance for system-prompt assembly. Lives next to the tool
 * (single source of truth) and is projected into every role's system
 * prompt that's allowed to call the tool. See agent-mcp's `ToolGuidance`
 * for full docs.
 *
 * Plugin-SDK plugins can populate this in their manifest's `tools[i]`
 * entry; built-in tools populate it via `defineTool({ guidance })`. Both
 * paths feed the same projection slot.
 */
export interface PluginToolGuidance {
  /** Primary trigger — "When user asks 'X'" / "When you need Y". 1-2 lines. */
  when?: string;
  /** Disambiguation — "NOT for X; use <other_tool>". 1-2 lines. */
  notWhen?: string;
  /** Pairing hint — "Chain after <tool_a>" / "Pair with *_get". */
  chaining?: string;
  /**
   * Per-role override. Shallow-merged into the base at projection time.
   * AgentRole strings are kept opaque here to avoid a cross-package
   * type-import; runtime validates against the known roles enum.
   */
  byRole?: Record<string, { when?: string; notWhen?: string; chaining?: string }>;
}

export interface ToolDefinition {
  /** Function key — matches `plugin.tools[<name>]` in the entry point. */
  name: string;
  /** One-line description shown to MCP clients. */
  description: string;
  /** JSON Schema for tool input. Validated before dispatch. */
  inputSchema: Record<string, unknown>;
  /** Capabilities required to invoke. Must subset plugin.capabilities. */
  capabilities: Capability[];
  /** Optional role allowlist (MCP transport only; HTTP gates via principal). */
  roles?: AgentRole[];
  /** Per-role quota windows. */
  rolesQuota?: Partial<Record<AgentRole, RolesQuota>>;
  /** Per-call wall-clock timeout. Default 60s. */
  timeoutSec?: number;
  /**
   * Where to project this tool. At least one of `http`/`mcp` must be set.
   * Loader fills sensible defaults when absent — see plugin-mcp-host-design.md.
   */
  expose?: ToolExposure;
  /**
   * Optional per-tool guidance for system-prompt assembly. Projected into
   * the role's system prompt by `assembleRolePrompt`. See
   * `PluginToolGuidance` above.
   */
  guidance?: PluginToolGuidance;
}

/**
 * The `tools` export shape every plugin contributing tools must provide.
 * Map keys must match `ToolDefinition.name` values from the manifest.
 *
 *   export const tools: PluginToolMap = {
 *     'repomix.pack': async (input, ctx) => { ... },
 *   };
 */
export type PluginToolMap = Record<string, ToolHandler>;


/* ─────────────────────────────────────────────────────────────────────
 * Helper: defineService for typed service registration.
 *
 * Plugin authors declare what their service exposes; the loader uses this
 * metadata to enforce capabilities at the proxy level.
 * ───────────────────────────────────────────────────────────────────── */

export interface ServiceMethodDef {
  /** Capability required to invoke this method. Either a literal or a function for resource-scoped caps. */
  capability: Capability | ((...args: unknown[]) => Capability);
}

export interface ServiceDef {
  name: string;
  methods: Record<string, ServiceMethodDef>;
}

export function defineService(def: ServiceDef): ServiceDef {
  return def;
}


/* ─────────────────────────────────────────────────────────────────────
 * Runtime version — the canonical "host runtime" semver. Plugin manifests
 * declare `papercusp: '<range>'` (e.g. `^0.1.0`) and the loader validates
 * the range against this constant at load time.
 *
 * This is intentionally distinct from the @papercusp/plugin-sdk package
 * version. The SDK package version tracks shape changes to types in this
 * file; the runtime version tracks behavior + lifecycle changes that
 * plugins actually depend on (which fire-points exist, what services
 * back PapercuspApi, etc).
 *
 * Bump rules:
 *   - patch: bug fixes, internal changes invisible to plugins.
 *   - minor: add new optional surface (new lifecycle hook, new service,
 *     new optional ctx field). Backwards-compatible.
 *   - major: remove or rename existing surface. Bumps `0.x → 1.x` etc.
 *     Plugins with `^0.1` constraint will refuse to load against `1.x`.
 * ───────────────────────────────────────────────────────────────────── */

export const PAPERCUSP_RUNTIME_VERSION = '0.1.1' as const;


/* ─────────────────────────────────────────────────────────────────────
 * Capability tier table — substrate-known capabilities → tier.
 *
 * Used by the Operator pipeline to derive auto_dispatch authoritatively
 * (LLM's `tier` is sanity-check only). Unknown capabilities resolve to
 * `null`; the Operator forces `high` (fail-safe → always ask).
 * ───────────────────────────────────────────────────────────────────── */

export { lookupTier, TIER_TABLE } from './tier-table';
export type { CapabilityTier } from './tier-table';
export {
  PROVIDER_CONTRACT_VERSIONS,
  PROVIDER_ID_PATTERN,
  PROVIDER_DATATYPE_PATTERN,
  PROVIDER_CAPABILITY_PATTERN,
  PROVIDER_EGRESS_HOST_PATTERN,
  providerEgressAllows,
  validateProviderDescriptor,
  validateProviderDeclaration,
  isProviderAdapter,
  PROVIDER_DAEMON_METHODS,
  PROVIDER_SYNC_WAKE_CAPABILITY,
  PROVIDER_SYNC_ADOPT_CAPABILITY,
} from './provider';
export type {
  ProviderDaemonCallParams,
  ProviderDaemonFetchParams,
  ProviderContractVersion,
  ProviderOAuthDescriptor,
  ProviderOAuthIdentity,
  ProviderDescriptor,
  ProviderSyncRequest,
  ProviderRecord,
  ProviderSyncPage,
  ProviderSyncError,
  ProviderInvokeRequest,
  ProviderServiceCredential,
  ProviderServices,
  ProviderWakeResult,
  ProviderAdoptResult,
  HostFetchRequest,
  HostFetchResponse,
  HostFetch,
  ProviderHost,
  ProviderAdapter,
} from './provider';


/* ─────────────────────────────────────────────────────────────────────
 * Multi-runtime manifest descriptors (Batch G/G+/H/I — rev 3 plan).
 *
 * Surfaces the manifest's optional `runtime` and `ui[].type` fields as
 * TS types so loaders, lints, and consumers all read the same shape.
 * v1 keeps these optional + back-compat: omitting `runtime` means JS;
 * omitting `ui[].type` means React (existing behavior).
 * ───────────────────────────────────────────────────────────────────── */

export type PluginRuntimeKind = 'js' | 'wasm' | 'daemon';

export interface PluginRuntime {
  kind: PluginRuntimeKind;
  /** Required when kind='wasm'. Path relative to manifest dir. */
  wasmPath?: string;
  /** Required when kind='daemon'. argv (binary first). */
  daemonCommand?: string[];
  daemonRestart?: {
    policy?: 'never' | 'on-failure' | 'always';
    maxRestarts?: number;
    backoffMs?: number;
  };
  /** WASM linear-memory cap (MiB). Default 64. (Batch G4) */
  memoryBudgetMb?: number;
  /**
   * Action-invocation concurrency. WASM defaults to 'serial'
   * (mpsc actor); daemon defaults to 'parallel'.
   */
  concurrency?: 'serial' | 'parallel';
}

export type UiSurfaceType = 'react' | 'iframe' | 'tui-pane';

export interface UiSurfaceManifestEntry {
  /**
   * v1 default: 'react'. 'iframe' opts into the sandboxed iframe loader (Batch H).
   * 'tui-pane' is the terminal UI target (revive-plugin-system-2026-06-04 D-002):
   * the pui (apps/tui) hosts it by allocating a zellij pane it manages and running
   * `command` in it — the plugin renders its own content (ratatui or any TUI).
   * Zellij stays the pui's swappable layout engine, NOT the plugin contract.
   * Desktop targets (dashboard-tab/harness-route) are deferred with desktop.
   */
  type?: UiSurfaceType;
  slug: string;
  label: string;
  icon?: string;
  /** Required when type='iframe'. Path relative to manifest dir. */
  iframeEntry?: string;
  /** Origins the iframe can top-navigate to (Batch H5 — `iframe:navigate:<origin>` cap). */
  iframeNavigateOrigins?: string[];
  /**
   * Required when type='tui-pane'. argv to run in the zellij pane. `command[0]`
   * is a PATH-resolvable basename (or absolute path) the plugin must hold
   * `compute:exec:<command[0]>` for — same exec-gate as ctx.spawn. The process
   * runs with cwd = the plugin's install dir, so it can invoke a shipped render
   * script by relative path (e.g. ["sh", "render.sh"]).
   */
  command?: string[];
}

/** Default WASM memory budget in MiB when manifest omits the field. */
export const DEFAULT_WASM_MEMORY_BUDGET_MB = 64;

/** True if the entry opts into the iframe runtime. Treats omitted type as 'react'. */
export function isIframeSurface(entry: Pick<UiSurfaceManifestEntry, 'type'>): boolean {
  return entry.type === 'iframe';
}

/** True if the entry is a TUI pane (terminal render target). */
export function isTuiPaneSurface(entry: Pick<UiSurfaceManifestEntry, 'type'>): boolean {
  return entry.type === 'tui-pane';
}

/** True when the runtime is WASM. Defaults JS when descriptor missing. */
export function isWasmRuntime(rt: Pick<PluginRuntime, 'kind'> | undefined): boolean {
  return rt?.kind === 'wasm';
}

/** True when the runtime is a subprocess daemon. */
export function isDaemonRuntime(rt: Pick<PluginRuntime, 'kind'> | undefined): boolean {
  return rt?.kind === 'daemon';
}

/**
 * Cross-field validation of a manifest's event declarations (D-003, P-005) —
 * the semantic layer above the JSON schema's shape check. Pure; returns one
 * human-readable issue string per problem (empty array = clean). Enforces the
 * contract `buildKey` (operator-core events/await/catalog.ts) relies on, so a
 * declared family can actually build concrete keys:
 *   - `provides.events` family ids are non-empty and unique;
 *   - every `<name>` placeholder in a `keyTemplate` has a matching `params`
 *     entry, AND every declared param name appears as a `<name>` placeholder
 *     (a typo either way would silently mis-build keys);
 *   - `dependencies.events` family ids are non-empty.
 *
 * The provider RESOLUTION of a dependency (is family X available / installable
 * / unknown?) is deliberately NOT checked here — that needs the host pack
 * catalog and is the resolver's job (P-007).
 */
export function validateManifestEventDeclarations(manifest: {
  provides?: { events?: ManifestProvidedEvent[] } | null;
  dependencies?: { events?: ManifestEventDependency[] } | null;
}): string[] {
  const issues: string[] = [];

  const provided = manifest.provides?.events ?? [];
  const seen = new Set<string>();
  provided.forEach((ev, i) => {
    const at = `provides.events[${i}]`;
    const family = typeof ev?.family === 'string' ? ev.family.trim() : '';
    if (!family) {
      issues.push(`${at} — missing family id`);
    } else if (seen.has(family)) {
      issues.push(`${at} — duplicate family "${family}" (family ids must be unique within provides.events)`);
    } else {
      seen.add(family);
    }
    const template = typeof ev?.keyTemplate === 'string' ? ev.keyTemplate : '';
    if (!template) {
      issues.push(`${at} — missing keyTemplate (family "${family || '?'}")`);
      return;
    }
    const placeholders = new Set<string>();
    for (const m of template.matchAll(/<([^<>]+)>/g)) placeholders.add(m[1]);
    const declared = new Set<string>();
    for (const p of ev?.params ?? []) {
      const name = typeof p?.name === 'string' ? p.name : '';
      if (name) declared.add(name);
    }
    for (const name of placeholders) {
      if (!declared.has(name)) {
        issues.push(
          `${at} — keyTemplate placeholder "<${name}>" has no matching params entry (family "${family || '?'}")`,
        );
      }
    }
    for (const name of declared) {
      if (!placeholders.has(name)) {
        issues.push(
          `${at} — params entry "${name}" does not appear as "<${name}>" in keyTemplate "${template}" (family "${family || '?'}")`,
        );
      }
    }
  });

  const deps = manifest.dependencies?.events ?? [];
  deps.forEach((dep, i) => {
    const family = typeof dep?.family === 'string' ? dep.family.trim() : '';
    if (!family) issues.push(`dependencies.events[${i}] — missing family id`);
  });

  return issues;
}
