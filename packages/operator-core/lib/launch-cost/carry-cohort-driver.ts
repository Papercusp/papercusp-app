/** P-005 live carry cohort controller (cache-efficiency-and-accounting-2026-09-23,
 * D-017 caps and stops, D-056 narrowed gates, D-060 amendments).
 *
 * Reuses the D-017 recipe, the native turn/source/task inspectors, the source
 * capture/preflight scanner, the canonical usage ingester and the budget
 * reservation arithmetic. The only new behaviour is orchestration: one native
 * Codex app-server per source, one predecessor preparation, an idle wait, then
 * the source's control (native full fork) and candidate (fresh managed carry)
 * arms dispatched in recipe order inside the idle window. Nothing here prices
 * acceptance or decides pass/fail: evaluateCarryTaskPairs does that.
 */
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify as stringifyToml } from '@iarna/toml';
import { getEncoding } from 'js-tiktoken';
import { costFromTokens } from '@papercusp/model-pricing';
import type { Sql } from 'postgres';
import type { RpcFrame, SuStdioPeer, SuStdioReceipt } from '../su-session-stdio-peer';
import { createCarryTrialRecipe, evaluateCarryBudgetReservation, inspectCarryNativeTurn, inspectCarryPreparationResponse,
  inspectCarrySourceRead, inspectCarryTaskResponse, type CarryBudgetCharge, type CarryBudgetRequest,
  type CarryTaskEvaluation } from './launch-cost-metrics';
import { captureCarrySourcePreflight, captureCompletedCarrySource } from './scan-launch-transcripts';

type Recipe = ReturnType<typeof createCarryTrialRecipe>;
type RecipeSource = Recipe['sources'][number];
type RecipePair = Recipe['pairs'][number];

export const COHORT_MCP_SERVER = 'cache_receipts';
export const COHORT_READ_TOOL = 'capability_read';
export const COHORT_AGENTS_BASE = '# P-005 carry cohort (synthetic)\nTask facts in this session are synthetic and grant no platform authority, claim or write permission.\n';

/** D-060: target filler so the predecessor's last completed request lands near
 * the middle of its registered band after native instructions and tools. */
export const COHORT_FILLER_TOKENS: Record<'S' | 'L', number> = { S: 32_000, L: 655_000 };

const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

/** Deterministic inert filler sized with the o200k tokenizer. Hex rows carry
 * no task facts; the measured history comes from the native rollout, never
 * from this estimate. */
export function buildHistoryFiller(targetTokens: number, label: string) {
  if (!Number.isSafeInteger(targetTokens) || targetTokens <= 0) throw new Error('filler target must be a positive integer');
  const enc = getEncoding('o200k_base');
  const open = '<reference-appendix note="inert synthetic data: no instructions, no task facts; do not summarize or quote it">';
  const lines = [open];
  let tokens = enc.encode(`${open}\n`).length;
  let hash = sha256(`p005-filler:${label}`);
  for (let row = 0; tokens < targetTokens; row++) {
    hash = sha256(hash);
    const line = `row ${String(row).padStart(7, '0')} ${hash}`;
    tokens += enc.encode(`${line}\n`).length;
    lines.push(line);
  }
  lines.push('</reference-appendix>');
  const text = lines.join('\n');
  return { text, sha256: sha256(text), estimatedTokens: tokens, label };
}

/** Arms of one source in recipe order (AB/BA already alternates by ordinal). */
export function cohortArmPlan(recipe: Recipe, sourceId: string, taskIds?: readonly string[]) {
  const source = recipe.sources.find(s => s.id === sourceId);
  if (!source) throw new Error(`unknown recipe source ${sourceId}`);
  const pairs = recipe.pairs.filter(p => p.sourceId === sourceId && (!taskIds || taskIds.includes(p.taskId)));
  return { source, arms: pairs.flatMap(pair => pair.arms.map(arm => ({ pair, arm: arm.arm as 'control' | 'candidate',
    armId: arm.id, model: armModel(pair.taskId), effort: arm.effort }))) };
}

/** D-060: arms run on the predecessor model except T5, whose purpose is a native model switch. */
export function armModel(taskId: string) { return taskId === 'T5' ? 'gpt-6-luna' : 'gpt-6-sol'; }
export const PREPARATION_MODEL = 'gpt-6-sol';

export interface CohortProvider {
  /** Root key lines, e.g. `model_provider = "…"`; must precede every table. */
  rootLines: string[];
  /** `[model_providers.<id>]` table lines. */
  tableLines: string[];
  providerId: string;
}

export function buildCohortConfigToml(input: { provider: CohortProvider; mcpUrl: string; mcpToken: string;
  modelContextWindow: number; autoCompactTokenLimit: number }) {
  const body = stringifyToml({
    model_reasoning_effort: 'medium',
    model_context_window: input.modelContextWindow,
    model_auto_compact_token_limit: input.autoCompactTokenLimit,
    web_search: 'disabled',
    features: { apps: false, shell_tool: false, shell_snapshot: false, plugins: false, remote_plugin: false },
    mcp_servers: { [COHORT_MCP_SERVER]: { url: input.mcpUrl, http_headers: { Authorization: `Bearer ${input.mcpToken}` } } },
  } as Parameters<typeof stringifyToml>[0]);
  return `${input.provider.rootLines.join('\n')}\n${body}\n${input.provider.tableLines.join('\n')}\n`;
}

/** Arm request record written for every observed arm, including failures. */
export interface CohortArmRecord {
  pairId: string; sourceId: string; taskId: string; arm: 'control' | 'candidate'; armId: string;
  model: string; threadId: string | null; turnIds: string[];
  sourceRef: string | null; historyInputTokens: number | null; historyEvidenceRef: string | null;
  predecessorCompletedAtMs: number | null; firstDispatchAtMs: number | null; firstUsefulAtMs: number | null;
  observedIdleMs: number | null; idleEvidenceRef: string | null; firstUsefulResponseMs: number | null;
  completed: boolean; quality: 'pass' | 'fail' | 'unverified'; qualityEvidence: Record<string, unknown>;
  response: string | null; errors: string[]; workloadFingerprint: string; transport: string; authorizationScope: string;
}

export interface CohortSourceRecord {
  sourceId: string; homeDir: string; threadId: string | null; turnId: string | null; sourceRef: string | null;
  filler: { sha256: string; estimatedTokens: number } | null; history: unknown; idle: unknown;
  preparation: { matches: boolean | null; trace: string; response: string | null } | null;
  carry: { launchContextPath: string; carrySha256: string } | null; errors: string[];
}

export interface CohortDeps {
  openPeer(input: { home: string; onMessage(frame: RpcFrame): void; onReceipt(receipt: SuStdioReceipt): void }): Promise<SuStdioPeer>;
  mintCarry(input: { home: string; sourceThreadId: string; seedText: string }): { carryText: string; launchContextPath: string };
  readTool(args: { file_path: string; byte_offset: number; byte_limit: number }, home: string): Promise<{ content: Array<{ type: 'text'; text: string }> }>;
  now(): number;
  sleep(ms: number): Promise<void>;
  log(line: string): void;
  /** Called once the idle window opens, immediately before any arm dispatch. */
  admit(input: { sourceId: string; armIds: string[] }): Promise<{ ok: boolean; reason?: string }>;
  /** Observation hook after the predecessor is frozen but before a long idle
   * wait can evict its request-stage/account receipt from the gateway ring. */
  afterPreparation?(input: { sourceId: string; threadId: string; turnId: string }): Promise<void>;
  /** D-063 runtime half of the pre-charge root manifest. Called after the
   * exact native source and managed carry hashes exist, but before any
   * control/candidate arm can dispatch. */
  afterSourceBound?(input: { source: Readonly<CohortSourceRecord> }):
    Promise<{ ok: boolean; reason?: string }>;
  /** D-060 paid-pilot checkpoint. When a source names `pilotTaskId`, that
   * control/candidate pair runs first against the source's one frozen cut.
   * The remaining arms stay in the same app-server and start only after this
   * hook accepts the observed pair. Omitting the hook fails closed. */
  afterPilot?(input: { sourceId: string; taskId: string; arms: readonly CohortArmRecord[] }):
    Promise<{ ok: boolean; reason?: string }>;
}

export interface CohortSourceInput {
  recipe: Recipe; sourceId: string; taskIds?: readonly string[]; homeDir: string; provider: CohortProvider;
  transport: string; authorizationScope: string; fillerTokens: number;
  /** Run this task's two arms before any other task arm for the source. This
   * keeps the pilot inside the registered 30 pairs and preserves the single
   * source cut that evaluateCarryTaskPairs requires. */
  pilotTaskId?: string;
  /** Fail closed before every compared arm unless afterSourceBound accepts the
   * exact source/carry binding. Paid D-063 runs always set this. */
  sourceBindingRequired?: boolean;
  /** Dispatch offset after the idle window opens; arms are staggered by staggerMs. */
  windowMarginMs: number; staggerMs: number; turnTimeoutMs: number;
  modelContextWindow: number; autoCompactTokenLimit: number;
}

export interface CohortSourceRunResult {
  source: CohortSourceRecord;
  arms: CohortArmRecord[];
  stop: string | null;
}

/** A persisted source is resumable only when the whole registered source
 * population completed cleanly. A preparation-only or partially dispatched
 * failure must never masquerade as an already-finished source on restart. */
export function isCompletedCohortSourceRun(recipe: Recipe, result: CohortSourceRunResult) {
  const expectedArms = recipe.pairs.filter(pair => pair.sourceId === result.source.sourceId).length * 2;
  return result.stop === null && result.source.errors.length === 0 && result.arms.length === expectedArms &&
    result.arms.every(arm => arm.completed && arm.quality === 'pass' && arm.errors.length === 0);
}

/** Every new immutable retry root must chain all earlier attempts, including
 * preparation-only failures. An explicit ordinal prevents a runner from
 * accidentally omitting retry-1 when it starts retry-2. */
export function cohortPriorAttemptIds(attemptId: string) {
  if (attemptId === 'initial') return [];
  const match = /^retry-([1-9][0-9]*)$/.exec(attemptId);
  const ordinal = match ? Number(match[1]) : NaN;
  if (!Number.isSafeInteger(ordinal) || ordinal > 100) throw new Error(`invalid cohort attempt ${attemptId}`);
  return ['initial', ...Array.from({ length: ordinal - 1 }, (_, index) => `retry-${index + 1}`)];
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Host a loopback MCP server exposing the canonical capability:read handler. */
async function startReadServer(deps: CohortDeps, home: string, token: string, reads: Array<{ at: number; args: unknown }>) {
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { StreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/streamableHttp.js');
  const { z } = await import('zod');
  const server: Server = createServer(async (req, res) => {
    try {
      if (req.url !== '/mcp' || req.headers.authorization !== `Bearer ${token}`) { res.writeHead(404).end(); return; }
      const host = new McpServer({ name: 'p005-carry-cohort-source', version: '1' });
      host.registerTool(COHORT_READ_TOOL, {
        inputSchema: { file_path: z.string(), byte_offset: z.number(), byte_limit: z.number() },
        annotations: { readOnlyHint: true },
      }, async args => { reads.push({ at: deps.now(), args }); return await deps.readTool(args, home); });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      await host.connect(transport); await transport.handleRequest(req, res);
    } catch { if (!res.headersSent) res.writeHead(500); res.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('read server has no loopback port');
  return { server, url: `http://127.0.0.1:${address.port}/mcp` };
}

/** One native app-server with per-thread event demultiplexing. */
async function openLive(deps: CohortDeps, home: string) {
  const events: RpcFrame[] = [], receipts: SuStdioReceipt[] = [];
  const p = await deps.openPeer({ home, onMessage: frame => events.push(frame), onReceipt: receipt => receipts.push(receipt) });
  await p.request({ method: 'initialize', params: { clientInfo: { name: 'p005_carry_cohort', version: '1' } } });
  p.send({ method: 'initialized', params: {} });
  return { p, events, receipts };
}
type Live = Awaited<ReturnType<typeof openLive>>;

function turnEvents(events: readonly RpcFrame[], threadId: string, turnId: string) {
  return events.filter(event => {
    const params = record(event.params);
    return params.threadId === threadId && (params.turnId === turnId || record(params.turn).id === turnId);
  });
}

async function runTurn(deps: CohortDeps, live: Live, input: { threadId: string; text: string; model?: string;
  timeoutMs: number; allowedMcpCalls?: unknown[]; bindInput: boolean }) {
  const response = await live.p.request({ method: 'turn/start', params: { threadId: input.threadId,
    input: [{ type: 'text', text: input.text }], ...(input.model ? { model: input.model } : {}) } }, input.timeoutMs);
  const turnId = String(record(response.turn).id);
  const deadline = deps.now() + input.timeoutMs;
  const done = () => live.events.find(event => event.method === 'turn/completed' &&
    record(event.params).threadId === input.threadId && record(record(event.params).turn).id === turnId);
  while (!done()) {
    if (deps.now() > deadline) throw new Error(`turn ${turnId} did not complete within ${input.timeoutMs}ms`);
    await deps.sleep(250);
  }
  const completion = live.receipts.find(r => r.phase === 'received' && r.frame.method === 'turn/completed' &&
    record(r.frame.params).threadId === input.threadId && record(record(r.frame.params).turn).id === turnId);
  const dispatch = live.receipts.find(r => r.phase === 'write-started' && r.frame.method === 'turn/start' &&
    record(r.frame.params).threadId === input.threadId && JSON.stringify(record(r.frame.params).input) ===
      JSON.stringify([{ type: 'text', text: input.text }]));
  const threadRead = await live.p.request({ method: 'thread/read', params: { threadId: input.threadId, includeTurns: true } });
  const evidence = { threadId: input.threadId, turnId, events: turnEvents(live.events, input.threadId, turnId), threadRead,
    allowedMcpCalls: input.allowedMcpCalls ?? [], ...(input.bindInput ? { expectedInputText: input.text } : {}) };
  const trace = inspectCarryNativeTurn(evidence as Parameters<typeof inspectCarryNativeTurn>[0]);
  return { turnId, trace, evidence, dispatchAtMs: dispatch?.atMs ?? null, completedAtMs: completion?.atMs ?? null,
    status: String(record(record(done()!.params).turn).status) };
}

/** Run one registered source: preparation, idle wait, then its arms. */
export async function runCarryCohortSource(deps: CohortDeps, input: CohortSourceInput): Promise<{
  source: CohortSourceRecord; arms: CohortArmRecord[]; stop: string | null }> {
  const { recipe } = input;
  const plan = cohortArmPlan(recipe, input.sourceId, input.taskIds);
  const pilotPlans = input.pilotTaskId ? plan.arms.filter(arm => arm.pair.taskId === input.pilotTaskId) : [];
  if (input.pilotTaskId && pilotPlans.length !== 2) {
    throw new Error(`pilot task ${input.pilotTaskId} must name exactly one control/candidate pair in ${input.sourceId}`);
  }
  const stratum = input.sourceId.split('-')[0] as 'S' | 'L';
  mkdirSync(input.homeDir, { recursive: true, mode: 0o700 });
  // One fixed base shared by the predecessor and every arm; the managed carry
  // requires a non-empty base and layers the seed on top of it (D-060).
  writeFileSync(join(input.homeDir, 'AGENTS.md'), COHORT_AGENTS_BASE, { mode: 0o600 });
  const token = sha256(`${input.homeDir}:${deps.now()}`).slice(0, 32);
  const reads: Array<{ at: number; args: unknown }> = [];
  const read = await startReadServer(deps, input.homeDir, token, reads);
  writeFileSync(join(input.homeDir, 'config.toml'), buildCohortConfigToml({ provider: input.provider, mcpUrl: read.url,
    mcpToken: token, modelContextWindow: input.modelContextWindow, autoCompactTokenLimit: input.autoCompactTokenLimit }), { mode: 0o600 });
  const sourceRecord: CohortSourceRecord = { sourceId: input.sourceId, homeDir: input.homeDir, threadId: null, turnId: null,
    sourceRef: null, filler: null, history: null, idle: null, preparation: null, carry: null, errors: [] };
  const arms: CohortArmRecord[] = [];
  const options = { modelProvider: input.provider.providerId, cwd: input.homeDir, approvalPolicy: 'never', sandbox: 'read-only' };
  let live: Live | null = null;
  try {
    live = await openLive(deps, input.homeDir);
    const filler = buildHistoryFiller(input.fillerTokens, input.sourceId);
    sourceRecord.filler = { sha256: filler.sha256, estimatedTokens: filler.estimatedTokens };
    const started = await live.p.request({ method: 'thread/start', params: { ...options, model: PREPARATION_MODEL } });
    const sourceThreadId = String(record(started.thread).id);
    sourceRecord.threadId = sourceThreadId;
    const prepText = `${filler.text}\n\n${recipe.sourcePreparation.prompt}`;
    deps.log(`${input.sourceId} preparation dispatch (filler ~${filler.estimatedTokens} tokens)`);
    const prepared = await runTurn(deps, live, { threadId: sourceThreadId, text: prepText, model: PREPARATION_MODEL,
      timeoutMs: input.turnTimeoutMs, bindInput: false });
    sourceRecord.turnId = prepared.turnId;
    const ack = prepared.trace.finalResponse ? inspectCarryPreparationResponse(prepared.trace.finalResponse) : null;
    sourceRecord.preparation = { matches: ack?.matches ?? null, trace: prepared.trace.status, response: prepared.trace.finalResponse };
    if (prepared.status !== 'completed') throw new Error(`preparation turn ${prepared.status}`);
    const source = await captureCompletedCarrySource(live.p, sourceThreadId, prepared.turnId);
    const preflight = await captureCarrySourcePreflight({ source, sourceId: input.sourceId, receipts: live.receipts });
    sourceRecord.sourceRef = preflight.sourceRef;
    sourceRecord.history = preflight.history; sourceRecord.idle = preflight.idle;
    deps.log(`${input.sourceId} history=${preflight.history?.inputTokens ?? 'unknown'} inBand=${preflight.history?.inBand ?? false}`);
    if (deps.afterPreparation) {
      await deps.afterPreparation({ sourceId: input.sourceId, threadId: sourceThreadId, turnId: prepared.turnId });
    }
    // Mint the carry from the stopped source BEFORE any arm creates a newer rollout.
    const carry = deps.mintCarry({ home: input.homeDir, sourceThreadId, seedText: recipe.seedText });
    sourceRecord.carry = { launchContextPath: carry.launchContextPath, carrySha256: sha256(carry.carryText) };
    const sentinel = Buffer.from(String(recipe.tasks.find(t => t.id === 'T2')!.expected.sourceSentinel));
    const offset = source.snapshot.bytes.indexOf(sentinel);
    const readArgs = offset > 0 ? { file_path: source.filePath, byte_offset: offset, byte_limit: sentinel.length } : null;
    const window = readArgs ? { sourceRef: preflight.sourceRef, server: COHORT_MCP_SERVER, tool: COHORT_READ_TOOL,
      filePath: source.filePath, byteOffset: readArgs.byte_offset, byteLength: readArgs.byte_limit,
      totalBytes: source.snapshot.completeBytes, sha256: sha256(sentinel) } : null;
    if (!window) sourceRecord.errors.push('source-sentinel-not-found');
    const sourceBinding = deps.afterSourceBound
      ? await deps.afterSourceBound({ source: structuredClone(sourceRecord) })
      : input.sourceBindingRequired ? { ok: false, reason: 'afterSourceBound hook is required' } : { ok: true };
    if (!sourceBinding.ok) {
      return { source: sourceRecord, arms, stop: `source-binding-refused:${sourceBinding.reason ?? 'unknown'}` };
    }
    const completedAt = preflight.idle?.completedAtMs ?? null;
    if (completedAt === null) throw new Error('predecessor completion receipt unavailable');
    const opensAt = completedAt + plan.source.idle.minMs + input.windowMarginMs;
    const waitMs = opensAt - deps.now();
    if (waitMs > 0) { deps.log(`${input.sourceId} idle wait ${Math.round(waitMs / 1000)}s`); await deps.sleep(waitMs); }
    const admission = await deps.admit({ sourceId: input.sourceId, armIds: plan.arms.map(a => a.armId) });
    if (!admission.ok) return { source: sourceRecord, arms, stop: `admission-refused:${admission.reason ?? 'unknown'}` };
    // captureCompletedCarrySource closed the preparation peer (writer exclusion
    // before the cut is read). Arms run in one fresh app-server on the same home.
    live = await openLive(deps, input.homeDir);
    const runPlans = async (selected: typeof plan.arms) => await Promise.all(selected.map((armPlan, index) => (async () => {
      await deps.sleep(index * input.staggerMs);
      return await runArm(deps, live!, { input, armPlan, options, sourceThreadId, completedAt, preflight, carry, window, readArgs });
    })()));
    if (input.pilotTaskId) {
      const observedPilot = await runPlans(pilotPlans);
      arms.push(...observedPilot);
      const pilotSecurity = observedPilot.find(arm => arm.errors.some(error => error.startsWith('violation:')));
      if (pilotSecurity) return { source: sourceRecord, arms, stop: `native-violation:${pilotSecurity.armId}` };
      const verdict = deps.afterPilot
        ? await deps.afterPilot({ sourceId: input.sourceId, taskId: input.pilotTaskId, arms: observedPilot })
        : { ok: false, reason: 'afterPilot hook is required' };
      if (!verdict.ok) return { source: sourceRecord, arms, stop: `pilot-refused:${verdict.reason ?? 'unknown'}` };
      const pilotArmIds = new Set(pilotPlans.map(arm => arm.armId));
      arms.push(...await runPlans(plan.arms.filter(arm => !pilotArmIds.has(arm.armId))));
    } else {
      arms.push(...await runPlans(plan.arms));
    }
    const security = arms.find(a => a.errors.some(e => e.startsWith('violation:')));
    return { source: sourceRecord, arms, stop: security ? `native-violation:${security.armId}` : null };
  } catch (error) {
    sourceRecord.errors.push(error instanceof Error ? error.message : String(error));
    return { source: sourceRecord, arms, stop: `source-failed:${input.sourceId}` };
  } finally {
    if (live) { await live.p.close().catch(() => undefined); await live.p.done.catch(() => undefined); }
    await new Promise<void>(resolve => read.server.close(() => resolve()));
  }
}

async function runArm(deps: CohortDeps, live: Live, ctx: {
  input: CohortSourceInput; armPlan: ReturnType<typeof cohortArmPlan>['arms'][number];
  options: Record<string, unknown>; sourceThreadId: string; completedAt: number;
  preflight: Awaited<ReturnType<typeof captureCarrySourcePreflight>>; carry: { carryText: string };
  window: Parameters<typeof inspectCarrySourceRead>[1] | null; readArgs: Record<string, unknown> | null;
}): Promise<CohortArmRecord> {
  const { pair, arm, armId, model } = ctx.armPlan;
  const task = ctx.input.recipe.tasks.find(t => t.id === pair.taskId)!;
  const workload = sha256(JSON.stringify({ recipe: ctx.input.recipe.sha256, pair: pair.id, sourceRef: ctx.preflight.sourceRef, model }));
  const row: CohortArmRecord = { pairId: pair.id, sourceId: pair.sourceId, taskId: task.id, arm, armId, model,
    threadId: null, turnIds: [], sourceRef: ctx.preflight.sourceRef, historyInputTokens: ctx.preflight.history?.inputTokens ?? null,
    historyEvidenceRef: ctx.preflight.history?.evidenceRef ?? null, predecessorCompletedAtMs: ctx.completedAt,
    firstDispatchAtMs: null, firstUsefulAtMs: null, observedIdleMs: null, idleEvidenceRef: ctx.preflight.idle?.evidenceRef ?? null,
    firstUsefulResponseMs: null, completed: false, quality: 'unverified', qualityEvidence: {}, response: null, errors: [],
    workloadFingerprint: workload, transport: ctx.input.transport, authorizationScope: ctx.input.authorizationScope };
  try {
    const opened = await live.p.request({ method: arm === 'control' ? 'thread/fork' : 'thread/start',
      params: { ...ctx.options, model, ...(arm === 'control' ? { threadId: ctx.sourceThreadId } : {}) } });
    const threadId = String(record(opened.thread).id);
    row.threadId = threadId;
    const turnOptions = { threadId, model, timeoutMs: ctx.input.turnTimeoutMs };
    const recover = task.id === 'T2' && ctx.window && ctx.readArgs;
    const prompt = recover ? `${task.prompt}\nRecovery reference: ${ctx.window!.sourceRef}\nByte window: ${JSON.stringify(ctx.readArgs)}`
      : task.prompt;
    const allowed = recover ? [{ server: COHORT_MCP_SERVER, tool: COHORT_READ_TOOL, arguments: ctx.readArgs }] : [];
    // A real fresh Codex successor receives its carry as the first actionable
    // turn. Give the candidate the objective task in that same turn: a separate
    // carry-only turn would execute nextAction before the matched task arrives.
    // The frozen carry bytes and hash remain unchanged, and any premature or
    // unapproved action in this turn still fails the native trace checker.
    const turnText = arm === 'candidate' ? `${ctx.carry.carryText}\n\n${prompt}` : prompt;
    const result = await runTurn(deps, live, { ...turnOptions, text: turnText, allowedMcpCalls: allowed, bindInput: true });
    row.turnIds.push(result.turnId);
    row.firstDispatchAtMs = result.dispatchAtMs;
    row.firstUsefulAtMs = result.completedAtMs;
    row.completed = result.status === 'completed';
    row.response = result.trace.finalResponse;
    if (result.trace.violations.length) row.errors.push(...result.trace.violations.map(v => `violation:task:${v}`));
    const check = inspectCarryTaskResponse({ taskId: task.id, response: result.trace.finalResponse ?? '',
      boundSourceRef: task.id === 'T2' ? ctx.preflight.sourceRef : undefined });
    const sourceRead = task.id === 'T2' && ctx.window ? inspectCarrySourceRead(result.evidence as Parameters<typeof inspectCarrySourceRead>[0], ctx.window) : null;
    row.qualityEvidence = { trace: { status: result.trace.status, missing: result.trace.missing, violations: result.trace.violations },
      check: { matches: check.matches, missing: check.missing, violations: check.violations, oracleSha256: check.oracleSha256 },
      ...(sourceRead ? { sourceRead: { status: sourceRead.status, missing: sourceRead.missing, violations: sourceRead.violations } } : {}) };
    const readOk = task.id !== 'T2' || sourceRead?.status === 'verified';
    row.quality = check.matches === true && result.trace.status === 'verified' && readOk ? 'pass'
      : check.matches === false || (sourceRead && sourceRead.status === 'violation') || result.trace.violations.length ? 'fail' : 'unverified';
  } catch (error) {
    row.errors.push(error instanceof Error ? error.message : String(error));
  }
  if (row.firstDispatchAtMs !== null) row.observedIdleMs = row.firstDispatchAtMs - ctx.completedAt;
  if (row.firstDispatchAtMs !== null && row.firstUsefulAtMs !== null) row.firstUsefulResponseMs = row.firstUsefulAtMs - row.firstDispatchAtMs;
  deps.log(`${armId} ${row.quality} idle=${row.observedIdleMs}ms useful=${row.firstUsefulResponseMs}ms errors=${row.errors.length}`);
  return row;
}

/** Canonical usage row subset read back from agent_usage_samples. */
export interface CohortUsageRow {
  id: string; session_id: string; usage_event_key: string | null; model: string | null; ts: string;
  input_tokens: number; cache_read_tokens: number; cache_creation_tokens: number; output_tokens: number;
  usage_provenance: Record<string, unknown> | null;
}

/** Read every canonical request for the selected native sessions. Both
 * event_ts and ts are bigint Unix milliseconds; keep the same statement for
 * the empty-session pre-charge preflight so a SQL/type drift fails before any
 * preparation request can be sent. Unknown token categories fail closed. */
export async function readCarryCohortUsage(sql: Sql, input: { workspaceId: string; sessionIds: readonly string[] }):
  Promise<CohortUsageRow[]> {
  if (!input.workspaceId.trim() || input.sessionIds.some(id => !id.trim())) {
    throw new Error('cohort usage query requires a workspace and nonblank native session ids');
  }
  const sessions = [...new Set(input.sessionIds)];
  const result = await sql<Array<Record<string, unknown>>>`
    SELECT id::text, session_id, usage_event_key, model,
           COALESCE(event_ts, ts)::text AS event_time,
           input_tokens, cache_read_tokens, cache_creation_tokens, output_tokens, usage_provenance
      FROM harness_shared.agent_usage_samples
     WHERE workspace_id = ${input.workspaceId}
       AND session_id = ANY(${sql.array(sessions)}::text[])
     ORDER BY COALESCE(event_ts, ts), id`;
  return result.map(row => {
    for (const key of ['input_tokens', 'cache_read_tokens', 'cache_creation_tokens', 'output_tokens']) {
      if (row[key] === null || row[key] === undefined || !Number.isSafeInteger(Number(row[key])) || Number(row[key]) < 0) {
        throw new Error(`canonical usage row ${row.id} has unavailable ${key}`);
      }
    }
    const eventTime = Number(row.event_time);
    if (!Number.isSafeInteger(eventTime) || eventTime < 0) {
      throw new Error(`canonical usage row ${row.id} has unavailable bigint epoch-ms event time`);
    }
    return {
      id: String(row.id), session_id: String(row.session_id),
      usage_event_key: row.usage_event_key === null ? null : String(row.usage_event_key),
      model: row.model === null ? null : String(row.model), ts: String(row.event_time),
      input_tokens: Number(row.input_tokens), cache_read_tokens: Number(row.cache_read_tokens),
      cache_creation_tokens: Number(row.cache_creation_tokens), output_tokens: Number(row.output_tokens),
      usage_provenance: row.usage_provenance as Record<string, unknown> | null,
    };
  });
}

export async function preflightCarryCohortUsageQuery(sql: Sql, workspaceId: string) {
  await readCarryCohortUsage(sql, { workspaceId, sessionIds: [] });
}

function requestOrder(row: CohortUsageRow) {
  const ordinal = Number(record(row.usage_provenance).requestOrdinal);
  return [row.ts, Number.isFinite(ordinal) ? ordinal : 0, row.id] as const;
}

/** Map canonical rows to D-017 evaluation rows. Every request of an arm thread
 * belongs to that arm; the first two are its startup (D-056 #4, D-060: an arm
 * with one request has a one-request first-two). Preparation rows are charged
 * to the recipe's chargeToArmId. Uncached input is the canonical input_tokens
 * column (total minus cache read/write); an unknown value stays null. */
export function buildCarryTaskEvaluations(recipe: Recipe, arms: readonly CohortArmRecord[], sources: readonly CohortSourceRecord[],
  usage: readonly CohortUsageRow[]): CarryTaskEvaluation[] {
  const sorted = [...usage].sort((a, b) => {
    const [x, y] = [requestOrder(a), requestOrder(b)];
    return x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : x[1] - y[1] || (x[2] < y[2] ? -1 : 1);
  });
  const uncached = (row: CohortUsageRow) => Number.isSafeInteger(row.input_tokens) && row.input_tokens >= 0 ? row.input_tokens : null;
  return arms.map(arm => {
    const source = sources.find(s => s.sourceId === arm.sourceId);
    const own = arm.threadId ? sorted.filter(row => row.session_id === arm.threadId) : [];
    const prepTarget = recipe.sources.find(s => s.id === arm.sourceId)?.chargeToArmId;
    const preparation = prepTarget === arm.armId && source?.threadId ? sorted.filter(row => row.session_id === source.threadId) : [];
    const requests = [
      ...preparation.map(row => ({ id: `${row.session_id}:${row.usage_event_key ?? row.id}`, phase: 'preparation' as const, uncachedInputTokens: uncached(row) })),
      ...own.map((row, index) => ({ id: `${row.session_id}:${row.usage_event_key ?? row.id}`,
        phase: index < 2 ? 'startup' as const : 'work' as const, uncachedInputTokens: uncached(row) })),
    ];
    const accountingComplete = arm.threadId !== null && own.length > 0 && own.every(row => uncached(row) !== null) &&
      (prepTarget !== arm.armId || preparation.length > 0);
    return { taskId: arm.pairId, sourceId: arm.sourceId, sourceRef: arm.sourceRef,
      measuredHistoryInputTokens: arm.historyInputTokens, historyEvidenceRef: arm.historyEvidenceRef,
      observedIdleMs: arm.observedIdleMs, idleEvidenceRef: arm.idleEvidenceRef, arm: arm.arm, model: arm.model,
      transport: arm.transport, authorizationScope: arm.authorizationScope, workloadFingerprint: arm.workloadFingerprint,
      completed: arm.completed, quality: arm.quality,
      qualityEvidenceRef: arm.quality === 'unverified' ? null : `p005-arm:${arm.armId}#${createHash('sha256')
        .update(JSON.stringify(arm.qualityEvidence)).digest('hex').slice(0, 16)}`,
      firstUsefulResponseMs: arm.firstUsefulResponseMs, requests, accountingComplete };
  });
}

/** Charged list-cost estimate per canonical row, identical rates for both arms. */
export function priceUsageRow(row: CohortUsageRow) {
  const total = row.input_tokens + row.cache_read_tokens + row.cache_creation_tokens;
  const estimate = costFromTokens(row.model ?? '', { requestInputTokens: total, inputTokens: row.input_tokens,
    cacheReadTokens: row.cache_read_tokens, cacheCreationTokens: row.cache_creation_tokens, outputTokens: row.output_tokens });
  return estimate.priced ? estimate.usd : null;
}

/** D-017 controller-side admission (D-056 #2): spent = canonical charges so far;
 * remaining = every request slot of every not-yet-finished arm and preparation,
 * reserved at its stratum's history ceiling and 2x the observed output maximum. */
export function reserveCohortBudget(input: { recipe: Recipe; spent: readonly CohortUsageRow[]; spentArmOf(row: CohortUsageRow): string;
  remainingArms: readonly { armId: string; sourceId: string; arm: 'control' | 'candidate'; taskId: string }[];
  remainingPreparations: readonly string[]; plannedRequestsPerArm: number; candidateInputTokenLimit: number;
  defaultOutputTokenLimit: number }) {
  const recipe = input.recipe;
  const observedOutput = Math.max(0, ...input.spent.map(row => row.output_tokens));
  const outputLimit = Math.max(input.defaultOutputTokenLimit, observedOutput * 2);
  const spent: CarryBudgetCharge[] = input.spent.map(row => ({ id: `${row.session_id}:${row.usage_event_key ?? row.id}`,
    armId: input.spentArmOf(row), inputTokens: row.input_tokens + row.cache_read_tokens + row.cache_creation_tokens,
    outputTokens: row.output_tokens, estimatedListUsd: priceUsageRow(row) }));
  const ceiling = (sourceId: string) => recipe.sources.find(s => s.id === sourceId)!.history.maxInputTokens;
  const evidence = 'D-056#2 controller projection: stratum history ceiling input, 2x observed output maximum';
  const remaining: CarryBudgetRequest[] = [
    ...input.remainingPreparations.map(sourceId => ({ id: `reserve:${sourceId}:preparation`,
      armId: recipe.sources.find(s => s.id === sourceId)!.chargeToArmId, model: PREPARATION_MODEL,
      inputTokenLimit: ceiling(sourceId), outputTokenLimit: outputLimit, boundsVerified: true, boundsEvidenceRef: evidence })),
    ...input.remainingArms.flatMap(arm => Array.from({ length: input.plannedRequestsPerArm }, (_, i) => ({
      id: `reserve:${arm.armId}:${i}`, armId: arm.armId, model: armModel(arm.taskId),
      inputTokenLimit: arm.arm === 'control' ? ceiling(arm.sourceId) + input.candidateInputTokenLimit : input.candidateInputTokenLimit,
      outputTokenLimit: outputLimit, boundsVerified: true, boundsEvidenceRef: evidence }))),
  ];
  return evaluateCarryBudgetReservation({ accountingComplete: input.spent.every(row => priceUsageRow(row) !== null),
    remainingRequestsComplete: true, spent, remaining,
    limits: { inputTokens: recipe.limits.inputTokens, outputTokens: recipe.limits.outputTokens,
      estimatedListUsd: recipe.limits.estimatedListUsd, chargedRequestsPerArm: recipe.limits.chargedRequestsPerArm } });
}

export type { RecipeSource, RecipePair };
