-- 082: completion_ref verifier columns on harness_features_consolidated.
--
-- Per papercusp-dogfood-v5 Phase 2 P-016. Adds the columns the background
-- `git ls-remote` verifier daemon (apps/operator/lib/harness/
-- completion-ref-verifier.ts) writes when polling each pending_done /
-- recently-shipped feature against its remote.
--
--   verified_done_at_remote_ts TIMESTAMPTZ — stamped when the
--                                            completion_ref.commit_sha
--                                            is found via git ls-remote.
--                                            Null while unverified or
--                                            after divergence. Drives the
--                                            tier-B ✓ badge per §17/D-030.
--
--   verifier_last_error        TEXT        — 'sha_not_found' when the SHA
--                                            has disappeared from the
--                                            remote (force-push / branch
--                                            delete / revert). Null on
--                                            success. The presence of this
--                                            value is the divergence signal
--                                            the FeatureDetail UI reads to
--                                            render the ⚠ warning state
--                                            (P-017). NOT writing through
--                                            harness_escalations: that
--                                            table is a per-(slug,phase)
--                                            file-mirror surface, wrong
--                                            shape for a per-feature
--                                            verifier signal.
--
--   verifier_last_checked_at   TIMESTAMPTZ — bumped on every check
--                                            (success, divergence, AND
--                                            network-unreachable). Lets the
--                                            daemon skip recently-checked
--                                            features and the UI show
--                                            "verifying…" vs "stale" state.
--
-- The per-harness → consolidated sync trigger (sync_features_consolidated
-- in 001-shared.sql) only SETs the columns listed in its INSERT/UPDATE
-- statement — these verifier_* columns are NOT in that list, so direct
-- UPDATEs from the verifier daemon won't be clobbered on the next
-- per-harness feature mutation. Audited 2026-05-24.
--
-- Idempotent (PG 9.6+ IF NOT EXISTS on ALTER COLUMN).

ALTER TABLE harness_shared.harness_features_consolidated
  ADD COLUMN IF NOT EXISTS verified_done_at_remote_ts TIMESTAMPTZ;
ALTER TABLE harness_shared.harness_features_consolidated
  ADD COLUMN IF NOT EXISTS verifier_last_error        TEXT;
ALTER TABLE harness_shared.harness_features_consolidated
  ADD COLUMN IF NOT EXISTS verifier_last_checked_at   TIMESTAMPTZ;

-- Partial index for divergence queries: surface "broken completion_ref"
-- rows fast. The Insights tab / Contributors panel will read this to
-- count tier-B verified vs divergent.
CREATE INDEX IF NOT EXISTS hfc_verifier_divergence_idx
  ON harness_shared.harness_features_consolidated (harness_slug, feature_id)
  WHERE verifier_last_error IS NOT NULL;

-- Partial index for the daemon's per-tick sweep: features that have a
-- completion_ref but haven't been verified yet (or were last verified
-- long ago). Complements hfc_pending_done_idx from migration 080.
CREATE INDEX IF NOT EXISTS hfc_verifier_pending_idx
  ON harness_shared.harness_features_consolidated (harness_slug, verifier_last_checked_at NULLS FIRST)
  WHERE completion_ref IS NOT NULL AND verified_done_at_remote_ts IS NULL;
