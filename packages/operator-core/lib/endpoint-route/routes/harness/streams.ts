/**
 * SSE streams for the harness UI:
 *
 *   GET /api/harness/:slug/agents/:runId/stream   — live "thinking" timeline for one agent run
 *   GET /api/harness/:slug/stream                 — text log + feature-diff heartbeats
 *   GET /api/harness/:slug/log/stream             — structured JSONL log stream
 *
 * Relocated from `_hono/harness.ts` (endpoint-hono-elimination-2026-05-21
 * A4 batch 38). All three share the `activeStreams` registry from
 * `lib/harness-active-streams.ts` (carved out in b36) and use the
 * `@papercusp/sse` `sseResponse` helper.
 */
import { join } from 'node:path';
import { statSync, readFileSync, openSync, readSync, closeSync } from 'node:fs';
import { open as openFileAsync } from 'node:fs/promises';
import { sseResponse } from '@papercusp/sse';
import { managedSetInterval, type ManagedHandle } from '@papercusp/scheduled-registry';
import { resolvePhasedProject, harnessDir, parseFeatures, tailFile } from '../../../harness-core';
import { phasePhaseLabel } from '../../../harness-phases';
import {
  activeStreams,
  HARNESS_STREAM_TOTAL_CAP,
  type StreamToken,
} from '../../../harness-active-streams';
import { defineTool } from '@papercusp/tooldef';
// TYPE-ONLY: session-transcript-remat lazily imports the session-archive module,
// which fails LOUD at import when zstd is unavailable — it must stay off this
// module's load path (see the WI-6581 note at the remat call site).
import type { TranscriptStreamKey } from '../../../session-transcript-remat';
import {
  TRANSCRIPT_RENDER_TEXT_CAP,
  TRUNCATION_MARKER_POSIX_RE,
  capWithMarker,
} from '../../../transcript-text-caps';
import type { AgentTimelineEntry } from '../../../cross-boundary-event-contracts';

function remoteIpFrom(req: Request): string {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0].trim() ??
    req.headers.get('x-real-ip') ??
    req.headers.get('cf-connecting-ip') ??
    'unknown'
  );
}

export type { AgentTimelineEntry } from '../../../cross-boundary-event-contracts';

/** Per-entry text cap for UI-bound thinking entries. A single tool_result can
 *  carry a whole file (hundreds of KB); the pane renders it in a ~120px scroll
 *  box, so ship a bounded excerpt — this also keeps the one-shot `backfill`
 *  lean over the desktop IPC hop. Pure — exported for tests.
 *
 *  This is the RENDER budget, and it is now THE canonical cap: the ingest
 *  store derives its prose cap from it (see ../../../transcript-text-caps), so
 *  raising it here widens what gets stored rather than leaving the store 4x
 *  tighter than the pane, which is the drift this alias exists to prevent. */
export const THINKING_ENTRY_TEXT_CAP = TRANSCRIPT_RENDER_TEXT_CAP;
export function capEntryText(e: AgentTimelineEntry): AgentTimelineEntry {
  if (typeof e.text !== 'string') return e;
  const capped = capWithMarker(e.text, THINKING_ENTRY_TEXT_CAP);
  return capped === e.text ? e : { ...e, text: capped };
}

/**
 * Split a byte snapshot of an append-only JSONL file at record boundaries.
 *
 * The writer can be in the middle of appending the final record when the
 * reader stats and reads the file.  Parsing that trailing fragment is safe
 * only as a best-effort display operation; advancing the follow cursor past
 * it is not safe because the parser drops the fragment and the next poll
 * would start after the completed record.  Keep the fragment out of the
 * parsed prefix and return the absolute cursor just after the last newline.
 *
 * When a bounded tail starts in the middle of a record, discard that first
 * partial record from the parsed prefix just as the caller did previously.
 * The cursor still uses the absolute byte offset, so a later follow begins
 * at the exact boundary represented by the snapshot.
 * Pure — exported for regression tests.
 */
export function splitCompleteJsonlSnapshot(
  snapshot: Uint8Array,
  startOffset = 0,
): {
  complete: Buffer;
  trailing: Buffer;
  cursor: number;
  snapshotEnd: number;
} {
  const bytes = Buffer.from(snapshot);
  const snapshotEnd = startOffset + bytes.length;
  const lastNewline = bytes.lastIndexOf(0x0a);
  if (lastNewline < 0) {
    return {
      complete: Buffer.alloc(0),
      trailing: bytes,
      cursor: startOffset,
      snapshotEnd,
    };
  }

  const firstNewline = startOffset > 0 ? bytes.indexOf(0x0a) : -1;
  const completeStart = firstNewline >= 0 ? firstNewline + 1 : 0;
  const completeEnd = lastNewline + 1;
  return {
    complete: bytes.subarray(completeStart, completeEnd),
    trailing: bytes.subarray(completeEnd),
    cursor: startOffset + completeEnd,
    snapshotEnd,
  };
}

/**
 * The harness Run-view stream crosses the desktop IPC boundary as individual
 * SSE frames. Keep raw-log frames small enough that a large tail or a burst of
 * log-bus lines cannot make the webview/parser retain one enormous message.
 * These are DATA limits; SSE framing adds only a small fixed header.
 */
export const HARNESS_STREAM_LOG_CHUNK_BYTES = 64 * 1024;
export const HARNESS_STREAM_LOG_BATCH_LINES = 100;
export const HARNESS_STREAM_LOG_BATCH_BYTES = 64 * 1024;

/**
 * The old Run-view only reads these feature fields. `parseFeatures` also
 * returns notes, metadata, provenance, and other detail columns that can be
 * very large; sending those on every 3-second heartbeat made one `features`
 * event reach tens of megabytes. Keep the event name and list shape stable,
 * while retaining the fields the view actually renders/filters.
 */
export const HARNESS_STREAM_FEATURE_TEXT_CAP = 1_000;
export const HARNESS_STREAM_FEATURE_CLAIMS_CAP = 32;
export const HARNESS_STREAM_FEATURE_TAGS_CAP = 32;
export const HARNESS_STREAM_FEATURE_PAYLOAD_CAP_BYTES = 4 * 1024 * 1024;

const STREAM_TEXT_ENCODER = new TextEncoder();

function utf8ByteLength(value: string): number {
  return STREAM_TEXT_ENCODER.encode(value).byteLength;
}

/**
 * Split text on Unicode scalar boundaries so each returned string's encoded
 * bytes stay within `maxBytes`. A UTF-8 scalar is at most four bytes, so the
 * effective minimum is four even if a caller passes a smaller limit.
 * Pure — exported for regression tests.
 */
export function splitUtf8Chunks(
  value: string,
  maxBytes = HARNESS_STREAM_LOG_CHUNK_BYTES,
): string[] {
  if (!value) return [];
  const limit = Math.max(4, Math.floor(maxBytes));
  const chunks: string[] = [];
  let start = 0;
  let used = 0;

  for (let index = 0; index < value.length;) {
    const codePoint = value.codePointAt(index)!;
    const width = codePoint > 0xffff ? 2 : 1;
    const charBytes = utf8ByteLength(value.slice(index, index + width));
    if (used > 0 && used + charBytes > limit) {
      chunks.push(value.slice(start, index));
      start = index;
      used = 0;
    }
    used += charBytes;
    index += width;
  }
  if (start < value.length) chunks.push(value.slice(start));
  return chunks;
}

/**
 * Join raw log lines into bounded SSE payloads. A line that is itself larger
 * than the limit is split safely by `splitUtf8Chunks`; normal lines remain
 * newline-delimited so the existing Run-view consumer can append them.
 * Pure — exported for regression tests.
 */
export function batchRawLogLines(
  lines: Iterable<string>,
  maxBytes = HARNESS_STREAM_LOG_BATCH_BYTES,
  maxLines = HARNESS_STREAM_LOG_BATCH_LINES,
): string[] {
  const byteLimit = Math.max(4, Math.floor(maxBytes));
  const lineLimit = Math.max(1, Math.floor(maxLines));
  const batches: string[] = [];
  let current = '';
  let currentBytes = 0;
  let currentLines = 0;
  const flush = () => {
    if (!current) return;
    batches.push(current);
    current = '';
    currentBytes = 0;
    currentLines = 0;
  };

  for (const rawLine of lines) {
    const line = rawLine.endsWith('\n') ? rawLine : `${rawLine}\n`;
    for (const part of splitUtf8Chunks(line, byteLimit)) {
      const partBytes = utf8ByteLength(part);
      if (current && (currentLines >= lineLimit || currentBytes + partBytes > byteLimit)) {
        flush();
      }
      current += part;
      currentBytes += partBytes;
      currentLines += 1;
      if (currentBytes >= byteLimit || currentLines >= lineLimit) flush();
    }
  }
  flush();
  return batches;
}

function capStreamFeatureText(value: unknown): unknown {
  if (typeof value !== 'string' || value.length <= HARNESS_STREAM_FEATURE_TEXT_CAP) return value;
  return `${value.slice(0, HARNESS_STREAM_FEATURE_TEXT_CAP)}…`;
}

/**
 * Project one parsed feature to the legacy Run-view contract without carrying
 * heavy detail columns across the SSE/IPC boundary. Pure — exported for tests.
 */
export function slimFeatureForStream(feature: any): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: feature?.id,
    title: capStreamFeatureText(feature?.title),
    status: feature?.status,
    attempts: feature?.attempts,
  };
  if (feature?.summary != null) out.summary = capStreamFeatureText(feature.summary);
  if (Array.isArray(feature?.claims)) {
    out.claims = feature.claims
      .slice(0, HARNESS_STREAM_FEATURE_CLAIMS_CAP)
      .map((claim: unknown) => capStreamFeatureText(claim));
  }
  if (feature?.project_id != null) out.project_id = capStreamFeatureText(feature.project_id);
  if (Array.isArray(feature?.tags)) {
    out.tags = feature.tags
      .slice(0, HARNESS_STREAM_FEATURE_TAGS_CAP)
      .map((tag: unknown) => capStreamFeatureText(tag));
  }
  return out;
}

export function slimFeaturesForStream(features: readonly any[]): Record<string, unknown>[] {
  return features.map(slimFeatureForStream);
}

export type HarnessStreamFeatureState = [unknown, unknown, unknown];

/** The compact state tuple used when even the legacy feature projection is too large. */
export function featureStateForStream(features: readonly any[]): HarnessStreamFeatureState[] {
  return features.map((feature) => [feature?.id, feature?.status, feature?.attempts]);
}

/**
 * Preserve the legacy feature-object payload for ordinary harnesses, but
 * degrade a pathological feature corpus to the compact state tuples already
 * used by the stream's change detector. This keeps the `features` event name
 * and array contract while preventing detail text from crossing IPC in bulk.
 */
export function featuresForStreamEvent(
  features: readonly any[],
): Record<string, unknown>[] | HarnessStreamFeatureState[] {
  const slim = slimFeaturesForStream(features);
  return utf8ByteLength(JSON.stringify(slim)) <= HARNESS_STREAM_FEATURE_PAYLOAD_CAP_BYTES
    ? slim
    : featureStateForStream(features);
}

export function createAgentTimelineParser() {
  let pendingText = '';
  let pendingThinking = '';
  // The timestamp of the FIRST delta of the current pending span, so a flushed
  // text/thinking entry reports when the agent STARTED saying it (not flush time).
  let pendingTextTs: string | undefined;
  let pendingThinkingTs: string | undefined;
  const flushText = (out: AgentTimelineEntry[]) => {
    if (pendingText) { out.push({ kind: 'text', text: pendingText, ts: pendingTextTs }); pendingText = ''; pendingTextTs = undefined; }
  };
  const flushThinking = (out: AgentTimelineEntry[]) => {
    if (pendingThinking) {
      out.push({ kind: 'status', text: `[thinking] ${pendingThinking}`, ts: pendingThinkingTs });
      pendingThinking = '';
      pendingThinkingTs = undefined;
    }
  };
  return {
    parseLine(raw: string): AgentTimelineEntry[] {
      const out: AgentTimelineEntry[] = [];
      let obj: any;
      try { obj = JSON.parse(raw); } catch { return out; }
      const type = obj.type;
      // Source-record ISO timestamp, when present — stamped onto every entry this
      // line emits (drives the per-entry header time in the thinking pane).
      const ts: string | undefined = typeof obj.timestamp === 'string' ? obj.timestamp : undefined;

      if (type === 'stream_event' && obj.event?.type === 'content_block_delta') {
        const delta = obj.event?.delta;
        if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
          if (!pendingText) pendingTextTs = ts;
          pendingText += delta.text;
        }
      } else if (type === 'assistant' && obj.message?.content) {
        flushText(out);
        for (const block of obj.message.content) {
          if (block.type === 'text') out.push({ kind: 'text', text: block.text, ts });
          else if (block.type === 'tool_use') out.push({ kind: 'tool_use', toolName: block.name, toolInput: block.input, toolId: block.id, ts });
        }
      } else if (type === 'user' && obj.message?.content != null) {
        const content = obj.message.content;
        if (typeof content === 'string') {
          // A real user/wake message (plain text) → a turn boundary.
          const t = content.trim();
          if (t) out.push({ kind: 'prompt', text: t.slice(0, 2000), ts });
        } else if (Array.isArray(content)) {
          const promptTexts: string[] = [];
          let hadToolResult = false;
          for (const block of content) {
            if (block.type === 'tool_result') {
              hadToolResult = true;
              const contentStr = typeof block.content === 'string'
                ? block.content
                : Array.isArray(block.content)
                  ? block.content.map((p: any) => p.text ?? '').join('')
                  : '';
              out.push({ kind: 'tool_result', toolId: block.tool_use_id, text: contentStr, ts });
            } else if (block.type === 'text' && typeof block.text === 'string') {
              promptTexts.push(block.text);
            }
          }
          // Text-only user record (no tool_result) = a wake/prompt → turn boundary.
          if (!hadToolResult && promptTexts.length > 0) {
            out.push({ kind: 'prompt', text: promptTexts.join('\n').slice(0, 2000), ts });
          }
        }
      } else if (type === 'result') {
        flushText(out);
        out.push({
          kind: 'result',
          text: obj.result ?? '',
          costUsd: obj.total_cost_usd,
          inputTokens: obj.usage?.input_tokens,
          outputTokens: obj.usage?.output_tokens,
          durationMs: obj.duration_ms,
          ts,
        });
      } else if (type === 'system' && obj.subtype === 'status') {
        out.push({ kind: 'status', text: obj.status, ts });
      }
      // ── omp (oh-my-pi) format ────────────────────────────────
      else if (type === 'message_update' && obj.assistantMessageEvent) {
        const ev = obj.assistantMessageEvent;
        if (ev.type === 'text_delta' && typeof ev.delta === 'string') {
          flushThinking(out);
          if (!pendingText) pendingTextTs = ts;
          pendingText += ev.delta;
        } else if (ev.type === 'thinking_delta' && typeof ev.delta === 'string') {
          if (!pendingThinking) pendingThinkingTs = ts;
          pendingThinking += ev.delta;
        } else if (ev.type === 'thinking_end') {
          flushThinking(out);
        }
      } else if (type === 'tool_execution_start') {
        flushText(out);
        flushThinking(out);
        out.push({
          kind: 'tool_use',
          toolName: obj.toolName ?? 'tool',
          toolInput: obj.args,
          toolId: obj.toolCallId,
          ts,
        });
      } else if (type === 'tool_execution_end') {
        const result = obj.result;
        const text = typeof result === 'string'
          ? result
          : Array.isArray(result)
            ? result.map((p: any) => (typeof p === 'string' ? p : (p?.text ?? JSON.stringify(p)))).join('')
            : result != null
              ? JSON.stringify(result)
              : '';
        out.push({ kind: 'tool_result', toolId: obj.toolCallId, text, ts });
      } else if (type === 'turn_end' && obj.message?.content) {
        flushText(out);
        flushThinking(out);
        const lastText: string[] = [];
        for (const block of obj.message.content) {
          if (block.type === 'text' && typeof block.text === 'string') {
            lastText.push(block.text);
          }
        }
        if (lastText.length > 0) {
          out.push({ kind: 'result', text: lastText.join('\n').slice(0, 500), ts });
        }
      } else if (type === 'message_end') {
        flushText(out);
        flushThinking(out);
      }
      return out;
    },
    flush(): AgentTimelineEntry[] {
      const out: AgentTimelineEntry[] = [];
      flushText(out);
      flushThinking(out);
      return out;
    },
  };
}

export function parseAgentTimelineChunks(chunks: Iterable<string>): { entries: AgentTimelineEntry[]; done: boolean } {
  const parser = createAgentTimelineParser();
  const entries: AgentTimelineEntry[] = [];
  let lineBuf = '';
  let done = false;
  for (const chunk of chunks) {
    lineBuf += chunk;
    let nl: number;
    while ((nl = lineBuf.indexOf('\n')) !== -1) {
      const line = lineBuf.slice(0, nl).trim();
      lineBuf = lineBuf.slice(nl + 1);
      if (!line) continue;
      for (const e of parser.parseLine(line)) {
        entries.push(e);
        if (e.kind === 'result') done = true;
      }
    }
  }
  const tail = lineBuf.trim();
  if (tail) {
    for (const e of parser.parseLine(tail)) {
      entries.push(e);
      if (e.kind === 'result') done = true;
    }
  }
  for (const e of parser.flush()) {
    entries.push(e);
    if (e.kind === 'result') done = true;
  }
  return { entries, done };
}

async function readRunChunkBackfill(harnessSlug: string, runId: string): Promise<{ chunks: string[]; lastSeq: number } | null> {
  try {
    const { sql } = (await import('@papercusp/db-org')).getOrgPg();
    const rows = await sql<{ seq: number; chunk_data: string }[]>`
      SELECT seq, chunk_data
        FROM (
          SELECT seq, chunk_data
            FROM harness_shared.harness_run_chunks
           WHERE harness_slug = ${harnessSlug}
             AND run_id = ${runId}
           ORDER BY seq DESC
           LIMIT 500
        ) AS recent
       ORDER BY seq ASC
    `;
    return rows.length > 0
      ? { chunks: rows.map((r) => r.chunk_data), lastSeq: rows[rows.length - 1].seq }
      : null;
  } catch {
    return null;
  }
}

/**
 * SSE: live stream of one agent run's "thinking" — text deltas, tool
 * uses, tool results, and the terminal `result` event.
 *
 * Powers the hover popover on Now-running agent pills. On connect,
 * backfills the parsed timeline so the popover paints immediately,
 * then appends new events from the run-chunk bus. Closes when the
 * agent emits its `result` event or the client disconnects.
 */
const agentRunStream = defineTool({
  method: 'GET',
  path: '/harness/:slug/agents/:runId/stream',
  // SECURITY (auth: 'loopback', WI-1388): reads a harness run's "thinking" timeline
  // (tool inputs/RESULTS, which can hold file contents + secrets) by raw caller-supplied
  // slug/runId with NO workspace/ownership scoping — unauthenticated data exposure on a
  // network-exposed bind. The only consumer is the loopback desktop webview via a relative
  // /api URL (AgentThinkingPopover); the mobile path has its own device-JWT endpoint
  // (/device/harnesses/:slug/log/stream) and does not touch this one. Gate loopback-only:
  // non-loopback → 403 (enforced under ENDPOINT_AUTH_TIERS / fail-closed if the flag layer
  // is down; PAPERCUSP_ALLOW_REMOTE_ADMIN=1 is the deliberate remote opt-out). A per-principal
  // + workspace-scoped check is the follow-up for a genuine multi-tenant/exposed deployment.
  auth: 'loopback',
  sampleRate: 0,
  async handler(req, ctx) {
    const url = new URL(req.url);
    const project = await resolvePhasedProject(
      ctx.params.slug as string,
      phasePhaseLabel(url.searchParams.get('phase') ?? undefined),
    );
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const runId = (ctx.params.runId as string).replace(/[^A-Za-z0-9_.-]/g, '');
    const logDir = join(harnessDir(project), 'logs');
    const jsonlPath = join(logDir, `${runId}.jsonl`);

    const remoteIP = remoteIpFrom(req);
    const streamKey = `agent|${remoteIP}|${project.slug}|${runId}`;
    if (!activeStreams.has(streamKey) && activeStreams.size >= HARNESS_STREAM_TOTAL_CAP) {
      return Response.json(
        { error: 'too many active streams', cap: HARNESS_STREAM_TOTAL_CAP },
        { status: 503 },
      );
    }
    const previous = activeStreams.get(streamKey);
    if (previous) previous.abort();

    const parser = createAgentTimelineParser();

    return sseResponse({
      signal: req.signal,
      heartbeatMs: SESSION_STREAM_HEARTBEAT_MS,
      setup: async (sink) => {
        const token: StreamToken = {
          abort: () => { sink.close(); },
          createdAt: Date.now(),
          remoteIP,
          slug: project.slug,
        };
        activeStreams.set(streamKey, token);
        sink.onClose(() => {
          if (activeStreams.get(streamKey) === token) activeStreams.delete(streamKey);
        });

        let lineBuf = '';
        let done = false;

        const emitChunk = (chunk: string) => {
          lineBuf += chunk;
          let nl: number;
          while ((nl = lineBuf.indexOf('\n')) !== -1) {
            const line = lineBuf.slice(0, nl).trim();
            lineBuf = lineBuf.slice(nl + 1);
            if (!line) continue;
            const entries = parser.parseLine(line);
            for (const e of entries) {
              sink.event('event', e);
              if (e.kind === 'result') {
                done = true;
                sink.event('done', {});
                sink.close();
                return;
              }
            }
          }
        };

        let backfillRaw: string | null = null;
        let backfillChunks: string[] | null = null;
        let backfillChunkLastSeq = -1;
        try {
          const { sql } = (await import('@papercusp/db-org')).getOrgPg();
          const rows = await sql<{ jsonl_body: string }[]>`
            SELECT jsonl_body FROM harness_shared.harness_run_output
             WHERE harness_slug = ${project.slug} AND run_id = ${runId}
             LIMIT 1
          `;
          if (rows.length > 0 && rows[0].jsonl_body) {
            backfillRaw = rows[0].jsonl_body;
          }
        } catch { /* fall through to disk */ }
        if (backfillRaw === null) {
          const chunkBackfill = await readRunChunkBackfill(project.slug, runId);
          if (chunkBackfill) {
            backfillChunks = chunkBackfill.chunks;
            backfillChunkLastSeq = chunkBackfill.lastSeq;
          }
        }
        if (backfillRaw === null) {
          try {
            const stat = statSync(jsonlPath);
            if (stat.size > 0) {
              backfillRaw = readFileSync(jsonlPath, 'utf8');
            }
          } catch { /* no file yet either */ }
        }

        if (backfillChunks && backfillChunks.length > 0) {
          const parsed = parseAgentTimelineChunks(backfillChunks);
          done = parsed.done;
          const capped = parsed.entries.length > 200 ? parsed.entries.slice(-200) : parsed.entries;
          sink.event('backfill', capped);
          if (done) { sink.event('done', {}); sink.close(); return; }
        } else if (backfillRaw && backfillRaw.length > 0) {
          const backfill: AgentTimelineEntry[] = [];
          for (const rawLine of backfillRaw.split('\n')) {
            const line = rawLine.trim();
            if (!line) continue;
            for (const e of parser.parseLine(line)) {
              backfill.push(e);
              if (e.kind === 'result') done = true;
            }
          }
          backfill.push(...parser.flush());
          const capped = backfill.length > 200 ? backfill.slice(-200) : backfill;
          sink.event('backfill', capped);
          if (done) { sink.event('done', {}); sink.close(); return; }
        } else {
          sink.event('backfill', []);
        }

        const { subscribe: busSubscribe } = await import('../../../run-chunk-bus');
        const channelKey = `${project.slug}:${runId}`;
        const busSub = busSubscribe(channelKey, (env) => {
          if (sink.closed) return;
          if (env.seq <= backfillChunkLastSeq) return;
          emitChunk(env.data);
        });
        for (const env of busSub.recent) {
          if (env.seq <= backfillChunkLastSeq) continue;
          emitChunk(env.data);
          if (sink.closed) break;
        }
        void busSub.whenDone.then(() => {
          if (!done && !sink.closed) {
            done = true;
            sink.event('done', {});
            sink.close();
          }
        });
        sink.onClose(() => busSub.unsubscribe());
      },
    });
  },
});

/**
 * SSE: tail run.log + push feature-diff heartbeats. Legacy text-log
 * stream consumed by the harness Run-view.
 */
const slugStream = defineTool({
  method: 'GET',
  path: '/harness/:slug/stream',
  // SECURITY (auth: 'loopback', WI-1388): tails a harness run.log (can hold tool
  // outputs + secrets) by raw caller-supplied slug with NO ownership scoping. The only
  // consumer is the loopback desktop webview via a relative /api URL (the Run-view);
  // the mobile path uses its own device-JWT endpoint. Gate loopback-only (non-loopback
  // → 403; PAPERCUSP_ALLOW_REMOTE_ADMIN=1 is the deliberate remote opt-out).
  auth: 'loopback',
  sampleRate: 0,
  async handler(req, ctx) {
    const url = new URL(req.url);
    const project = await resolvePhasedProject(
      ctx.params.slug as string,
      phasePhaseLabel(url.searchParams.get('phase') ?? undefined),
    );
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const runLogPath = join(harnessDir(project), 'logs', 'run.log');

    const remoteIP = remoteIpFrom(req);
    const streamKey = `${remoteIP}|${project.slug}`;

    if (!activeStreams.has(streamKey) && activeStreams.size >= HARNESS_STREAM_TOTAL_CAP) {
      return Response.json(
        { error: 'too many active streams', cap: HARNESS_STREAM_TOTAL_CAP },
        { status: 503 },
      );
    }
    const previous = activeStreams.get(streamKey);
    if (previous) previous.abort();

    return sseResponse({
      signal: req.signal,
      heartbeatMs: SESSION_STREAM_HEARTBEAT_MS,
      setup: async (sink) => {
        const token: StreamToken = {
          abort: () => { sink.close(); },
          createdAt: Date.now(),
          remoteIP,
          slug: project.slug,
        };
        activeStreams.set(streamKey, token);
        sink.onClose(() => {
          if (activeStreams.get(streamKey) === token) activeStreams.delete(streamKey);
        });

        let lastFeatureState = '';

        const emitLogText = (text: string) => {
          for (const chunk of splitUtf8Chunks(text, HARNESS_STREAM_LOG_CHUNK_BYTES)) {
            if (sink.closed) return;
            sink.eventRaw('log', chunk);
          }
        };
        const emitLogLines = (lines: Iterable<string>) => {
          for (const batch of batchRawLogLines(
            lines,
            HARNESS_STREAM_LOG_BATCH_BYTES,
            HARNESS_STREAM_LOG_BATCH_LINES,
          )) {
            if (sink.closed) return;
            sink.eventRaw('log', batch);
          }
        };

        try {
          const chunk = tailFile(runLogPath, 256 * 1024);
          if (chunk) emitLogText(chunk);
        } catch { /* no log file yet */ }

        let liveLineBatch: string[] = [];
        let liveLineBatchBytes = 0;
        let liveFlushTimer: ReturnType<typeof setTimeout> | null = null;
        const flushLiveLines = () => {
          if (liveFlushTimer) {
            clearTimeout(liveFlushTimer);
            liveFlushTimer = null;
          }
          if (liveLineBatch.length === 0) return;
          const lines = liveLineBatch;
          liveLineBatch = [];
          liveLineBatchBytes = 0;
          emitLogLines(lines);
        };
        const queueLiveLine = (line: string) => {
          if (sink.closed) return;
          const text = line.endsWith('\n') ? line : `${line}\n`;
          liveLineBatch.push(text);
          liveLineBatchBytes += utf8ByteLength(text);
          if (
            liveLineBatch.length >= HARNESS_STREAM_LOG_BATCH_LINES ||
            liveLineBatchBytes >= HARNESS_STREAM_LOG_BATCH_BYTES
          ) {
            flushLiveLines();
          } else if (!liveFlushTimer) {
            // Coalesce a short burst without adding meaningful latency to the
            // Run-view. Thresholds above remain the hard memory/frame bounds.
            liveFlushTimer = setTimeout(flushLiveLines, 25);
          }
        };

        const { subscribe: logSubscribe } = await import('../../../harness-log-bus');
        const sub = logSubscribe(`${project.slug}:raw`, (env) => {
          queueLiveLine(env.line);
        });
        emitLogLines(sub.recent.map((env) => env.line));
        sink.onClose(() => {
          flushLiveLines();
          sub.unsubscribe();
        });

        const pushFeatures = async () => {
          if (sink.closed) return;
          // This legacy stream only publishes the Run-view projection below;
          // do not materialize notes/metadata/provenance for every 3s poll.
          const feats = await parseFeatures(project, { projection: 'stream' });
          const streamFeatures = featuresForStreamEvent(feats);
          const state = JSON.stringify(featureStateForStream(feats));
          if (state !== lastFeatureState) {
            lastFeatureState = state;
            sink.event('features', streamFeatures);
          }
        };
        while (!sink.closed) {
          await pushFeatures();
          if (sink.closed) break;
          await new Promise((r) => setTimeout(r, 3000));
        }
      },
    });
  },
});

/**
 * SSE: structured JSONL log stream. Tails run.log.jsonl (no polling),
 * emits one SSE event per JSON line. On connect, backfills the last
 * `tail` events.
 */
const logStream = defineTool({
  method: 'GET',
  path: '/harness/:slug/log/stream',
  // SECURITY (auth: 'loopback', WI-1388): tails a harness run.log.jsonl (structured
  // log; can hold tool outputs + secrets) by raw caller-supplied slug with NO ownership
  // scoping. The only consumer is the loopback desktop webview via a relative /api URL
  // (RealLogsPanel); the mobile path has its OWN device-JWT /device/harnesses/:slug/log/stream
  // (which re-implements the tail, not a proxy to this one). Gate loopback-only (non-loopback
  // → 403; PAPERCUSP_ALLOW_REMOTE_ADMIN=1 is the deliberate remote opt-out).
  auth: 'loopback',
  sampleRate: 0,
  async handler(req, ctx) {
    const url = new URL(req.url);
    const project = await resolvePhasedProject(
      ctx.params.slug as string,
      phasePhaseLabel(url.searchParams.get('phase') ?? undefined),
    );
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const jsonlPath = join(harnessDir(project), 'logs', 'run.log.jsonl');
    const tailSize = Math.min(
      Math.max(parseInt(url.searchParams.get('tail') ?? '500', 10) || 500, 1),
      5000,
    );

    const remoteIP = remoteIpFrom(req);
    const streamKey = `jsonl|${remoteIP}|${project.slug}`;
    if (!activeStreams.has(streamKey) && activeStreams.size >= HARNESS_STREAM_TOTAL_CAP) {
      return Response.json(
        { error: 'too many active streams', cap: HARNESS_STREAM_TOTAL_CAP },
        { status: 503 },
      );
    }
    const previous = activeStreams.get(streamKey);
    if (previous) previous.abort();

    return sseResponse({
      signal: req.signal,
      heartbeatMs: SESSION_STREAM_HEARTBEAT_MS,
      setup: async (sink) => {
        const token: StreamToken = {
          abort: () => { sink.close(); },
          createdAt: Date.now(),
          remoteIP,
          slug: project.slug,
        };
        activeStreams.set(streamKey, token);
        sink.onClose(() => {
          if (activeStreams.get(streamKey) === token) activeStreams.delete(streamKey);
        });

        try {
          const stat = statSync(jsonlPath);
          const tailBytes = 1024 * 1024;
          const start = Math.max(0, stat.size - tailBytes);
          const len = stat.size - start;
          const buf = Buffer.alloc(len);
          const fd = openSync(jsonlPath, 'r');
          try { readSync(fd, buf, 0, len, start); }
          finally { closeSync(fd); }
          let chunk = buf.toString('utf8');
          if (start > 0) {
            const firstNl = chunk.indexOf('\n');
            if (firstNl >= 0) chunk = chunk.slice(firstNl + 1);
          }
          const allLines = chunk.split('\n').filter(Boolean);
          const toReplay = allLines.slice(-tailSize);
          let count = 0;
          for (const raw of toReplay) {
            if (sink.closed) break;
            try { JSON.parse(raw); }
            catch { continue; }
            sink.eventRaw('log', raw);
            count++;
          }
          sink.eventRaw('backfill-done', String(count));
        } catch {
          sink.eventRaw('backfill-done', '0');
        }

        const { subscribe: logSubscribe } = await import('../../../harness-log-bus');
        const sub = logSubscribe(`${project.slug}:log`, (env) => {
          if (sink.closed) return;
          try { JSON.parse(env.line); }
          catch { return; }
          sink.eventRaw('log', env.line);
        });
        for (const env of sub.recent) {
          if (sink.closed) break;
          try { JSON.parse(env.line); }
          catch { continue; }
          sink.eventRaw('log', env.line);
        }
        sink.onClose(() => sub.unsubscribe());
      },
    });
  },
});

/**
 * Reconstruct a thinking-pane backfill from the DURABLE session_turns corpus —
 * the exact Postgres corpus /adv session-search matches on — for an ENDED
 * session whose transcript jsonl AND archive are both gone (WI-4194). Without
 * this, clicking a search hit into a pruned-transcript session (archives retain
 * only ~1.5 days; the jsonl is deleted ~15s after death) dead-clicks to
 * "0 turns · Run ended without producing any output", even though the full
 * transcript is still in session_turns. Because search MATCHED on this corpus, a
 * hit is guaranteed to have rows here.
 *
 * Maps each stored turn to an AgentTimelineEntry: a user/human turn becomes a
 * `prompt` (the frontend's turn boundary) so the pane still groups into turns;
 * everything else becomes `text`. Windows to the last `cap` turns, or — when a
 * search deep-link supplied anchorTs — centers the window on the nearest turn by
 * timestamp and returns its in-window index for the client to scroll to.
 *
 * Two queries keep the payload bounded: a cheap turn_idx+ts positional scan to
 * pick the window/anchor without pulling text, then a windowed fetch that caps
 * each row's text in SQL. Returns null when the corpus has no rows (caller falls
 * back to the honest empty-backfill terminate). Exported for tests.
 */
/** A stored session_turns speaker → the timeline entry kind. A user/human turn
 *  is the frontend's turn boundary (`prompt`); everything else is `text`. Pure —
 *  exported for tests. */
export function sessionTurnEntryKind(speaker: string | null | undefined): 'prompt' | 'text' {
  return speaker === 'user' || speaker === 'human' ? 'prompt' : 'text';
}

/** Pick the [start, start+cap) slice of an ordered turn list to backfill, and —
 *  when a search deep-link supplied anchorTs — the position of the turn nearest
 *  that timestamp (so the window centers on it). Without an anchor, tails the
 *  last `cap` turns. `tsList` is the ts of each turn in turn order. Returns the
 *  window start and the absolute anchor position (or null). Pure — exported for
 *  tests. */
export function pickSessionTurnWindow(
  tsList: ReadonlyArray<string | null>,
  cap: number,
  anchorTs?: string | null,
): { start: number; anchorPos: number | null } {
  const n = tsList.length;
  const c = Math.max(1, cap);
  let start = Math.max(0, n - c);
  let anchorPos: number | null = null;
  if (anchorTs) {
    const at = Date.parse(anchorTs);
    if (!Number.isNaN(at)) {
      let bestI = -1;
      let bestD = Infinity;
      for (let i = 0; i < n; i++) {
        const raw = tsList[i];
        const t = raw ? Date.parse(raw) : NaN;
        if (!Number.isNaN(t)) {
          const d = Math.abs(t - at);
          if (d < bestD) { bestD = d; bestI = i; }
        }
      }
      if (bestI >= 0) {
        start = Math.max(0, Math.min(bestI - Math.floor(c / 2), Math.max(0, n - c)));
        anchorPos = bestI;
      }
    }
  }
  return { start, anchorPos };
}

/** P-001: session_turn_parts.part_kind → the timeline entry kind the pane
 *  renders. `thinking` becomes a `status` entry carrying the same
 *  `[thinking] …` prefix the JSONL parsers emit, so the pane's existing
 *  styling applies unchanged. Pure — exported for tests. */
export function sessionPartEntryKind(
  partKind: string | null | undefined,
  speaker: string | null | undefined,
): AgentTimelineEntry['kind'] {
  switch (partKind) {
    case 'tool_use': return 'tool_use';
    case 'tool_result': return 'tool_result';
    case 'thinking': return 'status';
    default: return sessionTurnEntryKind(speaker);
  }
}

/**
 * P-001/P-008: the FAITHFUL backfill — session_turn_parts, which carries the
 * tool_use / tool_result / thinking blocks session_turns discards by design.
 * Returns null when this session has no parts (outside the 14 d parts window,
 * or a source kind with no parts adapter), so the caller falls through to the
 * text-turns backfill below.
 *
 * Bounded by the same two-query shape as the turns backfill, and for the same
 * reason (P-009): the positional scan must never pull a row per part of a
 * long session just to pick a 200-row window.
 */
export async function backfillFromSessionParts(
  key: { sourceKind: 'claude' | 'omp' | 'codex'; sessionId: string },
  opts: { anchorTs?: string | null; cap?: number } = {},
): Promise<Backfill | null> {
  const cap = Math.max(1, opts.cap ?? 200);
  const { getOrgPg } = await import('@papercusp/db-org');
  const { sql } = getOrgPg();
  const scanLimit = positionalScanLimit(cap, !!opts.anchorTs);
  const idxRows = await sql<Array<{ part_idx: number; ts: string | null }>>`
    SELECT part_idx, ts::text AS ts FROM (
      SELECT part_idx, ts
        FROM harness_shared.session_turn_parts
       WHERE source_kind = ${key.sourceKind} AND session_id = ${key.sessionId}
       ORDER BY part_idx DESC
       LIMIT ${scanLimit}
    ) recent
    ORDER BY part_idx ASC
  `;
  if (idxRows.length === 0) return null;
  const { start, anchorPos } = pickSessionTurnWindow(idxRows.map((r) => r.ts), cap, opts.anchorTs);
  const end = Math.min(idxRows.length, start + cap);
  const startIdx = idxRows[start].part_idx;
  const textCap = THINKING_ENTRY_TEXT_CAP + 200;
  // `store_truncated` asks a question the projected `text` column CANNOT answer:
  // was this row already short when it was STORED? It is evaluated against the
  // full stored value (never the `left(...)` projection) and requires BOTH the
  // ingest marker AND a length below the render budget — a row at/above the
  // budget is one the pane would clip anyway, so re-reading the file would buy
  // the reader nothing and is not worth abandoning the DB path for.
  const rows = await sql<Array<{
    ts: string | null; speaker: string | null; part_kind: string | null;
    tool_name: string | null; text: string | null; store_truncated: boolean | null;
  }>>`
    SELECT ts::text AS ts, speaker, part_kind, tool_name, left(text, ${textCap}) AS text,
           (text ~ ${TRUNCATION_MARKER_POSIX_RE} AND length(text) < ${TRANSCRIPT_RENDER_TEXT_CAP})
             AS store_truncated
      FROM harness_shared.session_turn_parts
     WHERE source_kind = ${key.sourceKind} AND session_id = ${key.sessionId}
       AND part_idx >= ${startIdx}
     ORDER BY part_idx ASC
     LIMIT ${cap}
  `;
  const storeTruncated = rows.some((r) => r.store_truncated === true);
  // Shape each entry EXACTLY as the JSONL timeline parsers do, so a DB-served
  // pane is indistinguishable from a file-served one: a tool_use carries
  // toolName + toolInput (never prose), a tool_result carries text, and a
  // thinking block is a `status` entry with the `[thinking]` marker the pane
  // already styles.
  const entries: AgentTimelineEntry[] = rows.map((r) => {
    const kind = sessionPartEntryKind(r.part_kind, r.speaker);
    const body = r.text ?? '';
    const ts = r.ts ?? undefined;
    if (r.part_kind === 'tool_use') {
      return { kind, toolName: r.tool_name ?? undefined, toolInput: body || undefined, ts };
    }
    if (r.part_kind === 'thinking') return capEntryText({ kind, text: `[thinking] ${body}`, ts });
    return capEntryText({ kind, text: body, ts });
  });
  const anchorIndex = anchorPos !== null && anchorPos >= start && anchorPos < end ? anchorPos - start : null;
  return { entries, anchorIndex, storeTruncated };
}

/**
 * P-009: how many of the session's TRAILING rows the positional scan needs.
 *
 * The old query was `ORDER BY turn_idx ASC` with NO LIMIT — a row per turn of
 * the whole session, pulled only to choose a 200-row window. That was
 * tolerable while this path was a rare archive fallback; P-008 makes it the
 * hot path for every history pane, so it is bounded here BEFORE the flip.
 *
 * Without an anchor we only ever tail the last `cap` rows, so `cap` suffices.
 * With an anchor (a search deep-link) the match can sit anywhere in the
 * session, so we widen to a fixed ceiling: far enough back to find nearly
 * every anchor, still O(1) in session length. An anchor older than the
 * ceiling degrades to the tail window plus `anchor {found:false}` — the same
 * honest fallback the file path already emits on a miss, never a dead pane.
 *
 * Pure — exported for tests.
 */
export const POSITIONAL_SCAN_CEILING = 20_000;
export function positionalScanLimit(cap: number, anchored: boolean): number {
  return anchored ? POSITIONAL_SCAN_CEILING : Math.max(1, cap);
}

type Backfill = {
  entries: AgentTimelineEntry[];
  anchorIndex: number | null;
  /** At least one entry came from a row the INGEST had already shortened below
   *  what this pane can render — so the DB copy is lossy in a way the source
   *  file is not. Only the parts backfill can set it; turns carry no marker. */
  storeTruncated?: boolean;
};

/**
 * Choose between the FAITHFUL parts backfill and the text-turns backfill.
 *
 * Fidelity is not the only axis — REACH matters too, and during the cutover
 * they point opposite ways. Parts only accrue from the byte offset the ingest
 * had reached when P-001 shipped, so a session that was already running has a
 * full turns history and only a short parts tail. Measured live on the first
 * real sweep: one session had 13 parts against 85 turns. Preferring parts
 * unconditionally would have QUIETLY SHORTENED that pane's history from 85
 * entries to 13 — a fidelity upgrade that reads to the user as data loss.
 *
 * So: take parts when they reach at least as far back as the turns window
 * would (or when the parts window is already full, in which case nothing
 * reaches further within `cap`), and fall back to turns otherwise. The
 * condition self-heals — once a session has accumulated a full window of
 * parts, parts always win — so this is a cutover rule, not a permanent
 * two-store read.
 *
 * Pure — exported for tests.
 */
export function preferHigherFidelityBackfill(
  parts: Backfill | null,
  turns: Backfill | null,
  cap = 200,
): Backfill | null {
  if (!parts || parts.entries.length === 0) return turns;
  if (!turns || turns.entries.length === 0) return parts;
  if (parts.entries.length >= cap) return parts;
  const oldest = (b: Backfill): number => {
    for (const e of b.entries) {
      const t = e.ts ? Date.parse(e.ts) : NaN;
      if (!Number.isNaN(t)) return t;
    }
    return Infinity; // no usable timestamps ⇒ cannot claim to reach further back
  };
  return oldest(parts) <= oldest(turns) ? parts : turns;
}

/**
 * Should the DB backfill be SERVED, or should we decline and let the caller
 * read the session file?
 *
 * Two guards, both of which only bite when the file is actually available —
 * with no file the DB is the only story and anything beats a dead pane:
 *
 *  1. STORE choice (P-008). session_turns is TEXT-ONLY while the JSONL has the
 *     tool calls, so serving turns over an existing file is a downgrade on the
 *     very axis the DB-primary work existed to improve. The first cut of P-008
 *     shipped exactly that and called it "DB-primary". Fidelity order with a
 *     file present is parts > FILE > turns.
 *
 *  2. STORE INTEGRITY (EI-20637908167729753). Guard 1 asks which store won;
 *     this asks whether the winner is intact. Ingest caps tool payloads below
 *     the render budget, so a parts row can be the highest-fidelity store
 *     available and STILL be short of what the pane had room to show — while
 *     the file on disk has all of it. Serving the DB copy there renders a body
 *     that is quietly truncated with no way for the reader to tell, which is
 *     the failure mode that made a 7,051-char report display as 2,000.
 *
 * Pure — exported for tests.
 */
export function shouldServeDbBackfill(
  backfill: Backfill | null,
  opts: { fileAvailable: boolean; fromParts: Backfill | null; ownerWide?: boolean },
): backfill is Backfill {
  if (!backfill || backfill.entries.length === 0) return false;
  // A single native transcript file can never replace the owner's predecessor
  // epochs. Even a text-only or store-truncated owner window is the only
  // complete identity-scoped view available, so serve it when requested.
  if (opts.ownerWide) return true;
  if (!opts.fileAvailable) return true;
  if (backfill !== opts.fromParts) return false;
  return !backfill.storeTruncated;
}

export async function backfillFromSessionTurns(
  key: { sourceKind: 'claude' | 'omp' | 'codex'; sessionId: string },
  opts: { anchorTs?: string | null; cap?: number } = {},
): Promise<{ entries: AgentTimelineEntry[]; anchorIndex: number | null } | null> {
  const cap = Math.max(1, opts.cap ?? 200);
  const { getOrgPg } = await import('@papercusp/db-org');
  const { sql } = getOrgPg();
  // 1) Positional scan — turn_idx + ts only, ordered — to bound the window (and
  //    match anchorTs) without pulling every turn's text. P-009: bounded to the
  //    trailing slice the window can actually reach (see positionalScanLimit);
  //    the DESC+LIMIT subquery walks the PK backwards and stops, where the old
  //    unbounded ASC scan read the whole session.
  const scanLimit = positionalScanLimit(cap, !!opts.anchorTs);
  const idxRows = await sql<Array<{ turn_idx: number; ts: string | null }>>`
    SELECT turn_idx, ts::text AS ts FROM (
      SELECT turn_idx, ts
        FROM harness_shared.session_turns
       WHERE source_kind = ${key.sourceKind} AND session_id = ${key.sessionId}
       ORDER BY turn_idx DESC
       LIMIT ${scanLimit}
    ) recent
    ORDER BY turn_idx ASC
  `;
  if (idxRows.length === 0) return null;
  const { start, anchorPos } = pickSessionTurnWindow(idxRows.map((r) => r.ts), cap, opts.anchorTs);
  const end = Math.min(idxRows.length, start + cap);
  const startIdx = idxRows[start].turn_idx;
  // 2) Windowed fetch — text capped in SQL (+ a margin so capEntryText still
  //    stamps its "[truncated]" marker on a genuinely long turn).
  const textCap = THINKING_ENTRY_TEXT_CAP + 200;
  const rows = await sql<Array<{ turn_idx: number; ts: string | null; speaker: string | null; text: string | null }>>`
    SELECT turn_idx, ts::text AS ts, speaker, left(text, ${textCap}) AS text
      FROM harness_shared.session_turns
     WHERE source_kind = ${key.sourceKind} AND session_id = ${key.sessionId}
       AND turn_idx >= ${startIdx}
     ORDER BY turn_idx ASC
     LIMIT ${cap}
  `;
  const entries: AgentTimelineEntry[] = rows.map((r) =>
    capEntryText({
      kind: sessionTurnEntryKind(r.speaker),
      text: r.text ?? '',
      ts: r.ts ?? undefined,
    }),
  );
  const anchorIndex = anchorPos !== null && anchorPos >= start && anchorPos < end ? anchorPos - start : null;
  return { entries, anchorIndex };
}

/**
 * The ordinary HUD conversation is an OWNER conversation, not one native
 * transcript file. A carry-respawn keeps the coord owner id and creates a new
 * native session id, so session-keyed backfill necessarily drops every
 * predecessor epoch.
 *
 * Select from session_turns deliberately. It is the user/assistant
 * CONVERSATION store and retains 45 days; session_turn_parts retains 14 days
 * and includes every tool/thinking part. A busy current epoch can fill all 200
 * part slots by itself (measured live while implementing this fix), recreating
 * the exact missing-predecessor symptom despite an owner predicate. Text turns
 * preserve the bounded popup contract while letting prior conversation epochs
 * survive current-epoch tool volume. The live follower remains tied to the
 * resolved current transcript file below, so tool activity still appears as it
 * is appended now.
 */
export async function backfillFromOwnerSessionTurns(
  owner: string,
  opts: { cap?: number; cursor?: OwnerHistoryCursor | null } = {},
): Promise<OwnerHistoryPage | null> {
  const cap = Math.max(1, opts.cap ?? 200);
  const cursor = opts.cursor ?? null;
  const { getOrgPg } = await import('@papercusp/db-org');
  const { sql } = getOrgPg();
  const textCap = THINKING_ENTRY_TEXT_CAP + 200;
  // Bind cursor timestamps as text before PostgreSQL parses them. A directly
  // inferred timestamptz parameter uses postgres.js's Date serializer, which
  // drops retained microseconds and skips rows at the page boundary.
  const rows = await sql<Array<{
    event_at: string; source_kind: string; session_id: string; turn_idx: number;
    speaker: string | null; text: string | null;
  }>>`
    SELECT to_json(event_at) #>> '{}' AS event_at,
           source_kind, session_id, turn_idx, speaker, left(text, ${textCap}) AS text
      FROM (
        SELECT COALESCE(ts, ingested_at) AS event_at,
               speaker, text, source_kind, session_id, turn_idx
          FROM harness_shared.session_turns
         WHERE owner = ${owner}
           AND (
             ${cursor?.at ?? null}::text::timestamptz IS NULL
             OR (COALESCE(ts, ingested_at), source_kind, session_id, turn_idx)
                < (${cursor?.at ?? null}::text::timestamptz,
                   ${cursor?.sourceKind ?? null}::text,
                   ${cursor?.sessionId ?? null}::text,
                   ${cursor?.turnIdx ?? null}::int)
           )
         ORDER BY event_at DESC,
                  source_kind DESC, session_id DESC, turn_idx DESC
         LIMIT ${cap + 1}
      ) recent
     ORDER BY event_at ASC,
              source_kind ASC, session_id ASC, turn_idx ASC
  `;
  if (rows.length === 0) return null;
  // The query returns the newest cap+1 rows in chronological order. The first
  // row is the one-row look-behind used only to prove another page exists;
  // drop it so adjacent pages neither overlap nor exceed the public page cap.
  const hasMore = rows.length > cap;
  const selected = hasMore ? rows.slice(1) : rows;
  const first = selected[0];
  return {
    entries: selected.map((r) => capEntryText({
      kind: sessionTurnEntryKind(r.speaker),
      text: r.text ?? '',
      ts: r.event_at,
    })),
    anchorIndex: null,
    hasMore,
    cursor: hasMore && first
      ? encodeOwnerHistoryCursor({
          at: first.event_at,
          sourceKind: first.source_kind,
          sessionId: first.session_id,
          turnIdx: first.turn_idx,
        })
      : null,
  };
}

export interface OwnerHistoryCursor {
  at: string;
  sourceKind: string;
  sessionId: string;
  turnIdx: number;
}

export interface OwnerHistoryPage extends Backfill {
  hasMore: boolean;
  cursor: string | null;
}

/** Opaque cursor for the complete deterministic owner-history ordering tuple. */
export function encodeOwnerHistoryCursor(cursor: OwnerHistoryCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

/** Fail-closed decoder for a caller-supplied owner-history cursor. */
export function decodeOwnerHistoryCursor(raw: string): OwnerHistoryCursor | null {
  if (!raw || raw.length > 800) return null;
  try {
    const value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<OwnerHistoryCursor>;
    if (
      typeof value.at !== 'string'
      || Number.isNaN(Date.parse(value.at))
      || typeof value.sourceKind !== 'string'
      || value.sourceKind.length === 0
      || typeof value.sessionId !== 'string'
      || value.sessionId.length === 0
      || !Number.isInteger(value.turnIdx)
      || value.turnIdx! < 0
    ) return null;
    return value as OwnerHistoryCursor;
  } catch {
    return null;
  }
}

/**
 * GET /api/adv/session/thinking — a LIVE-FOLLOWED view of an INTERACTIVE
 * (non-bee) session's thinking timeline, for the agents-roster inspector.
 * Keyed by exactly one of:
 *   ?sessionId=<uuid>[&owner=<coord-owner>] — a CLAUDE session's transcript jsonl
 *   ?codexSessionKey=<adv-row-id>           — a CODEX session's rollout jsonl
 *   ?ompThreadId=<uuid>                     — an OMP session's jsonl
 * Unlike a spawned bee (whose harness run-log the /agents/:runId/stream reads),
 * an interactive session keeps its timeline in a per-backend jsonl; we resolve
 * that file, parse the tail with the backend's timeline parser, emit it as one
 * `backfill`, then POLL the file for appended records — emitting each new entry
 * as `event` (the current turn streams in live) plus a `thinking` status
 * ({active}) when the agent starts/stops writing.
 * It does NOT emit `done` while the session merely goes idle (only if the transcript
 * vanishes); the client closes the stream when the pane closes. A session whose
 * transcript hasn't been WRITTEN yet (a live agent pre-first-turn) gets an empty
 * backfill and the stream KEEPS polling until the file appears — `done` there
 * would misread a live agent as "run ended". Empty backfill + `done` only when
 * no sessionId was supplied.
 *
 * SECURITY (auth: 'loopback'): an interactive session's transcript carries the
 * FULL agent reasoning + tool inputs/results (which can hold file contents +
 * secrets) and is resolved by a raw caller-supplied sessionId with NO
 * workspace/ownership scoping — a cross-session IDOR if network-reachable. The
 * sole consumer is the loopback desktop webview (AgentInspectorModal's
 * streamUrl), so gate it loopback-only: a non-loopback caller gets 403 instead
 * of an arbitrary session's transcript. (Enforced when ENDPOINT_AUTH_TIERS is
 * on / fail-closed if the flag layer is down; PAPERCUSP_ALLOW_REMOTE_ADMIN=1 is
 * the deliberate remote opt-out.) A per-principal + workspace-scoped check is
 * the follow-up for a multi-tenant/exposed deployment.
 */
/**
 * Server heartbeat cadence for the agent timeline SSE streams in this file
 * (`/adv/session/thinking` and the per-run harness streams) — the BOTTOM RUNG
 * of the staleness ladder their UI consumers render.
 *
 * An idle agent emits no transcript events, so these heartbeats are the ONLY
 * proof the stream is still alive. Three constants must stay ordered:
 *
 *   SESSION_STREAM_HEARTBEAT_MS (15s)      ── the beat
 *     × 2 <  STREAM_SILENCE_STALE_MS (35s) ── pane says "may be behind"
 *          <  DEFAULT_ZOMBIE_TIMEOUT_MS (45s) ── transport gives up
 *
 * Raise this and the panes start crying stale at healthy idle streams; lower
 * the gap to the watchdog and the "stale" rung becomes unreachable dead code
 * (which is exactly what shipped once — EI-20265888603098901). The ordering is
 * pinned by `stream-freshness.ladder.test.ts`, which reads this literal, so
 * changing it fails that test rather than silently drifting.
 *
 * Consumers: `apps/operator/app/_components/chat/SessionChatModal.tsx` and
 * `apps/operator/app/harness/AgentThinkingStream.tsx`.
 */
export const SESSION_STREAM_HEARTBEAT_MS = 15_000;

/**
 * Which SESSION the `/adv/session/thinking` query params name, as the same
 * discriminated key the archive re-resolve already speaks (WI-41496).
 *
 * Pure and exported so the per-backend routing is unit-testable — the thing it
 * decides is invisible from outside otherwise: a wrong branch produces a
 * perfectly healthy SSE stream carrying an empty transcript, which looks
 * identical to a quiet agent. Both omp defects this closes had exactly that
 * shape.
 *
 * PRECEDENCE is deliberate and matches the client builders: the most SPECIFIC
 * handle wins. A codex row legitimately carries a `sessionId` too (its rollout
 * uuid), so a sessionId-first order would send every codex session to the
 * claude resolver — the same misread that had 237 of 257 live codex rows
 * labelled "no live transcript" (WI-41497).
 */
export function sessionThinkingKey(params: {
  sessionId?: string;
  owner?: string;
  codexSessionKey?: string;
  codexRolloutId?: string;
  ompThreadId?: string;
  /** The omp session's adv-row id — names the per-session home. */
  ompSessionKey?: string;
}): TranscriptStreamKey | null {
  if (params.codexSessionKey) {
    return { kind: 'codex-session-key', sessionKey: params.codexSessionKey };
  }
  if (params.codexRolloutId) {
    return { kind: 'codex-rollout', rolloutId: params.codexRolloutId };
  }
  if (params.ompThreadId) {
    return {
      kind: 'omp',
      threadId: params.ompThreadId,
      ...(params.ompSessionKey ? { sessionKey: params.ompSessionKey } : {}),
    };
  }
  if (params.sessionId) {
    return {
      kind: 'claude',
      sessionId: params.sessionId,
      ...(params.owner ? { owner: params.owner } : {}),
    };
  }
  return null;
}

const sessionThinkingStream = defineTool({
  method: 'GET',
  path: '/adv/session/thinking',
  auth: 'loopback',
  sampleRate: 0,
  async handler(req) {
    const url = new URL(req.url);
    const sessionId = (url.searchParams.get('sessionId') ?? '').replace(/[^A-Za-z0-9_.-]/g, '');
    // The agent's coord owner id — the per-session isolation dir key. Lets
    // findSessionTranscript jump straight to `session-claude/<owner>/projects`
    // (1 readdir, plus the global root) instead of sweeping every isolation
    // root. Sanitized; absent ⇒ the full-scan fallback still resolves it.
    const owner = (url.searchParams.get('owner') ?? '').replace(/[^A-Za-z0-9_.-]/g, '') || undefined;
    // Stable owner identity for an ordinary HUD conversation's HISTORY. This
    // is deliberately distinct from `owner`, whose pre-existing job is only to
    // narrow Claude's on-disk transcript resolver. Search deep-links omit this
    // parameter and therefore keep their exact native-session anchor window.
    const historyOwner = (url.searchParams.get('historyOwner') ?? '').replace(/[^A-Za-z0-9_.-]/g, '') || undefined;
    const historyPage = url.searchParams.get('historyPage') === '1';
    const historyCursorRaw = (url.searchParams.get('historyCursor') ?? '').slice(0, 801);
    const historyCursor = historyCursorRaw ? decodeOwnerHistoryCursor(historyCursorRaw) : null;
    if (historyPage) {
      if (!historyOwner) {
        return Response.json({ ok: false, error: 'historyOwner is required for a history page' }, { status: 400 });
      }
      if (historyCursorRaw && !historyCursor) {
        return Response.json({ ok: false, error: 'invalid historyCursor' }, { status: 400 });
      }
      try {
        const page = await backfillFromOwnerSessionTurns(historyOwner, { cursor: historyCursor });
        return Response.json({
          ok: true,
          entries: page?.entries ?? [],
          hasMore: page?.hasMore ?? false,
          cursor: page?.cursor ?? null,
        });
      } catch {
        return Response.json({ ok: false, error: 'owner history unavailable' }, { status: 503 });
      }
    }
    // Non-claude backends ("every roster agent has a history"): a codex session
    // streams its rollout jsonl (CODEX_HOME keyed by the adv-session row id),
    // an omp session its ~/.omp/agent/sessions jsonl (keyed by thread id). Same
    // tail-backfill + poll-follow machinery — only resolver + parser differ.
    const codexSessionKey = (url.searchParams.get('codexSessionKey') ?? '').replace(/[^A-Za-z0-9_-]/g, '');
    const ompThreadId = (url.searchParams.get('ompThreadId') ?? '').replace(/[^A-Za-z0-9_-]/g, '');
    /**
     * WI-41496: the omp session's ADV-ROW id, which is what names its home.
     *
     * A psu-launched omp agent gets a per-session home
     * (`~/.papercusp/su-omp-homes/session-<advId>/agent/sessions`) and never
     * writes to the shared `~/.omp`; without this the route resolved against
     * the shared home only and every such session's conversation popup was
     * permanently empty — measured live against a 25 KB transcript that was
     * being appended at the time. Optional: the resolver falls back to a
     * bounded sweep of the per-session homes when it is absent, which is what
     * keeps a deep-link (thread id only) working.
     */
    const ompSessionKey = (url.searchParams.get('ompSessionKey') ?? '').replace(/[^A-Za-z0-9_-]/g, '');
    // A codex session keyed by its ROLLOUT UUID (the session-turns index key) —
    // the transcript-search deep-link for codex sessions with no adv-row key.
    const codexRolloutId = (url.searchParams.get('codexRolloutId') ?? '').replace(/[^A-Za-z0-9-]/g, '');
    // Deep-link anchor (agents-pill-inactive-search-2026-07-09 P-005): `find` =
    // the search term (a plain substring for entry matching, never a
    // path/pattern — length-capped only) and `anchorTs` = the matched turn's
    // timestamp. When `find` is present the backfill window CENTERS on the
    // matched entry instead of tailing the file, and an `anchor` event tells
    // the client which backfill index to scroll to.
    const find = (url.searchParams.get('find') ?? '').slice(0, 300);
    const anchorTsRaw = (url.searchParams.get('anchorTs') ?? '').trim();
    const anchorTs = anchorTsRaw && !Number.isNaN(Date.parse(anchorTsRaw)) ? anchorTsRaw : null;
    // ended=1 (WI-3990): the caller (InactiveSessionsSection / an inactive search
    // hit) knows this session has ENDED. That lets us distinguish "no transcript
    // on disk because the agent hasn't taken its first turn yet" (a LIVE session —
    // keep waiting) from "no transcript on disk because it was archived+deleted
    // after death" (an ENDED session — rematerialize it from the archive, or
    // terminate the stream). Without it the route polls forever and the inspector
    // shows "waiting for the first output" indefinitely instead of the history.
    const ended = url.searchParams.get('ended') === '1' || url.searchParams.get('ended') === 'true';
    return sseResponse({
      signal: req.signal,
      heartbeatMs: SESSION_STREAM_HEARTBEAT_MS,
      setup: async (sink) => {
        const { resolveInteractiveTranscript, SESSION_THINKING_ACTIVE_MS } = await import('../../../claude-sessions');
        const { findCodexRolloutPath, findCodexRolloutPathByUuid, findOmpSessionPath } = await import('../../../session-transcript-resolvers');
        const { createCodexTimelineParser, createOmpTimelineParser } = await import('../../../session-timeline-parsers');
        // ONE decision about which backend this request is for
        // (`sessionThinkingKey`, pure + unit-tested), then a resolver and a
        // parser off that single key. The two used to be independent 4-way
        // branches over the same params — which is how the omp leg came to pass
        // its per-session key to the resolver in one place and not the other.
        const key = sessionThinkingKey({ sessionId, owner, codexSessionKey, codexRolloutId, ompThreadId, ompSessionKey });
        if (!key) { sink.event('backfill', []); sink.done({}); return; }
        const source = key.kind === 'codex-session-key'
          ? { resolve: () => findCodexRolloutPath(key.sessionKey), newParser: createCodexTimelineParser }
          : key.kind === 'codex-rollout'
            ? { resolve: () => findCodexRolloutPathByUuid(key.rolloutId), newParser: createCodexTimelineParser }
            : key.kind === 'omp'
              ? {
                  resolve: () => findOmpSessionPath(key.threadId, {
                    ...(key.sessionKey != null ? { sessionKey: key.sessionKey } : {}),
                  }),
                  newParser: createOmpTimelineParser,
                }
              // P-016 fallback (WI-2680): resolve the exact recorded session_id first,
              // then — on a miss — the newest transcript under the owner root, so a
              // session that RESUMED (fresh uuid ⇒ stale recorded id) still streams its
              // CURRENT transcript instead of an empty "waiting/stalled" pane.
              : { resolve: () => resolveInteractiveTranscript(key.sessionId, { owner: key.owner }), newParser: createAgentTimelineParser };
        let path = await source.resolve();

        // WI-3990: an ENDED session whose transcript was archived + deleted after
        // death resolves to no on-disk path. Rather than fall through to the
        // "wait for a first turn" poll below (which never terminates for a
        // session that already ended), rematerialize the transcript from the
        // session archive ONCE, then re-resolve.
        //
        // WI-6581: codex used to be skipped here because its archive keying
        // differs twice over — the archive key is the ROLLOUT UUID rather than
        // the adv-row session key, and the restore lands in the session's own
        // CODEX_HOME rather than the global ~/.codex the by-uuid resolver
        // scans. Both are now bridged in `session-transcript-remat`, which owns
        // the per-backend keying (and the lazy session-archive import — that
        // module fails LOUD at import when zstd is unavailable, so it must stay
        // off this module's load path). Best-effort: every failure mode comes
        // back as a `reason` and falls through to the ended-terminate branch.
        if (!path && ended) {
          // The SAME key the resolver above was built from — `sessionThinkingKey`
          // returns exactly `TranscriptStreamKey`, so the archive re-resolve
          // cannot address a different session (or a differently-keyed one) than
          // the live stream just failed to find.
          try {
            const { rematerializeTranscript } = await import('../../../session-transcript-remat');
            const r = await rematerializeTranscript(key);
            if (r.path) path = r.path;
          } catch { /* best-effort — the ended-terminate branch below handles the miss */ }
        }

        // ── Follow state (shared by the backfill + the live-follow tick) ──
        let pos = 0;
        let lineBuf = '';
        let lastActive: boolean | null = null;
        let lastAppendMs = Date.now();
        let handle: ManagedHandle | null = null;
        let followParser = source.newParser();
        const emitThinking = (active: boolean) => {
          if (active !== lastActive) { lastActive = active; sink.event('thinking', { active }); }
        };

        // ── 1) Backfill: the last 1 MiB tail as a snapshot. Returns whether the
        //       transcript was appended recently (the initial thinking state). ──
        const backfillFrom = (p: string): boolean => {
          try {
            const stat = statSync(p);
            const tailBytes = 1024 * 1024;
            const start = Math.max(0, stat.size - tailBytes);
            const len = stat.size - start;
            const buf = Buffer.alloc(len);
            const fd = openSync(p, 'r');
            let bytesRead = 0;
            try { bytesRead = readSync(fd, buf, 0, len, start); } finally { closeSync(fd); }
            const snapshot = splitCompleteJsonlSnapshot(buf.subarray(0, bytesRead), start);
            const chunk = snapshot.complete.toString('utf8');
            const parser = source.newParser();
            const entries: AgentTimelineEntry[] = [];
            for (const rawLine of chunk.split('\n')) {
              const line = rawLine.trim();
              if (!line) continue;
              for (const e of parser.parseLine(line)) entries.push(e);
            }
            entries.push(...parser.flush());
            const capped = (entries.length > 200 ? entries.slice(-200) : entries).map(capEntryText);
            sink.event('backfill', capped);
            // Do not advance past a record whose newline was not in the
            // snapshot. The live follow will reread that record and combine
            // it with the bytes appended by the writer on a later poll.
            pos = snapshot.cursor;
            return Date.now() - stat.mtimeMs < SESSION_THINKING_ACTIVE_MS;
          } catch {
            sink.event('backfill', []);
            return false;
          }
        };

        // ── 1b) Anchored backfill (deep-link from a transcript-search hit):
        //       stream the WHOLE file through the AnchorWindowCollector and
        //       backfill a window CENTERED on the matched entry, then emit
        //       `anchor` with the in-backfill index for the client to scroll
        //       to. Memory-bounded (only the window region is retained) and —
        //       with an anchorTs — stops reading once the trailing context is
        //       collected. No match ⇒ fall back to the tail backfill and say
        //       so (`anchor {found:false}`), never a dead pane. ──
        const anchoredBackfillFrom = async (p: string): Promise<boolean> => {
          try {
            const { AnchorWindowCollector } = await import('../../../session-anchor-window');
            const { StringDecoder } = await import('node:string_decoder');
            const stat = statSync(p);
            const collector = new AnchorWindowCollector({ find, anchorTs });
            const parser = source!.newParser();
            const decoder = new StringDecoder('utf8');
            const chunk = Buffer.alloc(1024 * 1024);
            let lineRest = '';
            let offset = 0;
            let lastCompleteOffset = 0;
            // WI-6512: this loop used to use the SYNCHRONOUS fs (openSync/readSync),
            // which blocks Node's single event loop thread for the ENTIRE scan — and a
            // deep-link anchor search streams the WHOLE transcript up to (and a bit past)
            // the matched entry before it can stop (session-anchor-window.ts's docstring:
            // "without anchorTs: a full scan"; WITH anchorTs it still scans everything
            // BEFORE the anchor, which is most of the file for an anchor late in a long
            // session). Measured live transcripts up to 261MB raw — a synchronous scan of
            // that size stalls every OTHER concurrent request on the operator too, not
            // just this one, for however long the scan takes. Async fs (fs/promises)
            // performs the identical byte-for-byte scan and produces the identical
            // result, but each `await fh.read()` yields the event loop back between
            // chunks, so a slow anchor scan no longer starves unrelated traffic.
            const fh = await openFileAsync(p, 'r');
            try {
              while (offset < stat.size && !collector.done) {
                const chunkStart = offset;
                const { bytesRead: n } = await fh.read(chunk, 0, chunk.length, offset);
                if (n <= 0) break;
                offset += n;
                const rawChunk = chunk.subarray(0, n);
                lastCompleteOffset = Math.max(
                  lastCompleteOffset,
                  splitCompleteJsonlSnapshot(rawChunk, chunkStart).cursor,
                );
                lineRest += decoder.write(rawChunk);
                let nl: number;
                while ((nl = lineRest.indexOf('\n')) !== -1 && !collector.done) {
                  const line = lineRest.slice(0, nl).trim();
                  lineRest = lineRest.slice(nl + 1);
                  if (!line) continue;
                  for (const e of parser.parseLine(line)) collector.push(e);
                }
              }
              if (!collector.done) {
                // The decoder remainder is a live, incomplete record. Keep it
                // out of the parser; the follow tick will read it again from
                // lastCompleteOffset after the writer appends its newline.
                lineRest += decoder.end();
                for (const e of parser.flush()) collector.push(e);
              } else {
                // Anchored views intentionally skip the records after the
                // selected window. Preserve only an incomplete record from the
                // bytes already read so its eventual completion is not lost,
                // while keeping the cursor at the read high-water mark.
                lineRest += decoder.end();
                const lastNewline = lineRest.lastIndexOf('\n');
                lineBuf = lastNewline >= 0 ? lineRest.slice(lastNewline + 1) : lineRest;
              }
            } finally {
              await fh.close();
            }
            const res = collector.result();
            if (!res) {
              // Term not found (transcript rotated / truncated at ingest) —
              // honest fallback: normal tail backfill + a found:false anchor.
              const active = backfillFrom(p);
              sink.event('anchor', { found: false });
              return active;
            }
            sink.event('backfill', res.entries.map(capEntryText));
            sink.event('anchor', { found: true, index: res.anchorIndex });
            // Live-follow continues from EOF: entries between the window and
            // the file end are elided from the pane (it is a jumped-to view).
            pos = collector.done ? offset : lastCompleteOffset;
            return Date.now() - stat.mtimeMs < SESSION_THINKING_ACTIVE_MS;
          } catch {
            sink.event('backfill', []);
            sink.event('anchor', { found: false });
            return false;
          }
        };

        // The corpus key for this session, shared by the DB-primary backfill
        // below and the ENDED-session recovery further down. claude→sessionId,
        // omp→ompThreadId, codex→codexRolloutId (codexSessionKey is an adv-row
        // id with no corpus key, so a session keyed that way has no DB path).
        const corpusKey = sessionId
          ? ({ sourceKind: 'claude', sessionId } as const)
          : ompThreadId
            ? ({ sourceKind: 'omp', sessionId: ompThreadId } as const)
            : codexRolloutId
              ? ({ sourceKind: 'codex', sessionId: codexRolloutId } as const)
              : null;

        /**
         * P-008 (session-turn-storage-2026-07-28): serve HISTORY from Postgres.
         *
         * This inverts the old order. It used to be file-first with the DB as a
         * fallback only when the file was GONE; now the DB is the primary and
         * the file is the fallback. Two stores are tried in fidelity order:
         *   1. session_turn_parts — the faithful transcript (tool calls,
         *      results, thinking), inside the 14 d parts window;
         *   2. session_turns — text turns only, inside the 45 d window.
         * A miss on both returns false and the caller reads the file exactly as
         * before, so nothing regresses for a source with no parts adapter, a
         * session older than the windows, or a DB that is down.
         *
         * D-003: this is BACKFILL only. The live tail keeps polling the file —
         * the ingest cron is 2 min, so the DB is up to ~2 min behind the
         * current turn. `pos` is therefore seeded at the file's CURRENT size by
         * the caller, so the pane shows DB history and then live-follows
         * appended records with neither a gap nor a duplicate.
         */
        const backfillFromDb = async (opts: { fileAvailable: boolean }): Promise<boolean> => {
          if (!corpusKey && !historyOwner) return false;
          try {
            // These are bounded fallback reads, not a latency-critical primary
            // path. Keep them serial so a single pane cannot reserve two org DB
            // operations at once and both helpers observe the same initialized
            // client/module seam.
            // An owner-wide popup reads the conversation store directly. Do
            // not let current-epoch tool parts crowd predecessor epochs out of
            // the fixed-size history window (backfillFromOwnerSessionTurns).
            const fromParts = historyOwner
              ? null
              : await backfillFromSessionParts(corpusKey!, { anchorTs });
            const ownerPage = historyOwner
              ? await backfillFromOwnerSessionTurns(historyOwner)
              : null;
            const fromTurns = historyOwner
              ? ownerPage
              : await backfillFromSessionTurns(corpusKey!, { anchorTs });
            const backfill = preferHigherFidelityBackfill(fromParts, fromTurns);
            if (!shouldServeDbBackfill(backfill, {
              fileAvailable: opts.fileAvailable,
              fromParts,
              ownerWide: Boolean(historyOwner),
            })) {
              return false;
            }
            sink.event('backfill', backfill.entries);
            if (historyOwner && ownerPage) {
              sink.event('history', { hasMore: ownerPage.hasMore, cursor: ownerPage.cursor });
            }
            if (find) {
              sink.event('anchor', backfill.anchorIndex !== null
                ? { found: true, index: backfill.anchorIndex }
                : { found: false });
            }
            return true;
          } catch {
            // The DB is a convenience here, never a dependency — a failure
            // degrades to the file read, which is what shipped before P-008.
            return false;
          }
        };

        if (path) {
          const served = await backfillFromDb({ fileAvailable: true });
          if (served) {
            // Seed the follow cursor at the last complete JSONL boundary, not
            // blindly at EOF. The DB history is complete, but the live file
            // can still end in a record that is being appended right now.
            try {
              const st = statSync(path);
              const tailBytes = 1024 * 1024;
              const start = Math.max(0, st.size - tailBytes);
              const len = st.size - start;
              const buf = Buffer.alloc(len);
              const fd = openSync(path, 'r');
              let bytesRead = 0;
              try { bytesRead = readSync(fd, buf, 0, len, start); } finally { closeSync(fd); }
              pos = splitCompleteJsonlSnapshot(buf.subarray(0, bytesRead), start).cursor;
              emitThinking(Date.now() - st.mtimeMs < SESSION_THINKING_ACTIVE_MS);
            } catch {
              emitThinking(false);
            }
          } else {
            emitThinking(find ? await anchoredBackfillFrom(path) : backfillFrom(path));
          }
        } else if (ended) {
          // WI-4194: the transcript jsonl + archive are both gone, but the ENDED
          // session's turns may still live in the DURABLE session_turns corpus
          // (exactly what /adv search matched on to surface this hit). Reconstruct
          // the backfill from there so a search click renders the history instead
          // of dead-clicking to "0 turns". Keyed by uuid — see `corpusKey`
          // above. P-010: this is now the SAME parts-then-turns read the live
          // branch uses (backfillFromDb), so an ended session renders with the
          // same fidelity a live one does — where before it silently dropped to
          // text-only. Best-effort — any failure degrades to the honest
          // empty-backfill terminate below.
          // fileAvailable:false — the transcript is gone, so text-only turns
          // are the best surviving record and beat an empty pane (WI-4194).
          const recovered = await backfillFromDb({ fileAvailable: false });
          // WI-3990: no recoverable transcript anywhere (never archived, archive
          // incomplete/pruned AND no session_turns rows) — emit an empty backfill
          // and TERMINATE so the pane shows its honest "no output" / ended state
          // instead of "waiting for the first output" FOREVER (an ended session
          // never takes a first turn, so the live-follow poll would never resolve).
          if (!recovered) sink.event('backfill', []);
          sink.done({});
          return;
        } else {
          // No transcript file YET — for a LIVE session that hasn't taken its
          // first turn this is "waiting", NOT "run ended": serve any durable
          // history first, then keep the stream open. `fileAvailable:false`
          // matters here because there is no file to fall back to; the DB copy
          // is the only surviving history for a live session whose resolver
          // cannot find its transcript. If the DB has no rows either, emit the
          // honest empty snapshot (no eternal "connecting…") and let the tick
          // below re-resolve until the file appears.
          const served = await backfillFromDb({ fileAvailable: false });
          if (!served) sink.event('backfill', []);
          emitThinking(false);
        }

        // ── 2) Live-follow the CURRENT turn: poll for appended records, emit each
        //       as `event`, and a `thinking` status when the agent starts/stops
        //       writing. Unlike a bee run this never emits `done` on its own — an
        //       interactive session's transcript just goes quiet when idle; the
        //       client closes the stream when the pane closes (onClose → stop). ──
        let resolving = false;
        const tick = () => {
          if (sink.closed) { handle?.stop(); return; }
          if (!path) {
            // Still waiting on the first transcript write. Cheap for every
            // backend (a handful of readdirs, never a sweep).
            if (resolving) return;
            resolving = true;
            void source.resolve()
              .then(async (p) => {
                if (sink.closed || path || !p) return;
                path = p;
                followParser = source.newParser();
                // Deliberately FILE-first here, unlike the P-008 flip above:
                // this branch fires the moment a live session's transcript
                // first appears, and the ingest cron is 2 min behind, so the
                // DB would return null (or a stale prefix) for the very turn
                // the user is watching. History has no such freshness problem.
                emitThinking(find ? await anchoredBackfillFrom(p) : backfillFrom(p));
              })
              .finally(() => { resolving = false; });
            return;
          }
          let stat;
          try { stat = statSync(path); } catch { sink.done({}); handle?.stop(); return; }
          if (stat.size > pos) {
            const len = stat.size - pos;
            const buf = Buffer.alloc(len);
            const fd = openSync(path, 'r');
            try { readSync(fd, buf, 0, len, pos); } finally { closeSync(fd); }
            pos = stat.size;
            lineBuf += buf.toString('utf8');
            let nl: number;
            while ((nl = lineBuf.indexOf('\n')) !== -1) {
              const line = lineBuf.slice(0, nl).trim();
              lineBuf = lineBuf.slice(nl + 1);
              if (!line) continue;
              for (const e of followParser.parseLine(line)) sink.event('event', capEntryText(e));
            }
            lastAppendMs = Date.now();
            emitThinking(true);
          } else if (Date.now() - lastAppendMs >= SESSION_THINKING_ACTIVE_MS) {
            emitThinking(false);
          }
        };
        handle = managedSetInterval('adv-session-thinking-follow', 1000, tick, {
          category: 'lifecycle',
          instanced: true,
        });
        sink.onClose(() => handle?.stop());
      },
    });
  },
});

export default [agentRunStream, slugStream, logStream, sessionThinkingStream];
