/**
 * `@papercusp/eval-battery` — the ONE eval-battery engine + the swappable `Subject`
 * port (self-improvement-stack-reconciliation-2026-06-09 D-001).
 *
 *   runBattery({ cells, rubric, maxDistillChars }, { subject, llmCall, hooks, now })
 *
 * owns the bounded variant×case×repeat loop, the frozen LLM judge, the scoring/cost
 * cores, and the never-abort + rate-pause discipline. The only swap is the `Subject`:
 *   - the gym = `HarnessSubject`   (a component eval; variant = a prompt overlay),
 *   - the Apiary/gen-0 = `InstanceSubject` (a whole-instance eval; variant = a genome delta).
 *
 * Pure, dependency-injected — the store writes + metric collection are caller-bound
 * hooks; the subject-specific aggregation (gym variance/cost/comparison, apiary
 * passed/meanComposite) stays caller-side.
 */
export * from './subject';
export * from './registry';
export * from './battery';
export * from './judge';
export * from './scoring';
export * from './rate-pause';
export { tryParseJson } from './parse-json';
// Producer diagnostics share the evaluator's original-load receipt. This is
// per-module evidence; it never supplies a complete runtime code pin.
export { captureSourceHash } from './source-identity';

// The compare/select comparison core (test-gym P-002) — re-exported so battery
// callers rank/select arms with the same semantics the scenario substrate uses
// (runBattery runs the cells; compareArms is the shared diff/rank/select math).
export {
  BASELINE_ID,
  compareArms,
  type CompareArm,
  type CompareArmsOpts,
  type CompareSelectResult,
  type MetricDiff,
  type RankedCandidate,
  type ScorerDirection,
} from '@papercusp/testing-shell/llm';
