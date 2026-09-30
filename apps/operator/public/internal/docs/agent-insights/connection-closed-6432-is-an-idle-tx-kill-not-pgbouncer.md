# `write CONNECTION_CLOSED 127.0.0.1:6432` is an idle-tx kill, not a PgBouncer bug — and how to prove a fix with a :3170-vs-:3070 A/B
URL: /internal/docs/agent-insights/connection-closed-6432-is-an-idle-tx-kill-not-pgbouncer

The :6432 in the error names the pooler, so this signature has been mis-filed as a PgBouncer problem at least three times. It is Postgres killing a backend at idle_in_transaction_session_timeout (60s) because the MCP dispatcher held a workspace tx open across slow NON-DB work. The tell is a duration of almost exactly 60000ms. Fixing the inner tool is a no-op while a DELEGATOR (tools:invoke) wraps it in its own tx. Also documents the general technique: use :3170 (your edit) vs :3070 (green release) as a controlled A/B to prove a server-side fix before it deploys.

## The signature

```
MCP error -32603: write CONNECTION_CLOSED 127.0.0.1:6432
```

…or the worse variant: no response at all, until the client's 300s idle-abort fires and blames
`CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` — which reads as "your timeout is too short" rather than
"the write path is wedged".

**`:6432` is PgBouncer, and that is exactly why this keeps getting mis-diagnosed.** The port in
the message names the nearest component, not the guilty one. Three separate investigations
(EI-18666279107998059, EI-18733783500981433, and the parent of this doc) each started at the
pooler. None of them needed to.

## What is actually happening

`dispatchWithSynthesizedTx` (`_mcp-handler.ts`) opens a `withWorkspace` transaction and holds it
for a projected tool's **entire handler**. A handler that does slow **non-DB** work — shelling out
to `tsc`, `vitest`, `git`, a deploy — leaves that transaction idle-but-open. At 60s the role-level
`idle_in_transaction_session_timeout` fires, Postgres kills the backend, PgBouncer notices its
server connection died ("server conn crashed?"), and the caller is handed `CONNECTION_CLOSED`.

The pooler is a **messenger**. It is reporting a backend that Postgres deliberately killed.

### The tell

Look at the duration. A killed call lands at **almost exactly 60000ms**:

```sql
SELECT tool_name, duration_ms, error_code, invoked_at
FROM harness_shared.tool_invocations
WHERE error_code = 'handler_error'
  AND duration_ms BETWEEN 59000 AND 62000
  AND invoked_at > now() - interval '7 days'
ORDER BY invoked_at DESC;
```

A genuine pooler or network fault has no reason to cluster at 60.0s. A timeout does.

To attribute a kill to a *process*, read the PG log — `log_line_prefix` carries `app=%a`, and the
app name embeds the pid:

```bash
sudo grep 'idle-in-transaction' /var/log/postgresql/postgresql-18-main.log | grep 'app='
# 10:57:53.916 EDT [1584535] harness_app@papercusp app=pcusp:org-app:p3697522
#   FATAL: terminating connection due to idle-in-transaction timeout
ps -o pid,cmd -p 3697522   # -> which operator was holding the tx
```

## The part that made two correct root-causes fail

`release:deploy` and `capability:bash` were **each individually fixed** with `skipWorkspaceTx: true`
— and both kept dying at 60s anyway, \~31 times a day.

Because **`tools:invoke` is a pure delegator.** It awaits `ctx.dispatchTool()` for the inner tool's
whole runtime and never reads `ctx.tx` — but it is itself a projected tool, so the dispatcher wrapped
*it* in a transaction. The inner tool's exemption was irrelevant; the outer one held the tx.

The giveaway in the PG log was **paired** backend kills \~20ms apart: outer tx and inner tx dying
together.

> **When a fix does not hold, suspect a wrapper you have not looked at.** The thing that *calls* the
> fixed component can re-arm the identical defect.

## Finding the whole class, not the instances you were handed

Log evidence named 5 offending tools. Grepping for the **property** instead —

> defines a tool **and** imports `node:child_process` **and** never reads `ctx.tx`

— found **11**. The extra 6 had simply not yet blocked past 60s. (One was `dev:restart`, whose own
`timeoutSec` already exceeds 60s: armed and waiting.)

Evidence finds what has already broken; a property finds what *will*. `child-process-tools-skip-workspace-tx.test.ts`
now encodes that property and fails the build on any child-process tool missing the flag.

Note the polarity problem this leaves: `skipWorkspaceTx` is **opt-out**, so the default is armed and
every instance is disarmed only *after* it has failed in production. That is tracked separately
(EI-18808330244321407) — inverting it touches the hottest path in the system.

## Proving a server-side fix before it deploys — the :3170-vs-:3070 A/B

This is the generally reusable part, and it works for **any** server-side operator change.

The two-port model gives you a free control group:

| host            | runs                                                               | role in the experiment |
| --------------- | ------------------------------------------------------------------ | ---------------------- |
| `:3170` staging | the integration tree — **your edit**                               | the treatment          |
| `:3070` release | `papercup-release`, pinned to green `main` — **without your edit** | the control            |

Same machine, same Postgres, same PgBouncer, same second. The **only** variable is the code. That
is a real controlled experiment, and it is available *hours before* your change clears the green
gate.

```bash
# 1. load your edit into staging (never a raw systemctl restart — the tool drains + coalesces)
#    dev:restart { target: 'staging', confirm: true, authorize: true, reason: 'reload the staging operator with updated code' }

# 2. fire the identical call at BOTH hosts, in parallel
TOK=<superuser bearer>
BODY='{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"tools:invoke",
      "arguments":{"name":"capability:bash","args":{"command":"sleep 75; echo SLEPT_OK"}}}}'
for port in 3170 3070; do
  curl -s --max-time 150 -X POST "http://127.0.0.1:$port/api/mcp?superuser=1&workspace=papercusp-workspace" \
    -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' -d "$BODY" &
done; wait
```

Observed 2026-07-27T14:56:53Z:

* **`:3170` (fixed)** — 76s wall, `exit 0 · 75.2s`, `SLEPT_OK`.
* **`:3070` (unfixed)** — failed at **exactly 60s**, `write CONNECTION_CLOSED 127.0.0.1:6432`.
* PG logged **one** kill in the window, attributed to the `:3070` release host. Kills attributed to
  the staging pid, all day: **zero**.

Two things fall out of that single run that no amount of unit testing gives you:

1. **The bug reproduces on demand.** It had been filed as "intermittent". It is perfectly
   deterministic once you hold a tx across >60s of non-DB work — and a bug you can summon is a bug
   you can prove you fixed.
2. **The pooler is exonerated by construction.** Both hosts share it. One failed, one did not.
   No pooler-side hypothesis survives that, and no one needs to re-open it.

### Why bother, instead of waiting for the deploy

Waiting produces *weaker* evidence. "We deployed and then saw no kills for a while" is an argument
from absence, and it cannot distinguish a real fix from a quiet hour. The A/B shows presence **and**
absence under control, in \~80 seconds.

Keep the deployment itself as a separate, honestly-stated residual: verifying the code is correct is
not the same claim as verifying the artifact shipped. Confirm that with
`dev:pipeline_position { path }` and, if you want belt-and-braces, re-run the `:3070` leg after the
deploy and watch it *succeed*.

## Checklist

* Duration \~60000ms + `:6432` in the message ⇒ idle-tx kill. Do **not** open the pooler.
* Find the holder via `app=%a` in the PG log, then `ps` the pid.
* Fix the tool **and** every delegator that wraps it.
* Sweep for the property (`child_process` + no `ctx.tx`), not just the reported instances.
* Prove it with a `:3170`-vs-`:3070` A/B before the gate goes green.
