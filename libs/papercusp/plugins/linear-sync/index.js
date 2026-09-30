"use strict";
/**
 * @papercupai/linear-sync — bidirectional background sync between a harness's
 * features/issues queues and a Linear team. Mirrors jira-sync's architecture
 * (see docs/issue-tracker-sync.md).
 *
 * Differences from jira-sync:
 *   - GraphQL transport instead of REST
 *   - Status modeled as `state.id` per-team (must be resolved by name)
 *   - Labels are first-class: `IssueLabelCreate` / `IssueLabel` lookup
 *   - Identifier vs id: Linear has both — we store both
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.runSync = runSync;
// Resolve embedded-PG URL from discovery file. Returns null if no file.
function readDiscoveryUrl(role) {
    if (process.env.PAPERCUSP_SKIP_PG_DISCOVERY === '1')
        return null;
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const fs = require('node:fs');
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const os = require('node:os');
        const raw = fs.readFileSync(`${os.homedir()}/.papercusp/embedded-pg.json`, 'utf8');
        const parsed = JSON.parse(raw);
        if (!parsed?.host || !parsed?.port)
            return null;
        if (role === 'admin' && parsed.user && parsed.password) {
            return `postgresql://${parsed.user}:${parsed.password}@${parsed.host}:${parsed.port}/papercusp`;
        }
        return `postgresql://harness_app:harness_app_pwd@${parsed.host}:${parsed.port}/papercusp`;
    }
    catch {
        return null;
    }
}
const LINEAR_ENDPOINT = 'https://api.linear.app/graphql';
const DEFAULT_STATUS_MAP = {
    todo: 'Todo',
    in_progress: 'In Progress',
    passed: 'Done',
    failing: 'In Review',
    blocked: 'Backlog',
    done: 'Done',
};
/* ─────────────────────────────────────────────────────────────────────
 * Config / creds
 * ───────────────────────────────────────────────────────────────────── */
async function readConfig(ctx) {
    const { promises: fs } = await Promise.resolve().then(() => __importStar(require('node:fs')));
    const { join } = await Promise.resolve().then(() => __importStar(require('node:path')));
    try {
        return JSON.parse(await fs.readFile(join(ctx.pluginDataDir, 'config.json'), 'utf8'));
    }
    catch {
        return {};
    }
}
function readKey() {
    return process.env.LINEAR_API_KEY ?? null;
}
async function gql(key, query, variables = {}) {
    const r = await fetch(LINEAR_ENDPOINT, {
        method: 'POST',
        headers: {
            authorization: key,
            'content-type': 'application/json',
            accept: 'application/json',
        },
        body: JSON.stringify({ query, variables }),
    });
    if (!r.ok) {
        const t = await r.text().catch(() => '');
        throw new Error(`linear: HTTP ${r.status} — ${t.slice(0, 300)}`);
    }
    const json = (await r.json());
    if (json.errors?.length)
        throw new Error(`linear: ${json.errors.map((e) => e.message).join('; ')}`);
    return json.data;
}
/* ─────────────────────────────────────────────────────────────────────
 * Postgres
 * ───────────────────────────────────────────────────────────────────── */
let _pgClient = null;
async function pg() {
    if (_pgClient)
        return _pgClient;
    const postgres = (await Promise.resolve().then(() => __importStar(require('postgres')))).default;
    const url = process.env.HARNESS_ADMIN_DATABASE_URL ||
        process.env.HARNESS_DATABASE_URL ||
        readDiscoveryUrl('app') ||
        'postgresql://harness_app:harness_app_pwd@localhost:5432/papercusp';
    _pgClient = postgres(url, {
        onnotice: () => { },
        max: 2,
        idle_timeout: 30,
        // WI-6062: tag so this singleton pool is attributable in pg_stat_activity —
        // without it postgres-js's own 'postgres.js' default applies and the connection
        // is indistinguishable from every other untagged pool (a sandboxed plugin can't
        // import the shared @papercusp/db-org helper, so tag inline).
        connection: { application_name: `pcusp:linear-sync:p${process.pid}`.slice(0, 63) },
    });
    return _pgClient;
}
function harnessSchema(slug) {
    return 'harness_' + slug.replace(/-/g, '_');
}
async function ensureSchema(ctx) {
    const sql = await pg();
    const { promises: fs } = await Promise.resolve().then(() => __importStar(require('node:fs')));
    const { join, dirname } = await Promise.resolve().then(() => __importStar(require('node:path')));
    const here = (typeof __dirname === 'string') ? __dirname : dirname(eval('import.meta.url').replace('file://', ''));
    const ddl = await fs.readFile(join(here, 'schema.sql'), 'utf8');
    await sql.unsafe(ddl);
    ctx.log('linear-sync: schema ensured');
}
async function ensureCursor(slug) {
    const sql = await pg();
    await sql `
    INSERT INTO plugin_linear_sync.cursors (harness_slug)
    VALUES (${slug})
    ON CONFLICT (harness_slug) DO NOTHING
  `;
}
/* ─────────────────────────────────────────────────────────────────────
 * Hashing
 * ───────────────────────────────────────────────────────────────────── */
async function sha256(s) {
    const { createHash } = await Promise.resolve().then(() => __importStar(require('node:crypto')));
    return createHash('sha256').update(s).digest('hex');
}
function canonical(o) {
    if (o === null || typeof o !== 'object')
        return JSON.stringify(o);
    if (Array.isArray(o))
        return '[' + o.map(canonical).join(',') + ']';
    const obj = o;
    const keys = Object.keys(obj).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(obj[k])).join(',') + '}';
}
async function hashLocalFeature(f) {
    return sha256(canonical({
        title: f.title,
        summary: f.summary ?? '',
        status: f.status,
        tags: (f.tags ?? []).slice().sort(),
    }));
}
async function hashLocalIssue(i) {
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
async function hashRemote(r, statusMap) {
    const inverse = invertMap(statusMap);
    return sha256(canonical({
        title: r.title ?? '',
        description: r.description ?? '',
        status: inverse[r.state?.name ?? ''] ?? r.state?.name ?? '',
        labels: (r.labels?.nodes ?? []).map((l) => l.name).slice().sort(),
    }));
}
function invertMap(m) {
    const out = {};
    for (const [k, v] of Object.entries(m))
        out[v] = k;
    return out;
}
/* ─────────────────────────────────────────────────────────────────────
 * Local data access
 * ───────────────────────────────────────────────────────────────────── */
async function readLocalFeatures(slug, sinceTs) {
    const sql = await pg();
    const schema = harnessSchema(slug);
    const rows = await sql.unsafe(`SELECT feature_id, title, summary, status, tags, updated_ts
     FROM ${schema}.harness_features
     WHERE harness_slug = $1 AND updated_ts > $2
     ORDER BY updated_ts ASC LIMIT 500`, [slug, sinceTs]);
    return rows.map((r) => ({
        feature_id: r.feature_id, title: r.title, summary: r.summary,
        status: r.status, tags: Array.isArray(r.tags) ? r.tags : (r.tags ?? null),
        updated_ts: Number(r.updated_ts),
    }));
}
async function readLocalIssues(slug, sinceTs) {
    const sql = await pg();
    const schema = harnessSchema(slug);
    const rows = await sql.unsafe(`SELECT issue_id, title, severity, status, repro, evidence, suggested_fix, linked_feature_id, updated_ts
     FROM ${schema}.harness_issues
     WHERE harness_slug = $1 AND updated_ts > $2
     ORDER BY updated_ts ASC LIMIT 500`, [slug, sinceTs]);
    return rows.map((r) => ({
        issue_id: r.issue_id, title: r.title, severity: r.severity, status: r.status,
        repro: r.repro, evidence: r.evidence, suggested_fix: r.suggested_fix,
        linked_feature_id: r.linked_feature_id, updated_ts: Number(r.updated_ts),
    }));
}
async function getLink(slug, kind, id) {
    const sql = await pg();
    const rows = await sql `
    SELECT * FROM plugin_linear_sync.links
    WHERE harness_slug = ${slug} AND entity_kind = ${kind} AND entity_id = ${id}
  `;
    return rows[0] ?? null;
}
async function upsertLink(row) {
    const sql = await pg();
    await sql `
    INSERT INTO plugin_linear_sync.links
      (harness_slug, entity_kind, entity_id, external_id, external_identifier, external_url,
       local_hash, remote_hash, remote_meta, tombstoned, last_synced_at)
    VALUES
      (${row.harness_slug}, ${row.entity_kind}, ${row.entity_id},
       ${row.external_id}, ${row.external_identifier}, ${row.external_url},
       ${row.local_hash}, ${row.remote_hash}, ${sql.json(row.remote_meta)},
       ${row.tombstoned ?? false}, now())
    ON CONFLICT (harness_slug, entity_kind, entity_id) DO UPDATE SET
      external_id = EXCLUDED.external_id,
      external_identifier = EXCLUDED.external_identifier,
      external_url = EXCLUDED.external_url,
      local_hash = EXCLUDED.local_hash,
      remote_hash = EXCLUDED.remote_hash,
      remote_meta = EXCLUDED.remote_meta,
      tombstoned = EXCLUDED.tombstoned,
      last_synced_at = now()
  `;
}
async function logConflict(row) {
    const sql = await pg();
    await sql `
    INSERT INTO plugin_linear_sync.conflicts
      (harness_slug, entity_kind, entity_id, external_id, field,
       local_value, remote_value, resolution)
    VALUES
      (${row.slug}, ${row.kind}, ${row.entityId}, ${row.externalId},
       ${row.field}, ${sql.json(row.localValue)}, ${sql.json(row.remoteValue)},
       ${row.resolution})
  `;
}
/* ─────────────────────────────────────────────────────────────────────
 * Linear lookups (team, label, state)
 * ───────────────────────────────────────────────────────────────────── */
const ISSUE_FIELDS = `
  id identifier url title description
  state { id name type }
  labels(first: 50) { nodes { id name } }
  priority
  assignee { displayName email }
  updatedAt
`;
const teamCache = new Map(); // teamKey → teamId
async function resolveTeamId(key, teamKey) {
    if (teamCache.has(teamKey))
        return teamCache.get(teamKey);
    const data = await gql(key, `query($k: String!) { teams(filter: { key: { eq: $k } }, first: 1) { nodes { id } } }`, { k: teamKey });
    const id = data?.teams?.nodes?.[0]?.id ?? null;
    if (id)
        teamCache.set(teamKey, id);
    return id;
}
const stateCache = new Map();
async function resolveStateByName(key, teamId, name) {
    let perTeam = stateCache.get(teamId);
    if (!perTeam) {
        const data = await gql(key, `query($id: String!) { team(id: $id) { states { nodes { id name type } } } }`, { id: teamId });
        const nodes = data?.team?.states?.nodes ?? [];
        perTeam = new Map(nodes.map((n) => [n.name.toLowerCase(), n]));
        stateCache.set(teamId, perTeam);
    }
    return perTeam.get(name.toLowerCase()) ?? null;
}
async function resolveLabelIds(key, teamId, names) {
    if (names.length === 0)
        return [];
    const data = await gql(key, `query($id: String!) { team(id: $id) { labels(first: 250) { nodes { id name } } } }`, { id: teamId });
    const existing = data?.team?.labels?.nodes ?? [];
    const byName = new Map(existing.map((l) => [l.name.toLowerCase(), l.id]));
    const out = [];
    for (const n of names) {
        const hit = byName.get(n.toLowerCase());
        if (hit) {
            out.push(hit);
            continue;
        }
        const created = await gql(key, `mutation($i: IssueLabelCreateInput!) { issueLabelCreate(input: $i) { issueLabel { id } } }`, { i: { name: n, teamId } });
        const newId = created?.issueLabelCreate?.issueLabel?.id;
        if (newId)
            out.push(newId);
    }
    return out;
}
/* ─────────────────────────────────────────────────────────────────────
 * Remote calls
 * ───────────────────────────────────────────────────────────────────── */
async function fetchRemoteById(key, id) {
    const data = await gql(key, `query($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} } }`, { id });
    return data?.issue ?? null;
}
async function fetchRemoteForHarness(key, slug, labelPrefix, since) {
    const filter = { labels: { name: { eq: `${labelPrefix}-${slug}` } } };
    if (since)
        filter.updatedAt = { gt: since.toISOString() };
    const data = await gql(key, `query($f: IssueFilter!) { issues(filter: $f, first: 100) { nodes { ${ISSUE_FIELDS} } } }`, { f: filter });
    return data?.issues?.nodes ?? [];
}
async function createRemote(key, p) {
    const input = {
        teamId: p.teamId,
        title: p.title,
        description: p.description,
        labelIds: p.labelIds,
    };
    if (p.stateId)
        input.stateId = p.stateId;
    const data = await gql(key, `mutation($i: IssueCreateInput!) { issueCreate(input: $i) { issue { ${ISSUE_FIELDS} } } }`, { i: input });
    if (!data?.issueCreate?.issue)
        throw new Error('linear createRemote: no issue returned');
    return data.issueCreate.issue;
}
async function updateRemote(key, id, patch) {
    const input = {};
    if (patch.title !== undefined)
        input.title = patch.title;
    if (patch.description !== undefined)
        input.description = patch.description;
    if (patch.stateId !== undefined)
        input.stateId = patch.stateId;
    if (patch.labelIds !== undefined)
        input.labelIds = patch.labelIds;
    if (Object.keys(input).length === 0)
        return;
    await gql(key, `mutation($id: String!, $i: IssueUpdateInput!) { issueUpdate(id: $id, input: $i) { success } }`, { id, i: input });
}
/* ─────────────────────────────────────────────────────────────────────
 * Local mutators (remote → local)
 * ───────────────────────────────────────────────────────────────────── */
async function writeLocalFeatureFromRemote(slug, featureId, r, statusMap) {
    const sql = await pg();
    const schema = harnessSchema(slug);
    const inverse = invertMap(statusMap);
    const status = inverse[r.state?.name ?? ''] ?? 'todo';
    const now = Date.now();
    await sql.unsafe(`INSERT INTO ${schema}.harness_features
       (harness_slug, feature_id, title, summary, status, created_ts, updated_ts)
     VALUES ($1, $2, $3, $4, $5, $6, $6)
     ON CONFLICT (harness_slug, feature_id) DO UPDATE SET
       title = EXCLUDED.title, summary = EXCLUDED.summary,
       status = EXCLUDED.status, updated_ts = EXCLUDED.updated_ts`, [slug, featureId, r.title ?? '', r.description ?? null, status, now]);
}
async function writeLocalIssueFromRemote(slug, issueId, r) {
    const sql = await pg();
    const schema = harnessSchema(slug);
    const now = Date.now();
    const status = (r.state?.type === 'completed' || r.state?.type === 'canceled') ? 'closed' : 'open';
    await sql.unsafe(`INSERT INTO ${schema}.harness_issues
       (harness_slug, issue_id, title, severity, source, status, found_at, created_ts, updated_ts, repro)
     VALUES ($1, $2, $3, 'normal', 'linear-sync', $4, now(), $5, $5, $6)
     ON CONFLICT (harness_slug, issue_id) DO UPDATE SET
       title = EXCLUDED.title, status = EXCLUDED.status,
       updated_ts = EXCLUDED.updated_ts, repro = EXCLUDED.repro`, [slug, issueId, r.title ?? '', status, now, r.description ?? null]);
}
async function mintIssueId(slug) {
    const sql = await pg();
    const schema = harnessSchema(slug);
    const rows = await sql.unsafe(`SELECT MAX(CAST(SUBSTRING(issue_id FROM 3) AS BIGINT)) AS max FROM ${schema}.harness_issues WHERE harness_slug = $1`, [slug]);
    const next = Number(rows[0]?.max ?? 0) + 1;
    return `I-${String(next).padStart(4, '0')}`;
}
function emptyStats() {
    return { pushedCreated: 0, pushedUpdated: 0, pushedTransitioned: 0, pulledCreated: 0, pulledUpdated: 0, conflicts: 0, errors: [] };
}
function extractRemoteMeta(r) {
    return {
        priority: r.priority ?? null,
        assignee: r.assignee?.displayName ?? r.assignee?.email ?? null,
        updatedAt: r.updatedAt,
    };
}
function unionLabels(...lists) {
    const s = new Set();
    for (const list of lists)
        for (const x of list)
            s.add(x);
    return Array.from(s).sort();
}
async function syncFeature(ctx, key, cfg, feature, stats) {
    const slug = ctx.installSlug ?? 'unknown';
    const slugLabel = `${cfg.labelPrefix}-${slug}`;
    const idLabel = `${cfg.labelPrefix}-feat-${feature.feature_id}`;
    const baseLabels = unionLabels([slugLabel, idLabel], feature.tags ?? []);
    const link = await getLink(slug, 'feature', feature.feature_id);
    const localHashNow = await hashLocalFeature(feature);
    const targetStateName = cfg.statusMap[feature.status];
    const targetState = targetStateName ? await resolveStateByName(key, cfg.teamId, targetStateName) : null;
    if (!link) {
        const labelIds = await resolveLabelIds(key, cfg.teamId, baseLabels);
        const remote = await createRemote(key, {
            teamId: cfg.teamId,
            title: feature.title,
            description: feature.summary ?? '',
            labelIds,
            stateId: targetState?.id,
        });
        const remoteHash = await hashRemote(remote, cfg.statusMap);
        await upsertLink({
            harness_slug: slug, entity_kind: 'feature', entity_id: feature.feature_id,
            external_id: remote.id, external_identifier: remote.identifier, external_url: remote.url,
            local_hash: localHashNow, remote_hash: remoteHash, remote_meta: extractRemoteMeta(remote),
        });
        stats.pushedCreated++;
        ctx.log(`linear-sync: created ${remote.identifier} ← feature/${feature.feature_id}`);
        return;
    }
    const remote = await fetchRemoteById(key, link.external_id);
    if (!remote) {
        await upsertLink({ ...link, tombstoned: true, local_hash: localHashNow });
        return;
    }
    const remoteHashNow = await hashRemote(remote, cfg.statusMap);
    const localChanged = localHashNow !== link.local_hash;
    const remoteChanged = remoteHashNow !== link.remote_hash;
    if (!localChanged && !remoteChanged)
        return;
    if (localChanged) {
        const remoteLabelNames = (remote.labels?.nodes ?? []).map((l) => l.name);
        const labelIds = await resolveLabelIds(key, cfg.teamId, unionLabels(remoteLabelNames, baseLabels));
        await updateRemote(key, remote.id, {
            title: feature.title,
            description: feature.summary ?? '',
            labelIds,
            stateId: targetState?.id,
        });
        stats.pushedUpdated++;
        if (targetState && remote.state?.id !== targetState.id)
            stats.pushedTransitioned++;
    }
    if (remoteChanged && localChanged) {
        if (remote.title !== feature.title) {
            await logConflict({ slug, kind: 'feature', entityId: feature.feature_id, externalId: remote.id, field: 'title', localValue: feature.title, remoteValue: remote.title, resolution: 'local-wins' });
            stats.conflicts++;
        }
    }
    const fresh = await fetchRemoteById(key, remote.id);
    const finalRemoteHash = fresh ? await hashRemote(fresh, cfg.statusMap) : remoteHashNow;
    await upsertLink({
        harness_slug: slug, entity_kind: 'feature', entity_id: feature.feature_id,
        external_id: remote.id, external_identifier: remote.identifier, external_url: remote.url,
        local_hash: localHashNow, remote_hash: finalRemoteHash,
        remote_meta: extractRemoteMeta(fresh ?? remote),
    });
}
async function syncIssue(ctx, key, cfg, issue, stats) {
    const slug = ctx.installSlug ?? 'unknown';
    const slugLabel = `${cfg.labelPrefix}-${slug}`;
    const idLabel = `${cfg.labelPrefix}-issue-${issue.issue_id}`;
    const bugLabel = `${cfg.labelPrefix}-bug`;
    const baseLabels = [slugLabel, idLabel, bugLabel];
    const description = [
        issue.repro ? `### Repro\n${issue.repro}` : '',
        issue.evidence ? `### Evidence\n${issue.evidence}` : '',
        issue.suggested_fix ? `### Suggested fix\n${issue.suggested_fix}` : '',
        issue.linked_feature_id ? `### Linked feature\n${issue.linked_feature_id}` : '',
    ].filter(Boolean).join('\n\n');
    const link = await getLink(slug, 'issue', issue.issue_id);
    const localHashNow = await hashLocalIssue(issue);
    if (!link) {
        const labelIds = await resolveLabelIds(key, cfg.teamId, baseLabels);
        const remote = await createRemote(key, { teamId: cfg.teamId, title: issue.title, description, labelIds });
        await upsertLink({
            harness_slug: slug, entity_kind: 'issue', entity_id: issue.issue_id,
            external_id: remote.id, external_identifier: remote.identifier, external_url: remote.url,
            local_hash: localHashNow, remote_hash: await hashRemote(remote, cfg.statusMap), remote_meta: extractRemoteMeta(remote),
        });
        stats.pushedCreated++;
        return;
    }
    const remote = await fetchRemoteById(key, link.external_id);
    if (!remote) {
        await upsertLink({ ...link, tombstoned: true, local_hash: localHashNow });
        return;
    }
    const remoteHashNow = await hashRemote(remote, cfg.statusMap);
    if (localHashNow === link.local_hash && remoteHashNow === link.remote_hash)
        return;
    if (localHashNow !== link.local_hash) {
        const remoteLabelNames = (remote.labels?.nodes ?? []).map((l) => l.name);
        const labelIds = await resolveLabelIds(key, cfg.teamId, unionLabels(remoteLabelNames, baseLabels));
        await updateRemote(key, remote.id, { title: issue.title, description, labelIds });
        stats.pushedUpdated++;
    }
    const fresh = await fetchRemoteById(key, remote.id);
    await upsertLink({
        harness_slug: slug, entity_kind: 'issue', entity_id: issue.issue_id,
        external_id: remote.id, external_identifier: remote.identifier, external_url: remote.url,
        local_hash: localHashNow,
        remote_hash: fresh ? await hashRemote(fresh, cfg.statusMap) : remoteHashNow,
        remote_meta: extractRemoteMeta(fresh ?? remote),
    });
}
async function pullRemoteToLocal(ctx, key, cfg, stats) {
    const slug = ctx.installSlug ?? 'unknown';
    const sql = await pg();
    const cur = await sql `SELECT remote_cursor FROM plugin_linear_sync.cursors WHERE harness_slug = ${slug}`;
    const since = cur[0]?.remote_cursor && new Date(cur[0].remote_cursor).getTime() > 0
        ? new Date(cur[0].remote_cursor) : undefined;
    const remotes = await fetchRemoteForHarness(key, slug, cfg.labelPrefix, since);
    for (const r of remotes) {
        const labelNames = (r.labels?.nodes ?? []).map((l) => l.name);
        const featLabel = labelNames.find((l) => l.startsWith(`${cfg.labelPrefix}-feat-`));
        const issueLabel = labelNames.find((l) => l.startsWith(`${cfg.labelPrefix}-issue-`));
        const isBug = labelNames.includes(`${cfg.labelPrefix}-bug`);
        if (featLabel) {
            const featureId = featLabel.replace(`${cfg.labelPrefix}-feat-`, '');
            const link = await getLink(slug, 'feature', featureId);
            if (!link) {
                await writeLocalFeatureFromRemote(slug, featureId, r, cfg.statusMap);
                const newFeat = (await readLocalFeatures(slug, 0)).find((x) => x.feature_id === featureId);
                if (newFeat) {
                    await upsertLink({
                        harness_slug: slug, entity_kind: 'feature', entity_id: featureId,
                        external_id: r.id, external_identifier: r.identifier, external_url: r.url,
                        local_hash: await hashLocalFeature(newFeat), remote_hash: await hashRemote(r, cfg.statusMap),
                        remote_meta: extractRemoteMeta(r),
                    });
                }
                stats.pulledCreated++;
            }
        }
        else if (issueLabel) {
            const issueId = issueLabel.replace(`${cfg.labelPrefix}-issue-`, '');
            const link = await getLink(slug, 'issue', issueId);
            if (!link) {
                await writeLocalIssueFromRemote(slug, issueId, r);
                stats.pulledCreated++;
            }
        }
        else if (isBug) {
            const newId = await mintIssueId(slug);
            await writeLocalIssueFromRemote(slug, newId, r);
            const newIssue = (await readLocalIssues(slug, 0)).find((x) => x.issue_id === newId);
            if (newIssue) {
                await upsertLink({
                    harness_slug: slug, entity_kind: 'issue', entity_id: newId,
                    external_id: r.id, external_identifier: r.identifier, external_url: r.url,
                    local_hash: await hashLocalIssue(newIssue), remote_hash: await hashRemote(r, cfg.statusMap),
                    remote_meta: extractRemoteMeta(r),
                });
            }
            stats.pulledCreated++;
        }
    }
    await sql `UPDATE plugin_linear_sync.cursors SET remote_cursor = now() WHERE harness_slug = ${slug}`;
}
async function effectiveCfg(ctx, key) {
    const cfg = await readConfig(ctx);
    let teamId = cfg.defaultTeamId;
    if (!teamId && cfg.defaultTeamKey) {
        const id = await resolveTeamId(key, cfg.defaultTeamKey);
        if (!id)
            return null;
        teamId = id;
    }
    if (!teamId)
        return null;
    return {
        teamId,
        labelPrefix: cfg.labelPrefix ?? 'papercusp',
        statusMap: cfg.statusMap ?? DEFAULT_STATUS_MAP,
    };
}
async function runSync(ctx, opts = {}) {
    const stats = emptyStats();
    const slug = ctx.installSlug ?? 'unknown';
    const key = readKey();
    if (!key) {
        ctx.log('linear-sync: runSync — skipped (LINEAR_API_KEY not set)');
        return stats;
    }
    const cfg = await effectiveCfg(ctx, key);
    if (!cfg) {
        ctx.log('linear-sync: runSync — skipped (defaultTeamKey/Id not configured)');
        return stats;
    }
    await ensureSchema(ctx);
    await ensureCursor(slug);
    const sql = await pg();
    const cur = await sql `SELECT local_cursor FROM plugin_linear_sync.cursors WHERE harness_slug = ${slug}`;
    const localCursor = opts.full ? 0 : Number(cur[0]?.local_cursor ?? 0);
    const features = await readLocalFeatures(slug, localCursor);
    const issues = await readLocalIssues(slug, localCursor);
    let maxTs = localCursor;
    for (const f of features) {
        try {
            await syncFeature(ctx, key, cfg, f, stats);
            maxTs = Math.max(maxTs, f.updated_ts);
        }
        catch (e) {
            stats.errors.push({ entity: `feature/${f.feature_id}`, error: e?.message ?? String(e) });
        }
    }
    for (const i of issues) {
        try {
            await syncIssue(ctx, key, cfg, i, stats);
            maxTs = Math.max(maxTs, i.updated_ts);
        }
        catch (e) {
            stats.errors.push({ entity: `issue/${i.issue_id}`, error: e?.message ?? String(e) });
        }
    }
    await sql `UPDATE plugin_linear_sync.cursors SET local_cursor = ${maxTs} WHERE harness_slug = ${slug}`;
    try {
        await pullRemoteToLocal(ctx, key, cfg, stats);
    }
    catch (e) {
        stats.errors.push({ entity: 'remote-pull', error: e?.message ?? String(e) });
    }
    if (opts.full)
        await sql `UPDATE plugin_linear_sync.cursors SET last_full_sync = now() WHERE harness_slug = ${slug}`;
    ctx.log(`linear-sync: tick ↑${stats.pushedCreated}c/${stats.pushedUpdated}u/${stats.pushedTransitioned}t ↓${stats.pulledCreated}c err=${stats.errors.length}`);
    return stats;
}
/* ─────────────────────────────────────────────────────────────────────
 * Plugin manifest
 * ───────────────────────────────────────────────────────────────────── */
const plugin = {
    kind: 'plugin',
    name: '@papercupai/linear-sync',
    version: '0.2.0',
    papercusp: '^0.1.0',
    description: 'Bidirectional background sync between harness features/issues and a Linear team.',
    capabilities: [
        'db:plugin-schema',
        'secrets:read:LINEAR_API_KEY',
        'secrets:read:LINEAR_WEBHOOK_SECRET',
        'http:fetch:api.linear.app',
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
        schemaName: 'plugin_linear_sync',
        sqlPaths: ['./schema.sql'],
    },
    routines: [
        { name: 'sync-tick', trigger: { kind: 'cron', expr: '*/30 * * * * *' }, targetRole: 'linear-sync.runSync', concurrency: 'skip', catchup: 'skip-old' },
        { name: 'webhook', trigger: { kind: 'webhook', tokenEnv: 'LINEAR_WEBHOOK_SECRET' }, targetRole: 'linear-sync.runSync', concurrency: 'queue' },
        { name: 'manual-sync', trigger: { kind: 'api', method: 'POST' }, targetRole: 'linear-sync.runSync', concurrency: 'queue' },
    ],
    actions: [
        { name: 'force-sync', label: 'Force full sync', surfaces: ['plugin-detail'], capabilities: ['secrets:read:LINEAR_API_KEY', 'http:fetch:api.linear.app'], serverHandler: { timeoutSec: 60 } },
        { name: 'backfill-local-to-remote', label: 'Push every harness feature/issue to Linear', surfaces: ['plugin-detail'], capabilities: ['secrets:read:LINEAR_API_KEY', 'http:fetch:api.linear.app'], serverHandler: { timeoutSec: 300 } },
        { name: 'backfill-remote-to-local', label: 'Import every Linear issue tagged for this harness', surfaces: ['plugin-detail'], capabilities: ['secrets:read:LINEAR_API_KEY', 'http:fetch:api.linear.app'], serverHandler: { timeoutSec: 300 } },
    ],
    async init(ctx) {
        ctx.actions.register('force-sync', async (innerCtx) => ({ ok: true, result: await runSync(innerCtx, { full: true }) }));
        ctx.actions.register('backfill-local-to-remote', async (innerCtx) => {
            const sql = await pg();
            const slug = innerCtx.installSlug ?? 'unknown';
            await sql `UPDATE plugin_linear_sync.cursors SET local_cursor = 0 WHERE harness_slug = ${slug}`;
            return { ok: true, result: await runSync(innerCtx, { full: true }) };
        });
        ctx.actions.register('backfill-remote-to-local', async (innerCtx) => {
            const sql = await pg();
            const slug = innerCtx.installSlug ?? 'unknown';
            await sql `UPDATE plugin_linear_sync.cursors SET remote_cursor = 'epoch' WHERE harness_slug = ${slug}`;
            return { ok: true, result: await runSync(innerCtx, { full: true }) };
        });
    },
    hooks: {
        async onLoad(ctx) {
            try {
                await ensureSchema(ctx);
                if (ctx.installSlug)
                    await ensureCursor(ctx.installSlug);
            }
            catch (e) {
                ctx.log(`linear-sync: onLoad — ${e?.message ?? String(e)}`);
            }
        },
        async beforeMissionStart(ctx) {
            try {
                await runSync(ctx, {});
            }
            catch (e) {
                ctx.log(`linear-sync: beforeMissionStart — ${e?.message ?? String(e)}`);
            }
        },
        async onPostValidator(ctx) {
            try {
                await runSync(ctx, {});
            }
            catch (e) {
                ctx.log(`linear-sync: onPostValidator — ${e?.message ?? String(e)}`);
            }
        },
        async afterDone(ctx) {
            try {
                await runSync(ctx, { full: true });
            }
            catch (e) {
                ctx.log(`linear-sync: afterDone — ${e?.message ?? String(e)}`);
            }
        },
    },
};
const apiRoutes = {
    async fetch(req) {
        const url = new URL(req.url);
        const path = url.pathname.replace(/^.*\/plugins\/[^/]+/, '') || url.pathname;
        const slug = url.searchParams.get('slug') ?? 'unknown';
        if (path === '/ping' || path.endsWith('/ping')) {
            return Response.json({ ok: true, plugin: '@papercupai/linear-sync', version: '0.2.0', configured: readKey() !== null });
        }
        if (path.endsWith('/status') && req.method === 'GET') {
            try {
                const sql = await pg();
                const links = await sql `SELECT count(*)::bigint AS n FROM plugin_linear_sync.links WHERE harness_slug = ${slug} AND NOT tombstoned`;
                const cur = await sql `SELECT * FROM plugin_linear_sync.cursors WHERE harness_slug = ${slug}`;
                const drift = await sql `SELECT count(*)::bigint AS n FROM plugin_linear_sync.conflicts WHERE harness_slug = ${slug} AND resolved_at > now() - interval '24 hours'`;
                return Response.json({ ok: true, slug, linkCount: Number(links[0]?.n ?? 0), cursor: cur[0] ?? null, recentConflicts: Number(drift[0]?.n ?? 0) });
            }
            catch (e) {
                return Response.json({ ok: false, error: e?.message ?? String(e) }, { status: 500 });
            }
        }
        if (path.endsWith('/links') && req.method === 'GET') {
            const sql = await pg();
            const rows = await sql `SELECT * FROM plugin_linear_sync.links WHERE harness_slug = ${slug} ORDER BY last_synced_at DESC LIMIT 200`;
            return Response.json({ ok: true, links: rows });
        }
        if (path.endsWith('/conflicts') && req.method === 'GET') {
            const sql = await pg();
            const rows = await sql `SELECT * FROM plugin_linear_sync.conflicts WHERE harness_slug = ${slug} ORDER BY resolved_at DESC LIMIT 50`;
            return Response.json({ ok: true, conflicts: rows });
        }
        if (path.endsWith('/webhook') && req.method === 'POST') {
            const secret = process.env.LINEAR_WEBHOOK_SECRET;
            const provided = req.headers.get('linear-signature') ?? url.searchParams.get('secret');
            if (secret && provided !== secret)
                return Response.json({ ok: false, error: 'bad secret' }, { status: 401 });
            const sql = await pg();
            await sql `UPDATE plugin_linear_sync.cursors SET remote_cursor = LEAST(remote_cursor, now() - interval '5 minutes') WHERE harness_slug = ${slug}`;
            return Response.json({ ok: true, queued: true });
        }
        if (path.endsWith('/sync') && req.method === 'POST') {
            const ctx = {
                installSlug: slug, projectDir: process.cwd(),
                stateDir: process.env.PAPERCUSP_STATE_DIR ?? `${process.env.HOME}/.papercusp/harnesses/${slug}`,
                pluginDataDir: `${process.env.HOME}/.papercusp/harnesses/${slug}/plugins/linear-sync`,
                log: (m) => console.log(`[linear-sync] ${m}`),
            };
            try {
                return Response.json({ ok: true, stats: await runSync(ctx, {}) });
            }
            catch (e) {
                return Response.json({ ok: false, error: e?.message ?? String(e) }, { status: 500 });
            }
        }
        return Response.json({ error: 'not found', path }, { status: 404 });
    },
};
plugin.apiRoutes = apiRoutes;
exports.default = plugin;
