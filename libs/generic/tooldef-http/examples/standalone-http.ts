/**
 * P-051 (HTTP-serving form) — serve a tool over the HTTP transport importing
 * ONLY `@papercusp/tooldef` + `@papercusp/tooldef-http`. No `@papercusp/agent-mcp`,
 * no operator, no Postgres, no auth host — `extras` is an empty DI surface.
 *
 * Together with `packages/tooldef/examples/standalone-inprocess.ts` (in-process
 * dispatch) and `@papercusp/tooldef-mcp`'s `dispatchProjectedToolToMcp` test (the
 * MCP-result mapping), this is the falsifiable proof that the extracted engine +
 * adapters are usable standalone across all three caller shapes.
 *
 * Run: `npx tsx examples/standalone-http.ts` from packages/tooldef-http.
 */
import { registerProjectedTool } from '@papercusp/tooldef';
import { handleHttpToolRequest, type HttpToolRequest } from '@papercusp/tooldef-http';

registerProjectedTool({
  pluginName: 'example',
  description: 'Add two numbers',
  inputSchema: {
    type: 'object',
    properties: { a: { type: 'number' }, b: { type: 'number' } },
    required: ['a', 'b'],
  },
  capabilities: [],
  expose: { mcp: { name: 'math.add' }, http: { path: '/api/plugins/example/add', methods: ['POST'] } },
  async fn(input) {
    const { a, b } = input as { a: number; b: number };
    return { content: [{ type: 'text', text: String(a + b) }] };
  },
});

async function main(): Promise<void> {
  // A transport-neutral request the adapter resolves to the tool by pathname.
  // A real host builds this from a Fetch `Request` / Next / Hono request.
  const req: HttpToolRequest = {
    method: 'POST',
    pathname: '/api/plugins/example/add',
    searchParams: new URLSearchParams(),
    headers: {},
    body: { a: 2, b: 3 },
  };
  // Empty DI surface — no principal resolution, no quota/telemetry, no superuser.
  const res = await handleHttpToolRequest(req, { deps: {} });

  const body = res.body as { content?: Array<{ text?: string }> };
  const value = body.content?.[0]?.text;
  if (res.status !== 200 || value !== '5') {
    throw new Error(`expected 200 + "5", got status=${res.status} value=${value}`);
  }
  // eslint-disable-next-line no-console
  console.log(`✓ standalone HTTP dispatch: POST /api/plugins/example/add {a:2,b:3} → ${res.status} "${value}"`);
}

void main();
