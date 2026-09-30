/**
 * blueprint:create — author a NEW standalone blueprint. The agent supplies the
 * blueprint object; the tool resolves + validates it and returns the canonical
 * YAML (ready to write to `.papercusp/blueprint.yaml`). Pure: it does NOT write
 * files or create a harness (that's harness:create / the agent).
 *
 * harness-blueprint-orchestration-2026-06-03 P-007 / B1 / D-008 (tool-authored
 * canonical YAML, Zod-validated on the way out).
 */
import { z } from 'zod';
import { stringify as stringifyYaml } from 'yaml';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { resolveAndValidate } from './_resolve';

export default defineTool({
  name: 'blueprint:create',
  description:
    'Author a NEW Harness Blueprint from a blueprint object. Validates it (schema + semantics) and returns {ok, errors, warnings, yaml} — the canonical YAML to persist at .papercusp/blueprint.yaml. Does not write files or create a harness. For a blueprint that inherits, use blueprint:extend.',
  guidance: {
    when: 'Authoring a brand-new blueprint shape from scratch (rare — usually you extend `coding`/`base`/`research`). Returns validated canonical YAML.',
    notWhen: 'Inheriting from an existing blueprint — use blueprint:extend (cheaper, less to author). Creating the harness itself — harness:create.',
    chaining: 'blueprint:create → (inspect yaml) → harness:create { blueprint } or write .papercusp/blueprint.yaml.',
    seeAlso: [
      'blueprint:validate (validate before creating a harness)',
      'blueprint:extend (extend an existing blueprint instead of authoring)',
      'harness:create (create a harness from it)',
    ],
  },
  capability: 'harness:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    blueprint: z.record(z.string(), z.unknown()).describe('The full blueprint object (id, workItem, spine, roles, …)'),
  }),
  async handler(args) {
    const r = resolveAndValidate(args.blueprint);
    if (r.parseError) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, parseError: r.parseError }) }] };
    }
    // Emit the AUTHORED object as canonical YAML (not the merged form — the file
    // is the source, extends-resolution happens at load time).
    const yaml = stringifyYaml(args.blueprint, { lineWidth: 100 });
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ ok: r.ok, errors: r.validation!.errors, warnings: r.validation!.warnings, yaml }),
        },
      ],
    };
  },
});
