/**
 * blender:route-idea — route an su IDEATE-pass idea onto the PLAN rail
 * (su-ideate-learning-substrate-2026-07-10 P-009 / D-007).
 *
 * The su-side multi-rail router, plan rail first: an su session (or the Mug
 * triaging su filings) promotes an idea into a DRAFT plan the Queen/owner then
 * greenlights. It rides the SAME draft seam Scout's broad rail uses
 * ({@link createScoutPlanDraft} — scout-plan-draft.ts), so the draft is pinned
 * to the caller's concrete workspace and the routed-idea ledger row carries
 * origin='su-ideate'. P-003/P-004 grade→outcome→feedback
 * attribution then works unchanged — classifyIdeaOutcome already follows a
 * `plan:<slug>` ref's terminal states.
 *
 * Two entry shapes (D-007), exactly one:
 *   - draft {…}  — a fresh idea: mint a ledger row keyed by the plan ref.
 *   - featureId  — re-route an ALREADY-FILED su feature (an EI): upsert its
 *                  existing ledger row (idea_id ON CONFLICT) onto the plan rail
 *                  + link wi↔plan 'relates'; the wi STAYS OPEN for Mug
 *                  disposition (a routing is not a resolution).
 *
 * gym / instance rails are explicitly OUT of scope here (acknowledge-only first,
 * a later item) — `rail` is pinned to 'plan'.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';

import { getIssue, linkIssue } from '../../issues-engineer';
import { recordRoutedIdea } from '../../scout/routed-ledger';
import {
  buildScoutPlanTemplate,
  createScoutPlanDraft,
  type CreateScoutPlanDraftInput,
} from '../../scout/scout-plan-draft';
import { SU_IDEATION_LENSES, type SuIdeationLens } from '../../scout/types';
import { preserveAgentReviewAuthorityBeforePlanRoute } from '../../harness/improvements/agent-review';
import { resolvePlanRevisionSessionRef } from '../plans/revisions';
import { resolveAgentIdentity } from '../coordination/identity';
import { hardText, softText, LIMITS } from '../limits';

const cheapExperimentArg = z
  .object({
    hypothesis: z.string().min(1).max(2000).describe('what we believe will be true if the idea has merit'),
    method: z.string().min(1).max(2000).describe('the cheap first test (what to run / build / measure)'),
    falsifiableSignal: z.string().min(1).max(2000).describe('the observable that would prove the hypothesis WRONG'),
  })
  .strict();

export const routeIdeaArgs = z
  .object({
    /**
     * Re-route an ALREADY-FILED su feature (an EI id) onto the plan rail. Its
     * existing ledger row is upserted; the wi is linked to the plan and STAYS
     * OPEN. Pass this XOR `draft`.
     */
    featureId: z.string().min(1).max(120).optional().describe("re-route an already-filed su feature (EI id) onto the plan rail — the wi stays open"),
    /** A fresh idea to route straight to a draft plan. Pass this XOR `featureId`. */
    draft: z
      .object({
        title: hardText(LIMITS.SHORT_TITLE).describe('one-line idea title (becomes the draft plan title + slug stem)'),
        framing: hardText(LIMITS.CONTENT).describe('the why / the reframe — what problem or opportunity this addresses'),
        mechanism: hardText(LIMITS.CONTENT).describe('the how — the concrete mechanism the plan would build'),
        bet: softText(LIMITS.ANNOTATION).optional().describe('the concrete upside if the idea pans out'),
        cheapExperiment: cheapExperimentArg.optional().describe('the cheap falsifiable first experiment (ScoutExperiment shape, D-006)'),
        lens: z
          .enum([...SU_IDEATION_LENSES] as [SuIdeationLens, ...SuIdeationLens[]])
          .optional()
          .describe("the generative stance that produced the idea — recorded on the ledger row (origin-partitioned OUT of Scout's lens-weight learning); omitted ⇒ the 'su-ideate' sentinel"),
        addressesPatternRefs: z
          .array(z.string().min(1).max(200))
          .max(10)
          .optional()
          .describe(
            "the digest meta-pattern refs this idea GROUNDS ON (observationsImpact.patterns[].ref, e.g. 'wi:EI-10587') — without them the routed idea can never count as grounded in anyone's observationsImpact (P-006/EI-10607)",
          ),
      })
      .strict()
      .optional(),
    /** Only the plan rail is wired here (D-007); gym/instance land later. */
    rail: z.literal('plan').default('plan').describe("the target rail — only 'plan' is supported here (gym/instance are a later item)"),
  })
  .refine((a) => (a.featureId == null) !== (a.draft == null), {
    message: 'Pass exactly one of featureId or draft.',
  });
export type RouteIdeaArgs = z.infer<typeof routeIdeaArgs>;

/** The tool's payload — what was routed, where, and (re-route path) the link state. */
export interface RouteIdeaResult {
  ok: boolean;
  /** Refusal reason for a route that cannot safely enter the plan rail. */
  reason?: 'not-found' | 'placeholder-draft';
  rail?: 'plan';
  /** The (dated) draft plan slug. */
  slug?: string;
  /** The change-feed ref of the routed artifact: `plan:<slug>`. */
  planRef?: string;
  /** false = an existing plan with that slug was reused (idempotent). */
  created?: boolean;
  /** The routed-idea ledger PK. */
  ideaId?: string;
  /** Set on the re-route path: the source feature id. */
  featureId?: string;
  /** Re-route path: whether the wi↔plan 'relates' edge landed (best-effort). */
  linked?: boolean;
  /** Re-route path: the wi is deliberately NOT closed (D-007). */
  wiStaysOpen?: boolean;
  /** Sections whose known placeholder text made the route unsafe. */
  placeholderSections?: RouteDraftPlaceholderSection[];
}

/** The two plan sections whose old Scout prose disguised an empty draft. */
export type RouteDraftPlaceholderSection = 'requirements' | 'design';

const KNOWN_ROUTE_PLACEHOLDERS: Readonly<Record<RouteDraftPlaceholderSection, readonly string[]>> = {
  requirements: [
    'TBD',
    'The ratified plan must turn the proposal above into a concrete, observable outcome. Its first slice must preserve the rationale recorded in this draft and produce verification evidence that a reviewer can use to judge the outcome.',
  ],
  design: [
    'TBD',
    'Start from the first concrete slice below and refine its implementation boundary, dependencies, and verification during review. The design must stay within the proposal\'s rationale and make the smallest verifiable change explicit before the plan is ratified.',
  ],
};

function normalizedSectionBody(body: string): string {
  return body.replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim();
}

function sectionRange(content: string, heading: string): { start: number; end: number; body: string } | null {
  const start = content.indexOf(`## ${heading}`);
  if (start < 0) return null;
  const bodyStart = content.indexOf('\n', start);
  if (bodyStart < 0) return { start, end: content.length, body: '' };
  const remainder = content.slice(bodyStart);
  const nextHeading = remainder.search(/\n## /);
  const end = nextHeading < 0 ? content.length : bodyStart + nextHeading;
  return { start, end, body: content.slice(bodyStart + 1, end) };
}

/** Pure detector for the exact known template prose observed in routed drafts. */
export function knownRouteDraftPlaceholderSections(content: string): RouteDraftPlaceholderSection[] {
  return (['requirements', 'design'] as const).filter((section) => {
    const range = sectionRange(content, section[0].toUpperCase() + section.slice(1));
    if (!range) return false;
    const body = normalizedSectionBody(range.body);
    return KNOWN_ROUTE_PLACEHOLDERS[section].some((placeholder) => normalizedSectionBody(placeholder) === body);
  });
}

/**
 * Keep the shared draft shape, but remove deceptive known placeholders for the
 * su route. Missing sections are intentionally visible and remain subject to
 * the existing spec-triad gate until a reviewer authors them.
 */
export function buildRouteDraftBody(args: Parameters<typeof buildScoutPlanTemplate>[0]): string {
  const body = buildScoutPlanTemplate(args);
  const ranges = (['requirements', 'design'] as const)
    .map((section) => {
      const range = sectionRange(body, section[0].toUpperCase() + section.slice(1));
      if (!range) return null;
      const normalized = normalizedSectionBody(range.body);
      return KNOWN_ROUTE_PLACEHOLDERS[section].some((placeholder) => normalizedSectionBody(placeholder) === normalized)
        ? range
        : null;
    })
    .filter((range): range is { start: number; end: number; body: string } => range !== null)
    .sort((a, b) => b.start - a.start);

  return ranges
    .reduce((current, range) => current.slice(0, range.start) + current.slice(range.end), body)
    .replace(/\n{3,}/g, '\n\n');
}

export type RouteDraftBodyBuilder = (args: Parameters<typeof buildScoutPlanTemplate>[0]) => string;

export type RouteDraftGuardResult =
  | { ok: true }
  | { ok: false; reason: 'placeholder-draft'; placeholderSections: RouteDraftPlaceholderSection[] };

/** Refuse a body if a future route builder reintroduces the deceptive template prose. */
export function guardRouteDraftBody(content: string): RouteDraftGuardResult {
  const placeholderSections = knownRouteDraftPlaceholderSections(content);
  return placeholderSections.length
    ? { ok: false, reason: 'placeholder-draft', placeholderSections }
    : { ok: true };
}

function routeDraftBuilder(title: string, rationale: string, builder: RouteDraftBodyBuilder) {
  const buildBody = ({ slug, date }: { slug: string; date: string }): string =>
    builder({ slug, title, date, rationale });
  // Probe the exact builder before any plan or ledger write. This keeps the
  // route safe if the shared template changes and starts emitting a known
  // placeholder again.
  const guard = guardRouteDraftBody(buildBody({ slug: 'route-probe', date: '2000-01-01' }));
  return { buildBody, guard };
}

function prepareRoutePlanDraft(args: {
  title: string;
  rationale: string;
  harnessSlug: string;
  workspaceId?: string;
  revisionIdentity: ReturnType<typeof resolveAgentIdentity>;
  revisionSession: Awaited<ReturnType<typeof resolvePlanRevisionSessionRef>>;
}, deps: RouteIdeaDeps):
  | { ok: true; input: CreateScoutPlanDraftInput }
  | { ok: false; result: RouteIdeaResult } {
  const { buildBody, guard } = routeDraftBuilder(
    args.title,
    args.rationale,
    deps.buildDraftBody ?? buildRouteDraftBody,
  );
  if (!guard.ok) return { ok: false, result: guard };

  const date = new Date().toISOString().slice(0, 10);
  return {
    ok: true,
    input: {
      slug: slugStemFromTitle(args.title),
      title: args.title,
      harnessSlug: args.harnessSlug,
      ...(args.workspaceId ? { workspaceId: args.workspaceId } : {}),
      revisionIdentity: args.revisionIdentity,
      revisionSession: args.revisionSession,
      rationale: args.rationale,
      date,
      buildBody,
    },
  };
}

/** Injectable seams — unit tests drive the full flow with fakes (grade-idea/gym-tools pattern). */
export interface RouteIdeaDeps {
  createPlanDraft: (input: CreateScoutPlanDraftInput) => Promise<{ slug: string; created: boolean }>;
  recordRoutedIdea: typeof recordRoutedIdea;
  getIssue: typeof getIssue;
  linkIssue: typeof linkIssue;
  preserveAgentReviewAuthority: typeof preserveAgentReviewAuthorityBeforePlanRoute;
  /** Test seam for proving the route refuses a reintroduced known placeholder. */
  buildDraftBody?: RouteDraftBodyBuilder;
}

/**
 * Production createPlanDraft: the shared idempotent draft seam. runRouteIdea
 * supplies the caller's concrete workspace on every write so a scoped su route
 * cannot strand the plan in the legacy `default` partition (EI-20333672116088584).
 */
const defaultDeps: RouteIdeaDeps = {
  createPlanDraft: createScoutPlanDraft,
  recordRoutedIdea,
  getIssue,
  linkIssue,
  preserveAgentReviewAuthority: preserveAgentReviewAuthorityBeforePlanRoute,
};

/** kebab-case slug stem from a title; createScoutPlanDraft appends the date suffix. */
export function slugStemFromTitle(title: string): string {
  const stem = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return stem || 'su-idea';
}

/** PURE: compose the draft plan's rationale/background from the declared idea shape. */
export function buildRouteRationale(input: {
  framing?: string | null;
  mechanism?: string | null;
  bet?: string | null;
  cheapExperiment?: { hypothesis: string; method: string; falsifiableSignal: string } | null;
  sourceRef?: string | null;
}): string {
  const ce = input.cheapExperiment;
  return [
    input.framing ? `**Framing:** ${input.framing}` : null,
    input.mechanism ? `**Mechanism:** ${input.mechanism}` : null,
    input.bet ? `**Bet:** ${input.bet}` : null,
    ce ? `**Cheap experiment:** hypothesis — ${ce.hypothesis}; method — ${ce.method}; falsifiable signal — ${ce.falsifiableSignal}` : null,
    input.sourceRef ? `_Routed from ${input.sourceRef} (su-ideate P-009). The wi stays open for triage._` : null,
  ]
    .filter((l): l is string => !!l)
    .join('\n\n');
}

/** The declared ideation shape a routed su feature may carry on its payload. */
function lensFromPayload(payload: unknown): SuIdeationLens | 'su-ideate' {
  const lens = (payload as { ideation?: { lens?: unknown } } | null)?.ideation?.lens;
  return typeof lens === 'string' && (SU_IDEATION_LENSES as readonly string[]).includes(lens)
    ? (lens as SuIdeationLens)
    : 'su-ideate';
}

/**
 * The testable core: create the draft plan, record/upsert the ledger row
 * (origin='su-ideate', plan rail), and — on the re-route path — link wi↔plan.
 */
export async function runRouteIdea(
  args: RouteIdeaArgs,
  ctx: unknown,
  deps: RouteIdeaDeps = defaultDeps,
): Promise<RouteIdeaResult> {
  const identity = resolveAgentIdentity(ctx as Parameters<typeof resolveAgentIdentity>[0]);
  const workspaceId = identity.workspaceId;
  const ctxHarnessRaw = (ctx as { harnessSlug?: unknown }).harnessSlug;
  const harnessSlug =
    typeof ctxHarnessRaw === 'string' && ctxHarnessRaw && ctxHarnessRaw !== '*' ? ctxHarnessRaw : 'papercusp';
  const revisionSession = await resolvePlanRevisionSessionRef(ctx as never, identity);

  // ── Re-route path: an already-filed su feature → the plan rail (wi stays open).
  if (args.featureId) {
    const issue = await deps.getIssue(args.featureId);
    if (!issue) return { ok: false, reason: 'not-found', featureId: args.featureId };

    const draft = prepareRoutePlanDraft(
      {
        title: issue.title,
        harnessSlug,
        ...(workspaceId ? { workspaceId } : {}),
        revisionIdentity: identity,
        revisionSession,
        rationale: buildRouteRationale({ framing: issue.body || null, sourceRef: `wi:${issue.id}` }),
      },
      deps,
    );
    if (!draft.ok) return { ...draft.result, featureId: issue.id };
    const { slug, created } = await deps.createPlanDraft(draft.input);
    const planRef = `plan:${slug}`;
    // The same bare EI id is used by su-ideate's plan-learning row and, when
    // review enrollment happened first, by agent-review's grade authority. Move
    // the latter to its deterministic fallback before the plan upsert can reuse
    // the key. This is a no-op for ordinary/non-review routes and on retries.
    await deps.preserveAgentReviewAuthority({
      workItemId: issue.id,
      ...(workspaceId ? { workspaceId } : {}),
    });
    // idea_id ON CONFLICT upserts the feature's existing ledger row onto the
    // plan rail; created_by preserves the ORIGINATOR (not the re-router).
    await deps.recordRoutedIdea({
      ideaId: issue.id,
      origin: 'su-ideate',
      rail: 'plan',
      routedRef: planRef,
      lens: lensFromPayload(issue.payload),
      harnessSlug,
      title: issue.title,
      createdBy: issue.createdBy ?? identity.ownerId,
    });
    // Link wi↔plan 'relates' (D-007) — best-effort: a link hiccup never undoes
    // the routing the caller asked for.
    let linked = false;
    try {
      await deps.linkIssue(issue.id, { kind: 'plan', ref: slug }, 'relates', identity.ownerId);
      linked = true;
    } catch {
      /* best-effort edge */
    }
    return { ok: true, rail: 'plan', slug, planRef, created, ideaId: issue.id, featureId: issue.id, linked, wiStaysOpen: true };
  }

  // ── Draft path: a fresh idea → a new draft plan + a fresh ledger row.
  const d = args.draft!;
  const draft = prepareRoutePlanDraft(
    {
      title: d.title,
      harnessSlug,
      ...(workspaceId ? { workspaceId } : {}),
      revisionIdentity: identity,
      revisionSession,
      rationale: buildRouteRationale({
        framing: d.framing,
        mechanism: d.mechanism,
        bet: d.bet ?? null,
        cheapExperiment: d.cheapExperiment ?? null,
      }),
    },
    deps,
  );
  if (!draft.ok) return draft.result;
  const { slug, created } = await deps.createPlanDraft(draft.input);
  const planRef = `plan:${slug}`;
  await deps.recordRoutedIdea({
    ideaId: planRef, // no pre-existing idea id — key the row by its routed artifact
    origin: 'su-ideate',
    rail: 'plan',
    routedRef: planRef,
    lens: d.lens ?? 'su-ideate',
    harnessSlug,
    title: d.title,
    createdBy: identity.ownerId,
    // P-006/EI-10607: the grounding leg — a draft routed without refs can never
    // read as grounded in observationsImpact.
    ...(d.addressesPatternRefs?.length ? { addressesPatternRefs: [...d.addressesPatternRefs] } : {}),
  });
  return { ok: true, rail: 'plan', slug, planRef, created, ideaId: planRef, wiStaysOpen: false };
}

/** Map the outcome onto the tool envelope (isError only for a not-found featureId). */
export function toToolResult(out: RouteIdeaResult): {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
} {
  return {
    content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
    ...(out.ok ? {} : { isError: true }),
  };
}

export default defineTool({
  name: 'blender:route-idea',
  description:
    "Route an su idea onto the PLAN rail: create a DRAFT plan (the owner greenlights it) and record it in the routed-idea ledger (origin='su-ideate') so grade→outcome→feedback learning attributes back to it. Pass `draft {title, framing, mechanism, bet?, cheapExperiment?, lens?}` for a fresh idea, OR `featureId` to re-route an already-filed su feature — that path links the wi to the plan and leaves the wi OPEN for triage. Only rail:'plan' is supported (gym/instance land later).",
  capability: 'harness:write',
  guidance: {
    when: "You have an su IDEATE-pass idea worth a real plan (not just a backlog item). Route a fresh idea with `draft`, or promote an already-filed feature with `featureId`. The draft lands in the Create tab as `status: draft` for owner review.",
    notWhen:
      'A small fix or friction — that is improvements:capture (kind bug/change). Grading a routed idea — blender:grade-idea. gym/instance rails — not wired here yet.',
    chaining:
      'blender:route-idea → the draft plan appears for owner triage; greenlighting it (promoting the draft) starts the normal plan lifecycle, and classifyIdeaOutcome follows the plan:<slug> terminal state so the idea earns won/lost credit automatically.',
    seeAlso: [
      'improvements:capture (file a smaller improvement instead of a plan)',
      'blender:grade-idea (grade a routed idea 1–5)',
      'plans:new (author a plan directly, not through the ideation ledger)',
    ],
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: routeIdeaArgs,
  async handler(args, ctx) {
    return toToolResult(await runRouteIdea(args, ctx));
  },
});
