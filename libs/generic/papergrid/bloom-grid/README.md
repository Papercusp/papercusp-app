# @papercusp/bloom-grid

Search-driven grid for very large cold catalogs. Client and server pieces
that minimize bytes-on-the-wire by skipping rows the client already has.

## When to use

Use bloom-grid when **all** of these hold:

- Your dataset is large (think 10k+ rows the user might filter through)
- Most rows don't change between page loads (the catalog is mostly cold)
- Repeated filter/sort traversals would otherwise re-fetch huge result
  sets

If your data changes often or fits comfortably in memory, this is overkill —
use `RichGrid` with paging or a normal SQL `LIMIT`/`OFFSET` instead.

## How it works

The client maintains a Bloom filter of `{id, version}` pairs it already has
in its local row store. On each query:

1. Server runs the filter/sort and returns a **manifest** — just `(id, v)`
   pairs for the matching rows.
2. Client compares the manifest against its bloom filter; identifies rows
   it's missing or has a stale version of.
3. Server sends only those missing/stale rows as a second-pass payload.
4. Client merges into its row store and renders.

Net effect: a user paging through 50k SKUs only ever downloads each row
once (or once per version bump), regardless of how many times they re-sort
or re-filter.

## Architecture

```
┌──────────────────────┐                  ┌──────────────────────┐
│  React useBloomQuery │ ── filter/sort ─►│  createBloomHandler  │
│  (client component)  │                  │  (server route)      │
│                      │ ◄─ manifest ─────┤                      │
│  RowStore            │ ── bloom ───────►│  loadManifest()      │
│  (local cache)       │ ◄─ missing rows ─┤  loadRows(ids)       │
│                      │                  │  count(filter)       │
└──────────────────────┘                  └──────────────────────┘
```

## Public surface

```ts
import {
  createBloomHandler,        // server: wires loadManifest/loadRows/count
  type BloomHandlerAdapters,
  createRowStore,            // local row cache + bloom-filter snapshot
  type RowStore,
  type RowStoreOptions,
  type Versioned,            // {id: string, v: number}
  type ManifestEntry,
  type BloomQueryRequest,
  type BloomQueryResponse,
} from '@papercusp/bloom-grid';

// Client (in a 'use client' module):
import { useBloomQuery, useInfiniteBloomQuery } from '@papercusp/bloom-grid/client';
```

`useBloomQuery` is **not** re-exported from the package root — only from
`@papercusp/bloom-grid/client`. The reason: server routes that import the
root pull in the rest of the package (which is pure JS, no React), while
the client hooks are gated behind `'use client'`. Server bundles never
load the React deps.

## Server-side wiring

```ts
import { createBloomHandler } from '@papercusp/bloom-grid';

const handle = createBloomHandler<Product, ProductFilter>({
  loadManifest: ({ filter, sort, limit, offset }) =>
    db.products.findIds({ where: filter, orderBy: sort, limit, offset }),

  loadRows: (ids) =>
    db.products.findMany({ where: { id: { in: ids } } }),

  count: (filter) =>
    db.products.count({ where: filter }),
});

// Plug into your route handler:
export async function POST(req: Request) {
  const body = await req.json() as BloomQueryRequest<ProductFilter>;
  return Response.json(await handle(body));
}
```

The manifest comes back with `(id, v)` pairs; you decide what `v` is for
your domain. Common patterns: `updated_at` epoch, content hash, or a
monotonic version counter on the row.

## Client-side wiring

```tsx
'use client';
import { useBloomQuery } from '@papercusp/bloom-grid/client';

function Catalog({ filter }: { filter: ProductFilter }) {
  const { rows, total, isLoading } = useBloomQuery<Product, ProductFilter>({
    endpoint: '/api/products/bloom',
    filter,
    sort: 'name',
    limit: 100,
    offset: 0,
  });

  return (
    <RichGrid<Product>
      rows={rows}
      columns={columns}
      getRowId={(p) => p.id}
    />
  );
}
```

The hook keeps a per-endpoint `RowStore` in memory. `useInfiniteBloomQuery`
adds offset paging on top — pass it to RichGrid's `virtualMode` for
incremental loading.

## File layout

```
bloom-grid/
├── README.md                    ← you are here
├── package.json
├── src/
│   ├── index.ts                 Public root exports (no React)
│   ├── client.ts                useBloomQuery, useInfiniteBloomQuery
│   ├── server.ts                createBloomHandler
│   ├── protocol.ts              Wire-format types
│   ├── rowStore.ts              Local cache + bloom-filter management
│   ├── rowStore.spec.ts
│   ├── server.spec.ts
│   ├── useBloomQuery.ts
│   └── useInfiniteBloomQuery.ts
└── tsconfig.json
```

## Used by

The shop catalog (`apps/shop`, `apps/shop-app`) for large product browsing
where the same SKU set is paged through repeatedly under different filters.
Not used in `apps/papercup` — its panels are small enough that direct
Zero subscriptions are simpler.
