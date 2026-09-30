/**
 * Gateway-backed paired worker-parity runner (own-tui-full-divorce P-014 / D-027).
 *
 * This module owns only the deterministic cohort contract and the non-generation
 * route proof. The executable wrapper runs every arm in a dedicated process and
 * delegates the actual turn + persistence to orchestrator `invoke()`. Process
 * isolation matters: both `invoke()` and the native Anthropic transport consume
 * launch routing from process.env, and a benchmark must never leak its temporary
 * OMP models.yml or account route into the shared operator process.
 */
import type { HarnessConfig } from '@papercusp/orchestrator';
import {
  ompGatewayModelFromSpec,
} from '../inference-gateway/omp-models-config';
import {
  ACCOUNT_ROUTING_MODE_ENV,
  resolveSpawnGatewayEnv,
} from '../inference-gateway/spawn-env';
import { resolveLoopModelSpec } from './model-selection';

export type WorkerParityArm = 'omp' | 'loop';

export type GatewayEnvResolver = (
  input: Parameters<typeof resolveSpawnGatewayEnv>[0],
) => Promise<Record<string, string>>;

export interface WorkerParityRoutePlan {
  schemaVersion: 'worker-parity-route-v1';
  /** Canonical bare upstream id stamped identically on both run_meta records. */
  model: string;
  loopProvider: 'gateway-anthropic' | 'gateway-codex';
  account: 'auto';
  ompEnv: Record<string, string>;
  loopEnv: Record<string, string>;
  proof: {
    ompSelector: string;
    ompGatewayBaseUrl: string;
    loopGatewayBaseUrl: string;
  };
}

export interface WorkerParityArmInput {
  arm: WorkerParityArm;
  pairIndex: number;
  runId: string;
  chunkId: string;
  prompt: string;
  model: string;
  routeEnv: Record<string, string>;
}

export interface WorkerParityArmResult {
  arm: WorkerParityArm;
  pairIndex: number;
  runId: string;
  exitCode: number;
  output: string;
  durationMs: number;
}

export interface WorkerParityCohortResult {
  schemaVersion: 'worker-parity-cohort-v1';
  cohortId: string;
  model: string;
  requestedPairs: number;
  completedPairs: number;
  results: WorkerParityArmResult[];
}

function loopbackUrl(value: string | undefined, label: string): URL {
  if (!value) throw new Error(`${label} did not resolve a gateway base URL`);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} returned an invalid gateway URL: ${JSON.stringify(value)}`);
  }
  if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) {
    throw new Error(`${label} must resolve the local Papercusp gateway, got ${parsed.toString()}`);
  }
  return parsed;
}

function ompBaseUrl(modelsYml: string): string {
  const match = /^\s*baseUrl:\s*["']?([^"'\s]+)["']?\s*$/m.exec(modelsYml);
  if (!match?.[1]) throw new Error('OMP gateway models.yml did not contain a baseUrl');
  return match[1];
}

/**
 * Resolve and validate both gateway routes without issuing model generation.
 * Direct API-key providers are rejected before the route resolver is called.
 */
export async function resolveWorkerParityRoute(input: {
  workspaceId: string;
  harnessSlug: string;
  ownerId?: string;
  model: string;
  resolveGatewayEnv?: GatewayEnvResolver;
}): Promise<WorkerParityRoutePlan> {
  const loopSelection = resolveLoopModelSpec(input.model, null);
  if (
    loopSelection.provider !== 'gateway-anthropic'
    && loopSelection.provider !== 'gateway-codex'
  ) {
    throw new Error(
      `worker parity forbids direct-provider model ${JSON.stringify(input.model)}; `
      + 'use a bare model id or claude/ or codex/ subscription alias',
    );
  }

  // Canonicalize aliases/provider prefixes before invoking. D-015 pairs on the
  // requestedModel wire, so `claude/<id>` on one arm and `<id>` on the other
  // would otherwise be an avoidable model-mismatch pair.
  const model = loopSelection.modelId;
  const ompRoute = ompGatewayModelFromSpec(model);
  if (!ompRoute) throw new Error(`OMP cannot route parity model ${JSON.stringify(model)} through the gateway`);
  const expectedAccountProvider = loopSelection.provider === 'gateway-codex' ? 'codex' : 'claude';
  if (ompRoute.modelId !== model || ompRoute.accountProvider !== expectedAccountProvider) {
    throw new Error(
      `parity route mismatch: loop=${loopSelection.provider}/${model}, `
      + `omp=${ompRoute.accountProvider}/${ompRoute.modelId}`,
    );
  }

  const resolveEnv = input.resolveGatewayEnv ?? resolveSpawnGatewayEnv;
  const common = {
    workspaceId: input.workspaceId,
    slug: input.harnessSlug,
    role: 'worker',
    model,
    account: 'auto' as const,
    ...(input.ownerId ? { ownerId: input.ownerId } : {}),
  };
  const [ompEnv, loopEnv] = await Promise.all([
    resolveEnv({ ...common, backend: 'omp' }),
    resolveEnv({
      ...common,
      backend: loopSelection.provider === 'gateway-codex' ? 'codex' : 'claude-code',
    }),
  ]);

  const ompSelector = ompEnv.PAPERCUSP_OMP_MODEL_SELECTOR;
  const expectedSelector = `papercusp-gateway/${model}`;
  if (ompSelector !== expectedSelector) {
    throw new Error(`OMP gateway selector mismatch: expected ${expectedSelector}, got ${ompSelector || '<empty>'}`);
  }
  const modelsYml = ompEnv.PAPERCUSP_OMP_MODELS_YML;
  if (!modelsYml || !modelsYml.includes('# BEGIN PAPERCUSP_OMP_GATEWAY')) {
    throw new Error('OMP parity route did not resolve the managed Papercusp gateway models.yml');
  }
  const ompGatewayUrl = loopbackUrl(ompBaseUrl(modelsYml), 'OMP parity route').toString();

  let loopGatewayUrl: string;
  if (loopSelection.provider === 'gateway-anthropic') {
    loopGatewayUrl = loopbackUrl(loopEnv.ANTHROPIC_BASE_URL, 'owned-loop parity route').toString();
    if (!loopEnv.ANTHROPIC_AUTH_TOKEN) {
      throw new Error('owned-loop Anthropic gateway route omitted the client auth token');
    }
    if (loopEnv[ACCOUNT_ROUTING_MODE_ENV] !== 'auto') {
      throw new Error('owned-loop Anthropic route must retain explicit auto account routing');
    }
  } else {
    if (loopEnv.PAPERCUSP_CODEX_GATEWAY !== '1') {
      throw new Error('owned-loop Codex route did not enable the Papercusp gateway');
    }
    // createRoutedModelPort resolves this same local gateway port for codex/.
    const port = Number(process.env.PAPERCUSP_GATEWAY_PORT);
    loopGatewayUrl = `http://127.0.0.1:${Number.isFinite(port) && port > 0 ? port : 8788}/v1`;
    loopbackUrl(loopGatewayUrl, 'owned-loop Codex parity route');
  }

  return {
    schemaVersion: 'worker-parity-route-v1',
    model,
    loopProvider: loopSelection.provider,
    account: 'auto',
    ompEnv,
    loopEnv,
    proof: {
      ompSelector,
      ompGatewayBaseUrl: ompGatewayUrl,
      loopGatewayBaseUrl: loopGatewayUrl,
    },
  };
}

/** Per-arm effective config handed to the isolated invoke process. */
export function workerParityArmConfig(
  base: HarnessConfig,
  arm: WorkerParityArm,
  model: string,
): HarnessConfig {
  const ai = (base.aiBackend ?? {}) as {
    default?: Record<string, unknown>;
    roles?: Record<string, Record<string, unknown>>;
  };
  const roles = ai.roles ?? {};
  const worker = roles.worker ?? {};
  return {
    ...base,
    aiBackend: {
      ...ai,
      roles: {
        ...roles,
        worker: {
          ...worker,
          engine: arm === 'loop' ? 'loop' : 'subprocess',
          // The baseline is explicitly OMP; the loop arm ignores agentCmd but
          // keeps the same value so engine is the only execution-path delta.
          agentCmd: 'omp -p',
          model,
        },
      },
    },
  } as HarnessConfig;
}

/**
 * Per-process benchmark env. The engine comparison deliberately disables the
 * subprocess-only OS sandbox: the owned-loop arm never enters that sandbox, so
 * enabling it only on OMP would add a second experimental variable. Both arms
 * still expose only the read-only canary task and capability-gated tool surface.
 */
export function workerParityArmEnv(routeEnv: Record<string, string>): Record<string, string> {
  return {
    ...routeEnv,
    PAPERCUSP_FLEET_SANDBOX: '0',
    // Remove OMP's native bash/edit/write/fetch tools so the requested
    // capability:git call cannot be silently substituted with a native shell.
    PAPERCUSP_FLEET_CAPABILITY_ONLY: '1',
  };
}

/** One distinct, read-only tool-bearing task; byte-identical across its pair. */
export function workerParityPrompt(pairIndex: number): string {
  if (!Number.isSafeInteger(pairIndex) || pairIndex < 1) {
    throw new Error(`pairIndex must be a positive integer, got ${pairIndex}`);
  }
  const pair = String(pairIndex).padStart(2, '0');
  return [
    `Worker parity canary pair ${pair}.`,
    'Call the MCP tool capability:git exactly once with this input:',
    '{"args":["status","--short"]}',
    `After the tool succeeds, reply exactly PARITY_OK_${pair}.`,
    'Do not use a native shell or any other tool, and do not modify anything.',
  ].join('\n');
}

function safeCohortId(value: string): string {
  const normalized = value.trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!normalized) throw new Error('cohortId must contain at least one safe character');
  return normalized.slice(0, 80);
}

/** Execute paired arms through an injected process-isolated arm runner. */
export async function runWorkerParityCohort(input: {
  route: WorkerParityRoutePlan;
  cohortId: string;
  pairs?: number;
  runArm: (arm: WorkerParityArmInput) => Promise<WorkerParityArmResult>;
  onPairComplete?: (completedPairs: number, totalPairs: number) => void;
}): Promise<WorkerParityCohortResult> {
  const pairs = input.pairs ?? 20;
  if (!Number.isSafeInteger(pairs) || pairs < 1 || pairs > 100) {
    throw new Error(`pairs must be an integer in [1,100], got ${pairs}`);
  }
  const cohortId = safeCohortId(input.cohortId);
  const results: WorkerParityArmResult[] = [];

  // One pair at a time prevents a 20-pair run from becoming a 40-request burst;
  // the two arms inside a pair launch together to avoid systematic order bias.
  for (let pairIndex = 1; pairIndex <= pairs; pairIndex += 1) {
    const prompt = workerParityPrompt(pairIndex);
    const pair = String(pairIndex).padStart(2, '0');
    const armInputs: WorkerParityArmInput[] = (['omp', 'loop'] as const).map((arm) => ({
      arm,
      pairIndex,
      runId: `worker-parity-${cohortId}-${pair}-${arm}`,
      chunkId: `worker-parity-${cohortId}-${pair}`,
      prompt,
      model: input.route.model,
      routeEnv: arm === 'omp' ? input.route.ompEnv : input.route.loopEnv,
    }));
    const pairResults = await Promise.all(armInputs.map((arm) => input.runArm(arm)));
    results.push(...pairResults);
    input.onPairComplete?.(pairIndex, pairs);
  }

  return {
    schemaVersion: 'worker-parity-cohort-v1',
    cohortId,
    model: input.route.model,
    requestedPairs: pairs,
    completedPairs: pairs,
    results,
  };
}
