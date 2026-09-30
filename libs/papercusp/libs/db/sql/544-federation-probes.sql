-- 544-federation-probes.sql — self-verifying federation probes
-- (fleet-reliability-verification-2026-07-10 P-010, WI-3812).
--
-- Root lesson (2026-07-10 cause #10): ALL prior ad-hoc "v2t" liveness probes
-- (hand-written marker ops, e.g. the `p059:v2t:wakeN-<agent>` convention in
-- shared-pot-federation-diagnosis-toolkit.mdx) were UNSTAMPED — nothing forced
-- them to carry the keys (workspace_id, harness_slug) required to prove they
-- actually rode the real federation pipeline, so "green" was unreachable by
-- construction for ~6h and nothing said so.
--
-- This table is the durable receipt for a `probe:emit`-created probe: the
-- STAMPED declaration (probe_key, workspace_id, harness_slug, emitted_by) plus
-- one nullable timestamp per named pipeline hop (capture -> drain -> replicate
-- -> merge -> member_guard -> project). `probe:get` derives a verdict from
-- which hops are filled — "a probe failure NAMES its hop" (P-010).
--
-- Idempotent. Applied via the runner (db:migrate) so schema_migrations records it.

CREATE TABLE IF NOT EXISTS harness_shared.federation_probes (
  id             bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id   text        NOT NULL,
  harness_slug   text        NOT NULL,
  probe_key      text        NOT NULL, -- stamped, direction-unique v2t-style key
  emitted_by     text        NOT NULL, -- ownerId of the agent that called probe:emit
  emitted_at     timestamptz NOT NULL DEFAULT now(),
  -- Per-hop receipts — each NULL until that hop is recorded. capture is always
  -- stamped by probe:emit itself (a probe only ever exists once captured).
  captured_at      timestamptz,
  drained_at       timestamptz,
  replicated_at    timestamptz,
  merged_at        timestamptz,
  member_guard_at  timestamptz,
  projected_at     timestamptz,
  -- Terminal state: 'pending' (still in flight) | 'acked' (every expected hop
  -- landed) | 'refused' (emit itself refused — see refusal_reason) | 'timed_out'
  -- (a caller/sweep gave up waiting on a stalled hop).
  status         text        NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'acked', 'refused', 'timed_out')),
  refusal_reason text,       -- set iff status='refused' (e.g. 'harness_not_federated')
  detail         text        -- free-form human note, e.g. what the last hop observed
);

-- probe:get / probe:record-hop lookup by the stamped key (globally unique —
-- collisions are refused loudly by probe:emit, never silently overwritten).
CREATE UNIQUE INDEX IF NOT EXISTS federation_probes_probe_key
  ON harness_shared.federation_probes (probe_key);

-- Recency listing per (workspace, harness) — status dashboards / sweeps.
CREATE INDEX IF NOT EXISTS federation_probes_recent
  ON harness_shared.federation_probes (workspace_id, harness_slug, emitted_at DESC);
