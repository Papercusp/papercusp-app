/**
 * operator:preferences — list, append, or remove operator preference
 * entries. Mirrors GET/POST/DELETE /api/agent-mcp/operator-preferences.
 *
 * Writes affect operator scanner behavior (provenance tags drive the
 * substrate prompt + parser); restricted to operator + architect.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES, isOperatorConfigWriteRole } from '@papercusp/agent-mcp';
import {
  appendPreferenceEntry,
  listPreferenceEntries,
  removePreferenceEntry,
} from '../../operator-preferences';

export default defineTool({
  name: 'operator:preferences',
  profile: 'engineer',
  description: 'List / append / remove operator preference entries (provenance-tagged markdown).',
  capability: 'operator:write',
  guidance: {
    when: `Read or update operator-level preferences (scan cadence, autoAccept tier, persona name, etc.).`,
    notWhen: `For VOICE prefs specifically, use \`operator:voice_prefs\`. For workspace-level config, use \`multi_workspace\`/\`papercusp:list_workspaces\`.`,
    seeAlso: [
      'operator:voice_prefs (voice-specific preferences)',
      'operator:multi_workspace (workspace-level switching)',
    ],
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  rolesQuota: { architect: { perRun: 30 }, operator: { perRun: 100 } },
  args: z.discriminatedUnion('op', [
    z.object({ op: z.literal('list') }),
    z.object({ op: z.literal('append'), entry: z.string().min(1) }),
    z.object({ op: z.literal('remove'), key: z.string().min(1) }),
  ]),
  async handler(args, ctx) {
    if (args.op === 'list') {
      const entries = await listPreferenceEntries();
      return { content: [{ type: 'text', text: JSON.stringify({ entries }) }] };
    }
    if (!isOperatorConfigWriteRole(ctx.role)) {
      throw new Error(`operator:preferences ${args.op} requires operator, architect, or mug role`);
    }
    if (args.op === 'append') {
      await appendPreferenceEntry(args.entry);
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] };
    }
    const removed = await removePreferenceEntry(args.key);
    return { content: [{ type: 'text', text: JSON.stringify({ ok: removed, key: args.key }) }] };
  },
});
