/**
 * Credential-safe listener startup diagnostics.
 *
 * Keep this module dependency-free: host-bootstrap imports it before loading
 * the listener graph, so an import-time failure in that graph can still be
 * classified without exposing an arbitrary message, stack, socket path, URL,
 * or credential to the journal.
 */
export function agentMcpBootstrapFailureCode(error: unknown): string {
  const candidate = error && typeof error === 'object'
    ? error as { code?: unknown; name?: unknown; message?: unknown }
    : null;
  const systemCode = typeof candidate?.code === 'string' &&
    /^[A-Z][A-Z0-9_]{1,63}$/.test(candidate.code)
    ? candidate.code : null;
  if (systemCode) return `system:${systemCode}`;
  const message = typeof candidate?.message === 'string' ? candidate.message : '';
  if (/^uds_[a-z_]+$/.test(message)) return `uds:${message}`;
  if (message === 'Invalid MCP endpoint' || message === 'Invalid operator port') {
    return `contract:${message.replaceAll(' ', '_').toLowerCase()}`;
  }
  const name = typeof candidate?.name === 'string' &&
    /^(?:Error|TypeError|RangeError|ReferenceError|SyntaxError)$/.test(candidate.name)
    ? candidate.name : null;
  return name ? `runtime:${name}` : 'unknown';
}
