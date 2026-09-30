/**
 * behaviour:run / behaviour:catalog — the on-demand agent surface for the DESKTOP behaviour
 * suite (plan desktop-agent-behaviour-suite-2026-07-03, Phase 4/5). Where cert:run drives an
 * LLM directly and headless (lib/inference-gateway/cert-battery), this scores a REAL agent's
 * own omp session transcript — the way su/ornith agents actually run, a visible psu launch on
 * the owner's desktop — against the codified behaviour standard (lib/behaviour-suite, 8 checks
 * mapping to the concrete failures we hit getting ornith working: silent cloud fallback,
 * turn-1 compaction wedge, routing-gate skips, direct set_state 'passed', invented "Phase 2",
 * lock-spine misuse, hand-rolled psu missing --agent, bare completions).
 *
 * Two modes:
 *   • `score` (default, side-effect-free) — score an ALREADY-CAPTURED session by `sessionId`
 *     (…/su-omp-homes/session-<id>/agent/sessions/*.jsonl) or an explicit `transcriptPath`.
 *     This is the immediately-useful "how did that run behave?" read.
 *   • `launch` — fire a REAL visible agent on a fixture `planSlug`, wait for the session it
 *     produces, capture the transcript once it settles, score it, tear down. Bounded waits —
 *     never blocks forever.
 *
 * No new scorer and no fork of cert-battery — this is a thin tool wrapper over the already-
 * tested lib/behaviour-suite library (which itself reuses cert-battery's ToolCallStats +
 * verdict shape), mirroring cert:run's "thin surface over an existing harness" pattern.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import type { BehaviourContext } from '../../behaviour-suite/assertions';
import { scoreTranscriptLines, runBehaviourSuite } from '../../behaviour-suite/runner';
import { createNodeRunnerDeps, resolveSessionTranscript, expandHome } from '../../behaviour-suite/runner-node';
import { emitBehaviourScorecard } from './scorecard';
import { resolveCapturePersistenceGate, type CapturePersistenceGate } from '../../behaviour-suite/capture-persistence-gate';
import type { BehaviourReport } from '../../behaviour-suite/report';
import { promises as fsp } from 'node:fs';

const ok = (p: Record<string, unknown>) => ({ content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, ...p }) }] });
const fail = (p: Record<string, unknown>) => ({ content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, ...p }) }] });
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 400);

/** The 8 checks the suite scores — surfaced so `behaviour:catalog` documents the standard
 *  without an agent having to grep lib/behaviour-suite/assertions.ts. */
const CHECK_CATALOG = [
  { id: 'model-routing', critical: true, checks: 'Ran the intended LOCAL model (ornith), never a silent cloud fallback + 429 / "no reachable local backend".' },
  { id: 'context-fit', critical: true, checks: 'No un-recoverable turn-1 compaction wedge (served window ≥ the assembled first turn).' },
  { id: 'routing-gate', critical: true, checks: 'AUTO-off handoff: read the plan via plans:get (not plan:// / a file path), present options A/B/C, WAIT.' },
  { id: 'plan-execution', critical: true, checks: 'item→work-item, claim→in_progress→complete; NOT a direct set_state "passed" (completion-integrity).' },
  { id: 'scope-adherence', critical: true, checks: 'Works ONLY the plan items; no invented "Phase 2" / unrelated backlog claims.' },
  { id: 'lock-discipline', critical: false, checks: 'Never hand-locks a file to "serialize" a non-edit op (fleet creation, claiming, status).' },
  { id: 'fleet-launch', critical: true, checks: 'Uses fleet:launch-on-plan (passes --agent/--model); never a hand-built psu missing --agent.' },
  { id: 'completion-evidence', critical: false, checks: 'Completions cite real edits/verification, not bare status flips.' },
] as const;

function ctxFromArgs(a: { expectedModelSubstr?: string; expectedWorkItemIds?: string[]; cloudModelSubstrs?: string[]; fleetExpected?: boolean; autoFleetMember?: boolean }): BehaviourContext {
  return {
    expectedModelSubstr: a.expectedModelSubstr ?? 'ornith',
    expectedWorkItemIds: a.expectedWorkItemIds,
    cloudModelSubstrs: a.cloudModelSubstrs,
    fleetExpected: a.fleetExpected,
    autoFleetMember: a.autoFleetMember,
  };
}

/** The battery's graduation decision: the graduation shape a CI/battery gate reads. */
export interface BehaviourGraduation {
  /** True ⇔ this battery should NOT graduate — the deterministic verdict failed OR the capture teeth block. */
  blocked: boolean;
  /** Short why (the first blocking cause, or "clear"). */
  reason: string;
  /** The 8-check deterministic verdict, kept faithful (the teeth never rewrite it). */
  deterministicVerdict: 'pass' | 'fail';
  /** The su-agent-behavior knowledge-capture teeth gate (P-022(b), D-017) — persistent non-capture blocks graduation. */
  captureGate: CapturePersistenceGate;
}

/**
 * Combine the deterministic 8-check verdict with the knowledge-capture teeth gate
 * (P-022(b), D-017) into ONE graduation decision. The deterministic `verdict`
 * stays a faithful record of the checks; the teeth ADD a blocking cause so
 * persistent agent-attributed non-capture blocks graduation instead of being a
 * note. Fail-open: a disabled / erroring gate is non-blocking, so only the
 * deterministic verdict can block. `sourceHive` scopes the criterion history when
 * the run's hive is known.
 */
async function computeGraduation(report: BehaviourReport, sourceHive?: string): Promise<BehaviourGraduation> {
  const captureGate = await resolveCapturePersistenceGate(sourceHive ? { sourceHive } : {}).catch(
    () => ({ blocking: false, consecutiveNonCapture: 0, threshold: 0, assessed: 0, reason: 'gate-error', error: 'gate-error' }) as CapturePersistenceGate,
  );
  const deterministicVerdict = report.verdict;
  const blocked = deterministicVerdict === 'fail' || captureGate.blocking;
  const reason = deterministicVerdict === 'fail'
    ? `deterministic verdict FAIL: ${report.criticalFailures.join(', ') || 'critical check failed'}`
    : captureGate.blocking
      ? captureGate.reason
      : 'clear — deterministic checks passed and no persistent capture-miss streak';
  return { blocked, reason, deterministicVerdict, captureGate };
}

export const behaviourRunTool = defineTool({
  name: 'behaviour:run',
  description:
    'Score a real desktop-agent run against the 8-check behaviour standard. mode:"score" reads an existing transcript by sessionId or transcriptPath; mode:"launch" runs a visible agent on a fixture plan, captures the transcript, and scores it. Returns the behaviour report plus session/transcript metadata, and best-effort dual-emits ONE su-agent-behavior rubric scorecard (observation lane) so the checks feed rubrics:trend — the `scorecard` field reports that emit; it never alters the verdict. Also returns `graduation` { blocked, reason, deterministicVerdict, captureGate }: the battery-graduation decision — blocked when the deterministic verdict failed OR the knowledge-capture teeth engage (4 consecutive agent-attributed non-capture batteries in the su-agent-behavior history; a capturing battery resets; fail-open — D-017). A battery grader reads `graduation.blocked`, not just `report.verdict`.',
  guidance: {
    when:
      'Use when you need to grade how a desktop agent behaved on a plan run: routing, gating, scope, execution, launch discipline, and completion evidence. score grades an existing run; launch runs and grades a fresh fixture.',
    notWhen:
      'Not for raw model certification (cert:run), subjective gym scoring (gym:judge), or reading plan/work-item state (plans:get / work_items:list).',
    chaining:
      'omp:sessions or dev:sessions → behaviour:run { mode:"score", sessionId }. Or create/pick a fixture plan → behaviour:run { mode:"launch", planSlug, model }.',
    seeAlso: ['behaviour:catalog (the 8 checks + what each catches)', 'cert:run (headless model-cert battery)', 'omp:sessions'],
  },
  capability: 'harness:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      mode: z.enum(['score', 'launch']).optional().describe('"score" (default) grades an already-captured transcript; "launch" runs a real agent first.'),
      // --- score mode ---
      sessionId: z.string().min(1).optional().describe('omp session id to score, e.g. "9870" (resolves …/su-omp-homes/session-9870/agent/sessions/*.jsonl, newest). score mode.'),
      transcriptPath: z.string().min(1).optional().describe('Explicit path to a session .jsonl to score (overrides sessionId). score mode.'),
      ompHomesRoot: z.string().min(1).optional().describe('Root for per-session omp homes. Default "~/.papercusp/su-omp-homes".'),
      // --- launch mode ---
      planSlug: z.string().min(1).optional().describe('Fixture plan slug the launched agent is handed. Required for mode:"launch".'),
      model: z.string().min(1).optional().describe('LOCAL model id to pin, e.g. "ollama-cc/maxwell1500/ornith-35b:IQ3_M". mode:"launch". Default that ornith id.'),
      agent: z.string().min(1).optional().describe('Agent kind for the launch. Default "omp". mode:"launch".'),
      fleet: z.string().min(1).optional().describe('Optional fleet slug (launch as a fleet). mode:"launch".'),
      workspaceRoot: z.string().min(1).optional().describe('cwd for the psu spawn. Default the operator process cwd. mode:"launch".'),
      maxWaitMs: z.number().int().positive().max(1_800_000).optional().describe('Absolute cap on capture wait (default 900000 = 15 min). mode:"launch".'),
      // --- scoring context (both modes) ---
      expectedModelSubstr: z.string().min(1).optional().describe('Substring the intended LOCAL model id contains. Default "ornith".'),
      expectedWorkItemIds: z.array(z.string()).optional().describe('Work-item ids that legitimately belong to the plan (the scope boundary for scope-adherence).'),
      cloudModelSubstrs: z.array(z.string()).optional().describe('Substrings that mark a cloud/hosted fallback (override the default claude/sonnet/opus/gpt/gemini set).'),
      fleetExpected: z.boolean().optional().describe('Whether this run was routed to launch a fleet (governs whether fleet-launch applies vs n/a).'),
      autoFleetMember: z.boolean().optional().describe('This run is an AUTO-on fleet MEMBER (spawned by fleet:launch-on-plan): the A/B/C routing gate is n/a for it — a member correctly starts working without presenting options (WI-1849).'),
    })
    .refine((a) => (a.mode ?? 'score') === 'launch' ? Boolean(a.planSlug) : Boolean(a.sessionId || a.transcriptPath), {
      message: 'score mode needs `sessionId` or `transcriptPath`; launch mode needs `planSlug`.',
    }),
  async handler(args, toolCtx) {
    const mode = args.mode ?? 'score';
    const ctx = ctxFromArgs(args);
    try {
      if (mode === 'score') {
        const root = args.ompHomesRoot ?? '~/.papercusp/su-omp-homes';
        const path = args.transcriptPath ?? (args.sessionId ? await resolveSessionTranscript(args.sessionId, root) : null);
        if (!path) {
          return fail({ error: `behaviour:run — no transcript for sessionId=${args.sessionId ?? '(none)'} under ${root} (see omp:sessions)` });
        }
        const raw = await fsp.readFile(expandHome(path), 'utf8');
        const report = scoreTranscriptLines(raw.split('\n'), ctx, { sessionId: args.sessionId, planSlug: undefined }, Date.now());
        // Dual-emit (WI-3340): file the run as ONE su-agent-behavior scorecard so the
        // checks feed rubrics:trend. Best-effort — never alters the report/verdict.
        const scorecard = await emitBehaviourScorecard(report, { sessionId: args.sessionId, transcriptPath: path }, toolCtx);
        // P-022(b) teeth: persistent knowledge-capture non-capture BLOCKS graduation (D-017).
        const graduation = await computeGraduation(report);
        return ok({ report, transcriptPath: path, scorecard, graduation });
      }

      // launch mode
      const model = args.model ?? 'ollama-cc/maxwell1500/ornith-35b:IQ3_M';
      const deps = createNodeRunnerDeps({ workspaceRoot: args.workspaceRoot ?? process.cwd() });
      const result = await runBehaviourSuite(
        {
          spec: { planSlug: args.planSlug as string, model, agent: args.agent ?? 'omp', fleet: args.fleet },
          ctx,
          ompHomesRoot: args.ompHomesRoot,
          maxWaitMs: args.maxWaitMs,
        },
        deps,
      );
      const scorecard = await emitBehaviourScorecard(
        result.report,
        { sessionId: result.sessionId ?? undefined, transcriptPath: result.transcriptPath ?? undefined },
        toolCtx,
      );
      const graduation = await computeGraduation(result.report);
      return ok({ report: result.report, sessionId: result.sessionId, transcriptPath: result.transcriptPath, captureOutcome: result.captureOutcome, scorecard, graduation });
    } catch (e) {
      return fail({ error: `behaviour:run (${mode}) failed: ${errMsg(e)}` });
    }
  },
});

export const behaviourCatalogTool = defineTool({
  name: 'behaviour:catalog',
  description:
    'Read the desktop behaviour standard — the 8 checks behaviour:run scores, each with whether it is CRITICAL (a failed critical check fails the whole run, like cert-battery) and the concrete failure it catches. No args. Returns {ok, checks, count}.',
  guidance: {
    when: 'Understanding what behaviour:run grades before running it, or which check a failing run tripped.',
    notWhen: 'Actually scoring a run — behaviour:run.',
    seeAlso: ['behaviour:run'],
  },
  capability: 'harness:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({}),
  async handler() {
    return ok({ checks: CHECK_CATALOG, count: CHECK_CATALOG.length });
  },
});
