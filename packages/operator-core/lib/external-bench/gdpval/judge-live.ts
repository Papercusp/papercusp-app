/**
 * The LIVE GDPval autograder judge (plan benchmark-suite-gdpval-2026-06-17, P-006) — binds the pure pairwise
 * grader's {@link JudgeFn} seam to a real LLM completion through OUR inference gateway (claude-opus-4-8, the
 * same fair-routing path the bees + GAIA arms use; the gateway paces + injects OAuth credentials).
 *
 * The judge is ONE completion per call (no tools, no extended thinking): it reasons briefly in its text output
 * and finishes with a `WINNER: A|B|TIE` line the pure grader parses. The dual-order position-bias mitigation
 * lives in grader/gdpval.ts (it calls this twice with swapped deliverables) — this binding just answers one
 * pairwise question. Only {@link makeLiveGdpvalJudge} touches the SDK; the prompt construction + verdict parse
 * are the pure, unit-tested grader. The hosted GDPval grading service is the same seam (a different JudgeFn).
 */
import Anthropic from '@anthropic-ai/sdk';
import { gatewayBaseUrl } from '../competitor-live';
import { ACCOUNT_HEADER, PRIORITY_HEADER } from '../../inference-gateway/gateway';
import { CLAUDE_CODE_IDENTITY } from '../gaia/agent-live';
import { GDPVAL_JUDGE_SYSTEM, buildJudgeUserPrompt, type JudgeFn } from '../grader/gdpval';

/** Fairness default: the judge runs claude-opus-4-8 via the gateway (matches the arms + competitor default). */
export const DEFAULT_GDPVAL_JUDGE_MODEL = 'claude-opus-4-8';

export interface LiveGdpvalJudgeConfig {
  /** Judge model (default claude-opus-4-8). Pin + record this in the grader version for pre-registration. */
  model?: string;
  /** Anthropic-compatible base url — default the inference gateway. Set null for the SDK default (direct). */
  baseUrl?: string | null;
  /** Env var the API key is read from (default ANTHROPIC_API_KEY; the gateway routes so any value works). */
  apiKeyEnv?: string;
  /** SDK max retries (default 12) — rides out gateway/account 429/529 bursts under fleet contention. */
  maxRetries?: number;
  /** Pin the judging account / set interactive priority on the gateway. */
  accountId?: string;
  priority?: string;
  /** Max tokens for the judgment (default 1536 — room for brief reasoning + the WINNER line). */
  maxTokens?: number;
  /** Prepend the Claude Code identity system block — REQUIRED on the Max-OAuth gateway (else a bogus 429). */
  claudeCodeIdentity?: boolean;
  /** Injected SDK client (tests pass a fake; production builds one from the config). */
  client?: Pick<Anthropic, 'messages'>;
}

/** Build the live pairwise judge {@link JudgeFn}. */
export function makeLiveGdpvalJudge(cfg: LiveGdpvalJudgeConfig = {}): JudgeFn {
  const model = cfg.model ?? DEFAULT_GDPVAL_JUDGE_MODEL;
  const baseURL = cfg.baseUrl === undefined ? gatewayBaseUrl() : (cfg.baseUrl ?? undefined);
  const apiKey = process.env[cfg.apiKeyEnv ?? 'ANTHROPIC_API_KEY'] ?? 'sk-gateway-routed';
  const throughGateway = baseURL !== undefined;
  const useIdentity = cfg.claudeCodeIdentity ?? throughGateway;
  const maxTokens = cfg.maxTokens ?? 1536;
  const client =
    cfg.client ??
    new Anthropic({
      apiKey,
      ...(baseURL ? { baseURL } : {}),
      maxRetries: cfg.maxRetries ?? 12,
      ...(cfg.accountId || cfg.priority || throughGateway
        ? {
            defaultHeaders: {
              ...(cfg.accountId ? { [ACCOUNT_HEADER]: cfg.accountId } : {}),
              [PRIORITY_HEADER]: cfg.priority ?? 'benchmark',
            },
          }
        : {}),
    });

  return async (req): Promise<string> => {
    // First system block MUST be the Claude Code identity on the Max-OAuth gateway (else a bogus 429).
    const system: Anthropic.MessageCreateParams['system'] = useIdentity
      ? [{ type: 'text', text: CLAUDE_CODE_IDENTITY }, { type: 'text', text: GDPVAL_JUDGE_SYSTEM }]
      : GDPVAL_JUDGE_SYSTEM;
    const params: Anthropic.MessageCreateParamsStreaming = {
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: buildJudgeUserPrompt(req) }],
      stream: true,
    };
    // STREAM + finalMessage (not create): consistent with the arms; tolerates a slow judgment without the
    // SDK's 10-minute non-streaming guard tripping.
    const res = await client.messages.stream(params).finalMessage();
    return res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
  };
}
