/**
 * Coord-op interface + context (`coordination-ops-as-blueprint-primitives-
 * 2026-06-04` P-001 / D-001 / D-003).
 *
 * A **coord op** is the uniform primitive the coordination layer is generalized
 * into: a typed `(args, ctx) → result` with an args/result Zod schema. The same
 * op is usable two ways (D-001, "one implementation, two surfaces"):
 *
 *   1. **directly by an agent** — wrapped as a `defineTool` (the tool's `args` IS
 *      the op's `argsSchema`; the handler resolves a ctx and calls `op.run`).
 *   2. **as a blueprint spine step** — the durable `coordProgramWorkflow` looks
 *      the op up in the registry, validates the interpolated step args against
 *      `argsSchema`, runs it as a checkpointed DBOS step, and binds the result.
 *
 * The op `run` is side-effectful (it touches the coordination substrate) but its
 * substrate access is funnelled through `ctx.caps` — a small capability bag wired
 * to the prod singletons in `prod-caps.ts` (conversations, escalations, the agent
 * spawn runner) or to test doubles in unit tests. That DI is what makes every op
 * + the program executor unit-testable without PG or real agent spawns.
 */
import type { ZodType } from 'zod';

// The program outcome shape is the generic step-program runner's
// (`@papercusp/step-program`) — imported for local use (CoordOpCaps.runProgram)
// and re-exported so coord-op consumers keep one type.
import type { ProgramOutcome } from '@papercusp/step-program';
import type { InterestAutoArmHandle } from '../interest-auto-arm.js';
import type { ConversationProducer } from '../agent-tools/coordination/conversations-store.js';
export type { ProgramOutcome };

/** A thread post as the collect/aggregate ops consume it (a slim ThreadPostRow). */
export interface CollectedPost {
  id: number;
  author_id: string | null;
  body: string;
  created_ts: string;
}

/** One resolved agent to spawn (spawn-roles expands per-lens / counts into these). */
export interface ResolvedSpawn {
  role: string;
  /** The context injected into the agent run (question, options, thread, lens, …). */
  inject: Record<string, unknown>;
  /**
   * The program blueprint this role belongs to (e.g. 'vote'). Lets the spawn
   * runner tell `invoke()` where to find the role's prompt — program-blueprint
   * roles (`voter`/`advocate`) live at `blueprints/<blueprintId>/prompts/<role>.md`,
   * not the global `prompts/<role>.md`. Set from `ctx.blueprintId` (stamped by the
   * program runner). Omitted for a non-program spawn.
   */
  blueprintId?: string;
}

export interface SpawnRolesResult {
  spawned: { role: string; inject: Record<string, unknown>; ok: boolean }[];
  launched: number;
}

/** Inputs for the program-recursion capability (coord:vote inside deliberate). */
export interface RunProgramInput {
  blueprintId: string;
  payload: Record<string, unknown>;
  /** Composition depth — the parent ctx's depth + 1 (D-008 recursion guard). */
  depth: number;
  callerId?: string;
}

/**
 * The capability bag an op's `run` uses to touch the coordination substrate.
 * Wired to prod singletons (prod-caps.ts) or test doubles. Each capability is the
 * narrow seam onto exactly one shipped primitive (D-004: wrap, don't rebuild).
 */
export interface CoordOpCaps {
  /** Open a thread (a conversation thread). Wraps `conversations.openConversation`. */
  openThread(input: {
    title?: string;
    body?: string;
    kind?: 'question' | 'discussion';
    topics?: string[];
    harness?: string;
    /** Which tool this thread is being opened BY (EI-21462599108204160).
     *  Threaded through the capability rather than hardcoded in prod-caps
     *  because more than one op opens threads through this same seam — the
     *  owner ask (`coord:ask-owner`) and `coord:thread-open` are not the
     *  same producer, and only the op knows which it is. */
    producer: ConversationProducer;
    /** Replace an open owner ask instead of creating a second live gate. */
    supersedes_conversation_id?: string;
  }): Promise<{ thread_id: string; conversation_id: string; interest_watch?: InterestAutoArmHandle }>;

  /** Post to a thread. Wraps `conversations.postReply` / `answerQuestion`. */
  postThread(input: {
    conversation_id: string;
    body: string;
    isAnswer?: boolean;
  }): Promise<{ post_id: number }>;

  /** Read all posts on a thread. Wraps `conversations.getConversation().posts`. */
  listPosts(conversationId: string): Promise<CollectedPost[]>;

  /**
   * Read whether a question thread has been answered — the accepted answer, or
   * the latest reply by someone other than the asker. Powers `coord:ask`'s wait
   * for the owner (the first rung of the deliberate ladder).
   */
  readAnswer(input: {
    conversationId: string;
    askerId: string;
  }): Promise<{ answered: boolean; answer: string | null }>;

  /** Spawn role agents (one per resolved spec), inject context, await completion. */
  spawnRoles(specs: ResolvedSpawn[]): Promise<SpawnRolesResult>;

  /** Open an escalation to the human. Wraps `coord:escalate` / `openEscalation`. */
  escalate(input: {
    severity: 'blocker' | 'question' | 'advisory';
    summary: string;
    body?: string;
    options?: { id: string; label: string }[];
    plan_slug?: string;
    /**
     * Domain-free extras bag, spread FLAT onto the escalation envelope by
     * `openEscalation`. Used by `askOp` to stamp the `conversationId` of the
     * question thread this escalation is the Decision-tier twin of, so
     * answering the conversation clears the escalation too
     * (attention/conversation-escalation-link.ts). Never read by dedup —
     * `escalationDedupIdentity` consults only subjectSignature/dedupKind.
     */
    meta?: Record<string, unknown>;
  }): Promise<{ msg_id: string }>;

  /** Subscribe an owner to a topic/object (the subscribe→inject substrate). */
  subscribe(input: {
    target_kind: 'topic' | 'object';
    target_ref: string;
    mode?: 'full' | 'digest' | 'mention';
  }): Promise<{ ok: true }>;

  /** Inject/notify the caller (resolve's caller-inject). Best-effort. */
  notify(input: { to: string[]; summary: string; body?: string }): Promise<void>;

  /** Run a sub-blueprint program (coord:vote/coord:deliberate recursion, D-008). */
  runProgram(input: RunProgramInput): Promise<ProgramOutcome>;

  /** Sleep (collect's poll interval). Injectable so tests resolve instantly. */
  sleep(ms: number): Promise<void>;
}

/** The execution context handed to every op. */
export interface CoordOpCtx {
  identity: { ownerId: string; ownerLabel?: string };
  workspaceId?: string;
  harnessSlug?: string;
  /** The decision work-item this program is resolving (resolve / escalate ref). */
  workItemId?: string;
  /**
   * The blueprint id of the program currently executing (stamped by
   * `runProgramCore` from `bp.id`). The `orchestrator:spawn-roles` op reads it so a
   * spawned program role resolves its prompt from the OWNING blueprint's
   * `blueprints/<blueprintId>/prompts/<role>.md` (forkable-blueprint design, D-006).
   */
  blueprintId?: string;
  /** The owner who invoked the program (resolve notifies them). */
  callerId?: string;
  /** Composition depth (recursion guard — D-008). 0 for a top-level invocation. */
  depth: number;
  now: () => string;
  newId: (prefix: string) => string;
  caps: CoordOpCaps;
  log?: (msg: string) => void;
}

/**
 * A coordination operation — the composable primitive (D-001). `argsSchema` /
 * `resultSchema` make it typed + projectable onto the tool + spine-step surfaces;
 * `run` is the single implementation both surfaces share.
 */
export interface CoordOp<A = unknown, R = unknown> {
  /** Registry key, the op name used in a spine step's `op` and the tool name. */
  name: string;
  /** One-line description (the tool's guidance + the registry listing). */
  description: string;
  argsSchema: ZodType<A>;
  resultSchema: ZodType<R>;
  /** The roles allowed to call this op as a direct tool (defaults to COORD_ROLES). */
  agentRoles?: readonly string[];
  run(args: A, ctx: CoordOpCtx): Promise<R>;
}
