/**
 * Session-transcript ingest — the episodic verbatim index feeder
 * (session-search-scope-2026-07-05 P-003 / D-003; compaction-context-loss
 * D-001 "index, don't summarize harder").
 *
 * ONE `harness_shared.session_turns` table fed by an ADAPTER REGISTRY:
 *   * `claude`      — Claude Code JSONL (~/.claude/projects/** and the psu
 *                     isolation dirs ~/.papercusp/session-claude/<owner>/projects/**)
 *   * `omp`         — OMP JSONL (~/.omp/agent/sessions/<munged-cwd>/*.jsonl)
 *   * `codex`       — Codex rollouts (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl)
 *   * `agent_chat`  — harness_shared.agent_chats_consolidated transcript JSONB
 *
 * Design invariants:
 *   * INCREMENTAL: per-file (source_kind, file_path) → byte_offset bookkeeping
 *     in session_ingest_state; JSONL is append-only so tailing is cheap. Only
 *     COMPLETE lines are consumed (a partially-flushed last line waits for the
 *     next tick).
 *   * BOUNDED per tick: file/turn/byte caps below — the corpus is ~23k files /
 *     ~10 GB on a mature box, so a tick NEVER tries to swallow history in one
 *     go; the tailer converges across ticks (newest-mtime first, so recent
 *     sessions — the ones agents actually search — index first).
 *   * TEXT TURNS ONLY (v1): user + assistant text parts. Tool results /
 *     thinking blocks are bulk noise for recall (tool calls already live in
 *     tool_invocations); the full source line remains on disk for
 *     sessions:read.
 *   * TRUNCATED + REDACTED at ingest: 8k chars/turn; common secret shapes
 *     scrubbed. The index is for recall, not archival — the PERMANENT copy is
 *     `harness_shared.session_archives` (session-db-archive-retire-dirs
 *     -2026-07-10 D-001): a LIVE session's JSONL is on disk; an ENDED
 *     session's files are archived-then-deleted (exit hook + hourly
 *     reconciler), and sessions:read falls through to the archive
 *     (session-archive-read.ts) with this same cap+redaction re-applied.
 *   * COMPACTION-SAFE by construction: compaction never deletes the JSONL
 *     (archive-at-death only deletes AFTER a sha-verified archive of the
 *     whole file), so the index can never lose pre-compaction turns;
 *     `ingestFileNow` gives the read-time freshness guarantee (self
 *     live-tail) client-neutrally (compaction-context-loss D-002 — hooks are
 *     optimizations, not dependencies). The end-of-session hook also runs a
 *     FINAL ingestFileNow before archiving, so the index captures the tail.
 *   * Embeddings are NOT computed here — the embed-backfill sweep
 *     (search/embed-backfill.ts, bench admission lane) fills
 *     `text_embedding` asynchronously; ingest must never block on network.
 */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { open, readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { listAllProjectedTools } from '@papercusp/tooldef';
import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';
import { cooperativeYield } from '../event-loop-lag-monitor';
import { blockPayloadText, codexToolCallArgsRaw, CLAUDE_OWNER_DIALOG_RESULT_PREFIXES } from '../transcript-wire';
import { classifyRecordedTurn, OWNER_DIALOG_TURN_MARKER } from '../turn-provenance/turn-ref';
import {
  MACHINE_SURFACE_CATALOGUE_VERSION,
  CLASSIFY_HEAD_CHARS,
} from '../turn-provenance/machine-surface-catalogue';
import {
  addResultBytes,
  addToolUse,
  dayOf,
  extractLineUsage,
  rollupRows,
  type LineUsage,
  type UsageRollup,
} from '../bash-substitution/usage-rollup';
import { getSubstitutionRows } from '../bash-substitution/registry';
import type { SubstitutionRow } from '../bash-substitution/match';
import { activeWorkspaceId } from '../workspace-registry';
import { pinModuleState } from '@papercusp/module-singleton';
import { redactKeyDirectedSecrets, redactSelfIdentifyingSecrets } from '../sensitive-text';
import { capWithMarker, partTextCapFor } from '../transcript-text-caps';

// Backward-compatible export for the session-part security tests and archive readers.
export { redactKeyDirectedSecrets as redactPartSecrets } from '../sensitive-text';

/** How far back a source file's mtime may be and still get ingested. */
const INGEST_WINDOW_DAYS = 45;
/** Retention for indexed turns (the JSONL remains the archive past this). */
const RETENTION_DAYS = 45;
/** Per-tick caps — the tailer converges across ticks, never gulps. */
const MAX_FILES_PER_TICK = 200;
const MAX_TURNS_PER_TICK = 4000;
const MAX_BYTES_PER_FILE_PER_TICK = 5 * 1024 * 1024;
const MAX_CHATS_PER_TICK = 50;
/** WI-5218: cooperative-yield granularity for the per-line parse loop in
 * readNewLines — large enough that a quiet host pays only a handful of
 * macrotask hops per file (not thousands), small enough that even a single
 * MAX_BYTES_PER_FILE_PER_TICK-sized file can no longer block the main thread
 * for tens of milliseconds straight. */
const LINE_YIELD_EVERY = 1000;
/** Historical EI-9970 counter repair caps. The cursor persists across ticks. */
const MAX_COUNT_BACKFILL_FILES_PER_TICK = 25;
const MAX_COUNT_BACKFILL_BYTES_PER_TICK = 50 * 1024 * 1024;
/** Historical P-001 faithful-part repair caps. The cursor persists across ticks. */
const MAX_PART_BACKFILL_FILES_PER_TICK = 25;
const MAX_PART_BACKFILL_BYTES_PER_TICK = 50 * 1024 * 1024;
/** Per-turn text cap (chars). */
export const SESSION_TURN_TEXT_CAP = 8000;
const TEXT_CAP = SESSION_TURN_TEXT_CAP;
/** Skip micro-turns ("ok", "y") — noise for recall. */
const MIN_TEXT_LEN = 3;
/**
 * Per-PART text caps (chars) — session_turn_parts, the faithful-render
 * companion (session-turn-storage-2026-07-28 D-002). These are now DERIVED
 * from the render budget rather than hardcoded here; see
 * `../transcript-text-caps` for why (this file used to carry a flat 2,000
 * justified by a comment claiming the pane capped there too — it caps at
 * 8,000, so the store was 4x tighter than the surface reading it and 16.9% of
 * all stored parts were truncated below what the pane would have shown).
 *
 * Prose (`text`/`thinking`) is stored to the full render budget. Tool payloads
 * keep the tighter volume cap — tool_result alone is 218 MB raw against text's
 * 21 MB over 7 days — and stay recoverable from the session file, which the
 * stream route prefers whenever a stored part was truncated.
 */
export { PART_TEXT_CAP_PROSE, PART_TEXT_CAP_TOOL, partTextCapFor } from '../transcript-text-caps';
/** Retention for faithful parts — SHORTER than RETENTION_DAYS by design
 * (D-002): recent sessions render faithfully, older ones degrade to the text
 * turns in session_turns, older still to session_archives. */
const PART_RETENTION_DAYS = 14;

export type SourceKind = 'claude' | 'omp' | 'codex' | 'agent_chat';

/**
 * Native, non-semantic evidence about an assistant response.  `delivered`
 * means the client recorded its final-answer boundary; it never means a text
 * fragment merely happened to follow a prompt.  `interrupted` deliberately
 * does NOT settle the request that was being served.
 */
export type ParsedResponseDisposition = 'progress' | 'delivered' | 'interrupted';

export interface ParsedTurn {
  ts: Date | null;
  speaker: 'user' | 'assistant';
  text: string;
  cwd?: string | null;
  sessionId?: string | null;
  /** SHA-256 of the raw, normalized prompt before cap/redaction. Claude only;
   *  used to correlate the hook-authenticated OWNER stamp at insert time. */
  promptHash?: string | null;
  /** Native logical turn/request id when the client writes one on both sides
   *  of the exchange (Codex today).  Other clients are correlated through the
   *  message-parent chain below by the bounded transcript-tail reader. */
  requestId?: string | null;
  /** Native message graph identity.  These fields stay out of session_turns;
   *  the carry tail uses them in-memory to connect final delivery to the owner
   *  request it actually belongs to. */
  messageId?: string | null;
  parentMessageId?: string | null;
  /** Mechanically derived from the client wire: Claude end_turn, Codex
   *  final_answer, or OMP stop.  Missing/unknown is intentionally not success. */
  responseDisposition?: ParsedResponseDisposition | null;
}

/** The faithful-render part kinds stored in session_turn_parts. Mirrors the
 *  AgentTimelineEntry kinds the thinking pane renders, minus 'status' (which
 *  the render path derives from part_kind rather than storing). */
export type PartKind = 'text' | 'thinking' | 'tool_use' | 'tool_result';

/**
 * ONE content part of a transcript line (session-turn-storage-2026-07-28
 * P-001). A single JSONL line commonly yields SEVERAL of these — an assistant
 * line with a thinking block plus three tool_use blocks is four parts, in
 * content order — which is precisely the fidelity `session_turns` throws away
 * by design (it reduces the whole line to its joined text or nothing at all).
 */
export interface ParsedPart {
  ts: Date | null;
  speaker: 'user' | 'assistant';
  partKind: PartKind;
  /** tool_use / tool_result only. */
  toolName?: string | null;
  text: string;
  sessionId?: string | null;
}

/**
 * Per-line classification signal (EI-9970) — computed for EVERY raw
 * transcript line, not just the ones parseXLine turns into a stored
 * session_turns row. Feeds the real cost/effort-audit counters
 * (prompt_count / response_count / tool_call_count) that session_turns'
 * row count structurally cannot: that table is TEXT TURNS ONLY (tool_use /
 * tool_result / thinking-only content is never stored there by design), so
 * a bare count(*) over it was being misread as "how many turns did this
 * session take" when it only ever counted a filtered subset.
 */
export interface LineSignal {
  /** A real user-typed prompt — same filter session_turns applies for a
   *  stored speaker='user' row (non-boilerplate, >= MIN_TEXT_LEN chars). */
  isPrompt: boolean;
  /** This line carries genuine model-response payload (real text and/or a
   *  tool call) — a candidate RESPONSE boundary, as opposed to a pure
   *  thinking-only placeholder line some clients (Claude) emit as a
   *  separate JSONL record ahead of the actual output. */
  isResponsePayload: boolean;
  /** The id tying this response-payload line to the one model call it
   *  belongs to (Claude: message.id/requestId; OMP/Codex: the record's own
   *  id) — null when the adapter has no such id (that line is always
   *  counted as its own distinct response, never deduped). ONLY set when
   *  isResponsePayload is true. A single model turn can legitimately span
   *  MULTIPLE raw JSONL 'assistant' lines sharing one id (a thinking-only
   *  stub, one line per tool_use block, then the text line) — counting raw
   *  lines instead of distinct ids reproduces the exact "matches nothing
   *  intuitive" bug this signal exists to fix.
   */
  inferenceId: string | null;
  /** Real tool invocations carried on this line (Claude tool_use content
   *  blocks; OMP toolCall content items; Codex counts as 0|1 since its
   *  tool calls are their own separate response_item line). */
  toolCallCount: number;
}

const NULL_SIGNAL: LineSignal = { isPrompt: false, isResponsePayload: false, inferenceId: null, toolCallCount: 0 };

export interface IngestStats {
  filesScanned: number;
  filesIngested: number;
  turnsInserted: number;
  /** P-001: faithful session_turn_parts rows written this sweep. */
  partsInserted?: number;
  chatsIngested: number;
  /** Historical session_ingest_state rows whose EI-9970 counters advanced. */
  countBackfillFiles: number;
  /** Historical session_ingest_state rows whose P-001 parts advanced. */
  partsBackfillFiles: number;
  errors: number;
  /** First few error messages of the sweep — diagnosis without log spam. */
  errorSample?: string[];
  durationMs: number;
  /** Exclusive wall-time buckets, including await/scheduling time, not CPU time.
   * `other` covers sweep bookkeeping outside the measured operations. */
  phaseMs?: Record<'setup' | 'history' | 'discovery' | 'state' | 'metadata' | 'decode' | 'writes' | 'metadataBackfill' | 'chats' | 'other', number>;
  /** One receipt per nonempty adapter/repair operation, not per file or row.
   * Wall spans include database and scheduling waits; they do not measure CPU.
   * Counts/spans and input hashes identify the operation without retaining
   * session IDs, owner IDs or SQL. */
  metadataBackfills?: Array<{
    sourceKind: SourceKind;
    operation: 'sessionOwners' | 'partOwners' | 'codexAdvSessions';
    requested: number;
    /** Owner repair: SHA-256 of JSON.stringify([sessionIds, owners]) in the
     * exact UNNEST parameter order. Captured before execution, even on failure;
     * a fingerprint supports comparison but cannot reconstruct the values. */
    inputSha256?: string;
    updated?: number;
    startedAtMs: number;
    durationMs: number;
    status: 'completed' | 'failed';
  }>;
  skipped?: string;
}

/** Keep slow, empty sweeps observable as well as useful or failed sweeps. */
export function sessionIngestLogLine(stats: IngestStats): string | null {
  const parts = stats.partsInserted ?? 0;
  if (stats.skipped || (stats.turnsInserted === 0 && parts === 0 && stats.errors === 0 && stats.durationMs < 5000)) {
    return null;
  }
  return `[session-ingest] +${stats.turnsInserted} turn(s) +${parts} part(s) from ${stats.filesIngested} file(s) ` +
    `+ ${stats.chatsIngested} chat turn(s) (${stats.filesScanned} scanned, ${stats.errors} error(s), ${stats.durationMs}ms)` +
    (stats.phaseMs ? ` phases=${JSON.stringify(stats.phaseMs)}` : '') +
    (stats.metadataBackfills?.length ? ` metadataBackfills=${JSON.stringify(stats.metadataBackfills)}` : '');
}

/** Injected boilerplate prefixes that would pollute recall — not real speech. */
const BOILERPLATE_PREFIXES = [
  '<system-reminder',
  '<local-command',
  '<command-name',
  '<user_instructions>',
  '<permissions instructions>',
  '<environment_context>',
  'Caveat: The messages below',
];

/** Re-exported for back-compat — the definition moved to transcript-wire.ts
 *  (EI-22171324436610992) so turn-provenance/turn-ref.ts can share it too
 *  without a circular import (this module already imports FROM turn-ref.ts).
 *  Re-exporting the IMPORTED binding (not `export … from`) so it's also
 *  bound locally for use inside this file's own parseClaudeLine, below. */
export { CLAUDE_OWNER_DIALOG_RESULT_PREFIXES };

/** Exported for the archive reader (session-archive-read.ts, P-009): archived
 *  bytes are VERBATIM, so anything surfaced to agents must retain the same
 *  secret redaction as the index, with an opt-in to recover past its cap. */
export interface TurnTextParseOptions {
  /** Return all parsed turn text while retaining the normal secret redaction. */
  fullSource?: boolean;
}

export function cleanTurnText(raw: string, options: TurnTextParseOptions = {}): string | null {
  const t = raw.trim();
  if (t.length < MIN_TEXT_LEN) return null;
  for (const p of BOILERPLATE_PREFIXES) if (t.startsWith(p)) return null;
  return redactSelfIdentifyingSecrets(options.fullSource ? t : t.slice(0, TEXT_CAP));
}

/**
 * The parts analog of cleanTurnText — cap + BOTH redaction passes, and
 * deliberately NO boilerplate/min-length filtering: this store exists to
 * render a transcript faithfully, so a `<system-reminder>` block or a
 * two-character tool result is real content here even though it is noise for
 * recall.
 *
 * Redact BEFORE capping so a secret straddling the cap boundary cannot be
 * half-preserved, and cap after so the stored bytes stay bounded.
 *
 * The cap is PER KIND (`partTextCapFor`): prose keeps everything the pane can
 * render, tool payloads keep the tighter volume cap. `kind` defaults to prose
 * because that is the safe direction to be wrong in — an over-wide store costs
 * bytes, an over-narrow one destroys a reader's content irrecoverably.
 */
export function cleanPartText(raw: string, kind: PartKind = 'text'): string {
  const redacted = redactKeyDirectedSecrets(redactSelfIdentifyingSecrets(raw));
  return capWithMarker(redacted, partTextCapFor(kind));
}

/** Join the text parts of a message content (string or parts array). */
export function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const p of content) {
    if (!p || typeof p !== 'object') continue;
    const part = p as { type?: string; text?: string };
    if (typeof part.text !== 'string') continue;
    if (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text') {
      parts.push(part.text);
    }
  }
  return parts.join('\n');
}

function parseTs(v: unknown): Date | null {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Lockstep with UserPromptSubmit's Python normalize/sha256_hex helpers. */
export function promptOriginHash(raw: string): string {
  return createHash('sha256').update(raw.replace(/\r\n?/g, '\n').trim(), 'utf8').digest('hex');
}

/**
 * Claude Code records a prompt sent while a turn is running as a top-level
 * `attachment` line rather than a normal `user` message. Only the
 * human-authored prompt variant belongs in the recall index: other queued
 * commands are client plumbing and must keep the existing skip behavior.
 */
function parseClaudeQueuedCommand(
  obj: Record<string, unknown>,
  options: TurnTextParseOptions = {},
): ParsedTurn | null {
  if (obj.type !== 'attachment') return null;
  const attachment = obj.attachment as {
    type?: unknown;
    commandMode?: unknown;
    origin?: { kind?: unknown };
    prompt?: unknown;
    timestamp?: unknown;
  } | undefined;
  if (
    !attachment ||
    attachment.type !== 'queued_command' ||
    attachment.commandMode !== 'prompt' ||
    attachment.origin?.kind !== 'human' ||
    typeof attachment.prompt !== 'string'
  ) {
    return null;
  }
  const text = cleanTurnText(attachment.prompt, options);
  if (!text) return null;
  return {
    ts: parseTs(attachment.timestamp) ?? parseTs(obj.timestamp),
    speaker: 'user',
    text,
    cwd: typeof obj.cwd === 'string' ? obj.cwd : null,
    sessionId:
      typeof obj.sessionId === 'string'
        ? obj.sessionId
        : typeof obj.session_id === 'string'
          ? obj.session_id
          : null,
    promptHash: promptOriginHash(attachment.prompt),
  };
}

/* ------------------------------------------------------------------ */
/* Per-client line parsers (exported for unit tests)                    */
/* ------------------------------------------------------------------ */

/** Claude Code line → turn. Lines include normal user/assistant messages and
 * the narrowly gated human `attachment.type='queued_command'` prompt shape. */
export function parseClaudeLine(line: string, options: TurnTextParseOptions = {}): ParsedTurn | null {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  const queuedCommand = parseClaudeQueuedCommand(obj, options);
  if (queuedCommand) return queuedCommand;
  if (obj.type !== 'user' && obj.type !== 'assistant') return null;
  const message = obj.message as { role?: string; content?: unknown; stop_reason?: unknown } | undefined;
  if (!message) return null;
  const speaker = message.role === 'user' ? 'user' : message.role === 'assistant' ? 'assistant' : null;
  if (!speaker) return null;
  let rawText = textFromContent(message.content);
  // EI-20772173866687919: AskUserQuestion answers are owner speech delivered
  // inside a synthetic `tool_result` user line. General tool results are a
  // 218 MB/week corpus and deliberately stay out of session_turns; promote
  // only Claude's stable owner-dialog result shape so sessions:search can find
  // the decision without flooding recall with tool output.
  if (!rawText && Array.isArray(message.content)) {
    for (const block of message.content) {
      if (!block || typeof block !== 'object') continue;
      const part = block as { type?: string; content?: unknown };
      if (part.type !== 'tool_result') continue;
      const payload = partPayloadText(part.content).trim();
      if (!CLAUDE_OWNER_DIALOG_RESULT_PREFIXES.some((prefix) => payload.startsWith(prefix))) continue;
      rawText = `${OWNER_DIALOG_TURN_MARKER}\n${payload}`;
      break;
    }
  }
  const text = cleanTurnText(rawText, options);
  if (!text) return null;
  const messageId = typeof obj.uuid === 'string' ? obj.uuid : null;
  const parentMessageId = typeof obj.parentUuid === 'string' ? obj.parentUuid : null;
  const stopReason = typeof message.stop_reason === 'string' ? message.stop_reason : null;
  const responseDisposition: ParsedResponseDisposition | null =
    speaker !== 'assistant'
      ? null
      : stopReason === 'end_turn'
        ? 'delivered'
        : stopReason === 'tool_use'
          ? 'progress'
          : obj.isApiErrorMessage === true || obj.error != null || stopReason === 'stop_sequence'
            ? 'interrupted'
            : null;
  return {
    ts: parseTs(obj.timestamp),
    speaker,
    text,
    cwd: typeof obj.cwd === 'string' ? obj.cwd : null,
    sessionId: typeof obj.sessionId === 'string' ? obj.sessionId : null,
    promptHash: speaker === 'user' ? promptOriginHash(rawText) : null,
    requestId: speaker === 'user' ? messageId : null,
    messageId,
    parentMessageId,
    responseDisposition,
  };
}

/** Render a tool_use `input` / tool_result `content` payload as display text.
 *  A string passes through; anything structured is JSON — the pane shows the
 *  argument object, which is what makes a tool call readable at all. */
/**
 * Claude tool_result content is usually [{type:'text',text}] — prefer the text
 * parts, and fall back to JSON for image/structured blocks.
 *
 * WI-41498: this is now the SHARED implementation in transcript-wire, imported
 * rather than kept here. The live-timeline parser had its own, weaker copy of
 * the same idea (`JSON.stringify` of anything non-string) and fell behind the
 * wire while this one stayed correct — with nothing to fail when they diverged.
 * The local alias is kept so this module's call sites read unchanged.
 */
const partPayloadText = blockPayloadText;

/**
 * Claude Code line → FAITHFUL parts (session-turn-storage-2026-07-28 P-001).
 *
 * The counterpart to parseClaudeLine, which stores at most one joined-text row
 * per line. This walks the content array in order and emits every renderable
 * block: text, thinking, tool_use (name + input), tool_result (payload).
 *
 * Exported for unit tests, same convention as the parseX/classifyX family.
 */
export function parseClaudeParts(line: string): ParsedPart[] {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return [];
  }
  if (obj.type !== 'user' && obj.type !== 'assistant') return [];
  const message = obj.message as { role?: string; content?: unknown } | undefined;
  if (!message) return [];
  const speaker = message.role === 'user' ? 'user' : message.role === 'assistant' ? 'assistant' : null;
  if (!speaker) return [];
  const ts = parseTs(obj.timestamp);
  const sessionId = typeof obj.sessionId === 'string' ? obj.sessionId : null;
  const out: ParsedPart[] = [];
  const push = (partKind: PartKind, raw: string, toolName?: string | null) => {
    const text = cleanPartText(raw, partKind);
    // A tool_use is worth a row on its NAME alone (an argument-less call is
    // still a real event in the transcript); every other kind needs content.
    if (!text.trim() && partKind !== 'tool_use') return;
    out.push({ ts, speaker, partKind, toolName: toolName ?? null, text, sessionId });
  };

  const content = message.content;
  if (typeof content === 'string') {
    push('text', content);
    return out;
  }
  if (!Array.isArray(content)) return out;
  for (const p of content) {
    if (!p || typeof p !== 'object') continue;
    const part = p as {
      type?: string; text?: string; thinking?: string;
      name?: string; input?: unknown; content?: unknown;
    };
    switch (part.type) {
      case 'text':
      case 'input_text':
      case 'output_text':
        push('text', typeof part.text === 'string' ? part.text : '');
        break;
      case 'thinking':
        // ⚠ In PRACTICE this stores nothing today, and that is deliberate —
        // do not "fix" it by widening the push() guard without reading D-007.
        //
        // Claude Code writes signature-only thinking records: the block is
        // {type,thinking,signature} with thinking === ''. Verified over the
        // real 7 d corpus (1,193 files / 6.4 M lines, both roots): 58,362 raw
        // `"type":"thinking"` blocks in the JSONL, ZERO thinking parts emitted
        // here — every one is dropped by the empty-text guard in push() above.
        //
        // That is the right outcome (an empty `[thinking]` entry is render
        // noise, and 58k content-free rows/week buy a reader nothing), and it
        // does NOT disturb ordering: part_idx is assigned over EMITTED parts,
        // so the parts that do render keep their relative order.
        //
        // The call stays because a build that DOES emit reasoning text — an
        // older transcript in this same corpus carries 1.5k thinking parts
        // with real prose — then flows through with no schema change.
        //
        // An earlier revision of this comment (and D-003) claimed thinking was
        // "stored so the part ORDER stays faithful". It never was. Corrected
        // 2026-07-28; see session-turn-storage-2026-07-28 D-007.
        push('thinking', typeof part.thinking === 'string' ? part.thinking : '');
        break;
      case 'tool_use':
        push('tool_use', partPayloadText(part.input), typeof part.name === 'string' ? part.name : null);
        break;
      case 'tool_result':
        push('tool_result', partPayloadText(part.content));
        break;
      default:
        break;
    }
  }
  return out;
}

/** OMP line → turn. Lines: {type:'message', timestamp, message:{role, content:[{type:'text',text}]}}. */
export function parseOmpLine(line: string, options: TurnTextParseOptions = {}): ParsedTurn | null {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (obj.type !== 'message') return null;
  const message = obj.message as {
    role?: string;
    content?: unknown;
    stopReason?: unknown;
    errorMessage?: unknown;
  } | undefined;
  if (!message) return null;
  const speaker = message.role === 'user' ? 'user' : message.role === 'assistant' ? 'assistant' : null;
  if (!speaker) return null;
  const rawText = textFromContent(message.content);
  const text = cleanTurnText(rawText, options);
  if (!text) return null;
  const messageId = typeof obj.id === 'string' ? obj.id : null;
  const parentMessageId = typeof obj.parentId === 'string' ? obj.parentId : null;
  const stopReason = typeof message.stopReason === 'string' ? message.stopReason : null;
  const responseDisposition: ParsedResponseDisposition | null =
    speaker !== 'assistant'
      ? null
      : stopReason === 'stop'
        ? 'delivered'
        : stopReason === 'toolUse'
          ? 'progress'
          : stopReason === 'aborted' || stopReason === 'error' || message.errorMessage != null
            ? 'interrupted'
            : null;
  return {
    ts: parseTs(obj.timestamp),
    speaker,
    text,
    requestId: speaker === 'user' ? messageId : null,
    messageId,
    parentMessageId,
    responseDisposition,
    promptHash: speaker === 'user' ? promptOriginHash(rawText) : null,
  };
}

/** Codex rollout line → turn. Lines: {timestamp, type:'response_item', payload:{type:'message', role, content:[{type:'input_text'|'output_text', text}]}}. */
export function parseCodexLine(line: string, options: TurnTextParseOptions = {}): ParsedTurn | null {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  // Fallback prompt history: {session_id, ts(seconds), text}. Current Codex
  // builds can emit this while leaving the rollout path unmaterialized.
  if (
    typeof obj.session_id === 'string' &&
    typeof obj.text === 'string' &&
    (typeof obj.ts === 'number' || typeof obj.ts === 'string')
  ) {
    const text = cleanTurnText(obj.text, options);
    if (!text) return null;
    const rawTs = obj.ts;
    const ts = typeof rawTs === 'number' && rawTs < 10_000_000_000
      ? new Date(rawTs * 1000)
      : parseTs(rawTs);
    return { ts, speaker: 'user', text, sessionId: obj.session_id, promptHash: promptOriginHash(obj.text) };
  }
  if (obj.type !== 'response_item') return null;
  const payload = obj.payload as {
    type?: string;
    role?: string;
    content?: unknown;
    id?: unknown;
    phase?: unknown;
    internal_chat_message_metadata_passthrough?: unknown;
  } | undefined;
  if (!payload || payload.type !== 'message') return null;
  const speaker = payload.role === 'user' ? 'user' : payload.role === 'assistant' ? 'assistant' : null;
  if (!speaker) return null; // 'developer'/'system' = injected instructions, skip
  const rawText = textFromContent(payload.content);
  const text = cleanTurnText(rawText, options);
  if (!text) return null;
  const metadata =
    payload.internal_chat_message_metadata_passthrough != null &&
    typeof payload.internal_chat_message_metadata_passthrough === 'object' &&
    !Array.isArray(payload.internal_chat_message_metadata_passthrough)
      ? payload.internal_chat_message_metadata_passthrough as Record<string, unknown>
      : null;
  const requestId = typeof metadata?.turn_id === 'string' ? metadata.turn_id : null;
  const phase = typeof payload.phase === 'string' ? payload.phase : null;
  const responseDisposition: ParsedResponseDisposition | null =
    speaker !== 'assistant'
      ? null
      : phase === 'final_answer'
        ? 'delivered'
        : phase === 'commentary'
          ? 'progress'
          : null;
  return {
    ts: parseTs(obj.timestamp),
    speaker,
    text,
    requestId,
    messageId: typeof payload.id === 'string' ? payload.id : null,
    parentMessageId: null,
    responseDisposition,
    // Correlate the hook's original prompt, before display cleanup/truncation.
    promptHash: speaker === 'user' ? promptOriginHash(rawText) : null,
  };
}

/**
 * Codex rollout line → FAITHFUL parts.
 *
 * Codex writes each renderable item as its own `response_item`: message text,
 * tool calls, tool results, and readable reasoning summaries.  The turn parser
 * above deliberately keeps only message text for recall; this companion keeps
 * the full renderable stream for `session_turn_parts`, matching the Claude
 * adapter's separation contract.
 *
 * `event_msg/agent_message` is intentionally ignored because it duplicates the
 * canonical `response_item/message` record in current Codex rollouts.  Storing
 * both would double every assistant message and make freshness appear newer
 * than the actual model turn.
 */
export function parseCodexParts(line: string): ParsedPart[] {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return [];
  }
  if (obj.type !== 'response_item') return [];

  const payload = obj.payload as {
    type?: string;
    role?: string;
    content?: unknown;
    name?: unknown;
    namespace?: unknown;
    arguments?: unknown;
    input?: unknown;
    query?: unknown;
    output?: unknown;
    summary?: unknown;
  } | undefined;
  if (!payload || typeof payload.type !== 'string') return [];

  const ts = parseTs(obj.timestamp);
  const out: ParsedPart[] = [];
  const push = (
    speaker: 'user' | 'assistant',
    partKind: PartKind,
    raw: string,
    toolName?: string | null,
  ) => {
    const text = cleanPartText(raw, partKind);
    // Preserve an argument-less tool call: its name is still a real event.
    if (!text.trim() && partKind !== 'tool_use') return;
    out.push({ ts, speaker, partKind, toolName: toolName ?? null, text });
  };

  if (payload.type === 'message') {
    const speaker = payload.role === 'user'
      ? 'user'
      : payload.role === 'assistant'
        ? 'assistant'
        : null;
    if (!speaker) return [];
    if (typeof payload.content === 'string') {
      push(speaker, 'text', payload.content);
      return out;
    }
    if (!Array.isArray(payload.content)) return out;
    for (const block of payload.content) {
      if (!block || typeof block !== 'object') continue;
      const part = block as { type?: string; text?: unknown };
      if (
        (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text') &&
        typeof part.text === 'string'
      ) {
        push(speaker, 'text', part.text);
      }
    }
    return out;
  }

  if (
    payload.type === 'function_call' ||
    payload.type === 'custom_tool_call' ||
    payload.type === 'tool_search_call'
  ) {
    const namespace = typeof payload.namespace === 'string' && payload.namespace
      ? `${payload.namespace}.`
      : '';
    const name = typeof payload.name === 'string' && payload.name
      ? payload.name
      : payload.type;
    push(
      'assistant',
      'tool_use',
      // WI-41498: field list shared with the live-timeline parser
      // (transcript-wire) rather than spelled out twice.
      partPayloadText(codexToolCallArgsRaw(payload)),
      `${namespace}${name}`,
    );
    return out;
  }

  if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
    push('user', 'tool_result', partPayloadText(payload.output));
    return out;
  }

  if (payload.type === 'reasoning' && Array.isArray(payload.summary)) {
    const summary = (payload.summary as Array<{ text?: unknown } | string>)
      .map((part) => (typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : ''))
      .filter(Boolean)
      .join(' ');
    push('assistant', 'thinking', summary);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Per-client line CLASSIFIERS (EI-9970) — every raw line, not just the  */
/* ones parseXLine turns into a stored session_turns row.                */
/* ------------------------------------------------------------------ */

/** Claude Code line → signal. tool_use blocks live in assistant content
 * arrays; tool_result blocks arrive as synthetic 'user'-role lines (not a
 * real prompt — excluded from isPrompt exactly like parseClaudeLine
 * already excludes them via the text-content shape, but tool_result
 * carriers pass textFromContent as empty since it only joins 'text' /
 * 'input_text' / 'output_text' parts, so no extra filtering is needed
 * there; the explicit check below is for clarity + a stable test pin). */
export function classifyClaudeLine(line: string): LineSignal | null {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (parseClaudeQueuedCommand(obj)) return { ...NULL_SIGNAL, isPrompt: true };
  if (obj.type !== 'user' && obj.type !== 'assistant') return null;
  const message = obj.message as { role?: string; content?: unknown; id?: string } | undefined;
  if (!message) return null;

  if (message.role === 'user') {
    const content = message.content;
    const isToolResultCarrier =
      Array.isArray(content) &&
      content.some((p) => p && typeof p === 'object' && (p as { type?: string }).type === 'tool_result');
    if (isToolResultCarrier) return NULL_SIGNAL;
    const text = cleanTurnText(textFromContent(content));
    return text ? { ...NULL_SIGNAL, isPrompt: true } : NULL_SIGNAL;
  }

  if (message.role === 'assistant') {
    const content = message.content;
    let hasText = false;
    let toolCallCount = 0;
    if (Array.isArray(content)) {
      for (const p of content) {
        if (!p || typeof p !== 'object') continue;
        const part = p as { type?: string; text?: string };
        if (part.type === 'tool_use') toolCallCount += 1;
        if (part.type === 'text' && typeof part.text === 'string' && part.text.trim().length >= MIN_TEXT_LEN) {
          hasText = true;
        }
      }
    } else if (typeof content === 'string' && content.trim().length >= MIN_TEXT_LEN) {
      hasText = true;
    }
    const isResponsePayload = hasText || toolCallCount > 0; // excludes pure-thinking-only stub lines
    const inferenceId = isResponsePayload
      ? (typeof message.id === 'string' ? message.id : (typeof obj.requestId === 'string' ? (obj.requestId as string) : null))
      : null;
    return { isPrompt: false, isResponsePayload, inferenceId, toolCallCount };
  }

  return null;
}

/** OMP line → signal. Tool calls are 'assistant'-role content items of
 * type 'toolCall'; tool results arrive as their OWN role ('toolResult'),
 * distinct from Claude's synthetic-user-line convention. */
export function classifyOmpLine(line: string): LineSignal | null {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (obj.type !== 'message') return null;
  const message = obj.message as { role?: string; content?: unknown } | undefined;
  if (!message) return null;

  if (message.role === 'user') {
    const text = cleanTurnText(textFromContent(message.content));
    return text ? { ...NULL_SIGNAL, isPrompt: true } : NULL_SIGNAL;
  }
  if (message.role === 'toolResult') return NULL_SIGNAL;

  if (message.role === 'assistant') {
    const content = message.content;
    let hasText = false;
    let toolCallCount = 0;
    if (Array.isArray(content)) {
      for (const p of content) {
        if (!p || typeof p !== 'object') continue;
        const part = p as { type?: string; text?: string };
        if (part.type === 'toolCall') toolCallCount += 1;
        if (part.type === 'text' && typeof part.text === 'string' && part.text.trim().length >= MIN_TEXT_LEN) {
          hasText = true;
        }
      }
    } else if (typeof content === 'string' && content.trim().length >= MIN_TEXT_LEN) {
      hasText = true;
    }
    const isResponsePayload = hasText || toolCallCount > 0;
    const inferenceId = isResponsePayload && typeof obj.id === 'string' ? obj.id : null;
    return { isPrompt: false, isResponsePayload, inferenceId, toolCallCount };
  }

  return null;
}

/** Codex rollout line → signal. Tool calls are their OWN response_item
 * (payload.type 'function_call' | 'custom_tool_call'), never nested inside
 * a message's content — so unlike Claude/OMP, a codex assistant 'message'
 * payload is already atomic (one payload.id = one real response). */
export function classifyCodexLine(line: string): LineSignal | null {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof obj.session_id === 'string' && typeof obj.text === 'string') {
    return cleanTurnText(obj.text) ? { ...NULL_SIGNAL, isPrompt: true } : NULL_SIGNAL;
  }
  if (obj.type !== 'response_item') return null;
  const payload = obj.payload as { type?: string; role?: string; content?: unknown; id?: string } | undefined;
  if (!payload) return null;

  if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
    return { ...NULL_SIGNAL, toolCallCount: 1 };
  }
  if (payload.type !== 'message') return null;

  if (payload.role === 'user') {
    const text = cleanTurnText(textFromContent(payload.content));
    return text ? { ...NULL_SIGNAL, isPrompt: true } : NULL_SIGNAL;
  }
  if (payload.role === 'assistant') {
    const inferenceId = typeof payload.id === 'string' ? payload.id : null;
    return { isPrompt: false, isResponsePayload: true, inferenceId, toolCallCount: 0 };
  }
  return null; // 'developer'/'system' = injected instructions, same as parseCodexLine
}

/* ------------------------------------------------------------------ */
/* Adapter registry                                                     */
/* ------------------------------------------------------------------ */

/** A transcript root + how many DIRECTORY levels sit between it and the
 * .jsonl files. Depth-bounded traversal is load-bearing: a blind
 * `readdir({recursive:true})` over ~/.papercusp/session-claude descends into
 * 15k+ per-session Claude-config clones (statsig caches, todos, …) — millions
 * of dentries, observed HANGING the sweep for minutes (2026-07-05). The
 * transcript layouts are fixed-shape, so we only walk the known levels. */
interface RootSpec {
  root: string;
  dirDepth: number;
  /** Optional per-level descend filter (1-based dir level under root). Lets a
   *  FAT root walk only its known layout — su-codex-homes holds ~20 subdirs
   *  per home but only <home>/sessions/YYYY/MM/DD carries transcripts;
   *  enumerating everything is the 2026-07-05 sweep-hang class. */
  descend?: (dirName: string, level: number) => boolean;
}

interface FileAdapter {
  sourceKind: Exclude<SourceKind, 'agent_chat'>;
  roots: () => RootSpec[];
  parseLine: (line: string) => ParsedTurn | null;
  /** EI-9970: classifies EVERY line for prompt/response/tool-call
   *  counting — a superset of parseLine's TEXT-TURNS-ONLY scope. */
  classifyLine: (line: string) => LineSignal | null;
  /**
   * P-001 (session-turn-storage-2026-07-28): every renderable content part of
   * the line, in order, for the FAITHFUL `session_turn_parts` companion store.
   * A strict superset of parseLine's scope.
   *
   * Optional: Claude and Codex implement it today. An adapter without it simply
   * contributes no parts — its pane keeps reading the file, exactly as before,
   * with no behavior change and no empty-render risk.
   */
  parseParts?: (line: string) => ParsedPart[];
  /** Best-effort provenance derived from the file path. */
  meta: (filePath: string) => {
    sessionId: string;
    owner: string | null;
    /** Managed OMP homes encode the adv_sessions row id in their path. */
    advSessionId?: number | null;
  };
  /**
   * P-002: per-TOOL / per-VERB usage extracted from the same pass, for the
   * bash→tool substitution metric.
   *
   * Optional because the shape is client-specific and only the Claude adapter
   * implements it today. `classifyLine` already sees every `tool_use` block but
   * deliberately reduces them to a COUNT — the substitution metric needs the
   * tool's NAME (and, for the shell tool, the command's verbs), which is a
   * strictly larger signal than the EI-9970 counters wanted.
   *
   * Extracted HERE, inside the existing incremental walk, rather than by a
   * second scanner: a standalone 7d sweep measures ~95s over 10.5M lines, and
   * transcripts roll off, so counting as we ingest is the only way the number
   * survives its own window (see `bash-substitution/usage-rollup.ts`).
   */
  usageOf?: (line: string) => LineUsage;
}

/** Resolve Codex rollout identity from its filename plus the per-session
 * CODEX_HOME diagnostics stamp. Shared ~/.codex rollouts intentionally have
 * no coordination owner; only managed su-codex-homes carry lockOwnerSid. */
export function codexTranscriptMeta(filePath: string): { sessionId: string; owner: string | null } {
  const stem = basename(filePath, '.jsonl');
  const sessionMatch = stem.match(/([0-9a-f]{8}-[0-9a-f-]{27,})$/i);
  const homeMatch = filePath.match(/^(.*\/su-codex-homes\/session-[^/]+)\/sessions\//);
  let owner: string | null = null;
  if (homeMatch) {
    try {
      const diagnostics = JSON.parse(
        readFileSync(join(homeMatch[1], 'papercusp-diagnostics.json'), 'utf8'),
      ) as { lockOwnerSid?: unknown };
      if (typeof diagnostics.lockOwnerSid === 'string' && diagnostics.lockOwnerSid.trim()) {
        owner = diagnostics.lockOwnerSid;
      }
    } catch {
      // A legacy/raced home has no trustworthy owner stamp; leave it unowned.
    }
  }
  return { sessionId: sessionMatch ? sessionMatch[1] : stem, owner };
}

/**
 * Resolve OMP transcript identity from its filename and, when present, the
 * managed per-session home. Shared ~/.omp transcripts intentionally have no
 * coordination owner. A psu-launched OMP home is named
 * `su-omp-homes/session-<advSessionId>/...`; the numeric directory is the
 * durable join key to adv_sessions, while the filename suffix is OMP's native
 * thread/session id.
 */
export function ompTranscriptMeta(filePath: string): {
  sessionId: string;
  owner: string | null;
  advSessionId: number | null;
} {
  const stem = basename(filePath, '.jsonl');
  const us = stem.indexOf('_');
  const sessionId = us >= 0 ? stem.slice(us + 1) : stem;
  const managed = filePath.match(/(?:^|\/)su-omp-homes\/session-(\d+)\/agent\/sessions(?:\/|$)/);
  if (!managed) return { sessionId, owner: null, advSessionId: null };
  const advSessionId = Number(managed[1]);
  return Number.isSafeInteger(advSessionId) && advSessionId > 0
    ? { sessionId, owner: null, advSessionId }
    : { sessionId, owner: null, advSessionId: null };
}

/** Metadata that can be recovered from a managed Codex transcript without
 * reading any conversational content. The numeric home key is the
 * adv_sessions row id; the rollout filename is Codex's native session id. */
export interface CodexAdvSessionMetadata {
  advSessionId: number;
  sessionId: string;
  model: string | null;
  effort: string | null;
}

const CODEX_NATIVE_SESSION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Parse the two root-level Codex settings we use for launch attribution.
 * This is intentionally a tiny, fail-soft reader rather than a general TOML
 * parser: config.toml is generated by Codex, and these values are always
 * quoted root keys. Keeping the parser narrow also prevents a profile/table
 * override from being mistaken for the session's effective default. */
export function parseCodexEffectiveConfig(configText: string): {
  model: string | null;
  effort: string | null;
} {
  let model: string | null = null;
  let effort: string | null = null;
  let inTable = false;
  for (const line of configText.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) {
      inTable = true;
      continue;
    }
    if (inTable) continue;
    const match = line.match(/^\s*(model|model_reasoning_effort)\s*=\s*["']([^"']+)["']\s*(?:#.*)?$/);
    if (!match) continue;
    if (match[1] === 'model') model = match[2];
    else effort = match[2];
  }
  return { model, effort };
}

/** Resolve the adv-session id from a per-session Codex home. Shared
 * `~/.codex` files and temporary port homes are deliberately excluded: they
 * do not contain an authoritative adv_sessions row key. */
function codexAdvSessionHome(filePath: string): { advSessionId: number; home: string } | null {
  const match = filePath.match(/(?:^|\/)(su-codex-homes\/session-(\d+))(?:\/|$)/);
  if (!match) return null;
  const advSessionId = Number(match[2]);
  if (!Number.isSafeInteger(advSessionId) || advSessionId <= 0) return null;
  const marker = `/${match[1]}`;
  const markerAt = filePath.indexOf(marker);
  return {
    advSessionId,
    home: markerAt >= 0 ? filePath.slice(0, markerAt + marker.length) : '',
  };
}

/** Read Codex's effective model/effort and native id for one managed rollout.
 * Missing config is expected after archive/reaper cleanup: native-id repair
 * still proceeds, while model/effort remain null until a live config is seen. */
export function codexAdvSessionMetadata(
  filePath: string,
  sessionIdOverride?: string | null,
): CodexAdvSessionMetadata | null {
  const home = codexAdvSessionHome(filePath);
  if (!home) return null;
  const sessionId = sessionIdOverride?.trim() || codexTranscriptMeta(filePath).sessionId;
  if (!CODEX_NATIVE_SESSION_ID_RE.test(sessionId)) return null;
  let model: string | null = null;
  let effort: string | null = null;
  try {
    const config = parseCodexEffectiveConfig(readFileSync(join(home.home, 'config.toml'), 'utf8'));
    model = config.model;
    effort = config.effort;
  } catch {
    // The home can be reaped immediately after the rollout is discovered.
  }
  return { advSessionId: home.advSessionId, sessionId, model, effort };
}

const HOME = homedir();

export const FILE_ADAPTERS: FileAdapter[] = [
  {
    sourceKind: 'claude',
    usageOf: extractLineUsage,
    roots: () => [
      // ~/.claude/projects/<munged-cwd>/<uuid>.jsonl
      { root: join(HOME, '.claude', 'projects'), dirDepth: 1 },
      // ~/.papercusp/session-claude/<ownerId>/projects/<munged-cwd>/<uuid>.jsonl
      { root: join(HOME, '.papercusp', 'session-claude'), dirDepth: 3 },
    ],
    parseLine: parseClaudeLine,
    classifyLine: classifyClaudeLine,
    parseParts: parseClaudeParts,
    meta: (filePath) => {
      // psu isolation dir carries the launching session's owner dir:
      // ~/.papercusp/session-claude/<ownerDir>/projects/<munged-cwd>/<uuid>.jsonl
      const m = filePath.match(/\/session-claude\/([^/]+)\//);
      return { sessionId: basename(filePath, '.jsonl'), owner: m ? m[1] : null };
    },
  },
  {
    sourceKind: 'omp',
    roots: () => [
      // ~/.omp/agent/sessions/<munged-cwd>/<ts>_<uuid>.jsonl
      { root: join(HOME, '.omp', 'agent', 'sessions'), dirDepth: 1 },
      // psu isolation dir — a psu-launched OMP agent gets a PER-SESSION omp home and
      // never writes to ~/.omp, so without this root every psu OMP transcript is
      // invisible to the index (EI-20212281439039808). The claude adapter above has
      // carried its psu root for a while; this pair must not drift again — guarded by
      // session-ingest-psu-roots.test.ts.
      // ~/.papercusp/su-omp-homes/session-<advSessionId>/agent/sessions/<munged-cwd>/<ts>_<uuid>.jsonl
      { root: join(HOME, '.papercusp', 'su-omp-homes'), dirDepth: 4 },
    ],
    parseLine: parseOmpLine,
    classifyLine: classifyOmpLine,
    meta: ompTranscriptMeta,
  },
  {
    sourceKind: 'codex',
    // ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl
    roots: () => [
      { root: join(HOME, '.codex', 'sessions'), dirDepth: 3 },
      // Per-session CODEX_HOMEs: <home>/sessions/YYYY/MM/DD/rollout-*.jsonl.
      // session-db-archive-retire-dirs-2026-07-10 P-005: fleet codex sessions
      // previously had ZERO session_turns rows — only the shared ~/.codex was
      // walked. descend pins level 2 to 'sessions' so the walk never
      // enumerates the ~20 unrelated subdirs of every home.
      {
        root: join(HOME, '.papercusp', 'su-codex-homes'),
        dirDepth: 5,
        descend: (name, level) => (level === 2 ? name === 'sessions' : true),
      },
    ],
    parseLine: parseCodexLine,
    classifyLine: classifyCodexLine,
    parseParts: parseCodexParts,
    meta: codexTranscriptMeta,
  },
];

/** Collect *.jsonl exactly `dirDepth` directory levels under `root` (BFS,
 * never descending past the known layout — see RootSpec). Exported for the
 * walker's own tests (P-005 descend-filter contract). */
export async function jsonlAtDepth(
  root: string,
  dirDepth: number,
  descend?: (dirName: string, level: number) => boolean,
): Promise<string[]> {
  let dirs = [root];
  for (let d = 0; d < dirDepth; d += 1) {
    const next: string[] = [];
    for (const dir of dirs) {
      try {
        for (const e of await readdir(dir, { withFileTypes: true })) {
          if (!e.isDirectory()) continue;
          if (descend && !descend(e.name, d + 1)) continue;
          next.push(join(dir, e.name));
        }
      } catch { /* absent / raced — skip */ }
    }
    dirs = next;
    if (!dirs.length) return [];
  }
  const files: string[] = [];
  for (const dir of dirs) {
    try {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        if (e.isFile() && e.name.endsWith('.jsonl')) files.push(join(dir, e.name));
      }
    } catch { /* skip */ }
  }
  return files;
}

/* ------------------------------------------------------------------ */
/* Tailer                                                               */
/* ------------------------------------------------------------------ */

interface TurnRow {
  workspace_id: string;
  source_kind: string;
  session_id: string;
  turn_idx: number;
  /** ISO string — postgres-js's sql(rows) bulk-insert helper rejects Date values. */
  ts: string | null;
  owner: string | null;
  harness_slug: string | null;
  cwd: string | null;
  speaker: string;
  text: string;
  /** Provenance, stamped at insert by `stampTurnProvenance` — never by the
   *  adapters. Optional on the way in, always set on the way out. */
  turn_origin?: string | null;
  turn_origin_verdict?: string | null;
  turn_origin_classifier_version?: number | null;
  /** Insert-only correlation material; never persisted on session_turns. */
  prompt_hash?: string | null;
}

/**
 * A file-backed CLI row without an enrollment envelope has no trustworthy
 * authorship signal.  Keep that uncertainty explicit in the persisted
 * verdict instead of allowing `owner-typed` (the catalogue's residual) to
 * assert that the owner wrote it.
 *
 * This is intentionally an ingest-only verdict.  `classifyRecordedTurn`
 * remains the shared text classifier used by owner-facing surfaces, where
 * known machine markers still have a useful, bounded display decision.
 */
export const UNENROLLED_ORIGIN_VERDICT = 'unenrolled-origin';

/** Durable identity of a successful exact hook-receipt correlation. Unlike
 * the old owner-typed text residual, this survives receipt expiry and lets
 * the classifier backfill preserve positive evidence without guessing. */
export const HOOK_AUTHENTICATED_PROMPT_ORIGIN = 'hook-authenticated-prompt';

/**
 * Source kinds whose `speaker='user'` rows may arrive without an enrollment
 * envelope, and whose uncorrelated `owner-typed` residual is therefore
 * downgraded to `UNENROLLED_ORIGIN_VERDICT` below. A matching
 * hook-authenticated prompt-origin stamp can promote the exact row back to
 * `owner-typed` during insertion (the current query reads Claude stamps).
 *
 * EXPORTED because that downgrade has a consequence a READER must be told
 * about: the residual can remain `unenrolled-origin`, so a provenance-filtered
 * search over a CLI session may return a sparse or zero result that looks
 * exactly like "the owner never said it". `sessions:search` derives its
 * zero-hit caveat from this set and describes the correlation exception rather
 * than restating an impossible structural claim in prose.
 */
export const FILE_BACKED_SOURCE_KINDS = new Set<SourceKind>(['claude', 'omp', 'codex']);

/** Tight enough to distinguish repeated prompts, wide enough for a delayed
 * ingest tick. The durable stamp itself expires after ten minutes. */
export const PROMPT_ORIGIN_MATCH_WINDOW_MS = 2 * 60 * 1000;

export interface PromptOriginStamp {
  source_kind: string;
  session_id: string;
  prompt_hash: string;
  submitted_at: Date | string;
  /** Validity is anchored to the TURN it authenticates, never to ingest time
   *  (WI-10006568): a stamp vouches for a prompt typed before it expired. */
  expires_at?: Date | string | null;
}

/** Upgrade only the exact v5 uncertainty state. An authenticated stamp can
 * never override an envelope or catalogue machine verdict. */
export function correlatePromptOriginStamps(rows: TurnRow[], stamps: PromptOriginStamp[]): number {
  const used = new Set<number>();
  let matched = 0;
  for (const row of rows) {
    if (
      row.turn_origin_classifier_version !== MACHINE_SURFACE_CATALOGUE_VERSION ||
      row.turn_origin_verdict !== UNENROLLED_ORIGIN_VERDICT ||
      !row.prompt_hash ||
      !row.ts
    ) continue;
    const rowMs = Date.parse(row.ts);
    if (!Number.isFinite(rowMs)) continue;
    let best = -1;
    let bestDelta = Number.POSITIVE_INFINITY;
    for (let i = 0; i < stamps.length; i += 1) {
      if (used.has(i)) continue;
      const stamp = stamps[i];
      if (
        stamp.source_kind !== row.source_kind ||
        stamp.session_id !== row.session_id ||
        stamp.prompt_hash !== row.prompt_hash
      ) continue;
      // An expired stamp cannot vouch for a prompt typed after it expired. It
      // is compared with the TURN's own time, not with now(): measuring it
      // against ingest time lost every owner turn ingested more than one TTL
      // late (WI-10006568, 58 rows measured).
      if (stamp.expires_at != null && !(new Date(stamp.expires_at).getTime() > rowMs)) continue;
      const submittedMs = new Date(stamp.submitted_at).getTime();
      const delta = Math.abs(rowMs - submittedMs);
      if (Number.isFinite(delta) && delta <= PROMPT_ORIGIN_MATCH_WINDOW_MS && delta < bestDelta) {
        best = i;
        bestDelta = delta;
      }
    }
    if (best < 0) continue;
    used.add(best);
    row.turn_origin = HOOK_AUTHENTICATED_PROMPT_ORIGIN;
    row.turn_origin_verdict = 'owner-typed';
    matched += 1;
  }
  return matched;
}

function isUnenrolledFileRow(row: Pick<TurnRow, 'source_kind' | 'speaker'>): boolean {
  return row.speaker === 'user' && FILE_BACKED_SOURCE_KINDS.has(row.source_kind as SourceKind);
}

async function listCandidateFiles(
  adapter: FileAdapter,
  sinceMs: number,
): Promise<Array<{ path: string; size: number; mtimeMs: number }>> {
  const out: Array<{ path: string; size: number; mtimeMs: number }> = [];
  for (const spec of adapter.roots()) {
    const paths = await jsonlAtDepth(spec.root, spec.dirDepth, spec.descend);
    for (const p of paths) {
      try {
        const s = await stat(p);
        if (!s.isFile() || s.mtimeMs < sinceMs || s.size === 0) continue;
        out.push({ path: p, size: s.size, mtimeMs: s.mtimeMs });
      } catch {
        /* raced deletion — skip */
      }
    }
  }
  return out;
}

/** A managed fork can leave a seed copy with the source session's native id in
 * the fork owner's directory, including after the original file is archived.
 * Resolve path owners from psu's first-write-wins birth index before decoding
 * or repairing indexed turns. An absent index preserves the path fallback. */
async function indexedClaudeOwnersForCandidates(
  adapter: FileAdapter,
  candidates: ReadonlyArray<{ path: string }>,
): Promise<Map<string, string>> {
  const sessionIds = new Set<string>();
  for (const candidate of candidates) {
    const { sessionId, owner } = adapter.meta(candidate.path);
    if (owner) sessionIds.add(sessionId);
  }
  const resolved = new Map<string, string>();
  const ids = [...sessionIds];
  for (let start = 0; start < ids.length; start += 32) {
    await Promise.all(ids.slice(start, start + 32).map(async (sessionId) => {
      const indexed = await indexedClaudeOwner(sessionId);
      if (indexed) resolved.set(sessionId, indexed);
    }));
  }
  return resolved;
}

const indexedClaudeOwnerCache = pinModuleState<Map<string, { owner: string | null; at: number }>>(
  '@papercusp/operator-core.indexedClaudeOwners', () => new Map(),
);

async function indexedClaudeOwner(sessionId: string): Promise<string | null> {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(sessionId)) return null;
  const cached = indexedClaudeOwnerCache.get(sessionId);
  if (cached && (cached.owner || Date.now() - cached.at < 60_000)) return cached.owner;
  let owner: string | null = null;
  try {
    const indexed = JSON.parse(await readFile(
      join(HOME, '.papercusp', 'psu-session-owners', sessionId), 'utf8',
    )) as { ownerId?: unknown };
    owner = typeof indexed.ownerId === 'string' && indexed.ownerId ? indexed.ownerId : null;
  } catch { /* older/untracked sessions have no birth index */ }
  indexedClaudeOwnerCache.delete(sessionId);
  indexedClaudeOwnerCache.set(sessionId, { owner, at: Date.now() });
  if (indexedClaudeOwnerCache.size > 20_000) {
    const oldest = indexedClaudeOwnerCache.keys().next().value;
    if (oldest) indexedClaudeOwnerCache.delete(oldest);
  }
  return owner;
}

/** Read complete lines from `filePath` starting at `offset`, bounded. Returns
 * the parsed-turn list + the new offset (end of last complete line), plus
 * (EI-9970) the prompt/response/tool-call deltas classifyLine finds across
 * the SAME line window — a superset of parseLine's stored-row scope.
 * `lastInferenceId` carries the previous tick's dedup cursor in, so a model
 * response split across a tick boundary is never double-counted. Exported
 * for its own fixture test (EI-9970 recurrence guard — the split-response
 * dedup contract), same convention as jsonlAtDepth. */
export async function readNewLines(
  filePath: string,
  offset: number,
  parseLine: (l: string) => ParsedTurn | null,
  classifyLine: (l: string) => LineSignal | null,
  lastInferenceId: string | null,
  usageOf?: (l: string) => LineUsage,
  substitutionRows: SubstitutionRow[] = [],
  parseParts?: (l: string) => ParsedPart[],
): Promise<{
  turns: ParsedTurn[];
  /** P-001 faithful parts — empty when the adapter has no `parseParts`. */
  parts: ParsedPart[];
  newOffset: number;
  promptCount: number;
  responseCount: number;
  toolCallCount: number;
  lastInferenceId: string | null;
  /** P-002 per-tool/per-verb usage; empty when the adapter has no extractor. */
  usage: UsageRollup;
}> {
  // Declared up front so every early return reports the same (empty) shape —
  // a caller must never have to distinguish "no usage extractor" from "this
  // tick read nothing".
  const usage: UsageRollup = new Map();
  const fh = await open(filePath, 'r');
  try {
    const s = await fh.stat();
    if (s.size <= offset) {
      return { turns: [], parts: [], newOffset: offset, promptCount: 0, responseCount: 0, toolCallCount: 0, lastInferenceId, usage };
    }
    const toRead = Math.min(s.size - offset, MAX_BYTES_PER_FILE_PER_TICK);
    const buf = Buffer.alloc(toRead);
    await fh.read(buf, 0, toRead, offset);
    const chunk = buf.toString('utf8');
    const lastNl = chunk.lastIndexOf('\n');
    if (lastNl < 0) {
      // A single Codex record can exceed the 5 MiB tick window (for example a
      // tool result carrying a screenshot or a very large command response).
      // Returning the same offset wedges this file forever: every later tick
      // rereads the same prefix and again finds no newline. Scan forward with
      // bounded memory and skip that one unindexable record once it is
      // complete; subsequent normal turns remain searchable. If the record is
      // still being written and has no newline yet, retain the offset so a
      // partial record is never mistaken for complete data.
      const scanSize = 1024 * 1024;
      let cursor = offset + toRead;
      while (cursor < s.size) {
        const size = Math.min(scanSize, s.size - cursor);
        const scan = Buffer.alloc(size);
        await fh.read(scan, 0, size, cursor);
        const nl = scan.indexOf(0x0a);
        if (nl >= 0) {
          return {
            turns: [],
            parts: [],
            newOffset: cursor + nl + 1,
            promptCount: 0,
            responseCount: 0,
            toolCallCount: 0,
            lastInferenceId,
            usage,
          };
        }
        cursor += size;
      }
      return { turns: [], parts: [], newOffset: offset, promptCount: 0, responseCount: 0, toolCallCount: 0, lastInferenceId, usage };
    }
    const usable = chunk.slice(0, lastNl + 1);
    const turns: ParsedTurn[] = [];
    const parts: ParsedPart[] = [];
    let promptCount = 0;
    let responseCount = 0;
    let toolCallCount = 0;
    let cursor = lastInferenceId;
    // WI-5218: this loop does per-line JSON.parse (parseLine + classifyLine)
    // fully synchronously with zero await points — on a large transcript file
    // (up to MAX_BYTES_PER_FILE_PER_TICK = 5 MiB, tens of thousands of lines)
    // that blocks the main thread long enough to starve the routine ticker
    // (measured: 10-50 loop-governor "event loop recovered" recoveries/h,
    // blender scout recombine timeouts, outbox-drain pass-timeouts — root
    // cause confirmed via journal correlation, session-ingest pass durations
    // trending to 20-30s as scanned-file count grew). Cooperative-yield every
    // LINE_YIELD_EVERY lines: cheap on a quiet host (a handful of macrotask
    // hops per file), aggressive under real pressure (cooperativeYield yields
    // on every call once loopPressure() is already elevated) — same fix class
    // as the WI-2344 precedent (plugin-host boot warm-up).
    let yielded = 0;
    for (const line of usable.split('\n')) {
      if (line.trim()) {
        const t = parseLine(line);
        if (t) turns.push(t);
        if (parseParts) {
          // P-001. Same pass as parseLine/classifyLine — the per-line
          // JSON.parse is the expensive thing (WI-5218), so a second walk to
          // extract parts would add a third full parse of every line.
          // Fail-soft per line: a malformed part must never cost the TURN.
          try {
            for (const p of parseParts(line)) parts.push(p);
          } catch { /* one bad line, not the file */ }
        }
        const sig = classifyLine(line);
        if (sig) {
          if (sig.isPrompt) promptCount += 1;
          toolCallCount += sig.toolCallCount;
          if (sig.isResponsePayload) {
            // A null id is never deduped (no basis to compare); a stable id only
            // counts as a NEW response when it differs from the immediately
            // preceding response line's id (a multi-line split shares one id).
            if (sig.inferenceId === null || sig.inferenceId !== cursor) responseCount += 1;
            cursor = sig.inferenceId;
          }
        }
        if (usageOf) {
          // P-002. Folded into the SAME pass — the per-line JSON.parse is
          // already the expensive thing here (WI-5218), so a second walk just
          // to count tools would double the cost of the hot loop.
          // Undated records are dropped rather than dated "now": the metric is
          // read as a ts-window, and defaulting would inflate whichever window
          // happened to be running.
          try {
            const u = usageOf(line);
            for (const obs of u.toolUses) addToolUse(usage, obs, null, substitutionRows);
            if (u.resultBytes > 0) addResultBytes(usage, u.resultBytes, dayOf(u.ts));
          } catch {
            // A metric must never cost an ingest. Skip this line's counts.
          }
        }
      }
      yielded = await cooperativeYield(yielded, LINE_YIELD_EVERY);
    }
    return {
      turns,
      parts,
      newOffset: offset + Buffer.byteLength(usable, 'utf8'),
      promptCount,
      responseCount,
      toolCallCount,
      lastInferenceId: cursor,
      usage,
    };
  } finally {
    await fh.close();
  }
}

/**
 * Persist one tick's per-tool/per-verb counts (P-002).
 *
 * BEST-EFFORT BY CONTRACT, and called AFTER the offset has advanced. The
 * tradeoff is deliberate and worth stating: if this write fails, that tick's
 * counts are lost for good (those bytes will not be re-read). The alternative —
 * writing the rollup before the offset so a failure retries — would let a
 * persistently failing metric WEDGE transcript ingestion for the whole fleet.
 * A metric is never allowed to damage the pipeline it measures, so it loses
 * rather than blocks, and the caller only counts the error.
 *
 * Idempotent per (workspace, source, session, day, tool, verb, intent_label):
 * counts are ADDED on conflict, since each call carries only the delta this
 * tick read. The conflict target MUST stay in lockstep with the table's primary
 * key (migration 674 widened it with intent_label) — a narrower target would
 * fold a bucket row into the per-call row and corrupt the headline count.
 */
async function writeUsageRollup(
  sql: Sql,
  sourceKind: string,
  sessionId: string,
  usage: UsageRollup,
): Promise<void> {
  const rows = rollupRows(usage);
  if (!rows.length) return;
  const days = rows.map((r) => r.day);
  const tools = rows.map((r) => r.toolName);
  const verbs = rows.map((r) => r.verb ?? '');
  const intents = rows.map((r) => r.intentLabel ?? '');
  const calls = rows.map((r) => r.calls);
  const atoms = rows.map((r) => r.atoms);
  const bytes = rows.map((r) => r.resultBytes);
  await sql`
    INSERT INTO harness_shared.tool_usage_rollup
      (workspace_id, source_kind, session_id, day, tool_name, verb, intent_label, calls, atoms, result_bytes)
    SELECT 'default', ${sourceKind}, ${sessionId}, d::date, t, v, i, c, a, b
      FROM UNNEST(
        ${sql.array(days)}::text[], ${sql.array(tools)}::text[], ${sql.array(verbs)}::text[],
        ${sql.array(intents)}::text[],
        ${sql.array(calls)}::bigint[], ${sql.array(atoms)}::bigint[], ${sql.array(bytes)}::bigint[]
      ) AS u(d, t, v, i, c, a, b)
    ON CONFLICT (workspace_id, source_kind, session_id, day, tool_name, verb, intent_label) DO UPDATE
      SET calls        = harness_shared.tool_usage_rollup.calls + EXCLUDED.calls,
          atoms        = harness_shared.tool_usage_rollup.atoms + EXCLUDED.atoms,
          result_bytes = harness_shared.tool_usage_rollup.result_bytes + EXCLUDED.result_bytes,
          updated_at   = now()
  `;
}

/**
 * Stamp owner-vs-machine provenance onto a row, in place.
 *
 * WHY HERE AND NOT IN THE ADAPTERS. This is the single choke point every
 * adapter's rows funnel through, so stamping here covers claude/omp/codex/
 * agent_chat by construction — a new adapter cannot forget to do it, which is
 * the failure mode that produced four divergent private classifiers in the
 * first place (plan owner-visibility-provenance-2026-08-11 D-013).
 *
 * WHY ONLY `user` TURNS GET CLASSIFIED. `classifyRecordedTurn` answers "is this
 * recorded USER turn owner-typed", and it reaches `owner-typed` as the RESIDUAL
 * — no rule matched. Assistant turns never carry an envelope and never match a
 * machine-surface pattern, so applying it unguarded would stamp `owner-typed`
 * on every one of them (25,198 in a measured 3-day window would have
 * qualified). They get the explicit `not-user-turn` verdict instead, which is
 * also what keeps NULL meaning exactly one thing — see below.
 *
 * NULL vs 'unknown' IS LOAD-BEARING. Every row written here gets a non-NULL
 * verdict AND version, so a NULL verdict means precisely "ingested before this
 * feature, never classified" and nothing else. 'unknown' is reserved for
 * classified-but-undeterminable. Collapsing the two re-creates the
 * EI-13472/WI-37419 failure — a real owner directive that simply is not
 * turn-stamped being read as fabricated — with database authority behind it.
 */
export function stampTurnProvenance(row: TurnRow): void {
  row.turn_origin_classifier_version = MACHINE_SURFACE_CATALOGUE_VERSION;

  if (row.speaker !== 'user') {
    row.turn_origin = null;
    row.turn_origin_verdict = 'not-user-turn';
    return;
  }

  // Head-anchored by construction: the classifier and its predicates apply
  // their own CLASSIFY_HEAD_CHARS bound, so passing the full text cannot widen
  // the match onto an owner's mid-body quote of an envelope.
  const { verdict, origin } = classifyRecordedTurn(row.text);
  // Native CLI file surfaces cannot enroll their own user rows.  A clean row
  // therefore proves neither owner authorship nor machine authorship: the
  // classifier's owner-typed residual is an unsafe database assertion here.
  // Preserve explicit envelope and catalogue verdicts, which have their own
  // authored/curated evidence, and make only the residual honest uncertainty.
  if (isUnenrolledFileRow(row) && verdict === 'owner-typed') {
    row.turn_origin = null;
    row.turn_origin_verdict = UNENROLLED_ORIGIN_VERDICT;
    return;
  }
  row.turn_origin = origin;
  row.turn_origin_verdict = verdict;
}

export async function insertTurns(sql: Sql, rows: TurnRow[]): Promise<number> {
  if (!rows.length) return 0;
  for (const row of rows) stampTurnProvenance(row);
  const candidates = rows.filter((row) => row.prompt_hash && row.ts && row.turn_origin_verdict === UNENROLLED_ORIGIN_VERDICT);
  if (candidates.length) {
    const sourceKinds = [...new Set(candidates.map((row) => row.source_kind))];
    const sessionIds = [...new Set(candidates.map((row) => row.session_id))];
    const promptHashes = [...new Set(candidates.map((row) => row.prompt_hash!))];
    const times = candidates.map((row) => Date.parse(row.ts!)).filter(Number.isFinite);
    if (times.length) {
      const from = new Date(Math.min(...times) - PROMPT_ORIGIN_MATCH_WINDOW_MS);
      const to = new Date(Math.max(...times) + PROMPT_ORIGIN_MATCH_WINDOW_MS);
      const stamps = await sql<PromptOriginStamp[]>`
        SELECT source_kind, session_id, prompt_hash, submitted_at, expires_at
          FROM harness_shared.session_prompt_origin_stamps
         WHERE workspace_id = ${activeWorkspaceId()}
           AND source_kind = ANY(${sql.array(sourceKinds)}::text[])
           AND session_id = ANY(${sql.array(sessionIds)}::text[])
           AND prompt_hash = ANY(${sql.array(promptHashes)}::text[])
           AND submitted_at BETWEEN ${from} AND ${to}
      `;
      // Expiry is checked per row inside correlatePromptOriginStamps, against
      // the turn's own timestamp. An `expires_at > now()` filter here made
      // the verdict depend on ingest lag (WI-10006568).
      correlatePromptOriginStamps(rows, stamps);
    }
  }
  // ON CONFLICT DO NOTHING: idempotent re-ingest (e.g. a reset offset) can
  // never duplicate — the PK is (workspace_id, source_kind, session_id, turn_idx).
  const r = await sql`
    INSERT INTO harness_shared.session_turns ${sql(
      rows as unknown as Record<string, unknown>[],
      'workspace_id', 'source_kind', 'session_id', 'turn_idx', 'ts',
      'owner', 'harness_slug', 'cwd', 'speaker', 'text',
      'turn_origin', 'turn_origin_verdict', 'turn_origin_classifier_version',
    )}
    ON CONFLICT DO NOTHING
  `;
  return r.count ?? rows.length;
}

interface PartRow {
  workspace_id: string;
  source_kind: string;
  session_id: string;
  part_idx: number;
  ts: string | null;
  owner: string | null;
  speaker: string;
  part_kind: string;
  tool_name: string | null;
  text: string;
}

/** The small projected-tool shape needed to resolve transcript tool names.
 * Keep this structural so pure tests can inject a catalog without importing
 * the agent-tools barrel (which has process-wide boot side effects). */
export interface SessionPartToolCatalogEntry {
  expose?: { mcp?: { name?: unknown } | null };
}

/**
 * Add one client spelling to the catalog-backed alias map. A separator
 * spelling can be ambiguous when two canonical names differ only by a
 * separator (for example `foo:bar_baz` and `foo_bar:baz`). In that case the
 * safe result is to leave the raw transcript name untouched rather than
 * silently attributing it to the wrong tool.
 */
function addSessionPartToolAlias(
  aliases: Map<string, string>,
  ambiguous: Set<string>,
  alias: string,
  canonical: string,
): void {
  if (ambiguous.has(alias)) return;
  const prior = aliases.get(alias);
  if (prior === undefined) {
    aliases.set(alias, canonical);
  } else if (prior !== canonical) {
    aliases.delete(alias);
    ambiguous.add(alias);
  }
}

/**
 * Resolve the two client-mangled Papercusp MCP spellings persisted by Codex
 * and Claude to the live projected catalog's canonical `group:verb` name.
 *
 * This is intentionally NOT `normalizeMcpName`: that helper is tolerant for
 * dispatch and can turn an unknown or separator-ambiguous transcript value
 * into a guessed tool. Session history is an evidence store, so only exact
 * aliases derived from currently projected tools are safe to rewrite. Native
 * names (`Bash`, `Read`), unknown wrappers, and ambiguous aliases remain
 * byte-for-byte unchanged.
 *
 * The optional catalog is a pure-test seam. Production callers omit it and
 * read the current process-global projected catalog at the write boundary so
 * newly installed tools do not require a second static allowlist.
 */
export function canonicalSessionPartToolName(
  name: string,
  catalog: readonly SessionPartToolCatalogEntry[] = listAllProjectedTools(),
): string {
  if (!name) return name;

  return sessionPartToolAliases(catalog).get(name) ?? name;
}

/** Build the aliases once per ingest chunk rather than once per part. */
function sessionPartToolAliases(
  catalog: readonly SessionPartToolCatalogEntry[],
): ReadonlyMap<string, string> {
  const aliases = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const entry of catalog) {
    const canonical = entry.expose?.mcp?.name;
    // Plugin projections use their own namespaced forms; the two aliases this
    // repair covers are the core `group:verb` MCP projections only.
    if (typeof canonical !== 'string' || !canonical.includes(':')) continue;

    // Claude's mcp wrapper removes `:` but preserves `-`; Codex's function
    // name sanitizer removes both separators before parseCodexParts joins the
    // namespace and function with a dot.
    addSessionPartToolAlias(
      aliases,
      ambiguous,
      `mcp__papercusp-su__${canonical.replace(/:/g, '_')}`,
      canonical,
    );
    addSessionPartToolAlias(
      aliases,
      ambiguous,
      `mcp__papercusp_su.${canonical.replace(/[:-]/g, '_')}`,
      canonical,
    );
  }
  return aliases;
}

/** Build the session_turn_parts rows for one tick's parts, numbering them from
 *  the file's persisted part cursor. Pure — exported for tests. */
export function partRowsFrom(
  parts: ParsedPart[],
  base: { sourceKind: string; sessionId: string; owner: string | null; partCount: number },
  catalog?: readonly SessionPartToolCatalogEntry[],
): PartRow[] {
  const aliases = sessionPartToolAliases(catalog ?? listAllProjectedTools());
  return parts.map((p, i) => ({
    workspace_id: 'default',
    source_kind: base.sourceKind,
    session_id: p.sessionId ?? base.sessionId,
    part_idx: base.partCount + i,
    ts: p.ts ? p.ts.toISOString() : null,
    owner: base.owner,
    speaker: p.speaker,
    part_kind: p.partKind,
    tool_name: p.toolName == null ? null : aliases.get(p.toolName) ?? p.toolName,
    text: p.text,
  }));
}

/**
 * P-001 faithful-parts writer. Same ON CONFLICT DO NOTHING idempotency
 * contract as insertTurns (the PK is (workspace_id, source_kind, session_id,
 * part_idx)), so a reset offset re-ingests without duplicating.
 *
 * BEST-EFFORT BY CONTRACT, and that asymmetry is deliberate: the parts store
 * is a RENDER convenience, the turns store is the recall index. A parts write
 * that fails must cost the pane its fidelity for that window, never the
 * search corpus — so the caller catches and counts rather than aborting the
 * turn insert or holding back the byte_offset.
 */
async function insertParts(sql: Sql, rows: PartRow[]): Promise<number> {
  if (!rows.length) return 0;
  const r = await sql`
    INSERT INTO harness_shared.session_turn_parts ${sql(
      rows as unknown as Record<string, unknown>[],
      'workspace_id', 'source_kind', 'session_id', 'part_idx', 'ts',
      'owner', 'speaker', 'part_kind', 'tool_name', 'text',
    )}
    ON CONFLICT DO NOTHING
  `;
  return r.count ?? rows.length;
}

/** Repair rows ingested before a managed Codex home's owner stamp was wired
 * into the adapter. One bulk UPDATE per sweep avoids the historical
 * per-transcript-query trap while making owner-filtered session reads correct
 * without waiting for another turn to be appended. */
async function backfillSessionOwners(
  sql: Sql,
  sourceKind: SourceKind,
  ownersBySession: Map<string, string>,
  onInput: (inputSha256: string) => void,
): Promise<number> {
  if (!ownersBySession.size) return 0;
  const sessionIds = [...ownersBySession.keys()];
  const owners = sessionIds.map((sessionId) => ownersBySession.get(sessionId)!);
  onInput(createHash('sha256').update(JSON.stringify([sessionIds, owners])).digest('hex'));
  const repaired = await sql`
    UPDATE harness_shared.session_turns AS turns
       SET owner = resolved.owner
      FROM UNNEST(${sql.array(sessionIds)}::text[], ${sql.array(owners)}::text[])
           AS resolved(session_id, owner)
     WHERE turns.workspace_id = 'default'
       AND turns.source_kind = ${sourceKind}
       AND turns.session_id = resolved.session_id
       AND turns.owner IS DISTINCT FROM resolved.owner
  `;
  return repaired.count ?? 0;
}

/** Repair faithful-part owner stamps only for Claude ids whose candidate path
 * conflicts with the launcher's birth index. Most sessions never enter this
 * UPDATE, preserving the existing no-op cost for ordinary sweeps. */
async function backfillClaudePartOwners(
  sql: Sql,
  ownersBySession: Map<string, string>,
  onInput: (inputSha256: string) => void,
): Promise<number> {
  if (!ownersBySession.size) return 0;
  const sessionIds = [...ownersBySession.keys()];
  const owners = sessionIds.map((sessionId) => ownersBySession.get(sessionId)!);
  onInput(createHash('sha256').update(JSON.stringify([sessionIds, owners])).digest('hex'));
  const repaired = await sql`
    UPDATE harness_shared.session_turn_parts AS parts
       SET owner = resolved.owner
      FROM UNNEST(${sql.array(sessionIds)}::text[], ${sql.array(owners)}::text[])
           AS resolved(session_id, owner)
     WHERE parts.workspace_id = 'default'
       AND parts.source_kind = 'claude'
       AND parts.session_id = resolved.session_id
       AND parts.owner IS DISTINCT FROM resolved.owner
  `;
  return repaired.count ?? 0;
}

/**
 * Resolve managed OMP transcript homes to coordination owners in one query per
 * adapter sweep. The path's adv_sessions id is authoritative; joining by the
 * native OMP thread id would miss the period before lazy thread-linking runs.
 * Shared ~/.omp files never enter this map and remain deliberately unowned.
 */
async function loadOmpSessionOwners(
  sql: Sql,
  advSessionIds: Iterable<number>,
): Promise<Map<number, string>> {
  const ids = [...new Set([...advSessionIds].filter((id) => Number.isSafeInteger(id) && id > 0))];
  if (!ids.length) return new Map();
  const rows = await sql<Array<{ id: string | number; coord_owner_id: string | null }>>`
    SELECT id, coord_owner_id
      FROM harness_shared.adv_sessions
     WHERE workspace_id = ${activeWorkspaceId()}
       AND mode = 'omp'
       AND coord_owner_id IS NOT NULL
       AND id = ANY(${sql.array(ids)}::bigint[])
  `;
  return new Map(
    rows
      .filter((row) => typeof row.coord_owner_id === 'string' && row.coord_owner_id.trim())
      .map((row) => [Number(row.id), row.coord_owner_id!.trim()]),
  );
}

/** Repair the launch identity that Codex cannot provide at bootstrap time.
 * `writeSuCodexHome` creates the isolated home before Codex creates its native
 * rollout UUID, so the durable join is discovered later from
 * `<home>/sessions/.../rollout-...-<uuid>.jsonl`. This update deliberately
 * changes metadata only: ended/started/exit fields are lifecycle evidence and
 * must remain untouched for paused-session interval queries. */
async function backfillCodexAdvSessions(
  sql: Sql,
  metadataByAdvSession: Map<number, CodexAdvSessionMetadata>,
): Promise<number> {
  if (!metadataByAdvSession.size) return 0;
  const metadata = [...metadataByAdvSession.values()];
  const ids = metadata.map((m) => String(m.advSessionId));
  const sessionIds = metadata.map((m) => m.sessionId);
  // Empty strings become NULL in the CTE so a missing/reaped config never
  // overwrites a launch-time explicit value (or manufactures a blank value).
  const models = metadata.map((m) => m.model ?? '');
  const efforts = metadata.map((m) => m.effort ?? '');
  const rows = await sql<{ id: number }[]>`
    WITH resolved (id, session_id, model, effort) AS (
      SELECT id, session_id, NULLIF(model, ''), NULLIF(effort, '')
        FROM UNNEST(
          ${sql.array(ids)}::bigint[],
          ${sql.array(sessionIds)}::text[],
          ${sql.array(models)}::text[],
          ${sql.array(efforts)}::text[]
        ) AS candidate(id, session_id, model, effort)
    )
    UPDATE harness_shared.adv_sessions AS sessions
       SET session_id = COALESCE(sessions.session_id, resolved.session_id),
           launch_spec = CASE
             WHEN sessions.launch_spec IS NULL
              AND resolved.model IS NULL
              AND resolved.effort IS NULL
             THEN NULL
             ELSE COALESCE(sessions.launch_spec, '{}'::jsonb)
               || CASE
                    WHEN resolved.model IS NOT NULL
                     AND sessions.launch_spec->>'model' IS NULL
                    THEN jsonb_build_object('model', resolved.model)
                    ELSE '{}'::jsonb
                  END
               || CASE
                    WHEN resolved.effort IS NOT NULL
                     AND sessions.launch_spec->>'effort' IS NULL
                    THEN jsonb_build_object('effort', resolved.effort)
                    ELSE '{}'::jsonb
                  END
           END
      FROM resolved
     WHERE sessions.workspace_id = ${activeWorkspaceId()}
       AND sessions.id = resolved.id
       AND (
         sessions.session_id IS NULL
         OR (resolved.model IS NOT NULL AND sessions.launch_spec->>'model' IS NULL)
         OR (resolved.effort IS NOT NULL AND sessions.launch_spec->>'effort' IS NULL)
       )
    RETURNING sessions.id
  `;
  return rows.length;
}

/**
 * Rows re-classified per sweep. Bounded like every other pass in this file —
 * the corpus is millions of turns, so the sweep converges across ticks rather
 * than trying to swallow history in one go.
 */
export const PROVENANCE_BACKFILL_BATCH = 5_000;

export interface ProvenanceBackfillResult {
  scanned: number;
  updated: number;
  /** True while rows remain below the current catalogue version — the caller
   *  can keep sweeping, or simply wait for the next tick. */
  more: boolean;
}

/**
 * Re-derive `turn_origin*` for rows the CURRENT catalogue has not classified.
 *
 * TWO POPULATIONS, ONE QUERY (migration 794):
 *   * version IS NULL — ingested before this feature existed.
 *   * version < CURRENT — classified by an older catalogue, i.e. possibly
 *     stamped `owner-typed` only because the pattern that would have caught it
 *     had not been written yet.
 *
 * The second is the one that makes this sweep permanent rather than a one-off
 * migration chore. `owner-typed` is the RESIDUAL of a versioned deny-list, so
 * every pattern added to the catalogue silently invalidates some past verdicts;
 * without a re-derivation lane those rows keep asserting the owner said
 * something he did not, with a stored column's authority behind it. Bumping
 * MACHINE_SURFACE_CATALOGUE_VERSION is what makes them findable here.
 *
 * Only the HEAD is fetched — the classifier bounds itself to
 * CLASSIFY_HEAD_CHARS anyway, so pulling whole turn bodies (up to 8k each)
 * would be pure bandwidth.
 */
export async function backfillTurnProvenanceOnce(
  sql: Sql,
  limit = PROVENANCE_BACKFILL_BATCH,
): Promise<ProvenanceBackfillResult> {
  const rows = await sql<
    Array<{
      workspace_id: string;
      source_kind: string;
      session_id: string;
      turn_idx: number;
      speaker: string;
      head: string | null;
      turn_origin: string | null;
      turn_origin_verdict: string | null;
    }>
  >`
    SELECT workspace_id, source_kind, session_id, turn_idx, speaker,
           left(text, ${CLASSIFY_HEAD_CHARS}) AS head,
           turn_origin, turn_origin_verdict
      FROM harness_shared.session_turns
     WHERE turn_origin_classifier_version IS NULL
        OR turn_origin_classifier_version < ${MACHINE_SURFACE_CATALOGUE_VERSION}
     -- STALE-VERSION ROWS FIRST, never-classified rows after. The two
     -- populations are NOT equally harmful, and a plain LIMIT serves them in
     -- physical order, which starves the harmful one: measured on the first
     -- real sweep, 20,000 rows drained entirely from the NULL backlog while all
     -- 2,435 version-below-current rows sat untouched behind it.
     --
     -- A NULL row is HONEST - it asserts nothing, and every reader is told NULL
     -- means "never classified". A stale-version row carries a CONCRETE verdict
     -- with a stored column's authority, and that stale verdict is
     -- disproportionately the owner-typed RESIDUAL, precisely because the
     -- residual is what each newer catalogue is written to stop over-assigning.
     -- So the rows that actively misattribute machine text to the owner drain
     -- first; the ones that merely say nothing wait.
     --
     -- DESC NULLS LAST orders non-NULL versions ahead of NULLs and is served by
     -- session_turns_provenance_version_idx rather than a sort of the backlog.
     ORDER BY turn_origin_classifier_version DESC NULLS LAST
     LIMIT ${limit}
  `;
  if (!rows.length) return { scanned: 0, updated: 0, more: false };

  const wsIds: string[] = [];
  const kinds: string[] = [];
  const sessionIds: string[] = [];
  const turnIdxs: number[] = [];
  const origins: (string | null)[] = [];
  const verdicts: string[] = [];

  for (const r of rows) {
    // Reuse the ONE stamp path rather than re-deriving the rules here — a
    // second copy of this logic is how the four divergent classifiers arose.
    const staged = {
      source_kind: r.source_kind,
      speaker: r.speaker,
      text: r.head ?? '',
    } as TurnRow;
    stampTurnProvenance(staged);

    // Only the insert-time exact hook correlation writes this identity.
    // Preserve that positive evidence after ephemeral receipt expiry, but
    // let every current machine/envelope/speaker verdict win. Untagged old
    // owner-typed residuals still downgrade, so this cannot retroactively
    // authenticate historical rows from clean text alone.
    if (
      staged.turn_origin_verdict === UNENROLLED_ORIGIN_VERDICT &&
      r.turn_origin_verdict === 'owner-typed' &&
      r.turn_origin === HOOK_AUTHENTICATED_PROMPT_ORIGIN
    ) {
      staged.turn_origin = HOOK_AUTHENTICATED_PROMPT_ORIGIN;
      staged.turn_origin_verdict = 'owner-typed';
    }

    wsIds.push(r.workspace_id);
    kinds.push(r.source_kind);
    sessionIds.push(r.session_id);
    turnIdxs.push(r.turn_idx);
    origins.push(staged.turn_origin ?? null);
    verdicts.push(staged.turn_origin_verdict!);
  }

  const res = await sql`
    UPDATE harness_shared.session_turns AS turns
       SET turn_origin = resolved.turn_origin,
           turn_origin_verdict = resolved.turn_origin_verdict,
           turn_origin_classifier_version = ${MACHINE_SURFACE_CATALOGUE_VERSION}
      FROM UNNEST(
             ${sql.array(wsIds)}::text[], ${sql.array(kinds)}::text[],
             ${sql.array(sessionIds)}::text[], ${sql.array(turnIdxs)}::int[],
             ${sql.array(origins as string[])}::text[], ${sql.array(verdicts)}::text[]
           ) AS resolved(workspace_id, source_kind, session_id, turn_idx,
                         turn_origin, turn_origin_verdict)
     WHERE turns.workspace_id = resolved.workspace_id
       AND turns.source_kind = resolved.source_kind
       AND turns.session_id = resolved.session_id
       AND turns.turn_idx = resolved.turn_idx
  `;

  return {
    scanned: rows.length,
    updated: res.count ?? rows.length,
    more: rows.length === limit,
  };
}

/**
 * Sweep passes per tick. One pass is PROVENANCE_BACKFILL_BATCH rows, so this
 * caps a tick's write volume while still converging: the measured backlog when
 * this lane was first wired was 370,478 never-classified rows (96% of the
 * table), which drains in a couple of hours at this rate rather than pinning
 * the pool for one enormous transaction.
 */
export const PROVENANCE_BACKFILL_PASSES_PER_TICK = 4;

/**
 * Run the provenance re-derivation lane for one tick.
 *
 * WHY THIS NO-ARG WRAPPER EXISTS. `backfillTurnProvenanceOnce` takes a `sql`
 * handle and does exactly one batch, which makes it testable but not directly
 * schedulable. It sat EXPORTED AND UNCALLED — zero production call sites — so
 * the re-derivation lane its own docstring describes as "permanent rather than
 * a one-off migration chore" never ran at all, and every
 * MACHINE_SURFACE_CATALOGUE_VERSION bump silently STRANDED rows instead of
 * repairing them (WI-38135). This is the schedulable entry point; keep the tick
 * pointed at it and `no-uncalled-provenance-backfill.test.ts` will hold the
 * call site in place.
 */
export async function runTurnProvenanceBackfillOnce(): Promise<ProvenanceBackfillResult> {
  const { sql } = getOrgPg();
  let scanned = 0;
  let updated = 0;
  let more = false;
  for (let pass = 0; pass < PROVENANCE_BACKFILL_PASSES_PER_TICK; pass += 1) {
    const r = await backfillTurnProvenanceOnce(sql);
    scanned += r.scanned;
    updated += r.updated;
    more = r.more;
    if (!r.more) break;
  }
  // After the re-derivation above, so rows it just moved to the current
  // catalogue version are eligible for their hook stamp in the same tick.
  const recorrelated = await recorrelatePromptOriginStampsOnce(sql);
  return {
    scanned: scanned + recorrelated.scanned,
    updated: updated + recorrelated.promoted,
    more: more || recorrelated.more,
  };
}

export interface PromptOriginRecorrelationResult {
  /** Distinct unenrolled rows the prefilter paired with a stamp. */
  scanned: number;
  /** Rows the shared correlation rule upgraded to owner-typed. */
  promoted: number;
  more: boolean;
}

/**
 * Re-apply the hook-stamp correlation to rows ALREADY stored as
 * `unenrolled-origin` (WI-10006568).
 *
 * insertTurns correlates once, at insert, and writes ON CONFLICT DO NOTHING,
 * so a row that missed its stamp was never revisited: ingest that ran before
 * the hook's stamp landed, ingest that ran more than one stamp TTL late (the
 * old `expires_at > now()` filter), and every row ingested before correlation
 * shipped. Measured 2026-10-06: 1,508 owner turns in 648 sessions, including
 * owner directive #1459, which then failed plans:audit's owner-provenance check.
 *
 * The SQL is a PREFILTER only. Its normalised-text hash keeps permanent
 * non-matches out of the LIMIT window so they cannot starve real matches.
 * correlatePromptOriginStamps, the same function insertTurns uses, decides
 * every upgrade: same session, same hash, ±PROMPT_ORIGIN_MATCH_WINDOW_MS,
 * turn-anchored expiry, one row per stamp. The hash is recomputed from the
 * STORED text, so a row whose stored text differs from the raw prompt (for
 * example a truncated body) stays unmatched. This pass can miss a row; it
 * cannot attribute text the owner did not type.
 */
export async function recorrelatePromptOriginStampsOnce(
  sql: Sql,
  limit = PROVENANCE_BACKFILL_BATCH,
): Promise<PromptOriginRecorrelationResult> {
  const workspace = activeWorkspaceId();
  const windowMs = PROMPT_ORIGIN_MATCH_WINDOW_MS;
  const pairs = await sql<
    Array<{
      workspace_id: string;
      source_kind: string;
      session_id: string;
      turn_idx: number;
      ts: Date | string;
      speaker: string;
      text: string;
      prompt_hash: string;
      submitted_at: Date | string;
      expires_at: Date | string;
    }>
  >`
    SELECT turns.workspace_id, turns.source_kind, turns.session_id, turns.turn_idx,
           turns.ts, turns.speaker, turns.text,
           stamps.prompt_hash, stamps.submitted_at, stamps.expires_at
      FROM harness_shared.session_prompt_origin_stamps AS stamps
      JOIN harness_shared.session_turns AS turns
        ON turns.workspace_id IN ('default', ${workspace})
       AND turns.source_kind = stamps.source_kind
       AND turns.session_id = stamps.session_id
       AND turns.ts BETWEEN stamps.submitted_at - (${windowMs}::int * interval '1 millisecond')
                        AND stamps.submitted_at + (${windowMs}::int * interval '1 millisecond')
     WHERE stamps.workspace_id = ${workspace}
       AND turns.speaker = 'user'
       AND turns.turn_origin_verdict = ${UNENROLLED_ORIGIN_VERDICT}
       AND turns.turn_origin_classifier_version = ${MACHINE_SURFACE_CATALOGUE_VERSION}
       -- Mirrors promptOriginHash (CRLF -> LF, trim). Prefilter only; a drift
       -- between the two makes rows MISS, which the integration test catches.
       AND encode(sha256(convert_to(
             regexp_replace(regexp_replace(turns.text, E'\\r\\n?', E'\\n', 'g'), '^\\s+|\\s+$', '', 'g'),
             'UTF8')), 'hex') = stamps.prompt_hash
       -- A stamp already spent on a hook-authenticated row stays spent.
       AND NOT EXISTS (
         SELECT 1
           FROM harness_shared.session_turns AS spent
          WHERE spent.workspace_id = turns.workspace_id
            AND spent.source_kind = stamps.source_kind
            AND spent.session_id = stamps.session_id
            AND spent.turn_origin = ${HOOK_AUTHENTICATED_PROMPT_ORIGIN}
            AND spent.ts BETWEEN stamps.submitted_at - (${windowMs}::int * interval '1 millisecond')
                             AND stamps.submitted_at + (${windowMs}::int * interval '1 millisecond')
            AND encode(sha256(convert_to(
                  regexp_replace(regexp_replace(spent.text, E'\\r\\n?', E'\\n', 'g'), '^\\s+|\\s+$', '', 'g'),
                  'UTF8')), 'hex') = stamps.prompt_hash
       )
     ORDER BY turns.ts, turns.session_id, turns.turn_idx
     LIMIT ${limit}
  `;
  if (!pairs.length) return { scanned: 0, promoted: 0, more: false };

  const rowsByKey = new Map<string, TurnRow>();
  const stampsByKey = new Map<string, PromptOriginStamp>();
  for (const p of pairs) {
    const rowKey = [p.workspace_id, p.source_kind, p.session_id, p.turn_idx].join('\u0000');
    if (!rowsByKey.has(rowKey)) {
      rowsByKey.set(rowKey, {
        workspace_id: p.workspace_id,
        source_kind: p.source_kind,
        session_id: p.session_id,
        turn_idx: Number(p.turn_idx),
        ts: new Date(p.ts).toISOString(),
        owner: null,
        harness_slug: null,
        cwd: null,
        speaker: p.speaker,
        text: p.text,
        turn_origin: null,
        turn_origin_verdict: UNENROLLED_ORIGIN_VERDICT,
        turn_origin_classifier_version: MACHINE_SURFACE_CATALOGUE_VERSION,
        prompt_hash: promptOriginHash(p.text),
      });
    }
    const stampKey = [p.source_kind, p.session_id, p.prompt_hash, new Date(p.submitted_at).getTime()].join('\u0000');
    if (!stampsByKey.has(stampKey)) {
      stampsByKey.set(stampKey, {
        source_kind: p.source_kind,
        session_id: p.session_id,
        prompt_hash: p.prompt_hash,
        submitted_at: p.submitted_at,
        expires_at: p.expires_at,
      });
    }
  }
  const rows = [...rowsByKey.values()];
  correlatePromptOriginStamps(rows, [...stampsByKey.values()]);
  const promoted = rows.filter((row) => row.turn_origin === HOOK_AUTHENTICATED_PROMPT_ORIGIN);
  if (promoted.length) {
    await sql`
      UPDATE harness_shared.session_turns AS turns
         SET turn_origin = ${HOOK_AUTHENTICATED_PROMPT_ORIGIN},
             turn_origin_verdict = 'owner-typed'
        FROM UNNEST(
               ${sql.array(promoted.map((row) => row.workspace_id))}::text[],
               ${sql.array(promoted.map((row) => row.source_kind))}::text[],
               ${sql.array(promoted.map((row) => row.session_id))}::text[],
               ${sql.array(promoted.map((row) => row.turn_idx))}::int[]
             ) AS hit(workspace_id, source_kind, session_id, turn_idx)
       WHERE turns.workspace_id = hit.workspace_id
         AND turns.source_kind = hit.source_kind
         AND turns.session_id = hit.session_id
         AND turns.turn_idx = hit.turn_idx
         AND turns.turn_origin_verdict = ${UNENROLLED_ORIGIN_VERDICT}
    `;
  }
  return { scanned: rows.length, promoted: promoted.length, more: pairs.length === limit };
}

interface IngestState {
  byte_offset: number;
  turn_count: number;
  /** P-001: the session_turn_parts cursor — the parts analog of turn_count,
   *  carried on the SAME bookkeeping row so one writeState advances both. */
  part_count: number;
  /** EI-9970: cumulative real-prompt / distinct-model-response / tool-call
   *  counts for this file, and the dedup cursor for the response count. */
  prompt_count: number;
  response_count: number;
  tool_call_count: number;
  last_inference_id: string | null;
  counts_backfill_offset: number;
  counts_backfill_last_inference_id: string | null;
  counts_backfilled_at: string | null;
  /** P-001: independent cursor for repairing rows whose file cursor already
   * reached EOF before session_turn_parts existed or was wired. */
  parts_backfill_offset?: number;
  parts_backfilled_at?: string | null;
}

const EMPTY_STATE: IngestState = {
  byte_offset: 0,
  turn_count: 0,
  part_count: 0,
  prompt_count: 0,
  response_count: 0,
  tool_call_count: 0,
  last_inference_id: null,
  counts_backfill_offset: 0,
  counts_backfill_last_inference_id: null,
  counts_backfilled_at: null,
  parts_backfill_offset: 0,
  parts_backfilled_at: null,
};

async function readState(sql: Sql, sourceKind: string, filePath: string): Promise<IngestState> {
  const rows = await sql<Array<{
    byte_offset: string | number; turn_count: number; part_count: number | null;
    prompt_count: number; response_count: number; tool_call_count: number; last_inference_id: string | null;
    counts_backfill_offset: string | number; counts_backfill_last_inference_id: string | null;
    counts_backfilled_at: string | null;
    parts_backfill_offset: string | number; parts_backfilled_at: string | null;
  }>>`
    SELECT byte_offset, turn_count, part_count, prompt_count, response_count, tool_call_count, last_inference_id,
           counts_backfill_offset, counts_backfill_last_inference_id, counts_backfilled_at
           , parts_backfill_offset, parts_backfilled_at
      FROM harness_shared.session_ingest_state
     WHERE source_kind = ${sourceKind} AND file_path = ${filePath}
  `;
  if (!rows.length) return { ...EMPTY_STATE };
  const r = rows[0];
  return {
    byte_offset: Number(r.byte_offset),
    turn_count: r.turn_count,
    part_count: r.part_count ?? 0,
    prompt_count: r.prompt_count ?? 0,
    response_count: r.response_count ?? 0,
    tool_call_count: r.tool_call_count ?? 0,
    last_inference_id: r.last_inference_id ?? null,
    counts_backfill_offset: Number(r.counts_backfill_offset ?? 0),
    counts_backfill_last_inference_id: r.counts_backfill_last_inference_id ?? null,
    counts_backfilled_at: r.counts_backfilled_at ?? null,
    parts_backfill_offset: Number(r.parts_backfill_offset ?? 0),
    parts_backfilled_at: r.parts_backfilled_at ?? null,
  };
}

async function writeState(
  sql: Sql,
  sourceKind: string,
  filePath: string,
  st: Pick<IngestState, 'byte_offset' | 'turn_count'> &
    Partial<Pick<IngestState, 'part_count' | 'prompt_count' | 'response_count' | 'tool_call_count' | 'last_inference_id' | 'counts_backfill_offset' | 'counts_backfill_last_inference_id' | 'counts_backfilled_at'>> &
    Partial<Pick<IngestState, 'parts_backfill_offset' | 'parts_backfilled_at'>> &
    { sessionId?: string | null; mtimeMs?: number; lastError?: string | null },
): Promise<void> {
  await sql`
    INSERT INTO harness_shared.session_ingest_state
      (source_kind, file_path, byte_offset, turn_count, part_count, prompt_count, response_count,
       tool_call_count, last_inference_id, counts_backfill_offset, counts_backfill_last_inference_id, counts_backfilled_at,
       parts_backfill_offset, parts_backfilled_at, session_id, mtime_ms, last_error, updated_at)
    VALUES (${sourceKind}, ${filePath}, ${st.byte_offset}, ${st.turn_count}, ${st.part_count ?? 0},
            ${st.prompt_count ?? 0}, ${st.response_count ?? 0}, ${st.tool_call_count ?? 0}, ${st.last_inference_id ?? null},
            ${st.counts_backfill_offset ?? st.byte_offset}, ${st.counts_backfill_last_inference_id ?? null}, ${st.counts_backfilled_at ?? null},
            ${st.parts_backfill_offset ?? 0}, ${st.parts_backfilled_at ?? null},
            ${st.sessionId ?? null}, ${st.mtimeMs != null ? Math.round(st.mtimeMs) : null}, ${st.lastError ?? null}, now())
    ON CONFLICT (source_kind, file_path) DO UPDATE SET
      byte_offset       = EXCLUDED.byte_offset,
      turn_count        = EXCLUDED.turn_count,
      -- P-001: PRESERVE on omission, don't zero. Several callers write this row
      -- without knowing the parts cursor at all (the counts backfill, the
      -- agent_chat sync, the CHAT_HWM row) — with plain EXCLUDED semantics each
      -- of those ticks would silently reset part_count to 0 and the next real
      -- ingest would renumber parts from 0, colliding with existing part_idx
      -- values and losing the whole tail to ON CONFLICT DO NOTHING. Passing an
      -- explicit 0 still resets it, which is what a deliberate re-ingest wants.
      part_count        = COALESCE(${st.part_count ?? null}, harness_shared.session_ingest_state.part_count),
      prompt_count      = EXCLUDED.prompt_count,
      response_count    = EXCLUDED.response_count,
      tool_call_count   = EXCLUDED.tool_call_count,
      last_inference_id = EXCLUDED.last_inference_id,
      counts_backfill_offset = EXCLUDED.counts_backfill_offset,
      counts_backfill_last_inference_id = COALESCE(EXCLUDED.counts_backfill_last_inference_id, harness_shared.session_ingest_state.counts_backfill_last_inference_id),
      counts_backfilled_at = COALESCE(EXCLUDED.counts_backfilled_at, harness_shared.session_ingest_state.counts_backfilled_at),
      parts_backfill_offset = COALESCE(${st.parts_backfill_offset ?? null}, harness_shared.session_ingest_state.parts_backfill_offset),
      parts_backfilled_at = COALESCE(${st.parts_backfilled_at ?? null}, harness_shared.session_ingest_state.parts_backfilled_at),
      session_id        = COALESCE(EXCLUDED.session_id, harness_shared.session_ingest_state.session_id),
      mtime_ms          = EXCLUDED.mtime_ms,
      last_error        = EXCLUDED.last_error,
      updated_at        = now()
  `;
}

interface CountBackfillBudget {
  files: number;
  bytes: number;
}

interface CountBackfillStateRow extends IngestState {
  file_path: string;
  session_id: string | null;
}

/** Replay only the counter signal for one historical file. The indexed-turn
 * byte_offset/turn_count remain untouched; counts_backfill_offset is the
 * independent resumable cursor. */
async function backfillFileCounts(
  sql: Sql,
  adapter: FileAdapter,
  row: CountBackfillStateRow,
  budget: CountBackfillBudget,
): Promise<boolean> {
  if (budget.files <= 0 || budget.bytes <= 0) return false;
  const meta = adapter.meta(row.file_path);
  let sourceSize: number;
  try {
    const source = await stat(row.file_path);
    if (!source.isFile()) throw new Error('not a file');
    sourceSize = source.size;
  } catch {
    // The transcript may have been archived/deleted after its index state was
    // written. Mark it terminally unavailable so a missing source cannot wake
    // the same repair forever; the archive remains the authoritative payload.
    await writeState(sql, adapter.sourceKind, row.file_path, {
      byte_offset: row.byte_offset,
      turn_count: row.turn_count,
      prompt_count: row.prompt_count,
      response_count: row.response_count,
      tool_call_count: row.tool_call_count,
      last_inference_id: row.last_inference_id,
      counts_backfill_offset: row.counts_backfill_offset,
      counts_backfill_last_inference_id: row.counts_backfill_last_inference_id,
      counts_backfilled_at: new Date().toISOString(),
      sessionId: row.session_id ?? meta.sessionId,
      lastError: 'counts_backfill_source_missing',
    });
    budget.files -= 1;
    return true;
  }

  let cursor = Math.min(row.counts_backfill_offset, sourceSize);
  let promptCount = row.prompt_count;
  let responseCount = row.response_count;
  let toolCallCount = row.tool_call_count;
  let lastInferenceId = row.counts_backfill_last_inference_id;
  let progressed = false;
  while (cursor < sourceSize && budget.bytes > 0) {
    const result = await readNewLines(
      row.file_path,
      cursor,
      adapter.parseLine,
      adapter.classifyLine,
      lastInferenceId,
    );
    if (result.newOffset === cursor) break;
    const advanced = result.newOffset - cursor;
    cursor = result.newOffset;
    promptCount += result.promptCount;
    responseCount += result.responseCount;
    toolCallCount += result.toolCallCount;
    lastInferenceId = result.lastInferenceId;
    budget.bytes -= advanced;
    progressed = true;
  }

  const complete = cursor >= sourceSize;
  if (progressed || complete) {
    await writeState(sql, adapter.sourceKind, row.file_path, {
      byte_offset: row.byte_offset,
      turn_count: row.turn_count,
      prompt_count: promptCount,
      response_count: responseCount,
      tool_call_count: toolCallCount,
      last_inference_id: lastInferenceId,
      counts_backfill_offset: cursor,
      counts_backfill_last_inference_id: lastInferenceId,
      counts_backfilled_at: complete ? new Date().toISOString() : null,
      sessionId: row.session_id ?? meta.sessionId,
    });
  }
  if (progressed || complete) budget.files -= 1;
  return progressed || complete;
}

interface PartsBackfillStateRow {
  file_path: string;
  byte_offset: number;
  turn_count: number;
  part_count: number;
  parts_backfill_offset: number;
  parts_backfilled_at: string | null;
  session_id: string | null;
}

/** Replay only the faithful-part signal for one historical file. The live
 * byte_offset/turn_count cursors remain untouched: this is specifically for
 * rows that reached EOF before the P-001 writer existed or completed. A
 * separate cursor makes the repair resumable without replaying text turns. */
async function backfillFileParts(
  sql: Sql,
  adapter: FileAdapter,
  row: PartsBackfillStateRow,
  budget: CountBackfillBudget,
): Promise<boolean> {
  if (budget.files <= 0 || budget.bytes <= 0 || !adapter.parseParts) return false;
  const meta = adapter.meta(row.file_path);
  const owner = adapter.sourceKind === 'claude'
    ? await indexedClaudeOwner(meta.sessionId) ?? meta.owner
    : meta.owner;
  let sourceSize: number;
  try {
    const source = await stat(row.file_path);
    if (!source.isFile()) throw new Error('not a file');
    sourceSize = source.size;
  } catch {
    // Archive cleanup can win the race after indexing. Do not leave a missing
    // source eligible forever; the archive reader remains the recovery surface
    // for sessions whose bytes are no longer on disk.
    await writeState(sql, adapter.sourceKind, row.file_path, {
      byte_offset: row.byte_offset,
      turn_count: row.turn_count,
      part_count: row.part_count,
      parts_backfill_offset: row.parts_backfill_offset,
      parts_backfilled_at: new Date().toISOString(),
      sessionId: row.session_id ?? meta.sessionId,
      lastError: 'parts_backfill_source_missing',
    });
    budget.files -= 1;
    return true;
  }

  // A replaced/truncated source cannot honor an old independent cursor. Start
  // from zero so the part index is rebuilt from the bytes that exist now.
  let cursor = row.parts_backfill_offset > sourceSize ? 0 : row.parts_backfill_offset;
  let partCount = row.part_count;
  let progressed = false;
  while (cursor < sourceSize && budget.bytes > 0) {
    const result = await readNewLines(
      row.file_path,
      cursor,
      adapter.parseLine,
      adapter.classifyLine,
      null,
      undefined,
      [],
      adapter.parseParts,
    );
    if (result.newOffset === cursor) break;

    // If this write fails, leave the cursor at the last successful chunk so a
    // later sweep retries the same parts instead of declaring them repaired.
    await insertParts(sql, partRowsFrom(result.parts, {
      sourceKind: adapter.sourceKind,
      sessionId: row.session_id ?? meta.sessionId,
      owner,
      partCount,
    }));

    const advanced = result.newOffset - cursor;
    cursor = result.newOffset;
    partCount += result.parts.length;
    budget.bytes -= advanced;
    progressed = true;
    await writeState(sql, adapter.sourceKind, row.file_path, {
      byte_offset: row.byte_offset,
      turn_count: row.turn_count,
      part_count: partCount,
      parts_backfill_offset: cursor,
      parts_backfilled_at: null,
      sessionId: row.session_id ?? meta.sessionId,
    });
  }

  const complete = cursor >= sourceSize;
  if (complete) {
    await writeState(sql, adapter.sourceKind, row.file_path, {
      byte_offset: row.byte_offset,
      turn_count: row.turn_count,
      part_count: partCount,
      parts_backfill_offset: cursor,
      parts_backfilled_at: new Date().toISOString(),
      sessionId: row.session_id ?? meta.sessionId,
    });
  }
  if (progressed || complete) budget.files -= 1;
  return progressed || complete;
}

/** Backfill faithful parts for pre-P-001 rows in bounded, resumable slices.
 * Only file adapters with parseParts participate; agent_chat and OMP retain
 * their prior zero-parts semantics. */
async function backfillHistoricalParts(sql: Sql): Promise<number> {
  const budget: CountBackfillBudget = {
    files: MAX_PART_BACKFILL_FILES_PER_TICK,
    bytes: MAX_PART_BACKFILL_BYTES_PER_TICK,
  };
  let progressed = 0;
  for (const adapter of FILE_ADAPTERS) {
    if (budget.files <= 0 || budget.bytes <= 0 || !adapter.parseParts) break;
    const rows = await sql<Array<{
      file_path: string;
      byte_offset: string | number;
      turn_count: number;
      part_count: number | null;
      parts_backfill_offset: string | number;
      parts_backfilled_at: string | null;
      session_id: string | null;
    }>>`
      SELECT file_path, byte_offset, turn_count, part_count,
             parts_backfill_offset, parts_backfilled_at, session_id
        FROM harness_shared.session_ingest_state
       WHERE source_kind = ${adapter.sourceKind}
         AND byte_offset > 0
         AND parts_backfilled_at IS NULL
         AND (part_count = 0 OR parts_backfill_offset > 0)
       ORDER BY updated_at ASC, file_path ASC
       LIMIT ${MAX_PART_BACKFILL_FILES_PER_TICK}
    `;
    for (const r of rows) {
      if (budget.files <= 0 || budget.bytes <= 0) break;
      const changed = await backfillFileParts(sql, adapter, {
        file_path: r.file_path,
        byte_offset: Number(r.byte_offset),
        turn_count: r.turn_count,
        part_count: r.part_count ?? 0,
        parts_backfill_offset: Number(r.parts_backfill_offset ?? 0),
        parts_backfilled_at: r.parts_backfilled_at ?? null,
        session_id: r.session_id ?? null,
      }, budget);
      if (changed) progressed += 1;
    }
  }
  return progressed;
}

/** Backfill pre-579 file and agent-chat rows in small resumable slices. This
 * deliberately runs before the ordinary newest-first tail so historical rows
 * converge even when they are older than INGEST_WINDOW_DAYS. */
async function backfillHistoricalCounts(sql: Sql): Promise<number> {
  const budget: CountBackfillBudget = {
    files: MAX_COUNT_BACKFILL_FILES_PER_TICK,
    bytes: MAX_COUNT_BACKFILL_BYTES_PER_TICK,
  };
  let progressed = 0;
  for (const adapter of FILE_ADAPTERS) {
    if (budget.files <= 0 || budget.bytes <= 0) break;
    const rows = await sql<Array<{
      file_path: string;
      byte_offset: string | number;
      turn_count: number;
      part_count: number | null;
      prompt_count: number;
      response_count: number;
      tool_call_count: number;
      last_inference_id: string | null;
      counts_backfill_offset: string | number;
      counts_backfill_last_inference_id: string | null;
      counts_backfilled_at: string | null;
      session_id: string | null;
    }>>`
      SELECT file_path, byte_offset, turn_count, part_count, prompt_count, response_count,
             tool_call_count, last_inference_id, counts_backfill_offset,
             counts_backfill_last_inference_id, counts_backfilled_at, session_id
        FROM harness_shared.session_ingest_state
       WHERE source_kind = ${adapter.sourceKind}
         AND counts_backfilled_at IS NULL
       ORDER BY updated_at ASC, file_path ASC
       LIMIT ${MAX_COUNT_BACKFILL_FILES_PER_TICK}
    `;
    for (const r of rows) {
      if (budget.files <= 0 || budget.bytes <= 0) break;
      const changed = await backfillFileCounts(sql, adapter, {
        file_path: r.file_path,
        byte_offset: Number(r.byte_offset),
        turn_count: r.turn_count,
        part_count: r.part_count ?? 0,
        prompt_count: r.prompt_count ?? 0,
        response_count: r.response_count ?? 0,
        tool_call_count: r.tool_call_count ?? 0,
        last_inference_id: r.last_inference_id ?? null,
        counts_backfill_offset: Number(r.counts_backfill_offset ?? 0),
        counts_backfill_last_inference_id: r.counts_backfill_last_inference_id ?? null,
        counts_backfilled_at: r.counts_backfilled_at ?? null,
        session_id: r.session_id ?? null,
      }, budget);
      if (changed) progressed += 1;
    }
  }

  if (budget.files > 0) {
    const chats = await sql<Array<{
      file_path: string;
      byte_offset: string | number;
      turn_count: number;
      prompt_count: number;
      response_count: number;
      tool_call_count: number;
      last_inference_id: string | null;
      counts_backfill_offset: string | number;
      session_id: string | null;
      transcript: Array<{ role?: string; content?: unknown }> | null;
    }>>`
      SELECT st.file_path, st.byte_offset, st.turn_count, st.prompt_count,
             st.response_count, st.tool_call_count, st.last_inference_id,
             st.counts_backfill_offset, st.session_id, c.transcript
        FROM harness_shared.session_ingest_state AS st
        JOIN harness_shared.agent_chats_consolidated AS c
          ON st.file_path = ('chat:' || c.workspace_id || ':' || c.harness_slug || ':' || c.id)
       WHERE st.source_kind = 'agent_chat'
         AND st.file_path <> ${CHAT_HWM_PATH}
         AND st.counts_backfilled_at IS NULL
       ORDER BY st.updated_at ASC, st.file_path ASC
       LIMIT ${MAX_CHATS_PER_TICK}
    `;
    for (const chat of chats) {
      if (budget.files <= 0) break;
      const transcript = Array.isArray(chat.transcript) ? chat.transcript : [];
      let prompts = chat.prompt_count ?? 0;
      let responses = chat.response_count ?? 0;
      for (const turn of transcript) {
        if (turn.role === 'user') prompts += 1;
        else if (turn.role === 'assistant') responses += 1;
      }
      await writeState(sql, 'agent_chat', chat.file_path, {
        byte_offset: Number(chat.byte_offset),
        turn_count: chat.turn_count,
        prompt_count: prompts,
        response_count: responses,
        tool_call_count: chat.tool_call_count ?? 0,
        last_inference_id: chat.last_inference_id ?? null,
        counts_backfill_offset: transcript.length,
        counts_backfill_last_inference_id: null,
        counts_backfilled_at: new Date().toISOString(),
        sessionId: chat.session_id,
      });
      budget.files -= 1;
      progressed += 1;
    }
  }
  return progressed;
}

/** Tail ONE file now (bounded, incremental). The read-time freshness lever:
 * sessions:search { session:'self' } and the post-compaction orient call this
 * on the caller's own transcript so the last few minutes are never a blind
 * spot — client-neutral (compaction-context-loss D-002). */
export async function ingestFileNow(
  filePath: string,
  opts: { owner?: string | null; sessionId?: string | null } = {},
): Promise<{ inserted: number }> {
  const adapter = FILE_ADAPTERS.find((a) => a.roots().some((r) => filePath.startsWith(r.root)));
  if (!adapter) return { inserted: 0 };
  const { sql } = getOrgPg();
  let inserted = 0;
  const meta = adapter.meta(filePath);
  const owner = opts.owner ?? (adapter.sourceKind === 'claude'
    ? await indexedClaudeOwner(meta.sessionId) ?? meta.owner
    : meta.owner);
  if (adapter.sourceKind === 'codex') {
    // Run this even when the file has no new bytes: read-time freshness is
    // also the repair path for a paused session whose process interval still
    // overlaps the caller's query window.
    try {
      const codexMeta = codexAdvSessionMetadata(filePath, opts.sessionId?.trim() || meta.sessionId);
      if (codexMeta) await backfillCodexAdvSessions(sql, new Map([[codexMeta.advSessionId, codexMeta]]));
    } catch (err) {
      process.stderr.write(`[session-ingest] codex adv metadata backfill skipped: ${(err as Error).message}\n`);
    }
  }
  // A single file can exceed the per-call byte cap — loop until drained (bounded
  // by the file size; this is one file, not the fleet).
  for (let guard = 0; guard < 32; guard += 1) {
    const st = await readState(sql, adapter.sourceKind, filePath);
    const { turns, parts, newOffset, promptCount, responseCount, toolCallCount, lastInferenceId } =
      await readNewLines(
        filePath, st.byte_offset, adapter.parseLine, adapter.classifyLine, st.last_inference_id,
        undefined, [], adapter.parseParts,
      );
    if (newOffset === st.byte_offset) break;
    const rows: TurnRow[] = turns.map((t, i) => ({
      workspace_id: 'default',
      source_kind: adapter.sourceKind,
      session_id: t.sessionId ?? opts.sessionId ?? meta.sessionId,
      turn_idx: st.turn_count + i,
      ts: t.ts ? t.ts.toISOString() : null,
      owner,
      harness_slug: null,
      cwd: t.cwd ?? null,
      speaker: t.speaker,
      text: t.text,
      prompt_hash: t.promptHash ?? null,
    }));
    inserted += await insertTurns(sql, rows);
    // Best-effort by contract (see insertParts): the render store must never
    // block the recall index or hold back the offset.
    try {
      await insertParts(sql, partRowsFrom(parts, {
        sourceKind: adapter.sourceKind,
        sessionId: opts.sessionId ?? meta.sessionId,
        owner,
        partCount: st.part_count,
      }));
    } catch (err) {
      console.warn(`[session-ingest] parts write skipped (non-fatal): ${(err as Error).message}`);
    }
    await writeState(sql, adapter.sourceKind, filePath, {
      byte_offset: newOffset,
      turn_count: st.turn_count + turns.length,
      part_count: st.part_count + parts.length,
      prompt_count: st.prompt_count + promptCount,
      response_count: st.response_count + responseCount,
      tool_call_count: st.tool_call_count + toolCallCount,
      last_inference_id: lastInferenceId,
      counts_backfill_offset: newOffset,
      counts_backfill_last_inference_id: lastInferenceId,
      counts_backfilled_at: new Date().toISOString(),
      sessionId: opts.sessionId ?? meta.sessionId,
    });
  }
  return { inserted };
}

/* ------------------------------------------------------------------ */
/* agent_chat sync (PG → PG; transcript JSONB → turns)                  */
/* ------------------------------------------------------------------ */

const CHAT_HWM_PATH = '__hwm__';

async function syncAgentChats(sql: Sql, budget: { turns: number }): Promise<number> {
  const hwmRows = await sql<Array<{ mtime_ms: string | number | null }>>`
    SELECT mtime_ms FROM harness_shared.session_ingest_state
     WHERE source_kind = 'agent_chat' AND file_path = ${CHAT_HWM_PATH}
  `;
  const hwm = hwmRows.length ? Number(hwmRows[0].mtime_ms ?? 0) : 0;

  const chats = await sql<
    Array<{
      workspace_id: string;
      harness_slug: string;
      id: string;
      transcript: Array<{ ts?: string; role?: string; content?: unknown }> | null;
      updated_at: string | number;
    }>
  >`
    SELECT workspace_id, harness_slug, id, transcript, updated_at
      FROM harness_shared.agent_chats_consolidated
     WHERE updated_at > ${hwm} AND transcript IS NOT NULL
     ORDER BY updated_at ASC
     LIMIT ${MAX_CHATS_PER_TICK}
  `;
  if (!chats.length) return 0;

  let ingested = 0;
  let maxUpdated = hwm;
  for (const chat of chats) {
    // Budget check BEFORE advancing the high-water mark — a chat skipped for
    // budget must be re-fetched next tick, so the hwm may only cover chats we
    // actually processed.
    if (budget.turns <= 0) break;
    const transcript = Array.isArray(chat.transcript) ? chat.transcript : [];
    const key = `chat:${chat.workspace_id}:${chat.harness_slug}:${chat.id}`;
    const st = await readState(sql, 'agent_chat', key);
    if (transcript.length <= st.turn_count) {
      maxUpdated = Math.max(maxUpdated, Number(chat.updated_at)); // processed: nothing new
      continue;
    }
    const rows: TurnRow[] = [];
    let promptDelta = 0;
    let responseDelta = 0;
    for (let i = st.turn_count; i < transcript.length; i += 1) {
      const t = transcript[i];
      const speaker = t.role === 'user' ? 'user' : t.role === 'assistant' ? 'assistant' : null;
      if (!speaker) continue;
      const text = cleanTurnText(typeof t.content === 'string' ? t.content : textFromContent(t.content));
      if (!text) continue;
      // EI-9970: agent_chats_consolidated is already one JSONB entry per real
      // turn (no thinking-only/tool-only sub-line splitting like the file
      // adapters), so a plain per-speaker count is exact here — no dedup
      // cursor needed. tool_call_count stays 0: this transcript shape carries
      // no tool-call signal (documented limitation, sessions:list note).
      if (speaker === 'user') promptDelta += 1;
      else responseDelta += 1;
      rows.push({
        workspace_id: chat.workspace_id,
        source_kind: 'agent_chat',
        session_id: chat.id,
        turn_idx: i,
        ts: parseTs(t.ts)?.toISOString() ?? null,
        owner: null,
        harness_slug: chat.harness_slug,
        cwd: null,
        speaker,
        text,
      });
    }
    ingested += await insertTurns(sql, rows);
    await writeState(sql, 'agent_chat', key, {
      byte_offset: 0,
      turn_count: transcript.length,
      prompt_count: st.prompt_count + promptDelta,
      response_count: st.response_count + responseDelta,
      tool_call_count: st.tool_call_count,
      counts_backfill_offset: transcript.length,
      counts_backfill_last_inference_id: null,
      counts_backfilled_at: new Date().toISOString(),
      sessionId: chat.id,
    });
    budget.turns -= rows.length;
    maxUpdated = Math.max(maxUpdated, Number(chat.updated_at)); // processed
  }
  await writeState(sql, 'agent_chat', CHAT_HWM_PATH, {
    byte_offset: 0,
    turn_count: 0,
    counts_backfilled_at: new Date().toISOString(),
    mtimeMs: maxUpdated,
  });
  return ingested;
}

/* ------------------------------------------------------------------ */
/* Retention                                                            */
/* ------------------------------------------------------------------ */

/** Batched retention prune — the index stays bounded; the JSONL stays the
 * archive. Called from the daily retention tick (periodic-workflows.ts). */
export async function pruneSessionTurnsOnce(): Promise<{ deleted: number; partsDeleted: number }> {
  const { sql } = getOrgPg();
  let deleted = 0;
  let partsDeleted = 0;
  for (let i = 0; i < 40; i += 1) {
    const r = await sql`
      DELETE FROM harness_shared.session_turns
       WHERE ctid IN (
         SELECT ctid FROM harness_shared.session_turns
          WHERE COALESCE(ts, ingested_at) < now() - make_interval(days => ${RETENTION_DAYS})
          LIMIT 5000
       )
    `;
    deleted += r.count ?? 0;
    if ((r.count ?? 0) < 5000) break;
  }
  // Bookkeeping rows for files idle past the window are dead weight.
  await sql`
    DELETE FROM harness_shared.session_ingest_state
     WHERE updated_at < now() - make_interval(days => ${RETENTION_DAYS * 2})
       AND file_path <> ${CHAT_HWM_PATH}
  `;
  // The per-turn journal (P-012) rides the same retention window — it is a
  // bounded surface over the same transcripts, not an archive.
  await sql`
    DELETE FROM harness_shared.session_turn_journal
     WHERE created_at < now() - make_interval(days => ${RETENTION_DAYS})
  `;
  // P-001/D-002: the faithful parts store rides a SHORTER window than the
  // turns index (14 d vs 45 d). Measured at ~134 MB/7 d against session_turns'
  // 472 MB heap for 45 d, so an equal window would have made the render
  // convenience three times the size of the recall corpus it serves. Beyond
  // this window the pane degrades to text turns, then to session_archives —
  // each tier strictly cheaper and lossier, and none of them a dead click.
  // Batched exactly like the turns prune above: one unbounded DELETE over the
  // bulkiest table in the corpus is a long lock on the daily tick.
  for (let i = 0; i < 40; i += 1) {
    const r = await sql`
      DELETE FROM harness_shared.session_turn_parts
       WHERE ctid IN (
         SELECT ctid FROM harness_shared.session_turn_parts
          WHERE COALESCE(ts, ingested_at) < now() - make_interval(days => ${PART_RETENTION_DAYS})
          LIMIT 5000
       )
    `;
    partsDeleted += r.count ?? 0;
    if ((r.count ?? 0) < 5000) break;
  }
  return { deleted, partsDeleted };
}

/* ------------------------------------------------------------------ */
/* The periodic tick                                                    */
/* ------------------------------------------------------------------ */

// Single-flight realm-pinned (perf rule A18): tsx/dual-path imports can
// instantiate this module twice; a module-scoped flag would not dedupe.
// Pinned through @papercusp/module-singleton rather than a hand-rolled
// `globalThis[Symbol.for(...)]` pair, so the pin stays visible to
// listModuleDuplications() (EI-19479108855357092).
interface SweepState { running: boolean; last: IngestStats | null }
const __sweep = pinModuleState<SweepState>(
  '@papercusp/operator-core.sessionIngestState',
  () => ({ running: false, last: null }),
);

export function getLastSessionIngestStats(): IngestStats | null {
  return __sweep.last;
}

/** One bounded ingest sweep across every adapter. Never throws. */
export async function runSessionIngestOnce(): Promise<IngestStats> {
  const started = performance.now();
  const stats: IngestStats = {
    filesScanned: 0, filesIngested: 0, turnsInserted: 0, chatsIngested: 0, countBackfillFiles: 0,
    partsBackfillFiles: 0,
    errors: 0, durationMs: 0,
  };
  if (__sweep.running) return { ...stats, skipped: 'already_running' };
  const phaseMs: NonNullable<IngestStats['phaseMs']> = {
    setup: 0, history: 0, discovery: 0, state: 0, metadata: 0,
    decode: 0, writes: 0, metadataBackfill: 0, chats: 0, other: 0,
  };
  // Measure at existing operation boundaries: no new timer or per-file async hop.
  // finally retains the cost of failed work without changing its error contract.
  async function measure<T>(phase: keyof typeof phaseMs, work: () => Promise<T>): Promise<T> {
    const began = performance.now();
    try { return await work(); }
    finally { phaseMs[phase] += performance.now() - began; }
  }
  async function measureMetadataBackfill(
    sourceKind: SourceKind,
    operation: NonNullable<IngestStats['metadataBackfills']>[number]['operation'],
    requested: number,
    work: (receipt: NonNullable<IngestStats['metadataBackfills']>[number]) => Promise<number>,
  ): Promise<void> {
    if (!requested) return;
    const startedAtMs = Date.now();
    const began = performance.now();
    const receipt: NonNullable<IngestStats['metadataBackfills']>[number] = {
      sourceKind, operation, requested, startedAtMs, durationMs: 0, status: 'failed',
    };
    try {
      receipt.updated = await measure('metadataBackfill', () => work(receipt));
      receipt.status = 'completed';
    } catch (err) {
      // Metadata repair must not discard successful tail/offset progress or
      // prevent the other repair. Report it and retry the still-needed repair
      // on the next ordinary sweep, including unchanged transcripts.
      stats.errors += 1;
      if ((stats.errorSample ??= []).length < 3) {
        const label = operation === 'sessionOwners' ? 'owner backfill'
          : operation === 'partOwners' ? 'part owner backfill' : 'adv metadata';
        stats.errorSample.push(`${sourceKind} ${label}: ${(err as Error).message.slice(0, 200)}`);
      }
    } finally {
      receipt.durationMs = Math.round((performance.now() - began) * 10) / 10;
      (stats.metadataBackfills ??= []).push(receipt);
    }
  }
  __sweep.running = true;
  try {
    let enabled = true;
    try {
      enabled = await measure('setup', () => getFlag(FLAGS.SESSION_SEARCH, 'system:session-ingest'));
    } catch {
      /* fail-open: flag default is ON */
    }
    if (!enabled) return { ...stats, skipped: 'flag_off' };

    const { sql } = getOrgPg();
    try {
      stats.partsBackfillFiles = await measure('history', () => backfillHistoricalParts(sql));
    } catch (err) {
      stats.errors += 1;
      console.warn(`[session-ingest] historical parts backfill skipped (non-fatal): ${(err as Error).message}`);
    }
    try {
      stats.countBackfillFiles = await measure('history', () => backfillHistoricalCounts(sql));
    } catch (err) {
      stats.errors += 1;
      console.warn(`[session-ingest] historical count backfill skipped (non-fatal): ${(err as Error).message}`);
    }
    const sinceMs = Date.now() - INGEST_WINDOW_DAYS * 24 * 3600 * 1000;
    const budget = { turns: MAX_TURNS_PER_TICK };

    // P-002 / migration 674 — the substitution registry, fetched ONCE per sweep
    // and matched per Bash command to attribute an intent bucket at ingest.
    //
    // ⚠ TWO DIFFERENT `workspace_id`s, and they are NOT interchangeable. The
    // rollup (like session_turns) is written under the literal 'default' — the
    // session-transcript CORPUS namespace, which is not a tenant. The registry
    // rows live under the REAL tenant (activeWorkspaceId(), 'papercusp-workspace'
    // here), the same id locks:check_command resolves. Reading the registry with
    // 'default' returns zero rows and silently disables every bucket count while
    // the ingest still looks perfectly healthy — so resolve the tenant, and let
    // an empty result be loud rather than assumed (the counts simply do not
    // appear, which the report's own emptyRegistry flag surfaces).
    //
    // Fail-soft: a registry read failure costs bucket attribution for this
    // sweep, never the ingest (same contract as writeUsageRollup).
    let substitutionRows: SubstitutionRow[] = [];
    try {
      substitutionRows = await measure('setup', () => getSubstitutionRows(activeWorkspaceId()));
    } catch (err) {
      stats.errors += 1;
      console.warn(`[session-ingest] substitution registry read failed (buckets skipped): ${(err as Error).message}`);
    }

    for (const adapter of FILE_ADAPTERS) {
      if (budget.turns <= 0) break;
      let candidates: Array<{ path: string; size: number; mtimeMs: number }> = [];
      try {
        candidates = await measure('discovery', () => listCandidateFiles(adapter, sinceMs));
      } catch (err) {
        stats.errors += 1;
        console.warn(`[session-ingest] ${adapter.sourceKind} enumerate failed: ${(err as Error).message}`);
        continue;
      }
      // Newest first: recent sessions index first; history back-fills over ticks.
      candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
      // Bulk-load this adapter's ingest state ONCE — a per-file SELECT at ~23k
      // candidate files was minutes of serial round-trips (perf anti-pattern
      // A1: per-item queries in a loop; observed live 2026-07-05).
      const stateRows = await measure('state', () => sql<Array<{
        file_path: string; byte_offset: string | number; turn_count: number; part_count: number | null;
        prompt_count: number; response_count: number; tool_call_count: number; last_inference_id: string | null;
        counts_backfill_offset: string | number; counts_backfill_last_inference_id: string | null;
        counts_backfilled_at: string | null;
      }>>`
        SELECT file_path, byte_offset, turn_count, part_count, prompt_count, response_count, tool_call_count, last_inference_id,
               counts_backfill_offset, counts_backfill_last_inference_id, counts_backfilled_at
          FROM harness_shared.session_ingest_state
         WHERE source_kind = ${adapter.sourceKind}
      `);
      const stateMap = new Map<string, IngestState>(
        stateRows.map((r) => [r.file_path, {
          byte_offset: Number(r.byte_offset),
          turn_count: r.turn_count,
          part_count: r.part_count ?? 0,
          prompt_count: r.prompt_count ?? 0,
          response_count: r.response_count ?? 0,
          tool_call_count: r.tool_call_count ?? 0,
          last_inference_id: r.last_inference_id ?? null,
          counts_backfill_offset: Number(r.counts_backfill_offset ?? r.byte_offset),
          counts_backfill_last_inference_id: r.counts_backfill_last_inference_id ?? null,
          counts_backfilled_at: r.counts_backfilled_at ?? null,
        }]),
      );
      let filesThisAdapter = 0;
      const ownerBackfill = new Map<string, string>();
      const indexedClaudeOwners = adapter.sourceKind === 'claude'
        ? await measure('state', () => indexedClaudeOwnersForCandidates(adapter, candidates))
        : new Map<string, string>();
      const conflictingClaudePartOwners = new Map<string, string>();
      if (adapter.sourceKind === 'claude') {
        for (const candidate of candidates) {
          const { sessionId, owner } = adapter.meta(candidate.path);
          const indexed = indexedClaudeOwners.get(sessionId);
          // The turn budget can stop the ingest loop before it visits every
          // candidate. Build the repair map from the complete discovery set so
          // a partial sweep cannot revert owners repaired by a full sweep.
          const selected = indexed ?? owner;
          if (selected) ownerBackfill.set(sessionId, selected);
          if (owner && indexed && owner !== indexed) conflictingClaudePartOwners.set(sessionId, indexed);
        }
      }
      const codexMetadataBackfill = new Map<number, CodexAdvSessionMetadata>();
      let ompOwnersByAdvSession = new Map<number, string>();
      if (adapter.sourceKind === 'omp') {
        const managedIds = candidates
          .map((candidate) => adapter.meta(candidate.path).advSessionId)
          .filter((id): id is number => id != null);
        try {
          ompOwnersByAdvSession = await measure('state', () => loadOmpSessionOwners(sql, managedIds));
        } catch (err) {
          stats.errors += 1;
          if ((stats.errorSample ??= []).length < 3) {
            stats.errorSample.push(`omp owner lookup: ${(err as Error).message.slice(0, 200)}`);
          }
        }
      }
      for (const cand of candidates) {
        if (budget.turns <= 0 || filesThisAdapter >= MAX_FILES_PER_TICK) break;
        stats.filesScanned += 1;
        try {
          const metadataStarted = performance.now();
          const st = stateMap.get(cand.path) ?? { ...EMPTY_STATE };
          const meta = adapter.meta(cand.path);
          const owner = indexedClaudeOwners.get(meta.sessionId) ?? meta.owner ?? (
            adapter.sourceKind === 'omp' && meta.advSessionId != null
              ? ompOwnersByAdvSession.get(meta.advSessionId) ?? null
              : null
          );
          if (owner && adapter.sourceKind !== 'claude') ownerBackfill.set(meta.sessionId, owner);
          // Collect metadata BEFORE the byte-offset short circuit. A paused
          // session commonly has no late transcript turn, but its already
          // indexed rollout still carries the native id/config needed to repair
          // the adv row used by interval-overlap readers.
          if (adapter.sourceKind === 'codex') {
            const home = codexAdvSessionHome(cand.path);
            // Candidates are newest first; only the first valid rollout's
            // config can contribute to this adv row. Avoid reading configs
            // whose metadata would be discarded. This map lasts one sweep,
            // so later sweeps and single-file repairs still read fresh config.
            if (home && !codexMetadataBackfill.has(home.advSessionId)) {
              const codexMeta = codexAdvSessionMetadata(cand.path, meta.sessionId);
              if (codexMeta) codexMetadataBackfill.set(home.advSessionId, codexMeta);
            }
          }
          phaseMs.metadata += performance.now() - metadataStarted;
          if (cand.size <= st.byte_offset) continue; // nothing new
          filesThisAdapter += 1;
          const { turns, parts, newOffset, promptCount, responseCount, toolCallCount, lastInferenceId, usage } =
            await measure('decode', () => readNewLines(
              cand.path, st.byte_offset, adapter.parseLine, adapter.classifyLine, st.last_inference_id, adapter.usageOf,
              substitutionRows, adapter.parseParts,
            ));
          if (newOffset === st.byte_offset) continue;
          const rows: TurnRow[] = turns.map((t, i) => ({
            workspace_id: 'default',
            source_kind: adapter.sourceKind,
            session_id: t.sessionId ?? meta.sessionId,
            turn_idx: st.turn_count + i,
            ts: t.ts ? t.ts.toISOString() : null,
            owner,
            harness_slug: null,
            cwd: t.cwd ?? null,
            speaker: t.speaker,
            text: t.text,
            prompt_hash: t.promptHash ?? null,
          }));
          stats.turnsInserted += await measure('writes', () => insertTurns(sql, rows));
          // P-001 faithful parts — best-effort by contract (see insertParts):
          // a parts failure costs the render pane its fidelity for this window,
          // never the recall index and never the offset.
          try {
            stats.partsInserted = (stats.partsInserted ?? 0) + await measure('writes', () => insertParts(sql, partRowsFrom(parts, {
              sourceKind: adapter.sourceKind,
              sessionId: meta.sessionId,
              owner,
              partCount: st.part_count,
            })));
          } catch (err) {
            if ((stats.errorSample ??= []).length < 3) {
              stats.errorSample.push(`parts ${meta.sessionId}: ${(err as Error).message.slice(0, 160)}`);
            }
          }
          await measure('writes', () => writeState(sql, adapter.sourceKind, cand.path, {
            byte_offset: newOffset,
            turn_count: st.turn_count + turns.length,
            part_count: st.part_count + parts.length,
            prompt_count: st.prompt_count + promptCount,
            response_count: st.response_count + responseCount,
            tool_call_count: st.tool_call_count + toolCallCount,
            last_inference_id: lastInferenceId,
            counts_backfill_offset: newOffset,
            counts_backfill_last_inference_id: lastInferenceId,
            counts_backfilled_at: new Date().toISOString(),
            sessionId: meta.sessionId,
            mtimeMs: cand.mtimeMs,
          }));
          // P-002 — deliberately AFTER writeState and independently caught: the
          // substitution metric must never fail, retry, or wedge an ingest.
          try {
            await measure('writes', () => writeUsageRollup(sql, adapter.sourceKind, meta.sessionId, usage));
          } catch (err) {
            if ((stats.errorSample ??= []).length < 3) {
              stats.errorSample.push(`usage-rollup ${meta.sessionId}: ${(err as Error).message.slice(0, 160)}`);
            }
          }
          stats.filesIngested += 1;
          budget.turns -= turns.length;
        } catch (err) {
          stats.errors += 1;
          if ((stats.errorSample ??= []).length < 3) {
            stats.errorSample.push(`${cand.path.split('/').pop()}: ${(err as Error).message.slice(0, 200)}`);
          }
          // Record the error WITHOUT touching offsets — resetting byte_offset/
          // turn_count on a transient failure would restart turn_idx at 0 and
          // silently drop every subsequent turn to ON CONFLICT DO NOTHING.
          try {
            await measure('writes', () => sql`
              UPDATE harness_shared.session_ingest_state
                 SET last_error = ${(err as Error).message.slice(0, 300)}, updated_at = now()
               WHERE source_kind = ${adapter.sourceKind} AND file_path = ${cand.path}
            `);
          } catch { /* bookkeeping best-effort */ }
        }
      }
      await measureMetadataBackfill(adapter.sourceKind, 'sessionOwners', ownerBackfill.size,
        (receipt) => backfillSessionOwners(sql, adapter.sourceKind, ownerBackfill,
          (inputSha256) => { receipt.inputSha256 = inputSha256; }));
      if (adapter.sourceKind === 'claude') {
        await measureMetadataBackfill(adapter.sourceKind, 'partOwners', conflictingClaudePartOwners.size,
          (receipt) => backfillClaudePartOwners(sql, conflictingClaudePartOwners,
            (inputSha256) => { receipt.inputSha256 = inputSha256; }));
      }
      if (adapter.sourceKind === 'codex') {
        await measureMetadataBackfill(adapter.sourceKind, 'codexAdvSessions', codexMetadataBackfill.size,
          () => backfillCodexAdvSessions(sql, codexMetadataBackfill));
      }
    }

    if (budget.turns > 0) {
      try {
        stats.chatsIngested = await measure('chats', () => syncAgentChats(sql, budget));
      } catch (err) {
        stats.errors += 1;
        console.warn(`[session-ingest] agent_chat sync failed: ${(err as Error).message}`);
      }
    }

    const durationMs = performance.now() - started;
    phaseMs.other = Math.max(0, durationMs - Object.values(phaseMs).reduce((sum, ms) => sum + ms, 0));
    stats.phaseMs = Object.fromEntries(
      Object.entries(phaseMs).map(([phase, ms]) => [phase, Math.round(ms * 10) / 10]),
    ) as typeof phaseMs;
    stats.durationMs = Math.round(durationMs);
    __sweep.last = stats;
    return stats;
  } finally {
    __sweep.running = false;
  }
}
