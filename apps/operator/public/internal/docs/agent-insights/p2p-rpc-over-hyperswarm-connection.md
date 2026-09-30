# Add a P2P request/response RPC channel by riding the existing Hyperswarm connection
URL: /internal/docs/agent-insights/p2p-rpc-over-hyperswarm-connection

To reach a NAT'd peer for an RPC (lock authority, eviction relay-probe), don't resolve a URL — multiplex a protomux channel onto the connection the substrate already holds open. The connection IS the address. Mirror cross-pot-swarm-transport.ts; touch NOTHING in swarm.ts.

## What

When you need to send a **request/response RPC to a remote peer** in a shared pot
(the lock authority's `routeToAuthority`, B-05's eviction relay-probe, any future
cross-machine control op), the obvious design — "resolve the peer's `:3070` URL and
POST to it" — **does not work for the real topology.** Most peers are NAT'd desktops;
a raw operator URL is not reachable peer-to-peer. That was the standing `HttpPeerRpcTransport`
gap: `configurePeerAddressResolver` had no production source because `shared_presence`
carries `device_pubkey` (identity), not a network address.

The answer (shared-pot-hardening-2026-06-13 D-005, owner-ratified **option c**): the
substrate **already holds an open, NAT-traversed, encrypted Hyperswarm connection per
harness**, with a `protomux` muxer pinned at `socket.userData`, over which it already runs
the `papercusp/announce` channel. **Ride that connection.** The connection IS the address —
no URL, no mesh/tunnel layer, no addressing source to plumb.

## How (the pattern — copy `cross-pot-swarm-transport.ts`)

A standalone transport, NOT an edit to `sync/hyperbee/swarm.ts`:

1. Register your OWN `swarm.on('connection', …)` handler on the shared swarm **and**
   iterate `swarm.connections` for sockets that predate your wiring (the substrate forms
   harness connections at boot, before you register — they never re-emit `connection`).
2. On each socket: `Protomux.from(socket)` — this **reuses** the muxer already at
   `socket.userData` (corestore's replication muxer), so your channel rides the same
   connection as replication + the announce channel. Open a new protocol channel
   (`papercusp/authority-rpc`) with `c.json` encoding.
3. **HELLO-address by identity:** on channel `onopen`, send a HELLO carrying your
   `device_pubkey`. The remote records it; you route an outbound request to ONLY the
   channel whose `remoteDevicePubkey === peer.devicePubkey`. No broadcast.
4. **Request/response over fire-and-forget messages:** give each request a sender-unique
   id, keep a `pending: Map<id, …>` with a timeout, echo the id on the response. The
   RECEIVING side dispatches through the SAME pure `handleAuthorityRpc` the HTTP route
   wraps (with the identical `verifyIsAuthority` + EI-322 `verifyCaller` guards).
5. **Compose, don't replace:** keep `HttpPeerRpcTransport` for publicly-addressable peers
   (servers, the Hetzner rig). A `CompositePeerRpcTransport([swarm, http])` tries each;
   a `PeerUnreachableError` falls through, a non-unreachable error (reachable authority,
   real failure) is rethrown immediately and never masked.

Reference impl: `packages/operator-core/lib/authority/authority-rpc-swarm-transport.ts`
(+ `composite-peer-rpc-transport.ts`, `authority-rpc-swarm-wiring.ts`). Tests:
`authority-rpc-swarm-{transport,loopback,wiring}.test.ts`.

## Gotchas

* **Error mapping is load-bearing.** Map no-channel / timeout / closed-channel /
  `not_authority` → `PeerUnreachableError` (so `routeToAuthority` fails open, D-004 — git
  is the backstop). Map `handler_error` / `unknown_kind` / `unauthenticated` → a real
  `Error` (a genuine op failure on a REACHABLE authority must NOT be masked by fail-open,
  or you'll silently lose serialization on a real bug).
* **Don't touch `swarm.ts`.** The connection handler + `Protomux.from` reuse let the whole
  thing live in `lib/authority/` as new files — zero contention with the `sync/hyperbee`
  owners, and no risk to the delicate announce-channel lazy-pairing logic.
* **Testing without the network:** inject `protomux` (a minimal `ProtomuxLike` seam). For a
  two-instance loopback, link two fake channels (A's `send` → B's `onmessage`); that proves
  cross-"machine" serialization at one authority store in-process. The **real** cross-machine
  proof (reachability / NAT / latency) still needs two machines — keep it `needs-human`.
* **Roll out dark.** The cross-machine path can't be verified on one box, so ship behind a
  default-OFF flag (`papercusp-authority-rpc-protomux`, in `KNOWN_DARK_FLAGS`). OFF =
  byte-identical to today (no remote peers → no channels → fail-open). The flag-flip is the
  one act gated on the real-hardware proof. A runtime flip needs an operator reboot — the
  swarm + transport are boot-scoped.
