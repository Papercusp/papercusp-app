import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Braces,
  CheckCircle2,
  Database,
  FileCode2,
  GitBranch,
  GitCommitHorizontal,
  RefreshCw,
  Users,
} from 'lucide-react';
import type { GitLineComposition, GitStats } from '@papercusp/operator-core/lib/harness/git-stats';
import { useAdvScope } from './AdvShell';

type GitStatsEnvelope = {
  stats?: GitStats | null;
  notAGitRepo?: boolean;
  error?: string;
};

export interface AdvStatsTabProps {
  /** Test/embedding seam. Omit to inherit the selected pot from AdvShell. */
  slug?: string | null;
  allMode?: boolean;
  ready?: boolean;
}

/**
 * The backend already caches the expensive committed-content scan by repo +
 * HEAD. This small client cache serves a different purpose: switching away and
 * back never replaces useful measurements with a loading screen. Every mount
 * still revalidates live branch, push, and dirty-tree state.
 */
const statsBySlug = new Map<string, GitStats>();

const integer = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });

function formatCount(value: number): string {
  return value >= 10_000 ? compact.format(value) : integer.format(value);
}

function formatBytes(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '—';
  if (value < 1024) return `${integer.format(value)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = value / 1024;
  let unit = units[0];
  for (let i = 1; i < units.length && size >= 1024; i += 1) {
    size /= 1024;
    unit = units[i];
  }
  return `${size >= 10 ? size.toFixed(0) : size.toFixed(1)} ${unit}`;
}

function formatDate(value: number | null): string {
  return value == null ? '—' : new Date(value).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function measuredLabel(value: string): string {
  const elapsed = Date.now() - Date.parse(value);
  if (!Number.isFinite(elapsed) || elapsed < 0) return 'Measured recently';
  if (elapsed < 60_000) return 'Measured just now';
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return `Measured ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Measured ${hours}h ago`;
  return `Measured ${Math.floor(hours / 24)}d ago`;
}

function percent(part: number, total: number): number {
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, (part / total) * 100));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function MetricCard({ label, value, detail, icon: Icon }: {
  label: string;
  value: string;
  detail: string;
  icon: typeof FileCode2;
}) {
  return (
    <article className="pc-stats__metric">
      <span className="pc-stats__metric-icon" aria-hidden><Icon size={16} /></span>
      <span className="pc-stats__metric-label">{label}</span>
      <strong>{value}</strong>
      <span className="pc-stats__metric-detail">{detail}</span>
    </article>
  );
}

function CompositionBar({ value, label }: { value: GitLineComposition; label: string }) {
  const total = value.lines;
  const code = percent(value.codeLines, total);
  const comments = percent(value.commentLines, total);
  const blank = percent(value.blankLines, total);
  return (
    <div className="pc-stats__composition-block">
      <div className="pc-stats__composition-head">
        <strong>{label}</strong>
        <span>{formatCount(total)} lines · {formatCount(value.files)} files</span>
      </div>
      <div className="pc-stats__composition-bar" aria-label={`${label}: ${code.toFixed(0)}% code, ${comments.toFixed(0)}% comments, ${blank.toFixed(0)}% blank`}>
        <span data-kind="code" style={{ width: `${code}%` }} />
        <span data-kind="comment" style={{ width: `${comments}%` }} />
        <span data-kind="blank" style={{ width: `${blank}%` }} />
      </div>
      <div className="pc-stats__composition-legend">
        <span data-kind="code">Code <b>{formatCount(value.codeLines)}</b></span>
        <span data-kind="comment">Comments <b>{formatCount(value.commentLines)}</b></span>
        <span data-kind="blank">Blank <b>{formatCount(value.blankLines)}</b></span>
      </div>
    </div>
  );
}

function StateCard({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'error' }) {
  return <div className="pc-stats__state" data-tone={tone}>{children}</div>;
}

function pushTitle(stats: GitStats): string {
  switch (stats.push.status) {
    case 'up-to-date': return 'Up to date with upstream';
    case 'ahead': return `${stats.push.ahead ?? 0} commit${stats.push.ahead === 1 ? '' : 's'} ready to push`;
    case 'behind': return `${stats.push.behind ?? 0} commit${stats.push.behind === 1 ? '' : 's'} behind upstream`;
    case 'diverged': return 'Local and upstream histories diverged';
    case 'no-upstream': return 'No upstream branch configured';
    case 'no-remote': return 'No Git remote configured';
    default: return 'Push status unavailable';
  }
}

export default function AdvStatsTab(props: AdvStatsTabProps = {}) {
  const inherited = useAdvScope();
  const slug = props.slug === undefined ? inherited.slug : props.slug;
  const allMode = props.allMode === undefined ? inherited.allMode : props.allMode;
  const ready = props.ready === undefined ? inherited.ready : props.ready;
  const [stats, setStats] = useState<GitStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [notAGitRepo, setNotAGitRepo] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const forceRefreshRef = useRef(false);

  useEffect(() => {
    if (!ready || allMode || !slug) {
      setStats(null);
      setLoading(false);
      setRefreshing(false);
      setNotAGitRepo(false);
      setError(null);
      return;
    }

    const cached = statsBySlug.get(slug) ?? null;
    const controller = new AbortController();
    const forceRefresh = forceRefreshRef.current;
    forceRefreshRef.current = false;
    setStats(cached);
    setLoading(cached === null);
    setRefreshing(cached !== null);
    setNotAGitRepo(false);
    setError(null);

    void (async () => {
      try {
        const response = await fetch(
          `/api/harness/${encodeURIComponent(slug)}/git/stats${forceRefresh ? '?refresh=1' : ''}`,
          { cache: 'no-store', signal: controller.signal, headers: { Accept: 'application/json' } },
        );
        const body = await response.json() as GitStatsEnvelope;
        if (!response.ok) throw new Error(body.error || `Git statistics request failed (${response.status})`);
        if (body.notAGitRepo || body.stats === null) {
          statsBySlug.delete(slug);
          setStats(null);
          setNotAGitRepo(true);
          return;
        }
        if (!body.stats) throw new Error('Git statistics response did not include stats');
        statsBySlug.set(slug, body.stats);
        setStats(body.stats);
      } catch (caught) {
        if (controller.signal.aborted) return;
        setError(errorMessage(caught));
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    })();

    return () => controller.abort();
  }, [allMode, ready, refreshToken, slug]);

  const refresh = () => {
    forceRefreshRef.current = true;
    setRefreshToken((value) => value + 1);
  };

  if (!ready) {
    return <StateCard><RefreshCw className="pc-stats__spin" size={20} aria-hidden /><strong>Resolving pot scope…</strong></StateCard>;
  }
  if (allMode || !slug) {
    return <StateCard><GitBranch size={22} aria-hidden /><strong>Pick one pot to inspect its repository statistics.</strong><span>Stats are measured from a single Git repository, so the All Pots rollup is intentionally unavailable.</span></StateCard>;
  }

  return (
    <section className="pc-stats" aria-labelledby="pc-stats-title" aria-busy={loading || refreshing}>
      <header className="pc-stats__header">
        <div>
          <span className="pc-stats__eyebrow">Repository intelligence · {slug}</span>
          <h1 id="pc-stats-title">Git statistics</h1>
          <p>Committed content, history, contributors, and live push state for the selected pot.</p>
        </div>
        <button type="button" className="pc-stats__refresh" onClick={refresh} disabled={loading || refreshing}>
          <RefreshCw size={15} className={loading || refreshing ? 'pc-stats__spin' : undefined} aria-hidden />
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </header>

      {loading && !stats ? (
        <StateCard><RefreshCw className="pc-stats__spin" size={20} aria-hidden /><strong>Measuring {slug}…</strong><span>Large repositories may take a few seconds on the first scan.</span></StateCard>
      ) : null}
      {notAGitRepo ? (
        <StateCard><GitBranch size={22} aria-hidden /><strong>{slug} is not a Git repository.</strong><span>The pot exists, but its configured path has no Git work tree.</span></StateCard>
      ) : null}
      {error && !stats ? (
        <StateCard tone="error"><AlertTriangle size={22} aria-hidden /><strong>Could not load Git statistics.</strong><span>{error}</span><button type="button" onClick={refresh}>Try again</button></StateCard>
      ) : null}

      {stats ? (
        <>
          {error ? (
            <div className="pc-stats__notice" role="alert">
              <AlertTriangle size={16} aria-hidden />
              <span><strong>Showing the last measurement.</strong> Revalidation failed: {error}</span>
            </div>
          ) : null}
          {stats.coverage.truncated || !stats.coverage.treeComplete ? (
            <div className="pc-stats__notice pc-stats__notice--coverage">
              <AlertTriangle size={16} aria-hidden />
              <span><strong>Partial repository coverage.</strong> {stats.coverage.reasons.join(' · ') || 'The bounded scan reached a safety limit.'}</span>
            </div>
          ) : null}

          <div className="pc-stats__metrics" aria-label="Repository summary">
            <MetricCard icon={FileCode2} label="Tracked files" value={formatCount(stats.footprint.trackedFiles)} detail={formatBytes(stats.footprint.trackedBytes)} />
            <MetricCard icon={Braces} label="Lines" value={formatCount(stats.composition.total.lines)} detail={`${formatCount(stats.composition.total.codeLines)} code`} />
            <MetricCard icon={GitCommitHorizontal} label="Commits" value={formatCount(stats.history.commits)} detail={`${formatCount(stats.history.commitsLast30Days)} in 30 days`} />
            <MetricCard icon={Users} label="Contributors" value={formatCount(stats.contributors.identities)} detail={`${stats.contributors.top.length} ranked`} />
            <MetricCard icon={Database} label="Git objects" value={formatBytes(stats.footprint.gitObjectBytes)} detail={`${stats.repository.refs.tags} tags`} />
          </div>

          <section className={`pc-stats__push is-${stats.push.status}`} aria-label="Push status">
            <span className="pc-stats__push-icon" aria-hidden>
              {stats.push.status === 'up-to-date' ? <CheckCircle2 size={20} /> : stats.push.status === 'behind' ? <ArrowDown size={20} /> : <ArrowUp size={20} />}
            </span>
            <div>
              <strong>{pushTitle(stats)}</strong>
              <span>{stats.repository.branch ?? 'Detached HEAD'}{stats.push.upstream ? ` → ${stats.push.upstream}` : ''}{stats.push.remote ? ` · ${stats.push.remote}` : ''}</span>
            </div>
            <dl>
              <div><dt>Ahead</dt><dd>{stats.push.ahead ?? '—'}</dd></div>
              <div><dt>Behind</dt><dd>{stats.push.behind ?? '—'}</dd></div>
            </dl>
          </section>

          <div className="pc-stats__grid">
            <article className="pc-stats__panel pc-stats__panel--composition">
              <header><div><span>Composition</span><h2>What the repository contains</h2></div><Braces size={18} aria-hidden /></header>
              <CompositionBar label="All analyzed content" value={stats.composition.total} />
              <div className="pc-stats__composition-split">
                <CompositionBar label="Production" value={stats.composition.production} />
                <CompositionBar label="Tests & fixtures" value={stats.composition.testsAndFixtures} />
              </div>
            </article>

            <article className="pc-stats__panel pc-stats__panel--languages">
              <header><div><span>Languages</span><h2>Code by analyzed lines</h2></div><FileCode2 size={18} aria-hidden /></header>
              <div className="pc-stats__languages">
                {[...stats.composition.languages]
                  .filter((language) => language.lines > 0)
                  .sort((a, b) => b.lines - a.lines)
                  .slice(0, 10)
                  .map((language) => {
                    const share = percent(language.lines, stats.composition.total.lines);
                    return (
                      <div className="pc-stats__language" key={language.language}>
                        <div><strong>{language.language}</strong><span>{formatCount(language.lines)} lines · {formatCount(language.files)} files</span><b>{share.toFixed(1)}%</b></div>
                        <span className="pc-stats__language-bar"><i style={{ width: `${Math.max(share, 0.7)}%` }} /></span>
                      </div>
                    );
                  })}
                {stats.composition.languages.every((language) => language.lines === 0) ? <p className="pc-stats__empty">No text languages were classified.</p> : null}
              </div>
            </article>

            <article className="pc-stats__panel">
              <header><div><span>Contributors</span><h2>Commit leaders</h2></div><Users size={18} aria-hidden /></header>
              <ol className="pc-stats__contributors">
                {stats.contributors.top.slice(0, 8).map((contributor, index) => (
                  <li key={`${contributor.email ?? contributor.name}-${index}`}>
                    <span>{index + 1}</span>
                    <div><strong>{contributor.name}</strong>{contributor.email ? <small>{contributor.email}</small> : null}</div>
                    <b>{formatCount(contributor.commits)}</b>
                  </li>
                ))}
              </ol>
              {stats.contributors.top.length === 0 ? <p className="pc-stats__empty">No commits yet.</p> : null}
              {stats.contributors.truncated ? <p className="pc-stats__footnote">Contributor ranking is limited to the top results.</p> : null}
            </article>

            <article className="pc-stats__panel">
              <header><div><span>Repository</span><h2>History & storage</h2></div><GitBranch size={18} aria-hidden /></header>
              <dl className="pc-stats__details">
                <div><dt>HEAD</dt><dd title={stats.repository.head ?? undefined}>{stats.repository.head?.slice(0, 10) ?? 'Unborn'}</dd></div>
                <div><dt>Working tree</dt><dd className={stats.repository.clean ? 'is-good' : 'is-warn'}>{stats.repository.clean ? 'Clean' : `${stats.repository.changes.staged + stats.repository.changes.unstaged + stats.repository.changes.untracked + stats.repository.changes.conflicted} changes`}</dd></div>
                <div><dt>Local / remote branches</dt><dd>{stats.repository.refs.localBranches} / {stats.repository.refs.remoteBranches}</dd></div>
                <div><dt>First commit</dt><dd>{formatDate(stats.history.firstCommitAt)}</dd></div>
                <div><dt>Latest commit</dt><dd>{formatDate(stats.history.latestCommitAt)}</dd></div>
                <div><dt>Commits · 7 / 30 / 90 days</dt><dd>{stats.history.commitsLast7Days} / {stats.history.commitsLast30Days} / {stats.history.commitsLast90Days}</dd></div>
                <div><dt>Submodules</dt><dd>{stats.footprint.submodules.count}</dd></div>
                <div><dt>Scan coverage</dt><dd>{formatCount(stats.coverage.analyzedFiles)} files · {formatBytes(stats.coverage.analyzedBytes)}</dd></div>
              </dl>
            </article>
          </div>

          <footer className="pc-stats__footer">
            <span title={new Date(stats.measuredAt).toLocaleString()}>{measuredLabel(stats.measuredAt)}</span>
            <span>{stats.cache.hit ? 'Committed-content cache hit' : 'Fresh committed-content scan'}</span>
            <span>{stats.coverage.binaryFiles} binary · {stats.coverage.skippedLargeFiles} large skipped · {stats.coverage.unclassifiedFiles} unclassified</span>
          </footer>
        </>
      ) : null}

      <style>{`
        .pc-stats { container-type: inline-size; display: flex; flex: 1; min-height: 0; flex-direction: column; gap: 14px; padding: 18px; color: var(--fg, #e7f7ff); overflow: auto; }
        .pc-stats__header { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; }
        .pc-stats__header h1 { margin: 3px 0 4px; font-size: clamp(20px, 2vw, 28px); line-height: 1.1; letter-spacing: 0; }
        .pc-stats__header p { margin: 0; color: var(--fg-mute, #7f9bb4); font-size: 12px; }
        .pc-stats__eyebrow, .pc-stats__panel header span { color: var(--accent-strong, #7dd3fc); font-size: 10px; font-weight: 800; letter-spacing: 0; text-transform: uppercase; }
        .pc-stats__refresh, .pc-stats__state button { display: inline-flex; align-items: center; justify-content: center; gap: 7px; flex: 0 0 auto; border: 1px solid var(--border-strong, rgba(125,211,252,.3)); border-radius: 9px; background: var(--bg-2, rgba(255,255,255,.045)); color: var(--fg, #e7f7ff); padding: 7px 11px; font: inherit; font-size: 11px; font-weight: 750; cursor: pointer; }
        .pc-stats__refresh:hover:not(:disabled), .pc-stats__state button:hover { border-color: var(--accent-strong, #7dd3fc); }
        .pc-stats__refresh:disabled { cursor: default; opacity: .65; }
        .pc-stats__spin { animation: pc-stats-spin .8s linear infinite; }
        @keyframes pc-stats-spin { to { transform: rotate(360deg); } }
        .pc-stats__state { display: flex; min-height: 180px; flex: 1; align-items: center; justify-content: center; flex-direction: column; gap: 8px; padding: 28px; text-align: center; color: var(--fg-mute, #7f9bb4); border: 1px dashed var(--border, rgba(125,211,252,.2)); border-radius: 14px; background: var(--bg-2, rgba(255,255,255,.025)); }
        .pc-stats__state strong { color: var(--fg, #e7f7ff); font-size: 14px; }
        .pc-stats__state span { max-width: 520px; font-size: 12px; }
        .pc-stats__state[data-tone='error'] svg, .pc-stats__state[data-tone='error'] strong { color: var(--bad, #f87171); }
        .pc-stats__notice { display: flex; align-items: flex-start; gap: 8px; padding: 9px 11px; border: 1px solid rgba(248,113,113,.28); border-radius: 9px; background: rgba(248,113,113,.08); color: #fecaca; font-size: 11px; }
        .pc-stats__notice svg { flex: 0 0 auto; }
        .pc-stats__notice--coverage { border-color: rgba(251,191,36,.28); background: rgba(251,191,36,.075); color: #fde68a; }
        .pc-stats__metrics { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 9px; }
        .pc-stats__metric { position: relative; display: grid; grid-template-columns: 1fr auto; gap: 3px 8px; min-width: 0; padding: 11px 12px; border: 1px solid var(--border, rgba(125,211,252,.16)); border-radius: 12px; background: radial-gradient(circle at top right, rgba(56,189,248,.09), transparent 55%), var(--bg-2, rgba(255,255,255,.035)); }
        .pc-stats__metric-icon { grid-column: 2; grid-row: 1 / span 2; color: var(--accent-strong, #7dd3fc); opacity: .82; }
        .pc-stats__metric-label { grid-column: 1; color: var(--fg-mute, #7f9bb4); font-size: 9.5px; font-weight: 750; letter-spacing: 0; text-transform: uppercase; }
        .pc-stats__metric strong { grid-column: 1; font-size: 21px; line-height: 1.05; font-variant-numeric: tabular-nums; }
        .pc-stats__metric-detail { grid-column: 1 / -1; color: var(--fg-mute, #7f9bb4); font-size: 10px; }
        .pc-stats__push { display: flex; align-items: center; gap: 10px; min-width: 0; padding: 10px 12px; border: 1px solid rgba(52,211,153,.28); border-radius: 12px; background: rgba(52,211,153,.065); }
        .pc-stats__push.is-ahead, .pc-stats__push.is-diverged { border-color: rgba(251,191,36,.3); background: rgba(251,191,36,.07); }
        .pc-stats__push.is-behind, .pc-stats__push.is-unknown { border-color: rgba(248,113,113,.28); background: rgba(248,113,113,.065); }
        .pc-stats__push.is-no-upstream, .pc-stats__push.is-no-remote { border-color: var(--border, rgba(125,211,252,.2)); background: var(--bg-2, rgba(255,255,255,.035)); }
        .pc-stats__push-icon { color: var(--good, #34d399); }
        .pc-stats__push.is-ahead .pc-stats__push-icon, .pc-stats__push.is-diverged .pc-stats__push-icon { color: var(--warn, #fbbf24); }
        .pc-stats__push.is-behind .pc-stats__push-icon, .pc-stats__push.is-unknown .pc-stats__push-icon { color: var(--bad, #f87171); }
        .pc-stats__push > div { display: flex; flex: 1; min-width: 0; flex-direction: column; gap: 2px; }
        .pc-stats__push strong { font-size: 12px; }
        .pc-stats__push > div span { overflow: hidden; color: var(--fg-mute, #7f9bb4); font-size: 10.5px; text-overflow: ellipsis; white-space: nowrap; }
        .pc-stats__push dl { display: flex; gap: 13px; margin: 0; }
        .pc-stats__push dl div { display: grid; gap: 1px; text-align: right; }
        .pc-stats__push dt { color: var(--fg-mute, #7f9bb4); font-size: 8.5px; font-weight: 750; text-transform: uppercase; }
        .pc-stats__push dd { margin: 0; font-size: 13px; font-weight: 800; font-variant-numeric: tabular-nums; }
        .pc-stats__grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 11px; align-items: start; }
        .pc-stats__panel { min-width: 0; overflow: hidden; border: 1px solid var(--border, rgba(125,211,252,.16)); border-radius: 13px; background: var(--bg-2, rgba(255,255,255,.03)); }
        .pc-stats__panel > header { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--border, rgba(125,211,252,.12)); }
        .pc-stats__panel > header > div { display: grid; gap: 2px; }
        .pc-stats__panel > header h2 { margin: 0; font-size: 12px; }
        .pc-stats__panel > header > svg { color: var(--accent-strong, #7dd3fc); }
        .pc-stats__composition-block { display: grid; gap: 7px; padding: 11px 12px; }
        .pc-stats__composition-block + .pc-stats__composition-block { border-left: 1px solid var(--border, rgba(125,211,252,.12)); }
        .pc-stats__composition-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
        .pc-stats__composition-head strong { font-size: 11px; }
        .pc-stats__composition-head span { color: var(--fg-mute, #7f9bb4); font-size: 9.5px; }
        .pc-stats__composition-bar { display: flex; width: 100%; height: 8px; overflow: hidden; border-radius: 999px; background: rgba(255,255,255,.05); }
        .pc-stats__composition-bar span[data-kind='code'] { background: #38bdf8; }
        .pc-stats__composition-bar span[data-kind='comment'] { background: #a78bfa; }
        .pc-stats__composition-bar span[data-kind='blank'] { background: #64748b; }
        .pc-stats__composition-legend { display: flex; flex-wrap: wrap; gap: 8px 13px; color: var(--fg-mute, #7f9bb4); font-size: 9.5px; }
        .pc-stats__composition-legend span::before { display: inline-block; width: 6px; height: 6px; margin-right: 5px; border-radius: 999px; background: #38bdf8; content: ''; }
        .pc-stats__composition-legend span[data-kind='comment']::before { background: #a78bfa; }
        .pc-stats__composition-legend span[data-kind='blank']::before { background: #64748b; }
        .pc-stats__composition-legend b { color: var(--fg, #e7f7ff); font-weight: 700; }
        .pc-stats__composition-split { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); border-top: 1px solid var(--border, rgba(125,211,252,.12)); }
        .pc-stats__languages { display: grid; gap: 9px; padding: 11px 12px 13px; }
        .pc-stats__language { display: grid; gap: 4px; }
        .pc-stats__language > div { display: grid; grid-template-columns: minmax(80px, .7fr) minmax(130px, 1fr) auto; align-items: baseline; gap: 8px; }
        .pc-stats__language strong { overflow: hidden; font-size: 10.5px; text-overflow: ellipsis; white-space: nowrap; }
        .pc-stats__language span, .pc-stats__language b { color: var(--fg-mute, #7f9bb4); font-size: 9.5px; font-weight: 600; }
        .pc-stats__language b { font-variant-numeric: tabular-nums; }
        .pc-stats__language-bar { display: block; height: 4px; overflow: hidden; border-radius: 999px; background: rgba(255,255,255,.06); }
        .pc-stats__language-bar i { display: block; height: 100%; border-radius: inherit; background: linear-gradient(90deg, var(--accent, #38bdf8), #a78bfa); }
        .pc-stats__contributors { display: grid; gap: 0; margin: 0; padding: 5px 12px 9px; list-style: none; }
        .pc-stats__contributors li { display: grid; grid-template-columns: 20px minmax(0, 1fr) auto; align-items: center; gap: 8px; padding: 6px 0; border-bottom: 1px solid var(--border, rgba(125,211,252,.08)); }
        .pc-stats__contributors li:last-child { border-bottom: 0; }
        .pc-stats__contributors li > span { color: var(--fg-mute, #7f9bb4); font-size: 9px; font-variant-numeric: tabular-nums; }
        .pc-stats__contributors div { display: grid; min-width: 0; gap: 1px; }
        .pc-stats__contributors strong, .pc-stats__contributors small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .pc-stats__contributors strong { font-size: 10.5px; }
        .pc-stats__contributors small { color: var(--fg-mute, #7f9bb4); font-size: 8.5px; }
        .pc-stats__contributors b { color: var(--accent-strong, #7dd3fc); font-size: 10.5px; font-variant-numeric: tabular-nums; }
        .pc-stats__details { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); margin: 0; }
        .pc-stats__details div { display: grid; gap: 2px; min-width: 0; padding: 9px 12px; border-bottom: 1px solid var(--border, rgba(125,211,252,.08)); }
        .pc-stats__details div:nth-child(odd) { border-right: 1px solid var(--border, rgba(125,211,252,.08)); }
        .pc-stats__details dt { color: var(--fg-mute, #7f9bb4); font-size: 8.5px; font-weight: 700; text-transform: uppercase; }
        .pc-stats__details dd { overflow: hidden; margin: 0; font-size: 10.5px; font-weight: 700; text-overflow: ellipsis; white-space: nowrap; font-variant-numeric: tabular-nums; }
        .pc-stats__details dd.is-good { color: var(--good, #34d399); }
        .pc-stats__details dd.is-warn { color: var(--warn, #fbbf24); }
        .pc-stats__empty, .pc-stats__footnote { margin: 0; padding: 10px 12px; color: var(--fg-mute, #7f9bb4); font-size: 10px; }
        .pc-stats__footnote { padding-top: 0; }
        .pc-stats__footer { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 6px 16px; padding: 2px 2px 8px; color: var(--fg-mute, #7f9bb4); font-size: 9.5px; }
        @container (max-width: 900px) { .pc-stats__metrics { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
        @container (max-width: 680px) {
          .pc-stats { padding: 13px; }
          .pc-stats__header { align-items: center; }
          .pc-stats__header p { display: none; }
          .pc-stats__metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
          .pc-stats__grid { grid-template-columns: 1fr; }
          .pc-stats__push dl { display: none; }
        }
        @container (max-width: 430px) {
          .pc-stats__header { align-items: stretch; flex-direction: column; gap: 10px; }
          .pc-stats__refresh { align-self: flex-start; }
          .pc-stats__metrics { grid-template-columns: 1fr; }
          .pc-stats__composition-split, .pc-stats__details { grid-template-columns: 1fr; }
          .pc-stats__composition-block + .pc-stats__composition-block, .pc-stats__details div:nth-child(odd) { border-left: 0; border-right: 0; }
          .pc-stats__language > div { grid-template-columns: minmax(70px, 1fr) auto; }
          .pc-stats__language > div span { display: none; }
        }
        @media (prefers-reduced-motion: reduce) { .pc-stats__spin { animation: none; } }
      `}</style>
    </section>
  );
}
