/**
 * Hosted commercial cost statements (monetization P-004).
 * Reuses the pilot cost vocabulary, shadow meter's UTC month boundaries and
 * money-journal units. This is a projection of collector receipts, not a cash
 * journal, payment instruction or substitute for authenticated provider reads.
 * The caller must derive the scope and completeness receipt on the server.
 */
import { MICROS_PER_CENT, addMicrosDecimals, parseMicrosDecimal, splitMicrosDecimal, formatMicrosDecimal } from '../../../cupboard/money-journal';
import { shadowMonthBounds } from '../../../cupboard/shadow-metering-reader';
import { PILOT_COST_CATEGORIES, type CostPayer, type PilotCostCategory } from './unit-economics';

export type HostedCostSource = 'unpriced' | 'estimate' | 'provider-reported' | 'provider-billed';

export interface HostedUsageScope {
  readonly controlWorkspaceId: string;
  readonly organizationId: string;
  /** Null selects the organization's workspaces, never another organization. */
  readonly customerWorkspaceId: string | null;
}

export interface HostedUsageRecord extends Omit<HostedUsageScope, 'customerWorkspaceId'> {
  readonly customerWorkspaceId: string;
  /** Immutable collector receipt; replay must have identical contents. */
  readonly recordId: string;
  /** One provider usage event, including its later cost corrections. */
  readonly usageId: string;
  readonly revision: number;
  readonly provider: string;
  readonly category: PilotCostCategory;
  readonly payer: CostPayer;
  readonly occurredAtMs: number;
  readonly observedAtMs: number;
  readonly quantity: number;
  readonly unit: string;
  readonly costSource: HostedCostSource;
  readonly costMicros: number | null;
  /** Canonical exact micro amount; costMicros is its integer projection. */
  readonly costMicrosExact?: string;
  /** Opaque evidence pointer. Customer content never belongs in this record. */
  readonly sourceRef: string;
}

export interface HostedUsageStatementLine {
  readonly customerWorkspaceId: string;
  readonly provider: string;
  readonly category: PilotCostCategory;
  readonly payer: CostPayer;
  readonly unit: string;
  readonly quantity: number;
  readonly usages: number;
  readonly unpricedUsages: number;
  readonly estimatedMicros: number;
  readonly reportedMicros: number;
  readonly billedMicros: number;
  readonly estimatedMicrosExact?: string;
  readonly reportedMicrosExact?: string;
  readonly billedMicrosExact?: string;
}

export interface HostedUsageForecast {
  readonly method: 'linear-elapsed-utc-month';
  /** Latest known consumption costs; estimates/reports remain provisional. */
  readonly basisMicros: number | null;
  readonly basisMicrosExact?: string;
  readonly elapsedMs: number;
  readonly periodMs: number;
  readonly projectedConsumptionMicros: number | null;
  readonly provisional: boolean;
  readonly unavailableReason: 'window-not-started' | 'incomplete-source' | 'source-not-current'
    | 'receipt-newer-than-census' | 'unpriced-usage' | 'no-elapsed-time' | 'amount-overflow' | null;
}

export interface HostedUsageStatement {
  readonly scope: HostedUsageScope;
  readonly month: string;
  readonly currency: 'USD';
  readonly asOfMs: number;
  readonly sourceRef: string;
  readonly settlementEligible: boolean;
  readonly gaps: readonly string[];
  readonly lines: readonly HostedUsageStatementLine[];
  readonly consumptionBilled: { readonly micros: number; readonly wholeCents: number; readonly roundingMicros: number;
    readonly microsExact?: string; readonly roundingMicrosExact?: string };
  readonly platformBilledMicros: number;
  readonly customerDirectBilledMicros: number;
  readonly platformBilledMicrosExact?: string;
  readonly customerDirectBilledMicrosExact?: string;
  /** Display projection only: never funding, a reservation bound or a bill. */
  readonly forecast: HostedUsageForecast;
  readonly history: readonly {
    readonly customerWorkspaceId: string;
    readonly provider: string;
    readonly usageId: string;
    readonly revisions: readonly Pick<HostedUsageRecord, 'recordId' | 'revision' | 'sourceRef' | 'costSource' | 'costMicros' | 'costMicrosExact' | 'observedAtMs'>[];
  }[];
}

const RECORD_KEYS = [
  'controlWorkspaceId', 'organizationId', 'customerWorkspaceId', 'recordId', 'usageId', 'revision',
  'provider', 'category', 'payer', 'occurredAtMs', 'observedAtMs', 'quantity', 'unit',
  'costSource', 'costMicros', 'costMicrosExact', 'sourceRef',
] as const;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
export const HOSTED_COST_SOURCE_RANK: Readonly<Record<HostedCostSource, number>> = Object.freeze({ unpriced: 0, estimate: 1, 'provider-reported': 2, 'provider-billed': 3 });
const SOURCES = HOSTED_COST_SOURCE_RANK;

function id(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) throw new Error('invalid usage identifier');
}
function integer(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('usage counters must be non-negative safe integers');
}
function sum(a: number, b: number): number {
  const result = BigInt(a) + BigInt(b);
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('usage statement exceeds safe integer range');
  return Number(result);
}
export function validateHostedUsageRecord(record: HostedUsageRecord): void {
  if (!record || typeof record !== 'object' || Array.isArray(record) ||
      Object.keys(record).some((key) => !(RECORD_KEYS as readonly string[]).includes(key))) {
    throw new Error('usage record contains unsupported fields');
  }
  for (const key of ['controlWorkspaceId', 'organizationId', 'customerWorkspaceId', 'recordId', 'usageId', 'provider', 'unit', 'sourceRef'] as const) id(record[key]);
  for (const key of ['revision', 'occurredAtMs', 'observedAtMs', 'quantity'] as const) integer(record[key]);
  if (record.revision === 0 || record.observedAtMs < record.occurredAtMs ||
      !(PILOT_COST_CATEGORIES as readonly string[]).includes(record.category) ||
      !['platform', 'consumption', 'customer-direct'].includes(record.payer) ||
      !Object.hasOwn(SOURCES, record.costSource)) throw new Error('invalid usage receipt');
  if (record.costSource === 'unpriced') {
    if (record.costMicros !== null || record.costMicrosExact !== undefined) throw new Error('unpriced usage requires unknown cost');
  } else {
    integer(record.costMicros);
    if (record.costMicrosExact !== undefined) {
      const amount = splitMicrosDecimal(record.costMicrosExact);
      if (amount.exact !== record.costMicrosExact || amount.micros !== record.costMicros) throw new Error('exact usage cost mismatch');
    }
  }
}

const exactCost = (record: HostedUsageRecord) => record.costMicrosExact ?? String(record.costMicros ?? 0);
const exactLine = (line: HostedUsageStatementLine, kind: 'estimated' | 'reported' | 'billed') =>
  line[`${kind}MicrosExact`] ?? String(line[`${kind}Micros`]);
function lineAmounts(line: HostedUsageStatementLine, record: HostedUsageRecord) {
  const result: Record<string, number | string | undefined> = {};
  for (const [kind, source] of [['estimated', 'estimate'], ['reported', 'provider-reported'], ['billed', 'provider-billed']] as const) {
    const amount = splitMicrosDecimal(addMicrosDecimals(exactLine(line, kind), record.costSource === source ? exactCost(record) : '0'));
    result[`${kind}Micros`] = amount.micros;
    result[`${kind}MicrosExact`] = amount.exact.includes('.') ? amount.exact : undefined;
  }
  return result as Pick<HostedUsageStatementLine, 'estimatedMicros' | 'reportedMicros' | 'billedMicros'
    | 'estimatedMicrosExact' | 'reportedMicrosExact' | 'billedMicrosExact'>;
}

/**
 * Versioned replacements count one usage once, even after delayed provider
 * billing or replay. No amount is silently promoted from estimate to billed.
 * Missing/partial collector coverage makes settlement ineligible, including an
 * empty input. Customer-direct BYOK/cloud costs are shown separately.
 */
export function buildHostedUsageStatement(input: {
  readonly scope: HostedUsageScope;
  readonly month: string;
  readonly asOfMs: number;
  readonly source: { readonly complete: boolean; readonly observedAtMs: number; readonly maximumAgeMs: number; readonly evidenceRef: string };
  readonly records: readonly HostedUsageRecord[];
}): HostedUsageStatement {
  const { scope, asOfMs, source } = input;
  id(scope.controlWorkspaceId); id(scope.organizationId);
  if (scope.customerWorkspaceId !== null) id(scope.customerWorkspaceId);
  integer(asOfMs); integer(source.observedAtMs); integer(source.maximumAgeMs); id(source.evidenceRef);
  if (typeof source.complete !== 'boolean' || !Array.isArray(input.records)) throw new Error('invalid usage source census');
  const { startMs, endMs } = shadowMonthBounds(input.month);
  const gaps = new Set<string>();
  if (asOfMs < startMs) gaps.add('window-not-started');
  if (!source.complete) gaps.add('incomplete-source');
  if (source.observedAtMs > asOfMs || asOfMs - source.observedAtMs > source.maximumAgeMs) gaps.add('source-not-current');
  const seenReceipts = new Map<string, string>();
  const usages = new Map<string, HostedUsageRecord[]>();
  for (const record of input.records) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('invalid usage receipt');
    // An unattributable row cannot be treated as foreign and silently omitted.
    id(record.controlWorkspaceId); id(record.organizationId); id(record.customerWorkspaceId);
    // Filter the exact composite scope before retaining evidence or identifiers.
    if (record?.controlWorkspaceId !== scope.controlWorkspaceId || record?.organizationId !== scope.organizationId ||
        (scope.customerWorkspaceId !== null && record?.customerWorkspaceId !== scope.customerWorkspaceId)) continue;
    validateHostedUsageRecord(record);
    if (record.observedAtMs > asOfMs) continue;
    if (record.observedAtMs > source.observedAtMs) gaps.add('receipt-newer-than-census');
    const receiptKey = JSON.stringify([record.customerWorkspaceId, record.provider, record.recordId]);
    const fingerprint = JSON.stringify(RECORD_KEYS.map((key) => key === 'costMicrosExact' ? exactCost(record) : record[key]));
    const previous = seenReceipts.get(receiptKey);
    if (previous !== undefined) {
      if (previous !== fingerprint) throw new Error('usage receipt replay mismatch');
      continue;
    }
    seenReceipts.set(receiptKey, fingerprint);
    const key = JSON.stringify([record.customerWorkspaceId, record.provider, record.usageId]);
    const rows = usages.get(key) ?? [];
    rows.push(record); usages.set(key, rows);
  }
  const lines = new Map<string, HostedUsageStatementLine>();
  const history: HostedUsageStatement['history'][number][] = [];
  for (const [, rows] of [...usages].sort(([a], [b]) => a.localeCompare(b))) {
    rows.sort((a, b) => a.revision - b.revision);
    const first = rows[0]!;
    for (let index = 1; index < rows.length; index++) {
      const prior = rows[index - 1]!; const row = rows[index]!;
      if (row.revision === prior.revision || row.observedAtMs < prior.observedAtMs ||
          row.occurredAtMs !== first.occurredAtMs || row.category !== first.category ||
          row.payer !== first.payer || row.unit !== first.unit || SOURCES[row.costSource] < SOURCES[prior.costSource]) {
        throw new Error('conflicting usage revision');
      }
    }
    const latest = rows[rows.length - 1]!;
    if (latest.occurredAtMs < startMs || latest.occurredAtMs >= endMs || latest.occurredAtMs > asOfMs) continue;
    if (latest.costSource === 'unpriced') gaps.add('unpriced-usage');
    if (latest.costSource === 'estimate') gaps.add('estimated-cost');
    if (latest.costSource === 'provider-reported') gaps.add('unreconciled-provider-cost');
    const key = JSON.stringify([latest.customerWorkspaceId, latest.provider, latest.category, latest.payer, latest.unit]);
    const line = lines.get(key) ?? {
      customerWorkspaceId: latest.customerWorkspaceId, provider: latest.provider,
      category: latest.category, payer: latest.payer, unit: latest.unit,
      quantity: 0, usages: 0, unpricedUsages: 0, estimatedMicros: 0, reportedMicros: 0, billedMicros: 0,
    };
    lines.set(key, {
      ...line, quantity: sum(line.quantity, latest.quantity), usages: line.usages + 1,
      unpricedUsages: line.unpricedUsages + (latest.costSource === 'unpriced' ? 1 : 0),
      ...lineAmounts(line, latest),
    });
    history.push({
      customerWorkspaceId: latest.customerWorkspaceId, provider: latest.provider, usageId: latest.usageId,
      revisions: rows.map((row) => ({ recordId: row.recordId, revision: row.revision, sourceRef: row.sourceRef,
        costSource: row.costSource, costMicros: row.costMicros, costMicrosExact: row.costMicrosExact, observedAtMs: row.observedAtMs })),
    });
  }
  const ordered = [...lines].sort(([a], [b]) => a.localeCompare(b)).map(([, line]) => line);
  const total = (payer: CostPayer) => splitMicrosDecimal(addMicrosDecimals(...ordered.filter((line) => line.payer === payer).map(line => exactLine(line, 'billed'))));
  const consumption = total('consumption'); const platform = total('platform'); const direct = total('customer-direct');
  const micros = consumption.micros;
  const periodMs = endMs - startMs;
  // Extrapolate from the census cutoff, not time for which no source was read.
  const elapsedMs = Math.max(0, Math.min(asOfMs, source.observedAtMs, endMs) - startMs);
  let unavailableReason: HostedUsageForecast['unavailableReason'] = null;
  for (const reason of ['window-not-started', 'incomplete-source', 'source-not-current', 'receipt-newer-than-census', 'unpriced-usage'] as const) {
    if (gaps.has(reason)) { unavailableReason = reason; break; }
  }
  const basisExact = addMicrosDecimals(...ordered.filter(line => line.payer === 'consumption').flatMap(line =>
    [exactLine(line, 'billed'), exactLine(line, 'reported'), exactLine(line, 'estimated')]));
  const basis = parseMicrosDecimal(basisExact); const divisor = 10n ** BigInt(basis.scale);
  const safeBasis = basis.coefficient <= BigInt(Number.MAX_SAFE_INTEGER) * divisor;
  if (!unavailableReason && elapsedMs === 0) unavailableReason = 'no-elapsed-time';
  const projected = unavailableReason ? null :
    (basis.coefficient * BigInt(periodMs) + BigInt(elapsedMs) * divisor - 1n) / (BigInt(elapsedMs) * divisor);
  if (!unavailableReason && (!safeBasis || projected! > BigInt(Number.MAX_SAFE_INTEGER))) unavailableReason = 'amount-overflow';
  const forecast: HostedUsageForecast = {
    method: 'linear-elapsed-utc-month', basisMicros: unavailableReason || !safeBasis ? null : Number(basis.coefficient / divisor),
    ...(!unavailableReason && safeBasis && basisExact.includes('.') ? { basisMicrosExact: basisExact } : {}),
    elapsedMs, periodMs, projectedConsumptionMicros: unavailableReason ? null : Number(projected),
    provisional: elapsedMs < periodMs || gaps.size > 0 || unavailableReason !== null, unavailableReason,
  };
  return {
    scope: { controlWorkspaceId: scope.controlWorkspaceId, organizationId: scope.organizationId, customerWorkspaceId: scope.customerWorkspaceId },
    month: input.month, currency: 'USD', asOfMs, sourceRef: source.evidenceRef,
    settlementEligible: gaps.size === 0, gaps: [...gaps].sort(), lines: ordered,
    consumptionBilled: { micros, wholeCents: Number(BigInt(micros) / BigInt(MICROS_PER_CENT)), roundingMicros: Number(BigInt(micros) % BigInt(MICROS_PER_CENT)),
      ...(consumption.exact.includes('.') ? { microsExact: consumption.exact,
        roundingMicrosExact: formatMicrosDecimal(parseMicrosDecimal(consumption.exact).coefficient % (BigInt(MICROS_PER_CENT) * 10n ** BigInt(parseMicrosDecimal(consumption.exact).scale)), parseMicrosDecimal(consumption.exact).scale) } : {}) },
    platformBilledMicros: platform.micros, customerDirectBilledMicros: direct.micros,
    ...(platform.exact.includes('.') ? { platformBilledMicrosExact: platform.exact } : {}),
    ...(direct.exact.includes('.') ? { customerDirectBilledMicrosExact: direct.exact } : {}), forecast, history,
  };
}
