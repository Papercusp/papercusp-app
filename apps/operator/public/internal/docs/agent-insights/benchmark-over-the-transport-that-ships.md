# Benchmark over the transport that ships — loopback HTTP numbers do not transfer to Tauri IPC
URL: /internal/docs/agent-insights/benchmark-over-the-transport-that-ships

A sync-layer redesign was planned on :3070 loopback-HTTP measurements. Re-measured inside the Tauri shell the optimum moved 2x (concurrency 12 -> 24) and the low setting REGRESSED past the design it replaced. How to measure the desktop transport, and the two confounds that will invert your result.

## The trap

Papercusp's content layer is reachable two ways: plain **loopback HTTP** on
`:3070`/`:3170`, and the **webview→sidecar IPC bridge** inside the Tauri shell.
`curl` and any node script reach the first one. Only the shipping product uses
the second.

So the cheap way to benchmark anything in the sync path — loop a script against
`:3070`, chart the numbers — measures a transport **no user is ever on**. That
is exactly how `drop-sync-batcher-2026-07-25` was planned, and the numbers were
not merely imprecise, they pointed at the wrong setting.

## What actually differed

The plan replaced a request batcher with individual requests through a
bounded-concurrency gate, and had to pick a default max-in-flight. Same 106
sync queries, same code, both transports:

|                         | loopback HTTP (`:3070`)    | Tauri IPC (shipping)     |
| ----------------------- | -------------------------- | ------------------------ |
| wall @ conc 6 → 24      | **flat** (1126ms → 1106ms) | **not flat** (see below) |
| conc 12                 | —                          | 4981ms wall, p50 212ms   |
| conc 24                 | —                          | 2922ms wall, p50 395ms   |
| one bundle (old design) | 2676ms                     | 3000ms                   |

Over loopback, wall time was flat across the whole range, which says *pick the
low end — concurrency is free here and per-query latency is better there*. That
reasoning is sound and the conclusion is wrong: over IPC the curve is steep, and
at the low end (12) the new design's wall **regresses past the batcher it was
replacing** — the one outcome that would have made the whole change a net loss.
The default had to be 24.

Per-invoke overhead across the bridge is small (\~2ms; sequential median 18ms IPC
vs 16ms raw) and the bridge is genuinely parallel — so the invoke leg is not the
story. What changes is how the *server* behaves under a concurrent wave that
arrives via a different path, contending for the same PG pool and event loop.

## Measure it like this

Attach to a running shell and drive it headlessly — no focus steal, no human.
Full playbook in [testing/agent-e2e](/internal/docs/testing/agent-e2e); the
short version:

```bash
cd papercusp-desktop && npm run dev      # or attach to an already-running shell
tauri-agent-tools eval '<expression>'    # runs INSIDE the webview
```

Run your timing loop in that `eval`, not in a node script. The webview is the
only place the IPC path exists.

## The two confounds that will invert your result

Both of these bit during this measurement; the first produced a **published
number that had to be retracted**.

1. **Cold cache absorbs the whole cost of whichever condition runs first.** The
   first run showed the batcher winning by 2x (4895ms vs 9493ms) — pure
   ordering artifact. Condition A paid for every cold resolver, PG plan, and
   connection; B inherited a warm system. **Warm up first, then interleave the
   conditions round-robin**, several rounds, and compare medians. Interleaving
   inverted the result completely.

2. **Wall time is not the user-visible metric.** At equal wall time, N
   individual requests and one bundle are *not* equivalent: the bundle paints
   nothing until its slowest member lands, so its effective p50 **is** its wall.
   Individual requests painted at p50 395ms against a 3000ms bundle — a \~7.6x
   better time-to-first-paint at parity on wall. Record both, and say which one
   the decision rests on.

## The general rule

**A benchmark inherits the transport it was taken over.** Before a measurement
justifies a default, a design, or a deletion, check that it was taken over the
path that ships. If it wasn't, it is a hypothesis, not evidence — and a comment
citing it will be obeyed by everyone who reads it afterwards.

When both sets of numbers are worth keeping, keep both *and label them*, as
`query-fetcher.ts` now does: the shipping number drives the default, the
loopback number is marked non-transferable so nobody "restores" it later.
