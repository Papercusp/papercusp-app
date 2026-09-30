/**
 * hive-invite-link — format + parse `papercusp://pot?...` invite links
 * (hive-from-repo-hardening-2026-06-11 P-006, design D-006).
 *
 * One shareable invite ARTIFACT instead of a bare secret:
 *   papercusp://pot?pubkey=<base64-32B>&secret=<hex>&title=<urlencoded>
 *
 * Strict rules (patterned on `url-scheme.ts`):
 *   - Protocol must be `papercusp:`; host must be `pot`.
 *   - Param allowlist: `pubkey`, `secret`, `title`. Extra params rejected;
 *     duplicated params rejected.
 *   - `secret`: REQUIRED — the invite-topic secret, 32–128 hex chars
 *     (= 128–512 bits; case-insensitive; preserved verbatim — the invite topic
 *     is derived from the exact string the owner minted; real links are the
 *     256-bit/64-hex minted secret).
 *   - `pubkey`: OPTIONAL — the hive's Ed25519 identity pubkey, canonical
 *     padded standard base64 decoding to exactly 32 bytes.
 *   - `title`: OPTIONAL — human label, 1–200 chars.
 *
 * Returns `null` on any malformed input — never throws. PURE and
 * SPA-bundle-safe (no node:crypto/Buffer — same rule as harness-link-types).
 */

/** Parsed representation of a `papercusp://pot?...` invite link. */
export interface HiveInviteLink {
  /** The invite-topic secret, verbatim as shared (32–128 hex chars = 128–512 bits). */
  secret: string;
  /** The hive's Ed25519 identity pubkey (canonical base64, 32 bytes), when shared. */
  pubkeyBase64?: string;
  /** Human-readable hive title (≤200 chars), when shared. */
  title?: string;
}

export const HIVE_INVITE_LINK_PREFIX = 'papercusp://pot';

/** Exact set of accepted query-param keys. Any extra key → null. */
const ALLOWED_PARAMS = ['pubkey', 'secret', 'title'] as const;

/**
 * The invite secret: 32–128 hex chars, either case (= 128–512 bits).
 *
 * WAVE-4 X-1 (adversarial security / invite-secret strength): secrets are MINTED
 * as `randomBytes(32).toString('hex')` = 256-bit CSPRNG (hive-publish-from-repo.ts),
 * so every real link is 64 hex. The accept-floor was 16 hex (64 bits) — below the
 * minting; raised to 32 hex (128 bits) as defense-in-depth so a hand-crafted
 * weak-entropy link is rejected (the accept-floor now matches a strong minimum).
 * Not an exploitable fix — the topic is `sha256(prefix+secret)` with no offline
 * guess-oracle, so even 64 bits resisted online brute-force; this just aligns the
 * floor with the mint strength. See findings-X.md.
 */
const SECRET_RE = /^[0-9a-f]{32,128}$/i;

/**
 * Canonical padded standard base64 for exactly 32 bytes: 43 payload chars +
 * one `=` pad. (32 bytes → ceil(32/3)*4 = 44 chars.)
 */
const PUBKEY_B64_RE = /^[A-Za-z0-9+/]{43}=$/;

export const HIVE_INVITE_TITLE_MAX = 200;

/** True iff `s` is canonical standard base64 decoding to exactly 32 bytes. */
export function isValidHivePubkeyBase64(s: string): boolean {
  if (typeof s !== 'string' || !PUBKEY_B64_RE.test(s)) return false;
  try {
    // atob is global in browsers and Node ≥16 — keeps this module Buffer-free.
    return atob(s).length === 32;
  } catch {
    return false;
  }
}

/**
 * Build a `papercusp://pot?...` invite link. `secret` is required; `pubkey`
 * and `title` are emitted only when provided. Title is clamped to
 * HIVE_INVITE_TITLE_MAX so the artifact always round-trips through
 * `parseHiveInviteLink`. Caller is responsible for a valid secret/pubkey
 * (mirrors url-scheme.ts formatHarnessLink).
 */
export function formatHiveInviteLink(input: {
  pubkeyBase64?: string;
  secret: string;
  title?: string;
}): string {
  const p = new URLSearchParams();
  if (input.pubkeyBase64) p.set('pubkey', input.pubkeyBase64);
  p.set('secret', input.secret);
  if (input.title) p.set('title', input.title.slice(0, HIVE_INVITE_TITLE_MAX));
  return HIVE_INVITE_LINK_PREFIX + '?' + p.toString();
}

/**
 * Parse a `papercusp://pot?...` invite link. Returns `HiveInviteLink` on
 * success, `null` on any malformed input. Never throws.
 */
export function parseHiveInviteLink(url: string): HiveInviteLink | null {
  if (typeof url !== 'string') return null;

  // Fast prefix check before constructing a URL object.
  if (!url.startsWith('papercusp://')) return null;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'papercusp:') return null;
  if (parsed.host !== 'pot') return null;

  // Reject extra params; reject duplicated allowlisted params.
  for (const key of parsed.searchParams.keys()) {
    if (!(ALLOWED_PARAMS as readonly string[]).includes(key)) return null;
  }
  for (const key of ALLOWED_PARAMS) {
    if (parsed.searchParams.getAll(key).length > 1) return null;
  }

  const secret = parsed.searchParams.get('secret');
  if (!secret || !SECRET_RE.test(secret)) return null;

  const pubkey = parsed.searchParams.get('pubkey');
  if (pubkey !== null && !isValidHivePubkeyBase64(pubkey)) return null;

  const title = parsed.searchParams.get('title');
  if (title !== null && (title.length === 0 || title.length > HIVE_INVITE_TITLE_MAX)) return null;

  return {
    secret,
    ...(pubkey !== null ? { pubkeyBase64: pubkey } : {}),
    ...(title !== null ? { title } : {}),
  };
}
