/**
 * MCP session-start memory prelude builder.
 *
 * Plan: papercusp-su-memory-2026-05-25 (Phase 1, P-003 + P-004).
 *
 * Wired into the MCP `initialize` response handler so every
 * papercusp-su session starts with:
 *   - user-scoped mem0 memories (always)
 *   - harness-scoped mem0 memories (when ?harness=<slug> in the URL OR
 *     detectable via env / cwd)
 *   - agent-insights index (compact title list)
 *
 * D-005: three layers, three jobs. This module composes layers 1 (mem0)
 *        and 3 (insights). Layer 2 (coord) is wired separately on
 *        per-turn delta poll, not session start.
 *
 * Feature-flagged: PAPERCUSP_SU_MEMORY_INJECTION — default ON everywhere
 * (learning-system-audit-improvements-2026-06-09 P-050: finished work never
 * ships dark; the injection path is best-effort/never-throws, which is the
 * real D-004 protection). Set =off as the kill switch if a broken inject
 * ever threatens the papercusp-su shells.
 *
 * Best-effort: any failure returns null and the caller's MCP
 * initialize response is unaffected. Never throws.
 */

import { buildMemoryContextBlock } from './injection';
import {
  detectHarnessSlugSync,
  type DetectResult,
} from './detect-harness-slug';
import {
  readInsightsDir,
  renderInsightsPrelude,
} from './insights-index';
import { withOptionalMemoryAdmission } from './mid-turn-admission';

/** Default ON (P-050); PAPERCUSP_SU_MEMORY_INJECTION=off is the kill switch. */
function injectionEnabled(): boolean {
  return process.env.PAPERCUSP_SU_MEMORY_INJECTION !== 'off';
}

export interface PreludeInput {
  /** Resolved user id (from session cookie or fallback). */
  userId: string;
  /** Workspace id from the MCP request context. */
  workspaceId: string;
  /** URL of the incoming MCP request — used to read ?harness= (fallback; see `harnessSlug`). */
  url?: URL | null;
  /**
   * Explicit harness slug override — takes precedence over `?harness=` in `url`.
   * Callers that already resolved harness via header+param precedence (e.g. the
   * MCP handler's tryBuildSpawnContext, which folds the `x-papercusp-harness`
   * header for OMP sessions — OMP can't env-interpolate its MCP URL, so it
   * carries per-launch values via headers instead, WI-4393) should pass their
   * resolved slug here rather than relying on this module re-parsing `?harness=`
   * (which OMP's static URL never carries).
   */
  harnessSlug?: string | null;
  /**
   * Optional cwd hint — relevant only when the MCP transport carries
   * one (it usually doesn't, since the server is HTTP and the client's
   * cwd isn't in the request). Reserved for stdio-MCP variants.
   */
  cwd?: string;
  /** Absolute path to agent-insights dir for the insights index. */
  insightsDir?: string;
  /**
   * Recall query override. When omitted, the query is derived from the
   * launch profile (D-005 memory-delivery-unification-2026-07-12): a
   * harness-bound session queries with the harness identity; a bare
   * session gets NO initialize-time vector recall (empty query → the
   * pipeline returns null) and defers to the first turn-start delta.
   * The launch-profile resolver (P-007) supersedes this seam.
   */
  queryContext?: string;
  /**
   * Warm-session epoch dedup identity (P-002): the per-launch SID. When
   * present, injected ids are stamped on the session-epoch ledger under
   * port 'initialize' so later injection moments (turn-start, claim, …)
   * of the same epoch never re-pay them.
   */
  sessionId?: string;
}

/**
 * Initialize-time recall query for a harness-bound session (D-005,
 * owner-approved rung 2026-07-12: harness-only sessions DO vector-query at
 * initialize — it is what primes hive-pack + project-convention knowledge
 * before the first turn). Bare sessions return '' → no recall.
 */
export function initializeQueryForHarness(harnessSlug: string | null): string {
  if (!harnessSlug) return '';
  return `${harnessSlug} project: conventions, how we work here, active priorities, known gotchas`;
}

export interface PreludeResult {
  /** Markdown block ready to splice into initialize.instructions. */
  text: string;
  /** Diagnostic: which sources contributed. */
  sources: {
    userMemoryIncluded: boolean;
    harnessMemoryIncluded: boolean;
    insightsIncluded: boolean;
    harnessSlug: string | null;
    harnessSource: DetectResult['source'] | null;
  };
}

/**
 * Build the prelude. Returns null when the feature flag is off OR when
 * every source produced an empty block (no memories, no insights).
 *
 * Composition:
 *   ## Memory and live context
 *   <buildMemoryContextBlock(user + harness)>
 *
 *   ## Agent insights
 *   <renderInsightsPrelude(readInsightsDir)>
 */
export async function buildMcpPrelude(
  input: PreludeInput,
): Promise<PreludeResult | null> {
  if (!injectionEnabled()) return null;

  // Resolve harness slug — URL param first (per-session), then sync
  // detection. The async registry-lookup path stays unwired here;
  // callers that want it can pass it via the helper's standalone
  // detectHarnessSlug() and convert that into an input.url override.
  let harnessSlug: string | null = null;
  let harnessSource: DetectResult['source'] | null = null;

  const fromOverride = input.harnessSlug?.trim();
  const fromUrl = input.url?.searchParams.get('harness')?.trim();
  if (fromOverride) {
    harnessSlug = fromOverride;
    harnessSource = 'env'; // caller-resolved (e.g. header precedence) is effectively an explicit override
  } else if (fromUrl) {
    harnessSlug = fromUrl;
    harnessSource = 'env'; // URL is effectively an explicit override
  } else if (input.cwd) {
    const det = detectHarnessSlugSync({ cwd: input.cwd });
    harnessSlug = det.slug;
    harnessSource = det.source;
  }

  // Layer 1: mem0 fan-out. buildMemoryContextBlock handles the timeout
  // + degraded-mode-flag posture from injection.ts. WI-41042: initialize used
  // to bypass the host-wide optional-memory semaphore, letting every
  // SO_REUSEPORT worker run this same expensive enhancement concurrently. Use
  // the existing no-wait admission shared with mid-turn recall; a full or
  // unavailable gate omits memory only, while the cheap insights layer below
  // still gets a chance to enrich initialize.instructions.
  let memoryBlock: string | null = null;
  let userMemoryIncluded = false;
  let harnessMemoryIncluded = false;
  try {
    const admitted = await withOptionalMemoryAdmission(() =>
      buildMemoryContextBlock({
        userId: input.userId,
        workspaceId: input.workspaceId,
        harnessSlugs: harnessSlug ? [harnessSlug] : [],
        // D-005 (memory-delivery-unification-2026-07-12): the launch profile
        // decides the query. Harness-bound → harness-identity query (primes
        // hive packs + project conventions before the first turn); bare
        // session → '' → buildMemoryContextBlock returns null and recall
        // defers to the first turn-start delta. Callers may override via
        // input.queryContext (the P-007 resolver does).
        queryContext: input.queryContext ?? initializeQueryForHarness(harnessSlug),
        ...(input.sessionId
          ? { session: { sessionId: input.sessionId, port: 'initialize' } }
          : {}),
      }),
    );
    if (admitted.admitted) memoryBlock = admitted.value;
    // We can't introspect buildMemoryContextBlock's result to tell which
    // scope contributed without reshaping it; treat presence as
    // "both included when both requested".
    if (memoryBlock) {
      userMemoryIncluded = true;
      harnessMemoryIncluded = !!harnessSlug;
    }
  } catch {
    // mem0 failed — skip the block entirely
  }

  // Layer 3: insights index. Pure FS read; skip on failure.
  let insightsBlock: string | null = null;
  let insightsIncluded = false;
  if (input.insightsDir) {
    try {
      const entries = await readInsightsDir(input.insightsDir);
      insightsBlock = renderInsightsPrelude(entries);
      insightsIncluded = !!insightsBlock;
    } catch {
      // insights failed — skip the section
    }
  }

  if (!memoryBlock && !insightsBlock) return null;

  const sections: string[] = [];
  if (memoryBlock) sections.push(memoryBlock);
  if (insightsBlock) sections.push(insightsBlock);

  return {
    text: sections.join('\n\n'),
    sources: {
      userMemoryIncluded,
      harnessMemoryIncluded,
      insightsIncluded,
      harnessSlug,
      harnessSource,
    },
  };
}

export const _testing = {
  injectionEnabled,
};
