/**
 * get-coerce.ts — WI-1985: be liberal about docs:get's `slugs`.
 *
 * docs:get failed ~35% of calls (68/118 in 48h), and EVERY failure was the same
 * shape: "slugs: Invalid input: expected array, received undefined". The agent
 * passed a bare `slug: "endpoint-system/overview"` (singular key) or
 * `slugs: "endpoint-system/overview"` (a string, not an array) — a natural
 * mistake, since almost every other id-taking tool accepts a scalar. Coerce a
 * singular `slug`, and a string-valued `slugs`, into the `slugs: [...]` array the
 * schema wants BEFORE validation, instead of rejecting a well-intentioned read.
 *
 * Additive + identity-preserving: a well-formed `slugs` array with canonical
 * extensionless refs is returned untouched, so the published tools/list schema
 * (built via z.toJSONSchema of the OUTPUT object) is unchanged and well-shaped
 * callers are unaffected. Projected `.md`/`.mdx` refs are normalized because
 * docs:author returns a filesystem `path` as well as the extensionless `ref`.
 */

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Convert a filesystem-shaped authored-doc ref to an extensionless slug. */
export function normalizeDocsGetRef(value: string): string {
  return value.trim().replaceAll('\\', '/').replace(/\/+$/, '').replace(/\.(?:md|mdx)$/i, '');
}

/**
 * Convert engineering-doc URL/content-root refs to Starlight slugs.
 *
 * This is intentionally separate from normalizeDocsGetRef: harness docs keep
 * their `docs/` prefix as part of the canonical slug, while Starlight maps
 * `<section>/index.mdx` to the `<section>` slug.
 */
export function normalizeEngineeringDocsGetRef(value: string): string {
  const ref = normalizeDocsGetRef(value)
    .replace(/^\/?internal\/docs(?:\/|$)/, '')
    .replace(/^\/?docs\//, '')
    .replace(/^apps\/operator-docs\/src\/content\/docs\//, '');
  return ref.replace(/\/index$/i, '');
}

/**
 * A slug value (string, or array of strings) → a clean non-empty string[].
 * A single string is comma/whitespace-split so `"a, b"` yields two slugs; a lone
 * doc slug (path-like: kebab + slashes, never a comma or space) stays one entry.
 * Returns undefined when nothing usable is present (so the caller can fall back).
 */
function toSlugArray(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const arr = value
      .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
      .map(normalizeDocsGetRef);
    return arr.length > 0 ? arr : undefined;
  }
  if (typeof value === 'string') {
    const parts = value
      .split(/[\s,]+/)
      .map(normalizeDocsGetRef)
      .filter((s) => s.length > 0);
    return parts.length > 0 ? parts : undefined;
  }
  return undefined;
}

/** Preprocess for docs:get args — salvage a singular/scalar slug into `slugs:[]`. */
export function coerceDocsGetSlugs(raw: unknown): unknown {
  if (!isPlainObject(raw)) return raw;
  // A well-formed slugs array is left untouched (identity — no needless clone).
  if (
    Array.isArray(raw.slugs) &&
    raw.slugs.length > 0 &&
    raw.slugs.every((s) => typeof s === 'string' && normalizeDocsGetRef(s) === s.trim())
  ) {
    return raw;
  }
  // Prefer a string/array under `slugs`; else the singular `slug` misuse.
  const slugs = toSlugArray(raw.slugs) ?? toSlugArray((raw as { slug?: unknown }).slug);
  if (!slugs) return raw; // nothing to salvage → let the schema emit its normal error
  const { slug: _singular, ...rest } = raw as Record<string, unknown> & { slug?: unknown };
  return { ...rest, slugs };
}
