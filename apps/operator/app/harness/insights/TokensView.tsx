'use client';

/**
 * TokensView — the Insights → Tokens subtab (B-TOK-UI,
 * token-tracking-plan-and-briefs-2026-06-20).
 *
 * The SIBLING of the SpendCard's single headline total: this surfaces the same
 * CACHE-INCLUSIVE spend (input + output + cache_read + cache_creation — the
 * B-TOK-2 fix for the ~5× undercount) broken DOWN by model, role, and day so the
 * owner can see WHERE the burn is. The 24h audit that motivated this plan found
 * opus = 90% of spend and cache-read = 82% of all tokens — both invisible in the
 * old input+output-only number.
 *
 * Self-fetching (the LearningTab `?lview` model): reads through the
 * `insights.tokens` sync resolver via useSyncQuery, scoped to ONE harness slug.
 * Fetch-on-mount + a manual Refresh, matching the /adv no-polling ethos. Degrades
 * to a clean empty state when the substrate has no samples yet (the resolver/loader
 * never 500s).
 *
 * Per-account attribution is NOT yet captured on agent_usage_samples (routing is
 * gateway-layer state), so the brief's "by account" axis renders an honest note
 * rather than a fabricated breakdown.
 */

import type { CSSProperties, ReactNode } from 'react';
import { Coins, RefreshCw, Cpu, UserRound, CalendarDays, Info } from 'lucide-react';
import { useSyncQuery } from '@papercusp/sync';
import type { TokensDashboardSnapshot, TokenGroupRow } from '@papercusp/operator-core/lib/harness-insights/card-types';

// ─── number formatting (matches SpendCard's idiom) ──────────────────
function formatUsd(n: number): string {
  return n < 1 ? `$${n.toFixed(2)}` : n < 100 ? `$${n.toFixed(1)}` : `$${Math.round(n).toLocaleString()}`;
}
function formatTokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return `${n}`;
}
function pct(part: number, whole: number): string {
  if (whole <= 0) return '0%';
  return `${Math.round((part / whole) * 100)}%`;
}

// ─── styles (CSS-var tokens, matching SpendCard / InsightsTab) ──────
const WRAP: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 16, padding: 16 };
const HEAD: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 };
const TITLE: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, fontSize: 15, fontWeight: 600, color: 'var(--fg)' };
const SUB: CSSProperties = { fontSize: 12, color: 'var(--fg-dim)' };
const REFRESH: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12,
  border: '1px solid var(--border)', background: 'var(--bg-1)', color: 'var(--fg-dim)',
  borderRadius: 6, padding: '4px 8px', cursor: 'pointer',
};
const SCOREBOARD: CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 12 };
const STAT_CARD: CSSProperties = {
  border: '1px solid var(--border)', background: 'var(--bg-1)', borderRadius: 8, padding: 16,
  display: 'flex', flexDirection: 'column', gap: 2,
};
const STAT_VAL: CSSProperties = { fontSize: 22, fontWeight: 600, color: 'var(--fg)' };
const STAT_LABEL: CSSProperties = { fontSize: 11, color: 'var(--fg-dim)' };
const CARD: CSSProperties = {
  border: '1px solid var(--border)', background: 'var(--bg-1)', borderRadius: 8, padding: 16,
  display: 'flex', flexDirection: 'column', gap: 10,
};
const CARD_HEAD: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 600, color: 'var(--fg)' };
const ROW: CSSProperties = { display: 'flex', alignItems: 'center', gap: 10, fontSize: 13 };
const ROW_KEY: CSSProperties = { flex: '0 0 34%', color: 'var(--fg)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
const BAR_TRACK: CSSProperties = { flex: 1, height: 8, borderRadius: 4, background: 'var(--bg-2)', overflow: 'hidden' };
const ROW_NUM: CSSProperties = { flex: '0 0 auto', color: 'var(--fg-dim)', fontVariantNumeric: 'tabular-nums', minWidth: 56, textAlign: 'right' };
const NOTE: CSSProperties = {
  display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 12, lineHeight: 1.5,
  padding: '8px 12px', borderRadius: 6, background: 'var(--bg-2)', color: 'var(--fg-dim)',
};
const EMPTY: CSSProperties = {
  border: '1px dashed var(--border)', borderRadius: 8, padding: 24, textAlign: 'center',
  color: 'var(--fg-dim)', fontSize: 13, display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'center',
};

function Stat({ value, label, testid }: { value: string; label: string; testid?: string }) {
  return (
    <div style={STAT_CARD} data-testid={testid}>
      <div style={STAT_VAL}>{value}</div>
      <div style={STAT_LABEL}>{label}</div>
    </div>
  );
}

/** A grouped breakdown table — each row a proportion bar sized by token share. */
function Breakdown({
  title,
  icon,
  rows,
  totalTokens,
  emptyHint,
  testid,
}: {
  title: string;
  icon: ReactNode;
  rows: TokenGroupRow[];
  totalTokens: number;
  emptyHint: string;
  testid: string;
}) {
  const max = rows.reduce((m, r) => Math.max(m, r.tokens), 0);
  return (
    <div style={CARD} data-testid={testid}>
      <div style={CARD_HEAD}>
        {icon}
        {title}
      </div>
      {rows.length === 0 ? (
        <div style={{ ...SUB, padding: '4px 0' }}>{emptyHint}</div>
      ) : (
        rows.map((r) => (
          <div key={r.key} style={ROW} title={`${formatTokens(r.tokens)} tokens · ${formatUsd(r.costUsd)} · ${r.runs} runs · ${pct(r.tokens, totalTokens)} of tokens`}>
            <span style={ROW_KEY}>{r.key}</span>
            <span style={BAR_TRACK}>
              <span
                style={{
                  display: 'block',
                  height: '100%',
                  width: max > 0 ? `${Math.max(2, (r.tokens / max) * 100)}%` : '0%',
                  background: 'var(--accent, #6366f1)',
                  borderRadius: 4,
                }}
              />
            </span>
            <span style={ROW_NUM}>{formatTokens(r.tokens)}</span>
            <span style={{ ...ROW_NUM, minWidth: 52 }}>{formatUsd(r.costUsd)}</span>
          </div>
        ))
      )}
    </div>
  );
}

/** Daily token trend — inline bars, ascending by day. */
function DayTrend({ snapshot }: { snapshot: TokensDashboardSnapshot }) {
  const days = snapshot.byDay;
  const max = days.reduce((m, d) => Math.max(m, d.tokens), 0);
  return (
    <div style={CARD} data-testid="tokens-by-day">
      <div style={CARD_HEAD}>
        <CalendarDays size={14} aria-hidden /> By day
      </div>
      {days.length === 0 ? (
        <div style={{ ...SUB, padding: '4px 0' }}>No samples in this window yet.</div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, height: 72 }}>
          {days.map((d) => (
            <div
              key={d.startMs}
              style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, minWidth: 0 }}
              title={`${d.label}: ${formatTokens(d.tokens)} tokens · ${formatUsd(d.costUsd)}`}
            >
              <span
                style={{
                  width: '100%',
                  height: max > 0 ? `${Math.max(3, (d.tokens / max) * 56)}px` : '3px',
                  background: 'var(--accent, #6366f1)',
                  borderRadius: '3px 3px 0 0',
                }}
              />
              <span style={{ fontSize: 9, color: 'var(--fg-dim)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%' }}>
                {d.label}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function TokensView({ slug }: { slug: string }): ReactNode {
  const sync = useSyncQuery<TokensDashboardSnapshot>({
    queryName: 'insights.tokens',
    args: { harness: slug },
    staleTime: 30_000,
    enabled: !!slug,
  });
  const snap = sync.data?.[0];

  const cacheReadShare = snap ? pct(snap.totals.cacheReadTokens, snap.totals.tokens) : '—';

  return (
    <div style={WRAP} data-testid="insights-tokens-view">
      <div style={HEAD}>
        <div>
          <div style={TITLE}>
            <Coins size={16} aria-hidden /> Token spend
          </div>
          <div style={SUB}>Cache-inclusive token &amp; cost burn this week, broken down by model, role, and day.</div>
        </div>
        <button
          type="button"
          style={REFRESH}
          aria-label="Reload token spend"
          disabled={sync.fetching}
          onClick={() => sync.invalidate()}
        >
          <RefreshCw size={13} aria-hidden /> Refresh
        </button>
      </div>

      {sync.loading && !snap ? (
        <div style={EMPTY}>Loading token spend…</div>
      ) : sync.error ? (
        <div style={EMPTY}>Token spend unavailable: {sync.error.message}</div>
      ) : !snap || snap.totals.runs === 0 ? (
        <div style={EMPTY} data-testid="tokens-empty">
          <Coins size={20} aria-hidden />
          <strong>No token usage recorded yet</strong>
          <span>Agent runs on this harness write per-call token + cost samples; once they land, the cache-inclusive breakdown by model, role, and day appears here.</span>
        </div>
      ) : (
        <>
          <div style={SCOREBOARD} aria-label="Token spend totals">
            <Stat value={formatUsd(snap.totals.costUsd)} label="Total spend" testid="tokens-stat-cost" />
            <Stat value={formatTokens(snap.totals.tokens)} label="Total tokens" testid="tokens-stat-tokens" />
            <Stat value={snap.totals.runs.toLocaleString()} label="Agent runs" testid="tokens-stat-runs" />
            <Stat value={cacheReadShare} label="Cache-read share" testid="tokens-stat-cache" />
          </div>

          <div style={NOTE} data-testid="tokens-cache-note">
            <Info size={14} aria-hidden style={{ flex: '0 0 auto', marginTop: 1 }} />
            <span>
              Cache-inclusive: {formatTokens(snap.totals.inputTokens)} input · {formatTokens(snap.totals.outputTokens)} output ·{' '}
              {formatTokens(snap.totals.cacheReadTokens)} cache-read · {formatTokens(snap.totals.cacheCreationTokens)} cache-create.
              {snap.totals.estimatedUsd > 0
                ? ` Includes ${formatUsd(snap.totals.estimatedUsd)} estimated from token counts (codex/OMP report no billed cost).`
                : ''}
            </span>
          </div>

          <DayTrend snapshot={snap} />

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16 }}>
            <Breakdown
              title="By model"
              icon={<Cpu size={14} aria-hidden />}
              rows={snap.byModel}
              totalTokens={snap.totals.tokens}
              emptyHint="No model attribution on these samples."
              testid="tokens-by-model"
            />
            <Breakdown
              title="By role"
              icon={<UserRound size={14} aria-hidden />}
              rows={snap.byRole}
              totalTokens={snap.totals.tokens}
              emptyHint="No role attribution on these samples."
              testid="tokens-by-role"
            />
            <Breakdown
              title="By account"
              icon={<UserRound size={14} aria-hidden />}
              rows={snap.byAccount}
              totalTokens={snap.totals.tokens}
              emptyHint="No account attribution on these samples."
              testid="tokens-by-account"
            />
          </div>

          {!snap.accountAttributionAvailable ? (
            <div style={NOTE} data-testid="tokens-account-note">
              <Info size={14} aria-hidden style={{ flex: '0 0 auto', marginTop: 1 }} />
              <span>
                Per-account attribution isn’t captured yet — account routing is gateway-layer state, not a usage-sample
                column, so spend can’t be split by Max account here. (Tracked separately from B-TOK-FIX.)
              </span>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
