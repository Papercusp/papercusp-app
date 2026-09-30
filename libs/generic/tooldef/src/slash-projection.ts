/**
 * Slash exposure — project MCP-exposed tools onto the MCP **prompts**
 * primitive so agent clients (Claude Code, …) surface every tool the
 * session can call as a slash command.
 *
 * Plan: slash-exposure-tool-catalog-2026-06-12.
 *
 * This is a catalog projection, NOT a dispatch transport (plan D-001): a
 * rendered slash prompt instructs the agent to invoke the tool over the
 * session's existing MCP connection, so role gating, quota, audit, and
 * result formatting are inherited from the normal tools/call path. The
 * host transport (operator-core `_mcp-handler.ts`) decides WHICH tools are
 * visible per session (same role/profile walk as tools/list — parity by
 * construction); this module owns the per-tool projection mechanics:
 * naming, prompt-argument derivation, and the instruction render.
 *
 * Dynamic prompts live under the reserved `tool:` name namespace (plan
 * D-006); `prompt-registry.ts` rejects static prompts claiming it.
 */

import { tierFor } from './capability-tiers';
import type { ProjectedTool, ToolExposureSlash } from './tool-projection';
import type { PromptArgumentSchema, PromptResult } from './types';

/** Reserved name prefix for dynamic tool prompts (plan D-006). */
export const SLASH_PROMPT_PREFIX = 'tool:';

/** A prompts/list entry for one slash-exposed tool. */
export interface SlashPromptListing {
  name: string;
  description: string;
  arguments?: PromptArgumentSchema[];
}

/**
 * Normalize a tool's slash exposure. Returns the override object (possibly
 * empty) when the tool projects onto the slash surface, or null when it is
 * excluded — `expose.slash: false`, or no MCP exposure at all (an HTTP-only
 * tool has no agent-callable name for the rendered instruction to target).
 * Absent/`true` ⇒ ON with defaults (owner-ratified default-on, plan D-003).
 */
export function resolveSlashExposure(tool: ProjectedTool): ToolExposureSlash | null {
  if (!tool.expose.mcp) return null;
  const slash = tool.expose.slash;
  if (slash === false) return null;
  if (slash === undefined || slash === true) return {};
  return slash;
}

/** The dynamic prompt name for a tool: `tool:<override ?? mcp name>`. */
export function slashPromptNameFor(tool: ProjectedTool): string | null {
  const slash = resolveSlashExposure(tool);
  if (!slash) return null;
  const suffix = slash.name ?? tool.expose.mcp!.name;
  return `${SLASH_PROMPT_PREFIX}${suffix}`;
}

/** True when a prompt name addresses the dynamic tool-prompt namespace. */
export function isSlashPromptName(name: string): boolean {
  return name.startsWith(SLASH_PROMPT_PREFIX);
}

/** Strip the `tool:` prefix back to the (overridden or MCP) tool name. */
export function slashPromptToolName(promptName: string): string {
  return promptName.slice(SLASH_PROMPT_PREFIX.length);
}

interface JsonSchemaProperty {
  type?: string | string[];
  enum?: unknown[];
  description?: string;
  default?: unknown;
}

const SCALAR_TYPES = new Set(['string', 'number', 'integer', 'boolean']);

function isScalarProperty(prop: JsonSchemaProperty): boolean {
  if (Array.isArray(prop.enum) && prop.enum.length > 0) return true;
  const t = prop.type;
  if (typeof t === 'string') return SCALAR_TYPES.has(t);
  // Nullable scalars commonly serialize as ['string', 'null'].
  if (Array.isArray(t)) return t.some((x) => SCALAR_TYPES.has(x));
  return false;
}

/**
 * Derive MCP prompt arguments from a tool's input JSON Schema: every
 * top-level scalar (string/number/integer/boolean/enum) property, optionally
 * restricted to `restrict`. Non-scalar fields are deliberately omitted —
 * the rendered instruction has the agent elicit them (plan D-004).
 *
 * All arguments are advertised `required: false` ON THE WIRE, with
 * required-ness annotated in the description instead: a client that
 * enforces required prompt args client-side would otherwise block bare
 * `/command` invocation, which is exactly the elicitation flow we want to
 * keep available (implementation note on plan D-004).
 */
export function deriveSlashPromptArguments(
  inputSchema: Record<string, unknown>,
  restrict?: readonly string[],
): PromptArgumentSchema[] {
  const props = inputSchema?.properties as Record<string, JsonSchemaProperty> | undefined;
  if (!props || typeof props !== 'object') return [];
  const requiredSet = new Set(
    Array.isArray(inputSchema.required) ? (inputSchema.required as string[]) : [],
  );
  const out: PromptArgumentSchema[] = [];
  for (const [key, prop] of Object.entries(props)) {
    if (restrict && !restrict.includes(key)) continue;
    if (!prop || typeof prop !== 'object' || !isScalarProperty(prop)) continue;
    const bits: string[] = [];
    if (requiredSet.has(key)) bits.push('(required — the agent will ask if omitted)');
    if (typeof prop.description === 'string' && prop.description) bits.push(prop.description);
    if (Array.isArray(prop.enum) && prop.enum.length > 0 && prop.enum.length <= 12) {
      bits.push(`One of: ${prop.enum.map((v) => String(v)).join(', ')}.`);
    }
    out.push({
      name: key,
      ...(bits.length > 0 ? { description: bits.join(' ') } : {}),
      required: false,
    });
  }
  return out;
}

/**
 * Build the prompts/list entry for one slash-exposed tool, or null when the
 * tool is excluded. `advertisedInputSchema` lets the host pass the schema
 * the agent actually sees on tools/list (e.g. the positional-`row` swap for
 * registry write tools) so prompt args match what is callable; defaults to
 * the registered schema.
 */
export function slashPromptListingFor(
  tool: ProjectedTool,
  advertisedInputSchema?: Record<string, unknown>,
): SlashPromptListing | null {
  const slash = resolveSlashExposure(tool);
  if (!slash) return null;
  const description =
    slash.description ?? tool.guidance?.when ?? tool.description ?? tool.expose.mcp!.name;
  const args = deriveSlashPromptArguments(
    advertisedInputSchema ?? tool.inputSchema,
    slash.args,
  );
  return {
    name: `${SLASH_PROMPT_PREFIX}${slash.name ?? tool.expose.mcp!.name}`,
    description,
    ...(args.length > 0 ? { arguments: args } : {}),
  };
}

/**
 * Render the instruction message for a slash-invoked tool (plan D-004 +
 * D-007). Pure — no I/O, no ctx; the host wraps it in prompts/get.
 *
 * The message directs the agent to: coerce the string-typed slash args per
 * the schema, elicit any missing REQUIRED fields from the user before
 * invoking, confirm first for high-tier (and apparently-destructive)
 * invocations, then call the tool over this MCP session and summarize.
 */
export function renderSlashPrompt(
  tool: ProjectedTool,
  args: Record<string, string>,
  advertisedInputSchema?: Record<string, unknown>,
  opts?: {
    /**
     * Replace the supplied-arguments block verbatim — used by FILE emitters
     * whose client substitutes its own placeholder at invocation time (the
     * Codex `$ARGUMENTS` path, plan P-009). When set, `args` is ignored.
     */
    suppliedArgsText?: string;
  },
): PromptResult {
  const mcpName = tool.expose.mcp!.name;
  const schema = advertisedInputSchema ?? tool.inputSchema;
  const capability = tool.capabilities[0] ? String(tool.capabilities[0]) : undefined;
  const tier = capability ? tierFor(capability) : 'low';

  const supplied = Object.entries(args).filter(([, v]) => v !== undefined && v !== '');
  const suppliedBlock =
    opts?.suppliedArgsText ??
    (supplied.length > 0
      ? supplied.map(([k, v]) => `- ${k}: ${v}`).join('\n')
      : '(none)');

  const guidanceBits = [
    tool.guidance?.when ? `When to use: ${tool.guidance.when}` : null,
    tool.guidance?.notWhen ? `Not for: ${tool.guidance.notWhen}` : null,
  ].filter(Boolean);

  const confirmLine =
    tier === 'high'
      ? `3. This tool is HIGH-tier${capability ? ` (capability \`${capability}\`)` : ''}: before invoking, restate exactly what you are about to do and get the user's explicit confirmation.`
      : `3. If this invocation looks destructive or irreversible, restate what you are about to do and confirm with the user before invoking.`;

  const text = [
    `The user invoked the slash command for the \`${mcpName}\` tool on this MCP server.`,
    '',
    tool.description,
    ...(guidanceBits.length > 0 ? ['', ...guidanceBits] : []),
    '',
    'Tool input JSON Schema:',
    '```json',
    JSON.stringify(schema, null, 2),
    '```',
    '',
    'User-supplied arguments (all values arrive as strings — coerce per the schema):',
    suppliedBlock,
    '',
    'Instructions:',
    '1. Build the tool input from the supplied arguments plus the schema. Coerce types; leave optional fields unset rather than guessing.',
    '2. If any REQUIRED input field is still missing a value, ask the user for it first (one batch of questions via your question/elicitation affordance). Never invent a required value.',
    confirmLine,
    `4. Invoke \`${mcpName}\` over this MCP session, then summarize the result for the user in prose — do not paste raw payloads.`,
  ].join('\n');

  return {
    description: `Run the ${mcpName} tool.`,
    messages: [{ role: 'user', content: { type: 'text', text } }],
  };
}
