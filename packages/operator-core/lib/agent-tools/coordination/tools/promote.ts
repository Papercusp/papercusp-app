/**
 * plans:promote — promote a plan into a harness as features (+ their
 * inline VAL-* assertions).
 *
 * agent-coordination-architecture-v2 §11, as amended by
 * plans-central-harness-ux-2026-05-26 (D-004/D-005): plans replaced
 * SPEC.md as the authoritative scope/acceptance document, so promote no
 * longer writes SPEC.md — it extracts inline VAL-* assertions from the
 * plan items and stores them as `feature.claims` + `harness_plan_assertions`.
 *
 *   - **Preview** (default, `apply: false`): parses the plan, lists the
 *     VAL-* assertions that would be extracted for the named `from_items`,
 *     and returns the per-feature summary for the caller to inspect —
 *     useful for dry-runs / agent-driven proposal review.
 *   - **Apply** (`apply: true`): `POST`s the features to
 *     `/features/import` so the server allocates F-AUTO-* ids (carrying
 *     `claims` + source-plan provenance), upserts the extracted VAL-*
 *     assertions into `harness_plan_assertions`, and — unless
 *     `mark_items: false` — marks each plan item listed in `from_items`
 *     as `done` via `withPlanLock` + `flipStatusInBody`. It then writes a
 *     `## Promoted` block + `## Now` status line back into the plan and
 *     flips a `draft` plan to `active`.
 *   - **plan_event**: always emits a `kind=promoted` event so the
 *     history viewer surfaces it. The `after` payload differs between
 *     preview and apply.
 *
 * Reads the plan via `readPlanBySlug` to validate the slug exists and to
 * surface item IDs back in the preview / apply summary.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity, type ResolveIdentityCtx } from '../identity';
import { COORD_ROLES } from '../roles';
import { hardText, LIMITS } from '../../limits';
import { findUnknownFromItems } from '../promote';
import { emitPlanEventForCaller } from '../plan-events';
import { readPlanBySlug } from '../../plans/source';
import { ctxToPlanSourceOpts } from '../../plans/_ctx-opts';
import { parsePromotePolicy, buildWaveFeatures, applyInterWaveEdges, type BuiltFeature, type SpawnChild } from '../../plans/promote-policy';
import {
  executeSpawnChild,
  buildDefaultSpawnChildDeps,
  childSeedSlug,
  describeSpawnStart,
  type SpawnChildResult,
} from '../spawn-child';
import {
  computeDestructiveReplanDiff,
  decideDestructiveReplan,
  DEFAULT_PROTECTED_STATUSES,
} from '../../plans/destructive-replan';
import {
  resolveForEach,
  isForEachResolver,
  isCompletionTimeForEach,
} from '../../plans/for-each-resolver';
import { FanoutCapError, type ResolveFanoutCtx } from '@papercusp/fanout-resolver';
import { withPlanLock, bumpUpdatedDate } from '../../plans/with-plan-lock';
import { flipStatusInBody } from '../../plans/set-status';
import { planRevisionCapture, type PlanRevisionCtx } from '../../plans/revisions';
import { extractAssertions, type PlanAssertion } from '../../plans/val-assertions';
import { evaluatePromotionAssertionGate } from '../../plans/promotion-assertion-gate';
import { matchRoutingGateHint } from '../../../routing-gate-hints';
import { loopbackFetch, readJsonBody } from '../../../loopback-fetch';
import { resolveProject } from '../../../harness-core';
import { getOrgPg, harnessQuery } from '@papercusp/db-org';
import { phaseRequiresTwoMachineRig } from '../../../plan-phase-rig';

const PROMOTED_FENCE = '<!-- plan-pipeline: do not edit this block manually -->';
const PROMOTED_ROW_ID_RE = /^\- \[[ x]\] ((?:F|WI)-[A-Z0-9-]+)/;

/**
 * Marker for the auto-generated promote-status line inside `## Now`.
 * Lives at the end of the Now block, BELOW user-authored `**State:**`
 * and `**Next:**` lines. Idempotently replaced on each promote so
 * re-promoting accumulates correctly instead of appending duplicates.
 */
const PROMOTE_STATUS_MARKER = '<!-- plan-pipeline-status -->';

/**
 * Append (or replace) an auto-generated status line inside the `## Now`
 * block summarising how many features the plan has promoted and where
 * they are. Preserves user-authored `**State:**` / `**Next:**` content
 * verbatim — only the marker-delimited line is touched.
 *
 * The status line format:
 *   <!-- plan-pipeline-status -->
 *   **Promote-status:** N features in <harnessSlug>: <inflight> in-flight · <passed> passed
 *
 * If the plan has no `## Now` block, returns the body unchanged
 * (promote write-back has no preferred state/next to author).
 */
export interface WaveSummary {
  wave: string;
  total: number;
  passed: number;
  inflight: number;
  blocked: number;
  failing: number;
}

export function upsertPromoteStatusLine(
  body: string,
  harnessSlug: string,
  counts: { total: number; inflight: number; passed: number },
  waveSummaries?: WaveSummary[],
): string {
  const totalsLine =
    `**Promote-status:** ${counts.total} feature(s) in \`${harnessSlug}\`: ` +
    `${counts.inflight} in-flight · ${counts.passed} passed`;

  // Per-wave breakdown (P-013) — rendered as a compact table when waves exist.
  const waveLines: string[] = [];
  if (waveSummaries && waveSummaries.length > 1) {
    for (const w of waveSummaries) {
      const stuck = w.failing > 0 ? ` ⚠ ${w.failing} failing` : '';
      const blk = w.blocked > 0 ? ` · ${w.blocked} blocked` : '';
      waveLines.push(
        `  Wave **${w.wave}**: ${w.total} total · ${w.passed} passed · ${w.inflight} in-flight${blk}${stuck}`,
      );
    }
  }

  const block =
    `${PROMOTE_STATUS_MARKER}\n` +
    totalsLine +
    (waveLines.length ? '\n' + waveLines.join('\n') : '');

  // Strip any prior marker line + ALL of its content lines (idempotent
  // re-promote). The status block is the marker, the totals line, and zero
  // or more per-wave lines — so consume every non-blank line after the
  // marker up to the trailing blank line. The old regex only ate the marker
  // + two lines, which orphaned wave lines 2..N in a multi-wave breakdown on
  // re-promote (the only case that renders, since waves require length > 1).
  const stripRe = new RegExp(
    `\\n?${PROMOTE_STATUS_MARKER}(?:\\n(?!\\n)[^\\n]*)*`,
    'g',
  );
  const stripped = body.replace(stripRe, '');

  // Find the end of the ## Now block (next ## heading or EOF).
  const nowMatch = /^## (?:\d+(?:\.\d+)?\.\s+)?Now\b/m.exec(stripped);
  if (!nowMatch) return stripped;
  const afterNow = nowMatch.index + nowMatch[0].length;
  const tail = stripped.slice(afterNow);
  const nextSection = /^## /m.exec(tail);
  const insertAt = nextSection ? afterNow + nextSection.index : stripped.length;

  // Ensure exactly one blank line before the marker, one after.
  const before = stripped.slice(0, insertAt).replace(/\n*$/, '');
  const after = stripped.slice(insertAt).replace(/^\n*/, '');
  return `${before}\n\n${block}\n\n${after}`;
}

export function upsertPromotedBlock(body: string, newRows: string[]): string {
  if (newRows.length === 0) return body;
  const headerMatch = /^## Promoted\b/m.exec(body);

  if (headerMatch) {
    const start = headerMatch.index;
    const afterHeader = start + headerMatch[0].length;
    const nextSectionRel = /^## /m.exec(body.slice(afterHeader));
    const blockEnd = nextSectionRel ? afterHeader + nextSectionRel.index : body.length;
    const blockContent = body.slice(start, blockEnd);

    const existingIds = new Set<string>();
    for (const row of blockContent.split('\n')) {
      const m = PROMOTED_ROW_ID_RE.exec(row);
      if (m) existingIds.add(m[1]);
    }
    const deduped = newRows.filter((r) => {
      const m = PROMOTED_ROW_ID_RE.exec(r);
      return m ? !existingIds.has(m[1]) : true;
    });
    if (deduped.length === 0) return body;

    const insert = deduped.join('\n') + '\n';
    return body.slice(0, blockEnd) + insert + body.slice(blockEnd);
  }

  const block = `\n## Promoted\n\n${PROMOTED_FENCE}\n${newRows.join('\n')}\n`;
  const nowMatch = /^## Now\b/m.exec(body);
  if (nowMatch) {
    const afterNow = nowMatch.index + nowMatch[0].length;
    const nextSectionRel = /^## /m.exec(body.slice(afterNow));
    const ins = nextSectionRel ? afterNow + nextSectionRel.index : body.length;
    return body.slice(0, ins) + block + body.slice(ins);
  }
  return body + block;
}

/** A promoted feature whose realized structure is recorded in `## Promoted`. */
export interface PromotedRowFeature {
  title?: string;
  from_items?: string[];
  blocked_by?: string[];
  order?: number;
  /** Per-feature wave (set by the all-waves promote, P-044). Falls back to the
   *  call-level `waveId` when unset. */
  wave?: string;
  /** P-004 (promote-spawn-child-harness): set when this feature was routed into
   *  a spawned child harness — the `## Promoted` row is annotated
   *  `→ spawned child <slug> (plan <seed-slug>)` so the parent plan records
   *  where its sub-work went. */
  spawned_child?: { slug: string; seedSlug: string };
}

/**
 * Build the `## Promoted` checkbox rows, recording the REALIZED wave/parallelism
 * structure the promoting agent emitted (P-041): each row carries its allocated
 * id, title, and — when present — `wave`, `order`, and `blocked_by` (the durable,
 * reviewable, reproducible shape, consistent with plans-central). A `blocked_by`
 * ref that points at another feature in the SAME promote batch is rewritten to
 * that feature's allocated id (canonical); a ref to an existing feature is kept
 * verbatim. `ids[i]` is the server-allocated id for `features[i]`.
 */
export function buildPromotedRows(
  features: ReadonlyArray<PromotedRowFeature>,
  ids: readonly string[],
  waveId?: string,
): string[] {
  // batch title (normalized) → allocated id, so blocked_by refs to batch peers
  // are recorded as canonical ids.
  const idByTitle = new Map<string, string>();
  features.forEach((f, i) => {
    const t = f.title?.trim().toLowerCase();
    if (t && ids[i]) idByTitle.set(t, ids[i]);
  });
  return ids.map((fid, idx) => {
    const f = features[idx] ?? {};
    const itemRef = f.from_items?.[0] ? ` <!-- ${f.from_items[0]} -->` : '';
    const bits: string[] = [];
    const w = f.wave ?? waveId;
    if (w) bits.push(`wave ${w}`);
    if (typeof f.order === 'number') bits.push(`order ${f.order}`);
    if (f.blocked_by && f.blocked_by.length > 0) {
      const refs = f.blocked_by.map((ref) => idByTitle.get(ref.trim().toLowerCase()) ?? ref);
      bits.push(`blocked_by ${refs.join(', ')}`);
    }
    if (f.spawned_child) {
      bits.push(`→ spawned child ${f.spawned_child.slug} (plan ${f.spawned_child.seedSlug})`);
    }
    const struct = bits.length > 0 ? ` — ${bits.join(' · ')}` : '';
    return `- [ ] ${fid} — ${f.title ?? fid}${struct}${itemRef}`;
  });
}

const FEATURE_INPUT = z.object({
  title: hardText(LIMITS.SHORT_TITLE),
  body: z.string().optional(),
  acceptance: z.array(z.string().min(1)).optional(),
  from_items: z
    .array(z.string().regex(/^P-\d{3,}$/, 'P-NNN form required'))
    .optional(),
  // Per-feature hints (promote-policy-and-waves) — carried into metadata for the orchestrator/director.
  assigned_role: z.string().optional(),
  blocked_by: z.array(z.string()).optional(),
  order: z.number().int().optional(),
});

/** Resolve the operator's own base URL (in-process http for now). */
function operatorBase(): string {
  const port = process.env.PORT ?? '3055';
  return process.env.INTERNAL_API_BASE ?? `http://127.0.0.1:${port}`;
}

/**
 * Build the injected runners for a `for_each` glob/sql resolver (P-043): glob
 * over the harness repo via fast-glob; sql against the harness PG (SELECT-only —
 * a resolver reads, never mutates). Resolved lazily so an `items` resolver pays
 * for neither.
 */
function buildForEachCtx(harnessSlug: string, workspaceId: string | undefined): ResolveFanoutCtx {
  return {
    runGlob: async (pattern) => {
      const project = await resolveProject(harnessSlug, workspaceId);
      if (!project) throw new Error(`unknown harness '${harnessSlug}'`);
      const fg = (await import('fast-glob')).default;
      return fg(pattern, { cwd: project.path, dot: false, onlyFiles: true });
    },
    runSql: async (sqlText) => {
      if (!/^\s*select\b/i.test(sqlText)) {
        throw new Error('a for_each sql resolver must be a read-only SELECT');
      }
      const rows = (await harnessQuery(harnessSlug, (sql) => sql.unsafe(sqlText))) as unknown as Array<
        Record<string, unknown>
      >;
      return rows.map((r) => String(Object.values(r)[0] ?? '')).filter(Boolean);
    },
  };
}

interface FeaturesImportResponse {
  ok?: boolean;
  inserted?: number;
  updated?: number;
  total?: number;
  ids?: string[];
  error?: string;
  // R23: provenance back-channel observability (from R8 + F2 features.ts work).
  // When a feature carries source_plan_slug the import handler back-writes to
  // consolidated; per-feature errors are surfaced so plans:promote can echo
  // them in its response.
  provenanceWritten?: number;
  provenanceFailed?: number;
  provenanceErrors?: Array<{ feature_id: string; error: string }>;
}



async function postFeaturesImport(
  harnessSlug: string,
  features: Array<{
    title: string;
    summary?: string;
    metadata: Record<string, unknown>;
    id?: string;
    claims?: string[];
    source_plan_slug?: string;
    source_plan_item_ids?: string[];
    wave?: string;
    needs_2_machine_rig?: boolean;
    blocked_by?: string[];
    order?: number;
  }>,
): Promise<{
  ids: string[];
  inserted: number;
  updated: number;
  provenanceWritten?: number;
  provenanceFailed?: number;
  provenanceErrors?: Array<{ feature_id: string; error: string }>;
}> {
  const r = await loopbackFetch(
    `${operatorBase()}/api/harness/${encodeURIComponent(harnessSlug)}/features/import`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ features }),
    },
  );
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`features_import_failed:${r.status}:${text.slice(0, 200)}`);
  }
  // readJsonBody (not bare .json()) so a 200 with an empty/truncated body during
  // a host restart rethrows an ATTRIBUTABLE error naming this URL — not the
  // frame-less `SyntaxError: Unexpected end of JSON input` that fatal-exited the
  // shared :3070 host (EI-20). `if (!r.ok)` above does NOT catch this: a zero-byte
  // 200 (host restarting mid-stream) passes the status check.
  const j = await readJsonBody<FeaturesImportResponse>(
    r,
    `${operatorBase()}/api/harness/${harnessSlug}/features/import`,
  );
  return {
    ids: j.ids ?? [],
    inserted: j.inserted ?? 0,
    updated: j.updated ?? 0,
    ...(j.provenanceWritten != null && { provenanceWritten: j.provenanceWritten }),
    ...(j.provenanceFailed != null && { provenanceFailed: j.provenanceFailed }),
    ...(j.provenanceErrors && j.provenanceErrors.length > 0 && { provenanceErrors: j.provenanceErrors }),
  };
}

/** Read the harness features minted from `planSlug` (the destructive diff input). */
async function readExistingPlanFeatures(
  harnessSlug: string,
  planSlug: string,
  workspaceId: string,
): Promise<Array<{ featureId: string; status: string }>> {
  const { sql } = getOrgPg();
  const rows = await sql<{ feature_id: string; status: string }[]>`
    SELECT feature_id, status FROM harness_shared.harness_features_consolidated
     WHERE workspace_id     = ${workspaceId}
       AND source_plan_slug = ${planSlug}
       AND harness_slug     = ${harnessSlug}
  `;
  return rows.map((r) => ({ featureId: r.feature_id, status: r.status }));
}

interface DestructiveReplanOutcome {
  toMint: string[];
  toKeep: string[];
  toDeprecate: string[];
  protectedFromDeprecation: string[];
  /** Set only after a real apply: the features actually deprecated + any errors. */
  deprecated?: string[];
  deprecateErrors?: string[];
}

/**
 * Destructive replan: converge the harness to the plan's CURRENT feature set by
 * deprecating features the plan dropped. `currentFeatureIds` is the canonical id
 * set the plan now declares (importRes.ids on apply; caller `feature_ids` on
 * preview). When `apply` is false, no writes happen — the diff is returned for the
 * preview. Returns `{ refuse }` (caller fails closed) on an unsafe empty-plan wipe.
 */
async function runDestructiveReplan(opts: {
  harnessSlug: string;
  planSlug: string;
  workspaceId: string;
  currentFeatureIds: string[];
  force: boolean;
  apply: boolean;
}): Promise<
  | { refuse: { code: 'unsafe_empty_replan'; detail: string; wouldDeprecate: string[] } }
  | { outcome: DestructiveReplanOutcome }
> {
  const existing = await readExistingPlanFeatures(opts.harnessSlug, opts.planSlug, opts.workspaceId);
  const diff = computeDestructiveReplanDiff(opts.currentFeatureIds, existing, {
    protectStatuses: opts.force ? [] : DEFAULT_PROTECTED_STATUSES,
  });
  const decision = decideDestructiveReplan(diff, { force: opts.force });
  if (decision.action === 'refuse') {
    return {
      refuse: {
        code: 'unsafe_empty_replan',
        detail: decision.refusalDetail ?? 'destructive replan refused (empty plan)',
        wouldDeprecate: diff.toDeprecate,
      },
    };
  }
  const base: DestructiveReplanOutcome = {
    toMint: diff.toMint,
    toKeep: diff.toKeep,
    toDeprecate: decision.toDeprecate,
    protectedFromDeprecation: decision.protectedHeld,
  };
  if (!opts.apply) return { outcome: base };

  // Apply: deprecate each dropped feature through the canonical PATCH path
  // (records feature_audit; the route requires a deprecation_reason).
  const deprecated: string[] = [];
  const deprecateErrors: string[] = [];
  for (const fid of decision.toDeprecate) {
    try {
      const r = await loopbackFetch(
        `${operatorBase()}/api/harness/${encodeURIComponent(opts.harnessSlug)}/features/${encodeURIComponent(fid)}`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            status: 'deprecated',
            deprecation_reason: `destructive-replan: dropped from plan ${opts.planSlug}`,
          }),
        },
      );
      if (r.ok) deprecated.push(fid);
      else deprecateErrors.push(`${fid}: HTTP ${r.status}`);
    } catch (e) {
      deprecateErrors.push(`${fid}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { outcome: { ...base, deprecated, deprecateErrors } };
}

/**
 * WI-3972: back-fill a plan's `## Promoted` block from features it ALREADY
 * promoted (rows in `harness_features_consolidated` with this plan as
 * `source_plan_slug`) when the plan has no `## Promote` policy to derive a
 * NEW promotion from. Returns `null` (no-op — caller falls through to its
 * normal `no_promote_policy` failure) when there is nothing on record to
 * back-fill; otherwise returns the tool result to send straight back to the
 * caller (a preview in `apply:false`, or the write outcome in `apply:true`).
 */
async function backfillPromotedFromConsolidated(opts: {
  ctx: ResolveIdentityCtx & { log?: (msg: string) => void };
  slug: string;
  apply: boolean;
  planTitle: string;
  planRaw: string;
  planScope: { workspaceId: string; harnessSlug: string };
  fail: (error: string, detail?: string) => {
    content: Array<{ type: 'text'; text: string }>;
    isError: true;
  };
}) {
  const { ctx, slug, apply, planTitle, planRaw, planScope, fail } = opts;
  type ConsolidatedRow = {
    feature_id: string;
    title: string | null;
    source_plan_item_ids: string[] | null;
    wave: string | null;
    feature_order: number | null;
  };
  let existingRows: ConsolidatedRow[] = [];
  try {
    const { sql } = getOrgPg();
    const workspaceId = planScope.workspaceId;
    existingRows = await sql<ConsolidatedRow[]>`
      SELECT feature_id, title, source_plan_item_ids, wave, feature_order
        FROM harness_shared.harness_features_consolidated
       WHERE workspace_id = ${workspaceId}
         AND source_plan_slug = ${slug}
       ORDER BY feature_order NULLS LAST, feature_id
    `;
  } catch (e) {
    ctx.log?.(`[plans:promote] WI-3972 backfill lookup failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
  if (existingRows.length === 0) return null;

  const backfillFeatures: PromotedRowFeature[] = existingRows.map((r) => ({
    title: r.title ?? r.feature_id,
    from_items: r.source_plan_item_ids ?? undefined,
    order: r.feature_order ?? undefined,
    wave: r.wave ?? undefined,
  }));
  const backfillIds = existingRows.map((r) => r.feature_id);
  const backfillRows = buildPromotedRows(backfillFeatures, backfillIds);

  if (!apply) {
    const newRows = /^## Promoted\b/m.test(planRaw)
      ? backfillRows.filter((row) => {
          const m = PROMOTED_ROW_ID_RE.exec(row);
          return m ? !new RegExp(`\\b${m[1]}\\b`).test(planRaw) : true;
        })
      : backfillRows;
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            mode: 'preview',
            backfill: true,
            plan_title: planTitle,
            detail:
              `plan has ${existingRows.length} already-promoted feature(s) on record but no \`## Promote\` policy — ` +
              `apply:true would BACK-FILL the \`## Promoted\` block from them (no new import, no items marked, no assertions) ` +
              `rather than promoting anything new.`,
            would_record: newRows,
            already_recorded: backfillRows.length - newRows.length,
          }),
        },
      ],
    };
  }

  let wrote = false;
  const revision = planRevisionCapture(
    ctx as PlanRevisionCtx,
    slug,
    'plans:promote → WI-3972 backfill ## Promoted block (no policy, already-promoted features)',
    planScope,
  );
  const writeResult = await withPlanLock<null>(
    ctx as never,
    {
      slug,
      intent: 'plans:promote → WI-3972 backfill ## Promoted block (no policy, already-promoted features)',
      ...planScope,
      afterWrite: revision.afterWrite,
    },
    async (current): Promise<{ newBody: string | null; value: null }> => {
      if (current === null) return { newBody: null, value: null };
      const newBody = upsertPromotedBlock(current, backfillRows);
      if (newBody === current) return { newBody: null, value: null };
      wrote = true;
      return { newBody: bumpUpdatedDate(newBody), value: null };
    },
  );
  if (writeResult.kind === 'busy') {
    return fail('plan_locked', `plan ${slug} is locked by another writer — retry the backfill`);
  }
  if (!wrote) {
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            mode: 'backfill',
            plan_title: planTitle,
            backfilled: { feature_ids: [], count: 0 },
            detail: 'all already-promoted features were already recorded in `## Promoted` — nothing to back-fill.',
          }),
        },
      ],
    };
  }
  await emitPlanEventForCaller(ctx, {
    planSlug: slug,
    event: 'promoted',
    after: {
      harness_slug: null,
      feature_count: existingRows.length,
      feature_ids: backfillIds,
      mode: 'backfill',
    },
    detail: `WI-3972: backfilled \`## Promoted\` block from ${existingRows.length} already-promoted feature(s) (no \`## Promote\` policy on the plan; no new import)`,
  });
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          ok: true,
          mode: 'backfill',
          plan_title: planTitle,
          backfilled: { feature_ids: backfillIds, count: backfillIds.length },
        }),
      },
    ],
  };
}

/**
 * Persist a plan's inline VAL-* assertions into harness_plan_assertions.
 *
 * P-003 (D-002/D-005). This is a separate, INJECTABLE unit rather than an inline
 * block for one reason: promote's fail-closed path has to be testable. `sql` is a
 * parameter instead of a `getOrgPg()` call made inside, so a unit test can drive a
 * failing store directly — the same testability `spawn-child` already gets from
 * `SpawnChildDeps.writeAssertions`, and whose absence here is why promote's refusal
 * was otherwise only reachable through a live PG.
 *
 * It NEVER throws, and it NEVER decides policy: it reports per-assertion outcomes
 * and the CALLER owns the refusal. That split is deliberate. The defect this
 * replaced was a persistence step that silently downgraded its own failure to a
 * warning — precisely what a helper allowed to own policy is free to do again.
 */
export async function persistPlanAssertions(opts: {
  sql: ReturnType<typeof getOrgPg>['sql'];
  workspaceId: string;
  harnessSlug: string;
  planSlug: string;
  assertions: readonly PlanAssertion[];
}): Promise<{ written: number; errors: string[] }> {
  const { sql, workspaceId, harnessSlug, planSlug, assertions } = opts;
  let written = 0;
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const a of assertions) {
    // A VAL id is the upsert KEY (workspace_id, harness_slug, val_id), so two
    // assertions in one promote sharing an id do NOT produce two rows — the
    // second silently overwrites the first. The feature still carries VAL-x as
    // a claim, but the row behind it now describes a DIFFERENT claim. That is
    // worse than a missing row, because every reader resolves it successfully
    // and gets the wrong assertion. Refuse rather than write.
    //
    // P-002 enforces VAL-id uniqueness upstream at extraction; this is the
    // persistence-layer backstop for when that is bypassed or regresses.
    if (seen.has(a.valId)) {
      errors.push(
        `${a.valId}: duplicate VAL id within this plan — a second assertion reuses it, which would ` +
          `overwrite the first row rather than add one`,
      );
      continue;
    }
    seen.add(a.valId);
    try {
      await sql`
        INSERT INTO harness_shared.harness_plan_assertions
          (workspace_id, harness_slug, val_id, plan_slug, item_id, verify_text, evidence_text, status, requires_test)
        VALUES
          (${workspaceId}, ${harnessSlug}, ${a.valId}, ${planSlug}, ${a.itemId},
           ${a.verifyText}, ${a.evidenceText}, ${a.status}, ${a.requiresTest})
        ON CONFLICT (workspace_id, harness_slug, val_id) DO UPDATE SET
          plan_slug     = EXCLUDED.plan_slug,
          item_id       = EXCLUDED.item_id,
          verify_text   = EXCLUDED.verify_text,
          evidence_text = EXCLUDED.evidence_text,
          requires_test = EXCLUDED.requires_test,
          updated_at    = now()
      `;
      written++;
    } catch (e) {
      errors.push(`${a.valId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { written, errors };
}

export default defineTool({
  name: 'plans:promote',
  profile: 'engineer',
  description:
    "Promote a `plans:*` plan into a harness. Preview computes the per-feature covers mapping and lists assertions that would be extracted. Apply POSTs features to /features/import (server allocates F-AUTO-*), stores inline VAL-* assertions to harness_plan_assertions, and marks its from_items done. A wave declaring `spawn_child` is routed into a NEWLY-SPAWNED child harness instead (scaffold → auto-synthesized seed plan → import → start; preview reports the would-be child). Emits `plan_event` kind=promoted.",
  guidance: {
    when: 'A plan is ready to enter the harness — you and the human have settled the feature list and acceptance criteria.',
    notWhen:
      'Routine plan edits — plans:set-now / plans:add-item already cover those. Mid-debate — promote only once the design is settled. ' +
      'ANTI-OVER-SPAWN (D-001, promote-spawn-child-harness): a `spawn_child` wave is justified ONLY when the work crosses a repo/worktree boundary or needs its own lifecycle/done-definition — same-repo sub-work stays as plain features in the current harness (a child harness buys no extra parallelism, only overhead). When in doubt, do NOT spawn.',
    chaining:
      'spawn_child waves: re-run with apply:false first — the preview lists slug/seed/count, no side effects. A partially-failed spawn (`spawned_children[].warnings`) is retried by re-promoting (idempotent). ' +
      'Apply rewrites the plan doc (stale-CAS for any queued set-content) — reload plans:get first.',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  // The `promote` role's whole job IS to call this tool (wave-advance sweep →
  // invoke promote → plans:promote), so it must be in the allowlist alongside
  // the coordination roles.
  agentRoles: [...COORD_ROLES, 'promote'],
  args: z.object({
    slug: z.string().min(1).describe('Plan slug to promote.'),
    harness_slug: z
      .string()
      .min(1)
      .optional()
      .describe('Target harness slug. Optional in policy-mode — falls back to the `## Promote` target_harness.'),
    features: z
      .array(FEATURE_INPUT)
      .max(40)
      .optional()
      .describe('Explicit features. Omit + pass `wave` to derive them from the plan\'s `## Promote` policy.'),
    feature_ids: z
      .array(z.string().regex(/^F-[A-Za-z0-9-]+$/))
      .optional()
      .describe(
        'Optional caller-allocated F-NNN ids per feature. With apply=true and omitted ids, the server allocates F-AUTO-* and returns them.',
      ),
    apply: z
      .boolean()
      .optional()
      .default(false)
      .describe('When true, import features + store VAL-* assertions + mark plan items done. When false (default), preview-only.'),
    mark_items: z
      .boolean()
      .optional()
      .default(true)
      .describe('Apply-only: when true (default) flip each from_items item to status=done.'),
    wave: z
      .string()
      .optional()
      .describe('Promote-policy wave these features belong to — stamped on each feature (consolidated.wave) for the deterministic wave-drain advance.'),
    generate_items: z
      .array(z.string())
      .optional()
      .describe('Policy-mode: the runtime set a generative wave\'s `for_each` expands over (e.g. the discovered universal types).'),
    all_waves: z
      .boolean()
      .optional()
      .describe('Policy-mode (P-044): promote EVERY wave at once instead of one `wave`. Cross-wave ordering is written as feature `blocked_by` edges so the dispatch frontier sequences the waves — no wave-advance poll. Completion-time `for_each: { from_feature }` waves stay deferred (expand on publish). Mutually exclusive with `wave`.'),
    destructive: z
      .boolean()
      .optional()
      .default(false)
      .describe('DESTRUCTIVE replan: after the (additive) import, deprecate harness features minted from THIS plan (source_plan=slug) that the plan no longer declares, so the queue converges to exactly the plan\'s current set. Default false = today\'s additive re-promote. Matches existing features by feature id, so the plan must use stable ids (caller `feature_ids` or policy-assigned). Passed/in_progress work is NEVER auto-deprecated (reported instead) and an empty-plan wipe is refused — unless `force`.'),
    force: z
      .boolean()
      .optional()
      .default(false)
      .describe('Destructive-only: override both safety guards — (a) deprecate even passed/in_progress work the plan dropped, and (b) allow wiping the whole plan queue when the plan resolves to zero features.'),
  }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);

    // Resolve the source plan from the caller's concrete harness scope. The
    // target `harness_slug` is intentionally NOT reused here: a promote policy
    // may import features into a different harness from the one that owns the
    // plan. The bare read previously defaulted every call to operator-home,
    // making a plan that `plans:get` could read in a scoped session fail here
    // with `plan_not_found` (EI-21093090220973191 / recurring EI-103 class).
    const planFile = await readPlanBySlug(args.slug, await ctxToPlanSourceOpts(ctx));
    if (!planFile) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              error: 'plan_not_found',
              detail: `no plan with slug ${args.slug}`,
            }),
          },
        ],
        isError: true,
      };
    }
    // Thread the SAME resolved key through every later source-plan write. A
    // second resolution path can disagree on workspace or Hive-home collapse;
    // the row that satisfied the read is the authority for the write-back.
    const planScope = {
      workspaceId: planFile.row.workspaceId,
      harnessSlug: planFile.row.harnessSlug,
    };
    const planTitle =
      (planFile.parsed.frontmatter as { title?: string } | null)?.title ?? args.slug;

    // Resolve features / harness / wave — explicit (caller-supplied) or
    // policy-driven: when `features` is omitted and a `wave` is given, read the
    // plan's `## Promote` policy and build that wave's features (P-006).
    const fail = (error: string, detail?: string) => ({
      content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error, detail }) }],
      isError: true as const,
    });
    const { features: explicitFeatures, harness_slug: explicitHarness, wave: explicitWave } = args;
    let promoteFeatures: BuiltFeature[] = (explicitFeatures ?? []) as BuiltFeature[];
    let harnessSlug = explicitHarness;
    let waveId = explicitWave;
    // P-003 (promote-spawn-child-harness): per-child spawn config, captured while
    // resolving the policy waves (keyed by child slug; the policy superRefine
    // guarantees slug uniqueness across waves). Only policy-mode waves can carry
    // spawn_child — explicit caller features never do.
    const spawnChildConfigs = new Map<string, { child: SpawnChild; waveId: string }>();
    /** Cross-wave orderings dropped because one side is a spawn_child wave. */
    const spawnEdgeWarnings: string[] = [];
    if (promoteFeatures.length === 0) {
      // v2 P-001: read the structured promote-policy from the plan row (parsed once at write-time);
      // fall back to parsing the raw for a not-yet-repopulated row (null column, pre-mig-331 plans).
      const { policy, warnings } = planFile.row.promotePolicy ?? parsePromotePolicy(planFile.parsed.raw);
      if (!policy) {
        // WI-3972: lint's `missing_promoted_block` finding fires when a plan
        // ALREADY promoted feature(s) (rows in harness_features_consolidated
        // carrying this plan as source_plan_slug — e.g. promoted before the
        // `## Promoted` write-back existed, or the block was dropped/never
        // written for some other reason) but the body has no `## Promoted`
        // record. Its suggested remedy is a BARE `plans:promote apply=true`
        // call — no `features`/`wave`/`all_waves`. Without this branch that
        // bare call falls straight into the `no_promote_policy` failure below,
        // a catch-22: the tool's own suggested fix can never succeed, because
        // deriving NEW features from a policy is not what's needed here — the
        // features already exist, only the record of them is missing.
        //
        // So: when the caller supplied nothing to derive a new promotion from,
        // treat it as a backfill request first. If this plan already has
        // promoted features on record, just write/preview the `## Promoted`
        // block from them (no new import, no items marked, no assertions) —
        // only fall through to `no_promote_policy` when there is genuinely
        // nothing to promote AND nothing to backfill.
        if (!explicitWave && !args.all_waves) {
          const backfillResult = await backfillPromotedFromConsolidated({
            ctx,
            slug: args.slug,
            apply: args.apply === true,
            planTitle,
            planRaw: planFile.parsed.raw,
            planScope,
            fail,
          });
          if (backfillResult) return backfillResult;
        }
        return fail('no_promote_policy', `plan ${args.slug} has no valid \`## Promote\` policy${warnings.length ? ': ' + warnings.join('; ') : ''}`);
      }
      // The resolver's glob/sql need the target harness — resolve it first.
      harnessSlug = harnessSlug ?? policy.target_harness;
      if (args.all_waves) {
        // ── P-044 Path A: promote EVERY wave up front in ONE pass; cross-wave
        // ordering becomes feature-level blocked_by edges (applyInterWaveEdges),
        // so the P-042 frontier alone sequences the waves — no 30s wave-advance
        // poll. Completion-time (`from_feature`) waves stay deferred (expand on
        // publish); promote-time resolvers (items/glob/sql) resolve inline.
        // (harnessSlug is only needed when a generative resolver actually runs —
        // checked there — so a pure spawn_child plan needs no target_harness.)
        const builtByWave = new Map<string, BuiltFeature[]>();
        const deferred: string[] = [];
        for (const w of policy.waves) {
          let feats: BuiltFeature[];
          if (w.generate && isCompletionTimeForEach(w.generate.for_each)) {
            deferred.push(w.id);
            feats = buildWaveFeatures({ ...w, generate: undefined }, {}).features;
          } else {
            let items = args.generate_items;
            if (w.generate && isForEachResolver(w.generate.for_each)) {
              if (!harnessSlug) {
                return fail('harness_slug_required', `wave "${w.id}" has a for_each glob/sql resolver, which needs a target harness (set harness_slug or \`## Promote\` target_harness)`);
              }
              try {
                // P-012: `templateData` carries the plan's resolved inputs, which the
                // `from_input` kind fans out over. The start gate has already
                // guaranteed a declared-required input is present, so a wave reaching
                // here cannot be missing the field it fans out on.
                items = await resolveForEach(
                  w.generate.for_each,
                  buildForEachCtx(harnessSlug, ctx.workspaceId),
                  planFile.row.templateData,
                );
              } catch (e) {
                const code = e instanceof FanoutCapError ? 'for_each_fanout' : 'for_each_resolver_error';
                return fail(code, `wave "${w.id}": ${e instanceof Error ? e.message : String(e)}`);
              }
            }
            feats = buildWaveFeatures(w, { generateItems: items }).features;
          }
          for (const f of feats) f.wave = w.id;
          if (w.spawn_child) spawnChildConfigs.set(w.spawn_child.slug, { child: w.spawn_child, waveId: w.id });
          if (feats.length > 0) builtByWave.set(w.id, feats);
        }
        // P-003 (spawn_child): cross-wave feature edges can only bind features
        // that land in the SAME harness — a spawn_child wave's features live in
        // the child, where parent-batch titles don't resolve (and vice versa).
        // Exclude any edge into or out of a spawn wave; surface the dropped
        // ordering instead of letting the import's ref resolver fail the batch.
        const spawnWaveIds = new Set(policy.waves.filter((w) => w.spawn_child).map((w) => w.id));
        const edgeEligibleWaves = policy.waves.filter((w) => {
          if (!w.blocked_by) return true;
          if (spawnWaveIds.has(w.id) || spawnWaveIds.has(w.blocked_by)) {
            spawnEdgeWarnings.push(
              `wave "${w.id}" blocked_by "${w.blocked_by}": cross-harness wave ordering is not enforced for spawn_child waves (v1) — the dependency is dropped`,
            );
            return false;
          }
          return true;
        });
        applyInterWaveEdges(edgeEligibleWaves, builtByWave);
        promoteFeatures = [...builtByWave.values()].flat();
        if (promoteFeatures.length === 0) {
          return fail('empty_policy', `no promote-time features across all waves${deferred.length ? ` (deferred completion-time waves: ${deferred.join(', ')})` : ''}`);
        }
        waveId = undefined; // each feature carries its own `wave`; no single value
      } else {
        if (!waveId) return fail('promote_input', 'provide features[], a wave, or all_waves:true (policy-mode)');
        const w = policy.waves.find((x) => x.id === waveId);
        if (!w) return fail('unknown_wave', `wave "${waveId}" is not in the \`## Promote\` policy`);
        if (w.generate && isCompletionTimeForEach(w.generate.for_each)) {
          // P-043 / D-019: a COMPLETION-TIME wave (`for_each: { from_feature }`) is
          // NOT expanded at promote — it expands when its producing feature
          // publishes its items (generators:publish → children blocked_by it). Mint
          // only any STATIC features it also declares; a pure generative
          // completion-time wave promotes nothing now (deferred, not an error).
          const staticOnly = buildWaveFeatures({ ...w, generate: undefined }, {}).features;
          if (staticOnly.length === 0) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({
                    ok: true,
                    mode: 'deferred',
                    wave: waveId,
                    reason: `wave "${waveId}" is a completion-time generative wave (for_each.from_feature=${w.generate.for_each.from_feature}); it expands when that feature publishes via generators:publish — nothing promoted now`,
                  }),
                },
              ],
            };
          }
          for (const f of staticOnly) f.wave = w.id;
          if (w.spawn_child) spawnChildConfigs.set(w.spawn_child.slug, { child: w.spawn_child, waveId: w.id });
          promoteFeatures = staticOnly;
        } else {
          // P-043: a promote-time resolver (items/glob/sql) resolves the item-set by
          // QUERY now; else the agent passes `generate_items` (legacy named set). A
          // fan-out over the cap or a resolver failure escalates (the whole promote
          // fails loudly) rather than silently truncating/zeroing.
          let generateItems = args.generate_items;
          if (w.generate && isForEachResolver(w.generate.for_each)) {
            if (!harnessSlug) {
              return fail('harness_slug_required', 'a for_each glob/sql resolver needs a target harness (set harness_slug or target_harness)');
            }
            try {
              // P-012 — see the sibling call above.
              generateItems = await resolveForEach(
                w.generate.for_each,
                buildForEachCtx(harnessSlug, ctx.workspaceId),
                planFile.row.templateData,
              );
            } catch (e) {
              const code = e instanceof FanoutCapError ? 'for_each_fanout' : 'for_each_resolver_error';
              return fail(code, e instanceof Error ? e.message : String(e));
            }
          }
          const built = buildWaveFeatures(w, { generateItems });
          if (built.features.length === 0) {
            return fail('empty_wave', `wave "${waveId}" resolved to 0 features${built.warnings.length ? ': ' + built.warnings.join('; ') : ''}`);
          }
          for (const f of built.features) f.wave = w.id;
          if (w.spawn_child) spawnChildConfigs.set(w.spawn_child.slug, { child: w.spawn_child, waveId: w.id });
          promoteFeatures = built.features;
        }
      }
    }

    // ── spawn_child partition (P-003) ──────────────────────────────────────
    // Features stamped `spawn_child_slug` (by buildWaveFeatures) route into
    // their child harness; the rest follow the normal target-harness path. A
    // pure spawn promote (every wave spawns) needs no target harness at all.
    const parentFeatures: BuiltFeature[] = [];
    const childGroups = new Map<string, BuiltFeature[]>();
    for (const f of promoteFeatures) {
      if (f.spawn_child_slug) {
        const arr = childGroups.get(f.spawn_child_slug) ?? [];
        arr.push(f);
        childGroups.set(f.spawn_child_slug, arr);
      } else {
        parentFeatures.push(f);
      }
    }
    for (const slug of childGroups.keys()) {
      if (!spawnChildConfigs.has(slug)) {
        // Internal invariant: a spawn_child_slug stamp always pairs with a
        // captured wave config (both written in the same policy resolution).
        return fail('spawn_child_config_missing', `features carry spawn_child_slug=${slug} but no wave declared that child`);
      }
    }
    if (parentFeatures.length > 0 && !harnessSlug) {
      return fail('harness_slug_required', 'harness_slug is required (or set target_harness in the `## Promote` policy)');
    }
    const promoteDate = new Date().toISOString().slice(0, 10);

    // Validate every from_items P-NNN against the plan's actual items
    // (audit B2). A typo'd id would otherwise be silently dropped during
    // the mark step — the caller would believe it covered an item that
    // does not exist. Fail fast, in both preview and apply mode.
    const unknownItems = findUnknownFromItems(
      promoteFeatures,
      (planFile.parsed.items as Array<{ id: string }>).map((i) => i.id),
    );
    if (unknownItems.length > 0) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              error: 'unknown_plan_items',
              detail: `from_items references item id(s) not present in plan ${args.slug}: ${unknownItems.join(', ')}`,
              unknown_items: unknownItems,
            }),
          },
        ],
        isError: true,
      };
    }

    // P-002 — fail-closed gate on inline VAL-* assertions.
    //
    // Evaluated HERE, beside the other fail-fast validation, and deliberately
    // NOT next to the assertion extraction further down: the apply path spawns
    // child harnesses, seed plans and feature imports well BEFORE it reaches
    // that extraction, so a refusal placed there would fire after real writes
    // had already landed.
    //
    // Scoped to PARENT-bound items — the same set whose assertions promotion
    // actually stores. A spawned child's features carry assertions synthesized
    // into the child SEED plan instead (D-002), so requiring parent-plan VALs
    // for them would be a false refusal.
    const gateItemIds = new Set<string>();
    for (const f of parentFeatures) {
      for (const id of f.from_items ?? []) gateItemIds.add(id);
    }
    const assertionGate = evaluatePromotionAssertionGate({
      rawPlan: planFile.parsed.raw,
      planStatus: String(
        (planFile.parsed.frontmatter as { status?: string } | null)?.status ?? 'unknown',
      ),
      itemIds: gateItemIds,
    });
    if (args.apply && assertionGate.violations.length > 0) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              error: 'plan_assertions_fail_closed',
              detail:
                `promote refused: ${assertionGate.violations.length} validation-assertion ` +
                `violation(s) on plan ${args.slug}. A malformed VAL block is silently ` +
                `dropped from feature.claims, so promoting it would record the item as ` +
                `having nothing to prove. Fix the blocks below (or run with apply:false ` +
                `to review), then re-promote.`,
              lane: assertionGate.lane,
              violations: assertionGate.violations,
              items_missing_assertions: assertionGate.itemsMissingAssertions,
            }),
          },
        ],
        isError: true,
      };
    }

    // Preview path: emit plan event + return per-feature covers + assertion preview.
    if (!args.apply) {
      const previewItemIds = new Set<string>();
      for (const f of promoteFeatures) {
        for (const id of f.from_items ?? []) previewItemIds.add(id);
      }
      const previewAssertions = previewItemIds.size > 0
        ? extractAssertions(planFile.parsed.raw, previewItemIds)
        : [];

      // P-003: report what a spawn_child apply WOULD create — child slug, seed
      // plan slug, feature count — with zero side effects (reads only).
      const spawnChildrenPreview = await Promise.all(
        [...childGroups.entries()].map(async ([slug, feats]) => {
          const cfg = spawnChildConfigs.get(slug)!;
          let childExists = false;
          try {
            childExists = Boolean(await resolveProject(slug));
          } catch { /* unknown → false */ }
          return {
            child_slug: slug,
            seed_plan_slug: childSeedSlug(slug, promoteDate),
            feature_count: feats.length,
            wave: cfg.waveId,
            template: cfg.child.template ?? null,
            ...(cfg.child.repo && { repo: cfg.child.repo }),
            child_already_exists: childExists,
          };
        }),
      );

      const previewTarget = harnessSlug ?? '(spawned children only)';
      await emitPlanEventForCaller(ctx, {
        planSlug: args.slug,
        event: 'promoted',
        after: {
          harness_slug: harnessSlug ?? null,
          feature_count: promoteFeatures.length,
          assertion_count: previewAssertions.length,
          ...(spawnChildrenPreview.length > 0 && { spawn_children: spawnChildrenPreview.length }),
          mode: 'preview',
        },
        detail: `previewed promote to ${previewTarget}: ${promoteFeatures.length} feature(s), ${previewAssertions.length} assertion(s)${spawnChildrenPreview.length > 0 ? `, ${spawnChildrenPreview.length} spawned child(ren)` : ''}`,
      });

      // Destructive preview: report what a destructive apply WOULD deprecate
      // (read-only). Needs the plan's stable ids to diff — on apply those come
      // from importRes; in preview they must be supplied via `feature_ids`.
      let destructivePreview: DestructiveReplanOutcome | { note: string } | undefined;
      if (args.destructive && harnessSlug) {
        if (args.feature_ids && args.feature_ids.length > 0) {
          const dr = await runDestructiveReplan({
            harnessSlug,
            planSlug: args.slug,
            workspaceId: ctx.workspaceId ?? '',
            currentFeatureIds: args.feature_ids,
            force: args.force,
            apply: false,
          });
          destructivePreview = 'refuse' in dr ? { note: `would refuse: ${dr.refuse.detail}` } : dr.outcome;
        } else {
          destructivePreview = {
            note: 'destructive preview needs explicit feature_ids (the plan’s stable ids) to diff against existing features; apply diffs against the imported ids',
          };
        }
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              mode: 'preview',
              plan_title: planTitle,
              preview: {
                feature_count: promoteFeatures.length,
                assertion_count: previewAssertions.length,
                assertions: previewAssertions.map((a) => ({ val_id: a.valId, item_id: a.itemId, verify: a.verifyText })),
                // P-002: what the fail-closed gate would do on apply. `violations`
                // non-empty means an apply:true promote REFUSES. Surfaced in the
                // preview so the fix happens before the write, not after a refusal.
                assertion_gate: {
                  lane: assertionGate.lane,
                  enforcing: assertionGate.enforcing,
                  plan_has_adopted_assertions: assertionGate.planHasAdoptedAssertions,
                  would_refuse: assertionGate.violations.length > 0,
                  violations: assertionGate.violations,
                  warnings: assertionGate.warnings,
                  items_missing_assertions: assertionGate.itemsMissingAssertions,
                },
                ...(spawnChildrenPreview.length > 0 && { spawn_children: spawnChildrenPreview }),
                ...(spawnEdgeWarnings.length > 0 && { spawn_edge_warnings: spawnEdgeWarnings }),
              },
              apply_hint: {
                ...(harnessSlug && { features_import_endpoint: `/api/harness/${harnessSlug}/features/import` }),
                note: 'Re-call with apply=true to import features + store assertions + mark plan items.',
              },
              ...(destructivePreview && { destructive: destructivePreview }),
            }),
          },
        ],
      };
    }

    // ── spawn_child apply (P-003): scaffold → seed plan → import → start, per
    // child wave. The parent is SEALED from the promote CALLER's identity — a
    // harness-principal caller IS the parent; otherwise the plan's home harness
    // — never from the YAML body (mirrors execute-action's parent_slug sealing).
    // Every failure lands in the result's warnings[] (D-004) — never thrown.
    const spawnedChildren: SpawnChildResult[] = [];
    const spawnedBySlug = new Map<string, SpawnChildResult>();
    if (childGroups.size > 0) {
      let sealedParent: string | null = null;
      const principalSlug = (ctx as { principal?: { slug?: string } }).principal?.slug;
      if (principalSlug && !principalSlug.startsWith('system:')) {
        try {
          if (await resolveProject(principalSlug, ctx.workspaceId)) sealedParent = principalSlug;
        } catch { /* not a harness principal — fall through */ }
      }
      if (!sealedParent) sealedParent = planScope.harnessSlug;
      const spawnDeps = buildDefaultSpawnChildDeps({ importFeatures: postFeaturesImport });
      for (const [slug, feats] of childGroups) {
        const cfg = spawnChildConfigs.get(slug)!;
        const r = await executeSpawnChild(
          {
            child: cfg.child,
            waveId: cfg.waveId,
            parentSlug: sealedParent,
            parentPlanSlug: args.slug,
            features: feats,
            date: promoteDate,
          },
          spawnDeps,
        );
        spawnedChildren.push(r);
        spawnedBySlug.set(slug, r);
      }
    }

    // Extract inline VAL-* assertions before building the import payload so
    // claims can be included in the SQLite INSERT (the import endpoint only
    // sets claims on INSERT, not UPDATE, so they must arrive with the row).
    // Scoped to the PARENT-bound features: a spawned child's features carry
    // claims synthesized from the wave's acceptance into the child SEED plan
    // (D-002) — the parent plan's VAL store doesn't track them.
    const allItemIds = new Set<string>();
    for (const f of parentFeatures) {
      for (const id of f.from_items ?? []) allItemIds.add(id);
    }
    // assertions keyed by item_id for O(1) lookup during payload construction.
    const assertionsByItem = new Map<string, string[]>();
    const allAssertions = allItemIds.size > 0
      ? extractAssertions(planFile.parsed.raw, allItemIds)
      : [];
    for (const a of allAssertions) {
      const arr = assertionsByItem.get(a.itemId) ?? [];
      arr.push(a.valId);
      assertionsByItem.set(a.itemId, arr);
    }
    const phaseByItemId = new Map(
      planFile.parsed.items.map((item) => [item.id, item.phase ?? null]),
    );

    // POST features to /features/import. Server allocates F-AUTO-* ids.
    // metadata.source_plan + metadata.covers carry provenance forward.
    // claims is populated from extracted VAL-* assertions for this feature's items.
    const importPayload = parentFeatures.map((f, idx) => {
      const metadata: Record<string, unknown> = {
        source_plan: args.slug,
      };
      if (f.from_items && f.from_items.length > 0) {
        metadata.from_plan_items = f.from_items;
      }
      // Per-feature hints → metadata (kept for any metadata reader). blocked_by
      // + order are ALSO threaded as first-class import fields below (P-046), so
      // the import resolves blocked_by refs → canonical ids + cycle-detects.
      if (f.assigned_role) metadata.assigned_role = f.assigned_role;
      if (f.blocked_by && f.blocked_by.length > 0) metadata.blocked_by = f.blocked_by;
      if (f.order != null) metadata.order = f.order;
      // EI-8809 (routing-gate hint at dispatch): stamp a matched papercusp-way row
      // onto the promoted feature so the claimer sees the prescribed mechanism —
      // hint only, never a promote-blocking check.
      const routingHint = matchRoutingGateHint(f.title);
      if (routingHint) metadata.routingHint = routingHint;
      // P-043: stamp generative provenance on resolver-produced children (the
      // completion-time replay-dedup key + audit trail).
      if (f.generated) metadata.generated_by = { plan: args.slug, wave: f.wave ?? waveId ?? null };
      const featureClaims = (f.from_items ?? []).flatMap(
        (id) => assertionsByItem.get(id) ?? [],
      );
      const out: {
        title: string;
        summary?: string;
        metadata: Record<string, unknown>;
        id?: string;
        claims?: string[];
        source_plan_slug: string;
        source_plan_item_ids: string[];
        wave?: string;
        needs_2_machine_rig?: boolean;
        blocked_by?: string[];
        order?: number;
      } = {
        title: f.title,
        metadata,
        source_plan_slug: args.slug,
        source_plan_item_ids: f.from_items ?? [],
        ...(f.from_items && f.from_items.length > 0 && {
          needs_2_machine_rig: f.from_items.some((itemId) =>
            phaseRequiresTwoMachineRig(phaseByItemId.get(itemId)),
          ),
        }),
        ...(featureClaims.length > 0 && { claims: featureClaims }),
        ...((f.wave ?? waveId) && { wave: f.wave ?? waveId }),
        ...(f.blocked_by && f.blocked_by.length > 0 && { blocked_by: f.blocked_by }),
        ...(f.order != null && { order: f.order }),
      };
      if (f.body) out.summary = f.body;
      if (args.feature_ids && args.feature_ids[idx]) {
        out.id = args.feature_ids[idx];
      }
      return out;
    });
    // P-003 (llm-agent-evaluation-measurement-integrity-2026-08-25, D-002/D-005):
    // persist assertion rows BEFORE the feature import, and FAIL CLOSED if they
    // cannot be persisted.
    //
    // Features and assertions live in two DIFFERENT datastores — features in the
    // target harness DB (written by /features/import below), assertion rows in
    // operator PG — so no single transaction spans both and ORDERING is the only
    // integrity boundary available. Importing first (the previous behaviour, whose
    // assertion write was explicitly best-effort) made the failure mode DANGLING
    // CLAIMS: a feature durably carrying VAL-* ids with no assertion row, written
    // silently, because a swallowed PG error still left the import committed. Every
    // reader of harness_plan_assertions then under-reports with nothing failing
    // loudly — /assertion/:valId resolves nothing, harness-test-gate cannot approve
    // a required test, and plans:get planItemTests / testing.ts coverage joins miss
    // the row entirely.
    //
    // Persisting first inverts that into ORPHAN ASSERTION ROWS when a later step
    // fails: benign, idempotent (the upsert is ON CONFLICT DO UPDATE), invisible to
    // every reader above because no feature references them, and self-healing on the
    // next promote of the same plan.
    let assertionsWritten = 0;
    let assertionErrors: string[] = [];
    if (allAssertions.length > 0 && harnessSlug) {
      try {
        const { sql } = getOrgPg();
        const stored = await persistPlanAssertions({
          sql,
          workspaceId: ctx.workspaceId ?? '',
          harnessSlug,
          planSlug: args.slug,
          assertions: allAssertions,
        });
        assertionsWritten = stored.written;
        assertionErrors = stored.errors;
      } catch (e) {
        // getOrgPg() itself failed — there is no store to write to at all, so every
        // assertion is unpersisted. Surfaced as an error (not a warning) so the
        // refusal below fires: this is the case where EVERY claim would dangle.
        assertionErrors = [e instanceof Error ? e.message : String(e)];
        ctx.log?.(`[plans:promote] assertion PG store unavailable: ${assertionErrors[0]}`);
      }
    }
    // Refuse BEFORE any feature is imported. Nothing has been written to the target
    // harness yet, so this leaves no partial promotion to reconcile — the caller can
    // re-run the identical promote once PG is reachable and the upsert re-converges.
    if (assertionErrors.length > 0) {
      return fail(
        'assertion_store_failed',
        `${assertionErrors.length} of ${allAssertions.length} inline VAL-* assertion(s) could not be persisted to ` +
          `harness_shared.harness_plan_assertions, so features carrying them as claims were NOT imported ` +
          `(refusing rather than promoting claim ids with no assertion row). Re-run this promote once the ` +
          `store is reachable; the upsert is idempotent. Errors: ${assertionErrors.join('; ')}`,
      );
    }

    // A pure spawn_child promote has no parent-bound features — skip the
    // target-harness import entirely (harnessSlug may legitimately be unset).
    const importRes =
      importPayload.length > 0 && harnessSlug
        ? await postFeaturesImport(harnessSlug, importPayload)
        : { ids: [] as string[], inserted: 0, updated: 0 };

    // Destructive replan: the import above is additive; now converge the harness
    // to the plan's CURRENT set by deprecating features it dropped (source_plan=
    // slug, no longer in importRes.ids). Fail closed on an empty-plan wipe.
    let destructive: DestructiveReplanOutcome | undefined;
    if (args.destructive && harnessSlug) {
      const dr = await runDestructiveReplan({
        harnessSlug,
        planSlug: args.slug,
        workspaceId: ctx.workspaceId ?? '',
        currentFeatureIds: importRes.ids,
        force: args.force,
        apply: true,
      });
      if ('refuse' in dr) return fail(dr.refuse.code, dr.refuse.detail);
      destructive = dr.outcome;
    }

    // Mark plan items as done via withPlanLock + flipStatusInBody. Also covers
    // child-routed features whose spawn actually imported (P-004: the parent's
    // items are done — the sub-work now lives in the child) — but NOT a
    // failed/aborted spawn's items (nothing covers those yet; retry will).
    const allFromItems = new Set<string>(allItemIds);
    for (const [slug, feats] of childGroups) {
      const spawned = spawnedBySlug.get(slug);
      if (!spawned || spawned.feature_ids.length === 0) continue;
      for (const f of feats) {
        for (const id of f.from_items ?? []) allFromItems.add(id);
      }
    }
    const markedItems: string[] = [];
    const skippedItems: Array<{ id: string; reason: string }> = [];
    if (args.mark_items && allFromItems.size > 0) {
      const revision = planRevisionCapture(
        ctx as PlanRevisionCtx,
        args.slug,
        `plans:promote → mark ${allFromItems.size} item(s) as done`,
        planScope,
      );
      const result = await withPlanLock<
        { ok: true; marked: number } | { ok: false; code: 'not_found' }
      >(
        ctx as never,
        {
          slug: args.slug,
          intent: `plans:promote → mark ${allFromItems.size} item(s) as done`,
          ...planScope,
          afterWrite: revision.afterWrite,
        },
        async (current) => {
          if (current === null) {
            return { newBody: null, value: { ok: false as const, code: 'not_found' as const } };
          }
          let body = current;
          for (const itemId of allFromItems) {
            const { newBody, found } = flipStatusInBody(body, itemId, 'done');
            if (found) {
              body = newBody;
              markedItems.push(itemId);
            } else {
              skippedItems.push({ id: itemId, reason: 'item_not_found' });
            }
          }
          if (markedItems.length === 0) {
            return { newBody: null, value: { ok: true as const, marked: 0 } };
          }
          return { newBody: bumpUpdatedDate(body), value: { ok: true as const, marked: markedItems.length } };
        },
      );
      if (result.kind === 'busy') {
        // Plan was locked. Record but don't fail the overall apply — spec + features
        // already landed. Caller can retry the mark step manually.
        for (const id of allFromItems) {
          if (!markedItems.includes(id)) {
            skippedItems.push({ id, reason: 'plan_locked' });
          }
        }
      }
    }

    // Query consolidated for THIS plan's full feature set, post-import.
    // Used to refresh the ## Now promote-status line with live counts.
    // Best-effort: failure here is non-fatal — the ## Promoted block
    // write proceeds regardless.
    let statusCounts: { total: number; inflight: number; passed: number } | null = null;
    let waveSummaries: WaveSummary[] | undefined;
    if (harnessSlug) try {
      const { sql } = getOrgPg();
      // P-041: scope to the caller's workspace (already used for the assertion
      // write above). The admin handle bypasses RLS, and post-091 neither
      // source_plan_slug nor harness_slug is globally unique, so without this
      // the status counts fold in a colliding workspace's features.
      // P-013: also read `wave` so we can emit per-wave progress lines.
      const rows = await sql<{ status: string; wave: string | null }[]>`
        SELECT status, wave FROM harness_shared.harness_features_consolidated
         WHERE workspace_id     = ${ctx.workspaceId ?? ''}
           AND source_plan_slug = ${args.slug}
           AND harness_slug     = ${harnessSlug}
      `;
      let passed = 0;
      let inflight = 0;
      // work-item-status-full-unify P-007: the success terminal is the unified `done`
      // (feature `passed`→`done`, nuance in terminal_reason). Count BOTH spellings so a
      // post-backfill `done` feature isn't miscounted as still-inflight.
      const isPassed = (s: string) => s === 'passed' || s === 'done';
      for (const r of rows) {
        if (isPassed(r.status)) passed++;
        else inflight++;
      }
      statusCounts = { total: rows.length, inflight, passed };

      // P-013: group by wave for the per-wave breakdown.
      const waveMap = new Map<string, WaveSummary>();
      for (const r of rows) {
        const w = r.wave ?? '(no wave)';
        if (!waveMap.has(w)) {
          waveMap.set(w, { wave: w, total: 0, passed: 0, inflight: 0, blocked: 0, failing: 0 });
        }
        const ws = waveMap.get(w)!;
        ws.total += 1;
        const s = r.status;
        if (isPassed(s)) ws.passed += 1;
        else if (s === 'failing') { ws.failing += 1; ws.inflight += 1; }
        else if (s === 'blocked') { ws.blocked += 1; }
        else ws.inflight += 1;
      }
      if (waveMap.size > 0) waveSummaries = Array.from(waveMap.values());
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      ctx.log?.(`[plans:promote] status-count query failed (status line skipped): ${msg}`);
    }

    // Write-back: stamp ## Promoted block + refresh ## Now promote-status line.
    // Item-level idempotent: parse existing block, append only new feature IDs.
    // Status line is marker-delimited so re-promote replaces in place.
    //
    // R2-B: also flip `status: draft` → `status: active` in the frontmatter.
    // A promote turns a "proposal" (draft) into an "active work plan"; the
    // ProposalsPanel filters drafts only, so this is what makes the card
    // disappear from the panel after Accept. Idempotent: a plan that's
    // already `active`/`shipped`/`superseded` is left alone.
    // P-004 (spawn_child): the parent plan's `## Promoted` block records the
    // child-routed rows too, annotated `→ spawned child <slug> (plan <seed>)` —
    // skipped for a child whose import didn't land (a retry promotes the rows).
    const promotedRowFeatures: PromotedRowFeature[] = [...parentFeatures];
    const promotedRowIds: string[] = [...importRes.ids];
    for (const [slug, feats] of childGroups) {
      const spawned = spawnedBySlug.get(slug);
      if (!spawned || spawned.feature_ids.length !== feats.length) continue;
      feats.forEach((f, i) => {
        promotedRowFeatures.push({ ...f, spawned_child: { slug, seedSlug: spawned.seed_plan_slug } });
        promotedRowIds.push(spawned.feature_ids[i]);
      });
    }

    const revision = planRevisionCapture(
      ctx as PlanRevisionCtx,
      args.slug,
      'plans:promote → write ## Promoted block + Now status + activate',
      planScope,
    );
    await withPlanLock<null>(
      ctx as never,
      {
        slug: args.slug,
        intent: 'plans:promote → write ## Promoted block + Now status + activate',
        ...planScope,
        afterWrite: revision.afterWrite,
      },
      async (current): Promise<{ newBody: string | null; value: null }> => {
        if (current === null) return { newBody: null, value: null };
        // P-041: record the REALIZED wave/parallelism structure (wave/order/
        // blocked_by) the promoting agent emitted, not just the bare id+title.
        const featureRows = buildPromotedRows(promotedRowFeatures, promotedRowIds, waveId);
        let newBody = upsertPromotedBlock(current, featureRows);
        if (statusCounts && harnessSlug) {
          newBody = upsertPromoteStatusLine(newBody, harnessSlug, statusCounts, waveSummaries);
        }
        // Promote-on-draft: flip status to active. Only the literal
        // `status: draft` line in frontmatter is rewritten — does not
        // touch any draft-shaped text in the body.
        newBody = newBody.replace(/^(status:\s*)draft\b/m, '$1active');
        return { newBody: bumpUpdatedDate(newBody), value: null };
      },
    );

    const spawnSummary = spawnedChildren.map((c) => ({
      child_slug: c.child_slug,
      seed_plan_slug: c.seed_plan_slug,
      feature_ids: c.feature_ids,
      started: c.started,
      // P-071/D-063: `started:false` alone cannot be read — 'axis_retired' (the
      // normal outcome now) and 'plan_not_found' (a real partial failure) are
      // both falsy and want opposite reactions.
      start: c.start,
    }));
    await emitPlanEventForCaller(ctx, {
      planSlug: args.slug,
      event: 'promoted',
      after: {
        harness_slug: harnessSlug ?? null,
        feature_count: promoteFeatures.length,
        feature_ids: importRes.ids,
        marked_items: markedItems,
        ...(spawnedChildren.length > 0 && { spawned_children: spawnSummary }),
        mode: 'apply',
      },
      detail:
        `applied promote to ${harnessSlug ?? '(spawned children only)'}: ${parentFeatures.length} feature(s) → ids [${importRes.ids.join(', ')}], ${markedItems.length} item(s) marked done` +
        (spawnedChildren.length > 0
          ? `; spawned ${spawnedChildren.length} child(ren): ${spawnedChildren.map((c) => `${c.child_slug} (plan ${c.seed_plan_slug}, ${c.feature_ids.length} feature(s)${describeSpawnStart(c.start)})`).join(', ')}`
          : ''),
    });

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            mode: 'apply',
            plan_title: planTitle,
            applied: {
              feature_ids: importRes.ids,
              features_inserted: importRes.inserted,
              features_updated: importRes.updated,
              marked_items: markedItems,
              skipped_items: skippedItems,
              assertions_written: assertionsWritten,
              ...(spawnedChildren.length > 0 && {
                spawned_children: spawnedChildren,
                ...((spawnedChildren.some((c) => c.warnings.length > 0) || spawnEdgeWarnings.length > 0) && {
                  warnings: [...spawnEdgeWarnings, ...spawnedChildren.flatMap((c) => c.warnings)],
                }),
              }),
              ...(assertionErrors.length > 0 && { assertion_errors: assertionErrors }),
              ...(importRes.provenanceFailed != null && importRes.provenanceFailed > 0 && {
                provenance_failed: importRes.provenanceFailed,
                provenance_errors: importRes.provenanceErrors ?? [],
              }),
              ...(destructive && {
                destructive: {
                  deprecated: destructive.deprecated ?? [],
                  protected_from_deprecation: destructive.protectedFromDeprecation,
                  ...(destructive.deprecateErrors && destructive.deprecateErrors.length > 0 && {
                    deprecate_errors: destructive.deprecateErrors,
                  }),
                },
              }),
            },
          }),
        },
      ],
    };
  },
});
