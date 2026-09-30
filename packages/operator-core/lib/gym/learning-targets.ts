/**
 * Learning-system gym targets (self-learning-frontier P-048 / FB-23) — the
 * learning system's own roles registered as gym targets judged on DRILL ground
 * truth: vaccination's planted frictions (lib/red-queen, FB-20) are the safe,
 * reproducible task battery, and their known answers are the un-gameable judging
 * signals (drill-signals.ts — the plantedBugCaught precedent generalized).
 *
 * The reflexive close (Phase 6): the system's own prompts evolve under the SAME
 * champion/challenger discipline as everything else — proposals land in
 * gym_proposals for human acceptance (D-020), accepted champions ride the
 * behavior-change ledger (control-plane's recordBehaviorChange hook, D-003), and
 * pointing a real harness at a champion still needs the explicit opt-in (D-012).
 * Nothing here adds a new mutation path.
 *
 * Registration is DARK by construction (D-001): created autoloop rows are
 * enabled:false with a null budget — doubly refused by the gym-cycle tick
 * (disabled AND unbudgeted, the D-004 governor rule). Arming (enable + budget)
 * is the P-001 owner act, after the drill task pool is wired live.
 */
import type { Sql } from 'postgres';
import { getAutoloop, setAutoloop } from './control-plane';
import { GYM_SIGNAL_REGISTRY } from './primitives';

/** How the gym can land a champion on this target's prompt layer. */
export type LearningPromptSurface =
  /** harness_prompt_overrides(harnessSlug, role) — the gym's native commit path. */
  | 'prompt-override'
  /** The Queen's triage persona sources (FB-19's lane) — champion = a reviewed source edit. */
  | 'queen-persona'
  /** Prompt built in code (scout lenses.ts; the lensWeights hook is the tunable) — champion = a reviewed source edit. */
  | 'code-constructed';

export interface LearningGymTarget {
  key: 'implement-worker' | 'triage-classifier' | 'scout-ideators';
  title: string;
  /**
   * The prompt-override role a champion mutates (only meaningful for the
   * 'prompt-override' surface; documentary for the others).
   */
  role: string;
  /** The launch blueprint that runs this role, when one exists. */
  blueprintId: string | null;
  promptSurface: LearningPromptSurface;
  /** Drill signal names (GYM_SIGNAL_REGISTRY) that judge this role. */
  signals: readonly string[];
  /**
   * Which red-queen drill classes form its eval pool — '*' = every class (the
   * role sits on the shared detect→triage→fix chain so all drills exercise it).
   */
  drillClasses: readonly string[];
  /** Why this target is judged by these signals — the auditable rationale. */
  rationale: string;
}

/**
 * The three learning-system roles (the FB-23 brief's set). Judging mapping:
 *   - implement worker  → resolve rate + the fix leg of MTTSH
 *   - triage classifier → triage accuracy vs known answers + the triage leg of MTTSH
 *   - Scout ideators    → MTTSH contribution (idea↔drill attribution is the
 *     Phase-B question once red-queen data exists; until then the target is
 *     declared, judged on the corpus-wide signal, and NOT autoloop-registered)
 */
export const LEARNING_GYM_TARGETS: readonly LearningGymTarget[] = Object.freeze([
  {
    key: 'implement-worker',
    title: 'Auto-implement worker (the implement launch blueprint)',
    role: 'worker',
    blueprintId: 'implement',
    promptSurface: 'prompt-override',
    signals: ['drillResolveRate', 'drillMttsh', 'regressionsFromTests'],
    drillClasses: ['*'],
    rationale:
      'The worker fixes whatever the dispatch loop hands it; a planted drill resolved with evidence is the ' +
      'ground-truth pass, mean planted→resolved is its speed, and the repo tests stay the regression guardrail.',
  },
  {
    key: 'triage-classifier',
    title: 'Improvements triage (policy tier + D-005 taxonomy; promptable surface = the Queen triage persona)',
    role: 'queen-triage',
    blueprintId: null,
    promptSurface: 'queen-persona',
    signals: ['drillTriageAccuracy', 'drillMttsh'],
    drillClasses: ['*'],
    rationale:
      'Every drill flows through triage; a drill class pins its expected TriageDecision, so accuracy vs the ' +
      'known answer is directly scoreable. The structural classifier (triage.ts) is code — the promptable ' +
      'evolution surface is the Queen triage persona, so champions are reviewed source edits, not overrides.',
  },
  {
    key: 'scout-ideators',
    title: 'Scout ideator personas (lenses.ts; lensWeights is the existing tunable hook)',
    role: 'scout-ideator',
    blueprintId: null,
    promptSurface: 'code-constructed',
    signals: ['drillMttsh'],
    drillClasses: ['*'],
    rationale:
      'Ideators contribute upstream of the fix (surfacing the friction class); their drill ground truth is the ' +
      'corpus-wide MTTSH contribution until per-idea↔drill attribution exists (Phase B, on real red-queen data).',
  },
]);

/** Every declared signal must resolve in the registry — a typo here would silently skip judging. */
export function validateLearningTargetSignals(): string[] {
  const unknown: string[] = [];
  for (const t of LEARNING_GYM_TARGETS) {
    for (const s of t.signals) {
      if (!Object.prototype.hasOwnProperty.call(GYM_SIGNAL_REGISTRY, s)) unknown.push(`${t.key}:${s}`);
    }
  }
  return unknown;
}

export interface RegisterLearningTargetsInput {
  workspaceId: string;
  /**
   * The configured auto-implement runner harness (plan-implement.ts D-006);
   * null/absent = unconfigured, so the implement-worker autoloop row is skipped
   * (registration never invents a harness slug).
   */
  implementRunnerSlug?: string | null;
}

export interface RegisterLearningTargetsResult {
  /** Targets whose DARK autoloop row was created this call. */
  created: string[];
  /** Targets whose autoloop row already existed — left UNTOUCHED (owner state is sovereign). */
  existing: string[];
  /** Targets with no autoloop row to create and why (no prompt-override surface / runner unconfigured). */
  skipped: Array<{ key: string; reason: string }>;
}

/**
 * Register the learning-system targets with the gym's autoloop control plane —
 * DARK (enabled:false, budget null; the tick doubly refuses). Only targets with
 * a real prompt-override surface AND a configured harness get a row: the
 * gym-cycle machinery can only act on that surface, and a row it would
 * misinterpret (running a code-constructed persona as a generic worker over the
 * synthetic substrate) is worse than no row. Idempotent; NEVER mutates an
 * existing row — an owner's enable/budget survives re-registration.
 */
export async function registerLearningGymTargets(
  sql: Sql,
  input: RegisterLearningTargetsInput,
): Promise<RegisterLearningTargetsResult> {
  const badSignals = validateLearningTargetSignals();
  if (badSignals.length > 0) {
    throw new Error(`learning gym targets declare unknown signals: ${badSignals.join(', ')}`);
  }
  const result: RegisterLearningTargetsResult = { created: [], existing: [], skipped: [] };
  for (const t of LEARNING_GYM_TARGETS) {
    if (t.promptSurface !== 'prompt-override') {
      result.skipped.push({ key: t.key, reason: `surface '${t.promptSurface}' — champion is a reviewed source edit, no autoloop row` });
      continue;
    }
    const slug = input.implementRunnerSlug?.trim();
    if (!slug) {
      result.skipped.push({ key: t.key, reason: 'implement runner harness unconfigured (plan-implement D-006)' });
      continue;
    }
    const existing = await getAutoloop(sql, { workspaceId: input.workspaceId, harnessSlug: slug });
    if (existing) {
      result.existing.push(t.key);
      continue;
    }
    await setAutoloop(sql, { workspaceId: input.workspaceId, harnessSlug: slug, enabled: false, budgetUsd: null });
    result.created.push(t.key);
  }
  return result;
}
