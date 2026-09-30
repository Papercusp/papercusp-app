-- 035_identity_surface.sql
--
-- The declared surface of an identity listing (portable-identity-packages-2026-09-26
-- P-016).
--
-- An identity publishes as a `blueprint` listing with the identity facet
-- (`blueprint_kind = 'identity'`). A shopper must see what it will do before
-- installing: slots, context contributions and their injection points, sync and
-- async hooks, bundled packages, knowledge-pack memories and docs, class contracts,
-- grants and the permission lines install asks consent for. The publisher DERIVES
-- that surface from the closure it signs (operator-core identity-listing-surface.ts)
-- and sends it as canonical JSON; the installer recomputes it from the verified
-- clone and refuses a listing whose surface differs, so the Worker only bounds and
-- well-forms it, exactly like release_manifest (migration 032).
--
-- Nullable and additive: every non-identity row keeps NULL. blueprint_kind stays a
-- route-validated TEXT column (migration 009), so 'identity' needs no DDL.

ALTER TABLE harnesses ADD COLUMN identity_surface TEXT;  -- canonical JSON, IdentityListingSurface
