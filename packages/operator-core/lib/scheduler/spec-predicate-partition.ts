/**
 * spec-predicate-partition.ts — the claim-spec surface's call into the SHARED predicate-partition
 * primitive (EI-23760081161304754 · plan dry-run-for-claims…, P-005).
 *
 * WHY. A claim spec's `view.filter` is a conjunction of predicates over a pool, and a COUNT of what
 * it matches cannot show the rows that satisfy none of them: a nullable field makes a comparison
 * UNKNOWN rather than false, so the row falls out of every branch AND out of the matched total
 * while the number still comes back well-formed. That is the exact shape that starved this fleet
 * twice (EI-13306: `not:{plan='<slug>'}` collapsed a 2341-row pool to 4). The query surface
 * (`dev:pg_query`) already answers it with an exhaustive partition — every row in exactly one
 * labelled cell — via `planPredicatePartition → executePredicatePartition → renderPredicatePartition`
 * in pg-read-query.ts. This module is the SECOND CALLER of that one primitive, and it adds no
 * second implementation of the partition or of leaf semantics.
 *
 * HOW (reuse-first, nothing re-implemented):
 *  - the pool floors are `specPoolFloors` — the very text `previewSpecPoolEffect` COUNTS under;
 *  - each top-level conjunct of the filter is `compileFilter` — the very function `get_next`
 *    executes. `compileFilter` is written against postgres.js's TAG form only (verified: no
 *    `sql(...)` call, `sql.json`, or `sql.array` anywhere on its path; `sql.unsafe` appears only in
 *    observationLaneExclusionSql), so handing it {@link textSql} — a tag that INLINES its values —
 *    renders the exact predicate text the claim path runs, with no parallel leaf compiler to drift;
 *  - the resulting `SELECT count(*) … WHERE (floors) AND (c1) AND (c2)` is handed to
 *    `planPredicatePartition`, which decides whether the read qualifies (< 2 dimensions and no jsonb
 *    path → null, narrow reads unchanged), caps the dimensions, and keeps the floors as SCOPE;
 *  - execution and rendering are `executePredicatePartition` / `renderPredicatePartition`, unchanged.
 *
 * Read-only and FAIL-OPEN: a probe that cannot run degrades to the statements-only rendering the
 * shared primitive already produces, and a throw while BUILDING the statement is reported by the
 * caller, never allowed to block a spec write or a preview.
 */
import type { ClaimSpec, FilterNode } from './claim-spec';
import { compileFilter } from './get-next';
import { describeFilterNode, specPoolFloors, specPoolStates } from './spec-pool-preview';
import type { OrgSql } from '../work-items';
import {
  executePredicatePartition,
  planPredicatePartition,
  renderPredicatePartition,
  type PredicatePartitionPlan,
} from '../pg-read-query';

// ─────────────────────────────────────────────────────────────────────────────
// textSql — a postgres.js-shaped tag that renders to TEXT instead of binding parameters.
// ─────────────────────────────────────────────────────────────────────────────

/** A rendered SQL fragment. A class so a nested fragment is told apart from a plain string value. */
class TextFragment {
  constructor(readonly text: string) {}
}

/**
 * Render one JS value as a SQL literal. This is the only place values are escaped, so it is
 * deliberately strict: anything it cannot render exactly throws rather than guessing.
 *
 * Strings that contain a backslash use the `E'…'` form with backslashes doubled, so the result is
 * the same text whether or not `standard_conforming_strings` is on — compileLeaf's glob and
 * word-boundary values both carry backslashes (globToLike / escapePgRegexLiteral).
 */
function renderLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'string') {
    if (value.includes('\u0000')) throw new Error('textSql: a NUL byte cannot appear in a SQL literal');
    const quoted = value.replace(/'/g, "''");
    return value.includes('\\') ? `E'${quoted.replace(/\\/g, '\\\\')}'` : `'${quoted}'`;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`textSql: cannot render non-finite number ${String(value)}`);
    return String(value);
  }
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  throw new Error(`textSql: unsupported value type ${typeof value}`);
}

function renderValue(value: unknown): string {
  if (value instanceof TextFragment) return value.text;
  if (Array.isArray(value)) {
    // `ARRAY[]` alone has no element type, but every array in the claim compiler is followed by
    // an explicit `::text[]` / `::numeric[]` cast, which gives it one.
    return `ARRAY[${value.map(renderLiteral).join(', ')}]`;
  }
  return renderLiteral(value);
}

function textTag(strings: TemplateStringsArray, ...values: unknown[]): TextFragment {
  // postgres.js also lets a caller invoke the tag as a plain function — `sql(rows)`, `sql('col')` —
  // to build identifiers or multi-row lists. Handed one of those, `strings[0]` below would be a
  // VALUE rather than template text and the result would render as plausible, wrong SQL. Refuse
  // loudly instead: the claim compiler uses the tag form only, so this can only fire if it grows
  // a second form, and the partition preview must not then silently measure a different predicate.
  if (!Array.isArray(strings) || !Array.isArray((strings as { raw?: unknown }).raw)) {
    throw new Error('textSql: only the tagged-template form is supported (called as a plain function)');
  }
  let out = strings[0] ?? '';
  for (let i = 0; i < values.length; i += 1) out += renderValue(values[i]) + (strings[i + 1] ?? '');
  return new TextFragment(out);
}
textTag.unsafe = (raw: string): TextFragment => new TextFragment(raw);

/**
 * The tag handed to the claim compiler in place of the postgres.js one. It is NOT an `OrgSql` and
 * is cast only because the compiler's own parameter type names one; the surface the compiler
 * actually touches is the tag call and `.unsafe`, which is exactly what this implements.
 */
export const textSql = textTag as unknown as OrgSql;

/** Read a fragment produced by {@link textSql}; throws if handed anything else (a real postgres.js fragment). */
export function textOf(fragment: unknown): string {
  if (fragment instanceof TextFragment) return fragment.text;
  throw new Error('textOf: not a textSql fragment — the compiler was handed a different sql tag');
}

// ─────────────────────────────────────────────────────────────────────────────
// The partition statement.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The top-level conjuncts of a filter: an `all` is flattened (AND is associative, so this changes
 * nothing about what matches) and everything else — a leaf, an `any`, a `not` — is ONE conjunct.
 * An `any` is deliberately NOT split: its arms are alternatives, so partitioning by arm would ask a
 * different question ("which arm admits it") than "does this predicate admit it, refuse it, or
 * leave it UNKNOWN".
 */
export function topLevelConjuncts(filter: FilterNode | undefined): FilterNode[] {
  if (!filter) return [];
  if ('all' in filter) return filter.all.flatMap(topLevelConjuncts);
  return [filter];
}

export interface SpecPartitionStatement {
  /** The `SELECT count(*) … WHERE (floors) AND (c1) AND …` text handed to the shared planner. */
  sql: string;
  /** The compiled text of each conjunct, in filter order, with its source node — for labelling. */
  conjuncts: Array<{ node: FilterNode; text: string }>;
}

/** Build the statement, or null when the filter has no conjunct to partition by. */
export function buildSpecPartitionStatement(
  spec: ClaimSpec,
  opts: { workspaceId: string; harness?: string | null },
): SpecPartitionStatement | null {
  const nodes = topLevelConjuncts(spec.view.filter);
  if (!nodes.length) return null;
  const floors = textOf(
    specPoolFloors(textSql, {
      workspaceId: opts.workspaceId,
      harness: opts.harness ?? null,
      states: specPoolStates(spec),
    }),
  );
  const conjuncts = nodes.map((node) => ({ node, text: textOf(compileFilter(textSql, node)) }));
  // Each conjunct is already parenthesised by compileFilter and the floors by specPoolFloors, so
  // the planner's base-depth splitter keeps every one whole.
  const sql =
    `SELECT count(*) FROM harness_shared.work_items\n WHERE ${floors}\n` +
    conjuncts.map((c) => `   AND ${c.text}`).join('\n');
  return { sql, conjuncts };
}

const squash = (text: string): string => text.replace(/\s+/g, ' ').trim();

/**
 * Name each partition dimension by the filter node it came from. The planner reports dimensions as
 * normalised text, so the join is by text — and a dimension that matches no conjunct is left
 * unlabelled rather than guessed at (a wrong label on a NULL cell would send the reader to the
 * wrong predicate).
 */
export function labelDimensions(plan: PredicatePartitionPlan, statement: SpecPartitionStatement): string[] {
  return plan.dimensions.map((dimension, i) => {
    const hit = statement.conjuncts.find((c) => squash(c.text) === dimension);
    return `d${i + 1} = ${hit ? describeFilterNode(hit.node) : '(unlabelled)'}`;
  });
}

/**
 * Plan the statement through the SHARED planner. Null = the read does not qualify (fewer than two
 * independent dimensions and no jsonb path): narrow specs come back exactly as they did before.
 */
export function planSpecPartition(
  spec: ClaimSpec,
  opts: { workspaceId: string; harness?: string | null },
): { plan: PredicatePartitionPlan; statement: SpecPartitionStatement } | null {
  const statement = buildSpecPartitionStatement(spec, opts);
  if (!statement) return null;
  const plan = planPredicatePartition(statement.sql);
  return plan ? { plan, statement } : null;
}

/**
 * Preview the partition of a claim spec's top-level predicates over the claimable pool.
 *
 * Returns null when the filter does not qualify; otherwise the shared primitive's rendering (the
 * EXECUTED cells, per-dimension NULL counts and fall-through sample, or the statements alone when
 * the probe could not run) behind a short legend naming which filter node each `d<N>` column is.
 * Throws only if the STATEMENT cannot be built (an unknown field — a code bug) — the caller
 * decides fail-open.
 */
export async function previewSpecFilterPartition(
  spec: ClaimSpec,
  opts: { workspaceId: string; harness?: string | null; client?: OrgSql },
): Promise<string | null> {
  const planned = planSpecPartition(spec, opts);
  if (!planned) return null;
  const { plan, statement } = planned;
  const data = await executePredicatePartition(plan, opts.client ? { client: opts.client } : {});
  return (
    `CLAIM-SPEC PARTITION — the pool is the neutral floors (status, unclaimed, not observation-lane, not claim-held); ` +
    `each d<N> below is ONE top-level predicate of the filter, evaluated per row. A NULL cell is a row the predicate ` +
    `neither admits nor refuses — the claim path drops it, and a matched COUNT cannot show it:\n` +
    `${labelDimensions(plan, statement).join('\n')}\n` +
    renderPredicatePartition(plan, data)
  );
}
