/**
 * plans:set-now — replace the `## Now` block atomically.
 *
 * Per agent-plan-tracking-2026-05-20.md §4.2.
 *
 * The Now block is the cold-resume anchor. This verb rewrites just the
 * state+next pair, preserving the surrounding plan body.
 *
 * Tolerant heading match: any `## Now` (or `## 3. Now`, etc.) is found
 * and replaced. If no Now block exists, one is inserted directly after
 * the closing frontmatter `---` block, before the first body content.
 *
 * Writes inside a lock. Auto-bumps frontmatter updated:.
 */

import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { resolveCtxHarnessSlug } from './_ctx-opts';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { withPlanLock, bumpUpdatedDate } from './with-plan-lock';
import { maskFences, parsePlan } from './parser';
import {
  detectNowItemContradictions,
  detectNowItemOmissions,
  type NowItemContradiction,
  type NowItemOmission,
} from './now-item-contradictions';
import { emitPlanEventForCaller } from '../coordination/plan-events';
import { planRevisionCapture, type PlanRevisionCtx } from './revisions';
import { bulkContent, mergeIds, runBulk } from '../_bulk';
import { softText, clampText } from '../limits';
import {
  detectEphemeralDeliverableReferences,
  renderEphemeralDeliverableWarning,
} from '../../turn-end-tracking';
import { provenanceLintField } from '../../carry-surface-provenance-lint';

const argsSchema = z.object({
  harness: harnessArg,
  slug: z.string().min(1).optional(),
  slugs: z.array(z.string().min(1)).min(1).max(200).optional().describe('Plan slugs to update with the same Now block in one call.'),
  state: softText(2000, { min: 1 }).describe(
    'One paragraph (≤2000 chars) describing where the plan currently stands. Keep it tight — the Now block is a cold-resume anchor, NOT a log. Auto-truncated to 2000 chars if longer (reported as `clamped`); put long-form detail in the plan body via plans:set-content / set-content-chunk, not here.',
  ),
  next: softText(8000, { min: 1 })
    .describe('One sentence (≤8000 chars) — the single next concrete action and who should do it. Auto-truncated to 8000 chars if longer; multi-step detail belongs in plan items or the body.'),
  rationale: z
    .string()
    .optional()
    .describe(
      'Optional — a short why behind this state change. Stored on the plan revision and shown in the revision timeline (D-009). Routine progress updates can omit it; the launch seed prefers substantive set-content rationales.',
    ),
}).refine((a) => Boolean(a.slug) || (a.slugs?.length ?? 0) > 0, {
  message: 'pass `slug` or `slugs`',
});

/** Explicit result payload so `withPlanLock`'s `T` is fixed by the type
 *  argument, not inferred from a union-returning mutator. */
type SetNowValue =
  | { ok: true }
  | { ok: false; code: 'not_found' }
  | { ok: false; code: 'now_item_status_contradiction'; contradictions: NowItemContradiction[] }
  | { ok: false; code: 'now_item_omission'; omissions: NowItemOmission[] };

export function replaceNowBlock(body: string, state: string, next: string): string {
  const block = `## Now\n\n**State:** ${state.trim()}\n\n**Next:** ${next.trim()}\n`;

  // Tolerant match — accept any "## [N.] Now" heading. The capture runs
  // from just after the heading line to the next `## ` heading OR the
  // end of the document. NOTE: JavaScript regex has no `\Z` anchor —
  // a literal `\Z` matches the character "Z" — so end-of-input must be
  // spelled `(?![\s\S])` ("no character follows"). The earlier `\Z`
  // form truncated the match at the first capital Z in the Now text
  // (corrupting the file), and when the Now block had no following
  // `## ` heading it failed to match at all and got duplicated by the
  // insert branch below.
  const nowRe = /^##\s+(?:\d+(?:\.\d+)?\.\s+)?Now\b[^\n]*\n([\s\S]*?)(?=^##\s|(?![\s\S]))/m;
  // Locate against the fence-masked body so a `## Now` heading inside a
  // worked-example code fence is never matched. m.index / m[0].length
  // are valid against the real body (maskFences preserves length); the
  // splice replaces the whole old block, so any fenced content that was
  // inside it is correctly discarded with it. Index splice rather than
  // body.replace also keeps user-supplied state/next literal.
  const m = nowRe.exec(maskFences(body));
  if (m) {
    return body.slice(0, m.index) + block + '\n' + body.slice(m.index + m[0].length);
  }
  // No Now block: insert after frontmatter close (or at top if none).
  if (body.startsWith('---')) {
    const close = body.indexOf('\n---', 3);
    if (close !== -1) {
      const afterClose = body.indexOf('\n', close + 4);
      const insertAt = afterClose === -1 ? body.length : afterClose + 1;
      return body.slice(0, insertAt) + '\n' + block + '\n' + body.slice(insertAt);
    }
  }
  return block + '\n' + body;
}

/**
 * Pure decision core for plans:set-now. Keeping the contradiction check in
 * the same evaluator used by the handler makes the structured write guard
 * unit-testable without the SU lock side-database.
 */
export function evaluateNowUpdate(
  current: string | null,
  state: string,
  next: string,
  slug: string,
): { newBody: string | null; value: SetNowValue } {
  if (current === null) {
    return { newBody: null, value: { ok: false, code: 'not_found' } };
  }

  const replaced = replaceNowBlock(current, state, next);
  const final = bumpUpdatedDate(replaced);
  const contradictions = detectNowItemContradictions(parsePlan(final, { filePath: `${slug}.md` }));
  if (contradictions.length > 0) {
    return {
      newBody: null,
      value: { ok: false, code: 'now_item_status_contradiction', contradictions },
    };
  }
  const omissions = detectNowItemOmissions(parsePlan(final, { filePath: `${slug}.md` }));
  if (omissions.length > 0) {
    return {
      newBody: null,
      value: { ok: false, code: 'now_item_omission', omissions },
    };
  }
  return { newBody: final, value: { ok: true } };
}

export default defineTool({
  name: 'plans:set-now',
  description:
    "Replace the `## Now` block atomically. The Now block is the cold-resume anchor — the single most-read field, NOT a log: keep State ≤2000 chars + Next ≤800 (both auto-truncate, reported as `clamped`; long-form detail belongs in the plan body via plans:set-content / set-content-chunk). Auto-bumps frontmatter updated:.",
  guidance: {
    when: 'Plan state advances meaningfully — phase boundaries, blocking discovery, finishing a chunk of work, picking up a new direction.',
    notWhen:
      'Per-item flip — that\'s plans:set-status. Or a decision — that\'s plans:add-decision.',
    chaining:
      'plans:set-status to flip current item → plans:set-now reflecting the new state. Keep State ≤2000 chars / Next ≤800 — an overflow auto-truncates (see `clamped`); offload long-form detail to plans:set-content / set-content-chunk.',
    seeAlso: [
      'plans:set-status (flip an item\'s lifecycle, not the narration)',
      'plans:add-decision (record a durable decision, not a now-note)',
      'plans:set-content (offload overflow detail out of the Now)',
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
    // softText `next` + `state` (P-002): never bounced on length — clamp to cap
    // here. `state` was a hardText reject until EI-20020322245949080: the Now
    // block is echoed prose with no downstream bound, so per limits.ts policy it
    // is a soft field, and bouncing it cost a full round-trip per attempt (five
    // in a row, shaving 4-14 chars each). The clamp is REPORTED rather than
    // silent — this is the cold-resume anchor, so a dropped tail must be visible.
    const next = clampText(args.next, 8000);
    const state = clampText(args.state, 2000);
    const clamped = [
      ...(args.state.length > 2000
        ? [{ field: 'state' as const, fromChars: args.state.length, toChars: 2000 }]
        : []),
      ...(args.next.length > 8000
        ? [{ field: 'next' as const, fromChars: args.next.length, toChars: 8000 }]
        : []),
    ];
    const slugs = mergeIds(args.slug, args.slugs);
    const env = await runBulk(
      slugs,
      async (slug) => {
        const rev = planRevisionCapture(
          ctx as PlanRevisionCtx,
          slug,
          args.rationale,
          harnessSlug ? { harnessSlug } : {},
        );
        const result = await withPlanLock<SetNowValue>(
          ctx as never,
          {
            slug,
            intent: `plans:set-now`,
            ...(harnessSlug ? { harnessSlug } : {}),
            afterWrite: rev.afterWrite,
          },
          async (current): Promise<{ newBody: string | null; value: SetNowValue }> =>
            evaluateNowUpdate(current, state, next, slug),
        );

        if (result.kind === 'busy') {
          return {
            ok: false as const,
            slug,
            error: 'busy',
            busy: result.busy.map((b) => ({
              path: b.path,
              owner_label: b.owner_label,
              intent: b.intent,
              expires_ts: b.expires_ts,
            })),
          };
        }

        if (!result.value.ok) {
          return {
            ok: false as const,
            slug,
            error: result.value.code,
            ...(result.value.code === 'now_item_status_contradiction'
              ? { contradictions: result.value.contradictions }
              : result.value.code === 'now_item_omission'
                ? { omissions: result.value.omissions }
              : {}),
          };
        }

        // EI-20268156880922192: a Now block is durable, but it may still point
        // successors at a session-local scratch path or account-local artifact
        // URL that evaporates. Warn after the write succeeds; this guard is
        // deliberately advisory/fail-open so a detector fault never loses the
        // state update it is meant to protect.
        let ephemeralDeliverableWarning: string | undefined;
        try {
          const references = detectEphemeralDeliverableReferences(`${args.state}\n${next}`);
          ephemeralDeliverableWarning = renderEphemeralDeliverableWarning(
            `plans:set-now for ${slug}`,
            references,
          );
        } catch {
          /* fail-open: the Now write already landed */
        }

        // WI-41690 / EI-21459558956325262: the Now block is re-injected verbatim
        // to every future reader as binding context, so an owner-attribution
        // asserted here ("Approved by <owner>") is read as authorization by
        // agents that never saw the conversation. That is the WI-3532
        // telephone-game shape, observed live on
        // llm-agent-evaluation-measurement-integrity-2026-08-25: a self-authored
        // approval line was quoted back as authority by a later session and came
        // one call short of activating a five-item plan.
        //
        // facts:assert, loop:checkpoint, work_items:checkpoint and
        // session:request-compaction already run this same shared lint. The plan
        // Now block was the one carry surface left unguarded — despite having the
        // widest blast radius of the five, since the others are read mainly by
        // their own author and this one is delivered to everyone.
        //
        // Deliberately the SYNC provenanceLintField, not the async
        // carryProvenanceFields the other four use: this runs inside the plan
        // lock, and carryProvenanceFields performs turn-ref IO under a 3s budget.
        // Paying IO inside a held lock to buy ref VERIFICATION is the wrong trade
        // for an advisory detector — the flag and its remedy note are the
        // load-bearing part, and they need no IO.
        //
        // Advisory and fail-open, exactly like the ephemeral guard above: a
        // detector fault must never lose the state update it exists to protect.
        let provenanceLint: ReturnType<typeof provenanceLintField>;
        try {
          provenanceLint = provenanceLintField(`${state}\n${next}`);
        } catch {
          /* fail-open: the Now write already landed */
        }

        await emitPlanEventForCaller(ctx, {
          planSlug: slug,
          event: 'now_updated',
          after: next,
          detail: state.slice(0, 200),
        });

        return {
          ok: true as const,
          slug,
          filePath: result.filePath,
          revision: rev.recorded.current ? { seq: rev.recorded.current.seq } : null,
          ...(result.activationAudit ? { activationAudit: result.activationAudit } : {}),
          ...(ephemeralDeliverableWarning ? { ephemeralDeliverableWarning } : {}),
          ...(provenanceLint ? { provenanceLint } : {}),
          ...(clamped.length ? { clamped } : {}),
        };
      },
      { keyOf: (slug) => ({ slug }) },
    );

    return bulkContent(env);
  },
});
