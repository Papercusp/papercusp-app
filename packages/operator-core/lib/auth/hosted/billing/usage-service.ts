/** Server collector composition for the hosted usage ledger (monetization P-004). */
import { createHash } from 'node:crypto';
import { PILOT_COST_CATEGORIES, type PilotCostCategory } from './unit-economics';
import {
  buildHostedUsageStatement, validateHostedUsageRecord,
  type HostedUsageRecord, type HostedUsageScope, type HostedUsageStatement,
} from './usage-statement';
import type { PostgresHostedUsageStore } from './usage-store';
import { shadowMonthBounds } from '../../../cupboard/shadow-metering-reader';

export interface HostedUsageRead {
  readonly scope: HostedUsageScope;
  readonly month: string;
  readonly asOfMs: number;
}
export type HostedBillingUsageSource = (input: HostedUsageRead) => Promise<HostedUsageStatement>;

/** Installed by the server composition, never selected or supplied by a browser. */
export interface HostedUsageCollector {
  readonly id: string;
  readonly provider: string;
  readonly categories: readonly PilotCostCategory[];
  read(input: HostedUsageRead): Promise<{
    readonly scope: HostedUsageScope;
    readonly month: string;
    readonly complete: boolean;
    readonly observedAtMs: number;
    readonly evidenceRef: string;
    readonly records: readonly HostedUsageRecord[];
  }>;
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const sameScope = (a: HostedUsageScope, b: HostedUsageScope) => a.controlWorkspaceId === b.controlWorkspaceId
  && a.organizationId === b.organizationId && a.customerWorkspaceId === b.customerWorkspaceId;
const inScope = (record: HostedUsageRecord, scope: HostedUsageScope) => record.controlWorkspaceId === scope.controlWorkspaceId
  && record.organizationId === scope.organizationId
  && (scope.customerWorkspaceId === null || record.customerWorkspaceId === scope.customerWorkspaceId);

/**
 * Each installed source must explicitly cover its population. Neither an empty
 * DB read, existing receipts nor a successful provider request proves a complete
 * commercial census. A missing category/source keeps settlement ineligible.
 * Receipts survive a later collector failure; retries use the store's replay
 * semantics. All batches are validated before the first persistence call.
 */
export function createHostedUsageSource(options: {
  readonly store: Pick<PostgresHostedUsageStore, 'append' | 'readRecords'>;
  readonly collectors?: readonly HostedUsageCollector[];
  readonly maximumAgeMs: number;
}): HostedBillingUsageSource {
  const collectors = (options.collectors ?? []).map(collector => Object.freeze({
    id: collector.id, provider: collector.provider, categories: Object.freeze([...collector.categories]),
    read: collector.read.bind(collector),
  }));
  const ids = new Set<string>();
  const categories = new Set<PilotCostCategory>();
  if (!Number.isSafeInteger(options.maximumAgeMs) || options.maximumAgeMs < 0) throw new Error('invalid usage census age');
  for (const collector of collectors) {
    if (!IDENTIFIER.test(collector.id) || !IDENTIFIER.test(collector.provider) || ids.has(collector.id)
        || !Array.isArray(collector.categories) || collector.categories.length === 0
        || new Set(collector.categories).size !== collector.categories.length
        || collector.categories.some(category => !(PILOT_COST_CATEGORIES as readonly string[]).includes(category))) {
      throw new Error('invalid usage collector');
    }
    ids.add(collector.id); collector.categories.forEach(category => categories.add(category));
  }
  return async input => {
    input = Object.freeze({ scope: Object.freeze({ ...input.scope }), month: input.month, asOfMs: input.asOfMs });
    const emptySource = { complete: false, observedAtMs: input.asOfMs, maximumAgeMs: options.maximumAgeMs, evidenceRef: 'hosted-usage:unmeasured-census' };
    buildHostedUsageStatement({ ...input, source: emptySource, records: [] });
    const { startMs, endMs } = shadowMonthBounds(input.month);
    const snapshots = await Promise.all(collectors.map(async collector => {
      const received = await collector.read(input);
      if (!received || !sameScope(received.scope, input.scope) || received.month !== input.month
          || !Array.isArray(received.records) || !Number.isSafeInteger(received.observedAtMs)
          || received.observedAtMs < 0 || received.observedAtMs > input.asOfMs) {
        throw new Error('usage collector snapshot mismatch');
      }
      const snapshot = Object.freeze({
        scope: input.scope, month: received.month, complete: received.complete,
        observedAtMs: received.observedAtMs, evidenceRef: received.evidenceRef,
        records: Object.freeze(received.records.map(record => Object.freeze({ ...record }))),
      });
      // The shared validator checks unknown cost, metadata-only fields and
      // source-census shape. Do not silently omit a foreign receipt and then
      // certify the remaining rows as the requested tenant's complete bill.
      for (const record of snapshot.records) {
        validateHostedUsageRecord(record);
        if (!inScope(record, input.scope) || record.provider !== collector.provider
            || !collector.categories.includes(record.category)
            || record.occurredAtMs < startMs || record.occurredAtMs >= endMs
            || record.observedAtMs > snapshot.observedAtMs) throw new Error('usage collector receipt mismatch');
      }
      buildHostedUsageStatement({ ...input, source: {
        complete: snapshot.complete, observedAtMs: snapshot.observedAtMs,
        maximumAgeMs: options.maximumAgeMs, evidenceRef: snapshot.evidenceRef,
      }, records: snapshot.records });
      return { collector, snapshot };
    }));
    for (const { snapshot } of snapshots) {
      for (const record of snapshot.records) {
        const outcome = await options.store.append(record);
        if (outcome !== 'recorded' && outcome !== 'duplicate') throw new Error('usage collector replay conflict');
      }
    }
    const records = await options.store.readRecords(input);
    if (records.some(record => !inScope(record, input.scope))) throw new Error('usage store scope mismatch');
    const manifest = snapshots.map(({ collector, snapshot }) => ({
      id: collector.id, provider: collector.provider, categories: [...collector.categories].sort(),
      evidenceRef: snapshot.evidenceRef, observedAtMs: snapshot.observedAtMs, complete: snapshot.complete,
    })).sort((a, b) => a.id.localeCompare(b.id));
    const usageKey = (record: HostedUsageRecord) => JSON.stringify([record.customerWorkspaceId, record.provider, record.usageId]);
    const latest = new Map<string, HostedUsageRecord>();
    for (const record of records) {
      const previous = latest.get(usageKey(record));
      if (!previous || record.revision > previous.revision) latest.set(usageKey(record), record);
    }
    const currentReceipts = new Set(snapshots.flatMap(({ snapshot }) => snapshot.records.map(record =>
      JSON.stringify([usageKey(record), record.revision, record.recordId]))));
    // A complete-but-empty response cannot erase a previously recorded charge.
    // A missing provider or an older revision is an unreconciled population,
    // even when every cost category has a declared collector.
    const reconciled = [...latest.values()].every(record => currentReceipts.has(
      JSON.stringify([usageKey(record), record.revision, record.recordId])));
    const complete = collectors.length > 0 && PILOT_COST_CATEGORIES.every(category => categories.has(category))
      && snapshots.every(({ snapshot }) => snapshot.complete) && reconciled;
    const observedAtMs = snapshots.reduce((oldest, { snapshot }) => Math.min(oldest, snapshot.observedAtMs), input.asOfMs);
    const evidenceRef = manifest.length === 0 ? emptySource.evidenceRef
      : 'hosted-usage:census:' + createHash('sha256').update(JSON.stringify({ scope: input.scope, month: input.month, manifest })).digest('hex');
    return buildHostedUsageStatement({ ...input, records, source: {
      complete, observedAtMs, maximumAgeMs: options.maximumAgeMs, evidenceRef,
    } });
  };
}
