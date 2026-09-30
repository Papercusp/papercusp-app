/**
 * hlc-stamp — the substrate's two HLC seams (shared-hive-hardening-2026-06-13 P-010).
 *
 * D-003 specified that LWW-federated writes carry a Hybrid Logical Clock so
 * `lwwPick` orders cross-peer conflicts by CAUSALITY rather than bare wall-clock
 * `ts` (a fast/stepped clock can otherwise resurrect a stale write or let a
 * skewed peer always win). The HLC primitives shipped in `@papercusp/locks-core`
 * (`processHlc`/`encodeHlc`/`decodeHlc`) but were NEVER wired into the
 * `sync/hyperbee` capture path — so until P-010 NO federated write carried an
 * `hlc` and `lwwPick` ALWAYS fell back to `ts`. This module is the one place that
 * couples the substrate to the process HLC clock:
 *
 *   - `stampOpHlc(op)` — the SEND seam. `handle.append` (`boot.ts`) calls it on
 *     every write funneled to the own log, so every LWW-federated op carries a
 *     causal order key. (Claims use the raw `ownLog.append` and are append-only
 *     distinct-key — they never LWW — so they correctly skip this.)
 *   - `observeRemoteHlc(hlc)` — the RECV seam. The apply path (`projection.ts`
 *     `applyOpVia`) calls it for every applied REMOTE op, advancing this
 *     process's clock past the remote causal frontier so a subsequent local
 *     write is stamped strictly-greater — the cross-machine happens-before that
 *     makes the order causal rather than skew-dependent.
 *
 * Both are additive + back-compat: an op without an `hlc` (pre-P-010 history,
 * the claim path) falls back to `ts` in `lwwPick`, so the field rolls out with
 * no flag day.
 */

import { encodeHlc, decodeHlc, processHlc, type HlcClock } from '@papercusp/locks-core';

/**
 * SEND seam: stamp a federated write with a causal HLC order key. A pre-set
 * `hlc` is PRESERVED (not overwritten) — a caller replaying a captured HLC keeps
 * it; everything else gets a fresh, process-monotone stamp. Returns the same op
 * shape with `hlc` guaranteed set.
 *
 * `clock` overrides the process-global HLC for callers that must NOT share it —
 * notably a test harness simulating MULTIPLE peers in ONE process: real peers
 * are separate processes with independent clocks, so a shared global clock would
 * interleave their stamps and break per-peer causal ordering (the two cells'
 * concurrent drains would race the same counter). Defaults to `processHlc()`.
 */
export function stampOpHlc<T extends { hlc?: string; ts?: number }>(
  op: T,
  clock: HlcClock = processHlc(),
): T & { hlc: string } {
  if (op.hlc) return op as T & { hlc: string };
  // Seed the HLC's physical component from the op's OWN recorded `ts` (the
  // write/capture time), NOT the wall clock at stamp time. The op is stamped at
  // DRAIN, which can be later than — and in a different order than — the writes,
  // so a bare `clock.now()` orders by drain-interleave instead of write order.
  // The projection's PG LWW guard orders by `fed_ts` (the write time); seeding
  // the HLC from the same write-time `ts` keeps the merge's HLC order consistent
  // with that guard, so a fold-winner is never silently rejected at PG (the
  // split-brain cross-cell DIVERGENCE). `send(physicalNow)` is built for exactly
  // this ("seed from an event's own recorded ms") and stays monotone via
  // bumpCount when `ts` is in the past. Undefined `ts` → falls back to now().
  return { ...op, hlc: encodeHlc(clock.now(op.ts)) };
}

/**
 * RECV seam: advance the HLC past an observed remote op's HLC, so a later local
 * write causally follows it. No-op when the op carries no `hlc` (pre-P-010 /
 * claim-path ops) — back-compat. Never throws: `decodeHlc` returns `HLC_ZERO` on
 * a malformed string, and `recv` of zero is a no-op advance. `clock` overrides
 * the process-global HLC — same multi-peer-in-one-process rationale as
 * `stampOpHlc` (each simulated peer advances ITS OWN clock on receive).
 */
export function observeRemoteHlc(hlc: string | undefined | null, clock: HlcClock = processHlc()): void {
  if (!hlc) return;
  clock.recv(decodeHlc(hlc));
}
