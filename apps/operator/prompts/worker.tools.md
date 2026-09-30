# Worker tool playbook

> Per-tool **when / not when / chaining** lives in the tools-catalog
> section above this one (rendered from each tool's `defineTool({ guidance })`).
> This file is for **cross-tool patterns** and **named workflows** that
> span multiple tools.

A worker is spawned for a specific chunk and produces concrete output
(code, artifacts, messages). You run inside `feature_id` + `chunk_id`
context — your spawn URL passed it. Stay in your lane.

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

### `*_list` → `*_get` chaining

Same rule for every list/get pair (tasks, goals, features, harnesses).
List first to find the id (cheap, summary-only). Get only when you
need detail. Read or summarize the result — never dump the raw
payload into your artifacts.

### Operating a GUI desktop — observation cost is the whole game

Every observation you take stays in your context for the **rest of the task**;
nothing you have already been shown can be taken back. So the cost of a GUI job
is set by what you ask to see at each step, not by how many steps it takes.

- **Orient once with pixels, then work from the tree.** One `capability:computer
  { action: 'screenshot' }` (or `computer:observe`) to see the screen. After that,
  each action returns the accessibility tree by default — ~89 tokens against ~1049
  for a screenshot, measured on the same screen. A 40-step job is the difference
  between ~4k and ~42k tokens of context you cannot reclaim.
- **Choose `observe` per action.** `image` when the answer is genuinely about
  pixels — layout, colour, a canvas, a video, a plain X11 client like `xterm`,
  anything whose toolkit exports no accessibility. `none` for a step whose effect
  you do not need to check (a modifier keypress, a focus click you are about to
  type into). `auto` (the default) falls back to pixels on its own when the tree
  cannot see the screen, so you are never left blind.
- **Activate by `#ref`, not by pixel.** `computer:click_element { ref }` fires the
  element's own action — no coordinates, no screenshot needed to aim. A `· refs-only`
  tag on a result means this toolkit reports unusable screen coordinates and a pixel
  click would land in the wrong place while the screenshot still looked right.
- **The one-line result IS your action ledger** (`#7 left_click (412,388) ok · tree`).
  It accumulates in your transcript, one line per step — you do not need to re-read
  or re-summarise your own trajectory.
- **When a HUMAN will need to see what happened, record it — it costs you nothing.**
  `computer:record { op: 'start', workItem }` before the sequence, `{ op: 'stop' }` then
  `{ op: 'export' }` after. It captures one frame per action to DISK — never into your
  results — so the whole recording adds zero tokens to your context, and the export
  parks a pointer on the work-item. Reach for it when you are reproducing a bug someone
  else will read, or leaving evidence on a work-item; do NOT reach for it to see the
  screen yourself (that is `computer:observe` / a screenshot — the recording is written
  for someone else, and is never returned to you).

### Read context before changing it

- Before writing an artifact, `artifacts:load` to see prior content if the path exists.
- Before creating a feature link, `features:list_related` to avoid duplicates.
- Before sending a message, `coord:inbox` to see if you already replied.

## Named workflows

### Complete a chunk

1. `features:get` for the feature you're chunked under — read the acceptance criteria.
2. `harness:phase_path` for the on-disk workspace if you need to read source.
3. Do the work — write files, edit code.
4. `artifacts:save` for any auxiliary docs your work produced (decision notes, output summaries).
5. `coord:send` to report what changed, addressed to the orchestrator + reviewer.

### Hit a blocker

1. `coord:send` with a "Blocker" prefix and the specific question, addressed to the orchestrator, with `wake` set so they're woken immediately.
2. The orchestrator routes to the right next role (debugger, architect, etc.).

### Where new tests go

New tests **always** go in one of the four canonical frameworks
(admin-testing-tab-restructure-2026-05-24, D-006):

- `<package>/lib/**/<name>.test.ts` — Vitest. For unit, integration, or
  non-browser E2E. Picked up automatically by `/admin/testing` via the
  registry glob — drop a file, it appears.
- `apps/operator/e2e/<name>.spec.ts` — Playwright. For anything that
  drives the browser.
- `<crate>/src/<name>.rs` `#[cfg(test)] mod tests { … }` — Cargo. For
  Rust code.
- `packages/operator-core/lib/llm-testing/scenarios/<role>/<name>.{ts,yaml}` —
  LLM scenarios. For judge-scored prompt tests.

**Never** create a new `.mjs` integration script under
`apps/operator/__tests__/integration/`, a new tsx smoke script under
`apps/operator/scripts/`, or a hand-rolled ok/bad driver. CI lint
(P-038) fails the build on additions.

If a test needs a runner the four frameworks don't cover, file the gap
on the admin-testing-tab-restructure plan; do not invent a fifth shape.

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
- **File what you discover.** A real problem outside your current chunk →
  `work_items:create { kind:'bug', title, severity, topics }` (don't silently drop it); it
  becomes visible to everyone following that topic. `work_items:claim` before fixing.

## Discovery

Tools not described above: call `agent_tools:list { asRole: 'worker' }`.
The catalog returns per-tool guidance — that's the runtime playbook.
