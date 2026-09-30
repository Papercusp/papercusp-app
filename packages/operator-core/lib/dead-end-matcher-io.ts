/**
 * dead-end-matcher-io — the LIVE leg of the P-006 dead-end matcher
 * (ambient-semantic-push-2026-07-14). It stitches the pure matcher core
 * (dead-end-matcher.matchDeadEnds) to the live cursor (session-cursor-store), the
 * REAL dead-end fact store (the P-015 slot — agent_facts rows keyed `dead-end:%`,
 * written via facts:assert { slot:'dead-end' }, read via foldDeadEndFacts), and
 * the delivery rail (push-delivery-store.enqueuePush):
 *
 *   read self's fresh cursor  →  fold the in-scope dead-end facts  →  matchDeadEnds
 *   →  drop refs already QUEUED for this owner (stateless-matcher dedup)  →  ENQUEUE
 *   a WARNING push (handle → the fact) to SELF.
 *
 * SELF-only: a dead end is a warning to the agent whose OWN work is drifting
 * toward a path it (or its role/harness/workspace) already documented as failed.
 * There is no peer side — unlike the symmetric collision matcher, the signal is
 * "your cursor vs the dead ends in your scope", not "your cursor vs a peer's".
 *
 * The push rides self's own next wake through the shared rail
 * (prepareAmbientPushBlock → selectPushes → injection door); this leg only
 * ENQUEUES. Two dedups keep it from becoming Clippy, and together they are the
 * stateless analog of the collision matcher's hysteresis edge-suppression:
 *   • the rail's NOVELTY guard (deliveredRefs → not-novel) stops re-warning about
 *     a dead end the agent has already been shown, for the delivery window;
 *   • this leg's QUEUED-ref dedup (push-delivery-store.queuedRefs) stops a second
 *     queued row piling up every tick BEFORE the rail drains — the matcher is
 *     stateless and re-proposes every tick the cursor still overlaps the fact.
 *
 * SEAM: journal:record-turn fires {@link boundedDeadEndTick} right AFTER the
 * P-001 cursor upsert (a fresh cursor is the tick trigger), behind the SAME
 * PAPERCUSP_AMBIENT_CURSOR gate as the cursor build + collision tick — the caller
 * checks the flag BEFORE importing this module, so the off path never loads it.
 * Bounded + fail-soft: an advisory warning must never slow or fail the journal
 * write.
 *
 * NO new table + NO cross-tick state: the dead-end fact store is the already-live
 * P-015 slot (agent_facts), and a match is a pure function of the current cursor
 * against the current facts — nothing to persist between ticks.
 *
 * DEFERRED-with-reason (not faked here): resolving a pulled dead-end fact.ref into
 * a full brief on the RECEIVE side (the reader's pull path) — the enqueue leg only
 * needs the ref to point at + the note to warn with; the pure core's
 * DeadEndFactSource.resolve names that receive-side seam.
 */
import { withBoundedTimeout } from './bounded-timeout';
import { matchDeadEnds, type DeadEndFact, type DeadEndMatchOptions } from './dead-end-matcher';
import type { LexicalCursor } from './lexical-cursor';
import type { AgentFact, FactSelector } from './agent-facts/store';

/** Budget for the turn-end dead-end tick (mirrors the cursor build + collision
 *  tick — the same fire-and-forget turn-end advisory contract). */
export const DEAD_END_TICK_BUDGET_MS = 4_000;

/** Per-scope cap on dead-end facts folded into one tick. Higher than the brief
 *  fold budget (FACTS_FOLD_LIMIT): this is the matcher's full candidate set, not
 *  a fold rendered into a bounded brief. */
export const DEAD_END_FOLD_LIMIT = 24;

export interface DeadEndTickInput {
  /** The self session whose fresh cursor triggers this tick. */
  selfSessionId: string;
  /** Self's coord identity (the delivery axis for the self-directed warning). */
  selfOwnerId: string | null;
  /** The harness the session is in, when known — adds the harness-scoped dead-end
   *  facts to the fold. */
  harnessSlug?: string | null;
  /** Workspace partition for the fact fold + the enqueue (defaults to the active
   *  workspace / 'default' respectively when omitted). */
  workspaceId?: string;
  /** Matcher tuning override (floor / maxTerms / cursorOptions), else the pure
   *  core's defaults. */
  matchOptions?: DeadEndMatchOptions;
}

export interface DeadEndTickResult {
  /** false when self has no cursor yet (nothing to tick). */
  ran: boolean;
  /** Documented dead ends the cursor overlapped this tick (pre-dedup). */
  matched: number;
  /** Warning pushes actually enqueued (after the owner gate + queued-ref dedup). */
  enqueued: number;
}

const ZERO_RESULT: DeadEndTickResult = { ran: false, matched: 0, enqueued: 0 };

/**
 * PURE: fold a set of agent_facts rows into the matcher's {@link DeadEndFact}[].
 * The fact's KEY is the resolvable handle ref — the greppable `dead-end:<slug>`
 * slot the reader re-pulls (kind 'fact', the natural home of a dead-end record);
 * the body is the match signal + teaser note. Skips rows the matcher would drop
 * anyway (empty body / no key), so `matched` counts real candidates.
 */
export function factsToDeadEnds(facts: readonly AgentFact[]): DeadEndFact[] {
  const out: DeadEndFact[] = [];
  for (const f of facts) {
    if (!f || typeof f.body !== 'string' || !f.body.trim() || !f.key) continue;
    out.push({ ref: f.key, note: f.body, kind: 'fact' });
  }
  return out;
}

/**
 * Run one dead-end tick for `selfSessionId`. Reads its just-persisted cursor and
 * the in-scope dead-end facts, matches them, and enqueues a warning push to self
 * for each documented dead end the cursor is drifting toward. Assumes the feature
 * is enabled (the caller gates on PAPERCUSP_AMBIENT_CURSOR before importing this
 * module). Not bounded here — {@link boundedDeadEndTick} owns the budget + the
 * fail-soft guarantee.
 */
export async function runDeadEndTick(input: DeadEndTickInput): Promise<DeadEndTickResult> {
  const [cursorStore, factStore, deliveryStore] = await Promise.all([
    import('./session-cursor-store'),
    import('./agent-facts/store'),
    import('./push-delivery-store'),
  ]);

  // Self's freshly-persisted cursor is the tick input. No cursor yet ⇒ nothing to do.
  const selfRow = await cursorStore.getSessionCursorRow(input.selfSessionId);
  if (!selfRow) return { ...ZERO_RESULT, ran: false };
  const selfCursor: LexicalCursor = cursorStore.rowToCursor(selfRow);

  // The in-scope dead-end facts (the P-015 slot): workspace-global, the agent's
  // own (owner), and the project's (harness) — the same scoping a fact fold uses.
  const selectors: FactSelector[] = [{ scope: 'workspace' }];
  if (input.selfOwnerId) selectors.push({ scope: 'owner', scopeRef: input.selfOwnerId });
  if (input.harnessSlug) selectors.push({ scope: 'harness', scopeRef: input.harnessSlug });

  const factRows = await factStore.foldDeadEndFacts(selectors, {
    workspaceId: input.workspaceId,
    limitPerSelector: DEAD_END_FOLD_LIMIT,
  });
  const facts = factsToDeadEnds(factRows);
  if (facts.length === 0) return { ran: true, matched: 0, enqueued: 0 };

  const matches = matchDeadEnds(selfCursor, facts, input.matchOptions);
  if (matches.length === 0) return { ran: true, matched: 0, enqueued: 0 };

  // Nothing to deliver to without an owner axis (the warning is self-directed).
  if (!input.selfOwnerId) return { ran: true, matched: matches.length, enqueued: 0 };

  // Stateless-matcher dedup: never pile a second queued row for a dead end already
  // awaiting delivery. (The rail dedups DELIVERED refs as not-novel; this dedups
  // QUEUED refs so the turn-after-turn re-proposal doesn't accumulate rows.)
  const alreadyQueued = await deliveryStore.queuedRefs(input.selfOwnerId, 'dead-end');

  let enqueued = 0;
  for (const { push } of matches) {
    if (alreadyQueued.has(push.handle.ref)) continue;
    try {
      await deliveryStore.enqueuePush({
        targetOwnerId: input.selfOwnerId,
        targetSessionId: input.selfSessionId,
        workspaceId: input.workspaceId,
        matcherKind: 'dead-end',
        severity: push.severity,
        handleKind: push.handle.kind,
        handleRef: push.handle.ref,
        handleQuery: push.handle.query,
        teaser: push.teaser,
        score: push.score,
        sourceSessionId: null, // a dead end is self's own recorded fact, not a peer's
      });
      alreadyQueued.add(push.handle.ref); // guard against duplicate refs within THIS tick
      enqueued += 1;
    } catch {
      /* fail-soft: skip this push, keep the rest */
    }
  }

  return { ran: true, matched: matches.length, enqueued };
}

/**
 * The seam the journal:record-turn hook calls after the cursor upsert: bounded +
 * fail-soft dead-end tick. Never throws, never hangs past
 * {@link DEAD_END_TICK_BUDGET_MS}; degrades to a no-op result. The caller checks
 * {@link import('./session-cursor-io').ambientCursorEnabled} BEFORE importing this
 * module, so the default-off path never loads the dead-end code.
 */
export async function boundedDeadEndTick(input: DeadEndTickInput): Promise<DeadEndTickResult> {
  const { value } = await withBoundedTimeout(runDeadEndTick(input), {
    fallback: ZERO_RESULT,
    timeoutMs: DEAD_END_TICK_BUDGET_MS,
    label: 'turn-end-dead-end-tick',
  });
  return value;
}
