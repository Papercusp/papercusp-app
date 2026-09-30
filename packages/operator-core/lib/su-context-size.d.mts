export declare const SU_CONTEXT_SIZE: "trimmed";
export declare const SU_CONTEXT_SIZE_STEWARD: "steward";
export declare const LEGACY_SU_CONTEXT_SIZE: "full";

export type NormalizedSuContextSize =
  | { ok: true; contextSize: "trimmed" | "steward"; explicit: boolean; normalizedLegacyFull: boolean }
  | { ok: false; error: string; received: string };

export declare function normalizeSuContextSize(input: unknown): NormalizedSuContextSize;
