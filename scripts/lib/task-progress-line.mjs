// scripts/lib/task-progress-line.mjs
//
// EI-21048499991398082: the AFFECTED_TASK_PROGRESS `exitStatus=`/`signal=` pair, extracted so
// it is unit-testable without spawning the whole affected-tests.mjs scheduler.

/**
 * Render the `exitStatus=`/`signal=` values for one AFFECTED_TASK_PROGRESS line.
 *
 * `status`/`signal` mirror Node's `child_process` `close(code, signal)` pair, which is
 * MUTUALLY EXCLUSIVE by construction: a normal exit has a numeric `code` and a `null`
 * signal; a signal-killed process has a `null` code and a signal name. Both are KNOWN
 * the instant `close` fires. Pass `settled: true` for that call. Every OTHER progress
 * tick (started / running / watchdog-extended / watchdog-firing) fires BEFORE the child
 * has closed, so `status`/`signal` there are genuinely not yet knowable — pass
 * `settled: false` (the default) for those.
 *
 * Bug this exists to prevent: a bare `status ?? "pending"` / `signal ?? "pending"` — with
 * no way to tell "not yet knowable" from "known: the OTHER field is what applies" — makes
 * a TERMINAL line, e.g. `state=finished exitStatus=0 signal=pending`, read as "this task's
 * outcome is still unresolved" even though `state=finished` already says it settled
 * cleanly (a normal exit always has `signal: null`). A reader (human, LLM triager, or a
 * future log summarizer) scanning for "which tasks have a fully-known outcome" by
 * requiring BOTH fields non-"pending" then misclassifies every clean, exit-0 pass as
 * still-open — the false-red shape reported in EI-21048499991398082 ("aborted run reports
 * exit-0 tasks as FAILED"). `settled: true` renders a definite `null` as `"none"` instead,
 * so "pending" is reserved for what is genuinely still unknown.
 *
 * @param {{ status: number | null, signal: string | null, settled: boolean }} args
 * @returns {{ exitStatus: number | string, signal: string }}
 */
export function formatTaskOutcomeFields({ status, signal, settled }) {
  const notApplicable = settled ? "none" : "pending";
  return {
    exitStatus: status ?? notApplicable,
    signal: signal ?? notApplicable,
  };
}
