import {
  buildGemmaEmbedder,
  buildHarrierEmbedder,
  buildLocalEmbedder,
  buildSidecarFirstEmbedder,
  configureMemory,
  EMBEDDER_DIM_SPECS,
  type EmbedFn,
  type EmbedderMode,
  type MemoryCredentials,
  type MemoryHost,
  type ResolvedEmbedder,
} from '@papercusp/memory';
import { getHarnessAdminUrl } from '../../embedded-pg-discovery';
import { buildOpenAiEmbedderCore } from '../openai-embedder-core';

export const PRECISION_BENCH_EMBEDDER_MODE_ENV = 'PAPERCUSP_PRECISION_BENCH_EMBEDDER_MODE';

const PRECISION_MODES = ['openai', 'local', 'gemma', 'harrier'] as const;
type PrecisionEmbedderMode = (typeof PRECISION_MODES)[number];

function parsePrecisionMode(value: string): PrecisionEmbedderMode {
  if ((PRECISION_MODES as readonly string[]).includes(value)) return value as PrecisionEmbedderMode;
  throw new Error(`precision bench requires a resolved embedder mode; received ${JSON.stringify(value)}`);
}

function buildPrecisionBenchEmbedder(mode: PrecisionEmbedderMode): EmbedFn | Promise<EmbedFn> {
  if (mode === 'openai') {
    const key = process.env.OPENAI_API_KEY ?? '';
    if (!key) throw new Error('openai_api_key not configured');
    return buildOpenAiEmbedderCore(key);
  }
  const fallback = (): EmbedFn | Promise<EmbedFn> => {
    if (mode === 'local') return buildLocalEmbedder();
    if (mode === 'gemma') return buildGemmaEmbedder({ kind: 'document' });
    return buildHarrierEmbedder({ kind: 'document' });
  };
  return buildSidecarFirstEmbedder({ model: mode, kind: 'document', fallback });
}

async function resolvePrecisionBenchEmbedder(mode: PrecisionEmbedderMode): Promise<ResolvedEmbedder> {
  const profile = EMBEDDER_DIM_SPECS[mode];
  return {
    mode,
    dims: profile.targetDims,
    profile,
    embed: await buildPrecisionBenchEmbedder(mode),
  };
}

/** Build only the MemoryHost seams the isolated precision bench uses. */
export function createPrecisionBenchMemoryHost(value: string): MemoryHost {
  const mode = parsePrecisionMode(value) as EmbedderMode;
  return {
    getAdminUrl: getHarnessAdminUrl,
    schema: 'harness_shared',
    defaultDbName: 'papercusp',
    localStoreDir: null,
    backend: 'mem0',
    getCredentials: async (): Promise<MemoryCredentials> => ({
      openai_api_key: process.env.OPENAI_API_KEY,
      anthropic_api_key: process.env.ANTHROPIC_API_KEY,
    }),
    resolveEmbedder: () => resolvePrecisionBenchEmbedder(mode),
    buildEmbedderForMode: async (explicitMode) => buildPrecisionBenchEmbedder(parsePrecisionMode(explicitMode)),
  };
}

/** Configure the child process without importing the operator's full memory host. */
export function configurePrecisionBenchMemoryHost(mode: string | undefined): void {
  if (!mode) throw new Error(`missing ${PRECISION_BENCH_EMBEDDER_MODE_ENV}`);
  configureMemory(createPrecisionBenchMemoryHost(mode));
}
