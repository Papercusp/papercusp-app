/**
 * tools:scaffold — generate a reviewable `defineTool` skeleton for a NEW tool
 * (reflexive-platform-extensibility-datatypes-2026-06-24 P-004, design D-003/D-004).
 *
 * The SAFE first step of runtime tool-creation: emit the SKELETON SOURCE (a defineTool
 * file, the index.ts import line, and — first-class — a migration stub) and hand it back
 * as TEXT for review. It writes NOTHING, executes NOTHING, and grants NO capability; the
 * generated handler is a `not_implemented` stub. The dangerous tiers (sandboxed-imperative,
 * elevated) are flagged `review-gated` (D-003): adversarially prove confinement, then land
 * via the dogfood PR rail (platform:contribute) — never enable at runtime.
 *
 * Server-only. The codegen itself is the pure `tool-scaffold` module.
 */
import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { scaffoldTool, TOOL_TIERS, type ToolScaffoldSpec } from '../../tool-scaffold';

export default defineTool({
  name: 'tools:scaffold',
  description:
    'Generate a REVIEWABLE skeleton for a new MCP tool — a defineTool file (+ index import line, + a ' +
    'migration stub for first-class table-backed tools) returned as TEXT. Writes nothing, runs nothing, ' +
    'mints no capability: the handler is a not_implemented stub. composed tier → mergeable after review; ' +
    'sandboxed-imperative/elevated → review-gated (D-003: prove confinement, then platform:contribute).',
  guidance: {
    when:
      'When a domain needs a NEW tool (not just a datatype). Scaffold the skeleton here, implement the handler, ' +
      'and land it through review. This is how the elevated/sandboxed tiers reach the codebase (D-003 PR rail).',
    notWhen:
      'To define a DATATYPE (meta:define-datatype). To run an existing composition (recipes:run). This does NOT ' +
      'register or execute a tool — it only emits source for review.',
    chaining:
      'tools:scaffold { group, verb, name, tier } → implement the handler → add the import to agent-tools/index.ts ' +
      '→ npm run gen:tool-catalog → (review-gated tiers) PR + platform:contribute.',
    seeAlso: [
      'meta:define-tool (define + register with tier routing)',
      'tools:find (check for an existing tool first)',
    ],
  },
  capability: 'intel:write',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  args: z.object({
    group: z.string().min(1).max(60).describe('agent-tools group dir, kebab-case (e.g. "oddsmith")'),
    verb: z.string().min(1).max(60).describe('file/verb name, kebab-case (e.g. "score-bet")'),
    name: z.string().min(1).max(120).describe('the registered tool name (e.g. "oddsmith:score-bet")'),
    description: z.string().min(1).max(2000).describe('one-line description (becomes the tool description + file header)'),
    tier: z
      .enum([...TOOL_TIERS] as [string, ...string[]])
      .describe('D-003 tier: composed (DAG over existing primitives, mints no cap) | sandboxed-imperative | elevated (both review-gated)'),
    capability: z.string().min(1).max(120).describe('the capability the tool will require (e.g. "intel:write")'),
    toolArgs: z
      .array(
        z.object({
          name: z.string().min(1).max(60).describe('arg identifier'),
          type: z.enum(['string', 'number', 'boolean', 'string[]']),
          required: z.boolean().optional(),
          description: z.string().max(400).optional(),
        }),
      )
      .max(32)
      .optional()
      .describe('the scaffolded tool\'s args → a zod object on the skeleton'),
    firstClass: z.boolean().optional().describe('also emit a first-class SQL migration stub (a table-backed tool)'),
    migrationTable: z.string().min(1).max(80).optional().describe('table name for the migration stub (defaults to group_verb)'),
  }),
  async handler(args) {
    const reply = (obj: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(obj) }] });
    const spec: ToolScaffoldSpec = {
      group: args.group,
      verb: args.verb,
      name: args.name,
      description: args.description,
      tier: args.tier as ToolScaffoldSpec['tier'],
      capability: args.capability,
      args: args.toolArgs,
      firstClass: args.firstClass,
      migrationTable: args.migrationTable,
    };
    const result = scaffoldTool(spec);
    if (!result.ok) {
      return reply({ ok: false, reason: result.reason, message: result.message });
    }
    return reply({
      ok: true,
      rail: result.rail,
      files: result.files,
      reviewNotes: result.reviewNotes,
      nextSteps: result.nextSteps,
      note:
        result.rail === 'review-gated'
          ? 'Skeleton generated. This tier is RUNTIME-DANGEROUS (D-003) — do not enable at runtime; land via review + platform:contribute.'
          : 'Skeleton generated (composed tier — mints no capability). Implement the handler, then merge after review.',
    });
  },
});
