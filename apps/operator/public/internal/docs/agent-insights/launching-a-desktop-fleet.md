# Launching a desktop fleet — use fleet:launch-on-plan, never capability:terminal
URL: /internal/docs/agent-insights/launching-a-desktop-fleet

A desktop fleet has one plan-aware launcher: fleet:launch-on-plan. capability:terminal is command-only and refuses psu agent launches; capability:launch-agent owns ad-hoc, resume, fork, and lower-level agent lifecycle.

## TL;DR

To spawn a desktop fleet on a plan, call **`fleet:launch-on-plan { name, plan, count, agent }`**.
It is the purpose-built wrapper: it ensures the fleet (you become leader), opens N visible
member terminals through the shared console-spawn primitive, threads psu
**`--fleet=<slug>`** so each member JOINS the fleet, and seeds the **auto-kickoff** so each member
auto-STARTS on the plan. One call, no manual wake.

**Do NOT hand-roll `fleet:create` + `capability:terminal` + a `psu …` command.**
`capability:terminal` refuses actual `psu` agent launches before it opens a window. If the
work is an ad-hoc brief, resume, fork, or raw multi-agent launch, use
**`capability:launch-agent`** with its `fleet`, `plan`, `count`, and/or `members` fields. Keep
`fleet:launch-on-plan` for self-pulling plan fleets that need carry and claim-spec semantics.

## The trap: a command window is not an agent-launch fallback

`capability:terminal` is the arbitrary-command door. Its wrong-door guard classifies the
whole batch and refuses it before opening any window when even one command is an actual agent
launch. Passing `fleet` does not create an exception: it may choose a command window's colour,
but wrapping `psu` in this tool is not a supported agent-launch API.

Use the lifecycle-owning door instead:

* **N self-pulling agents on a plan** → `fleet:launch-on-plan`. If it rejects the plan or claim
  shape, fix that input; a command-door bypass would lose the carry/claim-spec contract.
* **Ad-hoc, resume, fork, or raw visible/headless agent launch** → `capability:launch-agent`.
  It accepts `fleet`, `plan`, `count`, and declarative `members` when those bindings are needed.
  (`carry` and `claimKinds` still belong to `fleet:launch-on-plan`.)

## Observability gotchas (why a healthy fleet looks broken)

* **`fleet:assignments` is CLAIM-primary.** A member that booted but hasn't claimed yet (or parked
  between turns) shows as **`agents: 0`** there. That is NOT a death. To answer "did my launch come
  up / is it alive", read **`coord:presence`** (the liveness view: `sessionState` live/parked/ended,
  `claimedItems`, `wakeable`) — not the claim view.
* **A member can boot and PARK without claiming** (auto-kickoff miss). It's in `coord:presence` but
  invisible to `fleet:assignments`. Fix = **wake it** (`coord:send wake:'required'`), do NOT
  relaunch a duplicate.
* **Closing a visible agent window does NOT prove the agent ended.** Supported agent-launch
  doors run the managed `psu` session independently of the outer terminal window. Verify a
  stand-down via `coord:presence`, not by closing or killing the window.
* **Long external work (a big download) ≠ a stalled agent.** A driver may background the job
  (`nohup … &`) and end its turn (parked). Check the actual work (the process / growing file), not
  just the agent's turn-state, before "recovering" it.
* **omp/ornith member identity collisions are FIXED (WI-1866, 2026-07-03).** Before this fix, every
  `omp`-backed session on the box shared ONE coord identity: omp (unlike `claude`'s
  `${PAPERCUSP_SID}` URL env-expansion) can't interpolate its own session id at MCP-connect time,
  so the user-level template baked a single per-machine `client=` — members' claims all attributed
  to one agent, void claim-conflict protection, and wakes black-holed into whichever transcript
  happened to be visible (live incident: sessions 9980–9982). `writeOmpSessionConfigDir` now also
  stamps a per-session `client=<ownerId>` param (`applyOmpMcpUrlParams`), so if you previously saw
  an omp fleet's members all appearing to act as a single agent, that symptom is resolved — don't
  diagnose it as a fleet-launch bug going forward. A companion fix (WI-1863) also indexes
  `adv-<advSessionId>` → ownerId in the session-owner registry, since omp launches have no native
  session UUID to key off (`nativeSessionIdFromLaunchArgs` returns null for them by design) and were
  previously unresolvable from a desktop `session-<N>` to their coord owner.

## Tool decision table

| Need                                                    | Tool                                                                                                              |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Desktop fleet on a plan (the default)                   | **`fleet:launch-on-plan`** (auto-join + auto-start)                                                               |
| Register a fleet, no terminals                          | `fleet:create`                                                                                                    |
| Visible arbitrary-command window(s), no agent lifecycle | `capability:terminal` (`fleet` only selects the command window's scheme)                                          |
| Headless workers (no desktop window)                    | **`fleet:launch-on-plan { headless: true }`** — ~~`cup:spawn` / `fleet:place_batch`~~ REFUSE (retired 2026-08-09) |

Headless is a knob on the fleet, not a different tier: `fleet:launch-on-plan { headless: true }`
opens leader-led su MEMBERS with no desktop window. `cup:spawn` / `fleet:place_batch` used to be
the headless route — they spawned Mug-supervised nursery cups, and both **refuse** now that the
Mug · Kettle · Cup tier is
[retired](/internal/docs/agent-insights/mug-kettle-cup-tier-is-retired). Neither was ever right
for a "desktop fleet."

## Members default to YOUR backend/model when you omit `agent` (2026-07-03)

If you omit `agent` (and `model`), members no longer hard-default to `claude` — they inherit the
**calling session's own backend + model** (`resolveFleetAgent` in `launch-on-plan.ts`). psu stamps
the caller's resolved `agent`/`model` onto its own `/api/mcp` URL in the per-session `mcp.json`
(`writeOmpSessionConfigDir` / `applyOmpMcpUrlParams` in `psu-launcher.mjs`); the operator reads
those as `ctx.callerAgent` / `ctx.callerModel` when resolving each member's backend. So an
**omp/ornith `su` leader that calls `fleet:launch-on-plan` without `agent` now spawns `omp`
members** (previously always `claude`) — and inherits the caller's `model` too, but only when the
backend was ALSO inherited (an explicit `agent` never picks up the caller's model, so a claude
member is never silently handed an ornith model id).

Precedence, in order: explicit `args.agent` → `omp` (inferred when `model` is a local/ollama id,
e.g. `ollama-cc/…ornith`) → the caller's own backend → `claude` (last-resort fallback). An explicit
`claude`/`codex` `agent` paired with a local/ollama `model` is now a hard error (previously silently
launched `claude` mislabelled with the ornith model — the "thought ornith, got claude" trap). Set
`agent` explicitly whenever you want a fleet backend that differs from your own session's.

## Becoming a leader now hard-enters AUTO mode (2026-07-03)

A `fleet:launch-on-plan` call that creates/joins a fleet and makes the caller its **leader** now
appends `LEADER_AUTO_MODE_DIRECTIVE` to the launch result, on top of the existing numbered
`LEADER_STANDING_JOB` cycle list: *"LEADING THIS FLEET PUTS YOU IN AUTO MODE — effective NOW, for
the rest of your session… do not stop to ask permission between steps, and NEVER end a turn
waiting for an instruction while your fleet is live."* This lands the existing "leading a fleet
auto-enters AUTO mode" persona rule at the exact moment the caller becomes a leader (a live
finding, 2026-07-03: an ornith leader stayed at its ask-first routing-gate posture after this same
call and only supervised once externally woken — a persona clause alone was too far from the act
for a weaker model to bind). The launch result also now carries a structured
`autoModeEntered: true` field (set whenever `opened.length > 0`) so a hook/scorer can key off it
without parsing prose.
