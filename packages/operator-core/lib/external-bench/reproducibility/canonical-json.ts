/**
 * Deterministic ("canonical") JSON: object keys are sorted recursively so the
 * same logical value always serializes to the same bytes — the precondition for
 * a stable content hash. Arrays keep their order (order is semantic for a task
 * list / seed list); `undefined` members are dropped (they don't round-trip
 * through JSON anyway). Used to hash a pre-registered run config so a third party
 * can recompute the exact `prereg_hash` from the published config.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(v: unknown): unknown {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(sortValue);
  const obj = v as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(obj).sort()) {
    const val = obj[k];
    if (val !== undefined) out[k] = sortValue(val);
  }
  return out;
}
