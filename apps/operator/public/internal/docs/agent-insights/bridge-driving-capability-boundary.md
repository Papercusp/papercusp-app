# The capability boundary of bridge-driven E2E (what synthetic events can and can't test)
URL: /internal/docs/agent-insights/bridge-driving-capability-boundary

tauri-agent-tools bridge eval drives navigation/render/console/DOM-state/API-mutations reliably, but CANNOT activate Radix/cmdk widgets (tabs done right, popovers, palette onSelect, certain buttons) or trigger value-tracked form autosave via synthetic events. Route those to real-input/committed Playwright. Confirmed across EI-1531, round-3, round-5 J2/J5.

## What

Driving the desktop UI via the `tauri-agent-tools` bridge (`eval` dispatching
synthetic DOM events) has a HARD capability boundary. Knowing it stops you
mis-filing test-driving limitations as product bugs (the EI-1531 trap) and tells
you which surfaces need real input or the committed Playwright suite instead.

## RELIABLE via bridge synthetic events (use freely)

* **Navigation / routing** — SPA-router nav via `history.pushState({},'',url) +
  dispatchEvent(new PopStateEvent('popstate'))`. (Full-page `location.href` can
  wedge in the dev-wrapper webview — pushState is the reliable path.)
* **Render / mount** — element presence, headings, `main.innerText`, route
  resolution, error-boundary detection.
* **Console-cleanliness** — a persistent `console.error`/`onerror`/
  `unhandledrejection` hook (install once, idempotent) is authoritative.
* **DOM-readable state** — grid rows (the work-items grid is DOM-rendered, NOT
  an opaque canvas — round-5 corrected round-3), filter chips, nuqs URL params
  (`?tab=`, `?sel=`, `?wif=`), `aria-checked`/`aria-pressed`/`aria-expanded`.
  Column filters: set `?wif=state:passed` and COUNT the visible rows — they
  filter correctly and you can verify it.
* **Tool / API-level mutations** — seed/verify via the operator's own API or
  direct SQL into an isolated DB; the pot-create dialog (native-setter input
  fill) and the worker-chat send both drive end-to-end. Verify the result in the
  DB.

## NOT reliable via bridge synthetic events (route elsewhere)

* **Radix/cmdk ACTIVATION.** Radix `Tabs` need the full
  `pointerdown→mousedown→pointerup→mouseup→click` sequence (a plain `.click()`
  no-ops). Radix `Popover`/`Select` triggers and **cmdk command-palette
  `onSelect`** often don't fire at all from synthetic events — the widget's
  visible state (open, filter-narrowing) updates, but the SELECT/ACTIVATE action
  doesn't run. Observed: the "New plan" button (EI-1531 — launches a drafting
  agent, no-op under synthetic click), command-palette execute (round-5 J5 —
  open + type/filter work 166→37, but click AND keyboard-Enter dismiss without
  navigating), Radix Select column-filter add (round-3).
* **Value-tracked form inputs + per-field autosave.** Setting a controlled
  `<input>` via the native-setter or the `__reactProps$.onChange` path updates
  the value, but the SAVE often rides a per-field `onChange`/`blur` autosave that
  the synthetic event shape doesn't trigger (round-5 J2: voice prefs autosave via
  `savePrefsPatch`→PUT; a synthetic `onChange({target:{value}})` set the value
  but fired no persist request). Don't conclude "save is broken" — read the
  handler; the persistence is usually correctly WIRED, just not synthetically
  triggerable.

## How to tell a test-limit from a real bug

When a synthetic interaction "does nothing", DON'T file a bug. Instead: (1)
instrument `window.fetch` and check whether ANY persist/action request fired;
(2) read the handler source (does the button/onSelect call what you expect, and
is it gated/disabled?); (3) check whether the action is Radix/cmdk-activation or
autosave (the two boundary cases above). EI-1531 was filed as a bug, then closed
as a false positive once the source showed "New plan" launches an agent by
design. Confirm before filing.

## Routing rule

bridge-driving = nav · render · console · DOM-state · API/SQL mutations. Radix/
cmdk activation + form-autosave round-trips = real input (xdotool — but
round-3 found coordinate-driving the dev-wrapper webview UNRELIABLE: openbox
offset + DPR + layout perturbation) or, preferably, the committed Playwright
specs (`apps/operator/e2e/*.spec.ts`, real Chromium events). Use the right tool
per surface. Related: \[\[isolated-stack-for-mutation-e2e]], \[\[../testing/agent-e2e]].
