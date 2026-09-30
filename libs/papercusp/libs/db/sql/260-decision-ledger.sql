-- 260-decision-ledger.sql
--
-- agent-capability-confinement-2026-06-13 B-06 (P-011) ⨯ queen-autonomy-policy-2026-06-13
-- D-012 / P-110: the ACTION-CHOKEPOINT layer of the two-layer Queen decision ledger.
--
-- One compressed row per GOVERNED action, emitted from the shared endpoint dispatch
-- postInvoke seam (lib/decision-ledger). "Complete for actions by construction" once
-- capability-confinement lands: every governed action MUST pass dispatch (see
-- agent-capability-confinement-2026-06-13). This is a DIFFERENT projection from
-- harness_shared.tool_invocations (which records every call incl. reads): the ledger keeps
-- only governed (non-read, tier != 'low') actions by NON-superuser principals, plus the
-- decision-semantics columns (posture / category / risk_tier / reversibility / authority /
-- revert_handle / why / links).
--
-- Forward-design for the consumer briefs (build the schema once, here):
--   * `layer` discriminates 'action' (this B-06 emit) from the future 'disposition' rows
--     (queen-autonomy P-111 / B-13: act/defer/reject/route/no-op + rationale) so both
--     capture layers share ONE queryable ledger + surface (P-113).
--   * risk_tier / reversibility / authority / the authoritative `category` taxonomy come
--     from queen-autonomy B-01 (risk_tier + authority), B-02 (reversibility), and B-04
--     (the 13-category capability->category map). They ship NULLABLE here so those briefs
--     POPULATE them with no follow-on migration; at B-06 `category` carries a coarse
--     capability-group placeholder and the three axes are NULL.
--
-- Volume: a strict subset of tool_invocations (governed actions, non-SU). No RLS (mirrors
-- 251-fleet-ekg / 245-negative-space-demand): the emit + the future ledger resolver scope
-- by workspace_id explicitly.

CREATE TABLE IF NOT EXISTS harness_shared.decision_ledger (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    workspace_id    text NOT NULL,
    harness_slug    text,
    -- which capture layer produced the row (D-012 two-layer model).
    layer           text NOT NULL DEFAULT 'action',
    ts              timestamptz NOT NULL DEFAULT now(),

    -- the governed action: the tool name + its declared capability + the derived tier.
    action          text NOT NULL,
    capability      text,
    tier            text,
    -- coarse functional-domain category (capability group). The AUTHORITATIVE 13-category
    -- taxonomy + capability->category map is queen-autonomy B-04 (P-015 / P-020); this is a
    -- best-effort placeholder until that lands.
    category        text,

    -- the three autonomy axes (queen-autonomy D-002). NULLABLE: populated by B-01
    -- (risk_tier + authority) and B-02 (reversibility); NULL at B-06.
    risk_tier       text,
    reversibility   text,
    authority       text,

    -- posture: how the chokepoint handled the governed action.
    --   auto     — within the capability envelope (or envelope not applied), ran.
    --   proposed — the Queen proposed it for owner ratification (decider layer, B-13).
    --   gated    — beyond the envelope, enforcement OFF: would-deny, observed only (B-06 shadow).
    --   rejected — beyond the envelope, enforcement ON: denied by the dispatch gate.
    posture         text NOT NULL,
    -- outcome of the underlying call (rejected actions never ran -> 'error' + outcome_code).
    outcome         text NOT NULL,
    outcome_code    text,

    -- a handle a future tripwire (queen-autonomy P-080) can use to auto-revert. NULL at B-06.
    revert_handle   text,
    -- short human "why" (e.g. the envelope-deny reason). NULL when not applicable.
    why             text,
    -- provenance links: { runId, spawnId, parentSpawnId, featureId, chunkId, uiClientId, reaction }.
    links           jsonb,

    -- actor identity.
    actor_role      text,
    actor_spawn_id  text,
    actor_principal text,

    -- the dispatch transport (http|mcp|ipc|in_process) + call duration.
    transport       text,
    duration_ms     integer,
    -- a digest of the call args (never the full args -- those live in tool_invocations.args_json).
    args_digest     text,
    metadata        jsonb,

    CONSTRAINT decision_ledger_layer_check
      CHECK (layer IN ('action', 'disposition')),
    CONSTRAINT decision_ledger_posture_check
      CHECK (posture IN ('auto', 'proposed', 'gated', 'rejected')),
    CONSTRAINT decision_ledger_outcome_check
      CHECK (outcome IN ('ok', 'error'))
);

CREATE INDEX IF NOT EXISTS decision_ledger_ws_ts_idx
  ON harness_shared.decision_ledger (workspace_id, ts DESC);
CREATE INDEX IF NOT EXISTS decision_ledger_ws_category_idx
  ON harness_shared.decision_ledger (workspace_id, category, ts DESC);
CREATE INDEX IF NOT EXISTS decision_ledger_ws_posture_idx
  ON harness_shared.decision_ledger (workspace_id, posture, ts DESC);

GRANT SELECT, INSERT, UPDATE, DELETE
  ON harness_shared.decision_ledger TO harness_app;
GRANT USAGE, SELECT
  ON SEQUENCE harness_shared.decision_ledger_id_seq TO harness_app;
DO $z$ BEGIN
  GRANT SELECT ON harness_shared.decision_ledger TO harness_zero;
EXCEPTION WHEN undefined_object THEN NULL;
END $z$;
