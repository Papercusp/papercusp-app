/**
 * ClaimStatus — harness-claim badge vocabulary.
 *
 * Pure type, no UI. Lives in core (operator-core) so the backend loaders
 * (user-profile, insights) and the UI badge
 * (app/_components/ClaimStatusBadge) share ONE definition. Relocated out of
 * the badge component during the operator-core carve to cut the backend→UI
 * back-edge (plan operator-core-headless-serve-2026-06-04, Stage A).
 */
export type ClaimStatus = 'unclaimed' | 'claimed' | 'stale' | 'superseded';
