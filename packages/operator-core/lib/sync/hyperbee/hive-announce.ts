/**
 * hive-announce — the signed HIVE-DIRECTORY announce wire-format
 * (p2p-hive-directory-2026-06-06 P-001).
 *
 * A peer that owns a public (or invite-shared) hive broadcasts a signed announce
 * onto the directory topic (derive-hive-topic.ts). Other peers verify + render it
 * in their browse list. This is the directory's gossip frame — DISCOVERY UX, not
 * a trust surface (D-002): a valid announce lists a hive; JOINING it still runs
 * the full admission/attestation flow, and a listing grants nothing.
 *
 * It REUSES the announce.ts Ed25519 plumbing as-is (D-001 / the brief): raw-32-
 * byte-base64 device pubkey → SPKI-DER rebuild via the fixed 12-byte prefix →
 * Node-crypto `verify(null, …)`; a field-ordered JSON canonicalization (all
 * values are primitives or a string[] so a fixed order equals JCS for the
 * schema); a ±windowMs freshness check on `ts` (covered by the sig, closing the
 * replay-announce surface); and an INJECTED signer (tests pass a generated
 * keypair; production passes `bytes => signWithDeviceKey(keychainId, bytes)`),
 * exactly like peer announces.
 *
 * The announce binds the hive to its OWNER DEVICE identity: `owner_device_pubkey`
 * is the same raw-32-byte-base64 string as a peer announce's `device_pubkey`, so
 * a verified hive announce identifies a device whose GitHub attestation a
 * browsing peer can then check (verifyAttestation) before trusting the listing.
 */

import { sign as nodeSign, verify as nodeVerify, createPublicKey } from 'node:crypto';
import { canonicalBeaconForSigning, type HiveStatusBeacon } from '../../hive-beacon';

/** A hive's directory visibility (p2p-hive D-004). */
export type HiveVisibility = 'public' | 'invite' | 'private';
export const HIVE_VISIBILITIES: readonly HiveVisibility[] = ['public', 'invite', 'private'];
export function isHiveVisibility(v: unknown): v is HiveVisibility {
  return v === 'public' || v === 'invite' || v === 'private';
}

/** The signed-over fields of a hive announce (everything except `sig`). */
export interface HiveAnnounceBody {
  /** Stable hive id (workspace-local hiveControlFrames key / hive slug). */
  hive_id: string;
  /** Human title shown in the browse list. */
  title: string;
  /** One-paragraph description shown in the browse list. */
  description: string;
  /** The owner's GitHub login (display + the attestation anchor). */
  owner_github_login: string;
  /** The owner's GitHub numeric id — pins the attestation gist owner. */
  owner_github_user_id: number;
  /** Raw 32-byte Ed25519 device public key, base64 (== a peer announce's device_pubkey). */
  owner_device_pubkey: string;
  /**
   * Raw 32-byte Ed25519 HIVE-IDENTITY public key, base64 — the Hive's own keypair
   * (shared-hive-federation D-002), distinct from `owner_device_pubkey`. This is
   * the cross-Hive DIAL ADDRESS: a peer derives `deriveHiveFederationTopic(hive_pubkey)`
   * to reach this Hive's boundary (cross-hive-boundary-2026-06-08 P-006). OPTIONAL +
   * additive — only a Hive that minted its identity carries it; included in the
   * canonical signing bytes only when present (like `member_links`/`nonce`), so an
   * announce that omits it signs the exact bytes earlier versions did.
   */
  hive_pubkey?: string;
  /** P-011 device-attestation gist id (the channel-2 anchor a browser verifies). */
  attestation_gist_id: string;
  /**
   * The hive's member harness swarm-topics (hex) — the DISPLAY signal (how many
   * harnesses, the topic identities). Empty for a hive with no shared harnesses
   * yet. Order-significant in the canonical bytes.
   */
  member_topics: string[];
  /**
   * Full `papercusp://harness?...` join links per member harness (topic + the
   * GitHub repo binding). OPTIONAL + additive: a topic hex alone cannot form a
   * valid join link (join-shared-harness needs the repo id), so a hive that
   * wants ONE-CLICK join carries the full links here; a topic-only announce is
   * still browseable but its Join surfaces "link required". Order-significant;
   * included in the canonical signing bytes only when present (like `nonce`).
   */
  member_links?: string[];
  /**
   * Member harness upstream repos, encoded `<owner>/<repo>` or
   * `<owner>/<repo>#<id>` (id = GitHub's immutable numeric repository id when
   * known) — the repo→Hive binding signal (hive-from-github-url-2026-06-11
   * P-003): a peer pasting a GitHub URL matches it against these to offer JOIN
   * instead of create. OPTIONAL + additive; order-significant; included in the
   * canonical signing bytes only when present (like `member_links`), so an
   * announce that omits it signs the exact bytes earlier versions did.
   */
  member_repos?: string[];
  /**
   * The pot-git repoKey the POT HOME's own bare store is named on the owner's
   * device (A3, EI-18788176839043286).
   *
   * WHY THIS EXISTS SEPARATELY FROM `member_repos`/`member_links`. Those two
   * identify a member repo by its UPSTREAM GitHub coords, so a peer can only
   * adopt from them if it already holds the same coords. The pot HOME is exactly
   * the entry that often does NOT: `ensure-papercusp-hive` mints it with no
   * upstream at all, so it can correlate against nothing and is left deriving —
   * and therefore diverging — forever. This field needs no correlator: a device
   * whose local pot-home matches this announce's `hive_id` adopts it directly.
   *
   * OPTIONAL + additive; included in the canonical signing bytes only when
   * present, so an announce that omits it signs the exact bytes earlier versions
   * did.
   */
  home_repo_key?: string;
  /** Directory visibility — `public` announces to the global topic; `invite` to an
   *  invite-scoped topic only. (`private` never announces, so it never appears on
   *  the wire — included for completeness/round-trip.) */
  visibility: HiveVisibility;
  /** Epoch-ms when the hive was created (stable; for display + ordering). */
  created_at: number;
  /** Epoch-ms at announce-build time. Covered by sig; freshness-checked. */
  ts: number;
  /** Optional random nonce for additional replay resistance. Covered by sig. */
  nonce?: string;
  /**
   * OPTIONAL + additive — the opt-in status beacon (hive-network-surface-2026-06-11
   * P-005 / C-2): a compact activity summary the owner consented to publish. Carried
   * in the canonical signing bytes (via `canonicalBeaconForSigning`) only when
   * present, so an announce that omits it signs the exact bytes earlier versions
   * did. The consumer clamps/sanitizes it (`sanitizeBeacon`) and never rejects the
   * announce over a malformed beacon. See hive-beacon.ts for the frozen schema.
   */
  beacon?: HiveStatusBeacon;
}

/** A full hive announce as sent on the wire. */
export interface SignedHiveAnnounce extends HiveAnnounceBody {
  /** Base64 Ed25519 signature over `hiveAnnounceSigningBytes(body)`. */
  sig: string;
}

// ── member_repos ref encoding (hive-from-github-url P-003) ────────────────────

/** A parsed member-repo ref — the repo→Hive binding unit. */
export interface MemberRepoRef {
  owner: string;
  repo: string;
  /** GitHub's immutable numeric repository id, when known at publish time. */
  githubRepositoryId?: number;
}

/**
 * Encode a member-repo ref for the `member_repos` wire field:
 * `<owner>/<repo>` or `<owner>/<repo>#<id>`. Owner/repo segments follow
 * GitHub's charset (no `#` or `/` inside a segment), so parsing on the LAST
 * `#` is unambiguous.
 */
export function encodeMemberRepoRef(ref: MemberRepoRef): string {
  const id = ref.githubRepositoryId;
  return `${ref.owner}/${ref.repo}${typeof id === 'number' && Number.isFinite(id) ? `#${id}` : ''}`;
}

/** Parse a `member_repos` element. Returns null on any malformed input — never throws. */
export function parseMemberRepoRef(encoded: string): MemberRepoRef | null {
  if (typeof encoded !== 'string' || !encoded) return null;
  let base = encoded;
  let id: number | undefined;
  const hash = encoded.lastIndexOf('#');
  if (hash !== -1) {
    const idPart = encoded.slice(hash + 1);
    if (!/^\d+$/.test(idPart)) return null;
    id = Number(idPart);
    base = encoded.slice(0, hash);
  }
  const slash = base.indexOf('/');
  if (slash <= 0 || slash === base.length - 1) return null;
  const owner = base.slice(0, slash);
  const repo = base.slice(slash + 1);
  if (repo.includes('/')) return null;
  return { owner, repo, ...(id !== undefined ? { githubRepositoryId: id } : {}) };
}

/** Fixed 12-byte Ed25519 SPKI DER prefix (matches announce.ts / attest.ts). */
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** Same default freshness window as peer announces (D-007 replay hardening). */
export const DEFAULT_HIVE_ANNOUNCE_WINDOW_MS = 5 * 60 * 1000;

/**
 * Canonical signing bytes: field-ordered JSON of the body EXCLUDING `sig`. All
 * values are primitives or a string[], so a fixed field order equals JCS for the
 * schema. `member_topics` is serialized as-is (order-significant); `nonce` is
 * only included when present (undefined → key omitted), mirroring announce.ts.
 */
export function hiveAnnounceSigningBytes(body: HiveAnnounceBody): Buffer {
  const ordered: Record<string, unknown> = {
    hive_id: body.hive_id,
    title: body.title,
    description: body.description,
    owner_github_login: body.owner_github_login,
    owner_github_user_id: body.owner_github_user_id,
    owner_device_pubkey: body.owner_device_pubkey,
    attestation_gist_id: body.attestation_gist_id,
    member_topics: body.member_topics,
    visibility: body.visibility,
    created_at: body.created_at,
    ts: body.ts,
  };
  // member_links + nonce + hive_pubkey + member_repos + beacon are optional →
  // included only when present, so an announce that omits them signs the exact
  // bytes earlier versions did. `beacon` goes through a canonical fixed-key-order
  // projection (canonicalBeaconForSigning) so its bytes are independent of wire
  // key order and only the frozen v1 fields are signed.
  if (Array.isArray(body.member_links)) ordered.member_links = body.member_links;
  if (typeof body.nonce === 'string') ordered.nonce = body.nonce;
  if (typeof body.hive_pubkey === 'string') ordered.hive_pubkey = body.hive_pubkey;
  if (Array.isArray(body.member_repos)) ordered.member_repos = body.member_repos;
  if (typeof body.home_repo_key === 'string') ordered.home_repo_key = body.home_repo_key;
  if (body.beacon && typeof body.beacon === 'object') {
    const canon = canonicalBeaconForSigning(body.beacon);
    if (canon) ordered.beacon = canon;
  }
  return Buffer.from(JSON.stringify(ordered), 'utf8');
}

/**
 * Build a signed hive announce. The signer is injected: production passes
 * `bytes => signWithDeviceKey(keychainId, bytes)`; tests pass a generated
 * keypair's signer. Returns the full frame ready for the wire.
 */
export async function buildHiveAnnounce(
  body: HiveAnnounceBody,
  sign: (bytes: Buffer) => Promise<Buffer>,
): Promise<SignedHiveAnnounce> {
  const sig = await sign(hiveAnnounceSigningBytes(body));
  return { ...body, sig: sig.toString('base64') };
}

/**
 * Verify a hive announce's `sig` against its `owner_device_pubkey` (raw-32-byte
 * base64 → SPKI rebuild → nodeVerify) over `hiveAnnounceSigningBytes(frame)`,
 * and that `frame.ts` is within `opts.windowMs` of `opts.nowMs`. Returns false
 * on any tamper, stale/future ts, bad shape, or malformed input — never throws.
 *
 * This is signature + freshness ONLY (channel-1). The channel-2 GitHub
 * attestation (verifyAttestation over `attestation_gist_id`/`owner_github_user_id`/
 * `owner_device_pubkey`) is the directory service's separate admission check
 * (D-002) — a verified SIGNATURE proves the frame is from the device it claims;
 * the attestation proves that device belongs to the GitHub identity it claims.
 */
export function verifyHiveAnnounce(
  frame: SignedHiveAnnounce,
  opts?: { nowMs?: number; windowMs?: number },
): boolean {
  try {
    if (!frame || typeof frame !== 'object') return false;
    if (
      typeof frame.hive_id !== 'string' ||
      typeof frame.title !== 'string' ||
      typeof frame.description !== 'string' ||
      typeof frame.owner_github_login !== 'string' ||
      typeof frame.owner_github_user_id !== 'number' ||
      typeof frame.owner_device_pubkey !== 'string' ||
      (frame.hive_pubkey !== undefined && typeof frame.hive_pubkey !== 'string') ||
      typeof frame.attestation_gist_id !== 'string' ||
      !Array.isArray(frame.member_topics) ||
      frame.member_topics.some((t) => typeof t !== 'string') ||
      (frame.member_links !== undefined &&
        (!Array.isArray(frame.member_links) || frame.member_links.some((l) => typeof l !== 'string'))) ||
      (frame.member_repos !== undefined &&
        (!Array.isArray(frame.member_repos) || frame.member_repos.some((r) => typeof r !== 'string'))) ||
      (frame.home_repo_key !== undefined && typeof frame.home_repo_key !== 'string') ||
      !isHiveVisibility(frame.visibility) ||
      typeof frame.created_at !== 'number' ||
      typeof frame.sig !== 'string'
    ) {
      return false;
    }

    // A `private` hive must never appear on the wire.
    if (frame.visibility === 'private') return false;

    // D-007 freshness: ts present + within the window.
    if (typeof frame.ts !== 'number') return false;
    const nowMs = opts?.nowMs ?? Date.now();
    const windowMs = opts?.windowMs ?? DEFAULT_HIVE_ANNOUNCE_WINDOW_MS;
    if (Math.abs(nowMs - frame.ts) > windowMs) return false;

    const rawPubkey = Buffer.from(frame.owner_device_pubkey, 'base64');
    if (rawPubkey.length !== 32) return false;

    const spkiDer = Buffer.concat([SPKI_PREFIX, rawPubkey]);
    const publicKey = createPublicKey({ key: spkiDer, format: 'der', type: 'spki' });

    const bytes = hiveAnnounceSigningBytes(frame);
    const sig = Buffer.from(frame.sig, 'base64');
    return nodeVerify(null, bytes, publicKey, sig);
  } catch {
    return false;
  }
}
