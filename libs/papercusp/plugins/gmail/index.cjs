'use strict';
/**
 * Gmail provider (plan generalized-integrations-google-migration-cupboard-workflows-2026-10-05,
 * P-008 / D-017 / D-018).
 *
 * A first-party mail provider on the integration provider contract. The host's connector driver
 * calls `syncPage` and owns everything stateful (lease, cursor commit, dedupe, retry, routing);
 * outbound mail verbs call `invoke`. This module only maps Gmail's and Pub/Sub's REST APIs:
 *   - a mailbox message -> `email-message`, event `message.received` (nativeId = Gmail message id)
 *   - mail.read / mail.threads / mail.labels / mail.attachments -> reads and label edits
 *   - mail.draft (create | update | read) and mail.send (message | draft) -> outbound mail
 *   - sync.wake -> pull this source's Pub/Sub subscription; a matching notification wakes a sync
 *   - sync.adopt -> start a source the retired host Gmail poll drove from that poll's cursor (D-020)
 *
 * The only network path is `host.fetch`. Gmail calls carry the source account's token; Pub/Sub
 * calls carry the host-held `google-pubsub` service credential (D-018.1). Nothing here sees a
 * credential, imports host code, or writes a table.
 *
 * Cursor: one opaque JSON string
 *   `{ v, emailAddress, historyId, history: { pageToken }, backfill: { status, pageToken, messages },
 *      watch: { expiration, topicName, topicReady } }`.
 * Each `syncPage` drains ONE history page first (new mail has priority), then, once history is
 * drained, ONE budgeted messages.list backfill page. A null cursor pins the mailbox's current
 * historyId, then backfills. Every record carries a constant `version`, so a cursor reset, a
 * history overlap or a label change never re-delivers `message.received` (D-017.3).
 */
const { randomBytes } = require('node:crypto');
const manifest = require('./papercusp.json');

const DESCRIPTOR = manifest.provider;
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const PUBSUB = 'https://pubsub.googleapis.com/v1';
const PUBSUB_REF = 'google-pubsub';
const GMAIL_PUSH_PUBLISHER = 'serviceAccount:gmail-api-push@system.gserviceaccount.com';
const PUBLISHER_ROLE = 'roles/pubsub.publisher';
const HISTORY_PAGE_SIZE = 100;
const BACKFILL_PAGE_SIZE = 25;
const PULL_MAX_MESSAGES = 100;
const WATCH_RENEW_BEFORE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RETRY_AFTER_SECONDS = 60;
const RECORD_VERSION = 'received';
const EVENT = 'message.received';
const DATATYPE = 'email-message';
const ATTACHMENT_MAX_FILES = 10;
const ATTACHMENT_MAX_TOTAL_BYTES = 20 * 1024 * 1024;
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

function decodeBase64Url(data) {
  const normalized = nonEmpty(data);
  if (!normalized) return null;
  try {
    return Buffer.from(normalized.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  } catch {
    return null;
  }
}

function isoFromMillis(value) {
  const raw = value === undefined || value === null ? '' : String(value).trim();
  if (!/^\d+$/.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function query(params) {
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) for (const entry of value) search.append(name, String(entry));
    else search.set(name, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

/* ─── HTTP through host.fetch ─── */

function errorReasons(json) {
  const errors = json && json.error && Array.isArray(json.error.errors) ? json.error.errors : [];
  const reasons = errors.map((entry) => entry && entry.reason).filter((reason) => typeof reason === 'string');
  const status = json && json.error && typeof json.error.status === 'string' ? json.error.status : '';
  const message = json && json.error && typeof json.error.message === 'string' ? json.error.message : '';
  return { reasons, status, message };
}

/**
 * One Gmail or Pub/Sub call. Failures map to the host's sync signals (D-017.4): 429 and quota or
 * rate-limit 403s are `rate-limited`, other 401/403s are `auth`, a 404 on history is
 * `cursor-expired`, 5xx and anything else unexpected is `transient`. A 404 elsewhere carries
 * `notFound` so callers can treat a deleted message as gone. `allow` lists statuses the caller
 * handles itself (they return `{ status, json }` instead of throwing).
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
    if (raw && json === null) throw syncError('transient', `gmail_${op}_body_not_json`, { status, op });
    return opts.allow ? { status, json: json || {} } : json || {};
  }
  if (opts.allow && opts.allow.includes(status)) return { status, json: json || {} };
  const headers = lowerHeaders(response.headers);
  const { reasons, message } = errorReasons(json);
  const detail = `gmail_${op}_http_${status}${message ? `: ${message.slice(0, 300)}` : ''}`;
  const rateLimited = status === 429
    || (status === 403 && (reasons.some((reason) => RATE_LIMIT_REASONS.has(reason))
      || /quota|rate ?limit|usage ?limit|too many/i.test(message)));
  if (rateLimited) {
    const retryAfter = Number(headers['retry-after']);
    const retryAfterSeconds = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : DEFAULT_RETRY_AFTER_SECONDS;
    throw syncError('rate-limited', detail, { retryAfterSeconds, status, op });
  }
  if (status === 401 || status === 403) throw syncError('auth', detail, { status, op });
  if (status === 404 && op === 'history_list') throw syncError('cursor-expired', detail, { status, op });
  if (status === 404) throw syncError('transient', detail, { status, op, notFound: true });
  throw syncError('transient', detail, { status, op });
}

const gmail = (path) => `${GMAIL}${path}`;
const enc = (value) => encodeURIComponent(String(value));

async function getProfile(host, source) {
  const profile = await call(host, source, 'profile', gmail('/profile'));
  const emailAddress = nonEmpty(profile.emailAddress);
  const historyId = nonEmpty(profile.historyId === undefined ? undefined : String(profile.historyId));
  if (!emailAddress || !historyId) throw syncError('transient', 'gmail_profile_response_invalid');
  return { emailAddress, historyId };
}

async function getMessage(host, source, id, format) {
  return call(host, source, 'message_get', gmail(`/messages/${enc(id)}${query({ format: format || 'full' })}`));
}

/** messages.get, treating a message deleted between listing and fetching as gone. */
async function getMessageIfPresent(host, source, id) {
  try {
    return await getMessage(host, source, id, 'full');
  } catch (cause) {
    if (cause && cause.notFound) return null;
    throw cause;
  }
}

/* ─── mapping: Gmail message -> canonical email-message ─── */

function header(part, name) {
  const lower = name.toLowerCase();
  const found = (part && Array.isArray(part.headers) ? part.headers : [])
    .find((candidate) => candidate && typeof candidate.name === 'string' && candidate.name.toLowerCase() === lower);
  return nonEmpty(found && found.value);
}

/** Split an address header on top-level commas (not inside quotes or angle brackets). */
function addressList(value) {
  if (!value) return [];
  const values = [];
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

function collectParts(part, texts, html, attachments) {
  if (!part) return;
  const mimeType = typeof part.mimeType === 'string' ? part.mimeType.toLowerCase() : '';
  const body = part.body || {};
  if (!part.filename && mimeType === 'text/plain') {
    const decoded = decodeBase64Url(body.data);
    if (decoded) texts.push(decoded);
  } else if (!part.filename && mimeType === 'text/html') {
    const decoded = decodeBase64Url(body.data);
    if (decoded) html.push(decoded);
  } else if (part.filename && nonEmpty(body.attachmentId)) {
    const entry = { attachmentId: body.attachmentId, filename: part.filename, mimeType: part.mimeType || 'application/octet-stream' };
    if (Number.isFinite(Number(body.size))) entry.size = Number(body.size);
    if (nonEmpty(part.partId)) entry.partId = part.partId;
    attachments.push(entry);
  }
  for (const child of Array.isArray(part.parts) ? part.parts : []) collectParts(child, texts, html, attachments);
}

function occurredAt(message) {
  const fromInternal = isoFromMillis(message.internalDate);
  if (fromInternal) return fromInternal;
  const date = header(message.payload, 'Date');
  if (!date) return null;
  const parsed = Date.parse(date);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

/**
 * The canonical email-message payload. The fields and their rules are exactly the former host
 * normalizer's (id, threadId, from/to/cc/bcc, subject, messageId, references, text, html,
 * snippet, occurredAt, labels, direction), plus the provider-neutral `tags` (= labels),
 * attachment metadata, the mailbox address when known, and raw Gmail fields under
 * `extensions.gmail`.
 */
function normalizeMessage(message, mailbox) {
  const id = nonEmpty(message && message.id);
  if (!id) throw syncError('transient', 'gmail_message_id_required');
  const texts = [];
  const html = [];
  const attachments = [];
  collectParts(message.payload, texts, html, attachments);
  const normalized = { id };
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
  const labelIds = Array.isArray(message.labelIds) ? message.labelIds.filter((label) => typeof label === 'string') : [];
  if (labelIds.length) {
    normalized.labels = [...labelIds];
    normalized.tags = [...labelIds];
    normalized.direction = labelIds.some((label) => label === 'SENT' || label === 'DRAFT') ? 'outbound' : 'inbound';
  }
  if (attachments.length) normalized.attachments = attachments;
  if (mailbox) normalized.mailbox = mailbox;
  const extension = {};
  if (message.historyId !== undefined && message.historyId !== null) extension.historyId = String(message.historyId);
  if (message.internalDate !== undefined && message.internalDate !== null) extension.internalDate = String(message.internalDate);
  if (Number.isFinite(Number(message.sizeEstimate))) extension.sizeEstimate = Number(message.sizeEstimate);
  if (Object.keys(extension).length) normalized.extensions = { gmail: extension };
  return normalized;
}

function messageRecord(message, mailbox) {
  const payload = normalizeMessage(message, mailbox);
  const record = { datatype: DATATYPE, nativeId: payload.id, event: EVENT, payload, version: RECORD_VERSION };
  if (payload.occurredAt) record.occurredAt = payload.occurredAt;
  return record;
}

/* ─── cursor ─── */

function freshBackfill() {
  return { status: 'pending', pageToken: null, messages: 0 };
}

function decodeCursor(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw syncError('cursor-expired', 'gmail_cursor_unreadable');
  }
  if (!parsed || parsed.v !== 1 || !nonEmpty(parsed.historyId)) throw syncError('cursor-expired', 'gmail_cursor_unrecognised');
  const obj = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
  const history = obj(parsed.history);
  const backfill = obj(parsed.backfill);
  const watch = obj(parsed.watch);
  return {
    v: 1,
    emailAddress: nonEmpty(parsed.emailAddress),
    historyId: String(parsed.historyId).trim(),
    history: { pageToken: nonEmpty(history.pageToken) },
    backfill: {
      status: backfill.status === 'complete' ? 'complete' : 'pending',
      pageToken: nonEmpty(backfill.pageToken),
      messages: Number.isInteger(backfill.messages) && backfill.messages >= 0 ? backfill.messages : 0,
    },
    watch: {
      expiration: nonEmpty(watch.expiration),
      topicName: nonEmpty(watch.topicName),
      topicReady: nonEmpty(watch.topicReady),
    },
  };
}

/* ─── Pub/Sub topic + watch (D-018.3) ─── */

function pubsubService(services) {
  const params = services && services[PUBSUB_REF];
  const projectId = nonEmpty(params && params.projectId);
  const topicName = nonEmpty(params && params.topicName);
  return projectId && topicName ? { projectId, topicName } : null;
}

/** Idempotently create the shared topic and grant Gmail's push service account publish rights. */
async function ensureTopic(host, source, topicName) {
  await call(host, source, 'topic_create', `${PUBSUB}/${topicName}`, { method: 'PUT', body: {}, allow: [409] });
  const policy = await call(host, source, 'topic_get_iam', `${PUBSUB}/${topicName}:getIamPolicy`, { method: 'POST', body: {} });
  const bindings = Array.isArray(policy.bindings) ? policy.bindings : [];
  const granted = bindings.some((binding) => binding && binding.role === PUBLISHER_ROLE
    && Array.isArray(binding.members) && binding.members.includes(GMAIL_PUSH_PUBLISHER));
  if (granted) return;
  const next = bindings.filter((binding) => binding && binding.role !== PUBLISHER_ROLE);
  const existing = bindings.find((binding) => binding && binding.role === PUBLISHER_ROLE);
  next.push({ role: PUBLISHER_ROLE, members: [...new Set([...(existing && Array.isArray(existing.members) ? existing.members : []), GMAIL_PUSH_PUBLISHER])] });
  await call(host, source, 'topic_set_iam', `${PUBSUB}/${topicName}:setIamPolicy`, {
    method: 'POST',
    body: { policy: { bindings: next, ...(policy.etag ? { etag: policy.etag } : {}) } },
  });
}

async function renewWatchIfDue(host, source, cursor, service, now) {
  if (!service) return;
  const expiresAt = cursor.watch.expiration ? Date.parse(cursor.watch.expiration) : NaN;
  const due = cursor.watch.topicName !== service.topicName
    || !Number.isFinite(expiresAt)
    || expiresAt - now <= WATCH_RENEW_BEFORE_MS;
  if (!due) return;
  if (cursor.watch.topicReady !== service.topicName) {
    await ensureTopic(host, source, service.topicName);
    cursor.watch.topicReady = service.topicName;
  }
  const watched = await call(host, source, 'watch', gmail('/watch'), { method: 'POST', body: { topicName: service.topicName } });
  const expiration = isoFromMillis(watched.expiration);
  if (!expiration) throw syncError('transient', 'gmail_watch_expiration_invalid');
  cursor.watch.expiration = expiration;
  cursor.watch.topicName = service.topicName;
}

/* ─── sync ─── */

async function readHistoryPage(host, source, cursor, seen) {
  const page = await call(host, source, 'history_list', gmail(`/history${query({
    startHistoryId: cursor.historyId,
    historyTypes: 'messageAdded',
    maxResults: HISTORY_PAGE_SIZE,
    pageToken: cursor.history.pageToken,
  })}`));
  const records = [];
  for (const history of Array.isArray(page.history) ? page.history : []) {
    for (const added of Array.isArray(history && history.messagesAdded) ? history.messagesAdded : []) {
      const id = nonEmpty(added && added.message && added.message.id);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const message = await getMessageIfPresent(host, source, id);
      if (message) records.push(messageRecord(message, cursor.emailAddress));
    }
  }
  const nextPageToken = nonEmpty(page.nextPageToken);
  if (nextPageToken) {
    cursor.history.pageToken = nextPageToken;
  } else {
    const latest = page.historyId === undefined || page.historyId === null ? null : nonEmpty(String(page.historyId));
    if (!latest) throw syncError('transient', 'gmail_history_next_id_missing');
    cursor.historyId = latest;
    cursor.history.pageToken = null;
  }
  return { records, more: Boolean(nextPageToken) };
}

async function readBackfillPage(host, source, cursor, seen) {
  const page = await call(host, source, 'messages_list', gmail(`/messages${query({
    maxResults: BACKFILL_PAGE_SIZE,
    pageToken: cursor.backfill.pageToken,
  })}`));
  const records = [];
  for (const listed of Array.isArray(page.messages) ? page.messages : []) {
    const id = nonEmpty(listed && listed.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const message = await getMessageIfPresent(host, source, id);
    if (message) records.push(messageRecord(message, cursor.emailAddress));
  }
  const nextPageToken = nonEmpty(page.nextPageToken);
  cursor.backfill = {
    status: nextPageToken ? 'pending' : 'complete',
    pageToken: nextPageToken,
    messages: cursor.backfill.messages + records.length,
  };
  return records;
}

async function syncPage(request, host) {
  const source = request.source;
  let cursor = decodeCursor(request.cursor);
  if (!cursor) {
    const profile = await getProfile(host, source);
    cursor = {
      v: 1,
      emailAddress: profile.emailAddress,
      historyId: profile.historyId,
      history: { pageToken: null },
      backfill: freshBackfill(),
      watch: { expiration: null, topicName: null, topicReady: null },
    };
  }
  await renewWatchIfDue(host, source, cursor, pubsubService(request.services), Date.now());
  const seen = new Set();
  const history = await readHistoryPage(host, source, cursor, seen);
  const records = [...history.records];
  if (!history.more && cursor.backfill.status !== 'complete') {
    records.push(...(await readBackfillPage(host, source, cursor, seen)));
  }
  return {
    records,
    nextCursor: JSON.stringify(cursor),
    hasMore: history.more || cursor.backfill.status !== 'complete',
  };
}

/* ─── outbound MIME (RFC 5322 / 2047 / 2231) ─── */

function safeHeader(value, field, maxLength) {
  const normalized = String(value === undefined || value === null ? '' : value).trim();
  if (!normalized || normalized.length > (maxLength || 8000) || /[\r\n]/.test(normalized)) {
    throw new Error(`gmail_draft_${field}_invalid`);
  }
  return normalized;
}

function isAscii(value) {
  return /^[\x20-\x7e]*$/.test(value);
}

/** RFC 2047 B-encoded words, each at most 75 characters, never splitting a UTF-8 sequence. */
function encodedWords(value) {
  const words = [];
  let chunk = '';
  for (const character of value) {
    if (Buffer.byteLength(chunk + character, 'utf8') > 45) {
      words.push(chunk);
      chunk = '';
    }
    chunk += character;
  }
  if (chunk) words.push(chunk);
  return words.map((word) => `=?UTF-8?B?${Buffer.from(word, 'utf8').toString('base64')}?=`).join('\r\n ');
}

function encodeText(value) {
  return isAscii(value) ? value : encodedWords(value);
}

/** One address: an ASCII address stays as is; a non-ASCII display name is encoded, the address never. */
function encodeAddress(entry) {
  if (isAscii(entry)) return entry;
  const match = /^(.*?)<([^<>]+)>\s*$/.exec(entry);
  if (!match || !isAscii(match[2])) throw new Error('gmail_draft_address_invalid');
  const name = match[1].trim().replace(/^"(.*)"$/, '$1');
  return name ? `${encodedWords(name)} <${match[2].trim()}>` : `<${match[2].trim()}>`;
}

/** Fold a long ASCII header value at spaces so no line exceeds 78 characters where possible. */
function fold(name, value) {
  const line = `${name}: ${value}`;
  if (line.length <= 78) return line;
  const out = [];
  let current = `${name}:`;
  for (const token of value.split(' ')) {
    if (current.length + 1 + token.length > 78 && current.trim() !== `${name}:`) {
      out.push(current);
      current = ` ${token}`;
    } else {
      current += ` ${token}`;
    }
  }
  out.push(current);
  return out.join('\r\n');
}

function base64Lines(buffer) {
  return (buffer.toString('base64').match(/.{1,76}/g) || ['']).join('\r\n');
}

function addressHeader(name, values) {
  return `${name}: ${values.map(encodeAddress).join(',\r\n ')}`;
}

function normalizeAttachments(input) {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) throw new Error('gmail_draft_attachments_invalid');
  if (input.length > ATTACHMENT_MAX_FILES) throw new Error('gmail_draft_attachments_too_many');
  let total = 0;
  const out = input.map((file) => {
    const filename = safeHeader(file && file.filename, 'attachment_filename', 255);
    if (/["\\;]/.test(filename)) throw new Error('gmail_draft_attachment_filename_invalid');
    const contentType = safeHeader(file && file.contentType, 'attachment_content_type', 255);
    if (!/^[\w.+-]+\/[\w.+-]+$/.test(contentType)) throw new Error('gmail_draft_attachment_content_type_invalid');
    const encoded = typeof (file && file.contentBase64) === 'string' ? file.contentBase64.trim() : '';
    const content = encoded ? Buffer.from(encoded, 'base64') : Buffer.alloc(0);
    if (!content.length) throw new Error('gmail_draft_attachment_content_invalid');
    total += content.length;
    return { filename, contentType, content };
  });
  if (total > ATTACHMENT_MAX_TOTAL_BYTES) throw new Error('gmail_draft_attachments_too_large');
  return out;
}

function filenameParams(filename) {
  if (isAscii(filename)) return `filename="${filename}"`;
  const pct = encodeURIComponent(filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `filename*=UTF-8''${pct}`;
}

/**
 * Encode one outbound message as base64url RFC 5322. Reply threading needs BOTH the Gmail
 * `threadId` on the API request AND `In-Reply-To`/`References` in the MIME headers; supplying
 * one without the other sends fine and lands outside the thread, so it is assembled only here.
 * Gmail substitutes its own `From`, `Date` and `Message-ID`.
 */
function buildRawMessage(args) {
  const recipients = (Array.isArray(args.to) ? args.to : [args.to])
    .map((value) => String(value === undefined || value === null ? '' : value).trim())
    .filter(Boolean);
  if (!recipients.length) throw new Error('gmail_to_required');
  safeHeader(recipients.join(', '), 'to', 2000);
  const cc = (Array.isArray(args.cc) ? args.cc : []).map((value) => String(value === undefined || value === null ? '' : value).trim()).filter(Boolean);
  if (cc.length) safeHeader(cc.join(', '), 'cc', 2000);
  const subject = safeHeader(args.subject, 'subject', 998);
  const text = typeof args.text === 'string' ? args.text.trim() : '';
  if (!text || text.length > 100000) throw new Error('gmail_draft_text_invalid');
  const threadId = nonEmpty(args.threadId) ? safeHeader(args.threadId, 'thread_id', 512) : null;
  const inReplyTo = nonEmpty(args.inReplyTo) ? safeHeader(args.inReplyTo, 'in_reply_to', 998) : null;
  const references = inReplyTo
    ? safeHeader(nonEmpty(args.references) ? `${args.references.trim()} ${inReplyTo}` : inReplyTo, 'references')
    : null;
  const attachments = normalizeAttachments(args.attachments);
  const lines = [addressHeader('To', recipients)];
  if (cc.length) lines.push(addressHeader('Cc', cc));
  lines.push(`Subject: ${encodeText(subject)}`);
  if (inReplyTo) {
    lines.push(fold('In-Reply-To', inReplyTo));
    lines.push(fold('References', references));
  }
  lines.push('MIME-Version: 1.0');
  const textPart = [
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(Buffer.from(text, 'utf8')),
  ];
  if (!attachments.length) {
    lines.push(...textPart);
  } else {
    const boundary = `papercusp-${randomBytes(12).toString('hex')}`;
    lines.push(`Content-Type: multipart/mixed; boundary="${boundary}"`, '', `--${boundary}`, ...textPart);
    for (const file of attachments) {
      const params = filenameParams(file.filename);
      lines.push(
        `--${boundary}`,
        `Content-Type: ${file.contentType}; ${params.replace(/^filename/, 'name')}`,
        `Content-Disposition: attachment; ${params}`,
        'Content-Transfer-Encoding: base64',
        '',
        base64Lines(file.content),
      );
    }
    lines.push(`--${boundary}--`);
  }
  return { raw: Buffer.from(`${lines.join('\r\n')}\r\n`, 'utf8').toString('base64url'), threadId };
}

/* ─── outbound + reads (invoke) ─── */

function requireId(value, field) {
  const id = nonEmpty(value);
  if (!id) throw new Error(`gmail_${field}_required`);
  return id;
}

function draftResult(body, expect) {
  const draftId = nonEmpty(body.id);
  const messageId = nonEmpty(body.message && body.message.id);
  const threadId = nonEmpty(body.message && body.message.threadId);
  if (!draftId || !messageId || !threadId) throw new Error('gmail_draft_response_invalid');
  if (expect.draftId && draftId !== expect.draftId) throw new Error('gmail_draft_id_mismatch');
  if (expect.threadId && threadId !== expect.threadId) throw new Error('gmail_draft_thread_mismatch');
  return { draftId, messageId, threadId };
}

function extractAddress(entry) {
  const angle = /<([^>]*)>/.exec(entry);
  const raw = (angle ? angle[1] : entry).trim().toLowerCase();
  return raw.includes('@') ? raw : null;
}

async function mailDraft(host, source, args) {
  const operation = args.operation;
  if (operation === 'read') {
    const draftId = requireId(args.draftId, 'draft_id');
    const body = await call(host, source, 'draft_get', gmail(`/drafts/${enc(draftId)}${query({ format: 'metadata', metadataHeaders: ['To', 'Cc', 'Subject'] })}`));
    const headers = body.message && body.message.payload && Array.isArray(body.message.payload.headers) ? body.message.payload.headers : [];
    if (!headers.length) throw new Error('gmail_draft_headers_unreadable');
    const parse = (name) => addressList(header(body.message.payload, name)).map(extractAddress).filter(Boolean);
    return { draftId, to: parse('To'), cc: parse('Cc'), subject: header(body.message.payload, 'Subject') };
  }
  if (operation !== 'create' && operation !== 'update') throw new Error(`gmail_mail_draft_operation_unsupported:${operation}`);
  const encoded = buildRawMessage(args);
  const message = encoded.threadId ? { raw: encoded.raw, threadId: encoded.threadId } : { raw: encoded.raw };
  if (operation === 'create') {
    const body = await call(host, source, 'draft_create', gmail('/drafts'), { method: 'POST', body: { message } });
    return draftResult(body, { threadId: encoded.threadId });
  }
  const draftId = requireId(args.draftId, 'draft_id');
  const body = await call(host, source, 'draft_update', gmail(`/drafts/${enc(draftId)}`), { method: 'PUT', body: { id: draftId, message } });
  return draftResult(body, { draftId, threadId: encoded.threadId });
}

async function mailSend(host, source, args) {
  if (args.operation === 'draft') {
    const draftId = requireId(args.draftId, 'draft_id');
    const body = await call(host, source, 'draft_send', gmail('/drafts/send'), { method: 'POST', body: { id: draftId } });
    const messageId = nonEmpty(body.id);
    const threadId = nonEmpty(body.threadId);
    if (!messageId || !threadId) throw new Error('gmail_draft_send_response_invalid');
    return { messageId, threadId };
  }
  if (args.operation !== 'message') throw new Error(`gmail_mail_send_operation_unsupported:${args.operation}`);
  const encoded = buildRawMessage(args);
  const body = await call(host, source, 'message_send', gmail('/messages/send'), {
    method: 'POST',
    body: encoded.threadId ? { raw: encoded.raw, threadId: encoded.threadId } : { raw: encoded.raw },
  });
  const messageId = nonEmpty(body.id);
  const threadId = nonEmpty(body.threadId);
  if (!messageId || !threadId) throw new Error('gmail_send_response_invalid');
  if (encoded.threadId && threadId !== encoded.threadId) throw new Error('gmail_send_thread_mismatch');
  return { messageId, threadId };
}

function labelIds(value, field) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((label) => !nonEmpty(label))) throw new Error(`gmail_${field}_invalid`);
  return value.map((label) => label.trim());
}

async function mailLabels(host, source, args) {
  const operation = args.operation || 'list';
  if (operation === 'list') {
    const body = await call(host, source, 'labels_list', gmail('/labels'));
    const labels = (Array.isArray(body.labels) ? body.labels : [])
      .filter((label) => label && nonEmpty(label.id))
      .map((label) => ({ id: label.id, name: label.name || label.id, type: label.type || 'user' }));
    return { labels };
  }
  if (operation !== 'modify') throw new Error(`gmail_mail_labels_operation_unsupported:${operation}`);
  const addLabelIds = labelIds(args.add, 'labels_add');
  const removeLabelIds = labelIds(args.remove, 'labels_remove');
  if (!addLabelIds.length && !removeLabelIds.length) throw new Error('gmail_labels_change_required');
  const threadId = nonEmpty(args.threadId);
  const messageId = nonEmpty(args.messageId);
  if (Boolean(threadId) === Boolean(messageId)) throw new Error('gmail_labels_target_required: pass exactly one of messageId or threadId');
  const path = threadId ? `/threads/${enc(threadId)}/modify` : `/messages/${enc(messageId)}/modify`;
  const body = await call(host, source, threadId ? 'thread_modify' : 'message_modify', gmail(path), {
    method: 'POST',
    body: { addLabelIds, removeLabelIds },
  });
  if (threadId) {
    const messages = Array.isArray(body.messages) ? body.messages : [];
    return { threadId: nonEmpty(body.id) || threadId, messages: messages.map((m) => ({ id: m.id, labels: Array.isArray(m.labelIds) ? m.labelIds : [] })) };
  }
  return { messageId: nonEmpty(body.id) || messageId, threadId: nonEmpty(body.threadId), labels: Array.isArray(body.labelIds) ? body.labelIds : [] };
}

async function mailThreads(host, source, args) {
  const threadId = requireId(args.threadId, 'thread_id');
  const body = await call(host, source, 'thread_get', gmail(`/threads/${enc(threadId)}${query({ format: 'full' })}`));
  const messages = (Array.isArray(body.messages) ? body.messages : []).map((message) => normalizeMessage(message, null));
  return { threadId: nonEmpty(body.id) || threadId, messages };
}

async function mailRead(host, source, args) {
  const messageId = requireId(args.messageId, 'message_id');
  return { message: normalizeMessage(await getMessage(host, source, messageId, 'full'), null) };
}

async function mailAttachments(host, source, args) {
  const messageId = requireId(args.messageId, 'message_id');
  const attachmentId = requireId(args.attachmentId, 'attachment_id');
  const body = await call(host, source, 'attachment_get', gmail(`/messages/${enc(messageId)}/attachments/${enc(attachmentId)}`));
  const data = nonEmpty(body.data);
  if (!data) throw new Error('gmail_attachment_response_invalid');
  const content = Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  return { messageId, attachmentId, size: content.length, contentBase64: content.toString('base64') };
}

/* ─── cursor adoption (D-020) ─── */

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function idString(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  return nonEmpty(value);
}

/**
 * Map the retired host Gmail poll's cursor (`historyId`, `emailAddress`, `watchExpiration`,
 * resumable `backfill`) onto this provider's cursor, so the first connector pass continues from
 * where that poll stopped instead of re-walking the mailbox under new delivery keys. A legacy
 * cursor with no `backfill` key belongs to a mailbox cursored before resumable backfill existed:
 * the poll never backfilled it, so the adopted cursor does not either. A `throttled` backfill
 * resumes as pending. No history position means nothing to adopt.
 */
function adoptCursor(prior) {
  const p = plainObject(prior) || {};
  const historyId = idString(p.historyId) ?? idString(p.history_id);
  if (!historyId) return { cursor: null, backfillComplete: false };
  const legacy = plainObject(p.backfill);
  const messages = legacy && Number.isInteger(legacy.messages) && legacy.messages >= 0 ? legacy.messages : 0;
  const backfill = !legacy || legacy.status === 'complete'
    ? { status: 'complete', pageToken: null, messages }
    : { status: 'pending', pageToken: nonEmpty(legacy.pageToken), messages };
  const cursor = {
    v: 1,
    emailAddress: nonEmpty(p.emailAddress) ?? nonEmpty(p.email_address),
    historyId,
    history: { pageToken: null },
    backfill,
    watch: {
      expiration: nonEmpty(p.watchExpiration) ?? nonEmpty(p.watch_expiration),
      topicName: null,
      topicReady: null,
    },
  };
  return { cursor: JSON.stringify(cursor), backfillComplete: backfill.status === 'complete' };
}

/* ─── push wake (D-018.2 / D-018.3) ─── */

function decodeWakeState(raw) {
  if (typeof raw !== 'string' || !raw) return { v: 1 };
  try {
    const parsed = JSON.parse(raw);
    return parsed && parsed.v === 1 ? parsed : { v: 1 };
  } catch {
    return { v: 1 };
  }
}

/** Gmail push notification payload: base64 JSON `{ emailAddress, historyId }`. */
function notificationAddress(data) {
  if (typeof data !== 'string' || !data) return null;
  try {
    const parsed = JSON.parse(Buffer.from(data, 'base64').toString('utf8'));
    return nonEmpty(parsed && parsed.emailAddress);
  } catch {
    return null;
  }
}

/**
 * Pull this source's subscription on the shared topic, ack everything, and report whether any
 * notification names this mailbox. Without a configured Pub/Sub credential it reports no wake,
 * and the regular poll still syncs. A missing subscription is created and reported as a wake,
 * since notifications sent before it existed were never delivered to it.
 */
async function syncWake(host, source, args, services) {
  const service = pubsubService(services);
  const state = decodeWakeState(args.state);
  if (!service) return { wake: false, state: JSON.stringify(state) };
  if (!nonEmpty(state.emailAddress)) state.emailAddress = (await getProfile(host, source)).emailAddress;
  const subscription = `projects/${service.projectId}/subscriptions/papercusp-gmail-${source}`;
  const pulled = await call(host, source, 'pubsub_pull', `${PUBSUB}/${subscription}:pull`, {
    method: 'POST',
    body: { maxMessages: PULL_MAX_MESSAGES, returnImmediately: true },
    allow: [404],
  });
  if (pulled.status === 404) {
    await call(host, source, 'pubsub_subscription_create', `${PUBSUB}/${subscription}`, {
      method: 'PUT',
      body: { topic: service.topicName, ackDeadlineSeconds: 60 },
      allow: [409],
    });
    state.subscription = subscription;
    return { wake: true, state: JSON.stringify(state) };
  }
  const received = Array.isArray(pulled.json.receivedMessages) ? pulled.json.receivedMessages : [];
  const mailbox = state.emailAddress.toLowerCase();
  const wake = received.some((entry) => {
    const address = notificationAddress(entry && entry.message && entry.message.data);
    return Boolean(address && address.toLowerCase() === mailbox);
  });
  const ackIds = received.map((entry) => entry && entry.ackId).filter((ackId) => nonEmpty(ackId));
  if (ackIds.length) {
    await call(host, source, 'pubsub_ack', `${PUBSUB}/${subscription}:acknowledge`, { method: 'POST', body: { ackIds } });
  }
  state.subscription = subscription;
  return { wake, state: JSON.stringify(state) };
}

async function invoke(request, host) {
  if (!DESCRIPTOR.capabilities.includes(request.capability)) {
    throw new Error(`provider_capability_unsupported:${request.capability}`);
  }
  const args = request.args && typeof request.args === 'object' ? request.args : {};
  switch (request.capability) {
    case 'mail.read':
      return mailRead(host, request.source, args);
    case 'mail.threads':
      return mailThreads(host, request.source, args);
    case 'mail.labels':
      return mailLabels(host, request.source, args);
    case 'mail.attachments':
      return mailAttachments(host, request.source, args);
    case 'mail.draft':
      return mailDraft(host, request.source, args);
    case 'mail.send':
      return mailSend(host, request.source, args);
    case 'sync.wake':
      return syncWake(host, request.source, args, request.services);
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
  _internal: { normalizeMessage, buildRawMessage, decodeCursor, adoptCursor },
};
