# Decision log (harness design history)
URL: /internal/docs/harness/decisions/log

The chronological design decisions of the first-generation harness, which of them survive in the current engine, and where decisions are recorded today.

This page preserves the design-decision history of the **first-generation
(bash) harness** — the rationale trail that shaped the current system — and
maps which decisions survive in today's engine. Historical entries are kept
as written; they describe the system *as it was*.

## Where decisions are recorded today

This log is frozen history. Current design decisions live on **plans** — each
plan document carries a `## Decisions` section of dated `D-NNN` entries
(written via `plans:add-decision`), and the event-maintained rationale
projection (`rationale:feed`) serves the topic-keyed "why" across plans, work
items, and insights. If you're about to record a decision, put it on the
relevant plan, not here.

## The bash-era decision log (historical)

| When    | Decision                            | Rationale (as recorded)                                                                   |
| ------- | ----------------------------------- | ----------------------------------------------------------------------------------------- |
| Initial | **bash + claude as the runtime**    | No agent-runtime opinion; \~1500 lines of supervisor anyone can read in an afternoon.     |
| Initial | **Disk-only state**                 | Any role can be invoked from a fresh shell and re-derive everything.                      |
| Initial | **Fresh context per role**          | No drift across iterations; the prompt cache absorbs the cost (99.94% hit rate observed). |
| Initial | **Per-role markdown prompts**       | Improvements compound without code changes; cache-key-stable.                             |
| Initial | **Curator role**                    | Without compaction, raw memory grows unboundedly.                                         |
| Mid     | **Plan-reviewer gate**              | Catches scope drift before any worker fires.                                              |
| Mid     | **Debugger role**                   | Stuck features (attempts ≥ 3) deserve root-cause analysis, not blind retry.               |
| Mid     | **Crosscheck role**                 | A different model re-validates the validator's pass; catches "confidently wrong".         |
| Late    | **Cost-cap removed**                | Miscounted spend + owner wanted unbounded cost; soft-warn, later disabled.                |
| Late    | **TDD iron law in validator**       | Behavioral assertions need a test that failed before the change.                          |
| Late    | **"Boil the lake" principle**       | Sprawling roles got an explicit "do fewer things perfectly" section.                      |
| Late    | **Evidence rule**                   | Every PASS claim must quote source output; reports without evidence revert to failing.    |
| Late    | **Identity file per role**          | Cross-mission append-only memory; curator promotes recurring patterns.                    |
| Late    | **Named checkpoints**               | Pre-agreed milestones gate progress, distinct from escalations.                           |
| Late    | **Git worktrees**                   | Each parallel lane gets its own filesystem dir; no git race possible.                     |
| Late    | **Service smoke-test**              | Real curl + service startup before declaring DONE.                                        |
| Late    | **Two-mode parallelism**            | `lane` (different features) vs `competition` (same feature, validator picks winner).      |
| Late    | **Decisions timeline + ghost rate** | Orchestrator parse-ghost telemetry as a first-class signal.                               |

## Which of these survive today

Verified against the current engine:

* **Fresh contexts, prompt-cache discipline, curator** — survive as core
  design, each with its own page:
  [fresh-contexts](/internal/docs/harness/decisions/fresh-contexts),
  [prompt-cache](/internal/docs/harness/decisions/prompt-cache),
  [curator](/internal/docs/harness/decisions/curator).
* **Per-role markdown prompts** — survive, but the global
  `prompts/<role>.md` tier is gone (deleted in Phase 5, D-012). A role's
  persona now resolves by walking the blueprint **extends-chain** —
  `blueprints/<id>/prompts/<role>.md` (the blueprint's own override and
  each ancestor), always terminating at
  `blueprints/base/prompts/<role>.md`, the universal role library that is
  consulted for every blueprint (see [Roles](/internal/docs/harness/roles)).
* **Validator disciplines** — survive in the layered validator persona
  (`blueprints/base/prompts/validator.base.md` + `validator.md`). The
  **default-reject disposition** is there verbatim ("Your default is
  *reject*"). The **evidence rule** survives as discipline, not as a named
  clause: "Generate independent evidence. Don't trust the worker's claims"
  and "Record each assertion `[PASS]` / `[FAIL]` with evidence" — the old
  "EVIDENCE RULE" label is no longer a literal heading in the persona. The
  validator also carries a curator-maintained, append-only
  `identity/validator.md` it reads at startup — the concrete instance of
  the surviving "Identity file per role" decision (cross-mission memory of
  prior-mission lessons).
* **Debugger + crosscheck** — survive as blueprint roles in
  `blueprints/coding-factory/blueprint.yaml`: the debugger is a *reactive
  overlay* that fires before a worker retry once `knobs.debuggerThreshold`
  (default `3`) attempts accrue (`reactive: { beforeRole: worker,
  minAttempts: 3 }`); crosscheck is an opt-in quality gate
  (`NEXT_CROSSCHECK`). Note the blueprint name: the per-feature
  director spine moved to `coding-factory` in the 2026-06-18 rename — see
  the blueprint-rename note below.
* **Decision telemetry + ghost rate** — survives;
  see [Decision telemetry](/internal/docs/harness/decisions-timeline).
* **Named checkpoints** — **deprecated**: `CHECKPOINT` now finalizes as an
  escalation; milestone gates are `needs-human` plan items.
* **Competition mode** — removed (replaced by the synthesizer pre-cutover,
  itself dormant since the run-loop retirement); lane-style isolation lives
  on — see [Worktrees & isolation](/internal/docs/harness/worktrees).
  Parallelism is now two-tiered: at the fleet level the Pot/Mug places
  ranked tasks onto cup slots (free slot / graceful-evict+fresh /
  warm-inject), and the per-feature `coding-factory` pipeline carries
  `dispatch.concurrency: 4` (`priority: plan-order`) for parallel feature
  pipelines.
* **Disk-only state** — superseded: Postgres is the runtime store-of-record
  (see [Storage policy](/internal/docs/system/storage-policy)); the
  fresh-shell re-derivability *goal* survives, now via PG + the operator API.

## A note on the blueprint rename (`coding` is now the Pot)

This page was written when `coding` *was* the per-feature director spine.
The 2026-06-18 domain-generic-pot-architecture rename
(D-011/D-024) shuffled the blueprint ids, so the names mean different
things today:

* The bash-era per-feature spine — scoper → architect → worker → validator
  → reviewer → documenter → curator, with the debugger/crosscheck overlays
  — survives as **`blueprints/coding-factory/blueprint.yaml`** (the retired
  per-feature director loop, lifted into declared spine edges).
* **`blueprints/coding/blueprint.yaml`** is now a different system entirely:
  the **Pot/Mug operator blueprint** (`kind: pot`, roles `operator` and
  `mug`) — the judgment layer over the cup fleet, not a validation spine.
  Following the old pointer expecting validator/debugger/crosscheck will
  land you on the Mug instead.

## Later eras (condensed)

Two further decision clusters in the original log concerned systems that are
now fully retired, kept here as one-line summaries: the **org layer** (five
fixed LLM directors with typed message kinds and file-based state under
`~/.restart-org/` — retired; its jobs live in work items, coord, and the Pot
operator) and the **public-site extraction** (a slim public repo +
Cloudflare-Workers static hosting for papercupai.com — site retired to
`_retired/papercup/`). The full tables remain in this page's git history and
the retired source (`_retired/papercup/`).

## Decisions explicitly rejected (historical, still instructive)

| Rejected                                         | Why                                                                                                                                                                                |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AutoGPT-style infinite loop                      | Drift catastrophe; supervised iterations with explicit decision verbs instead.                                                                                                     |
| LangChain orchestration                          | Heavyweight runtime + abstractions we didn't need.                                                                                                                                 |
| External task-source integration (Linear/Notion) | Owner explicitly declined an external task source.                                                                                                                                 |
| Vector-DB memory for the harness loop            | Bounded markdown memory was sufficient at harness scale. (Semantic memory later arrived as a *separate* system — the `memory:*` store — without replacing curated harness memory.) |
| Discord/Slack as the control surface             | Couples the harness to one chat UI; HTTP API + dashboard instead.                                                                                                                  |
| Tmux-based agent messaging                       | Couples state to a terminal multiplexer.                                                                                                                                           |
