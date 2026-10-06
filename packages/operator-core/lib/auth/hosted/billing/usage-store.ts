/**
 * Monetization P-004: durable provider receipts, alongside hosted billing.
 * Cash movements stay in money-journal; identity markup stays in shadow metering.
 * Only an authenticated server collector may append. A receipt is evidence of
 * one observation, never evidence that the collector population is complete.
 */
import { withHostedServiceContext } from '@papercusp/db-org';
import type { Sql } from 'postgres';
import type { HostedServiceContextRunner } from '../workos-lifecycle-postgres';
import { shadowMonthBounds } from '../../../cupboard/shadow-metering-reader';
import { splitMicrosDecimal } from '../../../cupboard/money-journal';
import { openRouterUsageRecord, type OpenRouterUsageBinding } from './openrouter-usage';
import type { HostedBudgetExecutionGrant } from './budget-store';
import {
  buildHostedUsageStatement,
  validateHostedUsageRecord,
  type HostedUsageRecord,
  type HostedUsageScope,
} from './usage-statement';

type ReceiptRow = {
  control_workspace_id: string; organization_id: string; customer_workspace_id: string;
  provider: string; record_id: string; usage_id: string; revision: string | number;
  category: HostedUsageRecord['category']; payer: HostedUsageRecord['payer'];
  occurred_at_ms: string | number; observed_at_ms: string | number;
  quantity: string | number; unit: string; cost_source: HostedUsageRecord['costSource'];
  cost_micros: string | number | null; source_ref: string;
  openrouter_credential_ref: string | null;
  openrouter_key_sha256: string | null;
  openrouter_is_byok: boolean | null;
  openrouter_budget_grant: HostedBudgetExecutionGrant | null;
};

export type OpenRouterGenerationBinding = Omit<OpenRouterUsageBinding, 'revision' | 'credentialSha256'>
  & { readonly credentialSha256: string };
export interface HostedUsagePopulation {
  readonly records: readonly HostedUsageRecord[];
  /** Private execution metadata, never included in public usage records. */
  readonly openRouterBindings: readonly OpenRouterGenerationBinding[];
}
const sameTenant = (row: ReceiptRow, scope: HostedUsageScope) => row.control_workspace_id === scope.controlWorkspaceId
  && row.organization_id === scope.organizationId && row.customer_workspace_id === scope.customerWorkspaceId;
const sameBinding = (row: ReceiptRow, binding?: OpenRouterGenerationBinding) => !binding
  || (row.openrouter_credential_ref === binding.credentialRef
    && row.openrouter_key_sha256 === binding.credentialSha256 && row.openrouter_is_byok === binding.isByok
    && grantIdentity(row.openrouter_budget_grant) === grantIdentity(binding.budgetGrant));
const grantIdentity = (grant: HostedBudgetExecutionGrant | null | undefined) => grant == null ? null
  : JSON.stringify([grant.scope.controlWorkspaceId, grant.scope.organizationId, grant.scope.customerWorkspaceId,
    grant.reservationId, grant.month, grant.budgetKey, grant.maximumCostMicros, grant.providerLimitRef,
    grant.policyId, grant.policyRevision, grant.evidenceRef]);

/** Copy only a structurally valid private grant before the first await. The
 * transaction and database guard still verify it against the real admission. */
function snapshotGrant(value: HostedBudgetExecutionGrant): HostedBudgetExecutionGrant {
  const identifier = (v: unknown) => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(v);
  const safe = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(k => !['scope', 'reservationId', 'month', 'budgetKey', 'maximumCostMicros',
        'providerLimitRef', 'policyId', 'policyRevision', 'evidenceRef'].includes(k))
      || !value.scope || typeof value.scope !== 'object' || Array.isArray(value.scope)
      || Object.keys(value.scope).some(k => !['controlWorkspaceId', 'organizationId', 'customerWorkspaceId'].includes(k))
      || !identifier(value.scope.controlWorkspaceId) || !identifier(value.scope.organizationId)
      || !identifier(value.scope.customerWorkspaceId) || !identifier(value.reservationId)
      || !identifier(value.budgetKey) || !identifier(value.providerLimitRef) || !identifier(value.policyId)
      || !identifier(value.evidenceRef) || !safe(value.maximumCostMicros)
      || !safe(value.policyRevision) || value.policyRevision < 1) throw new Error('invalid OpenRouter budget grant');
  shadowMonthBounds(value.month);
  return Object.freeze({ ...value, scope: Object.freeze({ ...value.scope }) });
}

function receipt(row: ReceiptRow): HostedUsageRecord {
  const amount = row.cost_micros === null ? null : splitMicrosDecimal(String(row.cost_micros));
  const record: HostedUsageRecord = {
    controlWorkspaceId: row.control_workspace_id, organizationId: row.organization_id,
    customerWorkspaceId: row.customer_workspace_id, provider: row.provider,
    recordId: row.record_id, usageId: row.usage_id, revision: Number(row.revision),
    category: row.category, payer: row.payer, occurredAtMs: Number(row.occurred_at_ms),
    observedAtMs: Number(row.observed_at_ms), quantity: Number(row.quantity), unit: row.unit,
    costSource: row.cost_source, costMicros: amount?.micros ?? null,
    ...(amount?.exact.includes('.') ? { costMicrosExact: amount.exact } : {}),
    sourceRef: row.source_ref,
  };
  validateHostedUsageRecord(record);
  return record;
}

const keys = [
  'controlWorkspaceId', 'organizationId', 'customerWorkspaceId', 'provider', 'recordId',
  'usageId', 'revision', 'category', 'payer', 'occurredAtMs', 'observedAtMs', 'quantity',
  'unit', 'costSource', 'costMicros', 'costMicrosExact', 'sourceRef',
] as const;
const canonical = (record: HostedUsageRecord) => JSON.stringify(keys.map(key =>
  key === 'costMicrosExact' ? record.costMicrosExact ?? String(record.costMicros) : record[key]));

export type HostedUsageAppendResult = 'recorded' | 'duplicate' | 'replay-mismatch' | 'revision-conflict';

export class PostgresHostedUsageStore {
  constructor(private readonly run: HostedServiceContextRunner = withHostedServiceContext) {}

  /** Server-only local census through the caller's reservation transaction.
   * Includes ALL stored revisions, providers, tenants and times; neither the
   * monthly statement read nor the rotating binding batch is a census.
   * SHARE protects even an empty table against existing and direct SQL writers
   * until this transaction ends. Call before collecting provider evidence; do
   * not append usage inside this read-only population phase (lock upgrades by
   * concurrent readers would deadlock).
   *
   * Row/binding presence establishes neither provider account ownership nor
   * provider completeness, final bills, paid settlements or cash backing.
   * Unbound legacy rows and unknown costs are retained for reconciliation,
   * rather than assigned to an account or silently treated as zero.
   */
  async readLockedPopulation(sql: Sql): Promise<HostedUsagePopulation> {
    const [isolation] = await sql<{ transaction_isolation: string }[]>`SHOW transaction_isolation`;
    if (isolation?.transaction_isolation !== 'read committed') throw new Error('usage population requires read committed');
    const [started] = await sql<{ transaction_id: string }[]>`SELECT pg_current_xact_id()::text AS transaction_id`;
    await sql`SELECT papercusp_auth.lock_hosted_usage_population()`;
    const rows = await sql<ReceiptRow[]>`
      SELECT * FROM papercusp_auth.hosted_usage_receipts
       ORDER BY control_workspace_id COLLATE "C", organization_id COLLATE "C",
         customer_workspace_id COLLATE "C", provider COLLATE "C", usage_id COLLATE "C", revision`;
    const records = rows.map(row => Object.freeze(receipt(row)));
    const openRouterBindings = rows.filter(row => row.openrouter_credential_ref !== null).map(row => {
      const r = receipt(row);
      const binding: OpenRouterGenerationBinding = {
        scope: { controlWorkspaceId: r.controlWorkspaceId, organizationId: r.organizationId,
          customerWorkspaceId: r.customerWorkspaceId },
        generationId: r.usageId, payer: r.payer, isByok: row.openrouter_is_byok!,
        credentialRef: row.openrouter_credential_ref!, credentialSha256: row.openrouter_key_sha256!,
        ...(row.openrouter_budget_grant == null ? {} : { budgetGrant: snapshotGrant(row.openrouter_budget_grant) }),
        occurredAtMs: r.occurredAtMs, observedAtMs: r.observedAtMs, evidenceRef: r.sourceRef,
      };
      openRouterUsageRecord({ ...binding, revision: r.revision }, {
        data: { id: binding.generationId, is_byok: binding.isByok, total_cost: null },
      });
      return Object.freeze({ ...binding, scope: Object.freeze(binding.scope) });
    });
    const [finished] = await sql<{ transaction_id: string }[]>`SELECT pg_current_xact_id()::text AS transaction_id`;
    if (!started?.transaction_id || finished?.transaction_id !== started.transaction_id) {
      throw new Error('usage population requires one transaction');
    }
    return Object.freeze({ records: Object.freeze(records), openRouterBindings: Object.freeze(openRouterBindings) });
  }

  async append(record: HostedUsageRecord): Promise<HostedUsageAppendResult> {
    return this.appendBound(record);
  }

  /** Trusted execution composition captures the generation and actual key
   * identity before collection. Never supplied by a browser/provider report.
   * An unpriced receipt preserves the obligation after process loss; no secret
   * value or customer content is stored, and bindings survive new instances. */
  async bindOpenRouterGeneration(input: OpenRouterGenerationBinding): Promise<HostedUsageAppendResult> {
    if (Object.keys(input).some(key => !['scope', 'generationId', 'payer', 'isByok', 'credentialRef',
      'credentialSha256', 'occurredAtMs', 'observedAtMs', 'evidenceRef', 'budgetGrant'].includes(key))
      || !/^[a-f0-9]{64}$/.test(input.credentialSha256)
      || !/^(?:env:[A-Za-z_][A-Za-z0-9_]*|file:\/[A-Za-z0-9._/-]+)$/.test(input.credentialRef)) {
      throw new Error('invalid durable OpenRouter generation binding');
    }
    const binding = Object.freeze({ ...input, scope: Object.freeze({ ...input.scope }),
      ...(input.budgetGrant === undefined ? {} : { budgetGrant: snapshotGrant(input.budgetGrant) }) });
    const record = openRouterUsageRecord({ ...binding, revision: 1 }, {
      data: { id: binding.generationId, is_byok: binding.isByok, total_cost: null },
    });
    return this.appendBound(record, binding);
  }

  private async appendBound(record: HostedUsageRecord, binding?: OpenRouterGenerationBinding): Promise<HostedUsageAppendResult> {
    validateHostedUsageRecord(record);
    return this.run(async sql => {
      if (record.provider === 'openrouter') {
        // Generation identity is global, even when two tenants race. A later
        // report cannot reassign the original generation or its payer/time.
        await sql`SELECT pg_advisory_xact_lock(hashtextextended(${'openrouter-generation:' + record.usageId}, 0))`;
        if (binding?.budgetGrant) {
          // Admission rows are immutable. No organization/account lock is
          // acquired here, so this writer does not invert the reservation's
          // budget -> organization -> account -> read-only source order.
          // The database trigger independently validates direct SQL INSERTs.
          const [admission] = await sql<{ matches: boolean }[]>`SELECT EXISTS (
            SELECT 1 FROM papercusp_auth.hosted_budget_receipts b
             WHERE b.control_workspace_id = ${record.controlWorkspaceId}
               AND b.organization_id = ${record.organizationId}
               AND b.customer_workspace_id = ${record.customerWorkspaceId}
               AND b.reservation_id = ${binding.budgetGrant.reservationId} AND b.revision = 0
               AND b.observed_at_ms <= ${record.occurredAtMs} AND ${record.payer} = 'consumption'
               AND jsonb_build_object('scope', jsonb_build_object('controlWorkspaceId', b.control_workspace_id,
                 'organizationId', b.organization_id, 'customerWorkspaceId', b.customer_workspace_id),
                 'reservationId', b.reservation_id, 'month', b.month, 'budgetKey', b.budget_key,
                 'maximumCostMicros', b.maximum_cost_micros, 'providerLimitRef', b.provider_limit_ref,
                 'policyId', b.policy_id, 'policyRevision', b.policy_revision, 'evidenceRef', b.evidence_ref)
                   = ${JSON.stringify(binding.budgetGrant)}::jsonb
          ) AS matches`;
          if (!admission?.matches) return 'replay-mismatch';
        }
        const assigned = await sql<ReceiptRow[]>`SELECT * FROM papercusp_auth.hosted_usage_receipts
          WHERE provider = 'openrouter' AND usage_id = ${record.usageId}`;
        if (assigned.some(row => !sameTenant(row, record) || row.payer !== record.payer
          || Number(row.occurred_at_ms) !== record.occurredAtMs)) return 'replay-mismatch';
        if (binding && assigned.some(row => row.openrouter_credential_ref !== null && !sameBinding(row, binding))) {
          return 'replay-mismatch';
        }
      }
      // Serialize the whole stream, not just the receipt id: concurrent cost
      // revisions must validate against the same committed history. Hash
      // collisions only serialize unrelated streams; they cannot mix their rows.
      const stream = JSON.stringify([
        record.controlWorkspaceId, record.organizationId, record.customerWorkspaceId,
        record.provider, record.usageId,
      ]);
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${stream}, 0))`;
      const existing = await readStream(sql, record);
      const prior = existing.find(r => r.recordId === record.recordId);
      if (prior) {
        if (binding) {
          const rows = await sql<ReceiptRow[]>`SELECT * FROM papercusp_auth.hosted_usage_receipts
            WHERE provider = 'openrouter' AND usage_id = ${record.usageId} AND openrouter_credential_ref IS NOT NULL`;
          if (!rows[0] || !sameBinding(rows[0], binding)) return 'replay-mismatch';
        }
        return canonical(prior) === canonical(record) ? 'duplicate' : 'replay-mismatch';
      }
      if (existing.some(r => r.revision === record.revision)) return 'revision-conflict';
      const records = [...existing, record];
      const observedAtMs = records.reduce((latest, r) => Math.max(latest, r.observedAtMs), 0);
      // Reuse the statement's revision validation, including out-of-order
      // delivery, category/payer identity and estimated/reported/billed rank.
      buildHostedUsageStatement({
        scope: record, month: '1970-01', asOfMs: observedAtMs,
        source: { complete: false, observedAtMs, maximumAgeMs: 0, evidenceRef: record.sourceRef },
        records,
      });
      const inserted = await sql`
        INSERT INTO papercusp_auth.hosted_usage_receipts
          (control_workspace_id, organization_id, customer_workspace_id, provider,
           record_id, usage_id, revision, category, payer, occurred_at_ms,
           observed_at_ms, quantity, unit, cost_source, cost_micros, source_ref,
           openrouter_credential_ref, openrouter_key_sha256, openrouter_is_byok, openrouter_budget_grant)
        VALUES (${record.controlWorkspaceId}, ${record.organizationId}, ${record.customerWorkspaceId},
                ${record.provider}, ${record.recordId}, ${record.usageId}, ${record.revision},
                ${record.category}, ${record.payer}, ${record.occurredAtMs}, ${record.observedAtMs},
                ${record.quantity}, ${record.unit}, ${record.costSource}, ${record.costMicrosExact ?? record.costMicros}, ${record.sourceRef},
                ${binding?.credentialRef ?? null}, ${binding?.credentialSha256 ?? null}, ${binding?.isByok ?? null},
                ${binding?.budgetGrant === undefined ? null : JSON.stringify(binding.budgetGrant)}::jsonb)
        ON CONFLICT DO NOTHING RETURNING record_id`;
      if (inserted.length) return 'recorded';
      // One receipt id can race under two DIFFERENT usage ids. The table's
      // uniqueness, followed by this exact scoped read, catches that collision.
      const repeated = await sql<ReceiptRow[]>`
        SELECT * FROM papercusp_auth.hosted_usage_receipts
         WHERE control_workspace_id = ${record.controlWorkspaceId}
           AND organization_id = ${record.organizationId}
           AND customer_workspace_id = ${record.customerWorkspaceId}
           AND provider = ${record.provider} AND record_id = ${record.recordId}`;
      return repeated[0] && canonical(receipt(repeated[0])) === canonical(record) && sameBinding(repeated[0], binding)
        ? 'duplicate' : 'replay-mismatch';
    });
  }

  /** Full revision history as known at the requested time, in an exact tenant scope. */
  async readRecords(input: { scope: HostedUsageScope; month: string; asOfMs: number }): Promise<HostedUsageRecord[]> {
    // Reuse the shared boundary validation, including an explicit unknown
    // completeness receipt. An empty result cannot silently mean a zero bill.
    buildHostedUsageStatement({
      ...input, records: [],
      source: { complete: false, observedAtMs: input.asOfMs, maximumAgeMs: 0, evidenceRef: 'usage-store:read' },
    });
    const { startMs, endMs } = shadowMonthBounds(input.month);
    const { scope } = input;
    return this.run(async sql => {
      const rows = await sql<ReceiptRow[]>`
        SELECT * FROM papercusp_auth.hosted_usage_receipts
         WHERE control_workspace_id = ${scope.controlWorkspaceId}
           AND organization_id = ${scope.organizationId}
           AND (${scope.customerWorkspaceId}::text IS NULL OR customer_workspace_id = ${scope.customerWorkspaceId})
           AND occurred_at_ms >= ${startMs} AND occurred_at_ms < ${endMs}
           AND occurred_at_ms <= ${input.asOfMs} AND observed_at_ms <= ${input.asOfMs}
         ORDER BY customer_workspace_id COLLATE "C", provider COLLATE "C", usage_id COLLATE "C", revision`;
      return rows.map(receipt);
    });
  }

  /** Exact tenant/month/time read; organization reads can include its own
   * workspaces. Next observation counters come from committed stream history,
   * not the browser. Future receipts prevent stale reads from reusing a revision.
   * A bounded batch of the oldest observations rotates after successful reads;
   * this is never a full provider population census. */
  async readOpenRouterBindings(input: { scope: HostedUsageScope; month: string; asOfMs: number }): Promise<OpenRouterUsageBinding[]> {
    input = Object.freeze({ ...input, scope: Object.freeze({ ...input.scope }) });
    buildHostedUsageStatement({ ...input, records: [], source: {
      complete: false, observedAtMs: input.asOfMs, maximumAgeMs: 0, evidenceRef: 'openrouter:binding-read',
    } });
    const { startMs, endMs } = shadowMonthBounds(input.month);
    return this.run(async sql => {
      const rows = await sql<(ReceiptRow & { latest_revision: string | number; latest_observed_at_ms: string | number })[]>`
        SELECT b.*, h.latest_revision, h.latest_observed_at_ms
          FROM papercusp_auth.hosted_usage_receipts b
          CROSS JOIN LATERAL (SELECT max(revision) AS latest_revision, max(observed_at_ms) AS latest_observed_at_ms
            FROM papercusp_auth.hosted_usage_receipts r WHERE r.control_workspace_id = b.control_workspace_id
              AND r.organization_id = b.organization_id AND r.customer_workspace_id = b.customer_workspace_id
              AND r.provider = b.provider AND r.usage_id = b.usage_id) h
         WHERE b.control_workspace_id = ${input.scope.controlWorkspaceId}
           AND b.organization_id = ${input.scope.organizationId}
           AND (${input.scope.customerWorkspaceId}::text IS NULL OR b.customer_workspace_id = ${input.scope.customerWorkspaceId})
           AND b.provider = 'openrouter' AND b.openrouter_credential_ref IS NOT NULL
           AND b.occurred_at_ms >= ${startMs} AND b.occurred_at_ms < ${endMs}
           AND b.observed_at_ms <= ${input.asOfMs} AND h.latest_observed_at_ms <= ${input.asOfMs}
         ORDER BY h.latest_observed_at_ms, b.customer_workspace_id COLLATE "C", b.usage_id COLLATE "C"
         LIMIT 25`;
      return rows.map(row => {
        const r = receipt(row);
        const binding: OpenRouterUsageBinding = {
          scope: { controlWorkspaceId: r.controlWorkspaceId, organizationId: r.organizationId, customerWorkspaceId: r.customerWorkspaceId },
          generationId: r.usageId, payer: r.payer, isByok: row.openrouter_is_byok!,
          credentialRef: row.openrouter_credential_ref!, credentialSha256: row.openrouter_key_sha256!,
          ...(row.openrouter_budget_grant == null ? {} : { budgetGrant: snapshotGrant(row.openrouter_budget_grant) }),
          revision: Number(row.latest_revision) + 1, occurredAtMs: r.occurredAtMs,
          observedAtMs: input.asOfMs, evidenceRef: 'openrouter:metadata-read',
        };
        openRouterUsageRecord(binding, { data: { id: binding.generationId, is_byok: binding.isByok, total_cost: null } });
        return Object.freeze({ ...binding, scope: Object.freeze(binding.scope) });
      });
    });
  }
}

async function readStream(sql: Sql, record: HostedUsageRecord): Promise<HostedUsageRecord[]> {
  const rows = await sql<ReceiptRow[]>`
    SELECT * FROM papercusp_auth.hosted_usage_receipts
     WHERE control_workspace_id = ${record.controlWorkspaceId}
       AND organization_id = ${record.organizationId}
       AND customer_workspace_id = ${record.customerWorkspaceId}
       AND provider = ${record.provider} AND usage_id = ${record.usageId}
     ORDER BY revision`;
  return rows.map(receipt);
}
