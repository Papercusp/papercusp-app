/**
 * OpenAPI 3.1 fragment emitter for projected tools.
 *
 * Given a `ProjectedTool`, produces the per-tool slice of an OpenAPI
 * document: one path entry + the components.schemas entries that path
 * references. The assembler (Phase 7 step 2) walks the catalog, calls
 * `toolToOpenApiFragment()` per tool, and merges into a single document.
 *
 * Wire-format decisions follow openapi-design-spike-2026-05-20.md §6:
 *   - Q1 parsed shape: schemas describe `{ event, id?, data }` not raw
 *     SSE grammar.
 *   - Q2 discriminator: `event` field comes from the SSE `event:` line;
 *     schemas include it as a required string-literal property so the
 *     parsed shape carries the discriminator.
 *   - Q3 tool HTTP path: use the declared `expose.http.path`; the MCP name
 *     remains the operation id. A name-derived fallback is kept for MCP-only
 *     projected tools for backwards-compatible document assembly.
 *   - Q5 vendor extensions: `x-papercusp-*`.
 *   - Q6 plugin tools: same shape as built-ins.
 *
 * Spec ref: openapi-design-spike-2026-05-20.md.
 */

import type { ProjectedTool } from './tool-projection';
import { toJsonSchema } from './schema-adapter';

// componentKey: sanitize tool names for OpenAPI 3.1 component-schema map keys
// (regex ^[A-Za-z0-9._-]+$). Tool names use ":" as namespace separator (legal
// in paths per Q3, illegal in component keys). Swap any disallowed char to "_".
export function componentKey(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, '_');
}

/* ─── Public surface ─────────────────────────────────────────────────── */

export interface OpenApiFragment {
  /**
   * Path entry — keyed under the projected tool's declared HTTP path, or
   * `/api/<toolname>` for an MCP-only fallback.
   */
  path: string;
  /**
   * HTTP method this fragment's operation is keyed under in
   * `paths[path]`. Omitted → `'post'` (every projected tool is POST).
   * `defineTool` fragments set it to the route's actual method, and
   * the assembler merges multiple methods onto one path.
   */
  httpMethod?: 'get' | 'post' | 'put' | 'patch' | 'delete' | 'options';
  /** Operation object — keyed under `paths[path][httpMethod]`. */
  operation: Record<string, unknown>;
  /**
   * Schema entries — keyed under `components.schemas[<name>]` in the
   * assembled document. Names are `<toolName>.<suffix>` to avoid
   * collisions between tools.
   */
  schemas: Record<string, Record<string, unknown>>;
}

/**
 * Emit the OpenAPI fragment for a single projected tool.
 *
 * Hosts that want a custom path prefix can pass `pathPrefix` (default
 * `/api`); a custom security-scheme name (default `bearerAuth`) maps to
 * the `securitySchemes` entry the assembler will register.
 */
export function toolToOpenApiFragment(
  toolName: string,
  tool: ProjectedTool,
  opts: { pathPrefix?: string; securitySchemeName?: string } = {},
): OpenApiFragment {
  const pathPrefix = opts.pathPrefix ?? '/api';
  const securitySchemeName = opts.securitySchemeName ?? 'bearerAuth';
  // The HTTP adapter serves the manifest's declared path. Synthesizing a path
  // from the MCP name makes the OpenAPI document advertise a route that the
  // server cannot handle (for example `health:ack` vs
  // `/api/agent-tools/health/ack`).
  const path = tool.expose.http?.path ?? `${pathPrefix}/${toolName}`;
  const keyName = componentKey(toolName);

  const schemas: Record<string, Record<string, unknown>> = {};
  const safeName = (suffix: string) => `${keyName}.${suffix}`;

  /* Input schema */
  schemas[safeName('Input')] = stripJsonSchemaMeta(tool.inputSchema);

  /* Tool-result terminal shape (non-streaming consumers) */
  schemas[safeName('ToolResult')] = toolResultSchema();

  /* Per-event schemas */
  const eventEntries: string[] = [];
  const eventsZod = tool.events;
  const eventsJsonSchema = tool.eventsJsonSchema;
  if (eventsZod) {
    for (const [name, schema] of Object.entries(eventsZod)) {
      const dataSchema = zodToJsonSchemaSafe(schema);
      const refName = safeName(`Event.${name}`);
      schemas[refName] = eventWrapper(name, dataSchema);
      eventEntries.push(refName);
    }
  } else if (eventsJsonSchema) {
    for (const [name, dataSchema] of Object.entries(eventsJsonSchema)) {
      const refName = safeName(`Event.${name}`);
      schemas[refName] = eventWrapper(name, stripJsonSchemaMeta(dataSchema));
      eventEntries.push(refName);
    }
  }

  /* Framework-emitted events: done (always), chunk (when outputRef
   * plausible — we add it unconditionally since the runtime emits it
   * on result.outputRef and we'd rather over-document), state (when
   * the tool declared `state`). */
  schemas[safeName('Event.done')] = eventWrapper('done', { $ref: `#/components/schemas/${safeName('ToolResult')}` });
  eventEntries.push(safeName('Event.done'));
  schemas[safeName('Event.chunk')] = eventWrapper('chunk', {
    type: 'object',
    required: ['ref'],
    properties: {
      ref: { type: 'string' },
      byteSize: { type: 'integer' },
    },
  });
  eventEntries.push(safeName('Event.chunk'));
  if (tool.state) {
    schemas[safeName('Event.state')] = eventWrapper(
      'state',
      zodToJsonSchemaSafe(tool.state),
    );
    eventEntries.push(safeName('Event.state'));
  }

  /* SSE response schema — oneOf over the event-wrappers + discriminator
   * mapping on the `event` property. */
  const sseSchema = {
    oneOf: eventEntries.map((name) => ({ $ref: `#/components/schemas/${name}` })),
    discriminator: {
      propertyName: 'event',
      mapping: Object.fromEntries(
        eventEntries.map((name) => [
          name.substring(name.lastIndexOf('Event.') + 'Event.'.length),
          `#/components/schemas/${name}`,
        ]),
      ),
    },
  };

  /* Operation */
  const security = tool.capabilities.length > 0
    ? [{ [securitySchemeName]: tool.capabilities.map((c) => String(c)) }]
    : [{ [securitySchemeName]: [] }];

  const operation: Record<string, unknown> = {
    operationId: toolName,
    summary: toolName,
    description: tool.description,
    security,
    requestBody: {
      required: true,
      content: {
        'application/json': { schema: { $ref: `#/components/schemas/${safeName('Input')}` } },
      },
    },
    responses: {
      '200': {
        description: 'Tool completed (streaming) or returned (non-streaming).',
        content: {
          'text/event-stream': { schema: sseSchema },
          'application/json': { schema: { $ref: `#/components/schemas/${safeName('ToolResult')}` } },
        },
      },
      '400': { $ref: '#/components/responses/InvalidInput' },
      '401': { $ref: '#/components/responses/Unauthorized' },
      '403': { $ref: '#/components/responses/RoleOrCapabilityDenied' },
      '408': { $ref: '#/components/responses/Timeout' },
      '429': { $ref: '#/components/responses/QuotaExceeded' },
      '500': { $ref: '#/components/responses/HandlerError' },
    },
  };

  /* Vendor extensions — x-papercusp-* per Q5 */
  if (tool.agentRoles && tool.agentRoles.length > 0) {
    operation['x-papercusp-roles'] = [...tool.agentRoles];
  }
  if (typeof tool.timeoutSec === 'number') {
    operation['x-papercusp-timeoutSec'] = tool.timeoutSec;
  }
  if (typeof tool.idleTimeoutSec === 'number' && tool.idleTimeoutSec > 0) {
    operation['x-papercusp-idleTimeoutSec'] = tool.idleTimeoutSec;
  }
  if (typeof tool.replayBufferSize === 'number' && tool.replayBufferSize > 0) {
    operation['x-papercusp-replayBufferSize'] = tool.replayBufferSize;
  }
  if (tool.modality && tool.modality.length > 0) {
    operation['x-papercusp-modality'] = [...tool.modality];
  }
  operation['x-papercusp-plugin'] = tool.pluginName;

  return { path, operation, schemas };
}

/* ─── Shared response components ─────────────────────────────────────── */

/**
 * The fixed set of error response components every tool path references.
 * Returned as a single object so the assembler can spread it into
 * `components.responses` once per document instead of N times.
 */
export function standardResponseComponents(): Record<string, Record<string, unknown>> {
  const errorEnvelope = {
    type: 'object',
    required: ['error'],
    properties: {
      error: {
        type: 'object',
        required: ['code', 'message'],
        properties: {
          code: { type: 'string' },
          message: { type: 'string' },
          meta: { type: 'object', additionalProperties: true },
        },
      },
    },
  };
  const make = (description: string) => ({
    description,
    content: { 'application/json': { schema: errorEnvelope } },
  });
  return {
    InvalidInput: make('Input failed schema validation.'),
    Unauthorized: make('No principal resolved.'),
    RoleOrCapabilityDenied: make('Principal lacks the required role or capability.'),
    Timeout: make('Tool exceeded its wall-clock or idle timeout.'),
    QuotaExceeded: make('Tool invocation hit a per-role quota cap.'),
    HandlerError: make('Handler threw an exception not otherwise classified.'),
    UnknownTool: make('No tool registered for the given operationId.'),
  };
}

/* ─── Internals ──────────────────────────────────────────────────────── */

function eventWrapper(eventName: string, dataSchema: unknown): Record<string, unknown> {
  return {
    type: 'object',
    required: ['event', 'data'],
    properties: {
      event: { type: 'string', enum: [eventName] },
      id: { type: 'integer', description: 'Monotonic event id (replay-buffer key).' },
      data: dataSchema as Record<string, unknown>,
    },
  };
}

function toolResultSchema(): Record<string, unknown> {
  // Mirrors the MCP ToolResult shape — content array + optional
  // isError / outputRef / outputSize. Kept inline (not a $ref) because
  // every tool's response references the same shape; centralizing it
  // saves one $ref-traversal per tool at validation time.
  return {
    type: 'object',
    required: ['content'],
    properties: {
      content: {
        type: 'array',
        items: {
          type: 'object',
          required: ['type'],
          properties: {
            type: { type: 'string' },
            text: { type: 'string' },
          },
          additionalProperties: true,
        },
      },
      isError: { type: 'boolean' },
      outputRef: { type: 'string' },
      outputSize: { type: 'integer' },
    },
  };
}

/**
 * Strip `$schema` and other JSON-Schema-meta fields that don't belong
 * in OpenAPI components. Zod's toJSONSchema emits drafts 2020-12 metadata;
 * OpenAPI 3.1 supports drafts 2020-12 inline but the `$schema` URI
 * triggers linter warnings.
 */
function stripJsonSchemaMeta(schema: Record<string, unknown>): Record<string, unknown> {
  const out = { ...schema };
  delete out.$schema;
  return out;
}

/**
 * Convert a Zod schema to JSON Schema, with the meta stripped. Falls
 * back to `{ description: 'Schema not representable in JSON Schema.' }`
 * when a schema cannot be serialized (e.g. z.instanceof for raw
 * binary — matches the existing serializeEventsSchema fallback).
 */
function zodToJsonSchemaSafe(schema: unknown): Record<string, unknown> {
  try {
    const raw = toJsonSchema(schema);
    const stripped = stripJsonSchemaMeta(raw);
    // Detect schemas that cannot be represented (empty after stripping $schema).
    if (Object.keys(stripped).length === 0) {
      return { description: 'Schema not representable in JSON Schema.' };
    }
    return stripped;
  } catch {
    return { description: 'Schema not representable in JSON Schema.' };
  }
}
