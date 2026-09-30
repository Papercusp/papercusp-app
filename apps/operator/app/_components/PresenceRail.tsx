'use client';

/**
 * Live-agents rail — the Discord "member list" analog (Mod+U,
 * discord-shortcuts 2026-06-06).
 *
 * A right-side drawer with two nuqs-backed tabs (`?pres=`):
 *   • roster   — who's ONLINE right now + what each agent is DOING (intent),
 *                which plan, and which FILES they're editing.
 *   • activity — the who-did-what TIMELINE: the coordination firehose
 *                (messages / handoffs / escalations / plan-events) newest-first.
 *
 * Both surfaces push over @papercusp/sync (SSE-primary on desktop) — NO polling.
 * This replaced a 30 s `fetch('/api/coord/presence')` loop (which violated the
 * no-poll rule) with the live `dev.coordPresence` + `dev.coordFeed` sync
 * queries (shared-hive-collaboration-2026-06-14 P-006). Open + tab state live in
 * nuqs (`?members`, `?pres`) per the repo rule — deep-linkable, survives reload,
 * agent-driveable. Reuses the portable LivenessDot from the /coord dashboard.
 */
import { parseAsBoolean, parseAsStringEnum, useQueryState } from 'nuqs';
import { useSyncQuery } from '@papercusp/sync';
import { useShortcutAction } from '../../lib/hotkeys';
import { LivenessDot, livenessFromHeartbeat } from '../coord/presence-ui';

export interface PresenceRow {
  ownerId: string;
  ownerLabel: string;
  intent: string;
  currentPlanSlug: string | null;
  /** Repo-relative files the agent declared in scope (who's editing what). */
  currentFiles?: string[];
  /** Federated peers carry a view instead of a local plan slug. */
  currentView?: string | null;
  heartbeatAt: string;
}

/** One coordination envelope as `dev.coordFeed` returns it (flat row). */
export interface CoordFeedRow {
  ts: string;
  msg_id: string;
  from: string;
  to?: string[];
  kind: string;
  summary?: string;
  body?: string;
  plan_slug?: string;
  surface?: string;
  broadcast?: boolean;
}

/**
 * The "who-did-what" kinds the activity timeline shows — the action surfaces, NOT
 * the ambient subscribe/notify firehose (those are the inbox-fanout copies the
 * feed dedupes; including them would bury the signal).
 */
const ACTIVITY_KINDS = [
  'message',
  'handoff',
  'handoff_accepted',
  'escalation',
  'escalation_resolved',
  'plan_event',
  'contract',
] as const;

/** A glyph per coord kind, mirroring the coord-injection vocabulary. */
const KIND_GLYPH: Record<string, string> = {
  message: '–',
  ack: '=',
  notify: '·',
  handoff: '↦',
  handoff_accepted: '↤',
  escalation: '↑',
  escalation_resolved: '✓',
  plan_event: '~',
  contract: '⋈',
  yield: '⏸',
};

/** Short handle for an owner id: `su-4b1a8c13-…` → `su-4b1a8`; named sources pass through. */
function shortHandle(from: string): string {
  const m = /^su-([0-9a-f]{5})/.exec(from);
  return m ? `su-${m[1]}` : from;
}

/** Compact relative time for the live feed (finer than the day-granular shared helper). */
function relTime(iso: string, nowMs: number = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, Math.round((nowMs - t) / 1000));
  if (s < 10) return 'now';
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d`;
  return new Date(t).toISOString().slice(0, 10);
}

const TAB_BTN_BASE: React.CSSProperties = {
  flex: 1,
  background: 'none',
  border: 'none',
  borderBottom: '2px solid transparent',
  color: 'inherit',
  cursor: 'pointer',
  fontSize: 12,
  fontWeight: 600,
  padding: '6px 0',
  opacity: 0.6,
};

export default function PresenceRail() {
  const [open, setOpen] = useQueryState('members', parseAsBoolean.withDefault(false));
  const [tab, setTab] = useQueryState(
    'pres',
    parseAsStringEnum(['roster', 'activity']).withDefault('roster'),
  );

  useShortcutAction('panel.togglePresence', () => {
    void setOpen(!open);
  });

  // Live roster — SSE-pushed, stale rows filtered server-side. Fetches only
  // while the drawer is open.
  const roster = useSyncQuery<PresenceRow>({
    queryName: 'dev.coordPresence',
    args: {},
    enabled: open,
  });
  // Live activity timeline — only fetched on the activity tab.
  const activity = useSyncQuery<CoordFeedRow>({
    queryName: 'dev.coordFeed',
    args: { kinds: ACTIVITY_KINDS as unknown as string[], limit: 40 },
    enabled: open && tab === 'activity',
  });

  if (!open) return null;

  const rosterRows = roster.data ?? [];
  const feedRows = (activity.data ?? []).filter((r) => r && r.kind !== 'notify');
  const rosterErr = roster.error?.message ?? null;
  const activityErr = activity.error?.message ?? null;

  return (
    <aside
      aria-label="Live agents"
      data-testid="presence-rail"
      style={{
        position: 'fixed',
        top: 0,
        right: 0,
        bottom: 0,
        width: 320,
        zIndex: 900,
        background: 'var(--pc-surface, #16181d)',
        color: 'var(--pc-text, #e5e7eb)',
        borderLeft: '1px solid var(--pc-border, #2a2e37)',
        boxShadow: '-12px 0 30px rgba(0,0,0,.35)',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '10px 12px',
          borderBottom: '1px solid var(--pc-border, #2a2e37)',
        }}
      >
        <span style={{ fontSize: 13, fontWeight: 600 }}>
          Live agents{tab === 'roster' ? ` — ${rosterRows.length}` : ''}
        </span>
        <button
          type="button"
          onClick={() => void setOpen(false)}
          aria-label="Close live agents rail"
          style={{
            background: 'none',
            border: 'none',
            color: 'inherit',
            cursor: 'pointer',
            fontSize: 16,
            opacity: 0.7,
          }}
        >
          ×
        </button>
      </header>

      <div
        role="tablist"
        aria-label="Presence view"
        style={{ display: 'flex', borderBottom: '1px solid var(--pc-border, #2a2e37)' }}
      >
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'roster'}
          data-testid="presence-tab-roster"
          onClick={() => void setTab('roster')}
          style={{
            ...TAB_BTN_BASE,
            opacity: tab === 'roster' ? 1 : 0.6,
            borderBottomColor: tab === 'roster' ? 'var(--accent, #38bdf8)' : 'transparent',
          }}
        >
          Roster
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'activity'}
          data-testid="presence-tab-activity"
          onClick={() => void setTab('activity')}
          style={{
            ...TAB_BTN_BASE,
            opacity: tab === 'activity' ? 1 : 0.6,
            borderBottomColor: tab === 'activity' ? 'var(--accent, #38bdf8)' : 'transparent',
          }}
        >
          Activity
        </button>
      </div>

      <div style={{ overflowY: 'auto', flex: 1, padding: '6px 0' }}>
        {tab === 'roster' ? (
          <>
            {rosterErr && (
              <div role="alert" style={{ fontSize: 12, color: '#f87171', padding: '8px 12px' }}>
                Failed to load presence: {rosterErr}
              </div>
            )}
            {!rosterErr && rosterRows.length === 0 && (
              <div style={{ fontSize: 12, opacity: 0.6, padding: '8px 12px' }}>
                No agents active right now.
              </div>
            )}
            {rosterRows.map((r) => (
              <div
                key={r.ownerId}
                data-testid="presence-row"
                style={{ padding: '8px 12px', borderBottom: '1px solid var(--pc-border, #20242c)' }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <LivenessDot liveness={livenessFromHeartbeat(r.heartbeatAt)} />
                  <span style={{ fontSize: 12.5, fontWeight: 600 }}>{r.ownerLabel || r.ownerId}</span>
                </div>
                {r.intent && (
                  <div
                    style={{
                      fontSize: 11.5,
                      opacity: 0.75,
                      marginTop: 3,
                      display: '-webkit-box',
                      WebkitLineClamp: 3,
                      WebkitBoxOrient: 'vertical',
                      overflow: 'hidden',
                    }}
                  >
                    {r.intent}
                  </div>
                )}
                {(r.currentPlanSlug || r.currentView) && (
                  <div style={{ fontSize: 10.5, opacity: 0.55, marginTop: 3 }}>
                    ▸ {r.currentPlanSlug ?? r.currentView}
                  </div>
                )}
                {r.currentFiles && r.currentFiles.length > 0 && (
                  <div
                    data-testid="presence-files"
                    title={r.currentFiles.join('\n')}
                    style={{
                      fontSize: 10.5,
                      opacity: 0.55,
                      marginTop: 3,
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    ✎ {r.currentFiles.map((f) => f.split('/').pop()).join(', ')}
                  </div>
                )}
              </div>
            ))}
          </>
        ) : (
          <>
            {activityErr && (
              <div role="alert" style={{ fontSize: 12, color: '#f87171', padding: '8px 12px' }}>
                Failed to load activity: {activityErr}
              </div>
            )}
            {!activityErr && feedRows.length === 0 && (
              <div style={{ fontSize: 12, opacity: 0.6, padding: '8px 12px' }}>
                No recent activity.
              </div>
            )}
            {feedRows.map((e) => (
              <div
                key={e.msg_id}
                data-testid="activity-row"
                style={{ padding: '7px 12px', borderBottom: '1px solid var(--pc-border, #20242c)' }}
              >
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                  <span aria-hidden style={{ opacity: 0.6, width: 12, flexShrink: 0 }}>
                    {KIND_GLYPH[e.kind] ?? '·'}
                  </span>
                  <span style={{ fontSize: 11.5, fontWeight: 600 }}>{shortHandle(e.from)}</span>
                  <span style={{ fontSize: 10, opacity: 0.45, marginLeft: 'auto', flexShrink: 0 }}>
                    {relTime(e.ts)}
                  </span>
                </div>
                {(e.summary || e.body) && (
                  <div
                    style={{
                      fontSize: 11,
                      opacity: 0.8,
                      marginTop: 2,
                      paddingLeft: 18,
                      display: '-webkit-box',
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: 'vertical',
                      overflow: 'hidden',
                    }}
                  >
                    {e.summary || e.body}
                  </div>
                )}
                {e.plan_slug && (
                  <div style={{ fontSize: 10, opacity: 0.5, marginTop: 2, paddingLeft: 18 }}>
                    ▸ {e.plan_slug}
                  </div>
                )}
              </div>
            ))}
          </>
        )}
      </div>
    </aside>
  );
}
