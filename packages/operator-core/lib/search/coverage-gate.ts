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
  createCoverageGate,
  type CoverageGate,
  type CoverageSample,
  type CoverageSnapshot,
  type SearchCoverageReport,
  type SourceCoverageAssessment,
} from '@papercusp/search';
import { withChunkSearchColumns } from './chunks/registry';

/** Shared query/alarm floors. Keep them on the read side so a cold query
 * does not initialize the background monitor and its backfill dependencies.
 * Total coverage tolerates a converging backlog; recent coverage detects
 * write-path regressions, with a sample floor that avoids rounding noise. */
export const TOTAL_COVERAGE_FLOOR = 0.95;
export const RECENT_COVERAGE_FLOOR = 0.99;
export const MIN_RECENT_SAMPLE = 20;

// shared-vector-search-libraries-2026-09-29 P-002: the verdict logic lives in
// @papercusp/search (createCoverageGate). This module is papercusp's host half:
// the source → vector-column map, the thresholds, the persisted-sample reader
// and its memo. The types are re-exported so existing importers are unchanged.
export type {
  CoverageSnapshot,
  CoverageVerdict,
  SearchCoverageReport,
  SourceCoverageAssessment,
  SurfaceReading,
} from '@papercusp/search';

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

let configuredGate: CoverageGate | null = null;

/**
 * Papercusp's configured gate: the library's verdict logic with this host's
 * source map, floors and unmapped-source note.
 *
 * Built on first use. The query reader owns the shared floors; the background
 * monitor re-exports them without becoming a dependency of cold queries.
 */
function gate(): CoverageGate {
  configuredGate ??= createCoverageGate({
    sources: SEARCH_SOURCE_SURFACES,
    thresholds: {
      coverageFloor: TOTAL_COVERAGE_FLOOR,
      recentFloor: RECENT_COVERAGE_FLOOR,
      minRecentSample: MIN_RECENT_SAMPLE,
      maxSampleAgeMs: COVERAGE_SAMPLE_MAX_AGE_MS,
    },
    describeUnmappedSource: (source) =>
      `source '${source}' has no coverage mapping in SEARCH_SOURCE_SURFACES — ` +
      `treating as unknown. Add it (coverage-gate.ts) so this reports a real verdict.`,
  });
  return configuredGate;
}

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

  const samples: CoverageSample[] = (rows ?? []).map((r) => ({
    surface: r.surface,
    observedAt: r.observed_at,
    eligibleRows: r.eligible_rows,
    embeddedRows: r.embedded_rows,
    recentEligible: r.recent_eligible,
    recentEmbedded: r.recent_embedded,
  }));
  return gate().snapshot(samples, now);
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
  return gate().assessSource(source, snapshot);
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
  return gate().assessSurfaces(source, surfaces, snapshot);
}

/** Assess every scoped source and roll it up for a tool response. */
export function assessSearchCoverage(
  scope: readonly string[],
  snapshot: CoverageSnapshot,
): SearchCoverageReport {
  return gate().assessScope(scope, snapshot);
}
