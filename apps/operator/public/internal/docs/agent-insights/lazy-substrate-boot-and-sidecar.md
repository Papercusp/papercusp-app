# Lazy substrate boot (LAZY_SUBSTRATE_BOOT) + why the sidecar (SUBSTRATE_SIDECAR) stays dark
URL: /internal/docs/agent-insights/lazy-substrate-boot-and-sidecar

How the LAZY_SUBSTRATE_BOOT eviction reaper works (v1 evicts only inert private engines; the swarm-presence keepalive for idle SHARED harnesses is v2), and the evidence that SUBSTRATE_SIDECAR is a pervasively-coupled multi-session re-architecture that must NOT be flipped on.

## TL;DR

* **`papercusp-lazy-substrate-boot` is DEFAULT-ON (v1, WI-596).** A 60s reaper
  (`substrate-eviction-reaper.ts`) tears down idle, **inert private**
  (swarm-less, peerless) harness substrate engines via the pure
  `planSubstrateEviction` policy, bounding operator RSS sub-linearly in harness
  count. OFF is byte-identical eager boot.
* **`papercusp-substrate-sidecar` stays DEFAULT-OFF (genuinely incomplete, WI-604).**
  P-009 was dropped; the substrate is pervasively coupled to the main process.
  Flipping it on is a no-op-but-wasteful spawn, or — if naively cut over —
  breaks federation. Do **not** flip it without the full re-architecture.

## Lazy boot: the safety boundary that makes v1 flippable

The eviction RULE (`substrate-eviction-policy.ts`, a pure tested function) never
evicts an `active-peer`, `pinned`, or `hot` harness. The **v1 wiring**
(`boot-all.ts` `gatherBootedHarnessFacts`) tightens this further: a harness with
a **live swarm** (`handle.swarm != null`) or **any admitted remote peer**
(`handle.admitted.size > 1`) is reported `pinned`/`hasActivePeer`, so it is
**never** evicted.

Why that is safe-by-construction: a **private** (swarm-less) harness's substrate
engine is *pure overhead* — it merges nothing (no peers) and its local writes go
**PG-direct**. Tearing it down loses no federation state, so the EI-126
fleet-divergence class is off the table for v1. Consumers null-handle an evicted
engine gracefully (`feature-queue` → `substrate-off`, claims → legacy
single-writer — never data loss), and an evicted engine **re-boots on access**
(`getBootedHarness` fires a background `bootSingleHarness` for a key in the
`evicted` set) or on the next boot-all reconcile.

The race between the reaper's fact snapshot and the close is closed by
`evictBootedHarnessEngine` **re-checking** freshness + swarm/peer state
*immediately before* `closeBootedHarness` — if the harness got hot or gained a
peer since the snapshot, the eviction is skipped.

The whole path is gated by `enableSubstrateEvictionTracking()` (called only when
the reaper starts, i.e. the flag is ON), so the **OFF path is byte-identical** —
`getBootedHarness` does no extra work, no reaper runs.

### Current-fleet reality (why v1 is correct but currently inert)

`dev:dogfood_substrate_status` on the live operator shows **one** booted harness
(an internal reference harness), which is **shared + peered** → the reaper correctly evicts
nothing today. The path-liveness filter in `boot-all` (skip registry entries
whose project path is gone) already bounded the original O(harness-count) RSS
problem. v1 is ready to act when idle *private* harnesses exist; the real
at-scale win is v2.

### v2 (WI-662, NOT done): evict idle SHARED harnesses

The value-at-scale slice is evicting idle **shared-but-currently-peerless**
harnesses while a **lightweight swarm-presence keepalive** (D-004) re-boots them
on a later peer connection / a `substrate_outbox` NOTIFY / an access. This is
divergence-critical and **cannot be verified on a single box** — it needs a real
2-machine federation peer rig. It is the SAME flag (no new flag); it only widens
the `pinned = swarm != null` boundary + adds the keepalive + a swarm
peer-connection reboot hook.

## Why SUBSTRATE\_SIDECAR cannot just be flipped on

The substrate engine is **pervasively coupled** to the main operator process:

* **5+ hot-path consumers call `handle.append()` in-process, synchronously:**
  feature-queue enqueue/dequeue, distributed-claim, work-item-claim-lease,
  authority lock-events, presence. Routing these over IPC adds 10–50 ms/append
  and loses append-atomicity (PG write then a racing IPC append).
* **2 in-process background loops bound to the live handle:** the outbox-drain
  (`LISTEN substrate_outbox` → `handle.append` per row) and the 1 s merge-poll
  driver (→ PG projections).
* **The sidecar bin only built the socket-handoff replication spike.**
  `apps/operator/bin/substrate-sidecar.ts` stubs `bootHarness`, swarm-join, the
  merge loop, admission, and the PG projection writers ("later phase").
* **The wrapper never actually cuts over.** `bootSubstrateWithFallback` spawns
  the sidecar + healthz, then **falls back to in-process boot** — so even ON it
  is a no-op-but-wasteful spawn.

A real cutover means the sidecar must HOST the full `bootHarnessSubstrate`
(corestore + swarm + merge loop + PG projections) and the main process must
route every `handle.append()` over IPC and read PG-only — or a narrower
"replication-offload" design (main keeps the engine, hands raw swarm sockets to
the sidecar for `corestore.replicate`, the part already built) that offloads only
the merkle-verify CPU/RSS. Either is a tracked multi-session feature, never an
overnight flip. (Orthogonal to lazy boot per D-018/D-019.)
