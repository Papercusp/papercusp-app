/**
 * hardened-authority — the lowest-pubkey election COMPOSED with the D-006
 * hardening (epoch fencing + anti-flap). Plan: locks-correctness-hardening-2026-06-04.
 *
 * Additive + opt-in: the bare {@link lockAuthorityFor} (lock-authority.ts) keeps
 * its exact behaviour, so callers already riding it (the plan-item claim store)
 * are untouched. A caller that wants the FENCING epoch + anti-flap guarantees
 * calls {@link resolveHardenedAuthority} instead — it computes the same argmin
 * over the live presence roster, then runs it through {@link decideAuthority}
 * against a persisted prior-authority record, advancing the monotonic epoch only
 * on a genuine handover and refusing to be thrashed by a returning lower peer.
 *
 * The record store is INJECTED (`loadRecord`/`saveRecord`) so the composition is
 * fully deterministic + unit-testable; the default is an in-process store. A
 * federated PG-backed store (an `authority_grants` row per harness, propagated
 * like `shared_presence`) is the production persistence — wiring that into the
 * live federated path is the coordinated per-surface cut-over (the authority/
 * presence surface is owned by the distributed-coordination track); the algorithm
 * + composition here are complete and proven against a fake store.
 */

import {
  decideAuthority,
  fenceValid,
  staleWindowMs,
  type AuthorityRecord,
  type HardeningTiming,
} from './authority-hardening';
import type { PeerRef, SelfSwarmIdentity } from './lock-authority';

interface LivePeerRow {
  device_pubkey: string;
  github_user_id: number;
  machine_label: string;
  last_seen_ms: number;
}

export interface HardenedAuthorityResolution {
  isSelf: boolean;
  peer?: PeerRef;
  liveCount: number;
  /** The monotonic fencing epoch a grant minted now must carry. */
  epoch: number;
  electedAtMs: number;
  /** A genuine handover happened on this resolution. */
  changed: boolean;
  /** Still inside the RCU grace window — do NOT enforce/revoke yet. */
  withinGrace: boolean;
}

export interface HardenedAuthorityDeps {
  fetchPresenceRows: (harnessSlug: string) => Promise<LivePeerRow[]>;
  resolveSelf: () => Promise<SelfSwarmIdentity | null>;
  loadRecord: (harnessSlug: string) => Promise<AuthorityRecord | null>;
  saveRecord: (harnessSlug: string, record: AuthorityRecord) => Promise<void>;
  now?: () => number;
  timing?: HardeningTiming;
}

/** Default in-process record store. Production swaps in a federated PG store. */
const _processRecords = new Map<string, AuthorityRecord>();
export function inProcessRecordStore() {
  return {
    loadRecord: async (slug: string) => _processRecords.get(slug) ?? null,
    saveRecord: async (slug: string, rec: AuthorityRecord) => {
      _processRecords.set(slug, rec);
    },
  };
}
export function _resetHardenedAuthorityForTests(): void {
  _processRecords.clear();
}

const DEFAULT_TIMING: HardeningTiming = { heartbeatMs: 30_000 }; // stale 90s (matches DEFAULT_AUTHORITY_STALE_MS)

/**
 * Resolve the hardened authority for a harness: argmin over the fresh roster,
 * passed through the epoch/hysteresis/cooldown/grace machinery, persisting the
 * record on a handover. Returns the fencing epoch + grace state alongside the
 * usual isSelf/peer.
 */
export async function resolveHardenedAuthority(
  harnessSlug: string,
  deps: HardenedAuthorityDeps,
): Promise<HardenedAuthorityResolution> {
  if (!harnessSlug) throw new TypeError('resolveHardenedAuthority: harnessSlug required');
  const now = deps.now ?? Date.now;
  const timing = deps.timing ?? DEFAULT_TIMING;
  const nowMs = now();
  const cutoff = nowMs - staleWindowMs(timing);

  const [rows, self, prior] = await Promise.all([
    deps.fetchPresenceRows(harnessSlug),
    deps.resolveSelf(),
    deps.loadRecord(harnessSlug),
  ]);

  // Fresh candidate set (dedup by pubkey, keep freshest), self always included.
  const byPubkey = new Map<string, LivePeerRow>();
  for (const r of rows) {
    if (!r.device_pubkey || r.last_seen_ms <= cutoff) continue;
    const prev = byPubkey.get(r.device_pubkey);
    if (!prev || r.last_seen_ms > prev.last_seen_ms) byPubkey.set(r.device_pubkey, r);
  }
  if (self && !byPubkey.has(self.devicePubkey)) {
    byPubkey.set(self.devicePubkey, {
      device_pubkey: self.devicePubkey,
      github_user_id: self.githubUserId,
      machine_label: '(self)',
      last_seen_ms: nowMs,
    });
  }

  const candidates = [...byPubkey.values()];
  if (candidates.length === 0) {
    // Alone — we are the authority. Carry/seed an epoch so a grant is still fenceable.
    const epoch = prior?.epoch ?? 1;
    return { isSelf: true, liveCount: 0, epoch, electedAtMs: prior?.electedAtMs ?? nowMs, changed: false, withinGrace: false };
  }

  let argmin = candidates[0];
  for (const c of candidates) if (c.device_pubkey < argmin.device_pubkey) argmin = c;
  const priorLive = prior != null && byPubkey.has(prior.pubkey);

  const decision = decideAuthority(argmin.device_pubkey, priorLive, prior, nowMs, timing)!;
  if (decision.changed) {
    await deps.saveRecord(harnessSlug, {
      pubkey: decision.pubkey,
      epoch: decision.epoch,
      electedAtMs: decision.electedAtMs,
    });
  }

  const winner = byPubkey.get(decision.pubkey)!;
  const isSelf = self != null && decision.pubkey === self.devicePubkey;
  return {
    isSelf,
    liveCount: candidates.length,
    peer: isSelf
      ? undefined
      : { devicePubkey: winner.device_pubkey, githubUserId: winner.github_user_id, machineLabel: winner.machine_label },
    epoch: decision.epoch,
    electedAtMs: decision.electedAtMs,
    changed: decision.changed,
    withinGrace: decision.withinGrace,
  };
}

export { fenceValid };
