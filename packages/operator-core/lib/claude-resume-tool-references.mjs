/**
 * Claude persists MCP `tool_reference` blocks in its transcript. A resumed
 * process must advertise those Papercusp tools again before Claude replays the
 * transcript; otherwise the provider rejects the request before the agent can
 * recover with tools:find.
 *
 * Shared by the interactive psu launcher and the detached await-wake resume
 * path. Keep this plain ESM so both launch surfaces use the same name and
 * transcript rules.
 */
import { readFileSync, statSync } from 'node:fs';

const PAPERCUSP_MCP_TOOL_PREFIX = /^mcp__papercusp(?:-su|_su)__/i;
const MISSING_TOOL_REFERENCE_RE =
  /^\s*API Error(?::\s*400|\s+400\b)[^\r\n]{0,300}\bTool reference\s+['"][^'"]+['"]\s+not found in available tools\b/im;

export const CLAUDE_TOOL_REFERENCE_POISON_TURNS = 3;
/**
 * WI-10003466: a LIVE session whose last two assistant turns were both the
 * provider's unavailable-tool-reference rejection cannot take another turn on
 * its own (the rejected reference is in its saved transcript, so every request
 * replays it). Two — not one — because a single rejection can land while the
 * client is mid-reconnect and clear on the next turn; two consecutive turns
 * prove it persists. This is the carry-respawn RECOVERY threshold; the
 * quarantine threshold above stays the last resort when no host can recover it.
 */
export const CLAUDE_TOOL_REFERENCE_RECOVERY_TURNS = 2;
export const MAX_CLAUDE_RESUME_TOOL_REFERENCES = 32;
const MAX_TRANSCRIPT_CACHE_ENTRIES = 256;
const transcriptCache = new Map();

/** True only for the provider's exact unavailable-deferred-tool failure. */
export function isMissingClaudeToolReferenceError(text) {
  return missingClaudeToolReferenceEvidence(text) !== null;
}

/** Bounded exact evidence shared by the exit classifier and poison detector. */
export function missingClaudeToolReferenceEvidence(text) {
  if (typeof text !== 'string') return null;
  const match = MISSING_TOOL_REFERENCE_RE.exec(text);
  return match ? match[0].trim().slice(0, 200) : null;
}

function collectPapercuspToolReferences(value, found) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) collectPapercuspToolReferences(item, found);
    return;
  }
  const record = value;
  if (
    record.type === 'tool_reference' &&
    typeof record.tool_name === 'string' &&
    PAPERCUSP_MCP_TOOL_PREFIX.test(record.tool_name)
  ) {
    found.delete(record.tool_name);
    found.set(record.tool_name, true);
  }
  for (const child of Object.values(record)) collectPapercuspToolReferences(child, found);
}

function rememberMissingToolReference(text, found) {
  if (typeof text !== 'string') return;
  const match = /\bTool reference\s+['"]([^'"]+)['"]\s+not found in available tools\b/i.exec(text);
  const name = match?.[1];
  if (name && PAPERCUSP_MCP_TOOL_PREFIX.test(name)) {
    found.delete(name);
    found.set(name, true);
  }
}

/**
 * Claude records a provider rejection as a SYNTHETIC assistant entry —
 * `isApiErrorMessage:true` with `message.model:'<synthetic>'` (measured on live
 * transcripts, 2026-09-27) — never as model output. Only that structure counts
 * toward a poison streak: an agent whose own prose QUOTES the error (while
 * diagnosing exactly this failure) must not be counted as poisoned, which would
 * quarantine or respawn a healthy session (the WI-4608 false-death class).
 */
function isSyntheticApiErrorRecord(record) {
  return record?.isApiErrorMessage === true || record?.message?.model === '<synthetic>';
}

function missingToolReferenceName(text) {
  if (typeof text !== 'string') return null;
  const match = /\bTool reference\s+['"]([^'"]+)['"]\s+not found in available tools\b/i.exec(text);
  return match?.[1] ?? null;
}

function assistantText(record) {
  const role = record?.message?.role ?? record?.role;
  if (record?.type !== 'assistant' && role !== 'assistant') return null;
  if (role && role !== 'assistant') return null;
  const content = record?.message?.content ?? record?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n');
}

/**
 * Scan Claude JSONL once for recent Papercusp references and the trailing
 * streak of exact missing-reference assistant turns. References are returned
 * most-recent-first and capped so a long transcript cannot inflate every
 * resumed prompt into the full catalog.
 */
export function analyzeClaudeResumeTranscript(jsonl, options = {}) {
  const maxReferences = Number.isInteger(options.maxReferences) && options.maxReferences >= 0
    ? options.maxReferences
    : MAX_CLAUDE_RESUME_TOOL_REFERENCES;
  const references = new Map();
  let trailingMissingToolReferenceTurns = 0;
  let lastMissingToolReferenceEvidence = null;
  let lastMissingToolReferenceName = null;

  for (const line of String(jsonl ?? '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      // A partial/corrupt row cannot prove a reference or assistant turn.
      continue;
    }

    collectPapercuspToolReferences(record, references);
    const text = assistantText(record);
    if (text === null) continue;
    // Structure first (WI-10003466): prose that merely quotes the rejection is an
    // ordinary assistant turn and resets the streak like any other.
    const synthetic = isSyntheticApiErrorRecord(record);
    if (synthetic) rememberMissingToolReference(text, references);
    const evidence = synthetic ? missingClaudeToolReferenceEvidence(text) : null;
    trailingMissingToolReferenceTurns = evidence ? trailingMissingToolReferenceTurns + 1 : 0;
    lastMissingToolReferenceEvidence = evidence;
    lastMissingToolReferenceName = evidence ? missingToolReferenceName(evidence) : null;
  }

  const toolReferences = maxReferences === 0
    ? []
    : [...references.keys()].slice(-maxReferences).reverse();
  return {
    toolReferences,
    trailingMissingToolReferenceTurns,
    lastMissingToolReferenceEvidence,
    lastMissingToolReferenceName,
    needsFreshContext: trailingMissingToolReferenceTurns >= CLAUDE_TOOL_REFERENCE_RECOVERY_TURNS,
    poisoned: trailingMissingToolReferenceTurns >= CLAUDE_TOOL_REFERENCE_POISON_TURNS,
  };
}

/** Read and cache diagnostics by file size + mtime; a busy inbox-wake session
 * is scanned once per transcript version rather than once per message. */
export function analyzeClaudeResumeTranscriptFile(filePath, options = {}) {
  if (typeof filePath !== 'string' || !filePath) return null;
  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) return null;
    const key = `${filePath}\0${stat.size}\0${stat.mtimeMs}`;
    const cached = transcriptCache.get(key);
    if (cached) {
      transcriptCache.delete(key);
      transcriptCache.set(key, cached);
      return cached;
    }
    const analysis = analyzeClaudeResumeTranscript(readFileSync(filePath, 'utf8'), options);
    transcriptCache.set(key, analysis);
    while (transcriptCache.size > MAX_TRANSCRIPT_CACHE_ENTRIES) {
      transcriptCache.delete(transcriptCache.keys().next().value);
    }
    return analysis;
  } catch {
    return null;
  }
}

/** Test seam for the bounded process-local transcript cache. */
export function __resetClaudeResumeTranscriptCacheForTests() {
  transcriptCache.clear();
}

/** Append client-mangled names without changing the existing seed or order. */
export function appendClaudeToolReferencesToSeed(seed, references) {
  const names = String(seed ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  const seen = new Set(names.map((name) => name.toLowerCase()));
  for (const reference of references ?? []) {
    if (typeof reference !== 'string' || !PAPERCUSP_MCP_TOOL_PREFIX.test(reference)) continue;
    const name = reference.trim();
    const key = name.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      names.push(name);
    }
  }
  return names.join(',');
}
