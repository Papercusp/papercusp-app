/**
 * @module coord-lifecycle
 *
 * Coordination-message automation (coord-lifecycle-automation-2026-06-04):
 * auto-emit the *predictable* lifecycle coord from events, leaving free-text
 * `coord:send` for the genuinely-unpredictable residual.
 *
 *  - records.ts      — the typed lifecycle records (D-004/D-006 field design)
 *  - render.ts       — PURE formatters: record → coord notification {summary,body}
 *  - emits-desugar.ts— the `emits` defineTool field → ReactionRule adapter (D-002)
 *  - lifecycle-rules — the actual auto-emit rules (completion/claim/window/finding)
 *
 * The mechanism is the event-reaction engine (event-reaction-system-2026-06-04
 * D-001): `emits` is sugar that desugars to event rules — never a parallel path.
 */

export * from './records';
export * from './render';
export * from './emits-desugar';
