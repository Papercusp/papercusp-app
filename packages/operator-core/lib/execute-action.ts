/**
 * executeAction core — auth + dispatch + idempotency.
 *
 * Wire contract: apps/operator/docs/host/execute-action.contract.md
 * Plan: apps/operator-docs/src/content/docs/implementation/multi-harness-spawning.mdx
 *
 * Responsibilities:
 *   1. Verify Authorization: Bearer <token> against harness_shared.token_index
 *   2. Reject body-supplied identity fields that don't match
 *   3. Dispatch on action.op
 *   4. Cache to harness_<callerSlug>.executed_actions for idempotency replay
 *
 * The verbs (spinup_project, scaffold_harness, pause/resume_project,
 * create_feature, add_directive_summary) are implemented in this module.
 *
 * RETIRED 2026-07-26 (plan surface-every-routine-and-unbreak-automation-panes
 * -2026-07-25 P-008, owner-directed): the work-item MAIL verbs — send_message,
 * mark_message_status and mark_campaign_published — were removed along with the
 * rest of the `harness_<slug>.messages` surface. coord:send absorbed the job at
 * ~400x the volume. The rows are preserved; only the code path is gone. Do NOT
 * reintroduce a message verb here — see _retired/work-item-mail/RESTORE.md.
 *
 * ADDED 2026-07-26 (agent-trap-guards-2026-07-26 P-001, EI-18740258166031188):
 * `send_directive` fills the gap the retirement above left open — the
 * operator panel's directive-dispatch cards ("Accept" on a suggestion) still
 * POST `op:'send_message'` to this dispatcher, which no longer implements it,
 * so every accepted directive card hard-failed. `send_directive` performs the
 * equivalent of `coord:send` (a durable, harness-scoped coordination message)
 * instead of reintroducing the retired per-harness mailbox.
 */
import { getOrgPg, generated } from '@papercusp/db-org';
import { eq } from 'drizzle-orm';
import { activeWorkspaceId } from './workspace-registry';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { scaffoldHarnessSchema } from './scaffold-harness-schema';
import { operatorApiBase } from './operator-api-base';
import { sendMessage } from './agent-tools/coordination/messages';
import type { AgentIdentity } from './agent-tools/coordination/identity';

const execFileP = promisify(execFile);

function slugToSchema(slug: string): string {
  return 'harness_' + slug.replace(/-/g, '_').toLowerCase();
}

// The harness-schema existence cache (schemaExistsCache /
// harnessSchemaExists / __resetSchemaExistsCacheForTest) and the
// PLACEHOLDER_REASON audit regex were REMOVED 2026-07-26 with the work-item
// mail surface (P-008): the recipient-existence probe they optimised
// (WI-3800) existed solely for doSendMessage's multi-recipient pre-check,
// and PLACEHOLDER_REASON only graded that verb's `reason` field.

function isValidProjectSlug(s: string): boolean {
  return /^[a-z0-9][a-z0-9-]{1,63}$/.test(s);
}

export interface ExecuteActionRequest {
  actionId: string;
  callingHarness?: string;
  callingDept?: string;
  action: ExecuteAction;
}

export type ExecuteAction =
  | SpinupProjectAction
  | ScaffoldHarnessAction
  | PauseProjectAction
  | ResumeProjectAction
  | AddDirectiveSummaryAction
  | CreateFeatureAction
  | SendDirectiveAction;

export interface SendDirectiveAction {
  op: 'send_directive';
  /** coord:send-shaped recipients — mirrors OperatorPanel's `[card.target_harness]`. */
  to: string[];
  /** Directive category surfaced to the recipient. Default 'Directive'. */
  kind?: 'Directive' | 'Decision' | 'Priority';
  subject?: string;
  body?: string;
  /** Audit string — why this directive is being dispatched. */
  reason?: string;
}

export interface CreateFeatureAction {
  op: 'create_feature';
  harness_slug: string;
  title: string;
  summary?: string;
  goal_id?: string;
  expected_cost_cents?: number;
  /** Audit string (≥10 chars) — why this feature is being created. */
  reason: string;
  /** Optional explicit feature_id; if absent, server generates one. */
  feature_id?: string;
}

export interface AddDirectiveSummaryAction {
  op: 'add_directive_summary';
  directiveId: string;
  summary: string; // ≥10 chars; appended with ts + caller
  source?: 'ceo' | 'user' | 'auditor';
}

export interface PauseProjectAction {
  op: 'pause_project';
  projectSlug: string;
  reason?: string;
}

export interface ResumeProjectAction {
  op: 'resume_project';
  projectSlug: string;
  status?: string; // default 'in_progress'
}

export interface SpinupProjectAction {
  op: 'spinup_project';
  directiveId: string;
  projectName: string;
  projectVertical: string;
  projectBudgetCents: number;
  departments: string[];
}

export interface ScaffoldHarnessAction {
  op: 'scaffold_harness';
  projectSlug: string;
  template: string;
  spec: string;
  /** @deprecated kept for callers still passing GOAL.md content; merged into spec on write. */
  goal?: string;
  parent_slug?: string; // body-supplied; rejected (server-derived)
  dryRun?: boolean;     // if true, validate-only — no shell-out, no FS writes
}

export interface ExecuteActionResult {
  ok: boolean;
  actionId: string;
  result?: any;
  error?: string;
  detail?: string;
  cached?: boolean;
}

export interface ExecuteActionAuthFail {
  status: 401 | 403 | 400;
  error: string;
  detail?: string;
}

/**
 * Verify the bearer token and return the derived caller slug. Returns
 * either { ok: true, slug } or { ok: false, status, error }.
 */
export async function deriveCallerFromBearer(authHeader: string | null | undefined):
  Promise<{ ok: true; slug: string } | { ok: false; status: 401; error: string; detail?: string }> {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { ok: false, status: 401, error: 'invalid_or_missing_token', detail: 'no Bearer header' };
  }
  const token = authHeader.slice(7).trim();
  if (!token) {
    return { ok: false, status: 401, error: 'invalid_or_missing_token', detail: 'empty token' };
  }
  const { sql } = getOrgPg();
  const rows = await sql<{ harness_slug: string }[]>`
    SELECT harness_slug FROM harness_shared.token_index WHERE token = ${token} LIMIT 1
  `;
  if (rows.length === 0) {
    return { ok: false, status: 401, error: 'invalid_or_missing_token', detail: 'token not found' };
  }
  return { ok: true, slug: rows[0].harness_slug };
}

/**
 * Validate body-supplied identity fields against the bearer-derived caller.
 * Returns null on success, or an auth-fail descriptor.
 */
export function validateIdentityFields(
  derivedSlug: string,
  body: ExecuteActionRequest,
): ExecuteActionAuthFail | null {
  if (body.callingHarness && body.callingHarness !== derivedSlug) {
    return { status: 403, error: 'identity_mismatch', detail: `body.callingHarness=${body.callingHarness} does not match bearer-derived ${derivedSlug}` };
  }
  const { action } = body;
  if (action.op === 'scaffold_harness' && action.parent_slug !== undefined) {
    return { status: 400, error: 'parent_slug_not_caller_controlled', detail: 'parent_slug is server-derived; do not include it in the request body' };
  }
  return null;
}

/**
 * Idempotency check: return cached response if actionId was already
 * processed for this caller.
 *
 * Default mode (cache-is-authoritative): cached response returned without
 * verifying side effects still exist. If something out-of-band deleted the
 * row that the verb produced, replay still returns ok.
 *
 * Opt-in cache-and-verify mode (set PAPERCUSP_REPLAY_VERIFY=1): re-runs a
 * lightweight existence check on the produced side effect and, if missing,
 * treats the cache as stale (returns null so the caller re-executes).
 * Currently checks: spinup_project → project row still exists;
 * scaffold_harness → harness still in registry.
 */
const REPLAY_VERIFY = process.env.PAPERCUSP_REPLAY_VERIFY === '1';

async function getCachedAction(callerSlug: string, actionId: string): Promise<any | null> {
  // System principals don't have a per-harness executed_actions schema —
  // see saveAction for the rationale. No cache means no idempotency for
  // operator-initiated actions, which is acceptable: the dispatch path
  // already de-dupes by card id.
  if (callerSlug.startsWith('system:')) return null;
  const { sql } = getOrgPg();
  const schema = slugToSchema(callerSlug);
  const rows = await sql.unsafe(
    `SELECT op, target_slug, request, response FROM ${schema}.executed_actions WHERE action_id = $1 LIMIT 1`,
    [actionId],
  );
  if (rows.length === 0) return null;
  const r = (rows as any)[0];
  if (!REPLAY_VERIFY) return r.response;

  // Cache-and-verify: lightweight existence check on the produced side effect.
  try {
    const stillExists = await verifyEffectExists(r.op, r.target_slug, r.request, r.response);
    if (!stillExists) return null; // stale cache; force re-execution
  } catch {
    // Verification itself failed (e.g. schema dropped). Conservatively treat as stale.
    return null;
  }
  return r.response;
}

async function verifyEffectExists(
  op: string,
  targetSlug: string | null,
  _request: any,
  response: any,
): Promise<boolean> {
  const { sql } = getOrgPg();
  if (op === 'spinup_project') {
    const projectId = response?.result?.projectId;
    if (!projectId) return true;
    const rows = await sql<{ id: string }[]>`SELECT id FROM harness_shared.projects WHERE id = ${projectId} LIMIT 1`;
    return rows.length > 0;
  }
  if (op === 'scaffold_harness' && targetSlug) {
    const rows = await sql<{ harness_slug: string }[]>`
      SELECT harness_slug FROM harness_shared.token_index WHERE harness_slug = ${targetSlug} LIMIT 1
    `;
    return rows.length > 0;
  }
  if (op === 'create_feature' && targetSlug) {
    const featureId = response?.result?.feature_id;
    if (!featureId) return true;
    const rows = await sql<{ feature_id: string }[]>`
      SELECT feature_id FROM harness_shared.harness_features_consolidated
       WHERE harness_slug = ${targetSlug} AND feature_id = ${featureId} LIMIT 1
    `;
    return rows.length > 0;
  }
  // Unknown ops: trust the cache.
  return true;
}

async function saveAction(opts: {
  callerSlug: string;
  actionId: string;
  op: string;
  targetSlug: string | null;
  reason: string | null;
  request: any;
  response: any;
}): Promise<void> {
  // System principals (e.g. "system:operator") have no per-harness
  // schema; persisting an executed_actions row would generate
  // `harness_system:operator.executed_actions` which Postgres rejects
  // with `syntax error at or near ":"`. Skip the cache write — the
  // operator's own audit_log captures the dispatch separately.
  if (opts.callerSlug.startsWith('system:')) return;
  const { sql } = getOrgPg();
  const schema = slugToSchema(opts.callerSlug);
  // workspace_id stamped EXPLICITLY (WI-5243, the WI-5125 class). These
  // per-harness views used to carry `ALTER COLUMN workspace_id SET DEFAULT
  // 'default'`, so omitting the column filed the row under the WRONG tenant and
  // still reported success. Migration 616 dropped that literal and left a
  // derive-trigger as the net, but the net reads harness_shared.projects (a
  // near-empty legacy registry), so the active workspace must come from the
  // process — exactly as this file already does for its harness_shared.projects
  // and token_index writes below.
  await sql.unsafe(
    `INSERT INTO ${schema}.executed_actions (workspace_id, action_id, op, caller_slug, target_slug, reason, request, response)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb)
     ON CONFLICT (harness_slug, action_id) DO NOTHING`,
    [
      activeWorkspaceId(),
      opts.actionId,
      opts.op,
      opts.callerSlug,
      opts.targetSlug,
      opts.reason,
      JSON.stringify(opts.request),
      JSON.stringify(opts.response),
    ],
  );
}

function extractTargetSlug(action: ExecuteAction): string | null {
  switch (action.op) {
    case 'create_feature': return action.harness_slug ?? null;
    case 'spinup_project': return null;
    case 'scaffold_harness': return action.projectSlug ?? null;
    case 'send_directive': return action.to?.[0] ?? null;
    default: return null;
  }
}

// ── Verb implementations ───────────────────────────────────────────────────

async function doSpinupProject(
  callerSlug: string,
  action: SpinupProjectAction,
): Promise<ExecuteActionResult> {
  const { sql } = getOrgPg();
  if (!action.directiveId || !action.projectName || !Array.isArray(action.departments)) {
    return { ok: false, actionId: '', error: 'validation_error', detail: 'directiveId, projectName, departments[] required' };
  }
  if (typeof action.projectBudgetCents !== 'number' || action.projectBudgetCents < 0) {
    return { ok: false, actionId: '', error: 'validation_error', detail: 'projectBudgetCents must be non-negative number' };
  }

  const projectId = `PROJ-${randomBytes(4).toString('hex')}`;
  const projectSlug = action.projectName.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || projectId.toLowerCase();
  const now = Date.now();

  // Single transaction across schemas.
  const subActions: { op: string; ok: boolean; messageId?: string; recipient?: string; error?: string }[] = [];
  try {
    await sql.begin(async (tx) => {
      // Workspace_id derived from active workspace at action time.
      // The bearer-derived caller's workspace is set in the operator's
      // registry; cross-workspace dispatch is not supported in v1.
      const ws = activeWorkspaceId();
      await tx.unsafe(
        `INSERT INTO harness_shared.projects (id, name, status, slug, budget_cents, owning_dept, vertical, created_ts, updated_ts, parent_slug, workspace_id)
         VALUES ($1, $2, 'in_progress', $3, $4, $5, $6, $7, $7, $8, $9)
         ON CONFLICT (id) DO NOTHING`,
        [projectId, action.projectName, projectSlug, action.projectBudgetCents, action.departments[0] ?? null, action.projectVertical, now, callerSlug, ws],
      );

      // The Kickoff/Priority/Budget message fan-out to each department was
      // REMOVED 2026-07-26 with the rest of the work-item mail surface (P-008,
      // owner-directed). It was the last writer to `harness_<slug>.messages`
      // outside the retired mail verbs; the project row above is unaffected.
    });
  } catch (e) {
    return { ok: false, actionId: '', error: 'internal', detail: String((e as Error).message).slice(0, 500), result: { subActions } };
  }

  return {
    ok: true,
    actionId: '',
    result: { projectId, projectSlug, subActions },
  };
}

// Maximum spawn depth (parent → child → grandchild → ...). Prevents runaway
// trees + protects context size. Configurable via PAPERCUSP_MAX_SPAWN_DEPTH.
const MAX_SPAWN_DEPTH = Number(process.env.PAPERCUSP_MAX_SPAWN_DEPTH ?? 8);

async function detectCycleOrTooDeep(callerSlug: string, projectSlug: string): Promise<{ ok: true } | { ok: false; error: string; detail: string }> {
  if (callerSlug === projectSlug) {
    return { ok: false, error: 'validation_error', detail: 'a harness cannot spawn itself' };
  }
  // Walk parent_slug chain from caller upward; reject if we hit projectSlug
  // (would create a cycle) or if depth >= MAX_SPAWN_DEPTH.
  const { sql } = getOrgPg();
  const visited = new Set<string>();
  let cur: string | null = callerSlug;
  let depth = 0;
  while (cur && depth < MAX_SPAWN_DEPTH + 2) {
    if (visited.has(cur)) {
      return { ok: false, error: 'validation_error', detail: `existing parent chain already cycles at ${cur}` };
    }
    visited.add(cur);
    if (cur === projectSlug) {
      return { ok: false, error: 'validation_error', detail: `cycle: requested child ${projectSlug} is an ancestor of caller ${callerSlug}` };
    }
    depth++;
    if (depth > MAX_SPAWN_DEPTH) {
      return { ok: false, error: 'validation_error', detail: `spawn chain exceeds depth ${MAX_SPAWN_DEPTH}; refuse to deepen` };
    }
    const rows: { parent_slug: string | null }[] = await sql`
      SELECT parent_slug FROM harness_shared.projects WHERE slug = ${cur} LIMIT 1
    `;
    cur = rows.length > 0 ? rows[0].parent_slug : null;
  }
  return { ok: true };
}

async function doScaffoldHarness(
  callerSlug: string,
  action: ScaffoldHarnessAction,
): Promise<ExecuteActionResult> {
  if (!action.projectSlug || !isValidProjectSlug(action.projectSlug)) {
    return { ok: false, actionId: '', error: 'validation_error', detail: 'projectSlug must match /^[a-z0-9][a-z0-9-]{1,63}$/' };
  }
  if (!action.template || !action.spec) {
    return { ok: false, actionId: '', error: 'validation_error', detail: 'template, spec required' };
  }

  // Cycle / depth detection — prevents runaway trees and self-spawn.
  const cycle = await detectCycleOrTooDeep(callerSlug, action.projectSlug);
  if (!cycle.ok) {
    return { ok: false, actionId: '', error: cycle.error, detail: cycle.detail };
  }

  const { sql } = getOrgPg();

  // Validate template is in the spawnable catalog.
  const spawnable = await fetchSpawnableTemplates();
  const tmpl = spawnable.find((t) => t.name === action.template);
  if (!tmpl) {
    return { ok: false, actionId: '', error: 'template_not_spawnable', detail: `template ${action.template} not in spawnable catalog` };
  }

  // Slug uniqueness for the HARNESS slug (different namespace from
  // harness_shared.projects.slug — a project can have the same name as the
  // harness it's scaffolded into, but two harnesses can't share a slug).
  // Check token_index (authoritative for harness slugs) + on-disk path.
  const tokenIdxRows = await sql<{ harness_slug: string }[]>`
    SELECT harness_slug FROM harness_shared.token_index WHERE harness_slug = ${action.projectSlug} LIMIT 1
  `;
  if (tokenIdxRows.length > 0) {
    return { ok: false, actionId: '', error: 'slug_already_in_use', detail: `harness slug ${action.projectSlug} already in use` };
  }

  // Decide target path (default ~/.papercusp/projects/<slug>).
  const homeDir = process.env.HOME || '/tmp';
  const projectsRoot = process.env.PAPERCUSP_PROJECTS_ROOT || join(homeDir, '.papercusp', 'projects');
  const projectPath = join(projectsRoot, action.projectSlug);
  if (existsSync(projectPath)) {
    return { ok: false, actionId: '', error: 'slug_already_in_use', detail: `path ${projectPath} already exists on disk` };
  }

  // dryRun: validation-only path. Returns what would have been bound,
  // without shelling out, writing files, or scaffolding the schema.
  if (action.dryRun) {
    return {
      ok: true,
      actionId: '',
      result: {
        dryRun: true,
        slug: action.projectSlug,
        path: projectPath,
        template: action.template,
        parent_slug: callerSlug,
        templateKind: tmpl.spawnable?.kind ?? null,
      },
    };
  }

  // Shell out to `papercusp init`. Without --target, init creates the project
  // dir under PAPERCUSP_PROJECTS_ROOT/<slug>.
  const cliPath = process.env.PAPERCUSP_CLI ?? join(homeDir, '.local/bin/papercusp');
  let initStdout = '';
  try {
    const r = await execFileP(cliPath, ['init', action.projectSlug, '--from', action.template], {
      timeout: 5 * 60 * 1000, // 5 min
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, PAPERCUSP_PROJECTS_ROOT: projectsRoot },
    });
    initStdout = r.stdout || '';
  } catch (e: any) {
    // Roll back partial scaffold.
    if (existsSync(projectPath)) {
      try { await fs.rm(projectPath, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    const msg = String(e?.message ?? e).slice(0, 800);
    const timedOut = /killed|timeout/i.test(msg) || e?.killed === true;
    return {
      ok: false,
      actionId: '',
      error: 'internal',
      detail: timedOut ? `papercusp init timeout: ${msg}` : `papercusp init failed: ${msg}`,
      result: { partialPath: projectPath, timeout: timedOut },
    };
  }

  // Generate harness_token + merge into config.json (mode 0600).
  const harnessToken = base64url(randomBytes(32));
  const configPath = join(projectPath, '.papercusp', 'config.json');
  try {
    let cfg: any = {};
    if (existsSync(configPath)) {
      const txt = await fs.readFile(configPath, 'utf8');
      try { cfg = JSON.parse(txt); } catch { cfg = {}; }
    } else {
      await fs.mkdir(join(projectPath, '.papercusp'), { recursive: true });
    }
    cfg.harness_token = harnessToken;
    cfg.parent_slug = callerSlug;
    cfg.slug = action.projectSlug;
    await fs.writeFile(configPath, JSON.stringify(cfg, null, 2), 'utf8');
    await fs.chmod(configPath, 0o600);
  } catch (e: any) {
    return { ok: false, actionId: '', error: 'internal', detail: `failed to write .papercusp/config.json: ${e?.message}`, result: { partialPath: projectPath } };
  }

  // `papercusp init` already added the harness to the file registry (which
  // the operator reads via /api/harness/projects). Provision the per-harness
  // PG schema in-process — see lib/scaffold-harness-schema.ts.
  try {
    await scaffoldHarnessSchema(action.projectSlug);
  } catch (e: any) {
    return {
      ok: false,
      actionId: '',
      error: 'internal',
      detail: `schema scaffold failed: ${String(e?.message ?? e).slice(0, 500)}`,
      result: { partialPath: projectPath },
    };
  }

  // Persist the harness token to the authoritative store (token_index).
  // The per-harness config_token table was retired — token_index (workspace-
  // owned) is the single source of truth for token→harness auth lookups.
  await sql`
    INSERT INTO harness_shared.token_index (token, kind, harness_slug, workspace_id)
    VALUES (${harnessToken}, 'harness', ${action.projectSlug}, ${activeWorkspaceId()})
    ON CONFLICT (token) DO UPDATE
      SET kind = 'harness',
          harness_slug = EXCLUDED.harness_slug,
          workspace_id = EXCLUDED.workspace_id
  `;

  // Mirror parent_slug into harness_shared.projects so the registry knows
  // who spawned this child. `papercusp init` only writes to the file
  // registry; this is the PG-side bookkeeping. We INSERT or UPDATE since
  // some harnesses are tracked here (those that have a project record);
  // newly-spawned children may not yet have one — that's fine, parent_slug
  // is null until something else inserts the project row.
  await sql`
    UPDATE harness_shared.projects SET parent_slug = ${callerSlug}
    WHERE slug = ${action.projectSlug}
  `;

  // Entry-seam migration (deprecate-harness-config-json-2026-06-06): lift any
  // instance config the init template scaffolded into `.papercusp/config.json`
  // (phase / models / knob overrides) into the workspace-PG registry — the live
  // config path never reads the file. Best-effort no-op when init didn't
  // register the child in this registry yet or wrote no instance content.
  try {
    const { migrateConfigJsonToInstance } = await import('./deployment/instance-config');
    await migrateConfigJsonToInstance(action.projectSlug, activeWorkspaceId());
  } catch { /* never blocks the scaffold */ }

  return {
    ok: true,
    actionId: '',
    result: {
      slug: action.projectSlug,
      path: projectPath,
      template: action.template,
      parent_slug: callerSlug,
    },
  };
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

interface SpawnableTemplate {
  name: string;
  version: string;
  spawnable?: { kind?: string; requires?: string[] };
}

async function fetchSpawnableTemplates(): Promise<SpawnableTemplate[]> {
  // Read directly from the operator's marketplace catalog endpoint.
  const operatorBase = operatorApiBase();
  try {
    const r = await fetch(`${operatorBase}/api/marketplace/spawnable`);
    if (r.ok) {
      const d: any = await r.json();
      return Array.isArray(d?.spawnable) ? d.spawnable : [];
    }
  } catch { /* fall through */ }
  return [];
}

// ── Public dispatch ────────────────────────────────────────────────────────

async function doPauseProject(
  _callerSlug: string,
  action: PauseProjectAction,
): Promise<ExecuteActionResult> {
  if (!action.projectSlug) return { ok: false, actionId: '', error: 'validation_error', detail: 'projectSlug required' };
  const { db } = getOrgPg();
  const p = generated.projectsInHarnessShared;
  const rows = await db
    .update(p)
    .set({ status: 'paused', updatedTs: Date.now() })
    .where(eq(p.slug, action.projectSlug))
    .returning({ id: p.id, slug: p.slug, status: p.status });
  if (rows.length === 0) return { ok: false, actionId: '', error: 'not_found', detail: `project ${action.projectSlug} not found` };
  return { ok: true, actionId: '', result: { project: rows[0], reason: action.reason ?? null } };
}

async function doResumeProject(
  _callerSlug: string,
  action: ResumeProjectAction,
): Promise<ExecuteActionResult> {
  if (!action.projectSlug) return { ok: false, actionId: '', error: 'validation_error', detail: 'projectSlug required' };
  const target = action.status ?? 'in_progress';
  const { db } = getOrgPg();
  const p = generated.projectsInHarnessShared;
  const rows = await db
    .update(p)
    .set({ status: target, updatedTs: Date.now() })
    .where(eq(p.slug, action.projectSlug))
    .returning({ id: p.id, slug: p.slug, status: p.status });
  if (rows.length === 0) return { ok: false, actionId: '', error: 'not_found', detail: `project ${action.projectSlug} not found` };
  return { ok: true, actionId: '', result: { project: rows[0] } };
}

async function doAddDirectiveSummary(
  callerSlug: string,
  action: AddDirectiveSummaryAction,
): Promise<ExecuteActionResult> {
  if (!action.directiveId || typeof action.summary !== 'string' || action.summary.trim().length < 10) {
    return { ok: false, actionId: '', error: 'validation_error', detail: 'directiveId and summary (≥10 chars) required' };
  }
  const source = action.source ?? 'ceo';
  if (!['ceo', 'user', 'auditor'].includes(source)) {
    return { ok: false, actionId: '', error: 'validation_error', detail: `source must be one of ceo|user|auditor (got ${source})` };
  }
  const { sql } = getOrgPg();
  const schema = slugToSchema(callerSlug);
  const rows = await sql.unsafe(
    `INSERT INTO ${schema}.directive_summaries (workspace_id, directive_id, source, summary, caller_slug)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, created_at`,
    [activeWorkspaceId(), action.directiveId, source, action.summary.trim(), callerSlug], // ws explicit (WI-5243)
  );
  return {
    ok: true,
    actionId: '',
    result: { id: (rows as any)[0].id, directiveId: action.directiveId, source },
  };
}

/** Stable sender identity for operator-dispatched directives (the OperatorPanel
 *  "Accept" click on a suggestion card) — mirrors severe-event-broadcast's
 *  SEVERE_EVENT_IDENTITY pattern for a server-side, non-agent sender. Not a
 *  live agent session, so it carries no workspaceId-scoped presence — the
 *  dispatch is attributable (the operator itself), never anonymous. */
const SEND_DIRECTIVE_IDENTITY: AgentIdentity = {
  ownerId: 'system:operator-directive',
  ownerLabel: 'operator · directive',
  source: 'principal',
  workspaceId: null,
  userId: null,
};

async function doSendDirective(
  _callerSlug: string,
  action: SendDirectiveAction,
): Promise<ExecuteActionResult> {
  const to = Array.isArray(action.to)
    ? action.to.filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
    : [];
  if (to.length === 0) {
    return { ok: false, actionId: '', error: 'validation_error', detail: 'send_directive: to (non-empty string[]) required' };
  }
  const kind = action.kind ?? 'Directive';
  const subject = typeof action.subject === 'string' ? action.subject.trim() : '';
  const body = typeof action.body === 'string' ? action.body.trim() : '';
  if (!subject && !body) {
    return { ok: false, actionId: '', error: 'validation_error', detail: 'send_directive: subject or body required' };
  }
  const summary = subject ? `[${kind}] ${subject}` : `[${kind}]`;

  let env;
  try {
    env = await sendMessage(SEND_DIRECTIVE_IDENTITY, {
      to,
      summary,
      body: body || undefined,
      category: 'operator-directive',
      extra: {
        directiveKind: kind,
        ...(subject ? { directiveSubject: subject } : {}),
        ...(action.reason ? { reason: action.reason } : {}),
      },
    });
  } catch (e: any) {
    return { ok: false, actionId: '', error: 'internal', detail: `coord send failed: ${String(e?.message ?? e).slice(0, 500)}` };
  }

  return {
    ok: true,
    actionId: '',
    // `msg_id` is the stable id the panel now reads in place of the retired
    // mail surface's `messageId`.
    result: { msg_id: env.msg_id, to: env.to, ts: env.ts },
  };
}

const FEATURE_ID_RE = /^[A-Z][A-Z0-9-]+(-[A-Z0-9-]+)?$/;

async function doCreateFeature(
  callerSlug: string,
  action: CreateFeatureAction,
): Promise<ExecuteActionResult> {
  if (!action.harness_slug || typeof action.harness_slug !== 'string') {
    return { ok: false, actionId: '', error: 'validation_error', detail: 'harness_slug required' };
  }
  if (!action.title || typeof action.title !== 'string' || action.title.trim().length === 0) {
    return { ok: false, actionId: '', error: 'validation_error', detail: 'title required' };
  }
  if (typeof action.reason !== 'string' || action.reason.trim().length < 10) {
    return { ok: false, actionId: '', error: 'validation_error', detail: 'reason (≥10 chars) required' };
  }
  // Caller must own the target harness, or be an admin caller
  // (matches the existing pattern in validateIdentityFields — when the
  // bearer principal's slug differs from action.harness_slug we treat
  // it as cross-harness which the gateway already rejects unless the
  // bearer has admin scope; here we simply require the caller to be
  // the harness owner).
  if (callerSlug !== action.harness_slug) {
    return {
      ok: false, actionId: '', error: 'forbidden',
      detail: `caller ${callerSlug} cannot create features in harness ${action.harness_slug}`,
    };
  }

  // Generate or validate the feature id.
  const explicitId = action.feature_id?.trim() ?? '';
  let featureId: string;
  if (explicitId) {
    if (!FEATURE_ID_RE.test(explicitId)) {
      return {
        ok: false, actionId: '', error: 'validation_error',
        detail: `feature_id must match ${FEATURE_ID_RE.source}`,
      };
    }
    featureId = explicitId;
  } else {
    // F-AUTO-{base36 timestamp + 4 random chars}, all uppercase to satisfy
    // FEATURE_ID_RE.
    const ts = Date.now().toString(36).toUpperCase();
    const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
    featureId = `F-AUTO-${ts}${rand}`;
  }

  const { sql } = getOrgPg();
  const now = Date.now();

  // Use a transaction so the duplicate-check + insert can't race.
  // Direct write to harness_features_consolidated (the canonical store
  // post-migration 029); BEFORE INSERT trigger fill_needs_design_trg
  // (migration 050) auto-computes needs_design from title + summary.
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe(`SELECT set_config('app.workspace_id', $1, true)`, [callerSlug]);
      const dup = await tx`
        SELECT 1 FROM harness_shared.harness_features_consolidated
         WHERE harness_slug = ${action.harness_slug} AND feature_id = ${featureId}
         LIMIT 1
      `;
      if ((dup as Array<unknown>).length > 0) {
        throw new Error(`duplicate:${featureId}`);
      }
      await tx`
        INSERT INTO harness_shared.work_items (
          harness_slug, feature_id, title, summary, status, attempts,
          expected_cost_cents, goal_id, needs_human_review,
          ts, created_ts, updated_ts
        ) VALUES (
          ${action.harness_slug}, ${featureId},
          ${action.title.trim()},
          ${action.summary ?? null},
          -- work-item-status-full-unify P-004/P-005: fresh feature-family row → unified
          -- claimable token 'open' (was 'todo'), consistent with the ['open'] claim floor.
          'open', 0,
          ${action.expected_cost_cents ?? null},
          ${action.goal_id ?? null},
          FALSE,
          ${now}, ${now}, ${now}
        )
      `;
    });
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('duplicate:')) {
      return {
        ok: false, actionId: '', error: 'conflict',
        detail: `feature_id ${featureId} already exists in ${action.harness_slug}`,
      };
    }
    return {
      ok: false, actionId: '', error: 'pg_error',
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  return {
    ok: true,
    actionId: '',
    result: {
      feature_id: featureId,
      harness_slug: action.harness_slug,
      title: action.title.trim(),
      status: 'open', // work-item-status-full-unify P-004/P-005: mirrors the INSERT above
    },
  };
}

/**
 * Validate that an action has the required fields for its op.
 * Returns null on success, or a validation error descriptor on failure.
 *
 * This ensures that malformed actions are rejected BEFORE dispatch,
 * so state remains clean (no partial writes or side effects).
 */
function validateActionShape(action: ExecuteAction): ExecuteActionResult | null {
  const a = action as any;

  switch (action.op) {
    case 'spinup_project': {
      if (typeof a.directiveId !== 'string' || !a.directiveId) {
        return { ok: false, actionId: '', error: 'validation_error', detail: 'spinup_project: directiveId (string) required' };
      }
      if (typeof a.projectName !== 'string' || !a.projectName) {
        return { ok: false, actionId: '', error: 'validation_error', detail: 'spinup_project: projectName (string) required' };
      }
      if (!Array.isArray(a.departments)) {
        return { ok: false, actionId: '', error: 'validation_error', detail: 'spinup_project: departments (array) required' };
      }
      if (typeof a.projectBudgetCents !== 'number' || a.projectBudgetCents < 0) {
        return { ok: false, actionId: '', error: 'validation_error', detail: 'spinup_project: projectBudgetCents (non-negative number) required' };
      }
      break;
    }

    case 'scaffold_harness': {
      if (typeof a.projectSlug !== 'string' || !a.projectSlug) {
        return { ok: false, actionId: '', error: 'validation_error', detail: 'scaffold_harness: projectSlug (string) required' };
      }
      if (typeof a.template !== 'string' || !a.template) {
        return { ok: false, actionId: '', error: 'validation_error', detail: 'scaffold_harness: template (string) required' };
      }
      if (typeof a.spec !== 'string' || !a.spec) {
        return { ok: false, actionId: '', error: 'validation_error', detail: 'scaffold_harness: spec (string) required' };
      }
      break;
    }

    case 'pause_project': {
      if (typeof a.projectSlug !== 'string' || !a.projectSlug) {
        return { ok: false, actionId: '', error: 'validation_error', detail: 'pause_project: projectSlug (string) required' };
      }
      break;
    }

    case 'resume_project': {
      if (typeof a.projectSlug !== 'string' || !a.projectSlug) {
        return { ok: false, actionId: '', error: 'validation_error', detail: 'resume_project: projectSlug (string) required' };
      }
      break;
    }

    case 'add_directive_summary': {
      if (typeof a.directiveId !== 'string' || !a.directiveId) {
        return { ok: false, actionId: '', error: 'validation_error', detail: 'add_directive_summary: directiveId (string) required' };
      }
      if (typeof a.summary !== 'string' || a.summary.trim().length < 10) {
        return { ok: false, actionId: '', error: 'validation_error', detail: 'add_directive_summary: summary (≥10 chars) required' };
      }
      break;
    }

    case 'create_feature': {
      if (typeof a.harness_slug !== 'string' || !a.harness_slug) {
        return { ok: false, actionId: '', error: 'validation_error', detail: 'create_feature: harness_slug (string) required' };
      }
      if (typeof a.title !== 'string' || !a.title.trim()) {
        return { ok: false, actionId: '', error: 'validation_error', detail: 'create_feature: title (string) required' };
      }
      if (typeof a.reason !== 'string' || a.reason.trim().length < 10) {
        return { ok: false, actionId: '', error: 'validation_error', detail: 'create_feature: reason (≥10 chars) required' };
      }
      break;
    }

    case 'send_directive': {
      if (!Array.isArray(a.to) || a.to.length === 0 || !a.to.every((t: unknown) => typeof t === 'string' && t.trim())) {
        return { ok: false, actionId: '', error: 'validation_error', detail: 'send_directive: to (non-empty string[]) required' };
      }
      const hasSubject = typeof a.subject === 'string' && a.subject.trim().length > 0;
      const hasBody = typeof a.body === 'string' && a.body.trim().length > 0;
      if (!hasSubject && !hasBody) {
        return { ok: false, actionId: '', error: 'validation_error', detail: 'send_directive: subject or body required' };
      }
      break;
    }

    default:
      // Unknown op — will be caught by dispatchAction
      break;
  }

  return null;
}

export async function dispatchAction(
  callerSlug: string,
  action: ExecuteAction,
): Promise<ExecuteActionResult> {
  switch (action.op) {
    case 'create_feature': return doCreateFeature(callerSlug, action);
    case 'spinup_project': return doSpinupProject(callerSlug, action);
    case 'scaffold_harness': return doScaffoldHarness(callerSlug, action);
    case 'pause_project': return doPauseProject(callerSlug, action);
    case 'resume_project': return doResumeProject(callerSlug, action);
    case 'add_directive_summary': return doAddDirectiveSummary(callerSlug, action);
    case 'send_directive': return doSendDirective(callerSlug, action);
    default: return { ok: false, actionId: '', error: 'validation_error', detail: `unknown op: ${(action as any).op}` };
  }
}

/**
 * Top-level entry point for the route handler. Handles:
 *   - actionId validation
 *   - idempotency cache lookup
 *   - dispatch
 *   - cache write on success-or-validated-failure
 */
export async function executeAction(
  callerSlug: string,
  body: ExecuteActionRequest,
): Promise<ExecuteActionResult> {
  if (!body.actionId || typeof body.actionId !== 'string') {
    return { ok: false, actionId: body.actionId ?? '', error: 'validation_error', detail: 'actionId (UUID) required' };
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.actionId)) {
    return { ok: false, actionId: body.actionId, error: 'validation_error', detail: 'actionId must be a UUID' };
  }
  if (!body.action || typeof body.action !== 'object' || !body.action.op) {
    return { ok: false, actionId: body.actionId, error: 'validation_error', detail: 'action.op required' };
  }

  // Validate action shape before dispatch — ensures state remains clean
  // (validation happens before any side effects).
  const shapeError = validateActionShape(body.action);
  if (shapeError) {
    shapeError.actionId = body.actionId;
    return shapeError;
  }

  // Idempotency cache check.
  const cached = await getCachedAction(callerSlug, body.actionId);
  if (cached) {
    return { ...cached, actionId: body.actionId, cached: true };
  }

  const result = await dispatchAction(callerSlug, body.action);
  result.actionId = body.actionId;

  // Cache the result (both success and validated failure). Don't cache
  // 5xx internal errors — the operation may have partially succeeded;
  // safer to allow retry.
  const isInternalError = !result.ok && result.error === 'internal';
  if (!isInternalError) {
    await saveAction({
      callerSlug,
      actionId: body.actionId,
      op: body.action.op,
      targetSlug: extractTargetSlug(body.action),
      reason: (body.action as any).reason ?? null,
      request: body.action,
      response: result,
    });
  }
  return result;
}
