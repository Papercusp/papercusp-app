/**
 * Ideas triage — ONE classification authority + the D-005 taxonomy
 * (self-improvement-consume-edges-2026-06-12 P-021 / D-003 / D-005; resolves EI-364).
 *
 * Before this, an item was classified TWICE in parallel: `triageIdea` ran its own
 * product/process reasoning while `classifyImprovement` (policy.ts) computed the
 * risk tier — with contradictory verdicts and different consumers (an operator-scope
 * bug was tier=auto for the dispatch loop AND process→gate for triage). And with the
 * dogfood Hive targeting papercusp itself, product/process was structurally
 * uninformative: 100/100 open ideas classified process→gate (EI-364).
 *
 * After P-021 there is ONE verdict chain (D-003):
 *   - **policy.ts** computes the safety tier (auto vs human) — the only safety verdict;
 *   - **triage** consumes that tier and adds ONLY the routing dimension: the D-005
 *     taxonomy, keyed off scope + paths + watchdog signal class.
 *
 * The D-005 taxonomy (PROPOSED values — P-004 ratification pending; the lists below
 * are exported tunables so an owner amendment is a config-shaped change):
 *   - `product`           — external-target Hive's code (scope harness:<slug> ≠ papercup)
 *                           → place (the normal pipeline; the per-Hive external-target
 *                           case keeps the product route).
 *   - `code-bug`          — papercusp code-level fix → auto-eligible; the POLICY tier
 *                           decides auto vs human (current policy gates apply).
 *   - `infra-environment` — docker/systemd/env/transport problems → owner-escalate per
 *                           D-002, NEVER auto (a worker cannot fix a port mapping).
 *   - `process-prompt`    — prompt/persona/playbook changes → gym A/B or human gate
 *                           (the existing compounding-class rule, D-003/P-040).
 *   - `needs-design`      — net-new feature-shaped work → a plans:new design draft
 *                           before implementation.
 */

import type { ScoredItem } from './digest';
import { PLATFORM_POT_SLUG, LEGACY_PLATFORM_POT_SLUGS, isPlatformPotScope } from '../../platform-pot-slug';
import {
  matchGlob,
  infraEnvironmentHit,
  watchdogSourceOf,
  INFRA_SIGNAL_SOURCES,
  INFRA_PATH_PATTERNS,
} from './policy';

// Infra-environment detection is owned by the safety layer (policy.ts) so the
// risk tier and the routing taxonomy share ONE vocabulary (D-003) — re-exported
// here for back-compat with existing importers (the D-005 taxonomy's public surface).
export { watchdogSourceOf, INFRA_SIGNAL_SOURCES, INFRA_PATH_PATTERNS };

export type IdeaType = 'product' | 'code-bug' | 'infra-environment' | 'process-prompt' | 'needs-design';
export type TriageDecision = 'place' | 'gate' | 'gym' | 'reject';

export interface IdeaTriageClassification {
  type: IdeaType;
  reason: string;
}

export interface IdeaTriageDecision {
  decision: TriageDecision;
  reason: string;
  /** For 'place': which lane/harness. For 'gate': who gates (human-review / owner-escalation / plans:new). */
  target?: string;
}

/**
 * Structural classifier input — both `ImprovementCandidate` (full fidelity: paths,
 * watchdogKey, kind) and `ScoredItem` satisfy it. Call with the richest shape you
 * have: the taxonomy keys off scope + paths + watchdog signal class (D-005), so a
 * scope-only call degrades to the scope legs.
 */
export interface IdeaClassifierInput {
  scope?: string;
  /** Work-item kind ('feature' = the net-new refinement → needs-design). */
  kind?: string;
  title?: string;
  body?: string;
  paths?: string[];
  /** Stable watchdog identity '<source>:<key>' — the source IS the signal class. */
  watchdogKey?: string;
}

/**
 * Scopes that mean "papercusp itself" — the dogfood case the D-005 taxonomy exists for.
 *
 * ⚠ DERIVED from {@link PLATFORM_POT_SLUG}, never hand-written. This list used to read
 * `['operator', 'harness:papercup']` — the PRE-RENAME spelling — and by the time the Pot
 * was `papercusp` nothing recognised the dogfood scope as self (EI-19370922358009801).
 * Prefer {@link isPapercuspSelfScope} over `.includes()`: the predicate canonicalizes,
 * so a scope carrying any legacy spelling resolves correctly without being enumerated.
 */
export const PAPERCUSP_SELF_SCOPES: readonly string[] = [
  'operator',
  `harness:${PLATFORM_POT_SLUG}`,
  ...LEGACY_PLATFORM_POT_SLUGS.map((s) => `harness:${s}`),
];

/**
 * Does this scope name papercusp ITSELF (the dogfood Pot) rather than an external
 * project's code? `operator` (workspace-global) and every spelling of the platform
 * Pot — current or legacy — answer true.
 *
 * This is the ONE question leg 1 of {@link classifyIdeaType} asks. It must not be a
 * literal comparison: `engineer_issues.scope` is DERIVED (`'harness:' || harness_slug`),
 * so any re-slug of the platform Pot — e.g. the owner-directed migrations 630/631 that
 * moved the workspace's own issues from `operator:<ws>` onto `papercusp` — silently
 * changes the string this branch sees.
 */
export function isPapercuspSelfScope(scope: string | null | undefined): boolean {
  if (!scope) return true; // no scope at all ⇒ not an external project
  const s = scope.trim();
  if (!s.startsWith('harness:')) return true; // 'operator' / workspace-global labels
  return isPlatformPotScope(s);
}

/** Paths that mean the change is a PROMPT/PERSONA/PLAYBOOK edit (the gym-A/B-able class). PROPOSED (P-004). */
export const PROMPT_PATH_PATTERNS: readonly string[] = [
  'apps/operator/prompts/**',
  'libs/papercusp/packages/harness/blueprints/**/prompts/**',
  '**/*.persona.md',
  '**/*.tools.md',
  'packages/operator-core/lib/prompt-assembly*',
];

/**
 * Narrow title/body markers for the prompt class when no paths were captured.
 * Deliberately specific — 'prompt' alone would swallow "permission prompts" etc.
 * PROPOSED (P-004).
 */
export const PROMPT_KEYWORDS: readonly string[] = [
  'persona',
  'playbook',
  'system prompt',
  'spawn prompt',
  'prompt wording',
  '.tools.md',
  '.persona.md',
  'prompt-assembly',
  // '<role> prompt' bigrams — how prompt-change ideas are naturally phrased.
  // A bare 'prompt' keyword would swallow "permission prompts" etc.
  'validator prompt',
  'scoper prompt',
  'architect prompt',
  'worker prompt',
  'reviewer prompt',
  'documenter prompt',
  'curator prompt',
  'queen prompt',
  'judge prompt',
  'ideator prompt',
  'proposer prompt',
  'operator prompt',
  'agent prompt',
  'role prompt',
];

/**
 * Classify an idea into the D-005 taxonomy, keyed off scope + paths + watchdog
 * signal class. Precedence (first hit wins):
 *   1. external-target scope → `product` (the per-Hive case keeps the product route);
 *   2. infra signal class OR infra paths → `infra-environment`;
 *   3. kind=feature (net-new) → `needs-design`;
 *   4. prompt paths/keywords → `process-prompt`;
 *   5. everything else in the dogfood scope → `code-bug`.
 *
 * The taxonomy is the ROUTING dimension only — the safety verdict (auto vs human)
 * stays with policy.ts (`classifyImprovement`), consumed by `triageIdea` (D-003).
 */
export function classifyIdeaType(item: IdeaClassifierInput): IdeaTriageClassification {
  // 1. External-target Hive → product (the harness's own code rides its pipeline).
  //    The self check CANONICALIZES (isPapercuspSelfScope) rather than comparing
  //    literals — see EI-19370922358009801 for what a stale literal costs here.
  if (item.scope && item.scope.startsWith('harness:') && !isPapercuspSelfScope(item.scope)) {
    return { type: 'product', reason: `Scope "${item.scope}" targets an external project's code` };
  }

  // 2. Infra/environment — the safety layer's shared predicate (signal class is the
  //    strongest key — a service-down/circuit-open firing IS an environment fact —
  //    infra paths the fallback). D-003: ONE vocabulary, owned by policy.ts, so the
  //    risk tier (classifyImprovement) and this routing taxonomy never disagree.
  const infraHit = infraEnvironmentHit(item);
  if (infraHit) {
    return { type: 'infra-environment', reason: `${infraHit} — infra-class (D-002: escalate, never auto)` };
  }

  // 3. Net-new work → a design draft before implementation.
  if (item.kind === 'feature') {
    return { type: 'needs-design', reason: 'kind=feature (net-new) — needs a design draft before implementation' };
  }

  // 4. Prompt/persona/playbook — the gym-A/B-able compounding class.
  const promptPath = (item.paths ?? []).find((p) => PROMPT_PATH_PATTERNS.some((pat) => matchGlob(pat, p)));
  if (promptPath) {
    return { type: 'process-prompt', reason: `Path "${promptPath}" is a prompt source (gym-A/B-able class)` };
  }
  const hay = `${item.title ?? ''} ${item.body ?? ''}`.toLowerCase();
  const promptKw = PROMPT_KEYWORDS.find((k) => hay.includes(k.toLowerCase()));
  if (promptKw) {
    return { type: 'process-prompt', reason: `Mentions "${promptKw}" — prompt/persona change (gym-A/B-able class)` };
  }

  // 5. Default for the dogfood scope: a papercusp code-level fix.
  // allow-scope-default: display fallback — "operator" is the explicit top-level scope label, not a workspace.
  return { type: 'code-bug', reason: `Scope "${item.scope ?? 'operator'}" — papercusp code-level fix (policy tier decides the lane)` };
}

/**
 * Triage an idea — the ROUTING verdict, derived from the taxonomy + the policy tier.
 *
 * D-003 (one classification authority): this function NEVER re-derives safety. The
 * policy verdict already on the ScoredItem (`tier` + `tierReason`, computed by
 * `classifyImprovement` in the digest) is consumed as-is; triage adds only WHERE the
 * item goes:
 *   - product           → place (target Hive's pipeline)
 *   - code-bug          → tier=auto → place into the auto-implement lane;
 *                         tier=human → gate, citing the POLICY's reason verbatim
 *   - infra-environment → gate to owner-escalation (D-002 — never auto)
 *   - process-prompt    → gate (human or gym A/B — P-040: the Queen may override to
 *                         'gym'; recurrence-escalation auto-routes chronic ones)
 *   - needs-design      → gate to plans:new (a design draft, then re-enter)
 *
 * The Queen applies discretion on top via improvements:triage { decision } — this is
 * the deterministic recommendation the scheduled pass persists.
 */
export function triageIdea(item: ScoredItem): IdeaTriageDecision {
  const type = item.ideaType ?? classifyIdeaType(item).type;

  switch (type) {
    case 'product':
      return {
        decision: 'place',
        reason: `product idea — targets ${item.scope} (external Hive); rides the normal pipeline`,
        target: item.scope,
      };
    case 'code-bug':
      if (item.tier === 'auto') {
        return {
          decision: 'place',
          reason: `code-bug, policy tier=auto (${item.tierReason}) — auto-implement lane (D-003: one verdict chain)`,
          target: 'auto-implement',
        };
      }
      return {
        decision: 'gate',
        reason: `code-bug, policy tier=human (${item.tierReason}) — human gate per the policy verdict (D-003)`,
        target: 'human-review',
      };
    case 'infra-environment':
      return {
        decision: 'gate',
        reason: 'infra/environment problem — owner-escalates per D-002 (never auto: a worker cannot fix a port mapping)',
        target: 'owner-escalation',
      };
    case 'process-prompt':
      return {
        decision: 'gate',
        reason: 'process/prompt change — human gate or gym A/B before live (compounding class, D-003/P-040)',
        target: 'human-review',
      };
    case 'needs-design':
      return {
        decision: 'gate',
        reason: 'net-new feature — needs a design draft (plans:new) before implementation (D-005)',
        target: 'plans:new',
      };
  }
}

/**
 * Extract cross-referenced work-item/issue ids an idea's title+body cites as
 * supporting EVIDENCE (e.g. "cites EI-5834, EI-5846..."). Recognizes the
 * EI-/WI-/F- id families used across this repo. Order-preserving, deduped.
 *
 * Used by the pre-place evidence-staleness guard (triage-core.ts,
 * EI-18696839552593260 — 12 near-duplicate Scout ideas were all auto-triaged
 * 'place' although each one's OWN cited evidence already stated the premise
 * they argued from): an idea whose every citation is already terminal with a
 * completion ref is a strong signal its premise may be stale.
 */
export function extractCitedIds(text: string | null | undefined): string[] {
  if (!text) return [];
  const re = /\b(?:EI|WI|F)-\d+\b/g;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of text.match(re) ?? []) {
    if (!seen.has(m)) {
      seen.add(m);
      out.push(m);
    }
  }
  return out;
}

/**
 * Generate a triage summary for the Queen to read: which ideas got which decisions,
 * and why. Used in the digest broadcast or the Queen's decision log.
 */
export interface TriageSummary {
  total: number;
  byDecision: Record<TriageDecision, number>;
  byType: Record<IdeaType, number>;
  highlights: string[];
}

export function summarizeTriages(items: ScoredItem[]): TriageSummary {
  const byDecision: Record<TriageDecision, number> = {
    place: 0,
    gate: 0,
    gym: 0,
    reject: 0,
  };
  const byType: Record<IdeaType, number> = {
    'product': 0,
    'code-bug': 0,
    'infra-environment': 0,
    'process-prompt': 0,
    'needs-design': 0,
  };
  const highlights: string[] = [];

  for (const item of items) {
    const type = item.ideaType ?? classifyIdeaType(item).type;
    const decision = triageIdea(item);

    byType[type] += 1;
    byDecision[decision.decision] += 1;

    // Highlight high-priority ideas
    if (item.score >= 40 && decision.decision === 'place') {
      highlights.push(`${item.title} (${type}, high-priority)`);
    } else if (item.score >= 40 && decision.decision === 'gate') {
      highlights.push(`${item.title} (${type}, ${decision.target ?? 'gated'})`);
    }
  }

  return {
    total: items.length,
    byDecision,
    byType,
    highlights: highlights.slice(0, 5), // Top 5
  };
}
