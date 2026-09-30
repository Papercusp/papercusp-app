/**
 * Standalone usage of `@papercusp/tooldef-mcp` — the MCP leg of the extraction's
 * "three caller shapes, each proven standalone" proof (plan
 * papercusp-tooldef-extraction-2026-05-29, P-051). Companions:
 * `@papercusp/tooldef/examples/standalone-inprocess.ts` (in-process) and
 * `@papercusp/tooldef-http/examples/standalone-http.ts` (HTTP).
 *
 * This file imports ONLY `@papercusp/tooldef` + `@papercusp/tooldef-mcp` — no
 * `@papercusp/agent-mcp`, no MCP server library, no operator, no auth host. It
 * exercises both of the package's jobs:
 *   1. The `RequestHandlerExtra` extractors — pull bearer / url / headers out of
 *      the opaque `extra` an MCP server hands a request handler (here: the
 *      Vercel `mcp-handler` shape, hand-built).
 *   2. The dispatch → MCP-result mapper — run a tool through the engine and shape
 *      both a success (→ `{ content }`) and a gate denial (→ `{ isError, content }`).
 *
 * Run: `npx tsx examples/standalone-mcp.ts` from packages/tooldef-mcp.
 */
import {
  registerProjectedTool,
  lookupByMcpName,
  type UnifiedToolContext,
} from '@papercusp/tooldef';
import {
  bearerFromExtra,
  urlFromExtra,
  headersFromExtra,
  dispatchProjectedToolToMcp,
} from '@papercusp/tooldef-mcp';

// A tool with no capability gate — dispatches cleanly on the engine defaults.
registerProjectedTool({
  pluginName: 'example',
  description: 'Add two numbers',
  inputSchema: {
    type: 'object',
    properties: { a: { type: 'number' }, b: { type: 'number' } },
    required: ['a', 'b'],
  },
  capabilities: [],
  expose: { mcp: { name: 'math.add' } },
  async fn(input) {
    const { a, b } = input as { a: number; b: number };
    return { content: [{ type: 'text', text: String(a + b) }] };
  },
});

// A tool gated by `requireRoles` — the role-requirement gate is fail-closed for
// an anonymous caller (no `ctx.principal`), so the engine denies it and the
// mapper turns the denial into an MCP `{ isError: true }` result rather than
// throwing. (Note: a `capabilities`-gated tool would NOT deny here — the
// capability gate is principal-conditional and skips when there's no principal;
// `requireRoles` is the gate that fails closed for anonymous callers.)
registerProjectedTool({
  pluginName: 'example',
  description: 'Admin-only tool (role-gated)',
  inputSchema: { type: 'object' },
  capabilities: [],
  requireRoles: ['admin'],
  expose: { mcp: { name: 'admin.op' } },
  async fn() {
    return { content: [{ type: 'text', text: 'should-not-reach' }] };
  },
});

const ctx = (): UnifiedToolContext => ({
  log: () => {},
  signal: new AbortController().signal,
  progress: () => {},
  emit: () => {},
});

async function main(): Promise<void> {
  // 1. Extractors over a hand-built `extra` (the shape mcp-handler passes a
  //    request handler). No mcp-handler dependency required.
  const extra = {
    requestInfo: {
      headers: { authorization: 'Bearer tok-123', 'x-papercusp-workspace': 'w1' },
      url: 'https://host.example/mcp?client=sess-9',
    },
  };
  const bearer = bearerFromExtra(extra);
  const url = urlFromExtra(extra);
  const headers = headersFromExtra(extra);
  if (bearer !== 'tok-123') throw new Error(`bearer: got ${bearer}`);
  if (url?.searchParams.get('client') !== 'sess-9') throw new Error(`url: got ${url}`);
  if (headers.get('x-papercusp-workspace') !== 'w1') throw new Error('headers: workspace missing');

  // 2a. Map a successful dispatch → { content }.
  const addTool = lookupByMcpName('math.add');
  if (!addTool) throw new Error('math.add not registered');
  const ok = await dispatchProjectedToolToMcp(addTool, 'math.add', { a: 2, b: 3 }, ctx(), {});
  const okText = ok.content[0] && 'text' in ok.content[0] ? ok.content[0].text : undefined;
  if (ok.isError || okText !== '5') throw new Error(`success map: isError=${ok.isError} text=${okText}`);

  // 2b. Map a gate denial → { isError: true, content:[{ text:'<code>: <message>' }] }.
  const adminTool = lookupByMcpName('admin.op');
  if (!adminTool) throw new Error('admin.op not registered');
  const denied = await dispatchProjectedToolToMcp(adminTool, 'admin.op', {}, ctx(), {});
  const deniedText = denied.content[0] && 'text' in denied.content[0] ? denied.content[0].text : '';
  if (!denied.isError || typeof deniedText !== 'string' || deniedText.length === 0) {
    throw new Error(`denial map: isError=${denied.isError} text=${deniedText}`);
  }

  // eslint-disable-next-line no-console
  console.log(
    `✓ standalone @papercusp/tooldef-mcp: extractors ok; math.add → "${okText}"; ` +
      `admin.op → isError (${deniedText})`,
  );
}

void main();
