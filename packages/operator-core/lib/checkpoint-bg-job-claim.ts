/**
 * checkpoint-bg-job-claim — detect an UNVERIFIABLE background-job claim inside a
 * checkpoint (EI-18654296679612119).
 *
 * A checkpoint that reports "verification is running in bg job <id> (log
 * /tmp/foo.log), will complete once clean" reads as "basically done, just
 * wait for green" to whoever inherits the item — but native background-job
 * bookkeeping (Bash `run_in_background`/`TaskOutput`, or an ad-hoc
 * `cmd & echo $!` job) lives in the WRITER'S OWN process/shell, not anywhere
 * papercusp persists (EI-16611, see
 * cold-loop-wake-kills-native-background-bash-tasks). The instant that
 * process is replaced — session teardown, a loop/carry respawn, a
 * compaction, or simply the writer moving on — the referenced job can die
 * silently (SIGHUP) with no trace left in the checkpoint text itself. A log
 * that stopped growing with no errors LOOKS clean but is genuinely
 * ambiguous: "finished cleanly" and "was killed mid-run" are
 * indistinguishable without checking the runner's own completion marker AND
 * the OS-level liveness of the referenced pid/job.
 *
 * Confirmed live 2026-07-25 (WI-5778): a checkpoint only ~41s old still
 * referenced two background jobs that had ALREADY died — both underlying OS
 * processes had exited, and neither log reached a real completion marker.
 * Absolute recency (checkpointAgeMs) gave no signal here; only actually
 * checking `ps -p <pid>` and diffing the log's tail against the runner
 * script's own success/failure strings caught it.
 *
 * This is a cheap, PURE, warn-only heuristic (mirrors
 * {@link ./checkpoint-staleness}'s `computeCheckpointStaleness`): it cannot
 * itself know whether the referenced job is still alive — that requires an
 * OS-level check (`ps`/`kill -0`) only the reader, in their own shell, can
 * perform — so it flags the CLAIM SHAPE ("this checkpoint leans on a
 * background job as evidence") and tells the reader exactly what to go
 * verify, instead of letting the prose be trusted at face value.
 */

/**
 * Keyword-level match for a checkpoint that cites a background job/task as
 * evidence of in-flight or completed work. Deliberately broad for natural
 * language because a false positive only prompts a verification the reader
 * should do anyway. A `task_id`/`bash_id` marker is different: count it only
 * when a handle-shaped value follows, so an SQL column name alone is not a
 * background-job claim.
 */
/**
 * WI-38297 — WIDENED, because the original alternation MISSED the single most common
 * real-world phrasing and therefore never fired on the items it was built to catch.
 * `background` was only recognized when IMMEDIATELY followed by job/task/process/
 * verification, but agents overwhelmingly write "<cmd> running in background (bash id
 * <id>)" — the noun never appears. Measured 2026-08-12 against the actual stranded
 * checkpoints:
 *
 *   "test:affected running in background (bash id bx76day3h) — will report+complete
 *    once it finishes."                        WI-5895, open 17 days   → MISSED
 *   "tsc --noEmit running in background to confirm no type errors;
 *    awaiting result before considering this done."   WI-3561, 34 days → MISSED
 *   "read task id bf5ryqqze output when it lands. If green -> complete"
 *                                              WI-3578, 34 days       → MISSED
 *
 * So every pickup-path warning (work_items:get / claim / scheduler:get_next) stayed
 * silent on exactly the checkpoints whose promised result could never arrive. Added:
 * bare "in (the) background", and the `bash id` / `task id` forms when followed by a
 * handle-shaped token — a checkpoint citing a native handle is citing a reference
 * that cannot outlive its author's process, which is the whole point. A bare SQL
 * column such as `RETURNING task_id` does not name such a handle.
 *
 * Widening is the right direction for THIS classifier specifically (see the header):
 * it is warn-only and deliberately broad, so a false positive costs a verification the
 * reader should do anyway, while a false negative costs a 17-day strand. The negative
 * controls that keep it honest ("this task is about…", "filed a follow-up job in the
 * queue") are pinned in checkpoint-bg-job-claim.test.ts and still hold — `task[_ -]?id`
 * cannot match "task identifier" (the trailing \b rejects it).
 */
const BG_JOB_REFERENCE_RE =
  /\b(?:bg\s*jobs?|background\s+(?:job|task|process|verification)s?|in\s+(?:the\s+)?background|run_in_background|in[- ]?flight\s+(?:verification|job|task)s?)\b/i;

// Native task IDs are generated handles (typically mixed letters and digits);
// requiring the value after the label prevents a generic SQL `task_id` column
// from being treated as an in-flight job. Bash IDs also include numeric PIDs.
const TASK_JOB_HANDLE_RE =
  /\btask[_\s-]?id\s*(?:[:=#]\s*)?(?:[a-z0-9_-]*[a-z][a-z0-9_-]*\d[a-z0-9_-]*|\d{4,})\b/i;
const BASH_JOB_HANDLE_RE =
  /\bbash[_\s-]?id\s*(?:[:=#]\s*)?(?:[a-z0-9_-]*[a-z][a-z0-9_-]*\d[a-z0-9_-]*|\d{4,})\b/i;

export interface BgJobCheckpointWarning {
  /** True when the checkpoint text cites a background job/task as evidence. */
  detected: boolean;
  /** Present only when `detected` — never asserts the job is dead, points the
   *  reader at the OS-level check that would prove it one way or the other. */
  reason?: string;
}

export function detectBgJobCheckpointClaim(
  checkpoint: string | null | undefined,
): BgJobCheckpointWarning {
  const text = (checkpoint ?? '').trim();
  if (
    !text ||
    (!BG_JOB_REFERENCE_RE.test(text) && !TASK_JOB_HANDLE_RE.test(text) && !BASH_JOB_HANDLE_RE.test(text))
  ) {
    return { detected: false };
  }
  return {
    detected: true,
    reason:
      'This checkpoint cites a background job/task as evidence — background-job bookkeeping lives ' +
      "in the WRITER'S OWN process/shell (not anywhere papercusp persists) and can die silently " +
      '(session teardown, a loop/carry respawn, a compaction) with no trace left in the checkpoint ' +
      'text (EI-16611 / EI-18654296679612119). Do NOT trust "verification in progress" or "will ' +
      'complete once clean" at face value: verify the referenced pid/job is still alive ' +
      '(`ps -p <pid>` or the job-status tool that started it) AND check the log for the ' +
      "runner's OWN completion marker — a log that simply stopped growing with no errors is " +
      'ambiguous (clean finish vs killed mid-run), not proof of success.',
  };
}
