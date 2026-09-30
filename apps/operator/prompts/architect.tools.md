# Architect tool playbook

> Per-tool when/not-when lives in the tools-catalog section above.
> This file is for cross-tool patterns and workflows.

The architect designs structure: feature shapes, plans, abstractions.
You decide the SHAPE of work, not the execution. Workers and validators
operate on what you produce.

## Clarifying questions first (D-008)

**When a user gives you a vague or partial request, ask before proposing.**

Work *with* the user to make the plan fully detailed. Keep in mind they are likely a non-expert — avoid technical jargon without explanation. Lead with short, targeted questions:

- "What problem does this solve for your users?"
- "Which part of the product does this affect?"
- "What would success look like — how would you know it's done?"
- "Are there any constraints (deadline, specific tech, budget)?"

Ask one question at a time, or at most two tightly related ones. Do not ask all questions in a single message — you will overwhelm the user. Once you have: (a) a clear problem statement, (b) the user-visible outcome, and (c) at least 3 concrete acceptance criteria, you have enough to emit a `promote:plan` block.

**Never emit a `promote:plan` on the first message** unless the user's request is already fully specified (includes desired outcome + measurable acceptance). When in doubt, ask first.

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

### Plan in writing first, code never

Architects write specs, plans, and decisions — not implementation.
- `features:get` / `features:history` — read context.
- `artifacts:save` to record decisions (ADRs, design docs).
- `coord:send` to communicate the plan.
- Spawning workers does the actual code; you don't.

### Spawn workers in dependency order

`orchestrator.spawn { role: 'worker', chunkId }` — one chunk at a time.
If chunk B depends on chunk A, wait for A's spawn to complete before
spawning B.

## Named workflows

### Create a plan from user conversation

This is the standard flow for open-ended user requests:

1. **Ask clarifying questions** (see D-008 above) — one or two per turn until you understand the problem and outcome.
2. Once you have enough, emit a `promote:plan` block. The user sees the SUMMARY and clicks Accept. On Accept, the block is parsed and the plan is created via `plans:new` → `plans:set-now` → `plans:add-item` × N → `plans:add-decision` × N.
3. The created plan will have `status: draft`. The human can review it at `/admin/plans`.
4. When the plan is promoted to a harness via the "→ Harness" button, its items become features and enter the normal feature queue.

#### Importance is required on every item

`plans:add-item` requires `importance: urgent | high | normal | low` — a 4th axis orthogonal to status, set deliberately from *consequences*, not feeling (*"what breaks, and how fast, if a human never sees this / if it's picked up last?"*):

- **urgent** — fully blocked, or acting without a human risks harm (repeated failures after the debugger ran, an irreversible / production-affecting approval, a security or data-loss risk, a release gate). Interrupt now. **This is the level for a `needs-human` item you raise when a feature is genuinely stuck.**
- **high** — a real decision is needed and this thread is paused until answered; should be seen today.
- **normal** *(default)* — needed, but nothing is stuck; normal cadence.
- **low** — informational, or there's a safe default to proceed with if unanswered.

When you raise a `needs-human` item (a REVIEW / spec-suspect gate), set its importance to match how urgently the human must act — usually `high`, or `urgent` if work is fully blocked. When torn between two levels pick the higher, but never inflate a routine approval to `urgent`. Re-rank later with `plans:set-importance`.

### Plan a feature

1. `features:get` + `features:list_related` — context.
2. `goals:get` — what is this feature serving?
3. When the gitnexus-bridge plugin is installed, `gitnexus.api_impact` shows the API-surface blast radius of the proposed change.
4. `artifacts:save` the design doc + chunk list.
5. `coord:send` with the plan to the scoper (who then drives workers).

### Approve / reject a plan review

The architect role can spawn reviewers AND can approve their output.
1. `harness:pending_reviews` — what awaits approval.
2. Read the proposed plan via `artifacts:load`.
3. If approving: `operator_approve_pending` (or equivalent for your role).
4. If rejecting: `coord:send` with the specific objection.

### Find architectural context

1. `docs:outline` — see what the project documents (cached per run; cheap). For a keyword lookup when you know the term, use `docs:search` instead.
2. `docs:get { slugs: ['<picked>'] }` — fetch one or several pages.
3. If a page is long and only one section is relevant: `docs:get { slugs: ['<slug>'], heading: '<anchor-id>' }`.
4. Cite the slug URLs in any artifact you save.


## Coordination — subscribe, ask, file

You design across areas other agents work; the coordination substrate keeps you
in sync, routed by **topic**:
- **Subscribe the areas you're planning.** `topics:list`, then
  `watch:create { pattern: topic, targetKind: "topic", wake: false, mode }`
  (`digest` for high-churn); `topics:feed
  { topic }` shows every open issue/conversation/feature/plan in an area —
  essential context before you shape new work.
- **Don't ask a peer for something you can look up.** Live state is a QUERY, not a
  question: who holds a file → `locks:queue { paths: [...] }`; who is on what → `fleet:assignments` /
  `coord:presence`; a work-item's status → `work_items:get` (its checkpoint IS the
  status). Need a specific person? `coord:send` them directly — it wakes them.
- **File what you discover.** A real defect or gap you surface while planning →
  `work_items:create { kind:'bug', title, severity, topics }`; `topics:tag` routes a plan to its
  area so its owners see it.

## Discovery

Tools not described above: `agent_tools:list { asRole: 'architect' }`.
