/**
 * SPEC TRIAD — the POLICY half (the pure detector is
 * `evaluateSpecTriad` in @papercusp/plan-parser).
 *
 * okf-frontmatter-adoption workstream H(b). The borrow is Kiro's
 * requirements/design/tasks triad per feature; the adaptation is that it lives
 * as structure INSIDE a plan rather than as a second directory convention
 * competing with plans.
 *
 * ## Why this module exists at all, instead of the one-line rule
 *
 * The design said the sections "must be non-empty before items can be marked
 * actionable". Taken literally that is one predicate and no policy — and it was
 * MEASURED against the live corpus before being built (2026-08-08,
 * papercusp/papercusp-workspace): of 1000 plans, **0** carried
 * `## Requirements`, 51 carried `## Design`, **0 carried both**, and 330 were
 * live. `actionable` is `effectiveStatus === 'todo'`, which is what plan-driven
 * dispatch runs on — so the rule as written turns every plan item in the
 * install non-actionable in one step and freezes the fleet.
 *
 * That failure has a recognisable shape, and it bit twice in one hour in two
 * unrelated subsystems the day this was designed: **a correct-looking positive
 * predicate over a field nothing populates yet.** It never errors; it silently
 * selects the empty set. The other instance was a fleet claim spec filtering
 * `plan = <slug>` against a NULLABLE column, where SQL three-valued logic
 * dropped all 16,942 open rows and starved the lane.
 *
 * ## What makes the same rule safe
 *
 * Three properties, none of which is a promise to be careful:
 *
 *  1. **An EPOCH.** The requirement applies only to plans CREATED AFTER it. A
 *     plan authored under the old rule is never retroactively gated, so the set
 *     of gated plans starts empty and grows only as plans are written under the
 *     new rule — plans whose authors were told the rule.
 *  2. **An explicit opt-in and opt-out**, declared in plan frontmatter
 *     (`specTriad: required` / `specTriad: exempt`). The opt-out is what keeps
 *     this from ever becoming a wall: a plan with a genuine reason not to carry
 *     the triad says so in one line and moves on.
 *  3. **Auto-file, never freeze-and-wait.** A plan that owes the triad gets a
 *     work item filed for it (see `spec-triad-sweep.ts`) which any agent can
 *     claim. The gate resolves itself through the ordinary work queue rather
 *     than routing a decision to a person — no human gate, per the standing
 *     design mandate.
 *
 * Every ambiguous input FAILS OPEN (not in scope, therefore not gated):
 * unparseable `created`, absent `created`, a plan whose content cannot be read.
 * The gate's job is to raise the floor for new work, never to strand old work.
 */

import { evaluateSpecTriad, type SpecTriadVerdict, type SpecTriadLegName } from '@papercusp/plan-parser';

/**
 * Plans created at or after this instant are in scope. Set to the date workstream
 * H(b) landed: every plan already in the corpus predates it, so arming the flag
 * gates exactly zero existing plans.
 *
 * Overridable via `PAPERCUSP_SPEC_TRIAD_EPOCH` (an ISO date) — mainly so a test
 * can put the epoch in the past without rewriting fixtures, and so an operator
 * can move it forward if a wave of plans needs a grace period. An unparseable
 * value falls back to the default rather than throwing: a bad env var must not
 * be able to move the epoch to 1970 and retro-gate the whole corpus.
 */
export const SPEC_TRIAD_EPOCH_DEFAULT = '2026-08-09T00:00:00.000Z';

export const SPEC_TRIAD_EPOCH_ENV = 'PAPERCUSP_SPEC_TRIAD_EPOCH';

export function specTriadEpoch(env: NodeJS.ProcessEnv = process.env): Date {
  const raw = env[SPEC_TRIAD_EPOCH_ENV];
  if (raw) {
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date(SPEC_TRIAD_EPOCH_DEFAULT);
}

export type SpecTriadDeclaration = 'required' | 'exempt' | null;

/**
 * The plan's own `specTriad:` frontmatter declaration, read straight from the
 * leading `---` block. Deliberately NOT routed through the parser's typed
 * frontmatter: this is a policy key, and the policy owning its own read means
 * adding it never widens the parser's public type.
 */
export function readSpecTriadDeclaration(content: string): SpecTriadDeclaration {
  const lines = content.split('\n');
  if (lines[0]?.trimEnd() !== '---') return null;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trimEnd() === '---') break;
    const m = /^specTriad:\s*["']?(required|exempt)["']?\s*$/i.exec(lines[i] ?? '');
    if (m) return m[1].toLowerCase() as SpecTriadDeclaration;
  }
  return null;
}

export type SpecTriadScopeReason =
  | 'flag-off'
  | 'exempt-declared'
  | 'required-declared'
  | 'created-after-epoch'
  | 'created-before-epoch'
  | 'created-unknown'
  | 'template-excluded';

/**
 * Plan-store TEMPLATES that are never subject to the spec triad (WI-10004229, WI-10005441).
 *
 * An acceptance rubric (`template: rubric`) is stored in the plan store, but it
 * is a grading BAR, not a plan with work to promote: it carries no P-NNN items
 * and no `## Requirements` / `## Design` by design. A "write the spec triad"
 * filing against one has no correct resolution. An agent that followed it
 * would rewrite the rubric's content under an in-flight vetting attestation or
 * independent grade. Measured 2026-09-30: 335 rubric rows in
 * papercusp-workspace, and at least 8 open filings against them.
 *
 * It lives HERE, in the shared scope verdict, so every filer agrees. Until
 * WI-10005441 only the daily sweep applied it; the promotion runner's own gate
 * did not, and kept filing against rubric rows (25 on 2026-10-02 alone).
 */
export const SPEC_TRIAD_EXCLUDED_TEMPLATES: readonly string[] = ['rubric'];

/** True when a plan row's `template` puts it outside the triad (and outside promotion). */
export function isSpecTriadExcludedTemplate(template: string | null | undefined): boolean {
  return typeof template === 'string' && SPEC_TRIAD_EXCLUDED_TEMPLATES.includes(template);
}

export interface SpecTriadScope {
  inScope: boolean;
  reason: SpecTriadScopeReason;
}

export interface SpecTriadPlanInput {
  planSlug?: string;
  content: string;
  /** The plan's frontmatter-derived `created` date, as PlanRow carries it. */
  created: string | null;
  /** Task count from the PG-canonical item index, when the caller has it. */
  itemCount?: number;
  /** `harness_plans.template`, when the caller has it; an excluded template is never in scope. */
  template?: string | null;
}

export interface SpecTriadOptions {
  flagEnabled: boolean;
  epoch?: Date;
}

/**
 * Is this plan subject to the triad requirement? Precedence, highest first:
 * flag → explicit declaration → creation date. Anything undecidable is OUT of
 * scope.
 */
export function planInSpecTriadScope(
  plan: SpecTriadPlanInput,
  opts: SpecTriadOptions,
): SpecTriadScope {
  if (!opts.flagEnabled) return { inScope: false, reason: 'flag-off' };
  // Before the declaration: a rubric row is not a plan, whatever its body says.
  if (isSpecTriadExcludedTemplate(plan.template)) return { inScope: false, reason: 'template-excluded' };

  const declared = readSpecTriadDeclaration(plan.content);
  if (declared === 'exempt') return { inScope: false, reason: 'exempt-declared' };
  if (declared === 'required') return { inScope: true, reason: 'required-declared' };

  if (!plan.created) return { inScope: false, reason: 'created-unknown' };
  const created = new Date(plan.created);
  if (Number.isNaN(created.getTime())) return { inScope: false, reason: 'created-unknown' };

  const epoch = opts.epoch ?? specTriadEpoch();
  return created.getTime() >= epoch.getTime()
    ? { inScope: true, reason: 'created-after-epoch' }
    : { inScope: false, reason: 'created-before-epoch' };
}

export interface SpecTriadGateVerdict {
  /** True ⇒ this plan's items are held back from `actionable`. */
  gated: boolean;
  scope: SpecTriadScope;
  /** The triad evaluation. `null` when the plan is out of scope (not evaluated). */
  triad: SpecTriadVerdict | null;
  missing: SpecTriadLegName[];
  /** Agent-facing explanation, present only when `gated`. */
  note: string | null;
}

const NOT_GATED = (scope: SpecTriadScope): SpecTriadGateVerdict => ({
  gated: false,
  scope,
  triad: null,
  missing: [],
  note: null,
});

/**
 * The gate verdict for one plan. Out-of-scope plans short-circuit BEFORE the
 * detector runs — so the common path (every plan predating the epoch) costs one
 * date comparison and never parses anything.
 */
export function specTriadGate(
  plan: SpecTriadPlanInput,
  opts: SpecTriadOptions,
): SpecTriadGateVerdict {
  const scope = planInSpecTriadScope(plan, opts);
  if (!scope.inScope) return NOT_GATED(scope);

  const triad = evaluateSpecTriad(plan.content, { itemCount: plan.itemCount });
  if (triad.complete) return { gated: false, scope, triad, missing: [], note: null };

  return {
    gated: true,
    scope,
    triad,
    missing: triad.missing,
    note:
      `plan '${plan.planSlug ?? '?'}' owes the spec triad (${triad.missing.join(', ')}) — ` +
      `its items are held back from \`actionable\` until the sections are written. ` +
      `A work item to write them is filed automatically; claim it, or declare ` +
      `\`specTriad: exempt\` in the plan frontmatter if the triad genuinely does not apply.`,
  };
}
