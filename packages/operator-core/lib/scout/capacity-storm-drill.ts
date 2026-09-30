/**
 * capacity-storm-drill.ts — blender:run-drill mode:'capacity-storm'
 * (rubric-system-hardening-2026-07-14 P-006, EI-12151).
 *
 * WI-4475 landed the timeout-vs-capacity classifier (capacity-errors.ts), but its
 * RED PATH — a live failure being classified at record time, persisted through the
 * jsonb round-trip, and read back in agreement — had never been exercised on the
 * deployed generation: the pool never happened to storm during a release-grading
 * window, so "the classifier works live" rested on unit tests alone.
 *
 * This drill manufactures the storm. It drives the REAL scheduler composition
 * ({@link runScoutTick} — the exact deployed function, not a re-implementation)
 * through three synthetic failure legs against the LIVE tick ledger:
 *
 *   1. `capacity`         — the cycle throws with a typed AdmissionDenial
 *                           reason:'rate-limit-blocked' stamped via:'governor'.
 *                           MUST be reclassified to the 'no-capacity' GATE (not an
 *                           error).
 *   2. `timeout`          — the cycle genuinely times out through the deployed
 *                           withScoutCycleTimeout wrapper (a hung runCycle + a tiny
 *                           cycleTimeoutMs). MUST stay status:'error' — the
 *                           asymmetry-of-harm rule: timeouts are never swallowed
 *                           into the capacity bucket.
 *   3. `admission-defect` — the cycle throws with reason:'no-free-slot' AND a
 *                           legacy-capacity-looking prose message. MUST stay
 *                           status:'error' on BOTH paths — the WI-4541 inversion
 *                           guard (an admission-path defect that merely LOOKS like
 *                           capacity must stay loud), and the versioned-row
 *                           boundary (typed evidence beats legacy prose).
 *   4. `unattested-capacity` — the cycle throws with a capacity REASON
 *                           ('provider-429') but NO `via` attestation stamp — the
 *                           exact shape an evidence-free prose-inferring mint site
 *                           would produce. MUST stay status:'error' on BOTH paths:
 *                           the evidence-required fail-closed rule (WI-5391 Part B).
 *   5. `contradicted-capacity` — a gateway-attested 429 (via:'http-429') while the
 *                           injected pool snapshot reports HEALTHY accounts — the
 *                           live WI-4541 signature. MUST record status:'error' with
 *                           capacityContradicted:true, and the read path must NOT
 *                           re-exclude it (the relabeling-can't-green-the-metric rule).
 *
 * After the legs run, the persisted rows are READ BACK from the ledger and
 * re-classified with {@link isPersistedCapacityError} — proving the write path and
 * the read path agree on the SAME persisted bytes, live.
 *
 * Provenance isolation (D-005, same contract as rubric-live-drill.ts): every tick
 * is recorded origin='drill', so it (a) never enters quality-metrics / cadence
 * reads (they filter origin='scout'), (b) never resets the Scout cadence floor,
 * and (c) never trips the error-streak alarm or the learning.scout SSE ping
 * (tick-ledger gates both on origin==='scout'). No autoloop dep is injected, so
 * fire-state/backoff/single-flight CAS are untouched by construction. The causal
 * assertion: zero non-drill-origin rows carry this drill's cycle ids.
 */

import { getOrgPg } from '@papercusp/db-org';

import { activeWorkspaceId } from '../workspace-registry';
import {
  admissionDenialFrom,
  CAPACITY_CLASSIFIER_SCHEMA_VERSION,
  isPersistedCapacityError,
} from './capacity-errors';
import { runScoutTick } from './scheduler';
import {
  readScoutTicks,
  recordScoutTick,
  type ReadScoutTicksOpts,
  type RecordScoutTickInput,
  type ScoutTickRow,
} from './tick-ledger';
import type { ScoutCadenceState } from './cadence';

/** Provenance partition every storm tick is recorded under. */
export const CAPACITY_STORM_TICK_ORIGIN = 'drill';

/** How long the hung-cycle timeout leg waits before the deployed wrapper kills it. */
export const CAPACITY_STORM_TIMEOUT_LEG_MS = 80;

export type CapacityStormLeg = 'capacity' | 'timeout' | 'admission-defect' | 'unattested-capacity' | 'contradicted-capacity';

export interface CapacityStormLegResult {
  leg: CapacityStormLeg;
  cycleId: string;
  /** runScoutTick's returned reason for this leg. */
  tickReason: string;
  /** The persisted row read back from the ledger (undefined = never landed). */
  persistedStatus?: string;
  persistedGate?: string;
  /** capacityClassifierVersion stamped on the persisted detail. */
  classifierVersion?: number;
  /** isPersistedCapacityError over the read-back detail — the read-path verdict. */
  readClassifiedCapacity?: boolean;
}

export interface CapacityStormEvidence {
  /** Leg 1 write path: reclassified to the 'no-capacity' gate, not an error. */
  capacityGated: boolean;
  /** Leg 1 detail: typed AdmissionDenial + classifier version survived persistence. */
  capacityDetailTyped: boolean;
  /** Leg 1 read path: isPersistedCapacityError agrees the row is capacity. */
  capacityReadAgrees: boolean;
  /** Leg 2 write path: a genuine cycle timeout stayed status:'error'. */
  timeoutStaysError: boolean;
  /** Leg 2 read path: the persisted timeout row is NOT reclassified as capacity. */
  timeoutReadStaysError: boolean;
  /** Leg 3 write path: a no-free-slot denial stayed status:'error' (WI-4541 guard). */
  defectStaysError: boolean;
  /** Leg 3 read path: versioned row + legacy-looking prose still NOT capacity. */
  defectReadStaysError: boolean;
  /** Leg 4 write path: a capacity-reason denial with NO `via` stamp stayed status:'error'. */
  unattestedStaysError: boolean;
  /** Leg 4 read path: the persisted unattested row is NOT reclassified as capacity. */
  unattestedReadStaysError: boolean;
  /** Leg 5 write path: an http-429 denial contradicted by a healthy pool snapshot stayed status:'error' + capacityContradicted. */
  contradictedStaysError: boolean;
  /** Leg 5 read path: the contradicted row is NOT re-excluded despite its attested denial. */
  contradictedReadStaysError: boolean;
  /** All five legs landed persisted origin='drill' rows. */
  allLegsPersisted: boolean;
  /** Ticks carrying this drill's cycle ids OUTSIDE origin='drill' (must be 0). */
  organicTickLeaks: number;
  /** Causal assertion: organicTickLeaks === 0. */
  organicMetricsUnchanged: boolean;
}

export interface CapacityStormDrillResult {
  ok: boolean;
  mode: 'capacity-storm';
  drillId: string;
  legs: CapacityStormLegResult[];
  evidence: CapacityStormEvidence;
  failures: string[];
}

/** PURE: the release verdict over the storm evidence — mirrors evaluateBlenderDrillEvidence. */
export function evaluateCapacityStormEvidence(
  evidence: CapacityStormEvidence,
): { ok: boolean; failures: string[] } {
  const checks: Array<[boolean, string]> = [
    [evidence.capacityGated, "the rate-limit-blocked leg was not reclassified to the 'no-capacity' gate"],
    [evidence.capacityDetailTyped, "the capacity tick's persisted detail lost the typed admissionDenial / classifier version"],
    [evidence.capacityReadAgrees, 'the read path (isPersistedCapacityError) disagreed with the write path on the capacity row'],
    [evidence.timeoutStaysError, 'a genuine cycle timeout was swallowed into the capacity bucket (asymmetry-of-harm violation)'],
    [evidence.timeoutReadStaysError, 'the read path reclassified the persisted timeout row as capacity'],
    [evidence.defectStaysError, 'a no-free-slot admission-path defect was hidden as capacity at write time (WI-4541 inversion)'],
    [evidence.defectReadStaysError, 'the read path let legacy-looking prose reclassify a versioned no-free-slot row as capacity'],
    [evidence.unattestedStaysError, 'an evidence-free capacity-reason denial (no via stamp) was excluded at write time (fail-closed violation)'],
    [evidence.unattestedReadStaysError, 'the read path reclassified the persisted unattested-denial row as capacity'],
    [evidence.contradictedStaysError, 'an http-429 denial contradicted by a healthy pool snapshot was excluded at write time (WI-4541 signature swallowed)'],
    [evidence.contradictedReadStaysError, 'the read path re-excluded the capacityContradicted row (relabeling greened the metric)'],
    [evidence.allLegsPersisted, "not every storm leg landed a persisted origin='drill' tick row"],
    [evidence.organicMetricsUnchanged, "a storm tick leaked outside origin='drill'"],
  ];
  const failures = checks.filter(([pass]) => !pass).map(([, message]) => message);
  return { ok: failures.length === 0, failures };
}

/** Injectable seams so the storm orchestration unit-tests without PG. */
export interface CapacityStormDrillDeps {
  recordTick?: (rec: RecordScoutTickInput) => Promise<void>;
  readTicks?: (opts: ReadScoutTicksOpts) => Promise<ScoutTickRow[]>;
  /** Count ticks carrying these cycle ids under any NON-drill origin (the leak probe). */
  countForeignOriginTicks?: (workspaceId: string, cycleIds: string[]) => Promise<number>;
}

async function countForeignOriginTicksPg(workspaceId: string, cycleIds: string[]): Promise<number> {
  const { sql } = getOrgPg();
  const rows = await sql<Array<{ leaks: string | number }>>`
    SELECT count(*) AS leaks
      FROM harness_shared.scout_ticks
     WHERE workspace_id = ${workspaceId}
       AND origin IS DISTINCT FROM ${CAPACITY_STORM_TICK_ORIGIN}
       AND detail->>'cycleId' = ANY(${cycleIds}::text[])`;
  return Number(rows[0]?.leaks ?? 0);
}

/** A cadence state that fires unconditionally (revision requests preempt every gate). */
function firingCadenceState(nowMs: number): ScoutCadenceState {
  return { idleRatio: 1, frictionSignals: 0, lastRunAtMs: null, nowMs, revisionRequestPending: true };
}

/**
 * Run the capacity-storm drill against the live ledger (or injected fakes).
 * Never throws for a failed assertion — failures land in the result, mirroring
 * runBlenderRubricDrill's contract.
 */
export async function runCapacityStormDrill(
  args: { harnessSlug: string; workspaceId?: string; nowMs?: number },
  deps: CapacityStormDrillDeps = {},
): Promise<CapacityStormDrillResult> {
  const workspaceId = args.workspaceId ?? activeWorkspaceId();
  const nowMs = args.nowMs ?? Date.now();
  const stamp = nowMs.toString(36);
  const drillId = `capacity-storm-${stamp}`;
  const recordTick = deps.recordTick ?? recordScoutTick;
  const readTicks = deps.readTicks ?? readScoutTicks;
  const countForeign = deps.countForeignOriginTicks ?? countForeignOriginTicksPg;

  const legs: Array<{
    leg: CapacityStormLeg;
    cycleId: string;
    runCycle: () => Promise<never>;
    cycleTimeoutMs?: number;
  }> = [
    {
      leg: 'capacity',
      cycleId: `${drillId}-capacity`,
      runCycle: async () => {
        throw Object.assign(
          new Error(`drill:${drillId} synthetic storm — every pool account paused/walled`),
          { admissionDenial: { reason: 'rate-limit-blocked', via: 'governor', pausedAccounts: 12 } },
        );
      },
    },
    {
      leg: 'timeout',
      cycleId: `${drillId}-timeout`,
      // A hung cycle + a tiny budget: the DEPLOYED withScoutCycleTimeout wrapper
      // constructs the real ScoutCycleTimeoutError. Never-settling on purpose —
      // settling after losing the race would risk an unhandled rejection.
      runCycle: () => new Promise<never>(() => {}),
      cycleTimeoutMs: CAPACITY_STORM_TIMEOUT_LEG_MS,
    },
    {
      leg: 'admission-defect',
      cycleId: `${drillId}-defect`,
      runCycle: async () => {
        // The prose DELIBERATELY matches the legacy capacity signatures — the
        // versioned-row boundary must keep typed evidence authoritative.
        throw Object.assign(
          new Error(`drill:${drillId} rate limit exceeded (synthetic admission-path defect)`),
          { admissionDenial: { reason: 'no-free-slot', via: 'governor', freeSlots: 0 } },
        );
      },
    },
    {
      leg: 'unattested-capacity',
      cycleId: `${drillId}-unattested`,
      runCycle: async () => {
        // A capacity REASON with no `via` attestation — the shape an evidence-free
        // prose-inferring mint site would produce. The fail-closed rule must keep it loud.
        throw Object.assign(
          new Error(`drill:${drillId} rate limit exceeded (synthetic unattested capacity claim)`),
          { admissionDenial: { reason: 'provider-429' } },
        );
      },
    },
    {
      leg: 'contradicted-capacity',
      cycleId: `${drillId}-contradicted`,
      runCycle: async () => {
        // A gateway-attested 429 while the (injected) pool snapshot reports healthy
        // accounts — the WI-4541 signature. The record-time discrimination must keep
        // it a loud error with capacityContradicted evidence.
        throw Object.assign(
          new Error(`drill:${drillId} 429 from gateway while pool reports healthy accounts (synthetic WI-4541 signature)`),
          { admissionDenial: { reason: 'provider-429', via: 'http-429' } },
        );
      },
    },
  ];
  // Injected snapshot for the contradicted-capacity leg: the gateway "reports" healthy
  // accounts at record time. Only via:'http-429' denials consult it, so the governor-
  // attested capacity leg still gates deterministically whatever the live gateway says.
  const drillPoolSnapshot = { probedAtMs: nowMs, healthyAccounts: 3, codexConfigured: false };

  const legResults: CapacityStormLegResult[] = [];
  for (const leg of legs) {
    const tick = await runScoutTick(
      {
        readCadenceState: async () => firingCadenceState(Date.now()),
        runCycle: leg.runCycle,
        persistRouted: async () => {
          throw new Error(`capacity-storm ${leg.leg}: persistRouted must never run on a failed cycle`);
        },
        recordTick: (rec) => {
          // Provenance stamp parity (su-7c298e1b, 2026-07-18): the TIMEOUT leg's error
          // string is minted by the DEPLOYED timeout wrapper — that's the certification
          // point, so the drill can't prefix it at throw time like the other legs. A
          // prefix-based consumer would read it as ORGANIC. Stamp it at persist time
          // instead; origin/install_slug already mark the row, the string must agree.
          const errText = rec.detail?.error;
          const detail =
            typeof errText === 'string' && !errText.startsWith('drill:')
              ? { ...rec.detail, error: `drill:${drillId} ${errText}` }
              : rec.detail;
          return recordTick({
            ...rec,
            ...(detail ? { detail } : {}),
            origin: CAPACITY_STORM_TICK_ORIGIN,
            installSlug: drillId,
            workspaceId,
          });
        },
        newCycleId: () => leg.cycleId,
        readPoolSnapshot: async () => drillPoolSnapshot,
      },
      leg.cycleTimeoutMs !== undefined ? { cycleTimeoutMs: leg.cycleTimeoutMs } : {},
    );
    legResults.push({ leg: leg.leg, cycleId: leg.cycleId, tickReason: tick.reason });
  }

  // Read the persisted rows BACK from the ledger — the read-path half of the proof.
  const persisted = await readTicks({
    workspaceId,
    origin: CAPACITY_STORM_TICK_ORIGIN,
    installSlug: drillId,
    sinceMs: nowMs - 5 * 60_000,
  });
  const rowByCycleId = new Map<string, ScoutTickRow>();
  for (const row of persisted) {
    const cid = row.detail?.cycleId;
    if (typeof cid === 'string') rowByCycleId.set(cid, row);
  }
  for (const result of legResults) {
    const row = rowByCycleId.get(result.cycleId);
    if (!row) continue;
    result.persistedStatus = row.status;
    if (row.gate) result.persistedGate = row.gate;
    const version = row.detail?.capacityClassifierVersion;
    if (typeof version === 'number') result.classifierVersion = version;
    result.readClassifiedCapacity = isPersistedCapacityError(row.detail);
  }

  const [capacity, timeout, defect, unattested, contradicted] = legResults;
  const capacityRow = rowByCycleId.get(capacity.cycleId);
  const timeoutRow = rowByCycleId.get(timeout.cycleId);
  const defectRow = rowByCycleId.get(defect.cycleId);
  const unattestedRow = rowByCycleId.get(unattested.cycleId);
  const contradictedRow = rowByCycleId.get(contradicted.cycleId);
  const organicTickLeaks = await countForeign(
    workspaceId,
    legResults.map((l) => l.cycleId),
  );

  const evidence: CapacityStormEvidence = {
    capacityGated:
      capacity.tickReason === 'no-capacity' &&
      capacity.persistedStatus === 'gated' &&
      capacity.persistedGate === 'no-capacity',
    capacityDetailTyped:
      capacity.classifierVersion === CAPACITY_CLASSIFIER_SCHEMA_VERSION &&
      admissionDenialFrom(capacityRow?.detail)?.reason === 'rate-limit-blocked',
    capacityReadAgrees: capacity.readClassifiedCapacity === true,
    timeoutStaysError:
      timeout.tickReason === 'cycle-error' &&
      timeout.persistedStatus === 'error' &&
      typeof timeoutRow?.detail?.timeoutMs === 'number',
    timeoutReadStaysError: timeoutRow !== undefined && timeout.readClassifiedCapacity === false,
    defectStaysError:
      defect.tickReason === 'cycle-error' &&
      defect.persistedStatus === 'error' &&
      admissionDenialFrom(defectRow?.detail)?.reason === 'no-free-slot',
    defectReadStaysError: defectRow !== undefined && defect.readClassifiedCapacity === false,
    unattestedStaysError:
      unattested.tickReason === 'cycle-error' &&
      unattested.persistedStatus === 'error' &&
      admissionDenialFrom(unattestedRow?.detail)?.reason === 'provider-429' &&
      admissionDenialFrom(unattestedRow?.detail)?.via === undefined,
    unattestedReadStaysError: unattestedRow !== undefined && unattested.readClassifiedCapacity === false,
    contradictedStaysError:
      contradicted.tickReason === 'cycle-error' &&
      contradicted.persistedStatus === 'error' &&
      contradictedRow?.detail?.capacityContradicted === true &&
      admissionDenialFrom(contradictedRow?.detail)?.via === 'http-429',
    contradictedReadStaysError: contradictedRow !== undefined && contradicted.readClassifiedCapacity === false,
    allLegsPersisted: legResults.every((l) => l.persistedStatus !== undefined),
    organicTickLeaks,
    organicMetricsUnchanged: organicTickLeaks === 0,
  };
  const verdict = evaluateCapacityStormEvidence(evidence);
  return {
    ok: verdict.ok,
    mode: 'capacity-storm',
    drillId,
    legs: legResults,
    evidence,
    failures: verdict.failures,
  };
}
