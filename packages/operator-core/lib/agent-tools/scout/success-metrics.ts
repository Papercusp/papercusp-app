/**
 * blender:success-metrics — the blender-self-learning program's DONE-CHECK, as a tool
 * (blender-self-learning-2026-07-12 P-015).
 *
 * P-015 asked for the program's success metrics to become a QUERYABLE check. This is that
 * surface: it reads the ledgers the program itself shipped (scout_ticks + the routed-idea
 * ledger, su-ideate partition) and answers the five bars the plan set, each PASS / FAIL /
 * UNKNOWN with the measurement behind it.
 *
 * Why a tool and not a routine: the program's own founding defect was a metric nobody could
 * SEE (the rubric grounding lane sat at zero for its entire life while every test stayed
 * green). A check that only a background routine can run reproduces that failure — the
 * scout quality-degradation watchdog next door was built, tested, and never wired to a
 * caller, so it has never once run. An agent-callable verb is what makes the gate real.
 *
 * Read-only. Never throws on an empty window: an empty denominator is reported as UNKNOWN,
 * which is NOT a pass — an unrun program must never certify itself done.
 *
 * EI-12146: the cycle-error-rate bar's DEFAULT evidence window is no longer a second,
 * independent hardcode living next to the rubric's own structured `window` field — it now
 * RESOLVES from the blender-release-readiness rubric's `cycle-error-rate` criterion
 * (see {@link resolveRubricDefaultWindow}), so the rubric is the single authority a
 * verdict is judged against. An explicit `sinceMs`/`watermarkRef` arg still overrides it
 * (EI-12148); the assembly layer's own rolling fallback only applies when the rubric
 * itself can't be read.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';

import { buildProgramSuccessReport, type ProgramSuccessReport } from '../../scout/success-metrics';
import { resolveConcreteWorkspaceId } from '../../workspace-registry';
import {
  BG_HOST_RESTART_WATERMARK,
  readRunningGeneration,
  resolveWatermarkRef,
  type RunningGeneration,
} from '../../scout/generation-watermark';
import { getRubric } from '../../rubrics';
import { resolveCriterionWindow } from '../plans/rubric-template';

export const successMetricsArgs = z
  .object({
    harnessSlug: z
      .string()
      .min(1)
      .optional()
      .describe(
        'scope harness-owned su-ideate rows; workspace Scout ticks and routed ideas always resolve through the @singleton brain (default: all su-ideate harnesses)',
      ),
    sinceMs: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'ABSOLUTE epoch-ms floor for the tick window — judge only evidence at/after this instant (overrides the rubric-derived default window). Mutually exclusive with watermarkRef; omit both to let the release-readiness rubric\'s own declared window judge (EI-12146).',
      ),
    watermarkRef: z
      .string()
      .min(1)
      .optional()
      .describe(
        `named generation watermark to floor the window at, resolved server-side. '${BG_HOST_RESTART_WATERMARK}' = the running scout bg-host's start instant — judge only what the CURRENTLY RUNNING code produced (a rolling window keeps failing on pre-fix errors for up to 48h after a fix ships; EI-12148). Mutually exclusive with sinceMs.`,
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(5000)
      .optional()
      .describe(
        'max routed-idea ledger rows to read (default 500). A read that hits this cap reports the reconciliation bar as UNKNOWN rather than failing on rows it never fetched — raise it to judge a longer history.',
      ),
    tickLimit: z
      .number()
      .int()
      .min(1)
      .max(5000)
      .optional()
      .describe(
        'optional safety cap inside the default scout_ticks time box (rubric-derived — EI-12146, 48h fallback). Omit to read the complete time box; this is not the release window definition.',
      ),
    maxErrorRate: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe("cycle error-rate bar (default 0.05 — the plan's <5%, down from the historical ~30%)"),
  })
  .strict();
export type SuccessMetricsArgs = z.infer<typeof successMetricsArgs>;

/** Window provenance echoed back whenever the window was resolved from something other
 *  than the plain rolling default: an explicit caller override (EI-12148: 'sinceMs' /
 *  `watermark:<ref>`), or the release-readiness rubric's own declared criterion window
 *  (EI-12146: `rubric:<window|default|watermark-unresolved>` — the resolveCriterionWindow
 *  provenance, so a verdict is never read without knowing whether the rubric's window
 *  resolved cleanly). Absent only when the rubric itself could not be read at all, in
 *  which case the read falls back to the pre-EI-12146 hardcoded default unchanged. */
export interface ResolvedSuccessWindow {
  sinceMs: number;
  sinceIso: string;
  source: 'sinceMs' | `watermark:${string}` | `rubric:${'window' | 'default' | 'watermark-unresolved'}`;
}

/** The rubric + criterion this instrument grades against (EI-12146). The DEFAULT window
 *  (no sinceMs/watermarkRef arg) resolves from THIS criterion's structured `window` field
 *  so the rubric stays the SINGLE authority for the bar's evidence window — an instrument
 *  that keeps its own separate hardcode is exactly the two-authorities disagreement this
 *  item was filed to close, even once that hardcode is "structured". */
export const RELEASE_READINESS_RUBRIC_SLUG = 'blender-release-readiness';
export const CYCLE_ERROR_RATE_CRITERION_KEY = 'cycle-error-rate';

/**
 * Resolve the DEFAULT window (no explicit sinceMs/watermarkRef arg) from the
 * release-readiness rubric's cycle-error-rate criterion (EI-12146). Degrades to
 * `undefined` — never throws — when the rubric, the criterion, or its structured
 * `window` cannot be read: the caller then falls back to the assembly layer's own
 * rolling default exactly as it did before this existed, so a rubric outage never
 * blocks the done-check, it only loses the provenance.
 */
export async function resolveRubricDefaultWindow(): Promise<ResolvedSuccessWindow | undefined> {
  try {
    const rubric = await getRubric(RELEASE_READINESS_RUBRIC_SLUG);
    const criterion = rubric?.criteria.find((c) => c.key === CYCLE_ERROR_RATE_CRITERION_KEY);
    const window = criterion?.window;
    if (!window) return undefined;
    const watermarks: Record<string, number | null> = {};
    if (window.kind === 'post-watermark' && window.watermarkRef) {
      const wm = await resolveWatermarkRef(window.watermarkRef);
      watermarks[window.watermarkRef] = wm.ok ? wm.ms : null;
    }
    const resolved = resolveCriterionWindow(window, { watermarks });
    return {
      sinceMs: resolved.sinceMs,
      sinceIso: new Date(resolved.sinceMs).toISOString(),
      source: `rubric:${resolved.source}`,
    };
  } catch {
    return undefined;
  }
}

export async function runSuccessMetrics(
  args: SuccessMetricsArgs,
  ctx?: unknown,
): Promise<
  | {
      ok: true;
      report: ProgramSuccessReport;
      resolvedWindow?: ResolvedSuccessWindow;
      runningGeneration?: RunningGeneration;
    }
  | { ok: false; error: string }
> {
  try {
    // Resolve the requested window floor (EI-12148). An EXPLICITLY requested watermark
    // that cannot be resolved is a LOUD error, never a silent fallback — substituting a
    // different window than the caller asked to judge is the exact instrument-vs-intent
    // disagreement this arg exists to remove.
    let resolvedWindow: ResolvedSuccessWindow | undefined;
    if (args.watermarkRef != null) {
      if (args.sinceMs != null) {
        return {
          ok: false,
          error: 'invalid_args: pass sinceMs OR watermarkRef, not both — they both set the window floor',
        };
      }
      const wm = await resolveWatermarkRef(args.watermarkRef);
      if (!wm.ok) return { ok: false, error: `watermark_unresolved: ${wm.error}` };
      resolvedWindow = {
        sinceMs: wm.ms,
        sinceIso: new Date(wm.ms).toISOString(),
        source: `watermark:${args.watermarkRef}`,
      };
    } else if (args.sinceMs != null) {
      resolvedWindow = { sinceMs: args.sinceMs, sinceIso: new Date(args.sinceMs).toISOString(), source: 'sinceMs' };
    } else {
      // EI-12146: no explicit override — resolve the DEFAULT from the rubric's own
      // declared criterion window instead of leaving it to the assembly layer's
      // independent hardcode. Falls back to that hardcode (resolvedWindow stays
      // undefined) when the rubric itself can't be read.
      resolvedWindow = await resolveRubricDefaultWindow();
    }
    // EI-19480382468465942: pass the CONCRETE workspace id, or the whole report reads the
    // wrong ledger. buildProgramSuccessReport resolves the scout tick install_slug via
    // resolveScoutTickInstallSlug(opts.workspaceId), which SHORT-CIRCUITS to the legacy
    // '@singleton' constant the moment workspaceId is falsy — so omitting it here silently
    // pointed the cadence read at a stream that stopped on 2026-08-02T02:04:47Z while the
    // live writer had moved to install_slug='papercusp-workspace'. The bar then reported
    // `unknown` ("denominator too small: n=2") forever and could not see a real 17.4%
    // error day. EI-19329929546171597 fixed the resolver correctly; it was inert because
    // this caller never fed it. Same shape as the omitted-optional-arg class in
    // EI-19479875196687941: a fix gated on an optional arg is unfinished until the callers
    // pass it. resolveConcreteWorkspaceId also falls back to activeWorkspaceId(), so a ctx
    // without a workspace still lands on a REAL workspace rather than the sentinel — and
    // it additionally re-arms the `opts.workspaceId ? AND workspace_id = ... : (nothing)`
    // guards downstream, which were degrading the other legs to unscoped cross-tenant reads.
    const workspaceId = resolveConcreteWorkspaceId(
      (ctx as { workspaceId?: string | null } | undefined)?.workspaceId,
    );
    const report = await buildProgramSuccessReport({
      workspaceId,
      ...(args.harnessSlug ? { harnessSlug: args.harnessSlug } : {}),
      ...(args.limit != null ? { limit: args.limit } : {}),
      ...(args.tickLimit != null ? { tickLimit: args.tickLimit } : {}),
      ...(args.maxErrorRate != null ? { maxErrorRate: args.maxErrorRate } : {}),
      ...(resolvedWindow ? { sinceMs: resolvedWindow.sinceMs } : {}),
    });
    // P-007 generation parity: any judgment carrying a resolved window (explicit
    // override, or the EI-12146 rubric-derived default) also carries the identity of the
    // generation being judged. Omitted only in the rare fallback case where the rubric
    // itself could not be read at all (resolvedWindow stays undefined, pre-EI-12146
    // behavior).
    const runningGeneration = resolvedWindow
      ? await readRunningGeneration().catch(
          (): RunningGeneration => ({
            deployedSha: null,
            hostStartedAt: null,
            bootHeadSha: null,
            scoutCodeHash: null,
            staleHost: true,
          }),
        )
      : undefined;
    return {
      ok: true,
      report,
      ...(resolvedWindow ? { resolvedWindow, runningGeneration } : {}),
    };
  } catch (e) {
    return { ok: false, error: (e instanceof Error ? e.message : String(e)).slice(0, 300) };
  }
}

export default defineTool({
  name: 'blender:success-metrics',
  description:
    "Read-only Blender done-check over LIVE ledgers. Returns six PASS/FAIL/UNKNOWN bars: rubric-grounded routes, zero score-0 cycles, cycle errors <5% over the rubric's own declared window (default: its 48h-rolling `window`; or a sinceMs/watermarkRef override), per-cycle ledger reconciliation, attributed grade→typed revision, and recent lens diversity. Also returns resolvedWindow + runningGeneration (parity evidence; staleHost:true = scout loop not proven to run deployedSha's code). verdict='pass' only when every bar passes; 'incomplete' if evidence is missing; 'fail' on regression.",
  capability: 'curation:read',
  guidance: {
    when: 'Checking whether the self-learning substrate is actually WORKING on real rows — closing out the blender-self-learning program, or auditing whether rubric-grounded ideation / volume-mode cadence / grading throughput are live.',
    notWhen:
      'Asking whether Scout ideas are getting BETTER over time (the quality/degradation report — this is an absolute done-check, not a trend). Grading an individual idea (blender:grade-idea).',
    chaining:
      "Read verdict and each bar's evidence/unknownReason. Cite resolvedWindow + runningGeneration alongside the verdict (EI-12146: default window comes from the rubric, not a fixed 48h) — sinceMs/watermarkRef only overrides which window judges it.",
    seeAlso: ['blender:ideation-feedback (your own graded-idea priming)', 'blender:grade-idea (grade one routed idea)'],
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: successMetricsArgs,
  async handler(args, ctx) {
    const out = await runSuccessMetrics(args, ctx);
    return {
      content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
      ...(out.ok ? {} : { isError: true }),
    };
  },
});
