/**
 * Codex + OMP transcript adapters for the interactive-usage ingester
 * (token-usage-reduction-audit-2026-06-09 P-015).
 *
 * Both backends turn out to write append-only JSONL rollouts just like Claude
 * Code (the OMP sqlite `agent.db` only INDEXES threads — its `rollout_path`
 * column points at `~/.omp/agent/sessions/**.jsonl`), so both adapters reuse
 * the same byte-watermark machinery as the Claude parser; only the per-line
 * shapes differ:
 *
 *   codex (`~/.codex/sessions/**.jsonl`):
 *     - `turn_context` lines carry `payload.model` — tracked as last-seen
 *       in parser state committed with the file watermark; an unavailable
 *       model is explicitly unknown, never replaced with a default model.
 *     - `event_msg` lines with `payload.type === 'token_count'` carry
 *       `payload.info.last_token_usage` = the PER-TURN usage
 *       ({input_tokens, cached_input_tokens, output_tokens}). `info` is null
 *       on rate-limit-only updates. `input_tokens` INCLUDES the cached
 *       subset, so uncached input = input − cached, cache-read = cached.
 *
 *   omp (`~/.omp/agent/sessions/**.jsonl`):
 *     - `message` lines with `message.role === 'assistant'` carry
 *       `message.usage` = {input, output, cacheRead, cacheWrite, cost:{total}}
 *       (anthropic-shaped: `input` is already the uncached residue) plus
 *       `message.model`. Deduped by line `id` (max-merge), mirroring the
 *       Claude parser's message.id discipline.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { codexHomesRoot } from '@papercusp/orchestrator/session-launch-dirs';
import type { ParsedChunk, TranscriptDelta, TranscriptParserState, TranscriptUsageEvent } from './ingest-claude-transcripts';
import { parseTranscriptChunk, transcriptEventTime } from './ingest-claude-transcripts';

const emptyDelta = (): TranscriptDelta => ({
  turns: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
});

/** Consume complete lines only; return [consumedText, consumedBytes]. */
function completeLines(chunk: string): { text: string; bytes: number } {
  const lastNewline = chunk.lastIndexOf('\n');
  if (lastNewline === -1) return { text: '', bytes: 0 };
  const text = chunk.slice(0, lastNewline + 1);
  return { text, bytes: Buffer.byteLength(text, 'utf8') };
}

export const UNKNOWN_CODEX_MODEL = 'unknown-openai';

const CODEX_CARRY_LINEAGE_RE = /⟦codex-carry-lineage predecessor:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})⟧/i;

/** Read the lineage marker from the native Codex user-message content shape. */
function codexCarryLineagePredecessor(payload: {
  type?: string;
  role?: string;
  content?: unknown;
} | undefined): string | undefined {
  if (payload?.type !== 'message' || payload.role !== 'user' || !Array.isArray(payload.content)) return undefined;
  for (const part of payload.content) {
    if (!part || typeof part !== 'object' || Array.isArray(part)) continue;
    const block = part as { type?: unknown; text?: unknown };
    if (block.type !== 'input_text' || typeof block.text !== 'string') continue;
    const match = CODEX_CARRY_LINEAGE_RE.exec(block.text);
    if (match) return match[1];
  }
  return undefined;
}

/** Parse a codex rollout chunk. Exported for unit tests. */
export function parseCodexChunk(chunk: string, priorState: TranscriptParserState = {}): ParsedChunk {
  const perModel = new Map<string, TranscriptDelta>();
  const events: TranscriptUsageEvent[] = [];
  const parserState = { ...priorState };
  const { text, bytes } = completeLines(chunk);
  if (bytes === 0) return { perModel, consumedBytes: 0, parserState };
  let model = typeof parserState.model === 'string' && parserState.model ? parserState.model : UNKNOWN_CODEX_MODEL;
  let relativeOffset = 0;
  for (const line of text.split('\n')) {
    const lineOffset = relativeOffset;
    relativeOffset += Buffer.byteLength(line + '\n', 'utf8');
    if (!line.trim()) continue;
    let j: unknown;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    const evt = j as {
      type?: string;
      timestamp?: unknown;
      payload?: {
        type?: string;
        model?: string;
        turn_id?: string;
        forked_from_id?: string;
        role?: string;
        content?: unknown;
        info?: {
          total_token_usage?: Record<string, number> | null;
          last_token_usage?: {
            input_tokens?: number;
            cached_input_tokens?: number;
            cache_write_input_tokens?: number;
            output_tokens?: number;
          } | null;
        } | null;
      };
    };
    if (evt?.type === 'session_meta') {
      // Only a source header establishes that this is the beginning of a session.
      // A resumed parser without prefix evidence must not label a later request as startup.
      parserState.contextGeneration ??= 0;
      parserState.requestOrdinal ??= 0;
      if (typeof evt.payload?.forked_from_id === 'string' && evt.payload.forked_from_id) {
        parserState.predecessorSessionId = evt.payload.forked_from_id;
      }
    }
    if (evt?.type === 'response_item') {
      // Managed fresh carries are new Codex threads, so session_meta has no
      // forked_from_id. Preserve native fork metadata when it exists; otherwise
      // recover the predecessor from Papercusp's marker in the first user turn.
      const predecessor = codexCarryLineagePredecessor(evt.payload);
      if (predecessor && !parserState.predecessorSessionId) {
        parserState.predecessorSessionId = predecessor;
      }
    }
    if (evt?.type === 'compacted' || evt.payload?.type === 'context_compacted') {
      parserState.contextGeneration = (parserState.contextGeneration ?? 0) + 1;
      delete parserState.lastCumulativeUsage;
    }
    if (evt?.type === 'turn_context') {
      if (typeof evt.payload?.model === 'string' && evt.payload.model) {
        model = evt.payload.model;
        parserState.model = model;
      }
      parserState.turnId = typeof evt.payload?.turn_id === 'string' ? evt.payload.turn_id : undefined;
      continue;
    }
    if (evt?.type !== 'event_msg' || evt.payload?.type !== 'token_count') continue;
    const u = evt.payload?.info?.last_token_usage;
    if (!u) continue; // rate-limit-only token_count update
    const cumulative = evt.payload?.info?.total_token_usage;
    // Ignore non-usage metadata; an empty/invalid object is NOT a request id.
    const fields = ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens'];
    const entries = cumulative && fields.filter((key) => cumulative[key] !== undefined).map((key) => [key, cumulative[key]] as const);
    const fingerprint = entries?.length && entries.every(([, n]) => Number.isFinite(n) && n >= 0) && entries.some(([, n]) => n > 0)
      ? JSON.stringify(entries) : null;
    if (fingerprint) {
      if (fingerprint === parserState.lastCumulativeUsage) continue;
      parserState.lastCumulativeUsage = fingerprint;
    }
    const count = (n: unknown): number => typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;
    const input = count(u.input_tokens);
    const cached = count(u.cached_input_tokens);
    const written = count(u.cache_write_input_tokens);
    const output = count(u.output_tokens);
    if (input + cached + written + output === 0) continue; // compaction/reset notification, not a request
    // Without cumulative identity, duplicate notifications cannot be distinguished
    // from requests. Keep accounting them by source line, but retire startup certainty.
    if (!fingerprint) delete parserState.requestOrdinal;
    else if (parserState.requestOrdinal !== undefined) parserState.requestOrdinal++;
    const usage: TranscriptDelta = { turns: 1, inputTokens: Math.max(0, input - cached - written),
      cacheReadTokens: cached, cacheCreationTokens: written, outputTokens: output };
    if (typeof u.cache_write_input_tokens !== 'number' || !Number.isFinite(u.cache_write_input_tokens) || u.cache_write_input_tokens < 0) usage.cacheCreationUnreported = true;
    events.push({ model, usage, relativeOffset: lineOffset, eventTime: transcriptEventTime(evt.timestamp),
      inputTotalTokens: typeof u.input_tokens === 'number' && Number.isFinite(u.input_tokens) && u.input_tokens >= 0 ? u.input_tokens : null,
      uncachedInputKnown: !usage.cacheCreationUnreported,
      sourceId: fingerprint ? `cumulative:${parserState.contextGeneration ?? 0}:${fingerprint}` : `line:${lineOffset}`,
      contextGeneration: parserState.contextGeneration, predecessorSessionId: parserState.predecessorSessionId,
      requestOrdinal: parserState.requestOrdinal,
      cacheReadKnown: typeof u.cached_input_tokens === 'number' && Number.isSafeInteger(u.cached_input_tokens) && u.cached_input_tokens >= 0,
      turnId: parserState.turnId });
    const acc = perModel.get(model) ?? emptyDelta();
    acc.turns += 1;
    acc.inputTokens += Math.max(0, input - cached - written); // input INCLUDES both cache subsets
    acc.cacheReadTokens += cached;
    acc.cacheCreationTokens += written;
    acc.outputTokens += output;
    if (usage.cacheCreationUnreported) acc.cacheCreationUnreported = true;
    perModel.set(model, acc);
  }
  return { perModel, events, consumedBytes: bytes, parserState };
}

interface OmpUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/** Parse an OMP rollout chunk. Exported for unit tests. */
export function parseOmpChunk(chunk: string): ParsedChunk {
  const perModel = new Map<string, TranscriptDelta>();
  const { text, bytes } = completeLines(chunk);
  if (bytes === 0) return { perModel, consumedBytes: 0 };
  // line id → max-merged usage (the Claude parser's message.id discipline).
  const byMsg = new Map<string, { model: string; u: Required<OmpUsage>; relativeOffset: number; eventTime: number | null; writeReported: boolean }>();
  let relativeOffset = 0;
  for (const line of text.split('\n')) {
    const lineOffset = relativeOffset;
    relativeOffset += Buffer.byteLength(line + '\n', 'utf8');
    if (!line.trim()) continue;
    let j: unknown;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    const evt = j as {
      type?: string;
      id?: string;
      timestamp?: unknown;
      message?: { role?: string; model?: string; usage?: OmpUsage };
    };
    if (evt?.type !== 'message' || evt.message?.role !== 'assistant') continue;
    const model = evt.message?.model;
    const u = evt.message?.usage;
    if (!model || !u) continue;
    const key = evt.id ? `message:${evt.id}` : `line:${lineOffset}`;
    const acc = byMsg.get(key) ?? {
      model, relativeOffset: lineOffset, eventTime: transcriptEventTime(evt.timestamp), writeReported: false,
      u: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    acc.u.input = Math.max(acc.u.input, u.input ?? 0);
    acc.u.output = Math.max(acc.u.output, u.output ?? 0);
    acc.u.cacheRead = Math.max(acc.u.cacheRead, u.cacheRead ?? 0);
    acc.u.cacheWrite = Math.max(acc.u.cacheWrite, u.cacheWrite ?? 0);
    if (typeof u.cacheWrite === 'number' && Number.isFinite(u.cacheWrite) && u.cacheWrite >= 0) acc.writeReported = true;
    byMsg.set(key, acc);
  }
  const events: TranscriptUsageEvent[] = [];
  for (const [sourceId, { model, u, relativeOffset, eventTime, writeReported }] of byMsg) {
    const usage: TranscriptDelta = { turns: 1, inputTokens: u.input, outputTokens: u.output,
      cacheReadTokens: u.cacheRead, cacheCreationTokens: u.cacheWrite };
    if (!writeReported) usage.cacheCreationUnreported = true;
    // OMP does not report Claude's TTL split; never assume five-minute writes.
    if (/^claude/i.test(model) && u.cacheWrite > 0) usage.cacheCreationTierUnknown = true;
    events.push({ model, usage, sourceId, relativeOffset, eventTime });
    const acc = perModel.get(model) ?? emptyDelta();
    acc.turns += 1;
    acc.inputTokens += u.input;
    acc.outputTokens += u.output;
    acc.cacheReadTokens += u.cacheRead;
    acc.cacheCreationTokens += u.cacheWrite;
    if (usage.cacheCreationTierUnknown) acc.cacheCreationTierUnknown = true;
    if (usage.cacheCreationUnreported) acc.cacheCreationUnreported = true;
    perModel.set(model, acc);
  }
  return { perModel, events, consumedBytes: bytes };
}

/** Provider bucket for a model id (drives `provider` + `bucket_key`). */
export function providerForModel(model: string): 'anthropic' | 'openai' | 'unknown' {
  if (model === UNKNOWN_CODEX_MODEL || /gpt|codex|^o\d/i.test(model)) return 'openai';
  return /^claude/i.test(model) ? 'anthropic' : 'unknown';
}

export interface TranscriptAdapter {
  /** Adapter name — for logs/errors only. */
  name: string;
  /** Transcript root to walk recursively for `*.jsonl`. */
  root: string;
  /** Chunk parser (complete-lines-only; returns the watermark advance). */
  parse: (chunk: string, state?: TranscriptParserState) => ParsedChunk;
  /** Stateful formats may reconstruct legacy empty parser state from consumed bytes. */
  replayStateFromPrefix?: boolean;
  /**
   * Native session id for a transcript file — the value written to
   * `agent_usage_samples.session_id`, which MUST equal `adv_sessions.session_id`
   * for every spend join (loop cost-cap, goal spend rollup, the goal_id stamp
   * via `goal_id_for_usage_session`) to find the row. Default: the basename
   * minus `.jsonl` (correct for Claude `<uuid>.jsonl` and OMP thread files).
   * Codex names its rollouts `rollout-<ts>-<uuid>.jsonl`, so its adapter
   * extracts the trailing uuid — WI-2140701 (a): without this every codex
   * sample carried an unmatchable `rollout-…` session_id and a NULL goal_id.
   */
  sessionIdForFile?: (filePath: string) => string;
  /**
   * Coord owner id this adapter's transcripts belong to, when the root itself
   * identifies one — the per-session isolation roots are shaped
   * `~/.papercusp/session-claude/<coord-owner-id>/projects`, so the owner is
   * already in hand and needs no join. Written to
   * `agent_usage_samples.harness_slug` via
   * `harness_shared.harness_slug_for_usage_attribution` (WI-2144763).
   *
   * Left undefined for the GLOBAL (non-isolation) roots, whose paths carry no
   * owner; those fall back to the function's adv_sessions session route.
   * Measured 2026-09-05: the owner route resolves a harness for 63.4% of the
   * real on-disk isolation owners, against 0.0% written by this writer today.
   */
  ownerId?: string;
  /**
   * `adv_sessions.id` (the bigint PRIMARY KEY) this adapter's transcripts belong
   * to, when the root itself identifies one. A psu-launched codex session runs
   * under a per-session CODEX_HOME shaped
   * `~/.papercusp/su-codex-homes/session-<advId>/`, so the PK is already in the
   * path the ingester walks and needs no join — the codex analogue of `ownerId`
   * above. Passed to `harness_slug_for_usage_attribution` as its ranked-second
   * route (WI-2144763, migration 1120).
   *
   * This exists because the rollout uuid stored in `session_id` does NOT match
   * `adv_sessions.session_id` for these sessions: measured 2026-09-05, only 10 of
   * 63 unstamped sessions were findable by that route, so the session fallback
   * had nothing to join to and every psu codex session went unattributed.
   * Measured coverage of THIS route on the same population: 58/58 resolve an
   * adv_sessions row and a coord owner, 44/58 (75.9%) reach a harness_slug.
   *
   * Left undefined for the GLOBAL (non-isolation) roots, whose paths carry no
   * adv id; those still fall back to the function's session route.
   */
  advSessionId?: number;
}

/** `rollout-2026-09-02T01-10-49-<uuid>.jsonl` → `<uuid>` — the same shape the
 *  wake-executor / compaction-usage codex handles key on. */
const CODEX_ROLLOUT_UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

/** Codex rollout file → `adv_sessions.session_id` (the bare rollout uuid).
 *  Falls back to the basename when the file is not rollout-named. */
export function codexSessionIdForFile(filePath: string): string {
  const m = CODEX_ROLLOUT_UUID_RE.exec(path.basename(filePath));
  return m ? m[1].toLowerCase() : path.basename(filePath, '.jsonl');
}

/** Base dir holding one per-session `CODEX_HOME` per psu-launched codex
 *  session (`~/.papercusp/su-codex-homes/session-<advId>/`); each home writes
 *  its rollouts under `<home>/sessions/YYYY/MM/DD/`. */
export function defaultCodexHomesBase(): string {
  return codexHomesRoot();
}

/**
 * Every per-session codex transcript root: `<base>/<home>/sessions` for each
 * per-session CODEX_HOME under the base (WI-2140701 (a)). The global
 * `~/.codex/sessions` root is NOT included — the default `codex` adapter
 * already covers it. Mirrors `claudeProjectsRoots()` for Claude's isolation
 * roots, because the same structural blindness (EI-19964643447670242) applied
 * on the codex lane: every psu-launched codex agent — the codex
 * everything-goal holder included — wrote rollouts under a root no ingester
 * ever scanned. Only the one known `sessions` level is enumerated (a per-home
 * recursive readdir would descend into ~20 config subdirs per home — the
 * 2026-07-05 sweep-hang class). Fail-soft: a missing/unreadable base → [].
 */
export async function codexSessionRoots(isolationBase: string = defaultCodexHomesBase()): Promise<string[]> {
  const roots: string[] = [];
  let homes: string[];
  try {
    homes = await fs.readdir(isolationBase);
  } catch {
    return roots; // no per-session codex homes on this machine
  }
  for (const home of homes) {
    const sessions = path.join(isolationBase, home, 'sessions');
    try {
      if ((await fs.stat(sessions)).isDirectory()) roots.push(sessions);
    } catch {
      // a home with no rollouts yet, or a stray file — skip
    }
  }
  return roots;
}

/**
 * `<base>/session-<advId>/sessions` → `<advId>` as a number, or undefined when the
 * root is not a per-session CODEX_HOME of that shape (WI-2144763, migration 1120).
 *
 * `<advId>` is `adv_sessions.id`, the bigint PRIMARY KEY, so this is the codex
 * analogue of lifting the coord owner id out of a claude isolation path: the key
 * is already in the directory the ingester walks, and no join is needed to find
 * it. Returns undefined rather than NaN on any unexpected shape, so a stray
 * directory degrades to the existing session-route fallback instead of poisoning
 * the INSERT with a NaN bind.
 */
export function advSessionIdFromCodexHome(sessionsRoot: string): number | undefined {
  const home = path.basename(path.dirname(sessionsRoot));
  const m = /^session-(\d+)$/.exec(home);
  if (!m) return undefined;
  const id = Number(m[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

/** The default adapter set: Claude Code + codex + OMP rollouts at their GLOBAL
 *  roots. The per-session isolation roots (claude + codex) are appended by
 *  `ingestInteractiveUsage` on its default path. */
export function defaultAdapters(): TranscriptAdapter[] {
  const home = os.homedir();
  return [
    {
      name: 'claude',
      root: path.join(home, '.claude', 'projects'),
      parse: parseTranscriptChunk,
    },
    {
      name: 'codex',
      root: path.join(home, '.codex', 'sessions'),
      parse: parseCodexChunk,
      replayStateFromPrefix: true,
      sessionIdForFile: codexSessionIdForFile,
    },
    {
      name: 'omp',
      root: path.join(home, '.omp', 'agent', 'sessions'),
      parse: parseOmpChunk,
    },
  ];
}
