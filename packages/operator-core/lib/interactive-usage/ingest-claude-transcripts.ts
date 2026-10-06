/**
 * Interactive-session usage ingester (token-usage-reduction-audit-2026-06-09 P-001).
 *
 * The 2026-06-09 audit found interactive Claude Code / psu sessions are the DOMINANT
 * token consumer (~235 MTok cache-read + ~170 MTok cache-write per week on this box)
 * yet wrote NO telemetry — `agent_usage_samples` only saw orchestrator spawns +
 * stateless anthropic-direct calls. This module tails the local Claude Code transcripts
 * (`~/.claude/projects`, recursive `*.jsonl`), sums each file's assistant-message `usage`
 * observations, and persists one sample per source request with
 * `source='interactive'`, so the spend rollups and the weekly token report see the
 * whole picture.
 *
 * Idempotency: a per-file BYTE WATERMARK (`harness_shared.interactive_usage_files`,
 * migration 210) marks the end of the last fully-parsed JSONL line; each tick reads
 * only the delta. Sample INSERT + watermark advance run in one transaction, so a
 * failed insert is retried next tick rather than silently dropped. A file smaller
 * than its watermark (recreated transcript) re-ingests from 0 — transcripts are
 * append-only, so that is the only rotation case.
 *
 * Subscription honesty: interactive sessions bill to the seat, not per-token. The
 * estimated $ (cost_source='estimated', list price) quantifies RATE-LIMIT-HEADROOM
 * consumption — the budget the fleet competes with — not real dollars.
 */
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { PRICE_TABLE_VERSION } from '@papercusp/model-pricing';
import { getOrgPg } from '@papercusp/db-org';
import { priceStoredUsageSample } from './reprice-usage-samples';
import { activeWorkspaceId } from '../workspace-registry';
import type { TranscriptAdapter } from './ingest-adapters';
import type { Sql } from 'postgres';

export interface HistoricalUsageApproval {
  filePath: string;
  byteOffset: number;
  sourceSha256: string;
  legacyFingerprint: string;
  /** Completed backup:snapshot_create receipt, revalidated for this workspace before apply. */
  backupSnapshotId: number;
}

/** Exact legacy rows, not a count-only fence. Safe to expose in a dry-run manifest. */
export async function legacyUsageFingerprint(sql: Sql, workspaceId: string, sessionId: string): Promise<string> {
  const [row] = await sql<Array<{ fingerprint: string }>>`
    SELECT md5(COALESCE(jsonb_agg(to_jsonb(s) ORDER BY id)::text, '[]')) AS fingerprint
    FROM harness_shared.agent_usage_samples s WHERE workspace_id = ${workspaceId}
      AND source = 'interactive' AND session_id = ${sessionId} AND usage_event_key IS NULL
  `;
  return row.fingerprint;
}

async function requireHistoricalBackup(sql: Sql, workspaceId: string, snapshotId: number): Promise<void> {
  if (!Number.isSafeInteger(snapshotId) || snapshotId <= 0) throw new Error('Invalid historical backup receipt');
  const backup = await sql`SELECT id FROM harness_shared.backup_snapshots
    WHERE workspace_id = ${workspaceId} AND id = ${snapshotId}
      AND status = 'ok' AND db_dump_ok = true AND kopia_snapshot_id IS NOT NULL
      AND finished_at IS NOT NULL AND started_at > now() - interval '24 hours'`;
  if (backup.length !== 1) throw new Error('Historical reconciliation requires a recent completed database backup receipt for this workspace');
}

/**
 * A missing source is NOT evidence for a replacement model or count. Preserve
 * each original row verbatim in provenance, then make the unrecoverable fields
 * NULL so every ledger consumer sees unknown rather than a plausible old guess.
 * Only a positively missing (ENOENT), unarchived single-source mapping may take this path.
 */
export async function markUnavailableTranscriptUsage(
  approval: Omit<HistoricalUsageApproval, 'sourceSha256'>,
): Promise<{ markedRows: number; alreadyMarked: boolean }> {
  const { sql } = getOrgPg();
  const ws = activeWorkspaceId();
  await requireHistoricalBackup(sql, ws, approval.backupSnapshotId);
  if (!/^[a-f0-9]{32}$/.test(approval.legacyFingerprint)) throw new Error('Invalid historical ledger fingerprint');
  const { codexSessionIdForFile } = await import('./ingest-adapters');
  const sessionId = codexSessionIdForFile(approval.filePath);
  const mappings = await sql<Array<{ file_path: string }>>`
    SELECT file_path FROM harness_shared.interactive_usage_files WHERE workspace_id = ${ws}
  `;
  if (mappings.filter(row => codexSessionIdForFile(row.file_path) === sessionId).length !== 1) {
    throw new Error('Missing-source session has an ambiguous file-to-ledger mapping');
  }
  return sql.begin(async tx => {
    await tx`SET LOCAL lock_timeout = '5s'`;
    await tx`SET LOCAL statement_timeout = '30s'`;
    await tx`LOCK TABLE harness_shared.agent_usage_samples IN SHARE ROW EXCLUSIVE MODE`;
    const [frontier] = await tx<Array<{ byte_offset: string }>>`
      SELECT byte_offset FROM harness_shared.interactive_usage_files
      WHERE workspace_id = ${ws} AND file_path = ${approval.filePath} FOR UPDATE
    `;
    if (!frontier || Number(frontier.byte_offset) !== approval.byteOffset) throw new Error('Missing-source frontier changed');
    try {
      await fs.stat(approval.filePath);
      throw new Error('Source exists; replay it instead of declaring its usage unknown');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const { readArchivedTranscriptSource } = await import('./replay-transcripts');
    if (await readArchivedTranscriptSource(approval.filePath)) {
      throw new Error('Source exists in the archive; replay it instead of declaring its usage unknown');
    }
    const [head] = await tx<Array<{ fingerprint: string; count: number; marked: number }>>`
      SELECT md5(COALESCE(jsonb_agg(to_jsonb(s) ORDER BY id)::text, '[]')) AS fingerprint,
        count(*)::int AS count,
        count(*) FILTER (WHERE usage_provenance->'historicalAvailability'->>'status' = 'source-unavailable')::int AS marked
      FROM harness_shared.agent_usage_samples s WHERE workspace_id = ${ws}
        AND source = 'interactive' AND session_id = ${sessionId} AND usage_event_key IS NULL
    `;
    if (head.count === 0 || head.count === head.marked) return { markedRows: 0, alreadyMarked: true };
    if (head.count > 2000 || head.fingerprint !== approval.legacyFingerprint) throw new Error('Missing-source ledger changed since inventory');
    const updated = await tx`
      UPDATE harness_shared.agent_usage_samples s SET
        usage_provenance = COALESCE(s.usage_provenance, '{}'::jsonb) || jsonb_build_object(
          'grain', 'unrecoverable-legacy', 'modelSource', 'unavailable',
          'historicalAvailability', jsonb_build_object('status', 'source-unavailable',
            'reason', 'ENOENT', 'sourceFile', ${approval.filePath}::text,
            'byteOffset', ${approval.byteOffset}::bigint, 'backupSnapshotId', ${approval.backupSnapshotId}::bigint,
            'originalRow', to_jsonb(s))),
        model = NULL, model_class = 'default', cost_usd = NULL, cost_source = NULL,
        input_tokens = NULL, output_tokens = NULL, cache_read_tokens = NULL, cache_creation_tokens = NULL,
        cache_creation_5m_tokens = NULL, cache_creation_1h_tokens = NULL, turn_count = NULL
      WHERE workspace_id = ${ws} AND source = 'interactive' AND session_id = ${sessionId}
        AND usage_event_key IS NULL
      RETURNING id
    `;
    return { markedRows: updated.length, alreadyMarked: false };
  });
}

export interface TranscriptDelta {
  /** Assistant turns (API calls) parsed in this delta. */
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** Arithmetic retains the known lower bound; persistence uses NULL, not measured zero. */
  cacheCreationUnreported?: boolean;
  cacheCreation5mTokens?: number;
  cacheCreation1hTokens?: number;
  cacheCreationTierUnknown?: boolean;
}

export interface ParsedChunk {
  /** Per-model accumulated usage for every fully-parsed line. */
  perModel: Map<string, TranscriptDelta>;
  /** Byte length of the consumed prefix (complete lines only) — the watermark advance. */
  consumedBytes: number;
  /** State committed together with the byte watermark; never inferred from a default model. */
  parserState?: TranscriptParserState;
  /** Full source-request observations. Persistence max-merges repeat observations. */
  events?: TranscriptUsageEvent[];
}

export interface TranscriptUsageEvent {
  model: string;
  usage: TranscriptDelta;
  /** Native request/message identity, or a byte-relative identity for id-less lines. */
  sourceId: string;
  relativeOffset: number;
  eventTime: number | null;
  /** Inclusive source input, independent of whether its cache breakdown is complete. */
  inputTotalTokens?: number | null;
  uncachedInputKnown?: boolean;
  turnId?: string;
  contextGeneration?: number;
  predecessorSessionId?: string;
  /** Unique usage observations since an observed native session header; absent for partial sources. */
  requestOrdinal?: number;
  cacheReadKnown?: boolean;
}

/**
 * Identity of one persisted usage observation (agent_usage_samples.usage_event_key).
 *
 * A provider-native message id (`message:<id>`) names ONE billed API request no matter which
 * file it is read from. A carried or resumed session's transcript is copied into each
 * successor's isolated config dir (~/.papercusp/session-claude/<owner>/), so the same request
 * is read from many files; keying it by file counted it once per copy (WI-10004637, up to 31
 * copies). It is therefore keyed by model + message id only, and a later copy max-merges into
 * the existing row as a no-op. Id-less observations (`line:`/`aggregate:`) have no identity
 * beyond their position, so they stay scoped to the file and its truncation generation.
 */
export function transcriptUsageEventKey(input: { file: string; fileGeneration: number; model: string; sourceId: string }): string {
  const identity = input.sourceId.startsWith('message:')
    ? ['provider-message', input.model, input.sourceId]
    : [input.file, input.fileGeneration, input.model, input.sourceId];
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

export function transcriptEventTime(value: unknown): number | null {
  const parsed = typeof value === 'string' ? Date.parse(value) : value;
  return typeof parsed === 'number' && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/** Max-merge one request, including streaming growth, without guessing missing TTLs. */
export function mergeTranscriptUsage(a: TranscriptDelta, b: TranscriptDelta): TranscriptDelta {
  const merged: TranscriptDelta = {
    turns: Math.max(a.turns, b.turns),
    inputTokens: Math.max(a.inputTokens, b.inputTokens),
    outputTokens: Math.max(a.outputTokens, b.outputTokens),
    cacheReadTokens: Math.max(a.cacheReadTokens, b.cacheReadTokens),
    cacheCreationTokens: Math.max(a.cacheCreationTokens, b.cacheCreationTokens),
  };
  if (a.cacheCreationUnreported && b.cacheCreationUnreported) merged.cacheCreationUnreported = true;
  const tiers = [b, a].find((u) => !u.cacheCreationTierUnknown &&
    u.cacheCreation5mTokens !== undefined && u.cacheCreation1hTokens !== undefined &&
    u.cacheCreation5mTokens + u.cacheCreation1hTokens === merged.cacheCreationTokens);
  if (tiers) {
    merged.cacheCreation5mTokens = tiers.cacheCreation5mTokens;
    merged.cacheCreation1hTokens = tiers.cacheCreation1hTokens;
  } else if (merged.cacheCreationTokens > 0 && (a.cacheCreationTierUnknown || b.cacheCreationTierUnknown ||
    a.cacheCreation5mTokens !== undefined || a.cacheCreation1hTokens !== undefined ||
    b.cacheCreation5mTokens !== undefined || b.cacheCreation1hTokens !== undefined)) {
    merged.cacheCreationTierUnknown = true;
  }
  return merged;
}

export interface TranscriptParserState {
  initialized?: boolean;
  /** Recovery cursor only; byte_offset remains the already-accounted frontier. */
  bootstrapOffset?: number;
  bootstrapSource?: 'transcript-prefix';
  fileGeneration?: number;
  model?: string;
  turnId?: string;
  lastCumulativeUsage?: string;
  predecessorSessionId?: string;
  contextGeneration?: number;
  requestOrdinal?: number;
}

const emptyDelta = (): TranscriptDelta => ({
  turns: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
});

/** Model string → bucket class (mirrors usage-sample-pg's modelClassForRun for anthropic). */
export function modelClassForModel(model: string): string {
  const m = model.toLowerCase();
  if (/opus/.test(m)) return 'opus';
  if (/sonnet/.test(m)) return 'sonnet';
  if (/haiku/.test(m)) return 'haiku';
  if (/gpt|codex|^o\d/.test(m)) return 'gpt';
  return 'default';
}

interface UsageLine {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  };
}

/**
 * Parse a transcript chunk (raw bytes read from the watermark onward, utf8-decoded).
 * Only COMPLETE lines (newline-terminated, or the final line of a chunk that ends at
 * EOF mid-write is left for the next tick) are consumed; `consumedBytes` is what the
 * watermark advances by. Unparseable lines are consumed but contribute nothing.
 *
 * Dedupe: a single API call (one `message.id`) is written as MULTIPLE assistant lines
 * (one per content block), each repeating the message's `usage` — counting every line
 * inflates ~1.3×. One message = one turn: usage is max-merged per `message.id` within
 * the chunk (max also absorbs a streaming usage that grows across the lines). An
 * id-less line counts individually. Full source observations are also returned for
 * durable max-merging across chunks/restarts in the existing usage ledger.
 */
export function parseTranscriptChunk(chunk: string): ParsedChunk {
  const perModel = new Map<string, TranscriptDelta>();
  const lastNewline = chunk.lastIndexOf('\n');
  if (lastNewline === -1) return { perModel, consumedBytes: 0 };
  const consumed = chunk.slice(0, lastNewline + 1);
  // msgId → { model, max-merged usage } for this chunk; id-less lines flushed directly.
  const byMsg = new Map<string, {
    model: string;
    u: Required<Omit<UsageLine, 'cache_creation'>> & Pick<UsageLine, 'cache_creation'>;
    relativeOffset: number;
    eventTime: number | null;
    writeReported: boolean;
  }>();
  let relativeOffset = 0;
  for (const line of consumed.split('\n')) {
    const lineOffset = relativeOffset;
    relativeOffset += Buffer.byteLength(line + '\n', 'utf8');
    if (!line.trim()) continue;
    let j: unknown;
    try {
      j = JSON.parse(line);
    } catch {
      continue; // torn/garbage line — consumed, contributes nothing
    }
    const evt = j as { type?: string; timestamp?: unknown; message?: { id?: string; model?: string; usage?: UsageLine } };
    if (evt?.type !== 'assistant') continue;
    const model = evt.message?.model;
    const u = evt.message?.usage;
    // `<synthetic>` rows are harness-injected error placeholders, not API calls.
    if (!model || model.startsWith('<') || !u) continue;
    const key = evt.message?.id ? `message:${evt.message.id}` : `line:${lineOffset}`;
    const acc = byMsg.get(key) ?? { model, relativeOffset: lineOffset, eventTime: transcriptEventTime(evt.timestamp), writeReported: false,
      u: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } as
        Required<Omit<UsageLine, 'cache_creation'>> & Pick<UsageLine, 'cache_creation'> };
    acc.u.input_tokens = Math.max(acc.u.input_tokens, u.input_tokens ?? 0);
    acc.u.output_tokens = Math.max(acc.u.output_tokens, u.output_tokens ?? 0);
    acc.u.cache_read_input_tokens = Math.max(acc.u.cache_read_input_tokens, u.cache_read_input_tokens ?? 0);
    acc.u.cache_creation_input_tokens = Math.max(acc.u.cache_creation_input_tokens, u.cache_creation_input_tokens ?? 0);
    if (typeof u.cache_creation_input_tokens === 'number' && Number.isFinite(u.cache_creation_input_tokens) && u.cache_creation_input_tokens >= 0) acc.writeReported = true;
    if (u.cache_creation && typeof u.cache_creation === 'object') {
      const old = acc.u.cache_creation;
      acc.u.cache_creation = {
        ephemeral_5m_input_tokens: u.cache_creation.ephemeral_5m_input_tokens ?? old?.ephemeral_5m_input_tokens,
        ephemeral_1h_input_tokens: u.cache_creation.ephemeral_1h_input_tokens ?? old?.ephemeral_1h_input_tokens,
      };
    }
    byMsg.set(key, acc);
  }
  const events: TranscriptUsageEvent[] = [];
  for (const [sourceId, { model, u, relativeOffset, eventTime, writeReported }] of byMsg) {
    const acc: TranscriptDelta = { turns: 1, inputTokens: u.input_tokens, outputTokens: u.output_tokens,
      cacheReadTokens: u.cache_read_input_tokens, cacheCreationTokens: u.cache_creation_input_tokens };
    if (!writeReported) acc.cacheCreationUnreported = true;
    const fiveMinute = u.cache_creation?.ephemeral_5m_input_tokens;
    const oneHour = u.cache_creation?.ephemeral_1h_input_tokens;
    if (
      typeof fiveMinute === 'number' && Number.isFinite(fiveMinute) && fiveMinute >= 0 &&
      typeof oneHour === 'number' && Number.isFinite(oneHour) && oneHour >= 0 &&
      fiveMinute + oneHour === u.cache_creation_input_tokens
    ) {
      acc.cacheCreation5mTokens = (acc.cacheCreation5mTokens ?? 0) + fiveMinute;
      acc.cacheCreation1hTokens = (acc.cacheCreation1hTokens ?? 0) + oneHour;
    } else if (u.cache_creation_input_tokens > 0) {
      acc.cacheCreationTierUnknown = true;
    }
    events.push({ sourceId, model, usage: acc, relativeOffset, eventTime });
    const total = perModel.get(model) ?? emptyDelta();
    for (const key of ['turns', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens'] as const) total[key] += acc[key];
    if (acc.cacheCreation5mTokens !== undefined) total.cacheCreation5mTokens = (total.cacheCreation5mTokens ?? 0) + acc.cacheCreation5mTokens;
    if (acc.cacheCreation1hTokens !== undefined) total.cacheCreation1hTokens = (total.cacheCreation1hTokens ?? 0) + acc.cacheCreation1hTokens;
    if (acc.cacheCreationTierUnknown) total.cacheCreationTierUnknown = true;
    if (acc.cacheCreationUnreported) total.cacheCreationUnreported = true;
    perModel.set(model, total);
  }
  return { perModel, events, consumedBytes: Buffer.byteLength(consumed, 'utf8') };
}

/** Read `[offset, min(size, offset+cap))` of a file as a utf8 string. */
export async function readFileDelta(filePath: string, offset: number, capBytes: number): Promise<string> {
  const fh = await fs.open(filePath, 'r');
  try {
    const { size } = await fh.stat();
    const len = Math.min(Math.max(0, size - offset), capBytes);
    if (len === 0) return '';
    const buf = Buffer.allocUnsafe(len);
    const { bytesRead } = await fh.read(buf, 0, len, offset);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    await fh.close();
  }
}

export interface IngestOptions {
  /** Explicit, snapshot-backed replacement of ONE previously dry-run legacy prefix. Never used by the routine. */
  historical?: HistoricalUsageApproval;
  /** Claude transcript root override. Default `~/.claude/projects`. (When
   *  `adapters` is supplied this is ignored — pass roots on the adapters.) */
  root?: string;
  /** Per-tick file cap (safety bound; the rest catch up next tick). Default 5000.
   *  Applies per adapter root. */
  maxFilesPerTick?: number;
  /** Per-file read cap per tick (memory bound). Default 32 MiB. */
  maxBytesPerFile?: number;
  /** Adapter set to ingest (P-015). Default: claude + codex + OMP
   *  (`defaultAdapters()` from ingest-adapters.ts). */
  adapters?: TranscriptAdapter[];
  /** Also sweep each per-session Claude isolation root
   *  (`~/.papercusp/session-claude/<owner>/projects`) in addition to the
   *  global `~/.claude/projects` claude adapter. Default true; only applies
   *  on the true default path (`adapters` not supplied — a caller passing
   *  its own `adapters` array, e.g. every existing test, opts out by
   *  construction). Set false to restrict to the single global root. */
  includeIsolationRoots?: boolean;
  /** Isolation base override for the isolation-root sweep — the parent dir
   *  holding one subdir per owner (default `~/.papercusp/session-claude`,
   *  same default as `claudeProjectsRoots()`). Test seam only. */
  isolationBase?: string;
  /** Codex isolation base override for the per-session `CODEX_HOME` sweep —
   *  the parent dir holding one `session-<advId>/` home per psu-launched codex
   *  session (default `~/.papercusp/su-codex-homes`, same default as
   *  `codexSessionRoots()`). Swept under the same `includeIsolationRoots`
   *  switch as the Claude isolation roots. Test seam only. */
  codexIsolationBase?: string;
}

export interface IngestResult {
  root: string;
  scannedFiles: number;
  ingestedFiles: number;
  samples: number;
  skippedUnchanged: number;
  bootstrapPending: number;
  totals: TranscriptDelta;
  errors: Array<{ file: string; error: string }>;
}

const DEFAULT_MAX_FILES = 5000;
const DEFAULT_MAX_BYTES_PER_FILE = 32 * 1024 * 1024;

/**
 * One ingest tick: walk every adapter's transcript root (P-015: claude +
 * codex + OMP by default), read each file's delta past its watermark, and
 * persist one `source='interactive'` usage sample per source request.
 * Safe to re-run (the system-actions contract). All adapters share the one
 * watermark table — file paths are absolute, so roots can't collide.
 *
 * EI-19964643447670242: `defaultAdapters()`'s claude entry only ever swept the
 * GLOBAL `~/.claude/projects` root. Every psu-launched agent (su fleet
 * members, queen/overwatch/bee, and every other psu console role) runs under
 * an ISOLATED per-owner `CLAUDE_CONFIG_DIR` and writes its transcript to
 * `~/.papercusp/session-claude/<ownerId>/projects/**` instead — a root this
 * ingester never scanned, so the ENTIRE fleet's interactive usage was
 * structurally invisible to `agent_usage_samples`: not merely "not yet
 * ingested" but never ingested at all. Two real consumers silently no-op'd on
 * this: `loop-cost-cap.ts`'s `readLoopSpendCents` (owner → adv_sessions.
 * session_id → agent_usage_samples.session_id → SUM(cost_usd)) always found 0
 * for a warm psu/loop session and the cost-cap guardrail never bound, and any
 * attempt to read a psu session's own spend via that same join came back
 * empty. Sweeping the isolation roots too (below, default on) closes the gap
 * with NO schema change — the existing session_id-keyed join already works
 * once the source rows exist. (A residual, DISTINCT bug remains for a
 * cold-loop-respawned session whose `adv_sessions.session_id` was never
 * re-anchored to its live successor transcript — filed separately.)
 */
export async function ingestInteractiveUsage(opts: IngestOptions = {}): Promise<IngestResult> {
  const maxFiles = opts.maxFilesPerTick ?? DEFAULT_MAX_FILES;
  const capBytes = opts.maxBytesPerFile ?? DEFAULT_MAX_BYTES_PER_FILE;
  const { sql } = getOrgPg();
  const ws = activeWorkspaceId();
  if (opts.historical && (opts.adapters?.length !== 1 || opts.includeIsolationRoots === true ||
    !Number.isSafeInteger(opts.historical.backupSnapshotId) || opts.historical.backupSnapshotId <= 0 ||
    !/^[a-f0-9]{64}$/.test(opts.historical.sourceSha256) || !/^[a-f0-9]{32}$/.test(opts.historical.legacyFingerprint))) {
    throw new Error('Historical reconciliation requires one explicit adapter, a verified backup receipt and dry-run fingerprints');
  }
  if (opts.historical) {
    await requireHistoricalBackup(sql, ws, opts.historical.backupSnapshotId);
  }

  // Lazy import avoids a require cycle (ingest-adapters imports this module's
  // parseTranscriptChunk for the claude adapter).
  const { defaultAdapters, providerForModel } = await import('./ingest-adapters');
  let adapters = opts.adapters ?? defaultAdapters();
  if (opts.root) {
    // Back-compat: a `root` override re-points the claude adapter (the
    // routine's `trigger_config.root` knob predates the adapter set).
    adapters = adapters.map((a) => (a.name === 'claude' ? { ...a, root: opts.root! } : a));
  }
  // Default ON only when the caller took the true default path (no `adapters`
  // supplied) — every existing test passes its own `adapters` array and so
  // opts out by construction, with zero risk of sweeping the real $HOME
  // isolation tree into a test's temp DB. `includeIsolationRoots: true`
  // explicitly overrides that opt-out (paired with `isolationBase` below) so
  // the sweep itself stays test-injectable rather than reachable only via the
  // real machine's `~/.papercusp/session-claude`.
  const wantIsolationRoots = opts.includeIsolationRoots ?? !opts.adapters;
  if (wantIsolationRoots) {
    // Distinct adapter names so the `root` back-compat remap above (which
    // matches name==='claude' only) can't collide two adapters onto the same
    // directory and double-ingest a tick.
    const { claudeProjectsRoots, defaultClaudeProjectsRoot } = await import('../claude-sessions');
    const { codexSessionRoots, parseCodexChunk, codexSessionIdForFile, advSessionIdFromCodexHome } =
      await import('./ingest-adapters');
    const globalRoot = defaultClaudeProjectsRoot();
    const isoRoots = (await claudeProjectsRoots(globalRoot, opts.isolationBase)).filter((r) => r !== globalRoot);
    // WI-2140701 (a): psu-launched codex sessions run under a per-session
    // CODEX_HOME (`~/.papercusp/su-codex-homes/session-<advId>/`) and write
    // their rollouts under `<home>/sessions/**` — EI-19964643447670242's
    // isolation-root blindness on the codex lane. The default `codex` adapter
    // only ever swept the global `~/.codex/sessions`, so every psu codex agent
    // (the codex everything-goal holder included) had ZERO usage samples and
    // its goal's spend rollup could not see the holder's own cost.
    // EI-22389989368696048: isolation must be SYMMETRIC. `codexSessionRoots()` defaults to
    // the machine's REAL per-session codex homes, so a caller that pinned `isolationBase`
    // (the documented test seam) but not `codexIsolationBase` silently swept that entire
    // corpus — 149 homes / 4,329 rollouts / 28GB on this box — into its own DB, hanging the
    // call and contaminating a test database with live agent transcripts. That broke the
    // "zero risk of sweeping the real $HOME isolation tree into a test's temp DB" guarantee
    // promised above, on the codex half only. Pinning EITHER seam now means "injected tree";
    // the real base is reached only when NEITHER is pinned, so production is unchanged.
    const codexIsoRoots =
      opts.codexIsolationBase === undefined && opts.isolationBase !== undefined
        ? []
        : await codexSessionRoots(opts.codexIsolationBase);
    adapters = [
      ...adapters,
      // WI-2144763: an isolation root is `<base>/<coord-owner-id>/projects`, so the
      // owner is the parent directory name — carry it so the INSERT can stamp
      // harness_slug without a join. Derived from `root` (not the transcript path)
      // because claudeProjectsRoots built that root from the owner dir itself.
      ...isoRoots.map((root, i) => ({
        name: `claude-iso-${i}`,
        root,
        parse: parseTranscriptChunk,
        ownerId: path.basename(path.dirname(root)),
      })),
      // WI-2144763 (migration 1120): a per-session CODEX_HOME is
      // `<base>/session-<advId>/sessions`, so the parent directory name carries
      // `adv_sessions.id` — the PRIMARY KEY — and the INSERT can stamp
      // harness_slug from it with no join, exactly as the claude isolation roots
      // do with their owner id. Without this every psu-launched codex session
      // fell through to the session route, which cannot find them: their sample
      // `session_id` is the rollout uuid, and only 10 of 63 measured unstamped
      // sessions were present in adv_sessions under it. codex-iso was ~92% of
      // the whole post-1119 attribution gap.
      ...codexIsoRoots.map((root, i) => ({
        name: `codex-iso-${i}`,
        root,
        parse: parseCodexChunk,
        replayStateFromPrefix: true,
        sessionIdForFile: codexSessionIdForFile,
        advSessionId: advSessionIdFromCodexHome(root),
      })),
    ];
  }

  const result: IngestResult = {
    root: adapters.map((a) => a.root).join(', '),
    scannedFiles: 0,
    ingestedFiles: 0,
    samples: 0,
    skippedUnchanged: 0,
    bootstrapPending: 0,
    totals: emptyDelta(),
    errors: [],
  };

  const wmRows = await sql<Array<{ file_path: string; byte_offset: string; parser_state: TranscriptParserState }>>`
    SELECT file_path, byte_offset, parser_state FROM harness_shared.interactive_usage_files
     WHERE workspace_id = ${ws}
  `;
  const watermarks = new Map(wmRows.map((r) => [r.file_path, {
    offset: Number(r.byte_offset), parserState: r.parser_state ?? {},
  }]));

  for (const adapter of adapters) {
    let entries: Array<{ parentPath?: string; path?: string; name: string; isFile(): boolean }>;
    try {
      if (opts.historical) {
        const relative = path.relative(adapter.root, opts.historical.filePath);
        if (relative.startsWith('..') || path.isAbsolute(relative) || !relative.endsWith('.jsonl')) {
          throw new Error('Historical source must be inside its explicit adapter root');
        }
        entries = [{ name: path.basename(opts.historical.filePath), parentPath: path.dirname(opts.historical.filePath), isFile: () => true }];
      } else {
      // EI-14263 / EI-579: this recursive readdir materialises EVERY entry under
      // `adapter.root` before `maxFiles` (applied at .slice() below) can bind, so the
      // allocation is O(entries-in-root), not O(maxFiles). EI-579 named that its
      // "prime suspect" for a boot-time RSS spike and split this item off to bound it.
      // MEASURED 2026-09-05 against the real machine, all 220 adapter roots:
      //   peak RSS delta +2.0 MB · 105 ms · 10,324 entries materialised / 5,368 used
      //   · largest SINGLE root 3,406 entries (roots are scanned sequentially, so that
      //   is the true peak allocation — not the sum) · ~200 bytes/entry.
      // So the O(entries) shape is real but immaterial: ~5M entries in ONE root would
      // be needed to reach 1 GB. It is also NOT on the boot path — `interactive-usage-
      // ingest` is a cron routine (`0 */10 * * * *`). A bounded early-terminating walk
      // was prototyped and rejected: it saves ~1.5 MB and CHANGES which files are
      // ingested when the cap binds (Node's recursive order is not our BFS order).
      // What actually keeps this bounded is the `/projects` (and `/sessions`) suffix in
      // claudeProjectsRoots()/codexSessionRoots(): the isolation BASE holds 4,485,503
      // entries, the fenced roots only 2,458. That fence is the load-bearing invariant
      // here — it is guarded in claude-sessions.test.ts; do not widen a root to a bare
      // owner/home dir. Per-file reads (DEFAULT_MAX_BYTES_PER_FILE, 32 MiB) dominate
      // this module's memory by ~16x, so profile there first, not here.
      entries = (await fs.readdir(adapter.root, { withFileTypes: true, recursive: true })) as never;
      }
    } catch {
      if (opts.historical) throw new Error('Historical source adapter could not be enumerated');
      continue; // no transcript root for this backend on this machine
    }
    const files = entries
      .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
      .map((e) => path.join((e.parentPath ?? e.path ?? adapter.root) as string, e.name))
      .slice(0, maxFiles);

    for (const file of files) {
      result.scannedFiles += 1;
      try {
        const { size } = await fs.stat(file).catch(async (error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT' || !opts.historical) throw error;
          const { readArchivedTranscriptSource } = await import('./replay-transcripts');
          const archived = await readArchivedTranscriptSource(file, adapter.name);
          if (!archived) throw error;
          return { size: archived.length };
        });
        const stored = watermarks.get(file) ?? { offset: 0, parserState: {} };
        let offset = stored.offset;
        if (size < offset) offset = 0; // recreated transcript — re-ingest from the top
        if (size === offset && !opts.historical) {
          result.skippedUnchanged += 1;
          continue;
        }
        let fileState: TranscriptParserState = size < stored.offset
          ? { fileGeneration: (stored.parserState.fileGeneration ?? 0) + 1 } : stored.parserState;
        if (!opts.historical && adapter.replayStateFromPrefix && offset > 0 && !fileState.initialized &&
          (fileState.bootstrapOffset !== undefined || !fileState.model)) {
          // Replay at most the normal per-file byte budget per tick, discarding
          // all historical usage. Persist progress without advancing its paid
          // frontier; never infer a legacy model from the current launcher.
          const replayOffset = fileState.bootstrapOffset ?? 0;
          const prefix = await readFileDelta(file, replayOffset, Math.min(capBytes, offset - replayOffset));
          const replay = adapter.parse(prefix, fileState);
          if (replay.consumedBytes === 0) throw new Error('Legacy parser-state replay cannot advance within maxBytesPerFile');
          fileState = { ...fileState, ...replay.parserState, bootstrapSource: 'transcript-prefix' };
          const replayEnd = replayOffset + replay.consumedBytes;
          if (replayEnd < offset) {
            fileState.bootstrapOffset = replayEnd;
            const advanced = await sql`
              UPDATE harness_shared.interactive_usage_files
                 SET parser_state = ${JSON.stringify(fileState)}::jsonb, updated_at = now()
               WHERE workspace_id = ${ws} AND file_path = ${file} AND byte_offset = ${stored.offset}
                 AND parser_state = ${JSON.stringify(stored.parserState)}::jsonb
              RETURNING file_path
            `;
            if (advanced.length) result.bootstrapPending += 1;
            continue;
          }
          delete fileState.bootstrapOffset;
        }
        fileState = { ...fileState, initialized: true };
        let parsed: ParsedChunk;
        let historicalSourceLocation: 'filesystem' | 'archive' | undefined;
        if (opts.historical) {
          const approval = opts.historical;
          if (stored.offset !== approval.byteOffset || size !== stored.offset || (fileState.fileGeneration ?? 0) !== 0) {
            throw new Error('Historical frontier changed, source has unread bytes, or file generation is ambiguous; repeat dry run');
          }
          const { replayTranscriptPrefix } = await import('./replay-transcripts');
          const replay = await replayTranscriptPrefix({ filePath: file, byteOffset: stored.offset, adapter, chunkBytes: capBytes });
          if (replay.status !== 'available' || replay.sourceSha256 !== approval.sourceSha256 || replay.events.length === 0) {
            throw new Error('Historical source unavailable, empty or changed since dry run');
          }
          historicalSourceLocation = replay.sourceLocation;
          offset = 0;
          fileState = { initialized: true };
          parsed = { perModel: new Map(), events: replay.events.map(event => ({ ...event, relativeOffset: event.byteOffset })),
            consumedBytes: replay.byteOffset, parserState: { ...replay.parserState, initialized: true } };
        } else {
          const chunk = await readFileDelta(file, offset, capBytes);
          parsed = adapter.parse(chunk, fileState);
        }
        const { perModel, consumedBytes, parserState, events } = parsed;
        const nextParserState = parserState ?? fileState;
        if (consumedBytes === 0) continue; // no complete line yet — retry next tick
        // The value every spend join keys on (= adv_sessions.session_id); codex
        // rollouts need the adapter's extractor, see TranscriptAdapter.sessionIdForFile.
        const sessionId = adapter.sessionIdForFile ? adapter.sessionIdForFile(file) : path.basename(file, '.jsonl');
        if (opts.historical && [...watermarks.keys()].filter(candidate =>
          (adapter.sessionIdForFile ? adapter.sessionIdForFile(candidate) : path.basename(candidate, '.jsonl')) === sessionId).length !== 1) {
          throw new Error('Historical session has an ambiguous file-to-ledger mapping');
        }

        const committedDeltas = await sql.begin(async (tx) => {
          if (opts.historical) {
            // Serialize the rare maintenance transaction with all legacy INSERT writers,
            // including versions which do not yet lock a watermark before INSERT.
            await tx`SET LOCAL lock_timeout = '5s'`;
            await tx`SET LOCAL statement_timeout = '30s'`;
            await tx`LOCK TABLE harness_shared.agent_usage_samples IN SHARE ROW EXCLUSIVE MODE`;
          }
          // Two ticks may scan the same old watermark. Serialize only this file
          // and compare the observed offset before writing any usage samples.
          await tx`
            INSERT INTO harness_shared.interactive_usage_files (workspace_id, file_path, byte_offset, updated_at)
            VALUES (${ws}, ${file}, 0, now())
            ON CONFLICT (workspace_id, file_path) DO NOTHING
          `;
          const [head] = await tx<Array<{ byte_offset: string; state_matches: boolean }>>`
            SELECT byte_offset, parser_state = ${JSON.stringify(stored.parserState)}::jsonb AS state_matches
              FROM harness_shared.interactive_usage_files
             WHERE workspace_id = ${ws} AND file_path = ${file} FOR UPDATE
          `;
          if (Number(head.byte_offset) !== stored.offset || !head.state_matches) return null;
          let legacyRows: unknown[] = [];
          if (opts.historical) {
            const [legacy] = await tx<Array<{ rows: unknown[] | null; fingerprint: string; count: number }>>`
              SELECT jsonb_agg(to_jsonb(s) ORDER BY id) AS rows,
                md5(COALESCE(jsonb_agg(to_jsonb(s) ORDER BY id)::text, '[]')) AS fingerprint, count(*)::int AS count
              FROM harness_shared.agent_usage_samples s WHERE workspace_id = ${ws}
                AND source = 'interactive' AND session_id = ${sessionId} AND usage_event_key IS NULL
            `;
            if (legacy.count === 0) return null; // already reconciled; never duplicate requests
            if (legacy.count > 2000 || legacy.fingerprint !== opts.historical.legacyFingerprint) {
              throw new Error('Historical ledger changed since dry run or exceeds bounded row limit');
            }
            // Ensure the source is still the selected prefix while the ledger fence is held.
            const verify = await import('./replay-transcripts').then(module => module.replayTranscriptPrefix({
              filePath: file, byteOffset: stored.offset, adapter, chunkBytes: capBytes,
            }));
            if (verify.status !== 'available' || verify.sourceSha256 !== opts.historical.sourceSha256) {
              throw new Error('Historical source changed before commit');
            }
            legacyRows = legacy.rows ?? [];
            await tx`DELETE FROM harness_shared.agent_usage_samples WHERE workspace_id = ${ws}
              AND source = 'interactive' AND session_id = ${sessionId} AND usage_event_key IS NULL`;
          }
          const deltas: TranscriptDelta[] = [];
          // Keep custom adapters compatible, but label their coarser grain explicitly.
          const observations: TranscriptUsageEvent[] = events ?? [...perModel].map(([model, usage]) => ({
            model, usage, sourceId: `aggregate:${offset}:${model}`, relativeOffset: 0, eventTime: null,
          } satisfies TranscriptUsageEvent));
          for (const [eventIndex, event] of observations.entries()) {
            const { model } = event;
            const sourceId = event.sourceId.startsWith('line:') ? `line:${offset + event.relativeOffset}` : event.sourceId;
            const eventKey = transcriptUsageEventKey({ file, fileGeneration: fileState.fileGeneration ?? 0, model, sourceId });
            const [previous] = await tx<Array<{
              input_tokens: string | null; output_tokens: string | null; cache_read_tokens: string | null;
              cache_creation_tokens: string | null; cache_creation_5m_tokens: string | null;
              cache_creation_1h_tokens: string | null; turn_count: number | null; event_ts: string | null;
            }>>`
              SELECT input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
                cache_creation_5m_tokens, cache_creation_1h_tokens, turn_count, event_ts
                FROM harness_shared.agent_usage_samples WHERE workspace_id = ${ws} AND usage_event_key = ${eventKey}
            `;
            const before: TranscriptDelta = previous ? {
              turns: previous.turn_count ?? 0, inputTokens: Number(previous.input_tokens ?? 0),
              outputTokens: Number(previous.output_tokens ?? 0), cacheReadTokens: Number(previous.cache_read_tokens ?? 0),
              cacheCreationTokens: Number(previous.cache_creation_tokens ?? 0),
              cacheCreationUnreported: previous.cache_creation_tokens === null,
              cacheCreation5mTokens: previous.cache_creation_5m_tokens === null ? undefined : Number(previous.cache_creation_5m_tokens),
              cacheCreation1hTokens: previous.cache_creation_1h_tokens === null ? undefined : Number(previous.cache_creation_1h_tokens),
              cacheCreationTierUnknown: providerForModel(model) === 'anthropic' && Number(previous.cache_creation_tokens) > 0 &&
                (previous.cache_creation_5m_tokens === null || previous.cache_creation_1h_tokens === null),
            } : emptyDelta();
            const d = previous ? mergeTranscriptUsage(before, event.usage) : event.usage;
            const inputKnown = event.uncachedInputKnown !== false || (previous != null && previous.input_tokens !== null);
            if (event.uncachedInputKnown === false && previous?.input_tokens != null) d.inputTokens = before.inputTokens;
            const change = emptyDelta();
            for (const key of ['turns', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens'] as const) change[key] = d[key] - before[key];
            if (!inputKnown) change.inputTokens = 0;
            if (!opts.historical && previous && Object.values(change).every((n) => n === 0) &&
              inputKnown === (previous.input_tokens !== null) &&
              Boolean(d.cacheCreationUnreported) === Boolean(before.cacheCreationUnreported) &&
              d.cacheCreation5mTokens === before.cacheCreation5mTokens && d.cacheCreation1hTokens === before.cacheCreation1hTokens &&
              (previous.event_ts !== null || event.eventTime === null)) continue;
            const modelClass = modelClassForModel(model);
            const provider = providerForModel(model);
            // Price the row from exactly the values stored below, through the same function the
            // repricer uses, so a stored estimate is always re-derivable (WI-10004517 / D-018).
            const stored = {
              source: 'interactive', provider, model: model === 'unknown-openai' ? null : model,
              input_tokens: inputKnown ? d.inputTokens : null, output_tokens: d.outputTokens,
              cache_read_tokens: d.cacheReadTokens,
              cache_creation_tokens: d.cacheCreationUnreported ? null : d.cacheCreationTokens,
              cache_creation_5m_tokens: d.cacheCreationTierUnknown ? null : d.cacheCreation5mTokens ?? null,
              cache_creation_1h_tokens: d.cacheCreationTierUnknown ? null : d.cacheCreation1hTokens ?? null,
              grain: events ? 'request' : 'file-model-delta',
            };
            const price = priceStoredUsageSample(stored);
            const ingestedAt = Date.now();
            const eventTime = previous?.event_ts != null ? Number(previous.event_ts) : event.eventTime;
            const provenance = { parserVersion: 2, adapter: adapter.name, sourceFile: file, fileGeneration: fileState.fileGeneration ?? 0,
              sourceId, byteOffset: offset + event.relativeOffset, grain: events ? 'request' : 'file-model-delta',
              modelSource: model === 'unknown-openai' ? 'unavailable' : 'transcript',
              parserStateSource: fileState.bootstrapSource ?? 'incremental',
              turnId: event.turnId ?? null,
              cacheWriteSource: d.cacheCreationUnreported ? 'unreported' : 'reported',
              // 'lower' = cache writes with no TTL split, priced at the 5-minute floor; always
              // written (null included) so the ON CONFLICT `||` merge cannot keep a stale bound.
              costBound: price.costBound,
              uncachedInputSource: inputKnown ? 'reported-or-reconciled' : 'unknown-decomposition',
              inputTotalTokens: event.inputTotalTokens ?? null,
              accountSource: 'unavailable', triggerSource: 'unavailable',
              predecessorSessionId: event.predecessorSessionId ?? null, contextGeneration: event.contextGeneration ?? null,
              requestOrdinal: event.requestOrdinal ?? null,
              cacheReadSource: event.cacheReadKnown === true ? 'reported' : event.cacheReadKnown === false ? 'unreported' : 'unavailable',
              ...(opts.historical ? { reconciliation: { sourceSha256: opts.historical.sourceSha256,
                sourceLocation: historicalSourceLocation,
                byteOffset: opts.historical.byteOffset, backupSnapshotId: opts.historical.backupSnapshotId,
                legacyFingerprint: opts.historical.legacyFingerprint,
                ...(eventIndex === 0 ? { originalRows: legacyRows } : {}) } } : {}) };
            // Both attribution stamps below take the CODEX_HOME-derived adv_sessions PK
            // as their strongest key. harness_slug: migration 1120 (WI-2144763).
            // goal_id: migration 1121 (WI-2145149) — the 3-arg overload, same defect,
            // because both routes of the 2-arg form join adv_sessions on session_id,
            // which a psu codex row (whose sample carries the rollout uuid there) can
            // never match. The goal ceiling is small and deliberately honest: 0 -> 3 of
            // 134 codex sessions, which is 100% of the achievable set. The other 131
            // owners have no goal recorded at all — workspace-wide only 1.55% of
            // adv_sessions resolve a goal by ANY route — so a NULL goal_id here is
            // absent goal data, NOT a resolver failure (EI-22391659152296045).
            await tx`
              INSERT INTO harness_shared.agent_usage_samples
                (workspace_id, ts, bucket_key, provider, model_class, source,
                 input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd,
                 model, cost_source, harness_slug, run_id, role, session_id, goal_id,
                 cache_creation_5m_tokens, cache_creation_1h_tokens, turn_count,
                 usage_event_key, event_ts, ingested_at, usage_provenance, price_table_version)
              VALUES (
                ${ws}, ${eventTime ?? ingestedAt}, ${`${provider}:${modelClass}`}, ${provider}, ${modelClass}, ${'interactive'},
                ${stored.input_tokens}, ${stored.output_tokens}, ${stored.cache_read_tokens}, ${stored.cache_creation_tokens},
                ${price.costUsd}, ${stored.model}, ${price.costSource},
                (SELECT harness_shared.harness_slug_for_usage_attribution(
                   ${ws}, ${adapter.ownerId ?? null}, ${sessionId}, ${adapter.advSessionId ?? null})),
                ${sessionId}, ${'interactive'}, ${sessionId},
                (SELECT harness_shared.goal_id_for_usage_session(
                   ${ws}, ${sessionId}, ${adapter.advSessionId ?? null})),
                ${stored.cache_creation_5m_tokens},
                ${stored.cache_creation_1h_tokens}, ${d.turns},
                ${eventKey}, ${eventTime}, ${ingestedAt}, ${JSON.stringify(provenance)}::jsonb, ${PRICE_TABLE_VERSION}
              )
              ON CONFLICT (workspace_id, usage_event_key) WHERE usage_event_key IS NOT NULL
              DO UPDATE SET input_tokens = EXCLUDED.input_tokens, output_tokens = EXCLUDED.output_tokens,
                cache_read_tokens = EXCLUDED.cache_read_tokens, cache_creation_tokens = EXCLUDED.cache_creation_tokens,
                cache_creation_5m_tokens = EXCLUDED.cache_creation_5m_tokens, cache_creation_1h_tokens = EXCLUDED.cache_creation_1h_tokens,
                cost_usd = EXCLUDED.cost_usd, cost_source = EXCLUDED.cost_source,
                price_table_version = EXCLUDED.price_table_version, turn_count = EXCLUDED.turn_count,
                event_ts = EXCLUDED.event_ts, ts = COALESCE(EXCLUDED.event_ts, agent_usage_samples.ts),
                ingested_at = EXCLUDED.ingested_at,
                usage_provenance = COALESCE(agent_usage_samples.usage_provenance, '{}'::jsonb) || EXCLUDED.usage_provenance
            `;
            if (d.cacheCreationUnreported) change.cacheCreationUnreported = true;
            deltas.push(change);
          }
          await tx`
            INSERT INTO harness_shared.interactive_usage_files (workspace_id, file_path, byte_offset, parser_state, updated_at)
            VALUES (${ws}, ${file}, ${offset + consumedBytes}, ${JSON.stringify(nextParserState)}::jsonb, now())
            ON CONFLICT (workspace_id, file_path)
            DO UPDATE SET byte_offset = EXCLUDED.byte_offset, parser_state = EXCLUDED.parser_state, updated_at = now()
          `;
          return deltas;
        });
        if (!committedDeltas) continue; // the winning tick owns these source bytes
        watermarks.set(file, { offset: offset + consumedBytes, parserState: nextParserState });
        for (const d of committedDeltas) {
          result.samples += 1;
          result.totals.turns += d.turns;
          result.totals.inputTokens += d.inputTokens;
          result.totals.outputTokens += d.outputTokens;
          result.totals.cacheReadTokens += d.cacheReadTokens;
          result.totals.cacheCreationTokens += d.cacheCreationTokens;
          if (d.cacheCreationUnreported) result.totals.cacheCreationUnreported = true;
        }
        result.ingestedFiles += 1;
      } catch (e) {
        result.errors.push({ file, error: e instanceof Error ? e.message : String(e) });
      }
    }
  }
  return result;
}
