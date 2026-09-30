/**
 * The SQL-READ CENSUS — the recurring substitution audit
 * (plan `sql-escape-tool-routing-2026-08-12`, P-008).
 *
 * ── WHY A CENSUS AND NOT A DAILY AGENT RUN [owner 2026-08-12] ────────────────
 * The obvious shape for "keep auditing the routing story" is a daily agent turn.
 * The owner chose against it on measured grounds: `dev:pg_query` volume on this
 * box swings between 10 and 3,474 calls/day with fleet activity, so most daily
 * agent turns would read the same corpus and conclude nothing changed, at full
 * turn cost. The census needs no judgement at all — it normalises, extracts,
 * joins and counts — so it runs deterministically every night, and an agent is
 * woken ONLY when one of three thresholds is crossed.
 *
 * ── THE THREE ALARMS ─────────────────────────────────────────────────────────
 *  (a) UNCOVERED DEMAND   — a cluster no verb claims crosses N distinct agents.
 *  (b) VERDICT DRIFT      — a claiming pair that WAS `equivalent` no longer is.
 *  (c) NO FALL AFTER SHIP — a cluster gained a routing row, the grace period
 *      passed, and its traffic did not fall. This is the important one: it is
 *      how you learn a fix did not take. Every other measure here tells you
 *      about a gap; only (c) tells you about a FAILED REPAIR.
 *
 * ── WHY (c) FORCES A STORED HISTORY ──────────────────────────────────────────
 * `harness_shared.tool_invocations` is pruned to 14 days. A routing row that
 * shipped more than a fortnight ago has NO pre-ship window left in the ledger, so
 * (c) cannot be recomputed on demand — the evidence is gone, not merely
 * expensive. That, and nothing else, is why `harness_shared.sql_read_census`
 * exists and why the census writes on quiet nights too. See migration 811 for the
 * full argument, including why `tool_usage_rollup` and the
 * `bash_tool_substitutions.baseline_*` columns cannot stand in.
 *
 * ── WHAT IS PURE HERE ────────────────────────────────────────────────────────
 * Everything in this file. The corpus read, the upsert and the escalation live in
 * `harness/routines/sql-read-census-action.ts`; these functions take arrays and
 * return arrays, so each alarm is provable by feeding it a synthetic crossing and
 * its control — which is the only thing that distinguishes a detector that works
 * from a detector that has merely never fired (D-008 §3).
 */

import { plainSingleRelationRead } from '../pg-read-query';
import { scrubIdentity } from './corpus';
import { SQL_READ_NO_PAIR_DECISIONS } from './pairs';
import { sqlPairClaimsAtom } from './sql-corpus';
import type {
  DeliberateNoPairDecision,
  EquivalenceVerdict,
  SampledCommand,
  SqlSubstitutionPair,
} from './types';

/**
 * Schemas whose qualifier is STYLE rather than meaning, so `harness_shared.work_items`
 * and `work_items` are ONE cluster.
 *
 * Everywhere else the schema is load-bearing and the qualified spelling is kept:
 * `information_schema` has tables literally called `columns` and `tables`, and
 * folding those to their bare names would merge catalog traffic with any user
 * table that happens to share the name — the same hazard `relationMatches` in
 * sql-corpus.ts pays a qualified-only match to avoid.
 *
 * ⚠ This is a GROUPING key, never a claim test. Whether a pair covers an atom
 * stays entirely with {@link sqlPairClaimsAtom} (D-003's single judgement); this
 * only decides which counter the atom increments.
 */
export const BARE_QUALIFIER_SCHEMAS: ReadonlySet<string> = new Set(['harness_shared', 'public']);

/** The census cluster key for a resolved read: bare inside a style-only schema, qualified elsewhere. */
export function censusRelationKey(read: { relation: string; asWritten: string }): string {
  const written = read.asWritten.toLowerCase();
  const dot = written.indexOf('.');
  if (dot < 0) return written;
  return BARE_QUALIFIER_SCHEMAS.has(written.slice(0, dot)) ? read.relation.toLowerCase() : written;
}

/** The same key for a pair's DECLARED relation, so "does any pair speak about this relation" is symmetric. */
export function censusRelationKeyOfDeclared(declared: string): string {
  const written = declared.toLowerCase();
  const dot = written.indexOf('.');
  if (dot < 0) return written;
  return BARE_QUALIFIER_SCHEMAS.has(written.slice(0, dot)) ? written.slice(dot + 1) : written;
}

/**
 * Separator for the composite (relation, intent) map key.
 *
 * Printable on purpose. An earlier draft used a NUL, which a byte-level guard had
 * to catch: an invisible control character in source is indistinguishable from a
 * space to every reader and to the Edit tool, and neither a relation nor an intent
 * label can contain ` :: `, so the printable form is strictly better.
 */
const KEY_SEP = ' :: ';

/** How much of an exemplar query is kept for an escalation body. */
export const SAMPLE_ATOM_MAX_CHARS = 300;

/** One (relation, claiming intent) cluster over the census window. */
export interface CensusCluster {
  relation: string;
  /** The claiming pair's intent, or null when nothing claimed these atoms. */
  intentLabel: string | null;
  /**
   * Does ANY pair speak about this relation? Disambiguates the two NULL intents:
   * false = no verb covers this relation at all; true = the relation is served but
   * this query SHAPE is not — a materially different finding, and the one a
   * responder is most likely to mis-triage as "already done".
   */
  relationHasPairs: boolean;
  /** True when the relation-level NULL intent is a measured, registry-backed no-pair decision. */
  deliberatelyUnpaired: boolean;
  /** The decision and baseline carried through to persistence when deliberate. */
  deliberateNoPairDecision: DeliberateNoPairDecision | null;
  coveringTool: string | null;
  equivalenceVerdict: EquivalenceVerdict | null;
  /** Distinct AGENTS (coord owner ids) in this cluster — the D-007 ranking unit. */
  distinctAgents: number;
  calls: number;
  /** Distinct agents across EVERY cluster of this relation, de-duplicated. */
  relationDistinctAgents: number;
  /** Calls across every cluster of this relation. */
  relationCalls: number;
  /** One identity-scrubbed exemplar, truncated. */
  sampleAtom: string | null;
}

/**
 * PURE: fold sampled queries into census clusters.
 *
 * An atom that is not a PLAIN SINGLE-RELATION READ is dropped, not counted as
 * uncovered. That asymmetry is deliberate and is the whole reason the census can
 * be trusted to name a gap: a cross-table join or a group-by is `dev:pg_query`
 * working as intended, and counting it as unmet demand would manufacture a
 * routing gap for every analytic query on the box.
 *
 * The exemplar is the FIRST atom seen in each cluster. Callers pass the corpus
 * newest-first, so that is the most recent spelling — and it makes the output a
 * pure function of the input order rather than of a sampler.
 */
export function computeSqlCensus(
  atoms: readonly SampledCommand[],
  pairs: readonly SqlSubstitutionPair[],
  noPairDecisions: readonly DeliberateNoPairDecision[] = SQL_READ_NO_PAIR_DECISIONS,
): CensusCluster[] {
  const pairRelations = new Set(pairs.map((p) => censusRelationKeyOfDeclared(p.relation)));
  const decisionsByRelation = new Map(
    noPairDecisions.map((decision) => [censusRelationKeyOfDeclared(decision.relation), decision]),
  );

  interface Acc {
    relation: string;
    intentLabel: string | null;
    coveringTool: string | null;
    verdict: EquivalenceVerdict | null;
    agents: Set<string>;
    calls: number;
    sampleAtom: string | null;
  }
  const byCluster = new Map<string, Acc>();
  const relAgents = new Map<string, Set<string>>();
  const relCalls = new Map<string, number>();

  for (const entry of atoms) {
    const read = plainSingleRelationRead(entry.atom);
    if (!read) continue;
    const relation = censusRelationKey(read);

    const claiming = pairs.find((p) => sqlPairClaimsAtom(p, entry.atom)) ?? null;
    const intentLabel = claiming?.intentLabel ?? null;
    const key = relation + KEY_SEP + (intentLabel ?? '');

    let acc = byCluster.get(key);
    if (!acc) {
      acc = {
        relation,
        intentLabel,
        coveringTool: claiming?.toolName ?? null,
        verdict: claiming?.expectedVerdict ?? null,
        agents: new Set<string>(),
        calls: 0,
        sampleAtom: scrubIdentity(entry.atom).slice(0, SAMPLE_ATOM_MAX_CHARS),
      };
      byCluster.set(key, acc);
    }
    acc.agents.add(entry.sid);
    acc.calls += 1;

    let ra = relAgents.get(relation);
    if (!ra) {
      ra = new Set<string>();
      relAgents.set(relation, ra);
    }
    ra.add(entry.sid);
    relCalls.set(relation, (relCalls.get(relation) ?? 0) + 1);
  }

  const out: CensusCluster[] = [];
  for (const acc of byCluster.values()) {
    // A deliberate no-pair decision is relation-level. Do not let it mask an
    // unserved SHAPE on a relation that already has a positive pair.
    const deliberateNoPairDecision =
      acc.intentLabel === null && !pairRelations.has(acc.relation)
        ? (decisionsByRelation.get(acc.relation) ?? null)
        : null;
    out.push({
      relation: acc.relation,
      intentLabel: acc.intentLabel,
      relationHasPairs: pairRelations.has(acc.relation),
      deliberatelyUnpaired: deliberateNoPairDecision !== null,
      deliberateNoPairDecision,
      coveringTool: acc.coveringTool,
      equivalenceVerdict: acc.verdict,
      distinctAgents: acc.agents.size,
      calls: acc.calls,
      relationDistinctAgents: relAgents.get(acc.relation)?.size ?? acc.agents.size,
      relationCalls: relCalls.get(acc.relation) ?? acc.calls,
      sampleAtom: acc.sampleAtom,
    });
  }
  // Deterministic ordering so a fixture diff means the CORPUS moved.
  out.sort(
    (a, b) =>
      b.distinctAgents - a.distinctAgents ||
      a.relation.localeCompare(b.relation) ||
      (a.intentLabel ?? '').localeCompare(b.intentLabel ?? ''),
  );
  return out;
}

// ── (a) uncovered demand ─────────────────────────────────────────────────────

export interface UncoveredCrossing {
  relation: string;
  distinctAgents: number;
  calls: number;
  relationHasPairs: boolean;
  sampleAtom: string | null;
}

/**
 * PURE: clusters no pair claims, at or above `threshold` distinct agents.
 *
 * `threshold <= 0` is the KILL SWITCH and returns nothing — the same `<=0`
 * convention the sibling watchdog floors use, so disabling a noisy leg never
 * requires a code change.
 */
export function evaluateUncoveredDemand(
  clusters: readonly CensusCluster[],
  threshold: number,
): UncoveredCrossing[] {
  if (!Number.isFinite(threshold) || threshold <= 0) return [];
  return clusters
    .filter((c) => c.intentLabel === null && !c.deliberatelyUnpaired && c.distinctAgents >= threshold)
    .map((c) => ({
      relation: c.relation,
      distinctAgents: c.distinctAgents,
      calls: c.calls,
      relationHasPairs: c.relationHasPairs,
      sampleAtom: c.sampleAtom,
    }))
    .sort((a, b) => b.distinctAgents - a.distinctAgents || a.relation.localeCompare(b.relation));
}

// ── (a2) deliberate no-pair drift ───────────────────────────────────────────

export interface DeliberateNoPairDrift {
  relation: string;
  decisionRef: string;
  baselineDistinctAgents: number;
  currentDistinctAgents: number;
  thresholdDistinctAgents: number;
  sampleAtom: string | null;
}

/**
 * PURE: re-raise a deliberate no-pair decision when independent-agent demand
 * materially exceeds the measured population that justified it. Calls are
 * intentionally ignored here: D-007 established that one polling session can
 * dominate call volume, so only independent agents can reopen the decision.
 */
export function evaluateDeliberateNoPairDrift(
  clusters: readonly CensusCluster[],
): DeliberateNoPairDrift[] {
  const out: DeliberateNoPairDrift[] = [];
  for (const cluster of clusters) {
    const decision = cluster.deliberateNoPairDecision;
    if (!cluster.deliberatelyUnpaired || !decision) continue;
    const threshold =
      decision.reRaiseAtDistinctAgents ?? Math.ceil(decision.baseline.distinctAgents * 1.5);
    if (cluster.relationDistinctAgents < threshold) continue;
    out.push({
      relation: cluster.relation,
      decisionRef: decision.decisionRef,
      baselineDistinctAgents: decision.baseline.distinctAgents,
      currentDistinctAgents: cluster.relationDistinctAgents,
      thresholdDistinctAgents: threshold,
      sampleAtom: cluster.sampleAtom,
    });
  }
  return out.sort(
    (a, b) => b.currentDistinctAgents - a.currentDistinctAgents || a.relation.localeCompare(b.relation),
  );
}

// ── (b) verdict drift ────────────────────────────────────────────────────────

/** One prior-night census row, as read back from `harness_shared.sql_read_census`. */
export interface PriorCensusRow {
  ranOn: string;
  relation: string;
  intentLabel: string | null;
  coveringTool: string | null;
  equivalenceVerdict: EquivalenceVerdict | null;
  distinctAgents: number;
  relationDistinctAgents: number;
}

export interface VerdictDrift {
  relation: string;
  intentLabel: string;
  coveringTool: string | null;
  previousVerdict: EquivalenceVerdict;
  currentVerdict: EquivalenceVerdict;
}

/**
 * PURE: a claiming pair that WAS `equivalent` on the most recent prior night and
 * is not tonight.
 *
 * Deliberately requires a BEFORE. A pair recorded non-equivalent from the start
 * is a durable negative finding (the registry keeps those on purpose — see
 * `pairs/index.ts` on `PROCESS_PAIRS`), not a regression, and paging nightly
 * about a conclusion someone already reached is exactly the noise that teaches a
 * fleet to ignore an alarm. "Drifts OFF equivalent" means it moved.
 */
export function evaluateVerdictDrift(
  tonight: readonly CensusCluster[],
  prior: readonly PriorCensusRow[],
): VerdictDrift[] {
  const priorByCluster = new Map<string, PriorCensusRow>();
  for (const row of prior) {
    if (row.intentLabel === null) continue;
    const key = row.relation + KEY_SEP + row.intentLabel;
    const held = priorByCluster.get(key);
    if (!held || held.ranOn < row.ranOn) priorByCluster.set(key, row);
  }

  const out: VerdictDrift[] = [];
  for (const c of tonight) {
    if (c.intentLabel === null || c.equivalenceVerdict === null) continue;
    const before = priorByCluster.get(c.relation + KEY_SEP + c.intentLabel);
    if (!before || before.equivalenceVerdict !== 'equivalent') continue;
    if (c.equivalenceVerdict === 'equivalent') continue;
    out.push({
      relation: c.relation,
      intentLabel: c.intentLabel,
      coveringTool: c.coveringTool,
      previousVerdict: before.equivalenceVerdict,
      currentVerdict: c.equivalenceVerdict,
    });
  }
  return out.sort((a, b) => a.relation.localeCompare(b.relation));
}

// ── (c) no fall after ship ───────────────────────────────────────────────────

export interface NoFallCrossing {
  relation: string;
  /** The night the covering tool first appeared for this relation, per the census's own history. */
  shippedOn: string;
  coveringTool: string | null;
  preShipAgents: number;
  currentAgents: number;
  /** Negative when traffic GREW. */
  fallPct: number;
  requiredFallPct: number;
  graceDays: number;
}

export interface NoFallOptions {
  /** Days after the ship night before the check applies. Default 14. */
  graceDays?: number;
  /** Fraction of pre-ship distinct agents that must have gone away. Default 0.3. */
  requiredFallPct?: number;
  /** Today, ISO date (UTC) — injected so the decider is pure. */
  today: string;
}

/** Whole days between two ISO dates (UTC), b - a. */
function daysBetween(a: string, b: string): number {
  const ms = Date.parse(a + 'T00:00:00Z');
  const msB = Date.parse(b + 'T00:00:00Z');
  return Math.floor((msB - ms) / 86_400_000);
}

/**
 * PURE: relations whose routing row shipped, whose grace period has passed, and
 * whose traffic did not fall.
 *
 * ── "SHIPPED" IS OBSERVED, NEVER ASSERTED ────────────────────────────────────
 * The ship night is the first night in the census's OWN history where this
 * relation's covering tool went absent → present. There is deliberately no
 * hand-maintained `shippedAt` date on the pair: a date someone types is a claim
 * that drifts silently from what actually happened, while the transition is a
 * measurement that cannot.
 *
 * The cost of that choice is stated rather than hidden: a relation already
 * covered on the census's FIRST night has no observed transition, so (c) is
 * UNKNOWN for it — it is skipped, never reported as passing. An unknown rendered
 * as a pass is how a fix that never took gets a clean bill of health.
 *
 * Measured in DISTINCT AGENTS, not calls (D-007): a call count can be one agent's
 * polling loop, so a single busy agent could mask an entire fleet's migration or
 * fake a regression on its own.
 */
export function evaluateNoFallAfterShip(
  tonight: readonly CensusCluster[],
  history: readonly PriorCensusRow[],
  opts: NoFallOptions,
): NoFallCrossing[] {
  const graceDays = opts.graceDays ?? 14;
  const requiredFallPct = opts.requiredFallPct ?? 0.3;
  if (requiredFallPct <= 0) return [];

  // Relation-level history: one entry per (relation, night), carrying whether ANY
  // cluster of that relation had a covering tool and the de-duplicated agent count.
  interface Night {
    ranOn: string;
    covered: boolean;
    agents: number;
    coveringTool: string | null;
  }
  const byRelation = new Map<string, Map<string, Night>>();
  for (const row of history) {
    let nights = byRelation.get(row.relation);
    if (!nights) {
      nights = new Map<string, Night>();
      byRelation.set(row.relation, nights);
    }
    const night = nights.get(row.ranOn) ?? {
      ranOn: row.ranOn,
      covered: false,
      agents: row.relationDistinctAgents,
      coveringTool: null,
    };
    night.agents = Math.max(night.agents, row.relationDistinctAgents);
    if (row.coveringTool !== null) {
      night.covered = true;
      night.coveringTool ??= row.coveringTool;
    }
    nights.set(row.ranOn, night);
  }

  const currentByRelation = new Map<string, { agents: number; coveringTool: string | null }>();
  for (const c of tonight) {
    const held = currentByRelation.get(c.relation);
    currentByRelation.set(c.relation, {
      agents: Math.max(held?.agents ?? 0, c.relationDistinctAgents),
      coveringTool: held?.coveringTool ?? c.coveringTool,
    });
  }

  const out: NoFallCrossing[] = [];
  for (const [relation, nightsMap] of byRelation) {
    const nights = [...nightsMap.values()].sort((a, b) => a.ranOn.localeCompare(b.ranOn));
    // The transition: the first covered night that FOLLOWS an uncovered one.
    let shipIdx = -1;
    for (let i = 1; i < nights.length; i += 1) {
      if (nights[i].covered && !nights[i - 1].covered) {
        shipIdx = i;
        break;
      }
    }
    if (shipIdx < 0) continue; // never observed shipping — UNKNOWN, not a pass.

    const shippedOn = nights[shipIdx].ranOn;
    if (daysBetween(shippedOn, opts.today) < graceDays) continue;

    const preShipAgents = nights[shipIdx - 1].agents;
    if (preShipAgents <= 0) continue;
    const current = currentByRelation.get(relation);
    if (!current) continue; // no traffic at all tonight — the best possible fall.

    const fallPct = (preShipAgents - current.agents) / preShipAgents;
    if (fallPct >= requiredFallPct) continue;

    out.push({
      relation,
      shippedOn,
      coveringTool: current.coveringTool ?? nights[shipIdx].coveringTool,
      preShipAgents,
      currentAgents: current.agents,
      fallPct,
      requiredFallPct,
      graceDays,
    });
  }
  return out.sort((a, b) => b.currentAgents - a.currentAgents || a.relation.localeCompare(b.relation));
}

// ── the escalation ───────────────────────────────────────────────────────────

/** How many uncovered clusters are NAMED in an escalation body before it summarises the rest. */
export const ESCALATION_TOP_K = 8;

export interface CensusAlarms {
  uncovered: UncoveredCrossing[];
  drift: VerdictDrift[];
  noFall: NoFallCrossing[];
  deliberateNoPairDrift?: DeliberateNoPairDrift[];
}

export interface CensusEscalation {
  summary: string;
  body: string;
  /** Stable per-class debounce keys, so a persistent gap does not re-page nightly. */
  scopeKeys: string[];
}

/**
 * PURE: ONE escalation for the whole night, or null when nothing crossed.
 *
 * One, not one-per-crossing, for a measured reason: a 7-day probe of this box
 * already shows ~15 uncovered relations above 10 distinct agents (`routines` 112,
 * `tool_invocations` 100, `adv_sessions` 53, `coord_presence` 53 …). Fifteen
 * simultaneous pages on the first run would not be fifteen times the signal — it
 * would teach the fleet that this alarm is noise, permanently, and the (c) alarm
 * that actually matters would die with it.
 *
 * The body restates D-006 and D-007 because the responder's first move is a
 * SERVABILITY judgement, not a coding task: a pair claims what its verb can ASK,
 * not its relation's traffic, and a cluster is ranked by distinct agents before
 * anyone asks whether a verb could serve it.
 */
export function buildCensusEscalation(alarms: CensusAlarms, windowDays: number): CensusEscalation | null {
  const { uncovered, drift, noFall } = alarms;
  const deliberateNoPairDrift = alarms.deliberateNoPairDrift ?? [];
  if (uncovered.length === 0 && drift.length === 0 && noFall.length === 0 && deliberateNoPairDrift.length === 0) {
    return null;
  }

  const parts: string[] = [];
  const scopeKeys: string[] = [];
  const headline: string[] = [];

  if (deliberateNoPairDrift.length > 0) {
    scopeKeys.push('deliberate-no-pair-drift');
    headline.push(`${deliberateNoPairDrift.length} deliberate no-pair decision(s) exceeded their agent baseline`);
    parts.push(
      `## (a2) DELIBERATE NO-PAIR DEMAND DRIFT — ${deliberateNoPairDrift.length}\n\n` +
        `These relations were intentionally left without a routing pair, but independent-agent demand ` +
        `now exceeds the measured decision baseline. Re-evaluate the decision before adding a pair.\n\n` +
        deliberateNoPairDrift
          .map(
            (d) =>
              `- \`${d.relation}\` — decision \`${d.decisionRef}\`, ${d.currentDistinctAgents} independent agents ` +
              `(baseline ${d.baselineDistinctAgents}, re-raise threshold ${d.thresholdDistinctAgents})` +
              (d.sampleAtom ? `\n  e.g. \`${d.sampleAtom}\`` : ''),
          )
          .join('\n'),
    );
  }

  if (noFall.length > 0) {
    scopeKeys.push('no-fall');
    headline.push(`${noFall.length} routing row(s) whose traffic did NOT fall`);
    parts.push(
      `## (c) TRAFFIC DID NOT FALL AFTER THE ROUTING ROW SHIPPED — ${noFall.length}\n\n` +
        `This is the alarm that says a fix did not take. Each row shipped, the grace period ` +
        `passed, and the same relation is still being hand-queried by as many agents.\n\n` +
        noFall
          .map(
            (n) =>
              `- \`${n.relation}\` -> ${n.coveringTool ?? '(tool unknown)'} — shipped ${n.shippedOn}, ` +
              `${n.preShipAgents} agents before -> ${n.currentAgents} now ` +
              `(${(n.fallPct * 100).toFixed(0)}% fall; needed >=${(n.requiredFallPct * 100).toFixed(0)}% ` +
              `within ${n.graceDays}d). Ask WHICH of: the verb cannot actually serve the shape agents ` +
              `write, the routing row is not reaching them, or the guidance names a different question ` +
              `than the one they have.`,
          )
          .join('\n'),
    );
  }

  if (drift.length > 0) {
    scopeKeys.push('verdict-drift');
    headline.push(`${drift.length} pair verdict(s) drifted off equivalent`);
    parts.push(
      `## (b) A PAIR'S VERDICT DRIFTED OFF \`equivalent\` — ${drift.length}\n\n` +
        `The routing row is still live and agents are still being pointed at a tool the evidence no ` +
        `longer says is a clean substitute.\n\n` +
        drift
          .map(
            (d) =>
              `- \`${d.relation}\` / \`${d.intentLabel}\` -> ${d.coveringTool ?? '(unknown)'}: ` +
              `\`${d.previousVerdict}\` -> \`${d.currentVerdict}\`. Either widen the tool until the ` +
              `verdict is earned again, or retire the row — never leave an advisory out-running its ` +
              `coverage (D-001).`,
          )
          .join('\n'),
    );
  }

  if (uncovered.length > 0) {
    scopeKeys.push('uncovered');
    headline.push(`${uncovered.length} uncovered cluster(s)`);
    const shown = uncovered.slice(0, ESCALATION_TOP_K);
    const rest = uncovered.length - shown.length;
    parts.push(
      `## (a) UNCOVERED DEMAND — ${uncovered.length} cluster(s) over the last ${windowDays}d\n\n` +
        shown
          .map(
            (u) =>
              `- \`${u.relation}\` — ${u.distinctAgents} distinct agents, ${u.calls} calls` +
              (u.relationHasPairs
                ? ` ⚠ this relation IS already served by a verb — it is this query SHAPE that is not, ` +
                  `so the answer is usually to widen the existing pair, not to add one`
                : '') +
              (u.sampleAtom ? `\n  e.g. \`${u.sampleAtom}\`` : ''),
          )
          .join('\n') +
        (rest > 0 ? `\n\n…and ${rest} more above the threshold (ranked by distinct agents).` : ''),
    );
  }

  const body =
    parts.join('\n\n') +
    `\n\n---\nBefore adding ANY routing pair, apply the two rulings this plan already settled:\n` +
    `- **D-006** — a pair claims what its VERB CAN ASK, not its relation's traffic. A verb that answers ` +
    `one question about a busy table does not cover the table.\n` +
    `- **D-007** — rank by distinct SESSIONS/agents, then check SERVABILITY. A call count can be one ` +
    `agent's polling loop.\n\n` +
    `Evidence: \`harness_shared.sql_read_census\` (one row per night per cluster). The census is ` +
    `deterministic and needs no agent — you were woken only because a threshold moved.`;

  return {
    summary: `SQL-read census: ${headline.join(', ')}`,
    body,
    scopeKeys,
  };
}
