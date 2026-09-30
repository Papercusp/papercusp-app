/**
 * crash-resume-advisory — the R4 resume-channel re-verify advisory
 * (interrupted-member-recovery-hardening-2026-09-01 P-004 / WI-2140461, D-002).
 *
 * THE HAZARD (EI-16611 class): a wake delivered over a RESUME channel means the
 * session's original CLI process EXITED before this turn ran. Everything that
 * lived only in that process's memory died with it — native background-Bash
 * bookkeeping (`run_in_background` ids / TaskOutput handles), child processes
 * it spawned, listeners, tunnels, in-flight callback flows. The resumed
 * transcript still CARRIES the predecessor's claims about that work ("job X is
 * running", "task Y COMPLETED exit 0") with full confidence — and a completion
 * notification can be stale even when it was genuinely delivered: a wrapper
 * shell (`cmd & echo launched`) reports done while its real child still runs.
 * The resumed turn must therefore re-verify carried background-work claims
 * against the real OS / the durable ledger before acting on them.
 *
 * D-002 (probed): `wakeTurnText` is CHANNEL-AGNOSTIC — built before channel
 * selection, and it must stay byte-identical for in-place injects (live pty
 * inject, psu-host inject), where the process did NOT die and carried claims
 * are still backed by a living process. So this advisory is appended ONLY at
 * the process-exited rung (Channel 2: `resume-headless` + the OMP pty resume
 * fallback) by the wake executor — never inside `wakeTurnText`. The EI-15799 /
 * EI-16648 reconcile notes are the precedent pattern: a scoped reconciliation
 * instruction appended to the wake text, byte-identical everywhere else.
 *
 * PURE and read-free by design: only evidence the executor already holds
 * locally (agent, ended_at) frames the advisory — no DB read may ride the wake
 * hot path for framing (same discipline as P-003's classifier consumption).
 */

/** Self-identifying first token — tests and downstream tooling key on it. */
export const CRASH_RESUME_ADVISORY_MARKER = '[resume-after-death advisory]';

export interface CrashResumeAdvisoryMeta {
  /** The resumed client (claude | omp | codex), naming the process that died. */
  agent: string | null;
  /** The dead process's recorded end time (adv session ended_at), when known. */
  endedAtIso?: string | null;
}

/** Build the standalone advisory block (PURE — no reads, total on null meta). */
export function buildCrashResumeAdvisory(meta: CrashResumeAdvisoryMeta): string {
  const died = meta.endedAtIso ? ` (recorded ended_at: ${meta.endedAtIso})` : '';
  const client = meta.agent || 'CLI';
  return (
    `${CRASH_RESUME_ADVISORY_MARKER} This turn RESUMED a session whose ${client} process had already ` +
    `EXITED${died} — this wake spawned a fresh process because no live one existed. Anything that lived ` +
    "only in the dead process's memory is GONE: native background-Bash tasks (run_in_background ids / " +
    'TaskOutput handles), child processes, listeners, tunnels. Before acting on ANY carried claim about ' +
    'background or in-flight work — including a carried "COMPLETED" (a wrapper shell can report done ' +
    'while its real child still ran) — RE-VERIFY it against the real OS (`ps aux | grep`, `kill -0 <pid>`) ' +
    'or the durable ledger that owns it (tool_invocations, the work-item checkpoint), and re-launch what ' +
    'matters through a restart-durable path (EI-16611: `capability:bash` background jobs are operator-owned; ' +
    'native CLI background tasks are not).'
  );
}

/**
 * Append the advisory to an already-built wake turn text. The wake executor
 * calls this exactly once, on the RESUME rungs only — every other channel's
 * text must remain byte-identical (R4 / D-002).
 */
export function appendCrashResumeAdvisory(wakeText: string, meta: CrashResumeAdvisoryMeta): string {
  return `${wakeText}\n\n${buildCrashResumeAdvisory(meta)}`;
}
