/**
 * EI-18803497769946984 — name a tool that is holding the dispatcher's ambient workspace
 * transaction open too long, while the call is still alive and the name is still known.
 *
 * `dispatchWithSynthesizedTx` holds a `withWorkspace` transaction for a projected tool's
 * entire handler. A handler that blocks on non-DB work (a child process, a slow external
 * call) leaves that transaction IDLE; past Postgres's
 * `idle_in_transaction_session_timeout` (60s on this deployment) the backend is killed,
 * PgBouncer reports `server conn crashed?`, and the caller receives a bare
 *
 *     write CONNECTION_CLOSED 127.0.0.1:6432
 *
 * That message names neither the tool nor the cause, which is the expensive part: the
 * condition ran ~31 kills/day and was diagnosed as a PgBouncer/infra problem three
 * separate times before being traced back to the dispatcher. This warning exists so the
 * NEXT occurrence arrives already diagnosed.
 *
 * Lives in its own module rather than inline in `_mcp-handler.ts` so it can be unit
 * tested without importing the whole MCP handler (and its tool catalog + PG deps).
 */

/**
 * How long a handler may hold the ambient workspace transaction before we say so.
 *
 * Deliberately below the 60s `idle_in_transaction_session_timeout` so the warning lands
 * while the call is still alive — a warning emitted after the kill would be reporting a
 * corpse, and the tool name is the whole value here.
 */
export const IDLE_TX_WARN_MS = 45_000;

/** Injectable clock, so tests need no real timers. */
export interface IdleTxWarnDeps {
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
  warn: (message: string) => void;
}

const defaultDeps: IdleTxWarnDeps = {
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
  warn: (m) => {
    console.warn(m);
  },
};

export function idleTxWarningMessage(toolName: string, afterMs: number = IDLE_TX_WARN_MS): string {
  return (
    `[mcp-tool] idle-tx-risk: "${toolName}" has held its ambient workspace transaction ` +
    `for ${afterMs / 1000}s without settling. Postgres kills an idle transaction at ` +
    `idle_in_transaction_session_timeout (60s), which reaches the caller as a bare ` +
    `"write CONNECTION_CLOSED 127.0.0.1:6432" that names neither this tool nor this cause. ` +
    `Only tools declaring needsWorkspaceTx:true retain an ambient transaction. ` +
    `If this handler never reads ctx.tx, remove that declaration ` +
    `(EI-18808330244321407).`
  );
}

/**
 * Warn if `p` is still pending after {@link IDLE_TX_WARN_MS}, then pass it through
 * untouched.
 *
 * Purely observational: it never alters the settled value, never converts a rejection,
 * and never delays anything. The timer is unref'd so it cannot hold the process alive,
 * and is always cleared on settle so a fast call costs one `setTimeout`/`clearTimeout`
 * pair and nothing else.
 */
export function warnIfHoldingWorkspaceTxTooLong<T>(
  toolName: string,
  p: Promise<T>,
  deps: IdleTxWarnDeps = defaultDeps,
): Promise<T> {
  const timer = deps.setTimeout(() => {
    deps.warn(idleTxWarningMessage(toolName));
  }, IDLE_TX_WARN_MS);
  (timer as { unref?: () => void }).unref?.();
  return p.finally(() => {
    deps.clearTimeout(timer);
  });
}
