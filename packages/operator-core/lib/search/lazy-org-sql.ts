/**
 * `lazyOrgSql` — the org PG handle, resolved on FIRST TOUCH rather than at call
 * time (P-016 of semantic-search-fingerprint-coverage-2026-08-03).
 *
 * `runHybridSearch` takes a `PgHandle` and threads it to every source. Some
 * surfaces registered on the engine have NO leg that consumes it: docs:search
 * reads a filesystem adapter and resolves its own handle inside the
 * doc_sections read; plans:search resolves a workspace-scoped handle inside
 * `withWorkspace`, where its injectable seams live.
 *
 * `getOrgPg()` calls `adminUrl()` unconditionally, so passing a real handle up
 * front would newly couple a LEXICAL-ONLY search — which has never needed a
 * database — to PG discovery being healthy. This proxy defers that: a surface
 * whose legs never touch `sql` never resolves it, and a future source that
 * genuinely wants the handle still gets the real one on first touch.
 */

import { getOrgPg } from '@papercusp/db-org';
import type { PgHandle } from '@papercusp/search';

export const lazyOrgSql = new Proxy((() => {}) as unknown as PgHandle, {
  apply: (_t, _self, argv: unknown[]) =>
    (getOrgPg().sql as unknown as (...a: unknown[]) => unknown)(...argv),
  get: (_t, prop) => (getOrgPg().sql as unknown as Record<string | symbol, unknown>)[prop],
});
