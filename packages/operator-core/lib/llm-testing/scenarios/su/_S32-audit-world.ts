/**
 * SU-S32 — the POPULATED "p2p program" world an audit runs against.
 *
 * WHY THIS EXISTS. The su llm-test target stubs every tool result by design
 * (targets/su.ts: "Why the executor stubs instead of running dispatchProjectedTool
 * for real"), and the runner stamps `workspace_mode` from `scenario.realWorkspace`
 * without the su target ever reading it. So the first recorded SU-S32 pass
 * (llm_test_runs ff1921c0-…, 2026-09-01) ran against NOTHING: the judge wrote that
 * the agent "never reached the point of actually executing the audit methodology"
 * because every read came back empty. Flipping `realWorkspace: true` would only
 * change the recorded LABEL. This fixture is the honest fix: it gives the audit
 * reads a real-shaped population so the whole-picture method can actually be
 * EXECUTED and judged, not merely described (WI-2089274).
 *
 * WHAT THE WORLD ENCODES — every "churn, not progress" marker the owner's
 * question turns on, none of them visible from an open-items read:
 *
 *   - LIFECYCLE: 7 plans across draft / active / shipped / superseded / archived.
 *     Like the production writer, `plans:list` returns every non-archived
 *     lifecycle by default and SAYS that archive rows were omitted. A complete
 *     census re-asks with `includeArchived:true`; `status:'all'` is deliberately
 *     rejected because that value is not in the live schema.
 *   - STALE ## Now: p2p-nat-traversal's ## Now (2026-07-03) claims "all remaining
 *     items in flight" while its ledger shows two items blocked on a phantom (P-004
 *     shipped 2026-06-20) and nothing touched since.
 *   - PHANTOM BLOCKERS: WI-7288 / WI-7289 are blocked on that done item.
 *   - REPEAT PRIOR-WORKERS: WI-7301 has been picked up three times by two agents;
 *     WI-7311 is "soak run #4" with three earlier runs and no recorded verdict.
 *   - RE-VALIDATION: p2p-hardening's first three items re-validate work that
 *     p2p-transport already SHIPPED — redoing, not advancing.
 *   - RE-OPENS: WI-6980 done → reopened → done.
 *   - STRANDED CLAIMS: WI-7150 is held by su-4a1f…, whose session ENDED 2026-07-21
 *     (`coord:presence` says so — sessionState is the liveness verdict).
 *   - STATUS-SUMMARY LOOP: three "write a status summary" items, two already done
 *     and both saying "on track" with the same remaining list.
 *
 * Every read is deterministic and side-effect free. Anything not modelled here
 * passes through to the target's benign stub.
 */

import { PASS_THROUGH } from '@papercusp/testing-shell/llm';
import type { ToolDispatchOverride, ToolResult } from '@papercusp/testing-shell/llm';

function canonical(name: string): string {
  return name.replace(/^mcp__agentmcp__/, '');
}

function json(payload: unknown, isError = false): ToolResult {
  return { content: [{ text: JSON.stringify(payload) }], ...(isError ? { isError: true } : {}) };
}

type Args = Record<string, unknown>;
function argsOf(a: unknown): Args {
  return a && typeof a === 'object' ? (a as Args) : {};
}

/** The audit's "now" — fixed so ages in the world are stable across runs. */
export const AUDIT_WORLD_NOW = '2026-09-01T18:00:00Z';

// --- agents ------------------------------------------------------------------

const AGENT_ENDED_JUL = 'su-4a1f9e0c-3d7b-4c1e-9f2a-6b8d1e0c4a7f';
const AGENT_PARKED = 'su-9c2e51b0-7a44-4e8d-b3c6-0f1d2a9e8b55';
const AGENT_LIVE = 'su-b77d0a44-1c2e-4f5a-8d9b-3e6c7a1f0d22';
const AGENT_ENDED_AUG = 'su-e01a3c9d-5b7e-4a2f-9c1d-8e0b6f4a2d11';

// --- plans -------------------------------------------------------------------

export type WorldPlanStatus = 'draft' | 'active' | 'shipped' | 'superseded' | 'archived';

export interface WorldPlanItem {
  id: string;
  title: string;
  status: 'todo' | 'wip' | 'blocked' | 'done' | 'dropped';
  updatedAt: string;
  assignee?: string;
  blockedBy?: string;
  note?: string;
}

export interface WorldPlan {
  slug: string;
  title: string;
  status: WorldPlanStatus;
  createdAt: string;
  updatedAt: string;
  shippedAt?: string;
  supersededBy?: string;
  archivedNote?: string;
  now: { state: string; next: string; updatedAt: string };
  items: WorldPlanItem[];
  decisions: string[];
}

function doneItems(prefix: string, titles: string[], at: string): WorldPlanItem[] {
  return titles.map((title, i) => ({ id: `P-${String(i + 1).padStart(3, '0')}`, title: `${prefix} ${title}`, status: 'done', updatedAt: at }));
}

export const AUDIT_WORLD_PLANS: readonly WorldPlan[] = [
  {
    slug: 'p2p-relay-bootstrap-2026-03-04',
    title: 'p2p — relay bootstrap',
    status: 'shipped',
    createdAt: '2026-03-04',
    updatedAt: '2026-04-18',
    shippedAt: '2026-04-18',
    now: { state: 'shipped', next: 'none', updatedAt: '2026-04-18' },
    items: doneItems('relay', ['bootstrap node list', 'relay handshake', 'relay keepalive', 'relay metrics', 'relay failover', 'relay docs'], '2026-04-18'),
    decisions: ['D-001 relays are bootstrap-only; peers must dial direct within 30s or fall back'],
  },
  {
    slug: 'p2p-transport-2026-04-22',
    title: 'p2p — transport layer',
    status: 'shipped',
    createdAt: '2026-04-22',
    updatedAt: '2026-06-02',
    shippedAt: '2026-06-02',
    now: { state: 'shipped', next: 'none', updatedAt: '2026-06-02' },
    items: doneItems('transport', ['wire codec', 'framing', 'handshake retry', 'connection pool', 'backpressure', 'TLS pinning', 'reconnect', 'soak'], '2026-06-02'),
    decisions: ['D-002 handshake retry is bounded at 3 attempts with jitter (P-003)', 'D-004 backpressure is credit-based, 64 frames per stream (P-005)'],
  },
  {
    slug: 'p2p-discovery-2026-05-15',
    title: 'p2p — peer discovery',
    status: 'superseded',
    createdAt: '2026-05-15',
    updatedAt: '2026-06-30',
    supersededBy: 'p2p-discovery-v2-2026-06-30',
    now: { state: 'superseded by p2p-discovery-v2-2026-06-30', next: 'none', updatedAt: '2026-06-30' },
    items: [
      { id: 'P-001', title: 'discovery DHT bootstrap', status: 'done', updatedAt: '2026-05-28' },
      { id: 'P-002', title: 'discovery peer exchange', status: 'done', updatedAt: '2026-06-05' },
      { id: 'P-003', title: 'discovery gossip', status: 'done', updatedAt: '2026-06-12' },
      { id: 'P-004', title: 'discovery mDNS', status: 'done', updatedAt: '2026-06-18' },
      { id: 'P-005', title: 'discovery relay fallback', status: 'dropped', updatedAt: '2026-06-30', note: 'moved to v2 P-005' },
      { id: 'P-006', title: 'discovery mDNS fallback', status: 'dropped', updatedAt: '2026-06-30', note: 'moved to v2 P-007' },
      { id: 'P-007', title: 'discovery soak', status: 'dropped', updatedAt: '2026-06-30', note: 'moved to v2 P-009' },
    ],
    decisions: ['D-001 v1 gossip is replaced wholesale by v2 (design flaw: unbounded fan-out)'],
  },
  {
    slug: 'p2p-discovery-v2-2026-06-30',
    title: 'p2p — peer discovery v2',
    status: 'active',
    createdAt: '2026-06-30',
    updatedAt: '2026-07-21',
    now: {
      state: 'P-007 (mDNS fallback) wip — su-4a1f… on it',
      next: 'P-008 relay fallback, then P-009 soak',
      updatedAt: '2026-07-21',
    },
    items: [
      ...doneItems('discovery-v2', ['bounded gossip', 'DHT bootstrap', 'peer exchange', 'scoring', 'relay fallback', 'metrics'], '2026-07-15'),
      { id: 'P-007', title: 'discovery-v2 mDNS fallback', status: 'wip', updatedAt: '2026-07-21', assignee: AGENT_ENDED_JUL },
      { id: 'P-008', title: 'discovery-v2 relay fallback hardening', status: 'todo', updatedAt: '2026-06-30' },
      { id: 'P-009', title: 'discovery-v2 soak', status: 'todo', updatedAt: '2026-06-30' },
    ],
    decisions: ['D-001 fan-out is bounded at 8 peers per round'],
  },
  {
    slug: 'p2p-nat-traversal-2026-05-28',
    title: 'p2p — NAT traversal',
    status: 'active',
    createdAt: '2026-05-28',
    updatedAt: '2026-07-03',
    now: {
      state: 'all remaining items in flight (P-008, P-009 blocked on P-004; P-010, P-011 claimed)',
      next: 'soak run #3',
      updatedAt: '2026-07-03',
    },
    items: [
      ...doneItems('nat', ['STUN client', 'candidate gathering', 'ICE lite', 'STUN probe service', 'TURN fallback', 'symmetric-NAT detection', 'metrics'], '2026-06-20'),
      { id: 'P-008', title: 'nat hole-punch fallback', status: 'blocked', updatedAt: '2026-06-12', blockedBy: 'P-004', note: 'waiting on the STUN probe service' },
      { id: 'P-009', title: 'nat relay handoff', status: 'blocked', updatedAt: '2026-06-12', blockedBy: 'P-004', note: 'waiting on the STUN probe service' },
      { id: 'P-010', title: 'nat soak run', status: 'todo', updatedAt: '2026-05-28' },
      { id: 'P-011', title: 'nat runbook', status: 'todo', updatedAt: '2026-05-28' },
    ],
    decisions: ['D-003 P-004 STUN probe service shipped 2026-06-20; P-008 / P-009 may proceed'],
  },
  {
    slug: 'p2p-observability-2026-07-08',
    title: 'p2p — observability',
    status: 'archived',
    createdAt: '2026-07-08',
    updatedAt: '2026-08-01',
    archivedNote: 'archived 2026-08-01: folded into p2p-hardening; no items shipped',
    now: { state: 'archived', next: 'none', updatedAt: '2026-08-01' },
    items: [
      { id: 'P-001', title: 'observability tracing', status: 'todo', updatedAt: '2026-07-08' },
      { id: 'P-002', title: 'observability dashboards', status: 'todo', updatedAt: '2026-07-08' },
      { id: 'P-003', title: 'observability alerts', status: 'todo', updatedAt: '2026-07-08' },
      { id: 'P-004', title: 'observability log schema', status: 'dropped', updatedAt: '2026-08-01' },
    ],
    decisions: [],
  },
  {
    slug: 'p2p-hardening-2026-08-15',
    title: 'p2p — hardening',
    status: 'draft',
    createdAt: '2026-08-15',
    updatedAt: '2026-08-28',
    now: { state: 'drafting', next: 're-validate transport + discovery before hardening', updatedAt: '2026-08-28' },
    items: [
      { id: 'P-001', title: 'Re-validate p2p-transport P-003 handshake retry', status: 'todo', updatedAt: '2026-08-15' },
      { id: 'P-002', title: 'Re-validate p2p-transport P-005 backpressure', status: 'todo', updatedAt: '2026-08-15' },
      { id: 'P-003', title: 'Re-verify discovery-v2 P-005 relay fallback', status: 'todo', updatedAt: '2026-08-16' },
      { id: 'P-004', title: 'Threat model', status: 'todo', updatedAt: '2026-08-15' },
      { id: 'P-005', title: 'Fuzz the wire codec', status: 'todo', updatedAt: '2026-08-15' },
    ],
    decisions: [],
  },
];

const DEFAULT_PLAN_STATUSES: readonly WorldPlanStatus[] = [
  'draft',
  'active',
  'shipped',
  'superseded',
];

function planSummary(p: WorldPlan) {
  const counts: Record<string, number> = {};
  for (const it of p.items) counts[it.status] = (counts[it.status] ?? 0) + 1;
  return {
    slug: p.slug,
    title: p.title,
    status: p.status,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    ...(p.shippedAt ? { shippedAt: p.shippedAt } : {}),
    ...(p.supersededBy ? { supersededBy: p.supersededBy } : {}),
    ...(p.archivedNote ? { archivedNote: p.archivedNote } : {}),
    itemCounts: counts,
  };
}

function planStatusCounts(): Record<WorldPlanStatus, number> {
  const c: Record<WorldPlanStatus, number> = { draft: 0, active: 0, shipped: 0, superseded: 0, archived: 0 };
  for (const p of AUDIT_WORLD_PLANS) c[p.status] += 1;
  return c;
}

function requestedStatuses(a: Args): readonly WorldPlanStatus[] | 'all' {
  const s = a.status ?? a.statuses;
  if (a.includeArchived === true) return 'all';
  if (typeof s === 'string') return [s as WorldPlanStatus];
  if (Array.isArray(s)) return s.filter((x): x is WorldPlanStatus => typeof x === 'string');
  return DEFAULT_PLAN_STATUSES;
}

// --- work items --------------------------------------------------------------

export interface WorldItem {
  id: string;
  title: string;
  kind: 'task' | 'bug' | 'feature';
  state: 'open' | 'blocked' | 'done' | 'dropped';
  sourcePlanSlug: string;
  planItem?: string;
  createdAt: string;
  updatedAt: string;
  assignee?: string | null;
  takenAt?: string;
  lastProgressAt?: string;
  blockedBy?: string[];
  priorWorkers?: string[];
  reopenCount?: number;
  note?: string;
  completionSummary?: string;
}

export const AUDIT_WORLD_ITEMS: readonly WorldItem[] = [
  {
    id: 'WI-7150',
    title: 'discovery-v2 P-007 mDNS fallback',
    kind: 'feature',
    state: 'open',
    sourcePlanSlug: 'p2p-discovery-v2-2026-06-30',
    planItem: 'P-007',
    createdAt: '2026-07-01',
    updatedAt: '2026-07-21',
    assignee: AGENT_ENDED_JUL,
    takenAt: '2026-07-19T09:12:00Z',
    lastProgressAt: '2026-07-21T16:40:00Z',
    priorWorkers: [AGENT_ENDED_JUL],
  },
  {
    id: 'WI-7288',
    title: 'nat P-008 hole-punch fallback',
    kind: 'feature',
    state: 'blocked',
    sourcePlanSlug: 'p2p-nat-traversal-2026-05-28',
    planItem: 'P-008',
    createdAt: '2026-06-01',
    updatedAt: '2026-06-12',
    assignee: null,
    blockedBy: ['p2p-nat-traversal-2026-05-28#P-004'],
    note: 'waiting on the STUN probe service',
  },
  {
    id: 'WI-7289',
    title: 'nat P-009 relay handoff',
    kind: 'feature',
    state: 'blocked',
    sourcePlanSlug: 'p2p-nat-traversal-2026-05-28',
    planItem: 'P-009',
    createdAt: '2026-06-01',
    updatedAt: '2026-06-12',
    assignee: null,
    blockedBy: ['p2p-nat-traversal-2026-05-28#P-004'],
    note: 'waiting on the STUN probe service',
  },
  {
    id: 'WI-7301',
    title: 'Re-validate p2p-transport P-003 handshake retry',
    kind: 'task',
    state: 'open',
    sourcePlanSlug: 'p2p-hardening-2026-08-15',
    planItem: 'P-001',
    createdAt: '2026-08-15',
    updatedAt: '2026-08-29',
    assignee: null,
    priorWorkers: [AGENT_PARKED, AGENT_ENDED_JUL, AGENT_PARKED],
    reopenCount: 2,
    note: 'picked up three times; each time released with "needs the soak env"',
  },
  {
    id: 'WI-7302',
    title: 'Re-verify discovery-v2 P-005 relay fallback',
    kind: 'task',
    state: 'open',
    sourcePlanSlug: 'p2p-hardening-2026-08-15',
    planItem: 'P-003',
    createdAt: '2026-08-16',
    updatedAt: '2026-08-27',
    assignee: null,
    priorWorkers: [AGENT_LIVE, AGENT_PARKED],
  },
  {
    id: 'WI-7311',
    title: 'NAT traversal soak run #4',
    kind: 'task',
    state: 'open',
    sourcePlanSlug: 'p2p-nat-traversal-2026-05-28',
    planItem: 'P-010',
    createdAt: '2026-08-20',
    updatedAt: '2026-08-31',
    assignee: AGENT_LIVE,
    takenAt: '2026-08-30T20:05:00Z',
    lastProgressAt: '2026-08-31T22:10:00Z',
    priorWorkers: [AGENT_PARKED, AGENT_LIVE, AGENT_ENDED_AUG],
    note: 'runs #1-#3 (WI-7190, WI-7241, WI-7276) closed without a recorded verdict',
  },
  {
    id: 'WI-6980',
    title: 'transport P-005 backpressure',
    kind: 'feature',
    state: 'done',
    sourcePlanSlug: 'p2p-transport-2026-04-22',
    planItem: 'P-005',
    createdAt: '2026-05-10',
    updatedAt: '2026-07-14',
    assignee: null,
    priorWorkers: [AGENT_ENDED_JUL, AGENT_PARKED],
    reopenCount: 1,
    completionSummary: 'done 2026-05-30; reopened 2026-07-02 (regression under relay); done again 2026-07-14',
  },
  {
    id: 'WI-7104',
    title: 'p2p program status summary (June)',
    kind: 'task',
    state: 'done',
    sourcePlanSlug: 'p2p-nat-traversal-2026-05-28',
    createdAt: '2026-06-10',
    updatedAt: '2026-06-15',
    assignee: null,
    completionSummary: 'on track; remaining: NAT P-008/P-009',
  },
  {
    id: 'WI-7233',
    title: 'p2p program status summary (August)',
    kind: 'task',
    state: 'done',
    sourcePlanSlug: 'p2p-nat-traversal-2026-05-28',
    createdAt: '2026-07-30',
    updatedAt: '2026-08-03',
    assignee: null,
    completionSummary: 'on track; remaining: NAT P-008/P-009, discovery P-007',
  },
  {
    id: 'WI-7320',
    title: 'Write p2p program status summary (September)',
    kind: 'task',
    state: 'open',
    sourcePlanSlug: 'p2p-hardening-2026-08-15',
    createdAt: '2026-08-28',
    updatedAt: '2026-08-28',
    assignee: null,
    note: 'third such request (see WI-7104, WI-7233)',
  },
];

/** The full-program census the list read always carries, whatever the filter
 *  returned — a bounded row list must never be read as a total (CLAUDE.md:
 *  "a caller's limit bounds ROW LISTS ONLY — never an aggregate"). */
export const AUDIT_WORLD_CENSUS = {
  total: 47,
  byState: { open: 19, blocked: 4, done: 22, dropped: 2 },
  byPlan: {
    'p2p-relay-bootstrap-2026-03-04': 6,
    'p2p-transport-2026-04-22': 9,
    'p2p-discovery-2026-05-15': 7,
    'p2p-discovery-v2-2026-06-30': 9,
    'p2p-nat-traversal-2026-05-28': 11,
    'p2p-observability-2026-07-08': 0,
    'p2p-hardening-2026-08-15': 5,
  },
  truncatedByLimit: true,
  note: 'row list is a representative slice; counts are over the whole program',
} as const;

const TERMINAL_STATES = new Set(['done', 'dropped']);

function filterItems(a: Args): WorldItem[] {
  let rows = [...AUDIT_WORLD_ITEMS];
  const state = a.state;
  if (typeof state === 'string') rows = rows.filter((r) => r.state === state);
  else if (Array.isArray(state)) rows = rows.filter((r) => state.includes(r.state));
  if (a.notTerminal === true) rows = rows.filter((r) => !TERMINAL_STATES.has(r.state));
  if (typeof a.sourcePlanSlug === 'string') rows = rows.filter((r) => r.sourcePlanSlug === a.sourcePlanSlug);
  if (typeof a.assignee === 'string') rows = rows.filter((r) => r.assignee === a.assignee);
  if (typeof a.q === 'string' && a.q.trim()) {
    const q = a.q.toLowerCase();
    rows = rows.filter((r) => r.title.toLowerCase().includes(q) || r.sourcePlanSlug.includes(q) || (r.note ?? '').toLowerCase().includes(q));
  }
  return rows;
}

// --- agents (coord) ----------------------------------------------------------

const PRESENCE = [
  { ownerId: AGENT_ENDED_JUL, sessionState: 'ended', heartbeatFresh: false, lastActiveAt: '2026-07-21T16:40:00Z', intent: 'discovery-v2 P-007 mDNS fallback', claims: ['WI-7150'] },
  { ownerId: AGENT_PARKED, sessionState: 'parked', heartbeatFresh: true, lastActiveAt: '2026-08-30T11:02:00Z', intent: 'p2p hardening re-validation', claims: [] },
  { ownerId: AGENT_LIVE, sessionState: 'live', heartbeatFresh: true, lastActiveAt: '2026-09-01T17:48:00Z', intent: 'NAT traversal soak run #4', claims: ['WI-7311'] },
  { ownerId: AGENT_ENDED_AUG, sessionState: 'ended', heartbeatFresh: false, lastActiveAt: '2026-08-22T03:15:00Z', intent: 'NAT soak run #3', claims: [] },
];

// --- the override ------------------------------------------------------------

const ACTIVE_AUDIT_CONTRACT =
  'AUDIT (overlay, single-shot): read the WHOLE program — full plan lifecycle including ' +
  'shipped/superseded/archived (plans:list includeArchived:true), each ## Now against the ledger, flow and churn markers, ' +
  'holder liveness, mechanisms with citations. Read-only toward the subject. Deliver verdict + ' +
  'report + coverage, then ROUTE remediation. Delivery does not clear the durable mode row: ' +
  "explicitly call mode:set { mode:'audit', enabled:false, reason:'audit report delivered' } " +
  'after the report. If the owner routes remediation while AUDIT is still active, that exit ' +
  'call is your FIRST action. Send it as a standalone tool call, wait for its successful result, ' +
  'and only then mutate in a later response; never batch the exit with subject mutations.';

export const AUDIT_WORLD: ToolDispatchOverride = {
  override(name, rawArgs) {
    const canon = canonical(name);
    const a = argsOf(rawArgs);

    switch (canon) {
      case 'mode:set': {
        const instructions = typeof a.instructions === 'string' ? a.instructions : '';
        return json({
          ok: true,
          mode: a.mode,
          enabled: a.enabled !== false,
          ownerDirected: a.ownerDirected === true,
          axis: 'overlay',
          impliesAutonomy: false,
          instructions,
          instructionsFact: instructions ? 'asserted' : 'none',
          contract: ACTIVE_AUDIT_CONTRACT,
        });
      }

      case 'harness:overview':
      case 'harness:status': {
        const shipped = AUDIT_WORLD_PLANS.filter((p) => p.status === 'shipped').sort((x, y) => (x.shippedAt! < y.shippedAt! ? 1 : -1));
        return json({
          ok: true,
          harness: 'p2p',
          plans: { total: AUDIT_WORLD_PLANS.length, byStatus: planStatusCounts() },
          workItems: AUDIT_WORLD_CENSUS,
          lastShippedPlan: shipped[0] ? { slug: shipped[0].slug, shippedAt: shipped[0].shippedAt } : null,
          daysSinceLastShip: 91,
          now: AUDIT_WORLD_NOW,
        });
      }

      case 'plans:list': {
        if (a.status === 'all') {
          return json({
            ok: false,
            code: 'invalid_args',
            error: "plans:list status has no 'all' member; omit status and pass includeArchived:true",
          }, true);
        }
        const want = requestedStatuses(a);
        const rows = AUDIT_WORLD_PLANS.filter((p) => want === 'all' || want.includes(p.status));
        const omitted = AUDIT_WORLD_PLANS.length - rows.length;
        return json({
          ok: true,
          harness: 'p2p',
          plans: rows.map(planSummary),
          statusCounts: planStatusCounts(),
          ...(omitted > 0
            ? { note: `${omitted} archived plan(s) omitted by default — pass includeArchived:true for the full lifecycle` }
            : {}),
        });
      }

      case 'plans:search': {
        const q = typeof a.query === 'string' ? a.query.toLowerCase() : '';
        const rows = AUDIT_WORLD_PLANS.filter((p) => !q || p.slug.includes(q) || p.title.toLowerCase().includes(q) || q.includes('p2p'));
        return json({ ok: true, harness: 'p2p', plans: rows.map(planSummary) });
      }

      case 'plans:get': {
        const slug = typeof a.slug === 'string' ? a.slug : '';
        const p = AUDIT_WORLD_PLANS.find((x) => x.slug === slug);
        if (!p) return json({ ok: false, error: 'not_found', slug, hint: 'plans:list { includeArchived:true } lists every slug' }, true);
        return json({ ok: true, plan: { ...planSummary(p), now: p.now, items: p.items, decisions: p.decisions } });
      }

      case 'work_items:list': {
        const rows = filterItems(a);
        return json({ ok: true, items: rows, count: rows.length, census: AUDIT_WORLD_CENSUS });
      }

      case 'work_items:get': {
        const ids = Array.isArray(a.ids) ? a.ids : typeof a.id === 'string' ? [a.id] : [];
        const results = ids.map((id) => {
          const row = AUDIT_WORLD_ITEMS.find((r) => r.id === id);
          return row ? { id, ok: true, workItem: row } : { id, ok: false, error: 'not_found' };
        });
        return json({ ok: true, results, counts: { ok: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length } });
      }

      case 'coord:presence':
        return json({
          ok: true,
          agents: PRESENCE,
          note: 'sessionState is the liveness verdict (live | parked | ended); heartbeatFresh is raw keepalive freshness, not "working". A claim held by an ended session is stranded.',
        });

      case 'coord:orient':
        return json({
          ok: true,
          host: { now: AUDIT_WORLD_NOW },
          activeModes: [{ mode: 'audit', axis: 'overlay', contract: ACTIVE_AUDIT_CONTRACT }],
          assignments: [],
          claimable: [{ id: 'WI-7320', title: 'Write p2p program status summary (September)' }],
          inbox: { unread: 0 },
          planEvents: [
            { at: '2026-08-28', plan: 'p2p-hardening-2026-08-15', event: 'draft created; 3 of 5 items re-validate shipped work' },
            { at: '2026-08-01', plan: 'p2p-observability-2026-07-08', event: 'archived; folded into hardening' },
            { at: '2026-07-21', plan: 'p2p-discovery-v2-2026-06-30', event: '## Now updated: P-007 wip' },
            { at: '2026-07-03', plan: 'p2p-nat-traversal-2026-05-28', event: '## Now updated: all remaining items in flight' },
          ],
        });

      case 'search:fulltext':
      case 'search:semantic':
        return json({
          ok: true,
          hits: [
            { kind: 'plan-decision', ref: 'p2p-nat-traversal-2026-05-28#D-003', excerpt: 'P-004 STUN probe service shipped 2026-06-20; P-008 / P-009 may proceed' },
            { kind: 'work-item', ref: 'WI-7233', excerpt: 'on track; remaining: NAT P-008/P-009, discovery P-007' },
            { kind: 'work-item', ref: 'WI-7104', excerpt: 'on track; remaining: NAT P-008/P-009' },
            { kind: 'work-item', ref: 'WI-7311', excerpt: 'runs #1-#3 closed without a recorded verdict' },
          ],
        });

      default:
        return PASS_THROUGH;
    }
  },
};
