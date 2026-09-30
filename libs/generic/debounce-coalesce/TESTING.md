# Testing — @papercusp/debounce-coalesce

`npm test` (vitest) from this directory, or via the repo's affected-test walker.

## Covered (`src/index.test.ts`)

- **coalesce** — union build (count / latest / urgent), throws on empty.
- **decideWake, leading edge** — wakes on the first fire after idle; suppresses inside the
  floor window; wakes (coalescing the burst into ONE) once the window elapses.
- **The exact gap** — a hot recurring stream (a fire every 100ms) wakes at most once per
  `minSleepMs`, each wake carrying the union; no fire is woken twice; fires still inside
  the latest window correctly remain pending.
- **Urgency bypass** — an urgent fire wakes immediately mid-window (and still carries the
  suppressed non-urgent fires).
- **Max-staleness** — a pending fire forces a wake once it ages past `maxStalenessMs`.
- **minSleep<=0** — disables the floor (every fire wakes).
- **Trailing edge** — `leadingEdge:false` anchors the floor on the first pending fire.
- **nextDueAt / onFire / withinFloor / clampToFloor** — the helper surface.

## Not covered here

Pure algorithm only. The PG-backed application of this core (the await delivery pump's
per-subscriber floor over `event_wake_deliveries`, and the pot's wake debounce) is tested
in `packages/operator-core` (`events/await/engine.test.ts`, `pot/wake.test.ts`).
