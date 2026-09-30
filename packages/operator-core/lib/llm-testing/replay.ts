/**
 * Replay — judge-only re-evaluation of a stored fixture or historical
 * run. No SUT call, no sim-user call. Cheap (~$0.10 per scenario at
 * Sonnet) and reproducible.
 *
 * Plan §9.1:
 *   replay --fixture <path>  — re-evaluate a frozen SSE tape
 *   replay --re-evaluate <run-id> — re-evaluate a historical run row
 *
 * Use cases:
 *   - Rubric edits: re-judge against existing transcripts to see what
 *     scores would change.
 *   - Asserting captured V8 evidence (the v8-baseline fixtures) catches
 *     specific behaviors without re-running the operator.
 */

import { randomUUID } from 'node:crypto';

import { getLongLivedAdminPool } from '../long-lived-admin-pool';

import {
  evaluateAsserts,
  loadFixtureTranscript,
  loadFixtureTelemetry,
  loadFixtureTurn,
  resolveFixturePath,
  computeIdentityHash,
  judgeRun,
  JUDGE_PROMPT_SCAFFOLD_VERSION,
  lookupBlend,
  resolvePersona,
  type JudgeResult,
  type Persona,
  type RunSummary,
  type Scenario,
  type TurnResult,
  type Violation,
} from '@papercusp/testing-shell/llm';

import { llmCall } from './llm-client';
import { pullToolInvocations, pullContinueChainRows } from './telemetry';
import { normalizeToolResultEvidence } from './tool-result-evidence';

// Transactional pool — re-resolves the admin URL on every use and rebinds if the endpoint
// moved (EI-19306394439939264). Shared connection options + idle policy come with it.
const db = () => getLongLivedAdminPool('llm-testing-replay', { max: 2, prepare: false });

export interface ReplayResult {
  summary: RunSummary;
  violations: Violation[];
  judge: JudgeResult;
  status: 'passed' | 'failed' | 'errored';
}

// =============================================================================
// Fixture replay
// =============================================================================

export interface FixtureReplayOpts {
  /** Either a fully resolved path OR a fixture id like 'v8-baseline/02-...'. */
  fixture: string;
  /** Scenario whose asserts + rubric drive the judge. */
  scenario: Scenario;
  /** Judge model. Same default rules as the runner. */
  judgeModel: string;
}

export async function replayFixture(opts: FixtureReplayOpts): Promise<ReplayResult> {
  const path = opts.fixture.includes('/') || opts.fixture.endsWith('.sse')
    ? opts.fixture
    : resolveFixturePath(opts.fixture);
  const looksLikePath = path.startsWith('/') || path.includes('fixtures/');
  const resolved = looksLikePath ? path : resolveFixturePath(path);

  const turns = loadFixtureTranscript(resolved) ?? [loadFixtureTurn(resolved)];
  const telemetry = loadFixtureTelemetry(resolved);
  const persona = resolvePersona(opts.scenario.persona, lookupBlend);
  const summary = buildSummary({
    scenario: opts.scenario,
    persona,
    judgeModel: opts.judgeModel,
    turns,
    workspaceMode: 'isolated',
    transportMode: 'http-sse',
  });
  if (telemetry) {
    summary.toolInvocations = telemetry.toolInvocations as RunSummary['toolInvocations'];
    summary.continueChainRows = telemetry.continueChainRows as RunSummary['continueChainRows'];
  }
  return evaluateRun(summary, opts.scenario, persona, opts.judgeModel);
}

// =============================================================================
// Fixture export — write a stored run as a reusable fixture pair
// =============================================================================

export interface ExportFixtureOpts {
  /** Source run id (from harness_shared.llm_test_runs). */
  runId: string;
  /** Relative fixture id (e.g. 'v8-baseline/08-my-capture'). Suffixes added. */
  fixtureId: string;
}

export interface ExportFixtureResult {
  ssePath: string;
  telemetryPath: string;
  transcriptPath: string;
  bytesSse: number;
  bytesTelemetry: number;
  bytesTranscript: number;
}

export async function exportFixtureFromRun(opts: ExportFixtureOpts): Promise<ExportFixtureResult> {
  const { zstdDecompressSync } = await import('node:zlib');
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const { dirname: pathDirname } = await import('node:path');
  const sql = db();
  const rows = await sql<Array<{
    transcript_raw_zstd: Buffer | null;
    transcript_norm_json: unknown;
    telemetry_json: { toolInvocations?: unknown; continueChainRows?: unknown } | null;
  }>>`
    SELECT transcript_raw_zstd, transcript_norm_json, telemetry_json
    FROM harness_shared.llm_test_runs
    WHERE id = ${opts.runId}
  `;
  if (rows.length === 0) throw new Error(`run not found: ${opts.runId}`);
  const row = rows[0];
  if (!row.transcript_raw_zstd) {
    throw new Error(`run ${opts.runId} has no transcript_raw_zstd (older run before zstd writer landed); re-run and try again.`);
  }

  // Decompress + reformat back to SSE-on-the-wire. The bytea holds a
  // JSON array of SseEvent {name, data, tMs}.
  const decompressed = zstdDecompressSync(row.transcript_raw_zstd).toString('utf8');
  const events = JSON.parse(decompressed) as Array<{ name: string; data: unknown }>;
  const sse = events.map((e) => {
    const dataStr = typeof e.data === 'string' ? e.data : JSON.stringify(e.data);
    return `event: ${e.name}\ndata: ${dataStr}\n`;
  }).join('\n');

  const telemetry = {
    toolInvocations: (row.telemetry_json?.toolInvocations ?? []) as unknown[],
    continueChainRows: (row.telemetry_json?.continueChainRows ?? []) as unknown[],
  };

  const ssePath = resolveFixturePath(opts.fixtureId);
  const telemetryPath = ssePath.replace(/\.sse$/, '.telemetry.json');
  mkdirSync(pathDirname(ssePath), { recursive: true });
  writeFileSync(ssePath, sse, 'utf8');
  const telemetryJson = JSON.stringify(telemetry, null, 2);
  writeFileSync(telemetryPath, telemetryJson, 'utf8');
  const transcriptPath = ssePath.replace(/\.sse$/, '.transcript.json');
  const transcript = {
    schemaVersion: 1,
    turns: Array.isArray(row.transcript_norm_json) ? row.transcript_norm_json : [],
  };
  const transcriptJson = JSON.stringify(transcript, null, 2);
  writeFileSync(transcriptPath, transcriptJson, 'utf8');

  return {
    ssePath,
    telemetryPath,
    transcriptPath,
    bytesSse: Buffer.byteLength(sse, 'utf8'),
    bytesTelemetry: Buffer.byteLength(telemetryJson, 'utf8'),
    bytesTranscript: Buffer.byteLength(transcriptJson, 'utf8'),
  };
}

// =============================================================================
// Run re-evaluation
// =============================================================================

export interface ReEvaluateOpts {
  /** Existing llm_test_runs row to re-judge. */
  runId: string;
  /** Scenario for the (possibly new) rubric. If absent, uses run's stored rubric_version. */
  scenarioOverride?: Scenario;
  /** Judge model. */
  judgeModel: string;
}

export async function reEvaluateRun(opts: ReEvaluateOpts): Promise<ReplayResult> {
  const sql = db();
  const rows = await sql<Array<{
    id: string;
    scenario_id: string;
    scenario_version: number;
    persona_id: string;
    persona_traits_json: Record<string, unknown>;
    sut_model: string;
    judge_model: string;
    workspace_mode: string;
    transport_mode: string;
    transcript_norm_json: {
      idx: number;
      assistantText: string;
      toolCalls: unknown;
      toolResults?: unknown;
      cards: unknown;
      controlTags: unknown;
      finishReason: string;
      costUsd: number;
      latencyMs: number;
      error: string | null;
      userText?: string;
      simThought?: string;
      simKind?: 'text' | 'choice';
    }[] | null;
  }>>`
    SELECT id, scenario_id, scenario_version, persona_id, persona_traits_json,
           sut_model, judge_model, workspace_mode, transport_mode,
           transcript_norm_json
    FROM harness_shared.llm_test_runs
    WHERE id = ${opts.runId}
  `;
  if (rows.length === 0) throw new Error(`run not found: ${opts.runId}`);
  const row = rows[0];

  if (!opts.scenarioOverride) {
    throw new Error('reEvaluateRun currently requires --scenario to provide the rubric; per-run rubric_version lookup is a Phase 2 follow-up.');
  }
  const scenario = opts.scenarioOverride;

  const turns: TurnResult[] = Array.isArray(row.transcript_norm_json)
    ? row.transcript_norm_json.map((t) => ({
      assistantText: t.assistantText,
      toolCalls: (t.toolCalls as TurnResult['toolCalls']) ?? [],
      toolResults: normalizeToolResultEvidence(t.toolResults),
      cards: (t.cards as TurnResult['cards']) ?? [],
      controlTags: (t.controlTags as TurnResult['controlTags']) ?? [],
      costUsd: t.costUsd,
      latencyMs: t.latencyMs,
      finishReason: t.finishReason as TurnResult['finishReason'],
      error: t.error ?? undefined,
      rawSseTape: [],
      ...(t.userText !== undefined ? { userText: t.userText } : {}),
      ...(t.simThought !== undefined ? { simThought: t.simThought } : {}),
      ...(t.simKind !== undefined ? { simKind: t.simKind } : {}),
    }))
    : [];

  const persona = resolvePersona(scenario.persona, lookupBlend);
  const summary = buildSummary({
    scenario,
    persona,
    judgeModel: opts.judgeModel,
    turns,
    workspaceMode: row.workspace_mode as 'isolated' | 'real',
    transportMode: row.transport_mode as 'in-process' | 'http-sse',
  });
  // Pull live telemetry tagged with the original run's uiClientId — this
  // preserves tool_called / continue_chain_within_cap accuracy on re-eval.
  try {
    const uiClientId = `llm-testing/${row.id}`;
    const [tools, chains] = await Promise.all([
      pullToolInvocations(uiClientId),
      pullContinueChainRows(uiClientId),
    ]);
    summary.toolInvocations = tools;
    summary.continueChainRows = chains;
  } catch {
    // Best-effort; deterministic asserts that depend on telemetry will under-report.
  }
  return evaluateRun(summary, scenario, persona, opts.judgeModel);
}

// =============================================================================
// Shared
// =============================================================================

interface BuildSummaryArgs {
  scenario: Scenario;
  persona: Persona;
  judgeModel: string;
  turns: TurnResult[];
  workspaceMode: 'isolated' | 'real';
  transportMode: 'in-process' | 'http-sse';
}

function buildSummary(args: BuildSummaryArgs): RunSummary {
  const totalCostUsd = args.turns.reduce((s, t) => s + t.costUsd, 0);
  const startedAt = new Date();
  return {
    runId: `replay-${randomUUID()}`,
    scenarioId: args.scenario.id,
    scenarioVersion: args.scenario.version,
    scenarioTarget: args.scenario.target,
    identityHash: computeIdentityHash({
      scenarioId: args.scenario.id,
      scenarioVersion: args.scenario.version,
      scenarioHash: 'replay',
      personaId: args.persona.id,
      personaTraits: args.persona.traits,
      rubricVersion: args.scenario.rubric.version,
      sutModel: 'replay',
      judgeModel: args.judgeModel,
      // D-013: this file stores nothing itself, but the identity it computes is
      // what DECLARES two runs comparable — so a scaffold-blind identity here
      // makes a replay claim comparability it cannot support.
      judgeScaffoldVersion: JUDGE_PROMPT_SCAFFOLD_VERSION,
    }),
    sutModel: 'replay',
    judgeModel: args.judgeModel,
    personaId: args.persona.id,
    personaTraits: args.persona.traits,
    workspaceMode: args.workspaceMode,
    transportMode: args.transportMode,
    turns: args.turns,
    toolInvocations: [],
    continueChainRows: [],
    totalCostUsd,
    startedAt,
    finishedAt: new Date(),
    finishReason: 'completed',
    capBreaches: [],
  };
}

async function evaluateRun(
  summary: RunSummary,
  scenario: Scenario,
  persona: Persona,
  judgeModel: string,
): Promise<ReplayResult> {
  const violations = evaluateAsserts(scenario.asserts, summary);
  const personaSummary = `${persona.id}: ${persona.traits.verbosity}, ${persona.traits.politeness}`;
  const goalSummary = describeGoal(scenario.goal);

  const judge = await judgeRun(
    {
      model: judgeModel,
      rubric: scenario.rubric,
      scenarioId: scenario.id,
      scenarioDescription: scenario.description,
      personaSummary,
      goalSummary,
    },
    summary,
    violations,
    llmCall,
  );

  // Replay's summary started with the original turn cost only;
  // judge.costUsd is the cost of THIS replay's judge passes.
  summary.totalCostUsd += judge.costUsd;

  const hasError = violations.some((v) => v.severity === 'error')
    || judge.findings.some((f) => f.severity === 'error');
  const status: ReplayResult['status'] = hasError ? 'failed' : 'passed';

  return { summary, violations, judge, status };
}

function describeGoal(g: Scenario['goal']): string {
  switch (g.kind) {
    case 'user_satisfied': return 'User-driven satisfaction.';
    case 'tool_fired': return `Tool '${g.toolName}' must be called.`;
    case 'card_emitted': return `Card '${g.cardKind}' must be emitted.`;
    case 'state_reached': return g.predicate;
  }
}
