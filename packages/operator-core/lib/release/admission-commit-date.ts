/**
 * The synthetic commit date every repair-queue ADMISSION commit carries, and the predicate that
 * recognises it again downstream.
 *
 * WHY A FIXED DATE EXISTS: admission builds the plumbing commit twice — once for the dry-run
 * preview, once for the confirmed write — and the two must produce the IDENTICAL sha or the
 * preview is a lie. A commit's sha covers its author/committer dates, so those dates have to be
 * deterministic. That is a correct design and is not what this module is here to change.
 *
 * WHY IT NEEDS A PREDICATE: the date is therefore NOT a measurement of anything. It says nothing
 * about when the commit was made, and a consumer that reads it as a real committer date computes
 * an age of ~26.7 YEARS for a commit that is minutes old. `gate_health.candidateCommittedAt` is
 * exactly such a consumer: green-checkpoint records the judged candidate's `%cI`, and the
 * gate-verdict-freshness CANDIDATE-FOSSIL rule differences it against verdict time. Under
 * freeze-and-converge the judged candidate IS an admission commit (`repairHead`), so that rule
 * fired on every single repairHead verdict — measured live 2026-09-23 as
 * "judged a commit that was ALREADY 234291.7h old", which then suppressed the red as unreliable
 * and told readers to go hunt a candidate-selection bug that does not exist (WI-10002121).
 *
 * `git-pipeline-stats.ts` already guards the sibling of this failure — it degrades an unparseable
 * `candidateCommittedAt` to null rather than 0, because 0 "would date the candidate to 1970 and
 * make EVERY verdict a fossil". The sentinel defeats that guard by being a well-formed, perfectly
 * parseable date. Recognising it is the same defence, extended to the one bad value that parses.
 *
 * Deliberately a LEAF module with no imports: the writer of these commits pulls in
 * `node:child_process`/`node:fs`, and the readers are pure stats/projection code that must not.
 * The literal lives here once and `repair-head-admission.ts` re-exports it, so there is exactly
 * one definition to keep in step with the commits actually being written.
 */

/** The identity every admission commit's author/committer date carries. */
export const ADMISSION_GIT_DATE = '2000-01-01T00:00:00Z';

/** `ADMISSION_GIT_DATE` as epoch ms, for comparison against a parsed date of any spelling. */
export const ADMISSION_GIT_DATE_MS = Date.parse(ADMISSION_GIT_DATE);

/**
 * Whether `raw` is the synthetic admission date rather than a real committer date.
 *
 * Compares PARSED INSTANTS, never strings: git renders `%cI` as `2000-01-01T00:00:00+00:00`
 * while the constant above is spelled with `Z`. Those are the same instant and a string
 * comparison would miss it — which is the whole bug, so the test for it is spelled out in
 * `admission-commit-date.test.ts` rather than left to the reader to rediscover.
 *
 * Accepts the same shapes the `gate_health` readers accept (ISO string or epoch ms), so a writer
 * that ever switches representation cannot silently turn the recognition off.
 */
export function isAdmissionSyntheticCommitDate(raw: string | number | null | undefined): boolean {
  if (raw == null) return false;
  if (typeof raw === 'number') return Number.isFinite(raw) && raw === ADMISSION_GIT_DATE_MS;
  if (typeof raw !== 'string' || raw.trim() === '') return false;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) && parsed === ADMISSION_GIT_DATE_MS;
}
