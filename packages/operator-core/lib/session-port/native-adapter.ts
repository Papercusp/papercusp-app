import { adaptClaudeJsonl } from './claude-adapter';
import { blockPayloadText, codexToolCallArgsRaw } from '../transcript-wire';
import type { ClaudeAdaptResult, SessionBackend } from './types';

type RecordValue = Record<string, any>;
export const NATIVE_SESSION_PORT_ADAPTER_VERSION = 1;

function recordsOf(jsonl: string): RecordValue[] {
  return jsonl.split('\n').filter((line) => line.trim()).map((line, index) => {
    try {
      const record = JSON.parse(line);
      if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('not an object');
      return { ...record, __line: index };
    } catch {
      // A fixed-high-water source already excludes partial trailing records.
      // Losing an interior record could silently change the evidence/branch.
      throw new Error(`native session-port source has a malformed record at line ${index + 1}`);
    }
  });
}

function contentBlocks(content: unknown): RecordValue[] {
  const values = Array.isArray(content) ? content : content == null ? [] : [content];
  return values.map((value) => {
    if (typeof value === 'string') return { type: 'text', text: value };
    if (!value || typeof value !== 'object') return { type: 'unknown' };
    const block = value as RecordValue;
    if (['input_text', 'output_text', 'text'].includes(block.type)) return { type: 'text', text: block.text };
    if (['input_image', 'output_image', 'image'].includes(block.type)) return { type: 'image' };
    if (block.type === 'toolCall') return { type: 'tool_use', id: block.id, name: block.name, input: block.arguments };
    if (block.type === 'thinking') return { type: 'thinking', signature: block.thinkingSignature };
    return block;
  });
}

function toolOutput(content: unknown): string {
  // Never copy binary payloads into a historical tool narrative.
  return Array.isArray(content)
    ? content.map((block) => typeof block === 'string' ? block
      : typeof block?.text === 'string' ? block.text : `[${block?.type ?? 'structured block'} omitted]`).join('\n')
    : blockPayloadText(content);
}

function materialize(records: RecordValue[], sourceRecords: number): ClaudeAdaptResult {
  if (!records.some((record) => record.message)) throw new Error('native session-port source has no material conversation');
  const adapted = adaptClaudeJsonl(records.map((record) => JSON.stringify(record)).join('\n'));
  adapted.stats.sourceRecords = sourceRecords;
  return adapted;
}

/** Reuse the portable block/relationship renderer; only native wire and active
 * history selection differ. Provider ids and executable calls never cross it. */
export function adaptCodexJsonl(jsonl: string, nativeSessionId: string): ClaudeAdaptResult {
  const source = recordsOf(jsonl);
  const headers = source.filter((record) => record.type === 'session_meta');
  if (!headers.length || headers.some((record) => record.payload?.id !== nativeSessionId)) {
    throw new Error('Codex session-port source does not match the exact native session identity');
  }
  let normalized: RecordValue[] = [];
  let parent: string | null = null;
  const state: { lastVisible: { key: string; wire: string } | null } = { lastVisible: null };
  let serial = 0;
  const append = (role: string, content: unknown, timestamp: unknown, compactSummary = false) => {
    const uuid = `codex-${++serial}`;
    normalized.push({ uuid, parentUuid: parent, type: role === 'assistant' ? 'assistant' : 'user',
      timestamp, message: { role, content }, ...(compactSummary ? { isCompactSummary: true } : {}) });
    parent = uuid;
  };
  const response = (payload: RecordValue, timestamp: unknown, compactSummary = false) => {
    if (payload.type === 'message') {
      if (!['user', 'assistant', 'developer', 'system'].includes(payload.role)) throw new Error('unsupported Codex message role');
      const content = contentBlocks(payload.content);
      const key = `${payload.role}\0${JSON.stringify(content)}`;
      if (!compactSummary && state.lastVisible?.key === key && state.lastVisible.wire === 'event_msg') {
        state.lastVisible = { key, wire: 'response_item' };
        return;
      }
      state.lastVisible = { key, wire: 'response_item' };
      append(payload.role === 'developer' ? 'system' : payload.role, content, timestamp, compactSummary);
    } else if (['function_call', 'custom_tool_call', 'tool_search_call'].includes(payload.type)) {
      append('assistant', [{ type: 'tool_use', id: payload.call_id,
        name: `${payload.namespace ? `${payload.namespace}.` : ''}${payload.name ?? payload.type}`,
        input: codexToolCallArgsRaw(payload) }], timestamp);
    } else if (['function_call_output', 'custom_tool_call_output', 'tool_search_output'].includes(payload.type)) {
      const output = payload.type === 'tool_search_output'
        ? (Array.isArray(payload.tools) ? payload.tools.map((tool: RecordValue) => tool.name).filter(Boolean).join(', ') : '')
        : toolOutput(payload.output);
      append('tool', [{ type: 'tool_result', tool_use_id: payload.call_id, content: output, is_error: payload.is_error }], timestamp);
    } else if (payload.type === 'reasoning') {
      append('assistant', [{ type: 'thinking', signature: payload.encrypted_content }], timestamp);
    } else {
      throw new Error(`unsupported Codex response item ${String(payload.type)}`);
    }
  };
  for (const record of source) {
    const payload = record.payload ?? {};
    if (record.type === 'response_item') response(payload, record.timestamp);
    else if (record.type === 'event_msg' && ['user_message', 'agent_message'].includes(payload.type)) {
      const role = payload.type === 'user_message' ? 'user' : 'assistant';
      const content = contentBlocks(payload.message);
      const key = `${role}\0${JSON.stringify(content)}`;
      if (state.lastVisible?.key === key && state.lastVisible.wire === 'response_item') continue;
      state.lastVisible = { key, wire: 'event_msg' };
      append(role, content, record.timestamp);
    } else if (record.type === 'compacted') {
      normalized = [];
      parent = null;
      state.lastVisible = null;
      if (Array.isArray(payload.replacement_history) && payload.replacement_history.length) {
        payload.replacement_history.forEach((item: RecordValue, index: number) => response(item, record.timestamp, index === 0));
      } else if (typeof payload.message === 'string' && payload.message.trim()) {
        append('user', [{ type: 'text', text: payload.message }], record.timestamp, true);
      } else throw new Error('Codex compaction has no portable replacement history');
    }
  }
  return materialize(normalized, source.length);
}

export function adaptOmpJsonl(jsonl: string, nativeSessionId: string): ClaudeAdaptResult {
  const source = recordsOf(jsonl);
  const headers = source.filter((record) => record.type === 'session');
  if (!headers.length || headers.some((record) => record.id !== nativeSessionId)) {
    throw new Error('OMP session-port source does not match the exact native session identity');
  }
  const entries = source.filter((record) => record.type !== 'session' && typeof record.id === 'string');
  const byId = new Map<string, RecordValue>();
  for (const entry of entries) {
    if (byId.has(entry.id)) throw new Error('ambiguous OMP transcript graph: duplicate id');
    byId.set(entry.id, entry);
  }
  const path: RecordValue[] = [];
  const seen = new Set<string>();
  let cursor = entries.at(-1);
  while (cursor) {
    if (seen.has(cursor.id)) throw new Error('unrecoverable OMP transcript graph: cycle');
    seen.add(cursor.id);
    path.unshift(cursor);
    if (cursor.parentId == null) break;
    const parent = byId.get(cursor.parentId);
    if (!parent) throw new Error('OMP transcript graph has a missing parent');
    cursor = parent;
  }
  let compactIndex = -1;
  for (let index = path.length - 1; index >= 0; index--) {
    if (path[index]?.type === 'compaction') { compactIndex = index; break; }
  }
  let active = path;
  if (compactIndex >= 0) {
    const compact = path[compactIndex]!;
    const keptIndex = path.findIndex((entry) => entry.id === compact.firstKeptEntryId);
    if (typeof compact.summary !== 'string' || !compact.summary.trim() || keptIndex < 0 || keptIndex >= compactIndex) {
      throw new Error('OMP compaction has no exact portable summary/tail');
    }
    active = [compact, ...path.slice(keptIndex, compactIndex), ...path.slice(compactIndex + 1)];
  }
  let parent: string | null = null;
  const normalized = active.filter((entry) => ['message', 'compaction'].includes(entry.type)).map((entry) => {
    const compact = entry.type === 'compaction';
    const message = compact ? { role: 'user', content: [{ type: 'text', text: entry.summary }] } : entry.message;
    if (!message || !['user', 'assistant', 'toolResult', 'system'].includes(message.role)) throw new Error('unsupported OMP message role');
    const role = message.role === 'toolResult' ? 'tool' : message.role;
    const content = role === 'tool'
      ? [{ type: 'tool_result', tool_use_id: message.toolCallId, content: toolOutput(message.content), is_error: message.isError }]
      : contentBlocks(message.content);
    const record = { uuid: entry.id, parentUuid: parent, type: role === 'assistant' ? 'assistant' : 'user',
      timestamp: entry.timestamp, message: { role, content }, ...(compact ? { isCompactSummary: true } : {}) };
    parent = entry.id;
    return record;
  });
  const adapted = materialize(normalized, source.length);
  adapted.stats.sidechainRecords = entries.length - path.length;
  adapted.stats.compactedAncestors = compactIndex >= 0 ? compactIndex : 0;
  return adapted;
}

export function adaptNativeSessionJsonl(backend: SessionBackend, jsonl: string, nativeSessionId: string): ClaudeAdaptResult {
  if (backend === 'claude') return adaptClaudeJsonl(jsonl);
  return backend === 'codex' ? adaptCodexJsonl(jsonl, nativeSessionId) : adaptOmpJsonl(jsonl, nativeSessionId);
}
