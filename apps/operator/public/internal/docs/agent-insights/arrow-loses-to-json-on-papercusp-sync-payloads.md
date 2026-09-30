# Arrow loses to JSON on Papercusp sync payloads (and why the estimate said otherwise)
URL: /internal/docs/agent-insights/arrow-loses-to-json-on-papercusp-sync-payloads

A measured negative result — Apache Arrow is net slower than JSON for our sync reads. Includes the two estimation mistakes that made it look like a win, both of which generalize.

**Verdict: do not convert Papercusp sync reads to Apache Arrow.** It is \~21ms/wave
*slower* end-to-end on real data. This page exists so nobody re-proposes it from first
principles, and — more usefully — so the two mistakes that made it look attractive don't
get repeated on the next format decision.

Measured 2026-07-26 with `apache-arrow` v21.2.0. Full record: plan
`arrow-zero-copy-sync-reads-2026-07-26` D-003.

## The numbers

Three fattest sync payloads, pulled live from `:3070`:

```
                        JSON        Arrow      delta
  server encode        11.5 ms      41.3 ms   +29.8 ms
  client decode        11.5 ms       2.5 ms    -9.0 ms
  NET                  23.0 ms      43.8 ms   +20.9 ms   <== Arrow LOSES
  bytes on wire         3.97 MB      3.23 MB      -19%
```

Arrow's client decode really is \~4.6× faster and the wire really is 19% smaller. But
`tableFromJSON` encode costs 3.6× what `JSON.stringify` does, and that swamps both wins.

## Mistake 1 — the estimate used a synthetic payload

The figure that motivated the work (55.1ms for the JSON path) came from a hand-built
12,000-row payload of uniform wide rows. Real sync payloads are 153–2,760 rows, and
**V8's `JSON.parse` is optimized C++** — it handles the real ones in 3–9ms, not 20ms.

The synthetic number was 2–4× too pessimistic, which was enough to invert the conclusion.

> **Generalizes to:** never size a serialization-format decision on synthetic data. Pull
> the real payload. It is usually one `curl` against the running operator.

## Mistake 2 — our rows are not tabular

Arrow's advantage is a columnar layout over flat, typed columns. Ours are nested blobs:

| query             | rows  | size    | shape                                                            |
| ----------------- | ----- | ------- | ---------------------------------------------------------------- |
| `plans.items`     | 2,760 | 1.64 MB | 3 cols — **92% of bytes is one nested `item` dict per row**      |
| `plans.attention` | 153   | 1.53 MB | 7 cols — **98% of bytes is a nested `items` list** (\~10 KB/row) |
| `plans.list`      | 880   | 0.80 MB | 22 cols — the most tabular, and the **worst** result             |

`tableFromJSON` cannot infer heterogeneous nested structures, so they degrade to
JSON-stringified strings held inside Arrow columns. That is still JSON parsing — just
deferred to field-access time, after you have already paid Arrow's encode.

Note the shape of the failure: `plans.list`, the *most* column-like of the three, came out
exactly break-even client-side (3.3ms vs 3.3ms) while costing +18.9ms to encode. More
columns did not help.

## What would have to change before re-measuring

The resolvers would have to emit **flat, typed, genuinely columnar rows**. That is
projection work, not a format change. If that ever lands and payloads are still large,
re-measure — but a format swap alone will not rescue this.

## The thing that was actually worth finding

The measurement's real value was diagnostic. Those three queries are 65% of a 5.94 MB
hydration wave **and** the three slowest resolvers (905 / 620 / 577 ms). Size and latency
share one cause: the `plans.*` sync resolvers do no projection at all — they pass through
whatever `callPlansRead()` returns, whole nested object per row.

Tracked as **WI-5910**. The chokepoint is `callPlansReadRaw` in
`packages/operator-core/lib/agent-tools/plans/read-dispatch.ts` (per the 2026-07-19
whole-app payload audit): it is the single in-process dispatch feeding both the
`/api/admin/plans/*` REST routes and the `@papercusp/sync` `plans.*` resolvers, and
agent/MCP sessions do not reach it — so a display projection there is UI-only and cannot
regress the agent-facing payload tier.

## Two adjacent facts established by the same investigation

* **The copy into the webview is 4.6ms per 6.65MB.** So true shared memory — an
  mmap'd store, or leaving the webview for a native/Electron renderer — is worth \~4.6ms.
  That is not a performance argument. If webview replacement is ever revisited, argue it
  on memory footprint (EI-278 records sustained `/adv` fetch load as the dominant
  workload behind a 16GB webview OOM), not on copies.
* **Tauri 2.11.5 supports raw byte IPC bodies.** `InvokeResponseBody` has a
  `Raw(Vec<u8>)` variant and `Channel::send(data) where TSend: IpcResponse` accepts it.
  The `"Tauri's IPC serializer is JSON-based"` comment in `ipc-stream.ts` is v1-era and
  stale; every non-SSE sync response body is currently base64'd out and back (\~12ms/wave).
  Tracked as **WI-5911** — format-independent, so this verdict does not touch it.

## The pattern worth carrying

Three separate comments in this subsystem asserted constraints that had quietly expired
and were being obeyed anyway: the batcher's 6-connection-per-host justification
(webapp-era, dead once desktop moved to IPC), `ipc-stream.ts`'s JSON-serializer claim
(Tauri v1-era), and a stale client-side `AttentionKind` mirror. Each cost real time.

When a comment states a constraint that is load-bearing for a design decision, **re-verify
it before building on it** — especially a comment that predates a platform pivot.
