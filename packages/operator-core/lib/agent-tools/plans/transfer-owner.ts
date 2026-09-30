/**
 * plans:transfer-owner — first-class plan ownership transfer + co-owner list
 * (shared-hive-collaboration-2026-06-14 P-003).
 *
 * Before this, "handing off" a plan in a shared hive meant either a raw
 * plans:set-content rewrite or plans:set-frontmatter (legacy-only) — ambiguous
 * and easy to get wrong. This is the explicit verb: set a plan's primary `owner`
 * and/or its `co_owners` list, surgically (only those frontmatter lines change;
 * every other key is preserved), inside the plan lock, recording a revision as
 * the durable handoff record and invalidating the plans list so the rail badge
 * updates.
 *
 * For a VALID plan only — converting a legacy plan is plans:set-frontmatter's job
 * (this refuses `legacy_plan` so it can never write `owner:` into a malformed
 * block). co_owners are stored as a comma-separated frontmatter scalar
 * (`co_owners: a@x.com, b@x.com`), matching the simple line-based frontmatter the
 * rest of the plan tools write; pass `coOwners: []` to clear, omit to leave it.
 */

import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { resolveCtxHarnessSlug } from './_ctx-opts';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { withPlanLock, bumpUpdatedDate } from './with-plan-lock';
import { parsePlan, type LegacyReason } from './parser';
import { planRevisionCapture, type PlanRevisionCtx } from './revisions';
import { bulkContent, mergeIds, runBulk } from '../_bulk';
import { softText, clampText, LIMITS } from '../limits';

/**
 * Set/replace/remove ONE scalar frontmatter line, preserving every other key.
 * `value === null` removes the line. Insert lands as the last frontmatter line
 * (mirrors bumpUpdatedDate). Returns the body unchanged when frontmatter is
 * missing/malformed (a legacy plan — the caller refuses those before reaching
 * here).
 */
export function setFrontmatterScalar(body: string, key: string, value: string | null): string {
  if (!body.startsWith('---')) return body;
  const close = body.indexOf('\n---', 3);
  if (close === -1) return body;
  const fm = body.slice(0, close);
  const rest = body.slice(close);
  const lineRe = new RegExp(`^${key}:[^\\n]*$`, 'm');
  if (value === null) {
    // Remove the line + its preceding newline, if present.
    return fm.replace(new RegExp(`\\n${key}:[^\\n]*`, 'm'), '') + rest;
  }
  if (lineRe.test(fm)) return fm.replace(lineRe, `${key}: ${value}`) + rest;
  return fm + `\n${key}: ${value}` + rest;
}

/** Current `owner:` value in a frontmatter body, or null. */
function currentOwner(body: string): string | null {
  const m = body.match(/^owner:[ \t]*(.*)$/m);
  const v = m?.[1]?.trim();
  return v && v.length > 0 ? v : null;
}

const emailList = z
  .array(z.string().email())
  .max(50)
  .describe('Co-owner emails — REPLACES the current co_owners list. [] clears it; omit to leave unchanged.');

const argsSchema = z
  .object({
    harness: harnessArg,
    slug: z.string().min(1).optional().describe('Plan slug (filename stem) to transfer.'),
    slugs: z.array(z.string().min(1)).min(1).max(200).optional().describe('Plan slugs to transfer in one call.'),
    to: z
      .string()
      .email()
      .optional()
      .describe('New primary owner email. Omit to keep the current owner and only edit co_owners.'),
    coOwners: emailList.optional(),
    rationale: softText(LIMITS.ANNOTATION)
      .optional()
      .describe('Why the handoff — stored on the plan revision (the durable transfer record). Auto-truncated to 2000 chars if longer.'),
  })
  .refine((a) => Boolean(a.slug) || (a.slugs?.length ?? 0) > 0, {
    message: 'provide `slug` or `slugs`',
  })
  .refine((a) => a.to !== undefined || a.coOwners !== undefined, {
    message: 'provide `to` (new owner) and/or `coOwners` (the co-owner list) — at least one.',
  });

type TransferValue =
  | { ok: true; slug: string; from: string | null; to: string | null; coOwners?: string[] }
  | { ok: false; code: 'not_found' }
  | { ok: false; code: 'legacy_plan'; reason?: LegacyReason };

export default defineTool({
  name: 'plans:transfer-owner',
  description:
    "Transfer a plan's ownership (set `owner`) and/or its `co_owners` list — the explicit, first-class handoff verb. Surgical frontmatter edit (other keys preserved), inside the plan lock, records a revision + refreshes the plans list. Pass `to` (new owner email) and/or `coOwners` (replaces the list; [] clears). Refuses a legacy plan — convert it with plans:set-frontmatter first.",
  guidance: {
    when: 'Explicitly handing a plan to another user, or setting its co-owners, in a shared hive — so ownership is unambiguous instead of an opaque set-content edit.',
    notWhen:
      'Converting a legacy (no-frontmatter) plan — plans:set-frontmatter. A whole-document raw edit — plans:set-content. Flipping an item status — plans:set-status.',
    chaining: 'plans:get { slug } to see the current owner first; plans:list to confirm the transfer landed on the rail.',
    seeAlso: [
      'plans:get (see the current owner first)',
      'plans:set-initiative (regroup plans rather than reassign ownership)',
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
    const rationale =
      clampText(args.rationale, LIMITS.ANNOTATION) ??
      (args.to ? `transfer owner → ${args.to}` : 'update co-owners');
    const slugs = mergeIds(args.slug, args.slugs);
    const env = await runBulk(
      slugs,
      async (slug) => {
        const rev = planRevisionCapture(
          ctx as PlanRevisionCtx,
          slug,
          rationale,
          harnessSlug ? { harnessSlug } : {},
        );

        const result = await withPlanLock<TransferValue>(
          ctx as never,
          {
            slug,
            intent: 'plans:transfer-owner',
            ...(harnessSlug ? { harnessSlug } : {}),
            afterWrite: rev.afterWrite,
          },
          async (current): Promise<{ newBody: string | null; value: TransferValue }> => {
            if (current === null) return { newBody: null, value: { ok: false, code: 'not_found' } };
            const parsedForLegacy = parsePlan(current, { filePath: `${slug}.md` });
            if (parsedForLegacy.isLegacy) {
              return {
                newBody: null,
                value: { ok: false, code: 'legacy_plan', reason: parsedForLegacy.legacyReason ?? undefined },
              };
            }
            const from = currentOwner(current);
            let body = current;
            if (args.to !== undefined) body = setFrontmatterScalar(body, 'owner', args.to);
            if (args.coOwners !== undefined) {
              body = setFrontmatterScalar(
                body,
                'co_owners',
                args.coOwners.length > 0 ? args.coOwners.join(', ') : null,
              );
            }
            body = bumpUpdatedDate(body);
            return {
              newBody: body,
              value: {
                ok: true,
                slug,
                from,
                to: args.to ?? from,
                ...(args.coOwners !== undefined ? { coOwners: args.coOwners } : {}),
              },
            };
          },
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
            ...('reason' in result.value && result.value.reason ? { reason: result.value.reason } : {}),
          };
        }

        return {
          ok: true as const,
          slug: result.value.slug,
          from: result.value.from,
          to: result.value.to,
          ...(result.value.coOwners !== undefined ? { coOwners: result.value.coOwners } : {}),
          revision: rev.recorded.current ? { seq: rev.recorded.current.seq } : null,
          ...(result.activationAudit ? { activationAudit: result.activationAudit } : {}),
        };
      },
      { keyOf: (slug) => ({ slug }) },
    );

    if (env.counts.ok > 0) {
      // Refresh the rail so the new owner/co-owners badge shows immediately.
      try {
        const { notifySyncInvalidate } = await import('../../sync-sse');
        await notifySyncInvalidate('plans.list', undefined);
      } catch {
        /* best-effort — the next natural refresh picks it up */
      }
    }

    return bulkContent(env);
  },
});
