/**
 * idle-session-reaper.ts — reap DEAD-process SU CLI sessions.
 *
 * Plan: operator-memory-and-psu-resilience-2026-06-14 P-011 (D-007).
 *
 * D-007 (su-4b005/su-36a0c): the single :3070 operator event loop is the
 * chokepoint — ~52 long-lived SU sessions each hold LISTEN conns + polling on
 * top of the eager all-harness substrate, so new spawns crawl. Idle/done SU
 * sessions persist for hours, never freeing their operator/LISTEN/MCP footprint.
 *
 * THIS MODULE (P-011 slice 1) is the SAFE foundation: a periodic sweep that
 * marks an OPEN `adv_sessions` row (`ended_at IS NULL`) ENDED once its owning
 * process is DEAD — i.e. its `coord_owner_id` has dropped out of the liveness
 * set (no fresh `coord_presence` heartbeat, no running `spawned_agents` alias,
 * no registered wake, holds no work-item claim) for longer than the grace
 * window. A LIVE psu session heartbeats its presence row every 60s (the
 * supervisor beat, psu-launcher.startSupervisorBeat) regardless of activity, so
 * a present owner is ALWAYS protected — this can only ever reap a session whose
 * process has already exited without stamping `ended_at` (the best-effort
 * reportSessionEnded didn't run). Reaping such a ghost reclaims the live roster
 * and unblocks `session-dir-gc` (which protects every `ended_at IS NULL` row).
 *
 * What this slice deliberately does NOT do: terminate a LIVE-but-idle session
 * (the actual event-loop-saturation fix). That needs an activity-based idle
 * signal + safe termination via the managed-pty control socket
 * (turn-lifecycle-control) and is the follow-on slice — see the plan.
 *
 * Liveness rule is deliberately identical to work-items-stale-claims.ts /
 * the mig-225 fleet_assignment view (EI-311) so the reapers can never disagree.
 *
 * The keep/reap decision is a PURE function (`planIdleSessionReap`, injected
 * clock + protected set) so it unit-tests without PG; the sweep wraps it with
 * the PG gather + the `markAdvSessionEnded` write. Flag-gated DEFAULT-OFF
 * (FLAGS.IDLE_SESSION_REAPER) — off ⇒ a no-op. Server-only.
 */

import { readdir, readFile } from 'node:fs/promises';
import { classifyAgentPane } from '@papercusp/agent-mcp';
import { STALE_MS } from './liveness';
import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';
import { getOrgPg } from '@papercusp/db-org';
import { markAdvSessionEnded } from './adv-sessions';
import { interruptViaPty, findLiveHost, listLiveHostsAsync } from './events/await/psu-pty-discovery';
import { COORD_INBOX_WAKE_PREFIX } from './agent-tools/coordination/inbox-wake';
import { AWAIT_CANCEL_REASONS } from './events/await/cancel-reasons';
import { gatherOnDesktopSessions, isPidUnderOpenWindow } from './desktop-window-liveness';
import { gatherViewerAttachedOwners } from './pty-viewer-heartbeat';
import { issuesScopeWorkspace } from './issues-engineer';
import { activeWorkspaceId } from './workspace-registry';
import { releaseAllWorkItemLeasesForOwner } from './work-item-lease-release';
import { probeProcessLiveness } from './agent-tools/coordination/presence';
import { nodeCgroupFs } from './task-manager/cgroup-read';
import { cgroupWindowProtects, isPidInLiveWindowScope } from './task-manager/terminal-residue-census';
import { ensureBootstrap, getTxPool, tryRelease, tryReleaseResource } from './agent-tools/locks/su-lock-store';
import { inWorkspaceTxn } from './agent-tools/locks/in-workspace-txn';

/** Liveness/grace window. Matches work-items-stale-claims STALE_CLAIM_GRACE_MS
 *  and the fleet_assignment view (10 min): a live psu session's supervisor beat
 *  (every 60s) refreshes presence well inside it, so a briefly-quiet but alive
 *  session is never reaped. Also the floor on `started_at` so a just-launched
 *  session (presence not yet written in its first seconds) is never reaped. */
export const IDLE_SESSION_GRACE_MS = STALE_MS;

/** One open adv_session considered for reaping. */
export interface ReapableSession {
  id: number;
  coordOwnerId: string | null;
  startedAtMs: number;
}

export interface IdleSessionReapPlan {
  /** Dead owner (not protected) AND older than the grace floor → reap. */
  reap: ReapableSession[];
  /** Owner is live/claim/wake-protected → keep. */
  keptLive: ReapableSession[];
  /** Within the grace floor (too new to judge) → keep. */
  keptFresh: ReapableSession[];
  /** No coord_owner_id → can't liveness-check → never reap (kept). */
  keptNoOwner: ReapableSession[];
}

/**
 * PURE keep/reap decision. A session is reaped ONLY when it has a
 * coord_owner_id, that owner is NOT in the protected (live) set, AND it started
 * longer ago than the grace floor. No I/O — `nowMs` + `protectedOwners`
 * injected so the boundary is unit-tested deterministically.
 */
export function planIdleSessionReap(opts: {
  sessions: ReapableSession[];
  protectedOwners: Set<string>;
  nowMs: number;
  graceMs?: number;
}): IdleSessionReapPlan {
  const graceMs = opts.graceMs ?? IDLE_SESSION_GRACE_MS;
  const plan: IdleSessionReapPlan = { reap: [], keptLive: [], keptFresh: [], keptNoOwner: [] };
  for (const s of opts.sessions) {
    if (!s.coordOwnerId) {
      plan.keptNoOwner.push(s); // no liveness key → never reap (can't prove it's dead)
    } else if (opts.protectedOwners.has(s.coordOwnerId)) {
      plan.keptLive.push(s); // fresh presence / running bee / registered wake / open claim
    } else if (opts.nowMs - s.startedAtMs < graceMs) {
      plan.keptFresh.push(s); // too new — its first presence beat may not have landed yet
    } else {
      plan.reap.push(s); // dead owner, past grace → ghost row, end it
    }
  }
  return plan;
}

/**
 * PURE (WI-1967 — Windows conservative-on-stale). When the on-desktop WINDOW
 * signal is UNAVAILABLE on a Windows host (GUI closed/backgrounded → no fresh
 * renderer push → we cannot tell which `wt.exe` terminals are still open), NO
 * open session may be reaped on the (absent) window signal — so EVERY open
 * session's owner must be protected this sweep. Returns the extra owners to fold
 * into the protected set AND the count of sessions this actually RESCUED from an
 * otherwise-certain reap (owner not already protected AND past the grace floor —
 * i.e. exactly what `planIdleSessionReap` would have reaped without the fold),
 * for observability. A no-op (`[]`, `0`) when the signal is known — always so on
 * Linux/macOS — so the caller's non-Windows behavior is byte-for-byte unchanged.
 * Injected clock so the grace boundary is deterministic.
 */
export function planWindowUnknownProtection(opts: {
  sessions: ReapableSession[];
  windowSignalUnknown: boolean;
  alreadyProtected: ReadonlySet<string>;
  nowMs: number;
  graceMs?: number;
}): { extraProtectedOwners: string[]; keptWindowSignalUnknown: number } {
  if (!opts.windowSignalUnknown) return { extraProtectedOwners: [], keptWindowSignalUnknown: 0 };
  const graceMs = opts.graceMs ?? IDLE_SESSION_GRACE_MS;
  const extra = new Set<string>();
  let keptWindowSignalUnknown = 0;
  for (const s of opts.sessions) {
    if (!s.coordOwnerId) continue; // no owner → planIdleSessionReap never reaps it anyway
    extra.add(s.coordOwnerId);
    // Count only the sessions this fold actually saved: an owner NOT already
    // protected AND past the grace floor is precisely one planIdleSessionReap
    // would have reaped. A within-grace or already-protected session was never
    // at risk, so it must not inflate the metric. Per-session (not per-owner):
    // two ghost rows for one dead owner are two sessions spared.
    if (!opts.alreadyProtected.has(s.coordOwnerId) && opts.nowMs - s.startedAtMs >= graceMs) {
      keptWindowSignalUnknown += 1;
    }
  }
  return { extraProtectedOwners: [...extra], keptWindowSignalUnknown };
}

/**
 * PURE (WI-2858): the coord-owner ids that have a LIVE psu-pty host on this box.
 * `listLiveHosts()` self-validates (pid alive + socket exists + psu-host identity)
 * and records each host's owning coord id as `ownerId` — so this is exactly "the
 * owners whose interactive session could be injected/relaunched right now". This
 * is the signal that BREAKS the slice-1↔slice-4 mutual-protection deadlock: a
 * standing inbox-wake await (slice-1's old leg) and an open adv_session (slice-4's
 * leg) each STOP being self-justifying "alive" signals; a live host (or a fresh
 * heartbeat, kept as its own leg) is what actually protects. Structural param so it
 * unit-tests without constructing a full PsuPtyHost.
 */
export function liveHostOwnerSet(hosts: ReadonlyArray<{ ownerId?: string | null }>): Set<string> {
  const out = new Set<string>();
  for (const h of hosts) if (h?.ownerId) out.add(h.ownerId);
  return out;
}

/**
 * PURE: resolve the local PID rows that are affirmatively gone. A missing PID,
 * remote host, or EPERM is inconclusive and therefore never enters the set.
 * Keeping the probe injectable makes the claim-release path testable without
 * killing real processes.
 */
export function confirmedDeadOwnerSet(
  rows: ReadonlyArray<{ ownerId?: string | null; host?: string | null; pid?: number | null }>,
  probe: (row: { host?: string | null; pid?: number | null }) => boolean | null = probeProcessLiveness,
): Set<string> {
  const out = new Set<string>();
  for (const row of rows) {
    if (row.ownerId && probe(row) === false) out.add(row.ownerId);
  }
  return out;
}

/**
 * PURE (EI-21434105273882121): which owners the dead-pid probe may UN-protect.
 * A dead pid probe is evidence about the RECORDED process, not the OWNER: under
 * carry-respawn the coord owner id survives its incarnation, and in the respawn
 * gap the presence row still carries the OLD (now dead) pid while the owner is
 * actively working. The 2026-08-25 incident: the lease-release flight record
 * fired at 14:03:42.395Z, the successor adv_session row was inserted 244ms
 * LATER, and the holder's own tool calls were seconds old — every protective
 * leg (fresh heartbeat, live host) was overridden by one dead probe of the
 * stale recorded pid, force-releasing a progressing worker's claims and
 * inviting a double-claim.
 *
 * Affirmative recent GENUINE ACTIVITY therefore VETOES the removal: an
 * `activeFresh` row (coord_presence.last_active_at within grace — mig 277:
 * bumped ONLY by real activity, never by the per-60s supervisor beat, so a
 * dead process cannot keep it fresh) keeps its owner protected even when the
 * recorded pid probes dead. The cost asymmetry is deliberate: an
 * activity-vetoed false KEEP delays lease cleanup by at most the grace window;
 * a loop-vetoed KEEP lasts until the loop's bounded reachability guard
 * deactivates it. A false REMOVE force-releases a live worker's in-flight
 * claims — the exact false-alarm-class bug this guards against.
 *
 * EI-21431501901242395: an ARMED engine loop is the same kind of owner-level
 * veto. The recorded pid belongs to one native incarnation; the loop is durable
 * continuation authority for the coordination owner across incarnations. A
 * dead old pid therefore cannot erase active-loop protection either.
 */
export function planDeadPidUnprotect(
  rows: ReadonlyArray<{
    ownerId?: string | null;
    host?: string | null;
    pid?: number | null;
    activeFresh?: boolean;
    loopActive?: boolean;
  }>,
  probe: (row: { host?: string | null; pid?: number | null }) => boolean | null = probeProcessLiveness,
): { unprotect: string[]; vetoedByActivity: string[]; vetoedByLoop: string[] } {
  const activeFresh = new Set<string>();
  for (const row of rows) if (row.ownerId && row.activeFresh === true) activeFresh.add(row.ownerId);
  const loopActive = new Set<string>();
  for (const row of rows) if (row.ownerId && row.loopActive === true) loopActive.add(row.ownerId);
  const unprotect: string[] = [];
  const vetoedByActivity: string[] = [];
  const vetoedByLoop: string[] = [];
  for (const owner of confirmedDeadOwnerSet(rows, probe)) {
    if (activeFresh.has(owner)) vetoedByActivity.push(owner);
    else if (loopActive.has(owner)) vetoedByLoop.push(owner);
    else unprotect.push(owner);
  }
  return { unprotect, vetoedByActivity, vetoedByLoop };
}

/**
 * PURE (WI-2858): which owners' OPEN adv_session counts as genuinely RESUMABLE —
 * only those with a LIVE psu-host that can relaunch/inject the wake. An open
 * adv_session ALONE is NOT enough: that was the slice-4 half of the deadlock — a
 * SIGKILLed session keeps `ended_at IS NULL` forever, so counting it "resumable"
 * kept its dangling inbox-wake await alive, which (via slice-1) kept the
 * adv_session "alive". A stale-heartbeat session with no live host is genuinely
 * gone; its await must be reclaimable so coord:presence shows it `ended`.
 */
export function resumableOpenSessionOwners(
  openAdvSessionOwners: Iterable<string>,
  liveHostOwners: ReadonlySet<string>,
): string[] {
  return [...new Set(openAdvSessionOwners)].filter((o) => o && liveHostOwners.has(o));
}

/**
 * Best-effort: the coord-owner ids with a LIVE psu-pty host on this box. Never
 * throws — a missing discovery dir / FS error yields an EMPTY set, in which case
 * host-liveness protects nobody and protection falls back to the heartbeat / bee /
 * wake-delivery legs alone (a genuinely-live session still heartbeats every 60s, so
 * it stays protected regardless; only the stale-heartbeat-but-live-host COLD cohort
 * relies on this leg). Local — the sweep functions call it once each.
 */
async function safeLiveHostOwners(): Promise<Set<string>> {
  try {
    // Async (WI-10004587): a sync psu-pty directory scan here froze the operator main thread.
    return liveHostOwnerSet(await listLiveHostsAsync());
  } catch {
    return new Set<string>();
  }
}

/**
 * The set of coord owner ids that are ALIVE / must never be reaped — the same
 * alias-aware liveness as work-items-stale-claims (presence + running nursery
 * aliases) UNION in-flight wake deliveries (the owner is mid-resume) UNION any
 * owner with an armed engine loop (durable same-owner continuation authority)
 * UNION any work-item claim holder (never reap a session mid-claim) UNION any
 * owner with a LIVE psu-host (`liveHostOwners`; it can inject/relaunch the wake).
 * One read.
 *
 * WI-2858: the old bare `event_awaits` leg (protect ANY owner with an
 * unfired/uncancelled await) is REMOVED — every parked session holds an
 * always-armed inbox-wake await, so that leg protected every dead session and was
 * the slice-1 half of the mutual-protection deadlock. A live HOST now carries the
 * "a wake can still reach it" protection WITHOUT the deadlock; a genuinely-live
 * session is independently protected by its fresh supervisor heartbeat.
 *
 * `includeClaimHolders` (default true) toggles the `taken_by` leg. Default true
 * preserves the EXISTING session-reap behavior (slice 1: never end a session
 * mid-claim). session-death-claim-release-2026-07-11 P-001: this leg is
 * SELF-REFERENTIAL for a KILLED claim holder — a dead agent's own still-held
 * lease is exactly what this leg reads back as "protected", so a claim alone
 * can wedge that owner "live" forever regardless of true process death (the
 * WI-4070 incident, EI-9807). The work-item-LEASE reaper below
 * (`runWorkItemLeaseReap`) must judge an owner's liveness WITHOUT this leg —
 * pass `includeClaimHolders:false` there — or it could never fire for the
 * exact scenario it exists to fix.
 */
export async function gatherProtectedSessionOwners(
  sql: Awaited<ReturnType<typeof getOrgPg>>['sql'],
  opts: {
    graceMs?: number;
    liveHostOwners?: ReadonlySet<string>;
    includeClaimHolders?: boolean;
    /** Probe the recorded local process identity and remove confirmed-dead owners. */
    confirmDeadPids?: boolean;
    /**
     * EI-22651749738479868: the owner whose session has JUST ENDED. Its own
     * coord_presence heartbeat / last_active_at are still fresh (STALE_MS=600s)
     * for far longer than the session-end release retries span (<=60s), so
     * without this the ending owner protects ITSELF and the release never
     * fires ("owner-live" on every attempt). The caller has already
     * established the owner has no OTHER open session; every other leg
     * (live psu host, armed loop, pending wake delivery, spawned_agents
     * heartbeat) still protects it.
     */
    ignoreOwnPresenceFor?: string;
  } = {},
): Promise<Set<string>> {
  const graceSec = Math.max(1, Math.round((opts.graceMs ?? IDLE_SESSION_GRACE_MS) / 1000));
  const includeClaimHolders = opts.includeClaimHolders !== false;
  const ignoredPresenceOwner = opts.ignoreOwnPresenceFor?.trim() || '';
  // EI-19357343... (WI-6638 side-finding): harness_features_consolidated is the
  // FEATURE-ONLY view (`WHERE item_kind <> ALL ('{bug,change,task}')` — see its
  // pg_get_viewdef) — issue-family (bug/change/task) claims live in
  // harness_shared.engineer_issues (`assignee`), exactly the split
  // runWorkItemLeaseReap below already unions correctly. Without this leg, a
  // session actively holding a WI-/EI- claim (the majority of live issue-family
  // work) was invisible to this "claim holder" protection and could be
  // live-idle-terminated out from under genuine in-flight work.
  const issueWs = issuesScopeWorkspace();
  const rows = await sql<Array<{ alias: string }>>`
    WITH owners AS (
      SELECT owner_id AS alias
        FROM harness_shared.coord_presence
       WHERE heartbeat_at IS NOT NULL
         AND (now() - heartbeat_at) < make_interval(secs => ${graceSec})
         AND owner_id <> ${ignoredPresenceOwner}
      UNION
      SELECT a.alias
        FROM harness_shared.spawned_agents n
        CROSS JOIN LATERAL (VALUES (n.spawn_id), (n.session_owner), (n.run_id)) AS a(alias)
       WHERE n.status IN ('running', 'restarting')
         AND n.heartbeat_at IS NOT NULL
         AND (now() - n.heartbeat_at) < make_interval(secs => ${graceSec})
      UNION
      SELECT subscriber_id AS alias
        FROM harness_shared.event_wake_deliveries
       WHERE status IN ('pending', 'parked', 'delivering')
      UNION
      -- EI-21431501901242395: a loop deliberately survives the current native
      -- session incarnation and re-invokes the SAME owner. Protect that owner
      -- between warm wakes even when its heartbeat/host row is temporarily
      -- absent; once the loop is inactive this leg disappears and ordinary
      -- terminal cleanup remains unchanged.
      SELECT DISTINCT target_owner_id AS alias
        FROM harness_shared.routines
       WHERE active = true
         AND reschedule_interval_sec IS NOT NULL
         AND target_owner_id IS NOT NULL AND target_owner_id <> ''
      UNION
      SELECT taken_by AS alias
        FROM harness_shared.harness_features_consolidated
       WHERE ${includeClaimHolders ? sql`TRUE` : sql`FALSE`}
         AND taken_by IS NOT NULL
      UNION
      SELECT assignee AS alias
        FROM harness_shared.engineer_issues
       WHERE ${includeClaimHolders ? sql`TRUE` : sql`FALSE`}
         AND workspace_id = ${issueWs} AND assignee IS NOT NULL AND assignee <> ''
    )
    SELECT DISTINCT alias FROM owners WHERE alias IS NOT NULL AND alias <> ''`;
  const protectedOwners = new Set(rows.map((r) => r.alias));
  // WI-2858: a LIVE psu-host protects (it can inject/relaunch the wake) — this
  // REPLACES the removed bare-await leg without the slice-1↔slice-4 deadlock.
  for (const o of opts.liveHostOwners ?? []) protectedOwners.add(o);
  if (opts.confirmDeadPids) {
    const pidRows = await sql<
      Array<{
        owner_id: string;
        host: string | null;
        pid: number | null;
        active_fresh: boolean;
        loop_active: boolean;
      }>
    >`
      SELECT DISTINCT owner_id, host, pid,
             (last_active_at IS NOT NULL
              AND (now() - last_active_at) < make_interval(secs => ${graceSec})
              AND owner_id <> ${ignoredPresenceOwner}) AS active_fresh,
             EXISTS (
               SELECT 1 FROM harness_shared.routines r
                WHERE r.target_owner_id = coord_presence.owner_id
                  AND r.active = true
                  AND r.reschedule_interval_sec IS NOT NULL
             ) AS loop_active
        FROM harness_shared.coord_presence
       WHERE owner_id IS NOT NULL AND pid IS NOT NULL AND pid > 0 AND host IS NOT NULL AND host <> ''`;
    // EI-21434105273882121: fresh GENUINE activity vetoes the dead-pid removal
    // (see planDeadPidUnprotect). A dead probe of the RECORDED pid must not
    // override affirmative seconds-old activity — under carry-respawn the
    // recorded pid goes stale while the owner id lives on, and deleting here
    // is what force-released a progressing holder's claims mid-work.
    const { unprotect } = planDeadPidUnprotect(
      pidRows.map((r) => ({
        ownerId: r.owner_id,
        host: r.host,
        pid: r.pid,
        activeFresh: r.active_fresh,
        loopActive: r.loop_active,
      })),
    );
    for (const owner of unprotect) {
      protectedOwners.delete(owner);
    }
  }
  return protectedOwners;
}

export interface IdleSessionReapResult {
  /** False when the flag is off (a no-op). */
  enabled: boolean;
  /** Open adv_sessions considered. */
  scanned: number;
  /** Rows marked ended (or that WOULD be, when dryRun). */
  reaped: number;
  reapedIds: number[];
  /** Owners kept because live/claim/wake-protected. */
  keptLive: number;
  /** Owners kept because the session is CURRENTLY on the desktop (a live OS
   *  window) — the hard-exemption (owner decision 2026-06-29). Subset of
   *  keptLive (on-desktop owners are folded into the protected set). */
  keptOnDesktop: number;
  /** Owners kept because a human is CURRENTLY viewing the session's terminal in the
   *  operator web/Tauri PTY panel (pty-viewer-heartbeat.ts) — the deferred sibling of
   *  keptOnDesktop for the no-OS-window case. Subset of keptLive (folded into the
   *  protected set). */
  keptViewerAttached: number;
  /** WINDOWS conservative-on-stale (WI-1967): sessions that WOULD have been reaped
   *  (dead-owner, past grace, no other protection) but were spared because the
   *  on-desktop window signal was UNAVAILABLE on this Windows host (GUI
   *  closed/backgrounded → no fresh renderer push → we can't tell which wt.exe
   *  terminals are open). Always 0 on Linux/macOS and whenever the window cache is
   *  fresh. A non-zero value here every sweep means the GUI reporter is down while
   *  sessions run — worth surfacing (the durable fix is a non-GUI enumeration). */
  keptWindowSignalUnknown: number;
  dryRun: boolean;
}

/**
 * The top-level sweep the `system:idle-session-reaper` routine fires. Gathers
 * the protected set + the open sessions from PG, plans, then marks the reapable
 * ghosts ended (unless dryRun). FLAG-GATED DEFAULT-OFF — a no-op when off.
 * Best-effort: a PG failure returns a zero result rather than throwing (it must
 * never wedge the routine engine).
 */
export async function runIdleSessionReap(
  opts: { dryRun?: boolean; graceMs?: number } = {},
): Promise<IdleSessionReapResult> {
  const dryRun = !!opts.dryRun;
  const empty: IdleSessionReapResult = {
    enabled: false,
    scanned: 0,
    reaped: 0,
    reapedIds: [],
    keptLive: 0,
    keptOnDesktop: 0,
    keptViewerAttached: 0,
    keptWindowSignalUnknown: 0,
    dryRun,
  };
  const enabled = await getFlag(FLAGS.IDLE_SESSION_REAPER, 'system').catch(() => false);
  if (!enabled) return empty;

  try {
    const { sql } = getOrgPg();
    // Gather the live-protected set AND the on-desktop set concurrently. A
    // session CURRENTLY on the desktop (a live OS window the user is looking at)
    // is HARD-EXEMPT — fold its owner into the protected set so it is never a
    // "ghost" however long its heartbeat has lapsed (owner decision 2026-06-29).
    // gatherOnDesktopSessions is best-effort → empty (headless box / wmctrl
    // failure), so this can only ever PROTECT MORE, never reap more.
    // WI-2858: live psu-host owners protect (a host can inject/relaunch the wake),
    // and REPLACE the removed bare-await leg that deadlocked slice-1 against slice-4.
    const liveHostOwners = await safeLiveHostOwners();
    const [protectedOwners, onDesktop, viewerOwners] = await Promise.all([
      gatherProtectedSessionOwners(sql, { graceMs: opts.graceMs, liveHostOwners, confirmDeadPids: true }),
      gatherOnDesktopSessions().catch(() => null),
      gatherViewerAttachedOwners().catch(() => new Set<string>()),
    ]);
    if (onDesktop) for (const o of onDesktop.owners) protectedOwners.add(o);
    // PTY-panel viewer-attach owners (pty-viewer-heartbeat.ts) are HARD-EXEMPT too:
    // a session a user is watching in the operator web/Tauri terminal panel has NO
    // OS window, so it is invisible to gatherOnDesktopSessions. Best-effort → empty,
    // so this only ever PROTECTS MORE, never reaps more.
    for (const o of viewerOwners) protectedOwners.add(o);
    const open = await sql<Array<{ id: number; coord_owner_id: string | null; started_at: string | Date }>>`
      SELECT id, coord_owner_id, started_at
        FROM harness_shared.adv_sessions
       WHERE ended_at IS NULL`;
    const sessions: ReapableSession[] = open.map((r) => ({
      id: r.id,
      coordOwnerId: r.coord_owner_id,
      startedAtMs: new Date(r.started_at).getTime(),
    }));
    // WI-1967 — Windows conservative-on-stale. When the on-desktop window signal
    // is UNAVAILABLE (Windows host + no fresh renderer push → we can't tell which
    // wt.exe terminals are still open), do NOT reap on the absent window signal:
    // protect EVERY open session's owner this sweep. Windows-only + purely
    // additive (pre-change Windows had no on-desktop exemption at all — see
    // WI-1675), so this can only ever protect more, never reap more; Linux/macOS
    // (windowSignalUnknown always false) is completely unchanged. The decision +
    // the "rescued" count are a PURE helper (planWindowUnknownProtection) so the
    // grace boundary is unit-tested without PG. alreadyProtected is the CURRENT
    // protected set (live + on-desktop + viewer), so the count is exactly the
    // sessions this fold saved from an otherwise-certain reap.
    const nowMs = Date.now();
    const graceMs = opts.graceMs ?? IDLE_SESSION_GRACE_MS;
    const { extraProtectedOwners, keptWindowSignalUnknown } = planWindowUnknownProtection({
      sessions,
      windowSignalUnknown: onDesktop?.windowSignalUnknown === true,
      alreadyProtected: protectedOwners,
      nowMs,
      graceMs,
    });
    for (const o of extraProtectedOwners) protectedOwners.add(o);
    const plan = planIdleSessionReap({
      sessions,
      protectedOwners,
      nowMs,
      graceMs,
    });
    if (!dryRun) {
      // markAdvSessionEnded re-checks `ended_at IS NULL`, so a row that ended
      // (or was reaped by a racing sweep) between the read and here is left alone.
      for (const s of plan.reap) await markAdvSessionEnded(s.id, null, 'reaper');
    }
    const onDesktopOwners = onDesktop?.owners ?? new Set<string>();
    const keptOnDesktop = sessions.filter(
      (s) => s.coordOwnerId != null && onDesktopOwners.has(s.coordOwnerId),
    ).length;
    const keptViewerAttached = sessions.filter(
      (s) => s.coordOwnerId != null && viewerOwners.has(s.coordOwnerId),
    ).length;
    return {
      enabled: true,
      scanned: sessions.length,
      reaped: plan.reap.length,
      reapedIds: plan.reap.map((s) => s.id),
      keptLive: plan.keptLive.length,
      keptOnDesktop,
      keptViewerAttached,
      keptWindowSignalUnknown,
      dryRun,
    };
  } catch (e) {
    console.warn('[idle-session-reaper] sweep failed (non-fatal):', (e as Error)?.message ?? e);
    return { ...empty, enabled: true };
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Slice 1b — WORK-ITEM + NAMED-RESOURCE LEASE reaper
// (session-death-claim-release-2026-07-11 P-001): force-release a work-item
// lease (`taken_by`/`assignee`) or named-resource lock whose owner is DEAD, so
// a killed agent doesn't poison either surface for the full lease TTL (up to
// 6 days observed for work items — EI-9807, WI-4070; EI-20980648124299591 for
// the resource-only gap).
//
// Deliberately DECOUPLED from "the owner's adv_session got marked ended"
// (slice 1 above): gatherProtectedSessionOwners' default `taken_by` leg treats
// holding a claim as itself a liveness signal, so a killed claim-holder's
// ghost session is NEVER reaped in the first place — cascading off slice 1
// would just never fire for the one scenario this exists to fix. Instead this
// judges each lease HOLDER's liveness directly, via the SAME protected-owner
// query with `includeClaimHolders:false` (so a claim can never protect its own
// holder), plus the same on-desktop / viewer-attached / live-host exemptions —
// a claim held by a genuinely-live agent (fresh heartbeat, running bee, mid
// wake-resume, on-desktop, watched in the PTY panel, or a live psu-host) is
// never touched. Same master flag as the session reaper (FLAGS.IDLE_SESSION_REAPER,
// default ON) — no new flag. The production action opts into the named-resource
// leg so a missed SessionEnd hook cannot strand a lock-only owner until TTL.
// ───────────────────────────────────────────────────────────────────────────

/** One currently-held work-item lease (feature or issue family). */
export interface WorkItemLeaseRow {
  id: string;
  /** Feature-family only (harness-scoped); null for issue-family (globally unique id). */
  harness: string | null;
  takenBy: string;
  takenAtMs: number | null;
}

export interface WorkItemLeaseReapPlan {
  /** Dead owner (not protected) AND past the grace floor → force-release. */
  reap: WorkItemLeaseRow[];
  /** Owner is live/on-desktop/watched/host-protected → keep. */
  keptLive: WorkItemLeaseRow[];
  /** Claimed within the grace floor (too new to judge) → keep. */
  keptFresh: WorkItemLeaseRow[];
}

/**
 * PURE keep/reap decision — the lease-reaper analog of `planIdleSessionReap`.
 * No I/O; `nowMs` + `liveOwners` injected so the boundary is unit-tested
 * deterministically. A lease with no `takenAtMs` (should not happen in
 * practice — every claim stamps taken_at/assigned_at) is treated as already
 * past the grace floor rather than protected forever.
 */
export function planWorkItemLeaseReap(opts: {
  leases: WorkItemLeaseRow[];
  liveOwners: ReadonlySet<string>;
  nowMs: number;
  graceMs?: number;
}): WorkItemLeaseReapPlan {
  const graceMs = opts.graceMs ?? IDLE_SESSION_GRACE_MS;
  const plan: WorkItemLeaseReapPlan = { reap: [], keptLive: [], keptFresh: [] };
  for (const lease of opts.leases) {
    if (opts.liveOwners.has(lease.takenBy)) {
      plan.keptLive.push(lease);
    } else if (lease.takenAtMs != null && opts.nowMs - lease.takenAtMs < graceMs) {
      plan.keptFresh.push(lease);
    } else {
      plan.reap.push(lease);
    }
  }
  return plan;
}

/** One currently-held named-resource lease in the SU-lock side database. */
export interface ResourceLockLeaseRow {
  coordinationDomain: string;
  resource: string;
  lockId: string;
  owner: string;
  acquiredAtMs: number | null;
}

export interface FileLockLeaseRow {
  coordinationDomain: string;
  path: string;
  lockId: string;
  owner: string;
  acquiredAtMs: number | null;
}

export interface ResourceLockLeaseReapPlan {
  /** Dead owner (not protected) AND past the grace floor → release the lock. */
  reap: ResourceLockLeaseRow[];
  /** Owner is live/on-desktop/watched/host-protected → keep. */
  keptLive: ResourceLockLeaseRow[];
  /** Lock was acquired within the grace floor (too new to judge) → keep. */
  keptFresh: ResourceLockLeaseRow[];
}

/**
 * PURE keep/reap decision for named-resource leases. Resource locks are owned
 * by the same session identities as work-item leases, but live in the separate
 * `papercusp_su` database. A lock-only owner therefore needs this parallel
 * decision instead of being discovered indirectly through a work-item row.
 */
export function planResourceLockLeaseReap(opts: {
  leases: ResourceLockLeaseRow[];
  liveOwners: ReadonlySet<string>;
  nowMs: number;
  graceMs?: number;
}): ResourceLockLeaseReapPlan {
  const graceMs = opts.graceMs ?? IDLE_SESSION_GRACE_MS;
  const plan: ResourceLockLeaseReapPlan = { reap: [], keptLive: [], keptFresh: [] };
  for (const lease of opts.leases) {
    if (opts.liveOwners.has(lease.owner)) {
      plan.keptLive.push(lease);
    } else if (lease.acquiredAtMs != null && opts.nowMs - lease.acquiredAtMs < graceMs) {
      plan.keptFresh.push(lease);
    } else {
      // A missing acquisition timestamp is anomalous, but treating it as
      // already past grace matches the work-item lease reaper and avoids
      // protecting a dead holder forever on malformed legacy rows.
      plan.reap.push(lease);
    }
  }
  return plan;
}

export interface ResourceLockLeaseReapResult {
  scanned: number;
  reaped: number;
  reapedIds: string[];
  keptLive: number;
  keptFresh: number;
  failedOwners: number;
  dryRun: boolean;
}

const emptyResourceLockLeaseReapResult = (dryRun: boolean): ResourceLockLeaseReapResult => ({
  scanned: 0,
  reaped: 0,
  reapedIds: [],
  keptLive: 0,
  keptFresh: 0,
  failedOwners: 0,
  dryRun,
});

export interface FileLockLeaseReapResult {
  scanned: number;
  reaped: number;
  reapedPaths: string[];
  keptLive: number;
  keptFresh: number;
  failedOwners: number;
  dryRun: boolean;
}

const emptyFileLockLeaseReapResult = (dryRun: boolean): FileLockLeaseReapResult => ({
  scanned: 0,
  reaped: 0,
  reapedPaths: [],
  keptLive: 0,
  keptFresh: 0,
  failedOwners: 0,
  dryRun,
});

/**
 * Apply the dead-owner lease decision to file-lock rows. This is deliberately
 * independent of work-item ownership: a request-release or failed carry-respawn
 * can clear the last work-item lease before the backstop sees the dead owner.
 * The production callback deletes by owner + lock id + path, so a row released
 * and reacquired after the snapshot cannot be mistaken for the predecessor's.
 */
export async function reapFileLockRows(opts: {
  leases: FileLockLeaseRow[];
  liveOwners: ReadonlySet<string>;
  dryRun: boolean;
  graceMs?: number;
  nowMs: number;
  releaseGroup?: (leases: FileLockLeaseRow[]) => Promise<string[]>;
}): Promise<FileLockLeaseReapResult> {
  const plan = planResourceLockLeaseReap({
    leases: opts.leases.map((lease) => ({ ...lease, resource: lease.path })),
    liveOwners: opts.liveOwners,
    nowMs: opts.nowMs,
    graceMs: opts.graceMs,
  });
  if (opts.dryRun) {
    return {
      scanned: opts.leases.length,
      reaped: plan.reap.length,
      reapedPaths: plan.reap.map((lease) => lease.resource),
      keptLive: plan.keptLive.length,
      keptFresh: plan.keptFresh.length,
      failedOwners: 0,
      dryRun: true,
    };
  }
  if (!opts.releaseGroup) return emptyFileLockLeaseReapResult(false);

  const reapKeys = new Set(plan.reap.map((lease) => `${lease.coordinationDomain}\u0000${lease.owner}\u0000${lease.lockId}\u0000${lease.resource}`));
  const byOwnerAndDomain = new Map<string, FileLockLeaseRow[]>();
  for (const lease of opts.leases) {
    const reapKey = `${lease.coordinationDomain}\u0000${lease.owner}\u0000${lease.lockId}\u0000${lease.path}`;
    if (!reapKeys.has(reapKey)) continue;
    const groupKey = `${lease.coordinationDomain}\u0000${lease.owner}`;
    const group = byOwnerAndDomain.get(groupKey);
    if (group) group.push(lease);
    else byOwnerAndDomain.set(groupKey, [lease]);
  }

  const reapedPaths: string[] = [];
  let failedOwners = 0;
  for (const leasesForOwner of byOwnerAndDomain.values()) {
    try {
      reapedPaths.push(...(await opts.releaseGroup(leasesForOwner)));
    } catch (e) {
      failedOwners += 1;
      console.warn(
        `[file-lock-lease-reap] release failed for ${leasesForOwner[0].owner} in ${leasesForOwner[0].coordinationDomain} (non-fatal):`,
        (e as Error)?.message ?? e,
      );
    }
  }
  return {
    scanned: opts.leases.length,
    reaped: reapedPaths.length,
    reapedPaths,
    keptLive: plan.keptLive.length,
    keptFresh: plan.keptFresh.length,
    failedOwners,
    dryRun: false,
  };
}

/**
 * Apply the named-resource dead-owner decision to a lock snapshot. The
 * release callback receives one owner/domain group at a time; production wires
 * it to owner-checked lock-id deletes, while tests can prove the selection and
 * grouping without touching either database.
 */
export async function reapResourceLockRows(opts: {
  leases: ResourceLockLeaseRow[];
  liveOwners: ReadonlySet<string>;
  dryRun: boolean;
  graceMs?: number;
  nowMs: number;
  releaseGroup?: (leases: ResourceLockLeaseRow[]) => Promise<string[]>;
}): Promise<ResourceLockLeaseReapResult> {
  const empty = emptyResourceLockLeaseReapResult(opts.dryRun);
  const plan = planResourceLockLeaseReap({
    leases: opts.leases,
    liveOwners: opts.liveOwners,
    nowMs: opts.nowMs,
    graceMs: opts.graceMs,
  });
  if (opts.dryRun) {
    return {
      scanned: opts.leases.length,
      reaped: plan.reap.length,
      reapedIds: plan.reap.map((lease) => lease.lockId),
      keptLive: plan.keptLive.length,
      keptFresh: plan.keptFresh.length,
      failedOwners: 0,
      dryRun: true,
    };
  }
  if (!opts.releaseGroup) return empty;

  const byOwnerAndDomain = new Map<string, ResourceLockLeaseRow[]>();
  for (const lease of plan.reap) {
    const key = `${lease.coordinationDomain}\u0000${lease.owner}`;
    const group = byOwnerAndDomain.get(key);
    if (group) group.push(lease);
    else byOwnerAndDomain.set(key, [lease]);
  }

  const reapedIds: string[] = [];
  let failedOwners = 0;
  for (const leasesForOwner of byOwnerAndDomain.values()) {
    const coordinationDomain = leasesForOwner[0].coordinationDomain;
    const owner = leasesForOwner[0].owner;
    try {
      reapedIds.push(...(await opts.releaseGroup(leasesForOwner)));
    } catch (e) {
      failedOwners += 1;
      console.warn(
        `[resource-lock-lease-reap] release failed for ${owner} in ${coordinationDomain} (non-fatal):`,
        (e as Error)?.message ?? e,
      );
    }
  }
  return {
    scanned: opts.leases.length,
    reaped: reapedIds.length,
    reapedIds,
    keptLive: plan.keptLive.length,
    keptFresh: plan.keptFresh.length,
    failedOwners,
    dryRun: false,
  };
}

/**
 * Reap dead owners' named-resource locks using the already-computed shared
 * liveness set. The query snapshot includes lock ids and each delete is
 * owner-checked by id, so a lock released and reacquired between the snapshot
 * and cleanup cannot be mistaken for the old row. The SU side database is a
 * best-effort efficiency substrate: one failed owner does not prevent other
 * owners or work-item leases from being reaped.
 */
async function reapResourceLocksForDeadOwners(opts: {
  liveOwners: ReadonlySet<string>;
  dryRun: boolean;
  graceMs?: number;
  nowMs: number;
}): Promise<ResourceLockLeaseReapResult> {
  const empty = emptyResourceLockLeaseReapResult(opts.dryRun);
  try {
    await ensureBootstrap();
    const sql = getTxPool();
    const rows = await sql<
      Array<{
        coordination_domain: string;
        resource: string;
        lock_id: string;
        owner: string;
        acquired_ts: string | Date | null;
      }>
    >`
      SELECT coordination_domain, resource, lock_id::text AS lock_id, owner, acquired_ts
        FROM agent_resource_locks
       WHERE expires_ts > clock_timestamp()
    `;
    const leases: ResourceLockLeaseRow[] = rows.map((row) => ({
      coordinationDomain: row.coordination_domain,
      resource: row.resource,
      lockId: row.lock_id,
      owner: row.owner,
      acquiredAtMs: row.acquired_ts == null ? null : new Date(row.acquired_ts).getTime(),
    }));
    return reapResourceLockRows({
      leases,
      liveOwners: opts.liveOwners,
      dryRun: opts.dryRun,
      graceMs: opts.graceMs,
      nowMs: opts.nowMs,
      releaseGroup: async (leasesForOwner) => {
        const coordinationDomain = leasesForOwner[0].coordinationDomain;
        const owner = leasesForOwner[0].owner;
        const reapedIds: string[] = [];
        await inWorkspaceTxn(coordinationDomain, owner, async (tx) => {
          for (const lease of leasesForOwner) {
            const released = await tryReleaseResource(tx, {
              coordinationDomain,
              owner,
              lockId: lease.lockId,
            });
            if (released.released > 0) reapedIds.push(lease.lockId);
          }
        });
        return reapedIds;
      },
    });
  } catch (e) {
    console.warn('[resource-lock-lease-reap] sweep failed (non-fatal):', (e as Error)?.message ?? e);
    return empty;
  }
}

/** File-lock counterpart to reapResourceLocksForDeadOwners. */
async function reapFileLocksForDeadOwners(opts: {
  liveOwners: ReadonlySet<string>;
  dryRun: boolean;
  graceMs?: number;
  nowMs: number;
}): Promise<FileLockLeaseReapResult> {
  const empty = emptyFileLockLeaseReapResult(opts.dryRun);
  try {
    await ensureBootstrap();
    const sql = getTxPool();
    const rows = await sql<
      Array<{
        coordination_domain: string;
        path: string;
        lock_id: string;
        owner: string;
        acquired_ts: string | Date | null;
      }>
    >`
      SELECT coordination_domain, path, lock_id::text AS lock_id, owner, acquired_ts
        FROM agent_file_locks
       WHERE expires_ts > clock_timestamp()
    `;
    const leases: FileLockLeaseRow[] = rows.map((row) => ({
      coordinationDomain: row.coordination_domain,
      path: row.path,
      lockId: row.lock_id,
      owner: row.owner,
      acquiredAtMs: row.acquired_ts == null ? null : new Date(row.acquired_ts).getTime(),
    }));
    return reapFileLockRows({
      leases,
      liveOwners: opts.liveOwners,
      dryRun: opts.dryRun,
      graceMs: opts.graceMs,
      nowMs: opts.nowMs,
      releaseGroup: async (leasesForOwner) => {
        const coordinationDomain = leasesForOwner[0].coordinationDomain;
        const owner = leasesForOwner[0].owner;
        const reapedPaths: string[] = [];
        await inWorkspaceTxn(coordinationDomain, owner, async (tx) => {
          for (const lease of leasesForOwner) {
            const released = await tryRelease(tx, {
              coordinationDomain,
              owner,
              lockId: lease.lockId,
              paths: [lease.path],
            });
            reapedPaths.push(...released.released);
          }
        });
        return reapedPaths;
      },
    });
  } catch (e) {
    console.warn('[file-lock-lease-reap] sweep failed (non-fatal):', (e as Error)?.message ?? e);
    return empty;
  }
}

export interface WorkItemLeaseReapResult {
  /** False when the flag is off (a no-op). */
  enabled: boolean;
  /** Held leases considered. */
  scanned: number;
  /** Leases force-released (or that WOULD be, when dryRun). */
  reaped: number;
  reapedIds: string[];
  /** Distinct dead owners whose coordination claim ledger was also cleared
   *  (harness_shared.work_item_claims — the EI-9807 two-ledger divergence). */
  ownersReconciled: number;
  keptLive: number;
  keptFresh: number;
  /** Named-resource lease backstop results from the same liveness snapshot. */
  resourceLocks: ResourceLockLeaseReapResult;
  /** File-lock lease backstop results from the same liveness snapshot. */
  fileLocks: FileLockLeaseReapResult;
  dryRun: boolean;
}

/**
 * The top-level sweep — reads current leases + judges each holder's true
 * liveness, then (unless dryRun) force-releases every dead-owner work-item
 * lease AND clears that owner's stale `work_item_claims` rows. When
 * `includeResourceLocks` is enabled by the production action, it also reads
 * the separate SU-lock database and releases dead-owner file + named-resource
 * rows from the same liveness snapshot. Best-effort: a PG failure returns a
 * zero result rather than throwing (must never wedge the routine engine).
 */
export async function runWorkItemLeaseReap(
  opts: { dryRun?: boolean; graceMs?: number; includeResourceLocks?: boolean } = {},
): Promise<WorkItemLeaseReapResult> {
  const dryRun = !!opts.dryRun;
  const empty: WorkItemLeaseReapResult = {
    enabled: false,
    scanned: 0,
    reaped: 0,
    reapedIds: [],
    ownersReconciled: 0,
    keptLive: 0,
    keptFresh: 0,
    resourceLocks: emptyResourceLockLeaseReapResult(dryRun),
    fileLocks: emptyFileLockLeaseReapResult(dryRun),
    dryRun,
  };
  const enabled = await getFlag(FLAGS.IDLE_SESSION_REAPER, 'system').catch(() => false);
  if (!enabled) return empty;

  try {
    const { sql } = getOrgPg();
    const liveHostOwners = await safeLiveHostOwners();
    const [liveOwners, onDesktop, viewerOwners] = await Promise.all([
      // includeClaimHolders:false — see the module comment above: a claim can
      // never be the reason its own holder is judged alive.
      gatherProtectedSessionOwners(sql, {
        graceMs: opts.graceMs,
        liveHostOwners,
        includeClaimHolders: false,
        confirmDeadPids: true,
      }),
      gatherOnDesktopSessions().catch(() => null),
      gatherViewerAttachedOwners().catch(() => new Set<string>()),
    ]);
    if (onDesktop) for (const o of onDesktop.owners) liveOwners.add(o);
    for (const o of viewerOwners) liveOwners.add(o);

    const featureWs = activeWorkspaceId();
    const issueWs = issuesScopeWorkspace();
    const [featureRows, issueRows] = await Promise.all([
      sql<Array<{ id: string; harness: string; taken_by: string; taken_at: string | Date | null }>>`
        SELECT feature_id AS id, harness_slug AS harness, taken_by, taken_at
          FROM harness_shared.harness_features_consolidated
         WHERE workspace_id = ${featureWs} AND taken_by IS NOT NULL AND taken_by <> ''`,
      sql<Array<{ id: string; taken_by: string; taken_at: string | Date | null }>>`
        SELECT issue_id AS id, assignee AS taken_by, assigned_at AS taken_at
          FROM harness_shared.engineer_issues
         WHERE workspace_id = ${issueWs} AND assignee IS NOT NULL AND assignee <> ''`,
    ]);
    const leases: WorkItemLeaseRow[] = [
      ...featureRows.map((r) => ({
        id: r.id,
        harness: r.harness,
        takenBy: r.taken_by,
        takenAtMs: r.taken_at == null ? null : new Date(r.taken_at).getTime(),
      })),
      ...issueRows.map((r) => ({
        id: r.id,
        harness: null,
        takenBy: r.taken_by,
        takenAtMs: r.taken_at == null ? null : new Date(r.taken_at).getTime(),
      })),
    ];

    const nowMs = Date.now();
    const plan = planWorkItemLeaseReap({ leases, liveOwners, nowMs, graceMs: opts.graceMs });
    let ownersReconciled = 0;
    if (!dryRun && plan.reap.length) {
      // Per distinct dead owner: force-release every lease it holds + reconcile
      // its claim ledger via the SHARED core (work-item-lease-release.ts) — the
      // exact same function P-002's event-driven fast path calls, so a session
      // whose SessionEnd never fired (SIGKILL, a raw terminal close, a host
      // crash) still gets the identical release semantics from this backstop.
      const deadOwners = [...new Set(plan.reap.map((l) => l.takenBy))];
      for (const owner of deadOwners) {
        const rel = await releaseAllWorkItemLeasesForOwner(owner);
        if (rel.claimsCleared) ownersReconciled += 1;
      }
    }
    // The SU-lock legs are opt-in because this function is also used by isolated
    // work-item lease tests/environments that do not own the SU-lock side
    // database. The production idle-session action enables both file and named-
    // resource cleanup from this exact liveness snapshot; callers that only need
    // work-item cleanup keep the historic single-database behavior.
    const [resourceLocks, fileLocks] = opts.includeResourceLocks
      ? await Promise.all([
          reapResourceLocksForDeadOwners({
            liveOwners,
            dryRun,
            graceMs: opts.graceMs,
            nowMs,
          }),
          reapFileLocksForDeadOwners({
            liveOwners,
            dryRun,
            graceMs: opts.graceMs,
            nowMs,
          }),
        ])
      : [emptyResourceLockLeaseReapResult(dryRun), emptyFileLockLeaseReapResult(dryRun)];
    return {
      enabled: true,
      scanned: leases.length,
      reaped: plan.reap.length,
      reapedIds: plan.reap.map((l) => l.id),
      ownersReconciled: dryRun ? new Set(plan.reap.map((l) => l.takenBy)).size : ownersReconciled,
      keptLive: plan.keptLive.length,
      keptFresh: plan.keptFresh.length,
      resourceLocks,
      fileLocks,
      dryRun,
    };
  } catch (e) {
    console.warn('[work-item-lease-reap] sweep failed (non-fatal):', (e as Error)?.message ?? e);
    return { ...empty, enabled: true };
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Slice 2 (read-only half): LIVE-but-IDLE detection — the actual D-007
// event-loop-saturation cohort (~52 sessions holding LISTEN conns + polling).
// This half only IDENTIFIES + COUNTS them; safely TERMINATING a live session
// (via the managed-pty control socket / pid) is the flag-gated follow-on.
// ───────────────────────────────────────────────────────────────────────────

/** Default "idle" threshold. A session is idle when it has done no GENUINE
 *  activity for this long — `coord_presence.last_active_at` (mig 277) is bumped
 *  ONLY by real activity, NOT by the per-60s supervisor heartbeat — while its
 *  process is still alive (fresh `heartbeat_at`).
 *
 *  45 min (was 4h; memory-reduction-2026-09-24 P-007, owner directive #440).
 *  Only headless / non-responsive sessions reach this test — `classifyLiveIdle`
 *  never selects an owner-directed pane — so no human-between-tasks is at risk.
 *  An idle headless CLI costs ~150 MB+ resident, its prompt cache has already
 *  expired well before 45 min, and ending it loses nothing: the wake-executor
 *  `--resume`s it on its next wake and session-dir-gc keeps its dir for that.
 *  At 4h the tower held 100+ such idle CLIs (~26 GB RSS + 15 GB swap, measured
 *  2026-09-24). */
export const IDLE_ACTIVITY_THRESHOLD_MS = 45 * 60 * 1000;

export interface LiveIdleCandidate {
  coordOwnerId: string;
  /** Process-aliveness clock (the supervisor beat). */
  heartbeatAtMs: number;
  /** Genuine-activity clock (mig 277); null = never recorded activity. */
  lastActiveAtMs: number | null;
  /** The session's coord_presence agentRole (mig 407 / deriveAgentRole) — the
   *  signal classifyAgentPane uses to resolve driveMode. Lets the live-idle filter
   *  EXCLUDE owner-directed (responsive) sessions from termination (P-001 / D-001).
   *  Optional (defaults null → id-only classification) so existing callers/tests
   *  that don't supply it still compile; a roleless su-… id still reads responsive. */
  role?: string | null;
  /** The durable launch argv from adv_sessions. Only an exact '--headless'
   *  token is meaningful; absent, malformed, and legacy values stay protected. */
  launchArgv?: unknown;
}

/**
 * A narrowly scoped launch discriminator for the live-idle reaper. The
 * recorded argv is JSON and has legacy/console shapes, so only a raw token
 * equal to '--headless' is authoritative. Embedded shell text, '--headless='
 * variants, and unknown values must not weaken the responsive-session guard.
 */
function hasExplicitHeadlessLaunch(argv: unknown): boolean {
  return Array.isArray(argv) && argv.some((arg) => arg === '--headless');
}

/**
 * PURE: a session is LIVE-but-IDLE when its process is alive (heartbeat within
 * `livenessMs`) AND it has done no genuine activity for `idleMs` AND it is NOT
 * busy (holds no claim / has no registered wake / is not a running bee) AND it is
 * NOT an OWNER-DIRECTED (responsive) session. NOTE the asymmetry vs the dead-ghost
 * reaper: presence-alive is the PRECONDITION here, so the "busy" set must EXCLUDE
 * presence (else every alive session looks protected and nothing is ever idle). A
 * null lastActiveAt = never active → idle. Injected clock so the boundary
 * unit-tests deterministically.
 *
 * P-001 / D-001 (queen-fleet-authority-boundary): su / sentinel / planner are
 * OWNER-DIRECTED (driveMode responsive) — the owner drives them; they hold no
 * reclaimable "slot". This live-idle sweep Ctrl-C's then SIGKILLs its targets
 * (terminateIdleLiveSessions), so an idle-but-alive owner session (e.g. a human
 * who stepped away, a parked planner) must NEVER enter the population — killing an
 * owner's own session out from under them is the exact authority violation this
 * plan fixes. This SUPERSEDES the original D-007 framing ("terminate idle SU
 * sessions to free the event loop"): loop-saturation from a live owner session is
 * addressed by reducing its footprint, not by system-killing it. The dead-ghost /
 * zombie / dangling-await slices (1/3/4) still reap already-dead responsive
 * sessions — only the LIVE-termination population is narrowed here.
 */
export function classifyLiveIdle(opts: {
  candidates: LiveIdleCandidate[];
  busyOwners: Set<string>;
  nowMs: number;
  livenessMs?: number;
  idleMs?: number;
}): LiveIdleCandidate[] {
  const livenessMs = opts.livenessMs ?? IDLE_SESSION_GRACE_MS;
  const idleMs = opts.idleMs ?? IDLE_ACTIVITY_THRESHOLD_MS;
  return opts.candidates.filter((c) => {
    if (opts.nowMs - c.heartbeatAtMs >= livenessMs) return false; // dead process → dead-ghost reaper's job
    if (opts.busyOwners.has(c.coordOwnerId)) return false; // holds a claim / wake / running bee
    const pane = classifyAgentPane({ role: c.role ?? null, ownerId: c.coordOwnerId });
    // Owner-directed (responsive) sessions are never live-idle-terminated
    // (P-001), except for an explicitly headless SU launch. Restrict the
    // exception to kind 'su': operator/planner panes remain owner-directed,
    // and unknown/legacy argv remains protected by default.
    const explicitlyHeadlessSu = pane.kind === 'su' && hasExplicitHeadlessLaunch(c.launchArgv);
    if (pane.driveMode === 'responsive' && !explicitlyHeadlessSu) return false;
    return opts.nowMs - (c.lastActiveAtMs ?? 0) >= idleMs; // no genuine activity for idleMs
  });
}

/**
 * Owners that are BUSY (must never be counted live-idle / terminated): work-item
 * claim holders + running nursery aliases + IN-FLIGHT wake deliveries (a session
 * mid-resume).
 *
 * CRITICAL — does NOT exclude STANDING `event_awaits`: every idle SU session is
 * parked on an always-armed inbox-wake (a standing await), so excluding those
 * made the detector silently always-0 and HID the entire D-007 cohort (verified
 * live: 24 alive-idle sessions → 0). A wake-armed idle session IS the cohort —
 * terminating it is safe BECAUSE the wake-executor `--resume`s it on its next
 * wake (and session-dir-gc keeps its dir for exactly that). Only a wake mid-
 * DELIVERY (event_wake_deliveries) must be spared. Also EXCLUDES coord_presence
 * (a fresh heartbeat is the live-idle precondition, not a protection). One read.
 */
export async function gatherBusyOwners(
  sql: Awaited<ReturnType<typeof getOrgPg>>['sql'],
  opts: { graceMs?: number } = {},
): Promise<Set<string>> {
  const graceSec = Math.max(1, Math.round((opts.graceMs ?? IDLE_SESSION_GRACE_MS) / 1000));
  // EI-19357343... (WI-6638 side-finding): harness_features_consolidated excludes
  // issue-family (bug/change/task) rows by construction (its view definition is
  // `WHERE item_kind <> ALL ('{bug,change,task}')`) — those claims live in
  // engineer_issues (`assignee`). Without this leg a session holding a WI-/EI-
  // claim was never "busy" here and could be live-idle-terminated mid-work.
  const issueWs = issuesScopeWorkspace();
  const rows = await sql<Array<{ alias: string }>>`
    WITH busy AS (
      SELECT taken_by AS alias
        FROM harness_shared.harness_features_consolidated
       WHERE taken_by IS NOT NULL
      UNION
      SELECT assignee AS alias
        FROM harness_shared.engineer_issues
       WHERE workspace_id = ${issueWs} AND assignee IS NOT NULL AND assignee <> ''
      UNION
      -- in-flight wake delivery only (mid-resume) — NOT standing event_awaits.
      SELECT subscriber_id AS alias
        FROM harness_shared.event_wake_deliveries
       WHERE status IN ('pending', 'parked', 'delivering')
      UNION
      SELECT a.alias
        FROM harness_shared.spawned_agents n
        CROSS JOIN LATERAL (VALUES (n.spawn_id), (n.session_owner), (n.run_id)) AS a(alias)
       WHERE n.status IN ('running', 'restarting')
         AND n.heartbeat_at IS NOT NULL
         AND (now() - n.heartbeat_at) < make_interval(secs => ${graceSec})
    )
    SELECT DISTINCT alias FROM busy WHERE alias IS NOT NULL AND alias <> ''`;
  return new Set(rows.map((r) => r.alias));
}

export interface IdleLiveSession {
  advSessionId: number;
  coordOwnerId: string;
  idleMs: number;
}

/**
 * READ-ONLY: the live-but-idle sessions right now — the D-007 saturation cohort.
 * Joins fresh-heartbeat presence rows (process alive) to their OPEN adv_sessions,
 * keeps those with stale `last_active_at` and a non-busy owner. Surfaced as a
 * metric + the future termination target list; this slice TERMINATES nothing.
 */
export async function findIdleLiveSessions(
  opts: { livenessMs?: number; idleMs?: number } = {},
): Promise<IdleLiveSession[]> {
  try {
    const { sql } = getOrgPg();
    // A session on the desktop is NEVER live-idle-terminated, however long it has
    // been idle — fold its owner into the busy set (the live-idle classifier
    // excludes busy owners). Best-effort → empty, so a failure can only spare
    // fewer, never terminate an on-desktop session it would otherwise spare.
    const [busyOwners, onDesktop, viewerOwners] = await Promise.all([
      gatherBusyOwners(sql, { graceMs: opts.livenessMs }),
      gatherOnDesktopSessions().catch(() => null),
      gatherViewerAttachedOwners().catch(() => new Set<string>()),
    ]);
    if (onDesktop) for (const o of onDesktop.owners) busyOwners.add(o);
    // A PTY-panel-viewed session (pty-viewer-heartbeat.ts) is never live-idle-
    // terminated either — its owner joins the busy set (no OS window, so the
    // on-desktop check above can't see it). Best-effort → empty: a failure only
    // spares fewer, never terminates a viewed session it would otherwise spare.
    for (const o of viewerOwners) busyOwners.add(o);
    const rows = await sql<
      Array<{
        id: number;
        coord_owner_id: string;
        heartbeat_at: string | Date;
        last_active_at: string | Date | null;
        agent_role: string | null;
        launch_argv: unknown;
      }>
    >`
      SELECT s.id, p.owner_id AS coord_owner_id, p.heartbeat_at, p.last_active_at, p.agent_role, s.launch_argv
        FROM harness_shared.coord_presence p
        JOIN harness_shared.adv_sessions s ON s.coord_owner_id = p.owner_id AND s.ended_at IS NULL
       WHERE p.heartbeat_at IS NOT NULL`;
    // WI-1967 — Windows conservative-on-stale (mirrors runIdleSessionReap). When
    // the on-desktop window signal is UNAVAILABLE (Windows host + no fresh
    // renderer push), we cannot tell which live sessions have an open wt.exe
    // terminal, so NONE may be live-idle-terminated this sweep — fold every
    // candidate owner into the busy set. Windows-only + additive: Linux/macOS
    // (windowSignalUnknown always false) is unchanged, and this only ever spares
    // more, never terminates more.
    if (onDesktop?.windowSignalUnknown === true) {
      for (const r of rows) if (r.coord_owner_id) busyOwners.add(r.coord_owner_id);
    }
    const nowMs = Date.now();
    const candidates: Array<LiveIdleCandidate & { advSessionId: number }> = rows.map((r) => ({
      advSessionId: r.id,
      coordOwnerId: r.coord_owner_id,
      heartbeatAtMs: new Date(r.heartbeat_at).getTime(),
      lastActiveAtMs: r.last_active_at ? new Date(r.last_active_at).getTime() : null,
      // agentRole feeds the P-001 responsive-session exclusion in classifyLiveIdle.
      role: r.agent_role,
      launchArgv: r.launch_argv,
    }));
    const idle = classifyLiveIdle({ candidates, busyOwners, nowMs, livenessMs: opts.livenessMs, idleMs: opts.idleMs });
    const idleKeys = new Set(idle.map((c) => c.coordOwnerId));
    return candidates
      .filter((c) => idleKeys.has(c.coordOwnerId))
      .map((c) => ({
        advSessionId: c.advSessionId,
        coordOwnerId: c.coordOwnerId,
        idleMs: nowMs - (c.lastActiveAtMs ?? 0),
      }));
  } catch (e) {
    console.warn('[idle-session-reaper] findIdleLiveSessions failed (non-fatal):', (e as Error)?.message ?? e);
    return [];
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Slice 2 (WRITE half): live-but-idle session TERMINATION — the actual D-007
// event-loop-saturation fix. DOUBLE-GATED + busy-excluding + best-effort.
// ───────────────────────────────────────────────────────────────────────────

/** How long to wait after the graceful Ctrl-C before escalating to SIGKILL. A
 *  Ctrl-C ends the current turn; a healthy psu host then idles (we still kill it
 *  — the goal is to free its operator/LISTEN/MCP footprint, not just end a turn),
 *  but the brief pause lets a co-operating host exit cleanly first so the SIGKILL
 *  is the exception, not the rule. */
export const TERMINATE_GRACE_MS = 3000;

export interface IdleLiveTerminateResult {
  /** False when EITHER flag is off (a no-op). */
  enabled: boolean;
  /** Genuinely-idle live sessions the sweep tried to terminate. */
  targeted: number;
  /** Sessions marked ended (or that WOULD be, when dryRun). */
  terminated: number;
  terminatedIds: number[];
  /** Sessions whose termination threw / failed (counted, never fatal). */
  failed: number;
  /**
   * P-012 / D-019: spared because the CGROUP window signal still sees their
   * window (or could not rule it out). Counted rather than silently skipped —
   * a protection nobody can observe is how the last one rotted into a no-op for
   * weeks without anyone noticing (WI-1586).
   */
  sparedByWindow: number;
  dryRun: boolean;
}

/** Injectable side-effects so the sweep unit-tests without real PG / pty / pids
 *  (mirrors turn/interrupt.ts deps + the slice-1 pure-function seam). Production
 *  defaults wire the live psu-pty + adv_sessions helpers. */
export interface TerminateDeps {
  /** Flag read; defaults to the real getFlag. */
  isFlagOn: (flag: (typeof FLAGS)[keyof typeof FLAGS]) => Promise<boolean>;
  /** The live-but-idle target list; defaults to findIdleLiveSessions. */
  listIdle: (opts: { livenessMs?: number; idleMs?: number }) => Promise<IdleLiveSession[]>;
  /** Graceful Ctrl-C into the owner's live psu-pty host; true on a clean write. */
  gracefulInterrupt: (ownerId: string) => Promise<boolean>;
  /** Resolve the owner's live host pid (for the SIGKILL escalation), or null. */
  resolvePid: (ownerId: string) => number | null;
  /** True iff the pid is still alive. */
  pidAlive: (pid: number) => boolean;
  /** Hard-kill the pid; true on success. */
  sigkill: (pid: number) => boolean;
  /** Mark the adv_session row ended in PG. */
  markEnded: (advSessionId: number) => Promise<void>;
  /** Pause between the Ctrl-C and the liveness re-check. */
  wait: (ms: number) => Promise<void>;
  /**
   * P-012 / D-019 — the cgroup-derived "spare this one" leg.
   *
   * The on-desktop exemption above comes from `desktop-window-liveness`, which
   * enumerates X windows via wmctrl. When that is unavailable — headless host, no
   * DISPLAY, a rotted launch handle, Windows — it yields an EMPTY set, and an
   * empty PROTECTION set protects nobody, so that signal fails toward KILLING. It
   * has done so twice (WI-1586: the exemption became a silent no-op and this sweep
   * SIGKILLed a session the owner had open on screen; WI-1641: the same lapse on
   * Windows).
   *
   * This leg answers the same question from the cgroup tree, needs no X server,
   * and so holds exactly where wmctrl is empty. It is strictly ADDITIVE: it can
   * only ever prevent a kill that happens today, never cause one, and it stays
   * silent (`false`) for a session that is not in a terminal window scope at all.
   */
  windowProtects: (ownerId: string) => boolean;
}

function defaultPidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM = alive but not ours to signal; ESRCH = gone.
    return (e as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

const defaultTerminateDeps: TerminateDeps = {
  isFlagOn: (flag) => getFlag(flag, 'system').catch(() => false),
  listIdle: (opts) => findIdleLiveSessions(opts),
  gracefulInterrupt: (ownerId) => interruptViaPty(ownerId, 'sigint').catch(() => false),
  resolvePid: (ownerId) => findLiveHost(ownerId)?.pid ?? null,
  pidAlive: defaultPidAlive,
  sigkill: (pid) => {
    try {
      process.kill(pid, 'SIGKILL');
      return true;
    } catch {
      return false;
    }
  },
  markEnded: async (advSessionId) => { await markAdvSessionEnded(advSessionId, null, 'reaper'); },
  wait: (ms) => new Promise((r) => setTimeout(r, ms)),
  windowProtects: (ownerId) => {
    try {
      const pid = findLiveHost(ownerId)?.pid;
      if (pid == null) return false; // nothing to judge — leave the existing rules alone
      return cgroupWindowProtects(isPidInLiveWindowScope(pid, nodeCgroupFs));
    } catch {
      // A probe failure must not decide a kill either way; the other protections stand.
      return false;
    }
  },
};

/**
 * The WRITE half: terminate every genuinely LIVE-but-IDLE session (the D-007
 * cohort that actually saturates the :3070 event loop). For each target:
 *   1. send a graceful Ctrl-C over its managed-pty control socket (ends its turn),
 *   2. wait TERMINATE_GRACE_MS, and if its host pid is STILL alive, SIGKILL it,
 *   3. mark its adv_session row ended in PG (frees session-dir-gc + the roster).
 *
 * DOUBLE-GATED DEFAULT-OFF: a pure no-op unless BOTH IDLE_SESSION_REAPER (the
 * slice-1 master switch) AND IDLE_SESSION_REAPER_TERMINATE (this destructive
 * write half) are on. The target list (findIdleLiveSessions) ALREADY excludes
 * busy owners via gatherBusyOwners (claim holders / in-flight wakes / running
 * bees) and dead-process sessions — so this never touches a session holding a
 * claim, mid-resume, or a fresh-but-quiet human. dryRun = plan + log, no kills /
 * no PG writes. Best-effort: a per-session failure is counted (`failed`) and the
 * sweep continues; the whole sweep never throws (it must not wedge the routine).
 */
export async function terminateIdleLiveSessions(
  opts: { dryRun?: boolean; livenessMs?: number; idleMs?: number; deps?: Partial<TerminateDeps> } = {},
): Promise<IdleLiveTerminateResult> {
  const dryRun = !!opts.dryRun;
  const deps: TerminateDeps = { ...defaultTerminateDeps, ...opts.deps };
  const empty: IdleLiveTerminateResult = {
    enabled: false,
    targeted: 0,
    terminated: 0,
    terminatedIds: [],
    failed: 0,
    sparedByWindow: 0,
    dryRun,
  };

  // Double-gate: both the master switch AND the destructive-write flag.
  const [master, terminate] = await Promise.all([
    deps.isFlagOn(FLAGS.IDLE_SESSION_REAPER).catch(() => false),
    deps.isFlagOn(FLAGS.IDLE_SESSION_REAPER_TERMINATE).catch(() => false),
  ]);
  if (!master || !terminate) return empty;

  let targets: IdleLiveSession[] = [];
  try {
    // findIdleLiveSessions already excludes busy owners + dead processes.
    targets = await deps.listIdle({ livenessMs: opts.livenessMs, idleMs: opts.idleMs });
  } catch (e) {
    console.warn('[idle-session-reaper] terminate: target gather failed (non-fatal):', (e as Error)?.message ?? e);
    return { ...empty, enabled: true };
  }

  const result: IdleLiveTerminateResult = { ...empty, enabled: true, targeted: targets.length };

  for (const t of targets) {
    try {
      // 0. P-012/D-019: spare a session whose window the CGROUP signal still sees
      //    (or cannot rule out). Checked BEFORE the graceful Ctrl-C, not merely
      //    before the SIGKILL — interrupting the turn of a session the owner is
      //    watching is itself the harm, so a protection that only guarded the kill
      //    would arrive too late.
      if (deps.windowProtects(t.coordOwnerId)) {
        result.sparedByWindow += 1;
        continue;
      }
      if (dryRun) {
        // Plan only — no Ctrl-C, no kill, no PG write.
        result.terminated += 1;
        result.terminatedIds.push(t.advSessionId);
        continue;
      }
      // 1. graceful Ctrl-C over the managed-pty control socket (ends the turn).
      await deps.gracefulInterrupt(t.coordOwnerId);
      // 2. give it a moment to exit, then SIGKILL the host pid if still alive.
      await deps.wait(TERMINATE_GRACE_MS);
      const pid = deps.resolvePid(t.coordOwnerId);
      if (pid != null && deps.pidAlive(pid)) deps.sigkill(pid);
      // 3. mark the row ended (re-checks ended_at IS NULL inside markAdvSessionEnded).
      await deps.markEnded(t.advSessionId);
      result.terminated += 1;
      result.terminatedIds.push(t.advSessionId);
    } catch (e) {
      // Per-session isolation: count + continue, never break the sweep.
      result.failed += 1;
      console.warn(
        `[idle-session-reaper] terminate failed for session ${t.advSessionId} (owner ${t.coordOwnerId}), non-fatal:`,
        (e as Error)?.message ?? e,
      );
    }
  }

  return result;
}

// ───────────────────────────────────────────────────────────────────────────
// Slice 3: ZOMBIE-PROC reap — an agent OS process whose adv_session is ENDED
// (exit recorded) but the process never exited (EI-1873 / EI-20982995405794565).
//
// The dominant fleet session-leak: 32 such zombies (sessions ended 16–18h prior,
// exit_code=0) accumulated PAST the bg-host wedge point, each holding LISTEN conns
// + polling on the :3070 event loop. No DB-roster reaper saw them — they are
// CLOSED in the DB (ended_at set) yet ALIVE as OS procs, so slices 1/2 (which scan
// OPEN sessions) reap 0 (verified live: a non-starved reaper run still reaped 0).
// The signal here is DETERMINISTIC + zero-heuristic: ended session + live proc =
// zombie. It is STARVATION-INDEPENDENT — it does NOT rely on the per-60s
// supervisor heartbeat that the very overload starves (the feedback loop that
// defeated the presence-based slices). DOUBLE-GATED like slice 2 (a process kill);
// best-effort; Linux /proc enumeration (a no-op where /proc is absent).
// ───────────────────────────────────────────────────────────────────────────

/**
 * A live agent process with a deterministic join back to adv_sessions.
 *
 * Claude keeps the historical native-session join (`--resume <uuid>`). Codex
 * does not expose its native session id on every launch, so psu's exact
 * `PAPERCUSP_ADV_SESSION_ID` is read from only the top-level
 * `~/.papercusp/bin/codex` wrapper. The native Codex child inherits the same
 * environment, but deliberately does not match the wrapper path; one session
 * therefore yields exactly one reap candidate.
 */
export type ResumeProc =
  | { pid: number; sessionId: string; advSessionId?: never }
  | { pid: number; sessionId?: never; advSessionId: number };

/** PURE: the resume-procs whose session is ENDED → the zombies to kill, MINUS
 *  any session currently on the desktop (a live OS window — never kill a proc the
 *  user is looking at, even if its adv row reads ended). Both sets are injected so
 *  the keep/kill boundary unit-tests without OS/PG. `onDesktopSessionIds` defaults
 *  empty, so existing 2-arg callers/tests are unchanged. This is belt-and-braces
 *  atop the foreground-TTY spare in discoverResumeProcs (a console terminal's
 *  claude proc is already foreground), covering minimized/backgrounded edge cases. */
export function planZombieReap(
  procs: ResumeProc[],
  endedSessionIds: ReadonlySet<string>,
  onDesktopSessionIds: ReadonlySet<string> = new Set(),
  endedAdvSessionIds: ReadonlySet<number> = new Set(),
  onDesktopAdvSessionIds: ReadonlySet<number> = new Set(),
): ResumeProc[] {
  return procs.filter((p) =>
    p.advSessionId != null
      ? endedAdvSessionIds.has(p.advSessionId) && !onDesktopAdvSessionIds.has(p.advSessionId)
      : endedSessionIds.has(p.sessionId) && !onDesktopSessionIds.has(p.sessionId),
  );
}

const RESUME_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CODEX_WRAPPER_RE = /(?:^|[\\/])\.papercusp[\\/]bin[\\/]codex$/;
const ADV_SESSION_ENV = 'PAPERCUSP_ADV_SESSION_ID=';

/**
 * PURE process classifier used by the /proc scanner and its recurrence tests.
 * Returns no identity for a native Codex child, an untracked plain Codex, or a
 * psu fork (forks intentionally carry no PAPERCUSP_ADV_SESSION_ID).
 */
export function parseReapableSessionProc(
  rawCmdline: string,
  rawEnviron = '',
): Omit<ResumeProc, 'pid'> | null {
  const args = rawCmdline.split('\0').filter(Boolean);

  if (rawCmdline.includes('claude')) {
    const i = args.indexOf('--resume');
    if (i >= 0 && args[i + 1] && RESUME_UUID_RE.test(args[i + 1])) {
      return { sessionId: args[i + 1] };
    }
  }

  // Match only the stable Papercusp top-level wrapper. The vendor-native Codex
  // child inherits the same env marker, so accepting any `*/bin/codex` would
  // discover and signal the same session twice.
  if (!args.some((arg) => CODEX_WRAPPER_RE.test(arg))) return null;
  const rawId = rawEnviron
    .split('\0')
    .find((entry) => entry.startsWith(ADV_SESSION_ENV))
    ?.slice(ADV_SESSION_ENV.length);
  if (!rawId || !/^[1-9]\d*$/.test(rawId)) return null;
  const advSessionId = Number(rawId);
  if (!Number.isSafeInteger(advSessionId)) return null;
  return { advSessionId };
}

/**
 * Discover live agent session procs via /proc (Linux). Claude is identified by
 * `--resume <uuid>`; Codex by PAPERCUSP_ADV_SESSION_ID on the stable top-level
 * `~/.papercusp/bin/codex` wrapper. Best-effort: a non-Linux host (no /proc) or
 * a per-pid read error skips that pid. Reads are bounded-parallel rather than a
 * serial /proc walk (performance.mdx A1/A19).
 */
export async function discoverResumeProcs(): Promise<ResumeProc[]> {
  const out: ResumeProc[] = [];
  let entries: string[];
  try {
    entries = await readdir('/proc');
  } catch {
    return out; // not Linux / no /proc → no-op
  }
  const pids = entries.filter((ent) => /^\d+$/.test(ent)).map(Number);
  const batchSize = 64;
  for (let offset = 0; offset < pids.length; offset += batchSize) {
    const batch = await Promise.all(
      pids.slice(offset, offset + batchSize).map(async (pid): Promise<ResumeProc | null> => {
        let rawCmdline = '';
        try {
          rawCmdline = await readFile(`/proc/${pid}/cmdline`, 'utf8');
        } catch {
          return null; // proc vanished / unreadable
        }
        if (!rawCmdline) return null;

        // Environ is needed only for the tiny Codex-wrapper cohort. Avoid a
        // second /proc read for every unrelated process on the host.
        const args = rawCmdline.split('\0').filter(Boolean);
        let rawEnviron = '';
        if (args.some((arg) => CODEX_WRAPPER_RE.test(arg))) {
          try {
            rawEnviron = await readFile(`/proc/${pid}/environ`, 'utf8');
          } catch {
            return null; // fail closed: no exact identity, no signal
          }
        }
        const identity = parseReapableSessionProc(rawCmdline, rawEnviron);
        if (!identity) return null;

        // Claude may be a human-owned foreground terminal. Papercusp's managed
        // Codex wrapper, however, is ALWAYS the foreground process of its PTY,
        // including ended/leaked sessions; its exact adv-session identity and
        // the two on-desktop spares below are the applicable safety boundary.
        if (shouldSpareForegroundSessionProc(identity, await isForegroundTty(pid))) return null;
        return { pid, ...identity } as ResumeProc;
      }),
    );
    out.push(...batch.filter((proc): proc is ResumeProc => proc != null));
  }
  return out;
}

export interface ZombieReapResult {
  /** False when EITHER flag is off (a no-op). */
  enabled: boolean;
  /** Live `claude --resume` procs discovered. */
  scannedProcs: number;
  /** Procs whose session is ended (zombies). */
  zombies: number;
  /** Pids signalled (or that WOULD be, when dryRun). */
  killedPids: number[];
  dryRun: boolean;
}

/** Injectable side-effects so the sweep unit-tests without OS/PG (mirrors the
 *  slice-2 TerminateDeps seam). */
export interface ZombieReapDeps {
  isFlagOn: (flag: (typeof FLAGS)[keyof typeof FLAGS]) => Promise<boolean>;
  listResumeProcs: () => Promise<ResumeProc[]>;
  /** The subset of `sessionIds` whose adv_session is ENDED (ended_at NOT NULL). */
  endedSessionIds: (sessionIds: string[]) => Promise<Set<string>>;
  /** The subset of exact adv-session row ids whose row is ENDED. */
  endedAdvSessionIds: (advSessionIds: number[]) => Promise<Set<number>>;
  /** Both exact identity sets CURRENTLY on the desktop — never reaped. */
  onDesktopIdentities: () => Promise<{ sessionIds: Set<string>; advSessionIds: Set<number> }>;
  sigterm: (pid: number) => boolean;
  pidAlive: (pid: number) => boolean;
  sigkill: (pid: number) => boolean;
  /** PID-recycle guard: true iff pid still carries the same exact identity. */
  stillTheProc: (pid: number, proc: ResumeProc) => Promise<boolean>;
  /** True iff the pid sits under an open desktop window (proc ancestry, WI-1586)
   *  — the launch-capture-free on-desktop spare. Never kill a proc inside a
   *  window the user can see, whatever its adv rows say. */
  pidOnDesktop: (pid: number) => Promise<boolean>;
  /** Pause between SIGTERM and the SIGKILL re-check. */
  wait: (ms: number) => Promise<void>;
}

async function defaultEndedSessionIds(sessionIds: string[]): Promise<Set<string>> {
  if (sessionIds.length === 0) return new Set();
  const { sql } = getOrgPg();
  // A uuid is a zombie ONLY when EVERY adv_session row for it is ended — i.e. it
  // has NO open row. CRITICAL (the collateral that killed the operator's live
  // session): a LIVE resumed session REUSES its session_id, so an OLD ended row can
  // coexist with the CURRENT OPEN row for the same uuid. The earlier `AND ended_at
  // IS NOT NULL` matched the old ended row and killed the live session in a
  // kill→--resume→kill loop. `HAVING` no open row makes the live (open) row veto.
  const rows = await sql<Array<{ session_id: string }>>`
    SELECT session_id
      FROM harness_shared.adv_sessions
     WHERE session_id = ANY(${sessionIds})
     GROUP BY session_id
    HAVING COUNT(*) FILTER (WHERE ended_at IS NULL) = 0`;
  return new Set(rows.map((r) => r.session_id));
}

async function defaultEndedAdvSessionIds(advSessionIds: number[]): Promise<Set<number>> {
  if (advSessionIds.length === 0) return new Set();
  const { sql } = getOrgPg();
  // Unlike the native Claude session id, PAPERCUSP_ADV_SESSION_ID names one
  // exact row. A resumed row is reopened (ended_at cleared), so an ended exact
  // id cannot alias a concurrently open session.
  const rows = await sql<Array<{ id: number | string }>>`
    SELECT id
      FROM harness_shared.adv_sessions
     WHERE id = ANY(${advSessionIds})
       AND ended_at IS NOT NULL`;
  return new Set(
    rows
      .map((row) => Number(row.id))
      .filter((id) => Number.isSafeInteger(id) && id > 0),
  );
}

/**
 * True iff `pid` is a FOREGROUND, TTY-attached process (ps `+`) — a live
 * interactive session (e.g. a human at a terminal), NEVER a backgrounded leaked
 * agent proc. Defense-in-depth atop the all-ended query: even a stale-stamped row
 * can't make us kill a live foreground session. Reads `/proc/<pid>/stat`: comm
 * (field 2) is parenthesised + may contain spaces, so we slice after the LAST ')';
 * the remaining 0-indexed fields are 0=state 1=ppid 2=pgrp 3=session 4=tty_nr
 * 5=tpgid. Foreground ⇔ a controlling tty (tty_nr≠0) AND this pgrp owns it
 * (pgrp===tpgid). Best-effort: a read/parse failure → false (never over-spare).
 */
/** PURE: parse a /proc/<pid>/stat line → is the process FOREGROUND + TTY-attached?
 *  Exported so the field-offset + comm-with-parens parsing (the error-prone bit
 *  that the EI-1873 collateral turned on) is unit-covered without /proc. */
export function parseForegroundFromStat(stat: string): boolean {
  const after = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
  const pgrp = Number(after[2]);
  const ttyNr = Number(after[4]);
  const tpgid = Number(after[5]);
  return Number.isFinite(ttyNr) && ttyNr !== 0 && Number.isFinite(pgrp) && Number.isFinite(tpgid) && pgrp === tpgid;
}

/**
 * PURE: whether a foreground-TTY process must be excluded from zombie-process
 * discovery. Claude's native `--resume` process may be a human-owned terminal,
 * so it keeps the historical spare. Papercusp's top-level Codex wrapper is
 * always the foreground process of its managed PTY — including leaked wrappers
 * whose exact adv-session row is ended — so applying the same spare to Codex
 * makes the entire exact-ID cleanup lane inert. Codex retains the stronger
 * exact-row plus on-desktop identity/ancestry spares in reapZombieResumeProcs.
 */
export function shouldSpareForegroundSessionProc(
  identity: Omit<ResumeProc, 'pid'>,
  foreground: boolean,
): boolean {
  return foreground && identity.advSessionId == null;
}

async function isForegroundTty(pid: number): Promise<boolean> {
  try {
    return parseForegroundFromStat(await readFile(`/proc/${pid}/stat`, 'utf8'));
  } catch {
    return false; // gone/unreadable → never over-spare
  }
}

async function defaultStillTheProc(pid: number, proc: ResumeProc): Promise<boolean> {
  try {
    const rawCmdline = await readFile(`/proc/${pid}/cmdline`, 'utf8');
    if (proc.advSessionId == null) {
      const current = parseReapableSessionProc(rawCmdline);
      return current?.sessionId === proc.sessionId;
    }
    const rawEnviron = await readFile(`/proc/${pid}/environ`, 'utf8');
    const current = parseReapableSessionProc(rawCmdline, rawEnviron);
    return current?.advSessionId === proc.advSessionId;
  } catch {
    return false; // gone → never signal a recycled pid
  }
}

const defaultZombieDeps: ZombieReapDeps = {
  isFlagOn: (flag) => getFlag(flag, 'system').catch(() => false),
  listResumeProcs: () => discoverResumeProcs(),
  endedSessionIds: (ids) => defaultEndedSessionIds(ids),
  endedAdvSessionIds: (ids) => defaultEndedAdvSessionIds(ids),
  onDesktopIdentities: () =>
    gatherOnDesktopSessions()
      .then((sets) => ({ sessionIds: sets.sessionIds, advSessionIds: sets.advSessionIds }))
      .catch(() => ({ sessionIds: new Set<string>(), advSessionIds: new Set<number>() })),
  sigterm: (pid) => {
    try { process.kill(pid, 'SIGTERM'); return true; } catch { return false; }
  },
  pidAlive: defaultPidAlive,
  sigkill: (pid) => {
    try { process.kill(pid, 'SIGKILL'); return true; } catch { return false; }
  },
  stillTheProc: (pid, proc) => defaultStillTheProc(pid, proc),
  pidOnDesktop: (pid) => isPidUnderOpenWindow(pid).catch(() => false),
  wait: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/**
 * Slice 3: reap ZOMBIE agent procs — sessions already ENDED whose OS process
 * never exited (EI-1873 / EI-20982995405794565). Discovers the live session
 * procs, asks PG which exact identities are ended, and SIGTERM→(wait)→SIGKILLs
 * the zombies. Re-verifies each pid's identity immediately before EACH signal.
 * adv_session is already ended, so no PG write is needed. DOUBLE-GATED DEFAULT-OFF
 * (both IDLE_SESSION_REAPER + IDLE_SESSION_REAPER_TERMINATE); dryRun plans only;
 * best-effort — a per-proc failure is isolated and the sweep never throws.
 */
export async function reapZombieResumeProcs(
  opts: { dryRun?: boolean; deps?: Partial<ZombieReapDeps> } = {},
): Promise<ZombieReapResult> {
  const dryRun = !!opts.dryRun;
  const deps: ZombieReapDeps = { ...defaultZombieDeps, ...opts.deps };
  const empty: ZombieReapResult = { enabled: false, scannedProcs: 0, zombies: 0, killedPids: [], dryRun };

  const [master, terminate] = await Promise.all([
    deps.isFlagOn(FLAGS.IDLE_SESSION_REAPER).catch(() => false),
    deps.isFlagOn(FLAGS.IDLE_SESSION_REAPER_TERMINATE).catch(() => false),
  ]);
  if (!master || !terminate) return empty;

  let procs: ResumeProc[] = [];
  try {
    procs = await deps.listResumeProcs();
  } catch {
    return { ...empty, enabled: true };
  }
  const sessionIds = [...new Set(procs.flatMap((proc) => (proc.sessionId ? [proc.sessionId] : [])))];
  const advSessionIds = [...new Set(procs.flatMap((proc) => (proc.advSessionId != null ? [proc.advSessionId] : [])))];
  let ended: Set<string>;
  let endedAdv: Set<number>;
  try {
    [ended, endedAdv] = await Promise.all([
      deps.endedSessionIds(sessionIds),
      deps.endedAdvSessionIds(advSessionIds),
    ]);
  } catch {
    return { ...empty, enabled: true, scannedProcs: procs.length };
  }
  // On-desktop sessions (a live OS window) are spared even if their adv row reads
  // ended — best-effort → empty, so a failure only loses this extra spare (the
  // foreground-TTY guard in discoverResumeProcs still covers real terminals).
  const onDesktop = await deps.onDesktopIdentities().catch(() => ({
    sessionIds: new Set<string>(),
    advSessionIds: new Set<number>(),
  }));
  const zombies = planZombieReap(
    procs,
    ended,
    onDesktop.sessionIds,
    endedAdv,
    onDesktop.advSessionIds,
  );
  const result: ZombieReapResult = {
    enabled: true,
    scannedProcs: procs.length,
    zombies: zombies.length,
    killedPids: [],
    dryRun,
  };

  for (const z of zombies) {
    try {
      // On-desktop spare, ancestry-keyed (WI-1586): the sessionId-keyed spare in
      // planZombieReap depends on launch-recorded window handles that can rot —
      // this live /proc-ancestry check spares a proc inside an open terminal
      // window even when its adv row carries no handle. Applies to dryRun too
      // (a plan must never list a kill the real run would refuse).
      if (await deps.pidOnDesktop(z.pid).catch(() => false)) continue;
      if (dryRun) {
        result.killedPids.push(z.pid);
        continue;
      }
      if (!(await deps.stillTheProc(z.pid, z))) continue; // recycle guard (pre-SIGTERM)
      deps.sigterm(z.pid);
      await deps.wait(TERMINATE_GRACE_MS);
      // SIGKILL survivors — re-verify the cmdline again so a pid recycled during
      // the grace pause into an unrelated process is never signalled.
      if (deps.pidAlive(z.pid) && (await deps.stillTheProc(z.pid, z))) deps.sigkill(z.pid);
      result.killedPids.push(z.pid);
    } catch {
      // per-proc isolation — never break the sweep.
    }
  }
  return result;
}

// ───────────────────────────────────────────────────────────────────────────
// Slice 4: RECLAIM-LANE — GC the dangling `coord:inbox-wake:<owner>` awaits of
// DEAD sessions (fleet-dispatch-wake-clarity-2026-06-22 P-004).
//
// THE BUG (verified live 2026-06-24, su-92ab4): every idle psu/Queen-launched
// agent arms a standing `coord:inbox-wake:<self>` await (turn-lifecycle-control
// always-arm). On a CLEAN session end `cancelInboxWake` cancels it — but a
// process that DIES (crash / kill / bg-host wedge) never runs that hygiene, so
// the await ROW persists forever. coord:presence/fetchWakeability reads exactly
// these rows to derive `wakeable`/`parked`, so a dead session shows as a LIVE
// dispatch target (woken:0 when a coordinator dispatches to it) — the
// "misleading zombie pile" P-004 names. Worse, `gatherProtectedSessionOwners`
// (slice 1's keep/reap gate) counts a standing await as alive, so these dangling
// rows also PROTECT their ghost adv_sessions from ever being reaped (the
// "reclaim not firing" report). Measured: 334 inbox-wake awaits, only 19 on a
// fresh-heartbeat owner and 98 on a still-OPEN (resumable) session → 236 pure
// garbage on dead owners.
//
// THE FIX is the SessionEnd-hygiene the dead process never ran, applied as a
// sweep: cancel an inbox-wake await whose owner is NOT genuinely live OR
// resumable. "Live or resumable" = a fresh presence heartbeat, a RUNNING bee, an
// IN-FLIGHT wake delivery (mid-resume), OR an OPEN adv_session (a parked session
// the wake-executor can `--resume` — its await is its lifeline, NEVER cancelled).
// So a parked-but-resumable session keeps its await; only a session that is over
// (no open adv_session) AND not live loses its dangling await → it flips from a
// false `parked` to an honest `ended`, and the adv_session reaper stops being
// protection-polluted by it. Non-destructive (cancels a DB await row, touches no
// process), so it rides the slice-1 master flag alone (not the destructive gate).
// ───────────────────────────────────────────────────────────────────────────

/** PURE: the await-owners to cancel — those NOT in the live-or-resumable set.
 *  Injected sets so the keep/cancel boundary unit-tests without PG. */
export function planDeadAwaitReclaim(opts: {
  awaitOwners: string[];
  liveOrResumable: ReadonlySet<string>;
}): string[] {
  return [...new Set(opts.awaitOwners)].filter((o) => o && !opts.liveOrResumable.has(o));
}

/**
 * The set of owners that are genuinely LIVE *or* RESUMABLE — so their standing
 * inbox-wake await must be PRESERVED. Deliberately distinct from
 * `gatherProtectedSessionOwners`: it DROPS the standing-await leg (counting the
 * very rows we are GC'ing as "alive" would make the sweep a no-op).
 *   - fresh coord_presence heartbeat (process alive), OR
 *   - a RUNNING/RESTARTING bee on any alias (spawn_id/session_owner/run_id), OR
 *   - an IN-FLIGHT wake delivery (the owner is mid-resume right now), OR
 *   - an OPEN adv_session (ended_at IS NULL) *whose owner has a LIVE psu-host* —
 *     WI-2858: an open adv_session ALONE is no longer proof of resumability (that
 *     was the slice-4 half of the deadlock — a SIGKILLed session keeps
 *     `ended_at IS NULL` forever). The wake-executor can only relaunch/inject a
 *     parked session when a live host exists, so gate the leg on `liveHostOwners`.
 * One read for the unconditional legs, one for the open-adv-session owners.
 */
export async function gatherLiveOrResumableOwners(
  sql: Awaited<ReturnType<typeof getOrgPg>>['sql'],
  opts: { graceMs?: number; liveHostOwners?: ReadonlySet<string> } = {},
): Promise<Set<string>> {
  const graceSec = Math.max(1, Math.round((opts.graceMs ?? IDLE_SESSION_GRACE_MS) / 1000));
  const [liveRows, openRows] = await Promise.all([
    sql<Array<{ alias: string }>>`
      WITH live AS (
        SELECT owner_id AS alias
          FROM harness_shared.coord_presence
         WHERE heartbeat_at IS NOT NULL
           AND (now() - heartbeat_at) < make_interval(secs => ${graceSec})
        UNION
        SELECT a.alias
          FROM harness_shared.spawned_agents n
          CROSS JOIN LATERAL (VALUES (n.spawn_id), (n.session_owner), (n.run_id)) AS a(alias)
         WHERE n.status IN ('running', 'restarting')
           AND n.heartbeat_at IS NOT NULL
           AND (now() - n.heartbeat_at) < make_interval(secs => ${graceSec})
        UNION
        -- Mid-resume: a wake is being delivered to this owner right now.
        SELECT subscriber_id AS alias
          FROM harness_shared.event_wake_deliveries
         WHERE status IN ('pending', 'parked', 'delivering')
      )
      SELECT DISTINCT alias FROM live WHERE alias IS NOT NULL AND alias <> ''`,
    sql<Array<{ alias: string }>>`
      SELECT DISTINCT coord_owner_id AS alias
        FROM harness_shared.adv_sessions
       WHERE ended_at IS NULL AND coord_owner_id IS NOT NULL AND coord_owner_id <> ''`,
  ]);
  const liveOrResumable = new Set(liveRows.map((r) => r.alias));
  // WI-2858: an OPEN adv_session is resumable ONLY when a live psu-host can relaunch
  // it — otherwise it is a SIGKILLed ghost whose dangling await must be reclaimed.
  for (const o of resumableOpenSessionOwners(openRows.map((r) => r.alias), opts.liveHostOwners ?? new Set()))
    liveOrResumable.add(o);
  return liveOrResumable;
}

export interface AwaitReclaimResult {
  /** False when the master flag is off (a no-op). */
  enabled: boolean;
  /** Distinct owners holding a standing inbox-wake await. */
  scanned: number;
  /** Owners judged dead (not live/resumable) → their awaits cancelled. */
  deadOwners: number;
  /** Await ROWS cancelled (≥ deadOwners; an owner may hold >1). 0 on dryRun. */
  cancelled: number;
  /** A bounded sample of the cancelled owners (for the routine log). */
  sampleOwners: string[];
  dryRun: boolean;
}

/**
 * Slice 4 sweep: cancel the dangling inbox-wake awaits of dead sessions (P-004).
 * Gathers the live-or-resumable set + the standing-await owners, plans the dead
 * subset (PURE), then bulk-cancels their awaits in ONE statement (the cancel
 * re-checks the await predicate, so a row re-armed between read and write is left
 * alone). FLAG-GATED on IDLE_SESSION_REAPER (the reaper master, shared with the
 * other slices) — non-destructive (no process touched), so no second gate.
 * Best-effort: a PG failure returns a zero result rather than throwing.
 */
export async function reclaimDanglingInboxWakeAwaits(
  opts: { dryRun?: boolean; graceMs?: number } = {},
): Promise<AwaitReclaimResult> {
  const dryRun = !!opts.dryRun;
  const empty: AwaitReclaimResult = {
    enabled: false,
    scanned: 0,
    deadOwners: 0,
    cancelled: 0,
    sampleOwners: [],
    dryRun,
  };
  const enabled = await getFlag(FLAGS.IDLE_SESSION_REAPER, 'system').catch(() => false);
  if (!enabled) return empty;

  try {
    const { sql } = getOrgPg();
    const wakePrefix = `${COORD_INBOX_WAKE_PREFIX}%`;
    // WI-2858: gate the "open adv_session ⇒ resumable" leg on a LIVE psu-host, so a
    // SIGKILLed session (open adv_session but no host + stale heartbeat) is no longer
    // counted resumable and its dangling inbox-wake await is reclaimed.
    const liveHostOwners = await safeLiveHostOwners();
    const [awaitRows, liveOrResumable] = await Promise.all([
      sql<Array<{ subscriber_id: string }>>`
        SELECT DISTINCT subscriber_id
          FROM harness_shared.event_awaits
         WHERE event_key LIKE ${wakePrefix}
           AND policy = 'wake' AND once = false
           AND fired_at IS NULL AND cancelled_at IS NULL
           AND (expires_ts IS NULL OR expires_ts > now())
           AND subscriber_id IS NOT NULL AND subscriber_id <> ''`,
      gatherLiveOrResumableOwners(sql, { graceMs: opts.graceMs, liveHostOwners }),
    ]);
    const awaitOwners = awaitRows.map((r) => r.subscriber_id);
    const dead = planDeadAwaitReclaim({ awaitOwners, liveOrResumable });

    let cancelled = 0;
    if (!dryRun && dead.length > 0) {
      // Bulk-cancel every dead owner's standing inbox-wake await in ONE statement.
      // The WHERE re-checks the await predicate (uncancelled/unfired standing wake
      // row), so an await re-armed between the read and here is never clobbered.
      const rows = await sql<Array<{ id: number }>>`
        UPDATE harness_shared.event_awaits
           SET cancelled_at = now(), cancel_reason = ${AWAIT_CANCEL_REASONS.danglingInboxWakeReclaimed}
         WHERE subscriber_id = ANY(${dead}::text[])
           AND event_key LIKE ${wakePrefix}
           AND policy = 'wake' AND once = false
           AND fired_at IS NULL AND cancelled_at IS NULL
        RETURNING id`;
      cancelled = rows.length;
    }
    return {
      enabled: true,
      scanned: awaitOwners.length,
      deadOwners: dead.length,
      cancelled,
      sampleOwners: dead.slice(0, 20),
      dryRun,
    };
  } catch (e) {
    console.warn('[idle-session-reaper] await-reclaim sweep failed (non-fatal):', (e as Error)?.message ?? e);
    return { ...empty, enabled: true };
  }
}
