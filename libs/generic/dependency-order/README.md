# @papercusp/dependency-order

Order nodes so every node's dependencies come **first**, and group each dependency
cycle into a single batch instead of failing.

Any sweep that reasons about a unit using context derived from its dependencies
gets better results processing leaves first. The alternative most sweeps use
today is glob order, which is arbitrary.

```ts
import { orderByDependencies } from '@papercusp/dependency-order';

const { groups, order, cycles, external } = orderByDependencies({
  nodes: files,                                  // everything to visit
  dependenciesOf: (f) => importsOf(f),           // edges: dependent -> dependency
  key: (f) => f.path,                            // identity (see below)
});

for (const group of groups) {
  // group.nodes.length > 1 iff group.cyclic — process it as one batch.
}
```

## Three decisions worth knowing

**Cycles are normal, not an error.** A live import graph contains cycles (and
near-cycles through barrel files) as a matter of course, so a topological sort
that throws on one is unusable here. Each strongly-connected component is emitted
as one `DependencyGroup` with `cyclic: true` — the only honest answer when no
order within the group is more correct than any other.

**The edge source is injected.** `dependenciesOf` is a parameter, so this lib
never depends on a particular graph provider. A utility this simple must not
inherit the availability of a code-graph service, so a plain import scan is an
equally first-class edge source.

**Unknown dependencies are reported, not dropped.** A dependency absent from
`nodes` (an external package, a path outside the sweep) comes back in `external`
and imposes no ordering. A silently dropped edge is indistinguishable from a
graph that never had one.

## The sharp edge: `key`

Without `key`, identity is the node value itself — string equality for strings,
**reference identity** for objects. If `dependenciesOf` returns a freshly
constructed object rather than the very object from `nodes`, that edge reads as
*external* and constrains nothing. Pass `key` whenever nodes are objects.

## Guarantees

- **Iterative**, never recursive: a deep real-world import graph would overflow a
  recursive Tarjan's call stack, and it would do so far from the cause. Covered by
  a 10k-node chain test and a 10k-node cycle test.
- **Deterministic**: group membership is ordered by input position, so repeated
  runs over the same graph produce identical output.
- A **self-dependency is ignored** — it constrains nothing, and reporting it as a
  one-node "cycle" gives a caller nothing to act on.
- Zero I/O, zero domain coupling, zero runtime dependencies.
