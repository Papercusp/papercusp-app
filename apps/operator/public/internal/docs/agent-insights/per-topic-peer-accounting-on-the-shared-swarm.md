# Per-topic peer accounting on the shared swarm
URL: /internal/docs/agent-insights/per-topic-peer-accounting-on-the-shared-swarm

Which per-topic peer count is honest, which two are traps, and where the only safe per-topic dial lever is — verified against hyperswarm 4.17.0.

If you need to answer **"how many peers does topic T have?"** or **"stop topic T
taking more of the peer budget"** on the process-shared Hyperswarm
(`packages/operator-core/lib/sync/hyperbee/swarm.ts`), read this first. Two of
the three obvious answers are wrong in ways that fail *silently*, and the useful
lever is not where you would look for it.

All line references are against the pinned **hyperswarm 4.17.0** in
`node_modules` (we do not float this dependency).

## The setup

There is **one** Hyperswarm per process (`getSharedSwarm`). Every harness joins
its own topic on it, and `maxPeers` is a **process-global** ceiling across every
topic. Hyperswarm enforces that ceiling **silently** — past it, peer N+1 simply
never connects: no error, no event. So "topic T is starved" and "topic T has no
peers available" look identical from the outside. That silence is why the
accounting has to be right: a wrong count produces a wrong throttle, which fails
the exact same invisible way as the bug you were fixing.

## Trap 1 — `peerInfo.topics` misses every inbound peer

The `connection` event carries a `PeerInfo` with a `topics` array, which looks
like ready-made attribution. It is not.

`PeerInfo._topic()` is called from exactly one place — `_handlePeer(peer, topic)`
(`index.js:451`) — whose own doc comment reads *"Called when a peer is actively
discovered during a lookup."* That is the **client/lookup path only**.

⇒ **Peers who discovered and dialled *us* arrive with an empty `topics` array.**
Any per-topic count built on it systematically under-reads inbound-heavy topics.
Used as a fairness input, it throttles the wrong topics — and, because the
under-read makes a busy topic look idle, it throttles them in the wrong
direction.

It is also living on borrowed time: `lib/peer-info.js:33` marks it
`// TODO: remove on next major`.

## Trap 2 — `swarmJoinSocketTopics` is a liveness registry, not a metric

The `WeakMap<socket, Set<topicHex>>` in `swarm.ts` looks like a socket→topics
index. But it is populated inside the **per-join** connection handler, and on a
shared swarm *every* harness's handler fires for *every* socket, each adding its
**own** `topicHex`. Every socket therefore ends up registered under every joined
topic.

⇒ Every topic reports the same number (the total socket count). It is genuinely
useful for "is this socket still doing anything for anyone" (that is what it was
built for) and useless as attribution.

## The honest gauge — `contentPeerCountForTopic(topicHex)`

`swarm.ts:655`, backed by `contentPeerMuxersByTopic`. A topic's entry is added
when its `(muxer, topic)` **announce channel opens** and removed when it closes,
so it counts distinct live peers the hive is genuinely content-replicating with.

It counts inbound peers correctly because announce-channel pairing is
**symmetric**: `openAnnounceChannel` runs for every socket in both directions and
pairs via lazy-accept `mux.pair({ protocol })`. It is also our own structure, so
no upstream deprecation risk.

**Use this one.**

## The lever — `PeerDiscoverySession.refresh({ client, server })`

`swarm.join(topic, opts)` does not return the `PeerDiscovery`; it returns a
**`PeerDiscoverySession`** (`index.js:501-521` → `discovery.session(opts)`), and
that session exposes `refresh({ client, server, limit })`
(`lib/peer-discovery.js:310-330`).

Setting `client: false` decrements `_clientSessions`; at zero the `PeerDiscovery`
stops its lookup, so no new dial candidates are enqueued **for that topic**.
Established connections are untouched, and it is fully reversible.

Three constraints, each of which will bite:

* **It throws if `client` and `server` are both false** (`peer-discovery.js:312`).
  Always keep `server: true` — which you want anyway: a topic that has stopped
  dialling should keep *announcing* so it can still be found and dialled by
  peers.
* **It resets `discovery.limit`** to the `limit` argument (default `Infinity`).
* **`rejoinOwnSession` reassigns `discovery`** on a forced rejoin. Anything that
  holds a session must hold a **getter closure**, never a captured reference, or
  it will end up toggling a destroyed session while the live one dials on
  unthrottled.

The two levers you might reach for instead are both dead ends: the **firewall**
is topic-blind (Hyperswarm hands it only a remote public key), and **eviction**
drops live peers, which is the harm you are trying to prevent.

## `maxClientConnections` — a second budget knob we were not using

`maxClientConnections` defaults to **`Infinity`** (`index.js:15`) and gates
dialling at `index.js:183`, independently of `maxPeers`. Left unset, outbound
dialling can consume 100% of the peer budget, at which point inbound peers of
*every* topic are refused — including topics with no outbound peers at all.
That is a starvation axis no amount of *between-topic* fairness can reach, so it
wants its own reserve.

## Two design rules this produced

**A level-based evaluator must be timer-driven when the thing it guards
suppresses its own events.** At the peer cap, `connection` events stop firing —
so an evaluator hung off connections can never *resume* a topic it paused. It
would pin the throttle on forever and recreate the original bug. Ride the shared
refresh loop (`registerSwarmRefresh`); do not add a timer, and do not drive this
off connections.

**Engage only under pressure.** Below a global-pressure threshold there is no
scarcity to arbitrate, so any per-topic bound is pure downside. Keeping the
mechanism a strict no-op until the budget is actually contended is what makes it
safe to ship into live federation code.

## See also

* `swarm.ts` — `evaluateSwarmFairness`, `contentPeerCountForTopic`,
  `reportPeerCapPressure`, `resolveMaxClientConnections`
* `swarm-topic-fairness.test.ts` — the differential tests (same topology, low vs
  high load, opposite outcomes)
* WI-6063 / plan `shared-hive-cross-machine-scale-10k-2026-06-29` (P-009)
