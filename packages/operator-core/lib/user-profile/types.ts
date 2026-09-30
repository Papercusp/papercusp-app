/**
 * User-profile page data contracts.
 *
 * Pure types, NO React/UI. The data shapes the user-profile loaders (this
 * directory) PRODUCE and the profile UI
 * (app/users/github/[id]/UserProfile.tsx) CONSUMES. Relocated out of the
 * `'use client'` component into core to cut the backend→UI back-edge during
 * the operator-core carve (plan operator-core-headless-serve-2026-06-04,
 * Stage A).
 *
 * NOTE: distinct from the dogfood data-spine shapes in
 * `../harness/user-profile-types.ts` (UserProfilePayload et al.) — these are
 * the live component contract.
 */
import type { BindingStatus } from '../identity/binding-verifier-types';
import type { ClaimStatus } from '../harness/claim-status-types';

export interface UserProfileData {
  github_user_id: number;
  github_login: string;
  display_name: string | null;
  avatar_url: string | null;
  /** Aggregate binding state across harnesses (worst case). */
  binding_status: BindingStatus;
  /** Per-harness blocks the viewer can see. */
  harnesses: ReadonlyArray<HarnessBlock>;
  /** Cross-harness recent activity, capped at ~30 events. */
  recent_activity: ReadonlyArray<ActivityEntry>;
  /** Harnesses this user has claimed as a verified maintainer. */
  claimed_harnesses: ReadonlyArray<ClaimedHarness>;
}

export interface HarnessBlock {
  harness_slug: string;
  display_title: string;
  href: string;
  prs_merged: number;
  features_shipped: number;
  activity_events: number;
}

export interface ActivityEntry {
  id: string;
  ts: number;
  kind: string;
  /** Pre-rendered short label, e.g. "Shipped F-042 in sheets". */
  label: string;
  href?: string;
}

export interface ClaimedHarness {
  harness_slug: string;
  display_title: string;
  href: string;
  claim_status: ClaimStatus;
}
