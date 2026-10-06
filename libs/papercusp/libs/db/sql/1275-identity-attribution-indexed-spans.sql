-- 1275 — WI-10004451: make identity attribution answerable at month scale.
--
-- Same columns, same rows as 1149/1177; only the evaluation shape changes.
--
-- 1. session_identity_activation_spans drops its lead() window. A window
--    function is a pushdown barrier: a lateral probe that keys spans by
--    anything other than the PARTITION BY columns recomputed the whole
--    workspace's windows once per probing row. The next applied event in the
--    same (workspace_id, owner_id, session_id) partition is now an indexed
--    lookup instead. All four columns are NOT NULL and (recorded_at, id) is a
--    total order, so the lookup returns exactly what lead() returned
--    (measured 2026-09-30: 11,537 rows, EXCEPT ALL empty in both directions).
--
-- 2. agent_usage_samples_identity_attribution keeps 1177's matching rule and
--    evaluates it as two indexed candidate sets. 1177 admits a span when
--    EITHER the sample's session reaches it through a key (native session
--    id, the span's adv_sessions row, or a session_archives row) OR the
--    session's transcript owners are exactly {span.owner_id}. The owner veto
--    guards only that second path: a key match admits the span whoever owns
--    the turns. Let O = the distinct non-null session_turns owners of the
--    sample's session (claude/omp/codex, own or 'default' workspace). So the
--    candidates are the key-reached spans, plus every span owned by X when
--    O = {X}. O depends on (workspace_id, session_id) alone, so the planner
--    memoizes it per session; the owner pick is an index scan backward on
--    session_identity_activation_applied_time_idx. 1177 took >30s for one
--    hour of samples; this form answers the same hour in well under 1s.
--    (A first draft also applied the veto to the key paths; a stratified
--    8,039-row comparison against 1177 caught 205 dropped attributions.)
--
-- 1177 selected `u.*`, which expands at CREATE time. agent_usage_samples has
-- since gained columns (usage_event_key, ...), so the usage columns are listed
-- explicitly: CREATE OR REPLACE VIEW may not reorder or insert columns.
--
-- Existing grants and comments survive CREATE OR REPLACE VIEW.
-- The migration runner supplies the transaction; keep this file psql-free.

CREATE INDEX IF NOT EXISTS session_identity_activation_applied_adv_idx
  ON harness_shared.session_identity_activation_events (adv_session_id)
  WHERE phase = 'applied' AND adv_session_id IS NOT NULL;

CREATE OR REPLACE VIEW harness_shared.session_identity_activation_spans AS
SELECT e.id AS activation_event_id,
       e.workspace_id, e.owner_id, e.actor_id, e.principal_id, e.session_id,
       e.adv_session_id, e.native_session_id, e.transition_id,
       e.control_generation, e.source, e.specification_revision,
       e.state_revision, e.stack_refs, e.recorded_at AS active_from,
       CASE
         WHEN nx.recorded_at IS NULL THEN s.ended_at
         WHEN s.ended_at IS NULL THEN nx.recorded_at
         ELSE LEAST(nx.recorded_at, s.ended_at)
       END AS active_until
  FROM harness_shared.session_identity_activation_events e
  LEFT JOIN LATERAL (
    SELECT e2.recorded_at
      FROM harness_shared.session_identity_activation_events e2
     WHERE e2.phase = 'applied'
       AND e2.workspace_id = e.workspace_id
       AND e2.owner_id = e.owner_id
       AND e2.session_id = e.session_id
       AND (e2.recorded_at, e2.id) > (e.recorded_at, e.id)
     ORDER BY e2.recorded_at, e2.id
     LIMIT 1
  ) nx ON true
  LEFT JOIN harness_shared.adv_sessions s ON s.id = e.adv_session_id
 WHERE e.phase = 'applied';

CREATE OR REPLACE VIEW harness_shared.agent_usage_samples_identity_attribution AS
SELECT u.id, u.workspace_id, u.ts, u.bucket_key, u.provider, u.model_class,
       u.source, u.input_tokens, u.output_tokens, u.cache_read_tokens,
       u.cost_usd, u.rl_requests_limit, u.rl_requests_remaining,
       u.rl_tokens_limit, u.rl_tokens_remaining, u.rl_reset_at, u.model,
       u.cost_source, u.harness_slug, u.run_id, u.role,
       u.cache_creation_tokens, u.turn_count, u.session_id, u.tool_name,
       u.turn_trigger, u.account_id, u.goal_id,
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
    SELECT count(DISTINCT t.owner) AS owner_count,
           min(t.owner) AS sole_owner
      FROM harness_shared.session_turns t
     WHERE u.session_id IS NOT NULL
       AND t.session_id = u.session_id
       AND (t.workspace_id = u.workspace_id OR t.workspace_id = 'default')
       AND t.source_kind IN ('claude', 'omp', 'codex')
       AND t.owner IS NOT NULL
  ) o ON true
  LEFT JOIN LATERAL (
    SELECT c.*
      FROM (
        -- O = {X}: every span X owns (the session_turns path).
        SELECT s.*
          FROM harness_shared.session_identity_activation_spans s
         WHERE o.owner_count = 1
           AND s.workspace_id = u.workspace_id
           AND s.owner_id = o.sole_owner
        UNION ALL
        -- Any O: spans reachable through the session's own keys. The owner
        -- veto does not apply here (1177 ORs these paths with the owner one).
        SELECT s.*
          FROM (
            SELECT e.id
              FROM harness_shared.session_identity_activation_events e
             WHERE e.phase = 'applied'
               AND e.workspace_id = u.workspace_id
               AND e.native_session_id = u.session_id
            UNION
            SELECT e.id
              FROM harness_shared.adv_sessions av
              JOIN harness_shared.session_identity_activation_events e
                ON e.adv_session_id = av.id
             WHERE av.session_id = u.session_id
               AND e.phase = 'applied'
               AND e.workspace_id = u.workspace_id
            UNION
            SELECT e.id
              FROM harness_shared.session_archives ar
              JOIN harness_shared.session_identity_activation_events e
                ON e.adv_session_id = ar.adv_session_id
             WHERE ar.session_id = u.session_id
               AND e.phase = 'applied'
               AND e.workspace_id = u.workspace_id
          ) k
          CROSS JOIN LATERAL (
            SELECT sp.*
              FROM harness_shared.session_identity_activation_spans sp
             WHERE sp.activation_event_id = k.id
          ) s
         WHERE u.session_id IS NOT NULL
      ) c
     WHERE c.active_from <= to_timestamp((u.ts::numeric / 1000.0)::double precision)
       AND (c.active_until IS NULL
            OR to_timestamp((u.ts::numeric / 1000.0)::double precision) < c.active_until)
     ORDER BY c.active_from DESC, c.activation_event_id DESC
     LIMIT 1
  ) a ON true;

COMMENT ON VIEW harness_shared.agent_usage_samples_identity_attribution IS
  'Inference usage samples with the applied identity span active at sample time (1177 rule; 1275 evaluates it per turn-owner case so month-scale reads are index-driven).';
