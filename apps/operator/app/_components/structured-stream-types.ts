/**
 * Shared types for <StructuredStreamView> — the typed-step view that renders a
 * one-directional structured event stream as structure (per-step ✓/✗/running +
 * duration + a raw-output drawer escape hatch), instead of flattening it into
 * opaque terminal bytes.
 *
 * Plan: structured-streams-not-terminals-2026-06-05 (D-001/D-002). Kept in a
 * `.ts` (no JSX) so the pure `deriveSteps` reducers consumers pass in are unit-
 * testable without a DOM.
 */

/** A raw event received off the SSE feed, in arrival order. */
export interface StreamEvent {
  /** SSE event name (e.g. `setup-started`, `script-output`). */
  kind: string;
  /** Parsed event payload (caller-shaped). */
  data: unknown;
  /** ISO timestamp the event carries, if any (used for durations). */
  ts: string;
  /** Monotonic arrival index — stable sort/key even when ts collide. */
  seq: number;
}

export type StepStatus = 'running' | 'ok' | 'failed' | 'info';

/** One typed row in the structured view, derived from the event stream. */
export interface StreamStep {
  /** Stable key (a phase family, a step id, …). */
  id: string;
  /** Display label. */
  label: string;
  status: StepStatus;
  /** Epoch ms when the step began (for duration). */
  startedAt?: number;
  /** Epoch ms when the step ended. */
  endedAt?: number;
  /** One-line detail (latest progress marker / failure reason). */
  detail?: string;
  /** Sub-lines under the step (recorded resources, truncation notices, …). */
  notes: string[];
}
