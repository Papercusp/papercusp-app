/**
 * Gym quality-diversity ARCHIVE (P-010, hive-creative-ideation-2026-06-08 D-008) — the
 * MAP-Elites novelty/diversity archive over gym candidates: one best-fitness elite per
 * niche cell (scope/domain/risk). It reframes the gym from objective-driven hill-climbing
 * into quality-diversity search — it preserves the best idea in EVERY region of the
 * behavior space (diversity + stepping-stones), not just the single global champion.
 *
 * This module is the `ArchiveAPI` the other gym-QD pieces consume as an injected port:
 *   • P-011 (selection)  — `noveltyScore(descriptor, k)` to bias parent selection toward
 *                          sparse regions (distance-from-archive), not fitness alone.
 *   • P-012 (Scout wire) — `listElites` / `steppingStones` to feed Scout diverse seeds, and
 *                          `upsertElite({source:'scout', …})` to seed distant niches Scout finds.
 *   • P-013 (outcome)    — joins on candidateId (= the gym variant_id) for attribution.
 *
 * The MAP-Elites + novelty-search math is in `./niche` (pure, feature-vector based, gym-
 * agnostic). `QdArchive` is the impl over an injected `ArchiveStore` so it's unit-tested
 * against `InMemoryArchiveStore` (here) and runs in prod against `PgArchiveStore`
 * (./archive-store-pg). v1 assumes a single writer per harness (the optimization loop), so
 * the insert-if-better decision is made at this layer over a `store.list()` read; concurrent
 * cross-process writers would want optimistic concurrency (a follow-up, not needed today).
 */
import {
  type ArchiveElite,
  type ArchiveSource,
  type BehaviorDescriptor,
  featureDistance,
  GYM_NICHE_CELL_COUNT,
  nicheKey,
  noveltyFromMembers,
} from './niche';

/** A candidate offered to the archive — enough to admit it as a niche elite. */
export interface ArchiveCandidate {
  /** The candidate's id. For gym candidates this is the gym variant_id (P-013 join key). */
  candidateId: string;
  descriptor: BehaviorDescriptor;
  /** Higher = better (the gym train-aggregate composite, or a Scout prior). */
  fitness: number;
  /** Defaults to 'gym'. Scout seeding passes 'scout'. */
  source?: ArchiveSource;
  rationale?: string | null;
}

/** The result of offering a candidate to the archive. */
export interface UpsertResult {
  /** True iff the candidate became (or stayed) the niche's elite. */
  admitted: boolean;
  reason: 'new-niche' | 'improved' | 'dominated';
  nicheKey: string;
  /** True iff the cell was empty before this offer (a genuinely new region). */
  isNewNiche: boolean;
  /** The candidate's distance-from-archive at offer time (pre-insert, nearest of any cell). */
  novelty: number;
  /** The displaced elite's candidateId, if this offer replaced an incumbent. */
  replaced?: string;
  /** The resulting niche elite — the candidate (admitted) or the incumbent (dominated). */
  elite: ArchiveElite;
}

export interface CoverageStat {
  filled: number;
  total: number;
  fraction: number;
}

/**
 * Persistence port for the archive (one elite per niche cell). `put` is a plain
 * set-this-cell upsert; the insert-if-better policy lives in `QdArchive`.
 */
export interface ArchiveStore {
  get(nicheKey: string): Promise<ArchiveElite | null>;
  put(elite: ArchiveElite): Promise<void>;
  list(opts?: { source?: ArchiveSource; limit?: number }): Promise<ArchiveElite[]>;
}

/**
 * The ArchiveAPI port consumed by P-011 (selection), P-012 (Scout bridge), and any gym
 * read-tool. Async throughout (the prod impl hits PG); P-011 precomputes `noveltyScore`
 * per frontier member at the loop layer and keeps its selection pure/sync.
 */
export interface ArchiveAPI {
  upsertElite(c: ArchiveCandidate, now?: number): Promise<UpsertResult>;
  getElite(nicheKey: string): Promise<ArchiveElite | null>;
  listElites(opts?: { source?: ArchiveSource; limit?: number }): Promise<ArchiveElite[]>;
  /** Mean distance to the k nearest archive members (the novelty-search score, 0..1). */
  noveltyScore(d: BehaviorDescriptor, k?: number): Promise<number>;
  coverage(): Promise<CoverageStat>;
  /** A diverse set of elites for Scout to build on (P-012). */
  steppingStones(opts?: { descriptor?: BehaviorDescriptor; k?: number }): Promise<ArchiveElite[]>;
}

/** Deterministic order: highest fitness first, then niche key ascending (tie-break). */
function byFitnessDesc(a: ArchiveElite, b: ArchiveElite): number {
  return b.fitness - a.fitness || (a.nicheKey < b.nicheKey ? -1 : a.nicheKey > b.nicheKey ? 1 : 0);
}

/**
 * Greedy farthest-point spread: a maximally-diverse subset of `k` elites. Seeded by the
 * fittest, then repeatedly add the elite whose nearest already-chosen neighbour is most
 * distant. Deterministic (fitness then nicheKey tie-breaks).
 */
function farthestPointSpread(elites: readonly ArchiveElite[], k: number): ArchiveElite[] {
  const pool = [...elites].sort(byFitnessDesc);
  if (pool.length <= k) return pool;
  const chosen: ArchiveElite[] = [pool[0]];
  while (chosen.length < k) {
    let best: ArchiveElite | null = null;
    let bestMinDist = -1;
    for (const cand of pool) {
      if (chosen.includes(cand)) continue;
      let minDist = Infinity;
      for (const c of chosen) {
        const d = featureDistance(cand.descriptor.features, c.descriptor.features);
        if (d < minDist) minDist = d;
      }
      if (minDist > bestMinDist || (minDist === bestMinDist && best !== null && cand.nicheKey < best.nicheKey)) {
        bestMinDist = minDist;
        best = cand;
      }
    }
    if (!best) break;
    chosen.push(best);
  }
  return chosen;
}

/** In-memory `ArchiveStore` for tests + ephemeral use (one elite per cell). */
export class InMemoryArchiveStore implements ArchiveStore {
  private readonly cells = new Map<string, ArchiveElite>();

  async get(key: string): Promise<ArchiveElite | null> {
    return this.cells.get(key) ?? null;
  }

  async put(elite: ArchiveElite): Promise<void> {
    this.cells.set(elite.nicheKey, { ...elite });
  }

  async list(opts?: { source?: ArchiveSource; limit?: number }): Promise<ArchiveElite[]> {
    let out = [...this.cells.values()];
    if (opts?.source) out = out.filter((e) => e.source === opts.source);
    out.sort(byFitnessDesc);
    if (opts?.limit != null) out = out.slice(0, opts.limit);
    return out;
  }
}

/** The MAP-Elites quality-diversity archive over an injected `ArchiveStore`. */
export class QdArchive implements ArchiveAPI {
  constructor(private readonly store: ArchiveStore) {}

  async upsertElite(c: ArchiveCandidate, now: number = Date.now()): Promise<UpsertResult> {
    const key = nicheKey(c.descriptor.coords);
    const members = await this.store.list();
    // The candidate's novelty = its distance to the nearest occupied cell of ANY kind
    // (include self-cell occupant: landing on a covered region is genuinely novelty 0).
    const novelty = noveltyFromMembers(c.descriptor.features, members.map((m) => m.descriptor.features), 1, {
      excludeSelf: false,
    });
    const incumbent = members.find((m) => m.nicheKey === key) ?? null;
    const elite: ArchiveElite = {
      nicheKey: key,
      coords: c.descriptor.coords,
      candidateId: c.candidateId,
      fitness: c.fitness,
      descriptor: c.descriptor,
      source: c.source ?? 'gym',
      rationale: c.rationale ?? null,
      updatedAt: now,
    };
    if (!incumbent) {
      await this.store.put(elite);
      return { admitted: true, reason: 'new-niche', nicheKey: key, isNewNiche: true, novelty, elite };
    }
    if (c.fitness > incumbent.fitness) {
      await this.store.put(elite);
      return { admitted: true, reason: 'improved', nicheKey: key, isNewNiche: false, novelty, replaced: incumbent.candidateId, elite };
    }
    return { admitted: false, reason: 'dominated', nicheKey: key, isNewNiche: false, novelty, elite: incumbent };
  }

  async getElite(key: string): Promise<ArchiveElite | null> {
    return this.store.get(key);
  }

  async listElites(opts?: { source?: ArchiveSource; limit?: number }): Promise<ArchiveElite[]> {
    return this.store.list(opts);
  }

  async noveltyScore(d: BehaviorDescriptor, k = 3): Promise<number> {
    const members = await this.store.list();
    return noveltyFromMembers(d.features, members.map((m) => m.descriptor.features), k);
  }

  async coverage(): Promise<CoverageStat> {
    const filled = (await this.store.list()).length;
    const total = GYM_NICHE_CELL_COUNT;
    return { filled, total, fraction: total ? filled / total : 0 };
  }

  async steppingStones(opts: { descriptor?: BehaviorDescriptor; k?: number } = {}): Promise<ArchiveElite[]> {
    const k = Math.max(1, opts.k ?? 5);
    const all = await this.store.list();
    if (all.length <= k) return all;
    if (opts.descriptor) {
      // Exploration seeds for a given anchor: the k elites FARTHEST from it (distant niches).
      const f = opts.descriptor.features;
      return [...all]
        .map((e) => ({ e, d: featureDistance(f, e.descriptor.features) }))
        .sort((a, b) => b.d - a.d || (a.e.nicheKey < b.e.nicheKey ? -1 : a.e.nicheKey > b.e.nicheKey ? 1 : 0))
        .slice(0, k)
        .map((x) => x.e);
    }
    // No anchor: a maximally-diverse spread across the whole archive.
    return farthestPointSpread(all, k);
  }
}
