export const SYSTEMD_RUNNER_OUTPUT_PATH_ENV: string;
export const SYSTEMD_RUNNER_REDACTIONS_ENV: string;
export const SYSTEMD_RUNNER_JOB_END_PREFIX: string;

export interface StreamingSecretRedactor {
  push(chunk: string): string;
  flush(): string;
}

export function createStreamingSecretRedactor(
  values: readonly string[] | undefined,
): StreamingSecretRedactor | null;

/** A redaction pattern carried as plain data so the runner can rebuild it. */
export interface StreamingRedactionPatternSpec {
  source: string;
  flags?: string;
  replacement?: string;
}

export const STREAMING_PATTERN_MAX_HOLD: number;

export function createStreamingPatternRedactor(
  patterns: readonly StreamingRedactionPatternSpec[] | undefined,
  maxHold?: number,
): StreamingSecretRedactor | null;

export function composeStreamingRedactors(
  ...redactors: readonly (StreamingSecretRedactor | null | undefined)[]
): StreamingSecretRedactor | null;

export function decodeRedactions(encoded: string): {
  values: string[];
  patterns: StreamingRedactionPatternSpec[];
};

export function main(argv?: string[]): void;

/**
 * True when `entryPath` is the copied runner itself, so only that copy self-executes.
 * Defaults to `process.argv[1]`. Mirrors the implementation in the sibling `.mjs`.
 */
export function isDirectSystemdScopeEnvRunnerInvocation(entryPath?: string): boolean;
