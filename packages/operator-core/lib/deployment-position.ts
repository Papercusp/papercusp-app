/**
 * Read-time deployment position for a set of repo-relative paths.
 *
 * `gitPipelinePosition` answers, per path, whether that code reached the callers
 * that need it. TWO consumers need the same join over a LIST of paths:
 *
 *   - terminal completion evidence (`work_items:get` → `deploymentPositionForEvidence`)
 *   - acceptance-audit citations (the plan ship gate → `deploymentPositionForCitations`)
 *
 * so the fan-out, its cap, and its fail-soft contract live here ONCE instead of
 * being reimplemented per consumer. Adding a third consumer means calling this,
 * not copying it.
 *
 * FAIL-SOFT IS THE LOAD-BEARING PROPERTY: a broken pipeline probe must make the
 * deployment dimension UNKNOWN, never make its caller fail. A caller that reports
 * "not deployed" because the probe threw would be manufacturing exactly the
 * confident-but-wrong verdict this join exists to prevent.
 */
import { gitPipelinePosition, type PipelinePosition } from './git-pipeline-position';

/**
 * Callers may name many paths (completion evidence accepts up to 60); do not fan
 * out that many hot reads. Each probe forks git and may probe systemd/health.
 */
export const MAX_DEPLOYMENT_POSITION_PATHS = 12;

export type DeploymentPath = {
  path: string;
  targetSha: string | null;
  deployedSha: string | null;
  positions: PipelinePosition['positions'] | null;
  blockedOn: PipelinePosition['blockedOn'] | null;
  positionsUnknown?: string[];
  /**
   * Legs whose `false` the probe ITSELF flags as a newer-commit artifact: the ref does
   * not contain `targetSha`, but it does contain an EARLIER commit touching the same
   * path. Carried here because dropping it is how the artifact becomes invisible — the
   * compact row would otherwise show a bare `deployed:false` with nothing saying the
   * probe had already disclaimed it.
   *
   * With a `path` (and no marker to settle it) `targetSha` is "the newest commit
   * touching this path", which on this whole-tree-swept checkout is routinely a PEER'S
   * commit — so the `false` is about that commit, not about the cited change.
   */
  positionsNewerCommit?: string[];
};

export interface DeploymentPositionForPaths {
  paths: DeploymentPath[];
  /** Paths whose probe failed or whose position contains an unknown leg. */
  unknownPaths: string[];
  /** Number of distinct usable paths the caller supplied. */
  totalPaths: number;
  /** True when the caller named more paths than this read probes. */
  truncated: boolean;
}

/**
 * Deployment position of the code/test citations backing a plan's code-truth audit,
 * plus the one derived conclusion a reader actually needs (`undeployedPaths`).
 */
export interface CitationDeployment extends DeploymentPositionForPaths {
  /**
   * Cited paths MEASURED as not live on the serving runtime — the acceptance blind
   * spot, stated positively.
   *
   * A path qualifies only when its `deployed` leg was genuinely measured false. A
   * path whose `deployed` leg is in `positionsUnknown` is UNKNOWN and stays out of
   * this list (it appears in `unknownPaths` instead), because a `false` produced by
   * a degraded git read is not evidence the stage was not reached — the same rule
   * `positionsUnknown` exists to enforce upstream.
   *
   * A leg in `positionsNewerCommit` is excluded for the same reason and lands in
   * `newerCommitPaths`: the probe has already disclaimed that `false` as being about
   * a later commit to the same file rather than about the cited change.
   */
  undeployedPaths: string[];
  /**
   * Cited paths whose `deployed:false` is a NEWER-COMMIT ARTIFACT — not evidence in
   * either direction.
   *
   * This list exists so the case is LOUD. Excluding these from `undeployedPaths` is
   * the correctness fix; naming them is what keeps the fix from creating a second
   * silent gap, where a path the gate could not actually judge simply disappears from
   * every list and reads as "fine". A reader who needs a verdict for one of these must
   * settle it with a marker literal the cited change introduced.
   */
  newerCommitPaths: string[];
}

export function compactPosition(path: string, result: PipelinePosition): DeploymentPath {
  return {
    path,
    targetSha: result.targetSha ?? null,
    deployedSha: result.deployedSha ?? null,
    positions: result.positions ?? null,
    blockedOn: result.blockedOn ?? null,
    ...(result.positionsUnknown?.length ? { positionsUnknown: result.positionsUnknown } : {}),
    ...(result.positionsNewerCommit?.length
      ? { positionsNewerCommit: result.positionsNewerCommit }
      : {}),
  };
}

/**
 * Is this row's `deployed` leg an actual MEASUREMENT of live state?
 *
 * `false` reaches the caller from three different places and only one of them is a
 * measurement: a real absence, a degraded read (`positionsUnknown`), and a leg the
 * probe itself flagged as being about a newer commit (`positionsNewerCommit`). The
 * last two must never be reported as "not live" — that is the confident-wrong-answer
 * shape this whole record exists to expose, reproduced inside the exposer.
 */
function deployedLegIsMeasured(entry: DeploymentPath): boolean {
  if (entry.positions?.deployed !== false) return false;
  if ((entry.positionsUnknown ?? []).includes('deployed')) return false;
  if ((entry.positionsNewerCommit ?? []).includes('deployed')) return false;
  return true;
}

/**
 * Resolve the supplied paths in parallel, capped and fail-soft.
 *
 * The per-path catch is intentional: one malformed/stale path must not hide the
 * deployment state of every other path the caller asked about.
 */
export async function deploymentPositionForPaths(
  paths: readonly string[],
): Promise<DeploymentPositionForPaths> {
  const distinct = [...new Set(paths.map((entry) => entry.trim()).filter(Boolean))];
  const selected = distinct.slice(0, MAX_DEPLOYMENT_POSITION_PATHS);

  const resolved = await Promise.all(
    selected.map(async (path) => {
      try {
        const result = await gitPipelinePosition({ path });
        return { path, result };
      } catch {
        return { path, result: null };
      }
    }),
  );

  const unknownPaths: string[] = [];
  const compact = resolved
    .map(({ path, result }) => {
      if (!result) {
        unknownPaths.push(path);
        return null;
      }
      if (result.positionsUnknown?.length) unknownPaths.push(path);
      return compactPosition(path, result);
    })
    .filter((entry): entry is DeploymentPath => entry !== null);

  return {
    paths: compact,
    unknownPaths,
    totalPaths: distinct.length,
    truncated: distinct.length > selected.length,
  };
}

/**
 * EI-22181490624100467 — resolve deployment position for an audit's cited evidence
 * and derive the one conclusion a reader needs from it.
 *
 * The load-bearing rule is that an UNKNOWN `deployed` leg is never reported as
 * UNDEPLOYED. Getting that backwards would make a degraded git read look like proof
 * the code is not live — the same confident-wrong-answer defect, one level down from
 * the one this record exists to expose.
 */
export async function citationDeploymentForPaths(
  paths: readonly string[],
): Promise<CitationDeployment> {
  const position = await deploymentPositionForPaths(paths);
  const undeployedPaths = position.paths.filter(deployedLegIsMeasured).map((entry) => entry.path);
  const newerCommitPaths = position.paths
    .filter((entry) => (entry.positionsNewerCommit ?? []).includes('deployed'))
    .map((entry) => entry.path);
  return { ...position, undeployedPaths, newerCommitPaths };
}
