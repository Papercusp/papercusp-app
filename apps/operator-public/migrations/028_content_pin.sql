-- Content pin at publish (cupboard-release-pipeline-content-trust-2026-09-16
-- P-001, D-003).
--
-- Before this migration a self-describing listing (rubric / plan / recipe /
-- goal / theme) was a POINTER: a repo + a `listing_ref` sub-directory that an
-- installer cloned at whatever the default branch happened to be at install
-- time. The operator approved a URL; the bytes behind it could move afterwards.
--
-- These columns make the pointer a VERSION. At publish the Worker itself
-- resolves the default-branch head and computes the canonical tree digest of
-- `<listing_ref>/` at that commit (`canonicalTreeDigest` in
-- @papercusp/artifact-registry — sorted (path, blob sha) pairs, sha256). It
-- stores what IT computed, never what the client reported (D-003). The
-- installer (P-002) fetches exactly `pinned_commit_sha`, recomputes the digest,
-- and refuses on any difference — so the bytes an operator approved are the
-- bytes every later install receives.
--
-- Nullable on purpose: code kinds (plugin/pack/app/…) carry no pin yet (Phase 4
-- converges them on the release gate), and every pre-028 row has none. A NULL
-- pin on a self-describing row published AFTER this migration is a bug, not a
-- state — the publish path refuses rather than inserting one.
ALTER TABLE harnesses ADD COLUMN pinned_commit_sha TEXT;
ALTER TABLE harnesses ADD COLUMN pinned_tree_digest TEXT;
-- Epoch millis when the pin was computed (= created_at for a fresh publish; a
-- P-004 versioned re-publish stamps its own).
ALTER TABLE harnesses ADD COLUMN pinned_at INTEGER;
