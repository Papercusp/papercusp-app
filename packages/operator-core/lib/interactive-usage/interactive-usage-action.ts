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
 *   - `reprice_max_batches` — per-tick cap on the stale-estimate repricer, in 5000-row
 *     batches (default 40). See `reprice-usage-samples.ts`.
 */
import { registerSystemAction, type SystemActionCtx } from '../harness/routines/system-actions';
import { getOrgPg } from '@papercusp/db-org';
import { ingestInteractiveUsage } from './ingest-claude-transcripts';
import { repriceUsageSamples } from './reprice-usage-samples';

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

  // Keep stored estimates on the running price table (WI-10004517 / agent-economy-flywheel D-018):
  // re-derive every non-provider sample stamped with another table version. Bounded per tick
  // (`reprice_max_batches` × 5000 rows); an unfinished pass resumes on the next tick. A no-op once
  // every row carries the running version.
  const repriceBatches = Number(cfg.reprice_max_batches);
  const reprice = await repriceUsageSamples(getOrgPg().sql, {
    maxBatches: Number.isFinite(repriceBatches) && repriceBatches > 0 ? repriceBatches : undefined,
  });
  if (reprice.stamped > 0 || reprice.skippedConcurrent > 0) {
    const top = Object.entries(reprice.changedByModel).sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([model, n]) => `${model}=${n}`).join(', ');
    console.log(
      `[interactive-usage] repriced ${reprice.stamped} sample(s) under price table ${reprice.version}: ` +
        `${reprice.changed} changed (${reprice.newlyPriced} newly priced, ${reprice.newlyUnpriced} newly unpriced)` +
        (top ? ` [${top}]` : '') +
        (reprice.skippedConcurrent ? `, ${reprice.skippedConcurrent} skipped (concurrent write)` : '') +
        (reprice.complete ? '' : ' — more pending, continuing next tick'),
    );
  }
});
