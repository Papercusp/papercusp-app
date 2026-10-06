# Attributing event-loop saturation to a hot frame — read the cpuprofiles, and subtract the profiler
URL: /internal/docs/agent-insights/attributing-loop-saturation-via-cpuprofiles

Once you know :3070 is event-loop-saturated (routes slow, /health fast), the next question is WHICH code. Aggregate self-time across the ~/.papercusp/loop-profiles/*.cpuprofile captures — but first subtract the profiler's own observer-effect (it can be ~44% of samples), and don't trust the obvious culprit: in round-4 the cost was uncached git subprocess spawning, not the JSON-serialize everyone assumed.

import { Aside } from '@astrojs/starlight/components';

## Where this picks up

The companion insight
[`agent-mcp-slow-but-health-fast-event-loop-saturation`](/agent-insights/agent-mcp-slow-but-health-fast-event-loop-saturation/)
tells you *that* the operator is main-thread/event-loop saturated (hop-heavy MCP
routes degrade to many seconds while `/api/health` stays fast — read the lag
gauge, not the PG pool). This one tells you **which code is pegging the loop**, so
you fix the right thing instead of the plausible thing.

The event-loop-lag monitor (`event-loop-lag-monitor.ts`) already drops V8 CPU
profiles into `~/.papercusp/loop-profiles/loop-saturation-*.cpuprofile` whenever
lag crosses the threshold. Those are your evidence. Aggregate them.

## The method

A `.cpuprofile` is `{ nodes[], samples[], timeDeltas[], startTime, endTime }`. `timeDeltas[i]` is the time from the PREVIOUS sample (or from `startTime`, for i = 0) to sample i, and a sample shows the stack at one instant. So sample i owns the interval that FOLLOWS it: **self-time** for a node = sum of `timeDeltas[i+1]` (µs) over the samples that point at it. Chrome DevTools attributes it the same way.

⚠ **Never credit `timeDeltas[i]` to sample i, and never credit an unsampled stretch to any frame.** The lead-in `timeDeltas[0]` (startTime to the first sample) and any interval far above the median were NOT sampled. Sentinel stall profiles open with a 1.6-2.3 s lead-in, so crediting the preceding delta hands the whole stall to whichever frame was sampled first. That produced a false "2,325 ms self in `_onread`" finding (WI-10005379, retracted). In the opposite case it hides a stall as `(program)` idle. Use `sampleDurations()` from `scripts/lib/cpu-profile.mjs`. It returns per-sample durations plus `leadInUs` / `unsampledGapUs`, and both `scripts/analyze-loop-profiles.mjs` and `scripts/cpu-sample.mjs` use it (WI-10005421). Aggregate self-time
per `callFrame` (functionName + url:line) across *all* the captures — the recurring
hot frame is the culprit, not whatever one capture happened to catch.

```python
node_self_us = defaultdict(float)
for i, sid in enumerate(prof['samples']):
    nxt = prof['timeDeltas'][i + 1] if i + 1 < len(prof['samples']) else 0
    node_self_us[sid] += max(0, nxt)   # µs: the interval FOLLOWING this sample (cap over-median gaps; see above)
# then sum node_self_us by callFrame across every *.cpuprofile, rank descending
```

Self-time finds the synchronous work pegging the loop. Inclusive time (walk to the
root) tells you the call path; attribute a leaf (e.g. a driver `parse`) to the
nearest *app* frame by walking parents until you hit `operator-core/lib`.

## Two traps that will mislead you

The single largest self-time frame is almost always `post @ node:inspector`
(parent `captureCpuProfile @ event-loop-lag-monitor.ts`) — the profiler capturing
the profile. In the round-4 captures it was **\~44% of all samples**. It is pure
observer-effect; **exclude any frame whose url contains `inspector`** (plus
`(idle)`/`(program)`) before computing percentages, or every number you report is
off by \~2×. (It's also a real secondary effect: profiling fires hardest *during* a
wedge, so it adds load exactly when you're already saturated.)

The round-4 plan assumed the dominant cost was "`coord_event_log` full-scan + large
JSON serialize" and scoped its centerpiece as a worker-thread offload of that JSON.
The profiles disagreed. Of *real* workload (profiler excluded):

* **git `child_process.spawn` ≈ 26%** — the #1 cost. `devDeployState()` shelled
  \~10 `git` fork/execs per call, **uncached**, from poll-storm-amplified read paths
  (`system-health/compute`, the sync-resolver `dev.deployState` collection).
* **GC ≈ 24%** — allocation churn, largely *driven by* the spawn machinery + buffers.
* **postgres `DataRow`/`types.parse` ≈ 11%** — result-set deserialization on the
  driver's socket-read callback (no app ancestor on the stack; the lever is *fewer
  rows*, i.e. bounded/filtered reads, not "offload the query").
* **`@hono` JSON response serialize ≈ 5% and DIFFUSE** — no hot frame; the biggest
  single handler was `admin/plans.ts` at 0.15s. There was nothing concentrated to
  offload. The assumed culprit was a red herring.

## The lesson

The cheap, correct fix beat the expensive, assumed one. The win was a **short-TTL
single-flight cache** on the uncached `git` fan-out (`dev-deploy-state.ts`:
memoize the resolved snapshot for \~3s *and* share the in-flight promise so a
concurrent burst collapses to one fan-out) — \~30 lines, fully unit-testable,
reversible. The worker-thread offload the plan was built around had **weak data
justification** and was deprioritised.

Generalise:

* **Uncached expensive sync/subprocess work on a hot read path** is the shape to
  hunt. `child_process.spawn` is especially brutal on a Node event loop (fork+exec
  * stream setup + stdout buffering + the GC that follows). Grep hot read paths
    (system-health, sync-resolver, frequently-polled tools) for `execFile`/`spawn`/
    unbounded `SELECT … ORDER BY id` with no LIMIT/cache.
* **Attribute before you fix.** "This table is 6 GB" is a disk fact, not a CPU cost;
  only the cpuprofile tells you what's actually on the loop. Adversarially verify
  each finding against the profile (cpuprofile hot-frame + measured lag delta)
  before committing an expensive fix.

Worked example + the full per-caller bounded-read safety analysis:
plan `infra-perf-reliability-audit-round4-2026-06-19` (P-015 attribution; the
`devDeployState` cache; P-002 coord read-path).
