/**
 * Pure, storage-agnostic analysis for the supported dependency graph.
 *
 * Edges use the store's waits-on orientation: `blocked` depends on `blocker`.
 * Identity is the canonical `(kind, ref)` tuple; aliases exist only so a caller
 * can prove that a declared endpoint resolves to a *different* canonical tuple.
 * Such an edge is reported as mismatched rather than silently normalized.
 *
 * Reachability is deliberately tri-state. `impossible` and `unknown` roots are
 * propagated through reverse dependency edges, but a terminal node cuts the
 * propagation because it already satisfies its dependants. Unknown is never
 * promoted to impossible. Structural cycles are always reported, even when a
 * terminal member means the current snapshot is not stranded by that cycle.
 */

export interface DependencyIdentity {
  readonly kind: string;
  readonly ref: string;
}

export type DependencyReachability = 'reachable' | 'impossible' | 'unknown';

export interface DependencyGraphNodeInput {
  readonly id: DependencyIdentity;
  /** Alternate declarations that resolve to this row. Any use is a mismatch. */
  readonly aliases?: readonly DependencyIdentity[];
  /** A terminal node already satisfies ordinary settlement dependencies. */
  readonly terminal?: boolean;
  /** Authoritative non-graph condition verdict; omitted means intrinsically reachable. */
  readonly rootVerdict?: DependencyReachability;
  /** Stored lifecycle says blocked, independently of the graph. */
  readonly storedBlocked?: boolean;
  /** A registered resolver explains an otherwise edge-less blocked lifecycle. */
  readonly hasRegisteredResolver?: boolean;
  /** Optional scope evidence retained for callers; it is not part of identity. */
  readonly scope?: string;
}

export interface DependencyGraphEdgeInput {
  readonly blocked: DependencyIdentity;
  readonly blocker: DependencyIdentity;
  readonly provenance?: string;
}

export interface DependencyGraphInput {
  readonly nodes: readonly DependencyGraphNodeInput[];
  readonly edges: readonly DependencyGraphEdgeInput[];
}

export type DependencyEndpointRole = 'blocked' | 'blocker';
export type DependencyEndpointDefectCode = 'missing' | 'mismatched' | 'ambiguous';

export interface DependencyEndpointDefect {
  readonly code: DependencyEndpointDefectCode;
  readonly edgeIndex: number;
  readonly role: DependencyEndpointRole;
  readonly declared: DependencyIdentity;
  readonly resolvedAs?: DependencyIdentity;
  readonly candidates?: readonly DependencyIdentity[];
  readonly message: string;
}

export interface DependencyStronglyConnectedComponent {
  readonly members: readonly DependencyIdentity[];
  /** One exact, closed cycle path (`path[0] === path.at(-1)`). */
  readonly cyclePath: readonly DependencyIdentity[];
}

export type DependencyBadRootCode =
  | 'cycle'
  | 'endpoint-missing'
  | 'endpoint-mismatched'
  | 'endpoint-ambiguous'
  | 'condition-impossible'
  | 'blocked-without-resolver';

export interface DependencyBadRoot {
  readonly id: string;
  readonly code: DependencyBadRootCode;
  readonly anchors: readonly DependencyIdentity[];
  /** Exact local proof: a closed cycle, endpoint path, or the root node itself. */
  readonly path: readonly DependencyIdentity[];
  readonly message: string;
  readonly edgeIndex?: number;
}

export interface DependencyNodeVerdict {
  readonly node: DependencyIdentity;
  readonly verdict: DependencyReachability;
  readonly impossibleRootIds: readonly string[];
  readonly unknownRootKeys: readonly string[];
}

export interface DependencyStrandedNode {
  readonly node: DependencyIdentity;
  readonly rootIds: readonly string[];
  /** Shortest deterministic node→root diagnostic path for each root. */
  readonly paths: readonly { readonly rootId: string; readonly path: readonly DependencyIdentity[] }[];
}

export interface DependencyGraphAnalysis {
  readonly stronglyConnectedComponents: readonly DependencyStronglyConnectedComponent[];
  readonly endpointDefects: readonly DependencyEndpointDefect[];
  readonly impossibleRoots: readonly DependencyBadRoot[];
  readonly verdicts: readonly DependencyNodeVerdict[];
  readonly stranded: readonly DependencyStrandedNode[];
  readonly strandedClosure: readonly DependencyIdentity[];
}

interface IndexedNode {
  readonly key: string;
  readonly input: DependencyGraphNodeInput;
}

type EndpointResolution =
  | { readonly status: 'exact'; readonly node: IndexedNode }
  | { readonly status: 'mismatched'; readonly node: IndexedNode }
  | { readonly status: 'missing' }
  | { readonly status: 'ambiguous'; readonly nodes: readonly IndexedNode[] };

interface ResolvedEdge {
  readonly edgeIndex: number;
  readonly blocked: IndexedNode;
  readonly blocker: IndexedNode;
  readonly exact: boolean;
}

interface RootSeed extends DependencyBadRoot {
  /** Paths must start at their map key and end at this root's local proof. */
  readonly seedPaths: ReadonlyMap<string, readonly DependencyIdentity[]>;
}

/** Collision-free, stable encoding of the canonical tuple. */
export function dependencyIdentityKey(id: DependencyIdentity): string {
  return JSON.stringify([id.kind, id.ref]);
}

function compareIdentity(a: DependencyIdentity, b: DependencyIdentity): number {
  return a.kind.localeCompare(b.kind) || a.ref.localeCompare(b.ref);
}

function compareKeys(a: string, b: string, nodes: ReadonlyMap<string, IndexedNode>): number {
  return compareIdentity(nodes.get(a)!.input.id, nodes.get(b)!.input.id);
}

function identityPathKey(path: readonly DependencyIdentity[]): string {
  return path.map(dependencyIdentityKey).join('\u0001');
}

function betterPath(candidate: readonly DependencyIdentity[], current: readonly DependencyIdentity[]): boolean {
  return (
    candidate.length < current.length ||
    (candidate.length === current.length && identityPathKey(candidate) < identityPathKey(current))
  );
}

function addToMultiMap<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const rows = map.get(key);
  if (rows) rows.push(value);
  else map.set(key, [value]);
}

function endpointMessage(
  code: DependencyEndpointDefectCode,
  role: DependencyEndpointRole,
  declared: DependencyIdentity,
  resolved?: DependencyIdentity,
  candidates: readonly DependencyIdentity[] = [],
): string {
  const label = `${declared.kind}:${declared.ref}`;
  if (code === 'missing') return `${role} endpoint ${label} does not resolve to a canonical node`;
  if (code === 'mismatched') {
    return `${role} endpoint ${label} resolves as ${resolved!.kind}:${resolved!.ref}, not as declared`;
  }
  return `${role} endpoint ${label} is ambiguous across ${candidates
    .map((candidate) => `${candidate.kind}:${candidate.ref}`)
    .join(', ')}`;
}

function makeEndpointDefect(
  edgeIndex: number,
  role: DependencyEndpointRole,
  declared: DependencyIdentity,
  resolution: EndpointResolution,
): DependencyEndpointDefect | null {
  if (resolution.status === 'exact') return null;
  if (resolution.status === 'missing') {
    return {
      code: 'missing',
      edgeIndex,
      role,
      declared,
      message: endpointMessage('missing', role, declared),
    };
  }
  if (resolution.status === 'mismatched') {
    return {
      code: 'mismatched',
      edgeIndex,
      role,
      declared,
      resolvedAs: resolution.node.input.id,
      message: endpointMessage('mismatched', role, declared, resolution.node.input.id),
    };
  }
  const candidates = [...resolution.nodes].map((node) => node.input.id).sort(compareIdentity);
  return {
    code: 'ambiguous',
    edgeIndex,
    role,
    declared,
    candidates,
    message: endpointMessage('ambiguous', role, declared, undefined, candidates),
  };
}

function stronglyConnectedComponents(
  nodes: ReadonlyMap<string, IndexedNode>,
  waitsOn: ReadonlyMap<string, ReadonlySet<string>>,
): string[][] {
  let nextIndex = 0;
  const indices = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const out: string[][] = [];

  const visit = (key: string): void => {
    indices.set(key, nextIndex);
    low.set(key, nextIndex);
    nextIndex += 1;
    stack.push(key);
    onStack.add(key);

    const neighbours = [...(waitsOn.get(key) ?? [])].sort((a, b) => compareKeys(a, b, nodes));
    for (const neighbour of neighbours) {
      if (!indices.has(neighbour)) {
        visit(neighbour);
        low.set(key, Math.min(low.get(key)!, low.get(neighbour)!));
      } else if (onStack.has(neighbour)) {
        low.set(key, Math.min(low.get(key)!, indices.get(neighbour)!));
      }
    }

    if (low.get(key) !== indices.get(key)) return;
    const component: string[] = [];
    while (stack.length > 0) {
      const member = stack.pop()!;
      onStack.delete(member);
      component.push(member);
      if (member === key) break;
    }
    component.sort((a, b) => compareKeys(a, b, nodes));
    out.push(component);
  };

  for (const key of [...nodes.keys()].sort((a, b) => compareKeys(a, b, nodes))) {
    if (!indices.has(key)) visit(key);
  }
  return out.sort((a, b) => compareKeys(a[0]!, b[0]!, nodes));
}

/** Find one real back-edge cycle inside an SCC; the returned path is closed. */
function findCyclePath(
  component: readonly string[],
  waitsOn: ReadonlyMap<string, ReadonlySet<string>>,
  nodes: ReadonlyMap<string, IndexedNode>,
): string[] {
  const allowed = new Set(component);
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  let found: string[] | null = null;

  const visit = (key: string): boolean => {
    state.set(key, 1);
    stack.push(key);
    const neighbours = [...(waitsOn.get(key) ?? [])]
      .filter((candidate) => allowed.has(candidate))
      .sort((a, b) => compareKeys(a, b, nodes));
    for (const neighbour of neighbours) {
      if ((state.get(neighbour) ?? 0) === 0) {
        if (visit(neighbour)) return true;
      } else if (state.get(neighbour) === 1) {
        const start = stack.lastIndexOf(neighbour);
        found = [...stack.slice(start), neighbour];
        return true;
      }
    }
    stack.pop();
    state.set(key, 2);
    return false;
  };

  for (const key of component) {
    if ((state.get(key) ?? 0) === 0 && visit(key)) break;
  }
  return found ?? [];
}

function rotateClosedPath(path: readonly string[], start: string): string[] {
  if (path.length < 2) return [...path];
  const open = path.slice(0, -1);
  const index = open.indexOf(start);
  if (index < 0) return [...path];
  const rotated = [...open.slice(index), ...open.slice(0, index)];
  return [...rotated, rotated[0]!];
}

function shortestPathToAny(
  start: string,
  targets: ReadonlySet<string>,
  adjacency: ReadonlyMap<string, ReadonlySet<string>>,
  allowed: ReadonlySet<string>,
  nodes: ReadonlyMap<string, IndexedNode>,
): string[] {
  const queue: string[][] = [[start]];
  const seen = new Set([start]);
  while (queue.length > 0) {
    const path = queue.shift()!;
    const key = path[path.length - 1]!;
    if (targets.has(key)) return path;
    const next = [...(adjacency.get(key) ?? [])]
      .filter((candidate) => allowed.has(candidate) && !seen.has(candidate))
      .sort((a, b) => compareKeys(a, b, nodes));
    for (const candidate of next) {
      seen.add(candidate);
      queue.push([...path, candidate]);
    }
  }
  return [];
}

function propagateSeedPaths(
  seeds: ReadonlyMap<string, readonly DependencyIdentity[]>,
  dependants: ReadonlyMap<string, ReadonlySet<string>>,
  nodes: ReadonlyMap<string, IndexedNode>,
): Map<string, readonly DependencyIdentity[]> {
  const paths = new Map<string, readonly DependencyIdentity[]>();
  const queue: string[] = [];
  for (const [key, path] of [...seeds.entries()].sort(([a], [b]) => compareKeys(a, b, nodes))) {
    if (nodes.get(key)?.input.terminal) continue;
    const current = paths.get(key);
    if (!current || betterPath(path, current)) {
      paths.set(key, path);
      queue.push(key);
    }
  }

  while (queue.length > 0) {
    const key = queue.shift()!;
    const path = paths.get(key)!;
    const next = [...(dependants.get(key) ?? [])].sort((a, b) => compareKeys(a, b, nodes));
    for (const dependant of next) {
      const node = nodes.get(dependant);
      if (!node || node.input.terminal) continue;
      const candidate = [node.input.id, ...path];
      const current = paths.get(dependant);
      if (!current || betterPath(candidate, current)) {
        paths.set(dependant, candidate);
        queue.push(dependant);
      }
    }
  }
  return paths;
}

function rootCodeForEndpoint(code: DependencyEndpointDefectCode): DependencyBadRootCode {
  if (code === 'missing') return 'endpoint-missing';
  if (code === 'ambiguous') return 'endpoint-ambiguous';
  return 'endpoint-mismatched';
}

/**
 * Analyse one complete graph snapshot. The function performs no IO, mutates no
 * input, and returns arrays in canonical order so diagnostics are reproducible.
 */
export function analyzeDependencyGraph(input: DependencyGraphInput): DependencyGraphAnalysis {
  const canonicalCandidates = new Map<string, IndexedNode[]>();
  const aliasCandidates = new Map<string, IndexedNode[]>();
  for (const node of input.nodes) {
    const indexed: IndexedNode = { key: dependencyIdentityKey(node.id), input: node };
    addToMultiMap(canonicalCandidates, indexed.key, indexed);
    for (const alias of node.aliases ?? []) {
      const aliasKey = dependencyIdentityKey(alias);
      if (aliasKey !== indexed.key) addToMultiMap(aliasCandidates, aliasKey, indexed);
    }
  }

  // A duplicate canonical tuple is invalid input. Preserve deterministic output
  // by selecting the first row; any endpoint naming the duplicate is ambiguous.
  const nodes = new Map<string, IndexedNode>();
  for (const [key, candidates] of canonicalCandidates) nodes.set(key, candidates[0]!);

  const resolve = (id: DependencyIdentity): EndpointResolution => {
    const key = dependencyIdentityKey(id);
    const exact = canonicalCandidates.get(key) ?? [];
    if (exact.length === 1) return { status: 'exact', node: exact[0]! };
    if (exact.length > 1) return { status: 'ambiguous', nodes: exact };
    const aliases = aliasCandidates.get(key) ?? [];
    const unique = [...new Map(aliases.map((candidate) => [candidate.key, candidate])).values()];
    if (unique.length === 1) return { status: 'mismatched', node: unique[0]! };
    if (unique.length > 1) return { status: 'ambiguous', nodes: unique };
    return { status: 'missing' };
  };

  const endpointDefects: DependencyEndpointDefect[] = [];
  const resolvedEdges: ResolvedEdge[] = [];
  const resolutions: Array<{
    edge: DependencyGraphEdgeInput;
    blocked: EndpointResolution;
    blocker: EndpointResolution;
  }> = [];

  input.edges.forEach((edge, edgeIndex) => {
    const blocked = resolve(edge.blocked);
    const blocker = resolve(edge.blocker);
    resolutions.push({ edge, blocked, blocker });
    const blockedDefect = makeEndpointDefect(edgeIndex, 'blocked', edge.blocked, blocked);
    const blockerDefect = makeEndpointDefect(edgeIndex, 'blocker', edge.blocker, blocker);
    if (blockedDefect) endpointDefects.push(blockedDefect);
    if (blockerDefect) endpointDefects.push(blockerDefect);
    if (
      (blocked.status === 'exact' || blocked.status === 'mismatched') &&
      (blocker.status === 'exact' || blocker.status === 'mismatched')
    ) {
      resolvedEdges.push({
        edgeIndex,
        blocked: blocked.node,
        blocker: blocker.node,
        exact: blocked.status === 'exact' && blocker.status === 'exact',
      });
    }
  });

  endpointDefects.sort(
    (a, b) => a.edgeIndex - b.edgeIndex || a.role.localeCompare(b.role) || a.code.localeCompare(b.code),
  );

  // Structural SCCs include uniquely-resolved aliases so alias-loops cannot hide
  // behind the mismatch finding. The active view removes edges whose blocked or
  // blocker endpoint is already terminal: those edges remain diagnostically
  // visible, but settlement means they cannot make the current graph impossible.
  // Readiness propagation below uses exact edges only.
  const structuralWaitsOn = new Map<string, Set<string>>();
  const activeStructuralWaitsOn = new Map<string, Set<string>>();
  const effectiveBlockers = new Map<string, Set<string>>();
  const dependants = new Map<string, Set<string>>();
  for (const key of nodes.keys()) {
    structuralWaitsOn.set(key, new Set());
    activeStructuralWaitsOn.set(key, new Set());
    effectiveBlockers.set(key, new Set());
    dependants.set(key, new Set());
  }
  for (const edge of resolvedEdges) {
    structuralWaitsOn.get(edge.blocked.key)!.add(edge.blocker.key);
    if (!edge.blocked.input.terminal && !edge.blocker.input.terminal) {
      activeStructuralWaitsOn.get(edge.blocked.key)!.add(edge.blocker.key);
    }
    if (!edge.exact) continue;
    effectiveBlockers.get(edge.blocked.key)!.add(edge.blocker.key);
    dependants.get(edge.blocker.key)!.add(edge.blocked.key);
  }

  const structuralCyclicComponents = stronglyConnectedComponents(nodes, structuralWaitsOn).filter(
    (component) => component.length > 1 || (structuralWaitsOn.get(component[0]!)?.has(component[0]!) ?? false),
  );
  const stronglyConnected: DependencyStronglyConnectedComponent[] = structuralCyclicComponents.map((component) => {
    const cycleKeys = findCyclePath(component, structuralWaitsOn, nodes);
    return {
      members: component.map((key) => nodes.get(key)!.input.id),
      cyclePath: cycleKeys.map((key) => nodes.get(key)!.input.id),
    };
  });

  const activeCyclicComponents = stronglyConnectedComponents(nodes, activeStructuralWaitsOn).filter(
    (component) => component.length > 1 || (activeStructuralWaitsOn.get(component[0]!)?.has(component[0]!) ?? false),
  );
  const roots: RootSeed[] = [];

  activeCyclicComponents.forEach((component, index) => {
    const cycleKeys = findCyclePath(component, activeStructuralWaitsOn, nodes);
    const cyclePath = cycleKeys.map((key) => nodes.get(key)!.input.id);

    const seedPaths = new Map<string, readonly DependencyIdentity[]>();
    const cycleMembers = new Set(cycleKeys.slice(0, -1));
    const componentSet = new Set(component);
    for (const member of component) {
      const toCycle = shortestPathToAny(member, cycleMembers, activeStructuralWaitsOn, componentSet, nodes);
      const cycleEntry = toCycle[toCycle.length - 1];
      if (!cycleEntry) continue;
      const rotated = rotateClosedPath(cycleKeys, cycleEntry);
      const fullPath = [...toCycle, ...rotated.slice(1)].map((key) => nodes.get(key)!.input.id);
      seedPaths.set(member, fullPath);
    }
    roots.push({
      id: `cycle:${index + 1}`,
      code: 'cycle',
      anchors: [...seedPaths.keys()].map((key) => nodes.get(key)!.input.id),
      path: cyclePath,
      message: `dependency SCC contains a cycle: ${cyclePath.map((id) => `${id.kind}:${id.ref}`).join(' -> ')}`,
      seedPaths,
    });
  });

  // Every endpoint defect is independently actionable and remains visible even
  // when another endpoint on the same edge is also broken.
  for (const defect of endpointDefects) {
    const resolution = resolutions[defect.edgeIndex]!;
    const blocked = resolution.blocked;
    const anchor = blocked.status === 'exact' || blocked.status === 'mismatched' ? blocked.node : null;
    const seedPaths = new Map<string, readonly DependencyIdentity[]>();
    if (anchor && !anchor.input.terminal) {
      seedPaths.set(anchor.key, [anchor.input.id, defect.declared]);
    }
    roots.push({
      id: `endpoint:${defect.edgeIndex}:${defect.role}:${defect.code}`,
      code: rootCodeForEndpoint(defect.code),
      anchors: anchor ? [anchor.input.id] : [],
      path: anchor ? [anchor.input.id, defect.declared] : [defect.declared],
      message: defect.message,
      edgeIndex: defect.edgeIndex,
      seedPaths,
    });
  }

  // Authoritative external/impossibility roots are direct seeds. Reachable is
  // the default and unknown gets a separate closure below.
  for (const node of [...nodes.values()].sort((a, b) => compareIdentity(a.input.id, b.input.id))) {
    if (node.input.rootVerdict === 'impossible') {
      roots.push({
        id: `condition:${node.key}`,
        code: 'condition-impossible',
        anchors: [node.input.id],
        path: [node.input.id],
        message: `${node.input.id.kind}:${node.input.id.ref} has an authoritative impossible root condition`,
        seedPaths: new Map([[node.key, [node.input.id]]]),
      });
    }
  }

  const defectAnchors = new Set<string>();
  for (const root of roots) for (const key of root.seedPaths.keys()) defectAnchors.add(key);
  for (const node of [...nodes.values()].sort((a, b) => compareIdentity(a.input.id, b.input.id))) {
    if (!node.input.storedBlocked || node.input.terminal || node.input.hasRegisteredResolver) continue;
    if (node.input.rootVerdict === 'impossible' || node.input.rootVerdict === 'unknown') continue;
    const hasLiveBlocker = [...(effectiveBlockers.get(node.key) ?? [])].some((key) => !nodes.get(key)?.input.terminal);
    if (hasLiveBlocker || defectAnchors.has(node.key)) continue;
    roots.push({
      id: `blocked-without-resolver:${node.key}`,
      code: 'blocked-without-resolver',
      anchors: [node.input.id],
      path: [node.input.id],
      message: `${node.input.id.kind}:${node.input.id.ref} is stored blocked with no live dependency or registered resolver`,
      seedPaths: new Map([[node.key, [node.input.id]]]),
    });
  }

  roots.sort((a, b) => a.id.localeCompare(b.id));

  const impossibleByNode = new Map<string, Map<string, readonly DependencyIdentity[]>>();
  for (const root of roots) {
    const closure = propagateSeedPaths(root.seedPaths, dependants, nodes);
    for (const [key, path] of closure) {
      const byRoot = impossibleByNode.get(key) ?? new Map<string, readonly DependencyIdentity[]>();
      byRoot.set(root.id, path);
      impossibleByNode.set(key, byRoot);
    }
  }

  const unknownSeeds = new Map<string, readonly DependencyIdentity[]>();
  for (const node of nodes.values()) {
    if (!node.input.terminal && node.input.rootVerdict === 'unknown') {
      unknownSeeds.set(node.key, [node.input.id]);
    }
  }
  const unknownByNode = new Map<string, Set<string>>();
  for (const [seed, path] of unknownSeeds) {
    const closure = propagateSeedPaths(new Map([[seed, path]]), dependants, nodes);
    for (const key of closure.keys()) {
      const rootsForNode = unknownByNode.get(key) ?? new Set<string>();
      rootsForNode.add(seed);
      unknownByNode.set(key, rootsForNode);
    }
  }

  const sortedNodes = [...nodes.values()].sort((a, b) => compareIdentity(a.input.id, b.input.id));
  const verdicts: DependencyNodeVerdict[] = sortedNodes.map((node) => {
    const impossible = impossibleByNode.get(node.key);
    const terminal = Boolean(node.input.terminal);
    const verdict: DependencyReachability = terminal
      ? 'reachable'
      : impossible && impossible.size > 0
        ? 'impossible'
        : unknownByNode.has(node.key)
          ? 'unknown'
          : 'reachable';
    const unknownRootKeys = verdict === 'unknown' ? [...(unknownByNode.get(node.key) ?? [])].sort() : [];
    return {
      node: node.input.id,
      verdict,
      impossibleRootIds: terminal || !impossible ? [] : [...impossible.keys()].sort(),
      unknownRootKeys,
    };
  });

  const stranded: DependencyStrandedNode[] = sortedNodes.flatMap((node) => {
    if (node.input.terminal) return [];
    const byRoot = impossibleByNode.get(node.key);
    if (!byRoot || byRoot.size === 0) return [];
    const paths = [...byRoot.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([rootId, path]) => ({ rootId, path }));
    return [{ node: node.input.id, rootIds: paths.map((row) => row.rootId), paths }];
  });

  return {
    stronglyConnectedComponents: stronglyConnected,
    endpointDefects,
    impossibleRoots: roots.map(({ seedPaths: _seedPaths, ...root }) => root),
    verdicts,
    stranded,
    strandedClosure: stranded.map((row) => row.node),
  };
}
