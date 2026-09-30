/**
 * ToolDispatchOverride — §10.4
 *
 * Replaces the rejected "middleware keyed on uiClientId prefix" pattern.
 * The override is part of the production dispatcher interface (always
 * present, only populated for test runs). When a tool call comes in,
 * the dispatcher asks the override; if it returns PASS_THROUGH, the
 * real dispatcher handles it.
 *
 * For `transport: 'in-process'` scenarios, the override is injected
 * directly into the converse handler call. For `transport: 'http-sse'`
 * scenarios (B21/B22 — transport-edge behaviors), the override is
 * looked up from a per-run registry keyed by the `X-Tool-Dispatch-Override-Id`
 * request header.
 */

import { PASS_THROUGH, type ToolDispatchOverride, type ToolResult } from './types';

export { PASS_THROUGH };
export type { ToolDispatchOverride };

// =============================================================================
// Per-run registry for http-sse transport
// =============================================================================

const overrides = new Map<string, ToolDispatchOverride>();

/**
 * Register an override for a runId. Used by the http-sse transport tier
 * (S12 tool-error-recovery is the only initial scenario that opts into
 * this path) — the operator ChatTarget puts the override here before
 * issuing the POST, then reads `X-Tool-Dispatch-Override-Id` in the
 * route handler to retrieve it.
 */
export function registerOverride(runId: string, override: ToolDispatchOverride): void {
  overrides.set(runId, override);
}

export function getOverride(runId: string): ToolDispatchOverride | undefined {
  return overrides.get(runId);
}

export function clearOverride(runId: string): void {
  overrides.delete(runId);
}

// =============================================================================
// Helpers for scenario authors
// =============================================================================

/** Build an override that maps tool names to fixed results / errors. */
export function makeStaticOverride(map: Record<string, ToolResult | { error: string } | 'pass-through'>): ToolDispatchOverride {
  return {
    override(name) {
      const entry = map[name];
      if (!entry || entry === 'pass-through') return PASS_THROUGH;
      if ('error' in entry) {
        return { content: [{ text: JSON.stringify({ error: entry.error }) }], isError: true };
      }
      return entry;
    },
  };
}

/** Build an override that returns a result after a delay (for cap-time scenarios). */
export function makeSlowOverride(map: Record<string, { delayMs: number; result: ToolResult }>): ToolDispatchOverride {
  return {
    async override(name) {
      const entry = map[name];
      if (!entry) return PASS_THROUGH;
      await new Promise((r) => setTimeout(r, entry.delayMs));
      return entry.result;
    },
  };
}

/** Compose multiple overrides: first match wins (PASS_THROUGH → try next). */
export function chainOverrides(...overridesIn: ToolDispatchOverride[]): ToolDispatchOverride {
  return {
    async override(name, args) {
      for (const o of overridesIn) {
        const r = await o.override(name, args);
        if (r !== PASS_THROUGH) return r;
      }
      return PASS_THROUGH;
    },
  };
}
