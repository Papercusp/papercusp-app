/**
 * Runtime Scout workspace-budget overrides (live-configurability-audit-2026-06-20 P-022).
 *
 * The workspace-wide Scout spend ceiling (scout-ceiling.ts / P-051) was tunable ONLY through the
 * `PAPERCUSP_SCOUT_WORKSPACE_CEILING_USD` env — a baked env value-gate that needed a host restart to
 * change (the exact class this audit kills, P-023). This module is the runtime OVERRIDE: an
 * operator-state row (`operator_scout_budget`) consulted IN FRONT of the env, set live via
 * `learning:set-scout-budget`.
 *
 * Resolution order (resolveScoutWorkspaceCeilingUsdLive):
 *   1. the PG override (`workspaceCeilingUsd`, when a finite ≥ 0 number) — set by the dial;
 *   2. the env (`PAPERCUSP_SCOUT_WORKSPACE_CEILING_USD`, when it parses to finite ≥ 0);
 *   3. DEFAULT_SCOUT_WORKSPACE_CEILING_USD (core.ts, 10.0).
 *
 * NOT flag-gated: an EMPTY override row (the default) falls straight through to the env/default, so
 * with no override set the gate is byte-identical to before this seam — the override only bites once
 * an operator sets a value (the operational-dial pattern: P-005 opus_budget, P-006 scale_policy, …).
 * The consumer (scoutWorkspaceCeilingGate) is ASYNC and infrequent (cadence-gated), so the override
 * read is a plain async PG read — no hot-path sync cache needed (unlike the dispatch-step P-009 dial).
 *
 * Deps are injectable so scout-budget-overrides.test.ts covers the resolution order with zero PG.
 *
 * This module deliberately imports ONLY `./core` (the DEFAULT constant) so there is no import cycle
 * with scout-ceiling.ts (which re-exports `resolveScoutWorkspaceCeilingUsd` from here and consumes
 * `resolveScoutWorkspaceCeilingUsdLive` for its default dep).
 */
import { DEFAULT_SCOUT_WORKSPACE_CEILING_USD } from './core';
import { readOperatorState, writeOperatorState } from '../operator-state-pg';
import { registerOverrideConcern, type OverrideEntry } from '../config-overrides/registry';

const STATE_TABLE = 'operator_scout_budget' as const;

/** The runtime Scout-budget override payload (operator_scout_budget). */
export interface ScoutBudgetOverrides {
  /** Workspace-wide Scout spend ceiling in USD, overriding the env/default. Finite ≥ 0. */
  workspaceCeilingUsd?: number;
}

const finiteNonNeg = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;

/**
 * Resolve the workspace ceiling from the ENV (no override) — the base layer.
 * The env override (`PAPERCUSP_SCOUT_WORKSPACE_CEILING_USD`) when it parses to a finite ≥ 0 number,
 * else {@link DEFAULT_SCOUT_WORKSPACE_CEILING_USD}. (0 is an honest cap — "no scout spend allowed".)
 *
 * Re-exported from scout-ceiling.ts for back-compat (its original home).
 */
export function resolveScoutWorkspaceCeilingUsd(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PAPERCUSP_SCOUT_WORKSPACE_CEILING_USD;
  if (raw === undefined || raw === '') return DEFAULT_SCOUT_WORKSPACE_CEILING_USD;
  const n = Number(raw);
  return finiteNonNeg(n) ? n : DEFAULT_SCOUT_WORKSPACE_CEILING_USD;
}

// ── async read/write (the dial + the live resolver) ───────────────────────────
export async function readScoutBudgetOverrides(): Promise<ScoutBudgetOverrides> {
  return (await readOperatorState<ScoutBudgetOverrides>(STATE_TABLE)) ?? {};
}

async function persist(next: ScoutBudgetOverrides): Promise<ScoutBudgetOverrides> {
  await writeOperatorState<ScoutBudgetOverrides>(STATE_TABLE, next);
  return next;
}

/** Set (or clear, when usd=null) the workspace Scout spend ceiling override. */
export async function setScoutWorkspaceCeilingUsd(usd: number | null): Promise<ScoutBudgetOverrides> {
  const cur = await readScoutBudgetOverrides();
  const next = { ...cur };
  if (usd === null) delete next.workspaceCeilingUsd;
  else {
    if (!finiteNonNeg(usd)) throw new Error('workspaceCeilingUsd must be a finite number ≥ 0');
    next.workspaceCeilingUsd = usd;
  }
  return persist(next);
}

export async function setScoutBudgetOverrides(o: ScoutBudgetOverrides): Promise<void> {
  await persist(o ?? {});
}
export async function resetScoutBudgetOverrides(): Promise<void> {
  await persist({});
}

/** Injectable seam (tests). Defaults = the real PG read + process.env. */
export interface ScoutBudgetResolveDeps {
  readOverride?: () => Promise<ScoutBudgetOverrides>;
  env?: NodeJS.ProcessEnv;
}

/**
 * THE live workspace-ceiling resolver scoutWorkspaceCeilingGate consults: the PG override first,
 * then the env, then the default. Async (the gate is async + infrequent).
 */
export async function resolveScoutWorkspaceCeilingUsdLive(deps?: ScoutBudgetResolveDeps): Promise<number> {
  const env = deps?.env ?? process.env;
  let override: ScoutBudgetOverrides = {};
  try {
    override = await (deps?.readOverride ?? readScoutBudgetOverrides)();
  } catch {
    // A broken override read must not break the gate — fall through to env/default (the safety cap
    // is already layered over every per-hive per-cycle cap; see scout-ceiling.ts fail-open).
    override = {};
  }
  if (finiteNonNeg(override.workspaceCeilingUsd)) return override.workspaceCeilingUsd;
  return resolveScoutWorkspaceCeilingUsd(env);
}

// ── config:list-overrides / config:reset-overrides registration (D-005) ───────
registerOverrideConcern({
  name: 'scout-workspace-budget',
  description:
    'runtime Scout workspace spend-ceiling override (learning:set-scout-budget), in front of the PAPERCUSP_SCOUT_WORKSPACE_CEILING_USD env',
  auditAction: 'learning:set-scout-budget',
  diff: async () => {
    const o = await readScoutBudgetOverrides();
    const entries: OverrideEntry[] = [];
    if (finiteNonNeg(o.workspaceCeilingUsd)) {
      entries.push({
        key: 'workspaceCeilingUsd',
        effective: o.workspaceCeilingUsd,
        default: resolveScoutWorkspaceCeilingUsd(),
        layer: 'pg-settings',
      });
    }
    return entries;
  },
  capture: () => readScoutBudgetOverrides(),
  reset: () => resetScoutBudgetOverrides(),
  restore: (snap) => setScoutBudgetOverrides((snap as ScoutBudgetOverrides) ?? {}),
});
