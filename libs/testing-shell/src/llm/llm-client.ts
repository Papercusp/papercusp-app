/**
 * Generic LLM-client helpers for the sim-user + judge.
 *
 * The concrete LLM transport (`llmCall`) is NOT defined here — it is an
 * injected seam (`LlmCallFn` in ./deps), because the real implementation is
 * host-specific (the operator routes through its `runAgentChat` + credentials).
 * This module holds only the host-agnostic pieces every consumer needs:
 * pricing, cost estimation, JSON recovery, and the call opts/result shapes.
 *
 * The operator's concrete `llmCall` (which imports its agent-chat-stream +
 * credentials) and `isLlmAvailable` (which reads operator credentials) stay
 * operator-side and are injected into the runner via `RunnerDeps.llmCall`.
 */

// =============================================================================
// Pricing — re-exported from the canonical table in @papercusp/model-pricing
// (cross-backend-cost-capture D-005: ONE price table; this module previously
// carried its own copy, which drifted — opus 4.x list price is $5/$25, not
// $15/$75). Vendor-prefixed ids ('openai-codex/gpt-5.5:xhigh') still resolve:
// the canonical `priceFor` normalizes them to bare ids.
// =============================================================================

export { MODEL_PRICES, estimateCost } from '@papercusp/model-pricing';
export type { ModelPrice } from '@papercusp/model-pricing';

// =============================================================================
// One-shot completion shapes. The concrete implementation is injected via
// `LlmCallFn` (see ./deps) — a host wires its own transport.
// =============================================================================

export interface LlmCallOpts {
  model: string;
  system?: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  maxTokens?: number;
  temperature?: number;
  responseFormat?: 'text' | 'json';
  /**
   * Extended-thinking budget (tokens). A host backend may thread this to the
   * provider's thinking budget. Needed by a frozen Opus judge ("extra-high
   * thinking"). Note: thinking and `temperature` are typically mutually
   * exclusive on the provider API; the host backend decides how to reconcile.
   */
  thinkingBudgetTokens?: number;
  /** Abort the host transport when an outer cycle/test timeout fires. */
  signal?: AbortSignal;
  /**
   * Priority/role label for the host transport's inference-gateway admission
   * tier (e.g. 'scout', 'queen', 'bee'). The operator host attaches it as the
   * `x-papercusp-priority` header on the in-process anthropic-direct call so the
   * pacing gateway tiers it correctly instead of dropping it in the lowest
   * default band; omit for an untiered call. Ignored by hosts with no gateway.
   */
  priority?: string;
  /**
   * WI-2144763: the harness this call's spend belongs to. The operator host forwards it
   * as usage attribution so the resulting `source:'headers'` usage row carries
   * `harness_slug` instead of falling into the '(unattributed)' bucket. Pass it whenever
   * the caller genuinely knows the harness (a scout/gym cycle does — it takes
   * `harnessSlug` as a first-class parameter); omit it for workspace-global work, since
   * an honest NULL beats a guessed slug. Ignored by hosts that record no usage.
   */
  harnessSlug?: string;
  /**
   * Cap (ms) on the ADMISSION wait — how long the host's shared rate-limit governor may
   * block this call waiting for a permit, BEFORE the request is issued. Omit to inherit
   * the host default.
   *
   * A caller with a bounded outer budget (a cycle timeout, a request deadline) should pass
   * the time it actually has LEFT. Otherwise the inner admission wait can equal or exceed
   * the caller's whole budget, and the caller's own timer will guillotine a call that was
   * correctly waiting for capacity — surfacing as a bogus transport "timeout" with $0 spent
   * (WI-4475). Ignored by hosts with no governor.
   */
  governorMaxWaitMs?: number;
  /**
   * ABSOLUTE epoch-ms deadline for the host transport's transient-retry ladder (WI-5391,
   * the WI-4475 class). `governorMaxWaitMs` bounds ONE admission wait; a host's retry
   * ladder (multiple attempts + backoff sleeps) is otherwise deadline-blind and can
   * outlive a bounded caller's own timer — which then mislabels an honest capacity error
   * (429/529) as the caller's generic timeout. With this set, the host stops retrying
   * before any backoff that would cross the deadline and surfaces the last classified
   * transport error instead. Omit for the host's default patient ladder. Ignored by
   * hosts without a retry ladder.
   */
  retryDeadlineMs?: number;
  /**
   * Fired when the host's LOCAL governor admits the call — immediately before the HTTP
   * request is issued — and again on each retry attempt.
   *
   * This does NOT prove upstream generation began: the HTTP request may itself enter an
   * inference-gateway admission queue. Use {@link onResponseStart} for the generation-phase
   * boundary. Ignored by hosts with no governor.
   */
  onAdmitted?: () => void;
  /**
   * Fired when the transport receives response headers / its first stream event, after every
   * local AND gateway admission layer. This is the safe boundary for starting a generation
   * timer: `onAdmitted` can fire while the request still has minutes of gateway queueing left.
   * Re-fired on a retry attempt that reaches a response. Ignored by transports that cannot
   * expose response start.
   */
  onResponseStart?: () => void;
  /** Stable caller identity for inference-gateway owner attribution. */
  ownerId?: string;
}

export interface LlmCallResult {
  text: string;
  json?: unknown;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  /** Provider terminal reason when available (`end_turn`, `max_tokens`, …). */
  stopReason?: string | null;
  /** Gateway account that actually served the request, when exposed by the
   * transport's `x-papercusp-routed-account` response header. */
  servedAccount?: string;
  raw: unknown;
}

export function tryParseJson(text: string): unknown {
  const trimmed = text.trim();
  // 1. Bare JSON, or JSON wrapped in ```json fences.
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  const candidate = fenced ? fenced[1] : trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    // fall through
  }
  // 2. Prose-wrapped JSON: take the outermost {...} span.
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try {
      return JSON.parse(trimmed.slice(first, last + 1));
    } catch {
      /* unrecoverable */
    }
  }
  return null;
}

/**
 * Legacy helper retained for any host caller that detects a model newly
 * rejecting the `temperature` parameter. Pure regex over the error message —
 * no host coupling.
 */
export function isTemperatureDeprecatedError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /temperature.{0,40}(deprecat|not supported|unsupported|no longer)/i.test(msg);
}
