-- 572-event-await-nodes-threshold-tree.sql — composable-event-awaits-2026-07-11 P-002.
--
-- Composed event awaits: wake when ANY / ALL / k-of-n of a set of event
-- occurrences fire, nested (a threshold TREE). Today events:await is one-shot on
-- one key (+ payload_filter); ANY across heterogeneous keys is only emulatable by
-- N separate awaits (spurious later wakes + N timeout wakes), and ALL / k-of-n do
-- not exist. This migration lays the STORAGE (P-003 adds the engine).
--
-- Model (plan D-001/D-002): the tree's LEAVES stay ordinary event_awaits rows —
-- the matching machinery (fireAwaitsForKey / payload_filter) is untouched — but a
-- leaf that belongs to a tree carries node_id (the parent NODE it propagates its
-- claim to instead of waking) + root_id (the tree it belongs to, for one-UPDATE
-- void-on-root-fire) + member_fired_at / member_payload (its captured fire). The
-- INTERIOR + ROOT nodes live here in event_await_nodes: each is a threshold node
-- (any = required_count 1, all = required_count n) with an atomic fired_count that
-- trips fired_at when it reaches required_count and propagates up to its parent;
-- the ROOT owns the wake_handle + spec + the (root-only, D-003) deadline.
--
-- root-only columns (spec, wake_handle, expires_ts, timeout_behavior): populated
-- only on a root (parent_id IS NULL); NULL on interior nodes. Not CHECK-enforced —
-- the engine (P-003) maintains the invariant; a CHECK can't reference the
-- not-yet-known self id at insert time.
--
-- Idempotent (IF NOT EXISTS throughout). The runner provides the transaction
-- -- NO BEGIN/COMMIT here (lint:migrations). Adding the four nullable columns to
-- event_awaits is a metadata-only ADD COLUMN (no table rewrite, no default); no
-- new constraint on that hot table, so no validation scan.

CREATE TABLE IF NOT EXISTS harness_shared.event_await_nodes (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id     text NOT NULL DEFAULT 'default',
  -- The tree this node belongs to: a ROOT's root_id equals its own id (set by the
  -- engine right after insert); every descendant carries the same root_id so a
  -- single root_id-scoped statement can void / render / cancel the whole tree.
  root_id          bigint NOT NULL,
  -- The node this one propagates its trip UP to. NULL ⇒ this is the ROOT.
  -- ON DELETE CASCADE so deleting a root tears down its whole subtree.
  parent_id        bigint REFERENCES harness_shared.event_await_nodes (id) ON DELETE CASCADE,
  subscriber_id    text NOT NULL,
  -- k of the k-of-n threshold: any = 1, all = (child count). The node TRIPS when
  -- fired_count reaches required_count.
  required_count   integer NOT NULL CHECK (required_count >= 1),
  fired_count      integer NOT NULL DEFAULT 0,
  fired_at         timestamptz,
  -- ROOT ONLY: the authored tree spec (dataConditionSchema tree of {event, when?}
  -- leaves + all/any/some combinators) — for events:status render + re-registration.
  spec             jsonb,
  -- ROOT ONLY: the delivery handle the root fires ONE wake to (pumpWakeDeliveries).
  wake_handle      jsonb,
  note             text,
  -- ROOT ONLY (D-003 root-only timeout): the whole-tree deadline + what a timeout does.
  expires_ts       timestamptz,
  timeout_behavior text NOT NULL DEFAULT 'expire' CHECK (timeout_behavior IN ('expire', 'wake')),
  -- events:cancel on the root cascades a cancel down the tree (soft-void via UPDATE).
  cancelled_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- Whole-tree scans: void unfired descendants on root fire, events:status render,
-- events:cancel cascade — all are root_id-scoped.
CREATE INDEX IF NOT EXISTS event_await_nodes_root_id_idx
  ON harness_shared.event_await_nodes (root_id);

-- Child enumeration for tree assembly + backs the ON DELETE CASCADE self-FK
-- (PG recommends indexing the referencing column so a cascade delete is not a seq scan).
CREATE INDEX IF NOT EXISTS event_await_nodes_parent_id_idx
  ON harness_shared.event_await_nodes (parent_id);

-- The sweeper scans only LIVE root nodes with a deadline (interior nodes have a
-- NULL expires_ts and are excluded).
CREATE INDEX IF NOT EXISTS event_await_nodes_sweeper_idx
  ON harness_shared.event_await_nodes (expires_ts)
  WHERE expires_ts IS NOT NULL AND fired_at IS NULL AND cancelled_at IS NULL;

-- Leaves-that-belong-to-a-tree carry these; a plain (non-composed) await leaves them NULL.
ALTER TABLE harness_shared.event_awaits
  ADD COLUMN IF NOT EXISTS node_id         bigint,      -- the parent NODE this leaf propagates to (NULL ⇒ ordinary await)
  ADD COLUMN IF NOT EXISTS root_id         bigint,      -- the tree root (for one-UPDATE void-on-root-fire)
  ADD COLUMN IF NOT EXISTS member_fired_at timestamptz, -- when this leaf claimed as a tree member (it propagates instead of waking)
  ADD COLUMN IF NOT EXISTS member_payload  jsonb;       -- the emit payload captured at leaf fire → root wake's { fired: leaf→payload }

-- The void-all-unfired-descendants bulk UPDATE on root fire + member scans — only
-- composed-leaf rows (partial, so a plain-await-heavy table pays nothing).
CREATE INDEX IF NOT EXISTS event_awaits_composed_root_idx
  ON harness_shared.event_awaits (root_id)
  WHERE root_id IS NOT NULL;

-- Per-node leaf enumeration (a node's direct leaf children) for tree assembly.
CREATE INDEX IF NOT EXISTS event_awaits_composed_node_idx
  ON harness_shared.event_awaits (node_id)
  WHERE node_id IS NOT NULL;

COMMENT ON TABLE harness_shared.event_await_nodes IS
  'Interior + root threshold nodes of a composed event-await TREE (composable-event-awaits-2026-07-11). Leaves stay in event_awaits (node_id/root_id/member_* columns); each node is an any/all/k-of-n counter that trips fired_at at required_count and propagates to parent_id; the root (parent_id IS NULL) owns the wake_handle, spec, and the root-only deadline.';
