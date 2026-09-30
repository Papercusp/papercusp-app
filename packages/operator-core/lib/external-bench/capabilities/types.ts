/**
 * capabilities/types.ts — the shared types for the benchmark capability-injection
 * substrate (plan benchmark-capability-injection-redesign-2026-06-17, P-001 + P-002).
 *
 * WHY THIS EXISTS. The redesign reframes the benchmark arms from "which TOPOLOGY"
 * (su / hive / vanilla) to "which of our REAL systems (memory / work-queue / coord)
 * does the agent get" (D-001). The arms hold the model fixed and vary the capability
 * SET. To measure that honestly the agent must call our genuine systems — but never
 * touch production mem0, never enqueue into a live harness, never address a real
 * fleet agent (D-003). The {@link RunSandbox} is that isolation boundary, and a
 * {@link CapabilityTool} is a thin wrapper that binds one real MCP verb to a sandbox
 * so every call carries the sandbox scope.
 *
 * This module is types + the injected IO seams ONLY — no live IO. The live wirings
 * live in `run-sandbox.ts` (the ephemeral-hive ops) and `capability-tools.ts` (the
 * loopback run-tool fetch). Both seams are dependency-injected so the unit tests run
 * with fakes: NO real hive boot, NO real MCP call, NO opus spend.
 */

/* -------------------------------------------------------------------------- */
/* The loopback run-tool seam (mirrors su-independent-backlog.ts)             */
/* -------------------------------------------------------------------------- */

/**
 * ONE invocation of a real MCP tool through the operator's loopback `run-tool`
 * route — the same shape `su-independent-backlog.ts` POSTs to
 * `:3170/api/agent-mcp/run-tool` (`{ name, args }`). The capability tools call
 * the real `memory:*` / `work_items:*` / `coord:*` verbs through this seam so
 * benchmark arms exercise the production code paths, not a re-implementation.
 *
 * The run-tool route wraps a tool's MCP return as
 * `{ ok, result: { content: [{ text: "<json>" }] } }` (or, tolerated, a flat
 * `result`). {@link RunTool} returns the UNWRAPPED tool payload so callers don't
 * each re-parse the envelope. A non-ok tool result throws (the capability call
 * failed) — the caller decides whether that aborts the task or is recorded.
 */
export type RunTool = (name: string, args: Record<string, unknown>) => Promise<RunToolResult>;

/** The unwrapped tool payload + the run-tool envelope status. */
export interface RunToolResult {
  /** The run-tool envelope `ok` (false ⇒ the route or the tool errored). */
  ok: boolean;
  /** The unwrapped tool payload (parsed from `result.content[0].text`, else the flat `result`). */
  payload: Record<string, unknown>;
  /** The run-tool envelope `error`, when `ok` is false. */
  error?: string;
}

/* -------------------------------------------------------------------------- */
/* The ephemeral-hive ops seam (mirrors su-independent-backlog.ts boot)        */
/* -------------------------------------------------------------------------- */

/**
 * The hive-lifecycle IO the {@link RunSandbox} needs, as ONE injectable seam so the
 * sandbox open/dispose ordering unit-tests with a fake (NO live hive). The live
 * binding ({@link import('./run-sandbox').liveSandboxHiveOps}) wires these to
 * `liveHiveOps` exactly as `su-independent-backlog.ts`'s real ops do:
 * `createHive` → `registerMember` → `seedFeature` on open, `dropMember` →
 * `dissolveHive` on dispose.
 */
export interface SandboxHiveOps {
  /** Boot an idle ephemeral hive (the Queen seat) — `liveHiveOps.createHive`. */
  createHive(input: { slug: string; workspaceId: string }): Promise<void>;
  /** Enroll the member harness that holds the run's work_items — `liveHiveOps.registerMember`. */
  registerMember(input: { member: string; clonePath: string; hiveHome: string; workspaceId: string }): Promise<void>;
  /** Seed the member's lone bootstrap feature — `liveHiveOps.seedFeature`. */
  seedFeature(input: { member: string; featureId: string; title: string; spec: string; workspaceId: string }): Promise<void>;
  /** Drop the member harness enrollment (best-effort) — `liveHiveOps.dropMember`. */
  dropMember(input: { member: string; workspaceId: string }): Promise<void>;
  /** Dissolve the ephemeral hive (best-effort) — `liveHiveOps.dissolveHive`. */
  dissolveHive(input: { hiveHome: string; workspaceId: string }): Promise<void>;
}

/* -------------------------------------------------------------------------- */
/* RunSandbox (P-002)                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The per-(suite-run × arm) isolation boundary (P-002 / D-003 / D-007). A run-sandbox
 * is backed by a per-run EPHEMERAL HIVE whose `potSlug` is the SHARED NAMESPACE for
 * all three capabilities:
 *   - memory → `memory:*` scoped by `hive_slug = potSlug` (the hive's shared pool —
 *     isolated from production mem0 and from every other run/arm);
 *   - work-queue → `work_items:*` scoped to `memberSlug` (the member harness holds the
 *     run's work_items; they die with the hive);
 *   - coord → `coord:*` scoped to `potSlug` (peer messages stay inside the sandbox; no
 *     real fleet agent is addressed).
 *
 * It PERSISTS for the whole run/arm — memory ACCUMULATES across every task in the run,
 * which is the cross-task-learning lift the benchmark measures (D-007). {@link dispose}
 * tears the hive down at run end so the sandbox is wiped and never leaks to production
 * or between runs.
 */
export interface RunSandbox {
  /** The ephemeral hive slug — the shared namespace for memory (hive_slug) + coord (harness scope). */
  readonly potSlug: string;
  /** The member harness slug — the work-queue (`work_items:*`) scope. */
  readonly memberSlug: string;
  /** Identifies the (suite, arm, runId) this sandbox isolates — diagnostics + report attribution. */
  readonly id: SandboxId;
  /** The run-tool seam the capability tools fire through (carried so tools bind to ONE sandbox). */
  readonly runTool: RunTool;
  /** The workspace the sandbox lives in (carried through to capability-tool calls). */
  readonly workspaceId: string;
  /** Tear the ephemeral hive down (dropMember → dissolveHive). Idempotent + best-effort. */
  dispose(): Promise<void>;
}

/** The (suite, arm, runId) tuple a sandbox isolates. */
export interface SandboxId {
  suite: string;
  arm: string;
  runId: string;
}

/* -------------------------------------------------------------------------- */
/* CapabilityTool (P-001)                                                      */
/* -------------------------------------------------------------------------- */

/**
 * One agent-callable tool exposing a REAL system, bound to a {@link RunSandbox} so
 * every invocation carries the sandbox scope (P-001). Each tool carries:
 *   - `name` — the benchmark-facing tool name (`memory.remember`, `workqueue.claim`, …);
 *   - `capability` — which palette capability it belongs to (the attribution arm key);
 *   - `inputSchema` — a JSON-schema descriptor so the set can be (a) injected into a
 *     turn-generator's tool-set AND (b) allow-listed by the personas plan's
 *     `roles[].tools` tool-scoping (D-010);
 *   - `invoke` — runs the tool, firing the bound sandbox's `runTool` at the right MCP verb.
 */
export interface CapabilityTool<Args = Record<string, unknown>, Result = unknown> {
  /** The benchmark-facing tool name, e.g. `memory.remember`. */
  readonly name: string;
  /** Which palette capability this tool belongs to (the attribution key). */
  readonly capability: CapabilityKind;
  /** A one-line description for the agent's tool-set. */
  readonly description: string;
  /** JSON-schema descriptor for the tool's args (for injection + tool-scoping). */
  readonly inputSchema: JsonSchema;
  /** Invoke the tool — fires the bound sandbox's run-tool at the underlying MCP verb. */
  invoke(args: Args): Promise<Result>;
}

/** The three palette capabilities (the attribution arms — D-011). */
export type CapabilityKind = 'memory' | 'workqueue' | 'coord';

/**
 * A minimal JSON-schema object descriptor — exactly what a turn-generator's tool-set
 * and the personas plan's `roles[].tools` allow-list need. Intentionally narrow (object
 * schemas with typed properties); not a full JSON-Schema implementation.
 */
export interface JsonSchema {
  type: 'object';
  properties: Record<string, JsonSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface JsonSchemaProperty {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  description?: string;
  items?: JsonSchemaProperty;
}
