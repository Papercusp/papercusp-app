# Desktop performance suite — catching real slow interactions
URL: /internal/docs/testing/desktop-performance-suite



import { Aside } from '@astrojs/starlight/components';

The **desktop-performance suite** is the standing REGRESSION harness that
continuously drives the real slow desktop-UI interactions and asserts each
against a named budget — so a "several seconds to open a plan"-class regression
reds a check instead of shipping green.

Do not confuse the two:

* **Desktop-UI perf (this page):** the `desktop-performance` admin test suite +
  the in-app `__papercuspPerfRecorder` + the `tools/perf-test/wdio`
  packaged-binary harness. Budgets: interaction settle, warm-route settle, chaos
  INP/frame, RSS.
* **Host/backend perf (NOT this page):** `system-health/perf-budgets.ts`
  `PERF_BUDGETS` + the `perf-gate.ts` deploy gate (worker CPU, event-loop lag,
  PSI). Referenced only as the *pattern* for the flag-gated, fail-soft release
  gate below.

## The measurement rule (why not just `eval` a timer?)

**Do NOT measure a UI interaction by driving a long-lived dev shell with
`tauri-agent-tools eval` and diffing `performance.now()` / wall-clock from
OUTSIDE the page.** `performance.now()` never resets across client navigations,
so a delta captured from outside is confounded — it reads 62s, 88s, … at the
"start" of the next eval, never a page-relative small number, and a bare
`import()` probe lies about warm cost. This produced untrustworthy numbers and
is retired.

**Instead:** every budgeted interaction emits a **page-relative
`performance.measure`** from the in-app perf-marks hooks. A measure's
`startTime + duration` come from one monotonic timeline regardless of how long
the page has lived, and it is readable BOTH from inside the app (the vitals
recorder, via a `PerformanceObserver` on `'measure'`) AND from a driver (via
`performance.getEntriesByName(name, 'measure')`). Read the measure — never an
external clock. Run against a **fresh** packaged binary (the wdio harness) or a
freshly-spawned shell, never one alive for days.

## Architecture — three layers over one canonical timing source

1. **Instrumentation — `apps/operator/app/_components/perf/perf-marks.ts`.**
   The ONE place that names + emits interaction measures. `PERF_INTERACTIONS`
   is the registry; `beginInteraction(name)` marks a page-relative start on the
   real user gesture, `endInteraction(name)` emits the `performance.measure` when
   the content settles. `endInteraction` is **measure-once + no-op unless a
   matching begin ran**, so it is safe to call on a SHARED render path (only the
   context that began the interaction emits a measure). A stale start (a begin
   whose end never came) is discarded past `STALE_START_MS`.

   Wired interactions (gesture → settle point):

   | interaction (`PERF_INTERACTIONS` value) | begin (gesture)                      | end (settle)                        |
   | --------------------------------------- | ------------------------------------ | ----------------------------------- |
   | `plan-popup-open`                       | PlansPane row click                  | PlanEditor Vditor body render       |
   | `command-palette-open`                  | GlobalCommandPalette open transition | CommandPalette (lazy chunk) mount   |
   | `inbox-list-settle`                     | InboxPane filter/facet click         | virtualized list re-render          |
   | `conversation-thread-load`              | ChatPanel chatId set                 | thread transcript first render      |
   | `harness-dock-open`                     | HarnessDock mount                    | dockview API bind (layout hydrated) |

   The vitals recorder (`apps/operator/app/admin/testing/_lib/vitals-recorder.ts`)
   captures these as a `measure` event kind, so the in-app suite and the wdio
   runner read one canonical source.

2. **Budgets — `packages/operator-core/lib/system-health/desktop-perf-budgets.ts`.**
   `DESKTOP_PERF_BUDGETS` is the single declaration point (sibling to
   host/backend `perf-budgets.ts`): warm-route settle, per-interaction settle
   (`interactions[name]`), chaos INP/frame tiers, RSS. `evaluateInteractionBudget`
   is the pure verdict (an UNBUDGETED interaction is recorded, never a failure).
   The admin suite sources **every** threshold from here — no inline numbers.

3. **Checks — `desktopPerformanceChecks` in
   `packages/operator-core/lib/admin-test-suites.ts`** (the `desktop-performance`
   admin suite). It drives the interactions in the Tauri shell and asserts the
   measures:
   * **warm-route settle:** harness / testing-live / plans routes.
   * **interaction budgets:** `plan-popup-open`, `command-palette-open`,
     `inbox-list-settle` are actively driven (`measureInteraction` — clicks the
     real trigger, or, when there is no click trigger, the `setup` deep-link IS
     the trigger). `conversation-thread-load` and `harness-dock-open` are
     **read-latest** (the dock hydrates once per session; a conversation needs a
     specific chat) — they report the recorded measure or **`skip`** (skip
     collapses to pass) when not exercised this session; the fresh-binary wdio
     harness drives them cold.
   * **chaos usability:** chaos-click each heavy surface for 5s and assert INP
     p95/max + frame budgets + no errors/reloads. Covers `test-runs` plus the
     broader surfaces (`chaos-harness-dock`, `chaos-plans`, `chaos-conversations`)
     with per-surface `chaos:<surface>:*` measure keys.
   * **RSS budget:** largest Tauri/WebKit process stays below the kill margin.

## Fresh-binary runner (the authoritative interaction timing)

`tools/perf-test/wdio` boots the **packaged** desktop binary FRESH and drives the
interactions via WebDriver, reading `performance.getEntriesByName`. This is the
trustworthy path EI-18128922194224210 asked for (never a shell alive for days;
a RELEASE binary — debug inflates timing).

```bash
cd papercusp-desktop && npm run build   # release binary
npm run perf:desktop                     # from repo root — build + run the specs
```

Specs (`specs/*.perf.spec.ts`): `plan-popup-open.perf.spec.ts` and
`broader-interactions.perf.spec.ts` (command palette, inbox list, harness dock).
Budgets in the specs MIRROR `DESKTOP_PERF_BUDGETS` — the runner is deliberately
outside the npm workspace, so keep the two in sync when a budget changes.

You can drive the Tauri shell head-lessly to reproduce a measure — see
[the agent E2E playbook](/testing/agent-e2e). The suite is not a substitute for
driving the real shell when you change an instrumented interaction.

## Regression tracking + release gate

* **Trend:** each run's measures are persisted in Postgres
  (`harness_shared.desktop_perf_runs`, migration 643;
  `system-health/desktop-perf-runs.ts`) for last-N / delta detection, surfaced in
  the admin testing UI.
* **Release gate:** `apps/operator/lib/release/desktop-perf-gate.ts` wires a
  desktop-perf verdict into the green-checkpoint, flag-gated + fail-soft
  (`FLAGS.DESKTOP_PERF_GATE`, default-ON **warn-only**; block-mode is deferred
  until the signal is trusted), mirroring host `perf-gate.ts` policy.

## Adding a new budgeted interaction

1. Add a `PERF_INTERACTIONS` entry (kebab value) in `perf-marks.ts`.
2. Wire `beginInteraction` on the real gesture + `endInteraction` on the settle
   point (end may sit on a shared render path — it is inert without a begin).
3. Add its budget to `DESKTOP_PERF_BUDGETS.interactions`.
4. Add a check to `desktopPerformanceChecks` (`measureInteraction` if driveable,
   else read-latest + `skip`).
5. Add a fresh-binary spec under `tools/perf-test/wdio/specs/`.
6. Cover the wiring: a component test asserting begin/end fires (see
   `PlansPane.test.tsx`), plus the `perf-marks` + `desktop-perf-budgets` unit
   tests (every registered interaction must be budgeted).
