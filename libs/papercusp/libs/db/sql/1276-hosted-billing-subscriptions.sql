-- Migration 1276 — hosted organization subscription billing through Stripe
-- (stripe-subscription-signup-2026-10-01 P-002; papercusp-monetization-2026-09-04
-- P-012 built early under D-010).
--
-- Three hosted_service-owned relations, all additive:
--   * hosted_billing_customers      — exactly one Stripe customer per organization;
--   * hosted_subscriptions          — subscription facts as order-independent
--                                     max-registers (see the ORDER KEY note below);
--   * hosted_billing_webhook_events — signed-delivery idempotency ledger (event id +
--                                     body digest, replay-mismatch detectable).
-- Entitlements are deliberately NOT persisted here: what a subscription entitles
-- is computed on read through HostedSubscriptionEntitlementProvider, so the
-- metering work can replace the stub without a data migration.
-- No credential, token or card material is stored; the guard at the bottom
-- refuses any such column.
-- FORWARD-COMPAT: all relations and indexes below are new; no existing hosted
-- relation, constraint or uniqueness contract is narrowed.

CREATE SCHEMA IF NOT EXISTS papercusp_auth;

CREATE TABLE IF NOT EXISTS papercusp_auth.hosted_billing_customers (
  organization_id     uuid PRIMARY KEY,
  stripe_customer_id  text NOT NULL,
  livemode            boolean NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hosted_billing_customers_customer_ck CHECK (stripe_customer_id ~ '^cus_[A-Za-z0-9]+$')
);
CREATE UNIQUE INDEX IF NOT EXISTS hosted_billing_customers_customer_idx
  ON papercusp_auth.hosted_billing_customers (stripe_customer_id);

-- ORDER KEY: Stripe does not deliver events in order. Each subscription row holds
-- two independent max-registers. The subscription register is replaced only when
-- the incoming (sub_terminal, sub_event_created, sub_status_rank, sub_event_id)
-- tuple is GREATER than the stored one; the invoice register likewise on
-- (invoice_event_created, invoice_event_id). Max is commutative, so the final row
-- is the same for every delivery order. Terminal statuses (canceled,
-- incomplete_expired) sort above everything, so a late-arriving older update can
-- never resurrect a canceled subscription.
CREATE TABLE IF NOT EXISTS papercusp_auth.hosted_subscriptions (
  stripe_subscription_id text PRIMARY KEY,
  organization_id        uuid NOT NULL,
  stripe_customer_id     text NOT NULL,
  livemode               boolean NOT NULL,
  status                 text NOT NULL DEFAULT 'pending',
  price_id               text,
  plan_key               text,
  current_period_end     timestamptz,
  cancel_at_period_end   boolean NOT NULL DEFAULT false,
  canceled_at            timestamptz,
  sub_terminal           boolean NOT NULL DEFAULT false,
  sub_event_created      timestamptz NOT NULL DEFAULT 'epoch',
  sub_status_rank        integer NOT NULL DEFAULT -1,
  sub_event_id           text NOT NULL DEFAULT '',
  latest_invoice_id      text,
  latest_invoice_status  text,
  invoice_event_created  timestamptz NOT NULL DEFAULT 'epoch',
  invoice_event_id       text NOT NULL DEFAULT '',
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hosted_subscriptions_id_ck CHECK (stripe_subscription_id ~ '^sub_[A-Za-z0-9]+$'),
  CONSTRAINT hosted_subscriptions_customer_ck CHECK (stripe_customer_id ~ '^cus_[A-Za-z0-9]+$'),
  CONSTRAINT hosted_subscriptions_status_ck CHECK (status IN (
    'pending', 'incomplete', 'incomplete_expired', 'trialing', 'active',
    'past_due', 'canceled', 'unpaid', 'paused'
  )),
  CONSTRAINT hosted_subscriptions_invoice_status_ck CHECK (
    latest_invoice_status IS NULL OR latest_invoice_status IN ('paid', 'payment_failed')
  )
);
CREATE INDEX IF NOT EXISTS hosted_subscriptions_organization_idx
  ON papercusp_auth.hosted_subscriptions (organization_id, sub_terminal, sub_event_created DESC);

CREATE TABLE IF NOT EXISTS papercusp_auth.hosted_billing_webhook_events (
  provider_event_id  text PRIMARY KEY,
  event_type         text NOT NULL,
  body_digest        text NOT NULL,
  livemode           boolean NOT NULL,
  outcome            text NOT NULL,
  rejection_code     text,
  organization_id    uuid,
  received_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hosted_billing_webhook_events_id_ck CHECK (provider_event_id ~ '^evt_[A-Za-z0-9]+$'),
  CONSTRAINT hosted_billing_webhook_events_digest_ck CHECK (body_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT hosted_billing_webhook_events_outcome_ck CHECK (outcome IN ('applied', 'ignored', 'rejected')),
  CONSTRAINT hosted_billing_webhook_events_rejection_ck CHECK (
    (outcome = 'rejected' AND rejection_code IS NOT NULL) OR (outcome <> 'rejected' AND rejection_code IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS hosted_billing_webhook_events_received_idx
  ON papercusp_auth.hosted_billing_webhook_events (received_at DESC);

COMMENT ON TABLE papercusp_auth.hosted_billing_customers IS
  'One Stripe customer per hosted organization (stripe-subscription-signup-2026-10-01). No payment credentials.';
COMMENT ON TABLE papercusp_auth.hosted_subscriptions IS
  'Order-independent Stripe subscription facts per hosted organization; entitlements are computed on read by the HostedSubscriptionEntitlementProvider seam.';
COMMENT ON TABLE papercusp_auth.hosted_billing_webhook_events IS
  'Idempotency ledger for signed Stripe billing webhooks: event id + body digest; a replay with different bytes is refused.';

ALTER TABLE papercusp_auth.hosted_billing_customers OWNER TO hosted_owner;
ALTER TABLE papercusp_auth.hosted_subscriptions OWNER TO hosted_owner;
ALTER TABLE papercusp_auth.hosted_billing_webhook_events OWNER TO hosted_owner;
ALTER TABLE papercusp_auth.hosted_billing_customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE papercusp_auth.hosted_billing_customers FORCE ROW LEVEL SECURITY;
ALTER TABLE papercusp_auth.hosted_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE papercusp_auth.hosted_subscriptions FORCE ROW LEVEL SECURITY;
ALTER TABLE papercusp_auth.hosted_billing_webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE papercusp_auth.hosted_billing_webhook_events FORCE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE
  papercusp_auth.hosted_billing_customers,
  papercusp_auth.hosted_subscriptions,
  papercusp_auth.hosted_billing_webhook_events
FROM PUBLIC, harness_app, harness_zero, harness_admin, hosted_app, hosted_service;
GRANT SELECT, INSERT, UPDATE ON
  papercusp_auth.hosted_billing_customers,
  papercusp_auth.hosted_subscriptions,
  papercusp_auth.hosted_billing_webhook_events
TO hosted_service;

DROP POLICY IF EXISTS hosted_billing_customers_service_all ON papercusp_auth.hosted_billing_customers;
CREATE POLICY hosted_billing_customers_service_all ON papercusp_auth.hosted_billing_customers
  FOR ALL TO hosted_service USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS hosted_subscriptions_service_all ON papercusp_auth.hosted_subscriptions;
CREATE POLICY hosted_subscriptions_service_all ON papercusp_auth.hosted_subscriptions
  FOR ALL TO hosted_service USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS hosted_billing_webhook_events_service_all ON papercusp_auth.hosted_billing_webhook_events;
CREATE POLICY hosted_billing_webhook_events_service_all ON papercusp_auth.hosted_billing_webhook_events
  FOR ALL TO hosted_service USING (true) WITH CHECK (true);

DO $mig1276$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'papercusp_auth'
       AND table_name IN ('hosted_billing_customers', 'hosted_subscriptions', 'hosted_billing_webhook_events')
       AND column_name ~* '(password|secret|token|credential|cookie|card|cvc|iban)'
  ) THEN
    RAISE EXCEPTION '1276: hosted billing tables contain forbidden credential columns';
  END IF;
  IF NOT has_table_privilege('hosted_service', 'papercusp_auth.hosted_billing_customers', 'SELECT, INSERT, UPDATE')
     OR NOT has_table_privilege('hosted_service', 'papercusp_auth.hosted_subscriptions', 'SELECT, INSERT, UPDATE')
     OR NOT has_table_privilege('hosted_service', 'papercusp_auth.hosted_billing_webhook_events', 'SELECT, INSERT, UPDATE') THEN
    RAISE EXCEPTION '1276: hosted_service billing DML surface is incomplete';
  END IF;
END
$mig1276$;
