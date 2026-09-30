/**
 * Cross-window operator state sync (multi-window-chat-coherence-2026-07-15,
 * WI-4838 follow-on). The desktop runs SEVERAL webview windows on the same
 * conversation (main app + Quick Panel), each mounting its own
 * OperatorConversationProvider. Mode/sleep lived in per-window sessionStorage
 * (Tauri windows do NOT share it), so the two chat sidebars could disagree —
 * active in one, passive in the other — and both windows could generate
 * concurrently without even signalling it.
 *
 * Mechanism: a localStorage MIRROR (localStorage IS shared across same-origin
 * windows in one WebKit website-data-store) + `storage` events for
 * cross-window reactivity. sessionStorage stays the per-window read path —
 * this module keeps the mirror in step and feeds remote changes back into the
 * window's sessionStorage + the existing CustomEvents.
 *
 * "Same app run" identity — the reason the mirror is safe in LOCALstorage
 * despite the "fresh app open re-seeds mode" rule (operator-converse-tags):
 * every window with a mounted provider refreshes `leaseTsMs` on a heartbeat.
 * A mirror whose lease went stale (> LEASE_STALE_MS) is from a DEAD app run
 * and is never adopted; the next boot seeds from prefs exactly as before.
 *
 * Also carries the cross-window "a generation is in flight" beacon (P-009):
 * the streaming window stamps GEN_KEY; peers render a typing indicator and
 * defer AUTO-fired generations (never user sends) while it's fresh.
 */

export type SharedOperatorMode = 'active' | 'passive';

interface SharedStateV1 {
  mode: SharedOperatorMode | null;
  sleepUntilMs: number;
  tsMs: number;
  leaseTsMs: number;
}

interface GeneratingV1 {
  windowId: string;
  active: boolean;
  tsMs: number;
}

const SHARED_KEY = 'papercusp.operatorShared.v1';
const GEN_KEY = 'papercusp.operatorGenerating.v1';
/** A mirror lease older than this is a dead app run — never adopt it. */
const LEASE_STALE_MS = 60_000;
const LEASE_BEAT_MS = 20_000;
/** A generating beacon older than this is a crashed/hung writer — ignore. */
const GEN_FRESH_MS = 15_000;

/** Stable per-window identity for beacon self-filtering. */
const windowId: string =
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);

function readJson<T>(key: string): T | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* sandbox / quota */
  }
}

function currentShared(): SharedStateV1 {
  return (
    readJson<SharedStateV1>(SHARED_KEY) ?? {
      mode: null,
      sleepUntilMs: 0,
      tsMs: 0,
      leaseTsMs: 0,
    }
  );
}

function leaseFresh(s: SharedStateV1): boolean {
  return s.leaseTsMs > 0 && Date.now() - s.leaseTsMs < LEASE_STALE_MS;
}

/** Mirror a mode change so other windows (and late-opening ones) adopt it. */
export function mirrorOperatorMode(mode: SharedOperatorMode): void {
  const s = currentShared();
  writeJson(SHARED_KEY, { ...s, mode, tsMs: Date.now(), leaseTsMs: Date.now() });
}

/** Mirror a sleep-until change. */
export function mirrorOperatorSleep(sleepUntilMs: number): void {
  const s = currentShared();
  writeJson(SHARED_KEY, { ...s, sleepUntilMs, tsMs: Date.now(), leaseTsMs: Date.now() });
}

/**
 * Clear the mirror (the G16 reload-reset path): "refresh = active again"
 * applies to the whole operator, so the reset propagates to peer windows via
 * the storage event instead of leaving them on the old mode.
 */
export function clearOperatorMirror(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(SHARED_KEY);
  } catch {
    /* sandbox */
  }
}

/**
 * The live peer state a freshly-opened window should adopt instead of
 * seeding from prefs — non-null only when some window of THIS app run
 * (fresh lease) has an established mode.
 */
export function adoptableSharedState(): { mode: SharedOperatorMode; sleepUntilMs: number } | null {
  const s = currentShared();
  if (!leaseFresh(s) || !s.mode) return null;
  return { mode: s.mode, sleepUntilMs: s.sleepUntilMs };
}

/** Stamp/refresh the in-flight generation beacon (call at start + periodically while streaming). */
export function broadcastGenerating(active: boolean): void {
  writeJson(GEN_KEY, { windowId, active, tsMs: Date.now() } satisfies GeneratingV1);
}

/** True when ANOTHER window has a fresh in-flight generation. */
export function peerGeneratingNow(): boolean {
  const g = readJson<GeneratingV1>(GEN_KEY);
  return !!g && g.active && g.windowId !== windowId && Date.now() - g.tsMs < GEN_FRESH_MS;
}

export interface OperatorWindowSyncHandlers {
  /** A peer window changed the operator mode. */
  onModeFromPeer?(mode: SharedOperatorMode): void;
  /** A peer window changed the sleep timer. */
  onSleepFromPeer?(sleepUntilMs: number): void;
  /** A peer window's reload-reset cleared the shared state. */
  onMirrorCleared?(): void;
  /** A peer window started/stopped (or timed out of) generating. */
  onPeerGenerating?(generating: boolean): void;
}

/**
 * Install the cross-window listeners + the lease heartbeat for this window.
 * Idempotent per handler-set; returns a cleanup. Call from the conversation
 * provider's mount effect.
 */
export function installOperatorWindowSync(handlers: OperatorWindowSyncHandlers): () => void {
  if (typeof window === 'undefined') return () => {};

  let lastShared = currentShared();
  let peerGenShown = false;
  let genExpiry: ReturnType<typeof setTimeout> | null = null;

  const evaluateGen = () => {
    const now = peerGeneratingNow();
    if (now !== peerGenShown) {
      peerGenShown = now;
      handlers.onPeerGenerating?.(now);
    }
    if (genExpiry) {
      clearTimeout(genExpiry);
      genExpiry = null;
    }
    // A fresh beacon expires on its own if the writer dies mid-stream —
    // re-evaluate just past the freshness horizon so the indicator clears.
    if (now) genExpiry = setTimeout(evaluateGen, GEN_FRESH_MS + 500);
  };

  const onStorage = (e: StorageEvent) => {
    if (e.key === SHARED_KEY) {
      const next = currentShared();
      if (e.newValue === null) {
        lastShared = next;
        handlers.onMirrorCleared?.();
        return;
      }
      if (next.mode && next.mode !== lastShared.mode) handlers.onModeFromPeer?.(next.mode);
      if (next.sleepUntilMs !== lastShared.sleepUntilMs) handlers.onSleepFromPeer?.(next.sleepUntilMs);
      lastShared = next;
    } else if (e.key === GEN_KEY) {
      evaluateGen();
    }
  };
  window.addEventListener('storage', onStorage);

  // Lease heartbeat: while this window lives, the mirror belongs to a live
  // app run. Only beats once a mode exists (an unseeded window must not
  // extend a lease it never joined).
  const beat = setInterval(() => {
    const s = currentShared();
    if (s.mode) writeJson(SHARED_KEY, { ...s, leaseTsMs: Date.now() });
  }, LEASE_BEAT_MS);

  return () => {
    window.removeEventListener('storage', onStorage);
    clearInterval(beat);
    if (genExpiry) clearTimeout(genExpiry);
  };
}
