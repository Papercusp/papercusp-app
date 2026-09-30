/**
 * Standalone usage of `@papercusp/tooldef` — the falsifiable proof for the
 * extraction (plan papercusp-tooldef-extraction-2026-05-29, P-051).
 *
 * This file imports ONLY `@papercusp/tooldef`. No `@papercusp/agent-mcp`, no
 * `@papercusp/host-platform`, no `@papercusp/*`, no `postgres`, no Zod, no
 * Next.js — nothing host-specific. It registers a tool and dispatches it
 * through the engine's in-process dispatcher, exercising the full gate stack
 * (role / capability / quota / timeout / telemetry) on the engine's *generic
 * defaults*:
 *   - roles      → `AgentRole` is bare `string` (no host RoleRegistry augment)
 *   - quota      → `defaultComputeQuotaWindow` (run-scoped, perRun); none set here
 *   - tiers      → `tierFor` defaults to `'low'` (no host resolver registered)
 *   - auth       → no `ctx.gateBypass`, no `ctx.principal` → gates fail-closed but
 *                  this tool declares no roles/capabilities, so they pass
 *
 * That every one of those used to be a hard Papercusp dependency is exactly
 * what Phase 2 removed. Serving the same tool over HTTP + MCP with zero host
 * deps is the Phase-4 form of this proof (transports extract to
 * `@papercusp/tooldef-http` / `-mcp`); this is the in-process form available
 * today.
 *
 * Run: `npx tsx examples/standalone-inprocess.ts` from packages/tooldef.
 */
import {
  registerProjectedTool,
  lookupByMcpName,
  dispatchProjectedTool,
  type UnifiedToolContext,
  type DispatchProjectedDeps,
} from '@papercusp/tooldef';

// 1. Define a tool. `inputSchema` is a plain JSON Schema object — no validator
//    library required. `fn` is the function-as-truth: typed input in, a
//    Model-Context-Protocol `ToolResult` out.
registerProjectedTool({
  pluginName: 'example',
  description: 'Add two numbers',
  inputSchema: {
    type: 'object',
    properties: { a: { type: 'number' }, b: { type: 'number' } },
    required: ['a', 'b'],
  },
  capabilities: [], // no capability gate
  expose: { mcp: { name: 'math.add' } },
  async fn(input) {
    const { a, b } = input as { a: number; b: number };
    return { content: [{ type: 'text', text: String(a + b) }] };
  },
});

async function main(): Promise<void> {
  // 2. A minimal context. No principal, no tx, no spawn metadata — the engine
  //    only needs the four always-present fields.
  const ctx: UnifiedToolContext = {
    log: () => {},
    signal: new AbortController().signal,
    progress: () => {},
    emit: () => {},
  };
  // 3. No host deps — empty DI surface. Quota/telemetry/overrides all optional.
  const deps: DispatchProjectedDeps = {};

  // 4. Dispatch through the full engine pipeline.
  const tool = lookupByMcpName('math.add');
  if (!tool) throw new Error('tool not registered');
  const result = await dispatchProjectedTool(tool, 'math.add', { a: 2, b: 3 }, ctx, deps);

  const text = result.result?.content[0];
  const value = text && 'text' in text ? text.text : undefined;
  if (!result.ok || value !== '5') {
    throw new Error(`expected ok + "5", got ok=${result.ok} value=${value}`);
  }
  // eslint-disable-next-line no-console
  console.log(`✓ standalone @papercusp/tooldef dispatch: math.add(2,3) = ${value}`);
}

void main();
