# Pot vs coding blueprint — don't conflate them
URL: /internal/docs/agent-insights/pot-vs-coding-blueprint

The pot blueprint (Mug + generalist cups, no spine) is the orchestration layer; the coding blueprint (scoper→…→curator spine) is one execution pipeline it runs. Agents repeatedly describe pot cups with coding-spine roles — they are different blueprints at different layers with opposite execution models.

> **⚠️ Blueprints RENAMED 2026-06-18 — the two names below have shifted (and the two "coding"s differ).**
> Per `orchestrator/src/blueprint/loader.ts`: the orchestration blueprint this page calls **`pot`** is now
> the **`coding`** dir (`kind: pot`, `decider: mug`); the former `generic-pot` is **`work`**; and the
> EXECUTION pipeline this page calls **`coding`** (scoper→…→curator spine) is now **`coding-factory`**
> (single-agent variant `coding-solo`). Legacy ids (`pot`, `generic-pot`) still resolve via the loader
> aliases. So read the table's **"pot" column as today's `coding`** and its **"coding" column as today's
> `coding-factory`**. The orchestration-layer-vs-execution-pipeline DISTINCTION below is unchanged — only
> the names moved.

Agents (and humans — and this insight's author, twice in one session) repeatedly
describe **pot** `cup`s as moving through the **coding** spine
(scoper → architect → worker → …). They are **different blueprints at different
layers with opposite execution models.** Both `extends: base` and both are
"blueprints," which is exactly why they look like siblings — but one
*orchestrates* and one *executes*.

## The one-liner

* **`coding`** = an *execution pipeline*. Takes ONE `feature` (`F-NNN`) and pushes
  it through a fixed chain of specialist roles via a deterministic state-machine
  **spine**.
* **`pot`** = the *orchestration layer above it*. A single **Mug** surveys the
  work frontier and **places ranked work onto generalist `cup`s** (no spine), then
  declares her own next wake. A pot can itself *create* coding harnesses.

They are **not two flavors of the same thing** — the pot sits *above* and runs
coding (and research/…) pipelines as needed.

## Contrast

|                | `coding`                                                                                                                                 | `pot`                                                                                  |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `kind`         | `harness`                                                                                                                                | `pot` (root-only, **never nested**)                                                    |
| work unit      | `feature` (`F-NNN`)                                                                                                                      | `pot-wake` (`POT-NNN`) for the Mug's own wake; real work = `work_items` placed on cups |
| execution      | state-machine **spine**: `director` emits a verb → `deriveNext` → next role                                                              | **no spine**: Mug surveys + places work + self-declares wake                           |
| roles          | scoper → architect → worker → validator → documenter → curator (+ opt-in tester / security / crosscheck / ui-qa; reviewer = the PR gate) | `mug`/`operator` (decider) + `cup` (one generic worker)                                |
| spine edges    | \~20 verbs (`NEXT_WORKER`, `NEXT_VALIDATOR`, …) → role transitions                                                                       | 3 terminal only: `DONE` / `ESCALATE` / `IDLE`                                          |
| `maxTurns`     | 200                                                                                                                                      | 50                                                                                     |
| who drives     | orchestrator runs ≤4 feature pipelines, strict plan-priority order                                                                       | Mug "steers, doesn't dispatch"; cups own their own sequencing                          |
| trigger        | autoloop dispatch (plan-order slot-filling)                                                                                              | self-declared wake (`pot:declare-wake`); **no timer**                                  |
| `planner`      | `features-import` (plans → features, waves + `blocked_by`)                                                                               | `inline`                                                                               |
| `requiresRepo` | `true`                                                                                                                                   | `false`                                                                                |
| finalize       | `gates.finalize`: DONE → curator → documenter → archive                                                                                  | none — cups complete work-items; the Mug reads state                                   |

## The traps that cause the confusion

1. **"worker" is overloaded.** `worker` is a *coding* pipeline role. The pot's
   generic agent is a **`cup`** — the glossary says it "carries no pipeline spine
   and no chunk requirement, **unlike `worker`**." A cup is NOT a
   scoper/architect/worker/validator.
2. **"Mug" ≠ "director".** Both decide, but the `director` emits per-feature
   verbs *inside a spine*; the **Mug** places work across a fleet *with no
   spine*.
3. **A cup can create a coding harness** (`blueprint:catalog → harness:create`)
   for genuinely structured work — so the two appear nested in practice even
   though they're distinct layers. (A cup may **not** launch another pot — pots
   are peers, never nested.)

## Rule of thumb

If you're naming scoper / architect / validator / reviewer / curator → you're in a
**coding** harness. If you're describing a **Mug placing ranked work on cups** →
you're in a **pot**, and **there is no spine.** When unsure, read the harness's
`kind` (`harness` vs `pot`) and its `blueprint.yaml` `spine:` block — a pot's
spine has only `DONE` / `ESCALATE` / `IDLE`.

*Sources: `blueprints/{pot,coding,base}/blueprint.yaml`, `pot/prompts/cup.md`,
`harness/glossary.mdx`, `orchestrator/src/blueprint/{schema,derive-next}.ts`.*
