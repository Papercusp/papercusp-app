/**
 * boot-history — in-process record of substrate boot events.
 *
 * Plan: papercusp-dogfood-phase5a-hyperbee-plumbing-2026-05-24.
 *
 * Tracks each `bootHarnessSubstrate` start / finish / close so flaky-
 * boot debugging has a per-harness timeline. Distinct from `boot-all`
 * (which holds the live handle map): this is the *history* of boot
 * events, including ones that fell out of the map.
 *
 * Pure logic — TWO module-level append-only rings, each with its own
 * configurable cap: the default ring (200 entries, env
 * PAPERCUSP_BOOT_HISTORY_CAP) for every low-frequency lifecycle kind, and a
 * separate high-frequency ring (40 entries, env
 * PAPERCUSP_BOOT_HISTORY_EPOCH_CAP) for the per-op epoch-decrypt-gate trace
 * kinds (WI-3827) — so hot epoch chatter can never evict the sparse
 * boot/peer/announce/replication forensic evidence `listBootHistory` merges
 * both rings back into one ts-ordered view. Process-local; clears when the
 * operator restarts. Test seams for time + reset.
 *
 * Event kinds:
 *   - 'boot_start'        — bootHarnessSubstrate called; corestore opening.
 *   - 'boot_ok'           — bootHarnessSubstrate returned successfully.
 *   - 'boot_fail'         — bootHarnessSubstrate threw.
 *   - 'close'             — handle.close() called.
 *   - 'peer_connected'    — a Hyperswarm peer connected to a swarmed harness.
 *   - 'swarm_join_failed' — swarm join threw; harness stays local-only.
 *   - 'peer_rejected'     — a banned peer's connection was dropped (DoS guard;
 *                           most banned keys are firewall-rejected pre-handshake
 *                           and never recorded here — this is in-flight/IP-ban).
 *   - 'peer_rate_limited' — a peer tripped the per-peer connection-rate limit and
 *                           was banned + dropped (DoS guard).
 *   - 'peer_capped'       — an admitted peer's log exceeded the per-author op
 *                           cap; the merge ingested only the first N ops this
 *                           pass (DoS Phase-4 reshape — a noisy peer bloats only
 *                           its own tail, not the whole merge).
 *   - 'peer_revoked'      — an admitted peer was revoked (D-004): its log was
 *                           dropped from the admitted set + its pubkey blocklisted.
 *   - 'peer_unrevoked'    — WI-193 (G8): a REFRESH-SOURCED revocation (the pubkey
 *                           was never named in a live handle.revoke() call) is no
 *                           longer present in the published revoked-pubkeys list —
 *                           applyRevocationRefresh reconciled it out of `revoked`,
 *                           so the peer is admissible again on its next announce.
 *   - 'replication_stalled' — WI-183: an admitted REMOTE log has held zero live
 *                           replicator peers (`core.peers.length`) for the stall
 *                           grace window, having shown at least one before. This
 *                           is the previously-SILENT failure mode from WI-183's
 *                           repro: the swarm reports `peer_connected` (transport
 *                           live) but this specific log's replication stream never
 *                           resumed, so writes on the remote peer stop crossing —
 *                           with no error and a boot log that otherwise looks
 *                           healthy. See `checkReplicationStall` in boot.ts.
 *   - 'replication_frozen' — P-004 (WI-183 class, attached-but-dead variant): an
 *                           admitted REMOTE log HAS a live replicator session but
 *                           its merge position hasn't advanced past the grace
 *                           window while the writer is known ahead — replication
 *                           attached but ingesting nothing. Emitted by
 *                           replication-liveness.ts (which also files a durable EI).
 *   - 'announce_admitted' — an inbound signed announce passed read-admission and
 *                           its per-peer log was added to the admitted set (Model B).
 *   - 'announce_pending'  — an inbound announce returned a 'pending' binding result
 *                           (channel-2 file not yet visible on GitHub); the peer
 *                           is stored for retry within the grace window (D-006).
 *   - 'announce_rejected' — an inbound announce failed the read-admission decision
 *                           (bad_sig / binding_invalid / revoked).
 *   - 'announce_clock_skew' — WI-1662: an inbound announce failed ONLY the D-007
 *                           freshness check (`verifyAnnounceDetailed` reason
 *                           'stale_ts') — the sig itself is valid, but the sender's
 *                           `ts` is >5min from this machine's clock. Recorded
 *                           ALONGSIDE (not instead of) the 'announce_rejected' the
 *                           frame still gets, so a skewed-clock peer is distinguishable
 *                           from a genuinely bad/forged signature: previously both
 *                           collapsed into the same indistinguishable `sigValid=false`
 *                           and the peer's log just silently never admitted, with
 *                           nothing pointing at "check this machine's clock/NTP".
 *   - 'announce_error'    — an exception while handling an announce (defensive).
 *   - 'merge_error'       — the read-merge driver threw on a pass (defensive).
 *   - 'replication_repair' — WI-3684 repair-on-detect: a connected_never_replicated
 *                           zombie session was re-attached (closed + re-opened) under
 *                           the merge gate. See `drainRepairQueue` in boot.ts.
 *   - 'replication_repair_failed' — WI-3684: a queued re-attach attempt threw (the
 *                           fresh session open itself failed); the log stays on its
 *                           stale (already-closed) session until a later episode
 *                           re-queues it, up to the per-log attempt cap.
 *
 * Keep this union in sync with the second declaration in
 * `app/harness/insights/BootHistoryTable.tsx` (+ its KIND_COLOR / KIND_MARK
 * maps) — the table renders these kinds and its Record maps must stay
 * exhaustive.
 */

import { trackDetached } from '../../detached-imports';

export type BootHistoryKind =
  | 'boot_start'
  | 'boot_ok'
  | 'boot_fail'
  | 'close'
  | 'peer_connected'
  // WI-1910 hardening (join-lifecycle witnesses): 'join_started' fires at
  // joinForBinding ENTRY (before its first await), 'join_succeeded' after the
  // swarm join returns. A 'join_started' with NEITHER 'join_succeeded' NOR
  // 'swarm_join_failed' is the silent-wedge signature (an await stuck on the
  // join critical path); no 'join_started' at all means the join was never
  // attempted. The WI-1910 rig hunt had no signal separating those two states
  // from a healthy-but-undialed swarm — each is a different bug class.
  | 'join_started'
  | 'join_succeeded'
  | 'swarm_join_failed'
  | 'peer_rejected'
  | 'peer_rate_limited'
  // P-008 (harden-shared-hive-to-256-peers): swarm peer-CONNECTION at/near the maxPeers
  // ceiling — Hyperswarm silently refuses peer N+1 at the cap, so onNearPeerCap records it
  // to make approaching/hitting 256 VISIBLE. Distinct from 'peer_capped' below (an admitted
  // peer's LOG exceeded the per-author op cap, not a connection-count signal).
  | 'peer_cap_near'
  // WI-6063: the per-topic fairness evaluator paused or resumed THIS topic's
  // outbound dialling because it held more (or no longer holds more) than its
  // share of the process-global peer budget. Edge-triggered — one row per
  // transition, not per evaluation. Distinct from 'peer_cap_near' (a
  // process-global total) : this names WHICH topic was held back and why, which
  // is the only way to tell a working fairness bound from a silent starvation.
  | 'peer_dial_throttled'
  | 'peer_capped'
  // p2p-join-catchup-speed P-005: the periodic OWN-log compaction (runOwnCompaction in
  // boot.ts) — its boot-time cadence anchor, each start, and each outcome (appended /
  // failed). These used to be recorded as 'peer_capped', which is neither stdout- nor
  // PG-mirrored, so whether a tower compaction ever ran, how long its full-history read
  // took, and why it failed were all unobservable once the in-memory ring rolled or the
  // process restarted. Sparse: one anchor per boot, then two rows per compaction.
  | 'own_log_compaction'
  | 'peer_revoked'
  | 'peer_unrevoked'
  // WI-10002600: ONE admitted log was retired by its own device's signed
  // supersession (an own-log fork recovery re-keyed it). The device stays
  // admitted under its new key — unlike 'peer_revoked', nothing is blocklisted.
  // Also recorded for a REFUSED supersession (a device naming another device's
  // log), with the refusal in the message.
  | 'peer_log_superseded'
  | 'replication_stalled'
  // P-004 (WI-1840, WI-183 class): an admitted REMOTE log has a live replicator
  // session attached (peers > 0) but the merge position has not advanced past
  // the grace window while the writer is known to be ahead — attached-but-dead
  // replication (blocks/ingest not flowing). Emitted edge-triggered by
  // replication-liveness.ts; the durable escalation is the EI it also files.
  | 'replication_frozen'
  | 'announce_admitted'
  | 'announce_pending'
  | 'announce_rejected'
  // WI-2039866: a REMOTE op the EN-4 owner-policy seam dropped (policy-admission.ts
  // makePolicyEnforcedApply onDrop) — reason + author + table, deduped per merge pass.
  // Before this kind existed such drops were invisible: the merge cursor advanced,
  // "replication live" read green, and the tower↔VM rig sat dark for weeks.
  | 'policy_drop'
  // WI-1662: recorded alongside 'announce_rejected' when the rejection reason is
  // SPECIFICALLY clock skew (stale_ts) rather than a bad/forged signature — see the
  // doc comment above.
  | 'announce_clock_skew'
  | 'announce_error'
  | 'merge_error'
  // WI-10003427: a merge pass stayed in flight past mergePassStallMs (names the stage it
  // is sitting in; re-armed with doubling back-off) / later settled / an identity-admitted
  // announce waited that long queued behind it. Every admission drains INSIDE a pass, so
  // a wedged pass silently starves admission — before these, nothing recorded it.
  | 'merge_stalled'
  | 'merge_stall_cleared'
  | 'announce_admission_stalled'
  // WI-280 (part B): the owner's re-key epoch-key grant to a freshly-admitted peer
  // failed. The grant is fire-and-forget (it must not block merge-gated admission),
  // so this is how the failure stays LOUD + queryable instead of a swallowed console.error.
  | 'rekey_grant_failed'
  // WI-280 (ee7e9 diagnostic): the grant SILENTLY early-returned {applied:false} WITHOUT
  // throwing — flag off / no fresh member pubkeys / no author pubkey (owner self-gate).
  // This is the non-throw 0-keys path part B's rekey_grant_failed cannot catch; the
  // message carries which condition + the input values so the witness re-run is conclusive.
  | 'rekey_grant_skipped'
  // WI-280 (boundary loud-signal): the revoke / go-private boundary path SKIPPED its epoch advance
  // without throwing — revokeHiveContributor early-returned (no_target / not_owner / no_owner_identity
  // / no_owner_row / revoke_failed) so advanceEpochOnHiveBoundary was never reached, OR the advance
  // itself no-op'd (flag off / no-author / no fresh members) → live:false. Mirrors rekey_grant_skipped
  // for the grant path: names the silent boundary 0→0 so a K2 revoke that doesn't advance NAMES why
  // (instead of a manual trace to the revoke early-return).
  | 'rekey_boundary_skipped'
  // WI-6043 (2026-07-26 reopen): the SUCCESS-path twin of rekey_boundary_skipped above.
  // advanceEpochOnHiveBoundary logs NOTHING when it actually applies — the boundary trigger
  // core (advanceEpochAndWrap) has no stdout output on its healthy path either — so a passing
  // boundary advance and a boundary that was simply never REACHED are indistinguishable from
  // any banked serve.log: both read as "rekey_boundary_skipped never fired". The WI-6043 reopen
  // investigation had to fall back to a live psql probe against the (soon torn-down) rig
  // containers to read the epoch column directly, which is exactly the "inferred from silence"
  // failure WI-5781 fixed for admission events and WI-280 fixed for the boundary SKIP case, but
  // missed for the boundary APPLY case. Fired from revokeHiveContributor right after a
  // successful (live:true) publishRevocation, naming the resulting newEpoch/distributed count so
  // the next rig run answers "was it invoked, and did it advance" directly from the banked log.
  | 'rekey_boundary_applied'
  // WI-808 (content-federation drop diagnosis): the apply-side epoch decrypt-gate's
  // per-op verdict. Both failure verdicts were previously SILENT (`return false`), so a
  // federated content op that never landed on a joiner left NO signal — indistinguishable
  // from the gate never being installed. These name the cause:
  //   - 'epoch_gate_built'    — rekeyDeps non-null: the decrypt gate IS wrapping applyImpl
  //                             for this harness (carries the resolved potHomeSlug = AAD potId).
  //   - 'epoch_defer'         — an encrypted op deferred: its epoch key is not yet local.
  //   - 'epoch_decrypt_fail'  — have a key but decrypt failed (wrong key / AAD mismatch:
  //                             potId is the LOCAL home slug, not a federated field) → DROP.
  //   - 'epoch_applied'       — an encrypted op decrypted + applied (the success path).
  | 'epoch_gate_built'
  // WI-5333 / P-505: the exact local device identity + keychain tiers resolved by
  // the epoch boot composition. Sparse (once per gate build), and durable so a
  // restart cannot erase the evidence needed to distinguish a boot-time identity
  // split from a downstream decrypt/apply failure.
  | 'epoch_boot_device'
  // WI-6043 (2026-07-26): `buildHiveRekeyBootDeps`'s fail-open catch casts this kind but it
  // was never declared in this union — a silent gate-build failure (a PG hiccup, a missing
  // local device identity, an unexpected throw) recorded an event whose `kind` didn't even
  // type-check as a BootHistoryKind, and — same root cause as rekey_boundary_skipped below —
  // it wasn't mirrored to stdout either, so a rig whose decrypt gate silently never installed
  // had NO way to show that in its banked serve.log.
  | 'epoch_gate_skipped'
  // WI-808 decisive entry trace: an encrypted-looking op (epoch stamped OR `{__rekey}`
  // value) REACHED the decrypt-gate. Distinguishes "content dropped UPSTREAM of the
  // gate" (this never fires) from "reached the gate but passed through" (fires with
  // epoch=NULL = the wire-stamp-lost case). The verdict kinds below follow it.
  | 'epoch_gate_seen'
  | 'epoch_defer'
  | 'epoch_decrypt_fail'
  | 'epoch_applied'
  // WI-3604 (recurrence guard for the split-DHT-universe outage class): recorded
  // once per harness join, right after this process's shared swarm resolves its
  // DHT bootstrap. 'dht_universe_ok' = either no expectation is configured
  // (PAPERCUSP_EXPECTED_DHT_BOOTSTRAP[_FILE] unset) or the resolved bootstrap
  // matches it. 'dht_universe_mismatch' = an expectation IS configured but this
  // process resolved to a DIFFERENT universe (public DHT, a different isolated
  // bootstrap, or a malformed env value) — the exact 2026-07-09 Mac VM incident
  // (a LaunchAgent's EnvironmentVariables not inherited by a manual app
  // relaunch, so PAPERCUSP_DHT_BOOTSTRAP silently read empty and the process
  // joined the PUBLIC DHT while every peer expected the isolated rig DHT). See
  // `resolveDhtUniverseState`/`assertDhtUniverse` in swarm.ts and the
  // `dhtUniverseMismatch` axis in replication-liveness.ts, which reads any
  // subsequent per-log stall as THIS cause instead of connected-but-dead.
  | 'dht_universe_ok'
  | 'dht_universe_mismatch'
  | 'replication_repair'
  | 'replication_repair_failed'
  // EI-13317 rung (b): the WI-3684 session-level repair budget
  // (REPAIR_MAX_ATTEMPTS_PER_LOG) is exhausted for a log AND it re-stalled
  // anyway — escalated to a topic-level forced rejoin (swarm.ts's
  // SwarmHandle.forceRejoin) rather than silently no-op'ing forever.
  | 'replication_repair_exhausted'
  // The forced-rejoin escalation itself threw (swarm.leave/join failure) —
  // distinct from 'replication_repair_failed' (a session re-attach failure).
  | 'replication_repair_rejoin_failed'
  // WI-5340 (WI-5332 Direction #1): a session re-attach was applied
  // ('replication_repair' above) but the post-repair confirmation window
  // elapsed with NO ingest progress and a live replicator peer still
  // attached — the re-attach did not actually fix the zombie. Emitted right
  // before synthesizing the next repair attempt directly (bypassing
  // replication-liveness.ts's edge-latch, which cannot re-fire on its own
  // while still alarmed).
  | 'replication_repair_confirmation_failed'
  // EI-18723690188615364: the other TWO outcomes of that same post-repair
  // confirmation window, which used to `return` having logged nothing at all —
  // so of its three branches only the failure above was observable. Success and
  // indefinite deferral were both silent and therefore indistinguishable from
  // each other, leaving the ~6min window between an applied repair and real
  // recovery completely unreadable (an operator saw the repair-APPLIED line and
  // concluded a 3-second incident against a real ~8.5min outage).
  //
  // 'replication_repair_confirmed' — ingest genuinely resumed (or caught up).
  // Carries the elapsed time SINCE THE REPAIR WAS APPLIED, which is the true
  // incident duration and is recorded nowhere else in the system.
  | 'replication_repair_confirmed'
  // The zero-peers branch (WI-5481) deferred judgment and re-armed its window:
  // still BROKEN, not recovered. Bounded — see the 'abandoned' kind below.
  | 'replication_repair_confirmation_deferred'
  // The deferral budget ran out: this log never observed a live replicator peer
  // at a judgment moment, so the re-attach ladder can never judge it. The
  // confirmation is dropped with a verdict instead of re-arming forever in
  // silence; permanently-zero peers is the no_replicator axis (WI-752/WI-1534
  // swarm self-heal), so no further attempt is synthesized.
  | 'replication_repair_confirmation_abandoned';

export interface BootHistoryEntry {
  ts: number;
  workspaceId: string;
  harnessSlug: string;
  kind: BootHistoryKind;
  message?: string;
  /** EI-18736339540215666: explicit provenance override for the durable PG mirror
   *  (boot-history-pg-store.ts) — 'real' | 'test'. Omitted ⇒ the PG store infers it
   *  from `process.env.VITEST`. This in-memory ring itself carries no provenance
   *  (it's process-local and always reflects this process's own reality). */
  origin?: 'real' | 'test';
}

function envCap(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

const DEFAULT_CAP = envCap('PAPERCUSP_BOOT_HISTORY_CAP', 200);

/**
 * EI-9108's boot-history sibling (WI-3827): `epoch_gate_seen` / `epoch_defer` /
 * `epoch_decrypt_fail` / `epoch_applied` fire PER-OP from the hot decrypt-gate trace
 * (buildEpochDecryptGate in hive-epoch-op-gate.ts) — orders of magnitude more frequent
 * than every other kind here (boot/close/peer/announce/replication events, each of
 * which fires at most once per lifecycle transition). A single shared ring meant this
 * high-frequency trace evicted the low-frequency admission/forensic evidence within
 * minutes (empirically confirmed 2026-07-10: a 200-deep ring held NOTHING but epoch
 * trace, producing a false "zero announces" signal that cost hours of misdirected
 * diagnosis). `epoch_gate_built` is excluded — it fires once per gate install, not
 * per-op, so it belongs with the low-frequency set.
 *
 * Fix: route the hot epoch-trace kinds into their OWN ring with their OWN (smaller,
 * env-configurable) cap, so no volume of epoch chatter can ever evict a
 * boot/peer/announce/replication entry — structural, not just a bigger shared cap
 * (which only buys time before the same eviction recurs at higher volume).
 */
const HIGH_FREQUENCY_KINDS: ReadonlySet<BootHistoryKind> = new Set([
  'epoch_gate_seen',
  'epoch_defer',
  'epoch_decrypt_fail',
  'epoch_applied',
]);
const DEFAULT_EPOCH_CAP = envCap('PAPERCUSP_BOOT_HISTORY_EPOCH_CAP', 40);

// Two independent append-only rings (each ascending-by-ts, oldest-first): `buffer` for
// every low-frequency/forensic kind, `epochBuffer` for the HIGH_FREQUENCY_KINDS hot
// trace. Evicting one never touches the other.
const buffer: BootHistoryEntry[] = [];
const epochBuffer: BootHistoryEntry[] = [];
let cap = DEFAULT_CAP;
let epochCap = DEFAULT_EPOCH_CAP;

/**
 * WI-5781 — kinds MIRRORED to stdout so they survive the process.
 *
 * Both rings are process-local: they clear on restart. That makes the
 * admission-decision trail unavailable for exactly the failure classes it
 * exists to serve — cold-restart re-peer, join-path, epoch rebind — because
 * the restart IS the event that destroys it. Worse, it fails SILENTLY and
 * ASYMMETRICALLY: a post-hoc `grep announce_admitted` over a banked serve log
 * returns zero hits for a PASSING run exactly as for a failing one, so the
 * absence reads as evidence when it is an artifact. That has now cost real
 * diagnosis time twice — the 2026-07-10 false "zero announces" signal noted
 * above (which the two-ring split fixed for EVICTION but not for VOLATILITY),
 * and WI-5781, where determining whether a member frame ADMITTED or BUFFERED
 * the owner's log was unrecoverable from any banked artifact and had to be
 * inferred from the peer frame's behaviour instead of observed.
 *
 * Mirroring these to stdout puts them in the banked serve logs the rigs
 * already capture, so "never admitted" becomes directly observable rather
 * than inferred from silence. Deliberately EXCLUDES the high-frequency epoch
 * trace and `peer_connected` (already logged by `[swarm]`, ~110/run): every
 * kind here is edge-triggered and sparse, so this cannot become a hot path.
 *
 * This is the cheap half of the fix. The durable half — persisting boot
 * history out of process (storage-policy default: Postgres) — is implemented
 * below (EI-18655247267756605): the SAME kind set is also best-effort mirrored
 * to `harness_shared.boot_history_events` (migration 660) via
 * boot-history-pg-store.ts, so the admission/join/peer/boot-fail trail
 * survives the restart that clears both in-memory rings, not just the
 * process's own stdout.
 */
const STDOUT_MIRROR_KINDS: ReadonlySet<BootHistoryKind> = new Set([
  // Admission decisions — the WI-5781 blind spot. A 'miss'-buffered peer log
  // is otherwise INVISIBLE: it never enters `admitted`, so the merge pass never
  // iterates it and the replication-liveness detector never samples it.
  'announce_admitted',
  'announce_pending',
  'announce_rejected',
  'announce_clock_skew',
  'announce_error',
  // Join lifecycle — 'join_started' with neither terminal kind is the
  // silent-wedge signature (WI-1910); useless if it dies with the process.
  'join_started',
  'join_succeeded',
  'swarm_join_failed',
  // Peer admissibility transitions + boot failure.
  'peer_revoked',
  'peer_unrevoked',
  'peer_log_superseded',
  'boot_fail',
  // P-005: own-log compaction anchor/start/outcome — sparse, and the only record of
  // whether the periodic snapshot producer actually ran on a box.
  'own_log_compaction',
  // WI-6043 (2026-07-26, revocation_kcut post-ban content LEAK): these three are the
  // re-key/K-cut path's own "loud signal" kinds (WI-280's stated purpose: "NAMES itself
  // instead of a silent 0→0" / "instead of a swallowed console.error") — but before this
  // fix they were recorded ONLY to the in-memory ring + PG, never mirrored to stdout, so
  // they were absent from exactly the artifact (`rig_bank_logs`' banked serve.log) every
  // Hetzner/local-matrix rig relies on for post-mortem diagnosis once frames are torn
  // down. A revocation_kcut FAIL investigation had to fall back to inferring the boundary
  // advance's outcome indirectly (epoch value absence across the whole run) instead of
  // reading the actual verdict — the exact "inferred from silence" failure WI-5781 fixed
  // for admission events but missed for these. All three are edge-triggered / at-most-
  // once-per-lifecycle-event (a revoke call, a member grant, a gate install) — same sparse
  // profile as the admission/join/peer kinds above, never the hot per-op decrypt trace.
  // WI-6063: per-topic dial throttling. Edge-triggered (transitions only), so it
  // matches the sparse profile above — but it is included for a sharper reason
  // than forensics-in-general: the fairness bound's failure mode is SILENT
  // starvation, indistinguishable by observation from the bug it fixes. The
  // in-memory ring dies with the process, so without this the ONLY durable
  // evidence that a topic was (or was not) held back would be gone by the time
  // anyone investigates "why did this hive never get peers". This is the record
  // that makes the mechanism verifiable rather than merely asserted.
  'peer_dial_throttled',
  'rekey_boundary_skipped',
  'rekey_boundary_applied',
  'rekey_grant_skipped',
  'epoch_gate_built',
  'epoch_boot_device',
  'epoch_gate_skipped',
]);

let _nowImpl: () => number = () => Date.now();

/** Test seam: capture the stdout mirror instead of writing to the console. */
let _mirrorImpl: (line: string) => void = (line) => console.log(line);

/**
 * Default durable-mirror write: a lazy `import('./boot-history-pg-store')` so
 * this module keeps zero static DB dependency (kept "pure logic" for callers
 * that don't want @papercusp/db-org pulled in just to record an in-memory
 * event), then a best-effort PG insert. Errors (a PG hiccup, or a missing
 * table on a host that hasn't applied migration 660 yet) are swallowed here
 * AND by the caller's own try/catch — this must never surface on a live
 * boot/announce/merge path.
 */
function _defaultPgWriteImpl(entry: BootHistoryEntry): void {
  void trackDetached(import('./boot-history-pg-store'))
    .then(({ insertBootHistoryEventPg }) => insertBootHistoryEventPg(entry))
    .catch(() => {
      // diagnostic-only — never let a PG hiccup break a boot/announce path
    });
}

/** Test seam: override the durable PG mirror instead of hitting real PG. */
let _pgWriteImpl: (entry: BootHistoryEntry) => void = _defaultPgWriteImpl;

export function _setMirrorForTests(impl: (line: string) => void): void {
  _mirrorImpl = impl;
}

export function _setPgWriteForTests(impl: (entry: BootHistoryEntry) => void): void {
  _pgWriteImpl = impl;
}

export function _setNowForTests(impl: () => number): void {
  _nowImpl = impl;
}

/** Set the default (low-frequency) ring's cap. Pass `epochN` to also set the
 *  high-frequency epoch-trace ring's cap (omit to leave it at its current value). */
export function _setCapForTests(n: number, epochN?: number): void {
  cap = n;
  if (epochN != null) epochCap = epochN;
}

export function _resetBootHistoryForTests(): void {
  buffer.length = 0;
  epochBuffer.length = 0;
  cap = DEFAULT_CAP;
  epochCap = DEFAULT_EPOCH_CAP;
  _nowImpl = () => Date.now();
  _mirrorImpl = (line) => console.log(line);
  _pgWriteImpl = _defaultPgWriteImpl;
}

export function recordBootEvent(
  workspaceId: string,
  harnessSlug: string,
  kind: BootHistoryKind,
  message?: string,
): void {
  const entry: BootHistoryEntry = {
    ts: _nowImpl(),
    workspaceId,
    harnessSlug,
    kind,
    message,
  };
  if (HIGH_FREQUENCY_KINDS.has(kind)) {
    epochBuffer.push(entry);
    while (epochBuffer.length > epochCap) epochBuffer.shift();
  } else {
    buffer.push(entry);
    while (buffer.length > cap) buffer.shift();
  }
  // WI-5781: mirror the sparse forensic kinds to stdout so they outlive the
  // process (see STDOUT_MIRROR_KINDS). Best-effort and fully isolated — a
  // throwing console must never break the caller, since every call site here
  // is a diagnostic on a live boot/merge/announce path.
  if (STDOUT_MIRROR_KINDS.has(kind)) {
    try {
      _mirrorImpl(
        `[boot-history] ${kind} harness=${harnessSlug}${message ? ` ${message}` : ''}`,
      );
    } catch {
      // diagnostic-only — never let logging break a boot/announce path
    }
    // EI-18655247267756605: durable half of the fix — best-effort mirror the
    // SAME sparse kind set to PG (boot-history-pg-store.ts) so this trail also
    // survives the restart that clears both in-memory rings, not just stdout.
    try {
      _pgWriteImpl(entry);
    } catch {
      // diagnostic-only — never let a PG hiccup break a boot/announce path
    }
  }
}

export interface ListBootHistoryOpts {
  workspaceId?: string;
  harnessSlug?: string;
  limit?: number;
  /** Filter to events with one of these kinds. */
  kinds?: ReadonlyArray<BootHistoryKind>;
}

/**
 * Returns a fresh array each call (sorted newest first), capped at
 * `limit` (default 50).
 *
 * Merges the two independent rings (`buffer` + the high-frequency `epochBuffer`) —
 * each individually ascending-by-ts, oldest-first — by walking both from their tail
 * (newest) end and always taking whichever is newer next, so the merged output stays
 * correctly ts-ordered across both rings without concatenating + re-sorting.
 */
export function listBootHistory(
  opts: ListBootHistoryOpts = {},
): BootHistoryEntry[] {
  const limit = opts.limit ?? 50;
  const kinds = opts.kinds ? new Set(opts.kinds) : null;
  const matches = (entry: BootHistoryEntry): boolean => {
    if (opts.workspaceId && entry.workspaceId !== opts.workspaceId) return false;
    if (opts.harnessSlug && entry.harnessSlug !== opts.harnessSlug) return false;
    if (kinds && !kinds.has(entry.kind)) return false;
    return true;
  };

  const filtered: BootHistoryEntry[] = [];
  let i = buffer.length - 1;
  let j = epochBuffer.length - 1;
  while (filtered.length < limit && (i >= 0 || j >= 0)) {
    const a = i >= 0 ? buffer[i] : undefined;
    const b = j >= 0 ? epochBuffer[j] : undefined;
    let pick: BootHistoryEntry;
    // Prefer `a` on a tie (arbitrary but deterministic) — newest-first overall.
    if (a && (!b || a.ts >= b.ts)) {
      pick = a;
      i -= 1;
    } else {
      pick = b!;
      j -= 1;
    }
    if (matches(pick)) filtered.push(pick);
  }
  return filtered;
}

/** Total entries currently held across BOTH rings (default + high-frequency epoch). */
export function bootHistoryDepth(): number {
  return buffer.length + epochBuffer.length;
}
