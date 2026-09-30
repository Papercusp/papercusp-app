/**
 * The roster data model — the shape a host hands this package, plus the
 * derived group/tab shapes its pure logic produces.
 *
 * Extracted from apps/operator-vite/src/components/adv/AgentsRunningPill.tsx
 * (P-001 of portal-universal-bar-and-agent-roster-2026-08-31, D-005: an
 * EXTRACTION, never a copy) so a second surface — the web portal, a separate
 * repo that links @papercusp/* by `file:` specifier — renders the SAME roster
 * from the SAME code with a different theme, instead of forking 2,700 lines.
 */

/**
 * The three-tone display scale for a roster dot.
 *
 * Deliberately re-declared here rather than imported: this package is
 * host-free by construction (the repo's generic-first rule), and the operator's
 * `@papercusp/operator-core/lib/liveness` is not. It is the same pattern that
 * module itself uses for STALE_MS ↔ coordination's PRESENCE_STALE_MS — a local
 * copy plus a test asserting the two cannot drift. That guard lives host-side,
 * where both modules are importable: see
 * apps/operator-vite/src/components/adv/agent-roster-liveness-parity.test.ts.
 */
export type Liveness = 'live' | 'idle' | 'stale' | 'pending';

/** A genuine turn younger than this reads as `live`. Mirrors operator-core's LIVE_MS. */
export const LIVE_MS = 60_000;

/** The window that counts as "live" in this dropdown: took a turn within the last 10 minutes. */
export const LIVE_TURN_MS = 600_000;

/** The subset of a server roster entry this control reads. The fleet fields are
 *  stamped by the host's roster resolver; a host whose payload lacks the
 *  optional fields simply renders without those affordances. */
export interface RosterAgent {
  ownerId: string;
  label: string;
  agent: string | null;
  role: string | null;
  intent: string;
  feature: string | null;
  currentPlanSlug: string | null;
  liveness: 'live' | 'idle' | 'stale' | string;
  /** Authoritative session-lifecycle verdict from the shared server oracle.
   *  Unlike `liveness`, this distinguishes a genuinely live turn from a parked
   *  or ended process that is still emitting keepalive heartbeats. */
  sessionState?: 'live' | 'parked' | 'draining' | 'suspect' | 'ended' | 'recorded' | string | null;
  heartbeatAt: string;
  /** Genuine-activity timestamp (last real turn/tool dispatch) — the "since last
   *  turn" clock and the basis for activity-liveness. NOT the keepalive
   *  heartbeat. null on older/pending rows. */
  lastActiveAt?: string | null;
  /** Whether an engine loop is armed for this agent (keeps working on a cadence). */
  loopArmed?: boolean;
  /** The machine this agent runs on — this machine's fingerprint for a local agent,
   *  the announced machine_label for a federated (cross-machine, shared-hive) agent. */
  machineLabel?: string | null;
  /** True for an agent on THIS machine; false for a federated cross-machine agent. */
  isLocal?: boolean;
  fleetSlug?: string | null;
  fleetColor?: string | null;
  agentPaneKind?: string | null;
  /** The agent's latest run-id + its harness — present only for spawned runs
   *  that have a thinking log. Enables the "live thinking" click action;
   *  absent ⇒ no action shown (never a dead button). */
  runId?: string | null;
  harnessSlug?: string | null;
  /** Native session id — the transcript handle for an INTERACTIVE (non-bee)
   *  CLAUDE session's thinking. */
  sessionId?: string | null;
  /** The omp thread id — an OMP session's transcript handle. */
  ompThreadId?: string | null;
  /** Whether transcript output changed within the recent display window.
   *  Decoration only: this does not establish a live turn. */
  transcriptFresh?: boolean | null;
  /**
   * @deprecated Compatibility alias for transcriptFresh from older roster
   * payloads. Do not use it as a liveness/activity verdict.
   */
  thinking?: boolean | null;
  /** Whether a transcript actually RESOLVES for this agent's live-thinking pane.
   *  false when the recorded session_id resolves to no transcript (a parked/ended
   *  agent whose transcript is gone). Gates the "Live thinking" affordance so
   *  clicking never opens an empty pane. Absent/true for every other backend. */
  thinkingResolvable?: boolean;
  /** The host session-row id + the OS terminal-window handle for this agent, when
   *  recorded. `windowId` is the most direct focus target, but NOT the only one:
   *  given `advSessionId`, the host's focus endpoint can also resolve the window
   *  from the row's stored windowId or window-TITLE fragment, so a live session
   *  whose windowId wasn't pre-resolved is still focusable. pid alone is NOT
   *  sufficient — sibling terminals commonly share one server pid. */
  advSessionId?: number | null;
  windowId?: string | null;
  pid?: number | null;
}

export interface FleetGroup {
  /** null = the "No fleet" catch-all group. */
  slug: string | null;
  color: string | null;
  agents: RosterAgent[];
}

export interface MachineTab {
  key: string;
  label: string;
  isLocal: boolean;
  count: number;
}
