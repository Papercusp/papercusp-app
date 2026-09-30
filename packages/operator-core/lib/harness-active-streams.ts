// SSE connection management (added 2026-04-26 to fix event-loop saturation
// from accumulating /stream connections that never close cleanly).
//
// Rules:
//  - Per (remote IP, slug) key: only one active stream. New connection
//    evicts the previous one for that key.
//  - Total cap across all clients: HARNESS_STREAM_TOTAL_CAP. Beyond cap,
//    new connections get 503.
//
// Diagnostics: GET /api/harness/streams/active returns the live registry.
//
// The Map is hung off globalThis so HMR / multi-import paths share a
// single registry — the cap is meaningless if every importer gets its
// own Map.

export type StreamToken = {
  abort: () => void;
  createdAt: number;
  remoteIP: string;
  slug: string;
};

export const activeStreams: Map<string, StreamToken> =
  (globalThis as any).__papercupActiveStreams ?? new Map();
(globalThis as any).__papercupActiveStreams = activeStreams;

export const HARNESS_STREAM_TOTAL_CAP = Number(
  process.env.HARNESS_STREAM_TOTAL_CAP ?? '64',
);
