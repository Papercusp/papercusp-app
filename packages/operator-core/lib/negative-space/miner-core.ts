/**
 * miner-core.ts — the negative-space miner's pure core
 * (self-learning-frontier-2026-06-12 P-010 / FB-04).
 *
 * "Negative space" = the knowledge agents LOOKED for and didn't find: a
 * zero-hit docs:search / plans:search / memory:search is a recorded demand
 * signal for a doc page, plan pointer, or memory that doesn't exist. This
 * module turns the raw zero-hit invocation rows (mined from
 * harness_shared.tool_invocations by scan.ts) into a deduped DEMAND MAP and
 * picks the capped candidate set worth filing as kind=change improvements.
 *
 * Pure on purpose (no PG, no clock): normalization, aggregation, and the
 * fire-bar selection are all unit-testable; scan.ts owns the SQL + the
 * capture-core glue. Mirrors the watchdog's split (collectors pure,
 * runWatchdogTick glued).
 */

export type DemandSurface = 'docs' | 'memory' | 'plans';

/** tool_name → demand surface; null = not a mined search tool. */
export function surfaceOfTool(toolName: string): DemandSurface | null {
  switch (toolName) {
    case 'docs:search':
      return 'docs';
    case 'memory:search':
      return 'memory';
    case 'plans:search':
      return 'plans';
    default:
      return null;
  }
}

/** One zero-hit search invocation, as scan.ts reads it off tool_invocations. */
export interface ZeroHitRow {
  toolName: string;
  /** Raw query string (args_json->>'query'). */
  query: string;
  /** Caller identity for the distinct-agents count (spawn_id, role fallback). */
  agent: string;
  /** ISO timestamp of the invocation. */
  invokedAt: string;
}

/** One demand-map entry: a (surface, normalized query) with its evidence. */
export interface DemandEntry {
  surface: DemandSurface;
  queryNorm: string;
  /** Most recent raw spelling of the query (display + capture body). */
  exampleQuery: string;
  missCount: number;
  distinctAgents: number;
  firstMissedAt: string;
  lastMissedAt: string;
  /** engineer_issues id once a candidate was filed (persisted across re-mines). */
  candidateImprovementId?: string | null;
}

/**
 * Normalize a query for dedup: lowercase, strip wrapping quotes, collapse
 * whitespace. Returns '' for queries too short to be a real demand signal
 * (callers drop those rows) — single tokens under 3 chars are noise the
 * search tools themselves mostly reject anyway.
 */
export function normalizeQuery(raw: string): string {
  let q = raw.trim().toLowerCase();
  // Strip one layer of wrapping quotes ("foo bar" and 'foo bar' search the same thing).
  if (q.length >= 2 && ((q.startsWith('"') && q.endsWith('"')) || (q.startsWith("'") && q.endsWith("'")))) {
    q = q.slice(1, -1).trim();
  }
  q = q.replace(/\s+/g, ' ');
  return q.length < 3 ? '' : q;
}

/**
 * Aggregate zero-hit rows into the deduped demand map. Rows whose tool isn't
 * a mined surface or whose query normalizes to '' are dropped. Output is
 * sorted hottest-first (missCount desc, distinctAgents desc, lastMissedAt
 * desc) — the order both the persist and the panel read use.
 */
export function aggregateZeroHits(rows: ZeroHitRow[]): DemandEntry[] {
  const byKey = new Map<string, DemandEntry & { agents: Set<string>; exampleAt: string }>();
  for (const row of rows) {
    const surface = surfaceOfTool(row.toolName);
    if (!surface) continue;
    const queryNorm = normalizeQuery(row.query);
    if (!queryNorm) continue;
    const key = `${surface}\x00${queryNorm}`;
    const agent = row.agent || 'unknown';
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, {
        surface,
        queryNorm,
        exampleQuery: row.query.trim(),
        exampleAt: row.invokedAt,
        missCount: 1,
        distinctAgents: 1,
        firstMissedAt: row.invokedAt,
        lastMissedAt: row.invokedAt,
        agents: new Set([agent]),
      });
      continue;
    }
    existing.missCount += 1;
    existing.agents.add(agent);
    existing.distinctAgents = existing.agents.size;
    if (row.invokedAt < existing.firstMissedAt) existing.firstMissedAt = row.invokedAt;
    if (row.invokedAt > existing.lastMissedAt) existing.lastMissedAt = row.invokedAt;
    if (row.invokedAt > existing.exampleAt) {
      existing.exampleAt = row.invokedAt;
      existing.exampleQuery = row.query.trim();
    }
  }
  return [...byKey.values()]
    .map(({ agents: _agents, exampleAt: _exampleAt, ...entry }) => entry)
    .sort(
      (a, b) =>
        b.missCount - a.missCount ||
        b.distinctAgents - a.distinctAgents ||
        (a.lastMissedAt < b.lastMissedAt ? 1 : a.lastMissedAt > b.lastMissedAt ? -1 : 0),
    );
}

export interface DemandFilingOptions {
  /** Fire bar: zero-hit count required before a query is candidate-worthy. Default 3. */
  minMisses?: number;
  /** Fire bar: distinct callers required ("N agents searched for X"). Default 2. */
  minAgents?: number;
  /** Per-tick filing cap (the anti-flood half the capture core doesn't own). Default 2. 0 = mine-only. */
  maxPerTick?: number;
}

/**
 * The capped candidate selection: entries over BOTH fire bars, not already
 * filed, hottest-first, cut at the per-tick cap. The capture core's
 * search-first + watchdogKey dedup is the second net behind this one.
 */
export function selectDemandCandidates(entries: DemandEntry[], opts: DemandFilingOptions = {}): DemandEntry[] {
  const minMisses = opts.minMisses ?? 3;
  const minAgents = opts.minAgents ?? 2;
  const maxPerTick = opts.maxPerTick ?? 2;
  if (maxPerTick <= 0) return [];
  return entries
    .filter((e) => e.missCount >= minMisses && e.distinctAgents >= minAgents && !e.candidateImprovementId)
    .slice(0, maxPerTick);
}

/** Stable cross-tick capture identity (payload.watchdogKey). */
export function demandWatchdogKey(entry: Pick<DemandEntry, 'surface' | 'queryNorm'>): string {
  return `negative-space:${entry.surface}:${entry.queryNorm}`;
}

/* ────────────────────────────────────────────────────────────────────────
 * Kind/taxonomy fidelity at the filing edge (frontier P-044 / FB-18, D-008)
 *
 * Two shapes leave this miner, machine-classified so the triage taxonomy can
 * route them instead of dumping 100% of machine findings on the human queue:
 *
 *   resolution-gap   — the demanded artifact EXISTS (an exact plan slug in
 *                      harness_plans, a docs page slug) yet search zero-hits
 *                      it. Clear correct state ("an exact identifier resolves
 *                      from any scope"), regression-testable → kind=bug, the
 *                      AUTO lane. EI-397 is the canonical instance.
 *   missing-knowledge — nothing with that identity exists; whether to write
 *                      the doc/memory is a judgment call → kind=change, the
 *                      gate lane (today's shape, unchanged).
 * ──────────────────────────────────────────────────────────────────────── */

export type DemandFindingClass = 'negative-space:resolution-gap' | 'negative-space:missing-knowledge';

export interface DemandClassification {
  kind: 'bug' | 'change';
  findingClass: DemandFindingClass;
  severity: 'major' | 'minor';
  /** The artifact that exists yet fails to resolve (`plan:<slug>` / `doc:<slug>`) — resolution-gap only. */
  artifactRef: string | null;
}

/**
 * Is this normalized query a single exact identifier (a slug/key), not free
 * prose? Only reference-shaped queries are even probe-worthy: a zero-hit
 * prose query can co-exist with a related artifact without being a bug, but
 * an exact identifier that exists and doesn't resolve is one.
 */
export function isReferenceShapedQuery(queryNorm: string): boolean {
  if (queryNorm.includes(' ')) return false;
  if (queryNorm.length < 4) return false;
  // Multi-part identifier: at least one separator or digit (bare common words
  // like "governor" stay prose — too collision-prone to call a reference).
  if (!/[-:_./\d]/.test(queryNorm)) return false;
  return /^[a-z0-9][a-z0-9:_./-]*$/.test(queryNorm);
}

/**
 * Classify one demand entry given the artifact probe's verdict (scan.ts owns
 * the probe IO; pass null = nothing found / not probed). Pure, so the
 * bug-vs-judgment line is pinned by unit tests.
 */
export function classifyDemandEntry(
  entry: Pick<DemandEntry, 'surface' | 'queryNorm'>,
  artifactRef: string | null,
): DemandClassification {
  if (artifactRef && isReferenceShapedQuery(entry.queryNorm)) {
    return { kind: 'bug', findingClass: 'negative-space:resolution-gap', severity: 'major', artifactRef };
  }
  return { kind: 'change', findingClass: 'negative-space:missing-knowledge', severity: 'minor', artifactRef: null };
}

/** STABLE capture title — no counts/timestamps, per the search-first dedup contract. */
export function demandCaptureTitle(
  entry: Pick<DemandEntry, 'surface' | 'queryNorm'>,
  classification?: Pick<DemandClassification, 'findingClass'>,
): string {
  if (classification?.findingClass === 'negative-space:resolution-gap') {
    return `Resolution gap: ${entry.surface} searches for "${entry.queryNorm}" zero-hit although it exists`;
  }
  return `Missing knowledge: ${entry.surface} searches for "${entry.queryNorm}" find nothing`;
}

/** Capture body — the evidence (counts live here, never in the title). */
export function demandCaptureBody(entry: DemandEntry, windowDays: number, classification?: DemandClassification): string {
  const evidence =
    `Negative-space miner signal (self-learning-frontier P-010): ${entry.distinctAgents} agent(s) ` +
    `searched ${entry.surface} for this ${entry.missCount}× over the last ${windowDays}d and got ZERO hits` +
    `${classification?.artifactRef ? '' : ' — recorded demand for knowledge that doesn\'t exist (or isn\'t findable under these terms)'}.\n\n` +
    `Latest raw query: ${JSON.stringify(entry.exampleQuery)}\n` +
    `Window: ${entry.firstMissedAt} → ${entry.lastMissedAt}\n\n`;
  if (classification?.findingClass === 'negative-space:resolution-gap') {
    return (
      evidence +
      `The demanded artifact EXISTS: \`${classification.artifactRef}\` — this is a resolution gap ` +
      `(frontier P-044, EI-397 shape), not missing knowledge. Correct state: an exact identifier resolves ` +
      `from any scope, or the zero-hit response points at the escape hatch that does resolve it. ` +
      `Regression test: this exact query against the surface must stop zero-hitting (or its miss must ` +
      `surface the redirect).`
    );
  }
  return (
    evidence +
    `Worth either writing the missing doc/insight/memory, or renaming/aliasing existing material ` +
    `so these terms find it. If the searches were probes/noise, close as not-planned.`
  );
}

/**
 * Tuning knobs off the routine's payload_template (mirrors
 * watchdogOptionsFromPayload — re-tunable without a deploy). Unknown/invalid
 * values are ignored; windowDays rides along for scan.ts.
 */
export function demandOptionsFromPayload(
  payload: Record<string, unknown> | null | undefined,
): DemandFilingOptions & { windowDays?: number } {
  const out: DemandFilingOptions & { windowDays?: number } = {};
  if (!payload) return out;
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined;
  const minMisses = num(payload.minMisses);
  const minAgents = num(payload.minAgents);
  const maxPerTick = num(payload.maxPerTick);
  const windowDays = num(payload.windowDays);
  if (minMisses !== undefined) out.minMisses = minMisses;
  if (minAgents !== undefined) out.minAgents = minAgents;
  if (maxPerTick !== undefined) out.maxPerTick = maxPerTick;
  if (windowDays !== undefined && windowDays > 0) out.windowDays = windowDays;
  return out;
}
