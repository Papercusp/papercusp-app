# Testing — `@papercusp/blueprint-distribution`

The Harness Blueprint distribution layer (E1/E2 of
`harness-blueprint-distribution-2026-06-03`). Two pure, host-injected modules
built on the frozen `@papercusp/orchestrator/blueprint` engine.

## What's covered (Vitest, `src/**/*.test.ts`)

- **`resolve-extends-composed.test.ts`** — the composed `extends` resolver
  (E1a). Precedence (local → installed → built-in, first hit wins), the
  installed-tier and built-in fallbacks, the `null` miss, multi-`localDirs`
  ordering, the default-options degenerate-to-built-in case, and one end-to-end
  test that lays out a local blueprint `extends`-ing the built-in `coding` and
  resolves+merges it through the real loader. The filesystem probe is injected
  (`exists`) so the unit cases need no disk; the e2e case uses an `os.tmpdir()`
  scratch dir.

- **`blueprint-deps.test.ts`** — the import-time dependency validator (E2a).
  `parseDepSpec` (plain / versioned / scoped names), empty deps, a present vs
  absent tool, an installed plugin, a Cupboard-installable plugin, a plugin in
  neither (the upfront "needs plugin X" failure), version-qualified matching,
  and the mixed missing-tool + missing-plugin case. Fully pure — host capability
  sets are injected.

## What's NOT covered here

- The CLI wiring (`papercusp init --from`) — covered by the CLI package's tests.
- The operator-side import-time validation wiring (closing the `unknown_tool`
  gap) — covered in `apps/operator`.

## Run

```bash
cd libs/papercusp/packages/blueprint-distribution && npx vitest run
```

Or via the affected-test walker from the repo root (`npm run test:affected`).
