/**
 * append-heavy-invalidator — the DEBOUNCED live-invalidation producer for the append-heavy
 * activity-LOG tables (data-sync-push-completion P-005 / D-012).
 *
 * THE PROBLEM. The six APPEND_HEAVY_POLL_SPECS (audit_log, agent_runs_consolidated, user_actions,
 * harness_hook_logs, toast_log, feature_audit_consolidated) are MAPPED in TABLE_TO_QUERY_NAMES
 * but INTENTIONALLY carry NO per-row emit_change_notify trigger — a per-row pg_notify on a
 * high-write log is the notify-storm anti-pattern (mig 376 drops it; cache-tag-trigger-coverage's
 * COVERAGE_EXEMPT documents it). So their mapped sync queries (userActions.recent / byHarness /
 * byKind, auditLog.*, toastLog.recent, …) did NOT live-update on a write — the COVERAGE_EXEMPT
 * "Debounced invalidation TODO (P-005)". Consumers had to fall back to a client poll (the
 * AdvOverviewTab Activity tile) or go stale until the 180s drift-repair.
 *
 * THE FIX. ONE cheap detector instead of a per-row trigger OR per-client poll: poll a monotonic
 * change-key (`max(<changeKey>)`, per APPEND_HEAVY_POLL_SPECS — NOT always `id`: 3 of the 6 tables
 * have a TEXT id or no id, so they use their bigint `ts`) per table on a fixed cadence; when it
 * advances, synthesize a single `harness_shared.<table>.changed` invalidation — the SAME event the
 * real trigger would emit — so the existing sync-sse bridge fans it to every mapped query name +
 * every connected client. ONE poll serves ALL clients; the fire is rate-limited to the poll cadence,
 * so there is no per-row storm.
 *
 * Self-debounced ⇒ it passes a SHORT `dedupeWindowMs` so the bus's 90s default (built to collapse
 * a chatty per-row reconcile) does not WRONGLY collapse its legitimate per-tick fires to one/90s.
 *
 * Detection = `max(<changeKey>)`, which catches new rows — the dominant change for append LOGS. A
 * pure UPDATE that does not advance the change-key (e.g. user_actions running→completed) is picked
 * up on the next INSERT or the 180s drift-repair; acceptable for an activity feed. Composes with
 * cache/debounced-invalidate.ts (the CONSUMER-side cache coalescer) — see APPEND_HEAVY_POLL_SPECS.
 *
 * Host-only (opens a PG connection, fires server invalidations). RLS: reads go through a
 * BYPASSRLS admin connection (mig 016) so `max(id)` sees every workspace; the synthesized
 * invalidation is name-only (full-bust), so each client refetches its own scope.
 */
import { getLongLivedAdminPool } from '../long-lived-admin-pool';
import { notifySyncInvalidate } from '../sync-sse';
import { APPEND_HEAVY_POLL_SPECS } from './table-to-query-names';

const DEFAULT_POLL_MS = 8_000;
// < poll cadence, so consecutive per-tick fires are NOT collapsed; still long enough to
// collapse a same-tick burst if more than one host runs the detector.
const DEFAULT_DEDUPE_MS = 5_000;

/** Injectable seams so the loop is unit-testable without a real DB / bus / clock. */
export interface AppendHeavyInvalidatorDeps {
  /** Tables to watch. Default {@link APPEND_HEAVY_POLL_SPECS}. */
  tables?: readonly string[];
  /** Poll cadence (ms). Default 8000. */
  pollMs?: number;
  /** Per-fire dedupe window passed to the bus (ms). Default 5000. */
  dedupeWindowMs?: number;
  /**
   * Runtime kill-switch checked at the START of every sweep (default: always on). The flag is
   * checked HERE — not at boot — because getFlag is FRAGILE at host-bootstrap time (it can resolve
   * false before the flag backend is warm; see host-bootstrap's INFERENCE_GATEWAY note). Starting
   * unconditionally + gating the work per-tick avoids "detector silently never started".
   *
   * EI-13014: `boolean | Promise<boolean>` — the real host wiring passes `() =>
   * getFlag(...)`, which is `async` (returns `Promise<boolean>`). A sync-only `()
   * => boolean` type let that through host-bootstrap.ts's structural typing as a
   * silent TS2322 that a narrower project-graph tsc run missed entirely; worse, a
   * caller that DID satisfy the old sync signature by returning a Promise anyway
   * (as this one always did) got `!deps.isEnabled()` evaluating `!<Promise
   * object>` — a Promise is always truthy, so the negation is always `false` and
   * the per-tick kill-switch checked below silently never disables anything. The
   * union + the `await` in `tick()` below make the async case correct instead of
   * merely type-checking.
   */
  isEnabled?: () => boolean | Promise<boolean>;
  /** Read the table's current max(id). Returns null/undefined when empty. (postgres-js
   *  returns a bigint column as a string — BigInt() in the sweep accepts string|number|bigint.) */
  maxId: (table: string) => Promise<bigint | number | string | null | undefined>;
  /** Emit the synthesized `harness_shared.<table>.changed` invalidation. */
  emitChanged: (eventName: string, dedupeWindowMs: number) => Promise<void>;
  /** setTimeout seam (default global). */
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (h: ReturnType<typeof setTimeout>) => void;
  onError?: (where: string, err: unknown) => void;
  log?: (msg: string) => void;
}

/**
 * Run ONE detection sweep over `tables`, firing a synthesized `.changed` invalidation for each
 * table whose max(id) advanced since `lastSeen`. The FIRST observation of a table only records
 * its baseline (no fire) so boot doesn't spuriously full-bust every consumer. Mutates `lastSeen`.
 * Exported for the unit test.
 */
export async function sweepAppendHeavy(
  tables: readonly string[],
  lastSeen: Map<string, bigint>,
  maxId: AppendHeavyInvalidatorDeps['maxId'],
  emitChanged: AppendHeavyInvalidatorDeps['emitChanged'],
  dedupeWindowMs: number,
  onError?: AppendHeavyInvalidatorDeps['onError'],
): Promise<void> {
  for (const table of tables) {
    try {
      const raw = await maxId(table);
      if (raw == null) continue; // empty table — nothing to detect yet
      const cur = BigInt(raw);
      const prev = lastSeen.get(table);
      lastSeen.set(table, cur);
      if (prev === undefined) continue; // baseline only — no fire on first observation
      if (cur > prev) {
        await emitChanged(`harness_shared.${table}.changed`, dedupeWindowMs);
      }
    } catch (err) {
      onError?.(`append-heavy:${table}`, err);
    }
  }
}

/**
 * Start the detection loop. Returns a stop handle. Pure of I/O wiring — pass `maxId`/`emitChanged`
 * (the host wrapper {@link startAppendHeavyInvalidatorHost} supplies the real ones).
 */
export function startAppendHeavyInvalidator(deps: AppendHeavyInvalidatorDeps): () => void {
  const tables = deps.tables ?? APPEND_HEAVY_POLL_SPECS.map((s) => s.table);
  const pollMs = deps.pollMs ?? DEFAULT_POLL_MS;
  const dedupeWindowMs = deps.dedupeWindowMs ?? DEFAULT_DEDUPE_MS;
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h));
  const lastSeen = new Map<string, bigint>();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const tick = async () => {
    if (stopped) return;
    // Runtime kill-switch (NOT boot-gated — getFlag is fragile at boot). When off, skip the
    // sweep (no reads, no fires) but keep ticking so a runtime flip back ON resumes without a
    // restart. lastSeen is left untouched while off, so the first ON tick fires at most ONCE to
    // catch up the OFF-window backlog (a single full-bust, not a per-row storm).
    if (deps.isEnabled && !(await deps.isEnabled())) {
      if (!stopped) timer = setTimer(() => void tick(), pollMs);
      return;
    }
    await sweepAppendHeavy(tables, lastSeen, deps.maxId, deps.emitChanged, dedupeWindowMs, deps.onError);
    if (!stopped) timer = setTimer(() => void tick(), pollMs);
  };
  // Kick off; the first sweep records baselines (no fires).
  void tick();

  return () => {
    stopped = true;
    if (timer !== undefined) clearTimer(timer);
  };
}

/**
 * Host wrapper: wires the real BYPASSRLS admin connection + the sync-sse bridge. Call once at
 * operator-host boot (flag-gated). Returns a stop handle that halts the poll loop; the pool
 * itself is registry-owned and intentionally outlives it (see the note on the return).
 */
export function startAppendHeavyInvalidatorHost(opts?: {
  pollMs?: number;
  dedupeWindowMs?: number;
  /** Runtime kill-switch checked per-tick (default always on). Pass `() => getFlag(...)`
   *  (async is fine — EI-13014). */
  isEnabled?: () => boolean | Promise<boolean>;
  log?: (msg: string) => void;
}): () => void {
  // Dedicated single connection on the BYPASSRLS admin URL (mig 016) so max(id) sees every
  // workspace's rows. max:1 — one long-lived poller connection, never per-call (perf-doc A-pattern).
  // EI-18122461766429683: tagged + zombie-safe (see longLivedPoolConnectionOptions) — this was
  // one of the untagged, unreaped singleton pools whose accumulation across host restarts
  // drove server-wide PG connection saturation past its SLO budget.
  // EI-19383722505382723: resolved PER USE, never captured. A `const sql = postgres(
  // getHarnessAdminUrl(), …)` here binds the admin URL ONCE at host boot — so when embedded-pg
  // dies and `~/.papercusp/embedded-pg.json` goes stale (or is DELETED, which correctly restores
  // the healthy native :5432), this poller keeps dialling the dead port for the whole process
  // lifetime and only a service restart clears it. Measured twice: deleting the discovery file
  // left the ECONNREFUSED rate completely unchanged, because nothing here ever re-asked.
  // `getLongLivedAdminPool` re-resolves on every call and rebinds when the endpoint moved, so
  // recovery needs no restart. Eligible because this pool is TRANSACTIONAL — the accessor is
  // deliberately NOT for LISTEN pools, whose subscription a silent rebuild would drop.
  //
  // `idle_timeout: 0` is preserved verbatim from the pre-migration site. Note it is off the
  // documented convention for a transactional pool (which wants `poolIdleTimeoutSec()`), but
  // changing idle policy is a DIFFERENT fix from rebind-on-move and does not belong smuggled
  // into this one; `extra` is spread last by the accessor, so this keeps the exact prior
  // behaviour. Tracked separately.
  const db = () =>
    getLongLivedAdminPool('append-heavy-invalidator', {
      max: 1,
      idle_timeout: 0,
      connect_timeout: 30,
    });
  // Per-table MONOTONIC change-key column (bigint) — NOT every table has a usable `id` (see
  // APPEND_HEAVY_POLL_SPECS). Built from the hardcoded allow-list, never user input.
  const changeKeyByTable = new Map(APPEND_HEAVY_POLL_SPECS.map((s) => [s.table, s.changeKey]));
  const stop = startAppendHeavyInvalidator({
    tables: APPEND_HEAVY_POLL_SPECS.map((s) => s.table),
    pollMs: opts?.pollMs,
    dedupeWindowMs: opts?.dedupeWindowMs,
    isEnabled: opts?.isEnabled,
    maxId: async (table) => {
      const changeKey = changeKeyByTable.get(table) ?? 'id';
      // Re-resolved per tick (see `db` above) — this is what makes a moved endpoint recoverable
      // without a restart. Bound to a local so the identifier escaping below uses this very pool.
      const sql = db();
      // table + changeKey come from the hardcoded APPEND_HEAVY_POLL_SPECS allow-list (never user
      // input); sql(...) escapes both identifiers regardless.
      const rows = await sql<{ m: string | number | null }[]>`
        SELECT max(${sql(changeKey)}) AS m FROM harness_shared.${sql(table)}`;
      return rows[0]?.m ?? null;
    },
    emitChanged: (eventName, dedupeWindowMs) =>
      notifySyncInvalidate(eventName, undefined, undefined, { dedupeWindowMs }),
    onError: (where, err) => (opts?.log ?? console.error)(`[append-heavy-invalidator] ${where}: ${String(err)}`),
    log: opts?.log,
  });
  return () => {
    stop();
    // Deliberately does NOT end the pool. It is owned by the long-lived-admin-pool registry —
    // shared by label and rebound on endpoint moves — so ending it here would strand a CLOSED
    // handle under this label that the next `getLongLivedAdminPool('append-heavy-invalidator')`
    // caller is handed straight back (the URL matches, so the rebind check passes it through).
    // The sole production caller discards this handle, and repeated start/stop now reuses the
    // one registry pool instead of accumulating a fresh one per start.
  };
}
