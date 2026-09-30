/**
 * @papercusp/rules — a generic, pure ECA (Event-Condition-Action) rules engine.
 *
 * Register rules `{ id, on, when, fire, args }`; given an event, `match()`
 * returns the actions that should fire. Indexed by trigger key for O(matching);
 * `when` is a declarative data-matcher (a curated MatchMap vocabulary evaluated
 * by a mingo-backed leaf compiler — see compile.ts) plus a JS-predicate
 * escape-hatch; rules are Zod-validatable in their serializable form.
 *
 * PURE: no I/O, no dispatch, no durability, no loop-protection — those are the
 * consumer's concern (rules-engine D-002). The lib decides WHAT should fire; the
 * consumer FIRES it. The first consumer is the event-reaction-system, but the
 * lib is consumer-agnostic (generic over the event + fire types).
 */

export { RulesEngine } from './engine';
export { evaluateCondition, evaluateDataCondition } from './matcher';
export { evaluateOperatorTest, isOperatorTest, isPlainObject, OPERATOR_KEYS } from './operators';
export type { OperatorKey, OperatorTest } from './operators';
export { compileToMingo, compileLeafClauses } from './compile';
export type { MingoQuery } from './compile';
export { getPath, hasPath, splitPath } from './path';
export { deepEqual } from './deep-equal';
export { validateRuleShape, RuleValidationError } from './validate';
export {
  serializableRuleSchema,
  dataConditionSchema,
  operatorTestSchema,
  parseSerializableRule,
  safeParseSerializableRule,
  parseSerializableRules,
  KNOWN_OPERATORS,
} from './schema';
export type { SerializableRule } from './schema';
export type {
  TriggerKey,
  MatchMap,
  DataCondition,
  Predicate,
  Condition,
  ArgsTemplate,
  Rule,
  MatchedAction,
  RulesEngineOptions,
} from './types';
