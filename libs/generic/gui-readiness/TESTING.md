# Testing @papercusp/gui-readiness

Pure, deterministic unit suite — no live Tauri/desktop process required.
Timing-sensitive behavior (poll intervals, deadlines, cold-start latency) is
tested via an injectable fake clock/sleep pair (`options.now`/`options.sleep`),
so the suite runs in milliseconds of real wall time regardless of how large a
`timeoutMs` a given case exercises.

```bash
npm run test:file -- \
  libs/generic/gui-readiness/src/wait-until-ready.test.ts \
  libs/generic/gui-readiness/src/cold-start.test.ts \
  libs/generic/gui-readiness/src/adapters.test.ts
```

One case in `wait-until-ready.test.ts` — "NEVER hangs on a probe call that
never resolves" — deliberately uses REAL timers (no injected clock) with a
`checkReady()` that returns a promise that never settles. That's the direct,
executable proof of the library's core guarantee: the test asserts the call
returns well within a generous real-world bound, which a genuine hang would
blow through (the whole point being that it can't).

`adapters.test.ts` opens a real ephemeral TCP listener to exercise
`tcpPortProbe` end-to-end, and exercises `pidLivenessProbe` against the
current process's own pid (alive) and pid `0` (never alive) — no mocking
needed for either.
