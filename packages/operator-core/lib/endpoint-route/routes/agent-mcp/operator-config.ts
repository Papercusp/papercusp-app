/**
 * GET /api/agent-mcp/operator-config — prompt + preferences + substrate.
 * PUT — write prompt_user / preferences.
 * Ported from app/api/agent-mcp/operator-config/route.ts. `auth: 'public'`.
 */
import { OPERATOR_SUBSTRATE_PROMPT } from '../../../operator-prompt-system';
import { readOperatorState, writeOperatorState } from '../../../operator-state-pg';
// The defaults live beside the sync resolver's copy of this read on purpose:
// both readers render the same editor and must fall back to the SAME text
// (operator-config-defaults.ts, EI-22439758558949990).
import { DEFAULT_PREFS, DEFAULT_PROMPT_USER, operatorConfigContent } from '../../../operator-config-defaults';
import { defineTool } from '@papercusp/agent-mcp';

const PROMPT_USER_LABEL = 'harness_shared.operator_prompt_user';
const PREFS_LABEL = 'harness_shared.operator_preferences';

async function readContent(
  table: 'operator_prompt_user' | 'operator_preferences',
  fallback: string,
): Promise<string> {
  return operatorConfigContent(await readOperatorState<{ content?: string }>(table), fallback);
}

async function buildPayload() {
  const [prompt_user, preferences] = await Promise.all([
    readContent('operator_prompt_user', DEFAULT_PROMPT_USER),
    readContent('operator_preferences', DEFAULT_PREFS),
  ]);
  return {
    prompt_user,
    preferences,
    substrate_prompt: OPERATOR_SUBSTRATE_PROMPT,
    prompt_user_path: PROMPT_USER_LABEL,
    prefs_path: PREFS_LABEL,
  };
}

const get = defineTool({
  method: 'GET',
  path: '/agent-mcp/operator-config',
  auth: 'public',
  async handler() {
    return Response.json(await buildPayload());
  },
});

const put = defineTool({
  method: 'PUT',
  path: '/agent-mcp/operator-config',
  auth: 'loopback',
  async handler(req) {
    const body = (await req.json()) as { prompt_user?: string; preferences?: string };
    if (typeof body.prompt_user === 'string') {
      await writeOperatorState('operator_prompt_user', { content: body.prompt_user });
    }
    if (typeof body.preferences === 'string') {
      await writeOperatorState('operator_preferences', { content: body.preferences });
    }
    return Response.json(await buildPayload());
  },
});

export default [get, put];
