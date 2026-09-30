'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { COLORS, FONTS, RADIUS, SIZES, STATUS } from './theme';
import { fetchGitLog as libFetchGitLog, getCachedGitLog as libGetCachedGitLog } from '@papercusp/git-graph';

function harnessScope(slug: string) { return `harness:${slug}`; }
function harnessLogUrl(slug: string, limit: number) { return `/api/harness/${slug}/git/log?limit=${limit}`; }
function getCachedGitLog(slug: string, limit: number) { return libGetCachedGitLog(harnessScope(slug), limit); }
function fetchGitLog(slug: string, limit: number) { return libFetchGitLog(harnessScope(slug), limit, harnessLogUrl(slug, limit)); }

const RAIL_WIDTH = 40;

// ─── Git graph collapsed rail ───────────────────────────────────────

interface Commit {
  sha: string;
  subject: string;
  author: string;
  ts: number;
}

const GIT_LAST_SEEN_KEY = (slug: string) => `harness.git.lastSeen.${slug}`;

export function CollapsedGitRail({ slug, onExpand }: { slug: string; onExpand: () => void }) {
  const [commits, setCommits] = useState<Commit[]>(() => (getCachedGitLog(slug, 300) as Commit[]) ?? []);
  const [lastSeen, setLastSeen] = useState<number>(0);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(GIT_LAST_SEEN_KEY(slug));
      setLastSeen(raw ? Number(raw) : 0);
    } catch {}
  }, [slug]);

  const load = useCallback(async () => {
    try {
      const cs = await fetchGitLog(slug, 300);
      setCommits(cs as Commit[]);
    } catch {}
  }, [slug]);

  useEffect(() => {
    const cached = getCachedGitLog(slug, 300);
    if (cached) setCommits(cached as Commit[]);
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [load, slug]);

  // Unread commits = commits newer than lastSeen
  const unreadCount = useMemo(
    () => commits.filter((c) => c.ts > lastSeen).length,
    [commits, lastSeen],
  );

  // Sparkline buckets: 12 × 5-minute buckets over the last hour
  const buckets = useMemo(() => {
    const now = Date.now();
    const BUCKET_MS = 5 * 60_000;
    const N = 12;
    const arr = new Array<number>(N).fill(0);
    for (const c of commits) {
      const age = now - c.ts;
      if (age < 0 || age > N * BUCKET_MS) continue;
      const idx = N - 1 - Math.floor(age / BUCKET_MS);
      if (idx >= 0 && idx < N) arr[idx]++;
    }
    return arr;
  }, [commits]);

  const maxBucket = Math.max(1, ...buckets);
  const latest = commits[0];

  const handleExpand = () => {
    if (latest) {
      try { localStorage.setItem(GIT_LAST_SEEN_KEY(slug), String(latest.ts)); } catch {}
    }
    setLastSeen(latest?.ts ?? Date.now());
    onExpand();
  };

  return (
    <button
      onClick={handleExpand}
      title={`Git graph · ${unreadCount > 0 ? `${unreadCount} new commits` : 'up to date'}${latest ? ` · latest: ${latest.subject.slice(0, 60)}` : ''}`}
      style={{
        width: RAIL_WIDTH,
        height: '100%',
        flexShrink: 0,
        background: 'var(--bg-2)',
        border: '1px solid var(--border)',
        borderRadius: 6,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 8,
        padding: '8px 4px',
        cursor: 'pointer',
        transition: 'background 120ms',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = 'color-mix(in oklab, var(--bg-2), white 3%)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--bg-2)'; }}
    >
      {/* Icon */}
      <div style={{
        fontSize: 18,
        color: COLORS.textMuted,
        fontFamily: FONTS.mono,
        lineHeight: 1,
        userSelect: 'none',
      }}>⎇</div>

      {/* Unread badge */}
      {unreadCount > 0 && (
        <div style={{
          minWidth: 20,
          padding: '1px 4px',
          background: COLORS.accent,
          color: 'white',
          borderRadius: 10,
          fontSize: '0.6rem',
          fontWeight: 600,
          fontFamily: FONTS.mono,
          textAlign: 'center',
          lineHeight: 1.2,
        }}>+{unreadCount}</div>
      )}

      {/* Sparkline — vertical, each row = a 5-minute bucket */}
      <div style={{
        flex: 1,
        minHeight: 0,
        width: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'flex-end',
        alignItems: 'center',
        gap: 1,
      }}>
        {buckets.map((count, i) => {
          const pct = maxBucket > 0 ? (count / maxBucket) * 100 : 0;
          const age = (buckets.length - 1 - i) * 5; // minutes ago
          return (
            <div
              key={i}
              title={`${count} commit${count === 1 ? '' : 's'} ${age === 0 ? 'now' : `${age}m ago`}`}
              style={{
                width: `${Math.max(20, pct)}%`,
                height: 4,
                background: count > 0 ? COLORS.accent : 'color-mix(in oklab, var(--border), transparent 30%)',
                borderRadius: 2,
                opacity: count > 0 ? 0.5 + 0.5 * (count / maxBucket) : 0.3,
                transition: 'width 200ms, opacity 200ms',
              }}
            />
          );
        })}
      </div>

      {/* Latest timestamp */}
      {latest && (
        <div style={{
          fontSize: '0.55rem',
          color: COLORS.textDim,
          fontFamily: FONTS.mono,
          writingMode: 'vertical-rl',
          transform: 'rotate(180deg)',
          textAlign: 'center',
          lineHeight: 1,
          maxHeight: 60,
          overflow: 'hidden',
          whiteSpace: 'nowrap',
        }}>
          {fmtAgo(Date.now() - latest.ts)}
        </div>
      )}
    </button>
  );
}

// ─── Inbox collapsed rail ───────────────────────────────────────────

export function CollapsedInboxRail({ slug, onExpand }: { slug: string; onExpand: () => void }) {
  const [reviewCount, setReviewCount] = useState(0);

  useEffect(() => {
    const load = async () => {
      try {
        const d = await fetch(`/api/harness/${slug}/reviews`).then((r) => r.json());
        setReviewCount((d.reviews ?? []).length);
      } catch {}
    };
    load();
    const t = setInterval(load, 5_000);
    return () => clearInterval(t);
  }, [slug]);

  return (
    <button
      onClick={onExpand}
      title={`Inbox${reviewCount > 0 ? ` · ${reviewCount} pending` : ''}`}
      style={{
        width: RAIL_WIDTH,
        height: '100%',
        flexShrink: 0,
        background: 'var(--bg-2)',
        border: `1px solid ${reviewCount > 0 ? STATUS.blocked.solid : 'var(--border)'}`,
        borderRadius: 6,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 8,
        padding: '8px 4px',
        cursor: 'pointer',
        transition: 'background 120ms',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = 'color-mix(in oklab, var(--bg-2), white 3%)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--bg-2)'; }}
    >
      <div style={{ fontSize: 18, lineHeight: 1, userSelect: 'none' }}>📥</div>
      {reviewCount > 0 && (
        <div style={{
          minWidth: 20,
          padding: '1px 4px',
          background: STATUS.blocked.solid,
          color: 'white',
          borderRadius: 10,
          fontSize: '0.6rem',
          fontWeight: 600,
          fontFamily: FONTS.mono,
          textAlign: 'center',
          lineHeight: 1.2,
        }}>{reviewCount}</div>
      )}
      <div style={{
        flex: 1,
        fontSize: '0.55rem',
        color: COLORS.textDim,
        fontFamily: FONTS.mono,
        writingMode: 'vertical-rl',
        transform: 'rotate(180deg)',
        textAlign: 'center',
        lineHeight: 1,
        whiteSpace: 'nowrap',
      }}>
        inbox
      </div>
    </button>
  );
}

function fmtAgo(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h`;
}
