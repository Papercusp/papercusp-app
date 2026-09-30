/**
 * hive-publish.ts — the announce-on-publish adapter for the hive directory
 * (p2p-hive-directory-2026-06-06 P-004).
 *
 * P-004: "Hive create/edit surface carries title + description; creating (or
 * opting-in) a hive announces it. Opt-in flag per hive — private hives never
 * announce." The directory service (hive-directory.ts) already owns
 * register + announce; this is the thin adapter the create/edit surface calls to
 * map a saved hive's METADATA + the local OWNER identity into the directory's
 * `LocalHiveDescriptor`, then register + (when public/invite) announce it.
 *
 * Pure over the injected directory — unit-testable without a swarm. The actual
 * STORAGE of the hive metadata (title/description/visibility on the hive record)
 * + the create/edit FORM are the UI surface that calls this; the live broadcast
 * requires the substrate boot-join + transport (see hive-directory-deps.ts).
 */

import type { HiveDirectory } from './hive-directory';
import type { HiveVisibility } from './sync/hyperbee/hive-announce';

/** The directory-relevant metadata a hive carries (set on the create/edit surface). */
export interface HiveDirectoryMeta {
  potId: string;
  title: string;
  description: string;
  /** The owning workspace — lets the announce-build enricher (P-004 hardening)
   *  re-derive members/links fresh per announce. Stamped by the publish
   *  call-sites; absent ⇒ legacy frozen-descriptor behavior. */
  workspaceId?: string;
  /** public = announce to the global topic; invite = invite-scoped topic only;
   *  private = never announce. Default for a directory-created hive: public. */
  visibility: HiveVisibility;
  /** Member harness swarm-topics (hex) — the display signal (how many harnesses). */
  memberTopics: string[];
  /**
   * The Hive's Ed25519 identity pubkey (raw-32-byte base64) — carried on the
   * announce so peers can DIAL this Hive for cross-Hive (P-006). Sourced at the
   * publish call-site from `loadHivePubkey(ws, potId)` (the `hives.public_key`
   * column); NOT persisted in the registry meta (it lives in the hives table).
   */
  hivePubkey?: string;
  /** Full `papercusp://harness?...` join links per member harness (one-click join). */
  memberLinks?: string[];
  /**
   * Member upstream repos, encoded `<owner>/<repo>[#<id>]` (hive-announce.ts) —
   * the repo→Hive binding signal (P-003). Derived FRESH at publish time via
   * `deriveHiveMemberRepoRefs` (like `hivePubkey`); NOT persisted in the
   * registry meta, so member additions surface on the next publish/boot.
   */
  memberRepos?: string[];
  /** Epoch-ms the hive was created (stable; for display + ordering). */
  createdAt: number;
  /** Required when visibility === 'invite' — the secret whose topic invitees join. */
  inviteSecret?: string;
}

/** The local device + GitHub identity that signs + owns the announce. */
export interface HiveOwnerIdentity {
  githubLogin: string;
  githubUserId: number;
  /** Raw 32-byte Ed25519 device pubkey, base64 (the binding convention). */
  devicePubkey: string;
  /** The P-011 device-attestation gist id (the channel-2 anchor browsers verify). */
  attestationGistId: string;
}

export interface PublishHiveResult {
  registered: boolean;
  /** A signed announce frame was built + broadcast onto the topic. NOTE: true
   *  does NOT mean any peer received it — `broadcast` is fire-and-forget. Read
   *  `reachablePeers` for whether it could actually reach anyone. */
  announced: boolean;
  /** Deceptive-publish fix: swarm peers reachable at announce time. 0 means the
   *  announce was broadcast into the void (no swarm connections) — the hive is
   *  registered but NOT discoverable yet. The UI must distinguish this from a
   *  real broadcast instead of flatly saying "announced to the directory". */
  reachablePeers: number;
  visibility: HiveVisibility;
}

/**
 * Register a hive this peer owns with the directory and announce it per its
 * visibility: `public` → the global topic, `invite` → its invite topic,
 * `private` → registered (so an edit→public re-announces) but NEVER announced.
 * Call this from the hive create/edit surface after saving metadata, and again
 * on any metadata change so the directory converges (P-003 "re-announce on hive
 * metadata change").
 */
export async function publishHiveToDirectory(
  dir: HiveDirectory,
  meta: HiveDirectoryMeta,
  owner: HiveOwnerIdentity,
): Promise<PublishHiveResult> {
  if (meta.visibility === 'invite' && !meta.inviteSecret) {
    throw new Error(`publishHiveToDirectory: hive ${meta.potId} is invite-visibility but has no inviteSecret`);
  }
  dir.registerLocalHive({
    potId: meta.potId,
    title: meta.title,
    description: meta.description,
    ...(meta.workspaceId ? { workspaceId: meta.workspaceId } : {}),
    memberTopics: [...meta.memberTopics],
    ...(meta.hivePubkey ? { hivePubkey: meta.hivePubkey } : {}),
    ...(meta.memberLinks ? { memberLinks: [...meta.memberLinks] } : {}),
    ...(meta.memberRepos ? { memberRepos: [...meta.memberRepos] } : {}),
    visibility: meta.visibility,
    createdAt: meta.createdAt,
    ownerGithubLogin: owner.githubLogin,
    ownerGithubUserId: owner.githubUserId,
    ownerDevicePubkey: owner.devicePubkey,
    attestationGistId: owner.attestationGistId,
    ...(meta.inviteSecret ? { inviteSecret: meta.inviteSecret } : {}),
  });
  // private never announces (announceLocalHive returns null for it).
  const frame = await dir.announceLocalHive(meta.potId);
  const announced = frame !== null;
  // WI-953: the single announce above is fire-and-forget over whatever
  // channels happen to be open right now — schedule a short follow-up burst
  // so a broadcast lost to connection churn (or a reachablePeers:0 void
  // broadcast right after create, before any peer has paired yet) self-heals
  // within ~45s instead of waiting on the 5-minute reannounce timer.
  if (announced) dir.burstReannounce(meta.potId);
  // Deceptive-publish fix: report how many peers the broadcast could actually
  // reach. announced && reachablePeers===0 ⇒ "registered but nobody heard it".
  // G-001: scope the count to THIS hive's announce topic (reachablePeersForHive),
  // not every joined topic — an invite announce must not count global-directory
  // peers it never reaches.
  return {
    registered: true,
    announced,
    reachablePeers: announced ? dir.reachablePeersForHive(meta.potId) : 0,
    visibility: meta.visibility,
  };
}

/**
 * Stop announcing a hive WITHOUT a wire withdrawal (legacy / local-only path):
 * drop it from the owned set so the re-announce timer no longer broadcasts it;
 * peers age it out via the TTL. Prefer `withdrawHiveFromDirectory` (P-005),
 * which ALSO broadcasts the signed unlist tombstone so peers drop immediately.
 */
export function unpublishHiveFromDirectory(dir: HiveDirectory, potId: string): void {
  dir.unregisterLocalHive(potId);
}

/**
 * P-005 (hive-from-repo-hardening D-005) — the ACTIVE withdrawal: broadcast a
 * signed `hive-unlist` tombstone on the hive's announce topic (peers verify it
 * against the listing's owner device key and drop the record immediately,
 * replay-resistant via the ts watermark), then unregister so the timer stops.
 * Best-effort: returns whether a tombstone actually went out (false for a
 * private/unknown hive — nothing was on the wire to withdraw).
 */
export async function withdrawHiveFromDirectory(
  dir: HiveDirectory,
  potId: string,
): Promise<{ withdrawn: boolean }> {
  try {
    const frame = await dir.unlistLocalHive(potId);
    return { withdrawn: frame !== null };
  } catch {
    // Signing/broadcast unavailable (e.g. keychain not wired) — fall back to
    // the passive path so the listing at least stops re-announcing.
    dir.unregisterLocalHive(potId);
    return { withdrawn: false };
  }
}
