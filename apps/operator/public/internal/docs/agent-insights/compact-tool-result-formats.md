# Parsing tagged compact tool results (TOON / CSV)
URL: /internal/docs/agent-insights/compact-tool-result-formats

Tool results are no longer always JSON — the MCP transport delivers compact TOON by default, prefixed with a `format: <fmt>` marker. How to read each format, where the pagination cursor + row count went, and how to force JSON when you need it.

:::caution\[Superseded — one named example is now wrong]
The runbook below is overwhelmingly still correct (the `format:` marker, the
`_meta` envelope, the negotiation knobs, and the lossless round-trip fallback all
still hold). But the specific claim that **`audit:list` reliably arrives as
TOON** (in "The lossless guarantee", below) is now **false**:

* `audit:list` is registered as a **Tier-3 headerless-CSV** tool
  (`read: 'csv'`) in `packages/operator-core/lib/agent-tools/pre-prompt-registry-config.ts:77`.
  Its summary mode returns exactly `{id,ts,actor,action,subject}` (flat), so in
  compact mode it self-presents as **headerless CSV** — `format: csv\n[N]\n…rows`
  — not TOON.
* The Tier-3 read path **takes precedence** over the generic TOON-auto path:
  `libs/generic/tooldef/src/serialize-result.ts:280`
  (`const chosen = tier3 ? { ...tier3, fallback: false } : chooseFormat(data, opts);`),
  where `tryTier3Read` (lines 198–215) returns `format: 'csv'` for a registry
  tool whose `readPrePromptFormat` is `'csv'` once the request resolves to
  compact.

The **general principle** still holds (flat/uniform list tools get a compact
format); only the named tool and its claimed format (TOON) are wrong. Treat
`audit:list` as headerless CSV.

Also new since this was written and **not** covered below: a 16 KiB size gate
(`TOON_VERIFY_MAX_BYTES`, `libs/generic/result-encoding/src/encode.ts:74`) skips
round-trip verification and forces JSON for lists above that size.

And a fifth format has since been added: **`format: md`** — a markdown table,
display-oriented and lossy (never round-tripped; `decode()` throws for it). It sits
in the same capability class as `csv`/`tsv` (flat-object arrays only) and is
**opt-in only, never auto-selected** — `bestCompactFormat`/`chooseFormat` still
only ever auto-pick `toon` or `json`
(`libs/generic/result-encoding/src/eligibility.ts`). Request it the same way as
`csv`: `_meta.format: "md"` / `?format=md`.
:::

## What changed

Tool results you read over MCP are **no longer always JSON**. To save tokens, the
server picks a compact format from each tool's output shape and serializes
`ToolResponse.data` into `content[0].text` accordingly. You don't request this —
it's delivered. Plan: `token-efficient-tool-result-formats-2026-06-06`.

Every compact payload **self-identifies** with a marker on its first line, so you
never have to guess:

```
format: toon
[3]{id,state,title}:
  WI-001,todo,Wire the encoder
  WI-002,passed,Add the schema
  WI-003,wip,Backfill list tools
```

* **No marker → it's JSON** (the assumed default; unmarked so bytes are unchanged).
* **`format: toon`** → TOON. The `[N]{cols}:` header names the row count `N` and
  the columns; each following indented line is one row, comma-separated, in column
  order. Nested values indent YAML-style. It is a lossless JSON superset — read a
  cell as the JSON value it represents (`null` is `null`, `42` is a number, a
  quoted `"…"` is a string with escapes).
* **`format: csv`** / **`format: tsv`** → a header row then comma/tab-separated
  rows, RFC 4180 quoted (a field with a delimiter/quote/newline is `"…"`, embedded
  quotes doubled). CSV is **lossy** — every cell is a string; there are no types or
  nulls. Only flat tools opt into it.
* **`format: md`** → a markdown table (display-oriented, lossy, never decoded
  back). Same eligibility as CSV/TSV (flat-object arrays only) and likewise never
  auto-selected — request it explicitly.

## Where the envelope went

Compact tabular formats can't hold a pagination cursor inside the table, so the
**envelope rides in `_meta`**, not the body:

* `_meta.format` — the format that was actually served.
* `_meta.nextCursor` — the pagination cursor (was `ToolResponse.nextCursor`).
* `_meta.degraded` / `_meta.degradedReasons` — partial-result flags.
* `_meta.formatFallback: true` — the server downgraded from the requested/ideal
  format (e.g. you asked for CSV on a nested shape, or TOON couldn't represent the
  data losslessly). The payload in `content[0].text` is still correct; just note it
  isn't what was nominally requested.

**The row count is in the TOON header** (`[N]{…}`), not a `count` field — list
tools dropped their `{ ok, count, items }` wrapper; `data` is the array directly.

## Forcing JSON (or another format)

The format is a **client-process knob**, never something you put in tool *args*.
If you (or a programmatic consumer) need lossless JSON for round-tripping or
exact parsing:

* **MCP** — pass `_meta.format: "json"` on the `tools/call`, or add `?format=json`
  to the MCP connection URL. `?format=csv` / `compact` also work.
* **HTTP** — `?format=json` (or `Accept: application/json`) on the request.
* **structuredContent** — `?structured=1` (or `_meta.structured: true`) also
  attaches the lossless structured JSON as `structuredContent` alongside the
  compact text, for clients that render it separately. Off by default.

## The lossless guarantee (why a list sometimes comes back as JSON)

`@toon-format/toon` is lossless in the common case but has round-trip bugs on
pathological keys and on certain string values containing structural characters
(backticks, colons, `→`) in its nested-list form. The encoder **verifies the
round-trip** (encode → decode → compare) and falls back to JSON whenever it
doesn't hold — so you are **never handed a compact payload that doesn't decode
back to the original**. Practical consequence: a list whose rows carry rich
markdown text or nested blobs (e.g. `work_items:list` with non-null `payload`)
may arrive as JSON with `_meta.formatFallback: true`. That's the safety net
working, not a bug. Flat/uniform list tools reliably arrive in a compact format.
(See the Superseded note at the top: `audit:list` specifically is now a Tier-3
**headerless-CSV** tool, not TOON.)

Implementation: `libs/generic/result-encoding` (encoder + eligibility) and
`libs/generic/tooldef/src/serialize-result.ts` (the single serializer every
transport calls). Contract reference: [Transports → Result formats](/internal/docs/endpoint-system/transports).
