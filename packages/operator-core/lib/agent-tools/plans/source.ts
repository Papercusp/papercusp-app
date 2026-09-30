/**
 * PG-canonical source for plans.
 *
 * Plans live in `harness_shared.harness_plans` — one row per plan, keyed by
 * (workspace_id, harness_slug, plan_slug). The `content` column holds the
 * canonical markdown blob; reads parse it into a `ParsedPlan` exactly as the
 * old filesystem reader did, so every downstream consumer (items/list/search/
 * effective-status) is unchanged. The frontmatter + op_* columns are a derived
 * index maintained on write.
 *
 * Plan: plans-pg-canonical-migration-2026-06-03 (Stage 1 — reads/writes flip
 * FS→PG). The filesystem at apps/operator/docs/plans/ is retired in Stage 2.
 *
 * The dir-resolution helpers (getRepoRoot / resolveHarnessPlansDir) survive as
 * SLUG/HARNESS VALIDATORS + repo-root resolvers (a launched plan agent still
 * `cd`s into the repo root); they no longer read plan bytes.
 */

import * as fs from 'node:fs/promises';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import * as path from 'node:path';
import { parsePlan, type ParsedPlan, type PlanItem } from './parser';
import type { PlanIndexItem, PlanIndexDecision } from './derive-index';
import { hashPlanContent } from './content-hash';
import { summarizeForcedPast, type ForcedPastSummary } from './forced-past-stamp';
import type { ParsePromoteResult } from './promote-policy';
import type { Sql } from 'postgres';
import { withWorkspace } from '@papercusp/db-org';
import { DEFAULT_WORKSPACE_ID } from '../../workspace-registry';
import { loadHarnessRegistry } from '../../harness-registry';
import {
  resolveProject,
  resolveWorkspaceForHarnessSlug,
  RegistryReadUnavailableError,
} from '../../harness-core';
import { detectPapercupRoot } from '../../harness/register-papercusp';
import { canonicalHarnessSlug, operatorHomeHarnessSlug } from '../../harness/operator-home-harness';
import { PAPERCUSP_WORKSPACE_ID } from '../../harness/papercusp-workspace';
import { potHomeSlugForHarness } from '../../hive-federation';
import { isTerminalItemStatus } from '../../fleet-drained-events';
import type { AgenticPlanExecutionTarget } from '../../agentic-plan-execution-target';
import type { BlueprintOperationRoutineTarget } from '../../harness/routines/materialize-plan-schedule';
import { BLENDER_PLAN_SQL_PATTERN } from './plan-provenance';
import { activeAcceptanceRubricsQuery } from './plan-lifecycle-derivation';

export const PLANS_DIR_REL = 'apps/operator/docs/plans';
export const ARCHIVE_DIR_REL = 'apps/operator/docs/plans/archive';

const PAPERCUP_PLANS_REL = 'apps/operator/docs/plans';
const DEFAULT_HARNESS_PLANS_REL = 'docs/plans';

/**
 * Normalize a path for a same-directory comparison, resolving symlinks.
 *
 * `path.resolve` is string-only (it never touches the filesystem), so it
 * treats a symlink and its target as DIFFERENT paths — and the canonical
 * checkout is reachable via a `papercup` symlink → `papercusp`, so two
 * strings naming the SAME directory compare unequal. `fs.realpathSync`
 * collapses the symlink, so the two forms match. Falls back to
 * `path.resolve` when the path doesn't exist yet (realpath throws ENOENT),
 * wrapped so a missing dir never crashes the caller (mirrors
 * `realpathOrSelf` in file-lock-authority-wiring.ts).
 */
function realpathOrResolve(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * Return true when two distinct paths are the canonical checkout and one of its
 * linked worktrees. The staging operator runs from `papercusp-staging`, while
 * the harness registry intentionally names the canonical `papercusp` checkout;
 * treating that supported topology as registry drift blocks fleet launches.
 *
 * This is deliberately narrower than accepting sibling paths by name: the
 * detected path must carry Git's worktree pointer, its gitdir must live below
 * the canonical repository's `.git/worktrees`, and its `commondir` must resolve
 * to that canonical `.git` directory. Unrelated checkouts therefore continue
 * to fail the P-014 guard.
 */
function isLinkedWorktreeOf(worktreePath: string, canonicalPath: string): boolean {
  const canonicalRoot = realpathOrResolve(canonicalPath);
  const worktreeRoot = realpathOrResolve(worktreePath);
  if (canonicalRoot === worktreeRoot) return false;

  try {
    const dotGit = readFileSync(path.join(worktreeRoot, '.git'), 'utf8').trim();
    const gitdir = /^gitdir:\s*(.+)$/.exec(dotGit)?.[1]?.trim();
    if (!gitdir || /[\r\n]/.test(gitdir)) return false;

    const gitDir = path.resolve(worktreeRoot, gitdir);
    const commonDirText = readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim();
    if (!commonDirText || /[\r\n]/.test(commonDirText)) return false;

    const commonDir = realpathOrResolve(path.resolve(gitDir, commonDirText));
    const canonicalGitDir = realpathOrResolve(path.join(canonicalRoot, '.git'));
    const worktreeRelative = path.relative(commonDir, realpathOrResolve(gitDir));
    return (
      commonDir === canonicalGitDir &&
      worktreeRelative !== '' &&
      !worktreeRelative.startsWith('..' + path.sep) &&
      !path.isAbsolute(worktreeRelative) &&
      worktreeRelative.split(path.sep)[0] === 'worktrees'
    );
  } catch {
    return false;
  }
}

function samePapercupCheckout(left: string, right: string): boolean {
  return (
    realpathOrResolve(left) === realpathOrResolve(right) ||
    isLinkedWorktreeOf(left, right) ||
    isLinkedWorktreeOf(right, left)
  );
}

function plansRelFor(harnessPath: string): string {
  const detected = detectPapercupRoot();
  if (detected && samePapercupCheckout(harnessPath, detected)) {
    return PAPERCUP_PLANS_REL;
  }
  return DEFAULT_HARNESS_PLANS_REL;
}

/**
 * Options threading the (workspace, harness) PG key through the read API.
 * `harnessSlug` is the only field consumers need; `workspaceId` is resolved
 * from the registry when omitted. The legacy filesystem override fields
 * (`plansDir` / `archiveDir` / `repoRoot`) are accepted-but-ignored so the
 * ~handful of historical call sites that still pass them keep compiling
 * through the Stage-2 cleanup.
 */
export interface PlanSourceOpts {
  /** plans:get reuses this signal in lifecycle derivation without another transaction. */
  prefetchAcceptance?: boolean;
  /** Harness whose plans to read. Omitted / '*' / 'all' → papercup primary. */
  harnessSlug?: string;
  /** Workspace the plans live in. Omitted → resolved from the registry / DEFAULT. */
  workspaceId?: string;
  /** @deprecated filesystem override — ignored under PG-canonical storage. */
  plansDir?: string;
  /** @deprecated filesystem override — ignored under PG-canonical storage. */
  archiveDir?: string;
  /** @deprecated filesystem override — ignored under PG-canonical storage. */
  repoRoot?: string;
}

/** A raw harness_plans row (camelCased), for callers needing version / op_* state. */
/**
 * The authored schedule of a scheduled/recurring plan (scheduled-recurring-plans-2026-06-16
 * D-004). Stored in the `schedule` jsonb column; NULL ⇒ the plan is not scheduled. The
 * recurrence SET is RRULE-native (rrule + rdate + exdate, anchored on dtstart/tzid); `cron`
 * is an alternate input dialect. The engine computes next_fire_at directly from this — it is
 * never converted to cron.
 */
export interface PlanSchedule {
  kind: 'rrule' | 'cron';
  rrule?: string;
  dtstart?: string;
  tzid?: string;
  rdate?: string[];
  exdate?: string[];
  cron?: string;
  concurrency?: 'queue' | 'skip' | 'cancel-prev';
  catchup?: 'skip-old' | 'run-all-backlog';
  // EI-1388: `carryState` (stateful watch — seed each run with the prior run's
  // deliverable, D-007) was accepted + stored here but runScheduledPlanFire
  // (plan-run-action.ts) never read it — enabling it silently did nothing. Removed
  // rather than implemented: "the prior run's deliverable" needs a real design
  // decision (which artifact, how it's injected into the new instance) that a
  // backlog-drain pass shouldn't guess at; a no-op option that looks like it works
  // is worse than no option. Re-add + wire into runScheduledPlanFire if/when that
  // design lands.
  costCapCents?: number;
  /**
   * The frontier item_kind each run mints (D-006/P-009). Default 'feature' (coding
   * spine). Validated against the feature-family kinds at author time (plans:set-schedule).
   */
  executorKind?: 'feature' | 'chunk';
  /** Optional direct-execution target for agentic app plan templates. */
  execution?: AgenticPlanExecutionTarget;
  /** Optional registered operation fired by this cadence instead of legacy system:plan-run. */
  operation?: BlueprintOperationRoutineTarget;
}

export interface PlanRow {
  /** Undefined = not prefetched; null = measured absence in the source snapshot. */
  activeAcceptanceRubricRef?: string | null;
  workspaceId: string;
  harnessSlug: string;
  planSlug: string;
  content: string;
  contentHash: string;
  version: number;
  title: string | null;
  status: string | null;
  created: string | null;
  updated: string | null;
  owner: string | null;
  /** P-015 free-text initiative grouping label (frontmatter-derived). */
  initiative: string | null;
  /** Template TYPE a plan conforms to (plan-templates-and-rubric-v2 P-004/P-005) —
   *  a code-registry zod schema name (e.g. 'rubric'); frontmatter-derived (mirrors
   *  `initiative`), null for ordinary plans. Distinct from `templateSlug` (the
   *  scheduled-instance back-pointer). */
  template: string | null;
  /** Per-plan structured template instance data (jsonb), validated against the
   *  template's registry zod schema on write (plans:set-template-data, P-005);
   *  null until set, never parsed from frontmatter. When the plan declares an
   *  `inputSchema` instead of a `template`, THIS is where its input VALUES live —
   *  one value slot, two possible schema sources (plan-structured-inputs D-002). */
  templateData: unknown;
  /** The plan's own JSON Schema for its inputs (jsonb, mig 714 — plans:set-input-schema).
   *  The runtime-authored alternative to a code-registry `template` type, and MUTUALLY
   *  EXCLUSIVE with it (D-002/D-008 Q3). Its `required` array is what the start gate
   *  checks `templateData` against. Null ⇒ the plan declares no inputs. */
  inputSchema: unknown;
  /** The plan's own JSON Schema for what it PRODUCES (jsonb, mig 908 —
   *  plans:set-output-schema, P-026/D-017). The symmetric half of `inputSchema`:
   *  that one says what a run must be GIVEN, this one what a completing run
   *  PUBLISHES, so a chain edge can carry an upstream plan's product into a
   *  downstream step's declared inputs (D-015). Unlike `inputSchema` it does NOT
   *  conflict with a code-registry `template` type — `template` describes
   *  arguments, not product, so there is no second source to arbitrate.
   *  Null ⇒ the plan declares no outputs, which is a valid terminal-only plan
   *  and the default for the entire existing corpus (D-017: outputs are optional). */
  outputSchema: unknown;
  /** LIST-only cheap presence projection. `inputSchema` is deliberately omitted
   *  from hot index reads, but plans:list still needs to derive whether a manual
   *  trigger exists without detoasting the schema JSON. */
  hasInputSchema?: boolean;
  /** LIST-only derived relation: at least one installed external-event binding
   *  launches this plan. Presence, not armed state, defines the trigger facet. */
  hasExternalTrigger?: boolean;
  /** LIST-only canonical provenance projection from the plan content marker. */
  isBlenderOrigin?: boolean;
  supersedes: string[];
  supersededBy: string | null;
  opStatus: 'started' | 'paused' | 'done' | null;
  opStartedAt: string | null;
  opUpdatedAt: string | null;
  currentWave: string | null;
  opPriority: number | null;
  archived: boolean;
  isLegacy: boolean;
  updatedAt: string;
  // Stage-3 structured derived index (may be empty for un-normalized rows).
  items: PlanIndexItem[];
  decisions: PlanIndexDecision[];
  nowState: string | null;
  nowNext: string | null;
  /** v2 P-001: the parsed `## Promote` policy ({ policy, warnings }); NULL when the row hasn't been
   *  repopulated since mig 331 (consumers fall back to parsing content until the next write). */
  promotePolicy: ParsePromoteResult | null;
  /** Bounded projection of the append-only acceptance-waiver log. The markdown
   *  content remains canonical; this is the cheap permanent read marker. */
  forcedPast: ForcedPastSummary | null;
  // Scheduled/recurring plans (scheduled-recurring-plans-2026-06-16, mig 299).
  /** Authored recurrence set + policy; NULL ⇒ not scheduled (D-004). */
  schedule: PlanSchedule | null;
  /** Armed/active — false until armed via the autonomy-governed flow (D-010). */
  scheduleActive: boolean;
  /** One-shot fire time (drag-onto-a-day); NULL for pure recurrence/unscheduled (D-004). */
  scheduledAt: string | null;
  /** Recurrence end / deadline; on expiry the schedule deactivates (D-004). */
  expiresAt: string | null;
  /** Per-plan timezone for calendar-time recurrence; NULL ⇒ workspace/user default (D-013). */
  tzid: string | null;
  /** Instance→template back-pointer (Option C, D-003); NULL for templates + ordinary plans. */
  templateSlug: string | null;
  /** Run ordinal for an instance plan (D-003). */
  runSeq: number | null;
}

interface PlanDbRow {
  active_acceptance_rubric_ref?: string | null;
  workspace_id: string;
  harness_slug: string;
  plan_slug: string;
  content: string;
  content_hash: string;
  version: string | number;
  title: string | null;
  status: string | null;
  created: string | null;
  updated: string | null;
  owner: string | null;
  initiative: string | null;
  template: string | null;
  template_data: unknown;
  input_schema: unknown;
  /** mig 908 (P-026/D-017). OPTIONAL on the DB row on purpose: only the
   *  single-plan read (getPlanRow) projects it, so every LIST/aggregate path that
   *  deliberately omits it keeps typechecking and maps to `outputSchema: null` —
   *  the same shape those paths already use for `input_schema`. */
  output_schema?: unknown;
  has_input_schema?: boolean;
  has_external_trigger?: boolean;
  is_blender_origin?: boolean;
  supersedes: string[] | null;
  superseded_by: string | null;
  op_status: string | null;
  op_started_at: string | null;
  op_updated_at: string | null;
  current_wave: string | null;
  op_priority: number | null;
  archived: boolean;
  is_legacy: boolean;
  updated_at: string;
  items: unknown;
  decisions: unknown;
  now_state: string | null;
  now_next: string | null;
  promote_policy: unknown;
  forced_past?: unknown;
  schedule: unknown;
  schedule_active: boolean;
  scheduled_at: string | null;
  expires_at: string | null;
  tzid: string | null;
  template_slug: string | null;
  run_seq: number | null;
}

function rowFromDb(r: PlanDbRow): PlanRow {
  return {
    ...('active_acceptance_rubric_ref' in r
      ? { activeAcceptanceRubricRef: r.active_acceptance_rubric_ref }
      : {}),
    workspaceId: r.workspace_id,
    harnessSlug: r.harness_slug,
    planSlug: r.plan_slug,
    content: r.content,
    contentHash: r.content_hash,
    version: Number(r.version),
    title: r.title,
    status: r.status,
    created: r.created,
    updated: r.updated,
    owner: r.owner,
    initiative: r.initiative,
    template: r.template ?? null,
    templateData: r.template_data ?? null,
    inputSchema: r.input_schema ?? null,
    outputSchema: r.output_schema ?? null,
    hasInputSchema: r.has_input_schema ?? r.input_schema != null,
    hasExternalTrigger: r.has_external_trigger,
    isBlenderOrigin: r.is_blender_origin,
    supersedes: r.supersedes ?? [],
    supersededBy: r.superseded_by,
    opStatus: (r.op_status as PlanRow['opStatus']) ?? null,
    opStartedAt: r.op_started_at,
    opUpdatedAt: r.op_updated_at,
    currentWave: r.current_wave,
    opPriority: r.op_priority,
    archived: r.archived,
    isLegacy: r.is_legacy,
    updatedAt: r.updated_at,
    items: Array.isArray(r.items) ? (r.items as PlanIndexItem[]) : [],
    decisions: Array.isArray(r.decisions) ? (r.decisions as PlanIndexDecision[]) : [],
    nowState: r.now_state,
    nowNext: r.now_next,
    // v2 P-001: surface the structured promote-policy; null when the column hasn't been repopulated
    // (the row predates mig 331's lazy-populate) → consumers fall back to parsing content.
    promotePolicy: (r.promote_policy as ParsePromoteResult | null) ?? null,
    // A null/missing projection can occur on a pre-861 row or an older federated
    // op. Full-row reads have content available, so self-heal from the canonical
    // log; index-only list reads pass content='' and stay null until backfilled.
    forcedPast:
      (r.forced_past as ForcedPastSummary | null | undefined) ??
      summarizeForcedPast(r.content),
    schedule: (r.schedule as PlanSchedule | null) ?? null,
    scheduleActive: r.schedule_active ?? false,
    scheduledAt: r.scheduled_at,
    expiresAt: r.expires_at,
    tzid: r.tzid,
    templateSlug: r.template_slug,
    runSeq: r.run_seq,
  };
}

/**
 * True for the harness slugs that resolve to the operator-home harness:
 * the empty / unset case, the SU wildcards `'*'` / `'all'`, and the literal
 * operator-home slug. Shared by `fill_workspace_id_from_projects` and
 * `resolvePlanScope` so the "this is the operator home" predicate is defined once.
 */
function isOperatorHomeScope(raw: string | undefined): boolean {
  const canonical = raw ? canonicalHarnessSlug(raw) : raw;
  return !canonical || canonical === '*' || canonical === 'all' || canonical === operatorHomeHarnessSlug();
}

/** Injectable seam for the projects-table lookup — overridden in unit tests
 *  so the slug→workspace resolution is exercised without a live PG. Returns
 *  the DISTINCT set of workspace_ids that carry the slug. */
export type ProjectsWorkspaceLookup = (slug: string) => Promise<string[]>;

/** Injectable seam for the AUTHORITATIVE-registry fallback (resolveWorkspaceForHarnessSlug):
 *  slug → its workspace_id (or null), used when the projects projection has no row.
 *  Overridden in unit tests so the fallback branch is exercised without a live PG. */
export type RegistryWorkspaceResolver = (slug: string) => Promise<string | null>;

/**
 * Which workspace_id(s) carry `harness_slug` in `harness_shared.projects`.
 *
 * NB (2026-06-18): `harness_shared.projects` is NOT the universal harness
 * registry — it is the org/department blueprint's PROJECTION (business columns
 * owning_dept/vertical/budget_cents; the sole non-test writer is the
 * `execute-action.ts` project-create action), so it is sparse and a hive/generic
 * harness never appears in it. The de-facto AUTHORITATIVE slug→workspace registry
 * is `harness_shared.harness_registry` (resolveProject / resolveWorkspaceForHarnessSlug),
 * which pot:create/harness:create write and the work-items path reads. The older
 * "projects is authoritative" framing (migration 221 leg 1) is STALE — kept here
 * only as the FIRST consult; `fill_workspace_id_from_projects` falls back to the
 * registry when this returns 0 (peers su-a7f66 / su-632e0166, sibling EI-1511).
 * UNIQUE (workspace_id, slug) still holds, so a slug appears at most once per
 * workspace but MAY appear in several (a same-name collision). The cross-workspace
 * read uses the admin-bypass connection (harness_admin, RLS off) because the
 * calling context's workspace GUC is not necessarily the one that owns the slug.
 */
async function lookupProjectWorkspaceIds(slug: string): Promise<string[]> {
  return withWorkspace(
    '',
    async (tx) => {
      const rows = await tx<{ workspace_id: string }[]>`
        SELECT DISTINCT workspace_id
          FROM harness_shared.projects
         WHERE slug = ${slug}
           AND COALESCE(workspace_id, '') <> ''
      `;
      return rows.map((r) => r.workspace_id);
    },
    { bypassRlsForAdmin: true },
  );
}

/**
 * Resolve a harness slug → its workspace_id from the projects/registry source
 * of truth (WI-148 / P-013 workspace-identity reconciliation, the SAFE forward
 * half).
 *
 * Rules (fail-loud, no silent cross-workspace default):
 *   - operator-home / empty / '*' / 'all' / operatorHomeHarnessSlug() → PAPERCUSP_WORKSPACE_ID.
 *     WI-148 PART-B CUTOVER (owner GO 2026-06-16): flipped from DEFAULT_WORKSPACE_ID
 *     to PAPERCUSP_WORKSPACE_ID *in LOCKSTEP* with migration 295, which moves
 *     papercup's plan/feature/issue rows 'default' → 'papercusp-workspace' in the
 *     SAME release. The flip and the data move MUST ship together (either alone
 *     404s every papercup read) — they apply atomically on the :3070 deploy
 *     (migrations-before-serve + papercup-read path-verify → rollback). See WI-148.
 *   - a concrete other slug: look it up in harness_shared.projects.
 *       0 matches  → null (caller decides how to fail).
 *       1 match    → that workspace_id.
 *       2+ matches → THROW (same-name collision across workspaces — fail loud
 *                    rather than silently pick the wrong workspace).
 */
export async function fill_workspace_id_from_projects(
  harnessSlug: string | undefined,
  opts: { lookup?: ProjectsWorkspaceLookup; registryFallback?: RegistryWorkspaceResolver } = {},
): Promise<string | null> {
  const raw = harnessSlug?.trim();
  // WI-148 part-B cutover (owner GO 2026-06-16): papercup → PAPERCUSP_WORKSPACE_ID,
  // in lockstep with migration 295's data move (see the doc-comment above).
  if (isOperatorHomeScope(raw)) return PAPERCUSP_WORKSPACE_ID;

  const lookup = opts.lookup ?? lookupProjectWorkspaceIds;
  const matches = await lookup(raw!);
  const distinct = [...new Set(matches.filter((w) => w && w.trim()))];
  if (distinct.length > 1) {
    throw new Error(
      `fill_workspace_id_from_projects: harness slug '${raw}' resolves to ` +
        `${distinct.length} workspaces (${distinct.join(', ')}). Ambiguous same-name ` +
        `collision across workspaces — pass an explicit workspaceId to disambiguate.`,
    );
  }
  if (distinct.length === 1) return distinct[0]!;
  // 0 rows in harness_shared.projects — expected for a hive/generic harness, which
  // lives only in the AUTHORITATIVE harness registry (the projects table is just
  // the org/department projection — see lookupProjectWorkspaceIds). Fall back to
  // that registry, which is what the work-items path already resolves through, so
  // a hive's plans resolve the same way its work-items do. Active-workspace-first +
  // collision-aware (su-a7f66 / su-632e0166, EI-1511 / P-017). Additive: only turns
  // a former null (→ caller throw) into a resolution; never regresses papercup
  // (isOperatorHomeScope) or explicit-workspaceId callers (both short-circuit earlier).
  const registryFallback = opts.registryFallback ?? resolveWorkspaceForHarnessSlug;
  return await registryFallback(raw!);
}

/**
 * Resolve a `PlanSourceOpts` to the concrete (workspaceId, hive home slug) PG key.
 * Plans are Hive-scoped: a member harness passed by a caller collapses to its
 * home Hive slug before touching `harness_shared.harness_plans`. No harness / the
 * SU wildcard `'*'` / `'all'` / the operator-home slug → the Papercusp home Hive
 * in PAPERCUSP_WORKSPACE_ID. A concrete slug not belonging to a Hive THROWS, so
 * future plan rows cannot be written at member/standalone harness grain.
 */
export async function resolvePlanScope(
  opts: PlanSourceOpts & {
    lookup?: ProjectsWorkspaceLookup;
    registryFallback?: RegistryWorkspaceResolver;
  } = {},
): Promise<{ workspaceId: string; harnessSlug: string }> {
  const rawInput = opts.harnessSlug?.trim();
  const raw = rawInput && rawInput !== '*' && rawInput !== 'all'
    ? canonicalHarnessSlug(rawInput)
    : rawInput;
  if (isOperatorHomeScope(raw)) {
    // Operator-home / wildcard branch — WI-148 part-B (owner GO 2026-06-16): honor an
    // explicit workspaceId, else PAPERCUSP_WORKSPACE_ID (flipped from
    // DEFAULT_WORKSPACE_ID in lockstep with migration 295's data move).
    return {
      workspaceId: opts.workspaceId ?? PAPERCUSP_WORKSPACE_ID,
      harnessSlug: operatorHomeHarnessSlug(),
    };
  }
  // A concrete non-papercup slug. An explicit workspaceId pins the workspace,
  // but the plan key still collapses member → Hive home below.
  const workspaceIdFromArg = opts.workspaceId;
  // Otherwise resolve the workspace: first the projects projection, then (when it
  // has no row — the common case for a hive/generic harness) the AUTHORITATIVE
  // harness registry. FAIL LOUD only when NEITHER resolves, instead of silently
  // defaulting to 'default' (which wrote a named harness's plans into the wrong
  // workspace — the WI-148 bug).
  const workspaceId =
    workspaceIdFromArg ??
    (await fill_workspace_id_from_projects(raw, {
      ...(opts.lookup ? { lookup: opts.lookup } : {}),
      ...(opts.registryFallback ? { registryFallback: opts.registryFallback } : {}),
    }));
  if (workspaceId === null) {
    throw new Error(
      `resolvePlanScope: harness '${raw}' is not registered in the harness registry ` +
        `(harness_shared.harness_registry) or harness_shared.projects in any workspace, so ` +
        `its plan workspace cannot be resolved. Register the harness, or pass an explicit ` +
        `workspaceId. (Refusing to silently default to '${DEFAULT_WORKSPACE_ID}' — WI-148.)`,
    );
  }
  const hiveHome = await potHomeSlugForHarness(workspaceId, raw!);
  if (!hiveHome) {
    throw new Error(
      `resolvePlanScope: plans are Hive-scoped, but '${raw}' is not a Hive home and ` +
        `does not belong to one in workspace '${workspaceId}'. Add it to a Hive or pass ` +
        `the Hive home slug explicitly; refusing to create/read a non-Hive-scoped plan.`,
    );
  }
  return { workspaceId, harnessSlug: hiveHome };
}

/**
 * Does this error mean "this harness genuinely has no Hive plan scope" — a stale,
 * deregistered, or standalone-non-Hive slug, for which a LIST read is legitimately
 * empty rather than a failure?
 *
 * This is the single classifier for that question (P-014 / EI-19286551248996972).
 * It lives beside `resolvePlanScope`, which throws the errors it classifies, so the
 * predicate cannot drift away from the thrower.
 *
 * THE TYPE CHECK BELOW IS THE POINT, AND IT MUST STAY FIRST. The incident this
 * closes is a registry READ FAULT rendering as "not registered": callers folded the
 * fault into the same empty-result path as a confirmed absence, so `plans:list`
 * answered `ok:true` with `[]` for a harness that in fact held 960 rows. An
 * error-STRING match can never separate those two — a fault and an absence can
 * render the same words — so the distinction has to be typed at the source.
 *
 * Concretely: `RegistryReadUnavailableError`'s own prose deliberately avoids the
 * phrases matched below, but it appends `Underlying: <cause.message>`, and the
 * cause is whatever the failing registry read threw. Nothing stops a DB/pool fault
 * from containing the words "not registered", and if it ever does, a purely textual
 * classifier silently reports the fault as an absence — reintroducing the exact bug.
 * The `instanceof` guard makes that unreachable regardless of message text.
 *
 * The regex is retained only for the genuine-absence case, where `resolvePlanScope`
 * is the thrower and the message shape is ours. It is anchored on that `resolvePlanScope:`
 * prefix so an unrelated error carrying similar words still propagates.
 */
export function isUnknownPlanScopeError(error: unknown): boolean {
  // A read that FAILED is never evidence of absence — check the type before the text.
  if (error instanceof RegistryReadUnavailableError) return false;
  const message = error instanceof Error ? error.message : String(error);
  return /resolvePlanScope:\s+(?:harness .* is not registered|plans are Hive-scoped, but .* is not a Hive home)/i.test(
    message,
  );
}

/**
 * Synthetic stable locator for a plan — display + lock-key only, never a real
 * file (EI-19964793024613369): plans are PG-canonical
 * (plans-pg-canonical-migration-2026-06-03) and `docs/plans/*.md` was
 * git-rm'd, so this string is never written to disk for ANY plan, old or
 * new. It used to render as `apps/operator/docs/plans/<slug>.md` — a real
 * *former* on-disk shape — which taught callers (agents grepping for a
 * "filePath" the tool response handed them) to search the filesystem for a
 * plan that only ever lived in Postgres. The `plan://` scheme makes clear at
 * a glance that this is a locator, not a path: read a plan via
 * `plans:get` / `plans:search`, never a filesystem read.
 */
export function syntheticPlanPath(harnessSlug: string, slug: string): string {
  return `plan://${harnessSlug}/${slug}`;
}

// ── Filesystem dir helpers (repo-root / cwd resolution only — NOT plan bytes) ──

function resolveCanonicalRoots(opts: PlanSourceOpts): { plans: string; archive: string } {
  const candidates: string[] = [];
  if (opts.repoRoot) {
    candidates.push(opts.repoRoot);
  } else {
    // Prefer the registry-detected papercup root (same preference as
    // getRepoRoot): the papercup plans dir is a property of THE papercup
    // checkout, not of whichever host cwd happens to be running this code.
    // (A host whose cwd is another checkout — e.g. the :3070 release artifact —
    // must still resolve the canonical tree's mirror dir.)
    const detected = detectPapercupRoot();
    if (detected) candidates.push(detected);
    const cwd = process.cwd();
    candidates.push(cwd);
    if (cwd.endsWith(path.sep + 'apps' + path.sep + 'operator')) {
      candidates.push(path.dirname(path.dirname(cwd)));
    } else if (cwd.endsWith('/apps/operator')) {
      candidates.push(path.resolve(cwd, '..', '..'));
    }
  }
  for (const root of candidates) {
    const direct = path.join(root, PLANS_DIR_REL);
    // NB: must be a static import — a runtime `require('node:fs')` here threw
    // under the tsx/ESM host, silently failing EVERY candidate and falling
    // back to cwd, which mis-rooted the plan-markdown mirror into a nested
    // apps/operator/apps/operator/docs/plans/ (found live 2026-06-06).
    if (existsSync(direct)) {
      return { plans: direct, archive: path.join(root, ARCHIVE_DIR_REL) };
    }
  }
  const root = candidates[0] ?? process.cwd();
  return { plans: path.join(root, PLANS_DIR_REL), archive: path.join(root, ARCHIVE_DIR_REL) };
}

export function getPlansDir(opts: PlanSourceOpts = {}): string {
  return resolveCanonicalRoots(opts).plans;
}
export function getArchiveDir(opts: PlanSourceOpts = {}): string {
  return resolveCanonicalRoots(opts).archive;
}

/**
 * The repo root — where a launched plan agent starts its process
 * (plan-agent-launch-2026-05-21). Prefer the registry-detected root so it stays
 * correct after the FS retirement (the `docs/plans/` dir is empty/absent once
 * plans are PG-canonical); fall back to the legacy dir-walk for tests that pass
 * an explicit `repoRoot`.
 */
export function getRepoRoot(opts: PlanSourceOpts = {}): string {
  if (!opts.repoRoot) {
    const detected = detectPapercupRoot();
    if (detected) return detected;
  }
  return path.resolve(getPlansDir(opts), '..', '..', '..', '..');
}

/**
 * Resolve a harness slug to its canonical slug + workspace + repo-root dirs.
 * Now a VALIDATOR + repo-dir resolver (the `plans`/`archive` paths are the
 * harness's docs/plans location, used for cwd/launch and synthetic locators —
 * not for reading plan bytes, which come from PG). Throws if the harness isn't
 * registered (preserved behavior).
 */
export async function resolveHarnessPlansDir(
  harnessSlug?: string,
  opts: { workspaceId?: string } = {},
): Promise<{ harnessSlug: string; workspaceId: string; plans: string; archive: string }> {
  const reg = await loadHarnessRegistry(opts.workspaceId);
  const raw = harnessSlug?.trim();

  let project: (typeof reg.projects)[number] | undefined;
  let resolved: string;

  if (!raw || raw === '*') {
    const detected = detectPapercupRoot();
    if (detected) {
      project = reg.projects.find((p) => realpathOrResolve(p.path) === realpathOrResolve(detected));
    }
    project = project ?? reg.projects.find((p) => p.slug === operatorHomeHarnessSlug());
    if (!project) {
      throw new Error(
        `resolveHarnessPlansDir: no harness in ctx and no primary harness findable ` +
          `(no path-match for repo root '${detected}', no '${operatorHomeHarnessSlug()}' slug). ` +
          `Available: ${reg.projects.map((p) => p.slug).join(', ') || '(none)'}`,
      );
    }
    resolved = project.slug;
  } else {
    resolved = raw;
    project = (await resolveProject(resolved, opts.workspaceId)) ?? undefined;
    if (!project) {
      const didYouMean = resolved === 'papercusp' ? ` Did you mean '${operatorHomeHarnessSlug()}'?` : '';
      throw new Error(
        `resolveHarnessPlansDir: harness '${resolved}' not registered in any workspace.${didYouMean} ` +
          `Active-workspace harnesses: ${reg.projects.map((p) => p.slug).join(', ') || '(none)'}`,
      );
    }
  }
  if (resolved === operatorHomeHarnessSlug()) {
    const detected = detectPapercupRoot();
    // Compare checkout identities rather than only directory strings: the
    // canonical checkout may be reached through a symlink, or the staging
    // operator may run from a linked worktree. String-only path.resolve treats
    // both supported topologies as mismatches, which false-alarms and breaks
    // fleet:launch-on-plan (WI-1341 / EI-22682015531897411). The identity check
    // still rejects a genuine registry mismatch.
    if (detected && !samePapercupCheckout(project.path, detected)) {
      throw new Error(
        `P-014 runtime guard: papercup harness path '${project.path}' does not match ` +
          `detected repo root '${detected}'. The registry is out of sync.`,
      );
    }
  }
  const plans = path.join(project.path, plansRelFor(project.path));
  const workspaceId =
    (project as { workspaceId?: string }).workspaceId ?? opts.workspaceId ?? DEFAULT_WORKSPACE_ID;
  return { harnessSlug: resolved, workspaceId, plans, archive: path.join(plans, 'archive') };
}

/**
 * Whitelist of characters legal in a plan slug. Rejecting `/` is what stops a
 * `../../../etc/passwd`-style traversal in the synthetic lock path; the read
 * path no longer touches the filesystem, but the slug is still the PG key and
 * the lock key, so the guard stays. Per-run instance plans are minted as
 * `<template>@run-<decimal token>` and must be addressable by the same
 * read/write surfaces as authored plans.
 */
export const VALID_PLAN_SLUG = /^(?:[A-Za-z0-9._-]+|[A-Za-z0-9._-]+@run-\d+)$/;

export interface ListEntry {
  slug: string;
  /** Synthetic stable locator (the old `.md` path) — no file exists under PG storage. */
  filePath: string;
  archived: boolean;
}

/** List plan slugs for a harness (PG). Sorted by slug for a stable directory. */
export async function listPlanFiles(
  opts: PlanSourceOpts & { includeArchived?: boolean } = {},
): Promise<ListEntry[]> {
  const { workspaceId, harnessSlug } = await resolvePlanScope(opts);
  const rows = await withWorkspace(workspaceId, async (tx) => {
    return tx<{ plan_slug: string; archived: boolean }[]>`
      SELECT plan_slug, archived
        FROM harness_shared.harness_plans
       WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug}
       ORDER BY plan_slug ASC
    `;
  });
  return rows
    .filter((r) => opts.includeArchived || !r.archived)
    .map((r) => ({
      slug: r.plan_slug,
      filePath: syntheticPlanPath(harnessSlug, r.plan_slug),
      archived: r.archived,
    }));
}

/** Fetch one plan's raw row (PG), or null when it doesn't exist. */
export async function getPlanRow(
  slug: string,
  opts: PlanSourceOpts = {},
  timings?: Record<string, number>,
): Promise<PlanRow | null> {
  if (typeof slug !== 'string' || !VALID_PLAN_SLUG.test(slug)) return null;
  let stageStarted = timings ? performance.now() : 0;
  const mark = (stage: string) => {
    if (!timings) return;
    const now = performance.now();
    timings[`source.${stage}`] = Math.max(0, now - stageStarted);
    stageStarted = now;
  };
  const { workspaceId, harnessSlug } = await resolvePlanScope(opts);
  mark('resolveScope');
  try {
    const acquisitionStartedAt = timings ? performance.now() : 0;
    let beginAt = acquisitionStartedAt;
    const rows = await withWorkspace(workspaceId, async (tx) => {
      // Includes pool acquisition, BEGIN and workspace setup, not just pool wait.
      mark('acquireAndSetup');
      const rows = await tx<PlanDbRow[]>`
        SELECT workspace_id, harness_slug, plan_slug, content, content_hash, version,
               title, status, created, updated, owner, initiative, supersedes, superseded_by,
               op_status, op_started_at, op_updated_at, current_wave, op_priority,
               archived, is_legacy, updated_at, items, now_state, now_next, promote_policy,
               schedule, schedule_active, scheduled_at, expires_at, tzid, template_slug, run_seq,
               template, template_data, input_schema, output_schema, forced_past
               ${opts.prefetchAcceptance ? tx`, (
                 SELECT plan_slug FROM (${activeAcceptanceRubricsQuery(tx, { workspaceId, planSlugs: [slug] })}) AS active_rubric
                 LIMIT 1
               ) AS active_acceptance_rubric_ref` : tx``}
          FROM harness_shared.harness_plans
         WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug}
           AND plan_slug = ${slug}
      `;
      mark('query');
      return rows;
    }, timings ? { onAcquisitionPhase: (phase) => {
      const now = performance.now();
      if (phase === 'begin') {
        // Includes pool wait, connection establishment and BEGIN. It does not
        // assert which of those consumed the time.
        timings['source.waitForBegin'] = Math.max(0, now - acquisitionStartedAt);
        beginAt = now;
      } else {
        timings['source.workspaceSetup'] = Math.max(0, now - beginAt);
      }
    } } : undefined);
    mark('finishTransaction');
    const row = rows[0] ? rowFromDb(rows[0]) : null;
    mark('row');
    return row;
  } catch (err: unknown) {
    // The lifecycle overlay is advisory. If its subquery cannot be read, retain
    // the ordinary source read and let lifecycle perform its existing guarded
    // lookup (failure there remains unmeasured, never measured false).
    if (opts.prefetchAcceptance) {
      return getPlanRow(slug, { ...opts, prefetchAcceptance: false }, timings);
    }
    // Fallback for databases where migration 299 hasn't been applied yet
    // (schedule columns don't exist). Gracefully default them to null/false.
    if (
      err instanceof Error &&
      err.message?.includes('column') &&
      err.message?.includes('does not exist')
    ) {
      const rows = await withWorkspace(workspaceId, async (tx) => {
        return tx<Omit<PlanDbRow, 'schedule' | 'schedule_active' | 'scheduled_at' | 'expires_at' | 'tzid' | 'template_slug' | 'run_seq' | 'template' | 'template_data' | 'input_schema'>[]>`
          SELECT workspace_id, harness_slug, plan_slug, content, content_hash, version,
                 title, status, created, updated, owner, initiative, supersedes, superseded_by,
                 op_status, op_started_at, op_updated_at, current_wave, op_priority,
                 archived, is_legacy, updated_at, items, now_state, now_next
            FROM harness_shared.harness_plans
           WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug}
             AND plan_slug = ${slug}
        `;
      });
      if (!rows[0]) return null;
      return rowFromDb({
        ...rows[0],
        schedule: null,
        schedule_active: false,
        scheduled_at: null,
        expires_at: null,
        tzid: null,
        template_slug: null,
        run_seq: null,
        template: null,
        template_data: null,
        input_schema: null,
        forced_past: null,
      } as PlanDbRow);
    }
    throw err;
  }
}

/**
 * Does this plan slug exist ANYWHERE in the workspace's plans store, in ANY
 * harness? Unlike getPlanRow (which requires a resolved single harness),
 * this is a slug-only existence check — for callers that have a declared
 * plan slug but no reliable harness to scope it to (e.g. a presence row,
 * which does not carry harnessSlug). EI-7402: the claim-discipline watch
 * uses this to distinguish "declared a real, store-backed plan but hasn't
 * claimed a lane yet" (nudge with the plans:set-status remedy) from
 * "declared a file-only plan the store never ingested" (that remedy can
 * never succeed against it — nudging it every wake is pure noise).
 */
export async function planSlugExistsInWorkspace(
  workspaceId: string,
  slug: string,
): Promise<boolean> {
  if (typeof slug !== 'string' || !VALID_PLAN_SLUG.test(slug)) return false;
  const rows = await withWorkspace(workspaceId, async (tx) => {
    return tx<{ one: number }[]>`
      SELECT 1 AS one FROM harness_shared.harness_plans
       WHERE workspace_id = ${workspaceId} AND plan_slug = ${slug}
       LIMIT 1
    `;
  });
  return rows.length > 0;
}

/** Item statuses that are themselves terminal — the only item statuses worth
 *  surfacing from a terminal (shipped/superseded) plan in a cross-plan query
 *  (items.ts's isTerminalPlanHiddenFromCrossPlan). Reuses the canonical
 *  `isTerminalItemStatus` from fleet-drained-events.ts (the ONE answer to
 *  "is a plan item done") rather than redefining it here. */

/**
 * EI-16176: is this declared plan TERMINAL (shipped/superseded) or does it
 * have zero non-terminal items? Both mean "there is genuinely nothing left to
 * claim" — the claim-discipline-watch nudge's own remedy (claim a plan-item
 * lane) can never be discharged against either shape, so nagging an agent
 * that declared one forever is pure noise. Slug-only lookup mirroring
 * `planSlugExistsInWorkspace` (a presence row carries no reliable harnessSlug);
 * resolves the owning harness the same deterministic way
 * (`resolvePlanHarnessSlug` — most-recently-updated row on ambiguity) then
 * reuses `getPlanRow` + `planItemsForRow` rather than re-deriving item-status
 * parsing here. Null when the slug isn't store-backed in this workspace —
 * callers should treat that as "unknown" (fail open), not "terminal".
 */
export async function planTerminalityInWorkspace(
  workspaceId: string,
  slug: string,
): Promise<{ status: string | null; hasOpenItems: boolean } | null> {
  const harnessSlug = await resolvePlanHarnessSlug(workspaceId, slug);
  if (!harnessSlug) return null;
  const row = await getPlanRow(slug, { workspaceId, harnessSlug });
  if (!row) return null;
  const hasOpenItems = planItemsForRow(row).some(
    (item) => !isTerminalItemStatus(item.storedStatus),
  );
  return { status: row.status, hasOpenItems };
}

/**
 * The harness (pot) slug that owns a plan slug in this workspace — a
 * slug-only lookup for callers that have a plan slug but no reliable harness
 * to scope it to (mirrors planSlugExistsInWorkspace; P-004, resolving "the
 * pot" for a cross-machine spawn-request's plan). Null when the slug isn't
 * store-backed in this workspace, or is ambiguous across harnesses (picks
 * the most recently updated row deterministically rather than guessing).
 */
export async function resolvePlanHarnessSlug(
  workspaceId: string,
  slug: string,
): Promise<string | null> {
  if (typeof slug !== 'string' || !VALID_PLAN_SLUG.test(slug)) return null;
  const rows = await withWorkspace(workspaceId, async (tx) => {
    return tx<{ harness_slug: string }[]>`
      SELECT harness_slug FROM harness_shared.harness_plans
       WHERE workspace_id = ${workspaceId} AND plan_slug = ${slug}
       ORDER BY updated_at DESC
       LIMIT 1
    `;
  });
  return rows[0]?.harness_slug ?? null;
}


/**
 * Batched exact-slug scope recovery (EI-21194994217912029) — the INVERSE
 * sibling of {@link planSlugsForHarness}: a caller holding one or more EXACT
 * plan slugs but NO harness to scope them to asks which harnesses own them
 * (the plans:get / plans:items omit-harness recovery path). Returns, per
 * requested slug, every harness in this workspace holding a store-backed row,
 * most-recently-updated first — index 0 is the same deterministic pick
 * {@link resolvePlanHarnessSlug} makes. Requested slugs absent from the map
 * are not store-backed anywhere in this workspace. One query; never throws;
 * invalid slugs simply come back absent.
 */
export async function planHarnessesForSlugs(
  workspaceId: string,
  slugs: readonly string[],
  sqlOverride?: Sql,
): Promise<Map<string, string[]>> {
  const valid = [...new Set(slugs)].filter(
    (s): s is string => typeof s === 'string' && VALID_PLAN_SLUG.test(s),
  );
  const out = new Map<string, string[]>();
  if (valid.length === 0) return out;
  const query = async (tx: Sql) => tx<{ plan_slug: string; harness_slug: string }[]>`
      SELECT plan_slug, harness_slug FROM harness_shared.harness_plans
       WHERE workspace_id = ${workspaceId} AND plan_slug = ANY(${valid})
       ORDER BY updated_at DESC
    `;
  const rows = await (sqlOverride
    ? query(sqlOverride)
    : withWorkspace(workspaceId, async (tx) => query(tx)));
  for (const row of rows) {
    const list = out.get(row.plan_slug);
    if (list) list.push(row.harness_slug);
    else out.set(row.plan_slug, [row.harness_slug]);
  }
  return out;
}

/**
 * The set of plan slugs owned by `harnessSlug` in this workspace — the batch
 * sibling of `resolvePlanHarnessSlug` (one plan → its harness) for a caller
 * that instead has a HARNESS and needs to scope a plan-slug-keyed list to it
 * (EI-6176: `fleet:assignments`'s plan-item coverage rollup ignored a passed
 * `harness` filter entirely — it filtered by `plan`/`agent` but never by
 * `harness`, so a caller like `fleet:assignments { harness: 'oddsmith' }`
 * still got back coverage rows for every OTHER harness's plans too). One
 * query; empty set on an unresolvable harness (never throws).
 */
export async function planSlugsForHarness(workspaceId: string, harnessSlug: string): Promise<Set<string>> {
  const slug = harnessSlug?.trim();
  if (!slug) return new Set();
  const rows = await withWorkspace(workspaceId, async (tx) => {
    return tx<{ plan_slug: string }[]>`
      SELECT plan_slug FROM harness_shared.harness_plans
       WHERE workspace_id = ${workspaceId} AND harness_slug = ${slug}
    `;
  });
  return new Set(rows.map((r) => r.plan_slug));
}

/** All plan rows for a harness (PG), live + optionally archived. The archived
 *  filter runs in SQL — excluded rows' content blobs never leave PG (P-042). */
export async function listPlanRows(
  opts: PlanSourceOpts & { includeArchived?: boolean } = {},
): Promise<PlanRow[]> {
  const { workspaceId, harnessSlug } = await resolvePlanScope(opts);
  try {
    const rows = await withWorkspace(workspaceId, async (tx) => {
      const archivedFilter = opts.includeArchived ? tx`` : tx`AND archived = false`;
      return tx<PlanDbRow[]>`
        SELECT workspace_id, harness_slug, plan_slug, content, content_hash, version,
               title, status, created, updated, owner, initiative, supersedes, superseded_by,
               op_status, op_started_at, op_updated_at, current_wave, op_priority,
               archived, is_legacy, updated_at, items, now_state, now_next,
               schedule, schedule_active, scheduled_at, expires_at, tzid, template_slug, run_seq,
               template, template_data, input_schema, forced_past
          FROM harness_shared.harness_plans
         WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug}
         ${archivedFilter}
         ORDER BY plan_slug ASC
      `;
    });
    return rows.map(rowFromDb);
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      err.message?.includes('column') &&
      err.message?.includes('does not exist')
    ) {
      const rows = await withWorkspace(workspaceId, async (tx) => {
        const archivedFilter = opts.includeArchived ? tx`` : tx`AND archived = false`;
        return tx<Omit<PlanDbRow, 'schedule' | 'schedule_active' | 'scheduled_at' | 'expires_at' | 'tzid' | 'template_slug' | 'run_seq' | 'template' | 'template_data' | 'input_schema'>[]>`
          SELECT workspace_id, harness_slug, plan_slug, content, content_hash, version,
                 title, status, created, updated, owner, initiative, supersedes, superseded_by,
                 op_status, op_started_at, op_updated_at, current_wave, op_priority,
                 archived, is_legacy, updated_at, items, now_state, now_next
            FROM harness_shared.harness_plans
           WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug}
           ${archivedFilter}
           ORDER BY plan_slug ASC
        `;
      });
      return rows.map((r) =>
        rowFromDb({
          ...r,
          schedule: null,
          schedule_active: false,
          scheduled_at: null,
          expires_at: null,
          tzid: null,
          template_slug: null,
          run_seq: null,
          template: null,
          template_data: null,
          input_schema: null,
          forced_past: null,
        } as PlanDbRow),
      );
    }
    throw err;
  }
}

/** A plan row WITHOUT the content blob — the derived/frontmatter projection
 *  columns only. What `plans:list` renders from (audit P-042). */
export type PlanIndexRow = Omit<PlanRow, 'content'>;

type PlanIndexFilterOpts = {
  includeArchived?: boolean;
  status?: string;
  limit?: number;
  includeInstances?: boolean;
  template?: string;
  templateSlug?: string;
  createdSince?: string;
  updatedSince?: string;
};

/**
 * Keep every optional index-list predicate parameterized in the same order.
 *
 * The old conditional fragments omitted parameters for unset filters. That
 * made the same logical `harness_plans` read produce a different SQL text for
 * each combination of archived/status/instance/recency/limit options, which
 * fragmented PostgreSQL's plan/statistics cache. Boolean gates let us retain
 * the existing semantics while binding a stable parameter layout; NULL LIMIT
 * is PostgreSQL's `LIMIT ALL`.
 */
function normalizePlanIndexFilterValues(opts: PlanIndexFilterOpts) {
  const status = opts.status || null;
  const template = opts.template || null;
  const templateSlug = opts.templateSlug || null;
  const createdSince = opts.createdSince || null;
  const updatedSince = opts.updatedSince || null;

  return {
    includeArchived: opts.includeArchived === true,
    statusActive: status !== null,
    status,
    // A templateSlug selector is itself an instance selector, matching the
    // old conditional fragment's implicit includeInstances behavior.
    includeInstances: opts.includeInstances === true || templateSlug !== null,
    templateActive: template !== null,
    template,
    templateSlugActive: templateSlug !== null,
    templateSlug,
    createdSinceActive: createdSince !== null,
    createdSince,
    updatedSinceActive: updatedSince !== null,
    updatedSince,
    limit: typeof opts.limit === 'number' && opts.limit > 0 ? opts.limit : null,
  };
}

/**
 * Index-only listing: every projection column, never the content blob, with
 * the archived/status filters pushed into SQL and an optional LIMIT
 * (audit P-042 — EI-98/EI-174/EI-175 were `plans:list` loading + parsing
 * every body per request). Rows arrive parse-free; a consumer needing item
 * statuses reads the Stage-3 `items` jsonb already on the row.
 *
 * PAYLOAD PROJECTION (db-performance-remediation-2026-07-26 P-006). This was the single
 * most expensive statement in the database: 1.84M calls over 16.5 days returning 730M
 * rows, 15.1% of ALL database time, at a ~298 ms mean. The plan was never the problem —
 * the table holds under 1000 rows and the scan itself takes 7 ms. The cost is DETOASTING
 * and SERIALIZING large jsonb columns that most callers never read.
 *
 * Measured on the live hot query (same rows, real output, `\o /dev/null`):
 *   full wide ...................................... ~80 ms
 *   drop now_state + template_data ................. ~57 ms   <- the default here
 *   also drop items ................................ ~19 ms   <- includeItems: false
 *
 * ⚠ A REJECTED optimization worth recording so nobody re-attempts it: projecting `items`
 * with each element's `text` key stripped server-side (`jsonb_agg(e.value - 'text')`)
 * removes 74% of the column's BYTES but measured ~88 ms — SLOWER than shipping it whole.
 * Postgres must still detoast and re-parse the entire jsonb to rewrite it, and that CPU
 * exceeds the serialization it saves. Byte count is not the cost model here; detoast is.
 *
 * Hence the two knobs, both defaulting to the cheap side:
 *   - `now_state` / `template_data` are omitted unless `heavyFields: true`. Nothing on the
 *     LIST path reads either (template_data is consumed only by the single-plan mutation
 *     path). `now_next` stays — plans:list renders it as nextAction.
 *   - `items` still ships by default because the hot polling callers (system-health,
 *     pot/survey, scout) all read item status; a caller that needs none of it passes
 *     `includeItems: false` and gets an empty array plus the ~3x speedup above.
 *
 * The residual cost is item detoast on a query called 1.84M times, which no column
 * projection can remove — that is a CALL-COUNT problem, and belongs to the Phase 2
 * precompute work (plan D-005), not here.
 */
export async function listPlanIndexRows(
  opts: PlanSourceOpts & {
    includeArchived?: boolean;
    status?: string;
    limit?: number;
    /** Include per-run instance plans (template_slug IS NOT NULL). Default false (D-003). */
    includeInstances?: boolean;
    /** Filter to plans of a given template TYPE (P-005) — uses the
     *  harness_plans_template_idx filter index (mig 329). */
    template?: string;
    /** Filter to per-run instances of a given template plan (template_slug
     *  back-pointer, P-005). Implies including instances. */
    templateSlug?: string;
    /** Only plans whose row `created_at >= this` (ISO timestamp). Server-side
     *  recency filter so callers stop fetching every plan + post-filtering. */
    createdSince?: string;
    /** Only plans whose row `updated_at >= this` (ISO timestamp). */
    updatedSince?: string;
    /** Row order: 'updated'/'created' = recency DESC, 'slug' (default) = slug ASC. */
    order?: 'updated' | 'created' | 'slug';
    /** Ship the `items` jsonb (P-006). Default true — most callers read item status.
     *  Pass false when you need none of it: detoasting items is ~2/3 of this query's
     *  cost (~57 ms -> ~19 ms measured), and `items` then arrives as `[]`. */
    includeItems?: boolean;
    /** Ship `now_state` + `template_data` (P-006). Default false — no LIST-path
     *  consumer reads them; omitting them measured ~80 ms -> ~57 ms. */
    heavyFields?: boolean;
  } = {},
): Promise<PlanIndexRow[]> {
  const { workspaceId, harnessSlug } = await resolvePlanScope(opts);
  try {
    const rows = await withWorkspace(workspaceId, async (tx) => {
      const filters = normalizePlanIndexFilterValues(opts);
      const orderClause =
        opts.order === 'updated'
          ? tx`ORDER BY updated_at DESC NULLS LAST`
          : opts.order === 'created'
            ? tx`ORDER BY created_at DESC NULLS LAST`
            : tx`ORDER BY plan_slug ASC`;
      // P-006 payload projection (see the function docstring for the measurements).
      // includeItems:false yields an empty array rather than NULL so `row.items.length`
      // stays safe; the heavy fragment emits typed NULLs so the row shape — and therefore
      // rowFromDb — is identical whether or not the caller opted in.
      const itemsCol = opts.includeItems === false ? tx`'[]'::jsonb AS items` : tx`items`;
      const heavyCols = opts.heavyFields
        ? tx`now_state, template_data, input_schema,`
        : tx`NULL::text AS now_state, NULL::jsonb AS template_data, NULL::jsonb AS input_schema,`;
      return tx<Array<Omit<PlanDbRow, 'content'>>>`
        SELECT workspace_id, harness_slug, plan_slug, content_hash, version,
               title, status, created, updated, owner, initiative, supersedes, superseded_by,
               op_status, op_started_at, op_updated_at, current_wave, op_priority,
               archived, is_legacy, updated_at, ${itemsCol}, ${heavyCols} now_next,
               schedule, schedule_active, scheduled_at, expires_at, tzid, template_slug, run_seq,
               template, forced_past,
               input_schema IS NOT NULL AS has_input_schema,
               -- STORED generated column (migration 1024). Do NOT inline
               -- "content LIKE BLENDER_PLAN_SQL_PATTERN" here again: content averages
               -- 10 kB and is TOASTed, so the LIKE detoasts it for every candidate row
               -- even though content is never returned. Measured 88.0 ms / 7,609 buffers
               -- with it vs 1.4 ms / 360 without -- 98.5% of this query's cost, and this
               -- was the #1 statement on the instance at 16.2% of all database time.
               -- The legacy fallback below still computes it inline ON PURPOSE: that path
               -- runs only where migration 1024 has not applied and the column is absent.
               is_blender_origin,
               EXISTS (
                 SELECT 1
                   FROM harness_shared.trigger_bindings tb
                  WHERE tb.workspace_id = harness_plans.workspace_id
                    AND tb.plan_harness_slug = harness_plans.harness_slug
                    AND tb.plan_slug = harness_plans.plan_slug
                    AND tb.action->>'type' = 'launch-plan'
                    AND tb.detached_at IS NULL
               ) AS has_external_trigger
          FROM harness_shared.harness_plans
         WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug}
           AND (${filters.includeArchived} OR archived = false)
           AND (${!filters.statusActive} OR status = ${filters.status})
           AND (${filters.includeInstances} OR template_slug IS NULL)
           AND (${!filters.templateActive} OR template = ${filters.template})
           AND (${!filters.templateSlugActive} OR template_slug = ${filters.templateSlug})
           AND (${!filters.createdSinceActive} OR created_at >= ${filters.createdSince})
           AND (${!filters.updatedSinceActive} OR updated_at >= ${filters.updatedSince})
         ${orderClause}
         LIMIT ${filters.limit}
      `;
    });
    return rows.map((r) => {
      const { content: _content, ...rest } = rowFromDb({ ...r, content: '' } as PlanDbRow);
      return rest;
    });
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      err.message?.includes('column') &&
      err.message?.includes('does not exist')
    ) {
      const rows = await withWorkspace(workspaceId, async (tx) => {
        const filters = normalizePlanIndexFilterValues(opts);
        return tx<Array<Omit<PlanDbRow, 'content'>>>`
          SELECT workspace_id, harness_slug, plan_slug, content_hash, version,
                 title, status, created, updated, owner, initiative, supersedes, superseded_by,
                 op_status, op_started_at, op_updated_at, current_wave, op_priority,
                 archived, is_legacy, updated_at, items, now_state, now_next
                 , content LIKE ${BLENDER_PLAN_SQL_PATTERN} AS is_blender_origin
           FROM harness_shared.harness_plans
           WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug}
             AND (${filters.includeArchived} OR archived = false)
             AND (${!filters.statusActive} OR status = ${filters.status})
             AND (${filters.includeInstances} OR template_slug IS NULL)
           ORDER BY plan_slug ASC
           LIMIT ${filters.limit}
        `;
      });
      return rows.map((r) => {
        const { content: _content, ...rest } = rowFromDb({
          ...r,
          content: '',
          schedule: null,
          schedule_active: false,
          scheduled_at: null,
          expires_at: null,
          tzid: null,
          template_slug: null,
          run_seq: null,
          template: null,
          template_data: null,
          input_schema: null,
          forced_past: null,
        } as PlanDbRow);
        return rest;
      });
    }
    throw err;
  }
}

/**
 * Index-only listing across the WHOLE active workspace — every plan in
 * `workspaceId` regardless of harness (workspace-data-isolation-leaks F-A1).
 *
 * The UI "all plans" view must show the ACTIVE workspace's plans, not a single
 * hardcoded harness. The legacy `harness:'all'` sentinel resolves to
 * papercup/PAPERCUSP_WORKSPACE_ID (the SU wildcard for Papercusp's own plans) —
 * correct for the dogfood, but a cross-workspace LEAK for any other workspace.
 * This lists by `workspace_id` only (RLS + the explicit filter both scope it),
 * so each workspace sees exactly its own plans. Output rows carry their own
 * `harnessSlug`. (In papercup's own workspace every plan is under the papercup
 * harness, so this returns the same set the old `harness:'all'` path did.)
 */
export async function listPlanIndexRowsForWorkspace(
  opts: {
    workspaceId: string;
    includeArchived?: boolean;
    status?: string;
    limit?: number;
    includeInstances?: boolean;
    /** Filter to plans of a given template TYPE (P-005). */
    template?: string;
    /** Filter to per-run instances of a given template plan (P-005); implies instances. */
    templateSlug?: string;
    /** Only plans whose row `created_at >= this` (ISO timestamp). */
    createdSince?: string;
    /** Only plans whose row `updated_at >= this` (ISO timestamp). */
    updatedSince?: string;
    /** Row order: 'updated'/'created' = recency DESC, default = harness+slug ASC. */
    order?: 'updated' | 'created' | 'slug';
    /** Ship the `items` jsonb (P-006). Default true; false yields `[]` and is ~3x faster. */
    includeItems?: boolean;
    /** Ship `now_state` + `template_data` (P-006). Default false. */
    heavyFields?: boolean;
  },
): Promise<PlanIndexRow[]> {
  const { workspaceId } = opts;
  try {
    const rows = await withWorkspace(workspaceId, async (tx) => {
      const filters = normalizePlanIndexFilterValues(opts);
      const orderClause =
        opts.order === 'updated'
          ? tx`ORDER BY updated_at DESC NULLS LAST`
          : opts.order === 'created'
            ? tx`ORDER BY created_at DESC NULLS LAST`
            : tx`ORDER BY harness_slug ASC, plan_slug ASC`;
      // P-006 payload projection — identical to listPlanIndexRows above; see its docstring.
      const itemsCol = opts.includeItems === false ? tx`'[]'::jsonb AS items` : tx`items`;
      const heavyCols = opts.heavyFields
        ? tx`now_state, template_data, input_schema,`
        : tx`NULL::text AS now_state, NULL::jsonb AS template_data, NULL::jsonb AS input_schema,`;
      return tx<Array<Omit<PlanDbRow, 'content'>>>`
        SELECT workspace_id, harness_slug, plan_slug, content_hash, version,
               title, status, created, updated, owner, initiative, supersedes, superseded_by,
               op_status, op_started_at, op_updated_at, current_wave, op_priority,
               archived, is_legacy, updated_at, ${itemsCol}, ${heavyCols} now_next,
               schedule, schedule_active, scheduled_at, expires_at, tzid, template_slug, run_seq,
               template, forced_past,
               input_schema IS NOT NULL AS has_input_schema,
               -- STORED generated column (migration 1024). Do NOT inline
               -- "content LIKE BLENDER_PLAN_SQL_PATTERN" here again: content averages
               -- 10 kB and is TOASTed, so the LIKE detoasts it for every candidate row
               -- even though content is never returned. Measured 88.0 ms / 7,609 buffers
               -- with it vs 1.4 ms / 360 without -- 98.5% of this query's cost, and this
               -- was the #1 statement on the instance at 16.2% of all database time.
               -- The legacy fallback below still computes it inline ON PURPOSE: that path
               -- runs only where migration 1024 has not applied and the column is absent.
               is_blender_origin,
               EXISTS (
                 SELECT 1
                   FROM harness_shared.trigger_bindings tb
                  WHERE tb.workspace_id = harness_plans.workspace_id
                    AND tb.plan_harness_slug = harness_plans.harness_slug
                    AND tb.plan_slug = harness_plans.plan_slug
                    AND tb.action->>'type' = 'launch-plan'
                    AND tb.detached_at IS NULL
               ) AS has_external_trigger
          FROM harness_shared.harness_plans
         WHERE workspace_id = ${workspaceId}
           AND (${filters.includeArchived} OR archived = false)
           AND (${!filters.statusActive} OR status = ${filters.status})
           AND (${filters.includeInstances} OR template_slug IS NULL)
           AND (${!filters.templateActive} OR template = ${filters.template})
           AND (${!filters.templateSlugActive} OR template_slug = ${filters.templateSlug})
           AND (${!filters.createdSinceActive} OR created_at >= ${filters.createdSince})
           AND (${!filters.updatedSinceActive} OR updated_at >= ${filters.updatedSince})
         ${orderClause}
         LIMIT ${filters.limit}
      `;
    });
    return rows.map((r) => {
      const { content: _content, ...rest } = rowFromDb({ ...r, content: '' } as PlanDbRow);
      return rest;
    });
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      err.message?.includes('column') &&
      err.message?.includes('does not exist')
    ) {
      const rows = await withWorkspace(workspaceId, async (tx) => {
        const filters = normalizePlanIndexFilterValues(opts);
        return tx<Array<Omit<PlanDbRow, 'content'>>>`
          SELECT workspace_id, harness_slug, plan_slug, content_hash, version,
                 title, status, created, updated, owner, initiative, supersedes, superseded_by,
                 op_status, op_started_at, op_updated_at, current_wave, op_priority,
                 archived, is_legacy, updated_at, items, now_state, now_next
                 , content LIKE ${BLENDER_PLAN_SQL_PATTERN} AS is_blender_origin
            FROM harness_shared.harness_plans
           WHERE workspace_id = ${workspaceId}
             AND (${filters.includeArchived} OR archived = false)
             AND (${!filters.statusActive} OR status = ${filters.status})
             AND (${filters.includeInstances} OR template_slug IS NULL)
           ORDER BY harness_slug ASC, plan_slug ASC
           LIMIT ${filters.limit}
        `;
      });
      return rows.map((r) => {
        const { content: _content, ...rest } = rowFromDb({
          ...r,
          content: '',
          schedule: null,
          schedule_active: false,
          scheduled_at: null,
          expires_at: null,
          tzid: null,
          template_slug: null,
          run_seq: null,
          template: null,
          template_data: null,
          input_schema: null,
          forced_past: null,
        } as PlanDbRow);
        return rest;
      });
    }
    throw err;
  }
}

/**
 * Author a plan's SCHEDULE — the operational schedule columns (scheduled-recurring-plans
 * D-004/D-016, P-014), distinct from the markdown blob (like the op_* columns). Writes
 * `schedule` (jsonb), `scheduled_at`, `expires_at`, `tzid`. Does NOT arm the schedule
 * (`schedule_active` is left untouched — arming is the autonomy-gated flow, Phase 3).
 * Pass `schedule: null` to clear a recurrence (un-schedule). `sql` is a test seam (an
 * admin client); production uses `withWorkspace`. Returns true iff a plan row matched.
 */
export async function setPlanSchedule(
  opts: PlanSourceOpts & {
    slug: string;
    schedule?: PlanSchedule | null;
    scheduledAt?: string | null;
    expiresAt?: string | null;
    tzid?: string | null;
    sql?: Sql;
  },
): Promise<boolean> {
  const { workspaceId, harnessSlug } = await resolvePlanScope(opts);
  const scheduleJson = opts.schedule ? JSON.stringify(opts.schedule) : null;
  const run = (tx: Sql) =>
    tx<{ plan_slug: string }[]>`
      UPDATE harness_shared.harness_plans
         SET schedule = ${scheduleJson}::text::jsonb,
             scheduled_at = ${opts.scheduledAt ?? null}::timestamptz,
             expires_at = ${opts.expiresAt ?? null}::timestamptz,
             tzid = ${opts.tzid ?? null},
             updated_at = now()
       WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug}
         AND plan_slug = ${opts.slug}
      RETURNING plan_slug
    `;
  const rows = opts.sql
    ? await run(opts.sql)
    : await withWorkspace(workspaceId, (tx) => run(tx as unknown as Sql));
  return rows.length > 0;
}

/**
 * Batched content fetch for a small, known slug set — the targeted fallback
 * for index rows whose Stage-3 `items` projection is empty (a federated
 * remote row whose projection didn't fill, audit P-042). One query, only
 * the named rows' blobs.
 */
export async function getPlanContentsBySlugs(
  slugs: string[],
  opts: PlanSourceOpts = {},
): Promise<Map<string, string>> {
  if (slugs.length === 0) return new Map();
  const { workspaceId, harnessSlug } = await resolvePlanScope(opts);
  const rows = await withWorkspace(workspaceId, async (tx) => {
    return tx<Array<{ plan_slug: string; content: string }>>`
      SELECT plan_slug, content
        FROM harness_shared.harness_plans
       WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug}
         AND plan_slug = ANY(${slugs}::text[])
    `;
  });
  return new Map(rows.map((r) => [r.plan_slug, r.content]));
}

/**
 * Return only plan slugs whose canonical content declares the spec-triad
 * policy. This metadata probe lets `plans:items` preserve declaration
 * precedence without transferring every plan body on the index path.
 */
export async function getPlanSlugsWithSpecTriadDeclaration(
  opts: PlanSourceOpts & { includeArchived?: boolean } = {},
): Promise<Set<string>> {
  const { workspaceId, harnessSlug } = await resolvePlanScope(opts);
  const rows = await withWorkspace(workspaceId, async (tx) => {
    return tx<Array<{ plan_slug: string }>>`
      SELECT plan_slug
        FROM harness_shared.harness_plans
       WHERE workspace_id = ${workspaceId}
         AND harness_slug = ${harnessSlug}
         ${opts.includeArchived ? tx`` : tx`AND archived = false`}
         AND content LIKE '%specTriad:%'
    `;
  });
  return new Set(rows.map((row) => row.plan_slug));
}

/** Escape LIKE/ILIKE wildcards in a user token so it matches literally. */
function escapeLike(token: string): string {
  return token.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * SQL candidate prefilter for `plans:search` (audit P-042): only rows whose
 * content OR plan_slug contains ≥1 query token (case-insensitive) come back.
 * Every content scope (title/now/items/decisions/prose) is a substring of the
 * content blob; the `slug` scope matches the PG plan_slug — which is NOT part of
 * what the scorer sees (the parser strips frontmatter from prose), so a
 * slug-only match (searching a plan's own slug, whose hyphenated tokens never
 * appear verbatim in its title/body) needs the explicit plan_slug arm or the
 * plan is lossily excluded (F-FIX-028/029). A plan with zero token hits in
 * either can never score and is lossless to exclude. `limit` caps the candidate
 * set; `truncated` reports when the cap bit (no silent caps).
 */
export async function listPlanRowsMatchingAnyToken(
  tokens: string[],
  opts: PlanSourceOpts & { includeArchived?: boolean; limit?: number } = {},
): Promise<{ rows: PlanRow[]; truncated: boolean }> {
  if (tokens.length === 0) return { rows: [], truncated: false };
  const { workspaceId, harnessSlug } = await resolvePlanScope(opts);
  const limit = opts.limit && opts.limit > 0 ? opts.limit : 200;
  const patterns = tokens.map((t) => `%${escapeLike(t)}%`);
  try {
    const rows = await withWorkspace(workspaceId, async (tx) => {
      const archivedFilter = opts.includeArchived ? tx`` : tx`AND archived = false`;
      return tx<PlanDbRow[]>`
        SELECT workspace_id, harness_slug, plan_slug, content, content_hash, version,
               title, status, created, updated, owner, initiative, supersedes, superseded_by,
               op_status, op_started_at, op_updated_at, current_wave, op_priority,
               archived, is_legacy, updated_at, items, now_state, now_next,
               schedule, schedule_active, scheduled_at, expires_at, tzid, template_slug, run_seq,
               template, template_data, input_schema, forced_past
          FROM harness_shared.harness_plans
         WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug}
         ${archivedFilter}
           AND (content ILIKE ANY(${patterns}::text[]) OR plan_slug ILIKE ANY(${patterns}::text[]))
         ORDER BY plan_slug ASC
         LIMIT ${limit + 1}
      `;
    });
    const truncated = rows.length > limit;
    return { rows: (truncated ? rows.slice(0, limit) : rows).map(rowFromDb), truncated };
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      err.message?.includes('column') &&
      err.message?.includes('does not exist')
    ) {
      const rows = await withWorkspace(workspaceId, async (tx) => {
        const archivedFilter = opts.includeArchived ? tx`` : tx`AND archived = false`;
        return tx<Omit<PlanDbRow, 'schedule' | 'schedule_active' | 'scheduled_at' | 'expires_at' | 'tzid' | 'template_slug' | 'run_seq' | 'template' | 'template_data' | 'input_schema'>[]>`
          SELECT workspace_id, harness_slug, plan_slug, content, content_hash, version,
                 title, status, created, updated, owner, initiative, supersedes, superseded_by,
                 op_status, op_started_at, op_updated_at, current_wave, op_priority,
                 archived, is_legacy, updated_at, items, now_state, now_next
            FROM harness_shared.harness_plans
           WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug}
           ${archivedFilter}
             AND (content ILIKE ANY(${patterns}::text[]) OR plan_slug ILIKE ANY(${patterns}::text[]))
           ORDER BY plan_slug ASC
           LIMIT ${limit + 1}
        `;
      });
      const truncated = rows.length > limit;
      return {
        rows: (truncated ? rows.slice(0, limit) : rows).map((r) =>
          rowFromDb({
            ...r,
            schedule: null,
            schedule_active: false,
            scheduled_at: null,
            expires_at: null,
            tzid: null,
            template_slug: null,
            run_seq: null,
            template: null,
            template_data: null,
            input_schema: null,
            forced_past: null,
          } as PlanDbRow),
        ),
        truncated,
      };
    }
    throw err;
  }
}

/**
 * Read one plan by slug, parsing its canonical content blob into a ParsedPlan.
 * Shape preserved from the FS reader (`{ parsed, archived }`) + the raw `row`
 * for callers needing version / op_* state. Returns null on an invalid slug or
 * a missing plan.
 */
export async function readPlanBySlug(
  slug: string,
  opts: PlanSourceOpts = {},
  timings?: Record<string, number>,
): Promise<{ parsed: ParsedPlan; archived: boolean; row: PlanRow } | null> {
  const row = await getPlanRow(slug, opts, timings);
  if (!row) return null;
  const started = timings ? performance.now() : 0;
  const parsed = parsePlan(row.content, { filePath: syntheticPlanPath(row.harnessSlug, row.planSlug) });
  if (timings) timings['source.parse'] = Math.max(0, performance.now() - started);
  return {
    parsed,
    archived: row.archived,
    row,
  };
}

/** All plans for a harness, parsed. Mirrors the old FS `readAllPlans`. */
export async function readAllPlans(
  opts: PlanSourceOpts & { includeArchived?: boolean } = {},
): Promise<Array<{ parsed: ParsedPlan; archived: boolean; row: PlanRow }>> {
  const rows = await listPlanRows(opts);
  return rows.map((row) => ({
    parsed: parsePlan(row.content, { filePath: syntheticPlanPath(row.harnessSlug, row.planSlug) }),
    archived: row.archived,
    row,
  }));
}

/**
 * The derived-index shapes and `deriveIndexFromContent` now live in the LEAF module
 * `./derive-index`, and are re-exported here so existing importers are unaffected.
 *
 * They were moved out because deriving an index from markdown is pure, while THIS
 * module is the plans data-access layer — it reaches `@papercusp/db-org`, the harness
 * registry, hive federation and `fleet-drained-events`, and through that last edge the
 * coordination → locks → db-org subgraph. Importing `source.ts` merely to derive an
 * index dragged all of that in, which is what took `perf/child-driver.test.ts` red on
 * the gate (the perf peer child stubs db-org to throw, and `locks/configure.ts` calls
 * into it at module top level). Import from `./derive-index` in new code; see that
 * module's header for the full chain.
 */
export {
  deriveIndexFromContent,
  type PlanIndex,
  type PlanIndexItem,
  type PlanIndexDecision,
} from './derive-index';

/**
 * Resolve a plan row's items from the PG-canonical structured `items` index
 * (plans-pg-canonical-migration Stage 3) — no content-blob parse. Falls back to
 * parsing `content` only when the structured index is empty/absent (a federated
 * remote row whose projection didn't fill the derived columns, or a genuinely
 * itemless plan — the parse is cheap either way). The ONE answer to "what items
 * does this plan have" — plans:items, set-status's flip, and declare-intent's
 * lane validation must all agree (EI-356).
 */
export function planItemsForRow(row: PlanRow): PlanItem[] {
  if (row.items.length > 0) {
    return row.items.map((i) => ({
      id: i.id,
      text: i.text,
      storedStatus: i.status as PlanItem['storedStatus'],
      importance: i.importance as PlanItem['importance'],
      blockedBy: i.blockedBy,
      decisionRefs: i.decisionRefs,
      phase: i.phase,
      lineNumber: 0,
      rawLine: '',
    }));
  }
  return parsePlan(row.content).items;
}
