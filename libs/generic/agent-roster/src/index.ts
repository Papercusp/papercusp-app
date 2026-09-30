/**
 * @papercusp/agent-roster — the headless agent-roster presentation and its pure
 * logic, extracted so more than one surface can render the same roster.
 *
 * A host supplies data + seams; nothing here fetches, routes, or imports a host
 * path. See ./seams for the three injection points and their defaults.
 */
export { AgentRoster, type AgentRosterProps } from './AgentRoster';
export { AgentDetailStrip, type AgentDetailStripProps } from './AgentDetailStrip';
export { InactiveSessionsSection, type InactiveSessionsSectionProps } from './InactiveSessionsSection';

export {
  appendEndedPage,
  endedDisplayName,
  visibleEndedRows,
  type EndedSessionRow,
  type EndedSessionsPage,
} from './sessions';

export {
  KIND_GLYPH,
  KIND_LEGEND,
  agentGlyph,
  type KindLegendRow,
  type RosterTermKey,
} from './glyphs';

export {
  activityLiveness,
  activityLivenessTitle,
  canFocusWindow,
  canForkSession,
  displayName,
  distinctMachineCount,
  filterRoster,
  fmtCompactAge,
  groupByFleet,
  hasThinking,
  isRunningAgent,
  isSessionGone,
  isTranscriptFresh,
  machineKey,
  machineTabs,
  resumableSessionId,
  shortOwner,
  thinkingStreamUrl,
} from './logic';

export { INACTIVE_SESSIONS_STYLES, ROSTER_STYLES } from './roster-styles';

export {
  defaultRosterChrome,
  identityRosterLabels,
  type LivenessDotProps,
  type RosterBulkActions,
  type RosterChrome,
  type RosterLabels,
  type ThinkingDotProps,
  type TooltipProps,
} from './seams';

export {
  LIVE_MS,
  LIVE_TURN_MS,
  type FleetGroup,
  type Liveness,
  type MachineTab,
  type RosterAgent,
} from './types';
