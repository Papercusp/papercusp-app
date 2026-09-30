-- 686-pots-canonical-home-slug-fk.sql
--
-- WI-559 / EI-18775450536624845 — the LAST hop of a 3-defect chain that kept a
-- joiner's Pot roster permanently empty. Defects 1 (federation demux bound to the
-- joiner's LOCAL slug) and 2 (a corrected binding resuming from a cursor folded
-- under the OLD scope, migration 685) are fixed and live-verified. This is 3.
--
-- ── THE DEFECT ────────────────────────────────────────────────────────────────
-- `harness_shared.pots.pot_home_slug` is doing TWO jobs that only coincide on the
-- Pot's OWNER:
--   LOCAL HANDLE     — which registry entry / identity row / local scope key this
--                      Pot is known by ON THIS BOX. `getPotBySlug`, the harness
--                      registry, ~40 local consumers and the swarm binding key on it.
--   FEDERATED SCOPE  — the `pot_home_slug` a Pot's rows travel under ON THE WIRE.
--                      That is the OWNER's slug, on every machine, by definition.
--
-- A JOINER's local slug is a naming AFFORDANCE, not an identity: join-hive derives
-- it `freeSlug(kebab(potId), taken)`, which deliberately SUFFIXES on a local name
-- collision. So it can legitimately differ from the owner's slug on a perfectly
-- healthy join. (On the 2-machine rig it also differed because a Cupboard lookup
-- leg fabricated the potId from a display TITLE — `kebab('octocat/Spoon-Knife')` =
-- 'octocat-spoon-knife' against the owner's 'spoon-knife-pot'. That source is fixed
-- in lookup-hive-for-repo.ts; this migration repairs the STRUCTURE it exposed.)
--
-- Once the demux fix (defect 1) correctly moved the projections to the OWNER's
-- slug, ~16 hive-home-grained projections began persisting rows under the FEDERATED
-- scope — while `pot_members_pot_fkey` still demanded a LOCAL handle:
--
--   FOREIGN KEY (workspace_id, pot_home_slug)
--     REFERENCES harness_shared.pots (workspace_id, pot_home_slug)
--
-- so on a joiner whose two slugs diverge there is NO parent row, and EVERY inbound
-- roster op fails:
--   [hyperbee-merge] merge pass FAILED harness=<local>:
--     insert or update on table "pot_members" violates foreign key constraint
--     "pot_members_pot_fkey"                                      (every ~60s)
-- and the WI-255 apply-quarantine then turns a STRUCTURAL failure into PERMANENT
-- data loss:
--   [read-merge] WI-255 quarantine: op hive-members::<n> threw on apply 3x —
--     recording winner + dropping to avoid a retry loop
-- => pot_members stays empty => `[presence-gossip] NO admitted devices for topic
-- <t>` => the joiner admits nobody. That is WI-559's symptom, three hops downstream.
--
-- ── WHY THIS SHAPE, AND NOT THE THREE OBVIOUS ALTERNATIVES ────────────────────
-- (a) Insert a SECOND `pots` row at the canonical slug purely as an FK parent.
--     IMPOSSIBLE: `pots_public_key_key` is UNIQUE on public_key — one identity row
--     per Pot, by construction. (It would also have made `getPotByPubkey`'s LIMIT 1
--     — the "have I already joined this Pot?" oracle — nondeterministic, and put a
--     phantom Pot into every `listPots()` consumer.)
-- (b) Persist under the LOCAL slug and confine the canonical slug to the wire.
--     Defensible, but ~16 projections are bound to the hive-home scope; re-pointing
--     all of them plus the presence read means redesigning a just-verified fix.
-- (c) RENAME the joiner's view to the owner's slug so the two agree.
--     Measured on the live rig: the view slug is NOT inert — it carries
--     substrate_meta/substrate_outbox/substrate_merge_cursor/work_items rows, so a
--     rename needs a cross-table harness-rename primitive that does not exist, and
--     it is impossible anyway on a genuine local slug collision (the case freeSlug
--     exists for).
--
-- THIS migration instead stops the CONFLATION at its source: give the federated
-- scope its OWN column, so one Pot keeps exactly one identity row while being
-- addressable under both names. `canonical_pot_home_slug` is the OWNER-authored
-- slug; `pot_home_slug` stays the untouched local handle. On an owner (and on every
-- healthy joiner whose slugs agree) the two are EQUAL and behavior is byte-identical
-- — which is what makes this safe to apply everywhere.
--
-- The runtime reconcile that keeps the column true (resolved BY PUBKEY from the
-- owner's signed announce, never by name) lives in
-- packages/operator-core/lib/pot-canonical-slug-reconcile.ts. This file only
-- establishes the structure + a self-healing backfill.
--
-- Idempotent: every step is IF NOT EXISTS / conditional. The runner provides the
-- transaction — NO BEGIN/COMMIT here.

-- ── 1. The column: the FEDERATED scope key. ───────────────────────────────────
--   Nullable at first so the backfill can run, then NOT NULL. Backfilled to
--   pot_home_slug, which is EXACTLY right for an owner and for an agreeing joiner
--   — i.e. every row that is not the defect.
ALTER TABLE harness_shared.pots
  ADD COLUMN IF NOT EXISTS canonical_pot_home_slug text;

UPDATE harness_shared.pots
   SET canonical_pot_home_slug = pot_home_slug
 WHERE canonical_pot_home_slug IS NULL;

ALTER TABLE harness_shared.pots
  ALTER COLUMN canonical_pot_home_slug SET NOT NULL;

-- A NOT NULL column with no usable DEFAULT would break every existing writer that
-- names its columns explicitly (hive-store's inserts, the substrate test rigs, any
-- raw fixture) — a SQL DEFAULT cannot reference another column, so the fill has to
-- be a trigger. Writers that know the owner's slug (the joiner reconcile) set it
-- explicitly; everyone else transparently gets canonical == local, i.e. exactly
-- today's behavior, with no call-site change anywhere.
CREATE OR REPLACE FUNCTION harness_shared.pots_fill_canonical_slug()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.canonical_pot_home_slug IS NULL THEN
    NEW.canonical_pot_home_slug := NEW.pot_home_slug;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS pots_fill_canonical_slug_trg ON harness_shared.pots;
CREATE TRIGGER pots_fill_canonical_slug_trg
  BEFORE INSERT OR UPDATE ON harness_shared.pots
  FOR EACH ROW EXECUTE FUNCTION harness_shared.pots_fill_canonical_slug();

COMMENT ON COLUMN harness_shared.pots.canonical_pot_home_slug IS
  'WI-559: the OWNER-authored (FEDERATED) pot_home_slug this Pot''s rows travel under on the wire — the scope key every hive-home-grained projection persists under, and the target of pot_members_pot_fkey. EQUALS pot_home_slug on the owner and on any joiner whose local slug agrees. Differs ONLY on a joiner whose local handle was suffixed by freeSlug or derived before the owner''s announce was heard. Reconciled BY PUBKEY from the signed announce (pot-canonical-slug-reconcile.ts) — NEVER by name, because the local slug is structurally untrustworthy.';

-- ── 2. Uniqueness — the FK needs a unique target, and it is a real invariant. ──
--   Two local Pots may not claim the same federated scope: that would mean two
--   identity rows for one wire Pot and would make the demux ambiguous. The
--   reconcile refuses to stamp a value that would collide, leaving canonical =
--   local (fail-open to today's behavior) rather than forcing it.
CREATE UNIQUE INDEX IF NOT EXISTS pots_canonical_home_slug_key
  ON harness_shared.pots (workspace_id, canonical_pot_home_slug);

-- ── 3. Repoint pot_members_pot_fkey at the FEDERATED scope. ───────────────────
--   pot_members.pot_home_slug holds the WIRE scope (the projection writes the op's
--   own pot_home_slug verbatim), so the FEDERATED column is the correct parent.
--   ON DELETE CASCADE is preserved: dissolving a Pot still reaps its roster.
--
--   ⚠ ON UPDATE CASCADE IS LOAD-BEARING, NOT DECORATION. Without it this whole
--   migration is INERT on exactly the install it exists to repair. Proved on real
--   PG against a reproduction of the live joiner state: with ON DELETE CASCADE
--   alone, the runtime reconcile's
--       UPDATE pots SET canonical_pot_home_slug = '<owner slug>'
--   is REFUSED —
--       ERROR: update or delete on table "pots" violates foreign key constraint
--       "pot_members_pot_fkey" ... Key (workspace_id, canonical_pot_home_slug)=
--       (<ws>, <local handle>) is still referenced from table "pot_members"
--   — because roster rows already scoped to the LOCAL handle pin the old value.
--   The reconcile would fail-open forever and the roster would stay empty.
--   CASCADE also does the right thing semantically: those rows belong to THIS Pot,
--   whose federated scope was just corrected, so re-scoping them onto the corrected
--   slug is the repair, not a side effect. (A pre-existing row already sitting under
--   the corrected scope would make the cascade collide on the PK; that surfaces as a
--   loud error and the reconcile fails open, rather than corrupting either row.)
--
--   Guarded: only re-create when the constraint is not ALREADY pointing at the new
--   target, so a re-apply on an up-to-date DB is a true no-op.
DO $$
DECLARE
  v_def text;
BEGIN
  IF to_regclass('harness_shared.pot_members') IS NULL THEN
    RETURN;
  END IF;

  SELECT pg_get_constraintdef(c.oid) INTO v_def
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
   WHERE n.nspname = 'harness_shared'
     AND t.relname = 'pot_members'
     AND c.conname = 'pot_members_pot_fkey';

  -- Already repointed AND already cascading on update: a true no-op re-apply.
  -- (The ON UPDATE clause is checked too, so a DB that got an earlier revision of
  -- this file — repointed but without the cascade — is upgraded rather than skipped.)
  IF v_def IS NOT NULL
     AND v_def LIKE '%canonical_pot_home_slug%'
     AND v_def LIKE '%ON UPDATE CASCADE%' THEN
    RETURN;
  END IF;

  -- SELF-HEAL BEFORE RE-ADDING (this is what repairs an install already broken by
  -- the defect — e.g. a joiner mid-blackout): any pot_members row whose scope has
  -- no parent under the NEW target, but whose scope IS some local Pot's handle,
  -- is stamped onto that Pot as its canonical scope. This is the narrow, evidence-
  -- backed case: the roster rows arrived under a slug we do know locally.
  UPDATE harness_shared.pots p
     SET canonical_pot_home_slug = p.pot_home_slug
   WHERE p.canonical_pot_home_slug IS DISTINCT FROM p.pot_home_slug
     AND NOT EXISTS (
       SELECT 1 FROM harness_shared.pot_members m
        WHERE m.workspace_id = p.workspace_id
          AND m.pot_home_slug = p.canonical_pot_home_slug
     );

  -- Any pot_members row that STILL has no parent under the new target is
  -- genuinely orphaned (its Pot is not known on this box at all). It could not
  -- have been inserted under the OLD constraint either, so deleting it removes
  -- data that is unreachable by every reader, and is required for the ADD to
  -- validate. Copy it aside first — reversibility over a silent delete.
  CREATE TABLE IF NOT EXISTS harness_shared._pot_members_686_orphans
    (LIKE harness_shared.pot_members INCLUDING DEFAULTS);

  INSERT INTO harness_shared._pot_members_686_orphans
  SELECT m.* FROM harness_shared.pot_members m
   WHERE NOT EXISTS (
     SELECT 1 FROM harness_shared.pots p
      WHERE p.workspace_id = m.workspace_id
        AND p.canonical_pot_home_slug = m.pot_home_slug
   );

  DELETE FROM harness_shared.pot_members m
   WHERE NOT EXISTS (
     SELECT 1 FROM harness_shared.pots p
      WHERE p.workspace_id = m.workspace_id
        AND p.canonical_pot_home_slug = m.pot_home_slug
   );

  IF v_def IS NOT NULL THEN
    ALTER TABLE harness_shared.pot_members DROP CONSTRAINT pot_members_pot_fkey;
  END IF;

  ALTER TABLE harness_shared.pot_members
    ADD CONSTRAINT pot_members_pot_fkey
    FOREIGN KEY (workspace_id, pot_home_slug)
    REFERENCES harness_shared.pots (workspace_id, canonical_pot_home_slug)
    ON DELETE CASCADE
    ON UPDATE CASCADE;
END $$;
