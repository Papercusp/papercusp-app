/**
 * Production adapters for `system:consult-expiry-sweep`.
 * EI-21559794492221235 · pattern reference: `../acceptance-grading-sweep-observe.ts`
 *
 * ── WHY THIS IS ITS OWN MODULE ─────────────────────────────────────────────────
 * `consult-expiry-core.ts` is pure and integration-tested, and that is exactly what
 * made this blind spot easy to miss: the CORE was covered, so the sweep read as
 * tested. But the three adapters that bind that core to real services —
 * `emitReplyEvent`, `dispatch`, `notifyRequester` — lived as lambdas inside the
 * `registerSystemAction` closure in `../harness/routines/consult-expiry-action.ts`.
 * Nothing outside that closure could reach them, so a test could only pin their
 * SOURCE TEXT, never execute them.
 *
 * That is not a hypothetical gap. It is the same shape as the defect in
 * `acceptance-grading-sweep-observe`: a closure-sealed adapter read a field that did
 * not exist, returned a falsy value on every row, and stayed invisible to 75 passing
 * tests because no test could call it.
 *
 * ── WHAT THE ADAPTERS ACTUALLY DECIDE ──────────────────────────────────────────
 * These are not pass-throughs, which is the reason they are worth executing:
 *
 *   - `consult_state` is workspace-PARTITIONED and ONE sweep serves every workspace,
 *     so the workspace must ride on each CALL. Taking it from the routine's ambient
 *     scope instead would silently address the wrong tenant — and would still pass
 *     every core test, because the core supplies the workspace and never checks where
 *     the adapter got it from.
 *   - `dispatch` must build its dispatcher per row from `opts.workspaceId` (D-011),
 *     stamp the sweep as `launchedBy`, and narrow the dispatcher's richer result down
 *     to the `{ woke, answeringOwnerId }` the core consumes. Hoisting the factory call
 *     out of the returned lambda would bind every workspace's launches to the first
 *     row's tenant — and would still pass every core test.
 *
 * Dependencies arrive as parameters and the service shapes are declared structurally,
 * so a test can drive these with fakes and this module stays off the events-engine,
 * notify-agents, and dispatcher import graphs.
 */
import type { AgentIdentity } from '../agent-tools/coordination/identity';
import type { SendOptions } from '../agent-tools/coordination/messages';
import type { NotifyAgentsOpts, NotifyAgentsResult } from '../agent-tools/coordination/notify-agents';
import type { EmitAwaitedEventOpts, EmitResult } from '../events/await/engine';
import type { ExpirySweepDeps, SilentResponderCandidate } from './consult-expiry-core';
import { DEAD_RESPONDER_STATES, HARD_BLOCKED_EXPIRY_MS } from './get-feedback-core';
import type { ThreadableStore } from '@papercusp/coordination/capabilities';
import { runWithWorkspace } from '../workspace-als';
import { consultAnswerFacts } from '../task-manager/reaper';
import type { TaskRow } from '../task-manager/types';

/** The ownerId this sweep acts under. Exported so a test asserts the real constant
 *  rather than re-typing the string it is checking against. */
export const CONSULT_EXPIRY_SWEEP_OWNER_ID = 'system:consult-expiry-sweep';

// The service shapes below are `import type` only — erased at runtime — so this module
// binds to the REAL contracts (a drifted parameter is a compile error here) without
// pulling the events engine, notify-agents, or the reviver onto its import graph.

/** What this module needs from `emitAwaitedEvent`. */
export type AwaitedEventEmitter = (input: EmitAwaitedEventOpts) => Promise<EmitResult>;

/** What this module needs from `notifyAgents`. */
export type AgentNotifier = (
  identity: AgentIdentity,
  opts: NotifyAgentsOpts,
) => Promise<NotifyAgentsResult>;

/** What this module needs from the durable coord message writer. */
export type RequesterAlertSender = (
  identity: AgentIdentity,
  opts: SendOptions,
) => Promise<unknown>;

/** What this module needs from `makeConsultReachDispatcher` — a FACTORY, because
 *  the dispatch context is per-row workspace-scoped (the thing the adapter has to
 *  get right, exactly as the old reviver's two-parameter split was). */
export type ConsultDispatcherFactory = (ctx: {
  workspaceId: string;
  harnessSlug: string | null;
  launchedBy: string;
}) => (opts: {
  responder: string;
  conversationId: string;
  summary: string;
  body: string;
}) => Promise<{ woke: number; answeringOwnerId: string | null }>;

/** Narrow seams for the post-routing silent-responder detector. Keeping these
 * as injected functions makes the adapter executable in unit tests while the
 * routine action can still lazy-load the operator services. */
export interface SilentResponderDetectorDeps {
  getPresence: (ownerId: string) => Promise<{ lastActiveAt: string | null } | null>;
  resolveSessionStates: (
    subjects: readonly { ownerId: string }[],
    opts: { hydratePerId: true },
  ) => Promise<ReadonlyMap<string, { sessionState?: string | null }>>;
  getThreadStore: (workspaceId: string) => SilentResponderThreadStore;
  /** Injectable clock for the bounded live-busy pickup window. */
  now?: () => Date;
}

/** `listRecentPosts` is a production-only bounded extension of the shared
 * ThreadableStore contract, so keep the detector's minimal reader shape local
 * instead of pretending it is part of that public interface. */
export interface SilentResponderThreadStore {
  getThreadByParent: ThreadableStore['getThreadByParent'];
  listRecentPosts: (threadId: string, limit: number) => Promise<{
    total: number;
    posts?: Array<{ author_id: string | null }>;
  }>;
}

/** Bound the history we inspect. More posts than this are unknown, not silent. */
const SILENT_THREAD_POST_LIMIT = 20;

/**
 * The per-row workspace SYSTEM identity the sweep acts under.
 *
 * Identity cannot come from the routine's ALS scope: `consult_state` is
 * workspace-partitioned and one sweep serves every workspace (mirrors `probeIdentity`
 * in `coord-invariant-actions.ts`).
 */
export function sweepIdentity(workspaceId: string): AgentIdentity {
  return {
    ownerId: CONSULT_EXPIRY_SWEEP_OWNER_ID,
    ownerLabel: 'consult expiry sweep',
    source: 'omp-hook-session',
    workspaceId,
    userId: null,
  } as AgentIdentity;
}

/**
 * Latched `consult:reply:<conv>` emit → the (possibly parked) requester.
 * The emit must land in the ROW's workspace, not the routine's ambient scope.
 */
export function consultExpiryEmitReplyEvent(
  emit: AwaitedEventEmitter,
): ExpirySweepDeps['emitReplyEvent'] {
  return async (e) => {
    await emit({
      key: e.key,
      summary: e.summary,
      payload: e.payload,
      to: e.to,
      workspaceId: e.workspaceId,
      source: 'consult-expiry-sweep',
    });
  };
}

/**
 * Durable requester alert. The core derives a replay key from the consult
 * lifecycle position; passing it through to sendMessage makes a retry return
 * the stored winner instead of appending a duplicate message.
 */
export function consultExpiryNotifyRequester(
  send: RequesterAlertSender,
): NonNullable<ExpirySweepDeps['notifyRequester']> {
  return async (opts) => {
    await runWithWorkspace(opts.workspaceId, () =>
      send(sweepIdentity(opts.workspaceId), {
        msgId: opts.msgId,
        to: [opts.requesterId],
        summary: opts.summary,
        body: opts.body,
        harnessSlug: null,
        extra: { conversation_id: opts.conversationId, recovery: 'pending' },
      }),
    );
  };
}

/**
 * D-005 cascade advance, D-002/D-011 delivery: an unanswered window elapsing
 * moves the chain exactly like a decline does — and the next selectee is
 * DISPATCHED (a fresh answering session forked/converted from their transcript),
 * never woken. `launchedBy` is stamped as the sweep so the launch is
 * attributable back to it, and the dispatcher is built PER ROW because its
 * context is workspace-scoped just like `reach`'s identity was.
 */
export function consultExpiryDispatch(
  makeDispatcher: ConsultDispatcherFactory,
): NonNullable<ExpirySweepDeps['dispatch']> {
  return async (opts) =>
    runWithWorkspace(opts.workspaceId, async () => {
      const r = await makeDispatcher({
        workspaceId: opts.workspaceId,
        harnessSlug: null,
        launchedBy: CONSULT_EXPIRY_SWEEP_OWNER_ID,
      })({
        responder: opts.responder,
        conversationId: opts.conversationId,
        summary: opts.summary,
        body: opts.body,
      });
      return { woke: r.woke, answeringOwnerId: r.answeringOwnerId };
    });
}

/** Detect post-routing no-pickup failures that otherwise wait for the full
 * expiry window. Three observations are safe enough to advance as an implicit
 * decline when the consult thread is still empty:
 *
 *  - the answering session became active after routing and re-parked; or
 *  - the answering session is still live or parked after one hard-blocked expiry window.
 *    This is the continuously-busy or queued-but-never-picked-up case: a queued
 *    wake can sit behind unrelated work for the four-hour `proceed` window even
 *    though no consult turn was picked up; or
 *  - the owner terminalized after routing, which makes waiting for expiry
 *    pointless because the queued wake can no longer be consumed; or
 *  - dispatch never stamped an answering identity after the bounded pickup
 *    window. The source expert's liveness says nothing about this case.
 *
 * Reusing HARD_BLOCKED_EXPIRY_MS gives a live responder the same bounded pickup
 * opportunity a blocking requester already accepts, while still cutting the
 * `proceed` dead end from hours to minutes. The original responder remains in
 * the digest and the existing cascade refill/revival machinery owns recovery.
 * Presence and liveness are batched by owner; thread reads are partitioned by
 * row workspace.
 */
export function consultExpiryFindSilentResponders(
  deps: SilentResponderDetectorDeps,
): NonNullable<ExpirySweepDeps['findSilentResponders']> {
  return async (rows: readonly SilentResponderCandidate[]) => {
    if (rows.length === 0) return new Set<string>();

    const checkedAtMs = (deps.now ? deps.now() : new Date()).getTime();

    const answeringOwnerIds = [...new Set(rows.flatMap((row) => row.answeringOwnerId ? [row.answeringOwnerId] : []))];
    const [presenceEntries, verdicts] = answeringOwnerIds.length > 0
      ? await Promise.all([
          Promise.all(answeringOwnerIds.map(async (ownerId) => [ownerId, await deps.getPresence(ownerId)] as const)),
          deps.resolveSessionStates(answeringOwnerIds.map((ownerId) => ({ ownerId })), { hydratePerId: true }),
        ])
      : [[], new Map<string, { sessionState?: string | null }>()] as const;
    const presenceByOwner = new Map(presenceEntries);
    const stores = new Map<string, SilentResponderThreadStore>();
    const getStore = (workspaceId: string) => {
      let store = stores.get(workspaceId);
      if (!store) {
        store = deps.getThreadStore(workspaceId);
        stores.set(workspaceId, store);
      }
      return store;
    };

    const silent = new Set<string>();
    await Promise.all(
      rows.map(async (row) => {
        const routedMs = Date.parse(row.routedAt);
        if (!Number.isFinite(routedMs)) return;
        if (row.answeringOwnerId === null) {
          // onAnsweringOwner is stamped as soon as a launched session submits
          // its kickoff, before the verifier wait. No stamp after this window
          // plus no post is a failed dispatch; never probe the SOURCE owner.
          if (!Number.isFinite(checkedAtMs) || checkedAtMs - routedMs < HARD_BLOCKED_EXPIRY_MS) return;
        } else {
          const lastActiveAt = presenceByOwner.get(row.answeringOwnerId)?.lastActiveAt;
          const activeMs = lastActiveAt == null ? Number.NaN : Date.parse(String(lastActiveAt));
          const sessionState = verdicts.get(row.answeringOwnerId)?.sessionState;
          const terminalAfterRoute = DEAD_RESPONDER_STATES.has(sessionState ?? '');
          const reparkedAfterRoute =
            sessionState === 'parked' && Number.isFinite(activeMs) && activeMs > routedMs;
          const inactivePastPickupWindow =
            (sessionState === 'live' || sessionState === 'parked') &&
            Number.isFinite(checkedAtMs) &&
            checkedAtMs - routedMs >= HARD_BLOCKED_EXPIRY_MS;
          if (!terminalAfterRoute && !reparkedAfterRoute && !inactivePastPickupWindow) return;
        }

        const store = getStore(row.workspaceId);
        const thread = await store.getThreadByParent({ kind: 'conversation', ref: row.conversationId });
        const history = thread == null
          ? { total: 0, posts: [] as Array<{ author_id: string | null }> }
          : await store.listRecentPosts(thread.thread_id, SILENT_THREAD_POST_LIMIT);
        if (history.total === 0) {
          silent.add(row.conversationId);
        } else if (
          row.answeringOwnerId === null &&
          history.total <= SILENT_THREAD_POST_LIMIT &&
          history.posts?.length === history.total &&
          history.posts.every((post) => post.author_id != null && row.priorResponderIds?.includes(post.author_id))
        ) {
          // A prior selectee's decline caused this route. Its post is not a
          // pickup by the unstamped current selection.
          silent.add(row.conversationId);
        }
      }),
    );
    return silent;
  };
}

/** Condition-key namespace for a review consult converted to pullable work (P-014). */
export const REVIEW_CONSULT_CONDITION_NAMESPACE = 'review-consult:v1';

/** What this module needs from `upsertConditionWorkItem` (condition-upsert.ts). */
export type ConditionWorkItemUpserter = (
  conditionKey: string,
  input: {
    kind: 'task';
    title: string;
    summary: string;
    harness?: string;
    workspaceId: string;
    createdBy: string;
    payload: Record<string, unknown>;
  },
) => Promise<{ id: string | null }>;

export interface ReviewWorkItemFilerDeps {
  upsert: ConditionWorkItemUpserter;
  /** The harness whose claimable backlog should carry the item when the consult's
   * routing does not name one (a vetting consult opened without a harness). */
  resolveHarness: (workspaceId: string, conversationId: string) => Promise<string | null>;
}

const REVIEW_SUMMARY_QUESTION_CAP = 4000;

/**
 * P-014 (review-system-rework-reduction-2026-09-23, spec RSR-P-014-A): file the
 * pullable review work item for a silent review consult.
 *
 * What this adapter decides:
 *   - IDENTITY. The condition key is per conversation, so a retry on a later tick
 *     adopts the same row instead of filing a sibling (migration 741's unique index
 *     makes that race-proof). An acceptance-grading consult already has a durable
 *     review-target reservation (`routing.cascade.reservation`); the adapter files
 *     under THAT key so the reservation itself becomes the pullable item, with its
 *     canonical title kept, rather than a second row competing with it.
 *   - HARNESS. `work_items:claimable` is per harness, so an item with no harness
 *     is never pulled. The routing snapshot's harness wins, then the resolver
 *     (conversation harness, then the workspace's home pot).
 *   - CLAIMABILITY. kind 'task', unassigned, in the open state — the shape the
 *     claimable backlog serves. Rigor is unchanged: scorecards:emit still refuses
 *     a critique by the emitter or the rubric author, and grader eligibility still
 *     excludes the plan's implementers, whoever claims the item.
 */
export function consultExpiryFileReviewWorkItem(
  deps: ReviewWorkItemFilerDeps,
): NonNullable<ExpirySweepDeps['fileReviewWorkItem']> {
  return async (req) => {
    const cascade = readCascadeBlock(req.routing);
    const reservationKey =
      req.kind === 'acceptance-grading' && typeof cascade?.reservation?.conditionKey === 'string'
        ? cascade.reservation.conditionKey
        : null;
    const conditionKey = reservationKey ?? `${REVIEW_CONSULT_CONDITION_NAMESPACE}:${req.conversationId}`;
    const harness =
      (typeof cascade?.harnessSlug === 'string' && cascade.harnessSlug) ||
      (await deps.resolveHarness(req.workspaceId, req.conversationId).catch(() => null)) ||
      undefined;

    const question = req.question.length > REVIEW_SUMMARY_QUESTION_CAP
      ? `${req.question.slice(0, REVIEW_SUMMARY_QUESTION_CAP)}…`
      : req.question;
    const title = reservationKey && typeof cascade?.planSlug === 'string' && typeof cascade?.rubricId === 'string'
      ? `Acceptance review-target reservation — ${cascade.planSlug} (${cascade.rubricId})`
      : `Review needed (${req.kind}) — ${firstLine(req.question, 110)}`;
    const summary =
      `PULLABLE REVIEW (review-system-rework-reduction-2026-09-23 P-014). Consult ${req.conversationId} ` +
      `(${req.kind}) had no reviewer exchange at half its window, so instead of cascading to another ` +
      `responder it was converted to this work item. Requester: ${req.requesterId}; silent selectee: ` +
      `${req.silentResponderId ?? '(none)'}. You may take it unless you are the requester, the rubric's ` +
      `author, or an implementer of the subject plan — the emit gates refuse those parties anyway. ` +
      reviewInstructions(req.kind) +
      `\n\nOriginal request:\n${question}`;

    const result = await deps.upsert(conditionKey, {
      kind: 'task',
      title,
      summary,
      ...(harness ? { harness } : {}),
      workspaceId: req.workspaceId,
      createdBy: CONSULT_EXPIRY_SWEEP_OWNER_ID,
      payload: {
        reviewConsult: {
          conversationId: req.conversationId,
          kind: req.kind,
          requesterId: req.requesterId,
          silentResponderId: req.silentResponderId,
        },
      },
    });
    if (!result.id) throw new Error(`review work item upsert returned no id for ${conditionKey}`);
    return { id: result.id };
  };
}

function reviewInstructions(kind: ReviewWorkItemRequestKind): string {
  if (kind === 'rubric-vetting') {
    return (
      'To review: claim this item, read the rubric named below, and post your critique with ' +
      'work_items:comment on THIS item. The rubric author then records vetting with ' +
      "scorecards:emit { vettingWorkItem: '<this id>' }; your comment is the third-party critique it requires."
    );
  }
  if (kind === 'acceptance-grading') {
    return (
      'To review: claim this item and grade the rubric with scorecards:emit, with concrete evidence per ' +
      'criterion, following the request below.'
    );
  }
  return (
    'To review: claim this item and emit the single terminal grading-integrity audit described below ' +
    'with scorecards:emit.'
  );
}

type ReviewWorkItemRequestKind = Parameters<NonNullable<ExpirySweepDeps['fileReviewWorkItem']>>[0]['kind'];

function readCascadeBlock(routing: unknown): {
  harnessSlug?: unknown;
  planSlug?: unknown;
  rubricId?: unknown;
  reservation?: { conditionKey?: unknown } | null;
} | null {
  let snap = routing;
  if (typeof snap === 'string') {
    try {
      snap = JSON.parse(snap);
    } catch {
      return null;
    }
  }
  const block = (snap as { cascade?: unknown } | null)?.cascade;
  return block && typeof block === 'object' ? (block as ReturnType<typeof readCascadeBlock>) : null;
}

function firstLine(text: string, cap: number): string {
  const line = text.split('\n').find((l) => l.trim().length > 0)?.trim() ?? '(no question text)';
  return line.length > cap ? `${line.slice(0, cap)}…` : line;
}

/** The task-manager seams {@link consultExpiryStopAnsweringSession} needs, declared structurally. */
export interface AnsweringSessionTaskSeams {
  listLiveTasks: (workspaceId: string) => Promise<readonly Pick<TaskRow, 'taskId' | 'class' | 'detail'>[]>;
  killTask: (taskId: string) => Promise<{ ok: boolean; error?: string; detail?: string }>;
}

/**
 * P-003 (WI-10003199): the production `stopAnsweringSession` — kill the ledger task
 * of the answering session a consult slot launched.
 *
 * It matches ONLY rows consult-dispatch tagged `consultAnswer` for THIS conversation,
 * then the slot: by the expert it answers for (`sourceOwnerId`), or by the
 * `answeringOwnerId` stamp on a row tagged before `sourceOwnerId` was recorded. It
 * never matches by owner id alone: a convert continues the expert's own identity,
 * so an owner-keyed stop could hit the expert's live session. Legacy rows with no
 * conversation id are left to the task reaper. Never throws.
 */
export function consultExpiryStopAnsweringSession(
  seams: AnsweringSessionTaskSeams,
): NonNullable<ExpirySweepDeps['stopAnsweringSession']> {
  return async ({ workspaceId, conversationId, answeringOwnerId, sourceOwnerId }) => {
    try {
      const matches = (await seams.listLiveTasks(workspaceId)).filter((row) => {
        if (row.class !== 'agent-session') return false;
        const facts = consultAnswerFacts(row);
        if (!facts || facts.conversationId !== conversationId) return false;
        if (facts.sourceOwnerId) return facts.sourceOwnerId === sourceOwnerId;
        return answeringOwnerId != null && facts.answeringOwnerId === answeringOwnerId;
      });
      if (matches.length === 0) return 'no live answering session found';
      const outcomes: string[] = [];
      for (const row of matches) {
        try {
          const o = await seams.killTask(row.taskId);
          outcomes.push(
            o.ok
              ? `stopped task ${row.taskId}`
              : o.error === 'already_gone'
                ? `task ${row.taskId} already gone`
                : `stop of task ${row.taskId} refused: ${o.error ?? 'unknown'}`,
          );
        } catch (e) {
          outcomes.push(`stop of task ${row.taskId} threw: ${(e as Error)?.message ?? String(e)}`);
        }
      }
      return outcomes.join('; ');
    } catch (e) {
      return `answering-session lookup failed: ${(e as Error)?.message ?? String(e)}`;
    }
  };
}
