/**
 * @papercusp/coordination/core — the pure, host-agnostic protocol layer.
 * Zero I/O (no fs, no DB), identity-free (receives resolved owner-id
 * strings, never a host ctx). Everything here is unit-testable in
 * isolation and shared by both storage seams (event-log, presence) and
 * the host.
 */

export {
  type CoordKind,
  // D-014: the executable ↔ conversational split. `isExecutableCoordKind` is the
  // single runtime authority for "may this line drive a state transition?" —
  // exported so readers narrow through it instead of re-listing kinds locally.
  type CoordExecutableKind,
  type CoordConversationalKind,
  COORD_EXECUTABLE_KINDS,
  COORD_CONVERSATIONAL_KINDS,
  isExecutableCoordKind,
  // P-009: the single door from an envelope to a state transition. The intent is
  // BODY-FREE by construction, so a transition path cannot read prose.
  type CoordTransitionIntent,
  readCoordTransitionIntent,
  type CoordEnvelope,
  newMsgId,
  compareByTsThenId,
} from './envelope';
export { type WatchTrigger, patternToRegex, matchesPattern } from './glob';
export {
  type Watermark,
  emptyWatermark,
  normaliseWatermark,
  mergeWatermark,
} from './watermark';
export { foldThread } from './thread';
export { type InboxOptions, filterInbox } from './inbox';
export {
  type OpenHandoffInput,
  type HandoffRecord,
  type HandoffKind,
  type HandoffWithAcceptance,
  HANDOFF_KINDS,
  isHandoffRecord,
  foldHandoffs,
} from './handoffs';
export {
  type EscalationSeverity,
  type EscalationOption,
  type OpenEscalationInput,
  type ResolveInput,
  type EscalationRecord,
  type EscalationResolvedEvent,
  type EscalationReopenedEvent,
  foldResolved,
  indexResolves,
  resolvedEventId,
  reopenedEventId,
  escalationGeneration,
  foldEscalations,
} from './escalations';
export {
  type PlanEventType,
  type ReadPlanEventsOpts,
  filterPlanEvents,
} from './plan-events';
export { findUnknownFromItems } from './promote';
