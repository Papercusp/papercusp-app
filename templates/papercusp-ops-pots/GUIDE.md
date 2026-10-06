# papercusp-ops-pots — composition GUIDE

**You are the building agent.** This aspect composes Papercusp's agentic work
plane into an app. The app owns a typed blueprint operation, its target plan
template, and a stable agent identity. Papercusp turns each external,
scheduled, or direct operation submission into visible work items before the
agent does anything. The deterministic app and the agentic plane meet at
**exactly one typed result seam**. Read `template.yaml` for the declared pieces and
MUSTs. Composition stays judgment-led; "done" means every check in the
composed closure is green.

Worked examples to keep open while you build: the starter blueprints +
contract template in THIS template (`blueprints/`, `contracts/`) and the
worked checks-config `reference/README.md` points at.

## MUST — consult the live Papercusp docs when this GUIDE is not enough

You are building on a live Papercusp install. If a component API, plan binding,
agent-name lifecycle, seam convention, or release step is unclear, do not
guess:

- read the Papercusp documentation served on your install at **`/internal/docs`**
  (start with the `agent-insights` section; this template's `template.yaml`
  `docs:` list names its canonical pages), and
- inspect the **operator app**, including its built-in Gmail agentic binding,
  as a running reference for app-scoped plan runs and stable-agent dispatch.

## The construction

The deterministic plane owns triggers, storage, drivers, ledgers, and app
tables. The agentic plane owns judgment work expressed as an app-owned plan
template:

```text
external event, schedule, or direct app request
  → blueprint:submit(operation id + typed input + stable request key)
  → pinned app-owned plan run
  → canonical plan-item promotion (inputs + provenance + blocked-by DAG)
  → assign actionable work items to one stable agent name
  → required wake of the live session that adopted that name
  → work-item completion releases and dispatches newly actionable successors
  → blueprint:result state=ready carries validated output
  → typed output crosses one parse gate into an app table
```

The queue is durable. The wake is delivery, not storage. A missing live agent
therefore fails loudly and retryably while the promoted work remains visible.

## MUST (Tier B — non-negotiable)

1. **Declare one reusable blueprint operation.** In the app's ROOT
   `.papercusp/blueprint.yaml` (materialize `reference/app-root.blueprint.yaml`),
   add an `operations[]` entry with a stable id/version, typed object input,
   typed accepted result, and an exact `plan-template` ref/revision/contentHash.
   The operation points at the plan; it never copies the plan's DAG. Apps call
   `blueprint:submit`, retain the returned handle, read `blueprint:status`, and
   accept payload only from `blueprint:result { state: "ready" }`.
2. **Use the canonical plan/work-item plane for every agentic run.** Author one
   app-owned plan template with explicit `blocked-by` edges and input schema.
   Operation admission launches that template; it does not insert work items
   directly, call `work_items:create`, or grow an app-local scheduler. Canonical
   promotion preserves the run id, immutable inputs/provenance, source
   plan-item identity, replay idempotency, and DAG edges.
3. **Declare the execution target on the plan template.** The plan schedule
   retains the same two-field contract:

   ```yaml
   execution:
     appHarnessSlug: "{{APP_HARNESS_SLUG}}"
     agentName: "{{APP_AGENT_NAME}}"
   ```

   New external bindings carry
   `action { type: "blueprint-operation", operationHarnessSlug, operationId }`;
   new recurrences use `plans:set-schedule { operation: { harnessSlug,
   operationId, input } }`. Operation admission reuses the target template's
   `schedule.execution`. `appHarnessSlug` owns the plan run and queue;
   `agentName` is the durable assignee stored on work items.
4. **Keep the stable agent live and adopted.** Launch the app agent from
   `blueprints/app-agent/`, then have its live session call
   `plan_items:adopt_name { name: "{{APP_AGENT_NAME}}" }`. Dispatch assigns only
   the actionable promoted frontier and sends a required wake to the newest
   live session adopting that name. Blocked descendants stay unassigned and
   unwoken until canonical prerequisite completion releases them. A dead,
   absent, or unwakeable target is a structured retryable failure—not success.
5. **Compose `@papercusp/pot-app-seam` for every crossing.** Use
   `bootstrapPots`, `submitOperations`, `operationStatus`, `operationResult`,
   and `startIngestLoop`; do not
   hand-roll calls against `/api/harness/*`. The seam is vendored inside this
   template, so link `"@papercusp/pot-app-seam": "file:./pot-app-seam"`.
   Never link it from `libs/generic` or an assumed checkout path: materializing
   copies only the selected template directory, and some installs ship no
   source tree.
   `launchPlanRuns` remains as a compatibility surface while an existing
   binding migrates. `operationDraftFromPlanRun` refuses a legacy draft without
   `dedupeKey`, because that key becomes the operation request key and losing it
   would fork replay identity. It also copies the immutable plan-run provenance
   into the reserved operation input field `provenance`; declare that field in
   the operation schema and do not reuse it for domain input.
6. **Own one contracts package and one parse gate.** Specialize
   `contracts/candidate-set.ts` into e.g. `@yourapp/contracts`: `.strict()`
   zod schemas both directions; the join key round-trips unchanged; an empty
   result requires notes; money is integer cents; the parse gate is the ONLY
   path from agent output to an app table; a reject emits
   `<workUnit>.rejected` UP as an event — never a silent drop.
7. **Keep confinement inviolable.** The stable agent is
   read + propose-only against the app's dangerous surface; pinned via role
   capability envelopes (the proven `ops-guard` pattern).
   Your app's **`blueprints/README.md` is the canonical statement of the
   rule** (materialize it from `blueprints/README.md` here) — every doc points
   at it, nothing restates it.
8. **Nothing else crosses.** No second transport, no side-channel table
   writes, no direct DB access from a role.

## SHOULD

- Treat the plan DAG as the execution topology. Parallelism is the number of
  independently actionable items, not a placement-width knob or nested fan-out
  hidden inside a role.
- Keep one stable app-agent name per execution target. A replacement session
  may adopt the same name after restart; durable assignment remains the name,
  while wake delivery resolves the current live session.
- **Judge acceptance** for judgment-heavy items: a rubric with ~3 weighted
  dimensions scoring match fidelity, evidence liveness, and value accuracy
  against declared constraints (see both starter blueprints).
- **Gym signals in four classes** (rename per domain): `no-<danger>-reach`,
  `<workUnit>-has-evidence`, `<constraint>-honored`, `schema-clean-output`.
  `collectTrace: work-item-output` (repo-less = no git diff).
- Model rejected-ingest repair, outcome review, and backlog hygiene as explicit
  plan items or scheduled plans on the same substrate—not a second executor.

## Decision points (declared judgment — answer each, disclose your answers)

| id | The question |
|---|---|
| `seam-work-item-kind` | What work-item kind and id prefix cross the seam? |
| `plan-template` | Which app-owned plan template defines inputs and the blocked-by DAG; what binding or schedule launches it? |
| `operation-contract` | Stable operation id/version; pinned template revision/hash; typed input/result; source of the stable request key. |
| `execution-target` | Which app harness owns the queue, and which stable agent name adopts assignments and wakes? |
| `contract-shape` | What does the down-leg contract carry? Specialize the starter, keep its invariants. |
| `domain-lexicon` | Domain nouns/verbs for hives, roles, work (replaces every `{{…}}` in the starters). |
| `domain-roles` | What prompt and capability envelope does the stable app agent need? |
| `app-tables` | Which app tables does ingested output land in; what read model over them? |

## FREE (genuinely yours)

Agent prompt wording, the plan's domain-specific phases, rubric dimensions and
weights, memory conventions, and optional scheduled review plans are yours.
The failure mode to guard is *illegible* improvisation: record every
decision-point answer so another engineer can review the resulting work plane.

## Composition walk (suggested order)

1. Answer the decision points and record the choices.
2. Author the app-owned plan template: input schema, phases/items, real
   `blocked-by` edges, and acceptance conditions.
3. Fill the ROOT blueprint's (`.papercusp/blueprint.yaml`, from
   `reference/app-root.blueprint.yaml`) operation id/version, exact
   plan-template revision/hash, and typed input/result schemas. An operation
   with `execution: { kind: agent, role }` declares that worker role in the
   same file. The app-agent blueprint under `blueprints/` declares none.
4. Configure new external bindings/recurrences to invoke that operation; keep
   any legacy launch-plan row intact until its parity fixture passes.
5. Specialize `contracts/candidate-set.ts` and test valid plus rejected payloads.
6. Materialize `blueprints/README.md`, `blueprints/app-agent/blueprint.yaml`
   and `.papercusp/blueprint.yaml`, replacing every `{{…}}` token; grep for
   `{{` to prove none remain.
7. Wire the app side through `@papercusp/pot-app-seam`, including non-ready
   result handling and reject events.
8. Launch/adopt the stable app agent, then run this template's checks and the
   full composed checks union.
