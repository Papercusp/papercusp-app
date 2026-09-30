-- 010-resource-fencing.sql — fencing tokens for correctness-class resource locks.
-- Plan: locks-correctness-hardening-2026-06-04 (D-001). Runs against papercusp_su. Idempotent.
--
-- File locks stay fail-open — git + merge-resolver back them, so they are
-- *efficiency-class* (Kleppmann's taxonomy) and need no fencing. But the named
-- resources `db-schema` (db:migrate) and `dev-server` (dev:restart) are
-- *correctness-class*: no merge un-corrupts a double-migrate, and today a
-- paused/zombie exclusive holder whose TTL lapsed (its lock swept, the exclusive
-- re-granted to another owner) could still run its destructive action against a
-- lock it no longer holds. `lock_id` is a random UUID — a handle, not a
-- monotonic token — so the action can't tell "I was superseded".
--
-- Fix: a MONOTONIC `fence_seq` per (coordination_domain, resource), bumped on
-- every EXCLUSIVE grant and stamped on the holder's row + returned with the
-- lock. The blessed wrapper passes it to the action, and the action rejects a
-- stale fence (antirez check-and-set / Chubby sequence number — the safe side of
-- the Redlock debate). For migrations the action ledger below makes the
-- su_meta-style migration-name idempotency an EXPLICIT resource-side check.

-- ─────────────────────────────────────────────────────────────────────
-- Per-(domain,resource) monotonic fence counter. Bumped on each exclusive
-- grant. The high-water mark is `next_seq`; a holder's stamped `fence_seq`
-- is current iff it still holds the (unique) live exclusive on that resource.
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agent_resource_fence (
  coordination_domain text   NOT NULL,
  resource            text   NOT NULL,
  next_seq            bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (coordination_domain, resource)
);

-- The fence stamped on this exclusive grant. 0 = never granted exclusive
-- (every shared row, and an exclusive still 'draining' / not yet effective).
ALTER TABLE agent_resource_locks
  ADD COLUMN IF NOT EXISTS fence_seq bigint NOT NULL DEFAULT 0;

-- Bump + return the next fence for (domain, resource). ONE source of truth for
-- both the TS immediate-held path and the SQL drain cascade, so the two can
-- never hand out the same number. Monotone and gap-free per resource.
CREATE OR REPLACE FUNCTION resource_assign_fence(
  p_coordination_domain text,
  p_resource            text
) RETURNS bigint
LANGUAGE plpgsql AS $func$
DECLARE
  v_seq bigint;
BEGIN
  INSERT INTO agent_resource_fence (coordination_domain, resource, next_seq)
  VALUES (p_coordination_domain, p_resource, 1)
  ON CONFLICT (coordination_domain, resource) DO UPDATE
    SET next_seq = agent_resource_fence.next_seq + 1
  RETURNING next_seq INTO v_seq;
  RETURN v_seq;
END;
$func$;

-- ─────────────────────────────────────────────────────────────────────
-- Resource-side idempotency ledger (D-001). Generalizes the su_meta
-- migration-name check: a correctness-class action records the
-- (domain, action_key) it performed + the fence that did it, so a retried or
-- zombie re-apply of the SAME action is a CHECKED no-op even if fencing were
-- somehow bypassed. db:migrate keys by the migration file (action_key
-- "migrate:<basename>"); dev:restart needs no ledger (a restart is naturally
-- idempotent — re-running it is harmless).
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agent_resource_action_log (
  coordination_domain text        NOT NULL,
  action_key          text        NOT NULL,
  fence_seq           bigint      NOT NULL,
  applied_ts          timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (coordination_domain, action_key)
);

-- ─────────────────────────────────────────────────────────────────────
-- Re-create the drain cascade so the draining→held flip ASSIGNS a fence
-- (the exclusive only becomes effective here, so this is where its fence is
-- minted). Identical to 005 otherwise. CREATE OR REPLACE — safe to re-run.
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION resource_grant_cascade(
  p_coordination_domain text,
  p_now                  timestamptz
)
RETURNS void
LANGUAGE plpgsql AS $func$
DECLARE
  v_excl         record;
  v_shared_count int;
BEGIN
  FOR v_excl IN
    SELECT * FROM agent_resource_locks
     WHERE coordination_domain = p_coordination_domain
       AND mode = 'exclusive'
       AND status = 'draining'
       AND expires_ts > p_now
  LOOP
    SELECT count(*) INTO v_shared_count
      FROM agent_resource_locks
     WHERE coordination_domain = p_coordination_domain
       AND resource = v_excl.resource
       AND mode = 'shared'
       AND expires_ts > p_now;

    IF v_shared_count = 0 THEN
      UPDATE agent_resource_locks
         SET status    = 'held',
             acquired_ts = p_now,
             fence_seq = resource_assign_fence(p_coordination_domain, v_excl.resource)
       WHERE coordination_domain = p_coordination_domain
         AND resource = v_excl.resource
         AND owner = v_excl.owner
         AND mode = 'exclusive';

      PERFORM pg_notify('ch_coord_' || p_coordination_domain, v_excl.lock_id::text);
    END IF;
  END LOOP;
END;
$func$;
