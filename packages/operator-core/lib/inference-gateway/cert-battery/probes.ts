/**
 * cert-battery/probes — the four codified certification probes (D-005), each a pure,
 * DETERMINISTIC check over a single injected `chat()` port. No probe judges quality with
 * an LLM; every verdict is COUNTED (coordination-eval.ts D-002 ethos). This is the
 * codification of the ad-hoc live probe sessions the plan ran by hand
 * (ornith-behavior-probe / ornith-comms-probe / ornith-2agent-comms-probe / the
 * mangling-storm sessions 9662 vs 9697) into a repeatable battery any
 * (model, quant, num_ctx, parallel, backend) combo runs through.
 *
 *   behavior       — does the model follow a bounded, read-only, shaped instruction
 *                    without drifting? (single-agent behavior)
 *   trimmed-shape  — given a trimmed tier's sanitized tool schema, does it emit a VALID
 *                    tool call with the required args? (the tools-on-demand seed shape)
 *   comms          — produce → handoff → consume: does a producer emit a structured
 *                    handoff a consumer can parse + echo? (the 2-agent coordination path)
 *   mangling-rate  — over K repeated tool emissions, what fraction are malformed JSON or
 *                    name a non-existent tool? (the metric that separated the healthy
 *                    ornith session from the tool-JSON storm)
 */
import { tryParseJson } from '@papercusp/eval-battery';
import { CERT_THRESHOLDS, type ChatResult, type ProbeContext, type ProbeResult, type ToolSchema } from './types';

// ---------------------------------------------------------------------------
// Fixed probe tools — small, realistic, already in the SANITIZED shape a trimmed
// llama.cpp session sees (no pattern/format/bounds; the :11435 sanitizer strips those).
// ---------------------------------------------------------------------------

const EMIT_FINDING: ToolSchema = {
  type: 'function',
  function: {
    name: 'emit_finding',
    description: 'Report a single structured finding. Call this exactly once.',
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'One-line summary of the finding.' },
        count: { type: 'number', description: 'A whole number the task specifies.' },
      },
      required: ['summary', 'count'],
    },
  },
};

const HANDOFF: ToolSchema = {
  type: 'function',
  function: {
    name: 'handoff',
    description: 'Hand a work token to the next agent. Call this exactly once.',
    parameters: {
      type: 'object',
      properties: {
        token: { type: 'string', description: 'The exact token you were given.' },
        note: { type: 'string', description: 'One line for the next agent.' },
      },
      required: ['token', 'note'],
    },
  },
};

const CONSUME: ToolSchema = {
  type: 'function',
  function: {
    name: 'consume',
    description: 'Acknowledge a handed-off token. Call this exactly once.',
    parameters: {
      type: 'object',
      properties: { token: { type: 'string', description: 'Echo the token from the handoff.' } },
      required: ['token'],
    },
  },
};

// ---------------------------------------------------------------------------
// Shared classification — the ONE place a tool-call emission is judged mangled.
// ---------------------------------------------------------------------------

/** Parse a tool call's raw `arguments` string to an object, or null if unparseable/non-object. */
export function parseToolArgs(raw: string): Record<string, unknown> | null {
  const parsed = tryParseJson(raw);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
}

/** Classify the FIRST tool call in a result against the offered tool names. `emitted` is false
 *  when the model produced no tool call at all (a compliance miss, not a mangle — tracked
 *  separately so it never inflates the mangling denominator). */
export function classifyFirstToolCall(
  result: ChatResult,
  offered: readonly string[],
): { emitted: boolean; name: string | null; notFound: boolean; malformed: boolean; args: Record<string, unknown> | null } {
  const call = result.toolCalls[0];
  if (!call) return { emitted: false, name: null, notFound: false, malformed: false, args: null };
  const name = call.function.name;
  const notFound = !offered.includes(name);
  const args = parseToolArgs(call.function.arguments);
  return { emitted: true, name, notFound, malformed: args === null, args };
}

const MAX = CERT_THRESHOLDS.probeMaxTokens;

// ---------------------------------------------------------------------------
// Probe 1 — behavior (single-agent bounded instruction-following, no tools).
// ---------------------------------------------------------------------------

export async function behaviorProbe(ctx: ProbeContext): Promise<ProbeResult> {
  const items = ['alpha', 'bravo', 'charlie'];
  const result = await ctx.chat({
    messages: [
      {
        role: 'system',
        content: 'You are a precise extraction agent. Reply with ONLY a JSON object, no prose, no code fences.',
      },
      {
        role: 'user',
        content: `Here is a list: ${items.join(', ')}. Reply with exactly {"count": <number of items>, "first": "<the first item>"}.`,
      },
    ],
    maxTokens: MAX,
    temperature: 0,
  });

  const parsed = tryParseJson(result.text) as { count?: unknown; first?: unknown } | null;
  const parsedOk = parsed !== null && typeof parsed === 'object';
  const countCorrect = parsedOk && parsed.count === items.length;
  const firstCorrect = parsedOk && parsed.first === items[0];
  // Drift guard: a compliant reply is a tiny JSON object; a rambling one blows past this.
  const boundedOutput = result.text.length <= 200;
  const passed = Boolean(parsedOk && countCorrect && firstCorrect && boundedOutput);

  return {
    probe: 'behavior',
    passed,
    critical: true,
    detail: passed
      ? 'followed a bounded extraction instruction; emitted exact JSON shape'
      : `instruction-following miss (parsed=${parsedOk} count=${countCorrect} first=${firstCorrect} bounded=${boundedOutput})`,
    metrics: {
      parsedJson: parsedOk,
      countCorrect: Boolean(countCorrect),
      firstCorrect: Boolean(firstCorrect),
      boundedOutput,
      outputChars: result.text.length,
      stopReason: result.stopReason ?? 'none',
    },
  };
}

// ---------------------------------------------------------------------------
// Probe 2 — trimmed-shape (emit a valid tool call against a sanitized schema).
// ---------------------------------------------------------------------------

export async function trimmedShapeProbe(ctx: ProbeContext): Promise<ProbeResult> {
  const result = await ctx.chat({
    messages: [
      { role: 'system', content: 'You have one tool. Use it — do not answer in prose.' },
      { role: 'user', content: 'Call emit_finding with summary "battery probe" and count 7.' },
    ],
    tools: [EMIT_FINDING],
    maxTokens: MAX,
    temperature: 0,
  });

  const c = classifyFirstToolCall(result, ['emit_finding']);
  const nameCorrect = c.name === 'emit_finding';
  const hasRequired = c.args !== null && typeof c.args.summary === 'string' && typeof c.args.count === 'number';
  const passed = c.emitted && nameCorrect && !c.malformed && hasRequired;

  return {
    probe: 'trimmed-shape',
    passed,
    critical: true,
    detail: passed
      ? 'emitted a valid emit_finding tool call with the required args from a sanitized schema'
      : `tool-call fidelity miss (emitted=${c.emitted} name=${c.name ?? 'none'} malformed=${c.malformed} requiredArgs=${hasRequired})`,
    metrics: {
      emittedToolCall: c.emitted,
      nameCorrect,
      argsParseable: !c.malformed && c.emitted,
      requiredFieldsPresent: hasRequired,
    },
    toolCallStats: {
      attempts: c.emitted ? 1 : 0,
      malformed: c.emitted && c.malformed ? 1 : 0,
      notFound: c.emitted && c.notFound ? 1 : 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Probe 3 — comms (produce → handoff → consume across two turns of the same model).
// A codified, repeatable proxy for the live 2-agent coordination the plan ran by hand:
// the producer emits a structured handoff carrying a token; the consumer must parse it
// and echo the SAME token back — the round-trip the coordination path depends on.
// ---------------------------------------------------------------------------

export async function commsProbe(ctx: ProbeContext): Promise<ProbeResult> {
  const token = 'ORN-7F3A';

  const produced = await ctx.chat({
    messages: [
      { role: 'system', content: 'You are the producer. Hand off using the handoff tool only.' },
      { role: 'user', content: `Your work token is ${token}. Hand it off with a one-line note.` },
    ],
    tools: [HANDOFF],
    maxTokens: MAX,
    temperature: 0,
  });
  const p = classifyFirstToolCall(produced, ['handoff']);
  const producedToken = p.args && typeof p.args.token === 'string' ? (p.args.token as string) : null;
  const producerOk = p.emitted && p.name === 'handoff' && !p.malformed && producedToken === token;

  const consumed = await ctx.chat({
    messages: [
      { role: 'system', content: 'You are the consumer. Acknowledge using the consume tool only.' },
      {
        role: 'user',
        content: `The previous agent handed off this JSON: ${JSON.stringify({ token: producedToken ?? token, note: 'proceed' })}. Consume it, echoing the token.`,
      },
    ],
    tools: [CONSUME],
    maxTokens: MAX,
    temperature: 0,
  });
  const cc = classifyFirstToolCall(consumed, ['consume']);
  const consumedToken = cc.args && typeof cc.args.token === 'string' ? (cc.args.token as string) : null;
  const consumerOk = cc.emitted && cc.name === 'consume' && !cc.malformed && consumedToken === token;

  const roundTripOk = producerOk && consumerOk;

  return {
    probe: 'comms',
    passed: roundTripOk,
    critical: true,
    detail: roundTripOk
      ? 'producer handed off a token the consumer parsed and echoed (round-trip ok)'
      : `handoff round-trip miss (producerOk=${producerOk} consumerOk=${consumerOk} echoed=${consumedToken ?? 'none'})`,
    metrics: {
      producerEmittedHandoff: p.emitted && p.name === 'handoff',
      producerTokenCorrect: producedToken === token,
      consumerEmittedConsume: cc.emitted && cc.name === 'consume',
      consumerEchoedToken: consumedToken === token,
      roundTripOk,
    },
    toolCallStats: {
      attempts: (p.emitted ? 1 : 0) + (cc.emitted ? 1 : 0),
      malformed: (p.emitted && p.malformed ? 1 : 0) + (cc.emitted && cc.malformed ? 1 : 0),
      notFound: (p.emitted && p.notFound ? 1 : 0) + (cc.emitted && cc.notFound ? 1 : 0),
    },
  };
}

// ---------------------------------------------------------------------------
// Probe 4 — mangling-rate (K repeated tool emissions; count garbled ones).
// Non-critical: it is a graded quality signal folded into the aggregate the verdict
// gates on, not a per-run pass/fail. The denominator is EMISSIONS (of what it tried to
// emit, how much was mangled), so a model that emits nothing scores rate 0 here but
// fails the critical trimmed-shape/comms probes — never a false certify.
// ---------------------------------------------------------------------------

export async function manglingRateProbe(
  ctx: ProbeContext,
  reps: number = CERT_THRESHOLDS.manglingRepetitions,
): Promise<ProbeResult> {
  let attempts = 0;
  let malformed = 0;
  let notFound = 0;
  let noEmit = 0;

  for (let i = 0; i < reps; i++) {
    const result = await ctx.chat({
      messages: [
        { role: 'system', content: 'You have one tool. Use it — do not answer in prose.' },
        { role: 'user', content: `Call emit_finding with summary "rep ${i}" and count ${i}.` },
      ],
      tools: [EMIT_FINDING],
      maxTokens: MAX,
      temperature: 0,
    });
    const c = classifyFirstToolCall(result, ['emit_finding']);
    if (!c.emitted) {
      noEmit += 1;
      continue;
    }
    attempts += 1;
    if (c.malformed) malformed += 1;
    if (c.notFound) notFound += 1;
  }

  const rate = attempts > 0 ? (malformed + notFound) / attempts : 0;
  const passed = rate <= CERT_THRESHOLDS.manglingRateMax;

  return {
    probe: 'mangling-rate',
    passed,
    critical: false,
    detail: `mangling rate ${(rate * 100).toFixed(1)}% over ${attempts}/${reps} emissions (malformed=${malformed} notFound=${notFound} noEmit=${noEmit}); threshold ${(CERT_THRESHOLDS.manglingRateMax * 100).toFixed(0)}%`,
    metrics: { reps, emissions: attempts, malformed, notFound, noEmit, rate },
    toolCallStats: { attempts, malformed, notFound },
  };
}

/** The four probes in run order. `mangling-rate` last so its K reps warm nothing the
 *  critical probes depend on. */
export const CERT_PROBES = [behaviorProbe, trimmedShapeProbe, commsProbe, manglingRateProbe] as const;
