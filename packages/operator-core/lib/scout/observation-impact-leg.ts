/**
 * observation-impact-leg.ts — P-021 (su-ideate-learning-substrate-2026-07-10):
 * the OBSERVATION→IMPACT readback (demand-pull). An agent's `lane:observation`
 * filings are otherwise a WRITE-ONLY well — you file a turn-end reflection and
 * never see where it went. This leg closes that visibility gap: given an agent's
 * own recent filings, it walks the funnel
 *
 *     your 7d filings → corpus-digest meta-patterns that cite them
 *                     → routed ideas grounded on those patterns
 *                     → which of those ideas actually SHIPPED
 *
 * so `blender:ideation-feedback scope:'mine'` can show an observation VISIBLY
 * becoming a pattern → idea → shipped change. D-017: that visible arc is the
 * strongest filing motivator there is — far stronger than a volume quota (the
 * explicitly-rejected alternative).
 *
 * THE JOIN (why it works, and its one honest approximation):
 *   - A free-text observation is unioned into the corpus-digest's FRICTION lane
 *     (corpus-digest-deps friction() ← readObservationItems), so a RECURRING
 *     observation gets clustered and surfaced as a meta-pattern whose drill-back
 *     `ref` is `wi:<engineer_issue_id>` — the SAME id space an observation filing
 *     carries. So "a pattern cites my observation" ⇔ `patternRefToIssueId(ref)` is
 *     one of my 7d filing ids.
 *   - APPROXIMATION (plan-aligned): the digest collapses each friction CLUSTER to
 *     ONE pattern whose ref is the cluster's EXEMPLAR (its newest member). So this
 *     surfaces a filing that is the exemplar of a surfaced pattern; a filing that
 *     merely co-occurred in a cluster it did not headline is NOT counted. This
 *     under-counts rather than over-counts (a filer's own recent rows are usually
 *     the newest ⇒ the exemplar), and it matches the plan's literal model
 *     ("patterns carry refs → join to observation issue_ids"). We do NOT reach into
 *     cluster membership — that is a bigger change to the digest core, out of scope
 *     for a read-only readback.
 *   - A routed idea grounds on a pattern when the pattern's ref is in the idea's
 *     `addresses_pattern_refs` (the same grounding contract Scout's ideators write).
 *     An idea's cached `outcome` column tells us whether that grounded idea shipped
 *     (`won`) — a slightly-stale cache is fine for a motivational readback.
 *
 * D-016 leg conventions (mirrors P-017/P-019/P-020):
 *   - PURE core (patternRefToIssueId / flattenObservationCitablePatterns /
 *     computeObservationsImpact) is exhaustively testable with no PG;
 *   - the IMPURE resolver is FAIL-OPEN — every failure mode degrades to a
 *     filings-only (or empty) block, never a throw, so it can never break the
 *     ideation-feedback read it rides;
 *   - env kill switch PAPERCUSP_SU_OBS_IMPACT=off;
 *   - VITEST-inert unless deps are injected (the real path synthesizes the whole
 *     state-of-Hive digest — many PG reads — which unrelated tests must never pay).
 */
import { getOrgPg } from '@papercusp/db-org';
import type { MetaPattern } from './types';
import type { StateOfHiveDigest } from './corpus-digest';

/** Kill switch (flag-ON default): PAPERCUSP_SU_OBS_IMPACT=off omits the block entirely. */
export const OBS_IMPACT_KILL_ENV = 'PAPERCUSP_SU_OBS_IMPACT';
/** The filing window — "your recent observations". */
export const OBS_IMPACT_WINDOW_DAYS = 7;
/** How many of the agent's observations to scan for the window (newest-first, then filtered). */
export const OBS_READ_LIMIT = 2000;
/** How many grounded routed ideas to surface (newest-first). */
export const GROUNDED_IDEA_LIMIT = 200;

const DAY_MS = 24 * 60 * 60 * 1000;

/** One of the agent's own recent `lane:observation` filings. */
export interface ObservationFiling {
  /** The engineer_issue id — the drill-back key the digest ref carries as `wi:<id>`. */
  id: string;
  title?: string;
  filedAtMs: number;
}

/** A flattened digest meta-pattern (only the fields the join needs). */
export interface DigestPatternView {
  ref: string;
  summary: string;
  category?: string;
  weight?: number;
}

/** An idea's real-world fate as read from the ledger's cached `outcome` column. */
export type IdeaImpactOutcome = 'won' | 'lost' | 'pending';

/** One routed idea that grounds on ≥1 pattern (before the pure per-observation scoping). */
export interface GroundedIdeaRow {
  ideaId: string;
  title?: string;
  routedRef: string;
  origin?: string;
  outcome: IdeaImpactOutcome;
  addressesPatternRefs: string[];
}

/** A digest pattern that cites one of the agent's own filings. */
export interface ImpactPattern {
  ref: string;
  summary: string;
  category?: string;
  weight?: number;
  /** Which of the agent's 7d filing ids this pattern's ref resolves to. */
  citesObservationId: string;
}

/** A routed idea grounded on ≥1 pattern that cites the agent's filings. */
export interface ImpactIdea {
  ideaId: string;
  title?: string;
  routedRef: string;
  origin?: string;
  outcome: IdeaImpactOutcome;
  /** The citing pattern refs this idea grounds on (⊆ the citing patterns' refs). */
  viaPatternRefs: string[];
}

/**
 * The DENOMINATOR for `surfacedAsPattern` (EI-20305547503222578).
 *
 * A bare `surfacedAsPattern` count cannot be read on its own, because the ceiling
 * it is counting against is tiny and SHARED BY EVERY FILER: the digest collapses
 * each friction CLUSTER to one exemplar, and caps each citable lane
 * (`corpus-digest.ts` — `opts.perCategory ?? 20`, and the real path passes no
 * `perCategory`). So only a few dozen observations hive-wide are cited as exemplars
 * at any instant, against a filing population orders of magnitude larger. The
 * overwhelmingly common reading is therefore `surfacedAsPattern: 0` — the EXPECTED
 * output of a fully healthy pipeline, previously indistinguishable from a dead one.
 *
 * These counts are DERIVED from the same digest read that produces the numerator
 * (never hand-maintained), so they cannot drift from the mechanism they describe.
 */
export interface SurfacingBasis {
  /** Citable-lane patterns the digest surfaced hive-wide on THIS read. */
  citableSlotsHiveWide: number;
  /**
   * Of those, the slots whose ref actually names an observation (`wi:<id>`) — the
   * real ceiling on `surfacedAsPattern`, competed for by every filer at once.
   */
  observationNamingSlots: number;
  /**
   * True when the digest was NOT read on this call (the no-filings short-circuit, or
   * a failed digest/grounding leg), so the slot counts above are UNKNOWN rather than
   * zero. Branch on this before comparing the numerator to them: reporting a
   * not-measured ceiling as `0` would replace one misleading zero with another.
   */
  slotsUnknown?: boolean;
  /** Why the bare count is uninterpretable. Deliberately carries no numbers, so it cannot drift. */
  note: string;
}

/** The mechanism note carried on every {@link SurfacingBasis}. */
export const SURFACING_BASIS_NOTE =
  'The digest collapses each friction cluster to ONE exemplar and caps each citable lane, so only ' +
  'the slots counted here are cited hive-wide at any instant — shared across every filer. A zero ' +
  'is therefore the expected reading for the large majority of filers and is NOT evidence that ' +
  'your filings went unread or that the pipeline is dead.';

/** The demand-pull observation→impact readback (P-021). */
export interface ObservationsImpact {
  /** The agent's own `lane:observation` filings in the last {@link OBS_IMPACT_WINDOW_DAYS} days. */
  filings: ObservationFiling[];
  /** Digest meta-patterns whose exemplar ref cites one of those filings. */
  patterns: ImpactPattern[];
  /** Routed ideas grounded on those citing patterns (Scout's OR su's). */
  ideas: ImpactIdea[];
  summary: {
    filings: number;
    /**
     * Distinct filings that surfaced as a cited pattern (the exemplar of one).
     * NEVER read this without {@link SurfacingBasis} beside it — on its own a `0`
     * is the modal output of a HEALTHY pipeline, not a signal about your filings.
     */
    surfacedAsPattern: number;
    ideasGrounded: number;
    /** Grounded ideas whose routed artifact shipped (`outcome === 'won'`). */
    shipped: number;
    /** The denominator + base rate that make `surfacedAsPattern` readable. */
    basis: SurfacingBasis;
  };
  /** Present only when the digest/grounding leg failed — filings still return (fail-open). */
  error?: string;
}

/** Injectable read seam (tests + any future space) — all fail-open at the call site. */
export interface ObservationImpactDeps {
  /** The agent's own `lane:observation` filings at/after `sinceMs`. */
  loadFilings: (createdBy: string, sinceMs: number) => Promise<ObservationFiling[]>;
  /** Synthesize the current state-of-Hive digest (the pattern source). */
  synthesizeDigest: () => Promise<StateOfHiveDigest>;
  /** Routed ideas whose `addresses_pattern_refs` overlaps any of `patternRefs`. */
  loadGroundedIdeas: (patternRefs: readonly string[]) => Promise<GroundedIdeaRow[]>;
}

/**
 * The engineer_issue id a digest pattern's ref drills back to, or null when the
 * ref is not a `wi:<id>` drill-back (PURE). Digest lanes tag their refs by kind
 * (`wi:` friction / reverts, `plan:` deferrals, `usage:` spend, `rubric:` ratings,
 * `niche:` map); only a `wi:` ref can name an observation filing.
 */
export function patternRefToIssueId(ref: string): string | null {
  if (typeof ref !== 'string' || !ref.startsWith('wi:')) return null;
  const id = ref.slice(3).trim();
  return id || null;
}

/**
 * Flatten the digest lanes that can cite an observation (PURE): the FRICTION-derived
 * lanes (recurringFriction, capabilityGaps, rubricGaps) — the only ones whose refs
 * are `wi:<engineer_issue_id>` sourced from the observation-unioned friction reader.
 * The other lanes (spend `usage:`, deferrals `plan:`, ratings `rubric:`, niche map)
 * carry non-observation refs and are skipped.
 */
export function flattenObservationCitablePatterns(digest: StateOfHiveDigest): DigestPatternView[] {
  const lanes: ReadonlyArray<readonly MetaPattern[] | undefined> = [
    digest.recurringFriction,
    digest.capabilityGaps,
    digest.rubricGaps,
  ];
  const out: DigestPatternView[] = [];
  for (const lane of lanes) {
    if (!lane) continue;
    for (const p of lane) {
      if (!p || typeof p.ref !== 'string') continue;
      out.push({
        ref: p.ref,
        summary: p.summary,
        ...(p.category ? { category: p.category } : {}),
        ...(p.weight != null ? { weight: p.weight } : {}),
      });
    }
  }
  return out;
}

/**
 * The pure impact join (PURE): my filings × digest patterns × grounded ideas →
 * the {@link ObservationsImpact} funnel. `patterns` are the flattened citable
 * lanes; `ideas` are the routed ideas that already overlap ≥1 pattern ref (the
 * impure loader pre-filters), re-scoped HERE to only the CITING patterns' refs so
 * an idea grounding on someone else's pattern in the same batch is not miscredited.
 */
export function computeObservationsImpact(
  filings: readonly ObservationFiling[],
  patterns: readonly DigestPatternView[],
  ideas: readonly GroundedIdeaRow[],
  opts: {
    /**
     * Did `patterns` actually come from a digest read? Default true — the supplied
     * array IS the read. The impure resolver passes `false` when the digest leg threw,
     * so an empty array is reported as an UNKNOWN ceiling rather than a measured zero.
     */
    patternsRead?: boolean;
  } = {},
): ObservationsImpact {
  const myIds = new Set(filings.map((f) => f.id));

  // Patterns whose exemplar ref resolves to one of my filings.
  const citing: ImpactPattern[] = [];
  for (const p of patterns) {
    const iid = patternRefToIssueId(p.ref);
    if (iid && myIds.has(iid)) {
      citing.push({
        ref: p.ref,
        summary: p.summary,
        ...(p.category ? { category: p.category } : {}),
        ...(p.weight != null ? { weight: p.weight } : {}),
        citesObservationId: iid,
      });
    }
  }
  const citingRefs = new Set(citing.map((p) => p.ref));

  // Ideas grounded on a CITING pattern (scoped from the pre-filtered batch).
  const grounded: ImpactIdea[] = [];
  for (const idea of ideas) {
    const via = idea.addressesPatternRefs.filter((r) => citingRefs.has(r));
    if (via.length === 0) continue;
    grounded.push({
      ideaId: idea.ideaId,
      ...(idea.title ? { title: idea.title } : {}),
      routedRef: idea.routedRef,
      ...(idea.origin ? { origin: idea.origin } : {}),
      outcome: idea.outcome,
      viaPatternRefs: via,
    });
  }

  const surfaced = new Set(citing.map((p) => p.citesObservationId));
  const shipped = grounded.filter((i) => i.outcome === 'won').length;
  // The ceiling `surfacedAsPattern` is counted against, derived from the SAME digest
  // read that produced the numerator (EI-20305547503222578). `patterns` here is the
  // hive-wide citable set — not just the citing subset — so this is every filer's
  // shared denominator, not this agent's own tally.
  const patternsRead = opts.patternsRead !== false;
  const basis: SurfacingBasis = {
    citableSlotsHiveWide: patternsRead ? patterns.length : 0,
    observationNamingSlots: patternsRead
      ? patterns.filter((p) => patternRefToIssueId(p.ref) != null).length
      : 0,
    ...(patternsRead ? {} : { slotsUnknown: true as const }),
    note: SURFACING_BASIS_NOTE,
  };
  return {
    filings: [...filings],
    patterns: citing,
    ideas: grounded,
    summary: {
      filings: filings.length,
      surfacedAsPattern: surfaced.size,
      ideasGrounded: grounded.length,
      shipped,
      basis,
    },
  };
}

/** The ledger's cached outcome string → the three-valued view (unknown/NULL ⇒ pending). */
function normalizeOutcome(raw: string | null): IdeaImpactOutcome {
  return raw === 'won' || raw === 'lost' ? raw : 'pending';
}

/**
 * The agent's own recent `lane:observation` filings, via the SAME topic-scoped
 * reader the digest reads (readObservationItems, OBSERVATION_TOPIC) so the id space
 * matches the digest's `wi:<id>` refs exactly. Reads newest-first up to
 * {@link OBS_READ_LIMIT}, then keeps this agent's rows inside the window. A busy
 * hive that exceeds the cap can under-surface the oldest window rows — acceptable
 * fail-soft for a motivational readback.
 */
async function loadFilingsReal(createdBy: string, sinceMs: number): Promise<ObservationFiling[]> {
  const { readObservationItems } = await import('../harness/improvements/read-items');
  const rows = await readObservationItems({ limit: OBS_READ_LIMIT });
  const out: ObservationFiling[] = [];
  for (const c of rows) {
    if (c.createdBy !== createdBy) continue;
    const ms = Date.parse(c.createdAt ?? '');
    if (!Number.isFinite(ms) || ms < sinceMs) continue;
    out.push({ id: c.id, ...(c.title ? { title: c.title } : {}), filedAtMs: ms });
  }
  return out;
}

async function synthesizeDigestReal(): Promise<StateOfHiveDigest> {
  const [{ synthesizeStateOfHive }, { buildStateOfHiveReaders }] = await Promise.all([
    import('./corpus-digest'),
    import('./corpus-digest-deps'),
  ]);
  return synthesizeStateOfHive(buildStateOfHiveReaders(), { nowMs: Date.now() });
}

/**
 * Routed ideas whose `addresses_pattern_refs` overlaps any citing pattern ref.
 * Uses `jsonb_exists_any` (the `?|` operator's function form — avoids any `?`
 * parse ambiguity) over the refs shipped as a JSON-text param and expanded
 * server-side (the getOrgPg postgres-js client won't serialize a JS array param).
 * NOT workspace-narrowed — the refs are globally-unique `wi:<id>` drill-backs, and
 * in-process tool dispatch runs under the 'default' ALS workspace while the ledger
 * rows carry the active one (the readScoutPlanRefs / EI-346 class).
 */
async function loadGroundedIdeasReal(patternRefs: readonly string[]): Promise<GroundedIdeaRow[]> {
  if (patternRefs.length === 0) return [];
  const { sql } = getOrgPg();
  const payload = JSON.stringify([...patternRefs]);
  const rows = await sql<
    Array<{
      idea_id: string;
      title: string | null;
      routed_ref: string;
      origin: string | null;
      outcome: string | null;
      addresses_pattern_refs: string[] | null;
    }>
  >`
    SELECT idea_id, title, routed_ref, origin, outcome, addresses_pattern_refs
      FROM harness_shared.scout_routed_ideas
     WHERE addresses_pattern_refs IS NOT NULL
       AND jsonb_exists_any(
             addresses_pattern_refs,
             (SELECT array_agg(value) FROM jsonb_array_elements_text(${payload}::text::jsonb) AS t(value))
           )
     ORDER BY routed_at DESC
     LIMIT ${GROUNDED_IDEA_LIMIT}`;
  return rows.map((r) => ({
    ideaId: r.idea_id,
    ...(r.title ? { title: r.title } : {}),
    routedRef: r.routed_ref,
    ...(r.origin ? { origin: r.origin } : {}),
    outcome: normalizeOutcome(r.outcome),
    addressesPatternRefs: Array.isArray(r.addresses_pattern_refs)
      ? r.addresses_pattern_refs.filter((x): x is string => typeof x === 'string')
      : [],
  }));
}

const realDeps: ObservationImpactDeps = {
  loadFilings: loadFilingsReal,
  synthesizeDigest: synthesizeDigestReal,
  loadGroundedIdeas: loadGroundedIdeasReal,
};

/**
 * Resolve the observation→impact readback for one agent (IMPURE leg). Never throws
 * — every failure mode returns `undefined` (block omitted) or a filings-only block
 * so the fire-and-forget `blender:ideation-feedback` read it rides is untouched.
 *
 * Short-circuits: kill switch / VITEST-without-deps ⇒ undefined; no filings ⇒ an
 * empty block WITHOUT synthesizing the (heavy) digest; a digest/grounding error ⇒
 * a filings-only block with `error` set (fail-open, D-016).
 */
export async function resolveObservationsImpact(
  createdBy: string,
  opts: { nowMs?: number } = {},
  deps?: ObservationImpactDeps,
): Promise<ObservationsImpact | undefined> {
  try {
    if (process.env[OBS_IMPACT_KILL_ENV] === 'off') return undefined;
    if (process.env.VITEST && !deps) return undefined;
    const who = (createdBy ?? '').trim();
    if (!who) return undefined;
    const d = deps ?? realDeps;
    const nowMs = opts.nowMs ?? Date.now();
    const sinceMs = nowMs - OBS_IMPACT_WINDOW_DAYS * DAY_MS;

    const filings = await d.loadFilings(who, sinceMs).catch(() => [] as ObservationFiling[]);
    // No filings ⇒ nothing to attribute; skip the heavy digest synthesis entirely.
    if (filings.length === 0) {
      return {
        filings: [],
        patterns: [],
        ideas: [],
        summary: {
          filings: 0,
          surfacedAsPattern: 0,
          ideasGrounded: 0,
          shipped: 0,
          // This path deliberately skips the heavy digest synthesis, so the ceiling was
          // never measured — report it UNKNOWN. (Here the zero numerator is unambiguous
          // anyway: you filed nothing. The marker keeps the basis honest regardless.)
          basis: {
            citableSlotsHiveWide: 0,
            observationNamingSlots: 0,
            slotsUnknown: true,
            note: SURFACING_BASIS_NOTE,
          },
        },
      };
    }

    let patterns: DigestPatternView[] = [];
    let ideas: GroundedIdeaRow[] = [];
    let error: string | undefined;
    try {
      const digest = await d.synthesizeDigest();
      patterns = flattenObservationCitablePatterns(digest);
      // Only fetch grounded ideas for patterns that actually cite my filings.
      const myIds = new Set(filings.map((f) => f.id));
      const citingRefs = patterns
        .filter((p) => {
          const iid = patternRefToIssueId(p.ref);
          return iid != null && myIds.has(iid);
        })
        .map((p) => p.ref);
      ideas = citingRefs.length > 0 ? await d.loadGroundedIdeas(citingRefs) : [];
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }

    // A failed digest leg leaves `patterns` empty for a reason that is NOT "the digest
    // surfaced nothing" — so the ceiling is unknown, never a measured zero.
    const impact = computeObservationsImpact(filings, patterns, ideas, {
      patternsRead: error === undefined,
    });
    return error ? { ...impact, error } : impact;
  } catch {
    return undefined;
  }
}
