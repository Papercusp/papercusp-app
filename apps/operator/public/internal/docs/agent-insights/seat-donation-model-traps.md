# Seat-donation traps found during the pot-seat-pools live drill
URL: /internal/docs/agent-insights/seat-donation-model-traps

Seven concrete bugs (including the diagnosed P-011 blocker, WI-5446, likely a manifestation of the known WI-953 federation gap) + design nuances surfaced while driving the pot-seat-pools-prose-ux-2026-07-18 live two-machine (tower↔iMac) verify drill. Read before touching resource:delegate/resource:offers' pot-scoped forms, fleet:request_remote_spawn spend authority, coord:send's federated liveness/hive-scope handling, or the always-armed inbox-wake.

Seven concrete bugs (including the diagnosed P-011 blocker, WI-5446, likely a manifestation of the known WI-953 federation gap) + design nuances surfaced while driving the pot-seat-pools-prose-ux-2026-07-18 live two-machine (tower↔iMac) verify drill. Read before touching resource:delegate/resource:offers' pot-scoped forms, fleet:request\_remote\_spawn spend authority, coord:send's federated liveness/hive-scope handling, or the always-armed inbox-wake.

## One paragraph

While driving WI-5410/P-011 (the live tower↔iMac two-machine verify drill
for [the seat-donation model](/internal/docs/coordination/seat-donation-model)),
fleet peers hit **seven** concrete, reproducible bugs — one of them
(**WI-5446**) the actual, diagnosed reason P-011 is still open (a real
federation gap, not a staffing/coverage problem, and likely not even a
*new* gap — see its link to WI-953 below) — plus design nuances worth
documenting alongside the model itself so the next agent doesn't have to
re-derive them. Six of the seven bugs don't block the model
conceptually (the fleet-scoped spend path was the workaround for parts of
the live drill), but WI-5446 means **no cross-machine seat spend can
currently be verified live at all**. All seven will bite anyone exercising
the **pot-scoped** form, or federated coordination generally, on a real
multi-hive/multi-machine workspace.

## Bugs filed (repro + evidence in each)

| id          | Summary                                                                                                                                                                                                                                                                                                            | Where it bites                                                                                   |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| **WI-5446** | **Cross-machine seat-offers do not federate at all** between tower and iMac — donor delegate succeeds locally (`hive` correctly passed), the offer never reaches the spender; zero P2P receipts on BOTH machines. Linked caused-by **WI-953** (same publish-succeeds/receiver-hears-nothing shape, one layer down) | the actual blocker behind P-011 — no cross-machine spend is currently verifiable live            |
| **WI-5445** | **Umbrella:** four surfaces on the cross-machine path handle hive-disambiguation four different, inconsistent ways — `coord:send` has no way to comply at all                                                                                                                                                      | the reusable framing for EI-16667/EI-16673 below, plus a `coord:send` gap neither of them covers |
| **WI-5447** | `resource:delegate { remove:true }` deletes the local allotment but leaves the published seat-offer `'open'`, so a revoked delegation still shadows the fleet's offer picker                                                                                                                                       | contradicts P-001's own "revoke works exactly like the fleet-scoped form" requirement            |
| EI-16667    | `resource:delegate` (potSlug+agent\_slot) silently skips its P2P seat-offer publish on a multi-hive workspace when `hive` is omitted                                                                                                                                                                               | write side of pot-scoped delegation                                                              |
| EI-16673    | `resource:offers` has no `potSlug`/`hive` disambiguation arg, so pot-wide `potShared` visibility can never resolve on a multi-hive workspace                                                                                                                                                                       | read side of pot-scoped delegation                                                               |
| EI-16693    | `coord:send{wake:'required'}`'s liveness check disagreed with `coord:presence` for a federated recipient — reported `sessionState:'ended'`/`recipient_absent:true` for a peer that was, in fact, alive and working                                                                                                 | any cross-machine wake/dispatch decision, not just seat-pools                                    |
| EI-16685    | the always-armed inbox-wake repeatedly redelivered a backlog of stale/already-read messages with expired nonces across \~5 consecutive turns                                                                                                                                                                       | general session hygiene, surfaced during this drill                                              |

### WI-5446 — cross-machine seat-offers do not federate (likely = WI-953)

Staged correctly, as pot-seat-pools fleet leader: the donor-side
delegation was fired **on the iMac** (via `ssh 172.31.44.2` → its local
MCP door), naming `hive:'papercusp'` explicitly (so EI-16667's
silent-skip-on-ambiguous-hive does not apply here) — it succeeded,
returning an active `allotment`. `fleet:request_remote_spawn` (fleet:
pot-seat-pools, hive: papercusp) fired from the **tower** repeatedly over
\~7 minutes, every attempt refusing with *"seat-offer
seat-ec799e00fa1c9725 is this machine's OWN delegation"* — i.e. the tower
could see exactly **one** open seat-offer for the fleet: its own.
(`request-remote-spawn.ts` only auto-selects when
`seatOffers.length === 1`; with 2+ open offers it instead refuses, asking
the caller to disambiguate — so this single auto-select is conclusive
that the iMac's offer was genuinely absent, not merely deprioritized: a
reusable **black-box technique** for telling "record absent" from
"present but not chosen" with no DB access at all.) Corroborating:
`p2p:trace {pot:'papercusp'}` returned empty receipts AND empty refusal
counters on **both** machines, and a direct `harness_shared.p2p_receipts`
query on the tower returned zero rows in the prior 2 hours — there is no
P2P traffic for this pot in either direction, not refused traffic, **no**
traffic. Every gate and spend path in the seat-donation model is unit-
and integration-green; the gap is specifically donor→spender delivery in
the P2P federation layer itself.

**Likely not a new bug.** Linked caused-by **WI-953** ("shared-hive
DIRECTORY ANNOUNCE never reaches the joiner", major, open since
2026-06-29) — stated as a strong hypothesis with reasoning, not
established fact:

|                | WI-953                                                                     | WI-5446 (this)                                                |
| -------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------- |
| publisher side | owner creates + publishes hive, `announced` reported                       | donor `resource:delegate` returns ok, allotment active        |
| wire           | peers connect on the topic, but ZERO slug-filter/announce lines processed  | zero P2P receipts AND zero refused-op counters, both machines |
| joiner side    | `/api/discovery/hives` stays `count=0`; never admits the owner's home core | tower never sees the offer; auto-select-of-one proves absence |
| net            | 0 content federates                                                        | 0 offers federate                                             |

In both cases the local publish reports success and the remote side
receives **nothing at all** — not a rejection, not a refusal receipt,
silence. WI-953's own analysis places the fault "UPSTREAM at the
directory-announce/peering layer" and explicitly rules out the
content-apply/merge code (hermetic repro green) — a seat-offer is just
another payload riding that same shared-hive federation path, so if the
announce/peering layer isn't delivering, seat-offers can't arrive either.
**Implication: do not start by re-debugging the seat-offer publish
code** (WI-5403/WI-5409's logic is unit- and integration-green, including
a real two-peer federation integration test that passes on the
local-parity path) — start from WI-953's "likely contributors / next
steps" list and its diagnostic toolkit
(`/internal/docs/agent-insights/shared-pot-federation-diagnosis-toolkit`),
and treat a working cross-machine seat-offer as an **acceptance test for
WI-953's fix**, not a separate investigation.

### WI-5445 — the umbrella: four inconsistent hive-disambiguation behaviors

On a workspace with more than one shared hive, four different surfaces on
the cross-machine coordination path handle the resulting ambiguity four
different ways — worst to best:

1. `coord:send { scope: 'hive' }` — **refuses with no way to comply at
   all**: `ambiguous_hive_scope`, and the tool takes no per-message `hive`
   argument. From an un-scoped SU/operator session, cross-machine coord
   messaging is therefore **impossible**, not merely awkward — hit live
   while trying to reach the only agent on the other machine, and the
   workaround (relaying through a peer whose session happened to be
   hive-scoped) was luck, not design.
2. `resource:delegate` (potSlug + agent\_slot) — **silently skips** its
   P2P publish when `hive` is omitted (EI-16667). The most dangerous of
   the four: silence is indistinguishable from success.
3. `resource:offers` — no pot/fleet disambiguation at all, so
   `potShared` never resolves (EI-16673).
4. `fleet:request_remote_spawn` — **refuses loudly**, names the
   candidate hives, and accepts a `hive` argument to comply. The correct
   behavior, and the model the other three should be fixed to match.

Proposed fix order: (a) give `coord:send` a `hive` argument mirroring
`fleet:request_remote_spawn`'s — today it's the only fully-blocked
surface; (b) make `resource:delegate` refuse loudly instead of silently
skipping (EI-16667); (c) give `resource:offers` the same disambiguation
(EI-16673); then add one shared helper so a fifth surface can't invent a
fifth behavior. The individual symptoms each look like a small ergonomic
wart; together they mean the cross-machine/federated coordination path is
effectively unusable from a multi-hive workspace unless the caller
already knows which sessions are incidentally hive-scoped — a much bigger
finding than any one of them alone, and the reason WI-5410/P-011 was hard
to stage correctly in the first place.

### WI-5447 — revoke is not symmetric with donate

The tower held an agent\_slot delegation to fleet `pot-seat-pools`
(offer `seat-ec799e00fa1c9725`). Revoking it
(`resource:delegate { fleetSlug, kind:'agent_slot', model, effort,
remove:true }` → `{ ok:true, action:'remove', removed:1 }`) removed the
local `resource_allotments` row — but `fleet:request_remote_spawn` still
resolved and selected that same offer id afterwards, reaching the
self-target guard in `p2p/spawn-request-publish.ts`. That guard sits
*after* the `target.status !== 'open'` check in the same function (which
would have said "the delegation was paused or revoked") — meaning the
offer record was still `status: 'open'` in the offer store despite the
revoke. **Revoke is not symmetric with set:** setting an agent\_slot
delegation auto-publishes a seat-offer; removing it does not retract or
close that offer, so the stale offer keeps shadowing the fleet's picker
(one stale self-offer + one legitimate remote offer means the picker
stops auto-selecting and demands explicit publisher+offer). This directly
contradicts P-001's own requirement that `remove:true` "must work exactly
like the fleet-scoped form" — a caller who revokes reasonably believes
the seat is withdrawn; it is not, from the spend path's point of view.

### EI-16667 — delegate silently skips its P2P publish

`resource:delegate` (potSlug: papercusp, audience: trusted-members,
kind: agent\_slot, model: sonnet, effort: medium, count: 1) — **no
`hive` param** — on a workspace with 17 registered hives (`pot:list`)
returned `{ ok:true, action, allotment }`: a clean-looking success. A
follow-up `resource:offers` on the same machine came back
`{ potShared:false, rows:[] }` — the offer was **not** visible pot-wide,
not even locally. Root cause: `resource:delegate`'s own arg doc says `hive`
is required to disambiguate the cross-machine publish on a >1-hive
workspace — omitting it means the P2P publish almost certainly no-op'd,
with **zero signal in the response** that anything was skipped. This is
the opposite of D-003's fail-closed/loud-refusal invariant: a silent
partial failure, not a loud one. Passing `hive` explicitly did **not**
fix `resource:offers`' read side — see EI-16673. See also WI-5445, which
frames this as one of four inconsistent hive-disambiguation behaviors.

### EI-16673 — resource:offers has no disambiguation arg

`resource:offers` accepts only `fleetSlug`; there is no `potSlug`/`hive`
argument. Direct DB check (`dev:pg_query` against
`harness_shared.resource_allotments`) confirmed the pot-scoped delegation
row existed and looked correct locally (`pot_slug='papercusp',
audience='trusted-members', status='active'`) — but the table has **no
`hive` column at all**, so the `hive` arg to `resource:delegate` is
transient/publish-time-only and cannot be what `resource:offers`'
`potShared` check consults. `resource:offers`' own doc frames
`potShared:false` as "this workspace has no single shared Hive" — i.e. the
read path requires resolving to exactly one shared hive with no way to
name one explicitly. On any workspace with 0 or >1 hives (17, here) pot-
scoped `resource:offers` can **never** return real rows, regardless of how
many valid delegations exist. Combined with EI-16667, a caller gets zero
signal from either side that pot-scoped delegation isn't actually working
end-to-end. **Workaround used for the P-011 drill:** fall back to
fleet-scoped `resource:delegate` + `fleet:request_remote_spawn` /
`fleet:launch-on-plan` (placement: remote) (resolves via `fleet_slug`, not
the ambiguous pot-wide hive lookup).

### EI-16693 — coord:send federated liveness disagrees with presence

`coord:send { to:[<federated peer>], wake:'required' }` reported
`sessionState:'ended'`, `recipient_absent:true` for a cross-machine
(iMac) recipient. \~60 seconds later `coord:presence` for the **same**
ownerId returned a fresh (12s-old) `active` row, and a direct `ssh` +
`ps aux` on that host confirmed the underlying process had been running
continuously for days and never died. An agent following the standard
"`recipient_absent:true` → treat as missed, redirect to a live driver"
guidance would have wrongly given up on / routed around a peer that was,
in fact, alive and working — a wake-dispatch-specific gap in the
federated-recipient liveness check, distinct from (but likely related
to) informally-noted gaps in `coord:glance`'s cross-hive/remote-machine
bee visibility.

### EI-16685 — inbox-wake redelivers a stale backlog

The always-armed inbox-wake fired repeatedly across \~4 consecutive turns,
each time surfacing a **different old, already-actioned** message (one
from \~30 minutes earlier), each carrying a `⟦turn-provenance⟧ UNVERIFIED
ORIGIN CLAIM` warning ("the envelope's nonce exists in the ledger but is
EXPIRED, age >600s ttl"). Each time, the internal delivery fold reported **zero** new entries while a repeatable `coord:inbox` VIEW still showed the current window — confirming these were stale replays
of a backlog rather than genuine new mail. Costs a wasted
"is this actually new?" re-verification turn every time it fires, and the
expired-nonce warning itself reads like a possible spoofed/injected turn
until checked.

## Design nuances worth documenting (not bugs — working as intended, but non-obvious)

* **Fleet-leader-only spend is a third authority axis.** Both
  `fleet:request_remote_spawn` and `fleet:launch-on-plan (placement:'remote')` enforce that only the spending fleet's **leader**
  may spend a delegated seat — beyond D-002's audience
  (`trusted-members`/`whole-pot`) and the host-local
  `ACCEPT_DELEGATED_SEATS` gate. Being a trusted (or whole-pot) member is
  necessary but not sufficient.
* **Self-donor exclusion — and why it makes a same-machine "drill"
  worthless.** A machine that delegates a seat to a fleet cannot
  remote-spend its **own** delegation — correctly refused with "spawn
  locally instead". For a genuine cross-machine drill, the donor and the
  spender must be **different physical machines**; delegating a seat and
  spending it on the SAME machine *looks like* a working drill but proves
  nothing at all (it never touches the federation path this whole model
  depends on). WI-5410 was initially wired with both the donor (B) and
  the spend attempt on the same machine (tower) and hit a
  correct-but-initially-confusing refusal before this was caught. Anyone
  testing seat pooling will fall into this exact trap.
* **The spend path is the model to fix the delegate path to.** The
  spend side (`fleet:request_remote_spawn`) refuses an ambiguous hive
  **loudly** — the correct behavior. The delegate-side publish
  (EI-16667) skips the same ambiguity **silently** — the opposite failure
  mode from the identical root cause. WI-5445 (above) is the formal
  write-up of this pattern across all four surfaces; cite it when fixing
  any of them.

## Open question

The pot-visibility DB sub-investigation (exactly which query/column
`resource:offers`' `potShared` check consults, beyond confirming
`resource_allotments` has no `hive` column) was **not** fully chased down
here — flagged as an open question rather than resolved, since finishing
it would mean fixing EI-16673's code, out of scope for a docs pass.
