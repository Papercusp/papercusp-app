/**
 * Capability-string → tier heuristic for the Operator's plugin-tier
 * resolver (Phase 5 polish — `tier-table.json` only knows substrate
 * caps; plugin caps would otherwise all default to `high` (fail-safe)).
 *
 * The pattern catalog at /docs/endpoint-system/tool-catalog shows clear
 * conventions: `*:read` is read-only, `*:write` mutates, `compute:exec:*`
 * runs code, `secrets:*` is sensitive, etc. We codify those conventions
 * so a fresh plugin install gets a sensible tier without the operator
 * having to walk every plugin's manifest.
 *
 * Pure function — no I/O. Safe to call sync from the suggestion parser.
 *
 * Matching is in priority order: the first rule that matches wins.
 * High-risk patterns are listed first so they can't be overridden by
 * a downstream `:read` suffix. (For example `secrets:operator-credentials:read`
 * matches `secrets:*` first and stays `high`.)
 *
 * This is a declarative `@papercusp/rules` `RulesEngine` (adopt-event-rules-engines
 * D-003): the table used to be a hand-rolled `{ match, tier, reason }[]` + a
 * first-match loop — *that was the engine, written longhand*. Now the rules are a
 * serializable `MatchMap` per row (the regex source → a `matches` operator-test),
 * matched in registration order; `heuristicTier` returns the first match. The
 * conventions stay inspectable via `engine.describe()` / `capTierRules()`.
 */

import type { CapabilityTier } from '@papercusp/plugin-sdk';
import { RulesEngine, type Rule } from '@papercusp/rules';

/** The event matched against the cap-tier rules: a single capability string. */
interface CapEvent {
  capability: string;
}

/** Every cap-tier rule fires on this one trigger key (the table is regex-matched, not key-indexed). */
const CAP_TRIGGER = 'capability';

/**
 * The cap-tier rule table. Each rule's `when` is a serializable `MatchMap`
 * (`{ capability: { matches: <regex-source> } }`); `fire` is the resolved tier;
 * `meta.reason` is the human-readable justification. Order = priority (first
 * match wins) — high-risk prefixes precede the generic suffix patterns so a
 * sensitive cap can't be downgraded by a trailing `:read`.
 */
const CAP_TIER_RULES: Rule<CapEvent, CapabilityTier>[] = [
  // ── HIGH (sensitive / destructive / network egress to arbitrary hosts) ──
  { id: 'cap:secrets', on: CAP_TRIGGER, when: { capability: { matches: '^secrets:' } }, fire: 'high', meta: { reason: 'reads/writes secret material' } },
  { id: 'cap:compute-exec', on: CAP_TRIGGER, when: { capability: { matches: '^compute:exec:' } }, fire: 'high', meta: { reason: 'runs arbitrary code' } },
  { id: 'cap:processes', on: CAP_TRIGGER, when: { capability: { matches: '^processes:' } }, fire: 'high', meta: { reason: 'process control (kill, etc.)' } },
  { id: 'cap:harness-dispatch', on: CAP_TRIGGER, when: { capability: { matches: '^harness:dispatch:' } }, fire: 'high', meta: { reason: 'dispatches a role into another harness' } },
  { id: 'cap:pending-events-write', on: CAP_TRIGGER, when: { capability: { matches: '^pending_events:write' } }, fire: 'high', meta: { reason: 'enqueues into the orchestrator event bus' } },
  { id: 'cap:http-fetch', on: CAP_TRIGGER, when: { capability: { matches: '^http:fetch:' } }, fire: 'medium', meta: { reason: 'network egress to a specific host' } },
  { id: 'cap:db-write', on: CAP_TRIGGER, when: { capability: { matches: '^db:write:' } }, fire: 'medium', meta: { reason: 'writes to a substrate-managed table' } },
  { id: 'cap:fs-write', on: CAP_TRIGGER, when: { capability: { matches: '^fs:write:' } }, fire: 'medium', meta: { reason: 'writes to the filesystem' } },
  { id: 'cap:plugins-write', on: CAP_TRIGGER, when: { capability: { matches: '^plugins:write' } }, fire: 'medium', meta: { reason: 'mutates plugin runtime state' } },
  { id: 'cap:autoloop-write', on: CAP_TRIGGER, when: { capability: { matches: '^autoloop:write' } }, fire: 'medium', meta: { reason: 'changes the orchestrator autoloop state' } },
  { id: 'cap:omp-write', on: CAP_TRIGGER, when: { capability: { matches: '^omp:write' } }, fire: 'medium', meta: { reason: 'mutates omp/CLI config' } },

  // ── Patterned suffixes (after the high-risk prefixes above so they
  // don't accidentally downgrade a sensitive capability) ──
  { id: 'cap:write-suffix', on: CAP_TRIGGER, when: { capability: { matches: ':write(?::|$)' } }, fire: 'medium', meta: { reason: 'mutates state' } },
  { id: 'cap:read-suffix', on: CAP_TRIGGER, when: { capability: { matches: ':read(?::|$)' } }, fire: 'low', meta: { reason: 'read-only' } },
  { id: 'cap:list-suffix', on: CAP_TRIGGER, when: { capability: { matches: ':list$' } }, fire: 'low', meta: { reason: 'enumeration' } },
  { id: 'cap:get-suffix', on: CAP_TRIGGER, when: { capability: { matches: ':get$' } }, fire: 'low', meta: { reason: 'single read' } },

  // ── Tool families that the catalog groups but which don't follow the
  //   prefix conventions. We classify them based on observed behavior. ──
  { id: 'cap:design-mutate', on: CAP_TRIGGER, when: { capability: { matches: '^tools:design:(submit|record|validate|lint)' } }, fire: 'medium', meta: { reason: 'design-system mutation' } },
  { id: 'cap:design-read', on: CAP_TRIGGER, when: { capability: { matches: '^tools:design:' } }, fire: 'low', meta: { reason: 'design-system read' } },
  { id: 'cap:gitnexus-mutate', on: CAP_TRIGGER, when: { capability: { matches: '^tools:gitnexus:(rename|.*sync|api_impact|impact|detect_changes)' } }, fire: 'medium', meta: { reason: 'gitnexus mutation' } },
  { id: 'cap:gitnexus-query', on: CAP_TRIGGER, when: { capability: { matches: '^tools:gitnexus:' } }, fire: 'low', meta: { reason: 'gitnexus query' } },
  { id: 'cap:firecrawl', on: CAP_TRIGGER, when: { capability: { matches: '^tools:firecrawl:' } }, fire: 'medium', meta: { reason: 'web scraping (egress + cost)' } },
  { id: 'cap:web-fetch', on: CAP_TRIGGER, when: { capability: { matches: '^tools:web:fetch' } }, fire: 'medium', meta: { reason: 'web fetch' } },
  { id: 'cap:repomix', on: CAP_TRIGGER, when: { capability: { matches: '^tools:repomix:' } }, fire: 'low', meta: { reason: 'local pack' } },
  { id: 'cap:code2prompt', on: CAP_TRIGGER, when: { capability: { matches: '^tools:code2prompt:' } }, fire: 'low', meta: { reason: 'local pack' } },
  { id: 'cap:orchestrator-spawn', on: CAP_TRIGGER, when: { capability: { matches: '^tools:orchestrator:spawn:' } }, fire: 'high', meta: { reason: 'spawns another agent' } },

  // ── Single-token convenience caps ──
  { id: 'cap:search', on: CAP_TRIGGER, when: { capability: { matches: '^search:' } }, fire: 'low', meta: { reason: 'search query' } },
  { id: 'cap:audit', on: CAP_TRIGGER, when: { capability: { matches: '^audit:' } }, fire: 'low', meta: { reason: 'audit-log read' } },
];

const ENGINE = new RulesEngine<CapEvent, CapabilityTier>({ keyOf: () => CAP_TRIGGER }).addAll(CAP_TIER_RULES);

export interface HeuristicResult {
  tier: CapabilityTier;
  reason: string;
}

/**
 * Classify a capability by pattern. Returns null when no rule matches —
 * the caller should fall back to the substrate fail-safe (`high`).
 */
export function heuristicTier(capability: string): HeuristicResult | null {
  const [first] = ENGINE.match({ capability });
  if (!first) return null;
  return { tier: first.fire, reason: (first.rule.meta as { reason: string }).reason };
}

/** Inspectability: the reactive graph of cap-tier rules (`{ on, ruleId, fire }`). */
export function capTierRules(): ReturnType<RulesEngine<CapEvent, CapabilityTier>['describe']> {
  return ENGINE.describe();
}
