-- 779-fleet-brief-snapshots.sql
--
-- fleet-lead-instrumentation-audit-2026-08-09 P-022 / D-011 — the wake boundary behind
-- `fleet:leader-brief`'s delta block.
--
-- P-022: "Every wake I reconstructed 'what changed' by hand from checkpoint prose: members
-- gained/lost, items closed, spec revision, capacity movement." Two of those four axes needed
-- no storage at all and are derived live against a timestamp (`fleet_membership_events` for
-- members ±N; `work_items:burn_down { since }` for closes +N, which already ships the delta
-- with a four-way attribution split). This table exists ONLY for the two that have no durable
-- history: the account-pool `factor`, computed live and never recorded, and the PRIOR claim-spec
-- `revision` (bee_claim_specs/cup_claim_specs keep current-value-only, so "rev X→Y" can report Y
-- but not X without a snapshot).
--
-- KEYED (workspace_id, fleet_slug, owner_id) — per-LEADER, not per-fleet (D-011 §4). A per-fleet
-- row would let two readers of the same fleet consume each other's baseline, so whichever read
-- second would see a spuriously empty delta. That is the same self-blinding failure P-006 hit,
-- where a repair wrote to the very record its own falsifier reads.
--
-- TWO SLOTS, rotated per WAKE and not per READ. `observation` is what this wake saw; `baseline`
-- is what the PREVIOUS wake saw and is what the delta is computed against. Rotation
-- (baseline := observation, observation := now) fires only when `fire_count` advances, so a
-- second brief read inside one wake returns the SAME delta instead of a freshly-zeroed one.
-- `fire_count` NULL means the caller had no armed loop: there is then no wake boundary to key
-- on, and the brief labels the boundary per-read rather than pretending otherwise.
--
-- Deliberately NOT stored in: `coord_watermarks` (its Watermark type lives in the generic
-- borrowable lib libs/generic/pubsub-substrate — a papercusp fleet snapshot there is a domain
-- leak — and its writes are deliberately non-monotonic for at-least-once redelivery, the wrong
-- contract for a value snapshot); `agent_fleets` (PK has no per-leader dimension, see above);
-- routine metadata (a leader need not have a loop, and mutable routine metadata is already the
-- sole record of loop disarms with no audit trail).

CREATE TABLE IF NOT EXISTS harness_shared.fleet_brief_snapshots (
    workspace_id text        NOT NULL DEFAULT 'default',
    fleet_slug   text        NOT NULL,
    owner_id     text        NOT NULL,
    -- The loop fire this row was last rotated at. NULL = the reader has no armed loop, so the
    -- boundary is per-read; the brief reports that rather than implying a wake.
    fire_count   bigint,
    -- What the PREVIOUS wake observed. The delta is computed against this. NULL on the first
    -- ever read for this (fleet, leader) — reported as `available:false`, never as a zero delta.
    baseline     jsonb,
    -- What THIS wake observed; becomes `baseline` at the next rotation.
    observation  jsonb       NOT NULL,
    rotated_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT fleet_brief_snapshots_ws_nonempty    CHECK (workspace_id <> ''),
    CONSTRAINT fleet_brief_snapshots_fleet_nonempty CHECK (fleet_slug <> ''),
    CONSTRAINT fleet_brief_snapshots_owner_nonempty CHECK (owner_id <> ''),
    PRIMARY KEY (workspace_id, fleet_slug, owner_id)
);

COMMENT ON TABLE harness_shared.fleet_brief_snapshots IS
  'Per-(workspace, fleet, leader) wake-boundary snapshot backing fleet:leader-brief''s delta block (fleet-lead-instrumentation-audit-2026-08-09 P-022 / D-011). Holds ONLY the axes with no durable history — account-pool factor and the prior claim-spec revision; members ±N and closes +N are derived live from fleet_membership_events and the burn-down delta. Two slots (baseline/observation) rotated when fire_count advances, so repeated reads within one wake return a stable delta instead of a zeroed one.';

COMMENT ON COLUMN harness_shared.fleet_brief_snapshots.fire_count IS
  'Loop fire this row was last rotated at; NULL = caller has no armed loop, so the brief labels its boundary per-read rather than per-wake.';

COMMENT ON COLUMN harness_shared.fleet_brief_snapshots.baseline IS
  'The PREVIOUS wake''s observation — what the delta is computed against. NULL on a first read, which the brief reports as available:false, never as delta 0.';

COMMENT ON COLUMN harness_shared.fleet_brief_snapshots.observation IS
  'THIS wake''s observation; becomes baseline at the next rotation.';
