/**
 * _deterministic-embedder.ts — an in-process, text-deterministic embedder for
 * benchmark fixtures (blueprint-backed-work-item-execution-2026-09-23 D-022(a)).
 *
 * The claim-time memory recall (memory/claim-port.ts → buildLaunchMemoryBlock →
 * mem0/hybrid) embeds its query through whatever `resolveEmbedder` the memory
 * host was configured with. In a benchmark that is a D-016 PROVIDER: the real
 * leg (embed sidecar, then an in-process gemma/harrier model load) cost about
 * 2.5 s of every cold arm (WI-10002948, pilots 8-10), which drowns the effect a
 * paired arm comparison is trying to measure. The fixture arms therefore embed
 * with this function; the actual-provider recall is measured only by the
 * separate smoke.
 *
 * NOT a test file — imported by them, and by the P-013 cold child process.
 *
 * Seam: `configureMemory` is "last call wins" on a process-global host slot
 * (libs/generic/memory/src/config.ts), so re-configuring with the operator's
 * own host plus a replaced `resolveEmbedder` swaps ONLY the embedder. The
 * operator's `lib/memory/configure.ts` wires the host as an import side effect,
 * so it is imported FIRST here; otherwise a later lazy import of it would
 * overwrite this override and silently restore the real embedder. The returned
 * `calls()` counter is the positive control: a benchmark asserts it moved, so a
 * seam that stopped taking effect fails loudly instead of re-measuring the
 * provider.
 *
 * Unlike the constant vectors some integration tests inline, the vector
 * depends on the text, so cosine ranking over stored memories still separates
 * different texts (a constant vector makes every candidate tie).
 */
import { createHash } from 'node:crypto';
import {
  configureMemory,
  memoryHost,
  EMBEDDER_DIM_SPECS,
  type EmbedFn,
  type ResolvedEmbedder,
} from '@papercusp/memory';

/** Unit-length vector derived only from `text` (SHA-256 in counter mode). */
export function deterministicEmbedding(text: string, dims: number): number[] {
  const out = new Array<number>(dims);
  let filled = 0;
  for (let block = 0; filled < dims; block++) {
    const digest = createHash('sha256').update(`${block}\0${text}`).digest();
    for (let offset = 0; offset + 4 <= digest.length && filled < dims; offset += 4) {
      // Map the 32-bit word onto [-1, 1).
      out[filled++] = digest.readUInt32BE(offset) / 0x8000_0000 - 1;
    }
  }
  let norm = 0;
  for (const v of out) norm += v * v;
  const scale = norm > 0 ? 1 / Math.sqrt(norm) : 0;
  return out.map((v) => v * scale);
}

export interface InstalledDeterministicEmbedder {
  /** The embedding space the fixture writes/reads (the production default). */
  mode: 'gemma';
  dims: number;
  /** Number of embed calls served since install — the positive control. */
  calls: () => number;
}

/**
 * Replace the memory host's embedder with the deterministic fixture for the
 * rest of this process. Uses the production default space ('gemma', native
 * 768) so the vector binding, the per-mode vec table and the profile checks are
 * the same ones production exercises; only the embed function differs.
 */
export async function installDeterministicEmbedder(): Promise<InstalledDeterministicEmbedder> {
  await import('../lib/memory/configure');
  const host = memoryHost();
  const profile = EMBEDDER_DIM_SPECS.gemma;
  const dims = profile.targetDims;
  let calls = 0;
  const embed: EmbedFn = async (text) => {
    calls++;
    return deterministicEmbedding(text, dims);
  };
  const resolved: ResolvedEmbedder = { mode: 'gemma', dims, profile, embed };
  configureMemory({
    ...host,
    resolveEmbedder: async () => resolved,
    buildEmbedderForMode: async () => embed,
  });
  return { mode: 'gemma', dims, calls: () => calls };
}
