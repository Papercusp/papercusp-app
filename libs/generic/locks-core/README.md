# @papercusp/locks-core

Generic, **pure** concurrency + causality primitives for distributed
coordination. Zero I/O, zero timers, zero domain coupling — feed in values,
get back decisions; the host injects any persistence/transport.

Three modules (all extracted from `locks-correctness-hardening`):

## `hlc` — Hybrid Logical Clocks (Kulkarni et al. 2014)

8-byte `{ ms, count }` timestamps that keep a physical component (still
human-comparable, still track real time) plus a logical counter that never
regresses across an NTP step and carries happens-before across machines on
`recv()`. The software substitute for TrueTime. `compareHlc`, `encode/decode`,
`pack/unpack`, and a stateful `HlcClock` (`send`/`recv`) with an injectable
physical clock.

## `crdt` — state-based CRDTs (Shapiro et al.)

Merge **by type** instead of clobbering by timestamp, so concurrent updates
never silently drop:

- **PN-Counter** — tallies / spend (commutative add + subtract).
- **OR-Set** — add-wins sets (tags, members, watchers, relations).
- **LWW-Register** — genuinely-scalar fields, keyed on an HLC, applied per-field.
- **Version vectors / DVV** — *detect* concurrency vs causal succession.
- **`decideMerge`** — the Thomas Write Rule: apply the causally-later write,
  drop a stale re-upsert, and route a genuine conflict to a resolver.

Every merge is commutative, associative and idempotent (state-based / δ-CRDT),
so replicas converge regardless of delivery order or duplication.

## `intention-locks` — multi-granularity locks (Gray 1976)

The IS/IX/S/SIX/X compatibility matrix plus ancestor lock-set derivation and
conflict detection — so a leaf lock and a subtree/root lock correctly conflict
through their shared ancestors. Enables one-call subtree locks and lock
escalation. Pure matrix + protocol; a host layers persistence on top
(`@papercusp/locks`'s `granular-lock-store` is the Papercusp adapter).

## Seam

The lib decides; the host stores. `@papercusp/locks` keeps its PG-backed lock
store (`su-lock-store` / `granular-lock-store`) as the Papercusp adapter and
imports the intention matrix from here. The federation/lease surfaces stamp ops
with `hlc` and merge with `crdt` over their own outbox.

Pure → exhaustively unit-testable; the conformance tests live with the lib.
