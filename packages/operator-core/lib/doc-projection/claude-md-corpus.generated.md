<!--
  GENERATED FILE — DO NOT EDIT, and do not treat it as documentation to read.

  It is the full CLAUDE.md corpus (every part, projected and unprojected alike)
  composed from harness_shared.harness_doc_parts, which is canonical. It exists so
  the doc-claims guards can judge the WHOLE corpus without a database: the client
  files carry only the projected minority, so pointing those guards at CLAUDE.md
  after the cutover would leave them judging a fraction of what they judge today.

  Written by scripts/project-doc-parts.mjs. Edit the rows, never this file.

  PROVENANCE — machine-read by doc-corpus.test.ts, which fails if the source sha
  here disagrees with the part manifest. That is the drift alarm: this file, the
  manifest and the rows are three artifacts derived from one CLAUDE.md snapshot,
  and regenerating any one of them alone silently desynchronises the set.
  corpus-parts: 321
  corpus-blocks: 268
  source-sha256: 77afdc4a46a5af9d0b5e7f604c6e2e1e592d51bef791b59633d4f00d1af8db2b
-->

# Papercup — agent guide

> Invariants + pointers only. The long-form detail behind every pointer lives in
> `/internal/docs` — start at
> [system/repo-conventions](/internal/docs/system/repo-conventions) (deployment
> model, retired surfaces, borrowable libs, branch/commit discipline long form,
> two-port model, database topology, test infrastructure).

> **Environment quick-start:** [`AGENT-ENV.md`](AGENT-ENV.md) — the machine-checked
> repo operating contract (where shared code lives: `libs/` vs `packages/`; how to run
> tests: the hoisted-root `vitest`; the operator-vite `@` cross-tree alias trap). It is
> GENERATED from the real config (`npm run gen:agent-env`) so it cannot drift, and
> `npm run doctor` asserts the same invariants as runnable checks. Read it first if you
> are new to the tree.

## ▶ Running / testing this app — it is the **Tauri DESKTOP app**, not a browser webapp

> The most-ignored rule in the repo. Read it before you try to "open the app".

**The ONLY supported way for an AGENT to run or test the app — it never touches the
owner's live desktop:**

```bash
scripts/verify-tauri-headless.sh -- bash -c '<your tauri-agent-tools assertions>'
scripts/verify-tauri-headless.sh --boot-only   # multi-step; run the printed stop script when done
                                               # under capability:bash: --boot-only-i-accept-task-lifetime
```

It boots `papercusp-desktop` on its OWN auto-picked Xvfb display (≥90) + VirtualGL, with
its own devUrl port and its own sidecar — embedded PG, migrations, webview, dev-bridge —
runs your assertions with `VERIFY_TAURI_PID` / `_PORT` / `_DEV_URL` / `_POLL` exported,
tears the whole tree down even on a failing assertion, and exits with your command's own
code. `--help` prints the full contract. ⚠ The **database and workspace are NOT isolated**
by default: every write you click is a real write to live state — pass
`VERIFY_TAURI_ISOLATED_DB=1` for a throwaway per-run PG + WebView profile before you
exercise write paths.

**The attended/human form is `cd papercusp-desktop && npm run dev`** (from the repo root).
It opens a REAL window on the inherited `DISPLAY`, which on this box is the owner's live
desktop `:1` — so it is for a human who asked for a window, **never** for agent
verification (agent-e2e §0 forbids focus-stealing; WI-2648 is the incident where synthetic
input leaked into the owner's real email draft). Either form boots embedded PG, the
operator sidecar, migrations, and the webview. There is no "just the webapp" mode.

> ⚠ **Launch via `npm run dev` — never a bare `npm run tauri dev` / `cargo tauri
> dev`.** `~/.cargo/config.toml` pins ONE shared Rust target dir for the whole box
> (`build.target-dir=~/.cargo-target`, set 2026-06-17 to stop per-checkout `target/`
> dirs bloating to ~150G), so two concurrent desktop builds interleave writes to the
> GENERATED app-manifest and **both** die with `build.rs:305 panicked: failed to run
> tauri_build with the app-command manifest (WI-1976): failed to parse JSON`. Because
> `tauri dev` rebuilds on change, a second instance takes down the FIRST one too —
> on 2026-08-02 an agent starting its own instance killed the **owner's live
> desktop** (WI-7101). The malformed file is generated, not tracked, so `git status`
> is clean and every checked-in `capabilities/*.json` parses fine, which is exactly
> why it reads as a mystery. Every `tauri dev` launched through npm now claims a
> per-instance target-dir slot, so concurrent desktops cannot corrupt each other:
> a lone launch keeps the shared dir and its warm cache, a second one isolates
> automatically and says so.
>
> The claim lives at the **`tauri` npm script** (`bin/tauri-guarded`, which sources
> `bin/lib/claim-target-dir.sh` for the `dev` subcommand only) — a chokepoint every
> launcher already passes through, so `npm run dev`, `dev:hmr`, `bin/desktop-preview-prod`
> and **`scripts/verify-tauri-headless.sh`** are all covered. It used to be wired into
> `bin/desktop-dev-nohmr` alone, which left it a convention each new launcher had to
> remember, and three then forgot — including the headless-verify script this file
> tells you to use, so the documented safe practice was itself launching an
> unprotected build (EI-19369470572700441). `papercusp-desktop/test/tauri-dev-slot-chokepoint.test.js`
> fails if a launcher routes around it again.
>
> Still unprotected by construction: a **`cargo tauri dev`** that skips npm entirely.
> Don't.

> **You CAN — and therefore MUST — verify UI yourself; "I can't check UI
> headless" is a mistake, not a constraint.** Launching this shell is within
> YOUR reach (run the command above — it is one script; first cargo build ~2 min),
> and you then drive its webview **head-lessly, no focus-steal**, with the
> **`tauri-agent-tools`** CLI: `probe` · `eval` · `dom` · `click` · `type` ·
> `screenshot` · `check` (CI-style assert, exits 0/1) · `capture` (screenshot +
> DOM + console + logs). Full playbook: `/internal/docs/testing/agent-e2e` §0–§2
> (attach to a running shell, or start your OWN second instance). Therefore a UI
> task is **NEVER** "blocked on a Tauri/desktop session," and UI is **NEVER**
> "unverifiable headless." If you catch yourself deferring, punting, or shipping
> UI work as un-testable-without-a-human, STOP — that *is* this mistake: start the
> shell and drive it. (For non-Papercusp/arbitrary web pages, `verdict`; the
> operator UI only renders correctly inside Tauri, so never point `verdict` or a
> browser at `:3055`/`:3070`.)

- **Never open `:3055`, `:3070`, or `:3170` in a browser** (verdict / playwright /
  chrome / `xdg-open`). They are the desktop's *internal content source* — a
  browser view is the **retired** webapp and gives a broken/misleading result,
  and navigating verdict there has wedged the shared verdict daemon outright
  (no Tauri IPC bridge, so the SPA never settles — `goto` never returns, and
  every later command in the same session times out too, until `stop`+restart).
  A `PreToolUse` hook (guard-operator-desktop.mjs) blocks a `Skill`-shaped
  navigation call, but that hook's matcher does not cover verdict's real
  invocation path (a plain Bash command, per SKILL.md's
  `allowed-tools: Bash(verdict*)`) — so verdict-cli itself also refuses
  client-side, before ever contacting its daemon, for all three ports
  (EI-22200064677663549; the patch lives in `patches/verdict-cli+0.1.1.patch`).
- **Never start `apps/operator` as a standalone Next server** (`next dev` /
  `next start`) — retired. (The root `bin/dev`/`bin/prod` launchers are NOT the
  forbidden thing — they boot the Vite `:3055` + Hono `:3070` stack and invoke
  no Next.)
- A `curl http://127.0.0.1:3070/...` for a quick **API** check (not a UI check)
  is fine while the desktop is running.


The `:3055`/`:3070` layer **is the desktop's content layer**, not a separable
webapp — what's retired is the *act of running/browsing it standalone*. Detail +
the transport/persistence table:
[repo-conventions § deployment model](/internal/docs/system/repo-conventions).

## Almost all state should be in nuqs

**If a piece of state is reasonably user-meaningful, it goes in the URL via
[nuqs](https://nuqs.dev), not `useState`.** Non-negotiable: the agent → UI
control surface (`ui:get_state`, `ui:dispatch`) reads/writes the URL — anything
in `useState` is invisible to agents.

- **nuqs:** tab/view/mode selectors, panel/drawer/dialog open-state, selection
  ids, search/filter/sort/pagination, expansion toggles.
- **useState:** loading/saving/error lifecycle, mid-edit drafts, hover/focus,
  toasts, ref-coupled sync values, render-only state.

**When in doubt, choose nuqs.** Prefer `parseAsStringEnum` > `parseAsBoolean` >
`parseAsString` > `parseAsJson(shapeGuard)`; encode complex selections as a
short scalar (`"review:<id>"`) + `useMemo` lookup, never 1KB of JSON. Rationale +
the migrated params: `apps/operator/docs/nuqs-audit-2026-05-11.md`.

## All client data sync goes through `@papercusp/sync`

Reads via `useSyncQuery({ queryName, args })`; writes fire
`notifySyncInvalidate(...)` (+ `useSyncMutate` for the hook). **Never** hand-roll
`fetch + setInterval`, SWR, React-Query, or a raw `EventSource` for query data —
the library is the one audited path (**SSE in every runtime** — desktop *and*
browser, no runtime branch; POLLING/REST only as the degraded fallback. The Zero
WebSocket branch was retired in the 2026-05-07 cutover and nothing selects WS
now). Zero is **retired**; ignore `libs/zero-harness`.

Wiring: resolver entry in `packages/operator-core/lib/sync-resolver/index.ts`
(read) + `notifySyncInvalidate` from `packages/operator-core/lib/sync-sse.ts`
after the write commits. Genuine exceptions (byte streams, UI timers,
operator-mobile's polled path) and the full recipe:
`/internal/docs/data-sync` + the
[adding-a-sync-query](/internal/docs/agent-insights/adding-a-sync-query) insight.

## Scheduling: no bare `setInterval`, no new scheduler

Recurring work has exactly **two execution mechanisms** + **one declaration surface** — don't
add a third. Durable + Postgres-backed → a **DBOS scheduled workflow** (or a `tier:durable`
routine fired by `routinesTick`). A frequent in-process bounded sweep → declare a
**`tier:ephemeral`** blueprint `triggers.schedule` (deterministic `system:<action>` + `intervalSec`;
the per-host `ephemeral-executor` runs it). A watchdog / per-connection / cache timer that must
stay bespoke → still wrap it in `managedSetInterval(name, ms, fn, { category })` so it is VISIBLE
in `schedule:inventory` (*visibility ≠ control*). A bare `setInterval` fails
`lint:no-raw-setinterval` (the BASELINE is empty). Full model:
[the scheduler layer model](/internal/docs/agent-insights/two-tier-scheduler-and-timer-visibility).

⚠ **`schedule:inventory` is PER-PROCESS, and which process answers you decides what
you can see.** `source: 'managed'` reads the in-memory registry of whichever process
SERVES the call — normally the operator (:3070). Most recurring sweeps do not run
there; they run in `papercup-bg-host.service`. So a timer's absence from the inventory
has never meant "that timer does not exist", and reading it that way is how
`dbos-executor-reaper` failed 100% of its passes for 6+ days undetected while
`attention-reconcile-unanswerable` had never executed once (EI-19445595198254637).
Sibling operator-shaped processes (bg-host, staging — anything serving
`bin/hono-host.ts`) are now federated live: they appear as `source:
'external-process'` rows carrying real `armed`/`lastFire`/`lastError`, tagged
`detail.federated: true` and `detail.process: '<role>:<port>'`. **Read
`detail.federated` before trusting a row's fire-state** — a `false` row is either the
static manifest (the inference gateway, its watchdog, psu-launcher, which serve no
such endpoint) or a sibling that did not answer the probe, and a non-answering
sibling renders as one explicit `… (timers unknown)` row. Unknown is not absent.
Mechanism: `schedule-federation.ts` + `GET /api/internal/managed-timers`.

⚠ Federation was necessary, **not sufficient** — until 2026-08-03 a timer could be missing
from the inventory of **its own process**. `dbos-executor-reaper` reaped every 2 min inside
bg-host while absent from `/api/internal/managed-timers` served by that same pid, because the
process held **two instances** of `@papercusp/scheduled-registry`, each with its own
module-level registry Map (tsx's CJS-preflight + ESM loader, bare-vs-relative specifiers, and
symlinked `node_modules/@papercusp/*` all produce this). The registry's state is now pinned to
`globalThis` under a `Symbol.for` key, so it is single-instance regardless of the seam. Two
readings this burned, both general: **a probe's negative covers only the conditions it
reproduced** (a tsx probe "falsified" the dual-instance theory and cost a wake), and
**unobservable is not empty** — `:3070` has no such route at all (verified: zero mentions of
`managed-timers` anywhere in the release checkout), and a `.get('timers', [])` parse turns its
`{"error":"not_found"}` into a false `total 0`. Full story:
[schedule:inventory is per-process](/internal/docs/agent-insights/schedule-inventory-is-per-process).

## Spawning: no unenrolled `detached` spawn, and never kill by name

The process analogue of the scheduler rule above. A `detached: true` spawn creates a
process meant to **outlive the call that made it** — the root of a subtree — so it must be
enrolled in the task ledger: **`managedSpawn`** (`task-manager/managed-spawn.ts`) for an
async seam, **`beginSyncEnrolment` + `completeSyncEnrolment` + `finishSyncEnrolment`**
(`task-manager/enroll-sync.ts`) for a sync one. `lint:no-unenrolled-spawn` fails a new
un-enrolled site; genuinely-not-ours lifetimes (a human terminal window, a pre-operator
bootstrap, a release cut that survives the restart it performs) go in that guard's
ALLOWLIST **with a reason**. Ordinary short-lived spawns need nothing — cgroup membership
is inherited, so a `git rev-parse` inside an already-confined process is already accounted
for. That inheritance is the whole design: confine the ROOTS, and the kernel accounts for
every descendant, including ones that double-fork and reparent to init.

⛔ **Never kill by name or pattern.** `pkill -f '<binary>'` has twice killed the owner's
live desktop window and peer agents' Xvfb instances. Use **`processes:kill { taskId }`** —
it kills the whole cgroup subtree and cannot reach a recycled pid (PID wrap happens ~daily
here under fleet load). An `identity_mismatch` refusal is the rail working, not a bug. To
relieve pressure without losing work, **`processes:freeze`** beats killing.

| you want | use | not |
|---|---|---|
| what is running AND WHY (who launched it, for which work-item, what it costs) | `processes:list` | `ps`/`pgrep` — kernel-shaped, zero provenance |
| the six tracked AGENT process kinds | `dev:processes` (unchanged, deliberately narrow) | `processes:list` |
| a real whole-host process list | plain `ps`/`pgrep` (never gated) | `processes:list` — it will answer wrong, not empty |

Human pane: `/admin/tasks` (sibling of `/admin/schedules` — that one inventories everything
RECURRING, this one everything RUNNING). Full model:
[the task manager and the no-escape property](/internal/docs/agent-insights/task-manager-and-the-no-escape-property).

## Shared-lib singletons: pin through the primitive, never by hand

Module-scoped mutable state in a shared package (`const registry = new Map()`, a cache,
a pool, a `configure*()` host-seam object) is a singleton **only if the loader produces
exactly one module record**. Several ordinary seams break that with no error: tsx's CJS
preflight beside the ESM loader, the same file reached by bare specifier and by relative
path, `node_modules/@papercusp/*` symlinked into the repo, a bundled copy beside source.
When it splits, each record gets its own state and writes to one are invisible to readers
of the other. Nothing throws — you get a *partial* view that looks complete.

**Use `pinModuleState` from `@papercusp/module-singleton`, at module scope, once:**

```ts
const state = pinModuleState('@papercusp/your-pkg.state', () => ({ registry: new Map() }));
```

It pins to `globalThis` under a `Symbol.for` key — correct under *every* seam above, so
you never have to prove which one applies — and counts evaluations, so a re-split is
reported by `listModuleDuplications()` instead of being rediscovered the expensive way.
⚠ **Do not hand-roll the `Symbol.for` + `globalThis` pair.** Hand-rolling still fixes
correctness, but the key is invisible to the central report, which then answers a
confident `[]` while your module is split — the failure below, one level up.
**`npm run lint:no-hand-rolled-module-pin` fails on a new one** (and
`-- --list` prints the full measured population, which is how its allowlist is
re-seeded — never from a hand-run grep).

Measured (EI-19451658870832332): `@papercusp/scheduled-registry` was evaluated twice in
bg-host, so `dbos-executor-reaper` reaped every 2 minutes while ABSENT from
`/api/internal/managed-timers` served by that same pid. It cost 6+ days and several
sessions because **the surface responsible for reporting the problem was the surface the
bug blinded** — absence from an inventory is evidence only when there is exactly one
inventory. Duplications now ride on that route beside the timer list.

⚠⚠ **`listModuleDuplications()` is still STRUCTURALLY PARTIAL — an empty `[]` is not a
clean bill of health yet.** Nineteen modules pin through the primitive and are reported
(`scheduled-registry`, `lexicon`, `kokoro-tts`, `memory` ×2, `deployment-driver`,
`flags`, three `tooldef` registries, and the `operator-core` caches) — measure that
set with `grep -rl pinModuleState`, not `pinModuleState(`, which misses the
generic-parameter call form `pinModuleState<T>(`. **27 pins across 26 files still
hand-roll theirs** and are invisible to it, spread over
`packages/operator-core`, `apps/operator`, `apps/operator-vite`, `libs/generic/sse` and
`libs/generic/tooldef`. Run the lint's `--list` for the current set — the count moves as
they migrate, so trust the command, not this sentence.

⚠ **That population has now been corrected THREE times, each time UPWARD, and each time
because the measurement matched a spelling instead of the thing.** The sequence is worth
knowing, because every step looked rigorous from the inside:

1. The commissioning work item said **five** — its audit grepped `Symbol.for('@papercusp`,
   while the larger population uses the dot form `Symbol.for('papercusp.…')`.
2. The first allowlist, seeded from an `rg … | head -30`, was two sites short.
3. The **detector built to replace those greps was itself form-blind** (2026-08-04,
   EI-19479108855357092): it matched `Symbol.for(...)` keys only, so it reported **14**
   remaining while **18 more files** pinned with a plain STRING key
   (`const K = '__papercuspPulseCache'; (globalThis as G)[K]`) — a form it never scanned.
   Three of those sat in `harness-core.ts` beside a fourth pin it *did* flag, and one was
   a fourth `tooldef` registry a prior tranche believed it had finished migrating.

**A proxy measurement's negative covers only the conditions it reproduced** — and step 3
shows that "use the detector, not a grep" is not by itself protection: a detector is only
as wide as the shape it matches, and a *tool* asserting "that's all of them" is far more
persuasive than a grep saying it. When a guard's job is to make a population trustworthy,
anchor its match to the PROPERTY that defines membership (here: indexing `globalThis`),
never to how the key happens to be spelled — and pair every widening with a control that
fails against the narrower rule, or the next narrowing is silent.

⚠ Note the ALLOW list legitimately GREW 14 → 32 at step 3. That is a **baseline
correction**, not a breach of its shrink-only rule: no pin was added, 18 were finally
seen. Shrink-only governs new debt; it is never a reason to keep a measurement wrong.

⚠⚠ **Fixing the detector does NOT fix the artifacts DERIVED from the old one — and a
`✓ VERIFIED` badge on a derived claim outranks the grep behind it.** Step 3 corrected the
detector; the *migration's* companion table ("which tests break when you migrate the
remaining sites") had been derived with the same narrow probe and was still wrong a wake
later. It was carried as **VERIFIED with evidence attached** — "NO test pokes a
STRING-key realm pin" — from a probe (`globalThis[^)]{0,40}\['__[A-Za-z]+`) that requires
bracket-string access on ONE line, so it could not see dot access
(`.__papercuspInvalidationListenHooks__`), an aliased read (`g.__sse_channel_registry__`),
or indirection through a named const (`[ACTIVE_KEY]`). Three real readers were invisible,
two of which `delete` the key in a `beforeEach` — after migration those clear NOTHING, so
the test keeps passing while testing nothing. Corroboration that this already happened
here: `sync-sse.test.ts:35` deletes `__syncNotifyDedupe`, a key **no source file writes**.
So: when you widen a guard, **re-derive every table you built from its narrower output**,
and treat your own verified-with-evidence claims as suspect when the evidence was a
pattern match — the badge records that a probe ran, not that it was wide enough.

## Deployment model: desktop is the product; the standalone webapp is RETIRED

Shipping target = the Tauri desktop app; **SSE is the sync path that matters** —
`HarnessSyncProvider` passes a literal `syncType="SSE"` with **no** runtime
branch, so a plain browser tab runs the SAME transport as production. WS is
**retired** (nothing selects it); POLLING is the degraded fallback and is
catastrophic here (~40 registered queries re-fetched per tick against a
6-connection-per-host cap starves the pool), so a feature that only works under
POLLING — or that assumes the retired Zero WS — is incomplete. Source of truth:
`apps/operator/providers/HarnessSyncProvider.tsx`. Transport table +
stale-docs-to-mistrust list:
[repo-conventions § deployment model](/internal/docs/system/repo-conventions).

## Retired / preserved-not-active surfaces

Some code is **retired but deliberately kept** — not deleted, not deployed, not
tested, not to be extended. Don't write tests for it, wire new code to it, or
"revive" it without an explicit ask. Currently: `_retired/papercup/` (public
site), the standalone operator webapp path, `libs/papercusp-db`,
`libs/holepunch-spike` (NOT zero-importers — shim implemented
by live orchestrator files), `libs/papercusp-shared/**/*View.tsx`, the legacy
orchestrator run-loop + orchestrator-spawn plugin
(`libs/papercusp/_retired/…`), the harness-snapshot system
(`_retired/snapshot-system/`), the legacy web chats
(`_retired/legacy-web-chats/` — OracleDock + TutorialButton **only**. ⚠ This entry
used to also name `OperatorChatSidebar` and to state "the pui chat pane is the only
chat surface". BOTH claims were FALSE, and this is the expensive direction for a
retired-list error: a live surface listed as retired tells every agent not to test
it, not to wire to it, and not to "revive" it without an ask — i.e. the doc
suppresses real work on shipping code. `OperatorChatSidebar` was REVIVED under
`operator-chat-sidebar-revival-2026-07-13` and is LIVE at
`apps/operator/app/_components/OperatorChatSidebar.tsx` — imported and rendered by
`ChromeShell.tsx` (L44/L352) behind `FLAGS.OPERATOR_CHAT_SIDEBAR`, which derives
**default-ON** because it is absent from `KNOWN_DARK_FLAGS` (`production-defaults.test.ts`
makes "every default-OFF flag has a vetted reason" true by construction). It has live
tests (`ChromeShell.test.tsx`, `OperatorChatSidebar.component.test.tsx`). Treat it as
live product surface: extend it, test it, fix it. OracleDock is genuinely retired —
it exists nowhere but `_retired/legacy-web-chats/`), the legacy per-slug harness dashboard
(`_retired/harness-dashboard/` — `/harness/$slug` shell/pages/Real-panels; the
design-system primitives AND the dock engine in `apps/operator/app/harness/`
stay LIVE — `/adv`+`/workbench` are built on them), and the **work-item mail surface** (`_retired/work-item-mail/` —
`messages:send`/`dismiss`/`inbox`/`outbox` + their `cross_harness:` analogs;
retired 2026-07-26, WI-6097. NOT broken — it lost to `coord:send`, which carried
~400× its traffic, and took zero writes in its final 30 days. Durable
work-item-scoped direction is now `work_items:comment` /
`work_items:checkpoint`, **not** `coord:send`, which targets a live session and
does not survive a spawn boundary. All 222 rows are preserved — this was code
removal only. ⚠ the `coord:*` plane — `agent-tools/coordination/messages.ts`, `coord_event_log`,
`coord-inbox-bus` — shares the word "messages" and is fully LIVE: match the
surface, never the substring). (The Mug/Kettle left-rail
tabs, retired under WI-4778, were RESTORED to the LeftSidebar by owner ask
2026-07-14 — and are, as of `retire-mug-kettle-su-only-2026-08-09` P-068, RETIRED
PERMANENTLY. ⚠ This entry used to say the tier was "GATED rather than deleted" behind
`papercusp-mug-kettle-system`, "whose default-OFF IS the delivered end state". Read
today that is worse than merely stale: it promises a reversible switch that no longer
exists. P-068 DELETED the flag — `MUG_KETTLE_SYSTEM` is absent from `FLAGS`,
`mugKettleSystemEnabled()` returns false unconditionally, and the three spawn doors
refuse a retired tier role through `isRetiredTierRole` rather than consulting anything
flippable. So this IS now a `_retired/` move rather than a gate. The left-rail tabs and
their panels ship nowhere and live under `_retired/mug-kettle-deciders/` — MugTab,
OverwatchTab, MugHeartbeat, ModelTiersOverride, ThrottleSection, AutonomySurfacing and
MugWakeEfficiencyPanel. **su + GOAL mode are the only way to drive the app.** Scout +
Blender (D-001) and the shared pot substrate (D-003) survive UNGATED.
⚠ `libs/zero-harness` used to be listed above as
retired-but-kept; it was **deleted** in zero-decommission-2026-06-20, so there is
nothing preserved and nothing to migrate off — measured 2026-08-09, it is absent
from disk, from the git index and from `.gitmodules`.)

**What enforces this section.** `lint:no-retired` guards re-imports of `_retired/`
modules — and as of EI-19971915610840229 that is finally TRUE rather than aspirational:
the script existed but NOTHING invoked it for months, so the guarantee this section
asserted was never actually checked. It is now a repo-wide invariant guard
(`scripts/affected-tests.mjs`), running on every changed TS/JS path, alongside
`lint:no-retired-resurrection`. The CLAIMS IN THIS SECTION are themselves guarded by
`packages/operator-core/lib/doc-claims/retired-surfaces.test.ts`: every path named here
must resolve, and a surface listed as living in a `_retired/` directory must actually be
there. That guard exists because the failure is silent in one direction — a doc that
wrongly says LIVE self-corrects the first time someone greps, while one that wrongly says
RETIRED just quietly diverts work away from shipping code.

Full table with restore points + the retiring-a-surface convention:
[repo-conventions § retired surfaces](/internal/docs/system/repo-conventions).

## Borrowable libraries — generic-first

Domain-free libs live as standalone submodules under `libs/generic/*`; the
catalog is `BORROWABLE.md` (generated — `npm run gen:borrowable`). **A genuinely
domain-free algorithm STARTS as `libs/generic/<name>` behind a `configure*()`
seam** — never inside `operator-core/lib` to be extracted later. `npm run
lint:generic-first` (advisory) flags violations; incidental keyword hits go in
the `ALLOW` set in `scripts/check-generic-first.mjs`. Long form + the seam
pattern: [repo-conventions § borrowable](/internal/docs/system/repo-conventions).

## This app is in testing — there are no users yet

There is no production. **Don't defer fixes for "let's see how it fares in
production first"** — there's nothing to fare in. **Be bold — in alpha, timidity
is the failure mode, not breakage.** The genuine mistakes are the cautious ones:
preserving a design you know is wrong, back-compat shims, deprecation aliases,
half-fixes to dodge churn. When the correct fix is a breaking change — a schema
migration, an API redesign, a rename, ripping out a load-bearing-but-wrong
abstraction — **make it now, in full**: redesign instead of layering, rename
instead of aliasing, migrate schemas when they're correct, pick the best
tool/library not the safe one, prefer a maintained library or existing internal
surface over rolling your own, lift anything general into a shared/generic lib.
Surface what you're changing to whoever supervises your work; don't ask
permission to do it well.

## A blocker is work, not a stop sign — resolve it, don't just relay it

Hit a blocker — something in scope that's hard/big/risky, a failing dependency,
a broken tool, an env/config fault, a wedged service? **Don't pause to hand it
to the owner. Investigate the root cause, fix it, and fix it DURABLY** — resolve
the whole class so it can't recur, not a one-off patch that leaves the trap
armed for the next agent (a half-fix is the real failure mode here). Escalate to
a human ONLY when the fix is genuinely irreversible / high-stakes, outside your
authority, or you've actually tried and can't resolve it — and even then, bring
your diagnosis + a proposed durable fix, not just the blocker. Whatever you
genuinely can't resolve now, record durably on the work-item: use
`work_items:set_blocker` for an external event, gate, runtime, or human blocker
(with its kind, capability, ref, evidence, and next action), and use
`work_items:link { rel:'blocks' }` when another work-item must finish first;
never a prose message that scrolls away — and carry it forward in every status
report.

**Before burning hours re-deriving something a PEER may already know, ask the
router: `consult:get_feedback { question }`.** It searches every agent's real
transcript history (yours excluded), wakes the best-qualified peer with
why-they-were-chosen evidence, and answers instantly from the archive when a
closed consult already settled the question. Honest by design: below the
relevance floor it says "no one knows more than you do — proceed", never a
costumed expert. Reach for it at exactly the moments you'd otherwise
deep-dive an unfamiliar subsystem, re-debug a failure someone else already
fixed, or guess at another lane's design intent. (It is who-knows DISCOVERY —
for a KNOWN agent use `coord:send`; for live state, query it; for an owner
decision, `coord:ask-owner`.)


Interactive (human-present) PSU sessions can still take a fast redirect from the owner, but the default is resolve-don't-relay.The human-session specifics live in the PSU engineer playbook (EI-148).

⛔ **Before you report an OWNER-GATED wall for a credential or permission, exhaust the privilege you already hold — on this box `sudo -n` is `NOPASSWD: ALL`.** The recurring failure is escalating "needs a superuser / needs credentials I don't have" after probing only the *unprivileged* path, which hands the owner a chore the agent could have done itself.

```bash
sudo -n -u postgres psql -d papercusp -c '<SQL>'
```

A permission blocker is owner-gated only once **`sudo -n` has also failed**. When you do report one, name the privileged paths you actually tried — "no superuser is reachable" is a claim about YOUR probe set, not about the machine, and stating it the second way is how a five-second fix becomes an owner's task.
Measured case behind the `sudo -n` rule (P-037 / WI-40505, 2026-08-27): an agent needed `GRANT hosted_app TO harness_app WITH INHERIT FALSE`, correctly established that `harness_admin` is not superuser and holds no ADMIN OPTION, then probed password auth, peer auth, `~/.pgpass` and the env — and declared an owner-gated wall. It never tried `sudo`. The Postgres superuser was one command away the whole time (`sudo -n -u postgres psql -d papercusp -c '<SQL>'`).

The generalisable shape: the agent's probe set was thorough within one privilege level and never crossed to the next, and its escalation described the machine ("no superuser is reachable") when it could only honestly describe the probe set ("no superuser is reachable BY THE PATHS I TRIED").


## A cross-lane ruling is a plan Decision, recorded the moment it forms

Any agent — not only a fleet leader — who settles a trade-off, ratifies a scope, or issues a
ruling OTHER lanes must follow records it as a plan Decision **at the moment it forms**:
`plans:add-decision { slug, title, body }` (via the structured `### D-NNN` form the tool
produces — a hand-authored `- **D-NNN**` bullet in a plan body is NOT parsed as a decision by
`@papercusp/plan-parser`, so it never surfaces through the mechanisms below). Never record a
governing ruling only as a coord message: a message is not addressable after delivery, so a
peer who received a wrong paraphrase has no way back to the source. A decision is.

This is not a paperwork nicety — it changes outcomes. Observed live on `agent-trap-guards-2026-07-26`:
a fleet member re-read a leader's recorded decision, discovered its own earlier report to the
leader had been wrong on most of the sites it touched, self-corrected unprompted, and swept up
several more instances of the same error. A coord message cannot produce that outcome.

Two mechanisms make this cheap in practice:

- **At claim time**, `scheduler:get_next` / `work_items:claim` inline a claimed item's plan's
  current decisions as `planDecisions` in the tool result — no extra round-trip. Read it before
  building; a ruling that governs your item may be sitting right there.
- **When relaying a ruling over coord**, name the decision id (`<planSlug>#D-NNN`) rather than
  only paraphrasing it, so the recipient can re-read the authoritative body
  (`plans:get { slug, heading:'Decisions' }`) instead of trusting your summary.

## Every plan ships with a graded acceptance rubric

⛔ **CARRYING A PLAN "START TO FINISH" INCLUDES THESE VALIDATION STEPS — they are the finish, not paperwork after it.** An owner who says "carry out the plan" or "finish it yourself" is asking for a SHIPPED plan. Stopping at the last implementation item and reporting done — or naming the remaining validation and handing it back — is the same silent halt in two costumes.

⚠ **You do NOT recruit the grader by hand — `plans:set-plan-status { status:'shipped' }` IS the recruiter.** It routes through the relevance router, excludes implementers/author/shipper for you, cascades past a decline, and mints a lineage-safe fresh judge if nobody is eligible. You GET a non-implementer by ROUTING to one, never by LAUNCHING one — a session in the author's spawn/rebind lineage is refused after a full boot is paid for. Hand-picking from `coord:presence`, or a `work_items:create` grading request, re-implements that cascade without its fallback.

⛔ **Recruitment only fires on `{acceptance_ungraded, self_graded_only}`.** Any other refusal — above all `acceptance_bar_contract_not_ready` — refuses WITHOUT recruiting, and its repairs are YOURS alone; recruiting then is premature because grading is not yet reachable. Get the refusal to read `acceptance_ungraded` FIRST, then call the same verb again. Stragglers, the per-item audit and the grader's evidence stay yours — doing them first is what makes grading cheap.

**Two independent evidence families gate `plans:set-plan-status → 'shipped'`: a per-item CODE-TRUTH audit, then a GRADED acceptance rubric.** After implementation is verified:

1. **Finish or intentionally drop every item** — `todo`/`blocked`/`needs-human` refuse shipping; a deliberate departure is `plans:set-status { status:'dropped', note }`.
2. **Audit the actual code, per item** — `plans:audit { slug, items:[{ itemId, verdict, citations }] }`. Only `code`/`test` citations verify; paths must resolve and their blob SHAs are stored. Never treat a work-item, doc, or memory of writing code as code truth.
3. **Author the rubric AFTER implementation** — `rubrics:propose { rubricRef, kind:'acceptance', subjectPlan, classRef, characteristic, title, criteria }`, 3–7 OUTCOME criteria tracing to the goal + Decisions (a pure investigation may use `criteria:[]`). Deliberately authored against as-built reality — never at plan creation.
4. **Vet its current revision** — `consult:get_feedback { policy:'rubric-vetting' }` (that key, NO responder count), improve, then attest with `scorecards:emit` against `meta-acceptance-rubric`. Any later rubric edit invalidates BOTH the attestation AND any independent grading, so batch every revision BEFORE requesting independent grading.
5. **A NON-implementer grades it** — `scorecards:emit { rubricRef, ratings }` with concrete evidence per criterion; the grader must be outside the rubric author's spawn/rebind lineage and spot-checks the audit citations.
6. **The implementer records the acceptance call** — re-emit the complete ratings with `acceptance:{ verdict, reasoning }`. The implementer owns the passing bar; a latest `reject` blocks ship until superseded.
7. **Ship** — `plans:set-plan-status { slug, status:'shipped' }`; the rubric auto-retires.

`force:{ reason }` waives ONLY the code-truth checks, and permanently marks the plan with what was waived, by whom and why. It NEVER waives rubric existence, vetting, independent grading, or the implementer's verdict.

Each refusal code names its own repair: [plan completion runbook](/internal/docs/agent-insights/acceptance-rubrics-on-every-plan-runbook) · [rubric vetting](/internal/docs/agent-insights/acceptance-rubric-vetting).
Evidence behind the plan-completion rule (the rule itself is the invariant sibling; this is the case history, kept out of the projected guide).

## Why "route, never launch" a grader — the mechanism

`grader-eligibility.ts` resolves the rubric's `createdBy` as the implementer and refuses any session in that author's spawn/rebind lineage with `grader_in_implementer_lineage`. Because the rubric author is normally the very agent who needs a grader, "just launch one" fails in exactly its main case — and it fails LATE, after a full agent boot and a complete grading pass have already been paid for. That is why the rule is stated as a routing obligation rather than a preference.

## Why an unassigned work-item silently strands the routing

An unassigned `work_items:create` goes through duplicate-screening admission first and lands `admission:'pending'`, which refuses EVERY claimant — including the grader already named in the body — for roughly 30–60 minutes (promoter tick, then the fail-open backstop). That window outlives most short-lived sessions, so the routing looks complete at the moment it is filed and quietly never happens.

Passing `assign_to` takes the `bypass:explicit-assignment` path, which makes the item born-admitted and claimable in the same write.

Filed instances: EI-22183121787169840, EI-22129349476264584, EI-22008434629323224.

## Why a rubric edit invalidates grading

The ship gate pins scorecards to `harness_plans.version`, so a revision bump un-counts a peer's card and requires a re-emit. This is what makes "batch every intended revision BEFORE requesting independent grading" an efficiency rule rather than a style preference — a late one-line rubric fix costs another full grading round trip from a peer.

## Why `consult:get_feedback { policy:'rubric-vetting' }` takes no responder count

Passing the policy key and NO count keeps the responder bound inside `selection-policies.ts`, where it is enforced. Supplying a count moves that decision to the call site, where it drifts.


## Verify mixed-family work-item citations against the base table

When checking whether a work-item citation is real, do not treat a zero-row
lookup in `harness_shared.engineer_issues` as proof that the citation is
fabricated. `engineer_issues` is an issue-family view (bug/change/task) with
harness scope; it does not cover feature-family `WI-`/`F-` rows. Those rows live
in the canonical `harness_shared.work_items` table under `feature_id`, so a
mixed `EI-`/`WI-`/`F-` citation set must be checked there (or with
`work_items:get`) before an absence claim is made. Preserve the applicable
`workspace_id` and `harness_slug` predicates when using the base-table query:

```sql
-- sql-snippet-justified: the RELATION CHOICE is the lesson here — engineer_issues is an
-- issue-family view that omits feature-family WI-/F- rows, so only the canonical work_items
-- base table can answer a mixed citation set. work_items:get is already named as the tool
-- alternative in the prose above; this block exists to show the base relation and the tenant
-- predicates it requires, which a tool call cannot demonstrate.
SELECT feature_id, item_kind, status, workspace_id, harness_slug
  FROM harness_shared.work_items
 WHERE workspace_id = '<workspace-id>'
   AND harness_slug = '<harness-slug>'
   AND feature_id IN ('<EI-or-WI-or-F-id>', ...);
```

The view's `issue_id` and the base table's `feature_id` are relation-specific;
neither relation uses a generic `id` column for this check. Only call a
citation fabricated after the family-correct lookup and a nearby-id sanity
check both support genuine absence.


When citing a repo-relative file path in a work-item comment or checkpoint that
may be read from a DIFFERENT harness — this workspace holds ~50 independent
checkouts side by side under `~/papercupai-workspace/` (portal, calendar,
zero-harness, several papercup*/papercusp* trees, …) — REPO-QUALIFY the path:
prefix it with the checkout directory name, e.g. `portal/packages/ui/src/shell.tsx`,
not bare `packages/ui/src/shell.tsx`. A repo-relative path is only meaningful
WITH its repo; an unqualified one that happens to live in a sibling checkout
fails every same-repo probe (`ls`, `find`, `grep`) exactly like a fabricated
path would, and reads as a hallucination to the next agent even when it is
entirely accurate (EI-22169368425533789).

`work_items:checkpoint { dependsOn: ['file:<path>'] }` now probes sibling
checkouts automatically when a `file:` ref cannot be resolved in the item's own
harness, and names the repo it actually lives in when it finds a hit — but that
detector only fires for a `dependsOn` declaration, never for a plain path
quoted in prose. Qualify it yourself; do not rely on the detector to catch it.


## Branch discipline: the shared tree stays on `staging`; `main` is automation-only

- The canonical shared checkout (the repo root you are working in) **always has
  `staging` checked out**. Work on `staging` directly — **no `git worktree`, no
  feature branches**; coordinate via `locks:*` (per-edit hook is automatic) + `coord:*`
  (declare-intent), not tree isolation.
- **`main` is the GREEN branch** — it only fast-forwards to a staging commit
  that passed the green-checkpoint suite; nothing and no one pushes it directly
  (a pre-push hook blocks you).

## Commit discipline: git-sync owns commit + push — you do neither

A background **git-sync** routine commits the whole shared tree and pushes to
`origin/staging` on a schedule (superproject + every submodule). **No `git add`
/ `commit` / `push`, no stashing/branching to isolate "your" diff** — just leave
work in the tree. Merge conflicts go to a `merge-resolver` agent, not you. From
`staging`, green-checkpoint (hourly) FFs `main` and release-trigger (≤15 min)
auto-deploys it to `:3070`. Pipeline view: `/admin/git`. Long form + symptoms:
[repo-conventions § branch + commit](/internal/docs/system/repo-conventions).

> ⚠ **Checking whether your edit landed, and the path is inside a SUBMODULE? Run the
> check INSIDE the submodule** — and decide *whether it is one* with a COMMAND, never
> from memory or a list in a doc:
>
> ```bash
> git submodule status <path>          # prints a line = submodule; empty = not one
> cd <path> && git rev-parse --show-toplevel   # the repo root that actually owns it
> ```
>
> ⚠ Test the OUTPUT, not the exit code: `git submodule status` exits **0 either way**
> (verified 2026-08-03 on a submodule, a non-submodule under `libs/generic/`, and a
> plain source dir), so `git submodule status <path> && echo YES` prints YES for
> everything. Use `[ -n "$(git submodule status <path>)" ]`.
>
> There are dozens of them and the set moves, so any prose list here rots — including
> the counts in this very paragraph, which is why the commands above are the answer and
> the numbers below are only motivation. One list already rotted: it named only
> `papercusp-desktop` and `libs/generic/*`, omitting **`libs/papercusp`**
> — which holds every harness blueprint and agent role prompt
> (`libs/papercusp/packages/harness/blueprints/*/prompts/*.md`), one of the hottest edit
> paths on this fleet — plus `libs/agent-chat`, `libs/papercusp-db`,
> `libs/papercusp-shared`, `libs/test-config`, `libs/testing-shell`
> (EI-19441260942111774). "Is it under `libs/generic/`?" is not the test either —
> measured 2026-08-03, only **31 of the 61** directories there were submodules (e.g.
> `libs/generic/result-encoding` is plain-tracked in the superproject, `100644` blobs).
>
> From the superproject the answer is ambiguous in the one direction that matters.
> The superproject tracks only a gitlink (`160000 <sha> papercusp-desktop`), so
> **`git status --porcelain papercusp-desktop/<path>` prints NOTHING whether the file
> is committed or completely untracked** — and an untracked file inside a submodule
> never announces itself with the `??` you would expect. Both readings are available
> and both are expensive: read the empty as "clean, therefore committed" and a
> genuinely stranded edit reports as landed; read it as "git doesn't know this file"
> and a perfectly committed edit sends you to redo work.
>
> 🚫 **`git log -S` / `git log --` on a submodule path from the superproject has the
> SAME false-empty, and this one costs the most.** It answers "no commit *of this repo*
> touched that path" — true, useless, and shaped exactly like "this text was never
> committed", so the action it invites is rebuilding work that already exists. Measured
> 2026-08-03 on a prompt string in `libs/papercusp`: empty from the superproject,
> `b793dab4 2026-07-05` from inside the submodule.
>
> ```bash
> cd papercusp-desktop && git cat-file -e HEAD:<path-inside-submodule>   # exit 0 = committed
> cd papercusp-desktop && git status --porcelain <path-inside-submodule> # empty = clean, here it MEANS it
> cd libs/papercusp && git log --format='%h %cI' -S'<string>' -- <path-inside-submodule>
> ```
>
> `git ls-files --error-unmatch <path>` from the superproject is a useful *first*
> filter — it turns the ambiguous empty into an exit code — but note it exits
> nonzero for a submodule-internal path **and** for a genuinely untracked one, so
> nonzero means "not tracked by THIS repo", not "stranded". Only the in-submodule
> check above separates those two. (Measured 2026-08-02: all three cases confirmed
> on `papercusp-desktop/bin/tauri-guarded` — EI-19370400151089283.)

> ⚠⚠ **The SUPERPROJECT has the same trap for the opposite reason, and it is the far
> more common one: a clean `git status --porcelain <path>` here means THE SWEEP RAN,
> not that nobody edited the file.** git-sync commits the whole working tree every few
> minutes, so the window in which a genuine edit shows as dirty is only minutes wide.
> Outside it, an edited file and an untouched file are **indistinguishable** by that
> command. Every agent edit passes through this state, so the failure is routine.
>
> 🚫 **Never use an empty `git status` as evidence that a test file was UNTOUCHED** —
> i.e. that a passing suite *validated* a fix rather than having been edited to match
> it. That is the specific unsound inference this warning exists to kill, and it
> produces completion evidence that is well-formed, confidently stated, and confounded.
>
> Measured 2026-08-03 (EI-19393377570065475): an agent recorded verbatim *"The test file
> is UNTOUCHED (git status --porcelain empty), so the tests validated the fix rather than
> being edited to match it."* The file had been edited by a **different** agent 13 minutes
> earlier (`7d0cd443d0`, 00:48:50Z) — materialising fixtures that disarmed the very
> recurrence guard the fix relied on. `git status` was clean only because git-sync had
> already swept it, and the quoted BEFORE/AFTER (2 failed → 55 passed) could not
> discriminate the fix from those fixtures: 55/55 was already measurable with the unsound
> drop still in place.
>
> ✅ **Anchor the question to a SHA, never to wall-clock or working-tree cleanliness** —
> "was this file touched between the state I measured and now?":
>
> ```bash
> B=<the sha you measured at>; F=<path>
> git log --oneline $B..HEAD -- "$F"        # empty = genuinely untouched in THAT window
> [ "$(git rev-parse $B:"$F")" = "$(git rev-parse HEAD:"$F")" ] \
>   && echo UNCHANGED || echo CHANGED       # blob identity — immune to sweep timing
> ```
>
> This is the same blob-identity technique the gate-containment recipe below prescribes,
> and for the same reason: on a swept tree, identity is decidable where working-tree
> status is not.


> ⚠ **Neither `git blame` NOR a commit's SUBJECT (nor a `Co-Authored-By` trailer) is evidence
> about a change in this repo — never cite one, least of all in an escalation.** git-sync sweeps
> the WHOLE tree under ONE identity and labels it with whatever context was current, so blame
> names the wrong person and the subject describes the sweeping agent's INTENT, not the diff.
> For authorship use the commissioning work-item or a timestamp-correlated `sessions:search`;
> if neither resolves, say "not attributable" — never name a person.
>
> **Which commit carries your change → `TZ=UTC git log -1 --date=iso-strict-local --format='%cd %H %s' -- <path>`.
> NOT `git rev-parse HEAD`:** the tip is routinely a DIFFERENT commit from the same sweep, so
> quoting it attributes your work to a stranger's diff. Only a `--date=*-local` format honours
> `TZ`, which is what makes that stamp read `+00:00` and directly comparable to Papercusp's UTC
> timestamps; keep `TZ=UTC` on `--since`/`--until` too.
>
> ⚠ **Containment is a CONTENT question, never a date or ancestry one.** `git rev-parse
> <sha>:<path>` vs `git rev-parse staging:<path>` — equal blobs ⇒ it carries it.
> `merge-base --is-ancestor` proves REACHABILITY only and stays true after a later sweep reverts
> the same lines, so it is never evidence a fix is live. For "is my change live", ask
> `dev:pipeline_position { path }` or `state:read { cell:'gate.greenCheckpoint.candidate', as:'<path>' }`.
>
> ⛔ **Four of these misreport SILENTLY, each toward a confident WRONG conclusion — know the
> signature, then look up the exact form before you act:** `HEAD` is a WALL-CLOCK moving baseline,
> so `git show HEAD:<path>` minutes after an edit hands back YOUR OWN edit and a vacuous guard
> reads identical to a sound one · `TZ=UTC` is INERT on `%cd`/`%cI` (a `-04:00` stamp read as UTC
> is a silent 4h skew in gate triage) · a bare `rev-parse staging:<missing>` PRINTS the ref to
> stdout before exiting 128, and a SUBMODULE has no `staging` ref at all · `git show
> <ref>:<submodule path> > file` leaves a ZERO-BYTE file, so the positive control that must come
> back non-zero returns 0 and the whole scan is believed. A submodule path needs its own check
> INSIDE the submodule; equal blobs there prove the PATH is current, not the candidate — the
> gitlink moves underneath it.
>
> Exact commands, the measured incident behind each, and the gitlink-drift check:
> [git evidence and containment recipes](/internal/docs/agent-insights/git-evidence-and-containment-recipes).
THE BLAME CASE: a release-fixer sent a false blocker accusation to the OWNER
("confirmed by git blame: YOUR migration") for an agent's own incomplete work (WI-5111).

THE SUBJECT/SHA CASES, both 2026-08-10 (EI-20091120781966310):
· 83c96a8027's subject named AppImage webkit self-containment and contained three
  unrelated pot-git transport files; the real AppImage fix sat under subjects reading
  `chore(git-sync): auto-commit`. The filer nearly RETRACTED a true claim over it.
· During the same day's gate incident an agent cited `rev-parse HEAD` (594e98c704) as
  "my commit". It carried none of their work — that was in e2ff7006d2, a different
  commit from the SAME sweep, whose own subject described unrelated UI work. Two more
  agents propagated the wrong sha before it was retracted, and a third mis-attributed
  a census delta to a commit that touched none of the relevant files.

WHY IT IS WORSE THAN AN ORDINARY WRONG CITATION: bad evidence for a TRUE claim is the
nastiest shape, because both the original citation AND the naive correction are wrong.
Only reading the diff settles it — which is why the rule prescribes a command per
question rather than "be careful".

Full runbook:
[attributing-a-change-despite-git-sync-squash](/internal/docs/agent-insights/attributing-a-change-despite-git-sync-squash).

> 🚨 **NEVER run a tree-wide destructive git op on the shared checkout** — not
> `git reset --hard`, not `git checkout .` / `git checkout -- :/`, not
> `git clean -fd`, not `git stash`. The tree is edited CONCURRENTLY by the whole
> fleet, and everyone's edits sit **unstaged** until the next git-sync tick — so a
> tree-wide reset/checkout/clean/stash **silently and irrecoverably wipes every
> peer's in-flight work** (it was never committed, so it is not in any git object;
> kopia backs up only ~14KB of workspace-state, NOT the code). This is not
> hypothetical: on 2026-06-21 a `git reset --hard HEAD` (an agent "cleaning the
> tree" between commits) discarded a tested, in-flight fix and is the root cause of
> the recurring "my edits got reverted/overwritten by a concurrent fixer" reports
> that burned hours of fleet time. **To discard only your OWN change to ONE file,
> re-edit that file by hand** (or, only after confirming via `coord:presence` /
> `locks:list` that no peer holds it, `git checkout -- path/to/that.one.file` with
> an explicit path — never a pathspec-less or `.`/`:/` discard). If you think you
> need a clean tree, you don't: just stop editing and let git-sync commit. A Bash
> guard rejects these commands on the shared checkout — do not route around it.

**Never sit in a wait/poll loop for git-sync to "push your change" or the deploy to
land — force it instead.** The pipeline is async: keep working, and locate your edit
with `dev:pipeline_position` (not a browser). But when your *next step genuinely
requires* a code change to be **live on `:3070`** before you can proceed (you must
exercise it through the running operator), do **not** idle waiting for the scheduled
commit→checkpoint→deploy. **Force the deploy now:**
`PAPERCUSP_ALLOW_DEV_RESTART=1 npx tsx apps/operator/lib/release/deploy-cli.ts --execute`.
⚠ The `PAPERCUSP_ALLOW_DEV_RESTART=1` is **required** on the dev box — without it the
restart step is *withheld* and deploy-cli's auto-rollback leaves `papercup-release`
inconsistent (git files vs node_modules/build), which crash-loops `:3070` on
`MODULE_NOT_FOUND` (recover: `systemctl --user stop papercup-dev-api.service` then re-run
the command above with `--no-drain`). Blocking on git-sync / the green gate before
continuing is the anti-pattern; force it and move on.

**"Is my change live, and if not what is the ONE thing blocking it" is ONE call — `dev:pipeline_position { path }` — never a hand-diff.** It answers three *different* questions that agents routinely conflate:Hand-resolving those three questions cost 11 tool calls and 4 `merge-base`/`git log` diffs on 2026-07-26 and still went wrong twice.

| you want to know | read | not |
|---|---|---|
| is it live, and if not the ONE lever | `blockedOn` + `nextAction` (the `summary` now LEADS with them) | the row of position ticks — a boolean per stage cannot say whether that stage is *moving* |
| is this leg stuck, or just slow | `stages[].health` (`advancing`/`stalled`/`disabled`/`broken`) | `positions.*` alone — that read a 2h52m push freeze as "not yet" |
| did my work reach origin | `gitSync.pushedRepos` | `gitSync.status` — `'synced'` is reachable with **nothing** pushed |
| is the running process executing my code | `serving.startedSinceCodeChange` | `positions.deployed` — a git fact stating a process conclusion ("deployed ✓" ≠ live; filed 4× independently) |
| is the gate judging MY code | `changeInCandidate.markerJudging` — pass `marker`, a literal string YOUR change introduced. `judgingContainsPath` answers only about THE PATH YOU PASSED, so its `true` is a verdict on your change only when that path is one you actually edited; read `missingReason` before believing a `false` (see below) | trusting a bare `true` from a fixed probe path reused across wakes — it reads `true` on nearly every call while saying NOTHING about whether your fix is in the candidate |
| will the next tick commit my half-finished refactor | `sweepExposure` (blast radius + when) | nothing — git-sync sweeps the WHOLE tree, so `git-sync:run` mid-refactor commits the broken intermediate on purpose |

`nextAction: null` is a **positive** answer ("waiting is correct"), never a missing one —
do not invent a lever when the honest move is to wait. Full field-by-field guide:
[reading pipeline state](/internal/docs/agent-insights/reading-pipeline-state-position-health-nextaction).

**About to ACT on one of these values — or quote it into a message, a plan, or a
work-item? RE-READ it, don't copy it: `state:read { cell }`.** These same values are
registered CELLS off the *same* resolver (`gitPipelinePosition()`), so this is a
re-read, never a second source of truth: `gate.greenCheckpoint.candidate` ·
`gate.greenCheckpoint.verdict` · `gate.greenCheckpoint.ownership` ·
`git.mainBehindStaging` · `git.pipelinePosition` · `deploy.3070.sha` (omit `cell` to
list them). Every one is a value that changes under
you mid-turn, and a transcribed copy of one is how a correct observation becomes a
confidently wrong report an hour later.

✅ **You do not have to look any of that up — `dev:pipeline_position` HANDS YOU THE
HANDLE.** Its result carries a `plane` block: one entry per volatile value, naming the
`path` it sits at in that very payload, the `cell` that re-answers it, and a ready
`reread` call. Copy the handle, not the number. Two things to actually read there:

- **The handle is already addressed to YOUR subject.** `git.pipelinePosition` and
  `gate.greenCheckpoint.candidate` are per-path cells, so their entries carry
  `as: '<the path you asked about>'`. Re-reading either WITHOUT that `as` answers about
  a different subject — which is why a no-arg call emits `unreadable: { needs: 'path' }`
  for those two and no handle at all, rather than one that looks authoritative and
  resolves elsewhere.
- **An entry appears even when the value is `null`.** That is deliberate: a null
  deployed-sha or candidate is the reading you are *least* entitled to transcribe, so
  it is the one that most needs a handle.

The block is derived from each cell's own `changeSignal` declaration, so it cannot drift from the registry — a cell added, renamed or re-pathed shows up (or stops showing up) on its own (`state-plane-stamp.ts`).Landed under state-plane-adoption-2026-08-02 P-010.

Two specifics worth knowing:

- **"Is the gate red about MY change?"** — `state:read { cell:
  'gate.greenCheckpoint.candidate', as: '<your path>' }`. It is per-path on purpose, and
  its falsifier is a **blob containment** check against the candidate — the same
  primary method the long recipe below prescribes, run for you. Its stated job is to
  kill exactly one error: *"the gate is red" read as "the gate is red ABOUT MY
  CHANGE."* That error, not the red itself, is what repeatedly costs hours here.
- **Waiting for one to CHANGE** (a verdict, a deploy sha) → `state:subscribe`, not a
  poll loop and not a hand-built await.

⛔ **A RED CANDIDATE IS FROZEN ON PURPOSE — never "just re-run" the gate at tip.** The standard main-greening procedure is **freeze-and-converge** (`RELEASE_FREEZE_AND_CONVERGE_DEFAULT`, default ON; P-013 / D-007). On the first real code red the gate opens ONE frozen repair queue, and every later run RESUMES that exact candidate rather than a newer tip. Turning it off restores the treadmill D-007 diagnosed, where each new cut re-admits the whole sweep and imports breakage faster than fixes land.

So when the gate is red: **author the fix on the shared staging checkout as normal — there is NO repair worktree (D-010) — wait for git-sync to commit it, then land it on the frozen lineage BY PATH: `release:repair-queue { op:'admit', paths:[...] }`**, naming exactly the files you changed (dry run by default; `confirm:true` publishes). That lands your fix ON TOP of the frozen candidate (advancing `repairHead`); the queue re-tests that head itself, and the immutable candidate never moves. Admission is hunk-exact (D-008): only YOUR ledgered hunks ride in, so a peer's concurrent edit in the same file stays out. An admission whose file imports a sibling you did not name is refused `admission-incomplete` naming that path — admit it too; **the tip is NEVER widened for you.**

Do NOT fire `release:checkpoint-run` to "try again" as a bypass: when a frozen queue exists, it applies the queue policy and resumes the exact frozen lineage (`ready-to-test` uses `queue.candidate`; `ready-to-verify` uses `queue.repairHead`; non-suite states refuse before launch). Only when no frozen queue exists does it cut a fresh candidate from the current quiet cut at tip. Do not hand-pin with `--candidate` either.

`release:repair-queue { op:'retire' }` clears ONE queue ROW, not the mechanism, and is **not a "make the gate move" lever**. Retire ONLY when the queue is provably *unreachable-green*: its fixer is dead AND the fixes are absent from the frozen candidate (per path, `git rev-parse <candidate>:<path>` vs `git rev-parse staging:<path>` — equal blobs mean the fix is NOT in it). Then let the next run re-freeze; do not start re-cutting.

✅ **"Is the freeze ON, and if not WHY" is a READ — do not grep run logs.** `gate_health.freezeAndConverge` returns `{ enabled, state, reason, candidate }`; `release:deploy status` renders it as one line. `state` is **`off` · `none` · `held` · `retired` · `converging`**, and **`reason` is load-bearing** — a state without its reason sends you back to the logs this read replaces.

⚠ **`off` and `none` are NOT synonyms.** `off` = the mechanism is switched off, so reds do not freeze at all; `none` = it is ON and simply had no frozen candidate this tick, which is a green gate's normal state. A retire CLEARS the queue row, so `repairQueue` reads null exactly when it matters most: read the disposition, not the queue's absence.

A surprising refusal is build-scoped: compare `refusal_provenance` with `/api/health` on `:3170` and `:3070` ([two-port A/B](/internal/docs/agent-insights/connection-closed-6432-is-an-idle-tx-kill-not-pgbouncer)) — **a deployed refusal can be stale while staging accepts the request.**
Evidence behind the freeze-and-converge rule (the rule itself is the invariant sibling; this is the case history, kept out of the projected guide).

## Why `off` and `none` must never be conflated

`gate_health.freezeAndConverge.state` has two values that both read as "nothing frozen right now" and mean opposite things. `off` = the mechanism is switched off, so reds do not freeze at all; `none` = it is ON and simply had no frozen candidate this tick, which is a green gate's normal state. Conflating them is how freeze-and-converge sat off fleet-wide for a full day — 20 frozen candidates retired, 0 resumed — while looking like an ordinary week. A retire CLEARS the queue row, so `repairQueue` reads null exactly when it matters most: read the disposition, not the queue's absence.

## Why a surprising refusal is build-scoped

A refusal carries `refusal_provenance`, the build that produced it. The serving host is recorded per call, so the same owner has been served by both `:3070` and `:3170`; a refusal from a deployed (`:3070`) build can be STALE while staging (`:3170`) accepts the identical request. Compare `refusal_provenance` with `/api/health` on each port before attributing a refusal to current queue policy. Worked example: [two-port A/B](/internal/docs/agent-insights/connection-closed-6432-is-an-idle-tx-kill-not-pgbouncer).


✅ **It DOES answer *"which sha is the run judging right now"*, AND it now names its own
provenance — read `source.authoritative` before you act on the sha.** The cell returns
`source: { value, authoritative, why }`: `'retriage-marker'` is authoritative (the run's OWN
published `inFlightRetriage` marker — an observation of what it is judging), `'run-probe'` is
NOT (on a MANUAL run its `/tmp` unit log, but on a CRON run it degrades to the checkpoint
checkout's live HEAD, an inference that changes between two reads). A non-authoritative
reading is also hoisted into the reply's `summary`, so you cannot miss it. Do not fire a
manual re-run off an inferred candidate. Raw `harness_shared.routines` SQL is the LAST resort.

⚠⚠ **This passage asserted the OPPOSITE of the truth for six days, in three different ways —
distrust any older note repeating it** (WI-36259, fixed 2026-08-08). It said the cell's sha
was "already marker-preferred per WI-7035". **It was not.** WI-7035 fixed
`checkpointRunInFlight.candidate` ONLY — its own title says so — while the cell's headline,
`changeInCandidate.judgingSha`, came from `checkActiveCheckpointRun`, which never reads the
marker at all. So one resolver produced TWO shas for the same subject and they DISAGREED
during a re-triage window: `checkpointRunInFlight` named the live candidate, and the cell this
file points triagers at named the **ABANDONED** one. The doc also sent readers to
`changeInCandidate.candidateSource`, a field that **never existed** (it was on
`checkpointRunInFlight`). `reconcileGateCandidates` now makes the headline marker-preferred
and labels it, so the two agree by construction.

**The transferable lesson, because this shape recurs here:** a fix landed on one field, and
the doc generalised it to a SIBLING field that never got it. Both fields were real, both
names plausible, and the claim was written with a ✅ and a citation — the citation
(`candidate: marker ? marker.refiringCandidate : candidate`) was even accurate, just about a
different object than the sentence around it. Nothing in the passage looked wrong. **When a
doc credits a fix to a field, verify the fix landed on THAT field** — read the writer, not
the citation — and be most suspicious when the surrounding prose is confident and recent.

⚠ **`judgingContainsPath: false` with `missingReason: 'newer-commit'` does NOT mean your
change missed the candidate — and on a shared file it usually means the opposite.** That
verdict compares the path's **current content**, so the moment ANY peer commits to the same
file after you, it flips false and stays false: the tip is always newer than the quiet-cut
candidate. Following the re-fire lever it used to emit can therefore never succeed — it just
restarts a ~55min suite clock. This cost ~2h of the 2026-07-27 fleet-wide `facts:assert`
outage (EI-18797292094433710): two wakes re-fired the gate while *every* candidate already
carried the fix.

⚠⚠ **THE PREMISE UNDER EVERY RECIPE BELOW: the candidate is cut from your LOCAL `staging`,
NOT from `origin/staging`. The gate never fetches — so pushing is not a precondition for the
gate to SELECT A CANDIDATE, or to RUN.**

⚠ **That is scoped to the gate's INPUT on purpose — do NOT read it as "the push doesn't matter
to the gate".** PROMOTION, the gate's OUTPUT, publishes the tested candidate to origin and is
load-bearing BY DESIGN: `pushGreenCandidateOrThrow` runs BEFORE `deps.advance(...)` on every
promotion path and RETHROWS on failure (swallowing it would let local `main` advance and emit a
false deployable verdict). So while the push credential is broken, the run throws before any
promotion decision — no advance, no `GATE_PROMOTION` trailer, and **no green is recordable at
all**. Both halves hold at once, and you need both: an unpushed commit IS already in the
candidate (every containment recipe below stands), AND a failing push hard-freezes promotion.
Grep those symbols rather than a line number — the numbers this claim used to carry had already
rotted. The ordering is pinned by
`packages/operator-core/lib/doc-claims/gate-promotion-push-precedes-advance.test.ts`, so this
text and `green-checkpoint.ts` cannot drift apart silently.
Measured 2026-08-16 (EI-20626763969105622, found during WI-39450 gate-red triage). GitHub was
403ing every push ("You must verify your email address"). An agent read the then-unscoped
sentence — *"PUSHING IS NOT A GATE PRECONDITION"* — and told both a peer and the owner that the
403 did not block the gate and that firing `release:checkpoint-run` was therefore safe. Both
wrong. The 11:22Z run had already shown the signature: `green=true` logged, then not-green 4ms
after the push 403, and no `GATE_PROMOTION` trailer written. A peer held the line and was right;
firing would have bought a 4th consecutive red plus a ~55min suite on a memory-thrashing host.

The instructive part is that the sentence was doing its job perfectly for the recipes beneath
it, which really are about candidate selection, while mis-arming anyone reasoning about the gate
as a whole. An emphatic claim scoped to one leg of a system reads as a claim about the system,
and the more load-bearing the framing ("the premise under every recipe"), the more confidently
it is generalised. The repair is to name the leg inside the sentence, not to soften it — the
input claim is still exactly as strong as it was.


green-checkpoint resolves it as `opts.candidate ?? opts.candidateHint ?? cfg.integrationBranch`, and `integrationBranch` defaults to the literal `'staging'` (`overrides.integrationBranch ?? process.env.PAPERCUSP_INTEGRATION_BRANCH ?? 'staging'`, in `release-config.ts`). Grep those expressions rather than a line number — the numbers this box used to carry had rotted to unrelated code by 2026-08-31 while the claim itself stayed true, which is the whole failure mode the derived-truth ladder warns about. There is no `git fetch` invocation anywhere in `green-checkpoint.ts`, and every `origin/` mention is either the post-green promotion push or prose about GitHub Actions' `origin/main` base-ref default — none resolves a candidate. Its submodule resync is `submodule update --init --recursive`, never `--remote`, so it materialises the gitlink the candidate already PINS instead of advancing it to a remote tip. The CLI path cuts the same way. So the hop that matters for containment is **COMMIT** (git-sync's local commit); the push to origin is a separate, later concern that no containment test below depends on.


⚠ **A path inside a SUBMODULE needs its own containment check — every blob recipe above answers about the wrong object.** The superproject tracks a submodule as ONE gitlink, so `git rev-parse <candidate>:<sub>/<path>` is ABSENT and `git log -S… -- <sub>/<path>` is empty regardless of what the submodule holds. Both read exactly like *"my fix is not in the candidate"*. Not a corner case: there are ~37 submodules here and **every DB migration lives in `libs/papercusp/libs/db/sql/`**, so the whole recurring class of migration gate-reds lands on it.

✅ **The cell answers it — ask with the SUPERPROJECT-relative path, exactly as for any other file:**

```
state:read { cell: 'gate.greenCheckpoint.candidate', as: 'libs/papercusp/libs/db/sql/727-….sql' }
```

It resolves the gitlink the judged candidate PINS and compares blobs **inside** the submodule, so `changeInCandidate.judgingContainsPath` is a real verdict. Read `changeInCandidate.submodule` beside it: `{ path, relPath, judgingPin, nextPin }`. A `false` with `missingReason:'newer-commit'` means the **superproject gitlink bump** is what the candidate lacks — the hop that matters is git-sync's superproject COMMIT. An unreadable gitlink returns `resolver-failed` — a measurement that failed, never a verdict.

⛔ **Do NOT reach for `git ls-remote origin refs/heads/staging` to answer this.** It is the natural next thought — *"the gate must see it on the remote"* — and it is wrong: the candidate is cut from LOCAL `staging` and the gate never fetches, so a committed-but-unpushed gitlink is ALREADY in the candidate. Asking the remote returns NOT-IN-CANDIDATE for a fix the gate can see.

> ⛔ **`git show <ref>:<submodule path> > file` leaves a ZERO-BYTE file behind, so a POSITIVE
> CONTROL built from it reports 0.** The shell creates the redirect BEFORE git runs, so the
> `fatal: path '…' exists on disk, but not in 'HEAD'` (exit 128) still leaves an empty file, and
> every later `grep -c` on it returns 0 — the exact reading that means "the string is already gone
> / my pattern is wrong". So it defeats the one check meant to catch a broken instrument: the
> control that MUST come back non-zero comes back zero, and the whole scan is then believed. Same
> false-zero family as a `| head` SIGPIPE truncation or a wrong-relation SQL zero-row. Extract
> INSIDE the submodule with a SUBMODULE-relative path, and check the exit status:
> `git -C libs/papercusp show "HEAD:plugins/design-phase/index.cjs" > /tmp/before.cjs || { echo EXTRACT-FAILED; exit 1; }`

> ⚠ **Equal blobs prove that PATH is current — NOT that the candidate is.** When a failing
> test's runtime SUBJECT lives in a submodule (e.g. `readdirSync('…/libs/papercusp/libs/db/sql')`),
> the test blob is identical in both refs while the gitlink moved underneath it — so containment
> answers "not stale" on a red that is pure staleness. Diff the gitlinks too:
> `git diff --raw <sha> staging | grep '^:160000'`. ⛔ And `git diff <sha> staging -- <sub>/<file>`
> prints NOTHING for a submodule-backed path — a superproject diff carries only the gitlink — so the
> empty result reads as "the subject did not change" and CONFIRMS the wrong conclusion.

Manual gitlink-resolution fallback (when the cell is unavailable, or you need a sha the gate is not judging): [git evidence and containment recipes](/internal/docs/agent-insights/git-evidence-and-containment-recipes).


Get this wrong and every recipe below still *runs*, but answers about the wrong object: an
unpushed commit reads as "not in the candidate", the push leg looks like the thing blocking you,
and the natural next move is either to wait for a push that was never blocking or to fire a
manual `release:checkpoint-run` that **discards a live auto-refire rescue** and costs a ~55min
suite.

**Corroboration requires independent EVIDENCE, not independent recall.** Two agents agreeing is not confirmation when both merely inherited the same unstated convention. The claim in this box is pinned to the code by `packages/operator-core/lib/doc-claims/gate-candidate-ref.test.ts`, so a gate that legitimately starts reading a remote ref fails there and forces this text to be updated with it.This section documented containment in enormous detail for months while never stating the premise, and the cost landed on 2026-08-09 (WI-37590, EI-20022093720663793): two agents independently assumed `origin/staging`, and one broadcast gating advice built on it to three peers mid-incident before retracting it. Their independent agreement *felt* like corroboration.

⚠⚠ **STEP 0 FIRST — establish WHICH sha is actually being judged. Skipping this is the
expensive mistake, and no amount of care in the steps below can recover from it.**

✅ **ONE CALL ANSWERS STEP 0 AND STEP 1 TOGETHER — do this before you write any SQL:**

```
state:read { cell: 'gate.greenCheckpoint.candidate', as: '<your repo-relative path>' }
```

It returns the judged sha plus **`source.authoritative` — read that FIRST**: a `run-probe` reading is an *inference* (on a CRON run, just the checkout's live HEAD), so never fire a manual re-run off one. Everything below is the FALLBACK for when it answers `unknown`. Field-by-field: [reading pipeline state](/internal/docs/agent-insights/reading-pipeline-state-position-health-nextaction).
Verified live 2026-08-08.

The `candidate` field DRIFTS: a single continuous run reports different candidates over its
lifetime. Observed 2026-08-02: one run with an unchanged `started_at` of 07:15:17Z (elapsed
climbing 1138 → 2887s, so provably not a new run) reported `1ee32228` and later `4a9b218ba0`.

**That drift is a FEATURE, not corruption.** The gate AUTO-RE-FIRES onto tip *inside the same
process* — see "A RUN'S JUDGED CANDIDATE CHANGES MID-RUN" below for the mechanism and for the
`inFlightRetriage` marker, which is **the authoritative answer to "which sha is this run
judging"**. In the case above the run genuinely had re-candidated onto `4a9b218ba0`, and that
candidate genuinely did carry the fix.

🚫 **Do NOT settle this by comparing commit dates to the run's `started_at`.** This file used to
prescribe exactly that — `newer than started_at? -> the field is BOGUS`, justified by "a run
cannot judge a commit that did not exist when it started". **That is WRONG for this gate, and
the recipe has been removed.** `apps/operator/lib/release/green-checkpoint.ts` recurses into
`runGreenCheckpoint(..., { candidate: tip, refireAttempts: +1 })` in-process at two sites —
L2617-2621 (test-file rescue) and L2661-2665 (the lint/typecheck sibling, which is the path a
`lint:tsc` red takes) — so `pid` and `started_at` stay FIXED while the candidate legitimately
advances past them. **A candidate newer than `started_at` is the expected signature of a healthy
re-fire.**

That check was seductive precisely because it looked free ("no marker/blob/ancestry needed"),
and it fails in the most expensive direction: it fires a false `BOGUS` exactly during the
re-triage window — i.e. when the gate is rescuing itself — and the reflex that follows a `BOGUS`
verdict is to fire a manual `release:checkpoint-run`, which discards the rescue and costs a full
suite. If you carry the old rule in memory from an earlier session, drop it.

⚠ **Do not try to settle step 0 by reading a checkpoint worktree.** There are at least two and
their names differ by one letter — `papercup-checkpoint` (HEAD dated 2026-07-02, a month stale)
and `papercusp-checkpoint` — plus transient `papercusp-checkpoint-simtmp-*` dirs. On 2026-08-02
neither matched the candidate the tool was reporting, and reading the wrong one produced a
confident wrong answer that went out to 16 agents. A worktree HEAD is a *live* read of a tree
that may be between runs, mid-reset, or simply not the one the gate is using.

⚠ On that same `held_externally: true` (cron) reply the fields have **OPPOSITE** trustworthiness, so
do not tar them with one brush — this file used to, and discredited the only reliable one (WI-7041):

- **`started_at` / `elapsed_sec` — TRUST THEM.** They do NOT describe the idle manual unit. They come
  from `checkRunLockHeld`, which reads the RUN LOCK's owner record and returns nothing unless
  `pidAlive(owner.pid)` — so they describe the process actually holding the lock, i.e. the cron run.
  Measured 2026-08-02 11:48Z: `ps` put pid 514562 at 11:15:03Z, the tool reported 11:15:04.561Z and
  `elapsedSec 1980` (33m), matching wall-clock. Run age + a liveness-verified lock owner is exactly
  what separates "healthy long run, wait it out" from "wedged, intervene".
- **`candidate` — AN INFERENCE, not an observation.** This branch returns before the log parse and
  reports the checkpoint checkout's live HEAD, which silently changes between two reads and is right
  only while that checkout stays pinned. This is the field that deserves the caution — settle it
  from the `inFlightRetriage` marker instead.

**The only primary observation is the verdict itself, which names its own candidate.** When the
containment question cannot be settled from primary evidence, say so and wait — do not arbitrate
it from these fields. Four agents produced four contradictory conclusions here in ninety minutes,
each reasoning correctly from the same untrustworthy inputs.

**FALLBACK — the routines marker in Postgres (the CELL above comes first).** This is the RAW
source the resolver itself reads through (WI-7035), so hand-querying it repeats work
`state:read { cell: 'gate.greenCheckpoint.candidate' }` has already done. Come here when the
cell answers `unknown`, or for a field it does not carry: `consecutiveReds`, the refire budget,
or a marker you need to age-check yourself. It is the only RAW read that answers step 0 for a
SCHEDULER-fired run, and the raw authority for a LIVE one:

```sql
SELECT metadata->'gate_health'->'inFlightRetriage'   AS live_refire,     -- the LIVE run's candidate
       metadata->'gate_health'->>'observedCandidate' AS last_completed,  -- the LAST COMPLETED pass
       metadata->'gate_health'->>'consecutiveReds'   AS reds
  FROM harness_shared.routines
 WHERE target_role = 'system:green-checkpoint'
   AND install_slug = '<harness>' AND workspace_id = '<workspace>';   -- multi-tenant: scope BOTH
```

The two keys answer DIFFERENT questions — conflating them is its own confident-wrong-answer path:

- **`inFlightRetriage` non-null ⇒ its `refiringCandidate` IS the sha being judged right now.** Null ⇒
  no refire in flight ⇒ the run is still on its first candidate. Treat a marker older than 3h as an
  abandoned run.
  ⚠ **`refireAttempt`/`maxRefires` are NOT "how much rescue budget is left"** — this file used to say
  they were, and that reading is wrong in the direction that costs you a suite. There are **two**
  bounds and they advance differently (EI-19343532231631821): `refireAttempt` counts only refires
  whose failures OVERLAP the set already being rescued — i.e. **FAILED** rescues — while
  `totalRefires` counts every refire and is bounded by `absoluteCeiling` (= `maxRefires` × 3). So a
  run five successful rescues deep reads `refireAttempt 0/2` — indistinguishable from "hasn't
  refired yet" — while sitting one red away from the ceiling, where the next red really does STICK.
  Read BOTH, and prefer the tools: `dev:pipeline_position`'s mid-rescue note and
  `release:checkpoint-run`'s `in_flight_retriage.budget`/`at_cap` both render them via one shared
  helper (`describeRefireBudget`, `packages/operator-core/lib/release/in-flight-retriage.ts`), so
  they cannot drift from each other or from this paragraph.
- **`observedCandidate` names the LAST COMPLETED pass**, never the live one — the same caveat this
  file already states for the persisted checkpoint-logs. Reading it as the in-flight candidate is a
  guaranteed one-pass-stale answer.

⚠ **Scope BOTH `install_slug` AND `workspace_id`.** That table is multi-tenant, one row per harness.
Measured 2026-08-02 11:44Z, ordering it `last_fired_at DESC LIMIT 5` returned oddsmith,
hello-world-hive, dummy-pot-0707, quartermaster and hello-world-3 — `papercusp` was not in the top
five. An unscoped query returns some other harness's gate: well-formed, confident, wrong.

🚫 **The `/tmp/papercup-green-checkpoint-manual-*` grep below covers MANUAL runs ONLY — a
scheduler-fired run writes no such log at all.** This file used to present that grep as *the* answer
to step 0. It is cron-blind, and it fails in the most expensive direction: `ls -t` cheerfully returns
the newest MANUAL log, which during a cron red is hours old, and its last `checkpointing candidate`
reads exactly like a fresh answer. Measured 2026-08-02 11:45Z against the live 11:15:03Z cron run —
the grep returned `4961cfb8` (discarded ~2h earlier) while the marker returned
`refiringCandidate: 16dbb52a7849`; the running process (pid 514562) held no `.log` fd at all. Two
agents hit this in one morning, one correctly filing "candidate undeterminable" while the answer sat
in Postgres (EI-19340690933031666).

**For a MANUAL run the run's own log is still a good second source.** It emits
`checkpointing candidate <sha>` (green-checkpoint.ts:2348) *once per candidate*, and the in-process
auto-refire RE-EMITS it — so the **LAST** match is the sha being judged, and the number of matches is
the number of candidates that run has had:

```bash
# MANUAL runs only. Pick the NEWEST log by mtime FIRST, then take that ONE file's last candidate.
# Check that mtime against the run you care about — a stale manual log looks identical to a fresh one.
f=$(ls -t /tmp/papercup-green-checkpoint-manual-*T*Z.log | head -1)
grep -o "checkpointing candidate [0-9a-f]*" "$f" | tail -1
```

⚠ **Do not collapse that to a single `grep … *T*Z.log | tail -1`.** The glob expands sorted by the
UNIT-NAME segment before the timestamp, so the alphabetically-last file is not the newest run —
measured 2026-08-02, the one-liner returned a candidate from a **2026-07-17** log belonging to a
different unit. Select the file by mtime, then grep it.

Measured 2026-08-02 on the live 08:37Z run: `14fb28da` at byte 177, `auto-refiring (attempt 1/2)`,
then `4961cfb8` at byte 2281 — two candidates, one run, and the second is the real one.
Cross-checked against the verdict's own persisted log, whose FILENAME independently names it:
`~/.papercusp/checkpoint-logs/<ts>-base-<sha>-cand-4961cfb8b3fc.log`. Those two sources are
independent, so when they agree the candidate is settled. Note the persisted log is written at each
pass's END, so during a live run it names the PREVIOUS pass — use the persisted filename to confirm a
COMPLETED verdict, and for a run still in flight prefer the `inFlightRetriage` marker above (the
`/tmp` unit log only exists if that run was fired MANUALLY).

⚠ **Do NOT take the FIRST match, and do not trust `release:checkpoint-run`'s `candidate` over this
grep.** Until EI-19327704778173646 that field came from a bare `.match()` on the log — the FIRST
occurrence — so after a refire it reported the sha the run had already DISCARDED, while the reply's
own prose said "verify your fix against THAT sha." Its `held_externally` sibling fails the opposite
way: it reads the checkout's live HEAD, so it is CORRECT but silently changes between two reads.
That opposite-direction pair is why two careful agents could observe contradictory things and both
be right. The fix reports the LAST candidate and adds `initial_candidate` / `refire_observed`, so a
candidate that legitimately MOVED now says so instead of looking like corruption.

⚠ Two traps specific to this grep: keep the `*T*Z.log` glob (bare `-manual-*.log` also matches the
synthetic test logs — EI-19326961954611487), and note these shas are **8-hex** on purpose
(`candidate.slice(0, 8)`), so the "ignore any sha that is not 40-hex" rule stated below applies to
the displacement lines, *not* to `checkpointing candidate`.

**Then — and only then — settle containment with ancestry + blob against THAT sha. Step 1
without step 0 proves the right thing about the wrong object:**

```bash
C=<the candidate you confirmed in step 0>; F=<your path>; S='<a string your change INTRODUCED>'
git log --oneline -S"$S" -- "$F" | tail -1     # OLDEST count-changing commit = the INTRODUCING one
git merge-base --is-ancestor <that commit> $C && echo IN || echo NOT-IN
[ "$(git rev-parse $C:"$F")" = "$(git rev-parse HEAD:"$F")" ] \
  && echo BLOB-IDENTICAL || echo INCONCLUSIVE   # blob-level confirmation
```

⚠ **The blob line compares IDENTITY, not a count — and this is a correction, not a
style preference.** It used to read `git show $C:"$F" | grep -c "$S"`, which is the
very check this file warns about forty lines below ("**A count DELTA is not
presence**"). A count is satisfied by any pre-existing occurrence of `$S`, so it
returns a confident nonzero for a candidate that does not contain your change; that
produced repeated retracted verdicts on 2026-08-02. Comparing blob SHAs cannot be
fooled that way, and needs no unique string at all.

**It is asymmetric — read it in one direction only:**

- **`BLOB-IDENTICAL` → definitive YES.** The candidate's version of that file *is*
  byte-for-byte yours. Nothing further to check; stop here.
- **`INCONCLUSIVE` → NOT "absent".** It means only that the file differs somehow —
  and on a file the fleet is editing, a peer's later commit makes it differ almost
  always. Fall back to the ancestry form above (`git log -S… | tail -1` +
  `--is-ancestor`), which isolates *your* introducing commit — but read BOTH caveats
  below first (`tail -1` not `-1`, and `-G` not `-S` when searching by a name), because
  that fallback is where both false-negative traps live.

Treating `INCONCLUSIVE` as "my change is missing" would re-create the `marker` bug
with the sign flipped, and send you to re-fire a gate that already carries your work.

## Ratified designs: implementation owes current passing visual evidence

## Ratified designs owe current passing visual evidence

After `design-phase.ratify_reference`, completion owes current passing `design-phase.compare_render` evidence for every case; inspect with `design-phase.get_design_evidence`. Each viewport/theme/state needs its own reference. Only engine verdicts count. Resolve missing, stale, invalid, and failing cases; visual parity never replaces responsive, interaction, functional, or accessibility checks. Explicitly retract obsolete references. While enforcement is report-only, treat returned `designEvidence` refusals as blocking.
## Full pre-compression rule text (preserved)

## Ratified designs owe current passing visual evidence

Unratified mockups constrain nothing — explore freely. Once a reviewer ratifies a
reference (`design-phase.ratify_reference`), implementation of that surface owes
CURRENT PASSING evidence for every required case before it can be completed.
Produce it with `design-phase.compare_render`; read what a surface owes and has
with `design-phase.get_design_evidence`.

- **One reference = one image = one environment (D-019).** A required case must be
  contracted at the reference's own viewport/theme/state — `compare_render` refuses
  a cross-environment capture, since comparing a 1280x800 reference against a
  390x844 render measures the viewport, not fidelity. Cover a second breakpoint or
  state by ratifying a **second reference**, never by adding a case to the first.
- **Only deterministic engine evidence counts (D-004).** `advisoryNotes` explains a
  failure; no prose turns a `fail` into a `pass`.
- **Four ways evidence fails, each fixed differently:** *missing* (never compared) ·
  *stale* (bound to a superseded revision — the stored record still reads
  `verdict: 'pass'`, which is why this one gets misread as green) · *invalid* (no
  meaningful verdict, or an unreadable schema version) · *failing* (diff exceeds
  policy). The refusal names every unmet case and its remedy at once — fix as a batch.
- **Visual evidence supplements, never replaces.** A green design gate says the pixels
  match at the ratified environments; you still owe responsive, interaction,
  functional and accessibility validation.
- **Retraction is the legitimate exit.** If the design no longer applies, retract the
  reference — the surface becomes unconstrained again, as a recorded transition.

Today the gate REPORTS rather than blocks on `work_items:complete`
(`DESIGN_EVIDENCE_GATE` on, `DESIGN_EVIDENCE_GATE_ENFORCING` off, per D-006): the
`designEvidence` line on your completion result is the refusal you will get once
enforcement lands. Treat it as one.


## Commit discipline: git-sync owns commit + push — you do neither

⚠⚠ **Blob identity answers "does this candidate carry my fix" and NOTHING ELSE. It does
NOT predict whether a test will appear in the next failing set.** `test:affected` selects
suites from each candidate's OWN changed paths, so two candidates with different
diffs-from-base run different suites — an unchanged file may not be RUN at all. Never
reason *"the blob is identical to the candidate that red'd on it, therefore it will red
again"*: that is a statement about content masquerading as a statement about a verdict.
The ONLY source for a failing set is that run's own `AFFECTED_TESTS_FAILING_FILES` line.

Measured 2026-08-03 (EI-19424058100380982): `apps/operator/app/_lints/css-tokens.test.ts`
is byte-identical between candidate `3b70938b2a` (which red'd on it) and `cf84126b` — and
`cf84126b`'s verdict (`coverage=complete fileCount=3`) does not contain it. An agent
broadcast the prediction hive-wide off a correctly-run blob check and had to retract it.
This is the dangerous shape: rigorous method, real measurements, confident wrong answer.

⚠ **`tail -1`, not `-1`.** `-S` lists every commit where the occurrence count changed,
**newest first**, so `git log -1 -S…` returns the MOST RECENT such commit, not the introducing
one. They differ whenever you touch a symbol twice — the normal case for work in progress — and
testing ancestry with the newer commit against a candidate cut between the two reports `NOT-IN`
while your change is in fact present. That is the exact false negative this recipe exists to
eliminate, and it sends you off to re-fire a gate that already carries your change.

Verified in this repo 2026-08-02 — `backingTables` in `sync-resolver/index.ts` has **five**
count-changing commits, and against gate candidate `1ee32228` the two forms disagree:

```
git log --oneline -1 -S backingTables -- "$F"        -> bd5ba29a9b : NOT-IN  <- FALSE NEGATIVE
git log --oneline    -S backingTables -- "$F" | tail -1 -> 362398846f : IN   <- correct
blob truth: backingTables occurs 14x in that candidate                       <- plainly present
```

⚠⚠ **`-S` is blind to a change that REWRITES a line without changing occurrence counts — use
`-G` whenever you are searching by a NAME you did not introduce.** `-S` lists commits where the
COUNT of the string changed. A commit that swaps a keyword, retypes a declaration, flips an
operator, or edits a value leaves the count identical, so `-S` cannot see it at all — and
`--is-ancestor` then answers correctly about the WRONG commit, which is worse than answering
nothing. `-G` matches any diff line touching the pattern and does see it.

The recipe above is still right *on its own terms*: `S='<a string your change INTRODUCED>'` is
genuinely new, so its count genuinely changes. The trap is the entry path — you reach for this
recipe precisely when a peer hands you a root cause as an IDENTIFIER ("the bug is
`AdvRosterArgs`"), and an identifier is a pre-existing token, not an introduced string.

Verified in this repo 2026-08-02 on `apps/operator/lib/adv-roster-args.ts`. The gate-red fix
`66908db5bf` changed `-export interface AdvRosterArgs {` → `+export type AdvRosterArgs = {`,
leaving the count at 1:

```
git log --oneline -S'AdvRosterArgs' -- "$F"   -> afba95d487              <- MISSES the fix
git log --oneline -G'AdvRosterArgs' -- "$F"   -> 66908db5bf afba95d487   <- correct
```

Cost when it fired: an agent used `-S`, concluded a peer's correct root-cause attribution could
not be corroborated, and broadcast that doubt hive-wide before retracting it (WI-7030).
**Rule of thumb: searching by a name you did NOT introduce → `-G`; by a string you DID introduce
→ `-S`. When in doubt run both — they disagree only in the cases that matter.** Note that the
BLOB-IDENTITY check above is immune to both this and the `tail -1` trap, which is why it is the
primary and log archaeology is the fallback.

**No string unique to your change?** Use a *semantic discriminator* instead of a token: diff the
CHANGED ASSERTION TEXT between candidate and HEAD. The OLD text disappearing is as informative
as the NEW text arriving, and unlike a token count it cannot be satisfied by something that
pre-existed.

⚠ **This corrects two claims this section used to make.** Both were wrong, and together they
pushed the fleet onto the unreliable path — three agents independently hit the resulting
false verdict inside ten minutes on 2026-08-02 (EI-19325709344484737, EI-19325915429897280):

- ~~"`--is-ancestor` has nothing sound to test"~~ — **false.** It is true that git-sync commits
  the whole tree under one identity, so no commit is identifiably yours *by author*. But
  `git log -S'<a string your change introduced>'` finds the commit that INTRODUCED your change
  regardless of who authored it, and `--is-ancestor` on **that** commit is exact. Authorship
  being unusable does not make ancestry unusable.
- ~~"The marker verdict is definitive both ways"~~ — **false.** `marker` is a substring/count
  test with no notion of attribution, so a marker that is not unique to your edit returns
  `present: true` and, worse, flips the `onStaging`/`inMain`/`deployed` legs from a correct
  `false` to a wrong `true` with prose explaining the correct answer away as a newer-commit
  artifact. Measured: marker `operator_turns` (already present 1× in the unmodified file)
  reported a change as on staging, in main AND deployed when it was in none of the three.
  **ANY nonzero count is unsafe when the token pre-existed** — a high count is not "obviously
  wrong enough to catch". Corroborated independently the same morning: `knownQueryNamesV2`
  stood at 3 in a candidate that provably lacked the fix and 4 at HEAD, and that symbol *looks*
  specific to the change. **A count DELTA is not presence.** Count-1 is merely the most
  seductive case, because count-1 is exactly what a genuine one-line addition looks like, so
  nothing on the surface looks wrong at all.

`marker` is still useful as a *quick* check, but only if the string is one the change
**INTRODUCED** and that the file never contained before — never a bare identifier, table name,
or type name the file already used. Treat a marker result as a hint; treat ancestry+blob as
the verdict.

⚠ **`callerEditsInCandidate.missing` with `reason: 'uncommitted'` is NOT evidence about YOUR
committed change on this shared tree.** `release:checkpoint-run { paths }` compares the
**working tree**, and every agent's edits sit unstaged until the next git-sync tick — so any
peer's dirty edit in a file you name reports that file as `uncommitted`/missing even when your
own fix is committed and demonstrably inside the candidate. Observed 2026-08-02 07:47Z:
`sync-resolver/index.ts` came back `missing … reason: 'uncommitted'` while
`--is-ancestor` + a blob grep proved the fix was in the candidate — the dirty edit belonged to
a different agent working an unrelated resolver change in the same file. On a hot shared file
this reason is near-permanently true and says nothing about you. `absent` is the honest miss;
`uncommitted` is not.

⚠ **`reason: 'newer-commit'` is the SECOND face of that same bug — and unlike `uncommitted` it
fires on a fully-committed change.** Observed 2026-08-02 08:00Z (EI-19326775809436764): the check
appears to compare the path's *current* content (or its latest touching commit) rather than
asking whether the commit that INTRODUCED your edit is an ancestor of the candidate. So on any
file the fleet edits, a peer's commit landing after yours flips your file to `missing … reason:
'newer-commit'` and *stays* there — the tip is always newer than the quiet-cut candidate. Two
ways it actively misleads: `excludedCommitsTouchingYourFiles` names that **peer's** commit as
the one "carrying your file", and the warning prescribes *"wait out the quiet window (~4 min)
and re-fire"* — a fresh ~55min gate clock for a candidate that already contains your fix.
Measured: `sync-resolver/index.ts` came back `missing`/`newer-commit` citing a peer's unrelated
`readOutbox` change, while `git merge-base --is-ancestor 07d759d576 4a9b218b` said IN and a blob
grep counted the fix present. Three agents had built a re-fire plan on that verdict before it was
caught. **Neither reason code is evidence about your change — settle it with ancestry+blob above,
and treat every containment field (`marker`, `changeInCandidate`, `callerEditsInCandidate`) as a
hint that fails in the direction of arguing for a wasteful re-fire.**

⚠⚠ **A RUN'S JUDGED CANDIDATE CHANGES MID-RUN — "which sha is this run judging" has no single
stable answer, and every source below answers a slightly different question.** On a red that
re-tests clean at tip, `green-checkpoint.ts:2600-2621` calls `runGreenCheckpoint(..., { candidate:
tip, refireAttempts: +1 })` **recursively, inside the same process** (cap `autoRefireCapFromEnv()`,
currently 2). So the **pid and start time stay FIXED while the candidate ADVANCES** — and a run
that has been alive for an hour may be on its second candidate, having already discarded the red
you are still reasoning about.

This single unstated mechanism cost 5–6 agents ~2h and at least four public retractions on
2026-08-02, because it makes true observations look mutually contradictory:
`checkpointRunInFlight.candidate` advancing under an **identical `startedAtMs`** is not corruption —
it is the auto-refire's signature, and it was retracted as impossible. `ps` showing ONE process
since 07:15Z was simultaneously true and never contradicted it.

**The authoritative read of a LIVE run** is the marker the refire writes for exactly this purpose:

```sql
SELECT metadata->'gate_health'->'inFlightRetriage'   -- fromCandidate / refiringCandidate
  FROM harness_shared.routines                        -- refireAttempt / maxRefires / observedAtMs
 WHERE target_role = 'system:green-checkpoint'
   AND install_slug = '<harness>' AND workspace_id = '<workspace>';   -- multi-tenant, scope both
```

`null` means no refire is in flight (the run is still on its first candidate). Treat a marker older
than `IN_FLIGHT_RETRIAGE_MAX_AGE_MS` (3h) as an abandoned run, not a long one.

⚠ **The persisted log names a COMPLETED pass, never the live one.**
`~/.papercusp/checkpoint-logs/<ts>-base-<sha>-cand-<sha>.log` is `writeFileSync`'d **once, at each
pass's END** — its first line is literally `candidate=… base=… written=<ISO> green=<bool>`, and the
filename timestamp is the WRITE time, not the run's start. Observed 2026-08-02: a log named
`…-cand-1ee32228e0cf.log` carried `written=07:38:58Z green=false` and a terminal
`AFFECTED_TESTS_RESULT status=failed` tail while its process was still alive 25 min later, having
already re-fired onto a newer tip. Reading it as the in-flight candidate is a guaranteed
one-pass-stale answer.

⚠⚠ **`green=` in that header is the SUITE's verdict and says NOTHING about whether the candidate
PROMOTED — the `GATE_PROMOTION` trailer at EOF is what answers that.** The header is written by the
suite dep at suite-end, while EVERY promotion decision (the four held gates, the fast-forward, a
longest-green-prefix salvage, an in-process refire that abandons the candidate) is taken
*afterwards*, by `runGreenCheckpoint` — so the header physically cannot carry the outcome, and a
`head -1` showing `green=true` was routinely read as "this became the pin".

```bash
grep -o 'GATE_PROMOTION candidate=.*' <log> | tail -1
# GATE_PROMOTION candidate=33cd2bfebec8 green=true promoted=false reason=perf-held
```

⚠ The ` candidate=` anchor is prophylactic here, not a fix for an observed break — no test name
embeds `GATE_PROMOTION` today (measured 2026-08-10). Keep it anyway: this marker is the one whose
**absence** carries the most meaning (see the next paragraph), and absence is precisely what a
future impostor line would erase. The two markers that ARE currently defeated this way are
`GATE_HELD_BY` and `AFFECTED_TESTS_RESULT` — WI-37636.

Two readings that are easy to get wrong. **ABSENCE IS MEANINGFUL:** no `GATE_PROMOTION` line means
the run never reached a promotion decision at all — killed, crashed, or still in flight — a third
state the header alone could not express (and the reason this is a trailer rather than a rewritten
header, which would have converted that state into a confident wrong answer). **And `promoted` is
the ACTUAL fast-forward, not a restatement of `reason`:** `reason=advanced promoted=false` is a real
state — `advance()` is FF-only and declined — that used to be entirely invisible.

Why it exists (EI-20014356905761236): 2026-08-09 ~21:53Z, one question about candidate
`33cd2bfebec8` drew three different answers from three authoritative surfaces — this log said
`green=true`, `release:deploy` said `skipped-locked`, and gate_health's `observedCandidate` still
named an older red. Six tool calls to reconcile, and `main` had not moved. The missing datum was
never the VERDICT; it was whether the verdict COUNTED.

⚠ A log written BEFORE this lands has neither the trailer nor the header's
`promoted=see-GATE_PROMOTION` pointer — its bare `green=<bool>` header is the older shape above, so
absence of a trailer on an old log means "pre-dates the fix", not "never reached a decision". Check
the header for the pointer before reading absence as a signal.

⚠ **`AFFECTED_TESTS_RESULT failed=N` counts TASKS (workspaces), not FILES — never derive your work
list from it.** It names how many workspace test-tasks went red (`@papercusp/operator-core :: test`),
so ONE task routinely hides a dozen files. Measured three times in one night: `failed=2` vs 3 distinct
files, `failed=3` vs 4, and `failed=2` vs **11**.

✅ **The run now states its own per-FILE break set — read that line instead of mining prose:**

```bash
grep -o 'AFFECTED_TESTS_FAILING_FILES run=.*' <log> | tail -1   # keep ` run=` — see the impostor warning below
# AFFECTED_TESTS_FAILING_FILES run=<pid>-<nonce> coverage=complete fileCount=11 \
#   unattributedCount=0 truncated=false transformCulpritCount=0 \
#   files=[{"workspace":"…","file":"…"}] unattributed=[] transformCulprits=[]
```

Read **`coverage`** before `files`, because an empty list is ambiguous in the expensive direction
(EI-19395701908500754). `complete` = every failed task was attributed. `partial` / `unattributed` =
some (or all) failed tasks could NOT be named down to a file — a TTY run with no captured child
output, a worker crash/OOM that printed no FAIL rows, or a non-vitest task like cargo — and each
such task is listed with its reason. **`files=[]` never means "nothing failed"** unless
`coverage=none`. `run=` is the same token as the `Full run log:` path, which is how you tell this
run's break set from a fixture line in an interleaved verdict log.

⚠⚠ **`coverage` does NOT tell you the listed files are BROKEN — read `transformCulpritCount` too,
and on a nonzero one treat the whole file list as CASUALTIES until proven otherwise.** The two
questions come apart completely on a parse failure: an unparseable module reds every test file that
transitively imports it, so all of them get real FAIL rows, all of them attribute cleanly, and the
run stamps the most confident label it has — `coverage=complete` — over a list of innocent files.
`coverage` only ever answered "were the failed TASKS attributed", never "are these files at fault",
and this passage used to send you straight from `complete` to the list with nothing in between.

Measured 2026-08-09 (WI-37607): run `465313-5f9da4f2` reported `coverage=complete fileCount=21
unattributedCount=0` from ONE peer mid-write on
`packages/operator-core/lib/sync/hyperbee/log-snapshot.ts:592`; the file was clean minutes later and
a 3-file re-run passed 69/69. The same shape had already reached the GATE — run `3993890-864b7768`
from the `papercusp-checkpoint` checkout: 7 files, `coverage=complete`, one parse error in
`lib/memory/corpus-recall-io.ts:58`. Nothing in either output said the files shared one cause.

The runner now leads its summary with a `⚠⚠ PARSE (transform) FAILURE DETECTED — cause=transform`
block naming the culprit module, and carries `transformCulpritCount` / `transformCulprits` on the
machine line. `transformCulpritCount=0` is the ordinary case. Note there is deliberately **no
`cause=` field on the machine line**: that a parse failure was PRESENT is provable, that it caused
every listed file is not, and a confident cause taxonomy is the same overstatement being fixed.
On this shared tree the usual source is a peer mid-edit — re-run in a minute and check the
culprit's `git status` before investigating anything in the list. Triaging an OLDER log with no
`transformCulpritCount` field at all? It predates this fix: grep it for `Transform failed with`
yourself before trusting its break set.

⚠⚠ **That line covers TEST FILES only — a red can be held by a post-suite LINT/TYPECHECK/BUILD leg
instead, and then it is EMPTY while the gate is legitimately red.** Read `GATE_HELD_BY` for the
gate's own answer to "what held it", which covers legs AND files:

```bash
grep -o 'GATE_HELD_BY count=.*' <log> | tail -1
# GATE_HELD_BY count=1 truncated=false entries=["lint:no-control-bytes"]
```

It is emitted from the SAME list the gate decided red on (`failingTests`, which folds in every
leg's `failingSignatures`), so it cannot drift from the verdict. **`count=` is legs + files
combined — not a file count** (the `failed=N` misread above, one level up).

⚠⚠ **Keep the ` count=` in that grep — a bare `grep -o 'GATE_HELD_BY.*'` returns a vitest TEST
NAME, and it fails in the direction that reads like an answer.** `green-checkpoint.test.ts:4919` is
named `renders one greppable line, in the house GATE_HELD_BY / AFFECTED_TESTS_RESULT shape`, so the
reporter echoes both markers into the very log you are grepping, whenever that suite is selected —
i.e. exactly when the gate is judging the release path, which is exactly when you are triaging.
Measured 2026-08-10 on `…-cand-a68d051e8fd8.log`: the bare recipe returned
`GATE_HELD_BY / AFFECTED_TESTS_RESULT shape<ESC>[32m 28ms` and **all 6 matches were impostors —
zero real machine lines existed.** That log was a legitimately GREEN run, where absence of
`GATE_HELD_BY` is the *meaningful* signal (nothing held it); the impostor converts that absence into
a non-empty, plausible-looking result. **Anchor every one of these greps on the `key=value` field a
real machine line always continues with** — `GATE_HELD_BY count=`, `AFFECTED_TESTS_RESULT status=`,
`AFFECTED_TESTS_FAILING_FILES run=`, `GATE_PROMOTION candidate=`, `TEST_FILE_RESULT requested=` —
never the bare marker. ⚠ Anchor on the SHAPE, not one spelling: the emitters legitimately vary
their first field (`GATE_HELD_BY entries=`, `AFFECTED_TESTS_RESULT failed=`), so *any* `key=`
works and pinning one specific key both flags correct recipes and sends you grepping a string no
log contains — the mistake this rule's own first draft made about `TEST_FILE_RESULT`. Same class
as the `[green-checkpoint]` suite-capture impersonation (WI-37605), but via the test NAME, so a fix
aimed at log prefixes does not cover it. Tracked as WI-37636 (4 files, ~10 such names, including two
`does NOT print the TEST_FILE_RESULT` tests whose names emit a match for the marker whose ABSENCE
they assert).

Why this exists: candidate `dca4c291` (verdict 2026-08-03T17:27:30Z, part of the 6-red streak that
held `main` at `5b898b7b` for ~4h) carried `AFFECTED_TESTS_RESULT status=passed tasks=58 failed=0`,
**no** `AFFECTED_TESTS_FAILING_FILES` line at all, and **no** `FAILED (npm run …)` line — a genuine
red whose cause appeared in neither place a triager looks. The real cause (`lint:no-control-bytes`)
occurred twice in 12,562 lines, both inside the leg's own output block, because 3 of the 12 leg
banners omitted the word FAILED that the other 9 use. Banners are now conformed and ratcheted
(`green-checkpoint-leg-banner-shape.test.ts`), but **`GATE_HELD_BY` is the line to read** — banner
text is prose, this is the verdict's own data. (WI-9613)

⚠ A verdict log written before this landed has no `GATE_HELD_BY` line; for those, grep
`FAILED (npm run` **and** check the three legacy-worded legs by name (`lint:no-control-bytes`,
`lint:guard-reachability`, `lint:mock-cast-escape`) before concluding a red has no lint leg.

⚠ **A verdict log older than 2026-08-03 has no such line — and the fallback recipe this file used
to give was itself a phantom-path generator.** `grep -oE 'FAIL +[^ ]+\.test\.ts'` does not merely
skip a `.tsx` suite: `\.test\.ts` matches the PREFIX of `…PreviewPanel.test.tsx`, so `-o` prints the
truncated `app/adv/create/PreviewPanel.test.ts` — **a file that does not exist**. Measured on the
060ea000f206 log: 11 paths out, one of them fabricated, and the real
`app/adv/create/PreviewPanel.test.tsx` absent. A reader then goes looking for a file that isn't
there and doubts their tooling rather than the recipe — the same symptom as mining fixture prose,
from a different cause. (The production parser, `scripts/lib/vitest-summary.mjs`'s
`VITEST_TEST_FILE_SOURCE`, always had the right shape; only this doc's hand-rolled copy was wrong.)
Match the full extension set, and both row shapes — vitest prints `FAIL` rows for only the first few
failures but emits a `❯` rollup row for every failing file:

```bash
sed 's/\x1b\[[0-9;]*m//g' <log> \
  | grep -oE '(FAIL +|❯ +)[^ ]+\.(test|spec)\.[cm]?[jt]sx?' \
  | sed -E 's/^(FAIL|❯) +//' | sort -u
```

⚠⚠ **Do NOT mine the gate's own prose for failing files** — `[green-checkpoint] isolation:
re-running <files>` and friends are emitted by green-checkpoint's SELF-TESTS too (they drive the
real `runGreen`), so a `grep 'isolation:'` on a verdict log returns FIXTURE paths. Measured on the
01:36:17Z red: it yielded `lib/a.test.ts` / `lib/b.test.ts`, neither of which exists in this tree,
while the real set was 11 real files across two workspaces. Since WI-7274 those fixture lines carry
`[green-checkpoint:TEST-FIXTURE]` instead of `[green-checkpoint]`, so an untagged log predates the
fix and every one of its `[green-checkpoint]` lines is suspect.

⚠ **`skipped-locked` is a DESIGNED DEFERRAL, not a lost tick — never read it as "this cycle
produced no verdict" or as gate throughput loss.** It means the scheduled tick fired, found the
singleton run-lock held by another gate run, and returned without judging — because *that* run is
producing the verdict and records it itself. The writer says so explicitly
(`packages/operator-core/lib/harness/routines/release-actions.ts:414-415`): *"false when it is **not
a verdict at all** (a `skipped-*` outcome — the run that HOLDS the lock is producing the real one and
records it itself)"*. Corroborated at :420 (`isRecordableVerdict` rejects `skipped-*`), :755
(`classify` → `'noop'`), and :834-836 (deliberately excluded from the stall counter). The row exists
purely as history for the /admin Git tab.

Measured over a 36h window (2026-08-09): **8 of 8** completed skips were followed by a real verdict
from the lock-holding run within 11–54 min — one of them naming the *same candidate* — and the 6
that could not be paired to a `/tmp` manual log each had a verdict land 29–55 min later. **Zero
verdicts were lost.** A fleet of agents firing manual `release:checkpoint-run` to green their own
changes is the *documented normal cause* of these rows (`release-actions.ts:400-409`, from the
2026-07-16/17 stall), and the consequence that actually mattered — a manual run not dispatching a
release-fixer — was already fixed by EI-13723.

The error this exists to prevent is filing it as a defect: a `GROUP BY status` over
`pipeline_events` makes `skipped-locked` look like a 29% throughput hole, which invites building a
"defer-and-retry" mechanism for a non-problem. That happened (EI-20019097046659920, filed major,
retracted and dropped the same hour, after its framing had already been propagated into a *critical*
sibling item). The tell was there and was ignored: a suspiciously clean percentage on a small
denominator, describing a system that would have had to be silently broken for months without
anyone noticing. **When a finding implies a long-standing system has been broken all along and
nobody spotted it, the prior is that you are misreading it** — read the writer before you file.

⚠⚠ **The verdict's `📍 lineage: … none of the failing files were modified in that range
(presumptively a real red)` line is UNRELIABLE — never let it talk you out of re-checking at HEAD.**
It asks whether the failing TEST file moved. For every test that polices OTHER files — the
prompt-weight budget, the NUL/source-integrity lints, the claim-door census, `tools-md-sync` — the
fix lands in the policed SOURCE file and the test itself is never touched, so the answer is
structurally always "no" and the line always reads "real red". It therefore prints its highest
confidence exactly where the red is most likely already dead, and the reflex it induces (go fix the
named thing) is the one that collides with peers' locks and burns a ~55min suite.

Measured 2026-08-03 on candidate `060ea000f2`: it printed that phrase while `loop:checkpoint`'s prompt
weight had already been trimmed 1589 → 1495 by `eb872e9ea8`, and `git log 060ea000f2..HEAD` on both
budget test files was **empty**. All 11 of that red's files were already green at HEAD — 7 verified by
running them. **That is the base rate, not a fluke:** on this fleet the tree outruns the gate, so treat
every red as STALE until you have RUN each failing file at HEAD (`npm run test:file -- <paths>`). A
status derived from the log — yours or a peer's — is not a status at HEAD. (EI-19394456914198611)

✅ **The wording is FIXED IN TREE as of 2026-08-03 (EI-19390159514676981) — but the run-it-at-HEAD rule
above stands unchanged, and the fix is NOT yet deployed**, so a live verdict can still emit the old
sentence until the next green+deploy. The presumption now requires the RANGE to be empty rather than
merely to exclude the failing test files, so you will start seeing a fourth outcome:

| the verdict says | it means |
|---|---|
| `N of the failing file(s) were MODIFIED in that range (presumptively STALE)` | a failing test file itself moved — re-verify at tip |
| `… submodule(s) moved … could not be diffed (skew UNDETERMINED)` | part of the range was unreadable |
| `none of the failing TEST files changed, but N other file(s) did … skew UNDETERMINED` | **NEW** — the absence-ratchet case: a budget/lint/census test is fixed in the file it POLICES, so this is the expected shape of an already-fixed red |
| `nothing at all changed in that range (a real red)` | the ONLY case that earns the real-red presumption — the range is empty, so nothing downstream could have fixed it |

An UNMEASURED range degrades to UNDETERMINED and is never upgraded to confidence. The two new
`GateLineage` fields (`rangeFilesChanged`, `failingPathsConsidered`) also persist into the durable
pipeline-event record, so `/admin/git` and `gate_health` stop replaying the old false confidence.

⚠ **Do not glob `/tmp/papercup-green-checkpoint-manual-*.log` and take the newest.** Tests write
synthetic placeholder shas into that same namespace, and `ls -t` routinely returns the TEST file
first (EI-19326961954611487). Observed 2026-08-02: the newest match was `…-manual-ryte5.log`,
containing only `was judging 11111111 … superseded by 222222222222` — which reads as a real
replaceStale displacement and is not. Real run logs are `…-manual-<unit>-<ISO>.log`, so match
**`/tmp/papercup-green-checkpoint-manual-*T*Z.log`** and ignore any line whose sha is not 40-hex.

🚨 **Never fire a manual `release:checkpoint-run` while a run is in its re-triage window.** That
window is where a STALE red gets voided and the gate re-fires itself onto a newer tip;
`green-checkpoint.ts:2566` states plainly that killing it "discards the rescue and costs a full
suite". A gate that looks stuck on a doomed candidate is very often seconds from rescuing itself —
check `inFlightRetriage` **before** concluding a re-fire is needed. Two agents were minutes from
firing one on 2026-08-02 while the automatic refire was already green on the affected suite.

✅ **You no longer have to remember to check — the verb itself now refuses with the answer.** `release:checkpoint-run`'s `already_running` reply reads the marker and, when a refire is in flight for THAT run, leads its `note` with `🚨 AUTO-REFIRE IN FLIGHT — STAND DOWN`, names both candidates (the one being judged **and** the one already discarded), lists the files the abandoned red named so you don't go fix them, and reports the budget via `in_flight_retriage.budget`/`at_cap`. Its containment check switches to the marker's candidate too, so `callerEditsInCandidate` answers about the sha actually being judged rather than the checkout HEAD inference. A marker written BEFORE that run started is deliberately NOT attributed to it (the run-lock is a singleton, so it belongs to an earlier run) and the pre-existing refusal is returned unchanged — `in_flight_retriage: null` means "no refire in flight", never "unknown".Shipped as EI-19343516395023183 and **LIVE** as of the 2026-08-03 02:30Z deploy (release `13d9c65db69c`, verified present in the running release checkout — it was staged-but-undeployed for the preceding 12-red streak).

⚠ And when it does re-fire: **a passing affected-tests suite is NOT a green gate.** The lint/perf/
desktop/delta gates and the `main` fast-forward still have to clear; an agent asserted "gate green"
off the suite result that same morning and had to retract it.

🚨🚨 **Never answer "is a gate run in flight" with a `pgrep`/`ps` process-table probe — not even a
bracketed one, not even `proc-guard.mjs`.** The self-match fix documented above (bracketing, or
`proc-guard`'s ancestor-chain exclusion) only protects against matching **your own** shell — it does
nothing for the failure that actually bites here: matching a **PEER agent's** diagnostic shell.
Anything specific enough to identify a gate run — a candidate sha, the literal string
`green-checkpoint`, a failing test path — is exactly what other agents type into `git show`, `grep`,
or `npx tsc … | grep` **while investigating that same incident**, so `pgrep -f 'release/green-checkpoint'`
or `pgrep -af <candidate-sha>` matches their argv, not a real gate process. Measured 2026-08-03
09:06Z: `pgrep -c -f 'release/green-checkpoint'` reported **3**; all three were peers' unrelated
`bash -c` wrappers (one running `npx tsc` and grepping its output for that same path-string); the
real count was 0. The same probe had correctly reported 3 REAL gate processes 24 minutes earlier in
the same session — it is not simply broken, it silently degrades from correct to false-positive
exactly as peers start typing the incident's identifying strings into their own shells, which is
precisely when several agents converge on one red gate. The failure is bidirectional and both
directions are expensive: a phantom "in flight" wrongly counsels waiting/standing down; a phantom
"nothing in flight" wrongly counsels firing a manual `release:checkpoint-run` that discards a live
rescue (see above) and costs a ~55min suite. It also resists noticing — the probe returns plausible
rows (real processes, genuinely matching strings), never an obviously-empty or obviously-broken
result. **Ask the run's own bookkeeping instead, never the kernel's process table:**
`release:checkpoint-run`'s `already_running` refusal (self-checking, see above); `dev:pipeline_position`
→ `gate.checkpointRunInFlight` (`active`/`candidate`/`startedAtMs`/`elapsedSec`); or the
`inFlightRetriage` marker in `harness_shared.routines` directly (query at the top of the section
above). (EI-19422230833209442, EI-19422359235363577)

⚠⚠ **`systemctl --user is-active papercup-green-checkpoint-manual-1fxzuva` does NOT tell you that
YOUR run is alive — that unit name is a FIXED string reused by every fire** (EI-13624, EI-6544). A
peer's freshly-launched run therefore wears the byte-identical unit name, and `is-active` answers
`active` *truthfully, about a different run*. This fails in the direction that wastes the most time:
you keep waiting on a verdict that already landed, so nothing looks wrong — there is no error, just
a true answer to a question you did not ask. **Compare `ExecMainPID` against the pid your own launch
reported; it is the only field that separates one fire from the next:**

```bash
systemctl --user show papercup-green-checkpoint-manual-1fxzuva.service -p ActiveState -p ExecMainPID
```

Measured 2026-08-10T00:35Z: `ActiveState=active` with `ExecMainPID=3347263`, while the run that
agent had launched was pid `953011` and had already recorded `green:false reason:not-green` **an
hour earlier**. Its own carried note read *"my run is in flight — re-check with `is-active`"*, a
check that stayed true, about the wrong subject, for the whole hour. The `/tmp` log has the same
defect: the `…-manual-1fxzuva.log` symlink is re-pointed on each fire, so it follows the newest run
rather than yours — read the timestamped filename, or better, the verdict's own
`~/.papercusp/checkpoint-logs/<ts>-base-<sha>-cand-<sha>.log`, which names its candidate.

⚠ **Read the pid comparison ASYMMETRICALLY — it is conclusive in only one direction.** A pid that
DIFFERS from your launch's is proof the active run is **not yours**; act on that. A pid that MATCHES
is *not* proof that it is, because pids are recycled too — PID wrap happens ~daily on this box under
fleet load, which is the same reason `processes:kill` refuses to target a bare pid and takes a
`taskId` instead. For a positive identification anchor to the run's own bookkeeping, which is unique
per run: the **candidate sha** it reports, the `inFlightRetriage` marker, or the verdict log's
`…-cand-<sha>.log` filename. In practice the negative is the one you need — it is what tells you to
stop waiting.

This is the same class as the `pgrep` trap above and as reading `skipped-locked` as a lost tick:
**a NAME the system legitimately recycles is not an IDENTITY** — and note that the fix for one
recycled identifier (the unit name) reached for another recycled identifier (the pid), which is how
this family survives being documented. When writing a note-to-self or a carried check, ask whether
its identifier could be reused by something that is not your subject; if it can, the check is a trap
for whoever reads it next, and that is usually you.

## Gate failure triage — re-run named files individually

`GATE_HELD_BY` / `AFFECTED_TESTS_FAILING_FILES` are a list of candidates, not proof that every
named file is failing at the current HEAD. Re-verify each path in its own invocation (for
example, `npm run test:file -- <one-path>`; with `testing:run`, submit one file per call).
A multi-file Vitest invocation can abort during collection when one file's mock or module graph
crashes, so its result must not be attributed to every requested path.

If a batch emits `TEST_FILE_ROUTE_ERROR` or `matched=0`, treat the result as **undetermined**:
zero files were measured. Re-run the paths individually and attribute red/green/fixed status
only from those per-file results. Never use a batch `matched=0` as evidence that the named files
are red, green, or fixed.

⛔ **A PASS at tip is NOT proof the verdict was stale** — the one containment trap that runs the
*other* direction. `test:file` runs the WORKING TREE, so a peer's uncommitted fix is silently in
your run: the file passes, you record "stale", and the gate keeps failing on the COMMITTED blob it
judged. The router stamps this for you — read its `TEST_FILE_PROVENANCE … uncommitted=N` banner and
the per-path `[DIRTY …]` / `[UNTRACKED …]` labels — and compare any non-clean path against the
judged candidate before calling it stale. ⚠ For a SUBMODULE path do that **inside** the submodule
(`git -C <sub> show <pin>:<repo-relative path>`): from the superproject `git status`/`git show`
answer about the gitlink and report nothing, so the one check that catches this returns empty.

⛔ **The converse holds too: a FAIL in the shared tree is NOT proof the leg is really red.** Some
suites assert over the LIVE WORKING TREE itself (`REAL TREE …`, shrink-only-baseline guards) while
dozens of agents mutate it and the gate judges an isolated clean checkout — the populations differ
by construction (EI-23817115274707255: ~26 failures across 18 unrelated files on the `lane-stateful`
leg). Read the gate run's OWN result (`state:read { cell:'gate.greenCheckpoint.candidateFailures' }`,
or `testing:runs { status:["fail","error"] }` `outputTail`) and never loosen such a guard. Tells it is
not substantive: process-level termination (SIGKILL/SIGTERM, per-file durations pinned at one
constant) and ZERO `Test timed out` strings. Before reproducing a HEAVY leg run
`node scripts/proc-guard.mjs check green-checkpoint` — a repro beside the gate's own run can cause
that signature. Leg-specific: `lint:tsc` reproduces faithfully.


## Server-side edits and the two-port model — no hot-reload

The Hono host (`bin/hono-host.ts`, MCP tools, `lib/endpoint-route`,
`apps/operator/lib/**`) has **no file-watch**, and on the dev box a `:3070`
restart does **NOT** pick up your edits:

- **`:3070`** = GREEN operator, runs from the **release checkout**
  (`papercup-release`, `main`). Your staging edits reach it only via the
  auto-serve pipeline (or a manual
  `PAPERCUSP_ALLOW_DEV_RESTART=1 npx tsx apps/operator/lib/release/deploy-cli.ts --execute`
  — the env flag is required for the restart; see the force-deploy note above).
- **`:3170`** = staging operator, runs from the integration tree. To test a
  server-side edit live: **`dev:restart { target: 'staging', confirm: true }`**,
  then probe `:3170`. **Never** shell out to a raw
  `systemctl --user restart papercup-staging-api.service` — on this
  heavily-parallel fleet that was firing every ~5-6min for hours with zero
  coordination (WI-4221): every agent's own "test my edit" restart was a real
  outage AND the trigger that made EI-9748 (headless children reaped by the
  service's cgroup on every restart) fire constantly. The tool drains
  concurrent `:3170` users first, and — for `target: 'staging'` specifically —
  **coalesces**: a restart requested within ~2min of a peer's real restart is
  skipped (reported `coalesced: true`) instead of firing a redundant one, so
  probe directly if you get that back.
- The Tauri dev shell spawns its own operator from the integration tree.

(`:3055` Vite *does* hot-reload.) Probe where the write actually lands; if it's
stale, restart the *right* host and re-probe. Detail:
[repo-conventions § two-port model](/internal/docs/system/repo-conventions).

⚠ **The MCP client URL does not prove which build served a call.** The `papercusp-su`
client connects through `http://127.0.0.1:9071/api/mcp`; the proxy's default upstream
is `:3070`, but the serving host is recorded separately for each tool invocation.
Records have shown the same owner served by both `port-3070` and `port-3170`. For a
specific call, use `dev:pg_query` to query `harness_shared.tool_invocations` by
`coord_owner_id`, `tool_name`, and `invoked_at`; read `serving_host` and
`serving_build_sha`. The writer captures the service and loaded build at invocation
time (`packages/operator-core/lib/projected-tool-deps.ts`), unlike the proxy URL or
current checkout. Compare that SHA with `/api/health` on the recorded host before
treating a route-level result as current.

Confirm which build an endpoint runs from its **health sha** — never a proxy's cwd or
boot time, which describe the proxy, not the code it forwards to:
`for p in 9071 3070 3170; do curl -s 127.0.0.1:$p/api/health; done`

⚠ **`:3170` is not the canonical working tree.** The staging operator serves the
separate `papercusp-staging` checkout pinned to `origin/staging`, so an uncommitted
edit — or a commit that git-sync has not pushed yet — is invisible there; restarting
`:3170` cannot make an unpublished edit appear. Use focused tests or a current-build
instance for unpublished work. After git-sync publishes the candidate, reload the
staging operator with `dev:restart { target: 'staging', confirm: true, authorize: true,
reason: 'reload staging after origin/staging advanced' }`, then compare `/api/health`
with the intended `origin/staging` build before exercising the real MCP surface:
`POST http://127.0.0.1:3170/api/mcp?superuser=1&client=$PAPERCUSP_SID&workspace=…`.
Run the identical sequence against `:3070` for an A/B whose only variable is the
build. Worked example:
[the :3170-vs-:3070 A/B](/internal/docs/agent-insights/connection-closed-6432-is-an-idle-tx-kill-not-pgbouncer).
⚠ Never bind a long-lived session's MCP to `:3170` — it restarts ~200×/day.


## Before you design or test — read the docs first

Two `/internal/docs` sections are **required reading before the corresponding
work**, not optional references. Check them *first*, then act:

- **Before ANY design work** — new or changed UI, an API/schema shape, an
  architecture, or a new durable surface (component, tool, table, service) —
  read the **design docs** at [`/internal/docs/design`](/internal/docs/design)
  and check the `design-phase:*` tools (the DTCG token set + component registry)
  for what already exists. Don't hand-roll a design without checking the system
  first.
- **Before ANY testing work** — writing, adding, or changing tests, or verifying
  behavior — read the **testing docs** at
  [`/internal/docs/testing`](/internal/docs/testing) (+
  [`/internal/docs/testing/agent-e2e`](/internal/docs/testing/agent-e2e) for UI).
  They say which of the four canonical frameworks to use and how (see also
  "Where new tests go" below).

## Read this before changing code — performance anti-patterns

Performance regressions here repeatedly come from the same small set of patterns
(serial fs loops, per-slug PG-pool opens, `<details>` gating, duplicate React
keys, stale Radix pointer-events overrides, …). **Read
`/internal/docs/performance` before any non-trivial change** — especially the
"What NOT to do" sections (A1–A14). If your change matches an anti-pattern,
change the approach first.

## Storage policy: Postgres by default

**New durable state goes in Postgres unless there is a specific reason it must
be a file.** No plain-JSON state files, no module-scoped TTL `Map`s, no "PG
mirror with file primary". Helpers: `packages/operator-core/lib/operator-state-pg.ts`.

- **Schema = migrations only; NO runtime DDL.** ⚠ **Pick the migration number via the atomic allocator — NEVER `ls sql/ | tail` by eye.** On this parallel fleet two agents racing an `ls`-then-write gap WILL pick the same NNN. Run `node scripts/next-migration.mjs --name <slug> --intent "..."` (or `npm run db:next-migration --`) FIRST — it reserves the number under an advisory lock (`harness_shared.migration_reservations`) and prints a `.DRAFT`-suffixed path.

  **Write and iterate at that `.DRAFT` path, not the bare `.sql` name**: the runner only applies files matching `*.sql`, so a `.DRAFT` file is invisible to boot auto-apply / `db:migrate` / the green-checkpoint preflight while you edit it — including a deliberate temporary both-ways guard-test mutation, which otherwise races the operator's auto-apply and can execute half-finished SQL against the live DB. When it is finished and tested, ARM it with the printed `arm_command` (`mv <path>.DRAFT <path>`) at `libs/papercusp/libs/db/sql/<NNN>-…sql` (≥107), then run `node libs/papercusp/libs/db/scripts/pull-schema.mjs`. Never an `ensureXxx()` / inline `CREATE TABLE`. `000-baseline.sql` is frozen/generated.
- **Never hardcode `localhost:5432`** — resolve via `getHarnessAdminUrl()`. Embedded-pg is the ship target; the dev box runs native PG on `:5432`.
- **Reading PG-canonical state? Query PG — don't dump-and-jq a projection.** Plans, work-items, issues, observations (`engineer_issues`), `tool_invocations`, scorecards and recipes live in Postgres; the `*:list` tools and `docs/plans/*.md` files are *projections*. `dev:pg_query` is for **genuinely ad-hoc / analytic** reads (a one-off group-by, join, or recency slice you won't repeat). A HOT read with a stable shape belongs behind a TOOL that wraps the canonical SQL so it can't drift — "what's claimable" is `work_items:claimable`, NOT a raw floor query.
The duplicate-number race is EI-6843 — it cost a rename plus every in-code reference plus a re-verify when caught. The `.DRAFT` mechanism is EI-19366138707071397.

**Before you write `SELECT`, check this table** — these are the reads agents most often hand-write, and each already has a tool that scopes + applies the real semantics. (`dev:pg_query` echoes the same routing as a `See also:` line on every result.)

| you want | use | not |
|---|---|---|
| how many tests fail on the **frozen candidate** | `state:read { cell:'gate.greenCheckpoint.candidateFailures' }` — read `stillBrokenCount` (files with NO fix yet), not `failingFileCount`; `fixInRepairHead` says whether a file's fix already landed | ANY hand-written `test_runs` query — it mixes THREE populations and only one judges the candidate; aggregating them reports fleet churn as the gate's verdict |
| what issue-family work is claimable now | `work_items:claimable { harness }` | `WHERE status='open'` / the `work_items_claimable` view (overcounts ~13×) |
| a filtered work-item / issue slice | `work_items:list` (server-side filters) | a hand-written `harness_shared.work_items` query |
| what plans exist / the recent ones | `plans:list { updatedSince, createdSince, order, limit }` — `order` is `'updated'\|'created'\|'slug'` (NOT `'recent'` — that is `invalid_input`) | a hand-written `harness_plans` query |
| plan COUNTS (by status / harness / day) | `plans:list { groupBy, aggregateOnly }` | a hand-written `GROUP BY` |
| pickable plan items across plans | `plans:items { actionable: true }` | unnesting the items jsonb |
| prose / full-text | exact phrase → `search:fulltext`; paraphrased concept → `search:semantic` | `ILIKE '%…%'` |
| definition, references, type truth | `lsp:query` (compiler semantics) | `grep` for a declaration — cannot resolve shadowing or re-exports |
| call chains, impact radius, topology | `gitnexus.context` / `gitnexus.impact` (dot, not colon) | `gitnexus.query` — UNRANKED NOISE, not empty: a wrong answer looks like a confident one (D-021) |
| who CALLS this symbol | `graph:query { op:'callers', name }` — returns call sites with `line1`, excludes the definition site, reports index staleness | `gitnexus.impact { direction:'callers' }` — `callers` is NOT a valid direction (only `upstream`/`downstream`/`both`) and the plugin SILENTLY answers with callees, self-reporting `epistemic:"exact"` |

⚠ **If `gate.greenCheckpoint.candidateFailures` is unavailable, the ONLY query that answers it is scoped to one population — and the blob check is half the answer:**

```sql
SELECT file_path, status FROM harness_shared.test_runs
 WHERE source='ci' AND worktree_dirty=false AND commit_sha='<the frozen candidate sha>'
   AND status IN ('fail','error');   -- 'failed'/'passed' can NEVER match
```

Then per path, `git rev-parse <candidate>:<path>` vs `git rev-parse <repairHead>:<path>`: **DIFFERENT blobs mean the fix ALREADY LANDED** and the file awaits re-verification, not repair. Equal blobs are the real queue. For a SUBMODULE path the blobs are identical while the gitlink moved — use `git diff --raw <candidate> <repairHead> -- <sub> | grep '^:160000'`. And `filesJudged` is the AFFECTED RADIUS, never the ~6,700-file suite: an empty failing list is **not** "the gate is green".

`testing:runs` has no root filter; its isolated-checkpoint row locator (rows only — never candidate failures) is in the corpus evidence part.
#### Why the `test_runs` routing row exists — the measured failure

`harness_shared.test_runs` mixes three populations and only one of them judges the frozen
candidate: full-suite rows carry `commit_sha=NULL`, and `worktree_dirty=true` rows measure a
working tree that ~100 agents are concurrently mutating. An agent aggregating all three
reported the gate as **"45 → 29 failing"** when the true number of files still broken on the
candidate was **1** — and that one already had its fix in the repair head. The report described
fleet churn, not the gate's verdict, and it read as a large and worsening problem rather than a
solved one. That is why the row prescribes the cell, and why the fallback SQL carries
`source='ci' AND worktree_dirty=false AND commit_sha='<candidate>'` as a single inseparable
predicate set.

The `status` literal is the second trap in the same query. The column's domain is
`pass | fail | skip | cancelled | error | running`, so a `WHERE status='failed'` predicate can
NEVER match and returns a clean-looking zero — an absence manufactured by the instrument, not
observed in the data.

#### Note on the observation-lane warning

An earlier revision of this part ended with an inline copy of the
`lane='observation'` population warning, which also ships as its own invariant part
(`storage-policy-postgres-by-d-a-hand-written-popul`) in the same section. The shipped guide
therefore carried the same rule twice, as two consecutive paragraphs. The inline copy was the
shorter and strictly weaker of the two — it lacked the four-weeks-earlier trend figure (417 of
472) and the "a remediation sized from the first number can be an order of magnitude too large"
consequence — so it was removed and the standalone part kept. Nothing was lost; the duplication
was.

#### Measured figures behind the observation-lane warning

The standalone invariant part states the rule; its measured support lives here. A `lane='observation'` row is correctly never claimable and never triaged, and correctly carries no assignee and no plan link — its absence from those columns is not a defect. Measured 2026-09-01: of open items whose title matches `P-[0-9]{3}`, 2,194 of 2,340 were observations; four weeks earlier the same query was 417 of 472 — the gap was widening fast. The same title/prose regex cannot distinguish an item that EXECUTES a reference from one that merely CITES it: observations cite constantly ("…defeats P-006", "another agent owns P-018", "do not claim P-008").

#### `testing:runs` root locator (relocated from the routing part, WI-10004675)

`testing:runs` returns a parser-validated `root` from `execution_details` but has no root filter. To LOCATE rows recorded under an isolated checkpoint tree, use the exact non-null root it returned and the frozen candidate SHA in a separate **diagnostic locator only**:

```sql
SELECT id, file_path, status, source, worktree_dirty, commit_sha, run_group_id
  FROM harness_shared.test_runs
 WHERE workspace_id='<workspace id from testing:runs>'
   AND harness_slug='<harness slug from testing:runs>'
   AND execution_details->>'root'='<exact checkpoint root from testing:runs>'
   AND commit_sha='<the frozen candidate sha>'
   AND source='local' AND worktree_dirty=true
   AND status IN ('fail','error')
 ORDER BY finished_at DESC NULLS LAST, started_at DESC;
```

If `root` is null, do not guess the checkout path or treat zero rows as absence. Add the exact `run_group_id` when known to narrow the query to one invocation. This is only a locator for rows and files: dirty `source='local'` rows do **NOT** prove those failures occurred on the frozen candidate and must never be counted as candidate failures. Use only `candidateFailures` or the clean `source='ci' AND worktree_dirty=false` population above for that verdict.


  Nothing in the table fits and the shape is genuinely one-off? Then **`dev:pg_query`**
  (read-only SELECT — read-only txn + `statement_timeout` + row cap) or a server-side
  `*:list` filter — never fetch a whole `*:list` and `jq`/python a spilled projection.
  If you find yourself writing the *same* query a second time, that is the signal it
  should be a tool (or an arg on one), not a snippet. (su can also `psql` the admin URL directly:
  `getHarnessAdminUrl()` / the live operator's `DATABASE_URL`.) ⚠ Multi-tenant
  tables (`harness_plans`, the `*_consolidated` tables, …) key on
  `(workspace_id, harness_slug, <slug/id>)` — a raw filter on just the slug/id
  can silently hit a different tenant's row and look like a stale/diverged
  store when it isn't:
  [raw SQL plan reads need workspace+harness scope](/internal/docs/agent-insights/raw-sql-plan-slug-needs-workspace-harness-scope).
  ⚠ A work-item's **severity** (issue-family only: bug/change/task) is reached
  **differently per relation**, and the wrong accessor returns NULL without
  erroring — a well-formed, plausible, WRONG answer. Bind the accessor to the
  relation (WI-6674):
  - **`harness_shared.work_items` (the TABLE)** has **no `severity` column** — it
    lives at **`payload->'_ei'->>'severity'`** (migration 374's fold). A raw
    top-level `payload ? 'severity'` / `payload->>'severity'` audit returns
    **zero rows**, reading exactly like "no criticals" when there are plenty.
    Measured 2026-08-01 and still true: 0 of 13,711 open rows via the top-level
    path vs 13,711 via the `_ei` path — **30 genuine criticals reported as none**.
  - **`harness_shared.engineer_issues` (the VIEW)** exposes **`severity` as a real
    column — read that column.** ⚠ This half INVERTED on 2026-09-02. The view used
    to subtract the blob (`payload - '_ei'`) after exploding it, so
    `payload->'_ei'->>'severity'` was NULL for every row; **migration 1096 stopped
    the subtraction**, so that path now *resolves and agrees* — on 166,941 of
    166,948 rows (measured 2026-09-02). Still prefer the column: the 7
    disagreements are rows with a NULL `payload`, where the column reports its
    `COALESCE(…, 'minor')` default and the nested path reports NULL. The column is
    right on every row; the nested path is right on *almost* every row, which is
    harder to catch, not safer.
  ⚠ `dev:pg_query`'s always-NULL advisory **no longer covers this view** — the entry
  was retired with 1096, because an advisory firing on a path that now resolves is
  itself the confidently-wrong answer it exists to prevent. It still fires for the
  `work_items` shapes it knows. Treat it as a backstop that *shrinks when a trap is
  fixed*, never as a licence to skip binding the accessor to the relation yourself.


  Prefer `work_items:list{severity}` / `work_items:claimable` over either raw path;
  the view scopes on `scope = 'harness:<slug>'`, not `harness_slug`:
  [work-item severity lives under payload._ei, not top-level](/internal/docs/agent-insights/work-item-severity-lives-under-payload-ei-not-top-level).
  ⚠ For CLAIMABLE issue-family work (bug/change/task), `status='open'` is **NOT**
  claimability — the real claim path applies ~12 unconditional floors, so a raw
  `WHERE status='open'` overcounts ~13×. Use the dedicated tool
  **`work_items:claimable { harness }`** — the authoritative count + rows + per-floor
  `excludedBreakdown`, wrapping the SAME oracle `scheduler:get_next` runs (so it can't
  diverge from what the queue actually serves). Do **not** hand-roll floors in SQL over
  `harness_shared.work_items` / the `work_items_claimable` view, and do **not** treat
  `work_items:list{admissibleOnly:true}` as the claimable verdict — `admissibleOnly` is
  only a cheap STRUCTURAL pre-filter (remote-origin + observation-lane), NOT the full claim
  floors. (`scheduler:get_next`'s own `excludedBreakdown` is the same oracle if you're
  already calling it.) For issue-family human-routing the signal is `payload.needsHuman`,
  NOT the feature-family `needs_human_review` column:
  [judging claimable work — status='open' is not claimability](/internal/docs/agent-insights/judging-claimable-work-not-status-open).
- ⚠ **Apply migrations via the runner (`db:migrate`)** — a raw `psql -f` runs
  DDL without recording it in `harness_shared.schema_migrations`, so every
  deploy re-runs it; a lock-contending re-run trips the deploy's 15s
  `lock_timeout` and rolls back (wedged all deploys ~1h on 2026-06-09). If you
  must `psql -f`, INSERT the schema_migrations row in the same transaction.

⚠ **A hand-written population query over `harness_shared.work_items` is mostly OBSERVATION LANE — the tools exclude it by default and raw SQL does not.** `work_items:list` / `:search` / `:claimable` all default `includeObservations:false`, because a `lane='observation'` row is an agent's turn-end reflection (never claimable, never triaged). Raw SQL has no such default, so `SELECT … FROM work_items WHERE <predicate>` answers about a different population than every tool you would compare it against. Add `AND lane IS DISTINCT FROM 'observation'` whenever you mean WORK, and say which population a count describes.

A title/prose regex compounds it — it cannot tell an item that EXECUTES a reference from one that merely CITES it.


Full guide (acceptable file uses, two-axes model, topology):
`/internal/docs/system/storage-policy` +
[repo-conventions § database topology](/internal/docs/system/repo-conventions).

## Code-describing metadata: derive, pin, or attest — never hand-maintain

## Code-describing metadata: derive, pin, or attest — never hand-maintain

**A value that DESCRIBES code — a path, a tool/event/flag/table name, an `exists`/`enabled`/`retired` boolean, a count, a list of emitters/call-sites — is a second copy of a truth the code owns, and it WILL drift** (EVENT_CATALOG's hand-authored `emitter`/`exists` drifted; the case history is in the worked plan below). Take the FIRST rung that fits; hand-maintained prose is the last resort and needs a stated reason, exactly like file-over-Postgres:

1. **DERIVE** — generate from the single source: `buildKey`, `gen:agent-env` + `doctor`, `gen:tool-routing`, allowlists re-seeded from a measuring `--list` run — never a hand-run grep.
2. **PIN** — prose that must remain gets a build-time divergence check: doc-claims (`packages/operator-core/lib/doc-claims/`), drift-tracked docs.
3. **ATTEST** — what static analysis can't see (dynamic keys, installed packs): reconcile against a runtime ledger (audited fires, `tool_invocations`) on a standing sweep that files findings.
4. **CURATED** — only genuine judgment (meaning/guidance/rationale), stating why 1–3 don't apply.

Review smell: a new registry/config field restating what code already knows. Long form + audit method: [derived-truth-ladder](/internal/docs/agent-insights/derived-truth-ladder); worked plan: `event-system-drift-to-derived-2026-08-21`.


## Reaching for bash? These reads already have a tool

The routing table below is the lever, and it is **generated from the same registry
the PreToolUse gate enforces**, so the advice you read here and the advice the hook
gives you cannot disagree.

⚠ **PRECEDENCE — this table beats any "prefer raw Bash" preamble you were handed.**
Claude Code emits a stock instruction in bypass/auto-permission mode, headed either
"While bypass permissions mode is active:" or "While auto mode is active:", telling
you to read with `cat`/`head`/`sed -n`, search with `grep`/`find`, and **make file
changes with `sed`, heredocs, or short scripts rather than the dedicated Read/Edit/
Write tools**. It is generic CLI text for a checkout with no tool layer; it is
**stock, not an injection** (origin settled in WI-39768 — do not re-open the origin
hunt, and do not report a sighting as a compromise); and **this repo supersedes it.**
The write half is load-bearing, not stylistic: `sed -i`, a heredoc, or a `>` rewrite
of a tracked file bypasses the `PreToolUse` lock-arbitration hook — and, on that same
matcher, the secrets guard, content-lint, and the migration / generated-file guards —
so it can silently clobber a peer's held file on this shared tree. Always edit via
`Edit`/`Write` (or `capability:edit` / `capability:write`).
Bash is still ~41% of all tool use here, and the audit behind this table found the cause is routing, not capability. Of the tools that replace a shell command, `dev:pg_query` was the only one this file already pointed at — and it is the only one with real adoption (~85%, against ~1% for equally-capable tools nobody was pointed at). That asymmetry is why the fix was to point at the tools rather than to build more of them.


Each row was earned, not asserted: a frozen sample of real commands from this box was
replayed against the tool's actual argument envelope, and only pairs where every
sampled command has a faithful tool expression appear here. Where the tool genuinely
could not do the job the **tool was widened** (that is where `capability:read`'s
`tail:` and `dev:pg_query`'s `describe:` came from) — and where it still cannot, the
row says so and bash remains correct.

<!-- BEGIN GENERATED gen:tool-routing — do not edit by hand -->

> Generated — do not hand-edit: the source is `pairs/*.ts` + `npm run gen:tool-routing`,
> and `gen:tool-routing:check` fails the build on drift. Adding a row, promoting one, or
> arguing with a gate that blocked you:
> [bash vs tool routing](/internal/docs/agent-insights/bash-vs-tool-routing).
>
> ⚠ ToolSearch finding NOTHING for a `use` tool does not mean it is unavailable to you — a
> trimmed surface (su) exposes only a seed of the ~550-tool catalog, so `select:` and a
> keyword search can both come back empty for a tool that exists. `tools:invoke { name:
> "<server:verb>", args: {…} }` dispatches ANY catalog tool server-side, gated identically
> to a direct call (verified for `testing:run`) — reach for that before falling back to the
> `not` column.

| you want | use | not |
|---|---|---|
| a line RANGE of one file | `capability:read { file_path, offset, limit }` | `sed -n 'N,Mp' FILE` (offset=N, limit=M-N+1) |
| the WHOLE of one file | `capability:read { file_path }` | `cat FILE` (a heredoc or redirect is a WRITE — not this) |
| the FIRST N lines of a file | `capability:read { file_path, limit: N }` | `head -n N FILE` (a `… \| head` pipe filter is not this) |
| the LAST N lines of a file (a build / gate log tail) | `capability:read { file_path, tail: N }` | `tail -n N FILE` (`tail -f` streaming has no tool form — keep using bash) |
| a one-off SELECT against the OPERATOR database | `dev:pg_query { sql }` (read-only txn + row cap + statement_timeout) | `psql -d papercusp -c "SELECT …"`. ⚠ ONLY the operator DB — a `$VAR`/other-database connection has NO tool form, so keep using psql for those rather than risk querying the WRONG database |
| a table's columns / indexes / constraints | `dev:pg_query { describe: "schema.table" }` (a `*` glob lists relations) | `psql -c "\d table"` (`\df`/`\dn`/`\du` are other object classes — no tool form) |
| whether a systemd unit is active / failed | `dev:service_health { units:["<unit>"], scope }` — unitStates[].{loadState,activeState,active,failed} for any unit, plus unitsUnknown[] for ones systemd does not know; services[].up / supervision[].healthy for registered units | `systemctl --user is-active <unit>` — note it prints `inactive` for a unit that does not exist, which the tool reports as unitsUnknown instead |
| whether a local dev service is answering | `dev:service_health` — for the probed set (incl. :3170 staging), when you need only up/down | `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:<port>/api/health` — still required for :8788 and other unprobed ports, and whenever you read the body |
| what is listening on a TCP port / which process owns it | `dev:listening_ports { port }` (or `{ pid }` for the reverse lookup) — structured rows with pid, command and ownerVisible | `ss -ltnp` / `lsof -nP -iTCP:<port> -sTCP:LISTEN` / `netstat -tlnp`. ⚠ LISTEN sockets only — an established-connection query (`ss -tn`, `netstat -an`) or one lsof call spanning several ports still needs bash |
| to read git state (status/log/diff/show/rev-parse/merge-base) | `capability:git { args: ["log","--oneline","-5"], cwd? }` — argv, no shell, gated as git | `git log --oneline -5` — bash is not WRONG here; the gain is argv-safety and git-scoped gating. Shell-substituted argv (`git -C "$D" …`) has no tool form. For "is my edit live", prefer `dev:pipeline_position { path }` |
| to run specific test files and see which tests failed | `testing:run { files: [...] }` — spawns the router directly, so it never waits for a pc-heavy admission ticket | `npm run test:file -- <paths> 2>&1 \| tail -60` — pc-heavy-wrapped, so under load it queues behind every heavy job (measured: 14+ min without starting, one attempt killed SIGTERM/143 with ZERO output, vs 1471ms via the tool). A log-file redirect is not this — the tool writes no artifact |
| to run test files without hand-picking a Vitest config | `testing:run { files: [...] }` | `npx vitest run <path>` (a root-level run can match zero files and still exit 0 — the router refuses that) |
| a service's log lines in a time window, filtered | `logs:read { unit, since, grep?, level?, limit? }` (filter pushed down to `journalctl --grep`; repeats collapsed) | `journalctl --user -u <unit> --since <w> \| grep <pat> \| tail -n` (a streaming `-f` follow, a boot/cursor selection, or `sudo` elevation has no tool form — keep using bash for those) |
| to typecheck a project and see the errors | `build:typecheck { project: "packages/operator-core" }` | `npx tsc --noEmit -p <project> 2>&1 \| grep …` (the tool refuses a run that checked ZERO files — `-p .` does that here, and a `grep` over its one-line error prints nothing, which reads as clean) |
| the current date/time | `host.now` — already in your coord:orient payload (ISO-8601 UTC). Call nothing. ⚠ SNAPSHOT of when orient ran: on a LATER turn, or for any age/duration, use `date -u`. ⚠ UTC while this box renders LOCAL (-04:00) — put the other side in UTC (`TZ=UTC stat`) or you invent a phantom 4h gap. | `date` / `date -u` / `date +%s`. ⚠ a `$(date …)` substitution INSIDE another command is string interpolation — keep using bash; so is `date -d @<epoch>` (a different instant) |
| the load average / how busy the box is | `host.load` + `host.cores` — already in your coord:orient payload. Call nothing | `uptime` (`uptime -p` / `-s` ask for BOOT TIME — a different question, still bash) |
| how many CPU cores this machine has | `host.cores` — already in your coord:orient payload. Call nothing | `nproc` / `nproc --all` |
| free memory / whether the box is out of RAM | `host.memFreePct` + `host.psiMemSome60` — already in your coord:orient payload. Call nothing | `free -h` / `free -g` |
| to find where a symbol is DEFINED | `lsp:query { op: "workspace_symbols", name: "X", file: "<grep root>" }`; body: `capability:read` | `grep -rn "export function X" <one project dir>` (repo-wide: add `--exclude-dir={node_modules,.vitest-tmp,dist,coverage} --exclude-dir=sidecar` — generated bundles/caches are not source evidence; exhaustive exact-text search remains grep's job) |
| to install dependencies in this shared tree | `npm run install:safe` (or `npm run install:safe -- ci` / `-- install --legacy-peer-deps`) — serializes concurrent agents behind an fs-mutex, then verifies every declared dep actually landed on disk | a bare `npm install` / `npm ci` — including a named-package add — because it rewrites `node_modules/.bin` under every other agent's in-flight test run. ⚠ NOT claimed: explicit `--prefix` scratch installs or `--dry-run` |
| one relation's columns and their types | `dev:pg_query { describe: "schema.table" }` (same tool — also returns indexes, constraints and column comments) | a hand-written `SELECT column_name, data_type FROM information_schema.columns WHERE table_schema='…' AND table_name='…'`. ⚠ A column SEARCH across relations (`column_name ILIKE '%x%'`) has no describe form — keep querying the catalog for that |
| to FIND a relation whose name you half-remember | `dev:pg_query { describe: "*fragment*" }` — glob matched case-insensitively against `schema.name`; `{ describe: "schema.*" }` lists one schema | a hand-written `SELECT table_name FROM information_schema.tables WHERE table_name ILIKE '%fragment%'`. ⚠ Names only, one glob per call — an explicit `table_name IN (…)` list, a `table_type` filter, or anything else the catalog holds still wants information_schema |
| whether migration NNN applied, or the most recent migrations | `db:migrations { like: "795" }` — a bare number is a prefix match; an empty match returns a verdict (pending / draft-not-armed / no-such-migration) rather than an ambiguous zero rows | a hand-written `SELECT filename, applied_at FROM harness_shared.schema_migrations WHERE filename LIKE '795%'`. ⚠ One pattern per call — a `filename IN (…)` list, a POSIX-regex range (`~ '^(79[4-9])'`), `LIKE ANY (ARRAY[…])` or a `>= '750' AND < '760'` number range still wants SQL |
| a test file's run history, or which tests are failing | `testing:runs { filePath, status: ["fail","error"], sinceHours }` — typed status enum, and `outputTail` comes back on the red rows | `SELECT … FROM test_runs WHERE file_path LIKE '%x%' AND status='failed'` — ⚠ that literal can NEVER match (pass\|fail\|skip\|cancelled\|error\|running), so it reads as a clean "no failures". Aggregates, `DISTINCT ON`, an `output_tail` hunt, a `finished_at` window or `workspace_id IS NULL` still want SQL |
| to find filed issues by text, state, assignee or scope | `issues:list { q: "fragment", state, assignee, limit }` — `q` matches title + body, `rollup:"state"` gives counts over the whole filtered set | `SELECT … FROM engineer_issues WHERE title ILIKE '%x%'`. ⚠ NO id filter — a single-item read (`WHERE issue_id='WI-123'`) is `work_items:get { id }` — and no time-window arg, so a `created_at` slice, an OR of several fragments, a regex match, and `payload->`/terminal-column forensics stay SQL |
| the green-checkpoint gate's health (consecutive reds, observed candidate, whether a re-triage is in flight) | `routines:list { name: 'green-checkpoint', installSlug: '<your install>' }` — read `health.gate_health`, plus `nextFireAt` / `lastFiredAt`. ⚠ OMIT installSlug and EVERY install's row comes back (21 here, truncated to 12); row 1 is another pot's and reads healthy | a hand-written `SELECT metadata->'gate_health'->… FROM harness_shared.routines`. ⚠ Unprojected columns (`tier`, `concurrency`), cross-routine aggregates and JOINs still want SQL. "Is my change live" is dev:pipeline_position; the judged sha is state:read { cell:'gate.greenCheckpoint.candidate' } |
| one work-item (or up to 100) by id, including its terminal/authority columns | `work_items:get { id }` / `{ ids: [...] }` — whole row incl. terminalOwner, completionAuthority, plus holder + checkpoint; add payloadTier:"full" for payload/summary | a hand-written `SELECT … FROM work_items WHERE feature_id='EI-…'`. ⚠ `payload->` PREDICATES, `source_plan_slug` slices, aggregates and JOINs stay SQL |
| a filtered work-item / issue slice — text, state set, kind, assignee, plan of origin, or a created/updated window | `work_items:list { q, state, notTerminal, kind, assignee, sourcePlanSlug, createdSince, updatedSince, limit }` — add includeObservations:true to match a raw SELECT, and completionAuthority to list under-evidenced closes | `SELECT … WHERE title ILIKE '%x%'`, or `status NOT IN ('done',…)` — that IS `notTerminal`. ⚠ `q` is a literal substring over title+summary, not token search. No id filter; exclusive `>`/`now()` windows, non-union exclusions, source_plan_slug PROJECTION, aggregates and JOINs stay SQL |

<!-- END GENERATED gen:tool-routing -->

⚠ **A `head`-truncated search cannot support a NEGATIVE conclusion — "no callers exist" is precisely the verdict truncation manufactures.** Piping `grep -rn` into `head -N` is safe when you look FOR something (the first hit answers you) and unsound the moment you act on the ABSENCE of a hit: `head` cuts by POSITION and grep walks paths in directory order, so one noisy file (a test, a barrel, a docs blob) can fill the whole budget while the real production caller sits at N+1. The pattern is CORRECT and the match EXISTS — the output was simply cut before it, which is why the result looks like a clean negative rather than a failed search. Same family as the zero-work false-greens (`-t` matching zero tests, `pgrep -q`, a wrong-relation SQL zero-row, a `grep -r` that times out and prints nothing): an instrument that searched only part of the space, whose empty output is indistinguishable from a real absence.

- **Never bound a search whose EMPTY result you will act on.** For "does any caller exist", use `grep -rl` — one line per FILE, so 20 files fit in 20 lines instead of one file eating the budget — or `-c`; if you must bound it, `| wc -l` first so a truncated count is visible as a count.
- **Exclude the definition site when asking who CALLS this**: `| grep -v '<the lib dir>'` drops the definition, the barrel re-export, the docstrings and the tests in one move — both what you meant and what stops self-noise from crowding out the answer.
Measured 2026-08-03 (EI-19435288508184075), establishing whether the persisted sync cache is reachable at runtime:

```
grep -rn --include=*.ts --include=*.tsx \
  'enablePersistedSyncCache\|restorePersistedSyncCache\|startSyncCachePersistence' \
  libs apps packages papercusp-desktop | grep -v node_modules | head -20
```

All 20 returned lines were the lib's own `index.ts`/`types.ts` plus **17 lines of `persisted-cache.test.ts`**. The reading taken was "zero production callers — the feature never runs", and the next step was to build the much stronger claim that the whole mechanism was unreachable. The real caller — `apps/operator/app/_components/RootSyncProvider.tsx` calling `enablePersistedSyncCache({ buster: 'v1' })`, unconditional at module-eval with no flag gate — was **below the cut**. It surfaced one step later only because a differently-shaped grep (excluding the lib dir) happened to reorder the output.

Cost was one step there, because the next probe contradicted it. The expensive version is the one that does NOT get contradicted: a confident "this surface is dead, delete it" filed against live code. A *delete-if-no-consumer* work item is exactly the shape where a truncated negative grep produces an irreversible wrong action.

Sibling false-absence traps in this same family, each with a different instrument and all reading as a clean negative: a full-tree `grep -r` that TIMES OUT prints nothing and exits nonzero, visually identical to "no matches found" (measured twice inside ten minutes, 2026-08-13); `pgrep -q`, which does not exist on this box and reports `gone` for a live process; a vitest `-t` pattern matching zero tests, which used to report `status=passed`; and a zero-row lookup against an issue-family view that structurally cannot hold feature-family rows.


The tool call is also cheaper: a structured result, no subprocess, nothing to
re-parse. When a row's caveat applies (a `tail -f` follow, a non-operator database,
a `\du`), the bash form is the right answer — the gate will not fight you on those.

⚠ **No papercusp tools AT ALL? READ THE REFUSAL — three classes, three different doors.**

- **TRANSPORT** — no tools listed; the handshake never completed (`:9071` starves
  new handshakes under load). Pass your OWN `--client`, or writes land under an
  anonymous `mcp-call-*` (EI-8509):
  `node scripts/mcp-call.mjs <server:verb> --json-file <args.json> --client <your-su-id> --port 3170`
- **DISCONNECTED** — tools worked, then every call says `ECONNREFUSED` or `MCP server
  papercusp-su is not connected`: the operator you dial (often a `:3170` pin) is
  restarting. Re-dial is INCONSISTENT, not never (EI-24755204180385597): once its
  `/api/health` answers, retry the original failed Papercusp tool call. No human
  `/mcp` needed (EI-24657708696146012). Still down? Flush checkpoints via
  `mcp-call.mjs` as above, then respawn YOURSELF:
  `node scripts/mcp-call.mjs session:request-compaction '{"reason":"papercusp-su MCP disconnected"}' --client <your-su-id> --port 3070`
- **IDENTITY** — tools are listed, but calls refuse `Identity capability (unresolved):
  stale-artifact`. ⛔ **`mcp-call.mjs` CANNOT open this one**: server-side preflight
  rejects every client and port (WI-10002028); even `coord:orient` may be refused.
  Read `activation.status` first:
  `sudo -n -u postgres psql -d papercusp -At -c "SELECT jsonb_pretty(control_state->'activation') FROM harness_shared.session_briefs WHERE owner_id = '<your-su-id>';"`
  - `desired`/`prepared` with lagging `applied` → `coord:orient { afterCompaction: true }`
    only acknowledges (WI-10002717); send another prompt, then converge if it remains `desired`.
  - `'failed'` → converge directly; there is nothing for orient to acknowledge.
  - **Converge** only if `adv_sessions.launch_spec->>'specificationRevision'` equals
    `desired`: set `applied` and `prepared` to `desired` and
    `status` to `'applied'`, with `WHERE` on that revision. This mitigates; add the
    occurrence to EI-23703586803892464.
Evidence behind the IDENTITY-refusal rule in "Reaching for bash? These reads already have a tool".

**Why `mcp-call.mjs` cannot open the identity class (WI-10002028).** The `stale-artifact`
denial is a server-side kernel preflight evaluated AFTER the request is accepted, so a
different client, port or transport reaches the byte-identical denial. The documented
transport fallback is not an escape hatch for this class.

**Why `coord:orient` is not reliably the door.** The guide used to say
`coord:orient { afterCompaction: true }` is "exempt from that preflight by design" and
to treat the SQL converge as a rare fallback. Measured otherwise, twice in one 30-minute
session (2026-09-22, su-14342fa6; class EI-23703586803892464, repeatCount 7+):
`coord:orient` was refused with the byte-identical `Kernel preflight denied tool
"coord:orient": Identity capability (unresolved): stale-artifact`. Believing the old
wording costs a wasted call and — worse — reads as "I am locked out with no door left",
which is exactly when an agent escalates a self-fixable blocker to the owner.

**The `failed` branch.** `status:'failed'` carries a `failure` string such as `stack
transition render failed`: the activation never rendered, so there is nothing for
`coord:orient` to acknowledge. Go straight to the SQL converge.

**The `desired`/`prepared` branch (WI-10002717).** `coord:orient` acknowledges without
the activation revision, so it leaves a pending activation for the next turn-start
boundary. Before that fix it advanced the watermark and stranded the activation at
`desired`.

**The converge.** Compare `adv_sessions.launch_spec->>'specificationRevision'` (what the
session is provably running) against `session_briefs.control_state->'activation'`; when
they differ set `applied` AND `prepared` := `desired`, `status` := `'applied'`, guarded
by a `WHERE` on that exact desired revision, via `sudo -n -u postgres psql -d papercusp`.
The tool surface returns immediately; no relaunch is needed. Converge only when
`launch_spec` shows the session is ALREADY running the desired revision — that is what
makes `applied := desired` a true statement rather than a forged one.

**Why it is a mitigation.** A recurrence inside one session means the writer that leaves
activation `failed` is still armed. Occurrences accumulate on EI-23703586803892464.

Relocated from the invariant part `reaching-for-bash-these-read-the-tool-call-is-al` on
2026-09-28 under EI-24511252962859723 (launch prose budget), to keep the rule in every
launch and the case history in the searchable corpus.

## `cd` outside the repo tree does NOT persist across Bash calls — a failed one silently falls back to the repo ROOT

**The Bash tool's own description says "the working directory persists between commands" — that is only true while you stay INSIDE this repo tree.** `cd /tmp/some-scratch-dir` succeeds and holds for the REST of that one call, but the *next* Bash call starts back at this repo's root, with a post-hoc `Shell cwd was reset to <repo root>` note on the PRIOR call's result — no warning before it runs, just after. A `cd` to a path still *inside* the tree genuinely persists across calls. The boundary is exactly "inside vs. outside this tree", not "cd never persists".

⚠ **The in-tree half is NOT the benign one — a persisted in-tree cwd changes which `package.json` a later ROOT `npm run <script>` resolves against.** npm walks up to the NEAREST enclosing workspace, so after a `cd packages/<pkg>/…` the root commands this guide prescribes — `test:affected`, `install:safe`, `doctor`, `gen:*`, `docs:rebuild`, `set-doc-part` — die with `npm error location …/packages/<pkg>` and `Missing script: "<name>"`. **The trap is the READING, not the error**: "Missing script" invites *"that script does not exist"* when the truth is *"wrong directory, and NOTHING was measured"* — so an agent mid-verification moves on believing it verified something.
Evidence for the in-tree `cd` / ROOT-`npm run` trap. Measured 2026-09-05: **207 of the repo root's 260 scripts are absent from `packages/operator-core` alone** — `test:affected` and `install:safe` among them. So after a persisted in-tree `cd`, a root command does not merely run in the wrong place; for the large majority of scripts it cannot resolve at all, and npm reports that as `Missing script: "<name>"`.

This is the same misreading the guide documents for `npm run --workspace <dir> test`: the message describes the SCRIPT as missing when the true fault is the DIRECTORY, so the natural reading ("that script does not exist, nothing to run") sends an agent onward believing it verified something when nothing was measured.

The defensive forms: scope the `cd` to a subshell — `( cd packages/<pkg> && <cmd> )` — or re-anchor before a root script with `cd "$(git rev-parse --show-superproject-working-tree 2>/dev/null)" 2>/dev/null || cd "$(git rev-parse --show-toplevel)" || exit 1`. The first `cd` is deliberately allowed to fail: `--show-superproject-working-tree` prints an empty string with exit status 0 from the superproject itself, so a non-empty-aware fallback is required.


**Why this is dangerous, not just surprising:** a multi-line script with no
`set -e` does NOT abort on a failed `cd` — it keeps executing every later line
in whatever directory it's actually sitting in. Combine the two: call 1's
`mkdir -p /tmp/x && cd /tmp/x` succeeds; call 2 opens with `cd /tmp/x` again
(cwd already reset to repo root) — if `/tmp/x` was never actually created (e.g.
call 1 was itself blocked by a `PreToolUse` gate before the `mkdir` ran), the
`cd` fails, prints "No such file or directory", and the REST of call 2's script
executes directly in **this shared monorepo root** instead of the intended
scratch dir. This is exactly how a `npm install <pkg>` meant for an isolated
scratch dir landed in the live tree and mutated shared `node_modules` while
other agents were working in it (repaired via `npm run install:safe`, no
lasting damage — but the near-miss is the point).

**The defensive pattern, every time a script leaves the repo tree:**
```bash
mkdir -p /tmp/my-scratch-dir && cd /tmp/my-scratch-dir || exit 1
```
`cd ... || exit 1` (or `set -e`) is the whole fix: a failed `cd` then kills the script
instead of falling through. Unsure where a PRIOR call left you? `pwd` first.

**For a `cd` that STAYS in the tree, don't leave one behind:** use a subshell,
`( cd packages/<pkg> && <cmd> )`, or re-anchor before a ROOT script:
```bash
root="$(git rev-parse --show-superproject-working-tree 2>/dev/null)"
[ -n "$root" ] || root="$(git rev-parse --show-toplevel)"
cd "$root" || exit 1
```
Test the VALUE's emptiness, never an exit status: from the superproject root
`--show-superproject-working-tree` prints an EMPTY string with exit 0. ⛔ So the
one-liner `cd "$(…superproject…)" || cd "$(…toplevel…)"` is a silent no-op there —
bash treats `cd ""` as success, the fallback never runs, and you stay where you were
with no signal (WI-10002083).
Evidence behind the re-anchor rule in "`cd` outside the repo tree does NOT persist across Bash calls".

**Why the re-anchor tests the VALUE, not an exit status.** `git rev-parse
--show-superproject-working-tree` prints the superproject path from inside a submodule, but
prints an EMPTY STRING with EXIT STATUS 0 from the superproject itself. So the fallback must be
driven by the emptiness of the value, never by an exit status and never by a failed `cd`.

**The broken one-liner (WI-10002083, measured 2026-09-20).** This is the second bug in the same
two-line recipe: the older `cd "$(git rev-parse --show-toplevel)"` form was replaced after
EI-22406679198158577, and its replacement was:

```bash
cd "$(git rev-parse --show-superproject-working-tree 2>/dev/null)" 2>/dev/null ||
  cd "$(git rev-parse --show-toplevel)" || exit 1        # BROKEN
```

From the superproject root the substitution is empty, so the first command is `cd ""` — and bash
treats `cd ""` as a SUCCESSFUL no-op, not an error. The `||` never fires, `--show-toplevel` is
never consulted, and the shell stays wherever it already was while reporting nothing. The same
trap applies to the value form `git rev-parse A || git rev-parse B`, which can return an empty
path without invoking its fallback.

**Why the silence is the damage.** The re-anchor exists to remove the `Missing script`
misdirection (a root npm script run from a nested workspace) at its source. A re-anchor that
fails silently converts that loud-but-misread failure into NO signal, so the agent proceeds
believing it is at the root. If the one-liner is used anyway, `pwd` immediately after is the only
thing that shows it did nothing.

Relocated from the invariant part `cd-outside-the-repo-tree-doe-the-defensive-patte` on
2026-09-28 under EI-24511252962859723 (launch prose budget).

## Scratch probes: name the file `.mts`, not `.ts`

A one-off probe that imports repo modules belongs in the in-tree, gitignored
`.papercusp/scratch/` — it resolves workspace imports, where `/tmp` does not. **Name it `.mts`.**

Neither location sits under a `package.json` declaring `"type": "module"`, so tsx/esbuild compiles a
bare `.ts` there as **CJS**, and any top-level `await` — the natural way to write
`const { fn } = await import('file:///.../module.ts')` to measure something against the real
implementation — dies at transform time with:

```
ERROR: Top-level await is currently not supported with the "cjs" output format
```

⚠ **The error names the OUTPUT FORMAT, not the fix.** It reads as a problem with your code, so the
natural next moves are all wrong ones: hunt for an esbuild/tsconfig knob, or restructure the probe
into an `async main()` with a `.catch`. Nothing in the code is wrong. Rename `probe.ts` → `probe.mts`
and it runs unchanged.
Evidence for the `.mts` scratch-probe rule. Measured 2026-09-05: `.papercusp/scratch/` held 34 `.mts` files beside 52 `.ts` — the workaround was being rediscovered one agent at a time, which is what the rule exists to stop.

The claim is pinned by `packages/operator-core/lib/doc-claims/scratch-probe-module-format.test.ts`: if a `"type": "module"` package.json is ever dropped over the scratch tree — a real fix that would make a bare `.ts` work — that test fails, so the guidance gets corrected rather than silently rotting into a lie.


## Long jobs: background them at the LAUNCH, don't poll for them afterwards

**"Is my job done?" is 12% of every bash call on this box** — ~2,950 calls in 7
days across 63 of 86 sessions: `ps`/`pgrep` (2,315), polling a task-output file
with `cat`/`tail`/`wc -c` (1,120), and bare `sleep` (1,082, and what follows a
sleep is overwhelmingly another poll). None of that is recoverable by swapping
the poll command, because the fix is one step earlier:

> For anything that runs longer than ~1–2 min, start it with
> **`capability:bash { run_in_background: true }`** and read it with
> **`capability:bash_output { bash_id, filter }`**. The `filter` regex means only
> matching lines enter your context — no `2>&1 | tail -60`.
>
> ⚠ **Duration is not the only trigger — LIFETIME is. If a process is what makes
> an owner-facing deliverable VALID (an OAuth flow, a callback listener, a
> tunnel, a signing session), background it however short it is.** A CLI child
> dies with your session, and every carry-respawn and `claude --resume` IS a
> session death, so the link you sent can be dead on arrival — and a dead one
> looks identical to a live one. Say what its lifetime is bound to (EI-16611).

⚠ **Filter background output at READ TIME, never at LAUNCH TIME.** Let the job
write its stdout/stderr unfiltered to the durable log, then pass `filter` to
`capability:bash_output`. A launch pipeline such as `cmd | grep -E '...'` (or
`| head`) can leave the log empty or truncated if the job is killed before the
consumer flushes its buffered stdout, losing the evidence you needed to debug
the failure. Read-time filtering is repeatable with a different pattern and
also works on the stranded-job recovery path. If launch-time filtering is
unavoidable, use a line-buffered consumer such as `grep --line-buffered` or
`stdbuf -oL`, but prefer keeping the durable log unfiltered.
A session handed the owner a PKCE-bound OAuth consent URL whose `gcloud` process was a child of its CLI; the carry-respawn killed it ~19s later, so the link was dead on arrival and nothing said so. Only `node scripts/proc-guard.mjs check` revealed it — bare `ps`/`pgrep` self-matches the query string and reports phantom liveness (EI-21442716425230784). State the lifetime binding explicitly when you hand such a deliverable over: the operator-owned background scope is not restart-durable either (EI-16611), so "valid while my session lives" is a different promise from "valid for 10 minutes".


⚠ **A background job still has a wall-clock deadline, and reaching it TERMINATES the
job** — 4h by default, 12h max, `timeout` to raise it. The launch result now names the
deadline; a job that hits it says so in its own output (`[capability:bash] deadline
reached: exceeded Nms`) and the log keeps that line, so a deadline death is never
mistaken for an OOM or a peer's `pkill`. Read the deadline off the launch result rather
than assuming; for a job that legitimately runs longer than 12h, don't use this tool.

⚠⚠ That deadline **used to be 2 minutes** — the background mode inherited the FOREGROUND
default, so the remedy this very section prescribes SIGKILLed precisely the jobs it
recommends it for, unless you happened to also pass `timeout` (WI-6677). Fixed
2026-08-02: background now has its own default/ceiling, and the deadline sends SIGTERM
before SIGKILL so the job's `trap`/`finally` cleanup actually runs (the old SIGKILL
skipped it, stranding a 489MB checkout and a 4.9GB deb extract in two separate
incidents). **If you are reading a pre-2026-08-02 note that says a backgrounded job
"died at exactly 120s" or "vanished with no cause", that was this bug — not your
command.**

**Why the tool and not native `run_in_background`:** not because the tool is
crash-proof — it is not. Its in-memory job registry is wiped whenever *any* agent
restarts the operator on this shared box (EI-8855). The difference is
**recoverability**. `capability:bash` writes the job log to a deterministic
`stateDir + bash_id` path, so a poll after that still returns the log tail plus a
cause. There are **three** reason codes and they are not interchangeable
(EI-18666279107998059): `tracking_lost_process_alive` = CONFIRMED running via a
task-ledger pid re-probe — keep polling, do NOT re-run; `job_process_gone` = CONFIRMED
ended, the ledger observed a terminal state — safe to re-run; `job_liveness_unknown` =
only a whole-operator restart was ruled out (the uptime heuristic), liveness genuinely
UNKNOWN and the job is most often alive but QUEUED behind pc-heavy's slot clamp — check
`ps` before re-running, or you add load to the queue that is delaying you. That
three-way split is **LIVE** as of the 2026-08-03 02:30Z deploy (release `13d9c65db69c`) —
a pre-2026-08-03 note saying the live operator flattens all three into `job_process_gone`
is stale, and that flattening is what made a QUEUED job look dead. A
native background id is bookkeeping inside the CLI child's own memory: after a
compaction, carry-respawn, or cold-loop wake it is simply a dead reference with
nothing to recover (EI-16611).

So: **checkpoint the `bash_id`, never a native task id**, and never write "await
background task `<id>`" as a successor's next action.

⚠ **A background command's own reported exit code is the LAST statement's, not
the one you care about — never trust it for a compound command, native OR
`capability:bash`.** (EI-19314565734665863, hit twice in one session on
2026-08-02.) The natural idiom for capturing a verdict —
`timeout 900 <cmd> > log 2>&1; echo "EXIT=$?" >> log` run with
`run_in_background: true` — silently defeats itself: when `<cmd>` is killed by
`timeout` (exit 124) or fails, the trailing `echo` still runs and exits 0, so
the **native** Bash tool's own completion notification reports "completed
(exit code 0)" for a run that never finished. That notification is Claude
Code's own bookkeeping (the shell process's exit status, not `<cmd>`'s) — there
is nothing in papercusp to patch here; treat it as untrustworthy for any `;`-
or `&&`-chained command and grep the log's own `EXIT=` line instead (it reads
`$?` immediately after `<cmd>`, so it IS accurate). **`capability:bash` does
not need this idiom at all** — its background job registry (`bash-jobs.ts`)
tracks the real child process's exit code natively (not from a caller's echo)
and `capability:bash_output` returns it as `exit_code`; trust that field
directly. It also already applies `-o pipefail` so a piped command
(`cmd | tail -60`) reports the pipeline's real exit code, not the last
stage's (EI-13414) — the same masking bug, different shell construct. If you
find yourself appending `; echo "EXIT=$?"` to a `capability:bash` command,
that is a sign you're hand-rolling something the tool already gives you for
free.

⚠ **Never combine `run_in_background: true` with your own manual trailing `&`,
`nohup … &`, or `setsid` inside the command — it double-backgrounds, and the
tool's "completed" notification then lies.** This holds for BOTH backgrounding
doors: `capability:bash` (EI-19389748740902475) and the NATIVE `Bash` tool
(EI-19408257709127659, where `nohup npm run test:affected > log 2>&1 &`
reported `status:"completed"`, exit 0, while `ps` and the log showed the
operator-core suite only just starting) — reading the trap as
capability-specific is exactly how it recurs. `run_in_background: true`
already backgrounds the whole command; adding your own `&` (e.g.
`(cmd > log 2>&1; echo EXIT=$? >> log) &`) forks a SECOND, untracked layer of
backgrounding whose child detaches from the job the tool is tracking. The
outer wrapper — the part the tool actually sees — returns almost immediately
after printing "launched pid $!", so the completion notification reports
"completed (exit code 0)" while the real leaf process (confirmed alive via
`pgrep`, and via `tail --pid=<leaf> -f /dev/null`) is still running,
unfinished, for minutes afterward — with a 0-byte log at the moment of the
false "completion". Note what is worse here than in the exit-code traps
elsewhere in this section: the COMPLETION ITSELF is false, not merely its
code, and the leaf's real exit is never reported at all. This is the same
wrapper-PID-vs-leaf-PID class the note below documents for `npm run <target>`,
but it needs no intermediate `npm` wrapper at all — just pass the plain
foreground-shaped command and let `run_in_background: true` do the
backgrounding; never add your own `&`. If you must background manually inside
a compound command anyway, resolve the real leaf PID and wait on it explicitly
(`tail --pid=<leaf> -f /dev/null`) or poll the log for a terminal marker
before trusting the tool's own "completed" notification. The PreToolUse bash
gate now advises on this at the call site for the native `Bash` tool
(`double-background advisory`), so prose is no longer the only line of
defence.


⚠ **Never wait on a process-table pattern you typed yourself.** `until ! pgrep -f '<pat>'; do sleep 5; done` can NEVER exit from an agent shell: `pgrep -f` matches the FULL command line, and your own `bash -c` argv contains the literal pattern, so the poll matches ITSELF and the condition stays true forever — the same self-match class as the documented `pkill -f` trap. `ps … | grep <pat>` loop conditions share the defect, and `grep -v grep` does NOT save you (the `bash -c` wrapper still matches). The PreToolUse gate now denies the loop form. Wait on the PID instead (`tail --pid=<pid> -f /dev/null`, or `kill -0 <pid>` in the loop) — or, if you genuinely must pattern-poll, bracket the first character so the pattern cannot match its own argv: `pgrep -f '[l]int-tsc'`.

⚠ **The same self-match trap applies across SSH.** In `ssh host 'for p in $(pgrep -f "DISPLAY=:111"); do sudo kill "$p"; done; <rest>'`, the remote shell's argv contains the literal pattern, so `pgrep -f` can match and kill that shell. SSH then reports the generic `exit 255` with no output, and every later command is silently skipped, leaving the remote host partially torn down. Bracket the first character (`pgrep -f '[D]ISPLAY=:111'`) or resolve PIDs by another identity, and keep the remote script single-quoted so the local shell cannot expand `$p` or other variables before SSH receives it. Treat `exit 255` with no output as a possible remote self-kill, not automatically as a network or authentication failure.
A peer burned 27 silent minutes exactly here (EI-19312699396945642).

✅ **The purpose-built tool for a managed task is `processes:list { live:true }`.** For a host-visible shell, `node scripts/proc-guard.mjs check <pattern>` walks the CALLER's own ancestor chain and excludes every pid in it before matching, so it cannot self-match no matter where the pattern appears in your command (the pgrep argument, an `echo` label, a comment, an `ls` path). For `green-checkpoint`, it also recognizes gate-owned identity markers (`GREEN_CHECKPOINT=1` together with `PC_HEAVY_RELEASE_GATE=1`) and the checkpoint systemd cgroup. Other patterns remain operational-argv matches, and a peer's prose or JSON payload is ignored.

`capability:bash` can run in a separate PID namespace with only its own processes. There `proc-guard` exits 2 with an explicit visibility error; a zero match from `pgrep` or a missing `/proc/<pid>` through that door says nothing about host liveness. Bracketing a `pgrep` pattern does not prevent self-matching when the literal also appears in a shell label, comment, or heredoc carried in the wrapper argv. Use `processes:list { live:true }` for managed work, or a verified host-visible tool for a whole-host census.
Exit 0 + the matching rows
(pid + full cmdline) when a genuinely external process matches; exit 1 + a "no
match" line otherwise — and it never prints a bare count without the rows,
because a count alone hides exactly this failure. Verified: `check
'definitely-not-a-real-process-zzqq'` correctly reports NO match while a bare
`pgrep -f` with that same pattern reports MATCHED against its own wrapper.
Bracketing is the inline fallback, not the primary answer — it protects the
pgrep argument only, and an `echo`/`ls` elsewhere in the same compound command
silently re-arms the self-match (measured 2026-08-03: a bracketed `[X]vfb :90`
probe self-matched because an `echo "== Xvfb :90 =="` label sat earlier in the
same call).

⚠ **Three `find` traps on this box, all of which return a CONFIDENT, WELL-FORMED EMPTY result.**

**1. Timestamps.** `find` here is **bfs 4.1.1**. With `-newermt` it REJECTS human-relative values (`12 minutes ago`, `-10 minutes`, `America/New_York`) and can SILENTLY mis-parse absolute ones (`2026-08-28 18:35:00 UTC`), under-reporting by hundreds of times. With stderr hidden, either case looks like a valid "nothing changed". For "files modified since T" use `git status --porcelain` or `TZ=UTC stat -c '%y %n' <paths>`; if you must use `find`, pass an epoch predicate (`@<unix-seconds>`) or an ISO-8601 timestamp with `Z`/a numeric offset, keep stderr visible, and corroborate with a positive control.

**2. Symlinked sibling hives are SKIPPED.** Some "checkouts" under `~/papercupai-workspace/` (e.g. `sidestage`) are symlinks into `~/.papercusp/hives/`, and `find` does not descend a symlinked directory without `-L`. A workspace-wide `find -name '<file>'` silently omitted `sidestage`'s copy. For any cross-checkout search prefer `git ls-files` / `grep -rl`.

**3. ⛔ But NEVER an UNBOUNDED `find -L` over a broad root** (`~`, `~/.papercusp`, `~/.papercusp/hives`, `~/papercupai-workspace`). Those roots reach ~50 checkouts whose `node_modules/@papercusp/*` symlink back into workspace packages, and bfs expands that DAG without bound — it never finishes and never errors. One such call ran 32 h and made the owner's desktop unusable (WI-10000836). The bash gate now DENIES `-L`/`-follow` from those roots unless bounded: `find -L <root> -maxdepth 6 -name node_modules -prune -o -name '<file>' -print`.

**The general rule behind all three: AN ABSENCE CLAIM NEEDS A POSITIVE CONTROL.** Before reporting "X does not exist", run the same search for something you KNOW is in that haystack. If the control also comes back empty, the instrument is broken, not the subject.
Evidence behind the `find` traps (the rule itself is the invariant sibling; this is the measured case history, kept out of the projected guide).

## Trap 2 — the symlinked sibling hive that a plain `find` skipped

A workspace-wide `find -name '<file>'` returned the real checkouts and silently omitted `sidestage`'s copy — output that looked complete, because `find` does not descend a symlinked directory without `-L` and `sidestage` is a symlink into `~/.papercusp/hives/`.

## Trap 3 — the unbounded `find -L` that made the desktop unusable (WI-10000836)

Measured 2026-09-08: one `find -L` over a broad root ran 32 h, reached 70 GB RSS + 1.86 TB swap and made the owner's desktop unusable. The roots reach ~50 checkouts whose `node_modules/@papercusp/*` symlink back into workspace packages, so bfs expands the DAG without bound — it never finishes and never errors. The durable guard is the bash gate's deny in `apps/operator/scripts/hooks/cc/pretooluse-bash-resource-gate.sh`, pinned by `bash-resource-gate.test.ts`.


⚠⚠ **`pgrep -q` DOES NOT EXIST on this box** (procps here has no `-q`), and this one
fails via the EXIT CODE rather than a spurious match, so bracketing cannot help.
`pgrep -qf X && echo ALIVE || echo gone` prints **`gone`** on the usage error — a
well-formed answer to the question you asked, while the process is very much alive
(measured: it printed `gone` while `pgrep -cf` returned **13**). The natural next
action is to conclude the job died and re-run it. Use `proc-guard` above, `pgrep -cf`
(count), `pgrep -x <name>` (matches the process NAME, so argv cannot fool it at all),
or `kill -0 <pid>` (EI-19446554284039165).
The natural next action is to conclude a job died and re-run it. Use
`proc-guard` above, `pgrep -cf` (count), `pgrep -x <name>` (matches the process
NAME, so argv cannot fool it at all), or `kill -0 <pid>`
(EI-19446554284039165).

## Full pre-compression rule text (preserved)

⚠⚠ **`pgrep -q` DOES NOT EXIST on this box** (procps here has no `-q`), and this
one fails via the EXIT CODE rather than a spurious match, so bracketing does not
help. `pgrep -qf X && echo ALIVE || echo gone` prints **`gone`** on the usage
error — a well-formed answer to the question you asked, while the process is
very much alive (measured: it printed `gone` while `pgrep -cf` returned **13**).


⚠ **With `pipefail`, do not use an early-exiting pipeline consumer as a
predicate.** `grep -q`, `grep -m1`, and `head -1` can exit as soon as they
find a match, sending `SIGPIPE` to the producer. The producer may then return
141, so `producer | grep -q PAT && echo yes || echo no` reports `no` even
though `grep` matched. This is a race: the same command can appear to work
until the producer is fast enough to hit the closed pipe. Capture the producer
output and match it afterward instead:

```bash
out=$(producer)
case "$out" in *PAT*) echo yes ;; *) echo no ;; esac
```

If a pipeline is necessary, consume to EOF (for example with `grep -c`) rather
than using an early-exit predicate. A false absence from this pattern is not
evidence that the guarded string, process, or flag is missing.

⚠ **A search of a path that DOES NOT EXIST looks exactly like one that found
nothing** — empty output, and the exit code that separates them (grep: 1 = ran
and found nothing, 2 = could not read the path) is thrown away by a pipe,
`2>/dev/null`, `|| true`, or simply not being read. A plan sat BLOCKED THREE
WEEKS on such a premise, and the agent verifying it hit the same trap the same
day (`work-items/` typed for the real `work_items/`). The PreToolUse gate now
REFUSES a `grep`/`rg`/piped-`ls` whose path operand it can measure as missing —
but it judges only a LITERAL path (never a variable, glob, subshell, or a
relative path when the host states no cwd), and the same shape recurs wherever a
query can miss its target: a `git log` for a submodule path run from the
superproject, a roster lookup by a name that is not the label. So the general
rule is yours: **AN ABSENCE CLAIM NEEDS A POSITIVE CONTROL.** Before writing "X
does not exist", run the same query for something you KNOW is there — if the
control also comes back empty, the instrument is broken, not the subject — and
state the scope you actually searched. For "where is this symbol defined" use
`gitnexus.context { name }` (no path argument to get wrong); for "does this TOOL
exist", `tools:find`.

⚠ **Do not use human-relative timestamps with `find -newermt` on this box.**
`find` resolves to **bfs 4.1.1** here, and values such as `12 minutes ago`,
`-10 minutes`, or `America/New_York` are rejected. If stderr is hidden, the
empty output can look like a valid "nothing changed" result. For "files
modified since T", use `git status --porcelain` or `TZ=UTC stat -c '%y %n'
<paths>`; if you must use `find`, pass an ISO-8601-like timestamp with `Z` or
a numeric offset and keep stderr visible. The PreToolUse Bash gate refuses
literal non-ISO `-newer?t` operands and names this remediation.

⚠ **Line-oriented matching cannot see a phrase split by hard wrapping.** Generated
or rendered prose may insert a newline inside a multi-word phrase, so
`grep -c 'IN THIS SAME TURN' rendered.md` → 0 does **not** prove the clause is
absent. Inspect the surrounding lines; flatten newlines before matching, for
example with a newline-flattening `tr` transform, or use a
short single-token discriminator that cannot wrap. For deploy/render checks,
measure both the OLD and NEW text after flattening so a zero is corroborated by
the expected transition rather than treated as a bare absence.


> ⚠ `pgrep -x` matches `/proc/<pid>/comm`, which the kernel truncates to **15
> chars**, so a longer binary name never matches. This one is well-behaved —
> measured 2026-08-10, `pgrep -x qemu-system-x86_64` (18 chars) prints
> *"pattern that searches for process name longer than 15 characters will result
> in zero matches"* and exits 1, rather than silently returning nothing. Match
> the truncated comm instead (`pgrep -x qemu-system-x86`), or use `-f`.

⚠⚠ **The same self-match trap exists in SQL, and the bracket fix does NOT transfer.** A `pg_stat_activity` probe filtered by `query LIKE '%pattern%'` **matches its own backend**: `query` holds the currently-executing statement, and yours contains the pattern in its own `WHERE` clause. So it reports a hit whether or not the process you are hunting exists — measured, a marker string present in no real query anywhere returned exactly one row, the probing backend itself. ⛔ Bracketing (`'%[p]attern%'`) is a **grep** character class, not a SQL one (that is SQL Server); Postgres matches `[p]attern` literally, your statement still contains it verbatim, and it **still self-matches** — so the habit above fails here while looking like it was applied. Exclude yourself explicitly with `AND pid <> pg_backend_pid()`, or use **`dev:pg_active_queries`**, which takes no pattern and already excludes itself.
Measured 2026-09-05 against the live operator database (EI-19453654761353908; the
trap was originally hit 2026-08-03 while identifying which process owned the
dbos-executor-reaper timer).

Three forms of the same probe, run in ONE statement so they share a backend, using
a marker string that appears in no real query anywhere on the box:

    SELECT
      (SELECT count(*) FROM pg_stat_activity
        WHERE query LIKE '%zzmarker_probe_alpha%')                      AS naive_filter,
      (SELECT count(*) FROM pg_stat_activity
        WHERE query LIKE '%[z]zmarker_probe_alpha%')                    AS bracket_fix_attempt,
      (SELECT count(*) FROM pg_stat_activity
        WHERE query LIKE '%zzmarker_probe_alpha%'
          AND pid <> pg_backend_pid())                                  AS with_backend_pid_exclusion;

    -> naive_filter=1  bracket_fix_attempt=1  with_backend_pid_exclusion=0

The first column is the trap: a pattern with ZERO possible true matches still
returns a row, because `pg_stat_activity.query` holds the statement currently
executing and that statement contains the pattern. The failure is silent and
directional — it manufactures a FALSE POSITIVE, so the natural next action is to
go hunting for a process that does not exist.

The second column is why this needed its own note rather than a pointer to the
`pgrep` entry above. `[z]` is a character class in grep/POSIX regex, NOT in SQL
`LIKE` — bracket classes there are a SQL Server extension. Postgres matches the
literal four characters `[z]z`, which the probing statement also contains
verbatim, so the bracket "fix" self-matches exactly as the naive form does while
appearing to have applied the documented remedy. An agent carrying the habit over
from the process-table rule gets the wrong answer AND believes it is guarded.

The earlier verbatim sighting (2026-08-03 17:26Z) returned only the probing psql
backend for `query LIKE '%GROUP BY executor_id%'`:

    3829678 | 127.0.0.1 | 46212 | psql | active

`dev:pg_active_queries` is safe by construction on both counts: it exposes no
pattern argument, and its underlying SQL (`pgActiveQueries` in
`packages/operator-core/lib/dev-data.ts`) carries
`AND query NOT ILIKE '%pg_stat_activity%'`, which excludes its own statement.


✅ **"Is this process actually DOING WORK right now?" — a two-sample delta over the
process's CGROUP, never a single-shot reading and never a hand-walked tree.** Every
single-shot probe answers a *different* question and fails toward a false "idle":
`ps -o %cpu` is a process-LIFETIME average, and a first-iteration sampler has no prior
sample to difference against. CPU usage *is* a delta; ask for one.


The runnable recipe, and the two `/proc` methods that each report a confident FALSE IDLE on a
process burning a full core:
[is this process actually doing work?](/internal/docs/agent-insights/is-this-process-actually-doing-work).
Measured 2026-08-10 (EI-20067988429441680). On a reap-heavy tree steadily burning ~2.7 cores, summing only fields 14+15 gave **89, -89, 74, -73, 0, 81** ticks/3s while the corrected sum gave 668-887: the live set is MEMBERSHIP-VARYING, so its difference is not a rate — vitest forks a worker per file and reaps it, and ticks counted in sample A are simply absent from B. ⚠ Fixing this by reading the ROOT's `cutime` alone is WORSE, not better: `cutime` only credits children the parent has `wait()`ed on, and in the real chain (`npm` -> `sh` -> `vitest` -> workers) *vitest* reaps the workers while the root reaps nothing until the run ends — measured **0, 0, 0, 0, 0, 0** for the whole run, a silent false idle instead of a noisy one. Sum the LIVE TREE. Calibrated against known loads: 0.99 / 2.99 / 0.99 cores for 1 / 3 / 1 burners (the corrected form reads ~6% low under churn — a reaped child's ticks land only at `wait()`, so it lags, but it is monotonic and never negative). And divide by MEASURED elapsed, never the sleep constant: the tree walk forks `pgrep`/`awk` dozens of times, so a nominal `sleep 3` took 4.1-5.3s on this box and the nominal divisor inflated every reading by 35-75%.


Re-measured 2026-08-10 (EI-20078374975070099): the "sum the LIVE TREE" fix above is itself defeated by the walker's DEPTH BOUND, so the corrected `/proc` form still reports a false idle on this repo's own primary test command. On `npm run test:affected` (capability:bash job `9e03bcf7-26a`, pid 419967) burning a steady 1.0 core, the documented 6-generation walk returned **`cores_busy=0`, `tree_pids=8`**, with `sh -c vitest run` as its DEEPEST member holding 0 ticks — the real `node .../vitest run` and its `esbuild --service` child sit at depth 7+ and were never enumerated, so the sum was taken entirely over processes that are legitimately idle. The single-pid `c*` reading returned **`delta_ticks=0`** over 10s, independently reproducing the silent false idle documented above. At that same moment the cgroup read `delta_usec=10069464` over 10.07s → **`cores=1.00`** with `procs_in_cgroup=13`, correctly including the depth-7 worker. The full chain is `bash -o pipefail -c` → `npm run test:affected` → `sh -c PC_HEAVY_COALESCE=0` → `bash scripts/pc-heavy.sh` → `node scripts/affected-tests.mjs` → `npm run test` → `sh -c vitest run` → `node vitest` → `esbuild`: pc-heavy queuing plus npm's `sh -c` indirection structurally add four levels before any real work starts, so a 6-deep walk can never measure it. The cgroup form additionally has no reap lag (the corrected tree sum reads ~6% low under churn per the calibration above) and makes no membership assumption at all, which is why it replaces rather than supplements the walk.

⚠ **Measure the whole PROCESS TREE, not the pid you were handed** — a `MainPID` is often a wrapper sitting at `utime=0` while a child burns a full core.
That trap cost a critical (EI-20029519971967372: the bg-host freeze watchdog killed a healthy boot every ~8 min because it had no way to tell "saturated and working" from "dead"). Walk children via `/proc/<pid>/task/<tid>/children` — **pid-anchored, so unlike a `pgrep -f` pattern it cannot self-match a peer's diagnostic shell**. Reference implementation: `procTreeCpuTicks` in `apps/operator/scripts/bghost-watchdog.mjs` — ⚠ but copy its TRAVERSAL, not its arithmetic: it sums utime+stime only and so carries the reap-heavy defect above (WI-37714), which is correct for bg-host's long-lived tree and wrong for any tree that forks-and-reaps.

⚠ Corollary: **a liveness beat emitted BY the process being judged cannot report main-thread saturation** — a saturated Node main thread stops every `setInterval` while looking perfectly asynchronous. Observe from OUTSIDE (`/proc`).


Treat `top -n1` as usable here; the two-sample `/proc` recipe is still the one to reach for, because it needs no column-index guess (`%CPU` is field **9** in `-H` output, not 8 — field 8 is the state column, and misreading it yields a whole column of `S` that looks like data).⚠ EI-20017779937060288 reports that `top -b -n1 -H` prints **0.0% for every thread** (a first-iteration artifact). **That did NOT reproduce** — re-measured 2026-08-10 against the same pid at the same load, `top -b -n1 -H` reported 99.9% on exactly the 2 hot threads of 13 and 0.0% on the idle ones, agreeing with the `/proc` delta above.

⚠ **Waiting on the right PID isn't enough for an `npm run <target>` you
launched detached — the PID you can grab immediately is usually the WRAPPER,
not the real work, and a wrapper-PID wait returns exit 0 while the job is
still running** (EI-19340089056227272). `npm run build` here is a chain
(`build` → `docs-build-singleflight` → `build:inner` → `astro build`, and
similarly for other package scripts); `pgrep -f 'npm run <target>'` matches
the outer `npm` process, which forks the leaf and can exit/return well before
the leaf finishes. A `tail --pid=<that PID> -f /dev/null` wait then comes back
in seconds while the build is still printing its first few lines — reading
exactly like "the job finished successfully," which is worse than an obvious
failure because nothing looks wrong. Resolve the **leaf** process before
waiting (e.g. `pgrep -f '[a]stro build'` for an Astro target — bracket the
first character per the self-match rule above), or don't rely on wait-exit
alone: also grep the job's own log for a terminal marker (`Complete!`, `EXIT=`)
before concluding it's done. Treat wait-exit as necessary but not sufficient.

Do not sit in a `sleep`/poll loop waiting on work you did not launch either —
prefer the push path (`events:await`, a completion event) over polling; see the
"never wait for a calm window" and force-the-deploy rules above.

## Feature flags + PostHog

**Feature flags have one source:** `libs/flags/src/types.ts`; flip them via `/admin/features`, never JSON/PostHog directly or an ad-hoc env boolean. New flags default enabled: finished work must set the code default ON and verify it live in the same task—an override-only flip or "owner later" is unfinished. Default-OFF is only for incomplete/unsafe code, owner-authority/security/destructive surfaces, or an attended cutover kill-switch. Put every exception in `KNOWN_DARK_FLAGS` with justification and `DARK_FLAGS_REVIEW_BY`, and surface it in plan `## Now` plus completion. Reversibility is a reason to verify ON, not ship dead code.
## Full pre-compression rule text (preserved)

Single source of truth for keys/defaults: `libs/flags/src/types.ts`; flip flags
via `/admin/features`, not JSON or PostHog directly. Gate cuttable features from
day one (`requireFlag` / `useFlag` / `gateApiRoute` / Hono middleware / MCP
registration) — **a feature toggle is a `FLAGS` entry, never an ad-hoc
`process.env.PAPERCUSP_*` boolean** (an env gate ships dark, dodges the default-on
guard + the dark-flag expiry, and can't be flipped at runtime; `lint:env-feature-gates`
enforces this in CI — env stays for launch-time/test/dev config only). **New flags
DEFAULT TO ENABLED — finished work never ships dark.** A flag left OFF means the code does
NOTHING in production, so a feature you built, tested, and left gated OFF is DEAD CODE and the
task is NOT done — however green the tests. **Flipping it ON is the FINAL STEP OF THE SAME TASK,
never a "someday" and never a hand-off** (and a flag flipped on only via a runtime override while
its DEFAULT in `types.ts` stays `false` is the same half-finish — change the default). ⛔ The #1
way good work silently dies is "ship it dark, verify/flip later" — PgBouncer AND claim-auto-convert
BOTH sat built+tested+OFF for weeks. KILL the two excuses that cause it: (i) **"the owner flips it
after verifying."** NO — if YOU built it and it's tested, YOU verify it: flip it ON, watch it work
live, flip it OFF only if it breaks. Verify-then-flip is ONE atomic step YOU own in THIS task, not
a punt to the owner or to "later"; the owner asked for a working feature, not dead code awaiting a
ceremony. (ii) **"it's reversible / safe to ship dark."** Reversibility is the reason to flip it ON
*confidently*, not a license to leave it OFF. Default-OFF is allowed ONLY for: genuinely
INCOMPLETE/unsafe code (it doesn't fully work yet), an OWNER-AUTHORITY/security surface the owner
must personally ratify (privilege-escalation, destructive reapers, public signup, full-autonomy),
or a reversible CUTOVER kill-switch needing an attended live verify the OWNER runs — and "finished
but I'd like it verified first" is NONE of these (that verify is YOUR job, in-task). When one of
those three genuinely applies — and then (a) add it to
`KNOWN_DARK_FLAGS` in `libs/flags/src/production-defaults.test.ts` with a
justification (CI fails otherwise), and (b) surface the pending flip loudly in the
plan's `## Now` + your completion report. The dark allowlist carries a
`DARK_FLAGS_REVIEW_BY` expiry, so a dark flag can't linger silently. Reference:
`/internal/docs/posthog` + `/internal/docs/posthog/feature-flags`.

⛔ **The dark allowlist is SHRINK-ONLY — never reconstruct or grow it, and never build a parallel one.** `KNOWN_DARK_FLAGS` exists ONLY to express the small set of genuinely-not-ready exceptions above (incomplete code / would-break-the-running-fleet / owner-authority / staged-cutover) — it is **NOT a parking lot for finished work**. `DarkCase` splits the set into two populations governed differently: the `DARK_FLAGS_HIGH_WATERMARK` size ceiling in `libs/flags/src/types.ts` (imported by `production-defaults.test.ts`) governs ONLY the **`parked`/`incomplete`** subset (`DARK_FLAGS_PARKING_COUNT`) — the actual parking-lot abuse; it **fails the build if THAT subset grows**, not the aggregate `DARK_FLAGS.size`. `owner-authority` / `cutover` entries (permanent or staged safety kill-switches) are **not rationed** by the watermark at all — they are governed only by the `DARK_FLAGS_REVIEW_BY` re-review date, so a legitimate new safety flag never has to fight a parking-lot budget. So: flipping a `parked`/`incomplete` flag ON *removes* its allowlist entry (the parking subset shrinks ✓); shipping a NEW genuinely-incomplete flag dark requires first **graduating an existing parked/incomplete dark flag** to make room (net-zero) or **explicit owner sign-off** to raise the watermark — never a quiet append. **Do NOT route around this guard** by re-introducing a second dark allowlist, a per-flag `process.env.PAPERCUSP_*` gate, a `darkReason` side-table, or any other parking-lot for finished-but-scary work: the temptation to park it dark "to verify later" is *exactly* the abuse this exists to stop — flipping it on and watching it work IS the task.Owner mandate 2026-06-23; the allowlist was being abused as a parking lot. The two-population split is WI-4495 — a single aggregate ceiling used to penalize adding a legitimate safety kill-switch exactly as hard as parking finished work, which is why the watermark kept getting silently raised 22→24→25→26 for the SAME bug class every time.

## Tests after editing

```bash
# Pass one comma-delimited value after `--changed-paths=` for YOUR radius.
npm run test:affected -- --changed-paths=path/to/first.ts,path/to/second.ts   # YOUR radius
npm run test:affected                  # unit only — the WHOLE tree's radius, not yours
npm run test:affected:integration      # also runs *.integration.test.ts
npm run lint:tsc -- --files=<the files you edited>   # TYPES — vitest does not typecheck
```

⚠ **ORDER MATTERS: typecheck LAST, after your FINAL edit — including the edit you made
to fix a failing test.** The ordinary loop invalidates its own verdict: typecheck → run
suites → a test fails → edit the TEST file → suites green → done. The clean verdict was
banked BEFORE that last edit and never covered it, and the green suite cannot stand in for
it, because vitest transforms via esbuild and never typechecks — a green run carries ZERO
type information. So the loop ends holding a fresh green signal that is silent on types
beside a stale clean one that is not, and they read as agreement. The resulting regression
is type-only, invisible to `test:affected` by construction, and first surfaces at the fleet
green-checkpoint hours later. Re-run `lint:tsc --files=` over the FULL changed set — source
and test files — as the last thing you do.


⚠ **The dual runs the other way too: a TYPECHECK cannot see a collapsed test fixture.** A multi-site identifier rename (`replace_all` across ~20 files) trips both halves at once, and each check is structurally blind to the other's defect — so "the tests were green" and "the typecheck was clean" are each individually insufficient after one, and each feels sufficient. A fixture that needs N *distinct* entities still typechecks perfectly once a rename collapses two of them onto one id; only RUNNING it surfaces the `Encountered two children with the same key` / `Found multiple elements with the text` failure. So after a multi-site rename run BOTH, for every workspace touched. And before collapsing a token inside a fixture, ask whether the test asserts N distinct entities — when a retired id needs replacing there, substitute a different REAL sibling rather than reusing the surviving id twice.
The case (EI-19448610782500230, found during EI-1539 — retiring the `papercusp-default` knowledge pack, a ~20-file identifier rename): one `replace_all` pass produced TWO distinct defects, and in both cases the check that had most recently passed was structurally incapable of seeing it.

**Defect 1 — types, invisible to tests.** The same fallback-literal edit was applied to two React forms. In `NewLocalForm` the local is a genuine `'coding'|'work'` union (driven by a `domain` prop), so a `=== 'work'` ternary is correct. In `ExistingLocalForm` it is `const defaultPack = 'coding'`, which TS narrows to the LITERAL type, making the same branch provably dead: `TS2367: This comparison appears to be unintentional because the types '"coding"' and '"work"' have no overlap`. **135/135 tests passed with this bug in the tree** (42/42 + 65/65 + 28/28) — it is a dead-branch type error in a fallback literal that only renders when a sync query returns empty, so no test can reach it. A bare `lint:tsc` covers `packages/operator-core` only, so the routine loop would have missed it too; it would have surfaced at green-checkpoint hours later as someone else's red.

**Defect 2 — fixture, invisible to types.** `apps/operator/app/cupboard/InstalledPacksSection.test.tsx` carries two listing rows and two pack rows so that its multi-row test can assert two rendered rows, resolve a title per row, and put the muted badge on one and the update badge on the other. Renaming the retired id to `coding` collapsed both onto the same id ⇒ `Encountered two children with the same key, 'coding'` + `Found multiple elements with the text: …`. Typecheck is blind to this; only running the test sees it. The repaired fixture uses `coding` and `work` — the two shipped builtin packs — which is the "substitute a real sibling" rule in situ.

The two defects are duals: tests cannot see the type error, and types cannot see the fixture collapse. That is why the invariant asks for BOTH after a multi-site rename rather than either alone.

A mechanical guard was considered and deliberately not built: a lint flagging a literal that appears 2+ times as a `key`/id within one fixture array, or a post-edit nudge (like `check-migration-fixture-drift.mjs`) when an `Edit` with `replace_all` touches a `*.test.*` file and reduces the number of distinct values in an array literal. Both are narrower than the discipline they would encode and would fire on legitimate shapes; the documented rule is the durable version.


⚠ **`test:affected` runs the suites of the WORKSPACES your changed paths map into —
so "green" can mean "nothing ran". To see what your change actually selects, ask
`testing:run { changedPaths: [...] }` — the same derivation, ~0.4s, and NO pc-heavy
admission ticket (it returns the PLAN and runs nothing, so read `mode:"plan"` and never
as a verdict). Or run the probe directly:**


```bash
node scripts/affected-tests.mjs --changed-paths scripts/lint-tsc.mjs,libs/flags/src/types.ts --print-affected
```

The print-only probe emits `AFFECTED_WS\t<workspace>` for selected workspaces,
`AFFECTED_WS_CMD\t<workspace>\t<command>` per selected TASK, and
`AFFECTED_GUARD\t<workspace>\t<script>\t<command>` for repo-wide invariant guards attached by
the same run. Guard lines may appear even when there are zero `AFFECTED_WS` lines; that is
the intended fail-safe behavior for root-level changes.

⛔ **Run the emitted command; never rebuild one from the workspace name.** `npm run
--workspace <name> test` is WRONG for a standalone package (a submodule like
`papercusp-desktop`, deliberately not in root `workspaces`): npm answers `No workspaces
found` and **exits 1 having measured ZERO tests** — indistinguishable from a failing suite.
The command field already handles it (`npm --prefix papercusp-desktop run --silent test` vs
`--workspace` for genuine workspaces, EI-22152426246970496). A workspace with no
`AFFECTED_WS_CMD` line has no selected task: running anything for it measures nothing.

⚠ **The probe takes `--changed-paths`; the RUN takes it too — use it, or you measure one
radius and run another.** A bare `npm run test:affected` derives its radius from git
(committed vs `origin/main` + working tree + untracked), which on this SHARED tree is the
whole fleet's work plus base drift — `origin/main` only fast-forwards on a green checkpoint,
so it sits ~1,500 commits back and a 3-file edit selected 71 workspaces / 90 tasks
(EI-20812741760514969). Every run now opens with one greppable
`AFFECTED_DERIVATION source=… changedPaths=… committed=… workspaces=… tasks=…` line saying
where its radius came from, plus a stderr banner when an unscoped set is tree-sized. That
wide scope is CORRECT for the green-checkpoint gate (it certifies the whole candidate) and
wrong for you: `source=explicit` is what verifying your own edit looks like.


A git-based probe cannot answer that question on this tree: git-sync sweeps the WHOLE
tree, so no real commit is ever scoped to just your paths, and `changedFiles()` also
folds in every peer's uncommitted edits. `--changed-paths` derives the set from an
explicit path list and exits before running anything. Reach for it whenever a suite you
expected to run didn't, or before trusting a fast green on an unusual path. A path that
belongs to no workspace selects **nothing** — root `scripts/**` did exactly that until
EI-19346163916263067 routed it to `@papercusp/operator-core` (measured: 7 of 106
scripts-touching commits in 600 ran none of the ~56 suites that cover them, and one ran
zero tests at all while reporting `status=passed`).

⚠ **`test:affected` is TYPE-BLIND — a green run does NOT mean your change compiles.**
Vitest transforms via esbuild/swc, and neither `scripts/affected-tests.mjs` nor
`lint:affected-gate` invokes `tsc` at all. So a type-only regression is invisible to
the routine loop and first surfaces at the **green-checkpoint** hours later, where it
reds the gate for the whole fleet and costs a peer the diagnosis. **Run
`npm run lint:tsc -- --files=packages/operator-core/lib/a.ts,…/b.ts` after editing** —
it gates a PER-FILE baseline scoped to exactly the files you name (fail-soft), which is
what makes it usable while operator-core still carries ~200 pre-existing errors that
would otherwise drown your one new one.

> ⚠ **Name the files; do NOT use `--mine` on this tree.** `--mine` infers "your" files
> from `git status`, and this repo has ONE working tree shared by the whole fleet with
> every agent's edits sitting unstaged until the next git-sync tick — so `--mine` means
> "dirty in the tree", i.e. *yours and every peer's*, and it will report a file you never
> opened as "1 file(s) YOU changed". This is one of the most-repeatedly-filed frictions
> here (EI-18731016038876755, which added `--files` precisely to fix it, plus three
> later duplicates). Both directions cost you: you chase a peer's error believing it is
> yours, or — worse — your own genuine regression arrives amid peer noise all labelled
> "YOU changed" and you dismiss the lot as fleet drift. `--files` is the only form whose
> attribution is trustworthy here.
>
> Since EI-19305736771912430 that trust extends to the **exit code**, not just the report:
> under `--files` a NEW file (one the baseline has never seen) that is outside the set you
> named no longer reds your run — so **a red under `--files` always means a file YOU named**.
> The unscoped findings are still printed, split into "uncommitted, a peer is likely mid-edit"
> and "COMMITTED: a standing red that WILL red the fleet" — the second kind needs an owner even
> though it is not your gate failure. `--mine` deliberately still fails on them: it *infers* the
> changed set from `git status`, and git-sync commits the tree every few minutes, so absence
> from that set is not evidence (EI-18766822535373909). `--files` *declares* it, which is the
> evidence `git status` cannot supply.

⚠⚠ **A BARE `npm run lint:tsc` typechecks `packages/operator-core` ONLY** — it is a single
`tsc -p packages/operator-core/tsconfig.json` (`scripts/lint-tsc.mjs`), so a clean bare run says
NOTHING about an edit anywhere else, and grepping its output for your paths finds nothing because
they were never compiled. **Always pass `--files=<the files you edited>`** — that form ROUTES each
path to the baseline-gated leg that OWNS it (`apps/operator` → `lint:tsc:operator`, plus
`:operator-vite`, `:orchestrator`, `:papercusp-libs`, `:scripts`, `:workspaces`). A `--files` set
lying entirely outside operator-core RUNS the owning leg for you (`status=routed`); a MIXED set
compiles only the in-scope files (`status=partial filesUnchecked=N`) and prints the exact command
for the rest. Read the `LINT_TSC_RESULT status=`, not just the exit code — `partial` is not `clean`.
A change confined
to another workspace — **`libs/generic/*`, `libs/papercusp/*`, `apps/*`, other
`packages/*`** — is typechecked by NEITHER `lint:tsc` NOR vitest, so a type-only
regression there is invisible to *both* routine checks and first reds the
**green-checkpoint**. Editing outside operator-core? Also typecheck that workspace —
**`build:typecheck { project: "<workspace>" }`** (EI-18719561823587590).

> ✅ **Editing `apps/operator` — including `lib/release/green-checkpoint.ts` — use
> `npm run lint:tsc:operator -- --files=<the files you edited>`.** It is the same per-file
> baseline gate as `lint:tsc` (`scripts/lint-tsc-operator.mjs` + `apps/operator/.tsc-baseline.json`,
> ratchet-only-down), added 2026-08-02, and it attributes correctly — it reports which of a
> file's errors PRE-DATE your change rather than blaming you for the standing baseline.
>
> ✅ **You no longer have to know which gate to pick — name your files at ANY `lint:tsc*` gate and
> it routes you** (EI-19461218392796337, fixed + verified live 2026-08-03; these are scripts run
> from the working tree, so there is no deploy to wait for). A gate that cannot judge the files
> you named now resolves them against its SIBLINGS and prints the command that can:
> `RUN THIS to check them:  npm run lint:tsc:operator`. Coverage is read from each sibling's own
> exported declaration, so a new `lint:tsc:*` script is picked up the moment it lands.
>
> ⚠ **It used to assert the opposite, so distrust any older note repeating it.** The refusal
> read *"NO typecheck gate covers these — nothing local will ever catch a type error here"* — a
> UNIVERSAL concluded from two facts that do not imply it (the file is outside MY project; its
> workspace declares no `typecheck` script), never consulting the sibling gates. Being covered by
> a sibling while declaring no workspace script is the NORMAL arrangement here, so it was wrong in
> the common case. Measured 2026-08-03: an agent trusted that sentence, fell back to hand-grepping
> a raw `tsc -p apps/operator/tsconfig.json` against a 579-error baseline, concluded 5 type errors
> it had just introduced into `green-checkpoint.test.ts` were "pre-existing", and shipped them —
> `lint:tsc:operator` flagged them instantly (`18 of this file's 23 error(s) PRE-DATE your
> change`, `exit=1 regressed`). The file it wrongly declared uncoverable implements the fleet's
> release gate.
>
> **The transferable rule, which the fix itself had to obey:** a tool asserting a UNIVERSAL
> ("no X exists", "nothing will ever") is making a claim about a scope it usually cannot see —
> verify an absence against the registry/manifest (here, one `grep lint:tsc package.json`), never
> against one tool's refusal. The banner now says *"No typecheck gate FOUND"* and, when any gate's
> coverage could not be resolved, adds *"the search was INCOMPLETE, so this is 'none found', NOT
> 'none exists'"* — naming each gate it could not read. Replacing one confident universal with a
> better-informed confident universal would have been the same defect in a bigger hat.

> ⚠ **Do NOT reach for `npm run --workspace <dir> typecheck` as the fallback — most workspaces
> have no such script and it dead-ends with `npm error Missing script: "typecheck"`.** Measured
> 2026-08-03: of 53 `libs/generic/*` packages with a tsconfig, only 7 declared one. The trap is
> the READING, not the error: "Missing script" invites the conclusion *"this workspace has no
> typecheck, so there is nothing to run"*, which is wrong — the code is perfectly checkable,
> nothing was checked, and you proceed believing you verified it. The command that always works
> is the tsconfig directly (EI-19409185011887864):
>
> ```bash
> npx tsc --noEmit -p libs/generic/<pkg>/tsconfig.json
> ```
>
> ✅ **`libs/generic/*` is no longer on the uncovered list above** — `lint:tsc:workspaces` (a
> green-checkpoint leg) now gates a package on having a **tsconfig.json**, not on having
> remembered to declare a script, so all 54 are checked routinely and a new package is covered
> the moment it has a tsconfig. `apps/*` and other `packages/*` are still script-only and remain
> report-only: promotion requires measuring a root first (`PROMOTE_ROOTS` in
> `scripts/lint-tsc-workspaces.mjs` says why, and the run prints every directory still
> unreachable).

> ✅ **`--files=` no longer lies about this** (EI-19341572300046923). Naming a path outside
> the project a gate compiles used to scope the VERDICT to files that compile never saw, so
> the run printed a clean result having typechecked **none of them** — a green indistinguishable
> from a real pass, and how two operator-vite reds reached the fleet gate on 2026-08-02. Now the
> gate checks coverage BEFORE the ~150s compile: if *every* named file is outside, it exits **1
> in ~0.15s** and names the command that does cover them (prefer `npx tsc --noEmit -p
> <workspace>/tsconfig.json` — see the Missing-script warning above);
> if only some are, it warns loudly and still reports the covered verdict. Coverage is derived
> from each CLI's own `-p` operand, so all four per-project gates (`lint:tsc`,
> `lint:tsc:operator-vite`, `lint:tsc:orchestrator`, `lint:tsc:papercusp-libs`) inherit it. It
> fails OPEN on an unparseable command — never a red it cannot substantiate.

> ⚠ Use the tool, not a hand-run `npx tsc -p . --noEmit`, and this is a correctness
> point rather than a style one: **there is no root `tsconfig.json` in this repo** (only
> `tsconfig.base.json`), so from the repo root `-p .` and `-p tsconfig.json` fail
> instantly with TS5057/TS5058 having typechecked **zero files**. Those are the two most
> common project operands in the whole 7d corpus, and 45 of 425 decidable `tsc`
> invocations (11%, across 24 of 86 sessions) checked nothing. What makes it expensive is
> how it reads: 42% of those runs were piped into `grep`, and a `grep <my-file>` over a
> one-line TS5057 prints **nothing at all** — indistinguishable from "my file is clean" —
> while `2>&1 | tail` throws away tsc's exit code too. `build:typecheck` refuses a
> zero-file run instead of reporting a clean zero, and names the projects that do exist.

> ⚠⚠ **The same false green also arrives via a CRASH, which the zero-file guards above
> cannot see — a hand-run `tsc` on operator-core OOMs and is killed BEFORE printing one
> diagnostic** (EI-20019651513530828 / EI-20013137550825704, both measured 2026-08-09).
> The program is ~9k files and overflows node's default ~4GB old-space:
>
> ```
> FATAL ERROR: Ineffective mark-compacts near heap limit … JavaScript heap out of memory
> Aborted (core dumped)          # exit 134
> ```
>
> A dead run emits **zero** `error TS####` lines, so every probe you would naturally
> reach for reads exactly as it would on a clean compile — `grep -c "error TS"` → `0`,
> `grep <my-changed-file>` → nothing. One agent got to within a step of recording
> "operator-core typechecks clean with the new required field", on precisely the
> required-field question the next paragraph flags as the classic silent breaker.
>
> **Never conclude "clean" from an absence of matches — read the run's exit status.**
> The tools now do it for you: `npm run lint:tsc`, `build:typecheck` and
> `capability:inspect { check:'typecheck' }` all pin the heap
> (`PAPERCUSP_TSC_HEAP_MB`, default 8192) so the OOM does not happen, and all three
> refuse a nonzero-exit-with-no-diagnostics run rather than reporting it as a pass.
> If you must hand-run tsc, set `NODE_OPTIONS=--max-old-space-size=8192` and check
> `EXIT=` — never the grep alone.

**The trigger to watch: adding a REQUIRED field to a shared interface** (or renaming
/ re-typing one). Every fixture that constructs that type elsewhere goes stale
instantly, in files your change never touched and `test:affected` never selects — and
a stale fixture in a file whose tsc baseline ALREADY tolerates errors is invisible to
the ratchet too, so it stays silently broken rather than loudly red. This bit three
separate changes on 2026-07-26 alone (`AgentFact.confidence`,
`OwnerSteering.createWakeSuppressPlans`, `PipelinePosition.submodulePin`), and
`IssueClaimExclusionBreakdown.excluded.remoteOrigin` on 2026-08-02 (27 errors across 2
committed files, caught ~10 min before the gate run that would have red-pinned on them).

**Don't do that by hand — `npm run lint:required-field-strands`** AST-diffs your change against `HEAD` and names every exported type that gained a required field, nested paths included. It also catches a field TIGHTENED from optional to required, which strands sites just as hard. It is ADVISORY by design — adding a required field is usually correct, so the mere addition is never a failure; `--typecheck` runs `lint:tsc` and exits non-zero only on real stranded sites. Finding the sites was never the hard part — `tsc` already does that perfectly; the gap this closes is *knowing to run it*. ⚠ Do NOT "fix" the errors by making the new field optional: that silently reintroduces whatever under-reporting the required field was added to prevent.Shipped as WI-6814. The 2026-08-02 case lived one level down, inside `excluded: {}`, where a top-level scan reports nothing and reads exactly like "no trap here". Making the field optional again is exactly the WI-6409 claim-floor bug.

**The behavioural sibling — adding a CALL to an injected collaborator strands call-COUNT
assertions in ANOTHER workspace**, and nothing you run locally sees it: `lint:tsc` is clean
(no type changed, only a runtime count) and `test:affected` selects by the workspaces your
changed PATHS map into, so it cannot select the stranded fixtures by construction. One
instance (WI-37582) cost ~3 gate reds and ~2h of frozen `main`.

`npm run lint:behavioural-strands` is the detector; a PostToolUse hook fires it at the edit,
which is the only moment it works — git-sync sweeps your edit into HEAD within minutes, and
`--base HEAD` then diffs content that already contains it. Read the EXIT CODE, not the prose:
0 = checked, no strands · 1 = strands named · 2 = NOT CHECKED (not a clean bill). The named
set is a RANKING, not a boundary (`--wide` runs the full reachable band). If a downstream
count assertion fails, UPDATE the count — deleting or loosening it removes the only thing
that makes the next such change detectable.

The detector also covers the value half of this runtime strand: rewriting the expression
assigned to a returned or persisted output property can strand a downstream assertion even when the object
shape and every type still agree. It joins on the PROPERTY NAME, not on one matcher spelling. A value trigger is advisory for the same
reason as a call-count trigger: RUN the named tests, then update the expectation only when the
new runtime contract is intentional; otherwise repair the writer. Pin the pre-edit commit
with `--base <sha>` when git-sync may already have swept the edit into `HEAD`.
Evidence behind the behavioural-strand rule (the rule itself is the invariant sibling; this is the case history, kept out of the projected guide).

## The measured instance — WI-37582

A second `source.lexical()` call in `libs/generic/search` added a CALL to an injected collaborator. `lint:tsc` stayed clean (no type changed, only a runtime count) and `test:affected` selected by the workspaces the changed PATHS map into, so it could not select the downstream call-COUNT fixtures that the new call stranded. The result was ~3 gate reds and ~2h of frozen `main`.

## The value half — a worked example

Rewriting the expression assigned to a returned or persisted output property (for example, `spentCents: rollup.potCents` → a conditional) can strand a downstream assertion even when the object shape and every type still agree. The detector joins on the PROPERTY NAME, not on one matcher spelling, and ranks reachable tests that read the property directly, by element access, an object matcher, `toHaveProperty`, or an `assert.*` call.


**A migration that ADDS a column to a `harness_shared` table can silently strand a
sibling `*.integration.test.ts` fixture** that hand-rolls that same table via an inline
`CREATE TABLE` instead of applying real migrations — the fixture used to be
schema-complete for every column it named and quietly falls one behind, and
`test:affected` won't select the stale file (your migration's diff never touches it).
A PostToolUse hook nudges you at edit time when this happens
(`scripts/check-migration-fixture-drift.mjs`, EI-19359711978838614) — advisory only, and
deliberately narrow: it fires only when some OTHER fixture already builds the exact
table and is missing the exact new column, not on every fixture that happens to omit it
(most are INTENTIONALLY partial stubs, e.g. "only the columns the live reads query" —
that's normal, not drift). `npm run lint:migration-fixture-drift` runs it by hand.

Schema/migration edits (`libs/papercusp/libs/db/**`) → `npm run
test:integration-only` (integration suites only; the graph won't catch them).
Don't run `npm run test:all` for routine edits. Each app/lib ships a `TESTING.md` — read it
before adding tests. Infra (Vitest 4, testcontainers PG, Docker required, CI,
property tests, knip, quarantine, secrets):
[repo-conventions § test infrastructure](/internal/docs/system/repo-conventions).


**npm only — never `pnpm`/`yarn` in this repo, even for a single-package test
run.** This is an **npm workspaces** monorepo (root `package.json`'s
`preinstall` runs `only-allow npm`); there is no `pnpm-workspace.yaml`. Running
e.g. `pnpm --dir packages/operator-core test` doesn't see npm's workspace
linking for internal `@papercusp/*` packages (they resolve via a plain `"*"`
version range, no `workspace:` protocol) — pnpm instead tries to fetch them
from the public registry and fails on the first private/unpublished one (e.g.
`@papercusp/audio-dsp`), a confusing error unrelated to your change (EI-7243).
For one or more exact test files, always use the repository router:

```bash
npm run test:file -- path/to/one.test.ts path/to/two.integration.test.ts
```

It discovers each file's owning workspace, runs from that workspace with its
unit or integration Vitest config (so app-local `@/` aliases resolve correctly),
prints requested versus matched/executed files, and hard-fails a zero or partial
match before executing. Do not hand-compose a root-level `vitest --config …`
command: there is intentionally no universal root config, config include globs
are cwd-relative, and the same-looking command can silently select zero files.
Pass additional Vitest flags after a second `--`, e.g.
`npm run test:file -- path/to/file.test.ts -- --reporter=verbose`.

⚠ **A `-t <pattern>` that matches ZERO tests is a run that measured NOTHING — and it used
to report `status=passed`.** Vitest merely SKIPS every test and exits 0, so
`Tests 625 skipped (625)` sat one line above `TEST_FILE_RESULT … status=passed`
(EI-19425177453558152). Same shape as the two zero-work false-greens documented above
(`tsc -p .`, `test:affected`), and it fires in the most expensive direction: the canonical
reason to pass `-t` is to confirm a **pre-fix RED**, and a false green there reads as "the
defect isn't real", so the natural next move is to stop — having verified nothing. The
router now refuses it (`TEST_FILE_NAME_FILTER_NO_MATCH`, exit 1, and deliberately NO
`TEST_FILE_RESULT` line, since its presence is what callers grep to mean "tests ran"), and
`testing:run` refuses the same via `error: 'name_filter_no_match'`.

⚠ **npm eats one level of quoting, so `-t 'a b c'` reaches vitest as `-t a` plus stray
POSITIONALS** (which vitest reads as extra FILE filters, narrowing the run further) — the
original false green. The refusal now prints the pattern **as vitest received it** plus any
strays, so the quote-eating is self-diagnosing. Quote for the inner command, or use a
space-free pattern.

**`npm install`/`npm ci` on this shared tree is a mutation every OTHER concurrent
agent can see mid-flight — serialize it, never run it bare.** `node_modules` is
unsynchronized global mutable state: one agent's install rewrites `node_modules/.bin`
out from under every other agent's test run (`vitest: not found` / a bare
`ERR_MODULE_NOT_FOUND` into `node_modules` — neither error names the real cause), and
two OVERLAPPING installs can leave a package durably HALF-WRITTEN (e.g. a `dist/`
with only `.d.ts` files, zero `.js` — not a version-resolution problem, does not
self-heal) (EI-18662389554660036). Always run **`npm run install:safe`** (passes
through to `npm install` by default; `node scripts/npm-install-safe.mjs ci` /
`... install --legacy-peer-deps` for other subcommands) instead of a bare `npm
install`/`npm ci` — it serializes concurrent installs across every agent process on
the host via a filesystem mutex (`scripts/lib/fs-mutex.mjs`, keyed off the repo
root's real/symlink-resolved path) before the rest of the tree ever sees a rewrite.
If a test run ever fails with the signature above, another agent is very likely
mid-install right now — `npm run test:file` detects it and prints a
`TEST_FILE_MID_INSTALL_SUSPECTED` hint instead of leaving you to chase a phantom bug;
wait for it to finish (or check `ps aux | grep 'npm install'`) and retry.

⚠ **A `TEST_FILE_ROUTE_ERROR ... matched=0` does NOT always mean the router failed to find your
file — check for a `TEST_FILE_TRANSFORM_ERROR` line beneath it.** A parse failure ANYWHERE in a
workspace's import graph makes `vitest list` collect zero test files and exit non-zero, which trips
the zero-match guard — so the terminal line blames routing for what is usually a PEER mid-edit in
an unrelated file. On this shared tree that is a high-frequency shape, and the real cause prints
~20 lines earlier, above the `| tail -N` cut this file prescribes throughout. The router now names
the culprit explicitly (EI-19462803905923939) and says which of the two cases it is — a file YOU
named failed to parse (a real syntax error in your own work), or a module only reachable through
the import graph did (re-run in a minute before investigating). Read that line before concluding
your test file moved or that your change broke the import graph.

⚠ **Hit a confusing "cannot find module" / Rolldown "failed to resolve" for a package
that IS in `package.json`? Run `npm run doctor:deps` BEFORE you suspect a code bug.**
Concurrent installs can leave npm's reify bookkeeping believing a dependency is
resolved (it's in `package-lock.json`, and `node_modules/.package-lock.json` is
newer) while the tarball was never extracted — so `npm install` prints "up to date",
exits 0, and the first symptom is an unrelated build/gate failure 10+ minutes later
(EI-18666853411437489: 8 declared `mem0ai` peers missing on disk blocked a gate; two
agents each mis-diagnosed it as a code bug first). `doctor:deps`
(`scripts/check-declared-deps-extracted.mjs`) checks in ~0.2s that every
directly-declared dependency of every workspace actually resolves on disk, and
`install:safe` now runs the same check automatically after a successful install
(repairing once with a full `npm install --legacy-peer-deps`, then failing loudly)
so the corruption surfaces at the install, not in someone else's build.

## Proving a guard is falsifiable — never mutate the shared tree to do it

A guard test that has never failed is a guard you have not tested. Proving it CAN
fail is correct discipline — but the obvious way to prove it is unsafe here, and has
already cost a committed mutant:

```bash
cp "$F" "$B"; <mutate>; <run the suite>; cp "$B" "$F"     # ⛔ never do this
```

It fails in **two independent ways**, and the second is not fixable by being careful:

1. **DEATH RACE** — the restore is the LAST statement, so anything that kills the
   command partway (the 2-min foreground Bash deadline, a SIGTERM, a compaction)
   skips it. A `trap` fixes this one.
2. **SWEEP RACE** — git-sync commits the WHOLE working tree every few minutes, and a
   probe legitimately holds the file mutated for as long as the suite runs. A sweep
   landing in that window commits the mutant *even though nothing went wrong and the
   trap never fired.* **A trap cannot fix this — it is a mitigation, not a fix.**

A mutation probe that mutates the shared tree can be committed by the sweep even when nothing goes wrong and no handler fails. `git status` cannot warn you either: on a swept tree a clean status means the sweep ran, not that the file is unmodified.Both failure modes fired for real (EI-19450431506682666): `db6d7b02b1` committed a mutant of `scripts/verify-tauri-headless.sh` in which the fix's function was DEFINED but never CALLED — inert, `bash -n`-clean, and shaped exactly like a finished change. Had green-checkpoint cut a candidate from it, the recurrence guard written minutes earlier would have red-pinned the whole fleet on a mutation nobody meant to commit.

**Pick the lowest tier that fits — only the last row's in-tree mutation dirties the tree:**

| your subject | how to prove falsifiability |
|---|---|
| a subject (or `--test` cmd) containing DESTRUCTIVE primitives (rm/rmdir/unlink/shred/truncate/mkfs/`dd of=`/`find -delete`) | **TIER-0: `--fake-destructive`** — PATH shims log each destructive call's argv and delete NOTHING; assert on what the code WOULD delete. The probe REFUSES such a subject without it; REAL execution needs `--i-know-this-deletes --sandbox-root <dir>` (bwrap, `/` read-only). Limit: PATH interception only — an absolute-path `/bin/rm` call needs the sandbox. |
| a MODULE / logic you `import` | Keep a deliberately-wrong implementation **permanently in the test file** as a control (plus a calibration case the REAL subject must pass, or the controls also pass when the property itself is broken). Never mutate production code. |
| a guard whose subject is the SOURCE TREE itself (it greps/walks files and asserts over their text) | ⚠ The control fixture lives INSIDE the subject, so a plainly-spelled fixture **SELF-MATCHES** — the `pgrep -f` trap in static form. It fails loud (a false positive), but a guard red forever gets deleted or weakened. **Strip before matching** with `stripCommentsAndStrings` (`scripts/lib/strip-comments-and-strings.mjs`, offset-preserving), or exclude the fixture's path, and **assert the fixture is STILL detector-shaped** so the control can never pass VACUOUSLY. ⚠ Don't strip where real tokens live inside literals (`DROP DATABASE` in a SQL template): that flips a true positive into a silent false NEGATIVE — decide per call site. |
| a FILE artifact the test reads by path (shell scripts, config, generated output) | Mutate a **COPY** outside the tree and point the test at it — zero window, no lock, no trap. Make the test's subject path overridable (an env var defaulting to the real path); that one line is what makes tier 2 available at all. |
| a guard whose pre-fix source is already in Git history | **HISTORICAL MODE:** use `--against-commit <sha> --must-be-absent <literal>` or `--against-last-without <literal>`. The probe freezes current and historical snapshots before either run, requires `--positive-control <literal>` for every token the assertions index, and requires a `--calibration` command that passes on both snapshots. |
| genuinely unavoidable in-tree mutation | Last resort. Hold the sweep for the probe's duration AND restore from a trap (see below). |
Evidence behind the SOURCE-TREE self-match row in "Proving a guard is falsifiable" (the tier table). The original row, verbatim, before it was condensed on 2026-09-28 under EI-24511252962859723 (launch prose budget):

⚠ The control fixture lives INSIDE the subject, so a plainly-spelled fixture **SELF-MATCHES** and the guard reports a violation that does not exist — the `pgrep -f` trap in static form (third documented venue, after process patterns and `pg_stat_activity` predicates). It fails toward a FALSE POSITIVE, so it is loud rather than silent — but a guard that is red forever gets deleted or weakened by whoever next touches it, so it is not benign. **Strip before matching** — `stripCommentsAndStrings` from `scripts/lib/strip-comments-and-strings.mjs` (TS-parser-based, blanks to spaces so offsets/line numbers stay exact) — so only real top-level code can satisfy the detector; or exclude the fixture's own path. Obfuscating the literal (`'export ' + 'function '`) also works but silently obliges every later author to remember the trick. **Either way, assert the fixture is STILL detector-shaped**, or a later "simplification" feeds the detector an unmatchable string and the control passes VACUOUSLY. ⚠ Not every guard may strip strings: one whose real tokens legitimately live inside literals (`DROP DATABASE`, which in TS source appears only inside a SQL template literal) would flip a true positive into a silent false NEGATIVE — the split is per call site, not per guard.

**`scripts/mutation-probe.sh` implements tier 0, historical mode, and tiers 2–3** so nobody hand-rolls the unsafe shape again. Copy-out is the default; it proves the tracked file is byte-identical before exiting, and it **refuses a mutation that changed nothing** — a no-op mutation makes any guard look weak, which is a false verdict from a probe that never mutated anything. `--mutate` is strict-checked: an undefined perl `$var` in the replacement is a hard refusal, not a silent empty-string expansion (the exact failure that once turned a probe's subject destructive).

Historical mode is the first choice when a true pre-fix source exists in Git. Never assume `HEAD` is “before” on this swept tree: use `--against-commit <sha> --must-be-absent <literal>`, or let `--against-last-without <literal>` select the newest reachable commit whose file lacks that literal. Every `--positive-control <literal>` must be present in both snapshots, and `--calibration <command containing {}>` must pass against both; those checks prevent a missing token or a broken instrument from becoming a plausible falsifiability verdict. The guard command must pass against current and produce the requested caught/survived verdict against the frozen historical snapshot.


```bash
# --fake-destructive is REQUIRED here: the subject contains rm/unlink, so the
# destructive-primitive gate refuses this probe outright without it.
scripts/mutation-probe.sh \
  --file scripts/verify-tauri-headless.sh \
  --fake-destructive \
  --mutate 's/^\s*if port_lost_to_squatter; then PORT_LOST=1; break; fi$//' \
  --test 'PROBE_SCRIPT={} npm run test:file -- apps/operator/lib/verify-tauri-headless-bind-retry.test.ts'
```

```bash
# Historical mode: NEW_GUARD must be present now but absent from the selected
# before-fix commit; stable-control is a required positive control.
scripts/mutation-probe.sh \
  --file packages/operator-core/lib/attention/bulk-resolve-kill-switch.test.ts \
  --against-last-without 'NEW_GUARD' \
  --positive-control 'stable-control' \
  --calibration 'grep -q "^stable-control$" {}' \
  --test 'grep -q "^NEW_GUARD$" {}'
```


Exit codes: `0` mutant/historical source CAUGHT (guard is falsifiable ✓) · `1` mutant/historical source SURVIVED (your guard is weaker than you think) · `2` misuse / missing historical control / failed calibration / no-op mutation / a mutant that no longer PARSES · `3` in-tree restore FAILED, act now. Note `0` means *the guard failed on the mutant or historical source* — "the probe succeeded" and "the test passed" mean OPPOSITE things here.


For tier 3, pause the sweep only for the files the probe mutates — git-sync excludes actively file-locked paths from its staging pathspecs, so probes on disjoint files and unrelated commits keep moving:


```
locks:acquire {
  paths: ['<repo-relative-mutated-file>'],
  coordination_domain: '<physical root for a nested repository>',
  ttl_sec: 1200,
  intent: 'mutation probe'
}
```

Top-level file: omit `coordination_domain`. Submodule: use its physical root (`git -C <file-directory> rev-parse --show-toplevel`) and keep `paths` relative to it. `--sweep-lock-held` refuses unless this session owns a live lock with intent `mutation probe`, then heartbeats it to 1200 s; the in-tree window is capped at 600 s. After the trap verifies restoration: `locks:release { lock_id }`.

The file lock is the whole fence, superproject and submodule alike. Do **not** take the exclusive `git-sync:<harness>` lease (it freezes every agent's commits): git-sync re-reads the lock census AFTER staging and unstages any late-locked or drifted path (EI-24712906810240170), provided the lock precedes the mutation and is released only AFTER the verified restore, the order the probe enforces. Evidence binders refuse to fingerprint a locked path.

`--accept-sweep-race` is only for a checkout known not to be swept or a consciously accepted risk; prefer copy-out mode (no dirty window).

⚠ **The dirty window is visible to PEERS** (EI-18750303030034478): a peer's raw `test:file` / `test:affected` can read the mutant and report an unrelated red. While a probe's `original.manifest` exists, a failing raw run prints `TEST_FILE_MUTATION_PROBE_WINDOW` naming the subject; treat a red on it or an importer as probe evidence and re-run once the window closes. `testing:run` refuses with `mutation_probe_active`.


⚠ **A `trap` alone does NOT restore promptly — bash will not run a trap handler while
waiting on a FOREGROUND child.** Measured 2026-08-03: a SIGTERM during a 25s guard
restored the file only after 23s, i.e. when the child happened to exit. The harness sends
SIGTERM *then* SIGKILL, so a deferred handler is frequently never a handler at all — which
is exactly how the original mutant survived. Run the guard in the background and `wait` on
it (`wait` IS interruptible); `mutation-probe.sh` already does this, and kills the guard's
whole descendant tree by pid rather than by name.

Prior independent discoveries of this same rule, consolidated here because they lived in
work-items nobody reads: EI-19394353984226522, EI-19393300770054790.

## Browser checks — use `verdict`

Ad-hoc/exploratory browser verification → the `verdict` skill, **not** Playwright
MCP tools or ad-hoc Puppeteer. Playwright is only for running/extending the
committed `apps/operator/e2e/*.spec.ts` suite. `verdict` is for
**arbitrary/external** pages — operator UI (`:3055`/`:3070`) is verified inside
the **Tauri shell** per `/internal/docs/testing/agent-e2e`, never by pointing
verdict at those ports.

## Use Context7 for current library docs

Before non-trivial APIs from third-party libraries (Tauri 2, Next.js 15, nuqs,
Hono, Radix, Vercel AI SDK, Vditor, BlockNote, …), call the `context7` MCP tools
(`resolve-library-id` → `get-library-docs`). Library APIs change faster than
training cutoffs; don't guess from memory.

## Adding a tool — the per-role guidance discipline

1. **Define** in `packages/operator-core/lib/agent-tools/<group>/<verb>.ts` (or
   `packages/agent-mcp/src/tools/...` for read-side).
2. **Import** it from `packages/operator-core/lib/agent-tools/index.ts`.
3. **Add `guidance: { when, notWhen?, chaining?, byRole? }`** — `when` first.
4. **Chat surfaces**: add `mcp__agentmcp__<group>:<verb>` to that surface's
   `allowedTools` (operator-converse:
   `packages/operator-core/lib/operator-mcp-tools.ts`; oracle:
   `packages/operator-core/lib/agent-tools/oracle/prompts.ts`).
5. **Run** `npm run lint:tool-prompts` — green before commit. This quick-check
   now also enforces the P-011 prompt-weight budget (≤1500 soft / ≤1600 hard per
   tool's description+guidance), so an over-budget guidance edit reds HERE
   instead of silently wedging the green gate (EI-7284).

   > It is a ROOT entrypoint that queues behind `scripts/pc-heavy.sh`, which is
   > what makes it runnable when you actually need it. To measure ONE tool
   > instead — seconds, no pc-heavy queue — **`npm run tool-weight -- <tool>`**
   > (`--json`; `--all` for the catalog). It prints the total AND the per-field
   > split (`description · when · notWhen · chaining · byRole`), so you cut the
   > field that is actually heavy instead of eyeballing it — the heavy one is
   > routinely `chaining`, not `description`.
A bare
   > `npx vitest run tools-md-sync` is REFUSED by the heavy-command admission
   > gate under fleet load — i.e. this mandated check used to be un-runnable as
   > written during exactly the hours the fleet is busiest, so the gate got
   > skipped and the breach surfaced later as a frozen fleet gate
   > (EI-19364889235428417).

> **Editing a live tool counts too.** In practice nearly every prompt-weight gate
> red has come from *growing* an existing tool's `description`/`guidance`, not from
> adding a new one — and an editor never reads an "Adding a tool" section, so the
> breach lands committed and freezes the fleet gate hours later. Run the same
> `npm run lint:tool-prompts` quick-check after ANY description/guidance change,
> not just an add. Backstop (EI-10966): the live operator now re-checks the prompt-weight
> budget at tool-registration and warns in its OWN log the moment a hot-reloaded
> edit goes over budget — so a skipped quick-check surfaces in the operator, not
> only at the fleet gate.

Per-tool when/not-when goes on the tool; cross-tool patterns in
`<role>.tools.md`; behavior rules in `<role>.persona.md`. The split is
intentional — see `packages/operator-core/lib/prompt-assembly.ts`.

⚠ **A caller's `limit` bounds ROW LISTS ONLY — never an aggregate. If a count is
computed over a capped fetch, the RESULT must say so ON THE AGGREGATE.** Marking
only the row list is not enough: the aggregate is what gets read as a verdict, and
a bounded measurement rendered as a confident number is indistinguishable from a
real zero. Measured (WI-37381): `work_items:burn_down` at `limit:5` reported
`terminal.total 0`, `delta 0`, `deltaBy.fleet 0` where the true values were
`1693` / `93` / `71` — while `deltaByPartitions:true` and the `basis` note still
rendered, so it read as a complete census of an empty queue. The fleet's own drain
leader believed it. Same family as the zero-work false-greens above (`tsc -p .`
checking zero files, `test:affected` selecting zero suites, a `-t` filter matching
zero tests) — and it fails in the same direction: silently, toward "nothing there".

The fix pattern, both halves: pin the census fetch independently of the caller's
`limit` (`censusLimit`), and expose a boundedness marker beside the counts
(`truncatedByLimit`) so a floor is never read as a total. **Guard it behaviourally,
not by field name** — the invariant is that the same fixture at `limit:N` and
`limit:N*100` returns equal aggregates (`burn_down.test.ts`, WI-37381). Anchoring a
check to the spelling of a flag is the form-blind mistake documented under
shared-lib singletons above.

## Prompts are auto-generated — edit the source, never the rendered output

Every agent-facing prompt is assembled at launch/spawn from sources: chat-surface
roles from `apps/operator/prompts/<role>.{persona,tools}.md` + the tool-guidance
catalog; psu playbooks from
`apps/operator/prompts/papercusp-su-{engineer,power}.tools.md` (which splice
THIS `CLAUDE.md` in as the Project guide — repo-convention changes belong here);
harness spawn prompts from `libs/papercusp/packages/harness/prompts/<role>.md`.
**Never edit rendered outputs** (`~/.papercusp/*-collaborator*.md`, anything
under `papercup-release`, captured prompts). Dev edits load immediately
(`PAPERCUSP_RELOAD_PROMPTS=1`). After a `<role>.tools.md` edit run
`npm run lint:tool-prompts`; after a substantial SU-playbook edit run
`npm --prefix apps/operator run llm-test -- --target su`. Long form:
[repo-conventions § prompts](/internal/docs/system/repo-conventions).

## Where new tests go — four canonical frameworks

Every new test goes in **exactly one** of: **Vitest**
`<package>/lib/**/<name>.test.ts` · **Playwright**
`apps/operator/e2e/<name>.spec.ts` · **Cargo** `#[cfg(test)]` · **LLM
scenarios** `packages/operator-core/lib/llm-testing/scenarios/<role>/`. **Never** new
`.mjs` integration scripts or tsx smoke scripts (CI lint P-038 fails the build).
`npm --prefix apps/operator run lint:tests` guards registry coverage — if it
fires for a new subsystem, widen a domain in
`packages/operator-core/lib/testing-domains-registry.ts` then `npm run
gen:contract` (root). See `/internal/docs/testing` §1.0a.

## Fleet leaders — the Project guide is per-stack

**Fleet leaders: your members read this repo's Project guide BY THEIR STACK, not by harness.** A doc part with a `stack_scope` (identities-v1 P-022) leaves the default `CLAUDE.md` and is spliced at launch only into a session whose stack matches — `blueprint:su.fleet-member`, `slot:autonomy`, `role:su`, …. Before you brief a lane, see what its members actually receive: `node scripts/project-doc-parts.mjs` prints the addressed inventory on every run, and `--audience=blueprint:su.fleet-member,slot:autonomy` previews a member-under-AUTO guide. A leader-only or member-only repo rule is authored once with `npm run set-doc-part -- --part-key <key> --stack-scope <tokens> --client-scope all …` — never as a per-member kickoff paragraph, which no successor can find. (This part is itself addressed to `blueprint:su.fleet-leader`: a member never sees it.)

