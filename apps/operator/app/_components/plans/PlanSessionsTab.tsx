'use client';

/**
 * PlanSessionsTab (owner-plans-single-pane-2026-07-17 P-005/P-006) — the plan
 * popup's Sessions tab: every agent session that touched THIS plan, plus a
 * plan-scoped transcript search, plus "continue" affordances.
 *
 * REUSE, not re-derivation:
 *   - the session list: the `planSessions.list` sync query (P-004), which is
 *     SSE-invalidated by any adv_sessions write, so a new/ended session
 *     refreshes the tab live;
 *   - search: the EXISTING GET /api/adv/sessions/search-transcripts route with
 *     `?plan=<slug>` scope (P-006) — the shared @papercusp/search engine, no
 *     new searcher;
 *   - viewing a session: SessionChatModal (owner-inbox P-007/P-008) — the
 *     chat-grade popup, not the raw AgentInspectorModal timeline.
 *
 * Continue: a live session row IS the "keep going with that agent" affordance
 * (click → chat with it); the header's "Launch agent on this plan" starts a
 * fresh agent bound to the plan (launchAgent { planSlug }). No new server
 * kickoff kind — a plan-bound plain launch is the natural continue.
 *
 * Search state is nuqs (`?ppq`) so the tab is deep-linkable + agent-driveable.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { parseAsString, useQueryState } from 'nuqs';
import { toast } from 'sonner';
import { launchAgent } from '@papercusp/operator-core/lib/launch-agent';
import { useSyncQuery } from '@papercusp/sync';
import { Tooltip } from '@/app/harness/Tooltip';
import { useWorkspaceId } from '@/lib/use-workspace-id';
import { hitDisplayHtml } from '@/lib/search-highlight';
import { useDebouncedValue } from '@/app/harness/picker-kit';
import SessionChatModal from '../chat/SessionChatModal';
import { agoLabel } from './PlansPane';

/** One row of the `planSessions.list` sync query (mirrors PlanSessionRow). */
interface PlanSessionRow {
  coordOwnerId: string;
  sessionId: string | null;
  ompThreadId: string | null;
  agent: string | null;
  mode: 'omp' | 'console';
  role: string | null;
  label: string | null;
  startedAt: string;
  endedAt: string | null;
  live: boolean;
  via: 'plan' | 'claim';
}

/** The /adv/sessions/search-transcripts response shapes this tab reads (mirror
 *  of the operator-vite AgentsPillSessions types — that tree can't be imported
 *  here). ownerId = active?.ownerId ?? session?.coordOwnerId. */
interface SearchTurnHit {
  turnIdx: number;
  ts?: string | null;
  excerpt: string;
  highlight: string;
  score: number;
}
interface SearchSessionResult {
  sourceKind: string;
  sessionId: string;
  topScore: number;
  hits: SearchTurnHit[];
  active: { ownerId?: string | null; label?: string | null } | null;
  session: { coordOwnerId?: string | null; label?: string | null } | null;
}

function hitOwnerId(s: SearchSessionResult): string | null {
  return s.active?.ownerId ?? s.session?.coordOwnerId ?? null;
}
function sessionLabel(row: PlanSessionRow): string {
  return row.label?.trim() || row.agent || row.role || row.coordOwnerId.slice(0, 12);
}

export default function PlanSessionsTab({
  planSlug,
  harnessSlug,
}: {
  planSlug: string;
  harnessSlug: string | null;
}) {
  const workspaceId = useWorkspaceId();
  const [rawQuery, setRawQuery] = useQueryState('ppq', parseAsString.withDefault(''));
  const query = useDebouncedValue(rawQuery, 300);
  const [openOwner, setOpenOwner] = useState<{ id: string; label: string | null } | null>(null);
  const [launching, setLaunching] = useState(false);

  const sessions = useSyncQuery<PlanSessionRow>({
    queryName: 'planSessions.list',
    args: useMemo(() => ({ planSlug, workspaceId: workspaceId ?? null }), [planSlug, workspaceId]),
  });
  const sessionRows = sessions.data ?? [];

  // ── Plan-scoped transcript search (P-006) ────────────────────────────────
  const [searchHits, setSearchHits] = useState<SearchSessionResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const searchSeq = useRef(0);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setSearchHits(null);
      setSearchError(null);
      setSearching(false);
      return;
    }
    const seq = ++searchSeq.current;
    const ctl = new AbortController();
    setSearching(true);
    setSearchError(null);
    (async () => {
      try {
        const r = await fetch(
          `/api/adv/sessions/search-transcripts?q=${encodeURIComponent(q)}&plan=${encodeURIComponent(planSlug)}&limit=30`,
          { signal: ctl.signal },
        );
        const body = (await r.json()) as { ok?: boolean; sessions?: SearchSessionResult[]; error?: string };
        if (seq !== searchSeq.current) return; // a newer query superseded this
        if (!r.ok || body.ok === false) {
          setSearchError(body.error ?? `search failed (${r.status})`);
          setSearchHits([]);
        } else {
          setSearchHits(body.sessions ?? []);
        }
      } catch (e) {
        if (ctl.signal.aborted || seq !== searchSeq.current) return;
        setSearchError(e instanceof Error ? e.message : 'search failed');
        setSearchHits([]);
      } finally {
        if (seq === searchSeq.current) setSearching(false);
      }
    })();
    return () => ctl.abort();
  }, [query, planSlug]);

  const onLaunch = useCallback(async () => {
    if (launching) return;
    setLaunching(true);
    try {
      const result = await launchAgent({
        slug: harnessSlug ?? null,
        planSlug,
        label: `plan · ${planSlug}`,
      });
      if (result.ok) {
        toast.success('Agent launching on this plan — it will appear here once it registers.', { duration: 3500 });
      } else if (result.installCmd) {
        toast.error(`${result.error ?? 'Launch prerequisites missing.'} Run: ${result.installCmd}`);
      } else {
        toast.error(`Launch failed: ${result.error ?? 'unknown error'}`);
      }
    } finally {
      setLaunching(false);
    }
  }, [launching, harnessSlug, planSlug]);

  const isSearching = query.trim().length >= 2;

  return (
    <div className="plan-sessions" data-testid="plan-sessions-tab">
      <div className="plan-sessions__bar">
        <input
          type="search"
          className="plan-sessions__search"
          placeholder="Search this plan's agent sessions…"
          value={rawQuery}
          onChange={(e) => void setRawQuery(e.target.value || null)}
          aria-label="Search plan sessions"
          data-testid="plan-sessions-search"
        />
        <Tooltip label="Launch a fresh agent session bound to this plan">
          <button
            type="button"
            className="plan-sessions__launch"
            onClick={onLaunch}
            disabled={launching}
            data-testid="plan-sessions-launch"
          >
            {launching ? 'Launching…' : '＋ Launch agent'}
          </button>
        </Tooltip>
      </div>

      {isSearching ? (
        <div className="plan-sessions__results" aria-label="Search results">
          {searching && !searchHits ? (
            <div className="plan-sessions__empty">Searching…</div>
          ) : searchError ? (
            <div className="plan-sessions__empty plan-sessions__empty--error">{searchError}</div>
          ) : (searchHits ?? []).length === 0 ? (
            <div className="plan-sessions__empty">No matching turns in this plan's sessions.</div>
          ) : (
            <ul className="plan-sessions__list">
              {(searchHits ?? []).map((s) => {
                const owner = hitOwnerId(s);
                const label = s.active?.label ?? s.session?.label ?? owner ?? s.sessionId.slice(0, 12);
                return (
                  <li key={`${s.sourceKind}:${s.sessionId}`}>
                    <Tooltip label={owner ? 'Open this session' : 'No resolvable live/recorded owner for this transcript'}>
                      <button
                        type="button"
                        className="plan-sessions__row plan-sessions__row--hit"
                        disabled={!owner}
                        onClick={() => owner && setOpenOwner({ id: owner, label })}
                        data-testid="plan-sessions-hit"
                      >
                        <span className="plan-sessions__row-title">
                          {s.active ? <span className="plan-sessions__live-dot" aria-label="live">●</span> : null}
                          {label}
                        </span>
                        {s.hits.slice(0, 2).map((h) => (
                          <span
                            key={h.turnIdx}
                            className="plan-sessions__excerpt"
                            // The ENGINE is trusted; the TRANSCRIPT it quotes is not. A hit is a
                            // slice of an agent turn, and turns routinely contain HTML/JS, so the
                            // headline must be escaped down to its own <mark> tags before it can
                            // touch innerHTML (P-003). The `|| excerpt` fallback is escaped by the
                            // same helper — see `@/lib/search-highlight`.
                            dangerouslySetInnerHTML={{ __html: hitDisplayHtml(h) }}
                          />
                        ))}
                      </button>
                    </Tooltip>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : sessions.loading && sessionRows.length === 0 ? (
        <div className="plan-sessions__empty">Loading sessions…</div>
      ) : sessionRows.length === 0 ? (
        <div className="plan-sessions__empty">
          No agent sessions have touched this plan yet. Use “＋ Launch agent” to start one.
        </div>
      ) : (
        <ul className="plan-sessions__list" aria-label="Plan sessions">
          {sessionRows.map((row) => (
            <li key={row.coordOwnerId}>
              <button
                type="button"
                className="plan-sessions__row"
                onClick={() => setOpenOwner({ id: row.coordOwnerId, label: sessionLabel(row) })}
                data-testid={`plan-sessions-row-${row.coordOwnerId}`}
              >
                <span className="plan-sessions__row-main">
                  <span className="plan-sessions__row-title">
                    {row.live ? (
                      <span className="plan-sessions__live-dot" aria-label="live">●</span>
                    ) : null}
                    {sessionLabel(row)}
                  </span>
                  <span className="plan-sessions__row-sub">
                    {row.agent ? <span className="plan-sessions__tag">{row.agent}</span> : null}
                    {row.role ? <span className="plan-sessions__tag">{row.role}</span> : null}
                    {row.via === 'claim' ? (
                      <span className="plan-sessions__tag plan-sessions__tag--claim" title="Attributed via a plan-item claim (launched without a plan binding)">
                        claimed
                      </span>
                    ) : null}
                  </span>
                </span>
                <span className="plan-sessions__row-ago" title={row.live ? `started ${row.startedAt}` : `ended ${row.endedAt}`}>
                  {row.live ? 'live' : agoLabel(row.endedAt)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <SessionChatModal
        sessionOwnerId={openOwner?.id ?? null}
        ownerLabel={openOwner?.label ?? null}
        onClose={() => setOpenOwner(null)}
      />
    </div>
  );
}
