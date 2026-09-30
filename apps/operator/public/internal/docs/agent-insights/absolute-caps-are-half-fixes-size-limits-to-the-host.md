# An absolute cap is a half-fix: a limit tuned on a big host re-appears as a bug on a small one
URL: /internal/docs/agent-insights/absolute-caps-are-half-fixes-size-limits-to-the-host

A resource cap chosen to tame the 128-core dev box was a hardcoded constant, so it never scaled DOWN — the same knob shipped as a 4-core CPU burn on an 8-vCPU packaged guest. Plus the diagnostic tell that finds this class: high process CPU with loopLag=ok means native threads, not the event loop.

## The trap

You find a resource knob melting the box, so you cap it. The cap is a number that
works *here*. Ship it — and you have fixed exactly one end of the range.

**WI-3792** (128-core dev host): ONNX Runtime defaults its intra-op thread pool to
EVERY core and spin-waits idle threads, so every process that lazily loaded an
embedder grew a \~128-thread spin pool — loadavg 2000-3000, host-wide stutter. The
fix pinned `intraOpNumThreads: 4`. Correct, effective, and it held for a year.

**EI-20493854163389792** (8-vCPU packaged guest): the same `4`. On a fresh Ubuntu
install the packaged operator averaged **415.2% process CPU** (360/418/422/465/411
over 5×1s pidstat samples) while the first-run UI sat idle. Four threads is 3% of
the incident host and **50% of a user's machine**.

The bug was never the value. It was that the value was **absolute**. A cap written
as a constant only ever clamps hosts BIGGER than the one you tuned on; every host
smaller than that inherits the tuning as a share it cannot afford.

## The tell that finds this class

`/api/health/deep` reported `loopLag pressure=ok` at the same instant the process
was burning four cores. That combination is diagnostic, not contradictory:

> **High process CPU + a healthy event loop ⇒ the burn is on NATIVE threads, not
> your JS.** Don't go looking for a hot loop in the JavaScript — there isn't one.

Node's main thread caps at one core. Anything above \~100% sustained is the libuv
threadpool, a `worker_threads` pool, or a native library's own pool (ORT, sharp,
zlib, crypto). Conversely, a saturated main thread shows up as loop lag and rarely
exceeds 100%. The two symptoms point at disjoint suspects — read them together
before you start bisecting.

Two corollaries that made this one hard to see:

* **A background sweep looks like idleness.** First run is the worst case for
  embed-backfill (nothing is embedded yet), so the pool stays hot precisely while
  the user is doing nothing. "Idle UI" is not "idle process".
* **Whose PID pays depends on a fallback.** The embedder runs in-process whenever
  the embed sidecar is absent — and that sidecar is opt-in. So a cost you'd expect
  on a sidecar lands on the operator's own PID in the packaged build.

## What to do instead

Express a background-work cap as a **share of the host**, bounded at both ends:

```ts
export const MAX_INTRA_OP_THREADS = 4;          // ceiling: the big-host fix
export const BACKGROUND_HOST_SHARE_DIVISOR = 4; // never more than ~1/4 of the box

export function resolveIntraOpNumThreads(hostCores: number): number {
  if (!Number.isFinite(hostCores) || hostCores < 1) return 1; // floor, never "auto"
  return Math.max(1, Math.min(MAX_INTRA_OP_THREADS,
    Math.floor(hostCores / BACKGROUND_HOST_SHARE_DIVISOR)));
}
```

* **Both ends.** A ceiling alone re-creates this bug; a share alone re-creates
  WI-3792 on a 128-core box. You need the min AND the max.
* **Floor to 1 on a bad reading.** A `0`/`NaN` host-size reading must degrade to
  one thread, never fall through to the library's all-cores default — that failure
  is silent and host-wide.
* **`os.availableParallelism()`**, not `os.cpus().length`: it respects the CPU
  affinity mask, so a pinned or containerised process sizes to what it may
  actually use.

## Writing the guard

The regression test must fail on a *revert to a constant*, which means asserting
**relativity**, not a number:

```ts
expect(resolveIntraOpNumThreads(4)).toBeLessThan(resolveIntraOpNumThreads(64));
expect(resolveIntraOpNumThreads(8)).toBeLessThan(4); // the 0.0.16 value
```

Any host-independent constant makes the first line equal and fails it. Asserting
only `<= MAX` would have passed happily on the broken code — that is precisely the
assertion WI-3792 left behind, and why this shipped.

Two things that bit while writing it:

* **A source-shape assertion must read code, not comments.** `expect(src).not.toMatch(/intraOpNumThreads:\s*\d+/)`
  flagged the file's own incident write-up, which *quotes* the bad literal while
  explaining it. Strip comments before matching, or your guard fires on the
  documentation of the bug it guards against.
* **When a value is duplicated across a TS module and a plain-JS mirror** (a worker
  script can't import TS), compare the two by their **constants + shared formula**,
  not by a computed number — the number is host-dependent and only agrees on the
  machine CI happens to run on.

## Where else this shape lives

Anywhere a limit was picked against one machine: thread pools, worker counts,
batch sizes, concurrency ceilings, cache sizes, poll cadences. Ask of each one —
*what does this do on a box 16× smaller than the one it was tuned on?* If the
answer is "the same thing", it is an absolute cap, and it is half a fix.
