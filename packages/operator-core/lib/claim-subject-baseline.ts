/**
 * Claim-time identity for issue-family work items.
 *
 * Issue coalescing intentionally refreshes the visible title/body and watchdog
 * metadata. A holder must nevertheless finish the subject it claimed, not a
 * later coalesced subject that happens to reuse the same work-item id. The
 * baseline is private payload state, stamped by the atomic claim write and read
 * only at completion time.
 */

export const CLAIM_SUBJECT_BASELINE_KEY = '_claimSubjectBaseline';

export interface ClaimSubjectBaseline {
  kind: string | null;
  title: string;
  summary: string;
  body: string;
  watchdogKey: string | null;
}

export interface ClaimSubjectMismatch {
  field: keyof ClaimSubjectBaseline;
  claimed: string | null;
  current: string | null;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function comparable(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === 'string' ? value : undefined;
}

/** Read a server-stamped baseline; absent or unrecognizable payload is legacy data. */
export function claimSubjectBaselineFromPayload(payload: unknown): Partial<ClaimSubjectBaseline> | null {
  const payloadRecord = recordOf(payload);
  const baselineRecord = recordOf(payloadRecord?.[CLAIM_SUBJECT_BASELINE_KEY]);
  if (!baselineRecord) return null;

  const baseline: Partial<ClaimSubjectBaseline> = {};
  for (const field of ['kind', 'title', 'summary', 'body', 'watchdogKey'] as const) {
    const value = comparable(baselineRecord[field]);
    if (value === undefined) continue;
    if (value === null) {
      if (field === 'kind' || field === 'watchdogKey') baseline[field] = value;
      continue;
    }
    baseline[field] = value;
  }
  return Object.keys(baseline).length > 0 ? baseline : null;
}

function currentSubject(item: {
  kind?: unknown;
  title?: unknown;
  summary?: unknown;
  body?: unknown;
  payload?: unknown;
}): ClaimSubjectBaseline {
  const payload = recordOf(item.payload);
  const body = typeof item.body === 'string' ? item.body : typeof item.summary === 'string' ? item.summary : '';
  return {
    kind: typeof item.kind === 'string' ? item.kind : null,
    title: typeof item.title === 'string' ? item.title : '',
    summary: typeof item.summary === 'string' ? item.summary : body,
    body,
    watchdogKey: typeof payload?.watchdogKey === 'string' ? payload.watchdogKey : null,
  };
}

/** Compare only fields present in the private baseline for legacy compatibility. */
export function claimSubjectBaselineMismatches(item: {
  kind?: unknown;
  title?: unknown;
  summary?: unknown;
  body?: unknown;
  payload?: unknown;
}): ClaimSubjectMismatch[] {
  const baseline = claimSubjectBaselineFromPayload(item.payload);
  if (!baseline) return [];
  const current = currentSubject(item);
  return (Object.keys(baseline) as Array<keyof ClaimSubjectBaseline>)
    .filter((field) => baseline[field] !== current[field])
    .map((field) => ({
      field,
      claimed: baseline[field] ?? null,
      current: current[field] ?? null,
    }));
}
