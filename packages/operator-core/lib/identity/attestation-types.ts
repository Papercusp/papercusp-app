/**
 * attestation-types — types for device-binding attestation via
 * GitHub Gist (papercusp-dogfood-v5 §0.2 + Phase 1b P-011).
 *
 * Sources from `dogfood-design-memo-device-attestation-ux-2026-05-24.md`.
 * Types-only — no I/O, no Octokit calls, no keychain access.
 *
 * Same types-first pattern as `binding-types.ts` (P-068) and
 * `binding-verifier-types.ts` (P-075) — ships the wire-shapes now
 * so P-011's runtime can land cleanly when the memo is accepted.
 *
 * When P-011 implementation begins:
 *   - apps/operator/lib/identity/attest.ts imports these types
 *   - apps/operator/lib/identity/keychain.ts uses Ed25519Keypair
 *   - apps/operator/app/_components/AttestationWizard.tsx renders
 *     the 3-screen modal per memo §"The modal"
 */

/**
 * Required GitHub OAuth scopes for the attestation flow per memo §1.
 * `gist` to publish the binding gist; `read:user` to confirm the
 * github_user_id matches the OAuth subject.
 *
 * One-shot scope request per memo Q-1 (both up front, not progressive).
 */
export const ATTESTATION_OAUTH_SCOPES = ['gist', 'read:user'] as const;
export type AttestationOauthScope = (typeof ATTESTATION_OAUTH_SCOPES)[number];

/**
 * Ed25519 keypair representation. The private key NEVER leaves the
 * OS keychain — this type carries only the BASE64-encoded public
 * material + a stable id for keychain lookup.
 *
 * The full keypair only ever materializes inside `keychain.ts`
 * during attestation creation; downstream surfaces (gist publish,
 * verifier) work only with the pubkey + signature output.
 */
export interface DeviceKeypairId {
  /** Stable id used for OS-keychain lookup. Derived from
   * `<github_user_id>:<machine-fingerprint>` so a multi-account
   * machine can hold one keypair per GitHub identity. */
  keychainId: string;
  /** Ed25519 public key, base64-encoded (44 chars incl. padding). */
  pubkeyBase64: string;
}

/**
 * The body of the device-binding gist published to the user's
 * GitHub account. The gist's filename convention per memo:
 * `papercusp-device-binding-<pubkey-prefix>.json` where
 * pubkey-prefix is the first 8 chars of pubkeyBase64.
 *
 * Field order matters for signature canonicalization (see Phase 1b
 * Q-2: JCS / RFC 8785). Implementations MUST serialize in this exact
 * order before signing + before verifying.
 */
export interface AttestationGistBody {
  /** Schema version of this body shape. Bump when adding fields. */
  version: 1;
  /** The Ed25519 device public key being attested, base64. */
  device_pubkey: string;
  /** User-supplied or auto-derived device label
   * (e.g. "alice-macbook-pro"). Up to 80 chars. */
  device_label: string;
  /** Stable numeric GitHub user id (NOT login — login renames). */
  github_user_id: number;
  /** GitHub login at attestation time. Display-only; verifiers
   * key off github_user_id. */
  github_login: string;
  /** Epoch milliseconds when the gist was created. */
  created_at: number;
  /** Ed25519 signature over the canonical-JCS serialization of all
   * preceding fields, base64. Self-signing — proves the device
   * controls the private key matching device_pubkey. */
  signature_by_device: string;
}

/**
 * Outcome of `verifyAttestation()` per memo §"Verifier helper".
 * The `valid` flag is the binary verdict; `reason` carries
 * structured detail for the UI.
 */
export interface AttestationVerificationResult {
  valid: boolean;
  reason?: AttestationFailureReason;
  /** Epoch ms when the verification ran — drives the 24h cache. */
  verifiedAt: number;
  /** Resolved gist owner's github_user_id, populated on success.
   * Lets callers cross-reference with the contributor row. */
  resolvedGithubUserId?: number;
}

export type AttestationFailureReason =
  /** Gist 404 — was deleted, was never published, or is private. */
  | 'gist_not_found'
  /** Gist body doesn't match AttestationGistBody shape (missing
   * required fields, wrong version, malformed). */
  | 'gist_body_invalid'
  /** Gist.owner.id doesn't match the gist body's github_user_id.
   * Forgery indicator. */
  | 'github_user_id_mismatch'
  /** signature_by_device fails Ed25519 verification against
   * device_pubkey. Forgery indicator. */
  | 'signature_invalid'
  /** The claimed_pubkey passed to verifyAttestation doesn't match
   * the gist body's device_pubkey. Caller-side type confusion. */
  | 'pubkey_mismatch'
  /** Device pubkey appears in the contributor's revoked list. */
  | 'pubkey_revoked'
  /** GitHub API rate-limited or unreachable. Transient — cache
   * miss + retry, not a forgery signal. */
  | 'github_api_unavailable';

/**
 * Default cache TTL for verified attestations per memo §"Cache
 * hit/miss" (24h). Verifier helpers cache successful verifications
 * for this duration.
 */
export const ATTESTATION_VERIFY_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

/**
 * Cache TTL for conclusive negative verification results. A short TTL
 * collapses repeated reads of known-invalid duplicate gists while keeping
 * an invalid → valid transition bounded to one minute. Inconclusive API
 * failures are never cached (see `github_api_unavailable`).
 */
export const ATTESTATION_VERIFY_NEGATIVE_CACHE_TTL_MS = 60 * 1000; // 60s

/**
 * Gist filename convention. Exported so the publish + verify paths
 * use one source of truth.
 *
 * The prefix is mapped to the URL/filename-safe base64 alphabet
 * (`+`→`-`, `/`→`_`): a GitHub gist filename CANNOT contain `/`, and a raw
 * base64 pubkey prefix contains `/` ~11% of the time (and `+` ~12%), so
 * without this `createAttestationGist` 422s ("Validation Failed: files
 * invalid") for ~1-in-9 devices and they can never publish their binding.
 * (Surfaced by the live two-identity P-079 acceptance run, 2026-06-01.)
 * Both publish + verify call this, so the mapping stays consistent; the
 * substitution is a bijection on those positions (no collisions).
 *
 * Example: pubkeyBase64="ab/d+234..." → "papercusp-device-binding-ab_d-234.json"
 */
export function attestationGistFilename(pubkeyBase64: string): string {
  const prefix = pubkeyBase64.slice(0, 8).replace(/\+/g, '-').replace(/\//g, '_');
  return 'papercusp-device-binding-' + prefix + '.json';
}

/**
 * Validate that the OAuth scope set returned by GitHub includes
 * everything attestation needs. Memo §"Error states" requires
 * graceful failure if user grants only `read:user`.
 */
export function hasAllAttestationScopes(grantedScopes: ReadonlySet<string>): boolean {
  return ATTESTATION_OAUTH_SCOPES.every((s) => grantedScopes.has(s));
}

/**
 * Return the list of attestation scopes the user is missing.
 * Drives the "re-prompt OAuth with explicit scope request" copy
 * from memo §"Error states".
 */
export function missingAttestationScopes(grantedScopes: ReadonlySet<string>): AttestationOauthScope[] {
  return ATTESTATION_OAUTH_SCOPES.filter((s) => !grantedScopes.has(s));
}

/**
 * Default-device-label derivation per memo §"Default device label":
 *   `<system-hostname>-<system-username>` if both available
 *   → `<system-hostname>` if only hostname
 *   → `papercusp-<random-6-char>` as fallback
 *
 * Pure function for testability — caller supplies the inputs
 * (hostname / username / random-source).
 */
export function deriveDefaultDeviceLabel(input: {
  hostname?: string;
  username?: string;
  randomFallback: string; // a 6-char fallback the caller generates
}): string {
  const h = (input.hostname ?? '').trim();
  const u = (input.username ?? '').trim();
  if (h && u) return h + '-' + u;
  if (h) return h;
  return 'papercusp-' + input.randomFallback;
}

/**
 * Clamp a device label to the published-byte budget (memo: ≤80
 * chars). Exported so the publish + UI paths agree on the limit.
 */
export const DEVICE_LABEL_MAX_LENGTH = 80;
export function clampDeviceLabel(raw: string): string {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  if (trimmed.length <= DEVICE_LABEL_MAX_LENGTH) return trimmed;
  return trimmed.slice(0, DEVICE_LABEL_MAX_LENGTH);
}
