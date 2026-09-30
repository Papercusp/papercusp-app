/** Durable Gmail watch/history/PubSub poll action (P-010 / D-011). */
import { getOrgPg } from '@papercusp/db-org';
import type postgres from 'postgres';
import {
  DEFAULT_BACKFILL_MESSAGES_PER_SYNC,
  decodeGoogleGmailNotification,
  ensureGoogleGmailWatch,
  GoogleGmailApiError,
  googleGmailBackfillParked,
  googleGmailBackfillPending,
  googleGmailIncrementalParked,
  googleGmailIncrementalPending,
  googleGmailSourceEmail,
  googleGmailSourceHistoryId,
  googleGmailWatchExpiresAt,
  isGoogleGmailQuotaError,
  syncGoogleGmailSource,
  type GoogleGmailDeps,
  type GoogleGmailSyncResult,
  type GoogleGmailWatchResult,
} from '../../external-triggers/google-gmail';
import { ensureGmailRespondDraftBinding } from '../../external-triggers/gmail-flagship';
import {
  acknowledgeGoogleGmailNotifications,
  provisionGoogleGmailPubSub,
  pullGoogleGmailNotifications,
  type GooglePubSubProvisionResult,
  type GooglePubSubReceivedMessage,
} from '../../external-triggers/google-pubsub';
import {
  type ExternalTriggerSourceRow,
  getExternalTriggerSource,
  listPollableExternalTriggerSources,
  updateExternalTriggerSourceSyncState,
} from '../../external-triggers/source-store';
import {
  isGoogleWorkspaceTerminalAuthError,
  resolveGoogleWorkspaceAccessToken,
  withGoogleWorkspaceAccessTokenRetry,
} from '../../external-triggers/google-workspace';
import { registerSystemAction, type SystemActionCtx } from './system-actions';

export interface GoogleGmailPollFailure {
  sourceId: string;
  status: 'degraded' | 'error';
  error: string;
}

export interface GoogleGmailPollResult {
  sources: number;
  succeeded: number;
  failed: number;
  renewed: number;
  /** Watch renewals not attempted because the mailbox's backfill is parked on a quota cool-down. */
  watchDeferred: number;
  /** Watch renewals that hit the per-user quota (403/429) and were treated as a pause, not a failure. */
  watchThrottled: number;
  /** Per-source syncs that hit the per-user quota (403/429) anywhere and were skipped this poll, not degraded. */
  quotaThrottled: number;
  pulled: number;
  acknowledged: number;
  messages: number;
  fullResyncs: number;
  /** Listed messages skipped because they were gone (404) by the time they were fetched — never a cursor fault. */
  messagesGone: number;
  failures: GoogleGmailPollFailure[];
}

type GoogleGmailAuthenticatedRunner = <T>(
  source: ExternalTriggerSourceRow,
  installSlug: string,
  operation: (accessToken: string) => Promise<T>,
) => Promise<T>;

export interface GoogleGmailPollDeps {
  sql?: postgres.Sql;
  listSources?: typeof listPollableExternalTriggerSources;
  getSource?: typeof getExternalTriggerSource;
  resolveAccessToken?: (source: ExternalTriggerSourceRow, installSlug: string) => Promise<string>;
  withAccessTokenRetry?: GoogleGmailAuthenticatedRunner;
  provision?: (workspaceId: string) => Promise<GooglePubSubProvisionResult>;
  pull?: (workspaceId: string, maxMessages: number) => Promise<GooglePubSubReceivedMessage[]>;
  acknowledge?: (workspaceId: string, ackIds: string[]) => Promise<number>;
  ensureWatch?: (
    sql: postgres.Sql,
    source: ExternalTriggerSourceRow,
    accessToken: string,
    topicName: string,
    input: { renewBeforeMs?: number },
  ) => Promise<GoogleGmailWatchResult>;
  ensureFlagshipBinding?: typeof ensureGmailRespondDraftBinding;
  syncSource?: (
    sql: postgres.Sql,
    source: ExternalTriggerSourceRow,
    accessToken: string,
    options?: GoogleGmailDeps,
  ) => Promise<GoogleGmailSyncResult>;
  updateSource?: typeof updateExternalTriggerSourceSyncState;
  now?: () => Date;
}

/**
 * Render a failure with the transport detail a bare `message` drops. node-fetch
 * reports a socket fault as `request to <url> failed, reason: ` with the actual
 * cause only on `code`/`errno`/`cause`, which made ECONNRESET, DNS and timeout
 * failures indistinguishable in `last_error` (EI-23378389605835281).
 */
export function describeErrorCause(cause: unknown, depth = 0): string {
  if (!(cause instanceof Error)) return String(cause);
  const tags: string[] = [];
  for (const key of ['code', 'errno', 'type', 'status'] as const) {
    const value = (cause as unknown as Record<string, unknown>)[key];
    if (typeof value === 'string' || typeof value === 'number') tags.push(`${key}=${value}`);
  }
  let text = cause.message || cause.name;
  if (tags.length > 0) text += ` [${tags.join(' ')}]`;
  if (depth < 4 && cause.cause !== undefined && cause.cause !== cause) {
    text += ` <- ${describeErrorCause(cause.cause, depth + 1)}`;
  }
  return text;
}

function errorText(cause: unknown): string {
  return describeErrorCause(cause).slice(0, 4000);
}

/** Keep per-source failure causes in the durable routine log, not only in the live result. */
export function formatGoogleGmailPollLog(result: GoogleGmailPollResult): string {
  const failures = result.failures.length > 0 ? ` failures=${JSON.stringify(result.failures)}` : '';
  return (
    `[google-gmail-poll] sources=${result.sources} succeeded=${result.succeeded} ` +
    `failed=${result.failed} renewed=${result.renewed} watch_deferred=${result.watchDeferred} ` +
    `watch_throttled=${result.watchThrottled} quota_throttled=${result.quotaThrottled} pulled=${result.pulled} ` +
    `acknowledged=${result.acknowledged} messages=${result.messages} ` +
    `full_resyncs=${result.fullResyncs} messages_gone=${result.messagesGone}${failures}`
  );
}

/**
 * One line per full resync naming WHY it fired. The aggregate full_resyncs
 * counter alone once sent a diagnosis down the wrong mechanism
 * (EI-23429618437235533 / WI-10001662): a cursorless bootstrap and an
 * expired-history rebootstrap both count as `full`, and only the latter
 * discards a resumable backfill.
 */
export function formatGoogleGmailFullResyncLog(
  sourceId: string,
  synced: Pick<GoogleGmailSyncResult, 'resyncReason'>,
): string {
  const reason = synced.resyncReason
    ? `reason=history_expired operation=${synced.resyncReason.operation} status=${synced.resyncReason.status}`
    : 'reason=no_cursor';
  return `[google-gmail-poll] full_resync source=${sourceId} ${reason}`;
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

async function runGoogleGmailAuthenticated<T>(
  source: ExternalTriggerSourceRow,
  installSlug: string,
  operation: (accessToken: string) => Promise<T>,
): Promise<T> {
  return withGoogleWorkspaceAccessTokenRetry(source, installSlug, async (accessToken) => {
    try {
      return { status: 200, result: await operation(accessToken) };
    } catch (cause) {
      if (cause instanceof GoogleGmailApiError && cause.status === 401) {
        return { status: 401, result: undefined as T };
      }
      throw cause;
    }
  });
}

/**
 * Renew every owned Gmail watch, pull this workspace's broadcast doorbells,
 * reconcile only matching mailboxes, then ack the successfully committed ones.
 */
export async function runGoogleGmailPoll(
  ctx: SystemActionCtx,
  provided: GoogleGmailPollDeps = {},
): Promise<GoogleGmailPollResult> {
  const sql = provided.sql ?? getOrgPg().sql;
  const listSources = provided.listSources ?? listPollableExternalTriggerSources;
  const getSource = provided.getSource ?? getExternalTriggerSource;
  const resolveAccessToken = provided.resolveAccessToken ?? resolveGoogleWorkspaceAccessToken;
  const withAccessTokenRetry: GoogleGmailAuthenticatedRunner =
    provided.withAccessTokenRetry ??
    (provided.resolveAccessToken
      ? async (source, installSlug, operation) => operation(await resolveAccessToken(source, installSlug))
      : runGoogleGmailAuthenticated);
  const provision = provided.provision ?? ((workspaceId) => provisionGoogleGmailPubSub({ workspaceId }));
  const pull =
    provided.pull ?? ((workspaceId, maxMessages) => pullGoogleGmailNotifications({ workspaceId, maxMessages }));
  const acknowledge =
    provided.acknowledge ?? ((workspaceId, ackIds) => acknowledgeGoogleGmailNotifications({ workspaceId }, ackIds));
  const ensureWatch = provided.ensureWatch ?? ensureGoogleGmailWatch;
  const ensureFlagshipBinding = provided.ensureFlagshipBinding ?? ensureGmailRespondDraftBinding;
  const syncSource = provided.syncSource ?? syncGoogleGmailSource;
  const updateSource = provided.updateSource ?? updateExternalTriggerSourceSyncState;
  const now = provided.now ?? (() => new Date());
  const sources = await listSources(sql, ctx.workspaceId, 'gmail');
  const result: GoogleGmailPollResult = {
    sources: sources.length,
    succeeded: 0,
    failed: 0,
    renewed: 0,
    watchDeferred: 0,
    watchThrottled: 0,
    quotaThrottled: 0,
    pulled: 0,
    acknowledged: 0,
    messages: 0,
    fullResyncs: 0,
    messagesGone: 0,
    failures: [],
  };
  if (sources.length === 0) return result;

  const failedSourceIds = new Set<string>();
  const recordFailure = async (source: ExternalTriggerSourceRow, cause: unknown): Promise<void> => {
    if (failedSourceIds.has(source.id)) return;
    const error = errorText(cause);
    const status = isGoogleWorkspaceTerminalAuthError(error) ? 'error' : 'degraded';
    await updateSource(sql, ctx.workspaceId, source.id, { status, lastError: error });
    failedSourceIds.add(source.id);
    result.failures.push({ sourceId: source.id, status, error });
  };

  let pubsub: GooglePubSubProvisionResult;
  try {
    pubsub = await provision(ctx.workspaceId);
  } catch (cause) {
    // Pub/Sub provisioning is shared by every mailbox. A missing GCP permission
    // must degrade the owned sources, not escape the system action and wedge the
    // routine on every cron tick before it can report a useful source status.
    for (const source of sources) await recordFailure(source, cause);
    result.failed = failedSourceIds.size;
    result.succeeded = sources.length - result.failed;
    return result;
  }
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const readySourceIds = new Set<string>();
  const renewBeforeMs = boundedInteger(
    ctx.triggerConfig.renew_before_ms,
    24 * 60 * 60 * 1_000,
    0,
    7 * 24 * 60 * 60 * 1_000,
  );
  const syncOptions: GoogleGmailDeps = {
    backfillMessagesPerSync: boundedInteger(
      ctx.triggerConfig.backfill_messages_per_sync,
      DEFAULT_BACKFILL_MESSAGES_PER_SYNC,
      1,
      5_000,
    ),
  };
  for (const source of sources) {
    try {
      // Reconcile the built-in binding on every durable poll so sources connected
      // before the flagship template existed are repaired without requiring OAuth.
      await ensureFlagshipBinding(
        sql,
        ctx.workspaceId,
        source,
        source.ownerUserId ? `owner:${source.ownerUserId}` : null,
      );
      // A quota cool-down applies to the whole mailbox, including history and
      // notification follow-up. Pulling the same doorbells during it cannot
      // make progress and competes with interactive sends for per-user quota.
      if (googleGmailBackfillParked(source, now()) || googleGmailIncrementalParked(source, now())) {
        result.quotaThrottled += 1;
        continue;
      }
      let authAttempt = 0;
      const prepared = await withAccessTokenRetry(source, ctx.installSlug, async (accessToken) => {
        let current =
          authAttempt++ === 0 ? source : ((await getSource(sql, ctx.workspaceId, source.id)) ?? source);
        let messages = 0;
        let messagesGone = 0;
        let fullResyncs = 0;
        // A cursorless mailbox bootstraps here; a cursored one whose resumable
        // backfill is still pending advances it by one budgeted chunk per poll.
        if (!googleGmailSourceHistoryId(current) || googleGmailBackfillPending(current) || googleGmailIncrementalPending(current)) {
          const initial = await syncSource(sql, current, accessToken, syncOptions);
          messages += initial.messages;
          messagesGone += initial.messagesGone;
          if (initial.mode === 'full') {
            fullResyncs += 1;
            console.log(formatGoogleGmailFullResyncLog(current.id, initial));
          }
          const persisted = await getSource(sql, ctx.workspaceId, current.id);
          if (!persisted) throw new Error(`google_gmail_source_missing_after_initial_sync:${current.id}`);
          current = persisted;
          if (initial.incrementalPending) {
            return { readySource: current, renewed: false, messages, messagesGone, fullResyncs, incrementalPending: true };
          }
        }
        // The users.watch renewal shares the per-user quota with the backfill
        // chunk that just ran. While that backfill is parked on a quota
        // cool-down and the existing watch is still valid, renewing now can
        // only burn a 403 — the ≥24h renew-before margin absorbs a ≤15min
        // wait. A quota error on the attempt itself is the same pause signal
        // the backfill uses, never a reason to degrade the source (WI-10001549).
        let watched: Pick<GoogleGmailWatchResult, 'renewed' | 'source'>;
        const watchExpiresAt = googleGmailWatchExpiresAt(current);
        const watchStillValid = watchExpiresAt !== null && watchExpiresAt > now().getTime();
        if (watchStillValid && googleGmailBackfillParked(current, now())) {
          watched = { renewed: false, source: current };
          result.watchDeferred += 1;
        } else {
          try {
            watched = await ensureWatch(sql, current, accessToken, pubsub.topicName, { renewBeforeMs });
          } catch (cause) {
            if (!isGoogleGmailQuotaError(cause)) throw cause;
            watched = { renewed: false, source: current };
            result.watchThrottled += 1;
          }
        }
        const readySource =
          watched.source.status === 'connected'
            ? watched.source
            : await updateSource(sql, ctx.workspaceId, source.id, {
                status: 'connected',
                lastError: null,
                connected: true,
              });
        return { readySource, renewed: watched.renewed, messages, messagesGone, fullResyncs };
      });
      sourceById.set(source.id, prepared.readySource);
      if (!prepared.incrementalPending) readySourceIds.add(source.id);
      result.messages += prepared.messages;
      result.messagesGone += prepared.messagesGone;
      result.fullResyncs += prepared.fullResyncs;
      if (prepared.renewed) result.renewed += 1;
    } catch (cause) {
      // The per-user quota is shared by every call for that mailbox, so a 403
      // here (history.list right after a backfill chunk spent the minute) is the
      // same pause signal the chunk and the watch renewal already honour — the
      // next poll retries; nothing is 'degraded' (EI-23429618437235533).
      if (isGoogleGmailQuotaError(cause)) {
        result.quotaThrottled += 1;
        continue;
      }
      await recordFailure(source, cause);
    }
  }

  // No mailbox can safely consume a notification yet. Leave Pub/Sub alone so
  // it redelivers only when a source's incremental cursor can advance again.
  if (readySourceIds.size === 0) {
    result.failed = failedSourceIds.size;
    result.succeeded = sources.length - result.failed;
    return result;
  }

  const maxMessages = boundedInteger(ctx.triggerConfig.max_messages, 100, 1, 1_000);
  const pulled = await pull(ctx.workspaceId, maxMessages);
  result.pulled = pulled.length;
  if (pulled.length === 0) {
    result.failed = failedSourceIds.size;
    result.succeeded = sources.length - result.failed;
    return result;
  }

  const sourceIdsByEmail = new Map<string, string[]>();
  let everySourceHasEmail = true;
  for (const source of sourceById.values()) {
    const email = googleGmailSourceEmail(source)?.toLowerCase();
    if (!email) {
      everySourceHasEmail = false;
      continue;
    }
    sourceIdsByEmail.set(email, [...(sourceIdsByEmail.get(email) ?? []), source.id]);
  }

  // null means the notification cannot yet be safely acknowledged.
  const requirements = new Map<string, Set<string> | null>();
  const targets = new Set<string>();
  for (const received of pulled) {
    const notification = decodeGoogleGmailNotification(received.message?.data);
    if (!notification) {
      const readyIds = [...readySourceIds];
      if (readyIds.length !== sources.length) {
        requirements.set(received.ackId, null);
      } else {
        requirements.set(received.ackId, new Set(readyIds));
        readyIds.forEach((id) => targets.add(id));
      }
      continue;
    }
    const matching = sourceIdsByEmail.get(notification.emailAddress.toLowerCase()) ?? [];
    if (matching.length === 0) {
      // The shared topic broadcasts every mailbox to every workspace
      // subscription. Once all local mailboxes are known, a non-match is an
      // irrelevant doorbell and can be drained without touching local cursors.
      requirements.set(received.ackId, everySourceHasEmail ? new Set() : null);
      continue;
    }
    if (!matching.every((id) => readySourceIds.has(id))) {
      requirements.set(received.ackId, null);
      continue;
    }
    const required = new Set(matching);
    requirements.set(received.ackId, required);
    matching.forEach((id) => targets.add(id));
  }

  const syncedSourceIds = new Set<string>();
  for (const sourceId of targets) {
    const source = sourceById.get(sourceId);
    if (!source || !readySourceIds.has(sourceId)) continue;
    try {
      const synced = await withAccessTokenRetry(source, ctx.installSlug, (accessToken) =>
        syncSource(sql, source, accessToken, syncOptions),
      );
      syncedSourceIds.add(sourceId);
      result.messages += synced.messages;
      result.messagesGone += synced.messagesGone;
      if (synced.mode === 'full') {
        result.fullResyncs += 1;
        console.log(formatGoogleGmailFullResyncLog(sourceId, synced));
      }
    } catch (cause) {
      if (isGoogleGmailQuotaError(cause)) {
        result.quotaThrottled += 1;
        continue;
      }
      await recordFailure(source, cause);
    }
  }

  const ackIds = [...requirements.entries()]
    .filter(([, required]) => required !== null && [...required].every((id) => syncedSourceIds.has(id)))
    .map(([ackId]) => ackId);
  result.acknowledged = await acknowledge(ctx.workspaceId, ackIds);
  result.failed = failedSourceIds.size;
  result.succeeded = sources.length - result.failed;
  return result;
}

registerSystemAction('google-gmail-poll', async (ctx) => {
  const result = await runGoogleGmailPoll(ctx);
  if (result.sources > 0 || result.pulled > 0) {
    console.log(formatGoogleGmailPollLog(result));
  }
});
