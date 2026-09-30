/**
 * @papercusp/operator-core — headless operator backend.
 *
 * Consumers import specific modules by subpath, e.g.
 *   import { handler } from '@papercusp/operator-core/lib/...';
 * (resolved via the consumer's tsconfig path / vite alias). This barrel is
 * intentionally thin — there is no single public surface; the backend is a
 * tree of modules under ./ that apps/operator and the desktop sidecar consume
 * directly. Carved from apps/operator in SP1 C4
 * (plan operator-core-headless-serve-2026-06-04).
 */
export const OPERATOR_CORE_PACKAGE = '@papercusp/operator-core';
