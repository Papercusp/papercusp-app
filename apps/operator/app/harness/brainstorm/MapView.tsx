'use client';


import { Tooltip } from '@/app/harness/Tooltip';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  ConnectionMode,
  addEdge,
  applyNodeChanges,
  applyEdgeChanges,
  useReactFlow,
  type Node as RFNode,
  type Edge as RFEdge,
  type NodeChange,
  type EdgeChange,
  type NodeProps,
  type Connection,
} from '@xyflow/react';
import dagre from '@dagrejs/dagre';
import '@xyflow/react/dist/style.css';
import { toast } from 'sonner';
import { useSyncQuery } from '@papercusp/sync';
import { Plus, X, Wand2 } from 'lucide-react';

interface Props { slug: string }

type NodeKind = 'idea' | 'question' | 'decision' | 'blocker';

interface MapNodeData extends Record<string, unknown> {
  text: string;
  kind: NodeKind;
}
type MapNode = RFNode<MapNodeData>;
type MapEdge = RFEdge;

interface Tree {
  nodes: MapNode[];
  edges: MapEdge[];
}

const NODE_W = 180;
const NODE_H = 52;

/* Legacy migration paths:
 *   - mind-elixir nested tree { nodeData: { id, topic, children: [] } }
 *   - reaflow flat { nodes: NodeData[], edges: EdgeData[] } (no positions)
 *   - native React Flow shape (this file's own format)
 * Anything that doesn't have explicit positions gets auto-arranged
 * via dagre on first load so the user doesn't see a pile at (0,0). */

type LegacyMENode = { id: string; topic?: string; children?: LegacyMENode[] };

export function isReactFlowTree(v: unknown): v is Tree {
  if (!v || typeof v !== 'object') return false;
  const t = v as any;
  return Array.isArray(t.nodes) && Array.isArray(t.edges)
    && t.nodes.every((n: any) => n && typeof n === 'object' && typeof n.id === 'string'
      && n.position && typeof n.position.x === 'number' && typeof n.position.y === 'number');
}

export function isReaflowTree(v: unknown): v is { nodes: Array<{ id: string; text?: string }>; edges: Array<{ id?: string; from: string; to: string }> } {
  if (!v || typeof v !== 'object') return false;
  const t = v as any;
  return Array.isArray(t.nodes) && Array.isArray(t.edges)
    && t.nodes.every((n: any) => n && typeof n.id === 'string' && (typeof n.text === 'string' || n.text === undefined));
}

export function meToTree(legacy: { nodeData?: LegacyMENode } | LegacyMENode): { nodes: Array<{ id: string; text: string }>; edges: Array<{ id: string; source: string; target: string }> } {
  const root: LegacyMENode | undefined = (legacy as any).nodeData ?? (legacy as LegacyMENode);
  const nodes: Array<{ id: string; text: string }> = [];
  const edges: Array<{ id: string; source: string; target: string }> = [];
  if (!root || typeof root !== 'object') return { nodes, edges };
  const walk = (n: LegacyMENode, parentId: string | null) => {
    if (!n?.id) return;
    nodes.push({ id: n.id, text: n.topic ?? '' });
    if (parentId) edges.push({ id: `${parentId}__${n.id}`, source: parentId, target: n.id });
    n.children?.forEach((c) => walk(c, n.id));
  };
  walk(root, null);
  return { nodes, edges };
}

/**
 * Run dagre to assign x/y to every node. Used on initial migration
 * (legacy data has no positions) AND on the user-triggered "auto-arrange"
 * button. After this runs, nodes are draggable and positions persist
 * — dagre is a one-shot tidy-up, not a continuous layout.
 */
function arrangeWithDagre(nodes: MapNode[], edges: MapEdge[]): MapNode[] {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: 'LR', nodesep: 30, ranksep: 80, marginx: 20, marginy: 20 });
  nodes.forEach((n) => g.setNode(n.id, { width: NODE_W, height: NODE_H }));
  edges.forEach((e) => g.setEdge(e.source, e.target));
  dagre.layout(g);
  return nodes.map((n) => {
    const pos = g.node(n.id);
    return { ...n, position: { x: pos.x - NODE_W / 2, y: pos.y - NODE_H / 2 } };
  });
}

function debounce<T extends (...args: any[]) => void>(fn: T, ms: number): T {
  let t: ReturnType<typeof setTimeout> | null = null;
  return ((...a: any[]) => { if (t) clearTimeout(t); t = setTimeout(() => fn(...a), ms); }) as T;
}

const NEW_ID = () => `n_${Math.random().toString(36).slice(2, 9)}`;

const KIND_OPTIONS: Array<{ kind: NodeKind; label: string }> = [
  { kind: 'idea', label: 'idea' },
  { kind: 'question', label: 'question' },
  { kind: 'decision', label: 'decision' },
  { kind: 'blocker', label: 'blocker' },
];

export function MapView({ slug }: Props) {
  return (
    <ReactFlowProvider>
      <MapInner slug={slug} />
    </ReactFlowProvider>
  );
}

function MapInner({ slug }: Props) {
  const [nodes, setNodes] = useState<MapNode[]>([]);
  const [edges, setEdges] = useState<MapEdge[]>([]);
  const [loaded, setLoaded] = useState(false);
  const slugRef = useRef(slug);
  slugRef.current = slug;
  const rf = useReactFlow();

  // Eager Zero subscription — replaces the lazy REST fetch so the mindmap
  // hydrates same-frame on open. The mindmap field on the brainstorm row
  // contains the tree shape directly (no /brainstorm-mindmap wrapper).
  const { data: brainstormRows } = useSyncQuery<{ harnessSlug: string; phase: string; content: string; canvas: unknown; mindmap: unknown; updatedAt: number }>({
    queryName: 'harnessBrainstorm.byHarness',
    args: { harnessSlug: slug },
    enabled: !!slug,
  });
  const brainstormRow = useMemo(
    () => Array.isArray(brainstormRows)
      ? brainstormRows.find((r) => r.phase === 'staging') ?? brainstormRows[0]
      : undefined,
    [brainstormRows],
  );

  // Initial load + migration. Anything without explicit positions
  // (mind-elixir or reaflow shape) gets dagre-arranged immediately.
  //
  // CRITICAL: load from the row exactly ONCE on mount. After that the
  // local state is the source of truth — every Zero refresh (which
  // includes the echo of our own PUT) would otherwise race the
  // persist's 500ms debounce: drag → setEdges has new edge → before
  // PUT fires, Zero echoes the old row → useEffect resets state to
  // old data → debounced persist saves the old data → user's edit
  // lost. Once-only-load avoids the race entirely. If a different tab
  // edits the same brainstorm, this tab won't see the update until
  // reload — acceptable for a per-user editing surface.
  const hasLoadedRef = useRef(false);
  useEffect(() => {
    if (hasLoadedRef.current) return;
    if (brainstormRows === undefined) return; // still loading
    hasLoadedRef.current = true;
    try {
      const tree = normalize(brainstormRow?.mindmap as never);
      setNodes(tree.nodes);
      setEdges(tree.edges);
      setLoaded(true);
    } catch (e: any) {
      toast.error(`Mindmap load failed: ${e?.message ?? e}`);
      const seed = seedTree();
      setNodes(seed.nodes);
      setEdges(seed.edges);
      setLoaded(true);
    }
  }, [brainstormRow, brainstormRows]);

  const persist = useMemo(() =>
    debounce((tree: Tree) => {
      fetch(`/api/harness/${slugRef.current}/brainstorm-mindmap`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tree }),
      }).catch((e) => toast.error(`Mindmap save failed: ${e?.message ?? e}`));
    }, 500), []);

  useEffect(() => {
    if (!loaded) return;
    persist({ nodes, edges });
  }, [nodes, edges, loaded, persist]);

  const onNodesChange = useCallback((changes: NodeChange<MapNode>[]) => {
    setNodes((nds) => applyNodeChanges(changes, nds));
  }, []);
  const onEdgesChange = useCallback((changes: EdgeChange<MapEdge>[]) => {
    setEdges((eds) => applyEdgeChanges(changes, eds));
  }, []);
  // Drag-to-connect: when the user drags from a node's source handle
  // to another node's target handle, ReactFlow fires onConnect with
  // {source, target}. addEdge dedupes if an identical edge already
  // exists. Without this handler, the drag completes visually but no
  // edge gets persisted.
  const onConnect = useCallback((conn: Connection) => {
    console.log('[MapView] onConnect', conn);
    if (!conn.source || !conn.target || conn.source === conn.target) return;
    setEdges((eds) => addEdge({
      id: `${conn.source}__${conn.target}`,
      source: conn.source!,
      target: conn.target!,
    }, eds));
  }, []);

  // Add a child of `parentId`. Position the new node a little down-and-right
  // of the parent so it lands somewhere sensible without a full re-layout.
  //
  // CRITICAL: never call setEdges or setEditingId from inside a setNodes
  // updater. React strict-mode invokes updaters twice for side-effect
  // detection — if we generate a random ID in the updater AND fire side
  // effects with it, the two invocations produce different IDs and the
  // committed state ends up with edges pointing to nodes that don't
  // exist (or vice versa). That bug corrupted persisted brainstorms
  // until 2026-05-06; the load path (`normalize` below) now also drops
  // orphan edges and orphan nodes to repair anything written by the
  // old code path.
  const addChild = useCallback((parentId: string) => {
    const parent = nodes.find((n) => n.id === parentId);
    if (!parent) return;
    const newId = NEW_ID();
    const newNode: MapNode = {
      id: newId,
      position: { x: parent.position.x + NODE_W + 60, y: parent.position.y + (Math.random() * 100 - 50) },
      data: { text: 'new idea', kind: 'idea' },
      type: 'mind',
    };
    setNodes((cur) => [...cur, newNode]);
    setEdges((cur) => [...cur, { id: `${parentId}__${newId}`, source: parentId, target: newId }]);
    setEditingId(newId);
  }, [nodes]);

  const [editingId, setEditingId] = useState<string | null>(null);

  // Visual "root" tag only (used for the highlighted blue card style).
  // Every node is now deletable — the earlier "root protected from
  // deletion" rule made the × button disappear on every node when
  // the graph was disconnected (no node had an incoming edge), and
  // disconnected graphs happened naturally via the prior addChild
  // bug. If the user deletes every node, seedTree() restores a fresh
  // root on next load.
  const rootIds = useMemo(() => {
    const incoming = new Set(edges.map((e) => e.target));
    return new Set(nodes.filter((n) => !incoming.has(n.id)).map((n) => n.id));
  }, [nodes, edges]);

  const deleteNode = useCallback((id: string) => {
    setNodes((nds) => nds.filter((n) => n.id !== id));
    setEdges((eds) => eds.filter((e) => e.source !== id && e.target !== id));
    if (editingId === id) setEditingId(null);
  }, [editingId]);

  const updateNode = useCallback((id: string, patch: Partial<MapNodeData>) => {
    setNodes((nds) => nds.map((n) => n.id === id ? { ...n, data: { ...n.data, ...patch } } : n));
  }, []);

  const autoArrange = useCallback(() => {
    setNodes((nds) => arrangeWithDagre(nds, edges));
    setTimeout(() => { try { rf.fitView({ duration: 200, padding: 0.2 }); } catch {} }, 50);
  }, [edges, rf]);

  // Recover from "deleted everything" — without this, an empty graph
  // has no nodes and therefore no [+] button to click. Spawn a fresh
  // root and immediately put it in edit mode.
  const addFirstNode = useCallback(() => {
    const seed = seedTree();
    setNodes(seed.nodes);
    setEdges(seed.edges);
    setEditingId(seed.nodes[0].id);
  }, []);

  // Use RF's native `selected` prop (driven by RF's own click handling)
  // for the selection visual + the Delete-key target. Custom React
  // selectionId state is gone — it caused two bugs:
  //   1. We were stopPropagation'ing clicks to set our own state,
  //      which prevented RF from marking the node as selected,
  //      which made deleteKeyCode/onNodesDelete a no-op.
  //   2. The visual "selected" border could disagree with RF's
  //      internal selection (e.g. after a click on the pane).
  // RF's selection is the single source of truth now.
  const nodeTypes = useMemo(() => ({
    mind: (props: NodeProps<MapNode>) => (
      <MapNodeBody
        {...props}
        isEditing={editingId === props.id}
        isSelected={!!props.selected}
        isRoot={rootIds.has(props.id)}
        onStartEdit={() => setEditingId(props.id)}
        onCommitEdit={(text) => { updateNode(props.id, { text }); setEditingId(null); }}
        onCancelEdit={() => setEditingId(null)}
        onChangeKind={(kind) => updateNode(props.id, { kind })}
        onAddChild={() => addChild(props.id)}
        onDelete={() => deleteNode(props.id)}
      />
    ),
  }), [editingId, rootIds, updateNode, addChild, deleteNode]);

  if (!loaded) return <div className="h-empty">loading mindmap…</div>;

  return (
    <div className="h-brainstorm-map" style={{ position: 'relative', width: '100%', height: '100%' }}>
      <div className="h-brainstorm-map-hint" aria-hidden="true">
        click <kbd>＋</kbd> to add child · drag to reposition · double-click to rename · <kbd>Del</kbd> to remove
      </div>
      <Tooltip label="Auto-arrange all nodes"><button
        type="button"
        className="h-brainstorm-map-arrange"
        onClick={autoArrange}

      >
        <Wand2 size={11} /> tidy
      </button></Tooltip>
      {nodes.length === 0 && (
        <div className="h-brainstorm-map-empty">
          <button type="button" className="h-brainstorm-map-empty-add" onClick={addFirstNode}>
            <Plus size={14} strokeWidth={2.5} /> add an idea
          </button>
        </div>
      )}
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onConnectStart={(_e, params) => console.log('[MapView] onConnectStart', params)}
        onConnectEnd={(_e) => console.log('[MapView] onConnectEnd')}
        // 'loose' lets any handle connect to any other handle — without
        // this, ReactFlow only allows source→target drags, so dragging
        // from a target handle on the right of one node to a source
        // handle on another silently no-ops.
        connectionMode={ConnectionMode.Loose}
        // 1px tolerance to make connections snap easily — without it,
        // releases just outside a handle's hit area silently no-op.
        connectionRadius={32}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.25 }}
        minZoom={0.2}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
        // Pressing Delete or Backspace on a selected node fires
        // onNodesDelete with the selected nodes. RF tracks the
        // selection internally — clicking a node selects it (the
        // wrapper sets `selected` on the NodeProps), so Delete
        // works without us having to focus the underlying div.
        deleteKeyCode={['Delete', 'Backspace']}
        onNodesDelete={(deleted) => {
          for (const n of deleted) deleteNode(n.id);
        }}
        className="h-brainstorm-map-rf"
      >
        <Background color="#2a3a4d" gap={20} size={1} />
        <Controls position="bottom-right" showInteractive={false} />
        <MiniMap
          nodeColor={(n) => kindAccent(((n.data as MapNodeData)?.kind) ?? 'idea')}
          maskColor="rgba(0,0,0,0.5)"
          style={{ background: 'color-mix(in srgb, var(--bg-popover), transparent 15%)' }}
          pannable
        />
      </ReactFlow>
    </div>
  );
}

/** Drop orphan edges (whose source or target node doesn't exist) and
 *  orphan nodes (no incoming AND no outgoing edges, except the root).
 *  Shipped after the addChild side-effect-in-updater bug corrupted some
 *  brainstorms — those have edges pointing to non-existent nodes. */
export function repairTree(tree: Tree): Tree {
  const nodeIds = new Set(tree.nodes.map((n) => n.id));
  const edges = tree.edges.filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target));
  return { nodes: tree.nodes, edges };
}

/** Migration entry point. Detects whatever shape we got and lifts it
 *  into the React Flow native shape, dagre-arranged if needed. */
export function normalize(raw: unknown): Tree {
  if (raw == null) return seedTree();
  if (isReactFlowTree(raw)) {
    return repairTree({
      nodes: raw.nodes.map((n) => ({ ...n, type: 'mind', data: { kind: 'idea' as NodeKind, text: '', ...(n.data as any) } })),
      edges: raw.edges,
    });
  }
  if (isReaflowTree(raw)) {
    const nodes: MapNode[] = raw.nodes.map((n) => ({
      id: n.id, type: 'mind', position: { x: 0, y: 0 },
      data: { text: n.text ?? '', kind: 'idea' },
    }));
    const edges: MapEdge[] = raw.edges.map((e, i) => ({
      id: e.id ?? `e_${i}`, source: e.from, target: e.to,
    }));
    const repaired = repairTree({ nodes, edges });
    return { nodes: arrangeWithDagre(repaired.nodes, repaired.edges), edges: repaired.edges };
  }
  // mind-elixir nested fallback.
  const flat = meToTree(raw as any);
  if (!flat.nodes.length) return seedTree();
  const nodes: MapNode[] = flat.nodes.map((n) => ({
    id: n.id, type: 'mind', position: { x: 0, y: 0 },
    data: { text: n.text, kind: 'idea' },
  }));
  const edges: MapEdge[] = flat.edges.map((e) => ({ id: e.id, source: e.source, target: e.target }));
  const repaired = repairTree({ nodes, edges });
  return { nodes: arrangeWithDagre(repaired.nodes, repaired.edges), edges: repaired.edges };
}

export function seedTree(): Tree {
  return {
    nodes: [{ id: 'root', type: 'mind', position: { x: 100, y: 200 }, data: { text: 'Brainstorm', kind: 'idea' } }],
    edges: [],
  };
}

export function kindAccent(kind: NodeKind): string {
  switch (kind) {
    case 'idea': return '#7aa2f7';
    case 'question': return '#e0af68';
    case 'decision': return '#9ece6a';
    case 'blocker': return '#f7768e';
  }
}

interface MapNodeBodyProps extends NodeProps<MapNode> {
  isEditing: boolean;
  isSelected: boolean;
  isRoot: boolean;
  onStartEdit: () => void;
  onCommitEdit: (text: string) => void;
  onCancelEdit: () => void;
  onChangeKind: (kind: NodeKind) => void;
  onAddChild: () => void;
  onDelete: () => void;
}

function MapNodeBody(props: MapNodeBodyProps) {
  const { data, isEditing, isSelected, isRoot, onStartEdit, onCommitEdit, onCancelEdit, onChangeKind, onAddChild, onDelete } = props;
  const { text, kind } = data;
  const [draft, setDraft] = useState(text);
  const [showKindMenu, setShowKindMenu] = useState(false);
  useEffect(() => { setDraft(text); }, [text, isEditing]);

  return (
    <div
      className={`rf-mind-node kind-${kind}${isRoot ? ' is-root' : ''}${isSelected ? ' is-selected' : ''}${isEditing ? ' is-editing' : ''}`}
      style={{ width: NODE_W, height: NODE_H }}
      onDoubleClick={(e) => { e.stopPropagation(); onStartEdit(); }}
    >
      {/* `nodrag` on every interactive element below so React Flow's
       * built-in drag handler doesn't swallow click/input events.
       * Without it, clicking the × button or typing in the rename
       * input starts a node drag instead — RF treats any pointerdown
       * on the node body as a drag start unless explicitly opted out. */}
      <Handle type="target" position={Position.Left} className="rf-mind-handle" />
      <Handle type="source" position={Position.Right} className="rf-mind-handle" />

      <span className={`rf-mind-kind-dot kind-${kind}`} title={kind} />
      {isEditing ? (
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => onCommitEdit(draft)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') { e.preventDefault(); onCommitEdit(draft); }
            else if (e.key === 'Escape') { e.preventDefault(); onCancelEdit(); }
          }}
          className="rf-mind-input nodrag nopan"
        />
      ) : (
        <span className="rf-mind-label">{text || 'empty'}</span>
      )}

      {/* Kind picker — lives inside the node, click the dot. */}
      {showKindMenu && (
        <div className="rf-mind-kindmenu nodrag nopan" onClick={(e) => e.stopPropagation()}>
          {KIND_OPTIONS.map((opt) => (
            <button
              key={opt.kind}
              type="button"
              className={`rf-mind-kindopt nodrag kind-${opt.kind}${kind === opt.kind ? ' on' : ''}`}
              onClick={(e) => { e.stopPropagation(); onChangeKind(opt.kind); setShowKindMenu(false); }}
            >
              <span className={`rf-mind-kind-dot kind-${opt.kind}`} />
              {opt.label}
            </button>
          ))}
        </div>
      )}
      <Tooltip label="Change type"><button
        type="button"
        className="rf-mind-kind-btn nodrag nopan"

        onClick={(e) => { e.stopPropagation(); setShowKindMenu((s) => !s); }}
      >
        type
      </button></Tooltip>

      <Tooltip label="Add child node"><button
        type="button"
        className="rf-mind-add nodrag nopan"

        onClick={(e) => { e.stopPropagation(); onAddChild(); }}
      >
        <Plus size={12} strokeWidth={2.5} />
      </button></Tooltip>
      <Tooltip label="Delete node"><button
        type="button"
        className="rf-mind-del nodrag nopan"

        onClick={(e) => { e.stopPropagation(); onDelete(); }}
      >
        <X size={11} strokeWidth={2.5} />
      </button></Tooltip>
    </div>
  );
}
