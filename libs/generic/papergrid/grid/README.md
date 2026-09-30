# @papercusp/grid

A thin **backward-compat re-export of [`@papercusp/grid-core`](../grid-core/README.md)**,
kept while consumers gradually migrate to importing `grid-core` directly.

```ts
// Everything from @papercusp/grid-core: RichGrid, DataGridShell, GridTable,
// applySort, useHoverExpand, theme tokens, …
export * from '@papercusp/grid-core';
```

## Status

This package adds no components of its own — it only forwards `@papercusp/grid-core`.
New code should import from `@papercusp/grid-core` directly; this alias exists so
existing `@papercusp/grid` imports keep resolving.

Shop-domain helpers (`BulkOrderGrid`, `formatCentsForRegion`, `getClientRegion`,
`Region`) moved to `@papercusp/ui` on 2026-04-26 — they did not belong in the
shared papergrid submodule. Update old imports:

```diff
- import { BulkOrderGrid } from '@papercusp/grid'
+ import { BulkOrderGrid } from '@papercusp/ui'
```

See the [`@papercusp/grid-core` README](../grid-core/README.md) for the full
component reference (RichGrid / DataGridShell / GridTable, sort + hover-expand
helpers, theme tokens).
