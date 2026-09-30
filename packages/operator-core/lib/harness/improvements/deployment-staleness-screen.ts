/**
 * deployment-staleness-screen — resolve DEPLOYMENT STATE before triage routes
 * (agent-review-filing-rail-and-class-aggregation-2026-09-05 P-003; EI-22450280531836927).
 *
 * ## The failure this closes
 *
 * `improvements:triage` classifies by the D-005 taxonomy alone — scope, paths, watchdog
 * signal class — and the taxonomy has no way to see deployment state. So a filing whose
 * subject is ALREADY REPAIRED in the tree and merely undeployed is indistinguishable, to
 * triage, from an open code defect: it lands `code-bug` and routes to place, dispatching
 * an agent to fix code that is already correct.
 *
 * Measured (EI-22450280531836927): three independent filers reported one
 * `improvements:capture` condition on the same day (EI-22372781172487389,
 * EI-22384939404278805, EI-22396332198777874), each assigning a DIFFERENT cause — caller
 * error, ambiguous prose, schema-vs-prompt mismatch. All three were wrong in the same
 * direction. The argument WAS declared in the capture schema, consumed, and covered by
 * passing tests; `dev:pipeline_position` reported `committedLocal:true, onStaging:true,
 * inMain:false, deployed:false`. The repair was "land the deploy", never "reconcile a
 * schema". In the same window that population held 213 open tool-call-failure items, 96
 * of them filed AFTER the deployed build was cut.
 *
 * ## Why BEFORE the route, and why not a new taxonomy leg
 *
 * The D-005 taxonomy is NOT replaced (plan Design). This screen runs ahead of
 * classification and may divert to "land the deploy"; everything it does not divert
 * flows into the taxonomy unchanged. Screening AFTER the route was considered and
 * rejected: by then the work-item is already filed against the wrong owner with the
 * wrong repair, and the cost this exists to remove has already been paid.
 *
 * ## The subject is a FIELD READ, never prose
 *
 * A structured `toolFailure` filing already names its tool
 * (`payload.toolFailureProbation.report.toolName`), so the screen's subject is read from
 * that field. A filing without one is not screened at all — deliberately. Inferring the
 * subject from title/body wording would make the screen's false positives unfalsifiable,
 * the same reason P-002 groups on the structured report rather than on title similarity.
 *
 * ## UNKNOWN is a third value and never diverts, never reassures
 *
 * The verdict rides on {@link toolSchemaStaleness}, which is three-valued with an
 * enumerated `unknownReason` precisely so "I could not tell" cannot render as "current".
 * This screen preserves that: only `'stale'` diverts, and an unknown is recorded as an
 * unknown rather than being silently converted into a clean bill for the taxonomy.
 */

import { projectedToolSourceFile } from '@papercusp/tooldef';
import { pinModuleState } from '@papercusp/module-singleton';

import { getBuildInfo } from '../../build-info';
import { gitReadForRepo } from '../../candidate-contains';
import { realGit } from '../../git-pipeline-position';
import { integrationRoot } from '../../release-deploy-launch';
import {
  toolSchemaStaleness,
  type StalenessUnknownReason,
  type ToolSchemaStalenessDeps,
} from '../../tool-schema-staleness';

/** The routing target a diverted filing carries. The repair is a DEPLOY, not a code change. */
export const LAND_THE_DEPLOY_TARGET = 'land-the-deploy';

/** Why the screen did not apply to a filing at all (it flows into the taxonomy unchanged). */
export type ScreenSkipReason =
  /** The filing carries no structured `toolFailure` report, so it names no subject tool. */
  | 'no-structured-tool-failure'
  /** The screen itself faulted (no repo on disk, an unreadable registry). Never blocks triage. */
  | 'screen-unavailable';

export type DeploymentStalenessScreen =
  | { screened: false; divert: false; skipReason: ScreenSkipReason }
  | {
      screened: true;
      divert: true;
      state: 'stale';
      toolName: string;
      relPath: string;
      deployedSha: string;
      treeRef: string;
    }
  | {
      screened: true;
      divert: false;
      state: 'current';
      toolName: string;
      relPath: string;
      deployedSha: string;
      treeRef: string;
    }
  | { screened: true; divert: false; state: 'unknown'; toolName: string; unknownReason: StalenessUnknownReason };

/** The narrow shape this screen reads. Both `EngineerIssue` and a scored item satisfy it. */
export interface ScreenSubjectInput {
  payload?: unknown;
}

/**
 * The subject tool of a structured `toolFailure` filing, or null.
 *
 * `improvements:capture` stores the reporter's structured report verbatim under
 * `payload.toolFailureProbation.report` (capture.ts), so the tool name is one field read
 * away. Anything else — a prose mention, a title fragment — is deliberately NOT a subject.
 */
export function structuredToolFailureSubject(input: ScreenSubjectInput): string | null {
  const payload = input.payload && typeof input.payload === 'object' ? (input.payload as Record<string, unknown>) : null;
  if (!payload) return null;
  const probation =
    payload.toolFailureProbation && typeof payload.toolFailureProbation === 'object'
      ? (payload.toolFailureProbation as Record<string, unknown>)
      : null;
  if (!probation) return null;
  const report =
    probation.report && typeof probation.report === 'object' ? (probation.report as Record<string, unknown>) : null;
  const raw = report && typeof report.toolName === 'string' ? report.toolName : null;
  const toolName = raw?.trim();
  return toolName ? toolName : null;
}

/**
 * Per-tool verdict memo.
 *
 * A retriage pass walks up to a 100-row window, and a defect CLASS concentrates on one
 * tool by construction (P-002), so the same tool name recurs across many rows in one
 * pass. Without this, each row pays two `git rev-parse` subprocesses for an answer that
 * cannot have changed between them. Keyed by the serving build sha as well as the tool,
 * so a deploy landing mid-pass invalidates rather than serving a pre-deploy verdict.
 *
 * Pinned via the module-singleton primitive per the repo's shared-lib rule: a split
 * module record would give each copy its own cache, which is a correctness-neutral but
 * invisible waste, and a hand-rolled `globalThis` key would be invisible to the central
 * duplication report.
 */
const cacheState = pinModuleState('@papercusp/operator-core.improvements-deployment-staleness-screen', () => ({
  verdicts: new Map<string, { at: number; verdict: DeploymentStalenessScreen }>(),
}));

/** How long a per-tool verdict is reused. Short: a deploy landing mid-pass must be seen. */
export const SCREEN_CACHE_TTL_MS = 60_000;

export interface DeploymentStalenessScreenDeps extends Partial<ToolSchemaStalenessDeps> {
  /** Injected clock so the cache TTL is testable without timers. */
  now?: () => number;
  /** Skip the memo entirely (tests asserting a per-call read). */
  cache?: boolean;
}

/**
 * Resolve deployment state for one filing, BEFORE any routing decision is taken.
 *
 * Never throws: a screen that cannot answer must cost the triage nothing, exactly as the
 * capture-time hint does. A fault returns `screened:false` with `screen-unavailable`,
 * which is not a verdict about the code and never diverts.
 */
export async function deploymentStalenessScreen(
  input: ScreenSubjectInput,
  deps: DeploymentStalenessScreenDeps = {},
): Promise<DeploymentStalenessScreen> {
  const toolName = structuredToolFailureSubject(input);
  if (!toolName) return { screened: false, divert: false, skipReason: 'no-structured-tool-failure' };

  const now = deps.now ?? (() => Date.now());
  const useCache = deps.cache !== false;
  try {
    const repoRoot = deps.repoRoot ?? integrationRoot();
    const deployedShaFn = deps.deployedSha ?? (() => getBuildInfo().sha);
    // Part of the cache key: a deploy landing mid-pass must invalidate rather than serve
    // a verdict about the previous build. A null sha still keys distinctly from a real one.
    const buildKey = deployedShaFn() ?? 'build-sha-unknown';
    const cacheKey = [buildKey, toolName].join('::');
    if (useCache) {
      const hit = cacheState.verdicts.get(cacheKey);
      if (hit && now() - hit.at < SCREEN_CACHE_TTL_MS) return hit.verdict;
    }

    const verdict = await toolSchemaStaleness(toolName, {
      sourceFileFor: deps.sourceFileFor ?? projectedToolSourceFile,
      deployedSha: deployedShaFn,
      repoRoot,
      git: deps.git ?? gitReadForRepo(realGit, repoRoot),
      treeRef: deps.treeRef,
    });

    const screened: DeploymentStalenessScreen =
      verdict.state === 'stale'
        ? {
            screened: true,
            divert: true,
            state: 'stale',
            toolName,
            relPath: verdict.relPath,
            deployedSha: verdict.deployedSha,
            treeRef: verdict.treeRef,
          }
        : verdict.state === 'current'
          ? {
              screened: true,
              divert: false,
              state: 'current',
              toolName,
              relPath: verdict.relPath,
              deployedSha: verdict.deployedSha,
              treeRef: verdict.treeRef,
            }
          : { screened: true, divert: false, state: 'unknown', toolName, unknownReason: verdict.reason };
    if (useCache) cacheState.verdicts.set(cacheKey, { at: now(), verdict: screened });
    return screened;
  } catch {
    return { screened: false, divert: false, skipReason: 'screen-unavailable' };
  }
}

/**
 * The reason line recorded on a diverted filing.
 *
 * Names the repair explicitly — landing the deploy — because the whole cost of the
 * failure this closes was three filers each proposing a different CODE repair for a
 * condition no code change fixes. Hedged the same way the capture-time hint is: a
 * differing blob proves the defining file moved, not that it moved for THIS constraint,
 * so the divert asks the reviewer to confirm rather than asserting the item is closed.
 */
export function renderDeploymentStalenessDivert(screen: Extract<DeploymentStalenessScreen, { divert: true }>): string {
  return (
    `DEPLOYMENT-STALENESS SCREEN (P-003 / EI-22450280531836927): \`${screen.relPath}\` (defines ` +
    `\`${screen.toolName}\`) differs between the build serving this filing (\`${screen.deployedSha}\`) and ` +
    `\`${screen.treeRef}\`. The reported condition may already be repaired in the tree and merely UNDEPLOYED, ` +
    `so the repair is to LAND THE DEPLOY, not to change code. Confirm with ` +
    `\`dev:pipeline_position { path: '${screen.relPath}' }\` before routing this as a code fix.`
  );
}

/** Test seam: drop every memoized verdict. */
export function resetDeploymentStalenessScreenCache(): void {
  cacheState.verdicts.clear();
}
