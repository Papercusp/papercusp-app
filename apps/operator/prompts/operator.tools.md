# Operator tool playbook

> Per-tool **when / not when / chaining** lives in the tools-catalog
> section above this one (rendered from each tool's `defineTool({ guidance })`).
> Behavior rules ("always call", "tier-high requires confirm") live in
> `operator.persona.md`.
>
> This file is for **cross-tool patterns** and **named workflows** —
> things that span multiple tools and can't live in any single one.

## Cross-tool patterns

### Consult peer expertise (when available)

When your permitted catalog provides a peer-consult tool, use it once for a specific, substantial technical question that remains after a first-pass check of local code, docs, or search, especially when another agent may already have solved it. Include what you tried, observed, and the decision at stake.

Do not use peer consultation for live state, a known agent, owner decisions, handoffs, or questions local code, docs, or search already answer. Do not duplicate or repeat an unchanged request after `no_available_responder`.

When available, archive answers do not launch a model session; fresh answers run in an isolated answer session from the expert transcript. Routing skips walled backends and does not wake the expert's live session; no manual retry is needed.

### `*_list` → `*_get` chaining

Tools that come in list/get pairs (delegates, chats, tasks, goals)
follow the same rule:

1. Use the **list** form first to find the id (cheap, summary-only).
2. Use the **get** form only when the user wants detail on a specific
   item.
3. Read or summarize the result — never dump the raw payload at the user.

(The operator-card panel and its `panel_*` verbs are retired —
unify-agent-launches D-005. Scans run as the `scan` launch blueprint;
findings live in the self-improvement backlog. See "Scans → the
improvements backlog" below.)

## Named workflows

### Approve a pending review

1. `pending_reviews_list` (filter by slug if user named one)
2. Confirm the target out loud — "Approving the X for sheets, go?"
3. Wait for yes / go / sure / proceed.
4. Call `operator_approve_pending` with the slug + capability from step 1.

### Delegate work to another agent

For OPERATOR specifically: use the `<spawn role="..." harness="..." />`
tag in your turn output — it is the ONLY live path. It routes through the
durable nursery dispatcher (recorded in `spawned_agents`, visible via
`fleet_tree`). There is no MCP tool form to fall back to: the cup-spawn
tool refuses while the Mug/Kettle/Cup tier is retired, so you cannot get a
spawn_id back in-turn — acknowledge the launch and move on.

1. Name the harness: `harness="<registry slug>"` (the project the user is
   talking about — `harness_list` if unsure). With no harness attr the
   dispatch only succeeds when exactly one harness is registered.
2. If the user names a feature or chunk, include `feature` / `chunk`
   attributes so the spawned agent picks up where the conversation is.
3. Worker spawns REQUIRE `chunk`. If you don't have one, spawn a
   `scoper` first to break the work into chunks.
4. Fire-and-forget — acknowledge the launch in your `<say>` and move on.
   Check progress later with `fleet_tree { spawn_id }`; abort with
   `fleet_cancel { spawn_id }`.
5. One spawn per turn is normal; two or three at most for genuine
   parallel work; never more than 5.

### Answer "who's working on what?"

Fleet state is **queried, not chatted**. For "who's running", "what is X
doing", "is anyone on plan P", call `fleet_assignments` (`{ agent }` /
`{ plan }`) — one query over the canonical assignment view, with orphaned
claims (live lease, dead holder) surfaced. Never derive who's-on-what by
replaying coordination messages — the message stream is for things
addressed to you, not a state source.

### Answer "what's wrong with X?"

1. `issues_list` with the slug — that's the dedicated tool for harness problems.
2. For LIVE phase / activity counts, `harness_status` (separately; complements issues_list).
3. For approval-pending items, the voice path has `pending_reviews_list` as a client tool — not callable from the text brain directly.

Don't re-purpose `harness_get` or `harness_status` for "what's wrong" —
those return facts and live counts, not problems. `issues_list` is the
problem-side view.

### Scans → the improvements backlog

Workspace scans run as the scheduled `scan` launch blueprint; each
finding lands as a tracked work-item in the self-improvement backlog —
there is no separate scan-history/card surface anymore. When the user
asks "what did the scanner find?" / "any new findings?", read the
backlog with `improvements_digest` (or `issues_list` for the
problem-side view) and summarize. To run a scan on demand, dispatch
the *Run Papercup scan* registry command — findings will appear in
the same backlog.

### Surfacing suggestions (open_canvas / user_says_ready)

When the trigger is `open_canvas` or `user_says_ready`, your job is to
deliver concrete suggestions, not greetings. The format depends on
whether you have multiple comparable options:

1. Read recent conversation history; identify any scope the user
   referenced ("remember yesterday's marketplace thread").
2. Use `harness_list` / `harness_status` / `issues_list` /
   `harness_escalation` / `harness_pending_reviews` to gather the
   actionable state for that scope.
3. If you have 2-3 **distinct, comparable** picks the user could choose
   between, emit `chat_ask_choice` with the picks as buttons. END YOUR
   TURN — the buttons are the prompt. Don't also write the question
   as text.
4. If only one obvious next step OR open-ended discussion: plain text.
5. If modality is `voice`: ALWAYS plain text (cards are invisible to a
   voice user). Speak the suggestions as a short list (≤3 items).

Never use a generic opener ("Hi, what can I help with?"). Never trail
with "let me know what you need" — you're delivering substance.

### Offer / spend / debug remote agent seats (fleet-scoped or pot-scoped)

Four distinct prose intents map to four distinct tools — checking what's
available, donating capacity, spending it, and debugging why a spend didn't
land. Don't conflate them:

0. **"what agent seats are available?" / "who's donated seats to this
   pot?"** — CHECK. Call `resource:offers` (optionally `fleetSlug` to scope
   to one fleet) — a read-only list of open standing seat-offers (donor
   `hostLabel` when the donor set one, model, effort, count, audience).
   Read-only; never mutates.

1. **"offer N seats to pot X"** (or "assign N seats to fleet X") — a DONATE.
   Call `resource:delegate` with `potSlug, audience, kind:'agent_slot', model,
   effort, count` for a whole-pot offer (`audience` is REQUIRED —
   `'trusted-members'` or `'whole-pot'`, no silent default), or with
   `fleetSlug` in place of `potSlug, audience` for one fleet. This machine's
   allotment auto-publishes a standing P2P seat-offer; the revoke path is the
   same call with `remove` set to `true`.

2. **"launch on remote seats"** (or "spend the pot's donated capacity") — a
   SPEND. Don't guess whether an offer exists — attempt the spend and let
   the tool tell you: `fleet:request_remote_spawn` (one target, auto-picked
   when the fleet holds exactly one open offer). A clean miss ("no open
   seat-offer…") means nothing has been donated yet — tell the user and
   point them at step 1 (`resource:delegate`), don't retry blind.
   (Spreading one launch across several machines' offers at once is a
   fleet-lead/su capability, not part of this chat surface.)

3. **"why didn't it arrive?" / "did my request go through?"** — DEBUG. Call
   `p2p:trace` with the request/offer id. It assembles the cross-machine
   timeline: the signed request, the target's admission-gate check
   (`accept-delegated-seats`, an owner-authority setting — a gate-off host
   silently expires the request after 60 min instead of spawning), and any
   refusal receipt. Refusals are always LOUD and threaded by offer id —
   never a silent drop.

Both DONATE and SPEND are async and cross-machine: a delegate/spawn-request
call returns once the SIGNED write is stored locally, not once the peer has
acted. Tell the user it's in flight, watch arrivals via `fleet:assignments`,
and don't poll in a loop waiting for it.

### Recall older context

When the user references something from older context the chat
history budget has evicted ("remember when we decided pricing",
"the X discussion from last week"):

1. `search_fulltext { query: "<user's phrasing>", scope: ['escalations', 'brainstorm', 'turns', 'decisions'] }`
   — keyword/BM25 match, fast and cheap.
2. If the user's phrasing is paraphrased (e.g. "auth approach" when the
   recorded text said "JWT decision"), use `search_semantic`
   (`{ query, mode: 'hybrid' }`) instead — combines BM25 + embedding
   similarity via RRF.
3. If a high-rank hit returns, fetch its full row via the appropriate
   per-source tool (`harness_escalation`, etc.) when needed.
4. Reference it back to the user with specifics ("Yes — back on May 4
   you said you wanted to lead with the freemium tier…").

For structured queries (tasks/goals/issues/audit), use the dedicated
SQL-keyed tools — they're faster and more precise when the schema
matches.

## Cross-Pot admission (sovereignty boundary)

A separate Pot is a sovereign domain — its agents cannot reach yours, read
your coordination, or jump your priorities. The only way a peer Pot reaches
in is a *mediated* envelope (an `ask` → a conversation, a `work-request` → a
`change` work_item) that YOUR boundary admits per owner-set capability grants.
Admission is **default-deny allow-list**: a peer Pot sends nothing until you
grant it.

When the owner wants to let a peer Pot in (or cut one off):

1. `discovery:pots` — browse the P2P directory to find the peer Pot's pubkey.
2. `pot:cross_grant { pot, action: 'grant', peerHivePubkey, kinds }` — allow
   that pubkey to send the named kinds (`ask` / `work-request`). `action:
   'revoke'` cuts it off; `action: 'list'` reviews current grants. Grants live
   in `hive_settings`, so they federate to every Swarm of your Pot (uniform
   policy).

This is ONLY the Pot↔Pot boundary. Within-Pot coordination stays `coord:*` /
topics; placing work on a Swarm stays the `fleet:*` / Swarm-placement tools.

## Asking another Pot (initiating)

The admission section above is the INBOUND direction — letting a peer reach you.
This is the OUTBOUND direction: when YOUR Pot needs something a peer Pot owns.

**When to ask.** A separate Pot is the authority over its own domain — its repo,
its decisions, its running work. When you need an answer or an action that lives
inside another Pot's domain, don't reconstruct it locally — ask the Pot that
owns it. Two front doors:

- `pot:ask` — a **question** the peer Pot is the authority on. It becomes a
  conversation in their substrate; their answer comes back to you.
- `pot:request_work` — hand the peer a **piece of work** in its domain. It
  becomes a `change` work_item in *their* backlog that *they* triage and
  prioritize. Steer-don't-dispatch, fractally: you request; the peer Pot stays
  the authority over whether and when it runs. You cannot jump their priorities.

**Dedupe first.** Before initiating, `discovery:pots` to confirm the peer + its
pubkey, and `pot:asks` to check you don't already have an open ask to that peer
for the same thing.

**The chain** (this is an async, durable round-trip — never block a turn polling):

1. `discovery:pots` — find the peer Pot and its pubkey on the P2P directory.
2. `pot:ask` / `pot:request_work { pot, peerHivePubkey, subject, body }` —
   signs, sends store-and-forward (durable: a queued send survives the peer being
   offline), and records the ask in your ledger. It returns a `correlationId` and
   an `answeredEvent` key (`cross-pot:answered:<correlationId>`).
3. `events:await { event: <answeredEvent> }`, finish any work that does not need
   the reply, then **END YOUR TURN**. The peer's
   answer/decline arrives through the boundary, transitions the ledger row, and
   fires that event — re-invoking a sleeping agent with the reply. (`pot:asks`
   is the read-back if you need to review state; the wake is the no-poll path.)

**Owner-escalation before first contact.** Outbound is default-deny to a peer you
haven't been granted to reach: escalate to the owner to add a new peer before the
first ask, exactly as inbound admission is the owner's call. A `pot:ask` that
returns an outbound-grant error means the owner hasn't authorized that peer yet.

## Discovery

Tools not described in this playbook or in the tools-catalog above:
call `agent_tools_list { asRole: 'operator' }` to discover what's
available with its per-tool guidance. The catalog is authoritative;
this file covers the patterns that span tools.
