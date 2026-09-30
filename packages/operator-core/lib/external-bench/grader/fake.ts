/**
 * A deterministic in-process {@link OfficialGrader} for unit tests + dry runs — no Docker, no subprocess.
 * Resolve verdicts come from a map (instanceId → resolved) or a predicate; missing → `graderError` so the
 * "infra failure ≠ not-resolved" path is exercised. Honors the fairness invariant (pure w.r.t. the arm).
 */
import type { ArmSubmission, BenchTask, BenchmarkFamily, GradeResult, OfficialGrader } from '../types';

export interface FakeGraderOpts {
  family?: BenchmarkFamily;
  modality?: 'diff' | 'in-container';
  version?: string;
  /** Resolve verdict per instanceId — a map or a predicate over the submission. Missing map key → graderError. */
  verdicts?: Record<string, boolean> | ((sub: ArmSubmission, task?: BenchTask) => boolean);
  /** Force a per-instance infra failure (image pull / timeout simulation). */
  graderErrors?: Record<string, string>;
}

export function makeFakeGrader(opts: FakeGraderOpts = {}): OfficialGrader {
  const family = opts.family ?? 'swe-bench-pro';
  const modality = opts.modality ?? 'diff';
  const version = opts.version ?? 'fake-v1';

  return {
    family,
    modality,
    async grade(submissions: ArmSubmission[], tasks: BenchTask[]): Promise<GradeResult[]> {
      const taskById = new Map(tasks.map((t) => [t.instanceId, t]));
      return submissions.map((sub): GradeResult => {
        const forcedErr = opts.graderErrors?.[sub.instanceId];
        if (forcedErr) {
          return {
            instanceId: sub.instanceId,
            prefix: sub.prefix,
            resolved: false,
            rawGraderOutput: { fake: true, graderError: forcedErr },
            graderFamily: family,
            graderVersion: version,
            graderError: forcedErr,
          };
        }
        let resolved: boolean;
        if (typeof opts.verdicts === 'function') {
          resolved = opts.verdicts(sub, taskById.get(sub.instanceId));
        } else if (opts.verdicts && sub.instanceId in opts.verdicts) {
          resolved = opts.verdicts[sub.instanceId];
        } else {
          // No verdict configured → treat as an infra failure (no result), not a silent false.
          return {
            instanceId: sub.instanceId,
            prefix: sub.prefix,
            resolved: false,
            rawGraderOutput: { fake: true, missing: true },
            graderFamily: family,
            graderVersion: version,
            graderError: 'fake grader: no verdict configured for instance',
          };
        }
        return {
          instanceId: sub.instanceId,
          prefix: sub.prefix,
          resolved,
          failToPass: modality === 'diff' ? [{ test: 'fake::test_resolved', passed: resolved }] : undefined,
          passToPass: modality === 'diff' ? [{ test: 'fake::test_regression', passed: true }] : undefined,
          rawGraderOutput: { fake: true, resolved },
          graderFamily: family,
          graderVersion: version,
        };
      });
    },
  };
}
