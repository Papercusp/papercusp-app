-- 685-substrate-merge-cursor-apply-binding.sql
-- EI-18773697830188393 (split out of WI-559 / EI-18769415639448677): a joiner whose
-- hive-home binding is CORRECTED never re-applies the rows it dropped while mis-bound.
--
-- WI-2105 made fold progress durable: `substrate_merge_cursor` records, per admitted
-- log, the next index to read, and boot SEEDS the in-memory cursor from it so a restart
-- resumes instead of re-folding from 0. That resume is only valid while the PROJECTION
-- SCOPE the ops were folded through is unchanged — a cursor position means "every op
-- below this index has been applied", and "applied" is decided by the pot-home
-- projection scope (`buildScopedApply`'s potHomeSlug), which is the federation DEMUX
-- KEY. Fold an op under the WRONG scope and it is DROPPED, yet the cursor still marks
-- it done.
--
-- That is exactly what WI-559 hit live: fed-b bound the shared hive to its LOCAL slug
-- (`octocat-spoon-knife`) instead of the owner-authored home (`spoon-knife-pot`), so
-- ~49.7k inbound rows were dropped at the demux while the cursor advanced past every
-- one of them. Correcting the binding was necessary but NOT sufficient: on the next
-- COLD boot the corrected process seeded from these same rows and resumed past the
-- owner's `hive_members` ops, so `pot_members` never repopulated and presence kept
-- rejecting. (`forceReFold` covers only the mid-session REKEY rebind — boot.ts:4606 —
-- never a cold boot.)
--
-- The durable fix is to make the cursor's validity INTRINSIC to the scope it was
-- computed under, rather than tracking the binding in a second, separately-drifting
-- store: stamp each row with its apply binding, and seed only from rows whose stamp
-- matches the scope the fold is about to run under. A changed (or first-time-unknown)
-- binding then self-heals automatically — the seed returns nothing, the fold restarts
-- from 0 through the corrected scope, and the re-fold is idempotent (LWW put/del).
--
-- Blast radius is one-shot but WIDER than the joiner. Pre-existing rows have
-- apply_binding NULL, and the binding a fold runs under is the full
-- `hiveHomeProjectionSlug ?? ownPotHomeSlug ?? memberHomeRebindSlug` chain, so:
--   * a NON-hive harness folds with binding NULL → NULL matches → seeds as before,
--     byte-identical to pre-fix behaviour;
--   * a hive JOINER folds under its hive-home slug → NULL does not match → exactly ONE
--     full re-fold, after which its rows carry the stamp and later boots resume;
--   * a hive OWNER booting its HOME harness ALSO re-folds once. (An earlier draft of
--     this comment claimed owners were exempt because `joinerPotHomeSlug` is
--     remote_hive-gated and returns NULL for an owner. That is TRUE of that one
--     resolver but FALSE of the binding: `ownPotHomeSlug` is non-null for the owner's
--     own home harness, so the stamp is non-null and the NULL rows mismatch.
--     MEASURED live on the fed-b rig 2026-07-27 — the `papercusp` harness stamped
--     'papercusp' and re-folded from 0.)
--
-- That one-shot re-fold is NOT free on a large log, and it is the same shape as the
-- condition WI-2105 exists to prevent (a big from-0 re-fold CPU-starving routinesTick
-- past the 240s bghost-watchdog bound). It is nonetheless bounded and self-limiting:
-- positions are persisted INTRA-pass (MERGE_PERSIST_EVERY_OPS) under the NEW stamp, so
-- progress is monotonic and a watchdog restart resumes the re-fold rather than
-- restarting it. Observed on the rig: a 461,475-op log re-folded monotonically
-- (39,191 → 100,000 → …) while re-stamping as it went.
--
-- Idempotent (ADD COLUMN IF NOT EXISTS) per migration policy. Nullable with no default:
-- NULL is a meaningful value here ("folded under no pot-home scope"), not a backfill gap.

ALTER TABLE harness_shared.substrate_merge_cursor
  ADD COLUMN IF NOT EXISTS apply_binding text;

COMMENT ON COLUMN harness_shared.substrate_merge_cursor.apply_binding IS
  'EI-18773697830188393: the pot-home projection scope (buildScopedApply potHomeSlug — the federation demux key) this fold progress was computed under; NULL = no pot-home scope. seedCursorFromPg seeds ONLY rows whose stamp equals the current binding, so a corrected/changed hive-home binding discards stale progress and re-folds from 0 through the new scope instead of resuming past ops it silently dropped.';
