/**
 * discriminator-scenarios.ts — the SYMMETRIC discriminator scenarios for the framework
 * bake-off (plan-implementation-framework-2026-06-15 P-008; D-006 impartiality).
 *
 * The base hive-eval corpus (scenarios.ts) scores OUTCOME QUALITY on static DAGs — that
 * already exercises the outcome-quality bets (compiled briefs). The discriminators add a
 * mid-run PERTURBATION so each perturbation-sensitive bet is tested on its HOME TURF:
 *   • crash-recovery     → the durable-record bets (amend / expand) survive a Queen/Swarm kill.
 *   • requirements-shift  → the framework must KEEP the dynamism (the owner's worry); the bets
 *     must not regress the lazy baseline, and amend/expand record the shift-driven re-decomposition.
 *   • multi-swarm         → the exclusion bet's home turf (cross-machine file thrash within a hive).
 * Impartiality (D-006): a fair bake-off tests each bet where it SHOULD win, not only where it
 * is neutral — so neither the new framework nor the lazy baseline is rigged.
 *
 * This module is the DECIDEABLE CORE — the scenario SPECS + the symmetric mapping, pure +
 * unit-tested (each spec resolves to a real base DAG; the mapping covers every perturbation-
 * sensitive bet). The live PERTURBATION FIXTURES (actually killing a Swarm / rewriting a spec
 * mid-run / spreading bees across N Swarms — the full-loop multi-swarm rig at
 * lib/deployment/p2p-perf-tier3/) are the documented ACTIVATION, not built here.
 */
import { FLAGS } from '@papercusp/flags';
import { getScenario } from './scenarios';

export type DiscriminatorKind = 'crash-recovery' | 'requirements-shift' | 'multi-swarm';

export interface DiscriminatorScenario {
  id: string;
  kind: DiscriminatorKind;
  title: string;
  /** The base corpus scenario this perturbs (reuses its DAG + seed-app sandbox). */
  baseScenarioId: string;
  perturbation: {
    description: string;
    /** Fraction of the run [0,1] at which the perturbation fires. */
    atProgress: number;
    /** The fixture action the live rig performs (the activation). */
    action: string;
  };
  /** The bet flag(s) this discriminator is the HOME TURF for — it should win here if the bet works. */
  favorsBets: readonly string[];
  /** The discriminating metric. */
  measures: string;
  rationale: string;
}

export const DISCRIMINATOR_SCENARIOS: readonly DiscriminatorScenario[] = [
  {
    id: 'crash-recovery',
    kind: 'crash-recovery',
    title: 'Crash-recovery — kill the steering Queen mid-run',
    baseScenarioId: 'deep-chain', // a long run with in-flight state to lose
    perturbation: {
      description: 'Kill the steering Queen (or a Swarm) at the half-way mark, then let the hive recover.',
      atProgress: 0.5,
      action: 'kill-queen',
    },
    favorsBets: [FLAGS.WORKITEM_AMEND, FLAGS.DEFERRED_EXPANSION],
    measures:
      'work re-done + time-to-recover after the kill (durably-recorded amendments/expansions survive; ephemeral reasoning is lost)',
    rationale:
      "The durable-record bets' home turf: a crash is exactly when a written-down structural decision pays off — the lazy baseline loses the in-flight decomposition, the recorded version resumes.",
  },
  {
    id: 'requirements-shift',
    kind: 'requirements-shift',
    title: 'Requirements-shift — rewrite a work-item spec mid-run',
    baseScenarioId: 'wide-fanout',
    perturbation: {
      description: "Rewrite one in-flight work-item's spec (the requirement changes) at 40% progress.",
      atProgress: 0.4,
      action: 'rewrite-spec',
    },
    favorsBets: [FLAGS.WORKITEM_AMEND, FLAGS.DEFERRED_EXPANSION],
    measures:
      'correctness + adaptation cost after the shift (must NOT regress the lazy baseline — the dynamism guard; amend/expand record the re-decomposition)',
    rationale:
      "The owner's worry made a test: does the framework keep the late-binding dynamism when the right answer changes mid-flight? A regression here vs the lazy baseline kills the bet.",
  },
  {
    id: 'multi-swarm',
    kind: 'multi-swarm',
    title: 'Multi-Swarm — spread bees across 3 Swarms of one hive',
    baseScenarioId: 'wide-fanout', // independent feats, parallelizable
    perturbation: {
      description: 'Run the scenario with bees spread across 3 Swarms (machines) of one hive instead of one.',
      atProgress: 0,
      action: 'spread-swarms:3',
    },
    favorsBets: [FLAGS.TOUCH_SET_EXCLUSION],
    measures:
      'parallel speedup vs ideal + cross-machine thrash (re-placements, merge conflicts) — exclusion should cut cross-Swarm file collisions',
    rationale:
      "The exclusion bet's home turf: across Swarms there is no shared filesystem lock, so proactive touch-set admission should cut the cross-machine merge thrash a file-lock-only baseline incurs.",
  },
];

/** The bets whose value only shows under a perturbation (must each have a home-turf discriminator). */
export const PERTURBATION_SENSITIVE_BETS: readonly string[] = [
  FLAGS.WORKITEM_AMEND,
  FLAGS.DEFERRED_EXPANSION,
  FLAGS.TOUCH_SET_EXCLUSION,
];

/** The discriminators that are the home turf for a bet flag (empty ⇒ covered by the base corpus). */
export function discriminatorsFor(flagKey: string): DiscriminatorScenario[] {
  return DISCRIMINATOR_SCENARIOS.filter((d) => d.favorsBets.includes(flagKey));
}

/** Lookup a discriminator by id. */
export function getDiscriminator(id: string): DiscriminatorScenario | undefined {
  return DISCRIMINATOR_SCENARIOS.find((d) => d.id === id);
}
