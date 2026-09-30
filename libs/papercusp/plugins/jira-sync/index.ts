/**
 * @papercupai/jira-sync — bidirectional background sync between a harness's
 * features/issues queues and a Jira Cloud project.
 *
 * Architecture (see docs/issue-tracker-sync.md):
 *
 *   - cron routine 'sync-tick' fires every 30s
 *   - webhook routine receives Jira issue.* webhooks (fast path)
 *   - lifecycle hook onPostValidator pushes status flips immediately
 *   - sync engine: pull both sides → diff by content hash → patch divergent
 *     fields with HARNESS WINS for canonical fields; remote-only metadata
 *     (assignee, priority, sprint) is mirrored read-only into a JSONB sidecar
 *
 * Two harness entity kinds map to Jira:
 *   feature → Jira issue (default issuetype = config.defaultIssueType)
 *   issue   → Jira issue with issuetype 'Bug' + label `papercusp-bug`
 *
 * State lives in Postgres schema `plugin_jira_sync` (see schema.sql).
 *
 * Status verbs are mapped harness↔Jira via config.statusMap. Default:
 *   harness 'todo'        ↔ Jira 'To Do'
 *   harness 'in_progress' ↔ Jira 'In Progress'
 *   harness 'passed'      ↔ Jira 'Done'
 *   harness 'failing'     ↔ Jira 'In Review'
 *   harness 'blocked'     ↔ Jira 'Blocked'
 *   harness 'done'        ↔ Jira 'Done'
 */

import type { Plugin, PapercuspContext } from '@papercusp/plugin-sdk';

// Resolve embedded-PG URL from discovery file. Returns null if no file.
function readDiscoveryUrl(role: 'app' | 'admin'): string | null {
  if (process.env.PAPERCUSP_SKIP_PG_DISCOVERY === '1') return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('node:fs') as typeof import('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const os = require('node:os') as typeof import('node:os');
    const raw = fs.readFileSync(`${os.homedir()}/.papercusp/embedded-pg.json`, 'utf8');
    const parsed = JSON.parse(raw) as { host?: string; port?: number; user?: string; password?: string };
    if (!parsed?.host || !parsed?.port) return null;
    if (role === 'admin' && parsed.user && parsed.password) {
      return `postgresql://${parsed.user}:${parsed.password}@${parsed.host}:${parsed.port}/papercusp`;
    }
    return `postgresql://harness_app:harness_app_pwd@${parsed.host}:${parsed.port}/papercusp`;
  } catch {
    return null;
  }
}

interface Config {
  defaultProjectKey?: string;
  defaultIssueType?: string;
  bugIssueType?: string;
  labelPrefix?: string;
  statusMap?: Record<string, string>;
  fullSyncIntervalSec?: number;
}

interface JiraCreds {
  token: string;
  email: string;
  baseUrl: string;
}

interface RemoteIssue {
  id: string;
  key: string;
  fields: {
    summary: string;
    description?: unknown;
    status?: { name: string };
    issuetype?: { name: string };
    labels?: string[];
    priority?: { name: string };
    assignee?: { displayName?: string; emailAddress?: string };
    updated: string;
  };
}

interface FeatureRow {
  feature_id: string;
  title: string;
  summary: string | null;
  status: string;
  tags: string[] | null;
  updated_ts: number;
}

interface IssueRow {
  issue_id: string;
  title: string;
  severity: string;
  status: string;
  repro: string | null;
  evidence: string | null;
  suggested_fix: string | null;
  linked_feature_id: string | null;
  updated_ts: number;
}

const DEFAULT_STATUS_MAP: Record<string, string> = {
  todo: 'To Do',
  in_progress: 'In Progress',
  passed: 'Done',
  failing: 'In Review',
  blocked: 'Blocked',
  done: 'Done',
};

/* ─────────────────────────────────────────────────────────────────────
 * Config / creds
 * ───────────────────────────────────────────────────────────────────── */

async function readConfig(ctx: PapercuspContext): Promise<Config> {
  const { promises: fs } = await import('node:fs');
  const { join } = await import('node:path');
  try {
    return JSON.parse(await fs.readFile(join(ctx.pluginDataDir, 'config.json'), 'utf8')) as Config;
  } catch {
    return {};
  }
}

function readCreds(): JiraCreds | null {
  const token = process.env.JIRA_API_TOKEN;
  const email = process.env.JIRA_EMAIL;
  const baseUrl = process.env.JIRA_BASE_URL;
  if (!token || !email || !baseUrl) return null;
  return { token, email, baseUrl: baseUrl.replace(/\/+$/, '') };
}

function authHeader(creds: JiraCreds): string {
  return 'Basic ' + Buffer.from(`${creds.email}:${creds.token}`).toString('base64');
}

async function jiraFetch(
  creds: JiraCreds,
  path: string,
  init: RequestInit & { signal?: AbortSignal } = {},
): Promise<Response> {
  return fetch(`${creds.baseUrl}/rest/api/3${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      authorization: authHeader(creds),
      accept: 'application/json',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
    },
  });
}

function adfDoc(text: string): unknown {
  return {
    type: 'doc',
    version: 1,
    content: text.split('\n\n').map((para) => ({
      type: 'paragraph',
      content: para ? [{ type: 'text', text: para }] : [],
    })),
  };
}

function adfToText(doc: unknown): string {
  if (!doc || typeof doc !== 'object') return '';
  const out: string[] = [];
  function walk(node: any) {
    if (!node) return;
    if (node.type === 'text' && typeof node.text === 'string') {
      out.push(node.text);
    } else if (node.type === 'paragraph') {
      (node.content ?? []).forEach(walk);
      out.push('\n');
    } else if (Array.isArray(node.content)) {
      node.content.forEach(walk);
    }
  }
  walk(doc);
  return out.join('').trim();
}

/* ─────────────────────────────────────────────────────────────────────
 * Postgres
 *
 * v1 talks to the same Postgres the harness uses (HARNESS_DATABASE_URL).
 * Plugin owns schema `plugin_jira_sync` and writes its state there;
 * reads cross-schema into `harness_<slug>.harness_features` /
 * `.harness_issues` for the local side of the diff.
 * ───────────────────────────────────────────────────────────────────── */

let _pgClient: any = null;
/**
 * WI-37473: the IN-FLIGHT build, memoized separately from the finished pool.
 *
 * `pg()` used to be `async` and guard on `_pgClient` alone, which put an `await
 * import('postgres')` between the check and the assignment. Every caller that
 * entered during that window saw `null`, passed the guard, and constructed its OWN
 * pool; only the last assignment was retained, so each loser's pool was left
 * unreferenced and never `.end()`-ed — its connections held against the shared
 * Postgres until process exit. With ~22 `await pg()` call sites, concurrent entry is
 * the normal case, not an edge case.
 *
 * The fix is to memoize the PROMISE and assign it SYNCHRONOUSLY, so no await sits
 * between check and set. Do NOT make `pg()` async again, and do NOT reintroduce an
 * `await` before `_pgClientPromise = …` — either change silently restores the race.
 */
let _pgClientPromise: Promise<any> | null = null;

async function buildPgClient(): Promise<any> {
  const postgres = (await import('postgres')).default;
  const url =
    process.env.HARNESS_ADMIN_DATABASE_URL ||
    process.env.HARNESS_DATABASE_URL ||
    readDiscoveryUrl('app') ||
    'postgresql://harness_app:harness_app_pwd@localhost:5432/papercusp';
  _pgClient = postgres(url, {
    onnotice: () => {},
    max: 2,
    idle_timeout: 30,
    // WI-6062: tag so this singleton pool is attributable in pg_stat_activity —
    // without it postgres-js's own 'postgres.js' default applies and the connection
    // is indistinguishable from every other untagged pool (a sandboxed plugin can't
    // import the shared @papercusp/db-org helper, so tag inline).
    connection: { application_name: `pcusp:jira-sync:p${process.pid}`.slice(0, 63) },
  });
  return _pgClient;
}

function pg(): Promise<any> {
  if (_pgClient) return Promise.resolve(_pgClient);
  if (_pgClientPromise) return _pgClientPromise;
  // Assigned synchronously — this is the line that closes the race.
  _pgClientPromise = buildPgClient().catch((err: unknown) => {
    // Let the next caller retry rather than inheriting a rejected memo.
    _pgClientPromise = null;
    throw err;
  });
  return _pgClientPromise;
}

function harnessSchema(slug: string): string {
  return 'harness_' + slug.replace(/-/g, '_');
}

async function ensureSchema(ctx: PapercuspContext): Promise<void> {
  const sql = await pg();
  const { promises: fs } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  // schema.sql sits next to this module
  const here = (typeof __dirname === 'string') ? __dirname : dirname((eval('import.meta.url') as string).replace('file://', ''));
  const ddl = await fs.readFile(join(here, 'schema.sql'), 'utf8');
  // postgres-js doesn't let us send a multi-statement string via sql``;
  // use sql.unsafe() for the migration only.
  await sql.unsafe(ddl);
  ctx.log('jira-sync: schema ensured');
}

async function ensureCursor(slug: string): Promise<void> {
  const sql = await pg();
  await sql`
    INSERT INTO plugin_jira_sync.cursors (harness_slug)
    VALUES (${slug})
    ON CONFLICT (harness_slug) DO NOTHING
  `;
}

/* ─────────────────────────────────────────────────────────────────────
 * Hashing
 *
 * Canonical-form hash = stable JSON of the fields we care about.
 * Hash equality means "no semantic change since last sync."
 * ───────────────────────────────────────────────────────────────────── */

async function sha256(s: string): Promise<string> {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(s).digest('hex');
}

function canonical(o: unknown): string {
  if (o === null || typeof o !== 'object') return JSON.stringify(o);
  if (Array.isArray(o)) return '[' + o.map(canonical).join(',') + ']';
  const obj = o as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(obj[k])).join(',') + '}';
}

async function hashLocalFeature(f: FeatureRow): Promise<string> {
  return sha256(canonical({
    title: f.title,
    summary: f.summary ?? '',
    status: f.status,
    tags: (f.tags ?? []).slice().sort(),
  }));
}

async function hashLocalIssue(i: IssueRow): Promise<string> {
  return sha256(canonical({
    title: i.title,
    severity: i.severity,
    status: i.status,
    repro: i.repro ?? '',
    evidence: i.evidence ?? '',
    suggested_fix: i.suggested_fix ?? '',
    linked: i.linked_feature_id ?? '',
  }));
}

async function hashRemote(r: RemoteIssue, statusMap: Record<string, string>): Promise<string> {
  const inverseMap = invertMap(statusMap);
  return sha256(canonical({
    title: r.fields.summary ?? '',
    description: adfToText(r.fields.description ?? null),
    status: inverseMap[r.fields.status?.name ?? ''] ?? r.fields.status?.name ?? '',
    labels: (r.fields.labels ?? []).slice().sort(),
  }));
}

function invertMap(m: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(m)) out[v] = k;
  return out;
}

/* ─────────────────────────────────────────────────────────────────────
 * Local data access (harness_<slug>.harness_features / harness_issues)
 * ───────────────────────────────────────────────────────────────────── */

async function readLocalFeatures(slug: string, sinceTs: number): Promise<FeatureRow[]> {
  const sql = await pg();
  const schema = harnessSchema(slug);
  const rows = await sql.unsafe(
    `SELECT feature_id, title, summary, status, tags, updated_ts
     FROM ${schema}.harness_features
     WHERE harness_slug = $1 AND updated_ts > $2
     ORDER BY updated_ts ASC
     LIMIT 500`,
    [slug, sinceTs],
  );
  return rows.map((r: any) => ({
    feature_id: r.feature_id,
    title: r.title,
    summary: r.summary,
    status: r.status,
    tags: Array.isArray(r.tags) ? r.tags : (r.tags ?? null),
    updated_ts: Number(r.updated_ts),
  }));
}

async function readLocalIssues(slug: string, sinceTs: number): Promise<IssueRow[]> {
  const sql = await pg();
  const schema = harnessSchema(slug);
  const rows = await sql.unsafe(
    `SELECT issue_id, title, severity, status, repro, evidence, suggested_fix, linked_feature_id, updated_ts
     FROM ${schema}.harness_issues
     WHERE harness_slug = $1 AND updated_ts > $2
     ORDER BY updated_ts ASC
     LIMIT 500`,
    [slug, sinceTs],
  );
  return rows.map((r: any) => ({
    issue_id: r.issue_id,
    title: r.title,
    severity: r.severity,
    status: r.status,
    repro: r.repro,
    evidence: r.evidence,
    suggested_fix: r.suggested_fix,
    linked_feature_id: r.linked_feature_id,
    updated_ts: Number(r.updated_ts),
  }));
}

async function readAllLocalFeatures(slug: string): Promise<FeatureRow[]> {
  return readLocalFeatures(slug, 0);
}

async function readAllLocalIssues(slug: string): Promise<IssueRow[]> {
  return readLocalIssues(slug, 0);
}

interface LinkRow {
  harness_slug: string;
  entity_kind: 'feature' | 'issue';
  entity_id: string;
  external_id: string;
  external_url: string;
  local_hash: string;
  remote_hash: string;
  remote_meta: Record<string, unknown>;
  tombstoned: boolean;
}

async function getLink(slug: string, kind: 'feature' | 'issue', id: string): Promise<LinkRow | null> {
  const sql = await pg();
  const rows = await sql`
    SELECT * FROM plugin_jira_sync.links
    WHERE harness_slug = ${slug} AND entity_kind = ${kind} AND entity_id = ${id}
  `;
  return rows[0] ?? null;
}

async function getLinkByExternal(slug: string, kind: 'feature' | 'issue', externalId: string): Promise<LinkRow | null> {
  const sql = await pg();
  const rows = await sql`
    SELECT * FROM plugin_jira_sync.links
    WHERE harness_slug = ${slug} AND entity_kind = ${kind} AND external_id = ${externalId}
  `;
  return rows[0] ?? null;
}

async function upsertLink(row: Omit<LinkRow, 'tombstoned'> & { tombstoned?: boolean }): Promise<void> {
  const sql = await pg();
  await sql`
    INSERT INTO plugin_jira_sync.links
      (harness_slug, entity_kind, entity_id, external_id, external_url,
       local_hash, remote_hash, remote_meta, tombstoned, last_synced_at)
    VALUES
      (${row.harness_slug}, ${row.entity_kind}, ${row.entity_id},
       ${row.external_id}, ${row.external_url}, ${row.local_hash},
       ${row.remote_hash}, ${sql.json(row.remote_meta)}, ${row.tombstoned ?? false}, now())
    ON CONFLICT (harness_slug, entity_kind, entity_id) DO UPDATE SET
      external_id = EXCLUDED.external_id,
      external_url = EXCLUDED.external_url,
      local_hash = EXCLUDED.local_hash,
      remote_hash = EXCLUDED.remote_hash,
      remote_meta = EXCLUDED.remote_meta,
      tombstoned = EXCLUDED.tombstoned,
      last_synced_at = now()
  `;
}

async function logConflict(row: {
  slug: string;
  kind: 'feature' | 'issue';
  entityId: string;
  externalId: string | null;
  field: string;
  localValue: unknown;
  remoteValue: unknown;
  resolution: 'local-wins' | 'remote-wins' | 'merged' | 'sidecar';
}): Promise<void> {
  const sql = await pg();
  await sql`
    INSERT INTO plugin_jira_sync.conflicts
      (harness_slug, entity_kind, entity_id, external_id, field,
       local_value, remote_value, resolution)
    VALUES
      (${row.slug}, ${row.kind}, ${row.entityId}, ${row.externalId},
       ${row.field}, ${sql.json(row.localValue as any)}, ${sql.json(row.remoteValue as any)},
       ${row.resolution})
  `;
}

/* ─────────────────────────────────────────────────────────────────────
 * Remote calls
 * ───────────────────────────────────────────────────────────────────── */

async function fetchRemoteByKey(creds: JiraCreds, key: string): Promise<RemoteIssue | null> {
  const r = await jiraFetch(creds, `/issue/${encodeURIComponent(key)}?fields=summary,description,status,issuetype,labels,priority,assignee,updated`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`jira fetch ${key}: HTTP ${r.status}`);
  return (await r.json()) as RemoteIssue;
}

async function fetchRemoteForHarness(creds: JiraCreds, slug: string, labelPrefix: string, since?: Date): Promise<RemoteIssue[]> {
  const sinceJql = since
    ? ` AND updated > "${since.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '')}"`
    : '';
  const jql = `labels = "${labelPrefix}-${slug}"${sinceJql} ORDER BY updated DESC`;
  const url = `/search?jql=${encodeURIComponent(jql)}&fields=summary,description,status,issuetype,labels,priority,assignee,updated&maxResults=100`;
  const r = await jiraFetch(creds, url);
  if (!r.ok) throw new Error(`jira search: HTTP ${r.status}`);
  const json = (await r.json()) as { issues: RemoteIssue[] };
  return json.issues ?? [];
}

interface CreatePayload {
  projectKey: string;
  issueType: string;
  summary: string;
  description: string;
  labels: string[];
}

async function createRemote(creds: JiraCreds, p: CreatePayload): Promise<RemoteIssue> {
  const body = {
    fields: {
      project: { key: p.projectKey },
      issuetype: { name: p.issueType },
      summary: p.summary,
      description: adfDoc(p.description),
      labels: p.labels,
    },
  };
  const r = await jiraFetch(creds, '/issue', { method: 'POST', body: JSON.stringify(body) });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`jira create: HTTP ${r.status} — ${t.slice(0, 300)}`);
  }
  const json = (await r.json()) as { id: string; key: string };
  return (await fetchRemoteByKey(creds, json.key))!;
}

async function updateRemoteFields(creds: JiraCreds, key: string, patch: { summary?: string; description?: string; labels?: string[] }): Promise<void> {
  const fields: Record<string, unknown> = {};
  if (patch.summary !== undefined) fields.summary = patch.summary;
  if (patch.description !== undefined) fields.description = adfDoc(patch.description);
  if (patch.labels !== undefined) fields.labels = patch.labels;
  if (Object.keys(fields).length === 0) return;
  const r = await jiraFetch(creds, `/issue/${encodeURIComponent(key)}`, {
    method: 'PUT',
    body: JSON.stringify({ fields }),
  });
  if (!r.ok && r.status !== 204) {
    const t = await r.text().catch(() => '');
    throw new Error(`jira update ${key}: HTTP ${r.status} — ${t.slice(0, 300)}`);
  }
}

async function transitionRemote(creds: JiraCreds, key: string, targetStatusName: string): Promise<void> {
  const tr = await jiraFetch(creds, `/issue/${encodeURIComponent(key)}/transitions`);
  if (!tr.ok) throw new Error(`jira transitions ${key}: HTTP ${tr.status}`);
  const trJson = (await tr.json()) as { transitions: Array<{ id: string; name: string; to: { name: string } }> };
  const t = trJson.transitions.find((x) => x.to.name === targetStatusName) ?? trJson.transitions.find((x) => x.name === targetStatusName);
  if (!t) {
    // Workflow doesn't allow this transition right now — record but don't throw.
    throw new Error(`jira transition ${key}: no transition leads to "${targetStatusName}"`);
  }
  const r = await jiraFetch(creds, `/issue/${encodeURIComponent(key)}/transitions`, {
    method: 'POST',
    body: JSON.stringify({ transition: { id: t.id } }),
  });
  if (!r.ok && r.status !== 204) {
    const text = await r.text().catch(() => '');
    throw new Error(`jira transition ${key}: HTTP ${r.status} — ${text.slice(0, 300)}`);
  }
}

/* ─────────────────────────────────────────────────────────────────────
 * Local mutators (write back to harness_<slug>.harness_features / harness_issues
 * when remote → local)
 * ───────────────────────────────────────────────────────────────────── */

async function writeLocalFeatureFromRemote(slug: string, featureId: string, r: RemoteIssue, statusMap: Record<string, string>): Promise<void> {
  const sql = await pg();
  const schema = harnessSchema(slug);
  const inverse = invertMap(statusMap);
  const status = inverse[r.fields.status?.name ?? ''] ?? 'todo';
  const now = Date.now();
  await sql.unsafe(
    `INSERT INTO ${schema}.harness_features
       (harness_slug, feature_id, title, summary, status, created_ts, updated_ts)
     VALUES ($1, $2, $3, $4, $5, $6, $6)
     ON CONFLICT (harness_slug, feature_id) DO UPDATE SET
       title = EXCLUDED.title,
       summary = EXCLUDED.summary,
       status = EXCLUDED.status,
       updated_ts = EXCLUDED.updated_ts`,
    [slug, featureId, r.fields.summary ?? '', adfToText(r.fields.description ?? null) || null, status, now],
  );
}

async function writeLocalIssueFromRemote(slug: string, issueId: string, r: RemoteIssue): Promise<void> {
  const sql = await pg();
  const schema = harnessSchema(slug);
  const now = Date.now();
  const status = (r.fields.status?.name ?? 'open').toLowerCase().includes('done') ? 'closed' : 'open';
  await sql.unsafe(
    `INSERT INTO ${schema}.harness_issues
       (harness_slug, issue_id, title, severity, source, status, found_at, created_ts, updated_ts, repro)
     VALUES ($1, $2, $3, 'normal', 'jira-sync', $4, now(), $5, $5, $6)
     ON CONFLICT (harness_slug, issue_id) DO UPDATE SET
       title = EXCLUDED.title,
       status = EXCLUDED.status,
       updated_ts = EXCLUDED.updated_ts,
       repro = EXCLUDED.repro`,
    [slug, issueId, r.fields.summary ?? '', status, now, adfToText(r.fields.description ?? null) || null],
  );
}

/* ─────────────────────────────────────────────────────────────────────
 * Sync engine
 * ───────────────────────────────────────────────────────────────────── */

interface SyncStats {
  pushedCreated: number;
  pushedUpdated: number;
  pushedTransitioned: number;
  pulledCreated: number;
  pulledUpdated: number;
  conflicts: number;
  errors: { entity: string; error: string }[];
}

function emptyStats(): SyncStats {
  return { pushedCreated: 0, pushedUpdated: 0, pushedTransitioned: 0, pulledCreated: 0, pulledUpdated: 0, conflicts: 0, errors: [] };
}

async function syncFeature(
  ctx: PapercuspContext,
  creds: JiraCreds,
  cfg: Required<Pick<Config, 'defaultProjectKey' | 'defaultIssueType' | 'labelPrefix' | 'statusMap'>>,
  feature: FeatureRow,
  stats: SyncStats,
): Promise<void> {
  const slug = ctx.installSlug ?? 'unknown';
  const slugLabel = `${cfg.labelPrefix}-${slug}`;
  const idLabel = `${cfg.labelPrefix}-feat-${feature.feature_id}`;
  const baseLabels = [slugLabel, idLabel];

  const link = await getLink(slug, 'feature', feature.feature_id);
  const localHashNow = await hashLocalFeature(feature);

  // No link → create remote
  if (!link) {
    const remote = await createRemote(creds, {
      projectKey: cfg.defaultProjectKey,
      issueType: cfg.defaultIssueType,
      summary: feature.title,
      description: feature.summary ?? '',
      labels: Array.from(new Set([...baseLabels, ...(feature.tags ?? [])])),
    });
    const remoteHash = await hashRemote(remote, cfg.statusMap);
    await upsertLink({
      harness_slug: slug,
      entity_kind: 'feature',
      entity_id: feature.feature_id,
      external_id: remote.key,
      external_url: `${creds.baseUrl}/browse/${remote.key}`,
      local_hash: localHashNow,
      remote_hash: remoteHash,
      remote_meta: extractRemoteMeta(remote),
    });
    // Drive status if non-default
    const targetStatus = cfg.statusMap[feature.status];
    if (targetStatus && remote.fields.status?.name !== targetStatus) {
      try {
        await transitionRemote(creds, remote.key, targetStatus);
        stats.pushedTransitioned++;
      } catch (e: any) {
        stats.errors.push({ entity: `feature/${feature.feature_id}`, error: e?.message ?? String(e) });
      }
    }
    stats.pushedCreated++;
    ctx.log(`jira-sync: created ${remote.key} ← feature/${feature.feature_id}`);
    return;
  }

  // Link exists → diff
  const remote = await fetchRemoteByKey(creds, link.external_id);
  if (!remote) {
    // Remote was deleted in Jira. Tombstone the link; harness keeps the feature.
    await upsertLink({ ...link, tombstoned: true, local_hash: localHashNow });
    ctx.log(`jira-sync: remote ${link.external_id} for feature/${feature.feature_id} not found — tombstoned`);
    return;
  }
  const remoteHashNow = await hashRemote(remote, cfg.statusMap);
  const localChanged = localHashNow !== link.local_hash;
  const remoteChanged = remoteHashNow !== link.remote_hash;

  if (!localChanged && !remoteChanged) return;

  // Harness wins for canonical fields. Always push our state up.
  if (localChanged) {
    const labels = unionLabels(remote.fields.labels ?? [], baseLabels, feature.tags ?? []);
    await updateRemoteFields(creds, remote.key, {
      summary: feature.title,
      description: feature.summary ?? '',
      labels,
    });
    stats.pushedUpdated++;
    const targetStatus = cfg.statusMap[feature.status];
    if (targetStatus && remote.fields.status?.name !== targetStatus) {
      try {
        await transitionRemote(creds, remote.key, targetStatus);
        stats.pushedTransitioned++;
      } catch (e: any) {
        stats.errors.push({ entity: `feature/${feature.feature_id}`, error: e?.message ?? String(e) });
      }
    }
  }

  // Both changed → log per-field conflicts (harness already won).
  if (remoteChanged && localChanged) {
    if (remote.fields.summary !== feature.title) {
      await logConflict({ slug, kind: 'feature', entityId: feature.feature_id, externalId: remote.key, field: 'title', localValue: feature.title, remoteValue: remote.fields.summary, resolution: 'local-wins' });
      stats.conflicts++;
    }
  }

  // Always cache remote-only metadata (assignee, priority).
  const newRemote = await fetchRemoteByKey(creds, remote.key);
  const finalRemoteHash = newRemote ? await hashRemote(newRemote, cfg.statusMap) : remoteHashNow;
  await upsertLink({
    harness_slug: slug,
    entity_kind: 'feature',
    entity_id: feature.feature_id,
    external_id: remote.key,
    external_url: `${creds.baseUrl}/browse/${remote.key}`,
    local_hash: localHashNow,
    remote_hash: finalRemoteHash,
    remote_meta: extractRemoteMeta(newRemote ?? remote),
  });
}

function unionLabels(...lists: string[][]): string[] {
  const s = new Set<string>();
  for (const list of lists) for (const x of list) s.add(x);
  return Array.from(s).sort();
}

function extractRemoteMeta(r: RemoteIssue): Record<string, unknown> {
  return {
    priority: r.fields.priority?.name ?? null,
    assignee: r.fields.assignee?.displayName ?? r.fields.assignee?.emailAddress ?? null,
    issuetype: r.fields.issuetype?.name ?? null,
    updated: r.fields.updated,
  };
}

async function syncIssue(
  ctx: PapercuspContext,
  creds: JiraCreds,
  cfg: Required<Pick<Config, 'defaultProjectKey' | 'bugIssueType' | 'labelPrefix' | 'statusMap'>>,
  issue: IssueRow,
  stats: SyncStats,
): Promise<void> {
  const slug = ctx.installSlug ?? 'unknown';
  const slugLabel = `${cfg.labelPrefix}-${slug}`;
  const idLabel = `${cfg.labelPrefix}-issue-${issue.issue_id}`;
  const bugLabel = `${cfg.labelPrefix}-bug`;
  const baseLabels = [slugLabel, idLabel, bugLabel];

  const link = await getLink(slug, 'issue', issue.issue_id);
  const localHashNow = await hashLocalIssue(issue);

  const description = [
    issue.repro ? `### Repro\n${issue.repro}` : '',
    issue.evidence ? `### Evidence\n${issue.evidence}` : '',
    issue.suggested_fix ? `### Suggested fix\n${issue.suggested_fix}` : '',
    issue.linked_feature_id ? `### Linked feature\n${issue.linked_feature_id}` : '',
  ].filter(Boolean).join('\n\n');

  if (!link) {
    const remote = await createRemote(creds, {
      projectKey: cfg.defaultProjectKey,
      issueType: cfg.bugIssueType,
      summary: issue.title,
      description,
      labels: baseLabels,
    });
    const remoteHash = await hashRemote(remote, cfg.statusMap);
    await upsertLink({
      harness_slug: slug,
      entity_kind: 'issue',
      entity_id: issue.issue_id,
      external_id: remote.key,
      external_url: `${creds.baseUrl}/browse/${remote.key}`,
      local_hash: localHashNow,
      remote_hash: remoteHash,
      remote_meta: extractRemoteMeta(remote),
    });
    stats.pushedCreated++;
    ctx.log(`jira-sync: created ${remote.key} ← issue/${issue.issue_id}`);
    return;
  }

  const remote = await fetchRemoteByKey(creds, link.external_id);
  if (!remote) {
    await upsertLink({ ...link, tombstoned: true, local_hash: localHashNow });
    return;
  }
  const remoteHashNow = await hashRemote(remote, cfg.statusMap);
  if (localHashNow === link.local_hash && remoteHashNow === link.remote_hash) return;

  if (localHashNow !== link.local_hash) {
    await updateRemoteFields(creds, remote.key, {
      summary: issue.title,
      description,
      labels: unionLabels(remote.fields.labels ?? [], baseLabels),
    });
    stats.pushedUpdated++;
  }

  const newRemote = await fetchRemoteByKey(creds, remote.key);
  const finalRemoteHash = newRemote ? await hashRemote(newRemote, cfg.statusMap) : remoteHashNow;
  await upsertLink({
    harness_slug: slug,
    entity_kind: 'issue',
    entity_id: issue.issue_id,
    external_id: remote.key,
    external_url: `${creds.baseUrl}/browse/${remote.key}`,
    local_hash: localHashNow,
    remote_hash: finalRemoteHash,
    remote_meta: extractRemoteMeta(newRemote ?? remote),
  });
}

async function pullRemoteToLocal(
  ctx: PapercuspContext,
  creds: JiraCreds,
  cfg: Required<Pick<Config, 'labelPrefix' | 'statusMap'>>,
  stats: SyncStats,
): Promise<void> {
  const slug = ctx.installSlug ?? 'unknown';
  const sql = await pg();
  const cursorRow = await sql`SELECT remote_cursor FROM plugin_jira_sync.cursors WHERE harness_slug = ${slug}`;
  const since: Date | undefined = cursorRow[0]?.remote_cursor && new Date(cursorRow[0].remote_cursor).getTime() > 0
    ? new Date(cursorRow[0].remote_cursor)
    : undefined;
  const remotes = await fetchRemoteForHarness(creds, slug, cfg.labelPrefix, since);
  for (const r of remotes) {
    const featLabel = (r.fields.labels ?? []).find((l) => l.startsWith(`${cfg.labelPrefix}-feat-`));
    const issueLabel = (r.fields.labels ?? []).find((l) => l.startsWith(`${cfg.labelPrefix}-issue-`));
    const isBug = (r.fields.labels ?? []).includes(`${cfg.labelPrefix}-bug`) || r.fields.issuetype?.name === 'Bug';
    if (featLabel) {
      const featureId = featLabel.replace(`${cfg.labelPrefix}-feat-`, '');
      const link = await getLink(slug, 'feature', featureId);
      if (!link) {
        await writeLocalFeatureFromRemote(slug, featureId, r, cfg.statusMap);
        const newFeat = (await readLocalFeatures(slug, 0)).find((x) => x.feature_id === featureId);
        if (newFeat) {
          await upsertLink({
            harness_slug: slug,
            entity_kind: 'feature',
            entity_id: featureId,
            external_id: r.key,
            external_url: `${creds.baseUrl}/browse/${r.key}`,
            local_hash: await hashLocalFeature(newFeat),
            remote_hash: await hashRemote(r, cfg.statusMap),
            remote_meta: extractRemoteMeta(r),
          });
        }
        stats.pulledCreated++;
      }
    } else if (issueLabel) {
      const issueId = issueLabel.replace(`${cfg.labelPrefix}-issue-`, '');
      const link = await getLink(slug, 'issue', issueId);
      if (!link) {
        await writeLocalIssueFromRemote(slug, issueId, r);
        stats.pulledCreated++;
      }
    } else if (isBug) {
      // Imported from Jira side without our id label — mint a new harness issue id.
      const newId = await mintIssueId(slug);
      await writeLocalIssueFromRemote(slug, newId, r);
      const newIssue = (await readLocalIssues(slug, 0)).find((x) => x.issue_id === newId);
      if (newIssue) {
        await upsertLink({
          harness_slug: slug,
          entity_kind: 'issue',
          entity_id: newId,
          external_id: r.key,
          external_url: `${creds.baseUrl}/browse/${r.key}`,
          local_hash: await hashLocalIssue(newIssue),
          remote_hash: await hashRemote(r, cfg.statusMap),
          remote_meta: extractRemoteMeta(r),
        });
      }
      stats.pulledCreated++;
    }
  }
  // Advance remote_cursor to "now" — we just read everything up to here.
  await sql`UPDATE plugin_jira_sync.cursors SET remote_cursor = now() WHERE harness_slug = ${slug}`;
}

async function mintIssueId(slug: string): Promise<string> {
  const sql = await pg();
  const schema = harnessSchema(slug);
  const rows = await sql.unsafe(
    `SELECT MAX(CAST(SUBSTRING(issue_id FROM 3) AS BIGINT)) AS max FROM ${schema}.harness_issues WHERE harness_slug = $1`,
    [slug],
  );
  const next = Number(rows[0]?.max ?? 0) + 1;
  return `I-${String(next).padStart(4, '0')}`;
}

function effectiveConfig(cfg: Config): Required<Pick<Config, 'defaultProjectKey' | 'defaultIssueType' | 'bugIssueType' | 'labelPrefix' | 'statusMap'>> | null {
  if (!cfg.defaultProjectKey) return null;
  return {
    defaultProjectKey: cfg.defaultProjectKey,
    defaultIssueType: cfg.defaultIssueType ?? 'Task',
    bugIssueType: cfg.bugIssueType ?? 'Bug',
    labelPrefix: cfg.labelPrefix ?? 'papercusp',
    statusMap: cfg.statusMap ?? DEFAULT_STATUS_MAP,
  };
}

export async function runSync(ctx: PapercuspContext, opts: { full?: boolean } = {}): Promise<SyncStats> {
  const stats = emptyStats();
  const slug = ctx.installSlug ?? 'unknown';
  const creds = readCreds();
  if (!creds) {
    ctx.log('jira-sync: runSync — skipped (creds not set)');
    return stats;
  }
  const cfg = effectiveConfig(await readConfig(ctx));
  if (!cfg) {
    ctx.log('jira-sync: runSync — skipped (defaultProjectKey not configured)');
    return stats;
  }

  await ensureSchema(ctx);
  await ensureCursor(slug);

  const sql = await pg();
  const cursorRow = await sql`SELECT local_cursor FROM plugin_jira_sync.cursors WHERE harness_slug = ${slug}`;
  const localCursor = opts.full ? 0 : Number(cursorRow[0]?.local_cursor ?? 0);

  // PUSH local → remote
  const features = await readLocalFeatures(slug, localCursor);
  const issues = await readLocalIssues(slug, localCursor);
  let maxTs = localCursor;
  for (const f of features) {
    try {
      await syncFeature(ctx, creds, cfg, f, stats);
      maxTs = Math.max(maxTs, f.updated_ts);
    } catch (e: any) {
      stats.errors.push({ entity: `feature/${f.feature_id}`, error: e?.message ?? String(e) });
    }
  }
  for (const i of issues) {
    try {
      await syncIssue(ctx, creds, cfg, i, stats);
      maxTs = Math.max(maxTs, i.updated_ts);
    } catch (e: any) {
      stats.errors.push({ entity: `issue/${i.issue_id}`, error: e?.message ?? String(e) });
    }
  }
  await sql`UPDATE plugin_jira_sync.cursors SET local_cursor = ${maxTs} WHERE harness_slug = ${slug}`;

  // PULL remote → local
  try {
    await pullRemoteToLocal(ctx, creds, cfg, stats);
  } catch (e: any) {
    stats.errors.push({ entity: 'remote-pull', error: e?.message ?? String(e) });
  }

  if (opts.full) {
    await sql`UPDATE plugin_jira_sync.cursors SET last_full_sync = now() WHERE harness_slug = ${slug}`;
  }

  ctx.log(`jira-sync: tick ↑${stats.pushedCreated}c/${stats.pushedUpdated}u/${stats.pushedTransitioned}t ↓${stats.pulledCreated}c err=${stats.errors.length}`);
  return stats;
}

/* ─────────────────────────────────────────────────────────────────────
 * Plugin manifest
 * ───────────────────────────────────────────────────────────────────── */

const plugin: Plugin = {
  kind: 'plugin',
  name: '@papercupai/jira-sync',
  version: '0.2.0',
  papercusp: '^0.1.0',
  description: 'Bidirectional background sync between harness features/issues and a Jira Cloud project.',
  capabilities: [
    'db:plugin-schema',
    'secrets:read:JIRA_API_TOKEN',
    'secrets:read:JIRA_EMAIL',
    'secrets:read:JIRA_BASE_URL',
    'secrets:read:JIRA_WEBHOOK_SECRET',
    'http:fetch:*.atlassian.net',
    'http:fetch:api.atlassian.com',
    'events:listen:feature-passed',
    'events:listen:feature-failed',
    'events:listen:proposal-accepted',
    'events:listen:mission-done',
    'routines:read',
    'routines:write',
    'tasks:read',
    'tasks:write',
  ],
  schema: {
    schemaName: 'plugin_jira_sync',
    sqlPaths: ['./schema.sql'],
  } as any,
  routines: [
    {
      name: 'sync-tick',
      trigger: { kind: 'cron', expr: '*/30 * * * * *' },
      targetRole: 'jira-sync.runSync',
      concurrency: 'skip',
      catchup: 'skip-old',
    },
    {
      name: 'webhook',
      trigger: { kind: 'webhook', tokenEnv: 'JIRA_WEBHOOK_SECRET' },
      targetRole: 'jira-sync.runSync',
      concurrency: 'queue',
    },
    {
      name: 'manual-sync',
      trigger: { kind: 'api', method: 'POST' },
      targetRole: 'jira-sync.runSync',
      concurrency: 'queue',
    },
  ],
  actions: [
    {
      name: 'force-sync',
      label: 'Force full sync',
      surfaces: ['plugin-detail'],
      capabilities: ['secrets:read:JIRA_API_TOKEN', 'secrets:read:JIRA_EMAIL', 'secrets:read:JIRA_BASE_URL', 'http:fetch:*.atlassian.net'],
      serverHandler: { timeoutSec: 60 },
    },
    {
      name: 'backfill-local-to-remote',
      label: 'Push every harness feature/issue to Jira',
      surfaces: ['plugin-detail'],
      capabilities: ['secrets:read:JIRA_API_TOKEN', 'secrets:read:JIRA_EMAIL', 'secrets:read:JIRA_BASE_URL', 'http:fetch:*.atlassian.net'],
      serverHandler: { timeoutSec: 300 },
    },
    {
      name: 'backfill-remote-to-local',
      label: 'Import every Jira issue tagged for this harness',
      surfaces: ['plugin-detail'],
      capabilities: ['secrets:read:JIRA_API_TOKEN', 'secrets:read:JIRA_EMAIL', 'secrets:read:JIRA_BASE_URL', 'http:fetch:*.atlassian.net'],
      serverHandler: { timeoutSec: 300 },
    },
  ],
  async init(ctx) {
    ctx.actions!.register('force-sync', async (innerCtx) => {
      const stats = await runSync(innerCtx, { full: true });
      return { ok: true, result: stats };
    });
    ctx.actions!.register('backfill-local-to-remote', async (innerCtx) => {
      const sql = await pg();
      const slug = innerCtx.installSlug ?? 'unknown';
      await sql`UPDATE plugin_jira_sync.cursors SET local_cursor = 0 WHERE harness_slug = ${slug}`;
      const stats = await runSync(innerCtx, { full: true });
      return { ok: true, result: stats };
    });
    ctx.actions!.register('backfill-remote-to-local', async (innerCtx) => {
      const sql = await pg();
      const slug = innerCtx.installSlug ?? 'unknown';
      await sql`UPDATE plugin_jira_sync.cursors SET remote_cursor = 'epoch' WHERE harness_slug = ${slug}`;
      const stats = await runSync(innerCtx, { full: true });
      return { ok: true, result: stats };
    });
  },
  hooks: {
    async onLoad(ctx: PapercuspContext) {
      try {
        await ensureSchema(ctx);
        if (ctx.installSlug) await ensureCursor(ctx.installSlug);
      } catch (e: any) {
        ctx.log(`jira-sync: onLoad schema setup failed — ${e?.message ?? String(e)}`);
      }
    },
    async beforeMissionStart(ctx: PapercuspContext) {
      try {
        await runSync(ctx, {});
      } catch (e: any) {
        ctx.log(`jira-sync: beforeMissionStart sync failed — ${e?.message ?? String(e)}`);
      }
    },
    async onPostValidator(ctx: PapercuspContext, _featureId: string, _status: 'passed' | 'failing') {
      try {
        await runSync(ctx, {});
      } catch (e: any) {
        ctx.log(`jira-sync: onPostValidator sync failed — ${e?.message ?? String(e)}`);
      }
    },
    async afterDone(ctx: PapercuspContext) {
      try {
        await runSync(ctx, { full: true });
      } catch (e: any) {
        ctx.log(`jira-sync: afterDone sync failed — ${e?.message ?? String(e)}`);
      }
    },
  },
};

/* ─────────────────────────────────────────────────────────────────────
 * apiRoutes
 *   GET  /ping       — config + connection status
 *   GET  /status     — sync stats: link count, last sync, drift count
 *   GET  /links      — list of harness↔Jira links
 *   GET  /conflicts  — recent conflict log
 *   POST /webhook    — Jira webhook receiver (writes pending_event for next tick)
 *   POST /sync       — trigger a sync now (also exposed as the manual-sync routine)
 * ───────────────────────────────────────────────────────────────────── */

const apiRoutes = {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^.*\/plugins\/[^/]+/, '') || url.pathname;
    const slug = url.searchParams.get('slug') ?? 'unknown';

    if (path === '/ping' || path.endsWith('/ping')) {
      const creds = readCreds();
      return Response.json({ ok: true, plugin: '@papercupai/jira-sync', version: '0.2.0', configured: creds !== null });
    }

    if (path.endsWith('/status') && req.method === 'GET') {
      try {
        const sql = await pg();
        const links = await sql`SELECT count(*)::bigint AS n FROM plugin_jira_sync.links WHERE harness_slug = ${slug} AND NOT tombstoned`;
        const cur = await sql`SELECT * FROM plugin_jira_sync.cursors WHERE harness_slug = ${slug}`;
        const drift = await sql`SELECT count(*)::bigint AS n FROM plugin_jira_sync.conflicts WHERE harness_slug = ${slug} AND resolved_at > now() - interval '24 hours'`;
        return Response.json({
          ok: true,
          slug,
          linkCount: Number(links[0]?.n ?? 0),
          cursor: cur[0] ?? null,
          recentConflicts: Number(drift[0]?.n ?? 0),
        });
      } catch (e: any) {
        return Response.json({ ok: false, error: e?.message ?? String(e) }, { status: 500 });
      }
    }

    if (path.endsWith('/links') && req.method === 'GET') {
      try {
        const sql = await pg();
        const rows = await sql`SELECT * FROM plugin_jira_sync.links WHERE harness_slug = ${slug} ORDER BY last_synced_at DESC LIMIT 200`;
        return Response.json({ ok: true, links: rows });
      } catch (e: any) {
        return Response.json({ ok: false, error: e?.message ?? String(e) }, { status: 500 });
      }
    }

    if (path.endsWith('/conflicts') && req.method === 'GET') {
      try {
        const sql = await pg();
        const rows = await sql`SELECT * FROM plugin_jira_sync.conflicts WHERE harness_slug = ${slug} ORDER BY resolved_at DESC LIMIT 50`;
        return Response.json({ ok: true, conflicts: rows });
      } catch (e: any) {
        return Response.json({ ok: false, error: e?.message ?? String(e) }, { status: 500 });
      }
    }

    if (path.endsWith('/webhook') && req.method === 'POST') {
      // Jira webhook fires per change. We don't dispatch the sync inline
      // (avoid blocking Jira's POST timeout); instead bump remote_cursor
      // backwards by 5 minutes so the next tick picks up the change.
      const secret = process.env.JIRA_WEBHOOK_SECRET;
      const provided = url.searchParams.get('secret') ?? req.headers.get('x-papercusp-secret');
      if (secret && provided !== secret) {
        return Response.json({ ok: false, error: 'bad secret' }, { status: 401 });
      }
      try {
        const sql = await pg();
        await sql`
          UPDATE plugin_jira_sync.cursors
          SET remote_cursor = LEAST(remote_cursor, now() - interval '5 minutes')
          WHERE harness_slug = ${slug}
        `;
        return Response.json({ ok: true, queued: true });
      } catch (e: any) {
        return Response.json({ ok: false, error: e?.message ?? String(e) }, { status: 500 });
      }
    }

    if (path.endsWith('/sync') && req.method === 'POST') {
      try {
        const ctx: PapercuspContext = {
          installSlug: slug,
          projectDir: process.cwd(),
          stateDir: process.env.PAPERCUSP_STATE_DIR ?? `${process.env.HOME}/.papercusp/harnesses/${slug}`,
          pluginDataDir: `${process.env.HOME}/.papercusp/harnesses/${slug}/plugins/jira-sync`,
          log: (m: string) => console.log(`[jira-sync] ${m}`),
        } as any;
        const stats = await runSync(ctx, {});
        return Response.json({ ok: true, stats });
      } catch (e: any) {
        return Response.json({ ok: false, error: e?.message ?? String(e) }, { status: 500 });
      }
    }

    return Response.json({ error: 'not found', path }, { status: 404 });
  },
};

(plugin as any).apiRoutes = apiRoutes;

export default plugin;
