/**
 * papercusp-shared-identity-gist — the per-owner store for the SHARED `papercusp`
 * dogfood hive identity (Solution C / DOGFOOD_PAPERCUSP_POT_SHARE).
 *
 * The owner's hive identity (Ed25519 keypair DER + the directory invite secret) is
 * stored in a GitHub gist tied to the owner's account, so EVERY one of the owner's
 * devices converges on ONE hive identity WITHOUT baking a secret into the public
 * binary. The first device generates + publishes; later devices fetch + adopt.
 *
 * Best-effort: ANY failure (no network, missing `gist` scope, malformed blob, no
 * passphrase configured) returns null and the caller (papercusp-hive-share) simply
 * skips sharing for this boot and retries on the next one. Nothing here ever throws
 * to the bootstrap.
 *
 * ── SECURITY (WI-2147371 / D-056) ────────────────────────────────────────────────
 * A `public:false` gist is UNLISTED, **not** access-controlled. GitHub's own docs:
 * "Secret gists aren't private. If you send the URL of a secret gist to a friend,
 * they'll be able to see it. However, if someone you don't know discovers the URL,
 * they'll also be able to see your gist." Both the web URL and `GET /gists/{id}`
 * serve it ANONYMOUSLY — the gh token is not a read gate. The 32-hex id is
 * unguessable, so the practical exposure is id LEAKAGE (logs, journals, browser
 * history, a screenshot, any listing of the owner's gists), after which a plaintext
 * blob hands a stranger the hive private key and the invite secret.
 *
 * Therefore the gist NEVER carries plaintext secrets. The private key and the invite
 * secret are sealed client-side (scrypt-derived key + AES-256-GCM) under an
 * OWNER-HELD passphrase that every one of the owner's devices supplies and that
 * never leaves them; the gist carries ciphertext plus the (public) pubkey only.
 * There is deliberately NO plaintext-publish fallback: without a passphrase
 * {@link publishOwnerHiveIdentity} refuses BEFORE any network call and sharing
 * no-ops for this boot, so the failure mode is "each device keeps its own identity",
 * never "the private key is readable by whoever learns the URL".
 *
 * The gh token is explicitly NOT usable as the sealing secret: it rotates, so a
 * token-derived key would strand every previously published blob.
 *
 * LEGACY: a v1 blob (plaintext, published before this fix) is still READ so an
 * existing owner keeps converging, and {@link fetchOwnerHiveIdentityRecord} reports
 * it as `legacyPlaintext` so the caller re-seals it in place — which is what
 * actually retires the exposure rather than only preventing new ones.
 *
 * Inputs (the gh token, the passphrase, the `fetch` impl) are injectable so unit
 * tests run with no network, no gh and no ambient secret.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const GIST_FILENAME = 'papercusp-hive-identity.json';
const GIST_DESCRIPTION =
  'Papercusp dogfood hive identity (per-owner, sealed) — managed by the Papercusp app; do not delete';
const GH_API = 'https://api.github.com';

/** scrypt work factors. Stored in the envelope so a future bump can still open old blobs. */
const KDF_N = 32768;
const KDF_R = 8;
const KDF_P = 1;
const KDF_KEYLEN = 32;
/** scrypt needs ~128*N*r bytes; N=32768,r=8 ⇒ ~33MB, above node's 32MB default. */
const KDF_MAXMEM = 64 * 1024 * 1024;

/**
 * Shortest passphrase accepted. A short passphrase is worse than none here: it looks
 * like protection while an offline attacker who has the ciphertext can grind it.
 */
export const MIN_IDENTITY_PASSPHRASE_LENGTH = 12;

/** The per-owner shared-hive identity, IN MEMORY. This shape is never written to a gist. */
export interface OwnerHiveIdentity {
  version: 1;
  /** Ed25519 PRIVATE key, DER bytes, base64 — injected into the keychain so all of
   *  the owner's devices share ONE hive identity (and thus one federation topic). */
  privateKeyDer: string;
  /** Raw-32 Ed25519 PUBLIC key, base64 — convenience/verification (derivable from
   *  the private key; stored so a reader can check without re-deriving). */
  pubkeyBase64: string;
  /** Directory invite secret (hex) — the owner's devices announce/discover on the
   *  same invite topic derived from it. */
  inviteSecret: string;
}

/**
 * What is ACTUALLY written to the gist: the public pubkey in the clear plus an
 * AES-256-GCM sealing of the two secrets. The pubkey is public by construction (the
 * baked canonical invite already ships it), so leaving it readable costs nothing and
 * lets a device compare identities without holding the passphrase.
 */
export interface SealedOwnerHiveIdentity {
  version: 2;
  pubkeyBase64: string;
  kdf: { alg: 'scrypt'; salt: string; N: number; r: number; p: number; keyLen: number };
  cipher: { alg: 'aes-256-gcm'; iv: string; authTag: string };
  /** base64 AES-256-GCM ciphertext of `{"privateKeyDer":…,"inviteSecret":…}`. */
  ciphertext: string;
}

type FetchImpl = typeof fetch;

function ghHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'papercusp-desktop',
  };
}

/** A passphrase usable for sealing — non-blank and long enough to resist offline grinding. */
export function isUsableIdentityPassphrase(passphrase: unknown): passphrase is string {
  return typeof passphrase === 'string' && passphrase.trim().length >= MIN_IDENTITY_PASSPHRASE_LENGTH;
}

/** Structural guard — a gist a user hand-edited (or a future-version blob) must not
 *  crash the bootstrap; an unrecognized shape is treated as "no identity yet". */
export function isOwnerHiveIdentity(v: unknown): v is OwnerHiveIdentity {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.privateKeyDer === 'string' &&
    o.privateKeyDer.length > 0 &&
    typeof o.pubkeyBase64 === 'string' &&
    o.pubkeyBase64.length > 0 &&
    typeof o.inviteSecret === 'string' &&
    o.inviteSecret.length > 0
  );
}

/** Structural guard for the sealed (v2) envelope. */
export function isSealedOwnerHiveIdentity(v: unknown): v is SealedOwnerHiveIdentity {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  if (o.version !== 2) return false;
  const kdf = o.kdf as Record<string, unknown> | undefined;
  const cipher = o.cipher as Record<string, unknown> | undefined;
  return (
    typeof o.pubkeyBase64 === 'string' &&
    o.pubkeyBase64.length > 0 &&
    typeof o.ciphertext === 'string' &&
    o.ciphertext.length > 0 &&
    !!kdf &&
    kdf.alg === 'scrypt' &&
    typeof kdf.salt === 'string' &&
    kdf.salt.length > 0 &&
    typeof kdf.N === 'number' &&
    typeof kdf.r === 'number' &&
    typeof kdf.p === 'number' &&
    typeof kdf.keyLen === 'number' &&
    !!cipher &&
    cipher.alg === 'aes-256-gcm' &&
    typeof cipher.iv === 'string' &&
    cipher.iv.length > 0 &&
    typeof cipher.authTag === 'string' &&
    cipher.authTag.length > 0
  );
}

function deriveKey(passphrase: string, salt: Buffer, kdf: SealedOwnerHiveIdentity['kdf']): Buffer {
  return scryptSync(passphrase.normalize('NFKC'), salt, kdf.keyLen, {
    N: kdf.N,
    r: kdf.r,
    p: kdf.p,
    maxmem: KDF_MAXMEM,
  });
}

/**
 * Seal an identity for publication. Returns null (never a plaintext fallback) when the
 * passphrase is unusable, so a caller cannot accidentally publish secrets in the clear.
 */
export function sealOwnerHiveIdentity(
  identity: OwnerHiveIdentity,
  passphrase: string,
): SealedOwnerHiveIdentity | null {
  if (!isOwnerHiveIdentity(identity) || !isUsableIdentityPassphrase(passphrase)) return null;
  try {
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const kdf: SealedOwnerHiveIdentity['kdf'] = {
      alg: 'scrypt',
      salt: salt.toString('base64'),
      N: KDF_N,
      r: KDF_R,
      p: KDF_P,
      keyLen: KDF_KEYLEN,
    };
    const key = deriveKey(passphrase, salt, kdf);
    const c = createCipheriv('aes-256-gcm', key, iv);
    const payload = JSON.stringify({
      privateKeyDer: identity.privateKeyDer,
      inviteSecret: identity.inviteSecret,
    });
    const ciphertext = Buffer.concat([c.update(payload, 'utf8'), c.final()]);
    return {
      version: 2,
      pubkeyBase64: identity.pubkeyBase64,
      kdf,
      cipher: { alg: 'aes-256-gcm', iv: iv.toString('base64'), authTag: c.getAuthTag().toString('base64') },
      ciphertext: ciphertext.toString('base64'),
    };
  } catch {
    return null;
  }
}

/** Open a sealed envelope. Returns null on a wrong passphrase, a tampered blob, or junk. */
export function openSealedOwnerHiveIdentity(
  sealed: SealedOwnerHiveIdentity,
  passphrase: string,
): OwnerHiveIdentity | null {
  if (!isSealedOwnerHiveIdentity(sealed) || !isUsableIdentityPassphrase(passphrase)) return null;
  try {
    const key = deriveKey(passphrase, Buffer.from(sealed.kdf.salt, 'base64'), sealed.kdf);
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.cipher.iv, 'base64'));
    d.setAuthTag(Buffer.from(sealed.cipher.authTag, 'base64'));
    const opened = Buffer.concat([
      d.update(Buffer.from(sealed.ciphertext, 'base64')),
      d.final(), // throws on a wrong key / tampered ciphertext — GCM is authenticated
    ]).toString('utf8');
    const parsed = JSON.parse(opened) as Record<string, unknown>;
    const identity: OwnerHiveIdentity = {
      version: 1,
      privateKeyDer: String(parsed.privateKeyDer ?? ''),
      pubkeyBase64: sealed.pubkeyBase64,
      inviteSecret: String(parsed.inviteSecret ?? ''),
    };
    return isOwnerHiveIdentity(identity) ? identity : null;
  } catch {
    return null;
  }
}

/** A gist list entry (the list API omits file content; `created_at` is used to pick
 *  the canonical duplicate deterministically). */
interface GistListEntry {
  id?: string;
  created_at?: string;
  files?: Record<string, unknown>;
}

/**
 * Find the owner's CANONICAL hive-identity gist id. Among every gist whose files
 * include the well-known filename, the OLDEST by `created_at` wins — a deterministic
 * choice every one of the owner's devices converges on, and the dedup key when
 * divergent duplicate gists exist (WI-867: 3+ `papercusp-hive-identity.json` gists
 * with *different* invite secrets, created by the old unconditional-POST publish on
 * "first device" races). Returns null when none match / on any failure.
 */
async function findCanonicalGistId(token: string, fetchImpl: FetchImpl): Promise<string | null> {
  const listRes = await fetchImpl(`${GH_API}/gists?per_page=100`, { headers: ghHeaders(token) });
  if (!listRes.ok) return null;
  const list = (await listRes.json()) as GistListEntry[];
  if (!Array.isArray(list)) return null;
  const matches = list.filter(
    (g) => g && g.id && g.files && Object.prototype.hasOwnProperty.call(g.files, GIST_FILENAME),
  );
  if (matches.length === 0) return null;
  // Oldest-first: `created_at` is ISO-8601 (lexicographic == chronological); tiebreak
  // on id so the ordering is total + stable even if `created_at` is ever missing.
  matches.sort((a, b) => {
    const ta = a.created_at ?? '';
    const tb = b.created_at ?? '';
    if (ta !== tb) return ta < tb ? -1 : 1;
    return (a.id ?? '') < (b.id ?? '') ? -1 : 1;
  });
  return matches[0]?.id ?? null;
}

/** What {@link fetchOwnerHiveIdentityRecord} resolved from the canonical gist. */
export interface OwnerHiveIdentityRecord {
  identity: OwnerHiveIdentity;
  /** The gist id it came from — so a caller can re-seal that exact blob in place. */
  gistId: string;
  /** True when the blob was a pre-fix v1 PLAINTEXT publish. The caller should re-seal
   *  it (publish again) to retire the live exposure, not merely adopt it. */
  legacyPlaintext: boolean;
}

/**
 * Fetch the owner's hive-identity from the CANONICAL gist (the oldest one holding the
 * well-known filename — so divergent duplicates resolve to ONE identity). Returns the
 * record, or null when absent / unopenable / on any failure. The gist LIST omits file
 * content, so the canonical gist is re-fetched by id to read the blob.
 *
 * A sealed (v2) blob needs the owner passphrase; a legacy (v1) plaintext blob does not
 * and is reported as `legacyPlaintext`.
 */
export async function fetchOwnerHiveIdentityRecord(
  token: string,
  passphrase: string | null,
  fetchImpl: FetchImpl = fetch,
): Promise<OwnerHiveIdentityRecord | null> {
  try {
    const gistId = await findCanonicalGistId(token, fetchImpl);
    if (!gistId) return null;

    const oneRes = await fetchImpl(`${GH_API}/gists/${gistId}`, { headers: ghHeaders(token) });
    if (!oneRes.ok) return null;
    const one = (await oneRes.json()) as { files?: Record<string, { content?: string }> };
    const content = one.files?.[GIST_FILENAME]?.content;
    if (!content) return null;

    const parsed = JSON.parse(content) as unknown;

    if (isSealedOwnerHiveIdentity(parsed)) {
      if (!isUsableIdentityPassphrase(passphrase)) return null; // sealed and we hold no key
      const identity = openSealedOwnerHiveIdentity(parsed, passphrase);
      return identity ? { identity, gistId, legacyPlaintext: false } : null;
    }

    // Legacy v1 plaintext: still adoptable so an existing owner keeps converging, and
    // flagged so the caller re-seals it in place.
    return isOwnerHiveIdentity(parsed) ? { identity: parsed, gistId, legacyPlaintext: true } : null;
  } catch {
    return null;
  }
}

/** Thin wrapper over {@link fetchOwnerHiveIdentityRecord} for callers that only want the identity. */
export async function fetchOwnerHiveIdentity(
  token: string,
  passphrase: string | null,
  fetchImpl: FetchImpl = fetch,
): Promise<OwnerHiveIdentity | null> {
  return (await fetchOwnerHiveIdentityRecord(token, passphrase, fetchImpl))?.identity ?? null;
}

/**
 * UPSERT the owner's hive-identity gist with a SEALED blob: PATCH the canonical gist in
 * place when one already exists (so the owner's devices converge on ONE blob and a
 * transient "first device" race can't fork a NEW divergent gist — the WI-867 root
 * cause), else POST a fresh one. Returns the gist id, or null on any failure.
 *
 * `passphrase` is REQUIRED and checked BEFORE any network call: without a usable one
 * this refuses outright rather than falling back to a plaintext publish (WI-2147371).
 * A null return therefore means "sharing no-ops this boot" — each device keeps its own
 * identity — which is the correct degradation. Best-effort; never throws.
 */
export async function publishOwnerHiveIdentity(
  token: string,
  identity: OwnerHiveIdentity,
  passphrase: string,
  fetchImpl: FetchImpl = fetch,
): Promise<{ gistId: string } | null> {
  const sealed = sealOwnerHiveIdentity(identity, passphrase);
  if (!sealed) return null; // no usable passphrase / malformed identity → never publish
  try {
    const existingId = await findCanonicalGistId(token, fetchImpl);
    const res = await fetchImpl(existingId ? `${GH_API}/gists/${existingId}` : `${GH_API}/gists`, {
      method: existingId ? 'PATCH' : 'POST',
      headers: { ...ghHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        // `public` is honored only on create; PATCH can't change visibility. Unlisted is
        // defence in depth ONLY — the sealing above is what actually protects the blob.
        description: GIST_DESCRIPTION,
        public: false,
        files: { [GIST_FILENAME]: { content: JSON.stringify(sealed, null, 2) } },
      }),
    });
    if (!res.ok) return null;
    const saved = (await res.json()) as { id?: string };
    const gistId = saved.id ?? existingId;
    return gistId ? { gistId } : null;
  } catch {
    return null;
  }
}

/** Constant-time compare of two base64 pubkeys (used by callers verifying convergence). */
export function samePubkey(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'base64');
  const bb = Buffer.from(b, 'base64');
  return ba.length === bb.length && ba.length > 0 && timingSafeEqual(ba, bb);
}

/** Exposed for tests + callers that need the canonical filename/description. */
export const __OWNER_GIST_FILENAME = GIST_FILENAME;
export const __OWNER_GIST_DESCRIPTION = GIST_DESCRIPTION;
