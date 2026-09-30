'use client';

/**
 * Operator panel mock — Decisions / Activity split layout, with full
 * feature parity stubs against the real /harness Operator panel.
 *
 * Goal: make the apples-to-apples design comparison honest. Every
 * surface the real panel exposes (search, filter pills, per-harness
 * filter, stream sidebar, scan/pause/settings buttons, tabs in the
 * everything-else view, scan history, delegates, etc.) is present
 * here as a stub — no backend wiring, but visually complete.
 *
 * Render at /operator-mock.
 */

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Tooltip } from '@/app/harness/Tooltip';
import { useLexicon } from '@/lib/useLexicon';

// ─── Types & mock data ─────────────────────────────────────────────────────

type Tier = 'low' | 'medium' | 'high';
type CardKind = 'directive' | 'navigate' | 'inform';
type CardStatus = 'pending' | 'in-flight' | 'done' | 'failed';

type DecisionCard = {
  id: string;
  tier: Tier;
  kind: CardKind;
  status: CardStatus;
  harness: string;
  title: string;
  body: string;
  directiveBody?: string;
  navUrl?: string;
  recipient?: string;
  autoFireSec?: number;
};

type ActivityRow = {
  id: string;
  kind: 'in-flight' | 'done' | 'delegate' | 'scan' | 'error';
  ts: string;
  text: string;
  detail?: string;
  harness?: string;
};

type StreamLine = { ts: string; text: string };

const HARNESSES = [
  { slug: 'sheets', state: 'in_progress' as const },
  { slug: 'papercup-org', state: 'in_progress' as const },
  { slug: 'papercup-org-business', state: 'idle' as const },
  { slug: 'sheets-fork-2', state: 'in_progress' as const },
  { slug: 'org-business', state: 'stalled' as const },
];

const ALL_CARDS: DecisionCard[] = [
  {
    id: 'd1',
    tier: 'medium',
    kind: 'directive',
    status: 'pending',
    harness: 'sheets',
    title: 'Run validator for F-HOME-001',
    body: 'Feature has been at status=validating for 18 minutes with no validator output. Blocking the next 3 todo items.',
    recipient: 'sheets',
    directiveBody:
      'Run the validator role on F-HOME-001 (home page sheet listing). Worker-log shows status=validating since 18m ago with no output. Either pick the case up or surface a blocking reason.',
  },
  {
    id: 'd2',
    tier: 'medium',
    kind: 'directive',
    status: 'pending',
    harness: 'sheets',
    title: 'Unblock 4 fixing-state issues',
    body: 'I-0062, I-0057, I-0069, I-1fd30i1 stuck. 57 open issues queued behind them.',
    recipient: 'sheets',
    directiveBody:
      'Investigate the 4 fixing-state issues with no recent worker-log entries. Either resume them or escalate as blocked.',
  },
  {
    id: 'd3',
    tier: 'low',
    kind: 'directive',
    status: 'pending',
    harness: 'papercup-org',
    title: 'Plan-review notes not dismissed',
    body: '8 {pots} carry accept-with-notes verdicts from the F-FIX-009 review — 3 missing assertions called out.',
    recipient: 'papercup-org',
    autoFireSec: 23,
    directiveBody:
      'Review accept-with-notes plan notes for F-FIX-009: missing VAL-PERF-004, VAL-CLIP-004, VAL-ERR-007. Add or dismiss.',
  },
  {
    id: 'd4',
    tier: 'low',
    kind: 'navigate',
    status: 'pending',
    harness: 'sheets-fork-2',
    title: 'F-FIX-017 looks done in worker-log but feature is still todo',
    body: 'sheets-fork-2 worker-log documents implementation + passing e2e specs but features.json still says todo.',
    navUrl: '/harness/sheets-fork-2?panel=summary',
  },
  {
    id: 'd5',
    tier: 'low',
    kind: 'inform',
    status: 'pending',
    harness: 'org-business',
    title: 'Plan review · org-business · reject',
    body: 'Orchestrator emitted a reject verdict for org-business during scoping. This verdict has not been dismissed.',
  },
  // In-flight
  {
    id: 'i1',
    tier: 'medium',
    kind: 'directive',
    status: 'in-flight',
    harness: 'sheets-fork-2',
    title: 'Reviewing F-FIX-017 large-int precision fix',
    body: 'Dispatched 2 min ago — typical 3-5 min runtime.',
    recipient: 'sheets-fork-2',
  },
  {
    id: 'i2',
    tier: 'low',
    kind: 'directive',
    status: 'in-flight',
    harness: 'sheets',
    title: 'Plan review · 8 {pots} · accept-with-notes',
    body: 'Auto-dispatched 4 min ago.',
    recipient: 'sheets',
  },
  // Done
  {
    id: 'r1',
    tier: 'low',
    kind: 'inform',
    status: 'done',
    harness: 'sheets',
    title: 'Plan review · sheets · accept-with-notes',
    body: 'Resolved 12 min ago.',
  },
  {
    id: 'r2',
    tier: 'medium',
    kind: 'directive',
    status: 'done',
    harness: 'sheets',
    title: 'Restarted stuck validator on F-HOME-002',
    body: 'Dispatched and acknowledged 22 min ago.',
  },
  // Failed
  {
    id: 'f1',
    tier: 'high',
    kind: 'directive',
    status: 'failed',
    harness: 'org-business',
    title: 'Re-scope org-business plan',
    body: 'Dispatch returned: {pot} in stalled state, refused to start.',
  },
];

const DELEGATES = [
  {
    id: 'g1',
    title: 'Bell-number summarization',
    sessionId: 'd5a532d4',
    turns: 12,
    status: 'in-flight' as const,
    started: '4 min ago',
  },
  {
    id: 'g2',
    title: 'harness-help: review plan-review backlog',
    sessionId: '8a91bc02',
    turns: 5,
    status: 'done' as const,
    started: '32 min ago',
  },
  {
    id: 'g3',
    title: 'voice-mode test plan',
    sessionId: 'fa14e290',
    turns: 8,
    status: 'archived' as const,
    started: '1 day ago',
  },
];

const SCANS = [
  {
    id: 's1',
    started: '8 min ago',
    summary:
      'Scanned static context (MCP harness tools unavailable); re-emitted 3 prior cards — all underlying issues unchanged.',
    cards: 3,
    cost: '$0.041',
  },
  {
    id: 's2',
    started: '24 min ago',
    summary:
      'Scanned harness index and plan reviews from context; MCP harness tools unavailable so live task/message state could not be read — 3 suggestions surfaced.',
    cards: 3,
    cost: '$0.038',
  },
  {
    id: 's3',
    started: '1 hr ago',
    summary: 'Cold-start scan; 6 suggestions, 2 auto-dispatched at low tier.',
    cards: 6,
    cost: '$0.047',
  },
];

const STREAM: StreamLine[] = [
  { ts: '0:08', text: 'scanning workspace · 8 {pots}' },
  { ts: '0:14', text: 'reading sheets/.papercusp/plan-review.md' },
  { ts: '0:22', text: 'reading sheets/features.json' },
  { ts: '0:31', text: 'classifier: F-HOME-001 → medium tier' },
  { ts: '0:38', text: 'classifier: 4 fixing-state issues → medium tier' },
  { ts: '0:44', text: 'emitted 3 cards · 2 auto-dispatch eligible' },
];

const TIER_COPY: Record<Tier, { label: string; bar: string; chip: string }> = {
  high: { label: 'High risk', bar: '#ef4444', chip: 'rgba(239,68,68,0.15)' },
  medium: { label: 'Medium', bar: '#f59e0b', chip: 'rgba(245,158,11,0.15)' },
  low: { label: 'Low risk', bar: '#10b981', chip: 'rgba(16,185,129,0.15)' },
};

const STATUS_LABEL: Record<CardStatus, string> = {
  pending: 'Needs decision',
  'in-flight': 'In flight',
  done: 'Done',
  failed: 'Needs review',
};

const STATUS_COLOR: Record<CardStatus, string> = {
  pending: '#fbbf24',
  'in-flight': 'var(--accent)',
  done: '#94a3b8',
  failed: '#ef4444',
};

const ACTIVITY_KIND_GLYPH = {
  'in-flight': '⏵',
  done: '✓',
  delegate: '⇢',
  scan: '◉',
  error: '⚠',
} as const;

const ACTIVITY_KIND_COLOR = {
  'in-flight': 'var(--accent)',
  done: '#94a3b8',
  delegate: '#a78bfa',
  scan: 'var(--accent-strong, var(--accent))',
  error: '#ef4444',
} as const;

// ─── Lexicon placeholder resolution ────────────────────────────────────────
// Module-level mock fixtures can't call the useLexicon() hook, so the
// project-unit ("hive") occurrences are baked in as {pot}/{pots} placeholders
// and resolved at each render site with the component's lexicon `t`.
type Lexicon = ReturnType<typeof useLexicon>;
const resolvePot = (s: string, t: Lexicon): string =>
  s
    .replace(/\{pots\}/g, t('pot', { plural: true, lower: true }))
    .replace(/\{pot\}/g, t('pot', { lower: true }));

// ─── Component ─────────────────────────────────────────────────────────────

type View = 'decisions' | 'activity';
type ActivityFilter = 'all' | 'in-flight' | 'done' | 'delegates' | 'scans';

export default function OperatorMockPage(): React.JSX.Element {
  const t = useLexicon();
  const [view, setView] = useState<View>('decisions');
  const [activityFilter, setActivityFilter] = useState<ActivityFilter>('all');
  const [harnessFilter, setHarnessFilter] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [confirming, setConfirming] = useState<DecisionCard | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [paused, setPaused] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [closed, setClosed] = useState(false);
  const [streamOpen, setStreamOpen] = useState(false);

  // Esc closes
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !confirming) setClosed(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [confirming]);

  if (closed) {
    return (
      <div style={S.closedShell}>
        <div style={S.closedMsg}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>👋</div>
          <div>Panel closed.</div>
          <button style={{ ...S.linkBtn, marginTop: 16 }} onClick={() => setClosed(false)}>
            Reopen
          </button>
        </div>
      </div>
    );
  }

  const decisions = ALL_CARDS.filter((c) => c.status === 'pending').filter(
    (c) => !dismissed.has(c.id),
  );
  const visibleDecisions = decisions
    .filter((c) => !harnessFilter || c.harness === harnessFilter)
    .filter(
      (c) =>
        !search ||
        c.title.toLowerCase().includes(search.toLowerCase()) ||
        c.body.toLowerCase().includes(search.toLowerCase()) ||
        c.harness.toLowerCase().includes(search.toLowerCase()),
    );

  const filterCount =
    (harnessFilter ? 1 : 0) + (search ? 1 : 0);

  const inFlight = ALL_CARDS.filter((c) => c.status === 'in-flight');
  const doneItems = ALL_CARDS.filter((c) => c.status === 'done' || c.status === 'failed');

  return (
    <div style={S.page}>
      <div style={S.shell}>
        {/* Header */}
        <header style={S.header}>
          <div style={S.headerTopRow}>
            <div style={S.titleRow}>
              <div style={S.title}>Papercup</div>
              <div style={paused ? { ...S.statePill, ...S.statePillPaused } : scanning ? { ...S.statePill, ...S.statePillScanning } : S.statePill}>
                <span style={S.stateDot} />
                {paused ? 'Paused' : scanning ? 'Scanning…' : 'Idle'}
              </div>
            </div>
            <div style={S.headerActions}>
              <Tooltip label="Re-scan workspace">
                <button
                  style={S.iconBtn}
                  onClick={() => {
                    setScanning(true);
                    setTimeout(() => setScanning(false), 2000);
                  }}
                  disabled={paused || scanning}
                >
                  ↻ Scan
                </button>
              </Tooltip>
              <Tooltip label={paused ? 'Resume operator' : 'Pause operator (auto-dispatch + scans halt)'}>
                <button
                  style={paused ? S.iconBtnActive : S.iconBtn}
                  onClick={() => setPaused(!paused)}
                >
                  {paused ? '▶ Resume' : '⏸ Pause'}
                </button>
              </Tooltip>
              <Tooltip label="Papercup settings">
                <button style={S.iconBtn} onClick={() => toast.info('mock — opens /settings/operator')}>
                  ⚙
                </button>
              </Tooltip>
              <Tooltip label="Close (Esc)">
                <button style={S.iconBtn} onClick={() => setClosed(true)}>
                  ✕
                </button>
              </Tooltip>
            </div>
          </div>
          <div style={S.viewToggle} role="tablist" aria-label="Panel view">
            <button
              role="tab"
              aria-selected={view === 'decisions'}
              onClick={() => setView('decisions')}
              style={view === 'decisions' ? S.toggleActive : S.toggleInactive}
            >
              Decisions
              {decisions.length > 0 && <span style={S.toggleCount}>{decisions.length}</span>}
            </button>
            <button
              role="tab"
              aria-selected={view === 'activity'}
              onClick={() => setView('activity')}
              style={view === 'activity' ? S.toggleActive : S.toggleInactive}
            >
              Activity
            </button>
          </div>
        </header>

        {/* Body — sidebar + main */}
        <div style={S.bodyRow}>
          {/* Sidebar */}
          <aside style={S.sidebar}>
            <div style={S.sectionHead}>{t('pot', { plural: true })}</div>
            <div style={S.harnessHint}>Click to filter by {t('pot', { lower: true })}.</div>
            <div style={S.harnessList}>
              {harnessFilter && (
                <button
                  style={S.harnessClear}
                  onClick={() => setHarnessFilter(null)}
                >
                  ← clear filter
                </button>
              )}
              {HARNESSES.map((h) => (
                <button
                  key={h.slug}
                  style={harnessFilter === h.slug ? S.harnessRowActive : S.harnessRow}
                  onClick={() =>
                    setHarnessFilter((curr) => (curr === h.slug ? null : h.slug))
                  }
                >
                  <span style={S.harnessSlug}>{h.slug}</span>
                  <span style={{ ...S.harnessState, color: h.state === 'in_progress' ? '#10b981' : h.state === 'stalled' ? '#ef4444' : '#94a3b8' }}>
                    {h.state}
                  </span>
                </button>
              ))}
            </div>

            <button
              style={S.streamToggle}
              onClick={() => setStreamOpen(!streamOpen)}
              aria-expanded={streamOpen}
            >
              <span>{streamOpen ? '▾' : '▸'} Stream</span>
              <span style={S.streamStatus}>{scanning ? 'live' : 'quiet'}</span>
            </button>
            {streamOpen && (
              <div style={S.streamPanel}>
                {STREAM.map((line, i) => (
                  <div key={i} style={S.streamLine}>
                    <span style={S.streamTs}>{line.ts}</span>
                    <span style={S.streamText}>{resolvePot(line.text, t)}</span>
                  </div>
                ))}
              </div>
            )}
          </aside>

          {/* Main */}
          <main style={S.main}>
            {/* Filter chip strip */}
            {filterCount > 0 && (
              <div style={S.filterStrip}>
                <span style={S.filterLabel}>Filtered:</span>
                {harnessFilter && (
                  <span style={S.filterChip}>
                    {harnessFilter}
                    <button style={S.chipX} onClick={() => setHarnessFilter(null)}>×</button>
                  </span>
                )}
                {search && (
                  <span style={S.filterChip}>
                    "{search}"
                    <button style={S.chipX} onClick={() => setSearch('')}>×</button>
                  </span>
                )}
                <button
                  style={S.clearAllBtn}
                  onClick={() => {
                    setHarnessFilter(null);
                    setSearch('');
                  }}
                >
                  clear all
                </button>
              </div>
            )}

            {/* Search */}
            <div style={S.searchWrap}>
              <input
                style={S.searchInput}
                type="search"
                placeholder={view === 'decisions' ? 'Filter decisions…' : 'Filter activity…'}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                aria-label="Filter list"
              />
            </div>

            {view === 'decisions' ? (
              <DecisionsView
                cards={visibleDecisions}
                lex={t}
                paused={paused}
                onDispatch={(card) => setConfirming(card)}
                onDismiss={(card) => setDismissed(new Set([...dismissed, card.id]))}
                onOpen={(card) => toast.info(`Mock navigation: ${card.navUrl}`)}
                onAck={(card) => setDismissed(new Set([...dismissed, card.id]))}
                gotoActivity={() => setView('activity')}
              />
            ) : (
              <ActivityView
                filter={activityFilter}
                setFilter={setActivityFilter}
                search={search}
                lex={t}
                inFlight={inFlight}
                doneItems={doneItems}
              />
            )}
          </main>
        </div>

        {/* Footer */}
        <footer style={S.footer}>
          <span style={S.footerText}>
            <kbd style={S.kbd}>Cmd</kbd>+<kbd style={S.kbd}>K</kbd> then <kbd style={S.kbd}>O</kbd> to toggle ·
            <kbd style={{ ...S.kbd, marginLeft: 6 }}>Esc</kbd> to close
          </span>
          <span style={S.footerVersion}>mock · /operator-mock</span>
        </footer>
      </div>

      {/* Dispatch confirm modal */}
      {confirming && (
        <DispatchConfirm
          card={confirming}
          onCancel={() => setConfirming(null)}
          onConfirm={() => {
            setDismissed(new Set([...dismissed, confirming.id]));
            setConfirming(null);
          }}
        />
      )}
    </div>
  );
}

// ─── Sub-components ────────────────────────────────────────────────────────

function DecisionsView({
  cards,
  lex,
  paused,
  onDispatch,
  onDismiss,
  onOpen,
  onAck,
  gotoActivity,
}: {
  cards: DecisionCard[];
  lex: Lexicon;
  paused: boolean;
  onDispatch: (c: DecisionCard) => void;
  onDismiss: (c: DecisionCard) => void;
  onOpen: (c: DecisionCard) => void;
  onAck: (c: DecisionCard) => void;
  gotoActivity: () => void;
}): React.JSX.Element {
  if (paused) {
    return (
      <div style={S.emptyState}>
        <div style={{ ...S.emptyGlyph, color: '#fbbf24' }}>⏸</div>
        <div style={S.emptyTitle}>Papercup paused</div>
        <div style={S.emptyHint}>
          Auto-dispatch + scans are halted. Voice and Oracle still respond. Resume from the header.
        </div>
      </div>
    );
  }
  if (cards.length === 0) {
    return (
      <div style={S.emptyState}>
        <div style={S.emptyGlyph}>✓</div>
        <div style={S.emptyTitle}>You're all caught up</div>
        <div style={S.emptyHint}>
          New cards appear here when the operator finds something for you.
        </div>
        <button style={S.linkBtn} onClick={gotoActivity}>
          See recent activity →
        </button>
      </div>
    );
  }
  return (
    <div style={S.decisionsList}>
      {cards.map((card) => (
        <DecisionCardView
          key={card.id}
          card={card}
          lex={lex}
          onDispatch={() => onDispatch(card)}
          onDismiss={() => onDismiss(card)}
          onOpen={() => onOpen(card)}
          onAck={() => onAck(card)}
        />
      ))}
    </div>
  );
}

function DecisionCardView({
  card,
  lex,
  onDispatch,
  onDismiss,
  onOpen,
  onAck,
}: {
  card: DecisionCard;
  lex: Lexicon;
  onDispatch: () => void;
  onDismiss: () => void;
  onOpen: () => void;
  onAck: () => void;
}): React.JSX.Element {
  const t = TIER_COPY[card.tier];
  const [bodyOpen, setBodyOpen] = useState(false);

  return (
    <article style={S.decisionCard}>
      <div style={{ ...S.tierBar, background: t.bar }} />
      <div style={S.decisionBody}>
        <div style={S.cardMeta}>
          <span style={{ ...S.tierChip, background: t.chip, color: t.bar }}>
            {t.label}
          </span>
          <span style={S.harnessTag}>{card.harness}</span>
          {card.autoFireSec != null && (
            <span style={S.autoFireChip}>
              auto-fires in {card.autoFireSec}s
            </span>
          )}
        </div>
        <h2 style={S.cardTitle}>{resolvePot(card.title, lex)}</h2>
        <p style={S.cardText}>{resolvePot(card.body, lex)}</p>

        {card.directiveBody && (
          <div style={S.directiveSection}>
            <button
              style={S.directiveToggle}
              onClick={() => setBodyOpen(!bodyOpen)}
              aria-expanded={bodyOpen}
            >
              {bodyOpen ? '▾' : '▸'} Directive body
            </button>
            {bodyOpen && (
              <pre style={S.directiveBody}>{card.directiveBody}</pre>
            )}
          </div>
        )}

        <div style={S.actions}>
          {card.kind === 'directive' && (
            <>
              <button style={S.primaryBtn} onClick={onDispatch}>
                Send to {card.recipient} →
              </button>
              <button style={S.ghostBtn} onClick={onDismiss}>
                Dismiss
              </button>
            </>
          )}
          {card.kind === 'navigate' && (
            <>
              <button style={S.primaryBtn} onClick={onOpen}>
                Open ↗
              </button>
              <button style={S.ghostBtn} onClick={onDismiss}>
                Dismiss
              </button>
            </>
          )}
          {card.kind === 'inform' && (
            <button style={S.ghostBtn} onClick={onAck}>
              Got it
            </button>
          )}
        </div>
      </div>
    </article>
  );
}

function ActivityView({
  filter,
  setFilter,
  search,
  lex,
  inFlight,
  doneItems,
}: {
  filter: ActivityFilter;
  setFilter: (f: ActivityFilter) => void;
  search: string;
  lex: Lexicon;
  inFlight: DecisionCard[];
  doneItems: DecisionCard[];
}): React.JSX.Element {
  const filters: { id: ActivityFilter; label: string; count: number }[] = [
    { id: 'all', label: 'All', count: inFlight.length + doneItems.length + DELEGATES.length + SCANS.length },
    { id: 'in-flight', label: 'In flight', count: inFlight.length },
    { id: 'done', label: 'Done', count: doneItems.length },
    { id: 'delegates', label: 'Delegates', count: DELEGATES.length },
    { id: 'scans', label: 'Scans', count: SCANS.length },
  ];

  return (
    <div style={S.activityWrap}>
      <div style={S.subFilter}>
        {filters.map((f) => (
          <button
            key={f.id}
            style={filter === f.id ? S.subFilterActive : S.subFilterInactive}
            onClick={() => setFilter(f.id)}
          >
            {f.label}
            <span style={S.subFilterCount}>{f.count}</span>
          </button>
        ))}
      </div>

      <div style={S.activityList}>
        {(filter === 'all' || filter === 'in-flight') && inFlight.length > 0 && (
          <Section label="In flight">
            {inFlight
              .filter((c) => !search || matchSearch(c, search))
              .map((c) => (
                <ActivityCardRow key={c.id} card={c} lex={lex} />
              ))}
          </Section>
        )}

        {(filter === 'all' || filter === 'done') && doneItems.length > 0 && (
          <Section label="Done">
            {doneItems
              .filter((c) => !search || matchSearch(c, search))
              .map((c) => (
                <ActivityCardRow key={c.id} card={c} lex={lex} />
              ))}
          </Section>
        )}

        {(filter === 'all' || filter === 'delegates') && (
          <Section label="Delegates">
            {DELEGATES.filter((d) => !search || d.title.toLowerCase().includes(search.toLowerCase())).map((d) => (
              <DelegateRow key={d.id} delegate={d} />
            ))}
          </Section>
        )}

        {(filter === 'all' || filter === 'scans') && (
          <Section label="Recent scans">
            {SCANS.filter((s) => !search || s.summary.toLowerCase().includes(search.toLowerCase())).map((s) => (
              <ScanRow key={s.id} scan={s} />
            ))}
          </Section>
        )}
      </div>
    </div>
  );
}

function matchSearch(c: DecisionCard, q: string): boolean {
  const t = q.toLowerCase();
  return (
    c.title.toLowerCase().includes(t) ||
    c.body.toLowerCase().includes(t) ||
    c.harness.toLowerCase().includes(t)
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <section style={S.activitySection}>
      <div style={S.activitySectionHead}>{label}</div>
      <div>{children}</div>
    </section>
  );
}

function ActivityCardRow({ card, lex }: { card: DecisionCard; lex: Lexicon }): React.JSX.Element {
  const kind = card.status === 'in-flight' ? 'in-flight' : card.status === 'failed' ? 'error' : 'done';
  const t = TIER_COPY[card.tier];
  return (
    <div style={S.activityRow}>
      <span style={{ ...S.activityGlyph, color: ACTIVITY_KIND_COLOR[kind] }}>
        {ACTIVITY_KIND_GLYPH[kind]}
      </span>
      <div style={S.activityTextWrap}>
        <div style={S.activityText}>
          <span style={S.activityHarness}>{card.harness}</span>
          {resolvePot(card.title, lex)}
          <span style={{ ...S.tierChipMini, background: t.chip, color: t.bar }}>{t.label}</span>
        </div>
        <div style={S.activityDetail}>{resolvePot(card.body, lex)}</div>
      </div>
      <span style={S.activityTs}>
        {card.status === 'failed' ? <button style={S.retryBtn}>Retry</button> : null}
      </span>
    </div>
  );
}

function DelegateRow({
  delegate,
}: {
  delegate: { id: string; title: string; sessionId: string; turns: number; status: 'in-flight' | 'done' | 'archived'; started: string };
}): React.JSX.Element {
  const kind = delegate.status === 'in-flight' ? 'in-flight' : 'delegate';
  return (
    <div style={S.activityRow}>
      <span style={{ ...S.activityGlyph, color: ACTIVITY_KIND_COLOR.delegate }}>
        {ACTIVITY_KIND_GLYPH.delegate}
      </span>
      <div style={S.activityTextWrap}>
        <div style={S.activityText}>
          {delegate.title}
          {delegate.status === 'in-flight' && (
            <span style={S.spinnerChip}>
              <span style={S.spinner} /> running
            </span>
          )}
          {delegate.status === 'done' && <span style={S.doneChip}>done</span>}
          {delegate.status === 'archived' && <span style={S.archivedChip}>archived</span>}
        </div>
        <div style={S.activityDetail}>
          session {delegate.sessionId} · {delegate.turns} turns · started {delegate.started}
        </div>
      </div>
      <span style={S.activityTs}>
        {delegate.status !== 'in-flight' && <button style={S.retryBtn}>Continue</button>}
      </span>
    </div>
  );
}

function ScanRow({
  scan,
}: {
  scan: { id: string; started: string; summary: string; cards: number; cost: string };
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div style={open ? S.scanRowOpen : S.scanRow} onClick={() => setOpen(!open)}>
      <div style={S.activityRow}>
        <span style={{ ...S.activityGlyph, color: ACTIVITY_KIND_COLOR.scan }}>
          {open ? '▾' : '▸'}
        </span>
        <div style={S.activityTextWrap}>
          <div style={S.activityText}>{scan.summary}</div>
          <div style={S.activityDetail}>
            {scan.started} · {scan.cards} cards · {scan.cost}
          </div>
        </div>
      </div>
      {open && (
        <div style={S.scanDetail}>
          <em style={{ color: '#94a3b8', fontSize: 12 }}>(stub) full scan output would appear here — emitted cards, cost breakdown, model used, claude session id.</em>
        </div>
      )}
    </div>
  );
}

function DispatchConfirm({
  card,
  onCancel,
  onConfirm,
}: {
  card: DecisionCard;
  onCancel: () => void;
  onConfirm: () => void;
}): React.JSX.Element {
  const t = useLexicon();
  return (
    <div style={S.modalBackdrop} onClick={onCancel}>
      <div style={S.modal} onClick={(e) => e.stopPropagation()}>
        <div style={S.modalEyebrow}>Confirm dispatch</div>
        <div style={S.modalTitle}>
          Send to <code style={S.code}>{card.recipient}</code>?
        </div>
        <div style={S.modalSection}>
          <div style={S.modalLabel}>The {t('pot', { lower: true })} will receive:</div>
          <div style={S.modalQuote}>"{resolvePot(card.directiveBody ?? card.title, t)}"</div>
        </div>
        <div style={S.modalSection}>
          <div style={S.modalLabel}>What happens next:</div>
          <ul style={S.modalList}>
            <li>Picked up by the validator role at the next scan tick (~30s).</li>
            <li>Estimated agent time: 2-5 min.</li>
            <li>You'll see it appear in the Activity tab as it runs.</li>
          </ul>
        </div>
        <div style={S.modalActions}>
          <button style={S.ghostBtn} onClick={onCancel}>
            Cancel
          </button>
          <button style={S.primaryBtn} onClick={onConfirm}>
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Styles ────────────────────────────────────────────────────────────────

const S: Record<string, React.CSSProperties> = {
  page: {
    minHeight: '100vh',
    background: 'var(--bg, #07101d)',
    color: 'var(--fg, #e2e8f0)',
    padding: '40px 20px',
    fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif',
  },
  shell: {
    maxWidth: 980,
    margin: '0 auto',
    background: 'var(--bg-1, #0b1220)',
    border: '1px solid rgba(255,255,255,0.08)',
    borderRadius: 12,
    overflow: 'hidden',
    boxShadow: '0 20px 60px rgba(0,0,0,0.4)',
    display: 'flex',
    flexDirection: 'column',
    minHeight: '70vh',
  },
  closedShell: { minHeight: '100vh', background: 'var(--bg, #07101d)', display: 'grid', placeItems: 'center', color: '#94a3b8' },
  closedMsg: { textAlign: 'center', fontSize: 14 },

  // Header
  header: {
    padding: '16px 20px 14px',
    borderBottom: '1px solid rgba(255,255,255,0.06)',
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
  },
  headerTopRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  titleRow: { display: 'flex', alignItems: 'center', gap: 12 },
  title: { fontSize: 20, fontWeight: 600, letterSpacing: -0.2 },
  statePill: {
    fontSize: 12,
    color: '#94a3b8',
    background: 'rgba(255,255,255,0.05)',
    padding: '3px 10px',
    borderRadius: 12,
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    border: '1px solid rgba(255,255,255,0.06)',
  },
  statePillScanning: { color: 'var(--accent-strong, var(--accent))', borderColor: 'color-mix(in oklab, var(--accent), transparent 70%)' },
  statePillPaused: { color: '#fbbf24', borderColor: 'rgba(251,191,36,0.3)' },
  stateDot: { width: 6, height: 6, borderRadius: 3, background: 'currentColor', display: 'inline-block' },
  headerActions: { display: 'flex', gap: 6 },
  iconBtn: {
    background: 'transparent',
    color: '#94a3b8',
    border: '1px solid rgba(255,255,255,0.08)',
    padding: '6px 12px',
    borderRadius: 6,
    fontSize: 13,
    cursor: 'pointer',
  },
  iconBtnActive: {
    background: 'rgba(251,191,36,0.15)',
    color: '#fbbf24',
    border: '1px solid rgba(251,191,36,0.3)',
    padding: '6px 12px',
    borderRadius: 6,
    fontSize: 13,
    cursor: 'pointer',
  },
  viewToggle: {
    display: 'inline-flex',
    background: 'rgba(255,255,255,0.04)',
    borderRadius: 8,
    padding: 3,
    alignSelf: 'flex-start',
    border: '1px solid rgba(255,255,255,0.06)',
  },
  toggleActive: {
    padding: '7px 14px',
    background: 'var(--accent)',
    color: '#051827',
    border: 'none',
    borderRadius: 6,
    cursor: 'pointer',
    fontSize: 13,
    fontWeight: 600,
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
  },
  toggleInactive: {
    padding: '7px 14px',
    background: 'transparent',
    color: '#94a3b8',
    border: 'none',
    borderRadius: 6,
    cursor: 'pointer',
    fontSize: 13,
    fontWeight: 500,
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
  },
  toggleCount: {
    background: 'rgba(5,24,39,0.25)',
    color: 'inherit',
    fontSize: 11,
    padding: '1px 6px',
    borderRadius: 8,
    fontWeight: 600,
  },

  // Body
  bodyRow: { display: 'flex', flex: 1, minHeight: 0 },
  sidebar: {
    width: 220,
    flexShrink: 0,
    padding: '16px 14px',
    borderRight: '1px solid rgba(255,255,255,0.06)',
    background: 'rgba(0,0,0,0.15)',
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  sectionHead: { fontSize: 11, color: '#64748b', textTransform: 'uppercase', marginBottom: 2 },
  harnessHint: { fontSize: 11, color: '#64748b', marginBottom: 4, fontStyle: 'italic' },
  harnessList: { display: 'flex', flexDirection: 'column', gap: 2 },
  harnessRow: {
    background: 'transparent',
    border: '1px solid transparent',
    color: '#cbd5e1',
    padding: '6px 8px',
    borderRadius: 4,
    fontSize: 12,
    cursor: 'pointer',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    textAlign: 'left',
  },
  harnessRowActive: {
    background: 'color-mix(in oklab, var(--accent), transparent 90%)',
    border: '1px solid color-mix(in oklab, var(--accent), transparent 70%)',
    color: 'var(--accent-strong, var(--accent))',
    padding: '6px 8px',
    borderRadius: 4,
    fontSize: 12,
    cursor: 'pointer',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    textAlign: 'left',
  },
  harnessSlug: { fontFamily: 'ui-monospace, monospace', fontSize: 12 },
  harnessState: { fontSize: 10, textTransform: 'uppercase' as const },
  harnessClear: {
    background: 'transparent',
    color: '#64748b',
    border: 'none',
    padding: '4px 0',
    fontSize: 11,
    cursor: 'pointer',
    textAlign: 'left',
    fontStyle: 'italic',
  },
  streamToggle: {
    background: 'transparent',
    border: 'none',
    color: '#94a3b8',
    padding: '8px 0',
    marginTop: 12,
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderTop: '1px solid rgba(255,255,255,0.05)',
    textTransform: 'uppercase' as const,
  },
  streamStatus: { fontSize: 10, color: '#64748b', textTransform: 'lowercase' as const },
  streamPanel: {
    background: 'rgba(0,0,0,0.3)',
    borderRadius: 4,
    padding: 8,
    fontFamily: 'ui-monospace, monospace',
    fontSize: 11,
    maxHeight: 140,
    overflowY: 'auto',
  },
  streamLine: { display: 'flex', gap: 8, padding: '2px 0', color: '#94a3b8' },
  streamTs: { color: '#64748b', flexShrink: 0, width: 32 },
  streamText: { color: '#cbd5e1' },

  // Main
  main: { flex: 1, padding: '14px 20px 20px', minWidth: 0, overflowY: 'auto' },
  filterStrip: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '8px 10px',
    background: 'color-mix(in oklab, var(--accent), transparent 94%)',
    border: '1px solid color-mix(in oklab, var(--accent), transparent 80%)',
    borderRadius: 6,
    marginBottom: 12,
    flexWrap: 'wrap' as const,
  },
  filterLabel: { fontSize: 11, color: '#94a3b8', textTransform: 'uppercase' as const },
  filterChip: {
    fontSize: 12,
    background: 'rgba(255,255,255,0.06)',
    padding: '3px 8px',
    borderRadius: 4,
    display: 'inline-flex',
    gap: 4,
    alignItems: 'center',
    color: '#cbd5e1',
  },
  chipX: { background: 'transparent', color: '#94a3b8', border: 'none', cursor: 'pointer', fontSize: 14, padding: 0, lineHeight: 1 },
  clearAllBtn: { background: 'transparent', color: 'var(--accent)', border: 'none', fontSize: 12, cursor: 'pointer', marginLeft: 'auto' },

  searchWrap: { marginBottom: 14 },
  searchInput: {
    width: '100%',
    background: 'rgba(255,255,255,0.04)',
    border: '1px solid rgba(255,255,255,0.08)',
    color: '#e2e8f0',
    padding: '8px 12px',
    borderRadius: 6,
    fontSize: 13,
    outline: 'none',
    fontFamily: 'inherit',
  },

  // Decisions
  decisionsList: { display: 'flex', flexDirection: 'column', gap: 12 },
  decisionCard: {
    display: 'flex',
    background: 'rgba(255,255,255,0.025)',
    border: '1px solid rgba(255,255,255,0.07)',
    borderRadius: 10,
    overflow: 'hidden',
  },
  tierBar: { width: 4, flexShrink: 0 },
  decisionBody: { flex: 1, padding: '16px 18px' },
  cardMeta: { display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' as const, alignItems: 'center' },
  tierChip: { fontSize: 11, fontWeight: 600, padding: '3px 8px', borderRadius: 4 },
  tierChipMini: { fontSize: 10, fontWeight: 600, padding: '1px 6px', borderRadius: 3, marginLeft: 8 },
  harnessTag: { fontSize: 12, color: '#94a3b8', fontFamily: 'ui-monospace, SFMono-Regular, monospace' },
  autoFireChip: {
    fontSize: 11,
    color: '#fbbf24',
    background: 'rgba(245,158,11,0.1)',
    padding: '3px 8px',
    borderRadius: 4,
    marginLeft: 'auto',
  },
  cardTitle: { fontSize: 16, fontWeight: 600, margin: '0 0 6px', lineHeight: 1.3 },
  cardText: { fontSize: 14, color: '#cbd5e1', margin: '0 0 12px', lineHeight: 1.5 },
  directiveSection: { marginBottom: 12 },
  directiveToggle: {
    background: 'transparent',
    color: '#94a3b8',
    border: 'none',
    padding: '4px 0',
    fontSize: 12,
    cursor: 'pointer',
    fontStyle: 'italic',
  },
  directiveBody: {
    background: 'rgba(0,0,0,0.3)',
    borderLeft: '3px solid color-mix(in oklab, var(--accent), transparent 60%)',
    padding: 10,
    borderRadius: 4,
    fontSize: 12,
    color: '#cbd5e1',
    fontFamily: 'ui-monospace, monospace',
    whiteSpace: 'pre-wrap',
    margin: '6px 0 0',
    lineHeight: 1.5,
  },
  actions: { display: 'flex', gap: 8 },
  primaryBtn: {
    background: 'var(--accent)',
    color: '#051827',
    border: 'none',
    padding: '8px 16px',
    borderRadius: 6,
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
  },
  ghostBtn: {
    background: 'transparent',
    color: '#94a3b8',
    border: '1px solid rgba(255,255,255,0.12)',
    padding: '8px 14px',
    borderRadius: 6,
    fontSize: 13,
    cursor: 'pointer',
  },
  linkBtn: {
    background: 'transparent',
    color: 'var(--accent)',
    border: 'none',
    padding: '8px 0',
    fontSize: 13,
    cursor: 'pointer',
    marginTop: 16,
  },
  retryBtn: {
    background: 'transparent',
    color: '#a78bfa',
    border: '1px solid rgba(167,139,250,0.3)',
    padding: '4px 10px',
    borderRadius: 4,
    fontSize: 11,
    cursor: 'pointer',
  },

  // Empty
  emptyState: {
    padding: '60px 24px',
    textAlign: 'center',
    color: '#94a3b8',
  },
  emptyGlyph: { fontSize: 36, color: '#10b981', marginBottom: 16 },
  emptyTitle: { fontSize: 18, fontWeight: 600, color: '#e2e8f0', marginBottom: 6 },
  emptyHint: { fontSize: 13, lineHeight: 1.5, maxWidth: 360, margin: '0 auto' },

  // Activity
  activityWrap: {},
  subFilter: {
    display: 'inline-flex',
    background: 'rgba(255,255,255,0.04)',
    borderRadius: 6,
    padding: 2,
    marginBottom: 14,
    border: '1px solid rgba(255,255,255,0.06)',
  },
  subFilterActive: {
    padding: '5px 10px',
    background: 'var(--accent)',
    color: '#051827',
    border: 'none',
    borderRadius: 4,
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 600,
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
  },
  subFilterInactive: {
    padding: '5px 10px',
    background: 'transparent',
    color: '#94a3b8',
    border: 'none',
    borderRadius: 4,
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 500,
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
  },
  subFilterCount: { fontSize: 10, opacity: 0.85 },
  activityList: { display: 'flex', flexDirection: 'column', gap: 0 },
  activitySection: { marginBottom: 16 },
  activitySectionHead: {
    fontSize: 11,
    color: '#64748b',
    textTransform: 'uppercase' as const,
    marginBottom: 4,
    paddingBottom: 4,
    borderBottom: '1px solid rgba(255,255,255,0.04)',
  },
  activityRow: {
    display: 'flex',
    gap: 12,
    padding: '10px 4px',
    alignItems: 'flex-start',
    borderBottom: '1px solid rgba(255,255,255,0.03)',
  },
  activityGlyph: { fontSize: 14, marginTop: 2, width: 16, textAlign: 'center', flexShrink: 0 },
  activityTextWrap: { flex: 1, minWidth: 0 },
  activityText: { fontSize: 13, color: '#e2e8f0', lineHeight: 1.4, display: 'flex', alignItems: 'baseline', gap: 4, flexWrap: 'wrap' as const },
  activityHarness: {
    fontFamily: 'ui-monospace, monospace',
    fontSize: 11,
    color: '#94a3b8',
    marginRight: 4,
  },
  activityDetail: { fontSize: 12, color: '#94a3b8', marginTop: 3, lineHeight: 1.4 },
  activityTs: { fontSize: 11, color: '#64748b', flexShrink: 0, marginTop: 2 },
  spinnerChip: {
    fontSize: 10,
    color: 'var(--accent)',
    background: 'color-mix(in oklab, var(--accent), transparent 90%)',
    padding: '1px 6px',
    borderRadius: 3,
    display: 'inline-flex',
    gap: 4,
    alignItems: 'center',
    marginLeft: 6,
  },
  spinner: {
    width: 6,
    height: 6,
    border: '1.5px solid color-mix(in oklab, var(--accent), transparent 60%)',
    borderTopColor: 'var(--accent)',
    borderRadius: 3,
    display: 'inline-block',
    animation: 'spin 0.8s linear infinite',
  },
  doneChip: { fontSize: 10, color: '#94a3b8', marginLeft: 6 },
  archivedChip: { fontSize: 10, color: '#64748b', fontStyle: 'italic', marginLeft: 6 },
  scanRow: { cursor: 'pointer' },
  scanRowOpen: { cursor: 'pointer', background: 'rgba(255,255,255,0.02)' },
  scanDetail: { padding: '4px 32px 12px', fontSize: 12, color: '#94a3b8' },

  // Footer
  footer: {
    padding: '10px 20px',
    borderTop: '1px solid rgba(255,255,255,0.04)',
    background: 'rgba(0,0,0,0.2)',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  footerText: { fontSize: 11, color: '#64748b' },
  footerVersion: { fontSize: 10, color: '#475569', fontStyle: 'italic' },
  kbd: {
    background: 'rgba(255,255,255,0.06)',
    border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: 3,
    padding: '1px 5px',
    fontSize: 10,
    fontFamily: 'ui-monospace, monospace',
    color: '#94a3b8',
  },

  // Modal
  modalBackdrop: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.6)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
    zIndex: 100,
  },
  modal: {
    background: '#0d1829',
    border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: 12,
    padding: 24,
    maxWidth: 480,
    width: '100%',
    boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
  },
  modalEyebrow: {
    fontSize: 11,
    color: '#94a3b8',
    textTransform: 'uppercase' as const,
    marginBottom: 8,
  },
  modalTitle: { fontSize: 18, fontWeight: 600, marginBottom: 20 },
  modalSection: { marginBottom: 16 },
  modalLabel: { fontSize: 12, color: '#94a3b8', marginBottom: 6 },
  modalQuote: {
    background: 'rgba(255,255,255,0.04)',
    borderLeft: '3px solid var(--accent)',
    padding: '10px 12px',
    borderRadius: 4,
    fontSize: 13,
    color: '#e2e8f0',
    fontStyle: 'italic',
  },
  modalList: { margin: 0, paddingLeft: 18, fontSize: 13, color: '#cbd5e1', lineHeight: 1.6 },
  modalActions: { display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 8 },
  code: {
    fontFamily: 'ui-monospace, SFMono-Regular, monospace',
    background: 'rgba(255,255,255,0.06)',
    padding: '2px 6px',
    borderRadius: 4,
    fontSize: 14,
  },
};
