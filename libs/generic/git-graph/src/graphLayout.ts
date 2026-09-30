export interface Commit {
  sha: string;
  parents: string[];
  subject: string;
  author: string;
  ts: number;
  refs: string[];
}

export interface LaidOutCommit extends Commit {
  lane: number;
  row: number;
}

export const ROW_HEIGHT = 22;
export const LANE_WIDTH = 14;
export const NODE_WIDTH = 240;

// gitk-style lane assignment. `commits` is newest-first (--date-order).
// lanes[i] holds the sha the i-th lane is "waiting for" (the next expected
// commit in that lane) — or null if the lane is free.
//
// For each commit:
//   1. Find a lane currently waiting for this sha (merges can claim many).
//      If none, grab the first free lane.
//   2. Clear any lane still waiting on this sha (merge collapse).
//   3. Place commit in its lane, then schedule its first parent in the same
//      lane and any additional parents into free lanes.
export function assignLanes(commits: Commit[]): LaidOutCommit[] {
  const lanes: (string | null)[] = [];
  const out: LaidOutCommit[] = [];

  const firstFree = (): number => {
    for (let i = 0; i < lanes.length; i++) if (lanes[i] === null) return i;
    lanes.push(null);
    return lanes.length - 1;
  };

  commits.forEach((c, row) => {
    let lane = lanes.findIndex((s) => s === c.sha);
    if (lane === -1) {
      lane = firstFree();
    }
    for (let i = 0; i < lanes.length; i++) if (lanes[i] === c.sha) lanes[i] = null;

    out.push({ ...c, lane, row });

    if (c.parents[0]) lanes[lane] = c.parents[0];
    else lanes[lane] = null;

    for (let i = 1; i < c.parents.length; i++) {
      if (lanes.includes(c.parents[i])) continue;
      lanes[firstFree()] = c.parents[i];
    }
  });

  return out;
}

export interface GraphNode {
  id: string;
  type: 'commit';
  position: { x: number; y: number };
  data: { commit: LaidOutCommit; maxLane: number };
  draggable: false;
  selectable: true;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  type: 'smoothstep';
  style: { stroke: string; strokeWidth: number };
  sourceHandle?: string;
  targetHandle?: string;
}

export const LANE_COLORS = [
  '#3b82f6', '#10b981', '#f59e0b', '#ef4444',
  '#a855f7', '#06b6d4', '#eab308', '#ec4899',
  '#14b8a6', '#f97316',
];

export function laneColor(lane: number): string {
  return LANE_COLORS[lane % LANE_COLORS.length];
}

export function buildGraph(commits: Commit[]): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const laid = assignLanes(commits);
  const byId = new Map<string, LaidOutCommit>();
  for (const c of laid) byId.set(c.sha, c);
  const maxLane = laid.reduce((m, c) => Math.max(m, c.lane), 0);

  const nodes: GraphNode[] = laid.map((c) => ({
    id: c.sha,
    type: 'commit',
    position: { x: c.lane * LANE_WIDTH, y: c.row * ROW_HEIGHT },
    data: { commit: c, maxLane },
    draggable: false,
    selectable: true,
  }));

  const edges: GraphEdge[] = [];
  for (const c of laid) {
    for (const p of c.parents) {
      const parent = byId.get(p);
      if (!parent) continue;
      // Edge color follows the child's lane when it's a straight-line continuation,
      // otherwise color by parent's lane (branch divergence point).
      const sameLane = c.lane === parent.lane;
      const color = laneColor(sameLane ? c.lane : parent.lane);
      edges.push({
        id: `${c.sha}->${p}`,
        source: c.sha,
        target: p,
        type: 'smoothstep',
        style: { stroke: color, strokeWidth: 2 },
      });
    }
  }
  return { nodes, edges };
}
