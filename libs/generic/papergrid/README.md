# papergrid

Generic data-grid building blocks. Three packages, each solving a different
problem. Pick by what you're rendering, not by name.

## Decision tree

```
Need a grid?
│
├── Rendering arbitrary JSX per cell (pills, hover popovers, qty steppers)?
│   └── @papercusp/grid-core → RichGrid
│       (DOM-based, CSS-grid layout, optional virtualization)
│
├── Rendering a flat scalar/number/text dataset, want canvas perf?
│   └── @papercusp/grid-core → DataGridShell
│       (canvas wrapper around glide-data-grid, headers + data shape)
│
├── Just need a styled HTML <table> with built-in cell types?
│   └── @papercusp/grid-core → GridTable
│       (declarative, no virtualization, fits CMS-style admin pages)
│
└── Search-driven view over a very large cold catalog (50k+ rows)?
    └── @papercusp/bloom-grid → useBloomQuery + createBloomHandler
        (Bloom-filter optimized client/server pair)
```

## Packages

- **[`@papercusp/grid-core`](./grid-core/README.md)** — The shared primitive set:
  RichGrid (DOM), DataGridShell (canvas), GridTable (declarative HTML),
  theme tokens, sort util, hover-expand state machine.

- **`@papercusp/grid`** — Compatibility re-export of `grid-core`. Kept while
  consumers migrate; new code should import from `grid-core` directly. The
  shop-domain helpers (`BulkOrderGrid`, `formatCentsForRegion`, region
  helpers) used to live here — they moved to `@papercusp/ui` on 2026-04-26
  because they don't belong in the shared papergrid submodule.

- **[`@papercusp/bloom-grid`](./bloom-grid/README.md)** — Search-driven grid
  optimized via Bloom filters. Client (`useBloomQuery`,
  `useInfiniteBloomQuery`) + server (`createBloomHandler`) + row store.
  Use only for very large cold datasets.

## Domain-specific grids built on top

- **`BulkOrderGrid`** (in `@papercusp/ui`) — wholesale procurement grid. Wraps
  RichGrid; adds tier rail, summary bar, qty steppers, hover-expand with
  product detail, region-aware money formatting. Lives in `@papercusp/ui`
  rather than papergrid because the procurement logic is shop-specific.
  See `libs/ui/src/components/BulkOrderGrid.md` for the full breakdown.

- **`WholesaleGlideGrid`** (in `@papercusp/ui`) — alternative wholesale grid
  using DataGridShell (canvas). Used where row count makes DOM
  rendering too slow.

## Usage as a git submodule

```bash
git submodule add git@github.com:papercupai/papergrid.git libs/papergrid
```

Then in your root `package.json`:

```json
"workspaces": ["apps/*", "libs/*", "libs/papergrid/*"]
```

## Used by

- `@papercusp/ui` (BulkOrderGrid, WholesaleGlideGrid)
- `apps/shop` and `apps/shop-app` (procurement, catalog browsing)
- `apps/papercup` (every flat-list view: /projects, /timeline, /portfolio,
  /directives, /departments, /messages, /projects/[id], /directives/[id])
- `apps/web` (admin /procurement)
