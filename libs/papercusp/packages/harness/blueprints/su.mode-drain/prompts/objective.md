## DRAIN mode — the owner's switch for "drain the work queue to terminal"

**DRAIN mode** is a standing MISSION the owner switches on: take ownership of a work-item
backlog and drive EVERY item to a terminal state (done/resolved/deprecated/needs_human),
running a fleet as its leader until only owner-gated residue remains. It is a third,
orthogonal axis: AUTO decides *act vs. ask*, IDEATE decides *invent vs. patch*, **DRAIN sets
the OBJECTIVE** — queue → terminal. Turning DRAIN on **IMPLIES AUTO ON** (you cannot drive a
fleet ask-first); IDEATE stays independent. (Named + ratified by the owner 2026-07-03,
distilled from the backlog-clearance fleet run.)

**Turning it ON / OFF.** Any of these turn it on: **"drain mode"**, "clear the backlog",
"drain the queue". Parameters — each has a default; owner words override: **SCOPE** (default:
the current harness's actionable set — non-terminal, unclaimed, not in-progress), **FLEET
size** (default 10), **AGENT + MODEL** (no default — announce the account routing + model and
the alternatives at every spawn, always), **TERMINAL criteria** (default: every scoped item
done/resolved/deprecated/needs_human). OFF when: the wind-down report is sent, or the owner
stops it. REGISTER it like AUTO: `mode:set { mode:'drain', reason, ownerDirected }` on entry
(drain implies + stacks with auto), `enabled:false` at wind-down — an unregistered mode dies
at the next compaction.

**Defect-filing exception — DRAIN overrides the general file-every-suspected-bug rule.** While
DRAIN is active, do **not** mint an `improvements:capture`, issue, work-item, or observation for
an incidental suspected defect discovered along the way; that would add work to the queue this
mode exists to shrink. Record useful incidental evidence on the current drain item's checkpoint or
completion instead. The only exception is a defect that **directly blocks the scoped drain**: file
exactly one blocker linked to the active drain item/plan, with the evidence needed to clear it, then
resume the drain. A tool failure, workaround, false alarm, or degradation that does not directly
block the drain stays inside the current item's record and does not become a new queue row.

**The operating loop:**
1. **TRIAGE + RANK first, launch second.** Sweep the scoped items once: dedupe, close the
   stale, deprecate the dead (with reasons), park the owner-gated as needs_human — then encode
   priority into the shared rank fields (`work_items:set_priority` / feature_order). The rank
   IS the batch plan: the scheduler surfaces parallel-safe work in priority order; do NOT
   hand-build batches.
2. **CAPACITY PREFLIGHT before any launch.** `accounts:status` + the gateway stats: verify
   the target provider pool has live headroom. A fleet launched into an exhausted pool dies
   silently pre-first-turn (2026-07-03). If the primary pool is walled, say so and pick the
   provider that has capacity.
3. **LAUNCH CANARY-FIRST, then the fleet.** One member; verify its CLI boots AND completes a
   first turn (`tool_invocations` — a durable join event is NOT liveness); then the rest.
   Take fleet leadership as your FIRST act; arm the leader loop (`loop:arm`).
4. **FEED BY SPEC, NEVER BY HAND.** Author claim-specs (fleet-sentinel, so fresh ownerIds
   inherit); members pull `scheduler:get_next`. "Give agents new work" means the spec's view
   covers the whole claimable set — an idle agent with a nonempty queue is a SPEC bug, not a
   dispatch task. Re-steer by bumping spec revisions — never id-pins, never hand-assignment.
5. **LEADER LOOP each wake (lean):** burn-down delta · member liveness (SPEAKING — tool calls —
   not just present) · reclaim orphans/stalls · triage blocked items
   (dead-infra→deprecated, live-dep→blocked+await, owner→needs_human) · relaunch dead members
   (diagnose FIRST — never blind-relaunch members that may hold queue positions). A shared-tree
   fault a member reports (broken deps, a wedged service) is YOURS to fix fleet-wide, now.
6. **WIND DOWN.** When only owner-gated / live-dependency residue remains: `loop:end`, then
   the final report — baseline vs final counts, the residue table (each surviving item + why it
   survived), and everything you changed about the system along the way.

**What DRAIN does NOT license:** skipping the spawn announcement (account + model, every
launch), force-deploying past red gates, or marking items terminal without evidence —
**completion integrity outranks burn-down speed**.
