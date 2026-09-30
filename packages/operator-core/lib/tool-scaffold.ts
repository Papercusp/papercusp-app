/**
 * tool-scaffold — PURE codegen for a reviewable `defineTool` skeleton
 * (reflexive-platform-extensibility-datatypes-2026-06-24 P-004, design D-003/D-004).
 *
 * The reflexive platform lets agents create NEW TOOLS, but D-003 is emphatic: runtime
 * tool creation is first-class, and SAFETY = confinement + REVIEW, not prohibition. The
 * dangerous tiers (sandboxed-imperative, elevated) do NOT register at runtime — they ride
 * the dogfood PR rail (`tools:scaffold` → review → `platform:contribute`). This module is
 * that rail's first step: it emits the SKELETON SOURCE for a new tool — a `defineTool`
 * file, the side-effect import line for `agent-tools/index.ts`, and (first-class) a
 * migration stub — and returns it as TEXT. It writes NOTHING, executes NOTHING, and mints
 * NO capability; the generated handler is a `not_implemented` stub a human implements and
 * reviews before enabling. That is what makes scaffolding safe to run unattended.
 *
 * Pure: no I/O, no zod at runtime — deterministic string templating, exhaustively
 * unit-testable. The `tools:scaffold` defineTool (agent-tools/tools/scaffold.ts) validates
 * input + wraps this.
 */

/** The capability tiers a created tool can occupy (D-003). */
export const TOOL_TIERS = ['composed', 'sandboxed-imperative', 'elevated'] as const;
export type ToolTier = (typeof TOOL_TIERS)[number];
export function isToolTier(t: string): t is ToolTier {
  return (TOOL_TIERS as readonly string[]).includes(t);
}

/** A single scaffolded arg → one zod field on the tool's `args` object. */
export interface ToolArgSpec {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'string[]';
  required?: boolean;
  description?: string;
}

export interface ToolScaffoldSpec {
  /** agent-tools group dir (kebab), e.g. `oddsmith`. */
  group: string;
  /** file/verb name (kebab), e.g. `score-bet`. */
  verb: string;
  /** the tool's registered name, e.g. `oddsmith:score-bet`. */
  name: string;
  description: string;
  /** D-003 tier — decides the review rail + the handler-stub guidance. */
  tier: ToolTier;
  /** capability string the tool requires, e.g. `intel:write`. */
  capability: string;
  args?: ToolArgSpec[];
  /** emit a first-class SQL migration stub alongside the tool (a table-backed tool). */
  firstClass?: boolean;
  /** table name for the migration stub (defaults to `${group}_${verb}` underscored). */
  migrationTable?: string;
  /** suggested next migration number (the wrapper may read it off disk); placeholder when absent. */
  suggestedMigrationNumber?: number;
}

export interface ScaffoldFile {
  path: string;
  action: 'create' | 'append';
  contents: string;
}

export interface ScaffoldResult {
  ok: true;
  files: ScaffoldFile[];
  /** `mergeable` (composed: mints no cap) | `review-gated` (sandboxed/elevated: D-003 adversarial proof). */
  rail: 'mergeable' | 'review-gated';
  reviewNotes: string[];
  /** post-scaffold steps the human must run (import wiring, catalog regen, migration reservation). */
  nextSteps: string[];
}

export interface ScaffoldError {
  ok: false;
  reason: 'invalid_spec';
  message: string;
}

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function zodForArg(a: ToolArgSpec): string {
  const base =
    a.type === 'string'
      ? 'z.string()'
      : a.type === 'number'
        ? 'z.number()'
        : a.type === 'boolean'
          ? 'z.boolean()'
          : 'z.array(z.string())';
  const opt = a.required ? '' : '.optional()';
  const desc = a.description ? `.describe(${JSON.stringify(a.description)})` : '';
  return `${base}${opt}${desc}`;
}

function renderArgsObject(args: ToolArgSpec[]): string {
  if (args.length === 0) return 'z.object({})';
  const lines = args.map((a) => `    ${a.name}: ${zodForArg(a)},`);
  return `z.object({\n${lines.join('\n')}\n  })`;
}

/** Whether the tool's handler needs a PG handle (first-class table-backed tools do). */
function needsPg(spec: ToolScaffoldSpec): boolean {
  return Boolean(spec.firstClass);
}

function toolFileContents(spec: ToolScaffoldSpec): string {
  const reviewBanner =
    spec.tier === 'composed'
      ? ' * TIER: composed — a DAG/recipe over EXISTING primitives; mints no new capability.\n' +
        ' * Safe to merge after a normal review. Implement the handler, then enable.'
      : ` * TIER: ${spec.tier} — RUNTIME-DANGEROUS (D-003). Do NOT enable at runtime.\n` +
        ' * This skeleton MUST be adversarially proven (fs escape, denied-host network, cap\n' +
        ' * escalation, cap minting all BLOCKED) and review-gated before its capability is\n' +
        ' * granted. Ship via the dogfood PR rail (platform:contribute), never runtime.';

  const imports = [
    "import { z } from 'zod';",
    "import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';",
    ...(needsPg(spec) ? ["import { getOrgPg } from '@papercusp/db-org';"] : []),
  ].join('\n');

  const pgLine = needsPg(spec) ? '\n    const sql = getOrgPg().sql;' : '';
  const argsObject = renderArgsObject(spec.args ?? []);

  return `/**
 * ${spec.name} — ${spec.description}
 *
${reviewBanner}
 *
 * SCAFFOLD (P-004 tools:scaffold). Generated skeleton — the handler is a not_implemented
 * stub. Implement it, run \`npm run gen:tool-catalog\`, and add the side-effect import to
 * agent-tools/index.ts. Server-only.
 */
${imports}

export default defineTool({
  name: ${JSON.stringify(spec.name)},
  description: ${JSON.stringify(spec.description)},
  guidance: {
    when: 'TODO: when an agent should reach for this tool.',
    notWhen: 'TODO: the near-miss tools this is NOT.',
    chaining: 'TODO: the typical call before/after.',
  },
  capability: ${JSON.stringify(spec.capability)},
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  args: ${argsObject},
  async handler(args, ctx) {${pgLine}
    // SCAFFOLD STUB — implement, then remove this guard. Review the tier rail before enabling.
    void args;
    void ctx;
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: false,
            reason: 'not_implemented',
            message: ${JSON.stringify(`${spec.name} is a scaffold; implement its handler before enabling.`)},
          }),
        },
      ],
    };
  },
});
`;
}

function migrationStub(spec: ToolScaffoldSpec): ScaffoldFile {
  const table = spec.migrationTable ?? `${spec.group}_${spec.verb}`.replace(/-/g, '_');
  const num =
    typeof spec.suggestedMigrationNumber === 'number' && Number.isFinite(spec.suggestedMigrationNumber)
      ? String(Math.floor(spec.suggestedMigrationNumber)).padStart(3, '0')
      : 'NNN';
  const contents = `-- ${num}-${table}.sql — first-class backing table for ${spec.name} (P-004 scaffold).
-- RESERVE the real migration number via \`db:next-migration\` before merging (NNN is a
-- placeholder; concurrent agents reserve numbers). Idempotent + additive so it is
-- fresh-migrate-safe and cannot wedge operator boot. Mirror the grants/RLS idiom of an
-- existing workspace-scoped table (e.g. 349-code-recipes.sql / 421-datatype-registry.sql).
CREATE TABLE IF NOT EXISTS harness_shared.${table} (
  id           TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  -- TODO: domain columns
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id)
);
-- TODO: GRANTs + ENABLE ROW LEVEL SECURITY + workspace isolation policy (copy 421's tail).
`;
  return { path: `libs/papercusp/libs/db/sql/${num}-${table}.sql`, action: 'create', contents };
}

/**
 * Generate the reviewable skeleton for a new tool. Returns the file artifacts as TEXT —
 * the caller (or a human) lands them through review; nothing is written or registered here.
 */
export function scaffoldTool(spec: ToolScaffoldSpec): ScaffoldResult | ScaffoldError {
  const fail = (message: string): ScaffoldError => ({ ok: false, reason: 'invalid_spec', message });
  if (!KEBAB.test(spec.group)) return fail(`group must be kebab-case (got ${JSON.stringify(spec.group)})`);
  if (!KEBAB.test(spec.verb)) return fail(`verb must be kebab-case (got ${JSON.stringify(spec.verb)})`);
  if (!spec.name.trim()) return fail('name is required');
  if (!spec.description.trim()) return fail('description is required');
  if (!isToolTier(spec.tier)) return fail(`tier must be one of ${TOOL_TIERS.join(' | ')}`);
  if (!spec.capability.trim()) return fail('capability is required');
  for (const a of spec.args ?? []) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(a.name)) return fail(`arg name ${JSON.stringify(a.name)} is not a valid identifier`);
  }

  const toolPath = `packages/operator-core/lib/agent-tools/${spec.group}/${spec.verb}.ts`;
  const files: ScaffoldFile[] = [{ path: toolPath, action: 'create', contents: toolFileContents(spec) }];
  if (spec.firstClass) files.push(migrationStub(spec));

  const importLine = `import './${spec.group}/${spec.verb}';`;
  const reviewGated = spec.tier !== 'composed';
  const reviewNotes = reviewGated
    ? [
        `D-003: tier "${spec.tier}" is runtime-dangerous. The capability ${JSON.stringify(
          spec.capability,
        )} must NOT be granted until the handler is adversarially proven: fs escape, denied-host network, capability escalation, and capability minting all BLOCKED.`,
        'Land via the dogfood PR rail (review → platform:contribute), never by enabling at runtime.',
      ]
    : [
        `Tier "composed" mints no new capability (a DAG/recipe over existing primitives). Safe to merge after a normal review once the handler is implemented.`,
      ];

  const nextSteps = [
    `Create ${toolPath} with the generated contents and implement the handler.`,
    `Add the side-effect import to packages/operator-core/lib/agent-tools/index.ts:  ${importLine}`,
    'Run `npm run gen:tool-catalog` to register it in .papercusp/tool-catalog.json.',
    ...(spec.firstClass
      ? ['Reserve the migration number via `db:next-migration`, then verify it applies against the embedded PG before merging.']
      : []),
    ...(reviewGated ? ['Open a PR for review — do NOT enable this tier at runtime (D-003).'] : []),
  ];

  return { ok: true, files, rail: reviewGated ? 'review-gated' : 'mergeable', reviewNotes, nextSteps };
}
