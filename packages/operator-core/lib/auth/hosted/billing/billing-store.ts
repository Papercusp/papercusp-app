/**
 * Postgres store for hosted subscription billing (migration 1276), run in the
 * hosted-service context.
 *
 * Webhook application is ONE transaction: the idempotency row and every fact
 * it carries commit or roll back together, so a crash between "recorded" and
 * "applied" cannot strand an event as a false duplicate (the cupboard
 * `webhook-inbox.ts` records before applying; only its digest/replay semantics
 * are reused here).
 *
 * Subscription facts are order-independent max-registers: see
 * `subscriptionOrderKey` (stripe-billing-events.ts) — the SQL row comparison
 * below is the same lexicographic order, with event ids compared under the "C"
 * collation so JavaScript and Postgres agree byte-for-byte.
 *
 * stripe-subscription-signup-2026-10-01 P-003.
 */
import { withHostedServiceContext } from '@papercusp/db-org';
import type { Sql } from 'postgres';
import type { HostedServiceContextRunner } from '../workos-lifecycle-postgres';
import { isHostedSubscriptionStatus, type HostedSubscriptionSnapshot } from './entitlement-seam';
import { subscriptionOrderKey, type HostedBillingEvent, type HostedBillingFact } from './stripe-billing-events';

export interface HostedBillingCustomer {
  readonly organizationId: string;
  readonly stripeCustomerId: string;
  readonly livemode: boolean;
}

export type HostedBillingApplyOutcome =
  | { readonly outcome: 'applied' | 'ignored'; readonly organizationId: string | null }
  | { readonly outcome: 'duplicate'; readonly organizationId: string | null }
  | { readonly outcome: 'replay-mismatch' }
  | {
    readonly outcome: 'rejected';
    readonly code: 'livemode_mismatch' | 'unknown_customer' | 'organization_mismatch';
    readonly organizationId: string | null;
  };

export interface HostedBillingStore {
  customerFor(organizationId: string): Promise<HostedBillingCustomer | null>;
  /** Insert-or-keep: returns the ONE customer row for the organization (an earlier winner is kept). */
  recordCustomer(customer: HostedBillingCustomer): Promise<HostedBillingCustomer>;
  currentSubscription(
    organizationId: string,
    planKeyForPrice: (priceId: string | null) => string | null,
  ): Promise<HostedSubscriptionSnapshot | null>;
  applyEvent(input: {
    event: HostedBillingEvent;
    bodyDigest: string;
    expectedLivemode: boolean;
    planKeyForPrice: (priceId: string | null) => string | null;
  }): Promise<HostedBillingApplyOutcome>;
  /** Record an authenticated delivery that could not be parsed into facts (so its retries are duplicates). */
  recordRejectedEvent(input: {
    eventId: string;
    eventType: string;
    bodyDigest: string;
    livemode: boolean;
    code: string;
  }): Promise<'recorded' | 'duplicate' | 'replay-mismatch'>;
}

class FactRejection extends Error {
  constructor(readonly code: 'unknown_customer' | 'organization_mismatch', readonly organizationId: string | null) {
    super(code);
  }
}

interface SubscriptionRow {
  stripe_subscription_id: string;
  organization_id: string;
  status: string;
  price_id: string | null;
  current_period_end: Date | string | null;
  cancel_at_period_end: boolean;
  canceled_at: Date | string | null;
  livemode: boolean;
  latest_invoice_status: string | null;
}

const toDate = (v: Date | string | null): Date | null => (v === null ? null : v instanceof Date ? v : new Date(v));

export class PostgresHostedBillingStore implements HostedBillingStore {
  constructor(private readonly run: HostedServiceContextRunner = (fn) => withHostedServiceContext(fn)) {}

  async customerFor(organizationId: string): Promise<HostedBillingCustomer | null> {
    return this.run(async (sql) => {
      const rows = await sql<Array<{ stripe_customer_id: string; livemode: boolean }>>`
        SELECT stripe_customer_id, livemode
          FROM papercusp_auth.hosted_billing_customers
         WHERE organization_id = ${organizationId}::uuid
      `;
      return rows[0] ? { organizationId, stripeCustomerId: rows[0].stripe_customer_id, livemode: rows[0].livemode } : null;
    });
  }

  async recordCustomer(customer: HostedBillingCustomer): Promise<HostedBillingCustomer> {
    return this.run(async (sql) => {
      await sql`
        INSERT INTO papercusp_auth.hosted_billing_customers (organization_id, stripe_customer_id, livemode)
        VALUES (${customer.organizationId}::uuid, ${customer.stripeCustomerId}, ${customer.livemode})
        ON CONFLICT (organization_id) DO NOTHING
      `;
      const rows = await sql<Array<{ stripe_customer_id: string; livemode: boolean }>>`
        SELECT stripe_customer_id, livemode
          FROM papercusp_auth.hosted_billing_customers
         WHERE organization_id = ${customer.organizationId}::uuid
      `;
      if (!rows[0]) throw new Error('hosted_billing_customer_unavailable');
      return { organizationId: customer.organizationId, stripeCustomerId: rows[0].stripe_customer_id, livemode: rows[0].livemode };
    });
  }

  async currentSubscription(
    organizationId: string,
    planKeyForPrice: (priceId: string | null) => string | null,
  ): Promise<HostedSubscriptionSnapshot | null> {
    return this.run(async (sql) => {
      // The organization's CURRENT subscription: any live one beats every
      // terminal one; among equals, the most recently changed.
      const rows = await sql<SubscriptionRow[]>`
        SELECT stripe_subscription_id, organization_id::text AS organization_id, status, price_id,
               current_period_end, cancel_at_period_end, canceled_at, livemode, latest_invoice_status
          FROM papercusp_auth.hosted_subscriptions
         WHERE organization_id = ${organizationId}::uuid
         ORDER BY sub_terminal ASC, sub_event_created DESC, stripe_subscription_id COLLATE "C" DESC
         LIMIT 1
      `;
      const row = rows[0];
      if (!row || !isHostedSubscriptionStatus(row.status)) return null;
      return {
        organizationId: row.organization_id,
        stripeSubscriptionId: row.stripe_subscription_id,
        status: row.status,
        planKey: planKeyForPrice(row.price_id),
        priceId: row.price_id,
        currentPeriodEnd: toDate(row.current_period_end),
        cancelAtPeriodEnd: row.cancel_at_period_end,
        canceledAt: toDate(row.canceled_at),
        livemode: row.livemode,
        latestInvoiceStatus: row.latest_invoice_status === 'paid' || row.latest_invoice_status === 'payment_failed'
          ? row.latest_invoice_status
          : null,
      };
    });
  }

  async recordRejectedEvent(input: {
    eventId: string;
    eventType: string;
    bodyDigest: string;
    livemode: boolean;
    code: string;
  }): Promise<'recorded' | 'duplicate' | 'replay-mismatch'> {
    return this.run(async (sql) => {
      const inserted = await sql`
        INSERT INTO papercusp_auth.hosted_billing_webhook_events
          (provider_event_id, event_type, body_digest, livemode, outcome, rejection_code)
        VALUES (${input.eventId}, ${input.eventType}, ${input.bodyDigest}, ${input.livemode}, 'rejected', ${input.code})
        ON CONFLICT (provider_event_id) DO NOTHING
        RETURNING provider_event_id
      `;
      if (inserted.length) return 'recorded';
      return (await priorDigest(sql, input.eventId)) === input.bodyDigest ? 'duplicate' : 'replay-mismatch';
    });
  }

  async applyEvent(input: {
    event: HostedBillingEvent;
    bodyDigest: string;
    expectedLivemode: boolean;
    planKeyForPrice: (priceId: string | null) => string | null;
  }): Promise<HostedBillingApplyOutcome> {
    const { event, bodyDigest } = input;
    try {
      return await this.run(async (sql) => {
        // Claim the event id first. A concurrent duplicate blocks on the primary
        // key until this transaction ends, then sees the committed row.
        const claimed = await sql`
          INSERT INTO papercusp_auth.hosted_billing_webhook_events
            (provider_event_id, event_type, body_digest, livemode, outcome)
          VALUES (${event.eventId}, ${event.eventType}, ${bodyDigest}, ${event.livemode}, 'ignored')
          ON CONFLICT (provider_event_id) DO NOTHING
          RETURNING provider_event_id
        `;
        if (!claimed.length) {
          const prior = await sql<Array<{ body_digest: string; organization_id: string | null }>>`
            SELECT body_digest, organization_id::text AS organization_id
              FROM papercusp_auth.hosted_billing_webhook_events
             WHERE provider_event_id = ${event.eventId}
          `;
          if (prior[0]?.body_digest !== bodyDigest) return { outcome: 'replay-mismatch' };
          return { outcome: 'duplicate', organizationId: prior[0]?.organization_id ?? null };
        }

        if (event.livemode !== input.expectedLivemode) {
          await markRejected(sql, event.eventId, 'livemode_mismatch', null);
          return { outcome: 'rejected', code: 'livemode_mismatch', organizationId: null };
        }
        if (event.facts.length === 0) return { outcome: 'ignored', organizationId: null };

        let organizationId: string | null = null;
        for (const fact of event.facts) {
          organizationId = await applyFact(sql, fact, event, input.planKeyForPrice);
        }
        await sql`
          UPDATE papercusp_auth.hosted_billing_webhook_events
             SET outcome = 'applied', organization_id = ${organizationId}::uuid
           WHERE provider_event_id = ${event.eventId}
        `;
        return { outcome: 'applied', organizationId };
      });
    } catch (error) {
      if (!(error instanceof FactRejection)) throw error;
      // The fact transaction rolled back; record the refusal in its own
      // transaction so Stripe's retries of this event are duplicates, not reapplies.
      const recorded = await this.recordRejectedEvent({
        eventId: event.eventId,
        eventType: event.eventType,
        bodyDigest,
        livemode: event.livemode,
        code: error.code,
      });
      if (recorded === 'replay-mismatch') return { outcome: 'replay-mismatch' };
      return { outcome: 'rejected', code: error.code, organizationId: error.organizationId };
    }
  }
}

async function priorDigest(sql: Sql, eventId: string): Promise<string | null> {
  const rows = await sql<Array<{ body_digest: string }>>`
    SELECT body_digest FROM papercusp_auth.hosted_billing_webhook_events WHERE provider_event_id = ${eventId}
  `;
  return rows[0]?.body_digest ?? null;
}

async function markRejected(sql: Sql, eventId: string, code: string, organizationId: string | null): Promise<void> {
  await sql`
    UPDATE papercusp_auth.hosted_billing_webhook_events
       SET outcome = 'rejected', rejection_code = ${code}, organization_id = ${organizationId}::uuid
     WHERE provider_event_id = ${eventId}
  `;
}

/** The organization a Stripe customer belongs to — the ONLY authority for attribution (R3). */
async function organizationForCustomer(sql: Sql, stripeCustomerId: string): Promise<string | null> {
  const rows = await sql<Array<{ organization_id: string }>>`
    SELECT organization_id::text AS organization_id
      FROM papercusp_auth.hosted_billing_customers
     WHERE stripe_customer_id = ${stripeCustomerId}
  `;
  return rows[0]?.organization_id ?? null;
}

async function ensureSubscriptionRow(
  sql: Sql,
  input: { stripeSubscriptionId: string; organizationId: string; stripeCustomerId: string; livemode: boolean },
): Promise<void> {
  await sql`
    INSERT INTO papercusp_auth.hosted_subscriptions
      (stripe_subscription_id, organization_id, stripe_customer_id, livemode)
    VALUES (${input.stripeSubscriptionId}, ${input.organizationId}::uuid, ${input.stripeCustomerId}, ${input.livemode})
    ON CONFLICT (stripe_subscription_id) DO NOTHING
  `;
  const rows = await sql<Array<{ organization_id: string; stripe_customer_id: string }>>`
    SELECT organization_id::text AS organization_id, stripe_customer_id
      FROM papercusp_auth.hosted_subscriptions
     WHERE stripe_subscription_id = ${input.stripeSubscriptionId}
     FOR UPDATE
  `;
  const row = rows[0];
  if (!row || row.organization_id !== input.organizationId || row.stripe_customer_id !== input.stripeCustomerId) {
    throw new FactRejection('organization_mismatch', input.organizationId);
  }
}

async function applyFact(
  sql: Sql,
  fact: HostedBillingFact,
  event: HostedBillingEvent,
  planKeyForPrice: (priceId: string | null) => string | null,
): Promise<string> {
  const mapped = await organizationForCustomer(sql, fact.stripeCustomerId);
  if (!mapped) throw new FactRejection('unknown_customer', fact.organizationId);
  const organizationId = fact.organizationId ?? mapped;
  if (organizationId !== mapped) throw new FactRejection('organization_mismatch', fact.organizationId);
  await ensureSubscriptionRow(sql, {
    stripeSubscriptionId: fact.stripeSubscriptionId,
    organizationId,
    stripeCustomerId: fact.stripeCustomerId,
    livemode: event.livemode,
  });

  if (fact.kind === 'subscription') {
    const key = subscriptionOrderKey(fact.status, event.createdAt, event.eventId);
    await sql`
      UPDATE papercusp_auth.hosted_subscriptions AS s
         SET status = ${fact.status},
             price_id = ${fact.priceId},
             plan_key = ${planKeyForPrice(fact.priceId)},
             current_period_end = ${fact.currentPeriodEnd},
             cancel_at_period_end = ${fact.cancelAtPeriodEnd},
             canceled_at = ${fact.canceledAt},
             sub_terminal = ${key.terminal},
             sub_event_created = ${event.createdAt},
             sub_status_rank = ${key.statusRank},
             sub_event_id = ${event.eventId},
             updated_at = now()
       WHERE s.stripe_subscription_id = ${fact.stripeSubscriptionId}
         AND (${key.terminal}::boolean, ${event.createdAt}::timestamptz, ${key.statusRank}::int, ${event.eventId}::text COLLATE "C")
           > (s.sub_terminal, s.sub_event_created, s.sub_status_rank, s.sub_event_id COLLATE "C")
    `;
  } else if (fact.kind === 'invoice') {
    await sql`
      UPDATE papercusp_auth.hosted_subscriptions AS s
         SET latest_invoice_id = ${fact.invoiceId},
             latest_invoice_status = ${fact.invoiceStatus},
             invoice_event_created = ${event.createdAt},
             invoice_event_id = ${event.eventId},
             updated_at = now()
       WHERE s.stripe_subscription_id = ${fact.stripeSubscriptionId}
         AND (${event.createdAt}::timestamptz, ${event.eventId}::text COLLATE "C")
           > (s.invoice_event_created, s.invoice_event_id COLLATE "C")
    `;
  }
  // 'checkout' needs nothing beyond ensureSubscriptionRow: the row now exists in
  // 'pending' so the UI shows "processing" until the subscription event lands.
  return organizationId;
}
