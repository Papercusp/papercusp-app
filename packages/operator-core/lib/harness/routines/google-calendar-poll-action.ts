/** Durable system action for the Google Calendar sync/time-wheel (P-019). */
import { getOrgPg } from '@papercusp/db-org';
import type postgres from 'postgres';
import { syncGoogleCalendarSource, type GoogleCalendarSyncResult } from '../../external-triggers/google-calendar';
import {
  type ExternalTriggerSourceRow,
  listPollableExternalTriggerSources,
  updateExternalTriggerSourceSyncState,
} from '../../external-triggers/source-store';
import {
  isGoogleWorkspaceTerminalAuthError,
  resolveGoogleWorkspaceAccessToken,
} from '../../external-triggers/google-workspace';
import { registerSystemAction, type SystemActionCtx } from './system-actions';

export interface GoogleCalendarPollFailure {
  sourceId: string;
  status: 'degraded' | 'error';
  error: string;
}

export interface GoogleCalendarPollResult {
  sources: number;
  succeeded: number;
  failed: number;
  created: number;
  updated: number;
  upcoming: number;
  failures: GoogleCalendarPollFailure[];
}

export interface GoogleCalendarPollDeps {
  sql?: postgres.Sql;
  listSources?: typeof listPollableExternalTriggerSources;
  resolveAccessToken?: (source: ExternalTriggerSourceRow, installSlug: string) => Promise<string>;
  syncSource?: typeof syncGoogleCalendarSource;
  updateSource?: typeof updateExternalTriggerSourceSyncState;
}

async function defaultResolveAccessToken(source: ExternalTriggerSourceRow, installSlug: string): Promise<string> {
  return resolveGoogleWorkspaceAccessToken(source, installSlug);
}

function positiveLeadMinutes(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function errorText(cause: unknown): string {
  return (cause instanceof Error ? cause.message : String(cause)).slice(0, 4000);
}

/**
 * Poll every owned/credentialed gcal source independently. One broken account
 * cannot starve the remaining sources; degraded provider errors retry on the
 * next routine fire, while terminal credential errors require reconnect.
 */
export async function runGoogleCalendarPoll(
  ctx: SystemActionCtx,
  provided: GoogleCalendarPollDeps = {},
): Promise<GoogleCalendarPollResult> {
  const sql = provided.sql ?? getOrgPg().sql;
  const listSources = provided.listSources ?? listPollableExternalTriggerSources;
  const resolveAccessToken = provided.resolveAccessToken ?? defaultResolveAccessToken;
  const syncSource = provided.syncSource ?? syncGoogleCalendarSource;
  const updateSource = provided.updateSource ?? updateExternalTriggerSourceSyncState;
  const sources = await listSources(sql, ctx.workspaceId, 'gcal');
  const result: GoogleCalendarPollResult = {
    sources: sources.length,
    succeeded: 0,
    failed: 0,
    created: 0,
    updated: 0,
    upcoming: 0,
    failures: [],
  };

  for (const source of sources) {
    try {
      const accessToken = await resolveAccessToken(source, ctx.installSlug);
      const synced: GoogleCalendarSyncResult = await syncSource(sql, source, accessToken, {
        leadMinutes: positiveLeadMinutes(ctx.triggerConfig.lead_minutes),
      });
      result.succeeded += 1;
      result.created += synced.created;
      result.updated += synced.updated;
      result.upcoming += synced.upcoming;
    } catch (cause) {
      const error = errorText(cause);
      const status = isGoogleWorkspaceTerminalAuthError(error) ? 'error' : 'degraded';
      await updateSource(sql, ctx.workspaceId, source.id, {
        status,
        lastError: error,
      });
      result.failed += 1;
      result.failures.push({ sourceId: source.id, status, error });
    }
  }
  return result;
}

registerSystemAction('google-calendar-poll', async (ctx) => {
  const result = await runGoogleCalendarPoll(ctx);
  if (result.sources > 0) {
    console.log(
      `[google-calendar-poll] sources=${result.sources} succeeded=${result.succeeded} ` +
        `failed=${result.failed} created=${result.created} updated=${result.updated} ` +
        `upcoming=${result.upcoming}`,
    );
  }
});
