/**
 * Executable continuity probes — the typed, data-only extension of carried
 * CheckEntry rows. Writers validate against the live projected-tool contract;
 * wake/orient readers replay only schema-current, read-only probes.
 *
 * This deliberately reuses the existing carry-note/checkpoint stores. There is
 * no second continuity table and no executable source text: predicates are a
 * tiny tagged grammar over JSON values, and state reads route through the
 * registered `state:read` door.
 */
import { Buffer } from 'node:buffer';
import { z } from 'zod';
import { listAllProjectedTools, projectedToolRegistryRevision, type ProjectedTool } from '@papercusp/agent-mcp';
import { checkAgainstJsonSchema } from './json-schema-validation';
import { parseProjection } from './result-projection';
import { redactSensitiveText, redactSensitiveValue } from './sensitive-text';
import { getCellUnchecked } from './cell-registry';
import { withBoundedTimeout } from './bounded-timeout';
import { mapWithConcurrency } from './gym/concurrency';
import type { CheckEntry } from './carry-note';
import { LIMITS } from './agent-tools/limits';

export const CONTINUITY_PROBE_MAX_BYTES = 12_000;
export const CONTINUITY_PROBE_ARGS_MAX_BYTES = 8_000;
export const CONTINUITY_PROBE_PROJECTION_MAX_BYTES = 2_000;
export const CONTINUITY_PROBE_RESULT_MAX_BYTES = 16_000;
export const CONTINUITY_PROBE_BATCH_MAX_BYTES = 24_000;
export const CONTINUITY_PROBE_MAX_PER_WAKE = 8;
export const CONTINUITY_PROBE_CONCURRENCY = 4;
export const CONTINUITY_PROBE_TIMEOUT_MS = 2_500;

const scalarSchema = z.union([z.string().max(1_000), z.number().finite(), z.boolean(), z.null()]);

/**
 * Writer-only convenience sentinel. The durable probe must always contain the
 * concrete revision that was checked at write time; `live` is only a way for a
 * caller to ask the writer to resolve that revision from the target it named.
 */
export const LIVE_SCHEMA_REVISION = 'live';

const schemaRevisionSchema = z
  .string()
  .min(1)
  .max(160)
  .describe(
    'Exact projected-tool-registry revision for this target. Writer-only `live` is expanded to the current target revision before validation; persisted and replayed probes contain the concrete revision.',
  );

/**
 * EI-22052859235198905 / EI-22057107388066791 / EI-22057804176244287: three
 * independent reporters guessed a wrong shape for `expect` (a bare string,
 * free-form evidence text, a right-shaped predicate bundled with extra keys)
 * and got zod's generic structural message back — accurate but not
 * actionable, unlike the semantic messages `superRefine` below already gives
 * for a right-shaped-but-wrong-valued predicate. This covers the two
 * structural codes THIS object's own checks raise: `invalid_type` (the input
 * isn't an object at all) and strict-mode `unrecognized_keys` (extra keys
 * alongside path/op/value). A predicate missing `path`/`op` entirely still
 * surfaces zod's own per-field message at that field's path — that issue is
 * raised by the child field schema, not this object, so it is out of scope
 * here; it already names the exact missing field. Same class of fix as
 * `probeDiscriminatorMessage` above: name the exact shape + a worked example.
 */
export function continuityPredicateShapeMessage(): string {
  return (
    'expect must be a predicate object shaped exactly ' +
    '{ path: string, op: "exists"|"eq"|"ne"|"gt"|"gte"|"lt"|"lte", value?: string|number|boolean|null } — ' +
    'not a bare string or a free-form evidence object. Example: { path: "$.state", op: "eq", value: "green" }. ' +
    'Narrative evidence belongs in `verified`/`recheck` on the check row, not in `expect`.'
  );
}

export const continuityPredicateSchema = z
  .object(
    {
      path: z.string().min(1).max(240).describe('Dot/bracket path into the JSON result; use "$" for the root value.'),
      op: z
        .enum(['exists', 'eq', 'ne', 'gt', 'gte', 'lt', 'lte'])
        .describe(
          'Predicate operation. `exists` checks presence and MUST omit `value`; comparison operations require a scalar `value`.',
        ),
      value: scalarSchema
        .optional()
        .describe('Expected scalar for comparison operations; omit this field when `op` is `exists`.'),
    },
    {
      // Only intercept issues this OBJECT itself raises (wrong overall type;
      // extra/misnamed keys under `.strict()`) — a per-field issue (e.g. an
      // invalid `op` enum value) keeps its own already-clear message.
      error: (issue) =>
        issue.code === 'invalid_type' || issue.code === 'unrecognized_keys'
          ? continuityPredicateShapeMessage()
          : undefined,
    },
  )
  .strict()
  .superRefine((predicate, ctx) => {
    const hasValue = Object.prototype.hasOwnProperty.call(predicate, 'value');
    if (predicate.op === 'exists' && hasValue) {
      ctx.addIssue({ code: 'custom', path: ['value'], message: '`exists` does not take a value' });
    }
    if (predicate.op !== 'exists' && !hasValue) {
      ctx.addIssue({ code: 'custom', path: ['value'], message: `\`${predicate.op}\` requires a scalar value` });
    }
    if (predicatePath(predicate.path) === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['path'],
        message: 'invalid predicate path; use $, dotted object keys, and numeric [index] segments only',
      });
    }
  });

const toolProbeShape = z
  .object({
    kind: z.literal('tool'),
    tool: z
      .string()
      .min(1)
      .max(LIMITS.IDENT)
      .describe(
        'Exact direct projected-tool name. Only directly invoked read-only tools may be persisted; indirect/meta surfaces such as `dev:pg_query`, `tools:invoke`, `code:run`, `recipes:run`, `capability:*`, and `computer:*` are rejected.',
      ),
    args: z.record(z.string(), z.unknown()).default({}),
    projection: z.unknown().optional(),
    schemaRevision: schemaRevisionSchema,
    expect: continuityPredicateSchema,
  })
  .strict();

const stateCellProbeShape = z
  .object({
    kind: z.literal('state-cell'),
    cell: z.string().min(1).max(120),
    as: z.string().min(1).max(200).optional(),
    schemaRevision: schemaRevisionSchema,
    expect: continuityPredicateSchema,
  })
  .strict();

/**
 * Shape-only schema used to decode durable rows before current-contract checks.
 *
 * EI-21674755057848047 / EI-21929976122332931 / EI-21926988610689807: the bare
 * "Invalid discriminator value" this used to raise described the SHAPE that was
 * missing without naming the REMEDY, and every reporter reacted the same costly
 * way — dropping `probe`, and in one case the whole `checks` array, losing the
 * evidence the carry-note exists to carry. By the time this fires the row has
 * neither `tool` nor `cell` (normalizeFlattenedContinuityProbeRow infers `kind`
 * whenever exactly one is present), so the honest reading is not "you specified
 * the probe wrong" but "there is no probe here" — and that row wants `recheck`.
 */
const PROBE_DISCRIMINATOR_PREFIX = "probe.kind is a required discriminator ('tool' or 'state-cell').";

/**
 * The three ways a row reaches this error are NOT the same mistake, and a single
 * message would be actively false for two of them — so each gets its own remedy.
 * A message that misdescribes the input is worse than a terse one: it sends the
 * reader to fix something that is not wrong.
 */
export function probeDiscriminatorMessage(input: unknown): string {
  const probe = input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : null;
  const hasTool = !!probe && Object.prototype.hasOwnProperty.call(probe, 'tool');
  const hasCell = !!probe && Object.prototype.hasOwnProperty.call(probe, 'cell');

  if (hasTool && hasCell) {
    return (
      `${PROBE_DISCRIMINATOR_PREFIX} This probe carries BOTH \`tool\` and \`cell\`, so the kind cannot be ` +
      'inferred without guessing which one you meant — state `kind` explicitly, or drop the field you do not need.'
    );
  }
  if (hasTool || hasCell) {
    // Unreachable through the checkpoint tools (the normalizer infers `kind` for
    // exactly this shape), but reachable when decoding a durable row written before
    // that inference existed — so it still names the concrete repair.
    return `${PROBE_DISCRIMINATOR_PREFIX} This probe carries \`${hasTool ? 'tool' : 'cell'}\`, so add kind:'${hasTool ? 'tool' : 'state-cell'}'.`;
  }
  return (
    `${PROBE_DISCRIMINATOR_PREFIX} This probe carries neither \`tool\` nor \`cell\`, so there is nothing to ` +
    'execute — it is a claim with no probe, not an under-specified one. OMIT `probe` and put the human ' +
    're-check in `recheck`; keep the check row rather than dropping it.'
  );
}

export const continuityProbeShapeSchema = z.discriminatedUnion('kind', [toolProbeShape, stateCellProbeShape], {
  error: (issue) => (issue.code === 'invalid_union' ? probeDiscriminatorMessage(issue.input) : undefined),
});
export type ContinuityProbe = z.infer<typeof continuityProbeShapeSchema>;
export type ContinuityPredicate = z.infer<typeof continuityPredicateSchema>;

export interface ContinuityProbeValidationIssue {
  path: Array<string | number>;
  message: string;
  code:
    | 'unknown_tool'
    | 'indirect_tool'
    | 'not_read_only'
    | 'schema_revision_mismatch'
    | 'invalid_args'
    | 'invalid_projection'
    | 'secret_material'
    | 'oversized'
    | 'unknown_state_cell'
    | 'unreadable_state_cell';
}

const SECRET_KEY_RE =
  /(?:authorization|cookie|credential|password|passphrase|secret|token|private.?key|access.?key|api.?key|client.?secret)/i;

const INDIRECT_OR_META_TOOL =
  /^(?:tools:|agent_tools:list$|code:run$|recipes:run$|capability:|computer:|dev:pg_(?:query|mutate)$)/;

function targetName(probe: ContinuityProbe): string {
  return probe.kind === 'tool' ? probe.tool : 'state:read';
}

function projectedTool(name: string): ProjectedTool | undefined {
  return listAllProjectedTools().find((tool) => tool.expose.mcp?.name === name);
}

export function continuityProbeRevision(toolName: string): string | null {
  const tool = projectedTool(toolName);
  return tool ? projectedToolRegistryRevision([tool]) : null;
}

/**
 * Resolve the writer-only `schemaRevision:'live'` shorthand before the
 * current-contract validator runs. Keeping this preprocessing on the writer
 * schema (rather than the shape/decode schema) ensures durable rows and wake
 * replay remain pinned to the exact revision that was validated.
 */
function normalizeWriterProbeRevision(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const probe = value as Record<string, unknown>;
  if (probe.schemaRevision !== LIVE_SCHEMA_REVISION) return value;

  const toolName =
    probe.kind === 'tool' && typeof probe.tool === 'string'
      ? probe.tool
      : probe.kind === 'state-cell'
        ? 'state:read'
        : null;
  if (!toolName) return value;
  const revision = continuityProbeRevision(toolName);
  return revision ? { ...probe, schemaRevision: revision } : value;
}

function jsonBytes(value: unknown): number | null {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return null;
  }
}

function findSecret(
  value: unknown,
  path: Array<string | number> = [],
  seen = new WeakSet<object>(),
): Array<string | number> | null {
  if (typeof value === 'string') return redactSensitiveText(value) === value ? null : path;
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return null;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const hit = findSecret(value[i], [...path, i], seen);
      if (hit) return hit;
    }
    return null;
  }
  if (typeof value !== 'object') return null;
  if (seen.has(value)) return path;
  seen.add(value);
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY_RE.test(key)) return [...path, key];
    const hit = findSecret(entry, [...path, key], seen);
    if (hit) return hit;
  }
  seen.delete(value);
  return null;
}

function effectOf(tool: ProjectedTool, args: unknown): 'read' | 'write' | 'unknown' {
  try {
    const dynamic = tool.effectForCall?.(args);
    if (dynamic === 'read' || dynamic === 'write') return dynamic;
  } catch {
    return 'unknown';
  }
  return tool.effect === 'read' || tool.effect === 'write' ? tool.effect : 'unknown';
}

/** Current-contract validation shared by both checkpoint writers and wake replay. */
export function validateContinuityProbe(probe: ContinuityProbe): ContinuityProbeValidationIssue[] {
  const issues: ContinuityProbeValidationIssue[] = [];
  const name = targetName(probe);
  const tool = projectedTool(name);
  if (!tool) {
    issues.push({
      path: probe.kind === 'tool' ? ['tool'] : ['cell'],
      code: 'unknown_tool',
      message: `unknown projected tool: ${name}`,
    });
    return issues;
  }
  if (probe.kind === 'tool' && INDIRECT_OR_META_TOOL.test(name)) {
    issues.push({
      path: ['tool'],
      code: 'indirect_tool',
      message: `${name} is an indirect execution/meta surface and cannot be persisted as a continuity probe`,
    });
  }
  const args = probe.kind === 'tool' ? probe.args : { cell: probe.cell, ...(probe.as ? { as: probe.as } : {}) };
  if (effectOf(tool, args) !== 'read') {
    issues.push({
      path: probe.kind === 'tool' ? ['tool'] : ['cell'],
      code: 'not_read_only',
      message: `${name} is not provably read-only for these arguments`,
    });
  }
  const revision = projectedToolRegistryRevision([tool]);
  if (probe.schemaRevision !== revision) {
    // This branch is reached only from the WRITER path (continuityProbeSchema):
    // the replay path (runOne, below) checks schemaRevision against the current
    // registry BEFORE calling validateContinuityProbe, and short-circuits with
    // its own diagnostic on a mismatch — so `probe.schemaRevision` here was
    // either a caller-supplied literal that was not (or could not be resolved
    // from) the `live` sentinel. Naming that sentinel in the message is what
    // turns a guess-the-revision failure into a one-shot fix; multiple callers
    // have independently hit this exact wall (EI-21886701316980990 and
    // siblings) by hardcoding a stale revision instead of using `live`.
    issues.push({
      path: ['schemaRevision'],
      code: 'schema_revision_mismatch',
      message: `stored revision ${probe.schemaRevision} differs from current revision ${revision}; pass schemaRevision:"${LIVE_SCHEMA_REVISION}" instead of a hardcoded revision string and the writer resolves it for you`,
    });
  }
  const argsBytes = jsonBytes(args);
  if (argsBytes === null || argsBytes > CONTINUITY_PROBE_ARGS_MAX_BYTES) {
    issues.push({
      path: probe.kind === 'tool' ? ['args'] : [],
      code: 'oversized',
      message: `arguments must serialize to at most ${CONTINUITY_PROBE_ARGS_MAX_BYTES} bytes`,
    });
  }
  // Scan the WHOLE persisted envelope, not only target args: a projection grep
  // pattern or expected scalar can carry the same credential bytes as an arg.
  const secretPath = findSecret(probe);
  if (secretPath) {
    issues.push({
      path: secretPath,
      code: 'secret_material',
      message: 'credential/auth/secret-bearing material is forbidden in persisted probes',
    });
  }
  const checked = checkAgainstJsonSchema(tool.discoveryInputSchema ?? tool.inputSchema, args);
  if (!checked.ok) {
    for (const message of checked.errors.slice(0, 6)) {
      issues.push({ path: probe.kind === 'tool' ? ['args'] : [], code: 'invalid_args', message });
    }
  }
  if (probe.kind === 'tool' && probe.projection !== undefined) {
    const projectionBytes = jsonBytes(probe.projection);
    if (projectionBytes === null || projectionBytes > CONTINUITY_PROBE_PROJECTION_MAX_BYTES) {
      issues.push({
        path: ['projection'],
        code: 'oversized',
        message: `projection must serialize to at most ${CONTINUITY_PROBE_PROJECTION_MAX_BYTES} bytes`,
      });
    }
    const parsed = parseProjection(probe.projection);
    if (!parsed.ok) issues.push({ path: ['projection'], code: 'invalid_projection', message: parsed.error });
  }
  if (probe.kind === 'state-cell') {
    const cell = getCellUnchecked(probe.cell);
    if (!cell)
      issues.push({
        path: ['cell'],
        code: 'unknown_state_cell',
        message: `state cell ${probe.cell} is not registered`,
      });
    else if (cell.changeSignal.kind !== 'poll') {
      issues.push({
        path: ['cell'],
        code: 'unreadable_state_cell',
        message: `state cell ${probe.cell} is event-signalled and cannot be read through state:read`,
      });
    }
  }
  const probeBytes = jsonBytes(probe);
  if (probeBytes === null || probeBytes > CONTINUITY_PROBE_MAX_BYTES) {
    issues.push({
      path: [],
      code: 'oversized',
      message: `probe must serialize to at most ${CONTINUITY_PROBE_MAX_BYTES} bytes`,
    });
  }
  return issues;
}

/** Writer-facing schema: shape + the live contract, with field-addressed issues. */
export const continuityProbeSchema = z
  .preprocess(normalizeWriterProbeRevision, continuityProbeShapeSchema)
  .superRefine((probe, ctx) => {
    for (const issue of validateContinuityProbe(probe)) {
      ctx.addIssue({ code: 'custom', path: issue.path, message: `${issue.code}: ${issue.message}` });
    }
  });

export function encodeContinuityProbe(probe: ContinuityProbe): string {
  return Buffer.from(JSON.stringify(probe), 'utf8').toString('base64url');
}

export function decodeContinuityProbe(encoded: string): ContinuityProbe | null {
  if (!/^[A-Za-z0-9_-]{1,20000}$/.test(encoded)) return null;
  try {
    const raw = Buffer.from(encoded, 'base64url').toString('utf8');
    if (Buffer.byteLength(raw, 'utf8') > CONTINUITY_PROBE_MAX_BYTES) return null;
    return continuityProbeShapeSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

function predicatePath(path: string): Array<string | number> | null {
  if (path === '$') return [];
  const source = path.startsWith('$.') ? path.slice(2) : path;
  if (!source) return null;
  const parts: Array<string | number> = [];
  let rest = source;
  while (rest.length > 0) {
    const key = /^([A-Za-z_][A-Za-z0-9_-]*)/.exec(rest);
    if (key) {
      parts.push(key[1]);
      rest = rest.slice(key[0].length);
    } else {
      const index = /^\[(\d+)\]/.exec(rest);
      if (!index) return null;
      parts.push(Number(index[1]));
      rest = rest.slice(index[0].length);
    }
    if (rest.startsWith('.')) rest = rest.slice(1);
    else if (rest.length > 0 && !rest.startsWith('[')) return null;
  }
  return parts;
}

function valueAtPredicatePath(value: unknown, path: string): unknown {
  const parts = predicatePath(path);
  if (parts === null) return undefined;
  let current = value;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined;
    current = (current as Record<string | number, unknown>)[part];
  }
  return current;
}

export function evaluateContinuityPredicate(
  predicate: ContinuityPredicate,
  value: unknown,
): { matches: boolean; actual: unknown } {
  const actual = valueAtPredicatePath(value, predicate.path);
  const compare = (op: 'gt' | 'gte' | 'lt' | 'lte'): boolean => {
    if (typeof actual === 'number' && typeof predicate.value === 'number') {
      if (op === 'gt') return actual > predicate.value;
      if (op === 'gte') return actual >= predicate.value;
      if (op === 'lt') return actual < predicate.value;
      return actual <= predicate.value;
    }
    if (typeof actual === 'string' && typeof predicate.value === 'string') {
      if (op === 'gt') return actual > predicate.value;
      if (op === 'gte') return actual >= predicate.value;
      if (op === 'lt') return actual < predicate.value;
      return actual <= predicate.value;
    }
    return false;
  };
  switch (predicate.op) {
    case 'exists':
      return { matches: actual !== undefined, actual };
    case 'eq':
      return { matches: Object.is(actual, predicate.value), actual };
    case 'ne':
      return { matches: !Object.is(actual, predicate.value), actual };
    case 'gt':
      return { matches: compare('gt'), actual };
    case 'gte':
      return { matches: compare('gte'), actual };
    case 'lt':
      return { matches: compare('lt'), actual };
    case 'lte':
      return { matches: compare('lte'), actual };
  }
}

export interface ContinuityProbeSource {
  source: { kind: 'loop'; ownerId: string } | { kind: 'work-item'; id: string; harness?: string | null };
  checkIndex: number;
  check: CheckEntry;
}

export interface ContinuityProbeResult {
  source: ContinuityProbeSource['source'];
  checkIndex: number;
  checkId?: string;
  claim: string;
  status: 'fresh' | 'stale' | 'error' | 'unknown';
  executed: boolean;
  observed?: unknown;
  diagnostic?: {
    code: string;
    message: string;
    fieldPath?: string;
    storedRevision?: string;
    currentRevision?: string | null;
    candidates?: string[];
  };
}

function candidateFields(tool: ProjectedTool | undefined, probe: ContinuityProbe): string[] {
  if (!tool || probe.kind !== 'tool') return [];
  const props = (tool.discoveryInputSchema ?? tool.inputSchema).properties;
  if (!props || typeof props !== 'object' || Array.isArray(props)) return [];
  const known = Object.keys(props as Record<string, unknown>);
  const unknown = Object.keys(probe.args).filter((key) => !known.includes(key));
  const needle = unknown[0] ?? '';
  const score = (candidate: string): number => {
    let same = 0;
    const n = Math.min(needle.length, candidate.length);
    for (let i = 0; i < n; i += 1) if (needle[i] === candidate[i]) same += 1;
    return Math.abs(needle.length - candidate.length) - same;
  };
  return known.sort((a, b) => score(a) - score(b) || a.localeCompare(b)).slice(0, 5);
}

function decodeToolResult(result: unknown): unknown {
  if (!result || typeof result !== 'object') return result;
  const row = result as Record<string, unknown>;
  if ('data' in row) return row.data;
  if ('structuredContent' in row) return row.structuredContent;
  const content = row.content;
  if (!Array.isArray(content)) return result;
  const texts = content.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const text = (entry as { text?: unknown }).text;
    return typeof text === 'string' ? [text] : [];
  });
  if (texts.length === 1) {
    try {
      return JSON.parse(texts[0]);
    } catch {
      return texts[0];
    }
  }
  return texts;
}

function observedScalar(value: unknown): unknown {
  const redacted = redactSensitiveValue(value);
  if (redacted == null || typeof redacted === 'number' || typeof redacted === 'boolean') return redacted;
  if (typeof redacted === 'string') return redacted.slice(0, 256);
  return undefined;
}

export interface ContinuityProbeDispatchContext {
  dispatchTool?: (name: string, args: Record<string, unknown>) => Promise<unknown>;
}

async function runOne(
  source: ContinuityProbeSource,
  ctx: ContinuityProbeDispatchContext,
): Promise<ContinuityProbeResult> {
  const probe = source.check.probe;
  const base = {
    source: source.source,
    checkIndex: source.checkIndex,
    ...(source.check.id ? { checkId: source.check.id } : {}),
    claim: source.check.claim,
  };
  if (!probe)
    return {
      ...base,
      status: 'unknown',
      executed: false,
      diagnostic: { code: 'missing_probe', message: 'check has no executable probe' },
    };
  const name = targetName(probe);
  const tool = projectedTool(name);
  const currentRevision = tool ? projectedToolRegistryRevision([tool]) : null;
  if (currentRevision !== probe.schemaRevision) {
    return {
      ...base,
      status: 'unknown',
      executed: false,
      diagnostic: {
        code: 'schema_revision_mismatch',
        message: 'probe contract drifted; explicit checkpoint migration is required before replay',
        fieldPath: probe.kind === 'tool' ? 'args' : 'cell',
        storedRevision: probe.schemaRevision,
        currentRevision,
        candidates: candidateFields(tool, probe),
      },
    };
  }
  const validation = validateContinuityProbe(probe);
  if (validation.length > 0) {
    const issue = validation[0];
    return {
      ...base,
      status: 'unknown',
      executed: false,
      diagnostic: {
        code: issue.code,
        message: issue.message,
        fieldPath: issue.path.map(String).join('.'),
        storedRevision: probe.schemaRevision,
        currentRevision,
        candidates: candidateFields(tool, probe),
      },
    };
  }
  if (!ctx.dispatchTool) {
    return {
      ...base,
      status: 'error',
      executed: false,
      diagnostic: { code: 'dispatcher_unavailable', message: 'internal read-only dispatcher is unavailable' },
    };
  }
  const args =
    probe.kind === 'tool'
      ? { ...probe.args, ...(probe.projection !== undefined ? { projection: probe.projection } : {}) }
      : { cell: probe.cell, ...(probe.as ? { as: probe.as } : {}) };
  const dispatched = await withBoundedTimeout(ctx.dispatchTool(name, args), {
    fallback: null,
    timeoutMs: CONTINUITY_PROBE_TIMEOUT_MS,
    label: `continuity-probe:${name}`,
  });
  if (dispatched.degraded || dispatched.value === null) {
    return {
      ...base,
      status: 'error',
      executed: true,
      diagnostic: {
        code: dispatched.reason ?? 'empty_result',
        message: dispatched.errorMessage ?? `probe ${name} did not return within its budget`,
      },
    };
  }
  const result = dispatched.value as Record<string, unknown>;
  if (result?.isError === true) {
    return {
      ...base,
      status: 'error',
      executed: true,
      diagnostic: { code: 'tool_error', message: `read-only probe ${name} returned an error` },
    };
  }
  const decoded = decodeToolResult(dispatched.value);
  const decodedBytes = jsonBytes(decoded);
  if (decodedBytes === null || decodedBytes > CONTINUITY_PROBE_RESULT_MAX_BYTES) {
    return {
      ...base,
      status: 'error',
      executed: true,
      diagnostic: {
        code: 'result_too_large',
        message: `decoded probe result exceeded the ${CONTINUITY_PROBE_RESULT_MAX_BYTES}-byte budget`,
      },
    };
  }
  const verdict = evaluateContinuityPredicate(probe.expect, decoded);
  const observed = observedScalar(verdict.actual);
  return {
    ...base,
    status: verdict.matches ? 'fresh' : 'stale',
    executed: true,
    ...(observed !== undefined ? { observed } : {}),
  };
}

export async function runContinuityProbeBatch(
  sources: readonly ContinuityProbeSource[],
  ctx: ContinuityProbeDispatchContext,
): Promise<{
  results: ContinuityProbeResult[];
  total: number;
  executed: number;
  truncated: number;
  limits: {
    maxProbes: number;
    concurrency: number;
    timeoutMs: number;
    maxResultBytes: number;
    maxBatchBytes: number;
  };
}> {
  const withProbes = sources.filter((source) => source.check.probe !== undefined);
  const selected = withProbes.slice(0, CONTINUITY_PROBE_MAX_PER_WAKE);
  const completed = await mapWithConcurrency(selected, CONTINUITY_PROBE_CONCURRENCY, (source) => runOne(source, ctx));
  const executed = completed.filter((result) => result.executed).length;
  const results = [...completed];
  let resultBudgetTruncated = 0;
  while ((jsonBytes(results) ?? Number.POSITIVE_INFINITY) > CONTINUITY_PROBE_BATCH_MAX_BYTES && results.length > 0) {
    results.pop();
    resultBudgetTruncated += 1;
  }
  return {
    results,
    total: withProbes.length,
    executed,
    truncated: Math.max(0, withProbes.length - selected.length) + resultBudgetTruncated,
    limits: {
      maxProbes: CONTINUITY_PROBE_MAX_PER_WAKE,
      concurrency: CONTINUITY_PROBE_CONCURRENCY,
      timeoutMs: CONTINUITY_PROBE_TIMEOUT_MS,
      maxResultBytes: CONTINUITY_PROBE_RESULT_MAX_BYTES,
      maxBatchBytes: CONTINUITY_PROBE_BATCH_MAX_BYTES,
    },
  };
}

/** Read existing loop + held-item checkpoint rows; no new persistence surface. */
export interface ContinuityProbeCollectionDeps {
  getLoopStatus?: (ownerId: string) => Promise<{ active: boolean; harnessSlug: string } | null>;
  getLoopCarryNoteWithMeta?: (ref: {
    harness: string;
    ownerId: string;
    workspaceId: string;
  }) => Promise<{ note: string | null; updatedAtMs: number | null }>;
  readHeldWorkItems?: (
    ownerId: string,
    workspaceId: string,
    opts: { limit: number },
  ) => Promise<
    Array<{
      id: string;
      harness: string | null;
      checkpoint: string | null;
    }>
  >;
}

export async function collectContinuityProbeSources(
  ownerId: string,
  workspaceId: string,
  deps: ContinuityProbeCollectionDeps = {},
): Promise<ContinuityProbeSource[]> {
  const [carryNote, { readHeldWorkItems }, loopRoutine] = await Promise.all([
    import('./carry-note'),
    import('./carry-brief'),
    import('./harness/routines/loop'),
  ]);
  const getLoopStatus = deps.getLoopStatus ?? loopRoutine.getLoopStatus;
  const getLoopCarryNoteWithMeta = deps.getLoopCarryNoteWithMeta ?? carryNote.getLoopCarryNoteWithMeta;
  const readHeld = deps.readHeldWorkItems ?? readHeldWorkItems;
  const out: ContinuityProbeSource[] = [];
  const [loop, held] = await Promise.all([
    getLoopStatus(ownerId).catch(() => null),
    readHeld(ownerId, workspaceId, { limit: 20 }).catch(() => []),
  ]);
  if (loop?.active) {
    const meta = await getLoopCarryNoteWithMeta({ harness: loop.harnessSlug, ownerId, workspaceId }).catch(() => ({
      note: null,
      updatedAtMs: null,
    }));
    for (const [checkIndex, check] of carryNote.splitCarryNoteChecks(meta.note).checks.entries()) {
      out.push({ source: { kind: 'loop', ownerId }, checkIndex, check });
    }
  }
  for (const item of held) {
    for (const [checkIndex, check] of carryNote.splitCarryNoteChecks(item.checkpoint).checks.entries()) {
      out.push({ source: { kind: 'work-item', id: item.id, harness: item.harness }, checkIndex, check });
    }
  }
  return out;
}

export async function runContinuityProbesForOwner(
  ownerId: string,
  workspaceId: string,
  ctx: ContinuityProbeDispatchContext,
) {
  return runContinuityProbeBatch(await collectContinuityProbeSources(ownerId, workspaceId), ctx);
}
