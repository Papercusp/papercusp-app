/**
 * session-search-index-build.ts — the deferred, online build of the session transcript
 * search indexes + term vocabulary (plan session-transcript-exact-fuzzy-search-2026-09-14
 * P-002; design authority: plan D-003 / D-004 / D-005).
 *
 * WHY THIS IS NOT A MIGRATION
 * ---------------------------
 * Measured on a 1,355,857-row copy of harness_shared.session_turns (D-004): the exact-tier
 * trigram GIN is 744 MB / 358.5 s to build, the vocabulary's first full ts_stat build is
 * 351.9 s. The migration runner wraps every file in ONE transaction, so
 * CREATE INDEX CONCURRENTLY is illegal there, and a plain CREATE INDEX would hold a
 * write-blocking lock on the live transcript table for six minutes. Migration 1273
 * therefore creates the two small tables (and the indexes only on a small/fresh table);
 * THIS module builds everything else online from a durable scheduled workflow
 * (lib/dbos/periodic-workflows.ts → sessionSearchIndexBuild), mirroring the shape of
 * db-index-bloat-reindex.ts:
 *   - CREATE INDEX CONCURRENTLY IF NOT EXISTS, autocommit via sql.unsafe (never inside a
 *     transaction block);
 *   - skips under a long-open transaction (CONCURRENTLY would merely park behind it) and
 *     when disk headroom is short (the GIN needs room for itself + WAL);
 *   - an INTERRUPTED concurrent build leaves an INVALID index under the final name that
 *     `CREATE INDEX IF NOT EXISTS` would silently keep forever (present, maintained on
 *     every write, never used) — so invalid leftovers with no live build behind them are
 *     dropped before each attempt;
 *   - never throws for a per-step failure: the failure is recorded on its entry and the
 *     run continues, so one bad step cannot strand the rest.
 *
 * WHAT THE READ PATH MAY RELY ON (D-005 rule 3)
 * ---------------------------------------------
 * `readSessionSearchReadiness` + `sessionSearchTierAvailability` answer, from catalog truth
 * (pg_index.indisvalid/indisready) and the per-workspace vocabulary state row, whether the
 * exact tier and the fuzzy tier can run RIGHT NOW. A tier that cannot is reported as skipped
 * with a reason — it must never fall back to a sequential scan (that is the >15 s
 * whole-corpus scan D-003 forbids).
 *
 * VOCABULARY SEMANTICS
 * --------------------
 * One row per (workspace_id, word) for tokens of length 4-40 produced by
 * to_tsvector('simple', lower(text)); `ndoc` is the number of turns containing the word. A full
 * build is exact; an incremental refresh adds the newly ingested rows' counts, so a re-ingested
 * turn can over-count — `ndoc` only orders equally-similar neighbours and is reset by the
 * periodic full rebuild (which also removes words whose last turn retention deleted).
 *
 * Server-only.
 */
import type postgres from 'postgres';

export const SESSION_TURNS_TABLE = 'harness_shared.session_turns';
export const SESSION_TURN_VOCAB_TABLE = 'harness_shared.session_turn_vocab';
export const SESSION_TURN_VOCAB_STATE_TABLE = 'harness_shared.session_turn_vocab_state';
export const SESSION_TURN_WINDOWS_TABLE = 'harness_shared.session_turn_windows';
export const SESSION_TURN_WINDOWS_STATE_TABLE = 'harness_shared.session_turn_windows_state';

/**
 * The window cut behind the bounded-latency exact tier (P-011, migration 1334): overlapping
 * `LEN`-char windows of lower(text) every `STRIDE` chars. Every substring of up to OVERLAP+1 chars
 * lies wholly inside one window, so a window-level LIKE is recall-complete for such a literal.
 * Mirrored by migration 1334's session_turn_windows_of() and pinned equal by its integration test.
 */
export const SESSION_TURN_WINDOW_LEN = 512;
export const SESSION_TURN_WINDOW_STRIDE = 448;
export const SESSION_TURN_WINDOW_OVERLAP = SESSION_TURN_WINDOW_LEN - SESSION_TURN_WINDOW_STRIDE;
/** Longest literal the windows route can look up whole; a longer one is filtered by this prefix. */
export const SESSION_TURN_WINDOW_MAX_LITERAL = SESSION_TURN_WINDOW_OVERLAP + 1;

/**
 * The exact-tier expression. The read path's predicate must contain this text byte-for-byte
 * (`lower(text) LIKE '%…%'`) or PostgreSQL cannot match it to the index.
 */
export const SESSION_TURN_TRGM_EXPR = 'lower(text)';

/** Vocabulary token length window (D-004: shorter tokens are not expanded, longer are noise). */
export const SESSION_TURN_VOCAB_MIN_WORD_LEN = 4;
export const SESSION_TURN_VOCAB_MAX_WORD_LEN = 40;

export type SessionSearchIndexStage = 'corpus' | 'windows' | 'vocab';

export interface SessionSearchIndexSpec {
  name: string;
  table: string;
  /** Everything after `ON <table>`. */
  definition: string;
  /** `corpus` indexes build first; `vocab` indexes build after the vocabulary is loaded. */
  stage: SessionSearchIndexStage;
}

/** Names + definitions are mirrored by migration 1273's size-guarded inline block. */
export const SESSION_SEARCH_INDEXES = [
  {
    name: 'session_turns_text_trgm_idx',
    table: SESSION_TURNS_TABLE,
    definition: `USING gin (${SESSION_TURN_TRGM_EXPR} gin_trgm_ops)`,
    stage: 'corpus',
  },
  {
    name: 'session_turns_ts_desc_idx',
    table: SESSION_TURNS_TABLE,
    definition: '(ts DESC NULLS LAST)',
    stage: 'corpus',
  },
  {
    // P-011: built only AFTER the windows backfill completes (stage 'windows'), never with the corpus
    // indexes — a GIN over a half-filled table would be 'valid' yet recall-incomplete.
    name: 'session_turn_windows_wtext_trgm_idx',
    table: SESSION_TURN_WINDOWS_TABLE,
    definition: 'USING gin (wtext gin_trgm_ops)',
    stage: 'windows',
  },
  {
    name: 'session_turn_vocab_word_trgm_idx',
    table: SESSION_TURN_VOCAB_TABLE,
    definition: 'USING gin (word gin_trgm_ops)',
    stage: 'vocab',
  },
] as const satisfies readonly SessionSearchIndexSpec[];

export type SessionSearchIndexName = (typeof SESSION_SEARCH_INDEXES)[number]['name'];

export function createIndexConcurrentlySql(spec: SessionSearchIndexSpec): string {
  return `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${spec.name} ON ${spec.table} ${spec.definition}`;
}

// ─────────────────────────────── readiness (read path) ───────────────────────────────

export type IndexReadiness = 'ready' | 'absent' | 'invalid';
export type VocabStatus = 'absent' | 'building' | 'ready' | 'failed';
/**
 * What the read path sees for one workspace: the persisted status, or `empty` — a DERIVED verdict
 * (never written to the state table) meaning the workspace has NO state row AND NO transcript rows.
 * The build only iterates workspaces that have rows, so such a workspace can never acquire a state
 * row; reading it as `absent` would leave the fuzzy tier skipped forever for it (and the fuzzy tier
 * always asks for the host-global 'default' workspace too, which a fresh install may not populate).
 * "Nothing to build" is not "not ready": an empty vocabulary expands to nothing, which is correct.
 */
export type VocabReadiness = VocabStatus | 'empty';

/** Persisted windows backfill status (`session_turn_windows_state`); `absent` also covers 'table not migrated yet'. */
export type WindowsReadiness = VocabStatus;

export interface SessionSearchReadiness {
  indexes: Record<SessionSearchIndexName, IndexReadiness>;
  /**
   * P-011 windows backfill status. The windows exact route needs this `ready` AND
   * `indexes.session_turn_windows_wtext_trgm_idx` `ready`; anything less keeps the legacy route.
   */
  windows: WindowsReadiness;
  /** workspace_id → vocabulary readiness (a workspace with no state row but transcript rows is `absent`). */
  vocab: Record<string, VocabReadiness>;
}

export interface TierAvailability {
  available: boolean;
  /** Present when `available` is false: why the tier must be skipped (for the policy receipt). */
  skipReason?: string;
  /** Exact tier only, when available: which index route serves it (P-011). */
  route?: 'windows' | 'legacy';
}

export interface SessionSearchTierAvailability {
  /** lower(text) LIKE tier — needs the trigram GIN. */
  exact: TierAvailability;
  /** Vocabulary-expansion tier — needs the vocabulary, its trigram GIN, AND the exact tier. */
  fuzzy: TierAvailability;
}

/** Catalog-truth readiness of the indexes and the requested workspaces' vocabularies. */
export async function readSessionSearchReadiness(
  sql: postgres.Sql,
  workspaceIds: readonly string[],
): Promise<SessionSearchReadiness> {
  const names = SESSION_SEARCH_INDEXES.map((i) => i.name);
  const rows = await sql<Array<{ name: string; valid: boolean; ready: boolean }>>`
    SELECT c.relname AS name, i.indisvalid AS valid, i.indisready AS ready
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'harness_shared'
       AND c.relname = ANY(${names as unknown as string[]})
  `;
  const indexes = Object.fromEntries(names.map((n) => [n, 'absent' as IndexReadiness])) as Record<
    SessionSearchIndexName,
    IndexReadiness
  >;
  for (const r of rows) {
    indexes[r.name as SessionSearchIndexName] = r.valid && r.ready ? 'ready' : 'invalid';
  }

  const vocab: Record<string, VocabReadiness> = Object.fromEntries(
    workspaceIds.map((w) => [w, 'absent' as VocabReadiness]),
  );
  if (workspaceIds.length > 0) {
    const states = await sql<Array<{ workspace_id: string; status: VocabStatus }>>`
      SELECT workspace_id, status
        FROM harness_shared.session_turn_vocab_state
       WHERE workspace_id = ANY(${workspaceIds as unknown as string[]})
    `;
    for (const s of states) vocab[s.workspace_id] = s.status;

    // A workspace with no state row is `absent` only if it has transcript rows the build still owes a
    // vocabulary for; with none, there is nothing to build and the build will never create a row.
    // The primary key leads with workspace_id, so each EXISTS is a single index probe.
    const stateless = workspaceIds.filter((w) => vocab[w] === 'absent');
    if (stateless.length > 0) {
      const empty = await sql<Array<{ workspace_id: string }>>`
        SELECT w AS workspace_id
          FROM unnest(${stateless as unknown as string[]}::text[]) AS w
         WHERE NOT EXISTS (
           SELECT 1 FROM harness_shared.session_turns t WHERE t.workspace_id = w
         )
      `;
      for (const e of empty) vocab[e.workspace_id] = 'empty';
    }
  }
  // The state table exists only once migration 1334 has reached this database. It is probed FIRST and read
  // in a SEPARATE statement: a `CASE WHEN to_regclass(..) IS NULL THEN NULL ELSE (SELECT .. FROM <table>)`
  // single statement still fails with `relation does not exist` at parse time when the table is missing,
  // which would make the whole readiness read throw and skip BOTH tiers (D-005 wants degrade, not outage).
  let windows: WindowsReadiness = 'absent';
  const [wpresent] = await sql<Array<{ present: boolean }>>`
    SELECT to_regclass(${SESSION_TURN_WINDOWS_STATE_TABLE}) IS NOT NULL AS present
  `;
  if (wpresent?.present) {
    const [wstate] = await sql<Array<{ status: WindowsReadiness }>>`
      SELECT status FROM harness_shared.session_turn_windows_state WHERE scope = 'all'
    `;
    windows = wstate?.status ?? 'absent';
  }
  return { indexes, vocab, windows };
}

/**
 * Pure: which tiers may run given a readiness snapshot. `workspaceIds` are the workspaces the
 * search will read vocabulary for (the requested workspace and, per the session_turns
 * convention, 'default').
 */
export function sessionSearchTierAvailability(
  readiness: SessionSearchReadiness,
  workspaceIds: readonly string[],
): SessionSearchTierAvailability {
  const trgm = readiness.indexes.session_turns_text_trgm_idx;
  const windowsIdx = readiness.indexes.session_turn_windows_wtext_trgm_idx;
  // P-011: the bounded-latency windows route outranks the legacy whole-turn trigram route whenever it
  // is fully built (backfill complete + GIN valid); either route alone keeps the exact tier available.
  const windowsReady = readiness.windows === 'ready' && windowsIdx === 'ready';
  const exact: TierAvailability = windowsReady
    ? { available: true, route: 'windows' }
    : trgm === 'ready'
      ? { available: true, route: 'legacy' }
      : { available: false, skipReason: `exact-index-${trgm}` };

  let fuzzy: TierAvailability;
  // The fuzzy tier's LIKE ANY variants still ride the legacy whole-turn trigram index.
  if (trgm !== 'ready') {
    fuzzy = { available: false, skipReason: `exact-index-${trgm}` };
  } else if (readiness.indexes.session_turn_vocab_word_trgm_idx !== 'ready') {
    fuzzy = {
      available: false,
      skipReason: `vocab-index-${readiness.indexes.session_turn_vocab_word_trgm_idx}`,
    };
  } else {
    const notReady = workspaceIds.filter((w) => {
      const v = readiness.vocab[w] ?? 'absent';
      return v !== 'ready' && v !== 'empty';
    });
    fuzzy =
      notReady.length === 0
        ? { available: true }
        : {
            available: false,
            skipReason: `vocab-${notReady.map((w) => `${w}:${readiness.vocab[w] ?? 'absent'}`).join(',')}`,
          };
  }
  return { exact, fuzzy };
}

// ───────────────────────────────── the deferred build ─────────────────────────────────

export interface SessionSearchIndexBuildOpts {
  /** Wall-clock budget checked BETWEEN steps (a step itself is not interruptible). Default 45 min. */
  timeBudgetMs?: number;
  /** Refuse to run when a transaction has been open longer than this. Default 60 s. */
  maxOpenTxnSeconds?: number;
  /** Refuse to run below this much free disk on the data directory. Default 4 GiB. */
  minFreeDiskBytes?: number;
  /** Rebuild a vocabulary from scratch once its last full build is older than this. Default 7 d. */
  vocabFullRebuildAfterMs?: number;
  /** A vocabulary build whose lease is older than this is presumed dead and reclaimed. Default 60 min. */
  vocabLeaseStaleMs?: number;
  /** Report what would be done without touching anything. */
  dryRun?: boolean;
}

const DEFAULTS = {
  timeBudgetMs: 45 * 60_000,
  maxOpenTxnSeconds: 60,
  minFreeDiskBytes: 4 * 1024 * 1024 * 1024,
  vocabFullRebuildAfterMs: 7 * 24 * 3600_000,
  vocabLeaseStaleMs: 60 * 60_000,
};

export interface IndexBuildEntry {
  name: string;
  action: 'built' | 'present' | 'would-build' | 'failed' | 'deferred-budget' | 'in-flight';
  elapsedMs: number;
  /** Windows backfill only: turns written to session_turn_windows this pass. */
  turns?: number;
  error?: string;
}

export interface VocabBuildEntry {
  workspaceId: string;
  action: 'full' | 'incremental' | 'current' | 'in-flight' | 'would-build' | 'failed' | 'deferred-budget';
  words?: number;
  elapsedMs: number;
  error?: string;
}

export interface SessionSearchIndexBuildResult {
  skipped?: 'tables-missing' | 'long-running-transaction' | 'low-disk';
  /** Invalid leftovers (interrupted CONCURRENTLY builds) dropped this run. */
  invalidDropped: string[];
  indexes: IndexBuildEntry[];
  vocab: VocabBuildEntry[];
  /** True when the time budget cut the run short. */
  truncated: boolean;
}

interface VocabStateRow {
  status: VocabStatus;
  /**
   * Read as TEXT (`watermark_ingested_at::text`), never as a JS Date: session_turns.ingested_at has
   * microsecond precision and a Date truncates to milliseconds, which would leave rows whose
   * sub-millisecond part sorts above the truncated bound out of a full build and re-count them in
   * the next incremental (the watermark would never read "current").
   *
   * ⚠ And it must go BACK to the server as `${x}::text::timestamptz`, never `${x}::timestamptz`:
   * postgres.js serializes a parameter the server types as timestamptz through `new Date(x)`, which
   * truncates a text value to milliseconds exactly as a Date would. Casting through `::text` keeps the
   * parameter text-typed so the conversion happens server-side at full precision.
   */
  watermark_ingested_at: string | null;
  last_full_build_at: string | Date | null;
  build_started_at: string | Date | null;
  build_finished_at: string | Date | null;
}

const toMs = (v: string | Date | null | undefined): number | null =>
  v == null ? null : new Date(v).getTime();

/**
 * Run one build pass: clean invalid leftovers, build missing corpus indexes, build/refresh each
 * workspace's vocabulary, then build the vocabulary's own trigram index. Idempotent — every step
 * is a no-op when its target is already current, so the scheduled workflow can fire it on a short
 * cadence and a crashed pass is simply resumed by the next one.
 */
export async function runSessionSearchIndexBuildOnce(
  sql: postgres.Sql,
  opts: SessionSearchIndexBuildOpts = {},
): Promise<SessionSearchIndexBuildResult> {
  const o = { ...DEFAULTS, ...opts };
  const result: SessionSearchIndexBuildResult = {
    invalidDropped: [],
    indexes: [],
    vocab: [],
    truncated: false,
  };
  const deadline = Date.now() + o.timeBudgetMs;
  const overBudget = () => Date.now() > deadline;

  // --- Guard 0: the migration may not have reached this database yet. ---
  const [present] = await sql<Array<{ turns: string | null; vocab: string | null; state: string | null }>>`
    SELECT to_regclass(${SESSION_TURNS_TABLE})::text AS turns,
           to_regclass(${SESSION_TURN_VOCAB_TABLE})::text AS vocab,
           to_regclass(${SESSION_TURN_VOCAB_STATE_TABLE})::text AS state
  `;
  if (!present?.turns || !present.vocab || !present.state) {
    result.skipped = 'tables-missing';
    return result;
  }

  // --- Guard 1: CONCURRENTLY waits on old snapshots; a long txn would just park the build. ---
  const [{ max_open_seconds: maxOpen } = { max_open_seconds: 0 }] = await sql<
    Array<{ max_open_seconds: number }>
  >`
    SELECT COALESCE(EXTRACT(EPOCH FROM max(now() - xact_start)), 0)::float8 AS max_open_seconds
      FROM pg_stat_activity
     WHERE xact_start IS NOT NULL
       AND backend_type = 'client backend'
       AND pid <> pg_backend_pid()
  `;
  if (Number(maxOpen) > o.maxOpenTxnSeconds) {
    result.skipped = 'long-running-transaction';
    return result;
  }

  // --- Guard 2: a concurrent GIN build needs room for the index and its WAL. ---
  // A probe failure is non-fatal: we would rather build than skip on an unreadable stat.
  try {
    const [{ data_directory: dataDir } = { data_directory: '' }] = await sql<
      Array<{ data_directory: string }>
    >`SELECT setting AS data_directory FROM pg_settings WHERE name = 'data_directory'`;
    if (dataDir) {
      const { statfs } = await import('node:fs/promises');
      const st = await statfs(dataDir);
      if (Number(st.bavail) * Number(st.bsize) < o.minFreeDiskBytes) {
        result.skipped = 'low-disk';
        return result;
      }
    }
  } catch {
    // unreadable data_directory / statfs unsupported — fall through and build.
  }

  const names = SESSION_SEARCH_INDEXES.map((i) => i.name) as string[];

  // --- Drop invalid leftovers that have NO live build behind them. An in-flight concurrent build
  // also shows indisvalid=false, so exclude indexes that pg_stat_progress_create_index reports. ---
  const invalid = await sql<Array<{ name: string }>>`
    SELECT c.relname AS name
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'harness_shared'
       AND c.relname = ANY(${names})
       AND (NOT i.indisvalid OR NOT i.indisready)
       AND NOT EXISTS (
         SELECT 1 FROM pg_stat_progress_create_index p WHERE p.index_relid = c.oid
       )
  `;
  for (const row of invalid) {
    if (o.dryRun) {
      result.invalidDropped.push(row.name);
      continue;
    }
    try {
      await sql.unsafe(`DROP INDEX CONCURRENTLY IF EXISTS harness_shared.${row.name}`);
      result.invalidDropped.push(row.name);
    } catch {
      // A leftover we cannot drop is retried next pass; it must not fail this one.
    }
  }

  const ensureIndexes = async (stage: SessionSearchIndexStage): Promise<void> => {
    for (const spec of SESSION_SEARCH_INDEXES.filter((i) => i.stage === stage)) {
      const started = Date.now();
      const [have] = await sql<Array<{ valid: boolean }>>`
        SELECT i.indisvalid AS valid
          FROM pg_index i
          JOIN pg_class c ON c.oid = i.indexrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'harness_shared' AND c.relname = ${spec.name}
      `;
      if (have?.valid) {
        result.indexes.push({ name: spec.name, action: 'present', elapsedMs: 0 });
        continue;
      }
      if (overBudget()) {
        result.truncated = true;
        result.indexes.push({ name: spec.name, action: 'deferred-budget', elapsedMs: 0 });
        continue;
      }
      if (o.dryRun) {
        result.indexes.push({ name: spec.name, action: 'would-build', elapsedMs: 0 });
        continue;
      }
      try {
        // CONCURRENTLY cannot run inside a transaction block — sql.unsafe() on the pooled
        // connection issues it autocommit, which is what we want.
        await sql.unsafe(createIndexConcurrentlySql(spec));
        result.indexes.push({ name: spec.name, action: 'built', elapsedMs: Date.now() - started });
      } catch (err) {
        result.indexes.push({
          name: spec.name,
          action: 'failed',
          elapsedMs: Date.now() - started,
          error: (err as Error).message,
        });
      }
    }
  };

  await ensureIndexes('corpus');
  await refreshWindows(sql, o, result, overBudget, () => ensureIndexes('windows'));
  await refreshVocabularies(sql, o, result, overBudget);
  await ensureIndexes('vocab');
  return result;
}

const WINDOWS_BACKFILL_ENTRY = 'session_turn_windows_backfill';
const WINDOWS_INDEX_NAME = 'session_turn_windows_wtext_trgm_idx';
/** Turns per backfill batch: ~2000 x <=8000 chars => ~35k windows, a second or two of INSERT. */
export const SESSION_TURN_WINDOWS_BACKFILL_BATCH_TURNS = 2000;
/** A backfill lease (state.heartbeat_at, refreshed every batch) older than this is presumed dead. */
const WINDOWS_LEASE_STALE_SEC = 600;

interface WindowsKey {
  workspace_id: string | null;
  source_kind: string | null;
  session_id: string | null;
  turn_idx: number | null;
}

/**
 * P-011: fill `session_turn_windows` for every pre-existing turn (keyset batches resumed from the
 * state cursor; new/updated turns are kept current by the migration's trigger), then build the
 * wtext trigram GIN CONCURRENTLY and only THEN flip the state to `ready`. Until `ready` the read path
 * keeps the legacy whole-turn route, so a half-filled table is never consulted (D-005).
 * Skips silently when migration 1334 has not reached this database.
 */
async function refreshWindows(
  sql: postgres.Sql,
  o: typeof DEFAULTS & SessionSearchIndexBuildOpts,
  result: SessionSearchIndexBuildResult,
  overBudget: () => boolean,
  ensureWindowsIndex: () => Promise<void>,
): Promise<void> {
  const [present] = await sql<Array<{ t: string | null; s: string | null }>>`
    SELECT to_regclass(${SESSION_TURN_WINDOWS_TABLE})::text AS t,
           to_regclass(${SESSION_TURN_WINDOWS_STATE_TABLE})::text AS s
  `;
  if (!present?.t || !present.s) return;

  if (!o.dryRun) {
    await sql`INSERT INTO harness_shared.session_turn_windows_state (scope) VALUES ('all') ON CONFLICT (scope) DO NOTHING`;
  }
  const [state] = await sql<Array<{ status: WindowsReadiness }>>`
    SELECT status FROM harness_shared.session_turn_windows_state WHERE scope = 'all'
  `;
  let complete = state?.status === 'ready';

  if (!complete) {
    const started = Date.now();
    if (o.dryRun) {
      result.indexes.push({ name: WINDOWS_BACKFILL_ENTRY, action: 'would-build', elapsedMs: 0 });
      return;
    }
    if (overBudget()) {
      result.truncated = true;
      result.indexes.push({ name: WINDOWS_BACKFILL_ENTRY, action: 'deferred-budget', elapsedMs: 0 });
      return;
    }
    const claimed = await sql<Array<{ ws: string | null; sk: string | null; sid: string | null; idx: number | null }>>`
      UPDATE harness_shared.session_turn_windows_state
         SET status = 'building', heartbeat_at = now(), build_started_at = COALESCE(build_started_at, now()),
             last_error = NULL, updated_at = now()
       WHERE scope = 'all' AND status <> 'ready'
         AND (heartbeat_at IS NULL OR heartbeat_at < now() - make_interval(secs => ${WINDOWS_LEASE_STALE_SEC}::int))
      RETURNING cursor_workspace_id AS ws, cursor_source_kind AS sk, cursor_session_id AS sid, cursor_turn_idx AS idx
    `;
    if (claimed.length === 0) {
      result.indexes.push({ name: WINDOWS_BACKFILL_ENTRY, action: 'in-flight', elapsedMs: 0 });
      return;
    }
    let cursor: WindowsKey = {
      workspace_id: claimed[0]!.ws,
      source_kind: claimed[0]!.sk,
      session_id: claimed[0]!.sid,
      turn_idx: claimed[0]!.idx,
    };
    let turns = 0;
    try {
      for (;;) {
        if (overBudget()) {
          result.truncated = true;
          break;
        }
        const [r] = await sql<Array<{ turns: number; last: WindowsKey | null }>>`
          WITH batch AS MATERIALIZED (
            SELECT workspace_id, source_kind, session_id, turn_idx, text
              FROM harness_shared.session_turns
             WHERE ${cursor.workspace_id}::text IS NULL
                OR (workspace_id, source_kind, session_id, turn_idx)
                   > (${cursor.workspace_id}::text, ${cursor.source_kind}::text, ${cursor.session_id}::text, ${cursor.turn_idx}::int)
             ORDER BY workspace_id, source_kind, session_id, turn_idx
             LIMIT ${SESSION_TURN_WINDOWS_BACKFILL_BATCH_TURNS}
          ), ins AS (
            INSERT INTO harness_shared.session_turn_windows (workspace_id, source_kind, session_id, turn_idx, win_idx, wtext)
            SELECT b.workspace_id, b.source_kind, b.session_id, b.turn_idx, f.win_idx, f.wtext
              FROM batch b, LATERAL harness_shared.session_turn_windows_of(b.text) f
            ON CONFLICT DO NOTHING
            RETURNING 1
          )
          SELECT (SELECT count(*) FROM batch)::int AS turns,
                 (SELECT row_to_json(l) FROM (
                    SELECT workspace_id, source_kind, session_id, turn_idx FROM batch
                     ORDER BY workspace_id DESC, source_kind DESC, session_id DESC, turn_idx DESC LIMIT 1) l) AS last
        `;
        if (!r || r.turns === 0 || !r.last) {
          complete = true;
          break;
        }
        cursor = r.last;
        turns += r.turns;
        await sql`
          UPDATE harness_shared.session_turn_windows_state
             SET cursor_workspace_id = ${cursor.workspace_id}, cursor_source_kind = ${cursor.source_kind},
                 cursor_session_id = ${cursor.session_id}, cursor_turn_idx = ${cursor.turn_idx},
                 turns_done = turns_done + ${r.turns}, heartbeat_at = now(), updated_at = now()
           WHERE scope = 'all'
        `;
      }
      // Release the lease so the next pass resumes immediately instead of waiting out the stale window.
      await sql`
        UPDATE harness_shared.session_turn_windows_state SET heartbeat_at = NULL, updated_at = now()
         WHERE scope = 'all' AND status = 'building'
      `;
      result.indexes.push({
        name: WINDOWS_BACKFILL_ENTRY,
        action: complete ? 'built' : 'deferred-budget',
        elapsedMs: Date.now() - started,
        turns,
      });
    } catch (err) {
      const message = (err as Error).message;
      await sql`
        UPDATE harness_shared.session_turn_windows_state
           SET status = 'failed', last_error = ${message}, heartbeat_at = NULL, updated_at = now()
         WHERE scope = 'all'
      `.catch(() => undefined);
      result.indexes.push({
        name: WINDOWS_BACKFILL_ENTRY,
        action: 'failed',
        elapsedMs: Date.now() - started,
        turns,
        error: message,
      });
      return;
    }
  }

  if (!complete) return; // budget cut the backfill short: no GIN yet, the next pass resumes.
  await ensureWindowsIndex();
  if (o.dryRun) return;
  const [idx] = await sql<Array<{ valid: boolean }>>`
    SELECT i.indisvalid AS valid FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'harness_shared' AND c.relname = ${WINDOWS_INDEX_NAME}
  `;
  if (idx?.valid) {
    await sql`
      UPDATE harness_shared.session_turn_windows_state
         SET status = 'ready', build_finished_at = now(), heartbeat_at = NULL, last_error = NULL, updated_at = now()
       WHERE scope = 'all' AND status <> 'ready'
    `;
  }
}

/** Build/refresh the vocabulary of every workspace that has transcript rows. */
async function refreshVocabularies(
  sql: postgres.Sql,
  o: typeof DEFAULTS & SessionSearchIndexBuildOpts,
  result: SessionSearchIndexBuildResult,
  overBudget: () => boolean,
): Promise<void> {
  // Global watermark, taken BEFORE any corpus read: every row with ingested_at <= W is covered by
  // a build that starts now; later rows are the next incremental's. max() is index-backed.
  const [{ w } = { w: null }] = await sql<Array<{ w: string | null }>>`
    SELECT max(ingested_at)::text AS w FROM harness_shared.session_turns
  `;
  if (w == null) return; // empty corpus — nothing to tokenize.

  const workspaces = await sql<Array<{ workspace_id: string }>>`
    SELECT DISTINCT workspace_id FROM harness_shared.session_turns
  `;

  for (const { workspace_id: ws } of workspaces) {
    const started = Date.now();
    const [state] = await sql<VocabStateRow[]>`
      SELECT status, watermark_ingested_at::text AS watermark_ingested_at,
             last_full_build_at, build_started_at, build_finished_at
        FROM harness_shared.session_turn_vocab_state WHERE workspace_id = ${ws}
    `;

    const mode = await decideVocabMode(sql, ws, state, o);
    if (mode === 'current' || mode === 'in-flight') {
      result.vocab.push({ workspaceId: ws, action: mode, elapsedMs: 0 });
      continue;
    }
    if (overBudget()) {
      result.truncated = true;
      result.vocab.push({ workspaceId: ws, action: 'deferred-budget', elapsedMs: 0 });
      continue;
    }
    if (o.dryRun) {
      result.vocab.push({ workspaceId: ws, action: 'would-build', elapsedMs: 0 });
      continue;
    }

    // Claim the lease atomically so two passes never build one workspace at once. A build in
    // flight is one whose lease is newer than its last finish and not stale. A READY vocabulary
    // keeps status='ready' during a rebuild (readers keep the old words until the swap commits).
    const staleAt = new Date(Date.now() - o.vocabLeaseStaleMs);
    const claimed = await sql<Array<{ workspace_id: string }>>`
      INSERT INTO harness_shared.session_turn_vocab_state AS st
             (workspace_id, status, build_started_at, updated_at)
      VALUES (${ws}, 'building', now(), now())
      ON CONFLICT (workspace_id) DO UPDATE
         SET status = CASE WHEN st.status = 'ready' THEN 'ready' ELSE 'building' END,
             build_started_at = now(),
             updated_at = now()
       WHERE st.build_started_at IS NULL
          OR (st.build_finished_at IS NOT NULL AND st.build_finished_at >= st.build_started_at)
          OR st.build_started_at < ${staleAt}::timestamptz
      RETURNING workspace_id
    `;
    if (claimed.length === 0) {
      result.vocab.push({ workspaceId: ws, action: 'in-flight', elapsedMs: 0 });
      continue;
    }

    try {
      const words = await buildVocabulary(sql, ws, mode, w, state);
      result.vocab.push({ workspaceId: ws, action: mode, words, elapsedMs: Date.now() - started });
    } catch (err) {
      const message = (err as Error).message;
      await sql`
        UPDATE harness_shared.session_turn_vocab_state
           SET status = CASE WHEN status = 'ready' THEN 'ready' ELSE 'failed' END,
               last_error = ${message.slice(0, 2000)},
               build_finished_at = now(),
               updated_at = now()
         WHERE workspace_id = ${ws}
      `.catch(() => {});
      result.vocab.push({
        workspaceId: ws,
        action: 'failed',
        elapsedMs: Date.now() - started,
        error: message,
      });
    }
  }
}

async function decideVocabMode(
  sql: postgres.Sql,
  ws: string,
  state: VocabStateRow | undefined,
  o: typeof DEFAULTS & SessionSearchIndexBuildOpts,
): Promise<'full' | 'incremental' | 'current' | 'in-flight'> {
  if (!state || state.status === 'absent' || state.status === 'failed') {
    return inFlight(state, o) ? 'in-flight' : 'full';
  }
  if (inFlight(state, o)) return 'in-flight';
  if (state.status === 'building') return 'full'; // a dead build's stale lease
  // status === 'ready'
  const fullAt = toMs(state.last_full_build_at);
  if (fullAt == null || Date.now() - fullAt > o.vocabFullRebuildAfterMs) return 'full';
  if (state.watermark_ingested_at == null) return 'full';
  const [fresh] = await sql<Array<{ has_new: boolean }>>`
    SELECT EXISTS (
      SELECT 1 FROM harness_shared.session_turns
       WHERE workspace_id = ${ws} AND ingested_at > ${state.watermark_ingested_at}::text::timestamptz
    ) AS has_new
  `;
  return fresh?.has_new ? 'incremental' : 'current';
}

function inFlight(state: VocabStateRow | undefined, o: { vocabLeaseStaleMs: number }): boolean {
  const started = toMs(state?.build_started_at);
  if (started == null) return false;
  const finished = toMs(state?.build_finished_at);
  if (finished != null && finished >= started) return false;
  return Date.now() - started < o.vocabLeaseStaleMs;
}

/** One workspace's vocabulary build in a single transaction: readers never see a half-swapped set. */
async function buildVocabulary(
  sql: postgres.Sql,
  ws: string,
  mode: 'full' | 'incremental',
  /** Full-precision timestamptz text — see VocabStateRow.watermark_ingested_at. */
  upTo: string,
  state: VocabStateRow | undefined,
): Promise<number> {
  const minLen = SESSION_TURN_VOCAB_MIN_WORD_LEN;
  const maxLen = SESSION_TURN_VOCAB_MAX_WORD_LEN;
  const prev = mode === 'incremental' ? state?.watermark_ingested_at ?? null : null;

  return sql.begin(async (tx) => {
    // A full build is one multi-minute statement; do not let a session statement_timeout kill it.
    await tx`SET LOCAL statement_timeout = 0`;
    // `mode` and the bounds are interpolated through format(%L), never string-concatenated.
    if (mode === 'full') {
      await tx`
        INSERT INTO harness_shared.session_turn_vocab AS v (workspace_id, word, ndoc, refreshed_at)
        SELECT ${ws}::text, s.word, s.ndoc, ${upTo}::text::timestamptz
          FROM ts_stat(format(
                 'SELECT to_tsvector(''simple'', lower(text)) FROM harness_shared.session_turns '
                 || 'WHERE workspace_id = %L AND ingested_at <= %L',
                 ${ws}::text, ${upTo}::text)) s
         WHERE length(s.word) BETWEEN ${minLen} AND ${maxLen}
        ON CONFLICT (workspace_id, word) DO UPDATE
           SET ndoc = EXCLUDED.ndoc, refreshed_at = EXCLUDED.refreshed_at
      `;
      // Words whose last turn retention deleted were not re-stamped by this build.
      await tx`
        DELETE FROM harness_shared.session_turn_vocab
         WHERE workspace_id = ${ws} AND refreshed_at < ${upTo}::text::timestamptz
      `;
    } else {
      await tx`
        INSERT INTO harness_shared.session_turn_vocab AS v (workspace_id, word, ndoc, refreshed_at)
        SELECT ${ws}::text, s.word, s.ndoc, ${upTo}::text::timestamptz
          FROM ts_stat(format(
                 'SELECT to_tsvector(''simple'', lower(text)) FROM harness_shared.session_turns '
                 || 'WHERE workspace_id = %L AND ingested_at > %L AND ingested_at <= %L',
                 ${ws}::text, ${prev}::text, ${upTo}::text)) s
         WHERE length(s.word) BETWEEN ${minLen} AND ${maxLen}
        ON CONFLICT (workspace_id, word) DO UPDATE
           SET ndoc = v.ndoc + EXCLUDED.ndoc, refreshed_at = EXCLUDED.refreshed_at
      `;
    }
    const [{ n } = { n: 0 }] = await tx<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM harness_shared.session_turn_vocab WHERE workspace_id = ${ws}
    `;
    await tx`
      UPDATE harness_shared.session_turn_vocab_state
         SET status = 'ready',
             watermark_ingested_at = ${upTo}::text::timestamptz,
             word_count = ${n},
             build_finished_at = now(),
             last_full_build_at = CASE WHEN ${mode === 'full'} THEN now() ELSE last_full_build_at END,
             last_error = NULL,
             updated_at = now()
       WHERE workspace_id = ${ws}
    `;
    return n;
  });
}
