/**
 * publish-goal-core — the ONE server-side path that publishes a goal PACKAGE to
 * the Cupboard as a `kind='goal'` listing (work-on-everything-goal-2026-08-23
 * P-006).
 *
 * Mirrors publish-plan-core: the listing is MIRROR-REPO-BACKED — `github_url`
 * is the public repo the package dir was pushed to and `listing_ref` is the
 * per-package subdir. Like a plan (and unlike a rubric), a goal has NO
 * DIRECTORY ON DISK to push: it lives in `harness_shared.goals` as a row that
 * fuses a reusable shape with live run state. So this core:
 *
 *   1. SERIALIZES the row, STRIPPING live state — `status`, `inputs`,
 *      `metadata` (spend, pause records, provenance) are never read, and
 *      tripwire `current` readings are dropped. What is KEPT is the shape:
 *      title / duties body / standing flag / kill criterion / tripwire
 *      thresholds / budget ceiling + window / launch settings / IO schemas
 *      (D-002: a package ships DEFAULTS, never another workspace's telemetry).
 *   2. MATERIALIZES the result as a self-describing dir in the writable user
 *      layer, so the publisher has a real directory to push.
 *
 * Hence `exportOnly`, same as the plan path: the honest ordering is export →
 * push → publish, and `exportOnly: true` runs steps 1–2 and stops.
 *
 * REVIEW POLICY: 'goal' is a REVIEW_POLICY_KIND — a goal package is prose that
 * tells another workspace what to PURSUE (and what to spend), so it lands
 * PENDING until an operator approves it. Enforced server-side by the worker.
 */
import { publishListingToCupboard } from './publish-listing';
import { buildSelfDescribingPublishExtras } from './self-describing-release';
import { parseGithubRemote, fetchGithubRepoMeta } from './resolve-repo-coords';
import {
  writeGoalPackageDir,
  type GoalPackageExport,
  type GoalPackageTripwire,
  type WrittenGoalPackage,
} from './goal-package-store';
import type { RubricRequirement } from './types';
import { scrubIdentityFields, isIdentityLeakError, type IdentityLeakHit } from './identity-scrub';

// A single safe path segment: the dir name under the user layer AND the
// within-repo subdir. Mirrors install-self-describing-core's SAFE_REF_RE.
const SAFE_REF_RE = /^[A-Za-z0-9._-]+$/;

/** The live-state fields the serializer NEVER reads — reported on every export
 *  so a sanitizer nobody inspects is not one nobody notices has stopped. */
const LIVE_STATE_OMITTED = ['status', 'inputs', 'metadata', 'properties', 'tripwires[].current'] as const;

export interface PublishGoalInput {
  /** The SOURCE goal's id in this workspace — what gets serialized. */
  goalId: string;
  /** Narrow the lookup to a goal filed against this install_slug. */
  harness?: string;
  /** The public mirror repo the exported dir lives in. Required unless `exportOnly`. */
  github_url?: string;
  /** Override the within-repo subdir / user-layer dir name (else derived from the title). */
  listing_ref?: string;
  /** Papercupai project remote. */
  project_ref?: string;
  title?: string;
  description?: string;
  /** Package version recorded in listing.json (storefront only). */
  version?: string;
  /** Declare these rubric requirements. A goal has no content to derive them from; `[]`/absent ⇒ none. */
  requires_rubrics?: RubricRequirement[];
  /** Materialize the exported dir and STOP — do not create a listing. */
  exportOnly?: boolean;
}

export interface PublishGoalExportInfo {
  written: WrittenGoalPackage;
  title: string;
  description: string;
  standing: boolean;
  requiresRubrics: RubricRequirement[];
  /** What the serializer removed — the evidence the live state came out. */
  stripped: {
    tripwireCurrentReadings: number;
    liveStateOmitted: readonly string[];
    /** Dotted paths of identity-bearing CONFIG fields replaced with placeholders
     *  (EI-23420285862298325). Empty means none were present — NOT that none were
     *  looked for; the write gate refuses anything this missed. */
    identityFieldsScrubbed: string[];
  };
}

export type PublishGoalResult =
  | { ok: true; exportedOnly: true; export: PublishGoalExportInfo }
  | { ok: true; exportedOnly: false; export: PublishGoalExportInfo; listing: unknown }
  | {
      ok: false;
      status: number;
      error: string;
      detail?: unknown;
      upstream_status?: number;
      /** Present when the write gate refused: publisher identity survived into the
       *  serialized package. Named so the publisher fixes the source rather than
       *  re-running a hand scan. */
      identityLeaks?: IdentityLeakHit[];
    };

/** The goal-row slice the export reads. Aliased camelCase in the default SQL so
 *  the shape is transform-independent. */
export interface GoalRowForExport {
  id: string;
  title: string;
  body: string | null;
  standing: boolean;
  killCriterion: string | null;
  tripwires: unknown;
  budgetCents: number | null;
  budgetWindowSec: number | null;
  launchSettings: unknown;
  inputSchema: unknown;
  outputSchema: unknown;
  /** Typed property DECLARATIONS (P-023 shape) — the runtime `properties`
   *  VALUES are live state and are never read by this export. */
  propertySchema: unknown;
}

/** Read the source goal row. Injected so the core is testable without a live
 *  Postgres — the real wiring reads `harness_shared.goals` workspace-scoped. */
export type GoalRowReader = (
  goalId: string,
  opts: { harness?: string },
) => Promise<GoalRowForExport | null>;

async function defaultGoalRowReader(
  goalId: string,
  opts: { harness?: string },
): Promise<GoalRowForExport | null> {
  const [{ getOrgPg }, { activeWorkspaceId }] = await Promise.all([
    import('@papercusp/db-org'),
    import('../workspace-registry'),
  ]);
  const workspaceId = activeWorkspaceId();
  if (!workspaceId) return null;
  const sql = getOrgPg().sql;
  const rows = (await sql`
    SELECT id, title, body, standing,
           kill_criterion   AS "killCriterion",
           tripwires,
           budget_cents     AS "budgetCents",
           budget_window_sec AS "budgetWindowSec",
           launch_settings  AS "launchSettings",
           input_schema     AS "inputSchema",
           output_schema    AS "outputSchema",
           property_schema  AS "propertySchema"
      FROM harness_shared.goals
     WHERE id = ${goalId}
       AND workspace_id = ${workspaceId}
       ${opts.harness ? sql`AND install_slug = ${opts.harness}` : sql``}
     LIMIT 1
  `) as unknown as GoalRowForExport[];
  return rows[0] ?? null;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Serialize the row's tripwires as package DEFAULTS: `current` readings are
 *  dropped (counted, so the caller can report the strip), malformed rows are
 *  skipped — this is our own jsonb, not attacker input, and an export should
 *  carry what is well-formed rather than refuse over legacy debris. */
function exportTripwires(raw: unknown): { tripwires: GoalPackageTripwire[] | null; strippedCurrents: number } {
  if (!Array.isArray(raw)) return { tripwires: null, strippedCurrents: 0 };
  let strippedCurrents = 0;
  const out: GoalPackageTripwire[] = [];
  for (const e of raw) {
    if (!isPlainObject(e)) continue;
    const metric = typeof e.metric === 'string' && e.metric ? e.metric : null;
    const label = typeof e.label === 'string' && e.label ? e.label : null;
    const threshold = typeof e.threshold === 'number' && Number.isFinite(e.threshold) ? e.threshold : null;
    if (!metric || !label || threshold === null) continue;
    if (e.current !== undefined) strippedCurrents += 1;
    const unit = typeof e.unit === 'string' && e.unit ? e.unit : undefined;
    out.push({ metric, label, threshold, ...(unit ? { unit } : {}) });
  }
  return { tripwires: out.length > 0 ? out : null, strippedCurrents };
}

/** Derive a safe default listing ref from the goal's title (goalId()'s stem
 *  logic without the random suffix — a listing ref should be stable). */
function refFromTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/**
 * Publish (or just export) a goal package. Returns a structured result — never
 * throws for an expected failure; the caller maps status+error to its response.
 */
export async function publishGoalToCupboard(
  input: PublishGoalInput,
  readGoal: GoalRowReader = defaultGoalRowReader,
): Promise<PublishGoalResult> {
  const goalId = String(input.goalId ?? '').trim();
  if (!goalId) return { ok: false, status: 400, error: 'goalId required (the goal to publish)' };

  const row = await readGoal(goalId, { ...(input.harness ? { harness: input.harness } : {}) });
  if (!row) return { ok: false, status: 404, error: `goal "${goalId}" not found in this workspace` };

  const title = (input.title ?? row.title ?? '').trim();
  if (!title) return { ok: false, status: 422, error: `goal "${goalId}" has no title to package` };

  const body = typeof row.body === 'string' && row.body !== '' ? row.body : null;
  const firstBodyLine = body?.split('\n').find((l) => l.trim() !== '')?.trim();
  const description =
    input.description ??
    (firstBodyLine ? (firstBodyLine.length > 240 ? `${firstBodyLine.slice(0, 240)}…` : firstBodyLine) : '');

  const { tripwires, strippedCurrents } = exportTripwires(row.tripwires);
  const requiresRubrics = input.requires_rubrics ?? [];

  // IDENTITY SCRUB (EI-23420285862298325). The CONFIG half of a package — launch
  // settings and IO schemas — is where the publisher's account handle rides along
  // (`launchSettings.roles.*.account`, 10+ sites in the leak that produced this).
  // That is configuration, so a package ships a PLACEHOLDER default instead of this
  // workspace's identity, and the strip is REPORTED like every other.
  //
  // Prose (title / body / killCriterion / description) is deliberately NOT scrubbed:
  // it is text whose meaning the publisher owns, so identity there is REFUSED at the
  // write gate rather than silently rewritten. The harvested values ride along to
  // that gate, so a copy of the same handle sitting in the duty body is caught too.
  const config = scrubIdentityFields({
    launchSettings: isPlainObject(row.launchSettings) ? row.launchSettings : null,
    inputSchema: isPlainObject(row.inputSchema) ? row.inputSchema : null,
    outputSchema: isPlainObject(row.outputSchema) ? row.outputSchema : null,
    propertySchema: isPlainObject(row.propertySchema) ? row.propertySchema : null,
  });

  const exported: GoalPackageExport = {
    title,
    body,
    standing: row.standing === true,
    killCriterion:
      typeof row.killCriterion === 'string' && row.killCriterion !== '' ? row.killCriterion : null,
    tripwires,
    budgetCents:
      typeof row.budgetCents === 'number' && Number.isFinite(row.budgetCents)
        ? Math.trunc(row.budgetCents)
        : null,
    budgetWindowSec:
      typeof row.budgetWindowSec === 'number' &&
      Number.isInteger(row.budgetWindowSec) &&
      row.budgetWindowSec > 0
        ? row.budgetWindowSec
        : null,
    ...config.value,
    description,
    requiresRubrics,
  };

  const ref = (input.listing_ref ?? refFromTitle(title) ?? '').trim() || goalId;
  if (!SAFE_REF_RE.test(ref)) {
    return { ok: false, status: 400, error: `invalid goal package ref "${ref}"` };
  }

  let written: WrittenGoalPackage;
  try {
    written = writeGoalPackageDir(exported, {
      ref,
      ...(input.version ? { version: input.version } : {}),
      ...(config.identityValues.length > 0
        ? { knownIdentityValues: config.identityValues }
        : {}),
    });
  } catch (e) {
    // A refused write is NOT a materialization failure — surfacing it as a generic
    // 500 would bury the one thing the publisher has to act on.
    if (isIdentityLeakError(e)) {
      return { ok: false, status: 422, error: e.message, identityLeaks: e.hits };
    }
    return {
      ok: false,
      status: 500,
      error: 'could not materialize the goal package dir',
      detail: e instanceof Error ? e.message.slice(0, 300) : String(e),
    };
  }

  const info: PublishGoalExportInfo = {
    written,
    title,
    description,
    standing: exported.standing,
    requiresRubrics,
    stripped: {
      tripwireCurrentReadings: strippedCurrents,
      liveStateOmitted: LIVE_STATE_OMITTED,
      identityFieldsScrubbed: config.scrubbed.map((h) => h.path),
    },
  };

  if (input.exportOnly === true) return { ok: true, exportedOnly: true, export: info };

  const githubUrl = typeof input.github_url === 'string' ? input.github_url.trim() : '';
  if (!githubUrl) {
    return {
      ok: false,
      status: 400,
      error:
        'github_url required (the public mirror repo the exported dir lives in) — or pass exportOnly to materialize the dir first',
    };
  }
  const parsed = parseGithubRemote(githubUrl);
  if (!parsed) return { ok: false, status: 400, error: `invalid github_url "${githubUrl}"` };
  const meta = await fetchGithubRepoMeta(parsed.owner, parsed.repo);
  if (!meta) {
    return { ok: false, status: 422, error: `could not resolve GitHub repo ${parsed.owner}/${parsed.repo}` };
  }

  const releaseBuild = await buildSelfDescribingPublishExtras({
    listingKind: 'goal',
    listingRef: ref,
    dir: written.dir,
    ...(input.version ? { version: input.version } : {}),
  });
  if (!releaseBuild.ok) {
    return { ok: false, status: releaseBuild.status, error: releaseBuild.error, detail: releaseBuild.detail };
  }

  const result = await publishListingToCupboard({
    ...releaseBuild.extras,
    listing_kind: 'goal',
    listing_ref: ref,
    ...(typeof input.project_ref === 'string' ? { project_ref: input.project_ref } : {}),
    github_repository_id: meta.id,
    github_owner: parsed.owner,
    github_name: parsed.repo,
    github_url: meta.html_url || `https://github.com/${parsed.owner}/${parsed.repo}`,
    title,
    description,
    // Omitted entirely when empty: the worker's validator rejects a zero-length
    // array (`array_1_to_200`), so sending `[]` for "declares nothing" would 400.
    ...(requiresRubrics.length > 0 ? { requires_rubrics: requiresRubrics } : {}),
  });

  if (!result.ok) {
    return {
      ok: false,
      status: result.status,
      error: result.error,
      detail: result.detail,
      upstream_status: result.upstream_status,
    };
  }
  return { ok: true, exportedOnly: false, export: info, listing: result.data };
}
