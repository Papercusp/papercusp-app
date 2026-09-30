# @papercusp/grid-core

The shared, domain-agnostic grid primitives. Three rendering strategies, one
theme, one sort helper.

```ts
import {
  RichGrid,           // DOM-based, JSX cells, optional virtualization
  DataGridShell,      // canvas wrapper around glide-data-grid
  GridTable,          // declarative HTML <table> with built-in cell types
  applySort,          // generic client-side sort helper
  useHoverExpand,     // debounced hover-expand state machine
  GRID_COLORS,        // theme tokens
} from '@papercusp/grid-core';
```

## At a glance

| Component | Layout | Cell type | Virtualization | Best for | Cap |
|---|---|---|---|---|---|
| **`RichGrid`** | CSS-grid + divs | Arbitrary JSX (you write `render(row)`) | Optional via `virtualMode` | Custom-styled rows: pills, qty steppers, hover popovers, detail-on-expand | A few thousand DOM rows; many more with virtual mode |
| **`DataGridShell`** | Canvas (glide-data-grid) | Built-in: text, number, boolean, custom cells via tokens | Native (canvas) | Flat catalogs, dense numeric tables, anywhere DOM perf hurts | 100k+ rows |
| **`GridTable`** | Native `<table>` | Declarative cell types via column `type:` | None | Admin pages, CSV-style displays, low row counts (<200) | Whatever the browser handles |

If you find yourself reaching for *both* JSX cells *and* 100k rows, you're in
the wrong place — that's the `@papercusp/bloom-grid` use case.

---

## RichGrid

DOM-based generic grid. Each cell is whatever React you want to put there.
The grid itself owns layout, header, sort, virtualization, and load-more —
you own data shape, cell content, and business logic.

### Core idea

You pass `columns: ColumnDef<TRow>[]` and `rows: TRow[]`. Each `ColumnDef`
declares its own `render(ctx) → ReactNode` where `ctx: CellRenderContext<TRow>`
gives you `{ row, rowIndex, rowBg, isSelected }`. **Important**: destructure
`{ row }` — `render: (row) =>` looks like it works but actually receives
the ctx object (so `row.harness_slug` etc. silently come back undefined).
The grid does CSS-grid layout via `gridTemplateColumns` derived from column
widths.

```tsx
import { RichGrid, type ColumnDef } from '@papercusp/grid-core';

interface Project {
  id: string;
  name: string;
  status: 'in_progress' | 'launched' | 'paused';
  budgetCents: number;
}

const columns: ColumnDef<Project>[] = [
  { key: 'name', header: 'Project', width: 3, sortKey: 'name',
    render: ({ row }) => <b>{row.name}</b> },
  { key: 'status', header: 'Status', width: 1, sortKey: 'status',
    render: ({ row }) => <StatusPill value={row.status} /> },
  { key: 'budget', header: 'Budget', width: 1, align: 'right',
    sortKey: 'budgetCents',
    render: ({ row }) => formatCents(row.budgetCents) },
];

<RichGrid<Project>
  rows={projects}
  columns={columns}
  getRowId={(p) => p.id}
/>
```

### Hooks RichGrid provides

| Prop | Purpose |
|---|---|
| `getRowId(row)` | Stable key for the row. Required. |
| `selectedRowKeys` | Controlled selection set. Optional. |
| `onRowClick(row)` | Click → activation handler. |
| `sortState`/`onSortChange` | Wire `applySort(rows, sortState)` in a memo. |
| `virtualMode` | `{ totalCount, rowAt(i), estimateSize, onRangeChange? }` for windowed render. |
| `onLoadMore` | Infinite scroll — fires when scroll reaches near-end. |
| `expandedRowKey` + `renderExpandedRow` | Single-row expand panel. |
| `expandedRowKeys: ReadonlySet<string>` | **Multi-row** expand. Combined with the single-key prop by union. |
| `onRowHover(row, idx)` | Mouse-enter callback (used by hover-detail UIs). |
| `getRowBg(row, idx, isSelected)` | Custom row background override (striping, highlights). |
| `rowProps(ctx)` | Per-row className / tabIndex / aria / focus events. |
| `headerStyle` | Override the sticky header style. |
| `renderLoadingRow(idx)` | Custom shimmer placeholder for the virtual range. |
| `scrollContainerRef` | Capture RichGrid's internal scroll element (e.g. for a parent virtualizer). |
| `inline` | Skip the outer flex + scroll wrapper; render as a fragment for parent-owned scroll. |
| `ColumnDef.cellStyle` | Per-column inline style override. |
| `ColumnDef.headerClassName` | Per-column header class. |

### Sort

```tsx
const [sortState, setSortState] = useState<RichGridSortState | null>(null);
const sortedRows = useMemo(() => applySort(rows, sortState), [rows, sortState]);

<RichGrid
  rows={sortedRows}
  sortState={sortState}
  onSortChange={setSortState}
  ...
/>
```

`applySort` is a non-mutating helper: numeric for `number` values,
`localeCompare` otherwise; nulls always last regardless of direction.
Designed for small client-side data. For large data sets, push the sort to
the data source (Zero `.orderBy(...)`, SQL `ORDER BY`, etc.) and skip the
helper.

### Virtualization

Pass `virtualMode` instead of `rows` when the dataset is too large to mount
everything:

```tsx
<RichGrid<Row>
  columns={columns}
  getRowId={(r) => r.id}
  virtualMode={{
    totalCount: totalKnownRows,
    rowAt: (i) => loadedPages.get(pageOf(i))?.[i % PAGE_SIZE],
    estimateSize: () => 44,
    onRangeChange: ({ start, end }) => prefetchRange(start, end),
  }}
/>
```

`rowAt(i)` may return `undefined` for unloaded rows; in that case the grid
calls `renderLoadingRow(idx)` (or shows "loading…").

### When NOT to use RichGrid

- Row count regularly exceeds ~5000 with rich JSX cells → DOM cost dominates.
  Switch to `DataGridShell` (canvas) or precompute and use a simpler layout.
- You only need a static admin table with built-in stepper / checkbox / price
  columns and no virtualization → `GridTable` is faster to author.
- You're rendering a search-driven view over a cold catalog → `bloom-grid`.

---

## DataGridShell

Thin wrapper around `@glideapps/glide-data-grid`. Canvas-based. Authors
define columns with the simple `headers: string[] + data: T[]` pattern (with
optional dot-paths) instead of glide's verbose `getCellContent` callback.

### Core idea

The wrapper handles:
- Dot-path resolution (`headers: ['user.email']` reads `row.user.email`)
- Title humanization (`'createdAt'` → `'Created at'`)
- Dark-theme integration via `glideTheme`
- Blank spacer columns
- Selection / cell-click / cell-edit hooks

You pass `headers`, `data`, optional formatters, and selection handlers.
You don't write `getCellContent` yourself.

```tsx
import { DataGridShell } from '@papercusp/grid-core';

<DataGridShell
  headers={['name', 'status', 'budgetCents', 'createdTs']}
  data={projects}
  formatters={{
    budgetCents: (v) => formatCents(v),
    createdTs: (v) => relativeTime(v),
  }}
/>
```

### Why canvas (vs RichGrid)

Glide's canvas renderer can scroll through 100k+ rows at 60fps because
nothing's mounted in the DOM. The trade-off: cells are drawn pixels, not
React. You can't put a `<HoverCard>` inside a cell. Custom interactive
"cells" are possible but require a separate `wholesale-cells` style of
custom-cell renderer registered with glide (see
`libs/ui/src/lib/wholesale-cells/canvas/` for examples).

### When to use

- Tabular data, mostly scalars
- High row count (>5000)
- You're displaying, not styling — pills, hover popovers, etc. don't fit
- Performance is the primary constraint

### When NOT to use

- You want JSX cells → `RichGrid`
- Row count is small and you want simplicity → `GridTable`
- SSR-rendered first paint matters (canvas is client-only)

---

## GridTable

Declarative HTML `<table>` that accepts the same `GridConfig` shape as
DataGridShell — same column definitions, same `headers`, same formatters —
but renders an actual `<table>` with built-in cell types (`stepper`,
`price`, `checkbox`, `expand`, etc.).

### When to use

- Static admin pages, CSV-style displays
- Row counts under a couple hundred
- You don't need virtualization
- You want column types declared (`type: 'stepper'`) rather than render
  callbacks (RichGrid) or canvas tokens (DataGridShell)
- You want SSR-rendered HTML in the first paint

```tsx
import { GridTable } from '@papercusp/grid-core';

<GridTable
  headers={['name', 'qty', 'priceCents', 'select']}
  data={items}
  columnTypes={{
    qty: 'stepper',
    priceCents: 'price',
    select: 'checkbox',
  }}
  onCellEdit={(row, key, value) => updateItem(row.id, key, value)}
/>
```

### Subrows

`GridSubTable` is a sibling export for nested rows — used in admin pages
that need an expand-to-reveal pattern without the full RichGrid expand
machinery.

---

## Helpers

### `applySort<T>(rows, sortState): T[]`

Non-mutating client-side sort. See the RichGrid section above for usage.
Numeric for `number`, `localeCompare` otherwise, nulls last regardless of
direction.

### `useHoverExpand({ delay, onExpand, onCollapse })`

Debounced hover-expand state machine. Returns `{ expandedKey, onEnter,
onLeave, onFocus, onBlur, cancel }`. Handles:

- Mouse-enter → set timer → expand after `delay`
- Mouse-leave → set timer → collapse after `delay` (allows brief re-entry)
- Keyboard `focus` immediately expands; `blur` immediately collapses
- Cleans up timers on unmount

Used by GridTable and BulkOrderGrid. Can be reused anywhere you need this
behaviour without re-implementing the timer dance.

### Theme tokens

`GRID_COLORS`, `glideTheme`, `TD_BASE`, `TH_BASE`, `STEPPER_BTN_STYLE`,
`badgeStyle()`, `rowBg()`, etc. Shared between all three grid components so
they stay visually consistent (dark theme, blue accent, alt-row striping).

---

## Where each grid is actually used

- **RichGrid**: `apps/papercup` — every flat-list view (Projects, Timeline,
  Inbox, Directives, Departments, Messages, Portfolio). Plus
  `BulkOrderGrid` (libs/ui) wraps RichGrid for the wholesale procurement
  surface.
- **DataGridShell**: `apps/papercup/HarnessConsoleView` (canvas, large row
  count). `WholesaleGlideGrid` in `libs/ui` for high-volume catalog
  scrolling.
- **GridTable**: smaller admin tables in `apps/web`, where SSR-first HTML
  matters and the row count is bounded.

---

## File layout

```
grid-core/
├── README.md                     ← you are here
├── package.json
├── src/
│   ├── index.ts                  Public exports
│   ├── RichGrid.tsx              (~780 LOC) DOM grid
│   ├── DataGridShell.tsx         (~620 LOC) Glide canvas wrapper
│   ├── GridTable.tsx             (~670 LOC) Declarative HTML table
│   ├── grid-config.ts            Column-config + formatter types
│   ├── grid-theme.ts             Token + style exports
│   ├── sort-util.ts              applySort
│   └── use-hover-expand.ts       Hover-expand state machine
└── tsconfig.json
```
