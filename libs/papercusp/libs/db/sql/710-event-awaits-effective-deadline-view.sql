-- 710-event-awaits-effective-deadline-view.sql
--
-- P-016 of fleet-leadership-continuity-and-actuation-2026-08-01:
-- "a leaf row with a non-null root_id is not self-describing, so every consumer of
--  event_awaits can draw the same wrong conclusion; a view or helper fixes the CLASS
--  rather than one surface."
--
-- THE DEFECT. A composed await (`events:await { spec }`) writes ONE deadline, on the
-- root NODE (harness_shared.event_await_nodes.expires_ts). Its LEAF rows in
-- event_awaits are deliberately deadline-free — insertComposedLeaf writes
-- `expires_ts = NULL, wake_handle = NULL` with the comment "the leaf owns no deadline
-- — the ROOT owns the tree's timeout", and the root ANCHOR row is NULL for the same
-- reason (so the generic timeout sweep leaves it alone).
--
-- That is correct for the FIRE path and wrong for every READ path. A consumer asking
-- "when does this park expire?" of a leaf gets NULL, and NULL in this table's other
-- 99% of rows means "waits forever". So a perfectly healthy 30-minute composed park
-- reads as an indefinite one at every liveness surface that has not special-cased it.
-- P-015 fixed exactly one such surface (fleet:leader-brief); this is the class fix.
-- Live cost of the un-fixed version: the most benign possible park rendered as the
-- most alarming possible reading, and a false fleet-halting-deadlock report to the
-- owner (2026-07-26, fleet push-not-poll).
--
-- THE VIEW. Every event_awaits column, plus the resolved truth:
--   effective_expires_ts      the deadline that actually governs this row
--   effective_timeout_behavior what happens when it lapses
--   composed_role             'leaf' | 'root-anchor' | NULL (an ordinary await)
--   root_expires_ts           the root's own deadline, for surfaces that show provenance
--
-- A row's OWN expires_ts always wins when it has one — the view only fills a gap, so
-- an ordinary (non-composed) await is byte-identical to reading the table directly and
-- can never be re-dated by this change.
--
-- Idempotent: CREATE OR REPLACE VIEW.

CREATE OR REPLACE VIEW harness_shared.event_awaits_effective AS
SELECT
  a.*,
  -- The governing deadline. COALESCE order is load-bearing: a leaf that somehow
  -- carries its own expires_ts is honouring its own, never the tree's.
  COALESCE(a.expires_ts, rn.expires_ts)                    AS effective_expires_ts,
  CASE
    WHEN a.expires_ts IS NOT NULL THEN a.timeout_behavior
    ELSE COALESCE(rn.timeout_behavior, a.timeout_behavior)
  END                                                      AS effective_timeout_behavior,
  -- Which half of a composed tree this row is (NULL ⇒ an ordinary await).
  CASE
    WHEN a.root_id IS NULL      THEN NULL
    WHEN a.node_id IS NOT NULL  THEN 'leaf'
    ELSE 'root-anchor'
  END                                                      AS composed_role,
  rn.expires_ts                                            AS root_expires_ts,
  rn.required_count                                        AS root_required_count,
  rn.fired_count                                           AS root_fired_count,
  rn.cancelled_at                                          AS root_cancelled_at
FROM harness_shared.event_awaits a
-- The root NODE is the one whose id equals root_id (compose-store's documented
-- "root_id equals its own id" convention for the root row).
LEFT JOIN harness_shared.event_await_nodes rn
       ON rn.id = a.root_id
      AND rn.workspace_id = a.workspace_id;

COMMENT ON VIEW harness_shared.event_awaits_effective IS
  'P-016: event_awaits with a composed leaf''s deadline resolved from its root node. '
  'Read this, not the raw table, anywhere a deadline or liveness verdict is derived — '
  'a composed leaf''s own expires_ts is NULL by design and reads as "waits forever".';
