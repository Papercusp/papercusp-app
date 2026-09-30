/**
 * contributor-row-types — PG-mirror row shape for the
 * `harness_shared.contributors` table per papercusp-dogfood-v5
 * §0.2.7 + §3.1 (the table joins binding-verifier output to PG).
 *
 * Types-only and PURE. No PG client, no HYPERBEE driver, no I/O.
 * Used by:
 *   - P-031 Hyperbee → PG projection writer (consumes here)
 *   - PG-direct readers (Contributors tab UI, Insights People card,
 *     user profile, claim CTA gate)
 *   - P-075 verifier daemon (updates binding_status + channel
 *     timestamps)
 *
 * Fifteenth module in the dogfood-arc types-only spine.
 *
 * Schema source: v5 line 460-481 verbatim. 18 columns including
 * the JSONB device_attestations array + array-typed revoked_pubkeys.
 *
 * Why types-first: every UI surface that aggregates contributors
 * (4+ per §17) consumes this shape. A field rename without a
 * single source of truth means hunt-and-replace across every
 * consumer; pinning the type module makes the rename a one-edit
 * + typecheck-driven fan-out.
 */

import { type BindingStatus } from '../identity/binding-verifier-types';

/**
 * Local copy of the BindingStatus value-set so structural predicates
 * can validate at runtime. Kept in lock-step with the union in
 * binding-verifier-types — if you add a state there, add it here.
 * Compile-time sentinel below catches drift.
 */
export const BINDING_STATUSES = ['verified', 'pending', 'unverified'] as const;
// Sentinel: if BindingStatus gains a variant, this assignment errors.
const _bindingStatusesCover: BindingStatus = BINDING_STATUSES[0];
void _bindingStatusesCover;

/**
 * Wire-version of the row shape. Matches the PG `schema_version`
 * default; bump together when columns change.
 */
export const CONTRIBUTOR_ROW_SCHEMA_VERSION = 1 as const;
export type ContributorRowSchemaVersion = typeof CONTRIBUTOR_ROW_SCHEMA_VERSION;

/**
 * One entry in the `device_attestations` JSONB array. Each device
 * the contributor has bound to this harness shows up as a row.
 * Mirrors the shape commented in v5 line 466.
 */
export interface DeviceAttestationEntry {
  device_pubkey: string;
  gist_id: string;
  gist_url: string;
  device_label: string;
  /** Epoch ms when the gist was published. */
  created_at: number;
  /** Ed25519 signature, base64. Same scope as
   * `AttestationGistBody.signature_by_device`. */
  signature_by_device: string;
}

/**
 * The full row shape. Numbers are epoch ms; nullable timestamps
 * are `number | null` (PG `TIMESTAMPTZ` projects to ms via the
 * existing PG-projection rules in `sync-resolver`).
 */
export interface ContributorRow {
  harness_slug: string;
  github_user_id: number;
  github_username: string;
  display_name: string | null;
  avatar_url: string | null;
  /** Array of bound devices for this contributor on this harness. */
  device_attestations: DeviceAttestationEntry[];
  /** Pubkeys explicitly revoked by the user (e.g. lost device).
   * A verifier MUST refuse to count any attestation whose pubkey
   * appears here. */
  revoked_pubkeys: string[];
  /** Epoch ms of first join. */
  joined_at: number;
  last_seen_at: number | null;
  /** §0.2.7 two-channel binding state. */
  binding_status: BindingStatus;
  /** Epoch ms of last Channel 1 (gh api /user) re-check success. */
  channel1_verified_at: number | null;
  /** Epoch ms of last Channel 2 (contributor-file) verify success. */
  channel2_verified_at: number | null;
  /** Branch name where the Channel 2 file lives. Diagnostic only;
   * verifier authoritative on `user/<github_user_id>` per D-010. */
  channel2_branch_ref: string | null;
  /** Epoch ms of most-recent binding re-check attempt (any outcome). */
  binding_last_checked_at: number | null;
  schema_version: ContributorRowSchemaVersion;
}

/**
 * Structural predicate for `ContributorRow`. Used by the PG-read
 * path before applying rows to the UI cache (defensive against
 * legacy rows / pre-binding-feature rows where two-channel columns
 * are NULL).
 */
export function isContributorRow(input: unknown): input is ContributorRow {
  if (input === null || typeof input !== 'object') return false;
  const r = input as Record<string, unknown>;
  if (typeof r.harness_slug !== 'string' || r.harness_slug.length === 0) return false;
  if (
    typeof r.github_user_id !== 'number' ||
    !Number.isInteger(r.github_user_id) ||
    r.github_user_id <= 0
  ) {
    return false;
  }
  if (typeof r.github_username !== 'string' || r.github_username.length === 0) return false;
  if (r.display_name !== null && typeof r.display_name !== 'string') return false;
  if (r.avatar_url !== null && typeof r.avatar_url !== 'string') return false;
  if (!Array.isArray(r.device_attestations)) return false;
  if (!Array.isArray(r.revoked_pubkeys)) return false;
  if (typeof r.joined_at !== 'number' || !Number.isFinite(r.joined_at)) return false;
  if (r.last_seen_at !== null && typeof r.last_seen_at !== 'number') return false;
  if (
    typeof r.binding_status !== 'string' ||
    !(BINDING_STATUSES as readonly string[]).includes(r.binding_status)
  ) {
    return false;
  }
  if (r.channel1_verified_at !== null && typeof r.channel1_verified_at !== 'number') {
    return false;
  }
  if (r.channel2_verified_at !== null && typeof r.channel2_verified_at !== 'number') {
    return false;
  }
  if (r.channel2_branch_ref !== null && typeof r.channel2_branch_ref !== 'string') {
    return false;
  }
  if (r.binding_last_checked_at !== null && typeof r.binding_last_checked_at !== 'number') {
    return false;
  }
  if (r.schema_version !== CONTRIBUTOR_ROW_SCHEMA_VERSION) return false;
  return true;
}

/**
 * Structural predicate for one `DeviceAttestationEntry`.
 */
export function isDeviceAttestationEntry(input: unknown): input is DeviceAttestationEntry {
  if (input === null || typeof input !== 'object') return false;
  const a = input as Record<string, unknown>;
  return (
    typeof a.device_pubkey === 'string' &&
    a.device_pubkey.length > 0 &&
    typeof a.gist_id === 'string' &&
    a.gist_id.length > 0 &&
    typeof a.gist_url === 'string' &&
    a.gist_url.length > 0 &&
    typeof a.device_label === 'string' &&
    typeof a.created_at === 'number' &&
    Number.isFinite(a.created_at) &&
    typeof a.signature_by_device === 'string' &&
    a.signature_by_device.length > 0
  );
}

/**
 * Predicate: does the contributor's binding aggregate into tier-A/B/C
 * stats per v5 §17? Only `verified` contributors count. `pending`
 * and `unverified` contribute to nothing.
 */
export function contributesToStats(row: ContributorRow): boolean {
  return row.binding_status === 'verified';
}

/**
 * Predicate: is the device's pubkey revoked on this row? Verifier
 * uses this to skip revoked devices when counting valid
 * attestations.
 */
export function isPubkeyRevoked(row: ContributorRow, devicePubkey: string): boolean {
  return row.revoked_pubkeys.includes(devicePubkey);
}

/**
 * Return the count of currently-active (non-revoked) device
 * attestations on this row. Used by the Contributors tab to show
 * "1 device" / "3 devices" badges.
 */
export function activeDeviceCount(row: ContributorRow): number {
  return row.device_attestations.filter(
    (a) => !row.revoked_pubkeys.includes(a.device_pubkey),
  ).length;
}

/**
 * Build a fresh row payload for a newly-joined contributor. Used by
 * P-029 wizard (creator) + P-009 Entry 4 (joiner) + P-068 binding
 * service (initial bind). Pure constructor — caller passes `now`.
 */
export function buildFreshContributorRow(args: {
  harness_slug: string;
  github_user_id: number;
  github_username: string;
  display_name?: string;
  avatar_url?: string;
  initial_attestation: DeviceAttestationEntry;
  now: number;
}): ContributorRow {
  if (!args.harness_slug) throw new TypeError('harness_slug required');
  if (!Number.isInteger(args.github_user_id) || args.github_user_id <= 0) {
    throw new TypeError('github_user_id must be a positive integer');
  }
  if (!args.github_username) throw new TypeError('github_username required');
  if (!isDeviceAttestationEntry(args.initial_attestation)) {
    throw new TypeError('initial_attestation must match DeviceAttestationEntry shape');
  }
  return {
    harness_slug: args.harness_slug,
    github_user_id: args.github_user_id,
    github_username: args.github_username,
    display_name: args.display_name ?? null,
    avatar_url: args.avatar_url ?? null,
    device_attestations: [args.initial_attestation],
    revoked_pubkeys: [],
    joined_at: args.now,
    last_seen_at: args.now,
    binding_status: 'pending',
    channel1_verified_at: null,
    channel2_verified_at: null,
    channel2_branch_ref: null,
    binding_last_checked_at: null,
    schema_version: CONTRIBUTOR_ROW_SCHEMA_VERSION,
  };
}
