# Shared pots — a user's guide
URL: /internal/docs/system/shared-pot-guide

Walk through the whole peer-to-peer shared-pot lifecycle as a user — create a pot (incl. from a GitHub URL), share it (public / invite / private), discover + join someone else's, what content federates between members and how cross-member browse works, collaborating on shared work, moderation (report / takedown / ban), and leaving or being removed (including how a re-key cuts read access).

import { Aside } from '@astrojs/starlight/components';

A **pot** is a project several people can work on together. Each person runs
their own Papercusp; the pot's shared state — work items, plans, conversations,
contributor list, file claims, presence — **syncs peer-to-peer** between
everyone's machines and shows up in each person's local app. There is no central
server: the pot is identified by a cryptographic keypair, and every machine
running it is an equal peer.

This page walks a user through the full lifecycle: **create → share → discover →
join → collaborate → moderate → leave**. For the security/trust reasoning behind
it (why GitHub is the authority of record, what's advisory, the threat model) see
[Shared harnesses — trust model](/security/shared-harnesses/). For how code
itself round-trips through git, see [Pot git-sync](/system/pot-git-sync/).

**Pot** = the project (keypair-identified). **Swarm** = one machine running the
pot (yours is a Swarm; each collaborator's is another). **Member** = a harness
inside the pot. A pot federates across its Swarms — each Swarm is a peer.
Identity is anchored to your **GitHub account**.

The **owner** is whoever holds the pot's private key (the Swarm that created
it). Owner-only actions — approving joiners, banning, takedowns, editing the
listing — only work from the owning Swarm. A person who **joined** a pot holds a
*viewer* of it: they federate its content and collaborate, but can't make owner
decisions. Where an action is owner-only, it's called out below.

## 1. Create a pot

There are two ways to start a pot.

### From scratch (a fresh project)

Creating a pot provisions a **home harness** that runs the pot blueprint and
stamps it as a pot. The default blueprint is the **coding** pot; pass a
different one for non-coding work (e.g. a research/`work` pot).

* **Tool:** `pot:create` — args: `slug` (required), `blueprintId` (default the
  coding pot; `work` for a non-coding pot), `kickoff`, `knowledgePack`,
  `wakeInSeconds`, `deployment` (default `local`).
* It's **root-only** — a pot is a top-level peer, never created from inside
  another agent. Running it in the cloud is a separate step
  (`deploy:pot`); by default the pot runs locally on your machine.

A brand-new pot is **local-only** until you publish it (step 2) — it doesn't
announce itself or federate to anyone yet.

### From a GitHub repository

If your project already lives on GitHub, create the pot straight from the repo
URL. This is the fastest path and the one most public releases use.

* **Tool:** `pot:create_from_repo` — args: `githubUrl` (required), `slug`,
  `runTests` (default **false** — opt in to execute the repo's test command),
  `shallow`, `intoHive` (add the repo to an *existing* pot instead of starting a
  new one).
* What it does, in order: **repo → pot lookup first** (if a pot already exists
  for that repo you get a **join offer** back, with zero side effects — so two
  people can't accidentally fork the same project into two pots), then clone,
  detect the blueprint, stand up the pot home + the first member harness, stamp
  the upstream GitHub coordinates, and **auto-publish** a directory listing.
* **Visibility is derived from the repo:** a **public** GitHub repo → a
  discoverable (`public`) pot listing; a **private** repo → a **Private**
  (invite-only, hidden) pot. You can change this afterward (step 2).

`pot:create_from_repo` defaults `runTests: false` on purpose — running a
pasted repo's test command executes that repo's code on your machine. Leave it
off unless you trust the source, and verify on a clone if you need to.

### Adding more members later

A pot starts with just its home (and, from a repo, one member harness). To bring
another existing harness into the pot, use `pot:add-member` (sets the harness's
`hive_slug` so its work federates within the pot). Until something sets that
pointer, a pot has only its home and no members.

## 2. Share it — public, invite, or private

Sharing happens at the **pot** level (per-harness sharing was retired). You
publish a pot to the peer-to-peer **directory** so others can find and join it.

* **Tool:** `discovery:set_pot` — args: `hiveId`, `title`, `description`,
  `visibility` (default `public`), `inviteSecret` (required for `invite`),
  `memberLinks` (one-click join links — see step 4). It's an idempotent
  create-or-edit: call it again with the same `hiveId` to edit the title /
  description / visibility.

The three visibilities mean exactly:

| Visibility  | What it does                                                                                               | Who can find it                                              |
| ----------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| **public**  | Announced to the **global directory topic**.                                                               | Anyone browsing the directory ([step 3](#3-discover-a-pot)). |
| **invite**  | Announced only on an **invite-scoped topic** derived from a secret you share. **Requires `inviteSecret`.** | Only people you give the invite secret to.                   |
| **private** | **Never announced.** Stays local-only.                                                                     | No one — it doesn't federate on the network at all.          |

A `private` (or never-published) pot doesn't announce on the DHT and **doesn't
federate** — the peer-to-peer machinery is a dormant, zero-risk path until you
publish it `public` or `invite`. Setting a published pot back to `private`
**withdraws** it: it stops being re-announced, and other peers age the listing out
on a TTL. Only a *shared* (public/invite) pot actually syncs to other machines.

A published pot can additionally broadcast a **live status beacon** (active
agents, queue depth, focus) onto the directory gossip. It is **owner-consent,
default-OFF**: `pot:beacon_consent { pot, consent: true }` to opt in (`false`
to stop; omit `consent` to read). It only rides a **published** (public/invite)
pot — enabling it on a private pot does nothing until you publish.

## 3. Discover a pot

To find pots other people have shared:

* **Tool:** `discovery:pots` — browse the directory of pots this peer has seen
  announced (title · description · owner · member harnesses). In the desktop app
  this is the **Pots / Network** board.
* The directory is **best-effort gossip** — it's how you *find* a pot, not how
  you're admitted to it. Joining still runs the full admission/attestation flow
  (step 4), so a listing you can see isn't a pot you're automatically in.
* An **invite** pot won't appear in the global directory; you reach it through
  the invite secret / link the owner shared with you.

## 4. Join a pot

Joining a pot makes you a peer: you start federating its content, get a
local view of it, and can collaborate.

**How you join** (this is a desktop / link action, not an agent command):

* **One-click join link** — `papercusp://harness?topic=…&github=…&repo_id=…`.
  The owner's listing carries these (`memberLinks`); pasting one into the app (or
  clicking it) joins you to that exact pot. The link pins the swarm **topic** so
  you land on the owner's pot, the GitHub `owner/repo`, and the immutable numeric
  `repo_id`.
* **From the directory** — pick a pot in the Pots / Network board and join it.
* **An invite pot** is joined with the owner's **invite link / secret**
  (`papercusp://pot?pubkey=…&secret=…`). This join is **honest**: if the pot
  hasn't actually announced yet (owner offline, withdrawn, or wrong secret) you're
  told it didn't connect and left subscribed — never handed a fake "joined."

Under the hood, joining wires up four things per member: a swarm federation
handle, a git-sync routine, presence rows, and registry entries (a `remote_hive`
view + the member harnesses). If no peer is reachable the moment you join, the
join lands in a `phase_0_pending` state — that's **not stuck**: it re-federates on
your next boot (or as soon as a peer comes online), so you don't need to redo it.

### Open vs approval — what happens when you join

Whether you're admitted immediately depends on the owner's **membership mode**
(an owner-signed policy on the pot). The default, and a pot with no policy, is
**open**.

| Mode               | What happens to a joiner                                                                       |
| ------------------ | ---------------------------------------------------------------------------------------------- |
| **open** (default) | Admitted immediately.                                                                          |
| **approval**       | Lands **pending** — held until the owner approves. You federate once approved.                 |
| **allowlist**      | Admitted only if your GitHub **login** is on the owner's pre-approved list; otherwise refused. |

A **banned** GitHub account is refused in **every** mode (the ban is keyed to your
stable numeric GitHub id, so renaming your login can't slip you back in). If a
peer ever sees a membership mode it doesn't recognize, it fails **safe** to
*pending* (owner decides) rather than auto-admitting.

### The approval queue (owner-side)

When the pot is in **approval** mode, the owner manages the queue:

* **`pot:membership_pending`** — list the pending join requests (the review
  queue). Read-only.
* **`pot:membership_decide`** — `approve` (trust-admits the joiner and their
  captured devices, and federates the decision back) or `deny` (never admitted).
  You can clear several at once. **Owner-only** — it requires the owning Swarm
  (the one holding the pot key); a viewer on another Swarm can't decide.

## 5. What syncs between members

Once you're a member, the pot's shared state federates over **one topic derived
from the pot's keypair** — all the pot's harnesses ride that one topic.

**Federates (advisory peer-synced state, projected into each member's local DB):**

* Work items / features (the queue + per-item status + claims)
* Plans and plan decisions
* Conversations, threads, and coordination messages
* Pot settings, the contributor list, presence (who's online), and the member
  list

**Does *not* federate:**

* **Pull-request / merge state.** PR status is read live from GitHub per machine,
  not synced — GitHub is the authority for "did it merge."
* Secrets, `.env`, credentials — never leave your machine.

Peer-synced rows are a fast, shared *cache* for coordination and display. Anything
that actually matters — whether code merged, who has write access, whether
something shipped — is **re-derived from GitHub at the point of action**, never
trusted from a peer. That's the core of the
[trust model](/security/shared-harnesses/); it's why the synced state can be
freely shared without it being a security authority.

### Cross-member browse

Each member harness keeps its own content keyed under its own slug, so **your own
views are unchanged** — you see your harness's work exactly as before. What
membership adds is **cross-member browse**: a member can see the *other* members'
federated content within the pot (their work items, plans, conversations), not
just their own. This is the collaboration payoff — one shared project surface
across everyone's harnesses.

## 6. Collaborate

Working together in a pot uses the same surfaces as solo work — they're just now
shared across Swarms:

* **Shared work items + plans.** Create, claim, and complete work items; they
  show up for every member. Plan items and decisions federate too.
* **File claims.** When agents on different machines might touch the same files,
  the pot serializes contended claims through a single **lock authority** (a
  deterministic function of who's online), so two machines don't stomp each
  other. Git-sync + merge resolution is the data-safety backstop underneath.
* **Coordination.** Messages, conversations, and presence federate, so you can
  see who's active and talk in-thread across machines. **Real-time coordination
  (wakes/receipts/events) crosses machines for POT-SCOPED sends**: a pot-scoped
  `coord:send {wake:'required'}` re-invokes the remote recipient on arrival and
  acks with a delivery receipt (`coord:receipt:<msg_id>` — `events:await` it);
  `events:emit {scope:'pot'}` fires waiters on every machine. Un-scoped sends
  stay machine-local — the send result's `federated:` field tells you which you
  got. Cross-machine wakes are rate-budgeted per sender device.

### Asking another pot for help (cross-pot)

Pots are sovereign, but one pot can send a question or a work request to
**another** pot:

* **`pot:ask`** — a question the other pot owns the answer to.
* **`pot:request_work`** — ask another pot to do something in its domain (it
  becomes a work item their side prioritizes).
* Both are **gated by an owner grant** (`pot:cross_grant`, directed `in`/`out` —
  default-deny, quota-capped). The answer arrives asynchronously; track it with
  `pot:asks`.

## 7. Moderate

Moderation is **owner-gated** and rides the owner-signed pot policy. The flow:

1. **Report** — a member files a report against a piece of content or another
   member with **`pot:report`**. (This only works if the owner enabled member
   reporting in the pot policy.)
2. **Review** — the owner reads the queue with **`pot:moderation_queue`**.
3. **Act** — the owner can:
   * **`pot:takedown`** — hide a piece of content across the pot (adds it to the
     owner-signed takedown list; honest peers honor it as a tombstone). Pass
     `restore: true` to un-hide.
   * **`pot:ban_member`** — ban a repeat abuser by their numeric GitHub id. This
     **denies re-join in every mode** and revokes their devices. (Pass
     `revoke: false` to record the ban without revoking; `unban: true` to lift
     it.) See the read-access note in step 8.
4. **Resolve** — the owner closes the report with **`pot:moderation_resolve`**
   (`actioned` or `dismissed`).

All of these require the owning Swarm.

## 8. Leave — or be removed

### Leaving a pot you joined

* **Tool:** `pot:leave` (requires `confirm: true`). It's the inverse of joining:
  it stops federating, deletes the git-sync routine, drops your presence, and
  deregisters the pot view + its member clones. Your cloned files are **kept by
  default** (so you can re-join later); pass `deleteClones: true` to also remove
  them from disk.
* On leave, your app publishes a presence **tombstone** so connected peers drop
  your "online" row promptly instead of waiting it out.

`pot:leave` is for a pot you **joined**. **`pot:dissolve`** is the owner
tearing down a **local pot they own** (destructive, `confirm: true`) — it does
nothing useful for a joiner. Don't reach for dissolve to leave.

### Being removed (ban / revocation)

When an owner bans or revokes you:

* The **write block and re-join denial are immediate** — your devices are dropped
  from federation and you can't re-join.
* **Read access cut-off ships with re-key (not yet live).** A true read cut-off —
  where removed devices can no longer *decrypt* new content — is the re-key feature
  (`shared-pot-rekey-2026-06-19`): on removal the pot advances a key **epoch** and
  re-wraps the new key to the *remaining* members only, so the removed device has no
  key for epoch N+1. That work is **implementation-complete but flag-dark**
  (`papercusp-pot-rekey`), so until the owner enables it, `ban_member`'s
  `revoke.live` is `false` and removal is a **write-block + re-join-deny only** —
  content already shared with the member stays readable to them.

So **today** removal = no more writes / no re-join; the read cut-off arrives when
re-key is enabled.

Related device-level tools: **`substrate:revoke_self_device`** (revoke one of
*your own* lost/rotated devices) and **`substrate:revoke_contributor`** (owner
revokes another contributor, per-harness or per-pot).

### Trusting a collaborator's work to run automatically

Separately from membership, you keep a **local** trust list: a verified work item
authored by a GitHub user you trust may run on your machine without per-item
screening.

* **`trust:add`** / **`trust:list`** / **`trust:remove`** — owner-scoped, local
  to your install, never federated. Adding someone is a security grant (their
  *verified* remote work auto-runs); remove it to put their work back behind
  per-item review.

## At a glance — the tool map

| Step                | What you want               | Tool(s)                                                         |
| ------------------- | --------------------------- | --------------------------------------------------------------- |
| Create              | New pot                     | `pot:create`                                                    |
| Create              | From a GitHub repo          | `pot:create_from_repo`                                          |
| Create              | Add an existing harness     | `pot:add-member`                                                |
| Share               | Publish / set visibility    | `discovery:set_pot`                                             |
| Share               | Live status beacon (opt-in) | `pot:beacon_consent`                                            |
| Discover            | Browse shared pots          | `discovery:pots`                                                |
| Join                | Find a pot's status         | `pot:get` / `pot:list`                                          |
| Join (owner)        | Review join queue           | `pot:membership_pending`                                        |
| Join (owner)        | Approve / deny              | `pot:membership_decide`                                         |
| Collaborate         | Ask another pot             | `pot:ask` / `pot:request_work` / `pot:asks`                     |
| Collaborate (owner) | Cross-pot grant             | `pot:cross_grant`                                               |
| Moderate            | Report content / member     | `pot:report`                                                    |
| Moderate (owner)    | Review reports              | `pot:moderation_queue`                                          |
| Moderate (owner)    | Hide content                | `pot:takedown`                                                  |
| Moderate (owner)    | Ban a member                | `pot:ban_member`                                                |
| Moderate (owner)    | Close a report              | `pot:moderation_resolve`                                        |
| Leave               | Leave a joined pot          | `pot:leave`                                                     |
| Leave (owner)       | Tear down your pot          | `pot:dissolve`                                                  |
| Removal             | Revoke a device             | `substrate:revoke_self_device` / `substrate:revoke_contributor` |
| Trust               | Auto-run a peer's work      | `trust:add` / `trust:list` / `trust:remove`                     |

## See also

* [Shared harnesses — trust model](/security/shared-harnesses/) — why GitHub is
  the authority of record, what's advisory vs decision-bearing, the threat model.
* [Pot git-sync](/system/pot-git-sync/) — how code commits/pushes round-trip.
* [Pot-scoped federation](/agent-insights/pot-scoped-federation/) — the
  engineering detail of how content federates at pot scope.
* [Shared-pot join/leave lifecycle](/agent-insights/shared-pot-join-leave-lifecycle/)
  — what self-heals, what to call, what ages out.
