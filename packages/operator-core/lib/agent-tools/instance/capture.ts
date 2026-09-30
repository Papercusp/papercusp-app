/**
 * instance:capture — produce an `InstanceSpec` from a live harness
 * (`retire-snapshots-instance-spec-2026-06-09` P-002).
 *
 * The lightweight, agent-facing reproducible-clone surface that replaces the
 * retired `snapshots:*` tools: a spec is `(blueprintRef, repoSha, deploymentConfig,
 * genome)` — boot it with `instance:boot`, or clone in one call with `instance:clone`.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { captureInstanceSpec } from '../../instance-spec';

export default defineTool({
  name: 'instance:capture',
  profile: 'engineer',
  guidance: {
    when: 'Capture a reproducible descriptor of a live harness/instance — its blueprint + git SHA + deployment + genome — to boot or vary an identical one. The replacement for the retired snapshot clone path.',
    notWhen: 'For a full state backup (code+data), git + PG already cover it. To create a fresh harness from scratch, use `harness:create`.',
    chaining: 'instance:capture → instance:boot (identical) or instance:clone (with a genome delta).',
    seeAlso: [
      'instance:boot (boot an identical harness from the spec)',
      'instance:clone (capture + vary + boot in one call)',
    ],
  },
  description: 'Capture an InstanceSpec (blueprintRef + repoSha + deploymentConfig + genome) from a live harness, for reproducible boot/vary.',
  capability: 'harness:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    slug: z.string().min(1).describe('The harness slug to capture.'),
    workspace: z.string().min(1).optional().describe('Workspace id (defaults to the active workspace).'),
  }),
  async handler(args) {
    try {
      const spec = await captureInstanceSpec(args.slug, args.workspace ? { workspaceId: args.workspace } : {});
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, spec }) }] };
    } catch (e) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }) }],
        isError: true,
      };
    }
  },
});
