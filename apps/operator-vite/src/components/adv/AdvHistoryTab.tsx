import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { parseAsInteger, parseAsString, parseAsStringEnum, useQueryState } from 'nuqs';
import { useSyncQuery } from '@papercusp/sync';
import {
  ActivityTimelineView,
  ProjectHistoryView,
  type ActivityEventKind,
  type ActivityFilter,
  type ActivityTimelineEvent,
  type BuildHistoryPlan,
  type BuildHistoryProject,
  type BuildHistorySnapshotSource,
} from '@papercusp/ui-primitives';
import { useAdvScope } from './AdvShell';
import './adv-history-tab.css';

/**
 * The two modes of this tab (P-011 / D-002). `archive` is the generated
 * ProjectHistoryView document served by the REST route; `live` is the
 * reverse-chronological activity timeline served by the sync resolver.
 * URL-backed so a reload, a shared link, and `ui:get_state` all see it.
 */
const HISTORY_VIEWS = ['archive', 'live'] as const;
type HistoryViewMode = (typeof HISTORY_VIEWS)[number];

/** `ActivityFilter` = `'all' | ActivityEventKind` — kept in this order for the URL enum. */
const HISTORY_FILTERS: readonly ActivityFilter[] = ['all', 'work-item', 'plan', 'decision', 'checkpoint'];

/**
 * `PROJECT_HISTORY_EVENTS_QUERY_NAME` from
 * packages/operator-core/lib/sync-resolver/project-history-events.ts. Mirrored as
 * a literal because operator-vite does not import operator-core (same convention
 * as every other sync consumer in this app, e.g. `dev.gitPipeline`).
 */
const HISTORY_EVENTS_QUERY = 'projectHistoryEvents.byHarness';

/**
 * Mirror of `ProjectHistoryEventRow`, that file's declared CONSUMER CONTRACT —
 * it names this wiring explicitly: "a field rename here is a breaking change to
 * both". Local, like every other row type in this app's sync consumers.
 */
interface ProjectHistoryEventRow {
  eventId: string;
  kind: string;
  tsMs: number;
  actor: string | null;
  subjectKind: 'work-item' | 'plan-item' | 'plan-decision';
  /** `WI-123` | `<plan-slug>#P-004` | `<plan-slug>#<part-key>`. */
  subjectId: string;
  title: string;
  status: string | null;
  planSlug: string | null;
  harnessSlug: string;
}

/**
 * `ProjectHistoryEventKind` -> the timeline's four display kinds. Derived from
 * PROJECT_HISTORY_EVENT_KINDS, not guessed: the five `work-item.*` kinds are
 * work-item rows EXCEPT `work-item.checkpoint`, which is its own filter chip.
 */
function displayKind(kind: string): ActivityEventKind {
  if (kind === 'work-item.checkpoint') return 'checkpoint';
  if (kind === 'plan.decision') return 'decision';
  if (kind === 'plan-item.status') return 'plan';
  return 'work-item';
}

/** Human label for the transition column, from the resolver's dotted kind. */
const EVENT_VERB: Record<string, string> = {
  'work-item.created': 'created',
  'work-item.claimed': 'claimed',
  'work-item.state-changed': 'state changed',
  'work-item.checkpoint': 'checkpointed',
  'work-item.completed': 'completed',
  'plan-item.status': 'status',
  'plan.decision': 'decided',
};

function toTimelineEvent(row: ProjectHistoryEventRow): ActivityTimelineEvent {
  // `subjectId` is `<plan-slug>#<item>` for plan rows; the fragment is the item.
  const hash = row.subjectId.indexOf('#');
  const planItem = hash >= 0 ? row.subjectId.slice(hash + 1) : null;
  const details: Array<{ label: string; value: string }> = [{ label: 'Event', value: row.kind }];
  if (row.planSlug) details.push({ label: 'Plan', value: row.planSlug });
  if (row.status) details.push({ label: 'Status', value: row.status });
  if (row.actor) details.push({ label: 'Actor', value: row.actor });
  return {
    id: row.eventId,
    kind: displayKind(row.kind),
    at: new Date(row.tsMs).toISOString(),
    ref: row.subjectId,
    title: row.title,
    actor: row.actor,
    // `status` is the DESTINATION state for a change row (the resolver says so);
    // there is no recorded prior state, so `fromStatus` stays honestly absent.
    toStatus: row.status ?? (EVENT_VERB[row.kind] ?? null),
    planSlug: row.planSlug,
    planItem: row.subjectKind === 'plan-item' ? planItem : null,
    details,
  };
}

/**
 * `?view=live`. Data-in-via-props is ActivityTimelineView's contract, so ALL
 * fetching happens here; filter/query/expansion are nuqs-owned and passed down
 * controlled, which is what P-010 built the controlled-or-uncontrolled props for.
 */
function HistoryLiveView({ harnessSlug }: { harnessSlug: string }) {
  const [filter, setFilter] = useQueryState(
    'historyFilter',
    parseAsStringEnum([...HISTORY_FILTERS]).withDefault('all'),
  );
  const [search, setSearch] = useQueryState('historyQ', parseAsString.withDefault(''));
  const [expandedId, setExpandedId] = useQueryState('historyOpen', parseAsString);

  const sync = useSyncQuery<ProjectHistoryEventRow>({
    queryName: HISTORY_EVENTS_QUERY,
    args: { harnessSlug, limit: 100 },
    staleTime: 10_000,
  });

  // The resolver returns `unknown[]`; guard the boundary rather than trust it.
  const rows = useMemo(
    () => (Array.isArray(sync.data) ? (sync.data as ProjectHistoryEventRow[]) : []),
    [sync.data],
  );
  const events = useMemo(() => rows.map(toTimelineEvent), [rows]);

  // When this page of data arrived — the "Ns ago" the live dot reads.
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);
  useEffect(() => {
    if (sync.data !== undefined) setLastUpdatedAt(new Date());
  }, [sync.data]);

  if (sync.error) {
    return (
      <div className="build-history-error" role="alert">
        <strong>Live activity is unavailable.</strong>
        <span>{stripAnsi(sync.error instanceof Error ? sync.error.message : String(sync.error))}</span>
      </div>
    );
  }

  return (
    <ActivityTimelineView
      events={events}
      loading={sync.loading}
      live
      lastUpdatedAt={lastUpdatedAt}
      filter={filter}
      onFilterChange={(next) => void setFilter(next)}
      query={search}
      onQueryChange={(next) => void setSearch(next || null)}
      expandedId={expandedId}
      onExpandedChange={(next) => void setExpandedId(next)}
      emptyTitle="No activity yet"
      emptyBody="Work items, plan-item status changes, and plan decisions appear here as they happen."
    />
  );
}

/**
 * How many plans the route serves per page when `?limit` is omitted
 * (`PROJECT_HISTORY_PAGE_SIZE`). Used ONLY to size a multi-page restore below;
 * every later request reuses `page.limit` off the response, so the server stays
 * the authority and a drift in this constant is bounded by its own hard cap.
 */
const HISTORY_PAGE_SIZE = 20;

/** `PROJECT_HISTORY_MAX_PAGE_SIZE` — the route clamps above this, so never ask past it. */
const HISTORY_MAX_LIMIT = 100;

/** The route's pagination block. `total` is the whole archive, `count` just this response. */
interface ProjectHistoryPage {
  count: number;
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
}

interface ProjectHistoryDocument {
  schemaVersion: number;
  project: BuildHistoryProject;
  source: BuildHistorySnapshotSource;
  plans: Array<Omit<BuildHistoryPlan, 'project' | 'snapshot'>>;
  page?: ProjectHistoryPage;
}

function materialize(document: ProjectHistoryDocument): BuildHistoryPlan[] {
  return document.plans.map((plan) => ({ ...plan, project: document.project, snapshot: document.source }));
}

/**
 * Defence in depth. The route strips escapes from the generator's stderr, but any
 * failure that reaches this box is text we did not author, so never render it raw
 * — an unstripped SGR sequence shows the user a literal `[31m` before the message.
 */
function stripAnsi(value: string): string {
  return value
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?:]*[ -/]*[@-~]/g, '');
}

/** Carries the route's machine-readable `code` so the view can tell "empty" from "broken". */
class HistoryError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
    this.name = 'HistoryError';
  }
}

export default function AdvHistoryTab() {
  const scope = useAdvScope();
  const slug = scope.allMode ? null : scope.slug;
  const [view, setView] = useQueryState(
    'view',
    parseAsStringEnum([...HISTORY_VIEWS]).withDefault('archive'),
  );
  // How many pages the reader has opened. URL-backed so a reload or a shared link
  // restores the depth they scrolled to, and so an agent can see it (useState is
  // invisible to `ui:get_state`). The FETCH is keyed on slug/revision only, never
  // on this value — appending must not re-request what is already rendered.
  const [pages, setPages] = useQueryState('historyPages', parseAsInteger.withDefault(1));
  const pagesRef = useRef(pages);
  pagesRef.current = pages;

  const [document, setDocument] = useState<ProjectHistoryDocument | null>(null);
  const [page, setPage] = useState<ProjectHistoryPage | null>(null);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [revision, setRevision] = useState(0);

  const request = useCallback(async (
    target: string,
    limit: number,
    offset: number,
    signal: AbortSignal,
  ): Promise<ProjectHistoryDocument> => {
    const query = `?limit=${limit}&offset=${offset}`;
    const response = await fetch(`/api/harness/${encodeURIComponent(target)}/project-history${query}`, { signal });
    const body = await response.json() as ProjectHistoryDocument & { error?: string; code?: string };
    if (!response.ok) throw new HistoryError(body.error || `HTTP ${response.status}`, body.code);
    return body;
  }, []);

  useEffect(() => {
    if (!slug) {
      setDocument(null);
      setPage(null);
      setError(null);
      return;
    }
    // `live` is served by the sync resolver, so never pay the archive
    // generator's REST round-trip while that view is the one on screen.
    if (view !== 'archive') return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    // A restore asks for every opened page in ONE request rather than replaying the
    // reader's clicks; the route's own cap bounds what that can cost.
    const restore = Math.min(HISTORY_PAGE_SIZE * Math.max(1, pagesRef.current), HISTORY_MAX_LIMIT);
    request(slug, restore, 0, controller.signal)
      .then((body) => {
        setDocument(body);
        setPage(body.page ?? null);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setError({
          message: stripAnsi(cause instanceof Error ? cause.message : String(cause)),
          code: cause instanceof HistoryError ? cause.code : undefined,
        });
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [slug, revision, request, view]);

  const loadMore = useCallback(async () => {
    if (!slug || !document || !page?.hasMore || loadingMore) return;
    setLoadingMore(true);
    try {
      const next = await request(slug, page.limit, document.plans.length, new AbortController().signal);
      // APPEND. Re-fetching from offset 0 would re-transmit every page already on
      // screen, which is the cost this pagination exists to avoid.
      setDocument((current) => current && { ...current, plans: [...current.plans, ...next.plans] });
      setPage(next.page ?? null);
      void setPages((current) => (current ?? 1) + 1);
    } catch (cause: unknown) {
      setError({
        message: stripAnsi(cause instanceof Error ? cause.message : String(cause)),
        code: cause instanceof HistoryError ? cause.code : undefined,
      });
    } finally {
      setLoadingMore(false);
    }
  }, [slug, document, page, loadingMore, request, setPages]);

  const plans = useMemo(() => document ? materialize(document) : [], [document]);
  return (
    <section className="pc-project-history build-history-page" aria-busy={loading}>
      <header className="build-history-hero">
        <div>
          <span className="pc-project-history__eyebrow">Verified delivery record</span>
          <h1>History</h1>
          <p>
            {view === 'live'
              ? 'Work items, plan-item status changes, and plan decisions, newest first, as they happen.'
              : 'Plans, completed work, commits, and the validation evidence that proves each change.'}
          </p>
        </div>
        {slug ? (
          <div className="pc-history-viewswitch" role="tablist" aria-label="History view">
            {HISTORY_VIEWS.map((mode) => (
              <button
                key={mode}
                type="button"
                role="tab"
                aria-selected={view === mode}
                className={view === mode ? 'is-active' : undefined}
                onClick={() => void setView(mode === 'archive' ? null : mode)}
              >
                {mode === 'archive' ? 'Archive' : 'Live activity'}
              </button>
            ))}
          </div>
        ) : null}
      </header>
      {!slug ? (
        <div className="build-history-empty"><h2>Select a pot</h2><p>History is scoped to one project at a time.</p></div>
      ) : view === 'live' ? (
        <HistoryLiveView harnessSlug={slug} />
      ) : error?.code === 'not-a-git-repository' ? (
        <div className="build-history-empty">
          <h2>No history to show</h2>
          <p>{error.message}</p>
        </div>
      ) : error ? (
        <div className="build-history-error" role="alert">
          <strong>History is unavailable.</strong><span>{error.message}</span>
          <button type="button" onClick={() => setRevision((value) => value + 1)}>Try again</button>
        </div>
      ) : loading && !document ? (
        <p className="build-history-loading" role="status">Generating project history…</p>
      ) : (
        <>
          <ProjectHistoryView plans={plans} now={new Date()} />
          {page ? (
            <footer className="build-history-more">
              <p role="status">
                Showing {plans.length} of {page.total} plan{page.total === 1 ? '' : 's'}.
              </p>
              {page.hasMore ? (
                <button type="button" onClick={() => void loadMore()} disabled={loadingMore}>
                  {loadingMore ? 'Loading…' : `Load ${Math.min(page.limit, page.total - plans.length)} more`}
                </button>
              ) : null}
            </footer>
          ) : null}
        </>
      )}
      <style>{HISTORY_CSS}</style>
    </section>
  );
}

const HISTORY_CSS = `
  .pc-project-history { display:grid; gap:18px; min-width:0; padding:18px; color:var(--fg); overflow:auto; }
  .build-history-hero { display:flex; justify-content:space-between; gap:16px; }
  .pc-history-viewswitch { display:flex; align-self:flex-start; gap:2px; padding:2px; border:1px solid var(--border); border-radius:8px; background:var(--bg-1); }
  .pc-history-viewswitch button { padding:6px 12px; border:0; border-radius:6px; color:var(--fg-mute); background:transparent; font-size:12px; font-weight:600; }
  .pc-history-viewswitch button.is-active { color:var(--accent-ink,var(--fg)); background:var(--accent); }
  .build-history-hero h1 { margin:4px 0; font-size:22px; }
  .build-history-hero p { margin:0; color:var(--fg-mute); font-size:13px; }
  .pc-project-history__eyebrow { color:var(--accent); font-size:10px; font-weight:800; text-transform:uppercase; }
  .build-metric-grid { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:8px; }
  .build-metric,.build-plan-card,.build-validation-contract,.build-history-toolbar,.build-verification-banner { border:1px solid var(--border); border-radius:10px; background:var(--bg-1); }
  .build-metric { display:grid; gap:4px; padding:12px; } .build-metric span,.build-evidence-block h4 { color:var(--fg-mute); font-size:10px; text-transform:uppercase; }
  .build-metric strong { font-size:18px; } .build-metric small { color:var(--fg-mute); }
  .build-verification-banner { display:grid; grid-template-columns:auto 1fr auto; align-items:center; gap:10px; padding:12px; }
  .build-verification-banner p { margin:3px 0 0; color:var(--fg-mute); font-size:12px; }
  .build-verification-mark { color:var(--good); font-weight:900; } .build-verification-status { color:var(--fg-mute); font-size:10px; text-transform:uppercase; }
  .build-history-toolbar { display:grid; grid-template-columns:minmax(220px,2fr) repeat(3,minmax(120px,1fr)); gap:8px; padding:10px; }
  .build-history-toolbar label { display:grid; gap:4px; color:var(--fg-mute); font-size:10px; text-transform:uppercase; }
  .build-history-toolbar input,.build-history-toolbar select { min-width:0; padding:7px; border:1px solid var(--border); border-radius:6px; color:var(--fg); background:var(--bg-2); }
  .build-history-results-heading,.build-plan-actions,.build-plan-meta-row,.build-item-meta,.build-validation-heading,.build-validation-contract>header { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:8px; }
  .build-history-results-heading h2 { margin:0; } .build-history-results-heading p { margin:2px 0 0; color:var(--fg-mute); }
  .build-plan-list { display:grid; gap:10px; } .build-plan-card { overflow:hidden; }
  .build-plan-heading { display:grid; grid-template-columns:1fr auto; gap:12px; padding:14px; cursor:pointer; list-style:none; }
  .build-plan-heading::-webkit-details-marker { display:none; } .build-plan-title h2 { margin:7px 0 4px; } .build-plan-title p,.build-plan-title code { color:var(--fg-mute); }
  .build-plan-status,.build-item-kind,.build-item-state { padding:3px 6px; border-radius:5px; background:color-mix(in oklab,var(--accent),transparent 82%); font-size:10px; text-transform:uppercase; }
  .build-plan-body { display:grid; gap:12px; padding:0 14px 14px; } .build-plan-evidence-grid,.build-item-evidence-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:8px; }
  .build-evidence-block { padding:10px; border:1px solid var(--border); border-radius:8px; background:var(--bg-2); } .build-evidence-block h4,.build-evidence-block p { margin:0 0 5px; }
  .build-validation-contract { display:grid; gap:8px; padding:10px; } .build-validation-contract ul,.build-item-list,.build-item-commits ul { display:grid; gap:8px; margin:0; padding:0; list-style:none; }
  .build-validation-contract li,.build-item { padding:10px; border:1px solid var(--border); border-radius:8px; background:var(--bg-2); }
  .build-validation-contract p { font-size:12px; } .build-validation-contract dl { display:grid; grid-template-columns:auto 1fr; gap:4px 8px; font-size:11px; } .build-validation-contract dd { margin:0; }
  .build-work-items-disclosure>summary { cursor:pointer; color:var(--accent); } .build-item-heading { display:flex; justify-content:space-between; gap:8px; }
  .build-item-commits { margin-top:10px; } .build-commit-title,.build-commit-meta { display:flex; justify-content:space-between; gap:8px; } .build-commit-meta { color:var(--fg-mute); font-size:10px; }
  .build-history-empty,.build-history-error,.build-history-loading { padding:24px; border:1px solid var(--border); border-radius:10px; background:var(--bg-1); text-align:center; }
  .build-history-more { display:flex; align-items:center; justify-content:center; gap:12px; flex-wrap:wrap; padding:14px; }
  .build-history-more p { margin:0; color:var(--fg-mute); font-size:12px; }
  .build-history-more button { padding:7px 14px; border:1px solid var(--border); border-radius:6px; color:var(--fg); background:var(--bg-2); }
  .build-history-more button:disabled { cursor:default; opacity:.6; }
  .build-history-error { color:var(--bad); } button,.button { cursor:pointer; }
  .build-plan-dialog-overlay { position:fixed; inset:0; z-index:1200; background:rgba(0,0,0,.7); }
  .build-plan-dialog { position:fixed; inset:5vh 5vw; z-index:1201; display:grid; grid-template-rows:auto auto 1fr; overflow:hidden; padding:16px; border:1px solid var(--border); border-radius:12px; background:var(--bg-popover); color:var(--fg); }
  .build-plan-dialog-header { display:flex; justify-content:space-between; } .build-plan-dialog-provenance { display:flex; flex-wrap:wrap; gap:12px; } .build-plan-dialog-document { min-height:0; overflow:auto; }
  @media(max-width:800px){.build-metric-grid,.build-plan-evidence-grid,.build-item-evidence-grid,.build-history-toolbar{grid-template-columns:1fr}.build-verification-banner{grid-template-columns:auto 1fr}.build-verification-status{grid-column:2}}
`;
