/**
 * GAIA suite barrel (plan `benchmark-suite-gaia-2026-06-17`). The broad general-assistant / research
 * dimension of the benchmark portfolio: GAIA ships no harness, so this module IS the agent + the grader.
 *
 *   - grader      → ../grader/gaia.ts   (quasi-exact-match question_scorer + per-level/overall aggregation)
 *   - dataset     → ./dataset.ts        (gated HF load, row schema, stratified subset, BenchTask mapping)
 *   - agent       → ./agent.ts          (pure ReAct loop; FINAL-ANSWER discipline; turn/budget guards)
 *   - tools-live  → ./tools-live.ts     (Brave web_search / fetch_url / run_python / read_file)
 *   - agent-live  → ./agent-live.ts     (Anthropic SDK → inference gateway; opus-4.8 @ xhigh)
 *   - run         → ./run.ts            (orchestrate → self-grade → predictions JSONL + report)
 *
 * Operate it via ./cli.ts (provision / selfcheck / pilot / run).
 */
export * from './dataset';
export * from './agent';
export * from './tools-live';
export * from './agent-live';
export * from './run';
export {
  gaiaQuestionScorer,
  extractFinalAnswer,
  gradeGaia,
  gradeGaiaTask,
  coerceLevel,
  type GaiaLevel,
  type GaiaPrediction,
  type GaiaReport,
  type GaiaTaskGrade,
  type GaiaLevelReport,
} from '../grader/gaia';
