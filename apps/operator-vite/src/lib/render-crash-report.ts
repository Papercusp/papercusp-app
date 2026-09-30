/** Local crash signal for React render boundaries. Raw messages, stacks,
 * component props, query strings, and URLs never cross this boundary. */
const sent = new Set<string>();
const ALLOWED_ERRORS = new Set([
  'Error', 'TypeError', 'ReferenceError', 'RangeError', 'SyntaxError', 'URIError',
]);

function componentName(stack: string | null): string {
  const first = stack?.match(/^\s+at ([A-Za-z][A-Za-z0-9_.$-]{0,79})\b/m)?.[1];
  return first ?? 'unknown';
}

export function redactedRenderCrash(
  boundary: 'route' | 'adv-tab',
  error: Error,
  componentStack: string | null,
  tab?: string,
): {
  source: 'render-boundary';
  boundary: 'route' | 'adv-tab';
  errorType: string;
  component: string;
  tab: string;
  fingerprint: string;
} {
  const errorType = ALLOWED_ERRORS.has(error.name) ? error.name : 'Error';
  const component = componentName(componentStack);
  const safeTab = tab && /^[a-z][a-z0-9-]{0,39}$/.test(tab) ? tab : 'other';
  return {
    source: 'render-boundary',
    boundary,
    errorType,
    component,
    tab: boundary === 'adv-tab' ? safeTab : 'other',
    fingerprint: `${boundary}:${errorType}:${component}:${boundary === 'adv-tab' ? safeTab : 'other'}`,
  };
}

export function reportRenderCrash(
  boundary: 'route' | 'adv-tab',
  error: Error,
  componentStack: string | null,
  tab?: string,
): void {
  if (typeof fetch !== 'function') return;
  const payload = redactedRenderCrash(boundary, error, componentStack, tab);
  if (sent.has(payload.fingerprint)) return;
  sent.add(payload.fingerprint);
  try {
    void fetch('/api/desktop/telemetry-report', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'crash', payload }),
      keepalive: true,
    }).then((response) => {
      if (!response.ok) sent.delete(payload.fingerprint);
    }).catch(() => sent.delete(payload.fingerprint));
  } catch {
    sent.delete(payload.fingerprint);
  }
}

/** Test-only reset of the per-page duplicate fence. */
export function resetRenderCrashReportDedupForTest(): void {
  sent.clear();
}
