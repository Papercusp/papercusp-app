-- 088: reset /adv Harness-tab dock layouts to the new default arrangement.
--
-- The /adv Harness tab default layout was reshaped from a flat 25/25/50
-- three-column split (Features | Issues | Detail) into a two-row layout:
-- Features and Issues side-by-side on top, with a full-width Detail reader
-- pane below (see defaultAdvHarnessesLayout in
-- apps/operator/lib/dock-layouts.ts).
--
-- Saved per-(workspace,user,harness) layouts only reseed on a read MISS, so
-- harnesses that already had a stored layout would keep the old split. This
-- migration force-resets them: deleting the stored rows makes getLayout()
-- reseed from the new default on the next read. Runs exactly once (tracked
-- in harness_shared.schema_migrations).
--
-- Targeted to adv-harness layout names only ('adv-harnesses' and
-- 'adv-harnesses:<slug>'). Dashboard ('dashboard:*'), pi-tab ('pi'/'pi:*'),
-- and every other dock layout are left untouched.

DELETE FROM harness_shared.harness_dock_layouts
 WHERE layout_name = 'adv-harnesses'
    OR layout_name LIKE 'adv-harnesses:%';
