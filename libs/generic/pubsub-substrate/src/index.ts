/**
 * @papercusp/pubsub-substrate — a host-agnostic agent-coordination / pub-sub
 * substrate. Import the sub-paths for focused surfaces:
 *
 *   @papercusp/pubsub-substrate/core            — pure protocol layer (no I/O)
 *   @papercusp/pubsub-substrate/event-log       — the swappable append-only log seam (outbox/CDC)
 *   @papercusp/pubsub-substrate/presence        — the live-presence seam
 *   @papercusp/pubsub-substrate/watermark-store — the per-agent read-cursor seam
 *   @papercusp/pubsub-substrate/capabilities    — the topic/subscription/thread + fan-out seam
 *
 * The root re-exports the core + the three single-row/append-only store seams
 * for convenience. The capabilities seam is import-by-subpath (it depends on
 * @papercusp/linkable-edges for the typed-entity graph). The Postgres backends
 * stay host-side by design — they live in the host adapter
 * (@papercusp/coordination); this package names no consuming app.
 */

export * from './core/index';
export * from './event-log/index';
export * from './presence/index';
export * from './watermark-store/index';
