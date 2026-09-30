/**
 * Scout LLM model defaults and the per-blueprint override shape.
 *
 * Every active Scout phase shares the provider-neutral learning policy. The
 * composite spec is intentional: llm-testing's resolver selects Codex and the
 * Responses bridge separates `xhigh` from the bare model id.
 */
import { LEARNING_MODEL_SPEC } from '../learning/model-policy';

export const DEFAULT_SCOUT_IDEATOR_MODEL = LEARNING_MODEL_SPEC;
export const DEFAULT_SCOUT_CRITIC_MODEL = LEARNING_MODEL_SPEC;
export const DEFAULT_SCOUT_RECOMBINE_MODEL = LEARNING_MODEL_SPEC;
export const DEFAULT_SCOUT_REVISION_MODEL = LEARNING_MODEL_SPEC;
export const DEFAULT_SCOUT_EXPERIMENT_MODEL = LEARNING_MODEL_SPEC;

export interface ScoutModelConfig {
  ideator: string;
  critic: string;
  recombine: string;
  revision: string;
  experiment: string;
}

export const DEFAULT_SCOUT_MODELS: ScoutModelConfig = {
  ideator: DEFAULT_SCOUT_IDEATOR_MODEL,
  critic: DEFAULT_SCOUT_CRITIC_MODEL,
  recombine: DEFAULT_SCOUT_RECOMBINE_MODEL,
  revision: DEFAULT_SCOUT_REVISION_MODEL,
  experiment: DEFAULT_SCOUT_EXPERIMENT_MODEL,
};
