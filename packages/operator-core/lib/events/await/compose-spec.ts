/**
 * Composed event awaits — the SPEC layer (composable-event-awaits-2026-07-11 P-003).
 *
 * A composed await waits on a THRESHOLD TREE of event occurrences: wake when ANY
 * of a set fire, ALL fire, or k-of-n fire — nested. The spec grammar reuses the
 * @papercusp/rules `dataConditionSchema` combinators (`all` / `any` / the new
 * `some:{require,of}` from P-001) — ONE combinator grammar in the system (D-001) —
 * whose LEAVES are event occurrences `{ event: '<key|glob|@macro>', when?: <cond> }`
 * rather than match-map path tests. `any` ≡ require:1, `all` ≡ require:n.
 *
 * This module is PURE (no I/O): grammar types, classification, validation (the
 * D-003 caps + the no-`not` rule), and the in-process birth computation that drives
 * latch-seeding / born-satisfied short-circuit (D-004). The store + fire engine
 * (compose-store.ts, engine.ts) build on it. Being I/O-free it is unit-testable
 * without a database — the P-003 recurrence guard.
 */

import { expandPatternMacro, isPattern, assertUsablePattern } from './pattern';
import { isPlainObject, type DataCondition } from '@papercusp/rules';

/** A leaf: one event occurrence, optionally payload-filtered by a rules DataCondition. */
export interface ComposedLeafSpec {
  event: string;
  when?: DataCondition;
}
export interface AllSpec {
  all: ComposedSpec[];
}
export interface AnySpec {
  any: ComposedSpec[];
}
export interface SomeSpec {
  some: { require: number; of: ComposedSpec[] };
}
/** The recursive composed-await spec: a leaf, or an all/any/some combinator of specs. */
export type ComposedSpec = ComposedLeafSpec | AllSpec | AnySpec | SomeSpec;

/** D-003 caps: depth ≤ 3 (root → interior → leaves), ≤ 20 leaves. Keep every firing
 *  decision local + a tree small enough to render + reason about. */
export const MAX_TREE_DEPTH = 3;
export const MAX_TREE_LEAVES = 20;

/** A spec node resolved to its kind. A combinator's `required` is the k-of-n threshold:
 *  all ⇒ (child count), any ⇒ 1, some ⇒ require. */
export type ClassifiedNode =
  | { kind: 'leaf'; event: string; when: DataCondition | undefined }
  | { kind: 'combinator'; op: 'all' | 'any' | 'some'; required: number; children: ComposedSpec[] };

/** Raised for a malformed / disallowed spec — the tool surface (P-004) turns the
 *  message into the caller-facing validation error. */
export class ComposedSpecError extends Error {}

/**
 * Classify ONE spec node, throwing on anything malformed or disallowed.
 *
 * Combinators are recognized as a SOLE key (like the rules grammar): `{ all: [...] }`,
 * `{ any: [...] }`, `{ some: { require, of } }`. A leaf is `{ event, when? }`. Two hard
 * rejections (D-003): an event-level `not` (absence is observed by the root TIMEOUT, not
 * by a negation the fire path can never see go true), and a `some.require` that exceeds
 * its `of` count (it could never fire — a near-certain authoring bug).
 */
export function classifyNode(node: unknown): ClassifiedNode {
  if (!isPlainObject(node)) {
    throw new ComposedSpecError('composed spec: each node must be an object — a leaf { event } or a combinator { all|any|some }.');
  }
  const rec = node as Record<string, unknown>;
  // `not` is unobservable in a monotone fire-once tree — reject loudly (D-003).
  if ('not' in rec) {
    throw new ComposedSpecError(
      "composed spec: event-level `not` is not supported — a non-event is observed by the await's root timeout (timeout_behavior:'wake'), not by negation. Use a deadline, not `not`.",
    );
  }
  const keys = Object.keys(rec);

  // Combinators first, each a SOLE key.
  if ('all' in rec || 'any' in rec || 'some' in rec) {
    if (keys.length !== 1) {
      throw new ComposedSpecError(
        `composed spec: a combinator node must have exactly one key (all | any | some), got [${keys.join(', ')}].`,
      );
    }
    if ('all' in rec) {
      const children = requireChildArray(rec.all, 'all');
      return { kind: 'combinator', op: 'all', required: children.length, children };
    }
    if ('any' in rec) {
      const children = requireChildArray(rec.any, 'any');
      return { kind: 'combinator', op: 'any', required: 1, children };
    }
    // some
    const some = rec.some;
    if (!isPlainObject(some)) {
      throw new ComposedSpecError('composed spec: `some` must be { require: <int≥1>, of: [ … ] }.');
    }
    const { require: req, of } = some as { require?: unknown; of?: unknown };
    const children = requireChildArray(of, 'some.of');
    if (typeof req !== 'number' || !Number.isInteger(req) || req < 1) {
      throw new ComposedSpecError('composed spec: `some.require` must be an integer ≥ 1.');
    }
    if (req > children.length) {
      throw new ComposedSpecError(
        `composed spec: some.require (${req}) exceeds its of-count (${children.length}) — it could never fire. Lower require or add sub-conditions.`,
      );
    }
    return { kind: 'combinator', op: 'some', required: req, children };
  }

  // Leaf: { event, when? } and nothing else.
  if ('event' in rec) {
    const extra = keys.filter((k) => k !== 'event' && k !== 'when');
    if (extra.length > 0) {
      throw new ComposedSpecError(
        `composed spec: a leaf may only carry { event, when? }, got extra key(s) [${extra.join(', ')}].`,
      );
    }
    if (typeof rec.event !== 'string' || rec.event.trim() === '') {
      throw new ComposedSpecError('composed spec: a leaf `event` must be a non-empty string (a key, glob, or @macro).');
    }
    if ('when' in rec && rec.when != null && !isPlainObject(rec.when)) {
      throw new ComposedSpecError('composed spec: a leaf `when` must be a DataCondition object (the same grammar as payload_filter).');
    }
    return { kind: 'leaf', event: rec.event, when: (rec.when as DataCondition | undefined) ?? undefined };
  }

  throw new ComposedSpecError(
    `composed spec: node is neither a leaf { event } nor a combinator { all|any|some } — keys [${keys.join(', ')}].`,
  );
}

function requireChildArray(v: unknown, label: string): ComposedSpec[] {
  if (!Array.isArray(v) || v.length === 0) {
    throw new ComposedSpecError(`composed spec: \`${label}\` must be a non-empty array of sub-conditions.`);
  }
  return v as ComposedSpec[];
}

/**
 * A bare-leaf root is a degenerate composed spec (≡ a single events:await). Wrap it in a
 * one-child `all` so the tree ALWAYS has a combinator root that owns the counter, deadline,
 * and wake handle — the rest of the engine can then assume a node-rooted tree. The tool
 * surface (P-004) routes an obvious bare leaf to plain events:await; this is the safety net.
 */
export function normalizeRoot(spec: ComposedSpec): ComposedSpec {
  const c = classifyNode(spec);
  return c.kind === 'leaf' ? { all: [spec] } : spec;
}

/** Canonical JSON: object keys sorted so two equivalent values differing only in key order
 *  serialize identically. Array order is PRESERVED (position is meaning in a `when` filter). */
function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/**
 * A stable identity for a spec: two specs that MEAN the same thing produce the same string.
 * Used to supersede a caller's own prior pending registration on re-arm (EI-14793), the same
 * way `cancelAwaitsForSubscribersOnKeys` keys the single-key path off the exact event key.
 *
 * Semantic, not syntactic, on the two axes that are genuinely free: sibling ORDER does not
 * matter (`{any:[A,B]}` ≡ `{any:[B,A]}`, so child identities are sorted) and `when` key order
 * does not matter (canonicalJson). The combinator's kind and threshold ARE part of the
 * identity — `{any:[A,B]}` and `{all:[A,B]}` wait for different things and must never merge.
 *
 * Deliberately conservative on one axis: the leaf's event string is compared AS WRITTEN, not
 * macro-expanded via resolveLeafKey. So `@plan:p` and its expansion read as different specs
 * and fail to supersede each other. That is the safe failure direction — it degrades to
 * today's behaviour (an extra live registration) rather than cancelling a wait the caller
 * still needs, which would silently lose a wake.
 */
export function specIdentity(spec: ComposedSpec): string {
  const c = classifyNode(spec);
  if (c.kind === 'leaf') return `leaf:${JSON.stringify(c.event)}:${canonicalJson(c.when)}`;
  return `${c.op}/${c.required}:[${c.children.map(specIdentity).sort().join(',')}]`;
}

/** Depth of a node (leaf = 1; combinator = 1 + max child depth). */
export function specDepth(spec: ComposedSpec): number {
  const c = classifyNode(spec);
  if (c.kind === 'leaf') return 1;
  return 1 + Math.max(...c.children.map(specDepth));
}

/** Every leaf in DFS order (also the total-leaf count for the D-003 cap). */
export function flattenLeaves(spec: ComposedSpec): ComposedLeafSpec[] {
  const c = classifyNode(spec);
  if (c.kind === 'leaf') return [{ event: c.event, when: c.when }];
  return c.children.flatMap(flattenLeaves);
}

/**
 * Validate a (root-normalized) spec fully: recurse (which classifies + rejects malformed
 * nodes, `not`, and unsatisfiable `some`), enforce the depth/leaf caps, and — per leaf —
 * macro-expand its event and, if it is a pattern, assert it is anchored enough not to
 * wake-storm (reusing the exact events:await registration guard). Returns the resolved
 * leaf list + depth so the caller need not re-walk. Throws ComposedSpecError on any problem.
 */
export function validateSpec(spec: ComposedSpec): { leaves: ComposedLeafSpec[]; depth: number } {
  // Recurse for structural validity (classifyNode throws on every malformed shape).
  const walk = (n: ComposedSpec): void => {
    const c = classifyNode(n);
    if (c.kind === 'combinator') c.children.forEach(walk);
  };
  walk(spec);

  const depth = specDepth(spec);
  if (depth > MAX_TREE_DEPTH) {
    throw new ComposedSpecError(`composed spec: tree depth ${depth} exceeds the max of ${MAX_TREE_DEPTH} (root → interior → leaves).`);
  }
  const leaves = flattenLeaves(spec);
  if (leaves.length > MAX_TREE_LEAVES) {
    throw new ComposedSpecError(`composed spec: ${leaves.length} leaves exceeds the max of ${MAX_TREE_LEAVES}.`);
  }
  if (leaves.length === 0) {
    throw new ComposedSpecError('composed spec: a tree must have at least one leaf.');
  }
  // Per-leaf pattern hygiene: expand @macros, and reject a too-broad glob at registration
  // (same guard as a plain pattern await) — a malformed macro throws here too.
  for (const leaf of leaves) {
    const expanded = expandPatternMacro(leaf.event);
    if (isPattern(expanded)) assertUsablePattern(expanded);
  }
  return { leaves, depth };
}

/** The macro-expanded key a leaf is stored + fired under (globs kept, exact keys unchanged). */
export function resolveLeafKey(event: string): string {
  return expandPatternMacro(event);
}

/**
 * A summary line for a composed wake / status render. `satisfied` = the tree tripped on a
 * real event; a timeout wake passes satisfied:false.
 */
export function composedWakeSummary(input: { satisfied: boolean; firedCount: number; leafCount: number }): string {
  const { satisfied, firedCount, leafCount } = input;
  return satisfied
    ? `Composed await consumed — satisfied — ${firedCount}/${leafCount} event(s) fired`
    : `Composed await consumed — timed out — only ${firedCount}/${leafCount} event(s) fired before the deadline`;
}
