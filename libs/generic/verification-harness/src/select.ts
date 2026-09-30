/**
 * Phase selection for a selective re-run (`--only` / `--from`) with setup reuse.
 *
 * The requested set is expanded through dependencies. A dependency outside the request is
 * REUSED when it is `reusable` and the prior run passed (or itself reused) it; otherwise it
 * is added to the run, and its own dependencies are expanded the same way. Everything else
 * is skipped. Planning is pure: it decides run / reuse / skip up front, and the runner then
 * decides blocked-vs-run from actual outcomes.
 */
import {
  type HarnessContract,
  type HarnessRunResult,
  type HarnessSelection,
  HarnessContractError,
  phaseTiers,
  type Tier,
} from './contract.js';

/**
 * Restrict a plan to one tier: a phase that does not run in it is skipped with
 * `tier:not-in-<tier>`. Naming such a phase in `--only` is a contract error, not a silent skip.
 */
export function applyTier(
  contract: HarnessContract,
  plan: PlannedPhase[],
  tier: Tier | null,
  selection: HarnessSelection,
): PlannedPhase[] {
  if (tier === null) return plan;
  const byId = new Map(contract.phases.map((p) => [p.id, p]));
  const outside = (id: string) => !phaseTiers(contract, byId.get(id)!).includes(tier);
  const named = (selection.only ?? []).find(outside);
  if (named) throw new HarnessContractError(`${contract.name}: phase ${named} does not run in the ${tier} tier`);
  return plan.map((p) => (outside(p.phase) ? { phase: p.phase, action: 'skip' as const, reason: `tier:not-in-${tier}` } : p));
}

export type PhaseAction = 'run' | 'reuse' | 'skip';

export interface PlannedPhase {
  phase: string;
  action: PhaseAction;
  /** For 'reuse': the prior run that passed this phase. For 'skip': why. */
  reuseFromRunId?: string;
  reason?: string;
}

export function planSelection(
  contract: HarnessContract,
  selection: HarnessSelection,
  prior: Pick<HarnessRunResult, 'runId' | 'phases'> | null,
): PlannedPhase[] {
  const ids = contract.phases.map((p) => p.id);
  const byId = new Map(contract.phases.map((p) => [p.id, p]));
  for (const id of [...(selection.only ?? []), ...(selection.from ? [selection.from] : [])]) {
    if (!byId.has(id)) throw new HarnessContractError(`${contract.name}: unknown phase ${id} (known: ${ids.join(', ')})`);
  }
  if (selection.only && selection.from) {
    throw new HarnessContractError(`${contract.name}: --only and --from are mutually exclusive`);
  }

  let requested: Set<string>;
  if (selection.only) requested = new Set(selection.only);
  else if (selection.from) requested = new Set(ids.slice(ids.indexOf(selection.from)));
  else return ids.map((phase) => ({ phase, action: 'run' as const }));

  const priorPassed = new Set(
    (prior?.phases ?? []).filter((r) => r.status === 'passed' || r.status === 'reused').map((r) => r.phase),
  );
  const run = new Set(requested);
  const reuse = new Set<string>();
  const queue = [...requested];
  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const dep of byId.get(id)!.dependsOn ?? []) {
      if (run.has(dep) || reuse.has(dep)) continue;
      if (byId.get(dep)!.reusable && priorPassed.has(dep)) {
        reuse.add(dep);
      } else {
        run.add(dep);
        queue.push(dep);
      }
    }
  }
  return ids.map((phase) => {
    if (run.has(phase)) return { phase, action: 'run' as const };
    if (reuse.has(phase)) return { phase, action: 'reuse' as const, reuseFromRunId: prior!.runId };
    return { phase, action: 'skip' as const, reason: 'not-selected' };
  });
}

/**
 * Parse the shared selection flags out of an argv list. Accepts `--only a,b`, `--only=a,b`,
 * `--only-phase`, `--from x`, `--from=x`, `--from-phase`, and `--reuse <run dir>`.
 * Unrecognised arguments are returned in `rest` untouched.
 */
export function parseSelectionArgs(argv: readonly string[]): HarnessSelection & { reuse: string | null; rest: string[] } {
  let only: string[] | null = null;
  let from: string | null = null;
  let reuse: string | null = null;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const m = /^--(only|only-phase|from|from-phase|reuse)(?:=(.*))?$/.exec(a);
    if (!m) {
      rest.push(a);
      continue;
    }
    const value = m[2] ?? argv[++i];
    if (value === undefined || value === '') throw new HarnessContractError(`${a} needs a value`);
    if (m[1] === 'only' || m[1] === 'only-phase') {
      only = [...(only ?? []), ...value.split(',').map((s) => s.trim()).filter(Boolean)];
    } else if (m[1] === 'reuse') {
      reuse = value;
    } else {
      from = value;
    }
  }
  return { only, from, reuse, rest };
}
