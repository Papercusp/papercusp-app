/**
 * Interest watches — push-interjection: "wake me when a peer's IN-FLIGHT work
 * matches my standing interest" (get-feedback-relevance-consults-2026-08-16
 * P-008 / WI-39500; table: migration 839).
 *
 * The PUSH half of the consult system. The relevance router (P-002) PULLS
 * experts to a question at ask time; an interest watch PUSHES a peer's
 * in-flight work to a standing interest as it happens. Registration surface:
 * `watch:create { targetKind:'interest' }` — the free-text interest is
 * embedded ONCE there and stored on the row; this sweep then matches NEW
 * `harness_shared.session_turns` rows (peers' transcript turns — the same
 * continuously-embedded index the router reads) against the stored vector by
 * cosine similarity, entirely in SQL. No embedding happens at match time.
 *
 * Above the per-row `sim_floor` (precision-biased default — D-003's spirit: an
 * interjection channel must prefer silence over spam), matches coalesce into
 * ONE `emitAwaitedEvent` on the row's synthetic key `interest:<id>`. That one
 * emit serves BOTH delivery modes for free:
 *   - wake:true  → the paired `event_awaits` row (floors, burst-coalesce, once
 *     semantics, timeout-wake — all the existing wake machinery);
 *   - wake:false → the standing `coord_entity_subscriptions` target_kind
 *     ='event' inject row (emitAwaitedEvent already fans out to event-key
 *     subscribers — WI-4014 Part 2), landing in the inbox at no token cost.
 *
 * WATERMARK vs THE ASYNC EMBED BACKFILL (the correctness subtlety here):
 * `text_embedding` is backfilled asynchronously (embed-backfill.ts) — a turn is
 * ingested now and embedded seconds-to-minutes later, and `ingested_at` is
 * never touched by that UPDATE. A naive "scan rows ingested since last sweep"
 * watermark would therefore SILENTLY SKIP any turn embedded after the sweep
 * passed it — the classic never-fires bug. Instead each sweep scans only the
 * CONTIGUOUSLY-EMBEDDED window (watermark, frontier]:
 *   frontier = min(claimNow - LAG, oldest YOUNG un-embedded candidate - 1ms)
 * i.e. the frontier never passes an un-embedded row until that row either gets
 * its embedding or ages past INTEREST_EMBED_ABANDON_HORIZON_MS (a row the
 * backfill has abandoned that long is invisible to every vector surface — the
 * router included — so skipping it is honest, and bounded). Every candidate
 * turn is thus scanned EXACTLY ONCE, after it is embedded: no duplicate fires,
 * no silent misses; delivery latency = embed-backfill lag + sweep interval,
 * which is fine for an interjection channel.
 *
 * Lifecycle mirrors predicate-watch.ts deliberately: stamp-claim FOR UPDATE
 * SKIP LOCKED (multi-host pollers split the set), 5 consecutive sweep errors
 * deactivate WITH an interestError emit (the waiter wakes instead of
 * dangling), and GC deactivates rows whose key has neither a live await nor a
 * live event-key subscription — so `events:cancel` / `events:unsubscribe`
 * need no coupling to this table.
 *
 * The core is deps-injected (sql / emit / now — relevance-router style) so the
 * integration test drives it against a fixture Postgres with deterministic
 * vectors; `startInterestWatchSweeper` is the prod binding.
 */
import type { Sql } from 'postgres';
import { withIterativeScan } from '@papercusp/search';
import {
  proseProfilePredicateSql,
  resolveProseProfileIdSelection,
  type ProseProfileSelection,
} from '../../search/prose-vector-dims';

/** Cosine floor a peer turn must clear (per-row; this is the default).
 *  Deliberately ABOVE the router's DEFAULT_SIM_FLOOR (0.4): a consult answer is
 *  solicited, an interjection is not — false positives here are spam. */
export const INTEREST_DEFAULT_SIM_FLOOR = 0.55;
/** Registration-time bounds for a caller-supplied floor. */
export const INTEREST_MIN_SIM_FLOOR = 0.3;
export const INTEREST_MAX_SIM_FLOOR = 0.95;
export const INTEREST_DEFAULT_INTERVAL_SEC = 120;
export const INTEREST_SWEEP_TICK_MS = 30_000;
export const INTEREST_SWEEP_BATCH_LIMIT = 10;
/** Matches delivered per watch per sweep (coalesced into one emit). */
export const INTEREST_MATCHES_PER_SWEEP = 5;
export const INTEREST_MAX_CONSECUTIVE_ERRORS = 5;
export const INTEREST_EXCERPT_CHARS = 240;
/** The frontier never advances closer to "now" than this — tolerates ingest
 *  commit skew (rows stamped slightly in the past becoming visible late). */
export const INTEREST_WATERMARK_LAG_MS = 10_000;
/** An un-embedded candidate older than this stops blocking the frontier — the
 *  backfill has abandoned it, and an unembedded turn is invisible to every
 *  vector surface (the router included), so skipping it is honest. */
export const INTEREST_EMBED_ABANDON_HORIZON_MS = 30 * 60_000;

export interface InterestWatchRow {
  id: string;
  workspaceId: string;
  ownerId: string;
  harnessSlug: string | null;
  eventKey: string;
  interest: string;
  /** The stored interest vector in pgvector text form ('[0.1,0.2,…]') — carried
   *  raw so the sweep can pass it back as a parameter (`::vector`) without a
   *  per-sweep sub-select. Null only if the row predates the pgvector leg. */
  embeddingText: string | null;
  /** Exact space carried by `embeddingText`. Null for legacy/unknown rows,
   * which fail closed in the sweeper instead of comparing by width or mode. */
  embeddingProfile: ProseProfileSelection | null;
  simFloor: number;
  intervalSec: number;
  once: boolean;
  watermark: string;
  lastSweptAt: string | null;
  lastMatchCount: number | null;
  fireCount: number;
  lastError: string | null;
  consecutiveErrors: number;
  active: boolean;
  createdAt: string;
}

export interface InterestMatch {
  owner: string;
  session_id: string;
  turn_idx: number;
  ts: string | null;
  sim: number;
  excerpt: string;
}

export interface InterestEmitOpts {
  key: string;
  payload: Record<string, unknown>;
  summary: string;
  source: string;
  workspaceId: string;
}

export interface InterestSweepDeps {
  getSql: () => Sql;
  /** Prod: emitAwaitedEvent. Injected so the fixture test can observe fires. */
  emit: (opts: InterestEmitOpts) => Promise<unknown>;
  now?: () => Date;
}

/* eslint-disable @typescript-eslint/no-explicit-any */

function mapRow(r: any): InterestWatchRow {
  return {
    id: String(r.id),
    workspaceId: r.workspace_id,
    ownerId: r.owner_id,
    harnessSlug: r.harness_slug ?? null,
    eventKey: r.event_key,
    interest: r.interest,
    embeddingText: r.embedding == null ? null : String(r.embedding),
    embeddingProfile: r.embedding_profile == null
      ? null
      : resolveProseProfileIdSelection(String(r.embedding_profile), r.embedding_mode ?? null),
    simFloor: Number(r.sim_floor),
    intervalSec: Number(r.interval_sec),
    once: Boolean(r.once),
    watermark: new Date(r.watermark).toISOString(),
    lastSweptAt: r.last_swept_at ? new Date(r.last_swept_at).toISOString() : null,
    lastMatchCount: r.last_match_count == null ? null : Number(r.last_match_count),
    fireCount: Number(r.fire_count ?? 0),
    lastError: r.last_error ?? null,
    consecutiveErrors: Number(r.consecutive_errors ?? 0),
    active: Boolean(r.active),
    createdAt: new Date(r.created_at).toISOString(),
  };
}

function log(msg: string): void {
  console.error(`[interest-watch] ${msg}`);
}

/* ── Pure helpers (unit-tested) ────────────────────────────────────────────── */

/**
 * The sweep window for one watch: scan turns with ingested_at in (from, to].
 * `blockerMinIngestedAtMs` is the oldest YOUNG un-embedded candidate (already
 * horizon-filtered by the caller's SQL); the frontier stops 1ms before it so
 * the row is scanned on a later sweep, once embedded. Returns null when the
 * window is empty (frontier has not advanced past the watermark).
 */
export function computeSweepWindow(input: {
  watermarkMs: number;
  blockerMinIngestedAtMs: number | null;
  claimNowMs: number;
}): { fromMs: number; toMs: number } | null {
  const cap = input.claimNowMs - INTEREST_WATERMARK_LAG_MS;
  const frontier =
    input.blockerMinIngestedAtMs === null ? cap : Math.min(cap, input.blockerMinIngestedAtMs - 1);
  if (frontier <= input.watermarkMs) return null;
  return { fromMs: input.watermarkMs, toMs: frontier };
}

/** Render the coalesced one-line summary for a fire (bounded — it becomes the
 *  wake turn's headline / the inbox line). */
export function renderInterestSummary(interest: string, matches: InterestMatch[]): string {
  const top = matches[0];
  const trimmed = interest.length > 80 ? `${interest.slice(0, 77)}…` : interest;
  const owners = [...new Set(matches.map((m) => m.owner))];
  return `interest matched: "${trimmed}" — ${matches.length} peer turn(s) from ${owners.length} agent(s), top ${top.owner} sim ${top.sim.toFixed(2)}`;
}

/* ── Store ─────────────────────────────────────────────────────────────────── */

export async function registerInterestWatch(
  sql: Sql,
  input: {
    /** Pre-generated id — the caller registers the delivery target (await row /
     *  event-key subscription) on `interest:<id>` FIRST (GC safety: a row must
     *  never exist without a live delivery target). */
    id: string;
    workspaceId: string;
    ownerId: string;
    harnessSlug?: string | null;
    eventKey: string;
    interest: string;
    embedding: number[];
    embeddingMode: string;
    embeddingProfile: ProseProfileSelection;
    simFloor?: number;
    intervalSec?: number;
    once?: boolean;
    now?: Date;
  },
): Promise<InterestWatchRow> {
  const now = input.now ?? new Date();
  const rows = await sql`
    INSERT INTO harness_shared.interest_watches
      (id, workspace_id, owner_id, harness_slug, event_key, interest, embedding,
       embedding_mode, embedding_profile, sim_floor, interval_sec, once, watermark)
    VALUES
      (${input.id}, ${input.workspaceId}, ${input.ownerId}, ${input.harnessSlug ?? null},
       ${input.eventKey}, ${input.interest}, ${JSON.stringify(input.embedding)}::vector,
       ${input.embeddingMode}, ${input.embeddingProfile.profileId},
       ${input.simFloor ?? INTEREST_DEFAULT_SIM_FLOOR},
       ${input.intervalSec ?? INTEREST_DEFAULT_INTERVAL_SEC}, ${input.once ?? false},
       -- An interest watches the FUTURE: only turns ingested after registration
       -- are candidates (minus the lag guard, so a turn committing right now on
       -- another connection is not skipped).
       ${new Date(now.getTime() - INTEREST_WATERMARK_LAG_MS).toISOString()}::timestamptz)
    RETURNING *
  `;
  return mapRow(rows[0]);
}

/** Claim-by-stamp the due rows (active + past their interval), FOR UPDATE SKIP
 *  LOCKED so concurrent host sweepers split the set instead of double-sweeping. */
export async function claimDueInterestWatches(
  sql: Sql,
  limit = INTEREST_SWEEP_BATCH_LIMIT,
): Promise<InterestWatchRow[]> {
  const rows = await sql`
    UPDATE harness_shared.interest_watches
       SET last_swept_at = now()
     WHERE id IN (
       SELECT id FROM harness_shared.interest_watches
        WHERE active
          AND (last_swept_at IS NULL OR last_swept_at < now() - make_interval(secs => interval_sec))
        ORDER BY last_swept_at ASC NULLS FIRST
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
     )
    RETURNING *
  `;
  return rows.map(mapRow);
}

/**
 * Deactivate rows whose key has NO live delivery target left — neither a live
 * await registration (once-unfired, or standing-unexpired) nor a live event-key
 * inject subscription. Mirrors gcOrphanedPredicateWatches; `events:cancel` /
 * `events:unsubscribe` need no coupling to this table.
 *
 * `coordWorkspaceId` scopes the event_awaits leg (awaits live under the coord
 * workspace); the subscription leg is deliberately unscoped — the subscription
 * store is workspace-RESOLVING and the key is uuid-unique across workspaces.
 */
export async function gcOrphanedInterestWatches(sql: Sql, coordWorkspaceId: string): Promise<number> {
  const rows = await sql`
    UPDATE harness_shared.interest_watches iw
       SET active = false,
           last_error = coalesce(iw.last_error, 'gc: no live await or event-key subscription on the interest key')
     WHERE iw.active
       AND NOT EXISTS (
         SELECT 1 FROM harness_shared.event_awaits ea
          WHERE ea.workspace_id = ${coordWorkspaceId}
            AND ea.event_key = iw.event_key
            AND ea.cancelled_at IS NULL
            AND ((ea.once = true AND ea.fired_at IS NULL)
              OR (ea.once = false AND (ea.expires_ts IS NULL OR ea.expires_ts > now())))
       )
       AND NOT EXISTS (
         SELECT 1 FROM harness_shared.coord_entity_subscriptions s
          WHERE s.target_kind = 'event'
            AND s.target_ref = iw.event_key
            AND s.cancelled_at IS NULL
            AND (s.expires_ts IS NULL OR s.expires_ts > now())
       )
    RETURNING iw.id
  `;
  return rows.length;
}

async function recordSweep(
  sql: Sql,
  id: string,
  input: { watermark: Date; matchCount: number; fired: boolean; deactivate: boolean },
): Promise<void> {
  await sql`
    UPDATE harness_shared.interest_watches
       SET watermark = ${input.watermark.toISOString()}::timestamptz,
           last_match_count = ${input.matchCount},
           fire_count = fire_count + ${input.fired ? 1 : 0},
           last_error = NULL,
           consecutive_errors = 0,
           active = active AND NOT ${input.deactivate}
     WHERE id = ${id}
  `;
}

async function recordSweepError(sql: Sql, id: string, message: string, deactivate: boolean): Promise<void> {
  await sql`
    UPDATE harness_shared.interest_watches
       SET last_error = ${message.slice(0, 2000)},
           consecutive_errors = consecutive_errors + 1,
           active = active AND NOT ${deactivate}
     WHERE id = ${id}
  `;
}

/* ── Sweep ─────────────────────────────────────────────────────────────────── */

export interface InterestSweepResult {
  fired: boolean;
  matchCount: number;
  /** Window scanned, null when the frontier had not advanced. */
  window: { fromMs: number; toMs: number } | null;
  error?: string;
  deactivated: boolean;
}

/**
 * One sweep of one watch: frontier probe → bounded cosine scan of the embedded
 * window → coalesced emit above the floor → watermark advance. The candidate
 * predicate mirrors the relevance router's corpus scope EXACTLY (workspace OR
 * 'default'; owner set; machine-surface excluded, NULL verdict passes) — the
 * push half reads the same corpus the pull half routes over.
 */
export async function sweepInterestWatch(
  row: InterestWatchRow,
  deps: InterestSweepDeps,
): Promise<InterestSweepResult> {
  const sql = deps.getSql();
  const now = deps.now ? deps.now() : new Date();
  try {
    // 1) Frontier probe: the oldest YOUNG un-embedded candidate blocks the
    //    frontier (it will be scanned once embedded); older ones age out.
    const horizon = new Date(now.getTime() - INTEREST_EMBED_ABANDON_HORIZON_MS);
    const blockerRows = (await sql`
      SELECT min(ingested_at) AS m
        FROM harness_shared.session_turns
       WHERE (workspace_id = ${row.workspaceId} OR workspace_id = 'default')
         AND ingested_at > ${row.watermark}::timestamptz
         AND ingested_at > ${horizon.toISOString()}::timestamptz
         AND text_embedding IS NULL
         AND owner IS NOT NULL
         AND owner <> ${row.ownerId}
    `) as unknown as Array<{ m: string | Date | null }>;
    const blockerMin = blockerRows[0]?.m ? new Date(blockerRows[0].m as string).getTime() : null;

    const window = computeSweepWindow({
      watermarkMs: new Date(row.watermark).getTime(),
      blockerMinIngestedAtMs: blockerMin,
      claimNowMs: now.getTime(),
    });
    if (!window) {
      await recordSweep(sql, row.id, {
        watermark: new Date(row.watermark),
        matchCount: 0,
        fired: false,
        deactivate: false,
      });
      return { fired: false, matchCount: 0, window: null, deactivated: false };
    }

    // 2) Bounded cosine scan of the embedded window. withIterativeScan: without
    //    it a filtered HNSW scan stops at ef_search and silently under-returns
    //    (WI-37603) — same guard the router uses.
    const from = new Date(window.fromMs).toISOString();
    const to = new Date(window.toMs).toISOString();
    if (!row.embeddingText || !row.embeddingProfile) {
      throw new Error('interest watch row has no exact stored embedding profile — cannot match');
    }
    const qVec = row.embeddingText;
    const matches = (await withIterativeScan(sql as never, (s) => (s as unknown as Sql)`
      SELECT owner, session_id, turn_idx,
             COALESCE(ts, ingested_at) AS ts,
             1 - (text_embedding <=> ${qVec}::vector) AS sim,
             left(text, ${INTEREST_EXCERPT_CHARS}) AS excerpt
        FROM harness_shared.session_turns
       WHERE (workspace_id = ${row.workspaceId} OR workspace_id = 'default')
         AND ingested_at > ${from}::timestamptz
         AND ingested_at <= ${to}::timestamptz
         AND text_embedding IS NOT NULL
         AND ${proseProfilePredicateSql(s as unknown as Sql, row.embeddingProfile, 'text_embedding_profile', 'text_embedding_mode')}
         AND owner IS NOT NULL
         AND owner <> ${row.ownerId}
         AND (turn_origin_verdict IS NULL OR turn_origin_verdict <> 'machine-surface')
         AND 1 - (text_embedding <=> ${qVec}::vector) >= ${row.simFloor}
    ORDER BY sim DESC
       LIMIT ${INTEREST_MATCHES_PER_SWEEP}
    `)) as unknown as Array<{
      owner: string;
      session_id: string;
      turn_idx: number;
      ts: string | Date | null;
      sim: number;
      excerpt: string;
    }>;

    const interestMatches: InterestMatch[] = matches.map((m) => ({
      owner: m.owner,
      session_id: m.session_id,
      turn_idx: m.turn_idx,
      ts: m.ts ? new Date(m.ts as string).toISOString() : null,
      sim: Number(m.sim),
      excerpt: m.excerpt,
    }));

    const fired = interestMatches.length > 0;
    if (fired) {
      await deps.emit({
        key: row.eventKey,
        payload: {
          interest: row.interest,
          watch_id: row.id,
          sim_floor: row.simFloor,
          matches: interestMatches,
        },
        summary: renderInterestSummary(row.interest, interestMatches),
        source: `interest-watch:${row.ownerId}`,
        workspaceId: row.workspaceId,
      });
    }
    const deactivate = fired && row.once;
    await recordSweep(sql, row.id, {
      watermark: new Date(window.toMs),
      matchCount: interestMatches.length,
      fired,
      deactivate,
    });
    return { fired, matchCount: interestMatches.length, window, deactivated: deactivate };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const deactivate = row.consecutiveErrors + 1 >= INTEREST_MAX_CONSECUTIVE_ERRORS;
    await recordSweepError(sql, row.id, msg, deactivate);
    if (deactivate) {
      // The waiter must wake, not dangle — fire the key with an error payload.
      await deps
        .emit({
          key: row.eventKey,
          payload: { interestError: msg.slice(0, 500), interest: row.interest, watch_id: row.id },
          summary: `interest watch DEACTIVATED after ${row.consecutiveErrors + 1} consecutive errors: ${msg.slice(0, 200)}`,
          source: `interest-watch:${row.ownerId}`,
          workspaceId: row.workspaceId,
        })
        .catch((e) => log(`error-emit failed for ${row.eventKey}: ${e instanceof Error ? e.message : e}`));
    }
    return { fired: deactivate, matchCount: 0, window: null, error: msg, deactivated: deactivate };
  }
}

/** One sweeper tick: GC orphans, claim the due batch, sweep serially (the batch
 *  is capped and each sweep is two bounded reads + one write — bounded work). */
export async function pollDueInterestWatches(
  deps: InterestSweepDeps,
  coordWorkspaceId: string,
): Promise<{ swept: number; fired: number; gc: number }> {
  const sql = deps.getSql();
  const gc = await gcOrphanedInterestWatches(sql, coordWorkspaceId);
  const due = await claimDueInterestWatches(sql);
  let fired = 0;
  for (const row of due) {
    const r = await sweepInterestWatch(row, deps);
    if (r.fired) fired++;
  }
  return { swept: due.length, fired, gc };
}

/* ── Prod binding ──────────────────────────────────────────────────────────── */

type Globals = typeof globalThis & { __papercuspInterestWatchSweeperStarted?: boolean };

/** Idempotent lazy start (mirrors startPredicateWatchPoller) — called at
 *  registration and from the agent-tools boot path so active rows survive a
 *  host restart. Deps are imported lazily so this module stays import-cheap. */
export function startInterestWatchSweeper(): void {
  const g = globalThis as Globals;
  if (g.__papercuspInterestWatchSweeperStarted) return;
  g.__papercuspInterestWatchSweeperStarted = true;
  void (async () => {
    const [{ managedSetInterval }, { getOrgPg }, { DEFAULT_COORD_WORKSPACE }, { emitAwaitedEvent }] =
      await Promise.all([
        import('@papercusp/scheduled-registry'),
        import('@papercusp/db-org'),
        import('@papercusp/coordination/event-log'),
        import('./engine'),
      ]);
    const deps: InterestSweepDeps = {
      getSql: () => getOrgPg().sql,
      emit: (opts) =>
        emitAwaitedEvent({
          key: opts.key,
          payload: opts.payload,
          summary: opts.summary,
          source: opts.source,
          workspaceId: opts.workspaceId,
        }),
    };
    managedSetInterval(
      'interest-watch-sweeper',
      INTEREST_SWEEP_TICK_MS,
      () => {
        void pollDueInterestWatches(deps, DEFAULT_COORD_WORKSPACE).catch((e) =>
          log(`sweep tick failed: ${e instanceof Error ? e.message : e}`),
        );
      },
      // D-004 must-sample: the trigger is a session_turn becoming EMBEDDED, and
      // nothing emits a change event when text_embedding lands — so the frontier
      // this sweep advances can only be observed by sampling for it.
      { category: 'global-sweep', classification: 'must-sample' },
    );
  })().catch((e) => {
    (globalThis as Globals).__papercuspInterestWatchSweeperStarted = false;
    log(`sweeper start failed: ${e instanceof Error ? e.message : e}`);
  });
}
