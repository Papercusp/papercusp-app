/**
 * "View inactive sessions" — the expander under the live roster that lists
 * every ended session, newest-ended first, in pages with infinite scroll.
 *
 * The presentation half of the operator's inactive-sessions section, lifted
 * whole (WI-2047194, same shape as P-001 / D-005) so the portal renders the SAME
 * section from the SAME code. What stayed in the host, and why:
 *
 *   · DATA — `loadPage(before)` is the host's own fetch against its own route
 *     (the operator hits /api/adv/sessions/ended directly; the portal proxies
 *     it server-side). This component never fetches.
 *   · EXPAND STATE — controlled: `expanded` + `onExpandedChange`. The operator
 *     keeps it in the URL (nuqs `agentsInactiveOpen`, which is also what makes
 *     it survive the pill's unmount/remount when the live roster transiently
 *     reads empty — WI-3881); a host with no router passes local state.
 *   · CHROME / LABELS — the same `RosterChrome` / `RosterLabels` seams the live
 *     roster uses, with the same working defaults.
 *   · ROW ACTIVATION — `onRowActivate(row)` is host-owned: the operator opens
 *     its transcript inspector, the portal opens the agent's conversation by
 *     `coordOwnerId`. `isOpenable(row)` is the host's predicate for whether a
 *     row can be activated at all (the operator: does a transcript URL
 *     resolve; the portal: is there an owner id). A row that is not openable
 *     renders inert with a title saying so — never a dead click.
 *
 * Paging: a bottom sentinel inside the section's own scroll container, an
 * IntersectionObserver that fires loadMore while `hasMore`, and a synchronous
 * reentry lock — the ChatConversation.tsx pattern the operator already used.
 * Deliberately NO user-scroll gate: when the first page does not fill the
 * container the observer SHOULD keep paging until it does.
 */
import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { fmtCompactAge } from './logic';
import { agentGlyph } from './glyphs';
import { defaultRosterChrome, identityRosterLabels, type RosterChrome, type RosterLabels } from './seams';
import { appendEndedPage, endedDisplayName, visibleEndedRows, type EndedSessionRow, type EndedSessionsPage } from './sessions';

export interface InactiveSessionsSectionProps {
  /** Owner ids currently shown as RUNNING — their ended rows are older terminals
   *  of a live agent and are elided (see `visibleEndedRows`). */
  activeOwnerIds: ReadonlySet<string>;
  /** A clock the host ticks so the ended-ago pills stay current. */
  nowMs: number;
  /** Deep-link focus: when set, auto-expand and show ONLY this owner's ended
   *  sessions — their session history. */
  focusOwnerId?: string | null;
  /** Controlled expand/collapse state. */
  expanded: boolean;
  onExpandedChange: (next: boolean) => void;
  /**
   * The host's page loader. `before` is the cursor the previous page returned
   * (`nextBefore`), or null for the first page. A THROW marks the section
   * errored ("Couldn't load inactive sessions.") and stops paging.
   */
  loadPage: (before: string | null) => Promise<EndedSessionsPage>;
  /** Whether a row can be activated. Default: every row with a coord owner id. */
  isOpenable?: (row: EndedSessionRow) => boolean;
  /** Host-owned row activation — runs only for rows `isOpenable` admits. Omit
   *  to render a read-only list. */
  onRowActivate?: (row: EndedSessionRow) => void;
  /** The host's presentational primitives. Defaults render correctly unstyled. */
  chrome?: RosterChrome;
  /** The host's vocabulary. Defaults leave every word exactly as stored. */
  labels?: RosterLabels;
  /** Title for an inert row. Default names the missing transcript handle, which
   *  is the operator's reason; a host with a different reason passes its own. */
  unopenableTitle?: string;
}

const defaultIsOpenable = (row: EndedSessionRow): boolean => Boolean(row.coordOwnerId);

export function InactiveSessionsSection({
  activeOwnerIds,
  nowMs,
  focusOwnerId = null,
  expanded,
  onExpandedChange,
  loadPage,
  isOpenable = defaultIsOpenable,
  onRowActivate,
  chrome = defaultRosterChrome,
  labels = identityRosterLabels,
  unopenableTitle = 'No transcript handle recorded for this session',
}: InactiveSessionsSectionProps): JSX.Element {
  const { LivenessDot } = chrome;
  // A focus deep-link means "show me this agent's history" — expand for it.
  useEffect(() => {
    if (focusOwnerId) onExpandedChange(true);
    // The host's setter identity may change per render (a nuqs setter does);
    // the intent is "once per focus value".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusOwnerId]);

  const [rows, setRows] = useState<EndedSessionRow[]>([]);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const nextBeforeRef = useRef<string | null>(null);
  const fetchInFlightRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  const loadMore = useCallback(async () => {
    if (fetchInFlightRef.current) return;
    fetchInFlightRef.current = true;
    setLoading(true);
    try {
      const page = await loadPage(nextBeforeRef.current);
      nextBeforeRef.current = page.nextBefore ?? null;
      setHasMore(Boolean(page.hasMore));
      setRows((prev) => appendEndedPage(prev, page.sessions ?? []));
    } catch {
      setError(true);
      setHasMore(false);
    } finally {
      fetchInFlightRef.current = false;
      setLoading(false);
    }
  }, [loadPage]);

  // First page on expand.
  useEffect(() => {
    if (expanded && rows.length === 0 && !error) void loadMore();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded]);

  // Infinite scroll: bottom sentinel + reentry lock.
  useEffect(() => {
    if (!expanded) return;
    const el = sentinelRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const obs = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        if (!hasMore) continue;
        if (fetchInFlightRef.current) continue;
        void loadMore();
      }
    }, { root: scrollRef.current ?? null, rootMargin: '0px 0px 120px 0px' });
    obs.observe(el);
    return () => obs.disconnect();
  }, [expanded, hasMore, loadMore]);

  const visible = visibleEndedRows(rows, activeOwnerIds, focusOwnerId);
  const activate = (r: EndedSessionRow) => {
    if (onRowActivate && isOpenable(r)) onRowActivate(r);
  };

  return (
    <div className="pc-agents-sessions__inactive" data-testid="inactive-sessions-section">
      <button
        type="button"
        className="pc-agents-sessions__toggle"
        data-testid="inactive-sessions-toggle"
        aria-expanded={expanded}
        onClick={() => onExpandedChange(!expanded)}
      >
        <span aria-hidden>{expanded ? '▾' : '▸'}</span> View inactive sessions
        {expanded && visible.length > 0 ? (
          <span className="pc-agents-roster__group-count" data-testid="inactive-sessions-count">
            ({visible.length}{hasMore ? '+' : ''})
          </span>
        ) : null}
        <span className="pc-agents-sessions__toggle-hint">every past session, newest first</span>
      </button>
      {expanded && (
        <div className="pc-agents-sessions__scroll pc-agents-sessions__inactive-list" ref={scrollRef} data-testid="inactive-sessions-list">
          {visible.map((r) => {
            const openable = Boolean(onRowActivate) && isOpenable(r);
            const endedAgo = r.endedAt ? fmtCompactAge(r.endedAt, nowMs) : '';
            return (
              <div
                key={r.id}
                className={`pc-agents-roster__row pc-agents-roster__row--nocheck${openable ? '' : ' is-unopenable'}`}
                data-testid={`inactive-session-${r.id}`}
                role={openable ? 'button' : undefined}
                tabIndex={openable ? 0 : undefined}
                title={openable ? 'Open session' : unopenableTitle}
                onClick={() => activate(r)}
                onKeyDown={(e) => {
                  if ((e.key === 'Enter' || e.key === ' ') && openable) { e.preventDefault(); activate(r); }
                }}
              >
                <span className="pc-agents-roster__live">
                  {/* Ended sessions get the SAME leading status dot as the active
                      roster rows (a muted grey 'stale' dot = offline/ended), so the
                      inactive list reads as a peer of the active-sessions section
                      instead of a bare age-only column (owner ask 2026-07-12). */}
                  <LivenessDot liveness="stale" size={7} title={endedAgo ? `ended ${endedAgo} ago` : 'ended session'} />
                  {endedAgo ? (
                    <span className="pc-agents-roster__age" title={`ended ${endedAgo} ago`}>{endedAgo}</span>
                  ) : null}
                </span>
                <span className="pc-agents-roster__glyph" aria-hidden>
                  {agentGlyph({ agentPaneKind: null, role: r.role })}
                </span>
                <span className="pc-agents-roster__name" title={`${r.coordOwnerId ?? ''}${r.agent ? ` · ${r.agent}` : ''}`}>
                  {endedDisplayName(r, labels.agentLabel)}
                </span>
                <span className="pc-agents-roster__doing">
                  {r.feature ? <span className="pc-agents-roster__feat">{r.feature}</span> : null}
                  {[r.planSlug, r.agent].filter(Boolean).join(' · ') || '—'}
                </span>
              </div>
            );
          })}
          {loading && <div className="pc-agents-sessions__status">Loading…</div>}
          {error && <div className="pc-agents-sessions__status is-error">Couldn’t load inactive sessions.</div>}
          {!hasMore && !loading && !error && visible.length === 0 && (
            <div className="pc-agents-sessions__status">No inactive sessions.</div>
          )}
          {/* The infinite-scroll sentinel — observed while more pages remain. */}
          <div ref={sentinelRef} data-testid="inactive-sessions-sentinel" style={{ height: 1 }} />
        </div>
      )}
    </div>
  );
}
