/**
 * `system:interactive-usage-ingest` — the cadence wrapper for the interactive
 * Claude Code transcript usage ingester (token-usage-reduction-audit-2026-06-09
 * P-001; design + idempotency model in `ingest-claude-transcripts.ts`).
 *
 * Runs as ONE durable step (the system-actions contract) — safe to re-run from the
 * top: every file delta is fenced by its byte watermark, and the sample INSERT +
 * watermark advance share a transaction.
 *
 * Config (routine `trigger_config`, all optional):
 *   - `root`      — transcript root (default `~/.claude/projects`).
 *   - `max_files` — per-tick file cap (default 5000).
 */
import { registerSystemAction, type SystemActionCtx } from '../harness/routines/system-actions';
import { ingestInteractiveUsage } from './ingest-claude-transcripts';

registerSystemAction('interactive-usage-ingest', async (ctx: SystemActionCtx) => {
  const cfg = ctx.triggerConfig ?? {};
  const maxFiles = Number(cfg.max_files);
  const result = await ingestInteractiveUsage({
    root: typeof cfg.root === 'string' && cfg.root.length > 0 ? cfg.root : undefined,
    maxFilesPerTick: Number.isFinite(maxFiles) && maxFiles > 0 ? maxFiles : undefined,
  });
  const t = result.totals;
  console.log(
    `[interactive-usage] scanned ${result.scannedFiles} transcript(s) → ` +
      `${result.ingestedFiles} ingested (${result.samples} sample(s), ${t.turns} turn(s), ` +
      `${Math.round((t.cacheReadTokens + t.cacheCreationTokens) / 1000)}k cache + ` +
      `${Math.round((t.inputTokens + t.outputTokens) / 1000)}k fresh tokens), ` +
      `${result.skippedUnchanged} unchanged` +
      (result.errors.length ? `, ${result.errors.length} error(s)` : ''),
  );
  for (const e of result.errors.slice(0, 5)) console.warn(`[interactive-usage]   ! ${e.file}: ${e.error}`);
});
