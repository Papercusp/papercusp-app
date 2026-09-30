/**
 * gate-watch.ts — the client-agnostic transcript watcher half of the
 * owner-gate tracker (owner-inbox-single-pane-2026-07-17 P-002).
 *
 * Detects a session BLOCKED ON THE OWNER purely from its transcript, with no
 * hook cooperation required: an `AskUserQuestion` / `ExitPlanMode` tool_use
 * with no later `tool_result` in the file = the session is waiting on a human
 * answer. When the matching tool_result eventually lands, the gate closes.
 * This is the fallback that works even for clients with no turn-end hook
 * (Codex today — plan D-002/Background).
 *
 * Same byte-watermark tailing discipline as
 * `interactive-usage/ingest-claude-transcripts.ts` (this module deliberately
 * mirrors its shape): `parseGateChunk` is a pure, unit-testable function over
 * a raw chunk of JSONL; `tickGateWatch` is the stateful outer loop that reads
 * each file's delta past its watermark and persists via gate-store.ts.
 * Watermarks live in their OWN table (`session_gate_watcher_files`, migration
 * 619) rather than sharing `interactive_usage_files` — a different
 * producer/consumer, kept decoupled.
 *
 * "Claude transcripts first" (plan Background) — this tick walks every Claude
 * transcript root (`defaultGateWatchRoots`: the psu root AND the native
 * `~/.claude/projects`); codex/OMP roots are a straightforward follow-on (same
 * shape as `interactive-usage/ingest-adapters.ts`) once each adapter's
 * tool_use/tool_result line shape is confirmed, left for a later plan item.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../workspace-registry';
import { readFileDelta } from '../interactive-usage/ingest-claude-transcripts';
import { closeGateByToolUseId, listOpenGateRefs, openOrTouchGate } from './gate-store';

/** Tool names whose unanswered tool_use means "blocked on the owner". */
const GATE_TOOL_NAMES = new Set(['AskUserQuestion', 'ExitPlanMode']);
const QUESTION_MAX_CHARS = 500;

export interface GateOpenEvent {
  toolUseId: string;
  toolName: string;
  question: string;
  options: Array<{ label: string; description?: string }> | null;
}

export interface GateCloseEvent {
  toolUseId: string;
}

export interface ParsedGateChunk {
  opens: GateOpenEvent[];
  closes: GateCloseEvent[];
  /**
   * Asks whose tool_result landed in this SAME chunk.
   *
   * They were never observably open, so they are correctly absent from
   * `opens` — but a gate the STORE already holds open (minted by a turn-end
   * hook, or by an earlier tick) is discharged by exactly this evidence. On a
   * cold-start full-file replay EVERY historical ask/answer pair lands in one
   * chunk, so dropping these (the pre-WI-10002079 behaviour) left the watcher
   * structurally unable to close the very gates whose transcript proves they
   * were answered. The caller still intersects against what is actually open,
   * so a non-gate pair remains a harmless, ignorable candidate.
   */
  resolved: GateCloseEvent[];
  consumedBytes: number;
}

interface AskUserQuestionInput {
  questions?: Array<{
    question?: string;
    header?: string;
    options?: Array<{ label?: string; description?: string }>;
  }>;
}

/** Best-effort human-readable question + flattened options for a gate tool_use. */
export function extractGateQuestion(
  toolName: string,
  input: unknown,
): { question: string; options: Array<{ label: string; description?: string }> | null } {
  if (toolName === 'AskUserQuestion') {
    const inp = (input ?? {}) as AskUserQuestionInput;
    const qs = Array.isArray(inp.questions) ? inp.questions : [];
    const question =
      qs
        .map((q) => (typeof q?.question === 'string' ? q.question : ''))
        .filter(Boolean)
        .join(' / ')
        .slice(0, QUESTION_MAX_CHARS) || 'AskUserQuestion';
    const options = qs
      .flatMap((q) => (Array.isArray(q?.options) ? q.options : []))
      .filter((o): o is { label: string; description?: string } => typeof o?.label === 'string')
      .map((o) => ({ label: o.label, description: typeof o.description === 'string' ? o.description : undefined }))
      .slice(0, 20);
    return { question, options: options.length ? options : null };
  }
  // ExitPlanMode (and any future gate-shaped tool): best-effort text only.
  const inp = (input ?? {}) as { plan?: string };
  const plan = typeof inp.plan === 'string' ? inp.plan : '';
  const question = plan
    ? `Exit plan mode — approve this plan?\n\n${plan}`.slice(0, QUESTION_MAX_CHARS)
    : 'Exit plan mode — approve?';
  return { question, options: null };
}

/**
 * Parse one incremental chunk (bytes read from the watermark onward) of a
 * Claude Code transcript. Only complete lines are consumed (the trailing
 * partial line is left for next tick, same discipline as
 * `parseTranscriptChunk`). An ask resolved WITHIN the same chunk (tool_use +
 * its tool_result both land in this delta) cancels out — it was never
 * observably open, so it never surfaces as a gate. A tool_result whose
 * tool_use lives in a PRIOR chunk is reported as a close candidate; the
 * caller intersects that against what's actually open in the store (a
 * tool_result for a non-gate tool is a harmless, ignorable candidate).
 */
export function parseGateChunk(chunk: string): ParsedGateChunk {
  const lastNewline = chunk.lastIndexOf('\n');
  if (lastNewline === -1) return { opens: [], closes: [], resolved: [], consumedBytes: 0 };
  const consumed = chunk.slice(0, lastNewline + 1);
  const stillOpen = new Map<string, GateOpenEvent>();
  const closes: GateCloseEvent[] = [];
  const resolved: GateCloseEvent[] = [];

  for (const line of consumed.split('\n')) {
    if (!line.trim()) continue;
    let j: unknown;
    try {
      j = JSON.parse(line);
    } catch {
      continue; // torn/garbage line — consumed, contributes nothing
    }
    const evt = j as { type?: string; message?: { content?: unknown } };
    const content = evt?.message?.content;
    if (!Array.isArray(content)) continue;

    if (evt.type === 'assistant') {
      for (const part of content) {
        const p = part as { type?: string; id?: string; name?: string; input?: unknown };
        if (p?.type !== 'tool_use' || !p.id || !p.name || !GATE_TOOL_NAMES.has(p.name)) continue;
        const { question, options } = extractGateQuestion(p.name, p.input);
        stillOpen.set(p.id, { toolUseId: p.id, toolName: p.name, question, options });
      }
    } else if (evt.type === 'user') {
      for (const part of content) {
        const p = part as { type?: string; tool_use_id?: string };
        if (p?.type !== 'tool_result' || !p.tool_use_id) continue;
        if (stillOpen.has(p.tool_use_id)) {
          stillOpen.delete(p.tool_use_id); // resolved inside this same window
          resolved.push({ toolUseId: p.tool_use_id });
        } else {
          closes.push({ toolUseId: p.tool_use_id });
        }
      }
    }
  }
  return { opens: [...stillOpen.values()], closes, resolved, consumedBytes: Buffer.byteLength(consumed, 'utf8') };
}

export interface GateWatchOptions {
  /**
   * Single-root form. When set it REPLACES the defaults — kept so an existing
   * routine `trigger_config.root` and the focused tests keep working.
   */
  root?: string;
  /** Explicit root list; when set it REPLACES the defaults. */
  roots?: string[];
  maxFilesPerTick?: number;
  maxBytesPerFile?: number;
  /**
   * WI-10002079/R3. A transcript seen for the FIRST time (no watermark row)
   * whose last write is older than this is replayed for CLOSES ONLY — its
   * unanswered historical asks never mint a gate. Default 24h.
   */
  coldStartOpenWindowMs?: number;
  /** Injectable clock for the cold-start window (tests). */
  now?: number;
}

export interface GateWatchResult {
  roots: string[];
  /** Transcripts that actually had unread bytes this tick (an already-current
   *  file costs a stat, not a budget slot). */
  scannedFiles: number;
  opened: number;
  alreadyOpen: number;
  closed: number;
  /** Opens suppressed by the R3 cold-start rule — dead history, not a miss. */
  coldStartSkippedOpens: number;
  /** TRUE when `maxFilesPerTick` cut the pass short; the next tick resumes
   *  where this one stopped, because every processed file leaves a watermark. */
  budgetExhausted: boolean;
  errors: Array<{ file: string; error: string }>;
}

const DEFAULT_MAX_FILES = 5000;
const DEFAULT_MAX_BYTES_PER_FILE = 32 * 1024 * 1024;
const DEFAULT_COLD_START_OPEN_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Every transcript root this box actually writes.
 *
 * WI-10002079/R1. `~/.claude/projects` alone — the original default — is the
 * NATIVE CLI's root and holds a small minority of this box's transcripts;
 * psu sessions write under
 * `~/.papercusp/session-claude/<owner>/projects/<encoded>/<session>.jsonl`.
 * Measured when this was filed: 300 files under the old root vs 2,105 under
 * the psu one, and of the open gates whose transcript demonstrably contained
 * the closing tool_result, ZERO were under the watched root. The watcher was
 * tailing a tree that does not contain the sessions it exists to watch.
 *
 * Both are returned (not swapped) because a plain `claude` run on this box
 * still writes the native root — a session id is unique across them, and the
 * file list is de-duplicated by absolute path.
 */
export function defaultGateWatchRoots(home: string = os.homedir()): string[] {
  return [path.join(home, '.papercusp', 'session-claude'), path.join(home, '.claude', 'projects')];
}

/**
 * One watcher tick: walk every transcript root, read each file's delta past
 * its watermark, and upsert opens/closes into session_pending_gates.
 * Safe to re-run (the system-actions contract) — every file delta is fenced
 * by its own byte watermark.
 */
export async function tickGateWatch(opts: GateWatchOptions = {}): Promise<GateWatchResult> {
  const roots = opts.roots?.length ? opts.roots : opts.root ? [opts.root] : defaultGateWatchRoots();
  const maxFiles = opts.maxFilesPerTick ?? DEFAULT_MAX_FILES;
  const capBytes = opts.maxBytesPerFile ?? DEFAULT_MAX_BYTES_PER_FILE;
  const coldWindowMs = opts.coldStartOpenWindowMs ?? DEFAULT_COLD_START_OPEN_WINDOW_MS;
  const now = opts.now ?? Date.now();
  const { sql } = getOrgPg();
  const ws = activeWorkspaceId();

  const result: GateWatchResult = {
    roots,
    scannedFiles: 0,
    opened: 0,
    alreadyOpen: 0,
    closed: 0,
    coldStartSkippedOpens: 0,
    budgetExhausted: false,
    errors: [],
  };

  const files: string[] = [];
  const seenPaths = new Set<string>();
  for (const root of roots) {
    let entries: Array<{ parentPath?: string; path?: string; name: string; isFile(): boolean }>;
    try {
      entries = (await fs.readdir(root, { withFileTypes: true, recursive: true })) as never;
    } catch {
      continue; // this root does not exist on this box — the others still count
    }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
      const full = path.join((e.parentPath ?? e.path ?? root) as string, e.name);
      if (seenPaths.has(full)) continue;
      seenPaths.add(full);
      files.push(full);
    }
  }

  const wmRows = await sql<Array<{ file_path: string; byte_offset: string }>>`
    SELECT file_path, byte_offset FROM harness_shared.session_gate_watcher_files WHERE workspace_id = ${ws}
  `;
  const watermarks = new Map(wmRows.map((r) => [r.file_path, Number(r.byte_offset)]));

  // Batch-fetch the currently-open ref ids ONCE per tick so a close candidate
  // for an ordinary (non-gate) tool_result never costs a write — we only ever
  // call closeGateByToolUseId for a ref this tick's opens-so-far confirm.
  //
  // WI-10002079/R2: this MUST be the complete open set. It used to seed from
  // listPendingGates({ limit: 200 }) — the display read, hard-clamped to 200
  // and ordered oldest-first — so past 200 open gates the NEWEST were silently
  // unclosable, which is exactly backwards.
  const openRefs = await listOpenGateRefs({ workspaceId: ws });
  const openRefsBySession = new Map<string, Set<string>>();
  for (const g of openRefs) {
    const set = openRefsBySession.get(g.session_id) ?? new Set<string>();
    set.add(g.ref_id);
    openRefsBySession.set(g.session_id, set);
  }

  for (const file of files) {
    if (result.scannedFiles >= maxFiles) {
      // The budget is a per-tick WORK cap, applied HERE rather than as a
      // `.slice(0, maxFiles)` over the raw list: slicing made the cap a
      // permanent horizon, so once the corpus outgrew it the tail was never
      // reached on ANY tick. Every processed file leaves a watermark, so
      // stopping here just resumes next tick.
      result.budgetExhausted = true;
      break;
    }
    try {
      const { size, mtimeMs } = await fs.stat(file);
      const firstSeen = !watermarks.has(file);
      let offset = watermarks.get(file) ?? 0;
      if (size < offset) offset = 0; // recreated transcript — re-ingest from the top
      if (size === offset) continue; // already current — costs a stat, not a budget slot
      result.scannedFiles += 1;
      const chunk = await readFileDelta(file, offset, capBytes);
      const { opens, closes, resolved, consumedBytes } = parseGateChunk(chunk);
      if (consumedBytes === 0) continue; // no complete line yet — retry next tick
      const sessionId = path.basename(file, '.jsonl');

      // WI-10002079/R3 — the cold-start replay bound. With no watermark rows
      // a first tick reads every file from byte 0, so a transcript's entire
      // history arrives as one chunk. Minting gates from that would OPEN asks
      // abandoned by long-dead sessions, growing the very backlog this watcher
      // exists to drain. An OLD first-seen transcript is therefore replayed
      // for CLOSES only; a RECENT one is ingested normally, because its
      // trailing unanswered ask is a genuinely live gate.
      const coldStartReplay = firstSeen && mtimeMs < now - coldWindowMs;
      if (coldStartReplay) {
        result.coldStartSkippedOpens += opens.length;
      } else {
        for (const open of opens) {
          const { outcome } = await openOrTouchGate({
            workspaceId: ws,
            sessionId,
            client: 'claude',
            kind: 'ask',
            refId: open.toolUseId,
            question: open.question,
            options: open.options,
            source: 'watcher',
            rawRef: file,
          });
          if (outcome === 'opened') result.opened += 1;
          else result.alreadyOpen += 1;
          const set = openRefsBySession.get(sessionId) ?? new Set<string>();
          set.add(open.toolUseId);
          openRefsBySession.set(sessionId, set);
        }
      }

      // `resolved` (ask + its answer inside this SAME chunk) is closing
      // evidence exactly as `closes` is. Both are intersected against what the
      // STORE actually holds open, so a non-gate pair stays ignorable — but a
      // gate a turn-end hook minted, whose answer is already in the
      // transcript, becomes dischargeable. On the cold-start replay above it
      // is the ONLY shape the evidence can take, because every historical
      // ask/answer pair cancels within the chunk.
      const knownOpen = openRefsBySession.get(sessionId);
      for (const close of [...closes, ...resolved]) {
        if (!knownOpen?.has(close.toolUseId)) continue; // not a gate we opened — ignore
        const closedCount = await closeGateByToolUseId({ workspaceId: ws, sessionId, toolUseId: close.toolUseId });
        if (closedCount > 0) {
          result.closed += closedCount;
          knownOpen.delete(close.toolUseId);
        }
      }

      await sql`
        INSERT INTO harness_shared.session_gate_watcher_files (workspace_id, file_path, byte_offset, updated_at)
        VALUES (${ws}, ${file}, ${offset + consumedBytes}, now())
        ON CONFLICT (workspace_id, file_path)
        DO UPDATE SET byte_offset = EXCLUDED.byte_offset, updated_at = now()
      `;
    } catch (e) {
      result.errors.push({ file, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return result;
}
