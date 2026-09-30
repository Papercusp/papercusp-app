/**
 * own-log-fork-ei — durable EI escalation for own-log-fork episodes.
 *
 * Plan: p2p-parity-parallel-lanes-2026-07-09 P-003 (WI-3535). Sibling of
 * replication-stall-ei.ts, same dedup + best-effort shape, for the own-log
 * equivocation-loop detector (own-log-fork-guard.ts) instead of the
 * per-remote-log replication registry.
 *
 * Dedup: at most ONE OPEN EI per (harness, own-log key) — the guard's own
 * process-local latch already fires this at most once per process per key,
 * but a process restart re-arms it (and a boot loop, per the module doc on
 * own-log-fork-guard.ts, restarts REPEATEDLY against the SAME corrupted
 * key) — the open-EI title match here is what keeps that from re-filing a
 * fresh EI on every crash-loop iteration.
 *
 * EI-9030a: the file/resolve/dedup/VITEST-gate machinery is the shared
 * `createEpisodicEscalator` seam (escalation/episodic-ei.ts) — this module is
 * the own-log-fork binding: its topic, title, body, and resolve note.
 */

import type { OwnLogForkEpisode } from './own-log-fork-guard';
import {
  createEpisodicEscalator,
  type EpisodicEiDeps,
} from '../../escalation/episodic-ei';

export const OWN_LOG_FORK_TOPIC = 'own-log-fork';

/** Stable, dedup-able title for one (harness, own-log key). */
export function ownLogForkEiTitle(episode: {
  harnessSlug: string;
  keyHex: string;
}): string {
  return (
    `[own-log-fork-guard] own_log_forked: harness=${episode.harnessSlug} ` +
    `log=${episode.keyHex.slice(0, 12)}… (equivocation loop, WI-183-adjacent)`
  );
}

/** Resolver identity stamped on auto-resolved (recovered) own-log-fork EIs. */
export const RECOVERY_OWNER = 'system:own-log-fork-guard';

/** DI seam so the dedup+file logic unit-tests without PG. */
export type OwnLogForkEiDeps = EpisodicEiDeps<'critical'>;

/** The (harness, key) identity resolveOwnLogForkEi keys on, plus a note detail. */
type OwnLogForkRecovery = { harnessSlug: string; keyHex: string; detail: string };

/** The EI body for a to-file own-log-fork episode. */
function buildOwnLogForkBody(episode: OwnLogForkEpisode): string {
  return (
    `Own-log fork guard (P-003 / WI-3535): ${episode.detail}\n\n` +
    `workspace=${episode.workspaceId} harness=${episode.harnessSlug}\n` +
    `log_core_key=${episode.keyHex}\n\n` +
    `Meaning: this harness's OWN writable single-writer log ` +
    `(packages/operator-core/lib/sync/hyperbee/peer-log.ts openOwnLog) hit ` +
    `Hypercore's equivocation loop — "[hypercore] conflict detected" — because ` +
    `two conflicting signatures exist for the same log length. The most likely ` +
    `cause is the WI-1891 "two live keys at once" class (the own-log keypair did ` +
    `not persist across a restart / was duplicated onto a second live process, so ` +
    `two writers signed divergent history under the same key) or a corrupted/rolled-` +
    `back local corestore. Hypercore has already closed EVERY open session to this ` +
    `core (SESSION_CLOSED on the next append/get) — local writes made against it are ` +
    `frozen, and re-booting WITHOUT fixing the on-disk state re-opens the SAME ` +
    `corrupted core, which re-forks on the next reconnect (the observed boot loop; ` +
    `old key e06b8704 cost hours before this was ever noticed).\n\n` +
    `Supported recovery: a PER-HARNESS STORE RESET — stop the harness, delete or move ` +
    `aside its Corestore directory ` +
    `(<workspaceRoot>/.papercusp/${episode.harnessSlug}/hyperbee/), then re-boot. ` +
    `Corestore lazily creates a FRESH keypair (a new own-log key) on first access, so ` +
    `the harness re-publishes its LOCAL history (PG-mirrored data is unaffected) under a ` +
    `new identity that no peer has conflicting proof for. This is destructive to the ` +
    `local hypercore-only log — only do it once the harness's local writes are confirmed ` +
    `merged into PG (or acceptably lost).\n\n` +
    `IMPORTANT: \`rekeyHarness\` (boot-all.ts) does NOT fix this — it only re-binds the ` +
    `swarm TOPIC binding (e.g. for a hive-membership change) and never touches the ` +
    `own-log Corestore, so calling it against a forked own-log leaves the SAME corrupted ` +
    `core in place and the boot loop continues.\n\n` +
    `An auto-recovery sketch exists behind a flag-gated, default-OFF kill-switch ` +
    `(destructive — see own-log-fork-recovery.ts / FLAGS.OWN_LOG_FORK_AUTO_RECOVERY) — ` +
    `the owner must ratify it before it runs unattended.\n\n` +
    `This EI auto-dedupes per (harness, own-log key) while one stays open.`
  );
}

const escalator = createEpisodicEscalator<OwnLogForkEpisode, OwnLogForkRecovery, 'critical'>({
  topic: OWN_LOG_FORK_TOPIC,
  stableTitle: ownLogForkEiTitle,
  buildBody: buildOwnLogForkBody,
  resolveNote: (recovery) => `resolved: own-log store reset — ${recovery.detail}`,
  severity: 'critical',
  createdBy: 'system:own-log-fork-guard',
  foundDuring: 'own-log-fork-guard-detector',
  recoveryOwner: RECOVERY_OWNER,
});

/** Test seam. */
export function _resetOwnLogForkEiForTests(): void {
  escalator._resetForTests();
}

/**
 * File a durable EI for an own-log-fork episode, deduplicating against open
 * EIs with the same stable title. Returns the EI id when filed, null when
 * deduped or on failure (best-effort — the caller, own-log-fork-guard.ts's
 * reporter, never awaits this).
 */
export function fileOwnLogForkEi(
  episode: OwnLogForkEpisode,
  deps?: OwnLogForkEiDeps,
): Promise<string | null> {
  return escalator.file(episode, deps);
}

/**
 * Auto-resolve the durable EI a fork episode filed, once the supported
 * recovery (a per-harness store reset) has actually completed — call this
 * from whatever completes that recovery (manual runbook step, or the
 * flag-gated auto-recovery sketch), NOT from a passive read path (unlike
 * replication-liveness, a fork never self-heals by observation alone).
 * Resolves EVERY open EI matching the stable (harness, key) title (mirrors
 * resolveReplicationStallEi's EI-6772 multi-match fix for the federated
 * issue ledger). Returns the ids actually resolved; best-effort.
 */
export function resolveOwnLogForkEi(
  recovery: OwnLogForkRecovery,
  deps?: OwnLogForkEiDeps,
): Promise<string[]> {
  return escalator.resolve(recovery, deps);
}
