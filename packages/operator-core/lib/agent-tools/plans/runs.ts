/**
 * harness_shared.plan_runs + plan_run_turns data access — the launched
 * plan-agent run store. plan-agent-launch-2026-05-21, Phase 3.
 *
 * `plan_runs` — one row per agent launched from a plan (P-012,
 * launches-only — the plan's origin is `plan_revisions` seq 1, D-006).
 * `plan_run_turns` — the run transcript, one row per turn.
 *
 * A thin DAL over the `harness_shared` tables P-010 created, in the
 * shape of `revisions.ts`. Used by `plans:launch` (P-012), resume
 * (P-013), and `plans:runs` (P-015). Unlike `recordPlanRevision`
 * (best-effort — the `.md` file is canonical), these rows ARE the
 * canonical record of a launch, so the writes throw on failure; the
 * caller decides what is fatal (a missing transcript turn is not — the
 * run already streamed to the user).
 */

import { withWorkspace } from '@papercusp/db-org';
// F-A2 (workspace-data-isolation-leaks): plan_runs / plan_run_turns were pinned to
// DEFAULT_WORKSPACE_ID, so scheduled-plan run history + transcripts were global across
// workspaces. Stamp + scope to the ACTIVE workspace instead (migration 303 adds the
// workspace_id column; RLS is a Phase-2 follow-up — see the migration header).
import { activeWorkspaceId } from '../../workspace-registry';
import { operatorHomeHarnessSlug } from '../../harness/operator-home-harness';
import {
  loadExternalTriggerRunVisibilities,
  type ExternalTriggerRunVisibility,
} from '../../external-triggers/admin';

/**
 * A run's lifecycle status (P-016):
 *   - `running`  — a turn is streaming;
 *   - `idle`     — a turn finished, the run is resumable (D-010);
 *   - `failed`   — the agent backend errored on the turn;
 *   - `archived` — set aside (auto, via the idle sweep, or manually);
 *                  still resumable — resuming reactivates it;
 *   - `done`     — deliberately concluded (manual only).
 * `running` / `idle` / `failed` are machine-set (launch, resume, the
 * turn settle, the orphan sweep); `archived` / `done` are reachable
 * manually via `plans:set-run-status`, and `archived` also via the
 * poll-based sweep (`sweepPlanRuns`).
 */
export type PlanRunStatus = 'running' | 'idle' | 'archived' | 'done' | 'failed';

/** The statuses a human/agent may set directly via
 *  `plans:set-run-status` — machine-only `running`/`failed` excluded. */
export type ManualPlanRunStatus = 'archived' | 'done' | 'idle';

/**
 * Whether a run in `from` may be manually restatused (P-016). A
 * `running` run is mid-turn: a manual restatus would race the turn's
 * own settle (`executePlanAgentTurn` writes `idle`/`failed` at the
 * end), so it is rejected — wait, or let the orphan sweep handle a
 * genuinely stuck run. Every settled status accepts any manual target
 * (`archived`/`done`/`idle` — `idle` un-archives or reopens a run).
 * Pure + exported for unit test.
 */
export function canManuallyRestatusRun(from: PlanRunStatus): boolean {
  return from !== 'running';
}

/** Transcript turn author. */
export type PlanRunTurnRole = 'user' | 'assistant';

export interface InsertPlanRunArgs {
  planSlug: string;
  /**
   * Harness scope for the launch. Default = the operator-home hive
   * (`operatorHomeHarnessSlug()` — the single pointer; papercup→papercusp
   * generalization). Per-harness callers (plans:launch from a
   * harness-context agent) pass their harness slug.
   */
  harnessSlug?: string;
  /** `hashPlanContent` of the plan doc that seeded the launch — P-023's
   *  stale-version badge compares it against the plan's current hash. */
  planContentHash: string;
  /** The run's `runAgentChat` session id (also the `?plan_run=` value). */
  sessionId: string;
  /** Optional free-text launch instruction. */
  note: string | null;
  /** Resolved identity of whoever launched the run. */
  launchedBy: string;
  /** Human-readable run label for the runs list. */
  title: string | null;
  /** Initial status — `running` at launch. */
  status: PlanRunStatus;
}

/** Insert a `plan_runs` row; returns its id. Throws on DB failure — a
 *  launch with no run record genuinely failed. */
export async function insertPlanRun(args: InsertPlanRunArgs): Promise<number> {
  const now = Date.now();
  const harnessSlug = args.harnessSlug?.trim() || operatorHomeHarnessSlug();
  return withWorkspace(activeWorkspaceId(), async (tx) => {
    const rows = await tx<{ id: number }[]>`
      INSERT INTO harness_shared.plan_runs (
        workspace_id, harness_slug, plan_slug, plan_content_hash, session_id, note,
        launched_by, launched_at, status, title, updated_at
      ) VALUES (
        ${activeWorkspaceId()}, ${harnessSlug}, ${args.planSlug}, ${args.planContentHash}, ${args.sessionId},
        ${args.note}, ${args.launchedBy}, ${now}, ${args.status},
        ${args.title}, ${now}
      )
      RETURNING id
    `;
    return Number(rows[0].id);
  });
}

/** Update a run's status (and bump `updated_at`). */
export async function setPlanRunStatus(
  runId: number,
  status: PlanRunStatus,
): Promise<void> {
  await withWorkspace(activeWorkspaceId(), async (tx) => {
    await tx`
      UPDATE harness_shared.plan_runs
      SET status = ${status}, updated_at = ${Date.now()}
      WHERE id = ${runId}
    `;
  });
}

/**
 * Persist the values a completing run PUBLISHED (P-026 / D-017, mig 908).
 *
 * Kept beside `insertPlanRun`/`setPlanRunStatus` rather than in the tool, so every
 * `plan_runs` write goes through this one module. The VALIDATION deliberately does not
 * live here — `evaluatePublishOutputs` (plan-outputs.ts) owns that and is pure, so this
 * function is reached only with values already checked against the plan's promise.
 *
 * Returns false when no row matched (an unknown or out-of-scope run id), so the caller
 * can report a miss instead of reporting a silent success on a write that touched
 * nothing.
 */
export async function setPlanRunOutputs(
  runId: number,
  outputs: Record<string, unknown>,
): Promise<boolean> {
  return withWorkspace(activeWorkspaceId(), async (tx) => {
    // jsonb bound as `${JSON.stringify(x)}::text::jsonb` — the operator's postgres-js
    // client throws on sql.json / bare-object jsonb params
    // (agent-insights/postgres-js-jsonb-binding).
    const rows = await tx<{ id: number }[]>`
      UPDATE harness_shared.plan_runs
         SET outputs = ${JSON.stringify(outputs)}::text::jsonb,
             updated_at = ${Date.now()}
       WHERE id = ${runId}
       RETURNING id
    `;
    return rows.length > 0;
  });
}

/** A `running` run untouched this long is orphaned — the process that
 *  owned its turn is gone (no live turn outlives the ~10-min tool
 *  timeout). The sweep transitions it to `failed`. */
export const PLAN_RUN_ORPHAN_FAIL_MS = 30 * 60_000; // 30 min

/** An `idle` run untouched this long is auto-archived — to declutter
 *  the active list. Non-destructive: resuming reactivates it (D-010). */
export const PLAN_RUN_IDLE_ARCHIVE_MS = 7 * 24 * 60 * 60_000; // 7 days

export interface SweepPlanRunsResult {
  /** Orphaned `running` rows transitioned to `failed`. */
  failed: number;
  /** Stale `idle` rows transitioned to `archived`. */
  archived: number;
}

/**
 * The poll-based run-status sweep (P-016). Two automatic transitions
 * that no in-process turn settle can make:
 *
 *   - orphaned `running` → `failed` — the process that owned the turn
 *     died before it could settle the status;
 *   - stale `idle` → `archived` — declutter; the run stays resumable
 *     (D-010), so this is non-destructive.
 *
 * Idempotent and cheap (two indexed bulk UPDATEs); the `plans:runs`
 * read calls it before every list — that read *is* the v1 poll, so no
 * background timer is needed. `now` is injectable for tests.
 */
export async function sweepPlanRuns(
  now: number = Date.now(),
): Promise<SweepPlanRunsResult> {
  return withWorkspace(activeWorkspaceId(), async (tx) => {
    const failedRows = await tx<{ id: number }[]>`
      UPDATE harness_shared.plan_runs
      SET status = 'failed', updated_at = ${now}
      WHERE status = 'running'
        AND updated_at < ${now - PLAN_RUN_ORPHAN_FAIL_MS}
      RETURNING id
    `;
    const archivedRows = await tx<{ id: number }[]>`
      UPDATE harness_shared.plan_runs
      SET status = 'archived', updated_at = ${now}
      WHERE status = 'idle'
        AND updated_at < ${now - PLAN_RUN_IDLE_ARCHIVE_MS}
      RETURNING id
    `;
    return { failed: failedRows.length, archived: archivedRows.length };
  });
}

/** A `plan_runs` row, camelCased. Returned by `getPlanRun`. */
export interface PlanRunRow {
  id: number;
  planSlug: string;
  planContentHash: string;
  sessionId: string;
  note: string | null;
  launchedBy: string;
  launchedAt: number;
  status: PlanRunStatus;
  title: string | null;
  updatedAt: number;
  // scheduled-recurring-plans-2026-06-16 (P-022) per-run enrichment.
  runType: string; // 'interactive' | 'scheduled'
  trigger: string | null; // 'scheduled' | 'manual' | 'event'
  outcome: string | null; // success | partial | failed (scheduled runs)
  finishedAt: number | null;
  runSeq: number | null;
  instancePlanSlug: string | null;
  /** finishedAt − launchedAt (ms); null while running. */
  durationMs: number | null;
  /** External-event launch provenance, policy trace, and redacted payload. */
  triggerRun?: ExternalTriggerRunVisibility | null;
}

/** Raw `plan_runs` row as PG returns it — snake_case, and `BIGSERIAL`
 *  / `BIGINT` columns can arrive as strings. */
export interface RawPlanRunRow {
  id: number | string;
  plan_slug: string;
  plan_content_hash: string;
  session_id: string;
  note: string | null;
  launched_by: string;
  launched_at: number | string;
  status: PlanRunStatus;
  title: string | null;
  updated_at: number | string;
  // P-022 enrichment (optional: getPlanRun's older callers may not select them).
  run_type?: string | null;
  trigger?: string | null;
  outcome?: string | null;
  finished_at?: number | string | null;
  run_seq?: number | string | null;
  instance_plan_slug?: string | null;
}

/** Map a raw `plan_runs` row to the camelCased `PlanRunRow`. Pure +
 *  exported for unit test — the `Number()` coercions are load-bearing
 *  (PG returns `BIGINT` columns as strings). */
export function mapPlanRunRow(r: RawPlanRunRow): PlanRunRow {
  return {
    id: Number(r.id),
    planSlug: r.plan_slug,
    planContentHash: r.plan_content_hash,
    sessionId: r.session_id,
    note: r.note,
    launchedBy: r.launched_by,
    launchedAt: Number(r.launched_at),
    status: r.status,
    title: r.title,
    updatedAt: Number(r.updated_at),
    runType: r.run_type ?? 'interactive',
    trigger: r.trigger ?? null,
    outcome: r.outcome ?? null,
    finishedAt: r.finished_at != null ? Number(r.finished_at) : null,
    runSeq: r.run_seq != null ? Number(r.run_seq) : null,
    instancePlanSlug: r.instance_plan_slug ?? null,
    durationMs: r.finished_at != null ? Number(r.finished_at) - Number(r.launched_at) : null,
    triggerRun: null,
  };
}

/** Fetch a single run by id, or `null` when no such run exists. Used
 *  by resume (P-013) to recover a run's `session_id` + `plan_slug`. */
export async function getPlanRun(runId: number): Promise<PlanRunRow | null> {
  return withWorkspace(activeWorkspaceId(), async (tx) => {
    const rows = await tx<RawPlanRunRow[]>`
      SELECT id, plan_slug, plan_content_hash, session_id, note,
             launched_by, launched_at, status, title, updated_at,
             run_type, trigger, outcome, finished_at, run_seq, instance_plan_slug
      FROM harness_shared.plan_runs
      WHERE id = ${runId}
    `;
    const r = rows[0];
    if (!r) return null;
    const run = mapPlanRunRow(r);
    const triggerRuns = await loadExternalTriggerRunVisibilities(tx, activeWorkspaceId(), {
      planRunRef: String(run.id),
      limit: 1,
    });
    return { ...run, triggerRun: triggerRuns[0] ?? null };
  });
}

/**
 * Mark a run `running` and re-stamp its `plan_content_hash` — called
 * by resume (P-013) at the start of a continuation. The hash is
 * updated because the resumed turn is re-seeded with the *current*
 * plan (the bundle is re-sent as the system prompt every spawn), so
 * `plan_content_hash` always means "the plan as the run last saw it" —
 * which keeps P-023's stale-version badge honest.
 *
 * P1-1 (resume-race guard): the claim is ATOMIC — the UPDATE only flips
 * a run that is NOT already `running` (`WHERE status <> 'running'`), and
 * returns `{ claimed }` reflecting whether THIS call won the transition.
 * Two concurrent resumes on the same run therefore serialize on the row:
 * exactly one sees `claimed: true` and kicks the turn; the loser sees
 * `claimed: false` and must reject rather than spawn a duplicate turn.
 * An archived/idle/failed/done run still reactivates (D-010) — only an
 * already-`running` run is refused.
 */
export async function markPlanRunResumed(
  runId: number,
  planContentHash: string,
): Promise<{ claimed: boolean }> {
  return withWorkspace(activeWorkspaceId(), async (tx) => {
    const rows = await tx<{ id: number }[]>`
      UPDATE harness_shared.plan_runs
      SET status = 'running',
          plan_content_hash = ${planContentHash},
          updated_at = ${Date.now()}
      WHERE id = ${runId}
        AND status <> 'running'
      RETURNING id
    `;
    return { claimed: rows.length > 0 };
  });
}

/** A `plan_runs` row plus its transcript turn count — the list-view
 *  shape returned by `listPlanRuns` / the `plans:runs` tool. */
export interface PlanRunSummary extends PlanRunRow {
  /** Number of `plan_run_turns` rows for this run. Null means no transcript
   * rows were recorded, which is distinct from a measured zero-turn run. */
  turnCount: number | null;
  /** Work-item rollup for the run (scheduled runs): counts by bucket. */
  workItems: { total: number; passed: number; failed: number; open: number };
  /** Σ plan_run_turns cost (interactive runs). Scheduled-run EXECUTION cost lives in
   *  the work-items, attributed separately (P-013). */
  costUsd: number;
  /** Domain metrics a routine published for this run (result_summary jsonb) — the
   *  series source for the Runs-tab metric charts (P-025). Null when none published. */
  resultSummary: Record<string, unknown> | null;
}

/** Aggregate over a template's runs — the Runs-tab summary header (P-023). */
export interface PlanRunRollup {
  total: number;
  success: number;
  partial: number;
  failed: number;
  running: number;
  /** settled-success / settled-total (0 when nothing settled). */
  successRate: number;
  avgDurationMs: number | null;
  medianDurationMs: number | null;
  totalCostUsd: number;
  lastOutcome: string | null;
  /** Regression flags: a failed latest run, or a run >2× the median duration. */
  regression: { lastFailed: boolean; slowRunIds: number[] };
}

/** Pure aggregate over a runs list (PURE — unit-testable, no DB). P-023. */
export function computePlanRunRollup(runs: readonly PlanRunSummary[]): PlanRunRollup {
  const success = runs.filter((r) => r.outcome === 'success').length;
  const partial = runs.filter((r) => r.outcome === 'partial').length;
  const failed = runs.filter((r) => r.outcome === 'failed').length;
  const running = runs.filter((r) => r.status === 'running').length;
  const settled = success + partial + failed;
  const durations = runs.map((r) => r.durationMs).filter((d): d is number => d != null);
  const avg = durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null;
  const sorted = [...durations].sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)]! : null;
  const totalCostUsd = runs.reduce((a, r) => a + (r.costUsd || 0), 0);
  // newest-first list → runs[0] is latest.
  const lastOutcome = runs.find((r) => r.outcome != null)?.outcome ?? null;
  const slowRunIds =
    median != null
      ? runs.filter((r) => r.durationMs != null && r.durationMs > 2 * median).map((r) => r.id)
      : [];
  return {
    total: runs.length,
    success,
    partial,
    failed,
    running,
    successRate: settled ? success / settled : 0,
    avgDurationMs: avg,
    medianDurationMs: median,
    totalCostUsd,
    lastOutcome,
    regression: { lastFailed: runs[0]?.outcome === 'failed', slowRunIds },
  };
}

/**
 * List every run launched from a plan, newest-first. The launch
 * history behind `plans:runs` (P-015) and the Agents tab's past-runs
 * list (P-021). Each row carries its transcript turn count via a
 * correlated subquery so the list view needs no follow-up query.
 */
export async function listPlanRuns(
  planSlug: string,
  opts: { harnessSlug?: string } = {},
): Promise<PlanRunSummary[]> {
  const harnessSlug = opts.harnessSlug?.trim() || operatorHomeHarnessSlug();
  return withWorkspace(activeWorkspaceId(), async (tx) => {
    const rows = await tx<
      (RawPlanRunRow & {
        turn_count: number | string | null;
        cost_usd: number | string;
        wi_total: number | string;
        wi_passed: number | string;
        wi_failed: number | string;
        result_summary: unknown;
      })[]
    >`
      SELECT r.id, r.plan_slug, r.plan_content_hash, r.session_id, r.note,
             r.launched_by, r.launched_at, r.status, r.title, r.updated_at,
             r.run_type, r.trigger, r.outcome, r.finished_at, r.run_seq, r.instance_plan_slug,
             r.result_summary,
             NULLIF((SELECT COUNT(*) FROM harness_shared.plan_run_turns t WHERE t.plan_run_id = r.id), 0) AS turn_count,
             (SELECT COALESCE(SUM(t.cost_usd), 0) FROM harness_shared.plan_run_turns t WHERE t.plan_run_id = r.id) AS cost_usd,
             (SELECT COUNT(*) FROM harness_shared.harness_features_consolidated w
                WHERE w.harness_slug = r.harness_slug AND w.payload -> 'plan_run' ->> 'runId' = r.id::text) AS wi_total,
             (SELECT COUNT(*) FROM harness_shared.harness_features_consolidated w
                WHERE w.harness_slug = r.harness_slug AND w.payload -> 'plan_run' ->> 'runId' = r.id::text
                  AND w.status IN ('passed', 'done', 'resolved', 'closed')) AS wi_passed,
             (SELECT COUNT(*) FROM harness_shared.harness_features_consolidated w
                WHERE w.harness_slug = r.harness_slug AND w.payload -> 'plan_run' ->> 'runId' = r.id::text
                  AND w.status IN ('failed', 'dropped', 'deprecated')) AS wi_failed
      FROM harness_shared.plan_runs r
      WHERE r.workspace_id = ${activeWorkspaceId()} AND r.harness_slug = ${harnessSlug} AND r.plan_slug = ${planSlug}
      ORDER BY r.launched_at DESC, r.id DESC
    `;
    const triggerRuns = await loadExternalTriggerRunVisibilities(tx, activeWorkspaceId(), {
      planHarnessSlug: harnessSlug,
      planSlug,
      limit: Math.max(50, rows.length),
    });
    const triggerRunByPlanRun = new Map(
      triggerRuns
        .filter((run) => run.planRunRef !== null)
        .map((run) => [run.planRunRef as string, run] as const),
    );
    return rows.map((r) => {
      const total = Number(r.wi_total);
      const passed = Number(r.wi_passed);
      const failed = Number(r.wi_failed);
      return {
        ...mapPlanRunRow(r),
        turnCount: r.turn_count == null ? null : Number(r.turn_count),
        costUsd: Number(r.cost_usd),
        workItems: { total, passed, failed, open: Math.max(0, total - passed - failed) },
        resultSummary: (r.result_summary as Record<string, unknown> | null) ?? null,
        triggerRun: triggerRunByPlanRun.get(String(r.id)) ?? null,
      };
    });
  });
}

export interface AppendPlanRunTurnArgs {
  planRunId: number;
  role: PlanRunTurnRole;
  content: string;
  tokensIn?: number | null;
  tokensOut?: number | null;
  costUsd?: number | null;
}

/**
 * Append a transcript turn. `seq` is allocated `max+1` per run in a
 * single `INSERT … SELECT` — `plans:launch` serialises its two turns
 * (user then assistant), and `UNIQUE (plan_run_id, seq)` is the
 * backstop. Returns the allocated `seq`. Throws on DB failure; the
 * caller treats a lost transcript turn as non-fatal (the run already
 * streamed to the user).
 */
export async function appendPlanRunTurn(
  args: AppendPlanRunTurnArgs,
): Promise<number> {
  const now = Date.now();
  return withWorkspace(activeWorkspaceId(), async (tx) => {
    const rows = await tx<{ seq: number }[]>`
      INSERT INTO harness_shared.plan_run_turns (
        workspace_id, plan_run_id, harness_slug, seq, role, content,
        tokens_in, tokens_out, cost_usd, created_at
      )
      SELECT
        ${activeWorkspaceId()},
        ${args.planRunId},
        -- data-scoping-audit P-005: mirror the parent run's harness_slug so the
        -- turn is directly scope-bearing (RLS/federation symmetry), not only via
        -- a parent join. NULL if the parent run vanished (defensive; FK keeps it
        -- present in practice).
        (SELECT harness_slug FROM harness_shared.plan_runs WHERE id = ${args.planRunId}),
        COALESCE(MAX(seq), 0) + 1,
        ${args.role}, ${args.content},
        ${args.tokensIn ?? null}, ${args.tokensOut ?? null},
        ${args.costUsd ?? null}, ${now}
      FROM harness_shared.plan_run_turns
      WHERE plan_run_id = ${args.planRunId}
      RETURNING seq
    `;
    return Number(rows[0].seq);
  });
}

// ── Scoped transcript read (P-008) ─────────────────────────────────

/** Default / max number of turns one `plans:revision-transcript`
 *  page returns — the read is paginated, never a whole-transcript
 *  dump (D-002). */
export const TRANSCRIPT_DEFAULT_LIMIT = 20;
export const TRANSCRIPT_MAX_LIMIT = 100;

/** Clamp a caller-supplied transcript page size into
 *  `[1, TRANSCRIPT_MAX_LIMIT]`, defaulting when absent/invalid.
 *  Pure + exported for unit test. */
export function clampTranscriptLimit(raw: number | null | undefined): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return TRANSCRIPT_DEFAULT_LIMIT;
  }
  return Math.min(TRANSCRIPT_MAX_LIMIT, Math.max(1, Math.floor(raw)));
}

/** Escape the LIKE metacharacters in a transcript search query so it
 *  matches as a literal substring (paired with `ESCAPE '\'`). Pure +
 *  exported for unit test. */
export function escapeLikePattern(s: string): string {
  return s.replace(/[\\%_]/g, (ch) => '\\' + ch);
}

/** One turn in a scoped transcript page. */
export interface PlanRunTranscriptTurn {
  seq: number;
  role: PlanRunTurnRole;
  content: string;
  createdAt: number;
}

/** A scoped, paginated slice of a run's transcript. */
export interface PlanRunTranscriptPage {
  turns: PlanRunTranscriptTurn[];
  /** `seq` to pass as the next `cursor`, or `null` at the end. */
  nextCursor: number | null;
}

export interface ReadPlanRunTranscriptOpts {
  /** Case-insensitive literal substring filter over turn content. */
  query?: string | null;
  /** Return turns with `seq` strictly greater than this. */
  cursor?: number | null;
  /** Page size — clamped via `clampTranscriptLimit`. */
  limit?: number | null;
  /** Upper-bound turns to `created_at <= beforeTs` — P-007 scopes a
   *  revision's rationale summary to the conversation up to that
   *  revision, not the run's whole later history. */
  beforeTs?: number | null;
}

/**
 * Read a scoped, paginated slice of a plan run's transcript — the
 * `plan_run` branch of `plans:revision-transcript` (P-008). Turns are
 * `seq`-ordered; `cursor` is a `seq` exclusive lower bound; `query`
 * is a literal substring filter. One extra row is fetched to decide
 * `nextCursor` without a second query. A `session_id` with no `plan_run`
 * row yields an empty page (an anomaly, not an error).
 */
export async function readPlanRunTranscript(
  sessionId: string,
  opts: ReadPlanRunTranscriptOpts = {},
): Promise<PlanRunTranscriptPage> {
  const limit = clampTranscriptLimit(opts.limit);
  const cursor =
    typeof opts.cursor === 'number' && Number.isFinite(opts.cursor)
      ? Math.floor(opts.cursor)
      : 0;
  const query = opts.query?.trim() ? opts.query.trim() : null;

  return withWorkspace(activeWorkspaceId(), async (tx) => {
    const runRows = await tx<{ id: number | string }[]>`
      SELECT id FROM harness_shared.plan_runs
      WHERE session_id = ${sessionId}
      LIMIT 1
    `;
    const run = runRows[0];
    if (!run) return { turns: [], nextCursor: null };

    const queryFilter = query
      ? tx`AND content ILIKE ${'%' + escapeLikePattern(query) + '%'} ESCAPE '\\'`
      : tx``;
    const beforeFilter =
      typeof opts.beforeTs === 'number' && Number.isFinite(opts.beforeTs)
        ? tx`AND created_at <= ${Math.floor(opts.beforeTs)}`
        : tx``;
    const rows = await tx<
      {
        seq: number;
        role: PlanRunTurnRole;
        content: string;
        created_at: string | number;
      }[]
    >`
      SELECT seq, role, content, created_at
      FROM harness_shared.plan_run_turns
      WHERE plan_run_id = ${run.id} AND seq > ${cursor}
        ${queryFilter} ${beforeFilter}
      ORDER BY seq ASC
      LIMIT ${limit + 1}
    `;

    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    return {
      turns: page.map((r) => ({
        seq: Number(r.seq),
        role: r.role,
        content: r.content,
        createdAt: Number(r.created_at),
      })),
      nextCursor: hasMore ? Number(page[page.length - 1]!.seq) : null,
    };
  });
}
