/**
 * hive-directory.ts — the P2P HIVE DIRECTORY service (p2p-hive-directory-2026-06-06 P-003).
 *
 * On substrate boot a peer JOINS the well-known directory topic
 * (derive-hive-topic.ts), VERIFIES inbound hive announces (signature + GitHub
 * attestation), and keeps the discovered set in memory with a PG-cached copy for
 * offline listing. It also ANNOUNCES the peer's own public/invite hives onto the
 * topic, re-announcing on a timer + on metadata change.
 *
 * DISCOVERY UX, NOT A TRUST SURFACE (D-002): a listed hive is best-effort gossip.
 * The directory renders only VERIFIED announces (valid Ed25519 signature +
 * GitHub attestation — D-001 verified-only posture, the spam floor) and supports
 * a LOCAL mute/hide list, but JOINING a listed hive still runs the full
 * admission/attestation flow elsewhere — a listing grants nothing.
 *
 * Architecture: the service core (verify → dedupe → maintain set → build/announce
 * → mute → re-announce) is pure over INJECTED seams — the swarm transport
 * (`broadcast`), the device signer (`sign`), the channel-2 attestation check
 * (`verifyAttestation`), and the PG cache (`loadCache`/`saveCache`). This mirrors
 * the established inject-the-IO-seam pattern (announce.ts's injected signer,
 * change-feed-deps, watchdog collectors) so the logic unit-tests without a swarm,
 * a keychain, or PG. Production wires the seams at boot (see `wireHiveDirectory`).
 *
 * Storage: PG is a CACHE for offline listing, never the transport (DB-is-not-a-
 * transport) — the live source is the topic; the cache only answers "what did I
 * last see" before the swarm reconnects.
 */

import {
  deriveDirectoryTopic,
  deriveInviteTopic,
  hiveTopicAsHex,
} from './sync/hyperbee/derive-hive-topic';
import { deriveHiveFederationTopic } from './sync/hyperbee/derive-swarm-topic';
import {
  buildHiveAnnounce,
  verifyHiveAnnounce,
  type HiveAnnounceBody,
  type HiveVisibility,
  type SignedHiveAnnounce,
} from './sync/hyperbee/hive-announce';
import {
  HIVE_UNLIST_KIND,
  buildHiveUnlist,
  verifyHiveUnlist,
  type SignedHiveUnlist,
} from './sync/hyperbee/hive-unlist';
import { sanitizeBeacon, type HiveStatusBeacon } from './hive-beacon';
import { managedSetInterval, type ManagedHandle } from '@papercusp/scheduled-registry';

export { isHiveUnlistFrame, type SignedHiveUnlist } from './sync/hyperbee/hive-unlist';

// Re-export the topic derivation so capability probes (e.g. the p2p-perf-tier3
// announce-volume forward hook's `hiveDirectoryReady`) can detect the substrate
// by importing from one place.
export { deriveDirectoryTopic, deriveInviteTopic } from './sync/hyperbee/derive-hive-topic';
export type { SignedHiveAnnounce, HiveVisibility } from './sync/hyperbee/hive-announce';

/** A hive discovered on the directory topic (verified), as listed to UI surfaces. */
export interface DiscoveredHive {
  potId: string;
  /**
   * WI-559 — set when `potId` is a LOCAL GUESS rather than the owner's authored slug.
   * The D-007 join-link seed (`defaultSeedOwnerBinding`) mints a synthetic descriptor
   * from a VERIFIED (hivePubkey → ownerDevicePubkey) binding but has no announce to
   * take the slug from, so it derives `${repoName}-pot` — designed to match what a real
   * announce stamps, but a guess nonetheless, and it is add-if-absent so it can outlive
   * the real beacon.
   *
   * Anything using `potId` as an IDENTITY (notably `loadAnnouncedHiveHomeSlug`, which
   * resolves the federation demux key) MUST skip these: canonicalizing a joiner onto a
   * guessed slug would break federation that currently works. Display/keying consumers
   * may keep using it. Absent/false ⇒ the slug came from a signed announce.
   */
  potIdSynthetic?: boolean;
  title: string;
  description: string;
  ownerGithubLogin: string;
  ownerGithubUserId: number;
  ownerDevicePubkey: string;
  /**
   * Raw 32-byte base64 Ed25519 HIVE-identity pubkey — the cross-Hive DIAL ADDRESS
   * (cross-hive-boundary-2026-06-08 P-006). Present only when the announcing Hive
   * carried its identity; absent ⇒ the Hive is browseable but not cross-Hive-addressable.
   */
  hivePubkey?: string;
  /** Member harness swarm-topics (hex) — the display signal (how many harnesses). */
  memberTopics: string[];
  /** Full join links per member harness, when the hive carries them (one-click join). */
  memberLinks?: string[];
  /** Member upstream repos, encoded `<owner>/<repo>[#<id>]` (hive-announce.ts) —
   *  the repo→Hive binding signal a paste-a-URL lookup matches against (P-003). */
  memberRepos?: string[];
  /**
   * A3 (EI-18788176839043286): the pot-git repoKey the POT HOME's bare store is
   * named on the OWNER's device. Unlike `memberRepos`, adopting this needs NO
   * correlator — a device whose local pot home matches `potId` takes it directly,
   * which is the only route open to a home entry that carries no upstream coords.
   */
  homeRepoKey?: string;
  visibility: HiveVisibility;
  /** Epoch-ms the hive was created (from the announce). */
  createdAt: number;
  /** Epoch-ms the most recent accepted announce was built (LWW ordering key). */
  announcedTs: number;
  /** Epoch-ms we last accepted an announce for it (local freshness / GC). */
  lastSeenMs: number;
  /** Channel-2 GitHub attestation verified (always true for a listed hive). */
  attested: true;
  /**
   * The opt-in status beacon the announcing Hive published (hive-network-surface
   * P-005 / C-2), already sanitized + clamped (sanitizeBeacon). Present only when
   * the announce carried a well-formed beacon; absent ⇒ the Hive published none
   * (or its beacon was unusable). A best-effort gossip signal — never a trust surface.
   */
  beacon?: HiveStatusBeacon;
}

/** A hive THIS peer owns + announces. */
export interface LocalHiveDescriptor {
  potId: string;
  title: string;
  description: string;
  /**
   * The workspace this hive lives in — the key the announce-build enricher
   * (P-004 hardening) derives fresh pubkey/memberRepos/memberLinks against.
   * Absent ⇒ the descriptor announces exactly as registered (legacy behavior).
   */
  workspaceId?: string;
  memberTopics: string[];
  /** Full join links per member harness (one-click join), when known. */
  memberLinks?: string[];
  /** Member upstream repos, encoded `<owner>/<repo>[#<id>]` — derived fresh at
   *  publish time (deriveHiveMemberRepoRefs), like hivePubkey. */
  memberRepos?: string[];
  /** A3: this pot HOME's own pot-git repoKey, derived fresh at publish time
   *  (`canonicalRepoKey` of the home entry) so peers adopt it instead of
   *  deriving — see the field on {@link DiscoveredHive}. */
  homeRepoKey?: string;
  visibility: HiveVisibility;
  createdAt: number;
  ownerGithubLogin: string;
  ownerGithubUserId: number;
  ownerDevicePubkey: string;
  /**
   * The Hive's own Ed25519 identity pubkey (raw-32-byte base64), carried on the
   * announce so peers can dial this Hive for cross-Hive (P-006). Set by the publish
   * path from the `hives.public_key` column; absent for a hive with no minted identity.
   */
  hivePubkey?: string;
  attestationGistId: string;
  /** Required for `invite` visibility — the secret whose topic invitees join. */
  inviteSecret?: string;
  /**
   * The opt-in status beacon to publish on this hive's announces (P-005 / C-2).
   * Set fresh per announce-build by the enrich seam (hive-descriptor-enrich) only
   * when the owner consented (BEACON_PUBLISH_CONSENT_KEY); absent ⇒ no beacon
   * goes on the wire. Carried into the announce body by `buildAnnounceFor`.
   */
  beacon?: HiveStatusBeacon;
}

/** Why an inbound announce was rejected (never rendered). */
export type IngestReject =
  | 'bad-signature-or-stale'
  | 'unattested'
  | 'superseded'
  | 'muted'
  /** P-005: dropped by a withdrawal tombstone with ts ≥ this announce's. */
  | 'tombstoned';

/** Why an inbound UNLIST was rejected (P-005). */
export type UnlistReject = 'bad-signature-or-stale' | 'unknown-hive' | 'not-owner';

export interface IngestResult {
  accepted: boolean;
  reason?: IngestReject;
}

/** Injected IO seams — production wires these at boot; tests pass fakes. */
export interface HiveDirectoryDeps {
  /** Sign bytes with the local device key (prod: `bytes => signWithDeviceKey(keychainId, bytes)`). */
  sign(bytes: Buffer): Promise<Buffer>;
  /** Channel-2 attestation check (prod: wraps attest.verifyAttestation(...).valid). */
  verifyAttestation(args: {
    attestationGistId: string;
    devicePubkey: string;
    githubUserId: number;
  }): Promise<boolean>;
  /** Broadcast a signed frame onto a topic (prod: swarm send to the topic's peers). */
  broadcast(topicHex: string, frame: SignedHiveAnnounce): Promise<void>;
  /** How many swarm peers the announce can actually REACH right now (prod: the
   *  directory-swarm's paired-channel count). Deceptive-publish fix: `broadcast`
   *  returns void, so a frame "announced" to a swarm with ZERO connections looks
   *  identical to a real broadcast. Surfacing this lets the publish result — and
   *  the UI — be honest ("announced, 0 peers connected" vs "broadcasting to N").
   *  G-001: `topicHex` SCOPES the count to the announce's OWN topic — an announce
   *  goes to exactly one topic (public=global, invite=secret), so the count must
   *  be that topic's peers, not every joined topic's (which over-reports reach for
   *  an invite publish on a box also browsing the global directory). Omit `topicHex`
   *  for the legacy all-topics total. Optional/additive: omitted seams report 0. */
  reachablePeers?(topicHex?: string): number;
  /**
   * EI-1599: how many peers are actually CONTENT-replicating on a topic right
   * now (prod: `swarm.ts`'s `contentPeerCountForTopic`, wired to the SHARED
   * content substrate swarm — distinct from `reachablePeers` above, which is
   * the hive-directory's own discovery/announce-gossip topic). Optional/
   * additive: an omitted seam reports 0 (honest — "unknown" would be a lie
   * that could read as "confirmed zero peers", so this deliberately can't be
   * told apart from a truly-zero-peer hive without the seam wired; callers
   * that need to distinguish "not wired" from "wired, zero peers" should gate
   * on whether the wiring ran, not on this return value alone).
   */
  contentPeers?(topicHex: string): number;
  /** EI-1599: ms-epoch of the last content-sync activity (an inbound signed-
   *  announce) seen on a topic (prod: `swarm.ts`'s `lastContentAnnounceRecvMs`).
   *  `null`/omitted ⇒ none observed. Optional/additive. */
  lastContentSyncMs?(topicHex: string): number | null;
  /** Load the cached discovered set (prod: PG). Optional — omit for in-memory only. */
  loadCache?(): Promise<DiscoveredHive[]>;
  /** Persist the discovered set (prod: PG). Optional. */
  saveCache?(hives: DiscoveredHive[]): Promise<void>;
  /** P-005: load the withdrawal tombstones (potId → unlist ts). Optional —
   *  omit for in-memory-only tombstones (a reboot could resurrect a dropped
   *  hive from the offline cache until its TTL). */
  loadTombstones?(): Promise<Record<string, number>>;
  /** P-005: persist the tombstones. Optional. */
  saveTombstones?(tombstones: Record<string, number>): Promise<void>;
  /**
   * Announce-BUILD-time descriptor enrichment (hardening P-004/D-004): called
   * on every frame build so the timer reannounce + fresh-pair snapshots carry
   * the registry as of NOW (members added between publishes included). MUST be
   * best-effort — a throw/reject falls back to the registered descriptor.
   * Prod: hive-descriptor-enrich.enrichLocalHiveDescriptor.
   */
  enrichDescriptor?(desc: LocalHiveDescriptor): Promise<LocalHiveDescriptor>;
  /**
   * Capture a beacon snapshot when an accepted announce carries a C-2 beacon
   * (hive-network-surface P-014, item 2 — tier-4 dossier history).
   * Best-effort: a throw/reject is caught + warned, never rejecting the announce.
   * Prod: captureBeaconSnapshot from network-board/beacon-history-pg.ts.
   */
  onBeaconAccepted?(potId: string, hivePubkey: string | null, beacon: HiveStatusBeacon): Promise<void>;
  /** Clock seam for deterministic tests. */
  now?(): number;
}

/** How long an un-refreshed discovered hive stays listed before GC (default 7d). */
export const DISCOVERED_HIVE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export class HiveDirectory {
  private readonly discovered = new Map<string, DiscoveredHive>();
  private readonly owned = new Map<string, LocalHiveDescriptor>();
  private readonly muted = new Set<string>();
  /** P-005: withdrawal tombstones — potId → the unlist frame's ts. An
   *  announce with ts ≤ this stays dropped; a newer one relists + clears. */
  private readonly tombstones = new Map<string, number>();
  private reannounceTimer: ManagedHandle | null = null;
  /** WI-953: pending burst-reannounce one-shot timers, keyed by potId — so a
   *  second publish/edit before the burst finishes replaces it instead of
   *  stacking, and `unregisterLocalHive` can cancel a burst for a hive that's
   *  gone. */
  private readonly burstTimers = new Map<string, ReturnType<typeof setTimeout>[]>();
  /** WI-40622: last emitted announce-frame census per hive_id, so the POSITIVE
   *  build-site record below logs ON CHANGE rather than on every build. The
   *  three failure warns in `buildAnnounceFor` are silent on success, which made
   *  "did hive_pubkey/member_links ride the wire?" answerable only by inference
   *  from silence — and `member_links` had no failure branch at all. */
  private readonly lastFrameCensus = new Map<string, string>();

  constructor(private readonly deps: HiveDirectoryDeps) {}

  private nowMs(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /** Swarm peers an announce can reach right now (0 = broadcasting into the void).
   *  Deceptive-publish fix — see HiveDirectoryDeps.reachablePeers. Pass `topicHex`
   *  to scope the count to ONE topic (the announce's own); omit for all topics. */
  reachablePeers(topicHex?: string): number {
    return this.deps.reachablePeers?.(topicHex) ?? 0;
  }

  /** G-001: peers reachable for the announce of ONE owned hive — i.e. peers on
   *  THAT hive's announce topic (public=global, invite=secret), not every joined
   *  topic. Returns 0 for an unknown/private hive (private never announces). This
   *  is what the publish path must report so an invite publish does not count the
   *  global-directory peers the invite announce never reaches. */
  reachablePeersForHive(potId: string): number {
    const desc = this.owned.get(potId);
    if (!desc) return 0;
    const topic = this.topicForLocalHive(desc); // null = private (never announces)
    if (!topic) return 0;
    return this.reachablePeers(hiveTopicAsHex(topic));
  }

  /** The hive's CONTENT-substrate topic (deriveSwarmTopic, keyed by hivePubkey)
   *  — distinct from `topicForLocalHive`'s discovery/announce topic. `null` for
   *  a hive with no minted identity yet (nothing has ever joined its content
   *  swarm, so honestly nothing to report). */
  private contentTopicForLocalHive(desc: LocalHiveDescriptor): Buffer | null {
    if (!desc.hivePubkey) return null;
    try {
      return deriveHiveFederationTopic(desc.hivePubkey);
    } catch {
      return null;
    }
  }

  /** EI-1599: TRUE per-hive content-replication peer count — peers whose
   *  content-announce channel is open on THIS hive's content topic, i.e.
   *  actually syncing hive content, not merely discoverable. 0 for an unknown
   *  hive, a hive with no minted identity, or when the `contentPeers` seam
   *  isn't wired (see the deps doc comment on why that's not distinguished
   *  from a genuine zero). Composes onto Brief H's per-topic announce-channel
   *  discrimination (A-002) via `swarm.ts`'s `contentPeerCountForTopic`. */
  contentPeersForHive(potId: string): number {
    const desc = this.owned.get(potId);
    if (!desc) return 0;
    const topic = this.contentTopicForLocalHive(desc);
    if (!topic) return 0;
    return this.deps.contentPeers?.(hiveTopicAsHex(topic)) ?? 0;
  }

  /** EI-1599: ms-epoch of the last content-sync activity observed on this
   *  hive's content topic, or `null` when unknown/none-yet (unminted identity,
   *  the seam isn't wired, or no announce has ever been received). */
  lastContentSyncAtForHive(potId: string): number | null {
    const desc = this.owned.get(potId);
    if (!desc) return null;
    const topic = this.contentTopicForLocalHive(desc);
    if (!topic) return null;
    return this.deps.lastContentSyncMs?.(hiveTopicAsHex(topic)) ?? null;
  }

  /** Hydrate the in-memory set from the PG cache (offline listing before the swarm reconnects). */
  async hydrateFromCache(): Promise<number> {
    // P-005: tombstones hydrate FIRST so a withdrawn hive in the offline cache
    // cannot resurrect across a reboot.
    if (this.deps.loadTombstones) {
      const ts = await this.deps.loadTombstones().catch(() => ({}) as Record<string, number>);
      for (const [id, t] of Object.entries(ts)) {
        const prev = this.tombstones.get(id);
        if (prev === undefined || t > prev) this.tombstones.set(id, t);
      }
    }
    if (!this.deps.loadCache) return this.discovered.size;
    const cached = await this.deps.loadCache().catch(() => [] as DiscoveredHive[]);
    for (const h of cached) {
      if (this.muted.has(h.potId)) continue;
      const tomb = this.tombstones.get(h.potId);
      if (tomb !== undefined && h.announcedTs <= tomb) continue; // withdrawn
      this.discovered.set(h.potId, h);
    }
    return this.discovered.size;
  }

  /**
   * Ingest an inbound announce: verify signature + freshness (channel-1), then
   * the GitHub attestation (channel-2). Only a frame passing BOTH is rendered
   * (D-001 verified-only). LWW by `ts` — an older announce never clobbers a newer
   * record for the same hive. A muted hive is dropped. Best-effort cache persist.
   */
  async ingestAnnounce(frame: SignedHiveAnnounce): Promise<IngestResult> {
    const nowMs = this.nowMs();
    if (!verifyHiveAnnounce(frame, { nowMs })) {
      return { accepted: false, reason: 'bad-signature-or-stale' };
    }
    if (this.muted.has(frame.hive_id)) {
      return { accepted: false, reason: 'muted' };
    }
    // LWW: ignore an announce that is not newer than what we already hold.
    const existing = this.discovered.get(frame.hive_id);
    if (existing && frame.ts <= existing.announcedTs) {
      return { accepted: false, reason: 'superseded' };
    }
    // P-005 tombstone: a withdrawn hive stays dropped for announces at or
    // before the withdrawal watermark (replay-resistance); a genuinely NEWER
    // signed announce relists (re-publish after withdraw) and clears it.
    const tomb = this.tombstones.get(frame.hive_id);
    if (tomb !== undefined) {
      if (frame.ts <= tomb) return { accepted: false, reason: 'tombstoned' };
      this.tombstones.delete(frame.hive_id);
      await this.persistTombstones();
    }
    const attested = await this.deps
      .verifyAttestation({
        attestationGistId: frame.attestation_gist_id,
        devicePubkey: frame.owner_device_pubkey,
        githubUserId: frame.owner_github_user_id,
      })
      .catch(() => false);
    if (!attested) {
      return { accepted: false, reason: 'unattested' };
    }
    // C-2 consume: clamp/sanitize the optional beacon. A malformed/oversize
    // beacon yields undefined (no beacon on the record) or a clamped value —
    // NEVER a rejected announce (the frame already passed sig + attestation).
    const beacon = sanitizeBeacon(frame.beacon);
    this.discovered.set(frame.hive_id, {
      potId: frame.hive_id,
      title: frame.title,
      description: frame.description,
      ownerGithubLogin: frame.owner_github_login,
      ownerGithubUserId: frame.owner_github_user_id,
      ownerDevicePubkey: frame.owner_device_pubkey,
      ...(frame.hive_pubkey ? { hivePubkey: frame.hive_pubkey } : {}),
      memberTopics: [...frame.member_topics],
      ...(frame.member_links ? { memberLinks: [...frame.member_links] } : {}),
      ...(frame.member_repos ? { memberRepos: [...frame.member_repos] } : {}),
      ...(frame.home_repo_key ? { homeRepoKey: frame.home_repo_key } : {}),
      visibility: frame.visibility,
      createdAt: frame.created_at,
      announcedTs: frame.ts,
      lastSeenMs: nowMs,
      attested: true,
      ...(beacon ? { beacon } : {}),
    });
    await this.persist();
    // P-014: capture the beacon snapshot (best-effort — never rejects the announce).
    if (beacon && this.deps.onBeaconAccepted) {
      this.deps.onBeaconAccepted(frame.hive_id, frame.hive_pubkey ?? null, beacon).catch((e) => {
        console.warn(`[hive-directory] beacon capture failed for ${frame.hive_id}: ${e instanceof Error ? e.message : e}`);
      });
    }
    return { accepted: true };
  }

  /**
   * The browse list: every verified, un-muted, un-expired discovered hive, newest
   * announce first. This is what the operator endpoint (P-005) serves to the UIs.
   */
  listDiscoveredHives(opts: { includeExpired?: boolean } = {}): DiscoveredHive[] {
    const nowMs = this.nowMs();
    const out: DiscoveredHive[] = [];
    for (const h of this.discovered.values()) {
      if (this.muted.has(h.potId)) continue;
      if (!opts.includeExpired && nowMs - h.lastSeenMs > DISCOVERED_HIVE_TTL_MS) continue;
      out.push(h);
    }
    return out.sort((a, b) => b.announcedTs - a.announcedTs);
  }

  /**
   * P-005 — ingest an inbound WITHDRAWAL tombstone. Trust rule (D-005): the
   * frame's signature must verify AND its pubkey must equal the LISTED
   * record's owner_device_pubkey (no listing → nothing to authenticate
   * against → rejected). On accept: drop the record, remember the watermark,
   * persist both.
   */
  async ingestUnlist(frame: SignedHiveUnlist): Promise<{ accepted: boolean; reason?: UnlistReject }> {
    const nowMs = this.nowMs();
    if (!verifyHiveUnlist(frame, { nowMs })) {
      return { accepted: false, reason: 'bad-signature-or-stale' };
    }
    const listed = this.discovered.get(frame.hive_id);
    if (!listed) return { accepted: false, reason: 'unknown-hive' };
    if (listed.ownerDevicePubkey !== frame.owner_device_pubkey) {
      return { accepted: false, reason: 'not-owner' };
    }
    this.discovered.delete(frame.hive_id);
    const prev = this.tombstones.get(frame.hive_id);
    if (prev === undefined || frame.ts > prev) this.tombstones.set(frame.hive_id, frame.ts);
    await this.persist();
    await this.persistTombstones();
    return { accepted: true };
  }

  /**
   * P-005 — owner side: broadcast a signed unlist for an owned hive on its
   * announce topic(s), then unregister it (stop re-announcing). Returns the
   * frame, or null when the hive is unknown/private (a private hive never
   * announced — there is nothing to withdraw on the wire).
   */
  async unlistLocalHive(potId: string): Promise<SignedHiveUnlist | null> {
    const desc = this.owned.get(potId);
    if (!desc) return null;
    const topic = this.topicForLocalHive(desc); // null = private, never on the wire
    if (!topic) {
      this.owned.delete(potId);
      return null;
    }
    const frame = await buildHiveUnlist(
      {
        kind: HIVE_UNLIST_KIND,
        hive_id: potId,
        owner_device_pubkey: desc.ownerDevicePubkey,
        ts: this.nowMs(),
      },
      this.deps.sign,
    );
    await this.deps
      .broadcast(hiveTopicAsHex(topic), frame as unknown as SignedHiveAnnounce)
      .catch(() => {});
    this.owned.delete(potId);
    return frame;
  }

  private async persistTombstones(): Promise<void> {
    if (!this.deps.saveTombstones) return;
    await this.deps.saveTombstones(Object.fromEntries(this.tombstones)).catch(() => {});
  }

  /** Locally hide a hive from the browse list (D-001 — no global moderation). */
  mute(potId: string): void {
    this.muted.add(potId);
  }
  unmute(potId: string): void {
    this.muted.delete(potId);
  }
  isMuted(potId: string): boolean {
    return this.muted.has(potId);
  }

  /** Register a hive THIS peer owns so it can be (re-)announced. */
  registerLocalHive(desc: LocalHiveDescriptor): void {
    this.owned.set(desc.potId, desc);
  }
  unregisterLocalHive(potId: string): void {
    this.owned.delete(potId);
    this.cancelBurstReannounce(potId);
  }

  private cancelBurstReannounce(potId: string): void {
    const timers = this.burstTimers.get(potId);
    if (!timers) return;
    for (const t of timers) clearTimeout(t);
    this.burstTimers.delete(potId);
  }

  /** The topic a given visibility announces on (null = never announces). */
  topicForLocalHive(desc: LocalHiveDescriptor): Buffer | null {
    if (desc.visibility === 'public') return deriveDirectoryTopic();
    if (desc.visibility === 'invite') {
      if (!desc.inviteSecret) {
        throw new Error(`hive ${desc.potId} is invite-visibility but has no inviteSecret`);
      }
      return deriveInviteTopic(desc.inviteSecret);
    }
    return null; // private — never announces
  }

  /**
   * Build + broadcast a signed announce for one owned hive. Returns the frame, or
   * null when the hive is `private` (never announces) or unknown. Re-announce on a
   * timer (`startReannounce`) AND call this directly when a hive's metadata
   * changes (P-004 create/edit) so the directory converges promptly.
   */
  /** Build (sign, do NOT broadcast) the announce frame for one owned hive, or
   *  null when private/unknown. Shared by announceLocalHive + buildOwnedAnnounces. */
  private async buildAnnounceFor(descIn: LocalHiveDescriptor): Promise<SignedHiveAnnounce | null> {
    if (!this.topicForLocalHive(descIn)) return null; // private
    // P-004 (hardening): re-derive pubkey/memberRepos/memberLinks at BUILD
    // time so every announce is fresh; failure → announce as registered.
    // WI-3496: swallow point #4 on the announce path. This `.catch` discards the
    // ENTIRE enrichment and announces `descIn` — and it also catches a rejection of
    // the LAZY `await import('./hive-descriptor-enrich')` inside the injected seam
    // (hive-directory-deps.ts), so the enricher can fail to ENTER and log nothing at
    // all. Failing soft stays (a broken enricher must not stop the hive announcing);
    // failing SILENTLY does not — an announce stripped of its cross-Hive dial address
    // is indistinguishable on the wire from one that never had a key.
    //
    // Measured 2026-08-22: the papercusp announce carried neither hivePubkey nor
    // memberLinks while the enricher, run standalone, supplies BOTH and the keychain
    // reads ok — with ZERO enricher log lines. All three outcomes below are silent
    // today, which is exactly why that state was unattributable.
    let desc = descIn;
    // Persisted production descriptors are workspace-bound. Synthetic/unit descriptors omit
    // workspaceId deliberately and do not own the production enrichment seam; emitting the
    // production alarm for them makes every pure announce test fail before its assertions while
    // adding no operational signal. Keep all three diagnostics fail-loud for real workspace rows.
    const warnOnUnenriched = typeof descIn.workspaceId === 'string' && descIn.workspaceId.length > 0;
    if (!this.deps.enrichDescriptor) {
      // (1) seam absent — production always wires it, so this means a non-production
      // deps object reached a real announce.
      if (warnOnUnenriched) {
        console.warn(
          `[hive-directory] announce for hive ${descIn.potId} built with NO enrichDescriptor seam ` +
            `(workspace ${descIn.workspaceId}) — no hivePubkey/memberRepos/memberLinks/` +
            `homeRepoKey enrichment rides this frame.`,
        );
      }
    } else {
      try {
        desc = await this.deps.enrichDescriptor(descIn);
      } catch (e) {
        // (2) the enricher (or its lazy import) REJECTED — it may never have entered,
        // which is why its own internal warnings can be absent.
        desc = descIn;
        if (warnOnUnenriched) {
          console.warn(
            `[hive-directory] enrichDescriptor REJECTED for hive ${descIn.potId} ` +
              `(workspace ${descIn.workspaceId}): ` +
              `${e instanceof Error ? (e.stack ?? e.message) : String(e)}. ` +
              `Announcing the UNENRICHED descriptor — no hivePubkey, memberRepos, memberLinks or ` +
              `homeRepoKey rides this frame. A lazy-import failure lands here having logged nothing.`,
          );
        }
      }
      if (!desc.hivePubkey && warnOnUnenriched) {
        // (3) enrichment RETURNED yet the frame still has no dial address. Distinguishes
        // "enricher never ran" from "enricher ran and still produced no key".
        console.warn(
          `[hive-directory] announce for hive ${descIn.potId} (workspace ` +
            `${descIn.workspaceId}) has NO hive_pubkey AFTER enrichment returned ` +
            `(enrichedKeys=${Object.keys(desc).sort().join('|')}) — this frame carries no ` +
            `cross-Hive dial address, so peers can discover the hive but never dial it.`,
        );
      }
    }
    const body: HiveAnnounceBody = {
      hive_id: desc.potId,
      title: desc.title,
      description: desc.description,
      owner_github_login: desc.ownerGithubLogin,
      owner_github_user_id: desc.ownerGithubUserId,
      owner_device_pubkey: desc.ownerDevicePubkey,
      ...(desc.hivePubkey ? { hive_pubkey: desc.hivePubkey } : {}),
      attestation_gist_id: desc.attestationGistId,
      member_topics: [...desc.memberTopics],
      ...(desc.memberLinks ? { member_links: [...desc.memberLinks] } : {}),
      ...(desc.memberRepos ? { member_repos: [...desc.memberRepos] } : {}),
      // A3: the pot home's own repoKey — the correlator-free adoption signal.
      ...(desc.homeRepoKey ? { home_repo_key: desc.homeRepoKey } : {}),
      visibility: desc.visibility,
      created_at: desc.createdAt,
      ts: this.nowMs(),
      // C-2 publish: the consent-gated beacon the enrich seam attached (absent ⇒
      // no beacon on the wire). Covered by the announce signature.
      ...(desc.beacon ? { beacon: desc.beacon } : {}),
    };
    // WI-40622: POSITIVE build-site record of what actually rides the wire. The
    // three warns above fire only on FAILURE, so a healthy announce emitted
    // nothing and "did the frame carry hive_pubkey / member_links?" could only be
    // inferred from silence — which cannot distinguish "enrichment succeeded"
    // from "buildAnnounceFor never ran". Presence + cardinality ONLY, never a
    // secret value. ON CHANGE, not per build: buildOwnedAnnounces runs on every
    // peer pairing (directory-swarm.ts getHelloFrames) as well as the 5-min
    // timer, so a per-build line would be noise; on-change gives one line per
    // hive per boot when steady and makes a field DISAPPEARING immediately loud.
    const census =
      `visibility=${body.visibility} ` +
      `hive_pubkey=${body.hive_pubkey ? 'present' : 'ABSENT'} ` +
      `member_links=${body.member_links?.length ?? 'ABSENT'} ` +
      `member_repos=${body.member_repos?.length ?? 'ABSENT'} ` +
      `member_topics=${body.member_topics.length} ` +
      `home_repo_key=${body.home_repo_key ? 'present' : 'ABSENT'} ` +
      `beacon=${body.beacon ? 'present' : 'ABSENT'}`;
    if (!process.env.VITEST && this.lastFrameCensus.get(body.hive_id) !== census) {
      this.lastFrameCensus.set(body.hive_id, census);
      console.warn(
        `[hive-directory] announce frame for hive ${body.hive_id} ` +
          `(workspace ${desc.workspaceId ?? 'unknown'}) ${census}`,
      );
    }
    return buildHiveAnnounce(body, this.deps.sign);
  }

  async announceLocalHive(potId: string): Promise<SignedHiveAnnounce | null> {
    const desc = this.owned.get(potId);
    if (!desc) return null;
    const topic = this.topicForLocalHive(desc);
    if (!topic) return null; // private
    const frame = await this.buildAnnounceFor(desc);
    if (!frame) return null;
    await this.deps.broadcast(hiveTopicAsHex(topic), frame);
    return frame;
  }

  /**
   * WI-953 durable fix: a single `announceLocalHive` broadcast is
   * fire-and-forget over whatever channels happen to be open at that exact
   * instant (topic-gossip.ts `broadcast()`) — no queue, no ack, no retry.
   * Live gate evidence (2026-07-10, run4): a freshly-created hive's announce
   * broadcast fired with a channel nominally open (reachablePeers:1) yet the
   * joiner never received it and never even logged a rejection — the frame
   * was lost somewhere in the connection-churn window right after a peer
   * pairs. The only prior resend was the 5-minute `startReannounce` timer,
   * which races the discovery poll's own ~300s window razor-thin.
   *
   * This schedules a short burst of follow-up re-announces for ONE hive
   * (fresh frame each time, so it also self-heals a stale reachablePeers:0
   * broadcast-into-the-void) at short, increasing delays — covering the
   * volatile first ~45s after a create/metadata-change without changing the
   * long-term steady-state cadence. Call once right after a publish/edit
   * (NOT from the periodic reannounce timer itself, or every 5-min tick
   * would re-trigger a fresh burst forever). Idempotent per potId: a second
   * call (e.g. a quick edit) replaces the pending burst rather than stacking.
   */
  burstReannounce(potId: string, delaysMs: number[] = HiveDirectory.BURST_REANNOUNCE_DELAYS_MS): void {
    this.cancelBurstReannounce(potId);
    const timers = delaysMs.map((ms) =>
      setTimeout(() => {
        void this.announceLocalHive(potId).catch(() => {});
      }, ms),
    );
    this.burstTimers.set(potId, timers);
  }

  /** Delays (ms) for `burstReannounce`'s follow-up re-announces. Covers the
   *  window a fresh swarm connection is most likely to still be settling
   *  (pairing/reconnect churn) — well inside a joiner's ~300s discovery poll. */
  private static readonly BURST_REANNOUNCE_DELAYS_MS = [2_000, 5_000, 10_000, 20_000, 45_000];

  /**
   * Build signed announce frames for owned NON-private hives (no broadcast). The
   * directory-swarm sends these to a freshly-paired peer (`getOwnAnnounces`) so a
   * newly-connected peer learns our hives immediately, without waiting for the
   * re-announce timer.
   *
   * `topicHex` SCOPES the result to the hives that announce on THAT topic — so a
   * peer paired on the GLOBAL topic only ever receives PUBLIC hives, and an
   * invite-topic peer only the invite hive(s) for that secret. Without it (the
   * default) every non-private owned hive is returned. The topic-scoping is what
   * keeps an invite hive from leaking onto the global directory.
   */
  async buildOwnedAnnounces(opts: { topicHex?: string } = {}): Promise<SignedHiveAnnounce[]> {
    const out: SignedHiveAnnounce[] = [];
    for (const desc of this.owned.values()) {
      const topic = this.topicForLocalHive(desc); // null for private
      if (!topic) continue;
      if (opts.topicHex && hiveTopicAsHex(topic) !== opts.topicHex) continue;
      const frame = await this.buildAnnounceFor(desc).catch(() => null);
      if (frame) out.push(frame);
    }
    return out;
  }

  /** Re-announce every owned non-private hive (the timer body). Returns the count broadcast. */
  async reannounceAll(): Promise<number> {
    let n = 0;
    for (const potId of this.owned.keys()) {
      const frame = await this.announceLocalHive(potId).catch(() => null);
      if (frame) n += 1;
    }
    return n;
  }

  /** Start the re-announce timer (prod: boot wiring). Returns a stop fn. Idempotent. */
  startReannounce(intervalMs: number): () => void {
    this.stopReannounce();
    this.reannounceTimer = managedSetInterval('hive-directory-reannounce', intervalMs, () => {
      void this.reannounceAll();
    }, { category: 'lifecycle', instanced: true });
    return () => this.stopReannounce();
  }
  stopReannounce(): void {
    if (this.reannounceTimer) {
      this.reannounceTimer.stop();
      this.reannounceTimer = null;
    }
  }

  /** GC discovered hives whose last announce is older than the TTL. Returns evicted count. */
  gcExpired(): number {
    const nowMs = this.nowMs();
    let evicted = 0;
    for (const [id, h] of this.discovered) {
      if (nowMs - h.lastSeenMs > DISCOVERED_HIVE_TTL_MS) {
        this.discovered.delete(id);
        evicted += 1;
      }
    }
    // P-005: tombstones age out with the same TTL — after that, the listing
    // would have TTL'd anyway, so the watermark has done its job.
    for (const [id, ts] of this.tombstones) {
      if (nowMs - ts > DISCOVERED_HIVE_TTL_MS) this.tombstones.delete(id);
    }
    return evicted;
  }

  private async persist(): Promise<void> {
    if (!this.deps.saveCache) return;
    await this.deps.saveCache([...this.discovered.values()]).catch(() => {});
  }
}

/**
 * Capability probe used by the p2p-perf-tier3 announce-volume forward hook
 * (and any other surface gating on "does the directory substrate exist yet").
 * Returns true now that P-001..P-003 have shipped — the topic + announce +
 * directory service are all present.
 */
export function hiveDirectoryReady(): boolean {
  return typeof deriveDirectoryTopic === 'function';
}
