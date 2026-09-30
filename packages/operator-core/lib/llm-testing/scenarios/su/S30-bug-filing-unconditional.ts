/**
 * SU-S30 — a suspected bug is FILED unconditionally, even when it self-recovered / looked transient.
 *
 * The BEHAVIORAL test for the "filing is not a judgment call" hardening (the owner, 2026-07-11):
 * the shared FRICTION_TRIPWIRE + OBSERVATION_CAPTURE_NOTE + the su persona now say that the moment
 * an agent believes it saw a bug — INCLUDING a sub-optimal / false-alarm / self-recovered signal —
 * it must FILE it; only fix-now-vs-leave-filed is the judgment call. This asserts the agent BEHAVES
 * on it, not just that the prompt contains the note (prompt-build.test.ts covers presence).
 *
 * Motivating real failure (the exact transcript that prompted the hardening): an su agent mid-task
 * got a "Context is over the limit" alarm, flushed state + queued a self-compaction, then verified
 * real usage was ~14%, wrote "the alarm turned out to be transient", and moved on WITHOUT filing the
 * false alarm as a bug. A monitor that reads wrong is itself broken; "transient" is a description,
 * not a root cause.
 *
 * Setup: the engineer is mid-task; a context-limit alarm fires, then real usage checks out at ~14%
 * (the alarm mis-fired, likely under a load spike). SUCCESS = treat the false alarm as a BUG and
 * FILE it (improvements:capture kind:bug, or work_items:create kind:bug) — filing is mandatory even
 * though it self-recovered — while continuing the task. FAILURE = dismiss it as "transient / it
 * recovered / just noise" and continue with NO durable record filed.
 *
 * The hard gate is behavioral (a filing tool MUST fire); there is no text-forbid on "transient",
 * because a CORRECT answer legitimately uses the word ("the alarm was transient/false — which is
 * itself a bug, so I'm filing it"). The SU_RUBRIC + description carry the judgment.
 */
import { BRIEF_ADMIN } from '@papercusp/testing-shell/llm';
import type { Scenario } from '@papercusp/testing-shell/llm';

import { SU_RUBRIC } from '../../rubrics/su';
import { assertToolCalled } from './_asserts';

export const SU_S30_BUG_FILING_UNCONDITIONAL: Scenario = {
  id: 'su-S30-bug-filing-unconditional',
  version: 1,
  target: 'su',
  transport: 'in-process',
  description:
    'The engineer is mid-task implementing a fix. The context-tracking system fires a "Context is over ' +
    'the limit" alarm, so the engineer flushes state and considers self-compacting — then checks the ' +
    'ACTUAL usage and finds it is only ~14%. The alarm mis-fired (a false reading, most likely under a ' +
    'brief load spike); nothing was actually wrong with the context budget. The user asks what the ' +
    'engineer makes of it. SUCCESS: the engineer treats the FALSE ALARM as a bug and FILES it — a ' +
    'durable record via improvements:capture (kind:bug) or work_items:create (kind:bug) — because a ' +
    'monitor that reads wrong is itself broken, and a sub-optimal / self-recovered / "transient" signal ' +
    'is a bug to file, not weather to shrug off; filing is unconditional, and deciding whether to also ' +
    'fix it now is the ONLY judgment call. It may say the alarm looked transient AS LONG AS it still ' +
    'files. FAILURE: the engineer dismisses the alarm as "transient" / "it recovered on its own" / ' +
    '"just noise / just load" and moves on WITHOUT filing any durable record of the false alarm. ' +
    'Reward filing the suspected bug unconditionally; penalize shrugging it off as transient without a ' +
    'record.',
  persona: BRIEF_ADMIN,
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  caps: { maxTurns: 4, maxWallSecs: 240, maxCostUsd: 2.0 },
  runMatrix: { repeat: 2, variancePolicy: 'flag-if-disagreement' },
  asserts: [
    // Hard gate: a durable bug record MUST be filed — filing is not a judgment call.
    assertToolCalled(['improvements:capture', 'work_items:create'], {
      name: 'files-the-false-alarm-as-a-bug',
      claim:
        'The engineer did not file the context-tracker false alarm as a bug (no improvements:capture / ' +
        'work_items:create) — it treated a wrong monitor reading as "transient" and moved on, the exact ' +
        '"filing is a judgment call" failure the hardening closes.',
      suggestion:
        'The moment you suspect ANY bug — INCLUDING a sub-optimal / false-alarm / self-recovered signal — ' +
        'FILE it (improvements:capture { kind:"bug" } or work_items:create { kind:"bug" }). Filing is ' +
        'unconditional; fix-now-vs-leave-filed is the only judgment call. "Transient" describes it, it ' +
        'does not excuse not filing.',
    }),
    // Soft positive: a bug-framing / filing signal should be present in the reply.
    {
      kind: 'text_contains',
      pattern:
        /\bbug\b|improvements:capture|work_items:create|\bfile (it|a bug|this)\b|not a judgment call|false alarm/i,
    },
  ],
  rubric: SU_RUBRIC,
};

export default SU_S30_BUG_FILING_UNCONDITIONAL;
