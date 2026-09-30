/**
 * Read-time deployment position for terminal completion evidence.
 *
 * A completion record proves what was verified, while `gitPipelinePosition`
 * answers whether the named paths reached the callers that need them. This
 * module owns only the COMPLETION-EVIDENCE shape (which keys hold paths); the
 * fan-out, its cap, and its fail-soft contract live in the shared
 * `lib/deployment-position` core so the plan ship gate can reuse them rather
 * than growing a second copy.
 */
import {
  deploymentPositionForPaths,
  MAX_DEPLOYMENT_POSITION_PATHS,
  type DeploymentPositionForPaths,
} from '../../deployment-position';
import { withBoundedTimeout } from '../../bounded-timeout';

export { MAX_DEPLOYMENT_POSITION_PATHS };

export interface DeploymentPositionForEvidence extends DeploymentPositionForPaths {
  /** Present when evidence exists but contains no usable path to probe, or the probe below did not
   *  finish inside its budget (see `DEPLOYMENT_POSITION_EVIDENCE_TIMEOUT_MS`). */
  unknownReason?: 'no-filesChanged' | 'timeout';
}

/**
 * EI-21751879754001299: `work_items:get` calls this ONCE PER ITEM, sequentially, inside its
 * bulk `runBulk` loop (never batched across ids) — so with no bound here, one slow leg costs
 * the WHOLE bulk read, not just its own item. `gitPipelinePosition` forks several `git`
 * subprocesses per path (each individually bounded, `GIT_PIPELINE_POSITION_SUBPROCESS_TIMEOUT_MS`
 * in `git-pipeline-position.ts`) and, under fleet load, that per-call bound does not stop the
 * *sum* across a path's several sequential subprocess calls from growing large — measured: a
 * 6-id bulk read with 4 `done` items carrying completion evidence (1/4/4/7 paths) hung 342s and
 * was aborted, while the identical read via `dev:pg_query` took 17ms. This is the sibling fix to
 * `release:trace`'s `RELEASE_TRACE_POSITION_TIMEOUT_MS` (same `withBoundedTimeout` wrapper around
 * the same `gitPipelinePosition`), sized tighter because this leg runs PER ITEM in a bulk loop
 * rather than once in a single-item diagnostic call.
 *
 * Deliberately NOT touching `gitPipelinePosition` / `deploymentPositionForPaths` themselves —
 * both are shared by the green-checkpoint gate and other higher-stakes consumers (via the
 * sibling `citationDeploymentForPaths` in `../../deployment-position.ts`) that are not part of
 * this bug and should not inherit a tighter budget tuned for a hot bulk-read tool.
 */
export const DEPLOYMENT_POSITION_EVIDENCE_TIMEOUT_MS = 8_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function stringPaths(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.trim()).filter(Boolean)
    : [];
}

function evidencePaths(evidence: unknown): string[] {
  if (!isRecord(evidence)) return [];
  const nested = isRecord(evidence.verification) ? evidence.verification : undefined;
  return [...new Set([...stringPaths(evidence.filesChanged), ...stringPaths(nested?.filesChanged)])];
}

/**
 * Resolve the paths recorded by a terminal completion. Absent evidence yields no
 * signal at all; evidence naming no path yields an EXPLICIT unknown, because
 * "nothing to probe" and "probed and found nothing deployed" are different facts.
 */
export async function deploymentPositionForEvidence(
  evidence: unknown,
): Promise<DeploymentPositionForEvidence | undefined> {
  if (!isRecord(evidence)) return undefined;

  const paths = evidencePaths(evidence);
  if (paths.length === 0) {
    return { paths: [], unknownPaths: [], totalPaths: 0, truncated: false, unknownReason: 'no-filesChanged' };
  }

  const bounded = await withBoundedTimeout(() => deploymentPositionForPaths(paths), {
    // Fallback is honest about WHICH paths went unresolved (never a bare "0 paths" that would
    // read as "evidence named nothing" — see the `unknownReason` doc above) — the whole point
    // of degrading here rather than letting the caller hang is to keep that distinction visible.
    fallback: { paths: [], unknownPaths: paths, totalPaths: paths.length, truncated: false },
    timeoutMs: DEPLOYMENT_POSITION_EVIDENCE_TIMEOUT_MS,
    label: 'deploymentPositionForEvidence',
  });
  return bounded.degraded ? { ...bounded.value, unknownReason: 'timeout' } : bounded.value;
}
