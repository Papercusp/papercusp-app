# @papercusp/linkable-edges

A generic **typed-entity graph** — polymorphic, directed, typed edges between
`{kind, ref}` object references, over an injected store. Zero I/O in the core,
zero runtime deps, zero domain coupling.

## Why

Lots of relationships across a system are the same shape: *issue **blocks** plan*,
*work-item **duplicates** work-item*, *issue **fixes** issue*, *object **tagged**
topic*. Rather than a bespoke join table per pair, model them all as one edge:

```
src {kind, ref}  —(rel)→  dst {kind, ref}
```

One store, queried by direction. "What does X block?" is `listOut(X, {rel:'blocks'})`;
"what blocks X?" is `listIn(X, {rel:'blocks'})`. Directionality is the query, not a
second relation type.

## What's in it

| Export | What |
|---|---|
| `ObjectRef` | A graph node: `{ kind, ref }` — `kind` is the object type, `ref` its id within that type. |
| `LinkRow` | A materialised edge: `{ id, src, dst, rel, created_by, created_ts }`. |
| `LinkableStore` | The store port: `link` / `unlink` (both idempotent on `(src,dst,rel)`) + directional `listOut` / `listIn` (optionally rel-filtered, ordered `(created_ts, id)` asc). |
| `TAG_REL` | The `'tagged'` relation used by Taggable. |
| `InMemoryLinkStore` | A zero-I/O backend — a test double, or a process-local graph. |
| `LinkBackedTaggable` / `TaggableStore` | Taggable rides Linkable: a tag IS an `object →tagged→ {kind:'topic', ref:<slug>}` edge, so `listTagged` is a reverse-edge lookup. Works over ANY `LinkableStore`. |
| `InMemoryTaggableStore` | `LinkBackedTaggable` pre-wired over an `InMemoryLinkStore`. |

## The seam — inject the store

The lib names no consuming app and holds no persistence. The host implements
`LinkableStore` against its own backend (Postgres, etc.), owns identity (passes
`created_by`) and the clock (passes an ISO `created_ts`):

```ts
import { type LinkableStore, LinkBackedTaggable } from '@papercusp/linkable-edges';

class PgLinkStore implements LinkableStore {
  /* … link / unlink / listOut / listIn over your edge table … */
}

const links = new PgLinkStore(/* host bindings */);
await links.link({ kind: 'issue', ref: 'I-7' }, { kind: 'plan', ref: 'p-9' }, 'blocks', {
  created_by: 'alice',
  created_ts: new Date().toISOString(),
});

// Taggable for free over any LinkableStore:
const tags = new LinkBackedTaggable(links);
await tags.addTag({ kind: 'issue', ref: 'I-7' }, 'release-blocker', { created_ts: new Date().toISOString() });
```

## Conformance — prove your backend matches

Any `LinkableStore` backend proves swappability against the same assertions the
in-memory double passes. The suite imports `vitest`, so it lives behind the
`./conformance` subpath (not the package barrel):

```ts
import { describeLinkableStoreConformance } from '@papercusp/linkable-edges/conformance';

describeLinkableStoreConformance('PgLinkStore', () => new PgLinkStore(/* … */), {
  ready: async () => /* skip when the DB isn't reachable */ true,
});
```

The cases mint unique ids per run, so the suite is safe against a shared live
table without a cleanup hook.

## Tests

`npm test` (vitest) — the in-memory conformance suite plus the Taggable
behaviour (a tag is an `object →tagged→ topic` edge).
