/**
 * plans:set-frontmatter — structured frontmatter writer for legacy
 * plan conversion.
 *
 * agent-plan-tracking Phase 5 (D-011 of plans-admin-ui-2026-05-20).
 *
 * A legacy plan is legacy because it lacks a valid frontmatter block
 * (no `slug:` / `status:`, often no `title:` / `created:`). This verb
 * writes a complete, valid block — converting the plan into a
 * first-class one — without touching the body. It is the structured,
 * safe-by-construction counterpart to `plans:set-content`: legacy
 * conversion is a frontmatter edit, not a whole-document rewrite, so
 * it does NOT route through `set-content`.
 *
 * The name is `set-frontmatter`, not `promote` — `plans:promote` is
 * already a different, unrelated tool (promote a plan into a harness;
 * see `coordination/tools/promote.ts`). See D-011's verb-name
 * correction.
 *
 * Refuses a plan that already has valid frontmatter (`already_valid`)
 * so a real plan's frontmatter — including keys this verb doesn't
 * model, like `supersedes:` — can never be silently clobbered.
 *
 * Writes inside `withPlanLock`.
 */

import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { hardText, LIMITS } from '../limits';
import { resolveCtxHarnessSlug } from './_ctx-opts';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { withPlanLock } from './with-plan-lock';
import { domainFailureMessage } from './plan-activation-gate';
import { parsePlan } from './parser';
import { planRevisionCapture, type PlanRevisionCtx } from './revisions';
import { clearStartedForTerminalPlan, isTerminalPlanStatus, NON_TERMINAL_PLAN_STATUSES } from './plan-start-state';
import { stampTerminalNowBlock } from './terminal-now-stamp';
import { stampGreenlitNowBlock } from './greenlit-now-stamp';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const argsSchema = z.object({
  harness: harnessArg,
  slug: z.string().min(1).describe('Plan slug (filename stem). Written into the frontmatter.'),
  title: hardText(LIMITS.SHORT_TITLE)
    .refine((s) => s.trim().length > 0, 'title cannot be blank')
    .describe('Human-readable plan title.'),
  // Derived from PLAN_STATUSES, not re-listed: this schema carried its own
  // hand-typed copy of the five values, so adding `awaiting-acceptance` to the
  // vocabulary left this one verb silently rejecting it. A second copy of a
  // list the parser already owns is the exact drift this plan removes.
  status: z
    .enum([...NON_TERMINAL_PLAN_STATUSES] as [string, ...string[]])
    .describe('Non-terminal initial status for legacy conversion; terminal transitions belong to plans:set-plan-status.'),
  created: z
    .string()
    .regex(DATE_RE)
    .optional()
    .describe('Creation date (YYYY-MM-DD). Defaults to today when omitted.'),
  owner: z.string().max(200).optional().describe('Plan owner (e.g. an email).'),
  rationale: z
    .string()
    .optional()
    .describe(
      'Optional — a note on this legacy-plan conversion. Stored on the plan revision, not in the frontmatter (D-009).',
    ),
});

/** Collapse internal whitespace + newlines so a value can never break
 *  out of its single frontmatter line. */
function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

export function buildFrontmatter(args: z.infer<typeof argsSchema>, today: string): string {
  const lines = ['---'];
  lines.push(`title: ${oneLine(args.title)}`);
  lines.push(`slug: ${args.slug}`);
  lines.push(`created: ${args.created ?? today}`);
  lines.push(`updated: ${today}`);
  lines.push(`status: ${args.status}`);
  const owner = args.owner ? oneLine(args.owner) : '';
  if (owner) lines.push(`owner: ${owner}`);
  lines.push('---');
  return lines.join('\n');
}

/**
 * Splice a frontmatter block onto a plan body: replace an existing
 * (malformed) leading `---…---` block, or prepend a fresh one when the
 * file has no frontmatter at all. Exported for unit testing.
 */
export function applyFrontmatterBlock(current: string, fmBlock: string): string {
  if (current.startsWith('---')) {
    const close = current.indexOf('\n---', 3);
    if (close !== -1) {
      const afterClose = current.indexOf('\n', close + 4);
      const bodyStart = afterClose === -1 ? current.length : afterClose + 1;
      return fmBlock + '\n' + current.slice(bodyStart);
    }
  }
  return fmBlock + '\n\n' + current;
}

/** Convert a legacy body and enforce the Now-block invariants in the same write. */
export function buildFirstClassPlanBody(
  current: string,
  args: z.infer<typeof argsSchema>,
  today: string,
): { body: string; nowStamped: boolean } {
  const converted = applyFrontmatterBlock(current, buildFrontmatter(args, today));
  const at = new Date(`${today}T00:00:00.000Z`);
  const stamped =
    stampTerminalNowBlock(converted, args.status, at) ??
    stampGreenlitNowBlock(converted, args.status, at);
  return { body: stamped ?? converted, nowStamped: stamped !== null };
}

type SetFrontmatterValue =
  | { ok: true; slug: string; nowStamped: boolean }
  | { ok: false; code: 'not_found' }
  | { ok: false; code: 'already_valid' };

export default defineTool({
  name: 'plans:set-frontmatter',
  description:
    'Convert a legacy plan (no valid frontmatter) into a first-class plan by writing a complete `title`/`slug`/`created`/`updated`/`status`/`owner` block with a non-terminal initial status. Body untouched. Refuses a plan that already has valid frontmatter; terminal transitions use plans:set-plan-status.',
  guidance: {
    when: 'Promoting a legacy plan — one with no/malformed frontmatter — to a tracked plan, e.g. from the Plans admin tab triage screen.',
    notWhen:
      'Editing a plan that already has valid frontmatter — that would clobber keys this verb does not model; use plans:set-content for prose edits and plans:set-plan-status for lifecycle changes. Routine status flips on items use plans:set-status.',
    chaining: 'plans:list (isLegacy: true rows) → plans:set-frontmatter per plan → plans:get to confirm.',
    seeAlso: [
      'plans:set-frontmatter-field (change ONE field, not the whole block)',
      'plans:get (mode:meta — read current frontmatter)',
    ],
  },
  capability: 'plans:write',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    const today = new Date().toISOString().slice(0, 10);

    const sctx = harnessScopedCtx(args.harness, ctx);
    const harnessSlug = resolveCtxHarnessSlug(sctx);
    const rev = planRevisionCapture(
      ctx as PlanRevisionCtx,
      args.slug,
      args.rationale,
      harnessSlug ? { harnessSlug } : {},
    );
    const result = await withPlanLock<SetFrontmatterValue>(
      ctx as never,
      {
        slug: args.slug,
        intent: 'plans:set-frontmatter',
        ...(harnessSlug ? { harnessSlug } : {}),
        afterWrite: rev.afterWrite,
      },
      async (current): Promise<{ newBody: string | null; value: SetFrontmatterValue }> => {
        if (current === null) {
          return { newBody: null, value: { ok: false, code: 'not_found' } };
        }

        const filePath = `${args.slug}.md`;
        if (!parsePlan(current, { filePath }).isLegacy) {
          return { newBody: null, value: { ok: false, code: 'already_valid' } };
        }

        const converted = buildFirstClassPlanBody(current, args, today);
        return {
          newBody: converted.body,
          value: { ok: true, slug: args.slug, nowStamped: converted.nowStamped },
        };
      },
    );

    if (result.kind === 'busy') {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              error: 'busy',
              busy: result.busy.map((b) => ({
                path: b.path,
                owner_label: b.owner_label,
                intent: b.intent,
                expires_ts: b.expires_ts,
              })),
            }),
          },
        ],
        isError: true,
      };
    }

    if (!result.value.ok) {
      const message = domainFailureMessage(result.value);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ error: result.value.code, slug: args.slug, ...(message ? { message } : {}) }),
          },
        ],
        isError: true,
      };
    }

    // Cross-store invariant: a legacy plan converted straight to a terminal
    // status must not retain an operational started/paused row. (Rare —
    // legacy plans seldom have one — but cheap and keeps the rule total.)
    if (isTerminalPlanStatus(args.status)) {
      try {
        await clearStartedForTerminalPlan(result.scope.workspaceId, result.scope.harnessSlug, args.slug);
      } catch {
        /* recovered by reconcileStartStatus on the next plans:list read */
      }
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            slug: result.value.slug,
            ...(result.value.nowStamped ? { nowStamped: true } : {}),
            filePath: result.filePath,
            revision: rev.recorded.current ? { seq: rev.recorded.current.seq } : null,
            ...(result.activationAudit ? { activationAudit: result.activationAudit } : {}),
          }),
        },
      ],
    };
  },
});
