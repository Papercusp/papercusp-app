/**
 * Postgres-backed feature state — Phase 1 of the orchestrator → PG arc.
 *
 * Schema layout (matches what the operator already reads/writes):
 *
 *   harness_<slug>.harness_features (workspace_id, feature_id, title, status,
 *     attempts, claims, notes, metadata, ...)
 *
 * Each harness gets its own schema; the orchestrator's pg client is
 * expected to be configured with `search_path=harness_<slug>` (the
 * operator's `dbcFor(slug)` pattern). When that's not feasible, callers
 * can pass a fully-qualified writer that does the search_path SET LOCAL
 * inside a tx — this module only references the unqualified table name.
 *
 * All mutations are workspace-scoped via the `workspace_id` column +
 * an explicit predicate on every UPDATE/SELECT so cross-workspace
 * leakage is impossible even if RLS is misconfigured.
 */
import type { OrchestratorPg } from './invoke';
import type { FeatureRecord } from './types';

export interface PgStateContext {
  pg: OrchestratorPg;
  workspaceId: string;
  /** Optional harness slug — when set, used by setFeatureStatusPg for
   *  the design-phase gate (PAPERCUSP_DESIGN_GATE=1). When unset, gate
   *  is skipped silently (preserves the no-op behavior of pre-gate
   *  callers). */
  harnessSlug?: string;
}

interface FeatureRow {
  feature_id: string;
  title: string | null;
  summary: string | null;
  status: string;
  attempts: number | bigint | null;
  claims: string | string[] | null;
  notes: string | null;
  metadata: Record<string, unknown> | null;
  kind: string | null;
  project_id: string | null;
  expected_cost_cents: number | bigint | null;
  tags: string[] | null;
  needs_human_review: boolean | null;
  ts: number | bigint | null;
  created_ts: number | bigint | null;
  updated_ts: number | bigint | null;
}

function toNum(v: number | bigint | null | undefined): number {
  if (v === null || v === undefined) return 0;
  return typeof v === 'bigint' ? Number(v) : v;
}

// ─── G2 Auditor-admission pick-gate (P-008) ─────────────────────────────────
//
// A feature is auto-pickable by the orchestrator iff it was written by the
// current user's own device ('local') OR the auditor has explicitly admitted it.
// Remote features with a NULL / 'pending' / 'reject' verdict are excluded.
//
// D-006: the 'local' bypass keys on origin (derived from op.writerPubkey —
// the Noise key that signed the op, cryptographically unforgeable), NOT on
// created_by_github_user_id (payload-level, forgeable).
//
// Exported so it can be unit-tested independently of the PG client.
export function isAutoPickable({
  origin,
  audit_verdict,
}: {
  origin?: string | null;
  audit_verdict?: string | null;
}): boolean {
  // Local features always bypass the auditor — no verdict needed.
  if (origin === 'local' || origin == null) return true;
  // Remote features are pickable only when the auditor has admitted them.
  return audit_verdict === 'admit';
}

function rowToFeature(r: FeatureRow): FeatureRecord {
  let claims: string[] | undefined;
  if (Array.isArray(r.claims)) claims = r.claims;
  else if (typeof r.claims === 'string' && r.claims.length > 0) {
    try { claims = JSON.parse(r.claims) as string[]; } catch { /* ignore */ }
  }
  return {
    id: r.feature_id,
    title: r.title ?? '',
    status: r.status as FeatureRecord['status'],
    attempts: toNum(r.attempts),
    ...(claims ? { claims } : {}),
    ...(r.notes ? { notes: r.notes } : {}),
    ...(r.summary ? { summary: r.summary } : {}),
    ...(r.kind ? { kind: r.kind } : {}),
  } as FeatureRecord;
}

/** Read every feature row for the active workspace. */
export async function readFeaturesPg(ctx: PgStateContext): Promise<FeatureRecord[]> {
  // Audit P-018: with no harness slug the two `${ctx.harnessSlug ?? ''}` legs below
  // silently corrupt the result — the started-plan subquery matches nothing, so
  // EVERY plan-linked feature vanishes, while the pick-gate join treats all rows as
  // local. No slug = no harness context; fail empty and visibly rather than decide
  // on corrupted data.
  if (!ctx.harnessSlug) {
    console.warn('[state-pg] readFeaturesPg called with no harnessSlug — returning no features');
    return [];
  }
  const rows = await ctx.pg<FeatureRow[]>`
    SELECT hf.feature_id, hf.title, hf.summary, hf.status, hf.attempts, hf.claims,
           hf.notes, hf.metadata, hf.kind, hf.project_id, hf.expected_cost_cents,
           hf.tags, hf.needs_human_review, hf.ts, hf.created_ts, hf.updated_ts
      FROM harness_features hf
      -- G2 Auditor-admission gate (P-008): LEFT JOIN against the consolidated
      -- table to read origin + audit_verdict without touching the per-harness
      -- schema. hfc may have no row yet (pre-sync) — treat that as local/pickable.
      LEFT JOIN harness_shared.harness_features_consolidated hfc
        ON hfc.harness_slug = ${ctx.harnessSlug ?? ''}
       AND hfc.feature_id   = hf.feature_id
     WHERE hf.workspace_id = ${ctx.workspaceId}
       AND (
         -- G2 pick-gate: local features always pass; remote features only pass
         -- when the auditor has admitted them. NULL origin (pre-G1 row, no hfc
         -- row yet) is treated as local for backward compat.
         hfc.feature_id IS NULL
         OR hfc.origin = 'local'
         OR hfc.audit_verdict = 'admit'
       )
       AND (
         -- Features not linked to any plan are always eligible (legacy/manual).
         -- ledger P-004: the plan slug now lives in the first-class
         -- source_plan_slug COLUMN (written by plan-to-work-item promotion +
         -- convert-at-pickup), with metadata->>'source_plan' kept only for
         -- pre-promotion features. We read it from hfc, the consolidated table
         -- already LEFT JOINed above (qualified, ALWAYS has the column), NULL when
         -- there is no consolidated row yet (pre-sync local feature, metadata
         -- fallback). This avoids referencing a per-harness column that a stale,
         -- SELECT*-frozen harness_features view may not expose.
         COALESCE(hfc.source_plan_slug, hf.metadata->>'source_plan') IS NULL
         OR
         -- Features from plans must belong to a started plan.
         COALESCE(hfc.source_plan_slug, hf.metadata->>'source_plan') IN (
           SELECT plan_slug
             FROM harness_shared.harness_plans
            WHERE workspace_id = ${ctx.workspaceId}
              AND harness_slug  = ${ctx.harnessSlug ?? ''}
              AND op_status     = 'started'
         )
       )
     ORDER BY hf.feature_id
  `;
  const features = rows.map(rowToFeature);
  // Phase 3 carve-out (dbos-durable-jobs D-012): exclude features a live durable
  // pipeline already owns, so the GLOBAL orchestrator never decides for them (the
  // per-feature pipeline's own director does) — otherwise the two double-dispatch.
  // No-op when PAPERCUSP_DBOS_ORCHESTRATOR is off: empty set, zero extra queries.
  const owned = await durableOwnedFeatureIdsPg(ctx);
  return owned.size > 0 ? features.filter((f) => !owned.has(f.id)) : features;
}

/**
 * Phase 3 of dbos-durable-jobs (D-011/D-012/D-013): the set of feature ids
 * currently OWNED by a live durable pipeline — a PENDING/ENQUEUED DBOS workflow
 * with id `pipeline:<slug>:<feature>:e<epoch>`. Read straight from DBOS's own
 * system table via the orchestrator's existing pg: `runMainLoop` is a separate
 * subprocess with no DBOS runtime, so it can't call `DBOS.retrieveWorkflow()`
 * (D-013). Same database, different schema — a plain cross-schema read.
 *
 * Gated by `PAPERCUSP_DBOS_ORCHESTRATOR` — ON by default (P-009: DBOS is the
 * default orchestrator; set `=0` for the legacy-loop revert → empty, no query).
 * Resilient by design (D-006 / D-013 off-path safety): no slug, an absent `dbos`
 * schema (`to_regclass` → NULL, no throw), or ANY query error all yield an empty
 * set → no carve-out → byte-identical legacy behavior.
 */
export async function durableOwnedFeatureIdsPg(ctx: PgStateContext): Promise<Set<string>> {
  // P-009: DBOS is the default orchestrator (on unless explicitly =0). The carve-out
  // runs by default; the to_regclass guard below makes it a safe no-op when the dbos
  // schema is absent (DBOS not booted). Set =0 for the legacy-loop revert.
  if (process.env.PAPERCUSP_DBOS_ORCHESTRATOR === '0') return new Set();
  const slug = ctx.harnessSlug;
  if (!slug) return new Set();
  try {
    // to_regclass returns NULL (no throw) when the dbos schema/table is absent —
    // the common case (DBOS idle / off), so don't let it raise.
    const reg = await ctx.pg<{ t: string | null }[]>`
      SELECT to_regclass('dbos.workflow_status') AS t
    `;
    if (!reg[0]?.t) return new Set();
    // workflow_uuid = `pipeline:<slug>:<feature>:e<epoch>`; slug + feature carry no
    // ':' (kebab slug, F-NNN feature), so split_part(...,3) is the feature id.
    const prefix = `pipeline:${slug}:%`;
    const rows = await ctx.pg<{ feature_id: string }[]>`
      SELECT DISTINCT split_part(workflow_uuid, ':', 3) AS feature_id
        FROM dbos.workflow_status
       WHERE workflow_uuid LIKE ${prefix}
         AND status IN ('PENDING', 'ENQUEUED')
    `;
    return new Set(rows.map((r) => r.feature_id).filter((id) => id.length > 0));
  } catch {
    // Any failure (schema absent, cross-db, permission) → no carve-out.
    return new Set();
  }
}

/** Return plan slugs that are currently 'started' for this harness. */
export async function readStartedPlanSlugsPg(ctx: PgStateContext): Promise<string[]> {
  if (!ctx.harnessSlug) return [];
  const rows = await ctx.pg<{ plan_slug: string }[]>`
    SELECT plan_slug
      FROM harness_shared.harness_plans
     WHERE workspace_id = ${ctx.workspaceId}
       AND harness_slug  = ${ctx.harnessSlug}
       AND op_status     = 'started'
     ORDER BY plan_slug
  `;
  return rows.map((r) => r.plan_slug);
}

/** True iff the active workspace has at least one feature row. */
export async function featuresExistPg(ctx: PgStateContext): Promise<boolean> {
  const rows = await ctx.pg<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM harness_features WHERE workspace_id = ${ctx.workspaceId}
    ) AS exists
  `;
  return rows[0]?.exists === true;
}

/** Attempts count for a feature, 0 if not present. */
export async function featureAttemptsPg(ctx: PgStateContext, featureId: string): Promise<number> {
  const rows = await ctx.pg<{ attempts: number | bigint | null }[]>`
    SELECT attempts FROM harness_features
     WHERE workspace_id = ${ctx.workspaceId} AND feature_id = ${featureId}
     LIMIT 1
  `;
  return rows.length === 0 ? 0 : toNum(rows[0].attempts);
}

/**
 * Design-phase gate: refuses to flip a feature into `in_progress` when
 * the design phase is still pending.
 *
 * Reads needs_design + design_status from harness_shared.harness_features_consolidated
 * (the canonical store, not per-harness). When needs_design is TRUE and
 * design_status is NULL or 'pending', throws DesignGateError.
 *
 * Off by default — only fires when env PAPERCUSP_DESIGN_GATE=1. Lets
 * existing harnesses ship without surprise gating; opt-in per workspace
 * by setting the env in the operator's startup. Once a harness's
 * features have all been triaged (accepted / ignored), turn the flag
 * on for that workspace.
 *
 * See apps/operator/content/internal-docs/design/design-phase-plan.mdx §2.
 */
export class DesignGateError extends Error {
  readonly featureId: string;
  readonly designStatus: string | null;
  constructor(featureId: string, designStatus: string | null) {
    super(
      `feature ${featureId} cannot transition to in_progress: ` +
        `needs_design=true, design_status=${designStatus ?? 'null'} ` +
        `(must be 'accepted' or 'ignored'). Set design_status=ignored to skip the design phase.`,
    );
    this.name = 'DesignGateError';
    this.featureId = featureId;
    this.designStatus = designStatus;
  }
}

function gateEnabled(): boolean {
  return process.env.PAPERCUSP_DESIGN_GATE === '1';
}

async function checkDesignGate(
  ctx: PgStateContext,
  featureId: string,
  harnessSlug: string,
): Promise<void> {
  if (!gateEnabled()) return;
  const rows = await ctx.pg<{ needs_design: boolean; design_status: string | null }[]>`
    SELECT needs_design, design_status
      FROM harness_shared.harness_features_consolidated
     WHERE harness_slug = ${harnessSlug} AND feature_id = ${featureId}
     LIMIT 1
  `;
  const r = rows[0];
  if (!r) return; // no row → can't gate; let the no-op behavior of UPDATE handle it
  if (!r.needs_design) return;
  if (r.design_status === 'accepted' || r.design_status === 'ignored') return;
  throw new DesignGateError(featureId, r.design_status);
}

/**
 * True iff this harness has its OWN per-harness `harness_<slug>` PG schema in the
 * caller's search_path. Every currently-registered harness gets one at
 * registration time (scaffold-harness-schema.ts, D-007) — in that case the
 * unqualified `harness_features` name used below resolves to THAT harness's own
 * auto-updatable, harness_slug-filtered view, so every UPDATE in this file is
 * already correctly scoped to exactly this harness.
 *
 * False only when no per-harness schema exists at all (a scaffold failure, a
 * mid-provisioning race, or a throwaway/gym harness whose schema was torn down
 * — see gym/README.md "worker invoke harness_features 42P01"). In that case the
 * unqualified name instead falls through to `harness_shared.harness_features`
 * (497-harness-features-shared-fallback-view.sql) — a compat view spanning
 * EVERY harness in the workspace with NO harness_slug filter. That view is
 * (despite its own "read-only by design" comment) actually WRITABLE by the
 * runtime role in practice — migration 109's `ALTER DEFAULT PRIVILEGES` on
 * `harness_shared` silently grants INSERT/UPDATE/DELETE to every later-created
 * object in that schema, this view included — so an unqualified UPDATE here
 * would not fail loudly as the 497 comment assumes; it would SUCCEED with a
 * real cross-tenant hazard instead: `feature_id` is only unique PER HARNESS
 * (the PK is `(harness_slug, feature_id)`), so an UPDATE keyed on
 * workspace_id+feature_id alone can silently mutate ANOTHER harness's
 * same-numbered feature (every harness starts its own "F-001") in the same
 * workspace. EI-13935: on this branch, write the base table directly with an
 * explicit harness_slug predicate instead of relying on the unqualified name.
 */
async function hasPerHarnessSchema(ctx: PgStateContext): Promise<boolean> {
  if (!ctx.harnessSlug) return true; // unknown slug — can't detect; preserve legacy behavior
  // Mirrors packages/operator-core/lib/scaffold-harness-schema.ts#harnessSchemaName.
  // Not imported: this package has no dependency on operator-core (it runs
  // standalone, shelled out as its own CLI) — keep the two transforms in sync.
  const schema = 'harness_' + ctx.harnessSlug.toLowerCase().replace(/-/g, '_');
  const rows = await ctx.pg<{ t: string | null }[]>`
    SELECT to_regclass(${schema + '.harness_features'}) AS t
  `;
  return rows[0]?.t != null;
}

/**
 * Update a feature's status. Bumps or resets attempts per options. Returns
 * the full feature list after the write. No-op if the feature doesn't
 * exist (matches bash `feature_set_status`'s silent no-op behavior).
 */
export async function setFeatureStatusPg(
  ctx: PgStateContext,
  featureId: string,
  status: FeatureRecord['status'],
  options: { bumpAttempts?: boolean; resetAttempts?: boolean } = {},
): Promise<FeatureRecord[]> {
  const slug = ctx.harnessSlug;
  if (status === 'in_progress' && slug) {
    await checkDesignGate(ctx, featureId, slug);
  }
  const now = Date.now();
  // EI-13935: when there's no per-harness schema for this harness, the unqualified
  // name below would resolve to the unfiltered, cross-harness fallback view — write
  // the base table directly, explicitly scoped, instead. See hasPerHarnessSchema.
  if (slug != null && !(await hasPerHarnessSchema(ctx))) {
    if (options.resetAttempts) {
      await ctx.pg`
        UPDATE harness_shared.work_items
           SET status = ${status}, attempts = 0, updated_ts = ${now}
         WHERE workspace_id = ${ctx.workspaceId} AND harness_slug = ${slug}
           AND feature_id = ${featureId} AND item_kind NOT IN ('bug', 'change', 'task')
      `;
    } else if (options.bumpAttempts) {
      await ctx.pg`
        UPDATE harness_shared.work_items
           SET status = ${status},
               attempts = COALESCE(attempts, 0) + 1,
               updated_ts = ${now}
         WHERE workspace_id = ${ctx.workspaceId} AND harness_slug = ${slug}
           AND feature_id = ${featureId} AND item_kind NOT IN ('bug', 'change', 'task')
      `;
    } else {
      await ctx.pg`
        UPDATE harness_shared.work_items
           SET status = ${status}, updated_ts = ${now}
         WHERE workspace_id = ${ctx.workspaceId} AND harness_slug = ${slug}
           AND feature_id = ${featureId} AND item_kind NOT IN ('bug', 'change', 'task')
      `;
    }
    return readFeaturesPg(ctx);
  }
  if (options.resetAttempts) {
    await ctx.pg`
      UPDATE harness_features
         SET status = ${status}, attempts = 0, updated_ts = ${now}
       WHERE workspace_id = ${ctx.workspaceId} AND feature_id = ${featureId}
    `;
  } else if (options.bumpAttempts) {
    await ctx.pg`
      UPDATE harness_features
         SET status = ${status},
             attempts = COALESCE(attempts, 0) + 1,
             updated_ts = ${now}
       WHERE workspace_id = ${ctx.workspaceId} AND feature_id = ${featureId}
    `;
  } else {
    await ctx.pg`
      UPDATE harness_features
         SET status = ${status}, updated_ts = ${now}
       WHERE workspace_id = ${ctx.workspaceId} AND feature_id = ${featureId}
    `;
  }
  return readFeaturesPg(ctx);
}
