# Heavy-command admission control (don't melt the shared box)
URL: /internal/docs/agent-insights/heavy-command-admission-control

The 128-core dev box is shared by the whole fleet. Each agent's vitest/tsc/test:affected is already per-suite worker-capped, but N agents running their own simultaneously with zero cross-process coordination is what melts the host to load 3000+. A PreToolUse hook now DENIES a new raw heavy command when host load is already past ~1.5x cores; scripts/pc-heavy.sh is the flock counting-semaphore that WAITS for a free slot instead of failing. What every agent needs to know when a heavy command gets denied.

## The problem

The dev box is a single 128-core host shared by the entire fleet. A single
`npm run test:affected` is already well-behaved: `scripts/affected-tests.mjs`
caps vitest at 32 workers per suite and runs workspaces sequentially. The
danger is **cross-process**: when \~6 agents each launch their own capped run at
once, that is \~185 vitest workers, and the box climbs from a healthy \~1x load
to 1.9x, then spirals (load 245 → 3000+ happened twice in one week). Nothing
coordinated heavy runs *across* agents — until now.

## What changed

Two cooperating pieces (WI-3821):

**1. Admission gate (in the PreToolUse bash hook).**
`apps/operator/scripts/hooks/cc/pretooluse-bash-resource-gate.sh` now checks, on
every raw agent `Bash` command, whether the command is *heavy*
(`vitest` / `tsc` / `npm test` / `test:affected` / `npm run build` /
`turbo run test|build|typecheck`) and whether host `load1` is already over the
threshold (default `1.5 × cores` = 192 here). If so, it **denies** the command
with a message telling you what to do. It is the only place that transparently
sees every raw heavy command, but a PreToolUse hook can only allow/deny — it
exits before the command runs, so it cannot hold a slot. Hence piece two.

**2. `scripts/pc-heavy.sh` — the "run it anyway, politely" path.**
A flock **counting semaphore**: it waits for one of N free build slots
(default `cores / 32` ≈ 4), runs your command `nice`/`ionice`'d, and releases
the slot when the command exits (kernel-backed, so a crash never leaks a slot).
It sets `PC_HEAVY_BYPASS=1` for the child, so the admission gate does not also
deny it — the wrapper already self-limits.

## What to do when a heavy command is denied

You have three options, in order of preference:

```sh
# 1. Preferred: run it under the semaphore — it queues for a slot instead of
#    failing, and runs at lowered priority so it yields to critical services.
scripts/pc-heavy.sh -- npm run test:affected
scripts/pc-heavy.sh -- ./node_modules/.bin/vitest run lib/x.test.ts

# 2. Just wait ~30-60s and re-run — the gate clears itself as load drops.

# 3. Verify via the sanctioned MCP tool instead of raw bash. capability:inspect
#    (npx tsc --noEmit / npm run test:affected / npx vitest run) runs
#    server-side and never hits this hook, so it is never gated.
```

## Who is exempt (by construction)

* **The green-checkpoint gate** and **`capability:inspect`** run server-side / as
  MCP tools and never reach the bash hook — never gated.
* **The owner** (a session with no `PAPERCUSP_AGENT_SESSION` marker, working
  outside the canonical shared tree) — never gated.
* Anything already wrapped by `pc-heavy.sh` (`PC_HEAVY_BYPASS=1`).

Only raw, uncoordinated **agent** heavy commands get staggered — exactly the
load that piles up.

## Tunables & kill-switch

| Env                                 | Default                | Effect                                                         |
| ----------------------------------- | ---------------------- | -------------------------------------------------------------- |
| `PC_HEAVY_ADMISSION=off`            | on                     | **Kill-switch** — disables the deny entirely.                  |
| `PC_HEAVY_MAX_LOAD1`                | `round(1.5 × cores)`   | Load1 above which heavy commands are denied.                   |
| `PC_HEAVY_SLOTS`                    | `max(2, cores/32)`     | Concurrent heavy runs `pc-heavy` allows.                       |
| `PC_HEAVY_TIMEOUT_SEC`              | `900`                  | Max seconds `pc-heavy` waits for a slot before running anyway. |
| `PC_HEAVY_NICE` / `PC_HEAVY_IONICE` | `10` / `best-effort 7` | Priority of a wrapped run.                                     |

The gate is **fail-open**: any error (can't read load, bad env, parse failure)
allows the command. It lands fleet-wide via git-sync with no review, so a
fail-closed bug would wedge every agent's bash — every path errs toward
allowing. The threshold sits well above healthy full-tilt operation (1.0–1.3x),
so it only trips during genuine oversubscription.

## Known boundary (follow-ups)

Coverage is best-effort, not airtight: a compound `cd <canonical> && vitest`
carries the workspace root as its payload `cwd`, so for those it relies on the
agent-session marker rather than the tree check. And raw invocations are
*denied*, not auto-queued — full transparent queueing (auto-routing heavy
commands through `pc-heavy`, an adoption check-guard, or an optional
`systemd` slice) is deliberately left as a follow-up rather than rushing a
host-wide scheduling change.
