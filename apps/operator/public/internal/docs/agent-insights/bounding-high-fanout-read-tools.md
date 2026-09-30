# Bounding high-fanout read tools so they can't overflow the agent result cap
URL: /internal/docs/agent-insights/bounding-high-fanout-read-tools

Agent-facing read tools whose output scales with workspace size (coord:inbox/feed, work_items:list, plans:get, fleet:assignments) overflow the per-result token cap and spill to a file. The fix is a budget-aware bound applied at the TOOL layer — here's the pattern, the shared util, and the per-tool shapes.

## The symptom

A read tool returns one giant line and the agent gets an error instead of data:

```
Error: result (73,723 characters across 1 line) exceeds maximum allowed tokens.
Output has been saved to .../tool-results/...txt
- Slice by character range via Bash ... read()[A:B] ...
```

You then have to file-slice to read your own inbox / the work queue / a plan. On a
busy workspace this is routine, not rare — the output scales with workspace size, so
a tool that was fine at week 1 overflows at week 6.

## The class (recurring)

Any agent-facing read tool whose result grows with the workspace is at risk. Seen +
fixed across: `coord:inbox` (EI-1752), `coord:plan-events` (EI-1737, default bound),
`plans:get` mode:sections (WI-274 — inlined every decision body), `work_items:list`
(full `summary` per row → 73KB at 40 items), `coord:feed` (full envelope × 100 rows),
`fleet:assignments` (per-agent intent + queued lists × N agents). Swept together as
**EI-1597**. A NEWER instance of the same class: `fleet:assignments { includeDag }`'s
DAG-filter frontier (EI-6949, 2026-07-03) — a plan's WHOLE item list, which can be
large — was bounded from day one per the rule below (see "Per-tool shapes").

Payload-TIER shaping (context-trimming-tiers-2026-07-01) is now a second, sibling
mechanism layered on top of the SAME bound-at-the-tool-layer discipline —
`assignments-shape.ts` tier-collapses `agents`/`orphaned`/`stalled`/`coverage`/`dag`
for `trimmed`/`standard` sessions (uniform keys + a visible truncation note per
tier), while `payloadTier:"full"` still gets the byte-budget-bounded shape below.
Tiering changes HOW MUCH of the already-bounded result a given session sees; it does
not replace the byte-budget bound itself.

## The fix — a budget-aware bound at the TOOL layer

Per-item cap = `min(perItemCap, floor(totalBudget / n))`. This keeps the TOTAL bounded
at **any** row count, while small results keep most rows full. A cut field gains
`<field>_truncated: true` + `<field>_full_chars`; always leave a full-fetch escape
hatch (a `mode:full`, a narrower `{ agent }`/`{ plan }`/`heading` query, or the
pagination cursor).

Shared util: `packages/operator-core/lib/agent-tools/_bound-output.ts`

* `boundRowField(rows, field, perItemCap, totalBudget)` — excerpt a big TEXT field per row.
* `boundListField(rows, field, maxItems)` — cap an unbounded ARRAY field per row (+ `<field>_total`).
* `trimToByteBudget(rows, budget)` — keep rows (caller sorts most-relevant first) until a serialized-size budget; the backstop when a row has many variable-size fields.

## Two non-negotiable disciplines

1. **Bound at the TOOL layer, NOT the data layer.** Internal callers + the UI read
   the data functions directly (`listWorkItems`, `groupByAgent`, `readCoordFeed`, the
   plan parser) and need the FULL bodies. Only the agent-facing tool projection is
   excerpted. Verify this with a quick consumer grep before you change a shape — e.g.
   `coord:feed` and `fleet:assignments` each have a UI/sync-resolver consumer on the
   data layer that must keep full data.
2. **Compute summaries/aggregates over the FULL set, then bound the returned rows.**
   `fleet:assignments` summary counts and `coord:feed` `byKind`/`total` are computed
   before the row bound, so the counts stay accurate even when the array is trimmed.

## Per-tool shapes (pick by what's unbounded)

* **Big text field per row** → `boundRowField` excerpt. (plans:get decision `body`;
  work\_items:list `summary`; coord:feed `body` + `summary`.)
* **Unbounded sub-list per row** → `boundListField` cap. (fleet:assignments `queued`
  work-list — keep the head + `load` count; the Mug reads those for placement.)
* **Many variable-size fields per row** → `trimToByteBudget` backstop. (fleet:assignments
  agent groups — sorted live-first so the trim drops the least-relevant tail.)
* **High default row count** → lower the AGENT default, keep the cursor. (coord:feed:
  agent default 30 vs the UI's `DEFAULT_FEED_LIMIT` 100 — at 100 the per-row metadata
  floor alone threatens the cap.)
* **Opt-in field whose size scales with an external structure (not the row count)**
  → never silently drop it, but collapse to counts + a visible note at the leaner
  tiers. (fleet:assignments `{ includeDag }` — the DAG frontier lists every item in
  the queried plan; `assignments-shape.ts` keeps the full frontier at
  `standard`/`full` but collapses `dag` → `dag_counts` + a `dag_note` at `trimmed`,
  mirroring how `coverage` collapses to `coverage_note`.)

## When you add a NEW read tool

If its result scales with the workspace, bound it from day one with `_bound-output`
(or lower its default + paginate). The cheapest test: imagine the workspace at 10×
today — does one call still fit? If not, bound it.

> Cross-refs: EI-1597 (the sweep), WI-274 (plans:get), EI-1752 (coord:inbox),
> EI-1737 (coord:plan-events). Sibling docs: `compact-tool-result-formats` (the
> ENCODING axis — TOON/CSV), `presence-token-cost-and-output-size-telemetry`.
