/**
 * Fleet / Colony tab — the live agent roster, GROUPED BY FLEET and COLORED BY
 * FLEET, each row expanding inline to that agent's task-list + plan-progress +
 * recent comms.
 *
 *   1. expandable rows — tasks/plans/comms live under the agent, not in a
 *      separate section that a click merely filters.
 *   2. kind glyphs from the shared cup-cast vocabulary (mug ☕ / kettle 🫖 /
 *      cup 🍵 / papercup 🥤 / su 🛠), same as the zellij dock + agents-running pill.
 *   3. comms folded per-agent (the old global "comms" toggle is gone — its
 *      data was live but read as dead when empty; per-agent mail is clearer).
 *   4. fleet sections (owner ask 2026-07-12: "make the fleet pane in the left
 *      hand sidebar be organized by fleet and inherit the coloring like the
 *      'agents running' dropdown does").
 *
 * REUSE, not re-derivation (WI-4463): the agents-running dropdown already solved
 * fleet identity — `advRoster.list` stamps every entry with fleetSlug +
 * fleetColor (adv-roster.ts resolveFleetInfoByOwner) and AgentsRunningPill
 * exports the grouping (`groupByFleet`: fleeted groups alpha-first, "No fleet"
 * last — the zellij roster's order), the membership rule (`isRunningAgent`), and
 * the row primitives (`agentGlyph` / `displayName`). This pane consumes ALL of
 * them, so the two surfaces cannot drift into disagreeing about who is running,
 * which fleet they're in, or what color that fleet is. It replaces the old
 * `dev.coordPresence` read, which carried no fleet identity at all and could
 * only split the roster into a flat 🛠-SU / ☕-Cups pair of sections.
 *
 * Selection lives in the URL (nuqs `?lsa=…`) so it stays deep-linkable +
 * agent-driveable (ui:get_state / ui:dispatch).
 */
import { useMemo } from 'react';
import { Link } from '@tanstack/react-router';
import { useSyncQuery } from '@papercusp/sync';
import { useQueryState, parseAsString } from 'nuqs';
import { useLexicon } from '@/lib/useLexicon';
import { advRosterArgs } from '@/lib/adv-roster-args';
import { usePlanList } from '@/app/admin/plans/plans-api';
// Relative, not `@/…`: the `@` alias points at the operator (Next) tree, so an
// intra-operator-vite import must be a relative path or it won't resolve.
import {
  agentGlyph,
  displayName,
  groupByFleet,
  isRunningAgent,
  type RosterAgent,
} from '../adv/AgentsRunningPill';

/** advRoster.list returns a single-element array wrapping the roster object. */
interface RosterResponse {
  active: RosterAgent[];
}

interface WorkListItem {
  id: string;
  itemKind?: string | null;
  title?: string | null;
  status?: string | null;
  rank?: number | null;
}

interface AgentClaimLite {
  type?: string | null;
  id?: string | null;
  harnessSlug?: string | null;
  planSlug?: string | null;
}

interface CupGroup {
  agentId: string;
  label?: string | null;
  name?: string | null;
  alive: boolean;
  intent?: string | null;
  declaredPlanSlug?: string | null;
  claims?: AgentClaimLite[];
  doing?: WorkListItem | null;
  queued: WorkListItem[];
  load: number;
}

interface PlanRow {
  slug: string;
  harness?: string | null;
  archived?: boolean;
  priority?: number | null;
  itemCounts?: { todo?: number; done?: number; blocked?: number; failed?: number } | null;
}

interface MailEntry {
  msg_id?: string;
  kind?: string;
  from?: string | null;
  to?: string[];
  summary?: string | null;
  ts?: string;
}

interface CupMailRow {
  owner: string;
  inbox: MailEntry[];
  outbox: MailEntry[];
}

function planTotals(p: PlanRow): { done: number; total: number } {
  const c = p.itemCounts ?? {};
  const done = c.done ?? 0;
  const total = done + (c.todo ?? 0) + (c.blocked ?? 0) + (c.failed ?? 0);
  return { done, total };
}

/**
 * Rows used to be plain `<a href>` anchors — which TanStack Router cannot
 * intercept, so every click did a FULL PAGE RELOAD (owner bug 2026-06-23). They
 * are now `<Link to search>` for client-side nav: the destination route's
 * `useSyncQuery`s hydrate the right pane in place, no reload.
 *
 * The `search` is always applied as a MERGE over the live URL (the `(prev) =>`
 * updater below), never a plain object — because the Colony rail's own state
 * (`?lsb`/`lst`/`lsa`) rides in the same search string, so a wholesale replace
 * would collapse/reset the sidebar on every click. (Same convention as
 * MugTab's navigate() in this directory.) Empty values are dropped.
 */
type RowSearch = Record<string, string | number | null | undefined>;

function mergeSearch(params: RowSearch) {
  return (prev: Record<string, unknown>) => {
    const next: Record<string, unknown> = { ...prev };
    for (const [key, value] of Object.entries(params)) {
      if (value == null || value === '') delete next[key];
      else next[key] = value;
    }
    return next;
  };
}

/** Work-item → its harness Working pane (needs the owning harness from the claim). */
function taskSearch(w: WorkListItem, g: CupGroup | undefined): RowSearch | null {
  const claim = g?.claims?.find((c) => c.type === 'work-item' && c.id === w.id && c.harnessSlug);
  if (!claim?.harnessSlug) return null;
  return { tab: 'harnesses', slug: claim.harnessSlug, scope: 'self', sel: w.id };
}

function planSearch(p: PlanRow): RowSearch {
  return { view: 'plans', plan: p.slug, h: p.harness };
}

/**
 * A clicked message → the Conversations FEED, opened AT that message
 * (`?fmsg=<msg_id>`, which the feed resolves child→root, scrolls into view, and
 * expands).
 *
 * `fsys: 'all'` is load-bearing, not decoration (WI-4462, owner bug 2026-07-12:
 * "clicking some of the messages brings up the conversations tab opened to the
 * clicked message but some of them don't"). The feed defaults to SYSTEM-origin
 * envelopes only (`system_only`, matched by `isSystemCoordActor` = /^system…/),
 * and that default used to be hardcoded — so a click on any AGENT-authored
 * message (from: su-… / bee-…, i.e. most of an agent's mail) deep-linked to a
 * row that could not exist in the feed: the tab opened at the newest head with
 * nothing expanded, while a system-watchdog row a few lines above it worked
 * fine. Widening the scope for the deep-link makes EVERY message row behave the
 * same, whoever sent it.
 */
function mailSearch(ownerId: string, msgId: string): RowSearch {
  return { tab: 'conversations', conv: 'feed', fsys: 'all', fagent: ownerId, fmsg: msgId };
}

export default function SwarmTab({ active }: { active: boolean }) {
  const t = useLexicon();
  const [selected, setSelected] = useQueryState('lsa', parseAsString);

  // The SAME workspace-wide, fleet-stamped roster the agents-running pill reads —
  // deliberately with the IDENTICAL args, so the two surfaces share one sync cache
  // entry (one resolve, one push) instead of issuing two near-duplicate queries.
  // (This pane ignores `ended` entirely; it still rides the shared key rather
  // than asking for a smaller slice, because a narrower `endedLimit` is a
  // DIFFERENT cache key — a second full resolve to receive LESS. `endedLimit`
  // is also `.positive()` server-side, so 0 is not a legal "don't fetch ended".
  // The one canonical shape lives in advRosterArgs — P-026.)
  const roster = useSyncQuery<RosterResponse>({
    queryName: 'advRoster.list',
    args: advRosterArgs(null),
    enabled: active,
    staleTime: 8_000,
  });
  const cups = useSyncQuery<CupGroup>({
    queryName: 'sidebar.fleetCups',
    enabled: active,
    staleTime: 8_000,
  });
  // usePlanList, NOT a raw `useSyncQuery('plans.list')`: the raw form here
  // omitted `args` entirely, which is the key `{}` — distinct from the
  // `{includeArchived:true,includeLegacy:true}` SUPERSET every other pane
  // (MugTab, AdvOverviewTab) already holds, so the sidebar was paying for a
  // second ~800 KB resolve to receive a strict SUBSET of rows it then filtered
  // the same way. usePlanList over-fetches once and narrows client-side; its
  // `{}` narrowing (archived off, legacy on) is exactly the server default this
  // call site used to get. P-026.
  const plans = usePlanList({ enabled: active });
  // Per-agent comms: only fetched for the expanded agent.
  const mail = useSyncQuery<CupMailRow>({
    queryName: 'sidebar.cupMail',
    args: { owner: selected ?? '' },
    enabled: active && !!selected,
    staleTime: 8_000,
  });

  const running = useMemo(
    () => (roster.data?.[0]?.active ?? []).filter(isRunningAgent),
    [roster.data],
  );
  const groups = useMemo(() => groupByFleet(running), [running]);
  const byAgent = useMemo(() => {
    const m = new Map<string, CupGroup>();
    for (const g of cups.data ?? []) m.set(g.agentId, g);
    return m;
  }, [cups.data]);

  const toggle = (id: string) => {
    void setSelected(selected === id ? null : id);
  };

  const taskRow = (w: WorkListItem, i: number, g: CupGroup | undefined) => {
    const search = taskSearch(w, g);
    const label = w.title || w.id;
    const body = (
      <>
        <span className="pclsb-task__rank">{w.rank != null ? `#${w.rank}` : '—'}</span>
        <span className="pclsb-task__main">
          <span className="pclsb-task__title">{label}</span>
          <span className="pclsb-task__id">{w.id}</span>
        </span>
        {w.status && <span className="pclsb-task__st">{w.status}</span>}
      </>
    );
    return search ? (
      <Link
        className="pclsb-task pclsb-linkrow"
        key={`${w.id}-${i}`}
        to="/adv"
        search={mergeSearch(search)}
        aria-label={`Open task ${w.id}: ${label}`}
      >
        {body}
      </Link>
    ) : (
      <div className="pclsb-task" key={`${w.id}-${i}`}>
        {body}
      </div>
    );
  };

  /**
   * One message row. EVERY row with a msg_id deep-links into the feed at that
   * message (see mailSearch) — inbound and outbound alike. A row WITHOUT a
   * msg_id has no target to open, so it renders as plain text rather than as a
   * link that silently lands nowhere: an affordance that can't work is worse
   * than no affordance (it's the shape of the bug this whole row-renderer is
   * fixing).
   */
  const mailRow = (ownerId: string, mm: MailEntry, i: number, dir: 'in' | 'out') => {
    const inbound = dir === 'in';
    const meta = inbound
      ? `Inbox · ${mm.from ?? '?'} · ${mm.kind ?? 'message'}`
      : `Outbox · ${(mm.to ?? []).join(', ') || '*'} · ${mm.kind ?? 'message'}`;
    const label = inbound
      ? `Open inbound message from ${mm.from ?? 'unknown'}`
      : `Open outbound message to ${(mm.to ?? []).join(', ') || 'all'}`;
    const body = (
      <>
        <div className="pclsb-mail__meta">{meta}</div>
        <span className="pclsb-mail__summary">{mm.summary ?? '(no summary)'}</span>
      </>
    );
    const key = `${dir}-${mm.msg_id ?? i}`;
    return mm.msg_id ? (
      <Link
        className="pclsb-mail pclsb-linkrow"
        to="/adv"
        search={mergeSearch(mailSearch(ownerId, mm.msg_id))}
        key={key}
        aria-label={label}
      >
        {body}
      </Link>
    ) : (
      <div className="pclsb-mail" key={key}>
        {body}
      </div>
    );
  };

  const renderExpansion = (a: RosterAgent) => {
    const g = byAgent.get(a.ownerId);
    const slugs = new Set<string>();
    if (g?.declaredPlanSlug) slugs.add(g.declaredPlanSlug);
    for (const c of g?.claims ?? []) if (c.planSlug) slugs.add(c.planSlug);
    if (a.currentPlanSlug) slugs.add(a.currentPlanSlug);
    const agentPlans = (plans.data?.plans ?? [])
      .filter((p) => !p.archived && slugs.has(p.slug) && planTotals(p).total > 0)
      .sort((x, y) => (y.priority ?? 0) - (x.priority ?? 0));

    const m = mail.data?.[0];
    const inbox = [...(m?.inbox ?? [])].reverse().slice(0, 6);
    const outbox = [...(m?.outbox ?? [])].reverse().slice(0, 6);
    const hasMail = inbox.length > 0 || outbox.length > 0;

    return (
      <div className="pclsb-expand" data-testid={`swarm-expand-${a.ownerId}`}>
        <div className="pclsb-expand__head">Tasks{g ? ` · ${g.load} claimed` : ''}</div>
        {g && g.queued.length > 0 ? (
          g.queued.map((w, i) => taskRow(w, i, g))
        ) : (
          <div className="pclsb-expand__empty">{g ? 'no work-items claimed' : 'no fleet task data'}</div>
        )}

        <div className="pclsb-expand__head">Plan progress</div>
        {agentPlans.length > 0 ? (
          agentPlans.slice(0, 8).map((p) => {
            const { done, total } = planTotals(p);
            const pct = total > 0 ? Math.round((done / total) * 100) : 0;
            return (
              <Link
                className="pclsb-plan pclsb-linkrow"
                key={p.slug}
                to="/admin/plans"
                search={mergeSearch(planSearch(p))}
                aria-label={`Open plan ${p.slug}`}
              >
                <span className="pclsb-plan__slug">
                  {p.slug}
                </span>
                <span className="pclsb-plan__bar" aria-hidden="true">
                  <span className="pclsb-plan__fill" style={{ width: `${pct}%` }} />
                </span>
                <span className="pclsb-plan__pct">{pct}%</span>
                <span className="pclsb-plan__nums">
                  {done}/{total}
                </span>
              </Link>
            );
          })
        ) : (
          <div className="pclsb-expand__empty">no linked plans</div>
        )}

        {(hasMail || (selected === a.ownerId && mail.loading)) && (
          <>
            <div className="pclsb-expand__head">Recent messages</div>
            {mail.loading && !hasMail && <div className="pclsb-expand__empty">loading…</div>}
            {inbox.map((mm, i) => mailRow(a.ownerId, mm, i, 'in'))}
            {outbox.map((mm, i) => mailRow(a.ownerId, mm, i, 'out'))}
          </>
        )}
      </div>
    );
  };

  const renderAgentRow = (a: RosterAgent, fleetColor: string | null) => {
    const g = byAgent.get(a.ownerId);
    const isSel = selected === a.ownerId;
    return (
      <div className="pclsb-agent" key={a.ownerId}>
        <div
          className={`pclsb-row is-clickable${isSel ? ' is-selected' : ''}`}
          data-testid={`swarm-agent-${a.ownerId}`}
          data-liveness={a.liveness}
          // The fleet's accent, inherited from the roster stamp — the same color
          // the agents-running dropdown paints this agent's group with.
          style={fleetColor ? { borderLeft: `2px solid ${fleetColor}` } : undefined}
          onClick={() => toggle(a.ownerId)}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') toggle(a.ownerId);
          }}
        >
          <span className="pclsb-row__icon" aria-hidden="true">
            {agentGlyph(a)}
          </span>
          <div className="pclsb-row__main">
            <div className="pclsb-row__title" title={a.ownerId}>
              {displayName(a, t)}
            </div>
            <div className="pclsb-row__sub" title={a.intent || undefined}>
              {a.intent || g?.intent || 'no declared intent'}
            </div>
          </div>
          {g && g.load > 0 && <span className="pclsb-pill">⇄{g.load}</span>}
          <span className="pclsb-row__chev" aria-hidden="true">
            {isSel ? '▾' : '▸'}
          </span>
        </div>
        {isSel && renderExpansion(a)}
      </div>
    );
  };

  return (
    <div className="pclsb-panel" data-testid="left-sidebar-swarm">
      <div className="pclsb-panel__bar">
        {/* Same warm-up guard as the Agents lane value: a present-but-empty first
            read must not render a confident "· 0 live" over a live fleet. */}
        <span className="pclsb-panel__bar-label">
          {t('fleet', { lower: true })} · {running.length === 0 && roster.loading ? '…' : `${running.length} live`}
        </span>
      </div>

      {roster.error && <div className="pclsb-panel__error">{String(roster.error)}</div>}
      {running.length === 0 && !roster.loading && (
        <div className="pclsb-panel__empty">No agents active right now.</div>
      )}

      {groups.map((grp) => (
        <div
          className="pclsb-sec pclsb-fleet"
          key={grp.slug ?? '__none'}
          data-testid={`swarm-fleet-${grp.slug ?? 'none'}`}
          style={grp.color ? { borderColor: grp.color } : undefined}
        >
          <div
            className="pclsb-sec__head pclsb-fleet__head"
            style={grp.color ? { color: grp.color } : undefined}
          >
            <span
              className="pclsb-fleet__dot"
              style={{ background: grp.color ?? 'var(--fg-mute, #7f9bb4)' }}
              aria-hidden="true"
            />
            {grp.slug ?? 'No fleet'}
            <span className="pclsb-fleet__count">({grp.agents.length})</span>
          </div>
          {grp.agents.map((a) => renderAgentRow(a, grp.color))}
        </div>
      ))}
    </div>
  );
}
