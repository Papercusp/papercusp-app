-- 441-hive-integration-requests.sql
-- cross-machine-coord-parity-and-trust-2026-07-01 P-035 (G-5c, D-010/D-011):
-- the multi-owner INTEGRATION-REQUESTS queue — the CODE-plane twin of
-- coord_quarantine (P-013 quarantine-don't-drop, mig 436).
--
-- A namespace work head published by a member device whose verified author sits
-- BELOW the 'steer' comms tier is NOT auto-integrated into the shared staging
-- ref by the integrator (integrator.ts). Instead of silently merging untrusted
-- code (or silently dropping the member's work), the head lands HERE — visible
-- on the requests surface and promotable with one call:
-- ratifyIntegrationRequest(device, sha) marks exactly THAT (device, head) pair
-- ratified, and the next integrator pass integrates it. A ratification is
-- PER-SHA: a newer head from the same below-tier device queues again (trust the
-- code you saw, not the author's future).
--
-- LOCAL-ONLY (never federates — no capture trigger, no HLC stamp trigger):
-- ratification is the RECEIVING integrator/owner's judgment about the sender,
-- exactly like quarantine. Bounded by the writer (per-author-device cap, oldest
-- pending evicted first; ratified rows are the last to go) so an untrusted
-- member cannot flood PG by republishing heads.

BEGIN;

CREATE TABLE IF NOT EXISTS harness_shared.hive_integration_requests (
    workspace_id            text NOT NULL DEFAULT '',
    hive_slug               text NOT NULL,
    -- Per-(hive, managed member repo) scope, matching storage.hiveGitRepoPath
    -- (G-1b P-041): one queue per bare repo.
    repo_key                text NOT NULL,
    -- The publishing member device (identity pubkey, base64) — VERIFIED
    -- upstream via sigrefs (sigrefs.ts), never an envelope claim.
    device_pubkey           text NOT NULL,
    head_sha                text NOT NULL,
    -- The device's attested author (hive_members chain), for the surface.
    author_github_user_id   bigint,
    reason                  text NOT NULL CHECK (reason IN ('below-steer-tier')),
    state                   text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'ratified')),
    -- Epoch ms: when queued / when ratified.
    created_ts              bigint NOT NULL,
    ratified_ts             bigint,
    PRIMARY KEY (workspace_id, hive_slug, repo_key, device_pubkey, head_sha)
);

CREATE INDEX IF NOT EXISTS hive_integration_requests_author_idx
  ON harness_shared.hive_integration_requests (workspace_id, device_pubkey, created_ts);

COMMENT ON TABLE harness_shared.hive_integration_requests IS
  'Below-steer-tier namespace heads awaiting integration ratification (P-035 G-5c, cross-machine-coord-parity-and-trust-2026-07-01). Queue-don''t-integrate: the requests surface lists it; ratify(device, sha) promotes exactly that head into the next integrator pass. Local-only, per-author-bounded.';

COMMIT;
