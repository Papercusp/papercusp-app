-- 1175 — scope the spec_evidence_bindings dedup index to LIVE proof only (EXPAND phase).
--
-- WI-10001850. Plan managed-agent-capability-contract-and-native-cutover-2026-09-13,
-- decision D-011. Follow-up to 1174, which added the retraction stamp.
--
-- WHY THIS EXISTS. 1174 gave the table a recorded-retraction path but left
-- spec_evidence_bindings_dedup a TOTAL unique index over
-- (workspace_id, harness_slug, work_item_id, plan_slug, spec_id, spec_revision,
-- binding_fingerprint). A retracted row therefore still occupies its dedup slot, and
-- that silently defeats the repair D-011 mandates:
--
--   1. bindSpecEvidence INSERTs with ON CONFLICT (<those columns>) DO NOTHING RETURNING id.
--   2. When an identical binding already exists the insert returns no row, so the
--      writer falls back to a lookup keyed on binding_fingerprint.
--   3. Because the index is unique over exactly those columns, that lookup matches
--      EXACTLY ONE row — the retracted one — and the call returns status 'unchanged'
--      naming it.
--
-- The caller is told the evidence is bound. Every reader excludes retracted rows by
-- default, so the evaluator sees nothing, and the clause stays failing with no
-- diagnosable cause. Retract-then-rebind-identical-evidence is exactly the flow a
-- repair takes when the retraction was provisional or mistaken, and re-emitting a
-- binding with a stable evidence_ref and test_run_id is ordinary behaviour here.
--
-- The dedup index exists to stop DUPLICATE LIVE PROOF. A retracted row is not live
-- proof, so scoping the index to retracted_at IS NULL restores the intended meaning
-- rather than weakening it: two live identical bindings remain impossible, while a
-- withdrawn one no longer squats on the slot its replacement needs.
--
-- EXPAND ONLY — the DROP of the total index deliberately lives in 1176, NOT here.
-- EI-23634085867209303. The first draft of this migration created the partial index
-- and dropped the total one in the SAME file, which is the migration-461/564/689
-- outage class (lint-migrations: "same-migration unique-index shape swap"), and its
-- original FORWARD-COMPAT note argued the deployed release was safe because its
-- INSERT "names the index's column list, not its name". That reasoning is wrong.
-- PostgreSQL cannot infer a PARTIAL unique index as an ON CONFLICT arbiter unless the
-- statement ALSO supplies the index predicate, so dropping the total index breaks
-- every un-predicated ON CONFLICT at PLAN TIME (42P10) — on every insert, not only
-- conflicting ones. Measured directly against PostgreSQL rather than reasoned about:
--     partial index only + `ON CONFLICT (cols) DO NOTHING`
--       -> ERROR: there is no unique or exclusion constraint matching the ON CONFLICT
--          specification
--     partial index only + `ON CONFLICT (cols) WHERE retracted_at IS NULL DO NOTHING`
--       -> succeeds
--     TOTAL index still present + that same predicated form -> ALSO succeeds
-- The last line is what makes the sequencing safe: the predicated writer works against
-- BOTH shapes, so the writer fix (spec-evidence-store.ts) can land first and on its
-- own, and 1176 removes the total index only once that writer is the deployed one.
--
-- FORWARD-COMPAT: this migration is purely additive — it creates one partial unique
-- index and drops nothing. The currently-deployed release keeps using the total index
-- spec_evidence_bindings_dedup as its ON CONFLICT arbiter, and that index still exists
-- after this runs, so the deployed release observes no behaviour change whatsoever.
--
-- Built before the old one is dropped so the table is never momentarily without a
-- uniqueness guarantee. The partial index is a strict subset of the total index's
-- key space, and no row is retracted at the time this runs, so the build cannot
-- fail on a pre-existing duplicate.

CREATE UNIQUE INDEX IF NOT EXISTS spec_evidence_bindings_dedup_live
  ON harness_shared.spec_evidence_bindings (
    workspace_id, harness_slug, work_item_id,
    plan_slug, spec_id, spec_revision, binding_fingerprint
  )
  WHERE retracted_at IS NULL;

COMMENT ON INDEX harness_shared.spec_evidence_bindings_dedup_live IS
  'Dedup guard for LIVE evidence bindings only. Two identical live bindings remain impossible; a retracted binding releases its slot so the corrected replacement can be inserted instead of silently deduping onto the withdrawn row. Supersedes the total index spec_evidence_bindings_dedup, which migration 1176 drops once the predicated writer is deployed.';
