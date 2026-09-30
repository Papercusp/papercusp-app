/**
 * behaviour-suite/report — assemble a BehaviourReport from the per-check results.
 *
 * Mirrors cert-battery's report shape + its "a failed CRITICAL check fails the whole
 * run" verdict rule (types.CertReport / battery.computeVerdict), so the desktop
 * behaviour axis reads the same way as the headless model-cert axis. Non-critical
 * checks are graded signals; `na` checks are excluded from the verdict.
 */
import type { BehaviourCheck, BehaviourCheckId } from './assertions';

export interface BehaviourReport {
  checks: BehaviourCheck[];
  passed: number;
  failed: number;
  naCount: number;
  criticalFailures: BehaviourCheckId[];
  /** 'pass' iff every applicable CRITICAL check passed. */
  verdict: 'pass' | 'fail';
  ranAt: string;
  summary: string;
  meta: { sessionId?: string; models?: string[]; planSlug?: string; agent?: string };
}

export function buildReport(
  checks: BehaviourCheck[],
  meta: BehaviourReport['meta'] = {},
  now: number = Date.now(),
): BehaviourReport {
  const applicable = checks.filter((c) => !c.na);
  const passed = applicable.filter((c) => c.passed).length;
  const failed = applicable.filter((c) => !c.passed).length;
  const naCount = checks.length - applicable.length;
  const criticalFailures = applicable.filter((c) => c.critical && !c.passed).map((c) => c.id);
  const verdict: 'pass' | 'fail' = criticalFailures.length === 0 ? 'pass' : 'fail';
  const line = checks
    .map((c) => `${c.na ? '·' : c.passed ? '✓' : '✗'}${c.id}`)
    .join(' ');
  const summary =
    `behaviour ${verdict.toUpperCase()} — ${passed}/${applicable.length} checks passed` +
    (criticalFailures.length ? ` · CRITICAL FAILS: ${criticalFailures.join(', ')}` : '') +
    (naCount ? ` · ${naCount} n/a` : '') +
    ` · [${line}]`;
  return { checks, passed, failed, naCount, criticalFailures, verdict, ranAt: new Date(now).toISOString(), summary, meta };
}
