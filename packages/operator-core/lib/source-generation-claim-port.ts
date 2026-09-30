/**
 * source-generation-claim-port — the claim-time "has this item's own code moved
 * since it was reported?" measurement (EI-22283949842250645).
 *
 * WHY THIS EXISTS: `assessClaimFreshness` scores two axes — source and runtime —
 * and its only caller fed BOTH from `getBuildInfo()`, so the source axis compared
 * a value against itself and always affirmed. This port supplies the axis with a
 * real measurement instead.
 *
 * THE MEASUREMENT: `git log --since=<observedAt> <observed generation>..staging --
 * <path>` per path. A non-empty result is direct evidence that someone touched this
 * item's code after it was observed, which is exactly the condition that should
 * route a claim through the cheap validation lane before anyone writes a line of
 * new code.
 *
 * WHY THE `--since` BOUND IS LOAD-BEARING (EI-23762020538736279): the observed
 * generation is the DEPLOYED build's sha, and the deployed operator lags `staging`
 * by hours. Without the time bound the range is dominated by commits that landed
 * BEFORE the item was ever filed — deploy lag, not movement — so the clause fired
 * on nearly every actively-edited file and asserted "moved since observation" about
 * commits that PREDATE the observation. That is not a tuning problem: the sha range
 * alone cannot answer a question about a moment in time. Measured instance: an item
 * filed at 05:25Z was routed to the validation lane because of commits whose newest
 * was 14 hours OLDER than the filing, and it then reproduced exactly at HEAD.
 *
 * The deploy-lag fact is NOT lost by this bound — it has its own mechanism, the
 * `pathsStalenessHint` "Possible STALE RUNTIME" advisory. The defect was that one
 * clause was doing duty for both questions and stating only the stronger one.
 *
 * WHY PATH-SCOPED AND NOT A TIP COMPARE: this tree is swept by git-sync every few
 * minutes across ~100 concurrent agents, so the repo tip has always moved. A
 * whole-tree sha compare therefore carries no information in either direction —
 * it is the same non-signal as the collapsed axis it would replace, merely stuck
 * ON instead of stuck OFF. Scoping to the item's own paths is what makes the
 * question answerable at all.
 *
 * WHICH TREE: `integrationRoot()` (PAPERCUSP_INTEGRATION_ROOT), the STAGING tree —
 * not `process.cwd()`. The :3070 operator runs from the release checkout pinned to
 * green `main`, which is days stale by design, and measuring there would report
 * "nothing moved" about a checkout where the fix has never existed. Same trap, and
 * the same resolution, as EI-21895925841807401 in `stale-path-hints-claim-port`.
 *
 * WHY LOCAL `staging` AND NOT `origin/staging`: the release candidate is cut from
 * the LOCAL branch and the gate never fetches, so a committed-but-unpushed fix is
 * already live to the pipeline. Comparing against the remote would report such a
 * fix as absent. `pathStaleness` defaults to local `staging` for this reason.
 *
 * FAIL-SOFT, in the honest direction: every failure yields `unmeasured` with a
 * reason, never a verdict. A partially-readable path set is `unmeasured` too — one
 * unreadable path means "nothing moved" was never established for the item as a
 * whole. Absence of evidence is not evidence of freshness; that conflation is the
 * defect this port was written to remove.
 */
import { deriveRepoPathsFromText } from './agent-tools/work_items/_derive-paths';
import { gitReadForRepo } from './candidate-contains';
import { realGit } from './git-pipeline-position';
import { integrationRoot } from './release-deploy-launch';
import { pathsOfPayload } from './stale-path-hints-claim-port';
import { pathStaleness } from './tool-schema-staleness';
import type { SourceGenerationSignal, WorkItemFreshnessEnvelope } from './work-item-claim-freshness';

/**
 * Bounded so a path-heavy item cannot turn one claim into dozens of git reads.
 * The claim path already runs inside a shared deadline; this keeps the leg's
 * worst case proportional to a normal item rather than to the largest one.
 */
const MAX_MEASURED_PATHS = 8;

function readEnvelopeGeneration(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const raw = (payload as Record<string, unknown>).freshnessEnvelope;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const envelope = raw as Partial<WorkItemFreshnessEnvelope>;
  // `observedSourceSha` and `observedRuntimeSha` are both written from the running
  // build's sha today, which is the correct RANGE START either way: a bug observed
  // against the deployed operator is asking "what changed since the build I saw?".
  // Preferring source and falling back to runtime keeps this correct if the writer
  // is later split into two genuinely different values.
  const generation = envelope.observedSourceSha ?? envelope.observedRuntimeSha;
  return typeof generation === 'string' && generation.trim() ? generation.trim() : null;
}

/**
 * The moment the item was OBSERVED — the boundary this port's question actually
 * turns on, and a DIFFERENT fact from the generation above (EI-23762020538736279).
 *
 * The generation says only which BUILD the reporter was running. Because the
 * deployed operator lags `staging` by hours, `generation..staging` is dominated by
 * commits that landed before the report was ever filed, so on its own it answers
 * "the tree is ahead of that build" — true of nearly every actively-edited file —
 * while the clause built on it claims the much stronger "moved SINCE OBSERVATION".
 * Bounding the range by this timestamp is what makes the stated claim the measured
 * one. Absent or unparseable leaves the range unbounded, i.e. the prior behaviour.
 *
 * Normalised to an ISO-8601 UTC instant so git's `--since` cannot silently pick up
 * the host's local offset (-04:00 here).
 */
function readEnvelopeObservedAt(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const raw = (payload as Record<string, unknown>).freshnessEnvelope;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const envelope = raw as Partial<WorkItemFreshnessEnvelope>;
  const observedAt = envelope.observedAt;
  if (typeof observedAt !== 'string' || !observedAt.trim()) return null;
  const parsed = Date.parse(observedAt);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

/**
 * Candidate paths for the measurement: the stored `payload.paths` hints when the
 * item has them, else repo paths cited in its own title/summary prose. The prose
 * fallback is what lifts coverage from 26% to 38% of open bugs (measured
 * 2026-09-03 over 1,369 rows) — most filed items name their file in the text
 * without ever populating the structured field.
 */
export function candidateSourcePaths(ref: {
  workItem?: { payload?: unknown; title?: string | null; summary?: string | null } | null;
  payload?: unknown;
  title?: string | null;
  summary?: string | null;
}): string[] {
  const stored = pathsOfPayload(ref.payload ?? ref.workItem?.payload);
  if (stored && stored.length > 0) return stored.slice(0, MAX_MEASURED_PATHS);
  const title = ref.title ?? ref.workItem?.title ?? '';
  const summary = ref.summary ?? ref.workItem?.summary ?? '';
  const prose = deriveRepoPathsFromText(`${title}\n${summary}`);
  return prose.slice(0, MAX_MEASURED_PATHS);
}

/**
 * Measure whether any of the claimed item's own paths carry commits newer than the
 * generation it was observed against. Never throws; never returns a verdict it did
 * not measure.
 */
export async function getClaimTimeSourceGenerationSignal(ref: {
  workItem?: { payload?: unknown; title?: string | null; summary?: string | null } | null;
  payload?: unknown;
  title?: string | null;
  summary?: string | null;
  repoRoot?: string;
  /** Test seam — defaults to a real git reader bound to the integration tree. */
  git?: (args: string[]) => Promise<string | null>;
}): Promise<SourceGenerationSignal> {
  try {
    const generation = readEnvelopeGeneration(ref.payload ?? ref.workItem?.payload);
    if (!generation) return { kind: 'unmeasured', reason: 'no observed generation on the envelope' };

    const paths = candidateSourcePaths(ref);
    if (paths.length === 0) {
      return { kind: 'unmeasured', reason: 'item names no resolvable source paths' };
    }

    const repoRoot = ref.repoRoot ?? integrationRoot();
    const git = ref.git ?? gitReadForRepo(realGit, repoRoot);
    // Bound the range by WHEN the item was observed, not only by which build the
    // reporter was running — see `readEnvelopeObservedAt`. Without this the range
    // start is the deployed sha, which lags `staging` by hours, so the clause fires
    // on deploy lag and claims post-observation movement it never measured
    // (EI-23762020538736279). Null leaves the range unbounded: the prior behaviour.
    const notBefore = readEnvelopeObservedAt(ref.payload ?? ref.workItem?.payload);
    const verdicts = await Promise.all(
      paths.map((relPath) =>
        pathStaleness(relPath, { deployedSha: () => generation, repoRoot, git, notBefore }),
      ),
    );

    const moved = verdicts
      .filter((v): v is Extract<typeof v, { state: 'stale' }> => v.state === 'stale')
      .map((v) => v.relPath);
    if (moved.length > 0) return { kind: 'paths-moved', paths: moved };

    // Only an ALL-current read establishes "nothing moved". A single unreadable
    // path leaves the item's real answer unknown, and reporting it as unchanged
    // would manufacture exactly the false-clean verdict this port replaces.
    const unreadable = verdicts.filter((v) => v.state === 'unknown');
    if (unreadable.length > 0) {
      const reasons = [...new Set(unreadable.map((v) => v.reason))].join(', ');
      return {
        kind: 'unmeasured',
        reason: `${unreadable.length} of ${verdicts.length} path(s) unreadable (${reasons})`,
      };
    }

    return { kind: 'paths-unchanged', checked: verdicts.map((v) => v.relPath) };
  } catch (err) {
    return { kind: 'unmeasured', reason: `probe failed (${(err as Error)?.name ?? 'error'})` };
  }
}
