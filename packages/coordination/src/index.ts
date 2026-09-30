/**
 * @papercusp/coordination — agent coordination substrate as three
 * host-agnostic pieces. Import the sub-paths for focused surfaces:
 *
 *   @papercusp/coordination/core       — pure protocol layer (no I/O)
 *   @papercusp/coordination/event-log  — the swappable append-only log seam
 *   @papercusp/coordination/presence   — the live-presence seam
 *
 * The root re-exports all three for convenience. Identity resolution,
 * watch/notify subscriptions, and watermark persistence stay host-side
 * by design (see README) and are NOT part of this package.
 */

export * from './core/index';
export * from './event-log/index';
export * from './presence/index';
export * from './watermark-store/index';
// NOTE: the legacy path-glob subscription-store seam was retired with coord:watch
// (coordination-substrate-2026-06-03 Phase 3). Entity/topic subscriptions live in
// the `capabilities` seam now (@papercusp/coordination/capabilities).
