/**
 * /api/coord/* — read-only history routes for the agent-coordination
 * substrate. Phase E13 (endpoint-unification-2026-05-21): ported off the
 * legacy `_hono/coord.ts` Hono sub-app onto `defineTool`. URLs unchanged.
 *
 * All routes are `auth: 'public'` — the legacy `coord` sub-app carried
 * no auth middleware; the `/coord` UI fetches these unauthenticated and
 * they are loopback-protected by the host bind. Posture preserved
 * verbatim (the route-migration rule: a mechanical port does not
 * tighten auth).
 *
 *   GET /api/coord/history      merged feed (plan-events/messages/escalations/handoffs)
 *   GET /api/coord/history/:source/:msg_id  one row's payload, on demand
 *   GET /api/coord/presence     active + stale presence records
 *   GET /api/coord/inbox        human-facing inbox
 *   GET /api/coord/plans        plan directory
 *   GET /api/coord/plans/:slug  one plan + raw markdown
 *   GET /api/coord/escalations  list-only
 *   GET /api/coord/handoffs     list-only
 *   GET /api/coord/plan-events  list-only
 */
import { defineTool } from '@papercusp/agent-mcp';
import inboxSse from './inbox-sse';
import { readPlanEvents } from '../../../agent-tools/coordination/plan-events';
import { listEscalations, listEscalationsPaginated } from '../../../agent-tools/coordination/escalations';
import { listHandoffs, listHandoffsPaginated } from '../../../agent-tools/coordination/handoffs';
import { coordLog } from '../../../agent-tools/coordination/log';
import { type CoordEnvelope } from '../../../agent-tools/coordination/envelope';

/**
 * Fields `toHistoryItem` PROJECTS out of the envelope onto the row's top level.
 * They are stripped from `payload` so each row carries them once, not twice
 * (WI-7295): `payload` used to be the whole envelope the columns were projected
 * FROM, which duplicated 42,328 B across the default 200-row view — 16.2% of the
 * read, and enough on its own to bust the 250,000 B sync-read budget.
 *
 * Every value stays reachable byte-identically at the row's top level, so this
 * removes a second copy, never information. `summary` is NOT in this list: it is
 * derived (envSummary truncates `detail` to 200 chars), so the full `detail`/
 * `event` text must survive inside `payload`.
 */
const PROJECTED_ENVELOPE_FIELDS = [
  'ts',
  'msg_id',
  'kind',
  'from',
  'to',
  'plan_slug',
  'harness_slug',
] as const;

/** The envelope minus the fields already projected onto the row. */
export type HistoryPayload = Omit<CoordEnvelope, (typeof PROJECTED_ENVELOPE_FIELDS)[number]>;

export interface HistoryItem {
  ts: string;
  msg_id: string;
  source: 'plan_event' | 'message' | 'escalation' | 'handoff';
  kind: string;
  from?: string;
  to?: string[];
  plan_slug?: string;
  harness_slug?: string;
  summary?: string;
  payload: HistoryPayload;
}

function envSummary(e: CoordEnvelope): string {
  const detail = (e as { detail?: unknown }).detail;
  if (typeof detail === 'string') return detail.slice(0, 200);
  const event = (e as { event?: unknown }).event;
  if (typeof event === 'string') return event;
  return e.kind;
}

/**
 * The envelope minus the fields already projected onto the row — the exact
 * value a history row's `payload` carries. Shared by `toHistoryItem` (the list)
 * and `loadCoordHistoryPayload` (the per-row on-demand fetch, WI-7297) so the
 * two can never disagree about what "the payload" is.
 */
function toHistoryPayload(e: CoordEnvelope): HistoryPayload {
  const payload = { ...e } as Record<string, unknown>;
  for (const k of PROJECTED_ENVELOPE_FIELDS) delete payload[k];
  return payload as HistoryPayload;
}

function toHistoryItem(source: HistoryItem['source'], e: CoordEnvelope): HistoryItem {
  const plan_slug = typeof (e as { plan_slug?: unknown }).plan_slug === 'string'
    ? ((e as { plan_slug?: string }).plan_slug as string)
    : undefined;
  const harness_slug = typeof (e as { harness_slug?: unknown }).harness_slug === 'string'
    ? ((e as { harness_slug?: string }).harness_slug as string)
    : undefined;
  const payload = toHistoryPayload(e);
  return {
    ts: e.ts,
    msg_id: e.msg_id,
    source,
    kind: e.kind,
    from: e.from,
    to: e.to,
    plan_slug,
    harness_slug,
    summary: envSummary(e),
    payload: payload as HistoryPayload,
  };
}

// EI-18138089781782660: this used to read the WHOLE coord corpus (every
// plan-event + every message + every escalation + every handoff, unbounded)
// on every call, then filter/sort/slice in JS — cost grew unboundedly with
// total coord volume. Every per-surface fetch below is now a BOUNDED storage
// read: readPlanEvents already pushes since_ts/planSlug into its own bounded
// query; messages go through `readLinesBounded` (limit/sinceTs/planSlug
// pushed to SQL, same primitive plan-events uses); escalations/handoffs go
// through their already-bounded/folded `*Paginated` readers (which page a
// coverage window deeper rather than risk a zombie "open" record — the same
// pattern WI-4181 hardened for escalations, now mirrored for handoffs). The
// `owner` filter still runs in JS over the bounded window (matching
// `readCoordFeed`'s established convention — see feed.ts's WI-3869 comment;
// pushing an owner/`to`-array-containment filter into SQL isn't the part
// that was unbounded).
//
// PUSHDOWN_CAP mirrors feed.ts's RAW_SURFACE_FETCH_CAP: fetch at most this
// many rows per surface regardless of the final page `limit`, so a caller
// asking for a small page with a narrow (planSlug/owner) filter still gets a
// wide-enough window to find its matches, without ever re-materializing the
// whole surface.
const PUSHDOWN_CAP = 1000;

export async function loadCoordHistory(args: {
  kinds?: string[];
  planSlug?: string;
  owner?: string;
  sinceTs?: string;
  limit?: number;
} = {}): Promise<{ items: HistoryItem[]; total: number; truncated: boolean }> {
  const wanted = args.kinds?.length ? new Set(args.kinds) : null;
  const sinceMs = args.sinceTs ? new Date(args.sinceTs).getTime() : 0;
  const limit = Math.min(Math.max(args.limit ?? 200, 1), 1000);
  const pushdownLimit = Math.min(Math.max(limit * 3, 200), PUSHDOWN_CAP);
  const items: HistoryItem[] = [];
  if (!wanted || wanted.has('plan_event')) {
    for (const e of await readPlanEvents({
      planSlugs: args.planSlug ? [args.planSlug] : undefined,
      since_ts: args.sinceTs,
      limit: pushdownLimit,
    })) items.push(toHistoryItem('plan_event', e));
  }
  if (!wanted || wanted.has('message')) {
    const bounded = await coordLog.readLinesBounded('messages', {
      limit: pushdownLimit,
      ...(args.sinceTs ? { sinceTs: args.sinceTs } : {}),
      ...(args.planSlug ? { planSlug: args.planSlug } : {}),
    });
    for (const e of bounded) items.push(toHistoryItem('message', e));
  }
  if (!wanted || wanted.has('escalation')) {
    const { escalations } = await listEscalationsPaginated({ maxRecords: pushdownLimit });
    for (const e of escalations) items.push(toHistoryItem('escalation', e));
  }
  if (!wanted || wanted.has('handoff')) {
    const { handoffs } = await listHandoffsPaginated({ maxRecords: pushdownLimit });
    for (const h of handoffs) {
      items.push(toHistoryItem('handoff', h.record));
      if (h.accepted_by) items.push(toHistoryItem('handoff', h.accepted_by));
    }
  }
  let filtered = items;
  if (args.planSlug) filtered = filtered.filter((it) => it.plan_slug === args.planSlug);
  if (args.owner) {
    const owner = args.owner;
    filtered = filtered.filter(
      (it) => it.from === owner || (it.to ?? []).includes(owner) || (it.to ?? []).includes('*'),
    );
  }
  if (sinceMs > 0) filtered = filtered.filter((it) => new Date(it.ts).getTime() > sinceMs);
  filtered.sort((a, b) => b.ts.localeCompare(a.ts) || b.msg_id.localeCompare(a.msg_id));
  const truncated = filtered.length > limit;
  return { items: truncated ? filtered.slice(0, limit) : filtered, total: filtered.length, truncated };
}

/** The four history sources, as the list rows label them. */
export const HISTORY_SOURCES: readonly HistoryItem['source'][] = [
  'plan_event',
  'message',
  'escalation',
  'handoff',
] as const;

export function isHistorySource(v: unknown): v is HistoryItem['source'] {
  return typeof v === 'string' && (HISTORY_SOURCES as readonly string[]).includes(v);
}

/**
 * Fetch ONE history row's `payload` on demand (WI-7297).
 *
 * ## Why this route exists at all
 *
 * `/coord`'s viewer holds `expanded` as a single `useState<string | null>`, so
 * AT MOST ONE row's payload is ever rendered — and only after a click. The list
 * nonetheless shipped all 200: measured live 2026-08-03, `payload` was 75.95%
 * of the read (159,523 B of 210,029 B) to display, in the common case, zero of
 * them. That is a per-VIEW waste, not a per-row one, so no further projection
 * could fix it (WI-7295 had already removed the last redundant bytes) — only
 * moving the fetch to the click could.
 *
 * ## Why it is a direct read and not a filtered `loadCoordHistory`
 *
 * Derived-read snapshots have no arg dimension, so an args-bearing variant
 * falls through to `loadCoordHistory`'s full inline scan — the 0.1-0.8s
 * variable-latency path the P-004 precompute exists to avoid. Paying that per
 * deliberate user click would be defensible, but it is also unnecessary: each
 * source already has a targeted by-id read, so this is an indexed point lookup
 * instead. It is additionally CORRECT where a scan is not — `loadCoordHistory`
 * is a bounded newest-N window, so a scan would answer `null` for any row older
 * than the bound, which is precisely the older-row case a user scrolls to.
 *
 * Returns null when no envelope with that id exists on that surface.
 */
export async function loadCoordHistoryPayload(
  source: HistoryItem['source'],
  msgId: string,
): Promise<HistoryPayload | null> {
  if (!msgId) return null;
  const envelope = await (async (): Promise<CoordEnvelope | null> => {
    switch (source) {
      case 'message': {
        const { getMessageById } = await import('../../../agent-tools/coordination/messages');
        return getMessageById(msgId);
      }
      case 'plan_event': {
        const { getPlanEventById } = await import('../../../agent-tools/coordination/plan-events');
        return getPlanEventById(msgId);
      }
      case 'escalation': {
        const { getEscalation } = await import('../../../agent-tools/coordination/escalations');
        return getEscalation(msgId);
      }
      case 'handoff': {
        // Covers the acceptance/expiry/re-ping siblings too: the list pushes
        // `h.accepted_by` as its own row, and each is stored under its own
        // msg_id on the same event surface (isHandoffRecord admits all four
        // handoff-family kinds).
        const { getHandoff } = await import('../../../agent-tools/coordination/handoffs');
        return getHandoff(msgId);
      }
    }
  })();
  return envelope ? toHistoryPayload(envelope) : null;
}

// EI-18138089781782660: same anti-pattern as loadCoordHistory before it was
// fixed — this used to read the WHOLE coord corpus (readAllMessages() with no
// LIMIT, listEscalations({})/listHandoffs({}) with no status filter, each an
// unbounded full-surface event replay) on every call, then filter down to the
// human-directed subset in JS. Cost grew unboundedly with total coord volume
// even though the human-facing inbox is typically tiny. Now every per-surface
// fetch is the same BOUNDED storage read loadCoordHistory uses: messages go
// through `readLinesBounded` (limit pushed to SQL); escalations go through
// `listEscalationsPaginated({ status: 'open' })`, which folds status server
// side (no `resolved == null` JS filter needed) AND already pages deep enough
// to avoid the WI-4181 zombie-open class; handoffs go through
// `listHandoffsPaginated` (same bounded/folded primitive as loadCoordHistory).
export async function loadCoordInbox(): Promise<HistoryItem[]> {
  const [msgs, { escalations }, { handoffs }] = await Promise.all([
    coordLog.readLinesBounded('messages', { limit: PUSHDOWN_CAP }),
    // listEscalationsPaginated/listHandoffsPaginated clamp maxRecords to 500
    // internally regardless — pass 500 explicitly rather than PUSHDOWN_CAP
    // (1000) to avoid implying a wider window than these primitives honor.
    listEscalationsPaginated({ status: 'open', maxRecords: 500 }),
    listHandoffsPaginated({ maxRecords: 500 }),
  ]);
  const items: HistoryItem[] = [];
  for (const m of msgs) {
    if (Array.isArray(m.to) && m.to.includes('human')) items.push(toHistoryItem('message', m));
  }
  for (const e of escalations) {
    items.push(toHistoryItem('escalation', e));
  }
  for (const h of handoffs) {
    if (Array.isArray(h.record.to) && h.record.to.includes('human')) items.push(toHistoryItem('handoff', h.record));
  }
  return items.sort((a, b) => b.ts.localeCompare(a.ts) || b.msg_id.localeCompare(a.msg_id));
}

export async function loadCoordPlans(): Promise<Array<Record<string, unknown>>> {
  const { readAllPlans } = await import('../../../agent-tools/plans/source');
  return (await readAllPlans({}))
    .filter((p) => !p.parsed.isLegacy)
    .map((p) => ({
      // IDENTITY AND LIFECYCLE COME FROM THE ROW, NEVER THE MARKDOWN (WI-7246).
      // A scheduled-run snapshot (`<slug>@run-<epochms>`) copies its parent
      // plan's body verbatim — frontmatter included — so the self-declared
      // `slug`/`status` of all 50 papercusp snapshots read as the PARENT's.
      // Trusting them collapsed 51 distinct plans into ONE identity: 51
      // duplicate React keys, every row fetching the parent's markdown, one
      // click expanding all 51 at once, and `superseded` rows rendering as
      // `draft`. `plan_slug` is also the only value that round-trips —
      // /coord/plans/:slug resolves via readPlanBySlug -> getPlanRow.
      slug: p.row.planSlug,
      title: p.parsed.frontmatter.title ?? p.row.planSlug,
      status: p.row.status ?? p.parsed.frontmatter.status ?? 'unknown',
      // Canonical-first for consistency with slug/status, though measured as a
      // NO-OP today: the `updated` column is NULL on all 50 snapshots, so this
      // falls through to the frontmatter exactly as before. (`title`
      // deliberately still LEADS with the frontmatter — it is display text
      // rather than identity, and its 20 row-vs-markdown divergences have a
      // separate, undiagnosed cause.)
      updated: p.row.updated ?? p.parsed.frontmatter.updated ?? null,
      now_state: p.parsed.now?.state ?? null,
      now_next: p.parsed.now?.next ?? null,
      item_count: p.parsed.items.length,
      decision_count: p.parsed.decisions.length,
    }));
}

/**
 * Fire-and-forget boot warm-up for the `coord.plans` sync query (WI-36179).
 *
 * `loadCoordPlans()` is a single well-scoped SQL read (`listPlanRows`, one query,
 * no N+1) followed by CPU-bound `parsePlan()` markdown parsing over every row —
 * on a WARM process this is comfortably inside the sync-resolver's 10s
 * RESOLVER_TIMEOUT_MS. But the FIRST call after an operator restart also pays
 * cold-start cost that a warm call does not: compiling the `agent-tools/plans/source`
 * import tree, running `parsePlan()` un-JIT'd across the whole corpus (932 rows /
 * 385KB measured), and a cold PG connection/query-plan — and that combined cost
 * was measured to exceed the 10s budget on `:3170` right after a restart, while an
 * immediate retry (now warm) succeeded well within it. The user-visible effect was
 * the CoordDashboard failing its first load after any operator restart, reading
 * like a network blip, then working on refresh.
 *
 * Firing this same read once at boot pays that one-time cost before any user is
 * waiting on it — the resolver's real semantics (always a synchronous, fully
 * correct read; no snapshot staleness) are unchanged, this just moves WHEN the
 * first invocation happens. Same pattern as `preWarmSystemHealth`
 * (system-health/compute.ts) for the equivalent cold-cache-on-boot problem.
 * Best-effort: a failure here is logged and swallowed, never thrown — this must
 * never block or fail boot, and the resolver still works correctly (just slower)
 * on its own first real call if this warm-up itself loses the race or errors.
 */
export function preWarmCoordPlans(): void {
  void loadCoordPlans().catch((e: unknown) => {
    console.warn(
      '[coord] boot pre-warm of coord.plans failed (non-fatal — the resolver will cold-compute on first real call):',
      e instanceof Error ? e.message : e,
    );
  });
}

const history = defineTool({
  method: 'GET',
  path: '/coord/history',
  auth: 'public',
  async handler(req) {
    const q = new URL(req.url).searchParams;
    return Response.json(await loadCoordHistory({
      kinds: q.get('kinds')?.split(',').map((s) => s.trim()).filter(Boolean),
      planSlug: q.get('plan_slug') ?? undefined,
      owner: q.get('owner') ?? undefined,
      sinceTs: q.get('since_ts') ?? undefined,
      limit: parseInt(q.get('limit') ?? '200', 10) || 200,
    }));
  },
});

// WI-7297: one row's payload, fetched when the viewer expands it. Source-aware
// because `msg_id` is only unique WITHIN a surface, and each surface has its own
// targeted by-id read — see loadCoordHistoryPayload for why this is a point
// lookup rather than a filtered history scan.
const historyPayload = defineTool({
  method: 'GET',
  path: '/coord/history/:source/:msg_id',
  auth: 'public',
  async handler(_req, ctx) {
    const source = ctx.params.source;
    const msgId = ctx.params.msg_id;
    if (!isHistorySource(source)) {
      return Response.json(
        { error: 'unknown source', expected: HISTORY_SOURCES },
        { status: 400 },
      );
    }
    const payload = await loadCoordHistoryPayload(source, msgId);
    if (payload === null) return Response.json({ error: 'history item not found' }, { status: 404 });
    return Response.json({ source, msg_id: msgId, payload });
  },
});

const presence = defineTool({
  method: 'GET',
  path: '/coord/presence',
  auth: 'public',
  async handler(req) {
    const { listPresence } = await import('../../../agent-tools/coordination/presence');
    const ws = new URL(req.url).searchParams.get('workspace');
    const records = await listPresence({ workspaceId: ws });
    return Response.json({
      active: records.filter((r) => !r.stale),
      stale: records.filter((r) => r.stale),
    });
  },
});

const inbox = defineTool({
  method: 'GET',
  path: '/coord/inbox',
  auth: 'public',
  async handler() {
    return Response.json({ items: await loadCoordInbox() });
  },
});

const plans = defineTool({
  method: 'GET',
  path: '/coord/plans',
  auth: 'public',
  async handler() {
    return Response.json({ plans: await loadCoordPlans() });
  },
});

const planBySlug = defineTool({
  method: 'GET',
  path: '/coord/plans/:slug',
  auth: 'public',
  async handler(_req, ctx) {
    const slug = ctx.params.slug;
    const { readPlanBySlug } = await import('../../../agent-tools/plans/source');
    const { readFile } = await import('node:fs/promises');
    const found = await readPlanBySlug(slug);
    if (!found) return Response.json({ error: 'plan not found' }, { status: 404 });
    let markdown = '';
    try {
      markdown = await readFile(found.parsed.filePath, 'utf8');
    } catch {
      return Response.json({ error: 'plan file unreadable' }, { status: 500 });
    }
    return Response.json({
      slug,
      // Canonical-first for STATUS (WI-7259, sibling of the /coord/plans list
      // fix, WI-7246): a scheduled-run snapshot copies its parent plan's body
      // verbatim, frontmatter included, so `found.parsed.frontmatter.status`
      // reads the PARENT's lifecycle for every snapshot. `title` deliberately
      // stays frontmatter-first — it is display text, not identity (WI-7246).
      title: found.parsed.frontmatter.title ?? slug,
      status: found.row.status ?? found.parsed.frontmatter.status ?? 'unknown',
      archived: found.archived,
      markdown,
    });
  },
});

const escalations = defineTool({
  method: 'GET',
  path: '/coord/escalations',
  auth: 'public',
  async handler(req) {
    const status = new URL(req.url).searchParams.get('status');
    const opts: { status?: 'open' | 'resolved' } = {};
    if (status === 'open' || status === 'resolved') opts.status = status;
    return Response.json({ items: await listEscalations(opts) });
  },
});

const handoffs = defineTool({
  method: 'GET',
  path: '/coord/handoffs',
  auth: 'public',
  async handler(req) {
    const status = new URL(req.url).searchParams.get('status');
    const opts: { status?: 'open' | 'accepted' } = {};
    if (status === 'open' || status === 'accepted') opts.status = status;
    return Response.json({ items: await listHandoffs(opts) });
  },
});

const planEvents = defineTool({
  method: 'GET',
  path: '/coord/plan-events',
  auth: 'public',
  async handler(req) {
    const q = new URL(req.url).searchParams;
    const planSlug = q.get('plan_slug');
    const eventsParam = q.get('events');
    const sinceTs = q.get('since_ts');
    const opts: { planSlugs?: string[]; events?: never[]; since_ts?: string } = {};
    if (planSlug) opts.planSlugs = [planSlug];
    if (eventsParam) {
      (opts as { events?: string[] }).events = eventsParam
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }
    if (sinceTs) opts.since_ts = sinceTs;
    return Response.json({ items: await readPlanEvents(opts as never) });
  },
});

export default [
  history,
  historyPayload,
  presence,
  inbox,
  inboxSse,
  plans,
  planBySlug,
  escalations,
  handoffs,
  planEvents,
];
