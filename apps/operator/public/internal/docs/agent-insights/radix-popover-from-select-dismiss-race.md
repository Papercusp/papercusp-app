# Opening a Radix Popover from a Radix Select selection — defer with setTimeout(0), not requestAnimationFrame
URL: /internal/docs/agent-insights/radix-popover-from-select-dismiss-race

When picking an item in a Radix Select (or DropdownMenu) opens a Radix Popover/Dialog, the popover flashes open then closes instantly ("clicking the menu item does nothing") — the trigger's still-draining close gesture (pointerup/focusout) is caught by the freshly-mounted dismissable layer as an outside-interaction. requestAnimationFrame does NOT escape it (it runs before the next paint, same task tail); setTimeout(…, 0) does. jsdom can't reproduce this — verify with a real-browser Playwright e2e.

import { Aside } from '@astrojs/starlight/components';

## The signature

You select an item in a Radix `Select` (or `DropdownMenu`), and that selection
is supposed to open a Radix `Popover`/`Dialog` (an editor, a detail panel, …).
In the real browser it **flashes open and closes in the same gesture** — to the
user, **"clicking the menu item does nothing."**

Concretely: the `/adv` Working-tab filter bar's `+ Add filter` `Select`, on
picking a column, set `editingKey` which opened the editor `Popover`. Clicking a
column did nothing.

## Why it happens

The selection handler fires *inside the Select's own close gesture*. Radix's
`Select`/`DropdownMenu` close on `pointerup`, and there are trailing
`pointerup` / `focusout` / outside-`pointerdown` events still draining from that
gesture. If you mount the `Popover` **synchronously** in the same tick, its
`DismissableLayer` registers its document listeners immediately and catches one
of those still-in-flight events as an **outside interaction** → it calls
`onOpenChange(false)` and dismisses on the same frame it opened.

## The trap: `requestAnimationFrame` is NOT enough

The obvious fix is "defer the open." But **`requestAnimationFrame` does not
escape the race** — rAF runs *before the next paint*, which is still inside the
same task tail as the Select's trailing pointer/focus events. So a rAF-deferred
open is dismissed exactly like the synchronous one. (Double-rAF also fails.)

`setTimeout(() => setOpen(true), 0)` schedules a **macrotask**, which runs only
after the current event/microtask queue (including the trigger's trailing
pointerup/focusout) has fully drained. By then the Select is closed and its
events are gone, so the Popover mounts cleanly and stays open.

```tsx
// ColumnFilterBar.tsx — the + Add filter Select
onChange={(key) => {
  if (key === ADD_FILTER) return;
  // NOT requestAnimationFrame: rAF runs before paint, still in the Select's
  // pointerup/focusout task tail, so the editor Popover is dismissed on open.
  // setTimeout(0) is a macrotask — it runs after those events drain.
  setTimeout(() => setEditingKey(key), 0);
}}
```

## Verifying it: jsdom can't, a real browser must

This is a **real-browser timing bug**. jsdom does not model the pointer-capture /
focus / dismissable-layer event ordering, so a jsdom component test passes on the
*broken* code — it will not catch this and will not prove a fix. Verify with a
**Playwright e2e in real Chromium** instead.

The committed guard is
`apps/operator/e2e/adv-work-items-filter.spec.ts`: it opens the Work items dock
panel, drives the real `+ Add filter` Select, and asserts the editor `role=dialog`
opens (then a chip + `wif` URL param). It was validated with a **causation
check** that is worth repeating for any fix of this class:

| open mechanism              | e2e result                             |
| --------------------------- | -------------------------------------- |
| synchronous `setOpen(true)` | **fails** (never opens)                |
| `requestAnimationFrame`     | **fails** (opens, instantly dismissed) |
| `setTimeout(…, 0)`          | **passes**                             |

## See also

* Plan `generic-column-filters-2026-06-14` (P-019) — the incident + fix.
* A jsdom component test could not have caught this; the durable guard is the
  Playwright e2e in the committed `apps/operator/e2e/` suite.
