# A native Napi::Error/SIGABRT on process exit needs a no-cleanup hard exit, not a teardown-skip
URL: /internal/docs/agent-insights/native-sigabrt-on-exit-needs-a-no-cleanup-hard-exit

Why skipping the P2P substrate close never stopped the host-recycle SIGABRT (exit 134), and the reliable fix: SIGKILL self after the drain so Node's env teardown — where the native addon actually throws — never runs.

## The recurring crash

The long-running Hono host (`:3070`, the memory-watchdog recycle, cluster SIGTERM
drains) intermittently dies with:

```
terminate called after throwing an instance of 'Napi::Error'
… exited code=134   (128 + 6 = SIGABRT)
```

It self-heals (systemd / WI-3042 supervisor restarts), so it reads as "transient" —
but during the window the webview shows the recovery page and any in-flight
verification/session silently dies. Chased across WI-3795 → WI-3848 → WI-3849 →
EI-9649 → **EI-10702**.

## The two mitigations that looked like fixes and weren't

Both early mitigations assumed the **P2P substrate close** (`closeAllBootedHarnesses()`
— Hypercore/Hyperswarm) was the thrower and tried to *not start* it:

* **WI-3795/WI-3848** — `isSaturated` skip: don't close the substrate when the event
  loop is already elevated.
* **EI-9649** — `skipSubstrateTeardown`: unconditionally skip it for a memory recycle.

Both **still SIGABRTed** (EI-10702: the skip logged "skipping substrate teardown" and
the process aborted on the next line). The WI-3849 coredump forensics settled it:
**a symbol scan of every native addon actually mapped into the live process
(`/proc/<pid>/maps` + `nm -D`) found the P2P stack (sodium-native, udx-native,
quickbit-native, rocksdb-native, simdle-native) does not even *link* the `Napi::Error`
C++ class — it cannot be the thrower.** Only `sharp`, `onnxruntime-node`, and
`@lydell/node-pty` do. 2 of 4 live coredumps aborted with the substrate close skipped
entirely.

## The actual root cause

The abort is thrown during **Node's environment teardown on `process.exit()`** — a
native addon (an in-flight onnxruntime AsyncWorker completion, or a node-pty child-exit
callback) firing a napi callback *as the JS env is being disposed*. The C++ exception
escapes below the JS layer, so **no `try/catch` or `Promise.race` in JS can catch or
bound it** once `process.exit()` has begun. Skipping *one* native surface (the substrate)
does nothing when the thrower is a *different* addon on the generic exit path.

## The fix that works: don't run the teardown at all

`process.exit(code)` runs the env cleanup / native destructors — that is the crash
surface. When the process is **fully exiting anyway** (a recycle: the supervisor
restarts a fresh process and the OS reclaims every socket/fd/thread on exit), the
reliable fix is a **no-cleanup hard exit**: after the graceful HTTP drain completes,
`process.kill(process.pid, 'SIGKILL')`. SIGKILL is uncatchable and immediate — it runs
**no** env cleanup and **no** native destructor/callback, so the abort has no path to
fire. Exit becomes deterministic: no coredump, no `terminate called…`, no exit 134.
(`gracefulHostRecycle`'s `hardExitOnRecycle` option, wired into the memory-watchdog
`onTrip`. Default false so the SIGTERM/lag paths keep `process.exit` + a controllable
exit code for an intentional deploy stop.)

## The generalizable lessons

1. **A native `terminate`/SIGABRT below the JS layer is unreachable from JS.** If it
   fires during teardown, the only lever is to not run the teardown — or the whole
   process — the way that reaches it. On a fully-exiting process, SIGKILL-after-drain
   is that lever.
2. **Prove which native surface throws before mitigating one.** `nm -D` for the C++
   class symbol against the addons actually in `/proc/<pid>/maps`, plus a coredump that
   still crashes with your suspect skipped, is what turned two wrong-target mitigations
   into the right fix. A mitigation aimed at the wrong native surface *logs that it is
   protecting you* and doesn't — the most dangerous kind of half-fix.
