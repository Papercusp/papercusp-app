/**
 * gates/canary — the self-checking verification substrate (fleet-reliability-
 * verification-2026-07-10 P-011, after P-010's probe:emit).
 *
 * Root lesson (2026-07-10 cause #10): every prior federation probe was
 * UNSTAMPED, so "green" was unreachable BY CONSTRUCTION for ~6h and nothing
 * said so — a "still red" reading was indistinguishable from "the checker
 * itself is broken". A gate canary closes that gap generically for ANY
 * standing gate: run a KNOWN-GOOD sample through the gate's own apparatus
 * periodically. If the canary itself fails, the gate cannot be trusted at all
 * (alarm 'gate' — the verification apparatus is broken, distinct from a real
 * failure). Only once the canary passes does a real red mean the SYSTEM under
 * test is genuinely broken (alarm 'system' — trust this red).
 *
 * This module is PURE (no PG, no ambient clock, no process spawn) — every
 * concrete gate binds its own `run()` (e.g. federation-probe-canary.ts binds
 * P-010's stampProbe; a checkpoint-walker canary binds green-checkpoint's own
 * result parser) and this substrate only classifies + times the result. Also
 * prevents the WI-2009 stale-verdict class: a gate that silently stopped
 * running reads identically to one whose canary times out (`canaryOk: null`,
 * verdict 'unknown', alarm 'gate') — never silently dropped.
 */

export type GateCanaryVerdict = 'healthy' | 'gate-broken' | 'system-broken' | 'unknown';
export type GateCanaryAlarm = 'none' | 'gate' | 'system';

export interface GateCanaryClassification {
  verdict: GateCanaryVerdict;
  alarm: GateCanaryAlarm;
  detail: string;
}

/**
 * Bifurcate a gate's current state.
 *
 * @param canaryOk  Did a KNOWN-GOOD sample just pass through the gate's own
 *   apparatus? `null` = the canary itself could not be determined (errored /
 *   timed out before producing a result) — treated conservatively as
 *   gate-suspect, NEVER silently dropped (the WI-2009 class this guards).
 * @param systemGreen  The gate's real (non-canary) verdict for the thing it
 *   actually protects. `null` = no real verdict to bifurcate against yet (a
 *   canary-only sweep that doesn't also track the live gate state).
 */
export function classifyGateCanary(input: {
  canaryOk: boolean | null;
  systemGreen: boolean | null;
}): GateCanaryClassification {
  if (input.canaryOk === null) {
    return {
      verdict: 'unknown',
      alarm: 'gate',
      detail:
        "the canary itself could not be determined (errored or timed out before producing a result) — " +
        'treated as gate-suspect, never silently ignored',
    };
  }
  if (input.canaryOk === false) {
    return {
      verdict: 'gate-broken',
      alarm: 'gate',
      detail:
        "a KNOWN-GOOD sample failed to pass through the gate's own apparatus — green is unreachable by " +
        'construction (the 2026-07-10 cause #10 failure class); this is NOT evidence of a real system failure',
    };
  }
  // canaryOk === true — the apparatus itself works, so a real red is trustworthy.
  if (input.systemGreen === null) {
    return {
      verdict: 'unknown',
      alarm: 'none',
      detail: 'the canary passed (the apparatus works), but no real (non-canary) verdict was supplied to bifurcate against',
    };
  }
  if (input.systemGreen === false) {
    return {
      verdict: 'system-broken',
      alarm: 'system',
      detail:
        'the canary passed (the gate apparatus works) but the real verdict is red — the SYSTEM under test ' +
        'genuinely fails; trust this red',
    };
  }
  return { verdict: 'healthy', alarm: 'none', detail: 'the canary passed and the real verdict is green' };
}

export interface GateCanaryRunResult {
  ok: boolean;
  /** One line: what the canary observed. Defaults to a generic pass/fail note. */
  detail?: string;
}

export interface GateCanaryDef {
  /** Stable id (e.g. `federation-probe:<harness>`) — the dedup/alarm key. */
  id: string;
  /** One line: what this canary proves. */
  describe: string;
  run: () => Promise<GateCanaryRunResult>;
  /** ms budget before a hung canary itself counts as undetermined (never hangs the caller). Default 30s. */
  timeoutMs?: number;
}

export interface GateCanaryReport {
  id: string;
  describe: string;
  ranAtMs: number;
  canaryOk: boolean | null;
  canaryDetail: string;
  systemGreen: boolean | null;
  classification: GateCanaryClassification;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Run ONE gate canary against a supplied real-verdict signal and classify the
 * result. NEVER throws — a canary that errors or times out reads as
 * `canaryOk: null` (verdict 'unknown', alarm 'gate'), so a broken canary can
 * never crash the sweep or silently vanish from it.
 */
export async function runGateCanary(
  def: GateCanaryDef,
  systemGreen: boolean | null,
  opts: { nowMs?: number } = {},
): Promise<GateCanaryReport> {
  const nowMs = opts.nowMs ?? Date.now();
  const timeoutMs = def.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let canaryOk: boolean | null = null;
  let canaryDetail = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await new Promise<GateCanaryRunResult>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`canary '${def.id}' timed out after ${timeoutMs}ms`)), timeoutMs);
      def.run().then(resolve, reject);
    });
    canaryOk = result.ok;
    canaryDetail = result.detail ?? (result.ok ? 'canary passed' : 'canary failed');
  } catch (e) {
    canaryOk = null;
    canaryDetail = e instanceof Error ? e.message : String(e);
  } finally {
    if (timer) clearTimeout(timer);
  }
  const classification = classifyGateCanary({ canaryOk, systemGreen });
  return { id: def.id, describe: def.describe, ranAtMs: nowMs, canaryOk, canaryDetail, systemGreen, classification };
}

/** Run many canaries (independent, in parallel) against their respective real-verdict signals. */
export async function runGateCanaries(
  defs: ReadonlyArray<{ def: GateCanaryDef; systemGreen: boolean | null }>,
): Promise<GateCanaryReport[]> {
  return Promise.all(defs.map(({ def, systemGreen }) => runGateCanary(def, systemGreen)));
}
