<!-- GENERATED FILE — DO NOT EDIT BY HAND. -->
<!-- Projected from Postgres: harness_shared.harness_doc_parts (doc_id=claude-md, client=claude). -->

> ⚠ **CLAUDE.md is GENERATED — editing it here does nothing durable.** Claude Code reads this file
> off disk, which is the only reason it exists (the canonical content is in Postgres:
> `harness_shared.harness_doc_parts`, with `harness_docs.content_mode='composed'`). A hand-edit
> is overwritten by the next projection and is invisible to every other client.
>
> **To change a rule:** edit its PART, then re-project — both halves are commands:
> `npm run set-doc-part -- --part-key <key> --body-file <path> --write`
> (`--list <prefix>` to find the key; dry-run without `--write`), then
> `node scripts/project-doc-parts.mjs --write`.
>
> Supporting evidence for these rules is deliberately NOT here — it lives in the corpus
> (`kind='prose'` rows, searchable) so a rule reaches the agent without its case history.

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
short scalar (`"review:<id>"`) + `useMemo` lookup, never 1KB of JSON. 

## All client data sync goes through `@papercusp/sync`

Reads via `useSyncQuery({ queryName, args })`; writes fire
`notifySyncInvalidate(...)` (+ `useSyncMutate` for the hook). **Never** hand-roll
`fetch + setInterval`, SWR, React-Query, or a raw `EventSource` for query data —
the library is the one audited path (**SSE in every runtime** — desktop *and*
browser, no runtime branch; POLLING/REST only as the degraded fallback. 

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
tested, not to be extended. 

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


Interactive (human-present) PSU sessions can still take a fast redirect from the owner, but the default is resolve-don't-relay.

⛔ **Before you report an OWNER-GATED wall for a credential or permission, exhaust the privilege you already hold — on this box `sudo -n` is `NOPASSWD: ALL`.** The recurring failure is escalating "needs a superuser / needs credentials I don't have" after probing only the *unprivileged* path, which hands the owner a chore the agent could have done itself.

```bash
sudo -n -u postgres psql -d papercusp -c '<SQL>'
```

A permission blocker is owner-gated only once **`sudo -n` has also failed**. When you do report one, name the privileged paths you actually tried — "no superuser is reachable" is a claim about YOUR probe set, not about the machine, and stating it the second way is how a five-second fix becomes an owner's task.


## A cross-lane ruling is a plan Decision, recorded the moment it forms

Any agent — not only a fleet leader — who settles a trade-off, ratifies a scope, or issues a
ruling OTHER lanes must follow records it as a plan Decision **at the moment it forms**:
`plans:add-decision { slug, title, body }` (via the structured `### D-NNN` form the tool
produces — a hand-authored `- **D-NNN**` bullet in a plan body is NOT parsed as a decision by
`@papercusp/plan-parser`, so it never surfaces through the mechanisms below). Never record a
governing ruling only as a coord message: a message is not addressable after delivery, so a
peer who received a wrong paraphrase has no way back to the source. A decision is.

This is not a paperwork nicety — it changes outcomes. 

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


> 🚨 **NEVER run a tree-wide destructive git op on the shared checkout** — not
> `git reset --hard`, not `git checkout .` / `git checkout -- :/`, not
> `git clean -fd`, not `git stash`. 

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

**"Is my change live, and if not what is the ONE thing blocking it" is ONE call — `dev:pipeline_position { path }` — never a hand-diff.** It answers three *different* questions that agents routinely conflate:

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

The block is derived from each cell's own `changeSignal` declaration, so it cannot drift from the registry — a cell added, renamed or re-pathed shows up (or stops showing up) on its own (`state-plane-stamp.ts`).

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


✅ **It DOES answer *"which sha is the run judging right now"*, AND it now names its own
provenance — read `source.authoritative` before you act on the sha.** The cell returns
`source: { value, authoritative, why }`: `'retriage-marker'` is authoritative (the run's OWN
published `inFlightRetriage` marker — an observation of what it is judging), `'run-probe'` is
NOT (on a MANUAL run its `/tmp` unit log, but on a CRON run it degrades to the checkpoint
checkout's live HEAD, an inference that changes between two reads). A non-authoritative
reading is also hoisted into the reply's `summary`, so you cannot miss it. Do not fire a
manual re-run off an inferred candidate. Raw `harness_shared.routines` SQL is the LAST resort.

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

**Corroboration requires independent EVIDENCE, not independent recall.** Two agents agreeing is not confirmation when both merely inherited the same unstated convention. The claim in this box is pinned to the code by `packages/operator-core/lib/doc-claims/gate-candidate-ref.test.ts`, so a gate that legitimately starts reading a remote ref fails there and forces this text to be updated with it.

⚠⚠ **STEP 0 FIRST — establish WHICH sha is actually being judged. Skipping this is the
expensive mistake, and no amount of care in the steps below can recover from it.**

✅ **ONE CALL ANSWERS STEP 0 AND STEP 1 TOGETHER — do this before you write any SQL:**

```
state:read { cell: 'gate.greenCheckpoint.candidate', as: '<your repo-relative path>' }
```

It returns the judged sha plus **`source.authoritative` — read that FIRST**: a `run-probe` reading is an *inference* (on a CRON run, just the checkout's live HEAD), so never fire a manual re-run off one. Everything below is the FALLBACK for when it answers `unknown`. Field-by-field: [reading pipeline state](/internal/docs/agent-insights/reading-pipeline-state-position-health-nextaction).


## Ratified designs: implementation owes current passing visual evidence

## Ratified designs owe current passing visual evidence

After `design-phase.ratify_reference`, completion owes current passing `design-phase.compare_render` evidence for every case; inspect with `design-phase.get_design_evidence`. Each viewport/theme/state needs its own reference. Only engine verdicts count. Resolve missing, stale, invalid, and failing cases; visual parity never replaces responsive, interaction, functional, or accessibility checks. Explicitly retract obsolete references. While enforcement is report-only, treat returned `designEvidence` refusals as blocking.


## Commit discipline: git-sync owns commit + push — you do neither

🚨 **Never fire a manual `release:checkpoint-run` while a run is in its re-triage window.** That
window is where a STALE red gets voided and the gate re-fires itself onto a newer tip;
`green-checkpoint.ts:2566` states plainly that killing it "discards the rescue and costs a full
suite". 

✅ **You no longer have to remember to check — the verb itself now refuses with the answer.** `release:checkpoint-run`'s `already_running` reply reads the marker and, when a refire is in flight for THAT run, leads its `note` with `🚨 AUTO-REFIRE IN FLIGHT — STAND DOWN`, names both candidates (the one being judged **and** the one already discarded), lists the files the abandoned red named so you don't go fix them, and reports the budget via `in_flight_retriage.budget`/`at_cap`. Its containment check switches to the marker's candidate too, so `callerEditsInCandidate` answers about the sha actually being judged rather than the checkout HEAD inference. A marker written BEFORE that run started is deliberately NOT attributed to it (the run-lock is a singleton, so it belongs to an earlier run) and the pre-existing refusal is returned unchanged — `in_flight_retriage: null` means "no refire in flight", never "unknown".

⚠ And when it does re-fire: **a passing affected-tests suite is NOT a green gate.** The lint/perf/
desktop/delta gates and the `main` fast-forward still have to clear; an agent asserted "gate green"
off the suite result that same morning and had to retract it.

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
  (`papercup-release`, `main`). 

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

  **Write and iterate at that `.DRAFT` path, not the bare `.sql` name**: the runner only applies files matching `*.sql`, so a `.DRAFT` file is invisible to boot auto-apply / `db:migrate` / the green-checkpoint preflight while you edit it — including a deliberate temporary both-ways guard-test mutation, which otherwise races the operator's auto-apply and can execute half-finished SQL against the live DB. When it is finished and tested, ARM it with the printed `arm_command` (`next-migration.mjs --arm <draft>`: it lints like boot, then publishes `libs/papercusp/libs/db/sql/<NNN>-…sql`, ≥107) — never a hand `mv`, which skips the lint (WI-10006549). Then run `node libs/papercusp/libs/db/scripts/pull-schema.mjs`. Never an `ensureXxx()` / inline `CREATE TABLE`. `000-baseline.sql` is frozen/generated.
- **Never hardcode `localhost:5432`** — resolve via `getHarnessAdminUrl()`. Embedded-pg is the ship target; the dev box runs native PG on `:5432`.
- **Reading PG-canonical state? Query PG — don't dump-and-jq a projection.** Plans, work-items, issues, observations (`engineer_issues`), `tool_invocations`, scorecards and recipes live in Postgres; the `*:list` tools and `docs/plans/*.md` files are *projections*. `dev:pg_query` is for **genuinely ad-hoc / analytic** reads (a one-off group-by, join, or recency slice you won't repeat). A HOT read with a stable shape belongs behind a TOOL that wraps the canonical SQL so it can't drift — "what's claimable" is `work_items:claimable`, NOT a raw floor query.


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


⚠ **A hand-written population query over `harness_shared.work_items` is mostly OBSERVATION LANE — the tools exclude it by default and raw SQL does not.** `work_items:list` / `:search` / `:claimable` all default `includeObservations:false`, because a `lane='observation'` row is an agent's turn-end reflection (never claimable, never triaged). Raw SQL has no such default, so `SELECT … FROM work_items WHERE <predicate>` answers about a different population than every tool you would compare it against. Add `AND lane IS DISTINCT FROM 'observation'` whenever you mean WORK, and say which population a count describes.

A title/prose regex compounds it — it cannot tell an item that EXECUTES a reference from one that merely CITES it.


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


The tool call is also cheaper: a structured result, no subprocess, nothing to
re-parse. When a row's caveat applies (a `tail -f` follow, a non-operator database,
a `\du`), the bash form is the right answer — the gate will not fight you on those.

⚠ **No papercusp tools AT ALL? READ THE REFUSAL — three classes, three different doors.**

- **TRANSPORT** — no tools listed; the handshake never completed (`:9071` starves
  new handshakes under load). Pass your OWN `--client`, or writes land under an
  anonymous `mcp-call-*` (EI-8509):
  `node scripts/mcp-call.mjs <server:verb> --json-file <args.json> --client <your-su-id> --port 3170`
- **DISCONNECTED** — tools worked, then calls return `ECONNREFUSED` or `MCP server
  papercusp-su is not connected`. Neither proves a restart.
  `mcp-call`'s refusal means its process could not connect before sending the
  request; another runtime may reach the endpoint. Probe in the same environment;
  once its `/api/health` answers, retry the original failed Papercup tool call.
  Re-dial is inconsistent (EI-24755204180385597); no human `/mcp`
  (EI-24657708696146012). Omit `--port` unless pinning; defaults try configured,
  canonical, and proxy ports. Flush checkpoints and request compaction via
  `mcp-call.mjs`.
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


## `cd` outside the repo tree does NOT persist across Bash calls — a failed one silently falls back to the repo ROOT

**The Bash tool's own description says "the working directory persists between commands" — that is only true while you stay INSIDE this repo tree.** `cd /tmp/some-scratch-dir` succeeds and holds for the REST of that one call, but the *next* Bash call starts back at this repo's root, with a post-hoc `Shell cwd was reset to <repo root>` note on the PRIOR call's result — no warning before it runs, just after. A `cd` to a path still *inside* the tree genuinely persists across calls. The boundary is exactly "inside vs. outside this tree", not "cd never persists".

⚠ **The in-tree half is NOT the benign one — a persisted in-tree cwd changes which `package.json` a later ROOT `npm run <script>` resolves against.** npm walks up to the NEAREST enclosing workspace, so after a `cd packages/<pkg>/…` the root commands this guide prescribes — `test:affected`, `install:safe`, `doctor`, `gen:*`, `docs:rebuild`, `set-doc-part` — die with `npm error location …/packages/<pkg>` and `Missing script: "<name>"`. **The trap is the READING, not the error**: "Missing script" invites *"that script does not exist"* when the truth is *"wrong directory, and NOTHING was measured"* — so an agent mid-verification moves on believing it verified something.


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


⚠ **Never wait on a process-table pattern you typed yourself.** `until ! pgrep -f '<pat>'; do sleep 5; done` can NEVER exit from an agent shell: `pgrep -f` matches the FULL command line, and your own `bash -c` argv contains the literal pattern, so the poll matches ITSELF and the condition stays true forever — the same self-match class as the documented `pkill -f` trap. `ps … | grep <pat>` loop conditions share the defect, and `grep -v grep` does NOT save you (the `bash -c` wrapper still matches). The PreToolUse gate now denies the loop form. Wait on the PID instead (`tail --pid=<pid> -f /dev/null`, or `kill -0 <pid>` in the loop) — or, if you genuinely must pattern-poll, bracket the first character so the pattern cannot match its own argv: `pgrep -f '[l]int-tsc'`.

⚠ **The same self-match trap applies across SSH.** In `ssh host 'for p in $(pgrep -f "DISPLAY=:111"); do sudo kill "$p"; done; <rest>'`, the remote shell's argv contains the literal pattern, so `pgrep -f` can match and kill that shell. SSH then reports the generic `exit 255` with no output, and every later command is silently skipped, leaving the remote host partially torn down. Bracket the first character (`pgrep -f '[D]ISPLAY=:111'`) or resolve PIDs by another identity, and keep the remote script single-quoted so the local shell cannot expand `$p` or other variables before SSH receives it. Treat `exit 255` with no output as a possible remote self-kill, not automatically as a network or authentication failure.


✅ **The purpose-built tool for a managed task is `processes:list { live:true }`.** For a host-visible shell, `node scripts/proc-guard.mjs check <pattern>` walks the CALLER's own ancestor chain and excludes every pid in it before matching, so it cannot self-match no matter where the pattern appears in your command (the pgrep argument, an `echo` label, a comment, an `ls` path). For `green-checkpoint`, it also recognizes gate-owned identity markers (`GREEN_CHECKPOINT=1` together with `PC_HEAVY_RELEASE_GATE=1`) and the checkpoint systemd cgroup. Other patterns remain operational-argv matches, and a peer's prose or JSON payload is ignored.

`capability:bash` can run in a separate PID namespace with only its own processes. There `proc-guard` exits 2 with an explicit visibility error; a zero match from `pgrep` or a missing `/proc/<pid>` through that door says nothing about host liveness. Bracketing a `pgrep` pattern does not prevent self-matching when the literal also appears in a shell label, comment, or heredoc carried in the wrapper argv. Use `processes:list { live:true }` for managed work, or a verified host-visible tool for a whole-host census.


⚠ **Three `find` traps on this box, all of which return a CONFIDENT, WELL-FORMED EMPTY result.**

**1. Timestamps.** `find` here is **bfs 4.1.1**. With `-newermt` it REJECTS human-relative values (`12 minutes ago`, `-10 minutes`, `America/New_York`) and can SILENTLY mis-parse absolute ones (`2026-08-28 18:35:00 UTC`), under-reporting by hundreds of times. With stderr hidden, either case looks like a valid "nothing changed". For "files modified since T" use `git status --porcelain` or `TZ=UTC stat -c '%y %n' <paths>`; if you must use `find`, pass an epoch predicate (`@<unix-seconds>`) or an ISO-8601 timestamp with `Z`/a numeric offset, keep stderr visible, and corroborate with a positive control.

**2. Symlinked sibling hives are SKIPPED.** Some "checkouts" under `~/papercupai-workspace/` (e.g. `sidestage`) are symlinks into `~/.papercusp/hives/`, and `find` does not descend a symlinked directory without `-L`. A workspace-wide `find -name '<file>'` silently omitted `sidestage`'s copy. For any cross-checkout search prefer `git ls-files` / `grep -rl`.

**3. ⛔ But NEVER an UNBOUNDED `find -L` over a broad root** (`~`, `~/.papercusp`, `~/.papercusp/hives`, `~/papercupai-workspace`). Those roots reach ~50 checkouts whose `node_modules/@papercusp/*` symlink back into workspace packages, and bfs expands that DAG without bound — it never finishes and never errors. One such call ran 32 h and made the owner's desktop unusable (WI-10000836). The bash gate now DENIES `-L`/`-follow` from those roots unless bounded: `find -L <root> -maxdepth 6 -name node_modules -prune -o -name '<file>' -print`.

**The general rule behind all three: AN ABSENCE CLAIM NEEDS A POSITIVE CONTROL.** Before reporting "X does not exist", run the same search for something you KNOW is in that haystack. If the control also comes back empty, the instrument is broken, not the subject.


⚠⚠ **`pgrep -q` DOES NOT EXIST on this box** (procps here has no `-q`), and this one
fails via the EXIT CODE rather than a spurious match, so bracketing cannot help.
`pgrep -qf X && echo ALIVE || echo gone` prints **`gone`** on the usage error — a
well-formed answer to the question you asked, while the process is very much alive
(measured: it printed `gone` while `pgrep -cf` returned **13**). The natural next
action is to conclude the job died and re-run it. Use `proc-guard` above, `pgrep -cf`
(count), `pgrep -x <name>` (matches the process NAME, so argv cannot fool it at all),
or `kill -0 <pid>` (EI-19446554284039165).


⚠⚠ **The same self-match trap exists in SQL, and the bracket fix does NOT transfer.** A `pg_stat_activity` probe filtered by `query LIKE '%pattern%'` **matches its own backend**: `query` holds the currently-executing statement, and yours contains the pattern in its own `WHERE` clause. So it reports a hit whether or not the process you are hunting exists — measured, a marker string present in no real query anywhere returned exactly one row, the probing backend itself. ⛔ Bracketing (`'%[p]attern%'`) is a **grep** character class, not a SQL one (that is SQL Server); Postgres matches `[p]attern` literally, your statement still contains it verbatim, and it **still self-matches** — so the habit above fails here while looking like it was applied. Exclude yourself explicitly with `AND pid <> pg_backend_pid()`, or use **`dev:pg_active_queries`**, which takes no pattern and already excludes itself.


> ⚠ `pgrep -x` matches `/proc/<pid>/comm`, which the kernel truncates to **15
> chars**, so a longer binary name never matches. 

✅ **"Is this process actually DOING WORK right now?" — a two-sample delta over the
process's CGROUP, never a single-shot reading and never a hand-walked tree.** Every
single-shot probe answers a *different* question and fails toward a false "idle":
`ps -o %cpu` is a process-LIFETIME average, and a first-iteration sampler has no prior
sample to difference against. CPU usage *is* a delta; ask for one.


The runnable recipe, and the two `/proc` methods that each report a confident FALSE IDLE on a
process burning a full core:
[is this process actually doing work?](/internal/docs/agent-insights/is-this-process-actually-doing-work).


⚠ **Measure the whole PROCESS TREE, not the pid you were handed** — a `MainPID` is often a wrapper sitting at `utime=0` while a child burns a full core.


⚠ Corollary: **a liveness beat emitted BY the process being judged cannot report main-thread saturation** — a saturated Node main thread stops every `setInterval` while looking perfectly asynchronous. Observe from OUTSIDE (`/proc`).


Treat `top -n1` as usable here; the two-sample `/proc` recipe is still the one to reach for, because it needs no column-index guess (`%CPU` is field **9** in `-H` output, not 8 — field 8 is the state column, and misreading it yields a whole column of `S` that looks like data).

## Feature flags + PostHog

**Feature flags have one source:** `libs/flags/src/types.ts`; flip them via `/admin/features`, never JSON/PostHog directly or an ad-hoc env boolean. New flags default enabled: finished work must set the code default ON and verify it live in the same task—an override-only flip or "owner later" is unfinished. Default-OFF is only for incomplete/unsafe code, owner-authority/security/destructive surfaces, or an attended cutover kill-switch. Put every exception in `KNOWN_DARK_FLAGS` with justification and `DARK_FLAGS_REVIEW_BY`, and surface it in plan `## Now` plus completion. Reversibility is a reason to verify ON, not ship dead code.


⛔ **The dark allowlist is SHRINK-ONLY — never reconstruct or grow it, and never build a parallel one.** `KNOWN_DARK_FLAGS` exists ONLY to express the small set of genuinely-not-ready exceptions above (incomplete code / would-break-the-running-fleet / owner-authority / staged-cutover) — it is **NOT a parking lot for finished work**. `DarkCase` splits the set into two populations governed differently: the `DARK_FLAGS_HIGH_WATERMARK` size ceiling in `libs/flags/src/types.ts` (imported by `production-defaults.test.ts`) governs ONLY the **`parked`/`incomplete`** subset (`DARK_FLAGS_PARKING_COUNT`) — the actual parking-lot abuse; it **fails the build if THAT subset grows**, not the aggregate `DARK_FLAGS.size`. `owner-authority` / `cutover` entries (permanent or staged safety kill-switches) are **not rationed** by the watermark at all — they are governed only by the `DARK_FLAGS_REVIEW_BY` re-review date, so a legitimate new safety flag never has to fight a parking-lot budget. So: flipping a `parked`/`incomplete` flag ON *removes* its allowlist entry (the parking subset shrinks ✓); shipping a NEW genuinely-incomplete flag dark requires first **graduating an existing parked/incomplete dark flag** to make room (net-zero) or **explicit owner sign-off** to raise the watermark — never a quiet append. **Do NOT route around this guard** by re-introducing a second dark allowlist, a per-flag `process.env.PAPERCUSP_*` gate, a `darkReason` side-table, or any other parking-lot for finished-but-scary work: the temptation to park it dark "to verify later" is *exactly* the abuse this exists to stop — flipping it on and watching it work IS the task.

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


⚠⚠ **A BARE `npm run lint:tsc` typechecks `packages/operator-core` ONLY** — it is a single
`tsc -p packages/operator-core/tsconfig.json` (`scripts/lint-tsc.mjs`), so a clean bare run says
NOTHING about an edit anywhere else, and grepping its output for your paths finds nothing because
they were never compiled. **Always pass `--files=<the files you edited>`** — that form ROUTES each
path to the baseline-gated leg that OWNS it (`apps/operator` → `lint:tsc:operator`, plus
`:operator-vite`, `:orchestrator`, `:papercusp-libs`, `:scripts`, `:workspaces`). A `--files` set
lying entirely outside operator-core RUNS the owning leg for you (`status=routed`); a MIXED set
compiles only the in-scope files (`status=partial filesUnchecked=N`) and prints the exact command
for the rest. Read the `LINT_TSC_RESULT status=`, not just the exit code — `partial` is not `clean`.


**The trigger to watch: adding a REQUIRED field to a shared interface** (or renaming
/ re-typing one). 

**Don't do that by hand — `npm run lint:required-field-strands`** AST-diffs your change against `HEAD` and names every exported type that gained a required field, nested paths included. It also catches a field TIGHTENED from optional to required, which strands sites just as hard. It is ADVISORY by design — adding a required field is usually correct, so the mere addition is never a failure; `--typecheck` runs `lint:tsc` and exits non-zero only on real stranded sites. Finding the sites was never the hard part — `tsc` already does that perfectly; the gap this closes is *knowing to run it*. ⚠ Do NOT "fix" the errors by making the new field optional: that silently reintroduces whatever under-reporting the required field was added to prevent.

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


**A migration that ADDS a column to a `harness_shared` table can silently strand a
sibling `*.integration.test.ts` fixture** that hand-rolls that same table via an inline
`CREATE TABLE` instead of applying real migrations — the fixture used to be
schema-complete for every column it named and quietly falls one behind, and
`test:affected` won't select the stale file (your migration's diff never touches it).


Schema/migration edits (`libs/papercusp/libs/db/**`) → `npm run
test:integration-only` (integration suites only; the graph won't catch them).
Don't run `npm run test:all` for routine edits. Each app/lib ships a `TESTING.md` — read it
before adding tests. Infra (Vitest 4, testcontainers PG, Docker required, CI,
property tests, knip, quarantine, secrets):
[repo-conventions § test infrastructure](/internal/docs/system/repo-conventions).


**npm only — never `pnpm`/`yarn` in this repo, even for a single-package test
run.** This is an **npm workspaces** monorepo (root `package.json`'s
`preinstall` runs `only-allow npm`); there is no `pnpm-workspace.yaml`. 

```bash
npm run test:file -- path/to/one.test.ts path/to/two.integration.test.ts
```

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

A mutation probe that mutates the shared tree can be committed by the sweep even when nothing goes wrong and no handler fails. `git status` cannot warn you either: on a swept tree a clean status means the sweep ran, not that the file is unmodified.

**Pick the lowest tier that fits — only the last row's in-tree mutation dirties the tree:**

| your subject | how to prove falsifiability |
|---|---|
| a subject (or `--test` cmd) containing DESTRUCTIVE primitives (rm/rmdir/unlink/shred/truncate/mkfs/`dd of=`/`find -delete`) | **TIER-0: `--fake-destructive`** — PATH shims log each destructive call's argv and delete NOTHING; assert on what the code WOULD delete. The probe REFUSES such a subject without it; REAL execution needs `--i-know-this-deletes --sandbox-root <dir>` (bwrap, `/` read-only). Limit: PATH interception only — an absolute-path `/bin/rm` call needs the sandbox. |
| a MODULE / logic you `import` | Keep a deliberately-wrong implementation **permanently in the test file** as a control (plus a calibration case the REAL subject must pass, or the controls also pass when the property itself is broken). Never mutate production code. |
| a guard whose subject is the SOURCE TREE itself (it greps/walks files and asserts over their text) | ⚠ The control fixture lives INSIDE the subject, so a plainly-spelled fixture **SELF-MATCHES** — the `pgrep -f` trap in static form. It fails loud (a false positive), but a guard red forever gets deleted or weakened. **Strip before matching** with `stripCommentsAndStrings` (`scripts/lib/strip-comments-and-strings.mjs`, offset-preserving), or exclude the fixture's path, and **assert the fixture is STILL detector-shaped** so the control can never pass VACUOUSLY. ⚠ Don't strip where real tokens live inside literals (`DROP DATABASE` in a SQL template): that flips a true positive into a silent false NEGATIVE — decide per call site. |
| a FILE artifact the test reads by path (shell scripts, config, generated output) | Mutate a **COPY** outside the tree and point the test at it — zero window, no lock, no trap. Make the test's subject path overridable (an env var defaulting to the real path); that one line is what makes tier 2 available at all. |
| a guard whose pre-fix source is already in Git history | **HISTORICAL MODE:** use `--against-commit <sha> --must-be-absent <literal>` or `--against-last-without <literal>`. The probe freezes current and historical snapshots before either run, requires `--positive-control <literal>` for every token the assertions index, and requires a `--calibration` command that passes on both snapshots. |
| genuinely unavoidable in-tree mutation | Last resort. Hold the sweep for the probe's duration AND restore from a trap (see below). |


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
3. **Add `guidance: { when, notWhen?, chaining?, byRole? }`** 

   > It is a ROOT entrypoint that queues behind `scripts/pc-heavy.sh`, which is
   > what makes it runnable when you actually need it. To measure ONE tool
   > instead — seconds, no pc-heavy queue — **`npm run tool-weight -- <tool>`**
   > (`--json`; `--all` for the catalog). It prints the total AND the per-field
   > split (`description · when · notWhen · chaining · byRole`), so you cut the
   > field that is actually heavy instead of eyeballing it — the heavy one is
   > routinely `chaining`, not `description`.


> **Editing a live tool counts too.** In practice nearly every prompt-weight gate
> red has come from *growing* an existing tool's `description`/`guidance`, not from
> adding a new one — and an editor never reads an "Adding a tool" section, so the
> breach lands committed and freezes the fleet gate hours later. 

Per-tool when/not-when goes on the tool; cross-tool patterns in
`<role>.tools.md`; behavior rules in `<role>.persona.md`. The split is
intentional — see `packages/operator-core/lib/prompt-assembly.ts`.

⚠ **A caller's `limit` bounds ROW LISTS ONLY — never an aggregate. If a count is
computed over a capped fetch, the RESULT must say so ON THE AGGREGATE.** Marking
only the row list is not enough: the aggregate is what gets read as a verdict, and
a bounded measurement rendered as a confident number is indistinguishable from a
real zero. 

The fix pattern, both halves: pin the census fetch independently of the caller's
`limit` (`censusLimit`), and expose a boundedness marker beside the counts
(`truncatedByLimit`) so a floor is never read as a total. **Guard it behaviourally,
not by field name** 

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
