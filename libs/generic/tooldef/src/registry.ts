/**
 * In-memory tool catalog. Tools self-register via `defineTool`.
 *
 * Importing `tools/**` once at server startup is enough to populate this;
 * after that, `getCatalog()` returns the full catalog and `lookup(name)`
 * fetches a specific tool.
 */

import type { ToolDefinition } from './types';

const CATALOG = new Map<string, ToolDefinition>();

export function register(def: ToolDefinition): void {
  if (CATALOG.has(def.name)) {
    const existing = CATALOG.get(def.name)!;
    if (existing === def) return;
    // Different capability is a real collision: throw so the bug surfaces in
    // dev rather than silently masking the wrong code path.
    if (existing.capability !== def.capability) {
      throw new Error(
        `Tool name collision: "${def.name}" registered twice. ` +
        `First registration's capability=${existing.capability}, second's=${def.capability}.`,
      );
    }
    // Same name + same capability is USUALLY an HMR / double-import re-eval of
    // the SAME tool (a fresh object, structurally identical): replace silently.
    // But two GENUINELY DIFFERENT tools that happen to share a name + capability
    // also land here, and the old code replaced them with no signal — the later
    // import won and the earlier tool vanished silently (EI-14; this is how the
    // bare `coord:ask` shadowed the knowledge-first `coord:ask` in prod). Tell a
    // re-eval from a real collision by structural signature: identical → replace,
    // different → fail loud.
    if (toolSignature(existing) === toolSignature(def)) {
      CATALOG.set(def.name, def);
      return;
    }
    throw new Error(
      `Tool name collision: "${def.name}" registered twice with the same capability ` +
      `(${def.capability}) but DIFFERENT definitions — the second silently shadows the first. ` +
      `Rename one: two distinct tools cannot share a name. ` +
      `prior description: ${JSON.stringify((existing.description ?? '').slice(0, 100))}; ` +
      `new description: ${JSON.stringify((def.description ?? '').slice(0, 100))}.`,
    );
  }
  CATALOG.set(def.name, def);
}

/**
 * Structural fingerprint used to distinguish a benign re-import of the same
 * tool from a real name-collision between two different tools (EI-14). The
 * legacy catalog only carries the model-facing fields here (description +
 * capability); the projection registry (tool-projection.ts) additionally
 * folds the input-schema shape into its own equivalent check, so the two
 * layers together fail loud on the duplicate-name bug from both directions.
 */
function toolSignature(def: ToolDefinition): string {
  return JSON.stringify({ description: def.description ?? '', capability: def.capability });
}

export function lookup(name: string): ToolDefinition | undefined {
  return CATALOG.get(name);
}

export function getCatalog(): readonly ToolDefinition[] {
  return [...CATALOG.values()];
}

import { _resetProjectionRegistryForTests } from './tool-projection';

/** Clears the catalog. Test-only. */
export function _resetCatalogForTests(): void {
  CATALOG.clear();
  // Also flush the projection registry — defineTool now auto-registers
  // legacy tools as projected, so a test that resets the legacy catalog
  // must also flush the projected mirror to avoid duplicate-name errors
  // when the same tool is re-defined.
  _resetProjectionRegistryForTests();
}
