/**
 * Dependency-ordered traversal.
 *
 * Order a set of nodes so every node's dependencies are visited BEFORE it, and
 * mutually-dependent nodes travel together as one group. Any sweep that reasons
 * about a unit using context derived from its dependencies gets better results
 * processing leaves first; the alternative most sweeps use today is glob order,
 * which is arbitrary.
 *
 * Two properties are load-bearing, and both exist because the naive version of
 * this helper is wrong in a real repository:
 *
 *  1. CYCLES ARE NORMAL, NOT AN ERROR. Import graphs in a live tree contain
 *     cycles (and near-cycles through barrel files) as a matter of course. A
 *     topological sort that throws on one is unusable here. Each strongly-
 *     connected component is emitted as a single group instead, so a caller can
 *     process it as one batch — the only honest answer when no order within the
 *     group is more correct than any other.
 *
 *  2. THE EDGE SOURCE IS INJECTED. `dependenciesOf` is a parameter, so this lib
 *     never depends on any particular graph provider. That is deliberate: a
 *     utility this simple must not inherit the availability of a code-graph
 *     service, so a plain import scan is an equally first-class edge source.
 *
 * Zero I/O, zero domain coupling, zero dependencies — the consumer injects the
 * edges. The traversal is ITERATIVE (Tarjan with an explicit stack): a recursive
 * implementation overflows the call stack on a deep real-world import graph, and
 * it does so as a crash far from the cause.
 */

/** How to read a node's dependencies, plus optional identity. */
export interface DependencyOrderInput<T> {
  /** Every node to order. Duplicates (by identity/`key`) collapse to the first. */
  nodes: Iterable<T>;
  /**
   * The nodes that must be processed BEFORE `node` — i.e. what it depends on.
   * Edges point from dependent to dependency.
   */
  dependenciesOf: (node: T) => Iterable<T>;
  /**
   * Identity for a node. Defaults to the value itself (string equality for
   * strings, reference identity for objects). Supply this whenever a dependency
   * may be a DIFFERENT object than the one in `nodes` that it refers to —
   * otherwise the edge silently reads as external and imposes no ordering.
   */
  key?: (node: T) => string;
}

/** One unit of the emitted order: a single node, or a whole dependency cycle. */
export interface DependencyGroup<T> {
  /** Members, deterministically ordered by their position in the input. */
  nodes: T[];
  /** True iff these nodes are mutually dependent (`nodes.length > 1`). */
  cyclic: boolean;
}

export interface DependencyOrderResult<T> {
  /** Groups in dependency order: a group's dependencies appear in earlier groups. */
  groups: DependencyGroup<T>[];
  /** `groups` flattened — the traversal order for a caller that ignores cycles. */
  order: T[];
  /** Just the cyclic groups, so a caller can report them without re-scanning. */
  cycles: T[][];
  /**
   * Dependencies referenced by some node but absent from `nodes` — e.g. an
   * external package in an import scan. They are REPORTED rather than silently
   * dropped and impose no ordering, because a dropped edge that nobody can see
   * is indistinguishable from a graph that never had one.
   */
  external: T[];
}

/**
 * Order `nodes` so dependencies come first, grouping each cycle into one batch.
 *
 * A self-dependency is ignored: it constrains nothing, and treating it as a
 * cycle would report a degenerate one-node "cycle" that no caller can act on.
 */
export function orderByDependencies<T>(input: DependencyOrderInput<T>): DependencyOrderResult<T> {
  const { nodes, dependenciesOf, key } = input;
  const idOf = (n: T): unknown => (key ? key(n) : n);

  // Materialize the node set first: an index per node, first occurrence wins.
  const indexById = new Map<unknown, number>();
  const nodeList: T[] = [];
  for (const n of nodes) {
    const id = idOf(n);
    if (indexById.has(id)) continue;
    indexById.set(id, nodeList.length);
    nodeList.push(n);
  }

  const count = nodeList.length;
  const adjacency: number[][] = [];
  const externalById = new Map<unknown, T>();

  for (let i = 0; i < count; i++) {
    const out: number[] = [];
    for (const dep of dependenciesOf(nodeList[i])) {
      const id = idOf(dep);
      const target = indexById.get(id);
      if (target === undefined) {
        if (!externalById.has(id)) externalById.set(id, dep);
        continue;
      }
      if (target !== i) out.push(target); // self-edges constrain nothing
    }
    adjacency.push(out);
  }

  const UNVISITED = -1;
  const index = new Array<number>(count).fill(UNVISITED);
  const lowlink = new Array<number>(count).fill(0);
  const onStack = new Array<boolean>(count).fill(false);
  const componentStack: number[] = [];
  const groups: DependencyGroup<T>[] = [];
  let counter = 0;

  for (let root = 0; root < count; root++) {
    if (index[root] !== UNVISITED) continue;

    index[root] = lowlink[root] = counter++;
    componentStack.push(root);
    onStack[root] = true;
    // Explicit DFS stack: { node, next edge to consider }.
    const frames: { v: number; edge: number }[] = [{ v: root, edge: 0 }];

    while (frames.length > 0) {
      const frame = frames[frames.length - 1];
      const v = frame.v;

      if (frame.edge < adjacency[v].length) {
        const w = adjacency[v][frame.edge++];
        if (index[w] === UNVISITED) {
          index[w] = lowlink[w] = counter++;
          componentStack.push(w);
          onStack[w] = true;
          frames.push({ v: w, edge: 0 });
        } else if (onStack[w] && index[w] < lowlink[v]) {
          lowlink[v] = index[w];
        }
        continue;
      }

      frames.pop();
      if (frames.length > 0) {
        const parent = frames[frames.length - 1].v;
        if (lowlink[v] < lowlink[parent]) lowlink[parent] = lowlink[v];
      }

      if (lowlink[v] === index[v]) {
        // v roots a strongly-connected component: pop it off the component stack.
        const members: number[] = [];
        for (;;) {
          const w = componentStack.pop()!;
          onStack[w] = false;
          members.push(w);
          if (w === v) break;
        }
        // Deterministic within-group order, independent of DFS pop order.
        members.sort((a, b) => a - b);
        groups.push({
          nodes: members.map((i) => nodeList[i]),
          cyclic: members.length > 1,
        });
      }
    }
  }

  // Tarjan emits a component only after everything it can reach, and edges point
  // at dependencies — so components come out dependencies-first already.
  const order: T[] = [];
  const cycles: T[][] = [];
  for (const group of groups) {
    for (const n of group.nodes) order.push(n);
    if (group.cyclic) cycles.push(group.nodes);
  }

  return { groups, order, cycles, external: [...externalById.values()] };
}
