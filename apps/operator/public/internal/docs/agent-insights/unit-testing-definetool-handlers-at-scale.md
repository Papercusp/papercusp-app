# Unit-testing defineTool handlers at scale — mock-source-layer + the sql-tagged-template mock
URL: /internal/docs/agent-insights/unit-testing-definetool-handlers-at-scale

How to cover the agent-tools endpoint surface fast and reliably. Mock the ./source/store layer and run the real pure validators so you test the handler's OWN guards/dispatch/error-mapping; mock inline sql with vi.fn(async()=>rows) (branch on first.raw for dual tagged-template + IN-clause usage); plus the four traps that bite (clearAllMocks, zod defaults, .spec-vs-.test, fail-on-console).

## What

Adding focused unit tests for `defineTool` handlers
(`packages/operator-core/lib/agent-tools/**`, `packages/agent-mcp/src/tools/**`)
without real PG, spawn, or the dispatch layer. The goal is to pin the handler's
OWN logic — guards, branch dispatch, error-code mapping, result/projection
shaping, the never-throw discipline — NOT the delegated store/composition (those
have their own unit/integration tests). Proven across the full surface
(plan `whole-app-test-coverage-breadth-2026-06-14`: \~64 handlers, all green).

Companion to [operator-core-route-handler-unit-tests](/internal/docs/agent-insights/operator-core-route-handler-unit-tests)
(the same partial-mock-db-org + direct-handler-bypasses-zod rules apply here).

## The dominant pattern: mock-source-layer

Most handlers are `validate → call a lib fn → shape the result`. The genuine
gap is the WIRING around an already-tested core. So: mock the `./source` /
store / composition module, keep the **real pure validators**, and call
`tool.handler(args, ctx)` directly.

```ts
vi.mock('./source', () => ({ setPlanSchedule: vi.fn(), getPlanRow: vi.fn() }));
vi.mock('./_ctx-opts', () => ({ ctxToPlanSourceOpts: vi.fn(async () => ({ workspaceId: 'default', harnessSlug: 'web' })) }));
vi.mock('../_harness-scope', async (o) => ({ ...(await o()), harnessScopedCtx: (_h, ctx) => ctx })); // keep harnessArg real (used in args at module load)
import { setPlanSchedule } from './source';
const setSched = vi.mocked(setPlanSchedule);
const tool = (await import('./set-schedule')).default;
// then: assert rrule_required / invalid_rrule (REAL validateRrule) / not_found / projection
```

What's worth a test: the guards (root-only/confirm/required-field), the
branch dispatch (op:'list'|'create'|..., reply-vs-new), the error→message
mapping, the projection (field rename, conditional fields, `*_unavailable`
on a DB failure rather than a misleading empty list). What's **theater** (skip):
thin pass-throughs over an already-tested lib, prompt-string `render*Note`
re-exports, constant/data modules.

## Inline-sql handlers: the sql-tagged-template mock

`getOrgPg().sql` is callable as a tagged template. Mock it so a tagged-template
call resolves the rows:

```ts
vi.mock('@papercusp/db-org', async (o) => ({ ...(await o()), getOrgPg: vi.fn(() => ({ sql: vi.fn(async () => rows) })) }));
```

The `...(await o())` spread is MANDATORY — a bare `{ getOrgPg }` mock fails at
import (`No "generated" export`) because the tool barrel pulls the agent-mcp
bootstrap. For a handler that uses sql BOTH as a tagged-template query AND as an IN-clause
helper (the `sql([...])` call form, embedded in the query — e.g.
improvements/learning-loops), one fn serves both, branching on the
tagged-template marker:

```ts
sql: (first) => (first && first.raw ? Promise.resolve(rows) : { __frag: first })
```

A handler that only passes `sql` THROUGH to a mockable fn (`admitSpawn(sql, …)`,
`getSubtree(sql, …)`) needs no row mock at all — `getOrgPg: () => ({ sql: {} })`
and mock the consumer.

## Four traps that bite

1. **`vi.clearAllMocks()` clears call history, NOT `mockImplementation`.** A
   `mockImplementation(() => { throw … })` (or `mockReturnValue`) set in one test
   PERSISTS into later tests. Reset per-test: `vi.mocked(fn).mockReset()` then
   re-arm in `beforeEach`.
2. **Calling `tool.handler(args, ctx)` directly bypasses the zod `args` schema** —
   `.default()`/coercion/validation run in DISPATCH. A `z.boolean().default(false)`
   field arrives `undefined`. Pass defaulted fields explicitly, or don't assert
   on the default. (Same gotcha as the route-handler insight.)
3. **`.spec.ts` vs `.test.ts` is per-lib — check the vitest `include` glob.**
   operator-core/apps/operator/orchestrator/sync = `*.test.ts`; search-core =
   `src/**/*.spec.ts`. A `.test.ts` in a `.spec`-only lib is silently NOT RUN
   ("No test files found"). This also traps coverage SWEEPS: a reference check
   that greps only `-g '*.test.ts'` reports `.spec`-covered modules as
   "uncovered" — grep ALL of `*.test.ts`, `*.test.tsx`, AND `*.spec.ts`. The
   `.tsx` case bites hardest: a React/jsdom module's colocated test is
   `<name>.test.tsx`, so a `.test.ts`-only enumerator flags an already-covered
   component as a gap (e.g. `ui/built-in-intents.ts` has `built-in-intents.test.tsx`).
   ALWAYS read the existing test before writing a "missing" one — the discipline
   that catches a false positive is reading the neighbor, not trusting the sweep.
4. **operator-core vitest is fail-on-console; apps/operator is NOT.** In
   operator-core, a tested path that `console.warn`/`error`s fails the test —
   `vi.spyOn(console,'warn').mockImplementation(()=>{})` in `beforeEach` (it must
   run AFTER vitest-fail-on-console's own setup hook, so beforeEach, not
   beforeAll). apps/operator (jsdom + RTL, 224 component tests) has no
   fail-on-console, so React act() warnings don't fail — component tests are
   reliable there.

## Provenance

Plan `whole-app-test-coverage-breadth-2026-06-14` (D-028/D-034/D-035/D-040).
Example tests: `agent-tools/plans/set-schedule.test.ts` (mock-source-layer),
`agent-tools/ui/get_state.test.ts` (sql-template mock),
`agent-tools/improvements/learning-loops.test.ts` (dual sql usage),
`agent-tools/locks/acquire.test.ts` (outcome-branch coverage of a 700+-loc handler,
covering the WI-1550 lock-event-emission fan-out AND the EI-9033
`pending_edit`/apply-on-grant guardrails — reject-without-`wake_on_grant`,
reject-multi-path, and the queued-ticket happy path).
