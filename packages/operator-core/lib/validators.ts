// Shared zod schemas for operator forms.
//
// Centralised so client + server agree on the rules and the same error text
// surfaces inline (per-keystroke) and from the API. Mirror any new rule in
// `apps/operator/app/api/_hono/*` so server-side stays a backstop.

import { z } from 'zod';

/**
 * npm-style package slug. Used for template/snapshot/plugin directories that
 * become both filesystem paths and publishable npm names.
 *
 * Why the rule: lowercase + alphanumeric + `._-` matches npm's package-name
 * grammar; uppercase would break case-insensitive filesystems (macOS) and
 * break `npm publish`. Scoped names `@owner/name` are allowed because
 * marketplace plugins use them.
 */
export const slugSchema = z
  .string()
  .trim()
  .min(1, 'required')
  .refine(
    (s) => /^[a-z0-9][a-z0-9._-]*$/.test(s) || /^@[a-z0-9][a-z0-9._-]+\/[a-z0-9][a-z0-9._-]+$/.test(s),
    { message: 'lowercase + digits + ._- (or @owner/name)' },
  );

/**
 * Semver. Permissive enough for the common case (no build metadata) — matches
 * the harness API's `^\d+\.\d+\.\d+(-[a-z0-9.-]+)?$` pattern exactly so the
 * server-side check can never disagree.
 */
export const semverSchema = z
  .string()
  .trim()
  .min(1, 'required')
  .regex(/^\d+\.\d+\.\d+(-[a-z0-9.-]+)?$/, 'semver, e.g. 0.1.0');

/**
 * Run a zod schema on a single field and return the first error message
 * (or null when valid). Designed for per-keystroke inline validation.
 */
export function fieldError<T>(schema: z.ZodType<T>, value: unknown): string | null {
  const r = schema.safeParse(value);
  if (r.success) return null;
  return r.error.issues[0]?.message ?? 'invalid';
}
