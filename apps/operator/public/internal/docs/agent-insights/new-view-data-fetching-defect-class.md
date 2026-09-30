# New-view data fetching: the four recurring defects and the library guard that catches them
URL: /internal/docs/agent-insights/new-view-data-fetching-defect-class

Every new sync-backed view kept re-introducing the same four fetch defects (waterfall refetch, oversized projection, unwindowed lists, misattributed slowness). Named here with their signatures, the measurement discipline, and the @papercusp/sync query-health observer that now warns on each.

## Why this doc exists

The owner kept catching the same class of bug in every NEW interface: the view works, but the first click is slow, and the explanation offered ("payload weight", "download+parse") is wrong. On 2026-07-18 (WI-5412, the Learning tab) all four shapes were present in one view at once, the misdiagnosis was made and corrected by the owner, and the class got a library-level guard. **If you are building a new `useSyncQuery`-backed view, read the checklist at the bottom before you ship it.**

## The four defect shapes

### 1. The args-flip waterfall

A query mounts with incomplete args (`{}`), fetches, then a dependency resolves (the hive list, a default selection), the args flip to `{hive}`, and the SAME query fetches again. The first fetch's work is thrown away; the first paint pays both, serially. With a heavy resolver that is 2 × 0.5–3s before anything renders.

**Signature:** two requests for the same queryName with different args within a couple seconds of mount.

**Fix:** gate the query with `enabled` until its inputs are actually resolved:

```tsx
const sync = useSyncQuery({ queryName, args: hive ? { hive } : {}, enabled: hiveReady });
```

where `hiveReady` means "the scope-defaulting read has SETTLED" (data present — even empty — or an explicit URL param), not "a scope value exists".

### 2. Oversized wire projection

The resolver ships fields no consumer renders. WI-5412's case: each ranked human-queue item carried a \~1KB `rank` breakdown + `impact` struct; across \~380 rows that was **65% of a 479KB payload** — and the UI rendered none of it. Slimming the resolver's wire projection (while the MCP tool kept the full shape) cut 479KB → 221KB.

**Fix:** the resolver projects what the view renders. Debug/ranking/explanation metadata stays on the tool surface, or ships on expand.

### 3. Unpaginated, unwindowed lists

Hundreds of rows in one result usually means hundreds of DOM nodes mounted on first paint (the Learning tab mounted 384 un-virtualized `<li>`s). Paginate server-side, or window the render (first page + a disclosure, or the virtualizer with `measureVariableHeight` when rows expand).

### 4. Misattributed slowness ("it's the download")

**On a loopback/desktop deployment, transfer is never the explanation** — 479KB over loopback is \~5ms. The real costs are (a) server compute in the resolver, (b) paying it twice (defect 1), (c) client parse + render (defects 2–3). WI-5412's resolver spent \~0.4s shipping 7,146 topic-tag ids OUT of Postgres and back IN via `ANY(...)` (`listIssues`' topic filter — now an `EXISTS` join, \~180ms).

**Discipline:** never explain slowness without a staged measurement. `curl -w %{time_total}` the `rest-query` endpoint per query (it was `rest-query-batch` until the batcher was dropped on 2026-07-26), then time the resolver's stages in a tsx script. The 2026-07-18 measurement contradicted the intuited explanation in under ten minutes.

## The library guard (auto-on in development)

`@papercusp/sync` now watches every `useSyncQuery` call site (`libs/generic/sync/src/observability/query-health.ts`, wired in `SyncContext.ts`) and **console-warns once per query per shape**:

* `waterfall` — args changed within 3s of a fetch that already ran → tells you to gate with `enabled`;
* `payload` — result over 256KB parsed → tells you to slim the projection;
* `rows` — over 1,000 rows in one result → tells you to paginate/window;
* `slow` — first load over 1s → tells you to time the resolver, not guess.

It is a no-op outside `NODE_ENV === 'development'`; thresholds are tunable via `configureQueryHealth(...)` (exported from `@papercusp/sync`). **Treat one of these warnings during development of a new view as a build defect, not noise.** If your view legitimately exceeds a threshold, say why in the PR/work item — don't silence the observer.

## Checklist for a new sync-backed view

1. Every query whose args depend on another read is gated with `enabled` until that read SETTLES.
2. The resolver projects exactly what the view renders — nothing ships "because the domain object has it".
3. Any list that can exceed \~100 rows is paginated or windowed before first ship.
4. Open the dev console once with the view mounted: zero `[sync query-health]` warnings.
5. If it still feels slow: measure (endpoint timing → resolver stages), then fix what the numbers say.
