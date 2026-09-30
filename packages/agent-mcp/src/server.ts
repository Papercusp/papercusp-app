/**
 * Agent MCP server.
 *
 * Wires the catalog (populated by importing `tools/**`) into an MCP
 * server. Each `tools/list` and `tools/call` request resolves the caller
 * to a Principal via the bearer token, checks the tool's capability
 * against the principal's grants, and runs the handler inside a
 * transaction with `app.workspace_id` set.
 *
 * Transports:
 *   - stdio (out-of-process pi sessions / external claude-code consumers)
 *   - in-process: import `dispatch()` directly (Operator/Oracle running
 *     in the same Node process call the same handlers without going
 *     over a wire — same contract, no transport overhead).
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readFileSync, statSync } from 'node:fs';
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { explainOnConflictSkew, withWorkspace } from '@papercusp/db-org';
import { advertisedArgsSchema } from '@papercusp/result-encoding';
import { resolveBearer } from './auth';
import { sanitizeToolSchema } from './tool-schema-sanitize';
import {
  getCatalog,
  lookup,
  lookupByMcpName,
  standardValidate,
  serializeToolResponse,
  formatOptsFromCtx,
  toArgsJsonSchema,
  applyEntityRefEnums,
} from '@papercusp/tooldef';
import { applyToolManifest } from './tool-manifest';
import { runWithValidationWorkspace } from './validation-context';
import {
  getResourceCatalog,
  matchResource,
} from '@papercusp/tooldef';
import { getPromptCatalog, lookupPrompt } from '@papercusp/tooldef';
import {
  authorizeScratchReference,
  parseScratchReference,
  ScratchReferenceError,
} from '@papercusp/operator-core/lib/scratch-reference';
import {
  parseScratchUri,
  safeScratchFilesystemPath,
  SCRATCH_SCHEME,
  ScratchUriError,
} from '@papercusp/operator-core/lib/scratch-uri';
import type {
  Principal,
  PromptContext,
  PromptResult,
  ResourceContents,
  ResourceContext,
  ResourceListEntry,
  ToolContext,
  ToolDefinition,
  ToolResult,
  ToolResponse,
} from '@papercusp/tooldef';

export interface DispatchOptions {
  toolName: string;
  args: unknown;
  bearer: string;
}

export interface DispatchResult {
  ok: boolean;
  response?: ToolResponse | ToolResult;
  error?: { code: string; message: string };
}

/**
 * One Standard-Schema validation issue. `message` + `path` are the only fields
 * the StandardSchemaV1.Issue type declares, but a Zod `too_big` issue ALSO carries
 * `{ code, origin, maximum }` at runtime — read them defensively (all optional).
 */
interface ValidationIssue {
  readonly message: string;
  readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }>;
  readonly code?: string;
  readonly origin?: string;
  readonly maximum?: number;
  /** Zod v4 `unrecognized_keys`: names of the offending object keys. */
  readonly keys?: ReadonlyArray<PropertyKey>;
  /**
   * Zod v4 `invalid_union`: the per-branch issue lists. Not part of the
   * Standard-Schema Issue type, so read defensively — see `bestUnionBranch`.
   */
  readonly errors?: ReadonlyArray<ReadonlyArray<ValidationIssue>>;
}

/**
 * EI-18889347809692710 — recover the ACTIONABLE issues hiding inside an
 * `invalid_union`.
 *
 * Zod reports a failed union as ONE issue at the union's OWN path, with the
 * uninformative message `Invalid input`; every branch's real diagnosis is nested
 * in `issue.errors`. For a union-typed arg that is how an agent gets told
 * `body: Invalid input` — naming neither the offending section index nor the key
 * — which is exactly the report that cost three round-trips on a message that was
 * already written, and pushed the caller to DROP the structured field and restate
 * it as prose (losing the machine-readable disposition the field exists to carry).
 *
 * Which branch to believe: the one that got FURTHEST into the structure, with
 * FEWEST ISSUES breaking a depth tie (and declaration order breaking a full tie).
 * A caller who passed an array to `z.union([z.string(), z.array(section)])`
 * produces a shallow "expected string, received array" from the string branch
 * and a deep `[1, 'couldNotDetermine']` from the array branch — the deep one is
 * the branch they meant, so its path is the one worth printing. Requiring depth
 * > 0 keeps the union's own message when NO branch located a specific field (e.g.
 * a plain scalar mismatch), where the branch messages are no more useful than
 * the union's.
 *
 * A Zod `unrecognized_keys` issue names the offending field in `keys`, not in
 * `path`. Count that key as one level below the issue path so a branch that
 * matched everything except one stray key is not discarded as depth zero.
 */
function issueDepth(issue: ValidationIssue): number {
  const pathDepth = (issue.path ?? []).length;
  return Array.isArray(issue.keys) && issue.keys.length > 0 ? pathDepth + 1 : pathDepth;
}

function bestUnionBranch(issue: ValidationIssue): ReadonlyArray<ValidationIssue> | null {
  const branches = issue.errors;
  if (!Array.isArray(branches) || branches.length === 0) return null;
  let best: ReadonlyArray<ValidationIssue> | null = null;
  let bestDepth = 0;
  let bestCount = Infinity;
  for (const branch of branches) {
    if (!Array.isArray(branch) || branch.length === 0) continue;
    const depth = Math.max(...branch.map(issueDepth));
    if (depth > bestDepth || (depth > 0 && depth === bestDepth && branch.length < bestCount)) {
      bestDepth = depth;
      bestCount = branch.length;
      best = branch;
    }
  }
  return best;
}

/** Walk a dotted path into the raw input to recover the offending value. */
function valueAtPath(input: unknown, segs: PropertyKey[]): unknown {
  let cur: unknown = input;
  for (const seg of segs) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<PropertyKey, unknown>)[seg];
  }
  return cur;
}

/**
 * Render validation issues into one agent-facing `path: message; …` string —
 * but for a string `too_big` issue, tell the agent HOW FAR over the cap it is and
 * the exact target length (agent-tooling-token-efficiency-2026-06-25 P-003). Derived
 * from the issue's `maximum` + the actual input length at that path, e.g.
 * `goal: too long — 412 chars over the 500-char limit; trim to 500.` so the agent
 * trims deterministically in ONE retry instead of blind-retrying the same value. A
 * telemetry audit traced ~1,000+ tool calls/14d failing purely on too-long args.
 *
 * A `number` `too_big` issue gets the same treatment (EI-21864057724720621):
 * Zod's raw message for a numeric ceiling — `Too big: expected number to be
 * <=10` — names the ceiling but not the caller's actual value or how far past
 * it they landed, so a caller retries blind instead of clamping in one step
 * (measured recurring independently across 6+ sessions against
 * `work_items:get`'s `threadLimit`, capped at 10). e.g.
 * `threadLimit: too big — 40 over the 10 limit; use 10.`
 *
 * Generic over any field/tool; non-too_big issues keep their original
 * `path: message`.
 */
export function formatInvalidArgs(issues: ReadonlyArray<ValidationIssue>, input: unknown): string {
  const render = (issue: ValidationIssue, prefix: PropertyKey[], depth: number): string[] => {
    const segs = [
      ...prefix,
      ...(issue.path ?? []).map((seg) =>
        typeof seg === 'object' && seg !== null ? (seg as { key: PropertyKey }).key : (seg as PropertyKey),
      ),
    ];

    // An `invalid_union` carries its real diagnosis in nested per-branch issues;
    // surface the branch that located an actual field instead of "Invalid input".
    // Bounded recursion so a union of unions cannot spin.
    if (depth < 4) {
      const branch = bestUnionBranch(issue);
      if (branch) return branch.flatMap((sub) => render(sub, segs, depth + 1));
    }

    const path = segs.map((s) => String(s)).join('.');
    if (issue.code === 'too_big' && issue.origin === 'string' && typeof issue.maximum === 'number') {
      const max = issue.maximum;
      const actual = valueAtPath(input, segs);
      const over = typeof actual === 'string' ? actual.length - max : null;
      const detail =
        over !== null && over > 0
          ? `too long — ${over} chars over the ${max}-char limit; trim to ${max}.`
          : `too long — over the ${max}-char limit; trim to ${max}.`;
      return [path ? `${path}: ${detail}` : detail];
    }
    if (issue.code === 'too_big' && issue.origin === 'number' && typeof issue.maximum === 'number') {
      const max = issue.maximum;
      const actual = valueAtPath(input, segs);
      const over = typeof actual === 'number' ? actual - max : null;
      const detail =
        over !== null && over > 0
          ? `too big — ${over} over the ${max} limit; use ${max}.`
          : `too big — over the ${max} limit; use ${max}.`;
      return [path ? `${path}: ${detail}` : detail];
    }
    return [path ? `${path}: ${issue.message}` : issue.message];
  };

  return issues.flatMap((issue) => render(issue, [], 0)).join('; ');
}

/**
 * EI-7068: some MCP clients double-encode tool arguments — instead of sending
 * the real arguments object, they JSON.stringify the WHOLE thing and wrap it
 * under a single top-level `args` key: `{ args: '{"content":"...","kind":"x"}' }`.
 * Every tool's Zod schema then sees its real fields as undefined at the top
 * level and rejects with invalid_args — indistinguishable, from a single
 * tool's schema, from the caller simply omitting required fields. This is a
 * TRANSPORT-layer client bug, not any one tool's problem (patching per-tool
 * schemas to accept it would just spread the workaround), so it's detected +
 * unwrapped ONCE here, before per-tool validation.
 *
 * Guarded narrowly so it can never misfire on a tool that legitimately has its
 * own `args` field: only unwraps when the incoming object's ONLY own key is
 * literally "args" AND that value is a string which JSON.parses to a plain
 * (non-null, non-array) object. Anything else (a real args:{...} object field,
 * extra sibling keys, non-JSON string, array/primitive) passes through
 * untouched and hits normal per-tool validation as before.
 */
export function unwrapDoubleEncodedArgs(input: unknown): unknown {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return input;
  const keys = Object.keys(input as Record<string, unknown>);
  if (keys.length !== 1 || keys[0] !== 'args') return input;
  const raw = (input as { args: unknown }).args;
  if (typeof raw !== 'string') return input;
  let candidate: unknown;
  try {
    candidate = JSON.parse(raw);
  } catch {
    return input;
  }
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) return input;
  return candidate;
}

/**
 * Run a tool by name with bearer-derived principal. The single entry
 * point used by both the MCP transport handler and in-process callers
 * (Operator/Oracle).
 */
export async function dispatch(opts: DispatchOptions): Promise<DispatchResult> {
  const tool = lookup(opts.toolName);
  if (!tool) {
    return { ok: false, error: { code: 'unknown_tool', message: `No tool named "${opts.toolName}"` } };
  }
  const principal = await resolveBearer(opts.bearer);
  if (!principal) {
    return { ok: false, error: { code: 'invalid_bearer', message: 'Bearer token did not resolve to a principal' } };
  }
  if (!principal.capabilities.has(tool.capability)) {
    return {
      ok: false,
      error: {
        code: 'missing_capability',
        message: `Principal ${principal.slug} lacks capability "${tool.capability}" (tool: ${tool.name})`,
      },
    };
  }
  // Validate args via the tool's Standard Schema validator. EI-7068: unwrap a
  // degenerate double-encoded { args: "<json-string>" } shape FIRST, so a
  // client bug at the transport layer doesn't 400 every tool it touches.
  const parsed = await runWithValidationWorkspace(principal.workspaceId, () =>
    standardValidate(tool.args, unwrapDoubleEncodedArgs(opts.args)),
  );
  if (!parsed.ok) {
    return {
      ok: false,
      error: { code: 'invalid_args', message: formatInvalidArgs(parsed.issues, opts.args) },
    };
  }

  try {
    const response = await withWorkspace(principal.workspaceId, async (tx) => {
      const ctx: ToolContext = {
        principal,
        tx,
        log: (level, msg, meta) => {
          // Minimal logger; replace with substrate logger in Phase E.
          // eslint-disable-next-line no-console
          console[level === 'info' ? 'log' : level](
            `[agent-mcp][${tool.name}][${principal.slug}] ${msg}`,
            meta ?? '',
          );
        },
      };
      return await tool.handler(parsed.value, ctx);
    });
    return { ok: true, response };
  } catch (err) {
    const message =
      explainOnConflictSkew(err) ?? (err instanceof Error ? err.message : String(err));
    return {
      ok: false,
      error: {
        code: 'handler_error',
        message,
      },
    };
  }
}

// ──────────────────────────────────────────────────────────────────────
// Resource dispatch — symmetric to tool dispatch.
// ──────────────────────────────────────────────────────────────────────

export interface ListResourcesResult {
  ok: boolean;
  resources?: ResourceListEntry[];
  error?: { code: string; message: string };
}

/**
 * Authentication already established by an outer transport. Most callers
 * still provide a bearer string; the HTTP MCP transport can hand off its
 * validated superuser/PI principal directly when that bearer is not indexed
 * as an agent-mcp token.
 */
export type ResourceAuth = string | { bearer: string } | { principal: Principal };

export interface ReadResourceOptions {
  uri: string;
  bearer?: string;
  principal?: Principal;
}

export interface ReadResourceResult {
  ok: boolean;
  contents?: ResourceContents;
  error?: { code: string; message: string };
}

function isScratchResourceUri(uri: string): boolean {
  return uri.startsWith(`${SCRATCH_SCHEME}/`);
}

async function resolveResourcePrincipal(auth: ResourceAuth): Promise<Principal | null> {
  if (typeof auth !== 'string' && 'principal' in auth) return auth.principal;
  const bearer = typeof auth === 'string' ? auth : auth.bearer;
  return bearer ? resolveBearer(bearer) : null;
}

function scratchMimeType(basename: string): string {
  const extension = basename.split('.').pop()?.toLowerCase() ?? '';
  switch (extension) {
    case 'json': return 'application/json';
    case 'csv': return 'text/csv';
    case 'txt':
    case 'log':
    case 'md':
    case 'html': return 'text/plain';
    case 'png': return 'image/png';
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    case 'gif': return 'image/gif';
    case 'webp': return 'image/webp';
    case 'pdf': return 'application/pdf';
    case 'zip': return 'application/zip';
    case 'gz': return 'application/gzip';
    default: return 'application/octet-stream';
  }
}

/**
 * Read a result-door scratch reference through MCP's authenticated resource
 * surface. Scratch URIs are not catalog resources: the URI itself identifies
 * a bounded file under the caller's workspace, and a self-describing file may
 * further restrict access to the owner that produced it.
 */
async function readScratchResource(
  uri: string,
  principal: Principal,
): Promise<ReadResourceResult> {
  let parts;
  try {
    parts = parseScratchUri(uri);
  } catch (err) {
    return {
      ok: false,
      error: {
        code: 'invalid_resource',
        message: err instanceof ScratchUriError ? err.message : String(err),
      },
    };
  }

  // A wildcard workspace is only produced by the explicitly authenticated
  // superuser transport principal (which carries the wildcard capability).
  // Keep ordinary principals strictly workspace-scoped while allowing an
  // intentional `all_workspaces=1` superuser session to follow the URI's
  // concrete workspace into the scratch store.
  const unscopedSuperuser = principal.workspaceId === '*' && principal.capabilities.has('*');
  if (parts.workspaceId !== principal.workspaceId && !unscopedSuperuser) {
    return {
      ok: false,
      error: {
        code: 'workspace_mismatch',
        message: `scratch URI references workspace "${parts.workspaceId}"; principal is scoped to "${principal.workspaceId}"`,
      },
    };
  }

  let filePath: string;
  try {
    filePath = safeScratchFilesystemPath(uri);
  } catch (err) {
    return {
      ok: false,
      error: {
        code: 'invalid_resource',
        message: err instanceof ScratchUriError ? err.message : String(err),
      },
    };
  }

  let bytes: Buffer;
  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) {
      return {
        ok: false,
        error: { code: 'not_a_file', message: 'scratch path is not a regular file' },
      };
    }
    bytes = readFileSync(filePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    return {
      ok: false,
      error: {
        code: code === 'ENOENT' ? 'not_found' : 'read_error',
        message: code === 'ENOENT'
          ? 'scratch file does not exist'
          : err instanceof Error ? err.message : String(err),
      },
    };
  }

  let mimeType = scratchMimeType(parts.basename);
  try {
    const reference = parseScratchReference(bytes);
    if (reference) {
      authorizeScratchReference(reference.manifest, {
        workspaceId: unscopedSuperuser ? reference.manifest.workspaceId : principal.workspaceId,
        // The resolved principal is the caller identity available at this
        // transport seam; result-door owner references use that same stable
        // principal slug when they are produced outside a request context.
        ownerId: principal.slug,
      });
      bytes = reference.payload;
      mimeType = reference.manifest.mediaType;
    }
  } catch (err) {
    if (err instanceof ScratchReferenceError) {
      return { ok: false, error: { code: err.code, message: err.message } };
    }
    return {
      ok: false,
      error: { code: 'invalid_reference', message: err instanceof Error ? err.message : String(err) },
    };
  }

  return {
    ok: true,
    contents: { uri, mimeType, text: bytes.toString('utf8') },
  };
}

/**
 * Enumerate every resource the bearer is allowed to see. Templated
 * resources expand via their `list` callback (one URI per harness, etc.);
 * concrete resources contribute one entry each.
 */
export async function listResources(auth: ResourceAuth): Promise<ListResourcesResult> {
  const principal = await resolveResourcePrincipal(auth);
  if (!principal) {
    return { ok: false, error: { code: 'invalid_bearer', message: 'Bearer did not resolve to a principal' } };
  }

  const visible = getResourceCatalog().filter((r) =>
    principal.capabilities.has('*') || principal.capabilities.has(r.capability),
  );

  try {
    const collected = await withWorkspace(principal.workspaceId, async (tx) => {
      const out: ResourceListEntry[] = [];
      for (const def of visible) {
        const ctx: ResourceContext = {
          principal,
          tx,
          log: (level, msg, meta) => {
            // eslint-disable-next-line no-console
            console[level === 'info' ? 'log' : level](
              `[agent-mcp][resource:list][${def.name}] ${msg}`,
              meta ?? '',
            );
          },
        };
        if (def.list) {
          try {
            const expanded = await def.list(ctx);
            out.push(...expanded);
          } catch (err) {
            // A single resource's list() failing must not block the rest.
            // eslint-disable-next-line no-console
            console.warn(
              `[agent-mcp] resource list() failed for ${def.name}:`,
              err instanceof Error ? err.message : err,
            );
          }
        } else {
          out.push({
            uri: def.uri,
            name: def.name,
            description: def.description,
            mimeType: def.mimeType,
          });
        }
      }
      return out;
    });
    return { ok: true, resources: collected };
  } catch (err) {
    return {
      ok: false,
      error: { code: 'list_error', message: err instanceof Error ? err.message : String(err) },
    };
  }
}

/**
 * Read a single resource by URI. Matches the URI against registered
 * templates, capability-checks the bearer, then runs the resource's
 * `read` callback inside a workspace-bound transaction.
 */
export async function readResource(opts: ReadResourceOptions): Promise<ReadResourceResult> {
  if (isScratchResourceUri(opts.uri)) {
    const principal = await resolveResourcePrincipal(
      opts.principal ? { principal: opts.principal } : { bearer: opts.bearer ?? '' },
    );
    if (!principal) {
      return { ok: false, error: { code: 'invalid_bearer', message: 'Bearer did not resolve to a principal' } };
    }
    return readScratchResource(opts.uri, principal);
  }

  const matched = matchResource(opts.uri);
  if (!matched) {
    return { ok: false, error: { code: 'unknown_resource', message: `No resource matches URI "${opts.uri}"` } };
  }
  const principal = await resolveResourcePrincipal(
    opts.principal ? { principal: opts.principal } : { bearer: opts.bearer ?? '' },
  );
  if (!principal) {
    return { ok: false, error: { code: 'invalid_bearer', message: 'Bearer did not resolve to a principal' } };
  }
  if (!principal.capabilities.has('*') && !principal.capabilities.has(matched.def.capability)) {
    return {
      ok: false,
      error: {
        code: 'missing_capability',
        message: `Principal ${principal.slug} lacks capability "${matched.def.capability}" (resource: ${matched.def.name})`,
      },
    };
  }

  try {
    const contents = await withWorkspace(principal.workspaceId, async (tx) => {
      const ctx: ResourceContext = {
        principal,
        tx,
        log: (level, msg, meta) => {
          // eslint-disable-next-line no-console
          console[level === 'info' ? 'log' : level](
            `[agent-mcp][resource:read][${matched.def.name}][${principal.slug}] ${msg}`,
            meta ?? '',
          );
        },
      };
      return await matched.def.read(opts.uri, ctx);
    });
    return { ok: true, contents };
  } catch (err) {
    return {
      ok: false,
      error: { code: 'read_error', message: err instanceof Error ? err.message : String(err) },
    };
  }
}

// ──────────────────────────────────────────────────────────────────────
// Prompt dispatch — symmetric to tool/resource dispatch.
// ──────────────────────────────────────────────────────────────────────

export interface ListPromptsResult {
  ok: boolean;
  prompts?: Array<{
    name: string;
    description: string;
    arguments?: Array<{ name: string; description?: string; required?: boolean }>;
  }>;
  error?: { code: string; message: string };
}

export interface GetPromptOptions {
  name: string;
  args: Record<string, string>;
  bearer: string;
}

export interface GetPromptResult {
  ok: boolean;
  result?: PromptResult;
  error?: { code: string; message: string };
}

/** Enumerate prompts visible to the bearer. */
export async function listPrompts(bearer: string): Promise<ListPromptsResult> {
  const principal = await resolveBearer(bearer);
  if (!principal) {
    return { ok: false, error: { code: 'invalid_bearer', message: 'Bearer did not resolve to a principal' } };
  }
  const visible = getPromptCatalog().filter(
    (p) => !p.capability || principal.capabilities.has(p.capability),
  );
  return {
    ok: true,
    prompts: visible.map((p) => ({
      name: p.name,
      description: p.description,
      arguments: p.arguments,
    })),
  };
}

/** Render a prompt by name with the given args. */
export async function getPrompt(opts: GetPromptOptions): Promise<GetPromptResult> {
  const def = lookupPrompt(opts.name);
  if (!def) {
    return { ok: false, error: { code: 'unknown_prompt', message: `No prompt named "${opts.name}"` } };
  }
  const principal = await resolveBearer(opts.bearer);
  if (!principal) {
    return { ok: false, error: { code: 'invalid_bearer', message: 'Bearer did not resolve to a principal' } };
  }
  if (def.capability && !principal.capabilities.has(def.capability)) {
    return {
      ok: false,
      error: {
        code: 'missing_capability',
        message: `Principal ${principal.slug} lacks capability "${def.capability}" (prompt: ${def.name})`,
      },
    };
  }
  // Enforce required-arg presence.
  for (const argSpec of def.arguments ?? []) {
    if (argSpec.required && !(argSpec.name in opts.args)) {
      return {
        ok: false,
        error: {
          code: 'missing_argument',
          message: `Prompt "${def.name}" requires argument "${argSpec.name}"`,
        },
      };
    }
  }

  try {
    const result = await withWorkspace(principal.workspaceId, async (tx) => {
      const ctx: PromptContext = {
        principal,
        tx,
        log: (level, msg, meta) => {
          // eslint-disable-next-line no-console
          console[level === 'info' ? 'log' : level](
            `[agent-mcp][prompt:get][${def.name}][${principal.slug}] ${msg}`,
            meta ?? '',
          );
        },
      };
      return await def.render(opts.args, ctx);
    });
    return { ok: true, result };
  } catch (err) {
    return {
      ok: false,
      error: { code: 'render_error', message: err instanceof Error ? err.message : String(err) },
    };
  }
}

export interface StartServerOptions {
  /** Use stdio transport. Default true. */
  stdio?: boolean;
  /** Bearer source for stdio transport — env var name. Default `AGENT_MCP_BEARER`. */
  bearerEnv?: string;
}

export async function startServer(opts: StartServerOptions = {}): Promise<void> {
  const stdio = opts.stdio ?? true;
  const bearerEnv = opts.bearerEnv ?? 'AGENT_MCP_BEARER';

  const server = new Server(
    { name: 'agent-mcp', version: '0.1.0' },
    { capabilities: { tools: {}, resources: {}, prompts: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const bearer = process.env[bearerEnv] ?? '';
    const principal = bearer ? await resolveBearer(bearer) : null;
    const catalog = getCatalog();
    const tools = await Promise.all(
      catalog
      .filter((t) => !principal || principal.capabilities.has(t.capability))
      .map(async (t) => {
        // GUARDED conversion, never a raw z.toJSONSchema (EI-10996 / WI-4596).
        // This runs inside the tools/list map, so an unrepresentable args schema
        // (almost always a trailing `.transform()`) throws for the WHOLE catalog,
        // not just its own tool — killing tool discovery for every client. Raw, that
        // surfaces as a bare adapter message naming no tool and no file, which reads
        // like an unrelated infra/zod break and was mis-triaged as one.
        const inputSchema = toArgsJsonSchema(t.name, t.args);
        delete (inputSchema as Record<string, unknown>).$schema;
        // Registry write-positional tools advertise a single `row` string (P-008).
        const advertised = advertisedArgsSchema(t.name, inputSchema);
        // Publish small entity vocabularies as enums so the model cannot EMIT an
        // invalid pot/role, rather than being corrected at dispatch (P-004b).
        // Capped + fail-open: over-cap or unavailable kinds change nothing here.
        await applyEntityRefEnums(t.args, advertised);
        // Objectify boolean sub-schemas (z.unknown() → `true`) so strict
        // consumers (Ollama) can parse the tool surface. See tool-schema-sanitize.ts.
        return { name: t.name, description: t.description, inputSchema: sanitizeToolSchema(advertised) };
      }),
    );
    // Pin to the tool manifest (if configured) for cache-stable parity with
    // the HTTP transport. No-op when no manifest is present. See tool-manifest.ts.
    return { tools: applyToolManifest(tools) };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const bearer = process.env[bearerEnv] ?? '';
    const result = await dispatch({
      toolName: req.params.name,
      args: req.params.arguments ?? {},
      bearer,
    });
    if (!result.ok) {
      return {
        isError: true,
        content: [
          { type: 'text', text: `${result.error?.code}: ${result.error?.message}` },
        ],
      };
    }
    // Format-aware serialization (token-efficient-tool-result-formats P-005) —
    // the same single serializer the HTTP path uses. stdio is an agent-facing
    // MCP transport, so it defaults to compact; a client can override per call
    // via `_meta.format`. The envelope (nextCursor/degraded) rides in `_meta`.
    const r = result.response!;
    if ('content' in r) return r;
    const meta = req.params._meta as { format?: string; structured?: boolean } | undefined;
    const serialized = serializeToolResponse(
      r,
      formatOptsFromCtx(
        { requestedFormat: meta?.format, requestedStructured: meta?.structured === true, transport: 'mcp' },
        lookupByMcpName(req.params.name)?.resultEligibility,
      ),
    );
    return {
      content: serialized.content,
      ...(Object.keys(serialized._meta).length > 0 ? { _meta: serialized._meta } : {}),
      ...(serialized.structuredContent !== undefined ? { structuredContent: serialized.structuredContent } : {}),
    };
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const bearer = process.env[bearerEnv] ?? '';
    const result = await listResources(bearer);
    return { resources: result.ok ? (result.resources ?? []) : [] };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const bearer = process.env[bearerEnv] ?? '';
    const result = await readResource({ uri: req.params.uri, bearer });
    if (!result.ok) {
      throw new Error(`${result.error?.code}: ${result.error?.message}`);
    }
    return { contents: [result.contents!] };
  });

  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    const bearer = process.env[bearerEnv] ?? '';
    const result = await listPrompts(bearer);
    return { prompts: result.ok ? (result.prompts ?? []) : [] };
  });

  server.setRequestHandler(GetPromptRequestSchema, async (req) => {
    const bearer = process.env[bearerEnv] ?? '';
    const result = await getPrompt({
      name: req.params.name,
      args: (req.params.arguments ?? {}) as Record<string, string>,
      bearer,
    });
    if (!result.ok) {
      throw new Error(`${result.error?.code}: ${result.error?.message}`);
    }
    return {
      description: result.result!.description,
      messages: result.result!.messages,
    };
  });

  if (stdio) {
    const transport = new StdioServerTransport();
    await server.connect(transport);
  }
}

export type { Principal, ToolDefinition, ToolResponse };
