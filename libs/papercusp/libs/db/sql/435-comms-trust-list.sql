-- 435-comms-trust-list.sql
-- cross-machine-coord-parity-and-trust-2026-07-01 P-011 (D-003/D-004): the
-- owner's LOCAL per-user COMMS-TRUST tiers — the coordination twin of
-- user_trust_list (which governs auto-RUN of verified remote work; this
-- governs what another hive member's agents may do to YOUR agents' attention
-- and spend across the federation boundary).
--
-- Tier lattice (D-004): observe < message < wake < steer.
--   observe — their content federates; you see broadcasts (inherent to
--             membership; a row at this tier is an explicit DOWNGRADE).
--   message — may inject into your agents' inboxes.
--   wake    — may re-invoke your sleeping agents (BILLABLE turns).
--   steer   — handoffs / work assignment / scheduler specs targeting your agents.
--
-- Resolution (comms-trust.ts effectiveCommsTier): this local override wins;
-- else the hive policy's owner-signed default (hive_policy.comms.defaultTier,
-- P-012); else the conservative fallback. Enforcement is RECEIVER-SIDE at the
-- projection chokepoint (P-013) keyed on the VERIFIED author github_user_id
-- from the source-log attestation chain — never the spoofable envelope fields.
--
-- LOCAL-ONLY / NEVER FEDERATED (the user_trust_list D-001 posture): no capture
-- trigger, no projection tag — federating a trust grant would let a peer
-- influence who may spend your tokens. Workspace-scoped everywhere (D-004:
-- reads run via the RLS-bypassing admin handle).

BEGIN;

CREATE TABLE IF NOT EXISTS harness_shared.comms_trust_list (
    workspace_id           text NOT NULL DEFAULT '',
    trusted_github_user_id bigint NOT NULL,
    tier                   text NOT NULL CHECK (tier IN ('observe', 'message', 'wake', 'steer')),
    note                   text,
    -- Optional expiry: an expired override is IGNORED at resolution (falls
    -- through to the policy default) — grants can be probationary.
    expires_at             timestamptz,
    created_ts             bigint NOT NULL,
    updated_ts             bigint NOT NULL,
    PRIMARY KEY (workspace_id, trusted_github_user_id)
);

COMMENT ON TABLE harness_shared.comms_trust_list IS
  'Per-user comms-trust tier overrides (P-011, cross-machine-coord-parity-and-trust-2026-07-01). LOCAL-ONLY, never federated. Tier lattice observe<message<wake<steer; resolution = local override ?? hive_policy.comms.defaultTier ?? fallback; enforced receiver-side (P-013) on the verified author identity.';

COMMIT;
