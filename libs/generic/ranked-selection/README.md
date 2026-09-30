# @papercusp/ranked-selection

Select an ordered menu of participants from a ranked candidate list, under a
**named bounds policy** that several call sites can share.

Zero I/O, zero domain coupling. The candidate type is a type parameter; the only
thing this library asks of a candidate is a stable identity, which you project.

```ts
import {
  configureSelectionPolicies,
  selectionPolicy,
  selectRanked,
} from '@papercusp/ranked-selection';

// once, at host startup
configureSelectionPolicies({
  'rubric-vetting': { min: 1, max: 2 },
  'acceptance-grading': { min: 1, max: 2 },
});

// at each call site
const menu = selectRanked({
  qualified,           // cleared your relevance/quality floor, best first
  allCandidates,       // the full ranked pool (fill source), best first
  bounds: selectionPolicy('acceptance-grading'),
  identity: (c) => c.ownerId,
  isSelectable: (c) => c.reachable,
});
// → [{ candidate, via: 'floor' }, { candidate, via: 'minimum' }, …]
```

## The two behaviours that matter

**Fill to `min`, never to `max`.** Qualified candidates are taken best-first up
to `max`. Only when that yields fewer than `min` does the selector reach into the
full pool — and it stops at `min`. Filling to `max` would quietly turn a cap into
a quota, pulling unqualified candidates in whenever the qualified pool merely ran
short.

**A fill is labelled, never blended.** Every pick carries
`via: 'floor' | 'minimum'`. A caller that cannot distinguish a qualified pick
from a below-floor fill will eventually treat them as equivalent evidence.
`outranks('floor', 'minimum') === true` is the generic kernel of "a below-floor
participant must not silently supersede a qualified one" — a rule that is only
expressible because the label is on the record.

A minimum that can only be filled by an *unselectable* candidate stays
**unfilled**. An honest short menu beats an unusable pick.

## Why the policy registry exists

Not for convenience. When two call sites are supposed to agree on a bound and
each hard-codes its own copy — or worse, one carries the number only in prose
documentation telling an operator to pass it by hand — they will drift, and
nothing will report it. The registry makes the shared setting a single runtime
value both sites read.

`selectionPolicy()` **throws** on an unknown key rather than falling back to a
built-in default. A silent default would reintroduce exactly the drift the
registry removes, while looking like it worked.

The registry is pinned through `@papercusp/module-singleton`, so a duplicated
module record (a bundled copy beside source, a bare-specifier and relative-path
import of the same file, a symlinked `node_modules` entry) cannot split it into
two registries that answer each other's reads with `undefined`.

## Delivery is not this library's business

`selectRanked` returns an **ordered menu**. Whether you wake the whole menu at
once, or advance through it one at a time carrying prior results forward, is the
caller's decision. This library never delivers anything.
