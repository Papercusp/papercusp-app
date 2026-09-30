import {
  TOOL_RESULT_EVIDENCE_MAX_CHARS,
  TOOL_RESULT_EVIDENCE_MAX_EVENTS,
  type ToolResultEvent,
} from '@papercusp/testing-shell/llm';

import {
  redactSensitiveText,
  redactStructuredSensitiveValue,
} from '../sensitive-text';

const TRUNCATION_SUFFIX = '\n[tool result truncated]';
const TOOL_NAME_MAX_CHARS = 200;

function boundedOutput(output: string): { output: string; truncated: boolean } {
  if (output.length <= TOOL_RESULT_EVIDENCE_MAX_CHARS) {
    return { output, truncated: false };
  }
  return {
    output:
      output.slice(0, TOOL_RESULT_EVIDENCE_MAX_CHARS - TRUNCATION_SUFFIX.length) +
      TRUNCATION_SUFFIX,
    truncated: true,
  };
}

function redactToolResultOutput(rawOutput: string): string {
  try {
    return JSON.stringify(redactStructuredSensitiveValue(JSON.parse(rawOutput)));
  } catch {
    return redactSensitiveText(rawOutput);
  }
}

/**
 * Convert one raw dispatcher result into the only form allowed to cross the
 * TurnResult/judge/persistence boundary: secret-scrubbed and size-bounded.
 */
export function captureToolResultEvidence(
  name: string,
  rawOutput: string,
  isError: boolean,
): ToolResultEvent {
  const redacted = redactToolResultOutput(rawOutput);
  const bounded = boundedOutput(redacted);
  return {
    name: redactSensitiveText(name).slice(0, TOOL_NAME_MAX_CHARS),
    output: bounded.output,
    isError,
    truncated: bounded.truncated,
    sourceChars: rawOutput.length,
  };
}

/**
 * Defense-in-depth normalization at DB/replay boundaries. Historical rows
 * legitimately have no field; malformed entries are dropped rather than sent
 * to the external judge. Redaction is deliberately repeated and idempotent.
 */
export function normalizeToolResultEvidence(value: unknown): ToolResultEvent[] {
  if (!Array.isArray(value)) return [];
  const normalized: ToolResultEvent[] = [];
  for (const raw of value.slice(0, TOOL_RESULT_EVIDENCE_MAX_EVENTS)) {
    if (!raw || typeof raw !== 'object') continue;
    const candidate = raw as Record<string, unknown>;
    if (typeof candidate.name !== 'string' || typeof candidate.output !== 'string') continue;

    const redacted = redactToolResultOutput(candidate.output);
    const bounded = boundedOutput(redacted);
    const sourceChars =
      typeof candidate.sourceChars === 'number' &&
      Number.isFinite(candidate.sourceChars) &&
      candidate.sourceChars >= 0
        ? Math.trunc(candidate.sourceChars)
        : candidate.output.length;
    normalized.push({
      name: redactSensitiveText(candidate.name).slice(0, TOOL_NAME_MAX_CHARS),
      output: bounded.output,
      isError: candidate.isError === true,
      truncated: candidate.truncated === true || bounded.truncated,
      sourceChars,
    });
  }
  return normalized;
}
