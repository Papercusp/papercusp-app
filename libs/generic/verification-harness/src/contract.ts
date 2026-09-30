/**
 * The verification-harness CONTRACT: what an expensive harness declares about itself so a
 * shared runner can give it structured per-phase results, one evidence dir per run,
 * phase-selective re-runs, and never-abort continuation.
 *
 * A harness is an ordered list of phases. A phase names the phases whose PASS it needs
 * (`dependsOn`); a dependency must be declared EARLIER, so declaration order is always a
 * valid execution order and a cycle cannot be written. A phase marked `reusable` is setup
 * whose passed result a later `--only` / `--from` run may take from a prior run's evidence
 * instead of paying for it again.
 */
import path from 'node:path';
import { GUARD_RAIL_TAG, type GuardRailReport } from './guard-rails.js';
import type { TierGateReport, TierReceiptsReport } from './tier-gate.js';

/**
 * A harness that can run the same phases on a cheap rig (same-box, local, mocked) and on an
 * expensive one (physical rig, full release cut) declares both tiers. The runner then refuses
 * the expensive tier for any phase whose code changed since it last passed the cheap tier.
 */
export const TIERS = ['cheap', 'expensive'] as const;
export type Tier = (typeof TIERS)[number];

export interface PhaseSpec {
  id: string;
  /** Phases whose pass (or reuse) this phase needs. Declared earlier than this phase. */
  dependsOn?: readonly string[];
  /** Setup whose passed result a selective re-run may reuse from a prior run. */
  reusable?: boolean;
  description?: string;
  /**
   * The tiers this phase runs in (default: every tier the contract declares). A phase that runs
   * only on the expensive tier covers a physical-only property and is exempt from the tier gate.
   */
  tiers?: readonly Tier[];
  /**
   * The code that defines this phase, as paths relative to the code root: a file, a directory,
   * or `script.sh#shell_function` for one function of a shell script. Its hash is the phase's
   * identity for the tier gate. Required on a phase that runs in both tiers.
   */
  code?: readonly string[];
}

export interface HarnessContract {
  name: string;
  phases: readonly PhaseSpec[];
  /** Where this harness sits, for guard-rail selection: its preflight runs every probe sharing a tag. */
  scopeTags?: readonly string[];
  /** What each tier runs on (e.g. cheap: "same-box two-instance rig", expensive: "physical rig"). */
  tiers?: Readonly<Record<Tier, string>>;
}

/** The tiers a phase runs in under this contract (empty when the contract declares no tiers). */
export function phaseTiers(contract: HarnessContract, spec: PhaseSpec): readonly Tier[] {
  if (!contract.tiers) return [];
  return spec.tiers ?? TIERS;
}

/** passed · failed · blocked (a dependency did not pass) · skipped (not selected) · reused (prior run). */
export type PhaseStatus = 'passed' | 'failed' | 'blocked' | 'skipped' | 'reused';

export interface PhaseResult {
  phase: string;
  status: PhaseStatus;
  /** The last step the phase marked before it ended (null when it never marked one). */
  step: string | null;
  /** Machine-readable cause for any status other than passed. */
  reasonCode: string | null;
  detail?: string;
  evidenceDir: string;
  startedAt: string | null;
  endedAt: string | null;
  elapsedMs: number;
  /** Set when status is 'reused': the run whose passed result satisfied this phase. */
  reusedFromRunId?: string;
}

/** tier-refused: an expensive-tier run the tier gate refused before paying for preflight or any phase. */
export type HarnessVerdict = 'pass' | 'fail' | 'preflight-failed' | 'tier-refused';

export interface HarnessSelection {
  only: string[] | null;
  from: string | null;
}

export interface HarnessRunResult {
  schemaVersion: 1;
  harness: string;
  runId: string;
  evidenceDir: string;
  selection: HarnessSelection;
  reuseFromRunId: string | null;
  preflight: PhaseResult | null;
  phases: PhaseResult[];
  verdict: HarnessVerdict;
  firstFailure: { phase: string; step: string | null; reasonCode: string | null } | null;
  /** Guard rails checked in preflight; null when the harness declares no scope tags. */
  guardRails?: GuardRailReport | null;
  /** The tier this run ran on; null/absent when the contract declares no tiers. */
  tier?: Tier | null;
  /** Expensive tier: the gate's per-phase verdict (refused phases name why). */
  tierGate?: TierGateReport | null;
  /** Cheap tier: where passing phases' code hashes were recorded. */
  tierReceipts?: TierReceiptsReport | null;
  startedAt: string;
  endedAt: string | null;
}

export class HarnessContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HarnessContractError';
  }
}

/** Throws HarnessContractError on a duplicate id, an unknown dependency, or a forward reference. */
export function validateContract(contract: HarnessContract): void {
  if (!contract.name) throw new HarnessContractError('contract.name is required');
  if (contract.phases.length === 0) throw new HarnessContractError(`${contract.name}: no phases declared`);
  const badTag = (contract.scopeTags ?? []).find((t) => !GUARD_RAIL_TAG.test(t));
  if (badTag !== undefined) throw new HarnessContractError(`${contract.name}: invalid scope tag ${JSON.stringify(badTag)}`);
  const seen = new Set<string>();
  for (const p of contract.phases) {
    if (!p.id || /[\s,/]/.test(p.id)) {
      throw new HarnessContractError(`${contract.name}: invalid phase id ${JSON.stringify(p.id)} (no spaces, commas or slashes)`);
    }
    if (seen.has(p.id)) throw new HarnessContractError(`${contract.name}: duplicate phase id ${p.id}`);
    for (const d of p.dependsOn ?? []) {
      if (!contract.phases.some((q) => q.id === d)) {
        throw new HarnessContractError(`${contract.name}: phase ${p.id} depends on unknown phase ${d}`);
      }
      if (!seen.has(d)) {
        throw new HarnessContractError(`${contract.name}: phase ${p.id} depends on ${d}, which is declared later`);
      }
    }
    seen.add(p.id);
  }
  validateTiers(contract);
}

function validateTiers(contract: HarnessContract): void {
  const byId = new Map(contract.phases.map((p) => [p.id, p]));
  if (!contract.tiers) {
    const tiered = contract.phases.find((p) => p.tiers !== undefined);
    if (tiered) throw new HarnessContractError(`${contract.name}: phase ${tiered.id} declares tiers but the contract declares none`);
    return;
  }
  for (const t of TIERS) {
    if (!contract.tiers[t]) throw new HarnessContractError(`${contract.name}: contract.tiers.${t} must say what that tier runs on`);
  }
  for (const p of contract.phases) {
    if (p.tiers && (p.tiers.length === 0 || p.tiers.some((t) => !(TIERS as readonly string[]).includes(t)))) {
      throw new HarnessContractError(`${contract.name}: phase ${p.id} has invalid tiers ${JSON.stringify(p.tiers)}`);
    }
    const mine = phaseTiers(contract, p);
    for (const d of p.dependsOn ?? []) {
      const missing = mine.find((t) => !phaseTiers(contract, byId.get(d)!).includes(t));
      if (missing) throw new HarnessContractError(`${contract.name}: phase ${p.id} runs in the ${missing} tier but its dependency ${d} does not`);
    }
    if (mine.length === TIERS.length && !(p.code && p.code.length > 0)) {
      throw new HarnessContractError(
        `${contract.name}: phase ${p.id} runs in both tiers, so it must declare \`code\` (its identity for the tier gate)`,
      );
    }
    if ((p.code ?? []).some((c) => !c || c.startsWith('#') || path.isAbsolute(c.split('#')[0]!))) {
      throw new HarnessContractError(`${contract.name}: phase ${p.id} has an invalid code path (relative path, optional #function)`);
    }
  }
}
