import type { GroupNode, LayoutDoc, PanelInstance, TabStrip } from './layout';

type DvSerializedPanel = {
  id: string;
  contentComponent: string;
  title?: string;
  params?: Record<string, unknown>;
};

type DvSerializedGridLeaf = {
  type: 'leaf';
  data: {
    views: string[];
    activeView?: string;
    id: string;
  };
  size?: number;
};

type DvSerializedGridBranch = {
  type: 'branch';
  data: DvSerializedGridNode[];
  size?: number;
};

type DvSerializedGridNode = DvSerializedGridLeaf | DvSerializedGridBranch;

type DvSerializedGrid = {
  root: DvSerializedGridBranch;
  height: number;
  width: number;
  orientation: 'HORIZONTAL' | 'VERTICAL';
};

type DvSerializedFloatingGroup = {
  data: DvSerializedGridLeaf;
  position: { left: number; top: number; width: number; height: number };
};

export type DockviewLayout = {
  grid: DvSerializedGrid;
  panels: Record<string, DvSerializedPanel>;
  activeGroup?: string;
  floatingGroups?: DvSerializedFloatingGroup[];
};

export function toDockviewJson(doc: LayoutDoc): DockviewLayout {
  const panels: Record<string, DvSerializedPanel> = {};

  function leafFromTabs(t: TabStrip): DvSerializedGridLeaf {
    for (const p of t.panels) panels[p.id] = panelToDv(p);
    return {
      type: 'leaf',
      data: {
        views: t.panels.map((p) => p.id),
        activeView: t.activePanelId,
        id: t.id,
      },
      size: t.size,
    };
  }

  function nodeToBranch(n: GroupNode | TabStrip | null | undefined): DvSerializedGridNode {
    if (!n) return { type: 'branch', data: [] };
    if (n.kind === 'tabs') return leafFromTabs(n);
    return {
      type: 'branch',
      data: (n.children ?? []).map(nodeToBranch),
      size: n.size,
    };
  }

  const rootDir = doc.root?.kind === 'group' ? doc.root.direction ?? 'row' : 'row';
  const serializedRoot = nodeToBranch(doc.root);
  // Dockview's persisted grid contract always requires a branch at the root,
  // even when the logical layout is a single tab strip. LayoutDoc deliberately
  // permits that compact root form, so adapt it here instead of forcing every
  // host seed to invent a one-child group.
  const root: DvSerializedGridBranch = serializedRoot.type === 'branch'
    ? serializedRoot
    : { type: 'branch', data: [serializedRoot] };
  const floatingGroups: DvSerializedFloatingGroup[] = (doc.floating ?? []).map((f) => {
    const leaf: DvSerializedGridLeaf = {
      type: 'leaf',
      data: {
        views: f.panels.map((p) => p.id),
        activeView: f.activePanelId,
        id: f.id,
      },
    };
    for (const p of f.panels) panels[p.id] = panelToDv(p);
    return {
      data: leaf,
      position: { left: f.x, top: f.y, width: f.width, height: f.height },
    };
  });

  return {
    grid: {
      root,
      orientation: rootDir === 'col' ? 'VERTICAL' : 'HORIZONTAL',
      height: 0,
      width: 0,
    },
    panels,
    floatingGroups: floatingGroups.length > 0 ? floatingGroups : undefined,
  };
}

function panelToDv(p: PanelInstance): DvSerializedPanel {
  return {
    id: p.id,
    contentComponent: p.type,
    title: p.title,
    params: p.params,
  };
}

export function toLayoutDoc(dv: DockviewLayout): LayoutDoc {
  const rootDir: 'row' | 'col' = dv.grid.orientation === 'VERTICAL' ? 'col' : 'row';
  // INVERSE of toDockviewJson's root-branch wrap. That direction must always emit a
  // branch at the root (dockview's persisted grid contract) even when the logical
  // layout is a single tab strip — so this direction has to unwrap it again, or a
  // compact `tabs` root does not survive a round trip and comes back as a `group`
  // wrapping one child. Both root forms serialize to the SAME dockview JSON (a branch
  // with one leaf), so that shape is genuinely ambiguous on the way back and the
  // compact form is the canonical inverse: it is what a caller wrote, it re-serializes
  // identically, and it makes roundTrip idempotent. Only a SINGLE-LEAF root branch is
  // unwrapped — a one-child branch whose child is itself a branch is a real nested
  // group and is left alone.
  const dvRoot = dv.grid.root;
  const soleLeafRoot =
    dvRoot.type === 'branch' && dvRoot.data.length === 1 && dvRoot.data[0]?.type === 'leaf'
      ? dvRoot.data[0]
      : dvRoot;
  const root = gridNodeToNode(soleLeafRoot, dv.panels, rootDir);
  const floating = (dv.floatingGroups ?? []).map((fg) => ({
    id: fg.data.data.id,
    x: fg.position.left,
    y: fg.position.top,
    width: fg.position.width,
    height: fg.position.height,
    panels: fg.data.data.views.map((id) => dvPanelToInstance(id, dv.panels[id])),
    activePanelId: fg.data.data.activeView ?? fg.data.data.views[0] ?? '',
  }));
  return {
    schemaVersion: 1,
    root,
    floating: floating.length > 0 ? floating : undefined,
  };
}

function gridNodeToNode(
  n: DvSerializedGridNode,
  panels: Record<string, DvSerializedPanel>,
  currentDir: 'row' | 'col',
): GroupNode | TabStrip {
  if (n.type === 'leaf') {
    return {
      kind: 'tabs',
      id: n.data.id,
      activePanelId: n.data.activeView ?? n.data.views[0] ?? '',
      panels: n.data.views.map((id) => dvPanelToInstance(id, panels[id])),
      size: n.size,
    };
  }
  const childDir: 'row' | 'col' = currentDir === 'row' ? 'col' : 'row';
  return {
    kind: 'group',
    id: cryptoId('g'),
    direction: currentDir,
    children: n.data.map((c) => gridNodeToNode(c, panels, childDir)),
    size: n.size,
  };
}

function dvPanelToInstance(id: string, p: DvSerializedPanel | undefined): PanelInstance {
  if (!p) return { id, type: '__missing__', params: { __orphan: true } };
  return {
    id: p.id,
    type: p.contentComponent,
    title: p.title,
    params: p.params,
  };
}

function cryptoId(prefix: string): string {
  try {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
      return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
    }
  } catch {
    /* ignored */
  }
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

export function roundTrip(doc: LayoutDoc): LayoutDoc {
  return toLayoutDoc(toDockviewJson(doc));
}
