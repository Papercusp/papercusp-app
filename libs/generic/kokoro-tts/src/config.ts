/**
 * Host seam for `@papercusp/kokoro-tts` (WI-4470).
 *
 * The package carries no `@huggingface/transformers` coupling: the three
 * primitives kokoro-tts.ts actually calls (a text-to-speech model loader,
 * a tokenizer loader, and a tensor constructor) are injected once via
 * `configureKokoroTts()`. This is deliberate, not incidental — the whole
 * reason this glue was vendored in the first place (see kokoro-tts.ts's
 * header, WI-4449/WI-4471) is that the upstream `kokoro-js` npm package
 * pins a transformers major version the repo doesn't run, and npm
 * workspaces `overrides` can't dedupe a nested transitive pin. A generic
 * package that itself listed `@huggingface/transformers` as a dependency
 * would reintroduce exactly that risk for any FUTURE consumer pinning a
 * different version; the injection seam keeps this package version-free.
 *
 * Types are kept STRUCTURAL (not imported from `@huggingface/transformers`)
 * so this package has zero build-time coupling to it either — the host
 * (operator-core) supplies the real classes, which already satisfy this
 * shape.
 *
 * Uses the same process-global Symbol-keyed slot as `@papercusp/memory`'s
 * seam (see its config.ts): under this repo's tsx runtime, a workspace
 * package can load via a node_modules symlink whose ESM loader resolves
 * inconsistently across import sites, forking a module-level singleton
 * into two instances. A `Symbol.for` registry key is immune to that.
 */

import { pinModuleState } from '@papercusp/module-singleton';

/** A loaded TTS model: callable with the model inputs, resolves the waveform. */
export type KokoroModelHandle = (inputs: {
  input_ids: unknown;
  style: unknown;
  speed: unknown;
}) => Promise<{ waveform: { data: Float32Array } }>;

/** A loaded tokenizer: callable, returns token ids for the given text. */
export type KokoroTokenizerHandle = (
  text: string,
  opts: { truncation: boolean },
) => { input_ids: { dims: { at(index: number): number | undefined } } };

export interface KokoroTransformersHost {
  StyleTextToSpeech2Model: {
    from_pretrained(modelId: string, opts: Record<string, unknown>): Promise<KokoroModelHandle>;
  };
  AutoTokenizer: {
    from_pretrained(modelId: string, opts: Record<string, unknown>): Promise<KokoroTokenizerHandle>;
  };
  /** A tensor constructor, e.g. `new Tensor('float32', data, dims)`. Narrowed to the one
   *  dtype literal this package actually constructs — a wider `string` param made the real
   *  transformers.js `Tensor` (whose dtype param is a specific literal union) structurally
   *  un-assignable here (TS2322: source must accept every value the target's param promises). */
  Tensor: new (dtype: 'float32', data: unknown, dims: number[]) => unknown;
}

/**
 * The pin key — also the id this module reports under in
 * `listModuleDuplications()`, so a split here is visible in the REALM-WIDE
 * report rather than only through this module's own accessor. Unchanged from
 * the `Symbol.for(...)` description this seam used before it was migrated
 * (EI-19469900474673886).
 */
const STATE_KEY = '@papercusp/kokoro-tts:host';

interface KokoroState {
  host: KokoroTransformersHost | null | undefined;
}

/**
 * Pinned + counted by `@papercusp/module-singleton` rather than hand-rolled.
 * A hand-rolled `globalThis[Symbol.for(...)]` slot fixes correctness but is
 * invisible to `listModuleDuplications()`, so the central report answers a
 * clean `[]` while this module is split. Must stay at module scope.
 */
const state = pinModuleState<KokoroState>(STATE_KEY, () => ({ host: undefined }));

/**
 * Wire the host's transformers primitives. Call once before first use (the
 * operator's voice-node/kokoro-local.ts does this, dynamically importing
 * `@huggingface/transformers` at the same point it currently dynamic-
 * imports this package, so the native onnxruntime load stays off the boot
 * path). Idempotent — last call wins.
 */
export function configureKokoroTts(host: KokoroTransformersHost): void {
  state.host = host;
}

/** Internal accessor — throws if the host hasn't been configured yet. */
export function kokoroTransformersHost(): KokoroTransformersHost {
  const host = state.host;
  if (!host) {
    throw new Error(
      '@papercusp/kokoro-tts is not configured — call configureKokoroTts({ StyleTextToSpeech2Model, AutoTokenizer, Tensor }) before using KokoroTts (the operator does this in lib/voice-node/kokoro-local.ts).',
    );
  }
  return host;
}

/** Test/diagnostic helper: is a host wired? */
export function isKokoroTtsConfigured(): boolean {
  return state.host != null;
}

/** Test hook: clear the wired host. */
export function __resetKokoroTtsHostForTests(): void {
  state.host = null;
}
