/**
 * Agent-run views + cross-harness active-stream registry:
 *
 *   GET /api/harness/:slug/agents              — light list (last 200), PG-mirrors as side-effect
 *   GET /api/harness/:slug/agents/:runId       — full timeline for one run (PG body preferred, disk fallback)
 *   GET /api/harness/streams/active            — diagnostic: live SSE registry across all slugs
 *
 * Relocated from `_hono/harness.ts` (endpoint-hono-elimination-2026-05-21
 * A4 batch 37). Scan helpers live in `lib/harness-agent-runs.ts`; the
 * SSE registry is `lib/harness-active-streams.ts` (carved out in b36).
 */
import { join } from 'node:path';
import { resolvePhasedProject, harnessDir, safeRead } from '../../../harness-core';
import { phasePhaseLabel } from '../../../harness-phases';
import { scanAgentRunsCached, syncAgentRunsToPg } from '../../../harness-agent-runs';
import { activeStreams, HARNESS_STREAM_TOTAL_CAP } from '../../../harness-active-streams';
import { defineTool } from '@papercusp/agent-mcp';

export interface AgentRunResultRollup {
  text: string;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  durationMs?: number;
  unreportedFrames?: number;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Parse one Claude CLI terminal result without turning absent usage into measured zero. */
export function parseAgentRunResult(obj: Record<string, unknown>): AgentRunResultRollup {
  const usage = obj.usage && typeof obj.usage === 'object'
    ? obj.usage as Record<string, unknown>
    : undefined;
  const costUsd = finiteNumber(obj.total_cost_usd);
  const inputTokens = finiteNumber(usage?.input_tokens);
  const outputTokens = finiteNumber(usage?.output_tokens);
  const durationMs = finiteNumber(obj.duration_ms);
  const unreportedFrames = costUsd === undefined || inputTokens === undefined || outputTokens === undefined
    ? 1
    : undefined;
  return {
    text: typeof obj.result === 'string' ? obj.result : '',
    ...(costUsd !== undefined ? { costUsd } : {}),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(unreportedFrames !== undefined ? { unreportedFrames } : {}),
  };
}

const listAgents = defineTool({
  method: 'GET',
  path: '/harness/:slug/agents',
  auth: 'public',
  async handler(req, ctx) {
    const url = new URL(req.url);
    const project = await resolvePhasedProject(
      ctx.params.slug as string,
      phasePhaseLabel(url.searchParams.get('phase') ?? undefined),
    );
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const all = scanAgentRunsCached(project);
    // Fire-and-forget PG mirror — Zero subscribers see updates within one poll.
    syncAgentRunsToPg(project, all).catch((err) => {
      console.warn(`[agents] PG sync failed for ${project.slug}:`, err?.message ?? err);
    });
    const runs = all.slice(0, 200).map((r) => ({
      runId: r.runId,
      role: r.role,
      ts: r.ts,
      sizeBytes: r.sizeBytes,
      running: r.running,
      lastEventTs: r.lastEventTs,
    }));
    return Response.json({ runs });
  },
});

const getAgentRun = defineTool({
  method: 'GET',
  path: '/harness/:slug/agents/:runId',
  auth: 'public',
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

    // Prefer PG-canonical body from harness_run_output (Phase 4); fall
    // back to disk for runs predating activation or in CLI-only mode.
    let jsonlRaw: string | null = null;
    try {
      const { sql } = (await import('@papercusp/db-org')).getOrgPg();
      const rows = await sql<{ jsonl_body: string }[]>`
        SELECT jsonl_body FROM harness_shared.harness_run_output
         WHERE harness_slug = ${project.slug} AND run_id = ${runId}
         LIMIT 1
      `;
      if (rows.length > 0 && rows[0].jsonl_body) {
        jsonlRaw = rows[0].jsonl_body;
      }
    } catch { /* fall through to disk */ }
    if (jsonlRaw === null) {
      jsonlRaw = safeRead(jsonlPath);
    }

    // Parse stream-json events into a compact timeline the UI can render.
    const timeline: Array<{
      kind: 'text' | 'tool_use' | 'tool_result' | 'status' | 'result' | 'error';
      text?: string;
      toolName?: string;
      toolInput?: unknown;
      toolId?: string;
      ts?: number;
      costUsd?: number;
      inputTokens?: number;
      outputTokens?: number;
      durationMs?: number;
      unreportedFrames?: number;
    }> = [];
    let accumulatedText = '';
    let totalCostUsd = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let unreportedFrames = 0;

    if (jsonlRaw) {
      for (const rawLine of jsonlRaw.split('\n')) {
        const line = rawLine.trim();
        if (!line) continue;
        try {
          const obj = JSON.parse(line);
          const type = obj.type;

          if (type === 'stream_event' && obj.event?.type === 'content_block_delta') {
            const delta = obj.event?.delta;
            if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
              accumulatedText += delta.text;
            }
          } else if (type === 'assistant' && obj.message?.content) {
            if (accumulatedText) {
              timeline.push({ kind: 'text', text: accumulatedText });
              accumulatedText = '';
            }
            for (const block of obj.message.content) {
              if (block.type === 'text') {
                timeline.push({ kind: 'text', text: block.text });
              } else if (block.type === 'tool_use') {
                timeline.push({ kind: 'tool_use', toolName: block.name, toolInput: block.input, toolId: block.id });
              }
            }
          } else if (type === 'user' && obj.message?.content) {
            for (const block of obj.message.content) {
              if (block.type === 'tool_result') {
                const contentStr = typeof block.content === 'string'
                  ? block.content
                  : Array.isArray(block.content)
                    ? block.content.map((p: any) => p.text ?? '').join('')
                    : '';
                timeline.push({ kind: 'tool_result', toolId: block.tool_use_id, text: contentStr });
              }
            }
          } else if (type === 'result') {
            const result = parseAgentRunResult(obj as Record<string, unknown>);
            if (result.costUsd !== undefined) totalCostUsd += result.costUsd;
            if (result.inputTokens !== undefined) totalInputTokens += result.inputTokens;
            if (result.outputTokens !== undefined) totalOutputTokens += result.outputTokens;
            if (result.unreportedFrames !== undefined) unreportedFrames += result.unreportedFrames;
            timeline.push({
              kind: 'result',
              text: result.text,
              ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : {}),
              ...(result.inputTokens !== undefined ? { inputTokens: result.inputTokens } : {}),
              ...(result.outputTokens !== undefined ? { outputTokens: result.outputTokens } : {}),
              ...(result.durationMs !== undefined ? { durationMs: result.durationMs } : {}),
              ...(result.unreportedFrames !== undefined ? { unreportedFrames: result.unreportedFrames } : {}),
            });
          } else if (type === 'system' && obj.subtype === 'status') {
            timeline.push({ kind: 'status', text: obj.status });
          }
        } catch {
          // Skip malformed line
        }
      }
      if (accumulatedText) timeline.push({ kind: 'text', text: accumulatedText });
    }

    return Response.json({
      runId,
      stdout: safeRead(join(logDir, `${runId}.out`)),
      stderr: safeRead(join(logDir, `${runId}.err`)),
      jsonlBytes: jsonlRaw?.length ?? 0,
      timeline,
      totalCostUsd,
      totalInputTokens,
      totalOutputTokens,
      ...(unreportedFrames > 0 ? { unreportedFrames } : {}),
    });
  },
});

const activeStreamsList = defineTool({
  method: 'GET',
  path: '/harness/streams/active',
  auth: 'public',
  async handler() {
    const now = Date.now();
    const out = Array.from(activeStreams.entries()).map(([key, t]) => ({
      key,
      slug: t.slug,
      remoteIP: t.remoteIP,
      ageMs: now - t.createdAt,
    }));
    return Response.json({
      count: activeStreams.size,
      cap: HARNESS_STREAM_TOTAL_CAP,
      streams: out,
    });
  },
});

export default [listAgents, getAgentRun, activeStreamsList];
