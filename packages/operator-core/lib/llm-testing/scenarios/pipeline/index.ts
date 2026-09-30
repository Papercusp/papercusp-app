/**
 * Pipeline-role scenario registry (P-020 + P-030).
 *
 * Behavioral, judge-scored scenarios for the headless invoke-once pipeline roles
 * — driven by the PipelineTarget (../../pipeline), NOT the conversational runner.
 * Kept in their own registry (separate from the conversational `SCENARIOS`) so
 * the chat runner + lint never try to `open()/send()` a non-chat target.
 *
 * Live runs need model credentials (on-demand, like every LLM scenario); CI
 * coverage is the deterministic capture-mechanics + registry-validity test in
 * ../../__tests__/pipeline-target.test.ts.
 */
import type { PipelineScenario } from '@papercusp/testing-shell/llm';
import { PIPE_SCOPER_CHUNKING } from './PIPE-scoper-chunking';
import { PIPE_VALIDATOR_ACCEPTANCE } from './PIPE-validator-acceptance';
import { PIPE_REVIEWER_SHIP_RETURN } from './PIPE-reviewer-ship-return';
import { PIPE_REVIEWER_GATES_ON_TESTS } from './PIPE-reviewer-gates-on-tests';
import { PIPE_TESTWRITER_CREATES_TESTS } from './PIPE-testwriter-creates-tests';

export const PIPELINE_SCENARIOS: readonly PipelineScenario[] = [
  PIPE_SCOPER_CHUNKING, // P-020 scoper chunking
  PIPE_VALIDATOR_ACCEPTANCE, // P-020 + P-030 validator acceptance judgment
  PIPE_REVIEWER_SHIP_RETURN, // P-020 reviewer ship/return
  PIPE_REVIEWER_GATES_ON_TESTS, // P-030 reviewer gates on tests existing
  PIPE_TESTWRITER_CREATES_TESTS, // P-030 test-writer actually creates tests
];
