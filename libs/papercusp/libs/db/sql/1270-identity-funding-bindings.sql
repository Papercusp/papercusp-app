-- Migration 1270 — local funding state of Cupboard identity releases.
--
-- agent-economy-flywheel-2026-08-30 P-016 (WI-10004280), decision D-011. P-017 reads it too.
--
-- One row per (workspace, identity release). It holds two local facts the activation gate
-- (packages/operator-core/lib/cupboard/identity-activation-gate-io.ts) needs:
--
--   1. The funding channel. Hosted payment channels are escrow held for one principal: the
--      hosted channel row has no seller, offer or release column, and the hosted meter door
--      takes the channelId on every call. Which channel pays for which identity release is
--      therefore the buyer's own routing choice, and channel_id records it. It is written
--      when a per-use checkout preflight returns an identity-release releaseRef
--      ('per-use-checkout'), or by the explicit bind door after the hosted owner-only
--      channel read confirms the channel ('explicit').
--
--   2. The last pricing verdict read from the hosted offers ('free' or 'priced'). It lets
--      a free release keep launching while the hosted Cupboard cannot be reached. A cached
--      'priced' verdict never activates anything by itself: funds are always re-read.
--
-- A channel_id here is NOT evidence of funds. The gate re-reads the channel from the
-- hosted Cupboard (GET /commerce/payment-channels/:channelId) on every activation, so a
-- closed, failed or exhausted channel refuses the next activation whatever this row says.
-- Prepaid credits need no row: they are a balance of the principal.

CREATE TABLE IF NOT EXISTS harness_shared.identity_release_funding (
  workspace_id        text NOT NULL,
  sku_ref             text NOT NULL,
  channel_id          text NULL,
  channel_source      text NULL,
  channel_bound_by    text NULL,
  channel_bound_at    timestamptz NULL,
  pricing_state       text NULL,
  pricing_offer_id    text NULL,
  pricing_unit_micros bigint NULL,
  pricing_checked_at  timestamptz NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, sku_ref),
  CONSTRAINT identity_release_funding_sku_ref_check
    CHECK (sku_ref LIKE 'identity-release:%'),
  CONSTRAINT identity_release_funding_channel_complete
    CHECK ((channel_id IS NULL) = (channel_source IS NULL)
       AND (channel_id IS NULL) = (channel_bound_at IS NULL)
       AND (channel_id IS NULL OR length(btrim(channel_id)) > 0)),
  CONSTRAINT identity_release_funding_channel_source_check
    CHECK (channel_source IS NULL OR channel_source IN ('per-use-checkout', 'explicit')),
  CONSTRAINT identity_release_funding_pricing_check
    CHECK (
      (pricing_state IS NULL AND pricing_checked_at IS NULL
         AND pricing_offer_id IS NULL AND pricing_unit_micros IS NULL)
      OR (pricing_state = 'free' AND pricing_checked_at IS NOT NULL
         AND pricing_offer_id IS NULL AND pricing_unit_micros IS NULL)
      OR (pricing_state = 'priced' AND pricing_checked_at IS NOT NULL
         AND pricing_offer_id IS NOT NULL AND pricing_unit_micros > 0)
    )
);

COMMENT ON TABLE harness_shared.identity_release_funding IS
  'agent-economy-flywheel P-016 (D-011): local funding state of one Cupboard identity release in this workspace — the hosted payment channel chosen to pay for it, and the last pricing verdict read from the hosted offers. Never evidence of funds: the activation gate re-reads funds from the hosted Cupboard on every activation.';
COMMENT ON COLUMN harness_shared.identity_release_funding.sku_ref IS
  'identity-release:<identity id>@<version> (cupboard/identity-per-use-offer.ts identityReleaseSkuRef).';
COMMENT ON COLUMN harness_shared.identity_release_funding.pricing_state IS
  'Last verdict read from the hosted offers: free (no active offer names this release) or priced (cheapest verified per-use offer in pricing_offer_id / pricing_unit_micros).';

ALTER TABLE harness_shared.identity_release_funding ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'harness_shared'
       AND tablename = 'identity_release_funding'
       AND policyname = 'identity_release_funding_workspace_isolation'
  ) THEN
    CREATE POLICY identity_release_funding_workspace_isolation
      ON harness_shared.identity_release_funding
      USING (workspace_id = current_setting('app.workspace_id'::text, true))
      WITH CHECK (workspace_id = current_setting('app.workspace_id'::text, true));
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.identity_release_funding TO harness_app;
