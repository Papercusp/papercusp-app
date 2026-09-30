/**
 * Feature dependency (`blocked_by`) resolution + cycle detection (P-046 / D-014).
 *
 * `blocked_by` is a first-class feature field: a list of feature refs that must
 * finish before a feature is dispatchable (the shared prerequisite for the
 * frontier dispatch model — P-042 reads it, P-043 generators edge-rewrite into
 * it). Authors (the `## Promote` policy / plans:promote) declare `blocked_by` as
 * feature ids OR titles; this module resolves those refs to canonical ids at
 * import time and rejects (a) an unresolvable/ambiguous ref and (b) a dependency
 * cycle — both LOUDLY, because a cycle is a silent permanent frontier deadlock.
 *
 * Pure + framework-free so the import handler can validate before it writes, and
 * so both can be unit-tested without a database.
 */

/** A feature visible during resolution — either being imported or already stored. */
export interface FeatureRef {
  id: string;
  title: string;
}

/** A feature carrying raw (unresolved) blocked_by refs from the import payload. */
export interface FeatureWithRawDeps extends FeatureRef {
  /** Raw refs as authored: feature ids and/or titles. */
  blockedByRefs: string[];
}

export interface ResolveResult {
  /** featureId → resolved canonical blocker ids (deduped, self-edges dropped). */
  resolved: Map<string, string[]>;
  /** Human-readable errors for unresolvable / ambiguous refs (empty = success). */
  errors: string[];
}

function norm(s: string): string {
  return s.trim().toLowerCase();
}

/**
 * Resolve every feature's `blockedByRefs` (ids or titles) to canonical feature
 * ids, against the union of the imported batch + the already-existing features.
 * A ref resolves by: exact id match first, else exact (case-insensitive) title
 * match — but a title shared by >1 feature is AMBIGUOUS and errors. An
 * unresolvable ref errors. A feature blocking itself drops that edge (no error).
 */
export function resolveBlockedByRefs(
  batch: readonly FeatureWithRawDeps[],
  existing: readonly FeatureRef[],
): ResolveResult {
  const all: FeatureRef[] = [...existing, ...batch];
  const ids = new Set(all.map((f) => f.id));
  // title (normalized) → set of ids with that title
  const byTitle = new Map<string, Set<string>>();
  for (const f of all) {
    const k = norm(f.title);
    if (!k) continue;
    (byTitle.get(k) ?? byTitle.set(k, new Set()).get(k)!).add(f.id);
  }

  const resolved = new Map<string, string[]>();
  const errors: string[] = [];

  for (const f of batch) {
    const out = new Set<string>();
    for (const rawRef of f.blockedByRefs) {
      const ref = rawRef.trim();
      if (!ref) continue;
      if (ids.has(ref)) {
        if (ref !== f.id) out.add(ref);
        continue;
      }
      const titleHits = byTitle.get(norm(ref));
      if (!titleHits || titleHits.size === 0) {
        errors.push(`feature ${f.id} blocked_by unresolvable ref "${rawRef}" (no feature with that id or title)`);
        continue;
      }
      if (titleHits.size > 1) {
        errors.push(`feature ${f.id} blocked_by ambiguous title "${rawRef}" (matches ${titleHits.size} features: ${[...titleHits].join(', ')}) — use the feature id`);
        continue;
      }
      const target = [...titleHits][0];
      if (target !== f.id) out.add(target);
    }
    resolved.set(f.id, [...out]);
  }
  return { resolved, errors };
}

/**
 * Detect a cycle in the dependency graph (Kahn topological sort). `edges` maps a
 * feature id → its resolved blocker ids (`blocked_by`); the graph orients
 * blocker → blocked (a blocker must finish first). Returns the ids that remain
 * after peeling all in-degree-0 nodes — non-empty iff a cycle exists. Existing
 * features' edges should be merged in so a batch↔existing cycle is caught too.
 */
export function detectDependencyCycle(edges: ReadonlyMap<string, readonly string[]>): {
  hasCycle: boolean;
  cycleNodes: string[];
} {
  // Build the full node set (every id that appears as a feature or a blocker).
  const nodes = new Set<string>();
  for (const [id, blockers] of edges) {
    nodes.add(id);
    for (const b of blockers) nodes.add(b);
  }
  // adjacency blocker → [blocked...]; indegree counts incoming (blocked_by) edges.
  const adj = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  for (const n of nodes) {
    adj.set(n, []);
    indegree.set(n, 0);
  }
  for (const [blocked, blockers] of edges) {
    for (const blocker of blockers) {
      adj.get(blocker)!.push(blocked);
      indegree.set(blocked, (indegree.get(blocked) ?? 0) + 1);
    }
  }
  const queue: string[] = [];
  for (const [n, d] of indegree) if (d === 0) queue.push(n);
  let visited = 0;
  while (queue.length > 0) {
    const n = queue.shift()!;
    visited++;
    for (const m of adj.get(n)!) {
      const d = (indegree.get(m) ?? 0) - 1;
      indegree.set(m, d);
      if (d === 0) queue.push(m);
    }
  }
  if (visited === nodes.size) return { hasCycle: false, cycleNodes: [] };
  const cycleNodes = [...indegree].filter(([, d]) => d > 0).map(([n]) => n).sort();
  return { hasCycle: true, cycleNodes };
}
