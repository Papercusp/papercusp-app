# The fed_hlc LWW comparator is non-transitive under MIXED HLC presence
URL: /internal/docs/agent-insights/lww-comparator-non-transitive-under-mixed-hlc

lwwPick / the fed_hlc PG guard used to use "both-HLC → compare HLC, else → compare ts" — a rule that CYCLED when a no-HLC (pre-314) op sat between two skewed HLC ops, so the fold winner became order-dependent and peers could diverge (EI-1698). FIXED as of 2026-07-02 (compare in one HLC space, everywhere) — plus a follow-up exact-tie/node-id fix (WI-1672, mig-459) and a THIRD hardening, the HlcClock recv ratchet ε-bound (maxDriftMs) that stops one absurd remote stamp from poisoning a node's (and, re-propagated, the pot's) clock.

## What

`lwwPick` (`packages/operator-core/lib/sync/hyperbee/projection.ts`) and the PG
`fed_hlc` guard (each mutable projection's `ON CONFLICT … WHERE` / `DELETE WHERE`,
mig-314) decide the LWW winner with the SAME rule:

> if **both** ops carry an `hlc` → compare HLC; **else** → compare `ts` (wall clock).

That rule is **NOT transitive** when HLC presence is *mixed* (some ops carry an
HLC, some don't) AND clocks are skewed (an HLC op's HLC order inverts its `ts`
order — the recv-advance case HLC was built for). A non-transitive comparator
makes the reduce-fold winner depend on **delivery order**, so two peers folding
the same ops in different orders **diverge** on a contended key.

This is **EI-1698** (filed 2026-06-19, severity minor/**latent**).

## The cycle (deterministic minimal repro)

```
X = { hlc: HIGH, ts: 100 }   // upgraded peer, recv-advanced HLC, low ts
Y = { hlc: none, ts: 150 }   // pre-314 peer, NO hlc, mid ts
Z = { hlc: LOW,  ts: 200 }   // upgraded peer, low HLC, high ts

lwwPick(X, Y) = Y   // mixed → ts fallback: 150 > 100
lwwPick(Y, Z) = Z   // mixed → ts fallback: 200 > 150
lwwPick(X, Z) = X   // both HLC  → HIGH > LOW
⇒ X > Z, Z > Y, Y > X   — a 3-cycle.

reduce(lwwPick, [X,Y,Z]) = Z     // but
reduce(lwwPick, [Z,Y,X]) = X     // ⇒ order-dependent winner = divergence
```

## Why it's LATENT (don't panic, but don't leave it for the re-key)

The cycle needs a no-HLC op with `ts` **between** two HLC ops. Post-P-010,
`stampOpHlc` stamps **every** LWW write, so no-HLC LWW ops are only **pre-P-010
history = the OLDEST `ts`** on a key. An oldest no-HLC op sits at the *bottom* of
the key's `ts` order (loses every mixed comparison on `ts`), so the comparator
degenerates to a transitive HLC-ordering among the newer ops → it converges. The
divergence is reachable only if a no-HLC op has a mid/recent `ts` — which the
production "no-HLC = oldest" distribution does not produce. So: a proven defect,
not an active incident.

It still matters because the same comparator is **load-bearing for the C-001
re-key** (a member needs epoch-N's key before epoch-N content, ordered by
`fed_hlc`). Adding epoch complexity on top of a non-transitive mixed comparator is
risk worth removing first.

## The fix — LANDED

Compare in **one order space**: synthesize an HLC from `ts` for a no-HLC op at
compare time, in BOTH `lwwPick` and the PG guard:

```ts
const key = op.hlc ?? encodeHlc({ ms: op.ts ?? 0, count: 0 }); // missing hlc → ts-as-HLC
```

Then every comparison is HLC-space → a single total order → transitive →
order-independent for ANY HLC-presence mix. **Both halves have now landed:**
`lwwPick` (`projection.ts`) does the compare-time synth inline (2026-06-20);
mig-458 (`libs/papercusp/libs/db/sql/458-fed-order-key-transitivity-fix.sql`,
2026-07-02) gave the PG-level guard the SAME fix via a small immutable SQL
function, `harness_shared.fed_order_key(hlc, ts)`, and swept EVERY mutable
projection's `ON CONFLICT … WHERE` / `DELETE WHERE` guard onto it (32 projection
files as of 2026-07-03, and growing as new mutable projections land — `grep -rl
fed_order_key packages/operator-core/lib/sync/hyperbee/projections/ | wc -l`) —
so the guard now
compares in the *exact* order space `lwwPick` does, on every table, not just in
`lwwPick` alone.

This is **verified**, not argued — see
`__tests__/fed-hlc-transitivity-fix-proof.test.ts`: a 600-run sweep shows the
synth-HLC comparator is ALWAYS a strict total order (`win-counts {0,1,2}`) while
the broken "both-HLC → HLC, else → ts" rule cycles (`{1,1,1}`). (The test still
models both comparators locally rather than importing the real ones — that's a
test-hygiene follow-up, not a sign the fix is unapplied; the code cited above is
the actual load-bearing path.)

## Update 2026-07-02 — a SECOND, related defect: exact-HLC ties (WI-1672)

Fixing transitivity did not fix everything in this area. Federation testing
(P-015) found a **live split-brain on an EXACT `fed_hlc` tie**: two peers whose
HLC clocks sit at the same wall-ms frontier (routine after any transient
fast-clock episode — `hlc_recv` ratchets every peer to the max ms ever
witnessed) can mint the IDENTICAL HLC for two DIFFERENT concurrent writes to the
same key. Every guard's tie-ACCEPTING compare (`fed_order_key(EXCLUDED…) >=
fed_order_key(stored…)`) then lets the incoming remote op overwrite the local
row on BOTH peers — the two peers stably SWAP winners instead of converging.
Live-reproduced on the wi1544 rig: both frames independently minted the same
`001783025829985:00417` stamp for different content.

**The fix (mig-459,
`libs/papercusp/libs/db/sql/459-hlc-node-id-total-order.sql`):** make the
ordering key total *by construction* — append a per-clock node-identity
segment, so an HLC string is `"<15-digit ms>:<5-digit count>:<16-hex node>"`.
A genuine full tie can then only be the SAME stamp replayed (where tie-accept
is correct/idempotent). `harness_shared.hlc_now()` mints the node-carrying
3-segment form; `hlc_recv()` parses both 2- and 3-segment encodings; the
`@papercusp/locks-core` HLC type gained an optional `node` field
(`compareHlc`/`encodeHlc` in `libs/generic/locks-core/src/hlc.ts`) that breaks
`(ms, count)` ties by node — absent ⇒ `''`, so a legacy (pre-459) stamp always
loses a tie to any node-carrying stamp, on every peer, identically. No
comparator code changed: `fed_order_key` passes the HLC through verbatim and
`lwwPick` already does a plain string compare, so a 3-segment stamp just sorts
correctly through the existing machinery.

## Update 2026-07-02 (later) — a THIRD hardening: bound the recv ratchet (ε drift clamp)

Node-id (previous section) makes an exact tie total-orderable, but a SEPARATE
risk in the same family is the recv ratchet itself: `HlcClock.recv()` always
advanced the local clock's `ms` up to `max(local, remote, physical)`. One
absurd remote stamp (a bad clock, a corrupted/adversarial payload, a
far-future `ms`) would permanently pin the receiving node's clock years
ahead — and because every subsequent local `send()` re-stamps at that poisoned
`ms`, a re-propagated event ratchets every OTHER peer the same way, so a
single bad stamp can drag the whole pot's clocks forward (the same
"amplifier" shape as the WI-1672 exact-tie bug, just via the physical
component instead of the tie-break).

**The fix (`libs/generic/locks-core/src/hlc.ts`, `HlcClock`):** `recv()` now
clamps the ratchet to an ε bound — `maxDriftMs` (constructor option, default
`600_000` = 10 minutes, 2× the announce-admission skew window so any
legitimately-admitted peer still ratchets us normally). A remote `ms` more
than `maxDriftMs` ahead of the local physical clock is treated as absent for
ratchet purposes (`remote = { ms: 0, count: 0 }` before the `max()`) — the
poisoned stamp still applies to the DATA it was attached to, it just doesn't
advance THIS node's clock. `processHlc()` (the process-wide federation clock)
uses the default bound; tests cover both the clamp firing and a legitimate
in-bound skew still ratcheting normally (`hlc.test.ts` → `describe('HlcClock
recv drift clamp')`).

No comparator or encoding changed here — this is a clock-input guard, not an
ordering-key change, so it composes with both the transitivity fix (first
section) and the node-id tie-break (previous section) without touching them.

## How to test / reproduce

* Comparator + cycle: `fed-hlc-transitivity-fix-proof.test.ts` (PG-free, the proof-of-fix).
* End-to-end through the real merge + `fed_hlc` guard:
  `version-skew-mixed-hlc-backcompat.test.ts` (Brief Y / AC scenario 6). Note
  MONOTONE-clock mixed universes DO converge (rolling-upgrade back-compat holds in
  the normal case); only SKEW + mixed reaches the cycle.
* Recv ratchet ε-bound: `libs/generic/locks-core/src/hlc.test.ts` →
  `describe('HlcClock recv drift clamp')` (an absurd-future remote does not
  ratchet; an in-bound skew still does; `maxDriftMs` is configurable).

## Gotcha for new work

Any new comparison or LWW path that treats "has HLC" and "no HLC" with *different*
comparison **modes** (rather than mapping both into one order) re-introduces this
non-transitivity. Map a missing HLC into HLC-space (synth from `ts`) instead of
switching to a `ts`-mode branch. Separately (WI-1672): any new comparator built
directly on `(ms, count)` without the `node` segment re-introduces the exact-tie
split-brain — always compare via the full encoded HLC string (or `compareHlc`),
never hand-roll a `(ms, count)`-only compare. And any new caller that merges a
REMOTE HLC into a local clock should go through `HlcClock.recv()` (or its
`maxDriftMs` bound) rather than a bare `Math.max` — an unbounded ratchet
re-introduces the same amplifier one absurd stamp can poison the whole pot with.

## Refs

* EI-1698 (the finding + the proof-of-fix comment) · `shared-pot-release-testing/findings-Y.md`
* WI-1672 (the follow-up exact-tie/node-id finding, found in P-015 federation
  testing) · mig-459 `hlc-node-id-total-order.sql`.
* The recv ratchet ε-bound (`maxDriftMs`) hardening in `HlcClock.recv()` — same
  WI-1672 amplifier family, landed as defense-in-depth after the node-id fix.
* Adjacent: D-001 `fed_hlc` ordering (`lww-hlc-fedts-divergence.test.ts`), mig-314,
  mig-458 (`fed_order_key()`), `hlc-stamp.ts`, `@papercusp/locks-core/hlc.ts`.
* Adjacent but DISTINCT (not an ordering bug — do not expect node ids to fix it):
  WI-1684, local-del resurrection under skipOwnOps (no tombstone) — see
  `agent-insights/federation-public-release-known-limitations` §4a; pinned by the
  WI-1684 teeth test in `convergence-fuzz.test.ts`.
