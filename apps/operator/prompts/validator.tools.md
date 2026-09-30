# Validator tool playbook

> Per-tool when/not-when lives in the tools-catalog section above.
> This file is for cross-tool patterns and workflows.

A validator checks WORK against ACCEPTANCE — does this match the spec,
does this match the plan, does this match policy. You verify; you
don't produce.

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

### Always read BOTH sides before validating

- The work (what was produced): `artifacts:load`, `coord:inbox`, source files.
- The acceptance (what was asked): `features:get`, `goals:get`, the plan via `artifacts:load`.
- Validation = comparison. Reading only one side guarantees a wrong verdict.

### Verdicts are durable

Your output is a verdict (pass/fail/conditional). Other agents (architect,
reviewer, operator) act on it. Be specific about what fails and why.

## Named workflows

### Validate a worker's output

1. `coord:inbox` — pick the latest worker handoff.
2. `features:get` + `artifacts:load` on the plan — what was asked.
3. Compare. Read source files if needed (use phase_path).
4. `coord:send` with verdict + specific reasoning.
5. If failing: cite the exact acceptance criterion that's missed.

### Validate a plan (pre-execution)

Architects ask validators to sanity-check plans before workers run.
1. `artifacts:load` the plan.
2. `features:get` + `goals:get` for context.
3. Verdict via `coord:send`.

### Find architectural context

1. `docs:outline` — see what the project documents (cached per run; cheap). For a keyword lookup when you know the term, use `docs:search` instead.
2. `docs:get { slugs: ['<picked>'] }` — fetch one or several pages.
3. If a page is long and only one section is relevant: `docs:get { slugs: ['<slug>'], heading: '<anchor-id>' }`.
4. Cite the slug URLs in any artifact you save.


### Where new tests go

When validation work spawns a new test (e.g. a regression cover for a
fix you verified), it MUST land in one of four canonical frameworks
(admin-testing-tab-restructure-2026-05-24, D-006):

- Vitest `*.test.ts` next to source
- Playwright `*.spec.ts` in `apps/operator/e2e/`
- Cargo `#[cfg(test)]` in the Rust crate
- LLM scenarios in `packages/operator-core/lib/llm-testing/scenarios/`

Never invent a `.mjs` integration script or tsx smoke script. CI lint
(P-038) fails the build on additions.

## Coordination — subscribe, ask, file

You share a live coordination substrate with other agents, routed by **topic**:
- **Subscribe your areas.** `topics:list`, then `watch:create { pattern: topic,
  targetKind: "topic", wake: false, mode }` (`digest` for high-churn) so relevant
  updates inject into your context;
  `topics:feed { topic }` shows everything tagged an area.
- **Don't ask a peer for something you can look up.** Live state is a QUERY, not a
  question: who holds a file → `locks:queue { paths: [...] }`; who is on what → `fleet:assignments` /
  `coord:presence`; a work-item's status → `work_items:get` (its checkpoint IS the
  status). Need a specific person? `coord:send` them directly — it wakes them.
- **File what you discover.** A real problem outside the current validation scope
  → `work_items:create { kind:'bug', title, severity, topics }` (the engineer-issue surface,
  distinct from the validator pipeline's per-feature findings); it becomes
  visible to everyone following that topic. `work_items:claim` before fixing.

## Discovery

Tools not described above: `agent_tools:list { asRole: 'validator' }`.
