/**
 * instance:boot — instantiate an identical instance from an `InstanceSpec`
 * (`retire-snapshots-instance-spec-2026-06-09` P-003).
 *
 * Reuses `harness:create` under the hood (deploy = boot(spec)); pass a spec from
 * `instance:capture`.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { bootInstanceSpec, type InstanceSpec } from '../../instance-spec';
import { InstanceSpecArgSchema } from './_spec-schema';

export default defineTool({
  name: 'instance:boot',
  profile: 'engineer',
  guidance: {
    when: 'Instantiate a NEW harness identical to a captured InstanceSpec (same blueprint + SHA + deployment + genome).',
    notWhen: 'To create a fresh harness from scratch, use `harness:create`. To clone-and-vary in one call, use `instance:clone`.',
    chaining: 'instance:capture → instance:boot.',
    seeAlso: [
      'instance:capture (capture the spec to boot from)',
      'instance:clone (clone-and-vary in one call)',
      'harness:create (a fresh harness from scratch)',
    ],
  },
  description: 'Boot a new harness from an InstanceSpec, reproducing the captured instance. Reuses harness:create.',
  capability: 'harness:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      spec: InstanceSpecArgSchema.describe('The InstanceSpec to boot (from instance:capture).'),
      slug: z.string().min(1).regex(/^[a-z0-9][a-z0-9-]*$/, 'slug must be lowercase alphanumeric + dashes').describe('The new harness slug.'),
      path: z.string().min(1).optional().describe('An existing dir to instantiate into.'),
      parentDir: z.string().min(1).optional().describe('Parent dir to create a new harness folder in.'),
      folderName: z.string().min(1).optional().describe('New folder name (with parentDir).'),
      autoInstallDeps: z.boolean().optional(),
    })
    .refine((a) => a.path != null || (a.parentDir != null && a.folderName != null), {
      message: 'pass `path`, or both `parentDir` and `folderName`',
    }),
  async handler(args) {
    const result = await bootInstanceSpec(args.spec as unknown as InstanceSpec, {
      slug: args.slug,
      ...(args.path != null ? { path: args.path } : { parentDir: args.parentDir, folderName: args.folderName }),
      ...(args.autoInstallDeps != null ? { autoInstallDeps: args.autoInstallDeps } : {}),
    });
    return { content: [{ type: 'text', text: JSON.stringify(result) }], ...(result.ok ? {} : { isError: true }) };
  },
});
