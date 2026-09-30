/**
 * work_items:burn_down — leader-facing census over the unified work queue.
 *
 * This is a read-only rollup over existing surfaces: work_items:list row shape,
 * coord presence liveness, and the issue-family `_claimHold` payload marker. It
 * gives drain/fleet leaders one stable response instead of rejoining
 * work_items:list + coord:presence client-side on every wake.
 */
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { listPresence, PRESENCE_STALE_MS } from '../coordination/presence';
import {
  explainIssueClaimFloors,
  listWorkItems,
  getWorkItem,
  readWorkItemClaimHoldProvenance,
  WORK_ITEMS_MAX_LIMIT,
  type ClaimFloorAttribution,
  type WorkItem,
  type WorkItemKind,
} from '../../work-items';
import { ANY_FAMILY_TERMINAL_STATES } from '../../work-item-dispatch-states';
import { countsTowardBurnDown } from '../../work-item-completion-authority';
import { classifyTerminalOwner } from '../../completion-audit';
import { resolveSelfRef } from '../coordination/self-marker';
import { buildP2pLaneFence } from '../../scheduler/p2p-lane-fence';
import { matchesClaimSpecFilter, claimSpecSubjectFromWorkItem } from '../../scheduler/claim-spec-match';
import { shapeBurnDown } from './burn_down-shape';
import { getModes } from '../../modes/store';
import { readDrainFlow, type DrainFlowReport } from './drain-flow';
import { readIssueOccurrenceCounts, type IssueOccurrenceCounts } from '../../issue-occurrence-ledger';
import { readAgentReviewState } from '../../harness/improvements/agent-review-policy';
import {
  classifyAuditAge,
  classifyDurableParkReleaseLiveness,
  classifyUnparkCondition,
  type AuditAge,
  type DurableParkReleaseLiveness,
  type UnparkConditionStatus,
} from '../../work-items-durable-park-audit';
import { resolveConcreteWorkspaceId } from '../../workspace-registry';
import {
  FLEET_METRIC_ADMISSION_PARITY,
  FLEET_METRIC_REMAINING_PRECEDENCE,
  FLEET_METRIC_UNITS,
  FLEET_METRIC_WRITERS,
  FLEET_METRICS_SCHEMA_VERSION,
  fleetMetricsResultSchema,
  parseFleetMetricsResult,
  type FleetMetricsResult,
} from '../fleet/fleet-metrics-contract';
import {
  resolveFleetMetricScope,
  selectFleetMetricCurrentItems,
  selectFleetMetricFlowEvents,
  type FleetMetricFlowMode,
  type FleetMetricScopeResolution,
  type ResolvedFleetMetricScope,
} from '../fleet/fleet-metrics-scope';
import {
  COUNT_EVIDENCE_COMPARISON_RULE,
  COUNT_EVIDENCE_SCHEMA_VERSION,
  countEvidenceBundleSchema,
  type CountContractDimension,
  type CountCutoff,
  type CountEvidenceBundle,
  type CountEvidenceMetric,
  type CountExactness,
} from '../../count-evidence-contract';

/**
 * P-011 (fleet-lead-instrumentation-audit-2026-08-09) — what a lane fence removed
 * from this census, reported so a lane-scoped burn-down never looks like a
 * harness-wide one.
 *
 * WHY THE FENCE LIVES HERE AT ALL. The real burn-down metric is terminal
 * transitions, which this tool computes — but a DRAIN fleet's mission is a LANE,
 * and this tool had no way to express one. So the leader hand-rolled the same
 * measurement in SQL with a hand-maintained p2p title regex re-typed into every
 * query: the exact per-query hand-typing the fence macro exists to end, and a
 * silent divergence between what the fleet may CLAIM and what its progress is
 * MEASURED over. `fence: 'p2p-lane'` applies the SAME `buildP2pLaneFence()`
 * FilterNode through the SAME evaluator the claim path uses
 * (`matchesClaimSpecFilter`), so the two cannot drift by construction.
 */
export interface BurnDownFenceReport {
  /** The lane macro applied. */
  lane: 'p2p-lane';
  /** Rows fetched before the fence ran. */
  candidates: number;
  /** Rows the fence kept — the population every count in this response describes. */
  counted: number;
  /** candidates - counted. */
  excluded: number;
  /** Stated so a reader can check the scope rather than infer it. */
  note: string;
}

/**
 * PURE: apply a lane macro to a census, reusing the CLAIM PATH's own filter
 * evaluator rather than re-implementing the match.
 *
 * The fence is built by `buildP2pLaneFence()` (the same FilterNode a claim spec
 * composes into `view.filter`) and evaluated by `matchesClaimSpecFilter` against
 * the same subject projection the scheduler uses. Nothing here knows what the
 * terms ARE — so adding, removing or re-wording a term in the fence module moves
 * this measurement with it, and there is no second copy to forget.
 */
export function applyLaneFence(
  items: readonly WorkItem[],
  lane: 'p2p-lane',
): { rows: WorkItem[]; report: BurnDownFenceReport } {
  const filter = buildP2pLaneFence();
  const rows = items.filter((item) => matchesClaimSpecFilter(claimSpecSubjectFromWorkItem(item), filter));
  return {
    rows,
    report: {
      lane,
      candidates: items.length,
      counted: rows.length,
      excluded: items.length - rows.length,
      note:
        `Census scoped to lane '${lane}' by the shared fence macro (buildP2pLaneFence), evaluated by the ` +
        'same matcher the claim path uses — every count below describes the fenced population, not the ' +
        'whole harness. cohortAudit (when present) is deliberately UNfenced.',
    },
  };
}

/** How the fleet behind `terminal.deltaBy.fleet` was determined. Reported verbatim so a
 *  reader never has to guess whether they are looking at their OWN fleet's output or a
 *  fleet named in the call — the ambiguity fix B exists to remove. */
export type FleetAttributionSource = 'arg' | 'caller-membership';

/** The attribution split of `terminal.delta`. The four counts PARTITION `delta`. */
export interface BurnDownDeltaBy {
  /** Closes by an EVER-member of the fleet in scope. `null` ⇒ no fleet was resolved
   *  (never 0, which would assert the fleet closed nothing). */
  fleet: number | null;
  /** Closes by a named agent that is not an ever-member of that fleet. With no fleet in
   *  scope this holds ALL agent closes in the harness. */
  otherAgents: number;
  /** Closes by automation (`system:*` / `watchdog-*` / the known bypass identities). */
  system: number;
  /** Closes with no `terminal_owner` recorded — deliberately NOT folded into `system`. */
  unattributed: number;
  basis: {
    fleet: string | null;
    fleetSource: FleetAttributionSource | null;
    membership: 'ever-members' | null;
    memberCount: number | null;
    note: string;
  };
}

// EI-18653071581558556 — derived from the canonical cross-family union rather
// than re-listed. This copy happened to be correct, but it was the third
// hand-maintained duplicate of the same set; placement-watchdog's copy had
// already drifted (missing `done`/`dropped`) and silently scored finished work
// as failed placements.
const TERMINAL_STATES = new Set(ANY_FAMILY_TERMINAL_STATES);
const PARKED_STATES = new Set(['blocked', 'needs-human', 'needs_human', 'cursed']);

type PresenceLike = { ownerId: string; heartbeatAt?: string | null; stale?: boolean | null };

export interface BurnDownRow {
  id: string;
  kind: string;
  family: string;
  harness: string | null;
  title: string;
  state: string;
  assignee: string | null;
  assigneeLive?: boolean;
  takenAt: string | null;
  lastProgressAt: string | null;
  updatedAt: string;
  severity: string | null;
  priority: number | null;
  /** Independent queue-control axes; omitted only when all four are absent. */
  queueControl?: BurnDownQueueControl;
}

export interface BurnDownQueueControl {
  activeClaim: { owner: string; claimedAt: string | null } | null;
  holdOpenLease: { holder: string; reason: string | null; heldAt: string | null; age: AuditAge } | null;
  durablePark: {
    parker: string | null;
    reason: string | null;
    parkedAt: string | null;
    age: AuditAge;
    unparkCondition: { status: UnparkConditionStatus; text: string | null };
    releaseLiveness: DurableParkReleaseLiveness;
  } | null;
  agentReview: ReturnType<typeof readAgentReviewState>;
  unattributedClaimHold: boolean;
}

export interface BurnDownParkedRow extends BurnDownRow {
  reason: string;
  mechanism: 'claimHold' | 'agent-review' | 'blocked' | 'needs-human' | 'external-blocker' | 'state';
  aliasedState?: string;
}

/** Lean itemized row for the `since`-bounded closed/opened lists — EI-8990. */
export interface BurnDownDeltaRow {
  id: string;
  kind: string;
  title: string;
  state: string;
  harness: string | null;
  ts: string;
}

/** Cap on itemized closedSince/openedSince rows (each list independently). */
const DELTA_ROW_CAP = 30;

export interface BurnDownResult {
  ok: true;
  harness: string;
  generatedAt: string;
  terminal: {
    total: number;
    done: number;
    passed: number;
    resolved: number;
    closed: number;
    deprecated: number;
    dropped: number;
    deltaSince: string | null;
    delta: number;
    /** EI-18820653360383242 — terminal rows carrying NO close stamp (closed before
     *  migration 698), excluded from `delta` because they cannot be placed in time.
     *  Nonzero means `delta` is a FLOOR, not a total: the window may also contain
     *  closes whose time is unknown. Reported so "nothing closed" and "this window
     *  predates the close stamp" are distinguishable — reading updatedAt instead is
     *  what once reported 3,833 ancient rows as closed within one hour. */
    deltaClosedUndated: number;
    /**
     * WI-37381 — `true` when the aggregate below was computed over a HARD-CAPPED fetch
     * (`censusLimit` rows) rather than the true full queue. This is the ONLY thing that
     * can make `terminal.*` an undercount: the caller-supplied `limit` arg never bounds
     * this fetch (see `censusLimit` — it is fixed at WORK_ITEMS_MAX_LIMIT regardless of
     * what the caller asked for), so a small `limit` can no longer silently zero out the
     * aggregate. A harness with more open+terminal rows than `censusLimit` can still hit
     * this flag; when it does, `terminal.*`/`counts.*`/`deltaBy.*` are a FLOOR, not a
     * total, and should be read as such (same shape as `deltaClosedUndated` above).
     */
    truncatedByLimit: boolean;
    /** The fetch size that produced this census (always WORK_ITEMS_MAX_LIMIT for a
     *  non-cohort call — see `truncatedByLimit`). Reported so "0 of 5" and "0 of 2000"
     *  are distinguishable without cross-referencing the request. */
    censusLimit: number;
    /** EI-19313376980892266 fix B — WHO produced `delta`. Present only with `since`.
     *  `delta` is harness-WIDE; without this split it reads as the caller's own fleet's
     *  output and over-reports by whatever the rest of the harness closed. */
    deltaBy?: BurnDownDeltaBy;
    /** Always true when `deltaBy` is present: its four counts sum to `delta` exactly.
     *  Stated on the wire so a reader need not test the invariant themselves. */
    deltaByPartitions?: boolean;
    /**
     * agent-protocol-authority-semantics-2026-07-26 P-004 — the terminal rows split by
     * COMPLETION AUTHORITY, which is the axis that answers "how much of this actually
     * counts as done?". `total` above counts LIFECYCLE terminality only: an item that
     * left the queue. That is the number this tool has always reported, and it is exactly
     * the number P-002 showed to be misleading — 65.6% of 14,663 terminal rows carried no
     * verification evidence and every one of them read as done here.
     *
     * `counted` is the honest burn-down: `committed` + `validated` + `legacy`
     * (see countsTowardBurnDown). `proposed` is the gap — closes recorded without
     * sufficient evidence, which are OUT of the claimable pool and owned by their closer
     * (D-007) but must not be reported as finished work.
     *
     * `legacy` is broken out rather than folded into `counted` silently because it is the
     * one bucket that counts WITHOUT a judgement: pre-contract closes, deliberately never
     * backfilled (D-005/D-008). Reporting it separately lets a leader see the contract
     * boundary shrink over time instead of inferring it.
     */
    authority: {
      counted: number;
      committed: number;
      validated: number;
      proposed: number;
      pendingHuman: number;
      invalid: number;
      legacy: number;
    };
  };
  inFlight: BurnDownRow[];
  parked: BurnDownParkedRow[];
  unclaimed: BurnDownRow[];
  counts: {
    total: number;
    terminal: number;
    inFlight: number;
    parked: number;
    unclaimed: number;
  };
  /** EI-8990: itemized (not just counted) terminal transitions since `since` —
   *  omitted entirely when `since` is not passed. Capped at DELTA_ROW_CAP,
   *  newest first; `truncated` names the true total when capped. */
  closedSince?: { rows: BurnDownDeltaRow[]; total: number; truncated: boolean };
  /** EI-8990: work-items CREATED since `since` (any state) — the "opened" half
   *  of the burn-down delta a monitor loop otherwise has to re-derive by diffing
   *  two full work_items:list snapshots. Same capping as closedSince. */
  openedSince?: { rows: BurnDownDeltaRow[]; total: number; truncated: boolean };
  /** P-024: exact one-row-per-requested-ID completion-integrity audit. */
  cohortAudit?: CohortAuditResult;
  /** P-011 — present only when `fence` was passed. See {@link BurnDownFenceReport}. */
  fence?: BurnDownFenceReport;
  /** P-003 (drain-admission-integrity-remediation-2026-08-13) — exact
   *  canonical bug flow for the CALLER's active DRAIN window. Present only on
   *  a `since`-bounded read by a caller that currently holds DRAIN mode. */
  drainFlow?: DrainFlowReport;
  /** P-004: canonical stock and raw report flow are different units. This
   * exact ledger census is never derived from the capped work-item fetch. */
  issueOccurrences?: IssueOccurrenceCounts;
  /** P-003 (fleet-spec-scoped-metrics-2026-08-21) — canonical, spec-scoped
   * fleet-lifetime snapshot. Present only with window:'fleet-lifetime'. */
  fleetMetrics?: FleetMetricsResult;
  /** Additive identity for every aggregate count in this response. The shared
   * contract is carried once; materialize a metric before comparing it. */
  countEvidence?: BurnDownCountEvidence;
}

export type CohortBucket = 'terminal' | 'parked' | 'in-flight' | 'unclaimed' | 'missing';
export type CohortEvidenceVerdict = 'verified' | 'incomplete' | 'missing' | 'not-applicable';

export interface CohortAuditRow {
  id: string;
  title: string | null;
  state: string | null;
  bucket: CohortBucket;
  /** Exact terminal lifecycle token (done/resolved/closed/…), null while open/missing. */
  closureKind: string | null;
  evidenceVerdict: CohortEvidenceVerdict;
  completionRef: string | null;
  terminalOwner: string | null;
  reopenRecommended: boolean;
  recommendation: string | null;
}

export interface CohortAuditResult {
  requested: number;
  found: number;
  missing: number;
  reopenRecommended: number;
  rows: CohortAuditRow[];
  /** Added by the payload-tier shaper when a fixed cohort is too large to inline. */
  truncated?: boolean;
}

export interface BurnDownCohortCutoff {
  field: 'createdAt';
  operator: '<' | '<=';
  value: string;
}

export type BurnDownPopulationState =
  | {
      kind: 'fixed-cohort';
      fixedCohortComplete: boolean;
      liveOpenPopulationEmpty: null;
      missingIds: number;
      note: string;
    }
  | {
      kind: 'live-census';
      fixedCohortComplete: null;
      liveOpenPopulationEmpty: boolean;
      missingIds: null;
      note: string;
    };

export interface BurnDownCountEvidence extends CountEvidenceBundle {
  populationState: BurnDownPopulationState;
}

export function buildCohortAudit(requestedIds: readonly string[], items: readonly WorkItem[]): CohortAuditResult {
  const byId = new Map(items.map((item) => [item.id, item]));
  const rows = requestedIds.map((id): CohortAuditRow => {
    const item = byId.get(id);
    if (!item) {
      return {
        id,
        title: null,
        state: null,
        bucket: 'missing',
        closureKind: null,
        evidenceVerdict: 'not-applicable',
        completionRef: null,
        terminalOwner: null,
        reopenRecommended: false,
        recommendation: 'investigate missing fixed-cohort id',
      };
    }
    const terminal = TERMINAL_STATES.has(item.state);
    const parked = hasClaimHold(item) || PARKED_STATES.has(item.state);
    const bucket: CohortBucket = terminal
      ? 'terminal'
      : parked
        ? 'parked'
        : item.assignee
          ? 'in-flight'
          : 'unclaimed';
    let evidenceVerdict: CohortEvidenceVerdict = 'not-applicable';
    let recommendation: string | null = null;
    let reopenRecommended = false;
    if (terminal) {
      const evidence = item.terminalCompletionEvidence;
      const hasEvidence = evidence != null && Object.keys(evidence).length > 0;
      const hasVerification = Boolean(
        evidence?.verifiedHow && (evidence.testsRun || evidence.testResult),
      );
      // P-004 deleted work_items:complete's synthetic terminalCompletionRef: the
      // completion-authority judgement is now the canonical signal for a live close.
      // Legacy (null-authority) rows still need their old completion ref, while a
      // committed/validated close must not be reported as missing merely because it
      // correctly used the new authority path.
      const missingLegacyCompletionRef =
        item.completionAuthority === null && !item.terminalCompletionRef;
      evidenceVerdict = !hasEvidence || missingLegacyCompletionRef
        ? 'missing'
        : hasVerification && countsTowardBurnDown(item.completionAuthority, true)
          ? 'verified'
          : 'incomplete';
      reopenRecommended = evidenceVerdict !== 'verified';
      recommendation = reopenRecommended
        ? 'reopen and require structured verification evidence before counting terminal'
        : null;
    }
    return {
      id,
      title: item.title,
      state: item.state,
      bucket,
      closureKind: terminal ? item.state : null,
      evidenceVerdict,
      completionRef: item.terminalCompletionRef,
      terminalOwner: item.terminalOwner,
      reopenRecommended,
      recommendation,
    };
  });
  return {
    requested: requestedIds.length,
    found: rows.filter((row) => row.bucket !== 'missing').length,
    missing: rows.filter((row) => row.bucket === 'missing').length,
    reopenRecommended: rows.filter((row) => row.reopenRecommended).length,
    rows,
  };
}

function fixedCohortFingerprint(ids: readonly string[]): string {
  return `sha256:${createHash('sha256').update(JSON.stringify([...new Set(ids)].sort())).digest('hex')}`;
}

/** Build the compact count contract after the same result snapshot is complete. */
export function buildBurnDownCountEvidence(
  result: BurnDownResult,
  args: {
    requestedIds: readonly string[] | null;
    kind?: string;
    includeChildren?: boolean;
    fence?: 'p2p-lane';
    cohortCutoff?: BurnDownCohortCutoff;
    fleet?: string;
    window?: 'fleet-lifetime';
  },
): BurnDownCountEvidence {
  const requestedIds = args.requestedIds;
  const fixedFingerprint = requestedIds ? fixedCohortFingerprint(requestedIds) : null;
  const populationSelector: Record<string, CountContractDimension> = requestedIds
    ? {
        mode: 'fixed-ids',
        fingerprint: fixedFingerprint!,
        requested: requestedIds.length,
        fence: args.fence ?? null,
      }
    : {
        mode: 'current-harness-census',
        harness: result.harness,
        kind: args.kind ?? 'all-work-item-kinds',
        includeChildren: args.includeChildren === true,
        fence: args.fence ?? null,
        fleet: args.fleet ?? null,
        window: args.window ?? null,
      };
  const cutoff: CountCutoff = args.cohortCutoff
    ? {
        kind: 'predicate',
        field: args.cohortCutoff.field,
        operator: args.cohortCutoff.operator,
        value: args.cohortCutoff.value,
      }
    : { kind: 'none' };
  const exactness: CountExactness = result.terminal.truncatedByLimit
    ? {
        status: 'bounded',
        bound: 'lower',
        limit: result.terminal.censusLimit,
        reason: 'the source census hit its hard row cap before every matching work item was read',
      }
    : { status: 'exact' };
  const nonTerminal = result.counts.inFlight + result.counts.parked + result.counts.unclaimed;
  const fixedComplete = requestedIds
    ? result.cohortAudit?.missing === 0 && nonTerminal === 0
    : null;
  const populationState: BurnDownPopulationState = requestedIds
    ? {
        kind: 'fixed-cohort',
        fixedCohortComplete: fixedComplete === true,
        liveOpenPopulationEmpty: null,
        missingIds: result.cohortAudit?.missing ?? requestedIds.length - result.counts.total,
        note:
          'Completion describes only the exact fixed-ID cohort. It is never evidence that the current live queue is empty.',
      }
    : {
        kind: 'live-census',
        fixedCohortComplete: null,
        liveOpenPopulationEmpty: nonTerminal === 0,
        missingIds: null,
        note:
          'Emptiness describes the current live census only. It is never evidence that a separately defined historical cohort completed.',
      };

  const metric = (
    value: number,
    id: string,
    definition: string,
    statusId: string,
    statusDefinition: string,
    zeroMeaning: string,
  ): CountEvidenceMetric => ({
    value,
    metric: { id, definition },
    status: { id: statusId, definition: statusDefinition },
    exactness,
    zeroMeaning,
  });

  return {
    contract: {
      schemaVersion: COUNT_EVIDENCE_SCHEMA_VERSION,
      population: {
        id: requestedIds ? 'fixed-work-item-id-cohort' : 'current-harness-work-item-census',
        selector: populationSelector,
        definition: requestedIds
          ? 'the exact deduplicated work-item ids supplied by the caller'
          : 'the current unified work-item rows selected for this harness/kind/fence census',
      },
      cutoff,
      writer: {
        id: requestedIds ? 'work_items:get+buildBurnDownResult' : 'work_items:list+buildBurnDownResult',
        revision: 'burn-down-count-contract-v1',
      },
      unit: { id: 'canonical-work-item', definition: 'distinct unified work-item ids' },
      scope: {
        harness: result.harness,
        populationMode: requestedIds ? 'fixed-cohort' : 'live-census',
        requestedIds: requestedIds?.length ?? null,
        fixedCohortFingerprint: fixedFingerprint,
        kind: args.kind ?? null,
        includeChildren: args.includeChildren === true,
        fence: args.fence ?? null,
      },
      measuredAt: result.generatedAt,
      comparisonRule: COUNT_EVIDENCE_COMPARISON_RULE,
    },
    metrics: {
      total: metric(
        result.counts.total,
        'census-total',
        'all resolved rows in the selected population',
        'resolved-row',
        'a selected work-item id resolved to a current row',
        requestedIds
          ? 'none of the requested fixed-cohort ids resolved; this does not mean the live queue is empty'
          : 'the current census resolved no rows; this does not certify a separate batch as complete',
      ),
      terminal: metric(
        result.counts.terminal,
        'terminal-count',
        'selected rows in a lifecycle-terminal state',
        'lifecycle-terminal',
        'state belongs to the canonical cross-family terminal-state set',
        'no selected rows are lifecycle-terminal',
      ),
      nonTerminal: metric(
        nonTerminal,
        'nonterminal-count',
        'selected rows not in a lifecycle-terminal state',
        'lifecycle-nonterminal',
        'row is currently in flight, parked, or unclaimed',
        requestedIds
          ? 'all found fixed-cohort rows are terminal; fixed-cohort completion additionally requires missingIds=0'
          : 'the current live census has no nonterminal rows; this does not describe a fixed historical cohort',
      ),
      inFlight: metric(
        result.counts.inFlight,
        'in-flight-count',
        'selected nonterminal rows assigned to an owner and not classified as parked',
        'in-flight',
        'nonterminal assigned row outside the parked precedence bucket',
        'no selected rows are currently in flight',
      ),
      parked: metric(
        result.counts.parked,
        'parked-count',
        'selected nonterminal rows held by a park/blocked/needs-human mechanism',
        'parked',
        'nonterminal row matched the burn-down parked precedence bucket',
        'no selected rows are parked',
      ),
      unclaimed: metric(
        result.counts.unclaimed,
        'unclaimed-count',
        'selected nonterminal rows with no current assignee after higher-precedence buckets',
        'unclaimed',
        'nonterminal row has no assignee and was not classified as parked',
        'no selected rows are unclaimed',
      ),
    },
    populationState,
  };
}

function hasClaimHold(item: WorkItem): boolean {
  const payload = item.payload;
  return Boolean(
    payload &&
      typeof payload === 'object' &&
      (payload as Record<string, unknown>)._claimHold === true,
  );
}

/**
 * EI-18672701535825889: a claim-hold row has TWO mutually-invisible provenance
 * conventions (held_open_* lease vs claim_hold_* durable park — see
 * readWorkItemClaimHoldProvenance). Reporting the raw `payload._claimHold` marker
 * with no holder/reason is exactly what sent a leader auditing this census down the
 * wrong path (84 policy-gated holds read as "(no holder), (no reason)" stale
 * corruption, one force-cleared off a security gate before the mistake was caught).
 * Surface whichever convention(s) actually attributed the hold; only a row with
 * NEITHER is a genuine unattributed-hold triage candidate.
 */
function claimHoldReason(item: WorkItem): string {
  const { heldOpen, parked, attributed } = readWorkItemClaimHoldProvenance(item.payload);
  if (!attributed) {
    return 'excluded from self-select by payload._claimHold — UNATTRIBUTED (no held_open_by / claim_hold_by on the row)';
  }
  const parts: string[] = [];
  if (heldOpen) {
    parts.push(`held open by ${heldOpen.by}${heldOpen.reason ? `: ${heldOpen.reason}` : ''}`);
  }
  if (parked) {
    parts.push(`durably parked by ${parked.by}${parked.reason ? `: ${parked.reason}` : ''}`);
  }
  return parts.join('; ');
}

function hasNeedsHuman(item: WorkItem): boolean {
  const payload = item.payload;
  return Boolean(
    payload &&
      typeof payload === 'object' &&
      !Array.isArray(payload) &&
      (payload as Record<string, unknown>).needsHuman === true,
  );
}

function hasActiveExternalBlocker(item: WorkItem): boolean {
  if (item.externalBlockers?.some((blocker) => blocker.status === 'active')) return true;
  const payload = item.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const blockers = (payload as Record<string, unknown>).externalBlockers;
  return (
    Array.isArray(blockers) &&
    blockers.some(
      (blocker) =>
        blocker &&
        typeof blocker === 'object' &&
        !Array.isArray(blocker) &&
        (blocker as Record<string, unknown>).status === 'active',
    )
  );
}

function queueControlFor(item: WorkItem, nowMs: number): BurnDownQueueControl | undefined {
  const payload = item.payload && typeof item.payload === 'object' && !Array.isArray(item.payload)
    ? item.payload as Record<string, unknown>
    : {};
  const { heldOpen, parked, attributed } = readWorkItemClaimHoldProvenance(payload);
  const rawClaimHold = hasClaimHold(item);
  const review = readAgentReviewState(payload);
  const control: BurnDownQueueControl = {
    activeClaim: item.assignee ? { owner: item.assignee, claimedAt: item.takenAt } : null,
    holdOpenLease: heldOpen ? {
      holder: heldOpen.by,
      reason: heldOpen.reason,
      heldAt: heldOpen.at,
      age: classifyAuditAge(heldOpen.at, nowMs),
    } : null,
    durablePark: rawClaimHold && !heldOpen && !parked ? {
      parker: null,
      reason: null,
      parkedAt: null,
      age: classifyAuditAge(null, nowMs),
      unparkCondition: classifyUnparkCondition(null),
      releaseLiveness: classifyDurableParkReleaseLiveness(payload, null),
    } : parked ? {
      parker: parked.by,
      reason: parked.reason,
      parkedAt: parked.at,
      age: classifyAuditAge(parked.at, nowMs),
      unparkCondition: classifyUnparkCondition(parked.reason),
      releaseLiveness: classifyDurableParkReleaseLiveness(payload, parked.reason),
    } : null,
    agentReview: review,
    unattributedClaimHold: rawClaimHold && !attributed,
  };
  return control.activeClaim || control.holdOpenLease || control.durablePark || control.agentReview
    ? control
    : undefined;
}

function toRow(item: WorkItem, assigneeLive: boolean | undefined, nowMs: number): BurnDownRow {
  const queueControl = queueControlFor(item, nowMs);
  return {
    id: item.id,
    kind: item.kind,
    family: item.family,
    harness: item.harness,
    title: item.title,
    state: item.state,
    assignee: item.assignee,
    ...(item.assignee ? { assigneeLive: Boolean(assigneeLive) } : {}),
    takenAt: item.takenAt,
    lastProgressAt: item.lastProgressAt,
    updatedAt: item.updatedAt,
    severity: item.severity,
    priority: item.priority,
    ...(queueControl ? { queueControl } : {}),
  };
}

export function liveOwnersFromPresence(
  presence: PresenceLike[],
  nowMs = Date.now(),
): Set<string> {
  const live = new Set<string>();
  for (const row of presence) {
    if (row.stale === true) continue;
    const heartbeatMs = row.heartbeatAt ? Date.parse(row.heartbeatAt) : NaN;
    if (!Number.isFinite(heartbeatMs)) continue;
    if (nowMs - heartbeatMs <= PRESENCE_STALE_MS) live.add(row.ownerId);
  }
  return live;
}

type FleetActorPartition = {
  fleet: number;
  otherAgents: number;
  system: number;
  unattributed: number;
  partitions: true;
  membershipBasis: 'ever-members';
};

function isObservationLane(item: WorkItem): boolean {
  const payload = item.payload;
  return Boolean(
    payload &&
    typeof payload === 'object' &&
    !Array.isArray(payload) &&
    (payload as Record<string, unknown>).lane === 'observation',
  );
}

function partitionActors(
  items: readonly WorkItem[],
  actor: (item: WorkItem) => string | null,
  members: Set<string>,
): FleetActorPartition {
  const out: FleetActorPartition = {
    fleet: 0,
    otherAgents: 0,
    system: 0,
    unattributed: 0,
    partitions: true,
    membershipBasis: 'ever-members',
  };
  for (const item of items) {
    const owner = actor(item);
    const classification = classifyTerminalOwner(owner);
    if (classification === 'unattributed') out.unattributed += 1;
    else if (classification === 'system') out.system += 1;
    else if (owner && members.has(owner)) out.fleet += 1;
    else out.otherAgents += 1;
  }
  return out;
}

function authorityPartition(items: readonly WorkItem[]) {
  const authority = {
    lifecycleTerminal: items.length,
    counted: 0,
    committed: 0,
    validated: 0,
    proposed: 0,
    pendingHuman: 0,
    invalid: 0,
    legacy: 0,
    partitionsLifecycleTerminal: true as const,
    countedRule: 'committed + validated + legacy' as const,
  };
  for (const item of items) {
    const value = item.completionAuthority;
    if (countsTowardBurnDown(value, true)) authority.counted += 1;
    if (value === null) authority.legacy += 1;
    else if (value === 'pending_human') authority.pendingHuman += 1;
    else authority[value] += 1;
  }
  return authority;
}

function fleetMetricsUnavailable(args: {
  fleet: string;
  harness: string;
  flowMode: FleetMetricFlowMode;
  reason: string;
  recoverVia: string;
}): Extract<FleetMetricsResult, { ok: false }> {
  const parsed = parseFleetMetricsResult({
    ok: false,
    schemaVersion: FLEET_METRICS_SCHEMA_VERSION,
    error: 'fleet_metrics_unavailable',
    reason: args.reason,
    recoverVia: args.recoverVia,
    requested: {
      fleet: args.fleet,
      harness: args.harness,
      flowMode: args.flowMode,
      window: 'fleet-lifetime',
    },
  });
  if (parsed.ok) throw new Error('fleet-metrics unavailable envelope parsed as a snapshot');
  return parsed;
}

/** Build the canonical snapshot after the shared resolver has fixed the fleet/spec/window. */
export async function buildFleetMetricsResult(
  resolution: FleetMetricScopeResolution,
  items: readonly WorkItem[],
  opts: {
    issueOccurrences: IssueOccurrenceCounts | PromiseLike<IssueOccurrenceCounts>;
    sourceCapExhausted: boolean;
    assignee?: string;
    explainFloors?: typeof explainIssueClaimFloors;
  },
): Promise<FleetMetricsResult> {
  if (!resolution.ok) return parseFleetMetricsResult(resolution);

  const currentMatched = selectFleetMetricCurrentItems(resolution, items);
  const observations = currentMatched.filter(isObservationLane);
  const currentCanonical = currentMatched.filter((item) => item.family === 'issue' && !isObservationLane(item));
  const windowStart = Date.parse(resolution.scope.window.startAt);
  const windowEnd = Date.parse(resolution.scope.window.endAt);
  const inWindow = (value: string | null): value is string => {
    if (!value) return false;
    const time = Date.parse(value);
    return Number.isFinite(time) && time >= windowStart && time < windowEnd;
  };
  const flowCandidates = items.filter((item) => item.family === 'issue' && !isObservationLane(item));
  const openedSelection = selectFleetMetricFlowEvents(
    resolution,
    flowCandidates
      .filter((item) => inWindow(item.createdAt))
      .map((item) => ({ item, at: item.createdAt, value: item.createdBy })),
  );
  if (!openedSelection.ok) return parseFleetMetricsResult(openedSelection);
  const terminalSelection = selectFleetMetricFlowEvents(
    resolution,
    flowCandidates
      .filter((item) => TERMINAL_STATES.has(item.state) && inWindow(item.closedAt))
      .map((item) => ({ item, at: item.closedAt!, value: item.terminalOwner })),
  );
  if (!terminalSelection.ok) return parseFleetMetricsResult(terminalSelection);

  const openedItems = openedSelection.events.map((event) => event.item);
  const terminalItems = terminalSelection.events.map((event) => event.item);
  const remainingItems = currentCanonical.filter((item) => !TERMINAL_STATES.has(item.state));
  const explainFloors = opts.explainFloors ?? explainIssueClaimFloors;
  // The occurrence census and claim-floor explanation are independent reads. Keep
  // the caller's occurrence promise deferred until this point so the two expensive
  // legs overlap instead of consuming the metric budget back-to-back.
  const [floorRows, issueOccurrences] = await Promise.all([
    explainFloors(
      resolution.scope.harness,
      remainingItems.map((item) => item.id),
      { assignee: opts.assignee },
    ),
    Promise.resolve(opts.issueOccurrences),
  ]);
  const floorById = new Map(floorRows.map((row: ClaimFloorAttribution) => [row.id, row]));
  const buckets = {
    needsHuman: 0,
    blocked: 0,
    claimHeld: 0,
    inFlight: 0,
    claimable: 0,
    otherUnclaimable: 0,
  };
  for (const item of remainingItems) {
    const floor = floorById.get(item.id);
    if (
      hasNeedsHuman(item) ||
      item.state === 'needs-human' ||
      item.state === 'needs_human' ||
      floor?.refusedBy === 'needs-owner-action'
    ) {
      buckets.needsHuman += 1;
    } else if (
      item.state === 'blocked' ||
      hasActiveExternalBlocker(item) ||
      floor?.refusedBy === 'blocked-dep' ||
      floor?.refusedBy === 'external-blocker'
    ) {
      buckets.blocked += 1;
    } else if (hasClaimHold(item) || floor?.refusedBy === 'claim-hold') {
      buckets.claimHeld += 1;
    } else if (item.assignee) {
      buckets.inFlight += 1;
    } else if (floor?.admissible === true) {
      buckets.claimable += 1;
    } else {
      buckets.otherUnclaimable += 1;
    }
  }

  const members = new Set(resolution.everMemberIds);
  const authority = authorityPartition(terminalItems);
  const priorExactness = resolution.quality.exactness;
  const quality = {
    ...resolution.quality,
    exactness: opts.sourceCapExhausted
      ? {
          status: 'truncated' as const,
          sourceCap: WORK_ITEMS_MAX_LIMIT,
          fetched: items.length,
          reason:
            `work-item source hit the ${WORK_ITEMS_MAX_LIMIT}-row cap before fleet-spec filtering` +
            (priorExactness.status === 'truncated' ? `; ${priorExactness.reason}` : ''),
          recoverVia:
            priorExactness.status === 'truncated'
              ? `narrow the work-item source reads; ${priorExactness.recoverVia}`
              : 'narrow the work-item source into complete, non-overlapping reads',
        }
      : priorExactness,
  };

  return parseFleetMetricsResult({
    ok: true,
    snapshot: {
      schemaVersion: FLEET_METRICS_SCHEMA_VERSION,
      generatedAt: resolution.generatedAt,
      scope: resolution.scope,
      quality,
      flow: {
        opened: openedItems.length,
        terminalLifecycle: terminalItems.length,
        terminalCounted: authority.counted,
        netLifecycle: openedItems.length - terminalItems.length,
        netCounted: openedItems.length - authority.counted,
        unit: FLEET_METRIC_UNITS.workItems,
        openedBy: partitionActors(openedItems, (item) => item.createdBy, members),
        terminalBy: partitionActors(terminalItems, (item) => item.terminalOwner, members),
      },
      remaining: {
        total: remainingItems.length,
        unit: FLEET_METRIC_UNITS.workItems,
        buckets,
        mutuallyExclusive: true,
        precedence: [...FLEET_METRIC_REMAINING_PRECEDENCE],
      },
      authority,
      issueUnits: {
        canonicalBugs: currentCanonical.filter((item) => item.kind === 'bug').length,
        observations: observations.length,
        occurrences: issueOccurrences.rawOccurrences,
        duplicateOccurrences: issueOccurrences.duplicateOccurrences,
        separateUnits: true,
        units: {
          canonicalBugs: FLEET_METRIC_UNITS.canonicalBugs,
          observations: FLEET_METRIC_UNITS.observations,
          occurrences: FLEET_METRIC_UNITS.occurrences,
          duplicateOccurrences: FLEET_METRIC_UNITS.duplicateOccurrences,
        },
        writers: {
          canonicalBugs: FLEET_METRIC_WRITERS.workItems,
          observations: FLEET_METRIC_WRITERS.workItems,
          occurrences: FLEET_METRIC_WRITERS.occurrences,
        },
      },
      populationLifecycle: resolution.populationLifecycle,
      admissionParity: FLEET_METRIC_ADMISSION_PARITY,
    },
  });
}

export function buildBurnDownResult(
  items: WorkItem[],
  liveOwners: Set<string>,
  opts: {
    harness: string;
    generatedAt?: string;
    since?: string | null;
    /** EI-19313376980892266 fix B: the fleet whose closes count as `deltaBy.fleet`, and
     *  its EVER-members (fleet-membership-store `fleetEverMembers` — never live presence).
     *  Null/absent ⇒ no fleet in scope; `deltaBy.fleet` is then reported as null rather
     *  than 0, because "this fleet closed nothing" and "no fleet was resolved" are
     *  different facts and 0 asserts the first one. */
    fleet?: { slug: string; members: Set<string>; source: FleetAttributionSource } | null;
    /**
     * WI-37381 — the fetch size `items` was drawn from (always WORK_ITEMS_MAX_LIMIT for
     * a real census; irrelevant/absent for a fixed `ids` cohort). Recorded verbatim as
     * `terminal.censusLimit`/`truncatedByLimit` — never re-derived from `items.length`
     * alone, since a queue that happens to contain exactly that many rows is
     * indistinguishable from one the fetch actually capped.
     */
    censusLimit?: number;
    /**
     * WI-37381 — bounds the RETURNED `inFlight`/`parked`/`unclaimed` row arrays only.
     * `terminal.*`/`counts.*` are always computed from the full `items` array regardless
     * of this value — that decoupling is the fix: a caller asking for a short row list
     * must never zero out the aggregate census.
     */
    rowLimit?: number;
    /** Captured on the raw source before a fence/spec filter can shrink it. */
    sourceCapExhausted?: boolean;
  },
): BurnDownResult {
  const generatedAt = opts.generatedAt ?? new Date().toISOString();
  const generatedAtMs = Number.isFinite(Date.parse(generatedAt)) ? Date.parse(generatedAt) : Date.now();
  const fleetMembers = opts.fleet?.members ?? null;
  const deltaBy = { fleet: 0, otherAgents: 0, system: 0, unattributed: 0 };
  const sinceMs = opts.since ? Date.parse(opts.since) : NaN;
  const hasSince = Number.isFinite(sinceMs);
  // WI-37381: `censusLimit` is the fetch size `items` was drawn from — NOT re-derived
  // from `items.length`, because a queue that happens to hold exactly that many rows
  // is indistinguishable from one the fetch capped. No `censusLimit` passed (the fixed
  // `ids`-cohort path) means the fetch was exact, never truncated.
  const censusLimit = opts.censusLimit ?? items.length;
  const truncatedByLimit = opts.sourceCapExhausted ?? (opts.censusLimit != null && items.length >= opts.censusLimit);
  const terminal = {
    total: 0,
    done: 0,
    passed: 0,
    resolved: 0,
    closed: 0,
    deprecated: 0,
    dropped: 0,
    deltaSince: opts.since ?? null,
    delta: 0,
    /** EI-18820653360383242 — terminal rows with NO close stamp (closed before
     *  migration 698). They CANNOT be placed in time, so they are excluded from
     *  `delta` rather than guessed at from updatedAt. Reported so a reader can
     *  tell "nothing closed in this window" apart from "this window predates the
     *  close stamp"; a nonzero value here means `delta` is a floor, not a total. */
    deltaClosedUndated: 0,
    /** WI-37381: see BurnDownResult.terminal.truncatedByLimit / censusLimit docs. */
    truncatedByLimit,
    censusLimit,
    /** EI-19313376980892266 fix B: who produced `delta`. Only present with `since`. */
    deltaBy: undefined as BurnDownDeltaBy | undefined,
    /** True whenever `deltaBy` is present: its four counts sum to `delta` exactly. */
    deltaByPartitions: undefined as boolean | undefined,
    authority: { counted: 0, committed: 0, validated: 0, proposed: 0, pendingHuman: 0, invalid: 0, legacy: 0 },
  };
  const inFlight: BurnDownRow[] = [];
  const parked: BurnDownParkedRow[] = [];
  const unclaimed: BurnDownRow[] = [];
  // EI-8990: itemized since-bounded deltas — only populated (and only cost
  // anything) when `since` is passed. Sorted newest-first before capping so a
  // truncated list still shows the most-recent transitions, not an arbitrary
  // prefix of listWorkItems's own ordering.
  const closedRows: BurnDownDeltaRow[] = [];
  const openedRows: BurnDownDeltaRow[] = [];
  let deltaClosedUndated = 0;

  for (const item of items) {
    const row = toRow(item, item.assignee ? liveOwners.has(item.assignee) : undefined, generatedAtMs);
    const state = item.state;
    if (hasSince && Date.parse(item.createdAt) > sinceMs) {
      openedRows.push({ id: item.id, kind: item.kind, title: item.title, state, harness: item.harness, ts: item.createdAt });
    }
    if (TERMINAL_STATES.has(state)) {
      terminal.total += 1;
      if (state in terminal && typeof terminal[state as keyof typeof terminal] === 'number') {
        (terminal[state as 'done' | 'passed' | 'resolved' | 'closed' | 'deprecated' | 'dropped']) += 1;
      }
      // P-004: the authority split. `countsTowardBurnDown` is the SINGLE definition of
      // what counts (it is also what treats a null authority on a terminal row as a
      // legacy close) — this must never re-derive that rule inline, or the census and the
      // contract can disagree about the same row.
      const auth = item.completionAuthority;
      if (countsTowardBurnDown(auth, true)) terminal.authority.counted += 1;
      if (auth === null) terminal.authority.legacy += 1;
      else if (auth === 'pending_human') terminal.authority.pendingHuman += 1;
      else terminal.authority[auth] += 1;
      // EI-18820653360383242: `closedAt`, NOT `updatedAt`. updatedAt moves on ANY
      // write, so a single bulk write reports every row it touched as just-closed:
      // this exact line once returned 3,833 items "closed in one hour", all with
      // terminal_owner NULL — the signature of a fleet-scale mass unattributed
      // close — when it was a backfill touching rows closed weeks earlier (oldest
      // 2026-06-04). A real mass-close and that artefact are INDISTINGUISHABLE from
      // updatedAt, which is why this must read the dedicated close stamp.
      //
      // A NULL closedAt is deliberately EXCLUDED rather than falling back to
      // updatedAt: null means "closed before migration 698, time unknown", and
      // coalescing it would silently reintroduce the same phantom. The cost is
      // that historical windows under-report until pre-698 rows age out, which is
      // the honest direction to be wrong in — and `deltaClosedUndated` below makes
      // that omission visible instead of leaving it to be discovered.
      const closedAtMs = item.closedAt ? Date.parse(item.closedAt) : NaN;
      if (hasSince && Number.isFinite(closedAtMs) && closedAtMs > sinceMs) {
        terminal.delta += 1;
        // EI-19313376980892266 fix B: attribute the delta as we count it, so the
        // partition can never disagree with the total it partitions.
        const cls = classifyTerminalOwner(item.terminalOwner);
        if (cls === 'unattributed') deltaBy.unattributed += 1;
        else if (cls === 'system') deltaBy.system += 1;
        else if (fleetMembers && fleetMembers.has(item.terminalOwner!)) deltaBy.fleet += 1;
        else deltaBy.otherAgents += 1;
        closedRows.push({ id: item.id, kind: item.kind, title: item.title, state, harness: item.harness, ts: item.closedAt! });
      } else if (hasSince && !item.closedAt) {
        deltaClosedUndated += 1;
      }
      continue;
    }

    if (hasClaimHold(item)) {
      parked.push({
        ...row,
        reason: claimHoldReason(item),
        mechanism: 'claimHold',
        aliasedState: state,
      });
      continue;
    }

    if (row.queueControl?.agentReview && row.queueControl.agentReview.status !== 'approved') {
      parked.push({
        ...row,
        reason: `awaiting agent review by ${row.queueControl.agentReview.submittedBy}`,
        mechanism: 'agent-review',
      });
      continue;
    }

    // These are the same queue floors used by scheduler:get_next and
    // work_items:claim_next. They remain open/directly actionable, but are
    // parked rather than reported as unclaimed so leader census agrees with
    // scheduler admission (WI-4759).
    if (hasNeedsHuman(item)) {
      parked.push({
        ...row,
        reason: 'excluded from self-select by payload.needsHuman',
        mechanism: 'needs-human',
      });
      continue;
    }

    if (hasActiveExternalBlocker(item)) {
      parked.push({
        ...row,
        reason: 'excluded from self-select by active external blocker',
        mechanism: 'external-blocker',
      });
      continue;
    }

    if (PARKED_STATES.has(state)) {
      const mechanism = state === 'blocked' ? 'blocked' : state === 'needs-human' || state === 'needs_human' ? 'needs-human' : 'state';
      parked.push({
        ...row,
        reason: `parked by lifecycle state ${state}`,
        mechanism,
      });
      continue;
    }

    if (item.assignee) {
      inFlight.push(row);
      continue;
    }
    unclaimed.push(row);
  }

  const sortNewestFirst = (a: BurnDownDeltaRow, b: BurnDownDeltaRow) => Date.parse(b.ts) - Date.parse(a.ts);
  const capDelta = (rows: BurnDownDeltaRow[]) => {
    const sorted = [...rows].sort(sortNewestFirst);
    return { rows: sorted.slice(0, DELTA_ROW_CAP), total: sorted.length, truncated: sorted.length > DELTA_ROW_CAP };
  };

  terminal.deltaClosedUndated = deltaClosedUndated;
  if (hasSince) {
    // EI-19313376980892266 fix B — PROVENANCE ON A DERIVED NUMBER. `delta` is
    // harness-WIDE; read as one fleet's output it over-reports by however much the
    // rest of the harness closed (measured: 269 harness-wide vs 63 by the reporting
    // fleet — a leader told the owner ~30 closes/hour against a real ~6.6).
    //
    // The buckets PARTITION `delta`: every counted close lands in exactly one, so
    // fleet + otherAgents + system + unattributed === delta, always. (Contrast the
    // claim `excluded` buckets, which overlap by construction.) `deltaByPartitions`
    // states that invariant on the wire rather than leaving a reader to test it.
    terminal.deltaBy = {
      // null (not 0) when no fleet was in scope — 0 would assert the fleet closed
      // nothing, which is a different claim from "no fleet was resolved".
      fleet: opts.fleet ? deltaBy.fleet : null,
      otherAgents: deltaBy.otherAgents,
      system: deltaBy.system,
      unattributed: deltaBy.unattributed,
      basis: {
        fleet: opts.fleet?.slug ?? null,
        fleetSource: opts.fleet?.source ?? null,
        // Ever-members, NOT live presence: a window-scoped question must count members
        // that have since died. session-search-scope-2026-07-05 D-002; measured 55%
        // under-report from a live-presence basis (see fleetEverMembers' doc).
        membership: opts.fleet ? ('ever-members' as const) : null,
        memberCount: opts.fleet ? opts.fleet.members.size : null,
        note: opts.fleet
          ? `fleet = closes whose terminal_owner is an EVER-member of '${opts.fleet.slug}' ` +
            `(${opts.fleet.members.size} member(s), from the append-only membership ledger — ` +
            `includes members that have since died); otherAgents = every other named agent ` +
            `in this harness; system = automation (system:*/watchdog-*); unattributed = no ` +
            `terminal_owner recorded. The four sum to delta.`
          : `no fleet in scope, so 'fleet' is null rather than 0 — pass { fleet } or call as ` +
            `a fleet member to split this harness-wide delta. otherAgents currently holds ALL ` +
            `agent closes in the harness, not just other fleets'.`,
      },
    };
    terminal.deltaByPartitions = true;
  }

  // WI-37381: `counts.*` are always the FULL bucket sizes over `items` — never bounded
  // by `rowLimit`. Only the returned row arrays are capped, and only for display; a
  // caller wanting a short row list must never see that reflected in the aggregate.
  const capRows = <T,>(rows: T[]): T[] =>
    opts.rowLimit != null ? rows.slice(0, opts.rowLimit) : rows;

  return {
    ok: true,
    harness: opts.harness,
    generatedAt,
    terminal,
    inFlight: capRows(inFlight),
    parked: capRows(parked),
    unclaimed: capRows(unclaimed),
    counts: {
      total: items.length,
      terminal: terminal.total,
      inFlight: inFlight.length,
      parked: parked.length,
      unclaimed: unclaimed.length,
    },
    ...(hasSince ? { closedSince: capDelta(closedRows), openedSince: capDelta(openedRows) } : {}),
  };
}

const auditAgeSchema = z.object({
  status: z.enum(['known', 'missing', 'invalid']),
  ageMs: z.number().nullable(),
  bucket: z.enum(['under-1d', '1-7d', '7-30d', '30d-plus', 'unknown']),
});

const releaseLivenessSchema = z.object({
  status: z.enum(['tracked', 'unverified', 'unreachable', 'satisfied-still-parked']),
  contractPresent: z.boolean(),
  condition: z.string().nullable(),
  owner: z.string().nullable(),
  trigger: z.string().nullable(),
  reachability: z.enum(['reachable', 'blocked', 'unreachable', 'satisfied']).nullable(),
  evidence: z.string().nullable(),
  findings: z.array(z.enum([
    'condition-missing',
    'condition-ambiguous',
    'owner-missing',
    'trigger-missing',
    'reachability-unverified',
    'evidence-missing',
    'condition-unreachable',
    'condition-satisfied-still-parked',
  ])),
});

const queueControlSchema = z.object({
  activeClaim: z.object({ owner: z.string(), claimedAt: z.string().nullable() }).nullable(),
  holdOpenLease: z.object({
    holder: z.string(),
    reason: z.string().nullable(),
    heldAt: z.string().nullable(),
    age: auditAgeSchema,
  }).nullable(),
  durablePark: z.object({
    parker: z.string().nullable(),
    reason: z.string().nullable(),
    parkedAt: z.string().nullable(),
    age: auditAgeSchema,
    unparkCondition: z.object({
      status: z.enum(['stated', 'missing', 'unresolved']),
      text: z.string().nullable(),
    }),
    releaseLiveness: releaseLivenessSchema,
  }).nullable(),
  agentReview: z.object({
    status: z.enum(['pending', 'revision-requested', 'approved']),
    submittedBy: z.string(),
    ledgerIdeaId: z.string(),
    round: z.number().int().positive(),
  }).nullable(),
  unattributedClaimHold: z.boolean(),
});

const rowSchema = z.object({
  id: z.string(),
  kind: z.string(),
  family: z.string(),
  harness: z.string().nullable(),
  title: z.string(),
  state: z.string(),
  assignee: z.string().nullable(),
  assigneeLive: z.boolean().optional(),
  takenAt: z.string().nullable(),
  lastProgressAt: z.string().nullable(),
  updatedAt: z.string(),
  severity: z.string().nullable(),
  priority: z.number().nullable(),
  queueControl: queueControlSchema.optional(),
});

const drainFlowCountSchema = z.object({
  opened: z.number(),
  terminaled: z.number(),
  net: z.number(),
});

const drainFlowSchema = z.object({
  exact: z.literal(true),
  windowStart: z.string(),
  workspaceId: z.string(),
  harness: z.string(),
  ownerId: z.string(),
  totals: drainFlowCountSchema,
  bySeverity: z.object({
    critical: drainFlowCountSchema,
    major: drainFlowCountSchema,
    minor: drainFlowCountSchema,
    nit: drainFlowCountSchema,
  }),
  breaker: z.object({
    tripped: z.boolean(),
    blocksNewBugs: z.boolean(),
    rule: z.string(),
    reason: z.string(),
  }),
});

export default defineTool({
  name: 'work_items:burn_down',
  profile: 'engineer',
  description:
    "One-call leader census for a harness work queue. Additive `queueControl` fields distinguish active claims, liveness-bound hold-open leases, durable parks, and agent-review gates; durable parks include parker/reason/time/age plus UNPARK-condition and release-liveness status. Legacy buckets/mechanisms remain compatible.",
  guidance: {
    when:
      'You are leading a drain/fleet pass and need to know what is done, actively held by a live or dead assignee, intentionally parked, and still unclaimed.',
    notWhen:
      'You need full per-item bodies/checkpoints/comments — use work_items:get for the specific ids after this census.',
    chaining:
      'work_items:burn_down → work_items:get for detail on a row → coord:send or work_items:claim/release/set_state as needed.',
    seeAlso: [
      'work_items:list (raw row listing)',
      'fleet:assignments (full live agent work-list and stalled/orphaned claim analysis)',
      'coord:presence (raw live roster)',
    ],
  },
  capability: 'work_items:read',
  requirePrincipal: false,
  // EI-20226779878046151: this census uses explicit workspace/store access and
  // never reads ctx.tx. Avoid holding the orient caller's ambient transaction
  // across presence and queue diagnostics.
  skipWorkspaceTx: true,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    harness: z.string().min(1).max(80),
    kind: z
      .string()
      .min(1)
      .max(80)
      .optional()
      .describe('optional work-item kind filter'),
    since: z
      .string()
      .datetime()
      .optional()
      .describe('optional ISO timestamp; terminal.delta counts terminal items updated after it, and closedSince/openedSince are itemized around it'),
    includeChildren: z
      .boolean()
      .optional()
      .describe('include child/chunk rows in the census'),
    limit: z
      .number()
      .int()
      .positive()
      .max(2000)
      .optional()
      .describe(
        'WI-37381: bounds ONLY the returned inFlight/parked/unclaimed row arrays. ' +
          'terminal.*/counts.*/deltaBy.* are always computed over the full census ' +
          '(up to WORK_ITEMS_MAX_LIMIT) regardless of this value — a small limit can ' +
          'no longer zero out the aggregate. Ignored when `ids` is passed.',
      ),
    ids: z
      .array(z.string().min(1).max(120))
      .min(1)
      .max(200)
      .optional()
      .describe('Exact fixed-cohort IDs. Narrows the census and adds cohortAudit with one row per requested ID, including missing IDs.'),
    cohortCutoff: z
      .object({
        field: z.literal('createdAt'),
        operator: z.enum(['<', '<=']),
        value: z.string().datetime({ offset: true }),
      })
      .strict()
      .optional()
      .describe(
        'Optional historical creation-time boundary that DEFINED an exact `ids` cohort. It is provenance only—the IDs remain the measured set—and is emitted verbatim in countEvidence. Omit when no temporal cutoff defined the cohort; the contract then says cutoff.kind:none.',
      ),
    fleet: z
      .string()
      .min(1)
      .max(80)
      .optional()
      .describe(
        "Attribute terminal.delta to this fleet's EVER-members (terminal.deltaBy.fleet). Defaults to YOUR own fleet when you are in one; omit and pass no fleet to get an unattributed harness-wide delta.",
      ),
    fence: z
      .enum(['p2p-lane'])
      .optional()
      .describe(
        'Scope the WHOLE census to a lane macro before counting — the same fence a claim spec composes, so a drain fleet measures burn-down over exactly the lane it may claim from. Never hand-roll a title regex for this.',
      ),
    window: z
      .literal('fleet-lifetime')
      .optional()
      .describe("Build the canonical stored-spec fleet snapshot over the fleet's creation-to-snapshot window."),
    flowMode: z
      .enum(['current-spec', 'at-event-spec'])
      .optional()
      .describe('How opened/terminal flow is filtered; defaults to current-spec. Remaining stock is always current-spec.'),
  }).superRefine((args, ctx) => {
    if (args.window && !args.fleet) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['fleet'],
        message: "fleet is required with window:'fleet-lifetime'",
      });
    }
    if (args.flowMode && !args.window) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['window'],
        message: "window:'fleet-lifetime' is required with flowMode",
      });
    }
    if (args.cohortCutoff && !args.ids) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ids'],
        message: 'ids is required with cohortCutoff because the cutoff documents a fixed cohort rather than filtering the live census',
      });
    }
  }),
  result: z.object({
    ok: z.literal(true),
    harness: z.string(),
    generatedAt: z.string(),
    terminal: z.object({
      total: z.number(),
      done: z.number(),
      passed: z.number(),
      resolved: z.number(),
      closed: z.number(),
      deprecated: z.number(),
      dropped: z.number(),
      deltaSince: z.string().nullable(),
      delta: z.number(),
      deltaClosedUndated: z.number(),
      truncatedByLimit: z.boolean(),
      censusLimit: z.number(),
      deltaBy: z
        .object({
          fleet: z.number().nullable(),
          otherAgents: z.number(),
          system: z.number(),
          unattributed: z.number(),
          basis: z.object({
            fleet: z.string().nullable(),
            fleetSource: z.enum(['arg', 'caller-membership']).nullable(),
            membership: z.literal('ever-members').nullable(),
            memberCount: z.number().nullable(),
            note: z.string(),
          }),
        })
        .optional(),
      deltaByPartitions: z.boolean().optional(),
      authority: z.object({
        counted: z.number(),
        committed: z.number(),
        validated: z.number(),
        proposed: z.number(),
        pendingHuman: z.number(),
        invalid: z.number(),
        legacy: z.number(),
      }),
    }),
    inFlight: z.array(rowSchema),
    parked: z.array(rowSchema.extend({
      reason: z.string(),
      mechanism: z.enum(['claimHold', 'agent-review', 'blocked', 'needs-human', 'external-blocker', 'state']),
      aliasedState: z.string().optional(),
    })),
    unclaimed: z.array(rowSchema),
    counts: z.object({
      total: z.number(),
      terminal: z.number(),
      inFlight: z.number(),
      parked: z.number(),
      unclaimed: z.number(),
    }),
    presentation: z
      .object({
        tier: z.enum(['trimmed', 'standard']),
        rowCap: z.number(),
        note: z.string(),
        rows: z.object({
          inFlight: z.object({ shown: z.number(), total: z.number(), truncated: z.boolean() }),
          parked: z.object({ shown: z.number(), total: z.number(), truncated: z.boolean() }),
          unclaimed: z.object({ shown: z.number(), total: z.number(), truncated: z.boolean() }),
        }),
      })
      .optional(),
    closedSince: z
      .object({
        rows: z.array(
          z.object({
            id: z.string(),
            kind: z.string(),
            title: z.string(),
            state: z.string(),
            harness: z.string().nullable(),
            ts: z.string(),
          }),
        ),
        total: z.number(),
        truncated: z.boolean(),
      })
      .optional(),
    openedSince: z
      .object({
        rows: z.array(
          z.object({
            id: z.string(),
            kind: z.string(),
            title: z.string(),
            state: z.string(),
            harness: z.string().nullable(),
            ts: z.string(),
          }),
        ),
        total: z.number(),
        truncated: z.boolean(),
      })
      .optional(),
    fence: z
      .object({
        lane: z.literal('p2p-lane'),
        candidates: z.number(),
        counted: z.number(),
        excluded: z.number(),
        note: z.string(),
      })
      .optional(),
    drainFlow: drainFlowSchema.optional(),
    issueOccurrences: z
      .object({
        canonicalClusters: z.number(),
        rawOccurrences: z.number(),
        duplicateOccurrences: z.number(),
        units: z.object({
          canonicalClusters: z.literal('distinct canonical work-item ids with occurrences'),
          rawOccurrences: z.literal('append-only report rows'),
          duplicateOccurrences: z.literal('report rows not creating a canonical item'),
        }),
        writer: z.literal('harness_shared.work_item_occurrences'),
      })
      .optional(),
    fleetMetrics: fleetMetricsResultSchema.optional(),
    countEvidence: countEvidenceBundleSchema.extend({
      populationState: z.discriminatedUnion('kind', [
        z.object({
          kind: z.literal('fixed-cohort'),
          fixedCohortComplete: z.boolean(),
          liveOpenPopulationEmpty: z.null(),
          missingIds: z.number().int().nonnegative(),
          note: z.string(),
        }),
        z.object({
          kind: z.literal('live-census'),
          fixedCohortComplete: z.null(),
          liveOpenPopulationEmpty: z.boolean(),
          missingIds: z.null(),
          note: z.string(),
        }),
      ]),
    }).optional(),
    cohortAudit: z
      .object({
        requested: z.number(),
        found: z.number(),
        missing: z.number(),
        reopenRecommended: z.number(),
        rows: z.array(z.object({
          id: z.string(),
          title: z.string().nullable(),
          state: z.string().nullable(),
          bucket: z.enum(['terminal', 'parked', 'in-flight', 'unclaimed', 'missing']),
          closureKind: z.string().nullable(),
          evidenceVerdict: z.enum(['verified', 'incomplete', 'missing', 'not-applicable']),
          completionRef: z.string().nullable(),
          terminalOwner: z.string().nullable(),
          reopenRecommended: z.boolean(),
          recommendation: z.string().nullable(),
        })),
        truncated: z.boolean().optional(),
      })
      .optional(),
  }),
  shape: {
    // WI-2145871: retires this tool's `unclassified-baseline` debt in
    // SHAPER_CONTRACT_EXEMPT. There is no `returns` prose in the
    // `Each row: { … }` form, so the derived-field path yields nothing and the
    // pinned set below is read off the shaper's OWN key list, not authored.
    //
    // `rows: 'inFlight'` picks the axis with TEETH: projectRow() rebuilds every
    // row from a hand-written literal, so a field survives tiering ONLY by being
    // named there — delete a line and this check fails immediately. All three
    // buckets run through that same projectRow, so pinning one guards all three.
    //
    // `id`/`kind` are load-bearing, not decorative: projectRow returns null
    // without them, which would empty the row set and fail the check for the
    // wrong reason. Deliberately EXCLUDED are the two conditionally-spread keys
    // — `assigneeLive` (guarded on `typeof === 'boolean'`) and `queueControl`
    // (projectQueueControl returns undefined for a non-object). The synthetic
    // probe row is all strings, so both are legitimately absent and pinning
    // either would report a defect this tool does not have.
    //
    // The top-level axis is genuine here: `out` is a hand-built literal, so a
    // preserve pin asserts something real (unlike a `{ ...d }` spread shaper,
    // where any key passes by passthrough while asserting nothing).
    // `counts` + `presentation` mechanize the promise the shaper's own note
    // already makes in prose — "aggregate counts remain complete" while rows are
    // capped — and `parked`/`unclaimed` catch a rebuild that silently drops a
    // whole bucket.
    contract: {
      rows: 'inFlight',
      fields: [
        'id',
        'kind',
        'family',
        'harness',
        'title',
        'state',
        'assignee',
        'takenAt',
        'lastProgressAt',
        'updatedAt',
        'severity',
        'priority',
      ],
      preserve: ['counts', 'presentation', 'parked', 'unclaimed'],
    },
    standard: (data, context) => shapeBurnDown(data, 'standard', context.args as { limit?: unknown; ids?: unknown }),
    trimmed: (data, context) => shapeBurnDown(data, 'trimmed', context.args as { limit?: unknown; ids?: unknown }),
  },
  async handler(args, ctx) {
    const requestedIds = args.ids ? [...new Set(args.ids)] : null;
    const wantsFleetMetrics = args.window === 'fleet-lifetime';
    const workspaceId = (ctx as { workspaceId?: string | null }).workspaceId ?? undefined;
    const occurrenceWorkspaceId = resolveConcreteWorkspaceId(
      workspaceId,
      (ctx as { principal?: { workspaceId?: string | null } }).principal?.workspaceId,
    );
    const self = args.since || wantsFleetMetrics ? resolveSelfRef(ctx) : undefined;
    const [items, presence, fleetMetricSourceItems] = await Promise.all([
      requestedIds
        ? Promise.all(requestedIds.map((id) => getWorkItem(id, args.harness))).then(
            (rows) => rows.filter((row): row is WorkItem => row != null),
          )
        : listWorkItems({
            harness: args.harness,
            kind: args.kind as WorkItemKind | undefined,
            includeChildren: args.includeChildren,
            // WI-37381: this fetch feeds the AGGREGATE (terminal.*/counts.*/deltaBy.*),
            // never just the returned row lists — so it must NEVER be bounded by the
            // caller's `limit`. A small `limit:5` used to fetch only 5 rows total and
            // report terminal.total 0 for a queue with 1693 real terminal rows. Always
            // fetch up to the hard cap here; `args.limit` is applied below (via
            // buildBurnDownResult's `rowLimit`) to the RETURNED inFlight/parked/unclaimed
            // arrays only.
            limit: WORK_ITEMS_MAX_LIMIT,
          }),
      listPresence({ workspaceId }).catch(() => []),
      wantsFleetMetrics
        ? listWorkItems({
            harness: args.harness,
            includeObservations: true,
            limit: WORK_ITEMS_MAX_LIMIT,
          })
        : Promise.resolve(null),
    ]);
    // EI-19313376980892266 fix B: resolve the fleet whose closes count as "ours".
    // Only worth a round-trip when `since` was passed (no `since` ⇒ no delta to split).
    // Best-effort throughout: an attribution read must never cost a leader the census.
    const fleetScope = await (async () => {
      if (!args.since) return null;
      try {
        const { fleetEverMembers, latestFleetMembership } = await import(
          '../../fleet-membership-store'
        );
        let slug = args.fleet ?? null;
        let source: FleetAttributionSource = 'arg';
        if (!slug) {
          // Fall back to the CALLER's own fleet — read from the append-only ledger, not
          // their presence row, so a leader whose own presence has been reaped still
          // attributes correctly.
          if (!self?.ownerId) return null;
          const mine = await latestFleetMembership(workspaceId ?? '', self.ownerId);
          if (!mine?.fleetSlug) return null;
          slug = mine.fleetSlug;
          source = 'caller-membership';
        }
        const members = await fleetEverMembers(slug, { workspaceId });
        // An unknown fleet resolves to NO members. Reporting fleet:0 off that would be a
        // fabricated verdict ("your fleet closed nothing") from a failed lookup, so treat
        // it as no-fleet-in-scope instead and let the null + note say so.
        if (members.size === 0) return null;
        return { slug, members, source };
      } catch {
        return null;
      }
    })();
    // P-003: the leader-facing read must use the SAME exact canonical oracle as
    // the write-side breaker. Never derive this from the capped census above.
    // `since` is the monitor-loop signal that asks for flow; the oracle window
    // still begins at ModeRow.setAt, not at the caller's arbitrary delta bound.
    // Once an active DRAIN mode is established, oracle failure stays loud: silently
    // omitting the field would look exactly like "not in DRAIN" and disable the
    // circuit-breaker monitor's detector.
    const drainFlow = await (async () => {
      if (!args.since || !workspaceId || !self?.ownerId) return null;
      const drainMode = (await getModes(workspaceId, self.ownerId)).find(
        (mode) => mode.mode === 'drain',
      );
      if (!drainMode) return null;
      return readDrainFlow({
        workspaceId,
        harness: args.harness,
        ownerId: self.ownerId,
        drainStartedAt: drainMode.setAt,
      });
    })();
    // P-004 / D-002 / D-004: read the append-only writer directly. Never infer
    // occurrence flow from created work-item rows or the capped census above.
    const issueOccurrences = await readIssueOccurrenceCounts({
      workspaceId: occurrenceWorkspaceId,
      harnessSlug: args.harness,
      since: args.since ?? null,
    });
    const fleetMetricResolution = await (async (): Promise<FleetMetricScopeResolution | null> => {
      if (!wantsFleetMetrics) return null;
      const flowMode = args.flowMode ?? 'current-spec';
      if (!workspaceId) {
        return fleetMetricsUnavailable({
          fleet: args.fleet!,
          harness: args.harness,
          flowMode,
          reason: 'workspace identity is unavailable',
          recoverVia: 'retry from a workspace-scoped session',
        });
      }
      return resolveFleetMetricScope({
        workspaceId,
        harness: args.harness,
        fleet: args.fleet!,
        flowMode,
      });
    })();
    const fleetMetrics = await (async (): Promise<FleetMetricsResult | null> => {
      if (!fleetMetricResolution || !fleetMetricSourceItems) return null;
      if (!fleetMetricResolution.ok) return parseFleetMetricsResult(fleetMetricResolution);
      const metricOccurrences = readIssueOccurrenceCounts({
        workspaceId: occurrenceWorkspaceId,
        harnessSlug: args.harness,
        since: fleetMetricResolution.scope.window.startAt,
      });
      return buildFleetMetricsResult(fleetMetricResolution, fleetMetricSourceItems, {
        issueOccurrences: metricOccurrences,
        sourceCapExhausted: fleetMetricSourceItems.length >= WORK_ITEMS_MAX_LIMIT,
        assignee: self?.ownerId,
      });
    })();
    // P-011: apply the lane fence BEFORE the census is built, so every count in the
    // response (terminal.*/counts.*/deltaBy.*) describes the same population — a
    // fence applied to the row lists alone would leave the aggregates harness-wide
    // while looking lane-scoped, which is worse than not offering the arg.
    const fenced = args.fence
      ? applyLaneFence(items, args.fence)
      : null;
    const censusItems = fenced ? fenced.rows : items;
    const result = buildBurnDownResult(censusItems, liveOwnersFromPresence(presence), {
      harness: args.harness,
      since: args.since ?? null,
      fleet: fleetScope,
      // WI-37381: the fixed `ids` cohort path fetches exactly those rows (never capped),
      // so it has no census limit to report. The real-census path always fetches at the
      // hard cap (see above) regardless of `args.limit`; `rowLimit` is where the caller's
      // `limit` actually takes effect — bounding only the returned row lists.
      censusLimit: requestedIds ? undefined : WORK_ITEMS_MAX_LIMIT,
      rowLimit: args.limit,
      sourceCapExhausted: requestedIds ? false : items.length >= WORK_ITEMS_MAX_LIMIT,
    });
    // The cohort audit deliberately reads the UNFENCED rows: it answers "what
    // happened to the exact IDs you named", and silently dropping a named ID because
    // a fence excluded it would report it as MISSING — a fabricated verdict.
    if (requestedIds) result.cohortAudit = buildCohortAudit(requestedIds, items);
    result.countEvidence = buildBurnDownCountEvidence(result, {
      requestedIds,
      kind: args.kind,
      includeChildren: args.includeChildren,
      fence: args.fence,
      cohortCutoff: args.cohortCutoff,
      fleet: args.fleet,
      window: args.window,
    });
    if (fenced) result.fence = fenced.report;
    if (drainFlow) result.drainFlow = drainFlow;
    result.issueOccurrences = issueOccurrences;
    if (fleetMetrics) result.fleetMetrics = fleetMetrics;
    return {
      data: result,
    };
  },
});
