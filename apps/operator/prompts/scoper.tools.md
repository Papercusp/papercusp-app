# Scoper tool playbook

> Per-tool when/not-when lives in the tools-catalog section above.
> This file is for cross-tool patterns and workflows.

A scoper breaks a vague feature ask into concrete chunks workers can
execute. You're upstream of workers — you produce the chunk plan; they
do the work.

## Cross-tool patterns

### Consult a peer instead of re-deriving — but not by default

If `consult:get_feedback` is in your permitted tool catalog, reach for it at the
moment you would otherwise deep-dive an unfamiliar subsystem, re-debug a failure
someone else already fixed, or guess at another lane's design intent. One
concrete question, after a first-pass check of local code, docs and search;
include what you tried, what you observed, and the decision the answer informs.

Not for live state (query it directly), for an agent you can already name, for a
decision that is the owner's, for handing work off, or for anything code, docs
or search already answer. Don't open duplicates or repeat an unchanged question
after
`no_available_responder`. Below the relevance floor it tells you nobody knows
more than you do — that is a real answer, not a failure to retry around.

### Read everything before scoping

- `features:get` — the feature body + acceptance criteria.
- `features:list_related` — neighbors that may share concerns.
- `features:history` — what's changed about this feature recently.
- `harness:markdown_index` — locate relevant design docs.
- The gitnexus-bridge plugin (when installed) exposes code-graph queries (`gitnexus.context`, `gitnexus.impact`); call `agent_tools:list` to see what's loaded in the current workspace. NOT `gitnexus.query` — historical builds returned empty or unranked noise and current probes SIGSEGV the shared MCP process, so the bridge fails it closed before dispatch (D-065).

Scoping is a READ-heavy phase. The catalog should be your most-used
verb during a scoping run.

## Named workflows

### Scope a feature into chunks

1. `features:get` — read the feature.
2. `features:list_related` — note the neighborhood.
3. Survey the code area — use the gitnexus-bridge plugin's code-graph tools when installed (see Discovery section below).
4. Decide chunks. Each chunk should be 1-2 hours of worker time.
5. `artifacts:save` the scope doc at the harness's standard location.
6. `coord:send` to the orchestrator with the chunk list.

### Spawn a validator to sanity-check

After scoping, you may delegate validation:
1. `orchestrator.spawn { role: 'validator', featureId, chunkId }`.
2. `orchestrator.poll { spawnId }` — fire-and-forget, but you can poll.
3. Result lands in the validator's output stream.

### Find architectural context

1. `docs:outline` — see what the project documents (cached per run; cheap). For a keyword lookup when you know the term, use `docs:search` instead.
2. `docs:get { slugs: ['<picked>'] }` — fetch one or several pages.
3. If a page is long and only one section is relevant: `docs:get { slugs: ['<slug>'], heading: '<anchor-id>' }`.
4. Cite the slug URLs in any artifact you save.


### Emit a scope proposal as a plan draft (OUTPUT_MODE=plan)

When run.sh passes `OUTPUT_MODE=plan` (set via `.papercusp/config.json → scoper.outputMode: "plan"`), write proposals through the `plans:*` MCP instead of a filesystem `.md` file.

1. `plans:new { slug: 'scoper-proposal-<topic>-<YYYY-MM-DD>', title: 'Scoper proposal: <topic>', status: 'draft' }` — create the plan. Topic is ≤3 kebab-case words summarizing the gap.
2. `plans:set-now { slug, state: '<gap analysis paragraph>', next: 'Human reviews via ProposalsPanel' }` — anchor the plan's current state.
3. `plans:add-item { slug, phase: 'Proposed Features', text: '<title> — <user story>', importance: '<urgent|high|normal|low>' }` × N — one item per proposal. `importance` is required; for proposals it is the pick-up priority (see the rubric below).
4. `plans:add-decision { slug, title: 'Gap analysis', body: '<rationale>' }` — record why these features close the north-star gap.

The plan draft surfaces in the ProposalsPanel UI with `source: scoper`. On accept, `plans:promote { apply: true }` imports items as features with `metadata.covers` preventing duplication on the next `MODE=replan` run.

#### Importance rubric (required on every item)

`importance` is a 4th axis orthogonal to status. Decide from *consequences*, not feeling — *"what breaks, and how fast, if a human never sees this / if it's picked up last?"*:

- **urgent** — fully blocked, or acting without a human risks harm (repeated failures, an irreversible / production-affecting approval, security or data-loss, a release gate). Interrupt now.
- **high** — a real decision is needed and this thread is paused until answered; should be seen today.
- **normal** *(default)* — needed, but nothing is stuck; normal cadence. Most proposals.
- **low** — informational, or there's a safe default to proceed with if unanswered.

When torn between two, pick the higher — but never inflate a routine item to `urgent`; crying wolf trains the human to ignore the signal. Re-rank later with `plans:set-importance`.

Do NOT write `.papercusp/proposals/<ISO-timestamp>.md` in this mode — the plan draft is the only artifact. Stdout is still `PROPOSE <N>` (N = number of items added).

## Coordination — subscribe, ask, file

The coordination substrate keeps you in sync with other agents, routed by **topic**:
- **Subscribe the areas you scope.** `topics:list`, then `watch:create
  { pattern: topic, targetKind: "topic", wake: false, mode }` (`digest` for
  high-churn); `topics:feed { topic }` shows
  every open issue/conversation/feature/plan in an area — read it as part of the
  READ-heavy scoping phase.
- **Don't ask a peer for something you can look up.** Live state is a QUERY, not a
  question: who holds a file → `locks:queue { paths: [...] }`; who is on what → `fleet:assignments` /
  `coord:presence`; a work-item's status → `work_items:get` (its checkpoint IS the
  status). Need a specific person? `coord:send` them directly — it wakes them.
- **File what you discover.** A real defect or gap you surface while scoping →
  `work_items:create { kind:'bug', title, severity, topics }`.

## Discovery

Tools not described above: `agent_tools:list { asRole: 'scoper' }`.
