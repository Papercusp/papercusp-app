/**
 * Dual-surface coord-op tools (`coordination-ops-as-blueprint-primitives-
 * 2026-06-04` D-001 — "one implementation, two surfaces"). Each `defineTool` here
 * projects a registered coord op onto the **agent-callable** surface: the tool's
 * `args` IS the op's `argsSchema`, and the handler resolves an identity, builds a
 * production `CoordOpCtx`, and calls the SAME `op.run` the spine executor calls.
 * So `coord:vote` an agent types and `coord:vote` a `deliberate` spine step both
 * run one implementation.
 *
 * Only the **agent-facing** ops are projected (D-009 — don't over-expose): the
 * decision tools (`coord:vote` / `coord:deliberate` / `coord:ask-owner`) + the voter's
 * `coord:thread-post`. The internal program ops (`coord:collect`,
 * `vote:aggregate`, `orchestrator:spawn-roles`, `resolve`, `coord:subscribe`) stay
 * spine-only; `coord:escalate` already ships as its own coordination tool.
 *
 * The decision tools run the program INLINE (synchronous — the caller awaits the
 * decision). The durable fire-and-forget path is `startCoordProgram`
 * (coord-program-workflow.ts), used by the event-rule trigger.
 */
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../agent-tools/coordination/identity.js';
import { COORD_ROLES } from '../agent-tools/coordination/roles.js';
import { requireCoordOp } from './registry.js';
import { askArgs } from './ops/compose.js';

/**
 * The roles allowed to POST into a vote/deliberate thread: the standard coord
 * roles PLUS the program-spawned `voter` / `advocate` roles (a tool's `agentRoles`
 * gates the caller per dispatch-stack.ts — without these, a spawned voter would be
 * denied `coord:thread-post`).
 */
const COORD_OP_POSTER_ROLES = [...COORD_ROLES, 'voter', 'advocate'] as const;
import { buildCoordOpCtx } from './prod-caps.js';
import type { CoordOpCtx } from './types.js';
import './index.js'; // ensure every op is registered before we wrap it

function jsonText(v: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(v) }] };
}

/** Pipeline roles carry `ctx.harnessSlug`; '*'/empty = operator/SU (no harness). */
function harnessFromCtx(ctx: unknown): string | undefined {
  const h = (ctx as { harnessSlug?: unknown }).harnessSlug;
  return typeof h === 'string' && h && h !== '*' ? h : undefined;
}

/** Build a prod ctx for an agent-initiated op call. */
function ctxFor(opCtxArgs: { rawCtx: unknown; harness?: string }): CoordOpCtx {
  const identity = resolveAgentIdentity(opCtxArgs.rawCtx as Parameters<typeof resolveAgentIdentity>[0]);
  return buildCoordOpCtx({
    identity: { ownerId: identity.ownerId, ownerLabel: identity.ownerLabel },
    workspaceId: identity.workspaceId ?? undefined,
    harnessSlug: opCtxArgs.harness ?? harnessFromCtx(opCtxArgs.rawCtx),
    callerId: identity.ownerId,
  });
}

// ── coord:vote ──────────────────────────────────────────────────────────────
const voteOp = requireCoordOp('coord:vote');
defineTool({
  name: 'coord:vote',
  description:
    'Run a diverse-lens, confidence-weighted vote on a decision and get back a resolution (decisive) or a curated escalation (split). One voter per lens + an advocate arguing against the lead.',
  guidance: {
    when: 'You face a genuinely uncertain, consequential choice between named options and want a diverse, anti-correlated read before committing — instead of deciding alone or escalating raw.',
    notWhen: 'A trivial or reversible choice — just decide. A pure factual lookup — use search/docs. To ask the human directly, use coord:ask-owner / coord:escalate.',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: voteOp.argsSchema,
  async handler(args, ctx) {
    const a = args as { harness?: string };
    const result = await voteOp.run(args, ctxFor({ rawCtx: ctx, harness: a.harness }));
    return jsonText(result);
  },
});

// ── coord:deliberate ──────────────────────────────────────────────────────────
const deliberateOp = requireCoordOp('coord:deliberate');
defineTool({
  name: 'coord:deliberate',
  description:
    'Run the uncertainty ladder on a decision: ask the owner first → if unresolved, run a vote → if the vote is split, escalate a curated summary. The full escalate-only-when-needed flow.',
  guidance: {
    when: 'A consequential decision where the owner might already have an answer, but you want an automatic fallback to a vote and a curated escalation rather than blocking.',
    notWhen: 'You already know the owner has no opinion (go straight to coord:vote) or the choice is trivial (just decide).',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: deliberateOp.argsSchema,
  async handler(args, ctx) {
    const a = args as { harness?: string };
    const result = await deliberateOp.run(args, ctxFor({ rawCtx: ctx, harness: a.harness }));
    return jsonText(result);
  },
});

// ── coord:ask-owner (bare ask-owner — a simple op, D-009) ───────────────────────
// NB: the EXPOSED agent tool is `coord:ask-owner`, distinct from the knowledge-first
// `coord:ask` tool (coordination-conversations D-001 — ask peers, knowledge-first).
// The two are different operations; sharing the `coord:ask` tool name silently
// shadowed the knowledge-first tool (tooldef registry replaces on same
// name+capability), so this owner-ask is exposed under its own name. The internal
// coord-op + the `deliberate` blueprint's `op: coord:ask` rung keep their name —
// that's a separate (blueprint-DSL) namespace the agent never sees.
const askOp = requireCoordOp('coord:ask');
// EI-18682693723293580: the underlying `coord:ask` OP's historical default
// (`timeout_s: 120`, polled every 2s — see compose.ts) is fine for the
// `deliberate`/`vote` blueprint rung, which runs as a durable DBOS step with
// no foreground time budget. It is WRONG for this agent-facing tool: a caller
// inside `code:run` (foreground, ~55s hard cap) that omits `timeout_s` used to
// ALWAYS script_timeout here — the write (open thread + escalate) had already
// landed, but the tool call itself could never return in time, leaving the
// caller holding a live double-post risk with no cheap way to check what
// landed. This tool therefore declares its OWN args schema, identical to the
// op's except `timeout_s` DEFAULTS TO 0 (return immediately after the
// question is opened — no poll loop at all, see the timeout_s<=0 fast path in
// askOp.run). The answer, once given, arrives the normal non-blocking way:
// the asker's inbox, or `events:await { event: 'conversation:answered:<id>' }`
// if they want to block deliberately (that wait belongs to the CALLER's own
// turn/loop, not hidden inside this tool call).
// Exported for the EI-18682693723293580 regression test (agent-tools.test.ts) —
// the tool itself is registered into the PROJECTED tool registry (role-gated,
// `requirePrincipal: false`), which wraps `handler` behind machinery (payload-
// tier shaping, StandardSchema validation, a UnifiedToolContext) a unit test
// has no cheap reason to stand up. Pinning the schema DEFAULT directly is the
// load-bearing assertion; askOp.run's own timeout_s<=0 fast path is covered in
// compose.test.ts.
export const askOwnerArgs = askArgs.extend({
  timeout_s: askArgs.shape.timeout_s.default(0).describe(
    'Seconds to poll for the owner\'s answer before returning (default 0 — return immediately once the question is opened; conversation_id lets you check back later or events:await on conversation:answered:<conversation_id>). Only pass a positive value from an INTERACTIVE (non-code:run) session where you genuinely want this call to block — a foreground code:run script has an ~55s hard cap and WILL script_timeout if this polls anywhere near it.',
  ),
});
defineTool({
  name: 'coord:ask-owner',
  description:
    'Ask the OWNER (the human) a question. By default returns IMMEDIATELY once the question is opened (opens a question thread + lands it in the human inbox) — pass timeout_s > 0 to instead poll and block for that long. Returns { answered, answer, conversation_id }. To correct an existing owner ask, pass supersedes_conversation_id so the old gate is retracted and the replacement remains a real gate. For asking PEERS knowledge-first, use coord:ask instead.',
  guidance: {
    when: 'You need the owner\'s (human\'s) input on a decision. Default call (no timeout_s) opens the question and returns at once with a conversation_id — safe to call from anywhere, including code:run; check back later via conversations:get or events:await { event: \'conversation:answered:<conversation_id>\' }.',
    notWhen:
      'A peer question or a knowledge lookup — use coord:ask (knowledge-first: searches existing knowledge, then routes to topic subscribers). A blocking decision that MUST have a human answer — use coord:escalate (severity: blocker). To retract an old owner ask, use supersedes_conversation_id or conversations:supersede, not a plain coord:send that cannot become a gate. Calling from inside code:run with an explicit timeout_s > 0 — code:run\'s own ~55s foreground cap will fire first and script_timeout the call (the question is still opened by then; do not blindly re-ask — check conversations:get for what already landed).',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: askOwnerArgs,
  async handler(args, ctx) {
    const result = await askOp.run(args, ctxFor({ rawCtx: ctx }));
    return jsonText(result);
  },
});

// ── coord:thread-post (the voter's post surface) ────────────────────────────────
const threadPostOp = requireCoordOp('coord:thread-post');
defineTool({
  name: 'coord:thread-post',
  description:
    'Post a message to a coordination thread by conversation_id (e.g. a spawned voter casting its structured ```vote``` block, or the advocate posting its ```advocate``` objection).',
  guidance: {
    when: 'You were spawned into a vote/deliberation with a CONVERSATION_ID and need to cast your structured vote or objection into that thread.',
    notWhen: 'Replying in an open conversation you joined — use conversations:post. A direct message to an agent — coord:send.',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_OP_POSTER_ROLES],
  args: threadPostOp.argsSchema,
  async handler(args, ctx) {
    const result = await threadPostOp.run(args, ctxFor({ rawCtx: ctx }));
    return jsonText(result);
  },
});
