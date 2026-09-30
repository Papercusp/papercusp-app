/**
 * `system:idle-session-reaper` — the P-011 (D-007) idle-session reaper.
 *
 * Marks DEAD-process open `adv_sessions` rows ended (owner dropped out of the
 * liveness set past the grace window), reclaiming the live roster + unblocking
 * `session-dir-gc` (which protects every `ended_at IS NULL` row). Design +
 * safety model live in `idle-session-reaper.ts`.
 *
 * DOUBLE-GATED + safe: flag-gated DEFAULT-OFF (FLAGS.IDLE_SESSION_REAPER → a
 * no-op until armed) AND the routine is seeded INACTIVE. This slice only ever
 * touches sessions whose process is already dead — it never terminates a live
 * session (that's the follow-on slice; see the plan).
 *
 * trigger_config (optional): `dry_run` — plan + log, mark nothing.
 */
import { registerSystemAction, type SystemActionCtx } from './system-actions';
import { readCoordLivenessConfig } from '../../coord-liveness-config';
import { gatherOnDesktopSessions, listOpenWindows } from '../../desktop-window-liveness';
import { listLiveHosts } from '../../events/await/psu-pty-discovery';
import {
  runIdleSessionReap,
  runWorkItemLeaseReap,
  findIdleLiveSessions,
  terminateIdleLiveSessions,
  reapZombieResumeProcs,
  reclaimDanglingInboxWakeAwaits,
} from '../../idle-session-reaper';

registerSystemAction('idle-session-reaper', async (ctx: SystemActionCtx) => {
  const cfg = ctx.triggerConfig ?? {};
  const dryRun = cfg.dry_run === true;

  // On-desktop exemption HEALTH PROBE (WI-1586 recurrence guard) — runs before
  // any destructive slice. The 2026-06-29 hard-exemption silently no-op'd for a
  // month ("0 on-desktop/hard-exempt" every sweep — launch-handle capture had
  // rotted) until the reaper killed a session the owner had open on screen.
  // The broken shape is DETECTABLE: open desktop windows + live interactive psu
  // hosts but ZERO protected owners. Surface it loudly every sweep.
  try {
    const [onDesktop, windows] = await Promise.all([gatherOnDesktopSessions(), listOpenWindows()]);
    const hosts = listLiveHosts();
    console.log(
      `[idle-session-reaper] on-desktop exemption: ${onDesktop.owners.size} owner(s) protected ` +
        `(${windows.length} open window(s), ${hosts.length} live psu host(s))`,
    );
    if (windows.length > 0 && hosts.length > 0 && onDesktop.owners.size === 0) {
      console.warn(
        '[idle-session-reaper] ⚠ on-desktop exemption looks BROKEN: open windows AND live interactive ' +
          'hosts but ZERO protected owners — the WI-1586 regression shape (handle capture rot / ancestry ' +
          'walk failure). A desktop-open session may be killable this sweep; investigate desktop-window-liveness.',
      );
    }
  } catch {
    /* best-effort probe — never blocks the sweep */
  }

  // Slice 3 (EI-1873) FIRST — the dominant fleet leak: ZOMBIE `claude --resume`
  // procs whose adv_session is ENDED but the process never exited (32 of them
  // wedged the box on 2026-06-20). Deterministic (ended session + live proc) and
  // starvation-independent — unlike the presence-based slices below, it does not
  // depend on the supervisor heartbeat the overload starves. DOUBLE-GATED.
  const zomb = await reapZombieResumeProcs({ dryRun });
  if (zomb.enabled) {
    console.log(
      `[idle-session-reaper] zombie-proc reap: scanned ${zomb.scannedProcs} resume-proc(s) → ` +
        `${zomb.dryRun ? 'WOULD kill' : 'killed'} ${zomb.zombies} zombie(s)` +
        (zomb.killedPids.length
          ? ` [pids: ${zomb.killedPids.slice(0, 20).join(',')}${zomb.killedPids.length > 20 ? ',…' : ''}]`
          : ''),
    );
  }

  // Read-only D-007 saturation metric — the LIVE-but-idle cohort (the sessions
  // that actually hold the event loop). Slice 2 terminates these (double-gated);
  // surfacing the count + the target list keeps the cohort visible even when the
  // terminate flag is off.
  const idleLive = await findIdleLiveSessions();
  console.log(
    `[idle-session-reaper] live-but-idle sessions: ${idleLive.length}` +
      (idleLive.length
        ? ` (oldest idle ~${Math.round(Math.max(...idleLive.map((s) => s.idleMs)) / 3_600_000)}h) — ` +
          `slice-2 termination target [ids: ${idleLive.slice(0, 20).map((s) => s.advSessionId).join(',')}${idleLive.length > 20 ? ',…' : ''}]`
        : ''),
  );

  // Live-but-idle TERMINATION (slice 2 / WI-152) — DOUBLE-GATED DEFAULT-OFF
  // (a no-op unless BOTH IDLE_SESSION_REAPER and IDLE_SESSION_REAPER_TERMINATE
  // are on). Ctrl-C → SIGKILL → mark ended; busy owners already excluded.
  const term = await terminateIdleLiveSessions({ dryRun });
  if (term.enabled) {
    console.log(
      `[idle-session-reaper] live-idle terminate: targeted ${term.targeted} → ` +
        `${term.dryRun ? 'WOULD terminate' : 'terminated'} ${term.terminated}, failed ${term.failed}` +
        (term.terminatedIds.length
          ? ` [ids: ${term.terminatedIds.slice(0, 20).join(',')}${term.terminatedIds.length > 20 ? ',…' : ''}]`
          : ''),
    );
  } else {
    console.log(
      '[idle-session-reaper] terminate flags off (need papercusp-idle-session-reaper + papercusp-idle-session-reaper-terminate) — live-idle termination skipped',
    );
  }

  // Dead-process ghost reap (slice 1) — flag-gated DEFAULT-OFF.
  // live-configurability-audit P-014: apply the session-reaper grace override (undefined ⇒ default).
  const livenessCfg = await readCoordLivenessConfig();
  const r = await runIdleSessionReap({ dryRun, graceMs: livenessCfg.sessionReaperGraceMs });
  if (!r.enabled) {
    console.log('[idle-session-reaper] reap flag off (papercusp-idle-session-reaper) — ghost reap skipped');
    return;
  }
  console.log(
    `[idle-session-reaper] scanned ${r.scanned} open session(s) → ` +
      `${r.dryRun ? 'WOULD end' : 'ended'} ${r.reaped} dead-process ghost(s), ` +
      `kept ${r.keptLive} live (${r.keptOnDesktop} on-desktop/hard-exempt` +
      (r.keptWindowSignalUnknown > 0
        ? `, ${r.keptWindowSignalUnknown} spared: Windows on-desktop signal stale (GUI reporter down)`
        : '') +
      `)` +
      (r.reapedIds.length
        ? ` [ids: ${r.reapedIds.slice(0, 20).join(',')}${r.reapedIds.length > 20 ? ',…' : ''}]`
        : ''),
  );

  // Slice 1b (session-death-claim-release-2026-07-11 P-001) — force-release
  // any work-item lease (taken_by/assignee) whose owner is DEAD, independent
  // of whether that owner's adv_session was itself reapable above (a claim
  // holder is self-protected in slice 1's liveness set — see the module
  // comment on gatherProtectedSessionOwners — so this judges the lease
  // holder's liveness directly rather than piggybacking off slice 1's plan).
  // The same call opts into the named-resource side-database backstop so a
  // dead session that held only a resource lock is not left fenced until TTL.
  const lr = await runWorkItemLeaseReap({
    dryRun,
    graceMs: livenessCfg.sessionReaperGraceMs,
    includeResourceLocks: true,
  });
  if (lr.enabled) {
    console.log(
      `[idle-session-reaper] work-item lease reap: scanned ${lr.scanned} held lease(s) → ` +
        `${lr.dryRun ? 'WOULD release' : 'released'} ${lr.reaped} dead-owner lease(s) ` +
        `(${lr.ownersReconciled} owner(s) claim-ledger-reconciled), kept ${lr.keptLive} live, ${lr.keptFresh} fresh` +
        (lr.reapedIds.length
          ? ` [ids: ${lr.reapedIds.slice(0, 20).join(',')}${lr.reapedIds.length > 20 ? ',…' : ''}]`
          : '') +
        `; named-resource lease backstop: scanned ${lr.resourceLocks.scanned} → ` +
        `${lr.resourceLocks.dryRun ? 'WOULD release' : 'released'} ${lr.resourceLocks.reaped} dead-owner lock(s), ` +
        `kept ${lr.resourceLocks.keptLive} live, ${lr.resourceLocks.keptFresh} fresh` +
        (lr.resourceLocks.failedOwners
          ? `, ${lr.resourceLocks.failedOwners} owner cleanup(s) failed`
          : ''),
    );
  }

  // Slice 4 — RECLAIM-LANE (fleet-dispatch-wake-clarity P-004): GC the dangling
  // inbox-wake awaits of DEAD sessions so a coordinator's coord:presence /
  // fetchWakeability stops showing them as `wakeable`/`parked` dispatch targets
  // (the "misleading zombie pile") and the ghost-reap above stops being
  // protection-polluted by them. Non-destructive (cancels a DB await row, touches
  // no process) → rides the single IDLE_SESSION_REAPER master flag.
  const aw = await reclaimDanglingInboxWakeAwaits({ dryRun });
  if (aw.enabled) {
    console.log(
      `[idle-session-reaper] await-reclaim: scanned ${aw.scanned} inbox-wake await owner(s) → ` +
        `${aw.deadOwners} dead → ${aw.dryRun ? 'WOULD cancel' : 'cancelled'} ${aw.cancelled} await(s)` +
        (aw.sampleOwners.length
          ? ` [owners: ${aw.sampleOwners.slice(0, 10).join(',')}${aw.deadOwners > 10 ? ',…' : ''}]`
          : ''),
    );
  }
});
