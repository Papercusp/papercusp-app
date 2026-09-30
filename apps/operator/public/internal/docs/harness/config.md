# Configuration
URL: /internal/docs/harness/config

Where harness configuration lives today — blueprint shape + declared params, the PG-stored instance layer delivered via HARNESS_CONFIG_JSON, and the effective-config overlay.

The first-generation harness was configured by one hand-edited
`.harness/config.json`. Today configuration is split into two layers with a
declared, validated surface between them — and **the config file is gone**.

## The two layers

**1. The blueprint (the shape).** A harness is instantiated from a blueprint
(`libs/papercusp/packages/harness/blueprints/<id>/blueprint.yaml`), which
declares the *shape*: roles, spine, triggers, gates, dispatch policy, plus

* **`knobs`** — shape-level defaults (e.g. the `coding-factory` blueprint sets
  `harnessKind: coding`, `requiresRepo: true`, `debuggerThreshold: 3`), and
* **`params`** — the *declared tunables*: a keyed record where each key is a
  dot-path into the instance config (`debugger.threshold`,
  `parallelWorkers.useChunkLoop`, `parallelWorkers.workingStateCheck`, …)
  carrying `label` / `type` / `min`/`max` / `options` / `default` / `group` /
  `affects` / `description`. Params **union across `extends`**: `base`
  declares the universal ones (`parallelWorkers.max`, `aiBackend.default.model`,
  `aiBackend.default.agentCmd`); a child blueprint adds its own (`coding-factory`'s
  worker/typecheck/debugger params — `debugger.threshold`,
  `parallelWorkers.useChunkLoop` / `.workingStateCheck` / `.replanStrikes` /
  `.escalateToRole` — are pipeline-only). The current `coding` (pot) blueprint
  declares no `params:` block at all, so it inherits only base's universal set.
  Schema: `libs/papercusp/packages/orchestrator/src/blueprint/schema.ts`.

:::note\[Blueprint-id rename — `coding` is the Pot, `coding-factory` is the pipeline]
The 2026-06-18 rename
(`domain-generic-pot-architecture-2026-06-18`,
`libs/papercusp/packages/orchestrator/src/blueprint-aliases.ts`) reassigned three
ids: `pot → coding`, `generic-pot → work`, and the **old** `coding → coding-factory`.
So `coding` now names the standard coding **Pot** (Mug + cups), while the
per-feature director pipeline (the strict
scoper → architect → worker → validator → … → curator spine that carries the
worker/typecheck/debugger knobs and params) is now `coding-factory`. There is
deliberately **no `coding → coding-factory` alias** — the `coding` id was reused,
so a bare `coding` reference resolves to the new Pot; old strict-spine instances
must be migrated to `extends: coding-factory`. When this page says "the coding
pipeline" it means `coding-factory`.
:::

**2. The instance config (the overrides).** Per-harness values live in the
**workspace-PG store**, not in a file. At spawn time the operator assembles
the instance config and delivers it solely via the `HARNESS_CONFIG_JSON` env
transport — `.papercusp/config.json` is **deprecated to zero and not read**
(`deprecate-harness-config-json-2026-06-06`; the `harness:migrate-config-json`
tool exists to absorb a legacy file into the PG store).

## How the effective config resolves

`effective-config.ts` overlays blueprint knobs **under** the instance config —
instance overrides always win, merged by a deep-merge where nested objects
merge recursively and scalars/arrays replace. The overlay carries only the
residual knob keys (`promptOverrides`, `aiBackend`, `parallelWorkers`,
`scoper`, `snapshotRetention`); already-migrated knobs (`maxCostUsd`,
`debuggerThreshold`, dispatch concurrency) have their own resolution paths
and are deliberately excluded so nothing double-applies.

The overlay is read **best-effort** from the harness's own local
`<stateDir>/blueprint.yaml` (`loadHarnessKnobs`) — a missing or unparseable
blueprint yields `null` and an **empty overlay**, never a file fallback. And a
blueprint that declares **none** of the five residual keys (the current `coding`
Pot, whose knobs are just `harnessKind` / `requiresRepo`) also produces an empty
overlay: `readEffectiveConfig` short-circuits and returns the bare instance layer
unchanged.

## Reading and writing configuration

The schema-driven layer in
`libs/papercusp/packages/orchestrator/src/blueprint/params.ts` is the one
supported read/write path:

* **`resolveParamViews`** — the current effective value for each declared
  param (instance override if present, else the param's `default`).
* **`validateParamPatch`** — rejects keys that aren't declared (no arbitrary
  config writes), type/range/option-checks each value, and **skips `secret`
  params** — secrets route through the credential store, never the config.
* **`applyParamPatch`** — writes the validated patch at each dot-path,
  dropping values equal to their default so the stored instance config stays
  minimal.

Because param keys *are* the historical config paths, no data migration was
needed — existing overrides already sit at the declared key-paths; they're
now declared + validated rather than freeform.

The UI for all of this is the schema-driven **harness settings panel**
(`BlueprintSettingsPanel`, gated by the `papercusp-blueprint-aware-settings`
[flag](/internal/docs/posthog/feature-flags) — **default ON**): it introspects
the harness's blueprint `params` and renders controls per declared group — which
is why a `coding-factory` harness shows the worker/typecheck/debugger controls
(those params are declared on `coding-factory`), while a `coding` (pot) / `work`
/ research / gym harness shows its own tunables instead of a hardcoded coding
form.

## Mapping from the legacy config (for old-timers)

| Legacy `.harness/config.json` field  | Today                                                                                                   |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `models.<role>` / backend choice     | `aiBackend.*` (residual overlay key; per-param declared)                                                |
| `promptOverrides.<role>`             | survives as a residual overlay key                                                                      |
| `debugger.threshold`                 | declared param `debugger.threshold` on `coding-factory` (blueprint knob default 3)                      |
| `parallelWorkers.*`                  | declared params on `coding-factory` (`useChunkLoop`, `workingStateCheck`, …)                            |
| `snapshotRetention`                  | residual overlay key                                                                                    |
| `smokeTest.*`                        | gate machinery exists, runner not yet ported — see [Smoke-test gate](/internal/docs/harness/smoke-test) |
| `checkpoints.*`                      | retired — `CHECKPOINT` finalizes as escalation; milestone gates are `needs-human` plan items            |
| `branchIsolation.*` / lane worktrees | retired with the run-loop — see [Worktrees & isolation](/internal/docs/harness/worktrees)               |

:::caution\[Update (2026-06-24): coding-factory is now RETIRED — NOT ACTIVE]
As of 2026-06-24 the `coding-factory` blueprint.yaml itself carries an explicit
RETIRED/dormant `description:` — its `director` autoloop last fired 2026-05-01
and nothing currently instantiates it. Do **not** treat it as the
active/default coding harness, and do not wire new work to it; it is kept
intact for a possible future revival (re-enable instantiation + restore the
director dispatch), not a live pipeline agents should spawn into today. The
code path below (`codingFallback()`) still technically resolves to it — that
line hasn't been updated to match the blueprint's own retirement — but per the
owner it is not the pipeline in active use. The **coding** (Pot) blueprint's
Mug + self-pulling `cup`s is the live model; see
[coding-pot cup vs coding-factory scoper](/internal/docs/agent-insights/coding-pot-cup-vs-coding-factory-scoper)
and
[two dispatch models](/internal/docs/agent-insights/two-dispatch-models-mug-cup-vs-coding-factory)
for the full detail. The worker/typecheck/debugger **params** documented above
still exist on the blueprint and are still what a coding-factory pipeline (if
ever revived) would tune — that part of this page is unaffected.
:::

`coding-factory`'s declared params notwithstanding, it is the fallback resolved
when a harness has no blueprint of its own
(`blueprint-run-action.ts`'s `codingFallback()` →
`loadBuiltinBlueprint('coding-factory')`), and the `extends:` target emitted by
`harness:generate-from-repo` for a detected repo — those code paths are
unchanged even though the blueprint is now dormant in practice.

## Related

* [Roles](/internal/docs/harness/roles) — what the blueprint's spine wires
* [Storage policy](/internal/docs/system/storage-policy) — why the instance
  layer is PG, not a file
