/**
 * plans:set-title — rename a first-class plan without a raw frontmatter edit.
 *
 * A plan's `title` is a reserved frontmatter key, so the generic
 * plans:set-frontmatter-field verb routes here. This keeps the rename surgical
 * (every other key and the body stay untouched), lock-protected, revisioned,
 * and visible to the plans list immediately.
 *
 * Refuses a legacy plan (no valid slug/status frontmatter) — convert it with
 * plans:set-frontmatter first. Pass a rationale to preserve why the rename
 * happened on the plan revision.
 */

import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { resolveCtxHarnessSlug } from './_ctx-opts';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { withPlanLock, bumpUpdatedDate } from './with-plan-lock';
import { parsePlan, type LegacyReason } from './parser';
import { planRevisionCapture, type PlanRevisionCtx } from './revisions';
import { setFrontmatterScalar } from './transfer-owner';
import { hardText, softText, clampText, LIMITS } from '../limits';

/** Collapse whitespace/newlines so the title remains one frontmatter line. */
export function normalizePlanTitle(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

/** Current `title:` value in a frontmatter body, or null when absent/blank. */
export function currentPlanTitle(body: string): string | null {
  const m = body.match(/^title:[ \t]*(.*)$/m);
  const v = m?.[1]?.trim();
  return v && v.length > 0 ? v : null;
}

const argsSchema = z.object({
  harness: harnessArg,
  slug: z.string().min(1).describe('Plan slug (filename stem) to rename.'),
  title: hardText(LIMITS.SHORT_TITLE)
    .refine((s) => s.trim().length > 0, 'title cannot be blank')
    .describe('New human-readable plan title.'),
  rationale: softText(LIMITS.ANNOTATION)
    .optional()
    .describe('Why — stored on the plan revision. Auto-truncated to 2000 chars if longer.'),
});

type SetTitleValue =
  | { ok: true; slug: string; from: string | null; to: string }
  | { ok: false; code: 'not_found' }
  | { ok: false; code: 'legacy_plan'; reason?: LegacyReason };

const text = (payload: Record<string, unknown>, isError = false) => ({
  data: payload,
  ...(isError ? { isError: true as const } : {}),
});

export default defineTool({
  name: 'plans:set-title',
  description:
    "Rename a first-class plan's `title` — surgical frontmatter edit (other keys and the body preserved), inside the plan lock, records a revision + refreshes the plans list. Refuses a legacy plan — convert it with plans:set-frontmatter first.",
  guidance: {
    when: 'Renaming the display title of an existing first-class plan without rewriting its whole document or using a raw string replacement.',
    notWhen:
      'Converting a legacy (no valid slug/status frontmatter) plan — plans:set-frontmatter. Editing arbitrary custom frontmatter — plans:set-frontmatter-field. Flipping lifecycle status — plans:set-plan-status.',
    chaining: 'plans:get { slug } to inspect the current title → plans:set-title → plans:get or plans:list to confirm the rename.',
    seeAlso: [
      'plans:set-frontmatter-field (custom keys; reserved title routes here)',
      'plans:set-frontmatter (convert a legacy plan first)',
      'plans:set-content (deliberate whole-document replacement)',
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
    const next = normalizePlanTitle(args.title);
    const rationale = clampText(args.rationale, LIMITS.ANNOTATION) ?? `set title → ${next}`;
    const rev = planRevisionCapture(
      ctx as PlanRevisionCtx,
      args.slug,
      rationale,
      harnessSlug ? { harnessSlug } : {},
    );

    const result = await withPlanLock<SetTitleValue>(
      ctx as never,
      {
        slug: args.slug,
        intent: 'plans:set-title',
        ...(harnessSlug ? { harnessSlug } : {}),
        afterWrite: rev.afterWrite,
      },
      async (current): Promise<{ newBody: string | null; value: SetTitleValue }> => {
        if (current === null) return { newBody: null, value: { ok: false, code: 'not_found' } };
        const parsedForLegacy = parsePlan(current, { filePath: `${args.slug}.md` });
        if (parsedForLegacy.isLegacy) {
          return {
            newBody: null,
            value: { ok: false, code: 'legacy_plan', reason: parsedForLegacy.legacyReason ?? undefined },
          };
        }
        const from = currentPlanTitle(current);
        let body = setFrontmatterScalar(current, 'title', next);
        body = bumpUpdatedDate(body);
        return { newBody: body, value: { ok: true, slug: args.slug, from, to: next } };
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
          ...('reason' in result.value && result.value.reason ? { reason: result.value.reason } : {}),
        },
        true,
      );
    }

    try {
      const { notifySyncInvalidate } = await import('../../sync-sse');
      await notifySyncInvalidate('plans.list', undefined);
    } catch {
      /* best-effort — the next natural refresh picks it up */
    }

    return text({
      ok: true,
      slug: result.value.slug,
      from: result.value.from,
      to: result.value.to,
      revision: rev.recorded.current ? { seq: rev.recorded.current.seq } : null,
      ...(result.activationAudit ? { activationAudit: result.activationAudit } : {}),
    });
  },
});
