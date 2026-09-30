/**
 * novelty-metrics.ts — P-011 (F3-3) THE success metric of federated Scout↔gym:
 * novelty-gain-per-peer. The owner's falsifiable hypothesis is "more peers →
 * more novelty, mechanically" (D-001). This module makes it MEASURABLE, three
 * ways (D-004 F3-3), so the migration-rate-0 CONTROL hive (P-016) can be beaten
 * on evidence rather than asserted:
 *
 *   (a) unique niches occupied NETWORK-WIDE — and the slice that exists ONLY
 *       because a peer contributed it (foreign-added niches / nichesPerPeer):
 *       the direct novelty a node gains from the network. Should grow with peer
 *       count, superlinearly vs the control arm.
 *   (b) per-node idea-dedup rate — the fraction of locally-generated ideas that
 *       merely re-discover something already known; should FALL as peer count
 *       rises (repulsion priming, P-007, steers away from crowded niches).
 *   (c) foreign-seeded win-rate vs local-only — do ideas recombined from a
 *       foreign elite (P-008 `seededBy` tag) actually pay off once decided?
 *
 * Pure core — no PG, no clock, no network — mirroring quality-metrics.ts. Win
 * accounting reuses {@link winCredit} (outcome-feedback D-002) so a graded idea
 * contributes a FRACTIONAL win exactly as the per-lens win-rate does; every rate
 * is `null` (never NaN) when its denominator is zero.
 *
 * SCAFFOLD DEPENDENCY (Lane B P-008): `seededByRefs` is not yet persisted on
 * `scout_routed_ideas`; until P-008 lands the ledger column + reader, the
 * foreign-seeded bucket is empty and {@link NoveltyGainReport.foreignSeededWinRate}
 * is null — the report shape and every other metric are already live. See
 * {@link buildNoveltyGainReport} for the production assembly.
 */
import { mapV1KeyForward } from '../gym/niche-descriptor';
import {
  isControlHivePriming,
  type FederatedEliteView,
  type FederatedPrimingConfig,
} from './federated-priming';
import { winCredit, type RoutedIdeaProvenance } from './outcome-feedback';

/**
 * One routed idea's decision + provenance, the minimal subset the novelty
 * metric needs. Intentionally decoupled from `RoutedIdeaProvenance` so this
 * module never forces an edit to outcome-feedback.ts; the assembly maps the
 * ledger rows onto this shape.
 */
export interface NoveltyIdeaRow {
  /**
   * Foreign-elite refs this idea was recombined from (P-008 `seededBy:<ref>`).
   * A non-empty list ⇒ the idea is FOREIGN-SEEDED; empty/absent ⇒ local-only.
   */
  seededByRefs?: readonly string[] | null;
  /**
   * Grader's 1–5 verdict (ledger `human_grade`). A valid integer DECIDES the
   * idea and dominates the feed outcome via {@link winCredit} (D-002).
   */
  humanGrade?: number | null;
  /**
   * Change-feed-derived decided outcome, used only when the idea is ungraded.
   * 'pending'/null ⇒ undecided (excluded from win-rate denominators).
   */
  outcome?: 'won' | 'lost' | 'pending' | null;
  /**
   * True iff this idea was flagged a near-duplicate of the existing corpus at
   * routing time (the assembly derives it from corpus-novelty scoring). Absent
   * ⇒ the row does not contribute to the dedup-rate denominator.
   */
  duplicate?: boolean | null;
}

/** The novelty-gain report — the P-011 scorecard section. */
export interface NoveltyGainReport {
  /** (a) Distinct niches with ≥1 elite anywhere on the network (local ∪ foreign). */
  uniqueNichesOccupied: number;
  /** Distinct niches with ≥1 LOCAL elite. */
  localNichesOccupied: number;
  /**
   * Distinct niches occupied ONLY because a peer contributed them (foreign
   * present, no local) — the mechanical "novelty gift" a node gains from the
   * network. = uniqueNichesOccupied − localNichesOccupied.
   */
  foreignAddedNiches: number;
  /** Distinct foreign source hives contributing at least one elite. */
  peerCount: number;
  /** foreignAddedNiches / peerCount — novelty gain per peer; null when no peers. */
  nichesPerPeer: number | null;

  /** (b) Ideas that carried a duplicate/novel decision (the dedup denominator). */
  dedupConsidered: number;
  /** dedupDuplicates / dedupConsidered — should fall as peers rise; null when none considered. */
  dedupRate: number | null;

  /** (c) Foreign-seeded ideas that were DECIDED (grade or feed outcome). */
  foreignSeededDecided: number;
  /** Local-only ideas that were decided. */
  localOnlyDecided: number;
  /** Fractional win-rate over decided FOREIGN-SEEDED ideas; null until P-008 lands / none decided. */
  foreignSeededWinRate: number | null;
  /** Fractional win-rate over decided LOCAL-ONLY ideas; null when none decided. */
  localOnlyWinRate: number | null;

  /**
   * True iff this hive runs the migration-rate-0 CONTROL profile (P-016). The
   * falsifiability baseline: a control hive should show ~0 foreignAddedNiches
   * and no foreign-seeded ideas — the comparison arm P-011 is measured against.
   */
  isControlArm: boolean;
}

/** Inputs the pure core folds — production via {@link buildNoveltyGainReport}, tests via fixtures. */
export interface NoveltyGainInputs {
  /**
   * The read-time union of local `gym_qd_archive` + foreign `gym_qd_foreign_elites`
   * elites. `sourceHive` null/blank ⇒ local; non-blank ⇒ that peer's partition.
   */
  elites: readonly FederatedEliteView[];
  /** Routed-idea decisions + seed provenance (the assembly maps ledger rows here). */
  ideas: readonly NoveltyIdeaRow[];
  /**
   * This hive's resolved federated-priming config — used only to stamp
   * {@link NoveltyGainReport.isControlArm}. Omit ⇒ treated as non-control.
   */
  priming?: FederatedPrimingConfig | null;
  /** Reserved v1→v2 canonicalization seam (default: {@link mapV1KeyForward}). */
  mapKey?: (key: string) => string;
}

function isLocalSource(sourceHive?: string | null): boolean {
  return !sourceHive || sourceHive.trim().length === 0;
}

/** A valid grader verdict is an integer in [1,5]. */
function validGrade(g?: number | null): g is number {
  return typeof g === 'number' && Number.isInteger(g) && g >= 1 && g <= 5;
}

/**
 * Decide one idea into (decided, wonCredit) with the SAME semantics as the
 * per-lens win-rate (outcome-feedback D-002): a grade dominates and contributes
 * a fractional win of {@link winCredit}(grade); an ungraded idea uses its
 * feed-decided outcome (won=1 / lost=0); anything else is undecided.
 */
function decideIdea(row: NoveltyIdeaRow): { decided: boolean; wonCredit: number } {
  if (validGrade(row.humanGrade)) return { decided: true, wonCredit: winCredit(row.humanGrade) };
  if (row.outcome === 'won') return { decided: true, wonCredit: 1 };
  if (row.outcome === 'lost') return { decided: true, wonCredit: 0 };
  return { decided: false, wonCredit: 0 };
}

function isForeignSeeded(row: NoveltyIdeaRow): boolean {
  return Array.isArray(row.seededByRefs) && row.seededByRefs.length > 0;
}

/**
 * Fold a snapshot into the {@link NoveltyGainReport}. Pure + total — an empty
 * input yields an all-zero / all-null report, never a throw or a NaN.
 */
export function computeNoveltyGainReport(inputs: NoveltyGainInputs): NoveltyGainReport {
  const mapKey = inputs.mapKey ?? mapV1KeyForward;

  // (a) niche occupancy from source presence, canonicalized through the v1→v2 seam.
  const localNiches = new Set<string>();
  const anyNiches = new Set<string>();
  const peers = new Set<string>();
  for (const e of inputs.elites) {
    const key = mapKey(e.nicheKey);
    anyNiches.add(key);
    if (isLocalSource(e.sourceHive)) {
      localNiches.add(key);
    } else {
      peers.add(e.sourceHive!.trim());
    }
  }
  const uniqueNichesOccupied = anyNiches.size;
  const localNichesOccupied = localNiches.size;
  const foreignAddedNiches = uniqueNichesOccupied - localNichesOccupied;
  const peerCount = peers.size;

  // (b) dedup rate + (c) seeded/local win-rate in one pass over the ideas.
  let dedupConsidered = 0;
  let dedupDuplicates = 0;
  let seededWon = 0;
  let seededLost = 0;
  let localWon = 0;
  let localLost = 0;
  let foreignSeededDecided = 0;
  let localOnlyDecided = 0;

  for (const row of inputs.ideas) {
    if (typeof row.duplicate === 'boolean') {
      dedupConsidered += 1;
      if (row.duplicate) dedupDuplicates += 1;
    }
    const { decided, wonCredit } = decideIdea(row);
    if (!decided) continue;
    if (isForeignSeeded(row)) {
      foreignSeededDecided += 1;
      seededWon += wonCredit;
      seededLost += 1 - wonCredit;
    } else {
      localOnlyDecided += 1;
      localWon += wonCredit;
      localLost += 1 - wonCredit;
    }
  }

  const ratio = (won: number, lost: number): number | null => {
    const decided = won + lost;
    return decided > 0 ? won / decided : null;
  };

  return {
    uniqueNichesOccupied,
    localNichesOccupied,
    foreignAddedNiches,
    peerCount,
    nichesPerPeer: peerCount > 0 ? foreignAddedNiches / peerCount : null,
    dedupConsidered,
    dedupRate: dedupConsidered > 0 ? dedupDuplicates / dedupConsidered : null,
    foreignSeededDecided,
    localOnlyDecided,
    foreignSeededWinRate: ratio(seededWon, seededLost),
    localOnlyWinRate: ratio(localWon, localLost),
    isControlArm: inputs.priming ? isControlHivePriming(inputs.priming) : false,
  };
}

// ── assembly: live readers over the merged archive + routed-idea ledger ───────

/** Scope for the production readers. */
export interface NoveltyGainScope {
  workspaceId: string;
  harnessSlug: string;
  /** Per-hive lens scope (ScoutLedgerOpts.potSlug); optional. */
  potSlug?: string;
}

/** Injectable reader port — tests inject fixtures; production uses lazy PG imports. */
export interface NoveltyGainReaders {
  /** The read-time union gym_qd_archive ∪ gym_qd_foreign_elites (listFrontierElites). */
  listElites: (scope: NoveltyGainScope) => Promise<FederatedEliteView[]>;
  /** The routed-idea ledger snapshot (readRoutedIdeas), mapped onto novelty rows. */
  listIdeas: (scope: NoveltyGainScope) => Promise<NoveltyIdeaRow[]>;
}

export interface BuildNoveltyGainOptions {
  scope: NoveltyGainScope;
  /** This hive's resolved federated-priming — stamps {@link NoveltyGainReport.isControlArm}. */
  priming?: FederatedPrimingConfig | null;
  /** Override readers (tests). Missing readers fall back to the live-PG production defaults. */
  readers?: Partial<NoveltyGainReaders>;
}

/**
 * Map a routed-idea provenance row onto the novelty metric's row shape. Today
 * only the grade decides an idea; `seededByRefs` is read DEFENSIVELY so the
 * foreign-seeded bucket lights up automatically the moment Lane B's P-008 adds
 * the `seeded_by` ledger column + surfaces it on {@link RoutedIdeaProvenance} —
 * no edit to this mapper needed then.
 */
export function mapProvenanceToNoveltyRow(p: RoutedIdeaProvenance): NoveltyIdeaRow {
  const seededByRefs = (p as { seededByRefs?: readonly string[] | null }).seededByRefs;
  return {
    humanGrade: p.humanGrade ?? null,
    seededByRefs: seededByRefs ?? null,
  };
}

/** Production readers — lazy PG imports so importing this module never touches the PG edge. */
function productionReaders(): NoveltyGainReaders {
  return {
    async listElites(scope) {
      const [{ listFrontierElites }, { getOrgPg }] = await Promise.all([
        import('./foreign-frontier'),
        import('@papercusp/db-org'),
      ]);
      const rows = await listFrontierElites(getOrgPg().sql, {
        workspaceId: scope.workspaceId,
        harnessSlug: scope.harnessSlug,
      });
      return rows.map((r) => ({ nicheKey: r.nicheKey, fitness: r.fitness, sourceHive: r.sourceHive }));
    },
    async listIdeas(scope) {
      const { readRoutedIdeas } = await import('./routed-ledger');
      const rows = await readRoutedIdeas({
        workspaceId: scope.workspaceId,
        harnessSlug: scope.harnessSlug,
        potSlug: scope.potSlug,
      });
      return rows.map(mapProvenanceToNoveltyRow);
    },
  };
}

/**
 * Read the merged archive + routed-idea ledger, then fold into the P-011 report.
 * The niche-occupancy metrics (a) are live TODAY from the archive union; the
 * foreign-seeded win-rate (c) stays null until P-008 persists `seededBy`; the
 * dedup rate (b) stays null until an idea-level novelty score is threaded onto
 * the ledger read — the report shape and (a) are fully live meanwhile.
 */
export async function buildNoveltyGainReport(opts: BuildNoveltyGainOptions): Promise<NoveltyGainReport> {
  const readers: NoveltyGainReaders = { ...productionReaders(), ...opts.readers };
  const [elites, ideas] = await Promise.all([
    readers.listElites(opts.scope),
    readers.listIdeas(opts.scope),
  ]);
  return computeNoveltyGainReport({ elites, ideas, priming: opts.priming });
}
