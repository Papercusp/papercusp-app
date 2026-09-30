/**
 * Durable reaction execution — the Papercusp side of the SEAM
 * (event-reaction-system D-004).
 *
 * A reaction must never block or fail its trigger, must survive a restart, and
 * must be idempotent under at-least-once delivery. The durable path enqueues the
 * reaction as a DBOS workflow keyed by a deterministic dedup id (D-007).
 *
 * The generic engine (`@papercusp/event-reaction`) takes the durable runner as a
 * port; this module is the host-local singleton that holds it. The DBOS layer
 * (`../dbos/event-reaction-workflow`) installs an enqueue runner via
 * `setDurableReactionRunner` at bootstrap WHEN `PAPERCUSP_DBOS_REACTIONS=1`.
 * Until then no runner is installed, so `durableReactionsEnabled()` is false and
 * the engine fires every reaction in-process. Kept as a setter (not a direct
 * import of the DBOS module) so `lib/events` never pulls in `@dbos-inc/dbos-sdk`
 * — the operator can run reactions in-process with DBOS entirely absent.
 */

import type { DurableReactionInput as GenericDurableReactionInput } from '@papercusp/event-reaction';
import type { ToolInvocationEvent } from './types';

/** The in-memory input the engine hands the durable runner (event is NOT serializable). */
export type DurableReactionInput = GenericDurableReactionInput<ToolInvocationEvent, string>;

let durableRunner: ((input: DurableReactionInput) => Promise<void>) | null = null;

/** Install the durable enqueue runner (called by the DBOS bootstrap when enabled). */
export function setDurableReactionRunner(fn: ((input: DurableReactionInput) => Promise<void>) | null): void {
  durableRunner = fn;
}

/** Whether the durable (DBOS-queued) reaction path is live. */
export function durableReactionsEnabled(): boolean {
  return durableRunner !== null;
}

/** Enqueue a reaction durably. Throws if no runner is installed (the engine then falls back in-process). */
export async function runDurableReaction(input: DurableReactionInput): Promise<void> {
  if (!durableRunner) throw new Error('durable reaction runner not installed');
  await durableRunner(input);
}
