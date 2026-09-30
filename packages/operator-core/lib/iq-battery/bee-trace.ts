/**
 * bee-trace.ts — read a FINISHED bee's run into the judge's distilled trace +
 * the collectors' REAL metric signals (Apiary `apiary-generation-0-battery` P-002 / D-004).
 *
 * For gen-0 "an instance" = a sandboxed fleet bee (D-002): one bee per (case, repeat),
 * spawned with the case prompt, run to a terminal state. Its work is observable in three
 * already-durable places — and this module turns those into the two things the battery needs:
 *
 *   1. the judge's `distilledTrace` (what the opus-4-8 judge reads), built from the bee's
 *      transcript JSONL + `output_tail` via the gym's `distillTrace` (selection/budgeting);
 *   2. the collectors' `MetricCollectorInput` `signals` (D-004) — status / tokens / time /
 *      first-attempt / escalation — so the seven metrics measure the ACTUAL run, not the
 *      `{stubbed:true}` defaults the PART-B stub used.
 *
 * The token signal comes from `harness_shared.agent_usage_samples` (one row per governed call,
 * attributed by `run_id` — see `agent-usage-telemetry.ts`); the transcript is the fallback when
 * no samples landed. The spawn row supplies terminal status + wall-clock + `output_tail`.
 *
 * Everything here is PURE or loader-injected — no PG, FS, or spend in the core — so it unit-tests
 * against fixtures. The live loaders (org-PG reads + on-disk transcript) are wired in the runner
 * (P-004); `locateBeeTranscript` resolves the per-spawn `CLAUDE_CONFIG_DIR` transcript path.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { sessionClaudeConfigDir } from '@papercusp/orchestrator/session-launch-dirs';
import { distillTrace, type RawTrace } from '../gym/distill';
import type { MetricCollectorInput } from './collectors';
import type { InstanceRunHandle } from './instance-manifest';
import type { CorpusCase } from './corpus';

/** The fields of a `harness_shared.spawned_agents` row this module reads. */
export interface BeeSpawnRow {
  /** 'done' | 'failed' | 'cancelled' | 'reaped' | 'running' */
  status: string;
  runId: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  durationMs: number | null;
  outputTail: string | null;
  errorMessage: string | null;
}

/** Token totals for one run (summed from `agent_usage_samples`, or the transcript fallback). */
export interface BeeRunTokens {
  inputTokens: number;
  outputTokens: number;
}

// ───────────────────────────── pure transcript parsing ─────────────────────────────

/** One claude-code transcript JSONL line (loosely typed — we read a few fields). */
interface TranscriptLine {
  type?: string;
  message?: {
    role?: string;
    content?: unknown;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
}

/** Parse a transcript JSONL blob into lines, skipping blank + malformed lines. */
export function parseTranscriptLines(jsonl: string): TranscriptLine[] {
  const out: TranscriptLine[] = [];
  for (const raw of jsonl.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as TranscriptLine);
    } catch {
      /* a partially-flushed last line is normal for a live transcript — skip it */
    }
  }
  return out;
}

/** Sum assistant-turn token usage — the fallback for when `agent_usage_samples` is empty. */
export function sumTranscriptTokens(lines: TranscriptLine[]): BeeRunTokens {
  let inputTokens = 0;
  let outputTokens = 0;
  for (const l of lines) {
    const u = l.message?.usage;
    if (l.type === 'assistant' && u) {
      inputTokens += u.input_tokens ?? 0;
      outputTokens += u.output_tokens ?? 0;
    }
  }
  return { inputTokens, outputTokens };
}

/**
 * Concatenate the bee's assistant text blocks (its reasoning + answers) into one trace string,
 * in transcript order. Tool-use blocks are reduced to a `[tool_use: <name>]` marker so the judge
 * sees the shape of the work without the raw tool payloads. User/system lines are dropped.
 */
export function extractAssistantText(lines: TranscriptLine[]): string {
  const parts: string[] = [];
  for (const l of lines) {
    if (l.type !== 'assistant') continue;
    const content = l.message?.content;
    if (typeof content === 'string') {
      if (content) parts.push(content);
      continue;
    }
    if (Array.isArray(content)) {
      for (const block of content as Array<Record<string, unknown>>) {
        if (block?.type === 'text' && typeof block.text === 'string') {
          parts.push(block.text as string);
        } else if (block?.type === 'tool_use' && typeof block.name === 'string') {
          parts.push(`[tool_use: ${block.name as string}]`);
        }
      }
    }
  }
  return parts.join('\n');
}

/**
 * Locate the newest transcript JSONL for a spawn under its per-spawn `CLAUDE_CONFIG_DIR`
 * (`~/.papercusp/session-claude/<spawnId>/projects/<slug>/<sessionId>.jsonl`). The detached
 * wake/launch path leaves this dir in place (see wake-executor.ts / spawn-mcp.ts). Returns the
 * newest `.jsonl` by mtime, or null if the spawn left no transcript.
 */
export function locateBeeTranscript(spawnId: string, baseDir?: string): string | null {
  const root = baseDir
    ? join(baseDir, spawnId, 'projects')
    : join(sessionClaudeConfigDir(spawnId), 'projects');
  if (!existsSync(root)) return null;
  let newest: { path: string; mtime: number } | null = null;
  let projDirs: string[];
  try {
    projDirs = readdirSync(root);
  } catch {
    return null;
  }
  for (const projDir of projDirs) {
    const projPath = join(root, projDir);
    let entries: string[];
    try {
      entries = readdirSync(projPath);
    } catch {
      continue;
    }
    for (const f of entries) {
      if (!f.endsWith('.jsonl')) continue;
      const p = join(projPath, f);
      let mtime: number;
      try {
        mtime = statSync(p).mtimeMs;
      } catch {
        continue;
      }
      if (!newest || mtime > newest.mtime) newest = { path: p, mtime };
    }
  }
  return newest?.path ?? null;
}

// ───────────────────────────── the distill effect (pure core) ─────────────────────────────

const ESCALATE_RE = /\bESCALATE\b/;
const SUCCESS_STATUS = 'done';

export interface CollectAndDistillResult {
  distilledTrace: string;
  traceRef: string;
  rawSignals: Record<string, unknown>;
  signals: Partial<MetricCollectorInput>;
}

/**
 * Map a finished bee + its transcript → the judge's distilled trace + the collectors' REAL
 * signals. Pure: every external read is passed in (`spawn`, `transcriptText`, `runTokens`).
 *
 * Signal mapping (→ `MetricCollectorInput`, see collectors.ts):
 *   - `workItemStatus`  ← 'done' iff the spawn reached the `done` terminal state, else its
 *                          raw terminal status (so failed/cancelled → not a success).
 *   - `escalated`       ← the bee emitted the `ESCALATE` verb (output_tail or trace tail).
 *   - `inputTokens`/`outputTokens` ← `agent_usage_samples` totals, transcript-sum fallback.
 *   - `workItemCreatedAt`/`workItemResolvedAt` ← spawn started/finished → drives time-to-green.
 *   - `workItemAttempts` ← 1 (a gen-0 bee is single-shot) → drives first-attempt-pass.
 */
export function collectAndDistillFromBee(args: {
  spawnId: string;
  spawn: BeeSpawnRow;
  transcriptText: string | null;
  runTokens: BeeRunTokens | null;
  maxChars: number;
}): CollectAndDistillResult {
  const lines = args.transcriptText ? parseTranscriptLines(args.transcriptText) : [];
  const assistantText = extractAssistantText(lines);

  // Prefer the attributed PG totals; fall back to the transcript when no sample landed.
  const tokens =
    args.runTokens && (args.runTokens.inputTokens || args.runTokens.outputTokens)
      ? args.runTokens
      : sumTranscriptTokens(lines);

  const status = args.spawn.status;
  const succeeded = status === SUCCESS_STATUS;
  const escalated =
    ESCALATE_RE.test(args.spawn.outputTail ?? '') || ESCALATE_RE.test(assistantText.slice(-2000));

  const rawSignals: Record<string, unknown> = {
    spawnId: args.spawnId,
    runId: args.spawn.runId,
    terminalStatus: status,
    exitError: args.spawn.errorMessage ?? null,
    durationMs: args.spawn.durationMs,
    inputTokens: tokens.inputTokens,
    outputTokens: tokens.outputTokens,
    escalated,
  };

  // Build the judge's trace. A gen-0 bee produces no captured git diff (a sandboxed workdir is a
  // later phase), so the assistant transcript carries the work; when the transcript is absent we
  // fall back to the spawn's output_tail. Everything is budgeted inside distillTrace's maxChars.
  const traceText = assistantText || args.spawn.outputTail || '';
  const raw: RawTrace = {
    diff: '',
    roleTranscripts: traceText
      ? [{ role: assistantText ? 'cup' : 'bee(output_tail)', runId: args.spawn.runId ?? args.spawnId, text: traceText }]
      : [],
    terminalState: status,
    signals: rawSignals,
  };
  const distilled = distillTrace(raw, { maxChars: args.maxChars });

  const signals: Partial<MetricCollectorInput> = {
    workItemStatus: succeeded ? 'done' : status,
    workItemAttempts: 1,
    escalated,
    ...(tokens.inputTokens ? { inputTokens: tokens.inputTokens } : {}),
    ...(tokens.outputTokens ? { outputTokens: tokens.outputTokens } : {}),
    ...(args.spawn.startedAt ? { workItemCreatedAt: args.spawn.startedAt } : {}),
    ...(args.spawn.finishedAt ? { workItemResolvedAt: args.spawn.finishedAt } : {}),
  };

  return { distilledTrace: distilled.text, traceRef: `bee:${args.spawnId}`, rawSignals, signals };
}

// ───────────────────────────── the injectable effect factory ─────────────────────────────

/** The three reads `collectAndDistill` needs, injected so the runner (P-004) supplies live ones. */
export interface BeeTraceLoaders {
  /** The spawned_agents row for the bee (null if it never recorded). */
  loadSpawn(spawnId: string): Promise<BeeSpawnRow | null>;
  /** Token totals for the run from agent_usage_samples (null when none landed). */
  loadRunTokens(runId: string): Promise<BeeRunTokens | null>;
  /** The bee's transcript text (null when absent). May be async: the live
   *  loader falls through to the session archive when the per-spawn dir was
   *  already archived-then-deleted (session-db-archive-retire-dirs P-010). */
  loadTranscript(spawnId: string): string | null | Promise<string | null>;
}

/**
 * Build the `BeekeeperDeps.collectAndDistill` effect from injected loaders. The `InstanceRunHandle`'s
 * `instanceId` IS the bee's spawn id (D-002). A missing spawn row degrades to an `errored`-shaped
 * trace + a non-success status rather than throwing, so one lost bee never aborts the battery.
 */
export function makeBeeCollectAndDistill(loaders: BeeTraceLoaders) {
  return async (input: {
    handle: InstanceRunHandle;
    case: CorpusCase;
    maxChars: number;
  }): Promise<CollectAndDistillResult> => {
    const spawnId = input.handle.instanceId;
    const spawn = await loaders.loadSpawn(spawnId);
    if (!spawn) {
      return {
        distilledTrace: `## Terminal state\nmissing\n\nNo spawn row recorded for ${spawnId}.`,
        traceRef: `bee:${spawnId}`,
        rawSignals: { spawnId, terminalStatus: 'missing' },
        signals: { workItemStatus: 'missing', workItemAttempts: 1 },
      };
    }
    const runTokens = spawn.runId ? await loaders.loadRunTokens(spawn.runId) : null;
    const transcriptText = await loaders.loadTranscript(spawnId);
    return collectAndDistillFromBee({ spawnId, spawn, transcriptText, runTokens, maxChars: input.maxChars });
  };
}
