# Standalone hyperswarm transports — discovery.refresh() loop is the ONLY driver that connects (+ the protomux pair/id traps)
URL: /internal/docs/agent-insights/standalone-hyperswarm-discovery-driver

A standalone (non-corestore) hyperswarm transport — directory-swarm, cross-pot — never forms a connection via discovery.flushed() OR swarm.flush() on the current hyperswarm/hyperdht: the first DHT round after join reliably misses and nothing retries for minutes. The only working driver is a per-topic discovery.refresh() loop. Multi-topic transports on the shared deduped swarm additionally need (protocol, id: topic) channel keying, a mux.pair() lazy-accept notifier (or late topic joins can NEVER pair — protomux rejects unmatched opens and the remote never re-opens), a null-check on createChannel, and the socket.userData muxer convention. Found + fixed 2026-06-09 via the pot-directory live two-peer E2E.

import { Aside } from '@astrojs/starlight/components';

The P2P pot directory (`p2p-pot-directory-2026-06-06`) shipped data-plane-complete
with 117 green tests — and had **never once connected over a real socket**: every
transport test used a fake swarm + fake Protomux. The first live two-peer run
(`lib/sync/hyperbee/__tests__/pot-directory-live-two-peer.test.ts`, real Hyperswarm
on a `hyperdht/testnet.js` loopback testnet, production `wireHiveDirectoryAtBoot` on
both peers) sat at 0 connections forever. So did the cross-pot live test
(`cross-pot-two-pot.test.ts`, `RUN_LIVE_HYPERSWARM=1`) — the pattern it was built
on had **rotted**. Three distinct root causes; all are general traps for ANY
standalone hyperswarm transport in this repo.

A transport that does NOT ride `corestore.replicate` must drive discovery with a
**per-topic `discovery.refresh()` interval loop**. Nothing else connects.

## 1 — The discovery driver: refresh-loop or nothing

On the current hyperswarm/hyperdht, the first announce/lookup round after
`swarm.join(topic)` **reliably misses** on a fresh DHT node, and nothing internal
retries for minutes. Probe matrix (throwaway vitest on a 3-node loopback testnet —
note a standalone `npx tsx` script can't reach the testnet, run probes as vitest):

| Driver after `join(topic, {server:true, client:true})` (both peers)     | Result                    |
| ----------------------------------------------------------------------- | ------------------------- |
| per-topic `discovery.refresh()` on a 1–2.5s interval                    | **CONNECTED in \~1.1s** ✅ |
| nothing (bare join)                                                     | 0 connections after 8s ❌  |
| `void discovery.flushed()` (the old directory-swarm driver)             | 0 connections ❌           |
| `await discovery.flushed()`                                             | resolves, still 0 conns ❌ |
| `swarm.flush()` once or looped (the old cross-pot driver, since rotted) | 0 connections ❌           |
| `await swarm.dht.ready()` then join                                     | 0 connections ❌           |

The corestore path (`joinHarnessSwarm` + `corestore.replicate`) still connects in
\~525ms with `void discovery.flushed()` — only **standalone** transports are
affected. Both standalone transports now run the refresh loop:
`directory-swarm.ts` (`DEFAULT_REFRESH_MS = 2500`) and
`cross-pot-transport.ts` (`refreshAll()` — its live test went from a 180s
timeout to passing in \~700ms). An earlier memory/comment claimed `swarm.flush()`
was the proven standalone driver and `discovery.flushed()` "poisons" it — that
account is **superseded**; don't resurrect either driver.

## 2 — Multi-topic transports: key channels by `(protocol, id: topic)`

Hyperswarm **dedupes connections per peer**: one A↔B socket serves every topic
both ends share. Two consequences that broke the directory:

* **Per-topic `connection` handlers are wrong.** A topic joined after the socket
  exists never sees it. One gossip instance (`createDirectoryGossip`) owns ONE
  handler + a live-socket set, and a late `joinTopic` retroactively opens its
  channel on every existing socket.
* **Same-`(protocol, id=null)` channels collide.** Protomux `createChannel` with
  the default `unique: true` returns **null** for a second live channel with the
  same key on one muxer — so with the global + an invite topic joined, only one
  topic ever got a channel, and invite announces were silently dropped. Key every
  channel `{ protocol, id: topic }`; pairing then matches per topic, which is also
  the **invite-scoping**: no shared topic → no pair → no frame. **Always
  null-check `createChannel`** (latent unguarded calls existed in `swarm.ts`'s
  announce channel and the cross-pot channel; both now guard).

## 3 — Late joins need a `mux.pair()` lazy-accept notifier

Protomux **REJECTS** an inbound channel-open with no matching local channel
(`_requestSession` → reject + GC) — and the remote **never re-sends** its open.
So even with per-topic ids, a peer that joins a topic late (the
`joinInviteTopic` flow) could never pair: the other side's open was already
rejected at connect time. The fix is corestore's own pattern — register a
**pair-notifier per muxer**:

```ts
mux.pair({ protocol: HIVE_DIRECTORY_PROTOCOL }, (id) => {
  const st = topics.get(id?.toString('hex') ?? '');
  if (st) openTopicChannel(socket, st); // MUST createChannel SYNCHRONOUSLY
});
```

The notify must `createChannel` **synchronously** (before returning/awaiting) to
consume the pending open, else protomux rejects it when the notify resolves.
Accepting only joined topics keeps the scoping intact.

## 4 — One muxer per socket: the `socket.userData` convention

`Protomux.from(socket)` reuses `socket.userData` when set but does **not** set
it. Hypercore's `createProtocolStream` sets it; a standalone transport that runs
first must do the same (`if (!socket.userData) socket.userData = mux`) so
corestore replication / cross-pot / directory share one muxer in **any** attach
order — two muxers on one stream corrupt framing.

## Cadence: two-speed, not flat

The refresh loop is **fast (2.5s) only inside a 30s post-join window** — several
full DHT rounds — then backs off to a **60s keepalive**, so a permanent topic
(the global directory) doesn't hammer the public DHT forever. Losing a topic's
last paired channel re-arms its fast window (snappy reconnection). The cross-pot
transport's background timer applies the same logic, while its `send()` dial loop
still refreshes unconditionally.

## Where this is pinned

* `lib/sync/hyperbee/__tests__/pot-directory-live-two-peer.test.ts` — the live
  directory E2E: bidirectional public discovery, member-links across the wire,
  LWW edit convergence, invite no-leak + late invite join. Runs in the normal
  unit suite (\~6s).
* `lib/cross-pot-two-pot.test.ts` (`RUN_LIVE_HYPERSWARM=1`) — the live
  cross-pot wire.
* `lib/sync/hyperbee/directory-swarm.test.ts` — fake-muxer unit coverage of the
  gossip (per-topic keying, lazy accept, late join, two-speed refresh, scoped
  broadcast).
* `papercusp-desktop/bin/two-instance-hive-directory-smoke.sh` — the
  **packaged full-app-stack proof** (PASSED 2026-06-09): two separately-packaged
  `.deb` instances, distinct real GitHub identities, isolated testnet DHT —
  `discovery:set_pot` on A → listed (owner-verified, member-links intact) on
  B's `GET /api/discovery/pots`, bidirectional. Also exercises the
  `ensureHiveDirectoryWired` lazy wire (a fresh install boots zero harnesses, so
  the boot-join has nothing to ride; the first publish/browse self-heals it).
* `papercusp-desktop/bin/two-instance-hive-from-repo-smoke.sh` — the
  **create-from-repo → discover → join-offer → join loop**
  (pot-from-github-url-2026-06-11 P-019, PASSED 2026-06-11): A POSTs
  `/api/harness/pots/from-repo` (public, Cupboard pointed at an unreachable
  port → `bindingUnverified:true` degradation proven) → B discovers the pot +
  member-links over the testnet directory → B pastes the SAME repo URL and gets
  the JOIN OFFER (`existing.kind='pot'`, `source='directory'` — the announce's
  `member_repos` repo-id match end-to-end) → B joins via the offered link
  (`clone_repo` done). Two modes: `deb` (the template path, static-gated on the
  packaged serve.mjs carrying `pots/from-repo`) and `sidecar` (the documented
  fallback: the same `src-tauri/sidecar/serve.mjs` artifact the .deb ships, run
  directly under the bundled node — full stack minus the Tauri window). The
  green run used sidecar mode (the on-disk .deb predated the from-repo backend).

Same-host limits still apply: a loopback **testnet** connects fine, but raw
hyperswarm holepunch between two processes on one physical host over a real DHT
does not — see
[vm-federation-separate-machine-proof](/internal/docs/agent-insights/vm-federation-separate-machine-proof).
On genuinely separate machines the refresh-loop driver connects over the **real
public DHT** just as fast: the two-machine run (dev box behind NAT ↔ a Hetzner
frame, production gossip on an invite-scoped topic) discovered bidirectionally
in \~5s each way (2026-06-09). Plan record: D-007..D-010 @
`p2p-pot-directory-2026-06-06`.
