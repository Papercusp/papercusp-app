/**
 * plans:ratify-decision — mark an existing D-NNN decision RATIFIED
 * (queen-autonomy-policy-2026-06-13 B-04/P-015 action-surface coverage
 * refinement, EI-458).
 *
 * `plans:add-decision` AUTHORS a decision; until now there was no distinct
 * verb to RATIFY one — ratification was encoded as free prose in the body
 * ("RATIFIED by owner"), so the Queen (or any agent) could not distinguish
 * "propose a decision" from "ratify it" as separate, governable actions
 * (action-surface.ts: `plan.ratify-decision`, coverage was `partial`).
 *
 * This is a thin, additive verb: it locates the decision's existing body
 * (reusing the exact block-boundary splice `plans:set-decision-body` already
 * uses — no new parsing logic) and appends one `Ratified: <by> on <date>`
 * line, preserving everything already there. Idempotent: a decision that
 * already carries a `Ratified:` line is reported `already_ratified: true`
 * and left untouched (never double-stamped).
 *
 * `authority: 'owner'` on the action-surface row means the AUTONOMY GATE
 * still requires the owner to ratify by right (D-002) — this tool only makes
 * that ratification a first-class, ledgered, Queen-accessible action instead
 * of a plans:edit string-replace.
 */

import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { resolveCtxHarnessSlug } from './_ctx-opts';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { withPlanLock, bumpUpdatedDate } from './with-plan-lock';
import { parsePlan, type LegacyReason } from './parser';
import { setDecisionBodyInBody } from './set-decision-body';
import { emitPlanEventForCaller } from '../coordination/plan-events';
import { planRevisionCapture, type PlanRevisionCtx } from './revisions';
import { resolveAgentIdentity } from '../coordination/identity';
import { softText, LIMITS } from '../limits';

/** Detects an existing ratification stamp so a repeat call is a safe no-op. */
const RATIFIED_LINE_RE = /^\s*Ratified:/im;

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Pure: append a `Ratified: <by> on <date>` line to a decision's body,
 * preserving the head line, the `Date:` line, and everything already in the
 * body (refs included). No-op (alreadyRatified:true) when the body already
 * carries a `Ratified:` line. `found:false` when the decision id doesn't
 * exist in `body` (body returned unchanged). Exported for tests.
 */
export function ratifyDecisionInBody(
  body: string,
  decisionId: string,
  ratifiedBy: string,
  ratifiedOn: string = todayISO(),
): { newBody: string; found: boolean; alreadyRatified: boolean } {
  const parsed = parsePlan(body);
  const decision = parsed.decisions.find((d) => d.id === decisionId);
  if (!decision) return { newBody: body, found: false, alreadyRatified: false };

  // decision.body includes the leading `Date:` line (the parser doesn't strip
  // it) — set-decision-body's own splice re-emits Date separately, so strip it
  // here the same way set-decision-body.ts computes its `oldBody` transparency
  // field, to avoid doubling it.
  const rest = decision.body.replace(/^\s*Date:[^\n]*\n?/i, '').trim();

  if (RATIFIED_LINE_RE.test(rest)) {
    return { newBody: body, found: true, alreadyRatified: true };
  }

  const stamped = `${rest}\nRatified: ${ratifiedBy} on ${ratifiedOn}`;
  const { newBody, found } = setDecisionBodyInBody(body, decisionId, stamped, decision.date);
  return { newBody, found, alreadyRatified: false };
}

const argsSchema = z.object({
  harness: harnessArg,
  slug: z.string().min(1).describe('Plan slug (filename stem).'),
  decisionId: z.string().regex(/^D-\d{3,}$/, 'D-NNN form required'),
  by: z
    .string()
    .min(1)
    .optional()
    .describe('Who is ratifying (a name/handle) — defaults to the calling identity\'s owner label.'),
  rationale: softText(LIMITS.ANNOTATION)
    .optional()
    .describe('Optional — why now / any caveat on the ratification. Stored on the plan revision (D-009).'),
});

type RatifyDecisionValue =
  | { ok: true; decisionId: string; slug: string; alreadyRatified: boolean }
  | {
      ok: false;
      code: 'not_found' | 'legacy_plan' | 'decision_not_found';
      reason?: LegacyReason;
    };

const text = (payload: Record<string, unknown>, isError = false) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
  ...(isError ? { isError: true as const } : {}),
});

export default defineTool({
  name: 'plans:ratify-decision',
  description:
    'Mark an existing D-NNN decision RATIFIED — appends a `Ratified: <by> on <date>` line to the decision body (preserving the head, Date, and existing content), instead of hand-editing prose. Idempotent: already-ratified is reported, never double-stamped. Distinct from plans:add-decision (which AUTHORS a decision) so "propose" and "ratify" are separately governable actions.',
  guidance: {
    when:
      'A D-NNN decision has been reviewed and accepted (by the owner, or an agent ratifying on their behalf) and that acceptance should be a ledgered, queryable fact — not just prose someone typed into the body.',
    notWhen:
      'Recording a NEW decision — plans:add-decision. Changing the substance of a decision\'s body — plans:set-decision-body (do that BEFORE ratifying).',
    chaining: 'plans:add-decision → (review) → plans:ratify-decision { slug, decisionId }.',
    seeAlso: [
      'plans:add-decision (author a NEW decision)',
      'plans:set-decision-body (edit a decision\'s substance)',
      'plans:get (read the decision to confirm ratification)',
    ],
  },
  capability: 'plans:write',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    const sctx = harnessScopedCtx(args.harness, ctx);
    const harnessSlug = resolveCtxHarnessSlug(sctx);
    const identity = resolveAgentIdentity(ctx);
    const by = args.by ?? identity.ownerLabel ?? identity.ownerId;
    const rev = planRevisionCapture(
      ctx as PlanRevisionCtx,
      args.slug,
      args.rationale,
      harnessSlug ? { harnessSlug } : {},
    );

    const result = await withPlanLock<RatifyDecisionValue>(
      ctx as never,
      {
        slug: args.slug,
        intent: `plans:ratify-decision ${args.decisionId}`,
        ...(harnessSlug ? { harnessSlug } : {}),
        afterWrite: rev.afterWrite,
      },
      async (current): Promise<{ newBody: string | null; value: RatifyDecisionValue }> => {
        if (current === null) return { newBody: null, value: { ok: false, code: 'not_found' } };
        const parsed = parsePlan(current, { filePath: args.slug + '.md' });
        if (parsed.isLegacy) {
          return {
            newBody: null,
            value: { ok: false, code: 'legacy_plan', reason: parsed.legacyReason ?? undefined },
          };
        }
        if (!parsed.decisions.some((d) => d.id === args.decisionId)) {
          return { newBody: null, value: { ok: false, code: 'decision_not_found' } };
        }

        const { newBody, found, alreadyRatified } = ratifyDecisionInBody(current, args.decisionId, by);
        if (!found) return { newBody: null, value: { ok: false, code: 'decision_not_found' } };
        if (alreadyRatified) {
          // A no-op write still needs SOME newBody for withPlanLock's contract;
          // pass `current` unchanged rather than skip the lock (keeps the
          // already-ratified check race-free against a concurrent ratify).
          return {
            newBody: null,
            value: { ok: true, decisionId: args.decisionId, slug: args.slug, alreadyRatified: true },
          };
        }
        return {
          newBody: bumpUpdatedDate(newBody),
          value: { ok: true, decisionId: args.decisionId, slug: args.slug, alreadyRatified: false },
        };
      },
    );

    if (result.kind === 'busy') {
      return text(
        {
          error: 'busy',
          busy: result.busy.map((b) => ({
            path: b.path,
            owner_label: b.owner_label,
            intent: b.intent,
            expires_ts: b.expires_ts,
          })),
        },
        true,
      );
    }

    if (!result.value.ok) {
      return text(
        {
          error: result.value.code,
          slug: args.slug,
          decisionId: args.decisionId,
          ...(result.value.reason ? { reason: result.value.reason } : {}),
        },
        true,
      );
    }

    if (!result.value.alreadyRatified) {
      await emitPlanEventForCaller(ctx, {
        planSlug: args.slug,
        event: 'decision_ratified',
        detail: args.decisionId,
        after: by,
      });
    }

    return text({
      ...result.value,
      by,
      filePath: result.filePath,
      revision: rev.recorded.current ? { seq: rev.recorded.current.seq } : null,
    });
  },
});
