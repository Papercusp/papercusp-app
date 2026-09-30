# A proxied tool going BULK blanks its admin-UI consumers — unwrap results[0]
URL: /internal/docs/agent-insights/admin-route-must-unwrap-bulk-tool-envelope

When a defineTool the /admin route proxies is migrated to the _bulk { ok, results, counts } envelope, the route's generic unwrap() forwards the envelope verbatim and any single-object UI consumer (e.g. the Plans editor reading data.raw/prose) gets undefined → renders BLANK with no error. Fix: unwrap results[0] in the route; if a payload-diet also dropped a field the UI round-trips (raw), restore it behind an opt-in flag that's also in the SWR cache key.

import { Aside } from '@astrojs/starlight/components';

## Symptom

Select a plan in the Plans admin tab and the **detail body renders BLANK** — the
header (title/tabs) shows, but the markdown pane has zero height, zero children,
zero text. No error toast, no spinner, no "Couldn't load the markdown renderer"
fallback. It looks like "selection works but the content vanished."

The give-away in a live DOM probe: `.pc-md-preview` exists but `h:16,
childCount:0, textLen:0`, and the value React handed `<MarkdownPreview>` is the
empty string — while the plan's body (30 KB+) is sitting un-read one level down
in the server response.

## Root cause — a proxied tool quietly became BULK, and the route still passthrough-unwraps

Two independent server changes compounded:

1. **`plans:get` was migrated to the bulk envelope.** Per
   [bulk-tool-contract-2026-06-22](/internal/docs/agent-insights/bulk-tool-contract-2026-06-22),
   it now runs through `runBulk` → `bulkContent` and returns
   `{ ok, results: [plan], counts }` — **even for a single slug**. The plan
   object moved from the top level into `results[0]`.

2. **The admin route proxy didn't unwrap it.** The
   [admin-route-tool-proxy](/internal/docs/agent-insights/admin-route-tool-proxy)
   shape ends in a generic `unwrap(result)` that just extracts the tool's
   `content[].text` and `JSON.parse`s it — a **verbatim passthrough**. So
   `/api/admin/plans/get` started returning the whole `{ ok, results, counts }`
   envelope to the browser.

The UI consumer is single-plan: `usePlan` → `fetchPlan` (`plans-api.ts`) types
the response as one `PlanGetResult`, and `PlanDetail` reads `data.raw ??
data.prose` straight off it. Against the envelope, `data.raw`/`data.prose` are
both `undefined` → `MarkdownPreview` gets `''` → blank. The header still shows
because its title falls back to the slug, which masks the break.

`unwrap()` is shape-agnostic: it hands the client whatever the tool returned. The
day a proxied tool adopts the keyed-array envelope, **every single-object UI
consumer silently starts receiving `{ ok, results, counts }`** and reading
`undefined` off it. There's no type error (the route is `unknown`-bodied) and no
runtime throw (the UI just renders empty). Audit consumers when you bulk-ify a
proxied verb.

## Second gotcha — the payload diet dropped a field the UI round-trips

`plans:get` full mode also **dropped `raw`** (P-008 token-diet:
`raw` duplicated `prose` + structured frontmatter, doubling agent tool-output;
"exact raw bytes live behind plans:export"). But the Plans **Edit** mode
round-trips the *whole document* through `plans:set-content`, whose compare-and-swap
hashes the exact raw bytes — and `set-content` guards `would_orphan_frontmatter`.
Reconstructing `raw` from `prose` + structured frontmatter would **not byte-match**
the CAS hash, so prose-only is not a substitute. Read needs `prose`; edit needs `raw`.

## The fix (both server-side, in operator-core)

1. **Route: unwrap `results[0]` for the `get` verb.** A dedicated `unwrapBulkGet`
   (not the generic `unwrap`) pulls the single plan out of the envelope. When the
   tool returns `{ ok: false, error: "not_found" }` in `results[0]` (the not-found
   shape), that object passes through as-is; if `results` is somehow empty, a
   fallback `{ error: { code: 'not_found', message: 'Plan not found.' } }` is
   returned. A bare `{ error }` at the top level (trust/validation failure — never
   the bulk shape) passes through unchanged. This restores the route's documented
   contract: *present clean single-object shapes to client code.*

   ```ts
   // routes/admin/plans.ts
   if (verb === 'get') body.includeRaw = true;          // ← opt into raw for the UI
   const result = await handleHttpToolRequest({ /* … */ }, HOST_EXTRAS);
   return verb === 'get' ? unwrapBulkGet(result) : unwrap(result);
   ```

2. **Tool: opt-in `includeRaw` (default OFF).** Agents keep the slim payload; the
   admin route sets `includeRaw: true` so full mode re-attaches `raw: parsed.raw`.
   The UI's existing `data.raw ?? data.prose` then renders read and round-trips edit.

3. **Put the opt-in flag in the SWR cache key.** `plans:get` is `cachedRead`-backed
   keyed on `{ slug, harness, mode, heading }`. `includeRaw` is **output-determining**,
   so it MUST join the key — otherwise a slim agent-cached entry (no `raw`) is served
   to a UI caller that asked for raw, and the editor breaks *intermittently* on cache
   state. (Mirror of: any new response-shaping arg belongs in the cache key.)

4. **UI: distinguish `not_found` from a real server error.** `PlanDetail` now checks
   `data.error === 'not_found'` and renders a calm "Plan not found." message instead
   of the alarming "Server: not\_found". This matters because `not_found` is a **benign
   empty state** — the plan lives in a different pot's harness, was deleted, or hasn't
   synced yet. It surfaces conspicuously in the Create tab when the harness-picker
   shows a cross-pot plan the current harness doesn't own.

## The generalizable checklist

When you migrate a `defineTool` that an `/admin` route proxies to the bulk
`{ ok, results, counts }` envelope:

* **Grep the route's read verbs for single-object UI consumers.** Anything that
  reads `data.<field>` off the response (not `data.results[*].<field>`) needs an
  `unwrap-results[0]` step at the route, or it renders empty.
* **Don't rely on the generic `unwrap()`** for a now-bulk verb — it's a passthrough.
* **If a payload diet drops a field**, check whether any consumer *round-trips the
  whole record* (write-back / CAS). Those need the dropped field restored behind an
  opt-in flag — and reconstruct-from-parts is not equivalent if a hash/CAS is involved.
* **Any response-shaping flag goes in the read tool's cache key.**

## Pointers

* Route fix + `unwrapBulkGet`: `packages/operator-core/lib/endpoint-route/routes/admin/plans.ts`
  (unit-tested in `plans.unwrap.test.ts`).
* `includeRaw` + cache key: `packages/operator-core/lib/agent-tools/plans/get.ts`.
* UI consumer: `apps/operator/app/admin/plans/PlanDetail.tsx` (`data.raw ?? data.prose` for
  read/edit; `data.error === 'not_found'` handled as a calm benign state — "Plan not found."
  instead of "Server: not\_found" — so cross-harness pot plans in the Create tab don't alarm),
  `plans-api.ts` (`fetchPlan`, mode:'full').
* Related: [bulk-tool-contract-2026-06-22](/internal/docs/agent-insights/bulk-tool-contract-2026-06-22),
  [admin-route-tool-proxy](/internal/docs/agent-insights/admin-route-tool-proxy),
  [caching-an-expensive-tool-read](/internal/docs/agent-insights/caching-an-expensive-tool-read).
