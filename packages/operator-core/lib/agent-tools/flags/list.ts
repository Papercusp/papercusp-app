/**
 * flags:list - returns all Papercusp feature flags and their resolved
 * boolean state for the current host. Mirrors what /api/flags/bootstrap
 * returns; the tool exists so agents can inspect flag state without
 * making an HTTP call.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';

import { ALL_FLAG_KEYS } from '@papercusp/flags';
import { getAllFlags } from '@papercusp/flags/server';
import { resolveDistinctId } from '../../flag-distinct-id';
import './_register-backend';

export default defineTool({
  name: 'flags:list',
  profile: 'engineer',
  description:
    'List every Papercusp feature flag with its resolved boolean state for this host. Use to discover what features are gated, audit V1 ship state, or check whether a flag is on before suggesting work that depends on it.',
  capability: 'intel:read',
  guidance: {
    when: 'Before recommending or executing work that lives behind a feature flag (snapshots, templates, marketplace, oracle, harness phases, cloudflare publish).',
    notWhen: 'For runtime user-facing flag reads, use the /api/flags/bootstrap endpoint from the client.',
    seeAlso: [
      'flags:get (read one flag in detail)',
      'flags:set (flip a flag)',
    ],
  },
  requirePrincipal: false,
  agentRoles: ['operator', 'architect', 'debugger', 'cup'],
  args: z.object({}),
  async handler() {
    const fakeReq = new Request('http://localhost/agent-tool');
    const payload = await getAllFlags(resolveDistinctId(fakeReq));
    return {
      data: { keys: ALL_FLAG_KEYS, ...payload },
    };
  },
});
