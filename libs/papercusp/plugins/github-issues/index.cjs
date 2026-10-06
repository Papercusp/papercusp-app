'use strict';
/**
 * GitHub Issues provider (plan generalized-integrations-google-migration-cupboard-workflows-2026-10-05,
 * P-010 / D-015 / D-009).
 *
 * A ticket provider on the integration provider contract. The host's connector driver
 * calls `syncPage` and owns everything stateful (lease, cursor commit, dedupe, retry, routing);
 * this module only maps GitHub's REST API into canonical records:
 *   - an issue               -> `ticket` (nativeId `owner/repo#N`)
 *   - first sight of a ticket -> `ticket-status-change` `opened` (nativeId `opened:owner/repo#N`)
 *   - close / reopen event   -> `ticket-status-change` (nativeId `event:<event id>`)
 *   - an issue comment       -> `ticket-comment` (nativeId `comment:<comment id>`)
 * Pull requests come back from the same endpoints and are skipped, with their events and comments.
 *
 * Writes (linear-asana-task-sync P-002; WI-10006212): `ticket.comment` posts a comment on the
 * issue and returns `updateId` = `comment:<id>`, the same nativeId the comment sync phase reports,
 * so the host recognises its own comment when it comes back. GitHub has no workflow columns, so
 * `ticket.transition` is not declared and the host refuses it by name.
 *
 * The only network path is `host.fetch`, which enforces the declared egress hosts and injects the
 * source account's token. Nothing here sees a credential, imports host code, or writes a table.
 *
 * Cursor: one opaque JSON string `{ v, phase, page, since, seen }`. Each `syncPage` reads ONE page
 * of ONE phase (issues, then events, then comments). `since` holds the watermarks the current pass
 * started from and never moves mid-pass; `seen` collects the newest timestamps read. Only a
 * completed pass folds `seen` into the next pass's `since`, so an interrupted pass resumes from the
 * last committed page and never skips an object. GitHub's `since` is inclusive, so a boundary
 * object is read again; the host's version-scoped dedupe absorbs it.
 */

const manifest = require('./papercusp.json');

const DESCRIPTOR = manifest.provider;
const API = 'https://api.github.com';
const PAGE_SIZE = 100;
/** Canonical ticket vocabulary names the issue tracker, not the plugin id. */
const TICKET_PROVIDER = 'github';
const PHASES = ['issues', 'events', 'comments'];
const TRANSITIONS = new Set(['closed', 'reopened']);

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function iso(value) {
  const raw = text(value);
  if (!raw) return undefined;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

function later(a, b) {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(b) > Date.parse(a) ? b : a;
}

function login(user) {
  return text(user && user.login) || undefined;
}

function syncError(kind, message, extra) {
  return Object.assign(new Error(message), { kind }, extra || {});
}

function repoOf(config) {
  const owner = text(config && config.owner);
  const repo = text(config && config.repo);
  if (!owner || !repo) throw syncError('transient', 'github_issues_repo_missing: source config needs owner and repo');
  return { owner, repo };
}

function ticketExternalId(owner, repo, number) {
  return `${owner}/${repo}#${number}`;
}

function freshCursor(since) {
  return { v: 1, phase: 'issues', page: 1, since: since || {}, seen: {} };
}

function decodeCursor(raw) {
  if (raw === null || raw === undefined || raw === '') return freshCursor();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw syncError('cursor-expired', 'github_issues_cursor_unreadable');
  }
  if (!parsed || parsed.v !== 1 || !PHASES.includes(parsed.phase) || !Number.isInteger(parsed.page) || parsed.page < 1) {
    throw syncError('cursor-expired', 'github_issues_cursor_unrecognised');
  }
  const obj = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {});
  return { v: 1, phase: parsed.phase, page: parsed.page, since: obj(parsed.since), seen: obj(parsed.seen) };
}

function lowerHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers || {})) out[key.toLowerCase()] = String(value);
  return out;
}

function rateLimitSeconds(headers) {
  const retryAfter = Number(headers['retry-after']);
  if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter;
  const reset = Number(headers['x-ratelimit-reset']);
  if (Number.isFinite(reset) && reset > 0) return Math.max(1, Math.ceil(reset - Date.now() / 1000));
  return 60;
}

/** GET one GitHub endpoint through host.fetch and map failures to the host's sync signals. */
async function getJson(host, source, url) {
  const response = await host.fetch({
    source,
    request: {
      url,
      method: 'GET',
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'papercusp-github-issues',
      },
    },
  });
  const headers = lowerHeaders(response.headers);
  const status = Number(response.status);
  const limited = status === 429
    || (status === 403 && (headers['x-ratelimit-remaining'] === '0' || headers['retry-after'] !== undefined));
  if (limited) {
    const retryAfterSeconds = rateLimitSeconds(headers);
    throw syncError('rate-limited', `github_rate_limited:${retryAfterSeconds}s`, { retryAfterSeconds });
  }
  if (status === 401 || status === 403 || status === 404) {
    throw syncError('auth', `github_access_denied:${status} ${url}`);
  }
  if (status < 200 || status >= 300) throw syncError('transient', `github_http_${status} ${url}`);
  const body = response.bodyEncoding === 'base64' ? Buffer.from(response.body, 'base64').toString('utf8') : response.body;
  try {
    return JSON.parse(body);
  } catch {
    throw syncError('transient', `github_body_not_json ${url}`);
  }
}

function listOf(data, url) {
  if (!Array.isArray(data)) throw syncError('transient', `github_list_expected ${url}`);
  return data;
}

/** GitHub's close reasons that mean "not done": the canonical `canceled` category. */
const CANCELED_REASONS = new Set(['not_planned', 'duplicate']);

/**
 * The canonical workflow category (migration 1377) for a GitHub issue. GitHub has only
 * open/closed: open is `todo`; closed is `done` unless its reason says it was dropped.
 */
function statusCategoryOf(issue) {
  if (text(issue.state) !== 'closed') return 'todo';
  return CANCELED_REASONS.has(text(issue.state_reason)) ? 'canceled' : 'done';
}

/** The canonical `ticket` payload for one GitHub issue. */
function issueToTicket(owner, repo, issue) {
  const number = Number(issue.number);
  const labels = (issue.labels || [])
    .map((label) => (typeof label === 'string' ? text(label) : text(label && label.name)))
    .filter(Boolean);
  const assignees = (issue.assignees || []).map(login).filter(Boolean);
  const payload = {
    provider: TICKET_PROVIDER,
    externalId: ticketExternalId(owner, repo, number),
    container: `${owner}/${repo}`,
    number,
    title: typeof issue.title === 'string' ? issue.title : '',
    body: typeof issue.body === 'string' ? issue.body : '',
    state: text(issue.state) === 'closed' ? 'closed' : 'open',
    statusCategory: statusCategoryOf(issue),
    assignees,
    labels,
  };
  const optional = {
    stateReason: text(issue.state_reason) || undefined,
    author: login(issue.user),
    url: text(issue.html_url) || undefined,
    createdAt: iso(issue.created_at),
    updatedAt: iso(issue.updated_at),
    closedAt: iso(issue.closed_at),
  };
  for (const [key, value] of Object.entries(optional)) if (value) payload[key] = value;
  return payload;
}

function commentIssueNumber(comment) {
  const match = /\/issues\/(\d+)$/.exec(text(comment.issue_url));
  return match ? Number(match[1]) : null;
}

function repoPath(owner, repo) {
  return `${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

async function readIssues(host, source, owner, repo, cursor) {
  const since = cursor.since.issues ? `&since=${encodeURIComponent(cursor.since.issues)}` : '';
  const url = `${repoPath(owner, repo)}/issues?state=all&sort=updated&direction=asc&per_page=${PAGE_SIZE}&page=${cursor.page}${since}`;
  const data = listOf(await getJson(host, source, url), url);
  const records = [];
  for (const issue of data) {
    cursor.seen.issues = later(cursor.seen.issues, iso(issue.updated_at));
    if (issue.pull_request || !Number.isInteger(issue.number)) continue;
    const ticket = issueToTicket(owner, repo, issue);
    records.push({
      datatype: 'ticket',
      nativeId: ticket.externalId,
      event: 'issue-updated',
      payload: ticket,
      ...(ticket.updatedAt ? { occurredAt: ticket.updatedAt } : {}),
    });
    records.push({
      datatype: 'ticket-status-change',
      nativeId: `opened:${ticket.externalId}`,
      event: 'issue-opened',
      payload: {
        provider: TICKET_PROVIDER,
        externalId: `opened:${ticket.externalId}`,
        ticketExternalId: ticket.externalId,
        transition: 'opened',
        ...(ticket.author ? { actor: ticket.author } : {}),
        ...(ticket.createdAt ? { occurredAt: ticket.createdAt } : {}),
      },
      ...(ticket.createdAt ? { occurredAt: ticket.createdAt } : {}),
    });
  }
  return { records, done: data.length < PAGE_SIZE };
}

async function readEvents(host, source, owner, repo, cursor) {
  // Newest first, so paging stops at the first event older than the pass's watermark.
  const url = `${repoPath(owner, repo)}/issues/events?per_page=${PAGE_SIZE}&page=${cursor.page}`;
  const data = listOf(await getJson(host, source, url), url);
  const records = [];
  const watermark = cursor.since.events ? Date.parse(cursor.since.events) : null;
  let reachedWatermark = false;
  for (const event of data) {
    const at = iso(event.created_at);
    if (watermark !== null && at && Date.parse(at) < watermark) {
      reachedWatermark = true;
      break;
    }
    cursor.seen.events = later(cursor.seen.events, at);
    const transition = text(event.event);
    const number = event.issue && event.issue.number;
    if (!TRANSITIONS.has(transition) || (event.issue && event.issue.pull_request) || !Number.isInteger(number) || event.id == null) continue;
    const ticketId = ticketExternalId(owner, repo, number);
    records.push({
      datatype: 'ticket-status-change',
      nativeId: `event:${event.id}`,
      event: `issue-${transition}`,
      payload: {
        provider: TICKET_PROVIDER,
        externalId: String(event.id),
        ticketExternalId: ticketId,
        transition,
        ...(text(event.state_reason) ? { stateReason: text(event.state_reason) } : {}),
        ...(login(event.actor) ? { actor: login(event.actor) } : {}),
        ...(at ? { occurredAt: at } : {}),
      },
      ...(at ? { occurredAt: at } : {}),
    });
  }
  return { records, done: reachedWatermark || data.length < PAGE_SIZE };
}

async function readComments(host, source, owner, repo, cursor) {
  const since = cursor.since.comments ? `&since=${encodeURIComponent(cursor.since.comments)}` : '';
  const url = `${repoPath(owner, repo)}/issues/comments?sort=updated&direction=asc&per_page=${PAGE_SIZE}&page=${cursor.page}${since}`;
  const data = listOf(await getJson(host, source, url), url);
  const records = [];
  for (const comment of data) {
    const updatedAt = iso(comment.updated_at);
    cursor.seen.comments = later(cursor.seen.comments, updatedAt);
    const number = commentIssueNumber(comment);
    // A pull-request comment's issue_url still says /issues/N; its html_url says /pull/N.
    if (number === null || comment.id == null || /\/pull\/\d+/.test(text(comment.html_url))) continue;
    const author = login(comment.user);
    const createdAt = iso(comment.created_at);
    records.push({
      datatype: 'ticket-comment',
      nativeId: `comment:${comment.id}`,
      event: 'issue-comment',
      payload: {
        provider: TICKET_PROVIDER,
        externalId: String(comment.id),
        ticketExternalId: ticketExternalId(owner, repo, number),
        text: typeof comment.body === 'string' ? comment.body : '',
        ...(author ? { author } : {}),
        ...(text(comment.html_url) ? { url: text(comment.html_url) } : {}),
        ...(createdAt ? { occurredAt: createdAt } : {}),
        ...(updatedAt ? { updatedAt } : {}),
      },
      ...((updatedAt || createdAt) ? { occurredAt: updatedAt || createdAt } : {}),
    });
  }
  return { records, done: data.length < PAGE_SIZE };
}

const READERS = { issues: readIssues, events: readEvents, comments: readComments };

async function syncPage(request, host) {
  const { owner, repo } = repoOf(request.config);
  const cursor = decodeCursor(request.cursor);
  const { records, done } = await READERS[cursor.phase](host, request.source, owner, repo, cursor);
  if (!done) {
    return { records, nextCursor: JSON.stringify({ ...cursor, page: cursor.page + 1 }), hasMore: true };
  }
  const nextPhase = PHASES[PHASES.indexOf(cursor.phase) + 1];
  if (nextPhase) {
    return { records, nextCursor: JSON.stringify({ ...cursor, phase: nextPhase, page: 1 }), hasMore: true };
  }
  // Pass complete: fold what this pass saw into the next pass's watermarks.
  const since = {};
  for (const phase of PHASES) {
    const value = later(cursor.since[phase], cursor.seen[phase]);
    if (value) since[phase] = value;
  }
  return { records, nextCursor: JSON.stringify(freshCursor(since)), hasMore: false };
}

function parseTicketRef(args) {
  const externalId = text(args && args.externalId);
  const match = /^([^/\s#]+)\/([^/\s#]+)#(\d+)$/.exec(externalId);
  if (match) return { owner: match[1], repo: match[2], number: Number(match[3]) };
  const owner = text(args && args.owner);
  const repo = text(args && args.repo);
  const number = Number(args && args.number);
  if (owner && repo && Number.isInteger(number) && number > 0) return { owner, repo, number };
  throw new Error('ticket_ref_invalid: pass { externalId: "owner/repo#N" } or { owner, repo, number }');
}

/** POST one JSON body to GitHub through host.fetch; a non-2xx reply is a named write failure. */
async function postJson(host, source, url, payload) {
  const response = await host.fetch({
    source,
    request: {
      url,
      method: 'POST',
      headers: {
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'papercusp-github-issues',
      },
      body: JSON.stringify(payload),
    },
  });
  const status = Number(response.status);
  if (status < 200 || status >= 300) throw new Error(`github_write_failed:${status} ${url}`);
  const body = response.bodyEncoding === 'base64' ? Buffer.from(response.body, 'base64').toString('utf8') : response.body;
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`github_body_not_json ${url}`);
  }
}

async function readTicket(request, host) {
  const { owner, repo, number } = parseTicketRef(request.args);
  const url = `${repoPath(owner, repo)}/issues/${number}`;
  const issue = await getJson(host, request.source, url);
  if (!issue || typeof issue !== 'object' || issue.pull_request) throw new Error(`ticket_not_found:${owner}/${repo}#${number}`);
  return { ticket: issueToTicket(owner, repo, issue) };
}

/** `ticket.comment { externalId, text }`: one plain comment; only the text is sent. */
async function commentOnTicket(request, host) {
  const { owner, repo, number } = parseTicketRef(request.args);
  const body = typeof (request.args && request.args.text) === 'string' ? request.args.text.trim() : '';
  if (!body) throw new Error('ticket_comment_text_required');
  const url = `${repoPath(owner, repo)}/issues/${number}/comments`;
  const comment = await postJson(host, request.source, url, { body });
  if (!comment || comment.id == null) throw new Error(`github_comment_id_missing ${url}`);
  return {
    externalRef: text(comment.html_url) || String(comment.id),
    // The nativeId the comment sync phase reports for this same comment (readComments).
    updateId: `comment:${comment.id}`,
  };
}

const INVOKERS = { 'ticket.read': readTicket, 'ticket.comment': commentOnTicket };

async function invoke(request, host) {
  const handler = DESCRIPTOR.capabilities.includes(request.capability) ? INVOKERS[request.capability] : undefined;
  if (!handler) throw new Error(`provider_capability_unsupported:${request.capability}`);
  return handler(request, host);
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
};
