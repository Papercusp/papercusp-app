/** Typed internal steps for an accepted blueprint-operation program. Their
 * execution needs the root's durable receipt, so the DBOS program runner
 * handles them before the generic coord-op dispatch path. */
import { z } from 'zod';
import type { CoordOp } from '../types.js';
import { registerCoordOp } from '../registry.js';

const stepId = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/);
const target = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('work-item'), id: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('plan'), runId: z.number().int().positive(), instanceSlug: z.string().min(1) }).strict(),
]);
export const childHandleSchema = z.object({
  workspaceId: z.string().min(1), harnessSlug: z.string().min(1),
  receiptId: z.number().int().positive(), operationId: z.string().min(1),
  specificationRevision: z.string().regex(/^[0-9a-f]{64}$/), target,
}).strict();

export const invokeChildArgsSchema = z.object({
  operationId: z.string().min(1), input: z.record(z.string(), z.unknown()),
  title: z.string().optional(), summary: z.string().optional(),
}).strict();

export const awaitChildArgsSchema = z.object({
  invokeStepId: stepId, operationId: z.string().min(1),
  timeoutSec: z.number().int().min(1).max(86_400).default(3600),
}).strict();

const invokeChildOp: CoordOp<z.infer<typeof invokeChildArgsSchema>, z.infer<typeof childHandleSchema>> = {
  name: 'blueprint:invoke-child',
  description: 'Invoke a child operation from an accepted program using the root receipt and authored step ID.',
  argsSchema: invokeChildArgsSchema,
  resultSchema: childHandleSchema,
  async run() {
    throw new Error('blueprint child invocation requires an accepted durable program root');
  },
};

const awaitChildOp: CoordOp<z.infer<typeof awaitChildArgsSchema>, { state: 'ready'; output: unknown; evidenceRef: string }> = {
  name: 'blueprint:await-child',
  description: 'Await a previously invoked child through its canonical operation result.',
  argsSchema: awaitChildArgsSchema,
  resultSchema: z.object({ state: z.literal('ready'), output: z.unknown(), evidenceRef: z.string().min(1) }).strict(),
  async run() {
    throw new Error('blueprint child wait requires an accepted durable program root');
  },
};

registerCoordOp(invokeChildOp);
registerCoordOp(awaitChildOp);
