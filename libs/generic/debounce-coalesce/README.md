# @papercusp/debounce-coalesce

A generic **per-subscriber wake-floor + burst-coalesce** primitive — a leading-edge
debounce that enforces a minimum re-invocation interval per subscriber and folds the
events suppressed inside the window into ONE delivery carrying their union.

Pure algorithm. No clock, no storage, no I/O — the host injects `now` (epoch ms) and
persists the per-subscriber `FloorState` between evaluations. Zero domain coupling, zero
runtime deps. The payload `T` is whatever the host carries on a fire.

## Why

Re-invoking an agent ("a wake") costs a full-context turn = tokens. An agent that
registers a wake on a hot, recurring key would be re-woken on every fire, burning a turn
each time. This primitive bounds that: at most one wake per `minSleepMs`, and the fires
suppressed in between coalesce into the next wake instead of being lost.

Generalized from the pot operator's bespoke `potWakeFloorSec`/`withinWakeFloor` so that
**every** `wake:true` subscription (not just the pot) gets the floor + coalesce — see
`unify-watch-primitive-2026-06-06`.

## Knobs (`FloorConfig`)

- `minSleepMs` — the floor; `<= 0` disables it (every fire wakes — for one-shot grants).
- `maxStalenessMs?` — force a wake mid-window once a pending fire ages past this.
- `leadingEdge?` (default `true`) — first fire after idle wakes immediately; `false` =
  trailing edge (anchor the floor on the first pending fire).

## API

```ts
import { decideWake, onFire, coalesce, nextDueAt, withinFloor, clampToFloor, emptyFloorState } from '@papercusp/debounce-coalesce';

// Pump-style: each tick, pass the subscriber's pending fires + their last wake time.
const d = decideWake({ lastWokenAt, pending, now, cfg });
if (d.wake) deliverOneWake(d.coalesced); // the union of all coalesced fires
else scheduleNextTickAt(d.dueAt);        // when the floor next allows a wake

// Debounce-only helpers (the pot uses these — it drops suppressed fires, no union):
withinFloor({ lastWokenAt, minSleepMs, now, urgent }); // true = suppress
clampToFloor({ requestedAt, minSleepMs, now });        // raise a too-soon time
```

`urgent: true` on any fire bypasses the floor and wakes now. See `src/index.ts` for the
full typed surface and `src/index.test.ts` for worked examples.
