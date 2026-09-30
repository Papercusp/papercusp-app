/**
 * Multi-granularity intention locks (Gray 1976) — the IS/IX/S/SIX/X matrix.
 * Plan: locks-correctness-hardening-2026-06-04 (D-005).
 *
 * Today the two lock systems are blind to each other: an agent can hold a file
 * lock UNDER a harness while another agent takes that whole harness/subtree
 * `exclusive` — they never conflict because file locks key off an exact path and
 * a "harness/tree" lock has no relationship to the files inside it. The fix is
 * the classic multi-granularity protocol: a lock on a node also places an
 * INTENTION lock on every ancestor node, and conflicts are decided by the
 * IS/IX/S/SIX/X compatibility matrix at each shared node.
 *
 *   - IS  (intention-shared)    — "I hold/want S somewhere below here."
 *   - IX  (intention-exclusive) — "I hold/want X somewhere below here."
 *   - S   (shared)              — read this whole subtree.
 *   - SIX (shared + intention-X)— read the whole subtree AND write one node in it.
 *   - X   (exclusive)           — own this whole subtree.
 *
 * So a file lock takes X on its leaf + IX on each ancestor (incl. the harness
 * root); a harness-exclusive takes X on the root, which now correctly CONFLICTS
 * with any descendant file lock's IX. A tree-reader takes S/IS; "reading the
 * tree while editing one file" is SIX. This subsumes the hand-rolled
 * `exclusive_pending` / `holds_shared` reason codes (which informally re-derived
 * this same matrix) and enables one-call directory/subtree locks for refactors
 * plus lock escalation (many file IXs under one harness → one harness-X, granted
 * iff no OTHER owner conflicts). Two levels of meaning — node + its ancestors —
 * and the matrix only; page-granularity is intentionally skipped.
 *
 * PURE module (no PG): the matrix, the ancestor derivation, and the conflict
 * computation. The PG store (`granular-lock-store.ts`) layers persistence +
 * all-or-nothing acquire on top, exactly as the file-lock store does.
 *
 * ([Gray 1976](https://mwhittaker.github.io/papers/html/gray1976granularity.html))
 */

export type GranularMode = 'IS' | 'IX' | 'S' | 'SIX' | 'X';

/** The harness/tree root node — the ancestor every path shares. A
 *  harness-`exclusive` is X on this node. Represented as the empty string so a
 *  repo-relative path never collides with it. */
export const ROOT_NODE = '';

/**
 * Gray's compatibility matrix. `MODE_COMPATIBLE[held][requested]` is true when a
 * lock already HELD (by another owner) in `held` mode permits a new `requested`
 * lock on the SAME node. Symmetric by construction.
 *
 *          IS    IX    S    SIX    X
 *   IS      ✓     ✓     ✓     ✓     ✗
 *   IX      ✓     ✓     ✗     ✗     ✗
 *   S       ✓     ✗     ✓     ✗     ✗
 *   SIX     ✓     ✗     ✗     ✗     ✗
 *   X       ✗     ✗     ✗     ✗     ✗
 */
export const MODE_COMPATIBLE: Record<GranularMode, Record<GranularMode, boolean>> = {
  IS:  { IS: true,  IX: true,  S: true,  SIX: true,  X: false },
  IX:  { IS: true,  IX: true,  S: false, SIX: false, X: false },
  S:   { IS: true,  IX: false, S: true,  SIX: false, X: false },
  SIX: { IS: true,  IX: false, S: false, SIX: false, X: false },
  X:   { IS: false, IX: false, S: false, SIX: false, X: false },
};

export function compatible(held: GranularMode, requested: GranularMode): boolean {
  return MODE_COMPATIBLE[held][requested];
}

/**
 * The intention mode a leaf request places on its ANCESTORS. Reading below a
 * node intends-shared (IS) on the way down; writing below it (X / IX / SIX)
 * intends-exclusive (IX).
 */
export function intentionFor(leafMode: GranularMode): GranularMode {
  switch (leafMode) {
    case 'S':
    case 'IS':
      return 'IS';
    case 'X':
    case 'IX':
    case 'SIX':
      return 'IX';
  }
}

/** Normalize a node path: trim, drop a trailing slash, collapse to ROOT for the
 *  root/empty/`.` cases. Repo-relative; absolute/traversal paths are the
 *  store-layer validator's concern (mirrors the file-lock path rules). */
export function normalizeNode(path: string): string {
  let p = (path ?? '').trim().replace(/\/+$/, '');
  if (p === '.' || p === '/') p = '';
  return p;
}

/**
 * The ancestor nodes of `path`, root-first, EXCLUDING the node itself:
 *   'apps/operator/foo.ts' → ['', 'apps', 'apps/operator']
 *   'apps'                 → ['']
 *   '' (root)              → []
 */
export function ancestorsOf(path: string): string[] {
  const node = normalizeNode(path);
  if (node === ROOT_NODE) return [];
  const segs = node.split('/').filter(Boolean);
  const out: string[] = [ROOT_NODE];
  let acc = '';
  for (let i = 0; i < segs.length - 1; i++) {
    acc = acc ? `${acc}/${segs[i]}` : segs[i];
    out.push(acc);
  }
  return out;
}

export interface NodeLock {
  node: string;
  mode: GranularMode;
}

/**
 * The full set of (node, mode) locks a request implies: the leaf in `leafMode`
 * plus the matching intention mode on every ancestor (incl. the harness root).
 * This is exactly the set that must be conflict-checked + persisted to make the
 * multi-granularity protocol hold.
 */
export function lockSetFor(path: string, leafMode: GranularMode): NodeLock[] {
  const leaf = normalizeNode(path);
  if (leaf === ROOT_NODE) return [{ node: ROOT_NODE, mode: leafMode }];
  const intent = intentionFor(leafMode);
  return [
    ...ancestorsOf(leaf).map((node) => ({ node, mode: intent })),
    { node: leaf, mode: leafMode },
  ];
}

export interface HeldNodeLock extends NodeLock {
  owner: string;
}

export interface GranularConflict {
  node: string;
  requested_mode: GranularMode;
  held_mode: GranularMode;
  held_owner: string;
}

/**
 * Compute the conflicts between a request (`owner` wanting `requested` locks)
 * and the currently-`held` locks. A lock held by the SAME owner never conflicts
 * (an owner refines its own grants — e.g. holding IX and escalating to X). Two
 * requested locks that land on the same node as an other-owner lock are checked
 * pairwise through the matrix. An empty result means the request is grantable.
 */
export function findConflicts(
  held: HeldNodeLock[],
  requested: NodeLock[],
  owner: string,
): GranularConflict[] {
  const conflicts: GranularConflict[] = [];
  // Index held locks by node for an O(req × held-at-node) scan.
  const byNode = new Map<string, HeldNodeLock[]>();
  for (const h of held) {
    if (h.owner === owner) continue; // self never conflicts
    const arr = byNode.get(h.node);
    if (arr) arr.push(h);
    else byNode.set(h.node, [h]);
  }
  for (const req of requested) {
    for (const h of byNode.get(req.node) ?? []) {
      if (!compatible(h.mode, req.mode)) {
        conflicts.push({
          node: req.node,
          requested_mode: req.mode,
          held_mode: h.mode,
          held_owner: h.owner,
        });
      }
    }
  }
  return conflicts;
}
