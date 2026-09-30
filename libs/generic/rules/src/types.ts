/**
 * Core types for the generic ECA rules engine.
 *
 * The engine is generic over the Event type (`E`) and the Fire descriptor type
 * (`Fire`, defaults to `string` — an action/tool name). A rule says: *on these
 * trigger key(s), when this condition holds over the event, fire this action
 * with these (possibly event-derived) args.* The engine is a PURE matcher: it
 * decides WHAT should fire and returns it; the consumer FIRES it. (rules-engine
 * D-002: dispatch/durability/loop-protection are the consumer's concern.)
 */

import type { OperatorTest } from './operators';

export type { OperatorTest } from './operators';

/** A trigger key — the value(s) the engine indexes rules by (e.g. a tool name). */
export type TriggerKey = string;

/**
 * A map of dot-path → leaf test (an `OperatorTest`, or a bare value meaning
 * `equals`). Every entry must pass — implicit AND. This is the common `when`
 * shape: `{ 'args.item': { exists: true }, 'result.ok': true }`.
 */
export type MatchMap = Record<string, OperatorTest | unknown>;

/**
 * A declarative, serializable condition. Either a single combinator
 * (`all`/`any`/`some`/`not` — recognised only when it is the SOLE key) or a
 * `MatchMap` of path→test (implicit AND). Combinators nest arbitrarily.
 *
 * `some: { require, of }` is the k-of-n threshold form: satisfied when at least
 * `require` of the `of` sub-conditions hold (`any` ≡ require:1, `all` ≡ require:n).
 */
export type DataCondition =
  | { all: DataCondition[] }
  | { any: DataCondition[] }
  | { some: { require: number; of: DataCondition[] } }
  | { not: DataCondition }
  | MatchMap;

/** The JS predicate escape-hatch (D-004/D-006): an opaque boolean function. */
export type Predicate<E> = (event: E) => boolean;

/** A rule's `when`: the declarative data-matcher OR a predicate. Omitted ⇒ always. */
export type Condition<E> = DataCondition | Predicate<E>;

/**
 * A rule's `args`: a static object, or a function deriving the args from the
 * event. The function form is the general escape-hatch for arg-mapping.
 */
export type ArgsTemplate<E> = Record<string, unknown> | ((event: E) => Record<string, unknown>);

/**
 * A rule: `{ id, on, when, fire, args }` (+ opaque `meta` the engine passes
 * through untouched — consumers stash mode/capability/source/dedup there).
 */
export interface Rule<E, Fire = string> {
  /** Unique id. Re-adding by the same id replaces the prior rule. */
  id: string;
  /** The trigger key(s) this rule fires on. Indexed for O(rules-for-key) match. */
  on: TriggerKey | TriggerKey[];
  /** The condition over the event. Omitted ⇒ matches whenever `on` matches. */
  when?: Condition<E>;
  /** The action to fire (a tool name, by default). Opaque to the engine. */
  fire: Fire;
  /** The action's args, static or event-derived. */
  args?: ArgsTemplate<E>;
  /** Opaque consumer metadata — passed through on `MatchedAction.rule`, never read by the engine. */
  meta?: Record<string, unknown>;
}

/** What `match()` returns per matched rule: the resolved, ready-to-fire action. */
export interface MatchedAction<E, Fire = string> {
  /** The rule that matched. */
  ruleId: string;
  /** The action to fire (verbatim from `rule.fire`). */
  fire: Fire;
  /** The resolved args (function templates already invoked). */
  args: Record<string, unknown>;
  /** The full rule (for provenance / meta passthrough). */
  rule: Rule<E, Fire>;
}

export interface RulesEngineOptions<E> {
  /**
   * Extract the trigger key(s) from an event, for indexed lookup. e.g. the
   * event-reaction system passes `(e) => e.tool`. An event may legitimately map
   * to multiple keys (return an array).
   */
  keyOf: (event: E) => TriggerKey | TriggerKey[];
  /**
   * Optional sink for per-rule evaluation errors (a throwing predicate / bad
   * regex). The engine catches these so one bad rule can't break matching;
   * by default they are swallowed. Provide this to log them.
   */
  onError?: (err: unknown, rule: Rule<E, unknown>, event: E) => void;
}
