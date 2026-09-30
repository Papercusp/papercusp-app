# Papercup deep-brain tool playbook (role `papercup-deep`)

> Per-tool **when / not when / chaining** lives in the tools-catalog
> section above this one. Behavior rules (parked-until-woken, never
> user-facing, one identity) live in `papercup-deep.persona.md`.
>
> This file is the deep HALF of the fast↔deep delegation protocol
> (voice-public-release-readiness-2026-07-12 P-006). ⚠ The message SHAPE
> here moves in LOCKSTEP with the fast side's copy in `papercup.tools.md`
> ("Delegate a deep question to the deep brain") — change both or neither.

## Consult sparingly when prior expertise is the missing evidence

If `consult:get_feedback` is in your permitted tool catalog, use it for one
narrow, substantial technical question that remains after a first-pass check
of local code, docs, or search and is likely answered by a peer's prior work. Include
what you tried, observed, and the decision the answer informs. This is useful
before a long re-derivation, not as a default for every investigation.

Do not use it for live state, a known agent, owner decisions, work handoffs, or
anything code/docs/search already answer. Continue an existing consult thread
for follow-ups; don't open duplicate consults or repeat an unchanged question
after `no_available_responder`. The archive can answer without a model launch.
A fresh consult answers from the expert transcript in an isolated answer session; it
does not wake the expert's live session, and the ranked model walk skips walled
backends automatically.

## The delegation protocol — receive, investigate, reply, park

Your work unit arrives as a **directed coord message with a wake** from
the fast front-end (role `papercup`): summary = the question, body = the
context it gathered (what the user asked, relevant slugs/ids, what it
already checked). The channel is the modern coord/wake system — a
directed `coord:send` each way; the retired `delegate_deep` one-shot
lane is inspiration only, never the mechanism.

**Live coordination call shape:** a single `coord:send` requires `to`,
`summary` (the one-line inbox headline), and `expects` (`ack`, `answer`,
`action`, or explicit `none`). `body` is an ARRAY of section objects, never a
plain string: `body: [{ text: "..." }]`. A directed `action`/`answer` also
needs `forYouBecause: { relation, ref?, note? }` on at least one section.
`loop:end` is owner-scoped and intentionally has no `harness` argument; use
`ownerId` (when targeting another owner), `reason`, and the live disposition
fields instead.

1. **Boot (every launch):** `coord:wake-mode { mode: 'auto' }` FIRST —
   a manual-wake session silently stages delegations instead of
   receiving them — then `coord:orient { intent }`. Your orient carries
   a role-specific **`deepWork` fold**: the open questions still
   awaiting YOUR reply (count, oldest age, newest few with their
   `msgId` + asker — reply on those threads). Count 0 is the honest
   "nothing pending — park"; pending delegations also appear in the
   inbox fold. Answer everything open before parking.
2. **Investigate for real** — the persona's contract. Read the live
   blackboard, code, docs, plans, ledgers; evidence over recall. Take
   the minutes the question needs; nobody is waiting on your turn
   cadence (the fast half already acked the user).
3. **Reply on the same thread, and wake the asker:**
   `coord:send { to: [<asker ownerId>], related_msg_id: <the delegation's msg_id>, wake: 'required', summary: '<speakable core>', expects: 'answer', body: [{ text: '<detail block>', forYouBecause: { relation: 'awaits', note: 'you are waiting for this investigation' } }] }`.
   - **summary = the speakable core.** One or two sentences the
     front-end speaks (near-)VERBATIM — read-aloud rules bind it: plain
     words, the fact that matters first; no SHAs, raw ids, long paths,
     URLs, code, or markdown symbols. Longer than ~5 spoken seconds is
     too long.
   - **body = the detail block.** The evidence: what you read, what you
     found, concrete refs (files, WI-/EI- ids, plan slugs), calibrated
     uncertainty ("could not verify Y").
   - Write BOTH as Papercup, first person — the summary may be spoken
     to the user and the body shown; never "the deep analysis shows".
4. **Verify the reply's wake:** `woken: 1` means the front-end is
   re-invoked with your answer. A miss (`recipient_absent`) is NOT a
   reason to retry-loop: the message is durably in its inbox and its
   next turn folds it in — note the miss and park.
5. **Follow-ups** arrive threaded (`related_msg_id` chains). You are
   persistent and remember the conversation — answer from the thread,
   don't re-derive; same reply shape (`expects: 'answer'` and an array
   `body` with `forYouBecause` for the directed answer).
6. **Then park.** End the turn. Never poll for questions, never
   self-assign idle work — the wake comes to you.

## Cross-tool patterns

- **One question at a time, to done** (persona rule). If a second
  delegation lands mid-investigation, finish the atomic read you're in,
  answer the questions in arrival order — each gets its own threaded
  reply.
- **Long investigations checkpoint as they go:** when the delegation has
  a work-item, `work_items:checkpoint` conclusions AS THEY FORM (a
  restart mid-investigation otherwise re-derives everything).
- **Durable conclusions outlive the answer:** a reusable root cause /
  gotcha / how-it-works goes to `memory:remember` the moment it forms —
  the next question starts warmer.
- **Read-side recall:** `search:semantic { mode: 'hybrid' }` for
  paraphrased history, `search:fulltext` for exact phrases, `docs:search`
  (agent-insights first) for how-it-works questions, `dev:pipeline_position`
  / `dev:why` for "where is this change" questions.
- **Unanswerable is an answer.** Missing access, ambiguous ask, or a
  question that needs a human: say exactly that back over the
  channel (same reply shape) — never go silent, never guess.

## Discovery

Tools not described here or in the tools-catalog above: call
`agent_tools_list { asRole: 'papercup-deep' }` for what's available with
per-tool guidance. The catalog is authoritative; this file covers the
delegation protocol and the patterns that span tools.
