/**
 * Pure, versioned cursor state for coord:orient's wake-to-wake fleet delta.
 *
 * D-004 keeps two separate contracts: leaderBrief is a replace-full snapshot,
 * while fleetDelta contains only changes since the server-side acknowledged
 * cursor. D-005 is enforced structurally here: the cursor identity carries the
 * canonical fleet/spec/window/population/unit labels and a mismatch resets to a
 * full replacement instead of comparing unlike numbers.
 */

export const FLEET_DELTA_SCHEMA_VERSION = 'fleet-delta-v2' as const;

export interface MemberFingerprint {
  v?: string;
  s?: string;
  d?: string;
  c?: number;
  p?: string;
  [k: string]: unknown;
}

export interface FleetDeltaScopeIdentity {
  fleet: string | null;
  harness: string | null;
  metricsSchemaVersion: string | null;
  specId: string | null;
  flowMode: string | null;
  flowSource: string | null;
  stockPopulation: string | null;
  flowPopulation: string | null;
  workItemUnit: string | null;
  fleetLifetime: { kind: string | null; startAt: string | null; startSource: string | null };
  lifecycle: { schemaVersion: string | null; startAt: string | null; startSource: string | null };
}

export interface FleetCanonicalAxes {
  metrics: {
    availability: 'measured' | 'unavailable' | 'absent';
    reason?: string;
    flow?: Record<string, number>;
    remaining?: { total: number; buckets: Record<string, number> };
    authority?: Record<string, number>;
    issueUnits?: Record<string, number>;
    specRevision?: number;
  };
  populationLifecycle: {
    availability: 'measured' | 'absent';
    target?: unknown;
    liveness?: unknown;
    claimFlow?: unknown;
  };
  capacity: { availability: 'measured' | 'absent'; value?: unknown };
  /** No canonical cost writer exists on leaderBrief yet. Keep that absence
   * explicit so callers never read omission as a measured zero. */
  cost: { availability: 'absent'; reason: 'canonical-cost-writer-unavailable' };
  gates: string[];
  promotion: { availability: 'measured' | 'absent'; gate?: string; deploy?: string };
}

export interface FleetFingerprint {
  schemaVersion: typeof FLEET_DELTA_SCHEMA_VERSION;
  scope: FleetDeltaScopeIdentity;
  members: Record<string, MemberFingerprint>;
  orphaned: number;
  stalled: number;
  axes: FleetCanonicalAxes;
  [k: string]: unknown;
}

export interface FleetDeltaRow {
  change: 'added' | 'updated' | 'removed';
  type: 'member';
  id: string;
  from?: MemberFingerprint;
  to?: MemberFingerprint;
}

export type FleetAxisChange = { from: unknown; to: unknown };

export interface FleetDelta {
  schemaVersion: typeof FLEET_DELTA_SCHEMA_VERSION;
  rows: FleetDeltaRow[];
  unchanged: number;
  orphaned?: { from: number; to: number };
  stalled?: { from: number; to: number };
  axes?: Record<string, unknown>;
  reset?: { reason: 'schema-mismatch' | 'scope-mismatch' | 'population-mismatch' | 'window-mismatch' };
  fullReplacement?: true;
}

export interface FleetFingerprintContext {
  leaderBrief?: unknown;
  announcedGates?: unknown;
  pipeline?: unknown;
  fleet?: string | null;
  harness?: string | null;
}

interface AssignmentsAgentRow {
  agentId?: unknown;
  verdict?: unknown;
  sessionState?: unknown;
  doing?: unknown;
  claims?: unknown;
  contextPressure?: unknown;
}

type Dict = Record<string, unknown>;
const asDict = (value: unknown): Dict | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Dict) : null;
const stringValue = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const numberValue = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

function numericFields(source: unknown, keys: readonly string[]): Record<string, number> | undefined {
  const record = asDict(source);
  if (!record) return undefined;
  const out: Record<string, number> = {};
  for (const key of keys) {
    const value = numberValue(record[key]);
    if (value !== undefined) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function stableObject(source: unknown, keys: readonly string[]): Dict | undefined {
  const record = asDict(source);
  if (!record) return undefined;
  const out: Dict = {};
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function canonicalProjection(context: FleetFingerprintContext): {
  scope: FleetDeltaScopeIdentity;
  axes: FleetCanonicalAxes;
} {
  const leaderBrief = asDict(context.leaderBrief);
  const fleetMetrics = asDict(leaderBrief?.fleetMetrics);
  const measured = fleetMetrics?.ok === true ? asDict(fleetMetrics.snapshot) : null;
  const metricScope = asDict(measured?.scope);
  const stock = asDict(metricScope?.stock);
  const flowScope = asDict(metricScope?.flow);
  const populations = asDict(metricScope?.population);
  const metricWindow = asDict(metricScope?.window);
  const summary = asDict(leaderBrief?.summary);
  const lifecycle = asDict(measured?.populationLifecycle) ?? asDict(summary?.populationLifecycle);
  const lifecycleWindow = asDict(lifecycle?.window);
  const requested = asDict(fleetMetrics?.requested);
  const fleet = stringValue(metricScope?.fleet) ?? stringValue(requested?.fleet) ?? context.fleet ?? null;
  const harness = stringValue(metricScope?.harness) ?? stringValue(requested?.harness) ?? context.harness ?? null;
  const flowMode = stringValue(flowScope?.mode) ?? stringValue(requested?.flowMode);
  const flowSource = stringValue(flowScope?.source) ?? stringValue(flowScope?.historyWriter);

  const metrics: FleetCanonicalAxes['metrics'] = !fleetMetrics
    ? { availability: 'absent' }
    : !measured
      ? {
          availability: 'unavailable',
          ...(typeof fleetMetrics.reason === 'string' ? { reason: fleetMetrics.reason } : {}),
        }
      : { availability: 'measured' };

  if (measured) {
    const flowValues = numericFields(measured.flow, [
      'opened', 'terminalLifecycle', 'terminalCounted', 'netLifecycle', 'netCounted',
    ]);
    if (flowValues) metrics.flow = flowValues;
    const remaining = asDict(measured.remaining);
    const remainingTotal = numberValue(remaining?.total);
    const remainingBuckets = numericFields(remaining?.buckets, [
      'needsHuman', 'blocked', 'claimHeld', 'inFlight', 'claimable', 'otherUnclaimable',
    ]);
    if (remainingTotal !== undefined && remainingBuckets) {
      metrics.remaining = { total: remainingTotal, buckets: remainingBuckets };
    }
    const authority = numericFields(measured.authority, [
      'lifecycleTerminal', 'counted', 'committed', 'validated', 'proposed', 'pendingHuman', 'invalid', 'legacy',
    ]);
    if (authority) metrics.authority = authority;
    const issueUnits = numericFields(measured.issueUnits, [
      'canonicalBugs', 'observations', 'occurrences', 'duplicateOccurrences',
    ]);
    if (issueUnits) metrics.issueUnits = issueUnits;
    const revision = numberValue(stock?.revision) ?? numberValue(flowScope?.currentRevision);
    if (revision !== undefined) metrics.specRevision = revision;
  }

  const populationLifecycle: FleetCanonicalAxes['populationLifecycle'] = lifecycle
    ? { availability: 'measured' }
    : { availability: 'absent' };
  if (lifecycle) {
    const target = stableObject(lifecycle.target, ['enabled', 'target', 'current', 'shortfall', 'underStrength', 'verdict']);
    if (target) populationLifecycle.target = target;
    const liveness = stableObject(lifecycle.liveness, [
      'byState', 'live', 'parked', 'suspect', 'dead', 'draining', 'recorded', 'unknown',
    ]);
    if (liveness) populationLifecycle.liveness = liveness;
    const claimFlow = stableObject(lifecycle.claimFlow, [
      'status', 'population', 'basis', 'claimable', 'inFlight', 'orphaned', 'stalled', 'idle',
      'criticalContext', 'values', 'reason',
    ]);
    if (claimFlow) populationLifecycle.claimFlow = claimFlow;
  }

  const capacityValue = stableObject(summary?.pool_capacity, [
    'poolExhausted', 'degraded', 'factor', 'queueDepth', 'usableAccounts', 'availableAccounts',
  ]);
  const capacity: FleetCanonicalAxes['capacity'] = capacityValue
    ? { availability: 'measured', value: capacityValue }
    : { availability: 'absent' };
  const cost: FleetCanonicalAxes['cost'] = {
    availability: 'absent',
    reason: 'canonical-cost-writer-unavailable',
  };

  const gateSource = Array.isArray(context.announcedGates)
    ? context.announcedGates
    : Array.isArray(leaderBrief?.announcedGates)
      ? leaderBrief.announcedGates
      : [];
  const gates = [...new Set(gateSource.flatMap((row) => {
    const event = stringValue(asDict(row)?.event);
    return event ? [event] : [];
  }))].sort();

  const pipeline = asDict(context.pipeline) ?? asDict(leaderBrief?.release);
  const gate = stringValue(pipeline?.gate);
  const deploy = stringValue(pipeline?.deploy);
  const promotion: FleetCanonicalAxes['promotion'] = gate || deploy
    ? { availability: 'measured', ...(gate ? { gate } : {}), ...(deploy ? { deploy } : {}) }
    : { availability: 'absent' };

  return {
    scope: {
      fleet,
      harness,
      metricsSchemaVersion: stringValue(measured?.schemaVersion) ?? stringValue(fleetMetrics?.schemaVersion),
      specId: stringValue(stock?.specId),
      flowMode,
      flowSource,
      stockPopulation: stringValue(populations?.stock),
      flowPopulation: stringValue(populations?.flow),
      workItemUnit: stringValue(asDict(measured?.flow)?.unit),
      fleetLifetime: {
        kind: stringValue(metricWindow?.kind) ?? stringValue(requested?.window),
        startAt: stringValue(metricWindow?.startAt),
        startSource: stringValue(metricWindow?.startSource),
      },
      lifecycle: {
        schemaVersion: stringValue(lifecycle?.schemaVersion),
        startAt: stringValue(lifecycleWindow?.startAt),
        startSource: stringValue(lifecycleWindow?.startSource),
      },
    },
    axes: { metrics, populationLifecycle, capacity, cost, gates, promotion },
  };
}

export function fingerprintFleet(me: unknown, context: FleetFingerprintContext = {}): FleetFingerprint | null {
  const m = me as { agents?: unknown; orphaned?: unknown; stalled?: unknown } | null | undefined;
  if (!m || !Array.isArray(m.agents)) return null;
  const members: Record<string, MemberFingerprint> = {};
  for (const raw of m.agents as AssignmentsAgentRow[]) {
    const id = typeof raw?.agentId === 'string' ? raw.agentId : null;
    if (!id) continue;
    const fp: MemberFingerprint = {};
    if (typeof raw.verdict === 'string') fp.v = raw.verdict;
    if (typeof raw.sessionState === 'string') fp.s = raw.sessionState;
    if (typeof raw.doing === 'string') fp.d = raw.doing.slice(0, 40);
    else if (raw.doing && typeof (raw.doing as { id?: unknown }).id === 'string') {
      fp.d = ((raw.doing as { id: string }).id).slice(0, 40);
    }
    if (typeof raw.claims === 'number') fp.c = raw.claims;
    if (typeof raw.contextPressure === 'string') fp.p = raw.contextPressure;
    members[id] = fp;
  }
  const canonical = canonicalProjection(context);
  return {
    schemaVersion: FLEET_DELTA_SCHEMA_VERSION,
    scope: canonical.scope,
    members,
    orphaned: Array.isArray(m.orphaned) ? m.orphaned.length : 0,
    stalled: Array.isArray(m.stalled) ? m.stalled.length : 0,
    axes: canonical.axes,
  };
}

function sameMember(a: MemberFingerprint, b: MemberFingerprint): boolean {
  return a.v === b.v && a.s === b.s && a.d === b.d && a.c === b.c && a.p === b.p;
}
const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

function changedFields(before: unknown, after: unknown): Record<string, FleetAxisChange> | undefined {
  const a = asDict(before) ?? {};
  const b = asDict(after) ?? {};
  const out: Record<string, FleetAxisChange> = {};
  for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    if (!sameValue(a[key], b[key])) out[key] = { from: a[key], to: b[key] };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function scopeMismatchReason(
  committed: FleetDeltaScopeIdentity,
  current: FleetDeltaScopeIdentity,
): NonNullable<FleetDelta['reset']>['reason'] | null {
  if (!sameValue(committed.fleetLifetime, current.fleetLifetime) || !sameValue(committed.lifecycle, current.lifecycle)) {
    return 'window-mismatch';
  }
  if (committed.stockPopulation !== current.stockPopulation || committed.flowPopulation !== current.flowPopulation) {
    return 'population-mismatch';
  }
  const { fleetLifetime: _cfw, lifecycle: _cl, stockPopulation: _csp, flowPopulation: _cfp, ...committedBase } = committed;
  const { fleetLifetime: _nfw, lifecycle: _nl, stockPopulation: _nsp, flowPopulation: _nfp, ...currentBase } = current;
  return sameValue(committedBase, currentBase) ? null : 'scope-mismatch';
}

export function diffFleet(committed: unknown, current: FleetFingerprint): FleetDelta {
  const prior = asDict(committed);
  if (prior?.schemaVersion !== FLEET_DELTA_SCHEMA_VERSION) {
    return {
      schemaVersion: FLEET_DELTA_SCHEMA_VERSION,
      rows: [],
      unchanged: 0,
      reset: { reason: 'schema-mismatch' },
      fullReplacement: true,
    };
  }
  const previous = prior as unknown as FleetFingerprint;
  const mismatch = scopeMismatchReason(previous.scope, current.scope);
  if (mismatch) {
    return {
      schemaVersion: FLEET_DELTA_SCHEMA_VERSION,
      rows: [],
      unchanged: 0,
      reset: { reason: mismatch },
      fullReplacement: true,
    };
  }

  const rows: FleetDeltaRow[] = [];
  let unchanged = 0;
  const beforeMembers = previous.members ?? {};
  const afterMembers = current.members ?? {};
  for (const [id, to] of Object.entries(afterMembers)) {
    const from = beforeMembers[id];
    if (!from) rows.push({ change: 'added', type: 'member', id, to });
    else if (!sameMember(from, to)) rows.push({ change: 'updated', type: 'member', id, from, to });
    else unchanged += 1;
  }
  for (const [id, from] of Object.entries(beforeMembers)) {
    if (!afterMembers[id]) rows.push({ change: 'removed', type: 'member', id, from });
  }

  const axes: Record<string, unknown> = {};
  const metricAvailability = changedFields(
    { availability: previous.axes.metrics.availability, reason: previous.axes.metrics.reason },
    { availability: current.axes.metrics.availability, reason: current.axes.metrics.reason },
  );
  const flow = changedFields(previous.axes.metrics.flow, current.axes.metrics.flow);
  const remainingTotal = changedFields(
    { total: previous.axes.metrics.remaining?.total },
    { total: current.axes.metrics.remaining?.total },
  );
  const remainingBuckets = changedFields(previous.axes.metrics.remaining?.buckets, current.axes.metrics.remaining?.buckets);
  const authority = changedFields(previous.axes.metrics.authority, current.axes.metrics.authority);
  const issueUnits = changedFields(previous.axes.metrics.issueUnits, current.axes.metrics.issueUnits);
  const specRevision = changedFields(
    { revision: previous.axes.metrics.specRevision },
    { revision: current.axes.metrics.specRevision },
  );
  if (metricAvailability || flow || remainingTotal || remainingBuckets || authority || issueUnits || specRevision) {
    axes.metrics = {
      ...(metricAvailability ? { availability: metricAvailability } : {}),
      ...(flow ? { flow } : {}),
      ...(remainingTotal || remainingBuckets
        ? { remaining: { ...(remainingTotal ?? {}), ...(remainingBuckets ? { buckets: remainingBuckets } : {}) } }
        : {}),
      ...(authority ? { authority } : {}),
      ...(issueUnits ? { issueUnits } : {}),
      ...(specRevision ? { specRevision } : {}),
    };
  }

  const population = changedFields(previous.axes.populationLifecycle, current.axes.populationLifecycle);
  if (population) axes.populationLifecycle = population;
  if (!sameValue(previous.axes.capacity, current.axes.capacity)) {
    axes.capacity = { from: previous.axes.capacity, to: current.axes.capacity };
  }
  if (!sameValue(previous.axes.cost, current.axes.cost)) {
    axes.cost = { from: previous.axes.cost, to: current.axes.cost };
  }
  if (!sameValue(previous.axes.gates, current.axes.gates)) {
    axes.gates = { from: previous.axes.gates, to: current.axes.gates };
  }
  if (!sameValue(previous.axes.promotion, current.axes.promotion)) {
    axes.promotion = { from: previous.axes.promotion, to: current.axes.promotion };
  }

  const delta: FleetDelta = {
    schemaVersion: FLEET_DELTA_SCHEMA_VERSION,
    rows,
    unchanged,
    ...(Object.keys(axes).length > 0 ? { axes } : {}),
  };
  if (previous.orphaned !== current.orphaned) delta.orphaned = { from: previous.orphaned, to: current.orphaned };
  if (previous.stalled !== current.stalled) delta.stalled = { from: previous.stalled, to: current.stalled };
  return delta;
}

export function slimAssignmentsForDelta(me: unknown): unknown {
  const m = me as Record<string, unknown> | null | undefined;
  if (!m || !Array.isArray(m.agents)) return me;
  const selfRow = (m.agents as Array<{ isSelf?: unknown }>).find((a) => a?.isSelf === true);
  const elided = (m.agents as unknown[]).length - (selfRow ? 1 : 0);
  return {
    ...m,
    agents: selfRow ? [selfRow] : [],
    peerRowsElidedFromScope: elided,
    elidedIsScopeRelative: true,
  };
}
