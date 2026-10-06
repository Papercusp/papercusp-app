# Hosted subscription billing: the Stripe signup flow, its entitlement seam, and how to test it for real
URL: /internal/docs/agent-insights/hosted-subscription-billing-seam

How app.papercusp.com organizations subscribe through Stripe (Checkout, signed webhooks, customer portal), where each piece lives, the one entitlement seam metering plugs into, and a verified recipe for a real Stripe test-mode end-to-end run.

A *subscription* here is a recurring Stripe subscription owned by **one hosted organization** (`papercusp_auth.organizations`). It is not a Cupboard listing purchase and not agent-economy metering (plan `stripe-subscription-signup-2026-10-01` D-001).

## Where each piece lives

| Concern                                                                                                                                        | File                                                                                                             |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Stripe REST client (no SDK). Reuses Cupboard's form encoding and signature check. Refuses `sk_live_` keys unless live mode is allowed.         | `packages/operator-core/lib/auth/hosted/billing/stripe-billing-client.ts`                                        |
| Event parser: Stripe JSON to typed facts (`subscription`, `checkout`, `invoice`)                                                               | `.../billing/stripe-billing-events.ts`                                                                           |
| Postgres store: customer map, order-independent subscription state, webhook idempotency, entitlement projection                                | `.../billing/billing-store.ts` (schema: migration `1276-hosted-billing-subscriptions.sql`)                       |
| Entitlement seam (`HostedSubscriptionEntitlementProvider`)                                                                                     | `.../billing/entitlement-seam.ts`                                                                                |
| Routes: `GET plans` (public), `GET subscription`, `POST checkout` and `POST portal` (`billing:manage`), `POST webhook` (public, Stripe-signed) | `packages/operator-core/lib/endpoint-route/routes/hosted-billing/index.ts`                                       |
| Runtime composition: config from env, secret refs, principal resolution, Hono app                                                              | `packages/operator-core/lib/endpoint-route/hosted-billing-runtime.ts`                                            |
| Portal host wiring and UI (`/billing`)                                                                                                         | `portal/apps/host/src/hosted-auth.ts`, `portal/packages/ui/src/billing.tsx`, `portal/e2e/portal-billing.spec.ts` |

Configuration is env-only. Secrets are passed as *refs* and never as values: `PAPERCUSP_STRIPE_SECRET_KEY_REF` and `PAPERCUSP_STRIPE_WEBHOOK_SECRET_REF` (`file:` / `env:`). The rest is plain config: `PAPERCUSP_HOSTED_BILLING_PLANS` (a JSON list of `{planKey, priceId, label, description?}`), `PAPERCUSP_STRIPE_PORTAL_CONFIGURATION_ID` (`bpc_...`, optional) and `PAPERCUSP_HOSTED_PUBLIC_ORIGIN`. A malformed value throws `hosted_billing_configuration_invalid:<VAR>`; it never silently degrades to an empty plan list. Missing keys leave the runtime `configured:false` with an `unavailableReason`, which the UI shows as copy.

## Invariants worth knowing before you touch it

* **The webhook reducer is order-independent.** Stripe delivers events out of order and retries them. The store keys subscription state by Stripe subscription id and applies an event only if it is newer than the last one applied. Dedupe and apply happen in one transaction keyed by event id plus body digest, so a replay with different bytes is answered `409 replay-mismatch`. Never rewrite it as last-event-wins.
* **Organization identity rides in Stripe metadata.** Subscription events must carry `metadata.organizationId`; Checkout sets it via `subscription_data.metadata` and `client_reference_id`. A subscription created any other way without that metadata is recorded as `rejected: missing-organization`, not applied.
* **Mutating routes enforce same-origin** against `PAPERCUSP_HOSTED_PUBLIC_ORIGIN` (`403 cross_origin_blocked`). Any non-browser caller, a probe included, must send a matching `Origin` header.
* **Entitlement is behind ONE seam.** Signup and webhook code depend only on `HostedSubscriptionEntitlementProvider`. The stub maps plan key to a hosted-paid entitlement with unmetered allowances. Metering replaces the provider; it does not edit the reducer.
* **Live mode is owner-gated.** The client refuses `sk_live_` keys unless `liveModeAllowed()` resolves true, which should read the default-OFF owner-authority flag `papercusp-hosted-billing-live-mode`. The portal host injects readPortalBillingLiveMode into the existing runtime (WI-10004514); the owner-authority flag remains default OFF. The cloud-dashboard rollout requires TEST credentials and livemode:false.

## Real Stripe test-mode end-to-end (verified 2026-10-01, 11/11)

Unit and integration tests use fake fetch and fixture events. To prove the whole loop against Stripe itself:

1. Stand up a throwaway database with `createOrgTestDb()` and a `HostedServiceContextRunner` that sets `app.workspace_id` and `SET LOCAL ROLE hosted_service`. Copy it from `billing-store.integration.test.ts`.
2. Compose `createHostedBillingRuntime(readHostedBillingRuntimeConfiguration(env), { resolvePrincipal, runService })` with a principal that carries `activeOrganizationId` and the `workspace:view` + `billing:manage` capabilities. Serve `runtime.app` with `@hono/node-server` on port 0.
3. Run `stripe --project-name papercusp listen --forward-to http://127.0.0.1:<port>/api/hosted/billing/webhook --events checkout.session.completed,customer.subscription.created,customer.subscription.updated,customer.subscription.deleted,invoice.paid,invoice.payment_failed`. The listen signing secret is stable per CLI pairing. Check it equals the stored webhook secret by comparing sha256 hashes, never by printing either value.
4. `POST /checkout` with `{planKey}` returns a `https://checkout.stripe.com/` URL and records the Stripe customer. The maintained API integration proves webhook reduction separately from the hosted Checkout browser journey: attach `pm_card_visa`, then `POST /v1/subscriptions` with the price and `metadata[organizationId]`. The forwarded `customer.subscription.created` and `invoice.paid` events turn `GET /subscription` to `active`.
5. `POST /portal` returns a `https://billing.stripe.com/` URL. A second checkout answers `409 already_subscribed`. `DELETE /v1/subscriptions/:id` produces `customer.subscription.deleted`, and the state becomes `canceled`. Delete the test customer in a `finally` block.

Use the maintained suite `packages/operator-core/lib/auth/hosted/billing/stripe-billing.live.integration.test.ts` instead of the historical scratch probe. Run `PAPERCUSP_STRIPE_TEST_E2E=1 PAPERCUSP_TEST_RUN_HARNESS=papercusp npm run test:file -- packages/operator-core/lib/auth/hosted/billing/stripe-billing.live.integration.test.ts`. It requires the device-specific stripe listen signing secret, which is a different ref from the public cloud webhook signing secret.

## Stripe account identity and deployed browser proof

Set `PAPERCUSP_STRIPE_ACCOUNT_ID` independently of key test/live mode. Runtime initialization reads Stripe `/v1/account` and fails closed with `stripe_account_mismatch` or `stripe_account_unavailable`. The cloud-dashboard TEST rollout pins Papercusp LLC `acct_1UChLcF3Zj0ZNLH5`. Both offer IDs and secret refs live in injected configuration outside the repository. Sandbox prices are test fixtures, not commercial pricing.

The canonical registered Portal is `~/.papercusp-workspaces/papercusp-workspace/.papercusp/apps/portal`. Its opted-in `e2e/portal-billing-live.spec.ts` uses genuine WorkOS TEST password authentication and a persisted sealed session with explicit production self-signup admission. It exercises deployed billing UI, Stripe TEST Checkout and signed webhooks; it does not certify upstream AuthKit signup UI. Run `PORTAL_BILLING_LIVE_E2E=1 npm run test:e2e:browser -- e2e/portal-billing-live.spec.ts --output=test-results/billing-live-YYYYMMDD-HHMM`. Retain per-offer receipts and screenshots before claiming shipment. A registered recipe alone is not passing deployed evidence.

WorkOS `user.created` may project identity before the explicit signup callback. Explicit signup reuses only the active exact subject and matching verified email with no membership history, under the lifecycle ordering lock. Ordinary sign-in remains a membership lookup and never creates a tenant. See WI-10005880 and `self-signup.integration.test.ts` for real Postgres race and refusal guards.
