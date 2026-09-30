/**
 * Declared injection points (portable-identity-packages-2026-09-26 P-010; D-009).
 *
 * A provider contribution names WHERE its output lands (sinks), WHEN it is
 * evaluated (trigger), how much of the sink it may ask for (tokenBudget), how it
 * ranks against every other identity's contribution at the same sink
 * (priority) and what happens when its produced text exceeds what the host
 * granted it (overBudget).
 *
 * ⚠ The declaration is a REQUEST, never an allowance. The host owns ONE
 * aggregate token and wall-clock budget per sink invocation and allocates it
 * across every contributing identity in deterministic priority order
 * (`operator-core/lib/agent-identities/sink-evaluator.ts`). A package that
 * declares a large `tokenBudget`, or ships many contributions, cannot multiply
 * the sink allowance — that is the PORTABLE-P-010 falsifier.
 *
 * The vocabulary lives here, beside the blueprint schema, so the schema, the
 * composition compiler and the operator's orientation registry all read ONE
 * list. `OrientationSink` in operator-core is derived from
 * {@link INJECTION_SINKS}; it is not a parallel hand-maintained union.
 */
import { z } from 'zod';

/**
 * Every orientation sink the host knows. Order is not meaningful.
 *
 * `leader-brief` and `carry-brief` are STRUCTURED payloads that consume
 * registry classes by id (plan orientation D-053), not rendered lines, so a
 * package-declared class has nothing they could consume: see
 * {@link PACKAGE_RENDERABLE_SINKS}.
 */
export const INJECTION_SINKS = ['turn-start', 'leader-brief', 'carry-brief', 'agent-orders'] as const;
export type InjectionSink = (typeof INJECTION_SINKS)[number];

/** The sinks that render `segments[].render` lines and so can carry a package class. */
export const PACKAGE_RENDERABLE_SINKS = ['turn-start', 'agent-orders'] as const satisfies readonly InjectionSink[];
export type PackageRenderableSink = (typeof PACKAGE_RENDERABLE_SINKS)[number];

/**
 * The client hook points a `delivery:'sync'` rule package runs at (P-011; D-023).
 * One client-neutral adapter maps each to the Claude and Codex hook event:
 * `turn-start` → UserPromptSubmit, `pre-tool` → PreToolUse, `post-tool` → the
 * mid-turn port (Claude PostToolBatch, Codex PostToolUse), `stop` → Stop,
 * `compaction` → SessionStart with source `compact`.
 */
export const HOOK_SINKS = ['turn-start', 'pre-tool', 'post-tool', 'stop', 'compaction'] as const;
export type HookSink = (typeof HOOK_SINKS)[number];

/** The hook sinks that carry context. `pre-tool` carries only guard verdicts: a
 * context hook never votes on a pending call. */
export const HOOK_CONTEXT_SINKS = ['turn-start', 'post-tool', 'stop', 'compaction'] as const satisfies readonly HookSink[];
export type HookContextSink = (typeof HOOK_CONTEXT_SINKS)[number];

/** The hook sinks that fire per tool call, the only ones a `tools` filter applies to. */
export const HOOK_TOOL_SINKS = ['pre-tool', 'post-tool'] as const satisfies readonly HookSink[];
export type HookToolSink = (typeof HOOK_TOOL_SINKS)[number];

/** Host clamps; a declaration outside them is refused at compile, not silently clamped. */
export const INJECTION_TOKEN_BUDGET_MAX = 2_000;
export const INJECTION_PRIORITY_MIN = 0;
export const INJECTION_PRIORITY_MAX = 100;

/** Catalogued event keys are `family:rest` (events:catalog). */
const EVENT_KEY = /^[a-z][a-z0-9-]*(?::[A-Za-z0-9._@/*-]+)+$/;

export const InjectionTriggerSchema = z.union([
  z.literal('every-turn'),
  z.literal('mode-change'),
  z.literal('on-demand'),
  z.object({ event: z.string().regex(EVENT_KEY, 'a trigger event must be a catalogued family:key') }).strict(),
]);
export type InjectionTrigger = z.infer<typeof InjectionTriggerSchema>;

export const InjectionPointSchema = z
  .object({
    sinks: z.array(z.enum(INJECTION_SINKS)).min(1),
    trigger: InjectionTriggerSchema,
    tokenBudget: z.number().int().min(1).max(INJECTION_TOKEN_BUDGET_MAX),
    priority: z.number().int().min(INJECTION_PRIORITY_MIN).max(INJECTION_PRIORITY_MAX),
    overBudget: z.enum(['truncate', 'omit']),
  })
  .strict();
export type InjectionPoint = z.infer<typeof InjectionPointSchema>;

/** The subset of a contribution the injection rules read (schema-agnostic). */
export interface InjectionContributionShape {
  readonly id: string;
  readonly purpose: string;
  readonly source: string;
  readonly refresh: string;
  readonly inputKind: string;
  readonly injection?: unknown;
}

export interface InjectionIssue {
  readonly contributionId: string;
  readonly path: readonly (string | number)[];
  readonly message: string;
}

/** The refresh cadence a trigger is evaluated on. */
export function refreshForTrigger(trigger: InjectionTrigger): 'turn' | 'on-demand' {
  return trigger === 'on-demand' ? 'on-demand' : 'turn';
}

/**
 * PURE compile-time validation of one contribution's injection point. Returns
 * every issue rather than the first so an author fixes the declaration in one
 * pass. A contribution with no `injection` is valid (it is not an injection
 * point — its output is bound but never rendered into a sink).
 */
export function validateInjectionPoint(contribution: InjectionContributionShape): InjectionIssue[] {
  if (contribution.injection === undefined) return [];
  const issues: InjectionIssue[] = [];
  const add = (path: (string | number)[], message: string) =>
    issues.push({ contributionId: contribution.id, path: ['injection', ...path], message });
  const parsed = InjectionPointSchema.safeParse(contribution.injection);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) add(issue.path as (string | number)[], issue.message);
    return issues;
  }
  const point = parsed.data;
  if (contribution.source !== 'provider') {
    add([], 'only provider output is injected at a sink; fixed content is part of the compiled prompt');
  }
  const injectable =
    (contribution.purpose === 'prompt' && contribution.inputKind === 'prompt-file') ||
    (contribution.purpose === 'resource' && contribution.inputKind === 'capability-provider');
  if (!injectable) {
    add([], `${contribution.purpose}/${contribution.inputKind} output has no text to inject`);
  }
  const seen = new Set<string>();
  point.sinks.forEach((sink, index) => {
    if (seen.has(sink)) add(['sinks', index], `sink ${sink} is declared twice`);
    seen.add(sink);
    if (!(PACKAGE_RENDERABLE_SINKS as readonly string[]).includes(sink)) {
      add(['sinks', index], `${sink} is a structured sink that consumes built-in classes by id; a package class cannot target it`);
    }
  });
  const cadence = refreshForTrigger(point.trigger);
  if (contribution.refresh !== cadence) {
    add(['trigger'], `trigger ${JSON.stringify(point.trigger)} is evaluated on refresh '${cadence}', but the contribution declares '${contribution.refresh}'`);
  }
  return issues;
}

/** Validate every contribution; ids are unique per blueprint by the schema. */
export function validateInjectionPoints(contributions: readonly InjectionContributionShape[] | undefined): InjectionIssue[] {
  return (contributions ?? []).flatMap((contribution) => validateInjectionPoint(contribution));
}
