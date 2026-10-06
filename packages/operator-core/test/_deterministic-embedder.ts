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
 *
 * Second seam (EI-24688584300743328): the memory host is only ONE of four
 * cascades that build a local embedder. search/embed-backfill (reached by the
 * declare-intent pivot leg), agent-tools/search/embedder and personal-vault
 * build theirs through `buildSidecarAwareEmbedder` without asking the memory
 * host, and with the host fixture alone the benchmark parent still constructed
 * the real gemma ONNX model (onnxruntime CUDA, ~5 GB of GPU). The fixture
 * therefore also installs the process-wide local-engine override in
 * embed-sidecar-wiring, which every one of those cascades passes through.
 * `assertNoLocalModelLoaded` is the matching negative control.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  configureMemory,
  memoryHost,
  embedPipelineDevices,
  getWorkerState,
  EMBEDDER_DIM_SPECS,
  type EmbedFn,
  type ResolvedEmbedder,
} from '@papercusp/memory';
import { pinModuleState } from '@papercusp/module-singleton';
import { setLocalEmbedEngineOverride } from '../lib/memory/embed-sidecar-wiring';

/**
 * Records the JS stack of this thread's first onnxruntime native load, so the
 * negative control names WHO loaded it instead of only THAT it happened.
 * Installed once per process by installDeterministicEmbedder; wraps
 * process.dlopen with the original arguments forwarded unchanged.
 */
const onnxDlopenTrip = pinModuleState<{ installed: boolean; stack: string | null }>(
  '@papercusp/operator-core.test.onnxDlopenTripwire',
  () => ({ installed: false, stack: null }),
);

function installOnnxruntimeDlopenTripwire(): void {
  if (onnxDlopenTrip.installed) return;
  onnxDlopenTrip.installed = true;
  const real = process.dlopen as unknown as (...args: unknown[]) => unknown;
  (process as unknown as { dlopen: (...args: unknown[]) => unknown }).dlopen = (...args: unknown[]) => {
    if (onnxDlopenTrip.stack === null && /onnxruntime/i.test(String(args[1]))) {
      // The default 10-frame limit is spent inside the module loader before the
      // first application frame, so capture deep and drop loader internals.
      const previousLimit = Error.stackTraceLimit;
      Error.stackTraceLimit = 200;
      const raw = new Error('onnxruntime dlopen').stack ?? '';
      Error.stackTraceLimit = previousLimit;
      const frames = raw.split('\n').filter((line) => !/node:internal|\/node_modules\/tsx\//.test(line));
      onnxDlopenTrip.stack = `${String(args[1])}\n${frames.join('\n')}`;
    }
    return real.apply(process, args);
  };
}

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
  installOnnxruntimeDlopenTripwire();
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
  // Every other local-embedder cascade (embed-backfill, search query embedder,
  // personal-vault) builds through buildSidecarAwareEmbedder; serve those from
  // the same deterministic function, at each space's own width, and count them
  // into the same positive control.
  setLocalEmbedEngineOverride((model) => {
    const width = EMBEDDER_DIM_SPECS[model].targetDims;
    return async (text) => {
      calls++;
      return deterministicEmbedding(text, width);
    };
  });
  return { mode: 'gemma', dims, calls: () => calls };
}

/** Evidence that no real local embedding model was loaded in this process. */
export interface LocalModelLoadEvidence {
  /** model id → device, for every ONNX pipeline this process constructed. */
  pipelines: Record<string, string>;
  /** Whether the local-embedder worker thread exists. */
  workerAlive: boolean;
  /** /proc/self/maps lines naming an onnxruntime shared library (Linux only; [] elsewhere). */
  onnxruntimeMappings: string[];
  /** JS stack of the first onnxruntime dlopen on this thread after install, or null. */
  onnxruntimeLoadStack: string | null;
}

/** Read the three independent signals that a local model was (not) loaded. */
export function localModelLoadEvidence(): LocalModelLoadEvidence {
  let onnxruntimeMappings: string[] = [];
  try {
    onnxruntimeMappings = [
      ...new Set(
        readFileSync('/proc/self/maps', 'utf8')
          .split('\n')
          .filter((line) => /onnxruntime/i.test(line))
          .map((line) => line.trim().split(/\s+/).slice(5).join(' '))
          .filter(Boolean),
      ),
    ];
  } catch {
    // No procfs (non-Linux): the other two signals still apply.
  }
  return {
    pipelines: { ...embedPipelineDevices() },
    workerAlive: getWorkerState().alive,
    onnxruntimeMappings,
    onnxruntimeLoadStack: onnxDlopenTrip.stack,
  };
}

/**
 * The negative control for the fixture: throws when this process constructed
 * a local ONNX pipeline, started the embedder worker thread, or mapped an
 * onnxruntime library. Independent of how the fixture is wired, so a new
 * cascade that bypasses both seams fails here instead of silently loading a
 * model (and, on a GPU box, allocating gigabytes of device memory).
 */
export function assertNoLocalModelLoaded(
  where: string,
  evidence: LocalModelLoadEvidence = localModelLoadEvidence(),
): LocalModelLoadEvidence {
  const problems: string[] = [];
  if (Object.keys(evidence.pipelines).length > 0) {
    problems.push(`ONNX pipelines constructed: ${JSON.stringify(evidence.pipelines)}`);
  }
  if (evidence.workerAlive) problems.push('the local-embedder worker thread is alive');
  if (evidence.onnxruntimeMappings.length > 0) {
    problems.push(`onnxruntime is mapped: ${evidence.onnxruntimeMappings.join(', ')}`);
  }
  if (evidence.onnxruntimeLoadStack) {
    problems.push(`first onnxruntime load: ${evidence.onnxruntimeLoadStack.split('\n').slice(0, 30).join('\n')}`);
  }
  if (problems.length > 0) {
    throw new Error(
      `[deterministic-embedder] ${where}: a real local embedding model was loaded although the fixture is installed — ${problems.join('; ')}`,
    );
  }
  return evidence;
}
