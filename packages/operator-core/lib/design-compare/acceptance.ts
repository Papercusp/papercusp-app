/** The journey/state obligation carried by an existing immutable design approval.
 * Contract and evidence are ordinary artifacts. File-set measurement, render
 * geometry/review and reference identity reuse the existing proof primitives.
 */
import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { measureRepoFilesEvidenceAtRoot, repoFilesEvidenceMeasurementSchema } from '../agent-tools/plans/spec-evidence-store';
import { designReferenceBindingSchema, type DesignApprovalScope } from './ratification';
import { loadHarnessRegistry, resolveHarnessContentPath } from '../harness-registry';
import { activeWorkspaceId } from '../workspace-registry';
import { readPngDimensions } from './png-header';
import { evaluateRenderMatrix, renderMatrixCaseSchema, renderMatrixObservationSchema } from './render-matrix';

const text = z.string().trim().min(1);
const paths = repoFilesEvidenceMeasurementSchema.shape.sourcePaths;
export const DESIGN_FRESHNESS_DIMENSIONS = ['source', 'test', 'fixture', 'rubric', 'environment', 'served-build'] as const;
const fingerprints = z.object(Object.fromEntries(DESIGN_FRESHNESS_DIMENSIONS.map(key => [key, text])) as Record<typeof DESIGN_FRESHNESS_DIMENSIONS[number], typeof text>).strict();
const measurement = z.object(Object.fromEntries(DESIGN_FRESHNESS_DIMENSIONS.map(key => [key, paths])) as Record<typeof DESIGN_FRESHNESS_DIMENSIONS[number], typeof paths>).strict();
const build = z.object({
  id: text, manifestPath: paths.element,
  /** JSON property path in the builder's existing identity artifact. */
  revisionPath: z.array(text).min(1).max(10),
}).strict();
const renderCase = renderMatrixCaseSchema.omit({ target: true }).extend({
  target: renderMatrixCaseSchema.shape.target.omit({ implementationRevision: true }),
  buildId: text,
}).strict();
export const designAcceptanceContractSchema = z.object({
  schemaVersion: z.literal(1),
  reference: designReferenceBindingSchema,
  targetRoute: z.string().regex(/^\/(?!\/)/),
  measurement,
  builds: z.array(build).min(1).max(20),
  journey: z.object({
    buildId: text,
    testFile: paths.element,
    scenarios: z.array(z.enum(['clean', 'canonical', 'legacy', 'persisted', 'reload', 'history'])).min(5).max(6)
      .refine(ids => new Set(ids).size === ids.length && ['clean', 'canonical', 'persisted', 'reload', 'history'].every(id => ids.includes(id as typeof ids[number])), 'all entry obligations must be declared'),
  }).strict(),
  renderCases: z.array(renderCase).min(1).max(200),
}).strict().superRefine((contract, ctx) => {
  if (!contract.measurement.test.includes(contract.journey.testFile)) {
    ctx.addIssue({ code: 'custom', message: 'the actual browser test file must be included in test measurement' });
  }
  const buildIds = contract.builds.map(row => row.id);
  if (new Set(buildIds).size !== buildIds.length ||
      !buildIds.includes(contract.journey.buildId) ||
      contract.renderCases.some(row => !buildIds.includes(row.buildId)) ||
      new Set(contract.renderCases.map(row => row.caseId)).size !== contract.renderCases.length) {
    ctx.addIssue({ code: 'custom', message: 'case/build identities must be unique and every proof must name a declared build' });
  }
  for (const row of contract.builds) {
    if (!contract.measurement['served-build'].includes(row.manifestPath)) {
      ctx.addIssue({ code: 'custom', message: 'each build manifest must be included in served-build measurement' });
    }
  }
});
export const designAcceptanceEvidenceSchema = z.object({
  schemaVersion: z.literal(1), reference: designReferenceBindingSchema,
  fingerprints,
  journeys: z.array(z.object({
    scenario: text, targetRoute: text, implementationRevision: text,
    runner: z.literal('browser'), shellReached: z.boolean(), destinationReached: z.boolean(),
    status: z.enum(['pass', 'fail']), testRunRef: z.string().regex(/^test-run:\d+$/),
  }).strict()).max(30),
  observations: z.array(renderMatrixObservationSchema).max(200),
}).strict();
export type DesignAcceptanceContract = z.infer<typeof designAcceptanceContractSchema>;
export type DesignAcceptanceEvidence = z.infer<typeof designAcceptanceEvidenceSchema>;
export type DesignAcceptanceResult = { satisfied: boolean; failures: { caseId: string; reason: string }[] };

/** Pure verdict over independently read identities; no caller-supplied current tuple. */
export function evaluateDesignAcceptance(
  contract: DesignAcceptanceContract,
  evidence: DesignAcceptanceEvidence,
  current: { fingerprints: DesignAcceptanceEvidence['fingerprints']; builds: Record<string, string> },
): DesignAcceptanceResult {
  const failures: DesignAcceptanceResult['failures'] = [];
  const fail = (caseId: string, reason: string) => failures.push({ caseId, reason });
  const expected = contract.reference;
  const actual = evidence.reference;
  if (actual.featureId !== expected.featureId || actual.referenceId !== expected.referenceId ||
      actual.revision !== expected.revision || actual.contentSha256 !== expected.contentSha256) fail('*', 'stale-reference');
  for (const key of DESIGN_FRESHNESS_DIMENSIONS) {
    if (evidence.fingerprints[key] !== current.fingerprints[key]) fail('*', `stale-${key}`);
  }
  for (const scenario of contract.journey.scenarios) {
    const rows = evidence.journeys.filter(row => row.scenario === scenario);
    if (rows.length !== 1) { fail(scenario, rows.length ? 'duplicate-journey-proof' : 'missing-journey-proof'); continue; }
    const row = rows[0]!;
    if (row.targetRoute !== contract.targetRoute) fail(scenario, 'wrong-target');
    if (row.implementationRevision !== current.builds[contract.journey.buildId]) fail(scenario, 'stale-build');
    if (!row.shellReached || !row.destinationReached || row.status !== 'pass') fail(scenario, 'journey-failed');
  }
  const matrix = evaluateRenderMatrix({
    schemaVersion: 1, reference: expected,
    cases: contract.renderCases.map(({ buildId, ...row }) => ({
      ...row, target: { ...row.target, implementationRevision: current.builds[buildId] },
    })),
  }, evidence.observations);
  failures.push(...matrix.failures);
  return { satisfied: failures.length === 0, failures };
}

/** Confine artifact reads to the harness, including symlinks, and bound each read. */
export async function artifactBytes(root: string, path: string): Promise<Buffer> {
  const normalized = paths.element.parse(path);
  const canonicalRoot = await realpath(root);
  const canonical = await realpath(resolve(canonicalRoot, normalized));
  const rel = relative(canonicalRoot, canonical);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('artifact-outside-harness');
  const info = await stat(canonical);
  if (!info.isFile() || info.size > 8 * 1024 * 1024) throw new Error('invalid-artifact-size');
  return readFile(canonical);
}
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

export async function measureDesignAcceptance(root: string, contract: DesignAcceptanceContract) {
  const measured = await Promise.all(DESIGN_FRESHNESS_DIMENSIONS.map(async key => {
    const result = await measureRepoFilesEvidenceAtRoot(root, { schemaVersion: 1, kind: 'repo-files', sourcePaths: contract.measurement[key] });
    return [key, result.sourceFingerprint] as const;
  }));
  const builds: Record<string, string> = {};
  for (const row of contract.builds) {
    let value: unknown = JSON.parse((await artifactBytes(root, row.manifestPath)).toString('utf8'));
    for (const key of row.revisionPath) value = value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
    builds[row.id] = text.parse(value);
  }
  return { fingerprints: fingerprints.parse(Object.fromEntries(measured)), builds };
}

/** Both completion and shipment use this reader, including re-hashing images. */
export async function readDesignAcceptance(input: {
  root: string; featureId: string; referenceId: string; revision: number; contentSha256: string;
  approval: DesignApprovalScope;
  /** The durable browser FILE verdict corroborates the per-scenario artifact.
   * It is not itself a per-scenario measurement. */
  readRun?: (id: number) => Promise<{ status: string; framework: string; filePath: string } | null>;
}): Promise<DesignAcceptanceResult> {
  const descriptor = input.approval.acceptance;
  const failure = (reason: string): DesignAcceptanceResult => ({ satisfied: false, failures: [{ caseId: '*', reason }] });
  if (!descriptor) return failure('missing-acceptance-registration');
  let contract: DesignAcceptanceContract;
  try {
    const bytes = await artifactBytes(input.root, descriptor.contractPath);
    if (digest(bytes) !== descriptor.contractSha256) return failure('stale-contract');
    contract = designAcceptanceContractSchema.parse(JSON.parse(bytes.toString('utf8')));
    const ref = contract.reference;
    if (ref.featureId !== input.featureId || ref.referenceId !== input.referenceId || ref.revision !== input.revision || ref.contentSha256 !== input.contentSha256) return failure('stale-reference');
    if (contract.targetRoute !== input.approval.targetRoute) return failure('wrong-target');
  } catch { return failure('invalid-acceptance-contract'); }
  let evidenceBytes: Buffer;
  try { evidenceBytes = await artifactBytes(input.root, descriptor.evidencePath); }
  catch { return failure('missing-proof'); }
  let evidence: DesignAcceptanceEvidence;
  try { evidence = designAcceptanceEvidenceSchema.parse(JSON.parse(evidenceBytes.toString('utf8'))); }
  catch { return failure('invalid-proof'); }
  try {
    const current = await measureDesignAcceptance(input.root, contract);
    const result = evaluateDesignAcceptance(contract, evidence, current);
    for (const ref of new Set(evidence.journeys.map(row => row.testRunRef))) {
      const run = await (input.readRun ?? readBrowserFileRun)(Number(ref.slice('test-run:'.length)));
      if (!run || run.status !== 'pass' || run.framework !== 'playwright' || run.filePath !== contract.journey.testFile) {
        result.failures.push({ caseId: ref, reason: 'browser-run-unproven' });
      }
    }
    for (const observation of evidence.observations) {
      try {
        const bytes = await artifactBytes(input.root, observation.capture.path);
        const dimensions = readPngDimensions(bytes);
        if (digest(bytes) !== observation.capture.sha256 ||
            dimensions.width !== Math.round(observation.environment.viewport.width * observation.environment.deviceScaleFactor)) {
          result.failures.push({ caseId: observation.caseId, reason: 'invalid-capture' });
        }
      } catch { result.failures.push({ caseId: observation.caseId, reason: 'invalid-capture' }); }
    }
    return { satisfied: result.failures.length === 0, failures: result.failures };
  } catch { return failure('current-identity-unavailable'); }
}

export async function readBrowserFileRun(id: number) {
  const { getOrgPg } = await import('@papercusp/db-org');
  const { sql } = getOrgPg();
  const rows = await sql<{ status: string; framework: string; filePath: string }[]>`
    SELECT status, framework, file_path AS "filePath"
    FROM harness_shared.test_runs WHERE id = ${id} LIMIT 1`;
  return rows[0] ?? null;
}

export async function designAcceptanceRoot(harnessSlug: string): Promise<string> {
  const registry = await loadHarnessRegistry(activeWorkspaceId());
  const root = resolveHarnessContentPath(registry, harnessSlug);
  if (!root) throw new Error('design-acceptance-harness-unavailable');
  return root;
}
