/**
 * instance:clone — capture a live harness → (optionally vary its genome) → boot an
 * identical / same-origin clone, in one call (`retire-snapshots-instance-spec-2026-06-09`
 * P-002+P-003+P-004). The ergonomic, one-shot replacement for the retired snapshot fork.
 *
 *   no `genomeDelta` ⇒ an IDENTICAL clone (capture→boot round-trip).
 *   a `genomeDelta`  ⇒ a fair SAME-ORIGIN clone (same blueprint + SHA + deployment,
 *                      differing only by the genome — the eval-battery's Δ-selection).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { bootInstanceSpec, captureInstanceSpec, varyInstanceSpec, type GenomeDelta } from '../../instance-spec';
import { GenomeDeltaArgSchema } from './_spec-schema';

export default defineTool({
  name: 'instance:clone',
  profile: 'engineer',
  guidance: {
    when: 'Clone a live harness into a new identical one, or a same-origin variant (pass a genomeDelta). The reproducible-clone replacement for the retired snapshot fork.',
    notWhen: 'For a fresh harness from scratch, use `harness:create`. To capture a spec without booting, use `instance:capture`.',
    chaining: 'instance:clone = instance:capture → (vary) → instance:boot in one call.',
    seeAlso: [
      'instance:capture (capture a spec without booting)',
      'instance:boot (boot an identical one)',
      'harness:create (a fresh harness from scratch)',
    ],
  },
  description: 'Capture a harness → optionally apply a genome delta → boot an identical / same-origin clone.',
  capability: 'harness:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      fromSlug: z.string().min(1).describe('The source harness to clone.'),
      slug: z.string().min(1).regex(/^[a-z0-9][a-z0-9-]*$/, 'slug must be lowercase alphanumeric + dashes').describe('The new harness slug.'),
      path: z.string().min(1).optional().describe('An existing dir to instantiate into.'),
      parentDir: z.string().min(1).optional().describe('Parent dir to create a new harness folder in.'),
      folderName: z.string().min(1).optional().describe('New folder name (with parentDir).'),
      genomeDelta: GenomeDeltaArgSchema.optional().describe('Optional genome delta → a same-origin variant clone instead of an identical one.'),
      workspace: z.string().min(1).optional(),
      autoInstallDeps: z.boolean().optional(),
    })
    .refine((a) => a.path != null || (a.parentDir != null && a.folderName != null), {
      message: 'pass `path`, or both `parentDir` and `folderName`',
    }),
  async handler(args) {
    try {
      const base = await captureInstanceSpec(args.fromSlug, args.workspace ? { workspaceId: args.workspace } : {});
      const spec = args.genomeDelta ? varyInstanceSpec(base, args.genomeDelta as GenomeDelta) : base;
      const result = await bootInstanceSpec(spec, {
        slug: args.slug,
        ...(args.path != null ? { path: args.path } : { parentDir: args.parentDir, folderName: args.folderName }),
        ...(args.autoInstallDeps != null ? { autoInstallDeps: args.autoInstallDeps } : {}),
      });
      return {
        content: [{ type: 'text', text: JSON.stringify({ ...result, varied: args.genomeDelta != null }) }],
        ...(result.ok ? {} : { isError: true }),
      };
    } catch (e) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }) }],
        isError: true,
      };
    }
  },
});
