import { Hono } from 'hono';
import type { Env } from '../env.ts';
import { listingsRoute } from './listings.ts';
import { reportsRoute } from './reports.ts';
import { bindingRoute } from './binding.ts';
import { adminRoute } from './admin.ts';
import { workspaceHostArtifactsRoute } from './workspace-host-artifacts.ts';
import { creatorDraftsRoute } from './creator-drafts.ts';
import { releaseMirrorRoute } from './release-mirror.ts';
import { commerceRoute } from './commerce.ts';
import { walletBindingRoute } from './wallet-binding.ts';
import { prepaidCreditsRoute } from './prepaid-credits.ts';
import { paymentChannelsRoute } from './payment-channels.ts';
import { meteredUsageRoute } from './metered-usage.ts';
import { settlementsRoute } from './settlements.ts';
import { treasuryRoute } from './treasury.ts';
import type { SafeTreasuryAdapter } from '../treasury-adapter.ts';
import type { PaymentChannelFundingAdapter } from '@papercusp/operator-core/lib/p2p/channel-funding.ts';
import type { EvmSettlementFacilitator } from '@papercusp/operator-core/lib/p2p/evm-settlement.ts';
import type { Organization } from '@papercusp/operator-core/lib/cupboard/commerce-accounts';
import { prepaidCreditCatalogEvents } from '@papercusp/operator-core/lib/cupboard/prepaid-credits.ts';
import { appendLedgerEvents, projectLedger } from '../commerce-store.ts';
import { projectPrepaidCredits } from '../prepaid-credit-store.ts';

/**
 * `fetchImpl` is threaded through to the commerce checkout route so its outbound
 * provider call can be exercised without network access. `loadOrgs` is threaded
 * for the same reason and one more: production has no org writer yet, so the
 * MEMBER-permitted branch of the checkout authorization gate is only reachable
 * from a test until one lands, and an unexercised authorization branch is the
 * one that rots. Production calls `buildApi()` with no options and gets the
 * runtime's own fetch plus the real (empty) org loader.
 */
export function buildApi(
  options: {
    fetchImpl?: typeof fetch;
    loadOrgs?: (db: D1Database) => Promise<ReadonlyMap<string, Organization>>;
    paymentChannelAdapter?: PaymentChannelFundingAdapter;
    settlementFacilitator?: EvmSettlementFacilitator;
    treasuryAdapter?: SafeTreasuryAdapter;
  } = {},
): Hono<{ Bindings: Env }> {
  const api = new Hono<{ Bindings: Env }>();
  api.get('/', (c) => c.json({ service: 'papercusp-cupboard', status: 'ok' }));
  api.get('/healthz', (c) => c.json({ ok: true }));
  // Generalized storefront: /listings (kind-aware) + /harnesses (kind='harness' view).
  api.route('/', listingsRoute());
  api.route('/', reportsRoute());
  api.route('/', bindingRoute());
  api.route('/', adminRoute());
  api.route('/', workspaceHostArtifactsRoute());
  api.route('/', creatorDraftsRoute());
  // Public mirror publication (P-045). Shares `fetchImpl` with the commerce
  // route for the same reason: its only outbound call is to a third party, and
  // an unexercised credential path is the one that rots.
  api.route('/', releaseMirrorRoute({ fetchImpl: options.fetchImpl }));
  // The top-up SKU is a fixed idempotent catalog fact. Install it immediately
  // before the existing Checkout handler reads the commerce ledger, without
  // modifying that shared route while parallel commerce work is in flight.
  api.use('/commerce/checkout-sessions', async (c, next) => {
    await appendLedgerEvents(c.env.DB, prepaidCreditCatalogEvents());
    await projectLedger(c.env.DB);
    await next();
  });
  // A signed accepted webhook has already updated the commerce authority when
  // control returns here. Rebuild the dependent credit projection before the
  // 200 reaches Stripe. Duplicates run the same repair path, so a prior
  // projection failure is recovered by the provider's normal retry.
  api.use('/commerce/webhooks/*', async (c, next) => {
    await next();
    if (c.res.status === 200) await projectPrepaidCredits(c.env.DB);
  });
  api.route('/', commerceRoute({ fetchImpl: options.fetchImpl, loadOrgs: options.loadOrgs }));
  api.route('/', walletBindingRoute());
  api.route('/', prepaidCreditsRoute());
  api.route('/', paymentChannelsRoute({ adapter: options.paymentChannelAdapter }));
  // P-031 metering interception. Mounted AFTER paymentChannelsRoute because it
  // draws against the durable channel that route funds: a reservation is only
  // meaningful once an escrow exists to exhaust. Its GET
  // /commerce/payment-channels/:channelId/usage sits under the same prefix on
  // purpose — the receipts ARE that channel's committed history.
  api.route('/', meteredUsageRoute());
  // P-033 batch settlement execution. Mounted LAST of the commerce chain
  // because it consumes what the two routes above produce: a funded channel and
  // the settled usage receipts drawn against it. Its POST returns a payment
  // CLAIM; only its /finality transition can report payment finality.
  api.route('/', settlementsRoute({ facilitator: options.settlementFacilitator }));
  // P-034 DAO treasury routing. Mounted after settlementsRoute because it acts
  // on what that route produces and only once it is FINAL: a claim can still be
  // dropped by a reorg, and a transfer out of the Safe cannot be unwound.
  api.route('/', treasuryRoute({ adapter: options.treasuryAdapter }));
  api.onError((err, c) => {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'internal', detail: msg }, 500);
  });
  return api;
}
