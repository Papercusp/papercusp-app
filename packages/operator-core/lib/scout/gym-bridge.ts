/**
 * Scout ↔ gym quality-diversity bridge (hive-creative-ideation P-012, D-008).
 *
 * The two-way wire between the **Scout loop** (generative exploration — broad novel
 * ideas) and the gym's **MAP-Elites novelty/diversity archive** (P-010), so the two
 * creative rails reinforce each other instead of running blind:
 *
 *   • archive → Scout  (`gatherSteppingStones`): surface a *maximally diverse* sample
 *     of the archive's preserved elites as priming for Scout's divergent generation
 *     (P-004) + recombine (P-006). Scout builds on stepping-stones the gym has actually
 *     discovered rather than re-deriving them — and is pulled toward sparse regions.
 *
 *   • Scout → archive  (`seedDistantNiches`): take Scout's routable ideas, compute their
 *     behavioural descriptor, and seed the ones that land in *genuinely distant* niches
 *     (far from everything in the archive) so the gym's QD selection (P-011) explores
 *     toward niches objective-driven hill-climbing would never reach.
 *
 * Pure + port-injected by design: it depends on the gym archive only through the small
 * `ArchiveReadPort` / `ArchiveSeedPort` interfaces (an adapter binds them to su-8075f's
 * real `Archive` in lib/gym/qd/archive.ts), and on Scout ideas only through
 * `ScoutIdeaView`. No PG, no LLM, no gym/scout file imports — fully unit-testable before
 * either upstream lands.
 *
 * The behaviour space (D-008): niches across **scope / domain / risk**. `behaviorDistance`
 * is the single shared notion of "distance in behaviour space" — P-011's `noveltyScore`
 * should equal mean-distance-to-k-nearest over the same metric so selection + seeding +
 * stepping-stone sampling all agree.
 */

// ── Behaviour space ─────────────────────────────────────────────────────────

/** How broad the idea's blast radius is (MAP-Elites axis 1). */
export type ScopeBand = 'local' | 'module' | 'cross-cutting' | 'architectural';
/** How risky the idea is to land (MAP-Elites axis 3). */
export type RiskBand = 'low' | 'medium' | 'high';

/** Ordinal order of the discretised bands (for the continuous feature projection). */
export const SCOPE_ORDER: readonly ScopeBand[] = ['local', 'module', 'cross-cutting', 'architectural'];
export const RISK_ORDER: readonly RiskBand[] = ['low', 'medium', 'high'];

/** A cell in the MAP-Elites behaviour grid. `domain` is a coarse subsystem tag, lowercased. */
export interface NicheCoords {
  scope: ScopeBand;
  domain: string;
  risk: RiskBand;
}

/**
 * A point in behaviour space: the discrete `coords` (the niche cell) plus a normalized
 * continuous `features` vector (each component in [0,1]) used for novelty-distance.
 * Shared shape across the gym-QD sub-system (P-010/P-011/P-012/P-013).
 */
export interface BehaviorDescriptor {
  coords: NicheCoords;
  features: number[];
}

/** The archive's stable cell id: `scope|domain|risk`. */
export function nicheKey(c: NicheCoords): string {
  return `${c.scope}|${c.domain.trim().toLowerCase()}|${c.risk}`;
}

export function scopeOrdinal(s: ScopeBand): number {
  const i = SCOPE_ORDER.indexOf(s);
  return i < 0 ? 0 : i;
}
export function riskOrdinal(r: RiskBand): number {
  const i = RISK_ORDER.indexOf(r);
  return i < 0 ? 0 : i;
}

/**
 * Distance between two points in behaviour space — the ONE shared metric.
 * Euclidean over the continuous `features` (length-tolerant: shorter vectors are
 * zero-padded) plus a categorical penalty when the `domain` differs (continuous axes
 * can't express categorical separation). `domainWeight` defaults to 1.0 — a different
 * subsystem is "one feature-unit" apart.
 */
export function behaviorDistance(a: BehaviorDescriptor, b: BehaviorDescriptor, domainWeight = 1): number {
  const n = Math.max(a.features.length, b.features.length);
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const d = (a.features[i] ?? 0) - (b.features[i] ?? 0);
    sumSq += d * d;
  }
  const domainTerm = a.coords.domain.trim().toLowerCase() === b.coords.domain.trim().toLowerCase() ? 0 : domainWeight * domainWeight;
  return Math.sqrt(sumSq + domainTerm);
}

/**
 * Novelty = mean distance to the `k` nearest elites already in the archive (Lehman &
 * Stanley's sparseness measure). Empty archive ⇒ maximally novel (`Infinity` collapsed
 * to a large finite sentinel by the caller as needed; here we return `Infinity` so an
 * empty/distant region is unambiguously "open"). This is the metric P-011's
 * `archive.noveltyScore` should reproduce so selection + seeding agree.
 */
export function noveltyDistance(d: BehaviorDescriptor, elites: readonly { descriptor: BehaviorDescriptor }[], k = 3): number {
  if (elites.length === 0) return Infinity;
  const dists = elites.map((e) => behaviorDistance(d, e.descriptor)).sort((x, y) => x - y);
  const take = Math.min(k, dists.length);
  let sum = 0;
  for (let i = 0; i < take; i++) sum += dists[i];
  return sum / take;
}

// ── Archive ports (bound to lib/gym/qd/archive.ts via an adapter) ────────────

/** A read view of one archive elite (best candidate in its niche). */
export interface ArchiveEliteView {
  nicheKey: string;
  coords: NicheCoords;
  candidateId: string;
  /** Objective quality (gym composite / dev-anchor agg); scout seeds use 0 until gym-tested. */
  fitness: number;
  descriptor: BehaviorDescriptor;
  source: 'gym' | 'scout';
  rationale?: string;
}

/** Read side of the archive the bridge needs (feed Scout). */
export interface ArchiveReadPort {
  /** All current niche elites. */
  listElites(): readonly ArchiveEliteView[];
}

/** An entry the bridge writes into the archive when Scout opens a distant niche. */
export interface ArchiveSeedEntry {
  candidateId: string;
  descriptor: BehaviorDescriptor;
  rationale?: string;
}

/** Write side of the archive the bridge needs (Scout seeds niches). */
export interface ArchiveSeedPort {
  /**
   * Upsert a scout-sourced seed. Returns whether it was admitted (empty cell, or beat the
   * incumbent's fitness — a scout seed has fitness 0, so it's admitted only into an empty
   * niche, which is exactly the "open a new distant niche" semantics we want).
   */
  seed(entry: ArchiveSeedEntry): { admitted: boolean; nicheKey: string };
}

/** Combined port (most callers hold both). */
export type ArchivePort = ArchiveReadPort & ArchiveSeedPort;

// ── Scout idea view (bound to lib/scout's idea/proposal shape) ───────────────

/**
 * The slice of a Scout idea/proposal the bridge reads. Bound to su-797a5 (P-004) /
 * su-d1170 (P-006)'s real shape via an adapter; every field except `id` is optional so
 * the default describer degrades gracefully on a partially-tagged idea.
 */
export interface ScoutIdeaView {
  id: string;
  /** Generative lens (D-004): analogical | first-principles | reframing | constraint-removal. */
  lens?: string;
  scope?: ScopeBand;
  domain?: string;
  risk?: RiskBand;
  /** Novelty critic score (P-005), 0..1. */
  novelty?: number;
  /** Feasibility critic score (P-005), 0..1. */
  feasibility?: number;
  /** In the high-novelty / low-feasibility moonshot bucket (D-005). */
  moonshot?: boolean;
  rationale?: string;
  /** The idea content (reserved for richer feature extraction). */
  text?: string;
}

/** Maps a Scout idea to a behaviour descriptor. Injectable; `describeScoutIdea` is the default. */
export type DescribeScoutIdea = (idea: ScoutIdeaView) => BehaviorDescriptor;

/**
 * Default behavioural characterisation of a Scout idea. Coords from its self-reported
 * {scope, domain, risk} with conservative fallbacks; the continuous feature vector is
 * [novelty, feasibility, scopeOrd/3, riskOrd/2] — so two ideas are "close" when their
 * novelty/feasibility/scope/risk profiles are close, and "distant" otherwise.
 */
export function describeScoutIdea(idea: ScoutIdeaView): BehaviorDescriptor {
  const scope: ScopeBand = idea.scope ?? 'module';
  const risk: RiskBand = idea.risk ?? (idea.moonshot ? 'high' : 'medium');
  const domain = (idea.domain ?? 'general').trim().toLowerCase();
  const novelty = clamp01(idea.novelty ?? (idea.moonshot ? 0.9 : 0.5));
  const feasibility = clamp01(idea.feasibility ?? 0.5);
  return {
    coords: { scope, domain, risk },
    features: [novelty, feasibility, scopeOrdinal(scope) / 3, riskOrdinal(risk) / 2],
  };
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

// ── archive → Scout : stepping-stones ────────────────────────────────────────

export interface SteppingStoneOptions {
  /** Max stepping-stones to surface. Default 5. */
  count?: number;
  /**
   * Bias the diverse pick toward sparse / low-fitness-density regions (so Scout is
   * pulled to under-explored behaviour space). Default true. When false, the seed of
   * the farthest-point walk is the single highest-fitness elite instead.
   */
  biasSparse?: boolean;
}

export interface SteppingStone {
  nicheKey: string;
  coords: NicheCoords;
  candidateId: string;
  fitness: number;
  source: 'gym' | 'scout';
  rationale?: string;
}

export interface SteppingStonesResult {
  stones: SteppingStone[];
  /** A formatted priming block to inject into Scout's divergent-generation prompt. */
  priming: string;
}

/**
 * Surface a maximally DIVERSE sample of archive elites as Scout priming.
 *
 * Selection = farthest-point sampling over the elites' descriptors: seed the walk (highest
 * fitness, or — when `biasSparse` — the elite in the sparsest region), then greedily add
 * the elite *farthest* from everything already chosen. Maximising spread is the point: it
 * hands Scout the broadest cross-section of what the gym has discovered, minimising overlap
 * with what Scout would generate anyway, and spotlighting the frontier of explored space.
 */
export function gatherSteppingStones(archive: ArchiveReadPort, opts: SteppingStoneOptions = {}): SteppingStonesResult {
  const count = Math.max(0, opts.count ?? 5);
  const biasSparse = opts.biasSparse ?? true;
  const elites = [...archive.listElites()];
  if (count === 0 || elites.length === 0) {
    return { stones: [], priming: formatPriming([]) };
  }

  // Seed of the farthest-point walk.
  let seedIdx: number;
  if (biasSparse) {
    // Sparsest = highest mean distance to the rest (most isolated elite).
    seedIdx = argmax(elites.map((e, i) => meanDistanceToOthers(e, elites, i)));
  } else {
    seedIdx = argmax(elites.map((e) => e.fitness));
  }

  const chosen: number[] = [seedIdx];
  while (chosen.length < Math.min(count, elites.length)) {
    // Pick the elite whose distance to the NEAREST already-chosen elite is largest.
    let bestIdx = -1;
    let bestDist = -1;
    for (let i = 0; i < elites.length; i++) {
      if (chosen.includes(i)) continue;
      let nearest = Infinity;
      for (const c of chosen) {
        const d = behaviorDistance(elites[i].descriptor, elites[c].descriptor);
        if (d < nearest) nearest = d;
      }
      // Tie-break deterministically by candidateId for stable output.
      if (nearest > bestDist || (nearest === bestDist && bestIdx >= 0 && elites[i].candidateId < elites[bestIdx].candidateId)) {
        bestDist = nearest;
        bestIdx = i;
      }
    }
    if (bestIdx < 0) break;
    chosen.push(bestIdx);
  }

  const stones: SteppingStone[] = chosen.map((i) => {
    const e = elites[i];
    return {
      nicheKey: e.nicheKey,
      coords: e.coords,
      candidateId: e.candidateId,
      fitness: e.fitness,
      source: e.source,
      rationale: e.rationale,
    };
  });
  return { stones, priming: formatPriming(stones) };
}

function formatPriming(stones: SteppingStone[]): string {
  if (stones.length === 0) {
    return '## Gym stepping-stones\n(none yet — the quality-diversity archive is empty; generate freely.)';
  }
  const lines = stones.map((s) => {
    const where = `${s.coords.scope}/${s.coords.domain}/${s.coords.risk} risk`;
    const tag = s.source === 'scout' ? 'scout-seed' : `gym fitness ${s.fitness.toFixed(2)}`;
    const why = s.rationale ? ` — ${s.rationale}` : '';
    return `- [${where}] (${tag})${why}`;
  });
  return [
    '## Gym stepping-stones (diverse elites the colony has already discovered)',
    'Build on, recombine, or deliberately leap AWAY from these — do not re-derive them:',
    ...lines,
  ].join('\n');
}

// ── Scout → archive : seed distant niches ────────────────────────────────────

export interface SeedDistantOptions {
  /**
   * Minimum novelty-distance from the current archive for an idea to count as "distant"
   * enough to seed. Default 0 ⇒ seed any idea that lands in an *empty* niche (the archive
   * itself rejects a seed into an occupied cell, since a scout seed's fitness is 0). Raise
   * it to also require the idea to be far from occupied niches in feature space.
   */
  minDistance?: number;
  /** Always attempt to seed moonshot-bucket ideas regardless of `minDistance`. Default true. */
  includeMoonshots?: boolean;
  /** k for the novelty-distance computation. Default 3. */
  k?: number;
}

export interface SeededIdea {
  ideaId: string;
  nicheKey: string;
  admitted: boolean;
  distance: number;
}

export interface SeedDistantResult {
  /** Ideas the bridge attempted to seed (admitted or not). */
  seeded: SeededIdea[];
  /** Niche keys newly OPENED by Scout (admitted into a previously-empty cell) — coverage gain. */
  newNiches: string[];
  /** Ideas not seeded, with the reason. */
  skipped: { ideaId: string; reason: string }[];
}

/**
 * Seed the archive's distant niches from Scout's routable ideas.
 *
 * For each idea: compute its descriptor, measure its novelty-distance from the current
 * archive, and — if it's distant enough (or a moonshot) — seed it. The archive admits the
 * seed only into an empty cell, so what actually lands is Scout's exploration of niches the
 * hill-climbing gym hasn't reached. Returns the coverage gain (`newNiches`) so the caller
 * (routing → gym, P-007/su-80be9) can report it and P-013 can attribute it to lenses.
 */
export function seedDistantNiches(
  ideas: readonly ScoutIdeaView[],
  archive: ArchivePort,
  opts: SeedDistantOptions = {},
  describe: DescribeScoutIdea = describeScoutIdea,
): SeedDistantResult {
  const minDistance = opts.minDistance ?? 0;
  const includeMoonshots = opts.includeMoonshots ?? true;
  const k = opts.k ?? 3;
  const elites = archive.listElites();

  const seeded: SeededIdea[] = [];
  const newNiches: string[] = [];
  const skipped: { ideaId: string; reason: string }[] = [];

  for (const idea of ideas) {
    const descriptor = describe(idea);
    const distance = noveltyDistance(descriptor, elites, k);
    const isMoonshot = idea.moonshot === true;
    const distantEnough = distance >= minDistance; // Infinity (empty archive / open region) always passes

    if (!distantEnough && !(includeMoonshots && isMoonshot)) {
      skipped.push({ ideaId: idea.id, reason: `too close to archive (distance ${fmtDist(distance)} < ${minDistance})` });
      continue;
    }

    const res = archive.seed({ candidateId: idea.id, descriptor, rationale: idea.rationale });
    seeded.push({ ideaId: idea.id, nicheKey: res.nicheKey, admitted: res.admitted, distance });
    if (res.admitted && !newNiches.includes(res.nicheKey)) newNiches.push(res.nicheKey);
    else if (!res.admitted) {
      // Recorded in `seeded` with admitted:false; also note the occupied-cell reason for visibility.
      skipped.push({ ideaId: idea.id, reason: `niche ${res.nicheKey} already occupied (not re-opened)` });
    }
  }

  return { seeded, newNiches, skipped };
}

function fmtDist(d: number): string {
  return d === Infinity ? '∞' : d.toFixed(2);
}

// ── small array helpers (pure) ───────────────────────────────────────────────

function argmax(xs: readonly number[]): number {
  let best = 0;
  for (let i = 1; i < xs.length; i++) if (xs[i] > xs[best]) best = i;
  return best;
}

function meanDistanceToOthers(e: ArchiveEliteView, all: readonly ArchiveEliteView[], selfIdx: number): number {
  if (all.length <= 1) return 0;
  let sum = 0;
  for (let i = 0; i < all.length; i++) {
    if (i === selfIdx) continue;
    sum += behaviorDistance(e.descriptor, all[i].descriptor);
  }
  return sum / (all.length - 1);
}
