# Unit-testing operator-core route handlers — partial-mock db-org, direct-handler pattern
URL: /internal/docs/agent-insights/operator-core-route-handler-unit-tests

vi.mock('@papercusp/db-org') must spread importOriginal or the agent-mcp bootstrap fails on the missing `generated` export; invoke handlers directly with a crafted Request + RouteContext; the loopback gate reads the host HEADER.

## What

Writing Vitest unit tests for
`packages/operator-core/lib/endpoint-route/routes/**` handlers without real
PG, Hono, or telemetry.

## The patterns

* **db-org must be PARTIALLY mocked.** A full
  `vi.mock('@papercusp/db-org', () => ({ getOrgPg }))` fails at import with
  `No "generated" export is defined on the "@papercusp/db-org" mock` —
  importing any route barrel pulls the `@papercusp/agent-mcp` bootstrap
  (`agent-mcp/src/tools/harness/list.ts`), which reads db-org's `generated`.
  Use:

  ```ts
  vi.mock('@papercusp/db-org', async (importOriginal) => ({
    ...(await importOriginal()),
    getOrgPg: () => ({ sql: sqlStub }),
  }));
  ```

* **Cleanest pattern = invoke handlers directly** with a crafted `Request` +
  hand-built `RouteContext` (`{ principal: null, input, params, log, signal }`);
  mock the store module + db-org. Precedent:
  `endpoint-route/__tests__/device-routes.test.ts`. (The Hono
  `registerRoute` + `app.request()` route also works — precedent
  `destructive-public-routes.test.ts` — but needs `../telemetry` mocked.)

* **Calling a `defineTool` handler directly BYPASSES the zod `args` schema.**
  This applies to agent-tools `defineTool`s too (not just endpoint routes) — the
  partial-mock-db-org rule above is the same. The schema's `.parse()` (defaults,
  coercion, validation) runs in the DISPATCH layer, so `await tool.handler(rawArgs, ctx)`
  receives your object verbatim: a field with `z.boolean().optional().default(true)`
  arrives `undefined`, not `true`. Symptom: a code path gated on that default
  silently no-ops (e.g. `plans:promote` skipped its whole mark-items step because
  `args.mark_items` was undefined — looked like a flip-not-found bug). Fix: parse
  first — `const parse = (x) => tool.args.parse(x); await tool.handler(parse(x), ctx)`
  (precedent `agent-tools/work_items/complete.test.ts`) — OR pass every defaulted
  arg explicitly. Precedent for the gotcha:
  `agent-tools/coordination/__tests__/promote-apply.integration.test.ts`.

* **The in-handler loopback gate reads the `host` HEADER, not `req.url`.**
  `isLoopbackRequest` (from `superuser-token`, used by the tui
  `intent-result`/`intents-stream` routes) is a different helper than
  `requireLoopbackOr403`/`isLoopbackHost`. The `host` header IS settable on a
  `Request` in Node 25 (`new Request(url, { headers: { host: 'localhost' } })`)
  and Hono `app.request` preserves it. No host header → not provably
  loopback → 403.

* **Auth posture for a route family** is pinned in `auth-posture.test.ts` via
  a `RULES` prefix entry (e.g. `{ prefix: '/tui/', expect: 'public' }`); the
  walk runs over `ALL_ROUTES`. The test also enforces specific loopback-gated
  routes (e.g., harness SSE stream endpoints per WI-1388) via `it.each()`
  parametrized tests.

## Provenance

Proven on `tui-routes.test.ts` (48 tests, 2026-06-04). Lifted from the Claude
memory archive (`project_operator_core_route_test_dborg_mock`) during the
claude-memory-projection-integration boundary split.
