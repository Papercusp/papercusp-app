# Integration-testing coord modules with module-level PG handles
URL: /internal/docs/agent-insights/coord-module-integration-test-fixture

coord-inbox-bus / presence / topics-feed resolve getOrgPg/getHarnessAdminUrl at call time — repoint env at the baseline DSN and reset 3 caches (codified in _baseline-coord-fixture.ts); drive the inbox producer via _coordInboxTestSeam.

## What

`coord-inbox-bus`, `presence`, and `topics-feed` call `getOrgPg()`
(peek/sweep/tag reads, harness\_app) — and coord-inbox-bus also
`getHarnessAdminUrl()` (the LISTEN connection, harness\_admin) — **at call
time from module level**, so their PG handles aren't injectable. To
integration-test their EXPORTS (not just the underlying lib stores):

## The fixture

Repoint env at the shared baseline-schema DSN and reset **3 caches**:

* `process.env.HARNESS_DATABASE_URL` = harness\_app and
  `HARNESS_ADMIN_DATABASE_URL` = harness\_admin (both off
  `inject('baselineSchemaDsn')`).
* `_resetUrlCacheForTests()` — relative import from
  `libs/papercusp/libs/db/src/connection` (NOT in the `@papercusp/db-org`
  index; needs `eslint-disable import/no-relative-packages`), plus
  `await _resetForTests()` (the db-org pool), plus
  `_resetHarnessAdminUrlCacheForTests()` (embedded-pg-discovery keeps its OWN
  URL memo — `_resetForTests` does not null it).

Codified in `packages/operator-core/lib/_baseline-coord-fixture.ts`
(mirrors the plans `_pg-tool-fixture.ts`). The baseline globalSetup is ONE
`papercusp_it` DB with full migrations (incl. the mig-126 NOTIFY trigger), so
NOTIFY/LISTEN works database-wide. Integration runs serial
(`fileParallelism: false`) → safe to repoint global env and share coord
tables; still clean up rows per test.

## The coord-inbox-bus test seam

The producer is drivable via `_coordInboxTestSeam` (mirrors `_stopForTests`):
`pump(onNotify)`, `ready` (awaitable ensureStarted — await LISTEN readiness
after the fire-and-forget `onCoordInbox`), `addHandler`, `setPeek` (stub the
human-relevance peek → deterministic draining/dirty coalescing + the
`handlers.size === 0` skip with no NOTIFY race), `setCursor`, `state()`.
A real e2e (insert into `coord_event_log` via admin `${admin.json(body)}` →
mig-126 NOTIFY → wake) covers the once/only-human + below-cursor paths.

## Gotchas

* harness\_app has DML on `coord_event_log`/`coord_presence` via mig-109's
  blanket `GRANT … ON ALL TABLES` (both tables predate 109).
* coord\_\* tables have NO RLS; `harness_features_consolidated` DOES → the
  topics-feed feature-kind enrich is RLS-gated (use conversation+issue kinds
  in tests instead).
* Use `admin.json()`, never `${x}::jsonb` (the `no-bare-jsonb-cast` eslint
  rule on `operator-core/lib/**`).
* Run from the package dir:
  `cd packages/operator-core && npx vitest run --config vitest.integration.config.ts <file>`.

## Provenance

Proven by the coordination-federation test-coverage pass (41 tests,
2026-06-04, su-06a38). Lifted from the Claude memory archive
(`project_coord_federation_test_coverage`) during the
claude-memory-projection-integration boundary split.
