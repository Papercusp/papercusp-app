'use client';

/**
 * OperatorActionLog — the harness-scoped log of long-running user-initiated
 * actions described in the designer brief from 2026-05-02.
 *
 * Subscribes to userActions.byHarness through the root sync cache. Lightweight; designed to slot into
 * any harness chrome region (sidebar / dashboard panel / drawer). Wire-up
 * is intentionally not done here — the host decides where the panel lives.
 *
 * Design choices left for the visual-design pass (see designer brief):
 *   - Layout shape (table vs timeline vs cards) — currently a simple list.
 *   - Running indicator — currently a CSS-pulse on the row.
 *   - Failure prominence — currently failures stay chronological, marked.
 *   - Archive policy — currently no auto-archive; show all returned rows.
 *
 * The `user_actions` table bridge pushes every lifecycle transition.
 */

import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useAutoAnimate } from '@formkit/auto-animate/react';
import { Clock, DollarSign } from 'lucide-react';
import { useSyncQuery } from '@papercusp/sync';
import { useWorkspaceId } from '@/lib/use-workspace-id';

export interface UserAction {
  id: number;
  kind: string;
  status: 'running' | 'succeeded' | 'failed' | 'cancelled';
  summary: string | null;
  detailUrl: string | null;
  errorText: string | null;
  invocationId: string | null;
  startedAt: number;
  finishedAt: number | null;
  actor: string | null;
}

type Listener = (a: UserAction) => void;

function useUserActions(slug: string | null, opts?: { onTransition?: Listener }): {
  actions: UserAction[];
  loading: boolean;
  error: string | null;
} {
  const workspaceId = useWorkspaceId();
  const onTransitionRef = useRef(opts?.onTransition);
  onTransitionRef.current = opts?.onTransition;
  const lastRef = useRef<Map<number, UserAction>>(new Map());

  // HarnessSyncProvider is hoisted to root layout — useSyncQuery works
  // on every route now (was blocked by a Turbopack chunking bug;
  // resolved by Paperclip's harness-phases-const fix). Server emits
  // notifySyncInvalidate('userActions.byHarness', {harnessSlug}) on
  // every recordUserAction / updateUserAction → push refetch.
  const sync = useSyncQuery<UserAction>({
    queryName: 'userActions.byHarness',
    args: { harnessSlug: slug ?? '', workspaceId, limit: 100 },
    enabled: !!slug,
  });
  const liveRows = (sync.data as UserAction[] | undefined) ?? [];
  const liveLoading = sync.loading;
  const liveError = sync.error ? sync.error.message : null;

  const actions: UserAction[] = useMemo(() => liveRows, [liveRows]);

  // Fire onTransition callbacks on pushed status flips.
  useEffect(() => {
    if (!slug || !Array.isArray(liveRows) || liveRows.length === 0) return;
    const next = new Map<number, UserAction>();
    for (const a of liveRows) next.set(a.id, a);
    const cb = onTransitionRef.current;
    if (cb) {
      for (const [id, a] of next) {
        const prev = lastRef.current.get(id);
        if (prev && prev.status !== a.status) cb(a);
      }
    }
    lastRef.current = next;
  }, [slug, liveRows]);

  return {
    actions,
    loading: !!slug && liveLoading && actions.length === 0,
    error: liveError,
  };
}



export function formatRelative(ms: number, now: number): string {
  const d = Math.max(0, now - ms);
  if (d < 1000) return 'just now';
  if (d < 60_000) return `${Math.floor(d / 1000)}s ago`;
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  return `${Math.floor(d / 86_400_000)}d ago`;
}

export function formatElapsed(startedAt: number, finishedAt: number | null, now: number): string {
  const ms = (finishedAt ?? now) - startedAt;
  if (ms < 1000) return '<1s';
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
}

export function OperatorActionLog({
  slug,
  onTransition,
  className,
}: {
  slug: string | null;
  onTransition?: Listener;
  className?: string;
}) {
  const { actions, loading, error } = useUserActions(slug, { onTransition });
  const [listRef] = useAutoAnimate<HTMLUListElement>();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    // Relative-time refresh ("Nm ago" labels) — pure UI timer, no fetch;
    // the documented UI-timer exception (audit P-058). Data itself is
    // push-driven via userActions.byHarness in useUserActions.
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  if (!slug) {
    return (
      <div className={className} style={{ opacity: 0.5, fontSize: 13 }}>
        Pick a harness to see its action log.
      </div>
    );
  }
  if (loading && actions.length === 0) {
    return (
      <div className={className} style={{ opacity: 0.6, fontSize: 13 }}>
        Loading actions…
      </div>
    );
  }
  if (error && actions.length === 0) {
    return (
      <div className={className} style={{ fontSize: 13 }}>
        <div style={{ color: 'var(--bad, #f87171)', marginBottom: 6 }}>
          Could not load action log: {error}
        </div>
        <button
          type="button"
          onClick={() => window.location.reload()}
          style={{
            fontSize: 12,
            padding: '3px 8px',
            background: 'transparent',
            border: '1px solid var(--border)',
            borderRadius: 4,
            cursor: 'pointer',
            color: 'var(--fg)',
          }}
        >
          retry
        </button>
      </div>
    );
  }
  if (actions.length === 0) {
    return (
      <div className={className}>
        <div style={{ opacity: 0.6, fontSize: 13 }}>
          No actions yet. Replan, cleanup, snapshot, and plugin operations show up here.
        </div>
      </div>
    );
  }

  return (
    <ul ref={listRef} className={`notif-list${className ? ` ${className}` : ''}`}>
      {actions.map((a) => (
        <ActionRow key={a.id} action={a} now={now} />
      ))}
    </ul>
  );
}

/** True iff the given href is something the browser can navigate to
 *  meaningfully — a same-origin route (`/...`), an `http(s)://` URL,
 *  or a hash. Filesystem paths like `/home/<user>/...` look like
 *  same-origin paths to the browser (they start with `/`) but every
 *  request 404s. Some older `user_actions` rows have these baked in;
 *  hiding the open link for them keeps the UI honest. */
export function isOpenableHref(href: string | null | undefined): href is string {
  if (!href) return false;
  if (/^https?:\/\//i.test(href)) return true;
  if (href.startsWith('#')) return true;
  if (href.startsWith('/')) {
    // Reject typical filesystem-path prefixes that we know aren't routes.
    if (/^\/(home|Users|root|tmp|var|opt|etc|usr)\//.test(href)) return false;
    return true;
  }
  return false;
}

/** Pull the duration token (e.g. "(9s)" or "(2m 4s)") and cost token
 *  (e.g. "cost=0.044") out of a free-form summary string so we can
 *  render them as standalone info-pills next to the summary. */
export function parseSummaryMeta(summary: string | null): {
  cleaned: string | null;
  duration: string | null;
  cost: string | null;
} {
  if (!summary) return { cleaned: null, duration: null, cost: null };
  let s = summary;
  let duration: string | null = null;
  let cost: string | null = null;
  // `completed (9s)` / `completed (2m 4s)` / `completed (123ms)` etc.
  const durRe = /\s*\((\d+(?:m\s*\d+)?(?:\.\d+)?\s*(?:m?s|s|m)(?:\s*\d+(?:\.\d+)?\s*(?:m?s|s))*)\)/i;
  const dm = s.match(durRe);
  if (dm) {
    duration = dm[1].trim();
    s = s.replace(dm[0], '').trim();
  }
  // `cost=0.044` (with optional `· cost=...` separator before).
  const costRe = /(?:\s*·)?\s*cost\s*=\s*([\d.]+)\s*/i;
  const cm = s.match(costRe);
  if (cm) {
    cost = cm[1];
    s = s.replace(cm[0], '').trim();
  }
  // Trim any dangling separators left over.
  s = s.replace(/[·\s]+$/g, '').trim();
  return { cleaned: s || null, duration, cost };
}

function ActionRow({ action: a, now }: { action: UserAction; now: number }) {
  const elapsedFallback = formatElapsed(a.startedAt, a.finishedAt, now);
  const started = formatRelative(a.startedAt, now);
  const meta = parseSummaryMeta(a.summary);
  // Filter out detail URLs we can't actually open in the browser.
  // Some legacy rows wrote a filesystem path like
  // `/home/.../.papercusp/runs/foo.log` — the browser treats that as a
  // same-origin URL and 404s.
  const detailHref = isOpenableHref(a.detailUrl) ? a.detailUrl : null;
  // If parsing didn't find a duration but the row has timing info,
  // fall back to the live elapsed counter so a `running` row still
  // shows duration.
  const durationLabel = meta.duration ?? (a.status === 'running' || !a.finishedAt ? elapsedFallback : null);
  const showCost = meta.cost != null;

  return (
    <li
      className={`notif-item notif-item--${a.status}`}
      title={a.errorText ?? undefined}
    >
      <div className="notif-item-head">
        <span className={`notif-level notif-level--${a.status}`}>
          {a.status === 'running' && (
            <span
              aria-hidden="true"
              style={{
                display: 'inline-block',
                width: 6,
                height: 6,
                marginRight: 5,
                borderRadius: '50%',
                background: 'currentColor',
                animation: 'pc-spin 800ms linear infinite, pulse 1.4s ease-in-out infinite',
                verticalAlign: 'middle',
              }}
            />
          )}
          {a.kind}
        </span>
        <span className="notif-time">{started}</span>
        {detailHref ? (
          <a
            href={detailHref}
            target={detailHref.startsWith('http') ? '_blank' : undefined}
            rel={detailHref.startsWith('http') ? 'noopener noreferrer' : undefined}
            className="notif-action"
            style={{ marginTop: 0, padding: '2px 6px', fontSize: 10.5 }}
            aria-label="Open detail link"
          >
            open ↗
          </a>
        ) : null}
      </div>
      <div className="notif-message" style={{ fontWeight: 500 }}>
        {a.errorText ? (
          <span style={{ color: 'var(--bad, #f87171)' }}>{a.errorText.slice(0, 280)}</span>
        ) : (
          meta.cleaned ?? <em style={{ opacity: 0.5, fontWeight: 400 }}>(no summary)</em>
        )}
      </div>
      {(durationLabel || showCost) && (
        <div className="notif-meta-row" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
          {durationLabel && (
            <span className="notif-meta-pill" title="Run duration">
              <Clock size={11} aria-hidden="true" style={{ marginRight: 4, verticalAlign: '-1px' }} />
              {durationLabel}
            </span>
          )}
          {showCost && (
            <span className="notif-meta-pill notif-meta-pill--cost" title="Run cost (USD)">
              <DollarSign size={11} aria-hidden="true" style={{ marginRight: 2, verticalAlign: '-1px' }} />
              {meta.cost}
            </span>
          )}
        </div>
      )}
    </li>
  );
}
