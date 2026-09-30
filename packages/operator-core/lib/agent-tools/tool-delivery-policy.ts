/**
 * tool-delivery-policy.ts — WHICH tools an agent sees advertised, and at WHAT
 * detail, derived from measured demand and measured bytes.
 * (deterministic-tool-definition-delivery-2026-09-21 P-003; D-001, D-002, D-004, D-005.)
 *
 * ── WHAT THIS REPLACES ─────────────────────────────────────────────────────
 *
 * Three hand-maintained seed lists that drifted independently, plus a drift
 * guard asserting two of them stayed disjoint — a rule that existed only
 * because they were separate lists. Here there is one ranking, one tier
 * assignment, and one function; `agentKind` varies nothing but its BUDGET and
 * its FLOOR SET (D-005). That is a hard property, not a convention: nothing
 * below branches on `agentKind` at all, so two agent kinds handed each other's
 * budget and floors produce each other's maps exactly.
 *
 * ── THE ALGORITHM, STATED SO IT CAN BE ARGUED WITH ─────────────────────────
 *
 * Every step is a MOVE with a marginal byte COST and a value of `callers` —
 * distinct agents who ever reached for the tool (D-001; call count is dominated
 * by loop machinery and is only a tiebreak). Two move kinds:
 *
 *     admit   deferred → compact    cost = compactBytes
 *     upgrade compact  → full       cost = fullBytes − compactBytes
 *
 *   1. Every FLOOR tool is admitted at COMPACT before ranking begins, whether or
 *      not it fits — a floor may choose a cheaper tier but may never be dropped
 *      (D-004). If the floors alone overrun the budget the result says so
 *      (`budgetOverrun`) rather than silently dropping a mandate.
 *   2. The remaining budget is filled by repeatedly applying the highest
 *      VALUE DENSITY (`callers / cost`) move that still fits — upgrading a floor
 *      to FULL and admitting a non-floor tool compete on the same scale, so a
 *      cheap high-demand newcomer can legitimately beat an expensive upgrade.
 *   3. Ties break by `calls` descending, then by name ascending, so the output
 *      is stable and the generated diff is reviewable.
 *
 * A move that does not fit is SKIPPED, not terminal: the loop continues to
 * cheaper moves, so a single 40 KB heavyweight cannot strand the tail of the
 * budget behind it.
 *
 * ⚠ ZERO MEASURED CALLERS BUYS NO DENSITY-RANKED MOVE — not an admission, and
 * not an upgrade either. Value density is zero, so step 2 has nothing to justify
 * the spend with; those bytes would buy a tool nobody has ever reached for, which
 * is exactly what the deferred catalog and `tools:find` exist to serve instead.
 * A FLOOR with zero demand is still SEATED at COMPACT in step 1 — its
 * justification is the mandate, not the measurement — but it stops there, which
 * is D-004 read literally: guaranteed COMPACT, explicitly not FULL.
 *
 * ── PURITY IS A CONTRACT, NOT A STYLE CHOICE ───────────────────────────────
 *
 * Nothing here reads the clock, the environment, the filesystem or the database.
 * The generated artifact is checked for drift by regenerating it and comparing,
 * which is meaningless the moment the generator's inputs can move underneath it —
 * hence D-003's frozen snapshot, and hence this function taking every input as an
 * argument. Reordering any input collection cannot change the output.
 */

/** The three delivery tiers. `deferred` is reachable via `tools:find`, not invisible. */
export type DeliveryTier = 'full' | 'compact' | 'deferred';

/** Which agent's seed is being resolved. Carried for reporting; NEVER branched on. */
export type AgentKind = 'claude' | 'codex' | 'omp';

/** One catalog entry, already measured at both tiers (see `compactWireBytes`). */
export interface DeliveryCatalogTool {
  name: string;
  /** Wire bytes for the complete advertised definition. */
  fullBytes: number;
  /** Wire bytes for the compact definition. */
  compactBytes: number;
}

/** One row of the committed demand snapshot. */
export interface DeliveryDemandRow {
  name: string;
  /** Distinct callers — THE numerator (D-001). */
  callers: number;
  /** Total calls — tiebreak only. */
  calls: number;
}

export interface ResolveToolDeliveryInput {
  agentKind: AgentKind;
  catalog: readonly DeliveryCatalogTool[];
  demand: readonly DeliveryDemandRow[];
  /** Tools that must be advertised at COMPACT or better regardless of demand (D-004). */
  floors: Iterable<string>;
  /** Total wire-byte budget for all advertised definitions. */
  budgetBytes: number;
}

/** One applied move, in the order the policy applied it — the audit trail for a diff. */
export interface DeliveryDecision {
  name: string;
  kind: 'floor' | 'admit' | 'upgrade';
  tier: Exclude<DeliveryTier, 'deferred'>;
  cost: number;
  callers: number;
  calls: number;
  /** `callers / cost`; `null` for a floor seat, which is taken on mandate, not density. */
  density: number | null;
}

export interface ToolDeliveryResolution {
  agentKind: AgentKind;
  tiers: Map<string, DeliveryTier>;
  budgetBytes: number;
  /** Bytes actually committed across every admitted tool. */
  spentBytes: number;
  /** `spentBytes − budgetBytes` when floors alone overran the budget, else 0. */
  budgetOverrun: number;
  counts: { full: number; compact: number; deferred: number };
  /** Applied moves in application order. */
  decisions: DeliveryDecision[];
  /** Catalog tools carrying no row in the demand snapshot — measured, not assumed. */
  unmeasured: string[];
}

interface WorkingTool {
  name: string;
  fullBytes: number;
  compactBytes: number;
  callers: number;
  calls: number;
  isFloor: boolean;
  tier: DeliveryTier;
}

interface CandidateMove {
  tool: WorkingTool;
  kind: 'admit' | 'upgrade';
  cost: number;
  density: number;
}

/**
 * `callers / cost`. A non-positive cost cannot be ranked by division, and it also
 * cannot exhaust the budget, so it sorts ahead of every priced move rather than
 * producing a NaN that would silently poison the comparison.
 */
function valueDensity(callers: number, cost: number): number {
  if (cost <= 0) return Number.POSITIVE_INFINITY;
  return callers / cost;
}

/** True when `a` should be applied before `b`. Total order: density, calls, name. */
function outranks(a: CandidateMove, b: CandidateMove): boolean {
  if (a.density !== b.density) return a.density > b.density;
  if (a.tool.calls !== b.tool.calls) return a.tool.calls > b.tool.calls;
  return a.tool.name < b.tool.name;
}

/**
 * The move a tool is next eligible for, or `null` when it has none left.
 *
 * A tool offers at most ONE move at a time, which is what keeps the greedy loop
 * deterministic: `admit` must precede `upgrade` for the same tool, and generating
 * both up front would let an upgrade sort ahead of the admission it depends on.
 */
function nextMove(tool: WorkingTool): CandidateMove | null {
  if (tool.tier === 'full') return null;

  // ZERO MEASURED DEMAND ⇒ NO DENSITY-RANKED MOVE, AT EITHER TIER. Step 2 fills
  // the budget "by descending value density", and a zero-caller tool has a value
  // density of zero — there is nothing for the ranking to justify. Applying the
  // rule only to admissions (the obvious half) leaves the other half wrong in a
  // way that is easy to miss: a zero-demand FLOOR is seated at COMPACT in step 1,
  // which makes its next move an UPGRADE, and a zero-density upgrade would then
  // be applied purely because nothing better was competing for the room. That
  // spends full-tier bytes on a tool nobody has ever called, and it contradicts
  // D-004 outright — a floor is guaranteed COMPACT, explicitly NOT FULL.
  if (tool.callers <= 0) return null;

  if (tool.tier === 'compact') {
    const cost = tool.fullBytes - tool.compactBytes;
    // A compact projection that is not actually smaller buys nothing; treat the
    // upgrade as free rather than negative-cost, so it cannot outrank real work
    // by arithmetic accident.
    return { tool, kind: 'upgrade', cost: Math.max(cost, 0), density: valueDensity(tool.callers, cost) };
  }
  // Deferred, and floors are already seated, so this is a non-floor admission.
  return {
    tool,
    kind: 'admit',
    cost: tool.compactBytes,
    density: valueDensity(tool.callers, tool.compactBytes),
  };
}

/**
 * Resolve every catalog tool to a delivery tier. Pure and synchronous: the result
 * is a function of the arguments alone, and is invariant under reordering of
 * `catalog`, `demand` and `floors`.
 */
export function explainToolDelivery(input: ResolveToolDeliveryInput): ToolDeliveryResolution {
  const { agentKind, catalog, demand, floors, budgetBytes } = input;

  const demandByName = new Map<string, DeliveryDemandRow>();
  for (const row of demand) demandByName.set(row.name, row);
  const floorSet = new Set(floors);

  // Sorted by name up front so every later pass walks a canonical order and the
  // caller's array order cannot leak into the result.
  const tools: WorkingTool[] = [...catalog]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((entry) => {
      const row = demandByName.get(entry.name);
      return {
        name: entry.name,
        fullBytes: entry.fullBytes,
        compactBytes: entry.compactBytes,
        callers: row?.callers ?? 0,
        calls: row?.calls ?? 0,
        isFloor: floorSet.has(entry.name),
        tier: 'deferred' as DeliveryTier,
      };
    });

  const unmeasured = tools.filter((t) => !demandByName.has(t.name)).map((t) => t.name);

  const decisions: DeliveryDecision[] = [];
  let spentBytes = 0;

  // ── 1. Seat the floors at COMPACT, budget or no budget (D-004). ────────────
  for (const tool of tools) {
    if (!tool.isFloor) continue;
    tool.tier = 'compact';
    spentBytes += tool.compactBytes;
    decisions.push({
      name: tool.name,
      kind: 'floor',
      tier: 'compact',
      cost: tool.compactBytes,
      callers: tool.callers,
      calls: tool.calls,
      density: null,
    });
  }

  // ── 2. Fill the remainder by descending value density. ─────────────────────
  // Recomputed each pass because applying a move changes which move its tool
  // offers next; with a few hundred tools this is trivially cheap and it is far
  // easier to verify than a hand-maintained heap.
  for (;;) {
    let best: CandidateMove | null = null;
    for (const tool of tools) {
      const move = nextMove(tool);
      if (!move) continue;
      if (spentBytes + move.cost > budgetBytes) continue;
      if (!best || outranks(move, best)) best = move;
    }
    if (!best) break;
    best.tool.tier = best.kind === 'admit' ? 'compact' : 'full';
    spentBytes += best.cost;
    decisions.push({
      name: best.tool.name,
      kind: best.kind,
      tier: best.tool.tier as Exclude<DeliveryTier, 'deferred'>,
      cost: best.cost,
      callers: best.tool.callers,
      calls: best.tool.calls,
      density: best.density,
    });
  }

  const tiers = new Map<string, DeliveryTier>();
  const counts = { full: 0, compact: 0, deferred: 0 };
  for (const tool of tools) {
    tiers.set(tool.name, tool.tier);
    counts[tool.tier] += 1;
  }

  return {
    agentKind,
    tiers,
    budgetBytes,
    spentBytes,
    budgetOverrun: Math.max(spentBytes - budgetBytes, 0),
    counts,
    decisions,
    unmeasured,
  };
}

/**
 * The delivery map alone — the shape the generator and the launcher consume.
 * A thin view over {@link explainToolDelivery}, never a second implementation.
 */
export function resolveToolDelivery(input: ResolveToolDeliveryInput): Map<string, DeliveryTier> {
  return explainToolDelivery(input).tiers;
}
