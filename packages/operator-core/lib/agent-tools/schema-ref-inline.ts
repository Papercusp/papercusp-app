/**
 * schema-ref-inline.ts — resolve `$ref`/`$defs` pointers for BOUNDED SCHEMA
 * RENDERERS.
 *
 * Discovery and recovery schemas publish shared sub-objects through `$defs`
 * and point at them with `$ref` (work_items:complete's completion record,
 * coord:send's body, watch:create, events:await, triggers:bind,
 * design-phase.*). The bounded renderers — `schemaToText`,
 * `compactSchemaForResult` in agent-tools/tools/find.ts, and the orient task
 * schema pack — do not follow a JSON pointer, so an unresolved `$ref` renders
 * as a BARE field name with no shape, and any renderer that inspects a
 * property's `description` sees nothing at all.
 *
 * That is a wrong answer that looks like a complete one. Two measured
 * instances of the same root cause:
 *   - `tools:find` silently stopped advertising `completion.verification.coverage`,
 *     `completion.rootCauseVerification` and `body[].premises`.
 *   - the orient task schema pack fell back to `completion?:object structured
 *     record`, dropping the conditional root-cause contract a recovery caller
 *     needs to form a valid bug close.
 *
 * Inline the pointers ONCE at each renderer's corpus boundary so every
 * downstream renderer keeps seeing the same structural shape it saw before.
 *
 * ⚠ This is for DISCOVERY/PREVIEW projections ONLY. The wire `inputSchema`
 * that the byte-budget guards measure is a different object and is
 * deliberately left referenced — `$defs` exists precisely so a duplicated
 * sub-schema does not blow those budgets. Inlining there would trade one red
 * for three.
 */

const MAX_SCHEMA_REF_INLINE_DEPTH = 12;

function resolveSchemaPointer(root: Record<string, unknown>, pointer: string): unknown {
  if (!pointer.startsWith('#/')) return undefined;
  let node: unknown = root;
  for (const rawSegment of pointer.slice(2).split('/')) {
    if (!node || typeof node !== 'object') return undefined;
    const segment = rawSegment.replace(/~1/g, '/').replace(/~0/g, '~');
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
}

function inlineSchemaRefs(
  value: unknown,
  root: Record<string, unknown>,
  open: ReadonlySet<string>,
  depth: number,
): unknown {
  if (Array.isArray(value)) return value.map((entry) => inlineSchemaRefs(entry, root, open, depth));
  if (!value || typeof value !== 'object') return value;
  const node = value as Record<string, unknown>;
  const ref = typeof node.$ref === 'string' ? node.$ref : null;
  if (ref) {
    const { $ref: _pointer, ...siblings } = node;
    // A definition already open on this path is genuinely recursive (the
    // completion record is); expanding it again never terminates. Collapse to
    // the sibling keywords so the FIELD NAME and its enclosing shape stay
    // visible, which is what the bounded renderers need.
    if (open.has(ref) || depth >= MAX_SCHEMA_REF_INLINE_DEPTH) return siblings;
    const target = resolveSchemaPointer(root, ref);
    if (target && typeof target === 'object') {
      const nextOpen = new Set(open);
      nextOpen.add(ref);
      const expanded = inlineSchemaRefs(target, root, nextOpen, depth + 1) as Record<string, unknown>;
      // Sibling keywords ($ref alongside description/default) win over the
      // referenced definition, per JSON Schema 2020-12.
      return { ...expanded, ...siblings };
    }
    return siblings;
  }
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(node)) {
    // `$defs` itself is the definition table, not a schema position; leaving it
    // unexpanded keeps the inlined root from carrying a second full copy.
    out[key] = key === '$defs' || key === 'definitions' ? entry : inlineSchemaRefs(entry, root, open, depth);
  }
  return out;
}

/**
 * Return `schema` with every internal `$ref` resolved in place and the `$defs`
 * table dropped. A schema with no definition table is returned unchanged, so
 * this is safe to apply unconditionally at a renderer boundary.
 */
export function withInlinedSchemaRefs(schema: unknown): unknown {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return schema;
  const root = schema as Record<string, unknown>;
  if (!root.$defs && !root.definitions) return schema;
  const inlined = inlineSchemaRefs(root, root, new Set<string>(), 0) as Record<string, unknown>;
  const { $defs: _defs, definitions: _definitions, ...rest } = inlined;
  return rest;
}
