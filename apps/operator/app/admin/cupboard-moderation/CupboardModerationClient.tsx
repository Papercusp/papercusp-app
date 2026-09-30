'use client';

/**
 * CupboardModerationClient — operator moderation UI for the Cupboard registry
 * (Phase 9 D-002). Renders the abuse-report queue and lets a Cupboard operator
 * dismiss a report or take a listing down.
 *
 * Self-fetching (the admin-route pattern, like DbosClient): it hits the
 * operator's `/api/cupboard/admin/*` proxy, which forwards to the Cupboard
 * worker with the maintainer's gh-token added server-side. So this component
 * is framework-neutral — the operator-vite route at /admin/cupboard-moderation
 * consumes it via the `@/app` alias, the same way InsightsTab is mounted.
 *
 * Auth failures surface inline: 401 gh_auth_required (no gh login) and 403
 * (this account isn't in the worker's CUPBOARD_OPERATOR_GITHUB_IDS allowlist).
 */

import React, { useCallback, useEffect, useState } from 'react';
import { useQueryState, parseAsStringLiteral } from 'nuqs';
import { toast } from 'sonner';
import { Flag, ExternalLink, RefreshCw, Shield, PackageOpen } from 'lucide-react';
import { useLexicon } from '@/lib/useLexicon';
import { appPlatformFamilies } from '../../cupboard/app-download';

const STATUS_FILTERS = ['pending', 'resolved_unlist', 'resolved_dismiss', 'all'] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];

interface ReportRow {
  id: string;
  harness_id: string;
  reporter_github_login: string;
  reporter_github_user_id: number;
  reason: string;
  status: 'pending' | 'resolved_unlist' | 'resolved_dismiss';
  resolved_at: number | null;
  resolved_by_operator_note: string | null;
  created_at: number;
  harness_title: string | null;
  harness_github_url: string | null;
  harness_unlisted_at: number | null;
}

/** Format an epoch-ms timestamp, or an em-dash for null/0. Exported for tests. */
export function fmtTime(ms: number | null): string {
  if (!ms) return '—';
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return String(ms);
  }
}

/** Only render http(s) URLs as links — blocks `javascript:`/`data:` href XSS from registry data. Exported for tests. */
export function safeHttpUrl(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch {
    return null;
  }
}

const STATUS_LABEL: Record<ReportRow['status'], string> = {
  pending: 'Pending',
  resolved_unlist: 'Unlisted',
  resolved_dismiss: 'Dismissed',
};

interface PendingRow {
  id: string;
  listing_kind: string;
  listing_ref: string | null;
  title: string;
  description: string | null;
  github_url: string;
  publisher_github_login: string;
  created_at: number;
  // app-kind provenance (cupboard-app-distribution-2026-07-14 P-006). An `app`
  // distributes a RUNNABLE INSTALLER — the highest-trust listing kind — so the
  // moderator must review WHERE the binary comes from (the release repo + the
  // signed latest.json), not only the source repo. The worker's `/admin/pending`
  // returns the raw row (SELECT *), so these ride along for app rows and are
  // absent/null on every other kind.
  delivery_type?: string | null;
  release_repo?: string | null;
  latest_json_url?: string | null;
  platforms?: string | null;
}

/**
 * Pre-publication review queue (learning-packs-2026-06-11 P-020, D-007;
 * app kind added by cupboard-app-distribution-2026-07-14 P-006): policy-kind
 * listings (knowledge-pack, blueprint, app) awaiting an operator decision. Only
 * allowlisted operators reach this — the worker 403s everyone else.
 *
 * Review the right thing before approving:
 *   - knowledge-pack / blueprint carry INSTRUCTIONS injected into agents — read
 *     the repo content.
 *   - an `app` carries a RUNNABLE INSTALLER (highest trust) — verify the release
 *     provenance (release repo + the signed latest.json) that the app-trust block
 *     surfaces, connecting the moderator authority of P-012 to executables.
 */
function PendingReviewQueue() {
  const [pending, setPending] = useState<PendingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [reasons, setReasons] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/cupboard/admin/pending');
      const data = (await res.json().catch(() => ({}))) as { pending?: PendingRow[]; error?: string };
      if (!res.ok) {
        setError(
          res.status === 401
            ? 'GitHub sign-in required — the operator needs a `gh auth login` token to moderate.'
            : res.status === 403
              ? 'This GitHub account is not a Cupboard operator (not in CUPBOARD_OPERATOR_GITHUB_IDS).'
              : data.error ?? `HTTP ${res.status}`,
        );
        setPending([]);
        return;
      }
      setPending(data.pending ?? []);
    } catch (e) {
      setError(String(e));
      setPending([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const decide = useCallback(
    async (id: string, decision: 'approve' | 'reject') => {
      setBusyId(id);
      try {
        const res = await fetch(`/api/cupboard/admin/listings/${encodeURIComponent(id)}/review`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ decision, reason: reasons[id]?.trim() || undefined }),
        });
        if (!res.ok) {
          const b = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(b.error ?? `HTTP ${res.status}`);
        }
        toast.success(decision === 'approve' ? 'Listing approved — now publicly visible' : 'Listing rejected');
        setReasons((m) => {
          const next = { ...m };
          delete next[id];
          return next;
        });
        void load();
      } catch (e) {
        toast.error(`Review failed: ${String(e)}`);
      } finally {
        setBusyId(null);
      }
    },
    [load, reasons],
  );

  return (
    <div className="pc-cbmod__pendingwrap">
      <div className="pc-cbmod__bar">
        <span className="pc-cbmod__title">
          <Shield size={15} aria-hidden /> Pending review
          <span className="pc-cbmod__count">{loading ? '…' : pending.length}</span>
        </span>
        <button type="button" className="pc-cbmod__refresh" onClick={() => void load()} aria-label="Refresh pending queue">
          <RefreshCw size={14} aria-hidden />
        </button>
      </div>
      {loading ? (
        <div className="pc-cbmod__msg">Loading…</div>
      ) : error ? (
        <div className="pc-cbmod__msg pc-cbmod__msg--err">{error}</div>
      ) : pending.length === 0 ? (
        <div className="pc-cbmod__msg">No listings awaiting review.</div>
      ) : (
        <div className="pc-cbmod__list" style={{ flex: 'none' }}>
          {pending.map((p) => {
            const repoUrl = safeHttpUrl(p.github_url);
            const isApp = p.listing_kind === 'app';
            // An app's trust surface is its RELEASE, not its source repo: the
            // signed latest.json + the release repo the installers come from.
            const releaseReleasesUrl = isApp && p.release_repo
              ? safeHttpUrl(`https://github.com/${p.release_repo}/releases`)
              : null;
            const latestJsonUrl = isApp ? safeHttpUrl(p.latest_json_url ?? null) : null;
            const appFamilies = isApp ? appPlatformFamilies(p.platforms) : [];
            return (
              <div key={p.id} className="pc-cbmod__card" data-testid="pending-review-card">
                <div className="pc-cbmod__cardhead">
                  <span className="pc-cbmod__status pc-cbmod__status--pending">{p.listing_kind}</span>
                  <span className="pc-cbmod__harness">{p.title}</span>
                  {p.listing_ref && <code style={{ fontSize: 11 }}>{p.listing_ref}</code>}
                  {repoUrl && (
                    <a className="pc-cbmod__gh" href={repoUrl} target="_blank" rel="noreferrer">
                      <ExternalLink size={12} aria-hidden /> {isApp ? 'source repo' : 'review the content'}
                    </a>
                  )}
                </div>
                {p.description && <div className="pc-cbmod__reason">{p.description}</div>}
                {isApp && (
                  // The executable-provenance block (P-006 → P-012): what a
                  // moderator vouches for when they approve a runnable installer.
                  <div className="pc-cbmod__apptrust" data-testid="pending-review-app-trust">
                    <div className="pc-cbmod__apptrust-warn">
                      <PackageOpen size={12} aria-hidden /> Runnable installer — the highest-trust kind. Verify the
                      release provenance below before approving.
                    </div>
                    <div className="pc-cbmod__apptrust-row">
                      <span className="pc-cbmod__apptrust-k">Delivery</span>
                      <code>{p.delivery_type ?? 'standalone'}</code>
                    </div>
                    {releaseReleasesUrl && (
                      <div className="pc-cbmod__apptrust-row">
                        <span className="pc-cbmod__apptrust-k">Release repo</span>
                        <a
                          className="pc-cbmod__gh"
                          href={releaseReleasesUrl}
                          target="_blank"
                          rel="noreferrer"
                          data-testid="pending-review-app-release"
                        >
                          <ExternalLink size={12} aria-hidden /> {p.release_repo} releases
                        </a>
                      </div>
                    )}
                    {latestJsonUrl && (
                      <div className="pc-cbmod__apptrust-row">
                        <span className="pc-cbmod__apptrust-k">Update manifest</span>
                        <a
                          className="pc-cbmod__gh"
                          href={latestJsonUrl}
                          target="_blank"
                          rel="noreferrer"
                          data-testid="pending-review-app-manifest"
                        >
                          <ExternalLink size={12} aria-hidden /> signed latest.json
                        </a>
                      </div>
                    )}
                    {appFamilies.length > 0 && (
                      <div className="pc-cbmod__apptrust-row">
                        <span className="pc-cbmod__apptrust-k">Platforms</span>
                        <span>{appFamilies.join(', ')}</span>
                      </div>
                    )}
                  </div>
                )}
                <div className="pc-cbmod__meta">
                  submitted by <strong>@{p.publisher_github_login}</strong> · {fmtTime(p.created_at)} ·{' '}
                  {isApp
                    ? 'a runnable installer — verify its release provenance before approving'
                    : 'this kind is injected into agents — read it before approving'}
                </div>
                <div className="pc-cbmod__resolve">
                  <input
                    type="text"
                    className="pc-cbmod__note"
                    placeholder="Reason (recorded; shown to the submitter on rejection)…"
                    value={reasons[p.id] ?? ''}
                    maxLength={1000}
                    disabled={busyId === p.id}
                    onChange={(e) => setReasons((m) => ({ ...m, [p.id]: e.target.value }))}
                  />
                  <div className="pc-cbmod__actions">
                    <button
                      type="button"
                      className="pc-cbmod__btn pc-cbmod__btn--unlist"
                      disabled={busyId === p.id}
                      onClick={() => void decide(p.id, 'reject')}
                    >
                      Reject
                    </button>
                    <button
                      type="button"
                      className="pc-cbmod__btn pc-cbmod__btn--approve"
                      disabled={busyId === p.id}
                      onClick={() => void decide(p.id, 'approve')}
                    >
                      Approve
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function CupboardModerationClient() {
  const t = useLexicon();
  const [filter, setFilter] = useQueryState(
    'cb_status',
    parseAsStringLiteral(STATUS_FILTERS).withDefault('pending'),
  );
  const [reports, setReports] = useState<ReportRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // Per-report operator note draft (mid-edit text → useState, not nuqs).
  const [notes, setNotes] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/cupboard/admin/reports?status=${encodeURIComponent(filter)}`);
      const data = (await res.json().catch(() => ({}))) as {
        reports?: ReportRow[];
        error?: string;
        reason?: string;
      };
      if (!res.ok) {
        if (res.status === 401) {
          setError('GitHub sign-in required — the operator needs a `gh auth login` token to moderate.');
        } else if (res.status === 403) {
          setError('This GitHub account is not a Cupboard operator (not in CUPBOARD_OPERATOR_GITHUB_IDS).');
        } else {
          setError(data.error ?? `HTTP ${res.status}`);
        }
        setReports([]);
        return;
      }
      setReports(data.reports ?? []);
    } catch (e) {
      setError(String(e));
      setReports([]);
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    void load();
  }, [load]);

  const resolve = useCallback(
    async (id: string, action: 'unlist' | 'dismiss', note?: string) => {
      setBusyId(id);
      try {
        const res = await fetch(`/api/cupboard/admin/reports/${encodeURIComponent(id)}/resolve`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action, note: note?.trim() || undefined }),
        });
        if (!res.ok) {
          const b = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(b.error ?? `HTTP ${res.status}`);
        }
        toast.success(action === 'unlist' ? 'Report resolved — listing taken down' : 'Report dismissed');
        setNotes((m) => {
          const next = { ...m };
          delete next[id];
          return next;
        });
        void load();
      } catch (e) {
        toast.error(`Action failed: ${String(e)}`);
      } finally {
        setBusyId(null);
      }
    },
    [load],
  );

  return (
    <div className="pc-cbmod">
      {/* knowledge-packs P-020: the pre-publication approval queue renders
          ABOVE the abuse reports — proactive review before reactive. */}
      <PendingReviewQueue />

      <div className="pc-cbmod__bar">
        <span className="pc-cbmod__title">
          <Flag size={15} aria-hidden /> Abuse reports
        </span>
        <div className="pc-cbmod__filters" role="tablist" aria-label="Report status filter">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              role="tab"
              aria-selected={filter === f}
              className={`pc-cbmod__chip${filter === f ? ' is-active' : ''}`}
              onClick={() => void setFilter(f)}
            >
              {f === 'all' ? 'all' : STATUS_LABEL[f as ReportRow['status']]}
            </button>
          ))}
        </div>
        <button type="button" className="pc-cbmod__refresh" onClick={() => void load()} aria-label="Refresh">
          <RefreshCw size={14} aria-hidden />
        </button>
      </div>

      <div className="pc-cbmod__list">
        {loading ? (
          <div className="pc-cbmod__msg">Loading…</div>
        ) : error ? (
          <div className="pc-cbmod__msg pc-cbmod__msg--err">{error}</div>
        ) : reports.length === 0 ? (
          <div className="pc-cbmod__msg">
            {filter === 'pending' ? 'No pending reports — nothing to moderate.' : 'No reports match this filter.'}
          </div>
        ) : (
          reports.map((r) => {
            const repoUrl = safeHttpUrl(r.harness_github_url);
            return (
            <div key={r.id} className="pc-cbmod__card">
              <div className="pc-cbmod__cardhead">
                <Flag size={13} aria-hidden className="pc-cbmod__flag" />
                <span className="pc-cbmod__harness">{r.harness_title ?? r.harness_id}</span>
                {repoUrl && (
                  <a className="pc-cbmod__gh" href={repoUrl} target="_blank" rel="noreferrer">
                    <ExternalLink size={12} aria-hidden /> repo
                  </a>
                )}
                <span className={`pc-cbmod__status pc-cbmod__status--${r.status}`}>{STATUS_LABEL[r.status]}</span>
                {r.harness_unlisted_at && <span className="pc-cbmod__taken">listing down</span>}
              </div>
              <div className="pc-cbmod__reason">{r.reason}</div>
              <div className="pc-cbmod__meta">
                reported by <strong>@{r.reporter_github_login}</strong> · {fmtTime(r.created_at)}
                {r.status !== 'pending' && (
                  <> · resolved {fmtTime(r.resolved_at)}{r.resolved_by_operator_note ? ` — “${r.resolved_by_operator_note}”` : ''}</>
                )}
              </div>
              {r.status === 'pending' && (
                <div className="pc-cbmod__resolve">
                  <input
                    type="text"
                    className="pc-cbmod__note"
                    placeholder="Optional note (recorded on the report)…"
                    value={notes[r.id] ?? ''}
                    maxLength={1000}
                    disabled={busyId === r.id}
                    onChange={(e) => setNotes((m) => ({ ...m, [r.id]: e.target.value }))}
                  />
                  <div className="pc-cbmod__actions">
                    <button
                      type="button"
                      className="pc-cbmod__btn pc-cbmod__btn--dismiss"
                      disabled={busyId === r.id}
                      onClick={() => void resolve(r.id, 'dismiss', notes[r.id])}
                    >
                      Dismiss
                    </button>
                    <button
                      type="button"
                      className="pc-cbmod__btn pc-cbmod__btn--unlist"
                      disabled={busyId === r.id}
                      onClick={() => void resolve(r.id, 'unlist', notes[r.id])}
                    >
                      Unlist {t('pot')}
                    </button>
                  </div>
                </div>
              )}
            </div>
            );
          })
        )}
      </div>

      <style>{`
        .pc-cbmod { display: flex; flex-direction: column; height: 100%; min-height: 0; }
        .pc-cbmod__bar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; padding: 8px 4px 12px; }
        .pc-cbmod__title { display: inline-flex; align-items: center; gap: 7px; font-size: 14px; font-weight: 700; color: var(--fg, #e7f7ff); }
        .pc-cbmod__title svg { color: var(--accent, #38bdf8); }
        .pc-cbmod__filters { display: inline-flex; gap: 5px; flex-wrap: wrap; }
        .pc-cbmod__chip { font-size: 11px; padding: 3px 10px; border-radius: 999px; border: 1px solid color-mix(in oklab, var(--accent, #38bdf8), transparent 78%); background: transparent; color: var(--fg-mute, #7f9bb4); cursor: pointer; text-transform: capitalize; }
        .pc-cbmod__chip:hover { color: var(--fg, #e7f7ff); }
        .pc-cbmod__chip.is-active { color: var(--fg, #e7f7ff); background: color-mix(in oklab, var(--accent, #38bdf8), transparent 80%); border-color: color-mix(in oklab, var(--accent, #38bdf8), transparent 40%); }
        .pc-cbmod__refresh { margin-left: auto; display: inline-flex; align-items: center; padding: 5px; color: var(--fg-mute, #7f9bb4); background: transparent; border: 0; border-radius: 4px; cursor: pointer; }
        .pc-cbmod__refresh:hover { color: var(--fg, #e7f7ff); }
        .pc-cbmod__list { flex: 1; min-height: 0; overflow: auto; display: grid; gap: 10px; align-content: start; }
        .pc-cbmod__msg { color: var(--fg-mute, #7f9bb4); font-size: 13px; padding: 24px; text-align: center; }
        .pc-cbmod__msg--err { color: var(--bad, #f87171); }
        .pc-cbmod__card { border: 1px solid var(--border, rgba(125,211,252,0.15)); border-radius: 8px; padding: 12px 14px; background: var(--bg-1, rgba(255,255,255,0.02)); }
        .pc-cbmod__cardhead { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
        .pc-cbmod__flag { color: var(--bad, #f87171); }
        .pc-cbmod__harness { font-weight: 700; color: var(--fg, #e7f7ff); }
        .pc-cbmod__gh { display: inline-flex; align-items: center; gap: 3px; font-size: 11px; color: var(--accent, #38bdf8); text-decoration: none; }
        .pc-cbmod__gh:hover { text-decoration: underline; }
        .pc-cbmod__status { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0; padding: 1px 7px; border-radius: 999px; }
        .pc-cbmod__status--pending { color: #f59e0b; background: color-mix(in oklab, #f59e0b, transparent 84%); }
        .pc-cbmod__status--resolved_unlist { color: #f87171; background: color-mix(in oklab, #f87171, transparent 84%); }
        .pc-cbmod__status--resolved_dismiss { color: #22c55e; background: color-mix(in oklab, #22c55e, transparent 84%); }
        .pc-cbmod__taken { font-size: 10px; font-weight: 600; color: var(--bad, #f87171); }
        .pc-cbmod__reason { margin: 8px 0 6px; font-size: 13px; color: var(--fg, #e7f7ff); white-space: pre-wrap; }
        .pc-cbmod__meta { font-size: 11px; color: var(--fg-mute, #7f9bb4); }
        .pc-cbmod__resolve { margin-top: 10px; display: flex; flex-direction: column; gap: 8px; }
        .pc-cbmod__note { width: 100%; box-sizing: border-box; font-size: 12px; padding: 5px 9px; border-radius: 6px; border: 1px solid var(--border, rgba(125,211,252,0.2)); background: var(--bg-2, rgba(0,0,0,0.2)); color: var(--fg, #e7f7ff); }
        .pc-cbmod__note::placeholder { color: var(--fg-mute, #7f9bb4); }
        .pc-cbmod__note:disabled { opacity: 0.5; }
        .pc-cbmod__actions { display: flex; gap: 8px; }
        .pc-cbmod__btn { font-size: 12px; font-weight: 600; padding: 5px 12px; border-radius: 6px; cursor: pointer; border: 1px solid transparent; }
        .pc-cbmod__btn:disabled { opacity: 0.5; cursor: default; }
        .pc-cbmod__btn--dismiss { background: transparent; color: var(--fg-mute, #7f9bb4); border-color: var(--border, rgba(125,211,252,0.2)); }
        .pc-cbmod__btn--dismiss:hover:not(:disabled) { color: var(--fg, #e7f7ff); }
        .pc-cbmod__btn--unlist { background: color-mix(in oklab, #f87171, transparent 86%); color: #f87171; border-color: color-mix(in oklab, #f87171, transparent 55%); }
        .pc-cbmod__btn--unlist:hover:not(:disabled) { background: color-mix(in oklab, #f87171, transparent 75%); }
        .pc-cbmod__btn--approve { background: color-mix(in oklab, #22c55e, transparent 86%); color: #22c55e; border-color: color-mix(in oklab, #22c55e, transparent 55%); }
        .pc-cbmod__btn--approve:hover:not(:disabled) { background: color-mix(in oklab, #22c55e, transparent 75%); }
        .pc-cbmod__apptrust { margin: 8px 0 6px; padding: 8px 10px; border-radius: 6px; border: 1px solid color-mix(in oklab, #f59e0b, transparent 62%); background: color-mix(in oklab, #f59e0b, transparent 92%); display: grid; gap: 5px; }
        .pc-cbmod__apptrust-warn { display: inline-flex; align-items: center; gap: 5px; font-size: 11.5px; font-weight: 700; color: #f59e0b; }
        .pc-cbmod__apptrust-row { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--fg, #e7f7ff); flex-wrap: wrap; }
        .pc-cbmod__apptrust-k { min-width: 92px; font-size: 10px; text-transform: uppercase; letter-spacing: 0; color: var(--fg-mute, #7f9bb4); }
        .pc-cbmod__pendingwrap { margin-bottom: 18px; }
        .pc-cbmod__count { font-size: 11px; font-weight: 700; padding: 1px 8px; border-radius: 999px; background: color-mix(in oklab, #f59e0b, transparent 84%); color: #f59e0b; }
      `}</style>
    </div>
  );
}
