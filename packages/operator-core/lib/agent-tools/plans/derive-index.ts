/**
 * `deriveIndexFromContent` + the derived-index shapes it returns, as a LEAF module.
 *
 * Extracted from `./source.ts` (WI-2141279). `source.ts` is the plans DATA-ACCESS
 * layer: it reaches `@papercusp/db-org`, the harness registry, hive federation and
 * `fleet-drained-events` — and through that last edge the whole
 * coordination → locks → db-org subgraph. Deriving a plan index from markdown needs
 * NONE of that: it is a pure function over `parsePlan` plus two small parsers. So
 * every consumer that only wanted the derivation was importing the entire data layer
 * to get it.
 *
 * That was not merely wasteful — it broke a gate. On 2026-09-01T03:12Z
 * `sync/hyperbee/projections/harness-plans.ts` began importing
 * `deriveIndexFromContent` from `./source`, which placed
 * `agent-tools/locks/configure.ts` in the import graph of the perf `peer-child`:
 *
 *   peer-child → sync/hyperbee/boot → projections/register-all
 *     → projections/harness-plans → agent-tools/plans/source → fleet-drained-events
 *     → events/await/engine → agent-tools/coordination/messages
 *     → coordination/audience-host → agent-tools/locks/su-lock-store
 *     → agent-tools/locks/configure
 *
 * `configure.ts` calls `setAdminPoolStatementTimeoutProvider` at MODULE TOP LEVEL,
 * and a perf peer child runs under `perf/no-pg-register.mjs`, which stubs
 * `@papercusp/db-org` so that ANY access throws (deliberately — a perf peer must
 * never query Postgres; see `perf/no-pg-hooks.mjs`). The child therefore died during
 * import and never emitted `ready`, so `perf/child-driver.test.ts` timed out its
 * 30s wait and went red on the green-checkpoint gate from that commit onward —
 * last pass 2026-09-01T02:29Z, first of an unbroken fail run 03:12Z.
 *
 * Keeping this a LEAF is the durable guard rather than a one-off unwind: a consumer
 * that only needs the derivation can no longer re-acquire the data layer (and with
 * it a top-level PG side effect) by accident. `source.ts` re-exports these four
 * names, so every existing importer is unaffected.
 */
import { parsePlan, type PlanStatus } from './parser';
import { deriveOwnerGateMarkers } from './owner-gate-marker';
import { parsePromotePolicy, type ParsePromoteResult } from './promote-policy';

/** A plan item as stored in the derived `items` jsonb column (Stage 3 normalize). */
export interface PlanIndexItem {
  id: string;
  status: string;
  text: string;
  importance: string;
  blockedBy: string[];
  decisionRefs: string[];
  phase: string | null;
  /** Optional marker parsed from plan prose for owner-gated items. */
  ownerGateMarker?: string | null;
}

/** A decision as stored in the derived `decisions` jsonb column (Stage 3 normalize). */
export interface PlanIndexDecision {
  id: string;
  title: string;
  body: string;
  date: string | null;
  itemRefs: string[];
  /** Reverse authority edges parsed from canonical `Affects:` metadata. */
  affects?: string[];
}

/**
 * Frontmatter + structured derived index for a plan, recomputed from the
 * canonical markdown on every write + backfill (D-006 — content is canonical;
 * these are a queryable derived index).
 */
export interface PlanIndex {
  title: string | null;
  status: PlanStatus | null;
  created: string | null;
  updated: string | null;
  owner: string | null;
  initiative: string | null;
  /** Template TYPE (frontmatter-derived, mirrors `initiative`) — P-004/P-005. */
  template: string | null;
  supersedes: string[];
  supersededBy: string | null;
  isLegacy: boolean;
  // Stage-3 structured index (normalize).
  items: PlanIndexItem[];
  decisions: PlanIndexDecision[];
  nowState: string | null;
  nowNext: string | null;
  /** v2 P-001: the operator-side parsed `## Promote` policy ({ policy, warnings }), recomputed
   *  on every write so consumers read it structured instead of re-parsing the markdown. */
  promotePolicy: ParsePromoteResult;
}

/** Parse a plan body into its derived index (frontmatter + structured sections). */
export function deriveIndexFromContent(content: string): PlanIndex {
  const p = parsePlan(content);
  const fm = p.frontmatter;
  const ownerGateMarkers = deriveOwnerGateMarkers(p.items, p.now?.raw, p.decisions);
  return {
    title: fm.title ?? null,
    status: fm.status ?? null,
    created: fm.created ?? null,
    updated: fm.updated ?? null,
    owner: fm.owner ?? null,
    initiative: fm.initiative ?? null,
    // P-004/P-005: the template TYPE is frontmatter-derived (like initiative); the
    // structured template_data is written separately + never parsed from frontmatter.
    template: fm.template ?? null,
    supersedes: fm.supersedes ?? [],
    supersededBy: fm.supersededBy ?? null,
    isLegacy: p.isLegacy,
    items: p.items.map((i) => ({
      id: i.id,
      status: i.storedStatus,
      text: i.text,
      importance: i.importance,
      blockedBy: i.blockedBy,
      decisionRefs: i.decisionRefs,
      phase: i.phase,
      ownerGateMarker: ownerGateMarkers.get(i.id) ?? null,
    })),
    decisions: p.decisions.map((d) => ({
      id: d.id,
      title: d.title,
      body: d.body,
      date: d.date,
      itemRefs: d.itemRefs,
      affects: d.affects ?? [],
    })),
    nowState: p.now?.state ?? null,
    nowNext: p.now?.next ?? null,
    // v2 P-001: parse the `## Promote` policy ONCE here (operator-side; the pure @papercusp/plan-parser
    // has no YAML dep) so the write stores it structured + the consumers (lint/expand-generators/promote)
    // stop re-parsing the markdown at read time.
    promotePolicy: parsePromotePolicy(content),
  };
}
