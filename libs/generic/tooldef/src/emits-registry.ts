/**
 * emits-registry.ts — the generic collector for tools' intrinsic `emits`
 * declarations (coord-lifecycle-automation-2026-06-04 D-002).
 *
 * WHY a side-collector rather than reading the tool catalog: role-gated tools
 * (`requirePrincipal: false` — most coordination / work_items tools) are NOT
 * stored in `getCatalog()`; they project straight into the projected-tool
 * registry. So "iterate getCatalog() for emits" would miss exactly the
 * lifecycle tools that carry `emits`. Instead, `defineTool` records every
 * tool's `emits` HERE at definition time — regardless of gating path — and the
 * operator-core desugar reads this collector once at load and registers the
 * rules. Generic (no domain knowledge of what `fire` means) by design; the
 * meaning lives in the operator-core adapter.
 */

import type { ToolEmitSpec } from './types';

/** One tool's collected emits, keyed by the resolved tool name. */
export interface CollectedToolEmits {
  toolName: string;
  emits: readonly ToolEmitSpec[];
}

const COLLECTED: CollectedToolEmits[] = [];
/** Track names already seen so a re-registered tool (hot-reload, test) replaces. */
const INDEX = new Map<string, number>();

/**
 * Record a tool's `emits`. Called by `defineTool` for BOTH gating paths.
 * Idempotent by tool name: re-defining a tool (prompt hot-reload,
 * `PAPERCUSP_RELOAD_PROMPTS`, tests) replaces its prior entry rather than
 * duplicating it. A tool with no (or empty) `emits` is a no-op.
 */
export function collectToolEmits(
  toolName: string,
  emits: readonly ToolEmitSpec[] | undefined,
): void {
  if (!emits || emits.length === 0) {
    // If the tool previously had emits and now declares none, drop the stale entry.
    const prior = INDEX.get(toolName);
    if (prior !== undefined) {
      COLLECTED.splice(prior, 1);
      INDEX.delete(toolName);
      // Re-index entries shifted left by the splice.
      for (const [name, idx] of INDEX) if (idx > prior) INDEX.set(name, idx - 1);
    }
    return;
  }
  const prior = INDEX.get(toolName);
  if (prior !== undefined) {
    COLLECTED[prior] = { toolName, emits };
    return;
  }
  INDEX.set(toolName, COLLECTED.length);
  COLLECTED.push({ toolName, emits });
}

/** Every tool that declared `emits`, in declaration order. The desugar reads this. */
export function getCollectedToolEmits(): readonly CollectedToolEmits[] {
  return COLLECTED;
}

/** Test seam — clear the collector between cases. */
export function _resetCollectedToolEmitsForTests(): void {
  COLLECTED.length = 0;
  INDEX.clear();
}
