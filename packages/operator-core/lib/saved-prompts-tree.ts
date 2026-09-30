/**
 * saved-prompts-tree.ts — pure outline (Workflowy-style) tree utilities for the
 * Quick Panel prompts tab (quick-panel-saved-prompts-2026-07-13 P-002).
 *
 * Operates on the organizer columns migration 598 added to
 * `harness_shared.saved_prompts` (parent_id / position / title / collapsed /
 * pinned). Every row is both an outline node AND (when body is non-empty) a
 * prompt; an empty body marks a pure folder node.
 *
 * Ordering: siblings sort by `position` (a fractional-indexing key), with
 * NULL-position (legacy) rows after positioned rows, by display title. Move
 * operations return ASSIGNMENTS (id → parentId/position patches) rather than
 * mutating: when a sibling list still contains legacy NULL positions the op
 * resequences the whole list once, so callers apply every returned assignment.
 *
 * Pure + isomorphic (no PG, no React) — imported by both the server routes and
 * the panel UI. Position keys come from the maintained `fractional-indexing`
 * package (concurrent inserts never collide, no renumber storms).
 */
import { generateKeyBetween, generateNKeysBetween } from 'fractional-indexing';

/** The organizer-relevant subset of a saved_prompts row (camelCase, store shape). */
export interface PromptNodeFields {
  id: string;
  name: string;
  title: string | null;
  body: string;
  parentId: string | null;
  position: string | null;
  collapsed: boolean;
  pinned: boolean;
  usageCount: number;
  lastUsedAt: string | null;
  archivedAt: string | null;
  /** Workflowy checkoff (migration 606). Optional so pre-606 row shapes remain valid. */
  completedAt?: string | null;
}

export interface PromptTreeNode<R extends PromptNodeFields = PromptNodeFields> {
  row: R;
  children: PromptTreeNode<R>[];
}

export interface PromptTreeModel<R extends PromptNodeFields = PromptNodeFields> {
  roots: PromptTreeNode<R>[];
  /** id → node + its parent node (null for roots). */
  byId: Map<string, { node: PromptTreeNode<R>; parent: PromptTreeNode<R> | null }>;
}

export interface VisibleRow<R extends PromptNodeFields = PromptNodeFields> {
  node: PromptTreeNode<R>;
  depth: number;
}

/** id → { parentId, position } patch produced by a move/sequence operation. */
export interface MoveAssignment {
  id: string;
  parentId: string | null;
  position: string;
}

/** What the outline shows for a node: free-text title, falling back to the slug name. */
export function displayTitle(row: Pick<PromptNodeFields, 'name' | 'title'>): string {
  const t = row.title?.trim();
  return t && t.length > 0 ? t : row.name;
}

/** A node with an empty body is a pure folder (never materialized as a command). */
export function isFolder(row: Pick<PromptNodeFields, 'body'>): boolean {
  return row.body.trim().length === 0;
}

/** Checked off (Workflowy complete). */
export function isCompleted(row: Pick<PromptNodeFields, 'completedAt'>): boolean {
  return row.completedAt !== null && row.completedAt !== undefined;
}

function siblingCompare(a: PromptNodeFields, b: PromptNodeFields): number {
  const ap = a.position;
  const bp = b.position;
  if (ap !== null && bp !== null && ap !== bp) return ap < bp ? -1 : 1;
  if (ap !== null && bp === null) return -1; // positioned before legacy
  if (ap === null && bp !== null) return 1;
  const byTitle = displayTitle(a).localeCompare(displayTitle(b));
  if (byTitle !== 0) return byTitle;
  return a.id < b.id ? -1 : 1;
}

/**
 * Build the outline from flat rows. Archived rows are excluded. Orphans
 * (parent missing or part of a cycle) surface as roots rather than vanishing.
 */
export function buildPromptTree<R extends PromptNodeFields>(rows: R[]): PromptTreeModel<R> {
  const live = rows.filter((r) => r.archivedAt === null || r.archivedAt === undefined);
  const nodes = new Map<string, PromptTreeNode<R>>();
  for (const row of live) nodes.set(row.id, { row, children: [] });

  const roots: PromptTreeNode<R>[] = [];
  for (const node of nodes.values()) {
    const pid = node.row.parentId;
    const parent = pid ? nodes.get(pid) : undefined;
    if (parent && parent !== node) parent.children.push(node);
    else roots.push(node);
  }

  // Cycle guard: anything unreachable from the roots (a parent loop in
  // hand-corrupted data) is promoted to a root so it stays visible. Severing
  // the promoted node's own parent edge breaks the cycle, so the tree below
  // is edge-consistent (no back-edges for sort/flatten to recurse into).
  const reachable = new Set<string>();
  const walk = (n: PromptTreeNode<R>) => {
    if (reachable.has(n.row.id)) return;
    reachable.add(n.row.id);
    n.children.forEach(walk);
  };
  roots.forEach(walk);
  for (const node of nodes.values()) {
    if (!reachable.has(node.row.id)) {
      const pid = node.row.parentId;
      const parent = pid ? nodes.get(pid) : undefined;
      if (parent) parent.children = parent.children.filter((c) => c !== node);
      roots.push(node);
      walk(node);
    }
  }

  const sortRec = (list: PromptTreeNode<R>[]) => {
    list.sort((a, b) => siblingCompare(a.row, b.row));
    for (const n of list) sortRec(n.children);
  };
  sortRec(roots);

  const byId = new Map<string, { node: PromptTreeNode<R>; parent: PromptTreeNode<R> | null }>();
  const index = (n: PromptTreeNode<R>, parent: PromptTreeNode<R> | null) => {
    byId.set(n.row.id, { node: n, parent });
    for (const c of n.children) index(c, n);
  };
  for (const r of roots) index(r, null);

  return { roots, byId };
}

function nodeMatches(row: PromptNodeFields, q: string): boolean {
  return (
    displayTitle(row).toLowerCase().includes(q) ||
    row.name.toLowerCase().includes(q) ||
    row.body.toLowerCase().includes(q)
  );
}

export interface VisibleOpts {
  /** Live text filter — matches title/name/body (so `#tag` filters too). */
  filter?: string;
  /**
   * Zoom/hoist (WI-4840 D-002): render only this node's CHILDREN, at depth 0.
   * The zoomed node itself is the page header, not a row, and its collapsed
   * flag is ignored (Workflowy: zooming in always shows the children).
   * Unknown/empty id ⇒ home (all roots).
   */
  zoomId?: string | null;
  /** Hide completed nodes AND their whole subtrees (the Workflowy toggle). */
  hideCompleted?: boolean;
}

/**
 * Flatten the tree to what the outline renders. Without a filter, children of
 * a collapsed node are hidden. With a filter, collapse is ignored and a node is
 * shown iff it (or a descendant) matches — ancestors of a match stay visible.
 * Both modes respect `zoomId` (re-roots the walk) and `hideCompleted`.
 */
export function visibleRows<R extends PromptNodeFields>(
  model: PromptTreeModel<R>,
  opts: VisibleOpts = {},
): VisibleRow<R>[] {
  const q = opts.filter?.trim().toLowerCase();
  const hide = opts.hideCompleted === true;
  const zoomNode = opts.zoomId ? model.byId.get(opts.zoomId)?.node : undefined;
  const roots = zoomNode ? zoomNode.children : model.roots;
  const out: VisibleRow<R>[] = [];

  if (!q) {
    const walk = (n: PromptTreeNode<R>, depth: number) => {
      if (hide && isCompleted(n.row)) return;
      out.push({ node: n, depth });
      if (!n.row.collapsed) for (const c of n.children) walk(c, depth + 1);
    };
    for (const r of roots) walk(r, 0);
    return out;
  }

  const subtreeMatches = (n: PromptTreeNode<R>): boolean =>
    nodeMatches(n.row, q) || n.children.some(subtreeMatches);
  const walk = (n: PromptTreeNode<R>, depth: number) => {
    if (hide && isCompleted(n.row)) return;
    if (!subtreeMatches(n)) return;
    out.push({ node: n, depth });
    for (const c of n.children) walk(c, depth + 1);
  };
  for (const r of roots) walk(r, 0);
  return out;
}

/**
 * Ancestor chain of a node, ROOT-FIRST and INCLUDING the node itself — the
 * zoom breadcrumb. Empty for an unknown id.
 */
export function breadcrumbOf<R extends PromptNodeFields>(
  model: PromptTreeModel<R>,
  id: string,
): R[] {
  const entry = model.byId.get(id);
  if (!entry) return [];
  const chain: R[] = [entry.node.row];
  let cur = entry.parent;
  while (cur) {
    chain.unshift(cur.row);
    cur = model.byId.get(cur.row.id)?.parent ?? null;
  }
  return chain;
}

/** Every id in a node's subtree, INCLUDING the node itself. Empty for unknown ids. */
export function subtreeIds<R extends PromptNodeFields>(
  model: PromptTreeModel<R>,
  id: string,
): Set<string> {
  const out = new Set<string>();
  const start = model.byId.get(id)?.node;
  if (!start) return out;
  const walk = (n: PromptTreeNode<R>) => {
    out.add(n.row.id);
    for (const c of n.children) walk(c);
  };
  walk(start);
  return out;
}

/** The ordered sibling list a node belongs to (roots when parent is null). */
function siblingListOf<R extends PromptNodeFields>(
  model: PromptTreeModel<R>,
  id: string,
): { siblings: PromptTreeNode<R>[]; parent: PromptTreeNode<R> | null } | null {
  const entry = model.byId.get(id);
  if (!entry) return null;
  return { siblings: entry.parent ? entry.parent.children : model.roots, parent: entry.parent };
}

/**
 * Effective positions for a sibling list. When every sibling already has a
 * strictly-increasing position, positions are used as-is (no assignments).
 * Otherwise (legacy NULLs / duplicates) the WHOLE list is resequenced once and
 * every sibling appears in the returned assignments.
 */
function effectiveSequence<R extends PromptNodeFields>(
  siblings: PromptTreeNode<R>[],
  parentId: string | null,
): { positions: string[]; assignments: MoveAssignment[] } {
  const ok =
    siblings.every((s) => s.row.position !== null) &&
    siblings.every(
      (s, i) => i === 0 || (siblings[i - 1].row.position as string) < (s.row.position as string),
    );
  if (ok) return { positions: siblings.map((s) => s.row.position as string), assignments: [] };
  const keys = generateNKeysBetween(null, null, siblings.length);
  return {
    positions: keys,
    assignments: siblings.map((s, i) => ({ id: s.row.id, parentId, position: keys[i] })),
  };
}

function mergeMoved(
  assignments: MoveAssignment[],
  moved: MoveAssignment,
): MoveAssignment[] {
  return [...assignments.filter((a) => a.id !== moved.id), moved];
}

/** Position key for appending a new child at the end of `parentId`'s children. */
export function appendPosition<R extends PromptNodeFields>(
  model: PromptTreeModel<R>,
  parentId: string | null,
): string {
  const siblings = parentId ? (model.byId.get(parentId)?.node.children ?? []) : model.roots;
  // Legacy NULL-position rows sort AFTER positioned ones, so the LAST sibling's
  // position can be null even when positioned siblings exist — appending from it
  // would mint 'a0' again and collide with the first positioned sibling
  // (live-caught in WI-4806). Append past the highest DEFINED key instead.
  let last: string | null = null;
  for (const s of siblings) {
    const p = s.row.position;
    if (p !== null && (last === null || p > last)) last = p;
  }
  return generateKeyBetween(last, null);
}

/** A create placement: where a new node goes + any normalization assignments. */
export interface InsertPlacement {
  parentId: string | null;
  position: string;
  assignments: MoveAssignment[];
}

/**
 * Placement for a new node as `id`'s NEXT SIBLING, unconditionally (duplicate,
 * split-below-a-collapsed-node). Null for an unknown id.
 */
export function siblingAfterPlacement<R extends PromptNodeFields>(
  model: PromptTreeModel<R>,
  id: string,
): InsertPlacement | null {
  const ctx = siblingListOf(model, id);
  if (!ctx) return null;
  const i = ctx.siblings.findIndex((s) => s.row.id === id);
  if (i === -1) return null;
  const parentId = ctx.parent?.row.id ?? null;
  const { positions, assignments } = effectiveSequence(ctx.siblings, parentId);
  const after = i + 1 < positions.length ? positions[i + 1] : null;
  return { parentId, position: generateKeyBetween(positions[i], after), assignments };
}

/**
 * Placement for a node created "on Enter" from `id` — Workflowy semantics: an
 * EXPANDED node with children gets the new node as its FIRST CHILD (visually
 * the next line); anything else gets it as the NEXT SIBLING. Returns the
 * create placement plus any normalization assignments (legacy NULL positions —
 * apply them via move alongside the create). Null for an unknown id.
 */
export function insertAfter<R extends PromptNodeFields>(
  model: PromptTreeModel<R>,
  id: string,
): InsertPlacement | null {
  const entry = model.byId.get(id);
  if (!entry) return null;
  const { node } = entry;
  if (node.children.length > 0 && !node.row.collapsed) {
    const { positions, assignments } = effectiveSequence(node.children, node.row.id);
    return {
      parentId: node.row.id,
      position: generateKeyBetween(null, positions[0] ?? null),
      assignments,
    };
  }
  return siblingAfterPlacement(model, id);
}

/**
 * Placement for a new node as `id`'s PREVIOUS SIBLING — Workflowy's Enter at
 * the start of a bullet: an empty bullet appears ABOVE and the caret stays in
 * the current text. Null for an unknown id.
 */
export function insertBefore<R extends PromptNodeFields>(
  model: PromptTreeModel<R>,
  id: string,
): InsertPlacement | null {
  const ctx = siblingListOf(model, id);
  if (!ctx) return null;
  const i = ctx.siblings.findIndex((s) => s.row.id === id);
  if (i === -1) return null;
  const parentId = ctx.parent?.row.id ?? null;
  const { positions, assignments } = effectiveSequence(ctx.siblings, parentId);
  const before = i > 0 ? positions[i - 1] : null;
  return { parentId, position: generateKeyBetween(before, positions[i]), assignments };
}

/**
 * Creation plan for duplicating `id`'s whole subtree (Workflowy Alt+Shift+D):
 * the copy lands as the original's NEXT SIBLING at the same level. `nodes` are
 * create-specs in creation order — `parentKey` points at the INDEX of the
 * copied parent within `nodes` (null = the plan root, whose parent is
 * `placement.parentId`). Children reuse the original position keys (the copy's
 * child list contains only copies, so the original keys stay valid and keep
 * order); legacy NULL positions get fresh appended keys. Null for unknown ids.
 */
export function duplicateSubtreePlan<R extends PromptNodeFields>(
  model: PromptTreeModel<R>,
  id: string,
): {
  placement: InsertPlacement;
  nodes: Array<{ parentKey: number | null; title: string | null; body: string; position: string }>;
} | null {
  const entry = model.byId.get(id);
  const placement = siblingAfterPlacement(model, id);
  if (!entry || !placement) return null;
  const nodes: Array<{
    parentKey: number | null;
    title: string | null;
    body: string;
    position: string;
  }> = [];
  const walk = (n: PromptTreeNode<R>, parentKey: number | null, position: string) => {
    nodes.push({ parentKey, title: n.row.title, body: n.row.body, position });
    const myKey = nodes.length - 1;
    let lastKey: string | null = null;
    for (const c of n.children) {
      const pos: string =
        c.row.position !== null && (lastKey === null || c.row.position > lastKey)
          ? c.row.position
          : generateKeyBetween(lastKey, null);
      lastKey = pos;
      walk(c, myKey, pos);
    }
  };
  walk(entry.node, null, placement.position);
  return { placement, nodes };
}

/**
 * Parse pasted multi-line text into outline rows (Workflowy paste): one bullet
 * per non-empty line, RELATIVE depth from leading indentation (a tab or every
 * two spaces = one level, rebased so the shallowest line is depth 0 and a
 * child is never more than one level below its parent), common bullet markers
 * (`- ` / `* ` / `• `) stripped. Single-line text returns one depth-0 row.
 */
export function parsePastedOutline(text: string): Array<{ title: string; depth: number }> {
  const lines = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((raw) => {
      const indentMatch = raw.match(/^[\t ]*/);
      const ws = indentMatch ? indentMatch[0] : '';
      const level = [...ws].reduce((n, ch) => n + (ch === '\t' ? 2 : 1), 0);
      const title = raw.slice(ws.length).replace(/^([-*•]|\d+[.)])\s+/, '').trimEnd();
      return { title, level: Math.floor(level / 2) };
    })
    .filter((l) => l.title.length > 0);
  if (lines.length === 0) return [];
  const min = Math.min(...lines.map((l) => l.level));
  const out: Array<{ title: string; depth: number }> = [];
  let prevDepth = -1;
  for (const l of lines) {
    const depth = Math.max(0, Math.min(l.level - min, prevDepth + 1));
    out.push({ title: l.title, depth });
    prevDepth = depth;
  }
  return out;
}

/**
 * Creation plan for the TAIL lines of a Workflowy multi-line paste (the first
 * pasted line merges into `id`'s own title at the caret — the caller does that
 * patch). `rows` are lines[1..] with parsePastedOutline's depths kept relative
 * to line 0: depth 0 ⇒ a sibling created after `id` (in order), depth 1 under
 * a depth-0 line that was line 0 itself ⇒ a CHILD of `id`, deeper ⇒ child of
 * the previous shallower create. `creates` come back in creation order:
 * `parentKey` is the index of the parent create, null ⇒ `parentId` is the real
 * node id to create under. Null for unknown ids.
 */
export function pasteOutlinePlan<R extends PromptNodeFields>(
  model: PromptTreeModel<R>,
  id: string,
  rows: Array<{ title: string; depth: number }>,
): {
  assignments: MoveAssignment[];
  creates: Array<{ parentKey: number | null; parentId: string | null; title: string; position: string }>;
} | null {
  const entry = model.byId.get(id);
  const ctx = siblingListOf(model, id);
  if (!entry || !ctx) return null;
  const i = ctx.siblings.findIndex((s) => s.row.id === id);
  if (i === -1) return null;
  const siblingParentId = ctx.parent?.row.id ?? null;
  const { positions, assignments } = effectiveSequence(ctx.siblings, siblingParentId);
  const nextKey = i + 1 < positions.length ? positions[i + 1] : null;
  const keys0 = generateNKeysBetween(positions[i], nextKey, rows.filter((r) => r.depth === 0).length);

  const creates: Array<{
    parentKey: number | null;
    parentId: string | null;
    title: string;
    position: string;
  }> = [];
  // anchors[d] = handle of the last materialized node at depth d ('self' = `id`).
  const anchors: Array<{ kind: 'self' } | { kind: 'create'; index: number }> = [{ kind: 'self' }];
  // Last child key handed out per parent handle ('self' seeds from existing children).
  let selfLastChildKey: string | null = null;
  for (const c of entry.node.children) {
    const p = c.row.position;
    if (p !== null && (selfLastChildKey === null || p > selfLastChildKey)) selfLastChildKey = p;
  }
  const createLastChildKey = new Map<number, string | null>();
  let k0 = 0;
  for (const r of rows) {
    const depth = Math.max(0, Math.min(r.depth, anchors.length));
    let spec: { parentKey: number | null; parentId: string | null; title: string; position: string };
    if (depth === 0) {
      spec = { parentKey: null, parentId: siblingParentId, title: r.title, position: keys0[k0++] };
    } else {
      const parent = anchors[Math.min(depth - 1, anchors.length - 1)];
      if (parent.kind === 'self') {
        const pos = generateKeyBetween(selfLastChildKey, null);
        selfLastChildKey = pos;
        spec = { parentKey: null, parentId: id, title: r.title, position: pos };
      } else {
        const last = createLastChildKey.get(parent.index) ?? null;
        const pos = generateKeyBetween(last, null);
        createLastChildKey.set(parent.index, pos);
        spec = { parentKey: parent.index, parentId: null, title: r.title, position: pos };
      }
    }
    creates.push(spec);
    anchors.length = Math.min(anchors.length, depth + 1);
    anchors[depth] = { kind: 'create', index: creates.length - 1 };
  }
  return { assignments, creates };
}

/** Swap with the previous sibling. Null when already first (or unknown id). */
export function moveUp<R extends PromptNodeFields>(
  model: PromptTreeModel<R>,
  id: string,
): MoveAssignment[] | null {
  const ctx = siblingListOf(model, id);
  if (!ctx) return null;
  const i = ctx.siblings.findIndex((s) => s.row.id === id);
  if (i <= 0) return null;
  const parentId = ctx.parent?.row.id ?? null;
  const { positions, assignments } = effectiveSequence(ctx.siblings, parentId);
  const before = i >= 2 ? positions[i - 2] : null;
  const pos = generateKeyBetween(before, positions[i - 1]);
  return mergeMoved(assignments, { id, parentId, position: pos });
}

/** Swap with the next sibling. Null when already last (or unknown id). */
export function moveDown<R extends PromptNodeFields>(
  model: PromptTreeModel<R>,
  id: string,
): MoveAssignment[] | null {
  const ctx = siblingListOf(model, id);
  if (!ctx) return null;
  const i = ctx.siblings.findIndex((s) => s.row.id === id);
  if (i === -1 || i >= ctx.siblings.length - 1) return null;
  const parentId = ctx.parent?.row.id ?? null;
  const { positions, assignments } = effectiveSequence(ctx.siblings, parentId);
  const after = i + 2 < positions.length ? positions[i + 2] : null;
  const pos = generateKeyBetween(positions[i + 1], after);
  return mergeMoved(assignments, { id, parentId, position: pos });
}

/** Tab: become the last child of the previous sibling. Null when no previous sibling. */
export function indent<R extends PromptNodeFields>(
  model: PromptTreeModel<R>,
  id: string,
): MoveAssignment[] | null {
  const ctx = siblingListOf(model, id);
  if (!ctx) return null;
  const i = ctx.siblings.findIndex((s) => s.row.id === id);
  if (i <= 0) return null;
  const newParent = ctx.siblings[i - 1];
  const last = newParent.children.length
    ? newParent.children[newParent.children.length - 1].row.position
    : null;
  const pos = generateKeyBetween(last ?? null, null);
  return [{ id, parentId: newParent.row.id, position: pos }];
}

/** Shift-Tab: move to be the sibling right after the current parent. Null for roots. */
export function outdent<R extends PromptNodeFields>(
  model: PromptTreeModel<R>,
  id: string,
): MoveAssignment[] | null {
  const entry = model.byId.get(id);
  if (!entry || !entry.parent) return null;
  const parent = entry.parent;
  const grand = model.byId.get(parent.row.id)?.parent ?? null;
  const grandId = grand?.row.id ?? null;
  const list = grand ? grand.children : model.roots;
  const pi = list.findIndex((s) => s.row.id === parent.row.id);
  const { positions, assignments } = effectiveSequence(list, grandId);
  const after = pi + 1 < positions.length ? positions[pi + 1] : null;
  const pos = generateKeyBetween(positions[pi], after);
  return mergeMoved(assignments, { id, parentId: grandId, position: pos });
}

// ---------------------------------------------------------------------------
// Drag-and-drop projection (WI-4840 D-006) — the dnd-kit SortableTree pattern:
// the UI renders the flattened visible rows, and while dragging it removes the
// active node's DESCENDANTS from that list (the subtree travels with the drag).
// All placement math lives here, pure; dnd-kit only supplies pointer mechanics.
// ---------------------------------------------------------------------------

export interface DropProjection {
  /** Clamped rendered depth the drop lands at. */
  depth: number;
  /** Real parent id at that depth (the zoom root when depth 0 inside a zoom). */
  parentId: string | null;
  /** Move assignments realizing the drop (active's move + any resequencing). */
  assignments: MoveAssignment[];
}

function arrayMoved<T>(list: T[], from: number, to: number): T[] {
  const next = list.slice();
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

/**
 * Project a drag of `activeId` over `overId` at `desiredDepth` (the pointer's
 * horizontal offset translated to a rendered depth by the caller).
 *
 * `flat` is the RENDERED row list with active's descendants removed but active
 * itself still present — exactly what the outline shows mid-drag. Depth is
 * clamped between the row above (may become its child) and the row below
 * (may not orphan it). Inside a zoom, depth-0 drops parent to `zoomRootId`.
 * Null when the ids are unknown or the drop would not move anything.
 */
export function projectDrop<R extends PromptNodeFields>(
  model: PromptTreeModel<R>,
  flat: VisibleRow<R>[],
  activeId: string,
  overId: string,
  desiredDepth: number,
  zoomRootId: string | null = null,
): DropProjection | null {
  const activeIndex = flat.findIndex((v) => v.node.row.id === activeId);
  const overIndex = flat.findIndex((v) => v.node.row.id === overId);
  if (activeIndex === -1 || overIndex === -1) return null;
  const active = model.byId.get(activeId);
  if (!active) return null;

  const next = arrayMoved(flat, activeIndex, overIndex);
  const prev = overIndex > 0 ? next[overIndex - 1] : null;
  const after = overIndex + 1 < next.length ? next[overIndex + 1] : null;

  const maxDepth = prev ? prev.depth + 1 : 0;
  const minDepth = after ? after.depth : 0;
  const depth = Math.max(minDepth, Math.min(maxDepth, desiredDepth));

  // Resolve the REAL parent id (rows carry absolute parentIds, so this is
  // zoom-safe): same depth as prev ⇒ share its parent; one deeper ⇒ prev IS
  // the parent; shallower ⇒ the nearest same-depth row above tells us.
  let parentId: string | null;
  if (depth === 0 || !prev) {
    parentId = zoomRootId;
  } else if (depth === prev.depth) {
    parentId = prev.node.row.parentId;
  } else if (depth > prev.depth) {
    parentId = prev.node.row.id;
  } else {
    const anchor = next
      .slice(0, overIndex)
      .reverse()
      .find((v) => v.depth === depth);
    parentId = anchor ? anchor.node.row.parentId : zoomRootId;
  }

  // A node can never become its own descendant.
  if (parentId !== null && subtreeIds(model, activeId).has(parentId)) return null;

  // Order within the new sibling list: neighbors are the closest rows in the
  // projected flat order that are DIRECT children of the chosen parent. Rows
  // carry absolute parentIds (a zoom's depth-0 rows are real children of the
  // zoom node), so plain comparison is zoom-safe.
  const sibBefore =
    next
      .slice(0, overIndex)
      .reverse()
      .find((v) => v.node.row.id !== activeId && v.node.row.parentId === parentId) ?? null;
  const sibAfter =
    next.slice(overIndex + 1).find((v) => v.node.row.id !== activeId && v.node.row.parentId === parentId) ??
    null;

  const siblingList = (
    parentId ? (model.byId.get(parentId)?.node.children ?? []) : model.roots
  ).filter((s) => s.row.id !== activeId);
  const { positions, assignments } = effectiveSequence(siblingList, parentId);
  const posOf = (rid: string | null): string | null => {
    if (!rid) return null;
    const i = siblingList.findIndex((s) => s.row.id === rid);
    return i === -1 ? null : positions[i];
  };
  const beforeKey = posOf(sibBefore?.node.row.id ?? null);
  const afterKey = posOf(sibAfter?.node.row.id ?? null);
  const position = generateKeyBetween(beforeKey, afterKey);

  return {
    depth,
    parentId,
    assignments: mergeMoved(
      assignments.filter((a) => a.id !== activeId),
      { id: activeId, parentId, position },
    ),
  };
}

// ---------------------------------------------------------------------------
// Tags (WI-4840 D-007) — Workflowy's #tag / @mention layer, parsed from text.
// ---------------------------------------------------------------------------

/** Global matcher for #tags / @mentions (letters/digits/_/-, must start alnum). */
export const TAG_RE = /(^|[\s([{'"])([#@][A-Za-z0-9][\w-]*)/g;

/**
 * Extract `#tag` / `@mention` tokens from text, deduplicated case-insensitively
 * (first casing wins), in first-appearance order.
 */
export function extractTags(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(TAG_RE)) {
    const tag = m[2];
    const key = tag.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(tag);
    }
  }
  return out;
}

/**
 * Extract `{{variable}}` placeholders from a prompt body, in first-appearance
 * order, deduplicated. Names are trimmed; empty braces are ignored.
 */
export function extractVariables(body: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of body.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)) {
    const name = m[1].trim();
    if (name && !seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

/** Substitute `{{variable}}` placeholders with the provided values (missing → left as-is). */
export function fillVariables(body: string, values: Record<string, string>): string {
  return body.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (whole, raw: string) => {
    const name = raw.trim();
    return Object.prototype.hasOwnProperty.call(values, name) ? values[name] : whole;
  });
}
