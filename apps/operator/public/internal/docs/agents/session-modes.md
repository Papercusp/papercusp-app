# Session modes — AUTO, COLD AUTO, IDEATE, DRAIN, GRADE
URL: /internal/docs/agents/session-modes

The owner-switchable standing modes an agent session runs under — official first-class state (mode:set / mode:get, presence-visible, audited), what each authorizes, the axis model, and how they compose.

An agent session runs under a set of **standing modes** the owner switches with
plain words. A mode is a session-wide grant — it carries across turns and topics
until explicitly turned off, the session ends, or the goal completes.

Since `modes-and-intake-ux-2026-07-05`, modes are **official first-class state**,
not prompt prose: the current mode set lives in `harness_shared.agent_modes`, is
**visible to peers** (`coord:presence` rows carry `modes`; `coord:orient` shows
your own), and every transition is **audited** (`agent_mode_changes`). The tools:

* **`mode:set { mode, reason, enabled?, agent?, ownerDirected? }`** — enter/exit a
  mode for yourself **or a peer**. A peer-set delivers the mandatory `reason` (plus
  the mode's full contract) to the target as a coord message, and takes effect at
  the target's **next turn boundary** (orient re-injects contracts each wake).
  `ownerDirected:true` (self-set only, on explicit owner instruction) arms the
  **owner-sticky guard**: a peer's attempt to override is refused and downgraded
  to a request.
* **`mode:get { agent?, contracts? }`** — anyone's current modes; **`mode:list`** —
  the catalog index.

## The axis model — what excludes, what stacks

The ONLY mutually-exclusive pair is the **autonomy** dial: **AUTO** vs **COLD
AUTO** (one dial, two positions — setting one auto-switches the other off, both
recorded in the audit). Everything else is an **overlay** that stacks freely:
IDEATE, DRAIN, and GRADE combine with the autonomy modes and **with each other**
— e.g. ideating on why a drain isn't working is a legitimate combination.

The **full binding contract** of each mode is data in the mode registry
(`packages/operator-core/lib/modes/registry.ts`) and is **injected at
activation** (mode:set returns it; coord:orient re-injects active contracts every
wake) — the always-present prompt carries only a one-line-per-mode index. Adding
a future mode costs one index line, not a prompt section.

## AUTO — "act, don't ask"

**On:** "AUTO mode", "run autonomously", "don't ask — use your judgment",
"just keep going". **Off:** "exit AUTO mode", "pause", "ask me first again".

AUTO suspends the default confirm-before-acting posture: the agent chooses the
route, passes approval gates on its own judgment, and **replaces every question
with a disclosure** — assumptions and deferrals are stated in the report, never
asked as menu check-ins ("want me to X or Y?" is banned). For open-ended
directives the agent arms an engine loop (`loop:arm`) so the work recurs across
turns instead of stopping to ask "what next?".

What still stops an AUTO session: nothing owner-shaped, except the genuinely
owner-walled actions (credentials, capital arming, category-1/irreversible
ops) and the one hard data rail — never destroying a **peer's** uncommitted
work (tree-wide destructive git ops on the shared checkout). Genuinely
unresolvable product-direction forks become disclosed assumptions, not pauses.

## IDEATE — "invent net-new, don't just patch"

**On:** "ideate mode", "brainstorm features", "think bigger". **Off:** "stop
ideating", "just fixes". Default OFF; orthogonal to AUTO.

IDEATE makes ambition part of the job: the agent runs deliberate ideation
passes — mining its own recent observations, `curation:state-of-pot`, rubric
freshness, and past graded proposals — and files net-new feature proposals via
`improvements:capture { kind:"feature" }`. No quality gate, no quota; blue-sky
is licensed. With AUTO also on, the strongest ideas get **built**, flag-ON and
disclosed, not just filed.

## DRAIN — "drive the queue to terminal"

**On:** "drain mode", "clear the backlog". Implies AUTO ON.

DRAIN sets the *objective*: take a work-item backlog and drive every item to a
terminal state (done / resolved / deprecated / needs\_human), usually by leading
a fleet. **Kickoff question (mandatory):** before draining, read the live
queue (`work_items:completion_stats` + a pile/age breakdown) and ask *which*
pile to drain, with concrete numbers from the data ("9 stale 'Loop iteration'
items, 2 canary items — a kind, a harness, oldest-first, or everything?") — do
not assume the whole backlog. Then the operating loop: triage + rank first ·
capacity preflight · canary launch, then the fleet · feed by claim-spec (never
hand-assignment) · a leader monitor loop each wake · wind down with a residue
report. Completion integrity outranks burn-down speed — nothing goes terminal
without evidence.

## COLD AUTO — AUTO across fresh-context wakes

**On:** "cold auto", a `loop:arm { carry:'cold' }` lifecycle. Same autonomy axis
as AUTO (never both).

Everything AUTO grants, carried across scheduled wakes with no human present and
**no transcript continuity** — each cold fire reconstructs from the carry-note
(`loop:checkpoint { did, left, insight, next }`) and per-item checkpoints. The
checkpoint layer IS the continuity; flushing it every wake is part of the mode's
contract, not optional hygiene.

## GRADE — rubric-graded monitoring

**On:** "grade mode", "monitor X and score it". An overlay; stacks with anything.

GRADE stands up monitoring of whatever the owner named on the rubric/scorecard
system: **reuse first** (`rubrics:search`; propose + ratify a new rubric only on
a real gap — proliferation is the failure mode), then a loop whose wakes gather
evidence → emit a complete scorecard (every criterion rated, with evidence) →
read `rubrics:trend`. Prefer deterministic evidence (SQL counters, freshness
checks) over per-wake LLM judgment: the cheapest grading is compute, not
inference. Cadence + exit criteria come from the owner at entry.

## How they compose

|                | AUTO off                                          | AUTO on                                              |
| -------------- | ------------------------------------------------- | ---------------------------------------------------- |
| **IDEATE off** | File observations; fixes wait for approval.       | Implement fixes/improvements you encountered.        |
| **IDEATE on**  | Run ideation passes; file proposals, don't build. | Run passes AND build the strongest ideas, disclosed. |

DRAIN layers the queue→terminal mission — and GRADE the scoring lens — on top of
whichever cell is active; overlays also combine with each other.

## Where the truth lives

The full binding contract of each mode lives in the **mode registry**
(`packages/operator-core/lib/modes/registry.ts`) and is injected at activation
(mode:set / coord:orient). The su playbook carries the one-line mode index plus
the offer/intake discipline; see
[prompt assembly](/internal/docs/agents/prompt-assembly) for how those reach a
live session, and the
[su-persona render + edit path](/internal/docs/agent-insights/su-persona-render-and-edit-path)
before editing them.
