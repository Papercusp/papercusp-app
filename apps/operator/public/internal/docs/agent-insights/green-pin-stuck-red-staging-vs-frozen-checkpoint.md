# Green pin stuck? Red staging vs a frozen checkpoint (+ the MCP-down PG fallback)
URL: /internal/docs/agent-insights/green-pin-stuck-red-staging-vs-frozen-checkpoint

`origin/main` not advancing for hours usually means staging is RED and the green-checkpoint is correctly holding — NOT a frozen routine. How to tell them apart from checkpoint-logs + coord_event_log, and how to diagnose it all via direct PG when the papercusp-su MCP is down.

## What

Symptom: `origin/main` hasn't advanced in hours while `origin/staging` keeps
moving (git-sync auto-commits) and the staging→main **buffer grows**. Your
change (and everyone else's) is stuck "in staging," not reaching the deployable
green pin.

The instinct is "the green-checkpoint / routine engine froze again." **Usually
it didn't.** Far more often staging is simply **RED** — one peer's broken commit
among the \~70-agent WIP stream — and the gate is *correctly* refusing to advance
`main` onto a non-green candidate. The gate working is indistinguishable from the
gate frozen if you only look at `git log origin/main`.

## Tell them apart (2 minutes, no MCP needed)

1. **Did the checkpoint actually RUN?** The real pipeline runs write a log named
   for the candidate's *real* base sha (test runs use `base-none` / `base-base-sha`):

   ```bash
   ls -t ~/.papercusp/checkpoint-logs/ | grep -vE 'base-none|base-base-sha' | head
   # e.g. 2026-06-20T04-20-45-696Z-base-f9464a9fcd34.log   <- ran 04:20, base = current main
   ```

   A recent real-sha log whose base == current `main` HEAD means the gate ran and
   **chose not to advance** → staging was red. No recent real-sha log at all → the
   routine may genuinely be stalled (then it's su-67d39 self-healing / the routine
   engine's lane, not yours).

2. **What was red?** The log's tail carries the de-noised failing tail; grep it:

   ```bash
   grep -nE 'FAIL |>>> .* FAILED|non-quarantined task|SPA BUILD FAILED|Unhandled' <log> | head
   ```

   Then reproduce just that workspace's tests on the current tree —
   `npm run test --workspace=@papercusp/<pkg> -- <file>` — a peer may have already
   fixed it on a newer staging commit (the logged run used the *older* base sha).

3. **Was it surfaced?** The gate opens a durable `release-not-green` escalation to
   `human` on every hold and resolves it ("gate green") on recovery — so a held pin
   is NOT silent. Confirm in `coord_event_log` (PG):

   ```sql
   select id, left(body::text, 200) from harness_shared.coord_event_log
   where surface='escalations'
     and (body::text ilike '%green-checkpoint%' or body::text ilike '%not green%')
   order by id desc limit 8;
   ```

## The MCP-down fallback (this is the load-bearing bit)

When the `papercusp-su` MCP is disconnected you lose plans/coord/work\_items — but
**direct Postgres still works** and answers every question above:

```bash
PGPASSWORD=harness_admin_pwd psql -h localhost -p 5432 -U harness_admin -d papercusp -tAc "<query>"
```

Useful reads: `harness_shared.coord_event_log` (escalations + messages),
`harness_shared.routines` (is the green-checkpoint routine `active` / its
`last_fired_at` / `consecutive_errors`). The operator `:3070` being healthy (200)
while the MCP is dead means it's a *client-side* disconnect, not a backend outage —
the DB and the pipeline keep running; only your MCP tools are gone.

## Resolution

Almost always: **nothing to do but confirm.** A peer's red is transient; once a
newer staging commit fixes it, the *next* checkpoint run advances `main` and
resolves the escalation automatically. Verify the previously-red workspaces pass
on the current tree, confirm the escalation exists (the system surfaced it), and
let the gate promote on its next tick. Only escalate to the routine-engine owners
if step 1 shows **no recent real-sha checkpoint run at all** (genuine freeze).

## Don't

* Don't conclude "frozen routine" from `git log origin/main` alone.
* Don't hand-force a promotion to `main` — `advanceReady` is FF-only and the gate's
  whole job is to refuse a red candidate. Forcing it ships red to the deployable pin.
* Don't re-fix a red you found in an old checkpoint log without first reproducing it
  on the current tree — it's often already fixed upstream of where the log ran.
