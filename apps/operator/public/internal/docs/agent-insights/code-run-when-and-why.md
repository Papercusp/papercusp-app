# code:run — when to reach for it, worked exemplars, and the measured payoff
URL: /internal/docs/agent-insights/code-run-when-and-why

The code-mode rollout (B-CX-3) — collapse a multi-step tool flow into ONE code:run instead of paying an inference round-trip per call. Two before/after exemplars + a real measured token/cost saving from agent_usage_samples.

`code:run` executes a JS/TS script that calls your allowed tools (`tools.ns.verb(args)` + real
control flow) **in the runtime** and returns ONLY its final value to you. So a flow that would be
N separate tool calls — each its own inference round-trip that re-reads your whole context —
collapses into **one** inference call. This note is the rollout companion to the `code:run` /
`code:tools` tool guidance and the shared `CODE_RUN_NUDGE` now in every agent base prompt
(cup base, operator-launched-role base, su playbooks, the papercusp-pot su instance override).

## When to reach for it (and when not)

* **YES** — a task with MANY tool calls + control flow: loop / branch / filter over results,
  fan-out reads you'll aggregate, retry-until, "do X for each of N." The round-trip count scales
  with N; that is exactly the shape to script.
* **NO** — a single tool call, or a step that needs YOUR judgment mid-flow (read a result, THEN
  decide). A script can't pause for you to think; call those tools directly.
* **Summarize conservatively — over-filtering backfires** (the plan §8 consensus). Only the
  script's RETURNED value re-enters your context. Return what you'll actually need next; if you
  drop a field and have to re-fetch it, you pay back the round-trips you saved. When unsure, return
  more.

The canonical chain: `code:tools {}` → pick namespaces → `code:tools { namespaces }` for the exact
typed `tools.ns.verb(args)` signatures → write the script → `code:run { dryRun:true }` to preview
`effect:'write'` mutations (returned in `plannedMutations`) → inspect → `code:run` to commit.

## Exemplar 1 — triage the open backlog (list-then-act-per-item)

A common loop: list the open items, inspect each, act on the ones that match. As direct calls that
is `1 + 2N` round-trips (one list + a get/act per item). As one script:

```js
// code:run — field names illustrative; fetch real ones via code:tools { namespaces:['work_items'] }
const { items } = await tools.work_items.list({ kind: 'bug', state: 'open' });
const closed = [];
for (const w of items) {
  const full = await tools.work_items.get({ id: w.id });
  if (full.ageDays > 30 && !full.assignee) {
    await tools.work_items.setState({ id: w.id, state: 'closed' }); // effect:'write' → dryRun first
    closed.push(w.id);
  }
}
return { scanned: items.length, closed: closed.length, ids: closed };
```

`work_items:list` → 10 items → 10×`get` + a few `set_state` becomes **one** `code:run`. Run it once
with `dryRun:true`, read `plannedMutations`, then commit.

## Exemplar 2 — fan-out reads + aggregate (no mutation)

"Across every member harness, which have open escalations?" — `1 + N` reads as direct calls; one
script returns just the ranked summary:

```js
// code:run — read-only fan-out; no dryRun needed
const { harnesses } = await tools.harness.list({});
const hot = [];
for (const h of harnesses) {
  const st = await tools.harness.status({ slug: h.slug });
  if (st.openEscalations > 0) hot.push({ slug: h.slug, open: st.openEscalations });
}
return hot.sort((a, b) => b.open - a.open).slice(0, 10); // conservative: the rows you'll act on
```

## The measured payoff

Basis: `harness_shared.agent_usage_samples`, last 24h, cache-inclusive tokens
(`input + cache_read + cache_creation`). A usage sample is **per-run** (one subprocess, usually
several assistant turns), so the per-round-trip figure is `run tokens ÷ turn_count` — the correct
normalization flagged by su-1282a (B-TOK-ROLL). One tool round-trip ≈ one assistant turn.

**Measured cost of one round-trip** (572 runs, avg 7.8 turns/run; 82.6% of tokens are cache-read):

| role      | ctx tokens / turn | $ / turn | avg turns / run |
| --------- | ----------------: | -------: | --------------: |
| all roles |          \~45,950 | \~$0.124 |             7.8 |
| mug       |          \~44,710 | \~$0.120 |             7.2 |
| cup       |          \~93,350 | \~$0.118 |            19.4 |
| overwatch |          \~40,050 | \~$0.199 |             6.2 |

**Before/after for a flow of N tool calls** — N round-trips (N inference calls, each re-reading the
context) vs ONE `code:run` (1 inference call; the N tool dispatches run in the runtime with no
per-call inference):

| flow                                                      | inference calls |              ctx tokens |           $ |
| --------------------------------------------------------- | --------------: | ----------------------: | ----------: |
| Exemplar 1 direct (1 list + 10 act, all-roles \~46k/turn) |              11 |               \~506,000 |     \~$1.36 |
| Exemplar 1 as one `code:run`                              |           **1** |                \~46,000 |     \~$0.12 |
| **saved**                                                 | **−10 (\~91%)** |   **\~460,000 (\~91%)** | **\~$1.24** |
| Cup 20-step loop direct (\~93k/turn)                      |              21 |             \~1,950,000 |     \~$2.47 |
| Cup 20-step loop as one `code:run`                        |           **1** |                \~93,000 |     \~$0.12 |
| **saved**                                                 | **−20 (\~95%)** | **\~1,857,000 (\~95%)** | **\~$2.35** |

The win is largest exactly where contexts are biggest: **cups average 19.4 turns/run at \~93k
tokens/turn**, and many of those turns are scriptable loops. Because 82.6% of the cost is cache-read
of the re-loaded context, removing whole round-trips — not shrinking each one — is the lever.

> Caveats: the saving is per multi-step flow, not a fleet-wide multiplier (single-call turns are
> unaffected). The `tool_name` / `session_id` attribution columns (B-TOK-2) aren't backfilled yet,
> so per-tool round-trip counts come from the flow shape, not from joined telemetry — refine the N
> figures once attribution is flowing. Numbers are from a 24h window and will drift.
