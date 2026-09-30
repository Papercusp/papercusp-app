/**
 * Deterministic asserts — §5.1
 *
 * Each kind maps to an evaluator that consumes a RunSummary and returns
 * Violations. The full assertion catalogue is intentionally finite —
 * new behaviors → new kinds, registered here. Free-form `custom`
 * predicates exist as an escape hatch but should be promoted into a
 * built-in kind once they recur (§5.2).
 */

import type { DeterministicAssert, RunSummary, Violation } from '../types';

export type AssertEvaluator = (assert: DeterministicAssert, run: RunSummary) => Violation[];

// Lazy-initialized via globalThis to avoid TDZ when side-effect register
// modules (./tool, ./text, ...) hoist above this module's `const`.
function getRegistry(): Partial<Record<DeterministicAssert['kind'], AssertEvaluator>> {
  const g = globalThis as unknown as {
    __llmTestEvaluators?: Partial<Record<DeterministicAssert['kind'], AssertEvaluator>>;
  };
  if (!g.__llmTestEvaluators) g.__llmTestEvaluators = {};
  return g.__llmTestEvaluators;
}

export function registerEvaluator<K extends DeterministicAssert['kind']>(
  kind: K,
  fn: (assert: Extract<DeterministicAssert, { kind: K }>, run: RunSummary) => Violation[],
): void {
  getRegistry()[kind] = fn as unknown as AssertEvaluator;
}

export function evaluateAsserts(asserts: DeterministicAssert[], run: RunSummary): Violation[] {
  const registry = getRegistry();
  const violations: Violation[] = [];
  for (const a of asserts) {
    const fn = registry[a.kind];
    if (!fn) {
      violations.push({
        assertKind: a.kind,
        severity: 'error',
        claim: `No evaluator registered for assert kind '${a.kind}'`,
      });
      continue;
    }
    violations.push(...fn(a, run));
  }
  return violations;
}

// Side-effect imports — each module calls registerEvaluator at top level.
// Safe to hoist because getRegistry() lazy-initializes the globalThis-backed
// store on first access, so import order doesn't matter.
import './tool';
import './text';
import './card';
import './control-tag';
import './auto-fire';
import './continue-chain';
import './latency';
