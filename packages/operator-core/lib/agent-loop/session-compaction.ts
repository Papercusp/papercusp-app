/**
 * session-compaction — bounded-growth compaction for loop sessions (P-009,
 * own-tui-full-divorce-2026-08-24).
 *
 * When a session's serialized ModelMessage working set exceeds the threshold,
 * the ELDER PREFIX is folded into a running text summary (one port call, no
 * tools) and only the recent suffix is kept for replay. The cut lands on a
 * CLEAN USER TURN (user role, text-only parts) so a tool_call and its
 * tool_result are never split across the boundary — providers reject a
 * tool_result whose call is missing.
 *
 * Degrades honestly: if the summarize call fails, the prefix is still dropped
 * (growth stays bounded — the invariant this module exists for) and the
 * summary records that a span went unsummarized, rather than silently
 * pretending coverage. The summarize call's own token usage is returned so
 * the caller can fold it into the turn's accounting instead of losing it.
 *
 * Wire-silent by design: compaction is server-side housekeeping; the D-011
 * v0 event vocabulary is not extended (the session row records the state).
 */
import type { ModelMessage, ModelPort, ModelUsage } from './model-port';

/** Compact when the serialized working set exceeds this many JSON chars
 *  (~60K tokens at 4 chars/token — well inside every supported context). */
export const COMPACT_THRESHOLD_CHARS = 240_000;

/** Messages the cut aims to keep for replay (more survive when no clean
 *  user turn falls in the window; fewer only when the tail is monstrous). */
export const COMPACT_KEEP_RECENT = 12;

/** Per-part render clamp + total render clamp for the summarizer's input. */
const RENDER_PART_MAX_CHARS = 1_200;
const RENDER_TOTAL_MAX_CHARS = 120_000;
const SUMMARY_MAX_TOKENS = 2_000;

export interface CompactSessionArgs {
  messages: ModelMessage[];
  priorSummary: string | null;
  /** Original messages the prior summary already covers. */
  priorCompactedCount: number;
  port: ModelPort;
  model: string;
  thresholdChars?: number;
  keepRecent?: number;
  signal?: AbortSignal;
  priority?: string;
  account?: string;
}

export interface CompactSessionResult {
  messages: ModelMessage[];
  summary: string | null;
  compactedCount: number;
  compacted: boolean;
  /** Usage of the summarize call, when one ran — fold into turn accounting. */
  summarizeUsage?: ModelUsage;
}

export function serializedChars(messages: ModelMessage[]): number {
  try {
    return (JSON.stringify(messages) ?? '[]').length;
  } catch {
    return Number.MAX_SAFE_INTEGER; // unserializable ⇒ certainly over budget
  }
}

/** A genuine user turn: user role, every part plain text (no tool_result). */
function isCleanUserTurn(m: ModelMessage): boolean {
  return m.role === 'user' && m.content.every((p) => p.type === 'text');
}

/**
 * Pick the cut index: everything BEFORE it is folded into the summary.
 * Largest clean-user-turn index ≤ len - keepRecent; if none, the largest
 * clean-user-turn index anywhere below len (keeps fewer than keepRecent).
 * 0 means "no safe cut" (the only clean user turn is the opening one).
 */
export function findCompactionCut(messages: ModelMessage[], keepRecent: number): number {
  const limit = messages.length - keepRecent;
  let best = 0;
  let bestAny = 0;
  for (let i = 1; i < messages.length; i++) {
    if (!isCleanUserTurn(messages[i])) continue;
    bestAny = i;
    if (i <= limit) best = i;
  }
  return best > 0 ? best : bestAny;
}

function clampText(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}… [+${s.length - max} chars]`;
}

/** Render messages as plain text for the summarizer (bounded). */
export function renderForSummary(messages: ModelMessage[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    for (const p of m.content) {
      if (p.type === 'text') {
        lines.push(`${m.role}: ${clampText(p.text, RENDER_PART_MAX_CHARS)}`);
      } else if (p.type === 'tool_call') {
        let input: string;
        try {
          input = JSON.stringify(p.input) ?? 'null';
        } catch {
          input = String(p.input);
        }
        lines.push(`assistant → tool_call ${p.name}(${clampText(input, RENDER_PART_MAX_CHARS)})`);
      } else {
        let content: string;
        try {
          content = typeof p.content === 'string' ? p.content : (JSON.stringify(p.content) ?? 'null');
        } catch {
          content = String(p.content);
        }
        lines.push(
          `tool_result${p.isError ? ' (ERROR)' : ''}: ${clampText(content, RENDER_PART_MAX_CHARS)}`,
        );
      }
    }
  }
  const rendered = lines.join('\n');
  if (rendered.length <= RENDER_TOTAL_MAX_CHARS) return rendered;
  // Tail-biased: the most recent elder context is the most load-bearing.
  return `[…earlier content elided]\n${rendered.slice(rendered.length - RENDER_TOTAL_MAX_CHARS)}`;
}

const SUMMARIZE_SYSTEM =
  'You compact agent-conversation history. Produce a dense, factual summary of the ' +
  'conversation excerpt you are given: user goals, what was done (tools run, files touched, ' +
  'results), decisions and their reasons, open threads and unresolved questions, and any ' +
  'constraints or preferences the user stated. Write plain prose/bullets. No preamble.';

async function summarize(args: {
  port: ModelPort;
  model: string;
  priorSummary: string | null;
  prefix: ModelMessage[];
  signal?: AbortSignal;
  priority?: string;
  account?: string;
}): Promise<{ text: string; usage?: ModelUsage }> {
  const sections: string[] = [];
  if (args.priorSummary) {
    sections.push(`## Existing summary of even earlier turns (fold this in)\n\n${args.priorSummary}`);
  }
  sections.push(`## Conversation excerpt to summarize\n\n${renderForSummary(args.prefix)}`);
  sections.push('Reply with the updated combined summary only.');

  let text = '';
  let usage: ModelUsage | undefined;
  let error: string | null = null;
  const stream = args.port.stream({
    model: args.model,
    system: SUMMARIZE_SYSTEM,
    messages: [{ role: 'user', content: [{ type: 'text', text: sections.join('\n\n') }] }],
    maxTokens: SUMMARY_MAX_TOKENS,
    ...(args.signal !== undefined ? { signal: args.signal } : {}),
    ...(args.priority !== undefined ? { priority: args.priority } : {}),
    ...(args.account !== undefined ? { account: args.account } : {}),
  });
  for await (const ev of stream) {
    if (ev.type === 'text_delta') text += ev.text;
    else if (ev.type === 'stop') usage = ev.usage;
    else if (ev.type === 'error') {
      error = ev.message;
      break;
    }
  }
  if (error || !text.trim()) {
    throw new Error(error ?? 'summarizer returned no text');
  }
  return { text: text.trim(), ...(usage !== undefined ? { usage } : {}) };
}

/**
 * Compact when over threshold. Never throws: the failure path still trims
 * (bounded growth is the invariant) and records the coverage gap in the
 * summary text instead.
 */
export async function maybeCompactSession(args: CompactSessionArgs): Promise<CompactSessionResult> {
  const threshold = args.thresholdChars ?? COMPACT_THRESHOLD_CHARS;
  const keepRecent = args.keepRecent ?? COMPACT_KEEP_RECENT;
  const noop: CompactSessionResult = {
    messages: args.messages,
    summary: args.priorSummary,
    compactedCount: args.priorCompactedCount,
    compacted: false,
  };
  if (serializedChars(args.messages) <= threshold) return noop;
  const cut = findCompactionCut(args.messages, keepRecent);
  if (cut <= 0) return noop; // only the opening user turn is clean — nothing safely foldable
  const prefix = args.messages.slice(0, cut);
  const kept = args.messages.slice(cut);
  const compactedCount = args.priorCompactedCount + prefix.length;
  try {
    const { text, usage } = await summarize({
      port: args.port,
      model: args.model,
      priorSummary: args.priorSummary,
      prefix,
      ...(args.signal !== undefined ? { signal: args.signal } : {}),
      ...(args.priority !== undefined ? { priority: args.priority } : {}),
      ...(args.account !== undefined ? { account: args.account } : {}),
    });
    return {
      messages: kept,
      summary: text,
      compactedCount,
      compacted: true,
      ...(usage !== undefined ? { summarizeUsage: usage } : {}),
    };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    const gapNote = `[compaction note: ${prefix.length} earlier message(s) dropped without a fresh summary — summarizer unavailable: ${reason}]`;
    return {
      messages: kept,
      summary: args.priorSummary ? `${args.priorSummary}\n\n${gapNote}` : gapNote,
      compactedCount,
      compacted: true,
    };
  }
}
