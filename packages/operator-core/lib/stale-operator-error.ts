/**
 * Diagnosis for module-link failures on the long-lived operator process.
 *
 * A changed export surface fails while an ESM graph is linking, before the
 * imported module evaluates. That means a try/catch inside the optional leg
 * cannot protect its caller. Keep this classifier dependency-free so the
 * rest-query error boundary can use it without importing another host graph.
 */

export const STALE_OPERATOR_MODULE_LINK_CODE = 'stale_operator_module_link';

export interface StaleOperatorModuleLinkDiagnosis {
  code: typeof STALE_OPERATOR_MODULE_LINK_CODE;
  staleOperator: true;
  message: string;
  originalMessage: string;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return String(error);
}

/** True for the ESM loader signatures that indicate a stale or split module graph. */
export function isStaleOperatorModuleLinkError(error: unknown): boolean {
  const message = messageOf(error);
  return (
    /does not provide an export named/i.test(message) ||
    /\bERR_MODULE_[A-Z0-9_]+\b/.test(message) ||
    /Cannot find (?:module|package) /i.test(message)
  );
}

/** Convert a raw link error into a query-scoped, restart-actionable diagnosis. */
export function diagnoseStaleOperatorModuleLink(
  queryName: string,
  error: unknown,
): StaleOperatorModuleLinkDiagnosis | null {
  const originalMessage = messageOf(error);
  if (!isStaleOperatorModuleLinkError(error)) return null;
  return {
    code: STALE_OPERATOR_MODULE_LINK_CODE,
    staleOperator: true,
    originalMessage,
    message:
      `sync query "${queryName}" failed because this operator may be running stale code ` +
      `after a module change (${originalMessage}). Restart the operator process and retry.`,
  };
}
