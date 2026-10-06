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
import { readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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

/**
 * A prompt a person (or launcher) actually submitted: a `user` record that is
 * not harness metadata (`isMeta`) and carries no `tool_result` block. Tool
 * results and meta records are also `type:'user'` rows, but they continue the
 * current turn rather than start one, so they must not reset the per-prompt
 * count (WI-10004645).
 */
function isSubmittedPrompt(record) {
  const role = record?.message?.role ?? record?.role;
  if (record?.type !== 'user' && role !== 'user') return false;
  if (role && role !== 'user') return false;
  if (record?.isMeta === true) return false;
  const content = record?.message?.content ?? record?.content;
  if (typeof content === 'string') return true;
  if (!Array.isArray(content)) return false;
  return !content.some((part) => part && part.type === 'tool_result');
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
  let assistantTurnsSinceLastPrompt = 0;

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
    if (isSubmittedPrompt(record)) {
      assistantTurnsSinceLastPrompt = 0;
      continue;
    }
    const text = assistantText(record);
    if (text === null) continue;
    assistantTurnsSinceLastPrompt += 1;
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
    assistantTurnsSinceLastPrompt,
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

/**
 * WI-10005612: a tracked FORK is a different CLI process with its own tool
 * surface. It runs headless instead of interactive, under its own deny list and
 * its own Papercusp seed. A `tool_reference` the source legitimately loaded
 * (measured: native `EndConversation`, earlier `WaitForMcpServers`) can
 * therefore be absent from the fork. The provider then rejects the fork's very
 * first request with "Tool reference '<name>' not found in available tools",
 * before the fork can answer anything. That made every source that ever ran a
 * tool search unforkable, so an acceptance-grading consult exhausted its
 * whole cascade.
 *
 * A reference only pre-loads a schema, so the fork's own seeded COPY of the
 * transcript drops them:
 * - inside a server tool-search result's `tool_references` array, entries are
 *   removed (an empty search result is a valid shape; a text block there is not);
 * - anywhere else in message content, a reference becomes a text marker.
 * The source session's own transcript is never touched.
 */
export function neutralizeClaudeToolReferences(jsonl, options = {}) {
  let rewritten = 0;
  const names = new Set();
  // Default: every reference (the fork seed). `nativeOnly` leaves Papercusp MCP
  // references in place — a RESUME restores those into the launch seed instead.
  const nativeOnly = options?.nativeOnly === true;
  const isReference = (value) =>
    value &&
    typeof value === 'object' &&
    value.type === 'tool_reference' &&
    typeof value.tool_name === 'string' &&
    (!nativeOnly || !PAPERCUSP_MCP_TOOL_PREFIX.test(value.tool_name));
  const visit = (value, key) => {
    if (Array.isArray(value)) {
      let changed = false;
      const out = [];
      for (const item of value) {
        if (isReference(item)) {
          rewritten += 1;
          names.add(item.tool_name);
          changed = true;
          if (key !== 'tool_references') {
            out.push({ type: 'text', text: `[tool reference ${item.tool_name} was loaded here before this session was ${nativeOnly ? 'resumed' : 'forked'}]` });
          }
          continue;
        }
        const next = visit(item, null);
        if (next !== item) changed = true;
        out.push(next);
      }
      return changed ? out : value;
    }
    if (!value || typeof value !== 'object') return value;
    let changed = false;
    const out = {};
    for (const [childKey, child] of Object.entries(value)) {
      const next = visit(child, childKey);
      if (next !== child) changed = true;
      out[childKey] = next;
    }
    return changed ? out : value;
  };
  const lines = String(jsonl ?? '').split('\n').map((line) => {
    if (!line.includes('"tool_reference"')) return line;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      return line;
    }
    if (!record || typeof record !== 'object' || !record.message || typeof record.message !== 'object') return line;
    const message = visit(record.message, 'message');
    return message === record.message ? line : JSON.stringify({ ...record, message });
  });
  return { text: lines.join('\n'), rewritten, toolNames: [...names] };
}

/**
 * Apply `neutralizeClaudeToolReferences` to every seeded `<sessionId>.jsonl`
 * under a fork's own `projects/` dir (one per encoded-cwd subdir). Unreadable
 * entries are skipped: the fork still gets the first-turn poison gate.
 */
export function neutralizeForkSeedToolReferences(projectsDir, sessionId, options = {}) {
  const result = { files: 0, rewritten: 0, toolNames: [] };
  if (!projectsDir || !sessionId) return result;
  let entries;
  try {
    entries = readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return result;
  }
  const names = new Set();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const out = neutralizeToolReferencesInFile(join(projectsDir, entry.name, `${sessionId}.jsonl`), options);
    if (out.rewritten === 0) continue;
    result.files += 1;
    result.rewritten += out.rewritten;
    for (const name of out.toolNames) names.add(name);
  }
  result.toolNames = [...names];
  return result;
}

/**
 * Rewrite ONE transcript file in place (temp file + rename, so a reader never
 * sees a half-written session). Unreadable/unparseable input is left alone.
 */
export function neutralizeToolReferencesInFile(file, options = {}) {
  const none = { rewritten: 0, toolNames: [] };
  if (!file) return none;
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return none;
  }
  const out = neutralizeClaudeToolReferences(text, options);
  if (out.rewritten === 0) return none;
  const tmp = `${file}.neutralize-${process.pid}.tmp`;
  try {
    writeFileSync(tmp, out.text);
    renameSync(tmp, file);
  } catch {
    return none;
  }
  return { rewritten: out.rewritten, toolNames: out.toolNames };
}

/**
 * Same-session RESUME (WI-10005612 only covered forks): the resumed CLI process
 * has its own tool surface, so a NATIVE deferred tool the earlier process loaded
 * through ToolSearch (measured: `ExitPlanMode`, `WaitForMcpServers`,
 * `EndConversation`) can be absent from it, and the provider then 400s the very
 * first replayed request — "Tool reference '<name>' not found in available
 * tools" — and the loop pauses (EI-24890753013901545). A reference only
 * pre-loads a schema, so drop the native ones before the process opens the
 * transcript. Papercusp MCP references stay: the launch seed restores those.
 * Call only while NO process holds the session (a resume spawn, not a live one).
 */
export function neutralizeResumeNativeToolReferences(projectsDir, sessionId) {
  return neutralizeForkSeedToolReferences(projectsDir, sessionId, { nativeOnly: true });
}

/** File-level form of {@link neutralizeResumeNativeToolReferences}. */
export function neutralizeResumeNativeToolReferencesInFile(file) {
  return neutralizeToolReferencesInFile(file, { nativeOnly: true });
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
