/**
 * `system:connector-sync` — the routine that runs the ONE host-owned connector
 * sync driver over every registered provider (generalized-integrations-google-
 * migration-cupboard-workflows-2026-10-05 P-004 / R-3). Seeded by migration
 * 1360. Per-provider poll actions are retired as each provider moves onto the
 * driver (Gmail P-008, Calendar P-009, GitHub issues P-010).
 */
import { getOrgPg } from '@papercusp/db-org';
import {
  formatConnectorSyncLog,
  formatConnectorWakeLog,
  runConnectorSync,
  runConnectorWakes,
} from '../../providers/connector-runtime';
import { runPendingParticipantBackfills } from '../../relationship-graph/participant-backfill';
import { registerSystemAction } from './system-actions';

registerSystemAction('connector-sync', async (ctx) => {
  const sql = getOrgPg().sql;
  const options = { workspaceId: ctx.workspaceId, harness: ctx.installSlug };
  // Push wake first (D-018.2): a provider's doorbell marks its sources due so
  // this same tick syncs them. A wake failure is diagnostics, never a failed pass.
  const wakes = await runConnectorWakes(sql, options);
  if (wakes.sources.length > 0) console.log(formatConnectorWakeLog(wakes));
  const result = await runConnectorSync(sql, options);
  if (result.sources.length > 0) console.log(formatConnectorSyncLog(result));
  const failed = result.sources.filter((source) => source.outcome === 'failed' || source.outcome === 'reconnect-required');
  // D-018: project participants of interactions stored before a source's person -> record grant.
  // Independent of the sync outcome above (it reads the owner's Vault, not the provider), and a
  // failure here is reported, never a failed pass.
  const backfills = await runPendingParticipantBackfills(sql, { workspaceId: ctx.workspaceId }).catch(
    (cause: unknown) => [{ sourceId: '*', outcome: 'failed' as const, documents: 0, participants: 0, error: cause instanceof Error ? cause.message : String(cause) }],
  );
  if (backfills.length > 0) console.log(`connector-sync participant backfill: ${JSON.stringify(backfills)}`);
  const backfillFailed = backfills.filter((b) => b.outcome === 'failed');
  const softErrors = [
    ...(failed.length > 0
      ? [`connector-sync: ${failed.length} source(s) failed: ${failed.map((s) => `${s.sourceId}:${s.error ?? s.outcome}`).join('; ')}`]
      : []),
    ...(backfillFailed.length > 0
      ? [`participant backfill: ${backfillFailed.length} source(s) failed: ${backfillFailed.map((b) => `${b.sourceId}:${b.error ?? 'failed'}`).join('; ')}`]
      : []),
  ];
  return {
    diagnostics: {
      providers: result.providers,
      sources: result.sources.length,
      failed: failed.length,
      admitted: result.sources.reduce((n, source) => n + source.admitted, 0),
      woken: wakes.sources.filter((source) => source.outcome === 'woken').length,
      wakeFailed: wakes.sources.filter((source) => source.outcome === 'failed').length,
      participantBackfilled: backfills.filter((b) => b.outcome === 'backfilled').length,
      participantBackfillFailed: backfillFailed.length,
    },
    ...(softErrors.length > 0 ? { softError: softErrors.join(' | ').slice(0, 1000) } : {}),
  };
});
