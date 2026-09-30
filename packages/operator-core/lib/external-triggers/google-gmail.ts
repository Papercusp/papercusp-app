/**
 * Replay-safe Gmail adapter (external-triggers P-010 / D-011).
 *
 * Pub/Sub notifications are only doorbells. The durable source cursor owns the
 * Gmail historyId, and advances only after every message delivery succeeds.
 *
 * Initial backfill (EI-23378389605835281): a mailbox with no history cursor is
 * pinned to the profile historyId FIRST, so incremental sync and the watch
 * start on the very first poll, and the historical walk runs as a resumable,
 * quota-budgeted chunk per sync (`cursor.backfill`) instead of one whole-mailbox
 * walk that a per-user quota kills and the next poll restarts from zero.
 */
import type { gmail_v1 } from '@googleapis/gmail';
import { Gaxios, type GaxiosError } from 'gaxios';
import MailComposer from 'nodemailer/lib/mail-composer';
import type postgres from 'postgres';
import {
  ingestExternalTriggerEvent,
  type IngestExternalTriggerInput,
  type IngestExternalTriggerResult,
} from './ingestion';
import { type ExternalTriggerSourceRow, updateExternalTriggerSourceSyncState } from './source-store';
import { createPersonalVaultExternalSinkForSource, type PersonalVaultExternalSink } from '../personal-vault/live-sink';
import {
  createAppDeliverySinkIfConfigured,
  reportAppSinkGateError,
  type AppDeliveryExternalSink,
} from '../app-data-producer/live-sink';

/**
 * Every sink this adapter hands to ingestion. The personal vault is always
 * present; the app-delivery sink (P-011) appears only when this deployment has
 * an owner mapping for the source's user, so an unconfigured deployment sees
 * exactly the previous single-sink behaviour.
 */
type IngestSink = PersonalVaultExternalSink | AppDeliveryExternalSink;

const GMAIL_API_ORIGIN = 'https://gmail.googleapis.com';
const DEFAULT_RENEW_BEFORE_MS = 24 * 60 * 60 * 1_000;
const MAX_PAGES = 10_000;
/** messages.list pages are capped at 500 by Gmail. */
const MAX_LIST_PAGE_SIZE = 500;
/**
 * Historical messages walked per sync (the CEILING of the adaptive budget).
 * The poll routine fires every minute and each messages.get costs 5 quota
 * units. The prior default of 200 exceeded what this project's per-user
 * per-minute quota actually allows: a 158-message chunk tripped it live
 * (WI-10001549), so the budget starts at 100 and halves per consecutive
 * throttle (see `googleGmailBackfillBudget`) down to the floor below.
 */
export const DEFAULT_BACKFILL_MESSAGES_PER_SYNC = 100;
const MAX_BACKFILL_MESSAGES_PER_SYNC = 5_000;
/** The adaptive budget never shrinks below this (unless the ceiling is smaller). */
export const MIN_BACKFILL_MESSAGES_PER_SYNC = 25;
/**
 * messages.list page size inside a chunk. The continuation token checkpoints
 * per PAGE, so a quota trip mid-page re-walks that page's already-delivered
 * messages on resume (delivery is dedupe-keyed but the gets still cost quota).
 * Small pages bound that waste to <25 gets per throttle; a list call costs 5 units.
 */
const BACKFILL_LIST_PAGE_SIZE = 25;
const BACKFILL_THROTTLE_BASE_MS = 60_000;
const BACKFILL_THROTTLE_MAX_MS = 15 * 60_000;

/**
 * Wire shapes are the Gmail API's OWN published types, not our transcription of
 * them. These aliases keep the domain-meaningful names at our boundary (so call
 * sites and consumers never churn) while `gmail_v1.Schema$*` owns what the
 * fields actually are.
 *
 * The concrete gain is NULLABILITY. Every hand-written field above was written
 * `field?: string` — `string | undefined`. Gmail publishes `string | null`, so
 * our version asserted a guarantee the API does not make, and a `null` arriving
 * where we had promised ourselves `undefined` reaches `?? fallback` and `!value`
 * intact but slips straight through a `=== undefined` or a `typeof x === 'string'`
 * assumption further out. Adopting the published type makes the compiler point at
 * each such spot instead of leaving it to a runtime surprise.
 *
 * `Schema$Message` also has NO index signature, where our `GoogleGmailMessage`
 * carried `[key: string]: unknown`. That escape hatch is what a transcribed
 * shape needs to stay honest about fields it never enumerated; the real schema
 * enumerates them, so dropping it is the point rather than a casualty.
 */
export type GoogleGmailHeader = gmail_v1.Schema$MessagePartHeader;
export type GoogleGmailMessagePart = gmail_v1.Schema$MessagePart;
export type GoogleGmailMessage = gmail_v1.Schema$Message;

type GoogleGmailProfile = gmail_v1.Schema$Profile;
type GoogleGmailWatchResponse = gmail_v1.Schema$WatchResponse;
type GoogleGmailHistoryResponse = gmail_v1.Schema$ListHistoryResponse;
type GoogleGmailMessagesListResponse = gmail_v1.Schema$ListMessagesResponse;

export interface GoogleGmailWatchResult {
  renewed: boolean;
  emailAddress: string;
  historyId: string;
  expiration: string;
  source: ExternalTriggerSourceRow;
}

/**
 * Resumable initial-backfill progress, persisted under `cursor.backfill`.
 * `pageToken` is the messages.list continuation the NEXT sync resumes from;
 * `pending` sources are re-synced by every poll until `complete`.
 */
export interface GoogleGmailBackfillState {
  status: 'pending' | 'throttled' | 'complete';
  pageToken: string | null;
  pages: number;
  messages: number;
  startedAt: string;
  completedAt: string | null;
  throttledUntil: string | null;
  throttleCount: number;
}

/** Why a sync ran in mode:'full' — the Gmail call + status that rejected the stored cursor. */
export interface GoogleGmailResyncReason {
  operation: string;
  status: number;
}

export interface GoogleGmailSyncResult {
  mode: 'incremental' | 'full';
  /** True when the bounded incremental walk has more history for a later poll. */
  incrementalPending?: boolean;
  messages: number;
  /**
   * Listed messages that were gone (messages.get 404) by the time they were
   * fetched and were skipped. Counted so the skip path is observable in the
   * poll summary instead of silently absorbed (WI-10001662).
   */
  messagesGone: number;
  /**
   * Set ONLY when mode:'full' was forced by history.list rejecting the stored
   * cursor; null for an incremental sync and for a cursorless bootstrap. This
   * is the record of WHY a full resync fired, which the aggregate
   * full_resyncs counter alone could not tell (WI-10001662).
   */
  resyncReason: GoogleGmailResyncReason | null;
  historyPages: number;
  messagePages: number;
  historyId: string;
  /** null for a mailbox that was cursored before resumable backfill existed. */
  backfill: GoogleGmailBackfillState | null;
}

export interface GoogleGmailDraftInput {
  to: string;
  subject: string;
  text: string;
  threadId: string;
  inReplyTo: string;
  references?: string | null;
}

/**
 * A create-shaped outbound message: no thread to reply into, so `threadId` and
 * `inReplyTo` are absent rather than empty. Used by the provider-neutral
 * `mail:send` verb (D-019 Tier 1) whose recipients cleared the D-020 rail-2
 * addressee check before reaching this seam.
 */
/**
 * One file to hang off a draft or send.
 *
 * `content` is the RAW bytes; this seam owns the base64 transfer-encoding so no
 * caller can double-encode it. `filename` reaches the recipient verbatim, so it
 * is header-validated exactly like a subject rather than interpolated blind.
 */
export interface GoogleGmailAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
}

export interface GoogleGmailOutboundInput {
  to: string | readonly string[];
  cc?: readonly string[];
  subject: string;
  text: string;
  threadId?: string | null;
  inReplyTo?: string | null;
  references?: string | null;
  /**
   * When present and non-empty the message is encoded `multipart/mixed`; when
   * absent the encoding stays byte-identical to the text/plain form, so adding
   * this field cannot perturb an existing caller.
   */
  attachments?: readonly GoogleGmailAttachment[];
}

export interface GoogleGmailDraftResult {
  draftId: string;
  messageId: string;
  threadId: string;
}

export interface GoogleGmailSendResult {
  messageId: string;
  threadId: string;
}

type Ingest = (sql: postgres.Sql, input: IngestExternalTriggerInput) => Promise<IngestExternalTriggerResult>;

export interface GoogleGmailDeps {
  fetch?: typeof fetch;
  now?: () => Date;
  apiOrigin?: string;
  ingest?: Ingest;
  createPersonalSink?: (sql: postgres.Sql, workspaceId: string, sourceId: string) => Promise<PersonalVaultExternalSink>;
  /**
   * P-011 app-delivery sink factory. Returning null means "this deployment is
   * not configured to deliver to the Email app", which is the normal state for
   * an install with no owner mapping — not an error.
   */
  createAppSink?: (
    sql: postgres.Sql,
    workspaceId: string,
    sourceId: string,
  ) => Promise<AppDeliveryExternalSink | null>;
  updateSource?: typeof updateExternalTriggerSourceSyncState;
  /** Historical messages walked per sync while a backfill is pending. */
  backfillMessagesPerSync?: number;
}

export class GoogleGmailApiError extends Error {
  constructor(
    readonly status: number,
    readonly operation: string,
    detail?: string,
  ) {
    super(`google_gmail_${operation}_${status}${detail ? `:${detail}` : ''}`);
    this.name = 'GoogleGmailApiError';
  }
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function assertSource(source: ExternalTriggerSourceRow, accessToken: string): void {
  if (source.kind !== 'gmail') throw new Error(`google_gmail_source_kind_mismatch:${source.kind}`);
  if (!source.ownerUserId) throw new Error(`external_trigger_source_owner_required:${source.id}`);
  if (!accessToken.trim()) throw new Error('google_gmail_access_token_required');
}

export function googleGmailSourceHistoryId(source: ExternalTriggerSourceRow): string | null {
  return nonEmpty(source.cursor.historyId) ?? nonEmpty(source.cursor.history_id);
}

export function googleGmailSourceEmail(source: ExternalTriggerSourceRow): string | null {
  return (
    nonEmpty(source.cursor.emailAddress) ??
    nonEmpty(source.cursor.email_address) ??
    nonEmpty(source.config.emailAddress) ??
    nonEmpty(source.config.email_address)
  );
}

/** Epoch ms the persisted users.watch expires at; null when no watch was ever recorded. */
export function googleGmailWatchExpiresAt(source: ExternalTriggerSourceRow): number | null {
  const raw = nonEmpty(source.cursor.watchExpiration) ?? nonEmpty(source.cursor.watch_expiration);
  if (!raw) return null;
  const parsed = /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function cursorWithoutHistory(cursor: Record<string, unknown>): Record<string, unknown> {
  const cleared = { ...cursor };
  delete cleared.historyId;
  delete cleared.history_id;
  // An expired history cursor means changes were lost; the re-bootstrap walks
  // the mailbox again (delivery is dedupe-keyed, so already-seen mail is a no-op).
  delete cleared.backfill;
  delete cleared.incrementalPending;
  delete cleared.incrementalMore;
  delete cleared.incrementalThrottledUntil;
  delete cleared.incrementalThrottleCount;
  return cleared;
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
}

/** Parse the persisted backfill progress; null when the source never recorded one. */
export function googleGmailBackfillState(source: ExternalTriggerSourceRow): GoogleGmailBackfillState | null {
  const raw = source.cursor.backfill;
  if (!raw || typeof raw !== 'object') return null;
  const state = raw as Record<string, unknown>;
  const status = state.status === 'complete' || state.status === 'throttled' ? state.status : 'pending';
  return {
    status,
    pageToken: nonEmpty(state.pageToken),
    pages: nonNegativeInteger(state.pages),
    messages: nonNegativeInteger(state.messages),
    startedAt: nonEmpty(state.startedAt) ?? new Date(0).toISOString(),
    completedAt: nonEmpty(state.completedAt),
    throttledUntil: nonEmpty(state.throttledUntil),
    throttleCount: nonNegativeInteger(state.throttleCount),
  };
}

/** True while the initial historical walk still has pages (or a throttle) ahead of it. */
export function googleGmailBackfillPending(source: ExternalTriggerSourceRow): boolean {
  const state = googleGmailBackfillState(source);
  return state !== null && state.status !== 'complete';
}

/**
 * True while the backfill is parked on a quota cool-down that has not elapsed.
 * The per-user quota is shared by every Gmail call for that mailbox, so a
 * parked backfill also means "do not spend quota on optional work right now".
 */
export function googleGmailBackfillParked(source: ExternalTriggerSourceRow, now: Date): boolean {
  const state = googleGmailBackfillState(source);
  if (!state || state.status !== 'throttled' || !state.throttledUntil) return false;
  const parkedUntil = Date.parse(state.throttledUntil);
  return Number.isFinite(parkedUntil) && parkedUntil > now.getTime();
}

export function googleGmailIncrementalPending(source: ExternalTriggerSourceRow): boolean {
  return source.cursor.incrementalMore === true;
}

export function googleGmailIncrementalParked(source: ExternalTriggerSourceRow, now: Date): boolean {
  const until = nonEmpty(source.cursor.incrementalThrottledUntil);
  return until !== null && Number.isFinite(Date.parse(until)) && Date.parse(until) > now.getTime();
}

/** history.list rejecting the stored startHistoryId — the ONLY legitimate full-resync trigger. */
export function isGoogleGmailHistoryExpiredError(cause: unknown): boolean {
  return cause instanceof GoogleGmailApiError && cause.status === 404 && cause.operation === 'history_list';
}

/** messages.get 404: the message was deleted between being listed and being fetched. */
export function isGoogleGmailMessageGoneError(cause: unknown): boolean {
  return cause instanceof GoogleGmailApiError && cause.status === 404 && cause.operation === 'message_get';
}

/** Quota exhaustion is a pause signal for the backfill, never a source failure. */
export function isGoogleGmailQuotaError(cause: unknown): boolean {
  if (!(cause instanceof GoogleGmailApiError)) return false;
  if (cause.status === 429) return true;
  return cause.status === 403 && /quota|rate ?limit|usage ?limit|too many/i.test(cause.message);
}

function backfillBudget(value: number | undefined): number {
  if (value === undefined) return DEFAULT_BACKFILL_MESSAGES_PER_SYNC;
  if (!Number.isInteger(value) || value < 1 || value > MAX_BACKFILL_MESSAGES_PER_SYNC) {
    throw new Error('google_gmail_backfill_messages_per_sync_invalid');
  }
  return value;
}

/**
 * Messages the NEXT chunk may walk: the configured ceiling halved once per
 * consecutive quota throttle, floored at `MIN_BACKFILL_MESSAGES_PER_SYNC`.
 * `throttleCount` resets to 0 on a clean chunk, which restores the ceiling.
 */
export function googleGmailBackfillBudget(ceiling: number, throttleCount: number): number {
  const floor = Math.min(MIN_BACKFILL_MESSAGES_PER_SYNC, ceiling);
  const halvings = Math.min(Math.max(0, Math.trunc(throttleCount)), 10);
  return Math.max(floor, Math.floor(ceiling / 2 ** halvings));
}

function backfillThrottleMs(throttleCount: number): number {
  return Math.min(BACKFILL_THROTTLE_BASE_MS * 2 ** Math.min(throttleCount, 10), BACKFILL_THROTTLE_MAX_MS);
}

function throttledBackfillState(
  state: GoogleGmailBackfillState,
  now: Date,
  messages = state.messages,
): GoogleGmailBackfillState {
  const throttleCount = state.throttleCount + 1;
  return {
    ...state,
    status: 'throttled',
    messages,
    throttledUntil: new Date(now.getTime() + backfillThrottleMs(state.throttleCount)).toISOString(),
    throttleCount,
  };
}

async function parseResponse<T>(response: Response, operation: string): Promise<T> {
  const text = await response.text();
  let body: unknown = {};
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { error: { message: text.slice(0, 500) } };
    }
  }
  if (!response.ok) {
    const detail =
      body && typeof body === 'object' ? nonEmpty((body as { error?: { message?: unknown } }).error?.message) : null;
    throw new GoogleGmailApiError(response.status, operation, detail ?? undefined);
  }
  return body as T;
}

/** Retry ceiling for a single Gmail call. */
const GMAIL_MAX_RETRIES = 3;

/**
 * Gmail retry policy — a CORRECTNESS decision, not an inherited default.
 *
 * gaxios ships retrying GET/HEAD/PUT/OPTIONS/DELETE on 408/429/5xx and
 * deliberately NOT retrying POST. That exclusion is load-bearing here: a 5xx on
 * `drafts/send` is AMBIGUOUS — the send may already have happened — so retrying
 * it could double-send a real job application. We keep that, and widen it by
 * exactly one case: POST on 429, where the request was rate-limited and
 * provably not performed. Gmail rate-limits aggressively during a batch send,
 * which makes 429 the transient failure we actually hit.
 *
 * Supplying `shouldRetry` REPLACES gaxios' own predicate, so this states the
 * whole policy rather than delegating part of it.
 */
function shouldRetryGmail(err: GaxiosError): boolean {
  const attempt = err.config?.retryConfig?.currentRetryAttempt ?? 0;
  if (attempt >= GMAIL_MAX_RETRIES) return false;
  const method = (err.config?.method ?? 'GET').toUpperCase();
  const status = err.response?.status;
  if (status === undefined) {
    // No response at all (socket/DNS): the server may still have acted on a
    // POST, so only replay methods that are safe to repeat.
    return method !== 'POST' && attempt < 2;
  }
  if (method === 'POST') return status === 429;
  return status === 408 || status === 429 || (status >= 100 && status <= 199) || (status >= 500 && status <= 599);
}

/**
 * Preserve the `GoogleGmailApiError(status, operation, detail)` contract that
 * callers and tests assert on, whatever shape the transport failed in.
 */
function toGoogleGmailApiError(err: unknown, operation: string): Error {
  const gaxios = err as Partial<GaxiosError> & { status?: number };
  const status = gaxios?.response?.status ?? gaxios?.status;
  if (typeof status !== 'number') return err instanceof Error ? err : new Error(String(err));
  const data = gaxios?.response?.data as { error?: { message?: unknown } } | string | undefined;
  const detail =
    typeof data === 'string'
      ? nonEmpty(data.slice(0, 500))
      : nonEmpty((data as { error?: { message?: unknown } } | undefined)?.error?.message);
  return new GoogleGmailApiError(status, operation, detail ?? undefined);
}

async function gmailRequest<T>(
  fetchImpl: typeof fetch,
  apiOrigin: string,
  accessToken: string,
  path: string,
  operation: string,
  input: { method?: string; params?: URLSearchParams; body?: unknown } = {},
): Promise<T> {
  const url = new URL(path, apiOrigin);
  if (input.params) url.search = input.params.toString();
  // gaxios is the @googleapis/gmail transport; routing through it is what buys
  // bounded exponential backoff, which the raw-fetch version never had.
  const transport = new Gaxios({ fetchImplementation: fetchImpl });
  try {
    const response = await transport.request<T>({
      url: url.toString(),
      method: (input.method ?? 'GET') as 'GET',
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: 'application/json',
        ...(input.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      // Pre-serialized so the wire body stays a JSON string, byte-identical to
      // what the hand-rolled encoder sent.
      body: input.body === undefined ? undefined : JSON.stringify(input.body),
      retryConfig: { retry: GMAIL_MAX_RETRIES, shouldRetry: shouldRetryGmail },
      errorRedactor: false,
    });
    return response.data as T;
  } catch (err) {
    throw toGoogleGmailApiError(err, operation);
  }
}

async function profile(
  fetchImpl: typeof fetch,
  apiOrigin: string,
  accessToken: string,
): Promise<{ emailAddress: string; historyId: string }> {
  const body = await gmailRequest<GoogleGmailProfile>(
    fetchImpl,
    apiOrigin,
    accessToken,
    '/gmail/v1/users/me/profile',
    'profile',
  );
  const emailAddress = nonEmpty(body.emailAddress);
  const historyId = nonEmpty(body.historyId);
  if (!emailAddress) throw new Error('google_gmail_profile_email_missing');
  if (!historyId) throw new Error('google_gmail_profile_history_id_missing');
  return { emailAddress, historyId };
}

function watchExpirationIso(expiration: string | null): string {
  if (!expiration || !/^\d+$/.test(expiration)) {
    throw new Error('google_gmail_watch_expiration_invalid');
  }
  const parsed = Number(expiration);
  if (!Number.isFinite(parsed)) throw new Error('google_gmail_watch_expiration_invalid');
  return new Date(parsed).toISOString();
}

/** Renew users.watch when due, preserving an existing replay cursor. */
export async function ensureGoogleGmailWatch(
  sql: postgres.Sql,
  source: ExternalTriggerSourceRow,
  accessToken: string,
  topicName: string,
  input: { renewBeforeMs?: number } = {},
  provided: GoogleGmailDeps = {},
): Promise<GoogleGmailWatchResult> {
  assertSource(source, accessToken);
  if (!topicName.trim()) throw new Error('google_gmail_topic_name_required');
  const fetchImpl = provided.fetch ?? fetch;
  const apiOrigin = (provided.apiOrigin ?? GMAIL_API_ORIGIN).replace(/\/$/, '');
  const now = (provided.now ?? (() => new Date()))();
  if (!Number.isFinite(now.getTime())) throw new Error('google_gmail_now_invalid');
  const renewBeforeMs = input.renewBeforeMs ?? DEFAULT_RENEW_BEFORE_MS;
  if (!Number.isFinite(renewBeforeMs) || renewBeforeMs < 0) {
    throw new Error('google_gmail_renew_before_ms_invalid');
  }
  const currentHistoryId = googleGmailSourceHistoryId(source);
  const currentExpiration = googleGmailWatchExpiresAt(source);
  const currentEmail = googleGmailSourceEmail(source);
  const shouldRenew =
    !currentHistoryId || currentExpiration === null || currentExpiration <= now.getTime() + renewBeforeMs;
  if (!shouldRenew && currentEmail) {
    return {
      renewed: false,
      emailAddress: currentEmail,
      historyId: currentHistoryId,
      expiration: new Date(currentExpiration).toISOString(),
      source,
    };
  }

  const mailbox = currentEmail
    ? { emailAddress: currentEmail, historyId: currentHistoryId ?? '' }
    : await profile(fetchImpl, apiOrigin, accessToken);
  let nextHistoryId = currentHistoryId;
  let expiration = currentExpiration === null ? null : new Date(currentExpiration).toISOString();
  if (shouldRenew) {
    const watched = await gmailRequest<GoogleGmailWatchResponse>(
      fetchImpl,
      apiOrigin,
      accessToken,
      '/gmail/v1/users/me/watch',
      'watch',
      { method: 'POST', body: { topicName } },
    );
    nextHistoryId ??= nonEmpty(watched.historyId);
    if (!nextHistoryId) throw new Error('google_gmail_watch_history_id_missing');
    expiration = watchExpirationIso(nonEmpty(watched.expiration));
  }
  if (!nextHistoryId || !expiration) throw new Error('google_gmail_watch_state_incomplete');
  const cursor = {
    ...source.cursor,
    emailAddress: mailbox.emailAddress,
    historyId: nextHistoryId,
    watchExpiration: expiration,
  };
  const updated = await (provided.updateSource ?? updateExternalTriggerSourceSyncState)(
    sql,
    source.workspaceId,
    source.id,
    { status: 'connected', cursor, lastError: null, connected: true },
  );
  return {
    renewed: shouldRenew,
    emailAddress: mailbox.emailAddress,
    historyId: nextHistoryId,
    expiration,
    source: updated,
  };
}

/**
 * `null` is admitted deliberately, not to appease the compiler: Gmail publishes
 * `Schema$MessagePartBody.data` as `string | null`, and an attachment part
 * carries `attachmentId` with a null `data` rather than omitting the field. The
 * runtime was always correct here — `nonEmpty` takes `unknown` and rejects null
 * on the first branch — so the old `string | undefined` was a type narrower than
 * the behavior it described, which is the kind of gap that stays invisible until
 * something downstream trusts it.
 */
function decodeBase64Url(data: string | null | undefined): string | null {
  const normalized = nonEmpty(data);
  if (!normalized) return null;
  try {
    return Buffer.from(normalized.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  } catch {
    return null;
  }
}

function header(part: GoogleGmailMessagePart | undefined, name: string): string | null {
  const found = part?.headers?.find((candidate) => candidate.name?.toLowerCase() === name.toLowerCase());
  return nonEmpty(found?.value);
}

function addressList(value: string | null): string[] {
  if (!value) return [];
  const values: string[] = [];
  let current = '';
  let quoted = false;
  let angleDepth = 0;
  for (const character of value) {
    if (character === '"') quoted = !quoted;
    if (!quoted && character === '<') angleDepth += 1;
    if (!quoted && character === '>') angleDepth = Math.max(0, angleDepth - 1);
    if (character === ',' && !quoted && angleDepth === 0) {
      if (current.trim()) values.push(current.trim());
      current = '';
    } else {
      current += character;
    }
  }
  if (current.trim()) values.push(current.trim());
  return values;
}

function collectBodies(part: GoogleGmailMessagePart | undefined, texts: string[], html: string[]): void {
  if (!part) return;
  const mimeType = part.mimeType?.toLowerCase();
  if (!part.filename && mimeType === 'text/plain') {
    const decoded = decodeBase64Url(part.body?.data);
    if (decoded) texts.push(decoded);
  } else if (!part.filename && mimeType === 'text/html') {
    const decoded = decodeBase64Url(part.body?.data);
    if (decoded) html.push(decoded);
  }
  for (const child of part.parts ?? []) collectBodies(child, texts, html);
}

function occurredAt(message: GoogleGmailMessage): string | null {
  const internalDate = nonEmpty(message.internalDate);
  if (internalDate && /^\d+$/.test(internalDate)) {
    const parsed = Number(internalDate);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  const date = header(message.payload, 'Date');
  if (!date) return null;
  const parsed = Date.parse(date);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

/** Normalize one Gmail API message into the canonical email-message datatype. */
export function normalizeGoogleGmailMessage(message: GoogleGmailMessage): Record<string, unknown> {
  const id = nonEmpty(message.id);
  if (!id) throw new Error('google_gmail_message_id_required');
  const texts: string[] = [];
  const html: string[] = [];
  collectBodies(message.payload, texts, html);
  const normalized: Record<string, unknown> = { id };
  const threadId = nonEmpty(message.threadId);
  const from = header(message.payload, 'From');
  const subject = header(message.payload, 'Subject');
  const messageId = header(message.payload, 'Message-ID');
  const references = header(message.payload, 'References');
  const time = occurredAt(message);
  if (threadId) normalized.threadId = threadId;
  if (from) normalized.from = from;
  const to = addressList(header(message.payload, 'To'));
  const cc = addressList(header(message.payload, 'Cc'));
  const bcc = addressList(header(message.payload, 'Bcc'));
  if (to.length) normalized.to = to;
  if (cc.length) normalized.cc = cc;
  if (bcc.length) normalized.bcc = bcc;
  if (subject) normalized.subject = subject;
  if (messageId) normalized.messageId = messageId;
  if (references) normalized.references = references;
  if (texts.length) normalized.text = [...new Set(texts)].join('\n');
  if (html.length) normalized.html = [...new Set(html)].join('\n');
  const snippet = nonEmpty(message.snippet);
  if (snippet) normalized.snippet = snippet;
  if (time) normalized.occurredAt = time;
  if (message.labelIds?.length) {
    normalized.labels = [...message.labelIds];
    normalized.direction = message.labelIds.some((label) => label === 'SENT' || label === 'DRAFT')
      ? 'outbound'
      : 'inbound';
  }
  return normalized;
}

function safeHeader(value: string, field: string, maxLength = 8_000): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || /[\r\n]/.test(normalized)) {
    throw new Error(`google_gmail_draft_${field}_invalid`);
  }
  return normalized;
}

/**
 * `Re:`-prefix a subject exactly once. Mail-protocol knowledge, so it belongs
 * with the adapter rather than being re-implemented by each caller.
 */
export function replySubjectFor(subject: string): string {
  const normalized = String(subject ?? '').trim();
  return /^re\s*:/i.test(normalized) ? normalized : `Re: ${normalized}`;
}

function replyReferences(references: string | null | undefined, inReplyTo: string): string {
  const prior = references?.trim() ?? '';
  const combined = prior ? `${prior} ${inReplyTo}` : inReplyTo;
  return safeHeader(combined, 'references');
}

export interface GoogleGmailEncodedMessage {
  raw: string;
  to: string;
  subject: string;
  threadId: string | null;
}

/**
 * Encode one outbound message as base64url RFC 2822.
 *
 * Shared by the draft and send seams so threading is implemented exactly once.
 * Reply threading is the part callers get wrong: Gmail needs BOTH the
 * `threadId` on the API request AND `In-Reply-To`/`References` headers in the
 * MIME body. Supplying only one of them produces a message that sends fine and
 * lands OUTSIDE the thread — a silent failure, which is why no agent-facing
 * verb is allowed to assemble this itself.
 */
export async function buildGoogleGmailRawMessage(
  input: GoogleGmailOutboundInput,
): Promise<GoogleGmailEncodedMessage> {
  const recipients = (Array.isArray(input.to) ? input.to : [input.to])
    .map((value) => String(value ?? '').trim())
    .filter(Boolean);
  if (!recipients.length) throw new Error('google_gmail_to_required');
  const to = safeHeader(recipients.join(', '), 'to', 2_000);
  const cc = (input.cc ?? []).map((value) => String(value ?? '').trim()).filter(Boolean);
  const ccHeader = cc.length ? safeHeader(cc.join(', '), 'cc', 2_000) : null;
  const subject = safeHeader(input.subject, 'subject', 998);
  const text = input.text.trim();
  if (!text || text.length > 100_000) throw new Error('google_gmail_draft_text_invalid');
  const threadId = input.threadId?.trim() ? safeHeader(input.threadId, 'thread_id', 512) : null;
  const inReplyTo = input.inReplyTo?.trim() ? safeHeader(input.inReplyTo, 'in_reply_to', 998) : null;
  const attachments = normalizeGmailAttachments(input.attachments);

  // Every rail above still runs HERE, before the encoder sees anything: the
  // header injection checks, the length caps and the attachment limits are ours
  // and are not delegated. MailComposer replaces only the ASSEMBLY — boundary
  // selection, transfer-encoding, header folding and RFC 2047 encoding — which
  // is exactly the part a hand-rolled encoder gets wrong. Measured against live
  // Gmail 2026-09-16: the previous builder emitted a non-ASCII `Subject:` as raw
  // UTF-8 bytes (a spec violation) and declared the body `8bit`; MailComposer
  // emits `=?UTF-8?Q?…?=` and quoted-printable, and Gmail round-trips it intact.
  const built = await new MailComposer({
    to,
    ...(ccHeader ? { cc: ccHeader } : {}),
    subject,
    text,
    ...(inReplyTo
      ? { inReplyTo, references: replyReferences(input.references, inReplyTo) }
      : {}),
    ...(attachments.length
      ? {
          attachments: attachments.map((file) => ({
            filename: file.filename,
            contentType: file.contentType,
            content: file.content,
          })),
        }
      : {}),
  })
    .compile()
    .build();

  // MailComposer also stamps `Date` and a `Message-ID`, which the hand-rolled
  // encoder omitted. Both are DISCARDED by Gmail, which substitutes its own
  // (`@mail.gmail.com`) plus the account's `From:` — verified against the live
  // API, not assumed — so there is nothing to suppress and no `@localhost`
  // Message-ID can reach a recipient.
  return { raw: built.toString('base64url'), to, subject, threadId };
}

/** Gmail rejects the whole request past ~35MB base64; cap the raw bytes well under it. */
const GMAIL_ATTACHMENT_MAX_FILES = 10;
const GMAIL_ATTACHMENT_MAX_TOTAL_BYTES = 20 * 1024 * 1024;

function normalizeGmailAttachments(
  input: readonly GoogleGmailAttachment[] | undefined,
): GoogleGmailAttachment[] {
  if (!input?.length) return [];
  if (input.length > GMAIL_ATTACHMENT_MAX_FILES) {
    throw new Error('google_gmail_draft_attachments_too_many');
  }
  let total = 0;
  const normalized = input.map((file) => {
    const filename = safeHeader(String(file?.filename ?? ''), 'attachment_filename', 255);
    // A quote or semicolon would break out of the filename parameter it sits in.
    if (/["\\;]/.test(filename)) throw new Error('google_gmail_draft_attachment_filename_invalid');
    const contentType = safeHeader(String(file?.contentType ?? ''), 'attachment_content_type', 255);
    if (!/^[\w.+-]+\/[\w.+-]+$/.test(contentType)) {
      throw new Error('google_gmail_draft_attachment_content_type_invalid');
    }
    if (!Buffer.isBuffer(file?.content) || !file.content.length) {
      throw new Error('google_gmail_draft_attachment_content_invalid');
    }
    total += file.content.length;
    return { filename, contentType, content: file.content };
  });
  if (total > GMAIL_ATTACHMENT_MAX_TOTAL_BYTES) {
    throw new Error('google_gmail_draft_attachments_too_large');
  }
  return normalized;
}

/**
 * Create one RFC 2822 draft; this seam never sends the message.
 *
 * Reply-shaped when `threadId`/`inReplyTo` are present, create-shaped when they
 * are not — the same two shapes `sendGoogleGmailMessage` already shares, so a
 * draft and a send of the same message are assembled identically and cannot
 * drift apart. The reply shape keeps its thread assertions: the caller asked
 * for a specific thread, so Gmail answering with a DIFFERENT one is a silent
 * mis-threading and stays an error. A create-shaped draft has no requested
 * thread to compare against — Gmail mints one — so there is nothing to assert
 * and asserting anyway is what made this seam reply-only.
 *
 * D-020: like the send seam, this performs NEITHER addressee rail. A caller
 * reaching it must already have resolved the destination from a stored
 * canonical object (rail 1) or cleared assertTrustedAddressee (rail 2).
 */
export async function createGoogleGmailDraft(
  accessToken: string,
  input: GoogleGmailOutboundInput,
  provided: Pick<GoogleGmailDeps, 'fetch' | 'apiOrigin'> = {},
): Promise<GoogleGmailDraftResult> {
  const token = accessToken.trim();
  if (!token) throw new Error('google_gmail_access_token_required');
  const encoded = await buildGoogleGmailRawMessage(input);
  const threadId = encoded.threadId;
  const raw = encoded.raw;
  const body = await gmailRequest<gmail_v1.Schema$Draft>(
    provided.fetch ?? fetch,
    (provided.apiOrigin ?? GMAIL_API_ORIGIN).replace(/\/$/, ''),
    token,
    '/gmail/v1/users/me/drafts',
    'draft_create',
    {
      method: 'POST',
      body: { message: threadId ? { raw, threadId } : { raw } },
    },
  );
  const draftId = nonEmpty(body.id);
  const messageId = nonEmpty(body.message?.id);
  const createdThreadId = nonEmpty(body.message?.threadId);
  if (!draftId || !messageId || !createdThreadId) throw new Error('google_gmail_draft_response_invalid');
  if (threadId && createdThreadId !== threadId) throw new Error('google_gmail_draft_thread_mismatch');
  return { draftId, messageId, threadId: createdThreadId };
}

/**
 * Revise ONE existing draft IN PLACE, preserving its draft id and its position
 * in the mailbox. `PUT /drafts/{id}` replaces the draft's message wholesale, so
 * the caller supplies the complete new content exactly as it would for a create.
 *
 * WHY THIS EXISTS (WI-10001658): without it, "revise a draft" has only one
 * implementation — delete the draft and create a replacement — which destroys
 * owner data (every draft id, and anything the owner has since typed into it)
 * to perform what the API models as an edit. There is deliberately no delete
 * seam in this module; if you are reaching for one to implement an edit, use
 * this instead.
 *
 * Encoding is shared with create via `buildGoogleGmailRawMessage`, so a draft
 * updated with `attachments` present gains them through the same
 * `multipart/mixed` branch — there is no separate attachment path to keep in
 * sync.
 *
 * D-020: like create and send, this performs NEITHER addressee rail. A caller
 * reaching it must already have resolved the destination from a stored
 * canonical object (rail 1) or cleared assertTrustedAddressee (rail 2).
 */
export async function updateGoogleGmailDraft(
  accessToken: string,
  draftId: string,
  input: GoogleGmailOutboundInput,
  provided: Pick<GoogleGmailDeps, 'fetch' | 'apiOrigin'> = {},
): Promise<GoogleGmailDraftResult> {
  const token = accessToken.trim();
  if (!token) throw new Error('google_gmail_access_token_required');
  const targetDraftId = draftId.trim();
  if (!targetDraftId) throw new Error('google_gmail_draft_id_required');
  const encoded = await buildGoogleGmailRawMessage(input);
  const threadId = encoded.threadId;
  const raw = encoded.raw;
  const body = await gmailRequest<gmail_v1.Schema$Draft>(
    provided.fetch ?? fetch,
    (provided.apiOrigin ?? GMAIL_API_ORIGIN).replace(/\/$/, ''),
    token,
    `/gmail/v1/users/me/drafts/${encodeURIComponent(targetDraftId)}`,
    'draft_update',
    {
      method: 'PUT',
      body: {
        id: targetDraftId,
        message: threadId ? { raw, threadId } : { raw },
      },
    },
  );
  const updatedDraftId = nonEmpty(body.id);
  const messageId = nonEmpty(body.message?.id);
  const updatedThreadId = nonEmpty(body.message?.threadId);
  if (!updatedDraftId || !messageId || !updatedThreadId) throw new Error('google_gmail_draft_response_invalid');
  // The in-place guarantee is the reason this seam exists: a response naming a
  // DIFFERENT draft means the API created one rather than revising ours, and
  // the original is still sitting in the mailbox unedited. Fail loudly instead
  // of returning a plausible-looking result for the wrong draft.
  if (updatedDraftId !== targetDraftId) throw new Error('google_gmail_draft_id_mismatch');
  if (threadId && updatedThreadId !== threadId) throw new Error('google_gmail_draft_thread_mismatch');
  return { draftId: updatedDraftId, messageId, threadId: updatedThreadId };
}

/**
 * Send an EXISTING draft, by id (WI-10001668).
 *
 * The distinction from `sendGoogleGmailMessage` is the whole point, not a
 * convenience: that one COMPOSES a fresh message from a `GoogleGmailOutboundInput`
 * and re-encodes the MIME. This one hands Gmail a draft id and sends the bytes
 * already sitting in the mailbox. So when a human has REVIEWED and approved a
 * draft, this is the only path that sends the artifact they actually approved —
 * re-composing it means the reviewed text and the sent text are two different
 * objects that merely ought to agree, and any encoder change between review and
 * send silently sends something else. It also consumes the draft rather than
 * leaving an orphan sitting beside a near-identical sent message.
 *
 * Deliberately takes no `GoogleGmailOutboundInput`: there is nothing to encode,
 * and accepting one would invite exactly the re-composition this exists to avoid.
 */
export async function sendGoogleGmailDraft(
  accessToken: string,
  draftId: string,
  provided: Pick<GoogleGmailDeps, 'fetch' | 'apiOrigin'> = {},
): Promise<GoogleGmailSendResult> {
  const token = accessToken.trim();
  if (!token) throw new Error('google_gmail_access_token_required');
  const targetDraftId = draftId.trim();
  if (!targetDraftId) throw new Error('google_gmail_draft_id_required');
  const body = await gmailRequest<gmail_v1.Schema$Message>(
    provided.fetch ?? fetch,
    (provided.apiOrigin ?? GMAIL_API_ORIGIN).replace(/\/$/, ''),
    token,
    '/gmail/v1/users/me/drafts/send',
    'draft_send',
    { method: 'POST', body: { id: targetDraftId } },
  );
  const messageId = nonEmpty(body.id);
  const threadId = nonEmpty(body.threadId);
  // A 2xx carrying no message id is the shape that would let a caller record a
  // send that may not have happened. Refuse it rather than return a half-result.
  if (!messageId || !threadId) throw new Error('google_gmail_draft_send_response_invalid');
  return { messageId, threadId };
}

/** The addressees a stored draft ACTUALLY carries, normalized and lowercased. */
export interface GoogleGmailDraftRecipients {
  to: string[];
  cc: string[];
  subject: string | null;
}

/**
 * Split an RFC-5322 address list on the commas that SEPARATE addresses, not on
 * the ones inside a quoted display name or an angle-addr.
 *
 * `"Weiss, owner" <owner@example.com>` is one recipient. A naive `.split(',')` reads
 * it as two, and both halves then fail to parse as addresses — so a caller
 * comparing against its expected set sees a mismatch that is purely an artifact
 * of the parser, on precisely the personal-name format most likely to appear in
 * a real mailbox.
 */
function splitAddressList(value: string): string[] {
  const out: string[] = [];
  let buf = '';
  let inQuotes = false;
  let inAngle = false;
  for (const ch of value) {
    if (ch === '"' && !inAngle) inQuotes = !inQuotes;
    else if (ch === '<' && !inQuotes) inAngle = true;
    else if (ch === '>' && !inQuotes) inAngle = false;
    else if (ch === ',' && !inQuotes && !inAngle) {
      out.push(buf);
      buf = '';
      continue;
    }
    buf += ch;
  }
  out.push(buf);
  return out.map((entry) => entry.trim()).filter(Boolean);
}

/** `Name <a@b.com>` / `a@b.com` → `a@b.com`; anything without an `@` → null. */
function extractAddress(entry: string): string | null {
  const angle = /<([^>]*)>/.exec(entry);
  const raw = (angle ? angle[1] : entry).trim().toLowerCase();
  return raw.includes('@') ? raw : null;
}

function headerValue(headers: readonly GoogleGmailHeader[], name: string): string {
  const lower = name.toLowerCase();
  return headers.find((header) => (header.name ?? '').toLowerCase() === lower)?.value ?? '';
}

/**
 * Read the addressees a draft currently holds, straight from Gmail.
 *
 * This exists because `drafts/send` sends WHAT GMAIL HOLDS, not what the caller
 * believes it holds. Between a draft being created (rails run, recipients
 * cleared) and being sent, the draft is editable — by the owner in their own
 * client, by any other process with the token. So an addressee check run only
 * at draft time proves nothing about the send: it judged bytes that may no
 * longer exist. The only way to judge what will actually leave the mailbox is
 * to read it back immediately before sending, which is what this returns.
 *
 * `format=metadata` keeps the response to headers — the body is not needed to
 * decide who a message is addressed to, and not fetching it means a large
 * attachment does not have to cross the wire to answer that question.
 */
export async function readGoogleGmailDraftRecipients(
  accessToken: string,
  draftId: string,
  provided: Pick<GoogleGmailDeps, 'fetch' | 'apiOrigin'> = {},
): Promise<GoogleGmailDraftRecipients> {
  const token = accessToken.trim();
  if (!token) throw new Error('google_gmail_access_token_required');
  const targetDraftId = draftId.trim();
  if (!targetDraftId) throw new Error('google_gmail_draft_id_required');
  const params = new URLSearchParams({ format: 'metadata' });
  for (const header of ['To', 'Cc', 'Subject']) params.append('metadataHeaders', header);
  const body = await gmailRequest<gmail_v1.Schema$Draft>(
    provided.fetch ?? fetch,
    (provided.apiOrigin ?? GMAIL_API_ORIGIN).replace(/\/$/, ''),
    token,
    `/gmail/v1/users/me/drafts/${encodeURIComponent(targetDraftId)}`,
    'draft_get',
    { params },
  );
  const headers = body.message?.payload?.headers ?? [];
  // A draft that came back carrying NO headers at all is an unreadable answer,
  // not a draft addressed to nobody. Returning empty would read to a caller as
  // "this draft has no recipients", and the safest-looking reaction to that —
  // treating an empty set as nothing to check — is exactly wrong.
  if (!Array.isArray(headers) || headers.length === 0) {
    throw new Error('google_gmail_draft_headers_unreadable');
  }
  const parse = (name: string): string[] => {
    const value = headerValue(headers, name);
    if (!value.trim()) return [];
    return splitAddressList(value)
      .map(extractAddress)
      .filter((address): address is string => Boolean(address));
  };
  const subject = headerValue(headers, 'Subject').trim();
  return { to: parse('To'), cc: parse('Cc'), subject: subject || null };
}

/**
 * Send one message. Reply-shaped when `threadId`/`inReplyTo` are present,
 * create-shaped when they are not.
 *
 * D-020: reaching this seam means the destination was either server-resolved
 * from a stored canonical object (rail 1) or cleared the trusted-addressee
 * check (rail 2). This function performs NEITHER check — it is the transport,
 * and calling it directly from a tool handler would bypass both rails.
 */
export async function sendGoogleGmailMessage(
  accessToken: string,
  input: GoogleGmailOutboundInput,
  provided: Pick<GoogleGmailDeps, 'fetch' | 'apiOrigin'> = {},
): Promise<GoogleGmailSendResult> {
  const token = accessToken.trim();
  if (!token) throw new Error('google_gmail_access_token_required');
  const encoded = await buildGoogleGmailRawMessage(input);
  const body = await gmailRequest<gmail_v1.Schema$Message>(
    provided.fetch ?? fetch,
    (provided.apiOrigin ?? GMAIL_API_ORIGIN).replace(/\/$/, ''),
    token,
    '/gmail/v1/users/me/messages/send',
    'message_send',
    {
      method: 'POST',
      body: encoded.threadId ? { raw: encoded.raw, threadId: encoded.threadId } : { raw: encoded.raw },
    },
  );
  const messageId = nonEmpty(body.id);
  const threadId = nonEmpty(body.threadId);
  if (!messageId || !threadId) throw new Error('google_gmail_send_response_invalid');
  if (encoded.threadId && threadId !== encoded.threadId) {
    throw new Error('google_gmail_send_thread_mismatch');
  }
  return { messageId, threadId };
}

/** Decode the Gmail JSON envelope carried in Pub/Sub message.data. */
export function decodeGoogleGmailNotification(
  data: string | undefined,
): { emailAddress: string; historyId: string | null } | null {
  const decoded = decodeBase64Url(data);
  if (!decoded) return null;
  try {
    const parsed = JSON.parse(decoded) as { emailAddress?: unknown; historyId?: unknown };
    const emailAddress = nonEmpty(parsed.emailAddress);
    if (!emailAddress) return null;
    return { emailAddress, historyId: nonEmpty(parsed.historyId) };
  } catch {
    return null;
  }
}

/**
 * A listed message can be deleted (a discarded draft, purged spam) before it
 * is fetched. That is a fact about ONE message, never about the mailbox
 * cursor: skip it — dedupe keys make a later re-list harmless.
 */
async function getMessageIfPresent(
  fetchImpl: typeof fetch,
  apiOrigin: string,
  accessToken: string,
  messageId: string,
): Promise<GoogleGmailMessage | null> {
  try {
    return await getMessage(fetchImpl, apiOrigin, accessToken, messageId);
  } catch (cause) {
    if (isGoogleGmailMessageGoneError(cause)) return null;
    throw cause;
  }
}

async function getMessage(
  fetchImpl: typeof fetch,
  apiOrigin: string,
  accessToken: string,
  messageId: string,
): Promise<GoogleGmailMessage> {
  const params = new URLSearchParams({ format: 'full' });
  return gmailRequest<GoogleGmailMessage>(
    fetchImpl,
    apiOrigin,
    accessToken,
    `/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}`,
    'message_get',
    { params },
  );
}

async function deliver(
  sql: postgres.Sql,
  ingest: Ingest,
  sinks: IngestSink[],
  source: ExternalTriggerSourceRow,
  message: GoogleGmailMessage,
): Promise<void> {
  const id = nonEmpty(message.id);
  if (!id) throw new Error('google_gmail_message_id_required');
  const normalized = normalizeGoogleGmailMessage(message);
  const result = await ingest(sql, {
    workspaceId: source.workspaceId,
    sourceId: source.id,
    source: 'gmail',
    event: 'message.received',
    externalId: id,
    datatypeId: 'email-message',
    adapterPayload: message,
    normalize: () => normalized,
    occurredAt: nonEmpty(normalized.occurredAt),
    dedupeKey: `gmail:${id}:message.received`,
    additionalSinks: [...sinks],
  });
  if (!result.ok) throw new Error(`google_gmail_delivery_failed:${id}`);
}

async function incrementalSync(
  sql: postgres.Sql,
  source: ExternalTriggerSourceRow,
  accessToken: string,
  startHistoryId: string,
  sinks: IngestSink[],
  deps: Required<Pick<GoogleGmailDeps, 'fetch' | 'apiOrigin' | 'ingest'>>,
  budget: number,
  persistCursor: (historyId: string, pending: { historyId: string; messageIds: string[] } | null) => Promise<void>,
): Promise<{ messages: number; gone: number; pages: number; historyId: string; complete: boolean }> {
  let pageToken: string | null = null;
  let pages = 0;
  let gone = 0;
  let nextHistoryId: string | null = null;
  let cursorHistoryId = startHistoryId;
  let fetchedCount = 0;
  const delivered = new Set<string>();
  const rawPending = source.cursor.incrementalPending;
  const pending = rawPending && typeof rawPending === 'object'
    ? rawPending as { historyId?: unknown; messageIds?: unknown }
    : null;
  const pendingHistoryId = nonEmpty(pending?.historyId);
  const pendingIds = pendingHistoryId && Array.isArray(pending?.messageIds)
    ? new Set(pending.messageIds.filter((id): id is string => typeof id === 'string'))
    : new Set<string>();
  do {
    if (++pages > MAX_PAGES) throw new Error('google_gmail_history_page_limit_exceeded');
    const params = new URLSearchParams({
      startHistoryId,
      historyTypes: 'messageAdded',
      maxResults: '500',
    });
    if (pageToken) params.set('pageToken', pageToken);
    const body = await gmailRequest<GoogleGmailHistoryResponse>(
      deps.fetch,
      deps.apiOrigin,
      accessToken,
      '/gmail/v1/users/me/history',
      'history_list',
      { params },
    );
    for (const history of body.history ?? []) {
      const recordId = nonEmpty(history.id);
      if (!recordId) throw new Error('google_gmail_history_record_id_missing');
      const processed = recordId === pendingHistoryId ? new Set(pendingIds) : new Set<string>();
      for (const added of history.messagesAdded ?? []) {
        const id = nonEmpty(added.message?.id);
        if (!id || processed.has(id) || delivered.has(id)) continue;
        if (fetchedCount >= budget) return { messages: delivered.size, gone, pages, historyId: cursorHistoryId, complete: false };
        const fetched = await getMessageIfPresent(deps.fetch, deps.apiOrigin, accessToken, id);
        fetchedCount += 1;
        if (!fetched) {
          gone += 1;
        } else {
          await deliver(sql, deps.ingest, sinks, source, fetched);
          delivered.add(id);
        }
        processed.add(id);
        // A record can contain more messages than one quota-safe chunk. Persist
        // the completed IDs so a restart or quota error does not re-fetch them.
        if (recordId) await persistCursor(cursorHistoryId, { historyId: recordId, messageIds: [...processed] });
      }
      if (recordId) {
        cursorHistoryId = recordId;
        await persistCursor(cursorHistoryId, null);
      }
    }
    nextHistoryId = nonEmpty(body.historyId) ?? nextHistoryId;
    pageToken = nonEmpty(body.nextPageToken);
    if (fetchedCount >= budget && pageToken) return { messages: delivered.size, gone, pages, historyId: cursorHistoryId, complete: false };
  } while (pageToken);
  if (!nextHistoryId) throw new Error('google_gmail_next_history_id_missing');
  return { messages: delivered.size, gone, pages, historyId: nextHistoryId, complete: true };
}

function newBackfillState(now: Date): GoogleGmailBackfillState {
  return {
    status: 'pending',
    pageToken: null,
    pages: 0,
    messages: 0,
    startedAt: now.toISOString(),
    completedAt: null,
    throttledUntil: null,
    throttleCount: 0,
  };
}

/**
 * Walk at most `budget` historical messages (newest first, as messages.list
 * orders them), checkpointing the continuation token after every page so an
 * interrupted walk resumes where it stopped instead of restarting from zero.
 * Quota exhaustion parks the walk with an exponential cool-down; delivery is
 * dedupe-keyed, so re-listing a partially delivered page is harmless.
 */
async function backfillChunk(
  sql: postgres.Sql,
  source: ExternalTriggerSourceRow,
  accessToken: string,
  sinks: IngestSink[],
  deps: Required<Pick<GoogleGmailDeps, 'fetch' | 'apiOrigin' | 'ingest'>>,
  updateSource: typeof updateExternalTriggerSourceSyncState,
  initial: GoogleGmailBackfillState,
  budget: number,
  now: Date,
): Promise<{ messages: number; gone: number; pages: number; state: GoogleGmailBackfillState; source: ExternalTriggerSourceRow }> {
  let state: GoogleGmailBackfillState = { ...initial, status: 'pending', throttledUntil: null };
  let workingSource = source;
  let messages = 0;
  let gone = 0;
  let pages = 0;
  const pageSize = Math.min(budget, BACKFILL_LIST_PAGE_SIZE, MAX_LIST_PAGE_SIZE);
  const persist = async (next: GoogleGmailBackfillState): Promise<void> => {
    state = next;
    workingSource = await updateSource(sql, source.workspaceId, source.id, {
      status: 'connecting',
      cursor: { ...workingSource.cursor, backfill: next },
      lastError: null,
    });
  };
  while (messages < budget) {
    if (state.pages + 1 > MAX_PAGES) throw new Error('google_gmail_message_page_limit_exceeded');
    const params = new URLSearchParams({ maxResults: String(pageSize) });
    if (state.pageToken) params.set('pageToken', state.pageToken);
    let delivered = 0;
    let nextPageToken: string | null = null;
    try {
      const body = await gmailRequest<GoogleGmailMessagesListResponse>(
        deps.fetch,
        deps.apiOrigin,
        accessToken,
        '/gmail/v1/users/me/messages',
        'messages_list',
        { params },
      );
      for (const listed of body.messages ?? []) {
        const id = nonEmpty(listed.id);
        if (!id) continue;
        const fetched = await getMessageIfPresent(deps.fetch, deps.apiOrigin, accessToken, id);
        if (!fetched) {
          gone += 1;
          continue;
        }
        await deliver(sql, deps.ingest, sinks, source, fetched);
        delivered += 1;
      }
      nextPageToken = nonEmpty(body.nextPageToken);
    } catch (cause) {
      if (!isGoogleGmailQuotaError(cause)) throw cause;
      await persist(throttledBackfillState(state, now, state.messages + delivered));
      return { messages: messages + delivered, gone, pages, state, source: workingSource };
    }
    messages += delivered;
    pages += 1;
    const complete = nextPageToken === null;
    await persist({
      ...state,
      status: complete ? 'complete' : 'pending',
      pageToken: nextPageToken,
      pages: state.pages + 1,
      messages: state.messages + delivered,
      completedAt: complete ? now.toISOString() : null,
      throttleCount: 0,
    });
    if (complete) break;
  }
  return { messages, gone, pages, state, source: workingSource };
}

/**
 * Reconcile one owned source: replay history since the stored cursor, bootstrap
 * a cursorless mailbox onto its profile historyId, then advance the resumable
 * backfill by one budgeted chunk. The history cursor commits only after every
 * delivery of the incremental pass succeeds.
 */
export async function syncGoogleGmailSource(
  sql: postgres.Sql,
  source: ExternalTriggerSourceRow,
  accessToken: string,
  provided: GoogleGmailDeps = {},
): Promise<GoogleGmailSyncResult> {
  assertSource(source, accessToken);
  const budgetCeiling = backfillBudget(provided.backfillMessagesPerSync);
  const deps = {
    fetch: provided.fetch ?? fetch,
    apiOrigin: (provided.apiOrigin ?? GMAIL_API_ORIGIN).replace(/\/$/, ''),
    ingest: provided.ingest ?? ((db, event) => ingestExternalTriggerEvent(db, event)),
  };
  const updateSource = provided.updateSource ?? updateExternalTriggerSourceSyncState;
  const createSink = provided.createPersonalSink ?? createPersonalVaultExternalSinkForSource;
  const sink = await createSink(sql, source.workspaceId, source.id);
  // P-011: deliver into the Email app as messages land, but only where an owner
  // mapping configures it. Resolved ONCE per sync, not per message.
  const createAppSink = provided.createAppSink
    ?? ((db: postgres.Sql, workspaceId: string, sourceId: string) =>
      createAppDeliverySinkIfConfigured(db, workspaceId, sourceId, 'email', {
        // P-007: the gate swallows its own errors to protect the sync (D-013),
        // so without this a registration fault is invisible everywhere.
        onGateError: reportAppSinkGateError,
      }));
  const appSink = await createAppSink(sql, source.workspaceId, source.id);
  const sinks: IngestSink[] = appSink ? [sink, appSink] : [sink];
  const now = (provided.now ?? (() => new Date()))();
  if (!Number.isFinite(now.getTime())) throw new Error('google_gmail_now_invalid');
  let workingSource = source;
  let historyId = googleGmailSourceHistoryId(source);
  let mode: GoogleGmailSyncResult['mode'] = historyId ? 'incremental' : 'full';
  let resyncReason: GoogleGmailResyncReason | null = null;
  let messages = 0;
  let messagesGone = 0;
  let historyPages = 0;
  let messagePages = 0;
  let incrementalPending = false;

  if (historyId) {
    try {
      const synced = await incrementalSync(
        sql, source, accessToken, historyId, sinks, deps,
        Math.min(budgetCeiling, MIN_BACKFILL_MESSAGES_PER_SYNC),
        async (nextHistoryId, pending) => {
          const cursor: Record<string, unknown> = { ...workingSource.cursor, historyId: nextHistoryId };
          if (pending) cursor.incrementalPending = pending;
          else delete cursor.incrementalPending;
          workingSource = await updateSource(sql, source.workspaceId, source.id, {
            status: 'connected', cursor, lastError: null, connected: true,
          });
        },
      );
      messages = synced.messages;
      messagesGone = synced.gone;
      historyPages = synced.pages;
      historyId = synced.historyId;
      incrementalPending = !synced.complete;
    } catch (cause) {
      // ONLY history.list itself saying the cursor is too old justifies the
      // full re-bootstrap below (which discards the resumable backfill). A 404
      // from any other call — messages.get for a message deleted between the
      // history page and its fetch — used to land here too and restarted the
      // backfill from zero every few minutes (EI-23429618437235533).
      // A quota 403 is different: it does not invalidate the history cursor,
      // but it must park an active backfill as well. Otherwise this throws to
      // the poll action before backfillChunk can persist its cooldown, and the
      // next poll retries the same full-size chunk against the exhausted quota.
      if (isGoogleGmailQuotaError(cause)) {
        const throttleCount = nonNegativeInteger(workingSource.cursor.incrementalThrottleCount) + 1;
        workingSource = await updateSource(sql, source.workspaceId, source.id, {
          status: 'connected',
          cursor: {
            ...workingSource.cursor,
            incrementalMore: true,
            incrementalThrottleCount: throttleCount,
            incrementalThrottledUntil: new Date(now.getTime() + backfillThrottleMs(throttleCount - 1)).toISOString(),
          },
          lastError: null,
          connected: true,
        });
        const backfill = googleGmailBackfillState(workingSource);
        if (backfill && backfill.status !== 'complete') {
          const throttled = throttledBackfillState(backfill, now);
          workingSource = await updateSource(sql, source.workspaceId, source.id, {
            status: 'connected',
            cursor: { ...workingSource.cursor, backfill: throttled },
            lastError: null,
            connected: true,
          });
        }
        throw cause;
      }
      if (!isGoogleGmailHistoryExpiredError(cause)) throw cause;
      // The guard above is the type narrowing: it only passes a GoogleGmailApiError.
      const expired = cause as GoogleGmailApiError;
      resyncReason = { operation: expired.operation, status: expired.status };
      const clearedCursor = cursorWithoutHistory(source.cursor);
      workingSource = await updateSource(sql, source.workspaceId, source.id, {
        status: 'connecting',
        cursor: clearedCursor,
        lastError: null,
      });
      historyId = null;
      mode = 'full';
    }
  }

  if (!historyId) {
    // Pin the incremental cursor BEFORE any historical walk: from here on new
    // mail is replayed via history and the watch can be established, while the
    // backfill below is free to take as many polls as the quota allows.
    const mailbox = await profile(deps.fetch, deps.apiOrigin, accessToken);
    historyId = mailbox.historyId;
    workingSource = await updateSource(sql, source.workspaceId, source.id, {
      status: 'connecting',
      cursor: {
        ...workingSource.cursor,
        emailAddress: mailbox.emailAddress,
        historyId,
        backfill: newBackfillState(now),
      },
      lastError: null,
    });
  }

  let backfill = googleGmailBackfillState(workingSource);
  if (!incrementalPending && backfill && backfill.status !== 'complete') {
    if (!googleGmailBackfillParked(workingSource, now)) {
      // A mailbox that just tripped its quota walks a smaller chunk this time;
      // the ceiling comes back once a chunk completes cleanly.
      const budget = googleGmailBackfillBudget(budgetCeiling, backfill.throttleCount);
      const chunk = await backfillChunk(sql, workingSource, accessToken, sinks, deps, updateSource, backfill, budget, now);
      messages += chunk.messages;
      messagesGone += chunk.gone;
      messagePages += chunk.pages;
      backfill = chunk.state;
      workingSource = chunk.source;
    }
  }

  const cursor: Record<string, unknown> = {
    ...workingSource.cursor,
    historyId,
  };
  if (incrementalPending) cursor.incrementalMore = true;
  else {
    delete cursor.incrementalMore;
    cursor.lastSyncAt = now.toISOString();
    delete cursor.incrementalThrottledUntil;
    delete cursor.incrementalThrottleCount;
  }
  await updateSource(sql, source.workspaceId, source.id, {
    status: 'connected',
    cursor,
    lastError: null,
    connected: true,
  });
  return {
    mode, messages, messagesGone, resyncReason, historyPages, messagePages, historyId, backfill,
    ...(incrementalPending ? { incrementalPending: true } : {}),
  };
}
