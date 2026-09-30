-- 1177 — preserve identity attribution across native-session carry reanchors.
--
-- A managed carry reuses one adv_sessions row while replacing its native
-- session_id. The activation event keeps the native id that was applied, but
-- an inference sample written by an intermediate successor can have neither
-- that id nor the row's current id. session_turns already records the exact
-- native-id -> coord-owner mapping for file-backed CLI transcripts; use that
-- indexed bridge only when it resolves to one owner, while retaining the
-- sample-time and applied-span boundaries below.

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
         ) OR
         (
           EXISTS (
             SELECT 1
               FROM harness_shared.session_turns t
              WHERE (t.workspace_id = u.workspace_id OR t.workspace_id = 'default')
                AND t.source_kind IN ('claude', 'omp', 'codex')
                AND t.session_id = u.session_id
                AND t.owner = s.owner_id
           )
           AND NOT EXISTS (
             SELECT 1
               FROM harness_shared.session_turns t
              WHERE (t.workspace_id = u.workspace_id OR t.workspace_id = 'default')
                AND t.source_kind IN ('claude', 'omp', 'codex')
                AND t.session_id = u.session_id
                AND t.owner IS NOT NULL
                AND t.owner <> s.owner_id
           )
         )
       )
     ORDER BY s.active_from DESC, s.activation_event_id DESC
     LIMIT 1
  ) a ON true;

