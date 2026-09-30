/**
 * omp session-file discovery, search, and state extraction.
 *
 * OMP stores every interactive session as JSONL under:
 *
 *   ~/.omp/agent/sessions/<cwd-encoded>/<timestamp>_<session-id>.jsonl
 *
 * The operator is on the same machine as OMP, so papercusp-su tools and the
 * /adv Sessions page can safely inspect those files directly. This module is
 * intentionally read-only and only serves files inside the OMP sessions root.
 */

import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { getOrgPg, generated } from '@papercusp/db-org';
import { eq } from 'drizzle-orm';
import { loadHarnessRegistry } from './harness-registry';

// Lazy (same pattern as sessionsRoot() below): this module must stay side-effect-free at
// import time — it's transitively reachable from the coordination message-send path
// (audience-host → fleet-roster → presence-wakeability → inbox-wake → events/await/engine
// → wake-executor → here), so a test that mocks '@papercusp/db-org' with only { getOrgPg }
// (never providing `generated`) threw `No "generated" export is defined on the mock` at
// import time even when it never calls lookupSpawnHints (EI-9152). Deferred to first use.
let _sa: typeof generated.spawnedAgentsInHarnessShared | null = null;
function sa(): typeof generated.spawnedAgentsInHarnessShared {
  return (_sa ??= generated.spawnedAgentsInHarnessShared);
}

// Lazy: this module is transitively bundled into the operator-vite renderer
// (via server-side agent-tools / endpoint routes), where `node:os` is a stub
// and a top-level `homedir()` call throws "homedir is not a function" on chunk
// load. Defer it so importing the module is side-effect-free.
let _sessionsRoot: string | null = null;
function sessionsRoot(): string {
  return (_sessionsRoot ??= join(homedir(), '.omp', 'agent', 'sessions'));
}

const DEFAULT_SESSION_LIMIT = 500;
const MAX_SESSION_LIMIT = 5000;
const DEFAULT_SEARCH_LIMIT = 50;
const MAX_SEARCH_LIMIT = 250;

export interface OmpSessionMeta {
  /** UUIDv7 session id minted by omp. */
  id: string;
  /** Absolute path to the .jsonl file. */
  filePath: string;
  /** Recorded cwd from the session header. */
  cwd: string;
  /** ISO timestamp from the session header. */
  timestamp: string;
  /** First title omp inferred (may be empty until the model picks one). */
  title: string;
  /** "exact-cwd" | "cwd-prefix" | "time-only" — drives caller confidence. */
  matchKind: 'exact-cwd' | 'cwd-prefix' | 'time-only';
  /** ms between the reference start time and this session's timestamp. */
  timeDriftMs: number;
}

export interface OmpSessionSummary {
  id: string;
  filePath: string;
  cwd: string;
  timestamp: string;
  title: string;
  titleSource?: string;
  sizeBytes: number;
  modifiedAt: string;
  lineCount: number;
}

export interface OmpSessionTurn {
  type: string;
  [k: string]: unknown;
}

export interface OmpTodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed' | 'abandoned';
  notes?: string[];
}

export interface OmpTodoPhase {
  name: string;
  tasks: OmpTodoItem[];
}

export interface OmpMessageSnippet {
  id?: string;
  timestamp?: string;
  role: string;
  toolName?: string;
  isError?: boolean;
  text: string;
}

export interface OmpToolSummary {
  toolName: string;
  calls: number;
  results: number;
  errors: number;
  lastUsedAt?: string;
}

export interface OmpSessionUsage {
  /** Aggregate input tokens across all assistant turns. */
  inputTokens: number;
  /** Aggregate output tokens across all assistant turns. */
  outputTokens: number;
  /** Aggregate cache-read tokens (tokens served from prompt cache). */
  cacheReadTokens: number;
  /** Aggregate cache-write tokens (tokens written to prompt cache). */
  cacheWriteTokens: number;
  /** Aggregate of all of the above. */
  totalTokens: number;
  /** Aggregate USD cost reported by OMP for this session. */
  totalCostUsd: number;
  /** Number of assistant turns that reported a usage block. */
  assistantTurnsWithUsage: number;
}

export interface OmpSessionState {
  header: SessionHeader;
  filePath: string;
  totalLines: number;
  countsByType: Record<string, number>;
  messages: {
    total: number;
    user: number;
    assistant: number;
    toolResults: number;
  };
  /** Distinct model ids used across assistant turns, in the order
   *  they were first seen — most sessions stay on one model the
   *  whole way through, but a model switch mid-session is allowed. */
  models: string[];
  /** Model used by the most recent assistant turn — null if none. */
  latestModel: string | null;
  /** Aggregate token + cost usage. Zeros when no assistant turn
   *  reported a usage block (e.g. transcript truncated). */
  usage: OmpSessionUsage;
  latestMessages: OmpMessageSnippet[];
  todos: OmpTodoPhase[];
  toolCounts: OmpToolSummary[];
  jobs: OmpMessageSnippet[];
  goals: OmpMessageSnippet[];
  compactions: OmpMessageSnippet[];
  handoffs: OmpMessageSnippet[];
}

export interface OmpSessionSearchMatch {
  session: OmpSessionSummary;
  line: number;
  entryId?: string;
  timestamp?: string;
  type: string;
  role?: string;
  toolName?: string;
  snippet: string;
  contextBefore: string[];
  contextAfter: string[];
}

export interface OmpSessionSearchResult {
  query: string;
  matches: OmpSessionSearchMatch[];
  truncated: boolean;
  searchedSessions: number;
}

interface SessionHeader {
  type: 'session';
  version: number;
  id: string;
  timestamp: string;
  cwd: string;
  title?: string;
  titleSource?: string;
}

interface SessionFileRecord {
  filePath: string;
  header: SessionHeader;
  sizeBytes: number;
  modifiedAtMs: number;
}

export function ompSessionsRoot(): string {
  return sessionsRoot();
}

function clampLimit(value: number | undefined, fallback: number, max: number): number {
  return Math.max(1, Math.min(max, value ?? fallback));
}

function readHeader(filePath: string): SessionHeader | null {
  try {
    // Read just the first 4KB — the session header is the first line.
    const fd = openSync(filePath, 'r');
    const buf = Buffer.alloc(4096);
    try {
      const n = readSync(fd, buf, 0, 4096, 0);
      const text = buf.slice(0, n).toString('utf8');
      const newline = text.indexOf('\n');
      const line = newline === -1 ? text : text.slice(0, newline);
      const parsed = JSON.parse(line) as SessionHeader;
      if (parsed.type !== 'session' || !parsed.id) return null;
      return parsed;
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

function sessionsRootRealPath(): string | null {
  try {
    return realpathSync(sessionsRoot());
  } catch {
    return null;
  }
}

function isSafeSessionFilePath(filePath: string): boolean {
  if (!filePath.endsWith('.jsonl')) return false;
  const root = sessionsRootRealPath();
  if (!root) return false;
  try {
    const real = realpathSync(filePath);
    return real === root || real.startsWith(`${root}/`);
  } catch {
    return false;
  }
}

export function listAllSessionFiles(): string[] {
  if (!existsSync(sessionsRoot())) return [];
  const out: string[] = [];
  for (const dir of readdirSync(sessionsRoot())) {
    const dirPath = join(sessionsRoot(), dir);
    try {
      if (!statSync(dirPath).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const f of readdirSync(dirPath)) {
      if (!f.endsWith('.jsonl')) continue;
      out.push(join(dirPath, f));
    }
  }
  return out;
}

function collectSessionFiles(): SessionFileRecord[] {
  const out: SessionFileRecord[] = [];
  for (const filePath of listAllSessionFiles()) {
    const header = readHeader(filePath);
    if (!header) continue;
    try {
      const st = statSync(filePath);
      out.push({
        filePath,
        header,
        sizeBytes: st.size,
        modifiedAtMs: st.mtimeMs,
      });
    } catch {
      // Session disappeared between directory scan and stat.
    }
  }
  out.sort((a, b) => b.modifiedAtMs - a.modifiedAtMs || b.header.timestamp.localeCompare(a.header.timestamp));
  return out;
}

function countLines(filePath: string): number {
  try {
    const text = readFileSync(filePath, 'utf8');
    if (!text) return 0;
    return text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length;
  } catch {
    return 0;
  }
}

function toSummary(record: SessionFileRecord): OmpSessionSummary {
  return {
    id: record.header.id,
    filePath: record.filePath,
    cwd: record.header.cwd,
    timestamp: record.header.timestamp,
    title: record.header.title ?? '',
    titleSource: record.header.titleSource,
    sizeBytes: record.sizeBytes,
    modifiedAt: new Date(record.modifiedAtMs).toISOString(),
    lineCount: countLines(record.filePath),
  };
}

function queryMatches(text: string, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const hay = text.toLowerCase();
  const terms = needle.split(/\s+/).filter(Boolean);
  return terms.every((term) => hay.includes(term));
}

export function listOmpSessions(input: {
  limit?: number;
  query?: string;
  cwd?: string;
} = {}): OmpSessionSummary[] {
  const limit = clampLimit(input.limit, 100, 1000);
  const cwd = input.cwd?.trim();
  const records = collectSessionFiles();
  const filtered = records.filter((record) => {
    if (cwd && record.header.cwd !== cwd && !record.header.cwd.startsWith(`${cwd}/`)) {
      return false;
    }
    if (input.query) {
      const text = [
        record.header.id,
        record.header.cwd,
        record.header.title ?? '',
        basename(record.filePath),
      ].join('\n');
      if (!queryMatches(text, input.query)) return false;
    }
    return true;
  });
  return filtered.slice(0, limit).map(toSummary);
}

function resolveSessionRecord(input: { id?: string; filePath?: string }): SessionFileRecord | null {
  if (input.filePath) {
    const abs = resolve(input.filePath);
    if (!isSafeSessionFilePath(abs)) return null;
    const header = readHeader(abs);
    if (!header) return null;
    try {
      const st = statSync(abs);
      return { filePath: abs, header, sizeBytes: st.size, modifiedAtMs: st.mtimeMs };
    } catch {
      return null;
    }
  }
  const id = input.id?.trim();
  if (!id) return null;
  return collectSessionFiles().find((record) => record.header.id === id) ?? null;
}

function readSessionEntries(filePath: string): { header: SessionHeader | null; entries: OmpSessionTurn[]; totalLines: number } | null {
  if (!isSafeSessionFilePath(filePath)) return null;
  let content: string;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  const lines = content.split('\n').filter((l) => l.trim() !== '');
  if (lines.length === 0) return null;

  let header: SessionHeader | null = null;
  const entries: OmpSessionTurn[] = [];
  for (const line of lines) {
    let parsed: OmpSessionTurn;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!header && parsed.type === 'session') {
      header = parsed as unknown as SessionHeader;
      continue;
    }
    entries.push(parsed);
  }
  return { header, entries, totalLines: lines.length };
}

async function lookupSpawnHints(
  spawnId: string,
): Promise<{ startedAtMs: number; harnessSlug: string | null; projectPath: string | null } | null> {
  const { db } = getOrgPg();
  const saTable = sa();
  const rows = await db
    .select({ harness_slug: saTable.harnessSlug, started_at: saTable.startedAt })
    .from(saTable)
    .where(eq(saTable.spawnId, spawnId))
    .limit(1);
  if (rows.length === 0) return null;
  const startedAtMs = rows[0].started_at ? new Date(rows[0].started_at as any).getTime() : 0;
  let projectPath: string | null = null;
  if (rows[0].harness_slug) {
    try {
      const reg = await loadHarnessRegistry();
      const project = reg.projects.find((p) => p.slug === rows[0].harness_slug);
      projectPath = project?.path ?? null;
    } catch {
      /* ignore */
    }
  }
  return {
    startedAtMs,
    harnessSlug: rows[0].harness_slug,
    projectPath,
  };
}

export function findOmpSessionNear(input: {
  startedAtMs: number;
  cwd?: string | null;
  windowMs?: number;
}): OmpSessionMeta | null {
  const windowMs = input.windowMs ?? 60_000;
  if (!input.startedAtMs) return null;

  let best: OmpSessionMeta | null = null;
  for (const record of collectSessionFiles()) {
    const ts = new Date(record.header.timestamp).getTime();
    if (!ts) continue;
    const drift = Math.abs(ts - input.startedAtMs);
    if (drift > windowMs) continue;

    let matchKind: OmpSessionMeta['matchKind'] = 'time-only';
    if (input.cwd && record.header.cwd === input.cwd) {
      matchKind = 'exact-cwd';
    } else if (input.cwd && record.header.cwd.startsWith(`${input.cwd}/`)) {
      matchKind = 'cwd-prefix';
    }

    const kindScore = matchKind === 'exact-cwd' ? 0 : matchKind === 'cwd-prefix' ? 1 : 2;
    const bestKindScore = !best
      ? Infinity
      : best.matchKind === 'exact-cwd'
        ? 0
        : best.matchKind === 'cwd-prefix'
          ? 1
          : 2;
    if (
      !best ||
      kindScore < bestKindScore ||
      (kindScore === bestKindScore && drift < best.timeDriftMs)
    ) {
      best = {
        id: record.header.id,
        filePath: record.filePath,
        cwd: record.header.cwd,
        timestamp: record.header.timestamp,
        title: record.header.title ?? '',
        matchKind,
        timeDriftMs: drift,
      };
    }
  }
  return best;
}

export async function findOmpSessionForSpawn(
  spawnId: string,
  windowMs = 60_000,
): Promise<OmpSessionMeta | null> {
  const hints = await lookupSpawnHints(spawnId);
  if (!hints || !hints.startedAtMs) return null;
  return findOmpSessionNear({
    startedAtMs: hints.startedAtMs,
    cwd: hints.projectPath,
    windowMs,
  });
}

export interface ReadOmpSessionInput {
  id?: string;
  filePath?: string;
  limit?: number;
}

export interface ReadOmpSessionResult {
  header: SessionHeader;
  turns: OmpSessionTurn[];
  totalLines: number;
  truncated: boolean;
}

export function readOmpSession(input: ReadOmpSessionInput): ReadOmpSessionResult | null {
  const limit = clampLimit(input.limit, DEFAULT_SESSION_LIMIT, MAX_SESSION_LIMIT);
  const record = resolveSessionRecord(input);
  if (!record) return null;
  const parsed = readSessionEntries(record.filePath);
  if (!parsed?.header) return null;
  return {
    header: parsed.header,
    turns: parsed.entries.slice(0, limit),
    totalLines: parsed.totalLines,
    truncated: parsed.entries.length > limit,
  };
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringifySmall(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value == null) return '';
  try {
    return JSON.stringify(value, (_key, inner) => {
      if (_key === 'thinking' || _key === 'thinkingSignature' || _key === 'encrypted_content') {
        return undefined;
      }
      if (typeof inner === 'string' && inner.length > 800) return `${inner.slice(0, 800)}…`;
      return inner;
    });
  } catch {
    return String(value);
  }
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return stringifySmall(content);
  const parts: string[] = [];
  for (const part of content) {
    const obj = asObject(part);
    if (!obj) {
      const s = stringifySmall(part);
      if (s) parts.push(s);
      continue;
    }
    const type = typeof obj.type === 'string' ? obj.type : '';
    if (type === 'thinking') continue;
    if (type === 'text' && typeof obj.text === 'string') {
      parts.push(obj.text);
      continue;
    }
    if (type === 'toolCall') {
      parts.push(`toolCall ${stringifySmall({ name: obj.name, arguments: obj.arguments })}`);
      continue;
    }
    const s = stringifySmall(obj);
    if (s) parts.push(s);
  }
  return parts.join('\n').trim();
}

function messageFromEntry(entry: OmpSessionTurn): Record<string, unknown> | null {
  const entryObj = asObject(entry);
  return asObject(entryObj?.message);
}

function entryRole(entry: OmpSessionTurn): string | undefined {
  const msg = messageFromEntry(entry);
  return typeof msg?.role === 'string' ? msg.role : undefined;
}

function entryToolName(entry: OmpSessionTurn): string | undefined {
  const msg = messageFromEntry(entry);
  return typeof msg?.toolName === 'string' ? msg.toolName : undefined;
}

function extractEntryText(entry: OmpSessionTurn): string {
  const msg = messageFromEntry(entry);
  if (msg) {
    const role = typeof msg.role === 'string' ? msg.role : 'message';
    const toolName = typeof msg.toolName === 'string' ? ` ${msg.toolName}` : '';
    return `${role}${toolName}\n${contentToText(msg.content)}`.trim();
  }
  const obj = asObject(entry);
  if (!obj) return stringifySmall(entry);
  return `${obj.type ?? 'entry'}\n${stringifySmall(obj)}`.trim();
}

function snippet(text: string, max = 320): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

function latestTodoPhases(entries: OmpSessionTurn[]): OmpTodoPhase[] {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const msg = messageFromEntry(entries[i]);
    if (!msg || msg.role !== 'toolResult' || msg.toolName !== 'todo_write' || msg.isError) {
      continue;
    }
    const details = asObject(msg.details);
    if (Array.isArray(details?.phases)) return details.phases as OmpTodoPhase[];
  }
  return [];
}

function messageSnippet(entry: OmpSessionTurn): OmpMessageSnippet {
  const msg = messageFromEntry(entry);
  return {
    id: typeof entry.id === 'string' ? entry.id : undefined,
    timestamp: typeof entry.timestamp === 'string' ? entry.timestamp : undefined,
    role: typeof msg?.role === 'string' ? msg.role : String(entry.type ?? 'entry'),
    toolName: typeof msg?.toolName === 'string' ? msg.toolName : undefined,
    isError: typeof msg?.isError === 'boolean' ? msg.isError : undefined,
    text: snippet(extractEntryText(entry), 600),
  };
}

/** Lightweight row-summary fields — what the sessions list needs to
 *  decide whether to show a row and what pills to render on it,
 *  without doing the full state extraction (tool counts, todo phases,
 *  message snippets, etc.). Reads the same JSONL but skips
 *  content-text reconstruction. */
export interface OmpSessionRowSummary {
  /** OMP session id from the JSONL header — the canonical thread id. */
  ompSessionId: string;
  /** Number of user-role turns. Zero = transcript exists but user
   *  never typed — filtered out of the sessions list. */
  userMessages: number;
  /** Latest model id reported by an assistant turn. */
  latestModel: string | null;
  /** Aggregate input/output/cache tokens. */
  totalTokens: number;
  /** Aggregate USD cost (sum of `usage.cost.total` across turns). */
  totalCostUsd: number;
}

/** Cheap variant of getOmpSessionState — same JSONL read, but skips
 *  content-text reconstruction, tool maps, todos, snippets. Used by
 *  the sessions list to filter empties server-side so the client
 *  doesn't see rows appear and then vanish as summaries resolve. */
export function getOmpSessionRowSummary(input: { id?: string; filePath?: string }): OmpSessionRowSummary | null {
  const record = resolveSessionRecord(input);
  if (!record) return null;
  const parsed = readSessionEntries(record.filePath);
  if (!parsed?.header) return null;
  let userMessages = 0;
  let latestModel: string | null = null;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let totalTokens = 0;
  let totalCostUsd = 0;
  for (const entry of parsed.entries) {
    const msg = messageFromEntry(entry);
    if (!msg) continue;
    const role = typeof msg.role === 'string' ? msg.role : undefined;
    if (role === 'user') {
      userMessages += 1;
      continue;
    }
    if (role !== 'assistant') continue;
    if (typeof msg.model === 'string') latestModel = msg.model;
    const u = asObject(msg.usage);
    if (!u) continue;
    const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    inputTokens += num(u.input);
    outputTokens += num(u.output);
    cacheReadTokens += num(u.cacheRead);
    cacheWriteTokens += num(u.cacheWrite);
    const reportedTotal = num(u.totalTokens);
    totalTokens +=
      reportedTotal > 0
        ? reportedTotal
        : num(u.input) + num(u.output) + num(u.cacheRead) + num(u.cacheWrite);
    const cost = asObject(u.cost);
    if (cost) totalCostUsd += num(cost.total);
  }
  // Avoid 'unused' on the four counters when not exported — they
  // would let us return per-bucket breakdowns later if needed.
  void inputTokens; void outputTokens; void cacheReadTokens; void cacheWriteTokens;
  return {
    ompSessionId: parsed.header.id,
    userMessages,
    latestModel,
    totalTokens,
    totalCostUsd,
  };
}

export function getOmpSessionState(input: { id?: string; filePath?: string }): OmpSessionState | null {
  const record = resolveSessionRecord(input);
  if (!record) return null;
  const parsed = readSessionEntries(record.filePath);
  if (!parsed?.header) return null;

  const countsByType: Record<string, number> = {};
  const toolMap = new Map<string, OmpToolSummary>();
  const latestMessages: OmpMessageSnippet[] = [];
  const jobs: OmpMessageSnippet[] = [];
  const goals: OmpMessageSnippet[] = [];
  const compactions: OmpMessageSnippet[] = [];
  const handoffs: OmpMessageSnippet[] = [];
  const modelSeen: string[] = [];
  let latestModel: string | null = null;
  const usage: OmpSessionUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    totalCostUsd: 0,
    assistantTurnsWithUsage: 0,
  };
  let user = 0;
  let assistant = 0;
  let toolResults = 0;

  for (const entry of parsed.entries) {
    const type = typeof entry.type === 'string' ? entry.type : 'unknown';
    countsByType[type] = (countsByType[type] ?? 0) + 1;

    const msg = messageFromEntry(entry);
    const role = typeof msg?.role === 'string' ? msg.role : undefined;
    if (role === 'user') user += 1;
    if (role === 'assistant') assistant += 1;
    if (role === 'toolResult') toolResults += 1;

    // Token + model + cost aggregation. OMP records this on assistant
    // turns as `message.model` (string) + `message.usage` (object with
    // input/output/cacheRead/cacheWrite/totalTokens + cost.total).
    if (role === 'assistant' && msg) {
      const modelId = typeof msg.model === 'string' ? msg.model : null;
      if (modelId) {
        latestModel = modelId;
        if (!modelSeen.includes(modelId)) modelSeen.push(modelId);
      }
      const u = asObject(msg.usage);
      if (u) {
        usage.assistantTurnsWithUsage += 1;
        const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
        usage.inputTokens += num(u.input);
        usage.outputTokens += num(u.output);
        usage.cacheReadTokens += num(u.cacheRead);
        usage.cacheWriteTokens += num(u.cacheWrite);
        // totalTokens is reported by OMP — prefer it; fall back to sum.
        const reportedTotal = num(u.totalTokens);
        usage.totalTokens +=
          reportedTotal > 0
            ? reportedTotal
            : num(u.input) + num(u.output) + num(u.cacheRead) + num(u.cacheWrite);
        const cost = asObject(u.cost);
        if (cost) usage.totalCostUsd += num(cost.total);
      }
    }

    const text = extractEntryText(entry);
    if (msg && (role === 'user' || role === 'assistant' || role === 'toolResult')) {
      latestMessages.push(messageSnippet(entry));
      if (latestMessages.length > 12) latestMessages.shift();
    }

    const toolName = entryToolName(entry);
    if (toolName) {
      const current = toolMap.get(toolName) ?? { toolName, calls: 0, results: 0, errors: 0 };
      if (role === 'toolResult') {
        current.results += 1;
        if (msg?.isError === true) current.errors += 1;
      } else {
        current.calls += 1;
      }
      if (typeof entry.timestamp === 'string') current.lastUsedAt = entry.timestamp;
      toolMap.set(toolName, current);

      if (toolName === 'job') jobs.push(messageSnippet(entry));
      if (toolName === 'goal') goals.push(messageSnippet(entry));
    }

    const isCompactionEntry =
      type === 'compaction' ||
      type === 'session_compact' ||
      type === 'auto_compaction_start' ||
      type === 'auto_compaction_end';
    if (isCompactionEntry) {
      compactions.push(messageSnippet(entry));
    }
    const isHandoffEntry =
      /handoff/i.test(type) ||
      text.includes('<handoff-context>') ||
      /new session started with handoff context/i.test(text);
    if (isHandoffEntry) {
      handoffs.push(messageSnippet(entry));
    }
  }

  return {
    header: parsed.header,
    filePath: record.filePath,
    totalLines: parsed.totalLines,
    countsByType,
    messages: {
      total: user + assistant + toolResults,
      user,
      assistant,
      toolResults,
    },
    models: modelSeen,
    latestModel,
    usage,
    latestMessages,
    todos: latestTodoPhases(parsed.entries),
    toolCounts: Array.from(toolMap.values()).sort((a, b) => (b.lastUsedAt ?? '').localeCompare(a.lastUsedAt ?? '')),
    jobs: jobs.slice(-20),
    goals: goals.slice(-20),
    compactions: compactions.slice(-20),
    handoffs: handoffs.slice(-20),
  };
}

export function searchOmpSessions(input: {
  query: string;
  sessionId?: string;
  filePath?: string;
  cwd?: string;
  limit?: number;
  context?: number;
}): OmpSessionSearchResult {
  const query = input.query.trim();
  const limit = clampLimit(input.limit, DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);
  const context = Math.max(0, Math.min(3, input.context ?? 1));
  const matches: OmpSessionSearchMatch[] = [];
  const records = input.sessionId || input.filePath
    ? [resolveSessionRecord({ id: input.sessionId, filePath: input.filePath })].filter((r): r is SessionFileRecord => r !== null)
    : collectSessionFiles().filter((record) => {
        if (!input.cwd) return true;
        return record.header.cwd === input.cwd || record.header.cwd.startsWith(`${input.cwd}/`);
      });

  let searchedSessions = 0;
  for (const record of records) {
    const parsed = readSessionEntries(record.filePath);
    if (!parsed?.header) continue;
    searchedSessions += 1;
    const texts = parsed.entries.map(extractEntryText);
    const summary = toSummary(record);
    for (let i = 0; i < texts.length; i += 1) {
      if (!queryMatches(texts[i], query)) continue;
      const entry = parsed.entries[i];
      matches.push({
        session: summary,
        line: i + 2,
        entryId: typeof entry.id === 'string' ? entry.id : undefined,
        timestamp: typeof entry.timestamp === 'string' ? entry.timestamp : undefined,
        type: typeof entry.type === 'string' ? entry.type : 'unknown',
        role: entryRole(entry),
        toolName: entryToolName(entry),
        snippet: snippet(texts[i], 500),
        contextBefore: texts.slice(Math.max(0, i - context), i).map((t) => snippet(t, 220)),
        contextAfter: texts.slice(i + 1, i + 1 + context).map((t) => snippet(t, 220)),
      });
      if (matches.length >= limit) {
        return { query, matches, truncated: true, searchedSessions };
      }
    }
  }
  return { query, matches, truncated: false, searchedSessions };
}
