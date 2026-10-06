-- Review approves a SHA (cupboard-release-pipeline-content-trust-2026-09-16
-- P-008, D-003/D-004).
--
-- Before this migration an operator's `approve` flipped `review_status` on a
-- row and said nothing about WHICH bytes were reviewed. P-001 already pins the
-- bytes the Worker fetched at publish (`pinned_*`), but a pin is what the
-- publisher pushed — the approval is the operator's statement "I reviewed THIS
-- commit". These columns record that statement separately, so the served
-- version is always provably a version somebody approved:
--
--   approved_commit_sha / approved_tree_digest  the commit + canonical tree
--       digest the operator reviewed. Equals pinned_* on a normal approval;
--       differs only when the row had DRIFTED (the repo head moved after the
--       pin) and the reviewer re-pinned to the SHA they actually read — in that
--       case the approve path ALSO rewrites pinned_* to the reviewed SHA, so an
--       installer (P-002) can never fetch bytes the reviewer did not see.
--   approved_at  epoch millis of the approval.
--   drift  1 when the repo head has moved past the pin and nobody has reviewed
--       the newer commit ("newer unverified version available"; install keeps
--       serving the pin). P-006's push webhook SETS it; an operator approve
--       (this plan item, SPEC-P-008) CLEARS it, because the approval just
--       re-pinned the row to the commit the operator actually read. 0 = no known
--       drift; every existing row starts there.
--
-- Nullable on purpose: only self-describing kinds carry a pin, so only they
-- carry an approved SHA; every other kind (knowledge-pack, plugin, …) and every
-- not-yet-approved row stores NULL.
ALTER TABLE harnesses ADD COLUMN approved_commit_sha TEXT;
ALTER TABLE harnesses ADD COLUMN approved_tree_digest TEXT;
ALTER TABLE harnesses ADD COLUMN approved_at INTEGER;
ALTER TABLE harnesses ADD COLUMN drift INTEGER NOT NULL DEFAULT 0;

-- Backfill: every already-approved pinned row was approved at the pin it
-- carries (the approve path refused an unpinned self-describing row since 028),
-- so the approval and the pin agree.
UPDATE harnesses
   SET approved_commit_sha = pinned_commit_sha,
       approved_tree_digest = pinned_tree_digest,
       approved_at = reviewed_at
 WHERE review_status = 'approved'
   AND pinned_commit_sha IS NOT NULL
   AND pinned_tree_digest IS NOT NULL;
