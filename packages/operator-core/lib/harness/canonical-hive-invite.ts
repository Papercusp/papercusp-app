/**
 * canonical-hive-invite — the committed CANONICAL Papercusp dogfood-hive invite.
 *
 * Every install uses this to discover + silently auto-JOIN the ONE shared `papercusp`
 * hive (see papercusp-hive-join.ts `bakedCanonicalHiveInvite` +
 * agent-insights/papercusp-shared-hive-per-owner).
 *
 * WHY COMMITTED IN SOURCE (dogfood-silent-canonical-hive-join D-001 / P-003): the invite
 * is a DISCOVERY TOKEN, not an access grant. It only lets a fresh install subscribe to the
 * invite topic + REQUEST the hive; real access is gated by (a) GitHub repo permissions —
 * cloning the private member repos needs the user's own `gh` — and (b) the owner-signed
 * admission allowlist (hive-policy-author). So shipping it in the (private) source / the
 * binary exposes NOTHING, and committing it — rather than sourcing two env vars from an
 * UNTRACKED release script (build-desktop-sidecar.sh), the WI-867 fragility — makes the
 * feature ship RELIABLY, version-tracked, identically on macOS/Windows/Linux.
 *
 * NEVER put the hive PRIVATE KEY here. The private key lives ONLY in the owner's per-owner
 * PRIVATE gist (papercusp-shared-identity-gist.ts). This file holds the public pubkey +
 * the invite secret (the discovery topic seed) ONLY.
 *
 * ── TO ACTIVATE (owner, once) ────────────────────────────────────────────────────────
 * The feature stays DARK (per-owner create fallback, exactly as today) until both values
 * below are filled. To fill them, on the box that OWNS the canonical `papercusp` hive:
 *
 *   GITHUB_TOKEN=$(gh auth token) \
 *     node packages/operator-core/bin/print-canonical-hive-invite.mjs
 *
 * It reads the canonical hive identity the app already published to the owner's private
 * gist, prints the pubkey + invite secret, and warns about any divergent duplicate gists
 * (WI-867). VERIFY the printed pubkey matches the LIVE hive's federation pubkey before
 * committing (a wrong value puts joiners on the wrong topic). Then paste both below and
 * commit. From then on every build bakes this and fresh installs auto-join.
 */

/** The committed canonical invite (pubkey + invite secret). Structurally a
 *  CanonicalHiveInvite (papercusp-hive-join.ts) — kept dependency-free here to avoid an
 *  import cycle (papercusp-hive-join imports THIS for the fallback). */
export interface CanonicalHiveInviteConst {
  /** Raw-32 Ed25519 PUBLIC key, base64 — the canonical hive's federation identity. */
  pubkeyBase64: string;
  /** Directory invite secret (hex) — seeds the canonical hive's discovery topic. */
  inviteSecret: string;
  /**
   * Verified owner device PUBLIC key used to bootstrap the owner's first peer
   * log before the pot_members row inside that log can be read. Public identity,
   * never a private signing key.
   */
  ownerDevicePubkey: string;
}

// VERIFIED 2026-06-29 from the LIVE operator Postgres (harness_shared.pots +
// harness_registry.hiveDirectoryMeta) for workspace 'papercusp-workspace', home_slug
// 'papercusp' — the authoritative canonical hive identity the owner is announcing on.
// NOTE: WI-867 recorded pubkey `73cHWul…`, which is STALE/divergent — the LIVE hive
// federation pubkey is the value below (`dt7o6io…`). The invite secret matches WI-867.
// Content/federation topic = d85dc18c…; member link → Papercusp/papercup.

/** Raw-32 Ed25519 PUBLIC key (base64) of the canonical `papercusp` hive. Empty ⇒ dark. */
const CANONICAL_PUBKEY_BASE64 = 'dt7o6ioLVBSnppkg+H7WO+NLLKK1EUcXHQVR45BMNyA=';
/** Directory invite secret (hex) of the canonical `papercusp` hive. Empty ⇒ dark. */
const CANONICAL_INVITE_SECRET = 'b395df2e0980d58b9730d820d315ee8bf559abae22b34c6efdc5ffa97a32ab0e';
/**
 * VERIFIED 2026-08-27 from the canonical owner's binding-status=verified
 * pot_members attestation. This is the signer bound to the durable owner log
 * 5b00878b…; without it a pristine self-admitted peer cannot read the membership
 * update that would otherwise teach it this same key (D-006 cold-boot deadlock).
 */
const CANONICAL_OWNER_DEVICE_PUBKEY = 'XPAsvso1qEKbSzisNbjSLYzfz42Oxo4HRwibCkPLQII=';

/**
 * The committed canonical invite, or null when not yet minted (then the build bakes no
 * invite ⇒ bootstrap takes the per-owner create fallback — the pre-activation behaviour).
 */
export const CANONICAL_PAPERCUSP_HIVE_INVITE: CanonicalHiveInviteConst | null =
  CANONICAL_PUBKEY_BASE64 && CANONICAL_INVITE_SECRET
    ? {
        pubkeyBase64: CANONICAL_PUBKEY_BASE64,
        inviteSecret: CANONICAL_INVITE_SECRET,
        ownerDevicePubkey: CANONICAL_OWNER_DEVICE_PUBKEY,
      }
    : null;

/*
 * CANONICAL_HIVE_TEAM_ALLOWLIST MOVED OUT (WI-38322, 2026-08-12) → ./canonical-hive-team-allowlist
 *
 * It cannot live here. This module is client-reachable: papercusp-hive-join.ts imports
 * CANONICAL_PAPERCUSP_HIVE_INVITE above, and a bundler pulls in the module WHOLE — so the
 * team's real GitHub logins were being emitted into the client chunk (as a minified
 * `W=[<owner-login>,"papercupai"]` array — the real login is deliberately NOT quoted
 * here, because this comment ships in source and quoting it would re-leak the very
 * handle the move exists to remove) and shipped in the
 * sidecar SPA to everyone who downloaded the app. The allowlist authorises nothing on the
 * client; admission is decided server-side in goSharedHive. Keeping the two constants in
 * one file made a server-only secret-ish value ride along with a deliberately-public one.
 *
 * DO NOT re-add it here, or re-export it from here — either restores the leak. Server-side
 * consumers import it directly from './canonical-hive-team-allowlist'.
 */
