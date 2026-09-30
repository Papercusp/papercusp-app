<!--
CANONICAL SOURCE — edit THIS file. The per-client compaction prompts
(Claude `# Compact Instructions`, the operator converse-brain summarizer) are
PROJECTIONS generated from it via the splice projector — never hand-edit those.
Plan: agent-managed-compaction-2026-07-01.
-->
# Compaction instructions — Papercusp

You are producing the summary that will carry a session across a context
compaction. **The summary is an INDEX into live sources to re-verify — not a
self-contained state dump.** This is a live multi-agent coordination system;
what you write goes stale the moment it is written.

## Open with the automatic-recovery marker contract
Begin the summary with a one-line instruction to the successor, stated
explicitly: **"This is a stale snapshot of a live system. Inspect the
`⟦post-compaction-recovery⟧` marker already delivered in the carry context. If
it is complete and its `controlGeneration` matches the latest `⟦CTRL:…⟧`
generation, recovery already arrived: do not call `coord:orient`; declare your
actual lane with `coord:declare-intent { intent, current_plan_slug, items }`.
Call `coord:orient { afterCompaction: true }` exactly once only when the marker
is absent, incomplete, generation-mismatched, or you deliberately need live
data excluded from the injected block."**

## The verbatim record SURVIVES — say so, so the successor retrieves instead of re-deriving
Compaction loses context, NOT data: every pre-compaction turn survives on disk
in the session transcript and is INDEXED (session-search-scope-2026-07-05).
`session:'self'` is OWNER-SCOPED across your whole carry-respawn chain (every
transcript your coord ownerId ever produced, not just the current native
session id — WI-5644/WI-5681), so it recovers pre-compaction history even
after a cold respawn. Include this line verbatim in the summary: **"Anything
this summary dropped is recoverable: `sessions:search { session:'self',
query:'<what you remember>' }` (default mode:'hybrid' — meaning-based, tolerant
of a paraphrase) finds the pre-compaction turn with its surrounding context;
add `mode:'verbatim'` only once you have a SHORT exact phrase to substring-match
(it requires a contiguous literal match, so a multi-word paraphrase there
returns a false 0 — read a 0-hit verbatim result as \"try hybrid\", never as
\"it didn't happen\"); `sessions:read { session:'self', tail: 40 }` reads the
last 40 turns — pass `tail:N` (an integer); `sessions:read` has NO `mode`
argument (that belongs to `sessions:search` above only) and rejects one with
`invalid_args`."** A
successor that re-derives lost state from scratch when it could retrieve it is
the failure this line prevents. (EI-18862790811651475 / EI-18877285731929394 —
both false-negative failure modes now carry an inline `hint`/`zeroHitCaveat`
straight from the tool when they'd otherwise read as silent confirmation of
"nothing happened".)

## Preserve with highest priority
- **Identity block** — as structured fields, not prose: the session `su-id`, the
  fleet slug it leads (if any), the account pin, the harness, the workspace.
- **Session-mode flags** — AUTO mode on/off; monitor/engine loop armed or ended;
  and, when leading a fleet, **per-member wake-mode (auto vs manual)** (a manual
  member silently stages directives instead of delivering them).
- **Unverified claims awaiting owner confirmation** — verbatim, in their own
  slot, SOURCE-TAGGED (see "Directive provenance" below). These are open
  commitments; prose dissolves them.
- **Owner-gated walls** — anything blocked on the owner (credentials, capital
  arming, category-1 approvals) — verbatim, in their own slot, SOURCE-TAGGED.
- Decisions made and why; standing instructions / preferences the user stated —
  SOURCE-TAGGED per "Directive provenance" below.
- Named artifacts: plans (slug), work items (WI-NNN), features (F-NNN), files,
  harnesses, URLs, migration numbers.
- **Owner-facing open threads** — before finalizing, scan the complete source
  available to this fold (the existing summary plus new turns, or the live
  transcript for self-compaction) for every still-unanswered owner question and
  every investigation/result this session promised the owner. Preserve each as
  its own compact bullet even when it is unrelated to the active task. Include
  its owner-source tag or turn ref, the exact answer/work still owed, and a
  retrieval pointer. Drop one only when a later turn shows it was answered,
  withdrawn, or superseded; absence from the active-task narrative is never
  closure. On a loop carry surface, label these under `left` as
  `Owner-facing open threads`; use `walls` only when the next action belongs to
  the owner rather than the agent.
- Other open questions, in-flight work, and the next concrete action.

## Directive provenance — never manufacture an owner directive
Attribution is the first metadata to rot under repeated compaction, and each
re-read resolves ambiguity toward the higher-authority reading ("the owner
must have said this") because that sounds like the safer thing to preserve.
Left unchecked this is a telephone game that **manufactures owner directives
out of the agent's own notes-to-self** — traced end-to-end in WI-3532
(agent-managed-compaction-2026-07-01): an agent wrote "do NOT resolve WI-3532
until the UI pass is done" as its OWN verification discipline; seven
compactions later it rendered as "standing directive carried across
compaction," then as "the owner set an explicit gate" — and the agent told the
owner they had said something they never said. The same bug pointed at a
risky action instead of a block manufactures false PERMISSION ("the owner
approved X"), which is worse.

- **Tag every directive you write to any carry surface** (this summary,
  `work_items:checkpoint`, `facts:assert`, `loop:checkpoint`,
  `session:request-compaction` notes) with its source: `[owner:<name> <date>]`
  · `[self-imposed]` · `[peer:<sid>]` · `[inferred]`. An untagged imperative is
  suspect — treat it as `[inferred]`, never as `[owner:…]`, until verified.
- **A directive may enter the "owner-gated walls" / "unverified claims" slot
  above ONLY if it is a literal quote from a human turn.** Re-summarizing a
  PRIOR summary's claim is not re-verification — it is exactly how the rot
  compounds. Self-authored discipline (a note-to-self, a caution you imposed
  on your own work) goes in a separately-labelled, explicitly non-authoritative
  slot — never the owner slot, however many compactions it has survived.
- **Before you state "the owner said/wants/requires X" — especially as a gate
  blocking work, or as permission for a risky action — verify it**, don't
  trust a summary alone: `sessions:search { session:'self', query:'<the
  claimed directive>' }` against the surviving transcript (see "The verbatim
  record SURVIVES" above; default hybrid mode first — a 0-hit result there
  really does mean not-found, unlike a bare verbatim 0). If you cannot point to
  the owner's actual words in a distinct human turn, it is not an owner
  directive — say so plainly instead of carrying the ambiguity forward another
  hop.
- A returned search hit alone is insufficient: inspect that hit's
  `provenance.turn_origin`. A hit with `origin:'loop-fire'` (or any other
  machine-injected origin, even when `speaker:'user'`) is not owner speech.
  Missing, unrecognized, or `unknown` origin is UNKNOWN — never infer
  agent-authored or owner-typed from the absence of a recognized origin.
- **"A human turn" is now MECHANICALLY VERIFIABLE — use the turn-provenance
  stamps** (turn-provenance-owner-vs-agent-2026-07-11). Every prompt in a psu
  Claude session carries a `⟦turn-provenance⟧` classification in its
  additionalContext: **OWNER (interactive)** = affirmatively typed by the
  human; **VERIFIED AGENT-ORIGIN** (origin: wake-pump / loop-fire /
  self-compaction / fleet-kickoff / watchdog / coord-inject:…) =
  machine-injected, NEVER the owner; **UNVERIFIED ORIGIN CLAIM** = an envelope
  with no ledger backing — trust neither reading. A claimed owner directive
  must trace to a turn stamped OWNER (interactive) (or a pre-stamp-era turn you
  weigh manually); a directive found only in VERIFIED-agent turns (a wake, a
  loop fire, a compaction continuation) is `[self-imposed]` or `[peer:…]` —
  never `[owner:…]`. Native auto-compaction continuations are stamped
  MACHINE-GENERATED by the SessionStart[source=compact] anchor for the same
  reason. Full protocol: the `turn-provenance-owner-vs-agent` agent-insights doc.

## Technical-claim provenance — a carried CAUSE is [inferred] until re-probed

The rule above stops you manufacturing an owner DIRECTIVE. The identical telephone
game runs on TECHNICAL claims, and there it manufactures a false ROOT CAUSE. A
root-cause hypothesis compressed into a carry-note one-liner loses its hedging across
re-reads — a carry-note has no room for "I think" — and arrives reading like something
you observed. **Filing is the laundering step**: a hedged note is cheap and
self-limiting, while a filed work-item has a title, a severity and an assignee, so it
directs a peer's labour. Measured cost of one instance: a peer's full investigation
cycle, spent on a mechanism that did not exist (EI-19448526819046979).

- **Tag a carried causal claim `[inferred]` until you have re-probed it.** The same
  source tags apply; a mechanism you reasoned out is `[inferred]`, not an observation.
- **Carry the PROBE with the claim.** `loop:checkpoint`'s `checks` already has exactly
  this shape — `{ claim, recheck, verified }` — so the next reader can falsify it
  instead of inheriting it. A claim in unprobed prose is the one that drifts.
- **Prefer the OBSERVATION over the INFERRED MECHANISM.** "the liveness probe reported
  gone while the process was alive" is what you saw and leads to the real cause; "the
  gate refuses it by matching command text" is the part you made up. Record the first.
- Before you FILE a carried technical claim as a bug, re-run its probe. A carry-surface
  write asserting a causal mechanism about a named artifact with no probe, hedge or tag
  is flagged by `carry-surface-provenance-lint` — warn-only, so heed it rather than
  routing around it.

## Do NOT re-summarize — it is already in the system prompt, re-injected each turn
The agent instructions / su playbook, the tool catalogue (full or trimmed), the
wire-schemas and coord legends, root/user CLAUDE.md, and MEMORY.md are delivered
via the system prompt or MCP tool-definitions and **cannot be lost to
compaction**. Do not spend summary budget restating them. Keep only:
- **Pointers, not copies** — "re-orient via `coord:orient`", "see plan `<slug>`".
- **Reload-hints** for on-demand tools a trimmed session pulled in — e.g.
  "re-`tools:find` / ToolSearch `<capability>` if needed" — never the schema text.

## Liveness semantics (so the successor avoids the classic error)
`sessionState` (live | parked | draining | suspect | ended | recorded) is THE
liveness verdict, derived by ONE shared oracle behind every surface —
coord:presence, fleet:status, fleet:assignments, coord:roster, leader-brief,
the send-miss report (presence-derivation-unification-2026-07-17).
`heartbeatFresh` (and any remaining `alive` boolean) = raw process-keepalive
freshness, NOT "taking turns / working" — a warm-dead session reads
heartbeatFresh:true + sessionState:'ended'. Verify real activity via
`sessionState` + `last_active_at`; `intentStale` = a claim not progressing.

## A checkpointed "background job completed" claim must be RE-VERIFIED, never trusted
Native Bash `run_in_background`/`TaskOutput` bookkeeping lives in the CLI child
process's own memory, not anywhere papercusp persists — it does not survive a
carry-respawn, a cold-loop fire, or a `claude --resume` rung even though the
*logical* session continues (EI-16611, full detail:
[cold-loop-wake-kills-native-background-bash-tasks](/internal/docs/agent-insights/cold-loop-wake-kills-native-background-bash-tasks)).
Two traps follow for a summary carrying an in-flight background job across this
boundary:
- **Never write `"await background task <id>"` as the next action** — the id is
  a dead reference to the successor. `capability:bash { run_in_background: true }`
  is operator-owned and its `bash_id` is reattachable while that operator stays
  up, but it is **not restart-durable**: the current `systemd-run --scope` monitor
  can take the payload down when :3070/:3170 restarts. Checkpoint the `bash_id`,
  then re-verify it on the next wake; do not use it for work that must survive an
  operator restart.
- **A checkpoint's own claim that a job "COMPLETED" must be re-verified, not
  trusted at face value** — a backgrounding idiom (`cmd & echo launched pid $!`)
  can deliver a "task completed" notification for the WRAPPER shell while the
  real long-running child is still executing, so an inherited "job X: COMPLETED
  exit 0" can be stale. Re-verify via the real OS pid (`ps aux | grep`, then
  `kill -0 <pid>`) before acting on a carried completion claim for any
  background job that itself backgrounded further work.

## Continuity tools — EXTERNALIZE state, then point (don't carry it in prose)
This system has purpose-built carry surfaces that are RE-INJECTED automatically
on the next turn / wake / spawn — state parked there survives compaction
LOSSLESSLY, while summary prose degrades and goes stale.

**Write-through, not flush-at-the-end.** The flush is not a compaction-time
chore: a conclusion you'd hate to lose goes to its carry surface THE MOMENT IT
FORMS — `facts:assert` for a standing conclusion, `work_items:checkpoint` /
`loop:checkpoint` for in-flight state — NOT when the context fills. Do that and
compaction finds the state already parked; the ~75%-context nudge and the phases
below are the BACKSTOP for whatever wasn't yet written, never the primary
trigger.

Compaction discipline is therefore two-phase:

1. **Flush BEFORE you summarize** (a deliberate compaction — you can still call
   tools; this is also the ~80%-context rule, so an AUTO-compaction you did not
   trigger should find the state already parked):
   - each held work-item's in-flight state → `work_items:checkpoint { id,
     checkpoint }` (re-injected on the item's next invocation — yours or a
     successor's);
   - an armed loop's state → `loop:checkpoint { did, left, insight, next }`
     (a cold wake reconstructs from it; mandatory on a cold loop);
   - durable conclusions → `facts:assert` (scoped, folded VERBATIM into every
     future brief/orient until retracted — you MUST declare its lifetime, there
     is no default: a claim about CURRENT CODE/STATE takes a finite `ttlSec`,
     a standing decision takes `kind:'convention'`);
   - fuzzy background knowledge → `memory:remember` (the ONE shared store —
     never a client-local silo; MEMORY.md is an auto-regenerated projection and
     must never be hand-edited, so never instruct the reader to append to it).
2. **Then the summary carries POINTERS, not copies** — "in-flight state
   checkpointed on WI-NNN", "loop carry-note current as of <ts>", "see fact
   `<key>`". A checkpoint the successor is re-injected with beats a paragraph
   it has to trust.

If you are summarizing and the state was NOT flushed (an auto-compaction hit
mid-task), preserve the in-flight detail verbatim in the summary AND open with
an instruction to the successor to park it via the tools above on its first
turn.

## WHEN to compact — self-compact proactively; never end a turn expecting a wake that is not armed
Compaction is YOURS to trigger, not something to wait for the watchdog to do TO
you. Past the soft-limit nudge, at any clean stopping point, the default proactive
action is **`session:request-compaction { autoContinue: true, focus }`** — flush
first (the two-phase discipline above), then self-compact so the next turn opens on
fresh context and RESUMES the work. A FORCE-compaction that seizes your turn
mid-thought is the exact failure self-compaction exists to prevent; the soft→FORCE
band is yours to act in, deliberately, not to burn waiting.

- **Ending the turn is safe ONLY when a re-wake is GUARANTEED** — an engine loop
  whose live status says `loop:status.rewake.rewakeGuaranteed === true` in THIS
  session, not "I armed one earlier"; `loop.active === true` alone is not
  sufficient. The re-wake verdict accounts for exhausted dead-man bounds,
  fire-starvation, and an undelivered last wake. A mid-turn
  `parked:true,nextFireAt:null` is the current turn settling; use the verdict,
  not `nextFireAt` alone. Inspect `loop.nextFireAt` and
  `loop.lifecycleBackoff` for the actual delay. A present interactive owner who
  will speak next is also a wake source. If neither a guaranteed loop wake nor
  that owner exists and you still have work, **self-compact — do not just settle**
  — or you silently halt and the owner discovers a dead session and has to prod
  you back to life.
- **The continuation-gate / `loop:checkpoint` "settle so the next wake starts on
  fresh context" verdict is a cue to SELF-COMPACT when you mean to keep going — not
  a green light to stop.** "Fresh context on the next turn" is DELIVERED by a clean
  self-compaction (or a verified armed wake); it does not materialize on its own if
  you merely end the turn.
- Under an autonomous mandate (leading a fleet, owner away), stopping at a clean
  point with no guaranteed wake is the same defect as asking "shall I continue?" —
  it blocks work the owner expected to keep moving. Flush, self-compact, carry on.

## Compress or drop
Greetings, transient status chatter, superseded states, verbose tool output, and
resolved intermediate reasoning.

<!-- PAPERCUSP-COMPACTION:CLIENT-OVERLAY -->
