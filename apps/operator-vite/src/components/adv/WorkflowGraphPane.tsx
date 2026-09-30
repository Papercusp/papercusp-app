/**
 * WorkflowGraphPane — the READ-ONLY topology pane of the Workflows detail view.
 *
 * Plan: external-triggers-gmail-slack-2026-08-22 (P-024), governed by D-013 as amended by
 * D-016.
 *
 * ── READ-ONLY IS THE DECISION, NOT A MISSING FEATURE ────────────────────────────────────
 * D-016 amended the interaction model: structural edits are AGENT-MEDIATED through the chat
 * panel beside this one, and the only direct controls are arm / disarm / test. So there is
 * deliberately no drag-to-connect, no node handle and no delete affordance here. Clicking a
 * node SELECTS it — which is how you ask the agent about that step — and nothing else.
 * Adding direct manipulation would contradict the governing decision, not extend it.
 *
 * ── elkjs COMES FROM THE SHARED SEAM ────────────────────────────────────────────────────
 * Layout uses `@/app/adv/elk-layout`, the same lazy loader and layered-LR options
 * DepGraphPanel uses. That module's cached promise is why opening both panes in one session
 * instantiates the ~1MB elk bundle once rather than twice. No second graph library is
 * introduced — reuse-first, and a second layout engine in a desktop bundle is a review smell.
 *
 * ── AN EMPTY CANVAS ALWAYS SAYS WHY ─────────────────────────────────────────────────────
 * Pending, unwired, and failed-to-lay-out are three different states and each says so. A
 * silently blank graph is indistinguishable from "this workflow does nothing", which is the
 * one thing a topology pane must never imply.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ELK_LAYERED_LR_OPTIONS, getElk, type ElkLaidOut } from '@/app/adv/elk-layout';
import {
  workflowGraphEmptyCopy,
  type WorkflowGraph,
  type WorkflowGraphNode,
  type WorkflowNodeKind,
} from './workflow-graph-model';

const NODE_W = 214;
const NODE_H = 74;
/** Room for the arrowhead and the selected node's stroke, which sit OUTSIDE the node box. */
const EDGE_PAD = 12;

const MIN_ZOOM = 0.4;
const MAX_ZOOM = 2.2;

/** Legend order — also the order kinds are introduced along a left-to-right flow. */
const KIND_ORDER: WorkflowNodeKind[] = ['trigger', 'filter', 'recipe', 'plan', 'tool', 'outcome'];

const KIND_LABEL: Record<WorkflowNodeKind, string> = {
  trigger: 'trigger',
  filter: 'filter',
  recipe: 'recipe',
  plan: 'plan',
  tool: 'tool',
  outcome: 'outcome',
};

interface Positioned {
  nodes: Array<WorkflowGraphNode & { x: number; y: number }>;
  width: number;
  height: number;
  /** Polyline points per edge id, in laid-out coordinates. */
  edgePaths: Array<{ id: string; points: Array<{ x: number; y: number }>; label: string | null }>;
}

export interface WorkflowGraphPaneProps {
  graph: WorkflowGraph;
  /** Currently selected node id (owned by the parent so it can live in the URL). */
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string | null) => void;
}

export default function WorkflowGraphPane({ graph, selectedNodeId, onSelectNode }: WorkflowGraphPaneProps) {
  const [positioned, setPositioned] = useState<Positioned | null>(null);
  const [layoutError, setLayoutError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const layoutSeq = useRef(0);
  const dragState = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number } | null>(
    null,
  );

  // Layout is keyed on the graph's SHAPE, not its object identity: the parent rebuilds the
  // graph object on every sync tick, and re-running a ~1MB layout engine on an unchanged
  // topology would thrash the pane on every poll.
  const shapeKey = useMemo(
    () =>
      JSON.stringify({
        n: graph.nodes.map((n) => [n.id, n.kind, n.label, n.detail, n.meta, n.state]),
        e: graph.edges.map((e) => [e.id, e.from, e.to, e.label]),
      }),
    [graph],
  );

  useEffect(() => {
    if (graph.nodes.length === 0) {
      setPositioned(null);
      setLayoutError(null);
      return;
    }
    const seq = ++layoutSeq.current;
    let cancelled = false;

    void (async () => {
      try {
        const elk = await getElk();
        const laid = (await elk.layout({
          id: 'root',
          layoutOptions: ELK_LAYERED_LR_OPTIONS,
          children: graph.nodes.map((n) => ({ id: n.id, width: NODE_W, height: NODE_H })),
          edges: graph.edges.map((e) => ({ id: e.id, sources: [e.from], targets: [e.to] })),
        })) as ElkLaidOut;

        if (cancelled || seq !== layoutSeq.current) return;

        const pos = new Map((laid.children ?? []).map((c) => [c.id, c]));
        const nodes = graph.nodes.map((n) => ({
          ...n,
          x: pos.get(n.id)?.x ?? 0,
          y: pos.get(n.id)?.y ?? 0,
        }));

        // Size the canvas from the NODES, not from ELK's reported extent alone — the same
        // rule DepGraphPanel documents. Any disagreement between the two would otherwise be
        // resolved by clipping, and a half-drawn card reads as a scroll boundary rather than
        // as a bug.
        const extentW = nodes.reduce((m, n) => Math.max(m, n.x + NODE_W), 0) + EDGE_PAD;
        const extentH = nodes.reduce((m, n) => Math.max(m, n.y + NODE_H), 0) + EDGE_PAD;

        const byId = new Map(nodes.map((n) => [n.id, n]));
        const edgePaths = graph.edges.map((e) => {
          const section = (laid.edges ?? []).find((le) => le.id === e.id)?.sections?.[0];
          if (section) {
            return {
              id: e.id,
              label: e.label,
              points: [section.startPoint, ...(section.bendPoints ?? []), section.endPoint],
            };
          }
          // Fall back to a straight edge between node ports if ELK reported no routing —
          // a drawn-but-approximate edge beats a silently missing one.
          const from = byId.get(e.from);
          const to = byId.get(e.to);
          if (!from || !to) return { id: e.id, label: e.label, points: [] };
          return {
            id: e.id,
            label: e.label,
            points: [
              { x: from.x + NODE_W, y: from.y + NODE_H / 2 },
              { x: to.x, y: to.y + NODE_H / 2 },
            ],
          };
        });

        setPositioned({
          nodes,
          width: Math.max(laid.width ?? 0, extentW),
          height: Math.max(laid.height ?? 0, extentH),
          edgePaths,
        });
        setLayoutError(null);
      } catch (err) {
        if (cancelled || seq !== layoutSeq.current) return;
        // Surface it. A silently blank graph is indistinguishable from "nothing is wired".
        setLayoutError(err instanceof Error ? err.message : String(err));
      }
    })();

    return () => {
      cancelled = true;
    };
    // shapeKey is the real dependency; `graph` is referenced inside but only ever with the
    // same contents shapeKey encodes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shapeKey]);

  const onWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    if (!event.ctrlKey && !event.metaKey && Math.abs(event.deltaY) < 1) return;
    event.preventDefault();
    setZoom((z) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z * (event.deltaY > 0 ? 0.92 : 1.08))));
  }, []);

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    // Only a background drag pans; a drag starting on a node would fight node selection.
    if ((event.target as HTMLElement).closest('[data-wf-node]')) return;
    dragState.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: pan.x,
      originY: pan.y,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }, [pan.x, pan.y]);

  const onPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragState.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setPan({
      x: drag.originX + (event.clientX - drag.startX),
      y: drag.originY + (event.clientY - drag.startY),
    });
  }, []);

  const endDrag = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (dragState.current?.pointerId !== event.pointerId) return;
    dragState.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  const resetView = useCallback(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, []);

  const presentKinds = useMemo(() => {
    const present = new Set(graph.nodes.map((n) => n.kind));
    return KIND_ORDER.filter((k) => present.has(k));
  }, [graph.nodes]);

  return (
    <section className="pc-workflow-graph" aria-label="Workflow topology">
      <header className="pc-workflow-graph__head">
        <div>
          <h3 className="pc-workflow-graph__title">Topology</h3>
          <p className="pc-workflow-graph__sub">read-only · elkjs layout, lazy-loaded</p>
        </div>
        <div className="pc-workflow-graph__legend" role="list">
          {presentKinds.map((kind) => (
            <span key={kind} role="listitem" className={`pc-workflow-graph__legend-item pc-wf-kind--${kind}`}>
              <span className="pc-workflow-graph__swatch" aria-hidden="true" />
              {KIND_LABEL[kind]}
            </span>
          ))}
        </div>
      </header>

      <div
        className="pc-workflow-graph__canvas"
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        {graph.emptyReason ? (
          <p className="pc-workflow-graph__empty">{workflowGraphEmptyCopy(graph.emptyReason)}</p>
        ) : layoutError ? (
          <p className="pc-workflow-graph__empty pc-workflow-graph__empty--error" role="alert">
            Could not lay out this workflow: {layoutError}
          </p>
        ) : !positioned ? (
          <p className="pc-workflow-graph__empty">Laying out…</p>
        ) : (
          <div
            className="pc-workflow-graph__viewport"
            style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
          >
            <svg
              className="pc-workflow-graph__edges"
              width={positioned.width}
              height={positioned.height}
              aria-hidden="true"
            >
              <defs>
                <marker
                  id="pc-wf-arrow"
                  viewBox="0 0 8 8"
                  refX="7"
                  refY="4"
                  markerWidth="7"
                  markerHeight="7"
                  orient="auto-start-reverse"
                >
                  <path d="M0,0 L8,4 L0,8 z" fill="currentColor" />
                </marker>
              </defs>
              {positioned.edgePaths.map((edge) => {
                if (edge.points.length < 2) return null;
                const points = edge.points.map((p) => `${p.x},${p.y}`).join(' ');
                const mid = edge.points[Math.floor(edge.points.length / 2)];
                return (
                  <g key={edge.id} className="pc-workflow-graph__edge">
                    <polyline points={points} markerEnd="url(#pc-wf-arrow)" />
                    {edge.label ? (
                      <text x={mid.x} y={mid.y - 8} textAnchor="middle" className="pc-workflow-graph__edge-label">
                        {edge.label}
                      </text>
                    ) : null}
                  </g>
                );
              })}
            </svg>

            {positioned.nodes.map((node) => {
              const selected = node.id === selectedNodeId;
              return (
                <button
                  key={node.id}
                  type="button"
                  data-wf-node={node.id}
                  aria-pressed={selected}
                  className={[
                    'pc-workflow-graph__node',
                    `pc-wf-kind--${node.kind}`,
                    `pc-wf-state--${node.state}`,
                    selected ? 'is-selected' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  style={{ left: node.x, top: node.y, width: NODE_W, height: NODE_H }}
                  onClick={() => onSelectNode(selected ? null : node.id)}
                >
                  <span className="pc-workflow-graph__node-label">{node.label}</span>
                  <span className="pc-workflow-graph__node-detail">{node.detail}</span>
                  <span className="pc-workflow-graph__node-foot">
                    <span className="pc-workflow-graph__node-kind">{KIND_LABEL[node.kind]}</span>
                    {node.meta ? <span className="pc-workflow-graph__node-meta">{node.meta}</span> : null}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      <footer className="pc-workflow-graph__foot">
        <span>Click a node to ask the agent about it · drag to pan · scroll to zoom</span>
        <button type="button" className="pc-workflow-graph__reset" onClick={resetView}>
          Reset view
        </button>
      </footer>
    </section>
  );
}
