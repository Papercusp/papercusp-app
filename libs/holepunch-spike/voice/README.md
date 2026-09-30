# voice/ — P0 spike for holepunch-voice-channels-2026-06-05

Answers P-001/P-002 of the plan: **does the Holepunch transport carry real-time
voice frames from Node at acceptable latency/jitter, and how does UDX-native
compare to the realistic Hyperswarm path?**

Frames are *synthetic Opus* — fixed 80-byte payloads at 50 fps (20 ms). A real
Opus voice stream at 24–32 kbps is ~60–80 bytes per 20 ms frame, so this is the
correct wire shape; the spike measures **transport overhead**, not codec quality
(codec is a solved, separate concern).

Scripts (run from `libs/holepunch-spike/`, deps resolve from its `node_modules`):

- `node voice/01-udx-datagram-rtt.mjs` — two raw UDX sockets on loopback,
  unreliable datagrams (`socket.trySend`) ping-ponged. The **lower bound**: pure
  UDX + Node event-loop overhead, no DHT, no encryption.
- `node voice/02-swarm-frame-rtt.mjs` — two Hyperswarm peers discover via the
  public DHT, hole-punch, and stream framed audio over the **Noise-encrypted UDX
  stream** — the actual production voice-channel path. Includes discovery +
  encryption overhead.

## What loopback does and doesn't measure

Loopback isolates **stack overhead** (serialization, event-loop scheduling, UDX
framing, Noise encryption) — the genuine "is UDX-from-Node fast enough" unknown.
It does **not** include WAN RTT or real NAT hole-punch success; those are additive
and machine-dependent → the **cross-NAT run on a second machine** is the
remaining P-001 follow-up before the P-004 gate.

Acceptance feel: mouth-to-ear budget for "natural" interaction is ~150 ms one-way.
Codec+jitter-buffer+playout typically eats 40–80 ms, so the **transport** wants to
add only single-digit ms on top of WAN RTT. Loopback one-way should be ≪ 10 ms.
