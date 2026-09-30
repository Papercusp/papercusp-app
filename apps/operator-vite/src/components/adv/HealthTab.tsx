/**
 * HealthTab — the read-only system Health dashboard
 * (system-health-tab-2026-06-15 P-004 / P-005, D-002/D-003;
 *  v2: health-tab-v2-2026-07-12 P-007 / P-013 / P-014).
 *
 * A live at-a-glance view of the whole running system: each panel is a
 * green/yellow/red status card (a light + a one-line summary + 3-5 counters +
 * a drill-down link to the existing detail surface). The goal is "is the system
 * healthy, and if not, which panel is red?" in two seconds — NOT a metrics dump.
 *
 * READ-ONLY (D-002) with ONE deliberate v2 amendment (D-A): a panel can be
 * ACKNOWLEDGED — a view-level judgment about attention (muted + excluded from
 * the overall light until recovery), never an operational control. Structural
 * controls (start/stop, restart, deploy) still live in their own surfaces.
 *
 * v2 additions:
 *  - history strips + "since" chips (P-007): `health.history` renders a 24h
 *    worst-status strip per card and dates every non-ok status, so "is this red
 *    NEW?" is answerable at a glance;
 *  - client-side staleness (P-013): the tab keeps its own clock — a snapshot
 *    older than ~3 ticks renders a loud STALE banner instead of silently
 *    showing old data (the 2026-07-12 40-minute tick freeze is the poster
 *    child: an open tab looked live the whole time);
 *  - expandable cards (P-014): click a card for the raw structured reading,
 *    non-ok reasons, its recent transitions, and the ack control. Expansion
 *    state lives in the URL (nuqs `healthPanel`) per the nuqs mandate.
 *
 * Reads the `health.snapshot` + `health.history` sync resolvers (SSE-live, the
 * ~30s system-health tick behind both). Renders a graceful empty state until a
 * recognizable snapshot arrives (loading / flag off / error), like the
 * LearningInfraHealthChip — a health surface must never add noise of its own.
 */
import { useEffect, useMemo, useState } from 'react';
import { useQueryState, parseAsString } from 'nuqs';
import { useSyncQuery } from '@papercusp/sync';
import { ArrowUpRight, HeartPulse } from 'lucide-react';
import { Tooltip } from '@/app/harness/Tooltip';
import { CATEGORICAL, TONE as THEME_TONE } from '@/app/harness/theme';
import {
  PANEL_ORDER,
  type SystemHealth,
  type HealthPanel,
  type HealthMetric,
  type PanelStatus,
} from '@papercusp/operator-core/lib/system-health/types';

const TONE: Record<PanelStatus, string> = { ok: 'good', warn: 'warn', crit: 'bad', unknown: 'mute' };

const OVERALL_LABEL: Record<PanelStatus, string> = {
  ok: 'All systems healthy',
  warn: 'Needs a look',
  crit: 'Action needed',
  unknown: 'Status unknown',
};

/** A snapshot older than this renders the STALE banner (≈6× the 30s tick). */
const STALE_AFTER_MS = 3 * 60_000;

// Local mirror of the `health.history` payload (system-health/history.ts).
// Type-only mirror on purpose: the client boundary keeps server modules out.
interface HealthHistoryRow {
  windowMs: number;
  bucketMs: number;
  strips: Record<string, Array<PanelStatus | null>>;
  overallStrip: Array<PanelStatus | null>;
  since: Record<string, number | null>;
  transitions: Array<{ panel: string; from: PanelStatus; to: PanelStatus; summary: string | null; at: number }>;
}

function checkedAgo(evaluatedAt: number, nowMs: number): string {
  const sec = Math.max(0, (nowMs - evaluatedAt) / 1000);
  if (sec < 60) return `${Math.round(sec)}s ago`;
  const min = sec / 60;
  if (min < 90) return `${Math.round(min)}m ago`;
  return `${Math.round(min / 60)}h ago`;
}

function sinceLabel(at: number | null | undefined, nowMs: number): string | null {
  if (at == null) return 'for 24h+';
  const min = Math.max(0, (nowMs - at) / 60_000);
  if (min < 1) return 'just now';
  if (min < 90) return `for ${Math.round(min)}m`;
  if (min < 36 * 60) return `for ${Math.round(min / 60)}h`;
  return `for ${Math.round(min / (24 * 60))}d`;
}

/** Unwrap a /api/agent-tools/* response (MCP content envelope or plain JSON). */
function unwrapTool(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') {
    const content = (raw as { content?: Array<{ text?: string }> }).content;
    const text = Array.isArray(content) ? content[0]?.text : undefined;
    if (typeof text === 'string') {
      try {
        return JSON.parse(text) as Record<string, unknown>;
      } catch {
        return {};
      }
    }
    return raw as Record<string, unknown>;
  }
  return {};
}

export default function HealthTab() {
  const sync = useSyncQuery<SystemHealth>({ queryName: 'health.snapshot', args: {}, staleTime: 15_000 });
  const historySync = useSyncQuery<HealthHistoryRow>({ queryName: 'health.history', args: {}, staleTime: 60_000 });
  const [, setTab] = useQueryState('tab', parseAsString);
  const [expandedKey, setExpandedKey] = useQueryState('healthPanel', parseAsString);
  const health = sync.data?.[0];
  // Shape-guard the history row (fail-soft, D-B): the tab must degrade to
  // snapshot-only on a malformed/absent history payload, never crash — the
  // resolver already returns [] on any read error, this guards drift too.
  const rawHistory = historySync.data?.[0];
  const history: HealthHistoryRow | null =
    rawHistory && typeof rawHistory === 'object' &&
    typeof (rawHistory as HealthHistoryRow).since === 'object' && (rawHistory as HealthHistoryRow).since !== null &&
    typeof (rawHistory as HealthHistoryRow).strips === 'object' && (rawHistory as HealthHistoryRow).strips !== null
      ? rawHistory
      : null;

  // P-013: the tab keeps its OWN clock so "checked Xs ago" ticks between SSE
  // pushes — and so a frozen health tick (no pushes at all) turns the tab
  // loudly STALE instead of silently rendering old data forever.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 15_000);
    return () => clearInterval(id);
  }, []);

  const stale = health ? nowMs - health.evaluatedAt > STALE_AFTER_MS : false;

  const overallSince = useMemo(() => {
    if (!health || !history || health.overall === 'ok' || health.overall === 'unknown') return null;
    let earliest: number | null | undefined;
    for (const key of PANEL_ORDER) {
      const p = health.panels[key];
      if (!p || p.status !== health.overall || p.ack) continue;
      const s = history.since[key];
      if (earliest === undefined || (s ?? 0) < (earliest ?? 0)) earliest = s;
    }
    return earliest === undefined ? null : sinceLabel(earliest, nowMs);
  }, [health, history, nowMs]);

  if (!health) {
    return (
      <div className="pc-health pc-health--empty">
        <div className="pc-health__placeholder">
          {sync.error ? `Health unavailable — ${String(sync.error)}` : sync.loading ? 'Loading system health…' : 'System health is disabled.'}
        </div>
        <HealthStyles />
      </div>
    );
  }

  // In-app tab switch for /adv?tab=… drill-downs; let other routes navigate normally.
  const onLink = (href: string) => (e: React.MouseEvent) => {
    const m = href.match(/^\/adv\?tab=([\w-]+)/);
    if (m) {
      e.preventDefault();
      void setTab(m[1]);
    }
  };

  const panels = PANEL_ORDER.map((k) => health.panels[k]).filter(Boolean) as HealthPanel[];
  const alarming = panels.filter((p) => !p.ack);
  const crit = alarming.filter((p) => p.status === 'crit').length;
  const warn = alarming.filter((p) => p.status === 'warn').length;
  const acked = panels.filter((p) => p.ack).length;
  const overallTone = TONE[health.overall];

  const invalidateAll = () => {
    sync.invalidate?.();
    historySync.invalidate?.();
  };

  return (
    <div className="pc-health">
      {stale && (
        <div className="pc-health__stale" role="alert">
          SNAPSHOT STALE — last computed {checkedAgo(health.evaluatedAt, nowMs)}. The health tick may be
          frozen (routine engine / bg host); the readings below are OLD.
        </div>
      )}
      <header className="pc-health__bar" data-tone={stale ? 'mute' : overallTone}>
        <span className={`pc-health__dot pc-health__dot--${stale ? 'mute' : overallTone}`} aria-hidden />
        <HeartPulse size={15} aria-hidden />
        <span className="pc-health__overall">
          {OVERALL_LABEL[health.overall]}
          {overallSince ? <span className="pc-health__since"> {overallSince}</span> : null}
        </span>
        <div className="pc-health__counts">
          {crit > 0 && <span className="pc-health__count pc-health__count--bad">{crit} red</span>}
          {warn > 0 && <span className="pc-health__count pc-health__count--warn">{warn} yellow</span>}
          {crit === 0 && warn === 0 && <span className="pc-health__count pc-health__count--good">all green</span>}
          {acked > 0 && <span className="pc-health__count">{acked} ack’d</span>}
        </div>
        <span className="pc-health__spacer" />
        {history?.overallStrip && <Strip cells={history.overallStrip} wide />}
        <span className="pc-health__checked">checked {checkedAgo(health.evaluatedAt, nowMs)}</span>
      </header>

      <div className={`pc-health__grid${stale ? ' pc-health__grid--stale' : ''}`}>
        {panels.map((p) => (
          <HealthCard
            key={p.key}
            panel={p}
            onLink={onLink}
            nowMs={nowMs}
            strip={history?.strips?.[p.key] ?? null}
            since={p.status !== 'ok' && p.status !== 'unknown' ? sinceLabel(history?.since?.[p.key], nowMs) : null}
            expanded={expandedKey === p.key}
            transitions={history?.transitions?.filter((t) => t.panel === p.key).slice(0, 8) ?? []}
            onToggle={() => void setExpandedKey(expandedKey === p.key ? null : p.key)}
            onChanged={invalidateAll}
          />
        ))}
      </div>

      <HealthStyles />
    </div>
  );
}

function Strip({ cells, wide }: { cells: Array<PanelStatus | null>; wide?: boolean }) {
  return (
    <span className={`pc-hstrip${wide ? ' pc-hstrip--wide' : ''}`} aria-label="24h status history" title="last 24h, oldest → newest">
      {cells.map((c, i) => (
        <span key={i} className={`pc-hstrip__cell pc-hstrip__cell--${c === null ? 'none' : TONE[c]}`} />
      ))}
    </span>
  );
}

function HealthCard({
  panel,
  onLink,
  nowMs,
  strip,
  since,
  expanded,
  transitions,
  onToggle,
  onChanged,
}: {
  panel: HealthPanel;
  onLink: (href: string) => (e: React.MouseEvent) => void;
  nowMs: number;
  strip: Array<PanelStatus | null> | null;
  since: string | null;
  expanded: boolean;
  transitions: Array<{ from: PanelStatus; to: PanelStatus; summary: string | null; at: number }>;
  onToggle: () => void;
  onChanged: () => void;
}) {
  const tone = TONE[panel.status];
  const [ackOpen, setAckOpen] = useState(false);
  const [ackReason, setAckReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const callAck = async (mode: 'ack' | 'unack') => {
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch(`/api/agent-tools/health/${mode}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(mode === 'ack' ? { panel: panel.key, reason: ackReason.trim(), ackedBy: 'owner' } : { panel: panel.key }),
      });
      const out = unwrapTool(await res.json().catch(() => ({})));
      if (!res.ok || out.ok === false) throw new Error(String(out.error ?? `HTTP ${res.status}`));
      setAckOpen(false);
      setAckReason('');
      onChanged();
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const reasons: string[] = (() => {
    const d = panel.data as { gateway?: { reasons?: unknown } } | null;
    const r = d?.gateway?.reasons;
    return Array.isArray(r) ? r.filter((x): x is string => typeof x === 'string') : [];
  })();

  return (
    <section
      className={`pc-hcard pc-hcard--${tone}${panel.ack ? ' pc-hcard--acked' : ''}${expanded ? ' pc-hcard--expanded' : ''}`}
      data-panel={panel.key}
    >
      <div className="pc-hcard__head">
        <span className={`pc-hcard__dot pc-hcard__dot--${tone}`} aria-hidden title={panel.status} />
        <button type="button" className="pc-hcard__title" onClick={onToggle} aria-expanded={expanded}>
          {panel.label}
        </button>
        {since && <span className="pc-hcard__since">{panel.status} {since}</span>}
        {panel.link && (
          <Tooltip label={`Open ${panel.link.label}`}>
            <a
              className="pc-hcard__link"
              href={panel.link.href}
              onClick={onLink(panel.link.href)}
              aria-label={`Open ${panel.link.label}`}
            >
              <ArrowUpRight size={12} aria-hidden />
            </a>
          </Tooltip>
        )}
      </div>
      {panel.ack && (
        <div className="pc-hcard__ack" title={`acknowledged by ${panel.ack.ackedBy}`}>
          ACK’D — {panel.ack.reason}
        </div>
      )}
      <div className="pc-hcard__summary" title={panel.error ?? panel.summary}>
        {panel.summary}
      </div>
      {panel.metrics.length > 0 && (
        <div className="pc-hcard__metrics">
          {panel.metrics.map((mt: HealthMetric, i: number) => (
            <span key={i} className="pc-hcard__m" data-tone={mt.tone ? TONE[mt.tone] : undefined}>
              <b>{mt.value}</b>
              <span>{mt.label}</span>
            </span>
          ))}
        </div>
      )}
      {strip && <Strip cells={strip} />}
      {expanded && (
        <div className="pc-hcard__detail">
          {reasons.length > 0 && (
            <ul className="pc-hcard__reasons">
              {reasons.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          )}
          {transitions.length > 0 && (
            <div className="pc-hcard__transitions">
              {transitions.map((t, i) => (
                <div key={i} className="pc-hcard__transition">
                  <span data-tone={TONE[t.to]}>{t.from} → {t.to}</span>
                  <span className="pc-hcard__transition-at">{checkedAgo(t.at, nowMs)}</span>
                  {t.summary && <span className="pc-hcard__transition-sum">{t.summary}</span>}
                </div>
              ))}
            </div>
          )}
          <div className="pc-hcard__actions">
            {panel.ack ? (
              <button type="button" className="pc-hcard__btn" disabled={busy} onClick={() => void callAck('unack')}>
                un-acknowledge
              </button>
            ) : panel.status === 'warn' || panel.status === 'crit' ? (
              ackOpen ? (
                <>
                  <input
                    className="pc-hcard__ackinput"
                    value={ackReason}
                    placeholder="why is this accepted?"
                    onChange={(e) => setAckReason(e.target.value)}
                  />
                  <button
                    type="button"
                    className="pc-hcard__btn"
                    disabled={busy || ackReason.trim().length < 3}
                    onClick={() => void callAck('ack')}
                  >
                    acknowledge
                  </button>
                  <button type="button" className="pc-hcard__btn" disabled={busy} onClick={() => setAckOpen(false)}>
                    cancel
                  </button>
                </>
              ) : (
                <button type="button" className="pc-hcard__btn" onClick={() => setAckOpen(true)}>
                  acknowledge…
                </button>
              )
            ) : null}
            {note && <span className="pc-hcard__note">{note}</span>}
          </div>
          {panel.data != null && (
            <pre className="pc-hcard__data">{JSON.stringify(panel.data, null, 2).slice(0, 4000)}</pre>
          )}
        </div>
      )}
    </section>
  );
}

function HealthStyles() {
  return (
    <style>{`
      .pc-health {
        display: flex; flex-direction: column; gap: 9px;
        min-height: 0; flex: 1; padding: 11px 13px 15px;
      }
      .pc-health--empty { align-items: center; justify-content: center; }
      .pc-health__placeholder { color: var(--fg-mute, #7f9bb4); font-size: 13px; padding: 40px; }

      /* P-013: stale-snapshot banner */
      .pc-health__stale {
        padding: 7px 11px; border-radius: 9px; font-size: 11px; font-weight: 700;
        letter-spacing: 0; color: #fca5a5;
        border: 1px solid rgba(244, 63, 94, 0.55); background: rgba(244, 63, 94, 0.12);
      }
      .pc-health__grid--stale { opacity: 0.55; filter: saturate(0.6); }

      /* Overall status bar */
      .pc-health__bar {
        display: flex; align-items: center; gap: 8px;
        padding: 6px 11px; border-radius: 9px;
        border: 1px solid var(--border, rgba(125, 211, 252, 0.16));
        background: var(--bg-2, rgba(255, 255, 255, 0.04));
      }
      .pc-health__bar[data-tone='bad'] { border-color: rgba(244, 63, 94, 0.45); background: rgba(244, 63, 94, 0.08); }
      .pc-health__bar[data-tone='warn'] { border-color: rgba(251, 191, 36, 0.4); background: rgba(251, 191, 36, 0.06); }
      .pc-health__bar svg { color: var(--fg-dim, #b9d4e8); }
      .pc-health__overall { font-size: 12px; font-weight: 760; letter-spacing: 0; color: var(--fg, #e7f7ff); }
      .pc-health__since { font-weight: 600; color: var(--fg-mute, #7f9bb4); }
      .pc-health__counts { display: flex; gap: 5px; }
      .pc-health__count {
        font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0;
        padding: 1px 7px; border-radius: 999px;
        border: 1px solid var(--border, rgba(125, 211, 252, 0.2)); color: var(--fg-mute, #7f9bb4);
      }
      .pc-health__count--bad { color: #fca5a5; border-color: rgba(244, 63, 94, 0.5); background: rgba(244, 63, 94, 0.12); }
      .pc-health__count--warn { color: #fcd34d; border-color: rgba(251, 191, 36, 0.5); background: rgba(251, 191, 36, 0.12); }
      .pc-health__count--good { color: #6ee7b7; border-color: rgba(52, 211, 153, 0.45); background: rgba(52, 211, 153, 0.1); }
      .pc-health__spacer { flex: 1; }
      .pc-health__checked { font-size: 10px; color: var(--fg-mute, #7f9bb4); font-variant-numeric: tabular-nums; }
      .pc-health__dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
      .pc-health__dot--good { background: ${THEME_TONE.good}; }
      .pc-health__dot--warn { background: ${THEME_TONE.warn}; }
      .pc-health__dot--bad { background: ${THEME_TONE.bad}; }
      .pc-health__dot--mute { background: ${CATEGORICAL.slate500.hex}; }

      /* P-007: 24h status strips */
      .pc-hstrip { display: inline-flex; gap: 1px; align-items: center; height: 5px; margin-top: 2px; }
      .pc-hstrip--wide { height: 7px; min-width: 144px; margin: 0 6px; }
      .pc-hstrip__cell { flex: 1; min-width: 2px; height: 100%; border-radius: 1px; background: rgba(148, 163, 184, 0.15); }
      .pc-hstrip__cell--good { background: rgb(from ${THEME_TONE.good} r g b / 0.75); }
      .pc-hstrip__cell--warn { background: rgb(from ${THEME_TONE.warn} r g b / 0.85); }
      .pc-hstrip__cell--bad { background: rgb(from ${THEME_TONE.bad} r g b / 0.9); }
      .pc-hstrip__cell--mute { background: rgba(148, 163, 184, 0.35); }
      .pc-hstrip__cell--none { background: rgba(148, 163, 184, 0.12); }

      /* Dense card grid — flat cards with a left status-stripe (compact pass) */
      .pc-health__grid {
        display: grid; grid-template-columns: repeat(auto-fill, minmax(208px, 1fr));
        gap: 7px; align-content: start;
      }
      .pc-hcard {
        display: flex; flex-direction: column; gap: 4px;
        padding: 7px 10px 8px; border-radius: 8px;
        border: 1px solid var(--border, rgba(125, 211, 252, 0.13));
        border-left: 3px solid var(--card-accent, #475569);
        background: var(--bg-2, rgba(255, 255, 255, 0.035));
      }
      .pc-hcard--good { --card-accent: ${THEME_TONE.good}; }
      .pc-hcard--warn { --card-accent: ${THEME_TONE.warn}; }
      .pc-hcard--bad { --card-accent: ${THEME_TONE.bad}; }
      .pc-hcard--mute { --card-accent: ${CATEGORICAL.slate500.hex}; opacity: 0.72; }
      .pc-hcard--acked { opacity: 0.6; border-left-style: dashed; }
      .pc-hcard--expanded { grid-column: 1 / -1; }
      .pc-hcard__head { display: flex; align-items: center; gap: 6px; }
      .pc-hcard__title {
        font-size: 10.5px; font-weight: 750; letter-spacing: 0; text-transform: uppercase;
        color: var(--fg, #e7f7ff); flex: 1; min-width: 0; text-align: left;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        background: none; border: none; padding: 0; cursor: pointer; font-family: inherit;
      }
      .pc-hcard__since {
        font-size: 9px; font-weight: 700; text-transform: uppercase; white-space: nowrap;
        color: var(--fg-mute, #7f9bb4); font-variant-numeric: tabular-nums;
      }
      .pc-hcard__ack {
        font-size: 9.5px; font-weight: 700; color: var(--fg-mute, #7f9bb4);
        border: 1px dashed var(--border, rgba(125, 211, 252, 0.25)); border-radius: 5px;
        padding: 2px 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .pc-hcard__dot--good { background: ${THEME_TONE.good}; box-shadow: 0 0 5px rgb(from ${THEME_TONE.good} r g b / 0.7); }
      .pc-hcard__dot--warn { background: ${THEME_TONE.warn}; box-shadow: 0 0 5px rgb(from ${THEME_TONE.warn} r g b / 0.6); }
      .pc-hcard__dot--bad { background: ${THEME_TONE.bad}; box-shadow: 0 0 6px rgb(from ${THEME_TONE.bad} r g b / 0.7); }
      .pc-hcard__dot--mute { background: ${CATEGORICAL.slate500.hex}; }
      .pc-hcard__dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
      .pc-hcard__link {
        display: inline-flex; align-items: center; flex-shrink: 0;
        color: var(--fg-mute, #7f9bb4); text-decoration: none; opacity: 0.7;
      }
      .pc-hcard__link:hover { color: var(--fg, #e7f7ff); opacity: 1; }
      .pc-hcard__summary {
        font-size: 10.5px; line-height: 1.3; color: var(--fg-dim, #b9d4e8);
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .pc-hcard--expanded .pc-hcard__summary { white-space: normal; }
      .pc-hcard__metrics { display: flex; flex-wrap: wrap; gap: 1px 9px; }
      .pc-hcard__m {
        display: inline-flex; align-items: baseline; gap: 3px;
        font-size: 9.5px; color: var(--fg-mute, #7f9bb4); white-space: nowrap;
      }
      .pc-hcard__m b {
        font-size: 11px; font-weight: 740; color: var(--fg, #e7f7ff);
        font-variant-numeric: tabular-nums;
      }
      .pc-hcard__m span { text-transform: uppercase; letter-spacing: 0; font-weight: 600; }
      .pc-hcard__m[data-tone='bad'] b { color: #fca5a5; }
      .pc-hcard__m[data-tone='warn'] b { color: #fcd34d; }
      .pc-hcard__m[data-tone='mute'] { opacity: 0.6; }

      /* P-014: expanded detail */
      .pc-hcard__detail { display: flex; flex-direction: column; gap: 6px; margin-top: 4px; }
      .pc-hcard__reasons { margin: 0; padding-left: 16px; font-size: 10.5px; color: #fcd34d; }
      .pc-hcard__transitions { display: flex; flex-direction: column; gap: 2px; }
      .pc-hcard__transition {
        display: flex; gap: 8px; align-items: baseline; font-size: 10px;
        color: var(--fg-dim, #b9d4e8); font-variant-numeric: tabular-nums;
      }
      .pc-hcard__transition [data-tone='bad'] { color: #fca5a5; }
      .pc-hcard__transition [data-tone='warn'] { color: #fcd34d; }
      .pc-hcard__transition [data-tone='good'] { color: #6ee7b7; }
      .pc-hcard__transition-at { color: var(--fg-mute, #7f9bb4); }
      .pc-hcard__transition-sum { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
      .pc-hcard__actions { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
      .pc-hcard__btn {
        font-size: 10px; font-weight: 700; text-transform: uppercase; cursor: pointer;
        padding: 2px 8px; border-radius: 6px; color: var(--fg-dim, #b9d4e8);
        border: 1px solid var(--border, rgba(125, 211, 252, 0.25)); background: transparent;
        font-family: inherit;
      }
      .pc-hcard__btn:hover:not(:disabled) { color: var(--fg, #e7f7ff); }
      .pc-hcard__btn:disabled { opacity: 0.5; cursor: default; }
      .pc-hcard__ackinput {
        flex: 1; min-width: 140px; font-size: 11px; font-family: inherit;
        padding: 2px 7px; border-radius: 6px; color: var(--fg, #e7f7ff);
        border: 1px solid var(--border, rgba(125, 211, 252, 0.25)); background: rgba(255,255,255,0.04);
      }
      .pc-hcard__note { font-size: 10px; color: #fca5a5; }
      .pc-hcard__data {
        margin: 0; font-size: 9.5px; line-height: 1.35; color: var(--fg-mute, #7f9bb4);
        max-height: 260px; overflow: auto; border-radius: 6px; padding: 7px 9px;
        border: 1px solid var(--border, rgba(125, 211, 252, 0.12)); background: rgba(0,0,0,0.18);
      }
    `}</style>
  );
}
