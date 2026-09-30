# Driving a multi-agent build: the write-capable pivot when fleet cups can't write
URL: /internal/docs/agent-insights/multi-agent-build-write-capable-pivot

The coordinator runbook for building a whole plan via spawned workers when conditions are degraded. Fleet cups may be READ-ONLY (EI-524 capability confinement) — they draft, they can't write; the 'lift' can be announced-but-not-effective. Org-wide API rate-limiting kills parallel agent BURSTS but serial main-loop work survives. Pivot to write-capable Agent (Task) subagents + serial; place waves at ≤3 concurrency; ALWAYS verify cup/subagent drafts before applying.

:::caution\[The `fleet:place_batch` → cups path described here is retired]
The Mug · Kettle · Cup/nursery tier was **retired 2026-08-09**
([canonical account](/internal/docs/agent-insights/mug-kettle-cup-tier-is-retired)):
`fleet:place_batch` and `cup:spawn` **refuse**, and no `system:cup` can be spawned. The
live equivalent of "decompose the plan into lanes and fan agents onto it" is
**`fleet:launch-on-plan`**. Kept for the write-capability reasoning, which still applies to
fleet members.
:::

## Current behavior (2026-07-03)

**Wall 1 below is CLOSED — fleet cups are now write+bash capable, not
read-only.** The "OWNER-PRIORITY FIX (2026-06-15)" (`cup-capability-expansion
-2026-06-08` D-005/P-004) granted `capability:fs-write` + `capability:bash` (plus
`fs-read` / `git` / `net` / `code-inspect`) to the `cup` role principal in
`role-principal-caps.ts`, closing the "two-gate desync" this doc's Wall 1
describes (the ENVELOPE-layer deny had been lifted, but the principal
CAPABILITY grant lagged — cups still 100%-failed with `lacks capability
'capability:fs-write'` until this landed). A `system:cup` today CAN `Edit` /
`Write` / run bash directly — do **not** assume a cup report of "read-only" is
still the EI-524 confinement; verify against `role-principal-caps.ts`'s current
`cup: [...]` grant list (and `cup-tool-boundary.test.ts`) before re-diagnosing
it as Wall 1. See `agent-spawning/allowlist-and-caps.mdx` for the current,
maintained capability/allowlist model.

**Everything past Wall 1 — Wall 2 (rate-limit bursts), verify-before-apply,
migration safety, and the monitor loop — is still generically useful runbook
knowledge** for a degraded/high-load build (a cup CAN now write, but a
genuinely capability-confined or otherwise-blocked agent still benefits from
the write-capable-subagent + serial pivot). Read the body below as historical
context for *why* that pivot pattern exists, not as "cups are read-only today."

## When this applies

You are an SU coordinator driving a `ready` plan to completion by **spawning
workers** (the "assign a bunch of agents + monitor on a loop" ask). The happy
path is: decompose the plan into lanes → `fleet:place_batch` cups → flip plan
items + place the next wave as deps clear. This page is the **degraded path** —
the two infra walls that path hit in practice, and the pivots that got through.

## Wall 1 — fleet cups can be READ-ONLY (EI-524 capability confinement)

A `system:cup` spawned via `cup:spawn`/`fleet:place_batch` may lack
`capability:fs-write`. It can read, diagnose, and produce an excellent **draft**
(exact migration SQL, code diffs), but its `Edit`/`Write` fails:

> `Principal 'system:cup' lacks capability 'capability:fs-write'`

* **Detect it, don't fight it.** If a cup reports the fs-write error (or two of
  them do), stop re-placing cups into the same wall.
* **A capability "lift" can be announced-but-not-effective.** A broadcast that
  "cups are now write+exec capable" did NOT immediately grant fs-write to cups
  spawned right after — the change was in-flux. **Verify empirically** (spawn one,
  watch for the error) before trusting a capability flip; multiple fleet agents
  hit the same wall after the "lift."
* The working fleet pattern while cups are read-only: **cup drafts → a
  write-capable actor verifies + applies.** But that funnels every write through
  a few write-capable SUs — a real throughput bottleneck.

## The pivot — write-capable execution

Two write-capable mechanisms the coordinator owns directly:

1. **Your own Agent (`Task`) subagents** — they inherit your full tool access, so
   they CAN `Edit`/`Write`/`Bash` + reach MCP tools. Launch with
   `run_in_background: true`; you're notified on completion (your monitor loop).
   This is the parallelism the read-only fleet can't give you.
2. **Serial main-loop work (you)** — the most reliable path; it consistently got
   through when both fleet cups and parallel subagents were blocked.

Stand the read-only cups down (`fleet:cancel` + close their work-items so the
autoloop doesn't re-place them) and re-route the lanes to subagents/serial.

## Wall 2 — org-wide API rate-limiting kills parallel BURSTS

Under heavy fleet load the Anthropic API returns
`Server is temporarily limiting requests (not your usage limit) · Rate limited`.
Observed shape: **parallel subagents die \~2 min / \~20 tool-calls in with tiny
output** (a 3-way burst is what trips it), while **serial main-loop work
survives** — the rate-limit punishes concurrency spikes, not steady single-stream
work.

* **Reduce concurrency under rate pressure.** Place waves at **≤3** write-capable
  subagents, not a big fan-out. Do the critical-path / privileged steps (DB
  migrations) **serially yourself**.
* Fleet cups route through the **rate-governor** (paced), so they degrade more
  gracefully than raw parallel Agent subagents — prefer them once the confinement
  is fixed.
* A rate-limited kill leaves **partial work**: check `git status` + a targeted
  `tsc` for an island of new files (they may be complete-but-unwired, or broken).
  A self-contained new-file island that nothing imports won't break the build —
  finish the wiring + tests serially.

## ALWAYS verify a draft before applying it

Read-only cups (and rushed subagents) produce **unverified** drafts. In one build
this caught **three real bugs** before they landed: a backfill `CROSS JOIN
harness_shared.harnesses WHERE kind='pot'` (no such table/column — pots are a
registry entry with `harness_kind='pot'`), a join on `engineer_issues.harness_slug`
(no such column — the slug is in the federation outbox jsonb, mig 197), and a
`DROP TABLE … CASCADE` rebuild where a `safe-to-truncate` cache only needed
`ADD COLUMN` + truncate + repoint-PK. **Verify every schema/table/symbol
assumption against the real files; correct, then apply + test.**

## Migration safety under a concurrent, rate-limited build

* Reserve the number with **`db:next-migration`**, never a guess — `288` was taken
  between a draft and its apply; the reserver hands out the real next number.
* **Don't `db:migrate` a coupled schema change ahead of its code deploy.** A
  `NOT NULL`/PK change that the still-deployed (green) code violates will break on
  the live DB. Write the migration file (it **boot-applies** with the code on the
  next deploy) and validate it in a **fresh testcontainer** (any integration test
  applies all migrations) instead of hand-applying to the shared dev DB.
* A **best-effort write path** (the writer wrapped in try/catch) makes a
  schema↔code split **degrade gracefully** (warn + skip) instead of breaking —
  which removes the "must land atomically" pressure during a flaky build.

## The loop

Monitor with **completion wakes** (background `Task` notifications + the cups'
`coord:send {wake:true}` on done) plus an **`events:await` heartbeat** fallback
for stalls. On each wake: flip the landed plan items (`plans:set-status`), place
the next wave as deps clear, re-`coord:declare-intent { items }` to keep your lane
visible (the claim-discipline watch nudges if you declare a plan but hold no
items). Stop placing waves when only **owner-gated** (outward-facing: live PR /
Comb publish / credentials) or genuinely-optional items remain — don't auto-cross
the outward-facing line, and don't manufacture low-value churn to satisfy a
"continue" loop.
