/**
 * testing:coverage — read the SURFACE CENSUS and its depth grading
 * (`harness_shared.testing_surface_depth`), plan
 * deterministic-coverage-census-2026-08-17 P-005.
 *
 * P-001–P-004 built a census that WRITES: `testing_surfaces` (what exists),
 * `coverage_evidence` (what proved it), and the `testing_surface_depth` view that
 * grades one against the other. Nothing READ any of it, which is why the whole
 * mechanism could sit at zero rows for a day without anyone noticing.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE ONE MISREAD THIS TOOL EXISTS TO MAKE UNREPRESENTABLE
 *
 * A coverage number is a RATIO, and a ratio over an empty census is not zero and
 * not one hundred — it is NOT MEASURED. Those three readings are trivially
 * confusable and only one of them is honest:
 *
 *   0 surfaces, 0 below floor  →  "0 gaps! everything is covered"   ← vacuous truth
 *   0 surfaces, 0 meeting floor →  "0% covered, everything is broken" ← equally wrong
 *
 * Both were LIVE readings on 2026-08-18: all four census tables sat at 0 rows
 * because nothing ever registered a provider (WI-39809), while the routine
 * reported healthy fires. So `pct` is `null` — never a number — whenever its
 * denominator is 0, `verdict` says `not-measured` in words, and `censusUnknown`
 * hoists WHY at the result level, where a hurried caller cannot miss it.
 *
 * This is the same rule the migration wrote into the view's own comment ("a
 * coverage number computed over a weak census can never be read as one computed
 * over a declared census"), applied one level up: a number computed over NO
 * census may not be read as a number at all.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * TWO MARKERS RIDE EVERY AGGREGATE (the P-005 acceptance requirement)
 *
 * `fidelity` — HOW the counted population was derived (declared > spec >
 * convention > observed > file-only). A 90% figure over a `file-only` census and
 * a 90% figure over a `declared` census are different claims, and the number
 * alone cannot tell them apart. Every aggregate therefore carries its own
 * distribution plus `weakest`, so the qualifier travels WITH the number rather
 * than being available somewhere else in the payload.
 *
 * `basis` — what the count was computed OVER. The root CLAUDE.md rule is that a
 * caller's `limit` bounds ROW LISTS ONLY and an aggregate computed over a capped
 * fetch must say so ON THE AGGREGATE. Here every count is computed in SQL across
 * the whole matching set and is genuinely independent of `limit` — but "it
 * happens to be unbounded today" is exactly the kind of invariant that decays
 * silently, so it is DECLARED (`boundedByLimit: false`) and pinned by a
 * behavioural test that re-reads at two different limits and requires the
 * aggregates to be identical. Only `rows` is capped, and it says so itself.
 *
 * NOT this tool: the test-run ledger is `testing:runs` (did this file pass);
 * running tests is `testing:run`. This answers "what SURFACES exist and which are
 * proven", which no ledger of runs can answer — a green suite says nothing about
 * the routes it never touched.
 */

import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { toIso } from '../_pg-timestamp';
import { activeWorkspaceId } from '../../workspace-registry';
import { operatorHomeHarnessSlug } from '../../harness/operator-home-harness';
import { OBSERVED_SURFACE_KINDS } from '../../coverage-census/attribution/sink';

const DEFAULT_LIMIT = 50;

/** Strongest → weakest, matching the CHECK constraint and FIDELITY_ORDER. */
export const FIDELITY_ORDER = ['declared', 'spec', 'convention', 'observed', 'file-only'] as const;
type Fidelity = (typeof FIDELITY_ORDER)[number];

/**
 * The rungs, each mapped to the view's own boolean FLAG.
 *
 * ⚠ NEVER `depth >= n`. The view's comment is explicit that the rungs are NOT
 * strictly nested — a surface can be intent-tested (L3) while the fuzzer has never
 * run against it (no L2) — so a `depth >= 2` test would ask a question the data
 * cannot answer and silently report that surface as failing a rung it was never
 * judged on. `depth` exists only as a human-facing summary of the highest rung
 * reached, and this tool treats it as such.
 */
export const RUNGS = {
  l1: { column: 'meets_l1', label: 'executed — something demonstrably reached it' },
  l2: { column: 'meets_l2', label: 'conformant — a generated adversarial suite passed' },
  l3: { column: 'meets_l3', label: 'intent-tested — a test a machine did not write exercised it' },
  l4: { column: 'meets_l4', label: 'hardened — the intent tests kill mutants' },
} as const;
export type Rung = keyof typeof RUNGS;

export type FidelityCounts = Record<Fidelity, number>;

export interface FidelityMarker {
  counts: FidelityCounts;
  /** The WEAKEST fidelity present — the honest ceiling on how much this number means. */
  weakest: Fidelity | null;
  /** Share of the population derived from a live code registry (cannot drift). */
  declaredPct: number | null;
}

/** Declared, not implied — see the header. Frozen so a caller cannot mutate the claim. */
export const AGGREGATE_BASIS = Object.freeze({
  countedOver: 'every census row matching the filters',
  boundedByLimit: false,
  limitAppliesTo: 'rows',
} as const);

export interface Aggregate {
  surfaces: number;
  meets: number;
  below: number;
  /**
   * Below the floor AND NOT waived — the gap population the house already treats as
   * real ("a live waiver is an accepted, expiry-dated gap", which is why `gapsOnly`
   * excludes waived rows by default).
   *
   * This exists as an AGGREGATE, computed in SQL, because it is the pass condition of
   * the kind:'coverage' criterion check (P-006). Counting it from the returned `rows`
   * instead would judge a gate on a `limit`-capped page — flatteringly, since gaps that
   * fell off the page cannot be counted — which is the precise defect this whole plan
   * exists to make unrepresentable.
   */
  belowUnwaived: number;
  waived: number;
  /** NULL when `surfaces` is 0. A ratio with no denominator is not-measured, never 0 or 100. */
  pct: number | null;
  fidelity: FidelityMarker;
  basis: typeof AGGREGATE_BASIS;
}

export const emptyFidelityCounts = (): FidelityCounts =>
  Object.fromEntries(FIDELITY_ORDER.map((f) => [f, 0])) as FidelityCounts;

export function fidelityMarker(counts: FidelityCounts, total: number): FidelityMarker {
  // WEAKEST, not strongest: the ceiling on what the number means is set by the
  // flimsiest row in the population, not the sturdiest.
  const weakest = [...FIDELITY_ORDER].reverse().find((f) => counts[f] > 0) ?? null;
  return {
    counts,
    weakest,
    declaredPct: total > 0 ? round1((counts.declared / total) * 100) : null,
  };
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

/** The one place a ratio is formed, so the null-when-vacuous rule cannot be
 *  forgotten at one call site out of six. */
export function pct(numerator: number, denominator: number): number | null {
  return denominator > 0 ? round1((numerator / denominator) * 100) : null;
}

export function aggregate(input: {
  surfaces: number;
  meets: number;
  waived: number;
  /** Below floor AND unwaived, counted in SQL — see {@link Aggregate.belowUnwaived}. */
  belowUnwaived: number;
  fidelityCounts: FidelityCounts;
}): Aggregate {
  return {
    surfaces: input.surfaces,
    meets: input.meets,
    below: input.surfaces - input.meets,
    belowUnwaived: input.belowUnwaived,
    waived: input.waived,
    pct: pct(input.meets, input.surfaces),
    fidelity: fidelityMarker(input.fidelityCounts, input.surfaces),
    basis: AGGREGATE_BASIS,
  };
}

const num = (v: unknown): number => Number(v ?? 0);

/** Row shapes as they arrive from postgres — counts are strings from `count(*)`. */
export interface CoverageRawInput {
  scope: { workspace: string; harness: string };
  rung: Rung;
  totals:
    | {
        surfaces: string | number;
        retired: string | number;
        waived: string | number;
        last_census_at: string | null;
        /** Scope-level census timestamp, independent of the caller's row filters. */
        scope_last_census_at?: string | null;
        meets_l1: string | number;
        meets_l2: string | number;
        meets_l3: string | number;
        meets_l4: string | number;
        meets_floor: string | number;
        /** Surfaces carrying ANY evidence basis — observed traffic or authored. */
        evidenced: string | number;
        below_unwaived_l1: string | number;
        below_unwaived_l2: string | number;
        below_unwaived_l3: string | number;
        below_unwaived_l4: string | number;
        below_unwaived_floor: string | number;
      }
    | undefined;
  fidelityRows: { fidelity: string; n: string | number }[];
  byKindRows: {
    kind: string;
    fidelity: string;
    n: string | number;
    meets: string | number;
    waived: string | number;
    below_unwaived: string | number;
  }[];
  registrations: { registered: string | number; enabled: string | number } | undefined;
  rows: {
    kind: string;
    surface_id: string;
    source_file: string | null;
    provider: string;
    fidelity: string;
    depth: number;
    meets_l1: boolean;
    meets_l2: boolean;
    meets_l3: boolean;
    meets_l4: boolean;
    mutation_score: number | null;
    authored_evidence: string | number;
    last_evidence_at: string | null;
    first_seen: string;
    retired_at: string | null;
    waived: boolean;
  }[];
  rowTotal: number;
  /** Injectable so the age computation is testable without freezing the clock. */
  now?: number;
}

/**
 * Keep the complete coverage MEASUREMENT when a model-facing result is bounded.
 * The aggregate envelope is the point of this tool; only `rows` is a page and may
 * be shortened further for transport. Without a domain shaper, tooldef's generic
 * projection can retain part of that large row page while dropping the required
 * root `count` / `total` / `truncatedByLimit` fields. A strict MCP client then
 * rejects the whole otherwise-readable response against this tool's outputSchema.
 */
export const TESTING_COVERAGE_TIER_CAPS = {
  trimmed: 4_800,
  standard: 5_200,
} as const;

type TestingCoverageTier = keyof typeof TESTING_COVERAGE_TIER_CAPS;

export function shapeTestingCoverage(data: unknown, tier: TestingCoverageTier): unknown {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  const source = data as Record<string, unknown>;
  if (!Array.isArray(source.rows)) return data;

  const targetChars = TESTING_COVERAGE_TIER_CAPS[tier];
  const rows = source.rows;
  const base = { ...source, rows: [] as unknown[], count: 0 };
  const kept: unknown[] = [];

  for (const row of rows) {
    const next = [...kept, row];
    const candidate = {
      ...base,
      rows: next,
      count: next.length,
      truncatedByLimit: source.truncatedByLimit === true || next.length < rows.length,
      payloadBounded: {
        tier,
        showingRows: next.length,
        queryRows: rows.length,
        droppedRows: rows.length - next.length,
      },
    };
    // Preserve one real row even when an unusually large identifier alone crosses
    // the target; the framework's much larger hard ceiling remains the final guard.
    if (JSON.stringify(candidate).length > targetChars && kept.length > 0) break;
    kept.push(row);
  }

  const droppedRows = rows.length - kept.length;
  const shaped = {
    ...base,
    rows: kept,
    count: kept.length,
    total: source.total,
    truncatedByLimit: source.truncatedByLimit === true || droppedRows > 0,
  };
  if (droppedRows === 0) return shaped;

  return {
    ...shaped,
    payloadBounded: {
      tier,
      showingRows: kept.length,
      queryRows: rows.length,
      droppedRows,
    },
  };
}

export type TestingCensusPopulationAssessment = 'no-providers' | 'census-not-run' | 'empty-measured' | 'populated';

/**
 * ⚠ `no-population`, NOT `not-measured` — and the rename is load-bearing, not cosmetic
 * (cell-assessment P-004, D-012).
 *
 * D-010's truth table named this code `not-measured`, which is ALSO a `CellUnknownCode`
 * — the read-HEALTH vocabulary (`not-applicable | resolver-failed | not-measured |
 * insufficient-data`). D-008 forbids that overlap and the registry enforces it
 * (`assessment-code-collides-with-unknown`), so the declaration this producer feeds
 * could not have been registered at all: declaring the colliding code is refused, and
 * omitting it makes every empty-census read fail as an undeclared code. The collision
 * was invisible until a cell actually declared an assessment.
 *
 * The rule is right and this is its clearest instance. An empty census is a MEASURED
 * FINDING ABOUT THE SUBJECT — the census ran and enumerated zero surfaces, so a ratio
 * would be vacuous — whereas `not-measured` as a read-health code means the apparatus
 * did not produce a value. Spelling them the same way makes "there is nothing to
 * measure" and "we failed to measure" one token, which is precisely the conflation this
 * whole contract exists to remove.
 *
 * The fix belongs HERE rather than in the declaration, per cell-registrations.ts's
 * twice-stated precedent: when a declaration cannot be written honestly, the resolver is
 * what changes. The sibling `verdict: 'measured' | 'not-measured'` field is UNTOUCHED —
 * it is not an assessment code and carries no such collision.
 */
export type TestingCoverageFloorAssessment =
  | 'no-population'
  | 'meets-floor'
  | 'below-floor'
  | 'no-evidence'
  | 'measured-with-waivers';

/** PURE. Numeric zero is interpreted only with its population provenance. */
export function assessTestingCensusPopulation(input: {
  surfaces: number;
  providersRegistered: number;
  lastCensusAt: string | null;
}): TestingCensusPopulationAssessment {
  if (input.surfaces > 0) return 'populated';
  if (input.providersRegistered === 0) return 'no-providers';
  return input.lastCensusAt === null ? 'census-not-run' : 'empty-measured';
}

/**
 * PURE. The aggregate, never the limit-capped rows, decides the floor.
 *
 * `evidenced` REFINES THE SHORTFALL BRANCH ONLY, AND THAT NARROWNESS IS THE POINT (P-008).
 * `assessTestingCensusPopulation` above already refuses to let a zero DENOMINATOR stand
 * without its provenance; until now the NUMERATOR had no such protection, so one
 * `below-floor` absorbed two states that call for opposite actions:
 *
 *   - surfaces a test could cover and does not — the gap queue is real work;
 *   - surfaces no evidence has EVER reached, because nothing armed an observer that can
 *     persist into this scope — where every item in that queue is unactionable, and
 *     writing tests moves nothing.
 *
 * Measured 2026-09-02: all 2,017 live surfaces read `below-floor` / `belowUnwaived=2017`
 * while `coverage_evidence` held ZERO rows, because `isAttributionArmed()` is only ever
 * set on test-spawn paths, the unit rail stands down at flush, and the integration rail
 * writes to a throwaway database under a synthetic scope. The queue was 2,017 rows deep
 * and none of it was work. That is the reading this code exists to prevent.
 *
 * It refines ONLY the `belowUnwaived > 0` branch on purpose: a missing numerator can make
 * a shortfall unattributable, but it must never be able to turn a passing floor into a
 * failing one, so `meets-floor` and `measured-with-waivers` are left untouched.
 */
export function assessTestingCoverageFloor(input: {
  verdict: 'measured' | 'not-measured';
  surfaces: number;
  below: number;
  belowUnwaived: number;
  /** Surfaces carrying ANY evidence basis — observed traffic or authored. */
  evidenced: number;
}): TestingCoverageFloorAssessment {
  if (input.verdict === 'not-measured' || input.surfaces === 0) return 'no-population';
  if (input.belowUnwaived > 0) return input.evidenced === 0 ? 'no-evidence' : 'below-floor';
  if (input.below > 0) return 'measured-with-waivers';
  return 'meets-floor';
}

/**
 * Turn raw query results into the response.
 *
 * PURE AND EXPORTED ON PURPOSE. Everything this plan item is judged on — the
 * null-when-vacuous ratio, the not-measured verdict, the hoisted reason, and the
 * fidelity/basis markers riding every aggregate — lives HERE rather than inside the
 * handler, so the guarantees are asserted against the real function instead of against
 * a mocked `sql` tagged template. A guarantee that can only be tested through a mock is
 * one the mock can be wrong about.
 */
export function assembleCoverage(input: CoverageRawInput) {
  const { scope, rung, totals, registrations } = input;
  const now = input.now ?? Date.now();
  const surfaces = num(totals?.surfaces);

  const fidelityCounts = emptyFidelityCounts();
  for (const r of input.fidelityRows) {
    if ((FIDELITY_ORDER as readonly string[]).includes(r.fidelity)) {
      fidelityCounts[r.fidelity as Fidelity] = num(r.n);
    }
  }

  const byKindMap = new Map<
    string,
    { surfaces: number; meets: number; waived: number; belowUnwaived: number; fid: FidelityCounts }
  >();
  for (const r of input.byKindRows) {
    const entry = byKindMap.get(r.kind) ?? {
      surfaces: 0,
      meets: 0,
      waived: 0,
      belowUnwaived: 0,
      fid: emptyFidelityCounts(),
    };
    entry.surfaces += num(r.n);
    entry.meets += num(r.meets);
    entry.waived += num(r.waived);
    entry.belowUnwaived += num(r.below_unwaived);
    if ((FIDELITY_ORDER as readonly string[]).includes(r.fidelity)) {
      entry.fid[r.fidelity as Fidelity] += num(r.n);
    }
    byKindMap.set(r.kind, entry);
  }

  const providersRegistered = num(registrations?.registered);
  // `last_census_at` is scoped by the caller's filters in the SQL below. Use the
  // unfiltered scope timestamp for population classification, otherwise a filter miss
  // makes a healthy census look like it has never run.
  const lastCensusAt = totals?.scope_last_census_at
    ? toIso(totals.scope_last_census_at)
    : totals?.last_census_at
      ? toIso(totals.last_census_at)
      : null;

  /**
   * The hoist (D-039 shape): result-level, enumerated, and populated ONLY when the
   * ratio genuinely has no denominator. A caller who reads nothing but `pct` still gets
   * `null` rather than a number; a caller who reads nothing but `verdict` still gets the
   * word. Both roads lead away from the vacuous reading.
   */
  const censusUnknown: string[] = [];
  if (surfaces === 0) {
    if (providersRegistered === 0) {
      censusUnknown.push(
        'no-providers-registered: harness_shared.census_provider_registrations has no row for this scope, so runCensus iterates an empty list and can never write a surface — its fires still report success (WI-39809)',
      );
    } else if (!lastCensusAt) {
      censusUnknown.push(
        'census-has-not-run: providers are registered but no census run has ever written a surface row for this scope',
      );
    } else {
      censusUnknown.push('no-surfaces-match-filters: the census has rows, but none match this query');
    }
  }

  const verdict = surfaces > 0 ? ('measured' as const) : ('not-measured' as const);
  const meetsFloor = num(totals?.meets_floor);
  const belowUnwaivedFloor = num(totals?.below_unwaived_floor);
  const belowFloor = surfaces - meetsFloor;
  const evidenced = num(totals?.evidenced);

  /**
   * P-008. Surfaces whose KIND no observer emits — they cannot acquire traffic evidence
   * by any path, so their place at the bottom of the ladder is a fact about the observer
   * population and not a coverage measurement.
   *
   * Derived from the sink's own exported set rather than a list maintained here: a third
   * observer must not require an edit in this file to be counted correctly, and a kind
   * that LOSES its observer must not keep flattering the queue. Counted from `byKindRows`,
   * which the aggregate already reads, so this costs no extra query.
   */
  const unobservable = input.byKindRows.reduce(
    (acc, r) => (OBSERVED_SURFACE_KINDS.includes(r.kind) ? acc : acc + num(r.n)),
    0,
  );

  return {
    scope,

    assessments: {
      censusPopulation: assessTestingCensusPopulation({
        surfaces,
        providersRegistered,
        lastCensusAt,
      }),
      coverageFloor: assessTestingCoverageFloor({
        verdict,
        surfaces,
        below: belowFloor,
        belowUnwaived: belowUnwaivedFloor,
        evidenced,
      }),
    },

    /** Words, not just a null number — the two say the same thing on purpose. */
    verdict,
    censusUnknown: censusUnknown.length > 0 ? censusUnknown : null,

    census: {
      surfaces,
      retired: num(totals?.retired),
      lastCensusAt,
      ageMs: lastCensusAt ? now - Date.parse(lastCensusAt) : null,
      providersRegistered,
      providersEnabled: num(registrations?.enabled),
      fidelity: fidelityMarker(fidelityCounts, surfaces),
      basis: AGGREGATE_BASIS,
    },

    coverage: {
      floor: rung,
      floorMeans: RUNGS[rung].label,
      ...aggregate({
        surfaces,
        meets: meetsFloor,
        waived: num(totals?.waived),
        belowUnwaived: belowUnwaivedFloor,
        fidelityCounts,
      }),

      /**
       * P-008. The two numbers that say whether a shortfall is WORK.
       *
       * `evidenced` is how many surfaces the evidence apparatus has ever reached;
       * `unobservable` is how many belong to a kind no observer emits, so they can never
       * be reached at all. Both are carried beside the ratio rather than folded into it,
       * because a caller acting on the gap queue needs to subtract them and a caller
       * reporting coverage must not: they change what the shortfall MEANS, not its size.
       */
      evidenced,
      unobservable,

      /** Every rung, so a caller sees the shape of the ladder without four calls.
       *  Each carries its own markers — a per-rung number is an aggregate too. */
      byRung: Object.fromEntries(
        (Object.keys(RUNGS) as Rung[]).map((r) => [
          r,
          aggregate({
            surfaces,
            meets: num(totals?.[RUNGS[r].column as keyof NonNullable<CoverageRawInput['totals']>]),
            waived: num(totals?.waived),
            belowUnwaived: num(totals?.[`below_unwaived_${r}` as keyof NonNullable<CoverageRawInput['totals']>]),
            fidelityCounts,
          }),
        ]),
      ) as Record<Rung, Aggregate>,
    },

    byKind: [...byKindMap.entries()]
      .map(([k, v]) => ({
        kind: k,
        ...aggregate({
          surfaces: v.surfaces,
          meets: v.meets,
          waived: v.waived,
          belowUnwaived: v.belowUnwaived,
          fidelityCounts: v.fid,
        }),
      }))
      .sort((a, b) => a.kind.localeCompare(b.kind)),

    rows: input.rows.map((r) => ({
      kind: r.kind,
      surfaceId: r.surface_id,
      sourceFile: r.source_file,
      provider: r.provider,
      fidelity: r.fidelity,
      depth: r.depth,
      meets: { l1: r.meets_l1, l2: r.meets_l2, l3: r.meets_l3, l4: r.meets_l4 },
      mutationScore: r.mutation_score,
      authoredEvidence: num(r.authored_evidence),
      lastEvidenceAt: r.last_evidence_at ? toIso(r.last_evidence_at) : null,
      firstSeen: toIso(r.first_seen),
      retiredAt: r.retired_at ? toIso(r.retired_at) : null,
      waived: r.waived,
    })),
    count: input.rows.length,
    total: input.rowTotal,
    truncatedByLimit: input.rows.length < input.rowTotal,
  };
}

export default defineTool({
  name: 'testing:coverage',
  description:
    'Read the SURFACE CENSUS (harness_shared.testing_surface_depth): which testable surfaces exist (http-route | mcp-tool | sync-query | …) and which are proven to the depth floor. Aggregates overall and by kind, plus the gap list. `pct` is null — never 0 or 100 — when the census is empty, and `verdict:"not-measured"` says so. Read-only.',
  capability: 'operator:read',
  guidance: {
    when: 'Answering "what is actually tested here" / "what did this plan leave unproven": the census knows about surfaces no test ever touched, which a run ledger cannot. rung + gapsOnly gives the gap queue.',
    notWhen:
      'For "did this file pass / what failed at this sha" use testing:runs (the run ledger — a different question). To RUN tests use testing:run. This tool never says whether a suite is green; it says what the suite reached.',
    chaining:
      "gapsOnly:true at your floor for the gap list → sourceFile to scope it to the files a plan touched → testing:runs on the surface's source_file for the run history behind its evidence.",
    // Response docs live HERE, not in description/when — those are prompt-weight budgeted.
    returns: [
      '{ scope, assessments, verdict, censusUnknown, census, coverage, byKind, rows, count, total, truncatedByLimit } — verdict "measured" | "not-measured". not-measured means the RATIO HAS NO DENOMINATOR (zero censused surfaces) — it is NOT a coverage of 0%, and censusUnknown carries the reason (no-providers-registered | census-has-not-run | no-surfaces-match-filters).',
      'Every aggregate (root `coverage`, each `byKind` entry, each `byRung` entry) carries `fidelity` { counts, weakest, declaredPct } and `basis` { countedOver, boundedByLimit:false, limitAppliesTo:"rows" }. fidelity.weakest is the ceiling on what the number means: 90% over a "file-only" census is not 90% over a "declared" one.',
      '`pct` is null whenever its denominator is 0, at every level including per-kind. A null pct is an honest unknown; treating it as 0 is the misread this tool exists to prevent.',
      'Aggregates are computed in SQL over the WHOLE matching set and do not move with `limit`; only `rows` is capped, and reports count/total/truncatedByLimit.',
      "Rungs are judged by the view's meets_lN FLAG, never depth >= N — the rungs are not nested (an intent-tested surface the fuzzer never ran against is L3 with no L2), so `depth` is a human-facing summary only.",
      'census { surfaces, retired, lastCensusAt, ageMs, providersRegistered, providersEnabled } describes the POPULATION. providersRegistered:0 means the census loop has nothing to iterate and cannot ever write a row (WI-39809) — the state that reads as a healthy zero everywhere else.',
      'BEFORE WORKING A GAP QUEUE, read coverage.evidenced and coverage.unobservable. evidenced:0 means nothing has EVER been measured about this scope, so the shortfall is a fact about the apparatus and no test you write will move it — the assessment says `no-evidence` rather than `below-floor` for exactly that case. unobservable counts surfaces whose kind no observer emits, which arming cannot fix. Subtract both before sizing the work.',
    ].join(' '),
    seeAlso: ['testing:runs (did this test file pass — the run ledger)', 'testing:run (actually run test files)'],
  },
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  args: z.object({
    harness: z.string().max(120).optional().describe('Harness slug to read (default: the operator home harness).'),
    workspace: z.string().max(120).optional().describe('Workspace id (default: the active workspace).'),
    kind: z.string().max(80).optional().describe('Only this surface kind (http-route | mcp-tool | sync-query | …).'),
    sourceFile: z
      .string()
      .max(400)
      .optional()
      .describe(
        'Only surfaces whose implementing file matches this SUBSTRING — the reverse map that scopes coverage to the files a plan touched.',
      ),
    rung: z
      .enum(['l1', 'l2', 'l3', 'l4'])
      .optional()
      .describe('The depth floor to judge against (default l1). Judged by the meets_lN flag, never depth >= N.'),
    gapsOnly: z.boolean().optional().describe('Return only surfaces BELOW the floor — the gap queue.'),
    includeRetired: z.boolean().optional().describe('Include surfaces the census no longer finds (default false).'),
    includeWaived: z
      .boolean()
      .optional()
      .describe(
        'Count waived surfaces in the gap list (default false — a live waiver is an accepted, expiry-dated gap).',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .describe(`Max ROWS (default ${DEFAULT_LIMIT}). Never bounds the aggregates.`),
  }),
  result: z
    .object({
      scope: z.unknown(),
      assessments: z.unknown(),
      verdict: z.enum(['measured', 'not-measured']),
      censusUnknown: z.array(z.string()).nullable(),
      census: z.unknown(),
      coverage: z.unknown(),
      byKind: z.array(z.unknown()),
      rows: z.array(z.unknown()),
      count: z.number().int().nonnegative(),
      total: z.number().int().nonnegative(),
      truncatedByLimit: z.boolean(),
    })
    .passthrough(),
  // NO `contract` — AUDITED 2026-09-16 (WI-2145871); recorded `reasoned` in
  // SHAPER_CONTRACT_EXEMPT, where the measurement lives. The 13-field row allowlist
  // that used to sit here described the HANDLER (`readCoverage` rebuilds each row
  // from an explicit key list) — but a contract is checked against the SHAPER, and
  // `shapeTestingCoverage` only DROPS WHOLE ROWS to bound size, passing each row
  // through untouched. So the pin read as sound against the handler while asserting
  // nothing about the shaper it actually guarded. Do not re-add it: restoring a
  // handler-shaped allowlist here re-banks that same vacuous green.
  shape: {
    standard: (data) => shapeTestingCoverage(data, 'standard'),
    trimmed: (data) => shapeTestingCoverage(data, 'trimmed'),
  },
  // ⚠ WRAPPED IN `{ data }`, like every sibling tool. A handler must return a
  // `ToolResult | ToolResponse`, not a bare payload — `dispatchReadOnlyTool` unwraps
  // `data`, which is why the state cells' declared paths are rooted at `coverage.pct`
  // rather than `data.coverage.pct`.
  //
  // Returning the payload raw fails as `TS2769: No overload matches this call` pointing
  // at this line — a headline whose indented sub-messages name the RETURN type as the
  // mismatch while the parameter types are shown matching exactly. Read those
  // sub-messages (a full `tsc` run; `lint:tsc` prints only the first line) before
  // concluding anything about this signature.
  async handler(args) {
    return { data: await readCoverage(args) };
  },
});

/** The argument shape, shared by every surface that reads coverage. */
export interface CoverageArgs {
  harness?: string;
  workspace?: string;
  kind?: string;
  sourceFile?: string;
  /**
   * MANY source-file substrings, matched as a union (a surface counts if ANY of them
   * matches). The reverse map for a multi-file scope — "the surfaces the files this plan
   * touched implement" — expressed as ONE query so the aggregate is still computed in
   * SQL across the whole matching population.
   *
   * ⚠ The alternative (call readCoverage once per file and add the results up) is
   * FORBIDDEN by this module's own contract: summing per-file aggregates double-counts
   * any surface two patterns both match, and re-derives a ratio outside the one place
   * {@link pct} enforces the null-when-vacuous rule. Widen the query, never the caller.
   */
  sourceFiles?: string[];
  rung?: Rung;
  gapsOnly?: boolean;
  includeRetired?: boolean;
  includeWaived?: boolean;
  limit?: number;
}

/**
 * THE coverage resolver. Exported because the `/admin/testing` panel reads it through
 * the sync registry (`testing.coverage`) and the state cells read it through the tool —
 * three surfaces, ONE derivation.
 *
 * ⚠ A surface may PROJECT or SUBSET this; none may re-derive it. The panel in particular
 * must not recompute a percentage from the row list it happens to have been sent: the
 * rows are capped by `limit` and the aggregates are not, so a client-side ratio would be
 * computed over a page instead of a population — silently, and in the flattering
 * direction. That is the exact defect this plan item exists to make unrepresentable, and
 * it would be reintroduced by the most natural line of UI code anyone could write.
 */
export async function readCoverage(args: CoverageArgs) {
  {
    const { sql } = getOrgPg();
    const harness = args.harness ?? operatorHomeHarnessSlug();
    const workspace = args.workspace ?? activeWorkspaceId();
    const rung: Rung = args.rung ?? 'l1';
    const limit = args.limit ?? DEFAULT_LIMIT;
    const includeRetired = args.includeRetired ?? false;
    const includeWaived = args.includeWaived ?? false;
    const filePattern = args.sourceFile ? `%${args.sourceFile}%` : null;
    // A union of substrings. Empty-after-trim ⇒ null, NOT an empty array: `ILIKE ANY('{}')`
    // matches nothing, so an all-blank list would silently produce a 0-surface scope that
    // reads as a real (and vacuously passing) measurement. null means "no filter"; a
    // caller that meant to scope to specific files and supplied none must not be handed
    // the whole census either — that is the CALLER's error to detect, and the coverage
    // check's scope resolver refuses it before it ever reaches this function.
    const filePatterns =
      args.sourceFiles && args.sourceFiles.some((f) => f.trim() !== '')
        ? args.sourceFiles.filter((f) => f.trim() !== '').map((f) => `%${f.trim()}%`)
        : null;
    const kind = args.kind ?? null;

    // The flag column for the requested rung. Interpolated from the RUNGS table, never
    // from caller input — the zod enum already bounds it, and this keeps it obvious.
    const meetsCol = sql(RUNGS[rung].column);

    const where = sql`
       WHERE workspace_id = ${workspace}
         AND harness_slug = ${harness}
         AND (${includeRetired}::boolean OR retired_at IS NULL)
         AND (${kind}::text IS NULL OR kind = ${kind})
         AND (${filePattern}::text IS NULL OR source_file ILIKE ${filePattern})
         AND (${filePatterns}::text[] IS NULL OR source_file ILIKE ANY(${filePatterns}))`;

    // ── The aggregates. Computed across the whole matching set in SQL, so `limit`
    //    cannot reach them (AGGREGATE_BASIS declares this, the behavioural test pins it).
    const [totals] = await sql<
      {
        surfaces: string;
        retired: string;
        waived: string;
        last_census_at: string | null;
        scope_last_census_at: string | null;
        meets_l1: string;
        meets_l2: string;
        meets_l3: string;
        meets_l4: string;
        meets_floor: string;
        evidenced: string;
        below_unwaived_l1: string;
        below_unwaived_l2: string;
        below_unwaived_l3: string;
        below_unwaived_l4: string;
        below_unwaived_floor: string;
      }[]
    >`
      SELECT count(*)                                                      AS surfaces,
             count(*) FILTER (WHERE retired_at IS NOT NULL)                AS retired,
             count(*) FILTER (WHERE waived)                                AS waived,
             max(last_seen)                                                AS last_census_at,
             (
               SELECT max(scope_row.last_seen)
                 FROM harness_shared.testing_surface_depth AS scope_row
                WHERE scope_row.workspace_id = ${workspace}
                  AND scope_row.harness_slug = ${harness}
             )                                                              AS scope_last_census_at,
             count(*) FILTER (WHERE meets_l1)                              AS meets_l1,
             count(*) FILTER (WHERE meets_l2)                              AS meets_l2,
             count(*) FILTER (WHERE meets_l3)                              AS meets_l3,
             count(*) FILTER (WHERE meets_l4)                              AS meets_l4,
             count(*) FILTER (WHERE ${meetsCol})                           AS meets_floor,
             -- The kind:'coverage' check's pass condition, counted over the WHOLE
             -- matching population (never the limit-capped rows). "NOT waived" matches
             -- the gap list's own default: a live waiver is an accepted, expiry-dated gap.
             count(*) FILTER (WHERE NOT meets_l1 AND NOT waived)            AS below_unwaived_l1,
             count(*) FILTER (WHERE NOT meets_l2 AND NOT waived)            AS below_unwaived_l2,
             count(*) FILTER (WHERE NOT meets_l3 AND NOT waived)            AS below_unwaived_l3,
             count(*) FILTER (WHERE NOT meets_l4 AND NOT waived)            AS below_unwaived_l4,
             count(*) FILTER (WHERE NOT ${meetsCol} AND NOT waived)         AS below_unwaived_floor,
             -- P-008. Does the NUMERATOR have any provenance at all? Counted over the
             -- whole matching population, and deliberately BROADER than any single
             -- rung: a surface with observed traffic OR authored evidence has been
             -- reached by the apparatus, even when what it proved falls short. Only a
             -- zero here means nothing ever reached this scope, which is why the floor
             -- assessment may spend it to tell an unactionable gap queue from a real one.
             count(*) FILTER (
               WHERE last_evidence_at IS NOT NULL OR COALESCE(authored_evidence, 0) > 0
             )                                                             AS evidenced
        FROM harness_shared.testing_surface_depth
        ${where}
    `;

    const fidelityRows = await sql<{ fidelity: string; n: string }[]>`
      SELECT fidelity, count(*) AS n
        FROM harness_shared.testing_surface_depth
        ${where}
       GROUP BY fidelity
    `;

    const byKindRows = await sql<
      {
        kind: string;
        surfaces: string;
        meets: string;
        waived: string;
        below_unwaived: string;
        fidelity: string;
        n: string;
      }[]
    >`
      SELECT kind,
             fidelity,
             count(*)                            AS n,
             count(*) FILTER (WHERE ${meetsCol}) AS meets,
             count(*) FILTER (WHERE waived)      AS waived,
             count(*) FILTER (WHERE NOT ${meetsCol} AND NOT waived) AS below_unwaived,
             0                                   AS surfaces
        FROM harness_shared.testing_surface_depth
        ${where}
       GROUP BY kind, fidelity
       ORDER BY kind
    `;

    // ── Provider registrations: the census loop iterates THESE, so zero of them means
    //    the census can never write a row however healthy its fires look (WI-39809).
    const [registrations] = await sql<{ registered: string; enabled: string }[]>`
      SELECT count(*)                             AS registered,
             count(*) FILTER (WHERE enabled)      AS enabled
        FROM harness_shared.census_provider_registrations
       WHERE workspace_id = ${workspace}
         AND harness_slug = ${harness}
    `;

    // ── The rows. The ONLY capped thing in this response.
    const rowWhere = args.gapsOnly
      ? sql`${where} AND NOT ${meetsCol} ${includeWaived ? sql`` : sql`AND NOT waived`}`
      : where;

    const rows = await sql<
      {
        kind: string;
        surface_id: string;
        source_file: string | null;
        provider: string;
        fidelity: string;
        depth: number;
        meets_l1: boolean;
        meets_l2: boolean;
        meets_l3: boolean;
        meets_l4: boolean;
        mutation_score: number | null;
        authored_evidence: string;
        last_evidence_at: string | null;
        first_seen: string;
        retired_at: string | null;
        waived: boolean;
      }[]
    >`
      SELECT kind, surface_id, source_file, provider, fidelity, depth,
             meets_l1, meets_l2, meets_l3, meets_l4, mutation_score,
             authored_evidence, last_evidence_at, first_seen, retired_at, waived
        FROM harness_shared.testing_surface_depth
        ${rowWhere}
       ORDER BY depth ASC, kind ASC, surface_id ASC
       LIMIT ${limit}
    `;

    const [rowTotal] = await sql<{ n: string }[]>`
      SELECT count(*) AS n FROM harness_shared.testing_surface_depth ${rowWhere}
    `;

    return assembleCoverage({
      scope: { workspace, harness },
      rung,
      totals,
      fidelityRows,
      byKindRows,
      registrations,
      rows,
      rowTotal: num(rowTotal?.n),
    });
  }
}
