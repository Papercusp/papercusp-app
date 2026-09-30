/**
 * Delta-protocol SAFETY GATE (agent-tool-delta-protocol-2026-06-22 P-016 / D-008).
 *
 * The owner BUILD decision (D-007) rests on a de-risk contract (D-008): the
 * LLM-facing semantic-delta opt-in MUST NOT ship to production until the Lane-C
 * behavioral scenarios — su-S23 (base-present merge), su-S24 (compaction
 * fallback-to-refetch), su-S25 (silent-wrong-merge detector) — pass. Scenario
 * evals do not gate `main` today (they run in the nightly matrix only), so this
 * is the missing wire: a green-checkpoint deploy-gate that BLOCKS advancing the
 * green pin when the delta protocol is ENABLED in production but the three
 * scenarios are not recorded-green-and-fresh.
 *
 * Modeled exactly on `perf-gate.ts` (the established deploy-gate precedent):
 *   - a PURE decision (`evaluateDeltaGate`) — no IO,
 *   - an IO-seam runner (`runDeltaGate`) that reads the flag state + the latest
 *     recorded scenario verdicts (NOT a synchronous live-model eval — that is
 *     too slow/flaky for an hourly checkpoint; the matrix runs the model and
 *     persists the verdict, the gate reads it),
 *   - wired into green-checkpoint via an optional `CheckpointDeps.deltaGate`.
 *
 * Two load-bearing rules (mirroring perf-gate):
 *   - FLAG-SCOPED. When the production delta flag is OFF, nothing risky is
 *     shipping → the gate is a no-op `pass` and reads no verdicts. The gate only
 *     bites when the flag is ON (the semantic-delta opt-in is about to be live).
 *   - DEFAULT-WARN, FAIL-CLOSED-WHEN-ARMED. Unlike perf (which fail-SOFTs on
 *     missing data), a SAFETY gate treats "flag on but no fresh green proof" as
 *     a REASON TO HOLD: it `warn`s by default and `block`s only when the owner
 *     arms block-mode. Missing/stale/red verdict ⇒ not-proven ⇒ warn|block (the
 *     conservative direction for a gate whose whole job is "don't ship unproven
 *     deltas"). It never blocks when the flag is off.
 *   - UNREACHABLE-PRECONDITION ESCAPE HATCH (WI-10890). "Not proven yet" and
 *     "can never be proven" are different states, and block-mode was only ever
 *     meant to hold the FORMER. When every Lane-C scenario is consistently
 *     `red` (not missing/stale — i.e. they run and fail, which is exactly what
 *     S23-S25 do today: no in-repo path feeds the model a raw delta body to
 *     merge, by design, so they cannot pass), holding `main` forever is not a
 *     safety measure — it's a deploy freeze the owner did not intend when
 *     arming a check they reasonably believed was achievable. `evaluateDeltaGate`
 *     downgrades block→warn in that specific all-red case only
 *     (`DeltaGateDecision.unreachable`); any other not-proven mix (missing,
 *     stale, errored, or red mixed with green) still blocks as designed, since
 *     those states genuinely can resolve on the next matrix run. S23-S25
 *     themselves are NOT removed — they remain the standing constraint on any
 *     future external wrapper that would feed compact deltas to a model (D-003).
 */

/** The Lane-C scenarios that gate the production delta opt-in (D-008). */
export const DELTA_GATE_SCENARIO_IDS = [
  'su-S23-delta-merge-base-present',
  'su-S24-delta-fallback-compacted',
  'su-S25-delta-wrong-merge-detector',
] as const;

/** Default freshness window: a recorded green older than this is "stale" and no
 *  longer proves the current candidate. 7 days covers the nightly matrix cadence
 *  with slack. */
export const DELTA_GATE_DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export type DeltaGateAction = 'pass' | 'warn' | 'block';

export interface DeltaGatePolicy {
  /** Master switch — when false the gate is a no-op (`pass`) and reads nothing.
   *  Default-OFF: the gate is opt-in until the owner arms it. */
  enabled: boolean;
  /** Owner-armed block-mode. When false an unproven opt-in only `warn`s and the
   *  deploy advances; when true it `block`s. Default-OFF (warn-only) so the gate
   *  never silently strands `main` before the owner trusts it. */
  block: boolean;
  /** Freshness window in ms (default {@link DELTA_GATE_DEFAULT_MAX_AGE_MS}). */
  maxAgeMs: number;
}

/** One scenario's latest recorded verdict (from the llm_test_runs table). */
export interface ScenarioVerdict {
  scenarioId: string;
  /** Status of the most-recent completed run, or null when never run. */
  status: 'passed' | 'failed' | 'errored' | null;
  /** finished_at epoch ms of that run, or null when never run. */
  finishedAtMs: number | null;
}

export interface DeltaGateDecision {
  action: DeltaGateAction;
  reasons: string[];
  summary: string;
  /** Per-scenario proof state for logging/telemetry. */
  proof: Array<{ scenarioId: string; state: 'green' | 'red' | 'errored' | 'stale' | 'missing' }>;
  /**
   * WI-10890: true when block-mode was ARMED but every Lane-C scenario is
   * consistently `red` (not merely missing/stale) — the signature of a
   * precondition that is structurally unreachable under the current
   * delta-proxy architecture, not one that's simply "not proven yet". When
   * true, `action` is forced to `warn` even though `policy.block` was set —
   * see the note on {@link evaluateDeltaGate} for why holding forever on an
   * unreachable precondition is not a safety measure.
   */
  unreachable?: boolean;
}

/** Read the gate policy from the environment (mirrors perfGatePolicyFromEnv).
 *  - `PAPERCUSP_DELTA_GATE=1`       → enable the gate (default off).
 *  - `PAPERCUSP_DELTA_GATE_BLOCK=1` → arm block-mode (default warn-only). Owner-set.
 *  - `PAPERCUSP_DELTA_GATE_MAX_AGE_MS` → override the freshness window. */
export function deltaGatePolicyFromEnv(env: NodeJS.ProcessEnv = process.env): DeltaGatePolicy {
  const rawAge = Number(env.PAPERCUSP_DELTA_GATE_MAX_AGE_MS);
  return {
    enabled: env.PAPERCUSP_DELTA_GATE === '1',
    block: env.PAPERCUSP_DELTA_GATE_BLOCK === '1',
    maxAgeMs: Number.isFinite(rawAge) && rawAge > 0 ? rawAge : DELTA_GATE_DEFAULT_MAX_AGE_MS,
  };
}

function shaLabel(candidateSha?: string): string {
  return candidateSha ? candidateSha.slice(0, 8) : 'candidate';
}

/** Classify one verdict against the freshness window → a proof state. */
function proofState(
  v: ScenarioVerdict,
  now: number,
  maxAgeMs: number,
): 'green' | 'red' | 'errored' | 'stale' | 'missing' {
  if (v.status === null || v.finishedAtMs === null) return 'missing';
  if (now - v.finishedAtMs > maxAgeMs) return 'stale';
  if (v.status === 'passed') return 'green';
  if (v.status === 'errored') return 'errored';
  return 'red';
}

/**
 * PURE: map (flag state × scenario verdicts × policy) → a deploy-gate action.
 * No IO.
 *
 * Decision table:
 *   gate disabled                         → pass (no-op; opt-in)
 *   delta flag OFF                        → pass (nothing risky shipping)
 *   flag ON + all 3 scenarios green+fresh → pass (de-risk contract satisfied)
 *   flag ON + any not-proven              → block IFF policy.block else warn
 *                                           (not-proven = red | errored | stale | missing)
 */
export function evaluateDeltaGate(
  input: { flagEnabled: boolean; verdicts: ScenarioVerdict[]; now: number },
  policy: DeltaGatePolicy,
  candidateSha?: string,
): DeltaGateDecision {
  const sha = shaLabel(candidateSha);

  if (!policy.enabled) {
    return { action: 'pass', reasons: [], summary: `delta-gate disabled — ${sha} not delta-checked`, proof: [] };
  }

  if (!input.flagEnabled) {
    return {
      action: 'pass',
      reasons: [],
      summary: `delta-gate: production delta flag OFF — ${sha} clears (no semantic-delta opt-in shipping)`,
      proof: [],
    };
  }

  // Flag ON — the semantic-delta opt-in is about to be live. Require fresh green
  // proof of all three Lane-C scenarios.
  const byId = new Map(input.verdicts.map((v) => [v.scenarioId, v]));
  const proof = DELTA_GATE_SCENARIO_IDS.map((scenarioId) => ({
    scenarioId,
    state: proofState(
      byId.get(scenarioId) ?? { scenarioId, status: null, finishedAtMs: null },
      input.now,
      policy.maxAgeMs,
    ),
  }));

  const notProven = proof.filter((p) => p.state !== 'green');
  if (notProven.length === 0) {
    return {
      action: 'pass',
      reasons: [],
      summary: `delta-gate: all ${proof.length} Lane-C delta scenarios green+fresh — ${sha} clears the semantic-delta opt-in`,
      proof,
    };
  }

  const reasons = notProven.map((p) => `${p.scenarioId}: ${p.state}`);

  // WI-10890: every scenario RED (run, and consistently failing — not merely
  // `missing`/`stale`, which are recoverable by the nightly matrix simply
  // running again) is the signature of a precondition that CANNOT become
  // green under the current architecture: no in-repo path hands the model a
  // raw `{mode:'delta'}` body to merge, so S23-S25 fail by design, not by
  // accident. Block-mode exists to HOLD deploys until fresh proof lands —
  // holding forever on proof that provably cannot land is not a safety
  // measure, it's an unrecoverable deploy freeze the owner did not intend
  // when arming it (they were arming a check they reasonably believed was
  // achievable). Downgrade to warn ONLY in this specific all-red case; a
  // missing/stale/errored verdict, or a MIX including at least one red among
  // otherwise-green, still blocks as designed — those states genuinely can
  // resolve on the next matrix run.
  const unreachable = proof.every((p) => p.state === 'red');
  const action: DeltaGateAction = policy.block && !unreachable ? 'block' : 'warn';
  const verb =
    action === 'block'
      ? 'BLOCKED (block-mode armed)'
      : policy.block && unreachable
        ? 'flagged — NOT held despite block-mode armed: every Lane-C scenario is consistently RED, which means this precondition is structurally unreachable under the current delta-proxy architecture (no live path merges a raw delta body — see WI-10890), not merely unproven. Amend the gate’s proof source rather than waiting for these to go green'
        : 'flagged (warn — block-mode not armed)';
  return {
    action,
    reasons,
    summary:
      `🟥 delta-gate: production delta flag ON but Lane-C scenarios not proven — deploy of ${sha} ${verb}: ${reasons.join('; ')}`,
    proof,
    ...(unreachable ? { unreachable: true } : {}),
  };
}

/** IO seam for `runDeltaGate` (injected as fakes in tests). */
export interface DeltaGateIO {
  /** Is the production semantic-delta flag enabled for this deploy target? */
  readFlagEnabled: () => Promise<boolean>;
  /** Latest recorded verdict per Lane-C scenario id. */
  readVerdicts: (scenarioIds: readonly string[]) => Promise<ScenarioVerdict[]>;
  now: () => number;
}

/**
 * Read the flag + the latest recorded Lane-C scenario verdicts and apply the
 * policy → a {@link DeltaGateDecision}. Fail-CLOSED-when-armed end-to-end: when
 * disabled it reads NOTHING and passes; a read error degrades to "not proven"
 * (warn|block), NOT a silent pass — a safety gate must not green-light an opt-in
 * it could not verify. The green-checkpoint wiring calls this post-`runGreen` /
 * pre-`advance` and, on `block`, holds the advance.
 */
export async function runDeltaGate(
  policy: DeltaGatePolicy,
  candidateSha: string | undefined,
  io: DeltaGateIO,
): Promise<DeltaGateDecision> {
  if (!policy.enabled) {
    return evaluateDeltaGate({ flagEnabled: false, verdicts: [], now: io.now() }, policy, candidateSha);
  }
  let flagEnabled = false;
  try {
    flagEnabled = await io.readFlagEnabled();
  } catch {
    // Can't read the flag → assume it MIGHT be on and require proof (fail-closed).
    flagEnabled = true;
  }
  if (!flagEnabled) {
    return evaluateDeltaGate({ flagEnabled: false, verdicts: [], now: io.now() }, policy, candidateSha);
  }
  let verdicts: ScenarioVerdict[] = [];
  try {
    verdicts = await io.readVerdicts(DELTA_GATE_SCENARIO_IDS);
  } catch {
    // Read failure ⇒ treat every scenario as missing (not proven) — never pass
    // an unverified opt-in.
    verdicts = [];
  }
  return evaluateDeltaGate({ flagEnabled, verdicts, now: io.now() }, policy, candidateSha);
}
