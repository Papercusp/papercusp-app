# Generic (non-coding) pots — the pot-blueprint domain profile
URL: /internal/docs/agent-insights/generic-pot-non-coding

How a Pot runs non-coding work. `generic-pot` is a built-in `kind:'pot'` blueprint that judges deliverables against a rubric (no tests), lands output as artifacts (no commits), and co-locates by topic (not files). The new domain-profile schema fields (acceptance/output/affinity/lexicon/fleet/wake/learning/placement) and where the engine reads each.

> **⚠️ Renamed since this was written.** The blueprint this page calls **`generic-pot`** (and its
> coding sibling **`pot`**) are now **legacy ids aliased to `work` and `coding`** —
> `libs/papercusp/packages/orchestrator/src/blueprint/loader.ts` maps `pot→coding` /
> `generic-pot→work`. `blueprintId: 'generic-pot'` still resolves via the alias, but the canonical
> blueprint dirs are `blueprints/work/` + `blueprints/coding/`. The domain-profile **mechanism** below
> (judge acceptance, artifacts output, topic affinity, the schema fields) is unchanged — only the
> blueprint *names* moved; substitute `work`/`coding` for the current ids.

:::caution\[The placement half is retired — the pot/blueprint half is not]
Instructions below addressed to **the Mug** (notably "the Mug must pass `affinity_kind`
explicitly to `fleet:place_batch`") no longer have an actor: the Mug · Kettle · Cup tier
was **retired 2026-08-09** and `fleet:place_batch` **refuses**
([canonical account](/internal/docs/agent-insights/mug-kettle-cup-tier-is-retired)).

The pot substrate this page is really about — generic (non-coding) pot blueprints, their
config surface, and the affinity WEIGHTS themselves — is explicitly KEPT (D-003) and still
live. Read the placement rows as "how affinity was consumed", not as a call to make.
:::

## What

The Pot/Mug/cup work-queue is no longer coding-only. The blueprint engine already
carried `kind:'pot'`; what made a Pot "a coding system" was hardcoded create/runtime
policy + coding-baked personas. `pot-blueprint-generalization-2026-06-15` lifted that into
a declarable **domain profile** and shipped **`generic-pot`** — the non-coding counterpart
of the coding `pot`.

```bash
pot:create { slug: 'my-research-pot', blueprintId: 'work', wakeInSeconds: 0 }
```

stands up a Pot whose Mug places **research / analysis / deliberation** work onto cups
that produce **deliverables** (reports, decisions, documents):

* **`acceptance.kind: judge`** — "done" is an LLM judge's verdict against a rubric, not a
  test pass.
* **`output.kind: artifacts`** — deliverables persist to the artifacts store, not a repo commit.
* **`affinity.kind: topic-overlap`** — the Mug co-locates/decomposes by subject, not files.
* **`dependencies.blueprints: [research, review, vote]`** — the work-blueprints its cups spawn.

Shipped as **`work extends coding`** (D-009, canonical ids; legacy: `generic-pot extends pot`), NOT a strict 3-deep `base-pot` split:
the live `pot` is already the de-facto base + coding pot (repo-less, generic roles, only its
`prompts/mug.md` is file-coded), and repointing the running fleet to a renamed `coding-pot`
was the risky part. So `generic-pot` is an additive sibling; `pot` stays the coding pot.

**Important**: because `coding` (and therefore `work`) now defaults `knobs.requiresRepo: true`
and `knobs.releaseGate.enabled: true` (per-pot-git-and-release-gate-2026-06-29 D-002), the
`work` blueprint explicitly overrides both back to `false` in its
`libs/papercusp/packages/harness/blueprints/work/blueprint.yaml`:

```yaml
knobs:
  requiresRepo: false        # work extends coding, which now sets requiresRepo:true
  releaseGate:
    enabled: false           # …and releaseGate.enabled:true
```

A `work`-based pot that omits these overrides would inherit the git/release-gate requirements
from `coding` — which is almost certainly wrong for a research/analysis pot. Do NOT remove
these overrides when forking `work`.

## The domain-profile schema (where each field is read)

All additive + **optional** on `BlueprintSchema`
(`libs/papercusp/packages/orchestrator/src/blueprint/schema.ts`) — every pre-existing
blueprint parses byte-identically, so the coding fleet is unchanged.

| Field                          | Consumed by                                                                                                                                                                                                                          | Coding default (undefined ⇒)                   |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| `acceptance.kind` + `rubric`   | `planFinalization` (`dbos/orchestrator-finalize.ts`): `human-gate` blocks DONE until approved; `judge` inserts a **`judge`-role** step before the onDone recipe. Activated by `harnessAcceptanceKind()` in `orchestrator-runner.ts`. | `tests` — the pipeline's validator/smoke gates |
| `output.kind`                  | `planFinalization` tags the documenter with `OUTPUT_KIND=<sink>`; `harnessOutputKind()` reads it.                                                                                                                                    | `repo-commit` — no extra                       |
| `affinity.kind`                | `fleet:place_batch`'s `affinity_kind` arg → `AFFINITY_WEIGHTS_BY_KIND` presets in `fleet/placement-affinity.ts` (reweights the lexicographic ranker).                                                                                | `file-overlap` — today's weights               |
| `lexicon`                      | persona/UI noun overrides (feature/PR vs deliverable/report)                                                                                                                                                                         | the built-in noun                              |
| `learning.{pack,loops}`        | `createHiveHarness` seeds `knowledge.pack` as the default seed pack                                                                                                                                                                  | the global default pack                        |
| `fleet` / `wake` / `placement` | declared; runtime reads are partial (see Gotchas)                                                                                                                                                                                    | global defaults                                |
| `dependencies.blueprints`      | the spawned-blueprint dep + install-closure (blueprint-role-bundling P-007)                                                                                                                                                          | none                                           |

The shared spawn preamble (`prompt-build.ts` + `testing-standard-policy.ts`) also swaps its
hardcoded `TESTING_STANDARD` for a domain-agnostic `VERIFICATION_STANDARD` when
`acceptance.kind !== 'tests'` — so a generic cup isn't told to write tests for a deliverable.

## Roles

`generic-pot` ships its own **`mug`** (topic-seam decomposition), **`judge`** (scores a
deliverable against the acceptance rubric → PASS/NEEDS-REVISION — distinct from the gym judge),
and **`documenter`** (honors `OUTPUT_KIND=artifacts` → `artifacts:save`). The **`cup`** is
inherited (it's already \~95% domain-agnostic). The acceptance gate reuses the existing
registered **`judge`** role (a FROZEN\_OVERLAY role), not a new `acceptance-judge`.

## Gotchas

* **The Mug must pass `affinity_kind` explicitly** to `fleet:place_batch` — the tool does
  not yet auto-resolve the calling pot's blueprint (P-015 deferred). The generic mug persona
  instructs this.
* **The judge step doesn't thread `acceptance.rubric`** into its extras yet; the generic judge
  persona embeds the default dimensions (accuracy/completeness/clarity), which match
  `generic-pot`'s rubric. A fork with a different rubric would need the rubric threaded.
* **The full execution smoke** (`generic-pot` → research-task → DONE via judge+artifacts) is the
  one runtime path not yet exercised; everything up to **live `blueprint:validate`** is verified.

## Source map

| Concern                | Source                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------- |
| Blueprint + personas   | `libs/papercusp/packages/harness/blueprints/work/`                                    |
| Domain-profile schema  | `libs/papercusp/packages/orchestrator/src/blueprint/schema.ts`                        |
| Acceptance/output gate | `packages/operator-core/lib/dbos/orchestrator-finalize.ts` + `orchestrator-runner.ts` |
| Affinity presets       | `packages/operator-core/lib/fleet/placement-affinity.ts` + `place_batch.ts`           |
| Preamble de-code       | `libs/papercusp/packages/orchestrator/src/prompt-build.ts`                            |
| pot:create blueprintId | `packages/operator-core/lib/agent-tools/hive/{create,_create}.ts` + `lib/pot/wake.ts` |
| Plan                   | `pot-blueprint-generalization-2026-06-15` (D-009 split, D-010 runtime-correctness)    |
