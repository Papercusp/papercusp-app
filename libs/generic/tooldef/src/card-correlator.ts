/**
 * Card correlator — server-side state machine for ctx.askUser.
 *
 * Plan: apps/operator/docs/plans/bespoke-card-improvements-2026-05-13.md §4.3
 *
 * Each ctx.askUser call:
 *   1. (optional) idempotency-key cache hit → return cached response, no emit
 *   2. generate correlationId = crypto.randomUUID()
 *   3. register in PENDING + BY_RUN; publish state-channel snapshot
 *   4. on timeoutMs (if set) → resolve {action:'cancel'}, drop
 *   5. on /card-response POST → validate payload against dataSchema,
 *      resolve Deferred, drop, re-publish snapshot
 *   6. on run-end → cancel every pending card for the run
 *   7. on workspace-switch → cancel every pending card in the workspace (H4)
 *
 * State source-of-truth: the PENDING map IS what `setOpenCards` mirrors
 * to the state channel. No double-bookkeeping (H2).
 */

import { pinModuleState } from '@papercusp/module-singleton';
import type { CardResponse, CardSpec, OpenCardSnapshot } from './types';
import { setOpenCards } from './state-channel';
import { onWorkspaceSwitch } from './workspace-lifecycle';
import { toJsonSchema } from './schema-adapter';
import { validateSync, type StandardSchemaV1 } from './standard-schema';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
}

function makeDeferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

interface PendingCard<TSchema extends StandardSchemaV1 = StandardSchemaV1> {
  correlationId: string;
  runId: string;
  workspaceId: string;
  spec: CardSpec<TSchema>;
  deferred: Deferred<CardResponse<TSchema>>;
  createdAt: number;
  timeoutHandle?: ReturnType<typeof setTimeout>;
}

/**
 * The pin key — also the id this module reports under in
 * `listModuleDuplications()`, so a split here shows up in the REALM-WIDE report
 * rather than only through this module's own accessor. Unchanged from the
 * `Symbol.for(...)` description used before the migration (EI-19479108855357092).
 */
const STATE_KEY = 'papercusp.cardCorrelatorRegistry';

interface CardCorrelatorState {
  pending: Map<string /* correlationId */, PendingCard>;
  byRun: Map<string /* runId */, Set<string /* correlationId */>>;
  idempotency: Map<string /* runId */, Map<string /* key */, CardResponse<any>>>;
  lifecycleSubscribed: boolean;
}

/**
 * Pinned + counted rather than hand-rolled: a hand-rolled
 * `globalThis[Symbol.for(...)]` slot is equally correct and completely invisible
 * to `listModuleDuplications()`. Must stay at module scope. Lifecycle
 * subscription stays lazy in `registry()` — only the data is eager.
 */
const state = pinModuleState<CardCorrelatorState>(STATE_KEY, () => ({
  pending: new Map(),
  byRun: new Map(),
  idempotency: new Map(),
  lifecycleSubscribed: false,
}));

function registry() {
  const r = state;
  if (!r.lifecycleSubscribed) {
    onWorkspaceSwitch((wid) => cancelPendingCardsForWorkspaceSwitch(wid));
    r.lifecycleSubscribed = true;
  }
  return r;
}

function zodToJsonSchema(schema: StandardSchemaV1): Record<string, unknown> {
  // Pluggable schema→JSON-Schema (P-021); default adapter is Zod 4's
  // toJSONSchema (zod-to-json-schema@3 produced empty results for Zod 4).
  const raw = toJsonSchema(schema);
  delete raw.$schema;
  return raw;
}

function pendingToOpenCard(card: PendingCard): OpenCardSnapshot {
  return {
    correlationId: card.correlationId,
    prompt: card.spec.prompt,
    dataSchemaJson: zodToJsonSchema(card.spec.dataSchema),
    presentation: card.spec.presentation,
    fallbackText: card.spec.fallbackText,
    allowDecline: card.spec.allowDecline,
    report: card.spec.report,
    createdAt: card.createdAt,
  };
}

function republishRunSnapshot(runId: string): void {
  const r = registry();
  const ids = r.byRun.get(runId);
  const cards: OpenCardSnapshot[] = [];
  if (ids) {
    for (const cid of ids) {
      const card = r.pending.get(cid);
      if (card) cards.push(pendingToOpenCard(card));
    }
  }
  setOpenCards(runId, cards);
}

/**
 * Write a resolved card response to the idempotency cache synchronously
 * at resolve time. Key may be undefined (no-op).
 *
 * Synchronous write closes the original race: previously we wrote via
 * deferred.promise.then(), which runs as a microtask. A second
 * registerCard with the same key arriving BETWEEN resolve and the
 * microtask saw no cache hit and registered a duplicate card.
 */
function cacheIdempotency(
  runId: string,
  key: string | undefined,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  response: CardResponse<any>,
): void {
  if (!key) return;
  const r = registry();
  let cache = r.idempotency.get(runId);
  if (!cache) {
    cache = new Map();
    r.idempotency.set(runId, cache);
  }
  cache.set(key, response);
}

function drop(correlationId: string): void {
  const r = registry();
  const card = r.pending.get(correlationId);
  if (!card) return;
  if (card.timeoutHandle) clearTimeout(card.timeoutHandle);
  r.pending.delete(correlationId);
  const set = r.byRun.get(card.runId);
  if (set) {
    set.delete(correlationId);
    if (set.size === 0) r.byRun.delete(card.runId);
  }
  republishRunSnapshot(card.runId);
}

/**
 * Register a new card and return a promise that resolves when the user
 * responds (or the card is cancelled/declined/times-out).
 *
 * Idempotency: if `spec.idempotencyKey` is set and we have a cached
 * response for the same (runId, idempotencyKey), return the cached
 * response immediately without registering or emitting.
 */
export function registerCard<TSchema extends StandardSchemaV1>(opts: {
  workspaceId: string;
  runId: string;
  spec: CardSpec<TSchema>;
}): { correlationId: string; result: Promise<CardResponse<TSchema>> } {
  const r = registry();

  if (opts.spec.idempotencyKey) {
    const cache = r.idempotency.get(opts.runId);
    const hit = cache?.get(opts.spec.idempotencyKey);
    if (hit) {
      return {
        correlationId: 'idempotent',
        result: Promise.resolve(hit as CardResponse<TSchema>),
      };
    }
  }

  const correlationId = crypto.randomUUID();
  const deferred = makeDeferred<CardResponse<TSchema>>();

  const card: PendingCard<TSchema> = {
    correlationId,
    runId: opts.runId,
    workspaceId: opts.workspaceId,
    spec: opts.spec,
    deferred,
    createdAt: Date.now(),
  };

  r.pending.set(correlationId, card as unknown as PendingCard);
  let set = r.byRun.get(opts.runId);
  if (!set) {
    set = new Set();
    r.byRun.set(opts.runId, set);
  }
  set.add(correlationId);

  if (opts.spec.timeoutMs && opts.spec.timeoutMs > 0) {
    card.timeoutHandle = setTimeout(() => {
      // Re-fetch by id — if a competing resolve already dropped the
      // card, the timeout is a no-op. Setting timeoutHandle=undefined
      // here matters only if we lose the race to another path that
      // also calls clearTimeout; either way pending.has() is the gate.
      if (r.pending.has(correlationId)) {
        const response = { action: 'cancel' } as CardResponse<TSchema>;
        cacheIdempotency(opts.runId, opts.spec.idempotencyKey, response);
        deferred.resolve(response);
        drop(correlationId);
      }
    }, opts.spec.timeoutMs);
  }

  republishRunSnapshot(opts.runId);

  return { correlationId, result: deferred.promise };
}

/**
 * Resolve a pending card with a user response. Returns:
 *   { ok: true }       — accepted, deferred resolved
 *   { ok: false, error } — not found OR validation failed
 *
 * Workspace gating: if `expectedWorkspaceId` is supplied and does not
 * match the card's workspaceId, returns not-found (defense in depth
 * against cross-workspace replay; the route's auth check is the
 * primary defense).
 */
export function resolveCardResponse(opts: {
  correlationId: string;
  action: 'submit' | 'decline' | 'cancel';
  payload?: unknown;
  reason?: string;
  expectedWorkspaceId?: string;
}): { ok: true } | { ok: false; status: number; error: string; details?: unknown } {
  const r = registry();
  const card = r.pending.get(opts.correlationId);
  if (!card) {
    return { ok: false, status: 404, error: 'card not found' };
  }
  if (opts.expectedWorkspaceId && card.workspaceId !== opts.expectedWorkspaceId) {
    return { ok: false, status: 404, error: 'card not found' };
  }

  // Compute the response shape BEFORE touching any timers / dropping —
  // validation may fail, in which case we leave the card pending.
  let response: CardResponse;
  if (opts.action === 'submit') {
    const parsed = validateSync(card.spec.dataSchema, opts.payload);
    if (!parsed.ok) {
      return {
        ok: false,
        status: 400,
        error: 'payload does not match dataSchema',
        details: parsed.issues,
      };
    }
    response = { action: 'submit', payload: parsed.value };
  } else if (opts.action === 'decline') {
    if (card.spec.allowDecline === false) {
      return { ok: false, status: 400, error: 'this card does not allow decline' };
    }
    response = { action: 'decline', reason: opts.reason };
  } else {
    response = { action: 'cancel' };
  }

  // Close the timeout/resolve race: clear the timeout BEFORE deferred.resolve
  // so a concurrent timeout firing finds pending.has() false (drop runs below)
  // AND its setTimeout is already cancelled. Without this, the timeout could
  // call deferred.resolve with cancel after we resolved with submit — caller
  // gets 200 OK but the tool's await sees the cancel.
  if (card.timeoutHandle) {
    clearTimeout(card.timeoutHandle);
    card.timeoutHandle = undefined;
  }
  cacheIdempotency(card.runId, card.spec.idempotencyKey, response);
  card.deferred.resolve(response);
  drop(opts.correlationId);
  return { ok: true };
}

/**
 * Cancel every pending card under a run. Used at run-end / abort.
 */
export function cancelPendingCardsForRun(runId: string): void {
  const r = registry();
  const ids = r.byRun.get(runId);
  if (!ids) return;
  for (const cid of [...ids]) {
    const card = r.pending.get(cid);
    if (card) {
      card.deferred.resolve({ action: 'cancel' } as CardResponse);
      drop(cid);
    }
  }
  r.idempotency.delete(runId);
}

/**
 * Cancel every pending card in a workspace. Subscribed via
 * onWorkspaceSwitch.
 */
export function cancelPendingCardsForWorkspaceSwitch(workspaceId: string): void {
  const r = registry();
  const toDrop: string[] = [];
  const runsToDrop = new Set<string>();
  for (const [cid, card] of r.pending) {
    if (card.workspaceId === workspaceId) {
      card.deferred.resolve({ action: 'cancel' } as CardResponse);
      toDrop.push(cid);
      runsToDrop.add(card.runId);
    }
  }
  for (const cid of toDrop) drop(cid);
  for (const rid of runsToDrop) r.idempotency.delete(rid);
}

/** Test-only: clear everything. */
export function _resetCardCorrelatorForTests(): void {
  const r = registry();
  for (const card of r.pending.values()) {
    if (card.timeoutHandle) clearTimeout(card.timeoutHandle);
  }
  r.pending.clear();
  r.byRun.clear();
  r.idempotency.clear();
}

/** Test-only stats. */
export function _cardCorrelatorStatsForTests(): {
  pendingCount: number;
  runCount: number;
} {
  const r = registry();
  return { pendingCount: r.pending.size, runCount: r.byRun.size };
}
