# Agent-activity truth: a claim is not progress — who's-doing-what is a LIVE derived signal
URL: /internal/docs/agent-insights/agent-activity-truth

The durable fix for 'agents are wrong about what other agents are doing'. A claim is a RESERVATION and a heartbeat proves the PROCESS is alive — NEITHER proves the WORK is advancing, and a coord broadcast outlives the work. The incident: a gate-fix cup DIED but its 'spawned for X' broadcast was read as 'actively worked' by the Mug + idle agents + the coordinator for ~1h, so the reds sat owned-but-unworked and blocked every deploy. The fix: a third signal (last_progress_at) + a reconciled fleet_assignment view (orphaned = dead holder, stalled = live-but-not-progressing) + the whoIsDoingWhat resolver + a flag-gated reconciler that auto-frees dead/stalled claims + immediate spawn-death release + the stalled-claim watchdog. Read the live signal, never the announcement.

## The incident (2026-06-21)

The Mug spawned a cup to fix two green-gate reds. The cup **died** seconds after
spawn (`fleet:assignments` for it → 0 agents / 0 claims). But every reader — the
Mug's placement, idle su agents, and the coordinator itself — kept reading the
Mug's "**cup spawned for these reds**" coord broadcast as "being actively
worked." So the gate sat **RED and unowned for \~1 hour**, blocking ALL deploys. No
one picked up the reds because everyone believed they were covered.

Same class as the orphaned **WI-291** (live lease, dead holder), **EI-2311**
(re-dispatch-of-dead-holder doesn't check already-resolved), and the loop that
re-assigned items to dead holders.

## Root cause: a claim is not progress, and an announcement outlives the work

"What others are doing" was answered from **stale announcements + claims that are
never reconciled against (a) the holder's liveness and (b) actual PROGRESS**.

* A **claim** (`taken_by`) is a RESERVATION.
* A **presence/nursery heartbeat** proves the PROCESS is alive.
* A **coord broadcast** ("spawned for X") has **no expiry** — it outlives the
  claim, the work, even the agent.

None of these proves the WORK is advancing. The missing third signal was
**last\_progress\_at** — a timestamp bumped only on REAL item-scoped work.

## The fix — one reconciled truth every reader derives from

1. **The progress signal** (`last_progress_at` on `harness_features_consolidated`,
   migration 357). Bumped ONLY on genuine item-scoped work — a `setWorkItemState`
   transition (the bump is folded into its UPDATE) or a `checkpoint` write
   (`markFeatureProgress`). NEVER on a bare presence heartbeat or a lease keepalive
   (`work_item_claims.last_activity_ts` already conflates those — this column stays
   clean).

2. **The classifier** (`item-activity.ts` `classifyItemActivity`) — a pure leaf
   deriving `free | reserved | alive | progressing | stalled | dead` from
   `(taken_by, taken_at, last_progress_at, holderAlive)`. **"Actively worked" ≡
   `progressing` only** (a live holder making real progress in the window).

3. **The reconciled read** (migration 358) — the `work_items` view projects
   `last_progress_at`, and `fleet_assignment` gains a **`stalled`** column
   (live lease, ALIVE holder, no progress in the 10-min window) ALONGSIDE the
   existing **`orphaned`** (live lease, DEAD holder). Both mean **NOT covered** and
   **reclaimable**; they're mutually exclusive. The SQL window mirrors `STALE_MS`
   so the view and the classifier can't drift.

4. **The single resolver** (`fleet/assignments.ts` `whoIsDoingWhat(workItemId)`)
   — the one per-item truth: is it actively worked, by whom, and is it reclaimable?
   `fleet:assignments` surfaces both `orphaned` and `stalled` lists + per-claim
   `activity`; `deriveActivity` projects the label from the view's booleans.

5. **The reconciler** (`reclaimStaleWorkItemClaims`) — frees + requeues a claim
   whose holder is **DEAD** (past grace), **a CONFIRMED-terminal spawn** (immediate,
   NO grace — spawn-death → release, the direct cure for the incident's lag), or
   **STALLED** (alive but not progressing — **flag-gated** behind `RECLAIM_STALLED`,
   default OFF, because it frees a live agent's claim).

6. **The recurrence guard** — the `stalled-claim` watchdog collector fires a loud
   aggregate signal when a live holder sits on a non-progressing claim, so stalled
   work is visible even while the reconciler's stalled leg is dark. Plus the
   `item-activity` + reconciler integration tests.

## What this means for you (the behavioural half)

* To answer "**is X being worked / who's on plan P / what is agent Y doing**", READ
  THE LIVE RECONCILED STATE via **`fleet:assignments`** (or `whoIsDoingWhat`). Do
  NOT re-derive coverage from a `coord:inbox` message or something you remember.
* `orphaned` (dead holder) and `stalled` (live holder, no progress) both mean
  **pickable**. A claim by a dead-or-stalled holder is yours to take — the
  reconciler frees it, and you should treat it as free even before it does.
* Keep YOUR work legible the same way: set work-item state / checkpoint as you go
  so your `last_progress_at` advances and peers reading the live signal see the
  truth. Don't rely on a one-time broadcast to keep a lane "owned."

The durable fix makes the QUERY truthful so you needn't hand-verify; the prompt
clause (`AGENT_ACTIVITY_TRUTH_NOTE`, shared across every role) reinforces "trust
the live signal, not the announcement."

## The corollary: a HANDOFF is not a pickup, and `woken:0` is a miss (2026-06-26)

The same class re-surfaced from the OTHER direction — not "I read a stale broadcast"
but "I made a stale read and then handed work to a ghost." An interactive `su`
session needed a `:3070` deploy driven. It read the fleet ONCE at session start,
saw `su-559a4885` `alive:true` with intent "hardening the gate," and then **carried
that snapshot \~13h** while asserting "they're actively on it." By the time it
`coord:send`'d the deploy to that agent, the agent had **ended hours earlier**. The
send used `wake:'optimistic'` and came back `woken:0` — which was read as "fine, a
backstop will get it." There was no backstop. The deploy was queued for a ghost.

Two failures, both avoidable with signals that ALREADY existed:

1. **Declared intent ≠ progress, and a snapshot decays.** `coord:presence` already
   exposes `lastActiveSecAgo`, `sessionState` (live | parked | **ended**), and
   `intentStale` right next to `intent`; `fleet:assignments` carries `holderAlive`
   next to `holderIntent`. Re-READ the live signal at the moment you rely on it — a
   13h-old "alive" is not "alive now." `fleet:assignments { agent }` returning **0
   rows** is the loudest possible "not on it." As of **2026-07-07**
   (`fleet-liveness-zombie-await`) the live signal itself force-ends a decayed holder:
   `reconcileWakeability` (`agent-tools/fleet/assignments.ts`) runs `isHardStale` and
   pins any holder whose heartbeat is cold beyond the 30-min DEAD ceiling
   (`PRESENCE_DEAD_MS`, `presence-wakeability.ts`) to `sessionState:'ended'` /
   `holderAlive:false` — **even if a lingering wake-await from an abrupt death
   (reboot/OOM/SIGKILL) would otherwise make it read `parked`/wakeable**. So an
   hour-cold "alive" no longer masquerades as a live member (the invisible-dead-fleet
   twin of this doc's root cause); see
   [coordinator-dispatch-and-wake](/agent-insights/coordinator-dispatch-and-wake) for
   the full DEAD-ceiling model.

2. **`woken:0` is a MISS, not a note — and `optimistic` hides it on purpose.**
   `coord:send` is honest by mode: `wake:'required'` escalates a miss to
   `recipient_absent` / `recipient_dead` with a loud note; a plain inject reports
   `notWoken`. But **`wake:'optimistic'` is SILENT on a miss by design** (it assumes
   a durable backstop re-dispatches) — it still returns `woken:0`, but no escalation.
   So `optimistic` is ONLY safe when something (the Mug survey, a sweep) will
   re-dispatch. For a one-off transfer to a specific agent it is the WRONG mode.

### Use the right tool for a transfer

A work/ownership **transfer** (you're done; a named agent picks up) is `coord:handoff`,
not `coord:send`. Handoff has the **lifecycle** a message lacks: an `open → accepted |
expired | repinged` state, an accept→wake-back loop, a reconcile sweep that auto-re-pings
at \~30m and expires at \~12h, and (like `wake:'required'`) a loud `recipient_absent` when
it wakes nobody. `coord:send` is for messages; it has no pickup lifecycle. If you DO use
`coord:send` to hand off, use `wake:'required'` and confirm `woken ≥ 1` — never
`optimistic` to a ghost.

### The forcing functions (so it can't just be ignored next time)

Guidance alone failed once (the signals existed and were rationalized away), so the
miss is now structurally hard to swallow:

* **FF#1 — `optimistic` silence must be CLAIMED.** `coord:send wake:'optimistic'` is
  silent-on-miss ONLY when you pass `backstop:'<what re-dispatches>'`. WITHOUT a
  declared backstop, an optimistic miss is reported as loudly as a required miss
  (`recipient_absent`). You can no longer silently hand work to a dead agent by
  reaching for the quiet mode.
* **FF#2 — a handoff is PENDING, not done.** `coord:handoff` open returns
  `accepted:false` / `pending_acceptance:true`, classifies dead recipients
  (`recipient_dead`), and is closed only by an acceptance (or the \~30m re-ping / 12h
  expiry sweep). A successful OPEN is never a successful TRANSFER.
* **FF#3 — the fresh liveness is forced into the result.** On any miss, both tools
  attach `recipient_liveness: [{ ownerId, sessionState, wakeable }]` — the missed
  addressee's CURRENT state, freshly read at the transfer moment
  (`recipient-liveness.ts` → `fetchWakeability`/`deriveSessionState`). A transfer to a
  long-ended agent reads `sessionState:'ended'` right in the answer, not a silent
  `woken:0`.

Rule of thumb: **after any handoff/wake, look at the count.** `woken ≥ 1` = a live
session was re-invoked. `woken:0` / `recipient_absent` / `recipient_dead` /
`recipient_liveness:[…ended]` = MISSED → re-dispatch to a LIVE agent
(`coord:presence → wakeable:true`) or respawn the owner. "I handed it off" only counts
if a live owner received it.

## The third corollary: a broadcast to zero live recipients is a silent no-op (EI-6874, 2026-07-02)

Same root cause, a third surface: **`coord:send` to an AUDIENCE SELECTOR** (not a
concrete `to`) can resolve to **zero live recipients** and, before this fix, said
nothing about it — `ok:true`, no count, no warning. Fleet `p2p-dist`'s leader
(`su-3700b`) sent a drain order to `@fleet:p2p-dist`; all 4 members had been
launched **without fleet registration** (`fleetSlug:null` — the EI-5835 `--fleet`
trap), so the audience resolved to **zero** live members. The leader believed the
order went out and sat **\~3h "awaiting compliance acks"** that could never arrive,
while the (unregistered) members kept working through what should have been a
pause.

This is the send-side twin of the handoff corollary above: there, a wake looked
delivered but the recipient was dead; here, a *broadcast* looked delivered but the
audience was empty. Both are "an announcement that outlived (or never reached) the
work" — exactly what this doc's root cause names.

**The fix (`packages/operator-core/lib/agent-tools/coordination/tools/send.ts`):**

* Every send to a **live-audience selector** (`@fleet:`, `@fleet-leader:`,
  `@topic:`, `@plan:`, `@object:`, `@file:` — resolved against who's live *now*,
  unlike a **slot** selector like `@role:`/`@wave:`/`@feature:`/`@user:`, which
  legitimately parks for a future agent and is excluded from this check) now
  reports **`recipients_resolved`** — how many live recipients the audience
  actually expanded to, every time, not just on a miss.
* An **explicit** audience selector that resolves to **zero** live recipients is
  now a **hard refusal** (`ok:false`, `error:'zero_recipients'`) — the row still
  persists to audience history (a later joiner still catches up via
  `coord:catch-up`), but the send is NOT silently `ok:true`.
* An **auto-scoped** `'*' → @fleet:<slug>` broadcast (a bare `to:['*']` from a
  fleeted sender, down-scoped per `fleet-scoped-broadcast-default`) that resolves
  to zero stays a **soft warning** (`ok:true` + `zero_recipients`) — the sender
  intended a plain broadcast, not a targeted directive, so a solo/quiet fleet
  isn't a hard error.
* A fleet-selector zero-hit result names the likely cause inline: verify each
  member's presence row actually carries `fleetSlug` (`coord:roster`) — an
  unregistered launch is the EI-5835 trap that caused this incident — or address
  the members by `ownerId` directly.

**What this means for you:** the same rule as the rest of this doc — **read the
result, not your assumption.** After sending to any audience selector, check
`recipients_resolved`; a `zero_recipients` warning (or the hard refusal) means
nobody live got it, full stop — don't sit "awaiting compliance" on a broadcast
that never left the building.

## The fourth corollary: on a FEDERATED pot, "never seen here" is not "dead" (WI-1999, 2026-07-03)

The reconciler itself (§5, `reclaimStaleWorkItemClaims` /
`reclaimStaleIssueClaims`, `work-items-stale-claims.ts`) had its own instance of
this same root cause, on the DEAD leg specifically. `work_items`/`engineer_issues`
rows **federate** across a shared pot's member nodes, but `coord_presence` (and
`spawned_agents`) are **local-by-design** — a holder alive on a peer node is
simply invisible to this node's liveness table. The DEAD leg used to conclude
"not in `live_holder`" ⇒ dead and reap it — which is correct for a holder this
node has ever *seen* go stale-then-silent, but wrong for a holder this node has
**never seen at all**: absence-from-fresh-presence and absence-from-ever-seen are
different claims, and only the first means "not alive **here**." Live incident
(2026-07-03): a mac-VM's sweep shredded a live tower holder's claims — dead-
lettering an actively-driven item 5×, requeuing another 5× — because the tower's
alias never had a `coord_presence` row on the mac-VM node.

**The fix:** a `known_holder` fragment (`knownHolderFragment`, shared by both
reapers) — every alias this node has **ever** recorded in `coord_presence` or
`spawned_agents`, regardless of freshness. The DEAD leg now reaps a claim only if
its holder is in `known_holder` (genuinely presumed dead) **or** the claim is old
enough to hit a long-horizon fallback —
`STALE_CLAIM_UNKNOWN_HOLDER_FALLBACK_MS` (24h) — measured from `taken_at`
(or `updated_ts` for a NULL-anchor claim, since an actively-federated remote
item keeps refreshing `updated_ts`). A never-seen-here holder is therefore
**not** reclaimed on the normal \~10-minute grace window; it is presumed
possibly-remote-and-alive until the 24h fallback lapses, at which point it frees
regardless (so a genuinely abandoned row still doesn't leak forever).

**What this means for you:** don't be surprised if a stale-looking claim
(`taken_by` some alias `fleet:assignments`/`coord:presence` on THIS node has
never heard of) survives well past the usual \~10-minute stale-claim grace — that
is the federation guard working as intended, not a bug. If you need to confirm a
claim is truly abandoned rather than live-on-another-node, check the pot's other
member nodes (or wait out the 24h fallback) before assuming it's free.

## The fifth corollary: `last_progress_at` was hardcoded null for issue-family, so every held bug/change/task claim read "stalled" (WI-2990/WI-3006, 2026-07-05)

The progress signal from §1 (`last_progress_at`) shipped on migration 357 for
**feature-family** work-items only. `issueToWorkItem()`
(`work-items.ts`) — the DTO that projects an `engineer_issues` row onto the
unified `WorkItem` shape `classifyItemActivity` reads — hardcoded
`takenAt: null, lastProgressAt: null` for **every** issue-family (bug/change/task)
row, on the stale pre-unification assumption that issue-family had no
claim-time/progress columns. It does: the base `work_items` table has carried
`taken_at`/`last_progress_at` for issue-family rows since migration 374, correctly
populated on claim — the DTO just never surfaced them.

The effect: `classifyItemActivity` returns `'stalled'` (age = `Infinity`) whenever
`takenBy` is set but `takenAt`/`lastProgressAt` read null — so **every claimed
issue-family item, however freshly and actively worked, classified as
immediately reclaimable**. `fleet:assignments`' `reclaimable` field (and any
leader census / Mug placement reading it) saw a just-claimed bug/change as
free, risking a near-double-placement.

**The fix** (migration 509 + `work-items.ts` / `issues-engineer.ts` /
`checkpoint.ts`): `issueToWorkItem()` now projects the real
`i.takenAt`/`i.lastProgressAt` columns, and a new `markIssueProgress()` (exported
alongside `markFeatureProgress` from `work-items.ts`) bumps issue-family
`last_progress_at` on a checkpoint — the issue-family analog of §1's feature-only
bump. The base-table reaper (`reclaimStaleIssueClaims`,
`work-items-stale-claims.ts`) was unaffected throughout (it always read
`assigned_at` directly via SQL, never through this DTO) — this was purely a
reporting-fidelity bug in what `classifyItemActivity` saw, not a reaper bug.

**What this means for you:** the "actively worked ≡ `progressing`" rule from §2
now holds uniformly across feature AND issue-family claims — checkpoint your
issue-family work (`work_items:checkpoint`) the same way you would a feature, so
its `last_progress_at` advances and it reads correctly as covered.

## The sixth corollary: the reconciler was one-directional — a just-launched holder read as orphaned too (EI-8106, 2026-07-09)

`listFleetAssignments` (`fleet/assignments.ts`) already reconciled the view in
one direction: `downgradeEndedHolders` catches a holder the view still believes
`alive` whose `adv_sessions` row has since **ended** (§5's dead-holder fix). But
the SAME view can be wrong in the OTHER direction too, on a fresh agent's
**launch/bootstrap window**: `adv_sessions` can authoritatively record a session
as LIVE before that session has registered coord presence or an inbox-wake await
— so a heartbeat-only read sees no presence row yet and marks its just-taken
claim `orphaned`, even though the holder is alive and about to start working.

**The fix:** a new `upgradeRecordedLiveHolders` runs alongside
`downgradeEndedHolders` on every `listFleetAssignments` read. For any row whose
`agentId` appears in `recordedLiveOwnerIds` (a fresh, positive-evidence read of
`adv_sessions`) and is NOT in the ended set, it forces `holderPresent`/
`holderAlive` true and — for an active claim — clears `orphaned`. Both reads
(`endedRecordedOwnerIds`, `recordedLiveOwnerIds`) now run in parallel over every
row's `agentId`, not just the ones the view currently believes alive, so a
just-launched holder that hasn't yet shown up in presence is no longer
misread as dead-and-reclaimable during its own bootstrap.

**What this means for you:** the same rule as the rest of this doc, from the
opposite direction — a claim that reads `orphaned` immediately after a fresh
spawn is not automatically free; `fleet:assignments` now folds the session log
both ways (ended → force-dead, recorded-live → force-alive) before you decide.
If you still see a claim reading orphaned for a holder you know just launched,
suspect a genuinely dead spawn (never reached `adv_sessions`) rather than
assuming this reconciliation gap.

## The seventh corollary: a genuinely-completed item can still read as free if `status` was never flipped (EI-8972, 2026-07-09)

A cousin of the same "the signal you're reading doesn't mean what you think"
class, on the claim POOL rather than liveness: `work_items:complete` records a
structured completion (`terminal_owner` + `terminal_completion_ref`) but does
not *require* the caller to also flip the top-level `state` to a terminal
value — a caller that omits it gets a `stateWarning`, not a hard refusal. The
row can therefore sit "genuinely done, but `status` still reads `'open'`" —
and until this fix, that row stayed in the self-select claim pool
(`claim_next` / `scheduler:get_next`), so a **different** agent could
re-discover and re-do work a peer had already finished (observed live:
WI-3646, completed + terminal-owned by one agent, re-claimed whole by another
minutes later). `alreadyTerminallyCompletedExclusionSql` (`work-items.ts`) now
pool-excludes any row carrying both `terminal_owner` and
`terminal_completion_ref`, alongside the existing observation/needsHuman/
federation-detector/loop-noise exclusions — the row stays directly claimable
BY ID (e.g. to formally flip its `state`), just not self-selectable fresh.

**What this means for you:** `terminal_owner`/`terminal_completion_ref` being
set is itself as strong a "this is actually settled" signal as a terminal
`status` — don't conclude an item is unclaimed/pickable from `status` alone if
those fields are populated, and always flip `state` when you
`work_items:complete` something so the pool and the status field agree.

## The eighth corollary: a stale declared intent READS as breaking news — presence is never edit-activity (EI-9696, 2026-07-11)

The reader-side twin of the original incident, with a twist: **the data was all
there and still got misread.** An agent planning a repo-wide rename read
`coord:presence`, saw \~20 rows tagged `fleet: p2p-*` with confident present-tense
intents ("UNPAUSE fleet — resume drain"), and concluded the p2p backend was being
actively swarmed — so it blocked three plan items on a constraint that did not
exist. Ground truth (checked only after the owner challenged it): zero
uncommitted p2p edits in the working tree, newest p2p file mtime \~3h old, every
p2p agent parked 2.5–20h, `claims:0` on every row. The staleness signals were IN
the same rows — `intentStale:true`, `lastActiveSecAgo:9641` — and were read past,
because a frozen intent string in the present tense out-shouts an adjacent
boolean and a raw-seconds integer nobody mentally converts to "2.7 hours."

**The fix (emit-side legibility, not more columns):** `toStableRosterRow`
(`presence-payload.ts`) now bakes the staleness INTO the string readers actually
consume — a stale row's intent emits as **`[idle 2h41m] UNPAUSE fleet — resume
drain`** (`formatIdleAge`, `presence-tier1.ts`; bare `[idle]` when the age is
unknown), which is impossible to read as current activity. The prefix is applied
at the emit projection only — the etag and \[coord+N] delta channel diff the raw
rows, so the minute-churning age never breaks the byte-stable delta contract
(D-005/D-006) — and the coord:inbox re-bootstrap block inherits it for free.
`coord:presence`'s guidance now also states the boundary outright.

**What this means for you:** presence answers "who can take a turn," never "who
is editing what." Fleet membership labels persist while parked; a declared
intent is a snapshot of the agent's LAST turn, however current it sounds. To
know whether anyone is actually editing a file or subsystem, read the ground
truth: **`locks:list` + `git status --porcelain` + file mtimes** — the per-edit
hook auto-acquires locks, so a clean tree with no locks is definitive. And
`claims:0` on an "active-looking" row is the tell: nobody working holds zero
claims.
