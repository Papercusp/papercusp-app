import { useMemo } from 'react';
import { parseAsBoolean, parseAsString, useQueryState, useQueryStates } from 'nuqs';
import {
  ArrowRight,
  ListChecks,
  Users,
  Bell,
  Activity as ActivityIcon,
  ClipboardList,
  HeartPulse,
  GraduationCap,
  Rocket,
  Coins,
  FileText,
} from 'lucide-react';
import { useSyncQuery } from '@papercusp/sync';
import FleetRateControl from './FleetRateControl';
import { isRunningAgent, type RosterAgent } from './AgentsRunningPill';

/** System-origin coord actor (system-watchdog, system-routine, …). MUST match
 *  AdvConversationsTab's exported isSystemConversationActor — inlined here so
 *  the Overview leaf doesn't pull the whole Conversations module in. */
const isSystemActor = (v: string | null | undefined): boolean =>
  /^system(?:$|[-_:/.])/i.test((v ?? '').trim());
import {
  usePlanList,
  usePlanAttention,
  flattenAttentionItems,
  type PlanListRow,
  type AttentionItem,
  type AttentionTier,
  type ItemStatus,
} from '@/app/admin/plans/plans-api';
import { Tooltip } from '@/app/harness/Tooltip';
import { agentDisplayLabel, agentRoleLabel } from '@/app/harness/agent-display';
import { requestDockPanelOpen } from '@/app/adv/harnesses/open-dock-panel';
import { KindPill } from '@/app/harness/primitives';
import { useLexicon } from '@/lib/useLexicon';
import { advRosterArgs } from '@/lib/adv-roster-args';
import { useAdvScope } from './AdvShell';

/**
 * Brief 23 — the Overview / dashboard: the default landing surface of /adv.
 *
 * Composition only (see plan overview-dashboard-2026-06-05, D-003): this owns
 * the tiles + layout; it CONSUMES peers' surfaces:
 *   - top-bar rate/usage/max control  → Brief 20 `<FleetRateControl>` (LIVE —
 *     ./FleetRateControl, rate-limit-layer-v2 P-013).
 *   - NEEDS-YOU tiered inbox           → Brief 21 (we read `needsHuman` off the
 *     attention feed, which Brief 21 is fixing AT THE SOURCE — so this tile
 *     auto-sharpens when their fix lands; no re-derivation here).
 *   - operator strip                   → Brief 24 desktop docked pane (placeholder
 *     strip until their dock lands; P-013).
 *
 * Tiles read GROUND-TRUTH PG state (plans list, attention, roster, activity) —
 * NOT the operator's `<report>` (D-002) — so they're correct even when the
 * operator is idle. Each tile clicks through to its full tab (D-007).
 *
 * Both tiles read via @papercusp/sync (one audited path), replacing the old 8s
 * setInterval over /api/adv/roster + /api/agent-tools/activity/recent
 * (data-sync-push-completion P-006). Both are SSE PUSH-driven:
 *  - Agents → `advRoster.list` (the SAME query + `isRunningAgent` predicate the
 *    header AgentsRunningPill and the sidebar Fleet pane use), so the tile can
 *    never disagree with the "N agents running" pill. WI-5517: this tile
 *    previously re-derived liveness client-side from raw `dev.coordPresence`
 *    heartbeats — `heartbeat_at` reaches the wire as a PG-text timestamp
 *    ("2026-07-19 15:23:28-04"), which WebKit's Date parser rejects (NaN),
 *    so EVERY row derived 'stale' and the tile showed "No live agents" in the
 *    Tauri webview while the header pill (server-derived liveness) was right.
 *    Liveness derivation belongs to the server oracle; never re-derive it
 *    client-side from timestamps.
 *  - Activity → `dev.coordFeed` (the coordination stream, agent-authored rows):
 *    the previous `user_actions` source is a DEAD TABLE (last write 2026-05-11,
 *    workspace_id ''/'default' only) — the fleet's real activity rides the
 *    coord stream (completions, handoffs, escalations, reports), same source
 *    the Conversations Raw-events view reads. Rows deep-link into it.
 */

// ── roster: the subset of an `advRoster.list` active entry the Agents tile
//    renders. Liveness is SERVER-derived on the roster entry (the shared
//    oracle) — never re-derived client-side from timestamps (WI-5517). ──────
export interface OverviewRosterEntry {
  ownerId: string;
  label: string;
  intent: string;
  liveness: 'live' | 'idle' | 'stale' | string;
  currentPlanSlug: string | null;
  role: string | null;
  agent: string | null;
}

// ── activity: the subset of a `dev.coordFeed` row the Activity tile renders.
//    The actor is the coord envelope's `from`; the title is `summary ?? body`. ─
export interface OverviewActivityRow {
  id: string;
  agent: string | null;
  kind: string;
  summary: string | null;
  status: string | null;
}

// ── workItems.stats: one kind × state COUNT cell (owner ask 2026-07-19). The
//    resolver aggregates server-side and stamps `terminal` from the CANONICAL
//    cross-family set (ALL_TERMINAL_STATUSES) — never re-derive open-vs-done
//    client-side from a state list (same never-re-derive rule as liveness). ──
export interface WorkItemStatsCell {
  kind: string;
  state: string;
  n: number;
  terminal: boolean;
}

// ── health.snapshot: the structural subset of SystemHealth the Health tile
//    renders (same subset pattern as OverviewRosterEntry). ───────────────────
export interface OverviewHealthPanel {
  key: string;
  label: string;
  status: 'ok' | 'warn' | 'crit' | 'unknown' | string;
  summary: string;
}
export interface OverviewHealthSnapshot {
  overall: 'ok' | 'warn' | 'crit' | 'unknown' | string;
  panels?: Record<string, OverviewHealthPanel>;
}

// ── learning.releaseReadiness: the subset the Learning tile renders (the
//    Verify-stage GO/NO-GO gate — same read LearningTab's readiness strip
//    holds, so the two can never disagree). ──────────────────────────────────
export interface OverviewReadinessSnapshot {
  report: {
    verdict: string | null;
    passed: number;
    criteria: Array<{ key: string; status: string }>;
  } | null;
  errors?: string[];
}

// ── dev.gitPipeline: the subset of GitPipelineSnapshot the Deploy tile reads
//    (overview-tab-expansion-2026-07-20 P-001). Gate counters arrive ALREADY
//    corrected server-side (pinProvenGateCorrection / verdict-freshness) — never
//    re-derive gate colour client-side from raw counters. ────────────────────
export interface OverviewPipelineSnapshot {
  gitSync: { headSha: string | null; lastSyncedAtMs: number | null };
  gate: {
    consecutiveReds: number;
    stalled: boolean;
    verdictStale: boolean;
    verdictObservedAtMs: number | null;
    lastGreenAtMs: number | null;
    failingTests: string[];
  };
  /** null = the snapshot was computed without the systemd probe (older producer);
   *  { active:false } = probed and idle; { active:true } = a suite run is judging. */
  activeRun: { active: boolean; candidate: string | null; elapsedSec: number | null } | null;
  deploy: {
    stagingHead: { sha: string } | null;
    greenPin: { sha: string } | null;
    deployed: { sha: string } | null;
    deployedAtMs: number | null;
    greenPinBehindStaging: number | null;
    deployedBehindGreenPin: number | null;
  };
}

/** "45s" / "12m" / "3h" / "2d" — compact age for tile tags. Pure. */
export function fmtAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '?';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

const shortSha = (sha: string | null | undefined): string => (sha ? sha.slice(0, 8) : '—');

export interface DeployTileModel {
  verdict: 'green' | 'red' | 'unknown';
  /** One line for the gate row: colour + failing count + verdict age (+ STALLED). */
  gateLine: string;
  /** "judging 06a0eb95 · 14m in" | "idle" | null when the snapshot wasn't probed. */
  runLine: string | null;
  failingCount: number;
  refs: Array<{ key: string; label: string; sha: string; tag: string | null }>;
}

/**
 * Derive the Deploy tile from the pipeline snapshot (P-001). Pure. The three refs
 * answer the owner's standing question "is my change live yet?": staging tip (what
 * agents committed) → green pin (what the gate proved) → :3070 (what actually runs).
 */
export function deriveDeployTile(
  snap: OverviewPipelineSnapshot | undefined,
  nowMs: number,
): DeployTileModel | null {
  if (!snap) return null;
  const g = snap.gate;
  const verdict: DeployTileModel['verdict'] = g.verdictStale
    ? 'unknown'
    : g.consecutiveReds > 0
      ? 'red'
      : g.verdictObservedAtMs != null || g.lastGreenAtMs != null
        ? 'green'
        : 'unknown';
  const verdictAge = g.verdictObservedAtMs != null ? `verdict ${fmtAge(nowMs - g.verdictObservedAtMs)} ago` : null;
  const gateLine =
    verdict === 'red'
      ? `gate RED — ${g.failingTests.length} failing${g.stalled ? ' · STALLED' : ''}${verdictAge ? ` · ${verdictAge}` : ''}`
      : verdict === 'green'
        ? `gate green${verdictAge ? ` · ${verdictAge}` : ''}`
        : 'gate unknown — verdict stale';
  const run = snap.activeRun;
  const runLine =
    run == null
      ? null
      : run.active
        ? `judging ${shortSha(run.candidate)}${run.elapsedSec != null ? ` · ${fmtAge(run.elapsedSec * 1000)} in` : ''}`
        : 'idle';
  const d = snap.deploy;
  const buffer = d.greenPinBehindStaging;
  const gap = d.deployedBehindGreenPin;
  const refs: DeployTileModel['refs'] = [
    {
      key: 'staging',
      label: 'staging',
      sha: shortSha(d.stagingHead?.sha ?? snap.gitSync.headSha),
      tag: buffer != null ? (buffer > 0 ? `+${buffer} unjudged` : 'all green') : null,
    },
    {
      key: 'green',
      label: 'green pin',
      sha: shortSha(d.greenPin?.sha),
      tag: g.lastGreenAtMs != null ? `green ${fmtAge(nowMs - g.lastGreenAtMs)} ago` : null,
    },
    {
      key: 'live',
      label: 'live :3070',
      sha: shortSha(d.deployed?.sha),
      tag:
        gap != null && gap > 0
          ? `${gap} behind green`
          : d.deployedAtMs != null
            ? `deployed ${fmtAge(nowMs - d.deployedAtMs)} ago`
            : gap === 0
              ? 'current'
              : null,
    },
  ];
  return { verdict, gateLine, runLine, failingCount: g.failingTests.length, refs };
}

// ── usage.spend envelope + accounts.pool rows: the Spend tile's two reads
//    (overview-tab-expansion-2026-07-20 P-003). ────────────────────────────────
export interface OverviewSpendEnvelope {
  h1: { spendUsd: number; calls: number };
  h24: { spendUsd: number; calls: number };
}
export interface OverviewAccountRow {
  id: string;
  label?: string;
  provider: string;
  available: boolean;
  usageWalled: boolean;
  edgeThrottled: boolean;
  rate: { pausedUntil: number; utilization?: number; utilization7d?: number };
}

export interface SpendTileModel {
  /** "$1.23 1h · $18.40 24h" */
  headline: string;
  /** Accounts not currently able to serve (walled / paused / edge-throttled). */
  unavailable: number;
  rows: Array<{
    id: string;
    label: string;
    /** 5h-window gateway utilization %, null until observed. */
    utilPct: number | null;
    /** 7d-window %, null until observed (title detail). */
    util7dPct: number | null;
    /** 'walled' | 'edge' | 'paused' | 'ok' — worst-first. */
    state: 'walled' | 'edge' | 'paused' | 'ok';
  }>;
}

/** "$1.23" / "$0.0042" / "$0" — same compact-spend rules as FleetRateControl. */
function fmtUsd(spendUsd: number | undefined): string {
  if (spendUsd === undefined || !Number.isFinite(spendUsd) || spendUsd <= 0) return '$0';
  if (spendUsd < 0.01) return `$${spendUsd.toFixed(4)}`;
  return `$${spendUsd.toFixed(2)}`;
}

/**
 * Derive the Spend tile (P-003): 1h/24h spend headline + per-account gateway
 * utilization, most-burned first (unknown-utilization accounts last). Pure.
 */
export function deriveSpendTile(
  spend: OverviewSpendEnvelope | undefined,
  accounts: readonly OverviewAccountRow[] | undefined,
  nowMs: number,
  limit = TILE_LIMIT - 1,
): SpendTileModel | null {
  if (!spend && (!accounts || accounts.length === 0)) return null;
  const headline = spend ? `${fmtUsd(spend.h1.spendUsd)} 1h · ${fmtUsd(spend.h24.spendUsd)} 24h` : '—';
  const rows = (accounts ?? [])
    .map((a) => {
      const util = a.rate?.utilization;
      const util7d = a.rate?.utilization7d;
      const paused = (a.rate?.pausedUntil ?? 0) > nowMs;
      const state: SpendTileModel['rows'][number]['state'] = a.usageWalled
        ? 'walled'
        : a.edgeThrottled
          ? 'edge'
          : paused
            ? 'paused'
            : 'ok';
      return {
        id: a.id,
        label: a.label || a.id,
        utilPct: typeof util === 'number' && Number.isFinite(util) ? Math.round(util * 100) : null,
        util7dPct: typeof util7d === 'number' && Number.isFinite(util7d) ? Math.round(util7d * 100) : null,
        state,
      };
    })
    .sort((a, b) => (b.utilPct ?? -1) - (a.utilPct ?? -1))
    .slice(0, limit);
  const unavailable = (accounts ?? []).filter((a) => !a.available).length;
  return { headline, unavailable, rows };
}

// ── operatorReports.latest: the newest operator <report> turns (P-004). This is
//    the operator's NARRATIVE account — every other tile reads ground-truth
//    state (D-002); the tile labels the distinction explicitly. ───────────────
export interface OverviewReportRow {
  turnId: string;
  conversationId: string;
  createdAt: number;
  title: string;
  excerpt: string | null;
  planCount: number;
}

// ── one `dev.coordFeed` row (the fields this tile reads). ────────────────────
interface CoordFeedRow {
  ts: string;
  msg_id: string;
  from: string;
  kind: string;
  summary?: string;
  body?: string;
}

const TILE_LIMIT = 6;

/**
 * Tile → AdvShell tab the tile clicks through to (D-007). Exported so the
 * mapping is unit-tested without mounting. Where no dedicated global tab exists
 * yet (agents/activity), we fall back to the nearest surface ('harnesses').
 */
export const OVERVIEW_TILE_TARGETS = {
  plans: 'plans',
  needsYou: 'plans',
  agents: 'harnesses',
  // The Activity tile now reads the coordination stream, whose full surface is
  // Conversations → Raw events — so that's where its "open" goes (WI-5517).
  activity: 'conversations',
  // Owner ask 2026-07-19: work-item stats → the Working tab (WorkItemsPanel);
  // health/learning headline stats → their own tabs.
  workItems: 'harnesses',
  health: 'health',
  learning: 'learning',
  // P-001: the Deploy tile opens the full Git pipeline surface.
  deploy: 'git',
} as const;

/** done / (todo+wip+blocked+needs-human+done) — dropped/unknown excluded. */
export function planProgress(
  counts: PlanListRow['itemCounts'],
): { done: number; total: number; pct: number } {
  if (!counts) return { done: 0, total: 0, pct: 0 };
  const get = (k: ItemStatus | 'unknown') => counts[k] ?? 0;
  const done = get('done');
  const total = get('todo') + get('wip') + get('blocked') + get('needs-human') + done;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return { done, total, pct };
}

/** Non-shipped plans, in-flight first, then most-recently-updated. Pure. */
export function selectActivePlans(rows: readonly PlanListRow[], limit = TILE_LIMIT): PlanListRow[] {
  const rank = (p: PlanListRow) =>
    p.startStatus === 'started' ? 0 : p.status === 'active' ? 1 : p.status === 'ready' ? 2 : 3;
  return rows
    .filter((p) => p.status !== 'shipped' && p.status !== 'superseded' && !p.archived)
    .slice()
    .sort((a, b) => rank(a) - rank(b) || (b.updated ?? '').localeCompare(a.updated ?? ''))
    .slice(0, limit);
}

/**
 * NEEDS-YOU = the Decisions tier (Brief 21's canonical `tier` field,
 * inbox-tiering-and-message-agent D-002/D-006). Runtime fallback to
 * `needsHuman`: until the release-gate deploy carries Brief 21 to the green
 * :3070 host, attention rows arrive WITHOUT `tier` (the type says required;
 * the wire may lag) — needsHuman is the pre-tier equivalent. Pure.
 */
export function selectDecisions(items: readonly AttentionItem[], limit = TILE_LIMIT): AttentionItem[] {
  return items
    .filter((i) => {
      const tier = (i as { tier?: AttentionTier }).tier;
      return tier ? tier === 'decision' : i.needsHuman;
    })
    .slice(0, limit);
}

/** Alerts tier for the top-bar badge (same wire-lag fallback as decisions). Pure. */
export function countAlerts(items: readonly AttentionItem[]): number {
  return items.filter((i) => {
    const tier = (i as { tier?: AttentionTier }).tier;
    return tier
      ? tier === 'alert'
      : !i.needsHuman && (i.kind === 'smoke-fail' || i.kind === 'coord-escalation');
  }).length;
}

/**
 * Top-N roster rows for the Agents tile. Membership ("who is running") is
 * decided ONCE upstream by the pill's shared `isRunningAgent` predicate
 * (present OR loop-armed) — this selector must NOT re-filter by liveness,
 * or the rows would drop loop-armed stale agents the count includes. Pure.
 */
export function selectAgentRows(
  roster: readonly OverviewRosterEntry[],
  limit = TILE_LIMIT,
): OverviewRosterEntry[] {
  return roster.slice(0, limit);
}

// ── workItems.delta24h: one per-kind 24h burn-down row (opened = created in the
//    window, closed = went terminal in the window — derived server-side, P-002). ─
export interface WorkItemDeltaCell {
  kind: string;
  opened: number;
  closed: number;
}

export interface WorkItemStatsSummary {
  total: number;
  open: number;
  /** 24h burn-down totals across ALL kinds (not just the rendered top-N). */
  opened24h: number;
  closed24h: number;
  /** Per-kind rollup ("bugs vs the rest"), open-count desc then total desc. */
  kinds: Array<{ kind: string; open: number; total: number; opened24h: number; closed24h: number }>;
}

/**
 * Roll the server's kind × state cells up to totals + a per-kind breakdown
 * (owner ask 2026-07-19: "how many items, how many are bugs vs other"), merging
 * the 24h burn-down deltas in (P-002: +opened/−closed per kind + headline).
 * `open` = non-terminal per the resolver's canonical `terminal` stamp. Pure.
 */
export function summarizeWorkItemStats(
  cells: readonly WorkItemStatsCell[],
  deltas: readonly WorkItemDeltaCell[] = [],
): WorkItemStatsSummary {
  const byKind = new Map<string, { open: number; total: number; opened24h: number; closed24h: number }>();
  const ensure = (kind: string) => {
    const k = byKind.get(kind) ?? { open: 0, total: 0, opened24h: 0, closed24h: 0 };
    byKind.set(kind, k);
    return k;
  };
  let total = 0;
  let open = 0;
  for (const c of cells) {
    const k = ensure(c.kind);
    k.total += c.n;
    total += c.n;
    if (!c.terminal) {
      k.open += c.n;
      open += c.n;
    }
  }
  let opened24h = 0;
  let closed24h = 0;
  for (const d of deltas) {
    const k = ensure(d.kind);
    k.opened24h += d.opened;
    k.closed24h += d.closed;
    opened24h += d.opened;
    closed24h += d.closed;
  }
  const kinds = [...byKind.entries()]
    .map(([kind, v]) => ({ kind, ...v }))
    .sort((a, b) => b.open - a.open || b.total - a.total)
    .slice(0, TILE_LIMIT);
  return { total, open, opened24h, closed24h, kinds };
}

/** warn/crit health panels, crit first (stable within a tier), top-N. Pure. */
export function selectUnhealthyPanels(
  snap: OverviewHealthSnapshot | undefined,
  limit = TILE_LIMIT,
): OverviewHealthPanel[] {
  if (!snap?.panels) return [];
  const rank = (s: string) => (s === 'crit' ? 0 : s === 'warn' ? 1 : 2);
  return Object.values(snap.panels)
    .filter((p) => p.status === 'crit' || p.status === 'warn')
    .sort((a, b) => rank(a.status) - rank(b.status))
    .slice(0, limit);
}

export default function AdvOverviewTab() {
  const potScope = useAdvScope();
  const lex = useLexicon();
  // Writers only (parseAsString) — AdvShell owns the canonical enum parser, so
  // writing a plain string round-trips identically. Mirrors AdvNowRunning.
  const [, setActiveTab] = useQueryState('tab', parseAsString);
  // Deep-link the inbox tier bar (Brief 21, ?inboxTier=) when a tile targets
  // the inbox. SEQUENTIAL awaits — the custom nuqs adapter merges each write
  // over the live search, so same-tick writes collide (see AdvShell).
  const [, setInboxTier] = useQueryState('inboxTier', parseAsString);
  const openInbox = async (tier: AttentionTier) => {
    await setActiveTab(OVERVIEW_TILE_TARGETS.needsYou);
    await setInboxTier(tier);
  };

  // Row click-throughs (WI-5517, owner ask 2026-07-19): a plan row opens THAT
  // plan in the Plans tab (?plan=, PlansClient's selection param); an agent row
  // opens the header Agents-running dropdown focused on that agent's session
  // history (?agentsRoster + ?agentsFocus, AgentsRunningPill); an activity row
  // opens the coordination event in Conversations → Raw events (?conv=feed).
  const [, setPlanSlug] = useQueryState('plan', parseAsString);
  const [, setAgentsRosterOpen] = useQueryState('agentsRoster', parseAsBoolean);
  const [, setAgentsFocus] = useQueryState('agentsFocus', parseAsString);
  const [, setFeedParams] = useQueryStates({
    conv: parseAsString,
    fmsg: parseAsString,
    fsys: parseAsString,
  });
  // Spend tile → the LeftSidebar Accounts tab (P-003). ONE useQueryStates batch:
  // lsb (rail open) + lst (rail tab) written same-tick race through the custom
  // nuqs adapter if issued as two hooks (see LeftSidebar's own setRail note).
  const [, setRailParams] = useQueryStates({ lsb: parseAsBoolean, lst: parseAsString });
  const openAccounts = async () => {
    await setRailParams({ lsb: true, lst: 'accounts' });
  };
  const openPlan = async (slug: string) => {
    await setActiveTab(OVERVIEW_TILE_TARGETS.plans);
    await setPlanSlug(slug);
  };
  const openAgent = async (ownerId: string) => {
    await setAgentsRosterOpen(true);
    await setAgentsFocus(ownerId);
  };
  const openActivity = async (msgId: string) => {
    await setActiveTab('conversations');
    await setFeedParams({ conv: 'feed', fmsg: msgId, fsys: 'all' });
  };

  const plansQ = usePlanList({ includeArchived: false, includeLegacy: false });
  const attentionQ = usePlanAttention();

  // Roster (live fleet) — the SAME `advRoster.list` subscription the header
  // AgentsRunningPill holds (identical args ⇒ one shared cache entry), with
  // liveness derived SERVER-side. See the file header for why this must never
  // go back to client-side heartbeat parsing (WI-5517: PG-text timestamps are
  // NaN under WebKit ⇒ every agent read 'stale' ⇒ "No live agents").
  const rosterQ = useSyncQuery<{ active: RosterAgent[] }>({
    queryName: 'advRoster.list',
    args: advRosterArgs(null),
    staleTime: 8_000,
  });

  // Activity — the coordination stream (fleet-wide; agent-authored rows only,
  // system telemetry filtered out client-side like the curated Conversations
  // views). Over-fetch, then filter + slice: system-origin rows dominate the
  // raw feed, so a bare limit-10 read could filter down to nothing.
  const activityQ = useSyncQuery<CoordFeedRow>({
    queryName: 'dev.coordFeed',
    // system_only EXPLICITLY false: the tile wants the whole stream so the
    // client-side actor filter below decides — never the server's default.
    args: { system_only: false, limit: 80 },
    staleTime: 8_000,
  });

  // Work-item stats (owner ask 2026-07-19): the tiny kind × state aggregate —
  // NEVER the enriched workItems.byHarness list (payload discipline,
  // whole-app-sync-payload-audit-2026-07-19). Scoped to the focused project
  // (?slug=) when one is selected; workspace-wide otherwise.
  const workItemScopeArgs = potScope.harnessSlugs === null
    ? {}
    : { harnessSlugs: [...potScope.harnessSlugs] };
  const statsQ = useSyncQuery<WorkItemStatsCell>({
    queryName: 'workItems.stats',
    args: workItemScopeArgs,
    enabled: potScope.ready,
    staleTime: 15_000,
  });
  // P-002: the 24h burn-down companion (same scoping + invalidation bridge).
  const deltaQ = useSyncQuery<WorkItemDeltaCell>({
    queryName: 'workItems.delta24h',
    args: workItemScopeArgs,
    enabled: potScope.ready,
    staleTime: 15_000,
  });

  // Health + Learning headline stats (owner ask 2026-07-19): the SAME queries
  // their tabs hold (health.snapshot / learning.releaseReadiness — identical
  // args ⇒ shared cache entries), so a tile can never disagree with its tab.
  const healthQ = useSyncQuery<OverviewHealthSnapshot>({
    queryName: 'health.snapshot',
    args: {},
    staleTime: 15_000,
  });
  const readinessQ = useSyncQuery<OverviewReadinessSnapshot>({
    queryName: 'learning.releaseReadiness',
    staleTime: 30_000,
  });
  // Deploy pipeline (P-001): the SAME precomputed dev.gitPipeline snapshot the
  // /admin Git panel reads (1-element array; 90s producer TTL) — a plain snapshot
  // SELECT, no git spawns on this read path (whole-app-sync-payload-audit P-007).
  const pipelineQ = useSyncQuery<OverviewPipelineSnapshot>({
    queryName: 'dev.gitPipeline',
    args: {},
    staleTime: 15_000,
  });
  // Operator report (P-004): the newest <report> turns — the operator's
  // NARRATIVE, a thin projection over the report-cards substrate (48h window).
  const reportsQ = useSyncQuery<OverviewReportRow>({
    queryName: 'operatorReports.latest',
    staleTime: 30_000,
  });
  // Spend (P-003): the 1h/24h spend envelope + the SAME accounts.pool read the
  // sidebar Accounts tab holds (identical args ⇒ shared cache entry).
  const spendQ = useSyncQuery<OverviewSpendEnvelope>({
    queryName: 'usage.spend',
    args: {},
    staleTime: 30_000,
  });
  // No `args` key — matches the sidebar AccountsTab's own subscription so the two
  // share one cache entry. (For the record: an explicit `args:{}` would share it
  // TOO — createUsePollingQuery defaults `args = {}`, so both forms key
  // ['sync','accounts.pool',{}]. This comment previously claimed `{}` would key a
  // SECOND entry, which is false and cost a WI-6796 misdiagnosis: it implies a
  // no-args subscriber is keyed on `undefined` and therefore unreachable by the
  // `notifySyncInvalidate(name, {})` that 30+ callsites emit. It is reachable.
  // The real invalidation gotcha is a NON-EMPTY mismatched args — see
  // /internal/docs/agent-insights/adding-a-sync-query.)
  const accountsQ = useSyncQuery<OverviewAccountRow>({
    queryName: 'accounts.pool',
    staleTime: 30_000,
  });

  // ── derive tile data (pure helpers, exported + unit-tested) ────────────
  const plans = useMemo(() => selectActivePlans(plansQ.data?.plans ?? []), [plansQ.data]);
  // Dedupe by id via the shared helper (WI-5337 / EI-19373923898562595): a
  // non-plan-scoped attention item (owner-wall, loop-carry-note) appears in
  // MULTIPLE plan groups server-side, so a bare `groups.flatMap(g => g.items)`
  // emitted it once per group — duplicate React keys on the `decisions` row
  // below (reproduced live: 6 "two children with the same key" console
  // errors on ?tab=overview). See flattenAttentionItems' own doc.
  const attentionItems = useMemo(
    () => flattenAttentionItems(attentionQ.data?.groups ?? []),
    [attentionQ.data],
  );
  const decisions = useMemo(() => selectDecisions(attentionItems), [attentionItems]);
  const alertCount = useMemo(() => countAlerts(attentionItems), [attentionItems]);

  // Map roster entries → OverviewRosterEntry through the SAME membership
  // predicate the header pill uses (isRunningAgent: present OR loop-armed), so
  // the tile's count and the pill's "N agents running" can never disagree.
  const roster = useMemo<OverviewRosterEntry[]>(
    () =>
      ((rosterQ.data?.[0]?.active ?? []) as RosterAgent[]).filter(isRunningAgent).map((a) => ({
        ownerId: a.ownerId,
        label: a.label,
        intent: a.intent,
        liveness: a.liveness,
        currentPlanSlug: a.currentPlanSlug,
        role: a.role,
        agent: a.agent,
      })),
    [rosterQ.data],
  );
  const agentRows = useMemo(() => selectAgentRows(roster), [roster]);
  const workItemStats = useMemo(
    () => summarizeWorkItemStats(statsQ.data ?? [], deltaQ.data ?? []),
    [statsQ.data, deltaQ.data],
  );
  const deployTile = useMemo(
    () => deriveDeployTile(pipelineQ.data?.[0], Date.now()),
    [pipelineQ.data],
  );
  const spendTile = useMemo(
    () => deriveSpendTile(spendQ.data?.[0], accountsQ.data, Date.now()),
    [spendQ.data, accountsQ.data],
  );
  const health = healthQ.data?.[0];
  const unhealthy = useMemo(() => selectUnhealthyPanels(health), [health]);
  const readiness = readinessQ.data?.[0];

  // Map coord-feed rows → the Activity tile's render shape: agent-authored rows
  // only (system telemetry belongs to Conversations → Raw events), actor =
  // envelope `from`, title = `summary ?? body ?? kind`. Newest-first already.
  const recentActivity = useMemo<OverviewActivityRow[]>(
    () =>
      (activityQ.data ?? [])
        .filter((r) => !isSystemActor(r.from))
        .slice(0, 10)
        .map((r) => ({
          id: r.msg_id,
          agent: r.from,
          kind: r.kind,
          summary: r.summary ?? r.body ?? null,
          status: null,
        })),
    [activityQ.data],
  );

  return (
    <div className="pc-overview">
      {/* ── Top bar: Brief 20 FleetRateControl (live) + alerts ─────────── */}
      <div className="pc-overview__topbar">
        <FleetRateControl />
        <div className="pc-overview__topbar-spacer" />
        <Tooltip label="Alerts — smoke failures + escalations">
          <button
            type="button"
            className="pc-overview__alerts"
            data-has-alerts={alertCount > 0}
            aria-label="Open alerts"
            onClick={() => void openInbox('alert')}
          >
            <Bell size={13} aria-hidden />
            <span>{alertCount}</span>
          </button>
        </Tooltip>
      </div>

      {/* ── 2×2 tiles ──────────────────────────────────────────────────── */}
      <div className="pc-overview__grid">
        <OverviewTile
          icon={<ListChecks size={14} aria-hidden />}
          title="Plans"
          count={plansQ.data?.plans?.filter((p) => p.status === 'active' || p.startStatus === 'started').length}
          loading={plansQ.loading && !plansQ.data}
          error={plansQ.error}
          empty={plans.length === 0}
          emptyLabel="No active plans"
          onOpen={() => void setActiveTab(OVERVIEW_TILE_TARGETS.plans)}
        >
          {plans.map((p) => {
            const { done, total, pct } = planProgress(p.itemCounts);
            return (
              <button
                key={p.slug}
                type="button"
                className="pc-overview__rowbtn"
                aria-label={`Open plan ${p.title ?? p.slug}`}
                onClick={() => void openPlan(p.slug)}
              >
                {/* Flex layout lives on an INNER span, never on the <button>
                    itself: WebKitGTK (the Tauri webview) renders button
                    contents through an anonymous box that IGNORES flex on the
                    button element — children overflowed and the progress bar
                    collapsed to 0×0 (owner report 2026-07-19). Chromium
                    resolves it; WebKit doesn't. */}
                <span className="pc-overview__plan">
                  <span className="pc-overview__plan-head">
                    <span className="pc-overview__plan-title" title={p.title ?? p.slug}>
                      {p.title ?? p.slug}
                    </span>
                    <span className="pc-overview__plan-frac">
                      {done}/{total}
                    </span>
                  </span>
                  <span className="pc-overview__bar" aria-hidden>
                    <span className="pc-overview__bar-fill" style={{ width: `${pct}%` }} />
                  </span>
                </span>
              </button>
            );
          })}
        </OverviewTile>

        <OverviewTile
          icon={<Bell size={14} aria-hidden />}
          title="Needs you"
          count={decisions.length}
          accent="var(--warn)"
          loading={attentionQ.loading && !attentionQ.data}
          error={attentionQ.error}
          empty={decisions.length === 0}
          emptyLabel="Nothing needs you right now"
          onOpen={() => void openInbox('decision')}
        >
          {decisions.map((d) => (
            <div key={d.id} className="pc-overview__row">
              <span className="pc-overview__row-dot" data-imp={d.importance} aria-hidden />
              <span className="pc-overview__row-title" title={d.body || d.title}>
                {d.title}
              </span>
              {d.harnessSlug && <span className="pc-overview__row-tag">{d.harnessSlug}</span>}
            </div>
          ))}
        </OverviewTile>

        <OverviewTile
          icon={<Users size={14} aria-hidden />}
          title="Agents"
          count={roster.length}
          accent="var(--accent-strong)"
          loading={rosterQ.loading && !rosterQ.data}
          error={rosterQ.error ? String((rosterQ.error as Error).message ?? rosterQ.error) : null}
          empty={agentRows.length === 0}
          emptyLabel="No live agents"
          onOpen={() => {
            // Owner ask 2026-07-19: the Working tab may not have the agents
            // panel in its persisted layout — request it (ensure + focus)
            // alongside the tab switch, else the click lands on nothing.
            requestDockPanelOpen('adv:agents');
            void setActiveTab(OVERVIEW_TILE_TARGETS.agents);
          }}
        >
          {agentRows.map((a) => {
            const label = agentDisplayLabel(a.label, lex);
            return (
              <button
                key={a.ownerId}
                type="button"
                className="pc-overview__rowbtn"
                aria-label={`Open ${label}'s session history`}
                onClick={() => void openAgent(a.ownerId)}
              >
                {/* Inner span carries the row flex — WebKitGTK ignores flex on
                    <button> (see the plans rows above). */}
                <span className="pc-overview__row">
                  <span className="pc-overview__row-dot" data-live={a.liveness} aria-hidden />
                  {/* title on the SPAN, not the button — the design-primitives lint
                      blocks native title= on buttons (Tooltip or span-title only). */}
                  <span className="pc-overview__row-title" title={a.intent || label}>
                    {a.intent || label}
                  </span>
                  {a.role && <span className="pc-overview__row-tag">{agentRoleLabel(a.role, lex)}</span>}
                </span>
              </button>
            );
          })}
        </OverviewTile>

        <OverviewTile
          icon={<ActivityIcon size={14} aria-hidden />}
          title="Activity"
          accent="var(--good)"
          loading={activityQ.loading && !activityQ.data}
          error={activityQ.error ? String((activityQ.error as Error).message ?? activityQ.error) : null}
          empty={recentActivity.length === 0}
          emptyLabel="No recent agent activity"
          onOpen={() => void setActiveTab(OVERVIEW_TILE_TARGETS.activity)}
        >
          {recentActivity.map((r) => (
            <button
              key={r.id}
              type="button"
              className="pc-overview__rowbtn"
              aria-label="Open this event in Conversations"
              onClick={() => void openActivity(r.id)}
            >
              {/* Inner span carries the row flex — WebKitGTK ignores flex on
                  <button> (see the plans rows above). */}
              <span className="pc-overview__row">
                <span className="pc-overview__row-actor">{r.agent ?? '—'}</span>
                <span className="pc-overview__row-title" title={r.summary ?? r.kind}>
                  {r.summary ?? r.kind}
                </span>
              </span>
            </button>
          ))}
        </OverviewTile>

        {/* Work-item stats (owner ask 2026-07-19): totals + bugs-vs-the-rest.
            Headline count = OPEN (non-terminal) items; each row is one kind. */}
        <OverviewTile
          icon={<ClipboardList size={14} aria-hidden />}
          title="Work items"
          count={workItemStats.open}
          accent="var(--warn)"
          loading={statsQ.loading && !statsQ.data}
          error={statsQ.error ? String((statsQ.error as Error).message ?? statsQ.error) : null}
          empty={workItemStats.total === 0}
          emptyLabel="No work items"
          onOpen={() => void setActiveTab(OVERVIEW_TILE_TARGETS.workItems)}
        >
          {/* P-002: the 24h burn-down headline — one row, only when it moved. */}
          {(workItemStats.opened24h > 0 || workItemStats.closed24h > 0) && (
            <div className="pc-overview__row">
              <span className="pc-overview__row-actor">24h</span>
              <span
                className="pc-overview__row-title"
                title="Work items opened vs driven terminal in the last 24 hours (all kinds)"
              >
                +{workItemStats.opened24h} opened · −{workItemStats.closed24h} closed
              </span>
            </div>
          )}
          {workItemStats.kinds.map((k) => (
            <div key={k.kind} className="pc-overview__row">
              {/* Owner ask 2026-07-19: the canonical per-kind icon chip
                  (KindPill / KIND_ICON) instead of a bare kind name — one
                  visual language with the Work items table. */}
              <span className="pc-overview__row-title">
                <KindPill kind={k.kind} size="xs" />
              </span>
              <span className="pc-overview__row-tag">
                {k.open} open · {k.total} all
                {k.opened24h > 0 || k.closed24h > 0 ? ` · +${k.opened24h}/−${k.closed24h}` : ''}
              </span>
            </div>
          ))}
        </OverviewTile>

        {/* Spend (P-003): 1h/24h LLM spend + per-account gateway utilization,
            most-burned first. Opens the sidebar Accounts tab. */}
        <OverviewTile
          icon={<Coins size={14} aria-hidden />}
          title="Spend"
          count={spendTile && spendTile.unavailable > 0 ? spendTile.unavailable : undefined}
          accent="var(--warn)"
          loading={(spendQ.loading && !spendQ.data) || (accountsQ.loading && !accountsQ.data)}
          error={
            spendQ.error
              ? String((spendQ.error as Error).message ?? spendQ.error)
              : accountsQ.error
                ? String((accountsQ.error as Error).message ?? accountsQ.error)
                : null
          }
          empty={!spendTile}
          emptyLabel="No usage telemetry yet"
          onOpen={() => void openAccounts()}
        >
          {spendTile && (
            <>
              <div className="pc-overview__row">
                <span className="pc-overview__row-actor">spend</span>
                <span
                  className="pc-overview__row-title"
                  title="LLM spend over the last 1h / 24h (usage telemetry, all accounts; provider-reported cost where available)"
                >
                  {spendTile.headline}
                </span>
              </div>
              {spendTile.rows.map((a) => (
                <div key={a.id} className="pc-overview__row">
                  <span className="pc-overview__row-dot" data-acct={a.state} aria-hidden />
                  <span
                    className="pc-overview__row-title"
                    title={`${a.label} — 5h window ${a.utilPct ?? '?'}%${a.util7dPct != null ? ` · 7d ${a.util7dPct}%` : ''}${a.state !== 'ok' ? ` · ${a.state}` : ''}`}
                  >
                    {a.label}
                  </span>
                  <span className="pc-overview__row-tag">
                    {a.utilPct != null ? `${a.utilPct}%` : '—'}
                    {a.state !== 'ok' ? ` · ${a.state}` : ''}
                  </span>
                </div>
              ))}
            </>
          )}
        </OverviewTile>

        {/* Deploy pipeline (P-001): staging tip → green pin → live :3070, the
            gate verdict (+ judging/idle from the producer's systemd probe), and
            the deploy gap — the owner's "is my change live yet?" at a glance. */}
        <OverviewTile
          icon={<Rocket size={14} aria-hidden />}
          title="Deploy"
          count={deployTile?.failingCount || undefined}
          accent={deployTile?.verdict === 'red' ? 'var(--bad)' : deployTile?.verdict === 'green' ? 'var(--good)' : 'var(--fg-mute)'}
          loading={pipelineQ.loading && !pipelineQ.data}
          error={pipelineQ.error ? String((pipelineQ.error as Error).message ?? pipelineQ.error) : null}
          empty={!deployTile}
          emptyLabel="No pipeline snapshot yet"
          onOpen={() => void setActiveTab(OVERVIEW_TILE_TARGETS.deploy)}
        >
          {deployTile && (
            <>
              <div className="pc-overview__row">
                <span
                  className="pc-overview__row-dot"
                  data-bar={deployTile.verdict === 'green' ? 'pass' : deployTile.verdict === 'red' ? 'fail' : undefined}
                  aria-hidden
                />
                <span className="pc-overview__row-title" title={deployTile.gateLine}>
                  {deployTile.gateLine}
                </span>
                {deployTile.runLine && <span className="pc-overview__row-tag">{deployTile.runLine}</span>}
              </div>
              {deployTile.refs.map((r) => (
                <div key={r.key} className="pc-overview__row">
                  <span className="pc-overview__row-actor pc-overview__row-actor--wide">{r.label}</span>
                  <span className="pc-overview__row-title" title={`${r.label} ${r.sha}`}>
                    {r.sha}
                  </span>
                  {r.tag && <span className="pc-overview__row-tag">{r.tag}</span>}
                </div>
              ))}
            </>
          )}
        </OverviewTile>

        {/* Operator report (P-004): the newest <report> — EXPLICITLY the
            operator's narrative account, unlike the ground-truth tiles (D-002).
            Opens the inbox where report cards live. */}
        <OverviewTile
          icon={<FileText size={14} aria-hidden />}
          title="Operator report"
          accent="var(--accent-cool)"
          loading={reportsQ.loading && !reportsQ.data}
          error={reportsQ.error ? String((reportsQ.error as Error).message ?? reportsQ.error) : null}
          empty={!reportsQ.data || reportsQ.data.length === 0}
          emptyLabel="No operator report in the last 48h"
          onOpen={() => void openInbox('activity')}
        >
          {(reportsQ.data ?? []).map((r, i) => (
            <div key={r.turnId} className="pc-overview__row">
              <span className="pc-overview__row-title" title={r.excerpt ?? r.title}>
                {r.title}
                {i === 0 && r.excerpt ? ` — ${r.excerpt}` : ''}
              </span>
              {i === 0 && (
                <span
                  className="pc-overview__row-tag"
                  title="The operator's own written status report — a narrative account; the other tiles read ground-truth state directly"
                >
                  narrative
                </span>
              )}
              <span className="pc-overview__row-tag">{fmtAge(Date.now() - r.createdAt)} ago</span>
            </div>
          ))}
        </OverviewTile>

        {/* Health headline (owner ask 2026-07-19): overall verdict + the
            warn/crit panels only — healthy systems stay out of the way. */}
        <OverviewTile
          icon={<HeartPulse size={14} aria-hidden />}
          title="Health"
          count={unhealthy.length}
          accent="var(--bad)"
          loading={healthQ.loading && !healthQ.data}
          error={healthQ.error ? String((healthQ.error as Error).message ?? healthQ.error) : null}
          empty={unhealthy.length === 0}
          emptyLabel={health ? (health.overall === 'ok' ? 'All systems healthy' : `Overall: ${health.overall}`) : 'No health snapshot yet'}
          onOpen={() => void setActiveTab(OVERVIEW_TILE_TARGETS.health)}
        >
          {unhealthy.map((p) => (
            <div key={p.key} className="pc-overview__row">
              <span className="pc-overview__row-dot" data-health={p.status} aria-hidden />
              <span className="pc-overview__row-title" title={p.summary}>
                {p.label} — {p.summary}
              </span>
            </div>
          ))}
        </OverviewTile>

        {/* Learning headline (owner ask 2026-07-19): the release-readiness
            GO/NO-GO verdict + its bars — the same learning.releaseReadiness
            read LearningTab's strip renders. */}
        <OverviewTile
          icon={<GraduationCap size={14} aria-hidden />}
          title="Learning"
          accent="var(--good)"
          loading={readinessQ.loading && !readinessQ.data}
          error={readinessQ.error ? String((readinessQ.error as Error).message ?? readinessQ.error) : null}
          empty={!readiness?.report}
          emptyLabel="No release-readiness report yet"
          onOpen={() => void setActiveTab(OVERVIEW_TILE_TARGETS.learning)}
        >
          {readiness?.report && (
            <>
              <div className="pc-overview__row">
                <span className="pc-overview__row-title">release gate: {readiness.report.verdict ?? 'unreadable'}</span>
                <span className="pc-overview__row-tag">
                  {readiness.report.passed}/{readiness.report.criteria.length} bars
                </span>
              </div>
              {readiness.report.criteria.slice(0, TILE_LIMIT - 1).map((c) => (
                <div key={c.key} className="pc-overview__row">
                  <span className="pc-overview__row-dot" data-bar={c.status} aria-hidden />
                  <span className="pc-overview__row-title">{c.key}</span>
                  <span className="pc-overview__row-tag">{c.status}</span>
                </div>
              ))}
            </>
          )}
        </OverviewTile>
      </div>

      {/* No in-tab operator strip on desktop: ChromeShell already mounts the
          persistent OperatorChatSidebar on every non-chromeless route incl.
          /adv (Brief 24, operator-always-visible-2026-06-05) — a second
          operator surface here would duplicate it. The TUI Overview DOES
          render a bottom strip (draw_operator_dock) because the TUI has no
          shell-level sidebar. See overview-dashboard-2026-06-05 D-008. */}

      <style>{`
        .pc-overview {
          display: flex;
          flex-direction: column;
          gap: 12px;
          min-height: 0;
          flex: 1;
          padding: 14px 16px 16px;
        }
        /* Top bar */
        .pc-overview__topbar {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 10px 12px;
          border: 1px solid var(--border, rgba(125, 211, 252, 0.16));
          border-radius: 12px;
          background: var(--bg-2, rgba(255, 255, 255, 0.04));
        }
        .pc-overview__topbar-spacer { flex: 1; }
        .pc-overview__alerts {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 5px 10px;
          font-size: 12px;
          font-weight: 700;
          border-radius: 8px;
          border: 1px solid var(--border, rgba(125, 211, 252, 0.2));
          background: var(--bg-2, rgba(255, 255, 255, 0.04));
          color: var(--fg-mute, #7f9bb4);
          cursor: pointer;
        }
        .pc-overview__alerts[data-has-alerts='true'] {
          color: var(--bad, #f87171);
          border-color: color-mix(in srgb, var(--bad, #f87171), transparent 60%);
          background: var(--bad-bg, rgba(248, 113, 113, 0.10));
        }
        /* Tiles grid */
        .pc-overview__grid {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          grid-auto-rows: minmax(0, 1fr);
          gap: 12px;
          flex: 1;
          min-height: 0;
        }
        @container (max-width: 720px) { .pc-overview__grid { grid-template-columns: 1fr; } }
        .pc-overview__tile {
          display: flex;
          flex-direction: column;
          min-height: 0;
          border: 1px solid var(--tile-accent, rgba(125, 211, 252, 0.18));
          border-radius: 14px;
          background:
            radial-gradient(circle at top left, color-mix(in oklab, var(--tile-accent, #38bdf8), transparent 90%), transparent 42%),
            var(--bg-2, rgba(255, 255, 255, 0.035));
          overflow: hidden;
        }
        .pc-overview__tile-head {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 10px 12px;
          border-bottom: 1px solid var(--border, rgba(125, 211, 252, 0.12));
          color: var(--fg, #e7f7ff);
        }
        .pc-overview__tile-head svg { color: var(--tile-accent, #7dd3fc); }
        .pc-overview__tile-title { font-size: 12px; font-weight: 760; letter-spacing: 0; text-transform: uppercase; }
        .pc-overview__tile-count {
          font-size: 11px;
          font-weight: 700;
          color: var(--fg, #e7f7ff);
          background: color-mix(in srgb, var(--tile-accent, #7dd3fc) 18%, var(--bg-popover, #0d1829));
          border: 1px solid color-mix(in srgb, var(--tile-accent, #7dd3fc), transparent 48%);
          border-radius: 999px;
          padding: 1px 7px;
          min-width: 18px;
          text-align: center;
        }
        .pc-overview__tile-open {
          margin-left: auto;
          display: inline-flex;
          align-items: center;
          gap: 3px;
          font-size: 10px;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0;
          color: var(--fg-mute, #7f9bb4);
          background: transparent;
          border: none;
          cursor: pointer;
        }
        .pc-overview__tile-open:hover { color: var(--fg, #e7f7ff); }
        .pc-overview__tile-body {
          flex: 1;
          min-height: 0;
          overflow-y: auto;
          padding: 8px 12px 10px;
          display: flex;
          flex-direction: column;
          gap: 7px;
        }
        .pc-overview__tile-state { font-size: 11.5px; color: var(--fg-mute, #7f9bb4); padding: 6px 0; }
        .pc-overview__tile-state[data-error='true'] { color: var(--bad, #f87171); }
        /* Plan rows */
        /* Flex on INNER spans only — WebKitGTK ignores flex on <button>. */
        .pc-overview__plan { display: flex; flex-direction: column; gap: 4px; width: 100%; min-width: 0; }
        .pc-overview__plan-head { display: flex; align-items: baseline; gap: 8px; }
        .pc-overview__plan-title {
          flex: 1; min-width: 0;
          font-size: 12px; font-weight: 600; color: var(--fg, #e7f7ff);
          text-align: left;
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        .pc-overview__plan-frac { font-size: 10.5px; color: var(--fg-mute, #7f9bb4); font-variant-numeric: tabular-nums; }
        .pc-overview__bar { display: block; height: 5px; border-radius: 999px; background: var(--bg-4, rgba(255, 255, 255, 0.11)); overflow: hidden; }
        .pc-overview__bar-fill {
          display: block;
          height: 100%;
          border-radius: 999px;
          background: linear-gradient(90deg, var(--accent, #38bdf8), var(--good, #34d399));
          transition: width 240ms ease;
        }
        /* Generic list rows (needs-you / agents / activity) */
        .pc-overview__row { display: flex; align-items: center; gap: 7px; min-width: 0; width: 100%; }
        /* Clickable rows (plans / agents / activity deep-links) — a quiet
           button reset that keeps the row layout, plus a soft hover. */
        .pc-overview__rowbtn {
          display: block;
          border: none;
          background: transparent;
          font: inherit;
          color: inherit;
          text-align: left;
          width: 100%;
          margin: 0 -6px;
          padding: 3px 6px;
          border-radius: 7px;
          cursor: pointer;
          transition: background-color 120ms ease;
        }
        .pc-overview__rowbtn:hover { background: var(--bg-3, rgba(255, 255, 255, 0.07)); }
        .pc-overview__rowbtn:focus-visible {
          outline: 1px solid var(--tile-accent, #7dd3fc);
          outline-offset: -1px;
        }
        .pc-overview__row-dot {
          width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; background: var(--fg-mute, #7f9bb4);
        }
        .pc-overview__row-dot[data-live='live'] { background: var(--good, #34d399); box-shadow: 0 0 6px color-mix(in srgb, var(--good, #34d399), transparent 50%); }
        .pc-overview__row-dot[data-live='idle'] { background: var(--warn, #fbbf24); }
        .pc-overview__row-dot[data-imp='urgent'] { background: var(--bad, #f87171); }
        .pc-overview__row-dot[data-imp='high'] { background: var(--warn, #fbbf24); }
        .pc-overview__row-dot[data-health='crit'] { background: var(--bad, #f87171); box-shadow: 0 0 6px color-mix(in srgb, var(--bad, #f87171), transparent 50%); }
        .pc-overview__row-dot[data-health='warn'] { background: var(--warn, #fbbf24); }
        .pc-overview__row-dot[data-bar='pass'] { background: var(--good, #34d399); }
        .pc-overview__row-dot[data-bar='fail'] { background: var(--bad, #f87171); }
        /* Spend tile account states (P-003): walled = hard red, edge = orange,
           paused = yellow, ok = green. */
        .pc-overview__row-dot[data-acct='ok'] { background: var(--good, #34d399); }
        .pc-overview__row-dot[data-acct='paused'] { background: var(--warn, #fbbf24); }
        .pc-overview__row-dot[data-acct='edge'] { background: var(--warn, #fbbf24); }
        .pc-overview__row-dot[data-acct='walled'] { background: var(--bad, #f87171); box-shadow: 0 0 6px color-mix(in srgb, var(--bad, #f87171), transparent 50%); }
        .pc-overview__row-actor {
          font-size: 10.5px; font-weight: 700; color: var(--fg-mute, #7f9bb4);
          flex-shrink: 0; min-width: 40px; max-width: 64px;
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        }
        /* Deploy tile ref labels ("live :3070") need more room than coord actors. */
        .pc-overview__row-actor--wide { min-width: 56px; max-width: 80px; }
        .pc-overview__row-title {
          flex: 1; min-width: 0;
          font-size: 12px; color: var(--fg-dim, #b9d4e8);
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        .pc-overview__row-tag {
          font-size: 9.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0;
          color: var(--fg-mute, #7f9bb4);
          border: 1px solid var(--border, rgba(125, 211, 252, 0.2));
          border-radius: 5px; padding: 1px 5px; flex-shrink: 0;
        }
      `}</style>
    </div>
  );
}

/** A single dashboard tile: header (icon · title · count · open→) + body. */
function OverviewTile({
  icon,
  title,
  count,
  accent,
  loading,
  error,
  empty,
  emptyLabel,
  onOpen,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  count?: number;
  accent?: string;
  loading?: boolean;
  error?: string | null;
  empty?: boolean;
  emptyLabel: string;
  onOpen: () => void;
  children: React.ReactNode;
}) {
  return (
    <section
      className="pc-overview__tile"
      style={accent ? ({ ['--tile-accent' as string]: accent } as React.CSSProperties) : undefined}
    >
      <div className="pc-overview__tile-head">
        {icon}
        <span className="pc-overview__tile-title">{title}</span>
        {typeof count === 'number' && count > 0 && <span className="pc-overview__tile-count">{count}</span>}
        <Tooltip label={`Open ${title}`}>
          <button type="button" className="pc-overview__tile-open" aria-label={`Open ${title}`} onClick={onOpen}>
            open <ArrowRight size={11} aria-hidden />
          </button>
        </Tooltip>
      </div>
      <div className="pc-overview__tile-body">
        {error ? (
          <div className="pc-overview__tile-state" data-error="true">
            {error}
          </div>
        ) : loading ? (
          <div className="pc-overview__tile-state">Loading…</div>
        ) : empty ? (
          <div className="pc-overview__tile-state">{emptyLabel}</div>
        ) : (
          children
        )}
      </div>
    </section>
  );
}
