/**
 * Zod schemas for the SERIALIZABLE rule form (rules-engine D-004: "Zod-validated
 * rule schema").
 *
 * A rule whose `when` is a data-condition and whose `args` is a static object is
 * fully serializable (JSON / an Events file). Predicate `when`s and function
 * `args` are the in-code escape-hatch and cannot be Zod-described — for those,
 * use `validateRuleShape` (validate.ts) instead. So: parse data-form rules with
 * `parseSerializableRule`; structurally check any rule with `validateRuleShape`.
 */

import { z } from 'zod';
import { OPERATOR_KEYS } from './operators';

/** A single leaf operator test — every operator optional, at least the known keys. */
export const operatorTestSchema = z
  .object({
    equals: z.unknown().optional(),
    notEquals: z.unknown().optional(),
    exists: z.boolean().optional(),
    truthy: z.boolean().optional(),
    in: z.array(z.unknown()).optional(),
    notIn: z.array(z.unknown()).optional(),
    contains: z.unknown().optional(),
    notContains: z.unknown().optional(),
    gt: z.number().optional(),
    gte: z.number().optional(),
    lt: z.number().optional(),
    lte: z.number().optional(),
    matches: z.union([z.string(), z.object({ source: z.string(), flags: z.string().optional() })]).optional(),
    startsWith: z.string().optional(),
    endsWith: z.string().optional(),
  })
  .strict();

/**
 * A declarative condition. Combinators (`all`/`any`/`some`/`not`) are recognised
 * only as the sole key (`.strict()`); otherwise it's a match-map of path →
 * test/value. Recursive via `z.lazy`. Typed loosely to avoid TS recursion blow-up.
 *
 * `some: { require: k, of: [...] }` is the k-of-n threshold combinator: satisfied
 * when at least `k` of the `of` sub-conditions hold. `any` ≡ `some{require:1}`,
 * `all` ≡ `some{require:n}` — `some` is the general form the two are presets of.
 * (composable-event-awaits P-001: the awaits-spec grammar IS this schema, no fork.)
 */
export const dataConditionSchema: z.ZodType = z.lazy(() =>
  z.union([
    z.object({ all: z.array(dataConditionSchema) }).strict(),
    z.object({ any: z.array(dataConditionSchema) }).strict(),
    z
      .object({ some: z.object({ require: z.number().int().min(1), of: z.array(dataConditionSchema) }).strict() })
      .strict(),
    z.object({ not: dataConditionSchema }).strict(),
    z.record(z.string(), z.unknown()),
  ]),
);

/** The serializable rule schema: `{ id, on, when?, fire, args?, meta? }`. */
export const serializableRuleSchema = z.object({
  id: z.string().min(1),
  on: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
  when: dataConditionSchema.optional(),
  fire: z.string().min(1),
  args: z.record(z.string(), z.unknown()).optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

export type SerializableRule = z.infer<typeof serializableRuleSchema>;

/** Parse + validate a data-form rule. Throws a ZodError on a bad shape. */
export function parseSerializableRule(input: unknown): SerializableRule {
  return serializableRuleSchema.parse(input);
}

/** Non-throwing variant. */
export function safeParseSerializableRule(input: unknown): z.ZodSafeParseResult<SerializableRule> {
  return serializableRuleSchema.safeParse(input);
}

/** Parse a whole Events file: an array of serializable rules. */
export function parseSerializableRules(input: unknown): SerializableRule[] {
  return z.array(serializableRuleSchema).parse(input);
}

/** The operator vocabulary, re-exported so a consumer can document/inspect it. */
export const KNOWN_OPERATORS = OPERATOR_KEYS;
