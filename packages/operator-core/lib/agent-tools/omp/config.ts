/**
 * omp:config — read or update the local `omp` CLI's config tree.
 *
 *   - { op: 'get' }                              → full settings tree
 *   - { op: 'catalog' }                          → OMP's enabled/configured models
 *   - { op: 'set', key, value }                  → set one knob
 *   - { op: 'unset', key }                       → unset one knob
 *
 * Writes invoke the `omp` CLI subprocess via the underlying lib.
 * Operator-only for writes; reads are any role (config introspection
 * is useful for any agent debugging behavior).
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { readOmpConfig, readOmpModelCatalog, setOmpConfig, unsetOmpConfig } from '../../omp-config';

export default defineTool({
  name: 'omp:config',
  profile: 'engineer',
  guidance: {
    when: 'Read or set an OMP CLI config key (model, paths, env tweaks). Used during installation / first-run flows.',
    notWhen: 'For OPERATOR runtime preferences (voice, scanner), use `operator:preferences`. omp:config is the CLI tool\'s config.',
    seeAlso: [
      'operator:preferences (OPERATOR runtime prefs, not the CLI)',
      'omp:sessions (OMP session history)',
    ],
  },
  description: 'Read the local OMP model catalog, or read/update the omp CLI config tree (catalog / get / set / unset).',
  capability: 'omp:write',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  rolesQuota: { operator: { perRun: 50 } },
  args: z.discriminatedUnion('op', [
    z.object({ op: z.literal('get') }),
    z.object({ op: z.literal('catalog') }),
    // `value` is a typed union (not z.unknown()) so the tool's JSON Schema is
    // valid for STRICT function-calling backends (OpenAI rejects an untyped
    // empty/anyOf-without-type schema: "anyOf must contain schemas with a
    // specified type"). omp config knobs are primitives (model id, path, flag).
    z.object({
      op: z.literal('set'),
      key: z.string().min(1),
      value: z.union([z.string(), z.number(), z.boolean()]),
    }),
    z.object({ op: z.literal('unset'), key: z.string().min(1) }),
  ]),
  async handler(args, ctx) {
    if (args.op === 'catalog') {
      try {
        const { models } = await readOmpModelCatalog();
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              ok: true,
              availability: {
                kind: 'enabled-configured',
                credentials: 'unchecked',
                upstream: 'unchecked',
              },
              models,
            }),
          }],
        };
      } catch (error) {
        throw new Error(`omp:config catalog failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (args.op === 'get') {
      const sections = await readOmpConfig();
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, sections }) }] };
    }
    if (ctx.role !== 'operator') {
      throw new Error(`omp:config ${args.op} requires operator role`);
    }
    if (args.op === 'set') {
      const result = await setOmpConfig(args.key, args.value);
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, raw: result.raw }) }] };
    }
    await unsetOmpConfig(args.key);
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, unset: true, key: args.key }) }] };
  },
});
