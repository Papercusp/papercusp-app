/** Structural render evidence supplements the existing per-image comparison.
 * Reuses CaptureEnvironment and exact reference/build identities. Callers store
 * this JSON with their existing design/test artifacts; it is not a pixel score
 * or proof that a fixture has connected to a real service.
 */
import { z } from 'zod';
import { environmentsMatch, type CaptureEnvironment } from './contract';
import { designReferenceBindingSchema } from './ratification';

const nonempty = z.string().trim().min(1);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const viewport = z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).strict();
const environment = z.object({
  viewport, deviceScaleFactor: z.number().positive(), browser: nonempty,
  theme: nonempty, fontSet: nonempty, fixture: nonempty.optional(), state: nonempty,
}).strict();
const target = z.object({
  targetId: nonempty, targetKind: z.enum(['storybook-story', 'page-route', 'component']),
  implementationRevision: nonempty,
}).strict();
const image = z.object({ path: nonempty, sha256 }).strict();
const bounds = z.object({
  x: z.number().finite(), y: z.number().finite(),
  width: z.number().positive(), height: z.number().positive(),
}).strict();

export const renderMatrixCaseSchema = z.object({
  caseId: nonempty, environment, target,
  evidenceKind: z.enum(['fixture', 'real-service']),
  layout: z.enum(['side-by-side', 'stacked']),
  controls: z.array(z.object({ name: nonempty, enabled: z.boolean() }).strict()).min(1),
  readyContentRequired: z.boolean(),
}).strict();

export const renderMatrixContractSchema = z.object({
  schemaVersion: z.literal(1),
  reference: designReferenceBindingSchema,
  cases: z.array(renderMatrixCaseSchema).min(1).max(200)
    .refine(cases => new Set(cases.map(c => c.caseId)).size === cases.length, 'case ids must be unique'),
}).strict();

export const renderMatrixObservationSchema = z.object({
  caseId: nonempty, environment, target,
  evidenceKind: z.enum(['fixture', 'real-service']),
  capture: image,
  geometry: z.object({
    container: bounds.extend({ clientWidth: z.number().positive(), scrollWidth: z.number().positive() }).strict(),
    primary: bounds, secondary: bounds,
  }).strict(),
  controls: z.array(z.object({ name: nonempty, visible: z.boolean(), enabled: z.boolean() }).strict()),
  readyContentVisible: z.boolean(),
  placeholderVisible: z.boolean(),
  connectivity: z.enum(['not-exercised', 'disconnected', 'connected']),
  connectivityEvidence: nonempty.optional(),
  review: z.object({
    referenceSha256: sha256, captureSha256: sha256,
    reviewer: nonempty, reviewedAt: z.string().datetime(),
    verdict: z.enum(['pass', 'fail']), note: nonempty,
  }).strict().optional(),
}).strict();

export type RenderMatrixContract = z.infer<typeof renderMatrixContractSchema>;
export type RenderMatrixObservation = z.infer<typeof renderMatrixObservationSchema>;
export type RenderMatrixFailure = { caseId: string; reason: string };

/** Every declared case is checked independently; extra evidence cannot cover it. */
export function evaluateRenderMatrix(contractInput: unknown, observationsInput: unknown) {
  const contract = renderMatrixContractSchema.safeParse(contractInput);
  const observations = z.array(renderMatrixObservationSchema).safeParse(observationsInput);
  const failures: RenderMatrixFailure[] = [];
  if (!contract.success || !observations.success) {
    return { satisfied: false, failures: [{ caseId: '*', reason: 'malformed-render-matrix' }], cases: [] };
  }
  for (const required of contract.data.cases) {
    const matches = observations.data.filter(row => row.caseId === required.caseId);
    const fail = (reason: string) => failures.push({ caseId: required.caseId, reason });
    if (matches.length !== 1) { fail(matches.length ? 'duplicate-case-evidence' : 'missing-case-evidence'); continue; }
    const row = matches[0]!;
    if (!environmentsMatch(required.environment as CaptureEnvironment, row.environment as CaptureEnvironment)) fail('wrong-environment');
    if (row.target.targetId !== required.target.targetId || row.target.targetKind !== required.target.targetKind) fail('wrong-target');
    if (row.target.implementationRevision !== required.target.implementationRevision) fail('stale-build');
    if (row.evidenceKind !== required.evidenceKind) fail('wrong-evidence-kind');
    if (row.evidenceKind === 'fixture' && row.connectivity !== 'not-exercised') fail('fixture-connectivity-claim');
    if (row.connectivity === 'connected' && !row.connectivityEvidence) fail('missing-connectivity-proof');
    if (required.readyContentRequired && (!row.readyContentVisible || row.placeholderVisible)) fail('placeholder-is-not-ready');
    const { container, primary, secondary } = row.geometry;
    const tolerance = 2; // CSS subpixel rounding, not a visual-difference threshold.
    if (container.scrollWidth > container.clientWidth + tolerance ||
        [primary, secondary].some(box => box.x < container.x - tolerance ||
          box.x + box.width > container.x + container.width + tolerance)) fail('horizontal-overflow');
    if (required.layout === 'side-by-side') {
      if (secondary.x < primary.x + primary.width - tolerance || primary.width <= secondary.width) fail('wrong-layout');
    } else if (secondary.y < primary.y + primary.height - tolerance) fail('wrong-layout');
    for (const control of required.controls) {
      const found = row.controls.filter(value => value.name === control.name);
      if (found.length !== 1 || !found[0]!.visible || found[0]!.enabled !== control.enabled) fail(`control-unavailable:${control.name}`);
    }
    if (!row.review) fail('missing-side-by-side-review');
    else if (row.review.referenceSha256 !== contract.data.reference.contentSha256 || row.review.captureSha256 !== row.capture.sha256) fail('stale-side-by-side-review');
    else if (row.review.verdict !== 'pass') fail('visual-review-failed');
  }
  return {
    satisfied: failures.length === 0, failures,
    cases: contract.data.cases.map(row => ({ caseId: row.caseId, evidenceKind: row.evidenceKind })),
  };
}
