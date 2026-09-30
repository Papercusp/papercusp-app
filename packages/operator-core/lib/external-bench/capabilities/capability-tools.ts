/**
 * capability-tools.ts — the {@link CapabilityTool} wrappers (plan
 * benchmark-capability-injection-redesign-2026-06-17, P-001).
 *
 * Thin functions exposing our REAL systems as agent-callable tools, each bound to a
 * {@link RunSandbox} so every call carries the sandbox scope. They call the genuine MCP
 * verbs through the LOOPBACK run-tool route — the SAME pattern `su-independent-backlog.ts`
 * uses (POST `:3170/api/agent-mcp/run-tool` with `{ name, args }`, then unwrap the tool
 * payload from `result.content[0].text`). So a benchmark arm exercises the production
 * `memory:*` / `work_items:*` / `coord:*` code paths, not a re-implementation.
 *
 * The mapping (palette table + the confirmed tool schemas):
 *   - memory.remember(fact) / memory.search(query) → `memory:remember` / `memory:search`
 *     with `hive_slug = sandbox.potSlug` (the hive's shared pool IS the namespace).
 *   - workqueue.enqueue(subtask) / claim() / complete(id) → `work_items:create` /
 *     `work_items:claim_next` / `work_items:complete` scoped to `sandbox.memberSlug` (the
 *     member harness holds the run's work_items — its `harness` arg).
 *   - coord.consult(specialist, q) / handoff(...) / ask(q) → `coord:ask` / `coord:handoff` /
 *     `coord:ask` scoped to the sandbox hive (the `harness` arg restricts to the hive).
 *
 * Each tool carries a `name` + a JSON-schema descriptor so the set can be (a) injected
 * into a turn-generator's tool-set AND (b) allow-listed by the personas plan's
 * `roles[].tools` tool-scoping (D-010). The loopback fetch is dependency-injected
 * ({@link OpenRunSandboxDeps.runTool}) so tests never make a real MCP call.
 */
import type {
  CapabilityTool,
  JsonSchema,
  RunSandbox,
  RunTool,
  RunToolResult,
  SandboxHiveOps,
} from './types';

/**
 * Dependencies for opening a sandbox + materializing capability tools. Inject `hiveOps`
 * (the ephemeral-hive lifecycle seam) + `runTool` (the loopback run-tool) so the whole
 * substrate unit-tests with fakes: NO real hive boot, NO real MCP call, NO opus spend.
 */
export interface OpenRunSandboxDeps {
  /** The workspace the sandbox + its capability calls live in. */
  workspaceId: string;
  /** The ephemeral-hive lifecycle seam (boot/teardown). */
  hiveOps: SandboxHiveOps;
  /** The loopback run-tool seam every capability tool fires through. */
  runTool: RunTool;
  /** Per-sandbox scratch parent for the member harness clone path. Default `/tmp/xbench-capabilities`. */
  scratchParent?: string;
}

/* -------------------------------------------------------------------------- */
/* The LIVE loopback run-tool (mirrors su-independent-backlog.ts)              */
/* -------------------------------------------------------------------------- */

/**
 * The LIVE {@link RunTool} — calls the operator's MCP endpoint (`/api/mcp?superuser=1`)
 * via a JSON-RPC `tools/call`, then unwraps the tool payload from `result.content[0].text`.
 *
 * WHY the MCP endpoint and NOT `/api/agent-mcp/run-tool` (the original wiring): the run-tool
 * route is the PALETTE runner and rejects arg-taking tools with `not_palette_eligible`
 * ("requires arguments") — `memory:*` / `work_items:*` / `coord:*` all take args, so they 403
 * there (plan D-013, confirmed by an auth-probe). The full MCP endpoint accepts `tools/call`
 * with arguments; it only needs a per-call `workspace` (the tool wrappers pass
 * `sandbox.workspaceId`) + the superuser bearer:
 *   - route via `operatorApiBase()` (PAPERCUSP_OPERATOR_BASE → :3170 staging; else PAPERCUSP_HONO_PORT);
 *   - bearer from `~/.papercusp/superuser-token` (the `superuser=1` gate);
 *   - the response is SSE (`text/event-stream`) — parse the `data:` line's JSON-RPC envelope;
 *   - the MCP result is `{ content: [{ text: "<json>" }], isError? }` — unwrap to the tool payload.
 *
 * The injected `runTool` ({@link OpenRunSandboxDeps.runTool}) is what tests pass instead, so the
 * fake-driven unit tests make no real call. A live smoke (real `memory:remember`) covers THIS
 * path — the D-013 lesson: stubbed-only tests hid the wrong endpoint.
 */
export function liveRunTool(): RunTool {
  return async (name, args) => {
    const { operatorApiBase } = await import('../../operator-api-base');
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    let token = '';
    try {
      token = (await fs.readFile(path.join(os.homedir(), '.papercusp', 'superuser-token'), 'utf8')).trim();
    } catch {
      /* a trusted-localhost loopback operator may not require it */
    }
    const url = `${operatorApiBase()}/api/mcp?superuser=1`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      });
    } catch (e) {
      return { ok: false, payload: {}, error: `fetch failed: ${(e as Error).message}` };
    }
    if (!res.ok) {
      return { ok: false, payload: {}, error: `HTTP ${res.status} ${await res.text().catch(() => '')}` };
    }
    const env = parseMcpSseResult(await res.text());
    if (!env) return { ok: false, payload: {}, error: 'unparseable MCP response' };
    if (env.error) return { ok: false, payload: {}, error: `MCP error: ${JSON.stringify(env.error).slice(0, 300)}` };
    const result = env.result as { content?: Array<{ text?: string }>; isError?: boolean } | undefined;
    const payload = unwrapRunToolPayload(result);
    if (result?.isError) {
      const txt = result.content?.[0]?.text ?? '';
      return { ok: false, payload, error: `tool error: ${txt.slice(0, 300)}` };
    }
    return { ok: true, payload };
  };
}

/**
 * Parse an MCP streamable-HTTP response: the body is SSE (`event: message` / `data: {json}`),
 * possibly preceded by a `:stream-open` comment. Returns the JSON-RPC envelope ({result}|{error})
 * from the last `data:` line that carries one. Tolerates a plain-JSON body too.
 */
export function parseMcpSseResult(body: string): { result?: unknown; error?: unknown } | null {
  const dataLines = body
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice('data:'.length).trim());
  for (let i = dataLines.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(dataLines[i]) as { result?: unknown; error?: unknown };
      if (obj && typeof obj === 'object' && ('result' in obj || 'error' in obj)) return obj;
    } catch {
      /* skip non-JSON data lines */
    }
  }
  try {
    const obj = JSON.parse(body) as { result?: unknown; error?: unknown };
    if (obj && typeof obj === 'object') return obj;
  } catch {
    /* not plain JSON */
  }
  return null;
}

/**
 * Unwrap a run-tool `result` into the tool payload. The route wraps the MCP return as
 * `{ content: [{ text: "<json>" }] }`; parse that JSON. Tolerates a flat result object
 * (no `content` wrapper) and a non-JSON text body (returns `{ text }`).
 */
export function unwrapRunToolPayload(result: unknown): Record<string, unknown> {
  const wrapped = result as { content?: Array<{ text?: string }> } | undefined;
  const text = wrapped?.content?.[0]?.text;
  if (typeof text === 'string') {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
      return { value: parsed };
    } catch {
      return { text };
    }
  }
  if (result && typeof result === 'object') return result as Record<string, unknown>;
  return {};
}

/* -------------------------------------------------------------------------- */
/* Tool-call helper                                                            */
/* -------------------------------------------------------------------------- */

/** Fire a sandbox-bound run-tool call; throw a descriptive error when the call failed. */
async function callTool(sandbox: RunSandbox, name: string, args: Record<string, unknown>): Promise<RunToolResult> {
  const res = await sandbox.runTool(name, args);
  if (!res.ok) {
    throw new Error(`capability tool ${name} failed: ${res.error ?? 'unknown run-tool error'}`);
  }
  return res;
}

/* -------------------------------------------------------------------------- */
/* memory capability — memory:remember / memory:search                         */
/* -------------------------------------------------------------------------- */

export interface MemoryRememberArgs {
  /** The fact to store (verbatim). */
  fact: string;
  /** The memory kind; defaults to `project` (run-scoped working context). */
  kind?: 'user' | 'feedback' | 'project' | 'reference';
}
export interface MemorySearchArgs {
  /** The recall query. */
  query: string;
  /** Max hits; defaults to the verb's default. */
  limit?: number;
}

/** `memory.remember(fact)` → `memory:remember` with `hive_slug = sandbox.potSlug`. */
export function memoryRememberTool(sandbox: RunSandbox): CapabilityTool<MemoryRememberArgs, RunToolResult> {
  return {
    name: 'memory.remember',
    capability: 'memory',
    description: 'Store a fact in the sandbox memory pool so later tasks in this run can recall it.',
    inputSchema: {
      type: 'object',
      properties: {
        fact: { type: 'string', description: 'The fact to remember (stored verbatim).' },
        kind: { type: 'string', description: 'user | feedback | project | reference (default project).' },
      },
      required: ['fact'],
      additionalProperties: false,
    },
    invoke: (args) =>
      callTool(sandbox, 'memory:remember', {
        content: args.fact,
        kind: args.kind ?? 'project',
        // The hive's shared pool IS the per-run namespace — isolated from production mem0
        // and from every other run/arm; accumulates across all tasks in THIS run (D-007).
        hive_slug: sandbox.potSlug,
        workspace: sandbox.workspaceId,
      }),
  };
}

/** `memory.search(query)` → `memory:search` scoped to the sandbox hive's pool. */
export function memorySearchTool(sandbox: RunSandbox): CapabilityTool<MemorySearchArgs, RunToolResult> {
  return {
    name: 'memory.search',
    capability: 'memory',
    description: 'Recall facts stored earlier in this run from the sandbox memory pool.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to recall.' },
        limit: { type: 'number', description: 'Max hits.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    invoke: (args) =>
      callTool(sandbox, 'memory:search', {
        query: args.query,
        // memory:search reads hive-scoped pools via harness_slug fan-out; pass the member
        // harness so the search is scoped to THIS sandbox's hive (the member resolves to the
        // hive pool the remember-side wrote under). workspace pins the SU fan-out.
        harness_slug: sandbox.memberSlug,
        ...(args.limit != null ? { limit: args.limit } : {}),
        workspace: sandbox.workspaceId,
      }),
  };
}

/* -------------------------------------------------------------------------- */
/* workqueue capability — work_items:create / claim_next / complete            */
/* -------------------------------------------------------------------------- */

export interface WorkqueueEnqueueArgs {
  /** The subtask title. */
  title: string;
  /** Optional body/summary. */
  summary?: string;
}
export interface WorkqueueClaimArgs {
  /** Optional assignee override (default: the caller). */
  assignee?: string;
}
export interface WorkqueueCompleteArgs {
  /** The work-item id to complete (e.g. WI-NNN). */
  id: string;
  /** A short completion summary. */
  summary?: string;
}

/** `workqueue.enqueue(subtask)` → `work_items:create` (kind feature) scoped to the member harness. */
export function workqueueEnqueueTool(sandbox: RunSandbox): CapabilityTool<WorkqueueEnqueueArgs, RunToolResult> {
  return {
    name: 'workqueue.enqueue',
    capability: 'workqueue',
    description: 'Enqueue a subtask into the sandbox work-queue (decompose a big task into tracked sub-deliverables).',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short subtask title.' },
        summary: { type: 'string', description: 'Subtask body / detail.' },
      },
      required: ['title'],
      additionalProperties: false,
    },
    invoke: (args) =>
      callTool(sandbox, 'work_items:create', {
        kind: 'feature',
        title: args.title,
        ...(args.summary != null ? { summary: args.summary } : {}),
        harness: sandbox.memberSlug, // the member harness holds the run's work_items.
        workspace: sandbox.workspaceId,
      }),
  };
}

/** `workqueue.claim()` → `work_items:claim_next` scoped to the member harness. */
export function workqueueClaimTool(sandbox: RunSandbox): CapabilityTool<WorkqueueClaimArgs, RunToolResult> {
  return {
    name: 'workqueue.claim',
    capability: 'workqueue',
    description: 'Claim the next available subtask from the sandbox work-queue.',
    inputSchema: {
      type: 'object',
      properties: {
        assignee: { type: 'string', description: 'Who claims it (default: you).' },
      },
      additionalProperties: false,
    },
    invoke: (args) =>
      callTool(sandbox, 'work_items:claim_next', {
        harness: sandbox.memberSlug,
        ...(args.assignee != null ? { assignee: args.assignee } : {}),
        workspace: sandbox.workspaceId,
      }),
  };
}

/** `workqueue.complete(id)` → `work_items:complete` scoped to the member harness. */
export function workqueueCompleteTool(sandbox: RunSandbox): CapabilityTool<WorkqueueCompleteArgs, RunToolResult> {
  return {
    name: 'workqueue.complete',
    capability: 'workqueue',
    description: 'Mark a sandbox work-queue subtask complete.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The work-item id (WI-NNN).' },
        summary: { type: 'string', description: 'A short completion summary.' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    invoke: (args) =>
      callTool(sandbox, 'work_items:complete', {
        id: args.id,
        harness: sandbox.memberSlug,
        state: 'passed',
        completion: { summary: args.summary ?? `Completed ${args.id}` },
        workspace: sandbox.workspaceId,
      }),
  };
}

/* -------------------------------------------------------------------------- */
/* coord capability — coord:message-agent / coord:handoff                      */
/* -------------------------------------------------------------------------- */

export interface CoordConsultArgs {
  /** The specialist / role to consult. */
  specialist: string;
  /** The question. */
  question: string;
}
export interface CoordHandoffArgs {
  /** Who to hand off to (peer ids / roles). */
  to: string[];
  /** A summary of the handoff. */
  summary: string;
  /** Optional next action. */
  nextAction?: string;
}
export interface CoordAskArgs {
  /** The sandbox peer to ask. Required — coord:ask refuses an unaddressed question (WI-5951). */
  peer: string;
  /** The question to ask that peer. */
  question: string;
}

/** `coord.consult(specialist, q)` → a directed conversation scoped to the sandbox hive. */
export function coordConsultTool(sandbox: RunSandbox): CapabilityTool<CoordConsultArgs, RunToolResult> {
  return {
    name: 'coord.consult',
    capability: 'coord',
    description: 'Consult a specialist peer inside the sandbox (a scoped coord question to a named role).',
    inputSchema: {
      type: 'object',
      properties: {
        specialist: { type: 'string', description: 'The specialist / role to consult.' },
        question: { type: 'string', description: 'What to ask them.' },
      },
      required: ['specialist', 'question'],
      additionalProperties: false,
    },
    invoke: (args) =>
      callTool(sandbox, 'coord:message-agent', {
        body: `[consult:${args.specialist}] ${args.question}`,
        harness: sandbox.potSlug, // scope the question to the sandbox hive — never the live fleet.
        to: args.specialist,
      }),
  };
}

/** `coord.handoff(...)` → `coord:handoff` scoped to the sandbox hive. */
export function coordHandoffTool(sandbox: RunSandbox): CapabilityTool<CoordHandoffArgs, RunToolResult> {
  return {
    name: 'coord.handoff',
    capability: 'coord',
    description: 'Hand work off to a sandbox peer with a summary + next action.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'array', description: 'Peer ids / roles to hand off to.', items: { type: 'string' } },
        summary: { type: 'string', description: 'Handoff summary.' },
        nextAction: { type: 'string', description: 'What the recipient should do next.' },
      },
      required: ['to', 'summary'],
      additionalProperties: false,
    },
    invoke: (args) =>
      callTool(sandbox, 'coord:handoff', {
        to: args.to,
        summary: args.summary,
        ...(args.nextAction != null ? { next_action: args.nextAction } : {}),
      }),
  };
}

/** `coord.ask(q)` → a directed conversation scoped to the sandbox hive. */
export function coordAskTool(sandbox: RunSandbox): CapabilityTool<CoordAskArgs, RunToolResult> {
  return {
    name: 'coord.ask',
    capability: 'coord',
    description: 'Ask a NAMED sandbox peer a question (a scoped, addressed coord question).',
    inputSchema: {
      type: 'object',
      properties: {
        peer: { type: 'string', description: 'The sandbox peer to ask. Required — an unaddressed question reaches nobody.' },
        question: { type: 'string', description: 'The question.' },
      },
      required: ['peer', 'question'],
      additionalProperties: false,
    },
    // WI-5951: this was a broadcast ("ask the sandbox peers") — the exact shape
    // retired platform-side, where 53 unaddressed questions drew zero answers in
    // 7 weeks. A bench that lets an agent do what the platform forbids measures
    // the wrong thing, so the recipient is required here too.
    invoke: (args) =>
      callTool(sandbox, 'coord:message-agent', {
        body: args.question,
        harness: sandbox.potSlug, // scope to the sandbox hive — never the live fleet.
        to: args.peer,
      }),
  };
}

/* -------------------------------------------------------------------------- */
/* All-tool factories, grouped by capability (the materializer consumes these) */
/* -------------------------------------------------------------------------- */

/**
 * A factory binding one tool to a sandbox — what the profile materializer calls. The
 * `never` arg makes a specific-arg tool factory (e.g. `(s) => CapabilityTool<MemoryRememberArgs>`)
 * assignable here (the contravariant `invoke(args: never)` accepts any concrete arg type);
 * the materializer hands the resulting tools to a turn-generator that calls `invoke` with
 * runtime-validated args.
 */
export type CapabilityToolFactory = (sandbox: RunSandbox) => CapabilityTool<never, unknown>;

/** Every tool factory for one capability. The profile materializer picks by capability. */
export const CAPABILITY_TOOL_FACTORIES: Record<string, CapabilityToolFactory[]> = {
  memory: [memoryRememberTool, memorySearchTool],
  workqueue: [workqueueEnqueueTool, workqueueClaimTool, workqueueCompleteTool],
  coord: [coordConsultTool, coordHandoffTool, coordAskTool],
};

/** Build every tool for one capability, bound to the sandbox. */
export function toolsForCapability(capability: string, sandbox: RunSandbox): CapabilityTool[] {
  return (CAPABILITY_TOOL_FACTORIES[capability] ?? []).map((make) => make(sandbox));
}
