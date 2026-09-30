/**
 * Resolves an EL-emitted tool name to a registered command/query.
 *
 * The EL agent normalizes registry IDs by replacing dots and dashes
 * with underscores (e.g., 'harness.list-features' → 'harness_list_features').
 * Since dot↔dash isn't 1:1 invertible without scanning, we try the
 * cheap reverses first and then fall back to searching the registry.
 *
 * Three resolution stages, in order:
 *   1. Literal match — agent already used the dotted form.
 *   2. Underscore → dot (only the dot variant) — covers IDs without dashes.
 *   3. Iterate registry, comparing normalized forms — definitive
 *      lookup; resolves IDs with mixed dot+dash content.
 *
 * Returns the matched definition's `id` (the canonical registry id),
 * or undefined if no match.
 *
 * Extracted from _hono/mobile.ts so the path can be exercised without
 * a Hono server, with a fake registry.
 */

export interface ToolDef {
  id: string;
}

export interface ToolRegistry {
  get(id: string): ToolDef | undefined;
  /** Should return *all* defs the resolver may match against — both commands and queries. */
  list(): ToolDef[];
}

export function resolveRegistryToolId(elName: string, registry: ToolRegistry): string | undefined {
  // Stage 1: literal match.
  const literal = registry.get(elName);
  if (literal) return literal.id;

  // Stage 2: underscore → dot (the simple inverse).
  const dotted = elName.replace(/_/g, '.');
  if (dotted !== elName) {
    const d = registry.get(dotted);
    if (d) return d.id;
  }

  // Stage 3: scan + compare normalized form.
  for (const d of registry.list()) {
    if (normalizeRegistryId(d.id) === elName) return d.id;
  }

  return undefined;
}

/**
 * Mirrors EL's tool-name normalization: replace dots and dashes with
 * underscores. Used both at agent-creation time (when we publish the
 * tool catalog) and at resolution time (this module's stage 3).
 */
export function normalizeRegistryId(id: string): string {
  return id.replace(/[.-]/g, '_');
}
