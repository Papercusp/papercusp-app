/**
 * askUserLocal — client-side companion to server-side ctx.askUser.
 *
 * For render-time-only prompts (tab pickers, settings dialogs,
 * confirm-before-action). The card never crosses the wire; the
 * resolver runs in the same React tree as the renderer.
 *
 * Plan: bespoke-card-improvements-2026-05-13.md §4.4 (M6 boundary)
 *
 * Usage (inside a React component):
 *   const r = await askUserLocal({
 *     prompt: 'Switch to new chat?',
 *     dataSchema: z.object({ choice: z.enum(['yes', 'no']) }),
 *     presentation: { kind: 'radio', options: [{id:'yes',label:'Yes'},{id:'no',label:'No'}] },
 *   });
 *
 * Implementation: a SHARED queue (single source of truth) plus a set of
 * subscribed host renderers. Every subscribed host receives every queue
 * change (push AND resolve) so its local view can never drift from the
 * canonical state.
 *
 * EI-19952165837170400: this used to be a per-card FAN-OUT — each host kept
 * its OWN `queue` React state, independently appended to on every incoming
 * card. Multiple mounted hosts (the chat sidebar AND an open session popup,
 * the normal case for this surface) each rendered their own copy of the same
 * card, and resolving one left the other's copy mounted and answerable — a
 * stale, orphaned duplicate the owner could act on after the real one had
 * already resolved. The shared-queue design makes that impossible: there is
 * exactly one queue, and every host's view IS that queue.
 *
 * A shared queue alone would still render the card in every mounted host at
 * once, though, which is its own bug (two visible copies of the same
 * question). So hosts additionally run a HOST ELECTION
 * (registerLocalCardHost / isActiveLocalCardHost): only the
 * most-recently-mounted host actually renders the head card; other mounted
 * hosts render nothing. Unmounting the active host promotes the
 * next-most-recently-mounted one, so a card raised while a modal is open and
 * left pending after the modal closes still surfaces in the sidebar.
 *
 * Falls back to {action:'cancel'} when no host is mounted.
 */

import type { CardResponse, CardSpec } from '@papercusp/agent-mcp';
import type { ZodTypeAny } from 'zod';
import { pinModuleState } from '@papercusp/module-singleton';

export interface OpenLocalCard<TSchema extends ZodTypeAny = ZodTypeAny> {
  id: string;
  spec: CardSpec<TSchema>;
  resolve: (response: CardResponse<TSchema>) => void;
}

type QueueListener = (queue: readonly OpenLocalCard[]) => void;
type ElectionListener = () => void;

type Registry = {
  queue: OpenLocalCard[];
  listeners: Set<QueueListener>;
  /** Host ids in mount order — the LAST entry is the active (rendering) host. */
  hostOrder: string[];
  electionListeners: Set<ElectionListener>;
};

// Pinned at module scope ONCE, not inside registry(). pinModuleState counts
// every call as an evaluation and listModuleDuplications() reports
// `evaluations > 1` as a split, so pinning inside the accessor — which runs on
// every notify — would manufacture a false duplication report in the very
// surface this pin exists to make honest.
const REGISTRY = pinModuleState<Registry>('@papercusp/web.ask-user-local-registry', () => ({
  queue: [],
  listeners: new Set(),
  hostOrder: [],
  electionListeners: new Set(),
}));

function registry(): Registry {
  return REGISTRY;
}

function notifyQueue(): void {
  const r = registry();
  const snapshot = r.queue.slice();
  for (const l of r.listeners) {
    try {
      l(snapshot);
    } catch (e) {
      console.warn('[askUserLocal] listener threw', e);
    }
  }
}

function notifyElection(): void {
  const r = registry();
  for (const cb of r.electionListeners) {
    try {
      cb();
    } catch (e) {
      console.warn('[askUserLocal] election listener threw', e);
    }
  }
}

/**
 * Subscribe a host renderer to the SHARED queue. Fires immediately with the
 * current queue, then again on every push/resolve. Returns an unsubscribe
 * function.
 */
export function subscribeAskUserLocal(cb: QueueListener): () => void {
  const r = registry();
  r.listeners.add(cb);
  // Deliver the current snapshot immediately, same error handling as the
  // broadcast path — a throwing subscriber must not block registration or
  // propagate out of subscribeAskUserLocal itself.
  try {
    cb(r.queue.slice());
  } catch (e) {
    console.warn('[askUserLocal] listener threw', e);
  }
  return () => {
    r.listeners.delete(cb);
  };
}

/**
 * Host election (EI-19952165837170400). Register a mounted host renderer —
 * the most-recently-registered host is ACTIVE; only the active host should
 * actually render the head card (see `isActiveLocalCardHost`). Registering
 * or unregistering a host notifies every subscribed queue listener so every
 * mounted host re-evaluates its own active-ness. Call once per host mount;
 * the returned function unregisters it (call on unmount).
 */
export function registerLocalCardHost(hostId: string): () => void {
  const r = registry();
  r.hostOrder = r.hostOrder.filter((id) => id !== hostId);
  r.hostOrder.push(hostId);
  notifyElection();
  notifyQueue();
  return () => {
    const rr = registry();
    rr.hostOrder = rr.hostOrder.filter((id) => id !== hostId);
    notifyElection();
    notifyQueue();
  };
}

/** Is `hostId` the currently-elected (rendering) host? */
export function isActiveLocalCardHost(hostId: string): boolean {
  const r = registry();
  return r.hostOrder.length > 0 && r.hostOrder[r.hostOrder.length - 1] === hostId;
}

/**
 * Subscribe to election changes (a host registered/unregistered) without
 * caring about the queue itself. Most callers should just re-derive
 * `isActiveLocalCardHost` inside their `subscribeAskUserLocal` callback —
 * `registerLocalCardHost` already triggers a queue notification on every
 * election change — but this is exposed for callers that need to react to
 * election changes even while the queue is empty.
 */
export function subscribeLocalCardHostElection(cb: ElectionListener): () => void {
  const r = registry();
  r.electionListeners.add(cb);
  return () => {
    r.electionListeners.delete(cb);
  };
}

/**
 * Request a local prompt. Returns a promise that resolves when any host
 * calls `resolve()`. If no host is subscribed, resolves immediately with
 * `{action:'cancel'}` (the caller decides how to handle that).
 */
export function askUserLocal<TSchema extends ZodTypeAny>(
  spec: CardSpec<TSchema>,
): Promise<CardResponse<TSchema>> {
  const r = registry();
  if (r.listeners.size === 0) {
    return Promise.resolve({ action: 'cancel' } as CardResponse<TSchema>);
  }
  return new Promise<CardResponse<TSchema>>((resolve) => {
    const card: OpenLocalCard<TSchema> = {
      id: crypto.randomUUID(),
      spec,
      resolve,
    };
    let resolved = false;
    card.resolve = (response: CardResponse<TSchema>) => {
      if (resolved) return;
      resolved = true;
      // Remove from the SHARED queue and broadcast — every subscribed host
      // (not just whichever one the user answered from) drops its view of
      // this card in the same tick, so no stale copy survives to be
      // answered twice (EI-19952165837170400).
      const rr = registry();
      rr.queue = rr.queue.filter((c) => c.id !== card.id);
      notifyQueue();
      resolve(response);
    };
    r.queue.push(card as unknown as OpenLocalCard);
    notifyQueue();
  });
}

/** Test-only: clear all subscribers, hosts, and the queue. */
export function _resetAskUserLocalForTests(): void {
  const r = registry();
  r.queue = [];
  r.listeners.clear();
  r.hostOrder = [];
  r.electionListeners.clear();
}
