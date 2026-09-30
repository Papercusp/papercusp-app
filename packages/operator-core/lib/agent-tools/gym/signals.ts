/**
 * gym:signals — evaluate a target blueprint's declared `gym.signals` (the
 * deterministic, un-gameable guardrails — D-011) over one run's inputs.
 *
 * The gym is a blueprint now (D-022); its judge/proposer roles resolve a target's
 * signals BY NAME through the host-side registry (`GYM_SIGNAL_REGISTRY`). This tool
 * is that resolution exposed to a role: pass the signal names + whatever run inputs
 * you have (pre/post tests, the planted bug, the harness output text, drill outcomes)
 * and get back each guardrail's boolean — with unknown/inapplicable signals reported,
 * never silently dropped.
 *
 * Drill-ground-truth signals (FB-23 / P-048) read red-queen drill rows. A judge can
 * supply them two ways: pass `drillOutcomes` explicitly (the test/override seam), OR
 * set `loadDrillOutcomes` to pull the live sandbox corpus from PG itself
 * (`readDrillOutcomes`, lib/red-queen/store.ts) — the no-hand-assembly path now that
 * the corpus is live (frontier:drill-corpus-live).
 *
 * harness-blueprint-orchestration-2026-06-03 P-012 / D-022. Pure (no PG, no LLM)
 * UNLESS `loadDrillOutcomes` is set, which lazily reads the drill corpus from PG.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { QUEEN_PLACEMENT_ROLES } from '../coordination/roles';
import { evaluateSignals, knownSignals, type SignalContext } from '../../gym/primitives';
import { SANDBOX_WORKSPACE_ID } from '../../red-queen/types';
import type { DrillOutcome as RedQueenDrillOutcome } from '../../red-queen/types';
import type { DrillOutcome as GymDrillOutcome } from '../../gym/drill-signals';

const testResult = z.object({ name: z.string(), passed: z.boolean() });

// Mirrors the red-queen v1 DrillOutcome contract (lib/gym/drill-signals.ts) — the
// drill-ground-truth judging inputs (FB-23 / P-048).
const drillOutcome = z.object({
  drillId: z.string(),
  drillClass: z.string(),
  collectorFamily: z.string(),
  plantedAt: z.string(),
  detectedAt: z.string().nullish(),
  triagedAt: z.string().nullish(),
  resolvedAt: z.string().nullish(),
  expectedWatchdogKey: z.string(),
  expectedKind: z.enum(['bug', 'change']),
  expectedSeverity: z.string(),
  expectedDecision: z.enum(['place', 'gate', 'gym', 'reject']).nullish(),
  detectedWatchdogKey: z.string().nullish(),
  detectedKind: z.string().nullish(),
  triagedDecision: z.string().nullish(),
  triagedIdeaType: z.string().nullish(),
  resolvedWithEvidence: z.boolean(),
  issueId: z.string().nullish(),
  mttsh: z
    .object({
      detectMs: z.number().optional(),
      triageMs: z.number().optional(),
      fixMs: z.number().optional(),
      totalMs: z.number().optional(),
    })
    .nullish(),
  leakCheckPassed: z.boolean().nullish(),
  status: z.enum(['planted', 'detected', 'triaged', 'resolved', 'failed', 'expired']),
  origin: z.literal('drill'),
});

/**
 * Compile-time drift guard (FB-23 ↔ FB-20). The DrillOutcome contract lives in
 * THREE places that must stay in lockstep:
 *   1. lib/red-queen/types.ts      — the SOURCE rows FB-20 produces (readDrillOutcomes)
 *   2. lib/gym/drill-signals.ts    — the gym signal-core mirror (this consumer reads it)
 *   3. the zod `drillOutcome` above — the wire schema for the explicit `drillOutcomes` arg
 * Both the load path (1→2) and the wire path (3→2) must remain assignable to the gym
 * signal contract; if a field is added/retyped incompatibly, the matching alias fails its
 * constraint and the build breaks (TS2344) — pointing the next editor straight here. (The
 * handler's real assignments enforce the same thing; these name it so the coupling is loud.)
 */
type Assignable<A extends B, B> = A;
export type _DrillContractSourcePin = Assignable<RedQueenDrillOutcome, GymDrillOutcome>;
export type _DrillContractWirePin = Assignable<z.infer<typeof drillOutcome>, GymDrillOutcome>;

export default defineTool({
  name: 'gym:signals',
  description:
    "Evaluate a target blueprint's deterministic gym signals (un-gameable guardrails) over one run's inputs. Pass `signals` (from the target's blueprint.gym.signals) + any of {preTests, postTests, plantedBug, harnessOutputText, drillOutcomes}. Returns {results:[{name,value,applicable,metric?}], unknown, known, drillSource}. Built-ins: regressionsFromTests (pre+post tests), plantedBugCaught (plantedBug+harnessOutputText), drillResolveRate/drillTriageAccuracy/drillMttsh (drill rows w/ planted known answers; value=SLO verdict, metric=raw rate/ms). Drill rows: pass drillOutcomes, or set loadDrillOutcomes to read the live sandbox corpus from PG.",
  guidance: {
    when: "Scoring a gym run's deterministic guardrails — the optimizer can't game these, so they gate/monitor a variant independently of the judge. Resolve the TARGET blueprint's gym.signals by name; set loadDrillOutcomes to pull the live red-queen sandbox corpus for the drill signals.",
    notWhen: 'Subjective quality scoring — that is the frozen judge (gym:judge). Running the pipeline — the gym runner.',
    chaining: 'gym runner → collect run inputs (tests/output) → gym:signals (loadDrillOutcomes for drill targets) → proposer + trace summary.',
    seeAlso: [
      'gym:judge (judge a run from these signals)',
      'gym:set-gates (the gates a judged run is measured against)',
    ],
  },
  capability: 'harness:read',
  requirePrincipal: false,
  // D-002 (bee-capability-expansion-2026-06-08): gym signals are a Queen-only
  // optimization surface — the worker-bee (a COORD_ROLE since local-hive P-011) is
  // EXCLUDED so [...COORD_ROLES] doesn't leak it. Other coord roles are unchanged.
  // Overwatch excluded too (overwatch-role-2026-06-15): not a gym evaluator, and this
  // gates on harness:read which the overwatch carries — the allowlist is the gate.
  agentRoles: QUEEN_PLACEMENT_ROLES,
  args: z.object({
    signals: z.array(z.string()).min(1).describe("Signal names from the target blueprint's gym.signals"),
    preTests: z.array(testResult).optional().describe("The repo's own tests run BEFORE the change"),
    postTests: z.array(testResult).optional().describe("The repo's own tests run AFTER the change"),
    plantedBug: z
      .object({ location: z.string(), defect: z.string().optional(), detectionSignature: z.string().optional() })
      .optional()
      .describe('The defect planted in the task (for plantedBugCaught)'),
    harnessOutputText: z.string().optional().describe("The harness's produced output (verdicts, filed issues)"),
    drillOutcomes: z
      .array(drillOutcome)
      .optional()
      .describe('Red-queen drill outcomes (planted known answers) for the drill-ground-truth signals — pass explicitly, or set loadDrillOutcomes to read them from PG'),
    loadDrillOutcomes: z
      .boolean()
      .optional()
      .describe('Load the live sandbox drill corpus from PG (readDrillOutcomes) into the drill signals instead of passing drillOutcomes by hand. Opt-in; when off the tool does no I/O. Ignored if drillOutcomes is also given (explicit wins).'),
    drillWorkspaceId: z
      .string()
      .optional()
      .describe(`Workspace to load drills from when loadDrillOutcomes is set (default '${SANDBOX_WORKSPACE_ID}', the red-queen sandbox).`),
    drillClass: z.string().optional().describe('Restrict loaded drills to one drill_class (e.g. "smoke-fail").'),
    drillsSinceTs: z.string().optional().describe('Only load drills planted at/after this ISO timestamp.'),
    drillsLimit: z
      .number()
      .int()
      .positive()
      .max(2000)
      .optional()
      .describe('Cap the number of loaded drill rows (store default 200, max 2000).'),
  }),
  async handler(args) {
    // drillOutcomes precedence: an explicit arg wins (test/override seam); otherwise
    // loadDrillOutcomes lazily reads the live corpus. When neither is given the drill
    // signals report inapplicable (never a fake zero), same as before.
    let drillOutcomes: SignalContext['drillOutcomes'] = args.drillOutcomes;
    let drillSource: { mode: 'explicit' | 'loaded' | 'none'; count: number; workspaceId?: string } = {
      mode: drillOutcomes ? 'explicit' : 'none',
      count: drillOutcomes?.length ?? 0,
    };
    if (args.loadDrillOutcomes && !drillOutcomes) {
      const { getOrgPg } = await import('@papercusp/db-org');
      const { readDrillOutcomes } = await import('../../red-queen/store');
      const workspaceId = args.drillWorkspaceId ?? SANDBOX_WORKSPACE_ID;
      const loaded = await readDrillOutcomes(getOrgPg().sql, {
        workspaceId,
        classId: args.drillClass,
        sinceTs: args.drillsSinceTs,
        limit: args.drillsLimit,
      });
      drillOutcomes = loaded;
      drillSource = { mode: 'loaded', count: loaded.length, workspaceId };
    }
    const ctx: SignalContext = {
      preTests: args.preTests,
      postTests: args.postTests,
      plantedBug: args.plantedBug
        ? { location: args.plantedBug.location, defect: args.plantedBug.defect ?? '', detectionSignature: args.plantedBug.detectionSignature ?? '' }
        : null,
      harnessOutputText: args.harnessOutputText,
      drillOutcomes,
    };
    const { results, unknown } = evaluateSignals(args.signals, ctx);
    return {
      content: [
        { type: 'text' as const, text: JSON.stringify({ ok: unknown.length === 0, results, unknown, known: knownSignals(), drillSource }) },
      ],
    };
  },
});
