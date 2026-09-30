/**
 * Payload-tier projection for work_items:burn_down.
 *
 * The burn-down handler deliberately computes its aggregates over the whole
 * fetched census. Returning every itemized row, however, lets the generic
 * payload projector cut an array in the middle of a row and append a string
 * marker to a typed row array. That is not merely a shortened answer: it no
 * longer conforms to the tool's declared result schema. This shaper keeps the
 * aggregate facts and projects complete, schema-shaped rows before the generic
 * hard ceiling has a chance to run.
 */

import { fleetMetricsResultSchema } from '../fleet/fleet-metrics-contract';
import { countEvidenceBundleSchema } from '../../count-evidence-contract';

type JsonObject = Record<string, unknown>;
export type BurnDownPayloadTier = 'trimmed' | 'standard';

export interface BurnDownShapeArgs {
  limit?: unknown;
  ids?: unknown;
}

const TIER_CAPS = {
  trimmed: {
    rowsPerBucket: 10,
    deltaRows: 8,
    cohortRows: 20,
    title: 96,
    reason: 180,
    note: 420,
  },
  standard: {
    rowsPerBucket: 20,
    deltaRows: 15,
    cohortRows: 40,
    title: 140,
    reason: 300,
    note: 600,
  },
} as const;

const PARKED_MECHANISMS = new Set([
  'claimHold',
  'agent-review',
  'blocked',
  'needs-human',
  'external-blocker',
  'state',
]);

function object(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function requiredString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function projectQueueControl(value: unknown, textCap: number): JsonObject | undefined {
  const source = object(value);
  if (!source) return undefined;
  const active = object(source.activeClaim);
  const lease = object(source.holdOpenLease);
  const park = object(source.durablePark);
  const review = object(source.agentReview);
  const age = (value: unknown) => {
    const row = object(value);
    return row ? { status: stringOrNull(row.status), ageMs: numberOrNull(row.ageMs), bucket: stringOrNull(row.bucket) } : null;
  };
  const release = park ? object(park.releaseLiveness) : null;
  const condition = park ? object(park.unparkCondition) : null;
  return {
    activeClaim: active ? { owner: stringOrNull(active.owner), claimedAt: stringOrNull(active.claimedAt) } : null,
    holdOpenLease: lease ? {
      holder: stringOrNull(lease.holder), reason: clip(lease.reason, textCap),
      heldAt: stringOrNull(lease.heldAt), age: age(lease.age),
    } : null,
    durablePark: park ? {
      parker: stringOrNull(park.parker), reason: clip(park.reason, textCap),
      parkedAt: stringOrNull(park.parkedAt), age: age(park.age),
      unparkCondition: condition ? { status: stringOrNull(condition.status), text: clip(condition.text, textCap) } : null,
      releaseLiveness: release ? {
        status: stringOrNull(release.status), contractPresent: release.contractPresent === true,
        condition: stringOrNull(release.condition), owner: stringOrNull(release.owner),
        trigger: clip(release.trigger, textCap), reachability: stringOrNull(release.reachability),
        evidence: clip(release.evidence, textCap),
        findings: Array.isArray(release.findings) ? release.findings.map(String) : [],
      } : null,
    } : null,
    agentReview: review ? {
      status: stringOrNull(review.status), submittedBy: stringOrNull(review.submittedBy),
      ledgerIdeaId: stringOrNull(review.ledgerIdeaId), round: numberOrNull(review.round),
    } : null,
    unattributedClaimHold: source.unattributedClaimHold === true,
  };
}

function clip(value: unknown, max: number): string {
  const text = requiredString(value);
  if (text.length <= max) return text;
  const marker = `…[TRUNCATED +${text.length - max} chars — re-read with payloadTier:'full']`;
  return text.slice(0, Math.max(0, max - marker.length)) + marker;
}

function projectRow(value: unknown, titleCap: number): JsonObject | null {
  const row = object(value);
  if (!row || typeof row.id !== 'string' || typeof row.kind !== 'string') return null;
  const queueControl = projectQueueControl(row.queueControl, titleCap);
  return {
    id: row.id,
    kind: requiredString(row.kind),
    family: requiredString(row.family),
    harness: stringOrNull(row.harness),
    title: clip(row.title, titleCap),
    state: requiredString(row.state),
    assignee: stringOrNull(row.assignee),
    ...(typeof row.assigneeLive === 'boolean' ? { assigneeLive: row.assigneeLive } : {}),
    takenAt: stringOrNull(row.takenAt),
    lastProgressAt: stringOrNull(row.lastProgressAt),
    updatedAt: requiredString(row.updatedAt),
    severity: stringOrNull(row.severity),
    priority: numberOrNull(row.priority),
    ...(queueControl ? { queueControl } : {}),
  };
}

function projectRows(value: unknown, cap: number, titleCap: number): JsonObject[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((row) => projectRow(row, titleCap))
    .filter((row): row is JsonObject => row !== null)
    .slice(0, cap);
}

function projectParkedRow(value: unknown, titleCap: number, reasonCap: number): JsonObject | null {
  const row = projectRow(value, titleCap);
  const source = object(value);
  if (!row || !source || typeof source.reason !== 'string' || !PARKED_MECHANISMS.has(String(source.mechanism))) {
    return null;
  }
  return {
    ...row,
    reason: clip(source.reason, reasonCap),
    mechanism: source.mechanism,
    ...(typeof source.aliasedState === 'string' ? { aliasedState: source.aliasedState } : {}),
  };
}

function projectParkedRows(value: unknown, cap: number, titleCap: number, reasonCap: number): JsonObject[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((row) => projectParkedRow(row, titleCap, reasonCap))
    .filter((row): row is JsonObject => row !== null)
    .slice(0, cap);
}

function projectDeltaRow(value: unknown, titleCap: number): JsonObject | null {
  const row = object(value);
  if (!row || typeof row.id !== 'string' || typeof row.kind !== 'string') return null;
  return {
    id: row.id,
    kind: row.kind,
    title: clip(row.title, titleCap),
    state: requiredString(row.state),
    harness: stringOrNull(row.harness),
    ts: requiredString(row.ts),
  };
}

function projectDelta(value: unknown, rowCap: number, titleCap: number): JsonObject | undefined {
  const source = object(value);
  if (!source) return undefined;
  const rawRows = Array.isArray(source.rows) ? source.rows : [];
  const rows = rawRows
    .map((row) => projectDeltaRow(row, titleCap))
    .filter((row): row is JsonObject => row !== null)
    .slice(0, rowCap);
  const total = numberOrZero(source.total) || rawRows.length;
  return {
    rows,
    total,
    truncated: source.truncated === true || rawRows.length > rowCap || total > rows.length,
  };
}

function projectTerminal(value: unknown, noteCap: number): JsonObject {
  const source = object(value) ?? {};
  const terminal: JsonObject = {
    total: numberOrZero(source.total),
    done: numberOrZero(source.done),
    passed: numberOrZero(source.passed),
    resolved: numberOrZero(source.resolved),
    closed: numberOrZero(source.closed),
    deprecated: numberOrZero(source.deprecated),
    dropped: numberOrZero(source.dropped),
    deltaSince: stringOrNull(source.deltaSince),
    delta: numberOrZero(source.delta),
    deltaClosedUndated: numberOrZero(source.deltaClosedUndated),
    truncatedByLimit: source.truncatedByLimit === true,
    censusLimit: numberOrZero(source.censusLimit),
  };

  const deltaBy = object(source.deltaBy);
  if (deltaBy) {
    const basis = object(deltaBy.basis) ?? {};
    terminal.deltaBy = {
      fleet: numberOrNull(deltaBy.fleet),
      otherAgents: numberOrZero(deltaBy.otherAgents),
      system: numberOrZero(deltaBy.system),
      unattributed: numberOrZero(deltaBy.unattributed),
      basis: {
        fleet: stringOrNull(basis.fleet),
        fleetSource:
          basis.fleetSource === 'arg' || basis.fleetSource === 'caller-membership'
            ? basis.fleetSource
            : null,
        membership: basis.membership === 'ever-members' ? 'ever-members' : null,
        memberCount: numberOrNull(basis.memberCount),
        note: clip(basis.note, noteCap),
      },
    };
  }
  if (typeof source.deltaByPartitions === 'boolean') {
    terminal.deltaByPartitions = source.deltaByPartitions;
  }

  const authority = object(source.authority) ?? {};
  terminal.authority = {
    counted: numberOrZero(authority.counted),
    committed: numberOrZero(authority.committed),
    validated: numberOrZero(authority.validated),
    proposed: numberOrZero(authority.proposed),
    pendingHuman: numberOrZero(authority.pendingHuman),
    invalid: numberOrZero(authority.invalid),
    legacy: numberOrZero(authority.legacy),
  };
  return terminal;
}

function projectCohortAudit(value: unknown, cap: number, titleCap: number, reasonCap: number): JsonObject | undefined {
  const source = object(value);
  if (!source) return undefined;
  const rawRows = Array.isArray(source.rows) ? source.rows : [];
  const rows = rawRows
    .map((value): JsonObject | null => {
      const row = object(value);
      if (!row || typeof row.id !== 'string') return null;
      const bucket = ['terminal', 'parked', 'in-flight', 'unclaimed', 'missing'].includes(String(row.bucket))
        ? row.bucket
        : 'missing';
      const evidence = ['verified', 'incomplete', 'missing', 'not-applicable'].includes(String(row.evidenceVerdict))
        ? row.evidenceVerdict
        : 'not-applicable';
      return {
        id: row.id,
        title: stringOrNull(row.title) == null ? null : clip(row.title, titleCap),
        state: stringOrNull(row.state),
        bucket,
        closureKind: stringOrNull(row.closureKind),
        evidenceVerdict: evidence,
        completionRef: stringOrNull(row.completionRef),
        terminalOwner: stringOrNull(row.terminalOwner),
        reopenRecommended: row.reopenRecommended === true,
        recommendation: stringOrNull(row.recommendation) == null ? null : clip(row.recommendation, reasonCap),
      };
    })
    .filter((row): row is JsonObject => row !== null)
    .slice(0, cap);
  return {
    requested: numberOrZero(source.requested),
    found: numberOrZero(source.found),
    missing: numberOrZero(source.missing),
    reopenRecommended: numberOrZero(source.reopenRecommended),
    rows,
    truncated: source.truncated === true || rawRows.length > cap,
  };
}

function projectFence(value: unknown, noteCap: number): JsonObject | undefined {
  const source = object(value);
  if (!source || source.lane !== 'p2p-lane') return undefined;
  return {
    lane: 'p2p-lane',
    candidates: numberOrZero(source.candidates),
    counted: numberOrZero(source.counted),
    excluded: numberOrZero(source.excluded),
    note: clip(source.note, noteCap),
  };
}

function projectDrainFlow(value: unknown, noteCap: number): JsonObject | undefined {
  const source = object(value);
  if (!source || source.exact !== true) return undefined;
  const projectCount = (value: unknown): JsonObject => {
    const count = object(value) ?? {};
    return {
      opened: numberOrZero(count.opened),
      terminaled: numberOrZero(count.terminaled),
      net: typeof count.net === 'number' && Number.isFinite(count.net) ? count.net : 0,
    };
  };
  const bySeverity = object(source.bySeverity) ?? {};
  const breaker = object(source.breaker) ?? {};
  return {
    exact: true,
    windowStart: requiredString(source.windowStart),
    workspaceId: requiredString(source.workspaceId),
    harness: requiredString(source.harness),
    ownerId: requiredString(source.ownerId),
    totals: projectCount(source.totals),
    bySeverity: {
      critical: projectCount(bySeverity.critical),
      major: projectCount(bySeverity.major),
      minor: projectCount(bySeverity.minor),
      nit: projectCount(bySeverity.nit),
    },
    breaker: {
      tripped: breaker.tripped === true,
      blocksNewBugs: breaker.blocksNewBugs === true,
      rule: clip(breaker.rule, noteCap),
      reason: clip(breaker.reason, noteCap),
    },
  };
}

function projectIssueOccurrences(value: unknown): JsonObject | undefined {
  const source = object(value);
  const units = object(source?.units);
  if (!source || !units || source.writer !== 'harness_shared.work_item_occurrences') return undefined;
  return {
    canonicalClusters: numberOrZero(source.canonicalClusters),
    rawOccurrences: numberOrZero(source.rawOccurrences),
    duplicateOccurrences: numberOrZero(source.duplicateOccurrences),
    units: {
      canonicalClusters: requiredString(units.canonicalClusters),
      rawOccurrences: requiredString(units.rawOccurrences),
      duplicateOccurrences: requiredString(units.duplicateOccurrences),
    },
    writer: 'harness_shared.work_item_occurrences',
  };
}

function projectCountEvidence(value: unknown): JsonObject | undefined {
  const source = object(value);
  if (!source) return undefined;
  const parsed = countEvidenceBundleSchema.safeParse({
    contract: source.contract,
    metrics: source.metrics,
  });
  const populationState = object(source.populationState);
  if (!parsed.success || !populationState) return undefined;
  if (populationState.kind === 'fixed-cohort') {
    if (
      typeof populationState.fixedCohortComplete !== 'boolean' ||
      populationState.liveOpenPopulationEmpty !== null ||
      typeof populationState.missingIds !== 'number'
    ) return undefined;
    return {
      ...parsed.data,
      populationState: {
        kind: 'fixed-cohort',
        fixedCohortComplete: populationState.fixedCohortComplete,
        liveOpenPopulationEmpty: null,
        missingIds: populationState.missingIds,
        note: requiredString(populationState.note),
      },
    };
  }
  if (populationState.kind === 'live-census') {
    if (
      populationState.fixedCohortComplete !== null ||
      typeof populationState.liveOpenPopulationEmpty !== 'boolean' ||
      populationState.missingIds !== null
    ) return undefined;
    return {
      ...parsed.data,
      populationState: {
        kind: 'live-census',
        fixedCohortComplete: null,
        liveOpenPopulationEmpty: populationState.liveOpenPopulationEmpty,
        missingIds: null,
        note: requiredString(populationState.note),
      },
    };
  }
  return undefined;
}

export function shapeBurnDown(
  data: unknown,
  tier: BurnDownPayloadTier,
  args: BurnDownShapeArgs = {},
): unknown {
  const source = object(data);
  if (!source) return data;
  const caps = TIER_CAPS[tier];
  const requestedLimit = typeof args.limit === 'number' && Number.isFinite(args.limit) ? args.limit : caps.rowsPerBucket;
  const rowCap = Math.max(0, Math.min(caps.rowsPerBucket, Math.floor(requestedLimit)));
  const rawInFlight = Array.isArray(source.inFlight) ? source.inFlight : [];
  const rawParked = Array.isArray(source.parked) ? source.parked : [];
  const rawUnclaimed = Array.isArray(source.unclaimed) ? source.unclaimed : [];
  const counts = object(source.counts) ?? {};
  const totalFor = (key: string, raw: unknown[]) => numberOrZero(counts[key]) || raw.length;
  const inFlight = projectRows(rawInFlight, rowCap, caps.title);
  const parked = projectParkedRows(rawParked, rowCap, caps.title, caps.reason);
  const unclaimed = projectRows(rawUnclaimed, rowCap, caps.title);
  const out: JsonObject = {
    ok: source.ok === true,
    harness: requiredString(source.harness),
    generatedAt: requiredString(source.generatedAt),
    terminal: projectTerminal(source.terminal, caps.note),
    inFlight,
    parked,
    unclaimed,
    counts: {
      total: numberOrZero(counts.total),
      terminal: numberOrZero(counts.terminal),
      inFlight: numberOrZero(counts.inFlight),
      parked: numberOrZero(counts.parked),
      unclaimed: numberOrZero(counts.unclaimed),
    },
    presentation: {
      tier,
      rowCap,
      note: `Itemized rows are capped at ${rowCap} per bucket for the ${tier} payload tier; aggregate counts remain complete. Re-read with payloadTier:'full' for every row.`,
      rows: {
        inFlight: { shown: inFlight.length, total: totalFor('inFlight', rawInFlight), truncated: totalFor('inFlight', rawInFlight) > inFlight.length },
        parked: { shown: parked.length, total: totalFor('parked', rawParked), truncated: totalFor('parked', rawParked) > parked.length },
        unclaimed: { shown: unclaimed.length, total: totalFor('unclaimed', rawUnclaimed), truncated: totalFor('unclaimed', rawUnclaimed) > unclaimed.length },
      },
    },
  };

  const closedSince = projectDelta(source.closedSince, caps.deltaRows, caps.title);
  if (closedSince) out.closedSince = closedSince;
  const openedSince = projectDelta(source.openedSince, caps.deltaRows, caps.title);
  if (openedSince) out.openedSince = openedSince;
  const fence = projectFence(source.fence, caps.note);
  if (fence) out.fence = fence;
  const drainFlow = projectDrainFlow(source.drainFlow, caps.note);
  if (drainFlow) out.drainFlow = drainFlow;
  const issueOccurrences = projectIssueOccurrences(source.issueOccurrences);
  if (issueOccurrences) out.issueOccurrences = issueOccurrences;
  const fleetMetrics = fleetMetricsResultSchema.safeParse(source.fleetMetrics);
  if (fleetMetrics.success) out.fleetMetrics = fleetMetrics.data;
  const countEvidence = projectCountEvidence(source.countEvidence);
  if (countEvidence) out.countEvidence = countEvidence;
  const cohortAudit = projectCohortAudit(source.cohortAudit, caps.cohortRows, caps.title, caps.reason);
  if (cohortAudit) out.cohortAudit = cohortAudit;
  return out;
}
