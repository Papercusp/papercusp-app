/**
 * harness-shared-config-types — types for the
 * `.papercusp/shared.json` committed file written by Phase 5a P-029
 * wizard per papercusp-dogfood-v5 line 337.
 *
 * Types-only and PURE. No fs, no JSON-write, no git. The wizard
 * runtime (when P-029 lands) imports these to shape the write +
 * subsequent reads from join + bootstrap paths.
 *
 * Fourteenth module in the dogfood-arc types-only spine.
 *
 * Per v5 line 337 the file body is:
 *   { topic, github_remote, github_repository_id, claim_status,
 *     discord_channel?, privacy, created_at, schema_version }
 *
 * This file is committed to git (every contributor sees the same
 * content), so the JCS-ascending field-order const lets a future
 * canonicalizer round-trip the file without diff churn on re-save.
 */

import {
  CUPBOARD_CLAIM_STATUSES,
  type CupboardClaimStatus,
} from '../cupboard/types';

/**
 * Wire-version of the file body. Bump if columns change. Readers
 * reject unknown versions to fail fast on client-older-than-file
 * mismatch.
 */
export const HARNESS_SHARED_CONFIG_SCHEMA_VERSION = 1 as const;
export type HarnessSharedConfigSchemaVersion =
  typeof HARNESS_SHARED_CONFIG_SCHEMA_VERSION;

/**
 * Privacy levels per v5 §0.5. shared-private = repo-link or
 * harness-link required; shared-public = additionally listed on
 * the Cupboard. (Local-only "private" doesn't get a shared.json
 * file at all.)
 */
export const HARNESS_SHARED_PRIVACY_LEVELS = ['shared-private', 'shared-public'] as const;
export type HarnessSharedPrivacy = (typeof HARNESS_SHARED_PRIVACY_LEVELS)[number];

/**
 * JCS-ascending field order per RFC 8785 §3.2. Used by the writer
 * to produce stable byte content (no diff churn on re-save) and
 * by future verifiers that need to hash the file for tamper
 * detection.
 */
export const HARNESS_SHARED_CONFIG_FIELD_ORDER = [
  'claim_status',
  'created_at',
  'discord_channel',
  'github_remote',
  'github_repository_id',
  'privacy',
  'schema_version',
  'topic',
] as const;

/**
 * The shape of `.papercusp/shared.json`. `discord_channel` is the
 * single optional field — present only when the harness has been
 * wired to a Discord channel via the §10 wizard.
 */
export interface HarnessSharedConfig {
  /** Hyperswarm topic as 64-char lowercase hex string (32 bytes).
   * Same shape as `harness-link-types.ts` `topic`. */
  topic: string;
  /** Git remote URL — typically
   * `git@github.com:<owner>/<repo>.git` or the HTTPS variant. */
  github_remote: string;
  /** Stable numeric GitHub repository id. Immutable across rename. */
  github_repository_id: number;
  /** Initial Cupboard claim status. New harnesses start `unclaimed`. */
  claim_status: CupboardClaimStatus;
  /** Optional Discord channel binding (e.g. `'#engineering'`). */
  discord_channel?: string;
  /** Privacy level. */
  privacy: HarnessSharedPrivacy;
  /** Epoch ms when this file was first written. Never updated on
   * subsequent saves (use git history for change tracking). */
  created_at: number;
  /** Schema version of this body shape. */
  schema_version: HarnessSharedConfigSchemaVersion;
}

/**
 * The relative path inside a repo where this file lives. Single
 * source of truth so writer + readers cannot drift.
 */
export const HARNESS_SHARED_CONFIG_REL_PATH = '.papercusp/shared.json' as const;

/**
 * Structural predicate. Verifies required fields are present +
 * typed. Used by every reader (join, bootstrap, verifier daemon)
 * defensively against file corruption or schema drift.
 */
export function isHarnessSharedConfig(input: unknown): input is HarnessSharedConfig {
  if (input === null || typeof input !== 'object') return false;
  const r = input as Record<string, unknown>;
  if (typeof r.topic !== 'string' || !/^[0-9a-f]{64}$/.test(r.topic)) return false;
  if (typeof r.github_remote !== 'string' || r.github_remote.length === 0) return false;
  if (
    typeof r.github_repository_id !== 'number' ||
    !Number.isInteger(r.github_repository_id) ||
    r.github_repository_id <= 0
  ) {
    return false;
  }
  if (
    typeof r.claim_status !== 'string' ||
    !(CUPBOARD_CLAIM_STATUSES as readonly string[]).includes(r.claim_status)
  ) {
    return false;
  }
  if (r.discord_channel !== undefined && typeof r.discord_channel !== 'string') {
    return false;
  }
  if (
    typeof r.privacy !== 'string' ||
    !(HARNESS_SHARED_PRIVACY_LEVELS as readonly string[]).includes(r.privacy)
  ) {
    return false;
  }
  if (typeof r.created_at !== 'number' || !Number.isFinite(r.created_at) || r.created_at <= 0) {
    return false;
  }
  if (r.schema_version !== HARNESS_SHARED_CONFIG_SCHEMA_VERSION) return false;
  return true;
}

/**
 * Compose a stable display key for a harness from its shared
 * config. Format: `<github_repository_id>@<topic-first-8>` —
 * keeps human-readable diagnostics short while still uniquely
 * identifying the harness.
 */
export function composeHarnessConfigKey(config: HarnessSharedConfig): string {
  return config.github_repository_id + '@' + config.topic.slice(0, 8);
}

/**
 * Predicate: is this config currently eligible for Cupboard
 * listing? Currently: privacy is `shared-public` AND claim_status
 * is not `superseded` or `stale`.
 */
export function isCupboardEligible(config: HarnessSharedConfig): boolean {
  if (config.privacy !== 'shared-public') return false;
  if (config.claim_status === 'superseded' || config.claim_status === 'stale') {
    return false;
  }
  return true;
}

/**
 * Build a fresh config payload for a newly-created shared harness.
 * P-029 wizard calls this at step 9 with the wizard-collected
 * inputs. Pure — caller passes `now` for deterministic testing.
 */
export function buildFreshConfig(args: {
  topic: string;
  github_remote: string;
  github_repository_id: number;
  privacy: HarnessSharedPrivacy;
  discord_channel?: string;
  now: number;
}): HarnessSharedConfig {
  if (!/^[0-9a-f]{64}$/.test(args.topic)) {
    throw new TypeError('topic must be 64-char lowercase hex');
  }
  if (!args.github_remote) {
    throw new TypeError('github_remote required');
  }
  if (!Number.isInteger(args.github_repository_id) || args.github_repository_id <= 0) {
    throw new TypeError('github_repository_id must be a positive integer');
  }
  const config: HarnessSharedConfig = {
    topic: args.topic,
    github_remote: args.github_remote,
    github_repository_id: args.github_repository_id,
    claim_status: 'unclaimed',
    privacy: args.privacy,
    created_at: args.now,
    schema_version: HARNESS_SHARED_CONFIG_SCHEMA_VERSION,
  };
  if (args.discord_channel !== undefined) {
    config.discord_channel = args.discord_channel;
  }
  return config;
}
