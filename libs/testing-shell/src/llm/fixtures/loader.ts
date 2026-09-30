/**
 * Fixture loader — read a stored `.sse` event tape back into a
 * `TurnResult` so the judge can re-evaluate without burning a fresh
 * SUT call.
 *
 * Plan §9.1 replay verbs:
 *   `pnpm llm-test replay --fixture <path> --scenario <id>`
 *
 * The .sse files are exactly the wire format `OperatorTarget` already
 * produces during a live run, so we reuse the same parser shape here.
 * A fixture file represents ONE SUT turn (one POST → SSE stream). For
 * multi-turn scenarios the runner would pass multiple files; the
 * loader returns an array.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  TOOL_RESULT_EVIDENCE_MAX_CHARS,
  TOOL_RESULT_EVIDENCE_MAX_EVENTS,
  type SseEvent,
  type TurnResult,
  type CardEvent,
  type ControlTag,
  type ToolCallEvent,
  type ToolResultEvent,
} from '../types';

export function loadFixtureTurn(filePath: string): TurnResult {
  const text = readFileSync(filePath, 'utf8');
  const events = parseSseTape(text);
  const turn = assembleTurn(events);
  const normalized = readNormalizedTranscript(filePath);
  return normalized?.length === 1 ? mergeNormalizedTurn(turn, normalized[0]) : turn;
}

export interface FixtureTelemetry {
  toolInvocations: Array<{ name: string; metadata_json?: Record<string, unknown> }>;
  continueChainRows: Array<{ ts: string; trigger: string; secondsSinceChainStart: number; chainTurnCount: number }>;
}

/**
 * Load the sibling `.telemetry.json` for a fixture, if present.
 *
 * Fixtures are SSE-only by default; the framework's writer
 * (exportFixtureFromRun) emits a paired `.telemetry.json` so the
 * replay path can re-evaluate deterministic asserts that read
 * tool_invocations / operator_continue_chains. Returns null when the
 * sibling is absent (back-compat: older fixtures keep working,
 * telemetry-dependent asserts just under-report).
 */
export function loadFixtureTelemetry(sseFilePath: string): FixtureTelemetry | null {
  const telemetryPath = sseFilePath.replace(/\.sse$/, '.telemetry.json');
  if (!existsSync(telemetryPath)) return null;
  try {
    const text = readFileSync(telemetryPath, 'utf8');
    const parsed = JSON.parse(text) as FixtureTelemetry;
    if (!Array.isArray(parsed.toolInvocations)) parsed.toolInvocations = [];
    if (!Array.isArray(parsed.continueChainRows)) parsed.continueChainRows = [];
    return parsed;
  } catch {
    return null;
  }
}

export function loadFixtureTurns(filePaths: string[]): TurnResult[] {
  return filePaths.map((p) => loadFixtureTurn(p));
}

/**
 * Load an exported normalized transcript sidecar when one exists. The sidecar
 * preserves sim-user evidence and turn boundaries that a flattened SSE tape
 * cannot carry. Missing/invalid sidecars are a normal back-compat case.
 */
export function loadFixtureTranscript(filePath: string): TurnResult[] | null {
  const normalized = readNormalizedTranscript(filePath);
  if (!normalized || normalized.length === 0) return null;

  if (normalized.length === 1) {
    const turn = assembleTurn(parseSseTape(readFileSync(filePath, 'utf8')));
    return [mergeNormalizedTurn(turn, normalized[0])];
  }
  return normalized.map((value) => normalizedToTurn(value)).filter((t): t is TurnResult => t !== null);
}

/**
 * Resolve a fixture id (e.g. `v8-baseline/02-multistep-list-then-summarize`)
 * to its absolute `.sse` path under `fixtures/operator/`. Accepts ids
 * with or without the `.sse` suffix.
 */
export function resolveFixturePath(fixtureId: string): string {
  const here = resolve(import.meta.dirname);
  const id = fixtureId.endsWith('.sse') ? fixtureId : `${fixtureId}.sse`;
  return resolve(here, 'operator', id);
}

// =============================================================================
// SSE parsing — mirrors OperatorTarget's readSse but reads from a string
// =============================================================================

function parseSseTape(text: string): SseEvent[] {
  const events: SseEvent[] = [];
  const blocks = text.split(/\n\n+/);
  let tMs = 0;
  for (const block of blocks) {
    if (!block.trim()) continue;
    const parsed = parseSseBlock(block);
    if (!parsed) continue;
    parsed.tMs = tMs;
    tMs += 1; // synthetic monotonic offset; real timing isn't in the tape
    events.push(parsed);
  }
  return events;
}

function parseSseBlock(block: string): SseEvent | null {
  let name = 'message';
  const dataLines: string[] = [];
  for (const line of block.split('\n')) {
    if (!line || line.startsWith(':') || line.startsWith('id:')) continue;
    if (line.startsWith('event:')) name = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0 && name === 'message') return null;
  const raw = dataLines.join('\n');
  let data: unknown = raw;
  try { data = JSON.parse(raw); } catch { /* keep raw */ }
  return { name, data, tMs: 0 };
}

// =============================================================================
// Turn assembly — replicates OperatorSession.applyEvent
// =============================================================================

function assembleTurn(events: SseEvent[]): TurnResult {
  const result: TurnResult = {
    assistantText: '',
    toolCalls: [],
    toolResults: [],
    cards: [],
    controlTags: [],
    costUsd: 0,
    latencyMs: 0,
    finishReason: 'done',
    rawSseTape: events,
  };
  for (const ev of events) {
    switch (ev.name) {
      case 'delta': {
        const text = extractDeltaText(ev.data);
        if (text) result.assistantText += text;
        break;
      }
      case 'tool_call': {
        const tc = ev.data as { name?: string; input?: unknown };
        if (tc?.name) {
          const event: ToolCallEvent = { name: tc.name, input: tc.input };
          result.toolCalls.push(event);
        }
        break;
      }
      case 'card':
      case 'state-snapshot': {
        const card = parseCardEvent(ev.data);
        if (card) result.cards.push(card);
        break;
      }
      case 'done': {
        const d = ev.data as { costUsd?: number } | undefined;
        if (d?.costUsd) result.costUsd = d.costUsd;
        result.finishReason = 'done';
        break;
      }
      case 'error': {
        const e = ev.data as { message?: string } | undefined;
        result.error = e?.message ?? 'unknown';
        result.finishReason = 'error';
        break;
      }
    }
  }
  result.controlTags = extractControlTags(result.assistantText);
  return result;
}

type NormalizedFixtureTurn = {
  assistantText?: unknown;
  toolCalls?: unknown;
  toolResults?: unknown;
  cards?: unknown;
  controlTags?: unknown;
  finishReason?: unknown;
  costUsd?: unknown;
  latencyMs?: unknown;
  error?: unknown;
  userText?: unknown;
  simThought?: unknown;
  simKind?: unknown;
};

function normalizedTranscriptPath(filePath: string): string {
  return filePath.replace(/\.sse$/, '.transcript.json');
}

function readNormalizedTranscript(filePath: string): NormalizedFixtureTurn[] | null {
  const transcriptPath = normalizedTranscriptPath(filePath);
  if (!existsSync(transcriptPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(transcriptPath, 'utf8')) as
      | NormalizedFixtureTurn[]
      | { turns?: unknown[] };
    const values = Array.isArray(parsed)
      ? parsed
      : parsed && Array.isArray(parsed.turns) ? parsed.turns : null;
    if (!values) return null;
    return values.filter((value): value is NormalizedFixtureTurn => !!value && typeof value === 'object');
  } catch {
    return null;
  }
}

function normalizedToTurn(value: NormalizedFixtureTurn): TurnResult | null {
  if (typeof value.assistantText !== 'string') return null;
  const turn: TurnResult = {
    assistantText: value.assistantText,
    toolCalls: Array.isArray(value.toolCalls) ? value.toolCalls as TurnResult['toolCalls'] : [],
    toolResults: normalizeToolResults(value.toolResults),
    cards: Array.isArray(value.cards) ? value.cards as TurnResult['cards'] : [],
    controlTags: Array.isArray(value.controlTags) ? value.controlTags as TurnResult['controlTags'] : [],
    costUsd: typeof value.costUsd === 'number' ? value.costUsd : 0,
    latencyMs: typeof value.latencyMs === 'number' ? value.latencyMs : 0,
    finishReason: value.finishReason === 'error' || value.finishReason === 'aborted' ||
      value.finishReason === 'budget' || value.finishReason === 'cap'
      ? value.finishReason
      : 'done',
    rawSseTape: [],
  };
  if (typeof value.error === 'string') turn.error = value.error;
  if (typeof value.userText === 'string') turn.userText = value.userText;
  if (typeof value.simThought === 'string') turn.simThought = value.simThought;
  if (value.simKind === 'text' || value.simKind === 'choice') turn.simKind = value.simKind;
  return turn;
}

function normalizeToolResults(value: unknown): ToolResultEvent[] {
  if (!Array.isArray(value)) return [];
  const results: ToolResultEvent[] = [];
  for (const raw of value.slice(0, TOOL_RESULT_EVIDENCE_MAX_EVENTS)) {
    if (!raw || typeof raw !== 'object') continue;
    const candidate = raw as Record<string, unknown>;
    if (typeof candidate.name !== 'string' || typeof candidate.output !== 'string') continue;
    const output = candidate.output.slice(0, TOOL_RESULT_EVIDENCE_MAX_CHARS);
    const sourceChars =
      typeof candidate.sourceChars === 'number' &&
      Number.isFinite(candidate.sourceChars) &&
      candidate.sourceChars >= 0
        ? Math.trunc(candidate.sourceChars)
        : candidate.output.length;
    results.push({
      name: candidate.name.slice(0, 200),
      output,
      isError: candidate.isError === true,
      truncated:
        candidate.truncated === true ||
        candidate.output.length > TOOL_RESULT_EVIDENCE_MAX_CHARS,
      sourceChars,
    });
  }
  return results;
}

function mergeNormalizedTurn(base: TurnResult, value: NormalizedFixtureTurn): TurnResult {
  const normalized = normalizedToTurn(value);
  if (!normalized) return base;
  return { ...base, ...normalized, rawSseTape: base.rawSseTape };
}

function extractDeltaText(data: unknown): string {
  if (typeof data === 'string') return data;
  if (data && typeof data === 'object') {
    const obj = data as { text?: unknown; delta?: unknown };
    if (typeof obj.text === 'string') return obj.text;
    if (typeof obj.delta === 'string') return obj.delta;
  }
  return '';
}

function parseCardEvent(data: unknown): CardEvent | null {
  if (!data || typeof data !== 'object') return null;
  const obj = data as Record<string, unknown>;
  const snapshot = obj.snapshot as { openCards?: unknown } | undefined;
  if (snapshot?.openCards && Array.isArray(snapshot.openCards)) {
    const c = snapshot.openCards[0] as Record<string, unknown> | undefined;
    if (!c) return null;
    return cardFromObj(c);
  }
  return cardFromObj(obj);
}

function cardFromObj(c: Record<string, unknown>): CardEvent | null {
  const kind = typeof c.kind === 'string'
    ? c.kind
    : typeof c.cardKind === 'string' ? (c.cardKind as string) : null;
  if (!kind) return null;
  const opts = Array.isArray(c.options) ? (c.options as Array<{ id?: unknown; label?: unknown }>) : undefined;
  const fallbackText = typeof c.fallbackText === 'string' ? (c.fallbackText as string) : undefined;
  return {
    kind,
    options: opts?.filter((o) => typeof o.id === 'string' && typeof o.label === 'string')
      .map((o) => ({ id: o.id as string, label: o.label as string })),
    voiceAnswerable: !!fallbackText,
    payload: c,
  };
}

function extractControlTags(text: string): ControlTag[] {
  const tags: ControlTag[] = [];
  const re = /<(continue|sleep|spawn)(\s+([^/>]*))?\/?>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const tag = m[1].toLowerCase() as ControlTag['tag'];
    const attrs: Record<string, string> = {};
    const attrStr = (m[3] ?? '').trim();
    if (attrStr) {
      for (const am of attrStr.matchAll(/(\w+)\s*=\s*"([^"]*)"/g)) {
        attrs[am[1]] = am[2];
      }
    }
    tags.push({ tag, attrs: Object.keys(attrs).length > 0 ? attrs : undefined });
  }
  return tags;
}
