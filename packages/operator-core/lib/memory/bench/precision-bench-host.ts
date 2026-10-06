import { configureMemory, type EmbedderMode, type MemoryHost } from '@papercusp/memory';
import { readCredentials } from '../../credentials';
import { getHarnessAdminUrl } from '../../embedded-pg-discovery';
import { buildEmbedderForMode, resolveEmbedderForMode } from '../worker-embedder';

export const PRECISION_BENCH_EMBEDDER_MODE_ENV = 'PAPERCUSP_PRECISION_BENCH_EMBEDDER_MODE';

const PRECISION_MODES = ['openai', 'local', 'gemma', 'harrier'] as const;
type PrecisionEmbedderMode = (typeof PRECISION_MODES)[number];

function parsePrecisionMode(value: string): PrecisionEmbedderMode {
  if ((PRECISION_MODES as readonly string[]).includes(value)) return value as PrecisionEmbedderMode;
  throw new Error(`precision bench requires a resolved embedder mode; received ${JSON.stringify(value)}`);
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
    getCredentials: async () => {
      const credentials = await readCredentials();
      return {
        openai_api_key: credentials.openai_api_key,
        anthropic_api_key: credentials.anthropic_api_key,
      };
    },
    resolveEmbedder: () => resolveEmbedderForMode(mode),
    buildEmbedderForMode,
  };
}

/** Configure the child process without importing the operator's full memory host. */
export function configurePrecisionBenchMemoryHost(mode: string | undefined): void {
  if (!mode) throw new Error(`missing ${PRECISION_BENCH_EMBEDDER_MODE_ENV}`);
  configureMemory(createPrecisionBenchMemoryHost(mode));
}
