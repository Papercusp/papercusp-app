# Agent-mcp routes slow but /health fast = main-event-loop saturation (not a leak/pool/DB issue)
URL: /internal/docs/agent-insights/agent-mcp-slow-but-health-fast-event-loop-saturation

When :3070 agent-mcp routes degrade to many seconds and MCP clients time out while /api/health stays fast, the cause is sustained main-thread CPU saturating the event loop — every await hop pays the loop delay, so hop-heavy routes degrade ~Nx while health (~2 hops) barely moves. Read the event-loop-lag gauge first, not the PG pool.

import { Aside } from '@astrojs/starlight/components';

## The signature

`:3070` agent-mcp routes (psu / fleet MCP, `/api/agent-mcp/*`, `/api/harness/*`)
degrade to **12–30s/req and MCP clients time out**, but `/api/health` stays
**\~sub-second**. It may worsen over \~1h after boot and "recur after restart".
Memory may spike separately — don't be misled into chasing a leak.

This is **main-event-loop saturation**, not what it looks like. The discriminator
chain (EI-79, a multi-day forensic slog precisely because nothing reported it):

* **Not a leak / fd / conn exhaustion** — fd and conn counts are normal.
* **Not the PG pool** — PG is healthy (sub-second queries, no blockers); N
  parallel requests finishing *together* at \~the same long time = no pool
  staircase, they're all waiting on the same shared resource (the loop).
* **Not CPU priority** — changing CPUWeight does nothing.
* **The tell**: trivial agent-mcp routes (one settings read) are as slow as
  heavy ones, while `/health` is fine. Hop-heavy routes
  (auth→identity→roles→telemetry→PG) pay the per-await **loop delay** dozens of
  times; `/health` (\~2 hops) pays it \~twice. Sustained host CPU (`node` \~165%+
  steady) is the burden; every `await` hop is where it's felt.

## Diagnose it in one read

A standing **event-loop-lag gauge** exists for exactly this — read it before
touching the PG pool:

* `packages/operator-core/lib/event-loop-lag-monitor.ts` — `perf_hooks`
  `monitorEventLoopDelay()`, wired at boot in `apps/operator/bin/hono-host.ts`.
* It logs `[event-loop-lag] high loop delay — host is CPU-bound on the main
  thread` (with p50/p95/p99/max) **only** when p95 over a 10s window ≥100ms;
  silent on a healthy host. Grep the `papercup-dev-api.service` journal for it.

To name the on-loop consumer: a 60s CPU profile of the live host
(`node --cpu-prof` / inspector). EI-79's was the hyperbee P2P read-merge driver
(`packages/operator-core/lib/sync/hyperbee/boot.ts` `mergeNow`, 1Hz poll) re-decoding **every op from index
0 in every admitted peer log every second** — O(total-history) per tick. Fix was
an incremental merge cursor reading only `[cursor,length)` + a steady-state
change-detection skip + PG-level `fed_ts` ts-guarded LWW writers (mig 181).

## On a busy box: separate loop work from scheduler preemption

`monitorEventLoopDelay()` measures wall-clock delay between timer fires, which
**includes time the OS descheduled the process**. On an oversubscribed box (high
load average), the gauge can sit at p95 \~100–150ms from **scheduler preemption
alone**, not host on-loop work.

Discriminator: time a **hop-heavy** agent-mcp route. If the loop genuinely
carried \~Xms of on-loop work *per hop*, a dozens-of-hops route would be
multi-second. If hop-heavy routes are **sub-second** while the gauge reads
\~100ms, the floor is mostly scheduler noise (external box load) — a real but
*different* problem from a host on-loop regression. Latency on the actual routes
is the ground truth; the gauge p95 is the alarm, not the verdict.
