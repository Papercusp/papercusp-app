/**
 * 405 Method Not Allowed for known paths.
 *
 * Hono's default for an unmatched request is 404 — including the case where
 * the PATH is registered but only for OTHER methods (e.g. POST-only
 * `/card-response` hit with GET). HTTP semantics call for **405** there (path
 * exists, method doesn't), with an `Allow` header listing the methods. The
 * endpoint-route migration regressed this to a blanket 404; the e2e suite
 * still (correctly) asserts 405 for wrong-verb requests.
 *
 * This restores 405 via Hono's `notFound` hook, which runs ONLY when no route
 * matched — so it cannot affect any working route, only the 404-vs-405
 * distinction for requests that were going to 404 anyway. Catch-all patterns
 * (`/plugins/*`, `/:transport`, greedy `:p{.+}`) are EXCLUDED from the match
 * set: they match almost any path, so including them would turn genuine
 * 404s (unknown single-segment paths matching `/:transport`) into false 405s.
 *
 * Plan: endpoint-route-migration-2026-05-20 (405 restoration).
 */

import type { Context, Hono } from 'hono';
import { ALL_ROUTES } from './routes';
import { isCatchAll } from './register';

/** Convert a Hono path pattern to an anchored regex matching a concrete path. */
function patternToRegex(pattern: string): RegExp {
  const parts = pattern.split('/').map((seg) => {
    if (seg === '') return '';
    if (seg === '*') return '.*';
    if (seg.startsWith(':')) {
      const braced = seg.match(/^:[^{]+\{(.+)\}$/);
      if (braced) return `(?:${braced[1]})`; // :name{regex}
      return '[^/]+'; // :name
    }
    return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // literal segment
  });
  return new RegExp('^' + parts.join('/') + '$');
}

/**
 * Non-catch-all routes, as `{ method, re }`, derived from the static
 * `ALL_ROUTES` registry — same source the dispatcher mounts. Built LAZILY on
 * first use (not at module load): `method-not-allowed` is imported by the
 * plugins catch-all, which is itself in `ALL_ROUTES`, so eager top-level
 * evaluation could race the registry's population (empty MATCHERS).
 */
let _matchers: ReadonlyArray<{ method: string; re: RegExp }> | null = null;
function matchers(): ReadonlyArray<{ method: string; re: RegExp }> {
  if (_matchers === null) {
    _matchers = ALL_ROUTES.filter((r) => !isCatchAll(r.path)).map((r) => ({
      method: r.method.toUpperCase(),
      re: patternToRegex(r.path),
    }));
  }
  return _matchers;
}

/**
 * Pure resolver (exported for tests): given a request method + a basePath-
 * relative path, return the allowed-methods set if the path matches a
 * registered literal/param route under a DIFFERENT method (→ 405), else null
 * (→ leave as 404).
 */
export function allowedMethodsFor(relPath: string): string[] {
  const methods = new Set<string>();
  for (const m of matchers()) if (m.re.test(relPath)) methods.add(m.method);
  return [...methods];
}

/**
 * Install the 405-aware `notFound` handler on `app`. `basePath` is stripped
 * from the request path before matching (the host app mounts at `/api`, but
 * route patterns are basePath-relative). HEAD is treated as GET (Hono auto-
 * routes HEAD to GET handlers).
 */
export function installMethodNotAllowed(app: Hono, basePath = ''): void {
  app.notFound((c: Context) => {
    let path = c.req.path;
    if (basePath && (path === basePath || path.startsWith(basePath + '/'))) {
      path = path.slice(basePath.length) || '/';
    }
    const allowed = allowedMethodsFor(path);
    const method = c.req.method.toUpperCase();
    const effective = method === 'HEAD' ? 'GET' : method;
    if (allowed.length > 0 && !allowed.includes(effective)) {
      c.header('Allow', allowed.join(', '));
      return c.json({ error: 'method_not_allowed', allow: allowed }, 405);
    }
    return c.json({ error: 'not_found' }, 404);
  });
}
