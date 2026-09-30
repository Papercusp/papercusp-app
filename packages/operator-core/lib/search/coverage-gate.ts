/**
 * P-009 (semantic-search-fingerprint-coverage-2026-08-03) — RUNTIME HONESTY.
 *
 * `embed-coverage.ts` already measures per-surface embedding coverage, but its
 * only consumer is the twice-hourly alarm workflow. Nothing read it at QUERY
 * time, so the semantic leg could not tell a healthy index from a near-empty
 * one and returned confident nearest-neighbours either way.
 *
 * That is not hypothetical: this plan exists because migration 727's 04:41Z
 * WIPE emptied the vector index and search kept answering as if nothing had
 * happened (D-011). An alarm firing into a log twice an hour is not the same
 * as the query path knowing it is degraded.
 *
 * This module is the READ side of the SAME surface — it does not measure
 * anything and does not own a second notion of coverage. It reads the samples
 * the alarm already persists (`harness_shared.embed_coverage_samples`) and
 * turns them into a per-source verdict the search tools can report.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE LOAD-BEARING RULE: absence of evidence is NOT health.
 *
 * A missing sample, a stale sample, or an unmapped source all resolve to
 * `unknown` — never to `healthy`. Defaulting the unknown case to healthy is
 * precisely the silent-confidence bug this item exists to remove: it would
 * report a green verdict for an index nobody has looked at, which is exactly
 * what happened during the wipe.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Deliberately NOT done here (D-010 is binding): this does not re-tune scores,
 * apply an absolute-cosine threshold, or drop results. It is a provenance /
 * honesty signal. Dropping the degraded leg outright was considered and
 * rejected — a 72%-covered corpus is still substantially useful, and silently
 * removing it would trade one dishonesty for another.
 */

import {
  TOTAL_COVERAGE_FLOOR,
  RECENT_COVERAGE_FLOOR,
  MIN_RECENT_SAMPLE,
} from './embed-coverage';
import { withChunkSearchColumns } from './chunks/registry';

/**
 * Minimal structural handle — mirrors the `sql.unsafe` call shape used by
 * embed-coverage.ts, so tests can pass a plain fake without a live PG.
 *
 * Returns `PromiseLike<unknown>` rather than `Promise<Row[]>` on purpose:
 * postgres.js's `unsafe` returns a `PendingQuery` (thenable, not a Promise),
 * and the row shape is genuinely unknown until we assert it. Widening here is
 * what lets a real `Sql` satisfy this interface WITHOUT an `as never` cast at
 * the call site — a cast there would silence type errors at exactly the seam
 * this module depends on being right.
 */
export interface CoverageSqlHandle {
  unsafe(query: string, params?: unknown[]): PromiseLike<unknown>;
}

/**
 * Which coverage surfaces back each `SearchSource`.
 *
 * An EMPTY array means the source has no embedding leg at all (BM25-only) —
 * a materially different statement from "we do not know its coverage", and
 * the two must not collapse into one verdict.
 *
 * ⚠ Keep in sync with `SEARCH_SOURCES` in ../agent-tools/search/sources.ts.
 * `coverage-gate.test.ts` asserts exhaustiveness in BOTH directions, so a new
 * source that forgets an entry fails the suite rather than silently reporting
 * `unknown` forever. That loud-on-omission property is the same lesson as
 * PROSE_VECTOR_COLUMNS (P-034): an unenumerated vector column is skipped in
 * silence, and silence is the failure mode we are paying to remove.
 */
export const SEARCH_SOURCE_SURFACES: Readonly<Record<string, readonly string[]>> = withChunkSearchColumns({
  escalations: ['harness_shared.harness_escalations.body_embedding'],
  brainstorm: ['harness_shared.harness_brainstorm.content_embedding'],
  turns: ['harness_shared.operator_turns.text_embedding'],
  decisions: ['harness_shared.harness_decisions.body_embedding'],
  // P-005 / D-078: this entry used to be `[]` with the note "`work_items.embedding`
  // DOES exist and is maintained at 100% — but it is consumed by the work-item
  // semantic dupe guard, not by this search source". That stopped being true when
  // the source gained its embedding leg (migration 776 exposes the column on the
  // `engineer_issues` view the source reads; the storage is the base table's).
  work_item: ['harness_shared.work_items.embedding'],
  // BM25-only. 120k+ coord envelope rows are not worth embedding — see the
  // coord_message source's own note in sources.ts.
  coord_message: [],
  // P-034 union: a turn is findable via its parent vector OR any chunk vector.
  // The chunk columns of every source are DERIVED from search/chunks/registry.ts
  // (generic-rag-chunking P-005): a dedicated store names its source
  // (session_turn_chunks -> session_turn), a shared-store entry names its own.
  session_turn: ['harness_shared.session_turns.text_embedding'],
});

/**
 * How old a sample may be before it stops counting as evidence.
 *
 * The alarm runs at :21 and :51 (crontab '0 21,51 * * * *'), i.e. every 30min.
 * 90min tolerates two missed ticks without crying wolf, while still resolving
 * to `unknown` when the alarm is genuinely dead — which is the case where a
 * confident `healthy` would be most harmful.
 */
export const COVERAGE_SAMPLE_MAX_AGE_MS = 90 * 60 * 1000;

/** In-process memo TTL. Samples only change every 30min; this just collapses
 *  a burst of queries into one read. */
export const COVERAGE_SNAPSHOT_TTL_MS = 60 * 1000;

export type CoverageVerdict =
  /** Every known leg is at or above the floor. */
  | 'healthy'
  /** The best known leg is below the floor — hits may be missing. */
  | 'degraded'
  /** No fresh sample. NOT a synonym for healthy. */
  | 'unknown'
  /** This source has no embedding leg; the semantic verdict does not apply. */
  | 'not-semantic';

export interface SurfaceReading {
  surface: string;
  observedAt: Date;
  eligibleRows: number;
  embeddedRows: number;
  /** embedded / eligible, 0..1. `null` when eligible is 0 (nothing to embed). */
  pct: number | null;
  /** Recent-window coverage, when the sample carries one. */
  recentPct: number | null;
  stale: boolean;
  ageMs: number;
}

export interface SourceCoverageAssessment {
  source: string;
  verdict: CoverageVerdict;
  /** Best known leg, 0..1 — the number the verdict is derived from. */
  coverage: number | null;
  /** Recent-window coverage of the best known leg, when available. */
  recentCoverage: number | null;
  /** Per-surface detail, including legs that were missing or stale. */
  surfaces: SurfaceReading[];
  /** Surfaces with no fresh sample. Non-empty ⇒ `coverage` is a partial view. */
  unknownSurfaces: string[];
  /** One line an agent or a human can act on. */
  note: string;
}

export type CoverageSnapshot = Map<string, SurfaceReading>;

interface SampleRow {
  surface: string;
  observed_at: Date | string;
  eligible_rows: string | number;
  embedded_rows: string | number;
  recent_eligible: string | number | null;
  recent_embedded: string | number | null;
}

/**
 * Latest persisted sample per surface. One indexed read — this rides
 * `embed_coverage_samples_ws_surface_ts_idx (workspace_id, surface,
 * observed_at DESC)`, so it is a DISTINCT ON over the index, not a scan.
 *
 * It deliberately does NOT call `measureCoverage()`: that runs live COUNT(*)
 * scans over every prose table and has no business on a query path.
 */
export async function loadCoverageSnapshot(
  sql: CoverageSqlHandle,
  workspaceId: string,
  now: Date = new Date(),
): Promise<CoverageSnapshot> {
  const rows = (await sql.unsafe(
    `SELECT DISTINCT ON (surface)
            surface, observed_at, eligible_rows, embedded_rows,
            recent_eligible, recent_embedded
       FROM harness_shared.embed_coverage_samples
      WHERE workspace_id = $1
      ORDER BY surface, observed_at DESC`,
    [workspaceId],
  )) as SampleRow[] | null;

  const snapshot: CoverageSnapshot = new Map();
  for (const r of rows ?? []) {
    const observedAt = r.observed_at instanceof Date ? r.observed_at : new Date(r.observed_at);
    const eligibleRows = Number(r.eligible_rows);
    const embeddedRows = Number(r.embedded_rows);
    const recentEligible = r.recent_eligible === null ? null : Number(r.recent_eligible);
    const recentEmbedded = r.recent_embedded === null ? null : Number(r.recent_embedded);
    const ageMs = now.getTime() - observedAt.getTime();
    snapshot.set(r.surface, {
      surface: r.surface,
      observedAt,
      eligibleRows,
      embeddedRows,
      pct: eligibleRows > 0 ? embeddedRows / eligibleRows : null,
      recentPct:
        recentEligible !== null && recentEmbedded !== null && recentEligible >= MIN_RECENT_SAMPLE
          ? recentEmbedded / recentEligible
          : null,
      stale: ageMs > COVERAGE_SAMPLE_MAX_AGE_MS,
      ageMs,
    });
  }
  return snapshot;
}

let memo: { at: number; workspaceId: string; snapshot: CoverageSnapshot } | null = null;
let lastWarnAt = 0;

/** A persistent read failure must not spam a hot search path — one line per
 *  window is enough to be discoverable without drowning the log. */
export const COVERAGE_WARN_THROTTLE_MS = 5 * 60 * 1000;

/** True when the handle can actually be queried. A caller that wired no real
 *  PG handle (a stub in a unit test) is NOT a failure to shout about — it
 *  still resolves to `unknown`, which is the honest verdict either way. */
function isQueryable(sql: unknown): sql is CoverageSqlHandle {
  return typeof (sql as CoverageSqlHandle | null)?.unsafe === 'function';
}

/**
 * Errors that are EXPECTED for this fail-open read and so must never warn
 * (vitest-fail-on-console would then red any rig test that merely touches the
 * claim/injection path — this gate sits on it via `assessCorpusGate`):
 * `harness_shared.embed_coverage_samples` absent, i.e. a partial test schema or
 * a deploy that has not yet run migration 746 (→ "… does not exist"), or the
 * query outliving the pool it ran on (a rig tearing down mid-read → postgres.js
 * CONNECTION_ENDED/CONNECTION_DESTROYED).
 *
 * Suppressing the LOG loses nothing: each of these already resolves to the
 * honest `unknown` verdict, which the pointer section surfaces as degraded, so
 * the line would only restate what the verdict already carries. Anything else
 * is a real surprise and still warns. Mirrors `session-compacted-events.ts`'s
 * `failSoft`, which classifies the same two shapes for the same reason.
 */
function isExpectedReadFailure(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  if (/does not exist/.test(msg)) return true;
  const code = (err as { code?: unknown } | null)?.code;
  return (
    code === 'CONNECTION_ENDED' ||
    code === 'CONNECTION_DESTROYED' ||
    /CONNECTION_ENDED|CONNECTION_DESTROYED|Connection ended/i.test(msg)
  );
}

/** TTL-memoised {@link loadCoverageSnapshot}. Fail-open: any failure yields an
 *  EMPTY snapshot, which assesses as `unknown` — never as healthy, and never
 *  an exception on the search path. */
export async function loadCoverageSnapshotCached(
  sql: CoverageSqlHandle,
  workspaceId: string,
  now: Date = new Date(),
): Promise<CoverageSnapshot> {
  if (memo && memo.workspaceId === workspaceId && now.getTime() - memo.at < COVERAGE_SNAPSHOT_TTL_MS) {
    return memo.snapshot;
  }
  if (!isQueryable(sql)) return new Map();
  try {
    const snapshot = await loadCoverageSnapshot(sql, workspaceId, now);
    memo = { at: now.getTime(), workspaceId, snapshot };
    return snapshot;
  } catch (err) {
    // Memoise the EMPTY result too. Without this a persistent failure retries
    // (and logs) on EVERY query, turning a degraded signal into a log flood on
    // the hottest path in the tool.
    memo = { at: now.getTime(), workspaceId, snapshot: new Map() };
    if (!isExpectedReadFailure(err) && now.getTime() - lastWarnAt >= COVERAGE_WARN_THROTTLE_MS) {
      lastWarnAt = now.getTime();
      console.warn(
        `[coverage-gate] snapshot read failed (degrading to unknown, non-fatal): ${
          (err as Error)?.message ?? String(err)
        }`,
      );
    }
    return new Map();
  }
}

/** Test seam — drop the memo and the warn throttle. */
export function resetCoverageSnapshotCache(): void {
  memo = null;
  lastWarnAt = 0;
}

const pctStr = (v: number | null): string => (v === null ? 'n/a' : `${(v * 100).toFixed(1)}%`);

/**
 * Assess ONE source against a snapshot. Pure — no I/O, no clock beyond `now`.
 *
 * Multi-leg sources (P-034's parent+chunk union) take the BEST known leg: a
 * row is findable if EITHER leg carries its vector, so the union is at least
 * the max. That makes `coverage` a conservative LOWER bound on true
 * findability — it can flag `degraded` slightly early, never late. Erring
 * toward flagging is the correct direction for an honesty signal.
 */
export function assessSourceCoverage(
  source: string,
  snapshot: CoverageSnapshot,
): SourceCoverageAssessment {
  const surfaces = SEARCH_SOURCE_SURFACES[source];

  if (surfaces === undefined) {
    return {
      source,
      verdict: 'unknown',
      coverage: null,
      recentCoverage: null,
      surfaces: [],
      unknownSurfaces: [],
      note:
        `source '${source}' has no coverage mapping in SEARCH_SOURCE_SURFACES — ` +
        `treating as unknown. Add it (coverage-gate.ts) so this reports a real verdict.`,
    };
  }

  return assessSurfaceCoverage(source, surfaces, snapshot);
}

/**
 * The surface-level half of {@link assessSourceCoverage}, for consumers that run a
 * cosine query but are NOT a `SearchSource` — the work-item dupe guard, work-item
 * similarity, and plan semantic-dedup (WI-9393 / D-018).
 *
 * ⚠ MEMORY RECALL IS NOT ONE OF THEM, AND THIS LINE USED TO SAY IT WAS. Injection's
 * corpus leg reads REGISTERED sources (`CORPUS_SOURCE_NAMES` = session_turn +
 * work_item), so it is already assessed through the SOURCE-level door:
 * `assessSearchCoverage(CORPUS_GATE_SOURCES, …)` in `memory/injection.ts`, feeding
 * `memory/corpus-coverage-gate.ts` — which can DEGRADE or SUPPRESS the injected
 * block, not merely annotate it. Wiring it here as well would fork one honesty
 * signal into two, which is precisely the duplication the next paragraph forbids.
 * The tell that it belongs there and not here: its surfaces are reachable from
 * `SEARCH_SOURCE_SURFACES` by source name, so it never needs to pass its own.
 *
 * Those consumers must NOT be added to `SEARCH_SOURCE_SURFACES`: that map is asserted
 * exhaustive in both directions against `SEARCH_SOURCES` (coverage-gate.test.ts), so a
 * non-search key there would fail the suite — and a second parallel map would be the
 * fork this repo's reuse-first rule exists to prevent. They pass their own surfaces here
 * instead, and inherit the identical verdict logic, including the binding D-018
 * constraint that absence of evidence renders `unknown` and never `healthy`.
 *
 * `source` is the LABEL this consumer is reported under; it appears in the notes and in
 * the returned assessment's `source` field.
 */
export function assessSurfaceCoverage(
  source: string,
  surfaces: readonly string[],
  snapshot: CoverageSnapshot,
): SourceCoverageAssessment {
  if (surfaces.length === 0) {
    return {
      source,
      verdict: 'not-semantic',
      coverage: null,
      recentCoverage: null,
      surfaces: [],
      unknownSurfaces: [],
      note: `source '${source}' has no embedding leg (BM25-only); embedding coverage does not apply.`,
    };
  }

  const readings: SurfaceReading[] = [];
  const unknownSurfaces: string[] = [];
  for (const s of surfaces) {
    const r = snapshot.get(s);
    if (!r || r.stale) {
      unknownSurfaces.push(s);
      if (r) readings.push(r);
    } else {
      readings.push(r);
    }
  }

  const known = readings.filter((r) => !r.stale && r.pct !== null);
  if (known.length === 0) {
    return {
      source,
      verdict: 'unknown',
      coverage: null,
      recentCoverage: null,
      surfaces: readings,
      unknownSurfaces,
      note:
        `no fresh embedding-coverage sample for '${source}' ` +
        `(${unknownSurfaces.join(', ') || 'no surfaces sampled'}) — ` +
        `coverage is UNKNOWN, which is not the same as healthy. ` +
        `Results may be drawn from an under-populated index.`,
    };
  }

  const best = known.reduce((a, b) => ((b.pct ?? 0) > (a.pct ?? 0) ? b : a));
  const coverage = best.pct;
  const degraded = coverage !== null && coverage < TOTAL_COVERAGE_FLOOR;
  const partial = unknownSurfaces.length > 0;

  const parts: string[] = [];
  if (degraded) {
    parts.push(
      `'${source}' embedding coverage is ${pctStr(coverage)} ` +
        `(${best.embeddedRows.toLocaleString()}/${best.eligibleRows.toLocaleString()} rows), ` +
        `below the ${pctStr(TOTAL_COVERAGE_FLOOR)} floor — semantic hits for this source are ` +
        `drawn from a PARTIAL index and a better match may simply not be embedded yet.`,
    );
    if (best.recentPct !== null && best.recentPct >= RECENT_COVERAGE_FLOOR) {
      parts.push(
        `Recent rows are ${pctStr(best.recentPct)} covered, so this is historical backlog ` +
          `rather than a live ingestion failure.`,
      );
    }
  } else {
    parts.push(`'${source}' embedding coverage is ${pctStr(coverage)} (at or above floor).`);
  }
  if (partial) {
    parts.push(`Partial view — no fresh sample for: ${unknownSurfaces.join(', ')}.`);
  }

  return {
    source,
    verdict: degraded ? 'degraded' : 'healthy',
    coverage,
    recentCoverage: best.recentPct,
    surfaces: readings,
    unknownSurfaces,
    note: parts.join(' '),
  };
}

export interface SearchCoverageReport {
  /** True when ANY scoped source is degraded or unknown. */
  degraded: boolean;
  /** Sources whose semantic results are drawn from a partial index. */
  degradedSources: string[];
  /** Sources with no fresh evidence either way. */
  unknownSources: string[];
  perSource: SourceCoverageAssessment[];
  /** One-line summary, or null when everything semantic is healthy. */
  warning: string | null;
}

/** Assess every scoped source and roll it up for a tool response. */
export function assessSearchCoverage(
  scope: readonly string[],
  snapshot: CoverageSnapshot,
): SearchCoverageReport {
  const perSource = scope.map((s) => assessSourceCoverage(s, snapshot));
  const degradedSources = perSource.filter((a) => a.verdict === 'degraded').map((a) => a.source);
  const unknownSources = perSource.filter((a) => a.verdict === 'unknown').map((a) => a.source);

  const bits: string[] = [];
  if (degradedSources.length > 0) {
    bits.push(
      `semantic results are DEGRADED for: ${degradedSources.join(', ')} — ` +
        `these surfaces are only partially embedded, so a better match may exist but be unindexed`,
    );
  }
  if (unknownSources.length > 0) {
    bits.push(
      `embedding coverage is UNKNOWN (no fresh sample) for: ${unknownSources.join(', ')} — ` +
        `treat these results as unverified rather than healthy`,
    );
  }

  return {
    degraded: degradedSources.length > 0 || unknownSources.length > 0,
    degradedSources,
    unknownSources,
    perSource,
    warning: bits.length > 0 ? bits.join('; ') : null,
  };
}
