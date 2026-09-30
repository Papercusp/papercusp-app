/**
 * Shared assertions for the D-016 model-drift guards.
 *
 * Extracted from `model-drift.test.ts` when the service family gained its own
 * argument-surface guard (WI-6149, `dev:listening_ports`). Both guard files ask
 * the same two questions of a pair — "does the tool still take the args this
 * model assumes?" and "does the expression name only args that exist?" — and a
 * second copy of that logic is one more thing to drift.
 *
 * These live in a plain module rather than a `.test.ts` on purpose: a helper
 * imported by two suites is not itself a suite, and duplicating it into each
 * would defeat the point of a guard whose whole job is to stop duplication from
 * rotting.
 */
import { expect } from 'vitest';

/** The tool's declared argument names, sorted. */
export function argKeys(tool: unknown): string[] {
  type SchemaLike = {
    shape?: Record<string, unknown>;
    _def?: { options?: readonly SchemaLike[] };
    options?: readonly SchemaLike[];
  };

  // Most tools expose a Zod object, but tools with mutually exclusive input
  // forms (for example dev:pg_query's `sql` vs `describe`) expose a Zod union.
  // Read every object branch so the drift guard compares the complete public
  // argument surface instead of treating a union as an empty object.
  const keys = new Set<string>();
  const visit = (schema: SchemaLike | undefined): void => {
    if (!schema || typeof schema !== 'object') return;
    for (const key of Object.keys(schema.shape ?? {})) keys.add(key);
    const options = schema._def?.options ?? schema.options ?? [];
    for (const option of options) visit(option);
  };

  visit((tool as { args?: SchemaLike }).args);
  return [...keys].sort();
}

/**
 * Assert a tool's parameter surface is exactly `expected`, with a diagnostic
 * that tells the reader WHY the audit cares and what to do about it.
 */
export function expectArgSurface(tool: unknown, toolName: string, expected: string[], why: string): void {
  const actual = argKeys(tool);
  const added = actual.filter((k) => !expected.includes(k));
  const removed = expected.filter((k) => !actual.includes(k));
  expect(
    { added, removed },
    `${toolName}'s argument surface changed, so the bash-substitution model of it may be stale.\n` +
      `  added:   ${added.join(', ') || '(none)'}\n` +
      `  removed: ${removed.join(', ') || '(none)'}\n` +
      `Why this matters here: ${why}\n` +
      `An ADDED arg usually means the pair now UNDER-claims coverage — re-derive the verdict and check advisoryText ` +
      `is not still telling agents to shell out for something the tool now does (the WI-6146 regression). ` +
      `A REMOVED arg means the pair OVER-claims — cover() is emitting expressions the tool can no longer evaluate. ` +
      `If the change genuinely does not affect coverage, add the arg to the expected list with a one-line reason.`,
  ).toEqual({ added: [], removed: [] });
}

/**
 * Every parameter a pair's emitted `expression` names must exist on the tool it
 * routes to — otherwise the audit hands agents an expression they cannot run.
 * (The service guard's `UNIT_TO_PROBE` check is the same idea in that family's
 * shape.)
 */
export function expectExpressionUsesRealArgs(
  pair: { id: string; cover: (atom: string) => { covered: boolean; expression?: string; reason?: string } },
  atom: string,
  tool: unknown,
  expectedParams: string[],
): void {
  const result = pair.cover(atom);
  expect(
    result.covered,
    `${pair.id} no longer covers its own canonical atom "${atom}" (reason: ${result.reason ?? 'none given'}). ` +
      `Either the model regressed or this atom stopped being representative — do not simply change the atom.`,
  ).toBe(true);

  const real = argKeys(tool);
  const bogus = expectedParams.filter((p) => !real.includes(p));
  expect(
    bogus,
    `${pair.id} builds an expression around parameters ${bogus.join(', ')} that ${
      (tool as { name?: string }).name ?? 'the tool'
    } does not accept — the audit is promising a call an agent cannot make.`,
  ).toEqual([]);

  const missing = expectedParams.filter((p) => !(result.expression ?? '').includes(`${p}:`));
  expect(
    missing,
    `${pair.id}'s expression for "${atom}" no longer names ${missing.join(', ')}. ` +
      `Expression was: ${result.expression ?? '(none)'}`,
  ).toEqual([]);
}
