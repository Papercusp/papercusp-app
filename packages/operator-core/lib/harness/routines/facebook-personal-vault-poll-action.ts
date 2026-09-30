/** Durable system action for Facebook Personal Vault polling (P-005). */
import { getOrgPg } from '@papercusp/db-org';
import type postgres from 'postgres';
import {
  resolveFacebookPersonalVaultAccessToken,
  syncFacebookPersonalVaultSource,
  type FacebookSyncResult,
} from '../../external-triggers/facebook';
import {
  type ExternalTriggerSourceRow,
  listPollableExternalTriggerSources,
  updateExternalTriggerSourceSyncState,
} from '../../external-triggers/source-store';
import { registerSystemAction, type SystemActionCtx } from './system-actions';

export interface FacebookPersonalVaultPollFailure {
  sourceId: string;
  status: 'degraded' | 'error';
  error: string;
}

export interface FacebookPersonalVaultPollResult {
  sources: number;
  succeeded: number;
  failed: number;
  profiles: number;
  posts: number;
  photos: number;
  failures: FacebookPersonalVaultPollFailure[];
}

export interface FacebookPersonalVaultPollDeps {
  sql?: postgres.Sql;
  listSources?: typeof listPollableExternalTriggerSources;
  resolveAccessToken?: (source: ExternalTriggerSourceRow, installSlug: string) => Promise<string>;
  syncSource?: typeof syncFacebookPersonalVaultSource;
  updateSource?: typeof updateExternalTriggerSourceSyncState;
}

function errorText(cause: unknown): string {
  return (cause instanceof Error ? cause.message : String(cause)).slice(0, 4000);
}

function terminalAuthError(message: string): boolean {
  return /(?:oauth|credential_ref|access_token).*(?:invalid|expired|not_connected|not_registered|required)|still_401|graph_.*_401/i.test(
    message,
  );
}

export async function runFacebookPersonalVaultPoll(
  ctx: SystemActionCtx,
  provided: FacebookPersonalVaultPollDeps = {},
): Promise<FacebookPersonalVaultPollResult> {
  const sql = provided.sql ?? getOrgPg().sql;
  const listSources = provided.listSources ?? listPollableExternalTriggerSources;
  const resolveAccessToken = provided.resolveAccessToken ?? resolveFacebookPersonalVaultAccessToken;
  const syncSource = provided.syncSource ?? syncFacebookPersonalVaultSource;
  const updateSource = provided.updateSource ?? updateExternalTriggerSourceSyncState;
  const sources = await listSources(sql, ctx.workspaceId, 'facebook');
  const result: FacebookPersonalVaultPollResult = {
    sources: sources.length,
    succeeded: 0,
    failed: 0,
    profiles: 0,
    posts: 0,
    photos: 0,
    failures: [],
  };

  for (const source of sources) {
    try {
      const accessToken = await resolveAccessToken(source, ctx.installSlug);
      const synced: FacebookSyncResult = await syncSource(sql, source, accessToken);
      result.succeeded += 1;
      result.profiles += synced.profile;
      result.posts += synced.posts;
      result.photos += synced.photos;
    } catch (cause) {
      const error = errorText(cause);
      const status = terminalAuthError(error) ? 'error' : 'degraded';
      await updateSource(sql, ctx.workspaceId, source.id, { status, lastError: error });
      result.failed += 1;
      result.failures.push({ sourceId: source.id, status, error });
    }
  }
  return result;
}

registerSystemAction('facebook-personal-vault-poll', async (ctx) => {
  const result = await runFacebookPersonalVaultPoll(ctx);
  if (result.sources > 0) {
    console.log(
      '[facebook-personal-vault-poll] sources=' + result.sources +
        ' succeeded=' + result.succeeded + ' failed=' + result.failed +
        ' profiles=' + result.profiles + ' posts=' + result.posts +
        ' photos=' + result.photos,
    );
  }
});
