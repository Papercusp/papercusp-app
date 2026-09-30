## Git — a background routine owns commit + push

A background routine commits the whole shared tree and pushes on a schedule. **You do not
`git add` / `commit` / `push`, ever** — just leave your work in the tree; it lands on the
remote within minutes. Don't stash, branch, or scope pathspecs to isolate "your" diff;
don't switch branches or create worktrees. Coordinate through locks + coord, not tree
isolation. Merge conflicts go to a resolver, not you.

**Edit ONLY the canonical `staging` main tree — never inside any other git worktree.**
The auto-commit routine commits the `staging` main tree alone; an edit made in a sibling
worktree (`papercup-staging`, `-release`, `-checkpoint`, an old feature worktree, …) is
invisible to it and **silently stranded** — never committed, never deployed. (A whole
feature was lost this way on 2026-06-30.) A `PreToolUse` guard now **blocks** any edit
whose file resolves to a non-canonical worktree, so a stray edit fails fast with a pointer
back to the staging tree. The one exception is the migration/synthesis roles' own
isolation worktrees under `.papercusp/worktrees/`, assigned to you on purpose. If an edit
is refused, run `git rev-parse --show-toplevel` — you are not in the staging tree; `cd`
there and redo it.

## Engineering discipline

- **Tests ship WITH the feature**, in the project's testing framework — not an ad-hoc
  script. A passing typecheck is not a test. Don't claim done without verification.
- **A red release/CI gate has exactly ONE fixer — READ OWNERSHIP BEFORE YOU ACT.**
  **Scope this exclusivity to `LIVE_GATE_OPS` only.** `LIVE_GATE_OPS` means work coupled to the
  current verdict or its live control plane: firing/re-running a checkpoint, deploy/force actions,
  current-red triage, repair-queue mutation, or monitoring the current run. FIRST call
  `state:read { cell: 'gate.greenCheckpoint.ownership' }`. **Held by a live agent ⇒ you are DONE
  with `LIVE_GATE_OPS`, not with every gate-related task:** send useful live-gate evidence once
  (`coord:send`), then STOP THAT LANE — do not claim the live gate item, arm a fallback monitor,
  or read gate status again this session.

  This ownership does **not** reserve `GATE_SYSTEM_DEV`: independently registered source work such
  as cache logic, instrumentation, test selection, retention/GC, alerting, tests, docs, and
  refactors continues under its own work-item/plan lane and file locks. If that development needs
  current-run evidence, request it once from the live gate owner and continue every preparatory or
  independent step; end the whole task only when every remaining step genuinely depends on that
  live result. A second agent on a held `LIVE_GATE_OPS` lane is waste, not diligence: measured
  2026-08-26, 37 distinct agents took 97 stints on ONE gate item. ⚠ That cell can UNDER-report a
  hold (EI-21456707280493029) — a `claimable` reading plus a
  refused claim means HELD, so believe the refusal, not the cell. ONLY when ownership is genuinely
  unheld is greening it YOURS: claim it, find the ACTUAL failing tests (query the test-run ledger,
  don't guess) and FIX them — even out of your lane, even in another agent's in-flight files, even
  when the fix is in shared config that affects the whole fleet. A gate is shared infrastructure;
  "those reds aren't mine" is not an excuse for leaving an UNOWNED gate red. Diagnose the ROOT cause first (one shared
  misconfiguration often red-pins a whole class of tests — fixing it greens them all at once),
  fix it durably, and verify the reds go green locally before claiming it. **Fixing the code is
  not the same as greening the gate — do not conflate them.** The gate is a PERIODIC full-suite
  VERDICT, not a live reaction to your commit: after your fix lands the gate stays red until
  the verdict RE-RUNS. So getting your change live is THREE separate hops, each with its own lever —
  (1) COMMIT the fix (the auto-commit routine; force it if it's lagging), (2) RE-RUN THE VERDICT
  (fire it now; don't wait for the periodic tick to re-evaluate), (3) SHIP the now-green result
  (expedite the deploy). Assuming a code fix auto-greens the gate, or conflating "re-run the
  verdict" with "deploy the result", is precisely why an agent fixes the reds and then stalls
  staring at a still-red gate. (Your project's docs/tool descriptions name the concrete lever
  for each hop.) Force-deploying PAST a red gate is the
  LAST resort: it ships known-broken code and needs explicit OWNER sign-off — never your first
  move, and never a substitute for greening. Hand-quarantine a test ONLY when it is
  CONFIRMED-unrelated, you can't fix it quickly, AND you file an accountable de-quarantine
  follow-up. Never silently wait on a red gate, and never report "gate green" / "shipped" when
  the gate is still red or your code never deployed — verify against the gate, not your intent.
- **In alpha, timidity is the failure mode, not breakage** — but this bias governs HOW you
  execute *once the owner has approved the plan and chosen the route* (or while AUTO mode is
  ON), NOT whether to start (see "Default posture" above). When the right fix is a
  breaking change, make it now, in full; prefer a maintained library or an existing
  internal surface over rolling your own. Ship features flag-ON by default. Default-OFF
  is only for the dangerous set — irreversible migration, outward-facing publish/send,
  fleet-autonomy escalation, auth/security, or a kill-switch — and only when registered
  (with a reason) in the dark-flags registry. A routine feature behind a dark flag nobody
  flips is an unfinished ship; a feature isn't done if it's gated behind an unregistered
  default-OFF flag. Tell the owner what changed; don't ask permission to do it right.
- **Reuse-first (extend, don't fork).** Before introducing a new durable surface — a
  table, tool/verb, service, cron/routine, config key, abstraction, or parallel
  "system" — first look for an existing one to extend (`search:semantic`, the docs,
  gitnexus, repomix) and prefer the smallest extension over a new parallel one; most
  "I need a new X" is really "one more field/case/option on an existing X." When you
  DO add a new durable surface, briefly note what you reused or why nothing fit. A new
  system that duplicates an existing surface is a top review smell.
- **ANY new app starts from a papercusp app template — never a hand-rolled scaffold.**
  Templates are NOT only for apps that embed agents. There are two KINDS, and
  `templates:list` reports which each one is via its `scope` field: **app-scope** roots
  (a whole app is materialized FROM one) and **aspect** templates that COMPOSE on top
  of a root (the desktop shell, the UI kit, the data layer, the agent/pot plane, …).
  ⚠ **Do not carry a memorized list of template names — read `templates:list`.** The
  live set changes, and a hardcoded roster in a prompt rots silently: as of 2026-08-31
  this text named three app roots (`papercusp-webapp`, `papercusp-desktop-app`,
  `papercusp-agentic-desktop-app`) that **did not exist in the registry at all**, so an
  agent following it would have asked the owner to choose between three templates none
  of which could be materialized. Name the roots the registry actually returns.
  When the ask is "create/build an app"
  in ANY form: (1) pick the app-scope root matching the shape — and when the shape is
  ambiguous (web vs desktop, agents vs not), ASK the owner which root applies BEFORE
  scaffolding, never assume. FRAME that ask so the owner knows what they're choosing:
  name the options as Papercusp app templates and give the one-line gloss (a template =
  a maintained, pre-built app scaffold — chassis, data layer, conventions — that the
  new app is materialized from, instead of scaffolding from scratch), and ALWAYS
  include the opt-out option "No template — I'll specify the framework myself." The
  owner picking the opt-out IS this mandate's stated-justification — the ban is on
  SILENTLY hand-rolling, never on an owner-chosen stack: follow up for the framework
  they want, record the choice on the work-item/plan, then scaffold it by hand. (Under
  AUTO mode there is no ask — pick the root by judgment and disclose; the opt-out
  belongs to the ask flow only.) (2) materialize via the template verbs — `templates:list`
  (see what exists) → `templates:get-guide` → `templates:new-app` (materializes into a
  new harness and kicks off a builder seeded with the GUIDE); the Cupboard HTTP routes
  (`POST /api/cupboard/install-template` → `/api/cupboard/materialize-template`) are the
  underlying mechanism if the verbs are unavailable — then open the materialized
  PROTOCOL.md + GUIDE.md as the building agent's launch context. When agents ARE
  embedded, the judgment plane crosses into the app at exactly ONE typed seam
  (`papercusp-ops-pots`). Hand-rolling an app scaffold — or a bespoke agent
  orchestration loop — when a template covers the shape is the reuse-first smell above.
  Deviating requires saying explicitly WHY no template fits, to the owner, BEFORE you
  scaffold; starting an app with neither a materialized template nor that stated
  justification is non-compliance.

### The papercusp-way routing gate (intent → mechanism)

The platform has a purpose-built mechanism for each recurring intent below. When a
request matches a trigger row, NAME the mechanism to the owner before acting: AUTO mode
OFF → ASK ("want the papercusp way — <mechanism>?") and wait; AUTO mode ON → USE it and
disclose that you did. In either mode, deviating from a matching row requires stating
WHY the mechanism doesn't fit BEFORE proceeding — silently hand-rolling past a matching
row is non-compliance. New platform surfaces add a ROW here, not a new section.

| when the ask sounds like | the papercusp way |
|---|---|
| "do X daily / weekly / on a schedule" | `plans:set-schedule` (authors the recurrence on a plan) THEN `plans:arm-schedule` — arming is a separate, autonomy-gated step; an unarmed schedule never fires. (`routines:set` is NOT this — it only retunes/pauses SYSTEM routines.) |
| "watch for Y / alert me when Z" | `watch:create` — the unified subscription primitive; `events:await { event, timeout_sec, on_timeout:'wake' }` is the one-shot wake preset (do not pass retired `wake`/`once` keys), and ambient topic interest is `watch:create { targetKind:"topic", wake:false }` directly (the `topics:subscribe` preset was retired 2026-08-09 for zero use). wake:false = cheap inbox inject; `events:await` costs a turn. Patterns are EXACT-match: if `events:catalog` has no key for the condition, say so and fall back to the schedule row (scheduled poll+diff against a watermark fact). |
| "keep working on this continuously" (solo, non-fleet) | `loop:arm` — tracked (`loop:status`), stoppable (`loop:end`), auto-claims its driving work-item. Never a self-rolled keep-alive. |
| user hands you a credential / API key | `setup:save_key` ONLY for the 4 platform provider keys (openai / anthropic / zeroentropy / github_pat). ANY other secret: never into a tree file — injected config outside the repo. |
| "before we migrate / risky or destructive data change" | `backup:snapshot_create` — snapshot before the destructive op; returns an id you can self-restore from (`backup:restore`). |
| "new agent role / persona / behavior" | `blueprint:catalog` (find the parent) → `blueprint:extend` (validated child override) — never a hand-rolled prompt file. |
| "bring this repo under management" | A FORK — ask which: `pot:create_from_repo` (GitHub URL → full pot; dedupes to a join offer if one exists) vs `harness:generate-from-repo` (existing local repo → coding harness; detects and runs the test command once; `dryRun` previews). |
| "design this screen / component" | `design-phase.search_registry` FIRST (pick from existing registry components instead of inventing) → spec → `design-phase.validate_spec` / `design-phase.lint_spec`. |
| repeated multi-step tool orchestration | `recipes:search` before composing by hand — `code:run` auto-captures recipes; search surfaces them. |
| "create/build an app" (any form) | `templates:list` → `templates:get-guide` → `templates:new-app` — the templates mandate above is this row's full rule (3 app-scope roots, presented AS Papercusp templates with the one-line gloss + the always-offered "No template — I'll specify the framework myself" opt-out; ask when the shape is ambiguous). |

