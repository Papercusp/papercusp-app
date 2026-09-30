# checks/ — the acceptance suite (landed: plan app-templates-2026-07-04 P-007)

The load-bearing replacement for the old deterministic generator: an app
composed from this template is DONE only when these checks pass,
app-parameterized, ALONGSIDE every other composed template's checks (the
union rule — `@papercusp/template-kit` `composeTemplates`).

## The suites (portable — copy verbatim into the composed app)

| check | file | pins |
|---|---|---|
| `confinement-guard` | `confinement-guard.test.ts` | no app-agent role's `capabilities:`/`tools:` matches a dangerous pattern (cart/checkout/vault/approvals-write analogs) |
| `seam-round-trip` | `seam-round-trip.test.ts` | the contract package exposes both wire gates; valid in/out payloads parse; the join key echoes unchanged; a malformed payload.out is REJECTED; the stable app-agent blueprint declares the same seam kind plus a typed, pinned plan-target operation; delegates the live operation→result→ingest leg to the app's own integration suite |
| `gym-signals` | `gym-signals.test.ts` | the stable app-agent blueprint declares `gym.collectTrace` + every required guardrail signal id |

## How they run

Each file is self-contained (devDeps: `vitest`, `yaml`) and driven by a JSON
config named via the **`TEMPLATE_CHECKS_CONFIG`** env var — schema:
`@papercusp/template-kit` **`TemplateChecksConfig`** (`checks-config.ts`, the
canonical field docs). Paths resolve relative to `app.root`, which resolves
relative to the config file's dir. **Without the env var every suite SKIPS**
— copying the files never breaks an unwired repo; wiring the config is part
of composing the app.

`seam.operation` pins the reusable operation id/version and the exact
plan-template ref/revision/content hash. The portable check rejects an
untyped or direct-plan-only substitute before the app can call it a reusable
workflow binding.

Worked example: the worked config at
`../../papercusp-app/reference/worked-example.checks-config.json`.

```sh
TEMPLATE_CHECKS_CONFIG=/path/to/checks-config.json npx vitest run checks/
```

In this monorepo, validate the machine schema/reference twin with
`npm test -w @papercusp/template-kit` and the bundled template tree with
`cd packages/operator-core && npx vitest run lib/cupboard/template-bundle-integrity.test.ts`.
These portable checks run only from a materialized app (or the template gym)
with `TEMPLATE_CHECKS_CONFIG`; there is no separate templates workspace.
