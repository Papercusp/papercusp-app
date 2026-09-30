/**
 * RulesEngine — the indexed registry + pure `match()`.
 *
 * Generic over the event type `E` and the fire-descriptor type `Fire` (default
 * `string`). Rules are bucketed by trigger key (`rule.on`), so matching an
 * event is O(rules-for-this-key), not O(all-rules) — critical when every tool
 * invocation is matched (rules-engine D-005).
 *
 * `match(event)` is side-effect-free: it returns the `MatchedAction`s that
 * should fire (resolved args included). The engine never fires anything — that
 * is the consumer's job (D-002). Per-rule evaluation errors are caught so one
 * bad rule can't break matching.
 */

import { evaluateCondition } from './matcher';
import { validateRuleShape } from './validate';
import type { MatchedAction, Rule, RulesEngineOptions, TriggerKey } from './types';

function normalizeKeys(on: TriggerKey | TriggerKey[]): TriggerKey[] {
  return Array.isArray(on) ? on : [on];
}

export class RulesEngine<E, Fire = string> {
  private readonly byKey = new Map<TriggerKey, Rule<E, Fire>[]>();
  private readonly byId = new Map<string, Rule<E, Fire>>();
  private readonly opts: RulesEngineOptions<E>;

  constructor(opts: RulesEngineOptions<E>) {
    this.opts = opts;
  }

  /** Register a rule. Re-adding an existing id replaces it (idempotent by id). */
  add(rule: Rule<E, Fire>): this {
    validateRuleShape(rule);
    if (this.byId.has(rule.id)) this.remove(rule.id);
    this.byId.set(rule.id, rule);
    for (const key of normalizeKeys(rule.on)) {
      const bucket = this.byKey.get(key);
      if (bucket) bucket.push(rule);
      else this.byKey.set(key, [rule]);
    }
    return this;
  }

  /** Register many rules. */
  addAll(rules: Iterable<Rule<E, Fire>>): this {
    for (const r of rules) this.add(r);
    return this;
  }

  /** Remove a rule by id. Returns true if one was removed. */
  remove(id: string): boolean {
    const rule = this.byId.get(id);
    if (!rule) return false;
    this.byId.delete(id);
    for (const key of normalizeKeys(rule.on)) {
      const bucket = this.byKey.get(key);
      if (!bucket) continue;
      const next = bucket.filter((r) => r.id !== id);
      if (next.length) this.byKey.set(key, next);
      else this.byKey.delete(key);
    }
    return true;
  }

  /** Remove every rule. */
  clear(): void {
    this.byKey.clear();
    this.byId.clear();
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  get(id: string): Rule<E, Fire> | undefined {
    return this.byId.get(id);
  }

  /** All registered rules (insertion order is not guaranteed across removals). */
  rules(): Rule<E, Fire>[] {
    return [...this.byId.values()];
  }

  /** Rules registered on a specific trigger key. */
  rulesFor(key: TriggerKey): Rule<E, Fire>[] {
    return this.byKey.get(key) ? [...(this.byKey.get(key) as Rule<E, Fire>[])] : [];
  }

  /** Every trigger key that has at least one rule. */
  triggerKeys(): TriggerKey[] {
    return [...this.byKey.keys()];
  }

  size(): number {
    return this.byId.size;
  }

  /**
   * Match an event → the actions that should fire. Pure. Rules are looked up by
   * the event's trigger key(s); each candidate's `when` is evaluated; matches
   * resolve their args into a `MatchedAction`. Evaluation errors are routed to
   * `onError` (if provided) and that rule is skipped.
   */
  match(event: E): MatchedAction<E, Fire>[] {
    const keys = normalizeKeys(this.opts.keyOf(event));
    const out: MatchedAction<E, Fire>[] = [];
    const seen = new Set<string>();
    for (const key of keys) {
      const bucket = this.byKey.get(key);
      if (!bucket) continue;
      for (const rule of bucket) {
        if (seen.has(rule.id)) continue; // a rule on multiple keys fires at most once
        seen.add(rule.id);
        try {
          if (!evaluateCondition(rule.when, event)) continue;
          out.push({
            ruleId: rule.id,
            fire: rule.fire,
            args: resolveArgs(rule, event),
            rule,
          });
        } catch (err) {
          this.opts.onError?.(err, rule as Rule<E, unknown>, event);
        }
      }
    }
    return out;
  }

  /**
   * The reactive graph as edges: one `{ on, ruleId, fire }` per (key, rule).
   * The inspectability primitive (D-008) the consumer's "what fires what" view
   * is built on.
   */
  describe(): Array<{ on: TriggerKey; ruleId: string; fire: Fire }> {
    const edges: Array<{ on: TriggerKey; ruleId: string; fire: Fire }> = [];
    for (const [on, bucket] of this.byKey) {
      for (const rule of bucket) edges.push({ on, ruleId: rule.id, fire: rule.fire });
    }
    return edges;
  }
}

function resolveArgs<E, Fire>(rule: Rule<E, Fire>, event: E): Record<string, unknown> {
  const { args } = rule;
  if (args === undefined) return {};
  if (typeof args === 'function') return (args as (e: E) => Record<string, unknown>)(event) ?? {};
  return args;
}
