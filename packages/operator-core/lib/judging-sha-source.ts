/**
 * Where `changeInCandidate.judgingSha` (the headline of the `gate.greenCheckpoint.candidate`
 * cell) came from, and which of those readings a caller may ACT on.
 *
 * A LEAF module on purpose: `cell-registrations.ts` must stay import-light (it names its
 * resolver by string), and `git-pipeline-position.ts` pulls in git/systemd/pg. Both import
 * THIS so the registration's `headlineSource.authoritative` derives from the same list the
 * resolver branches on (derived-truth ladder rung 1). The registration used to hand-list only
 * `'retriage-marker'` while the resolver already trusted `'in-flight-candidate'` too, so the
 * door reported `source.authoritative:false` for a reading the code treated as an observation.
 *
 *  - `'retriage-marker'` / `'in-flight-candidate'` — the run's OWN published markers, an
 *    observation of what THIS run is judging.
 *  - `'repair-queue'` — main-green-status-visible-2026-09-03 P-011 follow-up (grader card
 *    EI-22277841040474660, C5 leg 3): the frozen repair queue's candidate. Under
 *    freeze-and-converge (default ON, D-007) every later run RESUMES that exact sha and the
 *    recorded red was computed on it, so between runs — and during a CRON run, whose probe
 *    degrades to a checkout-head inference — the persisted queue row is the honest answer to
 *    "which sha did the gate judge". Before this the cell answered `no-active-run` (with a
 *    safe action naming a re-cut at tip) for the whole between-runs life of a frozen queue.
 *  - `'run-probe'` — an inference; never authoritative.
 */
export const AUTHORITATIVE_JUDGING_SHA_SOURCES = ['retriage-marker', 'in-flight-candidate', 'repair-queue'] as const;

export type AuthoritativeJudgingShaSource = (typeof AUTHORITATIVE_JUDGING_SHA_SOURCES)[number];
export type JudgingShaSource = AuthoritativeJudgingShaSource | 'run-probe';

export function isAuthoritativeJudgingShaSource(
  source: JudgingShaSource | string | null | undefined,
): source is AuthoritativeJudgingShaSource {
  return !!source && (AUTHORITATIVE_JUDGING_SHA_SOURCES as readonly string[]).includes(source);
}
