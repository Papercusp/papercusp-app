/**
 * corpus-sweep — de-duplicate and reconcile contradictions across OUR OWN
 * memory pools (plan memory-corpus-hygiene-and-release-distribution-2026-08-03,
 * P-004).
 *
 * WHY THIS EXISTS. `knowledge_packs:sweep` re-judges a HIVE's pool, and the
 * knowledge-hygiene routine only ever enumerated hives — so the two pools that
 * actually hold this fleet's working knowledge, `harness:<slug>` and the user
 * pool, were never swept by anything. Measured 2026-08-03 by this module
 * against the live store: `harness:papercusp` held 1,583 recallable rows
 * carrying 94 exact-duplicate groups / 98 redundant rows, and nothing had ever
 * looked. (Recallable, not `state='active'`: canonical-store filters recall on
 * `state <> 'archived'` alone, so `forgotten`/`broken_anchor` rows are still
 * served and are therefore still in scope for a hygiene sweep.)
 *
 * THREE LAYERS, CHEAPEST FIRST. The judge is an LLM call per row, so it is the
 * last resort, not the first:
 *   1. EXACT DUPLICATES — deterministic, free. Same pool, byte-identical after
 *      NFKC + whitespace + case normalization. Provably redundant, so this is
 *      the only layer allowed to resolve anything automatically.
 *   2. CONTRADICTIONS — `sweepPoolConflicts` (knowledge-packs/manage), i.e.
 *      the SAME judge `knowledge_packs:sweep` uses. P-004 is explicit that we
 *      reuse it rather than author a second one.
 *   3. Resolution of a contradiction is never automatic — see below.
 *
 * TWO SAFETY RULES, BOTH LOAD-BEARING.
 *
 * (a) POOL SELECTION IS AN ALLOWLIST, NEVER A DENYLIST (plan D-015 §3). The
 *     live canonical table holds pools that must never be swept: `bench` holds
 *     342 recall-benchmark fixtures seeded from ANOTHER project (a production
 *     IP among them — EI-19451290686156597), plus out-of-enum `workspace`
 *     rows. An allowlist also excludes any pool shape added after this file
 *     was written, which a denylist of 'bench' would silently admit.
 *
 * (b) AUTO-RESOLUTION IS LOCAL-ONLY, AND SOFT. A redundant row is closed with
 *     the temporal-lite validity window (`backend.invalidateEntry`, the same
 *     primitive `memory:forget { soft:true }` uses) — never a hard delete, so
 *     every resolution stays retrievable via `include_superseded`/`as_of`.
 *     And a row that is `shareable`, non-`local` origin, or carries a
 *     `source_hive` is NEVER touched: `capture_memory_canonical_outbox_upd_trg`
 *     emits a federation op on any UPDATE `WHEN (new.shareable OR
 *     old.shareable)`, so resolving one locally would broadcast a delete to
 *     every peer over a judgement they never made. Verified while implementing
 *     P-005 (migration 747).
 *
 * Contradictions are FILED, never auto-resolved. This mirrors the posture
 * knowledge-hygiene already settled (D-002): the hive case can auto-resolve
 * only because a PRISTINE pack row is provably not the user's words and
 * organic outranks pack. In our own pool BOTH sides are organic, so there is
 * no such asymmetry to arbitrate on — a machine picking a winner between two
 * things an agent deliberately learned is a data-loss bug wearing a hygiene
 * costume.
 *
 * CONTENT-FREE LAYER (plan jev-performance-improvements-2026-09-30, P-011),
 * opt-in: the save-time substance question memory:remember asks (P-010), asked
 * of every live row, so memories stored BEFORE the save gate existed can be found.
 * A judged verdict, unlike an exact duplicate, can be wrong (the save gate
 * refuses ~0.5% of real memories), so it never resolves on its own: a report run
 * lists flagged rows, a reviewer confirms ids, and only an `apply` run given those
 * ids (`forgetContentFreeIds`) soft-forgets a confirmed row — and only when that
 * same run flags it again and it is not federated.
 *
 * Deps injectable throughout; the unit tests run with fakes — zero PG, zero
 * LLM.
 */
import { isContentFree } from './jev-conflict-judge';

/** The pools this sweep is allowed to touch. Anything else is skipped. */
export type RealPoolKind = 'harness' | 'hive' | 'user';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Classify a pool key (mem0's `payload.user_id`) into one of the real pools,
 * or `null` when it is not one.
 *
 * ALLOWLIST BY CONSTRUCTION (D-015 §3) — every branch here names a shape we
 * have positively identified. `bench`, `workspace:*`, an empty key and any
 * future shape all fall through to `null` and are never swept.
 */
export function classifyPool(poolKey: string | null | undefined): RealPoolKind | null {
  if (typeof poolKey !== 'string') return null;
  const key = poolKey.trim();
  if (!key) return null;
  if (key.startsWith('harness:') && key.length > 'harness:'.length) return 'harness';
  if (key.startsWith('hive:') && key.length > 'hive:'.length) return 'hive';
  // The user pool is keyed by the account UUID. Deliberately strict: an
  // unrecognized shape is excluded, which costs a missed sweep, where wrongly
  // ADMITTING one costs a fixture pool being "reconciled".
  if (UUID_RE.test(key)) return 'user';
  return null;
}

/**
 * Normalize a memory body for exact-duplicate comparison.
 *
 * NFKC + whitespace-collapse + case-fold. Deliberately conservative: this
 * decides what may be auto-resolved, so it only ever folds differences that
 * cannot change meaning. Anything beyond it (punctuation, stemming, near-miss
 * similarity) is a JUDGEMENT and belongs to the conflict layer, not here.
 */
export function normalizeForDedup(text: string): string {
  return text.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** One row of a real pool, as the sweep needs to see it. */
export interface CorpusRow {
  id: string;
  /** `payload.user_id` — the pool/scope key. */
  pool: string;
  text: string;
  /** ISO timestamp. */
  createdAt: string;
  /** ISO timestamp, or null when recall has never served this row. */
  lastSurfacedAt: string | null;
  /** `local` for a row this workspace wrote; anything else came from a peer. */
  origin: string;
  shareable: boolean | null;
  sourceHive: string | null;
  /** Non-null ⇒ the validity window is already closed (soft-forgotten). */
  invalidAt: string | null;
}

/** Why a redundant row could not be auto-resolved. */
export type BlockedReason = 'federated' | 'shareable' | 'already-closed';

export interface DuplicateGroup {
  pool: string;
  /** The normalized body every row in the group shares. */
  normalized: string;
  /** The row kept — see {@link pickSurvivor}. */
  survivorId: string;
  /** Redundant rows eligible for auto-resolution. */
  redundantIds: string[];
  /** Redundant rows deliberately left alone, with the rule that spared them. */
  blocked: Array<{ id: string; reason: BlockedReason }>;
  /** One verbatim body, for a human reading the report. */
  sample: string;
}

/**
 * Why a row is spared from auto-resolution, or null when it may be resolved.
 *
 * Order matters only for reporting; any single hit spares the row.
 */
export function blockedReason(row: CorpusRow): BlockedReason | null {
  if (row.invalidAt !== null) return 'already-closed';
  if (row.shareable === true) return 'shareable';
  if (row.origin !== 'local' || row.sourceHive !== null) return 'federated';
  return null;
}

/**
 * Choose which row of an exact-duplicate group survives.
 *
 * A total order, so the choice is reproducible across runs and across the
 * report/apply split (a sweep that reported one survivor and applied another
 * would be a silent data-loss bug):
 *   1. a row recall has actually SURFACED beats one it never has — that is the
 *      row `memory_feedback` / the surfaced ledger point at;
 *   2. among those, the most recently surfaced;
 *   3. else the OLDEST — dedup-on-write should have stopped the later copies
 *      existing at all, so the later ones are the defect;
 *   4. else the lowest id, purely to make the order total.
 */
export function pickSurvivor(group: CorpusRow[]): CorpusRow {
  return [...group].sort((a, b) => {
    const aS = a.lastSurfacedAt ? Date.parse(a.lastSurfacedAt) : null;
    const bS = b.lastSurfacedAt ? Date.parse(b.lastSurfacedAt) : null;
    if (aS !== null && bS === null) return -1;
    if (aS === null && bS !== null) return 1;
    if (aS !== null && bS !== null && aS !== bS) return bS - aS;
    const aC = Date.parse(a.createdAt);
    const bC = Date.parse(b.createdAt);
    if (Number.isFinite(aC) && Number.isFinite(bC) && aC !== bC) return aC - bC;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  })[0];
}

/**
 * Group a pool's rows into exact-duplicate groups. Rows with a unique
 * normalized body produce no group; a group is only emitted when it has at
 * least one redundant row.
 *
 * Rows whose validity window is ALREADY closed are excluded from grouping
 * entirely — they are out of recall, so they are not duplicates of anything a
 * reader can see, and counting them would inflate the finding.
 */
export function groupExactDuplicates(rows: CorpusRow[]): DuplicateGroup[] {
  const byKey = new Map<string, CorpusRow[]>();
  for (const row of rows) {
    if (row.invalidAt !== null) continue;
    const norm = normalizeForDedup(row.text);
    if (!norm) continue;
    // \x00 as the separator: it cannot occur in a pool key or a normalized
    // body, so no pool/body pair can collide with another by construction.
    const key = `${row.pool}\x00${norm}`;
    const bucket = byKey.get(key);
    if (bucket) bucket.push(row);
    else byKey.set(key, [row]);
  }

  const groups: DuplicateGroup[] = [];
  for (const bucket of byKey.values()) {
    if (bucket.length < 2) continue;
    const survivor = pickSurvivor(bucket);
    const redundantIds: string[] = [];
    const blocked: DuplicateGroup['blocked'] = [];
    for (const row of bucket) {
      if (row.id === survivor.id) continue;
      const reason = blockedReason(row);
      if (reason) blocked.push({ id: row.id, reason });
      else redundantIds.push(row.id);
    }
    if (redundantIds.length === 0 && blocked.length === 0) continue;
    groups.push({
      pool: survivor.pool,
      normalized: normalizeForDedup(survivor.text),
      survivorId: survivor.id,
      redundantIds: redundantIds.sort(),
      blocked: blocked.sort((a, b) => (a.id < b.id ? -1 : 1)),
      sample: survivor.text,
    });
  }
  return groups.sort((a, b) => b.redundantIds.length - a.redundantIds.length);
}

/** A contradiction pair, in the shape `sweepPoolConflicts` returns. */
export interface CorpusConflictPair {
  aId: string;
  aText: string;
  bId: string;
  bText: string;
  summary: string;
}

export interface CorpusSweepDeps {
  /** The pool keys present in the store (unfiltered — the sweep allowlists). */
  listPools: () => Promise<string[]>;
  /** Every row of one pool. */
  listRows: (pool: string) => Promise<CorpusRow[]>;
  /** Close one row's validity window; false ⇒ nothing matched. */
  softForget: (id: string) => Promise<boolean>;
  /** Contradiction judge for one pool — `sweepPoolConflicts` in production. */
  sweepConflicts: (pool: string) => Promise<CorpusConflictPair[]>;
  /** File a contradiction for review. Never deletes. */
  fileConflict?: (pool: string, pair: CorpusConflictPair) => Promise<void>;
  /**
   * Is the LLM judge actually wired? Defaults to "assume yes".
   *
   * An UNKEYED judge does not fail — it classifies everything clean, so the
   * sweep would report `conflictPairs: 0` for a pool full of contradictions
   * and read exactly like a clean bill of health. That trap is already known
   * one layer down (EI-18746586784230719) but is only a console warning
   * there, which no structured caller ever sees. We refuse to run the layer
   * at all rather than emit a zero we cannot stand behind.
   */
  judgeAvailable?: () => boolean;
  /**
   * P(concrete) for one stored memory — the save-time substance question
   * (`judgeSubstanceWithJev`) in production. `null` = no usable answer.
   */
  judgeSubstance?: (text: string) => Promise<number | null>;
  /**
   * Is the substance judge wired (a Jev key resolves)? Same trap as
   * `judgeAvailable`: an unwired judge must not read as "nothing content-free".
   */
  substanceAvailable?: () => boolean;
}

export interface CorpusSweepOpts {
  /**
   * `report` (default) changes nothing. `apply` closes the validity window of
   * exact-duplicate redundant rows ONLY — contradictions are filed in both
   * modes and auto-resolved in neither.
   */
  mode?: 'report' | 'apply';
  /** Restrict to these pool keys (each still allowlist-checked). */
  pools?: string[];
  /** Run the LLM contradiction layer. Default true. */
  judgeConflicts?: boolean;
  /** Max pools judged per run — the LLM cost bound. Default 4. */
  maxPoolsJudged?: number;
  /**
   * Run the content-free layer (P-011): one substance question per live, non-
   * redundant row. Default false — it is one Jev call per memory. REPORT-ONLY in
   * both modes: `apply` never touches a content-free row.
   */
  contentFree?: boolean;
  /** Concurrent substance calls. Default 4. */
  contentFreeConcurrency?: number;
  /**
   * Ids a reviewer CONFIRMED from an earlier content-free report. Honored only
   * with `mode:'apply'` + `contentFree:true`, and only for a row this run flags
   * again and that is not federated; that row is soft-forgotten (recoverable via
   * include_superseded). Any other listed id is returned in `contentFreeUnconfirmed`.
   */
  forgetContentFreeIds?: string[];
  /**
   * In `apply` mode, also close exact-duplicate redundant rows. Default true.
   * Pass false to apply ONLY the reviewer-confirmed content-free forgets, so a
   * content-free review never widens into an unreviewed duplicate cleanup.
   */
  closeDuplicates?: boolean;
}

/** A row the substance judge found content-free. Reported, never auto-resolved. */
export interface ContentFreeRow {
  pool: string;
  id: string;
  text: string;
  pConcrete: number;
  /** Set when `memory:forget` must not touch this row locally (federation rules). */
  blocked: BlockedReason | null;
}

export interface CorpusPoolReport {
  pool: string;
  kind: RealPoolKind;
  rows: number;
  duplicateGroups: number;
  /** Redundant rows eligible for resolution. */
  redundant: number;
  /** Redundant rows spared, by rule. */
  blocked: number;
  resolved: number;
  resolveErrors: number;
  judged: boolean;
  conflictPairs: number;
  /** Rows the substance judge was asked about (0 when the layer did not run). */
  contentFreeJudged: number;
  contentFree: number;
  /** Asked but no usable answer — NOT concrete, just unmeasured. */
  contentFreeUnanswered: number;
  /** Reviewer-confirmed content-free rows soft-forgotten this run. */
  contentFreeResolved: number;
}

export interface CorpusSweepResult {
  mode: 'report' | 'apply';
  /**
   * True when the contradiction layer was SKIPPED because no judge is wired.
   * When true, every `conflictPairs: 0` means "not measured", NOT "clean" —
   * do not read it as a result.
   */
  judgeUnavailable: boolean;
  /**
   * True when the content-free layer was requested but no substance judge is
   * wired. Every `contentFree: 0` then means "not measured", NOT "none".
   */
  contentFreeUnavailable: boolean;
  pools: CorpusPoolReport[];
  skippedPools: Array<{ pool: string; reason: 'not-a-real-pool' }>;
  duplicates: DuplicateGroup[];
  conflicts: Array<{ pool: string; pair: CorpusConflictPair }>;
  /** Most content-free first (ascending P(concrete)). */
  contentFree: ContentFreeRow[];
  /**
   * `forgetContentFreeIds` entries NOT forgotten: not flagged again this run,
   * federated, outside the swept pools, not in apply mode, or the forget failed.
   */
  contentFreeUnconfirmed: string[];
  totals: {
    rows: number;
    duplicateGroups: number;
    redundant: number;
    blocked: number;
    resolved: number;
    conflictPairs: number;
    contentFreeJudged: number;
    contentFree: number;
    contentFreeUnanswered: number;
    contentFreeResolved: number;
  };
}

async function mapConcurrent<T, R>(items: readonly T[], width: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, width), items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

/**
 * Sweep our own pools. Every pass is independently fault-tolerant: a pool that
 * fails to list, a judge that errors, a resolve that races another writer —
 * none of them abort the run. Hygiene is never load-bearing (the posture
 * `conflict-check` and `hygiene` both already take).
 */
export async function sweepCorpus(
  opts: CorpusSweepOpts,
  deps: CorpusSweepDeps,
): Promise<CorpusSweepResult> {
  const mode = opts.mode ?? 'report';
  const wantJudge = opts.judgeConflicts ?? true;
  // An unkeyed judge reports "clean" for everything. Skipping the layer and
  // saying so beats emitting a zero that cannot be told apart from a result.
  const judgeUnavailable = wantJudge && (deps.judgeAvailable?.() ?? true) === false;
  const judgeConflicts = wantJudge && !judgeUnavailable;
  const maxPoolsJudged = Math.max(0, opts.maxPoolsJudged ?? 4);
  // Same rule for the content-free layer: unwired ⇒ skip it and say so.
  const wantContentFree = opts.contentFree === true;
  const contentFreeUnavailable =
    wantContentFree && (!deps.judgeSubstance || (deps.substanceAvailable?.() ?? true) === false);
  const judgeContentFree = wantContentFree && !contentFreeUnavailable;
  const contentFreeConcurrency = opts.contentFreeConcurrency ?? 4;
  const confirmed = new Set(opts.forgetContentFreeIds ?? []);
  const forgotten = new Set<string>();

  const skippedPools: CorpusSweepResult['skippedPools'] = [];
  const candidates: Array<{ pool: string; kind: RealPoolKind }> = [];
  // An explicit pool list is authoritative — do not pay a store round-trip to
  // discover pools we are about to discard.
  let requested = opts.pools;
  if (!requested) {
    try {
      requested = await deps.listPools();
    } catch {
      requested = [];
    }
  }
  const seenPools = new Set<string>();
  for (const pool of requested) {
    if (seenPools.has(pool)) continue;
    seenPools.add(pool);
    const kind = classifyPool(pool);
    if (!kind) {
      skippedPools.push({ pool, reason: 'not-a-real-pool' });
      continue;
    }
    candidates.push({ pool, kind });
  }

  const pools: CorpusPoolReport[] = [];
  const duplicates: DuplicateGroup[] = [];
  const conflicts: CorpusSweepResult['conflicts'] = [];
  const contentFree: ContentFreeRow[] = [];
  let judgedCount = 0;

  for (const { pool, kind } of candidates) {
    const report: CorpusPoolReport = {
      pool,
      kind,
      rows: 0,
      duplicateGroups: 0,
      redundant: 0,
      blocked: 0,
      resolved: 0,
      resolveErrors: 0,
      judged: false,
      conflictPairs: 0,
      contentFreeJudged: 0,
      contentFree: 0,
      contentFreeUnanswered: 0,
      contentFreeResolved: 0,
    };

    let rows: CorpusRow[] = [];
    try {
      rows = await deps.listRows(pool);
    } catch {
      pools.push(report);
      continue;
    }
    report.rows = rows.length;

    const groups = groupExactDuplicates(rows);
    report.duplicateGroups = groups.length;
    for (const group of groups) {
      report.redundant += group.redundantIds.length;
      report.blocked += group.blocked.length;
      duplicates.push(group);
      if (mode !== 'apply' || opts.closeDuplicates === false) continue;
      for (const id of group.redundantIds) {
        try {
          if (await deps.softForget(id)) report.resolved += 1;
          else report.resolveErrors += 1;
        } catch {
          report.resolveErrors += 1;
        }
      }
    }

    if (judgeConflicts && judgedCount < maxPoolsJudged) {
      judgedCount += 1;
      report.judged = true;
      let pairs: CorpusConflictPair[] = [];
      try {
        pairs = await deps.sweepConflicts(pool);
      } catch {
        pairs = [];
      }
      report.conflictPairs = pairs.length;
      for (const pair of pairs) {
        conflicts.push({ pool, pair });
        if (deps.fileConflict) await deps.fileConflict(pool, pair).catch(() => {});
      }
    }

    if (judgeContentFree && deps.judgeSubstance) {
      // Live rows only, and one copy of each duplicate group: a redundant row is
      // already reported above, and judging it again would double-count.
      const redundant = new Set(groups.flatMap((g) => g.redundantIds));
      const judge = deps.judgeSubstance;
      const asked = rows.filter((r) => r.invalidAt === null && r.text.trim() !== '' && !redundant.has(r.id));
      const answers = await mapConcurrent(asked, contentFreeConcurrency, async (row) => {
        try {
          return await judge(row.text);
        } catch {
          return null;
        }
      });
      report.contentFreeJudged = asked.length;
      const toForget: string[] = [];
      asked.forEach((row, i) => {
        const p = answers[i];
        if (p === null || !Number.isFinite(p)) {
          report.contentFreeUnanswered += 1;
          return;
        }
        if (!isContentFree(p)) return;
        report.contentFree += 1;
        const reason = blockedReason(row);
        const blocked = reason === 'already-closed' ? null : reason;
        contentFree.push({ pool, id: row.id, text: row.text, pConcrete: p, blocked });
        // Forget only what a reviewer confirmed AND this run flags again.
        if (mode === 'apply' && blocked === null && confirmed.has(row.id)) toForget.push(row.id);
      });
      for (const id of toForget) {
        try {
          if (await deps.softForget(id)) {
            report.contentFreeResolved += 1;
            forgotten.add(id);
          } else report.resolveErrors += 1;
        } catch {
          report.resolveErrors += 1;
        }
      }
    }

    pools.push(report);
  }
  contentFree.sort((a, b) => a.pConcrete - b.pConcrete);

  return {
    mode,
    judgeUnavailable,
    contentFreeUnavailable,
    pools,
    skippedPools,
    duplicates,
    conflicts,
    contentFree,
    contentFreeUnconfirmed: [...confirmed].filter((id) => !forgotten.has(id)),
    totals: {
      rows: pools.reduce((n, p) => n + p.rows, 0),
      duplicateGroups: pools.reduce((n, p) => n + p.duplicateGroups, 0),
      redundant: pools.reduce((n, p) => n + p.redundant, 0),
      blocked: pools.reduce((n, p) => n + p.blocked, 0),
      resolved: pools.reduce((n, p) => n + p.resolved, 0),
      conflictPairs: pools.reduce((n, p) => n + p.conflictPairs, 0),
      contentFreeJudged: pools.reduce((n, p) => n + p.contentFreeJudged, 0),
      contentFree: pools.reduce((n, p) => n + p.contentFree, 0),
      contentFreeUnanswered: pools.reduce((n, p) => n + p.contentFreeUnanswered, 0),
      contentFreeResolved: pools.reduce((n, p) => n + p.contentFreeResolved, 0),
    },
  };
}
