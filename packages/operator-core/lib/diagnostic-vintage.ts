/**
 * Runtime-vs-pipeline identity for diagnostic responses.
 *
 * A diagnostic endpoint can be perfectly healthy while its process is serving
 * code older than the staging tree it describes. Keep this disclosure
 * additive and pure so callers can attach it without changing the causal
 * diagnostic envelope or its existing action fields.
 */
import { getBuildInfo } from './build-info';

export type DiagnosticVintageStatus = 'current' | 'stale' | 'unknown';

export interface DiagnosticVintage {
  /** Build identity of the process producing this diagnostic response. */
  processSha: string | null;
  /** Current integration/staging HEAD, when the pipeline read measured it. */
  stagingHeadSha: string | null;
  /** Green pin that the release checkout is expected to serve, when measured. */
  greenPinSha: string | null;
  status: DiagnosticVintageStatus;
  processMatchesStaging: boolean | null;
  processMatchesGreenPin: boolean | null;
  /** Actionable disclosure for consumers that are about to follow `nextVerb`. */
  warning: string | null;
}

export interface DiagnosticVintageInput {
  processSha: string | null | undefined;
  stagingHeadSha: string | null | undefined;
  greenPinSha: string | null | undefined;
}

function normalizeSha(value: string | null | undefined): string | null {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return normalized.length >= 7 ? normalized : null;
}

/** Prefix-safe comparison for full and short git identities. */
export function shaMatches(a: string | null | undefined, b: string | null | undefined): boolean | null {
  const left = normalizeSha(a);
  const right = normalizeSha(b);
  if (!left || !right) return null;
  return left === right || left.startsWith(right) || right.startsWith(left);
}

function displaySha(value: string | null): string {
  return value ? value.slice(0, 12) : 'unknown';
}

export function computeDiagnosticVintage(input: DiagnosticVintageInput): DiagnosticVintage {
  const processSha = normalizeSha(input.processSha);
  const stagingHeadSha = normalizeSha(input.stagingHeadSha);
  const greenPinSha = normalizeSha(input.greenPinSha);
  const processMatchesStaging = shaMatches(processSha, stagingHeadSha);
  const processMatchesGreenPin = shaMatches(processSha, greenPinSha);
  const status: DiagnosticVintageStatus =
    processMatchesStaging === true ? 'current' : processMatchesStaging === false ? 'stale' : 'unknown';

  let warning: string | null = null;
  if (status === 'stale') {
    warning =
      `This diagnostic process is serving build ${displaySha(processSha)} while staging is at ` +
      `${displaySha(stagingHeadSha)}; its guidance may predate current fixes. Verify any ` +
      `nextVerb against a current staging read before acting.`;
  } else if (status === 'unknown') {
    warning =
      `Diagnostic build freshness is UNKNOWN (process ${displaySha(processSha)}, staging ` +
      `${displaySha(stagingHeadSha)}); do not assume this guidance covers the current tree. ` +
      `Verify any nextVerb against a current staging read before acting.`;
  }

  return {
    processSha,
    stagingHeadSha,
    greenPinSha,
    status,
    processMatchesStaging,
    processMatchesGreenPin,
    warning,
  };
}

/** Build the disclosure for a live process using its cached runtime identity. */
export function currentDiagnosticVintage(input: Omit<DiagnosticVintageInput, 'processSha'> & { processSha?: string | null }): DiagnosticVintage {
  return computeDiagnosticVintage({
    processSha: input.processSha ?? getBuildInfo().sha,
    stagingHeadSha: input.stagingHeadSha,
    greenPinSha: input.greenPinSha,
  });
}
