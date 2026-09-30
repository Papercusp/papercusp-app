# @papercusp/gui-readiness

Generic, domain-free GUI process/window readiness barrier + cold-start
measurement. Designed for exactly one failure mode: **an edge-triggered
readiness wait hangs forever against a persistent app process.**

## The problem this solves

A naive "wait until the app is ready" helper is usually built around a
one-shot signal — grep a log for the line that appears once at startup,
resolve a promise the first time a `did-finish-load`/`ready` event fires,
wait for a state *transition*. That works fine the first time you launch the
process. It **hangs forever** the moment you instead *attach* to a process
that was already running before you started watching: the one-shot signal
already fired in the past, so it will never fire again, and the wait blocks
indefinitely.

This library never does that. Every probe is **level-triggered** — it asks
"is it ready *right now*", not "has it *become* ready since some earlier
instant" — and every wait carries a **hard wall-clock deadline** plus a
**per-probe-call timeout** plus an optional **process-liveness fail-fast**.
Concretely:

- Attaching to an already-ready persistent process resolves on the very
  first check, immediately — no poll delay, no dependency on catching an
  event you may have missed.
- A process that never becomes ready still returns (an `ok:false` result),
  never hangs, once the configured `timeoutMs` elapses.
- A single wedged/never-resolving `checkReady()` call can't consume (or
  exceed) the whole budget — it's bounded by its own `probeTimeoutMs` and
  the loop just tries again on the next poll.
- A timed-out or failed liveness sensor is treated as **unknown**, not as
  evidence that the process died. Only an explicit `false` produces
  `reason: 'process_exited'`.
- A dead process (via an optional `LivenessProbe`) fails fast with
  `reason: 'process_exited'` instead of waiting out the remaining deadline
  for a readiness signal that can no longer arrive.

## Quick start

```typescript
import { waitUntilReady, measureGuiColdStart, pidLivenessProbe, tcpPortProbe } from '@papercusp/gui-readiness';

// Just wait for readiness (works the same whether you just launched the
// process or are attaching to one that might already be up):
const outcome = await waitUntilReady(
  { checkReady: () => myAppHealthCheck() },
  pidLivenessProbe(child.pid),
  { timeoutMs: 30_000 },
);
if (!outcome.ok) throw new Error(`app not ready: ${outcome.reason}`);

// Measure cold-start ONLY for a genuinely fresh launch:
const launchedAtMs = Date.now();
const child = spawn(...);
const cold = await measureGuiColdStart(
  { checkReady: () => myAppHealthCheck() },
  pidLivenessProbe(child.pid),
  { origin: 'launched', launchedAtMs, timeoutMs: 30_000 },
);
console.log(cold.coldStartMs); // birth → ready, in ms — null if it didn't succeed

// Attaching to a process that MIGHT already be running — never hangs, and
// never fabricates a cold-start number for a process whose birth you didn't see:
const attached = await measureGuiColdStart(
  { checkReady: () => myAppHealthCheck() },
  pidLivenessProbe(existingPid),
  { origin: 'attached', timeoutMs: 5_000 },
);
attached.coldStartMs; // always null for origin: 'attached'
```

## API

### `waitUntilReady(probe, liveness?, options): Promise<ReadinessOutcome>`

- `probe: { checkReady(): Promise<boolean> }` — required. Called
  repeatedly; must reflect *current* state.
- `liveness?: { isAlive(): Promise<boolean> }` — optional. When the
  underlying process/window has a distinct liveness signal (a pid, a socket),
  pass it so a dead process is detected immediately instead of waiting out
  the deadline.
- `options.timeoutMs` — required. There is no "wait forever" mode.
- `options.pollIntervalMs` — non-negative; default 250.
- `options.probeTimeoutMs` — positive; default `min(timeoutMs, 5000)`.
- `options.now` / `options.sleep` — injectable clock/delay for deterministic
  tests; real `Date.now`/`setTimeout` by default.

Returns `{ ok: true, ready: true, elapsedMs }` or
`{ ok: false, ready: false, elapsedMs, reason: 'timeout' | 'process_exited' }`.

### `measureGuiColdStart(probe, liveness?, options): Promise<ColdStartResult>`

Same wait, plus `options.origin: 'launched' | 'attached'`:

- `'launched'` — you observed the process's birth; pass `launchedAtMs`
  (defaults to "now" at call entry). `coldStartMs` is the birth→ready
  latency when the wait succeeds.
- `'attached'` — you don't know when the process was born (it may be a
  long-lived, persistent process that was already running). `coldStartMs`
  is **always `null`** — reporting "how long this call happened to wait" as
  a cold-start number would be fabricated, not measured, for a process
  whose birth this call never observed.

Returns `{ ok, ready, origin, waitedMs, coldStartMs, reason? }`.

### Adapters (optional convenience)

- `pidLivenessProbe(pid): LivenessProbe` — `process.kill(pid, 0)`-based
  liveness for a plain OS pid.
- `tcpPortProbe(port, host?, connectTimeoutMs?): ReadinessProbe` — ready
  once a fresh TCP connect to `host:port` succeeds.

Both are thin and optional — write your own tiny probe (an authenticated
HTTP health check, a DOM/webview eval, a debug-bridge round-trip) whenever
your readiness signal is richer than "can I open a socket".

## See also

- `/internal/docs/testing/agent-e2e` — the Tauri desktop E2E playbook this
  library is a general-purpose building block for (readiness/cold-start
  timing is a recurring need across that playbook's isolated-instance
  scripts and health probes).
- `@papercusp/tauri-verify` — a Tauri-specific verification surface
  (app-ready/route/scope assertions) built on the same underlying
  `tauri-agent-tools` dev bridge; complementary, not overlapping — that
  library asserts *what state the app is in*, this one answers *is it ready
  yet, and how long did that take*.
