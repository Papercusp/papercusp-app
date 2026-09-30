/**
 * tripwire/revert-executor.ts — the auto-revert EXECUTOR
 * (queen-autonomy-policy-2026-06-13 B-16 / P-081, D-025).
 *
 * B-16 owns the revert-handle VOCABULARY + the dispatch: a `revert_handle`
 * `{ kind, ... }` says how to undo an auto-decided reversible action, and this
 * registry maps each `kind` to a pure-ish reverter that performs the undo through
 * an existing safe operation. The Queen execution layer PRODUCES handles matching
 * this contract (and may `registerReverter` its own kinds); the tripwire sweep
 * (scan.ts) calls `executeRevertVia` on a trip.
 *
 * CANONICAL built-in handle kinds (the contract a producer conforms to):
 *   - `{ kind: 'work-item-state',    id, priorState,    harness? }`
 *       → restore a work-item's lifecycle state (setWorkItemState).
 *   - `{ kind: 'work-item-priority', id, priorPriority,  harness? }`
 *       → restore a work-item's queue priority (setWorkItemPriority; a non-lease
 *         holder's write degrades to a steering PROPOSAL, fail-open — unchanged).
 *
 * Unknown kinds return `reverted:false` with a note (the sweep still records the
 * trip + demotes + alerts — the revert is best-effort). Reverters never throw out
 * (caught → reverted:false), so a bad handle can't wedge the sweep.
 *
 * Reverse-ops are injected (`RevertHelpers`) so the registry is unit-testable
 * without PG; `defaultRevertHelpers()` binds the live `work-items` libs.
 */

import type { RevertHandle } from './core';
import type { RevertOutcome } from './scan';
import type { TripwireRow } from './store';

/** The reverse-operations a built-in reverter may use (injected for testability). */
export interface RevertHelpers {
  setWorkItemState: (
    id: string,
    state: string,
    opts: { harness?: string; by?: string; allowNonCanonical?: boolean; skipCompletionGate?: boolean },
  ) => Promise<unknown>;
  setWorkItemPriority: (id: string, priority: number | null, opts: { harness?: string }) => Promise<unknown>;
  /** P-010 Inbox bulk compensation. Optional for injected legacy/test helpers;
   *  the built-in fails closed when the host has not wired it. */
  revertAttentionBulkItem?: (handle: RevertHandle) => Promise<RevertOutcome>;
}

/** A reverter undoes one handle kind. MUST NOT throw for control flow — return reverted:false. */
export type Reverter = (handle: RevertHandle, helpers: RevertHelpers) => Promise<RevertOutcome>;

function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}

/** The canonical reverters B-16 ships for the standard reversible-action kinds. */
export const BUILTIN_REVERTERS: Readonly<Record<string, Reverter>> = {
  'work-item-state': async (h, helpers) => {
    const id = str(h.id);
    const priorState = str(h.priorState);
    if (!id || !priorState) return { reverted: false, note: "work-item-state handle missing id/priorState" };
    const harness = str(h.harness) ?? undefined;
    // allowNonCanonical: this restores a CAPTURED prior DB state (possibly a raw-SQL
    // pipeline phase), not agent input — it must bypass the P-011 agent-typo guard (D-010).
    // skipCompletionGate (WI-1403, contract C-1): a revert-to-prior-state is NOT a
    // completion — even when priorState happens to be terminal, no genuine "who finished
    // this + what proves it" claim applies here, so it must not (and structurally cannot,
    // since it has no completionRef) satisfy the completion-integrity gate.
    await helpers.setWorkItemState(id, priorState, {
      ...(harness ? { harness } : {}),
      by: 'autonomy-revert',
      allowNonCanonical: true,
      skipCompletionGate: true,
    });
    return { reverted: true, note: `restored work-item ${id} → state '${priorState}'` };
  },
  'work-item-priority': async (h, helpers) => {
    const id = str(h.id);
    if (!id) return { reverted: false, note: 'work-item-priority handle missing id' };
    const prior = typeof h.priorPriority === 'number' ? h.priorPriority : null;
    const harness = str(h.harness) ?? undefined;
    await helpers.setWorkItemPriority(id, prior, harness ? { harness } : {});
    return { reverted: true, note: `restored work-item ${id} → priority ${prior ?? 'null'}` };
  },
  'attention-bulk-item': async (h, helpers) => {
    const workspaceId = str(h.workspaceId);
    const runId = str(h.runId);
    const itemId = str(h.itemId);
    if (!workspaceId || !runId || !itemId) {
      return {
        reverted: false,
        note: 'attention-bulk-item handle missing workspaceId/runId/itemId',
      };
    }
    if (!helpers.revertAttentionBulkItem) {
      return { reverted: false, note: 'attention-bulk-item reverter is not wired on this host' };
    }
    return await helpers.revertAttentionBulkItem(h);
  },
};

/** Build a reverter registry: the built-ins overlaid with any caller extensions. */
export function makeRevertRegistry(extra?: Record<string, Reverter>): Map<string, Reverter> {
  return new Map(Object.entries({ ...BUILTIN_REVERTERS, ...(extra ?? {}) }));
}

/** Register (or override) a reverter for a handle kind on an existing registry. */
export function registerReverter(registry: Map<string, Reverter>, kind: string, fn: Reverter): void {
  registry.set(kind, fn);
}

/**
 * Execute the undo for a tripped row's revert_handle via the registry. Unknown
 * kind → reverted:false; a reverter that throws is caught → reverted:false. Never
 * throws (the sweep's demote + alert are the safety; the revert is best-effort).
 */
export async function executeRevertVia(
  row: TripwireRow,
  registry: Map<string, Reverter>,
  helpers: RevertHelpers,
): Promise<RevertOutcome> {
  const kind = typeof row.revertHandle?.kind === 'string' ? row.revertHandle.kind : null;
  const reverter = kind ? registry.get(kind) : undefined;
  if (!reverter) return { reverted: false, note: `no reverter registered for handle kind '${kind ?? '(none)'}'` };
  try {
    return await reverter(row.revertHandle, helpers);
  } catch (e) {
    return { reverted: false, note: `reverter for '${kind}' failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Live reverse-ops, lazily imported so this leaf doesn't pull work-items at load. */
export function defaultRevertHelpers(): RevertHelpers {
  return {
    async setWorkItemState(id, state, opts) {
      return (await import('../../work-items')).setWorkItemState(id, state, opts);
    },
    async setWorkItemPriority(id, priority, opts) {
      return (await import('../../work-items')).setWorkItemPriority(id, priority, opts);
    },
    async revertAttentionBulkItem(handle) {
      return (await import('../../attention/bulk-run-reversal')).revertAttentionBulkItemHandle(handle);
    },
  };
}
