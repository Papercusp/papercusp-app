export const CLAUDE_TOOL_REFERENCE_POISON_TURNS: number;
export const CLAUDE_TOOL_REFERENCE_RECOVERY_TURNS: number;
export const MAX_CLAUDE_RESUME_TOOL_REFERENCES: number;

export interface ClaudeResumeTranscriptAnalysis {
  toolReferences: string[];
  trailingMissingToolReferenceTurns: number;
  lastMissingToolReferenceEvidence: string | null;
  /** The tool name the latest counted rejection named, or null. */
  lastMissingToolReferenceName: string | null;
  /**
   * Assistant records (model output or the provider's synthetic error) written
   * after the most recent submitted prompt. A fork's file carries the source's
   * copied history, so "any assistant record exists" cannot say whether the
   * fork's own first reply has landed; this count can (WI-10004645).
   */
  assistantTurnsSinceLastPrompt: number;
  /** Trailing streak ≥ CLAUDE_TOOL_REFERENCE_RECOVERY_TURNS: a live session must be moved onto fresh context. */
  needsFreshContext: boolean;
  poisoned: boolean;
}

export function isMissingClaudeToolReferenceError(text: unknown): boolean;
export function missingClaudeToolReferenceEvidence(text: unknown): string | null;
export function analyzeClaudeResumeTranscript(
  jsonl: string,
  options?: { maxReferences?: number },
): ClaudeResumeTranscriptAnalysis;
export function analyzeClaudeResumeTranscriptFile(
  filePath: string,
  options?: { maxReferences?: number },
): ClaudeResumeTranscriptAnalysis | null;
export function __resetClaudeResumeTranscriptCacheForTests(): void;
export function appendClaudeToolReferencesToSeed(seed: string | null | undefined, references: readonly string[]): string;
export interface NeutralizeToolReferencesOptions {
  /** Leave Papercusp MCP references in place (a resume restores those via the launch seed). */
  nativeOnly?: boolean;
}
export function neutralizeClaudeToolReferences(
  jsonl: string,
  options?: NeutralizeToolReferencesOptions,
): { text: string; rewritten: number; toolNames: string[] };
export function neutralizeForkSeedToolReferences(
  projectsDir: string | null | undefined,
  sessionId: string | null | undefined,
  options?: NeutralizeToolReferencesOptions,
): { files: number; rewritten: number; toolNames: string[] };
export function neutralizeToolReferencesInFile(
  file: string | null | undefined,
  options?: NeutralizeToolReferencesOptions,
): { rewritten: number; toolNames: string[] };
export function neutralizeResumeNativeToolReferences(
  projectsDir: string | null | undefined,
  sessionId: string | null | undefined,
): { files: number; rewritten: number; toolNames: string[] };
export function neutralizeResumeNativeToolReferencesInFile(
  file: string | null | undefined,
): { rewritten: number; toolNames: string[] };
