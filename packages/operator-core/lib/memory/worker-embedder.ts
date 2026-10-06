import {
  EMBEDDER_DIM_SPECS,
  type EmbedFn,
  type EmbedderMode,
  type ResolvedEmbedder,
} from '@papercusp/memory';
import { buildDeferredSidecarAwareEmbedder, buildSidecarAwareEmbedder } from './embed-sidecar-wiring';
import { buildOpenAiEmbedderCore, resolveOpenAiKey } from './openai-embedder';

type OpenAiBuilder = (key: string) => EmbedFn;

/** The explicit-mode builder shared by re-embedding and isolated precision workers. */
export async function buildEmbedderForMode(
  mode: 'openai' | 'local' | 'gemma' | 'harrier',
  buildOpenAi: OpenAiBuilder = (key) => buildOpenAiEmbedderCore(key),
): Promise<EmbedFn> {
  if (mode === 'openai') {
    const key = await resolveOpenAiKey();
    if (!key) throw new Error('openai_api_key not configured');
    return buildOpenAi(key);
  }
  if (mode === 'gemma') return buildSidecarAwareEmbedder('gemma', 'document');
  if (mode === 'harrier') return buildSidecarAwareEmbedder('harrier', 'document');
  return buildSidecarAwareEmbedder('local', 'document');
}

/** Resolve one already-selected production mode without re-running the parent process' cascade. */
// `'disabled'` is the stored-preference value for "no embedding"; it is not an
// EmbedderMode, but an untyped caller (the precision bench) can still pass it, so the
// parameter admits it and the guard below refuses it at runtime.
export async function resolveEmbedderForMode(mode: EmbedderMode | 'disabled'): Promise<ResolvedEmbedder> {
  if (mode === 'disabled') throw new Error('precision bench cannot run with memory embedding disabled');
  let embed: EmbedFn;
  if (mode === 'openai') {
    const key = await resolveOpenAiKey();
    if (!key) throw new Error('openai_api_key not configured');
    embed = buildOpenAiEmbedderCore(key);
  } else {
    embed = await buildDeferredSidecarAwareEmbedder(mode, 'document');
  }
  const profile = EMBEDDER_DIM_SPECS[mode];
  return { mode, dims: profile.targetDims, profile, embed };
}
