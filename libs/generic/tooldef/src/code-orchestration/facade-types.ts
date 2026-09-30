/**
 * code-execution-tool-orchestration B-CX-API — typed signatures for the code-mode facade.
 *
 * The COMPILE-TIME companion to `tool-facade.ts` (the RUNTIME). It renders the TypeScript
 * surface the model writes against:
 *
 *     declare const tools: {
 *       workItems: {
 *         // List work-items across kinds …
 *         list(args?: { harness?: string; kind?: "feature" | "bug"; limit?: number }): Promise<unknown>;
 *       };
 *       call(toolName: string, args?: unknown): Promise<unknown>;
 *     };
 *
 * Each signature is derived from a tool's projected `inputSchema` — which is ALREADY a JSON
 * Schema object (the projection ran the schema→JSON-Schema adapter, `toJsonSchema`, at
 * `defineTool` time; see schema-adapter.ts + define-tool.ts). So this module never touches a
 * validator library: it walks JSON-Schema objects and emits strings. That keeps it dependency-
 * free and host-agnostic, exactly like the rest of `@papercusp/tooldef`.
 *
 * WHY: the model can already name tools from the normal catalog, but explicit typed signatures
 * (a) cut `code:run` script errors (it sees the real arg shapes, not a guess) and (b) enable the
 * Anthropic "on-demand tool discovery" token win — the `code:tools` lookup serves signatures for
 * only the namespaces a task needs, instead of dumping every tool def into every prompt.
 *
 * Namespace + verb naming are shared with the runtime via `camelNamespace` / `camelVerb`
 * (tool-facade.ts) so the generated `tools.<ns>.<verb>` names ALWAYS match what the runtime
 * facade actually exposes.
 *
 * Scoping mirrors the runtime: pass the agent's `allowed` set and tools outside it are omitted —
 * the model never sees a signature for a tool it cannot call.
 */
import type { ProjectedTool } from '../tool-projection';
import { camelNamespace, camelVerb, splitToolName } from './tool-facade';

/** A JSON Schema node (we only read well-known keywords; everything else degrades to `unknown`). */
type JsonSchema = Record<string, unknown>;

/** Default nesting depth before a deep/recursive schema collapses to `Record<string, unknown>`. */
const DEFAULT_MAX_DEPTH = 8;

/** Truncation cap for the per-signature description comment (token economy). */
const DESC_MAX = 120;

const isObj = (v: unknown): v is JsonSchema => typeof v === 'object' && v !== null && !Array.isArray(v);
const isValidIdent = (k: string): boolean => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k);

/** Quote an object-literal key only when it is not already a valid JS identifier. */
function renderKey(key: string): string {
  return isValidIdent(key) ? key : JSON.stringify(key);
}

/** A JSON enum/const value → its TS literal form. */
function literal(v: unknown): string {
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number' || typeof v === 'boolean' || v === null) return String(v);
  return 'unknown';
}

/** De-duplicate union/intersection members, preserving order. */
function uniq(parts: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of parts) {
    if (!seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  }
  return out;
}

type NumericSchemaBound = { value: number; exclusive: boolean };

/**
 * Render the caller-facing numeric contract that TypeScript cannot express as a
 * normal primitive type. The comment keeps generated signatures assignable as
 * `number` while making integer-ness and validator bounds visible to the model.
 * This intentionally mirrors the compact discovery form (`integer(5-200)`).
 */
function numericConstraintNote(schema: JsonSchema, t: string): string {
  if (t !== 'number' && t !== 'integer') return '';

  const numberValue = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  const findBound = (
    inclusiveKey: 'minimum' | 'maximum',
    exclusiveKey: 'exclusiveMinimum' | 'exclusiveMaximum',
  ): NumericSchemaBound | undefined => {
    const exclusiveValue = numberValue(schema[exclusiveKey]);
    if (exclusiveValue !== undefined) return { value: exclusiveValue, exclusive: true };

    const inclusiveValue = numberValue(schema[inclusiveKey]);
    if (inclusiveValue !== undefined) {
      return { value: inclusiveValue, exclusive: schema[exclusiveKey] === true };
    }
    return undefined;
  };

  const lower = findBound('minimum', 'exclusiveMinimum');
  const upper = findBound('maximum', 'exclusiveMaximum');
  const range = lower && upper
    ? `${lower.exclusive ? '>' : ''}${lower.value}-${upper.exclusive ? '<' : ''}${upper.value}`
    : upper
      ? `${upper.exclusive ? '<' : '≤'}${upper.value}`
      : lower
        ? `${lower.exclusive ? '>' : '≥'}${lower.value}`
        : '';

  // An unbounded `number` already has the exact TS representation we can
  // provide. Keep it compact, but retain `integer` even without bounds so the
  // validator's integral-value requirement is not silently erased.
  return t === 'number' && !range ? '' : `${t}${range ? `(${range})` : ''}`;
}

/** Map a single JSON-Schema primitive `type` to its TS type. */
function primitiveType(t: string): string {
  switch (t) {
    case 'string':
      return 'string';
    case 'number':
    case 'integer':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'null':
      return 'null';
    case 'array':
      return 'unknown[]';
    case 'object':
      return 'Record<string, unknown>';
    default:
      return 'unknown';
  }
}

/** Map a primitive and retain numeric validator constraints as a TS comment. */
function primitiveSchemaType(t: string, schema: JsonSchema): string {
  const base = primitiveType(t);
  const note = numericConstraintNote(schema, t);
  return note ? `${base} /* ${note} */` : base;
}

/** Resolve a `$ref` like `#/$defs/Name` or `#/definitions/Name` against the root `$defs`. */
function resolveRef(ref: string, defs: Record<string, JsonSchema>): JsonSchema | undefined {
  const m = /^#\/(?:\$defs|definitions)\/(.+)$/.exec(ref);
  if (!m) return undefined;
  return defs[m[1]];
}

/**
 * Render one JSON-Schema node to a TS type string.
 * `defs` is the root schema's `$defs`/`definitions` (for `$ref` resolution).
 */
function schemaToTs(
  schema: unknown,
  depth: number,
  defs: Record<string, JsonSchema>,
  maxDepth: number,
): string {
  if (!isObj(schema)) return 'unknown';
  if (depth > maxDepth) return 'unknown';

  // $ref → resolve against root defs (cycle-safe via the depth cap).
  if (typeof schema.$ref === 'string') {
    const target = resolveRef(schema.$ref, defs);
    return target ? schemaToTs(target, depth + 1, defs, maxDepth) : 'unknown';
  }

  // const / enum → literal unions.
  if ('const' in schema) return literal(schema.const);
  if (Array.isArray(schema.enum)) {
    const members = uniq(schema.enum.map(literal));
    return members.length ? members.join(' | ') : 'never';
  }

  // Combinators.
  if (Array.isArray(schema.anyOf) || Array.isArray(schema.oneOf)) {
    const variants = (schema.anyOf ?? schema.oneOf) as unknown[];
    const parts = uniq(variants.map((v) => schemaToTs(v, depth + 1, defs, maxDepth)));
    return parts.length ? parts.map((p) => (p.includes('|') ? `(${p})` : p)).join(' | ') : 'unknown';
  }
  if (Array.isArray(schema.allOf)) {
    const parts = uniq((schema.allOf as unknown[]).map((v) => schemaToTs(v, depth + 1, defs, maxDepth)));
    return parts.length ? parts.join(' & ') : 'unknown';
  }

  // `nullable: true` (draft-07 / OpenAPI flavor) widens with null.
  const nullableSuffix = schema.nullable === true ? ' | null' : '';

  // `type` may be a string or an array of types (e.g. ["string","null"]).
  const t = schema.type;
  if (Array.isArray(t)) {
    const parts = uniq(
      t.map((one) =>
        one === 'object' || one === 'array'
          ? schemaToTs({ ...schema, type: one }, depth, defs, maxDepth)
          : primitiveSchemaType(String(one), schema),
      ),
    );
    return parts.join(' | ');
  }

  if (t === 'array') {
    const items = schema.items;
    if (Array.isArray(items)) {
      // Tuple form.
      const parts = items.map((it) => schemaToTs(it, depth + 1, defs, maxDepth));
      return `[${parts.join(', ')}]${nullableSuffix}`;
    }
    const inner = items ? schemaToTs(items, depth + 1, defs, maxDepth) : 'unknown';
    return `Array<${inner}>${nullableSuffix}`;
  }

  if (t === 'object' || isObj(schema.properties) || schema.additionalProperties !== undefined) {
    return objectToTs(schema, depth, defs, maxDepth) + nullableSuffix;
  }

  if (typeof t === 'string') return primitiveSchemaType(t, schema) + nullableSuffix;

  return 'unknown';
}

/** Render a JSON-Schema object node to a TS object/record type. */
function objectToTs(
  schema: JsonSchema,
  depth: number,
  defs: Record<string, JsonSchema>,
  maxDepth: number,
): string {
  if (depth >= maxDepth) return 'Record<string, unknown>';

  const props = isObj(schema.properties) ? schema.properties : undefined;
  const ap = schema.additionalProperties;

  // Record shape: no declared properties, but a value schema on additionalProperties (z.record).
  const hasProps = props && Object.keys(props).length > 0;
  if (!hasProps) {
    if (isObj(ap)) return `Record<string, ${schemaToTs(ap, depth + 1, defs, maxDepth)}>`;
    if (ap === false) return '{}';
    return 'Record<string, unknown>';
  }

  const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
  const fields: string[] = [];
  for (const [key, propSchema] of Object.entries(props!)) {
    const optional = required.has(key) ? '' : '?';
    fields.push(`${renderKey(key)}${optional}: ${schemaToTs(propSchema, depth + 1, defs, maxDepth)}`);
  }
  // An open record (additionalProperties is a schema) alongside declared props → add an index sig.
  if (isObj(ap)) fields.push(`[k: string]: ${schemaToTs(ap, depth + 1, defs, maxDepth)} | unknown`);
  return `{ ${fields.join('; ')} }`;
}

/** Root `$defs`/`definitions` of a schema, for `$ref` resolution within it. */
function rootDefs(schema: JsonSchema): Record<string, JsonSchema> {
  const d = (schema.$defs ?? schema.definitions) as unknown;
  if (!isObj(d)) return {};
  const out: Record<string, JsonSchema> = {};
  for (const [k, v] of Object.entries(d)) if (isObj(v)) out[k] = v;
  return out;
}

export interface ToolArgsType {
  /** The rendered TS type for the tool's args object. */
  type: string;
  /** True when no arg is required — the call may be made with no argument. */
  optional: boolean;
}

/**
 * Render a tool's `inputSchema` (a JSON Schema object) to its TS args type + whether all
 * fields are optional (so the generated signature can mark `args?`).
 */
export function toolArgsType(tool: ProjectedTool, maxDepth = DEFAULT_MAX_DEPTH): ToolArgsType {
  const schema = tool.inputSchema;
  if (!isObj(schema)) return { type: 'Record<string, unknown>', optional: true };
  const defs = rootDefs(schema);
  const type = schemaToTs(schema, 0, defs, maxDepth);
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
  return { type, optional: required.length === 0 };
}

/**
 * EI-13298 — render the tool's RETURN shape, not just its args.
 *
 * The root cause of the bug this fixes: a `code:run` script author sees only the arg
 * signature (`Promise<unknown>` for the return) and so guesses response keys — a guess
 * that fails SILENTLY (an optional-chained `||`-fallback over a wrong key just collapses
 * to `[]`/`undefined`, never an error), which then reads as a true negative ("no data")
 * instead of the mapping bug it actually is. Two independent sources feed this, since
 * most tools declare only one of them:
 *
 *   1. `tool.outputJsonSchema` — a REAL JSON-Schema (present when the tool declared a
 *      Zod `result`, i.e. `defineTool({ result: z.object({...}) })`) — rendered to a
 *      precise TS type via the same `schemaToTs` walker `toolArgsType` uses for args.
 *   2. `tool.guidance.returns` — a free-text description of the shape (EI-10882),
 *      already authored on ~many tools for `tools:find`'s `returns` field but never
 *      surfaced anywhere a `code:run` script is actually being WRITTEN.
 *
 * When neither is declared, the return type stays `unknown` (honest — better than a
 * confident-looking but made-up shape) and no `@returns` comment is emitted.
 */
export function toolResultType(tool: ProjectedTool, maxDepth = DEFAULT_MAX_DEPTH): string {
  const schema = tool.outputJsonSchema;
  if (!isObj(schema)) return 'unknown';
  const defs = rootDefs(schema);
  return schemaToTs(schema, 0, defs, maxDepth);
}

/** Truncation cap for the `@returns` free-text comment (token economy; this one earns a bit more room than `desc` since it's the whole point of this render). */
const RETURNS_DESC_MAX = 220;

/** The tool's authored `guidance.returns` free-text shape hint (EI-10882), if any. */
function returnsNote(tool: ProjectedTool): string | undefined {
  const raw = tool.guidance?.returns?.trim();
  if (!raw) return undefined;
  const one = raw.replace(/\s+/g, ' ').trim();
  return one.length > RETURNS_DESC_MAX ? `${one.slice(0, RETURNS_DESC_MAX - 1)}…` : one;
}

/** One line of description, whitespace-collapsed and truncated for the signature comment. */
function shortDesc(desc: string | undefined): string {
  if (!desc) return '';
  const one = desc.replace(/\s+/g, ' ').trim();
  const bounded = one.length > DESC_MAX ? `${one.slice(0, DESC_MAX - 1)}…` : one;
  // Keep authored descriptions from terminating the generated JSDoc early.
  return bounded.replace(/\*\//g, '*\\/');
}

interface ToolArgDoc {
  path: string;
  description: string;
}

/** Render top-level JSON-Schema property descriptions as JSDoc @param hints. */
function toolArgDocs(tool: ProjectedTool): ToolArgDoc[] {
  const schema = tool.inputSchema;
  if (!isObj(schema) || !isObj(schema.properties)) return [];

  const docs: ToolArgDoc[] = [];
  for (const [key, propSchema] of Object.entries(schema.properties)) {
    if (!isObj(propSchema) || typeof propSchema.description !== 'string') continue;
    const description = shortDesc(propSchema.description);
    if (!description) continue;
    const path = isValidIdent(key) ? `args.${key}` : `args[${JSON.stringify(key)}]`;
    docs.push({ path, description });
  }
  return docs;
}

interface FacadeToolEntry {
  ns: string;
  verb: string;
  name: string;
  desc: string;
  argDocs: ToolArgDoc[];
  args: ToolArgsType;
  /** Rendered TS return type (EI-13298) — `unknown` when the tool declares no output schema. */
  resultType: string;
  /** Free-text `guidance.returns` shape hint (EI-10882), rendered as an `@returns` comment line. */
  returns?: string;
}

/** Project the tools into well-formed, allowed facade entries (sorted ns then verb). */
function facadeEntries(
  tools: readonly ProjectedTool[],
  opts: { allowed?: ReadonlySet<string>; namespaces?: readonly string[]; names?: readonly string[]; maxDepth?: number },
): FacadeToolEntry[] {
  const nsFilter = opts.namespaces && opts.namespaces.length ? new Set(opts.namespaces) : undefined;
  const nameFilter = opts.names && opts.names.length ? new Set(opts.names) : undefined;
  const entries: FacadeToolEntry[] = [];
  for (const tool of tools) {
    const name = tool.expose?.mcp?.name;
    if (!name) continue;
    const split = splitToolName(name);
    if (!split) continue;
    if (opts.allowed && !opts.allowed.has(name)) continue;
    const { rawNs, rawVerb } = split;
    const ns = camelNamespace(rawNs);
    if (rawNs === 'call' || ns === 'call') continue; // never shadow the escape hatch
    // When a subset is requested, include a tool if its ns OR its full name matches.
    if (nsFilter || nameFilter) {
      const hit = (nsFilter && (nsFilter.has(ns) || nsFilter.has(rawNs))) || (nameFilter && nameFilter.has(name));
      if (!hit) continue;
    }
    entries.push({
      ns,
      verb: camelVerb(rawVerb),
      name,
      desc: shortDesc(tool.description),
      argDocs: toolArgDocs(tool),
      args: toolArgsType(tool, opts.maxDepth),
      resultType: toolResultType(tool, opts.maxDepth),
      returns: returnsNote(tool),
    });
  }
  entries.sort((a, b) => (a.ns === b.ns ? a.verb.localeCompare(b.verb) : a.ns.localeCompare(b.ns)));
  return entries;
}

export interface GenerateFacadeTypesOptions {
  /** The agent's capability envelope (full `ns:verb` names). Absent ⇒ all tools. */
  allowed?: ReadonlySet<string>;
  /** Render only these namespaces (on-demand discovery). Combined with `names` as a union. */
  namespaces?: readonly string[];
  /** Render only these exact tool names. Combined with `namespaces` as a union. */
  names?: readonly string[];
  /** Nesting depth cap before nested objects collapse to Record<string, unknown>. */
  maxDepth?: number;
  /** Override the `declare const tools` header (e.g. omit for an embedded snippet). */
  header?: string;
}

/**
 * Generate the `declare const tools: { … }` TypeScript surface for the code-mode facade,
 * scoped to `allowed` (and optionally to a `namespaces`/`names` subset for on-demand loading).
 * The universal `call(toolName, args?)` escape hatch is always included.
 */
export function generateToolFacadeTypes(
  tools: readonly ProjectedTool[],
  opts: GenerateFacadeTypesOptions = {},
): string {
  const entries = facadeEntries(tools, opts);
  const byNs = new Map<string, FacadeToolEntry[]>();
  for (const e of entries) {
    const bucket = byNs.get(e.ns) ?? [];
    bucket.push(e);
    byNs.set(e.ns, bucket);
  }

  const lines: string[] = [];
  lines.push(opts.header ?? 'declare const tools: {');
  for (const ns of [...byNs.keys()].sort()) {
    lines.push(`  ${renderKey(ns)}: {`);
    for (const e of byNs.get(ns)!) {
      if (e.desc) lines.push(`    /** ${e.desc} */`);
      for (const doc of e.argDocs) lines.push(`    /** @param ${doc.path} ${doc.description} */`);
      // EI-13298: surface the RETURN shape right next to the arg signature — a
      // free-text `@returns` hint (guidance.returns, EI-10882) when authored, so the
      // model reads the real response shape instead of guessing keys that silently
      // collapse to an empty/undefined "true negative".
      if (e.returns) lines.push(`    /** @returns ${e.returns} */`);
      const argPart = e.args.type === '{}'
        ? 'args?: {}'
        : `args${e.args.optional ? '?' : ''}: ${e.args.type}`;
      lines.push(`    ${e.verb}(${argPart}): Promise<${e.resultType}>;`);
    }
    lines.push('  };');
  }
  lines.push('  /** Universal escape hatch — call any allowed tool by full "ns:verb" name. */');
  lines.push('  call(toolName: string, args?: unknown): Promise<unknown>;');
  lines.push('};');
  return lines.join('\n');
}

export interface FacadeNamespaceIndexEntry {
  ns: string;
  /** Camel-cased verbs available under this namespace (sorted). */
  verbs: string[];
  /** Full `ns:verb` names (sorted) — pass any to `code:tools { names }`. */
  toolNames: string[];
}

/**
 * The cheap index for on-demand discovery: every allowed namespace with its verb list, WITHOUT
 * full arg types. The model reads this first, then requests `generateToolFacadeTypes` for the
 * one or two namespaces it actually needs — the token win.
 */
export function listFacadeNamespaces(
  tools: readonly ProjectedTool[],
  allowed?: ReadonlySet<string>,
): FacadeNamespaceIndexEntry[] {
  const entries = facadeEntries(tools, { allowed });
  const byNs = new Map<string, FacadeNamespaceIndexEntry>();
  for (const e of entries) {
    const idx = byNs.get(e.ns) ?? { ns: e.ns, verbs: [], toolNames: [] };
    idx.verbs.push(e.verb);
    idx.toolNames.push(e.name);
    byNs.set(e.ns, idx);
  }
  return [...byNs.values()].sort((a, b) => a.ns.localeCompare(b.ns));
}
