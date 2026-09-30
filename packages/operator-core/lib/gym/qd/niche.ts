/**
 * Gym quality-diversity — the shared niche / behavior-descriptor types + the MAP-Elites
 * descriptor math (P-010, hive-creative-ideation-2026-06-08 D-008).
 *
 * This is the CONTRACT module the four gym-QD pieces interlock on (agreed across
 * P-010/P-011/P-012/P-013, 2026-06-08): the discrete niche cell (`NicheCoords` across
 * scope / domain / risk), the continuous `BehaviorDescriptor` (cell + a normalized
 * feature vector used for novelty-distance), the `ArchiveElite` row shape, and the pure
 * functions that turn a gym candidate into a descriptor (`describeBehavior`) and score
 * novelty (`noveltyFromMembers`).
 *
 * Pure — no I/O, no PG, no LLM. The MAP-Elites grid + novelty-search core here is
 * deliberately gym-agnostic in its math (it operates on `number[]` feature vectors), so
 * it is extractable to `libs/generic/quality-diversity` later; only `describeBehavior`
 * + the band thresholds are gym-specific (they read a `VariantOverlay`).
 */
import type { VariantOverlay } from '../variant-overlay';

// ───────────────────────────── the niche cell (MAP-Elites grid coordinate) ─────────────────────────────

/** How structurally broad the change is (derived from how many roles it touches). */
export type ScopeBand = 'local' | 'module' | 'cross-cutting' | 'architectural';
/** How aggressive the change is (derived from its character-magnitude). */
export type RiskBand = 'low' | 'medium' | 'high';

export const SCOPE_BANDS: readonly ScopeBand[] = ['local', 'module', 'cross-cutting', 'architectural'];
export const RISK_BANDS: readonly RiskBand[] = ['low', 'medium', 'high'];
/** The coarse subsystem/role-category domains a gym candidate's change falls into. */
export const DOMAIN_VOCAB: readonly string[] = ['planning', 'execution', 'quality', 'knowledge', 'mixed'];

/** A point on the discrete MAP-Elites grid: niches across scope / domain / risk (D-008). */
export interface NicheCoords {
  scope: ScopeBand;
  /** Coarse subsystem tag, lowercased. For gym candidates this is a DOMAIN_VOCAB value. */
  domain: string;
  risk: RiskBand;
}

/**
 * A point in behavior space: the discrete cell (`coords`, the MAP-Elites niche) plus a
 * continuous `features` vector (each component normalized to [0,1]) used for the
 * novelty-distance metric. In v1 `features` is derived purely from `coords` (so two
 * candidates in the same cell are behaviorally identical for novelty); the vector is a
 * separate field so a future richer behavior characterization can extend it without
 * changing the cell grid or the consumers.
 */
export interface BehaviorDescriptor {
  coords: NicheCoords;
  features: number[];
}

/** Where an archive elite came from — a gym candidate, or a Scout-seeded idea (P-012). */
export type ArchiveSource = 'gym' | 'scout';

/** The single best-fitness elite occupying one niche cell. */
export interface ArchiveElite {
  nicheKey: string;
  coords: NicheCoords;
  candidateId: string;
  /** Higher = better. For gym candidates this is the train-aggregate judge composite. */
  fitness: number;
  descriptor: BehaviorDescriptor;
  source: ArchiveSource;
  rationale?: string | null;
  /** Epoch ms of the last write to this cell. */
  updatedAt: number;
}

/** Stable, canonical cell key — `scope|domain|risk`, domain lowercased. */
export function nicheKey(c: NicheCoords): string {
  return `${c.scope}|${c.domain.toLowerCase()}|${c.risk}`;
}

/**
 * The number of cells in the gym niche grid — the coverage denominator. The domain axis
 * is an open string, but coverage is measured against the known `DOMAIN_VOCAB` (an
 * out-of-vocab domain still occupies a real cell; it just isn't counted in the
 * denominator, so a stray domain can push `fraction` slightly past nothing meaningful).
 */
export const GYM_NICHE_CELL_COUNT = SCOPE_BANDS.length * DOMAIN_VOCAB.length * RISK_BANDS.length; // 4 × 5 × 3 = 60

// ───────────────────────────── feature vector + novelty distance ─────────────────────────────

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * The normalized feature vector for a niche cell: `[scopeNorm, riskNorm, ...oneHot(domain)]`.
 * scope/risk are ordinal axes → a normalized ordinal index in [0,1]; domain is categorical
 * → a one-hot over `DOMAIN_VOCAB` (an out-of-vocab domain → an all-zero one-hot, still a
 * valid, maximally-distinct point). Every component is in [0,1].
 */
export function coordsToFeatures(c: NicheCoords): number[] {
  const si = Math.max(0, SCOPE_BANDS.indexOf(c.scope));
  const ri = Math.max(0, RISK_BANDS.indexOf(c.risk));
  const scopeNorm = SCOPE_BANDS.length > 1 ? si / (SCOPE_BANDS.length - 1) : 0;
  const riskNorm = RISK_BANDS.length > 1 ? ri / (RISK_BANDS.length - 1) : 0;
  const dom = c.domain.toLowerCase();
  const oneHot = DOMAIN_VOCAB.map((d) => (d === dom ? 1 : 0));
  return [scopeNorm, riskNorm, ...oneHot];
}

/**
 * Normalized Euclidean distance between two feature vectors, in [0,1]. Each component is
 * in [0,1] so the max raw Euclidean distance over `n` dims is √n; dividing by √n keeps the
 * result in [0,1]. Differing-length vectors are compared up to the longer length (missing
 * components treated as 0).
 */
export function featureDistance(a: readonly number[], b: readonly number[]): number {
  const n = Math.max(a.length, b.length);
  if (n === 0) return 0;
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    sumSq += d * d;
  }
  return clamp01(Math.sqrt(sumSq) / Math.sqrt(n));
}

/**
 * The novelty-search score for `features`: the mean distance to its `k` nearest members
 * (Lehman & Stanley's novelty metric). Higher ⇒ more isolated ⇒ a sparser region of the
 * behavior space ⇒ more exploration headroom.
 *
 * `excludeSelf` (default true) drops exact (distance ≈ 0) matches so an elite that is
 * itself in `members` does not deflate its own novelty to 0 — the right semantics for
 * "how novel is this *existing* elite among the others" (P-011's parent selection). Pass
 * `excludeSelf:false` to ask "how far is this candidate from *anything* in the archive"
 * (so a candidate landing on an already-occupied cell scores 0). An empty / degenerate
 * member set ⇒ 1 (maximally novel).
 */
export function noveltyFromMembers(
  features: readonly number[],
  members: readonly (readonly number[])[],
  k = 3,
  opts: { excludeSelf?: boolean } = {},
): number {
  const excludeSelf = opts.excludeSelf ?? true;
  let dists = members.map((m) => featureDistance(features, m));
  if (excludeSelf) dists = dists.filter((d) => d > 1e-9);
  dists.sort((x, y) => x - y);
  if (dists.length === 0) return 1;
  const take = dists.slice(0, Math.max(1, k));
  return take.reduce((s, d) => s + d, 0) / take.length;
}

// ───────────────────────────── gym candidate → behavior descriptor ─────────────────────────────

/** A gym candidate (or baseline) offered to the archive, enough to derive its niche. */
export interface GymCandidate {
  /** The candidate's merged overlay (parent ⊕ proposed). */
  overlay: VariantOverlay;
  /** The parent's overlay, to size the niche delta. Absent for the baseline. */
  parentOverlay?: VariantOverlay | null;
}

/**
 * What the optimization loop hands the archive recorder for one evaluated variant (the
 * loop's `recordArchive` seam, P-010). Carries the candidate's identity + reward on top of
 * the overlay pair the niche is derived from.
 */
export interface ArchiveCandidateRecord extends GymCandidate {
  /** The variant id (= the gym variant_id; the P-013 join key). */
  variantId: string;
  /** Fitness = the variant's train-aggregate judge composite (the reward). */
  fitness: number;
  rationale?: string;
}

/** Coding-blueprint role → coarse domain. Unknown roles fall back to 'execution'. */
const ROLE_DOMAIN: Readonly<Record<string, string>> = Object.freeze({
  scoper: 'planning',
  architect: 'planning',
  worker: 'execution',
  validator: 'quality',
  reviewer: 'quality',
  documenter: 'knowledge',
  curator: 'knowledge',
});

/** Char-magnitude thresholds for the risk band (markdown role-prompt deltas). Tunable. */
const RISK_LOW_MAX = 400;
const RISK_MED_MAX = 1500;

interface RoleChange {
  role: string;
  before: string | null;
  after: string;
}

/** The roles whose merged prompt actually differs from the parent's (inherited-unchanged roles are skipped). */
function changedRoles(overlay: VariantOverlay, parentOverlay?: VariantOverlay | null): RoleChange[] {
  const parent = parentOverlay?.promptOverrides ?? {};
  const out: RoleChange[] = [];
  for (const [role, after] of Object.entries(overlay.promptOverrides ?? {})) {
    const before = role in parent ? parent[role] : null;
    if (before === after) continue; // inherited, unchanged — not part of this candidate's delta
    out.push({ role, before, after });
  }
  return out;
}

function scopeBand(nChanged: number): ScopeBand {
  if (nChanged <= 1) return 'local';
  if (nChanged === 2) return 'module';
  if (nChanged <= 4) return 'cross-cutting';
  return 'architectural';
}

function riskBand(magnitude: number): RiskBand {
  if (magnitude < RISK_LOW_MAX) return 'low';
  if (magnitude < RISK_MED_MAX) return 'medium';
  return 'high';
}

/** Total character-magnitude of the change. A new role override counts its full size; a
 *  modified one counts its length delta, or its full size when the rewrite kept the length
 *  (a same-length total rewrite is high-risk, not zero). */
function changeMagnitude(changes: readonly RoleChange[]): number {
  let m = 0;
  for (const c of changes) {
    if (c.before === null) {
      m += c.after.length;
    } else {
      const lenDelta = Math.abs(c.after.length - c.before.length);
      m += lenDelta > 0 ? lenDelta : c.after.length;
    }
  }
  return m;
}

/** The domain of the change: the single role-category if all changed roles share one, else
 *  'mixed' (a cross-cutting change, or the degenerate no-change baseline). */
function domainOf(changes: readonly RoleChange[]): string {
  const domains = new Set<string>();
  for (const c of changes) domains.add(ROLE_DOMAIN[c.role] ?? 'execution');
  if (domains.size === 1) return [...domains][0];
  return 'mixed';
}

/**
 * Derive a gym candidate's behavior descriptor — its MAP-Elites niche (scope/domain/risk)
 * + the feature vector for novelty-distance. Deterministic and pure. The baseline (no
 * parent, empty overlay) maps to the degenerate cell (local, mixed, low).
 */
export function describeBehavior(candidate: GymCandidate): BehaviorDescriptor {
  const changes = changedRoles(candidate.overlay, candidate.parentOverlay);
  const coords: NicheCoords = {
    scope: scopeBand(changes.length),
    domain: domainOf(changes),
    risk: riskBand(changeMagnitude(changes)),
  };
  return { coords, features: coordsToFeatures(coords) };
}
