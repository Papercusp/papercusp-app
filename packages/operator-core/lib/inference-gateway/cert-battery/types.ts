/**
 * cert-battery/types — the shapes for the model certification battery
 * (local-concurrent-inference-2026-07-02 P-006, D-005).
 *
 * D-005: "The certified-model catalog is a HARNESS, not a list — codify the
 * behavior probes as a repeatable certification battery." This module defines the
 * config a battery certifies, the per-probe result shape, and the aggregate
 * report. The probes themselves (probes.ts) are DETERMINISTIC and INJECTABLE — the
 * eval-battery ethos (coordination-eval.ts D-002: "an LLM must never judge a number
 * you can count"). The only I/O is a single `chat()` port (an OpenAI /v1-compatible
 * completion against the served backend), so the whole battery is unit-testable with
 * a fake client and CI-stable.
 *
 * The battery's OUTPUT is a catalog entry with a locked config — it flips an entry in
 * provisioner/catalog.ts CERTIFIED_CATALOG from `provisional` to `certified`, never a
 * parallel catalog (per that module's explicit instruction).
 */
import type { LocalBackendKind } from '../local-backend-pool';

/** The (model, quant, num_ctx, parallel, backend) combo a battery run certifies — the
 *  "locked config" that becomes a catalog entry (D-005). */
export interface CertConfig {
  /** The OpenAI `/v1` model id the backend serves, e.g. 'maxwell1500/ornith-35b:IQ3_M'. */
  model: string;
  /** Quantization label, e.g. 'IQ3_M' (llama-server GGUF) or 'awq' (vLLM). */
  quant: string;
  /** TOTAL context across all parallel slots (llama-server `-c`), e.g. 180224. Per-slot ≈ numCtx/parallel. */
  numCtx: number;
  /** Parallel slots (llama-server `-np`), e.g. 2. */
  parallel: number;
  /** Which serving engine this config runs on. */
  backend: LocalBackendKind;
}

/** The four codified probes (D-005). */
export type ProbeId = 'behavior' | 'trimmed-shape' | 'comms' | 'mangling-rate';

// ---------------------------------------------------------------------------
// The single injected I/O port: an OpenAI /v1/chat/completions-shaped call.
// ---------------------------------------------------------------------------

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Present on role:'tool' replies (echoing a prior tool_call id). */
  tool_call_id?: string;
}

/** A JSON-schema tool parameter object (already SANITIZED for llama.cpp per D-011 —
 *  no pattern/format/additionalProperties/bounds; the sanitizer at :11435 strips those). */
export interface ToolParamSchema {
  type: 'object';
  properties?: Record<string, unknown>;
  required?: string[];
  [k: string]: unknown;
}

export interface ToolSchema {
  type: 'function';
  function: { name: string; description?: string; parameters: ToolParamSchema };
}

/** A tool call as the model emitted it — `arguments` is a RAW string (the model may
 *  mangle it into non-JSON, which is exactly what the mangling-rate metric counts). */
export interface RawToolCall {
  id?: string;
  type?: string;
  function: { name: string; arguments: string };
}

export interface ChatRequest {
  messages: ChatMessage[];
  tools?: ToolSchema[];
  maxTokens?: number;
  temperature?: number;
}

export interface ChatResult {
  /** Assistant text content ('' when the turn was a pure tool call). */
  text: string;
  /** Parsed tool calls the model emitted (empty when none). */
  toolCalls: RawToolCall[];
  /** OpenAI finish_reason ('stop' | 'tool_calls' | 'length' | ...), or null if absent. */
  stopReason: string | null;
}

/** The only side-effect surface the probes touch — injected so the battery is
 *  deterministic + unit-testable (fake `chat`) and the live run wires a real client. */
export interface ProbeContext {
  chat(req: ChatRequest): Promise<ChatResult>;
  /** Injected clock (ms) — keeps the report timestamp deterministic in tests. */
  now(): number;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/** Per-emission tool-call accounting that feeds the aggregate mangling-rate. */
export interface ToolCallStats {
  /** Tool-call emissions the probe elicited (the mangling denominator). */
  attempts: number;
  /** Emissions whose `arguments` did not parse as JSON — a mangled emission. */
  malformed: number;
  /** Emissions naming a tool that was not offered — a not-found emission. */
  notFound: number;
}

export interface ProbeResult {
  probe: ProbeId;
  passed: boolean;
  /** A failed CRITICAL probe fails the whole cert; a non-critical probe is a graded signal. */
  critical: boolean;
  /** Human-readable one-liner (what it checked + the outcome). */
  detail: string;
  /** Counted signals (never judged) — booleans/numbers/strings. */
  metrics: Record<string, number | boolean | string>;
  /** Tool-call accounting contributed to the aggregate mangling-rate (absent for probes
   *  that elicit no tool call, e.g. the behavior probe). */
  toolCallStats?: ToolCallStats;
}

export interface CertReport {
  config: CertConfig;
  probes: ProbeResult[];
  /** (Σ malformed + Σ notFound) / Σ attempts across every probe (0 when no tool attempts). */
  manglingRate: number;
  manglingDetail: ToolCallStats;
  /** 'certified' iff every CRITICAL probe passed AND manglingRate ≤ threshold. */
  verdict: 'certified' | 'failed';
  ranAt: string;
  /** One-line summary suitable for a coord/catalog note. */
  summary: string;
}

// ---------------------------------------------------------------------------
// Thresholds — module constants (NOT env feature-gates), the D-012 discipline:
// tuning knobs live in code, versioned + reviewable, never a runtime env toggle.
// ---------------------------------------------------------------------------

export const CERT_THRESHOLDS = {
  /** Max aggregate tool-name mangling rate a certified model may exhibit. Grounded in the
   *  session evidence D-005 cites: session-9697 (the healthy ornith run) sat far under this;
   *  session-9662 (a no-backoff tool-JSON storm — 125 errors / 4 not-found) blew well past it. */
  manglingRateMax: 0.25,
  /** Repetitions the dedicated mangling-rate probe fires, so the denominator is robust
   *  (a single blip is 1/N, not a coin-flip). */
  manglingRepetitions: 8,
  /** Bounded per-turn output cap — probes stay cheap and their pass/fail stays deterministic. */
  probeMaxTokens: 512,
} as const;
