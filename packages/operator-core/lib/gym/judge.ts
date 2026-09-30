/**
 * The frozen judge runner moved into the shared eval-battery engine (reconciliation
 * D-001 — one engine, the gym is the `HarnessSubject`). This thin re-export keeps the
 * gym's modules + the (still-live) apiary importing `../gym/judge` working
 * byte-identically; the canonical home is `@papercusp/eval-battery`.
 *
 * `judgeGymRun` / `GymScore` / `GymJudgeInput` are re-exported as aliases of the
 * engine's subject-neutral `judgeBatteryRun` / `BatteryScore` / `JudgeInput`.
 */
export {
  buildJudgePrompt,
  judgeBatteryRun as judgeGymRun,
  type JudgeLlmCall,
  type JudgeInput as GymJudgeInput,
  type BatteryScore as GymScore,
} from '@papercusp/eval-battery';
