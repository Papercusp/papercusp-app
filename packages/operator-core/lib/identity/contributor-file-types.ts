/**
 * contributor-file-types — types for the Channel 2 contributor file
 * pushed to `user/<github_user_id>` branches as part of two-channel
 * binding (papercusp-dogfood-v5 §0.2.7 + Phase 1b P-075).
 *
 * Resolves Phase 1b Q-2 ("Channel 2's `.papercusp/contributors/<github_login>.json`
 * — what's the canonical-form serialization?") at the type level: the
 * serialization is JCS (JSON Canonicalization Scheme, RFC 8785) and
 * the field order is fixed by the const tuple below.
 *
 * Sources from `papercusp-dogfood-v5-2026-05-23.md` §0.2.7 +
 * `dogfood-design-memo-two-channel-binding-ux-2026-05-24.md`
 * (re-verification behavior + grace-window UX).
 *
 * Types-only — no I/O, no `git fetch`, no Octokit, no JCS bytes.
 * The runtime impl that lands when P-075's two-channel-verifier ships
 * imports these types verbatim; the JCS byte-encoder is its concern.
 *
 * Same pattern as:
 *   - apps/operator/lib/harness/binding-types.ts            (P-068)
 *   - apps/operator/lib/identity/binding-verifier-types.ts  (P-075)
 *   - apps/operator/lib/identity/attestation-types.ts       (P-011)
 *
 * Together these four types-only modules form the complete spine of
 * Phase 1b's identity surface.
 */

/**
 * Wire-version of the contributor file body shape. Bump when adding
 * fields. Verifiers MUST reject files with an unknown version rather
 * than silently mis-canonicalize.
 */
export const CONTRIBUTOR_FILE_VERSION = 1 as const;
export type ContributorFileVersion = typeof CONTRIBUTOR_FILE_VERSION;

/**
 * The canonical field-order tuple for `ContributorFileBody`. Implements
 * Q-2's chosen serialization (JCS / RFC 8785). JCS specifies ascending
 * Unicode code-point order on object keys; this tuple matches that
 * order exactly so a hand-implemented serializer can iterate it
 * without re-sorting. Exported so the publish + verify paths share one
 * authoritative ordering — diverging here breaks signatures silently.
 *
 * Source: `papercusp-dogfood-v5-2026-05-23.md` §0.2.7 + RFC 8785 §3.2.
 */
export const CONTRIBUTOR_FILE_CANONICAL_FIELD_ORDER = [
  'device_attestation_gist_id',
  'device_pubkey',
  'github_login',
  'github_user_id',
  'joined_at',
  'signature_by_device',
  'version',
] as const;

/**
 * The body of the contributor file pushed to
 * `.papercusp/contributors/<github_login>.json` on the contributor's
 * `user/<github_user_id>` branch.
 *
 * The signature scope per §0.2.7 is the JCS-canonical serialization of
 * EVERY field EXCEPT `signature_by_device` itself — implementations
 * compute the bytes by serializing the body with `signature_by_device`
 * omitted, signing those bytes, then injecting the signature.
 */
export interface ContributorFileBody {
  /** Schema version of this body shape. */
  version: ContributorFileVersion;
  /** Stable numeric GitHub user id (NOT login — login renames over
   * time and we key off the immutable id). */
  github_user_id: number;
  /** GitHub login at time of file commit. Display-only inside the
   * file body; the trust path that proves the login is the
   * GitHub-verified commit author (see Channel 2 spec). */
  github_login: string;
  /** Ed25519 device public key in the form `ed25519:<base64url>`.
   * Same byte material as `AttestationGistBody.device_pubkey` but
   * algorithm-tagged here for forward compatibility (a future Ed448
   * key would carry `ed448:` etc.). */
  device_pubkey: string;
  /** The gist id from Channel 1's `AttestationGistBody`. Lets
   * verifiers cross-reference both channels' attestation material
   * without re-fetching the gist on every contributor-file check. */
  device_attestation_gist_id: string;
  /** ISO-8601 timestamp of join. Tolerant clients SHOULD accept any
   * RFC 3339 time string; canonical writers SHOULD emit `Z` UTC. */
  joined_at: string;
  /** Base64url Ed25519 signature over the JCS-canonical serialization
   * of all other fields (this field omitted). */
  signature_by_device: string;
}

/**
 * Tag prefix on `device_pubkey` per spec. A future expansion adds new
 * algorithm tags; verifiers reject unknown prefixes.
 */
export const SUPPORTED_DEVICE_PUBKEY_ALGORITHMS = ['ed25519'] as const;
export type SupportedDevicePubkeyAlgorithm =
  (typeof SUPPORTED_DEVICE_PUBKEY_ALGORITHMS)[number];

/**
 * Parsed result for an algorithm-tagged `device_pubkey` string. Pure
 * splitter — callers handle base64url decoding themselves.
 */
export interface ParsedDevicePubkey {
  alg: SupportedDevicePubkeyAlgorithm;
  /** The bytes-as-base64url portion (everything after the colon). */
  keyBase64Url: string;
}

/**
 * Split `device_pubkey` into its algorithm tag and key bytes. Returns
 * `null` for any malformed input — including unknown algorithm tags
 * (verifiers reject these as `device_pubkey_invalid`).
 */
export function parseDevicePubkeySpec(spec: string): ParsedDevicePubkey | null {
  if (typeof spec !== 'string') return null;
  const idx = spec.indexOf(':');
  if (idx <= 0 || idx === spec.length - 1) return null;
  const alg = spec.slice(0, idx);
  const key = spec.slice(idx + 1);
  if (!SUPPORTED_DEVICE_PUBKEY_ALGORITHMS.includes(alg as SupportedDevicePubkeyAlgorithm)) {
    return null;
  }
  // Reject obviously-malformed base64url (any char outside the RFC 4648 §5
  // alphabet). Final decode is the verifier's job; we only do shape.
  if (!/^[A-Za-z0-9_-]+$/.test(key)) return null;
  return { alg: alg as SupportedDevicePubkeyAlgorithm, keyBase64Url: key };
}

/**
 * Build an algorithm-tagged `device_pubkey` string from parts. Inverse
 * of `parseDevicePubkeySpec`. Caller is responsible for supplying a
 * valid base64url key — this is a string concatenator, not a validator.
 */
export function formatDevicePubkeySpec(
  alg: SupportedDevicePubkeyAlgorithm,
  keyBase64Url: string,
): string {
  return alg + ':' + keyBase64Url;
}

/**
 * Repo-relative path for a contributor file. Single source of truth so
 * publish + verify paths cannot drift.
 *
 *   contributorFilePath("alice") => ".papercusp/contributors/alice.json"
 *
 * NOTE: This is a path-builder, not a sanitizer — callers must have
 * already validated `githubLogin` against GitHub's username rules
 * (alphanumeric + dashes, ≤ 39 chars). Verifiers re-check the segment
 * for path-escape attempts; see `assertSafeGithubLoginSegment`.
 */
export const CONTRIBUTORS_DIR = '.papercusp/contributors' as const;
export function contributorFilePath(githubLogin: string): string {
  return CONTRIBUTORS_DIR + '/' + githubLogin + '.json';
}

/**
 * Branch-name derivation per D-010: numeric `user/<github_user_id>`.
 * The login is intentionally not in the branch name — logins can
 * rename, ids cannot. Single source of truth so the create-branch +
 * verify-branch paths cannot drift.
 *
 *   contributorBranchRef(12345) => "user/12345"
 */
export function contributorBranchRef(githubUserId: number): string {
  if (!Number.isInteger(githubUserId) || githubUserId <= 0) {
    throw new TypeError('githubUserId must be a positive integer');
  }
  return 'user/' + githubUserId;
}

/**
 * Reject login segments that would escape the contributors dir. GitHub
 * logins are alphanumeric + dashes, max 39 chars, no consecutive dashes,
 * no leading/trailing dash (§ "Username may only contain alphanumeric
 * characters or single hyphens, and cannot begin or end with a hyphen").
 *
 * Returns `true` if safe to use as a path segment; `false` otherwise.
 * Verifier callers use this BEFORE building paths from untrusted inputs.
 */
export const GITHUB_LOGIN_MAX_LENGTH = 39;
export function isSafeGithubLoginSegment(seg: string): boolean {
  if (typeof seg !== 'string') return false;
  if (seg.length === 0 || seg.length > GITHUB_LOGIN_MAX_LENGTH) return false;
  if (seg.startsWith('-') || seg.endsWith('-')) return false;
  if (seg.includes('--')) return false;
  return /^[A-Za-z0-9-]+$/.test(seg);
}

/**
 * Outcome of `verifyContributorFile()` per §0.2.7 "Both channels MUST
 * pass" — channel-2-side verdict only. The two-channel aggregator
 * (binding-verifier-types) combines this with the channel-1 result.
 */
export interface Channel2VerificationResult {
  valid: boolean;
  reason?: Channel2FailureReason;
  /** Epoch ms when verification ran. */
  verifiedAt: number;
  /** SHA of the GitHub-verified commit that pushed the file. Populated
   * on success; lets callers cross-reference with the contributor row
   * + render "verified at <commit-link>" in the UI. */
  commitSha?: string;
  /** GitHub commit `verification.reason` field on failure — surfaces
   * "unknown_key", "expired_key", "unsigned", etc. directly to the
   * UI without translation. */
  githubVerificationReason?: string;
}

export type Channel2FailureReason =
  /** The user branch doesn't exist on the remote. */
  | 'branch_not_found'
  /** Branch exists but the contributor file doesn't. */
  | 'contributor_file_not_found'
  /** File body doesn't match `ContributorFileBody` shape. */
  | 'contributor_file_body_invalid'
  /** Login segment in the file path is unsafe (path-escape attempt). */
  | 'login_segment_unsafe'
  /** `device_pubkey` field is malformed or uses an unknown algorithm. */
  | 'device_pubkey_invalid'
  /** `signature_by_device` fails Ed25519 verification against
   * `device_pubkey`. Forgery indicator. */
  | 'signature_invalid'
  /** Body fields don't match what the verifier expects (e.g.
   * github_user_id ≠ the user we asked about). */
  | 'identity_mismatch'
  /** `GET /repos/.../commits/<sha>` returned `verification.verified
   * === false` — GitHub did not stamp the commit as verified. */
  | 'commit_not_verified_by_github'
  /** `author.login` on the commit doesn't match the contributor's
   * claimed login (file body could be forged with a bad login). */
  | 'commit_author_login_mismatch'
  /** GitHub API rate-limited or unreachable. Transient. */
  | 'github_api_unavailable'
  /** Local git fetch failed (network, auth, etc.). Transient. */
  | 'git_fetch_failed';

/**
 * Structural predicate for `ContributorFileBody`. Verifies every
 * required field is present + typed correctly. Does NOT verify
 * signature or external consistency — that's the verifier's job.
 */
export function isContributorFileBody(input: unknown): input is ContributorFileBody {
  if (input === null || typeof input !== 'object') return false;
  const b = input as Record<string, unknown>;
  return (
    b.version === CONTRIBUTOR_FILE_VERSION &&
    typeof b.github_user_id === 'number' &&
    Number.isInteger(b.github_user_id) &&
    b.github_user_id > 0 &&
    typeof b.github_login === 'string' &&
    b.github_login.length > 0 &&
    typeof b.device_pubkey === 'string' &&
    b.device_pubkey.length > 0 &&
    typeof b.device_attestation_gist_id === 'string' &&
    b.device_attestation_gist_id.length > 0 &&
    typeof b.joined_at === 'string' &&
    b.joined_at.length > 0 &&
    typeof b.signature_by_device === 'string' &&
    b.signature_by_device.length > 0
  );
}

/**
 * `pending` grace-window per §0.2.7 ("up to 24h while the branch may still be
 * propagating"). 24h window. (The two-channel binding state machine that used
 * to share this constant was removed by non-collaborator-join-fork-pr-2026-06-02.)
 */
export const CHANNEL2_PROPAGATION_GRACE_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h
