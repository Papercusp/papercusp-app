import {
  checkScript,
  ensureParseCheckReady,
  extractPayloadTier,
  prepareToolArgsForSchema,
  type ProjectedTool,
} from '@papercusp/tooldef';
import type { StaticSourcePosition } from '@papercusp/tooldef/parse-check';
import { prepareNestedProjection } from '../../result-projection';

/**
 * Which schema rule an issue broke. Callers gate on this because the classes are NOT
 * equally trustworthy as a refusal reason:
 *
 *  - `unknown-key` is decided by `additionalProperties:false`, which is exactly what a strict
 *    zod object does at dispatch — so a flagged key is one the real dispatcher WILL reject.
 *    Safe to fail closed on.
 *  - every other class compares a literal against the PUBLISHED schema, which a tool may
 *    legitimately widen at dispatch: ~22 arg schemas here use `z.coerce`, deliberately so the
 *    same field accepts a numeric MCP arg AND a string (see plans/resume.ts, plans/revision-diff.ts).
 *    A `type` complaint against such a field is a FALSE positive, so a caller that cannot afford
 *    one (code:run, the highest-traffic script path) must treat these as advisory.
 *
 * EI-19449316000499177.
 */
export type RecipeSchemaIssueKind = 'unknown-key' | 'required' | 'enum' | 'type' | 'shape' | 'output-field';

export interface RecipeSchemaIssue {
  tool: string;
  path: string;
  message: string;
  /** Optional: absent on issues produced before the classification existed. */
  kind?: RecipeSchemaIssueKind;
  /** 1-based location of the invalid input call or unsafe result-field read. */
  position?: StaticSourcePosition;
  /** Tool-call location for an unsafe result-field read. */
  callPosition?: StaticSourcePosition;
}

interface SchemaIssueDetail {
  message: string;
  kind: RecipeSchemaIssueKind;
}

export interface RecipeSchemaValidation {
  ok: boolean;
  issues: RecipeSchemaIssue[];
  /** Canonical current-catalog tool names resolved statically from the script. */
  staticToolNames: string[];
}

type JsonSchema = {
  type?: string;
  enum?: unknown[];
  required?: string[];
  properties?: Record<string, JsonSchema>;
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  allOf?: JsonSchema[];
  minItems?: number;
};

// `checkScript` records property access chains from tool results. When the
// result is an array, that chain can end in a built-in Array property/method
// (for example `result.rows.map`), which is valid JavaScript but is not a JSON
// schema field. Keep this set explicit so an unknown member such as `rows.mapp`
// still fails closed.
const ARRAY_MEMBERS = new Set([
  'length',
  'at',
  'concat',
  'copyWithin',
  'entries',
  'every',
  'fill',
  'filter',
  'find',
  'findIndex',
  'findLast',
  'findLastIndex',
  'flat',
  'flatMap',
  'forEach',
  'includes',
  'indexOf',
  'join',
  'keys',
  'lastIndexOf',
  'map',
  'pop',
  'push',
  'reduce',
  'reduceRight',
  'reverse',
  'shift',
  'slice',
  'some',
  'sort',
  'splice',
  'toLocaleString',
  'toReversed',
  'toSorted',
  'toSpliced',
  'toString',
  'unshift',
  'values',
  'with',
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const equalJson = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) return true;
  if (typeof left !== typeof right || !isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every(
    (key, index) => key === rightKeys[index] && equalJson(left[key], right[key]),
  );
};

function validateValue(value: unknown, schema: JsonSchema, path: string): SchemaIssueDetail[] {
  const alternatives = schema.anyOf ?? schema.oneOf;
  if (alternatives?.length) {
    if (alternatives.some((candidate) => validateValue(value, candidate, path).length === 0)) return [];
    return [{ message: `${path} does not match any current schema alternative`, kind: 'shape' }];
  }

  if (schema.enum && !schema.enum.some((candidate) => equalJson(value, candidate))) {
    return [{
      message: `${path} must be one of ${schema.enum.map((candidate) => JSON.stringify(candidate)).join(', ')}`,
      kind: 'enum',
    }];
  }

  if (schema.type === 'object') {
    if (!isRecord(value)) return [{ message: `${path} must be an object`, kind: 'type' }];
    const issues: SchemaIssueDetail[] = [];
    for (const key of schema.required ?? []) {
      if (!(key in value)) issues.push({ message: `${path}.${key} is required`, kind: 'required' });
    }
    const properties = schema.properties ?? {};
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) {
          issues.push({
            message: `${path}.${key} is not accepted by the current tool schema`,
            kind: 'unknown-key',
          });
        }
      }
    }
    for (const [key, child] of Object.entries(properties)) {
      if (key in value) issues.push(...validateValue(value[key], child, `${path}.${key}`));
    }
    return issues;
  }

  if (schema.type === 'array') {
    if (!Array.isArray(value)) return [{ message: `${path} must be an array`, kind: 'type' }];
    return schema.items ? value.flatMap((item, index) => validateValue(item, schema.items!, `${path}[${index}]`)) : [];
  }

  const typeIssue = (expected: string): SchemaIssueDetail[] => [
    { message: `${path} must be ${expected}`, kind: 'type' },
  ];
  if (schema.type === 'string' && typeof value !== 'string') return typeIssue('a string');
  if (schema.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) return typeIssue('a number');
  if (schema.type === 'integer' && (!Number.isInteger(value))) return typeIssue('an integer');
  if (schema.type === 'boolean' && typeof value !== 'boolean') return typeIssue('a boolean');
  return [];
}

interface OutputPathFailure {
  reason: 'missing' | 'optional';
  path: string[];
}

/** Return the first result-path segment the current output schema cannot guarantee. */
function outputPathFailure(
  schema: JsonSchema,
  path: string[],
  safeOptionalPaths: string[][] = [],
  offset = 0,
): OutputPathFailure | null {
  const alternatives = schema.anyOf ?? schema.oneOf;
  if (alternatives?.length) {
    for (const alternative of alternatives) {
      const failure = outputPathFailure(alternative, path, safeOptionalPaths, offset);
      if (failure) return failure;
    }
    return null;
  }

  if (schema.allOf?.length) {
    const properties = Object.assign({}, ...schema.allOf.map((part) => part.properties ?? {}), schema.properties ?? {});
    const required = [...new Set([
      ...schema.allOf.flatMap((part) => part.required ?? []),
      ...(schema.required ?? []),
    ])];
    return outputPathFailure({ ...schema, allOf: undefined, properties, required }, path, safeOptionalPaths, offset);
  }

  const segment = path[offset];
  if (segment === undefined) return null;

  let child: JsonSchema | undefined;
  if (schema.type === 'array') {
    // Validate the array path itself, but do not mistake an intrinsic Array
    // member for a field the tool must declare in its JSON output schema.
    if (offset === path.length - 1 && ARRAY_MEMBERS.has(segment)) return null;
    const index = Number(segment);
    if (!Number.isInteger(index) || index < 0 || !schema.items) {
      return { reason: 'missing', path: path.slice(0, offset + 1) };
    }
    if ((schema.minItems ?? 0) <= index) {
      const optionalPath = path.slice(0, offset + 1);
      if (!safeOptionalPaths.some((safePath) => safePath.length === optionalPath.length && safePath.every((segment, i) => segment === optionalPath[i]))) {
        return { reason: 'optional', path: optionalPath };
      }
    }
    child = schema.items;
  } else {
    const properties = schema.properties ?? {};
    if (!Object.prototype.hasOwnProperty.call(properties, segment)) {
      return { reason: 'missing', path: path.slice(0, offset + 1) };
    }
    if (!(schema.required ?? []).includes(segment)) {
      const optionalPath = path.slice(0, offset + 1);
      if (!safeOptionalPaths.some((safePath) => safePath.length === optionalPath.length && safePath.every((part, i) => part === optionalPath[i]))) {
        return { reason: 'optional', path: optionalPath };
      }
    }
    child = properties[segment];
  }

  if (offset === path.length - 1) return null;
  return child
    ? outputPathFailure(child, path, safeOptionalPaths, offset + 1)
    : { reason: 'missing', path: path.slice(0, offset + 1) };
}

const mcpName = (tool: ProjectedTool): string | undefined => tool.expose.mcp?.name;

/** Validate statically-known calls against the live projected tool catalog. */
export async function validateRecipeScriptAgainstCatalog(
  script: string,
  tools: readonly ProjectedTool[],
  allowed?: ReadonlySet<string>,
): Promise<RecipeSchemaValidation> {
  await ensureParseCheckReady();
  const analysis = checkScript(script, tools, allowed);
  const byName = new Map<string, ProjectedTool>();
  for (const tool of tools) {
    const name = mcpName(tool);
    if (name) byName.set(name, tool);
  }
  // TypeScript is intentionally error-tolerant and may recover malformed JavaScript into an
  // AST that contains pseudo-properties. Those nodes are useful for the advisory tool scan, but
  // they are not reliable evidence for literal argument validation: an unescaped quote inside a
  // shell command can otherwise become a false `unknown-key` refusal. Let the VM's compile step
  // report the authoritative syntax error and skip only this schema inspection pass.
  const staticToolNames = [...new Set(analysis.calls.map((call) => call.tool))].sort();
  if (analysis.hasParseErrors) {
    return { ok: true, issues: [], staticToolNames };
  }
  // Unknown/disallowed references remain the runtime facade's concern: the
  // existing orchestration parser reports those with the caller's role-scoped
  // allow-set. This guard focuses on the failure class that survives name
  // resolution: literal arguments accepted when the recipe was saved but no
  // longer accepted by the current tool schema.
  const issues: RecipeSchemaIssue[] = [];

  for (const call of analysis.calls) {
    const name = call.tool.includes(':') ? call.tool : [...byName.keys()].find((candidate) => candidate?.replace(':', '.') === call.tool);
    const tool = name ? byName.get(name) : undefined;
    if (!name || !tool) continue;
    if (!call.dynamicArgs && call.args != null) {
      // `payloadTier` is a framework-reserved control. The real projected-tool
      // dispatcher extracts it before validating the tool's published schema, so
      // recipe preflight must validate the same schema-visible argument shape.
      const { input: tierlessArgs } = extractPayloadTier(call.args);
      // `projection` is a host-owned dispatch control, just like payloadTier. The
      // direct transport peels it before the target schema; recipe preflight must
      // validate the same schema-visible argument shape or it rejects valid calls.
      const { args: nestedArgs } = prepareNestedProjection(tierlessArgs);
      const schemaArgs = prepareToolArgsForSchema(
        name,
        tool.inputSchema as Record<string, unknown>,
        nestedArgs,
      );
      for (const detail of validateValue(schemaArgs, tool.inputSchema as JsonSchema, 'args')) {
        issues.push({ tool: name, path: 'args', message: detail.message, kind: detail.kind, position: call.position });
      }
    }

    const outputSchema = tool.outputJsonSchema as JsonSchema | undefined;
    if (!outputSchema || !call.resultReads?.length) continue;
    for (const read of call.resultReads) {
      const failure = outputPathFailure(outputSchema, read.path, read.safeOptionalPaths ?? []);
      if (!failure) continue;
      const readPath = `result.${read.path.join('.')}`;
      const unsafePrefix = `result.${failure.path.join('.')}`;
      const reason = failure.reason === 'optional'
        ? `${unsafePrefix} is optional in the current output schema and may be absent at runtime`
        : `${unsafePrefix} is not declared in the current output schema`;
      issues.push({
        tool: name,
        path: readPath,
        message: `${readPath} is unsafe: ${reason}; update or guard the saved recipe before execution`,
        kind: 'output-field',
        position: read.position,
        callPosition: call.position,
      });
    }
  }
  return {
    ok: issues.length === 0,
    issues,
    staticToolNames,
  };
}
