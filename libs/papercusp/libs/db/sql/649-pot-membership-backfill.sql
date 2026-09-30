-- 649-pot-membership-backfill.sql
--
-- Owner directive (VERIFIED — owner, interactive, 2026-07-20 11:21, sess a5e7a6e8):
-- "papercusp-workspace ISNT A POT ... THOSE WERE SUPPOSED TO BE MOVED TO
-- PAPERCUSP ... AUDIT ALL WORK ITEMS THEY SHOULD ALL BE PART OF A REAL POT."
-- Plan: pot-membership-enforcement-2026-07-20 (P-003). Enforcement (validate a
-- pot slug at write) is a SEPARATE follow-up (P-005/P-006); this file is the
-- one-time BACKFILL of the existing mis-scoped data.
--
-- WHAT: work_items.harness_slug is meant to name the row's real Pot
-- (pots.pot_home_slug). ~2448 rows in workspace_id='papercusp-workspace' carry a
-- NON-pot slug — platform scope-labels (*, @singleton, operator:<ws>,
-- papercusp-workspace, hive-canary, all, papercup*), project slugs that predate
-- their hive pot (oddsmith, sb-devboard, ...), and dead xbench/eval benchmark
-- runs. Re-home each to its real Pot:
--   platform scope-labels  -> papercusp            (the one platform Pot)
--   oddsmith               -> oddsmith-hive
--   sb-devboard[-smoke]    -> sb-devboard-hive
--   papercusp-public-site  -> papercusp-public-site-pot
--   quartermaster          -> quartermaster-hive
--   hiveloop               -> hiveloop-hive
--   shared-hive-test       -> shared-hive-test-hive
--   xbench-su-<id>-instance_<b> -> its base Pot xbench-su-<id> (when it exists)
--   any other papercusp-workspace mis-scope -> papercusp (catch-all)
-- SCOPE: workspace_id='papercusp-workspace' ONLY. The 'default'/'generic-test'
-- tenants are isolated test fixtures with their own pots and are LEFT untouched.
--
-- COLLISIONS (the "could corrupt data" landmine): the PK is
-- (harness_slug, feature_id), GLOBAL. feature_ids are global (WI-/EI-/F-...), so
-- a handful of rows are DUPLICATE SHADOWS — the same logical id present under a
-- mis-scoped slug AND already under its target Pot (e.g. EI-13196 as
-- operator:papercusp-workspace[open] and papercusp[done]). Re-homing them would
-- violate the PK. Resolution = DEDUP (drop the mis-scoped shadow, keep the
-- target-Pot canonical row), NOT renumber — they are one logical item, not two.
-- Dropped rows are copied to harness_shared._pot_backfill_649_dropped first
-- (reversibility), and an in-txn guard proves every dropped id still survives
-- under its target Pot before commit.
--
-- SAFE BY CONSTRUCTION:
--   * Trigger-quiet: engineer_issues is a local VIEW over work_items (mig 522),
--     so local reads self-correct from harness_slug the instant it changes — no
--     projection row is orphaned locally. The CDC capture triggers only enqueue
--     FEDERATED egress (substrate_outbox); a ~2448-row re-scope would be a
--     needless federation spike, so we DISABLE them for the txn (precedent: mig
--     295). Federation is dormant here; convergence on resume is a reconcile.
--   * IDEMPOTENT: re-run only sees rows still mis-scoped (none after success);
--     the backup table is CREATE-IF-NOT-EXISTS so a re-run never wipes it.
--   * GUARDED: RAISE (=> runner rollback) on any residual mis-scope, any
--     non-pot target, or any dropped id with no surviving target-Pot row.
--   * BOOT-SAFE: the whole backfill is a no-op — and the guards are skipped —
--     when the workspace has no platform Pot yet, because migrations run BEFORE
--     the operator that creates Pots. See step 1's precondition.
-- The migration runner wraps this file in ONE transaction (no BEGIN/COMMIT/\set
-- here); a RAISE or failure rolls the whole thing back AND re-enables triggers.

-- ── 0. quiet the CDC/federation capture + notify/churn side-effects for the txn ─
ALTER TABLE harness_shared.work_items DISABLE TRIGGER capture_work_items_feature_upd_trg;
ALTER TABLE harness_shared.work_items DISABLE TRIGGER capture_work_items_issue_upd_trg;
ALTER TABLE harness_shared.work_items DISABLE TRIGGER capture_work_items_outbox_ins_del_trg;
ALTER TABLE harness_shared.work_items DISABLE TRIGGER emit_change_notify_trg;
ALTER TABLE harness_shared.work_items DISABLE TRIGGER record_steering_churn_trg;

-- ── 1. compute the slug -> real-Pot target for every mis-scoped row ────────────
-- PRECONDITION (see the guard block's matching check in step 5): the workspace
-- must actually HAVE its platform Pot. Every arm of the CASE below — and the
-- catch-all every arm collapses to in step 1b — names 'papercusp'. If that Pot
-- does not exist here there is no valid home for ANY row, so the only correct
-- backfill is no backfill: select nothing, touch nothing, and let the runtime
-- self-heal (mig 652 / pot-membership.ts) re-home these rows once the operator
-- boots and creates the Pot.
--
-- This is not defensive padding, it is the single condition that bricked the
-- SHIPPED APP (EI-18892214197928842). `harness_shared.pots` is populated only at
-- RUNTIME by hive-store.ts — NO migration, not even 000-baseline, ever inserts a
-- Pot. Migrations run BEFORE the operator boots, so on the packaged app's fresh
-- seed the pots table is empty by construction and this file used to RAISE, exit
-- serve.mjs 1, and respawn-loop the sidecar forever.
--
-- Migrations 651 and 652 — same plan, same invariant, written days later —
-- already settled this: "Fail OPEN for a workspace with no platform Pot
-- (isolated fixtures / un-potted tenant)". 649 hard-RAISEd on the identical
-- condition. It was the outlier, and it is now aligned with its siblings.
--
-- The obvious alternative — have a migration CREATE the papercusp Pot — is
-- wrong: a Pot carries a federation identity (public_key, keychain_id). A
-- migration must never mint a keypair.
DROP TABLE IF EXISTS _pb649;
CREATE TEMP TABLE _pb649 AS
SELECT wi.harness_slug AS src, wi.feature_id, wi.status, wi.updated_ts,
  CASE
    WHEN wi.harness_slug IN ('*','@singleton','all','papercusp-workspace','hive-canary','papercup','papercup-hive','operator')
      OR wi.harness_slug LIKE 'operator:%'                       THEN 'papercusp'
    WHEN wi.harness_slug = 'oddsmith'                            THEN 'oddsmith-hive'
    WHEN wi.harness_slug IN ('sb-devboard','sb-devboard-smoke')  THEN 'sb-devboard-hive'
    WHEN wi.harness_slug = 'papercusp-public-site'               THEN 'papercusp-public-site-pot'
    WHEN wi.harness_slug = 'quartermaster'                       THEN 'quartermaster-hive'
    WHEN wi.harness_slug = 'hiveloop'                            THEN 'hiveloop-hive'
    WHEN wi.harness_slug = 'shared-hive-test'                    THEN 'shared-hive-test-hive'
    WHEN wi.harness_slug LIKE 'xbench-su-%-instance_%'
      AND EXISTS (SELECT 1 FROM harness_shared.pots p2
                   WHERE p2.pot_home_slug = split_part(wi.harness_slug,'-instance_',1))
                                                                 THEN split_part(wi.harness_slug,'-instance_',1)
    ELSE 'papercusp'
  END AS target
FROM harness_shared.work_items wi
WHERE wi.workspace_id = 'papercusp-workspace'
  -- the platform-Pot precondition documented above: no Pot, no backfill.
  AND EXISTS (SELECT 1 FROM harness_shared.pots p0
               WHERE p0.workspace_id = 'papercusp-workspace'
                 AND p0.pot_home_slug = 'papercusp')
  AND NOT EXISTS (SELECT 1 FROM harness_shared.pots p WHERE p.pot_home_slug = wi.harness_slug);

-- ── 1b. collapse any target Pot that does not exist HERE onto the catch-all ────
-- The CASE above names optional Pots (oddsmith-hive, sb-devboard-hive, ...). Those
-- exist in the dev database this migration was written against; they do NOT all
-- exist in every deployment — notably the embedded-PG data dir the packaged
-- desktop app ships with. Without this step the `bad_target` guard below counts
-- those rows and RAISEs, the runner rolls the whole file back, and serve.mjs exits
-- 1 before becoming ready: the SHIPPED DESKTOP APP THEN CANNOT BOOT AT ALL and
-- respawn-loops its sidecar forever (EI-18892214197928842, reproduced on the
-- 0.0.13 deb 2026-07-28 — "649 guard: 8 mapped target slug(s) are not real pots").
--
-- Collapsing to 'papercusp' is not a workaround, it IS this file's stated intent:
-- "any other papercusp-workspace mis-scope -> papercusp (catch-all)". The named
-- targets are a nicety — homing a row somewhere MORE specific when that Pot
-- happens to exist. When it does not, the catch-all is the correct answer, and a
-- migration must never make a boot depend on which optional Pots a database has.
-- The xbench arm already guards its target with EXISTS; this generalises that to
-- every arm rather than repeating the check six more times.
--
-- MUST run BEFORE step 2: the dedup partitions by (target, feature_id), so
-- rewriting targets afterwards would group rows under the wrong partition and
-- could keep two rows that collide on the PK.
--
-- The guard keeps its teeth WHEREVER A BACKFILL ACTUALLY RAN: given the platform
-- Pot, it still fires if any row remains mis-scoped, if a mapped target is not a
-- real Pot, or if a dropped shadow has no surviving row. What it no longer does is
-- fire when there was nothing to check — see step 1's precondition and step 5.
UPDATE _pb649 m
   SET target = 'papercusp'
 WHERE NOT EXISTS (SELECT 1 FROM harness_shared.pots p WHERE p.pot_home_slug = m.target);

-- ── 2. identify DUPLICATE-SHADOW rows to drop (dedup, not renumber) ────────────
--   A: an existing canonical row already holds (target, feature_id)
--   B: >1 source row maps to the same (target, feature_id); keep the winner
--      (terminal state first, then most-recently-updated), drop the rest.
DROP TABLE IF EXISTS _pb649_drop;
CREATE TEMP TABLE _pb649_drop AS
SELECT src, feature_id FROM (
  SELECT m.src, m.feature_id
    FROM _pb649 m
   -- A row is never its OWN duplicate shadow. Without this, a row whose slug already
   -- EQUALS the target matches itself here and is DELETED in step 4 — silent data
   -- loss. Not hypothetical: it is exactly what the packaged app's 8 rows (already
   -- scoped 'papercusp', in a database with no 'papercusp' Pot) did, and only the
   -- bad_target guard's RAISE rolled the deletion back.
   -- NOTE the EXISTS stays deliberately UNSCOPED by workspace_id: the PK is
   -- (harness_slug, feature_id) with NO workspace_id (verified against
   -- pg_constraint, not just this file's header). Scoping it would let a re-home
   -- collide with another tenant's row holding the same global key.
   WHERE m.target <> m.src
     AND EXISTS (SELECT 1 FROM harness_shared.work_items t
                  WHERE t.harness_slug = m.target AND t.feature_id = m.feature_id)
  UNION ALL
  SELECT src, feature_id FROM (
    SELECT m.src, m.feature_id,
      row_number() OVER (
        PARTITION BY m.target, m.feature_id
        ORDER BY (m.status IN ('done','dropped','resolved','passed','closed','deprecated')) DESC,
                 m.updated_ts DESC NULLS LAST, m.src) AS rn
      FROM _pb649 m
     WHERE NOT EXISTS (SELECT 1 FROM harness_shared.work_items t
                        WHERE t.harness_slug = m.target AND t.feature_id = m.feature_id)
  ) z WHERE z.rn > 1
) u GROUP BY src, feature_id;

-- ── 3. back up the rows we are about to drop (reversibility; re-run-safe) ──────
CREATE TABLE IF NOT EXISTS harness_shared._pot_backfill_649_dropped AS
SELECT wi.* FROM harness_shared.work_items wi
JOIN _pb649_drop d ON d.src = wi.harness_slug AND d.feature_id = wi.feature_id
WHERE wi.workspace_id = 'papercusp-workspace';

-- ── 4. drop the shadows, then re-home the survivors ───────────────────────────
DELETE FROM harness_shared.work_items wi
USING _pb649_drop d
WHERE wi.harness_slug = d.src AND wi.feature_id = d.feature_id
  AND wi.workspace_id = 'papercusp-workspace';

UPDATE harness_shared.work_items wi
   SET harness_slug = m.target
  FROM _pb649 m
 WHERE wi.harness_slug = m.src AND wi.feature_id = m.feature_id
   AND wi.workspace_id = 'papercusp-workspace';

-- ── 5. in-txn guards (any RAISE => full rollback + triggers re-enabled) ────────
DO $g649$
DECLARE remaining bigint; bad_target bigint; lost bigint;
BEGIN
  -- FAIL OPEN, exactly as migrations 651/652 already do for this same condition:
  -- "Fail OPEN for a workspace with no platform Pot (isolated fixtures / un-potted
  -- tenant)". Step 1 selected nothing in that case, so nothing was re-homed and
  -- nothing was dropped — there is no invariant left to check, and the rows are
  -- correctly left for the runtime self-heal. Checking anyway is what took the
  -- shipped app down: guard 1 would count these very rows as "still mis-scoped"
  -- and RAISE, in a database where no valid home exists to move them to yet.
  IF NOT EXISTS (SELECT 1 FROM harness_shared.pots p
                  WHERE p.workspace_id = 'papercusp-workspace'
                    AND p.pot_home_slug = 'papercusp') THEN
    RAISE NOTICE '649: workspace papercusp-workspace has no platform Pot yet — backfill skipped, rows left for the runtime self-heal (mig 652).';
    RETURN;
  END IF;

  SELECT count(*) INTO remaining
    FROM harness_shared.work_items wi
   WHERE wi.workspace_id = 'papercusp-workspace'
     AND NOT EXISTS (SELECT 1 FROM harness_shared.pots p WHERE p.pot_home_slug = wi.harness_slug);
  IF remaining > 0 THEN
    RAISE EXCEPTION '649 guard: % non-pot work_items still in papercusp-workspace after backfill', remaining;
  END IF;

  SELECT count(*) INTO bad_target
    FROM _pb649 m
   WHERE NOT EXISTS (SELECT 1 FROM harness_shared.pots p WHERE p.pot_home_slug = m.target);
  IF bad_target > 0 THEN
    RAISE EXCEPTION '649 guard: % mapped target slug(s) are not real pots', bad_target;
  END IF;

  SELECT count(*) INTO lost
    FROM harness_shared._pot_backfill_649_dropped d
    JOIN _pb649 m ON m.src = d.harness_slug AND m.feature_id = d.feature_id
   WHERE NOT EXISTS (SELECT 1 FROM harness_shared.work_items t
                      WHERE t.harness_slug = m.target AND t.feature_id = d.feature_id);
  IF lost > 0 THEN
    RAISE EXCEPTION '649 guard: % dropped shadow(s) have NO surviving row under their target pot (data loss)', lost;
  END IF;
END $g649$;

-- ── 6. restore triggers + drop temps (success path; rollback also restores) ────
ALTER TABLE harness_shared.work_items ENABLE TRIGGER capture_work_items_feature_upd_trg;
ALTER TABLE harness_shared.work_items ENABLE TRIGGER capture_work_items_issue_upd_trg;
ALTER TABLE harness_shared.work_items ENABLE TRIGGER capture_work_items_outbox_ins_del_trg;
ALTER TABLE harness_shared.work_items ENABLE TRIGGER emit_change_notify_trg;
ALTER TABLE harness_shared.work_items ENABLE TRIGGER record_steering_churn_trg;

DROP TABLE IF EXISTS _pb649;
DROP TABLE IF EXISTS _pb649_drop;
