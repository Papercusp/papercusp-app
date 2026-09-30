# @papercusp/cache

A generic, **workspace-scoped, tag-based** cache. Pure algorithm + injected storage seam; zero domain coupling, zero runtime deps.

```ts
import { Cache } from '@papercusp/cache';

const cache = new Cache({ maxL1Entries: 10_000 /*, generationStore, clock, default TTLs */ });

// getOrSet(workspaceId, key, factory, { tags, softTtlMs, hardTtlMs, cacheEmpty })
const ready = await cache.getOrSet('ws-1', 'readiness:WI-C', () => computeReadiness('WI-C'), {
  tags: ['item:WI-C', 'item:WI-A', 'item:WI-B'], // its data dependencies
});

// invalidation = bump a per-(workspace,tag) generation; every entry carrying the tag is
// lazily treated as stale on its next read (no eager purge).
cache.invalidateByTag('ws-1', 'item:WI-A');
```

## Model
- **Tag-based, bumpable-generation** invalidation (Fastly surrogate-keys / Drupal cache-tags). An entry records the generation of each tag at build time; an invalidation increments the tag's generation; an entry stamped with an older generation is stale.
- **Workspace-scoped** (mandatory): keys *and* tags are namespaced per `workspaceId` — two workspaces can never collide (cross-workspace-leak guard). A missing `workspaceId` throws.
- **L1** in-process LRU (bounded).
- **Single-flight**: concurrent `getOrSet` on the same key share one factory run.
- **Stale-while-revalidate**: past `softTtlMs` (but generation-fresh + within `hardTtlMs`) serves the stale value and rebuilds in the background; past `hardTtlMs` forces a blocking rebuild.
- **Race-safe**: generations are snapshotted *before* the factory runs, so an invalidation during a build marks the result stale on its next read (never masked).
- **Cold-bust**: `clearL1()` drops all L1 entries (used on a LISTEN/NOTIFY listener (re)connect, since fire-and-forget NOTIFYs missed during an outage are otherwise lost).

## Seam
The bumpable-generation store is injected (`GenerationStore`). An in-memory default ships; the host wires a LISTEN/NOTIFY-fed in-process map backed by Postgres (durable counters), so an L1 hit checks generations with no PG round-trip.

Part of `caching-layer-tag-eca-2026-06-22`.
