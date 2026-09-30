# \\\"too many clients already\\\" is a connection storm or pool overhang — diagnose it at the OS level, don't assume a DB outage
URL: /internal/docs/agent-insights/pg-connection-exhaustion-fleet-wedge

Papercusp's PG is the native cluster /var/lib/postgresql/18/main on :5432 with max_connections=100 (db harness_admin; users papercusp + papercusp_su). When it exhausts, EVERY MCP/PG call wedges fleet-wide and even a direct psql fails with FATAL 'sorry, too many clients already' — which reads like a DB outage but is almost always (1) a runaway client storming connections or (2) one operator's pool sitting near the 100 ceiling. You can diagnose + fix entirely at the OS level WITHOUT a SQL connection: count the postmaster's backends, map each :5432 socket to its owning PID with ss, find the one PID holding hundreds, and kill that subtree (or restart the offending service). On 2026-06-17 a STRAY manually-launched bin/hono-host.ts (gnome-terminal child, bound to FALLBACK ports 3071/3079/... because the standard ones were taken) was storming PG with 743 ESTAB + 355 SYN-SENT (~1000 conns); killing it unwedged the whole fleet. Separately the legit staging-api.service (:3170) alone held ~70 connections — restart it to reset its pool.

## The mistake this prevents

An agent sees `MCP error -32603: sorry, too many clients already` (or every PG-backed
tool failing, or `remaining connection slots are reserved for roles with the SUPERUSER
attribute`) and concludes the database is down / broken / needs an admin to restart — and
either gives up or reaches for a disruptive full-cluster restart. **It is almost never an
outage.** It is connection *exhaustion* — and you can find the culprit and fix it at the OS
level without ever getting a SQL connection.

## What's actually true

Papercusp's Postgres on the dev box is the **native cluster
`/var/lib/postgresql/18/main` on `:5432`**, `max_connections = 100`, db `harness_admin`,
roles `papercusp` (the app, NOT superuser) and `papercusp_su` (the MCP, superuser). The
box also runs \~18 OTHER PG clusters for unrelated self-hosted apps (bytebot, chatwoot,
vikunja, …) — ignore those; only `18/main` is Papercusp's.

Two things exhaust it:

1. **A connection storm** — a runaway client opening connections faster than it closes.
   On 2026-06-17 a **stray, manually-launched `bin/hono-host.ts`** from the canonical tree
   (a `gnome-terminal` child, not systemd-managed) couldn't bind the standard operator
   ports so it grabbed **fallback ports (3071/3079/3270/3274)** and sat there storming PG:
   **743 ESTAB + 355 SYN-SENT** (frantically opening more). One redundant process pegged
   all 100 slots and wedged the entire fleet.

2. **Pool overhang near the ceiling** — the legit `papercup-staging-api.service` (`:3170`)
   alone held **\~70 connections** (crash-loop residue after 55 restarts + warm-up growth),
   while the primary release operator (`:3070`) held a healthy \~18. With 100 total, one
   oversized pool + everything else sits right at the edge, and the next `papercusp`-role
   (non-superuser) connection gets refused — while a `papercusp_su` MCP call may still
   succeed via the superuser-reserved slots (which is why YOUR session works but the fleet
   doesn't).

## Diagnose it without SQL (the OS-level recipe)

```bash
# postmaster pid for Papercusp's cluster (lowest-PID match)
PM=$(ps -eo pid,etimes,cmd --sort=etimes | grep '[/]usr/lib/postgresql/18/bin/postgres -D /var/lib/postgresql/18/main' | head -1 | awk '{print $1}')

# backend count (against max 100; ~12 of these are bg workers)
pgrep -P "$PM" | wc -l

# which CLIENT process holds the most connections → the storm/leak shows up instantly
ss -tnp | awk '$5 ~ /:5432$/' | grep -oE 'pid=[0-9]+' | sort | uniq -c | sort -rn | head

# identify + classify the top PID: is it systemd-managed or a stray terminal child?
P=<top-pid>; tr '\0' ' ' < /proc/$P/cmdline; echo; cat /proc/$P/cgroup
ss -tnp | grep "pid=$P," | awk '{print $1}' | sort | uniq -c   # ESTAB vs SYN-SENT vs CLOSE-WAIT
```

A single PID holding hundreds (especially with many `SYN-SENT`) is a storm. A
`gnome-terminal-server.service` cgroup = a stray manual launch; a `*.service` cgroup = a
real service.

## Recover (least-disruptive first)

* **Storming stray** → `kill -KILL` its whole subtree (the `npm exec` → `sh -c tsx` →
  `node` chain). It's redundant (the real operator is elsewhere on the standard ports);
  killing it frees the slots immediately and it does NOT respawn (it's not systemd).
* **Oversized service pool** → restart just that service:
  `dev:restart { target: 'staging', confirm: true, authorize: true, reason: 'reload the staging operator with updated code' }` (playbook-blessed; `:3170` is the
  non-primary staging operator — never a raw `systemctl restart`, which bypasses the
  drain + WI-4221 debounce). Its pool reconnects lazily to baseline (\~18), freeing \~50
  slots. Do NOT restart the whole cluster for this.
* **Terminating idle backends** at the OS level (`kill -TERM <backend-pid>`) is safe (PG
  treats it like `pg_terminate_backend`) but pools just reopen — only a fix if the client
  count is genuinely transient; otherwise kill the source.

## Chronic note

`max_connections = 100` is tight for this multi-tenant dev box — the staging operator alone
wants \~70. Raising it is a **postmaster-start** parameter (a full cluster restart, NOT a
`SIGHUP`/reload), so it's a coordinated action, not an in-session fix. RAM is not the
constraint (the box has 100+ GB free). If storms/overhang recur, raising `max_connections`
(or shrinking the staging operator's pool) is the durable fix — file it rather than
band-aiding each wedge.

## Watchdog no longer mis-files a wedge as tool bugs (fixed 2026-06-17)

The improvement-watchdog used to classify these exhaustion errors as **per-tool structural
bugs** (low-bar, fires at n≥2) because the error *shape* recurs identically — so a single
wedge spammed `Tool X returns a structural error` EIs across every PG-backed tool
(EI-1331/1332/1323/1337/1342/1344 + the coord-probe canary EI-1333), several of which the
Mug then triaged to the auto-implement fix queue (which would "fix" working tools).
Fixed in `packages/operator-core/lib/harness/improvements/watchdog.ts`:
`classifyToolError` + the SQL `CASE` in `collectToolErrorSignals` classify
connection-exhaustion / DB-unavailable messages (`INFRA_TRANSIENT_MESSAGE_PATTERN`) as
**transient** (volume-gated at n≥15 via `transientMinCount`, `toolErrorSignalsFromRows`), so a
brief wedge is ignored while a sustained infra problem still fires. So a future wedge won't
recreate that false-positive EI cluster.

(As of `watchdog-and-exposed-systems-improvement-2026-06-18` P-011, the classifier itself —
`classifyToolError`, `ToolErrorClass`, the message-pattern constants, and the SQL `CASE`
generator — moved to a sibling module, `./tool-error-classifier.ts`, so the TS function and the
SQL stay generated from one ordered rule table and can't drift apart; `watchdog.ts` re-exports
`classifyToolError`/`ToolErrorClass` for existing import sites and still owns
`collectToolErrorSignals`/`toolErrorSignalsFromRows`, which consume the classifier.)
