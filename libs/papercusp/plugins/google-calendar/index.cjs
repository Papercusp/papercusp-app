'use strict';
/**
 * Google Calendar provider (plan generalized-integrations-google-migration-cupboard-workflows-2026-10-05,
 * P-009 / D-021).
 *
 * A first-party calendar provider on the integration provider contract. The host's connector
 * driver calls `syncPage` and owns everything stateful (lease, cursor commit, dedupe, retry,
 * routing); the outbound calendar verbs call `invoke`. This module only maps the Calendar REST API:
 *   - a calendar event -> `calendar-event`, events `event-created` / `event-updated` (changes) and
 *     `event-upcoming` (the time wheel), nativeId = the Google event id
 *   - calendar.read -> one event; calendar.write (create | update) -> events insert / patch
 *   - sync.adopt -> start a source the retired host Calendar poll drove from that poll's cursor
 *
 * The only network path is `host.fetch`, which carries the source account's token. Nothing here
 * sees a credential, imports host code, or writes a table.
 *
 * Cursor: one opaque JSON string
 *   `{ v, phase, syncToken, pageToken, lastSyncAt, changesStartedAt,
 *      upcoming: { pageToken, windowStart }, legacyUpcoming: { from } | null }`.
 * Each `syncPage` reads ONE events.list page. The `changes` phase pages events.list (showDeleted)
 * from the sync token until Google returns the next one; then the `upcoming` phase pages the
 * single-event window [windowStart, windowStart + lead) and the pass ends. Versions are namespaced
 * (`change:<updated|etag|sequence-N>`, `upcoming:<start>`) because the host's delivery key carries
 * no event name: a full resync re-reads every event at the SAME version and is deduped (D-021.3).
 */
const manifest = require('./papercusp.json');

const DESCRIPTOR = manifest.provider;
const API = 'https://www.googleapis.com/calendar/v3';
const DATATYPE = 'calendar-event';
const PAGE_SIZE = 2500;
const DEFAULT_LEAD_MINUTES = 15;
const MAX_LEAD_MINUTES = 24 * 60;
const DEFAULT_RETRY_AFTER_SECONDS = 60;
const RATE_LIMIT_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'quotaExceeded', 'dailyLimitExceeded']);

/* ─── small helpers ─── */

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function syncError(kind, message, extra) {
  return Object.assign(new Error(message), { kind }, extra || {});
}

function lowerHeaders(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers || {})) out[name.toLowerCase()] = value;
  return out;
}

function bodyText(response) {
  return response.bodyEncoding === 'base64' ? Buffer.from(response.body || '', 'base64').toString('utf8') : response.body || '';
}

function query(params) {
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(name, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

function isoOrNull(value) {
  const raw = nonEmpty(value);
  if (!raw) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

const enc = (value) => encodeURIComponent(String(value));

/* ─── HTTP through host.fetch ─── */

function errorDetail(json) {
  const error = json && json.error && typeof json.error === 'object' ? json.error : {};
  const reasons = (Array.isArray(error.errors) ? error.errors : [])
    .map((entry) => entry && entry.reason)
    .filter((reason) => typeof reason === 'string');
  const message = typeof error.message === 'string' ? error.message : '';
  return { reasons, message };
}

/**
 * One Calendar call. Failures map to the host's sync signals (D-021.4): 429 and quota or
 * rate-limit 403s are `rate-limited`, other 401/403s are `auth`, a 410 (sync or page token no
 * longer valid) is `cursor-expired`, 5xx and anything else unexpected is `transient`. A 404
 * carries `notFound`. Writes are never retried here: a 5xx on a write is ambiguous, and every
 * write carries sendUpdates=all, so a replay would re-invite real people.
 */
async function call(host, source, op, url, options) {
  const opts = options || {};
  const request = { url, method: opts.method || 'GET', headers: { accept: 'application/json' } };
  if (opts.body !== undefined) {
    request.headers['content-type'] = 'application/json';
    request.body = JSON.stringify(opts.body);
  }
  const response = await host.fetch({ source, request });
  const status = Number(response.status);
  const raw = bodyText(response);
  let json = null;
  if (raw) {
    try {
      json = JSON.parse(raw);
    } catch {
      json = null;
    }
  }
  if (status >= 200 && status < 300) {
    if (raw && json === null) throw syncError('transient', `google_calendar_${op}_body_not_json`, { status, op });
    return json || {};
  }
  const headers = lowerHeaders(response.headers);
  const { reasons, message } = errorDetail(json);
  const detail = `google_calendar_${op}_http_${status}${message ? `: ${message.slice(0, 300)}` : ''}`;
  const rateLimited = status === 429
    || (status === 403 && (reasons.some((reason) => RATE_LIMIT_REASONS.has(reason))
      || /quota|rate ?limit|usage ?limit|too many/i.test(message)));
  if (rateLimited) {
    const retryAfter = Number(headers['retry-after']);
    const retryAfterSeconds = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : DEFAULT_RETRY_AFTER_SECONDS;
    throw syncError('rate-limited', detail, { retryAfterSeconds, status, op });
  }
  if (status === 401 || status === 403) throw syncError('auth', detail, { status, op });
  if (status === 410) throw syncError('cursor-expired', detail, { status, op });
  if (status === 404) throw syncError('transient', detail, { status, op, notFound: true });
  throw syncError('transient', detail, { status, op });
}

function eventsUrl(calendarId, suffix) {
  return `${API}/calendars/${enc(calendarId)}/events${suffix || ''}`;
}

/* ─── mapping: Google event -> canonical calendar-event ─── */

function calendarDate(value) {
  return nonEmpty(value && value.dateTime) || nonEmpty(value && value.date);
}

function appendDefined(target, key, value) {
  if (value !== undefined && value !== null && value !== '') target[key] = value;
}

/**
 * The canonical calendar-event payload. The fields and their rules are exactly the former host
 * normalizer's (`normalizeGoogleCalendarEvent`): id, summary, description, organizer (email, else
 * display name), attendees, start/end (dateTime, else all-day date), location, status, htmlLink,
 * created, updated, recurringEventId, originalStart, sequence, attachments, conferenceData.
 */
function normalizeEvent(event) {
  const id = nonEmpty(event && event.id);
  if (!id) throw syncError('transient', 'google_calendar_event_id_required');
  const normalized = { id };
  appendDefined(normalized, 'summary', event.summary);
  appendDefined(normalized, 'description', event.description);
  const organizer = event.organizer || {};
  appendDefined(normalized, 'organizer', organizer.email || organizer.displayName);
  if (Array.isArray(event.attendees)) {
    normalized.attendees = event.attendees.map((attendee) => {
      const entry = {};
      if (attendee && attendee.email) entry.email = attendee.email;
      if (attendee && attendee.displayName) entry.displayName = attendee.displayName;
      if (attendee && attendee.responseStatus) entry.responseStatus = attendee.responseStatus;
      if (attendee && attendee.self !== undefined) entry.self = attendee.self;
      return entry;
    });
  }
  appendDefined(normalized, 'start', calendarDate(event.start));
  appendDefined(normalized, 'end', calendarDate(event.end));
  appendDefined(normalized, 'location', event.location);
  appendDefined(normalized, 'status', event.status);
  appendDefined(normalized, 'htmlLink', event.htmlLink);
  appendDefined(normalized, 'created', event.created);
  appendDefined(normalized, 'updated', event.updated);
  appendDefined(normalized, 'recurringEventId', event.recurringEventId);
  appendDefined(normalized, 'originalStart', calendarDate(event.originalStartTime));
  appendDefined(normalized, 'sequence', event.sequence);
  appendDefined(normalized, 'attachments', event.attachments);
  appendDefined(normalized, 'conferenceData', event.conferenceData);
  return normalized;
}

/** The legacy event version: updated, else etag, else the sequence number. */
function eventVersion(event) {
  return nonEmpty(event.updated)
    || nonEmpty(event.etag)
    || `sequence-${Number.isInteger(event.sequence) ? event.sequence : 0}`;
}

function eventRecord(event, eventName, version) {
  const payload = normalizeEvent(event);
  const record = { datatype: DATATYPE, nativeId: payload.id, event: eventName, payload, version };
  const occurredAt = calendarDate(event.start) || nonEmpty(event.updated) || nonEmpty(event.created);
  if (occurredAt) record.occurredAt = occurredAt;
  return record;
}

/* ─── config ─── */

function leadMinutes(config) {
  const raw = config.leadMinutes !== undefined ? config.leadMinutes : config.lead_minutes;
  const parsed = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(MAX_LEAD_MINUTES, parsed) : DEFAULT_LEAD_MINUTES;
}

function calendarIdOf(config) {
  return nonEmpty(config.calendarId) || nonEmpty(config.calendar_id) || 'primary';
}

/* ─── cursor ─── */

function freshCursor() {
  return {
    v: 1,
    phase: 'changes',
    syncToken: null,
    pageToken: null,
    lastSyncAt: null,
    changesStartedAt: null,
    upcoming: { pageToken: null, windowStart: null },
    legacyUpcoming: null,
  };
}

function decodeCursor(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw syncError('cursor-expired', 'google_calendar_cursor_unreadable');
  }
  if (!parsed || parsed.v !== 1 || (parsed.phase !== 'changes' && parsed.phase !== 'upcoming')) {
    throw syncError('cursor-expired', 'google_calendar_cursor_unrecognised');
  }
  const obj = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
  const upcoming = obj(parsed.upcoming);
  const legacy = obj(parsed.legacyUpcoming);
  const legacyFrom = isoOrNull(legacy.from);
  return {
    v: 1,
    phase: parsed.phase,
    syncToken: nonEmpty(parsed.syncToken),
    pageToken: nonEmpty(parsed.pageToken),
    lastSyncAt: isoOrNull(parsed.lastSyncAt),
    changesStartedAt: isoOrNull(parsed.changesStartedAt),
    upcoming: { pageToken: nonEmpty(upcoming.pageToken), windowStart: isoOrNull(upcoming.windowStart) },
    legacyUpcoming: legacyFrom ? { from: legacyFrom } : null,
  };
}

/* ─── sync ─── */

function createdAfter(event, lastSyncAtMs) {
  if (lastSyncAtMs === null) return false;
  const created = event.created ? Date.parse(event.created) : NaN;
  return Number.isFinite(created) && created > lastSyncAtMs;
}

/**
 * One page of changes. A full sweep (no sync token) announces every event as `event-created`;
 * an incremental sweep announces events created after the previous sweep started as
 * `event-created` and everything else, cancellations included, as `event-updated` (the legacy
 * classification). `lastSyncAt` advances to this sweep's start only once Google hands back the
 * next sync token.
 */
async function readChangesPage(host, source, cursor, calendarId, now) {
  if (!cursor.pageToken) cursor.changesStartedAt = new Date(now).toISOString();
  const page = await call(host, source, cursor.syncToken ? 'incremental_list' : 'full_list', eventsUrl(calendarId, query({
    maxResults: PAGE_SIZE,
    showDeleted: 'true',
    syncToken: cursor.syncToken,
    pageToken: cursor.pageToken,
  })));
  const lastSyncAtMs = cursor.lastSyncAt ? Date.parse(cursor.lastSyncAt) : null;
  const records = [];
  for (const event of Array.isArray(page.items) ? page.items : []) {
    if (!nonEmpty(event && event.id)) throw syncError('transient', 'google_calendar_event_id_required');
    const created = cursor.syncToken === null || createdAfter(event, lastSyncAtMs);
    records.push(eventRecord(event, created ? 'event-created' : 'event-updated', `change:${eventVersion(event)}`));
  }
  const nextPageToken = nonEmpty(page.nextPageToken);
  if (nextPageToken) {
    cursor.pageToken = nextPageToken;
    return records;
  }
  const nextSyncToken = nonEmpty(page.nextSyncToken);
  if (!nextSyncToken) throw syncError('transient', 'google_calendar_next_sync_token_missing');
  cursor.syncToken = nextSyncToken;
  cursor.pageToken = null;
  cursor.lastSyncAt = cursor.changesStartedAt;
  cursor.changesStartedAt = null;
  cursor.phase = 'upcoming';
  cursor.upcoming = { pageToken: null, windowStart: null };
  return records;
}

/**
 * True when the retired host poll already announced this (event, start) as upcoming (D-021.6).
 * That poll announced every event overlapping [from, from + lead) at its last run `from`, and every
 * earlier window before it, so any event that existed then (`updated` not after `from`) and starts
 * before `from + lead` was delivered under the poll's own key, which never collides with this
 * provider's. An event created or moved after `from` is announced again, correctly. The marker is
 * kept, not expired: a long event that started before cutover stays inside later windows.
 */
function legacyAnnounced(cursor, event, start, lead) {
  if (!cursor.legacyUpcoming) return false;
  const from = Date.parse(cursor.legacyUpcoming.from);
  const startMs = Date.parse(start);
  if (!Number.isFinite(from) || !Number.isFinite(startMs)) return false;
  if (startMs >= from + lead * 60000) return false;
  const updated = event.updated ? Date.parse(event.updated) : NaN;
  return !Number.isFinite(updated) || updated <= from;
}

/** One page of the upcoming-event window: single events overlapping [windowStart, windowStart + lead). */
async function readUpcomingPage(host, source, cursor, calendarId, lead, now) {
  if (!cursor.upcoming.windowStart) cursor.upcoming.windowStart = new Date(now).toISOString();
  const windowStart = Date.parse(cursor.upcoming.windowStart);
  const page = await call(host, source, 'upcoming_list', eventsUrl(calendarId, query({
    maxResults: PAGE_SIZE,
    orderBy: 'startTime',
    showDeleted: 'false',
    singleEvents: 'true',
    timeMin: new Date(windowStart).toISOString(),
    timeMax: new Date(windowStart + lead * 60000).toISOString(),
    pageToken: cursor.upcoming.pageToken,
  })));
  const records = [];
  for (const event of Array.isArray(page.items) ? page.items : []) {
    if (!nonEmpty(event && event.id)) throw syncError('transient', 'google_calendar_event_id_required');
    const start = calendarDate(event.start);
    if (!start || legacyAnnounced(cursor, event, start, lead)) continue;
    records.push(eventRecord(event, 'event-upcoming', `upcoming:${start}`));
  }
  const nextPageToken = nonEmpty(page.nextPageToken);
  cursor.upcoming.pageToken = nextPageToken;
  if (!nextPageToken) {
    cursor.phase = 'changes';
    cursor.upcoming = { pageToken: null, windowStart: null };
  }
  return { records, more: Boolean(nextPageToken) };
}

async function syncPage(request, host) {
  const source = request.source;
  const config = request.config && typeof request.config === 'object' ? request.config : {};
  const calendarId = calendarIdOf(config);
  const lead = leadMinutes(config);
  const cursor = decodeCursor(request.cursor) || freshCursor();
  const now = Date.now();
  if (cursor.phase === 'changes') {
    const records = await readChangesPage(host, source, cursor, calendarId, now);
    // Either more change pages, or the upcoming window still to read: both continue this pass.
    return { records, nextCursor: JSON.stringify(cursor), hasMore: true };
  }
  const upcoming = await readUpcomingPage(host, source, cursor, calendarId, lead, now);
  return { records: upcoming.records, nextCursor: JSON.stringify(cursor), hasMore: upcoming.more };
}

/* ─── outbound (invoke) ─── */

function requireId(value, field) {
  const id = nonEmpty(value);
  if (!id) throw new Error(`google_calendar_${field}_required`);
  return id;
}

function eventDate(value, timeZone) {
  const normalized = String(value === undefined || value === null ? '' : value).trim();
  if (!normalized) throw new Error('google_calendar_event_time_required');
  // An all-day event is a bare date; anything else must be a real instant.
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return { date: normalized };
  if (!Number.isFinite(Date.parse(normalized))) throw new Error(`google_calendar_event_time_invalid:${normalized}`);
  return nonEmpty(timeZone) ? { dateTime: normalized, timeZone: timeZone.trim() } : { dateTime: normalized };
}

function attendeeList(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error('google_calendar_attendees_invalid');
  return value.map((email) => {
    const address = nonEmpty(email);
    if (!address) throw new Error('google_calendar_attendee_invalid');
    return { email: address };
  });
}

function textField(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function createBody(args) {
  const summary = textField(args.summary);
  if (!summary || summary.length > 1024) throw new Error('google_calendar_event_summary_invalid');
  const body = {
    summary,
    start: eventDate(args.start, args.timeZone),
    end: eventDate(args.end, args.timeZone),
  };
  const description = textField(args.description);
  const location = textField(args.location);
  if (description) body.description = description.slice(0, 8192);
  if (location) body.location = location.slice(0, 1024);
  const attendees = attendeeList(args.attendees);
  if (attendees.length) body.attendees = attendees;
  return body;
}

/** A patch carries only the fields the caller supplied; a supplied null clears a text field. */
function patchBody(args) {
  const has = (key) => Object.prototype.hasOwnProperty.call(args, key) && args[key] !== undefined;
  const patch = {};
  if (has('summary')) patch.summary = textField(args.summary);
  if (has('description')) patch.description = textField(args.description);
  if (has('location')) patch.location = textField(args.location);
  if (has('start')) patch.start = eventDate(args.start, args.timeZone);
  if (has('end')) patch.end = eventDate(args.end, args.timeZone);
  if (has('attendees')) patch.attendees = attendeeList(args.attendees);
  if (!Object.keys(patch).length) throw new Error('google_calendar_event_patch_empty');
  return patch;
}

function writeResult(event) {
  const id = nonEmpty(event.id);
  if (!id) throw new Error('google_calendar_event_response_invalid');
  return {
    id,
    htmlLink: nonEmpty(event.htmlLink),
    status: nonEmpty(event.status),
    attendees: (Array.isArray(event.attendees) ? event.attendees : [])
      .map((person) => nonEmpty(person && person.email))
      .filter(Boolean),
  };
}

async function calendarWrite(host, source, args) {
  const calendarId = nonEmpty(args.calendarId) || 'primary';
  if (args.operation === 'create') {
    const event = await call(host, source, 'event_create', eventsUrl(calendarId, query({ sendUpdates: 'all' })), {
      method: 'POST',
      body: createBody(args),
    });
    return writeResult(event);
  }
  if (args.operation === 'update') {
    const eventId = requireId(args.eventId, 'event_id');
    const event = await call(host, source, 'event_update', eventsUrl(calendarId, `/${enc(eventId)}${query({ sendUpdates: 'all' })}`), {
      method: 'PATCH',
      body: patchBody(args),
    });
    return writeResult(event);
  }
  throw new Error(`google_calendar_write_operation_unsupported:${args.operation}`);
}

async function calendarRead(host, source, args) {
  const eventId = requireId(args.eventId, 'event_id');
  const calendarId = nonEmpty(args.calendarId) || 'primary';
  return { event: normalizeEvent(await call(host, source, 'event_get', eventsUrl(calendarId, `/${enc(eventId)}`))) };
}

/* ─── cursor adoption (D-021.5) ─── */

/**
 * Map the retired host Calendar poll's cursor (`syncToken`, `lastSyncAt`, or their snake_case
 * forms) onto this provider's cursor, so the first connector pass continues from that poll's sync
 * token instead of re-announcing the whole calendar under new delivery keys. The poll's last run
 * is recorded as `legacyUpcoming.from` so the first windows skip what it already announced. No
 * sync token means nothing to adopt.
 */
function adoptCursor(prior) {
  const p = prior && typeof prior === 'object' && !Array.isArray(prior) ? prior : {};
  const syncToken = nonEmpty(p.syncToken) || nonEmpty(p.sync_token);
  if (!syncToken) return { cursor: null, backfillComplete: false };
  const lastSyncAt = isoOrNull(p.lastSyncAt) || isoOrNull(p.last_sync_at);
  const cursor = {
    ...freshCursor(),
    syncToken,
    lastSyncAt,
    legacyUpcoming: lastSyncAt ? { from: lastSyncAt } : null,
  };
  return { cursor: JSON.stringify(cursor), backfillComplete: true };
}

async function invoke(request, host) {
  if (!DESCRIPTOR.capabilities.includes(request.capability)) {
    throw new Error(`provider_capability_unsupported:${request.capability}`);
  }
  const args = request.args && typeof request.args === 'object' ? request.args : {};
  switch (request.capability) {
    case 'calendar.read':
      return calendarRead(host, request.source, args);
    case 'calendar.write':
      return calendarWrite(host, request.source, args);
    case 'sync.adopt':
      return adoptCursor(args.prior);
    default:
      throw new Error(`provider_capability_unsupported:${request.capability}`);
  }
}

module.exports = {
  name: manifest.name,
  version: manifest.version,
  papercusp: manifest.papercusp,
  capabilities: manifest.capabilities,
  providerAdapter: {
    describe: () => DESCRIPTOR,
    syncPage,
    invoke,
  },
  // Exposed for the provider's own tests only; the host uses providerAdapter.
  _internal: { normalizeEvent, decodeCursor, adoptCursor, legacyAnnounced },
};
