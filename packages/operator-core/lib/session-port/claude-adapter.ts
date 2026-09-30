import type {
  ClaudeAdaptResult,
  PortableBlock,
  PortableRole,
  PortableTurn,
} from './types';

type Json = Record<string, any>;

const textOf = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

export const CLAUDE_SESSION_PORT_ADAPTER_VERSION = 1;
const MAX_TOOL_NARRATIVE_CHARS = 16_000;
const MAX_TEXT_ATTACHMENT_BYTES = 64 * 1024;

function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean; originalBytes: number } {
  const originalBytes = Buffer.byteLength(text, 'utf8');
  if (originalBytes <= maxBytes) return { text, truncated: false, originalBytes };
  let bytes = 0;
  let end = 0;
  for (const char of text) {
    const charBytes = Buffer.byteLength(char, 'utf8');
    if (bytes + charBytes > maxBytes) break;
    bytes += charBytes;
    end += char.length;
  }
  return { text: text.slice(0, end), truncated: true, originalBytes };
}

const boundedText = (value: unknown): { text: string; truncated: boolean } => {
  const text = textOf(value);
  if (text.length <= MAX_TOOL_NARRATIVE_CHARS) return { text, truncated: false };
  return {
    text: `${text.slice(0, MAX_TOOL_NARRATIVE_CHARS)}\n[tool narrative truncated]`,
    truncated: true,
  };
};

type ToolRelations = { next: number; sourceToLocal: Map<string, string> };

function textAttachment(value: Json): {
  text: string;
  name: string | null;
  mediaType: string | null;
} | null {
  const source = value?.source && typeof value.source === 'object' ? value.source : null;
  const mediaTypeRaw = value?.media_type ?? value?.mime_type ?? source?.media_type ?? source?.mime_type;
  const mediaType = typeof mediaTypeRaw === 'string' && mediaTypeRaw.trim() ? mediaTypeRaw.trim() : null;
  const sourceType = String(source?.type ?? '').toLowerCase();
  const textualMedia = mediaType != null && /^(?:text\/|application\/(?:json|xml|javascript|x-yaml))/i.test(mediaType);
  const explicitTextField = typeof value?.text === 'string';
  const candidate =
    typeof value?.text === 'string' ? value.text
      : typeof value?.content === 'string' ? value.content
        : source && typeof source.data === 'string' && ['text', 'plain_text'].includes(sourceType) ? source.data
          : null;
  if (
    candidate == null ||
    (!explicitTextField && !textualMedia && !['text', 'plain_text'].includes(sourceType))
  ) return null;
  const nameRaw = value?.name ?? value?.file_name ?? value?.filename ?? source?.name;
  return {
    text: candidate,
    name: typeof nameRaw === 'string' && nameRaw.trim() ? nameRaw.trim() : null,
    mediaType,
  };
}

function roleOf(record: Json): PortableRole {
  const role = String(record?.message?.role ?? record?.role ?? record?.type ?? '').toLowerCase();
  if (role === 'assistant') return 'assistant';
  if (role === 'system') return 'system';
  if (role === 'tool') return 'tool';
  return 'user';
}

function blocksOf(
  record: Json,
  stats: ClaudeAdaptResult['stats'],
  relations: ToolRelations,
): PortableBlock[] {
  const content = record?.message?.content ?? record?.content;
  const values = Array.isArray(content) ? content : content == null ? [] : [content];
  const blocks: PortableBlock[] = [];
  for (const value of values) {
    if (typeof value === 'string') {
      if (value) blocks.push({ type: 'text', text: value });
      continue;
    }
    const kind = String(value?.type ?? 'unknown');
    if (kind === 'text' || kind === 'summary') {
      const text = textOf(value.text ?? value.summary);
      if (text) blocks.push({ type: 'text', text });
      if (value?.signature != null) stats.omittedSignatureBlocks++;
    } else if (kind === 'thinking' || kind === 'redacted_thinking') {
      stats.omittedThinkingBlocks++;
      if (value?.signature != null) stats.omittedSignatureBlocks++;
      blocks.push({ type: 'omission', reason: 'provider-thinking', sourceType: kind });
    } else if (kind === 'signature') {
      stats.omittedSignatureBlocks++;
      blocks.push({ type: 'omission', reason: 'provider-signature', sourceType: kind });
    } else if (kind === 'tool_use') {
      stats.toolCalls++;
      const sourceId = typeof value.id === 'string' && value.id ? value.id : null;
      const relationId = `tool-${++relations.next}`;
      if (sourceId) relations.sourceToLocal.set(sourceId, relationId);
      const content = boundedText(value.input ?? null);
      if (content.truncated) stats.truncatedToolNarratives++;
      blocks.push({
        type: 'tool_narrative',
        event: 'call',
        relationId,
        name: String(value.name ?? 'unknown'),
        content: content.text,
      });
    } else if (kind === 'tool_result') {
      stats.toolResults++;
      const sourceId = typeof value.tool_use_id === 'string' ? value.tool_use_id : null;
      const relationId = sourceId ? relations.sourceToLocal.get(sourceId) ?? null : null;
      if (!relationId) stats.unlinkedToolResults++;
      const content = boundedText(value.content);
      if (content.truncated) stats.truncatedToolNarratives++;
      blocks.push({
        type: 'tool_narrative',
        event: 'result',
        relationId,
        name: 'prior tool',
        content: content.text,
        isError: value.is_error === true || value.isError === true,
      });
    } else if (kind === 'image' || kind === 'document' || kind === 'attachment' || kind === 'file') {
      const attachment = kind === 'image' ? null : textAttachment(value);
      if (attachment) {
        const bounded = truncateUtf8(attachment.text, MAX_TEXT_ATTACHMENT_BYTES);
        stats.textAttachments++;
        if (bounded.truncated) stats.truncatedAttachments++;
        blocks.push({
          type: 'text_attachment',
          name: attachment.name,
          mediaType: attachment.mediaType,
          text: bounded.text,
          originalBytes: bounded.originalBytes,
          truncated: bounded.truncated,
        });
      } else {
        stats.omittedAttachments++;
        blocks.push({ type: 'omission', reason: 'binary-attachment', sourceType: kind });
      }
    } else {
      stats.unsupportedBlocks++;
      blocks.push({ type: 'omission', reason: 'unsupported-content', sourceType: kind });
    }
  }
  return blocks;
}

/**
 * Reconstruct Claude's active parent-linked path. JSONL append order is not a
 * conversation order: retries and sidechains coexist in the file. We choose
 * the newest non-sidechain conversational leaf, follow parentUuid, and then
 * cut summarized ancestors at the newest isCompactSummary record so the port
 * never sends both a summary and the history it already represents.
 */
export function adaptClaudeJsonl(jsonl: string): ClaudeAdaptResult {
  const stats: ClaudeAdaptResult['stats'] = {
    sourceRecords: 0,
    activePathRecords: 0,
    malformedRecords: 0,
    sidechainRecords: 0,
    compactedAncestors: 0,
    toolCalls: 0,
    toolResults: 0,
    unlinkedToolResults: 0,
    truncatedToolNarratives: 0,
    omittedAttachments: 0,
    textAttachments: 0,
    truncatedAttachments: 0,
    omittedThinkingBlocks: 0,
    omittedSignatureBlocks: 0,
    unsupportedBlocks: 0,
    syntheticRecords: 0,
    redactions: 0,
    controlBytesRemoved: 0,
    delimiterEscapes: 0,
  };
  const warnings: string[] = [];
  const records: Array<Json & { __line: number }> = [];
  for (const [index, line] of String(jsonl).split('\n').entries()) {
    if (!line.trim()) continue;
    stats.sourceRecords++;
    try {
      const record = JSON.parse(line) as Json;
      records.push({ ...record, __line: index });
      if (record.isSidechain === true) stats.sidechainRecords++;
    } catch {
      stats.malformedRecords++;
    }
  }

  const nodes = new Map<string, Json & { __line: number }>();
  for (const record of records) {
    if (record.uuid) {
      const id = String(record.uuid);
      if (nodes.has(id)) throw new Error(`ambiguous Claude transcript graph: duplicate uuid ${id}`);
      nodes.set(id, record);
    }
  }
  const candidates = records.filter(
    (record) =>
      record.uuid &&
      record.isSidechain !== true &&
      (record.type === 'user' || record.type === 'assistant' || record.message?.role),
  );
  const leaf = candidates.at(-1) ?? null;
  const reversed: Array<Json & { __line: number }> = [];
  const visited = new Set<string>();
  let cursor = leaf;
  while (cursor?.uuid) {
    const id = String(cursor.uuid);
    if (visited.has(id)) {
      throw new Error(`unrecoverable Claude transcript graph: cycle detected at ${id}`);
    }
    visited.add(id);
    reversed.push(cursor);
    const parentRaw = cursor.parentUuid ?? cursor.logicalParentUuid;
    const parent = parentRaw == null ? null : String(parentRaw);
    if (!parent) break;
    const next = nodes.get(parent) ?? null;
    if (!next) {
      warnings.push(`missing parent ${parent} for ${id}; path starts at the earliest available record`);
      break;
    }
    cursor = next;
  }
  let path = reversed.reverse();
  let compactIndex = -1;
  for (let index = path.length - 1; index >= 0; index--) {
    if (path[index].isCompactSummary === true) { compactIndex = index; break; }
  }
  if (compactIndex > 0) {
    stats.compactedAncestors = compactIndex;
    path = path.slice(compactIndex);
  }
  stats.activePathRecords = path.length;

  const material = path.filter((record) => {
    const type = String(record.type ?? '').toLowerCase();
    const hasMessage = record.message?.role || record.message?.content != null || record.content != null;
    if (!hasMessage || ['queue-operation', 'progress', 'file-history-snapshot', 'system'].includes(type)) {
      stats.syntheticRecords++;
      return false;
    }
    return true;
  });
  stats.activePathRecords = material.length;
  const relations: ToolRelations = { next: 0, sourceToLocal: new Map() };
  const turns: PortableTurn[] = material.map((record) => ({
    id: String(record.uuid),
    parentId: record.parentUuid == null ? null : String(record.parentUuid),
    role: roleOf(record),
    timestamp: typeof record.timestamp === 'string' ? record.timestamp : null,
    blocks: blocksOf(record, stats, relations),
    ...(record.isCompactSummary === true ? { compactSummary: true } : {}),
  }));

  if (stats.malformedRecords) warnings.push(`${stats.malformedRecords} malformed JSONL record(s) omitted`);
  if (stats.sidechainRecords) warnings.push(`${stats.sidechainRecords} sidechain record(s) excluded from the active path`);
  if (stats.omittedAttachments) warnings.push(`${stats.omittedAttachments} binary attachment(s) represented as omissions`);
  if (stats.textAttachments) warnings.push(`${stats.textAttachments} text attachment(s) preserved as inert text`);
  if (stats.truncatedAttachments) warnings.push(`${stats.truncatedAttachments} text attachment(s) truncated with byte disclosure`);
  if (stats.truncatedToolNarratives) warnings.push(`${stats.truncatedToolNarratives} tool narrative(s) truncated with an inline marker`);
  if (stats.omittedThinkingBlocks) warnings.push(`${stats.omittedThinkingBlocks} provider thinking block(s) omitted`);
  if (stats.omittedSignatureBlocks) warnings.push(`${stats.omittedSignatureBlocks} provider signature block(s) omitted`);
  if (stats.unlinkedToolResults) warnings.push(`${stats.unlinkedToolResults} tool result(s) lacked a local call relationship`);
  if (stats.unsupportedBlocks) warnings.push(`${stats.unsupportedBlocks} unsupported content block(s) represented as omissions`);
  if (stats.syntheticRecords) warnings.push(`${stats.syntheticRecords} synthetic bookkeeping record(s) excluded`);
  const contentRecords = material.length;
  if (records.length > 0 && contentRecords === 0) {
    throw new Error('Claude transcript format drift: no material user/assistant records found');
  }
  if (stats.unsupportedBlocks > Math.max(8, contentRecords * 2)) {
    throw new Error('Claude transcript format drift: unsupported content dominates the active path');
  }
  return { turns, stats, warnings, activeLeafId: leaf?.uuid ? String(leaf.uuid) : null };
}
