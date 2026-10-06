/** Pinned GOAL content, shared by publishing, delivery and the report card. */
export interface GoalOwnerReportSnapshotV1 {
  schemaVersion: 1;
  workspaceId: string;
  goalId: string;
  observedAt: string;
  sources: Array<{
    ref: string; revision: string; observedAt: string; measuredAt: string | null;
    availability: 'value' | 'unknown'; unknownReason?: string;
  }>;
  moved: Array<{
    ref: string; state: string; stateObservedAt: string;
    successfulMutations: Array<{ receiptRef: string; operation: string; persistedAt: string }>;
    completionEvidenceRefs: string[]; verification: 'verified' | 'unverified';
  }>;
  cost: {
    spentCents: number | null; budgetCents: number | null; budgetWindowSec: number | null;
    sourceRef: string; sourceRevision: string; measuredAt: string | null; readAt: string;
    coverage: string; unknownReason?: string;
  };
  ownerWalls: Array<{
    itemRef: string; exactAction: string; decisionRefs: string[]; artifactRefs: string[];
    sourceRevision: string;
  }>;
  coverage: {
    checkedRefs: string[]; uncheckedRefs: string[]; notApplicableRefs: string[];
    unknowns: Array<{ ref: string; reason: string }>; residueRefs: string[];
  };
  killed: Array<{ ref: string; disposition: string; evidenceRefs: string[]; at: string }>;
  nextWake: {
    kind: 'loop' | 'event' | 'owner' | 'unknown'; ref: string | null;
    expectedAt: string | null; evidenceRef: string | null; unknownReason?: string;
  };
}

/** Workspace is resolved by the server, never chosen by a reference caller. */
export interface GoalOwnerReportRefV1 {
  schemaVersion: 1;
  goalId: string;
  reportId: string;
  bodySha256: string;
}

const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const identity = (v: unknown): v is string => text(v) && v === v.trim();
const texts = (v: unknown): v is string[] => Array.isArray(v) && v.every(text);
const utc = (v: unknown): v is string => text(v) &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(v) &&
  Number.isFinite(Date.parse(v)) && new Date(v).toISOString().replace('.000Z', 'Z') === v.replace('.000Z', 'Z');
const nullableUtc = (v: unknown) => v === null || utc(v);
const nullableText = (v: unknown) => v === null || text(v);
const nullableNumber = (v: unknown) => v === null ||
  (typeof v === 'number' && Number.isFinite(v) && v >= 0);
const optionalText = (v: unknown) => v === undefined || text(v);
const rows = (v: unknown, valid: (row: unknown) => boolean) => Array.isArray(v) && v.every(valid);
function object(v: unknown, keys: string[]): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) &&
    Object.keys(v).every((key) => keys.includes(key));
}

/** Validate without normalizing: exact actions/timestamps must survive storage. */
export function parseGoalOwnerReportSnapshot(value: unknown): GoalOwnerReportSnapshotV1 | null {
  if (!object(value, ['schemaVersion', 'workspaceId', 'goalId', 'observedAt', 'sources', 'moved',
    'cost', 'ownerWalls', 'coverage', 'killed', 'nextWake'])) return null;
  const s = value;
  if (s.schemaVersion !== 1 || !identity(s.workspaceId) || !identity(s.goalId) || !utc(s.observedAt)) return null;
  if (!rows(s.sources, (r) => object(r, ['ref', 'revision', 'observedAt', 'measuredAt', 'availability', 'unknownReason']) &&
    text(r.ref) && text(r.revision) && utc(r.observedAt) && nullableUtc(r.measuredAt) &&
    (r.availability === 'value' || r.availability === 'unknown') && optionalText(r.unknownReason) &&
    (r.availability !== 'unknown' || text(r.unknownReason)))) return null;
  if (!rows(s.moved, (r) => object(r, ['ref', 'state', 'stateObservedAt', 'successfulMutations', 'completionEvidenceRefs', 'verification']) &&
    text(r.ref) && text(r.state) && utc(r.stateObservedAt) && texts(r.completionEvidenceRefs) &&
    (r.verification === 'verified' || r.verification === 'unverified') &&
    (r.verification !== 'verified' || r.completionEvidenceRefs.length > 0) &&
    rows(r.successfulMutations, (m) => object(m, ['receiptRef', 'operation', 'persistedAt']) &&
      text(m.receiptRef) && text(m.operation) && utc(m.persistedAt)))) return null;
  const c = s.cost;
  if (!object(c, ['spentCents', 'budgetCents', 'budgetWindowSec', 'sourceRef', 'sourceRevision', 'measuredAt', 'readAt', 'coverage', 'unknownReason']) ||
    !nullableNumber(c.spentCents) || !nullableNumber(c.budgetCents) || !nullableNumber(c.budgetWindowSec) ||
    !text(c.sourceRef) || !text(c.sourceRevision) || !nullableUtc(c.measuredAt) || !utc(c.readAt) ||
    !text(c.coverage) || !optionalText(c.unknownReason) || (c.spentCents === null && !text(c.unknownReason))) return null;
  if (!rows(s.ownerWalls, (r) => object(r, ['itemRef', 'exactAction', 'decisionRefs', 'artifactRefs', 'sourceRevision']) &&
    text(r.itemRef) && text(r.exactAction) && texts(r.decisionRefs) && texts(r.artifactRefs) && text(r.sourceRevision))) return null;
  const coverage = s.coverage;
  if (!object(coverage, ['checkedRefs', 'uncheckedRefs', 'notApplicableRefs', 'unknowns', 'residueRefs']) ||
    !texts(coverage.checkedRefs) || !texts(coverage.uncheckedRefs) || !texts(coverage.notApplicableRefs) ||
    !texts(coverage.residueRefs) || !rows(coverage.unknowns, (r) => object(r, ['ref', 'reason']) && text(r.ref) && text(r.reason))) return null;
  if (!rows(s.killed, (r) => object(r, ['ref', 'disposition', 'evidenceRefs', 'at']) &&
    text(r.ref) && text(r.disposition) && texts(r.evidenceRefs) && utc(r.at))) return null;
  const wake = s.nextWake;
  if (!object(wake, ['kind', 'ref', 'expectedAt', 'evidenceRef', 'unknownReason']) ||
    !['loop', 'event', 'owner', 'unknown'].includes(String(wake.kind)) || !nullableText(wake.ref) ||
    !nullableUtc(wake.expectedAt) || !nullableText(wake.evidenceRef) || !optionalText(wake.unknownReason) ||
    (wake.kind === 'unknown' && !text(wake.unknownReason))) return null;
  return s as unknown as GoalOwnerReportSnapshotV1;
}

export function parseGoalOwnerReportRef(value: unknown): GoalOwnerReportRefV1 | null {
  if (!object(value, ['schemaVersion', 'goalId', 'reportId', 'bodySha256']) ||
    value.schemaVersion !== 1 || !identity(value.goalId) || !identity(value.reportId) ||
    typeof value.bodySha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.bodySha256)) return null;
  return value as unknown as GoalOwnerReportRefV1;
}

/** One deterministic full-body serialization; never derived from latest lineage. */
export function serializeGoalOwnerReportSnapshot(s: GoalOwnerReportSnapshotV1): string {
  if (!parseGoalOwnerReportSnapshot(s)) throw new Error('invalid GOAL report snapshot');
  const refs = (r: string[]) => r.length ? r.join(', ') : 'none declared';
  const lines = [
    `Goal ${s.goalId}; workspace ${s.workspaceId}; snapshot observed at ${s.observedAt}`,
    'Source evidence:',
    ...s.sources.map((r) => `- ${r.ref}; revision=${r.revision}; observed at=${r.observedAt}; measured at=${r.measuredAt ?? 'unknown'}; availability=${r.availability}${r.unknownReason ? `; unknown: ${r.unknownReason}` : ''}`),
    'MOVED:',
    ...(s.moved.length ? s.moved.flatMap((r) => [
      `- ${r.ref}; state=${r.state}; state observed at=${r.stateObservedAt}; completion ${r.verification}; evidence=${refs(r.completionEvidenceRefs)}`,
      ...r.successfulMutations.map((m) => `  - Successful mutation: ${m.operation}; receipt=${m.receiptRef}; persisted at=${m.persistedAt}`),
      ...(r.successfulMutations.length ? [] : ['  - No successful mutation receipts declared; a state observation is not a mutation.']),
    ]) : ['No movement records declared in this snapshot.']),
    `Coverage: checked=${refs(s.coverage.checkedRefs)}; unchecked=${refs(s.coverage.uncheckedRefs)}; not applicable=${refs(s.coverage.notApplicableRefs)}; residue=${refs(s.coverage.residueRefs)}`,
    ...s.coverage.unknowns.map((r) => `Unknown: ${r.ref}; reason=${r.reason}`),
    'COST:',
    `Spent=${s.cost.spentCents === null ? 'unknown' : `${s.cost.spentCents} cents`}; budget=${s.cost.budgetCents ?? 'unknown'} cents; budget window=${s.cost.budgetWindowSec ?? 'unknown'} seconds; coverage=${s.cost.coverage}`,
    `Source=${s.cost.sourceRef}; revision=${s.cost.sourceRevision}; measured at=${s.cost.measuredAt ?? 'unknown'}; read at=${s.cost.readAt}${s.cost.unknownReason ? `; unknown: ${s.cost.unknownReason}` : ''}`,
    'OWNER-WALLED:',
    ...(s.ownerWalls.length ? s.ownerWalls.map((r) => `- ${r.itemRef}; exact action: ${r.exactAction}; decisions=${refs(r.decisionRefs)}; artifacts=${refs(r.artifactRefs)}; source revision=${r.sourceRevision}`) : ['No owner actions declared in this snapshot.']),
    'KILLED:',
    ...(s.killed.length ? s.killed.map((r) => `- Historical disposition: ${r.ref}; ${r.disposition}; at=${r.at}; evidence=${refs(r.evidenceRefs)}`) : ['No historical dispositions declared in this snapshot.']),
    'NEXT WAKE:',
    `Kind=${s.nextWake.kind}; ref=${s.nextWake.ref ?? 'unknown'}; expected at=${s.nextWake.expectedAt ?? 'unknown'}; evidence=${s.nextWake.evidenceRef ?? 'unknown'}${s.nextWake.unknownReason ? `; unknown: ${s.nextWake.unknownReason}` : ''}`,
  ];
  return lines.join('\n');
}
