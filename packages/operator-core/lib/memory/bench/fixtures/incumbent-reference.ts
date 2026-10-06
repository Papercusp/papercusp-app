/** Synthetic transport/identity controls. Actual weights have separate operational proof. */
import { EMBEDDER_DIM_SPECS, gemmaPrompt, harrierPrompt } from '@papercusp/memory';
import { CORRECTED_GEMMA_REFERENCE_ID, INCUMBENT_REFERENCE_CASES, REFERENCE_PARITY_LIMITS,
  type NativeReference, type PythonReference } from '../candidate-embedders';

export function incumbentReferenceFixture() {
  const cases = INCUMBENT_REFERENCE_CASES.flatMap(([id, text]) => (['query', 'document'] as const).map((kind) => ({ id: `${kind}-${id}`, kind, text })));
  const native: NativeReference = { protocolSha256: 'a'.repeat(64), requestSha256: 'b'.repeat(64), cases,
    identities: (['gemma', 'harrier'] as const).map((model) => ({ model, profile: EMBEDDER_DIM_SPECS[model],
      files: ['config.json', 'tokenizer.json', 'onnx/model.onnx'].map((f) => ({ locator: `cache:validation/${model}/${f}`, sha256: 'c'.repeat(64), bytes: 100 })) })),
    arms: ([['gemma', 'shipped-sdk'], ['gemma', 'corrected-rust'], ['harrier', 'shipped-sdk']] as const).map(([model, tokenizerBackend]) => {
      const spec = EMBEDDER_DIM_SPECS[model];
      return { model, tokenizerBackend, profileId: tokenizerBackend === 'corrected-rust' ? CORRECTED_GEMMA_REFERENCE_ID : spec.profileId,
        dimensions: spec.nativeDims, pooling: spec.pooling,
        cases: cases.map((c, i) => {
          const vector = new Array<number>(spec.nativeDims).fill(0); vector[Math.floor(i / 2)] = 1;
          return { ...c, promptedText: model === 'gemma' ? gemmaPrompt(c.kind, c.text) : harrierPrompt(c.kind, c.text),
            inputIds: [1, i + 2], attentionMask: [1, 1], vector,
            ...(tokenizerBackend === 'shipped-sdk' ? { shippedVector: [...vector] } : {}) };
        }) };
    }) };
  const python: PythonReference = { nativeSha256: 'd'.repeat(64), requestSha256: native.requestSha256,
    executionProvider: 'CPUExecutionProvider', thresholds: REFERENCE_PARITY_LIMITS,
    versions: { numpy: 'test', onnxruntime: 'test', tokenizers: 'test', transformers: 'test' },
    arms: native.arms.map((a) => ({ model: a.model, profileId: a.profileId, tokenizerBackend: a.tokenizerBackend,
      cases: a.cases.map((c) => ({ id: c.id, referenceTokenIds: [...c.inputIds], referenceVector: [...c.vector] })) })) };
  return { native, python };
}
