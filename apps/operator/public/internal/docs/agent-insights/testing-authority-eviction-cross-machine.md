# Testing lock-authority eviction across machines (the ≥3-peer harness)
URL: /internal/docs/agent-insights/testing-authority-eviction-cross-machine

A φ+SWIM eviction proof needs ≥3 peers (a 2-machine test never evicts), and a PG-less frame supplies presence via an in-memory /alive heartbeat seam. How the eviction-agent harness proves P-016 over real Hetzner machines.

## What

The live cross-machine proof for P-016 (φ+SWIM authority eviction) — the
`eviction-agent.ts` harness under `packages/operator-core/lib/deployment/p2p-perf-tier3/`,
the eviction analog of `claim-agent.ts`. It runs $0 on loopback (CI) and paid across real
Hetzner frames, driven by `run-eviction-proof.ts` and gated in
`authority-eviction-cross-machine.integration.test.ts`. Two traps make this non-obvious.

**Proven 2026-06-13** (3 peers / 2 cpx31 ash frames): killing the authority → both survivors
φ+SWIM-evicted it in **4016 ms** while only **3536 ms stale** (vs the **90 000 ms** floor — a
\~25× margin), promoted the next live peer, and a survivor's `lock.acquire` crossed to it as
`remote-authority` (not fail-open). \~7.5 min, \<$0.50, 0 leaked VMs.

## Trap 1 — eviction is a ≥3-peer mechanism; a 2-machine test NEVER evicts

`authority/peer-eviction.ts decide()` returns **keep** when `relays.length === 0`, and
`relays = observed-non-self-peers − target`. With only 2 machines (the authority + the
corpse) the witness set is empty → the SWIM relay-confirmation can't run → no eviction, ever.
You need a **third** peer to vouch the suspect dead (`peer-eviction.ts` header: *"a real crash
in a ≥3-peer pot (witnesses exist + agree dead) → prompt eviction"*).

So the eviction proof is a **≥3-machine** gate — distinct from B-01's P-003 two-machine
lock-*serialization* proof. Don't inherit the "two-machine" wording from P-003; an eviction
test with 2 peers will pass-by-doing-nothing and prove nothing.

## Trap 2 — a bench frame is PG-less; swap the presence SOURCE, not the eviction logic

In production the φ detector + the witness's `peer.probe` (`defaultPeerLiveness`) both read
`harness_shared.shared_presence` from PG. A Hetzner bench frame has **no PG**
(`bench-bootstrap.ts` installs only the runtime). Rather than provision PG per frame, swap the
presence *source* exactly as `claim-agent` swaps the SQL claim store for an in-memory one
through a documented seam:

* every agent serves `GET /alive` and **polls every peer's `/alive`** each `heartbeatMs`,
  recording `lastSeenMs` — a real cross-frame heartbeat view. A real process kill freezes the
  dead peer's `lastSeenMs` from the survivors' vantage (a genuine cross-machine staleness signal).
* feed it to the φ detector via `LockAuthorityDeps.fetchPresenceRows`, and to the witness via
  `registerPeerProbeOp({ isPeerLive })` (the documented injection seam).

The **real** `AuthorityEvictionMonitor`, **real** `peer.probe` op + dispatch, and **real**
`HttpPeerRpcTransport` are unchanged — only *where liveness comes from* is swapped. The
substrate's actual cross-machine presence federation over the public DHT is proven separately
(pot-cross-machine P-011); this proof isolates the eviction *decision* chain.

## The A/B that makes it a proof, not a demo

`runEvictionProof({ evictionEnabled })`:

* **ON**: kill the authority → both survivors φ+SWIM-evict it and promote the next live peer;
  a survivor's `lock.acquire` lands on the promoted authority (`remote-authority`).
* **OFF** (pre-P-016 control): no monitor → survivors stay stuck on the corpse (still elected,
  because it's only seconds stale vs the 90s floor) → the acquire **fails open**.

Set `authorityStaleMs` to the **production 90s** and assert `deadStaleAtEvictMs < floor` — that
is the literal "eviction beats the staleness floor" claim, measured.

## Gotchas that cost a debug cycle

* **One-tick lag**: the evicted set updates live (background `refresh`) but a cached authority
  resolution lags one `heartbeatMs`. Re-resolve `lockAuthorityFor` **fresh** when you snapshot
  state, don't read a cached `lastResolution`, or a survivor reports the just-evicted authority
  for a beat and the "agree on new authority" assertion flakes.
* **Fast φ in a test**: `heartbeatMs: 300`, `evictionStaleMs: 1500` (witness's dead-vote window,
  > a couple poll intervals so jitter never false-evicts), `refreshThrottleMs: 300` → evicts in
  > \~2–3s. The witness window, not φ, gates the eviction time.
* **Poll a dead frame with a hard timeout** (`pollTimeoutMs`) and `Promise.allSettled`, or a
  hung TCP connect to the corpse stalls the whole heartbeat loop.

## How to run

```bash
# $0 local parity (CI) — 3 child processes on loopback:
cd packages/operator-core
npx vitest run --config vitest.integration.config.ts \
  lib/deployment/authority-eviction-cross-machine.integration.test.ts

# Real ≥3-VM Hetzner (3 peers over 2 frames; authority alone on frame 0):
HCLOUD_TOKEN=$(cat ~/.papercusp/hcloud-token) \
HETZNER_SSH_KEY_ID=114898429 \
HETZNER_SSH_IDENTITY_FILE=~/.ssh/papercusp-latitude-frame \
HETZNER_E2E_SERVER_TYPE=cpx31 P2P_PERF_HETZNER_LOCATIONS=ash,ash \
npx vitest run --config vitest.integration.config.ts \
  lib/deployment/authority-eviction-cross-machine.integration.test.ts
```

`provisionBenchFleet` sweeps leftovers at start + `teardownAll()` in a `finally`. Raise
`EVICT_E2E_FRAMES=3` (after raising the Hetzner account's 2-server limit) for 1 peer per VM,
which makes the witness relay-probe cross-machine too (the default 2-frame layout already makes
the *death detection* cross-machine; the relay-probe between co-located survivors is intra-frame).
Always verify 0 leaked VMs after: `curl -H "Authorization: Bearer $TOKEN" https://api.hetzner.cloud/v1/servers`.

## See also

* [Wiring the failure detector into the lock authority](/internal/docs/agent-insights/failure-detector-eviction-wiring) — the two wiring traps (reachable-relay gate + authority-exempt probe op).
* Plan `shared-pot-hardening-2026-06-13` D-010 (the arming + the ≥3-peer correction + exact φ/probe/timeout params).
