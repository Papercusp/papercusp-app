/**
 * The stage seam every mic-path DSP element implements: one fixed-size PCM16
 * frame in, one out (in-place reuse is allowed — callers must not hold the
 * input). Engine-bound suppressors (RNNoise WASM, Koala, …) are host wirings
 * of this seam; the pure cores in this package implement it directly.
 */
export interface MicDspStage {
  /** Process one frame (frameSamples PCM16 mono). */
  process(frame: Int16Array): Int16Array;
  /** Release any native/WASM state. */
  destroy?(): void;
}

/** A noise suppressor is just a stage (alias for intent at call sites). */
export type NoiseSuppressor = MicDspStage;
