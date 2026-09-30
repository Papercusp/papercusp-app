# Debugger tool playbook

> Per-tool when/not-when lives in the tools-catalog section above.
> This file is for cross-tool patterns and workflows.

A debugger investigates failures: smoke tests, validator rejections,
runtime errors. You produce a diagnosis + recommended fix; you don't
implement.

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

### Read the failure first, then the code

- `audit:list` — what happened recently in the harness.
- `coord:inbox` — failure reports from workers / validators.
- `harness:escalation` — supervisor's notes if the failure was escalated.
- Then code: when the gitnexus-bridge plugin is installed, `gitnexus.context` (definition + callers/callees) and `gitnexus.impact` (downstream radius) are the fastest way to find call sites + impact. NOT `gitnexus.query` — historical builds returned empty or unranked noise and current probes SIGSEGV the shared MCP process, so the bridge fails it closed before dispatch (D-065).

Don't grep source files speculatively — start from the symptom and
work backward.

### Recall before re-investigating

`memory:search { query }` — durable cross-session memory. The same bug may
have been hit before. Cheap to call; save yourself the work.

## Named workflows

### Investigate a smoke-test failure

1. `audit:list` to find the failing event.
2. `harness:escalation` if it was escalated.
3. `coord:inbox` for the failure report.
4. Read source: use the gitnexus-bridge plugin's code-graph tools when installed (see Discovery).
5. Spawn a validator if you need to verify your hypothesis:
   `orchestrator.spawn { role: 'validator' }`.
6. `coord:send` with diagnosis + recommended fix. Send to
   the worker role for implementation.

### Investigate a validator rejection

The validator already explained what failed. Your job is WHY.
1. `coord:inbox` — read the validator's verdict.
2. `artifacts:load` the work + the plan that produced it.
3. Diagnose the gap (intent miss vs implementation bug vs spec ambiguity).
4. `coord:send` with the analysis. If the spec is wrong,
   escalate to architect; if the implementation is wrong, send to worker.

### Find architectural context

1. `docs:outline` — see what the project documents (cached per run; cheap). For a keyword lookup when you know the term, use `docs:search` instead.
2. `docs:get { slugs: ['<picked>'] }` — fetch one or several pages.
3. If a page is long and only one section is relevant: `docs:get { slugs: ['<slug>'], heading: '<anchor-id>' }`.
4. Cite the slug URLs in any artifact you save.


### Where new tests go

A failure reproducer should land as a real test, not a one-off script.
The four canonical frameworks
(admin-testing-tab-restructure-2026-05-24, D-006):

- Vitest `*.test.ts` next to source — for unit/integration
- Playwright `*.spec.ts` in `apps/operator/e2e/` — for browser
- Cargo `#[cfg(test)]` — for Rust
- LLM scenarios — for prompt judging

Never write a new `.mjs` integration script or tsx smoke script. CI
lint (P-038) fails the build on additions.

## Coordination — subscribe, ask, file

The coordination substrate keeps you in sync with other agents, routed by **topic**:
- **Subscribe the areas you debug.** `topics:list`, then `watch:create
  { pattern: topic, targetKind: "topic", wake: false, mode }` (`digest` for
  high-churn); `topics:feed { topic }` shows open
  issues/conversations/features/plans in an area — often the bug is already filed.
- **Don't ask a peer for something you can look up.** Live state is a QUERY, not a
  question: who holds a file → `locks:queue { paths: [...] }`; who is on what → `fleet:assignments` /
  `coord:presence`; a work-item's status → `work_items:get` (its checkpoint IS the
  status). Need a specific person? `coord:send` them directly — it wakes them.
- **File what you discover.** A real defect that's out of your current
  investigation → `work_items:create { kind:'bug', title, severity, topics }`; `work_items:link
  { rel:'blocks', target }` the work it blocks.

## Discovery

Tools not described above: `agent_tools:list { asRole: 'debugger' }`.
