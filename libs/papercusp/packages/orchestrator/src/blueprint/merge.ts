/**
 * The MERGE_RULES-driven merger — `identities-v1-2026-08-30` P-019, revised by
 * P-039 / D-029. `resolveLayers` composes an `extends` stack with `mergeByRules`;
 * the per-leaf algebra it applies is DECLARED in `merge-rules.ts`, never
 * hardcoded here.
 *
 * HOW A DOCUMENT IS WALKED. `BlueprintSchema` is a tree of OBJECT nodes whose
 * leaves are the merge-units `enumerateBlueprintLeaves` lists (a scalar, a whole
 * array, a whole record, a union, a lazy schema, or an object's catchall keys).
 * The merger descends every INTERIOR node (`schemaInteriorPaths` — each proper
 * prefix of a leaf path) field by field, and at a LEAF applies `mergeRuleFor(path)`:
 *
 *   - `explicit-replacement` — the child's whole value when it sets the key; an
 *                          absent child key inherits. An opaque catchall is replaced,
 *                          never guessed at below the schema boundary.
 *   - `set-union`        — structural array values accumulate and deduplicate;
 *                          unequal values never overwrite one another.
 *   - `keyed-overlay`    — records overlay by key; keyed arrays retain every key
 *                          and deep-merge a restatement's fields. Value precedence
 *                          is intentionally ordered and therefore not commutative.
 *   - `constraint-intersection` — equal values agree; numeric upper bounds take
 *                          the minimum. Non-comparable values fail closed with the
 *                          path, merge phase, and contributing sources.
 *   - `hard-conflict`    — the document retains keyed slot declarations, while
 *                          `resolveBlueprint` rejects distinct exclusive claimants
 *                          using the source layers whose identity the merged value
 *                          no longer carries.
 *
 * A key the registry does not govern at all — outside `BlueprintSchema`, which
 * strips it at parse — composes by `mergeRaw`, exactly as before.
 *
 * THE STACK WALK IS UNCHANGED (P-019 changes the algebra, not the graph): parents
 * are resolved depth-first and merged pairwise in `extends` order, the child last.
 * `mergeRaw` (last-writer-wins) is not associative when an intermediate layer sets
 * a scalar over an object a later layer sets again, so the golden test compares the
 * rule-driven walk against a `mergeRaw` walk of the SAME shape, not a flat fold.
 */
import { mergeRuleFor, enumerateBlueprintLeaves, type MergeRule } from './merge-rules.js';

/** A raw, pre-parse blueprint object (straight off disk, or an already-merged subtree). */
export type RawDocument = Record<string, unknown>;

export interface MergeContext {
  mode?: 'inheritance' | 'peer-assembly';
  baseSources?: readonly string[];
  childSources?: readonly string[];
}

export class MergeConflictError extends Error {
  constructor(
    readonly path: string,
    readonly rule: MergeRule['rule'],
    readonly base: unknown,
    readonly child: unknown,
    readonly context: MergeContext = {},
  ) {
    const sources = [...(context.baseSources ?? []), ...(context.childSources ?? [])];
    super(
      `merge conflict at "${path}" under ${rule}${context.mode ? ` during ${context.mode}` : ''}${sources.length ? ` (sources: ${sources.join(', ')})` : ''}: ${stableStringify(base)} versus ${stableStringify(child)}`,
    );
    this.name = 'MergeConflictError';
  }
}

export function isPlainObject(v: unknown): v is RawDocument {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Sorted-key JSON — the structural identity of a value (order-independent for objects). */
export function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (isPlainObject(v)) {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

/**
 * Last-writer-wins deep-merge: plain objects merge recursively; arrays and scalars
 * are replaced by the child's value. Pure. This was the WHOLE algebra before P-019;
 * it survives as (a) the value overlay within a record or colliding keyed-array
 * element, (b) the rule for a key outside the schema, and (c) the reference the
 * golden test compares the rule-driven merger against.
 */
export function mergeRaw(base: RawDocument, child: RawDocument): RawDocument {
  const out: RawDocument = { ...base };
  for (const [k, cv] of Object.entries(child)) {
    const bv = out[k];
    out[k] = isPlainObject(bv) && isPlainObject(cv) ? mergeRaw(bv, cv) : cv;
  }
  return out;
}

let interiorCache: ReadonlySet<string> | null = null;

/**
 * The OBJECT nodes of `BlueprintSchema` — every proper prefix of a leaf path
 * (`knobs`, `knobs.promotion`, `knobs.promotion.smokeBuild`, …). The merger
 * descends these; everything else is a leaf governed by `mergeRuleFor`. Derived
 * from the same enumeration `MERGE_RULES` is asserted exhaustive over, so a new
 * object field descends without any registration here.
 */
export function schemaInteriorPaths(): ReadonlySet<string> {
  if (!interiorCache) {
    const set = new Set<string>();
    for (const { path } of enumerateBlueprintLeaves()) {
      const segs = path.split('.');
      for (let i = 1; i < segs.length; i++) set.add(segs.slice(0, i).join('.'));
    }
    interiorCache = set;
  }
  return interiorCache;
}

function elementIdentity(el: unknown, key: MergeRule['key']): string {
  if (key && isPlainObject(el)) {
    const fields = typeof key === 'string' ? [key] : key;
    const parts = fields.map((f) => el[f]);
    if (parts.every((p) => p !== undefined)) return `k:${JSON.stringify(parts)}`;
  }
  return `v:${stableStringify(el)}`;
}

/**
 * Keyed overlay of two arrays. Identity is `key` (a field or tuple of fields on a
 * plain object element), with structural value as the fallback. Base order comes
 * first; a child element whose identity already exists deep-merges into that
 * position (child fields win), while new elements append in child order. The key
 * population is commutative; colliding values deliberately are not.
 */
export function keyedOverlayArrays(
  base: readonly unknown[],
  child: readonly unknown[],
  key: MergeRule['key'],
): unknown[] {
  const out: unknown[] = [];
  const at = new Map<string, number>();
  for (const el of [...base, ...child]) {
    const id = elementIdentity(el, key);
    const i = at.get(id);
    if (i === undefined) {
      at.set(id, out.length);
      out.push(el);
    } else {
      const prev = out[i];
      out[i] = isPlainObject(prev) && isPlainObject(el) ? mergeRaw(prev, el) : el;
    }
  }
  return out;
}

/** Structural set union: equal values dedupe, unequal values never overwrite one another. */
export function setUnionArrays(base: readonly unknown[], child: readonly unknown[]): unknown[] {
  const out: unknown[] = [];
  const seen = new Set<string>();
  for (const value of [...base, ...child]) {
    const identity = stableStringify(value);
    if (seen.has(identity)) continue;
    seen.add(identity);
    out.push(value);
  }
  return out;
}

/** Intersect two upper-bound constraints. Unequal non-numeric values fail closed. */
export function intersectConstraint(
  base: unknown,
  child: unknown,
  path = '<unknown>',
  context: MergeContext = {},
): unknown {
  if (typeof base === 'number' && typeof child === 'number') return Math.min(base, child);
  if (stableStringify(base) === stableStringify(child)) return base;
  throw new MergeConflictError(path, 'constraint-intersection', base, child, context);
}

/**
 * Apply ONE leaf's rule to a base value and a child value. `undefined` on either
 * side short-circuits to the child (an absent base has nothing to compose with;
 * an explicitly-undefined child key is carried as `mergeRaw` carries it).
 */
export function applyMergeRule(
  rule: MergeRule,
  base: unknown,
  child: unknown,
  path = '<unknown>',
  context: MergeContext = {},
): unknown {
  if (base === undefined || child === undefined) return child;
  switch (rule.rule) {
    case 'explicit-replacement':
      return child;
    case 'constraint-intersection':
      return intersectConstraint(base, child, path, context);
    case 'set-union':
      if (Array.isArray(base) && Array.isArray(child)) return setUnionArrays(base, child);
      throw new MergeConflictError(path, rule.rule, base, child, context);
    case 'keyed-overlay':
      if (Array.isArray(base) && Array.isArray(child)) return keyedOverlayArrays(base, child, rule.key);
      if (isPlainObject(base) && isPlainObject(child)) return mergeRaw(base, child);
      return child;
    case 'hard-conflict':
      if (Array.isArray(base) && Array.isArray(child)) return keyedOverlayArrays(base, child, rule.key);
      if (stableStringify(base) === stableStringify(child)) return base;
      throw new MergeConflictError(path, rule.rule, base, child, context);
  }
}

function mergeNode(
  base: RawDocument,
  child: RawDocument,
  path: string,
  interior: ReadonlySet<string>,
  context: MergeContext,
): RawDocument {
  const out: RawDocument = { ...base };
  for (const [k, cv] of Object.entries(child)) {
    const p = path ? `${path}.${k}` : k;
    const bv = out[k];
    if (interior.has(p)) {
      // An object node of the schema: descend field by field. A non-object on either
      // side (a child's `retired: null`, say) cannot be descended — the child's value
      // replaces, as it always has.
      out[k] = isPlainObject(bv) && isPlainObject(cv) ? mergeNode(bv, cv, p, interior, context) : cv;
      continue;
    }
    const rule = mergeRuleFor(p);
    out[k] = rule
      ? applyMergeRule(rule, bv, cv, p, context)
      : isPlainObject(bv) && isPlainObject(cv)
        ? mergeRaw(bv, cv)
        : cv;
  }
  return out;
}

/**
 * Merge `child` over `base` under the declared `MERGE_RULES`. Pure (a new object;
 * neither input is mutated). The loader calls this pairwise along the `extends`
 * walk; `mergeByRules(doc, {})` and `mergeByRules({}, doc)` are both `doc`.
 */
export function mergeByRules(base: RawDocument, child: RawDocument, context: MergeContext = {}): RawDocument {
  return mergeNode(base, child, '', schemaInteriorPaths(), context);
}
