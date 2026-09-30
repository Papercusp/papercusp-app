# coding-pot `cup` (self-pulls a claim-spec) vs coding-factory `scoper` (gets a FEATURE_ID pushed) — don't conflate them
URL: /internal/docs/agent-insights/coding-pot-cup-vs-coding-factory-scoper

Papercusp has TWO distinct coding execution models that share the cup:spawn chokepoint, and agents repeatedly conflate their work units. The coding POT is a mug + self-pulling `cup`s: the Mug steers a cup with a versioned claim-spec (scheduler:set_claim_spec) and the cup PULLS its own next item via scheduler:get_next. The coding-FACTORY is the OPPOSITE — a PUSH pipeline (scoper→architect→worker→validator→documenter→curator, driven by a director's spine) where each role is HANDED a FEATURE_ID by the orchestrator (NEXT_SCOPER/NEXT_ARCHITECT/… all carry extras:[\"FEATURE_ID={feature}\"]) and NEVER calls get_next. The exact observed failure: an agent spawned role=\"scoper\" and set claim-specs on it to test the coding-pot handoff — but a scoper never self-pulls, so the claim-spec is INERT and (lacking a pushed FEATURE_ID) the scoper has nothing to do. For a claim-spec self-pulling worker the role is \"cup\", NEVER scoper. operator-spawn now REFUSES a factory pipeline role spawned with no pushed-feature context and points at role=\"cup\"; set_claim_spec WARNS when its beeId resolves to a non-self-pulling role.

:::danger\[SUPERSEDED — BOTH models on this page are gone; neither `cup` nor `scoper` can be spawned]
The coding-**pot** half (a Mug steering self-pulling `cup`s with a versioned claim-spec) was
**retired 2026-08-09**, owner-directed. While `papercusp-mug-kettle-system` is OFF — the
delivered end state, not a pending flip — `cup:spawn` REFUSES and no Mug exists to set or
steer a claim-spec. See
[the Mug · Kettle · Cup tier is retired](/agent-insights/mug-kettle-cup-tier-is-retired).

The coding-**factory** half was already dormant when this page was written (see the note
below about it being "revived"), so the advice it originally gave — *"use the coding-pot
`cup` instead"* — now points at a second dead option. **Do not follow this page's
recommendation.**

**What to do instead:** a claim-spec self-pulling worker is now an **su fleet member**.
`fleet:launch-on-plan { name, plan, count, headless? }` launches them, they pull with
`scheduler:get_next`, and you steer them by claim-SPEC exactly as the Mug steered cups —
the pull model this page describes survived; only its worker substrate and its supervisor
were replaced.

**Why this page is kept:** the push-vs-pull distinction is the genuinely transferable idea,
and the `role`-confusion failure it documents recurs whenever a pushed-pipeline role is
handed a claim-spec. The spawn-time guards described in *The durable guards* are still in
the tree.
:::

## The mistake this prevents

An agent wanted to test the coding-**pot** work-handoff. It **spawned `role="scoper"`** and
then **set claim-specs on that scoper** (`scheduler:set_claim_spec`) expecting it to pull
work. It never pulled anything. **`scoper` is the wrong unit.** A scoper is a coding-**factory**
role: it is *pushed* a `FEATURE_ID` by the orchestrator and **never calls `scheduler:get_next`**,
so a claim-spec set on it is **inert** — it just sits in `bee_claim_specs` and steers nothing.
And because no `FEATURE_ID` was pushed, the scoper had nothing to do either. The right unit for a
claim-spec self-pulling worker is **`role="cup"`**.

The tooling did not flag this. It does now (see *The durable guards* below).

:::caution\[Current status (2026-06-24): coding-factory is RETIRED — NOT ACTIVE]
`blueprints/coding-factory/blueprint.yaml` now carries an explicit
RETIRED/dormant description: its `director` autoloop last fired 2026-05-01 and
nothing currently instantiates it. Do **not** treat it as the active/default
coding harness, and do not wire new work to it — it is kept intact for a
possible future revival (re-enable instantiation + restore the director
dispatch), not a live pipeline you can spawn into today. The PUSH-vs-PULL
distinction below still explains the two models correctly and still applies if
coding-factory is ever revived; the coding **POT** (`cup` + Mug,
`scheduler:get_next`) is the live, actively-used model. If you were about to
push a `FEATURE_ID` into a `scoper`/`architect`/… role expecting a running
pipeline to pick it up, there currently isn't one — use the coding-pot `cup`
path instead.
:::

:::note\[Terminology drift in comments, 2026-07 — not yet a role/field rename]
As of `autoloop-pot-operator-rebuild-2026-06-05`, `blueprints/coding/blueprint.yaml`'s own
comments and description now call this the **"Hive" operator blueprint** — "the Queen in charge
of the bee fleet" — and `operator-spawn.ts`'s factory-vs-self-pulling guard comments likewise say
"coding-HIVE worker" / "bee". This is comment-level renaming only so far: the blueprint's actual
`id: coding`, `kind: pot`, and `spine.decider: mug` are unchanged, and `blueprints/cup/blueprint.yaml`
still names the worker role `cup` and its placer "the Mug." So **`role="cup"` / `scheduler:set_claim_spec`
/ `scheduler:get_next` are still the literal tool-call surface** — treat "Hive"/"Queen"/"bee" in
comments as a synonym for "coding pot"/"Mug"/"cup" until the `kind`/role identifiers themselves change.
:::

## The two models (they share `cup:spawn`, but they are opposites)

### coding POT — PULL (mug + self-pulling cups)

* Blueprint: `blueprints/coding/blueprint.yaml` (`id: coding`, `kind: pot`) — the Mug
  (roles `operator` / `mug`). Its worker is the **`cup`**: `blueprints/cup/blueprint.yaml`
  (`id: cup`, a single-role launch blueprint — the Mug's "place one generic worker" primitive).
* The Mug **steers, doesn't dispatch**: she writes a cup a versioned **claim-spec**
  (`scheduler:set_claim_spec` → `bee_claim_specs`, mig 372) = a scoped **VIEW** (filter) +
  **ORDERING** (rank) over the live work-item DAG (`packages/operator-core/lib/scheduler/claim-spec.ts`).
* The cup **self-pulls**: it calls **`scheduler:get_next`**
  (`packages/operator-core/lib/agent-tools/scheduler/get_next.ts`), which atomically claims the
  next item that satisfies `(global hard floors AND spec.view.filter)`, ordered by `spec.rank`. No
  spec ⇒ `DEFAULT_CLAIM_SPEC` (== `work_items:claim_next` oldest-first).
* Re-steering a running cup = bumping its spec revision; the cup picks it up on its next
  `get_next`. **The pull is the cup's; the scheduling judgment is the Mug's.**

### coding-FACTORY — PUSH (director-driven pipeline)

* Blueprint: `blueprints/coding-factory/blueprint.yaml` (`id: coding-factory`, `kind: harness`).
  A per-feature **director** emits a decision verb each turn; the spine maps it to the next role:
  `scoper → architect → worker → validator → reviewer → documenter → curator`.
* Each lifecycle edge **carries the feature**: `NEXT_SCOPER`, `NEXT_ARCHITECT`, `NEXT_VALIDATOR`,
  `NEXT_WORKER`, … all declare `extras: ["FEATURE_ID={feature}"]` (and `worker` additionally needs a
  chunk). **The role is HANDED its `FEATURE_ID`; it does not self-select.**
* A factory role **never calls `scheduler:get_next`** and a claim-spec means nothing to it.

|                   | coding POT                                            | coding-FACTORY                                                   |
| ----------------- | ----------------------------------------------------- | ---------------------------------------------------------------- |
| worker unit       | **`cup`**                                             | `scoper`/`architect`/`worker`/`validator`/`documenter`/`curator` |
| how it gets work  | **PULLS** via `scheduler:get_next` per its claim-spec | **PUSHED** a `FEATURE_ID` by the director's spine                |
| Mug's lever       | `scheduler:set_claim_spec` (steer)                    | n/a (the director dispatches)                                    |
| claim-spec on it? | yes — that's the point                                | **INERT** — it never calls `get_next`                            |

## How to do it properly

To test (or run) a coding-pot self-pulling handoff:

1. **Spawn a cup** — `cup:spawn { role: "cup", harness: "<slug>", brief?: "…" }`. NOT scoper.
2. **Set its claim-spec** — `scheduler:set_claim_spec { beeId: "<the cup's session/owner id>",
   spec: { …view.filter + rank… } }`. Describe a **lane by property** (plan/paths/tags/priority)
   for a standing, auto-inflowing, steal-able lane; reserve `id in [...]` for a fixed wave.
3. **The cup pulls** — the cup calls `scheduler:get_next` and claims the next item the spec
   selects within the global floors. Re-steer it by setting a new spec (the revision bumps; it
   picks it up on its next `get_next`).

To run the coding-**factory** pipeline instead, push the feature: spawn the role *with* a
`FEATURE_ID` (`featureId` / a `FEATURE_ID=` extra; `worker` also needs a chunk), or — better — let
the harness autoloop / director dispatch the pipeline for you.

## The durable guards

* **`operator-spawn.ts` refuses an unfed factory role.** A spawn of a factory **pipeline** role
  (`scoper`/`architect`/`validator`/`documenter`/`curator`/`director`) with **no pushed-feature
  context** (no `featureId`, no `FEATURE_ID=` extra, no `chunkId`) is **rejected** with a message
  that names the cup alternative. A legitimate factory spawn always carries `FEATURE_ID` (the
  blueprint edges push it), so this never breaks the real factory. (`role="worker"` keeps its older,
  stricter chunk-id requirement, with the same cup hint.)
* **`scheduler:set_claim_spec` warns on a non-self-pulling target.** Best-effort, it looks up the
  `beeId`'s spawned `child_role` in `harness_shared.spawned_agents`; if it resolves to anything other
  than a self-pulling role (`cup`/`mug`), the result carries a prominent `warning` that the spec is
  inert and asks "did you mean to spawn a cup?". It does **not** hard-reject (the `beeId` may be a
  plain session id with no nursery row, or a mug) and swallows lookup errors.
* **Point-of-use guidance** on `cup:spawn`, `scheduler:set_claim_spec`, and `scheduler:get_next`
  spells out the pot-cup-vs-factory-scoper distinction inline.

## See also

* `claim-spec.ts` — the claim-spec schema/validator + `DEFAULT_CLAIM_SPEC` + the `isIdOnlySelector`
  id-pin tripwire.
* `role-config.ts` (`AGENT_ROLES`) — `cup` is "DECOUPLED from the pipeline guards"; the pipeline
  roles apply only inside a `kind:'harness'` coding harness.
