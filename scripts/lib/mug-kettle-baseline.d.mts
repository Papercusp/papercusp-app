export interface BaselineReseedEvaluation {
  previousEntries: string[];
  currentEntries: string[];
  previousEntryCount: number;
  nextEntryCount: number;
  removedEntries: string[];
  addedEntries: string[];
  shrunk: boolean;
  reason: string | null;
  reasonRequired: boolean;
  accepted: boolean;
}

export function normalizeBaselineEntries(entries?: unknown): string[];

export function evaluateBaselineReseed(options?: {
  previousEntries?: unknown;
  currentEntries?: unknown;
  reason?: unknown;
}): BaselineReseedEvaluation;

export function buildBaselineDocument(options?: {
  baseline?: Record<string, unknown>;
  currentEntries?: unknown;
  reason?: string;
  generatedAt?: string;
}): Record<string, unknown>;
