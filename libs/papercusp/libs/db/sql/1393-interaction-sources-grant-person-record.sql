-- 1393: interaction sources grant person -> record by default
-- (crm-agent-sales-onboarding-apps-2026-10-06 P-003, decision D-017 point 1; refines D-013 point 4).
--
-- The relationship graph admits an interaction's participants only from a source whose
-- destination_policy routes `person` to `record` (that routing IS the grant;
-- packages/operator-core/lib/relationship-graph/participants.ts createParticipantChain).
-- Measured 2026-10-06 ~09:10Z: no data source in any workspace routed person -> record, so the
-- graph held 0 PER- rows. D-014 already treats participants as default team-visible metadata,
-- and a graph person is that same identity-only metadata, so the grant is now default-on for
-- interaction sources. Removing `person` from a source's destination_policy revokes it.
--
-- Additive only: no DDL, no dropped column, and no change to the function's signature.

-- (1) New sources: the kind defaults applied by trigger_sources_apply_kind_defaults on INSERT.
--     Unchanged apart from `"person":["record"]` on the two interaction kinds (gmail, gcal).
CREATE OR REPLACE FUNCTION harness_shared.data_source_kind_defaults(
  p_kind text,
  OUT sync_mode text,
  OUT datatype_mappings jsonb,
  OUT destination_policy jsonb)
RETURNS record
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT
    CASE p_kind
      WHEN 'gmail' THEN 'poll'
      WHEN 'gcal' THEN 'poll'
      WHEN 'contacts' THEN 'poll'
      WHEN 'slack' THEN 'socket'
      WHEN 'webhook' THEN 'webhook'
      ELSE 'manual'
    END,
    (CASE p_kind
      WHEN 'gmail' THEN '{"message":"email-message"}'
      WHEN 'gcal' THEN '{"event":"calendar-event"}'
      WHEN 'contacts' THEN '{"person":"contact"}'
      WHEN 'slack' THEN '{"message":"chat-message"}'
      WHEN 'webhook' THEN '{"payload":"webhook-payload"}'
      ELSE '{}'
    END)::jsonb,
    (CASE p_kind
      WHEN 'gmail' THEN '{"email-message":["document","event"],"person":["record"]}'
      WHEN 'gcal' THEN '{"calendar-event":["document","event"],"person":["record"]}'
      WHEN 'contacts' THEN '{"contact":["document","event"]}'
      WHEN 'slack' THEN '{"chat-message":["document","event"]}'
      WHEN 'webhook' THEN '{"webhook-payload":["event"]}'
      ELSE '{}'
    END)::jsonb
$$;

-- (2) Existing sources: every source that routes an interaction datatype gains `record` in its
--     `person` routes (any other person routes it already had are kept). Keyed on the policy, not
--     on `kind`, so a source of any kind that carries mail or meetings is covered.
UPDATE harness_shared.data_sources AS s
   SET destination_policy = s.destination_policy || jsonb_build_object(
         'person',
         (SELECT jsonb_agg(DISTINCT r.route ORDER BY r.route)
            FROM jsonb_array_elements_text(
                   coalesce(s.destination_policy -> 'person', '[]'::jsonb) || '["record"]'::jsonb) AS r(route)))
 WHERE s.destination_policy ?| ARRAY['email-message', 'calendar-event']
   AND NOT (coalesce(s.destination_policy -> 'person', '[]'::jsonb) @> '["record"]'::jsonb);
