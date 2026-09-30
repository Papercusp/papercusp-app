/** Shared typed contract for the public blueprint operation lifecycle (P-017,
 * plan blueprint-backed-work-item-execution-2026-09-23 D-009).
 *
 * One schema set feeds every projection: the seven `blueprint:*` defineTool
 * `args`/`result`/`events` declarations (MCP inputSchema/outputSchema, the
 * /api/agent-tools HTTP route, /api/openapi.json) and the generic projected
 * client port. The service owns behaviour; this module only names its wire
 * shapes, so the transports cannot drift into separate contracts. */
import { z } from 'zod';
import { entityRef } from '@papercusp/tooldef';
import { OperationEventBodySchema, OperationHandleSchema } from './operation-service';

export const BLUEPRINT_OPERATION_TOOLS = {
  submit: 'blueprint:submit',
  status: 'blueprint:status',
  result: 'blueprint:result',
  events: 'blueprint:events',
  cancel: 'blueprint:cancel',
  signal: 'blueprint:signal',
  resume: 'blueprint:resume',
} as const;

export type BlueprintOperationVerb = keyof typeof BLUEPRINT_OPERATION_TOOLS;

export const BlueprintOperationHandleSchema = OperationHandleSchema;

const requestKey = z.string().trim().min(1).max(200)
  .describe('Caller-chosen idempotency key. The same key with the same input replays one durable outcome; different input is refused.');
const handle = BlueprintOperationHandleSchema
  .describe('The durable operation handle returned by blueprint:submit. It is bound to the submitting caller and scope.');

export const SubmitArgsSchema = z.object({
  // entityRef (not a bare string): the dispatch entity-check rejects an invented harness
  // before the operation service runs, and the conformance ratchet counts it converted.
  harness: entityRef('harness', {
    max: 120,
    describe: 'Harness (in your workspace) whose projected blueprint declares the operation.',
  }),
  operationId: z.string().trim().min(1).max(200).describe('Operation id declared by the harness blueprint.'),
  requestKey,
  input: z.record(z.string(), z.unknown()).describe('Operation input; validated against the declared inputSchema.'),
  title: z.string().trim().min(1).max(200).optional(),
  summary: z.string().max(4_000).optional(),
}).strict();

export const HandleArgsSchema = z.object({ handle }).strict();

export const EventsArgsSchema = z.object({
  handle,
  cursor: z.string().regex(/^(0|[1-9][0-9]*)$/).optional()
    .describe('Resume after this event cursor (from a prior page). Omit to read from the start.'),
  limit: z.number().int().min(1).max(100).optional(),
}).strict();

export const CancelArgsSchema = z.object({
  handle, requestKey, reason: z.string().trim().min(1).max(2_000),
}).strict();

export const SignalArgsSchema = z.object({
  handle,
  channel: z.string().trim().min(1).max(200).describe('Signal channel declared by the operation.'),
  payload: z.unknown().describe('Payload validated against the channel payloadSchema.'),
  requestKey,
}).strict();

export const ResumeArgsSchema = z.object({
  handle,
  token: z.string().trim().min(1).max(500).describe('The outstanding declared wait token (blueprint:status wait.token).'),
  response: z.unknown().describe('Response validated against the declared wait responseSchema.'),
  requestKey,
}).strict();

export const BlueprintOperationStatusSchema = z.object({
  handle: BlueprintOperationHandleSchema,
  phase: z.enum(['accepted', 'dispatched', 'waiting', 'terminal']),
  outcome: z.enum(['succeeded', 'unverified', 'failed', 'cancelled', 'dropped']).nullable(),
  items: z.array(z.object({ id: z.string(), state: z.string(), assignee: z.string().nullable() })),
  planRun: z.object({ status: z.string(), outcome: z.string().nullable() }).nullable(),
  cancellationRequested: z.boolean(),
  wait: z.object({ name: z.string(), token: z.string() }).nullable(),
});

/** Event vocabulary: the service's canonical event bodies plus their cursor. */
export const BlueprintOperationEventSchema = OperationEventBodySchema.and(
  z.object({ cursor: z.string(), at: z.string() }),
);

export const BlueprintOperationEventsPageSchema = z.object({
  status: BlueprintOperationStatusSchema,
  events: z.array(BlueprintOperationEventSchema),
  cursor: z.string(),
  hasMore: z.boolean(),
});

/** Settlement and success are different facts: only `ready` carries output. */
export const BlueprintOperationResultSchema = z.union([
  z.object({ state: z.literal('pending'), status: BlueprintOperationStatusSchema }),
  z.object({
    state: z.enum(['failed', 'cancelled', 'dropped', 'unavailable']),
    status: BlueprintOperationStatusSchema, reason: z.string(),
  }),
  z.object({
    state: z.literal('ready'), status: BlueprintOperationStatusSchema,
    output: z.unknown(), evidenceRef: z.string(), acceptanceEvidenceRef: z.string().optional(),
  }),
]);

/** A control input is durably accepted; handling is a separate worker fact. */
export const BlueprintOperationInputReceiptSchema = z.object({
  eventId: z.string(),
  replayed: z.boolean(),
  accepted: z.literal(true),
  wakeQueued: z.boolean(),
  handled: z.literal(false),
});

export const BlueprintOperationCancelReceiptSchema = BlueprintOperationInputReceiptSchema.extend({
  effected: z.boolean(),
});

export const SubmitResultSchema = z.object({ handle: BlueprintOperationHandleSchema });
