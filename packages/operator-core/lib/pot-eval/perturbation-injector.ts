/**
 * perturbation-injector.ts — the typed seam the discriminator scenarios drive
 * (plan-implementation-framework-2026-06-15 P-013, activation of P-008).
 *
 * A discriminator scenario (discriminator-scenarios.ts) declares a mid-run PERTURBATION
 * (kill-queen / rewrite-spec / spread-swarms). This module is the pure DISPATCH seam: parse
 * the action, route it to a bound injector, and SAFELY no-op when nothing is bound or the
 * action is unknown — so the discriminator corpus is inert until the live rig binds injectors.
 *
 * The real injectors (actually killing a Swarm / rewriting an in-flight spec / spreading bees
 * across N Swarms) live on the full-loop multi-swarm rig (lib/deployment/p2p-perf-tier3) and
 * are the OWNER-BUDGETED deepest activation — bound here via PerturbationInjectors, NOT built.
 */
import type { DiscriminatorScenario } from './discriminator-scenarios';

export type PerturbationKind = 'kill-queen' | 'rewrite-spec' | 'spread-swarms';

export interface PerturbationContext {
  scenario: DiscriminatorScenario;
  /** The raw action string (e.g. 'spread-swarms:3'). */
  action: string;
  kind: PerturbationKind;
  /** The optional action arg (e.g. '3' from 'spread-swarms:3'). */
  arg?: string;
  /** Opaque handle to the running hive — the live rig binds it. */
  hiveRunRef?: unknown;
}

export interface PerturbationOutcome {
  applied: boolean;
  action: string;
  note: string;
}

/** One perturbation injector — the live rig implements it; the dispatch routes to it by kind. */
export type PerturbationInjector = (ctx: PerturbationContext) => Promise<PerturbationOutcome>;

/** Per-kind injector bindings (all optional — an unbound kind is a safe no-op). */
export type PerturbationInjectors = Partial<Record<PerturbationKind, PerturbationInjector>>;

const KNOWN_KINDS = new Set<string>(['kill-queen', 'rewrite-spec', 'spread-swarms']);

/** Parse an action string ('spread-swarms:3') into its kind + optional arg. Pure. */
export function parsePerturbationAction(action: string): { kind: PerturbationKind | 'unknown'; arg?: string } {
  const idx = action.indexOf(':');
  const head = idx >= 0 ? action.slice(0, idx) : action;
  const arg = idx >= 0 ? action.slice(idx + 1) : undefined;
  if (KNOWN_KINDS.has(head)) return { kind: head as PerturbationKind, ...(arg ? { arg } : {}) };
  return { kind: 'unknown' };
}

/** The no-op default injector — does nothing (safe). Used until the live rig is bound. */
export const noopPerturbationInjector: PerturbationInjector = async (ctx) => ({
  applied: false,
  action: ctx.action,
  note: 'no-op perturbation injector (live rig not bound)',
});

/**
 * Dispatch a scenario's perturbation through the bound injectors: parse the action, guard an
 * unknown action (safe no-op), and call the per-kind injector (or no-op when unbound). Never
 * throws for an unknown/unbound action — the discriminator stays inert, not broken.
 */
export async function injectPerturbation(
  scenario: DiscriminatorScenario,
  injectors: PerturbationInjectors = {},
): Promise<PerturbationOutcome> {
  const action = scenario.perturbation.action;
  const { kind, arg } = parsePerturbationAction(action);
  if (kind === 'unknown') {
    return { applied: false, action, note: `unknown perturbation action '${action}' — skipped (safe no-op)` };
  }
  const injector = injectors[kind];
  if (!injector) {
    return { applied: false, action, note: `no injector bound for '${kind}' — no-op (the live rig is the activation)` };
  }
  return injector({ scenario, action, kind, ...(arg ? { arg } : {}) });
}
