/**
 * pipeline-events — the append + read helpers over `harness_shared.pipeline_events`
 * (mig 177), the append-only history of the git-sync → green-checkpoint → release
 * pipeline. The /admin Git tab's stats read from here.
 *
 * Before this table the pipeline kept only LATEST-state: git-sync's last status +
 * last resolver outcome in `routines.metadata` (overwritten every tick), the open
 * conflict in `harness_escalations` (overwritten), and nothing at all for
 * green-checkpoint. So counts over time ("how many merge conflicts", "main-green
 * rate") had no source. This is that source.
 *
 * Writes are BEST-EFFORT: a stats-log failure must never affect the pipeline
 * itself, so `appendPipelineEvent` swallows + warns rather than throwing into the
 * git-sync / green-checkpoint handlers that call it.
 *
 * Each fn takes an optional `sql` (the emitUsageEvent seam) — defaults to the
 * operator's org client, injected to a testcontainer client in integration tests.
 */
import { hostname } from 'node:os';
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { withPgRetry } from '../../pg-transient-retry';
import { getBuildInfo } from '../../build-info';

export type PipelineEventKind =
  | 'git_sync'
  | 'merge_resolver'
  | 'content_fixer'
  | 'green_checkpoint'
  /** P-001 (gate-verdict-liveness): the per-fire ledger ANCHOR — one row per gate tick/launch,
   *  written BEFORE any outcome exists. Deliberately a distinct kind: consumers of
   *  'green_checkpoint' treat "newest row" as "an outcome happened" (the watchdog's
   *  verdict-less clock among them), so anchors must never ride that stream. Admitted by the
   *  DB CHECK once migration 1054 applies; until then inserts best-effort warn-and-noop. */
  | 'green_checkpoint_fire'
  /** P-016 (gate-verdict-liveness): the weekly gate fire DRILL's outcome rows (pass /
   *  fail / skipped, lib/release/gate-fire-drill-deps.ts). Distinct kind for the same
   *  reason as the anchor above: drill outcomes must ride neither the 'green_checkpoint'
   *  outcome stream (a drill row would advance the verdict-less clock) nor the anchor
   *  stream (it would inflate the P-003 fires denominator). Admitted by the DB CHECK once
   *  migration 1083 applies; until then inserts best-effort warn-and-noop (weekly). */
  | 'gate_fire_drill'
  /** R-7 (green-gate-zero-wait-convergence) / EI-23420599799124840: the frozen-repair
   *  LATENCY ledger — one row per tick that actually held a readable repair queue, carrying
   *  the admit→verdict / red→fixer-spawn / fix→admit clocks. Distinct kind for the same two
   *  reasons as the rows above, and it is BOTH of them at once: on the 'green_checkpoint'
   *  stream it would advance the verdict-less clock, and on the anchor stream it would
   *  inflate the fires denominator. It exists because those clocks otherwise live only in
   *  the MUTABLE `gate_health.freezeAndConverge.repairLatency` slot, which the next tick
   *  merges over and a retire nulls — so they vanish exactly when a postmortem wants them.
   *  Admitted by the DB CHECK once migration 1167 applies; until then inserts best-effort
   *  warn-and-noop. */
  | 'green_checkpoint_repair_latency'
  | 'deploy'
  | 'release_fixer';

function db(sql?: Sql): Sql {
  return sql ?? (getOrgPg().sql as unknown as Sql);
}

/** P-015: which operator process emitted an event. On the shared dev box the desktop +
 *  the systemd :3070 / :3170 operators all run background machinery from DIFFERENT code
 *  trees (release-green vs staging), so "which host ran this tick" was an invisible
 *  lottery when diagnosing. The port discriminates the deployment; pid the process. */
export function hostTag(): string {
  return `${hostname()}:${process.env.PAPERCUSP_HONO_PORT ?? 'dev'}#${process.pid}`;
}

export interface AppendPipelineEvent {
  workspaceId: string;
  installSlug: string;
  kind: PipelineEventKind;
  /** Per-kind outcome string (see the migration header for the vocabulary). */
  status: string;
  detail?: Record<string, unknown>;
}

/** One logged pipeline event (read shape — camelCased, epoch-ms time). */
export interface PipelineEventRow {
  id: string;
  kind: PipelineEventKind;
  status: string;
  detail: Record<string, unknown>;
  createdAtMs: number;
}

/**
 * fleet-reliability-verification-2026-07-10 P-009: read `getBuildInfo()` (the
 * SAME cached sha/version resolver `/api/health` and the runtime-vintage
 * boot-report (P-008) already use) once per call — resolved+cached at module
 * load, so this never re-shells `git rev-parse` per event. Best-effort: a
 * resolve failure yields `{ sha: null, version: '0.0.0' }` (getBuildInfo's own
 * contract), never throws, so a vintage-stamp problem can never break the
 * pipeline event it's stamping.
 */
function currentVintageStamp(): { treeSha: string | null; bundleVersion: string } {
  const info = getBuildInfo();
  return { treeSha: info.sha, bundleVersion: info.version };
}

/** Append one pipeline event. Ordinary telemetry is best-effort; a required terminal
 * result may opt into throwing so its enclosing qualification transaction rolls back. */
export async function appendPipelineEvent(
  ev: AppendPipelineEvent,
  sql?: Sql,
  options: { required?: boolean } = {},
): Promise<void> {
  try {
    // P-015: stamp every event with the emitting host/process so the Git tab + a
    // post-mortem can tell WHICH operator ran a given tick (desktop vs :3070 vs :3170).
    //
    // P-009 (fleet-reliability-verification-2026-07-10): ALSO stamp the emitting
    // process's OWN build identity (vintage) on every event — every kind this
    // table carries (git_sync, merge_resolver, content_fixer, green_checkpoint,
    // deploy, release_fixer) is a gate/verdict-producing step in the SAME
    // pipeline, and "fix landed but gate still red" was, 2026-07-09/10, a
    // recurring ~5x manual-ssh diagnosis of "which build actually ran this
    // check" (root lesson of P-008's runtime-vintage ledger, generalized here to
    // every event this table logs, not just boot-time self-reports). One stamp
    // point covers the whole pipeline instead of touching each of the 6 call
    // sites individually. A caller cross-references `detail.vintage.treeSha`
    // against `deploys:vintage`'s current commit-lag report — a stale sha there
    // means "this verdict predates the fix — re-run", not "the fix didn't work".
    const detail = { ...(ev.detail ?? {}), host: hostTag(), vintage: currentVintageStamp() };
    await db(sql)`
      INSERT INTO harness_shared.pipeline_events (workspace_id, install_slug, kind, status, detail)
      VALUES (${ev.workspaceId || '*'}, ${ev.installSlug}, ${ev.kind}, ${ev.status},
              ${JSON.stringify(detail)}::text::jsonb)
    `;
  } catch (e) {
    if (options.required) throw e;
    console.warn(`[pipeline-events] append failed (${ev.kind}/${ev.status}): ${e instanceof Error ? e.message : e}`);
  }
}

/** Per-kind/per-status counts over a trailing window. */
export interface PipelineWindowSummary {
  sinceMs: number;
  gitSync: { total: number; synced: number; nothing: number; conflict: number; error: number };
  mergeResolver: { total: number; ok: number; failed: number; error: number };
  /**
   * EI-20702428259478130: these buckets must stay TOTAL over the produced status
   * vocabulary — `total === advanced + upToDate + advancedPrefix + notGreen +
   * notFastForward + createFailed + error + skipped + other`.
   *
   * They were NOT total, and the gap was not the harmless "unknown future status"
   * tail the fold's fallthrough was designed for. Measured over 30d on
   * `harness_shared.pipeline_events` (2026-08-17): green_checkpoint produced TEN
   * distinct statuses and only FIVE had a bucket, so 1205 of 9783 events (12.3%)
   * incremented `total` and no sub-counter — including every `error` (152: a
   * green-checkpoint crash, the 25-min timeout, or unparseable JSON) and every
   * `advanced-prefix` (13: a partial advance that DID move `main`, i.e. a green).
   *
   * That is this item's own bug one layer up. An infra death is not merely
   * indistinguishable in the ledger — it was invisible in the readout built on
   * it, and read as GREEN: the Git tab's "main-green rate" divides by
   * `advanced + upToDate + notGreen`, so a gate that crashed on EVERY tick
   * displayed 100%. Naming `error` is what makes a crash cost the rate something.
   *
   * `desktop-perf-held` / `migrations-pending` / `release-fixer-skipped-stale`
   * land in `other` deliberately: they are real verdicts, but naming a bucket per
   * status re-creates the drift. `other` being nonzero is the signal to come back
   * and name the ones that earn it — silently dropping them was the defect.
   */
  greenCheckpoint: {
    total: number;
    advanced: number;
    upToDate: number;
    notGreen: number;
    notFastForward: number;
    createFailed: number;
    /** A partial advance (WI-38218) — GREEN: the longest clean prefix promoted `main`. */
    advancedPrefix: number;
    /** The infra-death class: script crash, the 25-min timeout, unparseable JSON. */
    error: number;
    /** `skipped-*` — the tick judged NO code (routine disabled, run-lock contention). */
    skipped: number;
    /** Every other produced status. Keeps the fold total; nonzero means "name me". */
    other: number;
  };
  /**
   * Auto-serve deploys (staging-branch-pipeline-2026-06-06): one row per attempt.
   *
   * EI-18835078701597295: these buckets are TOTAL over the produced status set, for the
   * same reason `greenCheckpoint`'s are (EI-20702428259478130). They were NOT: production
   * has emitted `stale-lock-reclaimed` (deploy-deps.ts `recordStaleLockReclaim`) and
   * `certification-launched` / `certification-failed` (release-actions.ts) for a long time
   * and every one of them landed in NO bucket — so `ok+rolledBack+failed+refused` silently
   * undercounted against `total`, and a reader diffing them saw a gap with no name on it.
   * `coalesced` (this item's new status) would have been the fourth. Any status without a
   * bucket now lands in `other`; `other` being nonzero is the signal to come back and name it.
   */
  deploy: {
    total: number;
    ok: number;
    rolledBack: number;
    failed: number;
    refused: number;
    /** Yielded to a holder of the `release-deploy` single-flight lock (EI-13729). */
    coalesced: number;
    /** A dead holder's leaked lease was reclaimed (EI-18674647773291145). */
    staleLockReclaimed: number;
    /** Every other produced status. Keeps the fold total; nonzero means "name me". */
    other: number;
  };
}

export function emptyWindow(sinceMs: number): PipelineWindowSummary {
  return {
    sinceMs,
    gitSync: { total: 0, synced: 0, nothing: 0, conflict: 0, error: 0 },
    mergeResolver: { total: 0, ok: 0, failed: 0, error: 0 },
    greenCheckpoint: {
      total: 0,
      advanced: 0,
      upToDate: 0,
      notGreen: 0,
      notFastForward: 0,
      createFailed: 0,
      advancedPrefix: 0,
      error: 0,
      skipped: 0,
      other: 0,
    },
    deploy: {
      total: 0,
      ok: 0,
      rolledBack: 0,
      failed: 0,
      refused: 0,
      coalesced: 0,
      staleLockReclaimed: 0,
      other: 0,
    },
  };
}

/**
 * Fold raw `(kind,status,count)` group rows into the typed window summary. Pure —
 * unit-tested without a DB. Unknown statuses still count toward each kind's total.
 */
export function foldPipelineWindow(
  rows: Array<{ kind: string; status: string; n: number | string }>,
  sinceMs: number,
): PipelineWindowSummary {
  const out = emptyWindow(sinceMs);
  for (const r of rows) {
    const n = Number(r.n) || 0;
    if (r.kind === 'git_sync') {
      out.gitSync.total += n;
      if (r.status === 'synced') out.gitSync.synced += n;
      else if (r.status === 'nothing') out.gitSync.nothing += n;
      else if (r.status === 'conflict') out.gitSync.conflict += n;
      else if (r.status === 'error') out.gitSync.error += n;
    } else if (r.kind === 'merge_resolver') {
      out.mergeResolver.total += n;
      if (r.status === 'ok') out.mergeResolver.ok += n;
      else if (r.status === 'failed') out.mergeResolver.failed += n;
      else if (r.status === 'error') out.mergeResolver.error += n;
    } else if (r.kind === 'green_checkpoint') {
      out.greenCheckpoint.total += n;
      if (r.status === 'advanced') out.greenCheckpoint.advanced += n;
      else if (r.status === 'up-to-date') out.greenCheckpoint.upToDate += n;
      else if (r.status === 'not-green') out.greenCheckpoint.notGreen += n;
      else if (r.status === 'not-fast-forward') out.greenCheckpoint.notFastForward += n;
      else if (r.status === 'create-failed') out.greenCheckpoint.createFailed += n;
      // EI-20702428259478130 — see the bucket doc on PipelineWindowSummary. Unlike the
      // other kinds above, this chain is TOTAL: the trailing `other` means a status
      // added later cannot silently vanish from the readout the way `error` and
      // `advanced-prefix` did. `skipped-` is matched by PREFIX on purpose (it covers
      // skipped-disabled + skipped-locked, and any future skip) rather than by
      // enumerating them, because enumeration is what drifted in the first place.
      else if (r.status === 'advanced-prefix') out.greenCheckpoint.advancedPrefix += n;
      else if (r.status === 'error') out.greenCheckpoint.error += n;
      else if (r.status.startsWith('skipped-')) out.greenCheckpoint.skipped += n;
      else out.greenCheckpoint.other += n;
    } else if (r.kind === 'deploy') {
      out.deploy.total += n;
      // EI-18835078701597295: like the greenCheckpoint chain above, this one is TOTAL —
      // the trailing `other` is what keeps it that way as new deploy statuses appear.
      if (r.status === 'ok') out.deploy.ok += n;
      else if (r.status === 'rolled-back') out.deploy.rolledBack += n;
      else if (r.status === 'failed') out.deploy.failed += n;
      else if (r.status === 'refused') out.deploy.refused += n;
      else if (r.status === 'coalesced') out.deploy.coalesced += n;
      else if (r.status === 'stale-lock-reclaimed') out.deploy.staleLockReclaimed += n;
      else out.deploy.other += n;
    }
  }
  return out;
}

/**
 * Count events for `slug` over the trailing `windowSeconds`, grouped into the
 * per-kind summary the Git tab renders. One grouped query; `foldPipelineWindow`
 * does the typing.
 */
export async function summarizePipelineWindow(
  slug: string,
  windowSeconds: number,
  sql?: Sql,
): Promise<PipelineWindowSummary> {
  const sinceMs = Date.now() - windowSeconds * 1000;
  try {
    // Bounded retry on a transient CONNECT_TIMEOUT (WI-2776) — this is a read-only
    // count, so re-issuing it is trivially safe; absorbs the self-healing pooler blip
    // that otherwise logged a hard failure. A sustained outage still hits the catch.
    const rows = await withPgRetry(
      () => db(sql)<{ kind: string; status: string; n: number }[]>`
        SELECT kind, status, count(*)::int AS n
          FROM harness_shared.pipeline_events
         WHERE install_slug = ${slug}
           AND created_at >= now() - make_interval(secs => ${windowSeconds})
         GROUP BY kind, status
      `,
      { label: 'summarizePipelineWindow' },
    );
    return foldPipelineWindow(rows, sinceMs);
  } catch (e) {
    console.warn(`[pipeline-events] summarize failed: ${e instanceof Error ? e.message : e}`);
    return emptyWindow(sinceMs);
  }
}

/**
 * Most-recent events for `slug` (newest first) — the Git tab's timeline.
 *
 * EI-18835078701597295: `opts.kinds` pushes the kind filter into SQL. Without it, a
 * consumer that cares about ONE kind has to over-fetch and filter in memory, and the
 * `LIMIT` then applies to the WRONG population — on a busy pipeline a burst of
 * `git_sync` rows evicts the older `deploy` rows from the window, so a caller looking
 * for a run of consecutive deploys sees a short, truncated one and silently
 * under-reports. Filtering server-side makes the limit mean what the caller meant.
 */
export async function recentPipelineEvents(
  slug: string,
  limit = 25,
  sql?: Sql,
  opts?: { kinds?: PipelineEventKind[] },
): Promise<PipelineEventRow[]> {
  try {
    const kinds = opts?.kinds && opts.kinds.length > 0 ? opts.kinds : null;
    // Bounded retry on a transient CONNECT_TIMEOUT (WI-2776) — read-only, safe to re-issue.
    const rows = await withPgRetry(
      () => db(sql)<{ id: string; kind: string; status: string; detail: unknown; created_at: Date }[]>`
        SELECT id::text, kind, status, detail, created_at
          FROM harness_shared.pipeline_events
         WHERE install_slug = ${slug}
           AND (${kinds}::text[] IS NULL OR kind = ANY(${kinds}::text[]))
         ORDER BY created_at DESC
         LIMIT ${Math.min(Math.max(limit, 1), 200)}
      `,
      { label: 'recentPipelineEvents' },
    );
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind as PipelineEventKind,
      status: r.status,
      detail: normalizeDetail(r.detail),
      createdAtMs: r.created_at instanceof Date ? r.created_at.getTime() : new Date(r.created_at).getTime(),
    }));
  } catch (e) {
    console.warn(`[pipeline-events] recent failed: ${e instanceof Error ? e.message : e}`);
    return [];
  }
}

/** jsonb comes back as an object under the operator client but can arrive as a
 *  string under some client configs (double-encode) — tolerate both. */
function normalizeDetail(v: unknown): Record<string, unknown> {
  if (v && typeof v === 'object') return v as Record<string, unknown>;
  if (typeof v === 'string') {
    try {
      const p = JSON.parse(v);
      return p && typeof p === 'object' ? (p as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return {};
}

/**
 * EI-18676650746298156: prefix-safe candidate-sha match. `buildCheckpointDetail`
 * (release-actions.ts) truncates the full candidate sha to 12 chars before writing
 * `detail.candidate`, and a caller of `checkpoint:await`/this probe may ALSO pass a
 * shorter prefix (as short as 4 chars — same floor as its `candidateSha` arg). Compare
 * only the shorter of the two lengths so either truncation still matches the SAME
 * commit: a full 40-char sha compared against a stored 12-char prefix, or a 4-char
 * caller prefix compared against a longer stored value, both resolve correctly.
 * Below 4 chars neither side means anything — refuse rather than risk a false
 * positive on a coincidental short overlap.
 */
export function candidatePrefixMatches(requested: string, stored: string): boolean {
  if (!requested || !stored) return false;
  const cmpLen = Math.min(requested.length, stored.length);
  if (cmpLen < 4) return false;
  return requested.slice(0, cmpLen) === stored.slice(0, cmpLen);
}

/** One matched `green_checkpoint` verdict row, as {@link findGreenCheckpointVerdictForCandidate}
 *  returns it. `detail.green` is the verdict's OWN green/not-green outcome for the EXACT
 *  candidate matched (not re-derived from `status`, which conflates outcomes like
 *  'advanced-prefix' — a candidate that stayed RED while an EARLIER prefix advanced instead;
 *  `buildCheckpointDetail` already carries the right `green` value for the candidate this
 *  row's `detail.candidate` names, so trust it directly). */
export interface GreenCheckpointVerdictMatch {
  status: string;
  detail: Record<string, unknown>;
  createdAtMs: number;
}

/**
 * EI-18676650746298156: find the newest recorded `green_checkpoint` verdict (any status)
 * whose `detail.candidate` matches `candidateSha` — the exact-match probe
 * `checkpoint:await`'s candidateSha needs so a candidate ALREADY judged before the wait
 * armed doesn't strand the caller for the full timeout (the sibling gap to
 * EI-18676050719521433's `deploy:await` already-deployed latch). Optionally also
 * requires `detail.runId` to match exactly (WI-4957 — only needed when two runs might
 * judge the same candidate).
 *
 * DELIBERATELY EXACT, never ancestry-based (WI-5685): a LATER candidate that happens to
 * contain the requested commit is judged under a DIFFERENT `detail.candidate` value and
 * will not match here — same as it would not fire `checkpoint:await`'s payload-filtered
 * key. Conflating the two would silently reintroduce the WI-5685 race while closing this
 * one; see `checkpoint:await`'s own `candidateSha` arg description for that caveat.
 *
 * `installSlug: null` searches across ALL pipelines at once — the `global:true` case,
 * where `checkpoint:await` arms the unscoped keys. Read-only, bounded (`scanLimit`
 * caps how many recent green_checkpoint rows are scanned — this candidate match is a JS
 * loop over a small window, not a jsonb query, to keep the SQL simple and avoid
 * direction-dependent LIKE patterns), and non-throwing: a query failure returns null,
 * same fail-soft contract as the rest of this module — this probe must never itself
 * become a reason `checkpoint:await` fails to arm.
 */
export async function findGreenCheckpointVerdictForCandidate(
  installSlug: string | null,
  candidateSha: string,
  opts: { runId?: string; sql?: Sql; scanLimit?: number } = {},
): Promise<GreenCheckpointVerdictMatch | null> {
  const scanLimit = Math.min(Math.max(opts.scanLimit ?? 100, 1), 500);
  try {
    const rows = installSlug
      ? await withPgRetry(
          () => db(opts.sql)<{ status: string; detail: unknown; created_at: Date }[]>`
            SELECT status, detail, created_at
              FROM harness_shared.pipeline_events
             WHERE kind = 'green_checkpoint'
               AND install_slug = ${installSlug}
             ORDER BY created_at DESC
             LIMIT ${scanLimit}
          `,
          { label: 'findGreenCheckpointVerdictForCandidate' },
        )
      : await withPgRetry(
          () => db(opts.sql)<{ status: string; detail: unknown; created_at: Date }[]>`
            SELECT status, detail, created_at
              FROM harness_shared.pipeline_events
             WHERE kind = 'green_checkpoint'
             ORDER BY created_at DESC
             LIMIT ${scanLimit}
          `,
          { label: 'findGreenCheckpointVerdictForCandidate' },
        );
    for (const r of rows) {
      const detail = normalizeDetail(r.detail);
      const storedCandidate = typeof detail.candidate === 'string' ? detail.candidate : null;
      if (!storedCandidate || !candidatePrefixMatches(candidateSha, storedCandidate)) continue;
      if (opts.runId && detail.runId !== opts.runId) continue;
      return {
        status: r.status,
        detail,
        createdAtMs: r.created_at instanceof Date ? r.created_at.getTime() : new Date(r.created_at).getTime(),
      };
    }
    return null;
  } catch (e) {
    console.warn(`[pipeline-events] findGreenCheckpointVerdictForCandidate failed: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}
