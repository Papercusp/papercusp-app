/**
 * The Codex routing + usage-price rule that `llmCall` enforces, as a pure,
 * dependency-light module so WRITE-time seams can apply the exact same rule
 * (WI-10004526).
 *
 * `llmCall` sends a Codex-routed model to the Responses bridge only if
 * `@papercusp/model-pricing` can price it; otherwise it throws
 * `Codex model has no registered usage price`. In WI-10004502 the Scout was
 * configured with `gpt-5.4:medium`, which had no price, so every ideation call
 * failed — and nothing said so when the model was CONFIGURED, only three failed
 * cycles later when the Scout's error-streak alarm fired. The steering and
 * pot-override write paths use {@link unpricedCodexModel} to say so at write time.
 *
 * `llm-client.ts` imports the routing helpers from here (and re-exports them) so
 * the call-time rail and the write-time advisory cannot drift apart.
 */
import { priceFor } from '@papercusp/model-pricing';
import { normalizeCodexCliModel } from '../model-context-budget.mjs';

/** The model llmCall's Codex bridge uses (and prices) when the caller passes none. */
export const CODEX_LLM_DEFAULT_MODEL = 'gpt-5.5';

/** True when llmCall routes this spec to the Codex Responses bridge — the price-gated path. */
export function isCodexModel(model: string | undefined): boolean {
  const m = model?.trim().toLowerCase() ?? '';
  return /^(chatgpt:|gpt-|openai-codex\/)/.test(m);
}

/** Map a Codex-routed spec to the bare id the Codex bridge sends and prices (`chatgpt:5.5` → `gpt-5.5`). */
export function codexWireModel(model: string): string {
  const trimmed = model.trim();
  const chatgpt = /^chatgpt:(.+)$/i.exec(trimmed);
  if (chatgpt) return `gpt-${chatgpt[1]}`;
  const prefix = 'openai-codex/';
  if (trimmed.toLowerCase().startsWith(prefix)) return trimmed.slice(prefix.length);
  return trimmed;
}

/**
 * The Codex model id that would be refused for having no usage price, or null
 * when the spec is not Codex-routed or is priced. Papercusp's product aliases
 * (`sol` / `terra` / `luna`) are normalized first, as a Codex spawn does, so a
 * steering override written as an alias is judged by the model it launches.
 */
export function unpricedCodexModel(spec: string | null | undefined): string | null {
  const trimmed = spec?.trim();
  if (!trimmed) return null;
  const wire = codexWireModel(normalizeCodexCliModel(trimmed));
  if (!isCodexModel(wire)) return null;
  return priceFor(wire) ? null : wire;
}
