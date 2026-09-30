/**
 * Composition ops (`coordination-ops-as-blueprint-primitives-2026-06-04` D-006 /
 * D-009) — ops that *run a blueprint program*. These are the "called directly"
 * surface of the seed blueprints (D-009: a complex pattern is one op an agent
 * invokes): `coord:vote` runs the `vote` program, `coord:deliberate` runs the
 * `deliberate` program. They are also how a program composes recursively — the
 * `deliberate` spine's vote step invokes `coord:vote`, bounded by the depth cap
 * (`ctx.depth + 1`, D-008). `coord:ask` is the bare uncertainty-ladder rung (ask
 * the owner, bounded wait) — a simple op (D-009), not a program.
 *
 * The program execution itself is `ctx.caps.runProgram`, wired by the durable
 * `coordProgramWorkflow` (which loads the blueprint, runs its steps + gate as DBOS
 * steps, and returns the outcome). Keeping run-a-program behind a cap means these
 * ops have no DBOS dependency and stay unit-testable.
 */
import { z } from 'zod';
import type { CoordOp } from '../types.js';
import { registerCoordOp } from '../registry.js';
import { conversationLinkMeta } from '../../attention/conversation-escalation-link.js';

// ── coord:vote ────────────────────────────────────────────────────────────────

const voteArgs = z.object({
  question: z.string().min(1),
  options: z.array(z.string()).min(2),
  /** One voter per lens (the diversity defense — D-010). Defaults applied by the blueprint knobs. */
  lenses: z.array(z.string()).optional(),
  quorum: z.number().int().positive().optional(),
  timeout_s: z.number().positive().optional(),
  max_voters: z.number().int().positive().optional(),
  topics: z.array(z.string()).optional(),
  /** The harness whose agents run the voters (the tool handler sets ctx from this). */
  harness: z.string().optional(),
});

const programResult = z.object({
  outcome: z.string(),
  resolved: z.boolean(),
  decision: z.unknown().optional(),
});

export const voteOp: CoordOp<z.infer<typeof voteArgs>, z.infer<typeof programResult>> = {
  name: 'coord:vote',
  description: 'Run a diverse-lens confidence-weighted vote on a decision; resolve decisively or escalate the split.',
  argsSchema: voteArgs,
  resultSchema: programResult,
  async run(a, ctx) {
    const r = await ctx.caps.runProgram({
      blueprintId: 'vote',
      payload: { ...a },
      depth: ctx.depth + 1,
      callerId: ctx.callerId ?? ctx.identity.ownerId,
    });
    return { outcome: r.outcome, resolved: r.resolved, decision: r.decision };
  },
};
registerCoordOp(voteOp);

// ── coord:deliberate (the uncertainty ladder) ──────────────────────────────────

const deliberateArgs = z.object({
  question: z.string().min(1),
  options: z.array(z.string()).min(2),
  lenses: z.array(z.string()).optional(),
  ask_timeout_s: z.number().positive().optional(),
  quorum: z.number().int().positive().optional(),
  timeout_s: z.number().positive().optional(),
  harness: z.string().optional(),
});

export const deliberateOp: CoordOp<z.infer<typeof deliberateArgs>, z.infer<typeof programResult>> = {
  name: 'coord:deliberate',
  description: 'Run the uncertainty ladder: ask the owner → if unresolved, vote → if split, escalate.',
  argsSchema: deliberateArgs,
  resultSchema: programResult,
  async run(a, ctx) {
    const r = await ctx.caps.runProgram({
      blueprintId: 'deliberate',
      payload: { ...a },
      depth: ctx.depth + 1,
      callerId: ctx.callerId ?? ctx.identity.ownerId,
    });
    return { outcome: r.outcome, resolved: r.resolved, decision: r.decision };
  },
};
registerCoordOp(deliberateOp);

// ── coord:ask (bare ask-owner — a simple op, D-009) ─────────────────────────────

// Exported (not just local) so the agent-facing `coord:ask-owner` tool wrapper
// (agent-tools.ts) can build its OWN args schema off the same shape with a
// different `timeout_s` default — see the EI-18682693723293580 note on
// `askOp.run` below for why the tool must not inherit this op's historical
// 120s-blocking default.
export const askArgs = z.object({
  question: z.string().min(1),
  body: z.string().optional(),
  /** Bounded wait for the owner's answer. Used as-is by the `deliberate`/`vote`
   *  blueprint rung (a durable DBOS step, not foreground-time-boxed); the
   *  agent-facing tool overrides this default to 0 (see agent-tools.ts). */
  timeout_s: z.number().nonnegative().default(120),
  poll_ms: z.number().int().positive().default(2000),
  topics: z.array(z.string()).optional(),
  /** Replace a stale/unanswerable owner gate while keeping the replacement a
   *  real conversation and retiring the old gate durably. */
  supersedes_conversation_id: z.string().min(1).optional().describe(
    'When correcting an existing owner ask, pass its conversation_id so the old gate is retracted and this replacement is opened durably.',
  ),
});

const askResult = z.object({
  answered: z.boolean(),
  answer: z.string().nullable(),
  conversation_id: z.string(),
  interest_watch: z.object({
    event_keys: z.array(z.string()),
    await_ids: z.array(z.number().int()),
    cancel: z.object({
      tool: z.literal('events:cancel'),
      args: z.object({ await_ids: z.array(z.number().int()) }),
    }).nullable(),
    handle_note: z.string(),
  }).optional(),
});

const MAX_POLLS = 100_000;

export const askOp: CoordOp<z.infer<typeof askArgs>, z.infer<typeof askResult>> = {
  name: 'coord:ask',
  description: 'Ask the owner a question and wait a bounded time for an answer (the ladder\'s first rung).',
  argsSchema: askArgs,
  resultSchema: askResult,
  async run(a, ctx) {
    const thread = await ctx.caps.openThread({
      title: a.question,
      body: a.body ?? a.question,
      kind: 'question',
      // This op is registered as `coord:ask` but the EXPOSED agent tool is
      // `coord:ask-owner` (coord-ops/agent-tools.ts:101,137) — the user-facing
      // name is what makes the attribution readable, and it is distinct from
      // the agent-to-agent `coord:ask` in tools/ask.ts.
      producer: 'coord:ask-owner',
      topics: a.topics,
      harness: ctx.harnessSlug,
      supersedes_conversation_id: a.supersedes_conversation_id,
    });
    // Land it in the human's inbox so the ask is actually seen. This is the
    // DECISION-tier leg of the ask (escalationToAttention: blocker/question →
    // Decision); the thread above is the Alert-tier leg. `conversationId` links
    // the two so `conversations:resolve` clears BOTH — without it, every
    // question the owner ANSWERED left a permanent zombie in the Decision tier
    // (measured 9 of 11, EI-19399318647145782; see
    // attention/conversation-escalation-link.ts).
    await ctx.caps
      .escalate({
        severity: 'question',
        summary: a.question,
        body: a.body,
        meta: conversationLinkMeta(thread.conversation_id),
      })
      .catch(() => {
        /* best-effort — the thread itself is the durable ask surface */
      });

    const askerId = ctx.identity.ownerId;
    // EI-18682693723293580: `timeout_s: 0` (the agent-facing tool's new default)
    // must mean ZERO polling — a single immediate read, no `sleep` at all —
    // not "at least one 2s poll cycle" (the old `Math.max(1, …)` floor forced
    // that even at timeout_s=0, which is harmless standalone but defeats the
    // whole point of a code:run-safe non-blocking default: a caller that
    // asked for an instant return still paid a guaranteed sleep(poll_ms)).
    const maxPolls =
      a.timeout_s <= 0
        ? 0
        : Math.min(MAX_POLLS, Math.max(1, Math.ceil((a.timeout_s * 1000) / a.poll_ms)));
    let ans = await ctx.caps.readAnswer({ conversationId: thread.conversation_id, askerId });
    for (let poll = 0; poll < maxPolls && !ans.answered; poll++) {
      await ctx.caps.sleep(a.poll_ms);
      ans = await ctx.caps.readAnswer({ conversationId: thread.conversation_id, askerId });
    }
    return {
      answered: ans.answered,
      answer: ans.answer,
      conversation_id: thread.conversation_id,
      ...(thread.interest_watch ? { interest_watch: thread.interest_watch } : {}),
    };
  },
};
registerCoordOp(askOp);
