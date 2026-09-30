-- Cupboard migration 002 — publisher-permission signal.
--
-- Records the publisher's GitHub permission level on the bound repo AT
-- PUBLISH TIME, so the browse card can show a trust signal — "published
-- by a repo collaborator" vs "by a non-collaborator" — without a hard
-- gate. Provisional (unclaimed) listings stay open; see plan
-- cupboard-provisional-listing-trust-2026-06-02 (D-002/D-003).
--
-- Values: 'admin' | 'maintain' | 'write' | 'triage' | 'read' | 'none'.
-- Nullable: rows published before this migration have NULL and render as
-- "unknown" (no signal shown).

ALTER TABLE harnesses ADD COLUMN publisher_permission TEXT;
