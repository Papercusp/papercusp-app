-- 1149: append-only active-identity attribution for P-009 / D-028 / D-030.
--
-- `session_briefs.control_state.activation` remains the live desired / prepared /
-- applied authority.  This ledger is its temporal flight record: one immutable
-- event per transition phase, carrying the stable actor/principal/session tuple,
-- the exact artifact + mutable-state revisions, and the bound layer refs.  The
-- derived views turn applied events into non-overlapping activation/layer spans
-- and join existing tool + inference meters without adding billing policy.
--
-- The migration runner supplies the transaction; keep this file psql-free.

CREATE TABLE IF NOT EXISTS harness_shared.session_identity_activation_events (
  id                     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id           text        NOT NULL,
  owner_id               text        NOT NULL,
  actor_id               text        NOT NULL,
  principal_id           text        NOT NULL,
  session_id             text        NOT NULL,
  adv_session_id         bigint,
  native_session_id      text,
  transition_id          text        NOT NULL,
  control_generation     bigint      NOT NULL,
  phase                  text        NOT NULL,
  source                 text        NOT NULL,
  specification_revision text        NOT NULL,
  state_revision         text        NOT NULL,
  stack_refs             jsonb       NOT NULL DEFAULT '[]'::jsonb,
  failure                text,
  recorded_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT session_identity_activation_phase_ck
    CHECK (phase IN ('desired', 'prepared', 'applied', 'failed')),
  CONSTRAINT session_identity_activation_spec_revision_ck
    CHECK (specification_revision ~ '^[0-9a-f]{64}$'),
  CONSTRAINT session_identity_activation_nonempty_ck
    CHECK (
      btrim(owner_id) <> '' AND btrim(actor_id) <> '' AND
      btrim(principal_id) <> '' AND btrim(session_id) <> '' AND
      btrim(transition_id) <> '' AND btrim(source) <> '' AND
      btrim(state_revision) <> ''
    ),
  CONSTRAINT session_identity_activation_stack_ck
    CHECK (jsonb_typeof(stack_refs) = 'array'),
  CONSTRAINT session_identity_activation_failure_ck
    CHECK ((phase = 'failed' AND btrim(COALESCE(failure, '')) <> '') OR (phase <> 'failed' AND failure IS NULL)),
  CONSTRAINT session_identity_activation_event_uniq
    UNIQUE (workspace_id, owner_id, transition_id, phase)
);

CREATE INDEX IF NOT EXISTS session_identity_activation_owner_time_idx
  ON harness_shared.session_identity_activation_events
    (workspace_id, owner_id, recorded_at, id);
CREATE INDEX IF NOT EXISTS session_identity_activation_native_time_idx
  ON harness_shared.session_identity_activation_events
    (workspace_id, native_session_id, recorded_at, id)
  WHERE native_session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS session_identity_activation_applied_time_idx
  ON harness_shared.session_identity_activation_events
    (workspace_id, owner_id, recorded_at, id)
  WHERE phase = 'applied';

ALTER TABLE harness_shared.session_identity_activation_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS session_identity_activation_workspace_isolation
  ON harness_shared.session_identity_activation_events;
CREATE POLICY session_identity_activation_workspace_isolation
  ON harness_shared.session_identity_activation_events
  USING (workspace_id = current_setting('app.workspace_id'::text, true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id'::text, true));

CREATE OR REPLACE VIEW harness_shared.session_identity_activation_spans AS
WITH applied AS (
  SELECT e.*,
         lead(e.recorded_at) OVER (
           PARTITION BY e.workspace_id, e.owner_id, e.session_id
           ORDER BY e.recorded_at, e.id
         ) AS next_applied_at
    FROM harness_shared.session_identity_activation_events e
   WHERE e.phase = 'applied'
)
SELECT a.id AS activation_event_id,
       a.workspace_id, a.owner_id, a.actor_id, a.principal_id, a.session_id,
       a.adv_session_id, a.native_session_id, a.transition_id,
       a.control_generation, a.source, a.specification_revision,
       a.state_revision, a.stack_refs, a.recorded_at AS active_from,
       CASE
         WHEN a.next_applied_at IS NULL THEN s.ended_at
         WHEN s.ended_at IS NULL THEN a.next_applied_at
         ELSE LEAST(a.next_applied_at, s.ended_at)
       END AS active_until
  FROM applied a
  LEFT JOIN harness_shared.adv_sessions s ON s.id = a.adv_session_id;

CREATE OR REPLACE VIEW harness_shared.session_identity_layer_spans AS
SELECT s.activation_event_id, s.workspace_id, s.owner_id, s.actor_id,
       s.principal_id, s.session_id, s.adv_session_id, s.native_session_id,
       s.transition_id, s.control_generation, s.source,
       s.specification_revision, s.state_revision,
       layer.ref AS layer_ref,
       split_part(layer.ref, ':', 1) AS layer_slot,
       substring(layer.ref FROM position(':' IN layer.ref) + 1) AS layer_id,
       s.active_from, s.active_until
  FROM harness_shared.session_identity_activation_spans s
  CROSS JOIN LATERAL jsonb_array_elements_text(s.stack_refs) AS layer(ref);

CREATE OR REPLACE VIEW harness_shared.tool_invocations_identity_attribution AS
SELECT t.*,
       a.activation_event_id AS identity_activation_event_id,
       a.actor_id AS identity_actor_id,
       a.principal_id AS identity_principal_id,
       a.session_id AS identity_session_id,
       a.transition_id AS identity_transition_id,
       a.specification_revision AS identity_specification_revision,
       a.state_revision AS identity_state_revision,
       a.stack_refs AS identity_stack_refs
  FROM harness_shared.tool_invocations t
  LEFT JOIN LATERAL (
    SELECT s.*
      FROM harness_shared.session_identity_activation_spans s
     WHERE s.workspace_id = t.workspace_id
       AND s.owner_id = t.coord_owner_id
       AND t.invoked_at >= s.active_from
       AND (s.active_until IS NULL OR t.invoked_at < s.active_until)
     ORDER BY s.active_from DESC, s.activation_event_id DESC
     LIMIT 1
  ) a ON true;

CREATE OR REPLACE VIEW harness_shared.agent_usage_samples_identity_attribution AS
SELECT u.*,
       a.activation_event_id AS identity_activation_event_id,
       a.owner_id AS identity_owner_id,
       a.actor_id AS identity_actor_id,
       a.principal_id AS identity_principal_id,
       a.session_id AS identity_session_id,
       a.transition_id AS identity_transition_id,
       a.specification_revision AS identity_specification_revision,
       a.state_revision AS identity_state_revision,
       a.stack_refs AS identity_stack_refs
  FROM harness_shared.agent_usage_samples u
  LEFT JOIN LATERAL (
    SELECT s.*
      FROM harness_shared.session_identity_activation_spans s
     WHERE s.workspace_id = u.workspace_id
       AND to_timestamp(u.ts / 1000.0) >= s.active_from
       AND (s.active_until IS NULL OR to_timestamp(u.ts / 1000.0) < s.active_until)
       AND u.session_id IS NOT NULL
       AND (
         u.session_id = s.native_session_id OR
         EXISTS (
           SELECT 1 FROM harness_shared.adv_sessions av
            WHERE av.id = s.adv_session_id AND av.session_id = u.session_id
         ) OR
         EXISTS (
           SELECT 1 FROM harness_shared.session_archives ar
            WHERE ar.adv_session_id = s.adv_session_id AND ar.session_id = u.session_id
         )
       )
     ORDER BY s.active_from DESC, s.activation_event_id DESC
     LIMIT 1
  ) a ON true;

GRANT SELECT, INSERT ON harness_shared.session_identity_activation_events TO harness_app;
GRANT USAGE, SELECT ON SEQUENCE harness_shared.session_identity_activation_events_id_seq TO harness_app;
GRANT SELECT ON harness_shared.session_identity_activation_spans,
  harness_shared.session_identity_layer_spans,
  harness_shared.tool_invocations_identity_attribution,
  harness_shared.agent_usage_samples_identity_attribution TO harness_app;
DO $grant$
BEGIN
  GRANT SELECT ON harness_shared.session_identity_activation_events,
    harness_shared.session_identity_activation_spans,
    harness_shared.session_identity_layer_spans,
    harness_shared.tool_invocations_identity_attribution,
    harness_shared.agent_usage_samples_identity_attribution TO harness_zero;
EXCEPTION WHEN undefined_object THEN NULL;
END
$grant$;

COMMENT ON TABLE harness_shared.session_identity_activation_events IS
  'P-009 append-only desired/prepared/applied/failed identity activation flight record; live authority remains session_briefs.control_state.activation.';
COMMENT ON VIEW harness_shared.session_identity_activation_spans IS
  'Applied identity-stack spans. Pending/failed transitions never open a span; the prior applied span remains active until a later applied event or session end.';
