/**
 * P5 diagnostic — does omp connect the `agentmcp` HTTP MCP server when
 * spawned exactly the way operator:converse spawns it?
 *
 * Throwaway. Delete after P5 triage closes.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { runAgentChat } from '../../../libs/papercusp-shared/src/agent/chat-stream';

const token = readFileSync(join(homedir(), '.papercusp', 'superuser-token'), 'utf8').trim();
const mcpUrl = 'http://127.0.0.1:3070/api/mcp?superuser=1&workspace=default';

const mcpConfig = {
  mcpServers: {
    agentmcp: {
      type: 'http',
      url: mcpUrl,
      headers: { Authorization: `Bearer ${token}` },
    },
  },
};

const promptText =
  'You have an MCP tool called `harness:list`. Call it right now to list ' +
  'the harnesses in this workspace, then tell me their slugs. You MUST ' +
  'actually invoke the tool — do not guess or describe what it would return.';

const main = async () => {
  const t0 = Date.now();
  console.error(`[repro] starting at ${new Date().toISOString()}`);
  for await (const ev of runAgentChat({
    promptText,
    model: 'anthropic/claude-opus-4-7',
    mcpConfig,
    allowedTools: [],
    permissionMode: 'bypassPermissions',
  })) {
    const t = ((Date.now() - t0) / 1000).toFixed(1);
    if (ev.type === 'delta') {
      process.stdout.write(`[${t}s delta] ${ev.text}\n`);
    } else if (ev.type === 'tool_call') {
      console.error(`[${t}s TOOL_CALL] name=${ev.name} input=${JSON.stringify(ev.input)}`);
    } else if (ev.type === 'result') {
      console.error(`[${t}s RESULT] cost=${ev.costUsd} finalText.len=${ev.finalText.length}`);
    } else if (ev.type === 'error') {
      console.error(`[${t}s ERROR] ${ev.message}\n--stderr--\n${ev.stderr ?? ''}`);
    }
  }
  console.error(`[repro] done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
};

main().catch((e) => {
  console.error('[repro] threw:', e);
  process.exit(1);
});
