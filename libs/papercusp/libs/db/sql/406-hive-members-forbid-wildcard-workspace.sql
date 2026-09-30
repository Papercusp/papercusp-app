-- 406-hive-members-forbid-wildcard-workspace.sql
-- WI-892 / EI-3409 — forbid the unscoped-superuser wildcard from harness_shared.hive_members.
--
-- THE BUG
-- `'*'` is the unscoped-superuser READ sentinel (ctx.workspaceId for a ?superuser=1 session
-- that chose no workspace, per _mcp-handler's `workspaceId || '*'` fallback). The hive-membership
-- WRITE tools (hive:create owner self-register, hive:membership_decide approve, hive:add_member,
-- hive:create_from_repo) resolved workspace with `args.workspace ?? ctx.workspaceId ?? … ??
-- activeWorkspaceId()` — and a truthy `'*'` WINS that chain, so the `activeWorkspaceId()` fallback
-- never fires and the literal `'*'` is persisted as `workspace_id`. A `'*'`-stamped row is then
-- invisible to EVERY concrete-workspace read — the membership guard, epoch-key grant, and
-- cross-member content federation all filter `WHERE workspace_id = '<concrete>'` — so the
-- operator's member view silently diverges from the raw table, breaking shared-hive federation
-- and blocking live WI-887 (epoch-key self-heal) confirmation. Proven live on the fed-a rig:
-- 18 `'*'` member rows; e.g. b8recv-hive had 1 row total, 0 visible under workspace_id='default'.
--
-- THE FIX (this migration = HEAL + recurrence guard; the code fix stops new `'*'` writes at the
-- source: resolveConcreteWorkspaceId at the write tools + an upsertHiveMember throw-guard).
-- Idempotent + non-destructive of observable state: a `'*'` row is unreadable by any
-- concrete-workspace query, so it is already functionally dead; re-homing or dropping it changes
-- no membership any concrete read could see.

-- 1. Re-home `'*'` rows to their hive's REAL workspace, where the hives row resolves it AND no
--    concrete row already occupies the (workspace_id, hive_home_slug, github_user_id) PK. This is
--    FK-safe: the target hives row (h.workspace_id, h.home_slug) is exactly the joined row.
UPDATE harness_shared.hive_members m
   SET workspace_id = h.workspace_id
  FROM harness_shared.hives h
 WHERE m.workspace_id = '*'
   AND h.home_slug = m.hive_home_slug
   AND h.workspace_id <> '*'
   AND NOT EXISTS (
         SELECT 1 FROM harness_shared.hive_members c
          WHERE c.workspace_id = h.workspace_id
            AND c.hive_home_slug = m.hive_home_slug
            AND c.github_user_id = m.github_user_id);

-- 2. Drop every remaining `'*'` row. Either a concrete row already shadows it (step 1 skipped the
--    PK-dup) or its hive is itself unresolvable / `'*'` (dead test detritus). A `'*'` row is
--    unreadable by any concrete-workspace query, so removing it changes no observable membership.
DELETE FROM harness_shared.hive_members WHERE workspace_id = '*';

-- 3. The recurrence guard: forbid the wildcard (and empty) at the data layer so any future writer
--    that bypasses the code guard — including the projection's own INSERT — fails LOUDLY instead
--    of silently shadowing a row. DROP-then-ADD keeps this idempotent.
ALTER TABLE harness_shared.hive_members
  DROP CONSTRAINT IF EXISTS hive_members_workspace_id_concrete;
ALTER TABLE harness_shared.hive_members
  ADD CONSTRAINT hive_members_workspace_id_concrete
  CHECK (workspace_id <> '*' AND workspace_id <> '');

COMMENT ON CONSTRAINT hive_members_workspace_id_concrete ON harness_shared.hive_members IS
  'WI-892/EI-3409: workspace_id must be a CONCRETE workspace, never the unscoped-superuser read '
  'sentinel ''*'' (or empty). A ''*''-stamped row is invisible to every concrete-workspace read, '
  'silently breaking shared-hive federation. Writers resolve concrete via resolveConcreteWorkspaceId.';
