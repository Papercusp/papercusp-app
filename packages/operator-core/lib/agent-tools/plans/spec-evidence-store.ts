/** Exact work-item/spec-revision coverage and immutable evidence bindings (P-005). */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';
import { withWorkspace } from '@papercusp/db-org';
import { pgTimestampToIso } from '../../pg-timestamp';
import { planItemRef } from '../../issue-blocks-merge';
import { loadHarnessRegistry, resolveHarnessContentPath } from '../../harness-registry';
import { ADHOC_WORK_ITEM_SPEC_SCOPE, resolveSpecScopeSlug } from './adhoc-spec-scope';
import type { SpecClauseSql } from './spec-clauses-store';
import { resolvePlanScope } from './source';
import { ensureBootstrap, getTxPool, readQueue } from '../locks/su-lock-store';
import {
  MEASUREMENT_PIN_DETAILS_KEY,
  buildMeasurementPin,
  diffMeasuredFiles,
  gitBlobId,
  readMeasurementPin,
  type GitRunner,
  type MeasuredRepoFile,
  type MeasurementPin,
  type MovedPath,
} from './evidence-measurement-pin';

export { ADHOC_WORK_ITEM_SPEC_SCOPE, MEASUREMENT_PIN_DETAILS_KEY };
export type { MeasurementPin, MovedPath };

export const SPEC_EVIDENCE_KINDS = [
  'test',
  'fixture',
  'coverage-census',
  'mutation',
  'counterexample',
  'check',
  'manual',
  'operational',
] as const;
export type SpecEvidenceKind = (typeof SPEC_EVIDENCE_KINDS)[number];

const evidenceFingerprintSchema = z.string().trim().min(1).max(256);
const repoMeasurementPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(400)
  .refine(
    (value) =>
      !isAbsolute(value) &&
      !value.startsWith('./') &&
      !value.includes('\\') &&
      !value.split('/').some((part) => part === '' || part === '.' || part === '..'),
    'measurement paths must be normalized repo-relative POSIX file paths',
  );

export const repoFilesEvidenceMeasurementSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('repo-files'),
    /**
     * Optional workspace-registry slug for a source/test checkout other than the
     * plan's owning harness.  Cross-repository plans already resolve citations
     * through these registered roots; keeping the selector to a slug (never an
     * absolute path) gives evidence currentness the same bounded admission rule.
     */
    rootHarnessSlug: z.string().trim().min(1).max(120).optional(),
    sourcePaths: z.array(repoMeasurementPathSchema).min(1).max(32),
    testPaths: z.array(repoMeasurementPathSchema).min(1).max(32).optional(),
  })
  .strict();

export type RepoFilesEvidenceMeasurement = z.infer<typeof repoFilesEvidenceMeasurementSchema>;

const ledgerMeasurementIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Z]+-[A-Za-z0-9._-]+$/, 'ledger measurement ids are work-item refs such as WI-1234 or EI-5678');

/**
 * A LEDGER-STATE measurement basis (WI-10002087).
 *
 * WHY THIS EXISTS. `source` currentness had exactly ONE basis — a repo file-set hash — so a
 * binding whose SUBJECT is not a file set had no basis at all and was pinned at `unknown`
 * forever, whatever its `evidenceKind`. (The kind is a red herring: most `operational` rows
 * measure fine because their subject happens to be repo files.) That made every non-code plan
 * outcome unshippable, because the ship gate demands current proof and no current proof was
 * reachable for a claim about ledger state — e.g. "each of these five rows reached a recorded
 * disposition".
 *
 * WHY A DIGEST AND NOT A RECENCY WINDOW. Both a recency window and mapping non-file kinds to
 * `not-applicable` would REMOVE the check rather than satisfy it: a caller could mint freshness
 * from an assertion it authored itself, which is the whole failure the attested-current guard
 * below exists to prevent. Hashing the named rows' disposition keeps the rail exactly as strong
 * as the file-set hash — the server re-reads and re-hashes on every read, so a row that reopens
 * or is deleted correctly goes `stale` instead of staying provably "current".
 */
export const workItemsEvidenceMeasurementSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('work-items'),
    /**
     * The census population. Bounded like `sourcePaths`: a measurement basis has to stay cheap
     * enough to recompute on every evidence read.
     */
    workItemIds: z.array(ledgerMeasurementIdSchema).min(1).max(64),
  })
  .strict();

export type WorkItemsEvidenceMeasurement = z.infer<typeof workItemsEvidenceMeasurementSchema>;

/** Every server-re-measurable evidence basis. Discriminated on `kind`; add a case, not a parallel surface. */
export const evidenceMeasurementSchema = z.discriminatedUnion('kind', [
  repoFilesEvidenceMeasurementSchema,
  workItemsEvidenceMeasurementSchema,
]);

export type EvidenceMeasurement = z.infer<typeof evidenceMeasurementSchema>;

export interface MeasuredRepoEvidenceFingerprints {
  sourceFingerprint: string;
  testFingerprint: string | null;
}

const MAX_REPO_MEASUREMENT_BYTES = 8 * 1024 * 1024;

function containedBy(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

async function fingerprintRepoFileSet(
  repoRoot: string,
  declaredPaths: readonly string[],
): Promise<{ fingerprint: string; files: Array<{ path: string; sha256: string; gitBlob: string }> }> {
  const root = await realpath(repoRoot);
  const paths = [...new Set(declaredPaths)].sort();
  const entries: Array<{ path: string; sha256: string }> = [];
  const files: Array<{ path: string; sha256: string; gitBlob: string }> = [];
  let totalBytes = 0;
  for (const path of paths) {
    const candidate = resolve(root, path);
    if (!containedBy(root, candidate)) throw new Error(`repo_measurement_path_outside_root:${path}`);
    const canonical = await realpath(candidate);
    if (!containedBy(root, canonical)) throw new Error(`repo_measurement_symlink_outside_root:${path}`);
    const info = await stat(canonical);
    if (!info.isFile()) throw new Error(`repo_measurement_not_file:${path}`);
    totalBytes += info.size;
    if (totalBytes > MAX_REPO_MEASUREMENT_BYTES) {
      throw new Error(`repo_measurement_too_large:${totalBytes}>${MAX_REPO_MEASUREMENT_BYTES}`);
    }
    const content = await readFile(canonical);
    const sha256 = createHash('sha256').update(content).digest('hex');
    // The digest input stays exactly `{ path, sha256 }` so every existing fingerprint is
    // byte-identical; the git blob id rides alongside for the P-018 commit pin only.
    entries.push({ path, sha256 });
    files.push({ path, sha256, gitBlob: gitBlobId(content) });
  }
  const digest = createHash('sha256').update(JSON.stringify(entries)).digest('hex');
  return { fingerprint: `sha256-file-set-v1:${digest}`, files };
}

/** The fingerprint tuple plus the per-file hashes it was computed from (P-018). */
export interface DetailedRepoEvidenceMeasurement extends MeasuredRepoEvidenceFingerprints {
  files: MeasuredRepoFile[];
}

async function nearestRepositoryRoot(root: string, file: string): Promise<string> {
  let current = dirname(file);
  while (containedBy(root, current)) {
    if (existsSync(join(current, '.git'))) return realpath(current);
    if (current === root) break;
    current = dirname(current);
  }
  return root;
}

async function refuseMutationProbePaths(root: string, declaredPaths: readonly string[]): Promise<void> {
  const groups = new Map<string, Set<string>>();
  for (const path of new Set(declaredPaths)) {
    const candidate = resolve(root, path);
    if (!containedBy(root, candidate)) throw new Error(`repo_measurement_path_outside_root:${path}`);
    const canonical = await realpath(candidate);
    if (!containedBy(root, canonical)) throw new Error(`repo_measurement_symlink_outside_root:${path}`);
    const domain = await nearestRepositoryRoot(root, canonical);
    const repoPath = relative(domain, canonical).split(sep).join('/');
    const paths = groups.get(domain) ?? new Set<string>();
    paths.add(repoPath);
    groups.set(domain, paths);
  }

  await ensureBootstrap();
  for (const [coordinationDomain, paths] of groups) {
    const queue = await readQueue(getTxPool(), { coordinationDomain, paths: [...paths] });
    const activeProbe = queue.active_locks.find(
      (lock) => String(lock.intent ?? '').trim().toLowerCase() === 'mutation probe',
    );
    if (activeProbe) {
      throw new Error(`repo_measurement_mutation_probe_active:${coordinationDomain}:${activeProbe.path}`);
    }
  }
}

/** Measure a repo-files recipe and keep the per-file hashes, in ONE read of each file. */
export async function measureRepoFilesEvidenceDetailedAtRoot(
  repoRoot: string,
  measurement: RepoFilesEvidenceMeasurement,
): Promise<DetailedRepoEvidenceMeasurement> {
  const parsed = repoFilesEvidenceMeasurementSchema.parse(measurement);
  const root = await realpath(repoRoot);
  const measuredPaths = [...parsed.sourcePaths, ...(parsed.testPaths ?? [])];
  await refuseMutationProbePaths(root, measuredPaths);
  const [source, test] = await Promise.all([
    fingerprintRepoFileSet(root, parsed.sourcePaths),
    parsed.testPaths ? fingerprintRepoFileSet(root, parsed.testPaths) : Promise.resolve(null),
  ]);
  await refuseMutationProbePaths(root, measuredPaths);
  return {
    sourceFingerprint: source.fingerprint,
    testFingerprint: test?.fingerprint ?? null,
    files: [
      ...source.files.map((file) => ({ ...file, dimension: 'source' as const })),
      ...(test?.files ?? []).map((file) => ({ ...file, dimension: 'test' as const })),
    ],
  };
}

/** Recompute a bounded repository-backed evidence tuple from the current harness tree. */
export async function measureRepoFilesEvidenceAtRoot(
  repoRoot: string,
  measurement: RepoFilesEvidenceMeasurement,
): Promise<MeasuredRepoEvidenceFingerprints> {
  const { sourceFingerprint, testFingerprint } = await measureRepoFilesEvidenceDetailedAtRoot(repoRoot, measurement);
  return { sourceFingerprint, testFingerprint };
}

/**
 * Measure a repo-files recipe AND pin it to the commit(s) it was measured against
 * (P-018). The fingerprints come from the same single read the pin's per-file hashes
 * do, so the two can never describe different bytes. Pinning never fails the
 * measurement: a git probe that fails is recorded inside the pin.
 */
export async function measureAndPinRepoFilesEvidenceAtRoot(
  repoRoot: string,
  measurement: RepoFilesEvidenceMeasurement,
  options: { git?: GitRunner } = {},
): Promise<MeasuredRepoEvidenceFingerprints & { pin: MeasurementPin }> {
  const detailed = await measureRepoFilesEvidenceDetailedAtRoot(repoRoot, measurement);
  const pin = await buildMeasurementPin(await realpath(repoRoot), detailed.files, options);
  return { sourceFingerprint: detailed.sourceFingerprint, testFingerprint: detailed.testFingerprint, pin };
}

async function resolveMeasurementRoot(
  workspaceId: string,
  harnessSlug: string,
  measurement?: Pick<RepoFilesEvidenceMeasurement, 'rootHarnessSlug'>,
): Promise<string> {
  const registry = await loadHarnessRegistry(workspaceId);
  const rootHarnessSlug = measurement?.rootHarnessSlug ?? harnessSlug;
  const root = resolveHarnessContentPath(registry, rootHarnessSlug);
  if (!root) throw new Error(`repo_measurement_harness_root_unavailable:${rootHarnessSlug}`);
  return root;
}

/** Resolve the canonical harness checkout and measure the declared file sets there. */
export async function measureRepoFilesEvidence(
  workspaceId: string,
  harnessSlug: string,
  measurement: RepoFilesEvidenceMeasurement,
): Promise<MeasuredRepoEvidenceFingerprints> {
  return measureRepoFilesEvidenceAtRoot(await resolveMeasurementRoot(workspaceId, harnessSlug, measurement), measurement);
}

/**
 * Recompute a bounded ledger-state evidence tuple from the CURRENT work-item rows.
 *
 * Only the disposition-bearing column is hashed. Hashing the whole row would make the binding
 * go stale on any incidental touch (a comment, a re-checkpoint), which would train readers to
 * ignore staleness; hashing `status` alone means the digest changes exactly when the claim
 * "these rows reached a recorded disposition" stops being true.
 *
 * A row that is ABSENT is hashed as an explicit `null` rather than skipped, so a deleted row —
 * or a typo'd id that never existed — cannot silently produce the same digest as a present one.
 */
export async function measureWorkItemsEvidenceForScope(
  workspaceId: string,
  harnessSlug: string,
  measurement: WorkItemsEvidenceMeasurement,
): Promise<MeasuredRepoEvidenceFingerprints> {
  const parsed = workItemsEvidenceMeasurementSchema.parse(measurement);
  const ids = [...new Set(parsed.workItemIds)].sort();
  const rows = await withWorkspace(workspaceId, async (tx) => {
    return tx<{ feature_id: string; status: string | null }[]>`
      SELECT feature_id, status
        FROM harness_shared.work_items
       WHERE workspace_id = ${workspaceId}
         AND harness_slug = ${harnessSlug}
         AND feature_id = ANY(${ids}::text[])`;
  });
  const statusById = new Map(rows.map((row) => [row.feature_id, row.status]));
  const entries = ids.map((id) => ({ id, status: statusById.get(id) ?? null }));
  const digest = createHash('sha256').update(JSON.stringify(entries)).digest('hex');
  return { sourceFingerprint: `sha256-work-item-set-v1:${digest}`, testFingerprint: null };
}

/** Dispatch a measurement recipe to its basis. Both bases are server-measured, never caller-attested. */
export async function measureEvidenceForScope(
  workspaceId: string,
  harnessSlug: string,
  measurement: EvidenceMeasurement,
): Promise<MeasuredRepoEvidenceFingerprints> {
  return measurement.kind === 'work-items'
    ? measureWorkItemsEvidenceForScope(workspaceId, harnessSlug, measurement)
    : measureRepoFilesEvidence(workspaceId, harnessSlug, measurement);
}

/**
 * `measureEvidenceForScope` plus the P-018 commit pin for a repo-files basis. A ledger
 * (`work-items`) basis has no checkout, so it carries no pin.
 */
export async function measureAndPinEvidenceForScope(
  workspaceId: string,
  harnessSlug: string,
  measurement: EvidenceMeasurement,
): Promise<MeasuredRepoEvidenceFingerprints & { pin: MeasurementPin | null }> {
  if (measurement.kind === 'work-items') {
    return { ...(await measureWorkItemsEvidenceForScope(workspaceId, harnessSlug, measurement)), pin: null };
  }
  return measureAndPinRepoFilesEvidenceAtRoot(await resolveMeasurementRoot(workspaceId, harnessSlug, measurement), measurement);
}

function measurementFromDetails(details: Record<string, unknown>): EvidenceMeasurement | null {
  const parsed = evidenceMeasurementSchema.safeParse(details.currentMeasurement);
  return parsed.success ? parsed.data : null;
}
/** Shared wire contract for an explicit comparison with currently measured proof. */
export const evidenceCurrentInputSchema = z.object({
  planSlug: z.string().trim().min(1).max(2000).optional(),
  specId: z.string().trim().min(1).max(2000).optional(),
  specRevision: z.number().int().positive().optional(),
  specFingerprint: evidenceFingerprintSchema.optional(),
  evidenceKind: z.enum(SPEC_EVIDENCE_KINDS),
  evidenceRef: z.string().trim().min(1).max(2000),
  sourceFingerprint: evidenceFingerprintSchema,
  testFingerprint: evidenceFingerprintSchema.nullable().optional(),
  fixtureFingerprint: evidenceFingerprintSchema.nullable().optional(),
  rubricFingerprint: evidenceFingerprintSchema.nullable().optional(),
  environmentFingerprint: evidenceFingerprintSchema.nullable().optional(),
}).superRefine((input, ctx) => {
  const identity = [input.planSlug, input.specId, input.specRevision, input.specFingerprint];
  if (identity.some((value) => value !== undefined) && !identity.every((value) => value !== undefined)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['planSlug'],
      message: 'planSlug, specId, specRevision, and specFingerprint must be supplied together',
    });
  }
});

export interface EvidenceFingerprints {
  sourceFingerprint: string;
  testFingerprint?: string | null;
  fixtureFingerprint?: string | null;
  rubricFingerprint?: string | null;
  environmentFingerprint?: string | null;
}

export interface BindSpecEvidenceInput extends EvidenceFingerprints {
  harnessSlug?: string;
  /**
   * The plan whose spec clause this evidence binds to. OPTIONAL as of P-022: omit it for
   * an ad-hoc work-item that belongs to no plan, and the binding is scoped to
   * {@link ADHOC_WORK_ITEM_SPEC_SCOPE} instead.
   *
   * D-018 records why this is resolved rather than made nullable: `plan_slug` is a PRIMARY
   * KEY column in all four tables of the spec chain and carries a composite FK that
   * terminates at `harness_plans`, so it can never hold NULL. The blocker was never the
   * column — it was that the API forced a caller with no plan to invent one.
  */
  planSlug?: string;
  workItemId: string;
  specId?: string;
  sourceValId?: string;
  specRevision?: number;
  evidenceKind: SpecEvidenceKind;
  evidenceRef: string;
  coverageEvidenceRef?: number | null;
  testRunId?: number | null;
  details?: Record<string, unknown>;
  observedAt?: string;
  actorId: string;
}

export type BindSpecEvidenceResult =
  | {
      status: 'created' | 'unchanged';
      id: number;
      workItemId: string;
      planSlug: string;
      specId: string;
      sourceValId: string | null;
      specRevision: number;
      specFingerprint: string;
      bindingFingerprint: string;
    }
  | { status: 'work_item_not_found'; workItemId: string }
  | { status: 'spec_not_found'; specId?: string; sourceValId?: string }
  | { status: 'spec_revision_not_found'; specId: string; specRevision: number }
  | { status: 'coverage_evidence_not_found'; coverageEvidenceRef: number }
  // The test-run lookup is tenant-scoped, so a row that EXISTS but carries a
  // different (or NULL) harness_slug is indistinguishable from a fabricated id
  // — both surface as a bare `test_run_not_found`, which reads as "you invented
  // that id" and sends the caller hunting for the wrong bug. harness_slug is
  // stamped from the runner's environment, so it is legitimately NULL whenever a
  // run was started without a harness (for example `testing:run` called without
  // its optional `harness` arg), and those rows are then permanently unbindable
  // with no signal at the point of failure. `scopeMismatch` distinguishes the two
  // cases and names the row's actual tenancy so the fix is obvious.
  | {
      status: 'test_run_not_found';
      testRunId: number;
      scopeMismatch?: {
        foundOutsideScope: true;
        rowHarnessSlug: string | null;
        rowWorkspaceId: string | null;
        expectedHarnessSlug: string;
        expectedWorkspaceId: string;
        hint: string;
      };
    };

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, nested]) => [key, canonicalJson(nested)]),
    );
  }
  return value;
}

const nullableTrimmed = (value: string | null | undefined): string | null => value?.trim() || null;

interface CanonicalBinding {
  workspaceId: string;
  harnessSlug: string;
  workItemId: string;
  planSlug: string;
  specId: string;
  specRevision: number;
  specFingerprint: string;
  evidenceKind: SpecEvidenceKind;
  evidenceRef: string;
  sourceFingerprint: string;
  testFingerprint: string | null;
  fixtureFingerprint: string | null;
  rubricFingerprint: string | null;
  environmentFingerprint: string | null;
  coverageEvidenceRef: number | null;
  testRunId: number | null;
  details: Record<string, unknown>;
}

export function specEvidenceBindingFingerprint(input: CanonicalBinding): string {
  // P-018: the commit pin describes WHERE the bytes were measured, not the proof. A HEAD
  // sha moves with every unrelated commit, so fingerprinting it would turn a re-bind of
  // byte-identical proof into a fresh row instead of `unchanged`. Rows that predate the
  // pin carry no such key, so their fingerprints are unchanged by this omission.
  const { [MEASUREMENT_PIN_DETAILS_KEY]: _pin, ...fingerprintedDetails } = input.details;
  return createHash('sha256')
    .update(JSON.stringify(canonicalJson({ ...input, details: fingerprintedDetails })))
    .digest('hex');
}

interface SpecIdentityRow {
  spec_id: string;
  source_val_id: string | null;
  current_revision: number;
}

interface SpecRevisionRow {
  content_hash: string;
}

/** Resolve the selector and append one idempotent exact evidence binding. */
export async function bindSpecEvidence(input: BindSpecEvidenceInput): Promise<BindSpecEvidenceResult> {
  const scope = await resolvePlanScope({ harnessSlug: input.harnessSlug });
  return withWorkspace(scope.workspaceId, async (tx) => {
    // P-022 / D-018: a caller with no plan gets the harness's shared ad-hoc spec scope
    // rather than being forced to invent a plan slug. Everything downstream then runs
    // unchanged, which is the point: no PK, FK, index or freshness invariant moves.
    const planSlug = await resolveSpecScopeSlug(tx, scope.workspaceId, scope.harnessSlug, input.planSlug);
    const lockKey = `${scope.workspaceId}:${scope.harnessSlug}:${input.workItemId}:${planSlug}:${input.specId ?? input.sourceValId}`;
    await tx`SELECT pg_advisory_xact_lock(hashtext('spec_evidence_binding'), hashtext(${lockKey}))`;

    const workItems = await tx<{ feature_id: string }[]>`
      SELECT feature_id
        FROM harness_shared.work_items
       WHERE workspace_id = ${scope.workspaceId}
         AND harness_slug = ${scope.harnessSlug}
         AND feature_id = ${input.workItemId}`;
    if (!workItems[0]) return { status: 'work_item_not_found', workItemId: input.workItemId };

    const identities = await tx<SpecIdentityRow[]>`
      SELECT spec_id, source_val_id, current_revision
        FROM harness_shared.plan_spec_clauses
       WHERE workspace_id = ${scope.workspaceId}
         AND harness_slug = ${scope.harnessSlug}
         AND plan_slug = ${planSlug}
         AND (${input.specId ?? null}::text IS NULL OR spec_id = ${input.specId ?? null})
         AND (${input.sourceValId ?? null}::text IS NULL OR source_val_id = ${input.sourceValId ?? null})`;
    const identity = identities[0];
    if (!identity) {
      return {
        status: 'spec_not_found',
        ...(input.specId ? { specId: input.specId } : {}),
        ...(input.sourceValId ? { sourceValId: input.sourceValId } : {}),
      };
    }

    const specRevision = input.specRevision ?? Number(identity.current_revision);
    const revisions = await tx<SpecRevisionRow[]>`
      SELECT content_hash
        FROM harness_shared.plan_spec_clause_revisions
       WHERE workspace_id = ${scope.workspaceId}
         AND harness_slug = ${scope.harnessSlug}
         AND plan_slug = ${planSlug}
         AND spec_id = ${identity.spec_id}
         AND revision = ${specRevision}`;
    const revision = revisions[0];
    if (!revision) return { status: 'spec_revision_not_found', specId: identity.spec_id, specRevision };

    if (input.coverageEvidenceRef != null) {
      const rows = await tx<{ id: number }[]>`
        SELECT e.id
          FROM harness_shared.coverage_evidence e
          JOIN harness_shared.testing_surfaces s ON s.id = e.surface_ref
         WHERE e.id = ${input.coverageEvidenceRef}
           AND s.workspace_id = ${scope.workspaceId}
           AND s.harness_slug = ${scope.harnessSlug}`;
      if (!rows[0]) {
        return { status: 'coverage_evidence_not_found', coverageEvidenceRef: input.coverageEvidenceRef };
      }
    }
    if (input.testRunId != null) {
      const rows = await tx<{ id: number }[]>`
        SELECT id FROM harness_shared.test_runs
         WHERE id = ${input.testRunId}
           AND workspace_id = ${scope.workspaceId}
           AND harness_slug = ${scope.harnessSlug}`;
      if (!rows[0]) {
        // Re-probe by id ALONE before reporting absence. The scoped miss above
        // cannot tell a fabricated id from a real row in another tenancy, and the
        // most common cause here is the latter: harness_slug is env-stamped, so a
        // run started without a harness lands NULL and can never match.
        const unscoped = await tx<{ harness_slug: string | null; workspace_id: string | null }[]>`
          SELECT harness_slug, workspace_id FROM harness_shared.test_runs
           WHERE id = ${input.testRunId}`;
        const found = unscoped[0];
        if (!found) return { status: 'test_run_not_found', testRunId: input.testRunId };
        return {
          status: 'test_run_not_found',
          testRunId: input.testRunId,
          scopeMismatch: {
            foundOutsideScope: true,
            rowHarnessSlug: found.harness_slug,
            rowWorkspaceId: found.workspace_id,
            expectedHarnessSlug: scope.harnessSlug,
            expectedWorkspaceId: scope.workspaceId,
            hint:
              found.harness_slug === null
                ? `test-run ${input.testRunId} EXISTS but its harness_slug is NULL, so it can never match this harness-scoped lookup. harness_slug is stamped from the runner's environment: re-run the test with the harness supplied (for example testing:run { harness: '${scope.harnessSlug}', files: [...] }, or PAPERCUSP_TEST_RUN_HARNESS=${scope.harnessSlug} for a shell runner) and bind the NEW run id. The id you passed is real — it is simply unbindable.`
                : `test-run ${input.testRunId} EXISTS but belongs to harness '${found.harness_slug}' (workspace '${found.workspace_id ?? 'null'}'), not '${scope.harnessSlug}'. Bind a run recorded under this harness, or bind against the owning harness.`,
          },
        };
      }
    }

    const evidenceRef = input.evidenceRef.trim();
    const sourceFingerprint = input.sourceFingerprint.trim();
    const testFingerprint = nullableTrimmed(input.testFingerprint);
    const fixtureFingerprint = nullableTrimmed(input.fixtureFingerprint);
    const rubricFingerprint = nullableTrimmed(input.rubricFingerprint);
    const environmentFingerprint = nullableTrimmed(input.environmentFingerprint);
    // A replay that omits details is a partial update of an existing logical
    // binding, not a request to replace executable proof metadata with `{}`.
    // Explicit details (including `{}`) remain authoritative and retain the
    // append-only changed-proof behavior of binding_fingerprint.
    const priorDetails =
      input.details === undefined
        ? (
            await tx<{ details: Record<string, unknown> }[]>`
          SELECT details
            FROM harness_shared.spec_evidence_bindings
           WHERE workspace_id = ${scope.workspaceId}
             AND harness_slug = ${scope.harnessSlug}
             AND work_item_id = ${input.workItemId}
             AND plan_slug = ${planSlug}
             AND spec_id = ${identity.spec_id}
             AND spec_revision = ${specRevision}
             AND spec_fingerprint = ${revision.content_hash}
             AND evidence_kind = ${input.evidenceKind}
             AND evidence_ref = ${evidenceRef}
             AND source_fingerprint = ${sourceFingerprint}
             AND test_fingerprint IS NOT DISTINCT FROM ${testFingerprint}
             AND fixture_fingerprint IS NOT DISTINCT FROM ${fixtureFingerprint}
             AND rubric_fingerprint IS NOT DISTINCT FROM ${rubricFingerprint}
             AND environment_fingerprint IS NOT DISTINCT FROM ${environmentFingerprint}
             AND coverage_evidence_ref IS NOT DISTINCT FROM ${input.coverageEvidenceRef ?? null}
             AND test_run_id IS NOT DISTINCT FROM ${input.testRunId ?? null}
           ORDER BY observed_at DESC, id DESC
           LIMIT 1`
          )[0]?.details
        : undefined;

    const canonical: CanonicalBinding = {
      workspaceId: scope.workspaceId,
      harnessSlug: scope.harnessSlug,
      workItemId: input.workItemId,
      planSlug: planSlug,
      specId: identity.spec_id,
      specRevision,
      specFingerprint: revision.content_hash,
      evidenceKind: input.evidenceKind,
      evidenceRef,
      sourceFingerprint,
      testFingerprint,
      fixtureFingerprint,
      rubricFingerprint,
      environmentFingerprint,
      coverageEvidenceRef: input.coverageEvidenceRef ?? null,
      testRunId: input.testRunId ?? null,
      details: (canonicalJson(input.details ?? priorDetails ?? {}) ?? {}) as Record<string, unknown>,
    };
    const bindingFingerprint = specEvidenceBindingFingerprint(canonical);

    await tx`
      INSERT INTO harness_shared.work_item_spec_revision_edges (
        workspace_id, harness_slug, work_item_id, plan_slug, spec_id,
        spec_revision, spec_fingerprint, created_by
      ) VALUES (
        ${scope.workspaceId}, ${scope.harnessSlug}, ${input.workItemId}, ${planSlug},
        ${identity.spec_id}, ${specRevision}, ${revision.content_hash}, ${input.actorId}
      ) ON CONFLICT DO NOTHING`;

    const observedAt = input.observedAt ? new Date(input.observedAt) : new Date();
    const inserted = await tx<{ id: number }[]>`
      INSERT INTO harness_shared.spec_evidence_bindings (
        workspace_id, harness_slug, work_item_id, plan_slug, spec_id,
        spec_revision, spec_fingerprint, evidence_kind, evidence_ref,
        source_fingerprint, test_fingerprint, fixture_fingerprint,
        rubric_fingerprint, environment_fingerprint, coverage_evidence_ref,
        test_run_id, details, observed_at, binding_fingerprint, created_by
      ) VALUES (
        ${scope.workspaceId}, ${scope.harnessSlug}, ${input.workItemId}, ${planSlug},
        ${identity.spec_id}, ${specRevision}, ${revision.content_hash}, ${input.evidenceKind},
        ${canonical.evidenceRef}, ${canonical.sourceFingerprint}, ${canonical.testFingerprint},
        ${canonical.fixtureFingerprint}, ${canonical.rubricFingerprint},
        ${canonical.environmentFingerprint}, ${canonical.coverageEvidenceRef},
        ${canonical.testRunId}, ${JSON.stringify(canonical.details)}::text::jsonb,
        ${observedAt}, ${bindingFingerprint}, ${input.actorId}
      ) ON CONFLICT (
        workspace_id, harness_slug, work_item_id,
        plan_slug, spec_id, spec_revision, binding_fingerprint
      ) WHERE retracted_at IS NULL DO NOTHING
      RETURNING id`;

    const existing =
      inserted[0] ??
      (
        await tx<{ id: number }[]>`
      SELECT id FROM harness_shared.spec_evidence_bindings
       WHERE workspace_id = ${scope.workspaceId}
         AND harness_slug = ${scope.harnessSlug}
         AND work_item_id = ${input.workItemId}
         AND plan_slug = ${planSlug}
         AND spec_id = ${identity.spec_id}
         AND spec_revision = ${specRevision}
         AND binding_fingerprint = ${bindingFingerprint}
         AND retracted_at IS NULL`
      )[0];
    // The retraction filter is load-bearing, not defensive. This lookup only runs when the
    // INSERT above conflicted, and it reports the row the caller is told it now has bound.
    // Returning a RETRACTED row here would answer 'unchanged' while every reader excludes
    // that row by default — silent success with zero live evidence, which is precisely the
    // failure D-011's repair path exists to remove. Migration 1175 scopes the dedup index to
    // live rows so a retracted binding no longer blocks its replacement's insert; with both
    // halves in place a conflict can only mean a LIVE duplicate, and this lookup finds it.
    // If it does not, throwing is correct: a loud failure beats a wrong id.
    if (!existing) throw new Error(`spec_evidence_binding_insert_failed:${bindingFingerprint}`);

    return {
      status: inserted[0] ? 'created' : 'unchanged',
      id: Number(existing.id),
      workItemId: input.workItemId,
      planSlug: planSlug,
      specId: identity.spec_id,
      sourceValId: identity.source_val_id,
      specRevision,
      specFingerprint: revision.content_hash,
      bindingFingerprint,
    };
  });
}

export type FingerprintState = 'current' | 'stale' | 'unknown' | 'not-applicable';
export interface EvidenceCurrentInputIdentity {
  planSlug?: string;
  specId?: string;
  specRevision?: number;
  specFingerprint?: string;
}

export interface EvidenceCurrentInput extends EvidenceFingerprints {
  planSlug?: string;
  specId?: string;
  specRevision?: number;
  specFingerprint?: string;
  evidenceKind: SpecEvidenceKind;
  evidenceRef: string;
}

/**
 * Key a currentness tuple by exact clause identity when available. Historical
 * callers only supplied evidenceKind/evidenceRef, so those tuples retain a
 * separate legacy key and are consulted only as a fallback.
 */
export function evidenceCurrentInputKey(input: EvidenceCurrentInputIdentity & {
  evidenceKind: string;
  evidenceRef: string;
}): string {
  const scoped =
    input.planSlug !== undefined &&
    input.specId !== undefined &&
    input.specRevision !== undefined &&
    input.specFingerprint !== undefined;
  return JSON.stringify(
    scoped
      ? [
          'scoped',
          input.planSlug,
          input.specId,
          input.specRevision,
          input.specFingerprint,
          input.evidenceKind,
          input.evidenceRef,
        ]
      : ['legacy', input.evidenceKind, input.evidenceRef],
  );
}

/**
 * Provenance of the comparison used to classify a binding. Public tool inputs are
 * necessarily caller-attested: the caller supplies both fingerprints and the
 * comparison request. Only an internal server-measured path may establish a fresh
 * verdict.
 */
export type EvidenceCurrentnessProvenance =
  | 'server-measured'
  | 'partially-server-measured'
  | 'attested-current'
  | 'replayed-snapshot'
  | 'not-supplied';

type OpaqueFingerprintDimension = 'fixture' | 'rubric' | 'environment';

/** Trust metadata for the current-fingerprint tuple used by the classifier. */
interface CurrentnessClassificationOptions {
  provenance?: 'server-measured' | 'partially-server-measured' | 'replayed-snapshot';
  /** Applicable non-repository dimensions supplied by the caller beside server measurements. */
  attestedDimensions?: OpaqueFingerprintDimension[];
}

/**
 * A scorecard referenced as proof can still be a provisional working note.
 * Keep the source card's identity and stamp alongside the boolean flag so an
 * adequacy reader can audit the dependency without a second work-item lookup.
 */
export interface ProvisionalScorecardProof {
  issueId: string;
  stampedAt: string;
  violatableKeys: string[];
}

export interface EvidenceCurrentness {
  overall: Exclude<FingerprintState, 'not-applicable'>;
  dimensions: {
    spec: Exclude<FingerprintState, 'unknown' | 'not-applicable'>;
    source: Exclude<FingerprintState, 'not-applicable'>;
    test: FingerprintState;
    fixture: FingerprintState;
    rubric: FingerprintState;
    environment: FingerprintState;
    coverageEvidence: FingerprintState;
    testRun: FingerprintState;
  };
  staleReasons: string[];
  unknownReasons: string[];
  /**
   * Whether the CALLER actually supplied a current-fingerprint input for this row.
   *
   * WHY THIS EXISTS. `unknown` is produced by `compareFingerprint(stored, undefined)`,
   * i.e. by the caller not asking — not by anything uncertain about the evidence. A
   * reader that supplies no `current` therefore gets `unknown` on every row with a
   * stored fingerprint, and `source_fingerprint` is NOT NULL, so that is EVERY row.
   * Consumers which gate on uncertainty must distinguish "asked and got a gap" from
   * "never asked"; without this flag the two are indistinguishable and a gate reading
   * `unknown` as doubt becomes a constant refusal (WI-2146375).
   */
  comparisonSupplied: boolean;
  /**
   * Caller-supplied matching fingerprints are explicitly attested-current and are
   * capped at aggregate `unknown`; equality alone is not an independent measurement.
   */
  /** Optional only for legacy hand-built/internal fixtures; the classifier always emits it. */
  provenance?: EvidenceCurrentnessProvenance;
}

interface CurrentnessRow {
  spec_is_current: boolean;
  source_fingerprint: string;
  test_fingerprint: string | null;
  fixture_fingerprint: string | null;
  rubric_fingerprint: string | null;
  environment_fingerprint: string | null;
  coverage_evidence_ref: number | null;
  coverage_evidence_present: boolean;
  test_run_id: number | null;
  test_run_present: boolean;
}

function compareFingerprint(stored: string | null, current: string | null | undefined): FingerprintState {
  if (stored === null) return 'not-applicable';
  if (current == null) return 'unknown';
  return stored === current ? 'current' : 'stale';
}

/** Pure, four-state currentness classifier; no drifting boolean is persisted. */
export function classifySpecEvidenceCurrentness(
  row: CurrentnessRow,
  current?: EvidenceCurrentInput,
  options: CurrentnessClassificationOptions = {},
): EvidenceCurrentness {
  const dimensions: EvidenceCurrentness['dimensions'] = {
    spec: row.spec_is_current ? 'current' : 'stale',
    source: compareFingerprint(row.source_fingerprint, current?.sourceFingerprint) as 'current' | 'stale' | 'unknown',
    test: compareFingerprint(row.test_fingerprint, current?.testFingerprint),
    fixture: compareFingerprint(row.fixture_fingerprint, current?.fixtureFingerprint),
    rubric: compareFingerprint(row.rubric_fingerprint, current?.rubricFingerprint),
    environment: compareFingerprint(row.environment_fingerprint, current?.environmentFingerprint),
    coverageEvidence:
      row.coverage_evidence_ref === null ? 'not-applicable' : row.coverage_evidence_present ? 'current' : 'stale',
    testRun: row.test_run_id === null ? 'not-applicable' : row.test_run_present ? 'current' : 'stale',
  };
  const staleReasons = Object.entries(dimensions)
    .filter(([, state]) => state === 'stale')
    .map(([dimension]) => `${dimension}-stale`);
  const unknownReasons = Object.entries(dimensions)
    .filter(([, state]) => state === 'unknown')
    .map(([dimension]) => `${dimension}-current-fingerprint-not-supplied`);
  const attestedDimensions = [...new Set(options.attestedDimensions ?? [])].sort();
  const provenance: EvidenceCurrentnessProvenance =
    current === undefined
      ? 'not-supplied'
      : options.provenance === 'server-measured' && attestedDimensions.length > 0
        ? 'partially-server-measured'
        : options.provenance ?? 'attested-current';
  // A replayed snapshot is NOT an independent measurement: on the replay path the
  // server skips measuring entirely and the whole `current` tuple arrives from the
  // caller, so labelling it 'server-measured' would launder a caller assertion into
  // server proof. Guard it exactly like an attested tuple — the caller can still
  // reproduce a historical grade, but cannot mint a fresh-freshness verdict from
  // fingerprints it authored itself.
  const attestedCurrentGuard =
    (provenance === 'attested-current' ||
      provenance === 'partially-server-measured' ||
      provenance === 'replayed-snapshot') &&
    staleReasons.length === 0
      ? [
          provenance === 'partially-server-measured'
            ? `current-fingerprints-partially-attested-not-independently-measured:${attestedDimensions.join(',')}`
            : provenance === 'replayed-snapshot'
              ? 'current-fingerprints-replayed-not-independently-measured'
              : 'current-fingerprints-attested-not-independently-measured',
        ]
      : [];
  const guardedUnknownReasons = [...unknownReasons, ...attestedCurrentGuard];
  return {
    overall: staleReasons.length > 0 ? 'stale' : guardedUnknownReasons.length > 0 ? 'unknown' : 'current',
    dimensions,
    staleReasons,
    unknownReasons: guardedUnknownReasons,
    comparisonSupplied: current != null,
    provenance,
  };
}

interface EvidenceRow extends CurrentnessRow {
  id: number;
  work_item_id: string;
  plan_slug: string;
  spec_id: string;
  source_val_id: string | null;
  spec_revision: number;
  current_revision: number;
  spec_fingerprint: string;
  evidence_kind: SpecEvidenceKind;
  evidence_ref: string;
  details: Record<string, unknown>;
  observed_at: Date | string;
  binding_fingerprint: string;
  created_by: string;
  created_at: Date | string;
  /**
   * Withdrawal stamp (migration 1174). NULL on live proof; set all-three-or-none, once,
   * and never cleared — the row itself is never deleted, so a withdrawn claim stays
   * auditable. Only an `includeRetracted` read can see a row with these set.
   */
  retracted_at: Date | string | null;
  retracted_by: string | null;
  retraction_reason: string | null;
  test_run_file_path: string | null;
  test_run_commit_sha: string | null;
  test_run_worktree_dirty: boolean | null;
  provisionalProofBase?: boolean;
  provisionalScorecard?: ProvisionalScorecardProof;
}

function scorecardIssueIdFromEvidenceRef(evidenceRef: string): string | null {
  const match = /^scorecard:([^#\s]+)(?:#.*)?$/.exec(evidenceRef.trim());
  return match?.[1] ?? null;
}

function parseProvisionalScorecardProof(issueId: string, value: unknown): ProvisionalScorecardProof | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const violatableKeys = Array.isArray(raw.violatableKeys)
    ? raw.violatableKeys.filter((key): key is string => typeof key === 'string' && key.trim() !== '')
    : [];
  if (violatableKeys.length === 0 || typeof raw.stampedAt !== 'string' || raw.stampedAt.trim() === '') return null;
  return { issueId, stampedAt: raw.stampedAt, violatableKeys };
}

export interface ListSpecEvidenceOptions {
  harnessSlug?: string;
  /**
   * The plan namespaces to read evidence from — an ARRAY, not a single slug, since P-013.
   *
   * WHY IT HAD TO WIDEN. D-012/D-013 made a work item's contract span plan namespaces: an
   * edge can name a clause in a plan the item is not stamped with. Once the completion
   * gate ENFORCES those cross-namespace clauses (P-013), a single-plan evidence read makes
   * every one of them find ZERO rows and refuse SPURIOUSLY — the gate would demand proof it
   * had just made itself unable to see. So the enforced clause set and the evidence read
   * must be scoped by the SAME set of namespaces, always.
   *
   * It is one query with `plan_slug = ANY(...)`, deliberately, not an N-plan fan-out: the
   * 1000-row safety limit callers apply is a limit on the WHOLE selection, and N separate
   * capped queries cannot honour one shared cap.
   *
   * An EMPTY array selects nothing, which is the honest reading of "no eligible namespace".
   */
  planSlugs: string[];
  workItemIds?: string[];
  specIds?: string[];
  sourceValIds?: string[];
  evidenceKinds?: SpecEvidenceKind[];
  evidenceRefs?: string[];
  current?: EvidenceCurrentInput[];
  /** Pin reads to one immutable clause revision instead of the live revision pointer. */
  specRevision?: number;
  /** Optional content hash paired with specRevision for an exact immutable pin. */
  specFingerprint?: string;
  /** Replay the supplied current tuple as a prior server measurement; never re-read live files. */
  replaySnapshot?: boolean;
  /** Provenance for a replayed current tuple. */
  currentProvenance?: 'server-measured' | 'partially-server-measured' | 'replayed-snapshot';
  currentness?: Array<'current' | 'stale' | 'unknown'>;
  /**
   * Include bindings that were deliberately WITHDRAWN (migration 1174, decision D-011).
   *
   * Defaults to false, and that default is the whole point: the spec-test-adequacy
   * evaluator scans EVERY row of a (spec, revision) cohort — execution-integrity fails
   * the clause if ANY binding names a run that was never collected or executed, and
   * freshness fails it if ANY binding has gone stale — so one malformed binding
   * permanently bricks its clause. Appending a corrected row cannot outrank the bad one
   * (this loader has no DISTINCT ON; both rows are read), and spec_revision is the only
   * partitioning dimension, so before 1174 the only escape was bumping the clause
   * revision purely to shed the failing evidence. D-011 rules that out as gate evasion.
   *
   * So a retraction is what a default read must NOT see, or it repairs nothing. Pass
   * true only for an AUDIT read — one that must show what was withdrawn, by whom and
   * why — never from an evaluator, a gate, or anything that counts evidence.
   */
  includeRetracted?: boolean;
  limit?: number;
}

export interface WorkItemSpecRevisionEdge {
  workItemId: string;
  planSlug: string;
  specId: string;
  specRevision: number;
  specFingerprint: string;
}

export interface EnsureWorkItemSpecRevisionEdgesInput {
  workspaceId: string;
  harnessSlug: string;
  planSlug: string;
  planItemIds: readonly string[];
  workItemId: string;
  actorId: string;
}

async function writeWorkItemSpecRevisionEdges(
  input: EnsureWorkItemSpecRevisionEdgesInput,
  tx: SpecClauseSql,
): Promise<WorkItemSpecRevisionEdge[]> {
  const planItemIds = [...new Set(input.planItemIds.map((id) => id.trim()).filter(Boolean))];
  if (planItemIds.length === 0) return [];

  await tx`
    INSERT INTO harness_shared.work_item_spec_revision_edges (
      workspace_id, harness_slug, work_item_id, plan_slug, spec_id,
      spec_revision, spec_fingerprint, created_by
    )
    SELECT c.workspace_id, c.harness_slug, ${input.workItemId}, c.plan_slug,
           c.spec_id, c.current_revision, r.content_hash, ${input.actorId}
      FROM harness_shared.plan_spec_clauses c
      JOIN harness_shared.plan_spec_clause_revisions r
        ON r.workspace_id = c.workspace_id
       AND r.harness_slug = c.harness_slug
       AND r.plan_slug = c.plan_slug
       AND r.spec_id = c.spec_id
       AND r.revision = c.current_revision
     WHERE c.workspace_id = ${input.workspaceId}
       AND c.harness_slug = ${input.harnessSlug}
       AND c.plan_slug = ${input.planSlug}
       AND r.plan_item_id = ANY(${planItemIds}::text[])
    ON CONFLICT DO NOTHING`;

  const rows = await tx<{
    work_item_id: string;
    plan_slug: string;
    spec_id: string;
    spec_revision: number | string;
    spec_fingerprint: string;
  }[]>`
    SELECT work_item_id, plan_slug, spec_id, spec_revision, spec_fingerprint
      FROM harness_shared.work_item_spec_revision_edges
     WHERE workspace_id = ${input.workspaceId}
       AND harness_slug = ${input.harnessSlug}
       AND work_item_id = ${input.workItemId}
       AND plan_slug = ${input.planSlug}
     ORDER BY spec_id, spec_revision`;
  return rows.map((row) => ({
    workItemId: row.work_item_id,
    planSlug: row.plan_slug,
    specId: row.spec_id,
    specRevision: Number(row.spec_revision),
    specFingerprint: row.spec_fingerprint,
  }));
}

/**
 * Attach a promoted work-item to every current spec revision owned by its plan
 * item.  Promotion is the first moment the canonical work-item id exists, so
 * this is the join that turns activation's BAR/spec projection into an
 * executable behavior contract.  The edge is append-only: a later clause
 * revision gets a new edge, while old edges remain auditable and are reported
 * stale by the resolver.
 */
export async function ensureWorkItemSpecRevisionEdges(
  input: EnsureWorkItemSpecRevisionEdgesInput,
): Promise<WorkItemSpecRevisionEdge[]> {
  return withWorkspace(input.workspaceId, async (tx) => {
    return writeWorkItemSpecRevisionEdges(input, tx as unknown as SpecClauseSql);
  });
}

/**
 * Attach current clause revisions to every already-existing work-item that
 * names one of the supplied plan items. Activation can run after promotion,
 * so this repair must cover terminal rows as well as live rows and must not
 * mint a replacement work-item. All provenance legs are read in the same
 * caller-supplied transaction as the BAR/spec writes.
 */
export async function ensureExistingWorkItemSpecRevisionEdgesInTransaction(
  input: Omit<EnsureWorkItemSpecRevisionEdgesInput, 'workItemId'>,
  tx: SpecClauseSql,
): Promise<WorkItemSpecRevisionEdge[]> {
  const planItemIds = [...new Set(input.planItemIds.map((id) => id.trim()).filter(Boolean))];
  if (planItemIds.length === 0) return [];

  // The feature-family coord plane historically lives in `default`, while
  // issue-family links follow the active workspace when COORD_PER_WORKSPACE is
  // enabled. Read both without changing the scheduler or claim specification.
  const coordWorkspaceIds = [...new Set([input.workspaceId, DEFAULT_COORD_WORKSPACE])];
  const planItemRefs = planItemIds.map((itemId) => planItemRef(input.planSlug, itemId));
  const rows = await tx<{ work_item_id: string; plan_item_id: string }[]>`
    WITH provenance AS (
      SELECT wi.feature_id AS work_item_id,
             source_item.item_id AS plan_item_id
        FROM harness_shared.work_items wi
        CROSS JOIN LATERAL unnest(COALESCE(wi.source_plan_item_ids, ARRAY[]::text[]))
          AS source_item(item_id)
       WHERE wi.workspace_id = ANY(${coordWorkspaceIds}::text[])
         AND wi.harness_slug = ${input.harnessSlug}
         AND wi.source_plan_slug = ${input.planSlug}
      UNION
      SELECT wi.feature_id AS work_item_id,
             wi.payload->'plan_item'->>'item_id' AS plan_item_id
        FROM harness_shared.work_items wi
       WHERE wi.workspace_id = ANY(${coordWorkspaceIds}::text[])
         AND wi.harness_slug = ${input.harnessSlug}
         AND wi.payload->'plan_item'->>'plan_slug' = ${input.planSlug}
      UNION
      SELECT wi.feature_id AS work_item_id,
             split_part(l.dst_ref, '#', 2) AS plan_item_id
        FROM harness_shared.coord_links l
        JOIN harness_shared.work_items wi
          ON wi.workspace_id = l.workspace_id
         AND wi.harness_slug = ${input.harnessSlug}
         AND (
           (l.src_kind = 'issue' AND wi.feature_id = l.src_ref)
           OR (
             l.src_kind = 'feature'
             AND wi.feature_id = split_part(l.src_ref, '#', 2)
             AND wi.harness_slug = split_part(l.src_ref, '#', 1)
           )
         )
       WHERE l.workspace_id = ANY(${coordWorkspaceIds}::text[])
         AND l.rel = ANY(${['implements', 'relates']}::text[])
         AND l.dst_kind = 'plan_item'
         AND l.dst_ref = ANY(${planItemRefs}::text[])
    )
    SELECT DISTINCT work_item_id, plan_item_id
      FROM provenance
     WHERE plan_item_id = ANY(${planItemIds}::text[])
     ORDER BY work_item_id, plan_item_id`;

  const planItemsByWorkItem = new Map<string, string[]>();
  for (const row of rows) {
    const ids = planItemsByWorkItem.get(row.work_item_id) ?? [];
    if (!ids.includes(row.plan_item_id)) ids.push(row.plan_item_id);
    planItemsByWorkItem.set(row.work_item_id, ids);
  }

  const edges: WorkItemSpecRevisionEdge[] = [];
  for (const [workItemId, workItemPlanItemIds] of planItemsByWorkItem) {
    edges.push(...await writeWorkItemSpecRevisionEdges({
      ...input,
      planItemIds: workItemPlanItemIds,
      workItemId,
    }, tx));
  }
  return edges;
}

/** Read the explicit many-to-many coverage edges for one work item. */
export async function listWorkItemSpecRevisionEdges(options: {
  harnessSlug?: string;
  /**
   * OMIT to read every namespace. D-013: a work item may link to clauses in any
   * plan namespace regardless of its own source-plan provenance, so the universal
   * resolver needs the unscoped read. Widened here rather than added as a sibling
   * reader — two readers over one edge table is how the two drift apart.
   */
  planSlug?: string;
  workItemId: string;
}): Promise<WorkItemSpecRevisionEdge[]> {
  const scope = await resolvePlanScope({ harnessSlug: options.harnessSlug });
  const planSlug = options.planSlug;
  const rows = await withWorkspace(
    scope.workspaceId,
    async (tx) => tx<{
      work_item_id: string;
      plan_slug: string;
      spec_id: string;
      spec_revision: number;
      spec_fingerprint: string;
    }[]>`
      SELECT work_item_id, plan_slug, spec_id, spec_revision, spec_fingerprint
        FROM harness_shared.work_item_spec_revision_edges
       WHERE workspace_id = ${scope.workspaceId}
         AND harness_slug = ${scope.harnessSlug}
         AND work_item_id = ${options.workItemId}
         ${planSlug === undefined ? tx`` : tx`AND plan_slug = ${planSlug}`}
       ORDER BY plan_slug, spec_id, spec_revision`,
  );
  return rows.map((row) => ({
    workItemId: row.work_item_id,
    planSlug: row.plan_slug,
    specId: row.spec_id,
    specRevision: Number(row.spec_revision),
    specFingerprint: row.spec_fingerprint,
  }));
}

export interface RetractSpecEvidenceOptions {
  harnessSlug?: string;
  /**
   * The exact binding row to withdraw, as returned by plans:get-spec-evidence.
   *
   * Deliberately the row id and never a (workItemId, evidenceRef) pair: changed
   * fingerprints APPEND history, so that pair routinely matches several rows and a
   * retraction is one-way and per-row. Targeting by id forces the caller to have
   * actually looked at the row they are withdrawing.
   */
  bindingId: number;
  reason: string;
  actorId: string;
}

export interface RetractedBindingRow {
  id: number;
  work_item_id: string;
  plan_slug: string;
  spec_id: string;
  spec_revision: number;
  evidence_kind: SpecEvidenceKind;
  evidence_ref: string;
  retracted_at: Date | string | null;
  retracted_by: string | null;
  retraction_reason: string | null;
}

/**
 * Record a one-way, attributable withdrawal of a single evidence binding (D-011).
 *
 * The row is never deleted and never edited — it acquires a stamp, and default reads
 * stop counting it while an `includeRetracted` audit read still returns it in full.
 * This is the ONLY sanctioned repair for a malformed binding: because the adequacy
 * evaluator fails a clause if ANY bound row is uncollected/unexecuted or stale, and
 * spec_revision is its only partitioning dimension, the alternative was bumping a
 * clause revision purely to shed failing evidence — which D-011 forbids as gate
 * evasion, since a bar whose hash moved has genuinely different meaning.
 */
export async function retractSpecEvidence(options: RetractSpecEvidenceOptions) {
  const scope = await resolvePlanScope({ harnessSlug: options.harnessSlug });
  const reason = options.reason.trim();
  const actorId = options.actorId.trim();
  return withWorkspace(scope.workspaceId, async (tx) => {
    const [existing] = await tx<RetractedBindingRow[]>`
      SELECT id, work_item_id, plan_slug, spec_id, spec_revision,
             evidence_kind, evidence_ref, retracted_at, retracted_by, retraction_reason
        FROM harness_shared.spec_evidence_bindings
       WHERE workspace_id = ${scope.workspaceId}
         AND harness_slug = ${scope.harnessSlug}
         AND id = ${options.bindingId}`;
    // Not-found and already-retracted are reported as statuses rather than thrown: a
    // retraction is idempotent from the caller's side, and the trigger's own
    // re-retraction error would otherwise surface as an opaque 55000 for the benign
    // case of replaying the same repair.
    if (!existing) return { status: 'not_found' as const, bindingId: options.bindingId, binding: null };
    if (existing.retracted_at != null) return { status: 'already_retracted' as const, bindingId: existing.id, binding: existing };
    const [updated] = await tx<RetractedBindingRow[]>`
      UPDATE harness_shared.spec_evidence_bindings
         SET retracted_at = now(), retracted_by = ${actorId}, retraction_reason = ${reason}
       WHERE workspace_id = ${scope.workspaceId}
         AND harness_slug = ${scope.harnessSlug}
         AND id = ${options.bindingId}
         AND retracted_at IS NULL
      RETURNING id, work_item_id, plan_slug, spec_id, spec_revision,
                evidence_kind, evidence_ref, retracted_at, retracted_by, retraction_reason`;
    if (!updated) return { status: 'already_retracted' as const, bindingId: existing.id, binding: existing };
    return { status: 'retracted' as const, bindingId: updated.id, binding: updated };
  });
}

export interface SupersedeSpecEvidenceOptions {
  harnessSlug?: string;
  /** The resolved spec scope slug the superseding binding landed in (bind result `planSlug`). */
  planSlug: string;
  specId: string;
  specRevision: number;
  evidenceKind: SpecEvidenceKind;
  /** The binding doing the superseding; named in every retraction reason. */
  supersedingBindingId: number;
  /** Rows bound in the same call — never retracted by their own sibling. */
  keepBindingIds: readonly number[];
  actorId: string;
}

/**
 * P-019 (review-system-rework-reduction-2026-09-23): withdraw, in ONE statement, every other
 * live row of the same evidence kind at one clause revision, stamped as superseded by the
 * named binding (D-011: stamped, never deleted, still returned by includeRetracted reads).
 *
 * The adequacy evaluator grades every live row at a revision, so one old weak, stale or
 * failing row fails a criterion beside newer sufficient proof — measured on R-11, where a
 * fresh targeted mutation proof could not pass the bar until 13 older rows were retracted by
 * hand. Scoped to the same evidence KIND on purpose: a fresh test row must never withdraw the
 * clause's mutation proof, which is a different obligation. Runs AFTER the superseding bind
 * commits, so a failure here leaves the old rows live and never loses proof.
 */
export async function supersedeSpecEvidenceAtRevision(options: SupersedeSpecEvidenceOptions) {
  const scope = await resolvePlanScope({ harnessSlug: options.harnessSlug });
  const actorId = options.actorId.trim();
  const reason = `superseded by binding ${options.supersedingBindingId} (plans:bind-spec-evidence supersedeAtRevision)`;
  const keep = [...new Set([options.supersedingBindingId, ...options.keepBindingIds])];
  return withWorkspace(scope.workspaceId, async (tx) =>
    tx<RetractedBindingRow[]>`
      UPDATE harness_shared.spec_evidence_bindings
         SET retracted_at = now(), retracted_by = ${actorId}, retraction_reason = ${reason}
       WHERE workspace_id = ${scope.workspaceId}
         AND harness_slug = ${scope.harnessSlug}
         AND plan_slug = ${options.planSlug}
         AND spec_id = ${options.specId}
         AND spec_revision = ${options.specRevision}
         AND evidence_kind = ${options.evidenceKind}
         AND retracted_at IS NULL
         AND NOT (id = ANY(${keep}::bigint[]))
      RETURNING id, work_item_id, plan_slug, spec_id, spec_revision,
                evidence_kind, evidence_ref, retracted_at, retracted_by, retraction_reason`,
  );
}

export async function listSpecEvidence(options: ListSpecEvidenceOptions) {
  // No namespace selected can never match a row, so say so without a round-trip. Kept
  // explicit rather than leaning on `= ANY('{}')`: a reader must not have to know that
  // Postgres happens to return nothing, and the alternative reading — an empty filter
  // meaning "every plan" — is the exact silent-widening this whole plan exists to remove.
  if (options.planSlugs.length === 0) return [];
  const scope = await resolvePlanScope({ harnessSlug: options.harnessSlug });
  const planSlugs = options.planSlugs;
  const workItemIds = options.workItemIds ?? [];
  const specIds = options.specIds ?? [];
  const sourceValIds = options.sourceValIds ?? [];
  const evidenceKinds = options.evidenceKinds ?? [];
  const evidenceRefs = options.evidenceRefs ?? [];
  const limit = options.limit ?? 200;
  const includeRetracted = options.includeRetracted === true;
  const specRevision = options.specRevision;
  const specFingerprint = options.specFingerprint;
  const replayCurrent = options.current ?? [];
  // Completion gates can span several clauses, while each scorecard rerun recipe pins one.
  // For a multi-clause replay, current[] already carries the exact tuple per evidence row;
  // preserve those tuples instead of applying one scalar fingerprint to every clause.
  const replayCurrentHasFullClauseIdentity = replayCurrent.length > 0 && replayCurrent.every(
    (current) =>
      typeof current.planSlug === 'string' && current.planSlug.trim() !== '' &&
      typeof current.specId === 'string' && current.specId.trim() !== '' &&
      current.specRevision !== undefined &&
      typeof current.specFingerprint === 'string' && current.specFingerprint.trim() !== '',
  );
  const replayClausePins = replayCurrentHasFullClauseIdentity
    ? [...new Map(replayCurrent.map((current) => {
        const pin = {
          planSlug: current.planSlug!,
          specId: current.specId!,
          specRevision: current.specRevision!,
          specFingerprint: current.specFingerprint!,
        };
        return [JSON.stringify(pin), pin] as const;
      })).values()]
    : [];
  const rows = await withWorkspace(
    scope.workspaceId,
    async (tx) => {
      const replayClausePinMatch = replayClausePins.length > 0
        ? tx`EXISTS (
            SELECT 1
              FROM unnest(
                ${replayClausePins.map((pin) => pin.planSlug)}::text[],
                ${replayClausePins.map((pin) => pin.specId)}::text[],
                ${replayClausePins.map((pin) => pin.specRevision)}::int[],
                ${replayClausePins.map((pin) => pin.specFingerprint)}::text[]
              ) AS requested(plan_slug, spec_id, spec_revision, spec_fingerprint)
             WHERE requested.plan_slug = b.plan_slug
               AND requested.spec_id = b.spec_id
               AND requested.spec_revision = b.spec_revision
               AND requested.spec_fingerprint = b.spec_fingerprint
          )`
        : undefined;
      const replaySinglePinMatch = specRevision !== undefined
        ? tx`(
            b.spec_revision = ${specRevision}
            AND (${specFingerprint ?? null}::text IS NULL OR b.spec_fingerprint = ${specFingerprint ?? null})
          )`
        : undefined;
      const replaySnapshotMatch = options.replaySnapshot
        ? replaySinglePinMatch ?? replayClausePinMatch ?? tx`FALSE`
        : tx`TRUE`;
      const evidenceClauseFilter = options.replaySnapshot
        ? replaySnapshotMatch
        : tx`(
            (${specRevision ?? null}::int IS NULL OR b.spec_revision = ${specRevision ?? null})
            AND (${specFingerprint ?? null}::text IS NULL OR b.spec_fingerprint = ${specFingerprint ?? null})
          )`;
      const specIsCurrent = options.replaySnapshot
        ? replaySnapshotMatch
        : tx`(b.spec_revision = c.current_revision AND b.spec_fingerprint = r.content_hash)`;
      const rows = await tx<EvidenceRow[]>`
    SELECT b.id, b.work_item_id, b.plan_slug, b.spec_id, c.source_val_id,
           b.spec_revision, c.current_revision, b.spec_fingerprint,
           b.evidence_kind, b.evidence_ref, b.source_fingerprint,
           b.test_fingerprint, b.fixture_fingerprint, b.rubric_fingerprint,
           b.environment_fingerprint, b.coverage_evidence_ref, b.test_run_id,
           b.details, b.observed_at, b.binding_fingerprint, b.created_by, b.created_at,
           b.retracted_at, b.retracted_by, b.retraction_reason,
           tr.file_path AS test_run_file_path,
           tr.commit_sha AS test_run_commit_sha,
           tr.worktree_dirty AS test_run_worktree_dirty,
           ${specIsCurrent} AS spec_is_current,
           (b.coverage_evidence_ref IS NOT NULL AND EXISTS (
              SELECT 1 FROM harness_shared.coverage_evidence ce
              JOIN harness_shared.testing_surfaces s ON s.id = ce.surface_ref
             WHERE ce.id = b.coverage_evidence_ref
               AND s.workspace_id = b.workspace_id AND s.harness_slug = b.harness_slug
           )) AS coverage_evidence_present,
           (b.test_run_id IS NOT NULL AND EXISTS (
              SELECT 1 FROM harness_shared.test_runs tr
               WHERE tr.id = b.test_run_id
                 AND tr.workspace_id = b.workspace_id AND tr.harness_slug = b.harness_slug
           )) AS test_run_present
      FROM harness_shared.spec_evidence_bindings b
      LEFT JOIN harness_shared.test_runs tr
        ON tr.id = b.test_run_id
       AND tr.workspace_id = b.workspace_id AND tr.harness_slug = b.harness_slug
      JOIN harness_shared.plan_spec_clauses c
        ON c.workspace_id = b.workspace_id AND c.harness_slug = b.harness_slug
       AND c.plan_slug = b.plan_slug AND c.spec_id = b.spec_id
      JOIN harness_shared.plan_spec_clause_revisions r
        ON r.workspace_id = b.workspace_id AND r.harness_slug = b.harness_slug
       AND r.plan_slug = b.plan_slug AND r.spec_id = b.spec_id
       AND r.revision = b.spec_revision
     WHERE b.workspace_id = ${scope.workspaceId}
       AND b.harness_slug = ${scope.harnessSlug}
       AND b.plan_slug = ANY(${planSlugs}::text[])
       AND ${evidenceClauseFilter}
       AND (${workItemIds.length} = 0 OR b.work_item_id = ANY(${workItemIds}::text[]))
       AND (${specIds.length} = 0 OR b.spec_id = ANY(${specIds}::text[]))
       AND (${sourceValIds.length} = 0 OR c.source_val_id = ANY(${sourceValIds}::text[]))
       AND (${evidenceKinds.length} = 0 OR b.evidence_kind = ANY(${evidenceKinds}::text[]))
       AND (${evidenceRefs.length} = 0 OR b.evidence_ref = ANY(${evidenceRefs}::text[]))
       AND (${includeRetracted}::boolean IS TRUE OR b.retracted_at IS NULL)
     ORDER BY b.observed_at DESC, b.id DESC
      LIMIT ${limit}`;
      const scorecardIds = [
        ...new Set(
          rows
            .map((row) => scorecardIssueIdFromEvidenceRef(row.evidence_ref))
            .filter((issueId): issueId is string => issueId !== null),
        ),
      ];
      if (scorecardIds.length === 0) return rows;

      const scorecards = await tx<{ feature_id: string; provisional: unknown }[]>`
        SELECT feature_id, payload -> 'observation' -> 'provisional' AS provisional
          FROM harness_shared.work_items
         WHERE workspace_id = ${scope.workspaceId}
           AND harness_slug = ${scope.harnessSlug}
           AND feature_id = ANY(${scorecardIds}::text[])
           AND payload -> 'observation' -> 'provisional' IS NOT NULL`;
      const provisionalById = new Map<string, ProvisionalScorecardProof>();
      for (const scorecard of scorecards) {
        const proof = parseProvisionalScorecardProof(scorecard.feature_id, scorecard.provisional);
        if (proof) provisionalById.set(scorecard.feature_id, proof);
      }
      return rows.map((row) => {
        const issueId = scorecardIssueIdFromEvidenceRef(row.evidence_ref);
        const provisionalScorecard = issueId ? provisionalById.get(issueId) : undefined;
        return provisionalScorecard
          ? { ...row, provisionalProofBase: true, provisionalScorecard }
          : row;
      });
    },
  );

  const currentByKey = new Map((options.current ?? []).map((c) => [evidenceCurrentInputKey(c), c]));
  const measurementRoots = new Map<string, Promise<string>>();
  const serverMeasurements = await Promise.all(
    rows.map(async (row) => {
      // A REPLAY RE-MEASURES UNLESS THE CALLER HANDS US SERVER-MEASURED PROOF.
      // `currentProvenance:'server-measured'` is a caller saying "this pinned tuple is
      // already server-measured; replay it as-is, do not read the live repository" —
      // that opt-out is deliberate and stays exactly as it was.
      //
      // Every OTHER replay now measures. `replaySnapshot` pins the immutable CLAUSE
      // SNAPSHOT (see specIsCurrent above); it must NOT also suppress the per-binding
      // server measurement. It used to, and that made scorecards:emit structurally
      // unable to certify freshness='pass' on ANY card: rerunRecipeFor always emits
      // replaySnapshot:true PLUS a matching `current` tuple, so with measurement
      // suppressed the classifier saw nothing but caller-authored fingerprints,
      // attestedCurrentGuard fired precisely BECAUSE nothing was stale, and the replay
      // was capped at 'unknown'. emit's gate requires the exact replay to reproduce
      // every pass the card claims — so the evaluator's own recipe could not reproduce
      // the evaluator's own verdict (WI-10002320, reproduced twice on P-023).
      //
      // Re-measuring launders nothing, which is what the suppression was protecting:
      // `measured.current` is spread LAST so server values win over any caller tuple,
      // source/test are never counted as attested, and an opaque dimension the caller
      // supplied still degrades provenance to 'partially-server-measured' below. A
      // binding with no persisted measurement basis is still labelled
      // 'replayed-snapshot' and still capped. It is also the semantically correct
      // behaviour for a FRESHNESS criterion: a card must stop replaying 'pass' once the
      // code it was bound against moves.
      if (options.replaySnapshot && options.currentProvenance === 'server-measured') return null;
      const recipe = measurementFromDetails(row.details);
      if (!recipe) return null;
      try {
        let measured: MeasuredRepoEvidenceFingerprints;
        let files: MeasuredRepoFile[] | null = null;
        if (recipe.kind === 'work-items') {
          // Ledger state has no checkout to resolve: the digest is recomputed from the rows.
          measured = await measureWorkItemsEvidenceForScope(scope.workspaceId, scope.harnessSlug, recipe);
        } else {
          const rootHarnessSlug = recipe.rootHarnessSlug ?? scope.harnessSlug;
          const measurementRoot =
            measurementRoots.get(rootHarnessSlug) ??
            resolveMeasurementRoot(scope.workspaceId, scope.harnessSlug, recipe);
          measurementRoots.set(rootHarnessSlug, measurementRoot);
          // Same single read as before; the per-file hashes it now also returns are what
          // name the moved paths below at zero extra IO.
          const detailed = await measureRepoFilesEvidenceDetailedAtRoot(await measurementRoot, recipe);
          measured = { sourceFingerprint: detailed.sourceFingerprint, testFingerprint: detailed.testFingerprint };
          files = detailed.files;
        }
        return {
          status: 'measured' as const,
          files,
          current: {
            planSlug: row.plan_slug,
            specId: row.spec_id,
            specRevision: Number(row.spec_revision),
            specFingerprint: row.spec_fingerprint,
            evidenceKind: row.evidence_kind,
            evidenceRef: row.evidence_ref,
            ...measured,
          } satisfies EvidenceCurrentInput,
        };
      } catch (error: unknown) {
        return {
          status: 'unavailable' as const,
          reason: (error instanceof Error ? error.message : String(error)).slice(0, 240),
        };
      }
    }),
  );
  const classified = rows.map((row, index) => {
    const measured = serverMeasurements[index];
    const scopedCurrentKey = evidenceCurrentInputKey({
      planSlug: row.plan_slug,
      specId: row.spec_id,
      specRevision: Number(row.spec_revision),
      specFingerprint: row.spec_fingerprint,
      evidenceKind: row.evidence_kind,
      evidenceRef: row.evidence_ref,
    });
    const legacyCurrentKey = evidenceCurrentInputKey({
      evidenceKind: row.evidence_kind,
      evidenceRef: row.evidence_ref,
    });
    const callerCurrent = currentByKey.get(scopedCurrentKey) ?? currentByKey.get(legacyCurrentKey);
    const attestedDimensions: OpaqueFingerprintDimension[] =
      measured?.status === 'measured'
        ? [
            ...(row.fixture_fingerprint !== null && callerCurrent?.fixtureFingerprint != null
              ? (['fixture'] as const)
              : []),
            ...(row.rubric_fingerprint !== null && callerCurrent?.rubricFingerprint != null
              ? (['rubric'] as const)
              : []),
            ...(row.environment_fingerprint !== null && callerCurrent?.environmentFingerprint != null
              ? (['environment'] as const)
              : []),
          ]
        : [];
    const current =
      measured?.status === 'measured'
        ? { ...callerCurrent, ...measured.current }
        : callerCurrent;
    const replayProvenance =
      options.replaySnapshot && options.currentProvenance
        ? { provenance: options.currentProvenance }
        : {};
    const currentness = classifySpecEvidenceCurrentness(
      row,
      current,
      measured?.status === 'measured'
        ? { provenance: 'server-measured', attestedDimensions }
        : replayProvenance,
    );
    if (measured?.status === 'unavailable' && currentness.overall === 'unknown') {
      currentness.unknownReasons = [...currentness.unknownReasons, `server-measurement-unavailable:${measured.reason}`];
    }
    // P-018: a source/test-stale verdict now names WHICH measured files moved. Only for a
    // row that is stale on those dimensions — a current row has nothing to name, and a
    // row that predates the pin reports `pinned:false` rather than an empty (false) list.
    const fileStale = currentness.staleReasons.some((reason) => reason === 'source-stale' || reason === 'test-stale');
    const movement =
      fileStale && measured?.status === 'measured' && measured.files
        ? diffMeasuredFiles(readMeasurementPin(row.details), measured.files)
        : null;
    return {
      id: Number(row.id),
      workItemId: row.work_item_id,
      planSlug: row.plan_slug,
      specId: row.spec_id,
      sourceValId: row.source_val_id,
      specRevision: Number(row.spec_revision),
      currentRevision: Number(row.current_revision),
      specFingerprint: row.spec_fingerprint,
      evidenceKind: row.evidence_kind,
      evidenceRef: row.evidence_ref,
      fingerprints: {
        sourceFingerprint: row.source_fingerprint,
        testFingerprint: row.test_fingerprint,
        fixtureFingerprint: row.fixture_fingerprint,
        rubricFingerprint: row.rubric_fingerprint,
        environmentFingerprint: row.environment_fingerprint,
      },
      coverageEvidenceRef: row.coverage_evidence_ref === null ? null : Number(row.coverage_evidence_ref),
      testRunId: row.test_run_id === null ? null : Number(row.test_run_id),
      testRunProvenance: row.test_run_id === null || row.test_run_file_path == null
        ? null
        : {
            filePath: row.test_run_file_path,
            commitSha: row.test_run_commit_sha,
            worktreeDirty: row.test_run_worktree_dirty,
          },
      details: row.provisionalProofBase
        ? {
            ...row.details,
            provisionalProofBase: true,
            ...(row.provisionalScorecard ? { provisionalScorecard: row.provisionalScorecard } : {}),
          }
        : row.details,
      ...(row.provisionalProofBase ? { provisionalProofBase: true } : {}),
      ...(row.provisionalScorecard ? { provisionalScorecard: row.provisionalScorecard } : {}),
      observedAt: pgTimestampToIso(row.observed_at),
      bindingFingerprint: row.binding_fingerprint,
      createdBy: row.created_by,
      createdAt: pgTimestampToIso(row.created_at),
      ...(measured
        ? {
            serverMeasurement:
              measured.status === 'measured'
                ? {
                    status: measured.status,
                    measuredDimensions: [
                      'source',
                      ...(measured.current.testFingerprint === null ? [] : ['test']),
                    ],
                    ...(attestedDimensions.length > 0 ? { attestedDimensions } : {}),
                    current: measured.current,
                    ...(movement
                      ? movement.pinned
                        ? { pinned: true, movedPaths: movement.moved }
                        : { pinned: false }
                      : {}),
                  }
                : measured,
          }
        : {}),
      currentness,
    };
  });
  const allowed = options.currentness ? new Set(options.currentness) : null;
  return allowed ? classified.filter((row) => allowed.has(row.currentness.overall)) : classified;
}
