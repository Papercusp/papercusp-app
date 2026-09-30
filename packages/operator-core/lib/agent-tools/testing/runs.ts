/**
 * testing:runs — read the TEST-RUN LEDGER (`harness_shared.test_runs`),
 * plan sql-escape-tool-routing-2026-08-12 P-004.
 *
 * Closes a live CONTRADICTION: the su playbook orders agents to green a red
 * gate by finding "the ACTUAL failing tests (query the test-run ledger, don't
 * guess)" — and ships no verb to read that ledger. 40 agents / 288 hand-written
 * `dev:pg_query` calls fill the gap, and the corpus shows they get it wrong in
 * two specific, expensive ways this tool makes unrepresentable.
 *
 * TRAP 1 — TENANT SCOPE (EI-19324633485547042). `workspace_id`/`harness_slug`
 * are stamped ONLY by the per-hive Tests-tab ingestion route. The CI/dogfood
 * vitest reporter writes the SAME table deriving both from env vars that CI
 * never sets, so its rows are NULL on both — 338k rows in the last 7 days,
 * still arriving. A `workspace_id = '…'` predicate therefore excludes EVERY
 * CI/gate row and reads as a clean "no failures". So this tool applies NO
 * workspace predicate by default and scopes by source/commitSha/runGroup, per
 * the remedy already written at testing-run-store.ts:334-343.
 *
 * TRAP 2 — STATUS VOCABULARY. The values are 'pass'/'fail'/'skip', NOT
 * 'passed'/'failed', so a hand-written `status <> 'passed'` matches every row.
 * A typed enum makes that unrepresentable.
 *
 * SHAPE — the corpus is MAJORITY-AGGREGATE ("is this sha/run green": GROUP BY
 * commit_sha/run_group_id with count(*) FILTER (WHERE status='fail')), not
 * row-listing. A row-list-only verb would not cover this relation's real
 * shapes, so `rollup` is a first-class mode, not an afterthought (D-001 §1).
 * Rollups use the same latest-per-file view as the default row listing, so a
 * retry that supersedes a failed attempt cannot poison the aggregate verdict.
 *
 * NOT this tool: cross-run flip-rate ranking ("is this red mine or a known
 * flake") is `testing:flakiness` — same table, different question. Running
 * tests is `testing:run`.
 */

import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { parseTestRunExecutionDetails } from '@papercusp/test-config/execution-details';
import { CRITICAL_P95_MS } from '../../event-loop-lag-monitor';
import { toIso } from '../_pg-timestamp';

const DEFAULT_LIMIT = 30;
const OUTPUT_TAIL_CHARS = 800;
const NO_RUNS_RECORDED_REASON = 'no_runs_recorded' as const;

/**
 * An empty ledger result is not a clean test verdict. Keep this marker confined
 * to the empty path so callers that already consume populated responses retain
 * the established shape, while callers can distinguish "not measured" from
 * "measured and no red rows".
 */
function emptyResultMetadata(
  rowCount: number,
): { notRecorded: true; reason: typeof NO_RUNS_RECORDED_REASON } | Record<string, never> {
  return rowCount === 0 ? { notRecorded: true, reason: NO_RUNS_RECORDED_REASON } : {};
}

/** The statuses that constitute a RED row. `error` is red too — the corpus's
 *  own `status IN ('fail','error')` filters agree, and a fail-only filter
 *  under-reports a suite that errored before it could fail. */
const RED_STATUSES: string[] = ['fail', 'error'];

// NOT `d.toISOString()`: a timestamptz column arrives as a STRING here, so the old
// spelling threw on every row and left this tool dead on every call. See _pg-timestamp.
const iso = toIso;

/**
 * The ledger row contract advertised in guidance. Keep this explicit instead
 * of relying on `.passthrough()`: passthrough permits fields at runtime, but it
 * does not publish them in MCP `outputSchema`, so typed callers cannot discover
 * them and guidance can silently drift away from the registered contract.
 */
const testingRunResultSchema = z
  .object({
    id: z.number().int().positive(),
    workspaceId: z.string().nullable(),
    harnessSlug: z.string().nullable(),
    root: z.string().nullable(),
    filePath: z.string(),
    status: z.enum(['pass', 'fail', 'skip', 'cancelled', 'error', 'running']),
    framework: z.string(),
    startedAt: z.string(),
    finishedAt: z.string().nullable(),
    durationMs: z.number().nonnegative().nullable(),
    commitSha: z.string().nullable(),
    runGroupId: z.string().nullable(),
    source: z.enum(['ci', 'local', 'admin-ui', 'mutation-probe']),
    branch: z.string().nullable(),
    outputTail: z.string().nullable(),
    loopLagP95Ms: z.number().nullable(),
    rssMb: z.number().nullable(),
    saturationSuspect: z.boolean().nullable(),
    worktreeDirty: z.boolean(),
    isScratchConfig: z.boolean(),
    outputTailTruncated: z.boolean().optional(),
  })
  .passthrough();

const testingRunGroupResultSchema = z
  .object({
    key: z.string().nullable(),
    commitSha: z.string().nullable(),
    commitShaCount: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    failedFiles: z.number().int().nonnegative(),
    files: z.number().int().nonnegative(),
    firstStart: z.string().nullable(),
    lastFinish: z.string().nullable(),
  })
  .passthrough();

/**
 * A red row recorded while the host's event loop was past the critical band is
 * not trustworthy as a genuine failure — the column comment for
 * `loop_lag_p95_ms` says so directly (a timeout-class failure there is likely a
 * saturation artifact). Flagging it is NOT "blame high load": it does not
 * explain the failure away, it marks the row as unable to settle the question
 * and tells the caller to re-run before chasing it.
 *
 * NULL lag is explicitly UNKNOWN — the comment is emphatic that NULL means no
 * trustworthy host signal was recorded, which is not a claim the host was calm.
 */
export function isSaturationSuspect(loopLagP95Ms: number | null): boolean | null {
  if (loopLagP95Ms === null) return null;
  return loopLagP95Ms >= CRITICAL_P95_MS;
}

/** file_path is matched as a literal SUBSTRING — the corpus overwhelmingly
 *  reaches for `LIKE '%release-submodule-freshness%'`, a memorable fragment of
 *  a long path, not the exact worktree-relative path. Escape LIKE metacharacters
 *  first so ordinary path names such as `__tests__` cannot become an anchored
 *  wildcard pattern and produce a false absence. */
export function toPathPattern(filePath: string): string {
  const escaped = filePath.replace(/[\\%_]/g, (character) => `\\${character}`);
  return `%${escaped}%`;
}

/** commit_sha is matched as a PREFIX — agents quote a short sha
 *  (`362398846fd2`) while the column holds the full 40-char one. */
export function toShaPattern(sha: string): string {
  return /[%_]/.test(sha) ? sha : `${sha}%`;
}

/**
 * A rollup is documented as a CI/gate verdict — for a commit ("is this sha
 * green") or for one suite execution ("what did this run judge"). Local rows
 * share the same commit SHA and run group while representing an agent's
 * potentially dirty working tree, so they must not silently join that verdict.
 * Both rollups therefore default to CI; callers can still select a different
 * writer explicitly with `source`.
 *
 * runGroup was previously left unscoped, which let every local row that has no
 * run_group_id collapse into one meaningless `null`-keyed group — measured at
 * 11,822 rows spanning three months, dwarfing the real runs beside it.
 */
export function defaultRollupSource(
  rollup: 'commit' | 'runGroup' | undefined,
  source?: 'ci' | 'local' | 'admin-ui' | 'mutation-probe',
): 'ci' | 'local' | 'admin-ui' | 'mutation-probe' | null {
  return source ?? (rollup ? 'ci' : null);
}

/** Accept the output-shaped `runGroupId` spelling as an input compatibility
 * alias while keeping `runGroup` as the canonical selector name. When both
 * are supplied, the canonical spelling wins. */
export function normalizeRunGroupFilter(runGroup?: string, runGroupId?: string): string | null {
  return runGroup ?? runGroupId ?? null;
}

/** JSONB may arrive as its parsed object or as serialized JSON, depending on
 * the postgres client/facade serving the read. Normalize before applying the
 * strict versioned parser; malformed strings remain untrusted and map to no
 * root rather than throwing or inventing checkout identity. */
function parseStoredExecutionDetails(value: unknown) {
  if (typeof value !== 'string') return parseTestRunExecutionDetails(value);
  try {
    return parseTestRunExecutionDetails(JSON.parse(value));
  } catch {
    return undefined;
  }
}

/**
 * Keep testing:runs' row identity intact when a model-facing payload is
 * bounded. The generic payload projection can omit workspaceId/harnessSlug or
 * replace the numeric id while walking a large output tail, after which the
 * declared result schema rejects an otherwise valid CI response.
 *
 * This shaper preserves every row key, clips only verbose output tails, and
 * reports row cuts at the envelope (never as a fake row whose id would violate
 * the output schema).
 */
export const TESTING_RUNS_TIER_CAPS = {
  trimmed: { targetChars: 4_800, outputTailChars: 180 },
  standard: { targetChars: 5_200, outputTailChars: 800 },
} as const;

type TestingRunsTier = keyof typeof TESTING_RUNS_TIER_CAPS;

function clipOutputTail(value: unknown, maxChars: number): { value: unknown; clipped: boolean } {
  if (typeof value !== 'string' || value.length <= maxChars) return { value, clipped: false };
  const marker = `…[TRUNCATED +${value.length} chars — pass payloadTier:"full" for complete output]`;
  if (marker.length >= maxChars) return { value: marker.slice(0, maxChars), clipped: true };
  const keep = maxChars - marker.length;
  return { value: `${value.slice(0, keep)}${marker}`, clipped: true };
}

function projectTestingRun(row: unknown, outputTailChars: number): { row: Record<string, unknown>; clipped: boolean } {
  const r = (row ?? {}) as Record<string, unknown>;
  const outputTail = clipOutputTail(r.outputTail, outputTailChars);
  return {
    row: {
      ...r,
      id: r.id ?? null,
      workspaceId: r.workspaceId ?? null,
      harnessSlug: r.harnessSlug ?? null,
      outputTail: outputTail.value,
      ...(outputTail.clipped ? { outputTailTruncated: true } : {}),
    },
    clipped: outputTail.clipped,
  };
}

export function shapeTestingRuns(data: unknown, tier: TestingRunsTier): unknown {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  const d = data as Record<string, unknown>;
  const caps = TESTING_RUNS_TIER_CAPS[tier];

  if (Array.isArray(d.runs)) {
    const base = { ...d, runs: [] as Record<string, unknown>[] };
    const kept: Record<string, unknown>[] = [];
    let clippedRows = 0;
    for (const rawRow of d.runs) {
      const projected = projectTestingRun(rawRow, caps.outputTailChars);
      const candidate = { ...base, runs: [...kept, projected.row] };
      // Keep the first valid row even if an unusual envelope is larger than the
      // target; never return an empty row list that looks like no test ran.
      if (JSON.stringify(candidate).length > caps.targetChars && kept.length > 0) break;
      kept.push(projected.row);
      if (projected.clipped) clippedRows += 1;
    }
    const rowsDropped = d.runs.length - kept.length;
    if (rowsDropped === 0 && clippedRows === 0) return { ...d, runs: kept };
    return {
      ...base,
      runs: kept,
      payloadBounded: {
        tier,
        showingRuns: kept.length,
        totalRuns: d.runs.length,
        droppedRuns: rowsDropped,
        clippedOutputTails: clippedRows,
        outputTailChars: caps.outputTailChars,
      },
    };
  }

  if (Array.isArray(d.groups)) {
    const base = { ...d, groups: [] as Record<string, unknown>[] };
    const kept: Record<string, unknown>[] = [];
    for (const rawGroup of d.groups) {
      const group = { ...(rawGroup as Record<string, unknown>) };
      if (JSON.stringify({ ...base, groups: [...kept, group] }).length > caps.targetChars && kept.length > 0) break;
      kept.push(group);
    }
    const groupsDropped = d.groups.length - kept.length;
    if (groupsDropped === 0) return { ...d, groups: kept };
    return {
      ...base,
      groups: kept,
      payloadBounded: {
        tier,
        showingGroups: kept.length,
        totalGroups: d.groups.length,
        droppedGroups: groupsDropped,
      },
    };
  }

  return data;
}

export default defineTool({
  name: 'testing:runs',
  description:
    'Read the test-run ledger (harness_shared.test_runs): what actually failed, at which commit, in which run. `rollup:"commit"|"runGroup"` aggregates ("is this sha green" — total/failed/failing-file counts); rollups default to `source:"ci"` so local or mutation-probe rows cannot contaminate a gate verdict; ordinary row listings exclude mutation-probe evidence unless `source:"mutation-probe"` is explicit. Filter by `testRunIds` (exact durable numeric row IDs), filePath (substring), commitSha (prefix), runGroup (or compatibility alias runGroupId), status, source, since. Read-only.',
  capability: 'operator:read',
  guidance: {
    when: 'Greening a red gate or triaging CI: find the ACTUAL failing test files at a commit/run instead of guessing or re-running blind. rollup:"commit" answers "is this sha green" in one call.',
    notWhen:
      'To decide whether a red is a known FLAKE rather than your change, use testing:flakiness (cross-run flip rate — same table, different question). To RUN tests use testing:run. For "is my change live/what is blocking it" use dev:pipeline_position.',
    chaining:
      'rollup:"commit" to find the red sha (CI rows by default; pass source:"local" or source:"admin-ui" for another writer) → rows with that commitSha + status:["fail","error"] for the failing files and their output tails → testing:flakiness on a file before assuming the red is yours.',
    // Response docs live HERE, not in description/when — those are
    // prompt-weight budgeted (the guard refused the P-002 edit on routines:list).
    returns: [
      'Each row: { id, workspaceId, harnessSlug, root, filePath, status, framework, startedAt, finishedAt, durationMs, commitSha, runGroupId, source, branch, outputTail, loopLagP95Ms, rssMb, saturationSuspect, worktreeDirty, isScratchConfig }. id is the durable testRunId for evidence binding; workspaceId/harnessSlug report the stored scope and may be null. root is the parser-validated absolute checkout root captured in execution_details, or null for legacy/malformed rows. outputTail is populated only for fail/error rows and is truncated.',
      '`runGroup` is the canonical exact run_group_id input selector; `runGroupId` is accepted as a compatibility alias because output rows expose the same value as runGroupId. If both are supplied, runGroup wins.',
      '`testRunIds` is an exact primary-key selector for evidence-lineage lookups; when supplied without an explicit `latestPerFile`, it defaults to `latestPerFile:false` so every requested receipt remains visible, including multiple attempts for one file. Set `latestPerFile:true` only when intentionally collapsing the selected IDs.',
      '{ count, total, truncatedByLimit, latestPerFile, runs, groups } — `runs` is the row list and `groups` is present for rollups.',
      'Rollup rows: { key, commitSha, commitShaCount, total, failed, failedFiles, files, firstStart, lastFinish } grouped by commit_sha or run_group_id. commitSha names the CANDIDATE the group judged — for rollup:"runGroup" it is the only way to tell which sha a run was about; commitShaCount>1 means the group spans several, so commitSha is one arbitrary member and is NOT "the sha this judged". By default each group uses its latest result per file, matching the row-listing view; pass latestPerFile:false to include historical attempts. The response also reports the effective source filter; BOTH rollups default to source:"ci".',
      '`runs:[]` or `groups:[]` includes `{ notRecorded:true, reason:"no_runs_recorded" }`; an empty ledger result is not evidence that the requested test passed or did not run.',
      '`count` = rows returned; `total` = rows matching the filter independent of `limit`; `truncatedByLimit` says whether they differ, so a capped list is never read as a total.',
      'Row-list responses include `effectiveSourceFilter` and `omittedBySourceFilter`. The latter counts ledger rows matching all other selectors but removed by the effective source filter (before latestPerFile collapsing), so an empty filtered list is distinguishable from no recorded runs.',
      'latestPerFile (default true, or false when you name a filePath) collapses to the most recent run per file — without it a file that failed an hour ago and has passed since still lists as failing.',
      '`saturationSuspect` is true only when a trustworthy host event-loop p95 sample was past the critical band, so the row is NOT reliable evidence of a genuine red — re-run before chasing it. false means a valid calm sample; null means the signal is unknown (no trustworthy host sample), not that the host was calm.',
      'SCOPE: no workspace/harness predicate is applied by default, deliberately. CI/gate rows carry NULL workspace_id/harness_slug (the CI reporter derives them from env vars CI never sets), so scoping by workspace silently excludes every CI row and reads as a clean "no failures" (EI-19324633485547042). Pass `workspace` only for per-hive Tests-tab rows, knowing it excludes CI.',
      "Status values are 'pass'/'fail'/'skip'/'cancelled'/'error'/'running' — never 'passed'/'failed'.",
    ].join(' '),
    seeAlso: [
      'testing:flakiness (is this red a known flake — cross-run flip rate)',
      'testing:run (actually run test files)',
      'dev:pipeline_position (is my change live / what is blocking it)',
    ],
  },
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  args: z.object({
    testRunIds: z
      .array(z.number().int().positive())
      .min(1)
      .max(100)
      .optional()
      .describe(
        'Match exact durable test_runs row IDs (1–100). Use this for evidence-lineage lookups; no per-file collapse is applied by default.',
      ),
    filePath: z
      .string()
      .max(400)
      .optional()
      .describe(
        'Match test file path as a literal SUBSTRING (a memorable fragment is fine); LIKE metacharacters are treated literally.',
      ),
    commitSha: z.string().max(80).optional().describe('Match commit sha as a PREFIX — a short sha works.'),
    runGroup: z.string().max(200).optional().describe('Exact run_group_id (one suite execution).'),
    runGroupId: z
      .string()
      .max(200)
      .optional()
      .describe('Compatibility alias for the exact run_group_id selector; `runGroup` wins if both are supplied.'),
    status: z
      .array(z.enum(['pass', 'fail', 'skip', 'cancelled', 'error', 'running']))
      .min(1)
      .optional()
      .describe("Statuses to include. The RED set is ['fail','error'] — 'error' is a red too."),
    source: z
      .enum(['ci', 'local', 'admin-ui', 'mutation-probe'])
      .optional()
      .describe(
        'Which writer produced the row. Use "ci" for gate/CI triage or explicit "mutation-probe" for falsifiability evidence.',
      ),
    since: z.string().max(64).optional().describe('Only runs started at/after this ISO-8601 timestamp.'),
    sinceHours: z
      .number()
      // EI-21677405671312383: the floor was 0.1 (6 min), which refused a legitimately
      // tight poll ("did this file run in the last 2 minutes?") and pushed the caller
      // to `since` for no reason. Any positive window is meaningful. Zero is still
      // refused deliberately — see the `!= null` guard below: 0 is falsy, so admitting
      // it would silently drop the time predicate entirely and return the WHOLE ledger
      // as if it were the last instant.
      .gt(0)
      .max(2160)
      .optional()
      .describe(
        'Relative window: only runs started within the last N hours; fractional values are fine (0.05 = 3 min). Ignored when `since` is given.',
      ),
    workspace: z
      .string()
      .max(120)
      .optional()
      .describe(
        'Filter to one workspace_id. WARNING: excludes every CI/gate row (those are NULL by design) — omit for CI triage.',
      ),
    // EI-21669113109175663 / EI-21675813584516519: `harness` was rejected while its
    // twin `workspace` was accepted, though `test_runs.harness_slug` exists and
    // `test_runs_harness_scope_idx` is keyed (harness_slug, workspace_id, file_path,
    // finished_at) precisely for per-hive Tests-tab reads. The asymmetry was an
    // omission, not a policy: both columns carry identical NULL-on-CI semantics, so
    // the CI-exclusion warning is the same one `workspace` already carries. Safe to
    // declare because `harness` is NOT a framework-ambient arg here (the ambient set
    // is `projection`/`view` per ambient-args-wiring.ts, plus tooldef's payloadTier),
    // so it is never auto-injected — a caller has to ask for the scoping to get it.
    harness: z
      .string()
      .max(120)
      .optional()
      .describe(
        'Filter to one harness_slug. WARNING: like `workspace`, excludes every CI/gate row (those are NULL by design) — omit for CI triage.',
      ),
    rollup: z
      .enum(['commit', 'runGroup'])
      .optional()
      .describe('Aggregate instead of listing rows: group by commit_sha or run_group_id.'),
    latestPerFile: z
      .boolean()
      .optional()
      .describe(
        'Collapse to the most recent run per file. Defaults true, or false when `filePath` or `testRunIds` is given.',
      ),
    limit: z.number().int().min(1).max(200).optional().describe(`Max rows (default ${DEFAULT_LIMIT}).`),
  }),
  result: z
    .object({
      count: z.number().int().nonnegative(),
      total: z.number().int().nonnegative(),
      truncatedByLimit: z.boolean(),
      latestPerFile: z.boolean(),
      rollup: z.enum(['commit', 'runGroup']).optional(),
      source: z.enum(['ci', 'local', 'admin-ui', 'mutation-probe']).optional(),
      effectiveSourceFilter: z.string().optional(),
      omittedBySourceFilter: z.number().int().nonnegative().optional(),
      notRecorded: z.literal(true).optional(),
      reason: z.literal(NO_RUNS_RECORDED_REASON).optional(),
      runs: z.array(testingRunResultSchema).optional(),
      groups: z.array(testingRunGroupResultSchema).optional(),
    })
    .passthrough(),
  // NO `contract` — AUDITED 2026-09-16 (WI-2145871); recorded `reasoned` in
  // SHAPER_CONTRACT_EXEMPT, where the measurement lives. There is no axis a row
  // contract could hold: `projectTestingRun` SPREADS each row (`{ ...r, … }`) and
  // the envelope spreads too (`{ ...d, runs: kept }`), so every key passes through
  // and a `fields`/`preserve` pin is trivially satisfied — green while asserting
  // nothing, which is worse than no pin because the next reader counts it guarded.
  // What can actually regress here is the row BUDGET and the `payloadBounded`
  // marker: behavioural, not key-presence, and covered by this shaper's own tests.
  shape: {
    standard: (data) => shapeTestingRuns(data, 'standard'),
    trimmed: (data) => shapeTestingRuns(data, 'trimmed'),
  },
  async handler(args: {
    testRunIds?: number[];
    filePath?: string;
    commitSha?: string;
    runGroup?: string;
    runGroupId?: string;
    status?: Array<'pass' | 'fail' | 'skip' | 'cancelled' | 'error' | 'running'>;
    source?: 'ci' | 'local' | 'admin-ui' | 'mutation-probe';
    since?: string;
    sinceHours?: number;
    workspace?: string;
    harness?: string;
    rollup?: 'commit' | 'runGroup';
    latestPerFile?: boolean;
    limit?: number;
  }) {
    const { sql } = getOrgPg();
    // Exact-ID lookups are evidence receipt reads: do not silently return only
    // the ordinary listing default when a caller names up to 100 receipts.
    const limit = args.limit ?? args.testRunIds?.length ?? DEFAULT_LIMIT;
    const pathLike = args.filePath ? toPathPattern(args.filePath) : null;
    const shaLike = args.commitSha ? toShaPattern(args.commitSha) : null;
    const testRunIds = args.testRunIds ?? null;
    const runGroup = normalizeRunGroupFilter(args.runGroup, args.runGroupId);
    const source = defaultRollupSource(args.rollup, args.source);
    // The mutation-probe exclusion protects BROWSING and AGGREGATION, where a
    // deliberately-red probe row would contaminate "what is failing". An
    // exact-ID lookup is neither: the caller already holds the receipt and is
    // asking whether it exists. Applying the exclusion there answers `total: 0`
    // for a row that is plainly in the ledger — an ABSENCE-shaped result that
    // reads as "this citation is fabricated", which is precisely how a
    // mutation-probe-backed spec-evidence binding gets its grading audit failed
    // by an independent auditor doing the right thing with the wrong instrument
    // (measured 2026-09-22 on scorecard EI-23921807742712130: rows 18917525 /
    // 18917527 exist, `testing:runs { testRunIds }` returned 0). Exact ids are
    // receipt reads, same reasoning as the `limit` default just above.
    const sourceFilter =
      args.source === undefined && args.rollup === undefined && testRunIds == null
        ? sql`source <> 'mutation-probe'`
        : sql`(${source}::text IS NULL OR source = ${source})`;
    const workspace = args.workspace ?? null;
    const harness = args.harness ?? null;
    const statuses = args.status ?? null;
    const sinceTs =
      args.since ?? (args.sinceHours != null ? new Date(Date.now() - args.sinceHours * 3_600_000).toISOString() : null);
    // Naming a file means you want THAT FILE'S HISTORY; asking broadly means
    // you want the current picture, where a stale red would mislead.
    const latestPerFile = args.latestPerFile ?? (args.filePath === undefined && args.testRunIds == null);
    const effectiveSourceFilter =
      args.source !== undefined
        ? `source = '${args.source}' (explicit)`
        : testRunIds == null
          ? "source <> 'mutation-probe' (default row-list exclusion)"
          : 'none (exact testRunIds receipt lookup)';
    const shouldCountSourceOmissions = args.source !== undefined || testRunIds == null;

    const where = sql`
       WHERE (${pathLike}::text IS NULL OR file_path ILIKE ${pathLike} ESCAPE '\\')
         AND (${shaLike}::text IS NULL OR commit_sha ILIKE ${shaLike})
         AND (${testRunIds}::bigint[] IS NULL OR id = ANY(${testRunIds}::bigint[]))
         AND (${runGroup}::text IS NULL OR run_group_id = ${runGroup})
         AND ${sourceFilter}
         AND (${workspace}::text IS NULL OR workspace_id = ${workspace})
         AND (${harness}::text IS NULL OR harness_slug = ${harness})
         AND (${statuses}::text[] IS NULL OR status = ANY(${statuses}::text[]))
         AND (${sinceTs}::timestamptz IS NULL OR started_at >= ${sinceTs}::timestamptz)`;

    if (args.rollup) {
      const keyCol = args.rollup === 'commit' ? sql`commit_sha` : sql`run_group_id`;
      // A gate retry writes a second row for the same file/commit/run group. The
      // row-listing path already hides the superseded attempt; applying the same
      // collapse here is what makes "is this sha green" answer the current
      // outcome instead of counting a historical fail forever. Keep an explicit
      // latestPerFile:false escape hatch for callers that intentionally want the
      // raw attempt history in an aggregate.
      const rollupRows = latestPerFile
        ? sql`SELECT DISTINCT ON (${keyCol}, file_path) *
                FROM filtered
               ORDER BY ${keyCol}, file_path, finished_at DESC NULLS LAST, id DESC`
        : sql`SELECT * FROM filtered`;
      const rows = await sql<
        Array<{
          key: string | null;
          commit_sha: string | null;
          commit_shas: string;
          total: string;
          failed: string;
          failed_files: string;
          files: string;
          // timestamptz reads back as a STRING on this client; `Date` here was an
          // assertion about the driver, not a check of it. Route through toIso.
          first_start: string | Date | null;
          last_finish: string | Date | null;
          group_count: string;
        }>
      >`
        WITH filtered AS (
          SELECT * FROM harness_shared.test_runs
          ${where}
        ), latest_rows AS (
          ${rollupRows}
        ), grouped AS (
          SELECT ${keyCol} AS key,
                 -- WHICH CANDIDATE did this group judge. For a commit rollup
                 -- this restates the key; for a runGroup rollup it is the only
                 -- way to tell, and without it "recent gate runs" cannot be
                 -- tied to the sha under test at all. A run group spans one
                 -- candidate, so max() picks it; commit_shas exposes the
                 -- anomaly rather than hiding it behind an arbitrary pick.
                 max(commit_sha) AS commit_sha,
                 count(DISTINCT commit_sha)::text AS commit_shas,
                 count(*)::text AS total,
                 count(*) FILTER (WHERE status = ANY(${RED_STATUSES as unknown as string[]}::text[]))::text AS failed,
                 count(DISTINCT file_path) FILTER (WHERE status = ANY(${RED_STATUSES as unknown as string[]}::text[]))::text AS failed_files,
                 count(DISTINCT file_path)::text AS files,
                 min(started_at) AS first_start,
                 max(finished_at) AS last_finish
            FROM latest_rows
           GROUP BY 1
        )
        SELECT g.*, (SELECT count(*) FROM grouped)::text AS group_count
          FROM grouped g
         ORDER BY g.last_finish DESC NULLS LAST
         LIMIT ${limit}`;

      const total = rows.length > 0 ? Number(rows[0]!.group_count) : 0;
      return {
        data: {
          rollup: args.rollup,
          source,
          latestPerFile,
          count: rows.length,
          total,
          truncatedByLimit: total > rows.length,
          ...emptyResultMetadata(rows.length),
          groups: rows.map((r) => ({
            key: r.key,
            commitSha: r.commit_sha,
            // >1 means the group spans several candidates, so commitSha is one
            // arbitrary member and must not be read as "the sha this judged".
            commitShaCount: Number(r.commit_shas),
            total: Number(r.total),
            failed: Number(r.failed),
            failedFiles: Number(r.failed_files),
            files: Number(r.files),
            firstStart: iso(r.first_start),
            lastFinish: iso(r.last_finish),
          })),
        },
      };
    }

    const picked = latestPerFile
      ? sql`SELECT DISTINCT ON (file_path) * FROM filtered ORDER BY file_path, finished_at DESC NULLS LAST, id DESC`
      : sql`SELECT * FROM filtered`;

    // Keep the policy that protects ordinary browsing, but report how many
    // otherwise-matching rows it hid. Without this second count, a file-path
    // lookup that found only mutation-probe rows looked exactly like no runs
    // had ever been recorded.
    const whereWithoutSource = sql`
       WHERE (${pathLike}::text IS NULL OR file_path ILIKE ${pathLike} ESCAPE '\\')
         AND (${shaLike}::text IS NULL OR commit_sha ILIKE ${shaLike})
         AND (${testRunIds}::bigint[] IS NULL OR id = ANY(${testRunIds}::bigint[]))
         AND (${runGroup}::text IS NULL OR run_group_id = ${runGroup})
         AND (${workspace}::text IS NULL OR workspace_id = ${workspace})
         AND (${harness}::text IS NULL OR harness_slug = ${harness})
         AND (${statuses}::text[] IS NULL OR status = ANY(${statuses}::text[]))
         AND (${sinceTs}::timestamptz IS NULL OR started_at >= ${sinceTs}::timestamptz)`;

    const rows = await sql<
      Array<{
        id: string;
        workspace_id: string | null;
        harness_slug: string | null;
        execution_details: unknown;
        file_path: string;
        status: string;
        framework: string;
        duration_ms: string | null;
        started_at: string | Date;
        finished_at: string | Date | null;
        output_tail: string | null;
        run_group_id: string | null;
        source: string;
        branch: string | null;
        commit_sha: string | null;
        loop_lag_p95_ms: number | null;
        rss_mb: number | null;
        worktree_dirty: boolean;
        is_scratch_config: boolean;
        total: string;
      }>
    >`
      WITH filtered AS (
        SELECT * FROM harness_shared.test_runs
        ${where}
      ), picked AS (
        ${picked}
      )
      SELECT p.id::text, p.workspace_id, p.harness_slug, p.execution_details,
             p.file_path, p.status, p.framework, p.duration_ms::text, p.started_at, p.finished_at,
             CASE WHEN p.status = ANY(${RED_STATUSES as unknown as string[]}::text[])
                  THEN left(p.output_tail, ${OUTPUT_TAIL_CHARS}) END AS output_tail,
             p.run_group_id, p.source, p.branch, p.commit_sha,
             p.loop_lag_p95_ms, p.rss_mb, p.worktree_dirty, p.is_scratch_config,
             (SELECT count(*) FROM picked)::text AS total
        FROM picked p
       ORDER BY p.finished_at DESC NULLS LAST, p.started_at DESC
       LIMIT ${limit}`;

    const omittedRows = shouldCountSourceOmissions
      ? await sql<Array<{ omitted_by_source_filter: string }>>`
          SELECT count(*)::text AS omitted_by_source_filter
            FROM harness_shared.test_runs
            ${whereWithoutSource}
             AND NOT COALESCE((${sourceFilter}), false)`
      : [];
    const omittedBySourceFilter = Number(omittedRows[0]?.omitted_by_source_filter ?? 0);

    const total = rows.length > 0 ? Number(rows[0]!.total) : 0;
    return {
      data: {
        count: rows.length,
        total,
        truncatedByLimit: total > rows.length,
        ...emptyResultMetadata(rows.length + omittedBySourceFilter),
        latestPerFile,
        effectiveSourceFilter,
        omittedBySourceFilter,
        runs: rows.map((r) => ({
          id: Number(r.id),
          workspaceId: r.workspace_id,
          harnessSlug: r.harness_slug,
          root: parseStoredExecutionDetails(r.execution_details)?.root ?? null,
          filePath: r.file_path,
          status: r.status,
          framework: r.framework,
          startedAt: iso(r.started_at),
          finishedAt: iso(r.finished_at),
          durationMs: r.duration_ms === null ? null : Number(r.duration_ms),
          commitSha: r.commit_sha,
          runGroupId: r.run_group_id,
          source: r.source,
          branch: r.branch,
          outputTail: r.output_tail,
          loopLagP95Ms: r.loop_lag_p95_ms,
          rssMb: r.rss_mb,
          saturationSuspect: isSaturationSuspect(r.loop_lag_p95_ms),
          worktreeDirty: r.worktree_dirty,
          isScratchConfig: r.is_scratch_config,
        })),
      },
    };
  },
});
