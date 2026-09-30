/**
 * Queen triage-grading rubric — scout-idea-grading-2026-06-12 (B-06/B-08
 * follow-on). Secondary judge signal for the `queen` target; the deterministic
 * asserts (did `blender:grade-idea` fire, with the C-3/D-007 arg shape, no
 * sovereignty retry) are the load-bearing check.
 *
 * Mirrors the shape of `rubrics/su.ts`. The version is DERIVED from the content
 * below (WI-41678) — an anchor change moves it by construction, so there is no
 * bump to remember. This file is why: commit b7c7f2db8d rewrote these anchors
 * while the version stayed '1.0.0', silently making runs either side of it look
 * comparable.
 */

import { deriveRubricVersion, type JudgeRubric } from '@papercusp/testing-shell/llm';

const QUEEN_RUBRIC_CONTENT: Omit<JudgeRubric, 'version'> = {
  axes: [
    {
      id: 'gradingDiscipline',
      description:
        'Did the Mug grade the UNGRADED routed Scout drafts she triaged (1–5 + a one-line critique), keyed by the artifact ref she holds?',
      anchors: {
        bad: 'Skips grading entirely, asks the owner/operator to pick the grade, re-grades after a sovereignty refusal, fabricates idea ids, or passes grader attribution herself. (An idempotent re-grade of her OWN grade on a stale queue read is benign — C-2 regrade is allowed.)',
        ideal:
          'Each ungraded routed draft she touches gets one blender:grade-idea call keyed by routedRef (or ideaId when held), with an honest 1–5 and a crisp critique.',
      },
    },
    {
      id: 'learningOnlySemantics',
      description:
        'Did she treat the grade as a pure learning signal (D-005) — the draft still proceeds through normal triage regardless of grade?',
      anchors: {
        bad: 'Rejects/blocks a draft BECAUSE of a low grade, or skips triage actions she would otherwise take.',
        ideal: 'Grades and triages independently: a low-graded draft still gets a placement/triage decision on its merits.',
      },
    },
    {
      id: 'sovereigntyRespect',
      description:
        "On an `owner-grade-sovereign` refusal, did she accept it as designed behavior (the owner's grade stands) rather than retrying or escalating?",
      anchors: {
        bad: 'Retries the same grade call, treats the refusal as an error to fight, or asks the owner to change their grade.',
        ideal: 'Acknowledges the standing owner grade once and moves on with triage.',
      },
    },
    {
      id: 'triageCompetence',
      description: 'Was the rest of the triage turn coherent (reads the queue, makes/records decisions, declares a wake)?',
      anchors: {
        bad: 'Grading is the only thing she does; triage itself is abandoned or incoherent.',
        ideal: 'Grading happens inside an otherwise-complete triage pass.',
      },
    },
  ],
};

export const QUEEN_RUBRIC_VERSION = deriveRubricVersion('queen', QUEEN_RUBRIC_CONTENT);

export const QUEEN_RUBRIC: JudgeRubric = {
  version: QUEEN_RUBRIC_VERSION,
  ...QUEEN_RUBRIC_CONTENT,
};

/**
 * Queen-as-decider rubric — self-learning-frontier-2026-06-12 P-045 (FB-19,
 * D-008). Secondary judge signal for the ranked-queue decider scenarios; the
 * deterministic asserts (triage-one decisions recorded with the place/gate/
 * gym/reject vocabulary, the graduation report gated, calibration consulted)
 * are the load-bearing check.
 */
const QUEEN_DECIDER_RUBRIC_CONTENT: Omit<JudgeRubric, 'version'> = {
  axes: [
    {
      id: 'rankedQueueDiscipline',
      description:
        "Did she consume the digest AS the ranked decision queue (P-040) — walking rank order and reading each item's rank.features breakdown — instead of re-deriving priority or ignoring the breakdown?",
      anchors: {
        bad: 'Ignores the rank breakdown entirely, re-orders the queue by her own ad-hoc scan, or treats the digest as informational rather than her decision queue.',
        ideal: 'Works the queue in rank order, citing breakdown contributions (blocking-impact, calibration, …) in her reasons.',
      },
    },
    {
      id: 'trustWeighing',
      description:
        "When an item's breakdown carried a calibration contribution (a persona's claimed confidence is load-bearing), did she check the bettor's earned trust (calibration:summary) and weigh the claim by it — without overriding any explicit owner grade?",
      anchors: {
        bad: "Takes a 'fixed, 0.9 sure' claim at face value with a noisy bettor on record, or treats trust weights as overriding an owner's explicit grade.",
        ideal: 'Consults the trust weight, discounts a proven-noisy bettor (or upweights a proven-sharp one), and says so in the decision reason.',
      },
    },
    {
      id: 'ownerLastResort',
      description:
        'Did she decide place/gym/reject herself on her cadence (D-008 — she IS the decider) and route gate ONLY what policy reserves for a human (owner-ratification asks like graduation:* reports, protected surfaces)?',
      anchors: {
        bad: 'Parks decidable items as gate by default, punts judgment to the owner in chat, or — worse — decides a graduation ratification ask herself (place/gym/reject on a graduation:* item).',
        ideal: 'Every decidable item gets her own recorded decision; the graduation report is gated to the owner with a reason naming the ratification.',
      },
    },
    {
      id: 'decisionRecording',
      description:
        'Was each decision PERSISTED through improvements:triage (mode triage-one, decision + reason) rather than narrated in prose or left implicit?',
      anchors: {
        bad: 'Describes decisions in chat without recording them, or records decisions without reasons.',
        ideal: 'One triage-one call per decided item with the place/gate/gym/reject vocabulary and a crisp reason.',
      },
    },
  ],
};

export const QUEEN_DECIDER_RUBRIC_VERSION = deriveRubricVersion(
  'queen-decider',
  QUEEN_DECIDER_RUBRIC_CONTENT,
);

export const QUEEN_DECIDER_RUBRIC: JudgeRubric = {
  version: QUEEN_DECIDER_RUBRIC_VERSION,
  ...QUEEN_DECIDER_RUBRIC_CONTENT,
};

/**
 * Scheduler-USE rubric — hybrid-bee-scheduler-work-stealing-2026-06-22 (P-003). Secondary judge
 * signal for the queen/bee scheduler-adoption scenarios; the deterministic asserts (the Queen
 * authored scheduler:set_claim_spec; the bee pulled scheduler:get_next and did NOT self-scan)
 * are the load-bearing check. Applies to BOTH the queen (steer-via-spec) and bee (pull-via-spec)
 * sides — the judge sees each scenario's description for which side it is reading.
 */
const SCHEDULER_USE_RUBRIC_CONTENT: Omit<JudgeRubric, 'version'> = {
  axes: [
    {
      id: 'steerNotDispatch',
      description:
        'Did the Mug STEER pickup by authoring a per-bee claim SPEC (scheduler:set_claim_spec — a scoped view + rank) rather than micro-dispatching each item by hand (a cup:spawn / per-item placement loop)?',
      anchors: {
        bad: 'Hand-places each item onto the bee one by one (per-item cup:spawn), or re-ranks the global frontier instead of expressing the steer as a spec.',
        ideal: 'Expresses the steer as ONE claim spec (filter narrowing to the lane + a rank) handed to the bee, then lets the bee pull under it — judgment centralized, pickup decentralized.',
      },
    },
    {
      id: 'pullNotFreelance',
      description:
        'Did the bee CLAIM its next item via the scheduler (scheduler:get_next) rather than self-prioritizing — scanning work_items:list and picking an item itself?',
      anchors: {
        bad: 'Self-scans the backlog (work_items:list) and claims an item it chose, re-ranking the frontier itself, or invents work — ignoring the scheduler / its claim spec.',
        ideal: 'Pulls the next item through scheduler:get_next (the brain-blessed, spec-and-floor-compliant lease), treating scheduling as the Mug\'s job and pickup as its own.',
      },
    },
    {
      id: 'respectsTheSpec',
      description:
        'Did the agent honor the spec/floor split — the Mug NARROWS+REORDERS via the spec (never re-asserting a floor) and the bee pulls under its CURRENT spec revision rather than overriding it?',
      anchors: {
        bad: 'Tries to widen past a global floor in the spec, re-decides eligibility the floors own, or the bee ignores its spec and pulls under its own ad-hoc ordering.',
        ideal: 'The spec only scopes+orders within the floors; the bee pulls under the latest revision and treats the spec as the steer.',
      },
    },
  ],
};

export const SCHEDULER_USE_RUBRIC_VERSION = deriveRubricVersion(
  'scheduler-use',
  SCHEDULER_USE_RUBRIC_CONTENT,
);

export const SCHEDULER_USE_RUBRIC: JudgeRubric = {
  version: SCHEDULER_USE_RUBRIC_VERSION,
  ...SCHEDULER_USE_RUBRIC_CONTENT,
};
