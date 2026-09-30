/**
 * Structural validation that works for ANY rule — including ones whose `when`
 * is a predicate function and whose `args` is a function (which the Zod schema,
 * being for the serializable form, cannot describe). Cheap invariants only;
 * the deep serializable-shape check lives in schema.ts.
 */

export class RuleValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuleValidationError';
  }
}

/**
 * The structural view validation needs — all fields `unknown` so it accepts any
 * `Rule<E, Fire>` (avoiding predicate-arg contravariance) AND raw input. The
 * runtime checks below narrow each field.
 */
interface RuleLike {
  id: unknown;
  on: unknown;
  fire: unknown;
  when?: unknown;
  args?: unknown;
}

/** Throw if a rule violates the basic structural invariants. */
export function validateRuleShape(rule: RuleLike): void {
  if (!rule || typeof rule !== 'object') {
    throw new RuleValidationError('rule must be an object');
  }
  if (typeof rule.id !== 'string' || rule.id.length === 0) {
    throw new RuleValidationError('rule.id must be a non-empty string');
  }
  const on = rule.on;
  const onOk =
    (typeof on === 'string' && on.length > 0) ||
    (Array.isArray(on) && on.length > 0 && on.every((k) => typeof k === 'string' && k.length > 0));
  if (!onOk) {
    throw new RuleValidationError(`rule "${rule.id}": on must be a non-empty string or non-empty string[]`);
  }
  if (rule.fire === undefined || rule.fire === null || (typeof rule.fire === 'string' && rule.fire.length === 0)) {
    throw new RuleValidationError(`rule "${rule.id}": fire is required`);
  }
  if (rule.when !== undefined && typeof rule.when !== 'function' && (typeof rule.when !== 'object' || rule.when === null)) {
    throw new RuleValidationError(`rule "${rule.id}": when must be a DataCondition object or a predicate function`);
  }
  if (rule.args !== undefined && typeof rule.args !== 'function' && (typeof rule.args !== 'object' || rule.args === null)) {
    throw new RuleValidationError(`rule "${rule.id}": args must be an object or a function`);
  }
}
