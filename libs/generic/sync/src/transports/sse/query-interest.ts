/**
 * Client half of per-client invalidation filtering: work out which query names
 * this browser actually observes, and keep the SSE connection's declaration in
 * step with them.
 *
 * Two things live here, and the second is a CORRECTNESS requirement rather
 * than an optimisation (plan D-003c):
 *
 *   1. Derivation. `useSyncQuery` keys every entry `['sync', name, args]`, so
 *      the observed name set is readable straight off the react-query cache
 *      and no consumer has to declare anything.
 *
 *   2. Cross-tab union. The EventSource is SHARED across tabs by
 *      `createCrossTabControlStream`: one tab owns the socket and fans events
 *      out to followers over BroadcastChannel. Each tab has its own
 *      queryClient, so the owner's cache does NOT contain the follower tabs'
 *      observed queries. A filter built from the owner's cache alone would
 *      silently starve every follower — a worse bug than the one being fixed,
 *      and invisible in the single-webview desktop case where it is most
 *      likely to be tested. So each tab publishes its own names and every tab
 *      keeps the UNION; the owner declares that union.
 *
 * The union degrades correctly rather than needing a special case: tabs can
 * hear each other exactly when BroadcastChannel works, which is exactly when
 * the control stream shares one socket. With no BroadcastChannel every tab is
 * standalone with its OWN socket, and a self-only declaration is then the
 * right answer.
 *
 * The set is GROW-ONLY for the tracker's lifetime (D-003b). A name that has
 * ever been observed keeps receiving events even after its component unmounts;
 * that costs a little unnecessary traffic and eliminates an entire class of
 * unmount/remount races. Growth is the only thing that can force a reconnect,
 * so the connection cannot thrash on ordinary navigation churn.
 */

import type { QueryClient } from '@tanstack/react-query';

/** Debounce window for growth-driven reconnects. Long enough that a page
 * navigation mounting a dozen queries produces ONE reconnect, short enough
 * that a newly-mounted view starts receiving its invalidations promptly. */
export const INTEREST_REGROW_DEBOUNCE_MS = 750;

/** Minimal BroadcastChannel surface used here, so tests can inject a fake and
 * a runtime without BroadcastChannel is a supported (standalone) path. */
export interface InterestBroadcastChannel {
  postMessage(data: unknown): void;
  close(): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
}

export type InterestBroadcastChannelCtor = new (name: string) => InterestBroadcastChannel;

const PROTOCOL_VERSION = 1;

interface InterestMessage {
  v: number;
  scope: string;
  from: string;
  /** Names this tab observes. */
  names: string[];
  /** A joining tab asks peers to re-announce; without it a tab that starts
   * after its peers would hold a union missing every already-mounted query
   * until those peers happened to change. */
  ask?: boolean;
}

/**
 * Read the observed query names off the react-query cache.
 *
 * Keys are `['sync', name, args]`; anything else in the cache belongs to a
 * different consumer and is ignored. Non-string names are skipped rather than
 * coerced — a malformed key must not become a declared name that then filters
 * real events away.
 */
export function observedQueryNames(queryClient: QueryClient): Set<string> {
  const names = new Set<string>();
  for (const query of queryClient.getQueryCache().getAll()) {
    const key = query.queryKey;
    if (!Array.isArray(key) || key[0] !== 'sync') continue;
    const name = key[1];
    if (typeof name === 'string' && name.length > 0) names.add(name);
  }
  return names;
}

export interface InterestTracker {
  /** The current union across every tab we can hear, including ourselves. */
  current(): Set<string>;
  /** Re-read the local cache and publish it. Called on cache changes. */
  refresh(): void;
  close(): void;
}

export interface CreateInterestTrackerOptions {
  queryClient: QueryClient;
  /** Channel scope — tabs sharing a control stream must share this. */
  scope: string;
  /** Called (debounced) when the union GROWS beyond what was last reported. */
  onGrow: (names: Set<string>) => void;
  tabId?: string;
  debounceMs?: number;
  broadcastChannelCtor?: InterestBroadcastChannelCtor;
  /** Injectable for tests; defaults to setTimeout/clearTimeout. */
  scheduler?: {
    setTimeout: (fn: () => void, ms: number) => unknown;
    clearTimeout: (handle: unknown) => void;
  };
}

function randomTabId(): string {
  return `t-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
}

function resolveChannelCtor(
  explicit: InterestBroadcastChannelCtor | undefined,
): InterestBroadcastChannelCtor | null {
  if (explicit) return explicit;
  if (typeof BroadcastChannel === 'undefined') return null;
  return BroadcastChannel as unknown as InterestBroadcastChannelCtor;
}

/**
 * Track the cross-tab union of observed query names and report growth.
 *
 * `onGrow` fires in EVERY tab, not just the socket owner — deciding who acts
 * on it belongs to the caller, which is the only layer that knows which tab
 * currently holds the physical connection.
 */
export function createInterestTracker(opts: CreateInterestTrackerOptions): InterestTracker {
  const tabId = opts.tabId ?? randomTabId();
  const debounceMs = opts.debounceMs ?? INTEREST_REGROW_DEBOUNCE_MS;
  const setTimeoutFn = opts.scheduler?.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimeoutFn =
    opts.scheduler?.clearTimeout ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));

  /** Per-tab contributions. Grow-only per tab, and entries are never dropped
   * when a tab leaves: a superset declaration only ever costs traffic, while
   * dropping a departed tab's names could starve a view that is still open in
   * a tab we merely stopped hearing from. */
  const byTab = new Map<string, Set<string>>();
  /** The union as last handed to `onGrow`; growth is measured against this. */
  let reported = new Set<string>();
  let closed = false;
  let pending: unknown = null;

  let channel: InterestBroadcastChannel | null = null;
  const Ctor = resolveChannelCtor(opts.broadcastChannelCtor);
  if (Ctor) {
    try {
      channel = new Ctor(`papercusp-sync-interest:${opts.scope}`);
    } catch {
      channel = null; // no coordination surface -> standalone, self-only union
    }
  }

  const union = (): Set<string> => {
    const out = new Set<string>();
    for (const names of byTab.values()) for (const n of names) out.add(n);
    return out;
  };

  const grewBeyondReported = (next: Set<string>): boolean => {
    for (const n of next) if (!reported.has(n)) return true;
    return false;
  };

  const scheduleGrowthCheck = (): void => {
    if (closed || pending !== null) return;
    pending = setTimeoutFn(() => {
      pending = null;
      if (closed) return;
      const next = union();
      if (!grewBeyondReported(next)) return;
      reported = next;
      opts.onGrow(new Set(next));
    }, debounceMs);
  };

  const post = (msg: InterestMessage): void => {
    if (!channel) return;
    try {
      channel.postMessage(msg);
    } catch {
      /* a dead channel must never break local tracking */
    }
  };

  const publishSelf = (ask = false): void => {
    const mine = byTab.get(tabId);
    post({
      v: PROTOCOL_VERSION,
      scope: opts.scope,
      from: tabId,
      names: mine ? [...mine] : [],
      ...(ask ? { ask: true } : {}),
    });
  };

  const refresh = (): void => {
    if (closed) return;
    const mine = observedQueryNames(opts.queryClient);
    const prev = byTab.get(tabId);
    // Grow-only per tab: a name this tab has observed stays declared.
    const merged = prev ? new Set([...prev, ...mine]) : mine;
    const changed = !prev || merged.size !== prev.size;
    byTab.set(tabId, merged);
    if (changed) {
      publishSelf();
      scheduleGrowthCheck();
    }
  };

  if (channel) {
    channel.onmessage = (ev: { data: unknown }) => {
      if (closed) return;
      const msg = ev?.data as InterestMessage | undefined;
      if (!msg || msg.v !== PROTOCOL_VERSION || msg.scope !== opts.scope) return;
      if (typeof msg.from !== 'string' || msg.from === tabId) return;
      if (!Array.isArray(msg.names)) return;
      const incoming = msg.names.filter((n): n is string => typeof n === 'string' && n.length > 0);
      const prev = byTab.get(msg.from);
      const merged = prev ? new Set([...prev, ...incoming]) : new Set(incoming);
      byTab.set(msg.from, merged);
      // A joining peer needs our current set, or its union starts incomplete.
      if (msg.ask) publishSelf();
      scheduleGrowthCheck();
    };
  }

  // Seed from the local cache, then announce ourselves and ask peers to reply.
  refresh();
  publishSelf(true);

  return {
    current: () => union(),
    refresh,
    close: () => {
      if (closed) return;
      closed = true;
      if (pending !== null) {
        clearTimeoutFn(pending);
        pending = null;
      }
      if (channel) {
        channel.onmessage = null;
        try {
          channel.close();
        } catch {
          /* already gone */
        }
        channel = null;
      }
    },
  };
}
