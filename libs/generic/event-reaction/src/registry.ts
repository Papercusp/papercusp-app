/**
 * The reaction registry — a thin, inspectable wrapper over a `@papercusp/rules`
 * `RulesEngine`, specialized to reaction rules. One registry holds every rule
 * from every source (built-in, co-location sugar, plugin/blueprint contributions)
 * indexed by trigger key for O(rules-for-key) matching.
 *
 * The lib intentionally does NOT anchor a singleton — process-wide sharing (e.g.
 * a `globalThis` anchor across a tsx runtime + a vitest module graph) is a host
 * concern; the host constructs ONE `ReactionRegistry` and exposes whatever
 * functional API it wants over it.
 */

import { RulesEngine, type MatchedAction, type RulesEngineOptions, type TriggerKey } from '@papercusp/rules';
import type { ReactionRule } from './types';

export class ReactionRegistry<TEvent, TFire = string> {
  private readonly engine: RulesEngine<TEvent, TFire>;

  constructor(opts: RulesEngineOptions<TEvent>) {
    this.engine = new RulesEngine<TEvent, TFire>(opts);
  }

  /** Register a rule. Idempotent by `rule.id` (re-adding the same id replaces). */
  add(rule: ReactionRule<TEvent, TFire>): void {
    this.engine.add(rule);
  }

  /** Remove a rule by id. Returns true if one was removed. */
  remove(id: string): boolean {
    return this.engine.remove(id);
  }

  /** Every registered rule — inspectability / the reactive-graph view. */
  rules(): ReactionRule<TEvent, TFire>[] {
    return this.engine.rules() as ReactionRule<TEvent, TFire>[];
  }

  /** Rules registered on a given trigger key. */
  rulesFor(key: TriggerKey): ReactionRule<TEvent, TFire>[] {
    return this.engine.rulesFor(key) as ReactionRule<TEvent, TFire>[];
  }

  /** Match an event → the reaction actions that should fire (pure). */
  match(event: TEvent): Array<MatchedAction<TEvent, TFire>> {
    return this.engine.match(event);
  }

  /** The reactive graph as `{ on, ruleId, fire }` edges — the "what fires what" view. */
  describe(): Array<{ on: TriggerKey; ruleId: string; fire: TFire }> {
    return this.engine.describe();
  }

  /** Empty the registry (test / reset). */
  clear(): void {
    this.engine.clear();
  }
}
