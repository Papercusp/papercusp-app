# Voice spike results — 2026-06-05 (loopback, Linux x64, Node 25.9)

Plan: `holepunch-voice-channels-2026-06-05` P-001/P-002/P-003 + P-006/P-014 mesh.
80B synthetic-Opus frames @ 50fps, 300 frames/run.

| # | Path | conn setup | RTT p50 | p95 | p99 | max | loss |
|---|---|---|---|---|---|---|---|
| `01` | raw UDX datagram | n/a | 0.226ms | 0.409ms | 0.787ms | 5.65ms | 0% |
| `02` | Hyperswarm encrypted UDX stream (public DHT) | ~4.9s | 0.311ms | 0.556ms | 1.247ms | 13.6ms | 0% |
| `05` | WebRTC datachannel (node-datachannel) | ~1.0s | 0.450ms | 0.701ms | 0.862ms | 1.01ms | 0% |
| `04` | IPC unix-socket binary bridge (P-003) | n/a | 0.209ms | 0.437ms | 0.672ms | 1.77ms | 0% |
| `03` | 4-party mesh (3 peers, aggregate) | ~8.9s | 0.414ms | 0.719ms | 1.272ms | — | 0% |

## Verdict (Phase 0, loopback)

- **Transport overhead is negligible.** Encrypted UDX stream adds ~0.08ms p50 over raw
  datagrams; real mouth-to-ear will be dominated by WAN RTT + jitter buffer, not the stack.
  **P-001 loopback = PASS.**
- **UDX-native vs WebRTC (D-004):** UDX-native (0.31ms) beats WebRTC datachannel (0.45ms) on
  loopback, AND avoids a second native dep, AND reuses Holepunch's own encrypted stream +
  discovery. WebRTC's only edge here (faster local connect, ~1s) evaporates in production where
  it needs external signaling + STUN/TURN, which Holepunch's DHT replaces. **→ UDX-native; keep
  WebRTC documented as the fallback if cross-NAT hole-punch proves inadequate. P-002 = DONE.**
- **IPC bridge (P-003) = PASS:** binary-safe (0 corrupt over all byte values), lossless, one-way
  ~0.1ms. The operator-as-local-node audio bridge (D-002) is viable — needs a binary unix-socket
  channel, NOT the UTF-8 `sys:http` path.
- **Mesh (P-006/P-014) = PASS at 4-party:** one Node node held 3 concurrent encrypted peer
  streams, 900 frames, 0 loss, p50 0.41ms. **10-party did NOT converge in-process** (only 3/9
  peers in 60s, ~47s setup) — a *harness* limit: 10 Hyperswarm instances + 10 UDP sockets all
  announcing/looking-up on the public DHT in one event loop. Not a product finding (real
  10-party = 10 machines). A faithful upper-bound belongs in the cross-NAT/multi-process run, or
  via a local DHT bootstrap + separate processes. Steady-state per-stream latency is unaffected
  (proven 2- and 4-party).
- **Connection setup grows with peers** (~4.9s @ 2-party → ~8.9s @ 4-party via public DHT).
  Acceptable for "join channel" but a known optimization target (cached peer addr / persistent
  swarm / local bootstrap).

## Two-node + TRUE cross-NAT runs (2026-06-05, later same session)

| Pair | Path | connect | RTT p50 | jitter | loss | verdict |
|---|---|---|---|---|---|---|
| host ↔ QEMU-slirp VM (`06`) | host-local shortcut (`10.10.0.2`, the `papercusp` WG iface addr) | 4.0s | 0.98ms | 0.21ms | 0% | two-OS path works; NOT a NAT test (co-located VM short-circuits) |
| home originator → Ashburn echoer | — | TIMEOUT 60s | — | — | — | **FAIL: firewalled↔firewalled** (Hetzner *cloud* FW drops inbound UDP — host nft has NO INPUT chain; raw-UDP probe confirmed external drop). **hyperdht did NOT auto-relay.** |
| **Ashburn originator → home echoer** | **genuine internet** (saw `38.229.109.7` ↔ `178.156.250.24` — real reflexive addrs, not the WG tunnel) | **1.9s** | **38.8ms** | **1.2ms** | **0%** | **PASS — home NAT traversed, direct UDP, real WAN** |

### Cross-NAT findings (the P-013 answers)

1. **Direct P2P voice across the real internet between two different networks WORKS**: 0% loss,
   ~39ms WAN RTT (home↔Ashburn), 1.2ms jitter, one-way transport ≈19ms — well inside the ~150ms
   mouth-to-ear budget.
2. **Reachability is the whole game**: one punchable/reachable side → instant success; both sides
   firewalled (cloud FW dropping UDP) → **total failure with NO automatic relay fallback**.
   ARCHITECTURE REQUIREMENT: each peer-pair needs ≥1 UDP-reachable or punch-friendly peer, or we
   must provide an explicit relay. A *cloud* fleet peer needs one UDP port opened in its cloud
   firewall (host-level nft is already open on ours).
3. The home NAT here punched fine (server dialed our announced reflexive addr directly). The
   success-RATE across diverse NATs (CGNAT, symmetric↔symmetric) remains a field/beta question.

## What Phase 0 still does NOT cover

1. **Real Opus codec** in the loop (synthetic frames — correct wire shape, not real audio).
2. **N-peer MIX compute** with a real decoder — pending the audio stack (P-005).
3. **NAT-diversity success rate** (CGNAT/symmetric↔symmetric) — field/beta measurement.
4. Relay implementation for the firewalled↔firewalled case (now a known requirement, see D-009).

## Run

    cd libs/holepunch-spike
    node voice/01-udx-datagram-rtt.mjs
    node voice/02-swarm-frame-rtt.mjs
