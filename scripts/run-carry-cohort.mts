/**
 * P-005 paid carry-cohort runner (D-017/D-056/D-060/D-062/D-063).
 *
 * Modes:
 *   P005_COHORT_ATTEMPT=retry-2 npx tsx scripts/run-carry-cohort.mts manifest
 *   P005_COHORT_ATTEMPT=retry-2 npx tsx scripts/run-carry-cohort.mts pilot
 *   P005_COHORT_ATTEMPT=retry-2 npx tsx scripts/run-carry-cohort.mts cohort
 *   P005_COHORT_ATTEMPT=retry-2 npx tsx scripts/run-carry-cohort.mts summarize
 *
 * `pilot` runs the complete S-I0 source, but the registered T1 pair completes
 * and passes a second budget/accounting/quality gate before the other four
 * pairs start. Keeping those pairs in one process is load-bearing: the final
 * evaluator requires one frozen predecessor cut per source and D-017 caps the
 * experiment at exactly 30 pairs / 60 arms.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join, relative } from 'node:path';
import { committedBlobAtHead, submodulePrefixes, type GitRead } from '../packages/operator-core/lib/candidate-contains.ts';
import { getOrgPg } from '@papercusp/db-org';
import { MODEL_PRICES } from '@papercusp/model-pricing';
import { CODEX_GATEWAY_PROVIDER_ID, codexGatewayConfigToml } from '@papercusp/orchestrator/codex-gateway-config';
import { startSuStdioPeer } from '../packages/operator-core/lib/su-session-stdio-peer.ts';
import { processMonotonicClock } from '../packages/operator-core/lib/process-monotonic-clock.ts';
import sourceReadTool from '../packages/operator-core/lib/agent-tools/capability/read.ts';
import { activeWorkspaceId } from '../packages/operator-core/lib/workspace-registry.ts';
import { ingestInteractiveUsage } from '../packages/operator-core/lib/interactive-usage/ingest-claude-transcripts.ts';
import { codexSessionIdForFile, parseCodexChunk } from '../packages/operator-core/lib/interactive-usage/ingest-adapters.ts';
import { createCarryTrialRecipe, evaluateCarryTaskPairs,
  inspectCarryTaskResponse } from '../packages/operator-core/lib/launch-cost/launch-cost-metrics.ts';
import {
  COHORT_FILLER_TOKENS,
  buildCarryTaskEvaluations,
  buildHistoryFiller,
  cohortPriorAttemptIds,
  isCompletedCohortSourceRun,
  preflightCarryCohortUsageQuery,
  readCarryCohortUsage,
  reserveCohortBudget,
  runCarryCohortSource,
  type CohortArmRecord,
  type CohortDeps,
  type CohortSourceRecord,
  type CohortUsageRow,
} from '../packages/operator-core/lib/launch-cost/carry-cohort-driver.ts';

const { mintCarryRespawnArgs } = await import('../apps/operator/scripts/psu-launcher.mjs') as {
  mintCarryRespawnArgs(args: string[], opts: Record<string, unknown>): { carryText: string; launchContextPath: string };
};

const REPO = new URL('../', import.meta.url).pathname.replace(/\/$/, '');
const DIR = join(REPO, '.papercusp/scratch/p005-cohort');
const ATTEMPT = process.env.P005_COHORT_ATTEMPT?.trim() || 'initial';
const priorIds = cohortPriorAttemptIds(ATTEMPT);
const RUN_DIR = ATTEMPT === 'initial' ? DIR : join(DIR, 'attempts', ATTEMPT);
const PRIOR_ATTEMPTS = priorIds.map(attemptId => ({ attemptId,
  dir: attemptId === 'initial' ? DIR : join(DIR, 'attempts', attemptId) }));
const HOMES = join(RUN_DIR, 'homes');
const RECORDS = join(RUN_DIR, 'source-records.jsonl');
const SOURCE_BINDINGS = join(RUN_DIR, 'source-bindings.jsonl');
const PILOTS = join(RUN_DIR, 'pilot-checks.jsonl');
const GATEWAY_ROWS = join(RUN_DIR, 'gateway-observations.jsonl');
const BUDGET_ROWS = join(RUN_DIR, 'budget-admissions.jsonl');
const MANIFEST = join(RUN_DIR, 'manifest.json');
const EVIDENCE = join(REPO, `docs/evidence/cache-efficiency-p005-carry-cohort-${ATTEMPT}.json`);
const OWNER = process.env.PAPERCUSP_SID?.trim() ?? '';
const WORKSPACE = activeWorkspaceId();
const recipe = createCarryTrialRecipe();
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

if (!OWNER) throw new Error('PAPERCUSP_SID is required');
mkdirSync(HOMES, { recursive: true, mode: 0o700 });

type GatewayObservation = {
  requestId: number | string | null;
  ownerId: string | null;
  provider: string | null;
  model: string | null;
  servingAccountId: string | null;
  threadId: string | null;
  turnId: string | null;
  attempts: number | null;
  finalStatus: number | null;
  outcome: string | null;
  inputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  startedAt: number | null;
  finalizedAt: number | null;
};

type StoredSource = {
  capturedAt: string;
  rootManifestSha256: string;
  sourceBindingSha256: string;
  result: Awaited<ReturnType<typeof runCarryCohortSource>>;
  gateway: GatewayObservation[];
};

type RuntimeSourceBinding = {
  schema: 'p005-runtime-source-binding-v1';
  rootManifestSha256: string;
  sourceId: string;
  capturedAt: string;
  pass: boolean;
  reasons: string[];
  requestedAuthorizationScope: string;
  observedServingAccountId: string | null;
  threadId: string | null;
  turnId: string | null;
  sourceRef: string | null;
  sourceSnapshotSha256: string | null;
  carrySha256: string | null;
  filler: CohortSourceRecord['filler'];
  history: unknown;
  idle: unknown;
  preparation: CohortSourceRecord['preparation'];
  usageRows: CohortUsageRow[];
  bindingSha256: string;
};

const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);
const append = (path: string, value: unknown) => appendFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
function rows<T>(path: string): T[] {
  return !existsSync(path) ? [] : readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as T);
}
const latestSources = () => {
  const out = new Map<string, StoredSource>();
  for (const row of rows<StoredSource>(RECORDS)) {
    if (row.sourceBindingSha256 && isCompletedCohortSourceRun(recipe, row.result)) out.set(row.result.source.sourceId, row);
  }
  return out;
};
const priorRecords = () => PRIOR_ATTEMPTS.flatMap(attempt => rows<StoredSource>(join(attempt.dir, 'source-records.jsonl')));
const allStoredRecords = () => [...priorRecords(), ...rows<StoredSource>(RECORDS)];

function priorAttemptRefs() {
  return PRIOR_ATTEMPTS.map(attempt => {
    const manifestPath = join(attempt.dir, 'manifest.json');
    const recordsPath = join(attempt.dir, 'source-records.jsonl');
    if (!existsSync(manifestPath) || !existsSync(recordsPath)) throw new Error(`prior attempt ${attempt.attemptId} is incomplete`);
    const manifestText = readFileSync(manifestPath, 'utf8');
    const recordsText = readFileSync(recordsPath, 'utf8');
    const prior = JSON.parse(manifestText) as { manifestSha256?: unknown; gitHeadAtFreeze?: unknown };
    const parsedRecords = rows<StoredSource>(recordsPath);
    return { attemptId: attempt.attemptId, manifestSha256: String(prior.manifestSha256 ?? ''),
      manifestFileSha256: sha256(manifestText), recordsSha256: sha256(recordsText), recordCount: parsedRecords.length,
      gitHeadAtFreeze: String(prior.gitHeadAtFreeze ?? ''),
      chargedSessionIds: parsedRecords.flatMap(row => row.result.source.threadId ? [row.result.source.threadId] : []) };
  });
}

const git = (...args: string[]) => execFileSync('git', args, { cwd: REPO, encoding: 'utf8' }).trim();
const gitRead: GitRead = async args => {
  try { return git(...args); } catch { return null; }
};
const instrumentPaths = [
  'scripts/run-carry-cohort.mts',
  'packages/operator-core/lib/launch-cost/carry-cohort-driver.ts',
  'packages/operator-core/lib/launch-cost/carry-cohort-ledger.integration.test.ts',
  'packages/operator-core/lib/launch-cost/carry-cohort-driver.integration.test.ts',
  'packages/operator-core/lib/launch-cost/launch-cost-metrics.ts',
  'packages/operator-core/lib/launch-cost/scan-launch-transcripts.ts',
  'packages/operator-core/lib/interactive-usage/ingest-claude-transcripts.ts',
  'libs/generic/model-pricing/src/index.ts',
  'apps/operator/scripts/psu-launcher.mjs',
];

const gatewayConfig = codexGatewayConfigToml(null, { gatewayOn: true, ownerId: OWNER, priority: 'interactive' });
const providerTable = gatewayConfig.tables.flatMap(line => line === '# END PAPERCUSP_CODEX_GATEWAY_PROVIDER'
  ? ['request_max_retries = 0', 'stream_max_retries = 0', line] : [line]);
const provider = {
  providerId: CODEX_GATEWAY_PROVIDER_ID,
  rootLines: gatewayConfig.root,
  tableLines: providerTable,
};

async function freezeManifest() {
  // A frozen root binds committed instruments. A local dirty edit would make
  // git hash-object and gitHeadAtFreeze disagree before the first charged turn.
  const submodules = await submodulePrefixes(gitRead);
  for (const path of instrumentPaths) {
    const working = git('hash-object', path);
    const committed = await committedBlobAtHead(gitRead, path, submodules);
    if (!committed) throw new Error(`cohort instrument ${path} is not committed at HEAD`);
    if (working !== committed) throw new Error(`cohort instrument ${path} differs from committed HEAD`);
  }
  const prior = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, 'utf8')) as {
    stable: unknown; createdAt: string; manifestSha256: string; gitHeadAtFreeze: string } : null;
  const createdAt = prior?.createdAt ?? new Date().toISOString();
  const startMs = Date.parse(createdAt);
  if (!Number.isFinite(startMs)) throw new Error('manifest createdAt is invalid');
  const accountingWindow = { startInclusive: createdAt, endExclusive: new Date(startMs + 12 * 60 * 60_000).toISOString() };
  const priceEntries = Object.fromEntries(['gpt-6-luna', 'gpt-6-sol'].map(model => [model, MODEL_PRICES[model]]));
  const sourceInputs = recipe.sources.map(source => {
    const filler = buildHistoryFiller(COHORT_FILLER_TOKENS[source.id.startsWith('L-') ? 'L' : 'S'], source.id);
    const input = `${filler.text}\n\n${recipe.sourcePreparation.prompt}`;
    return { sourceId: source.id, fillerSha256: filler.sha256, estimatedTokens: filler.estimatedTokens,
      preparationInputSha256: sha256(input), preparationPromptSha256: recipe.sourcePreparation.promptSha256 };
  });
  const taskCheckers = recipe.tasks.map(task => {
    const checked = inspectCarryTaskResponse({ taskId: task.id, response: JSON.stringify(task.expected),
      ...(task.id === 'T2' ? { boundSourceRef: String(task.expected.sourceRef) } : {}) });
    return { taskId: task.id, promptSha256: sha256(task.prompt), expectedSha256: sha256(JSON.stringify(task.expected)),
      checkerOracleSha256: checked.oracleSha256 };
  });
  const runtimeBindingSchema = { schema: 'p005-runtime-source-binding-v1', uniqueBy: 'sourceId',
    hashChain: 'rootManifestSha256+bindingSha256', required: ['rootManifestSha256', 'sourceId', 'capturedAt', 'pass',
      'requestedAuthorizationScope', 'observedServingAccountId', 'threadId', 'turnId', 'sourceRef',
      'sourceSnapshotSha256', 'carrySha256', 'filler', 'history', 'idle', 'preparation', 'usageRows'] };
  const stable = {
    schema: 'p005-carry-cohort-manifest-v2',
    attemptId: ATTEMPT,
    priorAttempts: priorAttemptRefs(),
    plan: 'cache-efficiency-and-accounting-2026-09-23',
    decisions: ['D-017', 'D-056', 'D-060', 'D-062', 'D-063', 'D-065', 'D-068', 'D-069'],
    recipeSha256: recipe.sha256,
    recipeLimits: recipe.limits,
    preparationModel: 'gpt-6-sol',
    taskModels: Object.fromEntries(recipe.tasks.map(task => [task.id, task.id === 'T5' ? 'gpt-6-luna' : 'gpt-6-sol'])),
    effort: 'medium',
    transport: 'codex-oauth-responses-via-gateway-8788',
    requestedAuthorizationScope: `gateway-owner:${OWNER}`,
    providerConfigSha256: sha256([...provider.rootLines, ...provider.tableLines].join('\n')),
    accountingWindow,
    priceTable: { source: '@papercusp/model-pricing', sourceBlobSha256: git('hash-object',
      'libs/generic/model-pricing/src/index.ts'), entries: priceEntries, entriesSha256: sha256(JSON.stringify(priceEntries)) },
    sourceInputs,
    originalFixtureReference: recipe.fixtureReference,
    taskCheckers,
    armOrder: recipe.pairs.map(pair => ({ pairId: pair.id, sourceId: pair.sourceId, taskId: pair.taskId,
      arms: pair.arms.map(arm => ({ armId: arm.id, arm: arm.arm, model: taskModelsModel(pair.taskId), effort: arm.effort })) })),
    runtimeBinding: { path: relative(REPO, SOURCE_BINDINGS),
      schema: runtimeBindingSchema, schemaSha256: sha256(JSON.stringify(runtimeBindingSchema)) },
    instrumentBlobs: Object.fromEntries(instrumentPaths.map(path => [path, git('hash-object', path)])),
  };
  const manifestSha256 = sha256(JSON.stringify(stable));
  if (prior) {
    if (JSON.stringify(prior.stable) !== JSON.stringify(stable)) throw new Error('frozen manifest differs from current instruments/config');
    if (prior.manifestSha256 !== manifestSha256) throw new Error('frozen manifest hash does not match its stable body');
    return prior as { stable: typeof stable; createdAt: string; manifestSha256: string; gitHeadAtFreeze: string };
  }
  const manifest = { stable, createdAt, manifestSha256, gitHeadAtFreeze: git('rev-parse', 'HEAD') };
  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  return manifest;
}

const manifest = await freezeManifest();
const activePreparations = new Map<string, { threadId: string; home: string }>();
const observations = new Map<string, GatewayObservation[]>();
const sourceBindingHashes = new Map(rows<RuntimeSourceBinding>(SOURCE_BINDINGS)
  .map(binding => [binding.sourceId, binding.bindingSha256] as const));
let abortReason: string | null = null;

function taskModelsModel(taskId: string) { return taskId === 'T5' ? 'gpt-6-luna' : 'gpt-6-sol'; }

function assertAccountingWindow() {
  const now = Date.now();
  const start = Date.parse(manifest.stable.accountingWindow.startInclusive);
  const end = Date.parse(manifest.stable.accountingWindow.endExclusive);
  if (!Number.isFinite(start) || !Number.isFinite(end) || now < start || now >= end) {
    throw new Error(`outside frozen accounting window ${manifest.stable.accountingWindow.startInclusive}..${manifest.stable.accountingWindow.endExclusive}`);
  }
}

async function gatewayStats() {
  const res = await fetch('http://127.0.0.1:8788/stats', { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`gateway stats ${res.status}`);
  return await res.json() as Record<string, any>;
}

function compactObservation(value: Record<string, any>): GatewayObservation {
  const cache = value.cache ?? {}, native = value.nativeCorrelation ?? {};
  return {
    requestId: value.requestId ?? null,
    ownerId: value.ownerId ?? null,
    provider: value.provider ?? null,
    model: value.model ?? null,
    servingAccountId: cache.servingAccountId ?? null,
    threadId: native.threadId ?? null,
    turnId: native.turnId ?? null,
    attempts: Number.isFinite(value.attempts) ? value.attempts : null,
    finalStatus: Number.isFinite(value.finalStatus) ? value.finalStatus : null,
    outcome: value.outcome ?? null,
    inputTokens: Number.isFinite(cache.inputTokens) ? cache.inputTokens : null,
    cacheReadTokens: Number.isFinite(cache.cacheReadTokens) ? cache.cacheReadTokens : null,
    cacheWriteTokens: Number.isFinite(cache.cacheWriteTokens) ? cache.cacheWriteTokens : null,
    startedAt: Number.isFinite(value.startedAt) ? value.startedAt : null,
    finalizedAt: Number.isFinite(value.finalizedAt) ? value.finalizedAt : null,
  };
}

async function captureGateway(sourceId: string, identities: Array<{ threadId: string; turnId: string }>) {
  const wanted = new Set(identities.map(id => `${id.threadId}\u0000${id.turnId}`));
  let found: GatewayObservation[] = [];
  for (let attempt = 0; attempt < 20; attempt++) {
    const stats = await gatewayStats();
    const recent = Array.isArray(stats.requestStages?.recent) ? stats.requestStages.recent as Record<string, any>[] : [];
    found = recent.filter(row => wanted.has(`${row.nativeCorrelation?.threadId ?? ''}\u0000${row.nativeCorrelation?.turnId ?? ''}`))
      .map(compactObservation);
    if (new Set(found.map(row => `${row.threadId}\u0000${row.turnId}`)).size === wanted.size) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  const seen = new Set((observations.get(sourceId) ?? []).map(row => String(row.requestId)));
  const fresh = found.filter(row => !seen.has(String(row.requestId)));
  observations.set(sourceId, [...(observations.get(sourceId) ?? []), ...fresh]);
  for (const row of fresh) append(GATEWAY_ROWS, { capturedAt: new Date().toISOString(), sourceId, ...row });
  const got = new Set(found.map(row => `${row.threadId}\u0000${row.turnId}`));
  const missing = [...wanted].filter(id => !got.has(id));
  if (missing.length) throw new Error(`gateway observations missing ${missing.length}/${wanted.size} native turn(s) for ${sourceId}`);
  return found;
}

async function ingestHome(home: string) {
  const result = await ingestInteractiveUsage({
    adapters: [{ name: `p005-${sha256(home).slice(0, 8)}`, root: join(home, 'sessions'), parse: parseCodexChunk,
      replayStateFromPrefix: true, sessionIdForFile: codexSessionIdForFile }],
    includeIsolationRoots: false,
    maxFilesPerTick: 200,
  });
  if (result.errors.length) throw new Error(`usage ingestion errors: ${JSON.stringify(result.errors.slice(0, 3))}`);
  return result;
}

function sessionBindings() {
  const bindings = new Map<string, string>();
  for (const stored of allStoredRecords()) {
    const charge = recipe.sources.find(source => source.id === stored.result.source.sourceId)?.chargeToArmId;
    if (stored.result.source.threadId && charge) bindings.set(stored.result.source.threadId, charge);
    for (const arm of stored.result.arms) if (arm.threadId) bindings.set(arm.threadId, arm.armId);
  }
  for (const [sourceId, prep] of activePreparations) {
    const charge = recipe.sources.find(source => source.id === sourceId)?.chargeToArmId;
    if (charge) bindings.set(prep.threadId, charge);
  }
  return bindings;
}

async function readUsage(): Promise<CohortUsageRow[]> {
  const bindings = sessionBindings();
  if (!bindings.size) return [];
  const { sql } = getOrgPg();
  return await readCarryCohortUsage(sql, { workspaceId: WORKSPACE, sessionIds: [...bindings.keys()] });
}

async function validateLedgerReadQuery() {
  const { sql } = getOrgPg();
  await preflightCarryCohortUsageQuery(sql, WORKSPACE);
  log('canonical usage query preflight passed (event_ts/ts epoch-ms)');
}

function remainingPlan() {
  const complete = new Set([...latestSources().values()].flatMap(row => row.result.arms.map(arm => arm.armId)));
  return recipe.pairs.flatMap(pair => pair.arms.map(arm => ({ armId: arm.id, sourceId: pair.sourceId,
    arm: arm.arm as 'control' | 'candidate', taskId: pair.taskId }))).filter(arm => !complete.has(arm.armId));
}

async function admit(sourceId: string, armIds: string[]) {
  if (abortReason) return { ok: false, reason: abortReason };
  try { assertAccountingWindow(); } catch (error) { return { ok: false, reason: error instanceof Error ? error.message : String(error) }; }
  const stats = await gatewayStats();
  if (!(Number(stats.codexHealthyAccounts) > 0)) return { ok: false, reason: `codexHealthyAccounts=${stats.codexHealthyAccounts}` };
  for (const prep of activePreparations.values()) await ingestHome(prep.home);
  const usage = await readUsage();
  const bindings = sessionBindings();
  const remainingArms = remainingPlan();
  const remainingPreparations = recipe.sources.map(source => source.id).filter(id =>
    !latestSources().has(id) && !activePreparations.has(id));
  const reservation = reserveCohortBudget({ recipe, spent: usage,
    spentArmOf: row => bindings.get(row.session_id) ?? `UNBOUND:${row.session_id}`,
    remainingArms, remainingPreparations, plannedRequestsPerArm: 2,
    candidateInputTokenLimit: 40_000, defaultOutputTokenLimit: 4_000 });
  append(BUDGET_ROWS, { at: new Date().toISOString(), sourceId, armIds, codexHealthyAccounts: stats.codexHealthyAccounts,
    spentRows: usage.length, remainingArms: remainingArms.length, remainingPreparations, reservation });
  log(`${sourceId} admission fits=${reservation.fitsBudget} spentRows=${usage.length} remainingArms=${remainingArms.length}`);
  return { ok: reservation.fitsBudget, reason: reservation.fitsBudget ? undefined
    : `budget:${[...reservation.missing, ...reservation.exceeded].join(',')}` };
}

function bindAuthorizationScopes(source: CohortSourceRecord, arms: CohortArmRecord[], sourceId: string) {
  const seen = observations.get(sourceId) ?? [];
  const prepAccounts = new Set(seen.filter(row => row.threadId === source.threadId).map(row => row.servingAccountId).filter(Boolean));
  for (const arm of arms) {
    const accounts = new Set(seen.filter(row => row.threadId === arm.threadId).map(row => row.servingAccountId).filter(Boolean));
    if (arm.armId === recipe.sources.find(item => item.id === sourceId)?.chargeToArmId) {
      for (const account of prepAccounts) accounts.add(account);
    }
    if (accounts.size === 1) arm.authorizationScope = `gateway-account:${[...accounts][0]}`;
    else {
      arm.authorizationScope = `gateway-account:UNMATCHED:${arm.armId}`;
      arm.errors.push(accounts.size ? `mixed-serving-accounts:${[...accounts].join(',')}` : 'missing-serving-account');
    }
  }
}

async function runSource(sourceId: string, pilot: boolean) {
  const prior = latestSources().get(sourceId);
  if (prior) { log(`${sourceId} already recorded — skip`); return prior; }
  const failedHere = rows<StoredSource>(RECORDS).filter(row => row.result.source.sourceId === sourceId);
  if (failedHere.length) throw new Error(`${sourceId} has ${failedHere.length} failed attempt(s) under immutable root ${manifest.manifestSha256}; start a new attempt root`);
  assertAccountingWindow();
  const preparationAdmission = await admit(sourceId, [`${sourceId}:preparation`]);
  if (!preparationAdmission.ok) throw new Error(`preparation-admission-refused:${preparationAdmission.reason ?? 'unknown'}`);
  const home = join(HOMES, sourceId);
  const deps: CohortDeps = {
    openPeer: ({ home: peerHome, onMessage, onReceipt }) => startSuStdioPeer({
      binary: 'codex', args: ['app-server'], cwd: peerHome,
      env: { ...process.env, CODEX_HOME: peerHome, PI_CODING_AGENT_DIR: peerHome },
      workspaceId: WORKSPACE, ownerId: OWNER,
      spec: { class: 'test', title: `P-005 paid cohort ${sourceId}`, launchedBy: OWNER, argv: ['codex', 'app-server'] },
      onMessage, onReceipt,
    }),
    mintCarry: ({ home: carryHome, sourceThreadId, seedText }) => mintCarryRespawnArgs([], {
      agent: 'codex', home: carryHome, codexHome: carryHome, ownerId: OWNER, sourceSession: sourceThreadId,
      systemPromptAddendum: seedText,
    }),
    readTool: async (args, root) => await sourceReadTool.handler(args as never, { projectDir: root } as never) as never,
    now: () => processMonotonicClock.now(),
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    log,
    admit: ({ sourceId: admittedSourceId, armIds }) => admit(admittedSourceId, armIds),
    afterPreparation: async ({ threadId, turnId }) => {
      activePreparations.set(sourceId, { threadId, home });
      await ingestHome(home);
      await captureGateway(sourceId, [{ threadId, turnId }]);
    },
    afterSourceBound: async ({ source }) => {
      if (rows<RuntimeSourceBinding>(SOURCE_BINDINGS).some(binding => binding.sourceId === sourceId)) {
        return { ok: false, reason: `source binding already exists for ${sourceId}` };
      }
      await ingestHome(home);
      const seen = observations.get(sourceId) ?? [];
      const accounts = new Set(seen.filter(row => row.threadId === source.threadId)
        .map(row => row.servingAccountId).filter((value): value is string => Boolean(value)));
      const usage = await readUsage();
      const usageRows = usage.filter(row => row.session_id === source.threadId);
      const sourceHash = /@([a-f0-9]{64})$/.exec(source.sourceRef ?? '')?.[1] ?? null;
      const history = source.history as { inBand?: unknown } | null;
      const reasons = [
        ...source.errors.map(error => `source:${error}`),
        ...(!source.threadId || !source.turnId ? ['missing-native-source-identity'] : []),
        ...(!sourceHash ? ['missing-source-snapshot-hash'] : []),
        ...(!source.carry || !/^[a-f0-9]{64}$/.test(source.carry.carrySha256) ? ['missing-carry-hash'] : []),
        ...(source.preparation?.matches === true && source.preparation.trace === 'verified' ? [] : ['preparation-not-verified']),
        ...(history?.inBand === true ? [] : ['history-out-of-band-or-unknown']),
        ...(usageRows.length ? [] : ['missing-canonical-preparation-usage']),
        ...(accounts.size === 1 ? [] : [`observed-serving-account-count:${accounts.size}`]),
      ];
      const body = { schema: 'p005-runtime-source-binding-v1' as const,
        rootManifestSha256: manifest.manifestSha256, sourceId, capturedAt: new Date().toISOString(),
        pass: reasons.length === 0, reasons, requestedAuthorizationScope: `gateway-owner:${OWNER}`,
        observedServingAccountId: accounts.size === 1 ? [...accounts][0] : null,
        threadId: source.threadId, turnId: source.turnId, sourceRef: source.sourceRef,
        sourceSnapshotSha256: sourceHash, carrySha256: source.carry?.carrySha256 ?? null,
        filler: source.filler, history: source.history, idle: source.idle, preparation: source.preparation, usageRows };
      const binding: RuntimeSourceBinding = { ...body, bindingSha256: sha256(JSON.stringify(body)) };
      append(SOURCE_BINDINGS, binding);
      if (binding.pass) sourceBindingHashes.set(sourceId, binding.bindingSha256);
      log(`${sourceId} source binding pass=${binding.pass} reasons=${binding.reasons.length}`);
      return { ok: binding.pass, reason: binding.reasons.join(';') || undefined };
    },
    afterPilot: async ({ arms }) => {
      const ids = arms.flatMap(arm => arm.threadId ? arm.turnIds.map(turnId => ({ threadId: arm.threadId!, turnId })) : []);
      await captureGateway(sourceId, ids);
      await ingestHome(home);
      const prep = activePreparations.get(sourceId);
      const sourceStub = { sourceId, threadId: prep?.threadId ?? null } as CohortSourceRecord;
      bindAuthorizationScopes(sourceStub, arms as CohortArmRecord[], sourceId);
      const usage = await readUsage();
      const sessions = new Set([prep?.threadId, ...arms.map(arm => arm.threadId)].filter(Boolean));
      const reasons = [
        ...arms.flatMap(arm => arm.quality === 'pass' && arm.completed && arm.errors.length === 0 ? [] : [`arm:${arm.armId}:${arm.quality}:${arm.errors.join('|')}`]),
        ...[...sessions].flatMap(session => usage.some(row => row.session_id === session) ? [] : [`missing-usage:${session}`]),
      ];
      const pairScopes = new Set(arms.map(arm => arm.authorizationScope));
      if (pairScopes.size !== 1) reasons.push(`unmatched-serving-account:${[...pairScopes].join(',')}`);
      const secondAdmission = await admit(sourceId, remainingPlan().filter(arm => arm.sourceId === sourceId && !arms.some(done => done.armId === arm.armId))
        .map(arm => arm.armId));
      if (!secondAdmission.ok) reasons.push(`post-pilot-admission:${secondAdmission.reason}`);
      const check = { at: new Date().toISOString(), sourceId, taskId: 'T1', manifestSha256: manifest.manifestSha256,
        sourceBindingSha256: sourceBindingHashes.get(sourceId) ?? null,
        pass: reasons.length === 0, reasons, arms, usageRows: usage.filter(row => sessions.has(row.session_id)) };
      append(PILOTS, check);
      log(`${sourceId} pilot pass=${check.pass} reasons=${reasons.length}`);
      return { ok: check.pass, reason: reasons.join(';') || undefined };
    },
  };
  const result = await runCarryCohortSource(deps, {
    recipe, sourceId, homeDir: home, provider,
    transport: 'codex-oauth-responses-via-gateway-8788',
    authorizationScope: `gateway-owner:${OWNER}`,
    fillerTokens: COHORT_FILLER_TOKENS[sourceId.startsWith('L-') ? 'L' : 'S'],
    windowMarginMs: 1_000,
    staggerMs: 250,
    turnTimeoutMs: 600_000,
    modelContextWindow: 872_000,
    autoCompactTokenLimit: 850_000,
    sourceBindingRequired: true,
    ...(pilot ? { pilotTaskId: 'T1' } : {}),
  });
  const sourceBindingSha256 = sourceBindingHashes.get(sourceId) ?? '';
  for (const arm of result.arms) Object.assign(arm, { rootManifestSha256: manifest.manifestSha256, sourceBindingSha256 });
  const armIds = result.arms.flatMap(arm => arm.threadId ? arm.turnIds.map(turnId => ({ threadId: arm.threadId!, turnId })) : []);
  if (armIds.length) await captureGateway(sourceId, armIds);
  bindAuthorizationScopes(result.source, result.arms, sourceId);
  await ingestHome(home);
  activePreparations.delete(sourceId);
  const stored: StoredSource = { capturedAt: new Date().toISOString(), rootManifestSha256: manifest.manifestSha256,
    sourceBindingSha256, result, gateway: observations.get(sourceId) ?? [] };
  append(RECORDS, stored);
  const bad = result.stop ?? result.source.errors[0] ?? result.arms.find(arm => arm.quality !== 'pass' || !arm.completed || arm.errors.length)?.armId;
  if (bad) abortReason ??= `source-stop:${sourceId}:${bad}`;
  log(`${sourceId} complete arms=${result.arms.length} stop=${result.stop ?? 'none'} abort=${abortReason ?? 'none'}`);
  return stored;
}

async function summarize() {
  const current = latestSources();
  const missing = recipe.sources.map(source => source.id).filter(id => !current.has(id));
  if (missing.length) throw new Error(`cannot summarize; missing sources: ${missing.join(',')}`);
  for (const stored of current.values()) await ingestHome(stored.result.source.homeDir);
  const usage = await readUsage();
  const sources = [...current.values()].map(row => row.result.source);
  const arms = [...current.values()].flatMap(row => row.result.arms);
  const evaluations = buildCarryTaskEvaluations(recipe, arms, sources, usage);
  const verdict = evaluateCarryTaskPairs(evaluations);
  const out = { schema: 'p005-carry-cohort-evidence-v1', generatedAt: new Date().toISOString(), manifest,
    sourceBindings: rows<RuntimeSourceBinding>(SOURCE_BINDINGS), records: allStoredRecords(),
    usage, evaluations, verdict, abortReason };
  writeFileSync(EVIDENCE, `${JSON.stringify(out, null, 2)}\n`, { mode: 0o600 });
  log(`summary written ${EVIDENCE}: ${JSON.stringify({ status: verdict.status, pairs: verdict.pairs,
    failures: verdict.failures, insufficient: verdict.insufficient, metrics: verdict.metrics })}`);
}

await validateLedgerReadQuery();
const mode = process.argv[2];
if (mode === 'manifest') {
  log(`manifest verified ${manifest.manifestSha256} head=${manifest.gitHeadAtFreeze}`);
} else if (mode === 'pilot') {
  await runSource('S-I0', true);
  if (abortReason) throw new Error(abortReason);
} else if (mode === 'cohort') {
  if (!latestSources().has('S-I0')) await runSource('S-I0', true);
  if (!abortReason) {
    const pending = recipe.sources.map(source => source.id).filter(id => id !== 'S-I0' && !latestSources().has(id));
    await Promise.all(pending.map(sourceId => runSource(sourceId, false)));
  }
  if (abortReason) throw new Error(abortReason);
} else if (mode === 'summarize') {
  await summarize();
} else {
  console.error('usage: manifest | pilot | cohort | summarize');
  process.exit(2);
}
