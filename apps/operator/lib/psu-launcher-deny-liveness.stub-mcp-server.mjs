#!/usr/bin/env node
/**
 * Test FIXTURE (not a test, and not a standalone smoke script): a stdio MCP server advertising
 * N deliberately fat tools, spawned by `psu-launcher-deny-liveness.integration.test.ts`.
 *
 * WHY IT EXISTS. Claude advertises `ToolSearch` and `DeferredToolPlaceholder` ONLY when MCP
 * servers are configured, and it only defers anything when there is a surface worth deferring.
 * A capture taken with `--mcp-config {"mcpServers":{}}` therefore reports both as ABSENT no
 * matter what the launch flags say — indistinguishable from a deny that works. Every P-007
 * assertion about deferral would be vacuous without a server here.
 *
 * Deliberately a STUB rather than the real papercusp-su server: the surface must be identical
 * across arms and reproducible on any box, and it must touch no live operator state, register
 * no session, and need no credentials.
 */
const N = Number(process.env.STUB_TOOL_COUNT || 40);
const PAD = Number(process.env.STUB_TOOL_PAD || 2500);

const tools = Array.from({ length: N }, (_, i) => ({
  name: `stub_tool_${String(i).padStart(3, '0')}`,
  description: `Stub tool ${i} for deferral measurement. ` + 'x'.repeat(PAD),
  inputSchema: {
    type: 'object',
    properties: {
      q: { type: 'string', description: 'y'.repeat(300) },
      n: { type: 'number', description: 'z'.repeat(300) },
    },
    required: ['q'],
  },
}));

function send(o) {
  process.stdout.write(JSON.stringify(o) + '\n');
}

function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined || id === null) return; // notification: no reply
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: params?.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'psu-deny-liveness-stub', version: '0.0.1' },
      },
    });
  } else if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools } });
  } else if (method === 'resources/list') {
    send({ jsonrpc: '2.0', id, result: { resources: [] } });
  } else if (method === 'resources/templates/list') {
    send({ jsonrpc: '2.0', id, result: { resourceTemplates: [] } });
  } else if (method === 'prompts/list') {
    send({ jsonrpc: '2.0', id, result: { prompts: [] } });
  } else if (method === 'tools/call') {
    send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'ok' }] } });
  } else {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `no method ${method}` } });
  }
}

let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    try {
      handle(JSON.parse(line));
    } catch {
      /* ignore unparseable frame */
    }
  }
});
process.stdin.resume();
