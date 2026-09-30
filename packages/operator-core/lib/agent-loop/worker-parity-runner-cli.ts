#!/usr/bin/env node
/**
 * Dedicated-process CLI for the D-027 worker parity cohort.
 *
 * Dry route proof (no generation):
 *   npm --workspace @papercusp/operator-core run worker-parity
 * Exact D-015 floor:
 *   npm --workspace @papercusp/operator-core run worker-parity -- --execute --pairs=20
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { InvokeContext } from '@papercusp/orchestrator';
import {
  resolveWorkerParityRoute,
  runWorkerParityCohort,
  workerParityArmConfig,
  workerParityArmEnv,
  type WorkerParityArm,
  type WorkerParityArmInput,
  type WorkerParityArmResult,
  type WorkerParityRoutePlan,
} from './worker-parity-runner';
import {
  admissionContextFromEnvironment,
  beginGovernedExecution,
  governedExecutionRuntime,
} from '../resource-governor/execution';

// This one-shot driver never embeds text, but account-pool resolution imports
// the shared sync graph. Point that graph at the maintained sidecar before any
// heavyweight dynamic import so the native embedding addon is never loaded only
// to crash during one-shot process teardown (EI-19464316359123796).
process.env.PAPERCUSP_EMBED_SIDECAR_URL ??=
  `http://127.0.0.1:${process.env.PAPERCUSP_EMBED_SIDECAR_PORT || '3384'}`;

const RESULT_PREFIX = 'PAPERCUSP_PARITY_RESULT=';
const ROUTE_PROOF_ENV = 'PAPERCUSP_PARITY_ROUTE_PROVED';
const PROMPT_ENV = 'PAPERCUSP_PARITY_PROMPT_B64';
const RUN_ID_ENV = 'PAPERCUSP_PARITY_RUN_ID';
const ARM_ENV = 'PAPERCUSP_PARITY_ARM';
const MODEL_ENV = 'PAPERCUSP_PARITY_MODEL';
const CHUNK_ENV = 'PAPERCUSP_PARITY_CHUNK_ID';

interface CliArgs {
  execute: boolean;
  pairs: number;
  model: string;
  cohortId: string;
  workspaceId: string;
  harnessSlug: string;
  arm: WorkerParityArm | null;
}

function valueArg(argv: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
}

function parseArgs(argv: string[]): CliArgs {
  const pairs = Number(valueArg(argv, 'pairs') ?? 20);
  const armRaw = valueArg(argv, 'arm');
  if (armRaw !== undefined && armRaw !== 'omp' && armRaw !== 'loop') {
    throw new Error(`--arm must be omp|loop, got ${JSON.stringify(armRaw)}`);
  }
  const workspaceId = valueArg(argv, 'workspace') ?? process.env.PAPERCUSP_WORKSPACE ?? '';
  return {
    execute: argv.includes('--execute'),
    pairs,
    model: valueArg(argv, 'model') ?? 'claude-haiku-4-5',
    cohortId: valueArg(argv, 'cohort') ?? new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z'),
    workspaceId,
    harnessSlug: valueArg(argv, 'harness') ?? 'papercusp',
    arm: armRaw ?? null,
  };
}

function routeSummary(route: WorkerParityRoutePlan): Record<string, unknown> {
  return {
    schemaVersion: route.schemaVersion,
    model: route.model,
    loopProvider: route.loopProvider,
    account: route.account,
    proof: route.proof,
    generationIssued: false,
  };
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`internal parity arm is missing ${name}`);
  return value;
}

function assertArmRoute(arm: WorkerParityArm, model: string): void {
  if (process.env[ROUTE_PROOF_ENV] !== '1') {
    throw new Error('parity arm refused: non-generation gateway route proof was not carried into the child');
  }
  if (arm === 'omp') {
    if (process.env.PAPERCUSP_OMP_MODEL_SELECTOR !== `papercusp-gateway/${model}`) {
      throw new Error('parity OMP arm refused: managed gateway selector is absent or mismatched');
    }
    if (!process.env.PAPERCUSP_OMP_MODELS_YML?.includes('# BEGIN PAPERCUSP_OMP_GATEWAY')) {
      throw new Error('parity OMP arm refused: managed gateway models.yml is absent');
    }
    return;
  }
  if (/^claude-/i.test(model)) {
    const base = new URL(requiredEnv('ANTHROPIC_BASE_URL'));
    if (!['127.0.0.1', 'localhost', '::1'].includes(base.hostname)) {
      throw new Error(`parity loop arm refused direct Anthropic base URL ${base.toString()}`);
    }
    if (process.env.PAPERCUSP_ACCOUNT_ROUTING_MODE !== 'auto') {
      throw new Error('parity loop arm refused: account routing is not auto');
    }
  } else if (process.env.PAPERCUSP_CODEX_GATEWAY !== '1') {
    throw new Error('parity loop arm refused: Codex gateway marker is absent');
  }
}

async function runIsolatedArm(args: CliArgs): Promise<void> {
  // Install the runtime flag store BEFORE importing the agent-tool graph: that
  // graph has boot checks which call getFlag during module evaluation.
  const flagStore = await import('../flag-override-store');
  flagStore.installFlagOverrideStore();
  const [orchestrator, dbOrg, harnessPaths, headless, pipelineEnv] = await Promise.all([
    import('@papercusp/orchestrator'),
    import('@papercusp/db-org'),
    import('@papercusp/harness/paths'),
    import('./headless-invoke'),
    import('../dbos/orchestrator-spawn-env'),
  ]);
  const arm = args.arm;
  if (!arm) throw new Error('internal arm invocation did not name an arm');
  const model = requiredEnv(MODEL_ENV);
  assertArmRoute(arm, model);
  const prompt = Buffer.from(requiredEnv(PROMPT_ENV), 'base64').toString('utf8');
  const runId = requiredEnv(RUN_ID_ENV);
  const projectDir = requiredEnv('PAPERCUSP_PARITY_PROJECT_DIR');
  const stateDir = join(projectDir, '.papercusp');
  const logger = orchestrator.createLogger(stateDir);
  const pgHandle = dbOrg.getOrgPg();
  try {
    const effectiveConfig = JSON.parse(requiredEnv('HARNESS_CONFIG_JSON')) as Record<string, unknown>;
    const ctx: InvokeContext = {
      harnessDir: harnessPaths.harnessRoot(),
      projectDir,
      stateDir,
      logDir: join(stateDir, 'logs'),
      phase: orchestrator.resolvePhase(effectiveConfig as never).phase,
      claudeCmd: 'omp -p',
      agentBackend: 'omp',
      ...(arm === 'loop' ? { ownedLoop: headless.createOperatorOwnedLoopPort() } : {}),
      pg: pgHandle.sql as unknown as NonNullable<InvokeContext['pg']>,
      workspaceId: args.workspaceId,
      extraSpawnEnv: pipelineEnv.buildPipelineExtraEnv({
        harnessSlug: args.harnessSlug,
        workspaceId: args.workspaceId,
        turnTrigger: 'user',
      }),
      log: (message) => logger.log(`[worker-parity:${arm}] ${message}`),
    };
    const startedAt = Date.now();
    const result = await orchestrator.invoke(ctx, 'worker', [`CHUNK_ID=${requiredEnv(CHUNK_ENV)}`], {
      inlinePrompt: prompt,
      idempotencyKey: runId,
      cwd: projectDir,
    });
    const payload: WorkerParityArmResult = {
      arm,
      pairIndex: Number(requiredEnv('PAPERCUSP_PARITY_PAIR_INDEX')),
      runId,
      exitCode: result.exitCode,
      output: result.output,
      durationMs: result.durationMs ?? Date.now() - startedAt,
    };
    process.stdout.write(`${RESULT_PREFIX}${JSON.stringify(payload)}\n`);
  } finally {
    await pgHandle.sql.end({ timeout: 1 }).catch(() => undefined);
  }
}

async function spawnArmProcess(input: WorkerParityArmInput, args: CliArgs, baseConfig: Record<string, unknown>, projectDir: string): Promise<WorkerParityArmResult> {
  const execution = await beginGovernedExecution(
    {
      idempotencyKey: `worker-parity:${args.cohortId}:${input.runId}`,
      admissionClass: 'process',
      demand: { cpuWeight: 1 },
      payloadRef: `worker-parity:${input.runId}`,
      parent: admissionContextFromEnvironment(process.env.PAPERCUSP_ADMISSION_CONTEXT),
      metadata: { processKind: 'worker-parity', arm: input.arm, pairIndex: input.pairIndex },
    },
    { owner: process.env.PAPERCUSP_SID?.trim() || `worker-parity:${input.runId}` },
    governedExecutionRuntime(args.workspaceId, 'agent-process'),
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...workerParityArmEnv(input.routeEnv),
    [ROUTE_PROOF_ENV]: '1',
    [ARM_ENV]: input.arm,
    [MODEL_ENV]: input.model,
    [PROMPT_ENV]: Buffer.from(input.prompt, 'utf8').toString('base64'),
    [RUN_ID_ENV]: input.runId,
    [CHUNK_ENV]: input.chunkId,
    PAPERCUSP_PARITY_PAIR_INDEX: String(input.pairIndex),
    PAPERCUSP_PARITY_PROJECT_DIR: projectDir,
    PAPERCUSP_SPAWN_MODEL: input.model,
    HARNESS_CONFIG_JSON: JSON.stringify(workerParityArmConfig(baseConfig as never, input.arm, input.model)),
    PAPERCUSP_ADMISSION_CONTEXT: JSON.stringify(execution.context),
  };
  const script = fileURLToPath(import.meta.url);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', script, `--arm=${input.arm}`, `--workspace=${args.workspaceId}`, `--harness=${args.harnessSlug}`], {
      cwd: projectDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout = `${stdout}${chunk}`.slice(-128_000);
    });
    child.stderr.on('data', (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-128_000);
      process.stderr.write(`[parity ${input.pairIndex}/${input.arm}] ${chunk}`);
    });
    child.on('error', (error) => {
      void execution.cancel(`worker parity spawn error: ${error.message}`).finally(() => reject(error));
    });
    child.on('close', async (code, signal) => {
      await execution.finish({ cpuWeight: 1 });
      if (code !== 0) {
        reject(new Error(
          `parity ${input.runId} child failed code=${code ?? 'null'} signal=${signal ?? 'none'}: `
          + (stderr.trim() || stdout.trim() || 'no output'),
        ));
        return;
      }
      const lines = stdout.split(/\r?\n/);
      let line: string | undefined;
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        if (lines[i]?.startsWith(RESULT_PREFIX)) {
          line = lines[i];
          break;
        }
      }
      if (!line) {
        reject(new Error(`parity ${input.runId} child returned no result envelope`));
        return;
      }
      try {
        resolve(JSON.parse(line.slice(RESULT_PREFIX.length)) as WorkerParityArmResult);
      } catch (error) {
        reject(new Error(`parity ${input.runId} returned invalid result JSON: ${String(error)}`));
      }
    });
  });
}

async function runMain(args: CliArgs): Promise<void> {
  const flagStore = await import('../flag-override-store');
  flagStore.installFlagOverrideStore();
  const [workspaceRegistry, harnessCore, harnessConfig, dbOrg] = await Promise.all([
    import('../workspace-registry'),
    import('../harness-core'),
    import('../harness-effective-config'),
    import('@papercusp/db-org'),
  ]);
  if (!args.workspaceId) args.workspaceId = workspaceRegistry.activeWorkspaceId();
  if (!Number.isSafeInteger(args.pairs) || args.pairs < 1 || args.pairs > 100) {
    throw new Error(`--pairs must be an integer in [1,100], got ${args.pairs}`);
  }
  const project = await harnessCore.resolveProject(args.harnessSlug, args.workspaceId);
  if (!project) throw new Error(`unknown harness ${args.workspaceId}/${args.harnessSlug}`);
  const ownerId = process.env.PAPERCUSP_SID?.trim() || undefined;
  const route = await resolveWorkerParityRoute({
    workspaceId: args.workspaceId,
    harnessSlug: args.harnessSlug,
    model: args.model,
    ...(ownerId ? { ownerId } : {}),
  });
  const pgHandle = dbOrg.getOrgPg();
  try {
    process.stdout.write(`${JSON.stringify(routeSummary(route), null, 2)}\n`);
    if (!args.execute) return;

    const baseConfig = await harnessConfig.readEffectiveHarnessConfig(
      args.harnessSlug,
      args.workspaceId,
      project.path,
    );
    const result = await runWorkerParityCohort({
      route,
      cohortId: args.cohortId,
      pairs: args.pairs,
      runArm: (arm) => spawnArmProcess(arm, args, baseConfig as Record<string, unknown>, project.path),
      onPairComplete: (done, total) => {
        process.stdout.write(`worker parity cohort ${args.cohortId}: ${done}/${total} pair(s) persisted\n`);
      },
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await pgHandle.sql.end({ timeout: 1 }).catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.arm ?? process.env[ARM_ENV]) {
    args.arm = args.arm ?? (process.env[ARM_ENV] as WorkerParityArm);
    await runIsolatedArm(args);
  } else {
    await runMain(args);
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    process.stderr.write(
      `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
      () => process.exit(1),
    );
  },
);
