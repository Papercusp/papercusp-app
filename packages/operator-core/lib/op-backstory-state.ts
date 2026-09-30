/**
 * Backstory rate-limiting state. Per /docs/agents/operator-persona §7d:
 *   - max 3 fires per session
 *   - 30-min cooldown between any two fires
 *   - 7-day no-repeat per beat id
 *
 * Session counter + recent beat ids persist in sessionStorage so a
 * reload doesn't reset the budget mid-conversation. The 7-day no-repeat
 * persists in localStorage (cross-session).
 *
 * Pure module — caller invokes mark() after a beat is actually used,
 * pruneEligible() before composing.
 */

import { wsLocalKey } from './browser-workspace';

const SESSION_KEY = 'papercusp.backstory.session';
const RECENT_KEY = 'papercusp.backstory.recent';

// Test-environment fallback: when window/storage isn't available
// (node-side vitest), keep the same data shape in memory so the state
// module behaves identically. Browser code never reaches these.
const memStore: { session: string | null; recent: string | null } = {
  session: null,
  recent: null,
};
function getSessionStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try { return window.sessionStorage; } catch { return null; }
}
function getLocalStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try { return window.localStorage; } catch { return null; }
}
function readKey(kind: 'session' | 'recent'): string | null {
  const s = kind === 'session' ? getSessionStorage() : getLocalStorage();
  if (s) {
    try { return s.getItem(kind === 'session' ? SESSION_KEY : wsLocalKey(RECENT_KEY)); } catch { /* fall through */ }
  }
  return memStore[kind];
}
function writeKey(kind: 'session' | 'recent', value: string): void {
  const s = kind === 'session' ? getSessionStorage() : getLocalStorage();
  if (s) {
    try { s.setItem(kind === 'session' ? SESSION_KEY : wsLocalKey(RECENT_KEY), value); return; } catch { /* fall through */ }
  }
  memStore[kind] = value;
}
function removeKey(kind: 'session' | 'recent'): void {
  const s = kind === 'session' ? getSessionStorage() : getLocalStorage();
  if (s) {
    try { s.removeItem(kind === 'session' ? SESSION_KEY : wsLocalKey(RECENT_KEY)); } catch { /* fall through */ }
  }
  memStore[kind] = null;
}

const MAX_PER_SESSION = 3;
const COOLDOWN_MS = 30 * 60_000;
const NO_REPEAT_MS = 7 * 24 * 60 * 60_000;

interface SessionState {
  fires: number;
  lastFiredAt: number;
}

interface RecentEntry {
  id: string;
  firedAt: number;
}

function readSession(): SessionState {
  const raw = readKey('session');
  if (!raw) return { fires: 0, lastFiredAt: 0 };
  try {
    const parsed = JSON.parse(raw);
    return {
      fires: typeof parsed.fires === 'number' ? parsed.fires : 0,
      lastFiredAt: typeof parsed.lastFiredAt === 'number' ? parsed.lastFiredAt : 0,
    };
  } catch {
    return { fires: 0, lastFiredAt: 0 };
  }
}

function writeSession(s: SessionState): void {
  writeKey('session', JSON.stringify(s));
}

function readRecent(): RecentEntry[] {
  const raw = readKey('recent');
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e: any) => typeof e?.id === 'string' && typeof e?.firedAt === 'number',
    );
  } catch {
    return [];
  }
}

function writeRecent(rs: RecentEntry[]): void {
  writeKey('recent', JSON.stringify(rs));
}

/**
 * Mark a beat as fired. Updates both session + recent stores.
 */
export function markBeatFired(id: string, now: number = Date.now()): void {
  const s = readSession();
  writeSession({ fires: s.fires + 1, lastFiredAt: now });
  const recent = readRecent();
  const fresh = recent.filter((e) => now - e.firedAt < NO_REPEAT_MS && e.id !== id);
  fresh.push({ id, firedAt: now });
  writeRecent(fresh);
}

/**
 * Returns false if cap reached or cooldown still active.
 */
export function backstoryEligibleNow(now: number = Date.now()): boolean {
  const s = readSession();
  if (s.fires >= MAX_PER_SESSION) return false;
  if (s.lastFiredAt > 0 && now - s.lastFiredAt < COOLDOWN_MS) return false;
  return true;
}

/**
 * Set of beat ids the no-repeat window currently excludes.
 */
export function recentlyFiredIds(now: number = Date.now()): Set<string> {
  return new Set(readRecent().filter((e) => now - e.firedAt < NO_REPEAT_MS).map((e) => e.id));
}

/** Test-only: reset both stores. */
export function __resetBackstoryStateForTests(): void {
  removeKey('session');
  removeKey('recent');
}

export const BACKSTORY_LIMITS = {
  MAX_PER_SESSION,
  COOLDOWN_MS,
  NO_REPEAT_MS,
} as const;
