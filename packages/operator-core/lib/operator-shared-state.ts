'use client';

import { wsLocalKey } from './browser-workspace';
import { backgroundRequest } from './transport-adapters/origin-scheduler-fetch';

/**
 * Module-scoped shared state for the Operator chrome (button + panel +
 * background scanner). Single source of truth so a click on the button
 * is visible to the panel, the scanner respects pause toggles, etc.
 */

export type IconState =
  | 'idle'
  | 'scanning'
  | 'thinking'
  | 'acting'
  | 'paused'
  | 'awaiting-input';

/**
 * Compact card shape exposed to the registry's panel.cards query so
 * voice/oracle/palette can read what's on the panel without parsing
 * the full SuggestionCard type. Mirrors the user-visible bits.
 */
export interface PanelCard {
  id: string;
  title: string;
  /** 'dispatch' | 'inform' | 'navigate' | … per ParsedSuggestion.action. */
  action: string;
  /** Tier resolved at display time: 'low' | 'medium' | 'high'. */
  tier: string;
  /** Lifecycle: 'pending' | 'dispatched' | 'dismissed' | 'acked' | … */
  status: string;
  /** Optional harness slug the suggestion targets. */
  targetHarness?: string;
  /** One-line reason / preview. */
  reason?: string;
  /** True if the card was auto-dispatched without user input. */
  autoDispatch: boolean;
}

/** A card the operator auto-accepted (tracked in client memory only). */
export interface AutoAcceptEvent {
  id: string;
  title: string;
  tier: 'low' | 'medium' | 'high';
  targetHarness?: string;
  acceptedAt: number;
  source: 'auto-fire' | 'panel-auto';
}

const AUTO_ACCEPT_FEED_CAP = 10;

export interface OperatorState {
  open: boolean;
  iconState: IconState;
  paused: boolean;
  /** Auto-accept threshold. Cards the operator emits with `auto_dispatch: true`
   *  are auto-accepted only when their `actualTier` is at or below this
   *  threshold:
   *    'off'    → never auto-accept; every card waits for the user
   *    'low'    → auto-accept low-tier only
   *    'medium' → auto-accept low + medium
   *    'high'   → auto-accept everything (low + medium + high)
   *  Background scans run unless this is 'off' AND the user is also paused.
   *  Persisted via /api/profile (JSONB) + localStorage cache. */
  autoAccept: AutoAcceptLevel;
  /** Snapshot of the cards currently visible in the panel feed. The
   *  OperatorPanel re-publishes this on every render that changes the
   *  suggestion array; readers (registry queries) get a sync view. */
  cards: PanelCard[];
  /** Last N cards the operator auto-accepted (most recent first).
   *  Lives in client memory only — not persisted across reloads. The
   *  OperatorButton popdown shows these in compact form. */
  recentAutoAccepts: AutoAcceptEvent[];
}

export type AutoAcceptLevel = 'off' | 'low' | 'medium' | 'high';

export const AUTO_ACCEPT_LEVELS: readonly AutoAcceptLevel[] = ['off', 'low', 'medium', 'high'];
export function isAutoAcceptLevel(v: unknown): v is AutoAcceptLevel {
  return typeof v === 'string' && (AUTO_ACCEPT_LEVELS as readonly string[]).includes(v);
}

/** Tier-vs-threshold check used by both the panel and the background scanner. */
export function isAutoAcceptedByThreshold(
  tier: 'low' | 'medium' | 'high',
  threshold: AutoAcceptLevel,
): boolean {
  if (threshold === 'off') return false;
  if (threshold === 'high') return true;
  if (threshold === 'medium') return tier !== 'high';
  if (threshold === 'low') return tier === 'low';
  return false;
}

// Source of truth is `harness_shared.operator_user_profile.auto_accept` (PG,
// JSONB key — migration 021 set up the table; we just add a key). localStorage
// is a per-device cache so the initial render is instant and offline reads
// still work. On mount we GET /api/profile and overwrite the cache if PG
// differs (so a preference set on one device propagates to the next).
//
// Migration from the legacy `auto_scan: boolean`:
//   true  → 'medium'  (the "everything reasonable" default)
//   false → 'off'
const AUTO_ACCEPT_KEY = 'operator:autoAccept';
const LEGACY_AUTO_SCAN_KEY = 'operator:autoScan';
/**
 * Returns the localStorage-saved auto-accept level, or null if none is set.
 * Used ONLY by the client-side hydrate effect — never at module-eval time
 * for the initial state, because the server has no localStorage and an
 * SSR / client mismatch on the resulting class name causes a React
 * hydration error on the OperatorButton.
 */
function readSavedAutoAccept(): AutoAcceptLevel | null {
  if (typeof window === 'undefined') return null;
  try {
    const v = window.localStorage.getItem(wsLocalKey(AUTO_ACCEPT_KEY));
    if (isAutoAcceptLevel(v)) return v;
    const legacy = window.localStorage.getItem(LEGACY_AUTO_SCAN_KEY);
    if (legacy === '0') return 'off';
    if (legacy === '1') return 'medium';
  } catch { /* ignore */ }
  return null;
}
function saveAutoAccept(v: AutoAcceptLevel): void {
  if (typeof window === 'undefined') return;
  try { window.localStorage.setItem(wsLocalKey(AUTO_ACCEPT_KEY), v); } catch { /* ignore */ }
  void fetch('/api/profile', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ auto_accept: v }),
  }).catch(() => { /* offline / no session — localStorage already saved */ });
}

const defaultState: OperatorState = {
  open: false,
  iconState: 'idle',
  paused: false,
  // MUST match between SSR and first client render — see readSavedAutoAccept
  // above. The actual stored value is loaded inside hydrateOperatorStateFromPg
  // after mount.
  autoAccept: 'medium',
  cards: [],
  recentAutoAccepts: [],
};

type OperatorStateSetter = (s: Partial<OperatorState>) => void;
interface OperatorStateStore {
  state: OperatorState;
  setters: Set<OperatorStateSetter>;
  hydrated: boolean;
}

const OPERATOR_STATE_STORE_KEY = '__papercuspOperatorStateStore__';

function createOperatorStateStore(): OperatorStateStore {
  return {
    state: { ...defaultState },
    setters: new Set<OperatorStateSetter>(),
    hydrated: false,
  };
}

function getOperatorStateStore(): OperatorStateStore {
  if (typeof window === 'undefined') return createOperatorStateStore();
  const w = window as typeof window & { [OPERATOR_STATE_STORE_KEY]?: OperatorStateStore };
  w[OPERATOR_STATE_STORE_KEY] ??= createOperatorStateStore();
  return w[OPERATOR_STATE_STORE_KEY];
}

const operatorStateStore = getOperatorStateStore();
export let sharedState: OperatorState = operatorStateStore.state;

/**
 * Async hydrate from PG once per page load. Called from a useEffect in the
 * Operator chrome mount. Idempotent and shared across dev/HMR chunks.
 */
export async function hydrateOperatorStateFromPg(): Promise<void> {
  const store = getOperatorStateStore();
  if (store.hydrated || typeof window === 'undefined') return;
  store.hydrated = true;
  // Apply localStorage immediately (synchronous) so the UI doesn't flicker
  // 'medium' → saved value over the PG round-trip. SSR-safe because this
  // only runs in the post-hydration effect.
  const saved = readSavedAutoAccept();
  if (saved && saved !== store.state.autoAccept) {
    store.state = { ...store.state, autoAccept: saved };
    sharedState = store.state;
    for (const fn of store.setters) fn({ autoAccept: saved });
  }
  try {
    const r = await fetch('/api/profile', backgroundRequest());
    if (!r.ok) return;
    const profile = await r.json();
    // Prefer the new key; fall back to legacy auto_scan boolean.
    let pgValue: AutoAcceptLevel | null = null;
    if (isAutoAcceptLevel(profile?.auto_accept)) {
      pgValue = profile.auto_accept;
    } else if (typeof profile?.auto_scan === 'boolean') {
      pgValue = profile.auto_scan ? 'medium' : 'off';
    }
    if (pgValue && pgValue !== store.state.autoAccept) {
      try { window.localStorage.setItem(wsLocalKey(AUTO_ACCEPT_KEY), pgValue); } catch { /* ignore */ }
      store.state = { ...store.state, autoAccept: pgValue };
      sharedState = store.state;
      for (const fn of store.setters) fn({ autoAccept: pgValue });
    }
  } catch { /* ignore */ }
}

export function broadcastState(partial: Partial<OperatorState>): void {
  const store = getOperatorStateStore();
  store.state = { ...store.state, ...partial };
  sharedState = store.state;
  if (isAutoAcceptLevel(partial.autoAccept)) saveAutoAccept(partial.autoAccept);
  for (const fn of store.setters) fn(partial);
}

export function setOperatorState(partial: Partial<OperatorState>): void {
  broadcastState(partial);
}

/**
 * Push a single auto-accept event onto the head of the recent feed,
 * capped at AUTO_ACCEPT_FEED_CAP. Drops dupes by id (so a card that
 * fires once doesn't show twice if some path retries). Broadcasts so
 * the OperatorButton popdown re-renders.
 */
export function pushAutoAcceptEvent(event: AutoAcceptEvent): void {
  const store = getOperatorStateStore();
  const existing = store.state.recentAutoAccepts.filter((e) => e.id !== event.id);
  const next = [event, ...existing].slice(0, AUTO_ACCEPT_FEED_CAP);
  broadcastState({ recentAutoAccepts: next });
}

export function subscribeOperatorState(fn: OperatorStateSetter): () => void {
  const store = getOperatorStateStore();
  store.setters.add(fn);
  // Module chunks can be loaded after an open/pause/autopolicy change.
  // Seed late subscribers immediately so lazy panel mounts don't miss
  // the broadcast that caused them to load.
  fn(store.state);
  return () => {
    store.setters.delete(fn);
  };
}
