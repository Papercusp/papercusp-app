/**
 * Standalone reaction rules — a rule that is NOT owned by a plugin
 * (identities-v1-2026-08-30 P-028, D-011 / D-054 §7b).
 *
 * Today a rule is trapped inside a plugin by construction: the plugin contract
 * requires that `fire` name one of THAT plugin's projected tools, so you cannot
 * author a rule that fires a first-party tool, cannot compose two vendors' tools,
 * and must be a tool vendor to author a rule at all. A standalone rule is the
 * installable unit that frees it — and the thing that makes it portable is that
 * its `fire` names a capability CLASS verb, not a tool id (D-004): the pot's own
 * binding decides which provider actually runs, so ONE rule ships across pots
 * with different providers.
 *
 * There is NO second registry and NO second condition language: these register
 * into the same `registerReactionRule` engine every built-in and plugin rule uses,
 * and `when` is the one `@papercusp/rules` `dataConditionSchema`. The only things
 * that differ from the plugin path are the `source` (`standalone:<id>`) and the
 * class-based fire target.
 *
 * The plugin path's owner check stays exactly as it is — it is correct for plugin
 * rules (D-054 §7). This is a different source with a different contract, not a
 * relaxation of that one.
 */

import type postgres from 'postgres';
import { registerReactionRule, listReactionRules, unregisterReactionRule } from './registry';
import { validateClassFireTarget } from './class-fire-target';
import type { ReactionRule } from './types';

/** Provenance prefix for the reactive-graph view — mirrors `plugin:<name>`. */
export const STANDALONE_RULE_SOURCE = 'standalone';

export interface StandaloneRuleInput {
  /** Stable id within the standalone namespace; registers as `standalone:<id>`. */
  id: string;
  /** Trigger tool (the rule index key), e.g. `coord:handoff`. */
  on: string;
  /** `@papercusp/rules` data condition. Omitted ⇒ fires on every matching event. */
  when?: unknown;
  /** `class:<id>@<version>#<verb>` — validated against the class registry here. */
  fire: string;
  args?: Record<string, unknown>;
  onlyOnSuccess?: boolean;
}

export type RegisterStandaloneRuleResult =
  | { ok: true; ruleId: string; classRef: string; verb: string; capability: string }
  | { ok: false; error: string };

/**
 * Register one standalone rule, validating its CLASS at registration time
 * (D-054 §3). Deliberately does NOT resolve a provider: the binding is per-pot
 * and mutable, so a registration-time tool check would either refuse a valid rule
 * or bake in one pot's answer. Resolution happens at fire, in `dispatch-reaction`.
 *
 * The capability comes from the class verb, never from the resolved tool — see
 * `class-fire-target.ts`.
 */
export async function registerStandaloneReactionRule(
  sql: postgres.Sql | postgres.TransactionSql,
  workspaceId: string,
  input: StandaloneRuleInput,
): Promise<RegisterStandaloneRuleResult> {
  const id = String(input.id ?? '').trim();
  if (!id) return { ok: false, error: 'standalone rule needs a non-empty id' };
  const on = String(input.on ?? '').trim();
  if (!on) return { ok: false, error: `standalone rule "${id}" needs a non-empty \`on\` trigger` };

  const validated = await validateClassFireTarget(sql, workspaceId, input.fire);
  if (!validated.ok) return { ok: false, error: `standalone rule "${id}": ${validated.error}` };

  const ruleId = `${STANDALONE_RULE_SOURCE}:${id}`;
  registerReactionRule({
    id: ruleId,
    on,
    // A data-match object passes through to @papercusp/rules as-is, exactly as
    // the plugin path does.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...(input.when !== undefined ? { when: input.when as any } : {}),
    fire: input.fire,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    args: (input.args ?? {}) as any,
    ...(input.onlyOnSuccess !== undefined ? { onlyOnSuccess: input.onlyOnSuccess } : {}),
    source: `${STANDALONE_RULE_SOURCE}:${id}`,
    // Sandboxed to the CLASS's capability (D-054 §4), so installing a different
    // provider cannot widen what this rule may do.
    capability: validated.capability,
  } as ReactionRule);

  return {
    ok: true,
    ruleId,
    classRef: validated.target.classRef,
    verb: validated.target.verb,
    capability: validated.capability,
  };
}

/**
 * Drop every standalone-sourced rule. The same full re-sync shape the plugin path
 * uses, so an uninstalled rule cannot leave a stale registration behind.
 * Returns how many were removed.
 */
export function unregisterStandaloneReactionRules(): number {
  let removed = 0;
  for (const r of listReactionRules()) {
    if (typeof r.source === 'string' && r.source.startsWith(`${STANDALONE_RULE_SOURCE}:`)) {
      if (unregisterReactionRule(r.id)) removed += 1;
    }
  }
  return removed;
}
