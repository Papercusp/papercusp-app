// Public API — server bits (framework-free).

// Server
export { sseResponse, parseLastEventId, bridgeChannel } from './server/response';
export type { SseSink, SseResponseOptions } from './server/response';

// Node/Express bridge for `sseResponse()` (deps-free; structural Node response).
export { sseResponseToNode } from './server/node-bridge';
export type { NodeResponseLike } from './server/node-bridge';

// Channel
export {
  getChannel,
  dropChannel,
  listChannels,
  _resetChannelsForTest,
} from './server/channel';
export type { BusChannel, ChannelOptions } from './server/channel';

// Max-duration constants
export { SYNC_MAX_DURATION_SEC, ACTION_MAX_DURATION_SEC } from './server/max-duration';

// Wire format (low-level; exported for advanced consumers + the snapshot test)
export { encodeFrame, heartbeatFrame, commentFrame } from './wire/format';
export type { SseFrame } from './wire/format';

// Client primitives (framework-free)
export {
  createResilientEventSource,
  // A CEILING for any consumer running its own silence timer — see the constant.
  DEFAULT_ZOMBIE_TIMEOUT_MS,
  // Desktop endpoint-IPC has a tighter stream ceiling than the generic wrapper.
  DESKTOP_IPC_STREAM_IDLE_TIMEOUT_MS,
} from './client/resilient-event-source';
// Cross-tab control SSE: one visible owner per same-origin scope, with
// BroadcastChannel fanout and a conservative one-source-per-tab fallback.
export {
  createCrossTabControlStream,
  createCoordinatedEventSource,
  createControlStream,
  defaultControlChannelKey,
  DEFAULT_CONTROL_ELECTION_WINDOW_MS,
  DEFAULT_CONTROL_OWNER_HEARTBEAT_MS,
  DEFAULT_CONTROL_OWNER_LEASE_MS,
  DEFAULT_CONTROL_VISIBILITY_PAUSE_MS,
} from './client/cross-tab-control-stream';
// Live standing-stream registry (per-host connection budget — see stream-registry).
export {
  listLiveStreams,
  countLiveStreamsForHost,
  countStreamsForHostAllRealms,
  getStreamBudgetSnapshot,
  registerLiveStream,
  PEER_STALE_AFTER_MS,
  STREAM_BUDGET_WARN_AT,
  // Yield-on-contention thresholds — exported so a consumer can reason about
  // (and a test assert) the line it will be asked to step aside at.
  STREAM_YIELD_AT,
  STREAM_RESUME_UNDER,
  YIELD_COOLDOWN_MS,
} from './client/stream-registry';
export type {
  BudgetChannel,
  LiveStreamRecord,
  RegisterStreamOptions,
  StreamBudgetSnapshot,
} from './client/stream-registry';
// Resume cursor carried in the stream URL — shared by the client that writes
// it and the server that reads it, so the two spellings cannot drift.
export { RESUME_CURSOR_PARAM, withResumeCursor } from './wire/resume-cursor';
export type {
  ResilientEventSource,
  ResilientEventSourceOptions,
  ResilientEventSourceStatus,
} from './client/resilient-event-source';
export type {
  ControlBroadcastChannel,
  ControlBroadcastChannelCtor,
  ControlDocumentLike,
  ControlWindowLike,
  CrossTabControlRole,
  CrossTabControlState,
  CrossTabControlStream,
  CrossTabControlStreamOptions,
} from './client/cross-tab-control-stream';
export { parseSseStream } from './client/parse-stream';
export type { ParsedSseEvent } from './client/parse-stream';
export { resilientPostStream, StreamIdleTimeoutError } from './client/resilient-post-stream';
export type {
  ResilientPostStreamOptions,
  ResilientPostResume,
  ResilientStreamEvent,
} from './client/resilient-post-stream';

// Vocabulary
export type { SyncSseEventVocabulary } from './sync-events';
