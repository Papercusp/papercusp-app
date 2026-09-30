/**
 * types.ts — Red Queen vaccination drill harness
 * (self-learning-frontier-2026-06-12 P-031 / FB-20, supersedes the parked FB-11).
 *
 * A DRILL is a synthetic friction planted with known ground truth in the
 * SANDBOX WORKSPACE, then measured end-to-end through the REAL self-improvement
 * machinery: the watchdog tick collects it (detect), the digest+triage path
 * routes it (triage), the heal+resolve path closes it (fix). MTTSH
 * (mean-time-to-self-heal) is the segment deltas against the planted ground
 * truth. Every signal a drill produces carries origin='drill' (P-002/D-002) so
 * it never reaches an organic learner.
 *
 * THE SANDBOX PARTITION: drills plant rows in the real substrate tables
 * (harness_smoke_test, harness_plan_status, …) but ONLY under the sandbox
 * workspace_id. Every v1 collector family is workspace-scoped, so the live
 * watchdog (which sweeps the live workspace) is structurally blind to planted
 * artifacts — zero-leak by partition, asserted per run on top (leak_check).
 * The captured engineer_issues rows DO share the live store; their partition
 * is origin='drill' + scope='harness:red-queen-sandbox' (the provenance
 * read-seam filter every organic consumer inherits).
 *
 * The DrillOutcome shape is a CONTRACT with FB-23 (drills-as-gym-corpus,
 * P-048): gym judging signals read these rows as ground truth (resolve rate,
 * MTTSH contribution, triage accuracy vs known answers). Coordinate any
 * material change with that lane.
 */

import type { Sql } from 'postgres';
import type { WatchdogCollector } from '../harness/improvements/watchdog';
import type { ImprovementSeverity } from '../harness/improvements/policy';
import type { TriageDecision } from '../harness/improvements/triage';

/** The workspace every drill artifact is planted under — never the live one. */
export const SANDBOX_WORKSPACE_ID = 'red-queen-sandbox';
/** The harness scope drill captures file under ('harness:<slug>'). */
export const SANDBOX_HARNESS_SLUG = 'red-queen-sandbox';
export const SANDBOX_SCOPE = `harness:${SANDBOX_HARNESS_SLUG}`;

/** Governor registry identity — one Red Queen per workspace (D-004). */
export const RED_QUEEN_LOOP_ID = 'red-queen';

export type DrillStatus = 'planted' | 'detected' | 'triaged' | 'resolved' | 'failed' | 'expired';

/** MTTSH segments in milliseconds (deltas between the lifecycle timestamps). */
export interface MttshSegments {
  detectMs?: number;
  triageMs?: number;
  fixMs?: number;
  totalMs?: number;
}

/** Per-run zero-leak assertion detail (stored as leak_check jsonb). */
export interface LeakCheckResult {
  passed: boolean;
  /** The organic-default read seam returned zero drill rows. */
  organicReadClean: boolean;
  /** The drilled family's collector, swept over the LIVE workspace, saw none of the planted artifacts. */
  liveCollectorClean: boolean;
  /** The captured issue's stored signal_origin is exactly 'drill'. */
  capturedOriginIsDrill: boolean;
  notes?: string;
}

/**
 * One drill's outcome — the FB-23 read contract (ground truth + what the
 * system actually concluded + MTTSH + safety).
 */
export interface DrillOutcome {
  drillId: string;
  drillClass: string;
  collectorFamily: string;
  plantedAt: string;
  detectedAt?: string;
  triagedAt?: string;
  resolvedAt?: string;
  expectedWatchdogKey: string;
  expectedKind: 'bug' | 'change';
  expectedSeverity: string;
  expectedDecision?: TriageDecision;
  detectedWatchdogKey?: string;
  detectedKind?: string;
  triagedDecision?: string;
  triagedIdeaType?: string;
  resolvedWithEvidence: boolean;
  issueId?: string;
  mttsh?: MttshSegments;
  leakCheckPassed?: boolean;
  status: DrillStatus;
  origin: 'drill';
}

/** The ground truth a drill class declares before planting. */
export interface DrillGroundTruth {
  expectedWatchdogKey: string;
  expectedKind: 'bug' | 'change';
  expectedSeverity: ImprovementSeverity;
  /** The triage decision the planted friction SHOULD earn, when the class pins one. */
  expectedDecision?: TriageDecision;
}

/** What plant() leaves behind: ground truth + the artifact manifest cleanup removes. */
export interface PlantedDrill extends DrillGroundTruth {
  /** Row identities planted in substrate tables — recorded so cleanup is exact. */
  artifacts: Record<string, unknown>;
  /** Class-specific payload (e.g. the engine-death synthetic routines snapshot). */
  payload?: Record<string, unknown>;
}

/**
 * One drill class — a synthetic-friction recipe per watchdog collector family
 * (plus the out-of-band engine-death class). plant/heal/cleanup write ONLY
 * sandbox-workspace rows; collectors() returns the REAL collector functions
 * scoped to the sandbox, with origin='drill' + sandbox scope stamped on every
 * signal.
 */
export interface DrillClass {
  /** Stable class id, e.g. 'smoke-fail'. */
  id: string;
  /** Watchdog collector family this class drills ('out-of-band' for engine-death). */
  collectorFamily: string;
  description: string;
  /** Plant the synthetic friction in the sandbox workspace. */
  plant: (sql: Sql, planted: { drillId: string }) => Promise<PlantedDrill>;
  /**
   * The collectors that should detect this friction — thin wrappers over the
   * REAL collector functions, run against the GIVEN workspace. The sandbox
   * tick passes SANDBOX_WORKSPACE_ID (signals get origin='drill' + the sandbox
   * scope stamped); the zero-leak check passes the LIVE workspace id and
   * asserts the same sweep comes back empty.
   */
  collectors: (sql: Sql, planted: PlantedDrill, workspaceId: string) => WatchdogCollector[];
  /** Fix the friction (the known remedy ground truth measures against). */
  heal: (sql: Sql, planted: PlantedDrill) => Promise<void>;
  /** Remove every planted artifact (idempotent; runs even after a failed cycle). */
  cleanup: (sql: Sql, planted: PlantedDrill) => Promise<void>;
}
