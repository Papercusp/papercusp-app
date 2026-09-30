'use client';

/**
 * PrsTab — PRs tab for the harness UI (Phase 7 P-043).
 *
 * P-043a: each row shows PR number+title, author, checks, reviews, trust badge.
 * P-043b: action buttons — Open on GitHub (always), Approve, Approve+merge.
 * P-043c: filter chips — all, mine, awaiting-me, approved, merged.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useQueryState, parseAsStringLiteral, parseAsBoolean, parseAsInteger } from 'nuqs';
import { toast } from 'sonner';
import { GitPullRequest, RefreshCw, Settings, Bot, Lock } from 'lucide-react';
import { useSyncQuery } from '@papercusp/sync';
import { groupByHive, type HiveGroupProject } from '../adv/harnesses/harness-pot-groups';
import { computeAutoStatus, type PrAutoStatus } from '@papercusp/operator-core/lib/pr-host/pr-row-data';
import { PrRow, type PrRowData } from './PrRow';
import { PrReviewerSettings } from './PrReviewerSettings';
import { useHarnessClaimStatus } from '../adv/harnesses/useHarnessClaimStatus';
import { useLexicon } from '@/lib/useLexicon';

const PR_FILTERS = ['all', 'mine', 'awaiting-me', 'approved', 'merged'] as const;
type PrFilter = (typeof PR_FILTERS)[number];

/** hive-pr-rollup P-006: list one harness's PRs, or the whole hive's. */
const PR_SCOPES = ['harness', 'hive'] as const;

interface Props {
  harnessSlug: string;
  /** GitHub user id of the current viewer. Omitted (the live dock mount) ⇒
   *  resolved from the pr-reviewer-settings route (P-007). */
  viewerGithubId?: number;
  viewerLogin?: string;
  /** Trust list for the viewer on this harness. Omitted ⇒ resolved. */
  trustedAuthorIds?: ReadonlySet<number>;
  /** Review-gate override. Omitted ⇒ resolved (incl. the D-002 hive-home
   *  inherited role). */
  reviewerRoleEnabled?: boolean;
}

const EMPTY_ID_SET: ReadonlySet<number> = new Set();

/** The slice of the pr-reviewer-settings response the review gate needs. */
interface ReviewGate {
  viewerGithubId?: number;
  trustedAuthorIds: ReadonlySet<number>;
  reviewerRoleEnabled: boolean;
  /** PR-3: harness auto-mode settings (drive the toggle + honest auto-status). */
  autoReview: boolean;
  autoMerge: boolean;
  /** PR-3 §3: may the viewer flip auto-mode (claimed-owner gate, server-authoritative)? */
  autoModeEditable: boolean;
}

async function fetchReviewGate(harnessSlug: string): Promise<ReviewGate | null> {
  const r = await fetch(`/api/harness/${encodeURIComponent(harnessSlug)}/pr-reviewer-settings`);
  if (!r.ok) return null;
  const j = (await r.json().catch(() => null)) as {
    settings?: { pr_reviewer_role_enabled?: boolean; auto_review?: boolean; auto_merge?: boolean };
    trustList?: Array<{ trusted_github_user_id: number }>;
    viewer?: { github_user_id: number } | null;
    autoModeEditable?: boolean;
  } | null;
  if (!j) return null;
  return {
    viewerGithubId: j.viewer?.github_user_id,
    trustedAuthorIds: new Set((j.trustList ?? []).map((t) => t.trusted_github_user_id)),
    reviewerRoleEnabled: !!j.settings?.pr_reviewer_role_enabled,
    autoReview: !!j.settings?.auto_review,
    autoMerge: !!j.settings?.auto_merge,
    autoModeEditable: !!j.autoModeEditable,
  };
}

/** POST an auto-mode change (claimed-owner-gated server-side). */
async function postAutoMode(harnessSlug: string, on: boolean): Promise<void> {
  // ON  → enable the role + both auto levers (the full auto-apply path).
  // OFF → clear the auto levers (leave the personal reviewer role as-is).
  const patch = on
    ? { pr_reviewer_role_enabled: true, auto_review: true, auto_merge: true }
    : { auto_review: false, auto_merge: false };
  const r = await fetch(`/api/harness/${encodeURIComponent(harnessSlug)}/pr-reviewer-settings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!r.ok) {
    const body = (await r.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${r.status}`);
  }
}

interface PrsResponse {
  prs: PrRowData[];
  pollingFailedAt?: string | null;
  /** #5: server couldn't resolve a GitHub remote for this harness. */
  noRemote?: boolean;
  /** Hive scope only (P-005): the member slugs aggregated + per-member failures. */
  members?: string[];
  memberErrors?: Record<string, { pollingFailedAt?: string; noRemote?: boolean }>;
}

/**
 * PR-3 §4 honesty: does this row belong to the VIEWED harness (so the
 * fetched auto-mode settings actually apply to it)? In hive scope a row may
 * come from a different member harness whose auto-mode we haven't fetched —
 * for those we must NOT render an auto-status we can't stand behind. Pure —
 * unit-tested. Single-harness rows (no member_slug) always belong.
 */
export function rowBelongsToViewedHarness(
  row: Pick<PrRowData, 'member_slug'>,
  viewedSlug: string,
): boolean {
  return !row.member_slug || row.member_slug === viewedSlug;
}

/**
 * Should this row show an auto-status line? Only for the viewed harness's OPEN
 * PRs: a foreign-member row's auto-mode settings aren't held (suppress), and a
 * merged/closed/gone PR has no meaningful auto-status — its state badge speaks
 * for it, and "Auto-merge blocked: PR is not open" beside a "merged" badge is
 * misleading noise (PR-3 §4 honesty). Pure — unit-tested.
 */
export function shouldShowAutoStatus(
  row: Pick<PrRowData, 'member_slug' | 'state'>,
  viewedSlug: string,
): boolean {
  return rowBelongsToViewedHarness(row, viewedSlug) && row.state === 'open';
}

async function fetchPrs(harnessSlug: string, scope: 'harness' | 'hive'): Promise<PrsResponse> {
  const qs = scope === 'hive' ? '?scope=hive' : '';
  const r = await fetch(`/api/harness/${encodeURIComponent(harnessSlug)}/prs${qs}`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json() as Promise<PrsResponse>;
}

async function postApprove(harnessSlug: string, prNumber: number, merge: boolean): Promise<void> {
  const r = await fetch(`/api/harness/${encodeURIComponent(harnessSlug)}/prs/${prNumber}/review`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: merge ? 'approve_and_merge' : 'approve' }),
  });
  if (!r.ok) {
    const body = (await r.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${r.status}`);
  }
}

export function PrsTab({
  harnessSlug,
  viewerGithubId,
  trustedAuthorIds,
  reviewerRoleEnabled,
}: Props) {
  const t = useLexicon();
  const [filter, setFilter] = useQueryState(
    'prs_filter',
    parseAsStringLiteral(PR_FILTERS).withDefault('all'),
  );
  // hive-pr-rollup P-006: harness-vs-hive scope is user-meaningful URL state
  // (deep-linkable, agent-driveable) → nuqs.
  const [scope, setScope] = useQueryState(
    'prs_scope',
    parseAsStringLiteral(PR_SCOPES).withDefault('harness'),
  );
  // Modal-open is user-meaningful URL state (deep-linkable, agent-driveable)
  // → nuqs. The setting VALUES are server state, kept in the modal's useState.
  const [settingsOpen, setSettingsOpen] = useQueryState(
    'prs_settings',
    parseAsBoolean.withDefault(false),
  );
  // PR-3 §5: the focused PR + whether its agent-report panel is expanded are
  // user-meaningful, deep-linkable, agent-driveable → nuqs (AGENTS.md rule).
  const [selectedPr, setSelectedPr] = useQueryState('prs_selected', parseAsInteger);
  const [reportOpen, setReportOpen] = useQueryState(
    'prs_report',
    parseAsBoolean.withDefault(false),
  );
  const toggleReport = useCallback(
    (n: number) => {
      if (selectedPr === n && reportOpen) {
        void setReportOpen(false);
      } else {
        void setSelectedPr(n);
        void setReportOpen(true);
      }
    },
    [selectedPr, reportOpen, setSelectedPr, setReportOpen],
  );
  const [prs, setPrs] = useState<PrRowData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pollingFailed, setPollingFailed] = useState(false);
  const [noRemote, setNoRemote] = useState(false);
  const [memberErrors, setMemberErrors] = useState<
    Record<string, { pollingFailedAt?: string; noRemote?: boolean }>
  >({});

  // P-007: the live dock mounts <PrsTab harnessSlug/> with NO viewer props, so
  // the review gate (Approve buttons) was permanently off. Resolve it from the
  // pr-reviewer-settings route — which also applies the D-002 hive-home role
  // inheritance server-side. Props, when supplied, override. Keyed on
  // primitives only (slug + settings-modal close) — see the render-loop note
  // on `load` below. Failure degrades to read-only.
  const [fetchedGate, setFetchedGate] = useState<ReviewGate | null>(null);
  useEffect(() => {
    if (settingsOpen) return; // refresh on close, after possible saves
    let cancelled = false;
    fetchReviewGate(harnessSlug)
      .then((g) => {
        if (!cancelled && g) setFetchedGate(g);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [harnessSlug, settingsOpen]);

  const effViewerGithubId = viewerGithubId ?? fetchedGate?.viewerGithubId;
  const effTrustedAuthorIds = trustedAuthorIds ?? fetchedGate?.trustedAuthorIds ?? EMPTY_ID_SET;
  const effReviewerRoleEnabled = reviewerRoleEnabled ?? fetchedGate?.reviewerRoleEnabled ?? false;
  const effAutoReview = fetchedGate?.autoReview ?? false;
  const effAutoMerge = fetchedGate?.autoMerge ?? false;
  const effAutoModeEditable = fetchedGate?.autoModeEditable ?? false;
  // The single owner-facing "auto-apply agent recommendations" state: the full
  // auto path (role + approve + merge) is on. Granular per-lever control stays
  // in the settings modal.
  const autoModeOn = effReviewerRoleEnabled && effAutoReview && effAutoMerge;

  // PR-3 §3: claimed-owner authority for the contextual CTA (reuse the shared
  // hook). The server's `autoModeEditable` is the AUTHORITATIVE gate (it also
  // enforces the POST); this drives the human "claim to enable" messaging.
  const claim = useHarnessClaimStatus(harnessSlug);
  const [savingAuto, setSavingAuto] = useState(false);

  const autoModeTooltip = effAutoModeEditable
    ? 'Auto-apply agent recommendations — when on, the daemon auto-approves + merges trusted PRs the agent recommended approve, once checks are green.'
    : claim.data?.viewer_can_claim
      ? 'Only the claimed owner can change auto-mode. Claim this harness (Insights → Claim) to configure.'
      : 'Only the claimed owner can change auto-mode for this harness.';

  const handleToggleAutoMode = useCallback(async () => {
    if (!effAutoModeEditable || savingAuto) return;
    const next = !autoModeOn;
    setSavingAuto(true);
    try {
      await postAutoMode(harnessSlug, next);
      toast.success(next ? 'Auto-apply agent recommendations: ON' : 'Auto-apply: OFF');
      const g = await fetchReviewGate(harnessSlug);
      if (g) setFetchedGate(g);
    } catch (e) {
      toast.error(`Couldn't change auto-mode: ${String(e)}`);
    } finally {
      setSavingAuto(false);
    }
  }, [effAutoModeEditable, savingAuto, autoModeOn, harnessSlug]);

  // Whether this slug resolves into a hive with other members — gates the
  // scope toggle. Rides the audited sync path (harnessProjects.lite, EI-206)
  // the Harnesses tab already uses; NO new poller. Grouping recomputes via the
  // same shared groupByHive the server grouping uses (P-021).
  const liteQuery = useSyncQuery<HiveGroupProject>({
    queryName: 'harnessProjects.lite',
    args: { includeHiveHomes: true },
  });
  const hiveAvailable = useMemo(() => {
    const rows = liteQuery.data ?? [];
    const group = groupByHive(rows).find((g) => g.members.some((m) => m.slug === harnessSlug));
    return !!group && group.members.length > 1;
  }, [liteQuery.data, harnessSlug]);

  // Fetch RAW prs only — keyed solely on harnessSlug + scope (both primitive
  // strings). The per-row `trusted` / `reviewerRoleEnabled` enrichment is
  // intentionally NOT done here: folding it into `load` made `load` depend on
  // `trustedAuthorIds`, whose default value (`new Set()`) is a fresh reference
  // every render, so `useEffect([load])` re-fired on every render — an
  // infinite reload loop that stormed /api/harness/<slug>/prs (observed: 194
  // requests from a single mount) and wedged the webview connection pool,
  // leaving the panel stuck on "Loading…". Enrichment now lives in the
  // `displayed` memo below, off the fetch path.
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const resp = await fetchPrs(harnessSlug, scope);
      setPrs(resp.prs);
      setPollingFailed(!!resp.pollingFailedAt);
      setNoRemote(!!resp.noRemote);
      setMemberErrors(resp.memberErrors ?? {});
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [harnessSlug, scope]);

  useEffect(() => { void load(); }, [load]);

  const handleApprove = useCallback(async (prNumber: number, merge: boolean, targetSlug?: string) => {
    try {
      // Hive scope: the row's review must land on the MEMBER that owns the PR.
      await postApprove(targetSlug ?? harnessSlug, prNumber, merge);
      toast.success(merge ? `Approved + merged PR #${prNumber}` : `Approved PR #${prNumber}`);
      void load();
    } catch (e) {
      toast.error(`Action failed: ${String(e)}`);
    }
  }, [harnessSlug, load]);

  // Filter + enrich at render time (cheap, no setState/fetch — so a fresh
  // `trustedAuthorIds` reference each render only recomputes this memo, it never
  // re-triggers the loader). Enrichment stamps the per-row `trusted` /
  // `reviewerRoleEnabled` fields PrRow needs.
  const displayed = useMemo(
    () =>
      prs
        .filter((pr) => {
          if (filter === 'all') return pr.state !== 'gone';
          if (filter === 'mine') return pr.author_github_id === effViewerGithubId && pr.state === 'open';
          if (filter === 'awaiting-me') return pr.review_decision === 'none' && pr.state === 'open';
          if (filter === 'approved') return pr.review_decision === 'approved';
          if (filter === 'merged') return pr.state === 'merged';
          return true;
        })
        .map((pr) => ({
          ...pr,
          trusted: effTrustedAuthorIds.has(pr.author_github_id),
          reviewerRoleEnabled: effReviewerRoleEnabled,
        })),
    [prs, filter, effViewerGithubId, effTrustedAuthorIds, effReviewerRoleEnabled],
  );

  return (
    <div className="pc-adv-prs">
      <div className="pc-adv-prs__bar">
        <span className="pc-adv-prs__title">
          <GitPullRequest size={14} aria-hidden />
          Pull requests
          {pollingFailed && <span className="pc-adv-prs__warn">cannot reach GitHub</span>}
          {scope === 'hive' && Object.keys(memberErrors).length > 0 && (
            <span
              className="pc-adv-prs__warn"
              title={Object.entries(memberErrors)
                .map(([m, e]) => `${m}: ${e.noRemote ? 'no GitHub remote' : 'cannot reach GitHub'}`)
                .join('\n')}
            >
              {Object.keys(memberErrors).length} member{Object.keys(memberErrors).length === 1 ? '' : 's'} unreachable
            </span>
          )}
        </span>

        {/* PR-3 §3: per-hive auto-mode toggle, gated on claimed-owner authority.
            Read-only (lock) for an unclaimed / non-owner viewer; the server
            enforces the same gate on POST (the teeth). */}
        <div
          className={`pc-adv-prs__automode${effAutoModeEditable ? '' : ' is-locked'}`}
          title={autoModeTooltip}
        >
          <button
            type="button"
            role="switch"
            aria-checked={autoModeOn}
            aria-label="Auto-apply agent recommendations"
            disabled={!effAutoModeEditable || savingAuto}
            className={`pc-adv-prs__autoswitch${autoModeOn ? ' is-on' : ''}`}
            onClick={() => void handleToggleAutoMode()}
          >
            <span className="pc-adv-prs__autoswitch-knob" />
          </button>
          <span className="pc-adv-prs__automode-label">
            {effAutoModeEditable ? <Bot size={12} aria-hidden /> : <Lock size={12} aria-hidden />}
            Auto-apply
          </span>
        </div>

        {hiveAvailable && (
          <div className="pc-adv-prs__scope" role="tablist" aria-label="PR scope">
            {PR_SCOPES.map((s) => (
              <button
                key={s}
                type="button"
                role="tab"
                aria-selected={scope === s}
                className={`pc-adv-prs__chip pc-adv-prs__chip--scope${scope === s ? ' is-active' : ''}`}
                onClick={() => void setScope(s)}
              >
                {s === 'harness' ? 'this harness' : `whole ${t('pot', { lower: true })}`}
              </button>
            ))}
          </div>
        )}
        <div className="pc-adv-prs__filters" role="tablist" aria-label="PR filters">
          {PR_FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              role="tab"
              aria-selected={filter === f}
              className={`pc-adv-prs__chip pc-adv-prs__chip--${f}${filter === f ? ' is-active' : ''}`}
              onClick={() => void setFilter(f)}
            >
              {f}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="pc-adv-prs__refresh"
          onClick={() => void load()}
          aria-label="Refresh PRs"
        >
          <RefreshCw size={13} aria-hidden />
        </button>
        <button
          type="button"
          className="pc-adv-prs__settings"
          onClick={() => void setSettingsOpen(true)}
          aria-label="PR-reviewer settings"
        >
          <Settings size={13} aria-hidden />
        </button>
      </div>

      <div className="pc-adv-prs__list">
        {loading ? (
          <div className="pc-adv-prs__msg">Loading…</div>
        ) : error ? (
          <div className="pc-adv-prs__msg pc-adv-prs__msg--err">{error}</div>
        ) : displayed.length === 0 ? (
          <div className="pc-adv-prs__msg">
            {noRemote
              ? 'No GitHub remote configured for this harness — link a GitHub repo to see its pull requests.'
              : 'No PRs match this filter.'}
          </div>
        ) : (
          displayed.map((pr) => {
            // Honesty (PR-3 §4): the auto-mode settings we hold are the VIEWED
            // harness's. In hive scope a member row belongs to a DIFFERENT
            // harness whose auto-mode we haven't fetched, so computing an
            // auto-status from these settings would be misleading (e.g. claim
            // "Will auto-merge" when that member's auto-mode is actually off).
            // Auto-status only for the viewed harness's OPEN PRs: suppress it for
            // other members (settings we don't hold) AND for merged/closed/gone
            // PRs (auto-mode acts only on open PRs — a "blocked: not open" line
            // next to a "merged" badge is noise, not honesty). PR-3 §4.
            const autoStatus: PrAutoStatus | undefined = shouldShowAutoStatus(pr, harnessSlug)
              ? computeAutoStatus(pr, {
                  reviewerRoleEnabled: effReviewerRoleEnabled,
                  autoReview: effAutoReview,
                  autoMerge: effAutoMerge,
                })
              : undefined;
            return (
              <PrRow
                key={`${pr.member_slug ?? harnessSlug}:${pr.remote}#${pr.number}`}
                pr={pr}
                autoStatus={autoStatus}
                expanded={selectedPr === pr.number && reportOpen}
                onToggleExpand={() => toggleReport(pr.number)}
                onApprove={(n) => void handleApprove(n, false, pr.member_slug)}
                onApproveAndMerge={(n) => void handleApprove(n, true, pr.member_slug)}
              />
            );
          })
        )}
      </div>

      <style>{`
        .pc-adv-prs { display: flex; flex-direction: column; height: 100%; min-height: 0; background: var(--bg-1, #0b1220); }
        .pc-adv-prs__bar {
          display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
          padding: 6px 10px; flex-shrink: 0;
          border-bottom: 1px solid var(--border, rgba(125, 211, 252, 0.15));
        }
        .pc-adv-prs__title {
          display: inline-flex; align-items: center; gap: 6px;
          font-size: 12px; font-weight: 700; color: var(--fg, #e7f7ff);
        }
        .pc-adv-prs__title svg { color: var(--accent, #38bdf8); }
        .pc-adv-prs__warn { font-size: 10px; font-weight: 600; color: var(--bad, #f87171); }
        .pc-adv-prs__filters { display: inline-flex; gap: 4px; flex-wrap: wrap; }
        /* Per-filter tints: each chip carries a --chip-tint (faint on the idle
           border, strong fill when active) so the PR filters are colour-coded —
           sky=all, blue=mine, amber=awaiting, green=approved, violet=merged. */
        .pc-adv-prs__chip {
          --chip-tint: var(--accent, #38bdf8);
          font-size: 11px; padding: 2px 9px; border-radius: 999px;
          border: 1px solid color-mix(in oklab, var(--chip-tint), transparent 80%);
          background: transparent; color: var(--fg-mute, #7f9bb4); cursor: pointer;
          text-transform: capitalize;
          transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease;
        }
        .pc-adv-prs__scope { display: inline-flex; gap: 4px; }
        .pc-adv-prs__chip--scope { --chip-tint: #5eead4; }
        .pc-adv-prs__chip--all { --chip-tint: var(--accent-strong, var(--accent)); }
        .pc-adv-prs__chip--mine { --chip-tint: var(--accent, #38bdf8); }
        .pc-adv-prs__chip--awaiting-me { --chip-tint: #f59e0b; }
        .pc-adv-prs__chip--approved { --chip-tint: #22c55e; }
        .pc-adv-prs__chip--merged { --chip-tint: #a78bfa; }
        .pc-adv-prs__chip:hover { color: var(--fg, #e7f7ff); border-color: color-mix(in oklab, var(--chip-tint), transparent 45%); }
        .pc-adv-prs__chip.is-active {
          color: var(--fg, #e7f7ff);
          background: color-mix(in oklab, var(--chip-tint), transparent 80%);
          border-color: color-mix(in oklab, var(--chip-tint), transparent 38%);
        }
        .pc-adv-prs__refresh {
          margin-left: auto; display: inline-flex; align-items: center; padding: 4px;
          color: var(--fg-mute, #7f9bb4); background: transparent; border: 0; border-radius: 4px; cursor: pointer;
        }
        .pc-adv-prs__refresh:hover { color: var(--fg, #e7f7ff); }
        .pc-adv-prs__settings {
          display: inline-flex; align-items: center; padding: 4px;
          color: var(--fg-mute, #7f9bb4); background: transparent; border: 0; border-radius: 4px; cursor: pointer;
        }
        .pc-adv-prs__settings:hover { color: var(--fg, #e7f7ff); }
        /* PR-3 auto-mode toggle */
        .pc-adv-prs__automode {
          display: inline-flex; align-items: center; gap: 6px;
          padding: 2px 8px 2px 4px; border-radius: 999px;
          border: 1px solid color-mix(in oklab, #22c55e, transparent 80%);
        }
        .pc-adv-prs__automode.is-locked { border-color: var(--border, rgba(125,211,252,0.18)); opacity: 0.85; }
        .pc-adv-prs__automode-label {
          display: inline-flex; align-items: center; gap: 4px;
          font-size: 11px; font-weight: 600; color: var(--fg-mute, #7f9bb4);
        }
        .pc-adv-prs__autoswitch {
          appearance: none; width: 30px; height: 17px; border-radius: 999px; flex-shrink: 0; padding: 0;
          background: var(--bg-3, #1e293b); border: 1px solid var(--border, rgba(125,211,252,0.25));
          position: relative; cursor: pointer; transition: background-color 140ms ease;
        }
        .pc-adv-prs__autoswitch-knob {
          content: ''; position: absolute; top: 2px; left: 2px; width: 11px; height: 11px;
          border-radius: 50%; background: var(--fg, #e7f7ff); transition: transform 140ms ease;
        }
        .pc-adv-prs__autoswitch.is-on { background: #22c55e; border-color: #22c55e; }
        .pc-adv-prs__autoswitch.is-on .pc-adv-prs__autoswitch-knob { transform: translateX(13px); }
        .pc-adv-prs__autoswitch:disabled { cursor: not-allowed; opacity: 0.6; }
        .pc-adv-prs__list {
          flex: 1; min-height: 0; overflow: auto;
          padding: 10px 12px; display: grid; gap: 8px; align-content: start;
        }
        .pc-adv-prs__msg { color: var(--fg-mute, #7f9bb4); font-size: 13px; padding: 16px; text-align: center; }
        .pc-adv-prs__msg--err { color: var(--bad, #f87171); }
      `}</style>

      <PrReviewerSettings
        harnessSlug={harnessSlug}
        open={settingsOpen}
        onOpenChange={(o) => void setSettingsOpen(o)}
      />
    </div>
  );
}

export default PrsTab;
