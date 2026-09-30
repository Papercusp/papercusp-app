/**
 * Feature routes:
 *
 *   GET    /api/harness/:slug/features/:id                   — read one feature + verification columns
 *   POST   /api/harness/:slug/features                       — create
 *   POST   /api/harness/:slug/features/import                — bulk-import
 *   PATCH  /api/harness/:slug/features/:id                   — update
 *   DELETE /api/harness/:slug/features/:id                   — delete
 *   POST   /api/harness/:slug/features/:id/reset             — reset to todo
 *   POST   /api/harness/:slug/features/:id/approve-human     — clear needs_human_review (+ optional project create/budget adjust)
 *
 * Relocated from `_hono/harness.ts` (endpoint-hono-elimination-2026-05-21
 * A4 batch 28). Helper `auditFeatureChange` lives in `lib/feature-audit.ts`
 * (carve-out from batch 26a).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getLegacyClient, getOrgPg, harnessQuery, harnessTransaction } from '@papercusp/db-org';
import { resolveProject, resolvePhasedProject, harnessDir, rowToFeature } from '../../../harness-core';
import { readEffectiveHarnessConfig } from '../../../harness-effective-config';
import { phasePhaseLabel } from '../../../harness-phases';
import { emitFeatureAuthored, emitFeatureQueued } from '../../../harness/usage-emitters';
import { activeWorkspaceId } from '../../../workspace-registry';
import { auditFeatureChange } from '../../../feature-audit';
import { firePluginLifecycle } from '../../../plugin-host-runtime';
import { syncFeatureBlockEdges } from '../../../dbos/feature-blockers-edges';
import { defaultBlockingStore } from '../../../work-item-blocking';
import { normalizeFeatureStateInput } from '../../../work-item-dispatch-states';
import {
  resolveBlockedByRefs,
  detectDependencyCycle,
  type FeatureWithRawDeps,
  type FeatureRef,
} from '../../../feature-deps';
import { defineTool } from '@papercusp/agent-mcp';
import { trackDetached } from '../../../detached-imports';
import { normalizeTakenBy } from '../../../sync/hyperbee/projections/harness-features';

// F-001, PROJ-sheets, DIR-D-001 — verbatim from legacy.
const FEATURE_ID_RE = /^[A-Z][A-Z0-9-]+(-[A-Z0-9-]+)?$/;

/**
 * Capture the holder of a feature before the legacy PATCH writer clears it.
 *
 * The post-write `getWorkItem` read is intentionally truthful (a terminal item
 * is unclaimed), so the settled-event fanout needs this pre-write value to
 * resolve the holder's fleet and fire `fleet:item-completed`.
 */
export function priorFeatureAssignee(
  existing: { taken_by?: string | null; assignee?: string | null },
): string | null {
  return normalizeTakenBy(existing.taken_by ?? existing.assignee ?? null);
}

/**
 * Pure provenance writer (R8-A testability split).
 *
 * For each feature, calls the injected `updater` and tallies success vs
 * failure. Returns counts + per-feature errors. Caller injects either a
 * real PG sql callback or null (when getOrgPg threw — in which case
 * `pgConnectError` is passed and we surface 'pg_unavailable' for every
 * row instead of trying to write).
 *
 * `updater` should return the number of rows actually updated. If it
 * returns 0, that means the consolidated row didn't exist yet (trigger
 * race or genuinely missing) — surfaced as 'consolidated_row_missing'.
 */
export interface ProvenanceFeature {
  id: string;
  source_plan_slug: string;
  source_plan_item_ids: string[];
  /** Promote wave this feature belongs to (promote-policy-and-waves; null = un-waved). */
  wave?: string | null;
  /** Phase-derived admission floor; undefined means leave the existing payload value unchanged. */
  needs_2_machine_rig?: boolean;
}
export interface ProvenanceWriteResult {
  written: number;
  errors: Array<{ feature_id: string; error: string }>;
}
export async function writeProvenance(
  features: ProvenanceFeature[],
  harnessSlug: string,
  updater: ((f: ProvenanceFeature, slug: string) => Promise<number>) | null,
  pgConnectError: string | null = null,
): Promise<ProvenanceWriteResult> {
  const errors: Array<{ feature_id: string; error: string }> = [];
  let written = 0;
  if (pgConnectError !== null) {
    for (const f of features) {
      errors.push({ feature_id: f.id, error: `pg_unavailable: ${pgConnectError}` });
    }
    return { written, errors };
  }
  if (!updater) return { written, errors };
  for (const f of features) {
    try {
      const rows = await updater(f, harnessSlug);
      if (rows > 0) {
        written++;
      } else {
        errors.push({ feature_id: f.id, error: 'consolidated_row_missing' });
        console.warn(
          `[features/import] provenance UPDATE matched 0 rows for ${f.id} in ${harnessSlug} — consolidated trigger may not have fired yet`,
        );
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push({ feature_id: f.id, error: msg });
      console.warn(`[features/import] provenance UPDATE failed for ${f.id} in ${harnessSlug}: ${msg}`);
    }
  }
  return { written, errors };
}

/** The org-PG tagged-template handle type (`getOrgPg().sql`). */
type OrgSql = ReturnType<typeof getOrgPg>['sql'];

/**
 * EI-124: write a feature's plan provenance (source_plan_slug / item_ids / wave)
 * to `harness_features_consolidated`, keyed by the PRIMARY KEY
 * `(harness_slug, feature_id)` — NOT by workspace_id.
 *
 * The PK has no workspace_id, so (slug, feature_id) is globally unique and the
 * slug alone unambiguously scopes the row (workspace_id is functionally derived
 * from the slug by the `fill_workspace_id_from_projects` trigger). The previous
 * `WHERE workspace_id = activeWorkspaceId()` filter was therefore redundant AND
 * a bug: inside the loopback `POST /features/import` the request carries no
 * workspace, so `activeWorkspaceId()` fell back to the host's global-current
 * workspace and the UPDATE matched 0 rows — silently dropping provenance and
 * making promoted features invisible to the wave engine.
 *
 * Returns the number of rows updated (0 ⇒ no such consolidated row). Exported so
 * the integration regression test exercises this exact statement.
 */
export async function updateFeatureProvenance(
  sql: OrgSql,
  f: ProvenanceFeature,
  slug: string,
): Promise<number> {
  const writesRigFlag = f.needs_2_machine_rig !== undefined;
  const r = await sql`
    UPDATE harness_shared.harness_features_consolidated
       SET source_plan_slug     = ${f.source_plan_slug}
         , source_plan_item_ids = ${f.source_plan_item_ids}
         , wave                  = ${f.wave ?? null}
         , payload               = CASE
             WHEN ${!writesRigFlag} THEN payload
             ELSE COALESCE(payload, '{}'::jsonb) ||
               jsonb_build_object('needs_2_machine_rig', ${Boolean(f.needs_2_machine_rig)})
           END
     WHERE harness_slug = ${slug}
       AND feature_id   = ${f.id}
    RETURNING feature_id
  `;
  return (r as unknown as unknown[]).length;
}

// ── GET /:slug/features/:id ─────────────────────────────────────────────

const getFeature = defineTool({
  method: 'GET',
  path: '/harness/:slug/features/:id',
  auth: 'public',
  async handler(_req, ctx) {
    const slug = ctx.params.slug as string;
    const id = ctx.params.id as string;
    const project = await resolveProject(slug);
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });

    const rows = await harnessQuery(project.slug, (sql) => sql`
      SELECT * FROM harness_features WHERE harness_slug = ${project.slug} AND feature_id = ${id}
    `);
    const row = rows[0] as any;
    if (!row) return Response.json({ error: 'feature not found' }, { status: 404 });

    // Dogfood-arc verification columns live in PG consolidated (not in SQLite).
    // Use a try/catch so the read still works on harnesses that have never run
    // the 080/082 migrations (e.g. older harnesses).
    type PgVerifRow = {
      completion_ref: unknown;
      verified_done_at_remote_ts: Date | null;
      verifier_last_error: string | null;
      verifier_last_checked_at: Date | null;
    };
    let pgVerif: PgVerifRow | null = null;
    try {
      const { sql } = getOrgPg();
      // EI-124: key by the PK (harness_slug, feature_id) — globally unique, so a
      // same-slug harness in another workspace can NOT collide on (slug, id). The
      // old activeWorkspaceId() filter was redundant and wrong on any path where
      // the request workspace isn't the harness's (e.g. a loopback call) — it
      // silently dropped the verification columns.
      const rows = await sql<PgVerifRow[]>`
        SELECT completion_ref,
               verified_done_at_remote_ts,
               verifier_last_error,
               verifier_last_checked_at
          FROM harness_shared.harness_features_consolidated
         WHERE harness_slug = ${project.slug}
           AND feature_id = ${id}
      `;
      pgVerif = rows[0] ?? null;
    } catch {
      // PG not available or migration not applied — return base feature only
    }

    return Response.json({
      feature: {
        ...rowToFeature(row),
        completion_ref: pgVerif?.completion_ref ?? null,
        verified_done_at_remote_ts: pgVerif?.verified_done_at_remote_ts
          ? pgVerif.verified_done_at_remote_ts instanceof Date
            ? pgVerif.verified_done_at_remote_ts.toISOString()
            : String(pgVerif.verified_done_at_remote_ts)
          : null,
        verifier_last_error: pgVerif?.verifier_last_error ?? null,
        verifier_last_checked_at: pgVerif?.verifier_last_checked_at
          ? pgVerif.verifier_last_checked_at instanceof Date
            ? pgVerif.verifier_last_checked_at.toISOString()
            : String(pgVerif.verifier_last_checked_at)
          : null,
      },
    });
  },
});

// ── POST /:slug/features/:id/reset ─────────────────────────────────────

const resetFeature = defineTool({
  method: 'POST',
  path: '/harness/:slug/features/:id/reset',
  auth: 'loopback',
  async handler(req, ctx) {
    const url = new URL(req.url);
    const project = await resolvePhasedProject(
      ctx.params.slug as string,
      phasePhaseLabel(url.searchParams.get('phase') ?? undefined),
    );
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const id = ctx.params.id as string;
    const existingRows = await harnessQuery(project.slug, (sql) => sql`
      SELECT * FROM harness_features WHERE harness_slug = ${project.slug} AND feature_id = ${id}
    `);
    const existing = existingRows[0] as any;
    if (!existing) return Response.json({ error: 'feature not found' }, { status: 404 });
    await harnessTransaction(project.slug, async (tx) => {
      // work-item-status-full-unify P-007: reset re-queues to the UNIFIED claimable token
      // 'open' (was 'todo') — this raw write bypasses setWorkItemState's alias-fold, so a
      // literal 'todo' here reintroduced the legacy spelling the backfill removed.
      await tx`
        UPDATE harness_features SET status = 'open', attempts = 0, updated_ts = ${Date.now()}
        WHERE harness_slug = ${project.slug} AND feature_id = ${id}
      `;
      auditFeatureChange(project.slug, id, 'status', existing.status, 'open', 'api:reset');
      auditFeatureChange(project.slug, id, 'attempts', existing.attempts, 0, 'api:reset');
    });
    const featRows = await harnessQuery(project.slug, (sql) => sql`
      SELECT * FROM harness_features WHERE harness_slug = ${project.slug} AND feature_id = ${id}
    `);
    const feat = rowToFeature(featRows[0]);
    // P-070: feature re-queued for workers (reset → todo).
    void emitFeatureQueued(project.slug, id, { fromStatus: existing.status });

    // If worktree isolation is active and this feature has a stale worktree,
    // remove it so the next worker starts from a clean baseBranch.
    const hd = harnessDir(project);
    const wtPath = join(hd, 'worktrees', id);
    let worktreeRemoved = false;
    try {
      const cfg = await readEffectiveHarnessConfig(project.slug, activeWorkspaceId(), project.path);
      const bi = cfg?.branchIsolation as Record<string, unknown> | undefined;
      const useWorktrees = bi?.useWorktrees === true && bi?.enabled === true;
      if (useWorktrees && existsSync(wtPath)) {
        const { spawnSync } = await import('node:child_process');
        spawnSync('git', ['worktree', 'remove', '--force', wtPath], { cwd: project.path });
        spawnSync('git', ['branch', '-D', `harness/${id}`], { cwd: project.path });
        worktreeRemoved = true;
      }
    } catch {}

    return Response.json({ ok: true, feature: feat, worktreeRemoved });
  },
});

// ── PATCH /:slug/features/:id ──────────────────────────────────────────

const updateFeature = defineTool({
  method: 'PATCH',
  path: '/harness/:slug/features/:id',
  auth: 'loopback',
  async handler(req, ctx) {
    const url = new URL(req.url);
    const project = await resolvePhasedProject(
      ctx.params.slug as string,
      phasePhaseLabel(url.searchParams.get('phase') ?? undefined),
    );
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const id = ctx.params.id as string;
    const body = (await req.json()) as {
      title?: string;
      summary?: string;
      claims?: string[];
      status?: string;
      attempts?: number;
      project_id?: string;
      expected_cost_cents?: number;
      tags?: string[];
      needs_human_review?: boolean;
      metadata?: any;
      notes?: string;
      deprecation_reason?: string;
    };
    const actor = req.headers.get('x-actor') ?? 'api';

    const existingRows = await harnessQuery(project.slug, (sql) => sql`
      SELECT * FROM harness_features WHERE harness_slug = ${project.slug} AND feature_id = ${id}
    `);
    const existing = existingRows[0] as any;
    if (!existing) return Response.json({ error: 'feature not found' }, { status: 404 });

    const updates: Record<string, any> = {};
    if (body.status !== undefined) {
      if (typeof body.status !== 'string' || !body.status) return Response.json({ error: 'invalid status' }, { status: 400 });
      // WI-195 C2: reject an arbitrary/typo feature status at the HTTP edge + fold
      // aliases (the engine setWorkItemState path already guards; this endpoint
      // bypassed it, so a raw PATCH status:'banana' persisted un-rejected).
      const norm = normalizeFeatureStateInput(body.status);
      if (!norm.ok) {
        return Response.json({ error: `invalid status '${body.status}' — valid: ${norm.valid.join(', ')}` }, { status: 400 });
      }
      updates.status = norm.state;
    }
    if (body.title !== undefined) {
      if (typeof body.title !== 'string' || body.title.trim() === '') return Response.json({ error: 'title must be a non-empty string' }, { status: 400 });
      updates.title = body.title.trim();
    }
    if (body.claims !== undefined) {
      if (!Array.isArray(body.claims) || body.claims.some((v) => typeof v !== 'string')) return Response.json({ error: 'claims must be string[]' }, { status: 400 });
      updates.claims = JSON.stringify(body.claims.map((s) => s.trim()).filter(Boolean));
    }
    if (body.attempts !== undefined) {
      if (typeof body.attempts !== 'number' || body.attempts < 0 || !Number.isInteger(body.attempts)) return Response.json({ error: 'attempts must be a non-negative integer' }, { status: 400 });
      updates.attempts = body.attempts;
    }
    if (body.project_id !== undefined) updates.project_id = body.project_id || null;
    if (body.expected_cost_cents !== undefined) updates.expected_cost_cents = body.expected_cost_cents;
    if (body.tags !== undefined) updates.tags = body.tags == null ? null : JSON.stringify(body.tags);
    if (body.needs_human_review !== undefined) updates.needs_human_review = !!body.needs_human_review;
    if (body.metadata !== undefined) updates.metadata = body.metadata == null ? null : JSON.stringify(body.metadata);
    if (body.summary !== undefined) {
      if (body.summary !== null && typeof body.summary !== 'string') return Response.json({ error: 'summary must be a string or null' }, { status: 400 });
      updates.summary = body.summary;
    }
    if (body.notes !== undefined) {
      if (body.notes !== null && typeof body.notes !== 'string') return Response.json({ error: 'notes must be a string or null' }, { status: 400 });
      updates.notes = body.notes;
    }
    if (body.deprecation_reason !== undefined) {
      if (body.deprecation_reason !== null && typeof body.deprecation_reason !== 'string') return Response.json({ error: 'deprecation_reason must be a string or null' }, { status: 400 });
      updates.deprecation_reason = body.deprecation_reason;
    }
    // work-item-status-full-unify P-007: `updates.status` is the NORMALIZED value, and
    // normalizeFeatureStateInput now folds the legacy `deprecated` spelling onto the unified
    // drop terminal `dropped` (P-003 writer-flip). Key these guards on `dropped` — checking
    // `=== 'deprecated'` here silently stopped firing after the flip, so the required-reason
    // gate went dead AND the off-deprecate clear wiped the reason WHILE dropping.
    if (updates.status === 'dropped' && updates.deprecation_reason === undefined && !existing.deprecation_reason) {
      return Response.json({ error: 'deprecation_reason required when transitioning to status=dropped (deprecate)' }, { status: 400 });
    }
    if (updates.status !== undefined && updates.status !== 'dropped' && existing.deprecation_reason && updates.deprecation_reason === undefined) {
      updates.deprecation_reason = null;
    }

    if (Object.keys(updates).length === 0) return Response.json({ ok: true, feature: rowToFeature(existing), changes: 0 });

    await harnessTransaction(project.slug, async (tx) => {
      // Dynamic SET clause: `updates` keys are drawn from the fixed whitelist of
      // body fields validated above (never arbitrary/user-controlled key names),
      // so interpolating them as bare identifiers is safe. Values stay parameterized.
      const keys = Object.keys(updates);
      const values = keys.map((k) => updates[k]);
      const setClauses = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
      const n = values.length;
      await tx.unsafe(
        `UPDATE harness_features SET ${setClauses}, updated_ts = $${n + 1} WHERE harness_slug = $${n + 2} AND feature_id = $${n + 3}`,
        [...values, Date.now(), project.slug, id],
      );
      for (const [field, newVal] of Object.entries(updates)) {
        const oldVal = existing[field];
        auditFeatureChange(project.slug, id, field, oldVal, newVal, actor);
      }
    });

    // (The projects→spec-revision project_manager hook that enqueued a `pm_due`
    // pending_events row on a transition into 'passed' was retired with the PM
    // feature — D-020 / P-015.)
    // work-item-status-full-unify P-007: the success terminal is the unified `done`
    // (feature `passed`→`done`, nuance preserved in work_items.terminal_reason). Detect a
    // transition INTO the success terminal tolerantly across both spellings — keying on the
    // legacy `passed` alone went dead after P-003 folded `passed`→`done` at the write edge.
    const isSuccessTerminal = (s: string | null | undefined) => s === 'done' || s === 'passed';
    const transitionedToPassed = isSuccessTerminal(updates.status) && !isSuccessTerminal(existing.status);

    if (transitionedToPassed) {
      // `onFeaturePassed` is a FROZEN typed fire-point (plugin-system-hive-port
      // D-003) — kept for back-compat, never extended.
      void firePluginLifecycle('onFeaturePassed', {
        installSlug: project.slug,
        projectDir: project.path,
        stateDir: harnessDir(project),
      }, id);
      // P-007: the plugin-visible transition is re-homed onto the unified
      // work-items emissions (`work-item:done:<id>` + unblock fan-out) — the
      // SAME events the modern work_items:set_state path fires — replacing the
      // retired HookBus `task.passed` / `feature.completed` topics. The
      // per-schema harness_features write lands in the consolidated table, so
      // the unified read sees the settled row.
      void trackDetached(import('../../../work-items'))
        .then(async (wiMod) => {
          const wi = await wiMod.getWorkItem(id, project.slug);
          if (!wi) return;
          const m = await import('../../../work-items-events');
          // Force the unified success terminal `done` (was the legacy `passed`) so the settled
          // events fire even if the consolidated read hasn't projected the write yet — `done` is
          // in SETTLED_STATES.feature (frontier-readiness.TERMINAL_STATUSES).
          // `priorFeatureAssignee` exists for exactly this call: the post-write
          // `getWorkItem` above is truthfully unclaimed, so the settled-event
          // fanout needs the PRE-write holder to resolve its fleet and fire
          // `fleet:item-completed`. `existing` is the pre-update row.
          await m.emitWorkItemSettledEvents(
            { ...wi, state: 'done' },
            { priorAssignee: priorFeatureAssignee(existing) },
          );
        })
        .catch(() => {});
    }

    const updatedRows = await harnessQuery(project.slug, (sql) => sql`
      SELECT * FROM harness_features WHERE harness_slug = ${project.slug} AND feature_id = ${id}
    `);
    return Response.json({ ok: true, feature: rowToFeature(updatedRows[0]) });
  },
});

// ── POST /:slug/features/import — bulk import (scoper) ────────────────

const importFeatures = defineTool({
  method: 'POST',
  path: '/harness/:slug/features/import',
  auth: 'loopback',
  async handler(req, ctx) {
    const url = new URL(req.url);
    const project = await resolvePhasedProject(
      ctx.params.slug as string,
      phasePhaseLabel(url.searchParams.get('phase') ?? undefined),
    );
    if (!project) {
      // Diagnostic: resolveProject already scans all workspaces, so a miss means
      // the slug is registered NOWHERE (a typo, or an e2e/smoketest harness
      // promoted before it was registered). Echo the slug — plans:promote
      // re-wraps this as features_import_failed:404, so this is what the caller
      // sees; "unknown project" alone was undiagnosable.
      return Response.json(
        { error: `unknown project '${ctx.params.slug as string}' — not registered in any workspace` },
        { status: 404 },
      );
    }
    const body = (await req.json().catch(() => null)) as null | {
      features?: Array<{
        id?: string;
        title: string;
        summary?: string;
        status?: string;
        attempts?: number;
        claims?: string[] | null;
        notes?: string | null;
        metadata?: Record<string, unknown> | null;
        kind?: string | null;
        project_id?: string | null;
        expected_cost_cents?: number | null;
        tags?: string[] | null;
        needs_human_review?: boolean;
        ts?: number | null;
        source_plan_slug?: string | null;
        source_plan_item_ids?: string[] | null;
        wave?: string | null;
        needs_2_machine_rig?: boolean | null;
        /** First-class deps (P-046): refs (feature ids OR titles) that must
         *  finish before this feature; resolved → canonical ids at import. */
        blocked_by?: string[] | null;
        /** Within-wave ordering hint (the YAML `order`). */
        order?: number | null;
      }>;
    };
    if (!body?.features || !Array.isArray(body.features) || body.features.length === 0) {
      return Response.json({ error: 'features array required' }, { status: 400 });
    }
    const allocatedIds: string[] = [];
    const features = body.features.map((raw) => {
      if (raw.id && raw.id.length > 0) {
        allocatedIds.push(raw.id);
        return raw as typeof raw & { id: string };
      }
      const ts = Date.now().toString(36).toUpperCase();
      const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
      const id = `F-AUTO-${ts}${rand}`;
      allocatedIds.push(id);
      return { ...raw, id };
    });
    const invalid = features.find((f) => !FEATURE_ID_RE.test(f.id) || !f.title);
    if (invalid) {
      return Response.json({
        error: `every feature requires a valid id (matching ${FEATURE_ID_RE.source}) and title; offender: ${JSON.stringify(invalid).slice(0, 200)}`,
      }, { status: 400 });
    }

    // P-046: resolve blocked_by refs (ids/titles) → canonical ids and reject
    // dependency cycles BEFORE any write. Refs may point at batch features or
    // existing ones; an unresolvable/ambiguous ref or a cycle (a silent
    // permanent frontier deadlock) fails the WHOLE import loudly.
    // EI-124: every consolidated read/write below keys by the PRIMARY KEY
    // (harness_slug, feature_id) — globally unique — NOT by activeWorkspaceId().
    // workspace_id is functionally determined by the slug (the
    // fill_workspace_id_from_projects BEFORE-INSERT trigger), so the slug alone
    // unambiguously scopes the row. activeWorkspaceId() is resolved from the
    // request and is WRONG inside the loopback POST /features/import call (it
    // falls back to the host's global-current workspace when the loopback carries
    // no workspace header), which silently matched 0 rows and zeroed feature
    // provenance (source_plan_slug/wave) → promoted features invisible to the
    // wave engine. The admin handle (getOrgPg) bypasses RLS, and the PK can never
    // collide across workspaces, so dropping the workspace predicate is safe.
    const resolvedBlockedBy = new Map<string, string[]>();
    const featureOrder = new Map<string, number>();
    for (const f of features) {
      if (typeof f.order === 'number') featureOrder.set(f.id, f.order);
    }
    if (features.some((f) => (f.blocked_by?.length ?? 0) > 0)) {
      let existing: Array<{ id: string; title: string; blocked_by: string[] }>;
      try {
        const { sql } = getOrgPg();
        const rows = await sql<Array<{ feature_id: string; title: string }>>`
          SELECT feature_id, title
            FROM harness_shared.harness_features_consolidated
           WHERE harness_slug = ${project.slug}
        `;
        // EI-1 (D-027): existing blocker sets come from the coord_links rel='blocks'
        // edges (the legacy blocked_by column is dropped), keyed blocked → blockers.
        const blockers = await defaultBlockingStore.blockersFor(project.slug);
        existing = rows.map((r) => ({
          id: r.feature_id,
          title: r.title,
          blocked_by: (blockers.get(r.feature_id) ?? []).map((blocker) => blocker.id),
        }));
      } catch (e) {
        // Deps are correctness-critical — don't silently skip validation.
        return Response.json(
          { error: `blocked_by resolution failed (cannot read existing features): ${e instanceof Error ? e.message : String(e)}` },
          { status: 500 },
        );
      }
      const inBatch = new Set(features.map((f) => f.id));
      const batchDeps: FeatureWithRawDeps[] = features.map((f) => ({
        id: f.id,
        title: f.title,
        blockedByRefs: f.blocked_by ?? [],
      }));
      const existingRefs: FeatureRef[] = existing
        .filter((e) => !inBatch.has(e.id))
        .map((e) => ({ id: e.id, title: e.title }));
      const { resolved, errors } = resolveBlockedByRefs(batchDeps, existingRefs);
      if (errors.length > 0) {
        return Response.json({ error: `blocked_by resolution failed: ${errors.join('; ')}` }, { status: 400 });
      }
      for (const [id, blockers] of resolved) resolvedBlockedBy.set(id, blockers);
      // Cycle-detect over the union of batch (resolved) + existing edges.
      const edges = new Map<string, string[]>();
      for (const e of existing) if (!inBatch.has(e.id)) edges.set(e.id, e.blocked_by ?? []);
      for (const [id, blockers] of resolved) edges.set(id, blockers);
      const cyc = detectDependencyCycle(edges);
      if (cyc.hasCycle) {
        return Response.json(
          { error: `blocked_by introduces a dependency cycle among: ${cyc.cycleNodes.join(', ')}` },
          { status: 400 },
        );
      }
    }

    const now = Date.now();
    let inserted = 0;
    let updated = 0;
    let skippedKindMismatch = 0;
    await harnessTransaction(project.slug, async (tx) => {
      for (const f of features) {
        const existingRows = await tx`
          SELECT kind FROM harness_features WHERE harness_slug = ${project.slug} AND feature_id = ${f.id}
        `;
        const existing = existingRows[0] as { kind: string | null } | undefined;
        if (existing) {
          const existingKind = existing.kind ?? 'product';
          const incomingKind = f.kind ?? 'product';
          if (existingKind !== 'product' && existingKind !== incomingKind) {
            skippedKindMismatch++;
            continue;
          }
          await tx`
            UPDATE harness_features SET
              title = ${f.title},
              summary = ${f.summary ?? null},
              status = ${f.status ?? 'open'},
              updated_ts = ${now}
            WHERE harness_slug = ${project.slug} AND feature_id = ${f.id}
          `;
          updated++;
        } else {
          await tx`
            INSERT INTO harness_features
              (harness_slug, feature_id, title, summary, status, attempts, claims, notes, metadata,
               kind, project_id, expected_cost_cents, tags, needs_human_review,
               ts, created_ts, updated_ts)
            VALUES (${project.slug}, ${f.id}, ${f.title}, ${f.summary ?? null}, ${f.status ?? 'open'},
              ${f.attempts ?? 0},
              ${f.claims && f.claims.length > 0 ? JSON.stringify(f.claims) : null},
              ${f.notes ?? null},
              ${(f.metadata ? JSON.stringify(f.metadata) : null)}::text::jsonb,
              ${f.kind ?? null},
              ${f.project_id ?? null},
              ${f.expected_cost_cents ?? null},
              ${(f.tags && f.tags.length > 0 ? JSON.stringify(f.tags) : null)}::text::jsonb,
              ${Boolean(f.needs_human_review)},
              ${f.ts ?? now}, ${now}, ${now})
          `;
          inserted++;
        }
      }
    });

    // Write plan provenance to PG consolidated — best-effort (migration 084).
    // Logic extracted into pure helper for testability (R8-A).
    const withProvenance = features.filter((f) => f.source_plan_slug);
    let pgConnectError: string | null = null;
    let updater: ((f: ProvenanceFeature, slug: string) => Promise<number>) | null = null;
    if (withProvenance.length > 0) {
      try {
        const { sql } = getOrgPg();
        // EI-124: keyed by the PK (harness_slug, feature_id) — see updateFeatureProvenance.
        updater = (f, slug) => updateFeatureProvenance(sql, f, slug);
      } catch (e) {
        pgConnectError = e instanceof Error ? e.message : String(e);
        console.warn(`[features/import] PG provenance update skipped: ${pgConnectError}`);
      }
    }
    const provenanceResult = await writeProvenance(
      withProvenance.map((f) => ({
        id: f.id,
        source_plan_slug: f.source_plan_slug!,
        source_plan_item_ids: f.source_plan_item_ids ?? [],
        wave: f.wave ?? null,
        ...(f.needs_2_machine_rig != null && { needs_2_machine_rig: f.needs_2_machine_rig }),
      })),
      project.slug,
      updater,
      pgConnectError,
    );
    const provenanceWritten = provenanceResult.written;
    const provenanceErrors = provenanceResult.errors;

    // P-046 / EI-1 (D-027): write resolved deps. `feature_order` stays a typed
    // column on consolidated (the SELECT*-frozen per-harness view doesn't surface
    // it; the frontier reads it from consolidated). Blocking is NO LONGER a column
    // — it's the coord_links rel='blocks' edge (the legacy blocked_by column is
    // dropped, migration 155) — so blockers are written via syncFeatureBlockEdges,
    // the same edge the dispatch frontier (getFeatureBlockers) reads.
    const depWrites = features.filter(
      (f) => (resolvedBlockedBy.get(f.id)?.length ?? 0) > 0 || featureOrder.has(f.id),
    );
    let depsWritten = 0;
    if (depWrites.length > 0) {
      try {
        const { sql } = getOrgPg();
        for (const f of depWrites) {
          const bb = resolvedBlockedBy.get(f.id) ?? [];
          const ord = featureOrder.has(f.id) ? featureOrder.get(f.id)! : null;
          const r = await sql`
            UPDATE harness_shared.harness_features_consolidated
               SET feature_order = ${ord}
             WHERE harness_slug = ${project.slug}
               AND feature_id   = ${f.id}
            RETURNING feature_id
          `;
          // Sync this feature's blocker edges to the resolved set (idempotent;
          // an empty set clears any stale edges).
          await syncFeatureBlockEdges(project.slug, f.id, bb);
          if ((r as unknown as unknown[]).length > 0) depsWritten++;
        }
      } catch (e) {
        console.warn(`[features/import] blocked_by/order write skipped: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    return Response.json({
      ok: true,
      inserted,
      updated,
      total: features.length,
      skippedKindMismatch,
      ids: allocatedIds,
      ...(depWrites.length > 0 && { depsWritten }),
      ...(withProvenance.length > 0 && {
        provenanceWritten,
        provenanceFailed: provenanceErrors.length,
        ...(provenanceErrors.length > 0 && { provenanceErrors }),
      }),
    });
  },
});

// ── POST /:slug/features — create one ──────────────────────────────────

const createFeature = defineTool({
  method: 'POST',
  path: '/harness/:slug/features',
  auth: 'loopback',
  async handler(req, ctx) {
    const url = new URL(req.url);
    const project = await resolvePhasedProject(
      ctx.params.slug as string,
      phasePhaseLabel(url.searchParams.get('phase') ?? undefined),
    );
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const body = (await req.json()) as {
      id?: string;
      title?: string;
      claims?: string[];
      status?: string;
      summary?: string;
      kind?: string;
      project_id?: string;
      expected_cost_cents?: number;
      tags?: string[];
      needs_human_review?: boolean;
      metadata?: any;
    };
    const actor = req.headers.get('x-actor') ?? 'api';

    const id = (body.id ?? '').trim();
    const title = (body.title ?? '').trim();
    if (!FEATURE_ID_RE.test(id)) {
      return Response.json({ error: `id must match ${FEATURE_ID_RE.source}` }, { status: 400 });
    }
    if (!title) return Response.json({ error: 'title required' }, { status: 400 });

    const existsRows = await harnessQuery(project.slug, (sql) => sql`
      SELECT 1 AS x FROM harness_features WHERE harness_slug = ${project.slug} AND feature_id = ${id}
    `);
    if (existsRows.length > 0) return Response.json({ error: `id already exists: ${id}` }, { status: 409 });

    // Budget enforcement at proposal-add time: if project_id + budget +
    // expected_cost_cents would push committed-spend over budget → reject.
    if (body.project_id && typeof body.expected_cost_cents === 'number' && body.expected_cost_cents > 0) {
      // Narrowed to a local const: TS control-flow narrowing on `body.project_id`
      // from the truthy check above does not persist into the harnessQuery
      // callback (a nested function expression, which TS treats conservatively
      // for property-access narrowing), so the bare property access still
      // types as `string | undefined` inside sql`` below without this.
      const projectId = body.project_id;
      const expectedCostCents = body.expected_cost_cents;
      const projectRows = await harnessQuery(project.slug, (sql) => sql`
        SELECT id, name, budget_cents FROM projects WHERE id = ${projectId}
      `);
      const project_row = projectRows[0] as any;
      if (project_row && project_row.budget_cents !== null) {
        // Cross-harness admin read (all_features has no single harness scope) — stays
        // on the no-slug admin client (getOrgPg()); harnessQuery/withHarnessSchema
        // are inherently per-harness-schema-scoped and have no equivalent for
        // this shape. Decision + why: WI-5384, mirroring D-005's per-harness
        // getHarnessPg rationale.
        const adminC = getLegacyClient();
        const committed = Number(((await adminC.prepare(`
          SELECT COALESCE(SUM(expected_cost_cents), 0) as total
          FROM all_features
          WHERE project_id = ? AND status NOT IN ('cancelled', 'launched', 'passed')
        `).get(body.project_id)) as any).total ?? 0);
        const proposed_total = committed + body.expected_cost_cents;
        if (proposed_total > Number(project_row.budget_cents)) {
          const now = Date.now();
          const rejectSummary = body.summary ?? `Auto-rejected: would push ${project_row.name} over budget. Committed: ${committed}, proposed cost: ${body.expected_cost_cents}, budget: ${project_row.budget_cents}`;
          const rejectNotes = `Budget exceeded: requested ${body.expected_cost_cents} cents on top of ${committed} already committed (cap ${project_row.budget_cents}).`;
          await harnessQuery(project.slug, (sql) => sql`
            INSERT INTO harness_features
              (harness_slug, feature_id, title, summary, status, attempts, claims, notes, metadata, kind,
               project_id, expected_cost_cents, tags, needs_human_review, ts, created_ts, updated_ts)
            VALUES (${project.slug}, ${id}, ${title}, ${rejectSummary}, 'out_of_budget', 0, NULL,
              ${rejectNotes}, NULL, ${body.kind ?? null}, ${projectId}, ${expectedCostCents},
              NULL, false, ${now}, ${now}, ${now})
          `);
          auditFeatureChange(project.slug, id, '__rejected_budget', null, { project: project_row.id, budget: Number(project_row.budget_cents), committed, proposed: body.expected_cost_cents }, actor);
          return Response.json({
            ok: false,
            error: 'out_of_budget',
            rejected: true,
            project_id: project_row.id,
            project_name: project_row.name,
            project_budget_cents: Number(project_row.budget_cents),
            already_committed_cents: committed,
            proposed_cost_cents: body.expected_cost_cents,
            would_total_cents: proposed_total,
          }, { status: 409 });
        }
      }
    }

    // WI-195 C2: validate/normalize the caller-supplied feature status (typo guard,
    // mirroring the engine + PATCH path). The out_of_budget branch above returns
    // before this, so its internal status write is unaffected.
    const statusNorm = normalizeFeatureStateInput(body.status || 'open');
    if (!statusNorm.ok) {
      return Response.json({ error: `invalid status '${body.status}' — valid: ${statusNorm.valid.join(', ')}` }, { status: 400 });
    }
    const status = statusNorm.state;
    const claims = Array.isArray(body.claims) ? body.claims.map((s) => String(s).trim()).filter(Boolean) : [];
    const now = Date.now();

    await harnessTransaction(project.slug, async (tx) => {
      await tx`
        INSERT INTO harness_features
          (harness_slug, feature_id, title, summary, status, attempts, claims, notes, metadata, kind,
           project_id, expected_cost_cents, tags, needs_human_review, ts, created_ts, updated_ts)
        VALUES (${project.slug}, ${id}, ${title}, ${body.summary ?? null}, ${status}, 0,
          ${claims.length ? JSON.stringify(claims) : null},
          NULL,
          ${(body.metadata == null ? null : JSON.stringify(body.metadata))}::text::jsonb,
          ${body.kind ?? null},
          ${body.project_id ?? null},
          ${typeof body.expected_cost_cents === 'number' ? body.expected_cost_cents : null},
          ${(Array.isArray(body.tags) ? JSON.stringify(body.tags) : null)}::text::jsonb,
          ${!!body.needs_human_review},
          ${now}, ${now}, ${now})
      `;
      auditFeatureChange(project.slug, id, '__created', null, { id, title, status }, actor);
    });

    const createdRows = await harnessQuery(project.slug, (sql) => sql`
      SELECT * FROM harness_features WHERE harness_slug = ${project.slug} AND feature_id = ${id}
    `);
    const created = rowToFeature(createdRows[0]);
    // P-070 usage ledger (best-effort, never throws): the human authored a
    // feature, and if it lands claimable (`open`) it's immediately queued for workers.
    // work-item-status-full-unify P-007: `status` is the NORMALIZED value — normalize folds
    // the legacy `todo` onto the unified claimable token `open`, so the guard MUST be `open`
    // (`=== 'todo'` went dead after P-003 and stopped emitting the queued event on create).
    void emitFeatureAuthored(project.slug, id, { title });
    if (status === 'open') void emitFeatureQueued(project.slug, id, {});
    return Response.json({ ok: true, feature: created });
  },
});

// ── DELETE /:slug/features/:id ─────────────────────────────────────────

const deleteFeature = defineTool({
  method: 'DELETE',
  path: '/harness/:slug/features/:id',
  auth: 'loopback',
  async handler(req, ctx) {
    const url = new URL(req.url);
    const project = await resolvePhasedProject(
      ctx.params.slug as string,
      phasePhaseLabel(url.searchParams.get('phase') ?? undefined),
    );
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const id = ctx.params.id as string;
    const actor = req.headers.get('x-actor') ?? 'api';
    const existingRows = await harnessQuery(project.slug, (sql) => sql`
      SELECT * FROM harness_features WHERE harness_slug = ${project.slug} AND feature_id = ${id}
    `);
    const existing = existingRows[0] as any;
    if (!existing) return Response.json({ error: 'feature not found' }, { status: 404 });
    await harnessTransaction(project.slug, async (tx) => {
      await tx`DELETE FROM harness_features WHERE harness_slug = ${project.slug} AND feature_id = ${id}`;
      auditFeatureChange(project.slug, id, '__deleted', rowToFeature(existing), null, actor);
    });
    return Response.json({ ok: true, deleted: id });
  },
});

// ── POST /:slug/features/:id/approve-human ─────────────────────────────

const approveHumanReview = defineTool({
  method: 'POST',
  path: '/harness/:slug/features/:id/approve-human',
  auth: 'loopback',
  async handler(req, ctx) {
    const project = await resolveProject(ctx.params.slug as string);
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const id = ctx.params.id as string;
    const body = (await req.json().catch(() => ({}))) as {
      adjust_budget_cents?: number;
      create_project?: boolean;
      project_id?: string;
    };
    const actor = req.headers.get('x-actor') ?? 'human';

    const existingRows = await harnessQuery(project.slug, (sql) => sql`
      SELECT * FROM harness_features WHERE harness_slug = ${project.slug} AND feature_id = ${id}
    `);
    const existing = existingRows[0] as any;
    if (!existing) return Response.json({ error: 'feature not found' }, { status: 404 });
    if (!existing.needs_human_review) return Response.json({ error: 'feature does not need human review' }, { status: 400 });

    await harnessTransaction(project.slug, async (tx) => {
      let createdProject: any = null;
      if (body.create_project) {
        const projectId = body.project_id ?? `PROJ-${id.replace(/^[A-Z]+-/, '').toLowerCase()}`;
        const now = Date.now();
        await tx`
          INSERT INTO projects (id, name, status, budget_cents, created_ts, updated_ts)
          VALUES (${projectId}, ${existing.title}, 'in_progress',
            ${typeof body.adjust_budget_cents === 'number' ? body.adjust_budget_cents : null}, ${now}, ${now})
        `;
        createdProject = { id: projectId, budget_cents: body.adjust_budget_cents ?? null };
        auditFeatureChange(project.slug, id, '__project_created', null, createdProject, actor);
        await tx`
          UPDATE harness_features SET project_id = ${projectId}, updated_ts = ${now}
          WHERE harness_slug = ${project.slug} AND feature_id = ${id}
        `;
        auditFeatureChange(project.slug, id, 'project_id', existing.project_id, projectId, actor);
      } else if (typeof body.adjust_budget_cents === 'number' && existing.project_id) {
        const oldProjRows = await tx`SELECT budget_cents FROM projects WHERE id = ${existing.project_id}`;
        const oldProj = oldProjRows[0] as any;
        await tx`UPDATE projects SET budget_cents = ${body.adjust_budget_cents}, updated_ts = ${Date.now()} WHERE id = ${existing.project_id}`;
        auditFeatureChange(
          project.slug, id, '__project_budget_adjusted',
          oldProj?.budget_cents == null ? null : Number(oldProj.budget_cents),
          body.adjust_budget_cents, actor,
        );
      }

      await tx`
        UPDATE harness_features SET needs_human_review = false, updated_ts = ${Date.now()}
        WHERE harness_slug = ${project.slug} AND feature_id = ${id}
      `;
      auditFeatureChange(project.slug, id, 'needs_human_review', true, false, actor);
    });

    const updatedRows = await harnessQuery(project.slug, (sql) => sql`
      SELECT * FROM harness_features WHERE harness_slug = ${project.slug} AND feature_id = ${id}
    `);
    const updated = rowToFeature(updatedRows[0]);
    return Response.json({ ok: true, feature: updated, approvedBy: actor });
  },
});

// ── GET /:slug/features/:id/plan-context ────────────────────────────────
// Called by the TS orchestrator (invoke.ts step 8.8) to get the plan
// context section for a feature that was promoted from a plan. Returns
// { section, planSlug, truncated } or 404 when the feature has no plan
// origin. The orchestrator fetches this over HTTP using PAPERCUSP_OPERATOR_BASE
// so the submodule stays clean of operator-layer PG imports.

const getPlanContext = defineTool({
  method: 'GET',
  path: '/harness/:slug/features/:id/plan-context',
  auth: 'public',
  async handler(_req, ctx) {
    const { slug, id } = ctx.params as { slug: string; id: string };
    const project = await resolveProject(slug);
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const { getPlanContextForFeature } = await import('../../../plan-context-for-feature');
    const result = await getPlanContextForFeature(project.slug, id);
    if (!result) return Response.json({ error: 'no plan origin' }, { status: 404 });
    return Response.json(result);
  },
});

export default [
  getPlanContext,
  getFeature,
  resetFeature,
  updateFeature,
  importFeatures,
  createFeature,
  deleteFeature,
  approveHumanReview,
];
