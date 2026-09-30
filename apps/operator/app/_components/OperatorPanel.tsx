'use client';

/**
 * Deck panel — primary interaction surface for the Operator concierge.
 *
 * Per spec/agent-mcp:
 *   - Top dropdown covering most of the page in all directions.
 *   - Triggered by the Deck button (next to Mission Control) AND
 *     the Cmd/Ctrl+K, D keyboard shortcut.
 *   - Click-outside to close.
 *   - Current view stays mounted underneath.
 *   - Icon states: idle / scanning / thinking / acting / paused / awaiting-input.
 *
 * On open, kicks off /api/agent-mcp/operator-scan, streams events,
 * renders suggestion cards as they arrive, and lets the user dispatch
 * or dismiss each.
 */

import { useDeferredValue, useEffect, useMemo, useState, useCallback, useRef, type ReactElement } from 'react';
import { usePathname } from 'next/navigation';
import { useQueryState, parseAsString, parseAsStringLiteral } from 'nuqs';
import { useSyncQuery } from '@papercusp/sync';
import { createResilientEventSource } from '@papercusp/sse';
import { useWorkspaceId } from '@/lib/use-workspace-id';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useFancyEffectsEnabled } from '@/lib/visual-effects';
import gsap from 'gsap';
import { useGSAP } from '@gsap/react';
import { MarkdownPreview } from './MarkdownEditor';
import { LazyDetails } from './LazyDetails';
import { Button } from '../harness/Button';
import { Select } from '../harness/Select';
import { Tooltip } from '../harness/Tooltip';
import { usePromptDialog } from '../harness/usePromptDialog';
import { speak, onFinalUtterance, getVoiceState } from './voice/voice-mode';
import { registerVoiceConsumer } from './voice/VoiceAppBridge';
import { findFuzzyDuplicate } from '../../lib/operator-fuzzy-dedup';
import RouteLink from './RouteLink';
import { OperatorReactorCore } from './hud/OperatorReactorCore';
import { OperatorScanOverlay } from './hud/OperatorScanOverlay';
import DelegatesSection from './DelegatesSection';
import ScanHistorySection from './ScanHistorySection';
import { DeckCardsMark } from './ChromeNavMarks';
import { OperatorWordmarkLockup } from './OperatorWordmarkLockup';
type IconState = 'idle' | 'scanning' | 'thinking' | 'acting' | 'paused' | 'awaiting-input';



interface ProvenanceFlags {
  tierMismatch?: boolean;
  capabilityUnknown?: boolean;
  oversizedTitle?: boolean;
  oversizedWhy?: boolean;
}

interface ParsedSuggestion {
  id: string;
  title: string;
  why: string;
  reason: string;
  tier: 'low' | 'medium' | 'high';
  actualTier: 'low' | 'medium' | 'high';
  auto_dispatch: boolean;
  provenanceFlags: ProvenanceFlags;
  action: 'send_directive' | 'navigate' | 'inform';
  // Discriminated fields (only populated for matching action variant):
  capability?: 'messages:write' | null;
  target_harness?: string;
  directive_kind?: 'Directive' | 'Decision' | 'Priority';
  directive_subject?: string;
  directive_body?: string;
  target_resource?: string;
  body?: string;
}

type LifecycleState =
  | 'pending'   // waiting for user decision
  | 'accepted'  // user clicked Accept and the action succeeded
  | 'ignored';  // user clicked Ignore


function normalizeLifecycleState(status: unknown): LifecycleState {
  if (status === 'accepted' || status === 'dispatched' || status === 'consumed') return 'accepted';
  if (status === 'ignored' || status === 'dismissed' || status === 'superseded') return 'ignored';
  return 'pending';
}
interface SuggestionCard extends ParsedSuggestion {
  status: LifecycleState;
  /** Local time we transitioned to `accepted`. Used for sort + audit. */
  acceptedAt?: number;
  /** Local deadline for foreground auto-accept affordance. */
  autoDispatchAt?: number;
  /** True when ignore came from undo-window cancel (audit-only, no preferences entry). */
  undoCancelled?: boolean;
  /** Set after a successful directive accept — kept for traceability/dedup. */
  messageId?: string;
  /** Number of visually-identical pending recommendations collapsed into this card. */
  duplicateCount?: number;
  /** Count of failed Accept clicks while pending. Cleared on success. */
  failedAttempts?: number;
  /** Human-readable reason for the most recent Accept failure (HTTP, no message_id, etc.). */
  lastFailureReason?: string;
  /** Timestamp of the most recent Accept failure. */
  lastFailureAt?: number;
}

/**
 * Turn a raw failure string (HTTP body, exception .message) into a short
 * human-readable reason. Long error bodies (HTML 500 pages, multi-line
 * stack traces) overflow the row; pick the most informative line and
 * trim. Recognised network-error strings get friendlier rewrites.
 */
function humanizeFailure(raw: string | undefined): string {
  if (!raw) return 'unknown error';
  const trimmed = raw.trim();
  if (!trimmed) return 'unknown error';
  if (/^TypeError: Failed to fetch$/i.test(trimmed) || /NetworkError/i.test(trimmed)) {
    return 'network unreachable';
  }
  if (/aborted|AbortError/i.test(trimmed)) return 'request cancelled';
  if (/^HTTP\s+5\d\d/i.test(trimmed)) return 'server error';
  if (/^HTTP\s+4\d\d/i.test(trimmed)) return 'request rejected';
  // Strip HTML envelope if the server returned a page.
  const stripped = trimmed.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  // First line, capped.
  const firstLine = stripped.split(/\r?\n/, 1)[0] ?? stripped;
  return firstLine.length > 120 ? firstLine.slice(0, 117) + '…' : firstLine;
}

function lifecycleLabel(status: unknown): string {
  switch (normalizeLifecycleState(status)) {
    case 'pending':
      return 'Needs decision';
    case 'accepted':
      return 'Accepted';
    case 'ignored':
      return 'Ignored';
    default:
      return String(status);
  }
}

function tierLabel(tier: SuggestionCard['actualTier']): string {
  return tier === 'high' ? 'High risk' : tier === 'medium' ? 'Medium risk' : 'Low risk';
}

type MainView = 'cards' | 'accepted' | 'ignored' | 'scan-history';
type ScanStatus = 'idle' | 'scanning' | 'complete' | 'error';

function lifecycleLabelForCard(card: SuggestionCard): string {
  if (card.action === 'inform' && card.status === 'pending') return 'Informational';
  if (card.auto_dispatch && card.status === 'pending') return 'Auto-fire pending';
  return lifecycleLabel(card.status);
}

function lifecycleClassForCard(card: SuggestionCard): string {
  if (card.action === 'inform' && card.status === 'pending') return 'inform';
  if (card.auto_dispatch && card.status === 'pending') return 'auto';
  return card.status;
}



function autoDispatchSeconds(card: SuggestionCard, now: number): number {
  if (!card.autoDispatchAt) return 0;
  return Math.max(0, Math.ceil((card.autoDispatchAt - now) / 1000));
}

/**
 * Inform-card bodies often start with a markdown header that duplicates
 * `s.title` — rendered full-size by Vditor with an anchor link, this
 * dominates the compact card layout. Strip leading `# ...` lines and any
 * line that matches the card's own title so the body reads as prose.
 */
function stripLeadingHeading(body: string, title?: string): string {
  let out = body.replace(/^\s+/, '');
  // Strip any contiguous run of leading markdown headers.
  while (true) {
    const m = out.match(/^(#{1,6})\s+([^\n]*)\n?/);
    if (!m) break;
    const headingText = m[2].trim();
    const isDup = title && headingText.replace(/\s+/g, ' ') === title.replace(/\s+/g, ' ');
    // Strip duplicate-of-title unconditionally; otherwise only strip the
    // first leading H1 (so deeper structured docs survive).
    if (isDup || m[1].length === 1) {
      out = out.slice(m[0].length).replace(/^\s+/, '');
      if (!isDup) break;
    } else {
      break;
    }
  }
  return out;
}

const TIER_SORT_RANK: Record<SuggestionCard['actualTier'], number> = {
  high: 3,
  medium: 2,
  low: 1,
};

function actionGlyphForCard(card: SuggestionCard): string {
  if (card.action === 'navigate') return '↗';
  if (card.action === 'inform') return 'ℹ';
  return '✉';
}

function normalizeDuplicateText(value: string | null | undefined): string {
  return (value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function duplicateKeyForCard(card: ParsedSuggestion | SuggestionCard): string {
  return [
    card.action,
    card.actualTier,
    String(card.auto_dispatch),
    normalizeDuplicateText(card.target_harness),
    normalizeDuplicateText(card.title),
    normalizeDuplicateText(card.why),
    normalizeDuplicateText(card.directive_kind),
    normalizeDuplicateText(card.directive_subject),
    normalizeDuplicateText(card.directive_body),
    normalizeDuplicateText(card.target_resource),
    normalizeDuplicateText(card.body),
  ].join('\u001f');
}

function bumpDuplicateCount(card: SuggestionCard): SuggestionCard {
  return { ...card, duplicateCount: (card.duplicateCount ?? 1) + 1 };
}

function dedupePendingSuggestionCards(cards: SuggestionCard[]): SuggestionCard[] {
  const out: SuggestionCard[] = [];
  const pendingByKey = new Map<string, number>();
  for (const card of cards) {
    if (card.status === 'pending') {
      const key = duplicateKeyForCard(card);
      const existingIndex = pendingByKey.get(key);
      if (existingIndex !== undefined) {
        out[existingIndex] = bumpDuplicateCount(out[existingIndex]);
        continue;
      }
      pendingByKey.set(key, out.length);
    }
    out.push(card);
  }
  return out;
}


interface DecisionRow {
  id: string;
  ts: number;
  action: string;
  target: string;
}

function searchableTextForCard(card: SuggestionCard): string {
  return [
    card.title,
    card.why,
    card.reason,
    card.lastFailureReason,
    card.target_harness,
    card.directive_kind,
    card.directive_subject,
    card.directive_body,
    card.target_resource,
    card.body,
    card.action,
    tierLabel(card.actualTier),
    lifecycleLabelForCard(card),
  ]
    .filter(Boolean)
    .join('\n')
    .toLowerCase();
}


import {
  broadcastState,
  hydrateOperatorStateFromPg,
  isAutoAcceptedByThreshold,
  pushAutoAcceptEvent,
  setOperatorState,
  sharedState,
  subscribeOperatorState,
  type AutoAcceptLevel,
  type OperatorState,
} from './operator-shared-state';

gsap.registerPlugin(useGSAP);

export { setOperatorState };

export function OperatorButton(): ReactElement {
  const [state, setState] = useState<OperatorState>(sharedState);

  useEffect(() => {
    const fn = (partial: Partial<OperatorState>) =>
      setState((s) => ({ ...s, ...partial }));
    void hydrateOperatorStateFromPg();
    return subscribeOperatorState(fn);
  }, []);

  useEffect(() => {
    let armed = false;
    let timer: number | null = null;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        armed = true;
        if (timer) window.clearTimeout(timer);
        timer = window.setTimeout(() => {
          armed = false;
        }, 1000);
        return;
      }
      if (armed && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        broadcastState({ open: !sharedState.open });
        armed = false;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const toggle = useCallback(() => {
    broadcastState({ open: !sharedState.open });
  }, []);

  // Pause is "no autonomous work" — manual scan/think/act are user-driven
  // and should override the paused indicator while they're running. Pause
  // re-asserts itself when iconState falls back to idle/awaiting-input.
  const pausedActive = state.paused && (state.iconState === 'idle' || state.iconState === 'awaiting-input');
  const titleByState: Record<IconState, string> = {
    idle: 'Deck — Operator idle',
    scanning: 'Deck — Operator scanning workspace',
    thinking: 'Deck — Operator composing suggestions',
    acting: 'Deck — Operator dispatching',
    paused: 'Deck — Operator paused (autonomous actions disabled)',
    'awaiting-input': 'Deck — Operator awaiting your decision on pending suggestions',
  };
  const title = pausedActive
    ? titleByState.paused
    : state.paused
      ? `${titleByState[state.iconState]} (paused — auto-dispatch off)`
      : titleByState[state.iconState];

  const scanning = state.iconState === 'scanning' || state.iconState === 'thinking';

  // Always-visible count bubbles under the header Deck button. Counts come
  // from sharedState.cards (mirrored from the panel's suggestion array).
  const counts = useMemo(() => {
    const c = { pending: 0, accepted: 0, ignored: 0 };
    for (const card of state.cards) {
      if (card.status === 'pending') c.pending++;
      else if (card.status === 'accepted') c.accepted++;
      else if (card.status === 'ignored') c.ignored++;
    }
    return c;
  }, [state.cards]);


  return (
    <span className="pc-header-cta-shell pc-header-cta-shell--operator">
      <Tooltip label={title}>
      <button
        className={`pc-header-cta pc-header-cta--operator pc-header-cta--${state.iconState}${state.paused ? ' is-paused' : ''}${scanning ? ' is-scanning' : ''}${state.autoAccept !== 'off' ? ' is-auto' : ''}`}
        aria-label={title}
        onClick={toggle}
        aria-expanded={state.open}
        style={{ marginLeft: 8 }}
      >
        <span className="pc-header-cta-orb" aria-hidden="true">
          <DeckCardsMark className="pc-header-cta-logo pc-header-cta-logo--deck" />
          {scanning && <span className="pc-header-cta-scan-ring" aria-hidden="true" />}
          {state.autoAccept !== 'off' && !scanning && <span className="pc-header-cta-auto-dot" aria-hidden="true" />}
        </span>
        <span className="pc-header-cta-label">DECK</span>
      </button>
      </Tooltip>
      <div
        role="status"
        aria-label={`Deck card counts: ${counts.pending} pending, ${counts.accepted} accepted, ${counts.ignored} ignored`}
        aria-live="polite"
        className="pc-operator-popdown"
      >
        <OperatorCountBubble label="pending" count={counts.pending} tone="pending" />
        <OperatorCountBubble label="accepted" count={counts.accepted} tone="accepted" />
        <OperatorCountBubble label="ignored" count={counts.ignored} tone="ignored" />
      </div>
      <OperatorAutoAcceptFeed events={state.recentAutoAccepts} />
    </span>
  );
}

const TIER_DOT_COLOR: Record<'low' | 'medium' | 'high', string> = {
  low: '#10b981',
  medium: '#f59e0b',
  high: '#ef4444',
};

function formatRelativeAgo(now: number, then: number): string {
  const ms = Math.max(0, now - then);
  const sec = Math.floor(ms / 1000);
  if (sec < 5) return 'just now';
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  return `${hr}h ago`;
}

function CustomBudgetEntry({ disabled, onSet }: { disabled: boolean; onSet: (cap: number) => void | Promise<void> }): ReactElement {
  const [value, setValue] = useState<string>('');
  const parsed = Number(value);
  const valid = Number.isFinite(parsed) && parsed > 0 && parsed <= 1000;
  const submit = () => {
    if (!valid || disabled) return;
    void onSet(Math.round(parsed * 100) / 100);
    setValue('');
  };
  return (
    <form
      className="operator-budget-custom"
      onSubmit={(e) => { e.preventDefault(); submit(); }}
      aria-label="Custom daily budget"
    >
      <label className="operator-budget-custom__label">
        Or set a custom amount
      </label>
      <div className="operator-budget-custom__row">
        <span className="operator-budget-custom__prefix" aria-hidden="true">$</span>
        <input
          type="number"
          inputMode="decimal"
          min="0.01"
          max="1000"
          step="0.01"
          placeholder="e.g. 7.50"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-label="Custom daily budget in USD"
          className="operator-budget-custom__input"
          disabled={disabled}
        />
        <span className="operator-budget-custom__suffix">/day</span>
        <button
          type="submit"
          disabled={!valid || disabled}
          className="operator-budget-custom__submit"
        >
          Set
        </button>
      </div>
    </form>
  );
}

function OperatorAutoAcceptFeed({ events }: { events: readonly import('./operator-shared-state').AutoAcceptEvent[] }): ReactElement | null {
  // Tick once per 30s so relative-time labels refresh while the feed is visible.
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (events.length === 0) return;
    const t = setInterval(() => forceTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, [events.length]);
  if (events.length === 0) return null;
  const now = Date.now();

  return (
    <div
      role="region"
      aria-label="Recent auto-accepted cards"
      className="pc-operator-auto-feed"
    >
      <div className="pc-operator-auto-feed__head">
        <span className="pc-operator-auto-feed__title">Auto-accepted</span>
        <span className="pc-operator-auto-feed__count">{events.length}</span>
      </div>
      <ul className="pc-operator-auto-feed__list">
        {events.slice(0, 5).map((e) => (
          <li key={e.id} className="pc-operator-auto-feed__row">
            <span
              aria-hidden="true"
              className="pc-operator-auto-feed__tier-dot"
              style={{ background: TIER_DOT_COLOR[e.tier] }}
            />
            <span className="pc-operator-auto-feed__title-cell" title={e.title}>{e.title}</span>
            {e.targetHarness && (
              <span className="pc-operator-auto-feed__harness">{e.targetHarness}</span>
            )}
            <span className="pc-operator-auto-feed__age">{formatRelativeAgo(now, e.acceptedAt)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function OperatorCountBubble({
  label,
  count,
  tone,
}: {
  label: 'pending' | 'accepted' | 'ignored';
  count: number;
  tone: 'pending' | 'accepted' | 'ignored';
}): ReactElement {
  return (
    <span
      className={`pc-operator-count-bubble pc-operator-count-bubble--${tone}`}
      aria-label={`${count} ${label}`}
      title={`${count} ${label}`}
    >
      {count}
    </span>
  );
}

// Auto-accept threshold cycler. Single click steps Off → Low → Medium → High → Off.
// Tooltip explains what each level means; the visible label is the current level.
const AUTO_ACCEPT_LEVELS_ORDER: readonly AutoAcceptLevel[] = ['off', 'low', 'medium', 'high'];
const AUTO_ACCEPT_LABEL: Record<AutoAcceptLevel, string> = {
  off: 'off',
  low: 'low',
  medium: 'med',
  high: 'high',
};
const AUTO_ACCEPT_TOOLTIP: Record<AutoAcceptLevel, string> = {
  off: 'Auto-accept: OFF. Every suggestion waits for your decision. Background scans still run; cards just queue up. Click to cycle: Off → Low → Medium → High.',
  low: 'Auto-accept: LOW. Only low-risk cards auto-accept after a 10s review window. Medium and high still wait for you. Click to cycle.',
  medium: 'Auto-accept: MEDIUM. Low and medium-risk cards auto-accept after the 10s review window. High-risk still waits for you. Click to cycle.',
  high: 'Auto-accept: HIGH. Every card auto-fires after the 10s review window — INCLUDING high-risk ones (secrets, dispatches, code execution). Use with care. Click to cycle.',
};

export function OperatorAutoScanToggle(): ReactElement {
  const [autoAccept, setAutoAcceptState] = useState<AutoAcceptLevel>(sharedState.autoAccept);
  useEffect(() => {
    return subscribeOperatorState((s) => {
      if (s.autoAccept) setAutoAcceptState(s.autoAccept);
    });
  }, []);
  const cycle = useCallback(() => {
    const i = AUTO_ACCEPT_LEVELS_ORDER.indexOf(sharedState.autoAccept);
    const next = AUTO_ACCEPT_LEVELS_ORDER[(i + 1) % AUTO_ACCEPT_LEVELS_ORDER.length];
    broadcastState({ autoAccept: next });
  }, []);
  const title = AUTO_ACCEPT_TOOLTIP[autoAccept];
  return (
    <Tooltip label={title}>
    <button
      type="button"
      className={`pc-header-cta-mini pc-header-cta-mini--auto pc-header-cta-mini--auto-${autoAccept}${autoAccept !== 'off' ? ' is-on' : ''}`}
      aria-label={title}
      onClick={cycle}
      style={{ marginLeft: 4 }}
    >
      <span className="pc-header-cta-mini-dot" aria-hidden="true" />
      <span className="pc-header-cta-mini-label">auto: {AUTO_ACCEPT_LABEL[autoAccept]}</span>
    </button>
    </Tooltip>
  );
}

interface BudgetSnapshot {
  configured: boolean;
  dailyCapUsd: number;
  todaySpendUsd: number;
  exceeded: boolean;
}

export function OperatorPanel(): ReactElement | null {
  const [state, setState] = useState<OperatorState>(sharedState);
  const [suggestions, setSuggestions] = useState<SuggestionCard[]>([]);
  const [decisions, setDecisions] = useState<DecisionRow[]>([]);
  const [streamLog, setStreamLog] = useState<string[]>([]);
  const [scanStarted, setScanStarted] = useState(false);
  const [firstRun, setFirstRun] = useState(false);
  const [budget, setBudget] = useState<BudgetSnapshot | null>(null);
  const { prompt: askPrompt, element: promptEl } = usePromptDialog();

  // Eager Zero subscriptions for operator-budget + operator-last-scan.
  // Replaces the lazy REST fetches that fired when the panel opens, so
  // the user sees current state same-frame on open. Existing
  // refreshBudget / hydrateFromLastScan callbacks remain as back-stops
  // for post-mutation refresh and as REST fallback while the
  // subscription warms up.
  const operatorWorkspaceId = useWorkspaceId();
  const { data: budgetRows } = useSyncQuery<{ workspaceId: string; payload: BudgetSnapshot; updatedAt: number }>({
    queryName: 'operatorBudget.byWorkspace',
    args: { workspaceId: operatorWorkspaceId },
    enabled: !!operatorWorkspaceId,
  });
  useEffect(() => {
    if (!Array.isArray(budgetRows) || budgetRows.length === 0) return;
    setBudget(budgetRows[0].payload as BudgetSnapshot);
  }, [budgetRows]);
  const { data: lastScanRows } = useSyncQuery<{ workspaceId: string; payload: unknown; updatedAt: number }>({
    queryName: 'operatorLastScan.byWorkspace',
    args: { workspaceId: operatorWorkspaceId },
    enabled: !!operatorWorkspaceId,
  });
  const lastScanPayloadRef = useRef<unknown>(null);
  useEffect(() => {
    if (!Array.isArray(lastScanRows) || lastScanRows.length === 0) return;
    const payload = lastScanRows[0].payload as {
      cards?: (ParsedSuggestion & {
        _status?: string;
        _dispatchedAt?: number;
        _undoCancelled?: boolean;
      })[];
    } | null;
    lastScanPayloadRef.current = payload;
    // Seed `suggestions` from the Zero subscription so the top-bar Deck
    // count widget reflects pending/accepted/ignored counts before the
    // panel has ever been opened. The full REST-based hydrate still runs
    // on open as a backstop, but cards is the canonical source.
    const cards = payload?.cards;
    if (!cards?.length) return;
    setSuggestions((prev) => {
      if (prev.length > 0) return prev;
      return dedupePendingSuggestionCards(cards.map((c) => {
        const { _status, _dispatchedAt, _undoCancelled, ...rest } = c;
        const status = normalizeLifecycleState(_status);
        return {
          ...rest,
          status,
          acceptedAt: status === 'accepted' ? _dispatchedAt : undefined,
          autoDispatchAt: undefined,
          undoCancelled: _undoCancelled,
        };
      }));
    });
  }, [lastScanRows]);

  // Eager Zero subscription for the Decisions rail. Replaces the lazy
  // /api/agent-mcp/decisions?limit=20 fetch on panel open. The view's
  // workspace RLS doesn't apply to Zero (BYPASSRLS), so the query
  // filters by workspace + actor='system:operator' explicitly.
  // Schema row uses `subject` (the underlying audit_log column);
  // operator_decisions view aliases it to `target` — we map here.
  const { data: decisionRows } = useSyncQuery<{
    id: string;
    ts: number;
    action: string;
    subject: string;
  }>({
    queryName: 'auditLog.operatorDecisions',
    args: { workspaceId: operatorWorkspaceId, limit: 20 },
    enabled: !!operatorWorkspaceId,
  });
  useEffect(() => {
    if (!Array.isArray(decisionRows)) return;
    setDecisions(decisionRows.map((r) => ({
      id: r.id,
      ts: r.ts,
      action: r.action,
      target: r.subject,
    })));
  }, [decisionRows]);
  const [budgetSaving, setBudgetSaving] = useState(false);

  // Budget tiers are PG-backed (Migration 037). Falls back to a static
  // 3-tier list if the API is down — the picker should never be empty.
  const [budgetTiers, setBudgetTiers] = useState<Array<{ label: string; cap: number; blurb: string }>>([
    { label: 'Light',  cap: 5,  blurb: '~50 scans/day with default model' },
    { label: 'Active', cap: 20, blurb: 'recommended for daily use' },
    { label: 'Heavy',  cap: 50, blurb: 'large workspaces or always-on background' },
  ]);
  useEffect(() => {
    let cancelled = false;
    fetch('/api/operator/budget-tiers')
      .then((r) => r.json())
      .then((d) => {
        if (cancelled || !Array.isArray(d.tiers) || d.tiers.length === 0) return;
        setBudgetTiers(d.tiers);
      })
      .catch(() => { /* keep static fallback */ });
    return () => { cancelled = true; };
  }, []);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const evtSrcRef = useRef<{ close: () => void } | null>(null);
  const [feedQuery, setFeedQuery] = useQueryState('deckQ', parseAsString.withDefault(''));
  const [mainView, setMainView] = useQueryState<MainView>(
    'deckView',
    parseAsStringLiteral(['cards', 'accepted', 'ignored', 'scan-history'] as const).withDefault('cards'),
  );
  // Active harness filter — selected from the card toolbar dropdown.
  // Empty string = all harnesses.
  const [harnessFilterValue, setHarnessFilterValue] = useQueryState('deckHarness', parseAsString.withDefault(''));
  const harnessFilter = harnessFilterValue || null;
  const [harnessRows, setHarnessRows] = useState<HarnessOneLiner[]>([]);
  const [scanStatus, setScanStatus] = useState<ScanStatus>('idle');
  const [scanError, setScanError] = useState<string | null>(null);
  const [provisioning, setProvisioning] = useState(false);
  const [confirmingDispatch, setConfirmingDispatch] = useState<Record<string, boolean>>({});
  const [now, setNow] = useState(() => Date.now());
  const deferredFeedQuery = useDeferredValue(feedQuery.trim().toLowerCase());
  // Detect when the panel is rendered on the settings page itself, so
  // the "Set up Operator →" CTA doesn't become a useless self-link.
  const pathname = usePathname();
  const onSettingsPage = pathname === '/settings/operator';


  useEffect(() => {
    let cancelled = false;
    fetch('/api/agent-mcp/operator-trigger-state')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled || !d?.state?.perHarness) return;
        setHarnessRows(d.state.perHarness);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Subscribe to shared state.
  useEffect(() => {
    const fn = (partial: Partial<OperatorState>) =>
      setState((s) => ({ ...s, ...partial }));
    return subscribeOperatorState(fn);
  }, []);

  // Click-outside or Escape to close.
  useEffect(() => {
    if (!state.open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!panelRef.current) return;
      if (panelRef.current.contains(e.target as Node)) return;
      const target = e.target as HTMLElement;
      if (target.closest('[aria-label^="Deck"]')) return;
      broadcastState({ open: false });
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') broadcastState({ open: false });
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [state.open]);
  useEffect(() => {
    if (!state.open) return;
    // Updates `now` so relative timestamps in the panel re-render. 500ms
    // was overkill — at 2 re-renders/sec × ~287 nodes the panel was
    // doing reconciliation work even when nothing relevant had changed.
    // Most timestamps in this panel are minutes-old; 5s is well under
    // the perceptible threshold for "this was just now" timestamps and
    // cuts the steady-state render rate by 10×. See /docs/performance #A7.
    const t = window.setInterval(() => setNow(Date.now()), 5000);
    return () => window.clearInterval(t);
  }, [state.open]);



  // Kick off a scan when the panel opens.
  const startScan = useCallback((request?: string) => {
    if (evtSrcRef.current) {
      evtSrcRef.current.close();
      evtSrcRef.current = null;
    }
    setSuggestions([]);
    setStreamLog([]);
    setScanError(null);
    setScanStatus('scanning');
    broadcastState({ iconState: 'scanning' });
    setScanStarted(true);
    const url =
      `/api/agent-mcp/operator-scan?request=${encodeURIComponent(request ?? '')}`;
    const source = createResilientEventSource({
      url,
      maxConsecutiveFailures: 0, // one-shot stream — don't escalate
      handlers: {
        first_run: () => setFirstRun(true),
        delta: (data) => {
          try {
            const { text } = JSON.parse(data);
            setStreamLog((log) => {
              const next = [...log];
              const last = next[next.length - 1] ?? '';
              if (last.length < 200) {
                next[next.length - 1] = (last + text).slice(-200);
              } else {
                next.push(text.slice(0, 200));
              }
              return next.slice(-5);
            });
          } catch { /* ignore */ }
          broadcastState({ iconState: 'thinking' });
        },
        tool_call: () => {
          broadcastState({ iconState: 'scanning' });
        },
        idle_status: (data) => {
          try {
            const parsed = JSON.parse(data) as { perHarness?: HarnessOneLiner[] };
            if (Array.isArray(parsed.perHarness)) setHarnessRows(parsed.perHarness);
          } catch { /* ignore */ }
        },
        suggestion: (data) => { handleSuggestionEvent(data); },
        done: () => { handleDoneEvent(); },
        error: (data) => { handleErrorEvent(data); },
      },
    });
    evtSrcRef.current = source;

    function handleSuggestionEvent(data: string) {
      try {
        const raw = JSON.parse(data) as ParsedSuggestion;
        // Auto-accept reconciliation between server (conservative) and
        // client (user-toggleable threshold):
        //
        //   - Server emits auto_dispatch=true only when the suggestion's
        //     actualTier is low (or medium with a standing approval).
        //     It NEVER emits auto_dispatch=true for tier=high — the
        //     server has no view into the user's session-scoped
        //     autoAccept threshold.
        //   - Client downgrades auto→ask when paused or when the tier
        //     exceeds the user's threshold.
        //   - Client UPGRADES ask→auto when the user has explicitly set
        //     autoAccept='high' (or 'medium' for a medium card the
        //     server didn't standing-approve). This is how the user
        //     opts into auto-dispatch for high-risk cards: they cycle
        //     the navbar auto button to HIGH, accepting that everything
        //     auto-fires after the 10s review window.
        const tierAllowed = isAutoAcceptedByThreshold(raw.actualTier, sharedState.autoAccept);
        let nextAuto = raw.auto_dispatch;
        if (nextAuto && (sharedState.paused || !tierAllowed)) nextAuto = false;
        else if (!nextAuto && tierAllowed && !sharedState.paused) nextAuto = true;
        const s: ParsedSuggestion = nextAuto !== raw.auto_dispatch
          ? { ...raw, auto_dispatch: nextAuto }
          : raw;
        setSuggestions((prev) => {
          const autoDispatchAt = s.auto_dispatch ? Date.now() + 10_000 : undefined;
          const idx = prev.findIndex((c) => c.id === s.id);
          if (idx >= 0) {
            // Stable-id collision. Pending cards get their content
            // refreshed in place (operator refined the same suggestion).
            // Terminal cards (accepted / ignored) stay as the user's
            // recorded decision — the new emission lands as a separate
            // pending card so the user can see it again.
            const next = prev.slice();
            const prior = prev[idx];
            if (prior.status === 'pending') {
              next[idx] = {
                ...prior,
                ...s,
                status: 'pending',
                autoDispatchAt,
                duplicateCount: prior.duplicateCount,
              };
            } else {
              next.push({ ...s, status: 'pending', autoDispatchAt });
            }
            return next;
          }
          const exactKey = duplicateKeyForCard(s);
          const exactIdx = prev.findIndex((c) => c.status === 'pending' && duplicateKeyForCard(c) === exactKey);
          if (exactIdx >= 0) {
            const next = prev.slice();
            next[exactIdx] = bumpDuplicateCount(next[exactIdx]);
            return next;
          }
          // Fuzzy dedup: titles that paraphrase a still-pending card
          // collapse rather than stack. Only collapse against pending —
          // accepted/ignored cards have user-visible decisions we
          // shouldn't mask.
          const candidates = prev
            .filter((c) => c.status === 'pending')
            .map((c) => ({ id: c.id, title: c.title }));
          const fuzzy = findFuzzyDuplicate(s.title, candidates);
          if (fuzzy) {
            const fIdx = prev.findIndex((c) => c.id === fuzzy.matchedId);
            if (fIdx >= 0) {
              const dup = prev.slice();
              dup[fIdx] = {
                ...prev[fIdx],
                ...s,
                id: prev[fIdx].id,
                status: 'pending',
                autoDispatchAt,
                duplicateCount: (prev[fIdx].duplicateCount ?? 1) + 1,
              };
              return dup;
            }
          }
          return [
            ...prev,
            { ...s, status: 'pending', autoDispatchAt },
          ];
        });
        // Voice mode: speak the suggestion title + why-line.
        // Gated by `speakSuggestions` toggle (v4 §3.2). Voice-readable
        // provenance flags (Phase 6) are appended; tier=high uses
        // assertive aria-live priority.
        if (getVoiceState().mode !== 'off') {
          import('./voice/voice-prefs-client').then(({ loadVoicePrefsClient }) => {
            const prefs = loadVoicePrefsClient();
            if (!prefs.speakSuggestions) return;
            let suffix = '';
            if (s.provenanceFlags?.tierMismatch) suffix += ' Warning: tier mismatch — substrate forced authoritative.';
            if (s.provenanceFlags?.capabilityUnknown) suffix += ' Warning: unknown capability — forced high.';
            const priority = s.actualTier === 'high' ? 'assertive' : 'polite';
            speak(`${s.title}. ${s.why}${suffix}`, 'system:operator', priority);
          }).catch(() => {});
        }
      } catch { /* ignore */ }
    }

    function handleDoneEvent() {
      const askFirstPending = suggestionsRef.current.some(
        (c) => c.status === 'pending' && !c.auto_dispatch,
      );
      setScanStatus('complete');
      broadcastState({ iconState: askFirstPending ? 'awaiting-input' : 'idle' });
      source.close();
      evtSrcRef.current = null;
      void refreshDecisions();
    }

    function handleErrorEvent(detail: string) {
      setStreamLog((log) => [...log, `error: ${detail}`]);
      setScanError(detail);
      setScanStatus('error');
      broadcastState({ iconState: 'idle' });
      source.close();
      evtSrcRef.current = null;
    }
  }, []);

  const provisionAndRescan = useCallback(async () => {
    setProvisioning(true);
    setScanError(null);
    try {
      const r = await fetch('/api/agent-mcp/provision', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!r.ok) {
        const text = await r.text().catch(() => '');
        setScanError(`Provision failed (${r.status}): ${text || 'no detail'}`);
        return;
      }
      // Provisioned — clear the error state and kick off a real scan.
      setScanStatus('idle');
      startScan();
    } catch (err) {
      setScanError(`Provision failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setProvisioning(false);
    }
  }, [startScan]);

  const refreshDecisions = useCallback(async () => {
    try {
      const r = await fetch('/api/agent-mcp/decisions?limit=20');
      if (!r.ok) return;
      const d = await r.json();
      if (Array.isArray(d?.rows)) setDecisions(d.rows);
    } catch {
      /* ignore */
    }
  }, []);

  // Receiving-state polling (Zero watcher + REST fallback) was removed
  // when the lifecycle simplified to {pending, accepted, ignored}. Once
  // a card is accepted, it stays accepted — we no longer try to track
  // what the harness did with the directive afterward.

  const hydrateFromLastScan = useCallback(async () => {
    try {
      const r = await fetch('/api/agent-mcp/operator-last-scan');
      if (!r.ok) return;
      const { snapshot } = (await r.json()) as {
        snapshot: {
          cards: (ParsedSuggestion & {
            _status?: string;
            _dispatchedAt?: number;
            _undoCancelled?: boolean;
          })[];
        } | null;
      };
      if (!snapshot?.cards?.length) return;
      // Only hydrate when we have nothing on screen — never blow away an
      // in-flight scan.
      setSuggestions((prev) => {
        if (prev.length > 0) return prev;
        return dedupePendingSuggestionCards(snapshot.cards.map((c) => {
          const { _status, _dispatchedAt, _undoCancelled, ...rest } = c;
          const status = normalizeLifecycleState(_status);
          return {
            ...rest,
            status,
            acceptedAt: status === 'accepted' ? _dispatchedAt : undefined,
            autoDispatchAt: rest.auto_dispatch && status === 'pending' ? Date.now() + 10_000 : undefined,
            undoCancelled: _undoCancelled,
          };
        }));
      });
    } catch {
      /* ignore */
    }
  }, []);

  const refreshBudget = useCallback(async () => {
    try {
      const r = await fetch('/api/agent-mcp/operator-budget');
      if (!r.ok) return;
      const snap = (await r.json()) as BudgetSnapshot;
      setBudget(snap);
      // Voice budget warning at 80% / 100% (v4 §2e). Per-kind dedup
      // (30 min) is server-side via /api/agent-mcp/operator-nudge.
      if (snap.configured && getVoiceState().mode !== 'off') {
        const ratio = snap.todaySpendUsd / Math.max(snap.dailyCapUsd, 0.01);
        if (ratio >= 0.8) {
          import('./voice/voice-prefs-client').then(async ({ loadVoicePrefsClient }) => {
            if (!loadVoicePrefsClient().speakNudges) return;
            const nudge = await fetch('/api/agent-mcp/operator-nudge', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ kind: 'budget' }),
            }).then((nr) => nr.ok ? nr.json() : { fired: false });
            if (nudge.fired) {
              const phrase = ratio >= 1.0
                ? `Operator paused. Daily budget reached: ${snap.todaySpendUsd.toFixed(2)}.`
                : `Operator budget at ${Math.round(ratio * 100)} percent — ${snap.todaySpendUsd.toFixed(2)} of ${snap.dailyCapUsd}.`;
              speak(phrase, 'system:operator-nudge', 'assertive');
            }
          }).catch(() => {});
        }
      }
    } catch {
      /* ignore */
    }
  }, []);

  const setBudgetCap = useCallback(async (cap: number) => {
    setBudgetSaving(true);
    try {
      await fetch('/api/agent-mcp/operator-budget', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dailyCapUsd: cap }),
      });
      await refreshBudget();
    } finally {
      setBudgetSaving(false);
    }
  }, [refreshBudget]);

  useEffect(() => {
    if (!state.open) {
      if (evtSrcRef.current) {
        evtSrcRef.current.close();
        evtSrcRef.current = null;
      }
      return;
    }
    void refreshBudget();
    void refreshDecisions();
    void hydrateFromLastScan();
    // Cards pre-seeded by the lastScan Zero subscription (so the top-bar
    // count widget renders pre-open) intentionally skip setting
    // autoDispatchAt. Start their review windows now that the panel is
    // actually visible.
    setSuggestions((prev) => {
      let touched = false;
      const next = prev.map((c) => {
        if (c.status !== 'pending' || !c.auto_dispatch || c.autoDispatchAt) return c;
        touched = true;
        return { ...c, autoDispatchAt: Date.now() + 10_000 };
      });
      return touched ? next : prev;
    });
    // Don't auto-scan until the user has confirmed a budget cap.
    if (!scanStarted && !state.paused && budget?.configured && !budget.exceeded) {
      startScan();
    }
  }, [state.open, state.paused, scanStarted, startScan, refreshDecisions, refreshBudget, hydrateFromLastScan, budget?.configured, budget?.exceeded]);


  // Voice-action provenance (v4 §2m): flipped to 'voice' for the duration
  // of voice-utterance-handled actions so logAudit tags them correctly.
  // Reset to 'click' otherwise.
  const actorMethodRef = useRef<'voice' | 'click' | 'api'>('click');

  const logAudit = useCallback(async (cardId: string, kind: 'accepted' | 'ignored' | 'accept_failed' | 'undo_cancel', context?: Record<string, unknown>) => {
    try {
      await fetch('/api/agent-mcp/operator-audit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cardId, kind, context, actorMethod: actorMethodRef.current }),
      });
    } catch {
      /* best-effort */
    }
  }, []);

  const dispatchSuggestion = useCallback(async (id: string) => {
    const card = suggestionsRef.current.find((c) => c.id === id);
    if (!card) return;
    setConfirmingDispatch((prev) => {
      const { [id]: _removed, ...rest } = prev;
      return rest;
    });
    broadcastState({ iconState: 'acting' });

    // Side-effect by kind. On any failure we stay pending and bump the
    // failure counters; on success we flip to 'accepted' once.
    const recordFailure = (reason: string) => {
      setSuggestions((prev) =>
        prev.map((c) =>
          c.id === id
            ? {
                ...c,
                failedAttempts: (c.failedAttempts ?? 0) + 1,
                lastFailureReason: reason,
                lastFailureAt: Date.now(),
              }
            : c,
        ),
      );
      void logAudit(id, 'accept_failed', {
        action: card.action,
        target: card.target_harness ?? null,
        reason,
      });
    };

    const recordSuccess = (extra: Partial<SuggestionCard> = {}) => {
      setSuggestions((prev) =>
        prev.map((c) =>
          c.id === id
            ? {
                ...c,
                ...extra,
                status: 'accepted',
                acceptedAt: Date.now(),
                failedAttempts: undefined,
                lastFailureReason: undefined,
                lastFailureAt: undefined,
              }
            : c,
        ),
      );
      // Auto-fired (auto_dispatch was true)? Surface in the popdown feed.
      // Manual Accept clicks aren't included — those are user-initiated.
      if (card.auto_dispatch) {
        pushAutoAcceptEvent({
          id: card.id,
          title: card.title,
          tier: card.actualTier,
          targetHarness: card.target_harness,
          acceptedAt: Date.now(),
          source: 'panel-auto',
        });
      }
      void logAudit(id, 'accepted', {
        action: card.action,
        capability: card.capability ?? null,
        target: card.target_harness ?? null,
      });
    };

    try {
      if (card.action === 'inform') {
        // No side effect — the audit log entry is the whole action.
        recordSuccess();
        return;
      }
      if (card.action === 'navigate') {
        const url = card.target_resource ?? null;
        if (!url) {
          recordFailure('navigate card has no target_resource');
          return;
        }
        const opened = typeof window !== 'undefined' ? window.open(url, '_blank', 'noopener,noreferrer') : null;
        if (!opened) {
          recordFailure('window.open blocked (popup blocker?) — try clicking again');
          return;
        }
        recordSuccess();
        return;
      }
      // send_directive (the only remaining kind).
      if (!card.target_harness) {
        recordFailure('directive card has no target_harness');
        return;
      }
      const r = await fetch('/api/agent-mcp/operator-dispatch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          actionId: `${card.id}:dispatch`,
          op: 'send_directive',
          to: [card.target_harness],
          kind: card.directive_kind ?? 'Directive',
          subject: card.directive_subject,
          body: card.directive_body,
          reason: card.reason,
        }),
      });
      if (!r.ok) {
        const text = await r.text().catch(() => '');
        recordFailure(text || `HTTP ${r.status}`);
        return;
      }
      // Hard-fail when 200 but no msg_id — without it we'd lose
      // traceability for any future per-card lookups.
      let messageId: string | undefined;
      try {
        const data = await r.clone().json();
        messageId = data?.result?.msg_id;
      } catch {
        /* response wasn't JSON */
      }
      if (!messageId) {
        recordFailure('dispatch returned 200 but no msg_id');
        return;
      }
      recordSuccess({ messageId });
    } catch (err) {
      recordFailure(err instanceof Error ? err.message : String(err));
    } finally {
      broadcastState({ iconState: 'idle' });
      void refreshDecisions();
    }
  }, [refreshDecisions, logAudit]);

  const suggestionsRef = useRef<SuggestionCard[]>([]);
  useEffect(() => {
    suggestionsRef.current = suggestions;
  }, [suggestions]);

  useEffect(() => {
    if (!state.open || state.paused) return;
    const due = suggestions.find(
      (s) =>
        s.status === 'pending' &&
        s.auto_dispatch &&
        s.autoDispatchAt &&
        s.autoDispatchAt <= now &&
        // Re-check threshold at fire time so a user dropping the level
        // mid-window (e.g. High → Off) prevents the deadline firing.
        isAutoAcceptedByThreshold(s.actualTier, state.autoAccept),
    );
    if (due) void dispatchSuggestion(due.id);
  }, [dispatchSuggestion, now, state.open, state.paused, state.autoAccept, suggestions]);

  /**
   * Deliberate dismiss — user clicked Dismiss in the panel. Optionally
   * collect a reason so Operator can learn from the dismissal (Phase 4a).
   * Skipping the reason still records the dismissal in card state but
   * leaves preferences.md untouched.
   */
  const dismissSuggestion = useCallback(async (id: string) => {
    const card = suggestionsRef.current.find((c) => c.id === id);
    setSuggestions((prev) =>
      prev.map((c) =>
        c.id === id ? { ...c, status: 'ignored', undoCancelled: false } : c,
      ),
    );
    void fetch('/api/agent-mcp/operator-dismissed', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    void logAudit(id, 'ignored');
    if (!card) return;
    const reason = await askPrompt({
      title: 'Why ignore this?',
      label: 'Reason (optional)',
      body: 'Tell Operator why this suggestion isn\'t useful so it can learn. Leave blank to dismiss without logging.',
      placeholder: 'not relevant to this harness…',
      submitLabel: 'Dismiss',
      allowEmpty: true,
    });
    if (!reason || !reason.trim()) return;
    const entry = `- [USER-TYPED] [DISMISS] "${card.title.replace(/"/g, '\\"')}" — reason: "${reason.trim().replace(/"/g, '\\"')}"`;
    void fetch('/api/agent-mcp/operator-preferences', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entry }),
    });
  }, [askPrompt]);

  /**
   * Undo-window cancel — user hit Keep for review during the 10s window of a background
   * auto-fire toast. Audit-only; explicitly DOES NOT touch preferences
   * (per §4 decision 2). Background auto-fire toasts arrive in Phase 3;
   * this helper is exported now so the existing UI dismiss button can
   * share the lifecycle without confusing the two paths.
   */
  const undoCancelSuggestion = useCallback(
    (id: string) => {
      setSuggestions((prev) =>
        prev.map((c) =>
          c.id === id ? { ...c, status: 'ignored', undoCancelled: true } : c,
        ),
      );
      void logAudit(id, 'undo_cancel');
    },
    [logAudit],
  );

  // Voice mode: subscribe to final utterances while panel is open and
  // route commands to Operator actions. Falls through to scan(query)
  // when no strict command matches.
  useEffect(() => {
    if (!state.open) return;
    const dereg = registerVoiceConsumer('OperatorPanel');
    // Focus-transfer (v4 §2i): when the panel opens, this tab claims the
    // voice lead so spoken output follows user attention. No-op if we're
    // already leader or BroadcastChannel is unavailable.
    void import('./voice/voice-leader').then((m) => m.requestVoiceLead('panel-open')).catch(() => {});
    const unsub = onFinalUtterance(async (text) => {
      if (!text || text.length < 2) return;
      // v4 §2m: tag voice-initiated audit rows. Restore on next macrotask.
      actorMethodRef.current = 'voice';
      try {
        const { parseVoiceCommand } = await import('../../lib/voice-commands');
        const cmd = parseVoiceCommand(text);
        const orderedPending = suggestionsRef.current.filter((c) => c.status === 'pending');
        const pickByOrdinal = (ord?: number) => {
          if (ord === undefined) return orderedPending[0];
          return orderedPending[ord - 1];
        };
        switch (cmd.kind) {
          case 'dispatch': {
            const card = pickByOrdinal(cmd.ordinal);
            if (card) await dispatchSuggestion(card.id);
            return;
          }
          case 'dismiss': {
            const card = pickByOrdinal(cmd.ordinal);
            if (card) dismissSuggestion(card.id);
            return;
          }
          case 'pause':
            broadcastState({ paused: true });
            return;
          case 'resume':
            broadcastState({ paused: false });
            return;
          case 'cancel':
            return;
          case 'scan':
            startScan(cmd.query);
            return;
          case 'freeform':
          default:
            startScan(cmd.text);
        }
      } finally {
        setTimeout(() => { actorMethodRef.current = 'click'; }, 50);
      }
    });
    return () => {
      dereg();
      unsub();
    };
  }, [state.open, startScan, dispatchSuggestion, dismissSuggestion]);

  // Voice / Oracle / palette can drive cards via window events. The
  // registry's panel.dispatch-card / panel.dismiss-card commands fire
  // these; we forward to the existing local handlers so behavior is
  // identical to a click.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onDispatch = (e: Event) => {
      const id = (e as CustomEvent).detail?.id;
      if (id) void dispatchSuggestion(id);
    };
    const onDismiss = (e: Event) => {
      const id = (e as CustomEvent).detail?.id;
      if (id) dismissSuggestion(id);
    };
    window.addEventListener('operator:dispatch-card', onDispatch as EventListener);
    window.addEventListener('operator:dismiss-card', onDismiss as EventListener);
    return () => {
      window.removeEventListener('operator:dispatch-card', onDispatch as EventListener);
      window.removeEventListener('operator:dismiss-card', onDismiss as EventListener);
    };
  }, [dispatchSuggestion, dismissSuggestion]);

  // Bridge the operator.scan-request / operator.across-workspaces
  // events the registry fires from voice/Oracle. Voice has been firing
  // these without listeners since PR 5; consume them now so the
  // commands actually do something.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onScan = (e: Event) => {
      const query = (e as CustomEvent).detail?.query as string | undefined;
      // Open + start scan; query is informational (panel doesn't currently
      // accept a seed query but we stash it on state so future UI can use it).
      broadcastState({ open: true });
      void startScan(query);
    };
    const onOpen = () => broadcastState({ open: true });
    window.addEventListener('operator:scan-request', onScan as EventListener);
    window.addEventListener('operator:open-request', onOpen as EventListener);
    return () => {
      window.removeEventListener('operator:scan-request', onScan as EventListener);
      window.removeEventListener('operator:open-request', onOpen as EventListener);
    };
  }, [startScan]);

  const pendingCount = suggestions.filter((s) => s.status === 'pending').length;
  const acceptedCount = suggestions.filter((s) => s.status === 'accepted').length;
  const ignoredCount = suggestions.filter((s) => s.status === 'ignored').length;

  const sortedSuggestions = useMemo(
    () => suggestions
      .map((s, index) => ({ s, index }))
      .sort((a, b) => {
        // Pending cards with prior failures float above clean pending so the
        // user can retry them without hunting.
        const aRetry = a.s.status === 'pending' && (a.s.failedAttempts ?? 0) > 0 ? 1 : 0;
        const bRetry = b.s.status === 'pending' && (b.s.failedAttempts ?? 0) > 0 ? 1 : 0;
        if (aRetry !== bRetry) return bRetry - aRetry;
        const tierDelta = TIER_SORT_RANK[b.s.actualTier] - TIER_SORT_RANK[a.s.actualTier];
        if (tierDelta !== 0) return tierDelta;
        return b.index - a.index;
      })
      .map(({ s }) => s),
    [suggestions],
  );
  const textFilterActive = deferredFeedQuery.length > 0;
  const filterActive = textFilterActive || harnessFilter != null;
  const harnessOptions = useMemo(() => {
    const slugs = new Set<string>();
    harnessRows.forEach((h) => slugs.add(h.slug));
    suggestions.forEach((s) => {
      if (s.target_harness) slugs.add(s.target_harness);
    });
    decisions.forEach((d) => {
      const target = d.target?.replace(/^harness:/, '').split('/')[0];
      if (target) slugs.add(target);
    });
    return [
      { value: '_all', label: 'All harnesses' },
      ...Array.from(slugs).sort().map((slug) => ({ value: slug, label: slug })),
    ];
  }, [decisions, harnessRows, suggestions]);
  const activeFilterParts = [
    harnessFilter,
    feedQuery.trim() ? `“${feedQuery.trim()}”` : null,
  ].filter((part): part is string => Boolean(part));
  const lastScanUpdatedAt = Array.isArray(lastScanRows) ? lastScanRows[0]?.updatedAt : undefined;
  const lastScanAgeLabel = useMemo(() => {
    if (typeof lastScanUpdatedAt !== 'number' || !Number.isFinite(lastScanUpdatedAt)) return null;
    const timestamp = lastScanUpdatedAt < 1_000_000_000_000 ? lastScanUpdatedAt * 1000 : lastScanUpdatedAt;
    const minutes = Math.max(0, Math.round((now - timestamp) / 60_000));
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 48) return `${hours}h ago`;
    return `${Math.round(hours / 24)}d ago`;
  }, [lastScanUpdatedAt, now]);
  const filteredSuggestions = useMemo(() => {
    let list = sortedSuggestions;
    if (mainView === 'cards') {
      list = list.filter((s) => s.status === 'pending');
    } else if (mainView === 'accepted') {
      list = list.filter((s) => s.status === 'accepted');
    } else if (mainView === 'ignored') {
      list = list.filter((s) => s.status === 'ignored');
    }
    if (harnessFilter != null) {
      list = list.filter((s) => s.target_harness === harnessFilter);
    }
    if (textFilterActive) {
      list = list.filter((s) => searchableTextForCard(s).includes(deferredFeedQuery));
    }
    return list;
  }, [deferredFeedQuery, harnessFilter, mainView, sortedSuggestions, textFilterActive]);
  const visibleSuggestions = filteredSuggestions;
  // Publish a compact snapshot of visible cards so registry queries
  // (panel.cards) can be answered without re-fetching from the server.
  // Uses the imported broadcastState helper to avoid a render loop.
  // Broadcast ALL suggestions (not just the current view) so the
  // OperatorButton popdown can show pending/accepted/ignored counts
  // independent of the user's active tab/filter.
  useEffect(() => {
    broadcastState({
      cards: suggestions.slice(0, 200).map((c) => ({
        id: c.id,
        title: c.title,
        action: c.action,
        tier: c.actualTier,
        status: c.status,
        targetHarness: c.target_harness,
        reason: c.reason,
        autoDispatch: !!c.auto_dispatch,
      })),
    });
  }, [suggestions]);
  const hasFeedEntries = visibleSuggestions.length > 0;
  const hasCardEntries = sortedSuggestions.some((s) => (
    mainView === 'cards'
      ? s.status === 'pending'
      : mainView === 'accepted'
        ? s.status === 'accepted'
        : mainView === 'ignored'
          ? s.status === 'ignored'
          : s.status !== 'pending'
  ));
  const filteredEmpty = filterActive && hasCardEntries && !hasFeedEntries;
  const streamMuted = scanStatus === 'complete' && suggestions.length > 0;
  // Per-tab empty states are independent of scanStatus: a scan-in-progress
  // does not change whether the Accepted/Ignored lists are empty, so don't
  // overwrite their copy with "Scanning workspace…".
  const emptyTitle = filteredEmpty
    ? (mainView === 'accepted' ? 'No accepted actions match your filter' : mainView === 'ignored' ? 'No ignored actions match your filter' : 'No pending actions match your filter')
    : mainView === 'accepted'
      ? 'No accepted actions yet'
      : mainView === 'ignored'
        ? 'No ignored actions yet'
        : scanStatus === 'error'
          ? 'Operator scan needs setup'
          : scanStatus === 'scanning'
            ? 'Scanning workspace…'
            : state.paused
              ? 'Operator is paused'
              : scanStatus === 'complete' && suggestions.length === 0
                ? 'No suggestions found'
                : scanStarted
                  ? "Operator hasn't surfaced any pending actions"
                  : 'Operator has not scanned yet';
  const emptyBody = filteredEmpty
    ? 'Filters are narrowing this view. Clear the active filters or choose a different harness.'
    : mainView === 'accepted'
      ? 'Accepted actions will appear here after you accept them.'
      : mainView === 'ignored'
        ? 'Ignored actions will appear here after you ignore them.'
        : scanStatus === 'error'
          ? 'The scan did not complete. Check Operator settings or provision the substrate before scanning again.'
          : scanStatus === 'scanning'
            ? 'Operator is checking workspace state, recent decisions, and pending harness work.'
            : state.paused
              ? 'Resume Operator before automatic scans continue. You can still run a manual scan from the controls above.'
              : scanStatus === 'complete' && suggestions.length === 0
                ? `Last scan completed ${lastScanAgeLabel ?? 'recently'} and found no actions. Run Scan again when the workspace changes.`
                : scanStarted
                  ? `Last scan completed ${lastScanAgeLabel ?? 'recently'} without pending actions. Run Scan to reassess the workspace.`
                  : 'Click Scan to check workspace state, recent decisions, and pending harness work.';
  // Pause is masked by active states (scanning/thinking/acting) so manual
  // user-driven work is visible even when auto-dispatch is paused.
  const pausedVisible = state.paused && (state.iconState === 'idle' || state.iconState === 'awaiting-input');
  const effectiveIconState: IconState = pausedVisible ? 'paused' : state.iconState;
  const statusLabel = pausedVisible
    ? 'paused'
    : state.paused
      ? `${state.iconState.replace('-', ' ')} (paused)`
      : state.iconState.replace('-', ' ');
  const reducedMotion = useReducedMotion() ?? false;
  const visualEffectsEnabled = useFancyEffectsEnabled();
  const calmMotion = reducedMotion || !visualEffectsEnabled;
  const panelMotion = calmMotion
    ? {
        initial: { opacity: 0 },
        animate: { opacity: 1, transition: { duration: 0.16, ease: [0.2, 0, 0, 1] as const } },
        exit: { opacity: 0, transition: { duration: 0.14, ease: [0.7, 0, 0.84, 0] as const } },
      }
    : {
        initial: {
          opacity: 0,
          x: 196,
          y: -188,
          scale: 0.72,
          rotate: -18,
          rotateX: -26,
          rotateY: 22,
          skewX: -7,
        },
        animate: {
          opacity: [0, 1, 1, 1],
          x: [196, -28, 9, 0],
          y: [-188, 20, -7, 0],
          scale: [0.72, 1.06, 0.985, 1],
          rotate: [-18, 4, -1.25, 0],
          rotateX: [-26, 8, -2.25, 0],
          rotateY: [22, -6, 1.75, 0],
          skewX: [-7, 2.2, -0.55, 0],
          transition: {
            duration: 1.05,
            times: [0, 0.62, 0.84, 1],
            ease: [0.16, 1, 0.3, 1] as const,
            opacity: { duration: 0.24, ease: [0.16, 1, 0.3, 1] as const },
          },
        },
        exit: {
          opacity: 0,
          x: 220,
          y: -184,
          scale: 0.68,
          rotate: 20,
          rotateX: 26,
          rotateY: -28,
          skewX: 8,
          transition: {
            duration: 0.48,
            ease: [0.7, 0, 0.84, 0] as const,
          },
        },
      };

  useGSAP(
    () => {
      if (!panelRef.current || calmMotion) return;
      const q = gsap.utils.selector(panelRef.current);
      const intro = gsap.timeline({ defaults: { ease: 'power3.out' } });

      intro
        .fromTo(
          q('.operator-reactor-shell'),
          { autoAlpha: 0, scale: 0.52, rotate: -82 },
          { autoAlpha: 1, scale: 1, rotate: 0, duration: 0.92 },
          0,
        )
        .fromTo(
          q('.operator-panel__header'),
          { autoAlpha: 0, y: -36, rotationX: 18 },
          { autoAlpha: 1, y: 0, rotationX: 0, duration: 0.78 },
          0.06,
        )
        .fromTo(
          q('.operator-panel__metric-card'),
          { autoAlpha: 0, y: 18, scale: 0.9 },
          { autoAlpha: 1, y: 0, scale: 1, duration: 0.42, stagger: 0.05 },
          0.2,
        )
        .fromTo(
          q('.operator-panel__actions > *'),
          { autoAlpha: 0, x: 24 },
          { autoAlpha: 1, x: 0, duration: 0.34, stagger: 0.04 },
          0.24,
        )
        .fromTo(
          q('.operator-panel__rail--left, .operator-panel__feed, .operator-panel__rail--right'),
          { autoAlpha: 0, y: 34, rotationX: 10 },
          { autoAlpha: 1, y: 0, rotationX: 0, duration: 0.68, stagger: 0.08 },
          0.16,
        )
        .fromTo(
          q('.operator-entry'),
          { autoAlpha: 0, y: 28, x: 18, rotateX: 10 },
          { autoAlpha: 1, y: 0, x: 0, rotateX: 0, duration: 0.44, stagger: 0.05 },
          0.4,
        )
        .fromTo(
          q('.operator-panel__lock-flash'),
          { autoAlpha: 0.12, scaleX: 0.06 },
          { autoAlpha: 0.92, scaleX: 1, duration: 0.18, repeat: 1, yoyo: true },
          0.34,
        );

      const loops: gsap.core.Tween[] = [
        gsap.to(q('.operator-hud-ring--outer'), { rotate: 360, duration: 18, ease: 'none', repeat: -1 }),
        gsap.to(q('.operator-hud-ring--mid'), { rotate: -360, duration: 12, ease: 'none', repeat: -1 }),
        gsap.to(q('.operator-hud-ring--inner'), { rotate: 360, duration: 7, ease: 'none', repeat: -1 }),
        gsap.fromTo(
          q('.operator-hud-scan-beam'),
          { yPercent: -120, autoAlpha: 0.14 },
          { yPercent: 140, autoAlpha: 0.9, duration: 1.85, ease: 'power2.inOut', repeat: -1, repeatDelay: 0.35 },
        ),

      ];

      if (state.paused) {
        loops.push(
          gsap.to(q('.operator-reactor-core__orb'), { scale: 0.88, autoAlpha: 0.7, duration: 1.1, yoyo: true, repeat: -1, ease: 'sine.inOut' }),
        );
      } else if (state.iconState === 'acting') {
        loops.push(
          gsap.to(q('.operator-reactor-core__orb'), { scale: 1.2, duration: 0.34, yoyo: true, repeat: -1, ease: 'power2.inOut' }),
        );
      } else if (state.iconState === 'thinking') {
        loops.push(
          gsap.to(q('.operator-reactor-core__orb'), { scale: 1.1, duration: 0.72, yoyo: true, repeat: -1, ease: 'sine.inOut' }),
        );
      } else if (state.iconState === 'scanning') {
        loops.push(
          gsap.to(q('.operator-hud-reticle'), { rotate: '+=18', duration: 2.2, ease: 'none', repeat: -1 }),
        );
      }

      return () => {
        intro.kill();
        loops.forEach((loop) => loop.kill());
      };
    },
    { scope: panelRef, dependencies: [calmMotion, state.iconState, state.paused, scanStatus, suggestions.length, decisions.length] },
  );

  return (
    <AnimatePresence initial={false}>
      {state.open ? (
        <motion.div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-label="Deck"
          data-harness-modal="true"
          data-operator-state={effectiveIconState}
          data-scan-status={scanStatus}
          data-main-view={mainView}
          className={`operator-panel operator-panel--snap-lock operator-panel--maximal-hud operator-panel--${effectiveIconState}${state.paused ? ' is-paused' : ''}`}
          initial={panelMotion.initial}
          animate={panelMotion.animate}
          exit={panelMotion.exit}
          style={calmMotion ? undefined : { transformPerspective: 1800 }}
        >
          {promptEl}
          <svg className="operator-panel__svg-frame" viewBox="0 0 1000 600" preserveAspectRatio="none" aria-hidden="true" focusable="false">
            <defs>
              <linearGradient id="operatorPanelFrameRail" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="rgb(238 254 255)" stopOpacity="0.86" />
                <stop offset="34%" stopColor="rgb(99 230 255)" stopOpacity="0.92" />
                <stop offset="58%" stopColor="rgb(255 184 68)" stopOpacity="0.78" />
                <stop offset="100%" stopColor="rgb(16 185 235)" stopOpacity="0.86" />
              </linearGradient>
              <filter id="operatorPanelFrameGlow" x="-10%" y="-18%" width="120%" height="136%">
                <feGaussianBlur stdDeviation="2.6" result="softGlow" />
                <feMerge>
                  <feMergeNode in="softGlow" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
            </defs>
            <path className="operator-panel__svg-frame-spine" d="M46 10 H414 L448 27 H552 L586 10 H954 L990 46 V554 L954 590 H46 L10 554 V46 Z" />
          </svg>
          <span className="operator-panel__lock-flash" aria-hidden="true" />
          <OperatorScanOverlay
            state={effectiveIconState}
            reducedMotion={calmMotion}
          />
          <header className="operator-panel__header pc-animate-in pc-animate-in--down pc-animate-in--fast">
            <div className="operator-panel__titleblock">
              <OperatorReactorCore state={effectiveIconState} reducedMotion={calmMotion} />
              <div className="operator-panel__titlecopy">
                <div className="operator-panel__title-overline" aria-hidden="true" />
                <div className="operator-panel__titleline">
                  <OperatorWordmarkLockup className="operator-panel__wordmark" title="Deck" subtitle="" />
                  <span className={`operator-status operator-status--${effectiveIconState}`}>
                    {statusLabel}
                  </span>
                </div>
              </div>
            </div>


            <div className="operator-panel__actions pc-animate-in pc-animate-in--down pc-animate-in--delay-2">
              <div className="operator-panel__action-strip" aria-label="Deck controls">
                <button
                  type="button"
                  className="operator-btn operator-btn--primary operator-btn--icon"
                  onClick={() => startScan()}
                  aria-label="Scan"
                >
                  <span aria-hidden="true">↻</span>
                  <span>Scan</span>
                </button>
                <button
                  type="button"
                  className="operator-btn operator-btn--icon"
                  onClick={() => broadcastState({ paused: !state.paused })}
                  aria-label={state.paused ? 'Resume autonomous actions' : 'Pause autonomous actions'}
                >
                  <span aria-hidden="true">{state.paused ? '▶' : '⏸'}</span>
                  <span>{state.paused ? 'Resume' : 'Pause'}</span>
                </button>
                <RouteLink className="operator-btn operator-btn--ghost" href="/settings/operator">
                  Settings
                </RouteLink>
              </div>
              <button
                type="button"
                className="operator-btn operator-btn--close"
                onClick={() => broadcastState({ open: false })}
                aria-label="Close"
              >
                ×
              </button>
            </div>
          </header>

          {budget && !budget.configured && (
            <div className="operator-budget-overlay pc-animate-in pc-animate-in--fade">
              <div className="operator-budget-card pc-animate-in pc-animate-in--down pc-animate-in--delay-1">
                <div className="operator-panel__eyebrow">First run</div>
                <h3>Pick a daily budget for Operator</h3>
                <p>
                  Operator stops scanning automatically when today&apos;s spend reaches the cap.
                  You can change this any time at <RouteLink href="/settings/operator">/settings/operator</RouteLink>.
                </p>
                <div className="operator-budget-options">
                  {budgetTiers.map(({ label, cap, blurb }) => (
                    <button
                      key={cap}
                      type="button"
                      disabled={budgetSaving}
                      onClick={() => setBudgetCap(cap)}
                      className="operator-budget-option"
                    >
                      <strong>{label} — ${cap}/day</strong>
                      <span>{blurb}</span>
                    </button>
                  ))}
                </div>
                <CustomBudgetEntry disabled={budgetSaving} onSet={setBudgetCap} />
              </div>
            </div>
          )}

          <div className={`operator-panel__body${decisions.length === 0 ? ' has-empty-activity' : ''} pc-animate-in pc-animate-in--down pc-animate-in--delay-1`}>
            <aside className="operator-panel__rail operator-panel__rail--left">
              <DelegatesSection />
            </aside>

            <main className="operator-panel__feed pc-animate-in pc-animate-in--fade pc-animate-in--delay-2">
              <div className="operator-panel__metrics operator-feed-tabs pc-animate-in pc-animate-in--down pc-animate-in--delay-1" role="tablist" aria-label="Deck action views">
                {[
                  { key: 'cards' as MainView, count: pendingCount, label: 'Pending' },
                  { key: 'accepted' as MainView, count: acceptedCount, label: 'Accepted' },
                  { key: 'ignored' as MainView, count: ignoredCount, label: 'Ignored' },
                  { key: 'scan-history' as MainView, count: null, label: 'Scans' },
                ].map((view) => (
                  <button
                    key={view.key}
                    type="button"
                    role="tab"
                    className="operator-panel__metric-card operator-panel__metric-card--tab"
                    aria-selected={mainView === view.key}
                    aria-pressed={mainView === view.key}
                    onClick={() => { void setMainView(view.key); }}
                  >
                    <em>{view.label}</em>
                    {typeof view.count === 'number' ? <strong>{view.count}</strong> : null}
                  </button>
                ))}
              </div>
              <div className="operator-feed-head">
                {mainView !== 'scan-history' && (
                  <div className="operator-feed-tools">
                    <div className={`operator-feed-search${textFilterActive ? ' has-value' : ''}`}>
                      <span className="operator-feed-search__icon" aria-hidden="true">⌕</span>
                      <input
                        type="search"
                        value={feedQuery}
                        onChange={(e) => setFeedQuery(e.target.value)}
                        placeholder="Filter title or action"
                        aria-label={mainView === 'accepted' ? 'Filter accepted actions by title or action' : mainView === 'ignored' ? 'Filter ignored actions by title or action' : 'Filter pending actions by title or action'}
                        spellCheck={false}
                        enterKeyHint="search"
                      />
                      {feedQuery && (
                        <button
                          type="button"
                          className="operator-feed-search__clear"
                          onClick={() => setFeedQuery('')}
                          aria-label="Clear action filter"
                        >
                          ×
                        </button>
                      )}
                    </div>
                    <div className="operator-feed-harness-filter">
                      <Select
                        value={harnessFilterValue || '_all'}
                        onChange={(value) => setHarnessFilterValue(value === '_all' ? '' : value)}
                        ariaLabel="Filter actions by harness"
                        triggerClassName="operator-feed-harness-select"
                        options={harnessOptions.map((option) => ({ value: option.value, label: option.label }))}
                      />
                    </div>
                  </div>
                )}
              </div>
              {mainView !== 'scan-history' && filterActive && (
                <div className="operator-feed-active-filters" aria-label="Active filters">
                  <span>Filtered</span>
                  {activeFilterParts.map((part) => (
                    <em key={part}>{part}</em>
                  ))}
                  <button
                    type="button"
                    onClick={() => {
                      setFeedQuery('');
                      setHarnessFilterValue('');
                    }}
                  >
                    Clear
                  </button>
                </div>
              )}

              {mainView === 'scan-history' ? (
                <ScanHistorySection />
              ) : !hasFeedEntries ? (
                <div className={`operator-empty-state operator-empty-state--${scanStatus}`}>
                  <div className="operator-empty-state__icon" aria-hidden="true">
                    {scanStatus === 'error' ? '!' : scanStatus === 'scanning' ? '◐' : '·'}
                  </div>
                  <h3>{emptyTitle}</h3>
                  <p>{emptyBody}</p>
                  {scanStatus === 'error' && (
                    <button
                      type="button"
                      className="operator-btn operator-btn--primary"
                      onClick={() => provisionAndRescan()}
                      disabled={provisioning}
                    >
                      {provisioning ? 'Setting up…' : 'Set up Operator →'}
                    </button>
                  )}
                </div>
              ) : (
                <ul role="list" aria-label="Deck actions" className="operator-feed-list">
                  {visibleSuggestions.map((s, index) => (
                    <li
                      key={s.id}
                      role="article"
                      aria-label={`${s.title} — ${s.status === 'accepted' ? 'accepted' : s.status === 'ignored' ? 'ignored' : s.auto_dispatch ? 'accepts automatically soon' : 'awaiting your decision'}`}
                      data-entry-index={index}
                      data-entry-state={s.status}
                      data-entry-tier={s.actualTier}
                      tabIndex={0}
                      className={`operator-entry operator-entry--suggestion operator-entry--tier-${s.actualTier}${s.action === 'inform' ? ' operator-entry--inform-card' : ''}`}
                    >
                      <div className="operator-entry__rail">
                        <span title={s.auto_dispatch ? 'Auto-dispatch suggestion' : s.actualTier === 'high' ? 'High-risk review required' : 'Needs your decision'}>
                          {s.auto_dispatch ? '⚡' : s.actualTier === 'high' ? '⚠' : '✋'}
                        </span>
                      </div>
                      <div className="operator-entry__content">
                        <div className="operator-entry__meta">
                          <span className={`operator-tier operator-tier--${s.actualTier}`}>{tierLabel(s.actualTier)}</span>
                          {!(mainView === 'cards' && s.status === 'pending') && (
                            <>
                              <span className="operator-meta-sep" aria-hidden="true">·</span>
                              <span className={`operator-life operator-life--${lifecycleClassForCard(s)}`}>{lifecycleLabelForCard(s)}</span>
                            </>
                          )}
                          {s.target_harness && (
                            <>
                              <span className="operator-meta-sep" aria-hidden="true">·</span>
                              <span className="operator-target">{s.target_harness}</span>
                            </>
                          )}
                          <span className="operator-voice-slot" aria-hidden="true" />
                        </div>
                        <div className="operator-entry__title-row">
                          <div className="operator-entry__heading">
                            <span className={`operator-entry__type-glyph operator-entry__type-glyph--${s.action}`} aria-hidden="true">
                              {actionGlyphForCard(s)}
                            </span>
                            <h4>{s.title}</h4>
                          </div>
                          <div className="operator-entry__title-actions">
                            <div className="operator-entry__state">
                              {s.status === 'pending' && s.auto_dispatch && (
                                <span className="operator-state-text operator-state-text--auto">
                                  Accepts automatically in {autoDispatchSeconds(s, now)}s
                                </span>
                              )}
                              {s.status === 'pending' && (s.failedAttempts ?? 0) > 0 && (
                                <span
                                  className="operator-state-text operator-state-text--warn"
                                  title={s.lastFailureReason ?? 'unknown error'}
                                >
                                  ⚠ Last attempt failed: {humanizeFailure(s.lastFailureReason)} — try again
                                </span>
                              )}
                              {s.status === 'accepted' && (
                                <span className="operator-state-text operator-state-text--good">✓ accepted</span>
                              )}
                              {s.status === 'ignored' && (
                                <span className="operator-state-text operator-state-text--muted">ignored</span>
                              )}
                            </div>
                            <div className="operator-entry__buttons">
                              {/* Auto-fire countdown: Keep for review turns it into a regular pending card; otherwise the timer fires the same Accept flow. */}
                              {s.status === 'pending' && s.auto_dispatch && (
                                <Button size="mini" variant="ghost" onClick={() => undoCancelSuggestion(s.id)}>
                                  Keep for review
                                </Button>
                              )}

                              {/* High-risk send_directive: gate Accept behind a preview-and-confirm strip. */}
                              {s.status === 'pending' && !s.auto_dispatch && s.action === 'send_directive' && s.actualTier === 'high' && confirmingDispatch[s.id] && (
                                <div
                                  className="operator-confirm-strip operator-confirm-strip--preview"
                                  role="group"
                                  aria-label={`Accept preview for ${s.title}`}
                                >
                                  <div className="operator-confirm-strip__copy">
                                    <strong>Send to {s.target_harness ?? 'target harness'}?</strong>
                                    <span>The harness will receive: “{s.directive_subject || s.title}”</span>
                                    <span>Picked up at the next scan tick (~30s). Estimated agent time: 2–5 min.</span>
                                  </div>
                                  <div className="operator-confirm-strip__actions">
                                    <Button
                                      size="mini"
                                      variant="destructive"
                                      onClick={() => dispatchSuggestion(s.id)}
                                    >
                                      Accept
                                    </Button>
                                    <Button
                                      size="mini"
                                      variant="ghost"
                                      onClick={() => setConfirmingDispatch((prev) => {
                                        const { [s.id]: _removed, ...rest } = prev;
                                        return rest;
                                      })}
                                    >
                                      Cancel
                                    </Button>
                                  </div>
                                </div>
                              )}

                              {/* Default Accept button — visible on every pending card except auto-fire (countdown) and the high-risk-confirm sub-flow. */}
                              {s.status === 'pending' && !s.auto_dispatch && !(s.action === 'send_directive' && s.actualTier === 'high' && confirmingDispatch[s.id]) && (
                                <Button
                                  size="mini"
                                  variant={s.actualTier === 'high' ? 'destructive' : 'primary'}
                                  onClick={() => {
                                    if (s.action === 'send_directive' && s.actualTier === 'high') {
                                      setConfirmingDispatch((prev) => ({ ...prev, [s.id]: true }));
                                    } else {
                                      void dispatchSuggestion(s.id);
                                    }
                                  }}
                                >
                                  {(s.failedAttempts ?? 0) > 0 ? 'Retry Accept →' : 'Accept →'}
                                </Button>
                              )}

                              {/* Ignore button — visible on every pending card. */}
                              {s.status === 'pending' && !(s.action === 'send_directive' && s.actualTier === 'high' && confirmingDispatch[s.id]) && (
                                <Button size="mini" variant="ghost" onClick={() => dismissSuggestion(s.id)}>
                                  Ignore
                                </Button>
                              )}
                            </div>
                          </div>
                        </div>
                        {s.action !== 'send_directive' && <p className="operator-entry__why">{s.why}</p>}
                        {s.duplicateCount && s.duplicateCount > 1 ? (
                          <p className="operator-entry__duplicate-note">
                            {s.duplicateCount} matching recommendations grouped here.
                          </p>
                        ) : null}

                        {(s.provenanceFlags?.tierMismatch || s.provenanceFlags?.capabilityUnknown) && (
                          <div className="operator-entry__flags" aria-label="Provenance warnings">
                            {s.provenanceFlags?.tierMismatch && (
                              <span title="LLM-claimed tier overridden by substrate">⚠ tier corrected</span>
                            )}
                            {s.provenanceFlags?.capabilityUnknown && (
                              <span title="Unknown capability — forced high (fail-safe)">⚠ capability unknown</span>
                            )}
                          </div>
                        )}

                        {s.action === 'send_directive' && s.directive_body && (
                          <LazyDetails
                            className="operator-entry__details"
                            summaryClassName="operator-entry__details-summary"
                            summary="Directive body"
                          >
                            <MarkdownPreview value={s.directive_body} outline="left" />
                          </LazyDetails>
                        )}
                        {s.action === 'inform' && s.body && (
                          <div className="operator-entry__markdown operator-entry__markdown--compact">
                            <MarkdownPreview value={stripLeadingHeading(s.body, s.title)} />
                          </div>
                        )}
                        {s.action === 'navigate' && s.target_resource && (
                          <a
                            href={s.target_resource}
                            target="_blank"
                            rel="noreferrer"
                            className="operator-entry__link"
                          >
                            Open {s.target_resource}
                          </a>
                        )}

                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </main>

            <aside className={`operator-panel__rail operator-panel__rail--right${decisions.length === 0 ? ' is-empty' : ''} pc-animate-in pc-animate-in--fade pc-animate-in--delay-2`}>
              {firstRun && (
                <section className="operator-callout">
                  <strong>First-run intro</strong>
                  <p>
                    I have full write authority across all harnesses in this workspace.
                    Edit my prompt or preferences from <RouteLink href="/settings/operator">/settings/operator</RouteLink>.
                  </p>
                </section>
              )}
              <section className="operator-section">
                {decisions.length === 0 ? (
                  <div className="operator-empty-rail">
                    <strong>Decisions</strong>
                    <span>no recent decisions</span>
                    <em>0</em>
                  </div>
                ) : (
                  <>
                    <div className="operator-section__head">
                      <span>Decisions</span>
                      <em>recent</em>
                    </div>
                    <ul className="operator-activity-list">
                      {decisions.map((r) => (
                        <li key={r.id} className="operator-activity-item">
                          <span className="operator-activity-dot" aria-hidden="true" />
                          <div>
                            <strong>{r.action}</strong>
                            <p>
                              {r.target}{' '}
                              <span>· {new Date(r.ts).toLocaleString()}</span>
                            </p>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </section>
              <section className={`operator-section operator-stream${streamMuted ? ' operator-stream--muted' : ''}${scanStatus === 'error' ? ' operator-stream--error' : ''}`}>
                <div className="operator-section__head">
                  <span>Stream</span>
                  <em>{scanStatus === 'error' ? 'error' : scanStatus === 'scanning' ? 'scanning' : scanStatus === 'complete' ? 'complete' : 'quiet'}</em>
                </div>
                {scanStatus === 'error' ? (
                  <div className="operator-stream-error">
                    <strong>Scan errored</strong>
                    <p>{scanError || 'Operator substrate is not ready.'}</p>
                    <button
                      type="button"
                      className="operator-btn operator-btn--ghost"
                      onClick={() => provisionAndRescan()}
                      disabled={provisioning}
                    >
                      {provisioning ? 'Setting up…' : 'Set up Operator →'}
                    </button>
                    {onSettingsPage ? null : (
                      <RouteLink className="operator-btn operator-btn--muted" href="/settings/operator">
                        Open settings
                      </RouteLink>
                    )}
                  </div>
                ) : streamLog.length === 0 ? (
                  <p className="operator-empty-small">(no stream yet)</p>
                ) : (
                  <pre>{streamLog.join('\n')}</pre>
                )}
              </section>
            </aside>
          </div>

          <footer className="operator-panel__footer pc-animate-in pc-animate-in--fade pc-animate-in--delay-2">
            <span>Cmd/Ctrl+K then D • Esc closes • Click outside closes</span>
          </footer>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

interface HarnessOneLiner {
  slug: string;
  status: string;
  lastTouched: string | null;
}
