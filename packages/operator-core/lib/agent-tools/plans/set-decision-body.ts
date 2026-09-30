/**
 * plans:set-decision-body — replace the body of an existing decision
 * (plan-templates-and-rubric-v2-2026-06-20 P-003).
 *
 * The interface audit found you could plans:add-decision but never EDIT a decision's
 * body without a plans:edit string-replace. This is the structured setter: it
 * replaces everything after the `### D-NNN — title` head line (up to the next
 * heading) with the caller's new body, PRESERVING the head line (the title is
 * unchanged), the existing `Date:` line (creation metadata), and the existing
 * generated `Related:` line by default. Pass `refs` to replace that line, or an
 * empty array to clear it. Inside the plan lock; records a revision.
 */

import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { resolveCtxHarnessSlug } from './_ctx-opts';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { withPlanLock, bumpUpdatedDate } from './with-plan-lock';
import { decisionProvenance, FALSIFIED_OWNER_ANCHOR_NOTE } from './decision-provenance';
import { parsePlan, maskFences, normalizeDecisionBodyHeadings, type LegacyReason } from './parser';
import { planRevisionCapture, type PlanRevisionCtx } from './revisions';
import { hardText, softText, clampText, LIMITS } from '../limits';
import { neutralizeToolCallTags } from '../../text-safety';

/**
 * Replace a decision's body. Locates the `### D-NNN` head line against the
 * fence-masked body, finds the block end (the next `###`/`##`/`#` heading or EOF),
 * and rebuilds the block as: head line + (preserved `Date:` line) + the new body +
 * (preserved or explicitly replaced `Related:` line). `date` is the parsed decision
 * date (re-emitted, or omitted when null). Returns the prior body (minus head + date)
 * for transparency. Exported for tests.
 */
export function setDecisionBodyInBody(
  body: string,
  decisionId: string,
  newDecisionBody: string,
  date: string | null,
  refs?: string[],
): { newBody: string; found: boolean; oldBody: string } {
  const headRe = new RegExp(
    String.raw`^###\s+` + decisionId.replace(/-/g, '\\-') + String.raw`\b[^\n]*$`,
    'm',
  );
  const masked = maskFences(body);
  const hm = headRe.exec(masked);
  if (!hm) return { newBody: body, found: false, oldBody: '' };

  const headLineEnd = hm.index + hm[0].length; // end of the "### D-NNN — title" line text
  // The block runs to the next heading (### next decision / ## next section / #) or EOF.
  const restMasked = masked.slice(headLineEnd);
  const tailM = /^#{1,3}\s/m.exec(restMasked);
  const blockEnd = tailM ? headLineEnd + tailM.index : body.length;

  const oldBlock = body.slice(headLineEnd, blockEnd);
  const datePiece = date ? `Date: ${date}\n` : '';
  // `plans:add-decision` writes refs as a generated trailing `Related:` line.
  // Preserve that line unless the caller explicitly supplies `refs`; this keeps
  // a body edit from silently unlinking the decision from its plan items while
  // still allowing an intentional replacement or clear (`refs: []`).
  const existingRelated = oldBlock.match(/^\s*Related:[^\n]*$/im)?.[0]?.trim() ?? null;
  const relatedLine =
    refs === undefined ? existingRelated : refs.length > 0 ? `Related: ${refs.join(', ')}` : null;
  // One blank line before a following heading (matches add-decision's block spacing);
  // none at EOF.
  const trailing = blockEnd < body.length ? '\n' : '';
  // Demote `#`/`##` headings so the new body cannot break out of the
  // `## Decisions` section (EI-18804290731494084) — same structural guard
  // add-decision applies, so both decision writers are safe by construction
  // rather than only the one that happened to be fixed.
  const { body: normalizedBody } = normalizeDecisionBodyHeadings(newDecisionBody.trim());
  // Callers that still include the old Related line (per the former contract)
  // must not get a duplicate after preservation is applied. Only remove a
  // trailing line; `Related:` in ordinary prose remains untouched.
  const safeBody = relatedLine
    ? normalizedBody.replace(/\n\s*Related:[^\n]*\s*$/i, '').trim()
    : normalizedBody;
  const relatedPiece = relatedLine ? `\n${relatedLine}` : '';
  const rebuilt = `\n${datePiece}${safeBody}${relatedPiece}\n${trailing}`;
  const newBody = body.slice(0, headLineEnd) + rebuilt + body.slice(blockEnd);

  // oldBody (for the result) = the prior block minus its leading blank + Date line.
  const oldBody = oldBlock.replace(/^\s*/, '').replace(/^Date:[^\n]*\n?/i, '').trim();
  return { newBody, found: true, oldBody };
}

const argsSchema = z.object({
  harness: harnessArg,
  slug: z.string().min(1).describe('Plan slug (filename stem).'),
  decisionId: z.string().regex(/^D-\d{3,}$/, 'D-NNN form required'),
  body: hardText(5000).describe(
    "The decision's new body (replaces the prior body). HARD CAP 5000 chars — over-length is REJECTED, not truncated. The `### D-NNN — title`, `Date:`, and existing generated `Related:` line are preserved by default. Pass refs to replace the related item refs, or refs: [] to clear them.",
  ),
  refs: z
    .array(z.string().regex(/^P-\d{3,}$/, 'P-NNN form required'))
    .max(40)
    .optional()
    .describe("Replace the decision's generated Related: item refs. Omit to preserve existing refs; pass [] to clear them."),
  rationale: softText(LIMITS.ANNOTATION)
    .optional()
    .describe('Optional — why the decision body changed (a correction, an added caveat). Stored on the plan revision (D-009). Auto-truncated to 2000 chars if longer.'),
});

type SetDecisionBodyValue =
  | { ok: true; decisionId: string; slug: string; oldBody: string }
  | { ok: false; code: 'not_found' | 'decision_not_found' }
  | { ok: false; code: 'legacy_plan'; reason?: LegacyReason };

const text = (payload: Record<string, unknown>, isError = false) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
  ...(isError ? { isError: true as const } : {}),
});

export default defineTool({
  name: 'plans:set-decision-body',
  description:
    "Replace an existing decision's body — preserves the `### D-NNN — title` head, the `Date:` line, and existing generated `Related:` refs by default. Pass refs to replace them or [] to clear them. Inside the plan lock, records a revision. An uncovered absence premise returns advisory `absenceLint`; add a concrete `Measured: <scope + result>` line after running its recheck. The structured editor decisions lacked (plans:add-decision could only append; editing meant a plans:edit string-replace).",
  guidance: {
    when: "A decision's body needs revising — a correction, a clarification, an added caveat — keeping its id, title, date, and related item refs. Pass refs only when intentionally changing those refs. The structured alternative to a plans:edit on the decision block.",
    notWhen:
      'Recording a NEW decision (plans:add-decision). Changing a decision title (plans:edit — title lives on the head line). A whole-document rewrite (plans:set-content).',
    chaining: 'plans:get (the decision body) → plans:set-decision-body → plans:get to confirm.',
    seeAlso: [
      'plans:add-decision (add a NEW decision, not edit an existing body)',
      'plans:get (read the decision body first)',
    ],
  },
  capability: 'plans:write',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  modality: ['text'],
  args: argsSchema,
  async handler(rawArgs, ctx) {
    // EI-21915372335188454: the same tool-call-lookalike neutralization
    // plans:add-decision applies, for the same reason — this is the sibling
    // decision-body writer on the same durable governance surface, so guarding
    // only the append leaves the edit path free to reintroduce the exact same
    // absorbed-`<parameter>`/dropped-refs corruption (including via the very
    // repair call this editor is used to make). Non-destructive (cosmetic
    // full-width `＜` swap) — the edit still lands.
    const args = { ...rawArgs, body: neutralizeToolCallTags(rawArgs.body) };
    // WI-42142 — the same decision-provenance leg plans:add-decision runs, for the
    // same reason: this tool overwrites the very body that tool appends, so guarding
    // only the append is a guard an agent clears by recording a clean decision and
    // then rewriting it. Resolved BEFORE the plan lock (transcript IO under a bounded
    // budget must not be paid under a held lock); see ./decision-provenance.
    const { fields: provenance, anchors } = await decisionProvenance(args.body, ctx);
    if (anchors.length > 0) {
      return text(
        {
          error: 'falsified_owner_anchor',
          slug: args.slug,
          decisionId: args.decisionId,
          message: FALSIFIED_OWNER_ANCHOR_NOTE,
          anchors,
        },
        true,
      );
    }

    const sctx = harnessScopedCtx(args.harness, ctx);
    const harnessSlug = resolveCtxHarnessSlug(sctx);
    const rev = planRevisionCapture(
      ctx as PlanRevisionCtx,
      args.slug,
      clampText(args.rationale, LIMITS.ANNOTATION),
      harnessSlug ? { harnessSlug } : {},
    );

    const result = await withPlanLock<SetDecisionBodyValue>(
      ctx as never,
      {
        slug: args.slug,
        intent: `plans:set-decision-body ${args.decisionId}`,
        ...(harnessSlug ? { harnessSlug } : {}),
        afterWrite: rev.afterWrite,
      },
      async (current): Promise<{ newBody: string | null; value: SetDecisionBodyValue }> => {
        if (current === null) return { newBody: null, value: { ok: false, code: 'not_found' } };
        const parsed = parsePlan(current, { filePath: args.slug + '.md' });
        if (parsed.isLegacy) {
          return {
            newBody: null,
            value: { ok: false, code: 'legacy_plan', reason: parsed.legacyReason ?? undefined },
          };
        }
        const decision = parsed.decisions.find((d) => d.id === args.decisionId);
        if (!decision) return { newBody: null, value: { ok: false, code: 'decision_not_found' } };

        const { newBody, found, oldBody } = setDecisionBodyInBody(
          current,
          args.decisionId,
          args.body,
          decision.date,
          args.refs,
        );
        if (!found) return { newBody: null, value: { ok: false, code: 'decision_not_found' } };
        return {
          newBody: bumpUpdatedDate(newBody),
          value: { ok: true, decisionId: args.decisionId, slug: args.slug, oldBody },
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
          ...('reason' in result.value && result.value.reason ? { reason: result.value.reason } : {}),
        },
        true,
      );
    }

    // Refresh the plans rail so a decision-derived view updates immediately.
    try {
      const { notifySyncInvalidate } = await import('../../sync-sse');
      await notifySyncInvalidate('plans.list', undefined);
    } catch {
      /* best-effort — the next natural refresh picks it up */
    }

    return text({
      ...result.value,
      filePath: result.filePath,
      revision: rev.recorded.current ? { seq: rev.recorded.current.seq } : null,
      // WI-42142: advisory provenance — absent on the clean common case.
      ...provenance,
    });
  },
});
