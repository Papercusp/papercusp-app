export interface ModelCapacityMatch {
  errorClass: 'rate_limited';
  retryable: true;
  retryAfterMs: number;
  matchedPattern: string;
  matchedExcerpt: string;
}

export const MODEL_CAPACITY_RETRY_AFTER_MS: number;
export const MODEL_CAPACITY_RE: RegExp;

export function modelCapacityRetryAfterMs(text: string): number;
export function modelCapacityLineMatch(text: string): ModelCapacityMatch | null;

export function makeModelCapacityDetector(options?: {
  maxBufferChars?: number;
}): {
  observe(text: string): ModelCapacityMatch | null;
  reset(): void;
};
