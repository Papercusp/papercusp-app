/**
 * plans:set-frontmatter-field — set/clear an ARBITRARY plan frontmatter key
 * (plan-templates-and-rubric-v2-2026-06-20 P-002).
 *
 * THE templates blocker: a custom frontmatter field (e.g. `template:`) had NO
 * setter — only the legacy-plan converter (plans:set-frontmatter, which rewrites
 * the WHOLE block) or a raw plans:edit string-replace. This is the generic,
 * surgical, validated, revisioned single-key setter — a direct generalization of
 * plans:set-initiative (which hardcodes `initiative`) via setFrontmatterScalar.
 *
 * Surgical (only the target key's line changes; every other key preserved), inside
 * the plan lock, records a revision, refreshes the plans list. Pass value:null (or
 * "") to clear the key. Refuses a legacy plan (no frontmatter) — convert it with
 * plans:set-frontmatter first.
 *
 * RESERVED keys are rejected (they have a dedicated setter / lifecycle): slug,
 * title, status, created, updated, owner, co_owners, initiative — the rejection
 * names the tool that owns each.
 *
 * TEMPLATE seam (Phase 2): once the template mechanism lands, a value set on a
 * template-governed key will be validated here against the active template's zod
 * schema (validate-on-write). Until then this is a generic scalar field setter.
 */

import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { resolveCtxHarnessSlug } from './_ctx-opts';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { withPlanLock, bumpUpdatedDate } from './with-plan-lock';
import { parsePlan, type LegacyReason } from './parser';
import { planRevisionCapture, type PlanRevisionCtx } from './revisions';
import { setFrontmatterScalar } from './transfer-owner';
import { softText, clampText, LIMITS } from '../limits';

/** Keys with a dedicated setter / lifecycle management — not settable here. Each
 *  maps to the tool that owns it, surfaced in the rejection so the caller is
 *  routed to the right place. Exported for tests. */
export const RESERVED_FRONTMATTER_KEYS: Record<string, string> = {
  slug: 'plans:set-frontmatter (slug is the plan identity)',
  title: 'plans:set-title',
  status: 'plans:set-plan-status',
  created: 'plans:set-frontmatter',
  updated: 'managed automatically (bumped on every write)',
  owner: 'plans:transfer-owner',
  co_owners: 'plans:transfer-owner',
  initiative: 'plans:set-initiative',
};

/** A valid frontmatter key: a leading letter, then letters/digits/underscores.
 *  Excludes spaces, colons, and newlines so a value can never be smuggled into
 *  the key (and so the key is safe to interpolate into a line regex). */
const KEY_RE = /^[a-zA-Z][a-zA-Z0-9_]*$/;

/** Collapse whitespace/newlines so the value can never break out of its single
 *  frontmatter line; trim. Empty → null (clears the field). Exported for tests. */
export function normalizeFieldValue(raw: string | null): string | null {
  if (raw === null) return null;
  const v = raw.replace(/\s+/g, ' ').trim();
  return v.length > 0 ? v : null;
}

/** Current value of `key:` in a frontmatter body, or null. `key` must already be
 *  KEY_RE-validated (regex-safe). Exported for tests. */
export function currentFrontmatterField(body: string, key: string): string | null {
  const m = body.match(new RegExp(`^${key}:[ \\t]*(.*)$`, 'm'));
  const v = m?.[1]?.trim();
  return v && v.length > 0 ? v : null;
}

/** Validate + classify a requested frontmatter key: well-formed? reserved? The
 *  one piece of novel logic in this tool, so it's a pure exported helper. */
export function validateFrontmatterKey(
  rawKey: string,
):
  | { ok: true; key: string }
  | { ok: false; code: 'invalid_key' }
  | { ok: false; code: 'reserved_key'; use: string } {
  const key = rawKey.trim();
  if (!KEY_RE.test(key)) return { ok: false, code: 'invalid_key' };
  const use = RESERVED_FRONTMATTER_KEYS[key];
  if (use) return { ok: false, code: 'reserved_key', use };
  return { ok: true, key };
}

const argsSchema = z.object({
  harness: harnessArg,
  slug: z.string().min(1).describe('Plan slug (filename stem).'),
  key: z
    .string()
    .min(1)
    .max(64)
    .describe(
      'Frontmatter key to set, e.g. "template". Reserved keys (slug/title/status/created/updated/owner/co_owners/initiative) are rejected — use their dedicated setter.',
    ),
  value: z
    .string()
    .max(2000)
    .nullable()
    .describe('Value to set; null or empty string clears the key. Whitespace is collapsed so it stays a single frontmatter line.'),
  rationale: softText(LIMITS.ANNOTATION).optional().describe('Why — stored on the plan revision. Auto-truncated to 2000 chars if longer.'),
});

type SetFieldValue =
  | { ok: true; slug: string; key: string; from: string | null; to: string | null }
  | { ok: false; code: 'not_found' }
  | { ok: false; code: 'legacy_plan'; reason?: LegacyReason };

const text = (payload: Record<string, unknown>, isError = false) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
  ...(isError ? { isError: true as const } : {}),
});

export default defineTool({
  name: 'plans:set-frontmatter-field',
  description:
    "Set or clear an ARBITRARY plan frontmatter key (e.g. `template`) — surgical (other keys preserved), inside the plan lock, records a revision + refreshes the plans list. The generic setter custom fields lacked (vs a raw plans:edit string-replace). Pass value:null to clear. RESERVED keys (slug/title/status/created/updated/owner/co_owners/initiative) are rejected with a pointer to their dedicated setter. Refuses a legacy plan — convert with plans:set-frontmatter first.",
  guidance: {
    when: 'Setting a custom/template frontmatter field that has no dedicated setter (e.g. template:rubric) — the structured alternative to a plans:edit string-replace on the frontmatter.',
    notWhen:
      'A reserved/managed key — use its dedicated setter (title→plans:set-title, status→plans:set-plan-status, owner/co_owners→plans:transfer-owner, initiative→plans:set-initiative, slug/created→plans:set-frontmatter). A whole-document edit — plans:set-content. Converting a legacy (no-frontmatter) plan — plans:set-frontmatter.',
    chaining: 'plans:get (mode:meta) to see current frontmatter → plans:set-frontmatter-field → plans:get to confirm.',
    seeAlso: [
      'plans:set-frontmatter (rewrite the whole frontmatter block)',
      'plans:set-title (rename the reserved title field)',
      'plans:get (mode:meta — see current frontmatter)',
    ],
  },
  capability: 'plans:write',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    const v = validateFrontmatterKey(args.key);
    if (!v.ok) {
      return v.code === 'reserved_key'
        ? text({ error: 'reserved_key', key: args.key.trim(), use: v.use }, true)
        : text(
            {
              error: 'invalid_key',
              key: args.key.trim(),
              hint: 'A frontmatter key is a leading letter then letters/digits/underscores (no spaces, colons, or newlines).',
            },
            true,
          );
    }
    const key = v.key;

    const sctx = harnessScopedCtx(args.harness, ctx);
    const harnessSlug = resolveCtxHarnessSlug(sctx);
    const next = normalizeFieldValue(args.value);
    const rationale = clampText(args.rationale, LIMITS.ANNOTATION) ?? (next ? `set ${key} → ${next}` : `clear ${key}`);
    const rev = planRevisionCapture(
      ctx as PlanRevisionCtx,
      args.slug,
      rationale,
      harnessSlug ? { harnessSlug } : {},
    );

    const result = await withPlanLock<SetFieldValue>(
      ctx as never,
      {
        slug: args.slug,
        intent: 'plans:set-frontmatter-field',
        ...(harnessSlug ? { harnessSlug } : {}),
        afterWrite: rev.afterWrite,
      },
      async (current): Promise<{ newBody: string | null; value: SetFieldValue }> => {
        if (current === null) return { newBody: null, value: { ok: false, code: 'not_found' } };
        const parsedForLegacy = parsePlan(current, { filePath: `${args.slug}.md` });
        if (parsedForLegacy.isLegacy) {
          return {
            newBody: null,
            value: { ok: false, code: 'legacy_plan', reason: parsedForLegacy.legacyReason ?? undefined },
          };
        }
        const from = currentFrontmatterField(current, key);
        let body = setFrontmatterScalar(current, key, next);
        body = bumpUpdatedDate(body);
        return { newBody: body, value: { ok: true, slug: args.slug, key, from, to: next } };
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

    // Refresh the rail so any frontmatter-derived facet updates immediately.
    try {
      const { notifySyncInvalidate } = await import('../../sync-sse');
      await notifySyncInvalidate('plans.list', undefined);
    } catch {
      /* best-effort — the next natural refresh picks it up */
    }

    return text({
      ok: true,
      slug: result.value.slug,
      key: result.value.key,
      from: result.value.from,
      to: result.value.to,
      revision: rev.recorded.current ? { seq: rev.recorded.current.seq } : null,
      ...(result.activationAudit ? { activationAudit: result.activationAudit } : {}),
    });
  },
});
