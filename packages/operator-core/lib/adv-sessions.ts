/**
 * adv-sessions.ts — server-side lifecycle helpers for the /adv
 * Sessions surface. Wraps the `harness_shared.adv_sessions` table
 * (migration 079, ensured at runtime via ensureAdvSessionsTable).
 *
 * Two writers:
 *   - `recordAdvSession` inserts a row at spawn time and returns the
 *     new row id.
 *   - `markAdvSessionEnded` updates the row when the child exits.
 *
 * One reader: `listAdvSessions`, used by both the UI route and the
 * `adv:sessions_list` MCP tool (later).
 */

import { getOrgPg } from '@papercusp/db-org';
import { boundedOrgTxn } from './pg-bounded-txn';
import { activeWorkspaceId } from './workspace-registry';
import type { SuAgent } from './su-agents';
import { caveat, type FieldCaveat } from './field-reliability';
import { trackDetached } from './detached-imports';

/**
 * Log a best-effort read/write failure UNLESS it's PG's undefined_table
 * (42P01) — a minimal/isolated schema (many unit/integration test fixtures
 * build only the tables their scenario needs) legitimately lacks
 * harness_shared.adv_sessions, and every function in this file already
 * degrades cleanly (returns [] / null / no-op) on any error. Warning on that
 * EXPECTED case was pure noise that, under vitest-fail-on-console, turned
 * into red tests unrelated to adv-sessions itself (EI-8194) — the same
 * 42P01-swallow precedent used elsewhere (work-items.ts, decision-ledger,
 * sync-resolver). Real, unexpected errors still warn loudly.
 */
function warnUnlessMissingTable(e: unknown, label: string): void {
  if ((e as { code?: string } | undefined)?.code === '42P01') return;
  console.warn(`[adv-sessions] ${label} failed:`, (e as Error).message);
}

/** Claude native session ids are v4 UUIDs; refuse anything else so a corrupted
 *  report can never poison the authoritative owner→native mapping (WI-5075).
 *  Shared by every writer of `adv_sessions.session_id` from an externally
 *  reported id (the respawn report, the SessionStart lifecycle hook) so the
 *  validation can't drift between call sites. */
export const NATIVE_SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Who wrote a row's `ended_at` (migration 735), and whether the exit was VOLUNTARY
 * (migration 800).
 *
 * TWO ORTHOGONAL AXES live in this one column, and conflating them is what made a
 * mass reap invisible (WI-38054). Read them separately:
 *
 * | value          | `ended_at` is...  | the exit was...                        |
 * |----------------|-------------------|----------------------------------------|
 * | `'self'`       | the real end time | voluntary                              |
 * | `'signal'`     | the real end time | INVOLUNTARY — killed by `ended_signal` |
 * | `'reaper'`     | a NOTICE time     | unknown; already gone when noticed     |
 * | `'reconciler'` | a NOTICE time     | unknown; already gone when noticed     |
 * | `'cleanup'`    | a CLOSE time      | never ran                              |
 * | `null`         | unknown           | unknown (legacy, pre-735)              |
 *
 * ⚠ `'signal'` is an OBSERVATION, so it groups with `'self'` on the TIME axis and
 * against it on the VOLUNTARY axis. Use {@link isObserverEndedSession} for the first
 * question and {@link isInvoluntaryEnd} for the second — never `!== 'self'` for both,
 * which is the shortcut that produced the original wrong answer.
 *
 * WHY `'signal'` AND NOT `'reaped'`: the reporting parent observes only "my child died
 * from signal N". It cannot know whether the sender was a host restart, an owner's
 * Ctrl-C, a peer's `processes:kill`, or the OOM killer. Naming it after a cause nothing
 * observed would re-commit the very over-attribution this column exists to prevent.
 */
export type AdvSessionEndedBy = 'self' | 'signal' | 'reaper' | 'reconciler' | 'cleanup';

/**
 * The writers whose `ended_at` is a REAL end time because a live parent watched the
 * process go, as opposed to a sweeper stamping `now()` on noticing a corpse.
 *
 * Declared once so the two axes can never drift apart again: every "is this timestamp
 * trustworthy?" check reads this set, and nothing re-derives it from `!== 'self'`.
 */
const OBSERVED_END_WRITERS: ReadonlySet<AdvSessionEndedBy> = new Set(['self', 'signal']);

export interface AdvSessionRow {
  id: number;
  workspaceId: string;
  /** Harness scope persisted in the resolved su launch spec, when available.
   *  Older rows and pre-migration databases omit it and remain workspace-only. */
  harnessSlug?: string | null;
  planSlug: string | null;
  /** Which agent CLI backs this session; null for pre-*-su rows. */
  agent: SuAgent | null;
  /** Pipeline role this session runs as (worker/validator/…); null = plain SU/engineer. */
  role: string | null;
  /** Feature the role session is scoped to; null when none. */
  feature: string | null;
  mode: 'omp' | 'console';
  terminalBin: string | null;
  pid: number | null;
  windowId: string | null;
  ompThreadId: string | null;
  label: string | null;
  cwd: string | null;
  /** The coord identity (PAPERCUSP_SID) baked into the session env — the
   *  join key to coord_presence.owner_id for the live roster. null for
   *  console launches and pre-existing rows (no SID minted at record time). */
  coordOwnerId: string | null;
  /** The agent's NATIVE session id (claude/codex UUID) when psu forces +
   *  records it — the join key that lets `psu --resume <native-uuid>`
   *  correlate this row. null for omp (uses ompThreadId), codex (resumes via
   *  its per-session CODEX_HOME), and rows that predate native-id tracking. */
  sessionId: string | null;
  /** Pane-worthiness hint (pui-reactive-session-panes D-002/D-006): 'workbench'
   *  marks an INTERACTIVE launch the pui should reactively open a pane for;
   *  null for normal already-spawned sessions + autonomous cup:spawn rows. */
  display: string | null;
  /** The exact argv the pui pane runs for a pending workbench launch (a fresh
   *  `psu …`). null for non-deferred rows. */
  launchArgv: string[] | null;
  /** When the pui consumed a pending workbench launch by opening its pane.
   *  A PENDING launch is `display='workbench' AND launchedAt IS NULL AND
   *  endedAt IS NULL`; once set the row drops out of the pending roster tier. */
  launchedAt: string | null;
  startedAt: string;
  /**
   * When this session was last DOING something — set only by the queries that compute it
   * ({@link listResumableSessions}); every other query leaves it undefined.
   *
   * ⚠ Read this, NOT {@link startedAt}, when you mean "most recently worked in". `startedAt`
   * is neither a birth time nor an activity time: it is the time of the last (RE)ACTIVATION,
   * because `claimAdvSessionResume` / `reactivateAdvSessionByOwner` bump it to `now()` whenever
   * an ended row comes back to life. So a session that has been running and busy for ten hours
   * straight (never ended ⇒ never reactivated) keeps a ten-hour-old `startedAt` and sorts BELOW
   * a session that merely resumed a minute ago and has done nothing since. Ordering a
   * human-facing "recent sessions" list by `startedAt` is therefore wrong in the one case the
   * list exists for — measured 2026-08-12: 53 of the 74 codex sessions that had been active in
   * the past hour sat outside the top 30 by `startedAt`, the worst at rank 233.
   *
   * Derived as the GREATEST of `startedAt`, `coord_presence.last_active_at`, and the session
   * owner's newest `tool_invocations.invoked_at` — so it degrades to `startedAt` rather than
   * going null when both activity sources are missing. (`first_seen_at` is the immutable birth
   * column if you want the true launch time.)
   */
  lastActiveAt?: string | null;
  /**
   * When this row was marked ended — WHICH IS NOT NECESSARILY WHEN THE SESSION ENDED.
   *
   * Read `endedBy` before reasoning from this. Only `endedBy === 'self'` makes this an
   * observation; every other value (including `null`) means a sweeper stamped `now()` on
   * noticing a process that was ALREADY gone, so the true end time is unknown and the gap
   * is of arbitrary length. See {@link advSessionEndedAtCaveat}.
   */
  endedAt: string | null;
  /**
   * NULL here does NOT mean "clean exit" — it means "no code was ever observed", and that
   * happens for two unrelated reasons that are indistinguishable from this column alone:
   *
   *  - a genuine self-report with no code (`harness/spawn.ts` passes `r.exitCode ?? null`
   *    unconditionally, so a real self-reported end can still leave this NULL); or
   *  - we never reaped the process at all — it is not our child, so no status was ever
   *    read (see the `reconcileDeadTerminalLaunches` comment above, which documents this
   *    for the terminal-launch case specifically).
   *
   * Whoever writes it inherits the SAME provenance gap {@link endedAt} has (P-015,
   * WI-7126/EI-19375527037368001): when {@link isObserverEndedSession} is true for this row,
   * this NULL is an observer's absence-of-evidence, not evidence of a clean exit — do not
   * render it as "exited cleanly" or "code unknown but healthy". Pass it through
   * {@link advSessionExitCodeCaveat} before exposing it, the same way
   * {@link advSessionEndedAtCaveat} guards `endedAt`.
   *
   * ⚠ A NON-null `0` is the more dangerous case, and it is NOT hypothetical (WI-38054):
   * node-pty reports a signal death as `{ exitCode: 0, signal: N }`, so a KILLED session
   * carries a zero that looks exactly like a clean exit. Check {@link endedBy} — a
   * `'signal'` row's `exitCode` is a placeholder and carries no status at all.
   */
  exitCode: number | null;
  /**
   * Who wrote {@link endedAt}, and whether the exit was voluntary. `null` = legacy row
   * (migration 735) — provenance UNKNOWN, which is NOT the same as 'self' and must not
   * be read as it. See {@link AdvSessionEndedBy} for the two-axis table.
   */
  endedBy: AdvSessionEndedBy | null;
  /**
   * The signal that killed this session (e.g. `'SIGHUP'`), when {@link endedBy} is
   * `'signal'`; `null` for every other writer (enforced by a CHECK, migration 800).
   *
   * This is the ONLY field that can contradict a signal row's misleading `exitCode: 0`,
   * which is why it is persisted rather than derived — the discarding of this exact
   * value is what let a mass reap read as two voluntary exits.
   */
  endedSignal: string | null;
  /** Cross-backend session-port lineage. A port target remains hidden from
   * resumable surfaces until portStatus='delivered'. */
  portId?: string | null;
  portSourceAdvSessionId?: number | null;
  portStatus?: string | null;
  portMetadata?: Record<string, unknown> | null;
}

/**
 * Reconstruct the minimum safe SU launch record needed to repair an older
 * Codex session home when its adv_sessions row predates launch_spec.
 *
 * The fallback is deliberately narrower than launch-time reconstruction: the
 * row is authoritative for backend, owner and workspace, while optional
 * persona/model/fleet choices are unknown and therefore remain unset. A
 * missing harness also stays workspace-scoped rather than being guessed from
 * cwd or the caller's current environment. The repaired MCP config can then
 * resume safely and require explicit per-call harness scope where necessary.
 */
export function fallbackCodexLaunchSpecFromAdvSession(
  row: AdvSessionRow | null,
  owner: string,
): import('./su-persona-render').SuLaunchSpecRecord | null {
  if (!row || row.agent !== 'codex' || row.coordOwnerId !== owner || !row.workspaceId) return null;
  return {
    v: 1,
    agent: 'codex',
    workspaceId: row.workspaceId,
    harnessSlug: row.harnessSlug?.trim() || null,
    profile: 'engineer',
    contextSize: 'trimmed',
    personaTier: null,
    model: null,
    planSlug: row.planSlug,
    launchedBy: null,
    autoMode: false,
    drainMode: false,
    loopArmed: false,
    fleet: null,
  };
}

export interface RecordOpts {
  planSlug?: string | null;
  agent?: SuAgent | null;
  /** Pipeline role this session runs as (worker/validator/…); omit for plain SU. */
  role?: string | null;
  /** Feature the role session is scoped to. */
  feature?: string | null;
  /** Workspace to record the row in; defaults to the active workspace. */
  workspaceId?: string;
  mode: 'omp' | 'console';
  terminalBin?: string | null;
  pid?: number | null;
  label?: string | null;
  ompThreadId?: string | null;
  cwd?: string | null;
  /** The coord owner_id (PAPERCUSP_SID) for this session — the live-roster
   *  join key to coord_presence. Set by the psu launcher; omit for console. */
  coordOwnerId?: string | null;
  /** The agent's native session id (claude --session-id UUID) when psu forces
   *  it at launch. Recorded so resume-by-native-uuid can find this row. */
  sessionId?: string | null;
  /** Pane-worthiness hint (D-002/D-006) — 'workbench' for a deferred-spawn
   *  interactive launch the pui should pane; omit for normal sessions. */
  display?: string | null;
  /** The exact argv the pui pane runs (a fresh `psu …`) for a deferred launch. */
  launchArgv?: string[] | null;
  portId?: string | null;
  portSourceAdvSessionId?: number | null;
  portStatus?: string | null;
  portMetadata?: Record<string, unknown> | null;
}

export function toIsoTimestamp(value: string | Date | null | undefined): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  throw new Error(`invalid timestamp: ${String(value)}`);
}

export function mapAdvSessionRow(r: {
  id: number;
  workspace_id: string;
  harness_slug?: string | null;
  plan_slug: string | null;
  agent: string | null;
  role: string | null;
  feature: string | null;
  mode: 'omp' | 'console';
  terminal_bin: string | null;
  pid: number | null;
  window_id: string | null;
  omp_thread_id: string | null;
  label: string | null;
  cwd: string | null;
  coord_owner_id: string | null;
  session_id: string | null;
  // pui-reactive-session-panes (D-006): optional — only the pending-launch query
  // SELECTs them; every other query omits them and they map to null.
  display?: string | null;
  launch_argv?: string[] | null;
  launched_at?: string | Date | null;
  started_at: string | Date;
  /** Optional — only {@link listResumableSessions} computes it; every other SELECT omits it
   *  and it maps to undefined rather than being faked from `started_at`. */
  last_active_at?: string | Date | null;
  ended_at: string | Date | null;
  exit_code: number | null;
  /** Optional so a SELECT that omits it maps to null = UNKNOWN provenance, which is
   *  treated as un-attributed (caveated), never as a clean 'self' exit. */
  ended_by?: string | null;
  /** Optional for the same reason as {@link ended_by}: a SELECT that omits it maps to
   *  null, which reads as "no signal recorded" rather than inventing one. */
  ended_signal?: string | null;
  port_id?: string | null;
  port_source_adv_session_id?: number | string | null;
  port_status?: string | null;
  port_metadata?: Record<string, unknown> | null;
}): AdvSessionRow {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    harnessSlug: r.harness_slug ?? null,
    planSlug: r.plan_slug,
    agent: (r.agent as SuAgent | null) ?? null,
    role: r.role ?? null,
    feature: r.feature ?? null,
    mode: r.mode,
    terminalBin: r.terminal_bin,
    pid: r.pid,
    windowId: r.window_id,
    ompThreadId: r.omp_thread_id,
    cwd: r.cwd,
    coordOwnerId: r.coord_owner_id ?? null,
    sessionId: r.session_id ?? null,
    display: r.display ?? null,
    launchArgv: r.launch_argv ?? null,
    launchedAt: toIsoTimestamp(r.launched_at ?? null),
    label: r.label,
    startedAt: toIsoTimestamp(r.started_at)!,
    // Only present on queries that compute it; `undefined` (not startedAt) so a caller
    // can tell "this query did not measure activity" from "it measured, and it is old".
    ...(r.last_active_at === undefined ? {} : { lastActiveAt: toIsoTimestamp(r.last_active_at) }),
    endedAt: toIsoTimestamp(r.ended_at),
    exitCode: r.exit_code,
    endedBy: (r.ended_by as AdvSessionEndedBy | null) ?? null,
    endedSignal: r.ended_signal ?? null,
    portId: r.port_id ?? null,
    portSourceAdvSessionId: r.port_source_adv_session_id == null ? null : Number(r.port_source_adv_session_id),
    portStatus: r.port_status ?? null,
    portMetadata: r.port_metadata ?? null,
  };
}

/**
 * Workspace recorded for a coord owner (PAPERCUSP_SID) at launch — the
 * SID→workspace fallback for superuser MCP calls whose URL/headers carry no
 * workspace (stale user-level MCP configs; resumed sessions whose env dropped
 * PAPERCUSP_WORKSPACE). Most-recent row wins (a SID is minted per launch and
 * reused by resumes). Read-through TTL cache only — PG stays authoritative;
 * this can run on every superuser tool call when no explicit workspace rides
 * the request, and 30s of staleness is harmless (a SID's workspace is fixed
 * at launch).
 */
const coordOwnerWsCache = new Map<string, { ws: string | null; at: number }>();
const COORD_OWNER_WS_TTL_MS = 30_000;

export async function workspaceForCoordOwner(coordOwnerId: string): Promise<string | null> {
  const hit = coordOwnerWsCache.get(coordOwnerId);
  if (hit && Date.now() - hit.at < COORD_OWNER_WS_TTL_MS) return hit.ws;
  let ws: string | null = null;
  try {
    const { sql } = getOrgPg();
    const rows = await sql<{ workspace_id: string }[]>`
      SELECT workspace_id FROM harness_shared.adv_sessions
       WHERE coord_owner_id = ${coordOwnerId}
       ORDER BY started_at DESC
       LIMIT 1
    `;
    ws = rows[0]?.workspace_id ?? null;
  } catch (e) {
    warnUnlessMissingTable(e, 'workspaceForCoordOwner');
    return null; // don't cache a transient DB failure as "no workspace"
  }
  if (coordOwnerWsCache.size > 512) coordOwnerWsCache.clear(); // bounded; it's only a cache
  coordOwnerWsCache.set(coordOwnerId, { ws, at: Date.now() });
  return ws;
}

export async function recordAdvSession(opts: RecordOpts): Promise<number | null> {
  try {
    const { sql } = getOrgPg();
    // Rollout-order compatibility (WI-4936): ordinary sessions must remain
    // writable while migration 611 is still pending. Mentioning a new column in
    // an INSERT fails at parse time, even when its value is null, so only the
    // actual session-port path uses the extended INSERT. A port correctly fails
    // closed until its schema exists; every pre-existing caller stays legacy-safe.
    const rows = opts.portId
      ? await sql<{ id: number }[]>`
          INSERT INTO harness_shared.adv_sessions
            (workspace_id, plan_slug, agent, role, feature, mode, terminal_bin, pid, label, omp_thread_id, cwd, coord_owner_id, session_id, display, launch_argv,
             port_id, port_source_adv_session_id, port_status, port_metadata)
          VALUES
            (${opts.workspaceId ?? activeWorkspaceId()}, ${opts.planSlug ?? null}, ${opts.agent ?? null},
             ${opts.role ?? null}, ${opts.feature ?? null}, ${opts.mode},
             ${opts.terminalBin ?? null}, ${opts.pid ?? null}, ${opts.label ?? null},
             ${opts.ompThreadId ?? null}, ${opts.cwd ?? null}, ${opts.coordOwnerId ?? null}, ${opts.sessionId ?? null},
             ${opts.display ?? null}, ${opts.launchArgv ? JSON.stringify(opts.launchArgv) : null}::text::jsonb,
             ${opts.portId}, ${opts.portSourceAdvSessionId ?? null}, ${opts.portStatus ?? null},
             ${opts.portMetadata ? JSON.stringify(opts.portMetadata) : null}::text::jsonb)
          RETURNING id`
      : await sql<{ id: number }[]>`
          INSERT INTO harness_shared.adv_sessions
            (workspace_id, plan_slug, agent, role, feature, mode, terminal_bin, pid, label, omp_thread_id, cwd, coord_owner_id, session_id, display, launch_argv)
          VALUES
            (${opts.workspaceId ?? activeWorkspaceId()}, ${opts.planSlug ?? null}, ${opts.agent ?? null},
             ${opts.role ?? null}, ${opts.feature ?? null}, ${opts.mode},
             ${opts.terminalBin ?? null}, ${opts.pid ?? null}, ${opts.label ?? null},
             ${opts.ompThreadId ?? null}, ${opts.cwd ?? null}, ${opts.coordOwnerId ?? null}, ${opts.sessionId ?? null},
             ${opts.display ?? null}, ${opts.launchArgv ? JSON.stringify(opts.launchArgv) : null}::text::jsonb)
          RETURNING id`;
    return rows[0]?.id ?? null;
  } catch (e) {
    warnUnlessMissingTable(e, 'recordAdvSession');
    return null;
  }
}
/**
 * Pending "workbench launch" requests (pui-reactive-session-panes D-006): rows
 * the desktop new-session RECORDED (display='workbench') but the pui has not yet
 * consumed (launched_at IS NULL) and that have not ended. These are the deferred
 * launches the pui reactively opens a work-area pane for. Workspace-scoped (the
 * recording desktop + the pui that panes it share a box), most-recent first.
 */
export async function listPendingWorkbenchLaunches(
  opts: { workspaceId?: string | null; limit?: number } = {},
): Promise<AdvSessionRow[]> {
  const limit = opts.limit ?? 50;
  const ws = opts.workspaceId ?? null;
  try {
    const { sql } = getOrgPg();
    const workspacePredicate = ws === null ? true : sql`workspace_id = ${ws}`;
    const rows = await sql<Array<Parameters<typeof mapAdvSessionRow>[0]>>`
      SELECT id, workspace_id, plan_slug, agent, role, feature, mode, terminal_bin, pid,
             window_id, omp_thread_id, label, cwd, coord_owner_id, session_id,
             display, launch_argv, launched_at, started_at, ended_at, exit_code, ended_by, ended_signal
        FROM harness_shared.adv_sessions
       WHERE display = 'workbench'
         AND launched_at IS NULL
         AND ended_at IS NULL
         AND ${workspacePredicate}
       ORDER BY started_at DESC
       LIMIT ${limit}
    `;
    return rows.map(mapAdvSessionRow);
  } catch (e) {
    warnUnlessMissingTable(e, 'listPendingWorkbenchLaunches');
    return [];
  }
}

/**
 * `display` for a TERMINAL-spawned psu launch (WI-6376). Deliberately NOT
 * 'workbench': that value is pui-reactive-session-panes D-006's pane QUEUE, where
 * `launched_at IS NULL` means "the pui has not opened a pane for this row yet".
 * A terminal launch already owns a real terminal, so feeding it into that queue
 * would make the pui open a second, redundant work-area pane for it. The two
 * values are read by two different queries on purpose — keep them distinct.
 */
export const DISPLAY_TERMINAL_LAUNCH = 'terminal';

/** How long a terminal launch stays on the board before it ages out entirely.
 *  Long enough that a launch which never booted is VISIBLE as a failure rather
 *  than silently absent (the WI-6376 complaint), bounded so it cannot accrete. */
export const STARTING_LAUNCH_WINDOW_SEC = 15 * 60;

/**
 * Is `pid` a live OS process? Signal 0 = existence check; EPERM = alive-not-ours.
 * Deliberately a local copy of adv-roster's identical helper rather than a shared
 * import: adv-roster imports THIS module, so importing it back closes a cycle.
 */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

/**
 * A terminal launch we can PROVE never made it: its window process is gone and
 * it never registered a session. This is the OBSERVATION that WI-6821 was
 * missing — until it existed, a dead launch and a still-booting one were
 * indistinguishable, so the roster advertised the corpse as `starting` for the
 * whole window and the only thing that ever corrected the copy was a 60s
 * client-side timer (a guess, not evidence).
 *
 * `gnome-terminal --wait` is what makes this sound: the recorded pid is a
 * liveness handle for the terminal WINDOW's lifetime, so its absence is real
 * evidence rather than an inference from elapsed time.
 *
 * Both wrong answers are avoided deliberately:
 *  - `sessionId != null` ⇒ it registered, so it booted; never call that failed.
 *  - `pid == null` ⇒ no handle, hence NO EVIDENCE — leave it alone rather than
 *    guess (the status quo is a spinner; a false failure is a fabricated
 *    diagnosis, which is the very bug class this item is about).
 *  - a RECYCLED pid can only read alive, never gone — so pid-wrap (≈daily on
 *    this box under fleet load) can only make us miss a dead launch, never
 *    declare a live one dead. The error direction is the safe one.
 *
 * Host-safety: a pid is only meaningful on its own host, and `adv_sessions` has
 * no host column — but a `display='terminal'` row is LOCAL BY CONSTRUCTION
 * (`spawnInTerminal` spawns on the operator's own box), so the probe is sound
 * without one. If terminal launches ever become remote, this invariant breaks
 * and the row needs a host before it can be probed.
 *
 * Pure + injected `pidAlive` (the local idiom — see release-checkpoint-launch)
 * so the decision is unit-testable without real processes.
 */
export function isDeadTerminalLaunch(row: AdvSessionRow, pidAlive: (pid: number) => boolean = isPidAlive): boolean {
  if (row.display !== DISPLAY_TERMINAL_LAUNCH) return false;
  if (row.endedAt != null) return false; // already reconciled
  if (row.sessionId != null) return false; // it registered — it booted
  if (row.pid == null) return false; // no handle → no evidence
  return !pidAlive(row.pid);
}

/**
 * Does PERSISTED state say this launch failed? Pure — no probe. A terminal row
 * that has ended while never having registered a session is, by definition, a
 * launch that died before coming online.
 *
 * Derived rather than carried as a transient flag on purpose: "failed" then has
 * exactly ONE definition, shared by the reconciler that writes it and every
 * reader that renders it, and it survives a reload because it is a fact about
 * the row rather than about one process's memory.
 */
export function isFailedTerminalLaunch(row: AdvSessionRow): boolean {
  return row.display === DISPLAY_TERMINAL_LAUNCH && row.endedAt != null && row.sessionId == null;
}

/**
 * Stamp the launches we can prove are dead, and reflect the stamp in the rows we
 * return so the caller renders the truth on THIS poll rather than the next one.
 *
 * ⚠ `exit_code` is deliberately left NULL. We never reap this process — it is not
 * our child — so we never observe a status, and inventing a sentinel would be the
 * same fabrication this item exists to remove. The durable marker for "died before
 * registering" is `session_id IS NULL` (see isFailedTerminalLaunch), which is a
 * thing we actually know.
 *
 * The write is best-effort and the returned rows are corrected in memory first,
 * so a failed stamp degrades to "re-detected on the next poll", never to a wrong
 * answer.
 */
async function reconcileDeadTerminalLaunches(
  rows: AdvSessionRow[],
  pidAlive: (pid: number) => boolean = isPidAlive,
): Promise<AdvSessionRow[]> {
  const dead = rows.filter((r) => isDeadTerminalLaunch(r, pidAlive));
  if (dead.length === 0) return rows;
  const endedAt = new Date().toISOString();
  for (const r of dead) {
    r.endedAt = endedAt;
    // Keep the in-memory correction consistent with the write below: this stamp is a
    // NOTICE time, and a caller reading the corrected row must be able to tell.
    r.endedBy = 'reconciler';
  }
  try {
    const { sql } = getOrgPg();
    await sql`
      UPDATE harness_shared.adv_sessions
         SET ended_at = now(), ended_by = 'reconciler'
       WHERE id = ANY(${dead.map((r) => r.id)}::bigint[])
         AND ended_at IS NULL
         AND session_id IS NULL
    `;
  } catch (e) {
    warnUnlessMissingTable(e, 'reconcileDeadTerminalLaunches');
  }
  return rows;
}

/**
 * Terminal-spawned psu launches inside the boot window (WI-6376 / owner ask
 * 2026-07-25: "I want the sessions to show up there whether or not they are
 * launched with the new session button or if they are launched with the psu
 * utility").
 *
 * Between the spawn and psu's own coord-presence registration there is no
 * presence row, so the presence-primary roster cannot see the session at all —
 * the board showed it NOWHERE. This is the durable representation that covers
 * that window; the caller drops any row whose owner has since come online, so a
 * booted session is rendered once, from presence, not twice.
 *
 * Ended rows are included when they NEVER REGISTERED (WI-6821). A launch that
 * booted and later ended has a session_id and belongs in the `ended` list; one
 * that ended having never registered is a FAILED LAUNCH, and dropping it here
 * would leave the modal to fall through to "No recent Claude session found for
 * this agent" — replacing a spinner with a shrug. Keeping it in the tier, marked
 * failed, is what finally delivers the intent STARTING_LAUNCH_WINDOW_SEC was
 * written for: "a launch which never booted is VISIBLE as a failure rather than
 * silently absent".
 */
export async function listStartingTerminalLaunches(
  opts: {
    workspaceId?: string | null;
    limit?: number;
    withinSec?: number;
    pidAlive?: (pid: number) => boolean;
  } = {},
): Promise<AdvSessionRow[]> {
  const limit = opts.limit ?? 50;
  const withinSec = opts.withinSec ?? STARTING_LAUNCH_WINDOW_SEC;
  const ws = opts.workspaceId ?? null;
  try {
    const { sql } = getOrgPg();
    const workspacePredicate = ws === null ? true : sql`workspace_id = ${ws}`;
    const rows = await sql<Array<Parameters<typeof mapAdvSessionRow>[0]>>`
      SELECT id, workspace_id, plan_slug, agent, role, feature, mode, terminal_bin, pid,
             window_id, omp_thread_id, label, cwd, coord_owner_id, session_id,
             display, launch_argv, launched_at, started_at, ended_at, exit_code, ended_by, ended_signal
        FROM harness_shared.adv_sessions
       WHERE display = ${DISPLAY_TERMINAL_LAUNCH}
         AND (ended_at IS NULL OR session_id IS NULL)
         AND started_at > now() - (${withinSec}::int * interval '1 second')
         AND ${workspacePredicate}
       ORDER BY started_at DESC
       LIMIT ${limit}
    `;
    return await reconcileDeadTerminalLaunches(rows.map(mapAdvSessionRow), opts.pidAlive);
  } catch (e) {
    warnUnlessMissingTable(e, 'listStartingTerminalLaunches');
    return [];
  }
}

/**
 * Mark a pending workbench launch CONSUMED — the pui opened its pane (D-006).
 * Idempotent (only stamps an unset launched_at), so a roster-refresh race can't
 * double-consume. Returns true when this call did the stamping.
 */
export async function markAdvSessionLaunched(id: number): Promise<boolean> {
  try {
    const { sql } = getOrgPg();
    const rows = await sql<{ id: number }[]>`
      UPDATE harness_shared.adv_sessions
         SET launched_at = now()
       WHERE id = ${id}
         AND launched_at IS NULL
       RETURNING id
    `;
    return rows.length > 0;
  } catch (e) {
    warnUnlessMissingTable(e, 'markAdvSessionLaunched');
    return false;
  }
}

/**
 * ADOPT the launcher's starting row as this session's own (WI-37743/P-002).
 *
 * A programmatic spawner that PRE-PINS the owner id (`psu --owner-id=…`) writes
 * either a `display='terminal'` starting row or a deferred `display='workbench'`
 * row. The latter becomes adoptable only after PUI wins its atomic claim and
 * stamps `launched_at`. Either row is bound to the owner id the booting psu is
 * about to claim. It is this session's row, written moments early by its own
 * launcher; it is NOT a second session. So bootstrap COMPLETES it instead of
 * inserting a duplicate beside it.
 *
 * Two bugs die here:
 *  - the terminal launch itself. bootstrap's pre-pinned-owner freshness guard
 *    refuses an id that already has an un-ended row, so the launcher's own row
 *    made psu exit 1 — and since the one-liner is `exec psu`, that exit closed the
 *    window and surfaced as "its terminal closed before the session came online".
 *  - the ORPHAN. The headless path won that race the other way (its spawn helper
 *    returns slowly enough that psu registered first), leaving a registered row
 *    PLUS a starting row that never got a session_id — which `isFailedTerminalLaunch`
 *    later reads as a failed launch for a session that ran perfectly.
 *
 * Guarded to `session_id IS NULL AND ended_at IS NULL` so it can only ever complete
 * a genuine not-yet-online precursor: a row already carrying a session, or one the
 * reconciler has stamped, is left untouched and the caller falls back to inserting.
 * Returns true when this call did the adopting.
 */
export async function adoptStartingTerminalLaunch(opts: {
  id: number;
  sessionId: string | null;
  role?: string | null;
  feature?: string | null;
  planSlug?: string | null;
  label?: string | null;
  cwd?: string | null;
  mode?: string | null;
  launchArgv?: string[] | null;
}): Promise<boolean> {
  try {
    const { sql } = getOrgPg();
    const rows = await sql<{ id: number }[]>`
      UPDATE harness_shared.adv_sessions
         SET session_id = ${opts.sessionId},
             role       = COALESCE(${opts.role ?? null}, role),
             feature    = COALESCE(${opts.feature ?? null}, feature),
             plan_slug  = COALESCE(${opts.planSlug ?? null}, plan_slug),
             label      = COALESCE(${opts.label ?? null}, label),
             cwd        = COALESCE(${opts.cwd ?? null}, cwd),
             mode       = COALESCE(${opts.mode ?? null}, mode),
             launch_argv = COALESCE(
               ${opts.launchArgv ? JSON.stringify(opts.launchArgv) : null}::text::jsonb,
               launch_argv
             )
       WHERE id = ${opts.id}
         AND (
           display = ${DISPLAY_TERMINAL_LAUNCH}
           OR (display = 'workbench' AND launched_at IS NOT NULL)
         )
         AND session_id IS NULL
         AND ended_at IS NULL
       RETURNING id
    `;
    return rows.length > 0;
  } catch (e) {
    warnUnlessMissingTable(e, 'adoptStartingTerminalLaunch');
    return false;
  }
}

/**
 * Stamp the spawn result onto an already-written row.
 *
 * `terminalBin` is optional and COALESCE'd (WI-37743): a caller that writes its
 * starting row BEFORE spawning — which is the only ordering that lets
 * {@link adoptStartingTerminalLaunch} work at all, since a booting psu races
 * the launcher — has no pid or terminal yet, and fills both in here once the
 * spawn returns. Omitting it must never blank a value another writer set.
 *
 * `workspaceId` overrides the ambient workspace (WI-10002854). The wake
 * executor runs on the await plane, which is pinned to the coordination
 * workspace (WI-3575), so the ambient id there is not necessarily the one that
 * owns the row. Without the override that UPDATE matched zero rows and did not
 * report it.
 */
export async function setAdvSessionPid(
  id: number,
  pid: number | null,
  terminalBin?: string | null,
  workspaceId?: string | null,
): Promise<void> {
  try {
    const { sql } = getOrgPg();
    await sql`
      UPDATE harness_shared.adv_sessions
         SET pid = ${pid},
             terminal_bin = COALESCE(${terminalBin ?? null}, terminal_bin)
       WHERE id = ${id}
         AND workspace_id = ${workspaceId || activeWorkspaceId()}
    `;
  } catch (e) {
    warnUnlessMissingTable(e, 'setAdvSessionPid');
  }
}

export async function setAdvSessionWindowId(id: number, windowId: string | null): Promise<void> {
  const trimmed = windowId?.trim() || null;
  if (!trimmed) return;
  try {
    const { sql } = getOrgPg();
    await sql`
      UPDATE harness_shared.adv_sessions
         SET window_id = ${trimmed}
       WHERE id = ${id}
         AND workspace_id = ${activeWorkspaceId()}
    `;
  } catch (e) {
    warnUnlessMissingTable(e, 'setAdvSessionWindowId');
  }
}

export type AdvSessionLinkResult = 'linked' | 'already_linked' | 'not_found' | 'conflict';

export async function setAdvSessionOmpThreadId(id: number, ompThreadId: string): Promise<AdvSessionLinkResult> {
  const trimmed = ompThreadId.trim();
  if (!trimmed) return 'not_found';
  try {
    const { sql } = getOrgPg();
    const currentRows = await sql<Array<{ omp_thread_id: string | null }>>`
      SELECT omp_thread_id
        FROM harness_shared.adv_sessions
       WHERE id = ${id}
         AND workspace_id = ${activeWorkspaceId()}
       LIMIT 1
    `;
    const current = currentRows[0];
    if (!current) return 'not_found';
    if (current.omp_thread_id === trimmed) return 'already_linked';
    if (current.omp_thread_id != null && current.omp_thread_id !== trimmed) return 'conflict';
    await sql`
      UPDATE harness_shared.adv_sessions
         SET omp_thread_id = ${trimmed}
       WHERE id = ${id}
         AND workspace_id = ${activeWorkspaceId()}
    `;
    return 'linked';
  } catch (e) {
    warnUnlessMissingTable(e, 'setAdvSessionOmpThreadId');
    return 'not_found';
  }
}

/**
 * Is this row's `endedAt` an OBSERVATION of the session ending, or the moment a sweeper
 * NOTICED it was already gone?
 *
 * ⚠ Do NOT try to infer this from `exitCode`. The obvious shortcut — "exitCode == null
 * means a sweeper wrote it" — is WRONG: `harness/spawn.ts` passes `r.exitCode ?? null`,
 * so a genuine self-report also writes NULL. That inference over-fires on real
 * self-reports, which is the same confident-wrong-answer this function exists to prevent.
 *
 * `endedBy == null` (a legacy row) is UNKNOWN provenance and is treated as un-attributed,
 * NOT as 'self' — absence of attribution is not evidence of a clean exit.
 */
export function isObserverEndedSession(row: Pick<AdvSessionRow, 'endedAt' | 'endedBy'>): boolean {
  if (row.endedAt == null) return false;
  // ⚠ NOT `!== 'self'`. A 'signal' row was watched by its live parent, so its timestamp
  // is every bit as good as a self-report — it is the VOLUNTARINESS that differs, and
  // that question belongs to isInvoluntaryEnd. Collapsing the two axes here would make
  // every killed session's end time read as an unreliable NOTICE time, which is a fresh
  // wrong answer rather than a fix (WI-38054).
  return !OBSERVED_END_WRITERS.has(row.endedBy as AdvSessionEndedBy);
}

/**
 * Was this session KILLED rather than allowed to exit?
 *
 * The question `ended_by`'s original single axis could not answer, and the one the
 * owner actually needed: a reaped agent and a finished agent looked identical.
 *
 * Deliberately FALSE for the sweeper writers. A `'reaper'` row means "the process was
 * already gone when we looked" — we genuinely do not know whether it was killed or
 * exited, and answering `true` would assert a cause nobody observed. Only `'signal'`,
 * where a live parent watched the kill land, is a positive observation of one.
 */
export function isInvoluntaryEnd(row: Pick<AdvSessionRow, 'endedBy'>): boolean {
  return row.endedBy === 'signal';
}

/**
 * Validate a launcher-reported killing signal, returning the signal NAME or `null`.
 *
 * This string arrives over HTTP from the psu launcher and is then persisted as the
 * stated reason an agent died, so it is SHAPE-CHECKED rather than trusted: only a real
 * signal name is storable.
 *
 * ⚠ The failure mode to keep in mind is that rejecting is NOT free. A rejected value
 * degrades to `'self'` — i.e. "it exited voluntarily" — so an over-strict rule here
 * silently recreates the very bug this fixes, for whichever signal it fails to match.
 * That is why the pattern accepts digits (`signalNameFromCode` emits `SIG<number>` for a
 * signal this Node build cannot name) rather than only a closed list of known names.
 */
export function parseKilledBySignalReport(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  return /^SIG[A-Z0-9]{1,15}$/.test(raw) ? raw : null;
}

/**
 * Decide `ended_by` for a child whose exit THIS process watched.
 *
 * The rule is one line, but it was re-encoded inline at three separate writers
 * (`harness/spawn.ts`, `agent-mcp/console-launch.ts`, `agent-mcp/bootstrap-su.ts`), and
 * a rule spelled out three times is a rule that drifts. It did: `spawn.ts` tested only
 * its OWN timeout flag, so a worker killed by anything else — a sidecar restart tearing
 * down the cgroup (the original WI-38054 scenario), a peer's `processes:kill`, the OOM
 * killer — was recorded as a voluntary exit (EI-21908787009967815).
 *
 * ⚠ The asymmetry that makes this worth centralizing: the two mistakes are NOT equally
 * bad. Recording a kill as `'self'` produces a row that positively ASSERTS the session
 * chose to stop, and `isInvoluntaryEnd` then answers false — a silent wrong answer.
 * Recording a voluntary exit as `'signal'` is merely wrong and loud: it names a signal
 * that will not survive scrutiny. So this resolves toward `'signal'` on ANY positive
 * evidence of a kill, and reaches `'self'` only when nothing observed one.
 *
 * ⚠ `exitCode` is deliberately NOT an input. The 128+N convention looks like it could
 * settle this for free, but a process may exit 143 of its own accord, so inferring a
 * kill from the number manufactures exactly the attribution migration 800 refuses to
 * invent. Only a signal someone actually OBSERVED counts.
 */
export function endedByForObservedExit(
  observedSignal: string | null | undefined,
  opts: { killedByUs?: boolean; killedByUsSignal?: string } = {},
): { endedBy: Extract<AdvSessionEndedBy, 'self' | 'signal'>; signal: string | null } {
  // A signal the runtime reported wins: it is the strongest evidence available, and it
  // names the ACTUAL signal rather than the one we assume we sent.
  if (observedSignal != null && observedSignal !== '') {
    return { endedBy: 'signal', signal: observedSignal };
  }
  // A kill we performed ourselves is still a kill even when the runtime surfaced no
  // signal — a caught SIGTERM can exit 0 and look perfectly voluntary.
  if (opts.killedByUs) {
    return { endedBy: 'signal', signal: opts.killedByUsSignal ?? 'SIGTERM' };
  }
  return { endedBy: 'self', signal: null };
}

/**
 * The caveat for a row's `exit_code`, or `null` when the number means what it says.
 *
 * MEASURED against the real node-pty in this tree: killing a child with SIGHUP yields
 * `{ exitCode: 0, signal: 1 }`. The zero is a placeholder, not a status — so a KILLED
 * session carries the most persuasive possible evidence of a clean exit. Two of the
 * owner's agents were read as voluntary exits on exactly that zero (WI-38054).
 *
 * Pass the result through {@link withFieldReliability}, which is a no-op for an empty
 * caveat list, so healthy rows gain no noise.
 */
export function advSessionExitCodeCaveat(
  row: Pick<AdvSessionRow, 'endedAt' | 'endedBy' | 'exitCode'>,
  field = 'exitCode',
): FieldCaveat | null {
  if (row.endedBy !== 'signal') return null;
  return caveat({
    field,
    reliability: 'inferred',
    cannotAnswer: 'did this session exit cleanly?',
    insteadRead: 'ended_signal — the signal that killed it; this exit code is a placeholder',
    because:
      'node-pty reports a signal death as exitCode 0 with the signal in a separate field, ' +
      'so a killed session records the same 0 a clean exit does. Measured 2026-08-12 (WI-38054): ' +
      'two owner-launched agents killed by a sidecar restart both recorded exit 0.',
  });
}

/**
 * The field-reliability caveat for a row whose `endedAt` a sweeper wrote — or `null` when
 * the row's end time is a real observation and the result needs no caveat.
 *
 * Pass the result through {@link withFieldReliability}; it returns the object unchanged
 * when the caveat list is empty, so callers need no conditional.
 */
export function advSessionEndedAtCaveat(
  row: Pick<AdvSessionRow, 'endedAt' | 'endedBy'>,
  field = 'endedAt',
): FieldCaveat | null {
  if (!isObserverEndedSession(row)) return null;
  const who =
    row.endedBy == null
      ? 'a row predating migration 735, so its writer is unknown'
      : `the ${row.endedBy}, which stamps now() on NOTICING a process that had already gone`;
  return caveat({
    field,
    reliability: 'inferred',
    cannotAnswer: 'when did this session actually end?',
    insteadRead: "coord_presence.last_active_at for this session's owner — the last turn it actually took",
    because: `written by ${who}. Measured 2026-08-02 (WI-7126): one sweep stamped 9 rows within 13ms, one of them gone since 20 July — an artificial cluster that read as a simultaneous mass kill.`,
  });
}

/**
 * Every field-reliability caveat that applies to one row, ready to attach via
 * {@link withFieldReliability} — the combinator every adv_session-row reading surface
 * should call.
 *
 * EI-22176001691325872: {@link advSessionEndedAtCaveat} and {@link advSessionExitCodeCaveat}
 * were built, unit-tested, and correct, but had ZERO production callers — every real reading
 * surface rendered a bare `endedAt`/`exitCode` with nothing attached. This is the one place
 * that combines them so a surface needs only one call, not two easy-to-forget ones.
 */
export function advSessionRowCaveats(row: Pick<AdvSessionRow, 'endedAt' | 'endedBy' | 'exitCode'>): FieldCaveat[] {
  const caveats: FieldCaveat[] = [];
  const endedAtCaveat = advSessionEndedAtCaveat(row);
  if (endedAtCaveat) caveats.push(endedAtCaveat);
  const exitCodeCaveat = advSessionExitCodeCaveat(row);
  if (exitCodeCaveat) caveats.push(exitCodeCaveat);
  return caveats;
}

/**
 * The one phrase every PROSE surface should use to describe when a session ended.
 *
 * Prose is where this goes wrong most quietly: a structured field can carry a caveat
 * beside it, but `ended ${endedAt}` states a time as fact with nowhere to put the doubt.
 * Three outcomes, and only the first is an actual end time:
 *
 *   'ended 2026-08-02T18:26:03Z'                     — self-reported, a real observation
 *   'last recorded … — that is when the reaper NOTICED it was gone, not when it ended'
 *   'end time unknown'                               — never ended, or no timestamp
 */
export function describeSessionEndTime(
  row: Pick<AdvSessionRow, 'endedAt' | 'endedBy'> & Partial<Pick<AdvSessionRow, 'endedSignal'>>,
): string {
  if (row.endedAt == null) return 'end time unknown';
  if (row.endedBy === 'self') return `ended ${row.endedAt}`;
  if (row.endedBy === 'signal') {
    // Both halves are load-bearing. The TIME is a real observation, so state it plainly
    // — hedging it would destroy the "several agents died in the same second" signature
    // that is the only way a mass reap is currently detectable. The KILL is the half
    // that must never be droppable, so it leads the clause. Name the signal when we
    // have it and stay silent when we do not, rather than inventing a plausible one.
    const bySignal = row.endedSignal ? ` by ${row.endedSignal}` : '';
    return `KILLED${bySignal} at ${row.endedAt} — an observed end time, but NOT a voluntary exit`;
  }
  const who = row.endedBy ?? 'an unrecorded writer';
  return `last recorded ${row.endedAt} — that is when ${who} NOTICED it was gone, not when it ended`;
}

/**
 * Does the persisted row contain positive terminal evidence?
 *
 * Normally `ended_at` and `ended_by` are written together. A non-null writer
 * without its timestamp is still terminal evidence, though: treating that
 * half-written tuple as live is the stale-binding bug this predicate prevents.
 */
export function hasAdvSessionTerminalEvidence(
  row: Pick<AdvSessionRow, 'endedAt' | 'endedBy'> | null | undefined,
): boolean {
  return row != null && (row.endedAt != null || row.endedBy != null);
}

export interface AdvSessionExpectedBinding {
  coordOwnerId: string;
  sessionId: string | null;
  /** PostgreSQL's full-precision started_at::text, never a JS Date round-trip. */
  startedAt: string;
}

/**
 * Mark a session ended. Returns whether the row was updated.
 *
 * `endedBy` is REQUIRED on purpose: a row that cannot say who ended it cannot say whether
 * its `ended_at` is an observation, and that ambiguity is what made a sweep look like a
 * mass kill (WI-7126). Pass `'self'` ONLY when this process actually observed the
 * session's own exit.
 *
 * ⚠ AND ONLY WHEN THAT EXIT WAS VOLUNTARY. Observing a child die is not the same as the
 * child choosing to die: if it was killed, pass `'signal'` with `opts.signal`, not
 * `'self'`. Reporting a kill as `'self'` is what silently reaped two of the owner's
 * agents (WI-38054) — and because node-pty hands a signal death an `exitCode` of 0, the
 * resulting row actively asserts a clean exit instead of merely failing to describe one.
 */
export async function markAdvSessionEnded(
  id: number,
  exitCode: number | null,
  endedBy: AdvSessionEndedBy,
  opts: {
    signal?: string | null;
    /**
     * Lifecycle telemetry is normally best-effort, but callers that are about
     * to release an idempotency/ownership guard must know the terminal write
     * landed first. In that narrow case, rethrow instead of converting a DB
     * failure into a warning so the caller can keep its guard fail-closed.
     */
    throwOnError?: boolean;
    /** Refuse to end a reactivated/re-anchored successor using an old observation. */
    expectedBinding?: AdvSessionExpectedBinding;
    /**
     * WI-10002854: WHEN the reporter observed the exit. A row whose `started_at` is LATER
     * than this was reactivated by a successor incarnation after the observation (a wake
     * executor's headless resume, a relaunch), so the observation is about a predecessor
     * and must not end it. Without this, the killed terminal's late or replayed end report
     * re-ended the row a headless wake had just resumed; the next resume claim then read
     * it as terminal and won, leaving two live processes on one coord identity. Omitted
     * (legacy reporters) keeps the unguarded behaviour.
     */
    observedAt?: Date | null;
  } = {},
): Promise<boolean> {
  try {
    const { sql } = getOrgPg();
    // The CHECK (migration 800) allows a signal name ONLY on a 'signal' row; normalise
    // here so a caller that passes both can never trip a constraint violation on the
    // telemetry path, which is best-effort and must never throw into an exiting session.
    const endedSignal = endedBy === 'signal' ? (opts.signal ?? null) : null;
    const r = await sql`
      UPDATE harness_shared.adv_sessions
         SET ended_at = now(), exit_code = ${exitCode}, ended_by = ${endedBy},
             ended_signal = ${endedSignal}, resume_claim_key = NULL,
             resume_claimed_at = NULL
       WHERE id = ${id} AND ended_at IS NULL
         AND (${opts.expectedBinding == null} OR (
           coord_owner_id = ${opts.expectedBinding?.coordOwnerId ?? null}
           AND session_id IS NOT DISTINCT FROM ${opts.expectedBinding?.sessionId ?? null}
           AND started_at = ${opts.expectedBinding?.startedAt ?? null}::timestamptz
         ))
         AND (${opts.observedAt == null} OR started_at <= ${opts.observedAt ?? null}::timestamptz)
       RETURNING id
    `;
    if (r.length) {
      // EI-21185611167428939: the psu parent can authoritatively observe +
      // record a child exit even when the separate best-effort SessionEnd
      // lifecycle hook never reaches activity:report. Schedule the same lease
      // hygiene behind a short settle/liveness check so a genuine death cannot
      // strand file/resource locks or work-item claims until TTL, while a
      // carry/resume successor under the same owner remains protected.
      void trackDetached(import('./session-end-lease-release-hook')
        .then((m) => m.scheduleSessionEndLeaseRelease(id)))
        .catch((e) => console.warn(`[adv-sessions] lease-release hook unavailable: ${(e as Error)?.message ?? e}`));
      // End-of-session fast path (session-db-archive-retire-dirs-2026-07-10
      // P-004): archive-then-delete the session's files after a settle delay.
      // Dynamic import: no module cycle, and this hot end path stays free of
      // FS/zstd imports. Fire-and-forget — ending never blocks on archival;
      // a missed schedule is caught by the P-006 reconciler.
      void trackDetached(import('./session-archive-hook')
        .then((m) => m.scheduleArchiveForAdvSession(id)))
        .catch((e) => console.warn(`[adv-sessions] archive hook unavailable: ${(e as Error)?.message ?? e}`));
    }
    return r.length > 0;
  } catch (e) {
    if (opts.throwOnError) throw e;
    warnUnlessMissingTable(e, 'markAdvSessionEnded');
    return false;
  }
}

/**
 * Repair the impossible half-terminal state left by an observer that recorded
 * `ended_by` before its `ended_at` write completed.  A non-null writer is
 * terminal evidence, so an open timestamp makes every liveness reader disagree
 * with the teardown writer and can strand the owner as an apparently-live
 * session.  The predicate is deliberately narrow and idempotent: it fills only
 * the missing timestamp and never overwrites an existing terminal tuple.
 *
 * The repair is owner-scoped because the two callers that need it are resolving
 * one target. It is best-effort like the other adv-session lifecycle helpers;
 * callers use {@link hasAdvSessionTerminalEvidence} so a failed timestamp repair
 * cannot erase the terminal meaning already carried by `ended_by`.
 */
export async function repairStaleAdvSessionTerminalMarkers(coordOwnerId: string): Promise<number> {
  if (!coordOwnerId.trim()) return 0;
  try {
    const { sql } = getOrgPg();
    const rows = await sql<{ id: number }[]>`
      UPDATE harness_shared.adv_sessions
         SET ended_at = now()
       WHERE coord_owner_id = ${coordOwnerId}
         AND ended_at IS NULL
         AND ended_by IS NOT NULL
       RETURNING id
    `;
    return rows.length;
  } catch (e) {
    warnUnlessMissingTable(e, 'repairStaleAdvSessionTerminalMarkers');
    return 0;
  }
}

/**
 * Re-activate a tracked session row on RESUME — the inverse of
 * `markAdvSessionEnded` (presence-derive-from-session-log-2026-06-22 P-002 /
 * resume-visibility).
 *
 * `psu --resume` brings the agent PROCESS back to life, but `launchResume` does
 * NOT re-POST bootstrap-su, so the row kept the `ended_at`/`exit_code` from the
 * PRIOR exit — leaving a RUNNING agent recorded as dead, hence invisible to the
 * roster + presence-as-a-view (which correctly trust "ended means ended"). This
 * clears that stamp so a resumed session shows live the instant it resumes,
 * before it touches coord. `started_at` is bumped to now() so this incarnation
 * reads as freshly-live for the roster's recency window (the row represents the
 * CURRENT live session; resume time is its real "live since"). Idempotent: only
 * an already-ENDED row is touched. Returns true when this call re-activated a
 * row (false = no such ended row — already live, unknown id, or DB error).
 */
/**
 * Record the managed host's positive acknowledgement of session:end before
 * the child exits. This is separate from markAdvSessionEnded because the
 * force-release guard needs a durable teardown signal during the short
 * interval where the host has accepted shutdown but the child has not yet
 * posted its exit. Best-effort like the other lifecycle bookkeeping.
 */
export async function markAdvSessionShutdownAcceptedByOwner(coordOwnerId: string): Promise<boolean> {
  if (!coordOwnerId) return false;
  try {
    const { sql } = getOrgPg();
    const rows = await sql<{ id: number }[]>`
      UPDATE harness_shared.adv_sessions
         SET shutdown_accepted_at = now()
       WHERE id = (
         SELECT id FROM harness_shared.adv_sessions
          WHERE coord_owner_id = ${coordOwnerId}
            AND ended_at IS NULL
          ORDER BY started_at DESC
          LIMIT 1
       )
      RETURNING id
    `;
    return rows.length > 0;
  } catch (e) {
    warnUnlessMissingTable(e, 'markAdvSessionShutdownAcceptedByOwner');
    return false;
  }
}

/**
 * How recently a resume claim must have been taken for a LATER claimant to be
 * treated as the loser of a live race rather than the resumer of a stale row.
 * Comfortably longer than an agent spawn + bootstrap handshake (tens of
 * seconds): once the resumed process is up it registers presence, and the wake
 * executor parks on liveness long before it reaches the claim at all.
 */
const RESUME_CLAIM_WINDOW_SEC = 300;

/** Default lifetime of a psu resume reservation. This is deliberately much
 * shorter than the retired five-minute started_at claim window: normal
 * launcher setup completes in seconds, while a dead launcher must not strand
 * an intentionally ended session. Callers may pass a measured override. */
export const RESUME_RESERVATION_LEASE_SEC = 60;
/** Upper clamp on any requested resume reservation lease. The delayed
 * session-end lease cleanup treats a reservation younger than this as a resume
 * still starting up (EI-24355092354007517); its local copy is pinned to this. */
export const RESUME_RESERVATION_MAX_LEASE_SEC = 300;

/**
 * Positive local evidence that an exact resume has no competing agent process.
 *
 * This is intentionally a closed discriminant rather than a boolean. A missing
 * or malformed probe result is unknown and must not weaken the recent-row race
 * guard. The launcher is the only producer today; the server validates it again
 * because this endpoint is a trust boundary.
 *
 * Each kind names the ORACLE that produced it, and each oracle can only speak
 * for one agent backend:
 *   - `no-live-codex-writer`  — codex's own thread-writer flock reported free
 *     (WI-41663).
 *   - `no-live-claude-process` — no psu PTY host AND a complete `/proc` scan
 *     found no live argv carrying the native session id (WI-2141892).
 * {@link ADV_SESSION_LIVENESS_EVIDENCE_AGENT} binds them, so a claude witness can
 * never reconcile a codex row: the two probes ask genuinely different questions
 * and a cross-applied one would be an unearned liveness claim.
 */
export type AdvSessionLocalLivenessEvidenceKind =
  | 'no-live-codex-writer'
  | 'no-live-claude-process'
  | 'no-live-omp-process';

export type AdvSessionLocalLivenessEvidence = {
  version: 1;
  kind: AdvSessionLocalLivenessEvidenceKind;
};

/** Which `agent` each witness kind is allowed to reconcile. */
export const ADV_SESSION_LIVENESS_EVIDENCE_AGENT: Readonly<Record<AdvSessionLocalLivenessEvidenceKind, string>> =
  Object.freeze({
    'no-live-codex-writer': 'codex',
    'no-live-claude-process': 'claude',
    'no-live-omp-process': 'omp',
  });

/** Strict runtime validation for the local-liveness trust-boundary payload. */
export function isAdvSessionLocalLivenessEvidence(value: unknown): value is AdvSessionLocalLivenessEvidence {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  return (
    keys.length === 2 &&
    keys.every((key) => key === 'version' || key === 'kind') &&
    record.version === 1 &&
    typeof record.kind === 'string' &&
    Object.prototype.hasOwnProperty.call(ADV_SESSION_LIVENESS_EVIDENCE_AGENT, record.kind)
  );
}

/**
 * Does this witness speak for this row's agent backend? False for an absent or
 * malformed witness, and false for a kind produced by another backend's oracle.
 */
export function advSessionLivenessEvidenceCoversAgent(agent: string | null, evidence: unknown): boolean {
  if (!isAdvSessionLocalLivenessEvidence(evidence)) return false;
  return ADV_SESSION_LIVENESS_EVIDENCE_AGENT[evidence.kind] === agent;
}

export type AdvSessionResumeReservation =
  | {
      status: 'acquired';
      acquired: true;
      replayed: boolean;
      leaseExpiresAt: string;
    }
  | {
      status: 'reserved';
      acquired: false;
      retryAfterMs: number;
      leaseExpiresAt: string;
    }
  | { status: 'live'; acquired: false }
  | { status: 'missing'; acquired: false };

/**
 * Reserve the right to resume one adv-session WITHOUT asserting liveness.
 *
 * The row itself is the durable idempotency receipt: replaying `key` returns
 * the acquired verdict after an unknown HTTP outcome. A competing unexpired
 * key gets a typed reservation response; an expired key is atomically replaced.
 * Terminal rows are eligible immediately. Legacy active rows remain eligible
 * only after the established stale-process window, preserving recovery for old
 * sessions whose parent never recorded their exit.
 */
export async function acquireAdvSessionResume(
  id: number,
  resumeClaimKey: string,
  leaseSec: number = RESUME_RESERVATION_LEASE_SEC,
  staleActiveSec: number = RESUME_CLAIM_WINDOW_SEC,
  localLivenessEvidence?: unknown,
): Promise<AdvSessionResumeReservation> {
  const key = resumeClaimKey.trim();
  if (!key) throw new Error('resumeClaimKey must be non-empty');
  const boundedLeaseSec = Math.max(1, Math.min(RESUME_RESERVATION_MAX_LEASE_SEC, Math.floor(leaseSec)));
  const boundedStaleSec = Math.max(1, Math.floor(staleActiveSec));
  const { sql } = getOrgPg();

  return sql.begin(async (tx) => {
    const [row] = await tx<
      Array<{
        agent: string | null;
        ended_at: Date | string | null;
        ended_by: string | null;
        started_at: Date | string;
        resume_claim_key: string | null;
        resume_claimed_at: Date | string | null;
      }>
    >`
      SELECT agent, ended_at, ended_by, started_at, resume_claim_key, resume_claimed_at
        FROM harness_shared.adv_sessions
       WHERE id = ${id}
       FOR UPDATE
    `;
    if (!row) return { status: 'missing', acquired: false } as const;

    const nowMs = Date.now();
    const claimedAtMs = row.resume_claimed_at == null ? null : new Date(row.resume_claimed_at).getTime();
    const leaseMs = boundedLeaseSec * 1_000;
    const leaseLive = claimedAtMs != null && claimedAtMs + leaseMs > nowMs;

    if (row.resume_claim_key && row.resume_claim_key !== key && leaseLive) {
      const leaseExpiresAt = new Date(claimedAtMs! + leaseMs).toISOString();
      return {
        status: 'reserved',
        acquired: false,
        retryAfterMs: Math.max(1, claimedAtMs! + leaseMs - nowMs),
        leaseExpiresAt,
      } as const;
    }

    const replayed = row.resume_claim_key === key;
    const terminal = row.ended_at != null || row.ended_by != null;
    const staleActive = new Date(row.started_at).getTime() <= nowMs - boundedStaleSec * 1_000;
    const expiredReservation = row.resume_claim_key != null && !leaseLive;
    // A recent unended row normally wins the fail-closed liveness decision.
    // Only a launcher-produced, strictly validated absence witness whose ORACLE
    // speaks for this row's backend may reconcile that one case; it never relaxes
    // the lease or the row lock. Without this, a session that died with no end
    // witness is unresumable for the whole recent-active window with no override
    // at all — PSU_FORCE_RESUME gates only psu's local double-host guard, never
    // this check (WI-41663 for codex, WI-2141892 for claude).
    const canReconcileRecentActive = advSessionLivenessEvidenceCoversAgent(row.agent, localLivenessEvidence);
    if (!replayed && !terminal && !staleActive && !canReconcileRecentActive && !expiredReservation) {
      return { status: 'live', acquired: false } as const;
    }

    const [reserved] = await tx<Array<{ lease_expires_at: Date | string }>>`
      UPDATE harness_shared.adv_sessions
         SET resume_claim_key = ${key}, resume_claimed_at = now()
       WHERE id = ${id}
      RETURNING resume_claimed_at + make_interval(secs => ${boundedLeaseSec}) AS lease_expires_at
    `;
    return {
      status: 'acquired',
      acquired: true,
      replayed,
      leaseExpiresAt: new Date(reserved.lease_expires_at).toISOString(),
    } as const;
  });
}

type AdvSessionResumeTransition = 'finalize' | 'release';

/**
 * Apply one keyed post-acquire transition with a durable replay receipt.
 *
 * The row update and receipt commit together. If the HTTP response is lost,
 * retrying the same session/key/transition reads the original boolean instead
 * of mistaking "the first request already cleared the reservation" for a key
 * mismatch. This reuses the launch-idempotency ledger already used by the legacy
 * keyed resume claim; it is not a second lifecycle registry.
 */
async function transitionAdvSessionResume(
  id: number,
  resumeClaimKey: string,
  transition: AdvSessionResumeTransition,
  launchArgv?: string[] | null,
): Promise<boolean> {
  const key = resumeClaimKey.trim();
  if (!key) return false;
  const { sql } = getOrgPg();
  const receiptKind = `psu-resume-${transition}`;
  const ledgerKey = `${receiptKind}:${id}:${key}`;

  return sql.begin(async (tx) => {
    const [target] = await tx<Array<{ workspace_id: string }>>`
      SELECT workspace_id
        FROM harness_shared.adv_sessions
       WHERE id = ${id}
    `;
    if (!target) return false;

    await tx`
      INSERT INTO harness_shared.agent_launch_idempotency
        (workspace_id, idempotency_key, launched_at, launched_by, summary)
      VALUES (${target.workspace_id}, ${ledgerKey}, ${Date.now()}, NULL, '{}'::jsonb)
      ON CONFLICT (workspace_id, idempotency_key) DO NOTHING
    `;
    const [receipt] = await tx<Array<{ summary: Record<string, unknown> }>>`
      SELECT summary
        FROM harness_shared.agent_launch_idempotency
       WHERE workspace_id = ${target.workspace_id}
         AND idempotency_key = ${ledgerKey}
       FOR UPDATE
    `;
    if (receipt?.summary?.kind === receiptKind && typeof receipt.summary.transitioned === 'boolean') {
      return receipt.summary.transitioned;
    }

    const rows =
      transition === 'finalize'
        ? await tx<{ id: number }[]>`
          UPDATE harness_shared.adv_sessions
             SET ended_at = NULL, exit_code = NULL, ended_by = NULL, ended_signal = NULL,
                 started_at = now(), shutdown_accepted_at = NULL,
                 resume_claim_key = NULL, resume_claimed_at = NULL,
                 launch_argv = COALESCE(
                   ${launchArgv == null ? null : JSON.stringify(launchArgv)}::text::jsonb,
                   launch_argv
                 )
           WHERE id = ${id} AND resume_claim_key = ${key}
          RETURNING id
        `
        : await tx<{ id: number }[]>`
          UPDATE harness_shared.adv_sessions
             SET resume_claim_key = NULL, resume_claimed_at = NULL
           WHERE id = ${id} AND resume_claim_key = ${key}
          RETURNING id
        `;
    const transitioned = rows.length > 0;
    const summary = JSON.stringify({ kind: receiptKind, transitioned });
    await tx`
      UPDATE harness_shared.agent_launch_idempotency
         SET summary = ${summary}::text::jsonb
       WHERE workspace_id = ${target.workspace_id}
         AND idempotency_key = ${ledgerKey}
    `;
    return transitioned;
  });
}

/** Assert liveness for a reservation after the managed host/direct child has
 * actually spawned. The key match is the one-writer proof. */
export async function finalizeAdvSessionResume(
  id: number,
  resumeClaimKey: string,
  launchArgv?: string[] | null,
): Promise<boolean> {
  return transitionAdvSessionResume(id, resumeClaimKey, 'finalize', launchArgv);
}

/** Release a pre-spawn/failed reservation while preserving terminal evidence. */
export async function releaseAdvSessionResume(id: number, resumeClaimKey: string): Promise<boolean> {
  return transitionAdvSessionResume(id, resumeClaimKey, 'release');
}

/**
 * EI-21247460909447431: claim the single-winner right to RESUME an adv session.
 *
 * This is the sole numeric-id launch-acquisition path. Do not substitute the
 * owner-keyed best-effort activity repair below: its false result is a harmless
 * no-op, while false here means "another writer won — do not spawn".
 *
 * Two shapes of row are legitimately resumable, and the claim must admit both:
 *   - `ended_at IS NOT NULL` — the clean-exit case.
 *   - a row NEVER marked ended, because the process died without recording its
 *     exit. These are not an edge case: 341 of the 469 such rows on this box
 *     are over a day old. An `ended_at IS NOT NULL`-only predicate makes every
 *     one of them permanently un-resumable — the wake parks forever, reporting
 *     a race that never happened.
 *
 * Single-winner is preserved by the `started_at` bump rather than by the ended
 * state: a competing resumer that just won sets `started_at = now()`, so a
 * second claimant inside the window loses. Outside the window, a stale-active
 * row means the previous winner's process is gone — a live one never reaches
 * this claim, because the executor parks on liveness first — so claiming it is
 * the correct outcome, not a double-spawn.
 *
 * Throws on a genuine datastore fault instead of swallowing it, so a caller can
 * tell "could not evaluate the claim" apart from "lost the race". Returning
 * `false` for an unreachable database would report a race that never happened.
 */
export async function claimAdvSessionResume(
  id: number,
  resumeClaimKey: string | null = null,
  windowSec: number = RESUME_CLAIM_WINDOW_SEC,
): Promise<boolean> {
  const { sql } = getOrgPg();
  const key = resumeClaimKey?.trim() || null;

  // Legacy callers did not carry a replay key. Preserve their single-winner
  // behavior, but clear the COMPLETE terminal tuple: ended_by/ended_signal are
  // positive terminal evidence too, and leaving them behind creates an
  // impossible half-live row after a successful resume.
  if (!key) {
    const rows = await sql<{ id: number }[]>`
      UPDATE harness_shared.adv_sessions
         SET ended_at = NULL, exit_code = NULL, ended_by = NULL, ended_signal = NULL,
             started_at = now(), shutdown_accepted_at = NULL,
             resume_claim_key = NULL, resume_claimed_at = NULL
       WHERE id = ${id}
         AND (
           ended_at IS NOT NULL
           OR ended_by IS NOT NULL
           OR started_at < now() - make_interval(secs => ${windowSec})
         )
         AND (
           resume_claim_key IS NULL
           OR resume_claimed_at < now() - make_interval(secs => ${RESUME_RESERVATION_LEASE_SEC})
         )
      RETURNING id
    `;
    return rows.length > 0;
  }

  // WI-41450: the old launcher used a hard HTTP deadline around this mutation.
  // When Postgres committed but the response arrived after that deadline, psu
  // failed closed and an immediate retry lost to the freshly bumped started_at
  // window. Use the existing agent-launch idempotency ledger as the durable
  // response cache: the row claim and its boolean verdict commit in ONE
  // transaction, so retrying the same key is safe after an unknown response.
  // SELECT ... FOR UPDATE also serializes two in-flight deliveries of that key;
  // the follower waits, then reads the winner's completed verdict.
  const ledgerKey = `psu-resume:${id}:${key}`;
  return sql.begin(async (tx) => {
    const [target] = await tx<Array<{ workspace_id: string }>>`
      SELECT workspace_id
        FROM harness_shared.adv_sessions
       WHERE id = ${id}
    `;
    if (!target) return false;

    const workspaceId = target.workspace_id;
    await tx`
      INSERT INTO harness_shared.agent_launch_idempotency
        (workspace_id, idempotency_key, launched_at, launched_by, summary)
      VALUES (${workspaceId}, ${ledgerKey}, ${Date.now()}, NULL, '{}'::jsonb)
      ON CONFLICT (workspace_id, idempotency_key) DO NOTHING
    `;
    const [ledger] = await tx<Array<{ summary: Record<string, unknown> }>>`
      SELECT summary
        FROM harness_shared.agent_launch_idempotency
       WHERE workspace_id = ${workspaceId}
         AND idempotency_key = ${ledgerKey}
       FOR UPDATE
    `;
    const prior = ledger?.summary;
    if (prior?.kind === 'psu-resume-claim' && typeof prior.reactivated === 'boolean') {
      return prior.reactivated;
    }

    const rows = await tx<{ id: number }[]>`
      UPDATE harness_shared.adv_sessions
         SET ended_at = NULL, exit_code = NULL, ended_by = NULL, ended_signal = NULL,
             started_at = now(), shutdown_accepted_at = NULL,
             resume_claim_key = NULL, resume_claimed_at = NULL
       WHERE id = ${id}
         AND (
           ended_at IS NOT NULL
           OR ended_by IS NOT NULL
           OR started_at < now() - make_interval(secs => ${windowSec})
         )
         AND (
           resume_claim_key IS NULL
           OR resume_claim_key = ${key}
           OR resume_claimed_at < now() - make_interval(secs => ${RESUME_RESERVATION_LEASE_SEC})
         )
      RETURNING id
    `;
    const reactivated = rows.length > 0;
    const summary = JSON.stringify({ kind: 'psu-resume-claim', reactivated });
    await tx`
      UPDATE harness_shared.agent_launch_idempotency
         SET summary = ${summary}::text::jsonb
       WHERE workspace_id = ${workspaceId}
         AND idempotency_key = ${ledgerKey}
    `;
    return reactivated;
  });
}

/**
 * WI-573 (honest-presence): reactivate a resumed session's adv row keyed by its COORD owner id,
 * for resume paths that never re-POST bootstrap-su (harness compaction, or any resume that is not
 * `psu --resume`). Called from the declared-activity presence write so the instant a live agent
 * declares intent / orients, a stale `ended_at` left by a prior incarnation is cleared and it reads
 * LIVE instead of `ended`. Touches only the most-recent row carrying EITHER half
 * of the terminal tuple for that owner; idempotent + cheap (a 0-row no-op when
 * the session is already live). This covers non-launch resume
 * paths that prove liveness through genuine activity. Returns true when a row was re-activated.
 */
export async function reactivateAdvSessionByOwner(coordOwnerId: string): Promise<boolean> {
  if (!coordOwnerId) return false;
  try {
    const { sql } = getOrgPg();
    // EI-21417550055038906: clear the COMPLETE terminal tuple, exactly as
    // claimAdvSessionResume does. Clearing only ended_at left ended_by/
    // ended_signal residue on the re-activated row, so the next incarnation's
    // lost teardown re-created the half-terminal shape (ended_by='signal',
    // ended_at NULL) that the pre-pinned freshness guard then read as a live
    // binding — 409-ing the owner's own successor (row 18422, measured twice).
    // Native startup can itself emit MCP presence before a keyed resumer is
    // ready. Only that resumer may finalize its lease; generic activity must
    // leave both the reservation and terminal evidence intact. Keep this on
    // the UPDATE, so a concurrent acquire is rechecked under the row lock.
    const rows = await sql<{ id: number }[]>`
      UPDATE harness_shared.adv_sessions AS target
         SET ended_at = NULL, exit_code = NULL, ended_by = NULL, ended_signal = NULL,
             started_at = now(), shutdown_accepted_at = NULL
       WHERE id = (
         SELECT id FROM harness_shared.adv_sessions
          WHERE coord_owner_id = ${coordOwnerId}
            AND (ended_at IS NOT NULL OR ended_by IS NOT NULL)
          ORDER BY started_at DESC
          LIMIT 1
       )
         AND resume_claim_key IS NULL
         -- Owner activity may come from a NEW row. Reviving its retired
         -- predecessor would make that older artifact newest to the kernel.
         AND NOT EXISTS (
           SELECT 1 FROM harness_shared.adv_sessions active
            WHERE active.coord_owner_id = target.coord_owner_id
              AND active.workspace_id = target.workspace_id
              AND active.ended_at IS NULL AND active.ended_by IS NULL
         )
      RETURNING id
    `;
    return rows.length > 0;
  } catch (e) {
    warnUnlessMissingTable(e, 'reactivateAdvSessionByOwner');
    return false;
  }
}

/**
 * WI-5075 (P-018 carry-respawn kill loop): re-anchor a tracked session row's
 * NATIVE session id after a managed-host respawn (carry-respawn / cold RECYCLE).
 *
 * psu-pty-host's recycleChild kills the Claude child and boots a successor under
 * a FRESH `--session-id`, but this row — the authoritative owner→native mapping
 * that `resolveSessionRef` / `estimateContextTokensForOwner` read — kept naming
 * the dead predecessor. The compaction watchdog's context estimate therefore
 * stayed pinned to the predecessor's over-limit transcript and re-killed every
 * successor at each retry-grace expiry (193 CARRY-RESPAWN firings 2026-07-15/16).
 * Updating `session_id` in place keeps the row the SAME logical session (same
 * coord owner, same pty, same adv id) while tracking the live incarnation;
 * ended/exit stamps are cleared and `started_at` bumped for the same
 * resume-visibility reasons as {@link claimAdvSessionResume}. Idempotent per
 * native id; returns true when a row was updated.
 */
export async function reanchorAdvSessionNativeId(
  id: number,
  sessionId: string,
): Promise<{ reanchored: boolean; owner: string | null }> {
  if (!sessionId) return { reanchored: false, owner: null };
  try {
    const { sql } = getOrgPg();
    // ⚠ `RETURNING coord_owner_id` — there is NO `owner` column on adv_sessions.
    // The original WI-5075 ship wrote `RETURNING id, owner`, which made the WHOLE
    // statement throw 42703 into the catch below: the re-anchor silently never
    // committed for ANY cohort and only the watchdog's streak breaker masked it
    // (the 2026-07-18 su-57b6247d 3-successor kill loop).
    // EI-21417550055038906: clear the COMPLETE terminal tuple (ended_by/
    // ended_signal too, matching claimAdvSessionResume) — leaving them behind
    // creates a half-live row whose residue later reads as terminal evidence.
    const rows = await sql<{ id: number; owner: string | null }[]>`
      UPDATE harness_shared.adv_sessions
         SET session_id = ${sessionId}, ended_at = NULL, exit_code = NULL, ended_by = NULL,
             ended_signal = NULL, started_at = now(), shutdown_accepted_at = NULL,
             resume_claim_key = NULL, resume_claimed_at = NULL
       WHERE id = ${id} AND session_id IS DISTINCT FROM ${sessionId}
      RETURNING id, coord_owner_id AS owner
    `;
    // The owner rides back so the respawn route can clear the frozen context
    // gauge (the successor keeps the coord ownerId, so the in-process usage
    // cache would otherwise serve the DEAD predecessor's near-limit estimate
    // for up to a watchdog cadence — the "89% on a fresh successor" bug).
    if (rows.length > 0) return { reanchored: true, owner: rows[0]?.owner ?? null };
    // WI-41555: a NO-OP re-anchor is NOT "no owner". The UPDATE above is guarded
    // by `session_id IS DISTINCT FROM`, so a row that ALREADY names this native
    // id matches ZERO rows — exactly what happens when the spawn path stamped the
    // new id onto the row before this report arrived (the cold-loop recycle
    // cohort), and on any retried or duplicated report. Returning owner:null
    // there made the caller skip the very context-cache clears the comment above
    // promises, and the anchored gauge then served the DEAD predecessor's
    // reading FOREVER — not merely "for up to a watchdog cadence", because
    // advanceAnchor's fast path never re-resolves whether its cached path is
    // still the live transcript for this owner.
    // `reanchored` answers "did I change the row"; `owner` answers "whose row is
    // it". They are independent facts, and respawn hygiene keys off the second.
    const existing = await sql<{ owner: string | null }[]>`
      SELECT coord_owner_id AS owner FROM harness_shared.adv_sessions WHERE id = ${id}
    `;
    return { reanchored: false, owner: existing[0]?.owner ?? null };
  } catch (e) {
    warnUnlessMissingTable(e, 'reanchorAdvSessionNativeId');
    return { reanchored: false, owner: null };
  }
}

/**
 * Owner-keyed sibling of {@link reanchorAdvSessionNativeId} for sessions with NO
 * numeric adv id in their environment — an interactive `psu` / `psu --resume`
 * launch never gets PAPERCUSP_ADV_SESSION_ID, so its respawn report can only
 * name the coord ownerId. Without this path that whole cohort was invisible to
 * WI-5075: its adv row kept naming the dead predecessor and the compaction
 * watchdog re-killed each successor (2026-07-18 su-57b6247d, 3 cuts in 16 min).
 * Re-anchors an UNAMBIGUOUS row for the owner. A coord owner can temporarily
 * have more than one non-ended adv row while a launcher handoff is settling;
 * choosing by `started_at` in that shape can point the native id at a different
 * row's per-session CODEX_HOME (WI-42507). Prefer the sole active row, or the
 * sole row when no active row remains; refuse an ambiguous owner rather than
 * corrupting the owner→native mapping. Idempotent per native id.
 */
export async function reanchorAdvSessionNativeIdByOwner(
  coordOwnerId: string,
  sessionId: string,
): Promise<{ reanchored: boolean; owner: string | null }> {
  if (!coordOwnerId || !sessionId) return { reanchored: false, owner: null };
  try {
    const { sql } = getOrgPg();
    // `started_at` is a mutable activation clock (resume/re-anchor bumps it),
    // not a stable row identity. The exact adv id is preferred everywhere, but
    // legacy owner-only reports still need a safe fallback. Select the sole
    // active row; if there is no active row, accept only a single total row.
    // Two active rows (or two terminal rows) are ambiguous and must not let one
    // session's native id overwrite another session's home key.
    const target = await sql<{ id: number }[]>`
      WITH owner_rows AS (
        SELECT id,
               ended_at,
               ended_by,
               count(*) FILTER (WHERE ended_at IS NULL AND ended_by IS NULL) OVER () AS active_count,
               count(*) OVER () AS total_count
          FROM harness_shared.adv_sessions
         WHERE coord_owner_id = ${coordOwnerId}
      ), target AS (
        SELECT id
          FROM owner_rows
         WHERE (active_count = 1 AND ended_at IS NULL AND ended_by IS NULL)
            OR (active_count = 0 AND total_count = 1)
      )
      SELECT id FROM target LIMIT 1
    `;
    const targetId = target[0]?.id;
    if (targetId == null) return { reanchored: false, owner: null };
    const rows = await sql<{ id: number }[]>`
      UPDATE harness_shared.adv_sessions
         SET session_id = ${sessionId}, ended_at = NULL, exit_code = NULL,
             ended_by = NULL, ended_signal = NULL, started_at = now(),
             shutdown_accepted_at = NULL, resume_claim_key = NULL,
             resume_claimed_at = NULL
       WHERE id = ${targetId} AND session_id IS DISTINCT FROM ${sessionId}
      RETURNING id
    `;
    if (rows.length > 0) return { reanchored: true, owner: coordOwnerId };
    // WI-41555 (see the sibling above for the full reasoning): a row that ALREADY
    // names this native id updates zero rows, and the caller's respawn hygiene —
    // the context-usage + anchor cache clears — must still run for that owner.
    // Confirm the owner really does have a row, then report it with
    // reanchored:false so "did I change it" stays honest.
    return { reanchored: false, owner: coordOwnerId };
  } catch (e) {
    warnUnlessMissingTable(e, 'reanchorAdvSessionNativeIdByOwner');
    return { reanchored: false, owner: null };
  }
}

/** How a reported native session id relates to the owner's tracked incarnation. */
export type OwnerNativeSessionBinding = 'bound' | 'unbound' | 'foreign';

export interface OwnerNativeSessionRow {
  id: number;
  session_id: string | null;
  active: boolean;
}

/**
 * Pure verdict behind {@link classifyOwnerNativeSession}. The candidates are the
 * owner's ACTIVE rows when it has any, else its newest row:
 *   - `bound`   — some candidate is already bound to `sessionId`.
 *   - `unbound` — no candidate carries a native id yet (first binding; the
 *                 SessionStart reanchor is how it gets one).
 *   - `foreign` — the owner's incarnation is bound to a DIFFERENT native session.
 *
 * WI-10003957: `foreign` is what a nested CLI looks like. `PAPERCUSP_SID` is
 * inherited by every descendant of an su (native Bash, capability:bash jobs,
 * test-spawned `claude -p` probes), so that CLI's hooks report SessionStart /
 * SessionEnd AS the su. Owner-keyed lifecycle effects must not fire for it.
 */
export function classifyOwnerNativeSessionRows(
  rows: readonly OwnerNativeSessionRow[],
  sessionId: string,
): { binding: OwnerNativeSessionBinding; boundSessionId: string | null; advSessionId: number | null } {
  const active = rows.filter((r) => r.active);
  const candidates = active.length > 0 ? active : rows.slice(0, 1);
  const match = candidates.find((r) => r.session_id?.trim() === sessionId);
  if (match) return { binding: 'bound', boundSessionId: sessionId, advSessionId: Number(match.id) };
  const bound = candidates.find((r) => r.session_id?.trim());
  if (!bound) {
    return { binding: 'unbound', boundSessionId: null, advSessionId: candidates[0] ? Number(candidates[0].id) : null };
  }
  return { binding: 'foreign', boundSessionId: bound.session_id!.trim(), advSessionId: Number(bound.id) };
}

/**
 * Is `sessionId` the native session the owner's adv_sessions row is bound to?
 * With `advSessionId` (the launcher-exported PAPERCUSP_ADV_SESSION_ID) only that
 * row is consulted, when it belongs to the owner. Throws on a PG error, so the
 * caller decides the fail direction.
 */
export async function classifyOwnerNativeSession(opts: {
  ownerId: string;
  sessionId: string;
  advSessionId?: number | null;
}): Promise<{ binding: OwnerNativeSessionBinding; boundSessionId: string | null; advSessionId: number | null }> {
  const { sql } = getOrgPg();
  let rows: OwnerNativeSessionRow[] = [];
  if (opts.advSessionId != null) {
    rows = await sql<OwnerNativeSessionRow[]>`
      SELECT id, session_id, (ended_at IS NULL AND ended_by IS NULL) AS active
        FROM harness_shared.adv_sessions
       WHERE id = ${opts.advSessionId} AND coord_owner_id = ${opts.ownerId}
    `;
  }
  if (rows.length === 0) {
    rows = await sql<OwnerNativeSessionRow[]>`
      SELECT id, session_id, (ended_at IS NULL AND ended_by IS NULL) AS active
        FROM harness_shared.adv_sessions
       WHERE coord_owner_id = ${opts.ownerId}
       ORDER BY (ended_at IS NULL AND ended_by IS NULL) DESC, id DESC
       LIMIT 20
    `;
  }
  return classifyOwnerNativeSessionRows(rows, opts.sessionId);
}

/**
 * Persist the RESOLVED su persona render inputs on the session's row (migration
 * 738), so a carry-respawn can re-render the launch context from current prompt
 * sources instead of inheriting the predecessor's already-rendered file
 * (stale-prompt-render-in-live-sessions-2026-08-02 P-002).
 *
 * Returns false on failure so launch callers can refuse without a receipt.
 * Replacing a render must retain the still-applied artifact until real delivery
 * acknowledges its successor; persisting a launch is not an activation ACK.
 */
export async function recordSuLaunchSpec(
  advSessionId: number | null,
  coordOwnerId: string | null,
  launchSpec: unknown,
): Promise<boolean> {
  if (!launchSpec) return false;
  if ((advSessionId == null || advSessionId <= 0) && !coordOwnerId) return false;
  try {
    const { retainSuLaunchIdentityHistory } = await import('./su-persona-render');
    // Prefer the exact row id; fall back to the owner's NEWEST row for the
    // interactive cohort. Lock the selected row across read/merge/write so two
    // concurrent refreshes cannot discard each other's immutable receipts.
    return await boundedOrgTxn(async (tx) => {
      const exactId = advSessionId != null && advSessionId > 0 ? advSessionId : null;
      const rows = await tx<{ id: number; launch_spec: unknown; applied: unknown }[]>`
        SELECT a.id, a.launch_spec, b.control_state->'activation'->'applied' AS applied
          FROM harness_shared.adv_sessions a
          LEFT JOIN harness_shared.session_briefs b
            ON b.workspace_id = a.workspace_id AND b.owner_id = a.coord_owner_id
         WHERE (${exactId}::bigint IS NOT NULL AND a.id = ${exactId})
            OR (${exactId}::bigint IS NULL AND a.coord_owner_id = ${coordOwnerId})
         ORDER BY a.started_at DESC, a.id DESC
         LIMIT 1
         FOR UPDATE OF a
      `;
      const row = rows[0];
      if (!row) return false;
      const payload = JSON.stringify(retainSuLaunchIdentityHistory(row.launch_spec, launchSpec, row.applied));
      const updated = await tx<{ id: number }[]>`
        UPDATE harness_shared.adv_sessions SET launch_spec = ${payload}::jsonb
         WHERE id = ${row.id}
        RETURNING id
      `;
      return updated.length > 0;
    });
  } catch (e) {
    warnUnlessMissingTable(e, 'recordSuLaunchSpec');
    return false;
  }
}

/**
 * Read back the persona render inputs for a coord owner — the respawn key, which
 * is stable across every respawn by design (mintRecycleArgs rotates only the
 * NATIVE claude session id; PAPERCUSP_SID is deliberately untouched).
 *
 * Reads the NEWEST row for the owner, matching `reanchorAdvSessionNativeIdByOwner`
 * and `resolveSessionRef`. Returns null (never throws) when there is no row, no
 * spec, or the store is unavailable — every one of which fail-softs the caller to
 * the inherited render.
 */
export async function readSuLaunchSpecByOwner(coordOwnerId: string): Promise<unknown | null> {
  if (!coordOwnerId) return null;
  try {
    const { sql } = getOrgPg();
    const rows = await sql<{ launch_spec: unknown }[]>`
      SELECT launch_spec
        FROM harness_shared.adv_sessions
       WHERE coord_owner_id = ${coordOwnerId}
       ORDER BY started_at DESC
       LIMIT 1
    `;
    return rows[0]?.launch_spec ?? null;
  } catch (e) {
    warnUnlessMissingTable(e, 'readSuLaunchSpecByOwner');
    return null;
  }
}

/**
 * The launch data needed to recover a legacy fleet member whose fleet was
 * created before `fleet:headcount-target` existed.  Keep this reader separate
 * from `readSuLaunchSpecByOwner`: the latter intentionally reads the concrete
 * `launch_spec` column for the current persona-refresh path, while this one
 * must remain parse-safe on schemas where that column has not been added yet.
 */
export interface AdvSessionLaunchRecord {
  workspaceId: string;
  /** Launch-time backend persisted independently of launch_spec/launch_argv. */
  agent: SuAgent | null;
  launchSpec: unknown;
  launchArgv: unknown;
}

/** Read the newest launch record for one owner, optionally pinned to a workspace. */
export async function readAdvSessionLaunchRecordByOwner(
  coordOwnerId: string,
  workspaceId?: string | null,
): Promise<AdvSessionLaunchRecord | null> {
  if (!coordOwnerId) return null;
  const scope = workspaceId?.trim() || null;
  try {
    const { sql } = getOrgPg();
    const workspacePredicate = scope === null ? true : sql`workspace_id = ${scope}`;
    const rows = await sql<
      {
        workspace_id: string;
        agent: string | null;
        launch_spec: unknown;
        launch_argv: unknown;
      }[]
    >`
      SELECT workspace_id,
             agent,
             -- to_jsonb keeps this reader parse-safe on pre-migration legacy
             -- schemas: an absent key becomes NULL instead of a parse error.
             to_jsonb(a)->'launch_spec' AS launch_spec,
             to_jsonb(a)->'launch_argv' AS launch_argv
        FROM harness_shared.adv_sessions a
       WHERE coord_owner_id = ${coordOwnerId}
         AND ${workspacePredicate}
       ORDER BY started_at DESC
       LIMIT 1
    `;
    const row = rows[0];
    return row
      ? {
          workspaceId: row.workspace_id,
          agent: (row.agent as SuAgent | null) ?? null,
          launchSpec: row.launch_spec,
          launchArgv: row.launch_argv,
        }
      : null;
  } catch (e) {
    warnUnlessMissingTable(e, 'readAdvSessionLaunchRecordByOwner');
    return null;
  }
}

export async function listAdvSessions(limit = 100): Promise<AdvSessionRow[]> {
  try {
    const { sql } = getOrgPg();
    // Filter "dead-on-arrival" rows — a terminal that ended within 5
    // seconds of launch and never recorded an omp_thread_id never
    // produced a transcript. Showing those rows is just noise: the
    // detail panel can't load state, the Inspect / Resume buttons
    // dead-end, the user has no recourse. They're tracked in PG (audit
    // trail) but excluded from the UI list. A surviving session with
    // no omp_thread_id is still shown (it might be brand-new and
    // OMP just hasn't written its JSONL header yet).
    const rows = await sql<
      Array<{
        id: number;
        workspace_id: string;
        harness_slug?: string | null;
        plan_slug: string | null;
        agent: string | null;
        role: string | null;
        feature: string | null;
        mode: 'omp' | 'console';
        terminal_bin: string | null;
        pid: number | null;
        window_id: string | null;
        omp_thread_id: string | null;
        label: string | null;
        cwd: string | null;
        coord_owner_id: string | null;
        session_id: string | null;
        started_at: string | Date;
        ended_at: string | Date | null;
        exit_code: number | null;
        port_id?: string | null;
        port_source_adv_session_id?: number | string | null;
        port_status?: string | null;
        port_metadata?: Record<string, unknown> | null;
        launch_argv?: string[] | null;
      }>
    >`
      SELECT id, workspace_id, plan_slug, agent, role, feature, mode, terminal_bin, pid,
             window_id, omp_thread_id, label, cwd, coord_owner_id, session_id, started_at, ended_at, exit_code, ended_by, ended_signal,
             to_jsonb(a)->'launch_argv' AS launch_argv,
             to_jsonb(a)->>'port_id' AS port_id,
             to_jsonb(a)->>'port_source_adv_session_id' AS port_source_adv_session_id,
             to_jsonb(a)->>'port_status' AS port_status,
             to_jsonb(a)->'port_metadata' AS port_metadata
        FROM harness_shared.adv_sessions a
       WHERE workspace_id = ${activeWorkspaceId()}
         AND NOT (
           ended_at IS NOT NULL
           AND omp_thread_id IS NULL
           AND EXTRACT(EPOCH FROM (ended_at - started_at)) < 5
         )
       ORDER BY started_at DESC
       LIMIT ${limit}
    `;
    return rows.map(mapAdvSessionRow);
  } catch (e) {
    warnUnlessMissingTable(e, 'listAdvSessions');
    return [];
  }
}

/**
 * How many of EACH backend's most-recently-active sessions are guaranteed a place in
 * {@link listResumableSessions}'s result, on top of the global recency slice.
 *
 * Without a per-agent floor the result is whatever the busiest backend leaves room for, and
 * "busiest" here is not close: 13.3k claude rows vs 1.1k codex vs 261 omp on this box. A
 * flat top-N is then a lottery the quiet backends lose, and the picker they feed shows the
 * owner a list with a whole CLI missing and no indication anything was withheld.
 */
const RESUMABLE_PER_AGENT_FLOOR = 12;

/**
 * How far back the candidate pool reaches for ENDED sessions. Never-ended rows are pooled
 * in full regardless (see the query), so this only bounds the archaeology — the cost knob,
 * not the correctness knob.
 */
const RESUMABLE_SCAN_LIMIT = 300;

/**
 * Recent psu-tracked sessions (agent + cwd present), MOST-RECENTLY-ACTIVE first, across ALL
 * workspaces — the data the `psu --resume` picker walks. Unlike listAdvSessions this is NOT
 * workspace-scoped (you may want to resume a session launched in a different workspace) and
 * includes ended rows (resume revives them).
 *
 * Two things this query does that a plain `ORDER BY started_at DESC LIMIT n` did not, both
 * from the same owner report (2026-08-12, WI-38226: "psu --resume is not listing any codex
 * sessions... there were active codex sessions in that window"):
 *
 * 1. IT ORDERS BY ACTIVITY, NOT BY `started_at`. `started_at` is mutable — `claimAdvSessionResume`
 *    and `reactivateAdvSessionByOwner` set it to `now()` when an ended row comes back — so it
 *    means "last (re)activation", which is neither birth (`first_seen_at`) nor activity. A
 *    session running and busy for hours never reactivates, so it sinks below sessions that
 *    resumed a minute ago and did nothing since. Measured at the time of the report: 53 of the
 *    74 codex sessions active within the past hour ranked OUTSIDE the top 30 by `started_at`,
 *    the worst at rank 233 — i.e. the column was hiding sessions BECAUSE they had been working.
 *    The activity key is the GREATEST of `started_at`, the owner's `coord_presence.last_active_at`,
 *    and the owner's newest `tool_invocations.invoked_at`. Both extra sources are needed:
 *    coord_presence is TTL-reaped (only 28 of 129 live claude candidates still had a row), while
 *    tool_invocations is pruned to ~14d but covered 129/129 of them — together they rescued 229
 *    of 400 candidates that presence alone would have left ranked by `started_at`.
 *
 * 2. IT GUARANTEES EVERY BACKEND A PLACE, via {@link RESUMABLE_PER_AGENT_FLOOR} — see there.
 *
 * The candidate pool is every never-ended row (bounded and small — 315 when this was written —
 * and the population whose `started_at` is least trustworthy, since a long-running session's
 * is oldest exactly when its activity is newest) UNION the {@link RESUMABLE_SCAN_LIMIT} most
 * recent ended ones. Check the optional port column once per read: converting each candidate's
 * whole row to JSON also serializes large launch payloads just to inspect one status field.
 */
export async function listResumableSessions(
  limit = 30,
  { perAgentFloor = RESUMABLE_PER_AGENT_FLOOR, scanLimit = RESUMABLE_SCAN_LIMIT, exactId = null as number | null } = {},
): Promise<AdvSessionRow[]> {
  try {
    // An explicit native-session resume can recover its durable adv id from the
    // local first-write-wins session-owner index even after the row falls outside
    // the bounded recent-ended pool below. Keep that ONE row in the candidate set
    // without widening the human picker's normal history window.
    const exactResumeId = Number.isSafeInteger(exactId) && Number(exactId) > 0 ? Number(exactId) : -1;
    const { sql } = getOrgPg();
    // Keep pre-611 rollout compatibility without serializing every row (including launch_spec)
    // during candidate filtering. Do not cache absence: migration may finish while we are live.
    const [portColumn] = await sql<Array<{ present: boolean }>>`
      SELECT EXISTS (
        SELECT 1 FROM pg_attribute
         WHERE attrelid = to_regclass('harness_shared.adv_sessions')
           AND attname = 'port_status' AND NOT attisdropped
      ) AS present
    `;
    const deliveredPort = portColumn?.present
      ? sql`COALESCE(a.port_status, 'delivered') = 'delivered'`
      : sql`TRUE`;
    const rows = await sql<
      Array<{
        id: number;
        workspace_id: string;
        plan_slug: string | null;
        agent: string | null;
        role: string | null;
        feature: string | null;
        mode: 'omp' | 'console';
        terminal_bin: string | null;
        pid: number | null;
        window_id: string | null;
        omp_thread_id: string | null;
        label: string | null;
        cwd: string | null;
        coord_owner_id: string | null;
        session_id: string | null;
        started_at: string | Date;
        last_active_at: string | Date;
        ended_at: string | Date | null;
        exit_code: number | null;
      }>
    >`
      WITH pool AS (
        -- Never-ended rows in full: small, bounded, and the set a started_at-ordered scan
        -- gets most wrong (a session busy for 10h has the OLDEST started_at of any live one).
          SELECT a.id
            FROM harness_shared.adv_sessions a
           WHERE a.agent IS NOT NULL
             AND a.cwd IS NOT NULL
             AND ${deliveredPort}
             AND a.ended_at IS NULL
        UNION
          -- …plus the most recent ended rows. GREATEST(started_at, ended_at) because a row
          -- that ended AFTER its last reactivation is most recent at its end, not its start.
          SELECT id FROM (
            SELECT a.id
              FROM harness_shared.adv_sessions a
             WHERE a.agent IS NOT NULL
               AND a.cwd IS NOT NULL
               AND ${deliveredPort}
             ORDER BY GREATEST(a.started_at, COALESCE(a.ended_at, a.started_at)) DESC
             LIMIT ${scanLimit}
          ) recent
        UNION
          -- A direct resume/fork may name a tracked row older than the picker
          -- window. Include exactly that row (when resumable-shaped) so the
          -- launcher can recover workspace/plan/identity and use the managed
          -- fork path instead of silently degrading to a raw native fork.
          SELECT a.id
            FROM harness_shared.adv_sessions a
           WHERE a.id = ${exactResumeId}
             AND a.agent IS NOT NULL
             AND a.cwd IS NOT NULL
             AND ${deliveredPort}
      ),
      scored AS (
        SELECT a.id, a.agent,
               -- GREATEST, not COALESCE: each source is a LOWER BOUND on activity that can be
               -- missing or stale independently, so the newest evidence wins and a session with
               -- no evidence at all degrades to started_at instead of dropping to NULL.
               GREATEST(
                 a.started_at,
                 COALESCE(pr.last_active_at, a.started_at),
                 COALESCE(ti.last_tool, a.started_at)
               ) AS last_active_at
          FROM harness_shared.adv_sessions a
          JOIN pool ON pool.id = a.id
          LEFT JOIN harness_shared.coord_presence pr ON pr.owner_id = a.coord_owner_id
          -- Indexed by tool_invocations_coord_owner_idx (coord_owner_id, invoked_at DESC),
          -- so this is a per-candidate index max, not a scan of the 680k-row 3-day window.
          LEFT JOIN LATERAL (
            SELECT max(t.invoked_at) AS last_tool
              FROM harness_shared.tool_invocations t
             WHERE t.coord_owner_id = a.coord_owner_id
          ) ti ON true
      ),
      ranked AS (
        SELECT *,
               ROW_NUMBER() OVER (ORDER BY last_active_at DESC) AS global_rn,
               ROW_NUMBER() OVER (PARTITION BY agent ORDER BY last_active_at DESC) AS agent_rn
          FROM scored
      ),
      selected AS MATERIALIZED (
        -- Rank only identity/activity. Hydrating launch payloads before the window
        -- functions makes every candidate pay for JSON conversion and wide sorting.
        SELECT id, last_active_at FROM ranked
         WHERE global_rn <= ${limit} OR agent_rn <= ${perAgentFloor} OR id = ${exactResumeId}
      )
      SELECT a.id, a.workspace_id,
             -- Keep optional launch_spec parse-safe; convert only the selected rows.
             to_jsonb(a)->'launch_spec'->>'harnessSlug' AS harness_slug,
             a.plan_slug, a.agent, a.role, a.feature, a.mode, a.terminal_bin, a.pid,
             a.window_id, a.omp_thread_id, a.label, a.cwd, a.coord_owner_id, a.session_id,
             a.launch_argv,
             a.started_at, selected.last_active_at, a.ended_at, a.exit_code, a.ended_by, a.ended_signal
        FROM selected
        JOIN harness_shared.adv_sessions a ON a.id = selected.id
       ORDER BY selected.last_active_at DESC
    `;
    return rows.map(mapAdvSessionRow);
  } catch (e) {
    warnUnlessMissingTable(e, 'listResumableSessions');
    return [];
  }
}

/**
 * EI-19284963139619048: `loop:status`'s wake-reachability probe reads the caller's
 * session row through this function to decide the wake channel. It used to run on
 * the plain, unbounded `getOrgPg()` admin pool — no statement_timeout — so a stall
 * here (lock wait / slow scan under fleet load) hung `loop:status` itself until the
 * client's own 300s idle-timeout killed the call blind (pg-bounded-txn.ts's header
 * documents this exact symptom class, already fixed for `work_items:comment`).
 * boundedOrgTxn sets a real statement_timeout so a stall now fails fast + typed —
 * caught by the SAME try/catch this function already had for a missing-table read,
 * so a timeout degrades to `null` exactly like today's other error paths.
 */
export async function getAdvSession(id: number): Promise<AdvSessionRow | null> {
  try {
    const rows = await boundedOrgTxn(
      (tx) => tx<
        Array<{
          id: number;
          workspace_id: string;
          harness_slug?: string | null;
          plan_slug: string | null;
          agent: string | null;
          role: string | null;
          feature: string | null;
          mode: 'omp' | 'console';
          terminal_bin: string | null;
          pid: number | null;
          window_id: string | null;
          omp_thread_id: string | null;
          label: string | null;
          cwd: string | null;
          coord_owner_id: string | null;
          session_id: string | null;
          started_at: string | Date;
          ended_at: string | Date | null;
          exit_code: number | null;
          port_id?: string | null;
          port_source_adv_session_id?: number | string | null;
          port_status?: string | null;
          port_metadata?: Record<string, unknown> | null;
          launch_argv?: string[] | null;
        }>
      >`
      SELECT id, workspace_id,
             -- launch_spec was added after the base adv-session columns. Read it
             -- through to_jsonb so old schemas remain parse-safe while resumed
             -- sessions recover the harness scope persisted at launch time.
             to_jsonb(a)->'launch_spec'->>'harnessSlug' AS harness_slug,
             plan_slug, agent, role, feature, mode, terminal_bin, pid,
             window_id, omp_thread_id, label, cwd, coord_owner_id, session_id, started_at, ended_at, exit_code, ended_by, ended_signal,
             to_jsonb(a)->'launch_argv' AS launch_argv,
             to_jsonb(a)->>'port_id' AS port_id,
             to_jsonb(a)->>'port_source_adv_session_id' AS port_source_adv_session_id,
             to_jsonb(a)->>'port_status' AS port_status,
             to_jsonb(a)->'port_metadata' AS port_metadata
        FROM harness_shared.adv_sessions a
       WHERE workspace_id = ${activeWorkspaceId()}
         AND id = ${id}
       LIMIT 1
    `,
    );
    const r = rows[0];
    if (!r) return null;
    return mapAdvSessionRow(r);
  } catch (e) {
    warnUnlessMissingTable(e, 'getAdvSession');
    return null;
  }
}

/**
 * Resolve the newest still-active launch row for one coordination owner.
 *
 * This is deliberately keyed by `coord_owner_id`, not a native transcript id:
 * focus/mark/wake requests start from the stable handle exposed by
 * `coord:presence`, while the native id differs by backend and may be absent.
 * No recency cutoff is applied — a genuinely live interactive terminal can
 * remain open for days. The owner id is globally unique, but the active
 * workspace predicate keeps this low-level control read inside the caller's
 * workspace just like {@link getAdvSession}.
 */
export async function getLatestActiveAdvSessionByOwner(coordOwnerId: string): Promise<AdvSessionRow | null> {
  const ownerId = coordOwnerId.trim();
  if (!ownerId) return null;
  try {
    const rows = await boundedOrgTxn(
      (tx) => tx<Array<Parameters<typeof mapAdvSessionRow>[0]>>`
        SELECT id, workspace_id,
               to_jsonb(a)->'launch_spec'->>'harnessSlug' AS harness_slug,
               plan_slug, agent, role, feature, mode, terminal_bin, pid,
               window_id, omp_thread_id, label, cwd, coord_owner_id, session_id,
               started_at, ended_at, exit_code, ended_by, ended_signal,
               to_jsonb(a)->'launch_argv' AS launch_argv,
               to_jsonb(a)->>'port_id' AS port_id,
               to_jsonb(a)->>'port_source_adv_session_id' AS port_source_adv_session_id,
               to_jsonb(a)->>'port_status' AS port_status,
               to_jsonb(a)->'port_metadata' AS port_metadata
          FROM harness_shared.adv_sessions a
         WHERE workspace_id = ${activeWorkspaceId()}
           AND coord_owner_id = ${ownerId}
           AND ended_at IS NULL
         ORDER BY started_at DESC
         LIMIT 1
      `,
    );
    return rows[0] ? mapAdvSessionRow(rows[0]) : null;
  } catch (e) {
    warnUnlessMissingTable(e, 'getLatestActiveAdvSessionByOwner');
    return null;
  }
}

/** Explicit workspace lookup for a server-side port request. getAdvSession()
 * remains active-workspace scoped for legacy UI callers. */
export async function getAdvSessionInWorkspace(id: number, workspaceId: string): Promise<AdvSessionRow | null> {
  try {
    const { sql } = getOrgPg();
    const rows = await sql<Array<Parameters<typeof mapAdvSessionRow>[0]>>`
      SELECT id, workspace_id, plan_slug, agent, role, feature, mode, terminal_bin, pid,
             window_id, omp_thread_id, label, cwd, coord_owner_id, session_id,
             to_jsonb(a)->'launch_argv' AS launch_argv,
             started_at, ended_at, exit_code, ended_by, ended_signal,
             to_jsonb(a)->>'port_id' AS port_id,
             to_jsonb(a)->>'port_source_adv_session_id' AS port_source_adv_session_id,
             to_jsonb(a)->>'port_status' AS port_status,
             to_jsonb(a)->'port_metadata' AS port_metadata
        FROM harness_shared.adv_sessions a
       WHERE workspace_id = ${workspaceId} AND id = ${id}
       LIMIT 1`;
    return rows[0] ? mapAdvSessionRow(rows[0]) : null;
  } catch (e) {
    warnUnlessMissingTable(e, 'getAdvSessionInWorkspace');
    return null;
  }
}

export async function updateAdvSessionPortStatus(
  id: number,
  workspaceId: string,
  status: 'pending' | 'delivered' | 'failed',
  metadata: Record<string, unknown> = {},
): Promise<boolean> {
  const { sql } = getOrgPg();
  const rows = await sql<{ id: number }[]>`
    UPDATE harness_shared.adv_sessions
       SET port_status = ${status},
           port_metadata = COALESCE(port_metadata, '{}'::jsonb) || ${JSON.stringify(metadata)}::text::jsonb,
           ended_at = CASE WHEN ${status} = 'failed' THEN COALESCE(ended_at, now()) ELSE ended_at END
     WHERE id = ${id} AND workspace_id = ${workspaceId}
     RETURNING id`;
  return rows.length > 0;
}

/**
 * adv_sessions keyed by coord_owner_id — the enrichment side of the live-roster
 * join (coord_presence.owner_id = adv_sessions.coord_owner_id; D-002). Returns
 * a Map so mergeRoster() can look up each presence row's launch metadata in O(1).
 *
 * Deliberately NOT workspace-scoped: coord_owner_id (the session SID) is
 * globally unique, and a presence row's workspace ('*' for an unscoped SU
 * shell) need not equal its adv row's concrete workspace — scoping here would
 * silently drop valid joins. Most-recent row wins per owner (a SID is minted
 * per launch, so collisions are not expected; the guard is belt-and-suspenders).
 * adv-sessions-live-roster P-002.
 */
/**
 * The ACTIVE roster tier's adv rows, keyed by coord owner.
 *
 * ⚠ `launch_argv` MUST stay in this SELECT (WI-6510). It is declared OPTIONAL on
 * `AdvSessionDbRow` ("only the pending-launch query SELECTs it"), so dropping it
 * from the column list does NOT fail typecheck: `mapAdvSessionRow` maps the
 * missing column to `null`, the roster's `adv?.launchArgv ?? []` turns that into
 * an empty argv, and every live agent silently reports "no model recorded" while
 * the DB row holds the full spec. Verified live 2026-08-11: the chat MODEL pill
 * vanished entirely for a session launched with `--model=sonnet[1m]:high`, with
 * unit tests and typecheck both green — the fixtures set the field by hand, so
 * only a live drive could see it.
 */
export async function advSessionsByCoordOwner(limit = 500): Promise<Map<string, AdvSessionRow>> {
  const out = new Map<string, AdvSessionRow>();
  try {
    const { sql } = getOrgPg();
    const rows = await sql<
      Array<{
        id: number;
        /** See the docblock: omitting this maps to null, not a type error. */
        launch_argv?: string[] | null;
        workspace_id: string;
        plan_slug: string | null;
        agent: string | null;
        role: string | null;
        feature: string | null;
        mode: 'omp' | 'console';
        terminal_bin: string | null;
        pid: number | null;
        window_id: string | null;
        omp_thread_id: string | null;
        label: string | null;
        cwd: string | null;
        coord_owner_id: string | null;
        session_id: string | null;
        started_at: string | Date;
        ended_at: string | Date | null;
        exit_code: number | null;
      }>
    >`
      SELECT id, workspace_id, plan_slug, agent, role, feature, mode, terminal_bin, pid,
             window_id, omp_thread_id, label, cwd, coord_owner_id, session_id, launch_argv,
             started_at, ended_at, exit_code, ended_by, ended_signal
        FROM harness_shared.adv_sessions
       WHERE coord_owner_id IS NOT NULL
       ORDER BY started_at DESC
       LIMIT ${limit}
    `;
    for (const r of rows) {
      const mapped = mapAdvSessionRow(r);
      // ORDER BY started_at DESC → first seen per owner is the most recent.
      if (mapped.coordOwnerId && !out.has(mapped.coordOwnerId)) out.set(mapped.coordOwnerId, mapped);
    }
  } catch (e) {
    warnUnlessMissingTable(e, 'advSessionsByCoordOwner');
  }
  return out;
}

/** Broad recency bound used by labelled-session, window, and coupling reads.
 *  A session whose clean-exit `markAdvSessionEnded` never ran
 *  (killed/crashed process) ages out of those reads after this, instead of
 *  lingering as an eternal `ended_at IS NULL` zombie. The recorded roster's
 *  bootstrap rescue uses the narrower `RECORDED_ADV_SESSION_FRESH_SEC` bound.
 */
export const RECORDED_LIVE_MAX_AGE_MS = 12 * 60 * 60 * 1000;

/**
 * Live recorded sessions — the AUTHORITATIVE "what is running right now" leg of
 * the presence roster (presence-derive-from-session-log-2026-06-22 P-001).
 *
 * Every session the system RECORDED — any CLI (claude/codex/omp), any launch
 * mode (console/role/spawn/interactive) — that has NOT yet ended (ended_at IS
 * NULL) and carries a coord owner id (the join key to coord_presence.owner_id).
 * The presence snapshot synthesizes a roster row for any of these NOT already
 * self-registered in coord_presence, so a session is VISIBLE + ADDRESSABLE the
 * instant it is recorded — never gated on the agent volunteering a heartbeat
 * (the structural gap this closes: a recorded live session with no presence row
 * was invisible + undispatchable, worst for console/autonomous agents that
 * never heartbeat at all).
 *
 * Recency-bounded (`maxAgeMs`, default `RECORDED_ADV_SESSION_FRESH_SEC`, 10m)
 * so an unreaped zombie ages out while the session is still in its bootstrap
 * window. Callers with a different read contract may override `maxAgeMs`.
 * `DISTINCT ON (coord_owner_id)` most-recent row per owner (a resume reuses the
 * SID). Workspace-scoped when given. Best-effort → [] on any DB error: the
 * roster must render even if this leg fails. `ownerIds` bounds targeted reads
 * while preserving the public exact/label/prefix selector behavior.
 */
export async function listRecordedLiveSessions(
  opts: {
    workspaceId?: string | null;
    maxAgeMs?: number;
    limit?: number;
    /** Bounded targeted selectors; exact ids, labels, and substrings match. */
    ownerIds?: readonly string[];
  } = {},
): Promise<AdvSessionRow[]> {
  const ws = opts.workspaceId ?? null;
  const maxAgeSec = Math.max(1, Math.round((opts.maxAgeMs ?? RECORDED_ADV_SESSION_FRESH_SEC * 1000) / 1000));
  const limit = opts.limit ?? 500;
  const ownerIds = [...new Set((opts.ownerIds ?? []).filter((ownerId) => ownerId.length > 0))];
  try {
    const { sql } = getOrgPg();
    const workspacePredicate = ws === null ? true : sql`workspace_id = ${ws}`;
    // Targeted presence reads must not scan the recent-session population just
    // to discard every row except one owner. Exact owner ids can use the
    // coord_owner_id index; the remaining selector clauses preserve the public
    // prefix/label lookup semantics.
    const ownerFilter =
      ownerIds.length === 0
        ? sql``
        : sql`
         AND (
           coord_owner_id = ANY(${ownerIds}::text[])
           OR label = ANY(${ownerIds}::text[])
           OR EXISTS (
             SELECT 1
               FROM unnest(${ownerIds}::text[]) AS requested(owner)
              WHERE strpos(coord_owner_id, requested.owner) > 0
                 OR strpos(requested.owner, coord_owner_id) > 0
                 OR strpos(label, requested.owner) > 0
                 OR strpos(requested.owner, label) > 0
           )
         )`;
    const rows = await sql<Array<Parameters<typeof mapAdvSessionRow>[0]>>`
      SELECT DISTINCT ON (coord_owner_id)
             id, workspace_id, plan_slug, agent, role, feature, mode, terminal_bin, pid,
             window_id, omp_thread_id, label, cwd, coord_owner_id, session_id, started_at, ended_at, exit_code, ended_by, ended_signal
        FROM harness_shared.adv_sessions
       WHERE ended_at IS NULL
         AND coord_owner_id IS NOT NULL
         AND started_at > now() - make_interval(secs => ${maxAgeSec})
         AND ${workspacePredicate}
         ${ownerFilter}
       ORDER BY coord_owner_id, started_at DESC
       LIMIT ${limit}
    `;
    const mapped = rows.map(mapAdvSessionRow);
    return ownerIds.length === 0
      ? mapped
      : mapped.filter((row) =>
          ownerIds.some((selector) => {
            const id = row.coordOwnerId ?? '';
            const label = row.label ?? '';
            return (
              id === selector ||
              label === selector ||
              id.includes(selector) ||
              selector.includes(id) ||
              label.includes(selector) ||
              selector.includes(label)
            );
          }),
        );
  } catch (e) {
    warnUnlessMissingTable(e, 'listRecordedLiveSessions');
    return [];
  }
}

/**
 * Batch: which of `coordOwnerIds` have a RECORDED session whose MOST-RECENT row
 * has ENDED (`adv_sessions.ended_at IS NOT NULL`) — POSITIVE evidence the owner's
 * process has exited, keyed by owner (EI-6374, the fleet-coverage liveness-drift).
 *
 * This is the authoritative "is it actually still running" signal a coverage
 * reader needs to override a still-WARM `coord_presence` heartbeat: session end
 * sets `ended_at` in the SAME teardown that cancels the inbox-wake await (harness
 * spawn + su/console launch paths), so a bee reported `ended` by the wake path
 * lands here too. Positive-evidence by design — an owner with NO recorded session
 * (a test-synthetic presence row, a legacy agent) is NEVER flagged, and a
 * launching / live / RESUMED session (the resume paths clear `ended_at`) has
 * a LIVE most-recent row → excluded. `DISTINCT ON (coord_owner_id)` most-recent
 * row per owner (a resume reuses the SID, so the latest row wins). Federated
 * (`fed:…`) owners never have a local record → dropped up front. Best-effort →
 * empty set on any DB error (no owner is downgraded; the reader degrades to
 * heartbeat-only liveness and never over-reports death).
 */
/**
 * Batch: which owners' newest tracked session has received an accepted
 * self-shutdown acknowledgement while it is still open. Positive evidence
 * only: a marker on an older row cannot authorize a takeover after a newer
 * row exists, and a failed read returns an empty set so the force guard stays
 * strict.
 */
export async function shutdownAcceptedOwnerIds(coordOwnerIds: string[]): Promise<Set<string>> {
  const ids = [...new Set(coordOwnerIds.filter((id) => !!id && !id.startsWith('fed:')))];
  if (ids.length === 0) return new Set();
  try {
    const { sql } = getOrgPg();
    const rows = await sql<
      {
        coord_owner_id: string;
        shutdown_accepted_at: string | Date | null;
      }[]
    >`
      SELECT DISTINCT ON (coord_owner_id) coord_owner_id, shutdown_accepted_at
        FROM harness_shared.adv_sessions
       WHERE coord_owner_id = ANY(${ids}::text[])
       ORDER BY coord_owner_id, started_at DESC
    `;
    return new Set(rows.filter((r) => r.shutdown_accepted_at != null).map((r) => r.coord_owner_id));
  } catch (e) {
    warnUnlessMissingTable(e, 'shutdownAcceptedOwnerIds');
    return new Set();
  }
}

export async function endedRecordedOwnerIds(coordOwnerIds: string[]): Promise<Set<string>> {
  const ids = [...new Set(coordOwnerIds.filter((id) => !!id && !id.startsWith('fed:')))];
  if (ids.length === 0) return new Set();
  try {
    const { sql } = getOrgPg();
    const rows = await sql<{ coord_owner_id: string; ended_at: string | Date | null }[]>`
      SELECT DISTINCT ON (coord_owner_id) coord_owner_id, ended_at
        FROM harness_shared.adv_sessions
       WHERE coord_owner_id = ANY(${ids}::text[])
       ORDER BY coord_owner_id, started_at DESC
    `;
    return new Set(rows.filter((r) => r.ended_at != null).map((r) => r.coord_owner_id));
  } catch (e) {
    warnUnlessMissingTable(e, 'endedRecordedOwnerIds');
    return new Set();
  }
}
/**
 * Batch: the LATEST ended adv_session per owner, for owners whose
 * coord_presence row has been reaped (EI-21488009366204518). The read-side
 * authority for "this agent existed and is dead" when the presence door has no
 * row left to enrich — coord:presence's targeted `{ owner }` lookup synthesizes
 * an `ended` roster row from these so a reaped-but-recorded session never reads
 * as "never existed".
 *
 * Fail-soft like every adv_sessions leg: on query failure it returns [] and the
 * caller renders its ordinary empty result instead of fabricating liveness.
 */
export async function listEndedAdvSessionsByOwners(coordOwnerIds: string[]): Promise<AdvSessionRow[]> {
  const ids = [...new Set(coordOwnerIds.filter((id) => !!id && !id.startsWith('fed:')))];
  if (ids.length === 0) return [];
  try {
    const { sql } = getOrgPg();
    const rows = await sql<Array<Parameters<typeof mapAdvSessionRow>[0]>>`
      SELECT DISTINCT ON (coord_owner_id)
             id, workspace_id, plan_slug, agent, role, feature, mode, terminal_bin, pid,
             window_id, omp_thread_id, label, cwd, coord_owner_id, session_id, started_at, ended_at, exit_code, ended_by, ended_signal
        FROM harness_shared.adv_sessions
       WHERE ended_at IS NOT NULL
         AND coord_owner_id = ANY(${ids}::text[])
       ORDER BY coord_owner_id, started_at DESC
    `;
    return rows.map(mapAdvSessionRow);
  } catch (e) {
    warnUnlessMissingTable(e, 'listEndedAdvSessionsByOwners');
    return [];
  }
}

/**
 * How long an un-ended `adv_sessions` row may vouch for its owner's liveness.
 *
 * WI-42466. The rescue below exists for ONE narrow situation its own docstring
 * names: a session inside its *bootstrap/orient window* — already running, not
 * yet coord-dispatchable. That is a window measured in minutes. But the
 * `live_adv` leg was bounded only by `ended_at IS NULL`, and `ended_at` is
 * written by a session-end hook that SIGKILL, a crash, and an OOM all bypass —
 * so a row whose hook never ran vouched for a dead process FOREVER, and the
 * "freshly-launched" premise silently became "launched at any point in
 * history".
 *
 * Its `live_spawn` sibling never had this hole: it requires a heartbeat inside
 * 10 minutes. This is the same bound, for the same reason, on the same read.
 *
 * Why a bound rather than a pid probe: `probeProcessLiveness` refuses to guess
 * across machines and so returns `null` unless it is handed a host that equals
 * this one — and `adv_sessions` records no host column, while the presence row
 * that WOULD carry pid+host is reaped on a shorter schedule than these rows
 * live. Precisely when the rescue matters, the falsifier is unavailable. A
 * freshness bound needs no host, no pid, and no new column, and it restores the
 * window the docstring already claimed.
 *
 * Measured instance: goal `work-on-everything-070565` lost its holder
 * (su-a2e93ef3, pid 2911661, SIGKILLed — `kill -0` → ESRCH, `ended_at` still
 * NULL, presence reaped). The oracle read `recorded` ⇒ `holderCountsAsAlive`
 * ⇒ the goal folded to `held` ⇒ its liveness alarm returned null and the
 * owner-armed `GOAL_HOLDER_RESPAWN` respawner hit `continue` on all 113 of its
 * ticks. Nothing was broken except this predicate, and nothing could ever have
 * noticed.
 */
export const RECORDED_ADV_SESSION_FRESH_SEC = 10 * 60;

/**
 * Batch: which of `coordOwnerIds` have POSITIVE live-session evidence even if
 * they have not registered an inbox-wake await yet. This is the read-side twin
 * of coord:presence's `recorded` state: a freshly-launched session in its
 * bootstrap/orient window is alive, but not yet coord-dispatchable.
 *
 * Sources:
 *   - adv_sessions: an authoritative live interactive/terminal session row
 *     (`ended_at IS NULL`) started within `RECORDED_ADV_SESSION_FRESH_SEC`,
 *     keyed by coord_owner_id.
 *   - spawned_agents: the nursery's running row, keyed by any alias the
 *     fleet_assignment view can expose (spawn_id/session_owner/run_id), with a
 *     fresh process heartbeat.
 *
 * BOTH legs are freshness-bounded on purpose (WI-42466): this is a rescue for a
 * session that is booting, never a standing claim that an un-ended row means a
 * live process. A genuinely healthy long-lived agent does not need it — it arms
 * inbox waits and resolves through the wakeability leg instead.
 *
 * Positive-evidence by design. On query failure it returns empty so callers
 * degrade to the stricter wakeability-only behavior instead of fabricating
 * liveness.
 */
export async function recordedLiveOwnerIds(coordOwnerIds: string[]): Promise<Set<string>> {
  const ids = [...new Set(coordOwnerIds.filter((id) => !!id && !id.startsWith('fed:')))];
  if (ids.length === 0) return new Set();
  try {
    const { sql } = getOrgPg();
    const rows = await sql<{ owner_id: string }[]>`
      WITH requested(id) AS (
        SELECT unnest(${ids}::text[])
      ),
      live_adv AS (
        -- Match endedRecordedOwnerIds: only the NEWEST recorded session may
        -- vouch for this owner. Looking at every fresh un-ended row lets an
        -- older session survive a newer ended session, so the two enrichment
        -- sets overlap and the liveness oracle can report the ended holder as
        -- recorded/held-live.
        SELECT latest.coord_owner_id AS owner_id
          FROM (
            SELECT DISTINCT ON (coord_owner_id)
                   coord_owner_id, ended_at, started_at
              FROM harness_shared.adv_sessions
             WHERE coord_owner_id = ANY(${ids}::text[])
             ORDER BY coord_owner_id, started_at DESC
          ) AS latest
         WHERE latest.ended_at IS NULL
           AND latest.started_at > now() - ${`${RECORDED_ADV_SESSION_FRESH_SEC} seconds`}::interval
      ),
      live_spawn AS (
        SELECT alias.owner_id
          FROM harness_shared.spawned_agents sa
          CROSS JOIN LATERAL (
            VALUES (sa.spawn_id), (sa.session_owner), (sa.run_id)
          ) AS alias(owner_id)
          JOIN requested r ON r.id = alias.owner_id
         WHERE sa.status = 'running'
           AND sa.finished_at IS NULL
           AND sa.heartbeat_at > now() - interval '10 minutes'
      )
      SELECT DISTINCT owner_id FROM live_adv
      UNION
      SELECT DISTINCT owner_id FROM live_spawn
    `;
    return new Set(rows.map((r) => r.owner_id));
  } catch (e) {
    warnUnlessMissingTable(e, 'recordedLiveOwnerIds');
    return new Set();
  }
}

/**
 * When this coord owner FIRST existed — the EARLIEST `first_seen_at` across all
 * of its adv_sessions rows, as an ISO string (null when it has none on record).
 *
 * unread-count-truthfulness-2026-07-27 D-012: the unread cursor's birth floor.
 * A coord owner id survives respawns/carry-compactions, so this deliberately
 * takes the EARLIEST row, not the latest — flooring at the latest respawn would
 * silently drop mail that arrived during an earlier leg of the same owner's life.
 *
 * ⚠ WI-6589 — that safeguard used to be INERT, and reading `started_at` here was
 * why. The table keeps exactly ONE row per coord owner (13,797 of 13,797), and
 * `started_at` is bumped in place by every resume/re-anchor path below, so
 * MIN(started_at) === MAX(started_at) === the LATEST LAUNCH. The MIN could never
 * engage; a test seeding two rows for one owner asserted a shape production
 * cannot produce. `first_seen_at` (migration 707) is written once at INSERT and
 * never updated, so the MIN is a true birth. Do NOT revert this to `started_at`,
 * and do not add an UPDATE that touches `first_seen_at`.
 *
 * Fails soft to null if the column is not yet present (a deploy that has not run
 * migration 707): null = no floor, which OVER-counts broadcasts rather than
 * hiding mail — the safe direction.
 *
 * NOT workspace-scoped, same rationale as advSessionsByCoordOwner above (and
 * the same as its `latest` sibling below) — a coord owner id is globally unique,
 * and scoping here would make a cross-workspace row read as "never existed",
 * which floors to null and silently restores the count-from-epoch behaviour.
 */
export async function firstAdvSessionStartByCoordOwner(coordOwnerId: string): Promise<string | null> {
  try {
    const { sql } = getOrgPg();
    const rows = await sql<Array<{ started_at: Date | string | null }>>`
      SELECT MIN(first_seen_at) AS started_at
        FROM harness_shared.adv_sessions
       WHERE coord_owner_id = ${coordOwnerId}
    `;
    const raw = rows[0]?.started_at ?? null;
    if (raw == null) return null;
    const d = raw instanceof Date ? raw : new Date(raw);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  } catch (e) {
    warnUnlessMissingTable(e, 'firstAdvSessionStartByCoordOwner');
    return null;
  }
}

/**
 * The most recent adv_sessions row for ONE coord owner — the await-event
 * wake-handle capture (await-event-primitive-2026-06-05 D-003): events:await
 * stamps this row's {id, agent, session_id, omp_thread_id, cwd, pid} onto the
 * subscription at registration. NOT workspace-scoped, same rationale as
 * advSessionsByCoordOwner above.
 */
export async function latestAdvSessionByCoordOwner(coordOwnerId: string): Promise<AdvSessionRow | null> {
  try {
    const { sql } = getOrgPg();
    const rows = await sql<Array<Parameters<typeof mapAdvSessionRow>[0]>>`
      SELECT id, workspace_id, plan_slug, agent, role, feature, mode, terminal_bin, pid,
             window_id, omp_thread_id, label, cwd, coord_owner_id, session_id, started_at, ended_at, exit_code, ended_by, ended_signal
        FROM harness_shared.adv_sessions
       WHERE coord_owner_id = ${coordOwnerId}
       ORDER BY started_at DESC
       LIMIT 1
    `;
    const r = rows[0];
    return r ? mapAdvSessionRow(r) : null;
  } catch (e) {
    warnUnlessMissingTable(e, 'latestAdvSessionByCoordOwner');
    return null;
  }
}

/**
 * The newest STILL-LIVE adv_sessions row carrying `label` in `workspaceId` that
 * has a booted coord owner id — the correlation key for a labelled session
 * launch (the tutorial docs-agent: launch `psu --label='docs-tutor'`, then find
 * the resulting session here to route follow-up questions to its coord owner).
 *
 * "Live" = `ended_at IS NULL` AND started within RECORDED_LIVE_MAX_AGE_MS (so a
 * terminal whose exit was never recorded — the operator-restart caveat — ages
 * out instead of masquerading as live forever). `coord_owner_id IS NOT NULL`
 * because a row without one is mid-boot (bootstrap-su sets it) and not yet
 * addressable. Most-recent first. Returns null on no match / a missing table.
 */
export async function latestLiveAdvSessionByLabel(label: string, workspaceId: string): Promise<AdvSessionRow | null> {
  try {
    const { sql } = getOrgPg();
    const cutoffIso = new Date(Date.now() - RECORDED_LIVE_MAX_AGE_MS).toISOString();
    const rows = await sql<Array<Parameters<typeof mapAdvSessionRow>[0]>>`
      SELECT id, workspace_id, plan_slug, agent, role, feature, mode, terminal_bin, pid,
             window_id, omp_thread_id, label, cwd, coord_owner_id, session_id, started_at, ended_at, exit_code, ended_by, ended_signal
        FROM harness_shared.adv_sessions
       WHERE label = ${label}
         AND workspace_id = ${workspaceId}
         AND ended_at IS NULL
         AND coord_owner_id IS NOT NULL
         AND started_at >= ${cutoffIso}
       ORDER BY started_at DESC
       LIMIT 1
    `;
    const r = rows[0];
    return r ? mapAdvSessionRow(r) : null;
  } catch (e) {
    warnUnlessMissingTable(e, 'latestLiveAdvSessionByLabel');
    return null;
  }
}

/**
 * Recently-ended, inspectable agent sessions — the durable history half of the
 * live-roster view (the active half is the presence-driven mergeRoster).
 *
 * A console launch records an outer terminal-wrapper row before `psu` starts
 * or resumes the real agent. Those wrappers intentionally have no agent,
 * coord owner, or native transcript handle. They are useful lifecycle audit
 * records, but they are not agent sessions and cannot open in the transcript
 * inspector. Keep them out of this agent-history feed instead of rendering a
 * dead `resume · …` row in the Agents running popover (WI-5103 / EI-13166).
 *
 * Scoped to a workspace when given, else cross-workspace. Most-recently-ended
 * first. adv-sessions-live-roster P-003.
 */
export async function listEndedAdvSessions(
  opts: { workspaceId?: string | null; limit?: number; before?: string | null } = {},
): Promise<AdvSessionRow[]> {
  const limit = opts.limit ?? 50;
  const ws = opts.workspaceId ?? null;
  // Keyset cursor for the "inactive sessions" infinite scroll: only rows that
  // ended strictly BEFORE this timestamp. ended_at DESC + `before` = the next
  // page; null = the first page. (agents-pill-inactive-search-2026-07-09 P-001)
  const before = opts.before ?? null;
  try {
    const { sql } = getOrgPg();
    const workspacePredicate = ws === null ? true : sql`workspace_id = ${ws}`;
    const rows = await sql<
      Array<{
        id: number;
        workspace_id: string;
        plan_slug: string | null;
        agent: string | null;
        role: string | null;
        feature: string | null;
        mode: 'omp' | 'console';
        terminal_bin: string | null;
        pid: number | null;
        window_id: string | null;
        omp_thread_id: string | null;
        label: string | null;
        cwd: string | null;
        coord_owner_id: string | null;
        session_id: string | null;
        started_at: string | Date;
        ended_at: string | Date | null;
        exit_code: number | null;
      }>
    >`
      SELECT id, workspace_id, plan_slug, agent, role, feature, mode, terminal_bin, pid,
             window_id, omp_thread_id, label, cwd, coord_owner_id, session_id, started_at, ended_at, exit_code, ended_by, ended_signal
        FROM harness_shared.adv_sessions
       WHERE ended_at IS NOT NULL
         -- Match the transcript handles understood by endedSessionStreamUrl:
         -- Claude/native UUID, OMP thread id, or Codex's per-row CODEX_HOME.
         -- In particular, this excludes handleless console-launch wrappers.
         AND (
           NULLIF(BTRIM(session_id), '') IS NOT NULL
           OR NULLIF(BTRIM(omp_thread_id), '') IS NOT NULL
           OR agent = 'codex'
         )
         AND ${workspacePredicate}
         AND (${before}::timestamptz IS NULL OR ended_at < ${before}::timestamptz)
       ORDER BY ended_at DESC
       LIMIT ${limit}
    `;
    return rows.map(mapAdvSessionRow);
  } catch (e) {
    warnUnlessMissingTable(e, 'listEndedAdvSessions');
    return [];
  }
}

/** One agent session attributed to a plan, display-shaped for the plan popup's
 *  Sessions tab (owner-plans-single-pane-2026-07-17 P-004). One row per distinct
 *  agent identity (coord_owner_id) — the addressable unit SessionChatModal
 *  resolves owner → live/recent transcript from. */
export interface PlanSessionRow {
  coordOwnerId: string;
  sessionId: string | null;
  ompThreadId: string | null;
  agent: string | null;
  mode: 'omp' | 'console';
  role: string | null;
  label: string | null;
  startedAt: string;
  endedAt: string | null;
  /** ended_at IS NULL — the process has not cleanly exited (a live/recent
   *  session). The client still ages very old NULLs out visually. */
  live: boolean;
  /** How this session was attributed: 'plan' = launched bound to this plan
   *  (adv_sessions.plan_slug); 'claim' = a plan-UNBOUND session of an agent that
   *  claimed/completed one of the plan's work-items (D-005 supplement leg). */
  via: 'plan' | 'claim';
}

/**
 * Every agent session that touched a plan (owner-plans-single-pane-2026-07-17
 * P-004) — the plan popup's Sessions tab. Two legs (D-005):
 *   A. PRIMARY — adv_sessions whose plan_slug binds them to this plan (the
 *      launch binding; the reliable backbone).
 *   B. SUPPLEMENT — plan-UNBOUND sessions (plan_slug IS NULL) of agents that
 *      are terminal_owner / taken_by on a feature-family work-item created from
 *      this plan (source_plan_slug). Catches an agent that claimed plan work but
 *      was launched without a plan binding. Deliberately excludes a session
 *      bound to a DIFFERENT plan, so it never misattributes.
 * DISTINCT ON (coord_owner_id) — one row per agent identity, preferring its
 * plan-bound session then its most recent. Best-effort → [] on any DB error.
 */
export async function listPlanSessions(
  planSlug: string,
  opts: { workspaceId?: string | null; limit?: number } = {},
): Promise<PlanSessionRow[]> {
  const ws = opts.workspaceId ?? null;
  const limit = Math.min(500, Math.max(1, opts.limit ?? 200));
  if (!planSlug) return [];
  try {
    const { sql } = getOrgPg();
    const workspacePredicate = ws === null ? true : sql`s.workspace_id = ${ws}`;
    const rows = await sql<
      Array<{
        coord_owner_id: string;
        session_id: string | null;
        omp_thread_id: string | null;
        agent: string | null;
        mode: 'omp' | 'console';
        role: string | null;
        label: string | null;
        started_at: string | Date;
        ended_at: string | Date | null;
        via: 'plan' | 'claim';
      }>
    >`
      WITH claim_owners AS (
        SELECT DISTINCT owner FROM (
          SELECT terminal_owner AS owner
            FROM harness_shared.work_items
           WHERE source_plan_slug = ${planSlug} AND terminal_owner IS NOT NULL
          UNION
          SELECT taken_by AS owner
            FROM harness_shared.work_items
           WHERE source_plan_slug = ${planSlug} AND taken_by IS NOT NULL
        ) o
      ),
      candidate AS (
        SELECT s.coord_owner_id, s.session_id, s.omp_thread_id, s.agent, s.mode,
               s.role, s.label, s.started_at, s.ended_at, 'plan'::text AS via
          FROM harness_shared.adv_sessions s
         WHERE s.plan_slug = ${planSlug}
           AND s.coord_owner_id IS NOT NULL
           AND ${workspacePredicate}
        UNION ALL
        SELECT s.coord_owner_id, s.session_id, s.omp_thread_id, s.agent, s.mode,
               s.role, s.label, s.started_at, s.ended_at, 'claim'::text AS via
          FROM harness_shared.adv_sessions s
          JOIN claim_owners c ON c.owner = s.coord_owner_id
         WHERE s.plan_slug IS NULL
           AND s.coord_owner_id IS NOT NULL
           AND ${workspacePredicate}
      ),
      deduped AS (
        SELECT DISTINCT ON (coord_owner_id)
               coord_owner_id, session_id, omp_thread_id, agent, mode, role,
               label, started_at, ended_at, via
          FROM candidate
         ORDER BY coord_owner_id, (via = 'plan') DESC, started_at DESC
      )
      SELECT * FROM deduped
       ORDER BY (ended_at IS NULL) DESC, started_at DESC
       LIMIT ${limit}
    `;
    return rows.map((r) => ({
      coordOwnerId: r.coord_owner_id,
      sessionId: r.session_id,
      ompThreadId: r.omp_thread_id,
      agent: r.agent,
      mode: r.mode,
      role: r.role,
      label: r.label,
      startedAt: toIsoTimestamp(r.started_at) ?? new Date(0).toISOString(),
      endedAt: toIsoTimestamp(r.ended_at),
      live: r.ended_at == null,
      via: r.via,
    }));
  } catch (e) {
    warnUnlessMissingTable(e, 'listPlanSessions');
    return [];
  }
}

/**
 * adv_sessions rows matched by their transcript handles — `session_id` (a
 * claude transcript uuid) or `omp_thread_id`. Used by the transcript-search
 * route to attach session metadata (label/plan/agent/endedAt + the codex
 * open-key `id`) to session_turns hits (agents-pill-inactive-search-2026-07-09
 * P-002). Newest row per handle wins downstream (rows come back newest-first).
 */
export async function advSessionsByTranscriptHandles(handles: {
  sessionIds?: readonly string[];
  ompThreadIds?: readonly string[];
}): Promise<AdvSessionRow[]> {
  const sessionIds = handles.sessionIds && handles.sessionIds.length ? [...handles.sessionIds] : null;
  const ompThreadIds = handles.ompThreadIds && handles.ompThreadIds.length ? [...handles.ompThreadIds] : null;
  if (!sessionIds && !ompThreadIds) return [];
  try {
    const { sql } = getOrgPg();
    const rows = await sql<
      Array<{
        id: number;
        workspace_id: string;
        plan_slug: string | null;
        agent: string | null;
        role: string | null;
        feature: string | null;
        mode: 'omp' | 'console';
        terminal_bin: string | null;
        pid: number | null;
        window_id: string | null;
        omp_thread_id: string | null;
        label: string | null;
        cwd: string | null;
        coord_owner_id: string | null;
        session_id: string | null;
        launch_argv: string[] | null;
        started_at: string | Date;
        ended_at: string | Date | null;
        exit_code: number | null;
      }>
    >`
      SELECT id, workspace_id, plan_slug, agent, role, feature, mode, terminal_bin, pid,
             window_id, omp_thread_id, label, cwd, coord_owner_id, session_id, launch_argv, started_at, ended_at, exit_code, ended_by, ended_signal
        FROM harness_shared.adv_sessions
       WHERE (${sessionIds}::text[] IS NOT NULL AND session_id = ANY(${sessionIds}::text[]))
          OR (${ompThreadIds}::text[] IS NOT NULL AND omp_thread_id = ANY(${ompThreadIds}::text[]))
       ORDER BY started_at DESC
       LIMIT 500
    `;
    return rows.map(mapAdvSessionRow);
  } catch (e) {
    warnUnlessMissingTable(e, 'advSessionsByTranscriptHandles');
    return [];
  }
}

/**
 * WI-37204 — recorded sessions whose coord owner id, native session id, or omp
 * thread id STARTS WITH `token`. Backs the id leg of
 * GET /api/adv/sessions/search-transcripts, which is what makes an ENDED
 * session findable by an id pasted out of a log or a work-item (the live roster
 * only answers for sessions that are still running).
 *
 * Prefix, not substring: `su-bc38a419` must find `su-bc38a419-8dc6-…` (the
 * short handle IS what the UI renders), while an id's tail is not a handle
 * anyone is given and a mid-string match would pull in unrelated sessions that
 * merely share a run of hex. `token` is lowercased by the caller
 * (`parseSessionIdQuery`); the columns hold lowercase uuids, so the comparison
 * is done on `lower(col)` to stay correct for any row that ever stored one
 * mixed-case.
 *
 * `like_escape` guards the two LIKE metacharacters: an id token is
 * caller-supplied text, and an unescaped `%` would turn a typo into a
 * whole-table scan that matches everything.
 */
export async function advSessionsByIdToken(token: string, opts: { limit?: number } = {}): Promise<AdvSessionRow[]> {
  const t = token.trim().toLowerCase();
  if (!t) return [];
  const limit = Math.min(200, Math.max(1, opts.limit ?? 50));
  const pattern = `${t.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  try {
    const { sql } = getOrgPg();
    const rows = await sql<
      Array<{
        id: number;
        workspace_id: string;
        plan_slug: string | null;
        agent: string | null;
        role: string | null;
        feature: string | null;
        mode: 'omp' | 'console';
        terminal_bin: string | null;
        pid: number | null;
        window_id: string | null;
        omp_thread_id: string | null;
        label: string | null;
        cwd: string | null;
        coord_owner_id: string | null;
        session_id: string | null;
        started_at: string | Date;
        ended_at: string | Date | null;
        exit_code: number | null;
      }>
    >`
      SELECT id, workspace_id, plan_slug, agent, role, feature, mode, terminal_bin, pid,
             window_id, omp_thread_id, label, cwd, coord_owner_id, session_id, started_at, ended_at, exit_code, ended_by, ended_signal
        FROM harness_shared.adv_sessions
       WHERE lower(coord_owner_id) LIKE ${pattern}
          OR lower(session_id)     LIKE ${pattern}
          OR lower(omp_thread_id)  LIKE ${pattern}
       ORDER BY started_at DESC
       LIMIT ${limit}
    `;
    return rows.map(mapAdvSessionRow);
  } catch (e) {
    warnUnlessMissingTable(e, 'advSessionsByIdToken');
    return [];
  }
}
