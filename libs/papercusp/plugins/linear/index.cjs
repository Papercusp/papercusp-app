'use strict';
/**
 * Linear provider (plan linear-asana-task-sync-2026-10-05, P-004; decisions D-002, D-005, D-008).
 *
 * A ticket provider on the integration provider contract. The host's connector driver calls
 * `syncPage` and owns everything stateful (lease, cursor commit, dedupe, retry, routing); this
 * module only maps Linear's GraphQL API into canonical records:
 *   - an issue                       -> `ticket` (nativeId = the issue's UUID, which survives a
 *                                       team move; the `ENG-12` identifier rides as `identifier`)
 *   - first sight of a ticket        -> `ticket-status-change` `opened` (nativeId `opened:<uuid>`)
 *   - a workflow-state history entry -> `ticket-status-change` (nativeId `history:<id>`)
 *   - an issue comment               -> `ticket-comment` (nativeId `comment:<id>`)
 *
 * Workflow states map onto the canonical columns by Linear's state TYPE (triage, backlog,
 * unstarted, started, completed, canceled); a started state whose name says "review" is
 * `in-review`. The coarse open/closed `state` derives from the column, as in
 * packages/operator-core/lib/data-sources/ticket-vocabulary.ts (restated here: plugins are
 * self-contained CommonJS).
 *
 * Writes (D-008): `ticket.comment` -> commentCreate, returning `updateId` = `comment:<id>`, the
 * nativeId the comment phase reports, so the host recognises its own comment when it comes back.
 * `ticket.transition { toCategory }` -> issueUpdate stateId, choosing the first workflow state
 * (by position) of the issue's team whose type maps to that column; an issue already in the
 * column is left alone (`changed: false`).
 *
 * Papercusp installs as a Linear app user (`actor=app`, scopes app:assignable/app:mentionable):
 * work is handed to it by delegation, not assignment (D-005), and the delegate rides on the
 * ticket as `delegates`.
 *
 * The only network path is `host.fetch` (POST https://api.linear.app/graphql), which enforces
 * the declared egress hosts and injects the source account's token. Nothing here sees a
 * credential, imports host code, or writes a table.
 *
 * Cursor: one opaque JSON string `{ v, teams, team, phase, after, since, seen }`. Each
 * `syncPage` reads ONE page of ONE phase (issues, then comments) of ONE team, in config order.
 * `since` holds the watermarks the current pass started from and never moves mid-pass; `seen`
 * collects the newest `updatedAt` read. Only a completed pass folds `seen` into the next pass's
 * `since`, so an interrupted pass resumes from the last committed page and never skips an
 * object. The watermark filter is inclusive (`gte`): a boundary object is read again and the
 * host's version-scoped dedupe absorbs it.
 */

const manifest = require('./papercusp.json');

const DESCRIPTOR = manifest.provider;
const API = 'https://api.linear.app/graphql';
const PAGE_SIZE = 50;
const HISTORY_PAGE = 50;
/** Canonical ticket vocabulary names the issue tracker. */
const TICKET_PROVIDER = 'linear';
const PHASES = ['issues', 'comments'];

const CLOSED_CATEGORIES = new Set(['done', 'canceled']);
/** Linear workflow-state type -> canonical column (a started "review" state is in-review). */
const TYPE_CATEGORY = {
  triage: 'triage',
  backlog: 'backlog',
  unstarted: 'todo',
  started: 'in-progress',
  completed: 'done',
  canceled: 'canceled',
  duplicate: 'canceled',
};
/** Canonical column -> the Linear state type a transition moves into. */
const CATEGORY_TYPE = {
  triage: 'triage',
  backlog: 'backlog',
  todo: 'unstarted',
  'in-progress': 'started',
  'in-review': 'started',
  done: 'completed',
  canceled: 'canceled',
};
const REVIEW_NAME = /review/i;

const USER_FIELDS = 'id name displayName';
const STATE_FIELDS = 'id name type';
const ISSUE_FIELDS = `
  id identifier number title description url priority priorityLabel estimate dueDate
  createdAt updatedAt completedAt canceledAt
  state { ${STATE_FIELDS} }
  team { id key }
  assignee { ${USER_FIELDS} }
  delegate { ${USER_FIELDS} }
  creator { ${USER_FIELDS} }
  parent { id }
  project { id name }
  labels { nodes { name } }
  history(first: ${HISTORY_PAGE}) {
    nodes { id createdAt fromState { ${STATE_FIELDS} } toState { ${STATE_FIELDS} } actor { ${USER_FIELDS} } }
  }`;

const ISSUES_QUERY = `query PapercuspIssues($filter: IssueFilter, $after: String) {
  issues(first: ${PAGE_SIZE}, after: $after, filter: $filter, orderBy: updatedAt) {
    nodes { ${ISSUE_FIELDS} }
    pageInfo { hasNextPage endCursor }
  }
}`;

const COMMENTS_QUERY = `query PapercuspComments($filter: CommentFilter, $after: String) {
  comments(first: ${PAGE_SIZE}, after: $after, filter: $filter, orderBy: updatedAt) {
    nodes { id body url createdAt updatedAt user { ${USER_FIELDS} } issue { id } }
    pageInfo { hasNextPage endCursor }
  }
}`;

const ISSUE_QUERY = `query PapercuspIssue($id: String!) {
  issue(id: $id) { ${ISSUE_FIELDS} }
}`;

const ISSUE_STATES_QUERY = `query PapercuspIssueStates($id: String!) {
  issue(id: $id) {
    id
    state { ${STATE_FIELDS} }
    team { id states { nodes { id name type position } } }
  }
}`;

const COMMENT_CREATE = `mutation PapercuspCommentCreate($input: CommentCreateInput!) {
  commentCreate(input: $input) { success comment { id url } }
}`;

const ISSUE_UPDATE = `mutation PapercuspIssueTransition($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) { success issue { id updatedAt state { ${STATE_FIELDS} } } }
}`;

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

function person(user) {
  return text(user && user.displayName) || text(user && user.name) || undefined;
}

function syncError(kind, message, extra) {
  return Object.assign(new Error(message), { kind }, extra || {});
}

function teamsOf(config) {
  const raw = config && config.teamIds;
  const teams = Array.isArray(raw) ? raw.map(text).filter(Boolean) : [];
  if (teams.length === 0) throw syncError('transient', 'linear_teams_missing: source config needs teamIds');
  return [...new Set(teams)];
}

/** The canonical column of a Linear workflow state, or null when it has none. */
function categoryOf(state) {
  if (!state || typeof state !== 'object') return null;
  const category = TYPE_CATEGORY[text(state.type)];
  if (!category) return null;
  return category === 'in-progress' && REVIEW_NAME.test(text(state.name)) ? 'in-review' : category;
}

function stateForCategory(category) {
  return CLOSED_CATEGORIES.has(category) ? 'closed' : 'open';
}

/** `ticket-status-change` transition between two columns (ticket-vocabulary.ts ticketTransitionBetween). */
function transitionBetween(from, to) {
  if (!from) return 'opened';
  if (from === to) return null;
  const before = stateForCategory(from);
  const after = stateForCategory(to);
  if (before === 'open' && after === 'closed') return 'closed';
  if (before === 'closed' && after === 'open') return 'reopened';
  return 'moved';
}

function freshCursor(teams, since) {
  return { v: 1, teams, team: 0, phase: 'issues', after: null, since: since || {}, seen: {} };
}

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
}

/**
 * Decode the opaque cursor. A cursor written for a different team list (the source config
 * changed) starts a fresh pass, keeping the watermarks of the teams that remain.
 */
function decodeCursor(raw, teams) {
  if (raw === null || raw === undefined || raw === '') return freshCursor(teams);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw syncError('cursor-expired', 'linear_cursor_unreadable');
  }
  if (
    !parsed || parsed.v !== 1 || !Array.isArray(parsed.teams) || !PHASES.includes(parsed.phase)
    || !Number.isInteger(parsed.team) || parsed.team < 0
    || (parsed.after !== null && typeof parsed.after !== 'string')
  ) {
    throw syncError('cursor-expired', 'linear_cursor_unrecognised');
  }
  const since = plainObject(parsed.since);
  if (parsed.teams.join('\n') !== teams.join('\n')) {
    const kept = {};
    for (const key of Object.keys(since)) if (teams.includes(key.split(':')[0])) kept[key] = since[key];
    return freshCursor(teams, kept);
  }
  if (parsed.team >= teams.length) throw syncError('cursor-expired', 'linear_cursor_unrecognised');
  return { v: 1, teams, team: parsed.team, phase: parsed.phase, after: parsed.after, since, seen: plainObject(parsed.seen) };
}

function lowerHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers || {})) out[key.toLowerCase()] = String(value);
  return out;
}

/** Seconds until Linear's limit resets: Retry-After, else the reset headers (epoch ms). */
function rateLimitSeconds(headers) {
  const retryAfter = Number(headers['retry-after']);
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.ceil(retryAfter);
  for (const key of ['x-ratelimit-requests-reset', 'x-ratelimit-complexity-reset', 'x-ratelimit-endpoint-requests-reset']) {
    const reset = Number(headers[key]);
    if (!Number.isFinite(reset) || reset <= 0) continue;
    const resetMs = reset < 1e12 ? reset * 1000 : reset;
    return Math.max(1, Math.ceil((resetMs - Date.now()) / 1000));
  }
  return 60;
}

/**
 * The error classes a GraphQL error names. Linear documents `extensions.code` (`RATELIMITED`), while
 * its own SDK classifies by `extensions.type` (`ratelimited`, `authentication error`, `forbidden`;
 * @linear/sdk errorMap). Both are read and normalised to one spelling (`AUTHENTICATION_ERROR`).
 */
function errorCodes(errors) {
  const codes = [];
  for (const e of errors) {
    const ext = (e && e.extensions) || {};
    for (const raw of [ext.code, ext.type]) {
      const code = text(raw).toUpperCase().replace(/\s+/g, '_');
      if (code) codes.push(code);
    }
  }
  return codes;
}

/** One GraphQL request through host.fetch, mapping failures to the host's sync signals. */
async function gql(host, source, query, variables) {
  const response = await host.fetch({
    source,
    request: {
      url: API,
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'papercusp-linear' },
      body: JSON.stringify({ query, variables }),
    },
  });
  const headers = lowerHeaders(response.headers);
  const status = Number(response.status);
  const raw = response.bodyEncoding === 'base64' ? Buffer.from(response.body, 'base64').toString('utf8') : response.body;
  let body = null;
  try {
    body = JSON.parse(raw);
  } catch {
    body = null;
  }
  const errors = body && Array.isArray(body.errors) ? body.errors : [];
  const codes = errorCodes(errors);
  if (status === 429 || codes.includes('RATELIMITED')) {
    const retryAfterSeconds = rateLimitSeconds(headers);
    throw syncError('rate-limited', `linear_rate_limited:${retryAfterSeconds}s`, { retryAfterSeconds });
  }
  if (status === 401 || status === 403 || codes.includes('AUTHENTICATION_ERROR') || codes.includes('FORBIDDEN')) {
    throw syncError('auth', `linear_access_denied:${status}${codes.length ? `:${codes.join(',')}` : ''}`);
  }
  if (status < 200 || status >= 300) throw syncError('transient', `linear_http_${status}`);
  if (!body || typeof body !== 'object') throw syncError('transient', 'linear_body_not_json');
  if (errors.length > 0 || !body.data) {
    const messages = errors.map((e) => text(e && e.message)).filter(Boolean).join('; ');
    throw syncError('transient', `linear_graphql_error: ${messages || 'no data'}`);
  }
  return body.data;
}

function connectionOf(data, field) {
  const conn = data && data[field];
  if (!conn || !Array.isArray(conn.nodes) || !conn.pageInfo) {
    throw syncError('transient', `linear_unexpected_shape:${field}`);
  }
  const endCursor = typeof conn.pageInfo.endCursor === 'string' ? conn.pageInfo.endCursor : null;
  return { nodes: conn.nodes, hasNextPage: conn.pageInfo.hasNextPage === true && endCursor !== null, endCursor };
}

/** `YYYY-MM-DD` due date -> ISO instant at midnight UTC. */
function dueAtOf(dueDate) {
  const raw = text(dueDate);
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? iso(`${raw}T00:00:00Z`) : undefined;
}

/** The canonical `ticket` payload for one Linear issue. */
function issueToTicket(issue) {
  const category = categoryOf(issue.state) || 'todo';
  const labels = ((issue.labels && issue.labels.nodes) || []).map((label) => text(label && label.name)).filter(Boolean);
  const assignee = person(issue.assignee);
  const delegate = person(issue.delegate);
  const level = Number(issue.priority);
  const payload = {
    provider: TICKET_PROVIDER,
    externalId: text(issue.id),
    container: text(issue.team && issue.team.key),
    number: Number(issue.number),
    title: typeof issue.title === 'string' ? issue.title : '',
    body: typeof issue.description === 'string' ? issue.description : '',
    state: stateForCategory(category),
    statusCategory: category,
    assignees: assignee ? [assignee] : [],
    labels,
  };
  const projectName = text(issue.project && issue.project.name);
  const optional = {
    identifier: text(issue.identifier) || undefined,
    statusName: text(issue.state && issue.state.name) || undefined,
    delegates: delegate ? [delegate] : undefined,
    priority: Number.isInteger(level) && level >= 0 && level <= 4
      ? { level, ...(text(issue.priorityLabel) ? { name: text(issue.priorityLabel) } : {}) }
      : undefined,
    estimate: typeof issue.estimate === 'number' && Number.isFinite(issue.estimate) ? issue.estimate : undefined,
    dueAt: dueAtOf(issue.dueDate),
    parentExternalId: text(issue.parent && issue.parent.id) || undefined,
    projects: projectName ? [projectName] : undefined,
    author: person(issue.creator),
    url: text(issue.url) || undefined,
    createdAt: iso(issue.createdAt),
    updatedAt: iso(issue.updatedAt),
    closedAt: CLOSED_CATEGORIES.has(category) ? iso(issue.completedAt) || iso(issue.canceledAt) : undefined,
  };
  for (const [key, value] of Object.entries(optional)) if (value !== undefined) payload[key] = value;
  return payload;
}

/** `ticket-status-change` records for one issue: `opened` on first sight, then each state move. */
function statusChangesOf(issue, ticket) {
  const records = [];
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
  const history = (issue.history && issue.history.nodes) || [];
  for (const entry of history) {
    if (!entry || !entry.id || !entry.toState) continue;
    const to = categoryOf(entry.toState);
    if (!to) continue;
    const from = categoryOf(entry.fromState);
    const fromName = text(entry.fromState && entry.fromState.name);
    const toName = text(entry.toState.name);
    // A move between two states of the same column is still a move a board shows.
    const transition = from === to ? (fromName && fromName !== toName ? 'moved' : null) : transitionBetween(from, to);
    if (!transition) continue;
    const occurredAt = iso(entry.createdAt);
    const actor = person(entry.actor);
    records.push({
      datatype: 'ticket-status-change',
      nativeId: `history:${entry.id}`,
      event: 'issue-state-changed',
      payload: {
        provider: TICKET_PROVIDER,
        externalId: `history:${entry.id}`,
        ticketExternalId: ticket.externalId,
        transition,
        ...(from ? { fromCategory: from } : {}),
        toCategory: to,
        ...(fromName ? { fromStatusName: fromName } : {}),
        ...(toName ? { toStatusName: toName } : {}),
        ...(actor ? { actor } : {}),
        ...(occurredAt ? { occurredAt } : {}),
      },
      ...(occurredAt ? { occurredAt } : {}),
    });
  }
  return records;
}

function watermarkKey(cursor, phase) {
  return `${cursor.teams[cursor.team]}:${phase}`;
}

function pageFilter(cursor, phase) {
  const teamId = cursor.teams[cursor.team];
  const since = cursor.since[watermarkKey(cursor, phase)];
  const team = { id: { eq: teamId } };
  const filter = phase === 'issues' ? { team } : { issue: { team } };
  if (since) filter.updatedAt = { gte: since };
  return filter;
}

async function readIssues(host, source, cursor) {
  const data = await gql(host, source, ISSUES_QUERY, { filter: pageFilter(cursor, 'issues'), after: cursor.after });
  const page = connectionOf(data, 'issues');
  const key = watermarkKey(cursor, 'issues');
  const records = [];
  for (const issue of page.nodes) {
    if (!issue || !text(issue.id)) continue;
    const ticket = issueToTicket(issue);
    cursor.seen[key] = later(cursor.seen[key], ticket.updatedAt);
    records.push({
      datatype: 'ticket',
      nativeId: ticket.externalId,
      event: 'issue-updated',
      payload: ticket,
      ...(ticket.updatedAt ? { occurredAt: ticket.updatedAt } : {}),
    });
    records.push(...statusChangesOf(issue, ticket));
  }
  return { records, page };
}

async function readComments(host, source, cursor) {
  const data = await gql(host, source, COMMENTS_QUERY, { filter: pageFilter(cursor, 'comments'), after: cursor.after });
  const page = connectionOf(data, 'comments');
  const key = watermarkKey(cursor, 'comments');
  const records = [];
  for (const comment of page.nodes) {
    if (!comment || !text(comment.id)) continue;
    const updatedAt = iso(comment.updatedAt);
    cursor.seen[key] = later(cursor.seen[key], updatedAt);
    const issueId = text(comment.issue && comment.issue.id);
    if (!issueId) continue;
    const author = person(comment.user);
    const createdAt = iso(comment.createdAt);
    records.push({
      datatype: 'ticket-comment',
      nativeId: `comment:${comment.id}`,
      event: 'issue-comment',
      payload: {
        provider: TICKET_PROVIDER,
        externalId: text(comment.id),
        ticketExternalId: issueId,
        text: typeof comment.body === 'string' ? comment.body : '',
        ...(author ? { author } : {}),
        ...(text(comment.url) ? { url: text(comment.url) } : {}),
        ...(createdAt ? { occurredAt: createdAt } : {}),
        ...(updatedAt ? { updatedAt } : {}),
      },
      ...((updatedAt || createdAt) ? { occurredAt: updatedAt || createdAt } : {}),
    });
  }
  return { records, page };
}

const READERS = { issues: readIssues, comments: readComments };

async function syncPage(request, host) {
  const teams = teamsOf(request.config);
  const cursor = decodeCursor(request.cursor, teams);
  const { records, page } = await READERS[cursor.phase](host, request.source, cursor);
  if (page.hasNextPage) {
    return { records, nextCursor: JSON.stringify({ ...cursor, after: page.endCursor }), hasMore: true };
  }
  const nextPhase = PHASES[PHASES.indexOf(cursor.phase) + 1];
  if (nextPhase) {
    return { records, nextCursor: JSON.stringify({ ...cursor, phase: nextPhase, after: null }), hasMore: true };
  }
  if (cursor.team + 1 < teams.length) {
    return {
      records,
      nextCursor: JSON.stringify({ ...cursor, team: cursor.team + 1, phase: PHASES[0], after: null }),
      hasMore: true,
    };
  }
  // Pass complete: fold what this pass saw into the next pass's watermarks.
  const since = { ...cursor.since };
  for (const [key, value] of Object.entries(cursor.seen)) since[key] = later(since[key], value);
  return { records, nextCursor: JSON.stringify(freshCursor(teams, since)), hasMore: false };
}

function issueIdOf(args) {
  const id = text(args && args.externalId);
  if (!id) throw new Error('ticket_ref_invalid: pass { externalId: "<Linear issue id>" }');
  return id;
}

async function readTicket(request, host) {
  const id = issueIdOf(request.args);
  const data = await gql(host, request.source, ISSUE_QUERY, { id });
  if (!data.issue || !text(data.issue.id)) throw new Error(`ticket_not_found:${id}`);
  return { ticket: issueToTicket(data.issue) };
}

/** `ticket.comment { externalId, text }`: one plain comment; only the text is sent. */
async function commentOnTicket(request, host) {
  const issueId = issueIdOf(request.args);
  const body = typeof (request.args && request.args.text) === 'string' ? request.args.text.trim() : '';
  if (!body) throw new Error('ticket_comment_text_required');
  const data = await gql(host, request.source, COMMENT_CREATE, { input: { issueId, body } });
  const result = data.commentCreate;
  if (!result || result.success !== true || !result.comment || !text(result.comment.id)) {
    throw new Error(`linear_comment_failed:${issueId}`);
  }
  return {
    externalRef: text(result.comment.url) || text(result.comment.id),
    // The nativeId the comment sync phase reports for this same comment (readComments).
    updateId: `comment:${result.comment.id}`,
  };
}

/**
 * The workflow state a transition to `category` moves into: the first state (by position) of the
 * team whose type maps to that column; for in-progress/in-review the review-named started states
 * are preferred or avoided accordingly.
 */
function targetState(states, category) {
  const type = CATEGORY_TYPE[category];
  if (!type) throw new Error(`transition_category_invalid:${category}`);
  const candidates = states
    .filter((s) => s && text(s.type) === type && text(s.id))
    .sort((a, b) => Number(a.position) - Number(b.position));
  if (type === 'started') {
    const review = candidates.filter((s) => REVIEW_NAME.test(text(s.name)));
    const work = candidates.filter((s) => !REVIEW_NAME.test(text(s.name)));
    return (category === 'in-review' ? review[0] || work[0] : work[0] || review[0]) || null;
  }
  return candidates[0] || null;
}

/** `ticket.transition { externalId, toCategory }`: move the issue to that column. */
async function transitionTicket(request, host) {
  const id = issueIdOf(request.args);
  const toCategory = text(request.args && request.args.toCategory);
  if (!CATEGORY_TYPE[toCategory]) throw new Error(`transition_category_invalid:${toCategory}`);
  const data = await gql(host, request.source, ISSUE_STATES_QUERY, { id });
  const issue = data.issue;
  if (!issue || !text(issue.id)) throw new Error(`ticket_not_found:${id}`);
  if (categoryOf(issue.state) === toCategory) {
    return { changed: false, externalRef: text(issue.id) };
  }
  const states = (issue.team && issue.team.states && issue.team.states.nodes) || [];
  const target = targetState(states, toCategory);
  if (!target) throw new Error(`linear_transition_no_state:${toCategory}`);
  const updated = await gql(host, request.source, ISSUE_UPDATE, { id: text(issue.id), input: { stateId: target.id } });
  const result = updated.issueUpdate;
  if (!result || result.success !== true) throw new Error(`linear_transition_failed:${id}`);
  return { changed: true, externalRef: text(issue.id), toStatusName: text(target.name) || undefined };
}

const INVOKERS = { 'ticket.read': readTicket, 'ticket.comment': commentOnTicket, 'ticket.transition': transitionTicket };

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
  // Pure mappers, exported for the unit test only (no network, no host).
  _internal: { categoryOf, transitionBetween, issueToTicket, statusChangesOf, targetState, decodeCursor, rateLimitSeconds },
};
