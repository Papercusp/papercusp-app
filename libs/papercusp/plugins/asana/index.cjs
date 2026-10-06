'use strict';
/**
 * Asana provider (plan linear-asana-task-sync-2026-10-05, P-005; decisions D-002, D-004, D-008, D-011).
 *
 * A ticket provider on the integration provider contract. The host's connector driver calls
 * `syncPage` and owns everything stateful (lease, cursor commit, dedupe, retry, routing); this
 * module only maps Asana's REST API into canonical records:
 *   - a task                         -> `ticket` (nativeId = task gid; a task multi-homed in two
 *                                       configured projects is one ticket, deduped on that gid)
 *   - first sight of a ticket        -> `ticket-status-change` `opened` (nativeId `opened:<gid>`)
 *   - a marked_complete / marked_incomplete / section_changed story
 *                                    -> `ticket-status-change` (nativeId `story:<gid>`)
 *   - a comment story                -> `ticket-comment` (nativeId `story:<gid>`)
 *
 * Columns: a completed task is `done`; an open task takes the column its section in the task's
 * container project is mapped to by the source config `sectionCategories` (keyed by section gid or
 * name), else `todo`. The coarse open/closed `state` derives from the column, as in
 * packages/operator-core/lib/data-sources/ticket-vocabulary.ts (restated: plugins are
 * self-contained CommonJS).
 *
 * Sync (per configured project, in config order):
 *   - BACKFILL crawls the project's tasks page by page. Before the first page it takes a fresh
 *     Events sync token for the project (Asana answers a token-less request with 412 + a token), so
 *     any change made during the crawl is replayed by the first incremental pass; the host's
 *     version-scoped dedupe absorbs the overlap.
 *   - INCREMENTAL reads the project's events since its token, re-reads every task an event touched
 *     (a story event names its task as the parent), and advances the token.
 *   - A 412 on an incremental read means Asana dropped the token: `cursor-expired`, which the driver
 *     answers by restarting the source as a backfill (re-crawl, new tokens).
 *
 * Writes (D-008): `ticket.comment` -> a comment story, returning `updateId` = `story:<gid>`, the
 * nativeId the sync reports for it. `ticket.transition { toCategory }` -> done/canceled complete the
 * task; an open column reopens a completed task and moves it to the first section of its container
 * project mapped to that column. Asana has no state for an open column no section is mapped to, so
 * that move is a no-op (`changed: false`).
 *
 * The only network path is `host.fetch` (https://app.asana.com/api/1.0), which enforces the
 * declared egress host and injects the source account's token. Nothing here sees a credential,
 * imports host code, or writes a table.
 *
 * Cursor: one opaque JSON string `{ v, projects, project, phase, offset, tokens, fresh }`. `tokens`
 * holds each project's committed sync token; `fresh` holds the tokens taken during the current crawl
 * and becomes `tokens` only when the crawl of every project completes.
 */

const manifest = require('./papercusp.json');

const DESCRIPTOR = manifest.provider;
const API = 'https://app.asana.com/api/1.0';
/** Tasks per crawl page; each task costs one more request for its stories. */
const TASK_PAGE = 50;
const STORY_PAGE = 100;
const TICKET_PROVIDER = 'asana';

const CATEGORIES = new Set(['triage', 'backlog', 'todo', 'in-progress', 'in-review', 'done', 'canceled']);
const CLOSED_CATEGORIES = new Set(['done', 'canceled']);

const TASK_FIELDS = [
  'name', 'notes', 'completed', 'completed_at', 'created_at', 'modified_at', 'due_on', 'due_at',
  'permalink_url', 'assignee.name', 'created_by.name', 'parent.name', 'tags.name',
  'memberships.project.name', 'memberships.section.name',
].join(',');
const STORY_FIELDS = ['created_at', 'created_by.name', 'resource_subtype', 'text', 'old_section.name', 'new_section.name'].join(',');
const EVENT_FIELDS = ['action', 'created_at', 'resource', 'parent', 'type'].join(',');
const SECTION_FIELDS = 'name';

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function iso(value) {
  const raw = text(value);
  if (!raw) return undefined;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

function syncError(kind, message, extra) {
  return Object.assign(new Error(message), { kind }, extra || {});
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

function projectsOf(config) {
  const raw = config && config.projectGids;
  return Array.isArray(raw) ? [...new Set(raw.map(text).filter(Boolean))] : [];
}

/** `sectionCategories`, keyed by lower-cased section gid or name; unknown columns are dropped. */
function sectionMapOf(config) {
  const byKey = new Map();
  const mapping = config && config.sectionCategories;
  if (mapping && typeof mapping === 'object' && !Array.isArray(mapping)) {
    for (const [key, category] of Object.entries(mapping)) {
      if (CATEGORIES.has(category) && text(key)) byKey.set(text(key).toLowerCase(), category);
    }
  }
  return byKey;
}

/** The sync config, normalised: projects in config order (required), section mapping. */
function configOf(config) {
  const projects = projectsOf(config);
  if (projects.length === 0) throw syncError('transient', 'asana_projects_missing: source config needs projectGids');
  return { projects, sections: sectionMapOf(config) };
}

/** The config a write needs: the section mapping, and the projects when the source has them. */
function writeConfigOf(config) {
  return { projects: projectsOf(config), sections: sectionMapOf(config) };
}

/** The column a section is mapped to (by gid, then by name), or null. */
function sectionCategory(cfg, section) {
  if (!section) return null;
  return cfg.sections.get(text(section.gid).toLowerCase()) || cfg.sections.get(text(section.name).toLowerCase()) || null;
}

/**
 * The membership the ticket is filed under: the first CONFIGURED project (config order) the task
 * belongs to, else its first membership. Deterministic, so a multi-homed task read through either
 * project maps to the same ticket.
 */
function containerMembership(task, cfg) {
  const memberships = Array.isArray(task.memberships) ? task.memberships.filter((m) => m && m.project && text(m.project.gid)) : [];
  for (const gid of cfg.projects) {
    const hit = memberships.find((m) => text(m.project.gid) === gid);
    if (hit) return hit;
  }
  return memberships[0] || null;
}

function categoryOfTask(task, cfg, membership) {
  if (task.completed === true) return 'done';
  return sectionCategory(cfg, membership && membership.section) || 'todo';
}

/** `YYYY-MM-DD` due date -> ISO instant at midnight UTC. */
function dueAtOf(task) {
  const exact = iso(task.due_at);
  if (exact) return exact;
  const day = text(task.due_on);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? iso(`${day}T00:00:00Z`) : undefined;
}

function nameOf(ref) {
  return text(ref && ref.name) || undefined;
}

/** The canonical `ticket` payload for one Asana task. */
function taskToTicket(task, cfg) {
  const membership = containerMembership(task, cfg);
  const category = categoryOfTask(task, cfg, membership);
  const assignee = nameOf(task.assignee);
  const projectNames = [];
  for (const m of Array.isArray(task.memberships) ? task.memberships : []) {
    const name = nameOf(m && m.project);
    if (name && !projectNames.includes(name)) projectNames.push(name);
  }
  const sectionName = nameOf(membership && membership.section);
  const payload = {
    provider: TICKET_PROVIDER,
    externalId: text(task.gid),
    container: nameOf(membership && membership.project) || text(membership && membership.project && membership.project.gid),
    title: typeof task.name === 'string' ? task.name : '',
    body: typeof task.notes === 'string' ? task.notes : '',
    state: stateForCategory(category),
    statusCategory: category,
    assignees: assignee ? [assignee] : [],
    labels: (Array.isArray(task.tags) ? task.tags : []).map(nameOf).filter(Boolean),
  };
  const optional = {
    statusName: task.completed === true ? 'Completed' : sectionName,
    section: sectionName,
    projects: projectNames.length > 0 ? projectNames : undefined,
    dueAt: dueAtOf(task),
    parentExternalId: text(task.parent && task.parent.gid) || undefined,
    author: nameOf(task.created_by),
    url: text(task.permalink_url) || undefined,
    createdAt: iso(task.created_at),
    updatedAt: iso(task.modified_at),
    closedAt: task.completed === true ? iso(task.completed_at) : undefined,
  };
  for (const [key, value] of Object.entries(optional)) if (value !== undefined) payload[key] = value;
  return payload;
}

/** The `opened` change every ticket gets on first sight. */
function openedRecord(ticket) {
  return {
    datatype: 'ticket-status-change',
    nativeId: `opened:${ticket.externalId}`,
    event: 'task-opened',
    payload: {
      provider: TICKET_PROVIDER,
      externalId: `opened:${ticket.externalId}`,
      ticketExternalId: ticket.externalId,
      transition: 'opened',
      ...(ticket.author ? { actor: ticket.author } : {}),
      ...(ticket.createdAt ? { occurredAt: ticket.createdAt } : {}),
    },
    ...(ticket.createdAt ? { occurredAt: ticket.createdAt } : {}),
  };
}

/** A status change or comment for one story, or null for a story that is neither. */
function storyRecord(story, ticket, cfg) {
  const gid = text(story && story.gid);
  if (!gid) return null;
  const nativeId = `story:${gid}`;
  const occurredAt = iso(story.created_at);
  const actor = nameOf(story.created_by);
  const at = occurredAt ? { occurredAt } : {};
  const subtype = text(story.resource_subtype);
  if (subtype === 'comment_added') {
    return {
      datatype: 'ticket-comment',
      nativeId,
      event: 'task-comment',
      payload: {
        provider: TICKET_PROVIDER,
        externalId: gid,
        ticketExternalId: ticket.externalId,
        text: typeof story.text === 'string' ? story.text : '',
        ...(actor ? { author: actor } : {}),
        ...(ticket.url ? { url: ticket.url } : {}),
        ...at,
      },
      ...at,
    };
  }
  let change = null;
  if (subtype === 'marked_complete') {
    change = { transition: 'closed', toCategory: 'done' };
  } else if (subtype === 'marked_incomplete') {
    change = { transition: 'reopened', fromCategory: 'done' };
  } else if (subtype === 'section_changed') {
    const fromName = nameOf(story.old_section);
    const toName = nameOf(story.new_section);
    const from = sectionCategory(cfg, story.old_section);
    const to = sectionCategory(cfg, story.new_section);
    // Both columns known: the vocabulary's transition; otherwise a board move between sections.
    const transition = from && to && from !== to ? transitionBetween(from, to) : fromName !== toName ? 'moved' : null;
    if (!transition) return null;
    change = {
      transition,
      ...(from ? { fromCategory: from } : {}),
      ...(to ? { toCategory: to } : {}),
      ...(fromName ? { fromStatusName: fromName } : {}),
      ...(toName ? { toStatusName: toName } : {}),
    };
  }
  if (!change) return null;
  return {
    datatype: 'ticket-status-change',
    nativeId,
    event: 'task-status-changed',
    payload: {
      provider: TICKET_PROVIDER,
      externalId: nativeId,
      ticketExternalId: ticket.externalId,
      ...change,
      ...(actor ? { actor } : {}),
      ...at,
    },
    ...at,
  };
}

function lowerHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers || {})) out[key.toLowerCase()] = String(value);
  return out;
}

function queryString(query) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query || {})) if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

function firstErrorMessage(body) {
  const errors = body && Array.isArray(body.errors) ? body.errors : [];
  return errors.map((e) => text(e && e.message)).filter(Boolean)[0] || '';
}

/**
 * One REST call through host.fetch. Returns `{ status, body }` for 2xx and for the statuses the
 * caller handles itself (`allow`); maps rate limits, auth failures and everything else onto the
 * host's sync signals.
 */
async function rest(host, source, method, path, opts) {
  const options = opts || {};
  const response = await host.fetch({
    source,
    request: {
      url: `${API}${path}${queryString(options.query)}`,
      method,
      headers: {
        accept: 'application/json',
        'user-agent': 'papercusp-asana',
        ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    },
  });
  const headers = lowerHeaders(response.headers);
  const status = Number(response.status);
  const raw = response.bodyEncoding === 'base64' ? Buffer.from(response.body, 'base64').toString('utf8') : response.body;
  let body = null;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    body = null;
  }
  if (status === 429) {
    const retryAfter = Number(headers['retry-after']);
    const retryAfterSeconds = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.ceil(retryAfter) : 60;
    throw syncError('rate-limited', `asana_rate_limited:${retryAfterSeconds}s`, { retryAfterSeconds });
  }
  if (status === 401 || status === 403) {
    throw syncError('auth', `asana_access_denied:${status}${firstErrorMessage(body) ? `: ${firstErrorMessage(body)}` : ''}`);
  }
  if ((options.allow || []).includes(status) || (status >= 200 && status < 300)) {
    if (status >= 200 && status < 300 && (!body || typeof body !== 'object')) {
      if (status === 204 || options.emptyOk) return { status, body: {} };
      throw syncError('transient', `asana_body_not_json:${method} ${path}`);
    }
    return { status, body: body || {} };
  }
  const detail = firstErrorMessage(body);
  throw syncError('transient', `asana_http_${status}:${method} ${path}${detail ? `: ${detail}` : ''}`);
}

/** A fresh Events sync token for a project: Asana answers a token-less read with 412 + a token. */
async function newSyncToken(host, source, project) {
  const res = await rest(host, source, 'GET', '/events', { query: { resource: project }, allow: [412] });
  const token = text(res.body && res.body.sync);
  if (!token) throw syncError('transient', `asana_sync_token_missing:${project}`);
  return token;
}

async function readStories(host, source, taskGid) {
  const stories = [];
  let offset;
  for (let page = 0; page < 50; page++) {
    const res = await rest(host, source, 'GET', `/tasks/${encodeURIComponent(taskGid)}/stories`, {
      query: { limit: STORY_PAGE, opt_fields: STORY_FIELDS, offset },
    });
    stories.push(...(Array.isArray(res.body.data) ? res.body.data : []));
    offset = text(res.body.next_page && res.body.next_page.offset);
    if (!offset) break;
  }
  return stories;
}

/** Every record for one task: its ticket, `opened`, and each status-change or comment story. */
async function taskRecords(host, source, task, cfg) {
  if (!task || !text(task.gid)) return [];
  const ticket = taskToTicket(task, cfg);
  const records = [{
    datatype: 'ticket',
    nativeId: ticket.externalId,
    event: 'task-updated',
    payload: ticket,
    ...(ticket.updatedAt ? { occurredAt: ticket.updatedAt } : {}),
  }, openedRecord(ticket)];
  for (const story of await readStories(host, source, ticket.externalId)) {
    const record = storyRecord(story, ticket, cfg);
    if (record) records.push(record);
  }
  return records;
}

function freshCursor(projects, tokens) {
  return { v: 1, projects, project: 0, phase: 'crawl', offset: null, tokens: tokens || {}, fresh: {} };
}

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
}

/**
 * Decode the opaque cursor. A cursor written for a different project list (the source config
 * changed) starts a fresh crawl: the new projects need one and the old ones are deduped.
 */
function decodeCursor(raw, projects) {
  if (raw === null || raw === undefined || raw === '') return freshCursor(projects);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw syncError('cursor-expired', 'asana_cursor_unreadable');
  }
  if (
    !parsed || parsed.v !== 1 || !Array.isArray(parsed.projects) || !['crawl', 'events'].includes(parsed.phase)
    || !Number.isInteger(parsed.project) || parsed.project < 0
    || (parsed.offset !== null && typeof parsed.offset !== 'string')
  ) {
    throw syncError('cursor-expired', 'asana_cursor_unrecognised');
  }
  if (parsed.projects.join('\n') !== projects.join('\n')) return freshCursor(projects);
  if (parsed.project >= projects.length) throw syncError('cursor-expired', 'asana_cursor_unrecognised');
  return {
    v: 1, projects, project: parsed.project, phase: parsed.phase, offset: parsed.offset,
    tokens: plainObject(parsed.tokens), fresh: plainObject(parsed.fresh),
  };
}

async function crawlPage(host, source, cursor, cfg) {
  const project = cursor.projects[cursor.project];
  const fresh = { ...cursor.fresh };
  if (cursor.offset === null) fresh[project] = await newSyncToken(host, source, project);
  const path = `/projects/${encodeURIComponent(project)}/tasks`;
  const query = { limit: TASK_PAGE, opt_fields: TASK_FIELDS };
  let res = await rest(host, source, 'GET', path, { query: { ...query, offset: cursor.offset }, allow: cursor.offset ? [400] : [] });
  if (res.status === 400) {
    // Asana offsets expire; restart this project's crawl (its token is unchanged, the replay dedupes).
    res = await rest(host, source, 'GET', path, { query });
  }
  const records = [];
  for (const task of Array.isArray(res.body.data) ? res.body.data : []) records.push(...await taskRecords(host, source, task, cfg));
  const offset = text(res.body.next_page && res.body.next_page.offset);
  if (offset) return { records, nextCursor: JSON.stringify({ ...cursor, fresh, offset }), hasMore: true };
  if (cursor.project + 1 < cursor.projects.length) {
    return { records, nextCursor: JSON.stringify({ ...cursor, fresh, project: cursor.project + 1, offset: null }), hasMore: true };
  }
  // Crawl complete: the tokens taken before each project's crawl become the incremental starting points.
  const done = { v: 1, projects: cursor.projects, project: 0, phase: 'events', offset: null, tokens: { ...cursor.tokens, ...fresh }, fresh: {} };
  return { records, nextCursor: JSON.stringify(done), hasMore: false };
}

/** Task gids an event touched: the task itself, or the task a story event belongs to. */
function touchedTasks(events) {
  const gids = [];
  for (const event of events) {
    const resource = (event && event.resource) || {};
    const parent = (event && event.parent) || {};
    const gid = text(resource.resource_type) === 'task' ? text(resource.gid)
      : text(resource.resource_type) === 'story' && text(parent.resource_type) === 'task' ? text(parent.gid)
        : '';
    if (gid && !gids.includes(gid)) gids.push(gid);
  }
  return gids;
}

async function eventsPage(host, source, cursor, cfg) {
  const project = cursor.projects[cursor.project];
  const token = text(cursor.tokens[project]);
  if (!token) throw syncError('cursor-expired', `asana_sync_token_absent:${project}`);
  const res = await rest(host, source, 'GET', '/events', {
    query: { resource: project, sync: token, opt_fields: EVENT_FIELDS },
    allow: [412],
  });
  if (res.status === 412) throw syncError('cursor-expired', `asana_sync_token_expired:${project}`);
  const next = text(res.body.sync);
  if (!next) throw syncError('transient', `asana_sync_token_missing:${project}`);
  const records = [];
  for (const gid of touchedTasks(Array.isArray(res.body.data) ? res.body.data : [])) {
    const task = await rest(host, source, 'GET', `/tasks/${encodeURIComponent(gid)}`, { query: { opt_fields: TASK_FIELDS }, allow: [404] });
    if (task.status === 404) continue; // deleted since the event: nothing to re-read
    records.push(...await taskRecords(host, source, task.body.data, cfg));
  }
  const tokens = { ...cursor.tokens, [project]: next };
  if (res.body.has_more === true) return { records, nextCursor: JSON.stringify({ ...cursor, tokens }), hasMore: true };
  if (cursor.project + 1 < cursor.projects.length) {
    return { records, nextCursor: JSON.stringify({ ...cursor, tokens, project: cursor.project + 1 }), hasMore: true };
  }
  return { records, nextCursor: JSON.stringify({ ...cursor, tokens, project: 0 }), hasMore: false };
}

async function syncPage(request, host) {
  const cfg = configOf(request.config);
  const cursor = decodeCursor(request.cursor, cfg.projects);
  return cursor.phase === 'crawl' ? crawlPage(host, request.source, cursor, cfg) : eventsPage(host, request.source, cursor, cfg);
}

function taskGidOf(args) {
  const gid = text(args && args.externalId);
  if (!gid) throw new Error('ticket_ref_invalid: pass { externalId: "<Asana task gid>" }');
  return gid;
}

async function readTask(host, source, gid) {
  const res = await rest(host, source, 'GET', `/tasks/${encodeURIComponent(gid)}`, { query: { opt_fields: TASK_FIELDS }, allow: [404] });
  if (res.status === 404 || !res.body.data || !text(res.body.data.gid)) throw new Error(`ticket_not_found:${gid}`);
  return res.body.data;
}

async function readTicket(request, host) {
  const task = await readTask(host, request.source, taskGidOf(request.args));
  return { ticket: taskToTicket(task, writeConfigOf(request.config)) };
}

/** `ticket.comment { externalId, text }`: one comment story; only the text is sent. */
async function commentOnTicket(request, host) {
  const gid = taskGidOf(request.args);
  const body = typeof (request.args && request.args.text) === 'string' ? request.args.text.trim() : '';
  if (!body) throw new Error('ticket_comment_text_required');
  const res = await rest(host, request.source, 'POST', `/tasks/${encodeURIComponent(gid)}/stories`, { body: { data: { text: body } } });
  const story = res.body.data;
  if (!story || !text(story.gid)) throw new Error(`asana_comment_failed:${gid}`);
  return {
    externalRef: text(story.gid),
    // The nativeId the sync reports for this same comment (storyRecord).
    updateId: `story:${text(story.gid)}`,
  };
}

/** The first section (Asana's order) of `project` mapped to `category`, or null. */
async function targetSection(host, source, project, category, cfg) {
  const res = await rest(host, source, 'GET', `/projects/${encodeURIComponent(project)}/sections`, { query: { opt_fields: SECTION_FIELDS, limit: 100 } });
  const sections = Array.isArray(res.body.data) ? res.body.data : [];
  return sections.find((s) => s && text(s.gid) && sectionCategory(cfg, s) === category) || null;
}

/**
 * `ticket.transition { externalId, toCategory }`. Done/canceled complete the task (and move it to
 * a section mapped to that column, when one exists); an open column reopens a completed task and
 * moves it to the first section mapped to that column. Only completion and section travel: the
 * task's name, notes and assignee stay Asana's (D-004).
 */
async function transitionTicket(request, host) {
  const gid = taskGidOf(request.args);
  const toCategory = text(request.args && request.args.toCategory);
  if (!CATEGORIES.has(toCategory)) throw new Error(`transition_category_invalid:${toCategory}`);
  const cfg = writeConfigOf(request.config);
  const task = await readTask(host, request.source, gid);
  const membership = containerMembership(task, cfg);
  if (categoryOfTask(task, cfg, membership) === toCategory) return { changed: false, externalRef: gid };
  const project = text(membership && membership.project && membership.project.gid);
  const section = project ? await targetSection(host, request.source, project, toCategory, cfg) : null;
  const closing = CLOSED_CATEGORIES.has(toCategory);
  let changed = false;
  if (closing !== (task.completed === true)) {
    await rest(host, request.source, 'PUT', `/tasks/${encodeURIComponent(gid)}`, { body: { data: { completed: closing } } });
    changed = true;
  }
  const currentSection = text(membership && membership.section && membership.section.gid);
  if (section && text(section.gid) !== currentSection) {
    await rest(host, request.source, 'POST', `/sections/${encodeURIComponent(text(section.gid))}/addTask`, {
      body: { data: { task: gid } },
      emptyOk: true,
    });
    changed = true;
  }
  const toStatusName = closing ? 'Completed' : nameOf(section);
  return { changed, externalRef: gid, ...(toStatusName ? { toStatusName } : {}) };
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
  // Pure mappers and the requested field lists, exported for the tests only (no network, no host).
  _internal: {
    configOf, sectionCategory, taskToTicket, storyRecord, touchedTasks, decodeCursor, transitionBetween,
    fields: { task: TASK_FIELDS, story: STORY_FIELDS, event: EVENT_FIELDS, section: SECTION_FIELDS },
  },
};
