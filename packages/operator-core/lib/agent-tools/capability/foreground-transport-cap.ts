/**
 * The MCP transport cap, and the FOREGROUND command ceiling derived from it.
 *
 * EI-6073: the papercusp-su MCP transport hard-caps a tool call at ~55s. A FOREGROUND
 * command that outruns it is killed by the TRANSPORT with an opaque `request_timeout`
 * BEFORE the handler can respond — so the agent never learns the durable fix is a
 * detached run, and the very capability that exists to remove "shell out + poll"
 * friction pushes them back to it. A foreground-only tool therefore clamps its
 * command timeout safely below the cap, so the TOOL always self-times-out first
 * (`status: 'timed_out'`, a machine-separable token) and returns an actionable hint.
 * capability:bash now takes the stronger route: it uses this ceiling only as a
 * RESPONSE window, while one durable job keeps its independent execution deadline.
 * Reaching the response window returns that job's handle instead of killing it.
 *
 * EI-20645849301780712 is why these live here rather than in `capability:inspect`,
 * where they were first written. Three tools outside that file already imported them
 * (`testing:run`, `build:typecheck`, and historically `capability:bash`), which made a tool
 * reach into a SIBLING TOOL to learn a fact about the shared transport. `capability:bash`
 * — the most-used foreground surface of all — was the one that never got the clamp, and
 * the miss is exactly the kind an import-from-a-peer-tool shape hides: there was no
 * single place where "who honours the cap" was answerable. Now there is, and
 * `foreground-transport-cap.test.ts` separately enumerates foreground killers and
 * start-once response-yield tools as invariants.
 *
 * ⚠ Do NOT "fix" a too-short foreground run by RAISING these — that widens the dead
 * window between the ceiling and the transport cap, which is the defect, not the cure.
 * A command that legitimately needs longer needs a durable job. capability:bash creates
 * one for every call and returns it automatically at the response window; other tools
 * still require their explicit background mode. The job's own execution deadline is
 * not bound by this transport ceiling (see `DEFAULT_BACKGROUND_TIMEOUT_MS`).
 */

/** The hard per-call ceiling the MCP transport enforces. Not ours to change. */
export const MCP_TRANSPORT_CAP_MS = 55_000;

/** Time reserved for the process-tree SIGTERM → SIGKILL escalation after a foreground timeout. */
export const FOREGROUND_TERMINATION_GRACE_MS = 5_000;

/** Time reserved to serialize and deliver the structured timeout response. */
export const FOREGROUND_RESPONSE_HEADROOM_MS = 5_000;

/**
 * Foreground ceiling — leave room for process cleanup and response delivery before the transport
 * kills the call. Keep this derived from the shared budgets so a change to either cleanup path
 * cannot silently reopen the transport-vs-handler race (EI-22536928771275862).
 */
export const FOREGROUND_TIMEOUT_CEILING_MS =
  MCP_TRANSPORT_CAP_MS - FOREGROUND_TERMINATION_GRACE_MS - FOREGROUND_RESPONSE_HEADROOM_MS;

/** Clamp a FOREGROUND command timeout below the MCP transport cap (EI-6073).
 *  Background runs skip this clamp — they carry their own (much longer) deadline instead. */
export function clampForegroundTimeoutMs(requestedMs: number): number {
  return Math.min(requestedMs, FOREGROUND_TIMEOUT_CEILING_MS);
}

/**
 * The actionable hint appended when a FOREGROUND run hit the clamped ceiling (EI-6073) — turns an
 * opaque timeout into "this is too large to run inline; re-run detached and poll". Empty for any
 * other status, so a completed/failed run never carries a false timeout hint.
 *
 * `rerunAs` is the caller's OWN detached invocation (each tool has a different one), and stating
 * that the process was KILLED is load-bearing: EI-20645849301780712 was filed because an agent
 * could not tell a killed foreground run from one still executing invisibly server-side.
 *
 * Pure + exported for unit testing.
 */
/**
 * EI-21570021207351896 / EI-21569537333182760 — the clamp must SAY it clamped.
 *
 * `clampForegroundTimeoutMs` still protects internal callers that bypass transport schema
 * validation, but the public foreground orchestration schemas must use this same ceiling. That
 * keeps a valid request from silently receiving less time than it authored and makes the accepted
 * timeout contract match the runtime contract.
 *
 * Deliberately SEPARATE from `foregroundTimeoutHint` rather than folded into it. That hint
 * asserts the process tree "was KILLED — nothing is still running server-side", which is true
 * for `capability:bash` / `capability:inspect` (they own the child) and NOT true of code:run,
 * whose worker is terminated while a host-side facade call it dispatched may still be settling
 * (see the `onTimeout` cancellation seam, EI-20282336542235171). Reusing that wording here would
 * have produced a confidently FALSE disposition claim — the exact class of error that makes an
 * agent skip reconciling an in-flight write. This helper states only what is universally true:
 * what you asked for, what you actually got, and why they differ.
 *
 * Returns '' when the request was NOT clamped, so an honest budget never carries a false notice.
 * Pure + exported for unit testing.
 */
export function foregroundClampDisclosure(requestedMs: number, effectiveMs: number): string {
  if (!(requestedMs > effectiveMs)) return '';
  return (
    ` — ⚠ CLAMPED: you requested ${(requestedMs / 1000).toFixed(0)}s but the effective budget was ` +
    `${(effectiveMs / 1000).toFixed(0)}s, the foreground ceiling kept below the ~${(
      MCP_TRANSPORT_CAP_MS / 1000
    ).toFixed(0)}s MCP transport cap so this returns a real error instead of an opaque ` +
    `request_timeout. The deadline you set was never in force — do not read this as your budget ` +
    `being exhausted, and re-running with a larger timeoutSec will NOT buy more time.`
  );
}

export function foregroundTimeoutHint(status: string, timeoutMs: number, rerunAs: string): string {
  if (status !== 'timed_out') return '';
  return (
    `\n⏱ hit the ${(timeoutMs / 1000).toFixed(0)}s foreground cap (kept below the ~${(
      MCP_TRANSPORT_CAP_MS / 1000
    ).toFixed(0)}s MCP transport limit so this returns a hint instead of an opaque request_timeout). ` +
    `The command and its whole process tree were KILLED at the cap — nothing is still running server-side. ` +
    `This is too slow to run inline — re-run detached: ${rerunAs}, then poll capability:bash_output. ` +
    `⚠ If the output above (and any partial-output log) is EMPTY despite the command running the ` +
    `whole ${(timeoutMs / 1000).toFixed(0)}s, check whether its LAST pipeline stage BUFFERS until ` +
    `EOF (\`sort\`, \`uniq -c\`, an accumulating \`awk\`, \`jq -s\`, \`column\`) — killed before EOF, ` +
    `that stage never got to emit a single row, so empty output here does NOT mean the command did ` +
    `nothing. Restructure to emit incrementally (drop the buffering stage, or read straight from the ` +
    `unfiltered log — same rule as filtering a BACKGROUND job's output at read time, never launch time).`
  );
}
