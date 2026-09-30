# Testing — @papercusp/module-singleton

```bash
npm run test:file -- libs/generic/module-singleton/src/index.test.ts
```

Vitest, unit only. No database, no containers, no host coupling.

## The calibration control is load-bearing — do not delete it

`src/module-scoped-control.fixture.ts` deliberately does **not** use
`pinModuleState`, so a fresh module record must produce a fresh
`CONTROL_IDENTITY` and a zeroed write count.

This exists because the library's central assertion — *two module records share
one state object* — is **vacuous** if the harness ever stops producing a second
module record: one record trivially shares state with itself. A vitest upgrade, a
config change, or a caching layer could do that, and every subject test would
keep passing while measuring nothing.

So the suite is only informative when **the control splits and the subject
shares**. If the control tests ever start failing (identity preserved across
`vi.resetModules()`), do not "fix" them by relaxing the assertion — the subject
results have become meaningless and the harness is what needs investigating.

## Adding a fixture

Fixtures pair up: any new subject fixture that pins state should have a
control-shaped twin differing in exactly one respect (the pinning), so a
difference in outcome isolates that one cause.
