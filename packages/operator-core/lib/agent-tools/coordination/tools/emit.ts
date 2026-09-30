/**
 * coord:emit — the canonical LIFECYCLE-emission endpoint
 * (coord-lifecycle-automation-2026-06-04).
 *
 * This is the fire-target the auto-emit event rules invoke (D-003/D-004): a
 * work_item completing, a claim, a coordination-window opening — each transition
 * fires `coord:emit` with the already-rendered `{ summary, body }` from the
 * pure lifecycle render layer (../../coord-lifecycle/render). Agents do NOT
 * author these; the system reacts and emits them, so an agent spends zero
 * tokens narrating predictable lifecycle.
 *
 * It is a sibling of `coord:send`, deliberately SEPARATE:
 *   - `coord:send` carries the genuinely-contextual ~5% an agent writes by hand.
 *   - `coord:emit` carries the predictable lifecycle the engine emits.
 * Every emission is stamped `auto: true` + `lifecycle: '<category>'` on the
 * envelope so `coord:inbox` can treat lifecycle as signal (group / format it)
 * distinctly from human-authored coord traffic — the "inbox becomes signal,
 * not noise" goal (D-005). NOT marked as an ambient `category` (which would
 * exclude it from the inbox) — lifecycle IS the signal.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { withDbCallDeadline, DEFAULT_DB_CALL_DEADLINE_MS } from '@papercusp/db-org';
import { resolveAgentIdentity } from '../identity';
import { sendMessage } from '../messages';
import { COORD_ROLES } from '../roles';
import { goalRefSchema } from '../../../agent-goal-ref';

/**
 * EI-21862403163570302: `work_items:complete` fires `coord:emit` as its
 * INTRINSIC lifecycle broadcast (D-002/D-004) and this was the one
 * `sendMessage()` call site left unbounded when EI-21860312102671987 fixed
 * `coord:send`'s (tools/send.ts's `sendOne`) — so a saturated/wedged
 * `coord_event_log` write here silently hung `work_items:complete` itself
 * past its own transport timeout, indistinguishable from "the DB is down"
 * while ordinary reads stayed instant. Same fix, same reasoning: bound the
 * whole call so a stuck persist throws a decisive `DbCallDeadlineError`
 * instead of hanging forever; the underlying call is not cancelled, so
 * nothing about the actual persist changes, only how long the caller waits
 * on it. */
export const COORD_EMIT_DB_DEADLINE_MS = DEFAULT_DB_CALL_DEADLINE_MS;

export default defineTool({
  name: 'coord:emit',
  description:
    'Emit a structured LIFECYCLE coordination notification (completion / claim / window / handoff / finding). The system fires this automatically from lifecycle events; agents rarely call it directly — use coord:send for unpredictable, contextual messages.',
  guidance: {
    when: 'Almost never directly — the event-reaction rules fire coord:emit automatically when a work_item completes/claims, a coordination-window opens/closes, etc. Call it by hand ONLY to emit a recognized-shape lifecycle event the rules do not yet cover.',
    notWhen:
      "For a genuinely contextual message (a finding's nuance, a design call, a question, a hand-written status), use coord:send — that is the unpredictable residual coord:emit deliberately does NOT carry.",
    chaining:
      'The lifecycle rules render the payload via the coord-lifecycle render layer, then fire this. Pair with coord:inbox to see emitted lifecycle.',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    /** Lifecycle category — 'completion'|'claim'|'window'|'handoff'|'finding' by
     *  convention (open for the P3 long-tail). Stamped on the envelope. */
    category: z.string().min(1),
    /** The rendered one-line summary (the inbox headline). */
    summary: z.string().min(1),
    /** The rendered detail body. */
    body: z.string().optional(),
    /** Recipients — may be concrete ownerIds, `'*'` (broadcast), `'human'`, OR
     *  audience selectors that sendMessage expands to the watching ownerIds:
     *  `@plan:`/`@topic:`/`@object:`/`@file:` (coord-emit-subscription-scoping-2026-06-05)
     *  and `@fleet:<slug>` (the live members of a named fleet — membership IS the
     *  subscription, no tool call) / `@fleet-leader:<slug>` (escalate to the fleet's
     *  lead). Whatever selector you use is ALSO preserved as the message's audience
     *  KEY, so a member can later catch up on it via coord:catch-up.
     *  Omitted ⇒ broadcast `['*']` (legacy hand-call behavior). An explicit `[]`
     *  (or a selector that resolves to nobody) ⇒ record the lifecycle row but
     *  deliver to no inbox (D-004) — so it must be allowed through, hence no min. */
    to: z.array(z.string().min(1)).default(['*']),
    plan_slug: z.string().optional(),
    /** Chain to a prior message (e.g. a window 'done' referencing its 'open'). */
    related_msg_id: z.string().optional(),
    /** Typed goal refs explicitly covered by an intent lifecycle event. */
    declared_goal_refs: z
      .array(goalRefSchema)
      .min(1)
      .max(40)
      .optional(),
    /** Typed P-NNN plan-lane items explicitly covered by an intent lifecycle event. */
    declared_plan_items: z
      .array(z.string().regex(/^P-\d{3,}$/, 'plan item ref required'))
      .min(1)
      .max(40)
      .optional(),
  }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const ctxHarness = (ctx as { harnessSlug?: unknown }).harnessSlug;
    const harnessSlug = typeof ctxHarness === 'string' && ctxHarness && ctxHarness !== '*' ? ctxHarness : undefined;
    const env = await withDbCallDeadline(
      sendMessage(identity, {
        to: args.to,
        summary: args.summary,
        body: args.body,
        plan_slug: args.plan_slug,
        related_msg_id: args.related_msg_id,
        ...(harnessSlug ? { harnessSlug } : {}),
        // The lifecycle markers — visible signal, not an excluded ambient category.
        extra: {
          auto: true,
          lifecycle: args.category,
          ...(args.declared_goal_refs ? { declared_goal_refs: args.declared_goal_refs } : {}),
          ...(args.declared_plan_items ? { declared_plan_items: args.declared_plan_items } : {}),
        },
      }),
      { ms: COORD_EMIT_DB_DEADLINE_MS, label: 'coord:emit.sendMessage' },
    );
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ ok: true, msg_id: env.msg_id, ts: env.ts, lifecycle: args.category }),
        },
      ],
    };
  },
});
