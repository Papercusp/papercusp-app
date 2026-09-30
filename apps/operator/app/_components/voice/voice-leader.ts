'use client';

/**
 * BroadcastChannel voice-leader election (Phase 1d, v4 §2i).
 *
 * Multiple browser tabs in the same workspace would otherwise stereo-echo
 * every TTS utterance. Election picks one tab as the speaker; followers
 * silently no-op `speak()` calls.
 *
 * v4 scope reduction: election + heartbeat only. Focus-transfer
 * (user-attention-follows-speaker) is deferred to v1.5.
 *
 * Async boot per v4 §2i: chrome render is NOT blocked. `bootVoiceLeader()`
 * returns a promise; voice features wait on it before speaking.
 *
 * BroadcastChannel availability guard: Safari private windows + some
 * embedded WebViews don't expose it; we fall back to "this is the only
 * tab" mode.
 */

const CHANNEL = 'operator-voice';
const ANNOUNCE_WINDOW_MS = 250;
const HEARTBEAT_MS = 5_000;
const LEADER_LOSS_TIMEOUT_MS = 12_000;

type Message =
  | { kind: 'announce'; tabId: string; ts: number }
  | { kind: 'heartbeat'; tabId: string; ts: number }
  | { kind: 'request-lead'; tabId: string; reason: string }
  | { kind: 'yield'; toTabId: string }
  // EI-14611: the leader's parting shot on pagehide/beforeunload — followers
  // re-elect IMMEDIATELY instead of waiting out the 12s heartbeat-loss timeout.
  | { kind: 'leaving'; tabId: string };

interface LeaderState {
  isLeader: boolean;
  leaderTabId: string | null;
  myTabId: string;
  available: boolean; // BroadcastChannel actually works in this browser
}

const listeners = new Set<(s: LeaderState) => void>();
let state: LeaderState = {
  isLeader: false,
  leaderTabId: null,
  myTabId: makeTabId(),
  available: false,
};
let channel: BroadcastChannel | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let lastLeaderHeartbeatAt = 0;
let bootPromise: Promise<LeaderState> | null = null;
/** EI-14611: the visibility/pagehide DOM hooks are installed once per module
 *  lifetime (re-armed after a test reset) — election re-boots must not stack
 *  duplicate listeners. */
let domHooksInstalled = false;

function makeTabId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function notify(): void {
  for (const l of listeners) l(state);
}

/** Subscribe to leader-state changes. */
export function subscribeVoiceLeader(fn: (s: LeaderState) => void): () => void {
  listeners.add(fn);
  fn(state);
  return () => { listeners.delete(fn); };
}

/** Synchronous read of current state. */
export function getVoiceLeaderState(): LeaderState {
  return state;
}

/**
 * Async boot. Resolves with the determined leader state. Voice features
 * await this promise before speaking. Chrome render does NOT await it.
 *
 * Idempotent — second call returns the same in-flight promise.
 */
export function bootVoiceLeader(): Promise<LeaderState> {
  if (bootPromise) return bootPromise;
  bootPromise = (async () => {
    if (typeof window === 'undefined') return state;

    // Availability guard.
    if (typeof BroadcastChannel === 'undefined') {
      state = { ...state, isLeader: true, leaderTabId: state.myTabId, available: false };
      notify();
      return state;
    }

    state = { ...state, available: true };
    channel = new BroadcastChannel(CHANNEL);

    let candidates: { tabId: string; ts: number }[] = [{ tabId: state.myTabId, ts: Date.now() }];
    // Set when a heartbeat from an existing leader arrives mid-election.
    // Without this, a tab booting after an existing leader has finished
    // its election window would only see its own announce in `candidates`
    // (the existing leader doesn't re-announce on every new tab) and
    // would falsely "win" — producing two leaders. The existing leader's
    // announce handler now replies with a heartbeat (below); we use that
    // heartbeat to abort our own election and become a follower.
    let conflictingLeaderTabId: string | null = null;

    channel.addEventListener('message', (ev: MessageEvent<Message>) => {
      const msg = ev.data;
      if (!msg) return;
      if (msg.kind === 'announce') {
        candidates.push({ tabId: msg.tabId, ts: msg.ts });
        // If we're already the elected leader, immediately heartbeat so
        // the announcer aborts its own election and follows us.
        if (state.isLeader && msg.tabId !== state.myTabId && channel) {
          channel.postMessage({ kind: 'heartbeat', tabId: state.myTabId, ts: Date.now() } satisfies Message);
        }
      } else if (msg.kind === 'heartbeat') {
        if (state.leaderTabId === msg.tabId) {
          lastLeaderHeartbeatAt = msg.ts;
        } else if (!state.isLeader) {
          // If we're still in our boot election window, record so the
          // post-await code knows to defer to this leader.
          if (msg.tabId !== state.myTabId) conflictingLeaderTabId = msg.tabId;
          state = { ...state, leaderTabId: msg.tabId };
          lastLeaderHeartbeatAt = msg.ts;
          notify();
        }
      } else if (msg.kind === 'request-lead') {
        // Another tab wants the lead (e.g. user opened the panel there).
        // If we're the current leader, yield to them.
        if (state.isLeader && msg.tabId !== state.myTabId) {
          if (channel) {
            channel.postMessage({ kind: 'yield', toTabId: msg.tabId } satisfies Message);
          }
          // Step down — stop heartbeating, become follower.
          if (heartbeatTimer) clearInterval(heartbeatTimer);
          heartbeatTimer = null;
          state = { ...state, isLeader: false, leaderTabId: msg.tabId };
          lastLeaderHeartbeatAt = Date.now();
          startFollowerHeartbeatWatch();
          notify();
        }
      } else if (msg.kind === 'yield') {
        // We requested the lead and it was granted.
        if (msg.toTabId === state.myTabId && !state.isLeader) {
          becomeLeader();
        }
      } else if (msg.kind === 'leaving') {
        // EI-14611: the leader is unloading (pagehide/beforeunload) — re-elect
        // NOW instead of waiting out the 12s heartbeat-loss timeout. A closed
        // leader tab used to leave every follower silently no-op'ing speak()
        // for up to 12s. Only a follower whose CURRENT leader is the one
        // leaving re-boots; a stray 'leaving' from a non-leader changes nothing.
        if (!state.isLeader && msg.tabId === state.leaderTabId) {
          if (heartbeatTimer) clearInterval(heartbeatTimer);
          heartbeatTimer = null;
          bootPromise = null;
          void bootVoiceLeader();
        }
      }
    });

    installDomHooks();

    // Announce ourselves.
    channel.postMessage({ kind: 'announce', tabId: state.myTabId, ts: Date.now() } satisfies Message);

    // Wait the announce window for other tabs to chime in.
    await new Promise<void>((res) => setTimeout(res, ANNOUNCE_WINDOW_MS));

    // If we received a heartbeat from an existing leader during the
    // election window, defer to it unconditionally — its tabId may not
    // be in our candidates list (existing leaders don't announce, only
    // heartbeat).
    if (conflictingLeaderTabId) {
      state = { ...state, isLeader: false, leaderTabId: conflictingLeaderTabId };
      startFollowerHeartbeatWatch();
      notify();
      return state;
    }
    // Lowest tabId wins (deterministic, no clock skew).
    candidates.sort((a, b) => a.tabId.localeCompare(b.tabId));
    const winner = candidates[0];
    state = {
      ...state,
      isLeader: winner.tabId === state.myTabId,
      leaderTabId: winner.tabId,
    };

    if (state.isLeader) {
      startLeaderHeartbeats();
    } else {
      startFollowerHeartbeatWatch();
    }

    notify();
    return state;
  })();
  return bootPromise;
}

/**
 * EI-14611: align leadership with USER ATTENTION — the deferred v4 §2i v1.5
 * focus-transfer, landed as the fix for the hidden-leader starvation bug.
 *
 * The failure shape this closes: with two same-origin windows, a HIDDEN
 * window could win (or keep) the election while the user's conversation runs
 * in the visible one — whose speak() calls silently no-op as a follower, so a
 * correct reply renders in text with zero audio, indefinitely (a hidden tab
 * heartbeats forever; only a CLOSED one is reclaimed, after 12s).
 *
 * Mechanism (deliberately built on the existing request-lead → yield path):
 *   - a FOLLOWER whose document becomes VISIBLE requests the voice lead —
 *     voice follows the window the user is looking at. A hidden leader never
 *     blindly steps down (if EVERY window is hidden — user minimized the only
 *     window mid-utterance — playback must continue, not orphan itself).
 *   - a LEADER broadcasts 'leaving' on pagehide/beforeunload, so followers
 *     re-elect instantly instead of waiting out LEADER_LOSS_TIMEOUT_MS.
 */
function installDomHooks(): void {
  if (domHooksInstalled) return;
  if (typeof document === 'undefined' || typeof window === 'undefined') return;
  domHooksInstalled = true;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (state.isLeader || !state.available) return;
    requestVoiceLead('visibility');
  });
  const announceLeaving = (): void => {
    if (!state.isLeader || !channel) return;
    try {
      channel.postMessage({ kind: 'leaving', tabId: state.myTabId } satisfies Message);
    } catch {
      /* channel already closed — the heartbeat-loss timeout still covers this */
    }
  };
  window.addEventListener('pagehide', announceLeaving);
  window.addEventListener('beforeunload', announceLeaving);
}

function startLeaderHeartbeats(): void {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  lastLeaderHeartbeatAt = Date.now();
  heartbeatTimer = setInterval(() => {
    if (!channel) return;
    channel.postMessage({ kind: 'heartbeat', tabId: state.myTabId, ts: Date.now() } satisfies Message);
  }, HEARTBEAT_MS);
}

function startFollowerHeartbeatWatch(): void {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  lastLeaderHeartbeatAt = Date.now();
  heartbeatTimer = setInterval(() => {
    if (Date.now() - lastLeaderHeartbeatAt > LEADER_LOSS_TIMEOUT_MS) {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = null;
      bootPromise = null;
      void bootVoiceLeader();
    }
  }, HEARTBEAT_MS);
}

function becomeLeader(): void {
  state = { ...state, isLeader: true, leaderTabId: state.myTabId };
  startLeaderHeartbeats();
  // Announce immediately so other followers update their leader pointer.
  if (channel) channel.postMessage({ kind: 'heartbeat', tabId: state.myTabId, ts: Date.now() } satisfies Message);
  notify();
}

/**
 * Request the voice lead for this tab (focus-transfer; v4 §2i v1.5).
 *
 * Used when the user shifts focus to a non-leader tab (e.g. opens the
 * Operator panel here) — voice should follow user attention. The current
 * leader yields to us; we become leader and start heartbeating.
 *
 * No-op when we're already the leader OR BroadcastChannel is unavailable.
 */
export function requestVoiceLead(reason = 'focus'): void {
  if (state.isLeader) return;
  if (!channel || !state.available) return;
  channel.postMessage({ kind: 'request-lead', tabId: state.myTabId, reason } satisfies Message);
}

/** Test-only: tear down state for a fresh election. */
export function _resetVoiceLeaderForTests(): void {
  if (channel) try { channel.close(); } catch {}
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  channel = null;
  heartbeatTimer = null;
  bootPromise = null;
  // EI-14611: let the next boot re-install the DOM hooks on whatever (fake)
  // document/window the test has swapped in.
  domHooksInstalled = false;
  state = {
    isLeader: false,
    leaderTabId: null,
    myTabId: makeTabId(),
    available: false,
  };
  listeners.clear();
}
