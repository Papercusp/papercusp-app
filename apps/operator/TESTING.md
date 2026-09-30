# Testing — `@papercusp/web` (`apps/operator`)

This package owns the Papercusp operator API and the operator UI source. Use the
test file router from the repository root when you want one exact file; it picks
the Vitest configuration that owns that file.

## What this project's tests cover

- **Unit tests** (`*.test.ts`, `*.test.tsx`) use
  [`vitest.config.ts`](./vitest.config.ts) and cover pure operator logic,
  routes, components, hooks, reducers, source-level contracts, release guards,
  and script behavior under `app/`, `lib/`, `bin/`, and `scripts/`.
- **Integration tests** (`*.integration.test.ts`) use
  [`vitest.integration.config.ts`](./vitest.integration.config.ts). They run
  against the real migrated `harness_shared` schema and cover operator tools,
  work-items, plans, harnesses, plugins, migrations, synchronization, and
  other database-backed paths. They require the testcontainers/Postgres
  environment.
- **Browser E2E tests** (`e2e/*.spec.ts`) use
  [`playwright.config.ts`](./playwright.config.ts). They exercise the operator
  Vite application in Chromium through the browser-facing flows, including
  admin routes, chat surfaces, settings, and critical navigation paths.
- **Static and contract guards** are colocated with the code they protect.
  They check generated artifacts, route/tool contracts, test-domain coverage,
  release preconditions, and other invariants without requiring a live
  operator.

The operator's test inventory is discovered by the testing-domain registry;
new canonical test files must match one of its globs so they appear in the
Tests tab. `npm run lint:tests` enforces that coverage.

## What they don't cover

- A unit or browser test does not prove behavior against the packaged Tauri
  desktop shell, Rust workbench, or a production operator process.
- Tests that use fake providers, fixtures, or mocked credentials do not prove
  behavior against real third-party accounts, external network services, or
  production rate limits.
- Browser E2E runs the Vite app, not a full packaged desktop build. Use the
  Tauri/desktop testing runbooks for IPC, packaged sidecars, and OS-level
  behavior.
- Integration tests require a working local Docker/Postgres setup; a passing
  unit suite is not evidence that database migrations or RLS behavior work.
- Live voice, real provider, and other credentialed smokes are deliberately
  separate from the deterministic Vitest and Playwright suites.

## Run after editing

Run commands from the repository root unless noted otherwise.

### Unit or static tests

Run the exact affected file (the router selects the owning config):

```bash
npm run test:file -- apps/operator/<path>/<file>.test.ts
npm run test:file -- apps/operator/<path>/<file>.test.tsx
```

For a broader package run:

```bash
npm --workspace @papercusp/web test
npm --workspace @papercusp/web run lint:tests
npm --workspace @papercusp/web run typecheck
```

### Integration tests

Run one integration file through the same router, or the complete operator
integration suite when shared schema, migration, or database code changed:

```bash
npm run test:file -- apps/operator/test/<path>.integration.test.ts
npm --workspace @papercusp/web run test:integration
```

### Browser E2E

Use a free `OPERATOR_E2E_PORT` for an isolated Vite server. Reusing a server is
valid only when it was started with the HMR and fake-LLM settings required by
the Playwright config:

```bash
OPERATOR_E2E_PORT=3065 npm --workspace @papercusp/web run test:e2e -- e2e/<path>.spec.ts
OPERATOR_E2E_PORT=3065 npm --workspace @papercusp/web run test:e2e:ui
```

### Run matrix

| Changed path or behavior | Minimum verification |
| --- | --- |
| `apps/operator/app/**`, `lib/**`, `bin/**`, or `scripts/**` unit code | Exact affected `npm run test:file -- apps/operator/...` test(s), then `typecheck` when types or imports changed |
| `apps/operator/test/**`, `*.integration.test.ts`, tools, migrations, or RLS/database behavior | Focused integration test plus `npm --workspace @papercusp/web run test:integration` when shared setup/schema is affected |
| `apps/operator/e2e/**` or browser-facing route behavior | Focused Playwright spec with an isolated `OPERATOR_E2E_PORT` |
| `libs/papercusp/libs/db/**` or shared migration SQL | `npm run test:all:integration` from the repository root; the affected graph cannot see every schema consumer |
| Testing-domain registry or a new canonical test location | `npm --workspace @papercusp/web run lint:tests` and regenerate/check the testing contract |
| `apps/operator/TESTING.md` or testing documentation | `npm run test:file -- apps/operator/lib/testing-guide.test.ts` plus the relevant docs build/check |

After any meaningful cross-package change, also run the repository's affected
test commands rather than assuming the operator package suite covers all
consumers.

## Local dev

```bash
npm --workspace @papercusp/web test -- --watch
npm --workspace @papercusp/web run test:integration -- --ui
npm --workspace @papercusp/web run test:e2e -- --ui
```

For a live operator UI, use the project Tauri/staging verification runbook;
do not infer that a browser test or the green release checkout reflects
uncommitted `staging` edits.
