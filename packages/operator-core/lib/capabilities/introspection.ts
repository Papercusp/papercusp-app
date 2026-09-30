/**
 * Cheap, schema-library-agnostic "does this capability require args?" check.
 *
 * A capability whose schema accepts `{}` has no required args → safe to run
 * from the palette as fire-and-toast. One whose schema rejects `{}` needs an
 * arg-prompt step (Phase 2) → excluded from one-keystroke execution.
 *
 * Works for all three arg-schema flavours in the codebase — JSON Schema (the
 * projected registry's `inputSchema`) via its `required` array, Zod (the
 * Action Registry) and any Standard Schema (tooldef) via the `~standard`
 * interface with a Zod `.safeParse` fallback. Sync-only: an async validator
 * (rare; none of our arg schemas use one) is treated conservatively as
 * "requires args".
 */
export function schemaRequiresArgs(schema: unknown): boolean {
  if (!schema || typeof schema !== 'object') return false; // no schema ⇒ nothing required

  // JSON Schema (projected-registry `inputSchema`) — a root object schema
  // with a non-empty `required` array rejects `{}`. EXCEPT: Zod 4's
  // `toJSONSchema` runs in OUTPUT mode, so a `.default()` field is listed as
  // required while carrying its `default` — the caller may still omit it, so
  // it doesn't require an arg-prompt.
  const required = (schema as { required?: unknown }).required;
  if (Array.isArray(required)) {
    const props = (schema as { properties?: Record<string, unknown> }).properties ?? {};
    return required.some((field) => {
      const prop = props[String(field)];
      return !(prop && typeof prop === 'object' && 'default' in prop);
    });
  }

  // Standard Schema v1 (Zod ≥3.24 and tooldef schemas both implement this).
  const std = (schema as { ['~standard']?: { validate?: (i: unknown) => unknown } })['~standard'];
  if (std && typeof std.validate === 'function') {
    try {
      const r = std.validate({});
      // Async result (Promise) — can't decide synchronously; be conservative.
      if (r && typeof (r as { then?: unknown }).then === 'function') return true;
      return !!(r as { issues?: unknown }).issues;
    } catch {
      return true;
    }
  }

  // Zod fallback (older zod without the standard-schema interface).
  const zod = schema as { safeParse?: (i: unknown) => { success: boolean } };
  if (typeof zod.safeParse === 'function') {
    try {
      return !zod.safeParse({}).success;
    } catch {
      return true;
    }
  }

  return false;
}
