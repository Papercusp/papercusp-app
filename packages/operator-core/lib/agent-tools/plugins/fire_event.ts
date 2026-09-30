/**
 * plugins:fire_event — fire a synthetic event into the reaction registry OR
 * a typed lifecycle hook through the in-process host runtime. Diagnostic-
 * shaped, useful for smoke-testing handler/rule wiring.
 *
 * Mirrors POST /api/plugins/runtime/fire-event. Discriminated by
 * `mode`:
 *   - { mode: 'event',     event,     payload? }  → reaction rules on that key
 *   - { mode: 'lifecycle', lifecycle, slug, args? } → typed PluginHooks fire
 *
 * (The `event` mode used to fire the retired HookBus; it now feeds the
 * event-reaction matcher — plugin-system-hive-port P-006/D-003.)
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { firePluginLifecycle } from '../../plugin-host-runtime';
import { emitSystemEvent } from '../../events/engine';
import { loadHarnessRegistry } from '../../harness-registry';

export default defineTool({
  name: 'plugins:fire_event',
  profile: 'engineer',
  guidance: {
    when: 'Synthetically fire a hook event so the registered plugin / role pipelines run their handlers. Useful for replaying / testing event-driven flows.',
    notWhen: 'For NORMAL flow, events fire from real actions (commit, plan-approved, etc.); only use this when you need to manually trigger them. For listing PENDING events, use `pending_events:list`.',
    seeAlso: [
      'plugins:runtime_status (which plugins are loaded / healthy)',
      'pending_events:list (pending hook events)',
      'plugins:invoke_action (invoke a plugin action directly)',
    ],
  },
  description: 'Fire a free-form plugin event or typed lifecycle hook via the in-process host. Diagnostic — architect/operator only.',
  capability: 'plugins:write',
  requirePrincipal: false,
  agentRoles: ['architect', 'operator'],
  rolesQuota: { architect: { perRun: 30 }, operator: { perRun: 100 } },
  args: z.discriminatedUnion('mode', [
    z.object({
      mode: z.literal('event'),
      event: z.string().min(1),
      payload: z.unknown().optional(),
    }),
    z.object({
      mode: z.literal('lifecycle'),
      lifecycle: z.string().min(1),
      slug: z.string().min(1),
      args: z.array(z.unknown()).optional(),
    }),
  ]),
  async handler(args) {
    if (args.mode === 'event') {
      const payload = args.payload;
      emitSystemEvent({
        tool: args.event,
        args: (payload && typeof payload === 'object' ? payload : payload === undefined ? {} : { value: payload }) as Record<string, unknown>,
      });
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, fired: args.event }) }] };
    }
    const project = (await loadHarnessRegistry()).projects.find((p) => p.slug === args.slug) ?? null;
    const ctxArgs = {
      installSlug: args.slug,
      projectDir: project?.path ?? '/tmp',
      stateDir: project ? `${project.path}/.papercusp` : '/tmp',
    };
    const lifecycleArgs = args.args ?? [];
    // Same dynamic-name dispatch the legacy route uses; firePluginLifecycle's
    // type expects a known PluginHooks key but the diagnostic surface accepts
    // any string the host registered.
    await (firePluginLifecycle as unknown as (
      name: string,
      ctx: typeof ctxArgs,
      ...rest: unknown[]
    ) => Promise<void>)(args.lifecycle, ctxArgs, ...lifecycleArgs);
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, fired: args.lifecycle, slug: args.slug }) }] };
  },
});
