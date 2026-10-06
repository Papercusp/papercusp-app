/**
 * `system:slack-org-sync` — runs the Slack organization connector on a cadence
 * (plan enterprise-data-sources-2026-10-01 P-016, D-026; modelled on the
 * since-retired `google-gmail-poll-action.ts`, whose Gmail sync is now the `gmail`
 * provider plugin run by `system:connector-sync`).
 *
 * Each fire, for every organization Slack source (credential model
 * `customer-internal-app`, connected via `POST /admin/triggers/slack/connect-org`):
 *   1. membership sync when the source has no channel set yet or its last sync is
 *      older than `membership_interval_sec`, so each channel's permission list keeps
 *      tracking the channel's members;
 *   2. up to `max_steps` paced backfill steps, stopping early when the connector
 *      reports paused / rate-limited / complete / skipped. The connector owns the
 *      pacing (`nextAt`) and every 429 Retry-After; this action only waits out the
 *      minimum step gap between steps of one fire.
 *
 * Inert while the `papercusp-slack-org-connector` flag is off: the fire returns
 * before reading a single source, so nothing is listed, fetched or written. The flag
 * defaults ON now that the legal read of Slack's API terms (WI-10005258) is on record.
 *
 * Config (routine `trigger_config`, all optional):
 *   - `max_steps` — backfill steps per source per fire (default 5, 1..40).
 *   - `membership_interval_sec` — membership re-sync period (default 3600, 60..86400).
 */
import { getOrgPg } from '@papercusp/db-org';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import type postgres from 'postgres';
import {
  backfillSlackOrgOnce,
  SLACK_ORG_CREDENTIAL_MODEL,
  SLACK_ORG_MIN_STEP_MS,
  syncSlackOrgMembership,
  type SlackOrgDeps,
} from '../../data-sources/slack-org-connector';
import { resolveSlackSocketCredentials } from '../../external-triggers/slack';
import {
  type ExternalTriggerSourceRow,
  getExternalTriggerSource,
  listPollableExternalTriggerSources,
  updateExternalTriggerSourceSyncState,
} from '../../external-triggers/source-store';
import { registerSystemAction, type SystemActionCtx } from './system-actions';

export interface SlackOrgSyncDeps extends SlackOrgDeps {
  sql?: postgres.Sql;
  /** Bot token for a source; defaults to the stored Socket Mode credentials. */
  resolveBotToken?: (source: ExternalTriggerSourceRow, installSlug: string) => Promise<string>;
  sleep?: (ms: number) => Promise<void>;
}

export interface SlackOrgSyncResult {
  enabled: boolean;
  sources: number;
  membershipSynced: number;
  steps: number;
  written: number;
  completed: number;
  rateLimited: number;
  failures: Array<{ sourceId: string; error: string }>;
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function isOrgSource(source: ExternalTriggerSourceRow): boolean {
  return source.config?.credentialModel === SLACK_ORG_CREDENTIAL_MODEL;
}

function membershipDue(source: ExternalTriggerSourceRow, nowMs: number, intervalMs: number): boolean {
  const raw = source.cursor?.orgBackfill;
  const cursor = raw && typeof raw === 'object' ? (raw as { channels?: unknown; membershipSyncedAt?: unknown }) : {};
  if (!Array.isArray(cursor.channels)) return true;
  const syncedAt = Date.parse(typeof cursor.membershipSyncedAt === 'string' ? cursor.membershipSyncedAt : '');
  return !Number.isFinite(syncedAt) || nowMs - syncedAt >= intervalMs;
}

export function formatSlackOrgSyncLog(result: SlackOrgSyncResult): string {
  const failures = result.failures.length > 0 ? ` failures=${JSON.stringify(result.failures)}` : '';
  return (
    `[slack-org-sync] sources=${result.sources} membership_synced=${result.membershipSynced} ` +
    `steps=${result.steps} written=${result.written} completed=${result.completed} ` +
    `rate_limited=${result.rateLimited}${failures}`
  );
}

export async function runSlackOrgSync(
  ctx: Pick<SystemActionCtx, 'workspaceId' | 'installSlug' | 'triggerConfig'>,
  provided: SlackOrgSyncDeps = {},
): Promise<SlackOrgSyncResult> {
  const result: SlackOrgSyncResult = {
    enabled: false,
    sources: 0,
    membershipSynced: 0,
    steps: 0,
    written: 0,
    completed: 0,
    rateLimited: 0,
    failures: [],
  };
  const enabled = provided.isEnabled
    ? await provided.isEnabled()
    : await getFlag(FLAGS.SLACK_ORG_CONNECTOR, 'system').catch(() => false);
  if (!enabled) return result;
  result.enabled = true;

  const sql = provided.sql ?? getOrgPg().sql;
  const now = provided.now ?? (() => new Date());
  const sleep = provided.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const resolveBotToken =
    provided.resolveBotToken ??
    (async (source: ExternalTriggerSourceRow, installSlug: string) =>
      (await resolveSlackSocketCredentials(source, installSlug, provided.storage)).botToken);
  // The gate was read once for this fire; the connector calls below reuse that answer.
  const connector: SlackOrgDeps = { ...provided, now, isEnabled: async () => true };
  const config = ctx.triggerConfig ?? {};
  const maxSteps = boundedInteger(config.max_steps, 5, 1, 40);
  const membershipIntervalMs = boundedInteger(config.membership_interval_sec, 3_600, 60, 86_400) * 1_000;

  const sources = (await listPollableExternalTriggerSources(sql, ctx.workspaceId, 'slack')).filter(isOrgSource);
  result.sources = sources.length;
  for (const listed of sources) {
    try {
      const installSlug = typeof listed.config?.installSlug === 'string' ? listed.config.installSlug : ctx.installSlug;
      const botToken = await resolveBotToken(listed, installSlug);
      let source = listed;
      if (membershipDue(source, now().getTime(), membershipIntervalMs)) {
        await syncSlackOrgMembership(sql, source, botToken, connector);
        result.membershipSynced += 1;
        source = (await getExternalTriggerSource(sql, ctx.workspaceId, source.id)) ?? source;
      }
      for (let step = 0; step < maxSteps; step += 1) {
        const outcome = await backfillSlackOrgOnce(sql, source, botToken, connector);
        result.written += outcome.written;
        if (outcome.status === 'progressed' || outcome.status === 'complete') result.steps += 1;
        if (outcome.status === 'complete') result.completed += 1;
        if (outcome.status === 'rate-limited') result.rateLimited += 1;
        if (outcome.status !== 'progressed') break;
        source = (await getExternalTriggerSource(sql, ctx.workspaceId, source.id)) ?? source;
        if (step + 1 < maxSteps) await sleep(SLACK_ORG_MIN_STEP_MS);
      }
    } catch (cause) {
      const error = (cause instanceof Error ? cause.message : String(cause)).slice(0, 4_000);
      await updateExternalTriggerSourceSyncState(sql, ctx.workspaceId, listed.id, { status: 'degraded', lastError: error });
      result.failures.push({ sourceId: listed.id, error });
    }
  }
  return result;
}

registerSystemAction('slack-org-sync', async (ctx) => {
  const result = await runSlackOrgSync(ctx);
  if (result.sources > 0) console.log(formatSlackOrgSyncLog(result));
});
