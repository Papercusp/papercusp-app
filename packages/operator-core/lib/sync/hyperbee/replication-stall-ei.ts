/**
 * replication-stall-ei — durable EI escalation for replication-stall episodes.
 *
 * Plan: shared-hive-p2p-release-readiness-2026-07-03 P-004 (WI-1840). The
 * registry verdict (replication-liveness.ts) and the boot-history event are
 * both PROCESS-LOCAL — they evaporate on restart and are visible only to
 * whoever polls a status surface. P-004's acceptance requires the stall to
 * ESCALATE: this module files a durable `engineer_issues` row (an EI) so a
 * connected-but-dead peer shows up in the fleet's triage queue even when
 * nobody is watching.
 *
 * Dedup: at most ONE OPEN EI per (harness, log, kind) — episodes are already
 * edge-triggered once per stall episode, but a process restart re-arms the
 * detector, and a permanent stall (the P-059/WI-183 shape) would otherwise
 * re-file on every reboot. Open-EI title match + a per-process in-flight
 * guard keep it single.
 *
 * Runs in whichever process runs the merge loop. Both the default (main
 * process) and the `papercusp-substrate-sidecar` mode have PG access (the
 * sidecar owns the merge loop's PG projections when the flag is ON).
 * Best-effort everywhere: escalation must never wedge the merge pass.
 *
 * EI-9030a: the file/resolve/dedup/VITEST-gate machinery is the shared
 * `createEpisodicEscalator` seam (escalation/episodic-ei.ts) — this module is
 * the replication-liveness binding: its topic, title, body, and resolve note.
 */

import type { ReplicationStallEpisode } from './replication-liveness';
import {
  createEpisodicEscalator,
  type EpisodicEiDeps,
} from '../../escalation/episodic-ei';

export const REPLICATION_LIVENESS_TOPIC = 'replication-liveness';

/**
 * The EI surface also escalates the outbox-drain detectors — same durable-EI +
 * dedup mechanism, same triage topic; the "logKeyHex" slot carries a log key as
 * the stable dedup identifier:
 *   - 'drain_stalled' (WI-2009) — a single drain pass HUNG past the watchdog
 *     timeout; logKeyHex = the harness's LIVE own-log key;
 *   - 'drain_backlog_stalled' (WI-2009) — passes SETTLE but drain zero rows for the
 *     whole no-progress window while mapped undrained rows wait (the original filed
 *     silent-permanence signature the hung-pass watchdog does not cover); logKeyHex
 *     = the harness's LIVE own-log key;
 *   - 'drain_backlog_aged' (WI-5147) — the backlog IS making forward progress (unlike
 *     'drain_backlog_stalled' above) but is pathologically old/large regardless —
 *     the oldest undrained row's age or the undrained count crossed its threshold.
 *     Progress-independent by design: catches a backlog that crawls forward forever
 *     without ever tripping the zero-progress detector (the WI-5147 filed signature:
 *     a 3-week-old backlog went completely undetected this way); logKeyHex = the
 *     harness's LIVE own-log key;
 *   - 'drain_orphan_tail' (WI-2136) — fed-scope rows were drained into a PRIOR-era
 *     own-log key that no longer matches the live log (the own-log keypair did not
 *     persist across a restart — WI-2105 class), so that era's unreplicated tail is
 *     stranded; logKeyHex = the DEAD prior-era key (so distinct dead eras page
 *     separately).
 *   - 'drain_row_quarantined' (WI-3896) — ONE outbox row's per-stage (epoch-encrypt
 *     / append) timeout recurred `ROW_QUARANTINE_THRESHOLD` times consecutively, so
 *     that row is now permanently SKIPPED (left undrained on purpose) so it can no
 *     longer wedge every later row behind it; logKeyHex = the harness's LIVE
 *     own-log key (the row itself is named in `detail`).
 */
export type StallEiEpisode = Omit<ReplicationStallEpisode, 'kind'> & {
  kind:
    | ReplicationStallEpisode['kind']
    | 'drain_stalled'
    | 'drain_backlog_stalled'
    | 'drain_backlog_aged'
    | 'drain_orphan_tail'
    | 'drain_row_quarantined';
};

/**
 * WI-37499: the literal prefix EVERY title `replicationStallEiTitle` mints starts
 * with — this detector's population identity, independent of the `coord_links`
 * topic tag that a read may or may not find. `replicationStallEiTitle` BUILDS from
 * this constant (rather than repeating the literal), and replication-stall-ei's
 * unit suite asserts every episode kind's title starts with it — so a future edit
 * to the title shape cannot silently orphan the sweeps that select on it.
 */
export const REPLICATION_STALL_EI_TITLE_PREFIX = '[replication-liveness] ';

/** Stable, dedup-able title for one (harness, log, kind). */
export function replicationStallEiTitle(episode: {
  harnessSlug: string;
  logKeyHex: string;
  // Track StallEiEpisode's union instead of restating it: a new episode kind
  // added upstream must not un-assign this fn from the escalator's stableTitle.
  kind: StallEiEpisode['kind'];
}): string {
  return (
    `${REPLICATION_STALL_EI_TITLE_PREFIX}${episode.kind}: harness=${episode.harnessSlug} ` +
    `log=${episode.logKeyHex.slice(0, 12)}… (WI-183 class)`
  );
}

/** Resolver identity stamped on auto-resolved (recovered) replication-stall EIs. */
export const RECOVERY_OWNER = 'system:replication-liveness';

/**
 * WI-5762: standing-condition delta-gate cooldown (see escalation/episodic-ei.ts's
 * `standingCooldownMs`). A chronic (harness, log, kind) stall commonly flaps —
 * a transient reconnect/repair satisfies `onRecovery` and auto-resolves the open
 * EI, then the SAME condition re-stalls minutes later (WI-183 class, sharpened
 * by a restart-heavy soak) — and open-only dedup re-files a fresh duplicate
 * every time, because the check only ever sees "no OPEN match." Measured: 57
 * duplicate EIs for one standing stall over a 7d window. 24h mirrors
 * dark-flag-age-detect's DEFAULT_DARK_FLAG_AGE_RESOLUTION_COOLDOWN_MS — long
 * enough to absorb a flap-storm inside one soak/restart cycle, short enough
 * that a condition still standing a day later still re-pages (this is a
 * cooldown on RE-FILING, never a suppression of the underlying detector or the
 * boot-history/console legs, and a genuinely NEW distinct (harness, log, kind)
 * key is a different title and unaffected).
 */
export const REPLICATION_STALL_EI_STANDING_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/** DI seam so the dedup+file logic unit-tests without PG. */
export type ReplicationStallEiDeps = EpisodicEiDeps<'major'>;

/** The (harness, log, kind) identity resolveReplicationStallEi needs to find
 *  the EI a recovered episode should close — the same fields replicationStallEiTitle
 *  keys on, plus a human-readable `detail` for the resolution note. */
export type RecoveredStallEpisode = Pick<StallEiEpisode, 'harnessSlug' | 'logKeyHex' | 'kind' | 'detail'>;

/** The EI body for a to-file replication-stall episode. */
function buildReplicationStallBody(episode: StallEiEpisode): string {
  return (
    `Replication-liveness detector (P-004 / WI-1840, WI-183 class): ${episode.detail}\n\n` +
    `workspace=${episode.workspaceId} harness=${episode.harnessSlug}\n` +
    `log_core_key=${episode.logKeyHex}\n` +
    `kind=${episode.kind} stalledForMs=${episode.stalledForMs}\n\n` +
    `Meaning: ${
      episode.kind === 'drain_stalled'
        ? 'the OUTBOX DRAIN pass for this harness exceeded its watchdog timeout — a hung await ' +
          '(keychain unwrap / epoch-key resolution / append) wedged the serialized drain loop, so ' +
          'NO local writes were federating (WI-2009 permanence class). The watchdog un-wedged the ' +
          'loop (a fresh pass re-attempts; duplicate appends are safe per the at-least-once contract), ' +
          'but the underlying hang needs a root-cause look (WI-2018 keychain identity is the known suspect).'
        : episode.kind === 'drain_backlog_stalled'
        ? 'the OUTBOX DRAIN for this harness has run its passes but drained ZERO rows for the whole ' +
          'no-progress window while mapped undrained rows remain queued — passes complete (no hang) yet ' +
          'make no forward progress, so local writes are silently NOT federating (WI-2009 filed ' +
          'signature: fail-fast every pass, e.g. a persistent EpochKeyUnavailableError because the ' +
          'epoch key never arrived [WI-2003 divergence], or a persistent append fault). The 5s poll ' +
          'keeps re-attempting; this EI turns the otherwise silent console-spam into a durable page. ' +
          'Root-cause: check whether this device holds the current epoch key (hive_epoch_keys) and ' +
          'whether appends are landing on the own log.'
        : episode.kind === 'drain_backlog_aged'
        ? 'the OUTBOX DRAIN for this harness IS making forward progress (this is NOT the ' +
          '\'drain_backlog_stalled\' zero-progress case) but the backlog is old/large enough to be ' +
          'pathological regardless — the oldest undrained row\'s age or the undrained row count crossed ' +
          'its threshold (WI-5147 class: a backlog that always crawls forward, however slowly, never trips ' +
          'the zero-progress detector, and can silently starve new content for days to weeks with nobody ' +
          'paged — this is the guard against exactly that). Root-cause: check current drain throughput ' +
          '(is it degraded relative to normal — DB/CPU contention, an intermittent pass-timeout pattern) ' +
          'and whether the backlog composition includes a mass-mutation sweep that should be coalesced ' +
          'before hitting the outbox rather than one row per historical mutation.'
        : episode.kind === 'drain_row_quarantined'
        ? 'the OUTBOX DRAIN for this harness hit ONE row whose per-stage (epoch-encrypt / append) ' +
          'timeout recurred repeatedly for the SAME row id — that row always sorts first ' +
          '(`ORDER BY id`), so it was wedging every later row behind it, not just itself ' +
          '(WI-3896 class: the pass-level watchdog un-wedges the LOOP but not the BACKLOG when the ' +
          'same poison row keeps leading every pass). It has now been QUARANTINED (permanently ' +
          'skipped, left undrained ON PURPOSE — never falsely marked drained_at) so later rows drain ' +
          'normally again. See `detail` above for the exact row id + table. Triage: check whether the ' +
          'hang was LOAD-induced (host CPU pressure — may resolve if re-tried once load clears) or a ' +
          'genuinely stale/dead-device row (e.g. keymat for a device that will never decrypt/apply) — ' +
          'recovery is runbook-only: root-cause the specific row, then clear the quarantine to re-drain it.'
        : episode.kind === 'drain_orphan_tail'
        ? 'the OUTBOX DRAIN drained fed-scope rows into a PRIOR-era own-log key (log_core_key above) ' +
          'that no longer matches the live process’s log — the own-log keypair did NOT persist across ' +
          'a restart (WI-2105 / WI-2136 class: e06b8704 era → 4072cfad era), so that dead era’s ' +
          'unreplicated tail is STRANDED: its blocks can never replicate because no live process holds ' +
          'the dead log’s keypair. Recovery is runbook-only per the GO/NO-GO (d)-clause — re-emit ' +
          'the stranded rows by setting drained_at=NULL for the dead-key rows so the next drain ' +
          're-appends them onto the LIVE log (at-least-once tolerates the duplicate). Root fix ' +
          '(WI-2136 Q1): persist the own-log keypair across restarts so the class disappears; this ' +
          'guard then stays silent and pins it against regression. NB: two live keys at once instead ' +
          'of a restart succession is the WI-1891 cross-process host race (P-059) — also worth paging.'
        : `the swarm-level connection may look healthy (peer_connected), but this ` +
          `admitted remote log is ${
            episode.kind === 'no_replicator'
              ? 'no longer carried by any live replicator session — its writer’s ops are NOT arriving'
              : 'attached to a replicator but ingesting nothing — the writer is ahead and no ops have merged for the whole grace window'
          }. Writes made on that peer are silently diverging until replication recovers.`
    }\n\n` +
    `Triage: check \`getReplicationLiveness()\` (federation status / dogfood-substrate-status) ` +
    `for the current verdict; see agent-insights/shared-hive-federation-diagnosis-toolkit for the rig probes. ` +
    `This EI auto-dedupes per (harness, log, kind) while one stays open.`
  );
}

const escalator = createEpisodicEscalator<StallEiEpisode, RecoveredStallEpisode, 'major'>({
  topic: REPLICATION_LIVENESS_TOPIC,
  stableTitle: replicationStallEiTitle,
  buildBody: buildReplicationStallBody,
  resolveNote: (recovery) => `auto-resolved: replication recovered — ${recovery.detail}`,
  severity: 'major',
  createdBy: 'system:replication-liveness',
  foundDuring: 'replication-liveness-detector',
  recoveryOwner: RECOVERY_OWNER,
  standingCooldownMs: REPLICATION_STALL_EI_STANDING_COOLDOWN_MS,
  // WI-37499: this detector's rows are frequently minted WITHOUT the
  // `replication-liveness` topic edge (measured 2026-08-09: 60 of 105 open rows),
  // which silently blinded dedup, the duplicate-collapse pass and the orphan
  // sweep at once. Selecting on the stable title too makes every population read
  // independent of that derived tag.
  titlePrefix: REPLICATION_STALL_EI_TITLE_PREFIX,
});

/** Test seam. */
export function _resetReplicationStallEiForTests(): void {
  escalator._resetForTests();
}

/**
 * File a durable EI for a stall episode, deduplicating against open EIs with
 * the same stable title. Returns the EI id when filed, null when deduped or on
 * failure (best-effort — the caller never awaits this on the merge path).
 */
export function fileReplicationStallEi(
  episode: StallEiEpisode,
  deps?: ReplicationStallEiDeps,
): Promise<string | null> {
  return escalator.file(episode, deps);
}

/**
 * EI-7110: auto-resolve the durable EI a stall episode filed, once
 * `sampleReplicationLiveness` observes the SAME (harness, log, kind) recover.
 * Without this, a filed EI never auto-clears — it sits open until a human/agent
 * manually re-verifies current live status and closes it (exactly the toil that
 * surfaced EI-7110 itself: a fleet member 20h downstream of the stall, unable to
 * cheaply confirm whether it had already self-healed).
 *
 * Resolves EVERY open EI matching the stable (harness, log, kind) title — not
 * just the first (EI-6772 class). Duplicate open EIs for the SAME condition arise
 * legitimately across the FEDERATED, multi-machine issue ledger: two machines can
 * each file an `origin:remote` EI for one stall before the other's row replicates
 * in, and neither the per-process `inFlight` guard nor a racing `listOpenByTopic`
 * dedup can see the other machine's not-yet-replicated row. A `.find` recovery
 * then closes ONLY one and strands every duplicate open forever — exactly what
 * left EI-6772 open while its sibling EI-7764 (same harness/log/kind, both
 * `origin:remote`) auto-resolved on the same recovery. Returns the ids actually
 * resolved.
 *
 * No-ops (returns `[]`) when no open EI matches the stable dedup title — that is
 * the NORMAL case (recovered before ever crossing the escalation's OWN grace, or
 * already resolved by an earlier recovery). Best-effort: a resolve failure never
 * throws back into the merge pass that calls it (the registry verdict already
 * reads 'live' regardless of whether the durable EI closes) — each EI is resolved
 * independently so one failure never strands its siblings.
 */
export function resolveReplicationStallEi(
  recovery: RecoveredStallEpisode,
  deps?: ReplicationStallEiDeps,
): Promise<string[]> {
  return escalator.resolve(recovery, deps);
}

/**
 * WI-5332: is a durable EI ALREADY open for this exact (harness, log, kind)?
 * boot.ts's repair-on-detect ladder (`repairAttempts`) is a per-process-
 * lifetime Map — under restart-cadence disruption (a real sidecar restart,
 * or the live-fed-gate rig's restart_durability/reconnect_catchup scenarios)
 * it resets before ever reaching REPAIR_MAX_ATTEMPTS_PER_LOG, so the heavier
 * forced-rejoin escalation becomes structurally unreachable exactly when the
 * condition is chronic. An open EI is the one signal that survives the reset:
 * if THIS process's first-ever episode for a log finds an EI already open, a
 * PRIOR process already stalled on the exact same (harness, log, kind) and no
 * recovery has been observed since — i.e. this is not a fresh stall, it is
 * the SAME zombie surviving a restart. The caller (boot.ts) uses a true
 * result to skip straight to the forced rejoin instead of re-running a fresh
 * session-repair budget that the next restart would just reset again.
 */
export function hasOpenReplicationStallEi(
  episode: Pick<StallEiEpisode, 'harnessSlug' | 'logKeyHex' | 'kind'>,
  deps?: ReplicationStallEiDeps,
): Promise<boolean> {
  return escalator.hasOpen({ ...episode, detail: '' }, deps);
}
