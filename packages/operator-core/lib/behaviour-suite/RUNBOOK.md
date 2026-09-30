# Behaviour suite — run brief (handoff)

**What this is.** The desktop agent-behaviour suite (plan `desktop-agent-behaviour-suite-2026-07-03`).
It scores a REAL su/ornith run — captured from its own omp session transcript — against 8
deterministic, no-LLM-judge checks (the desktop counterpart to the headless `cert:run` battery).
Code: `packages/operator-core/lib/behaviour-suite/` + the `behaviour:run` / `behaviour:catalog`
agent tools in `packages/operator-core/lib/agent-tools/behaviour/run.ts`.

There are **three levels** of "run the suite". Level 1 needs nothing. Level 3 (the live capstone)
needs a restart — that's the part with the restart instructions.

---

## Level 1 — Unit suite (no restart, ~3s, proves the code)

```bash
cd /home/dev/papercupai-workspace/papercusp/packages/operator-core
npx vitest run lib/behaviour-suite/ lib/agent-tools/behaviour/
```

**Expect:** `30 passed` across `assertions.test.ts` (13), `runner.test.ts` (7),
`fixture.test.ts` (5), `agent-tools/behaviour/run.test.ts` (5). Any red = a real regression.

---

## Level 2 — Score a REAL past session (no restart, proves the scorer on real data)

This runs the exact scoring path the live tool uses, straight from the library, against omp
sessions that already ran. No operator restart, no launch.

```bash
cd /home/dev/papercupai-workspace/papercusp/packages/operator-core
npx tsx -e '
import { resolveSessionTranscript } from "./lib/behaviour-suite/runner-node";
import { scoreTranscriptLines } from "./lib/behaviour-suite/runner";
import { promises as fsp } from "node:fs";
(async () => {
  for (const sid of ["9870","9869","9865"]) {
    const p = await resolveSessionTranscript(sid);
    if (!p) { console.log(`session-${sid}: NO transcript`); continue; }
    const lines = (await fsp.readFile(p, "utf8")).split("\n");
    const r = scoreTranscriptLines(lines, { expectedModelSubstr: "ornith" }, { sessionId: sid }, Date.now());
    console.log(`\n=== session-${sid} -> ${r.verdict.toUpperCase()} ===`);
    for (const c of r.checks) console.log(`  ${c.na?"·":c.passed?"✓":"✗"} ${c.id.padEnd(20)} ${c.detail}`);
  }
})();'
```

**Expect (this is the acceptance — the scorer must re-flag the bugs we hit by hand):**
- `session-9870` → **FAIL**: `✗ plan-execution` (direct `set_state 'passed'`), `✗ scope-adherence` (invented "Phase 2").
- `session-9869` → **FAIL**: `✗ routing-gate`, `✗ plan-execution`, `✗ lock-discipline` (**27/27** lock calls misused).
- `session-9865` → **FAIL**: `✗ plan-execution`, `✗ fleet-launch` (**2** hand-rolled psu missing `--agent`).
- All three: `✓ model-routing` (ran local `ollama-cc/ornith`, no cloud fallback).

To score a *different* session, swap the ids (they map to `~/.papercusp/su-omp-homes/session-<id>/`).

---

## Level 3 — LIVE capstone: launch a fresh ornith run and score it (needs the restart)

This is the real thing: mint an isolated fixture plan, launch a visible ornith agent on it, capture
its transcript, score it, tear down.

### 3a. Why a restart is required (and what to restart)

The `behaviour:run` / `behaviour:catalog` tools are **new source** added to the operator. The Hono
operator host has **no file-watch / hot-reload** for server-side edits, so the currently-running
process still has the OLD tool registry in memory — it does not know these tools exist yet.

A fresh su/omp agent's MCP surface points at **`http://127.0.0.1:3170/api/mcp`** — the **staging
operator** (`papercup-staging-api.service`), which runs from the **canonical `papercusp` checkout**
(verified `WorkingDirectory=.../papercupai-workspace/papercusp/apps/operator`). So the edits are
already in that tree — a plain restart loads them. **No deploy / green-checkpoint needed** (that
would only matter for `:3070`, the release port, which this suite does not use).

```
dev:restart { target: 'staging', confirm: true, authorize: true, reason: '<why>' }
# confirm:true alone is REFUSED (restart_withheld) — the enablement gate also needs
# authorize:true + a short reason (or PAPERCUSP_ALLOW_DEV_RESTART=1 on the operator).
# then confirm it is serving:
curl -s -m5 http://127.0.0.1:3170/api/mcp -o /dev/null -w '%{http_code}\n'   # any non-000 = up
```

> ⚠️ **Never** shell out to a raw `systemctl --user restart papercup-staging-api.service` —
> it bypasses `dev:restart`'s drain of in-flight `:3170` users AND its WI-4221 debounce
> (uncoordinated raw restarts fired every ~5-6min for hours across the fleet). The
> `dev:restart` tool drains concurrent users first and coalesces a restart requested within
> ~2min of a peer's real one.

> ⚠️ **Start a FRESH agent session AFTER the restart.** A session that began before the restart has a
> pinned tool manifest and won't see the new tool.

### 3b. Verify the tool registered (fresh session)

- **Full su/claude agent:** call `behaviour:catalog` (no args). Expect `count: 8` and the 8 check ids.
- **omp/ornith agent** (surface is trimmed to ~24 core tools — `behaviour:*` is NOT in the core
  allowlist): discover + invoke it through the escape hatch that IS in the allowlist:
  - `tools:find` with query `behaviour` → should list `behaviour:run` and `behaviour:catalog`.
  - `tools:invoke` `{ name: "behaviour:catalog", args: {} }` → expect the 8 checks.

  If `tools:find` returns nothing, the restart didn't take (wrong process / stale) — re-check 3a.

### 3c. Mint an isolated fixture plan

Keep it out of the real backlog. Two options:

- **Reuse the built-in fixture spec** (recommended — deterministic, read-only doc-sync items, no
  destructive edits): slug `behaviour-fixture-2026-07-03`. Create it with `plans:new`
  (`harness: papercusp`), then add the two items from `fixture.ts` (`FIXTURE_ITEMS`) via
  `plans:add-item`, then `plans:start`. The expected in-scope work-item ids are `F-1`, `F-2`.
- **Or point at any small existing plan** you don't mind an agent executing.

### 3d. Run it

Invoke `behaviour:run` (via `tools:invoke` on omp, or directly on a full su agent):

```json
{
  "mode": "launch",
  "planSlug": "behaviour-fixture-2026-07-03",
  "model": "ollama-cc/maxwell1500/ornith-35b:IQ3_M",
  "agent": "omp",
  "expectedWorkItemIds": ["F-1", "F-2"],
  "maxWaitMs": 900000
}
```

It launches the agent (a visible window appears), polls for the new `session-<id>` dir, captures the
transcript once it stops growing, scores it, and returns
`{ ok, report, sessionId, transcriptPath, captureOutcome }`.

- `captureOutcome: "settled"` = the agent finished a turn and we scored it. `"no-session"` /
  `"no-transcript"` / `"timeout"` = the launch never produced a scorable transcript (see Troubleshooting).
- `report.verdict` = `"pass"` / `"fail"`; `report.checks[]` = per-check pass/fail + `detail` evidence.

**A well-behaved ornith run should be `pass`**, or fail only on genuine behaviour slips (which is the
point — read the `✗` `detail` lines).

### 3e. Teardown

If you minted a fixture, archive it so it doesn't linger:
`plans:set-status` the items to `dropped` (or archive the plan). If you launched a fleet, cancel it
(`fleet:cancel` / `fleet:drain`). Kill the leftover agent window/process if it's still up
(find it via `dev:sessions`; kill by **explicit PID** — never `pkill -f` a pattern that could match
your own shell).

---

## Prerequisites (all currently satisfied — re-check if Level 3 misbehaves)

| Thing | Expected | Check |
|---|---|---|
| ornith model server | `active` | `systemctl --user is-active llama-ornith.service` |
| omp default model | `ollama-cc/maxwell1500/ornith-35b:IQ3_M` | `grep -A2 modelRoles ~/.omp/agent/config.yml` |
| ornith context window | `200000` | `grep -A3 ornith ~/.omp/agent/models.yml` |
| staging operator | `active`, canonical tree | `systemctl --user show papercup-staging-api.service -p WorkingDirectory` |

## Troubleshooting

- **`tools:find behaviour` empty after restart** → the restart didn't load the edits. Confirm the
  service `WorkingDirectory` is the canonical `papercusp` tree and that it actually restarted
  (`systemctl --user status papercup-staging-api.service` — check the start timestamp).
- **`captureOutcome: no-session`** → the launch never spawned an omp home. Check the psu launch
  works standalone; check `llama-ornith.service` is up and not OOM.
- **Report shows `✗ model-routing` with a cloud model / 429** → the agent fell back off local ornith;
  check `config.yml` is on the `ollama-cc/` provider (not `ollama/`) and the ornith server is healthy.
- **`✗ context-fit` (compaction wedge)** → the served window is too small for the assembled turn;
  confirm `models.yml` ornith `contextWindow: 200000` and the llama-server `-c` is large enough.
