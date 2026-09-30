-- 820-backfill-launch-provenance-fallback.sql
--
-- EI-20305159182044134 — legacy `launch-provenance` standing facts hand an agent a
-- DEAD delivery address with no escape hatch.
--
-- A standing fact is folded VERBATIM into every future orient until it expires, so its
-- body is what a cold-woken agent actually reads long after the launch prompt has
-- scrolled away. `buildLaunchProvenanceFactBody`
-- (packages/operator-core/lib/endpoint-route/routes/agent-mcp/bootstrap-su.ts) gained a
-- durable reporting fallback on 2026-08-12 — "@fleet-leader:<slug>" for a fleet launch,
-- to:["human"] otherwise — but nothing backfilled the facts asserted BEFORE that. Those
-- bodies name only a raw launcher session id, and a session id is not a durable address:
-- the session ends, coord:send then hard-refuses it with `unknown_recipient`, and the
-- agent has nothing else to reach for. That is the reported failure.
--
-- Measured on this box at 2026-08-13T03:19Z: 340 unexpired legacy facts, 36 of them
-- belonging to owners active within the previous 2 hours.
--
-- DATA backfill only — no DDL, so there is nothing for the currently-deployed release to
-- break on and no FORWARD-COMPAT acknowledgment is required.
--
-- SCOPE, deliberately narrow. Only rows ending in the EXACT legacy sentence are touched.
-- The broader "body does not mention coord:send" predicate ALSO matches 2 hand-written
-- bodies that already name a live surface in prose; appending to those would produce
-- contradictory duplicate guidance, so they are excluded by construction.
--
-- We APPEND rather than re-parse and rebuild. The original launcher/plan/brief prose is
-- not safely parseable, and it is still correct as ATTRIBUTION — only the delivery advice
-- was missing. The appended sentences are kept character-identical to
-- `launchProvenanceFallbackSentence()` so a backfilled row is indistinguishable from a
-- freshly-asserted one.
--
-- The fleet lookup is a CORRELATED SUBQUERY, not `UPDATE ... FROM`: that form is an inner
-- join, which would silently skip every owner with no fleet-membership row — exactly the
-- fleetless agents who most need the to:["human"] fallback. COALESCE supplies the
-- fleetless sentence whenever the subquery finds nothing (no membership, last event was
-- 'leave', or the fleet no longer exists).

WITH current_fleet AS (
  SELECT DISTINCT ON (e.workspace_id, e.owner_id)
         e.workspace_id,
         e.owner_id,
         e.fleet_slug,
         e.event
  FROM harness_shared.fleet_membership_events e
  ORDER BY e.workspace_id, e.owner_id, e.at DESC
)
UPDATE harness_shared.agent_facts f
SET body = f.body || ' ' || COALESCE(
      (
        SELECT 'If that session ends, use coord:send with to: ["@fleet-leader:'
               || cf.fleet_slug
               || '"] to reach the current fleet leader; this selector survives session '
               || 'retirement and leadership rotation.'
        FROM current_fleet cf
        WHERE cf.owner_id = f.scope_ref
          AND cf.event <> 'leave'
          AND EXISTS (
            SELECT 1
            FROM harness_shared.agent_fleets af
            WHERE af.workspace_id = cf.workspace_id
              AND af.fleet_slug = cf.fleet_slug
          )
      ),
      'If that session ends, use coord:send with to: ["human"] to reach the owner; '
      || 'this owner surface survives session retirement.'
    ),
    updated_at = now()
WHERE f.key = 'launch-provenance'
  AND f.scope = 'owner'
  AND f.expires_at > now()
  AND f.body LIKE '%launcher/supervisor — report milestones + anomalies to them.';
