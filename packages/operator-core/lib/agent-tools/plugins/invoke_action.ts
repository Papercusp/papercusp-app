/**
 * plugins:invoke_action — invoke a plugin action via the in-process
 * registry. Diagnostic-shaped: same code path as the in-process
 * dispatcher used by hooks, NOT the marketplace-CLI shell-out.
 *
 * Mirrors POST /api/plugins/runtime/invoke-action. Architect+operator
 * only — invoking arbitrary plugin actions is a real side effect.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { invokePluginAction } from '../../plugin-host-runtime';
import { loadHarnessRegistry } from '../../harness-registry';

export default defineTool({
  name: 'plugins:invoke_action',
  profile: 'engineer',
  guidance: {
    when: 'Invoke a named action a plugin exposes (publish, sync, etc.). Use the action name from `plugins:runtime_status`.',
    notWhen: 'For TOOLS the plugin exposes (callable as MCP names), call them directly via their mcp__ prefix. Actions are plugin-lifecycle verbs; tools are the catalog.',
    seeAlso: [
      'plugins:runtime_status (find the action name + health)',
      'plugins:fire_event (fire a hook event instead of an action)',
    ],
  },
  description: 'Invoke a plugin action via the in-process registry. Diagnostic — architect/operator only.',
  capability: 'plugins:write',
  requirePrincipal: false,
  agentRoles: ['architect', 'operator'],
  rolesQuota: { architect: { perRun: 20 }, operator: { perRun: 50 } },
  args: z.object({
    plugin: z.string().min(1),
    action: z.string().min(1),
    slug: z.string().min(1),
    params: z.record(z.string(), z.unknown()).optional(),
  }),
  async handler(args) {
    const project = (await loadHarnessRegistry()).projects.find((p) => p.slug === args.slug) ?? null;
    const projectDir = project?.path ?? '/tmp';
    const stateDir = project ? `${project.path}/.papercusp` : '/tmp';
    const result = await invokePluginAction({
      pluginName: args.plugin,
      actionName: args.action,
      installSlug: args.slug,
      projectDir,
      stateDir,
      params: args.params,
      triggerSource: 'api',
      triggerId: `mcp-${Date.now()}`,
    });
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  },
});
