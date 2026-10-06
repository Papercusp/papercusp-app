/**
 * tools-discovery — project the derived pack catalog into the marketplace's
 * **Tools section** payload (`tool-distribution-granularity-2026-06-05`
 * P-006 / D-002/D-005).
 *
 * The discovery question is the resolver's question, fanned out: *for every
 * known tool, who provides it?* Each entry is one tool name resolved through
 * the `resolveToolProvider` ladder:
 *
 *   - `available`   — usable right now (built-in catalog, or an installed
 *                     plugin/pack registered it);
 *   - `installable` — a Cupboard listing (kind plugin|pack) declares it in
 *                     `provides_tools`; installing that unit resolves it. The
 *                     entry carries the providing listing so the UI can offer
 *                     the install action (D-005: a tool resolves to its
 *                     providing unit — runtime-sharing tools never install in
 *                     isolation).
 *
 * Pure projection over a `DerivedPackCatalog` — the route handler does the IO
 * (`derivePackCatalog()`) and delegates here, so this is unit-testable with
 * `assemblePackCatalog`-built inputs.
 */
import { resolveToolProvider, type PackDescriptor } from '@papercusp/blueprint-distribution';
import { getCatalog, listAllProjectedTools } from '@papercusp/agent-mcp';
import type { DerivedPackCatalog } from './pack-catalog';
import { categoryOf, searchTools } from './tools-search';

export interface ToolDiscoveryEntry {
  /** The MCP tool name (e.g. `repomix.pack`, `coord:send`). */
  tool: string;
  status: 'available' | 'installable';
  /** Namespace prefix used as the discovery category (`coord:send` → `coord`). */
  category: string;
  /**
   * One-line capability description — the tool's own (built-ins/installed
   * plugin tools) or, for a Cupboard-only tool with no per-tool text, the
   * providing unit's. Drives capability search + the UI's description line.
   */
  description?: string | null;
  /**
   * Compact, human-readable arg-schema text derived from the tool's JSON
   * inputSchema (`key:type description; …`). Makes argument names + their docs
   * searchable (lexical + embedding legs) and returnable by `tools:find`, so an
   * intent query can match on what a tool's PARAMETERS are, not just its name.
   * Null when the tool takes no args or the schema is absent.
   */
  argSchema?: string | null;
  /** The capability gate string (e.g. `tasks:read`), for built-ins. */
  capability?: string | null;
  /** Who provides it (the resolver's answer). */
  provider: {
    kind: 'builtin' | 'plugin' | 'pack';
    name: string;
    /** Cupboard listing id, when the provider is an installable listing. */
    listingId?: string | null;
  };
  /**
   * The providing distribution unit's descriptor surface (absent for
   * built-ins, which belong to no unit). Drives the UI's unit line +
   * install action.
   */
  unit?: {
    name: string;
    kind: 'plugin' | 'pack';
    source: 'installed' | 'cupboard';
    description?: string | null;
    version?: string | null;
    listingId?: string | null;
  };
}

/** One category facet: a namespace + how many matched tools fall under it. */
export interface CategoryFacet {
  name: string;
  count: number;
}

export interface ToolsDiscoveryPayload {
  tools: ToolDiscoveryEntry[];
  counts: { available: number; installable: number };
  /** Category facets over the searched/status-filtered set (pre category-filter). */
  categories: CategoryFacet[];
  /** False when the Cupboard fetch failed — the UI shows a degraded banner. */
  cupboardReachable: boolean;
}

export interface ToolsDiscoveryFilters {
  /** Capability search — relevance-ranks by name/category/capability/provider/description. */
  q?: string;
  /** Narrow to one resolution status. */
  status?: 'available' | 'installable';
  /** Narrow to one category (namespace). */
  category?: string;
}

/**
 * Per-tool capability text + gate, keyed by tool name. Built from the live
 * registries by `collectToolMeta()`; injected into the pure builders so they
 * stay unit-testable. Cupboard-only tools (names with no local registration)
 * are absent — they fall back to the providing unit's description.
 */
export type ToolMetaIndex = Map<
  string,
  { description?: string | null; capability?: string | null; argSchema?: string | null }
>;

/**
 * One level of a nested `object`-typed property's own `properties` — just the
 * field names (marking required-if-present ones), e.g. `{max_sec}` or
 * `{file,old_string,new_string?}`. Not recursive (one level is enough to name
 * the fields a caller needs; a deeper nest still falls back to bare `object`).
 * Empty/non-object nested schemas render nothing.
 */
function objectFieldsText(schema: { properties?: unknown; required?: unknown }): string {
  if (!schema.properties || typeof schema.properties !== 'object' || Array.isArray(schema.properties)) return '';
  const nestedRequired = new Set<string>(Array.isArray(schema.required) ? (schema.required as string[]) : []);
  const names = Object.keys(schema.properties as Record<string, unknown>).map(
    (n) => `${n}${nestedRequired.has(n) ? '' : '?'}`,
  );
  return names.join(',');
}

function nestedObjectFieldsText(p: {
  type?: unknown;
  properties?: unknown;
  required?: unknown;
  additionalProperties?: unknown;
}): string {
  if (p.type !== 'object') return '';
  const direct = objectFieldsText(p);
  if (direct) return `{${direct}}`;

  // z.record() advertises the entry schema under additionalProperties rather
  // than properties. Keep the map nature visible so callers do not mistake a
  // record of typed entries for a free-form object.
  if (
    p.additionalProperties &&
    typeof p.additionalProperties === 'object' &&
    !Array.isArray(p.additionalProperties)
  ) {
    const valueSchema = p.additionalProperties as { type?: unknown; properties?: unknown; required?: unknown };
    if (valueSchema.type === 'object') {
      const valueFields = objectFieldsText(valueSchema);
      if (valueFields) return `{*:object{${valueFields}}}`;
    }
  }
  return '';
}

/**
 * Render a caller-facing constraint declared on an array's primitive item
 * schema. JSON Schema nests these under `items`, so looking only at the array
 * node loses the constraint (for example plans:add-decision's `refs` pattern)
 * or the item shape itself (for example coord:send's string premises refs).
 */
export function arrayItemConstraintText(input: unknown): string {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return '';
  const node = input as { type?: unknown; items?: unknown };
  if (node.type !== 'array' || !node.items || typeof node.items !== 'object' || Array.isArray(node.items)) return '';
  const item = node.items as { type?: unknown; enum?: unknown; pattern?: unknown };
  const enumValues = Array.isArray(item.enum)
    ? item.enum.filter((v): v is string | number | boolean =>
        typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean',
      )
    : [];
  if (enumValues.length > 0) return `<enum(${enumValues.join('|')})>`;
  const pattern = typeof item.pattern === 'string' && item.pattern.length > 0 ? item.pattern : '';
  const itemType = typeof item.type === 'string' ? item.type : '';
  if (pattern) return `<${itemType || 'string'}~/${pattern}/>`;

  // A plain primitive item type is still caller-facing shape. Without it,
  // `premises: z.array(z.string())` was projected as only `array(≤20)`, and
  // callers could reasonably generalize the neighbouring object-shaped
  // section fields into `premises: [{ ref: ... }]` before the runtime refusal.
  // Keep object/array items represented by their nested-field projection (or
  // bare `array`) rather than adding a redundant `<object>`/`<array>` marker.
  return itemType && !['object', 'array'].includes(itemType) ? `<${itemType}>` : '';
}

/**
 * Render validator-owned call constraints from a JSON-Schema tree. These
 * annotations describe conditional rules that the schema shape cannot express
 * (for example, completion coverage becomes required only for universal
 * terminal claims), so keep them in both the searchable corpus and compact
 * discovery responses. Union branches retain their parent path; arrays append
 * `[]` before descending into their item schema.
 */
export function schemaCallConstraintAnnotation(
  inputSchema: unknown,
  options: { compact?: boolean } = {},
): string {
  const annotations = new Map<string, { path: string; constraint: string }>();
  const ancestors = new Set<object>();
  let inferredNestedUnion = false;
  const addAnnotation = (path: string, constraint: string): void => {
    const displayPath = path || '$';
    annotations.set(`${displayPath}\u0000${constraint}`, { path: displayPath, constraint });
  };
  const walk = (value: unknown, path: string): void => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || ancestors.has(value)) return;
    ancestors.add(value);
    const node = value as Record<string, unknown>;
    const constraint = node['x-papercusp-call-constraint'];
    if (typeof constraint === 'string' && constraint.trim()) {
      addAnnotation(path, constraint.trim());
    }
    for (const key of ['anyOf', 'oneOf']) {
      const branches = node[key];
      if (Array.isArray(branches)) {
        // Keep inference conservative: explicit validator-owned constraints are
        // authoritative and must not be crowded out by a second inferred layer.
        // For otherwise-unannotated tools, one bounded nested-union hint repairs
        // the lossy flattened view without flooding large contracts such as
        // work_items:complete with branch prose.
        if (path && !inferredNestedUnion && annotations.size === 0) {
          const objectBranches = branches.filter(
            (branch): branch is Record<string, unknown> =>
              !!branch && typeof branch === 'object' && !Array.isArray(branch),
          );
          const conditional = unionConditionalHint(objectBranches);
          if (conditional) {
            addAnnotation(path, conditional);
            inferredNestedUnion = true;
          }
        }
        for (const branch of branches) walk(branch, path);
      }
    }
    if (node.items) walk(node.items, `${path}[]`);
    const properties = node.properties;
    if (properties && typeof properties === 'object' && !Array.isArray(properties)) {
      for (const [name, child] of Object.entries(properties as Record<string, unknown>)) {
        walk(child, path ? `${path}.${name}` : name);
      }
    }
    ancestors.delete(value);
  };
  walk(inputSchema, '');
  const firstPathByConstraint = new Map<string, string>();
  return [...annotations.values()]
    .map(({ path, constraint }) => {
      const firstPath = firstPathByConstraint.get(constraint);
      firstPathByConstraint.set(constraint, firstPath ?? path);
      const full = `constraint:${path} (${constraint})`;
      const repeated = firstPath ? `constraint:${path} (same as constraint:${firstPath})` : '';
      // Compact discovery has a hard result budget. Repeating a validator rule
      // at an equivalent alias wastes that budget while hiding callable fields
      // later in the schema. Keep every path visible, but use the reference
      // whenever it is shorter than repeating the rule, regardless of length.
      return options.compact && repeated && repeated.length < full.length ? repeated : full;
    })
    .join('; ');
}

/**
 * A caller-facing alias relationship in a JSON-Schema projection.
 *
 * `properties` is a lossy view of the validator: two accepted spellings for
 * one logical value look like two unrelated optional fields. Keep the
 * relationship as a compact, path-aware annotation so discovery callers do
 * not confidently send both names. `path` is empty for the root object and
 * uses `[]` for an array item's object (for example `items[]`).
 */
export interface SchemaAliasGroup {
  path: string;
  fields: string[];
}

type AliasSchemaRecord = Record<string, unknown>;

const ALIAS_FIELD_METADATA_KEYS = [
  'x-papercusp-aliases',
  'x-aliases',
  'aliases',
  'aliasOf',
  'aliasFor',
] as const;
const ALIAS_GROUP_METADATA_KEYS = [
  'x-papercusp-alias-group',
  'x-papercusp-aliasGroup',
  'aliasGroup',
] as const;
const ALIAS_GROUPS_METADATA_KEYS = [
  'x-papercusp-alias-groups',
  'x-papercusp-aliasGroups',
  'aliasGroups',
] as const;
const ALIAS_FIELD_NAME = /^[A-Za-z_$][\w$.-]*$/;

function aliasSchemaRecord(value: unknown): AliasSchemaRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as AliasSchemaRecord) : null;
}

function aliasFieldName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  return ALIAS_FIELD_NAME.test(name) ? name : null;
}

function aliasFieldNames(value: unknown): string[] {
  const direct = aliasFieldName(value);
  if (direct) return [direct];
  if (Array.isArray(value)) return value.flatMap((entry) => aliasFieldNames(entry));
  const record = aliasSchemaRecord(value);
  if (!record) return [];
  for (const key of ['fields', 'members', 'aliases', 'keys', 'names', 'targets', 'fieldNames']) {
    const names = aliasFieldNames(record[key]);
    if (names.length > 0) return names;
  }
  return [];
}

function descriptionAliasTargets(description: unknown): string[] {
  if (typeof description !== 'string') return [];
  const targets: string[] = [];
  // Descriptions are the only metadata available for existing Zod schemas.
  // Keep these patterns deliberately narrow: a generic mention of "alias"
  // must not turn an unrelated pair of fields into a false contract hint.
  const patterns = [
    /\b(?:compatibility\s+)?alias(?:ed)?\s+(?:for|of)\s+[`'\"]?([A-Za-z_$][\w$.-]*)/gi,
    /\b(?:same|equivalent)\s+(?:logical\s+)?field\s+as\s+[`'\"]?([A-Za-z_$][\w$.-]*)/gi,
  ];
  for (const pattern of patterns) {
    for (const match of description.matchAll(pattern)) {
      // A negated comparison is a distinction, not an alias declaration.
      // Check the immediate prefix (including articles/Markdown), rather than
      // the whole description: a later affirmative declaration still counts.
      const prefix = description.slice(0, match.index).replace(/[`*_"]/g, '');
      if (/\b(?:not|never|no|isn['’]t|aren['’]t|wasn['’]t|weren['’]t)\s+(?:(?:an?|the|compatibility)\s+)*$/i.test(prefix)) {
        continue;
      }
      const name = aliasFieldName(match[1]);
      if (name) targets.push(name);
    }
  }
  return [...new Set(targets)];
}

function aliasTargetsForField(field: unknown): string[] {
  const record = aliasSchemaRecord(field);
  if (!record) return [];
  return [
    ...ALIAS_FIELD_METADATA_KEYS.flatMap((key) => aliasFieldNames(record[key])),
    ...descriptionAliasTargets(record.description),
  ];
}

function aliasGroupValues(record: AliasSchemaRecord): unknown[] {
  return ALIAS_GROUPS_METADATA_KEYS.flatMap((key) => {
    const value = record[key];
    return Array.isArray(value) ? value : value == null ? [] : [value];
  });
}

function localAliasName(name: string, declared: ReadonlySet<string>): string | null {
  if (declared.has(name)) return name;
  // Explicit metadata may use a dotted path for a field already scoped to this
  // object. Accept only its final segment; unrelated paths remain ignored.
  const tail = name.split('.').pop()?.replace(/\[\]$/, '');
  return tail && declared.has(tail) ? tail : null;
}

/** Add a field set, merging overlapping declarations transitively. */
function addAliasGroup(groups: Set<string>[], names: Iterable<string>, declared: ReadonlySet<string>): void {
  const local = [...new Set([...names].map((name) => localAliasName(name, declared)).filter((name): name is string => name != null))];
  if (local.length < 2) return;
  const overlapping = groups.filter((group) => local.some((name) => group.has(name)));
  const merged = new Set(local);
  for (const group of overlapping) {
    for (const name of group) merged.add(name);
  }
  for (const group of overlapping) groups.splice(groups.indexOf(group), 1);
  groups.push(merged);
}

function collectLocalAliasGroups(record: AliasSchemaRecord): string[][] {
  const properties = aliasSchemaRecord(record.properties);
  if (!properties) return [];
  const declared = new Set(Object.keys(properties));
  const declarationOrder = new Map(Object.keys(properties).map((name, index) => [name, index]));
  const groups: Set<string>[] = [];
  const namedGroups = new Map<string, Set<string>>();

  for (const [name, field] of Object.entries(properties)) {
    addAliasGroup(groups, [name, ...aliasTargetsForField(field)], declared);
    const fieldRecord = aliasSchemaRecord(field);
    for (const key of ALIAS_GROUP_METADATA_KEYS) {
      const value = fieldRecord?.[key];
      const names = aliasFieldNames(value).filter((candidate) => candidate !== value);
      if (names.length > 0) {
        addAliasGroup(groups, [name, ...names], declared);
      } else if (typeof value === 'string' && value.trim()) {
        const group = namedGroups.get(value.trim()) ?? new Set<string>();
        group.add(name);
        namedGroups.set(value.trim(), group);
      }
    }
  }

  for (const value of aliasGroupValues(record)) {
    addAliasGroup(groups, aliasFieldNames(value), declared);
  }
  for (const names of namedGroups.values()) addAliasGroup(groups, names, declared);

  return groups.map((group) =>
    [...group].sort((left, right) => (declarationOrder.get(left) ?? Number.MAX_SAFE_INTEGER) - (declarationOrder.get(right) ?? Number.MAX_SAFE_INTEGER)),
  );
}

/**
 * Find alias groups throughout a JSON-Schema tree, including union branches
 * and object schemas nested beneath `items`. The result is intentionally
 * independent of a renderer so the corpus text and compact result projection
 * share exactly one alias detector.
 */
export function schemaAliasGroups(inputSchema: unknown): SchemaAliasGroup[] {
  const found: SchemaAliasGroup[] = [];
  const seen = new Set<string>();
  const ancestors = new Set<object>();

  const add = (path: string, fields: string[]) => {
    const key = `${path}\u0000${fields.join('\u0000')}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ path, fields });
  };

  const walk = (value: unknown, path: string): void => {
    const record = aliasSchemaRecord(value);
    if (!record || ancestors.has(record)) return;
    ancestors.add(record);

    for (const fields of collectLocalAliasGroups(record)) add(path, fields);

    for (const key of ['anyOf', 'oneOf']) {
      const branches = record[key];
      if (Array.isArray(branches)) {
        for (const branch of branches) walk(branch, path);
      }
    }
    if (record.items && typeof record.items === 'object') {
      walk(record.items, `${path}[]`);
    }
    const properties = aliasSchemaRecord(record.properties);
    if (properties) {
      for (const [name, property] of Object.entries(properties)) {
        walk(property, path ? `${path}.${name}` : name);
      }
    }
    if (record.additionalProperties && typeof record.additionalProperties === 'object') {
      walk(record.additionalProperties, `${path}.*`);
    }
    ancestors.delete(record);
  };

  walk(inputSchema, '');
  return found;
}

/** Compact annotation used by both searchable and returned discovery schemas. */
export function schemaAliasAnnotation(inputSchema: unknown): string {
  return schemaAliasGroups(inputSchema)
    .map(({ path, fields }) => `alias-group:${path ? `${path}.` : ''}${fields.join('|')}`)
    .join('; ');
}

type NumericSchemaBound = { value: number; exclusive: boolean };

/**
 * Render numeric/length/item bounds without erasing JSON Schema exclusivity.
 * Draft-07+ uses a numeric `exclusiveMinimum`/`exclusiveMaximum`; draft-04
 * represents the same constraint as `minimum`/`maximum` plus a boolean
 * exclusive flag. Keep the established compact form for inclusive bounds and
 * add `>`/`<` only where the endpoint is genuinely exclusive.
 */
export function renderSchemaBounds(nodes: readonly unknown[]): string {
  const records = nodes.filter(
    (node): node is Record<string, unknown> => !!node && typeof node === 'object' && !Array.isArray(node),
  );
  const numberValue = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? value : null;
  const findBound = (
    inclusiveKey: 'minimum' | 'maximum',
    exclusiveKey: 'exclusiveMinimum' | 'exclusiveMaximum',
    fallbackKeys: readonly ('minLength' | 'maxLength' | 'minItems' | 'maxItems')[],
  ): NumericSchemaBound | null => {
    for (const node of records) {
      const exclusiveValue = numberValue(node[exclusiveKey]);
      if (exclusiveValue != null) return { value: exclusiveValue, exclusive: true };

      const inclusiveValue = numberValue(node[inclusiveKey]);
      if (inclusiveValue != null) {
        return { value: inclusiveValue, exclusive: node[exclusiveKey] === true };
      }

      for (const fallbackKey of fallbackKeys) {
        const fallbackValue = numberValue(node[fallbackKey]);
        if (fallbackValue != null) return { value: fallbackValue, exclusive: false };
      }
    }
    return null;
  };

  const lower = findBound('minimum', 'exclusiveMinimum', ['minLength', 'minItems']);
  const upper = findBound('maximum', 'exclusiveMaximum', ['maxLength', 'maxItems']);
  // Soft text caps are advisory metadata, not validation bounds. Keep them
  // distinct from the hard JSON Schema limit so discovery does not imply that
  // the larger backstop is the intended carry-row size.
  const softMaxLength =
    records
      .map((node) => numberValue(node['x-soft-maxLength']))
      .find((value): value is number => value !== null) ?? null;
  const lowerText = lower ? `${lower.exclusive ? '>' : ''}${lower.value}` : '';
  const upperText = upper ? `${upper.exclusive ? '<' : ''}${upper.value}` : '';

  const rendered = lower && upper
    ? `${lowerText}-${upperText}`
    : upper
      ? `${upper.exclusive ? '<' : '≤'}${upper.value}`
      : lower
        ? `${lower.exclusive ? '>' : '≥'}${lower.value}`
        : '';
  if (softMaxLength === null) return rendered;
  const softText = `soft cap ≤${softMaxLength}`;
  return rendered ? `${rendered} (${softText})` : softText;
}

function scalarSchemaValues(raw: unknown): Array<string | number | boolean | null> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const node = raw as { enum?: unknown; const?: unknown };
  if (Object.prototype.hasOwnProperty.call(node, 'const')) {
    const value = node.const;
    return value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
      ? [value]
      : null;
  }
  if (!Array.isArray(node.enum)) return null;
  const values = node.enum.filter(
    (value): value is string | number | boolean | null =>
      value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean',
  );
  return values.length === node.enum.length ? values : null;
}

/** Merge repeated scalar properties in a root union (usually a discriminator). */
export function mergeRepeatedPropertySchema(prior: unknown, next: unknown): unknown {
  const left = scalarSchemaValues(prior);
  const right = scalarSchemaValues(next);
  if (!left || !right) {
    // A root union repeats fields that are callable in one branch and
    // explicitly forbidden (`not: {}`) in the others. Keeping the first
    // forbidden schema loses the callable field's type and bounds from the
    // compact discovery projection (for example capability:read's
    // byte_limit max of 4096). Preserve the non-forbidden schema; the
    // unionConditionalHint still records which discriminator permits it.
    if (explicitlyForbiddenSchema(prior) && !explicitlyForbiddenSchema(next)) return next;
    if (!explicitlyForbiddenSchema(prior) && explicitlyForbiddenSchema(next)) return prior;
    return prior;
  }
  return { enum: [...new Set([...left, ...right])] };
}

/** Render each distinct set of branch-required keys once in union order. */
export function unionRequiredKeyHint(branches: readonly { required?: unknown }[]): string {
  const seen = new Set<string>();
  return branches
    .map((branch) =>
      Array.isArray(branch.required)
        ? branch.required.filter((value): value is string => typeof value === 'string')
        : [],
    )
    .filter((names) => names.length > 0)
    .filter((names) => {
      const key = [...names].sort().join('&');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((names) => names.join('&'))
    .join('|');
}

/** Keep conditional root-union guidance useful without allowing one schema to
 * consume the discovery response. A skipped hint is safer than a partial
 * condition that could teach an invalid value. */
export const UNION_CONDITIONAL_HINT_MAX_CHARS = 320;
const UNION_CONDITIONAL_HINT_MAX_VALUES = 8;
const UNION_CONDITIONAL_HINT_MAX_RELATIONS = 4;

type UnionSchemaBranch = {
  properties?: unknown;
  required?: unknown;
  additionalProperties?: unknown;
};
type UnionScalarValue = string | number | boolean | null;

function explicitlyForbiddenSchema(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const not = (raw as { not?: unknown }).not;
  return !!not && typeof not === 'object' && !Array.isArray(not) && Object.keys(not).length === 0;
}

function unionValueKey(value: UnionScalarValue): string {
  return `${typeof value}:${String(value)}`;
}

function unionValueText(value: UnionScalarValue): string {
  if (typeof value === 'string' && /^[A-Za-z0-9_.:-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

function unionConditionText(name: string, values: UnionScalarValue[], negate = false): string | null {
  if (values.length === 0) return null;
  if (values.length === 1) return `${name}${negate ? '!=' : '='}${unionValueText(values[0])}`;
  if (values.length > UNION_CONDITIONAL_HINT_MAX_VALUES) return null;
  return `${name}${negate ? ' not-in ' : ' in '}(${values.map(unionValueText).join('|')})`;
}

/**
 * Render explicit required/forbidden relationships in a root union.
 *
 * This deliberately needs a scalar discriminator in every branch and an
 * explicit target classification in every branch (`required`, optional,
 * `not:{}`, or omitted from a closed `additionalProperties:false` object).
 * Missing JSON-schema properties are forbidden only for a closed object:
 * omission may still be allowed by an open object schema. The result is
 * bounded and emits whole relations only, so a verbose or ambiguous union
 * fails open. Optional-vs-forbidden branches still emit the prohibition,
 * because that is the contract callers otherwise lose in the merged view.
 */
export function unionConditionalHint(branches: readonly UnionSchemaBranch[]): string {
  if (branches.length < 2) return '';
  const branchData = branches.map((branch) => {
    const properties =
      branch.properties && typeof branch.properties === 'object' && !Array.isArray(branch.properties)
        ? (branch.properties as Record<string, unknown>)
        : null;
    const required = new Set<string>(
      Array.isArray(branch.required) ? branch.required.filter((value): value is string => typeof value === 'string') : [],
    );
    return { properties, required, closed: branch.additionalProperties === false };
  });
  if (branchData.some((branch) => !branch.properties)) return '';

  const firstProperties = branchData[0].properties as Record<string, unknown>;
  const discriminatorNames = Object.keys(firstProperties).filter((name) =>
    branchData.every((branch) => {
      const values = scalarSchemaValues((branch.properties as Record<string, unknown>)[name]);
      return !!values && values.length > 0;
    }),
  );
  const targetNames = [...new Set(branchData.flatMap((branch) => Object.keys(branch.properties as Record<string, unknown>)))];
  const relations: string[] = [];

  for (const discriminator of discriminatorNames) {
    const discriminatorValues = branchData.map((branch) =>
      scalarSchemaValues((branch.properties as Record<string, unknown>)[discriminator])!,
    );
    const allValues = new Map<string, UnionScalarValue>();
    for (const values of discriminatorValues) {
      for (const value of values) allValues.set(unionValueKey(value), value);
    }
    if (allValues.size < 2) continue;

    const relationGroups = new Map<
      string,
      {
        targets: string[];
        requiredCondition: string | null;
        forbiddenCondition: string;
      }
    >();

    for (const target of targetNames) {
      if (target === discriminator) continue;
      const statuses = new Map<string, 'required' | 'optional' | 'forbidden'>();
      const requiredValues = new Map<string, UnionScalarValue>();
      const optionalValues = new Map<string, UnionScalarValue>();
      const forbiddenValues = new Map<string, UnionScalarValue>();
      let valid = true;

      branchData.forEach((branch, index) => {
        const properties = branch.properties as Record<string, unknown>;
        const present = Object.prototype.hasOwnProperty.call(properties, target);
        const status = branch.required.has(target)
          ? 'required'
          : explicitlyForbiddenSchema(properties[target]) ||
              (branch.closed && !present)
            ? 'forbidden'
            : 'optional';
        if (!status) {
          valid = false;
          return;
        }
        for (const value of discriminatorValues[index]) {
          const key = unionValueKey(value);
          const prior = statuses.get(key);
          if (prior && prior !== status) {
            valid = false;
            return;
          }
          statuses.set(key, status);
          (status === 'required' ? requiredValues : status === 'forbidden' ? forbiddenValues : optionalValues).set(key, value);
        }
      });

      if (!valid || statuses.size !== allValues.size || forbiddenValues.size === 0) continue;

      let requiredCondition: string | null = null;
      let forbiddenCondition: string | null = null;

      // Preserve the established two-sided form when every branch is either
      // required or forbidden. It is more informative than a one-sided
      // prohibition and keeps the existing compact contract stable.
      if (requiredValues.size > 0 && optionalValues.size === 0) {
        const requiredList = [...requiredValues.values()];
        const forbiddenList = [...forbiddenValues.values()];
        requiredCondition =
          requiredList.length === 1 && forbiddenList.length > 0
            ? unionConditionText(discriminator, requiredList)
            : forbiddenList.length === 1 && requiredList.length > 0
              ? unionConditionText(discriminator, forbiddenList, true)
              : unionConditionText(discriminator, requiredList);
        forbiddenCondition =
          requiredList.length === 1 && forbiddenList.length > 0
            ? unionConditionText(discriminator, requiredList, true)
            : forbiddenList.length === 1 && requiredList.length > 0
              ? unionConditionText(discriminator, forbiddenList)
              : unionConditionText(discriminator, forbiddenList);
        if (!requiredCondition || !forbiddenCondition) continue;
      } else {
        forbiddenCondition = unionConditionText(discriminator, [...forbiddenValues.values()]);
        if (!forbiddenCondition) continue;
      }

      // Group fields with the same branch-status vector before the compact
      // character cap. Otherwise a single discriminator with several parallel
      // fields can silently lose its later constraints (for example, owner-turn
      // `quote` after `turnRef`) even though the shared rule text is identical.
      const signature = JSON.stringify({
        required: [...requiredValues.keys()].sort(),
        optional: [...optionalValues.keys()].sort(),
        forbidden: [...forbiddenValues.keys()].sort(),
      });
      const group = relationGroups.get(signature);
      if (group) group.targets.push(target);
      else relationGroups.set(signature, { targets: [target], requiredCondition, forbiddenCondition });
    }

    for (const group of relationGroups.values()) {
      const targets = group.targets.join(',');
      const relation = group.requiredCondition
        ? `when ${group.requiredCondition} => ${targets} required; when ${group.forbiddenCondition} => ${targets} forbidden`
        : `when ${group.forbiddenCondition} => ${targets} forbidden`;
      const candidate = relations.length > 0 ? `${relations.join('; ')}; ${relation}` : relation;
      if (candidate.length > UNION_CONDITIONAL_HINT_MAX_CHARS) continue;
      relations.push(relation);
      if (relations.length >= UNION_CONDITIONAL_HINT_MAX_RELATIONS) return relations.join('; ');
    }
  }
  return relations.join('; ');
}

/**
 * Render a tool's JSON inputSchema into one compact searchable/embeddable line:
 * `key:type description; otherKey?:enum …` (a `?` marks an optional property).
 * Pulls only the model-facing surface — property names, their `type` (or `enum`),
 * and their `description` — so the arg vocabulary feeds both search legs without
 * dragging the raw JSON Schema into the corpus. Null for a no-arg / absent /
 * non-object schema.
 *
 * EI-13190: an `object`-typed property (e.g. `wait: { max_sec }`) used to render
 * as bare `wait?:object` — the nested REQUIRED field name (`max_sec`) was
 * invisible until a call guessing a different name (`timeout_ms`) was rejected,
 * and only the rejection error revealed the real name. Every such property now
 * also gets its one-level nested field-name list appended, e.g. `wait?:object{max_sec}`,
 * so the required nested shape is visible at discovery time, not just on retry.
 */
export function schemaToText(inputSchema: unknown): string | null {
  if (!inputSchema || typeof inputSchema !== 'object') return null;
  const root = inputSchema as Record<string, unknown>;
  const directProps = root.properties;
  const rawBranches = Array.isArray(root.anyOf)
    ? root.anyOf
    : Array.isArray(root.oneOf)
      ? root.oneOf
      : [];
  const branches = (directProps && typeof directProps === 'object' && !Array.isArray(directProps)
    ? [root]
    : rawBranches
  ).filter((branch): branch is Record<string, unknown> => !!branch && typeof branch === 'object' && !Array.isArray(branch));
  if (branches.length === 0) return null;

  // A raw union can require different top-level keys in each branch. Merge
  // the fields for searchable text, but mark a field required only when it is
  // present and required in every branch. The branch-required names remain in
  // the prefix so callers can see the OR constraint instead of inferring that
  // the flattened optional view is the whole contract.
  const merged = new Map<string, { raw: unknown; presentIn: number; requiredInAll: boolean }>();
  for (const branch of branches) {
    const props = branch.properties;
    if (!props || typeof props !== 'object' || Array.isArray(props)) continue;
    const requiredRaw = branch.required;
    const required = new Set<string>(Array.isArray(requiredRaw) ? requiredRaw.filter((v): v is string => typeof v === 'string') : []);
    for (const [name, raw] of Object.entries(props as Record<string, unknown>)) {
      const prior = merged.get(name);
      if (prior) {
        prior.presentIn += 1;
        prior.requiredInAll = prior.requiredInAll && required.has(name);
        // A discriminated union repeats the discriminator in every branch with
        // a different literal. Keep every accepted operation visible in the
        // searchable schema instead of retaining only the first branch.
        prior.raw = mergeRepeatedPropertySchema(prior.raw, raw);
      } else {
        merged.set(name, { raw, presentIn: 1, requiredInAll: required.has(name) });
      }
    }
  }
  if (merged.size === 0) return null;

  const unionHint = branches.length > 1 ? unionRequiredKeyHint(branches) : '';
  const conditionalHint = branches.length > 1 ? unionConditionalHint(branches) : '';
  const aliasHint = schemaAliasAnnotation(inputSchema);
  const callConstraintHint = schemaCallConstraintAnnotation(inputSchema);
  const parts: string[] = [];
  for (const [name, entry] of merged) {
    const raw = entry.raw;
    const p = (raw && typeof raw === 'object' ? raw : {}) as {
      description?: unknown;
      type?: unknown;
      enum?: unknown;
      const?: unknown;
      properties?: unknown;
      required?: unknown;
      minimum?: unknown;
      maximum?: unknown;
      exclusiveMinimum?: unknown;
      exclusiveMaximum?: unknown;
      minLength?: unknown;
      maxLength?: unknown;
      minItems?: unknown;
      maxItems?: unknown;
      items?: unknown;
      pattern?: unknown;
    };
    // EI-13164: an `enum` property's JSON-schema output ALSO carries `type:"string"`
    // (zod's own toJSONSchema emits both for `z.enum([...])`, confirmed for
    // `severity: z.enum(['critical','major','minor','nit'])` → `{ type:"string",
    // enum:[...] }`) — so the `type` branch below fired first and the enum branch
    // was DEAD CODE for every real zod enum, silently downgrading the discovered
    // shape to a bare `:string`. A caller then had no way to learn the allowed
    // values short of a rejected write (tools:find showed `severity?:string`;
    // passing a plausible-but-wrong value like "low" surfaced the real
    // critical|major|minor|nit set only in the runtime error). Check enum FIRST,
    // and render its actual member values (not just the word "enum") — strictly
    // more informative than either the old enum-only or type-only text.
    const enumValues = Array.isArray(p.enum)
      ? (p.enum as unknown[]).filter((v): v is string | number | boolean | null =>
          v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean',
        )
      : Object.prototype.hasOwnProperty.call(p, 'const') &&
          (p.const === null ||
            typeof p.const === 'string' ||
            typeof p.const === 'number' ||
            typeof p.const === 'boolean')
        ? [p.const]
        : null;
    const type =
      enumValues && enumValues.length > 0
        ? `enum(${enumValues.join('|')})`
        : typeof p.type === 'string'
          ? p.type
          : '';
    // EI-13181: same lossy-discovery bug class as EI-13164/EI-13176, but for a
    // number/string/array BOUND instead of an enum — `z.number().max(100)` etc.
    // renders its JSON-schema `maximum`/`minimum`/`*Length`/`*Items` right next
    // to `type`, but schemaToText only ever read `type`, so a caller learned
    // `limit?:integer` with no hint that >100 is rejected until the call
    // failed. Render the bound inline (e.g. `integer(1-100)`, `string(≤400)`,
    // `array(≤20)`) whenever the schema declares one — strictly additive, never
    // fires for a property with no bound. Preserve exclusive endpoints as
    // `>N`/`<N`; otherwise a caller may be taught to pass an invalid boundary.
    const bound = renderSchemaBounds([p]);
    // EI-13183: same lossy-discovery bug class as EI-13181/13164, but for a
    // `.regex()` constraint — `z.string().regex(/^[0-9a-f]{40,64}$/)` (e.g.
    // locks:release's published_sha) emits JSON-schema `pattern` right next to
    // `type`, invisible to schemaToText until now. A caller passed a plausible
    // abbreviated git SHA and only learned the real 40–64 hex-char requirement
    // from the rejection. Render the pattern inline whenever present — strictly
    // additive; never fires for a property with no `.regex()`.
    const pattern = typeof p.pattern === 'string' && p.pattern.length > 0 ? p.pattern : '';
    const nested = nestedObjectFieldsText(p);
    const desc = typeof p.description === 'string' ? p.description.trim() : '';
    // Never double up with the enum text (already shows its own values) — a
    // bound/pattern is meaningless for an enum anyway (zod never emits either
    // alongside one).
    const isEnum = !!(enumValues && enumValues.length > 0);
    const boundText = bound && !isEnum ? `(${bound})` : '';
    const patternText = pattern && !isEnum ? `~/${pattern}/` : '';
    // EI-20250807342723221: an array's item enum is part of the caller-facing
    // contract too. JSON Schema places it under `items`, so checking only the
    // property itself turns `states: z.array(z.enum(['open', 'failing']))`
    // into a misleading bare `array` and hides the only accepted values.
    const itemText = arrayItemConstraintText(p);
    const required = entry.presentIn === branches.length && entry.requiredInAll;
    const head = `${name}${required ? '' : '?'}${type ? `:${type}${boundText}${patternText}${nested}` : ''}`;
    const rendered = `${head}${itemText}`;
    parts.push(desc ? `${rendered} ${desc}` : rendered);
  }
  return parts.length > 0
    ? `${callConstraintHint ? `${callConstraintHint}; ` : ''}${unionHint ? `one-of:${unionHint}; ` : ''}${conditionalHint ? `${conditionalHint}; ` : ''}${aliasHint ? `${aliasHint}; ` : ''}${parts.join('; ')}`
    : null;
}

function unitOf(pack: PackDescriptor): ToolDiscoveryEntry['unit'] {
  return {
    name: pack.name,
    kind: pack.kind,
    source: pack.source,
    description: pack.description ?? null,
    version: pack.version ?? null,
    listingId: pack.listingId ?? null,
  };
}

/**
 * Resolve every tool name the catalog knows into an enriched
 * `ToolDiscoveryEntry` (provider + category + description + capability). No
 * filtering or sorting — the shared substrate for both the Tools view
 * (`buildToolsDiscovery`) and the "what provides X" surface
 * (`buildToolProvenance`).
 */
export function resolveToolEntries(
  cat: DerivedPackCatalog,
  meta?: ToolMetaIndex,
): ToolDiscoveryEntry[] {
  const names = new Set<string>(cat.builtinTools);
  for (const t of cat.view.installedToolIndex.keys()) names.add(t);
  for (const t of cat.view.cupboardToolIndex.keys()) names.add(t);

  const entries: ToolDiscoveryEntry[] = [];
  for (const tool of names) {
    const res = resolveToolProvider(tool, cat.view);
    if (res.status === 'unknown') continue; // unreachable: names come from the view
    const entry: ToolDiscoveryEntry = {
      tool,
      status: res.status,
      category: categoryOf(tool),
      provider: { ...res.provider },
    };
    if (res.provider.kind !== 'builtin') {
      const pack = cat.view.byName.get(res.provider.name);
      if (pack) entry.unit = unitOf(pack);
    }
    const m = meta?.get(tool);
    entry.description = m?.description ?? entry.unit?.description ?? null;
    entry.capability = m?.capability ?? null;
    entry.argSchema = m?.argSchema ?? null;
    entries.push(entry);
  }
  return entries;
}

/**
 * Every tool the catalog knows, resolved → status-filtered → capability-ranked
 * (when `q` is set) or name-sorted (browse) → category-faceted →
 * category-filtered. The facets are computed over the searched/status-filtered
 * set *before* the category narrow, so a UI can switch categories within the
 * current search.
 */
export function buildToolsDiscovery(
  cat: DerivedPackCatalog,
  filters: ToolsDiscoveryFilters = {},
  meta?: ToolMetaIndex,
): ToolsDiscoveryPayload {
  let entries = resolveToolEntries(cat, meta);
  if (filters.status) entries = entries.filter((e) => e.status === filters.status);

  // Capability search ranks; an absent query is the neutral name-sorted browse.
  const q = filters.q?.trim();
  entries = q ? searchTools(entries, q) : entries.sort((a, b) => a.tool.localeCompare(b.tool));

  // Facets over the searched/status set, pre category-filter.
  const facetCounts = new Map<string, number>();
  for (const e of entries) facetCounts.set(e.category, (facetCounts.get(e.category) ?? 0) + 1);
  const categories: CategoryFacet[] = [...facetCounts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  if (filters.category) {
    const want = filters.category.toLowerCase();
    entries = entries.filter((e) => e.category === want);
  }

  let available = 0;
  let installable = 0;
  for (const e of entries) {
    if (e.status === 'available') available += 1;
    else installable += 1;
  }

  return { tools: entries, counts: { available, installable }, categories, cupboardReachable: cat.cupboardReachable };
}

/** "What provides X" — the human-facing inverse of the dep resolver (P-006). */
export interface ToolProvenancePayload {
  /** The query that was resolved (the `tool` name or the `q` capability phrase). */
  query: string;
  /**
   * Exact-name resolution: the entry whose tool name == `tool`, if known.
   * `null` for a capability (`q`) query or an unknown name.
   */
  resolved: ToolDiscoveryEntry | null;
  /**
   * Ranked candidate providers (capability search). Each installable match
   * carries `provider.listingId` + `unit` — that *is* the install action. The
   * exact resolution, when present, always leads.
   */
  matches: ToolDiscoveryEntry[];
  cupboardReachable: boolean;
}

/**
 * Given a tool name (`tool`, exact) or a capability phrase (`q`), return the
 * providing unit(s) + install action — the inverse of the dependency resolver
 * (it asks "what installs this declared tool?"; this asks "I want capability
 * X, what provides it?"). `tool` takes precedence; `q` is the fallback query.
 */
export function buildToolProvenance(
  cat: DerivedPackCatalog,
  opts: { tool?: string; q?: string },
  meta?: ToolMetaIndex,
): ToolProvenancePayload {
  const entries = resolveToolEntries(cat, meta);
  const query = (opts.tool ?? opts.q ?? '').trim();
  const resolved = opts.tool ? entries.find((e) => e.tool === opts.tool) ?? null : null;
  const ranked = searchTools(entries, query);
  const matches = resolved
    ? [resolved, ...ranked.filter((e) => e.tool !== resolved.tool)]
    : ranked;
  return { query, resolved, matches, cupboardReachable: cat.cupboardReachable };
}

/**
 * Build the per-tool capability index from the LIVE registries: the legacy
 * catalog (`getCatalog()` — built-ins, with description + capability gate) and
 * the projected-tool registry (`listAllProjectedTools()` — adds installed
 * plugin/pack tools, description only). Built-ins win on name collision (they
 * carry the capability gate). Not pure — the route calls this and injects the
 * result into the pure builders above.
 */
export function collectToolMeta(): ToolMetaIndex {
  const meta: ToolMetaIndex = new Map();
  for (const t of getCatalog()) {
    meta.set(t.name, { description: t.description ?? null, capability: t.capability ?? null });
  }
  // The projected mirror carries the ready-made JSON `inputSchema` (the legacy
  // catalog only holds the un-rendered zod validator), so arg-schema text is
  // sourced here — ENRICHING the built-in entries above with their `argSchema`
  // AND adding projected-only (installed plugin) tools.
  for (const t of listAllProjectedTools()) {
    const name = t.expose?.mcp?.name;
    if (typeof name !== 'string' || name.length === 0) continue;
    const argSchema = schemaToText(t.inputSchema);
    const existing = meta.get(name);
    if (existing) existing.argSchema = argSchema; // built-in: keep its capability gate
    else meta.set(name, { description: t.description ?? null, capability: null, argSchema });
  }
  return meta;
}
