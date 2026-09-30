# lock authority — Track B of `distributed-coordination-shared-harness-2026-06-04`

The per-harness **lock authority**: the single point that serializes contended
control operations (file-claim locks, plan-item claim leases) across the machines
in a shared harness, so a mutual-exclusion grant never split-brains over the
eventually-consistent peer-log.

## Import surface

```ts
import {
  lockAuthorityFor,   // (harnessSlug) => { isSelf, peer?, liveCount }
  routeToAuthority,   // (harnessSlug, { local, remote? }) => { value, via, warning? }
  routeFileLockOp,    // file-claim scope-guarded routing (D-009)
  setPeerRpcTransport,// inject the wire transport when one exists
} from '@papercusp/operator-core/lib/authority';
```

## How the authority is chosen (D-005)

Not an election — a **deterministic function of live swarm membership**. The
authority for a harness is the peer with the **lowest live `device_pubkey`**
among the harness's `shared_presence` rows whose `last_seen_at` is within the
staleness window (`DEFAULT_AUTHORITY_STALE_MS = 90s`, the hysteresis knob). Every
peer computes this independently from the already-federated presence roster, so:

- No election round-trip, no leader-lease CAS race.
- **Failover is automatic**: when the current authority's heartbeat goes stale,
  the next-lowest live peer *is* the authority by definition. In-flight callers
  just re-resolve.
- Self is always a candidate (via `resolveUsageActor()`), even before this
  machine publishes its own presence row.

Edge case — **single box / no swarm**: zero live peers and no self identity →
`{ isSelf: true, liveCount: 0 }`. You are alone; you are the authority. This is
the current dev-box reality (one shared `papercusp_su`, PG advisory lock already
serializes).

## Routing + fail-open (D-004)

`routeToAuthority(harnessSlug, op)`:

| Situation | Behavior | `via` |
|---|---|---|
| We are the authority | run `op.local()` | `local-authority` |
| Remote authority, transport + `op.remote` present | RPC to the authority | `remote-authority` |
| Remote authority, unreachable / no transport / no `op.remote` | **fail open**: run `op.local()` + return a `warning` | `fail-open` |

Fail-open is **correct, not a compromise**: a shared harness is a git repo kept
in sync by git-sync with a merge-resolver, so concurrent edits are already
reconciled — git protects the data. Distributed locks only reduce merge churn.
Never block on an unreachable peer.

For su-119ce's plan-item claim leasing, wrap each claim op:

```ts
const { value, via, warning } = await routeToAuthority(harnessSlug, {
  local: () => claimStore.lease(/* … */),
  // when a transport lands, also pass `remote` so the authority leases on your behalf:
  // remote: { kind: 'claim.lease', payload: {...}, decode: raw => raw as LeaseResult },
});
if (warning) /* surface it */;
```

Until a transport exists, `remote` can be omitted entirely: on a single box
`isSelf` is always true (direct local lease); cross-machine it fails open to a
local lease + warning. Zero changes to your store when the transport lands.

## The RPC wire-leg (`peer-rpc-transport.ts` seam + `http-peer-rpc-transport.ts`)

The remote leg goes through a pluggable `PeerRpcTransport`. At boot,
`transport-wiring.ts` registers the real `HttpPeerRpcTransport` (POST to the
authority's `/api/authority/rpc`); a deployment rig can still override it via
`setPeerRpcTransport` after boot. With no transport registered at all (tests),
the default `NULL_PEER_RPC_TRANSPORT` reports every peer unreachable →
fail-open.

A transport MUST throw `PeerUnreachableError` (not a generic error) when it can't
reach the peer, so routing fails open rather than surfacing a hard error. The
HTTP transport maps no-address / network failure / non-2xx / `not_authority` to
`PeerUnreachableError` (fail-open) and `unknown_kind` / `handler_error` to a real
error (a genuine op failure on a reachable authority is never masked).

## The failure detector is a generic lib (`@papercusp/failure-detector`)

The signal that decides **when** a peer is stale enough to lose its authority /
have its lease revoked is φ-accrual + SWIM indirect probing. Those are pure,
domain-free algorithms, so they live in `@papercusp/failure-detector`
(`libs/generic/failure-detector`), not here — extracted from
`authority/{phi-accrual,swim-probe}.ts` by
`generalize-libs-to-generic-2026-06-05` (row #2). The cutover wires them as
`peer-eviction.ts` does — bind this module's `PeerRef` as the label:

```ts
import { PhiAccrualDetector, indirectProbe, decideEviction } from '@papercusp/failure-detector';

const result = await indirectProbe(target, relays, myRelayProbe, {
  label: (p: PeerRef) => p.machineLabel || p.devicePubkey.slice(0, 8),
});
const { evict } = decideEviction(detector.phi(now), result);
```

**Eviction is WIRED (P-016, shared-pot-hardening-2026-06-13).** `peer-eviction.ts`
(`AuthorityEvictionMonitor`) feeds a φ detector per peer from presence
observations, and `myRelayProbe` = `transportRelayProbe`: a `peer.probe` authority
RPC over the SAME `PeerRpcTransport` seam (the option-(c) Hyperswarm transport / the
HTTP one, via the composite). The relay (`peer-probe-op.ts`) answers from its OWN
federated presence view — so a peer one machine can't see but another can is kept
alive (the SWIM false-positive guard). `lockAuthorityFor` consults the monitor's
cached evicted set (sync; the probes run throttled in the background) and excludes a
relay-confirmed-dead peer from candidacy BEFORE the 90s staleness window.

Safety policy (stricter than `decideEviction`'s bare-φ option, by design): a peer is
evicted early ONLY when a REACHABLE relay fails to confirm it alive
(`confirmed-dead`). No relays / every relay unreachable / no transport → INCONCLUSIVE
→ keep (the 90s staleness floor, unchanged) — we never evict on our own blindness,
and single box / fail-open (D-004) is byte-identical to pre-P-016. Behind the
`papercusp-authority-eviction-probe` flag (DEFAULT OFF / dark): the LIVE
cross-machine eviction path rides the also-dark protomux transport and is
real-hardware-unverified (D-003, the P-003 two-machine proof). The
deterministic/loopback path is proven (`__tests__/peer-eviction.test.ts`,
`peer-probe-op.test.ts`).

## File-claim scope guard (D-009) — `routeFileLockOp`

ONLY file-claim / repo-root (`coordination_domain`) locks route to the authority
— they guard concurrent edits to the SHARED repo's files. NAMED-RESOURCE locks
(`dev-server`, `db-schema`, `shop`, …) guard MACHINE-LOCAL resources (each user
runs their own dev-server / embedded-pg) and **stay local** — they never call
`routeFileLockOp`.

`routeFileLockOp(domain, op)` maps the lock's `coordination_domain` (the repo
realpath) to a harness via an injectable resolver
(`configureFileLockDomainResolver`), then delegates to `routeToAuthority`. The
default resolver returns `null` (no federated harness) → run locally.

## Why a no-op today, load-bearing tomorrow

The shipping product is a desktop app backed by **embedded Postgres per machine**
(CLAUDE.md "Database topology"). Each machine then has its OWN `papercusp_su` lock
store, so a file-claim lock on a shared file genuinely needs a cross-machine
serialization point — the authority. On the current single shared-PG dev box
there is one `papercusp_su` and the PG advisory lock already serializes, so the
authority resolves to `isSelf` and routing is a direct local call. Correct in
both worlds.

## Cross-machine cutover — state at HEAD (2026-06-10)

All three cutover steps are **wired at boot** (side-effect import of
`agent-tools/locks/file-lock-authority-wiring.ts` from the agent-tools barrel):

1. ✅ **Transport** — `transport-wiring.ts` registers the `HttpPeerRpcTransport`
   (the one proven on Hetzner by `swarm-claim-dispatch.integration.test.ts`) via
   `setPeerRpcTransport` at boot, POSTing to the authority's
   `/api/authority/rpc` (which wraps `handleAuthorityRpc` + re-verifies it is
   the authority). (Handover, D-005: on becoming authority, a peer rebuilds its
   lock set from holders' re-asserted TTL heartbeats within one heartbeat
   interval; the brief gap is fail-open. INSTANT handover is now BUILT — P-015,
   shared-pot-hardening-2026-06-13: `lock-event-stream.ts` appends each
   authority grant/release as a `lock-event` op on the peer-log; a new authority
   reads the merged stream + folds it (`reconstructLockSet`) into
   `LockSetReconstructor.hydrateFromEvents` to reconstruct the live set
   immediately, falling back to the heartbeat-reassert rebuild when the stream is
   unavailable.)
2. ✅ **Hot-path routing** — `locks:acquire`/`release` route file-claim ops
   through `routeFileLockOp` (fed-reanchor-2026-06-06 P-060, cutover 2). The
   remote-peers cache keeps the no-peers common case near-zero-cost, and any
   routing-layer fault degrades to the raw local acquire.
3. ✅ **Domain→harness mapping** — `configureFileLockDomainResolver` /
   `configureFileLockHiveResolver` wired from the harness-registry snapshot.

**ADDRESSING — resolved via option (c)** (shared-pot-hardening-2026-06-13 D-005,
owner-ratified). The original residual was that `shared_presence` carries identity
(`device_pubkey`), not a network address, so `HttpPeerRpcTransport` had no
production address source — and a raw `:3070` URL can't reach a NAT'd desktop
anyway. The fix does NOT plumb an address: `authority-rpc-swarm-transport.ts`
multiplexes a `papercusp/authority-rpc` protomux channel onto the EXISTING
per-harness Hyperswarm connection (mirrors `cross-pot-swarm-transport.ts`; HELLO
carries `device_pubkey`; the connection IS the address — NAT already traversed).
`composite-peer-rpc-transport.ts` composes it IN FRONT of the HTTP transport
(addressable peers: the `PAPERCUSP_AUTHORITY_PEER_ADDRESSES` env map /
`configurePeerAddressResolver`), and `authority-rpc-swarm-wiring.ts` boot-wires it
behind flag `papercusp-authority-rpc-protomux`.

The flag is **DEFAULT OFF** (in `KNOWN_DARK_FLAGS`): the cross-machine path is
real-hardware-unverified (the in-process two-instance loopback
`__tests__/authority-rpc-swarm-loopback.test.ts` proves serialization at one
authority store, but reachability/NAT/latency need two machines — plan P-003,
`needs-human`). OFF is byte-identical to before: no flag → HTTP-only → no address
→ every remote-authority op fails open (D-004) with a loud warning. Flipping the
flag ON is the one remaining act, gated on the two-machine serialization proof.

## Tests

- `__tests__/lock-authority.test.ts` — 18 pure unit tests: argmin / isSelf /
  empty-set / dedup / staleness failover; routing local / remote / fail-open /
  rethrow; file-lock scope guard.
- `__tests__/lock-authority.integration.test.ts` — 5 tests against a real
  Postgres `shared_presence` table: the canonical query, argmin selection,
  remote-authority, staleness failover, empty-presence.
- `__tests__/transport-wiring.test.ts` — addressing precedence (configured
  resolver > env map > null), malformed-env degradation, boot idempotency,
  fail-open through the boot-wired transport.
- `__tests__/peer-rpc-transport.integration.test.ts` +
  `__tests__/two-instance-authority.integration.test.ts` (+ the pot variant) —
  the generic remote leg over real loopback HTTP: dispatch, serialization at one
  authority store, fail-open when unreachable.
- `__tests__/file-lock-authority-e2e.integration.test.ts` — the REAL file-lock
  leg end to end (P-006, coord-system-e2e-testing-2026-06-10): `routeFileLockOp`
  → boot-wired `HttpPeerRpcTransport` → loopback `/api/authority/rpc` mirror →
  the boot-registered `lock.*` handlers → the real PG su-lock store. Remote
  grant, cross-wire mutual exclusion + release, `not_authority` → fail-open,
  unreachable → fail-open, unmanaged-domain → pure local.
- `__tests__/lock-event-stream.test.ts` — P-015: the pure `reconstructLockSet`
  fold (acquire/release/expiry/last-write-wins/scope isolation), the peer-log op
  mappers, the sink/reader adapters, and the end-to-end instant-handover round-trip
  (sink → in-memory peer-log → reader → fold → `hydrateFromEvents`).
- `__tests__/lock-set-reconstructor.test.ts` — extended for P-015 hydration:
  instant rebuild (no fail-open gap), empty-stream fallback to the heartbeat path,
  expired-lock skip, and stream-seed + heartbeat-refresh composition.
- `__tests__/peer-eviction.test.ts` — P-016: φ observe/decay, the `decide`
  relay-confirmation safety policy (low-φ / no-relays / all-unreachable → keep;
  relay-alive → keep; relay-dead → evict), `refresh` evicts + self-heals, the
  `beforeSelect` sync-read + throttled background refresh, and the
  `selectAuthorityFromRows` exclusion (an evicted pubkey isn't the authority).
- `__tests__/peer-probe-op.test.ts` — P-016: the `peer.probe` handler, the
  authority-EXEMPT dispatch (a relay answers without being the authority), and the
  relay-probe over the `PeerRpcTransport` seam (single-box loopback-equivalent:
  crashed authority evicted, alive-via-relay kept, blind-relay → kept). The LIVE
  two-machine eviction proof is D-003 real-hardware-gated (needs-human).
