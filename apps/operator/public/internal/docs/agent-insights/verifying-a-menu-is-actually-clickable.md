# Verifying a menu is actually clickable (not just "open")
URL: /internal/docs/agent-insights/verifying-a-menu-is-actually-clickable

A Radix menu can mount, position correctly, report fully visible — and still be unreachable by a real mouse. How to test the question that matters, and the four false-fails that waste probe cycles first.

**"The menu opens" and "a user can click it" are different questions.** Assert the second
one. This is the runbook distilled from WI-7211, where four probe cycles were spent proving
the wrong thing.

## The bug this exists to catch

Owner report: *"None of the option selector dropdowns are working in the bottom panel."*

Every menu opened correctly. `data-state` flipped to `open`, the options mounted, the popper
wrapper was present, the content measured 350×168 fully inside both the modal and the
viewport, and computed style reported `opacity: 1`, `visibility: visible`,
`pointer-events: auto`.

It was still completely unusable, because it painted **behind the app shell**.
`document.elementFromPoint()` at the menu's own centre returned `.oracle-empty-state` — the
chat placeholder sitting *behind* it in the DOM but *above* it in paint order.

The mechanism ([full decision](/internal/docs/plans) `session-popup-compaction-and-contrast-2026-08-02` D-004):
Radix wraps popper Content in `[data-radix-popper-content-wrapper]`, which is
`position: fixed`, so it establishes **its own stacking context**. A `z-index` set on the
Content only orders things *inside* that wrapper. Worse, Radix *copies* the Content's
computed z-index onto the wrapper as an **inline style**, which beats any stylesheet rule
without `!important`.

## The one assertion that matters

```js
const w = document.querySelector('[data-radix-popper-content-wrapper]')
const c = w.firstElementChild || w
const r = c.getBoundingClientRect()
const hit = document.elementFromPoint(
  Math.round(r.x + r.width / 2),
  Math.round(r.y + r.height / 2),
)
// TRUE only if a real mouse click at the menu's centre would land in the menu.
const reachable = !!(hit && c.contains(hit))
```

Check each option's own centre too — a menu can be partly covered. Everything else
(`data-state`, option count, computed opacity) is necessary but **not sufficient**, and each
of those reported "fine" while the bug was fully present.

## Why a jsdom test cannot cover this

**jsdom does not paint.** It has no stacking contexts and no hit-testing, so
`elementFromPoint` has nothing to say. `ChatActionBar.test.tsx` has 28 tests over these exact
Selects and all 28 stayed green throughout.

A jsdom test asserting "the menu opens" *cannot fail* on this defect, and will be read as
coverage — which is worse than having no test at all. Guard this class either with a **live
Tauri probe** or with a **static invariant** over the stylesheet. The one in the repo is
`apps/operator/app/_lints/popper-stacking.test.ts`, which asserts the wrapper has an explicit
z-index, that no shell layer stacks at or above it, and that no popper Content sets a z-index
below that floor.

Note the shell layers are higher than you will guess: `<main>` is promoted to `70`, and
`.oracle-dock--maximal-hud` reaches **1450**. A hand-picked "safely above" value of 90 was
still buried. Do not choose this number from the layers you happen to remember — let the lint
tell you.

## Four false-fails that will cost you a probe cycle each

Each of these makes healthy code look broken. All four were hit on WI-7211 before the real
bug was found.

1. **The open flip is ASYNC.** Reading `data-state` in the same tick as the click returns
   `"closed"` on a fully successful open. `sleep >= 1s` before asserting.
2. **`[aria-haspopup]` matches nothing.** A Radix Select trigger carries `role="combobox"` +
   `aria-controls` but *no* `aria-haspopup`. That selector silently returns null and reads as
   "the trigger is missing". Select by `[data-testid^="…"]`.
3. **"Radix ignores synthetic input" is not true here.** WebKitGTK has
   `PointerEvent`, `setPointerCapture`, `hasPointerCapture` and `releasePointerCapture` — all
   present. A dispatched `pointerdown`+`pointerup` pair (`{button: 0, pointerType: 'mouse',
   isPrimary: true}`) opens the menu, and so does a plain `.click()`. The real caveat is about
   **X11-level** synthetic input (xdotool into Xvfb), not JS-dispatched events.
   `ChatActionBar.test.tsx`'s `openPill` helper is the reference.
4. **Dispatching directly on an option bypasses hit-testing.** It will report the mode applied
   successfully even when no real mouse could ever reach that option — which is exactly the
   bug. Useful for proving the *apply path* works; useless for proving reachability.

## Driving it

`tauri-agent-tools` flags are easy to guess wrong, and a wrong flag fails *inside* a \~5 minute
verifier boot:

* `screenshot` takes `-o, --output <path>` — **not** `--out`
* `check` takes `--eval <js>` — **not** `--expr`
* `--help` is refused by the multi-bridge target guard, so read the flags from
  `dist/commands/*.js` (tracked as EI-19389052544654400)
* **Always** pass `--pid "$VERIFY_TAURI_PID"`. Without it the CLI attaches to an arbitrary
  bridge — frequently the owner's live desktop.

Closing UI work also needs a real artifact: the completion-integrity guard rejects
`verifiedHow: 'live-drove-ui'` unless the record cites a screenshot path or a recorded
`tauri-agent-tools` capture/screenshot/check invocation. A drive-by `eval` is not an artifact.
Plan a capture run into the work, not after it.
