/**
 * fleet/chat-spawn-tracking — durable nursery rows for agent-chat runs (EI-259).
 *
 * The agent-chats message path (messagesRoute → dispatchProjectedToolStream
 * ('agent_chats:chat')) runs a REAL role-scoped agent but recorded nothing in
 * harness_shared.spawned_agents — chat-driven runs were invisible to fleet:tree,
 * intel:spawn_tree, and spawn-based accounting. This module gives that path the
 * same durable tracking every other invocation path has:
 *
 *   beginChatSpawnTracking → recordSpawn (status 'running', spawn_id
 *     `agent_chats-<chatId>-<uuid8>`, one row PER TURN — a turn is one agent
 *     invocation) → heartbeat on the SPAWN_HEARTBEAT_INTERVAL_MS cadence (a
 *     chat turn can outlive the 5-min orphan-reclaim window) → finish() flips
 *     the row terminal (done | failed | cancelled).
 *
 * Two deliberate semantics:
 *  - Best-effort: a PG hiccup must never break the user's chat — begin returns
 *    null and the chat streams untracked (logged once per failure).
 *  - No admission gate: the chat is interactive UX and is never queued behind
 *    the fleet ceiling, but its 'running' row DOES count toward countRunning —
 *    honest slot accounting, since a chat turn consumes a real provider slot.
 */
import { randomUUID } from 'node:crypto';
import { getOrgPg } from '@papercusp/db-org';
import { lockDomainForProjectDir } from '../agent-tools/locks/coordination-domain';
import { recordSpawnPg, finishSpawnPg, type Db } from './pg-stores';
import { heartbeatSpawns, SPAWN_HEARTBEAT_INTERVAL_MS } from './spawn-reclaim';
import { managedSetInterval } from '@papercusp/scheduled-registry';

export type ChatRunStatus = 'done' | 'failed' | 'cancelled';

/** Everything the stream consumer observed, reduced to one terminal verdict. */
export interface ChatRunOutcomeSignals {
  /** A `kind: 'done'` event arrived (the dispatch completed its protocol). */
  sawDone: boolean;
  /** A `kind: 'error'` tool-level error ended the stream. */
  toolErrorMessage: string | null;
  /** The last in-band `error` event payload, if any. */
  lastErrorMessage: string | null;
  /** The for-await loop threw (transport/dispatch failure). */
  threwMessage: string | null;
  /** The request signal was aborted (client disconnected). */
  aborted: boolean;
}

export function resolveChatRunOutcome(
  s: ChatRunOutcomeSignals,
): { status: ChatRunStatus; errorMessage: string | null } {
  if (s.threwMessage !== null) {
    return s.aborted
      ? { status: 'cancelled', errorMessage: `client disconnected mid-stream: ${s.threwMessage}` }
      : { status: 'failed', errorMessage: s.threwMessage };
  }
  if (s.toolErrorMessage !== null) return { status: 'failed', errorMessage: s.toolErrorMessage };
  if (s.lastErrorMessage !== null) return { status: 'failed', errorMessage: s.lastErrorMessage };
  if (!s.sawDone) {
    return s.aborted
      ? { status: 'cancelled', errorMessage: 'client disconnected before completion' }
      : { status: 'failed', errorMessage: 'stream ended without a completion event' };
  }
  return { status: 'done', errorMessage: null };
}

export interface ChatSpawnHandle {
  spawnId: string;
  /** Flip the row terminal. Idempotent; never throws (best-effort tracking). */
  finish(outcome: {
    status: ChatRunStatus;
    errorMessage?: string | null;
    outputTail?: string | null;
  }): Promise<void>;
}

export interface BeginChatSpawnTrackingInput {
  chatId: string;
  workspaceId: string;
  harnessSlug: string;
  /** The chat's role — the agent actually invoked (worker/validator/…). */
  childRole: string;
  /** The assembled run id (assembleRolePrompt meta.runId) — links row ↔ run. */
  runId: string;
  featureId?: string | null;
  projectDir?: string | null;
  /** Injectable for tests; defaults to the org pool. */
  sql?: Db;
}

/**
 * Hard deadline on the pre-stream nursery insert. "Best-effort" must mean
 * BOUNDED: the messages route awaits this BEFORE opening the SSE response, so
 * a slow/contended PG pool was holding the whole chat turn hostage (observed
 * 15s+ route hangs under fleet load, 2026-06-11). On timeout the chat streams
 * untracked — the same degraded mode as an insert error; a late-landing row
 * stays 'running' and the reclaim sweep reaps it.
 */
const RECORD_SPAWN_DEADLINE_MS = 2_500;

export async function beginChatSpawnTracking(
  input: BeginChatSpawnTrackingInput,
): Promise<ChatSpawnHandle | null> {
  const spawnId = `agent_chats-${input.chatId}-${randomUUID().slice(0, 8)}`;
  let sql: Db;
  try {
    sql = input.sql ?? getOrgPg().sql;
    const insert = recordSpawnPg(sql, {
      spawnId,
      workspaceId: input.workspaceId,
      harnessSlug: input.harnessSlug,
      parentSpawnId: null,
      // The chat surface runs with operator authority; the user drives it.
      parentRole: 'operator',
      childRole: input.childRole,
      runId: input.runId,
      featureId: input.featureId ?? null,
      sessionOwner: spawnId,
      coordinationDomain: input.projectDir ? lockDomainForProjectDir(input.projectDir) : undefined,
      status: 'running',
    });
    const inTime = await Promise.race([
      insert.then(() => true),
      new Promise<false>((r) => setTimeout(r, RECORD_SPAWN_DEADLINE_MS, false)),
    ]);
    if (!inTime) {
      insert.catch(() => { /* late failure of an already-abandoned insert */ });
      console.warn(
        `[chat-spawn-tracking] recordSpawn exceeded ${RECORD_SPAWN_DEADLINE_MS}ms — chat ${input.chatId} streams untracked`,
      );
      return null;
    }
  } catch (err) {
    console.warn(
      `[chat-spawn-tracking] recordSpawn failed — chat ${input.chatId} streams untracked: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }

  const timer = managedSetInterval('chat-spawn-heartbeat', SPAWN_HEARTBEAT_INTERVAL_MS, () => {
    void heartbeatSpawns(sql, [spawnId]).catch(() => {
      /* best-effort — a missed beat only matters if it persists past the
         5-min reclaim window, and the next beat heals it */
    });
  }, { category: 'lifecycle', instanced: true });

  let finished = false;
  return {
    spawnId,
    async finish(outcome) {
      if (finished) return;
      finished = true;
      timer.stop();
      try {
        await finishSpawnPg(sql, {
          spawnId,
          workspaceId: input.workspaceId,
          status: outcome.status,
          errorMessage: outcome.errorMessage ?? null,
          outputTail: outcome.outputTail ?? null,
        });
      } catch (err) {
        console.warn(
          `[chat-spawn-tracking] finishSpawn failed for ${spawnId} (row stays 'running' until the reclaim sweep): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    },
  };
}
