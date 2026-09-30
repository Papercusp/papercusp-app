/**
 * conventions:governing — P-018's discovery half: "what conventions govern what
 * I am about to do", answered WITHOUT the caller having to know which plan a
 * ruling came from or which scope a convention was filed under.
 *
 * This is a projection over the two mechanisms that already exist
 * (`facts:assert { kind:'convention' }` and `plans:add-decision`), not a third
 * store — D-004, and P-018's own wording. See `lib/conventions/registry.ts` for
 * why the two sources are treated asymmetrically.
 */
import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { InvalidInputError } from '@papercusp/tooldef';
import { ALL_HARNESSES, governingConventions, type Convention } from '../../conventions/registry';
import { renderEnforcement } from '../../agent-facts/store';

/** Excerpt width — enough to judge whether a convention applies to you. */
export const CONVENTION_EXCERPT_CHARS = 400;

/** PURE — unit-tested without PG. */
export function projectConvention(c: Convention, full: boolean): Record<string, unknown> {
  const body = c.body ?? '';
  const cut = !full && body.length > CONVENTION_EXCERPT_CHARS;
  return {
    // D-075 R1: this string is BOTH the answer and the citation. Pass it
    // verbatim as a `premises` ref at the point of action — it is already in a
    // shape classifyPremiseRef treats as invalidatable.
    id: c.id,
    source: c.source,
    title: c.title,
    body: cut ? `${body.slice(0, CONVENTION_EXCERPT_CHARS)}…` : body,
    ...(cut ? { body_truncated: true, body_full_chars: body.length } : {}),
    ...(c.scope ? { scope: c.scope } : {}),
    ...(c.planSlug ? { planSlug: c.planSlug } : {}),
    // D-016's tier, rendered so it is readable at a glance. Absent = no tier
    // declared, which for a plan decision is ALWAYS the case (D-075 R5) and for
    // a fact means its only enforcement is documentation — which D-016 rules is
    // not a tier at all.
    ...(c.enforcement
      ? { enforcement: c.enforcement, enforcementLabel: renderEnforcement(c.enforcement) }
      : {}),
    relevance: Number(c.relevance.toFixed(2)),
  };
}

export default defineTool({
  name: 'conventions:governing',
  capability: 'coord:read',
  description:
    "What conventions govern what you are about to do — DECLARED conventions (facts with kind:'convention', returned whole) plus the plan decisions relevant to your `about`, across every plan in the harness. Each carries the id you cite it by.",
  guidance: {
    when:
      "Before a commitment others build on — an edit to a shared surface, a coord:send, a claim/complete, a schema or API change — ask what already governs it. Answers 'which plan was that ruling in again?' without you knowing the plan.",
    notWhen:
      'Reading one known fact (facts:list) or one known decision (plans:get { heading }). Prose/semantic recall is memory:search.',
    chaining:
      "conventions:governing → cite the returned `id` verbatim in coord:send `premises` (it is already an invalidatable ref kind) → facts:assert { kind:'convention' } to declare a new one.",
    seeAlso: ['facts:assert', 'facts:list', 'plans:add-decision'],
  },
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  modality: ['text'],
  args: z.object({
    about: z
      .string()
      .max(2000)
      .optional()
      .describe(
        'What you are about to do, in a sentence. Ranks declared conventions and SELECTS which plan decisions are relevant. Omit to get declared conventions only — with nothing to rank against, arbitrary plan decisions would be noise dressed as governance.',
      ),
    harness: z
      .string()
      .max(120)
      .optional()
      .describe(
        "Harness whose plan decisions to search (default: your session harness). `'*'` — which is what a workspace-scoped session resolves to — searches EVERY harness in the workspace rather than a harness named `*`.",
      ),
    scopeRefs: z
      .array(z.string().max(120))
      .max(20)
      .optional()
      .describe(
        'Restrict role/owner/harness/work_item-scoped conventions to these refs. Workspace-scoped conventions are unconditional and always included. Default: your own owner id + harness.',
      ),
    limit: z.number().int().positive().max(50).optional().describe('Max conventions returned (default 20).'),
    full: z
      .boolean()
      .optional()
      .describe('Return COMPLETE bodies instead of excerpts. Default false.'),
  }),
  async handler(args, ctx) {
    const harness = (args.harness ?? ctx.harnessSlug ?? '').trim();
    // D-086 R2: `''` means identity resolution FAILED — a different condition
    // from "deliberately unscoped" (`'*'`, handled below), and never silently
    // widened into a whole-workspace scan.
    if (!harness) {
      // InvalidInputError, not a 500 — a missing arg is the caller's to fix, and
      // EI-7463's class says a caller-input error must not inflate the tool's
      // error rate as if the handler had broken.
      throw new InvalidInputError(
        'conventions:governing — harness_required: pass `harness` (a workspace-scoped session does not imply one). It scopes which plans\' decisions are searched.',
      );
    }
    // Default the scope filter to the caller's own governed refs, mirroring
    // facts:list's EI-7517 context defaulting: a role/owner convention naming
    // someone else's ref governs THEM, and surfacing it here would be noise.
    // Same identity path the facts tools use, so the two surfaces agree on which
    // refs are "yours".
    let scopeRefs = args.scopeRefs;
    if (!scopeRefs) {
      const { resolveAgentIdentity, deriveAgentRole } = await import('../coordination/identity');
      const identity = resolveAgentIdentity(ctx);
      scopeRefs = [identity.ownerId, harness, deriveAgentRole(identity)].filter(
        (v): v is string => typeof v === 'string' && v.length > 0,
      );
    }

    const { conventions, counts } = await governingConventions({
      harness,
      about: args.about ?? null,
      scopeRefs,
      limit: args.limit ?? 20,
    });

    return {
      data: {
        ok: true,
        harness,
        conventions: conventions.map((c) => projectConvention(c, args.full === true)),
        counts,
        // Stated rather than implied: a caller who passed no `about` got a
        // deliberately partial answer, and should know which half is missing.
        ...(args.about
          ? {}
          : {
              note: 'No `about` given — DECLARED conventions only; plan decisions were not searched.',
            }),
        // D-086 R3: a zero that means "searched every harness, found nothing" and
        // a zero that meant "searched nothing" are not the same answer, and
        // `counts` alone cannot tell them apart. Say which one this is.
        ...(harness === ALL_HARNESSES
          ? {
              harnessScope:
                'workspace — no single harness in scope, so plan decisions were searched across EVERY harness in this workspace. Pass `harness` to narrow.',
            }
          : {}),
      },
    };
  },
});
