# @papercusp/facets

A domain-free **faceted-filtering** core. Given rows of any type `T` and a set of
facet definitions, it derives — **from the actual rows** — which facets are worth
showing and which values each has, with counts, and builds the filter predicate.

"Context-dependent" is the whole point: a facet with only one distinct value
across the rows can't filter anything, so it's hidden by default; values that
never appear never show up.

## The seam

The lib owns the algorithm (tally → hide-singletons → sort → cap → predicate).
The caller owns exactly one thing — how to pull a facet's value(s) out of a row —
via `FacetDef.extract`. That's how a session-search UI, a work-items list, and a
plans list can all share this with zero domain code in here.

```ts
import { computeFacets, facetPredicate, type FacetDef } from '@papercusp/facets';

const defs: FacetDef<Row, { color?: string }>[] = [
  { key: 'status', label: 'Status', extract: (r) => (r.active ? 'active' : 'ended') },
  { key: 'fleet',  label: 'Fleet',  extract: (r) => r.fleet ? { value: r.fleet, meta: { color: r.fleetColor } } : null },
  { key: 'owner',  label: 'Owner',  extract: (r) => r.owners },   // multi-valued
];

const groups = computeFacets(rows, defs);              // → pills (with counts)
const shown  = rows.filter(facetPredicate(defs, sel)); // AND across facets, OR within
```

- `extract` returns nothing / one / many values. `null` ⇒ this row has no value
  for the facet (not counted). An array ⇒ multi-valued facet.
- A value's opaque `meta` (color, label, …) rides through untouched — the core
  never reads it.
- `serializeFacetSelection` / `parseFacetSelection` give compact URL-safe state;
  `toggleFacetValue` toggles immutably. No React / URL-framework coupling.

Pure + synchronous. Anything async or server-side (e.g. re-querying a backend
for a wider window) is deliberately the caller's concern, not folded in.
