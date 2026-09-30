# A headless spawn that omits --account silently bypasses the gateway
URL: /internal/docs/agent-insights/headless-spawn-without-account-bypasses-the-gateway

Omitting --account on a psu-launcher spawn routes it in 'default' mode (single CLI credential, no failover), which starves a batch spawner into silent all-null cells while the gateway pool sits idle.

## The trap

`psu-launcher`'s `--account` selects one of three LLM routing modes
(account-routing-3-options, `psu-launcher.mjs` \~L426 / `agent-launch-core.ts`):

* `<pool-id>` → hard-pin to that pool account **via the inference gateway** (no failover)
* `auto` → route **through the gateway**, auto-select an available pool account **with failover**
* `default` (or **omitted**) → **skip the gateway**, use the single shared `~/.claude` CLI-login credential

The footgun is the default. A spawner that omits `--account` runs **every** child
on the **one** CLI credential, with no failover. A one-off is fine; a **batch**
spawner (a benchmark sweep, a fan-out) fills that single account's rolling usage
window and then its children **spawn but land zero API turns** — while the 7-account
gateway pool sits completely idle. `cup:spawn` and fleet launch already default to
the gateway; **direct `psu-launcher` callers do not** and must opt in.

## Why it's nasty: silent all-null cells

A starved child still creates its config dir and exits cleanly, so a naive driver
records it as `status: 'ok'` with **every metric null** (a zero-hop transcript →
`emptyCellMetrics()`). The data looks present but is empty, and the failure
**clusters at the tail** of a long run (the credential fills over time) — so the
highest-cost / highest-value cells are exactly the ones lost.

Traced live 2026-07-17 on the P-025 `maxturn-sweep` (`WI-5003`): ornith mt25k 0/9
null → mt50k 6/9 → mt100k 9/9, and the next chunk started already starved. It reads
like "the pool is saturated" but it is the opposite — the pool was never used.

## Detect it at the process level (don't guess)

A gateway-routed child's `claude` process has the gateway endpoint in its env; a
`default`-mode child has it **blank**:

```
# gateway-routed (--account=auto / pool-id):
ANTHROPIC_BASE_URL=http://127.0.0.1:8788
ANTHROPIC_AUTH_TOKEN=papercusp-gateway

# default mode (no --account):
ANTHROPIC_BASE_URL=      # blank
ANTHROPIC_AUTH_TOKEN=    # blank
```

`tr '\0' '\n' < /proc/<claude-pid>/environ | grep -iE 'ANTHROPIC_BASE_URL|GATEWAY'`.
And confirm the pool is healthy with capacity via `gateway:status` (running/queued vs
cap) + `accounts:status` (per-account utilization / walls) — if turns stall while the
pool is idle, suspect routing, not capacity.

## The fix

Pass `--account=auto` (or a pool-id) explicitly on the spawn. Make it a **typed,
defaulted option** on the spawn interface rather than a bare flag — the sweep now
carries `SweepAccountRouting` on `SweepSpawnInput` / the CLI's `--account`, defaulting
to `'auto'`, emitted on **every** spawn so routing is never an implicit fall-through
(`maxturn-sweep-live.ts` `buildSweepSpawnArgs`).

## Related

* `agent-insights/rate-limit-is-usually-account-routing-not-capacity`
* `agent-insights/llm-429-check-the-transport-not-the-account`
