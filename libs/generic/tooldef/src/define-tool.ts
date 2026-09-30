/**
 * defineTool — the simplification engine.
 *
 * Tools are declared via `defineTool({ capability, args, handler })` and
 * placed in `src/tools/<group>/<verb>.ts`. The helper:
 *   - Derives the tool name from the file path: `tools/tasks/list.ts` →
 *     `tasks:list`. Override via `name` if needed.
 *   - Composes the description from `guidance` (when/notWhen/chaining)
 *     when not passed explicitly — see `describeFromGuidance`.
 *   - Looks up the tier from the capability per §10.6.1.
 *   - Self-registers into the runtime catalog (`registry.ts`).
 *
 * The catalog is the result of importing `tools/**`. The MCP `tools/list`
 * response is generated from the catalog at startup. Adding a tool is
 * dropping a file; no manual list to maintain.
 */

import { type ZodTypeAny } from 'zod';
import { tierFor } from './capability-tiers';
import { toJsonSchema } from './schema-adapter';
import { standardValidate, formatIssues, issuesAreValueLevel, issueLeaves, type StandardSchemaV1 } from './standard-schema';
import {
  applyArgReencodings,
  boundValue,
  correctedDisclosure,
  type AppliedArgCorrection,
  type ArgReencoding,
  type ArgReencodingOutcome,
} from './reencode-args';
import { register } from './registry';
import { collectToolEmits } from './emits-registry';
import {
  PROJECTED_TOOL_REGISTRY_SOURCE,
  projectedToolRegistryRevision,
  renderProjectedToolCall,
  registerProjectedTool,
  resolveMcpName,
  recordToolShapers,
  isProjectedToolDrop,
  type ProjectedToolCorrectiveCall,
  type ProjectedToolArgRedirect,
  type ProjectedTool,
  type ToolFn,
  type ToolExposure,
  type UnifiedToolContext,
} from './tool-projection';
import {
  UnauthorizedToolError,
  InvalidInputError,
  type InvalidInputCorrection,
  type InvalidInputMetadata,
} from './dispatch-projected';
import { serverVintageHint, constraintVintageHint } from './server-vintage';
import { readAmbientArgKeys } from './ambient-args';
import { GUIDANCE_SECTION_LABELS, GUIDANCE_SECTION_SEPARATOR } from './partial-guidance';
import { buildCorrectedCall, correctedCallHint } from './corrected-call';
import { serializeToolResponse, formatOptsFromCtx } from './serialize-result';
import { applyPayloadTier, extractPayloadTier, resolvePayloadTier, PAYLOAD_TIER_ARG } from './payload-tier';
import { boundWorkspaceTx } from './workspace-tx';
import {
  parseDeltaRequest,
  computeViewFingerprint,
  contentRevision,
  negotiateDelta,
  decodeDeltaCursor,
  computeRowDigest,
  computeViewChecksum,
  diffFromDigest,
  deltaCounts,
  isSemanticDeltaEnabled,
  DELTA_SMALL_RESPONSE_BYTES,
  computeRowDigestUncapped,
  type DeltaCapability,
  type DeltaNegotiation,
} from './delta-protocol';
import { putRowDigest, getRowDigest } from './delta-digest-store';
import {
  analyzeSchema,
  projectReadColumns,
  projectWriteColumns,
  reconstructArgs,
  isWritePositional,
  getPrePromptEntry,
  isObjectWithArrayField,
  type ColumnSpec,
  type EligibilityResult,
} from '@papercusp/result-encoding';
import type {
  RoleToolDefinition,
  RoleToolDefinitionInput,
  RouteDefinition,
  ToolContext,
  ToolDefinition,
  ToolDefinitionInput,
  ToolGuidance,
  ToolResponse,
} from './types';
import type { ToolResult } from './wire';

// Narrow authoring entrypoint consumers (notably hosted HTTP profiles) need
// the route shape beside defineTool without importing src/index.ts's complete
// dispatch/code-orchestration surface.
export type { RouteDefinition } from './types';

/**
 * The absolute path of the file that called `defineTool` — a tool's DEFINITION
 * SITE, captured from the call stack at registration time.
 *
 * Derived, never declared: a tool that had to hand-write its own source path
 * would be a second copy of a truth the module graph already owns, and it would
 * drift the first time a file moved (derived-truth-ladder rung 1). Nothing here
 * is host-specific — "where was this tool defined" is a property of any tool
 * registry, so it stays in the generic lib; what a HOST then does with the path
 * (resolve it against a repo, ask git whether it is stale) is the host's policy.
 *
 * ## Why the frame is SEARCHED rather than indexed
 *
 * The previous implementation took frame `[2]` with the comment
 * "[0]=this fn, [1]=defineTool, [2]=caller". That was off by one: this helper is
 * called from inside `definePrincipalGatedTool` / `defineRoleGatedTool`, which
 * `defineTool` delegates to, so the real caller sits at `[3]`. Frame `[2]` is
 * `defineTool` itself, whose path (`.../tooldef/src/define-tool.ts`) never
 * matches the `/tools/<group>/<verb>` convention below — so the derivation
 * silently returned `null` for every tool instead of throwing. It went unnoticed
 * because every first-party tool passes an explicit `name`.
 *
 * A hardcoded index is the wrong shape for a stack whose depth is an
 * implementation detail of this file. So: skip every frame belonging to THIS
 * file (identified from frame `[0]`, which is always this function — no
 * `import.meta.url`, which the CJS preflight seam can render differently) and
 * take the first frame outside it. Correct at any delegation depth, and it stays
 * correct when this file is refactored again.
 */
/**
 * A stack frame's file, as an absolute FILESYSTEM PATH.
 *
 * `getFileName()` returns a `file://` URL under ESM and a bare path under CJS, but
 * `ProjectedTool.sourceFile` is documented as an absolute PATH, and every host consumer
 * resolves it against a repo root by string-prefix comparison. A URL fails that
 * comparison — and fails it QUIETLY, in the direction that looks like a legitimate
 * answer: the host reports "this file is outside the repo" rather than erroring, so a
 * verdict built on it degrades to `unknown` for EVERY tool with nothing failing anywhere.
 *
 * Measured 2026-09-05 (P-003 / EI-22450280531836927): `toolSchemaStaleness` in
 * operator-core answered `unknown/source-outside-repo` for 884 of 1,078 open
 * tool-failure filings — 100% of the ones whose subject resolved at all — because
 * `relativizeToRepo('file:///home/.../x.ts', '/home/.../papercusp')` is null by
 * construction. Its unit tests never caught it: they inject a `sourceFileFor` stub that
 * returns a plain path, so the one seam that carries the URL was the one seam never
 * exercised.
 *
 * Converted here, at the field's source, so no consumer has to know which module system
 * registered a tool. Deliberately dependency-free (no `node:url`): this lib ships a
 * browser-safe barrel.
 */
function definitionSitePath(file: string): string {
  // Only the local-file form. A `file://host/share` UNC URL has no path equivalent here
  // and is left exactly as it came, rather than being mangled into a plausible-looking
  // absolute path — an unusable value must stay recognisably unusable.
  if (!file.startsWith('file:///')) return file;
  let path = file.slice('file://'.length);
  // A Windows drive URL is `file:///C:/x`; the leading slash is part of the URL grammar,
  // not the path.
  if (/^\/[A-Za-z]:/.test(path)) path = path.slice(1);
  try {
    return decodeURIComponent(path);
  } catch {
    // A malformed escape is not a reason to lose the frame entirely.
    return path;
  }
}

function captureDefinitionSite(): string | null {
  const ErrorAny = Error as unknown as {
    prepareStackTrace?: (err: Error, stack: unknown[]) => unknown;
  };
  const orig = ErrorAny.prepareStackTrace;
  const origLimit = Error.stackTraceLimit;
  try {
    ErrorAny.prepareStackTrace = (_err: Error, stack: unknown[]) => stack;
    // Bounded: we need the nearest few frames, not a full trace. Measured at
    // ~10.6µs per capture, ~8.7ms across a full 820-tool catalog boot.
    Error.stackTraceLimit = 12;
    const raw = new Error().stack as unknown as Array<{ getFileName?: () => string }>;
    if (!Array.isArray(raw) || raw.length === 0) return null;
    // Frame [0] is this function, so its file IS this file.
    const selfFile = raw[0]?.getFileName?.() ?? null;
    for (const frame of raw) {
      const file = frame?.getFileName?.();
      if (!file) continue;
      if (selfFile && file === selfFile) continue;
      // Node internals ('node:internal/...') are never a definition site.
      if (file.startsWith('node:')) continue;
      return definitionSitePath(file);
    }
    return null;
  } catch {
    return null;
  } finally {
    ErrorAny.prepareStackTrace = orig;
    Error.stackTraceLimit = origLimit;
  }
}

/**
 * Derive a tool name from its definition site's path. Convention:
 *   .../tools/tasks/list.ts    → tasks:list
 *   .../tools/harness/get.ts   → harness:get
 *   .../tools/search/query.ts  → search:query
 *
 * If the file is `index.ts`, the parent directory contributes the verb;
 * useful for tools that need a directory of helpers.
 */
function deriveNameFromCallSite(site: string | null): string | null {
  if (!site) return null;
  // Find the segment after 'tools/'.
  const match = /\/tools\/([^/]+)\/([^/]+)\.[mc]?[jt]s$/.exec(site);
  if (!match) return null;
  const group = match[1];
  let verb = match[2];
  if (verb === 'index') {
    verb = 'default';
  }
  return `${group}:${verb}`;
}

/**
 * Compose a model-facing description from `guidance` for tools that omit
 * an explicit `description`. Nearly every first-party tool carries rich
 * when/notWhen/chaining guidance but no `description` — and the old
 * fallback was a useless `Tool <name>` placeholder. A model handed 200+
 * tools all described as "Tool X" cannot tell them apart: the operator
 * brain confabulated harness state rather than call tools it could not
 * distinguish (2026-05-21 P5 root cause; verified with a model-API proxy
 * — the brain received all 228 agentmcp tools but every description was
 * the placeholder). The `guidance` object stays separately available for
 * role system-prompt assembly — this only fills the `description` slot,
 * which is the only field the MCP `tools/list` wire actually carries.
 */
function describeFromGuidance(guidance: ToolGuidance | undefined): string | null {
  if (!guidance) return null;
  const parts: string[] = [];
  // Labels come from the SHARED constant that `partial-guidance.ts` splits on,
  // so the composer and the projection cannot drift into two copies of the
  // format (derived-truth ladder, rung 1).
  const L = GUIDANCE_SECTION_LABELS;
  if (guidance.when) parts.push(`${L.when} ${guidance.when}`);
  if (guidance.notWhen) parts.push(`${L.notWhen} ${guidance.notWhen}`);
  if (guidance.chaining) parts.push(`${L.chaining} ${guidance.chaining}`);
  return parts.length > 0 ? parts.join(GUIDANCE_SECTION_SEPARATOR) : null;
}

/**
 * Compute the output-schema JSON projection + format eligibility once at
 * register time (token-efficient-tool-result-formats P-001/P-002). Returns
 * empties when the tool declared no output schema or the projection fails —
 * such tools fall back to the TOON runtime auto-encoder at serialize time.
 */
function computeOutputEligibility(
  resultSchema: StandardSchemaV1 | undefined,
): { jsonSchema?: Record<string, unknown>; eligibility?: EligibilityResult } {
  if (!resultSchema) return {};
  try {
    const js = toJsonSchema(resultSchema);
    delete (js as Record<string, unknown>).$schema;
    return { jsonSchema: js, eligibility: analyzeSchema(js) };
  } catch {
    return {};
  }
}

/**
 * Build the MCP `ToolResult` from a handler's `ToolResponse` using format-aware
 * serialization (P-005/P-006). The chosen format follows the request context
 * (explicit negotiation, else MCP→compact / others→JSON) intersected with the
 * tool's precomputed eligibility; the pagination/degraded envelope rides in
 * `_meta`. When `PAPERCUSP_VALIDATE_TOOL_OUTPUT=1` and an output schema is
 * declared, the returned `data` is validated against it and a mismatch is
 * logged (best-effort, never throws — D-003 payoff #3).
 */
/**
 * Resolve the freshness negotiation for one projected tool call (agent-tool-delta-
 * protocol-2026-06-22). Layers the Lane-E semantic upgrade on top of the Lane-B
 * view-level decision (`negotiateDelta`):
 *
 *   - no `_delta` request AND no `delta` capability → undefined (today's path).
 *   - `_delta` request, non-capable tool → full, `supported:false`.
 *   - capable tool: small-response bypass → full; else compute the view revision +
 *     (for a semantic tool) the row digest + checksum, run the Lane-B decision, and
 *     UPGRADE a `changed` outcome to `mode:'delta'` when the request wants it, the
 *     prior cursor carried a digest, the cursor is within `maxDeltaAge`, and the
 *     computed delta is actually smaller than a full resend.
 *
 * Never throws: a thrown `revision()`/`changesSince()` degrades to a full body.
 */
async function negotiateToolDelta(
  def: { name: string; delta?: DeltaCapability },
  ctx: UnifiedToolContext,
  args: unknown,
  response: ToolResponse,
): Promise<DeltaNegotiation | undefined> {
  const request = parseDeltaRequest(ctx.requestedDelta);
  if (!request && !def.delta) return undefined;
  if (!def.delta) return negotiateDelta({ request, capabilityDeclared: false });

  const cap = def.delta;
  const scope = cap.scope?.(args, ctx);
  const fingerprint = computeViewFingerprint({ toolName: def.name, args: args ?? null, scope, format: ctx.requestedFormat });
  const body = response && typeof response === 'object' ? (response as ToolResponse).data : undefined;
  const fullJsonLen = JSON.stringify(body ?? null).length;
  if (fullJsonLen < DELTA_SMALL_RESPONSE_BYTES) {
    return negotiateDelta({ request, capabilityDeclared: true, currentFingerprint: fingerprint, bypass: true });
  }

  // Semantic surface active when the tool can produce a diffable row array — via
  // the `rows` selector (e.g. flatten groups) or because the body IS the array —
  // AND declared `itemKey`. Otherwise it's a Lane-B (full | not_modified) tool.
  const rows = cap.rows ? cap.rows(body) ?? null : Array.isArray(body) ? (body as unknown[]) : null;
  const itemKey = cap.itemKey;
  let digest: Record<string, string> | null = null;
  let checksum: string | undefined;
  if (rows && itemKey) {
    digest = computeRowDigest(rows, itemKey, cap.rowRevision);
    checksum = computeViewChecksum(rows, itemKey, cap.rowRevision);
  }

  // Revision precedence: an explicit `cap.revision` (the cheapest signal) → the
  // view checksum for a semantic tool → a content hash of the whole body. Only the
  // explicit path can throw; the derived paths are pure over the handler's output.
  let currentRevision: string;
  try {
    currentRevision = cap.revision
      ? String(await cap.revision(args, ctx))
      : checksum !== undefined
        ? checksum
        : contentRevision(body ?? null);
  } catch (err) {
    ctx.log(`[delta] ${def.name} revision() threw; serving full: ${err instanceof Error ? err.message : String(err)}`);
    return { mode: 'full', supported: true, reason: 'revision_error' };
  }

  const nowMs = Date.now();
  // P-024: a view over DELTA_MAX_DIGEST_ENTRIES used to mint no digest at all, so it
  // could never delta — `plans.list` (933 rows) re-shipped ~822 KB per warm poll. The
  // cap is about what fits in a URL cursor, not about what can be diffed, so park the
  // full digest server-side and carry only an opaque id. Bound to the view fingerprint
  // (the cursor is client-supplied; see delta-digest-store safety property 2).
  let digestId: string | undefined;
  if (rows && itemKey && digest === null) {
    digestId = putRowDigest(
      computeRowDigestUncapped(rows, itemKey, cap.rowRevision),
      fingerprint,
      rows.length,
    );
  }
  const cursorExtra = digest
    ? { dg: digest, ts: nowMs }
    : digestId
      ? { di: digestId, ts: nowMs }
      : undefined;

  const base = negotiateDelta({
    request,
    capabilityDeclared: true,
    currentRevision,
    currentFingerprint: fingerprint,
    schemaVersion: cap.schemaVersion,
    cursorExtra,
  });
  // A semantic full/not_modified response carries the view checksum so the harness
  // can verify a later merge (and store it with the base).
  if (checksum && base.mode !== 'delta') base.checksum = checksum;

  // P-024: SAY that this endpoint can never serve a row-level delta, rather than
  // answering a bare `full` that is indistinguishable from "nothing changed" and
  // leaving the caller to pay for `_delta` round-trips forever. Size is no longer a
  // reason (large views park their digest server-side above) — only a missing semantic
  // surface is permanent.
  if (!rows || !itemKey) {
    base.semanticUnavailable = { reason: 'no_semantic_surface', needs: itemKey ? 'rows' : 'itemKey' };
  }

  // Convey the itemKey FIELD NAME so an OUT-OF-PROCESS client (the MCP proxy) can merge
  // a delta generically (`row[itemKeyField]`); in-process clients read `itemKey` from the
  // registry and ignore it. Only meaningful for a semantic (itemKey-declared) tool.
  if (cap.itemKeyField && itemKey && base.supported) base.itemKeyField = cap.itemKeyField;

  // Upgrade `changed` → `delta` only when the harness wants a delta body (mode
  // `auto`; an explicit `not_modified`/`full` is honored as-is) and it's safe.
  const wantsDelta = !!request && request.mode !== 'full' && request.mode !== 'not_modified';
  if (rows && itemKey && base.mode === 'full' && base.reason === 'changed' && wantsDelta) {
    // The semantic-delta upgrade is host-gated (FLAGS.TOOL_DELTA_PROTOCOL). The
    // flag read sits HERE — after the structural narrowing — so it runs only on a
    // changed-view + delta-request call (never per-call) and degrades to the
    // unconditionally-safe Lane-B `full` (reason `flag_off`) when off, never a
    // semantic delta. dormant-safe: OFF is byte-identical to a delta-unaware host.
    if (!(await isSemanticDeltaEnabled(ctx))) {
      base.reason = 'flag_off';
      return base;
    }
    // reason 'changed' ⇒ the request cursor decoded and its fp+sv matched.
    const decoded = decodeDeltaCursor(request!.cursor);
    // The prior state is either embedded (`dg`, small views) or parked server-side
    // (`di`, large views — P-024). A `di` miss (evicted, restarted, or a fingerprint
    // mismatch) is an ordinary miss: degrade to full, never to a wrong delta.
    const priorDigest = decoded?.dg ?? (decoded?.di ? getRowDigest(decoded.di, fingerprint) : undefined);
    if (!decoded || !priorDigest) {
      // Distinguish CAUSE from SYMPTOM (P-024). `no_digest` says only "the prior cursor
      // carried none", which is also what a first delta-capable call looks like.
      // `digest_expired` is the large-view path losing its parked digest — recoverable,
      // and the very next response re-parks one, unlike the old permanent degradation.
      base.reason = decoded?.di ? 'digest_expired' : 'no_digest';
    } else if (cap.maxDeltaAge !== undefined && decoded.ts !== undefined && nowMs - decoded.ts > cap.maxDeltaAge) {
      base.reason = 'max_age';
    } else {
      try {
        const changes = cap.changesSince
          ? await cap.changesSince(args, decoded, ctx)
          : diffFromDigest(priorDigest, rows, itemKey, { rowRevision: cap.rowRevision, rowType: cap.rowType });
        // The delta must actually be smaller than a full resend, else just send full.
        if (JSON.stringify(changes).length >= fullJsonLen) {
          base.reason = 'delta_too_large';
        } else {
          return { mode: 'delta', supported: true, cursor: base.cursor, changes, checksum, counts: deltaCounts(changes) };
        }
      } catch (err) {
        ctx.log(`[delta] ${def.name} changesSince() threw; serving full: ${err instanceof Error ? err.message : String(err)}`);
        base.reason = 'changesSince_error';
      }
    }
  }
  return base;
}

async function serializeProjectedResult(
  response: ToolResponse,
  ctx: UnifiedToolContext,
  eligibility: EligibilityResult | undefined,
  def: { name: string; result?: StandardSchemaV1; delta?: DeltaCapability },
  readColumns?: ColumnSpec[],
  args?: unknown,
): Promise<ToolResult> {
  if (
    def.result &&
    process.env.PAPERCUSP_VALIDATE_TOOL_OUTPUT === '1' &&
    response &&
    typeof response === 'object' &&
    response.data !== undefined
  ) {
    try {
      const v = await standardValidate(def.result, response.data);
      if (!v.ok) {
        ctx.log(`[output-schema] ${def.name} returned data not matching its declared result schema: ${formatIssues(v.issues)}`);
      }
    } catch {
      /* validation is best-effort; never fail the call on it */
    }
  }

  // Framework freshness negotiation (agent-tool-delta-protocol-2026-06-22, P-005 +
  // P-011/P-012 semantic deltas). No-op unless the call carries a `_delta` request
  // or the endpoint declared a `delta` capability; never fails a call (a thrown
  // revision()/changesSince() degrades to full).
  const delta = await negotiateToolDelta(def, ctx, args, response);

  const serialized = serializeToolResponse(response, {
    ...formatOptsFromCtx(ctx, eligibility),
    toolName: def.name,
    readColumns,
    ...(delta ? { delta } : {}),
  });
  const result: ToolResult = { content: serialized.content as never };
  if (Object.keys(serialized._meta).length > 0) result._meta = serialized._meta;
  if (serialized.structuredContent !== undefined) result.structuredContent = serialized.structuredContent;
  return result;
}

/**
 * P-002 (definetool-token-optimization-adoption): the ~407 first-party tools that
 * hand-roll `return { content: [{ type:'text', text: JSON.stringify(x) }] }` bypass
 * the compact encoder — a raw `ToolResult` passes through untouched. When such a
 * result is, ON THE AGENT-FACING MCP TRANSPORT, a single text item that parses as
 * JSON whose shape TOON actually shrinks (an array, or an object with an array
 * field), this returns the parsed payload so the caller can re-route it through the
 * SAME serializer a `{ data }` handler uses — zero per-tool churn, lossless JSON
 * fallback. Otherwise returns `undefined` ⇒ the raw result is passed through verbatim.
 *
 * Deliberately narrow so it can NEVER change what a NON-agent consumer sees:
 *   - ONLY `ctx.transport === 'mcp'`. Every other transport — in-process compounds
 *     (`inProcessCall`'s `unwrap` → `JSON.parse`), HTTP, IPC, the desktop UI / TUI
 *     Memory tab — keeps the EXACT raw bytes, preserving the memory:* verbatim-content
 *     contract (memory-taxonomy-and-debt-followups P-006; those consumers read over a
 *     non-mcp transport, and an MCP agent reads the body as text, never JSON-parses it).
 *   - single text content only; skip `isError`, `structuredContent`, multi-content /
 *     uiResources, and any already-`format:`-marked compact body (never double-encode).
 *   - parse the text FIRST, then wrap `{ data: parsed }` — NOT `{ data: theWholeResult }`,
 *     which is the double-wrap that broke the past blanket attempt (define-tool L548).
 *   - only array / object-with-array-field payloads (a scalar / plain object round-trips
 *     to identical JSON — no win — so leave it untouched).
 */
function reencodableJsonPayload(out: ToolResult, ctx: UnifiedToolContext): unknown | undefined {
  if (ctx.transport !== 'mcp') return undefined;
  if (out.isError) return undefined;
  if (out.structuredContent !== undefined) return undefined;
  const content = out.content;
  if (!Array.isArray(content) || content.length !== 1) return undefined;
  const item = content[0] as { type?: unknown; text?: unknown } | undefined;
  if (!item || item.type !== 'text' || typeof item.text !== 'string') return undefined;
  const text = item.text;
  // Already a compact-encoded body (a `{data}` tool, or a hand-marked payload).
  if (/^format: (?:toon|csv|tsv|md)\n/.test(text)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined; // non-JSON text (a plain string / human message) — leave as-is
  }
  if (!Array.isArray(parsed) && !isObjectWithArrayField(parsed)) return undefined;
  return parsed;
}

/**
 * Preserve the result-door's explicit-full signal for handlers that return an
 * MCP-shaped `ToolResult` directly. The normal `{ data }` path gets this
 * marker from `applyPayloadTier`, but raw results bypass that helper; without
 * the marker, an oversized explicit-full body is generically re-projected by
 * the result door instead of being spilled losslessly.
 *
 * Merge into existing metadata so handler-supplied fields survive. Ordinary
 * calls return the original result unchanged, keeping the default raw-result
 * contract byte- and metadata-stable.
 */
function markExplicitFullRawResult<T extends ToolResult>(
  result: T,
  explicitFullRequest: boolean,
): T {
  if (!explicitFullRequest) return result;
  return {
    ...result,
    _meta: { ...(result._meta ?? {}), explicitFullRequest: true },
  } as T;
}

function isExplicitFullPayloadRequest(
  callTier: ReturnType<typeof extractPayloadTier>['callTier'],
  ctx: Pick<UnifiedToolContext, 'contextTier' | 'transportCapExempt' | 'requestedStructured'>,
): boolean {
  // A structured-content request is a programmatic/schema-validation contract,
  // not merely a second rendering of the trimmed model-facing text. Generic
  // payload-tier projections can wrap/drop required fields (for example
  // activity:recent's `{ activity, count }`), making the value fail the
  // outputSchema the MCP client validates on `tools/call`. Preserve the raw
  // data whenever the caller explicitly asks for structuredContent; the result
  // door still owns the separate model-facing text budget.
  return (
    callTier === 'full' ||
    ctx.contextTier === 'full' ||
    ctx.transportCapExempt === true ||
    ctx.requestedStructured === true
  );
}

/**
 * A few legacy handlers return a hybrid envelope: human-facing MCP `content`
 * alongside the authoritative structured `data` payload. Treating that value
 * as a raw `ToolResult` drops `data` at the transport boundary because
 * `dispatchProjectedToolToMcp` intentionally forwards only MCP fields. The
 * launch-agent capability is the measured instance: its successful response
 * contains a prose launch summary plus `{ deduped, launch }` data, so ptool's
 * JSON-mode caller used to receive the prose instead of machine-readable JSON.
 *
 * Keep this adaptation MCP-only. HTTP, IPC, and in-process callers may consume
 * the handler's original content contract directly (including content that is
 * deliberately human-readable). MCP callers instead receive the data through
 * the same serializer as canonical `{ data }` handlers, including negotiated
 * `structuredContent`, while preserving the handler's protocol failure bit and
 * metadata.
 */
function isHybridToolResponse(
  response: ToolResponse | ToolResult,
): response is ToolResponse & ToolResult {
  return (
    response !== null &&
    typeof response === 'object' &&
    Array.isArray((response as ToolResult).content) &&
    Object.hasOwn(response, 'data') &&
    (response as ToolResponse).data !== undefined
  );
}

async function serializeHybridToolResponse(
  response: ToolResponse & ToolResult,
  ctx: UnifiedToolContext,
  eligibility: EligibilityResult | undefined,
  def: { name: string; result?: StandardSchemaV1; delta?: DeltaCapability },
  readColumns?: ColumnSpec[],
  args?: unknown,
): Promise<ToolResult> {
  if (ctx.transport !== 'mcp') return response;

  const serialized = await serializeProjectedResult(response, ctx, eligibility, def, readColumns, args);
  const result: ToolResult = {
    ...serialized,
    ...(response.isError !== undefined ? { isError: response.isError } : {}),
    ...(response._meta || serialized._meta
      ? { _meta: { ...(response._meta ?? {}), ...(serialized._meta ?? {}) } }
      : {}),
  };
  // The serializer's data-derived structured value is authoritative when it
  // was requested. Preserve a handler-supplied structured value only when the
  // serializer did not produce one, keeping the hybrid path lossless for
  // callers that already supplied an MCP structured twin.
  if (result.structuredContent === undefined && response.structuredContent !== undefined) {
    result.structuredContent = response.structuredContent;
  }
  if (response.outputRef !== undefined) result.outputRef = response.outputRef;
  if (response.outputSize !== undefined) result.outputSize = response.outputSize;
  return result;
}

/**
 * EI-20305133624359928: an object-rooted `result` schema is advertised to MCP
 * clients as `outputSchema`. The official SDK then requires `structuredContent`
 * whenever the caller opted into it, even when a legacy handler returned an
 * already-serialized JSON `ToolResult` instead of the canonical `{ data }`
 * envelope. Passing that raw result through unchanged makes a perfectly valid
 * business-level miss fail at the transport boundary with MCP -32600.
 *
 * Preserve the handler's text bytes, `isError`, resources, and metadata; only
 * add the schema-validated structured twin the caller explicitly requested.
 * Invalid/non-JSON raw results remain untouched so we never manufacture data
 * that the advertised schema does not actually describe.
 */
async function attachRequestedStructuredContent(
  out: ToolResult,
  ctx: UnifiedToolContext,
  def: { name: string; result?: StandardSchemaV1 },
): Promise<ToolResult> {
  if (
    ctx.transport !== 'mcp' ||
    ctx.requestedStructured !== true ||
    !def.result ||
    out.structuredContent !== undefined
  ) {
    return out;
  }
  const first = out.content?.[0] as { type?: unknown; text?: unknown } | undefined;
  if (!first || first.type !== 'text' || typeof first.text !== 'string') return out;

  let parsed: unknown;
  try {
    parsed = JSON.parse(first.text);
  } catch {
    return out;
  }
  const validated = await standardValidate(def.result, parsed);
  if (!validated.ok) {
    ctx.log(
      `[output-schema] ${def.name} returned raw JSON not matching its declared result schema: ` +
        formatIssues(validated.issues),
    );
    return out;
  }
  return { ...out, structuredContent: validated.value };
}

/**
 * P-019 (fleet-leadership-continuity-and-actuation-2026-08-01) — an
 * explicitly-`undefined` value means NOT PROVIDED, at every depth.
 *
 * `{ harness: undefined }` is idiomatic JS for "I have no value for this" — it is
 * what every spread of an optional (`{ ...(x ? { k: x } : {}) }` written the short
 * way as `{ k: x }`), every destructured passthrough, and every `obj[k] = maybe`
 * produces. But the key IS present in `Object.keys()`, so the EI-10883 closed-shape
 * gate rejects it as an unrecognized key — a hard `invalid_args` failure for a call
 * that supplied nothing at all. JSON has no `undefined`, so this is unreachable over
 * the MCP wire and hits ONLY in-process callers: `code:run` scripts (whose whole
 * point is writing ordinary JS against the catalog) and `tools:invoke`. Under
 * `code:run` it is worse than a wasted round-trip: a read's arg typo aborts the
 * WHOLE script, so already-ordered writes never execute (P-020).
 *
 * The strip is DEEP because the strictness it compensates for is deep:
 * `deepStrictifyInPlace` closes every nested object in the tree, so a top-level-only
 * strip would leave the nested case — `work_items:checkpoint { items: [{ id,
 * checkpoint, harness: undefined }] }`, exactly the row shape agents build in a loop
 * — still failing, for the same reason, one level down. That asymmetry is the bug
 * EI-18723223344390510 already had to fix once for strictness itself; fixing only
 * the level that happened to bite is what leaves it live.
 *
 * Runs FIRST, innermost of the pre-validation shim chain, so every downstream shim
 * sees a clean object: `applyHarnessArgAlias` keys off `'harness' in rec`, which
 * would otherwise rename `{ harness: undefined }` to `{ harness_slug: undefined }`
 * and fail validation just the same, one key over.
 *
 * Deliberately narrow so it can only ever REMOVE a no-op key:
 *  • object KEYS only — an `undefined` ARRAY ELEMENT is a positional value, and
 *    dropping it would silently reindex the array (a different, worse bug);
 *  • plain objects only (`Object.prototype`/null-prototype) — never a Date, Map,
 *    Buffer, or class instance, whose internals are not ours to rebuild;
 *  • returns the input BY REFERENCE when there is nothing to strip, so the common
 *    case allocates nothing and callers keep identity;
 *  • never mutates the caller's object — a rebuilt copy is returned instead, since
 *    the same args object may be retained/reused by the caller.
 */
export function stripUndefinedArgKeys(input: unknown): unknown {
  return stripUndefinedDeep(input, new Set());
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function stripUndefinedDeep(input: unknown, active: Set<object>): unknown {
  if (!input || typeof input !== 'object') return input;
  // Cycle guard: an args object built by a script can legitimately self-reference.
  if (active.has(input as object)) return input;

  if (Array.isArray(input)) {
    active.add(input as object);
    try {
      let changed = false;
      const out = input.map((el) => {
        const next = stripUndefinedDeep(el, active);
        if (next !== el) changed = true;
        return next;
      });
      return changed ? out : input;
    } finally {
      active.delete(input as object);
    }
  }

  if (!isPlainObject(input)) return input;

  active.add(input as object);
  try {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(input)) {
      const value = input[key];
      if (value === undefined) {
        changed = true; // drop it: an undefined value is an absent key
        continue;
      }
      const next = stripUndefinedDeep(value, active);
      if (next !== value) changed = true;
      out[key] = next;
    }
    return changed ? out : input;
  } finally {
    active.delete(input as object);
  }
}

/**
 * Write-side positional shim (token-efficient-agent-io P-008/D-006/D-007). When
 * the tool is registry write-positional and the model sent a single `row`
 * string, reconstruct the typed args from the prompt-declared column order and
 * run the misalignment guard BEFORE Zod validation. Returns the (possibly
 * reconstructed) input unchanged when the tool isn't positional or the caller
 * sent keyed args. Throws on a guard failure so a mis-emitted row fails LOUDLY
 * rather than writing wrong-but-valid data (Zod checks shape, not alignment).
 */
function applyPositionalWriteShim(name: string, argsJsonSchema: Record<string, unknown>, input: unknown): unknown {
  if (!isWritePositional(name)) return input;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const row = (input as Record<string, unknown>).row;
  if (typeof row !== 'string') return input; // keyed args (or no row) — leave as-is
  const entry = getPrePromptEntry(name);
  const cols = projectWriteColumns(argsJsonSchema, {
    freeTextName: entry?.freeTextArg,
    columnOverrides: entry?.columnOverrides,
    columnNames: entry?.writeColumnNames,
    requiredColumnNames: entry?.writeRequiredColumnNames,
  });
  if (!cols) return input; // tool doesn't actually fit the bounded positional shape
  const rec = reconstructArgs(row, cols);
  if (!rec.ok) throw new Error(`invalid_positional_row: ${rec.reason}`);
  return rec.args;
}

/**
 * EI-18729688357283797 — `harness` -> `harness_slug` arg alias, applied BEFORE validation.
 *
 * The catalog's dominant harness-scoping spelling is `harness` (work_items:*, docs:*,
 * plans:*, features:*, issues:*, harness:*, coord:orient, …) and the su persona
 * explicitly teaches it as THE way to scope a per-call ("name the harness on the
 * call: harness: '<slug>'"). A minority of tools (the search:* family — search:fulltext,
 * search:semantic) instead declare `harness_slug`. Because arg validation is STRICT
 * (EI-10883), the taught reflex produces a guaranteed-failing call against those
 * tools — a wasted round-trip every time, never a silent partial. Worse, the shared
 * did-you-mean hint (COMMON_ARG_ALIASES) can suggest the WRONG fix when the tool
 * separately declares an unrelated `scope` arg that happens to share a semantic-alias
 * slot with `harness` (search:fulltext's `scope` is the search-source list, not a
 * harness — confirmed live: the hint says "Did you mean `scope` for `harness`?", which
 * is actively misleading there).
 *
 * Rather than merely teach a better error, ACCEPT the call: when the tool's declared
 * shape has `harness_slug` but not `harness`, and the caller supplied `harness` without
 * `harness_slug`, transparently rename the key before validation. A caller who
 * (unusually) supplied BOTH keeps their explicit `harness_slug` untouched — this never
 * overrides an explicit value, and it is a no-op for every tool that already declares
 * `harness` itself (the common case).
 */
export function applyHarnessArgAlias(argsJsonSchema: Record<string, unknown>, input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const rec = input as Record<string, unknown>;
  if (!('harness' in rec) || 'harness_slug' in rec) return input;
  const props = (argsJsonSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
  if (!props || !('harness_slug' in props) || 'harness' in props) return input;
  const { harness, ...rest } = rec;
  return { ...rest, harness_slug: harness };
}

const SNAKE_CASE_ARG_KEY = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;
const LOWER_CAMEL_ARG_KEY = /^[a-z][A-Za-z0-9]*$/;

function snakeToLowerCamel(value: string): string {
  return value.replace(/_([a-z0-9])/g, (_match, char: string) => char.toUpperCase());
}

function casingTwin(left: string, right: string): boolean {
  if (SNAKE_CASE_ARG_KEY.test(left) && LOWER_CAMEL_ARG_KEY.test(right) && /[A-Z]/.test(right)) {
    return snakeToLowerCamel(left) === right;
  }
  if (SNAKE_CASE_ARG_KEY.test(right) && LOWER_CAMEL_ARG_KEY.test(left) && /[A-Z]/.test(left)) {
    return snakeToLowerCamel(right) === left;
  }
  return false;
}

/**
 * EI-19301104986780991 — exact snake_case <-> lowerCamelCase compatibility.
 *
 * The tool catalogue legitimately uses both conventions (`timeout_sec` on
 * checkpoint:await, `timeoutSec` on code:run; `related_msg_id` beside
 * `wakeOnReply` on coord:send). A caller that learned one spelling therefore
 * paid a guaranteed rejection round-trip on the sibling tool even when its
 * value and intent were otherwise complete.
 *
 * This is deliberately narrower than a did-you-mean rename. It runs only on
 * the validation-failure path, only for an exact bijective casing twin, only
 * when exactly one declared key matches, and never when the caller also sent
 * the canonical key. Semantic aliases, near names, conflicts, and genuinely
 * unknown keys still reach the EI-10883 strict refusal unchanged. The caller's
 * object is never mutated, and the existing D-104 correction disclosure names
 * the re-encoding on the successful result.
 */
export function applyCasingArgAliases(
  argsJsonSchema: Record<string, unknown>,
  input: unknown,
): ArgReencodingOutcome | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const rec = input as Record<string, unknown>;
  const properties =
    selectedUnionBranchProperties(argsJsonSchema, input) ?? mergedSchemaProperties(argsJsonSchema);
  if (!properties) return null;

  const declaredKeys = Object.keys(properties);
  const claimedTargets = new Set<string>();
  const corrections: AppliedArgCorrection[] = [];
  let rewritten: Record<string, unknown> | null = null;

  for (const source of Object.keys(rec)) {
    if (source in properties) continue;
    const matches = declaredKeys.filter((target) => casingTwin(source, target));
    if (matches.length !== 1) continue;
    const target = matches[0]!;
    if (target in rec || claimedTargets.has(target)) continue;

    rewritten ??= { ...rec };
    delete rewritten[source];
    rewritten[target] = rec[source];
    claimedTargets.add(target);
    corrections.push({
      path: source,
      sent: { [source]: boundValue(rec[source]) },
      ran: { [target]: boundValue(rec[source]) },
      rule: 'args.exact-casing-alias',
    });
  }

  return rewritten ? { input: rewritten, corrections } : null;
}

/**
 * EI-11621 — unwrap a client `__unparsedToolInput` envelope BEFORE validation.
 *
 * Some MCP clients (Claude Code) that cannot parse the model-emitted tool
 * arguments into structured JSON send `{ __unparsedToolInput: "<raw string>" }`
 * as the tool's arguments instead of the intended object — the raw string is the
 * JSON the model actually tried to emit. This hits tools with anyOf/nullable or
 * nested-object schemas (work_items:complete, session:request-compaction, …) the
 * hardest. Left as-is, the EI-10883 closed-shape gate rejects the reserved key
 * with a confusing "unrecognized key __unparsedToolInput", making those tools
 * unusable from that client without the code_run workaround (the reported bug).
 *
 * This transparently recovers the intended args: when the input object carries
 * `__unparsedToolInput`, JSON-parse its string value (or use it directly when the
 * client already handed us an object) and merge it UNDER any sibling keys the
 * client did parse (real sibling keys win — they are the caller's explicit
 * intent). A non-object / non-JSON payload is dropped so the real validation error
 * is about the actual args, not the framework envelope key. Never throws.
 */
export function unwrapUnparsedToolInput(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const rec = input as Record<string, unknown>;
  if (!('__unparsedToolInput' in rec)) return input;
  const { __unparsedToolInput: raw, ...rest } = rec;
  let recovered: unknown = raw;
  if (typeof raw === 'string') {
    try {
      recovered = JSON.parse(raw);
    } catch {
      // Not JSON — nothing to recover. Drop the reserved key so the failure is
      // reported against the real (remaining) args, not the envelope.
      return rest;
    }
  }
  if (recovered && typeof recovered === 'object' && !Array.isArray(recovered)) {
    return { ...(recovered as Record<string, unknown>), ...rest };
  }
  // Recovered a scalar / array — cannot be a tool-args object; strip the key.
  return rest;
}

/**
 * The unified endpoint primitive (Phase E6, endpoint-unification-2026-05-21).
 *
 * `defineTool` accepts THREE shapes, discriminated structurally:
 *   - **route-shaped** (`{ method, path, auth, handler }`) → returns a
 *     `RouteDefinition`. A plain Hono route; NOT in the agent catalog.
 *     The host mounts it via `registerRoute`. Authors call `defineTool`
 *     directly for routes (the former `defineRoute` alias is removed).
 *   - **role-gated tool** (`{ requirePrincipal: false, … }`) → a
 *     `RoleToolDefinition`, projected to MCP + the HTTP catch-all.
 *   - **principal-gated tool** (the default) → a `ToolDefinition`.
 *
 * One primitive, three projections — the route/tool duplication the
 * endpoint-unification plan set out to remove.
 */
export function defineTool<TArgs extends StandardSchemaV1>(
  input: RoleToolDefinitionInput<TArgs>,
): RoleToolDefinition<TArgs>;
export function defineTool<TArgs extends StandardSchemaV1>(
  input: ToolDefinitionInput<TArgs>,
): ToolDefinition<TArgs>;
// Route overload LAST: a tool-shaped call must resolve against the tool
// overloads first so its handler is contextually typed against the tool
// handler signature (a route-overload-first ordering widens the handler's
// return literals and then fails the tool overloads too). A genuine
// route-shaped call lacks `capability`/`args`/`requirePrincipal`, fails
// the two tool overloads structurally, and lands here.
// The `= undefined` default is load-bearing: a route file that declares
// no `input` schema and passes a standalone `handler` annotated
// `RouteContext<undefined>` gives TS nothing to infer `TInputSchema`
// from. Without the default it falls back to the constraint
// (`ZodTypeAny | undefined`) → `RouteContext<unknown>`, which the
// handler's `RouteContext<undefined>` param then rejects.
export function defineTool<TInputSchema extends ZodTypeAny | undefined = undefined>(
  input: RouteDefinition<TInputSchema>,
): RouteDefinition<TInputSchema>;
export function defineTool(
  input:
    | ToolDefinitionInput<StandardSchemaV1>
    | RoleToolDefinitionInput<StandardSchemaV1>
    | RouteDefinition<ZodTypeAny | undefined>,
): ToolDefinition<StandardSchemaV1> | RoleToolDefinition<StandardSchemaV1> | RouteDefinition<ZodTypeAny | undefined> {
  // Route-shaped — discriminated by `method` (tool inputs never carry it).
  if ('method' in input && 'path' in input) {
    return defineRouteShaped(input as RouteDefinition<ZodTypeAny | undefined>);
  }
  if ((input as RoleToolDefinitionInput<StandardSchemaV1>).requirePrincipal === false) {
    return defineRoleGatedTool(input as RoleToolDefinitionInput<StandardSchemaV1>);
  }
  return definePrincipalGatedTool(input as ToolDefinitionInput<StandardSchemaV1>);
}

/**
 * Route-shaped `defineTool`. Pure — returns the definition unchanged;
 * mounting happens host-side via `registerRoute`. A route declares its
 * own `auth` (incl. `kind: ['device']` if it admits paired devices) and
 * `cors` — there is no implicit folding.
 *
 * A route is deliberately NOT registered into the projection registry —
 * plumbing must not appear in the agent tool catalog.
 */
function defineRouteShaped<TInputSchema extends ZodTypeAny | undefined>(
  def: RouteDefinition<TInputSchema>,
): RouteDefinition<TInputSchema> {
  return def;
}

/**
 * Infer a tool's read/write effect (code-execution-tool-orchestration B-CX-PRE) from its
 * capability when not set explicitly: write-ish suffixes (`:write`/`:admin`/`:delete`/
 * `:manage`/`:execute`) ⇒ 'write'; everything else ⇒ 'read'. An explicit `effect` always
 * wins. Consumed by the code-execution sandbox's dry-run/confirm gate (read-only ⇒ no gate).
 */
export const WRITE_CAPABILITY_SUFFIXES = [':write', ':admin', ':delete', ':manage', ':execute'] as const;
/**
 * Known-mutating capabilities whose names don't end in a write-suffix — the
 * `capability:*` host-capability family (bash/fs-write/edit/write/git/computer/net/terminal) plus
 * dedicated control / side-effect capabilities (processes:kill, turn:interrupt,
 * ui:dispatch, tui:dispatch, operator:converse, activity:report).
 * Each is used ONLY by a mutating tool — where a read sibling exists it is a DISTINCT
 * `*:read` capability (ui:read, activity:read, operator:read) — so flipping the capability
 * is safe and self-documenting. Centralized here instead of backfilling each tool def.
 *
 * A tool can still override via an explicit `effect`; and a mutator that SHARES a `*:read`
 * capability with genuine readers (e.g. learning_packs:export, plans:export — both write
 * files under a `*:read` cap) sets `effect: 'write'` on its own def instead of polluting
 * this set (which would wrongly flip its read siblings). B-CX-EFFECT audit (2026-06-20).
 */
export const WRITE_CAPABILITIES = new Set<string>([
  'capability:bash',
  'capability:fs-write',
  'capability:edit',
  'capability:write',
  'capability:git',
  'capability:computer',
  'capability:net', // outbound HTTP (capability:fetch) — can POST/PUT/DELETE → external mutation
  'capability:terminal', // opens command/agent windows or headless agent processes
  'processes:kill',
  'processes:control', // freezes/thaws or re-budgets a live task's cgroup
  'turn:interrupt', // ends a peer agent's current turn
  'ui:dispatch', // performs a UI intent (click/navigate/submit) in a browser tab
  'tui:dispatch', // performs a control intent against a running pui workbench
  'operator:converse', // brain turn: spawns agents, records spend, mem0.add, dispatches <spawn>
  'activity:report', // inserts an agent-activity row
]);
/**
 * THE effect oracle. Exported (not merely used here) because it is the only
 * authoritative answer to "does this capability mutate?" in the tree, and callers
 * outside `defineTool` need it: a static scanner that cannot execute `defineTool`
 * — e.g. `scripts/check-no-bespoke-state-read.mjs`, whose whole bug class was
 * inferring effect from a tool's NAME while this function sat one lib away
 * (WI-6464: `processes:control` read as a state READ, so `processes:freeze` and
 * `processes:limit` were reported as undeclared state reads for hours).
 *
 * Anything re-deriving effect from naming is a second, drifting answer to a
 * question this owns. Consult it instead.
 */
export function inferCapabilityEffect(capability: string, explicit?: 'read' | 'write'): 'read' | 'write' {
  if (explicit) return explicit;
  const cap = capability.toLowerCase();
  if (WRITE_CAPABILITIES.has(cap)) return 'write';
  return WRITE_CAPABILITY_SUFFIXES.some((s) => cap.endsWith(s)) ? 'write' : 'read';
}

function definePrincipalGatedTool<TArgs extends StandardSchemaV1>(
  input: ToolDefinitionInput<TArgs>,
): ToolDefinition<TArgs> {
  const definitionSite = captureDefinitionSite();
  const name = input.name ?? deriveNameFromCallSite(definitionSite);
  if (!name) {
    throw new Error(
      'defineTool: could not derive tool name from call site. ' +
      'Pass `name` explicitly or place the file under `tools/<group>/<verb>.ts`.',
    );
  }
  const description =
    input.description ??
    describeFromGuidance(input.guidance) ??
    `Tool ${name}`;
  const tier = tierFor(input.capability);

  const def: ToolDefinition<TArgs> = {
    name,
    description,
    capability: input.capability,
    tier,
    effect: inferCapabilityEffect(input.capability, input.effect),
    effectForCall: input.effectForCall,
    idempotent: input.idempotent,
    abortCompletionReceipt: input.abortCompletionReceipt,
    replaces: input.replaces,
    composition: (input.replaces?.length ?? 0) > 0 ? 'composite' : 'primitive',
    // EI-10883: closed shape — an undeclared arg errors instead of being silently dropped.
    args: strictArgs(input.args),
    result: input.result ?? input.output,
    delta: input.delta,
    handler: input.handler,
    guidance: input.guidance,
    shape: input.shape,
    profile: input.profile,
    harness: input.harness,
    authorize: input.authorize,
    requireRoles: input.requireRoles,
    public: input.public,
    emits: input.emits,
    requires: input.requires,
    // P-062: cross-workspace opt-out, threaded so PRINCIPAL-gated tools (e.g.
    // memory:*) can run from an unscoped superuser session. The role-gated path
    // already threads this; the principal-gated path previously dropped it, so a
    // principal-gated cross-workspace tool failed `workspace_required`. See the field doc.
    crossWorkspace: input.crossWorkspace,
    // EI-18808330244321407: transaction retention is explicit opt-in.
    needsWorkspaceTx: input.needsWorkspaceTx,
    // Legacy no-op metadata retained for older plugin/source compatibility.
    skipWorkspaceTx: input.skipWorkspaceTx,
    // EI-19386201256023240: see ToolDefinition.skipResultDoor.
    skipResultDoor: input.skipResultDoor,
    // WI-37843: see ToolDefinition.payloadTierCeilingChars.
    payloadTierCeilingChars: input.payloadTierCeilingChars,
    // WI-37843: see ToolDefinition.ignoreSessionPayloadTier.
    ignoreSessionPayloadTier: input.ignoreSessionPayloadTier,
    // P-016 / D-104: see ToolDefinition.argReencodings. Threading this is what makes the
    // declaration reach `registerLegacyAsProjected`'s repair path — a field declared on the
    // input type but dropped here would leave every registered rule silently inert.
    argReencodings: input.argReencodings,
    // EI-19486111655110215: see ToolDefinition.argPreconditions. Threaded for the SAME
    // reason as argReencodings directly above — that field shipped INERT once because it
    // was declared on every interface and then dropped by this one-field-at-a-time copy
    // (EI-22172195473893352). A declaration without this line type-checks and does nothing.
    argPreconditions: input.argPreconditions,
  };

  // EI-20803112372029993: make the declared shapers reachable from the catalog.
  // `def.shape` is otherwise closed over by the dispatch handler below and by
  // nothing else, so no guard could enumerate the tools that rebuild rows at the
  // trimmed tier. Recorded with the `returns` prose because the contract check
  // derives its field list from that promise rather than a second hand-typed list.
  recordToolShapers(name, input.shape, input.guidance?.returns);

  // ORDER IS LOAD-BEARING: project FIRST (its first act is the guarded
  // args→JSON-Schema conversion), and only then enter the catalog.
  //
  // These two lines used to be reversed, which left a real hole: `register()`
  // seated the tool in the catalog and THEN the guard threw. While the throw is
  // fatal that is invisible — the process dies either way. But any caller that
  // CATCHES a module-import error (HMR re-eval, a test harness, a plugin loader)
  // resumes with an unrepresentable-schema tool still sitting in the catalog, and
  // the next tools/list serves it straight into `toArgsJsonSchema` — the exact
  // anonymous catalog-wide crash this guard exists to prevent. Projecting first
  // means a tool that cannot be represented never becomes catalog state at all.
  //
  // The catalog stores defs with their schema type erased (handlers run on
  // post-validation values); a specific TArgs isn't assignable to the
  // unknown-output base under Standard Schema's variance, so widen explicitly.
  registerLegacyAsProjected(def, input.expose, definitionSite);
  register(def as unknown as ToolDefinition);
  // Co-located intrinsic emissions → the generic collector; the operator-core
  // desugar registers them as event-reaction rules at load (D-002).
  collectToolEmits(name, input.emits);
  return def;
}

/**
 * Role-gated first-party tool — registers into the same projection
 * registry as principal-gated tools but skips the `principal+tx`
 * requirement in the wrapper. Gating happens via the dispatcher's
 * `roles` allowlist + `rolesQuota`, exactly as for plugin tools.
 *
 * The handler receives `UnifiedToolContext` directly (workspaceId,
 * harnessSlug, role, runId, etc.) — no `Principal`, no transaction.
 * If the tool needs PG, open its own connection from the workspace-
 * resolved pool; do not assume `tx` is set.
 */
function defineRoleGatedTool<TArgs extends StandardSchemaV1>(
  input: RoleToolDefinitionInput<TArgs>,
): RoleToolDefinition<TArgs> {
  const definitionSite = captureDefinitionSite();
  const name = input.name ?? deriveNameFromCallSite(definitionSite);
  if (!name) {
    throw new Error(
      'defineTool: could not derive tool name from call site. ' +
      'Pass `name` explicitly or place the file under `tools/<group>/<verb>.ts`.',
    );
  }
  // EI-20803112372029993 — see the twin call in `definePrincipalGatedTool`.
  // Recorded per-branch rather than once in the `defineTool` dispatcher because
  // the name is only resolved here: a tool that omits `name` and lets it be
  // derived from the call site is invisible upstream, and the SU tools this
  // guard exists for (routines:list among them) all take this branch.
  recordToolShapers(name, input.shape, input.guidance?.returns);
  const description =
    input.description ??
    describeFromGuidance(input.guidance) ??
    `Tool ${name}`;
  const tier = tierFor(input.capability);

  const def: RoleToolDefinition<TArgs> = {
    name,
    description,
    capability: input.capability,
    tier,
    effect: inferCapabilityEffect(input.capability, input.effect),
    effectForCall: input.effectForCall,
    idempotent: input.idempotent,
    abortCompletionReceipt: input.abortCompletionReceipt,
    replaces: input.replaces,
    composition: (input.replaces?.length ?? 0) > 0 ? 'composite' : 'primitive',
    requirePrincipal: false,
    authorize: input.authorize,
    requireRoles: input.requireRoles,
    public: input.public,
    agentRoles: input.agentRoles,
    rolesQuota: input.rolesQuota,
    timeoutSec: input.timeoutSec,
    idleTimeoutSec: input.idleTimeoutSec,
    replayBufferSize: input.replayBufferSize,
    crossWorkspace: input.crossWorkspace,
    // EI-18808330244321407: see RoleToolDefinition.needsWorkspaceTx.
    needsWorkspaceTx: input.needsWorkspaceTx,
    // Legacy no-op metadata retained for older plugin/source compatibility.
    skipWorkspaceTx: input.skipWorkspaceTx,
    // EI-19386201256023240: see RoleToolDefinition.skipResultDoor.
    skipResultDoor: input.skipResultDoor,
    // WI-37843: see RoleToolDefinition.payloadTierCeilingChars.
    payloadTierCeilingChars: input.payloadTierCeilingChars,
    // WI-37843: see RoleToolDefinition.ignoreSessionPayloadTier.
    ignoreSessionPayloadTier: input.ignoreSessionPayloadTier,
    // P-016 / D-104: see RoleToolDefinition.argReencodings. coord:send — the verb the whole
    // rule was measured for — is `requirePrincipal: false`, so it lands in THIS builder;
    // dropping the field here alone would make the shipped rule a no-op.
    argReencodings: input.argReencodings,
    // EI-19486111655110215: see RoleToolDefinition.argPreconditions. `work_items:complete`
    // — the verb this was measured on — is `requirePrincipal: false`, so it lands in THIS
    // builder; dropping the field here alone would make the shipped check a no-op.
    argPreconditions: input.argPreconditions,
    modality: input.modality,
    // EI-10883: closed shape — an undeclared arg errors instead of being silently dropped.
    args: strictArgs(input.args),
    result: input.result ?? input.output,
    delta: input.delta,
    events: input.events,
    state: input.state,
    handler: input.handler,
    guidance: input.guidance,
    shape: input.shape,
    profile: input.profile,
    harness: input.harness,
    emits: input.emits,
    requires: input.requires,
  };

  registerRoleGatedAsProjected(def, input.expose, definitionSite);
  // Co-located intrinsic emissions → the generic collector; the operator-core
  // desugar registers them as event-reaction rules at load (D-002).
  collectToolEmits(name, input.emits);
  return def;
}

/**
 * Auto-register a legacy `defineTool` entry in the projected-tool
 * registry so it appears alongside plugin-contributed tools and gets
 * HTTP exposure for free.
 *
 * Conventions:
 *   - MCP name unchanged (e.g. `tasks:list`).
 *   - HTTP path: `/api/agent-tools/<group>/<verb>` (group/verb derived
 *     from the colon in the legacy name).
 *   - Single capability from legacy `tool.capability` becomes a
 *     one-element capabilities[] array.
 *   - JSON Schema derived from Zod schema via zodToJsonSchema.
 *   - Handler wrapped so the legacy (args, ToolContext) signature
 *     adapts to the unified (args, UnifiedToolContext) shape:
 *       · ctx.principal + ctx.tx must be populated (built-in tools
 *         don't work without them; the route attaches them via bearer
 *         auth + withWorkspace).
 *       · ToolResponse.data → ToolResult.content[text(JSON)].
 *       · ToolResponse.uiResources → trailing content items.
 */
/**
 * Flatten a JSON schema for OpenAI's function-calling validator.
 *
 * OpenAI Codex (strict mode) requires:
 *   1. `type: "object"` at root.
 *   2. NO `oneOf`/`anyOf`/`allOf`/`enum`/`not` at root.
 *
 * Zod's `discriminatedUnion` (and `z.union`) produces a top-level
 * `{oneOf: [...]}` or `{anyOf: [...]}` — both rejected.
 *
 * Fix: when we see root-level oneOf/anyOf with all-object variants,
 * merge each variant's `properties` into a single object schema.
 * The discriminator field (`mode`, `op`, etc.) stays required; every
 * variant-specific field becomes optional. Handler-level validation
 * (via def.args.safeParse) re-enforces the per-variant required fields
 * at runtime, so loosening the schema for OpenAI doesn't compromise
 * input safety.
 *
 * Schemas that already have `type: "object"` and no problematic
 * top-level keys pass through unchanged.
 */
/**
 * Zod serializes `z.never()` as `{ not: {} }`. A union branch often uses that
 * schema to forbid a field (for example, `resume` on the fresh-launch branch).
 * Treat only an empty `not` schema as impossible; a constrained `not` remains a
 * meaningful validation rule and must not be discarded while flattening.
 */
function isNeverJsonSchema(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const schema = value as Record<string, unknown>;
  const negated = schema.not;
  return (
    negated !== null &&
    typeof negated === 'object' &&
    !Array.isArray(negated) &&
    Object.keys(negated as Record<string, unknown>).length === 0
  );
}

export function flattenForOpenAi(schema: Record<string, unknown>): Record<string, unknown> {
  // Already shaped right.
  const PROHIBITED_AT_ROOT = ['oneOf', 'anyOf', 'allOf', 'not'];
  const hasProhibited = PROHIBITED_AT_ROOT.some((k) => k in schema);
  if (schema.type === 'object' && !hasProhibited) return schema;

  // Pull the discriminator unions out of root.
  const variants: Array<Record<string, unknown>> = [];
  for (const key of ['oneOf', 'anyOf']) {
    if (Array.isArray(schema[key])) {
      for (const v of schema[key] as Array<Record<string, unknown>>) {
        if (v && typeof v === 'object') variants.push(v);
      }
    }
  }

  if (variants.length === 0) {
    // No unions — just ensure type:"object" + strip problematic keys.
    const out = { ...schema };
    for (const k of PROHIBITED_AT_ROOT) delete out[k];
    if (out.type !== 'object') out.type = 'object';
    return out;
  }

  // Merge variant properties. Each property keeps its first definition;
  // a property required by EVERY variant stays required (typically the
  // discriminator); others become optional.
  //
  // EI-21914494224354098: first-declaration-wins is wrong for the DISCRIMINATOR
  // field itself. Zod renders each `z.literal(x)` branch of a discriminated
  // union as `{ const: x }`, so `op: z.literal('get') | z.literal('converge') |
  // z.literal('retire')` produces three variants whose `op` property is
  // `{const:'get'}`, `{const:'converge'}`, `{const:'retire'}` respectively.
  // First-wins collapsed that to `{const:'get'}` alone — the flattened schema
  // (and hence the tool description every caller reads) advertised `op` as
  // ALWAYS "get", hiding "converge"/"retire" entirely. Track every `const`
  // value seen per key; when a key is `const`-shaped in every appearance and
  // spans more than one distinct value, replace it with an `enum` of the full
  // set instead of the first branch alone. A key that is ever non-const in any
  // appearance is left to ordinary first-wins (unioning heterogeneous shapes
  // is not safe in general — this only targets the literal-discriminator case).
  const mergedProps: Record<string, unknown> = {};
  const requiredSets: Set<string>[] = [];
  const constTracking = new Map<string, { allConst: boolean; values: Set<unknown> }>();
  for (const v of variants) {
    const props = (v.properties as Record<string, unknown>) ?? {};
    for (const [pk, pv] of Object.entries(props)) {
      // A field can be present in every union variant but intentionally be
      // `z.never()` in one of them. Keeping that first impossible definition
      // makes the flattened OpenAI contract reject the valid variant too.
      // Preserve first-declaration-wins for real schemas, while replacing a
      // never placeholder with the first satisfiable definition we encounter.
      if (!(pk in mergedProps) || (isNeverJsonSchema(mergedProps[pk]) && !isNeverJsonSchema(pv))) {
        mergedProps[pk] = pv;
      }
      const isConst =
        pv !== null && typeof pv === 'object' && !Array.isArray(pv) && 'const' in (pv as Record<string, unknown>);
      const entry = constTracking.get(pk) ?? { allConst: true, values: new Set<unknown>() };
      if (isConst) entry.values.add((pv as Record<string, unknown>).const);
      else entry.allConst = false;
      constTracking.set(pk, entry);
    }
    const req = Array.isArray(v.required) ? new Set(v.required as string[]) : new Set<string>();
    requiredSets.push(req);
  }
  for (const [pk, { allConst, values }] of constTracking) {
    if (allConst && values.size > 1) {
      const sample = [...values][0];
      mergedProps[pk] = { type: typeof sample === 'string' ? 'string' : typeof sample, enum: [...values] };
    }
  }
  const required = [...requiredSets[0]].filter((p) =>
    requiredSets.every((s) => s.has(p)),
  );
  // A recursive nested schema (for example rules' dataConditionSchema) is
  // emitted as a `$ref` into the root `$defs` map. The union flattening above
  // replaces the root `anyOf`/`oneOf` with a new object, so dropping `$defs`
  // here leaves every such property dangling (`#/$defs/__schema0`) and makes
  // the published tool schema unusable to clients that validate references.
  // Keep the definitions alongside the flattened object; they are still valid
  // JSON Schema and preserve the recursive contract for the client.
  const definitions = schema.$defs;
  const hasDefinitions =
    definitions !== null && typeof definitions === 'object' && !Array.isArray(definitions);

  return {
    type: 'object',
    properties: mergedProps,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
    description: typeof schema.description === 'string' ? schema.description : undefined,
    ...(hasDefinitions ? { $defs: definitions } : {}),
  };
}

/**
 * EI-10883 / EI-18723223344390510 — an unknown arg must be a HARD ERROR, never
 * a silent drop, AT ANY DEPTH.
 *
 * Zod object schemas STRIP unknown keys by default. So a caller who passes an
 * arg the tool does not declare (`sessions:read { order:'asc' }`) gets back
 * `ok:true` and the tool's DEFAULT behaviour — a result that is byte-identical
 * to success while doing something other than what was asked. That is the worst
 * possible failure mode: it cannot be detected by the caller, it cannot be
 * detected by the tool-efficiency telemetry (which only counts hard failures),
 * and it silently teaches the model a wrong mental model of the tool.
 *
 * Observed cost (agent-DX audit 2026-07-13, session 5c5a2f50): `order:'asc'` was
 * accepted and ignored by sessions:read; the agent concluded the tool had no head
 * read, burned two more calls, and drew a wrong conclusion about the data.
 *
 * EI-18723223344390510 — the ORIGINAL fix above only ever called `.strict()` on
 * the OUTERMOST object schema. `.strict()` does NOT cascade: a row schema
 * nested inside an array/optional/record/union field (e.g. `loop:checkpoint`'s
 * `checks: z.array(z.object({ claim, recheck, verified }))`) stayed in Zod's
 * default STRIP mode, so `{ claim, status:'verified', evidence:'Y' }` silently
 * dropped `status`/`evidence` and returned `ok:true` — the exact EI-10883 failure
 * mode, one level down, still live. Confirmed live: a verified external-state
 * check with real evidence degraded to an unverified `PREDICTED` row on the next
 * wake, with the evidence destroyed and no signal it had guessed the field names
 * wrong (`verified` reads like a boolean; `status`+`evidence` is the natural,
 * wrong guess).
 *
 * Fix: walk the WHOLE schema tree — object/array/optional/nullable/default/
 * readonly/catch/prefault/record/union/pipe (the pipe case covers
 * `z.preprocess`, which is exactly how `checks` is wired) — and `.strict()`
 * every object schema found, not just the root. The walk mutates each wrapper's
 * inner-schema slot (`def.element`/`def.innerType`/`def.shape[k]`/`def.options`/
 * `def.out`) IN PLACE before the schema is ever parsed; Zod 4 reads `_zod.def`
 * fresh at parse time rather than baking a closure over the original reference
 * at construction time, so the mutation takes effect for every subsequent call
 * (verified directly, including for `z.discriminatedUnion`'s per-variant
 * dispatch). Any `def.type` this walker doesn't recognize (tuple, intersection,
 * lazy, …) is left completely untouched — fail-open, exactly like the original
 * "no `.strict()` ⇒ pass through" behavior for unions.
 *
 * Runs HERE, once, at registration — closing the class for the whole catalog
 * rather than tool-by-tool or field-by-field. It also runs BEFORE
 * `toJsonSchema`, so the published input schema now advertises
 * `additionalProperties: false` at every level and the model can SEE the shape
 * is closed instead of discovering it by accident.
 */
function deepStrictifyInPlace(schema: unknown, active: Set<object>): unknown {
  if (!schema || typeof schema !== 'object') return schema;
  // Stack-based (enter/exit) cycle guard, NOT a permanent "ever visited" set:
  // a sub-schema legitimately gets reused BY REFERENCE across multiple sibling
  // fields (e.g. the same row schema wrapped by both .optional() and
  // .nullable()) — that must be processed on each path it's reached from, so
  // only a schema currently on the ACTIVE recursion stack (a true cycle, e.g. a
  // self-referential z.lazy()) short-circuits; a shared reference already
  // popped off the stack by the time a sibling field reaches it recurses fine.
  if (active.has(schema as object)) return schema;
  active.add(schema as object);
  try {
    const s = schema as {
      strict?: () => unknown;
      meta?: () => Record<string, unknown> | undefined;
      _zod?: { def?: Record<string, unknown> };
    };
    const def = s._zod?.def;
    if (!def || typeof def.type !== 'string') return schema;

    switch (def.type) {
      case 'object': {
        const shape = def.shape as Record<string, unknown> | undefined;
        if (shape) {
          for (const key of Object.keys(shape)) {
            shape[key] = deepStrictifyInPlace(shape[key], active);
          }
        }
        if (typeof s.strict !== 'function') return schema;
        const strict = s.strict() as { meta?: (metadata: Record<string, unknown>) => unknown };
        // Zod's strict() replaces the object and drops registry metadata.
        // Preserve descriptions and validator-owned call constraints on BOTH
        // root and nested objects before publishing their JSON Schema. This
        // does not change the catchall/refinements that enforce strictness.
        const metadata = typeof s.meta === 'function' ? s.meta() : undefined;
        return metadata && typeof strict.meta === 'function' ? strict.meta(metadata) : strict;
      }
      case 'array':
        def.element = deepStrictifyInPlace(def.element, active);
        return schema;
      case 'optional':
      case 'nullable':
      case 'default':
      case 'readonly':
      case 'catch':
      case 'prefault':
        def.innerType = deepStrictifyInPlace(def.innerType, active);
        return schema;
      case 'record':
        def.valueType = deepStrictifyInPlace(def.valueType, active);
        return schema;
      case 'union':
        // Covers z.union AND z.discriminatedUnion (same def.type in Zod 4) — each
        // variant gets strictified too, closing the same class one level further
        // than the pre-existing top-level-union pass-through did.
        def.options = (def.options as unknown[]).map((o) => deepStrictifyInPlace(o, active));
        return schema;
      case 'pipe':
        // z.preprocess(fn, target) compiles to a pipe { in: <transform>, out: <target> };
        // `out` is what actually gets validated post-transform.
        def.out = deepStrictifyInPlace(def.out, active);
        return schema;
      default:
        return schema;
    }
  } finally {
    active.delete(schema as object);
  }
}

export function strictArgs<T>(schema: T): T {
  try {
    return deepStrictifyInPlace(schema, new Set()) as unknown as T;
  } catch {
    return schema;
  }
}

/**
 * EI-10883 — make the closed-shape rejection TEACH, not merely fail.
 *
 * Zod renders an undeclared key as `Unrecognized key(s) in object: "order"`, which
 * says what was wrong but not what to do instead. Naming the accepted keys turns
 * ONE failed call into a corrected call — the same principle as `argsSchemaHint`
 * (P-004), and the reason the strictness change is a net WIN for agents rather
 * than a new tax: the old behaviour cost a silent wrong answer, the new behaviour
 * costs one loud, self-correcting error.
 */
const COMMON_ARG_ALIASES: Readonly<Record<string, readonly string[]>> = {
  assignee: ['assign_to', 'assignTo', 'owner', 'ownerId'],
  assignto: ['assign_to', 'assignee', 'owner', 'ownerId'],
  body: ['content', 'summary', 'comment', 'text'],
  code: ['script'],
  comment: ['body', 'summary', 'text'],
  content: ['body', 'description', 'summary', 'text'],
  completionref: ['completionRef', 'completion_ref', 'completion'],
  description: ['content', 'summary', 'body', 'text'],
  foundduring: ['foundDuring', 'found_during'],
  // `pot` trails the existing entries on purpose: on a tool whose `scope` genuinely
  // takes a slug, `scope` still wins exactly as before. It is reachable only once the
  // value-admissibility filter refutes the earlier candidates — which is the measured
  // `coord:presence` case, where `pot: '<harness slug>'` is the working call
  // (verified 2026-08-31: returns `scope: hive, hive: papercusp`). EI-21390759884688723.
  harness: ['scope', 'harnessSlug', 'harness_slug', 'pot'],
  itemid: ['item'],
  // `itemIds` is the plural spelling used by neighboring plan tools. Prefer a
  // declared plural destination when this tool has one (for example
  // plans:get-specs -> planItemIds); fall back to the singular alias only on
  // tools whose contract has no plural selector. Exact declared keys still win.
  itemids: ['planItemIds', 'itemId'],
  linkedfeatureid: ['linkedFeatureId', 'linked_feature_id'],
  owner: ['ownerEmail', 'ownerId', 'assignee', 'assign_to'],
  ownerid: ['ownerEmail', 'owner', 'assignee', 'assign_to'],
  // ── EI-21667775013157341: `plan` is the natural short name for a plan-scoped filter,
  // but the declared key spells out WHICH plan relation it is — `sourcePlanSlug` on
  // work_items:list, `current_plan_slug` on coord:declare-intent. The distance rung
  // cannot rescue that: compact('plan') vs compact('sourcePlanSlug') is 10 against a
  // threshold of 3 (the cap), so the caller is told the tool "declares no counterpart".
  // That sentence is FALSE, and here it is worse than a withheld hint — the natural
  // recovery from "no such filter" is to DROP the argument, which does not fail, it
  // silently widens the read to EVERY plan. The reporter had to find `sourcePlanSlug`
  // by reading the accepted-keys list.
  //
  // Deliberately an alias entry and NOT a containment rule: the suffix rung below
  // refuses `<unknown> contained in <declared>` for the same reason it refuses a prefix
  // test, and the reverse direction is worse still (`id` would match any key merely
  // spelling "id"). The exact-declared-match precedence above keeps a tool that really
  // declares `plan` winning over this line, and `admissible` still lets a value-refuting
  // enum veto it.
  plan: ['sourcePlanSlug', 'current_plan_slug', 'planSlug', 'plan_slug'],
  planitem: ['plan_item', 'itemId', 'item'],
  rubricid: ['rubricRef'],
  rubricids: ['rubricRefs'],
  scope: ['harness'],
  script: ['code'],
  summary: ['body', 'comment', 'text', 'content'],
  // ── Additions from a MEASURED rejection burst (WI-38059 / EI-20204653748131789):
  // eight arg-shape rejections in ~35 min of one agent's ordinary work, every one
  // correct-intent/wrong-spelling. These four were each verified to fall OUTSIDE
  // `suggestArgName`'s edit-distance threshold, so no suggestion was produced and
  // the caller had to re-read a schema. e.g. compact('ttldays') vs compact('ttlsec')
  // = distance 3, threshold 2. They are the obvious natural-language names for the
  // concept, which is exactly why agents reach for them.
  category: ['kind', 'type', 'lane'],
  kind: ['category', 'type'],
  text: ['content', 'body', 'summary', 'comment'],
  ttl: ['ttlSec', 'ttl_sec', 'ttlMs', 'ttl_ms'],
  ttldays: ['ttlSec', 'ttl_sec', 'ttlMs'],
  ttlseconds: ['ttlSec', 'ttl_sec'],
  type: ['kind', 'category'],
  value: ['body', 'content', 'summary'],
  // ── EI-20246935995110683: `q` vs `query` is a CROSS-TOOL near-synonym, not a typo —
  // both spellings are live in this catalogue (`issues:list` declares `q`,
  // `search:fulltext`/`search:semantic` declare `query`), so a caller that learned one
  // reaches for it on the other and gets no suggestion at all: compact('q') -> compact('query')
  // is edit distance 4 against a threshold of 1 (max(1, min(3, floor(5/3)))), so it falls
  // outside `suggestArgName`'s distance rescue the same way the WI-38059 additions above did.
  // Both directions are listed because the confusion runs both ways; the exact-declared-match
  // precedence in `suggestArgName` means a tool that genuinely declares `q` (or `query`) still
  // wins over its own alias entry, so neither line can override a tool's real vocabulary.
  q: ['query', 'search', 'text'],
  query: ['q', 'search', 'text'],
  search: ['query', 'q'],
};

function compactArgName(value: string): string {
  return value.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

/**
 * Type descriptors that a caller appends to a declared key's own name while still
 * naming the SAME subject (`plan` -> `planSlug`, `harness` -> `harnessName`). Consumed
 * by `suggestArgName`'s suffix rung, which documents why this must stay a closed set
 * rather than a general prefix or containment test. Compare compacted, so `plan_slug`
 * and `planSlug` are one case.
 */
const ARG_TYPE_SUFFIXES: ReadonlySet<string> = new Set(['slug', 'ref', 'id', 'name', 'key', 'path']);

function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length];
}

/**
 * Does `candidate`'s declared schema PROVE it cannot hold `value`?
 *
 * WHY (EI-21390759884688723): every suggestion source above matches on NAMES alone,
 * so the alias map will confidently relocate a value into a key whose schema cannot
 * accept it. Measured: `coord:presence { harness: 'papercusp' }` was answered with
 * "Did you mean `scope` for `harness`?", but that tool's `scope` is an enum of
 * hive|workspace|all — so obeying the hint produced a SECOND invalid_args
 * (`scope: Invalid option: expected one of "hive"|"workspace"|"all"`).
 *
 * A suggestion that provably cannot work is worse than no suggestion at all. It costs
 * a guaranteed extra round-trip, and — the expensive part — it teaches a false
 * vocabulary ("`scope` is where `harness` goes") that the caller then carries to other
 * tools and into its own durable notes. The whole point of EI-10883's loud rejection is
 * that ONE failed call teaches the corrected call; a misdirection inverts that.
 *
 * The fix cannot be to drop the alias: `harness -> scope` is CORRECT on tools that
 * declare a free-string `scope` which really does take a harness slug (pinned by
 * strict-args.test.ts for `improvements:capture`). The same name pair is right on one
 * tool and wrong on another, and the only discriminator is whether the TARGET can hold
 * the VALUE — which is what this decides.
 *
 * Deliberately narrow: only `enum`/`const` count as proof. Those enumerate the entire
 * admissible set, so "cannot accept" is decidable with no judgment. A projected
 * JSON-Schema `type` is not enough: Zod coercive and strict primitives project to the
 * same type even though coercive schemas may accept representations (including objects)
 * that strict schemas reject. Treating that lossy metadata as proof would suppress a
 * useful correction on the very calls this helper is meant to teach. Absent proof we
 * stay silent about admissibility and let the name-based suggestion stand.
 */
function candidateRefutesValue(
  props: Record<string, unknown> | undefined,
  candidate: string,
  value: unknown,
): boolean {
  if (!props || value === undefined) return false;
  const schema = props[candidate];
  if (!schema || typeof schema !== 'object') return false;
  const constrained = schema as { enum?: unknown; const?: unknown };
  // Only primitives are compared. A structured value tested against an enum of
  // primitives is not decidable by identity, so it yields no proof either way.
  if (value !== null && typeof value === 'object') return false;
  if (Array.isArray(constrained.enum)) return !constrained.enum.includes(value);
  if ('const' in constrained) return constrained.const !== value;
  return false;
}

/**
 * Return the closest declared field for an unknown arg, when confidence is high.
 *
 * `opts` is optional so every name-only caller (and the exported-direct test surface)
 * keeps its current behaviour; pass `value`/`props` to enable the value-admissibility
 * filter documented on `candidateRefutesValue`.
 */
export function suggestArgName(
  unknown: string,
  accepted: readonly string[],
  opts?: { value?: unknown; props?: Record<string, unknown> },
): string | null {
  const compactUnknown = compactArgName(unknown);
  const admissible = (candidate: string): boolean =>
    !candidateRefutesValue(opts?.props, candidate, opts?.value);
  // An EXACT declared match outranks every alias. Latent via `unknownArgHint`
  // (which filters declared keys before asking), but `suggestArgName` is exported
  // and used directly, and without this a tool that genuinely declares `text` or
  // `value` would be told to use `content`/`body` instead — the alias map
  // confidently overriding the tool's own vocabulary. Widening the alias map in
  // WI-38059 is what made that reachable enough to matter.
  //
  // Deliberately NOT value-filtered: if the tool declares this very name, the name is
  // unambiguously right and any value problem is a separate, correctly-taught error.
  const exact = accepted.find((candidate) => compactArgName(candidate) === compactUnknown);
  if (exact) return exact;
  const semanticAliases = COMMON_ARG_ALIASES[compactUnknown] ?? [];
  // Value-incompatible aliases are SKIPPED rather than ending the search, so the list
  // keeps its authored preference order and simply falls through to the next viable
  // entry (`harness` -> `scope` refuted by an enum -> ... -> `pot`).
  const semantic = semanticAliases.find((alias) =>
    accepted.some(
      (candidate) => compactArgName(candidate) === compactArgName(alias) && admissible(candidate),
    ),
  );
  if (semantic) {
    return accepted.find((candidate) => compactArgName(candidate) === compactArgName(semantic)) ?? semantic;
  }

  /**
   * EI-21670512679890540 / EI-21679236680294291 — a declared key wearing a TYPE SUFFIX.
   *
   * The edit-distance rung below scores by characters, so it penalises exactly the
   * shape this vocabulary uses most: `<declaredKey><Suffix>`. For `planSlug` against a
   * tool declaring `plan`, the distance is 4 (the whole suffix) while the threshold —
   * `max(len)/3`, capped at 3 — is 2, so the match is rejected and the caller is told
   * the tool "declares no counterpart". That sentence is FALSE here, and it is the
   * costly half: it does not merely withhold a suggestion, it asserts no synonym exists
   * and steers the caller to DROP the argument. `corrected-call.ts` then emitted
   * `plan_items:status({ harness })` — a call that cannot validate, because `plan` is
   * required and is listed as accepted in the very same message. Two agents filed this
   * within 2h19m of each other (2026-08-28 04:43Z, 07:02Z) and both had to find `plan`
   * by reading the accepted-keys list themselves.
   *
   * The suffixes are a CLOSED set of type descriptors — the argument still names the
   * same subject, it just says what representation of it is being passed — so
   * "`<key>` + one of these means `<key>`" is decidable without judgment, which is the
   * same bar `candidateRefutesValue` sets for its own narrowness. A general
   * containment or prefix rule is deliberately NOT used: it would map `plan` -> `p`
   * and `body` -> `bo` wherever such keys exist.
   *
   * Ambiguity FAILS CLOSED: two declared keys both explaining the unknown name yields
   * nothing, and the distance rung decides instead, because a confidently wrong
   * relocation is the failure this whole function exists to avoid. With the current set
   * that guard is unreachable rather than load-bearing — no member is a suffix of
   * another, so at most one prefix can leave an admissible remainder — but it is what
   * keeps the single-match check SUFFICIENT if the set ever grows a member that ends
   * like an existing one. Value-admissibility still applies, so a suffix match cannot
   * override an enum/const that provably refuses the caller's value.
   */
  const suffixMatches = accepted.filter((candidate) => {
    const compactCandidate = compactArgName(candidate);
    if (compactCandidate.length < 2 || compactCandidate === compactUnknown) return false;
    if (!compactUnknown.startsWith(compactCandidate)) return false;
    return ARG_TYPE_SUFFIXES.has(compactUnknown.slice(compactCandidate.length)) && admissible(candidate);
  });
  if (suffixMatches.length === 1) return suffixMatches[0];

  const ranked = accepted
    .filter(admissible)
    .map((candidate) => ({ candidate, distance: editDistance(compactUnknown, compactArgName(candidate)) }))
    .sort((a, b) => a.distance - b.distance || a.candidate.localeCompare(b.candidate));
  const best = ranked[0];
  if (!best) return null;
  const threshold = Math.max(1, Math.min(3, Math.floor(Math.max(compactUnknown.length, compactArgName(best.candidate).length) / 3)));
  return best.distance <= threshold ? best.candidate : null;
}

/**
 * Map each key declared on a NESTED object schema to its dotted path
 * (`observation.refs`), one level deep.
 *
 * WHY (WI-38059): `unknownArgHint` built its candidate list from TOP-LEVEL
 * properties only, so a key that genuinely exists — just one level down —
 * had nothing to match against and produced NO suggestion. The rejection
 * then read as "this tool has no `refs` concept" when the truth was "`refs`
 * lives inside `observation`". The caller's natural inference from that is
 * to DROP the arg, silently losing whatever it carried (attribution, in the
 * observed case), rather than to relocate it. That is strictly worse than a
 * round-trip: it fails quietly.
 *
 * One level only, and first-declaration-wins on a collision: this exists to
 * name an obvious relocation, not to search a schema tree. A deeper or
 * ambiguous match is left to the full schema hint that follows it.
 */
export function nestedArgPaths(props: Record<string, unknown> | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!props) return out;
  for (const [parent, rawChild] of Object.entries(props)) {
    const childProps = (rawChild as { properties?: Record<string, unknown> } | undefined)?.properties;
    if (!childProps) continue;
    for (const child of Object.keys(childProps)) {
      if (!out.has(child)) out.set(child, `${parent}.${child}`);
    }
  }
  return out;
}

/**
 * Normalize the schema representation used by the invalid-argument hint helpers.
 *
 * The dispatch path passes the eagerly projected JSON-Schema form, but
 * `unknownArgHint` is exported for direct verification and callers naturally pass
 * the source Standard Schema (`tool.args`). Treating that source validator as if it
 * were already JSON Schema makes every hint look absent (`properties` is undefined),
 * which is a false negative rather than a harmless no-op. Conversion is best-effort
 * because this helper runs while reporting an invalid call: an unrepresentable
 * schema must not replace the original validation error with a diagnostic throw.
 */
function jsonSchemaForArgHints(rawSchema: unknown): Record<string, unknown> | undefined {
  if (!rawSchema || typeof rawSchema !== 'object' || Array.isArray(rawSchema)) return undefined;
  const candidate = rawSchema as Record<string, unknown>;
  // The production path already supplies JSON Schema. Avoid converting it again,
  // including union roots whose top-level `properties` is intentionally absent.
  if (
    Object.prototype.hasOwnProperty.call(candidate, 'properties') ||
    Array.isArray(candidate.anyOf) ||
    Array.isArray(candidate.oneOf)
  ) {
    return candidate;
  }
  try {
    const converted = toJsonSchema(rawSchema);
    return converted && typeof converted === 'object' && !Array.isArray(converted) ? converted : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Merge `properties` across every branch of a UNION-rooted JSON Schema
 * (`anyOf`/`oneOf`), falling back to the schema's own top-level `properties`
 * when it isn't a union.
 *
 * `capability:launch-agent`'s two near-identical source/fresh branches — and
 * every other tool whose args are a top-level `z.union([...])` — render with
 * NO top-level `properties`, only `anyOf: [...]`. Reading `rawSchema.properties`
 * directly (the old behaviour) therefore always came back empty for a
 * union-rooted tool, no matter how good the correction below would otherwise
 * be: `keys.length === 0` short-circuited every caller before it could name
 * the accepted arg set, let alone consult `argRedirects` or a nested-path
 * relocation. See the EI-22084251948568820 cluster (EI-22078751749824171,
 * EI-21575773427457407, EI-21723773357897744): four independent reports of
 * `capability:launch-agent` rejecting a key with "the full anyOf schema...
 * no field-level pointer" — the schema WAS being dumped (the `argsSchemaHint`
 * fallback), but every correction path was silently skipped because this
 * lookup found no keys to work from.
 */
function mergedSchemaProperties(rawSchema: unknown): Record<string, unknown> | undefined {
  const schema = jsonSchemaForArgHints(rawSchema) as
    | { properties?: Record<string, unknown>; anyOf?: unknown; oneOf?: unknown }
    | undefined;
  if (schema?.properties) return schema.properties;
  const branches = (
    Array.isArray(schema?.anyOf) ? schema!.anyOf : Array.isArray(schema?.oneOf) ? schema!.oneOf : null
  ) as Array<{ properties?: Record<string, unknown> }> | null;
  if (!branches) return undefined;
  let merged: Record<string, unknown> | undefined;
  for (const branch of branches) {
    if (!branch?.properties) continue;
    merged = { ...(merged ?? {}), ...branch.properties };
  }
  return merged;
}

/**
 * Leaf-resolved issue text for the "is this an unrecognized-key rejection"
 * check below. An `invalid_union` issue's OWN top-level `.message` is Zod's
 * generic "Invalid input" (see `issueLeaves`'s doc on `bestUnionBranch`) — the
 * real diagnosis (e.g. "Unrecognized key(s) in object: 'carry'") lives several
 * levels down, in the closest-matching branch's own sub-issues. Reading
 * `issue.message` directly (the old behaviour) therefore saw only the generic
 * text for ANY union-rooted tool, never matched `/nrecognized key/i`, and
 * skipped the whole correction mechanism — including an authored
 * `argRedirects` entry — for exactly the tools most likely to need it (a
 * union of several launch/source shapes is precisely where a caller mixes up
 * which branch's knobs apply). Descend to the SAME leaves `formatIssues`
 * already renders from, so the two never disagree.
 */
function leafIssueSummary(
  issues: ReadonlyArray<{ message?: string; keys?: readonly string[] }> | undefined,
): {
  msgs: string;
  keys: string[];
  leaves: Array<{ issue: StandardSchemaV1.Issue; segs: PropertyKey[] }>;
} {
  const leaves = issueLeaves((issues ?? []) as StandardSchemaV1.Issue[]);
  const msgs = leaves.map(({ issue }) => issue.message ?? '').join(' ');
  const keys = leaves.flatMap(({ issue }) => (issue as { keys?: readonly string[] }).keys ?? []);
  return { msgs, keys, leaves };
}

/**
 * Resolve the object whose properties were being validated at an issue path.
 *
 * A flat root-property lookup is insufficient for strict unknown-key issues: the same
 * key can be valid on the tool's root while invalid inside `items[]` or a structured
 * object. Reuse the schema path walker used by field-scoped value hints so this
 * diagnostic describes the validator's actual context instead of guessing from the
 * key name alone. An ambiguous union is merged conservatively; a key accepted by any
 * reachable branch is not called unknown.
 */
function schemaPropertiesAtPath(
  rawSchema: unknown,
  path: ReadonlyArray<PropertyKey>,
): Record<string, unknown> | undefined {
  if (path.length === 0) return mergedSchemaProperties(rawSchema);
  const schema = jsonSchemaForArgHints(rawSchema);
  if (!schema) return undefined;

  let nodes: unknown[] = [schema];
  for (const segment of path) {
    nodes = stepSchema(nodes, segment);
    if (nodes.length === 0) return undefined;
  }

  let merged: Record<string, unknown> | undefined;
  for (const node of nodes) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) continue;
    const properties = (node as Record<string, unknown>).properties;
    if (!properties || typeof properties !== 'object' || Array.isArray(properties)) continue;
    merged = { ...(merged ?? {}), ...(properties as Record<string, unknown>) };
  }
  return merged;
}

function issueKeyNames(issue: StandardSchemaV1.Issue): string[] {
  const keys = (issue as { keys?: readonly PropertyKey[] }).keys;
  if (Array.isArray(keys)) return keys.map(String);
  return Array.from(issue.message.matchAll(/["'`]([^"'`]+)["'`]/g), (match) => match[1]);
}

function schemaPathLabel(path: ReadonlyArray<PropertyKey>, key: string): string {
  let label = '';
  for (const segment of [...path, key]) {
    const text = String(segment);
    if (/^\d+$/.test(text)) {
      label += '[]';
    } else {
      label = label.length > 0 ? `${label}.${text}` : text;
    }
  }
  return label;
}

/**
 * Find nested rejections whose key is accepted at the root as well. These are the
 * misleading cases where the ordinary `accepts ONLY` list is technically true but
 * omits the parent path that determines whether the caller's shape is valid.
 */
function nestedTopLevelArgContexts(
  issues: ReadonlyArray<{ message?: string; keys?: readonly string[] }> | undefined,
  rawSchema: unknown,
): Array<{ key: string; path: string }> {
  const root = mergedSchemaProperties(rawSchema);
  if (!root) return [];
  const contexts = new Map<string, string>();
  for (const { issue, segs } of issueLeaves((issues ?? []) as StandardSchemaV1.Issue[])) {
    if (segs.length === 0) continue;
    if (!/nrecognized key/i.test(issue.message)) continue;
    const nested = schemaPropertiesAtPath(rawSchema, segs);
    if (!nested) continue;
    for (const key of issueKeyNames(issue)) {
      if (Object.prototype.hasOwnProperty.call(nested, key)) continue;
      if (!Object.prototype.hasOwnProperty.call(root, key)) continue;
      contexts.set(key, schemaPathLabel(segs, key));
    }
  }
  return Array.from(contexts, ([key, path]) => ({ key, path }));
}

/**
 * For a DISCRIMINATED UNION, the properties of the single branch the caller's own args
 * select — or undefined when the schema is not a union, or when the branch is ambiguous.
 *
 * WHY THIS EXISTS (measured on `omp:sessions`, the worst verb in D-104's table: 66
 * rejections in 7d, 100% of its calls, ten agents). `mergedSchemaProperties` unions the
 * branches' keys, which is right for "what could this tool ever accept" — the
 * `accepts ONLY:` list — and wrong for "was THIS key accepted on THIS call". `omp:sessions`
 * declares `cwd` on op=list/search/link but not on op=get/state, so the merged view reports
 * `cwd` as accepted, the unrecognized-key set comes back empty, and the caller gets the
 * schema wall D-105 was written about while the mechanism meant to help stays silent.
 *
 * D-105 recorded this as "a verb that does not declare `cwd`". Reading the schema shows
 * that is not quite it: `cwd` IS declared, five times, on other branches. The correction
 * an agent needs is therefore "not on this `op`", which is only derivable per-branch.
 *
 * Deliberately narrow, and it FAILS CLOSED. A branch is selected only when a `const`/`enum`
 * discriminator matches the caller's value and exactly one branch survives; anything else
 * falls back to the merged behaviour, which is the pre-existing conservative answer. A
 * wrongly-selected branch would report a legitimate key as unrecognized and advise dropping
 * the caller's data — strictly worse than the silence it replaces.
 */
function selectedUnionBranchProperties(
  rawSchema: unknown,
  input: unknown,
): Record<string, unknown> | undefined {
  const schema = jsonSchemaForArgHints(rawSchema) as
    | { properties?: Record<string, unknown>; anyOf?: unknown; oneOf?: unknown }
    | undefined;
  if (schema?.properties) return undefined;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const branches = (
    Array.isArray(schema?.anyOf) ? schema!.anyOf : Array.isArray(schema?.oneOf) ? schema!.oneOf : null
  ) as Array<{ properties?: Record<string, unknown> }> | null;
  if (!branches) return undefined;
  const args = input as Record<string, unknown>;

  const matches = branches.filter((branch) => {
    const props = branch?.properties;
    if (!props) return false;
    let sawDiscriminator = false;
    for (const [key, rawProp] of Object.entries(props)) {
      const prop = rawProp as { const?: unknown; enum?: readonly unknown[] } | undefined;
      const admissible =
        prop && 'const' in prop
          ? [prop.const]
          : prop && Array.isArray(prop.enum)
            ? prop.enum
            : null;
      if (!admissible) continue;
      sawDiscriminator = true;
      if (!(key in args) || !admissible.includes(args[key])) return false;
    }
    return sawDiscriminator;
  });

  return matches.length === 1 ? matches[0].properties : undefined;
}

/**
 * The keys the caller sent that this tool does not declare — the full set, INCLUDING ones
 * for which no correction target exists.
 *
 * Extracted from `invalidInputCorrections` (rather than re-derived beside it) so the
 * corrected-call builder and the did-you-mean hints can never disagree about which keys
 * were rejected. A second copy of this derivation would be a code-describing value
 * maintained by hand, and it would drift the first time the unrecognized-key message
 * wording changes on either side.
 *
 * The keys WITHOUT a correction are the important half for P-015: they are the
 * "not accepted; drop it" cases D-105 identified, which the did-you-mean path is silent
 * about precisely because there is nothing to suggest.
 */
export function unrecognizedArgKeys(
  issues: ReadonlyArray<{ message?: string; keys?: readonly string[] }> | undefined,
  rawSchema: unknown,
  /** The caller's args — enables per-branch resolution on a discriminated union. */
  input?: unknown,
): string[] {
  const { msgs, keys: leafKeys, leaves } = leafIssueSummary(issues);
  if (!/nrecognized key/i.test(msgs)) return [];
  const merged = mergedSchemaProperties(rawSchema);
  // An empty object schema is still a readable schema. `z.object({})` declares no
  // keys, but it rejects every caller-supplied key and may carry an authored
  // corrective-call redirect for those keys (for example `fleet:list`'s ambient
  // workspace/harness guidance). Dropping this case makes those redirects
  // unreachable and leaves the caller with only a bare "accepts ONLY:" refusal.
  if (!merged) return [];
  // Per-branch when the caller's own discriminator picks exactly one, merged otherwise.
  const branch = input === undefined ? undefined : selectedUnionBranchProperties(rawSchema, input);
  const rootKeys = Object.keys(branch ?? merged);
  const reportedKeys = [
    ...new Set([
      ...leafKeys,
      ...Array.from(msgs.matchAll(/["']([^"']+)["']/g), (match) => match[1]),
    ]),
  ];
  const unknown = new Set<string>();

  // Compare each rejection against the object at its own path. A root-level key is
  // not a valid reason to suppress a nested rejection: `{ items:[{ harness }] }` and
  // `{ harness, items:[...] }` are different call shapes even when both mention the
  // same field name.
  for (const { issue, segs } of leaves) {
    if (!/nrecognized key/i.test(issue.message)) continue;
    const nested = segs.length > 0 ? schemaPropertiesAtPath(rawSchema, segs) : undefined;
    for (const key of issueKeyNames(issue)) {
      if (nested) {
        if (!Object.prototype.hasOwnProperty.call(nested, key)) unknown.add(key);
      } else if (!rootKeys.includes(key)) {
        unknown.add(key);
      }
    }
  }

  // Preserve the old message/keys fallback for validators that provide an unusual
  // issue shape which `issueLeaves` cannot associate with a path.
  for (const key of reportedKeys) {
    if (!leaves.some(({ issue }) => issueKeyNames(issue).includes(key))) {
      if (!rootKeys.includes(key)) unknown.add(key);
    }
  }
  return reportedKeys.filter((key) => unknown.has(key));
}

/**
 * Of `keys`, those this tool DOES declare somewhere — just not on the branch the caller
 * selected. Lets the refusal say "not on this `op`" instead of the flatly false "this tool
 * declares no counterpart", which would send an agent hunting for a synonym that exists.
 */
export function argsAcceptedOnOtherVariant(
  rawSchema: unknown,
  keys: readonly string[],
): string[] {
  const merged = mergedSchemaProperties(rawSchema);
  if (!merged) return [];
  return keys.filter((key) => key in merged);
}

export function invalidInputCorrections(
  issues: ReadonlyArray<{ message?: string; keys?: readonly string[] }> | undefined,
  rawSchema: unknown,
  argRedirects?: Record<string, ProjectedToolArgRedirect>,
  /** The caller's raw args, so a near-name guess can be checked against the value it
   *  would relocate (EI-21390759884688723). Optional: absent, behaviour is name-only. */
  input?: unknown,
): InvalidInputCorrection[] {
  // The candidate pool for a RELOCATION must be the keys this call can actually accept —
  // the selected union branch when the caller's discriminator picks one, merged otherwise.
  //
  // Using the merged pool here produced a SELF-RELOCATION on the real `omp:sessions`:
  // `cwd` is declared on op=list/search/link, so for an op='get' call it sat in the merged
  // pool, suggestArgName matched it exactly, and the correction came back
  // `cwd -> cwd` (kind: 'near-name'). buildCorrectedCall then setPath'd the value and
  // deleted the same key, so the value was silently DROPPED while the hint advised a move
  // that is not a move. A key rejected on this branch can never be its own destination.
  const merged = mergedSchemaProperties(rawSchema);
  const props = (input === undefined ? undefined : selectedUnionBranchProperties(rawSchema, input)) ?? merged;
  const keys = props ? Object.keys(props) : [];
  const unknownKeys = unrecognizedArgKeys(issues, rawSchema, input);
  if (unknownKeys.length === 0) return [];
  const nested = nestedArgPaths(props);
  // EI-20281509195248260: an AUTHORED cross-tool redirect outranks both guesses
  // below. A key whose real home is a different TOOL matches neither the nested
  // relocation nor an edit-distance near-name, so without this the caller reads
  // only "this tool accepts ONLY: …" and concludes the capability is missing —
  // the measured failure mode (`tags` on work_items:update, filed 10+ times).
  // Redirected keys are withheld from `corrections` so the same key cannot also
  // draw a string-distance guess that contradicts the authored answer.
  return unknownKeys.flatMap((rejectedArg): InvalidInputCorrection[] => {
    const redirect = argRedirects?.[rejectedArg];
    if (typeof redirect === 'string' && redirect.length > 0) {
      return [{ rejectedArg, target: redirect, kind: 'authored-redirect' }];
    }
    if (redirect && typeof redirect === 'object') {
      if (isProjectedToolDrop(redirect)) {
        return [{
          rejectedArg,
          target: '',
          kind: 'authored-drop',
          note: typeof redirect.note === 'string' ? redirect.note : '',
        }];
      }
      const registryRevision = projectedToolRegistryRevision();
      const rendered = renderProjectedToolCall(redirect.tool, redirect.args);
      return [{
        rejectedArg,
        target: `${rendered}${redirect.note ? ` — ${redirect.note}` : ''}`,
        kind: 'authored-redirect',
        ...(redirect.note ? { note: redirect.note } : {}),
        call: {
          tool: redirect.tool,
          args: redirect.args,
          source: PROJECTED_TOOL_REGISTRY_SOURCE,
          registryRevision,
        },
      }];
    }
    const nestedTarget = nested.get(rejectedArg);
    if (nestedTarget) return [{ rejectedArg, target: nestedTarget, kind: 'nested-path' }];
    const rejectedValue =
      input && typeof input === 'object'
        ? (input as Record<string, unknown>)[rejectedArg]
        : undefined;
    const nearName = suggestArgName(rejectedArg, keys, { value: rejectedValue, props });
    // Defence in depth for the whole class, independent of how the pool was computed: a
    // key relocated onto ITSELF is not a correction. buildCorrectedCall would setPath the
    // value and then delete the same key, losing it while reporting `relocated`.
    if (nearName === rejectedArg) return [];
    return nearName ? [{ rejectedArg, target: nearName, kind: 'near-name' }] : [];
  });
}

/**
 * Does an authored redirect target name a path inside THIS tool's own schema (a
 * RELOCATION, e.g. `observation.linkTo` or `body`) rather than another tool (a
 * CROSS-TOOL redirect, e.g. `work_items:tag { id, topic }`)? Derived from the tool's
 * own declared keys, so the two cases never need a hand-maintained flag alongside the
 * redirect. A rendered tool call always carries a space, `{` or `:`, so it can never
 * be mistaken for a dotted local path.
 *
 * Exported for direct unit test — see strict-args.test.ts.
 */
export function isLocalSchemaTarget(target: string, keys: readonly string[]): boolean {
  return splitLocalSchemaTarget(target, keys) !== null;
}

/** The separator between a redirect's destination PATH and its explanatory note. */
const REDIRECT_NOTE_SEPARATOR = ' — ';

/**
 * Split an authored redirect target into its local destination PATH and an optional
 * explanatory NOTE, or return null when the target does not name a path on this tool.
 *
 * WHY (P-002 / WI-2145856): `isLocalSchemaTarget` used to test the WHOLE target string
 * against the path regex, so any target carrying explanation classified as CROSS-TOOL
 * and rendered "`x` is not an arg of this tool — it is written by <the whole sentence>".
 * That forced every author into a false choice: a bare key (correct phrasing, no
 * teaching) or a sentence (the teaching, wrongly attributed to some other tool). A
 * same-tool relocation WITH an explanation — the common case — was unrepresentable.
 *
 * This is not hypothetical or new: `coord:send`'s own shipped redirects are authored as
 * `body[].premises — put it inside a section: …` and were being rendered with the
 * cross-tool sentence, which is precisely the misattribution EI-21119949290826530 fixed
 * for bare targets and EI-22179796827760943 re-reported. Measured against the live
 * function before this change: of five representative targets only the bare `detail`
 * classified local.
 *
 * The split is on the FIRST occurrence of the note separator, so a note may itself
 * contain dashes. A target with no separator keeps the previous whole-string behaviour
 * exactly, which is what makes every already-authored bare target byte-identical.
 */
export function splitLocalSchemaTarget(
  target: string,
  keys: readonly string[],
): { path: string; note: string } | null {
  const separatorAt = target.indexOf(REDIRECT_NOTE_SEPARATOR);
  const path = separatorAt === -1 ? target : target.slice(0, separatorAt);
  const note = separatorAt === -1 ? '' : target.slice(separatorAt + REDIRECT_NOTE_SEPARATOR.length).trim();
  // `[]` joins `[0]` here: an array-valued destination is normally addressed by shape
  // (`body[].premises`), not by index, and that is the form authors actually write.
  if (!/^[A-Za-z_$][\w$]*(?:\.[\w$]+|\[\d*\])*$/.test(path)) return null;
  const root = path.split(/[.[]/)[0];
  if (root === undefined || root.length === 0 || !keys.includes(root)) return null;
  return { path, note };
}

/** The tool name at the head of a `seeAlso` entry (`'work_items:claim (claim a SPECIFIC id)'`). */
function seeAlsoToolName(entry: unknown): string | null {
  if (entry && typeof entry === 'object') {
    const tool = (entry as { tool?: unknown }).tool;
    return typeof tool === 'string' && tool.length > 0 ? tool : null;
  }
  if (typeof entry !== 'string') return null;
  const head = /^\s*([A-Za-z][\w.-]*[:.][\w.-]+)/.exec(entry);
  return head?.[1] ?? null;
}

/**
 * EI-21681203906419973 — the rejected key is an exact declared arg of a SIBLING tool
 * that this tool's own `seeAlso` already names.
 *
 * The measured failure: `scheduler:get_next` was called with `count`, which is a real,
 * documented argument — of `work_items:claim_next`, the sibling self-select verb that
 * get_next's `seeAlso` literally lists. The caller reached for the neighbour's arg on
 * this tool and the rejection could only answer "this tool accepts ONLY: …", so the
 * filing concluded the live build had drifted from its documentation. It had not: no
 * revision of get_next has ever declared `count`. Naming the tool that DOES own the key
 * turns a suspected server/doc drift into a one-line redirect.
 *
 * Wholly DERIVED (rung 1) — both halves already exist: this tool's authored `seeAlso`
 * scopes the search to genuine neighbours, and the sibling's own declared schema answers
 * whether it owns the key. Nothing new is hand-maintained, so it cannot drift out of step
 * with either tool. Deliberately EXACT-match and seeAlso-scoped: a catalog-wide hunt for
 * any tool declaring `count` would name a dozen unrelated verbs and be worse than silence.
 *
 * Exported for direct unit test — see strict-args.test.ts.
 */
export function siblingToolArgOwner(
  toolName: string | undefined,
  rejectedKey: string,
  /** By-name registry lookup — `resolveMcpName` in production, a stub in tests. The
   *  projected row carries no `name` of its own (the registry is keyed by it), so a
   *  resolver is the only way to get from a see-also entry to a schema. */
  resolve: (name: string) => { inputSchema?: unknown; guidance?: { seeAlso?: unknown } } | undefined | null,
): string | null {
  if (!toolName) return null;
  const self = resolve(toolName);
  const seeAlso = self?.guidance?.seeAlso;
  // Function-form seeAlso projects as the literal 'runtime-resolved' (it is computed from
  // a RESULT, which a rejected call never produced) — nothing to scope against.
  if (!Array.isArray(seeAlso)) return null;
  for (const entry of seeAlso) {
    const siblingName = seeAlsoToolName(entry);
    if (!siblingName || siblingName === toolName) continue;
    const sibling = resolve(siblingName);
    if (!sibling) continue;
    const props = mergedSchemaProperties(sibling.inputSchema);
    if (props && rejectedKey in props) return siblingName;
  }
  return null;
}

// Exported for direct unit test alongside its sibling correction sources
// (`nestedArgPaths`, `suggestArgName`) — see strict-args.test.ts.
export function unknownArgHint(
  issues: ReadonlyArray<{ message?: string; keys?: readonly string[] }> | undefined,
  rawSchema: unknown,
  argRedirects?: Record<string, ProjectedToolArgRedirect>,
  /** See `invalidInputCorrections` — enables the value-admissibility filter. */
  input?: unknown,
  /** This tool's own name, so a rejected key can be traced to a `seeAlso` sibling that
   *  declares it (EI-21681203906419973). Omitted: the sibling leg simply stays silent. */
  toolName?: string,
): string {
  const { msgs } = leafIssueSummary(issues);
  if (!/nrecognized key/i.test(msgs)) return '';
  const props = mergedSchemaProperties(rawSchema);
  const keys = props ? Object.keys(props) : [];
  if (keys.length === 0) return '';
  const corrections = invalidInputCorrections(issues, rawSchema, argRedirects, input);
  const redirected = corrections.filter(
    (correction) => correction.kind === 'authored-redirect' || correction.kind === 'authored-drop',
  );
  // EI-21119949290826530: an authored redirect carries TWO different meanings and only
  // the cross-tool one was ever rendered. A target naming a path INSIDE this tool's own
  // schema (`observation.linkTo`, `body`) is a RELOCATION — the caller sent the right
  // value to the wrong PLACE on the right tool. A target naming another tool is the
  // cross-tool case (EI-20281509195248260). Rendering both as "it is written by X" told
  // a caller who merely nested a field wrongly that some OTHER tool owns their data —
  // the opposite of the correction they need, and a dead end for a value they are
  // holding right now. The distinction is DERIVED from the tool's own declared keys, so
  // a newly authored redirect classifies itself with no second field to maintain.
  const redirectText = redirected
    .map(({ rejectedArg, target, kind, note, call }) => {
      if (kind === 'authored-drop') {
        return ` \`${rejectedArg}\` is not an arg of this tool — drop the key${
          note ? `: ${note}` : '.'
        }`;
      }
      // P-002: a local target may carry an explanatory note after ` — `. Rendering
      // the note OUTSIDE the backticks is the whole point: inside them it reads as
      // part of the key name the caller should type.
      const local = splitLocalSchemaTarget(target, keys);
      if (local) {
        return ` \`${rejectedArg}\` is not a top-level arg of this tool — pass it as \`${local.path}\` instead${
          local.note ? `: ${local.note}` : '.'
        }`;
      }
      // A structured corrective call may intentionally target THIS SAME tool (for
      // example, a removed broad filter that now requires a targeted lookup). It is
      // still a call-shape correction, not ownership by another tool. Rendering it
      // as "written by <this tool>" contradicts the corrected call above and can
      // send the caller back through the same rejected argument.
      if (toolName && call?.tool === toolName) {
        return ` \`${rejectedArg}\` is not an arg of this tool — use this tool with ${JSON.stringify(call.args)} instead${
          note ? `: ${note}` : '.'
        }`;
      }
      return ` \`${rejectedArg}\` is not an arg of this tool — it is written by ${target}.`;
    })
    .join('');
  const localCorrections = corrections.filter(
    (correction) => correction.kind !== 'authored-redirect' && correction.kind !== 'authored-drop',
  );
  const correctionText = localCorrections.length > 0
    ? ` Did you mean ${localCorrections.map(({ rejectedArg, target }) => `\`${target}\` for \`${rejectedArg}\``).join('; ')}?`
    : '';
  const unknownKeys = unrecognizedArgKeys(issues, rawSchema, input);
  const nestedContexts = nestedTopLevelArgContexts(issues, rawSchema)
    .filter(({ key }) => unknownKeys.includes(key));
  const nestedContextText = nestedContexts
    .map(({ key, path }) =>
      ` \`${key}\` is not accepted at \`${path}\`; this tool accepts \`${key}\` only at the top level, so move it out of that nested object.`,
    )
    .join('');
  // EI-21826333890701824: `tools:invoke`'s envelope (`{ name, args }`) wrapped around a
  // DIRECT verb call is a recognisable, recurring caller error with a specific remedy,
  // but the generic list-the-keys message cannot express it: it truthfully reports two
  // unknown keys and leaves the caller to infer that their whole call SHAPE — not their
  // field names — was wrong. Fires only when this tool declares NEITHER key itself, so
  // the meta-dispatcher that genuinely takes `name`/`args` never sees it.
  // EI-22174225494240206: dispatch-level args (`payloadTier`, and any host-registered
  // ones — e.g. Papercusp's `projection`) are stripped by the transport BEFORE this
  // validator ever runs, so they can never appear in `keys` above. Where the transport
  // DID peel them they are genuinely accepted, and naming them is what stops this
  // message instructing a caller to re-send WITHOUT a capability that actually works.
  //
  // EI-22283734191872163: but "accepted" is PER-DISPATCH, never process-wide. The host
  // resolver reports which keys ITS TRANSPORT strips; a dispatch running BENEATH that
  // transport — tooldef's own `runToolOrchestration`, which is what a `code:run` script
  // calls — peels nothing, so the very same list is false there. The message then named
  // `projection` as "also accepted" in the same breath as it rejected `projection`,
  // which is how the false universal in this comment's earlier wording ("accepted on
  // every call") reached callers: it was true where it was written and false where it
  // was also emitted.
  //
  // The per-dispatch answer needs no new mechanism, no host signal and no dispatch
  // context, because THIS CALL already carries the evidence: a key that arrived as an
  // UNRECOGNIZED key was, by construction, not peeled before validation. So subtract
  // them. That is a MEASUREMENT of this dispatch (derived-truth rung 1) rather than a
  // claim about the process, and it fails safe for any future non-peeling path — such a
  // path inherits the truth automatically instead of inheriting the universal.
  const ambientKeys = [PAYLOAD_TIER_ARG, ...readAmbientArgKeys()]
    .filter((key) => !unknownKeys.includes(key));
  const ambientText = ambientKeys.length > 0
    ? ` (Dispatch-level args, handled by the transport before this tool's own schema and therefore not in the list above but also accepted: ${ambientKeys.join(', ')}.)`
    : '';
  const reSendHint = ambientKeys.length > 0
    ? ' Re-send using only the keys above (or the dispatch-level ones just listed).'
    : ' Re-send using only the keys above.';
  const envelopeText =
    unknownKeys.includes('name')
    && unknownKeys.includes('args')
    && !keys.includes('name')
    && !keys.includes('args')
      ? ' `name` + `args` are the `tools:invoke` ENVELOPE, not args of this tool —'
        + ' it looks like a direct call was wrapped for dispatch. Either call this tool'
        + ' directly with its own declared args at top level, or dispatch it through'
        + ' `tools:invoke { name, args }`.'
      : '';
  // EI-21675134570053141: `_meta` is the JSON-RPC/MCP REQUEST envelope (it sits on
  // `params`, sibling to the tool's `arguments`), never a tool arg — so a caller who
  // puts it inside args gets an ordinary unrecognized-key rejection that cannot say
  // which LAYER the key belongs to. The measured filing: a timed-out
  // `scheduler:get_next` returned an idempotency key, the caller tried to replay it as
  // `_meta.idempotencyKey` through `tools:invoke`, was rejected, and concluded the
  // replay was impossible. It was already automatic — the proxy injects
  // `params._meta.idempotencyKey` once per request and reuses it across every retry so
  // the server dedups the replay (mcp-proxy/proxy.ts), and a valid client-supplied key
  // on the ENVELOPE is respected rather than overwritten. Fires only when the tool does
  // not itself declare `_meta`.
  const metaEnvelopeText =
    unknownKeys.includes('_meta') && !keys.includes('_meta')
      ? ' `_meta` is the MCP request ENVELOPE (it rides on the JSON-RPC `params`, beside'
        + " the tool's `arguments`), not an arg of any tool — passing it inside args"
        + ' rejects it here. You do not need to set `_meta.idempotencyKey` yourself: the'
        + ' proxy injects one per request and reuses it across retries so a replay dedups'
        + ' instead of double-applying.'
      : '';
  // EI-21681203906419973: the key may be a real, documented arg — of a SIBLING tool this
  // tool's own `seeAlso` names. Rendered after the envelope legs because those diagnose a
  // wrong call LAYER, which outranks a wrong call TARGET.
  const siblingText = unknownKeys
    .flatMap((rejectedArg) => {
      const owner = siblingToolArgOwner(toolName, rejectedArg, resolveMcpName);
      return owner
        ? [` \`${rejectedArg}\` is not an arg of this tool, but \`${owner}\` (listed in this`
          + " tool's see-also) does declare it — check you did not reach for the neighbour's"
          + ' argument here.']
        : [];
    })
    .join('');
  return (
    ` — this tool accepts ONLY: ${keys.join(', ')}.${ambientText}${envelopeText}${metaEnvelopeText}${siblingText}${redirectText}${nestedContextText}${correctionText}` +
    ' An undeclared arg is REJECTED, not silently ignored (EI-10883): passing an arg a tool does not declare used to return ok:true' +
    ` while quietly doing something else, which is indistinguishable from success.${reSendHint}` +
    // EI-19953470656367880: an unrecognized-key rejection is ALSO the exact shape a
    // caller sees when it (or the UI sending on its behalf) is newer than the server
    // it's talking to — a long-lived process (e.g. a Tauri desktop's own spawned
    // operator) has no file-watch and serves whatever code it booted with. When the
    // host has registered a vintage resolver, say so, so that reads as "restart the
    // app" instead of "I typo'd an arg".
    serverVintageHint()
  );
}

function makeInvalidInputError(
  toolName: string,
  issues: ReadonlyArray<StandardSchemaV1.Issue>,
  input: unknown,
  rawSchema: unknown,
  argRedirects: Record<string, ProjectedToolArgRedirect> | undefined,
  argPreconditions?: (rawInput: unknown) => readonly string[],
): InvalidInputError {
  const corrections = invalidInputCorrections(issues, rawSchema, argRedirects, input);
  // P-015: the finished call, resolved against what the caller actually sent. Ordered
  // FIRST because D-105 measured that the alternative does not work: `omp:sessions`
  // already returns its entire args schema and ten agents still re-hit the same wall 66
  // times. Help the reader has to scroll past is help they did not get.
  const unknownKeys = unrecognizedArgKeys(issues, rawSchema, input);
  const corrected = buildCorrectedCall({
    toolName,
    input,
    corrections,
    unknownKeys,
    targetSchema: rawSchema,
    issues,
    acceptedOnOtherVariant: argsAcceptedOnOtherVariant(rawSchema, unknownKeys),
  });
  const metadata: InvalidInputMetadata = {
    source: PROJECTED_TOOL_REGISTRY_SOURCE,
    registryRevision: projectedToolRegistryRevision(),
    toolName,
    corrections,
    ...(corrected ? { correctedCall: corrected } : {}),
  };
  return new InvalidInputError(
    `invalid_args: ${formatIssues(issues, input)}${correctedCallHint(corrected)}${unknownArgHint(issues, rawSchema, argRedirects, input, toolName)}` +
      // EI-21353729155349111: the value-level branch appends no SCHEMA (EI-10943 — a
      // caller who knows the shape and sent a bad value learns nothing from a 1,800-char
      // dump), but "the constraint that just refused you may not exist in the tree any
      // more" is the one thing it cannot work out for itself. One conditional sentence,
      // and only when the host registered a vintage resolver.
      (issuesAreValueLevel(issues)
        ? constraintVintageHint()
        : failingFieldSchemaHint(issues, rawSchema) ||
          // WI-6661: never fall back to the whole schema. The former 1,800-char
          // dump routinely ended mid-property, so it was both expensive and an
          // unreliable contract. An unrecognized-key error already gets the
          // complete accepted-key list from `unknownArgHint`; an otherwise
          // pathless issue gets the same compact list here.
          (unknownKeys.length === 0 ? argsFieldNamesHint(rawSchema) : '')) +
      crossPhaseRequirementHint(argPreconditions, input),
    metadata,
  );
}

/**
 * EI-19486111655110215 — append the CROSS-PHASE requirements this call would ALSO fail,
 * so a caller fixing the schema error is not refused a second time for a reason this
 * refusal already knew. See `RoleToolDefinition.argPreconditions` for why these cannot
 * simply be moved into the schema (they are conditional on post-parse values).
 *
 * Isolated on purpose: this runs on input that FAILED validation, so it is the one place
 * in the refusal path guaranteed to see arbitrary shapes. A diagnostic that threw here
 * would replace a precise schema error with a stack trace — strictly worse than the gap
 * it exists to close — so a throwing or non-array precondition is dropped silently.
 */
function crossPhaseRequirementHint(
  argPreconditions: ((rawInput: unknown) => readonly string[]) | undefined,
  input: unknown,
): string {
  if (typeof argPreconditions !== 'function') return '';
  let lines: readonly string[];
  try {
    lines = argPreconditions(input);
  } catch {
    return '';
  }
  if (!Array.isArray(lines)) return '';
  const kept = lines.filter((line): line is string => typeof line === 'string' && line.trim().length > 0);
  if (kept.length === 0) return '';
  return ` — ALSO required for this call (would fail on your next attempt): ${kept.join(' · ')}`;
}

/**
 * P-016 / D-104 — the EXECUTE half. Consulted ONLY after `standardValidate` has already
 * failed: apply the tool's registered RE-ENCODINGS and re-validate the result.
 *
 * Returns null when nothing applied or the repair still does not validate, so the caller
 * falls through to the ordinary `makeInvalidInputError` refusal with its ORIGINAL issues.
 * That fallback matters: a rule that fires but leaves a different field broken must not
 * replace the caller's real diagnosis with a confusing second-order one.
 *
 * Ordering is deliberate — validate first, repair second. A rule can therefore never
 * re-shape a call that was already valid, which keeps this a repair path and not a silent
 * behaviour change on the hot path (and costs a registered tool nothing until it refuses).
 */
async function reencodeAndRevalidate<S extends StandardSchemaV1>(
  schema: S,
  rawSchema: Record<string, unknown>,
  argReencodings: readonly ArgReencoding[] | undefined,
  shimmed: unknown,
): Promise<{
  value: StandardSchemaV1.InferOutput<S>;
  corrections: readonly AppliedArgCorrection[];
} | null> {
  const casingAttempt = applyCasingArgAliases(rawSchema, shimmed);
  const authoredAttempt = applyArgReencodings(argReencodings, casingAttempt?.input ?? shimmed);
  if (!casingAttempt && !authoredAttempt) return null;
  const repairedInput = authoredAttempt?.input ?? casingAttempt!.input;
  const corrections = [
    ...(casingAttempt?.corrections ?? []),
    ...(authoredAttempt?.corrections ?? []),
  ];
  const retry = await standardValidate(schema, repairedInput);
  if (!retry.ok) return null;
  return { value: retry.value, corrections };
}

/**
 * Announce an auto-correction on the result that the corrected call produced.
 *
 * PROMINENT means FIRST (D-105: help the reader has to scroll past is help they did not
 * get), so the line is prepended to `content` rather than appended. The structured
 * `corrected:[{path,sent,ran,rule}]` rides `_meta` unconditionally — that is the half
 * EI-10883 requires, and it must not depend on a caller having negotiated
 * `structuredContent`.
 */
function attachCorrectedDisclosure(
  result: ToolResult,
  corrections: readonly AppliedArgCorrection[],
): ToolResult {
  if (corrections.length === 0) return result;
  const structured = result.structuredContent;
  return {
    ...result,
    content: [{ type: 'text', text: correctedDisclosure(corrections) }, ...(result.content ?? [])],
    ...(structured && typeof structured === 'object' && !Array.isArray(structured)
      ? {
          structuredContent: {
            ...(structured as Record<string, unknown>),
            corrected: corrections,
          },
        }
      : {}),
    _meta: { ...(result._meta ?? {}), corrected: corrections },
  };
}

/**
 * EI-20087434994864624 (+7 more filings of the same friction on 2026-08-10 alone) —
 * make a NESTED validation failure teach the shape it actually needs.
 *
 * The old fallback dumped the tool's WHOLE args schema, bounded at 1,800 chars.
 * That was simultaneously TOO LONG and TOO SHORT: long enough to crowd the result
 * budget, yet truncated thousands of characters before reaching the field that
 * actually failed. The caller then could not learn the shape from the error at all.
 *
 * The observed dead end (coord:send, eight independent agents): a section field rejects a
 * string, then rejects an array of strings, and the appended "full args schema" cuts off
 * mid-way through an unrelated sibling's description. The only route left is to send a
 * deliberate `[{}]` so the validator enumerates the required keys — a probe purely to
 * extract a schema the error was already trying to show. Agents who did not think of the
 * probe dropped the field and inlined the content as prose, which silently destroys the
 * structured signal the field exists to capture.
 *
 * So: when an issue points at a nested path, resolve THAT node in the JSON schema and
 * render it alone. Two details carry the value here:
 *
 *  - We render the deepest ancestor that has `properties`, not the failing leaf. For
 *    `couldNotDetermine.0.what: expected string`, the leaf's schema is `{"type":"string"}`
 *    — true and useless. The PARENT object's schema lists every accepted key, which is
 *    precisely what the `[{}]` probe was reverse-engineering.
 *  - We follow `anyOf`/`oneOf`/`allOf` branches, because the union is why the path was
 *    unreachable in the flat dump to begin with (`body` is a string OR an array of
 *    richly-described sections).
 *
 * A path that cannot be resolved falls back to the complete top-level field-name
 * list, never to a partial whole-schema dump (WI-6661).
 */
const FIELD_SCHEMA_HINT_MAX = 700;
const FIELD_SCHEMA_HINT_MAX_FIELDS = 3;

function schemaUnionBranches(node: unknown): unknown[] {
  if (!node || typeof node !== 'object') return [];
  const rec = node as Record<string, unknown>;
  const out: unknown[] = [];
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    const branch = rec[key];
    if (Array.isArray(branch)) out.push(...branch);
  }
  return out;
}

/**
 * Build a small, valid value for a JSON-Schema node. This is intentionally a
 * teaching example, not a validator: nested validation hints must expose the
 * COMPLETE set of accepted keys before their verbose field descriptions, or a
 * result cap can cut off the only field the caller needs to discover.
 */
function compactSchemaExampleValue(node: unknown, depth = 0): unknown {
  if (!node || typeof node !== 'object' || depth > 4) return '<value>';
  const rec = node as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(rec, 'const')) return rec.const;
  if (Array.isArray(rec.enum) && rec.enum.length > 0) return rec.enum[0];

  for (const branch of schemaUnionBranches(node)) {
    const value = compactSchemaExampleValue(branch, depth + 1);
    if (value !== '<value>') return value;
  }

  switch (rec.type) {
    case 'string':
      return '<string>';
    case 'number':
    case 'integer':
      return 0;
    case 'boolean':
      return false;
    case 'array': {
      // An empty teaching example is not accepted by schemas with minItems.
      // Keep optional/unbounded arrays compact, but include the minimum number
      // of item examples whenever the schema requires a non-empty array.
      const minItems =
        typeof rec.minItems === 'number' && Number.isFinite(rec.minItems)
          ? Math.max(0, Math.ceil(rec.minItems))
          : 0;
      if (minItems === 0) return [];
      const itemExample = compactSchemaExampleValue(rec.items, depth + 1);
      return Array.from({ length: minItems }, () => itemExample);
    }
    case 'object':
      return hasProperties(node) ? compactAcceptedObjectExample(node, depth + 1) : {};
    default:
      return hasProperties(node) ? compactAcceptedObjectExample(node, depth + 1) : '<value>';
  }
}

/**
 * Render a complete accepted object shape without copying its descriptions.
 * The full schema remains useful for limits and prose, but it comes AFTER this
 * example so a bounded error can never hide a later optional field (notably
 * `checks[].verified`).
 */
function compactAcceptedObjectExample(node: unknown, depth = 0): unknown {
  if (!node || typeof node !== 'object' || depth > 4) return '<value>';
  const rec = node as Record<string, unknown>;
  const props = rec.properties;
  if (!props || typeof props !== 'object' || Array.isArray(props)) return '<value>';

  const properties = props as Record<string, unknown>;
  const example: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties)) {
    example[key] = compactSchemaExampleValue(value, depth + 1);
  }
  return example;
}

function compactAcceptedObjectHint(node: unknown): string | null {
  if (!node || typeof node !== 'object') return null;
  const rec = node as Record<string, unknown>;
  const props = rec.properties;
  if (!props || typeof props !== 'object' || Array.isArray(props)) return null;
  const properties = props as Record<string, unknown>;
  const keys = Object.keys(properties);
  if (keys.length === 0) return null;

  const example = compactAcceptedObjectExample(node);
  if (!example || typeof example !== 'object') return null;
  const required = Array.isArray(rec.required) ? rec.required.filter((key): key is string => typeof key === 'string') : [];
  const optional = keys.filter((key) => !required.includes(key));
  const qualifiers = [
    required.length > 0 ? `required: ${required.join(', ')}` : '',
    optional.length > 0 ? `optional: ${optional.join(', ')}` : '',
  ].filter(Boolean);
  return `${JSON.stringify(example)}${qualifiers.length > 0 ? ` (${qualifiers.join('; ')})` : ''}`;
}

function hasProperties(node: unknown): boolean {
  if (!node || typeof node !== 'object') return false;
  const props = (node as Record<string, unknown>).properties;
  return !!props && typeof props === 'object' && Object.keys(props as object).length > 0;
}

/** Step one path segment, descending through any union branches. Returns every candidate. */
function stepSchema(nodes: readonly unknown[], seg: PropertyKey): unknown[] {
  const key = typeof seg === 'object' && seg !== null ? String((seg as { key: PropertyKey }).key) : String(seg);
  const isIndex = /^\d+$/.test(key);
  const next: unknown[] = [];
  const visit = (node: unknown, depth: number): void => {
    if (!node || typeof node !== 'object' || depth > 4) return;
    const rec = node as Record<string, unknown>;
    if (isIndex) {
      const prefixItems = rec.prefixItems;
      if (Array.isArray(prefixItems) && prefixItems[Number(key)]) next.push(prefixItems[Number(key)]);
      else if (rec.items) next.push(rec.items);
    } else {
      const props = rec.properties as Record<string, unknown> | undefined;
      if (props && Object.prototype.hasOwnProperty.call(props, key)) next.push(props[key]);
      else if (rec.additionalProperties && typeof rec.additionalProperties === 'object') {
        next.push(rec.additionalProperties);
      }
    }
    for (const branch of schemaUnionBranches(node)) visit(branch, depth + 1);
  };
  for (const node of nodes) visit(node, 0);
  return next;
}

function failingFieldSchemaHint(
  issues: ReadonlyArray<StandardSchemaV1.Issue> | undefined,
  rawSchema: unknown,
): string {
  const rendered = new Map<string, string>();
  // Read LEAF paths, not `issue.path`. For a union the issue's own path stops at the
  // union node (`body`) while the real diagnosis — and the path the error message
  // prints — is several levels deeper. Reading `issue.path` here silently never fires.
  for (const { segs } of issueLeaves(issues ?? [])) {
    const path = segs as ReadonlyArray<PropertyKey>;
    // A pathless issue cannot identify one field. `unknownArgHint` handles
    // unrecognized keys; the caller below falls back to a compact accepted-key list
    // for other root-level failures.
    if (path.length < 1) continue;

    // Walk the path, remembering the deepest prefix whose node actually lists
    // properties. If there is no object-shaped ancestor (the common top-level
    // primitive case), retain the resolved leaf itself. This is the WI-6661 seam:
    // `claimableLimit` now teaches only its integer/range schema instead of dumping
    // every unrelated coord:orient argument before truncating mid-property.
    let nodes: unknown[] = [];
    const schema = jsonSchemaForArgHints(rawSchema);
    if (schema) nodes = [schema];
    let bestNode: unknown;
    let bestLabel = '';
    let leafNode: unknown;
    let leafLabel = '';
    const labelParts: string[] = [];
    for (const seg of path) {
      nodes = stepSchema(nodes, seg);
      if (nodes.length === 0) break;
      const segKey = typeof seg === 'object' && seg !== null ? String((seg as { key: PropertyKey }).key) : String(seg);
      labelParts.push(/^\d+$/.test(segKey) ? '[]' : segKey);
      leafNode = nodes[0];
      leafLabel = labelParts.join('.').replace(/\.\[\]/g, '[]');
      const objectish = nodes.find((node) => hasProperties(node))
        ?? nodes.flatMap((node) => schemaUnionBranches(node)).find((node) => hasProperties(node));
      if (objectish) {
        bestNode = objectish;
        bestLabel = labelParts.join('.').replace(/\.\[\]/g, '[]');
      }
    }
    const hintNode = bestNode ?? leafNode;
    const hintLabel = bestNode === undefined ? leafLabel : bestLabel;
    if (hintNode === undefined || !hintLabel || rendered.has(hintLabel)) continue;

    let json = '';
    try {
      json = JSON.stringify(hintNode) ?? '';
    } catch {
      json = '';
    }
    if (json.length === 0) continue;
    if (json.length > FIELD_SCHEMA_HINT_MAX) json = `${json.slice(0, FIELD_SCHEMA_HINT_MAX)} …(truncated)`;
    // Keep a complete accepted example ahead of the verbose descriptions. A
    // nested object such as loop:checkpoint's checks[] row has a long
    // `verified` description; serializing the raw schema first can hit the
    // bounded hint before that optional field appears, leaving the caller to
    // guess the contract (EI-20232348713050420).
    const compact = compactAcceptedObjectHint(hintNode);
    rendered.set(hintLabel, compact ? `e.g. ${compact}; verbose schema: ${json}` : json);
    if (rendered.size >= FIELD_SCHEMA_HINT_MAX_FIELDS) break;
  }
  if (rendered.size === 0) return '';
  const body = [...rendered.entries()].map(([label, json]) => `\`${label}\` accepts ${json}`).join(' · ');
  return ` — the field(s) that failed, in full: ${body}`;
}

/** Compact, complete fallback for a pathless shape failure (WI-6661). */
function argsFieldNamesHint(rawSchema: unknown): string {
  const keys = Object.keys(mergedSchemaProperties(rawSchema) ?? {});
  return keys.length > 0 ? ` — accepted args: ${keys.join(', ')}` : '';
}

/**
 * Convert a tool's `args` to JSON Schema — failing LOUD and, crucially, NAMED.
 *
 * A tool's args schema is its CALLABLE CONTRACT, so unlike an unrepresentable *event*
 * schema (which degrades to a placeholder, keeping the tool usable) there is nothing to
 * degrade to: an args schema that cannot be advertised is a fatal authoring error.
 *
 * But it must fail with the TOOL'S NAME. This conversion runs at REGISTRATION — i.e.
 * during module import — and the same unguarded conversion runs again in the MCP
 * tools/list handlers. So one bad schema does not break one tool: it throws mid-import
 * and takes down the WHOLE catalog, surfacing as a bare, anonymous adapter error with no
 * tool, no file, nothing to grep (observed: `Transforms cannot be represented in JSON
 * Schema`, which reads like an unrelated infra/zod break and was mis-triaged as one).
 *
 * The two common causes are a TRAILING `.transform()` (whose output type JSON Schema
 * cannot express) and `z.custom<T>()`. Refinements (`.refine` / `.superRefine`) and
 * `preprocess` are all representable and fine.
 */

/**
 * Pick the remedy that matches the CAUSE the converter actually reported.
 *
 * The adapter error names the offending CONSTRUCT ("Custom types cannot be represented
 * in JSON Schema") but never the way out, and the two common causes have DISJOINT
 * remedies — so one hardcoded hint is affirmatively wrong for whichever cause it does not
 * describe. Observed: a `z.custom<T>()` author was told to "terminate the transform with
 * `.pipe()`", advice that cannot apply because there is no transform. The reader then
 * reaches for the next construct that compiles, and the natural next pick (`z.unknown()`)
 * is representable but infers `unknown` — which will not assign to T — so the cause-blind
 * hint costs a second failed attempt in a different check.
 */
function argsRemedyFor(causeMessage: string): string {
  if (/custom type/i.test(causeMessage)) {
    return (
      `This one is a \`z.custom<T>()\`: it typechecks CLEANLY — no compiler or lint sees it — and is ` +
      `unrepresentable. If the field is accepted but never read (a compat passthrough that only has to ` +
      `survive a \`.strict()\` round-trip), use \`z.any()\`: representable, and still assignable to T. ` +
      `\`z.unknown()\` is representable too, but infers \`unknown\`, which will NOT assign to T. ` +
      `Otherwise restate the shape in real Zod, so the contract is actually advertised to callers.`
    );
  }
  if (/transform/i.test(causeMessage)) {
    return (
      `This one is a trailing \`.transform()\` — do that normalization in the HANDLER instead ` +
      `(read the value, resolve it there), or, if a transform is genuinely required, terminate it with ` +
      `\`.pipe(<schema>)\` so the OUTPUT stays representable.`
    );
  }
  return (
    `The usual causes are a trailing \`.transform()\` — do that normalization in the HANDLER, or ` +
    `terminate it with \`.pipe(<schema>)\` — and \`z.custom<T>()\`, for which \`z.any()\` is the ` +
    `representable stand-in on a passthrough field.`
  );
}

export function toArgsJsonSchema(toolName: string, args: StandardSchemaV1): Record<string, unknown> {
  try {
    return toJsonSchema(args);
  } catch (err) {
    const cause = (err as Error).message;
    throw new Error(
      `Tool "${toolName}": its \`args\` schema cannot be represented in JSON Schema — ` +
        `${cause}. This is FATAL FOR THE WHOLE TOOL CATALOG, not just this tool: ` +
        `the conversion runs at registration and again (unguarded) when tools/list is served, so a ` +
        `single unrepresentable schema breaks tool discovery for every client. ` +
        `${argsRemedyFor(cause)} Refinements are always fine.`,
    );
  }
}

function registerLegacyAsProjected<TArgs extends StandardSchemaV1>(
  def: ToolDefinition<TArgs>,
  expose?: ToolExposure,
  sourceFile?: string | null,
): void {
  // tasks:list → /api/agent-tools/tasks/list
  const httpPath = `/api/agent-tools/${def.name.replaceAll(':', '/')}`;
  // Pluggable schema→JSON-Schema (P-021); default adapter is Zod 4's
  // toJSONSchema. zod-to-json-schema@3 returned just `{ $schema }` for zod 4
  // schemas (empty input schemas) — the built-in path fixed that.
  const rawSchema = toArgsJsonSchema(def.name, def.args);
  delete (rawSchema as Record<string, unknown>).$schema;
  const inputSchema = flattenForOpenAi(rawSchema);
  const { jsonSchema: outputJsonSchema, eligibility } = computeOutputEligibility(def.result);
  const readColumns = projectReadColumns(outputJsonSchema);
  const projectedFn: ToolFn = async (input, ctx) => {
    // The dispatch stack may expose `tx` as a fail-loud getter for tools that
    // did not declare `needsWorkspaceTx`. Never probe that property directly:
    // the descriptor-aware helper returns only a real bound transaction.
    const workspaceTx = boundWorkspaceTx(ctx);
    if (!ctx.principal || (def.needsWorkspaceTx === true && workspaceTx === undefined)) {
      // Almost always this is a workspace-SCOPING gap, not an auth failure:
      // either the principal is missing or a declared transaction consumer
      // has no concrete workspace from which the host can bind a transaction.
      // Say so — "requires authenticated request" sent authenticated callers
      // down the wrong debugging path (EI-30).
      throw new UnauthorizedToolError(
        `built-in tool "${def.name}" requires a workspace-scoped call — this session has no workspace transaction. ` +
          `Scope the session to a workspace, or pass a per-call workspace where the host/tool supports one.`,
      );
    }
    // EI-11621: recover a client `__unparsedToolInput` envelope FIRST, so the
    // per-call tier extraction + closed-shape validation see the intended args.
    // Framework-reserved per-call tier override is stripped next — BEFORE
    // validation (context-trimming-tiers D-004; not part of any tool's schema).
    const { input: tierlessInput, callTier } = extractPayloadTier(unwrapUnparsedToolInput(input));
    // Preserve host context metadata without touching `tx`: transaction-free
    // dispatches may install a fail-loud getter there. Copy descriptors first,
    // then omit the three fields whose legacy contracts differ from the host.
    const passthroughDescriptors: Record<string, PropertyDescriptor> = Object.getOwnPropertyDescriptors(ctx);
    delete passthroughDescriptors.tx;
    delete passthroughDescriptors.principal;
    delete passthroughDescriptors.log;
    const passthroughCtx = Object.defineProperties({}, passthroughDescriptors) as Omit<
      UnifiedToolContext, 'tx' | 'principal' | 'log'
    >;
    const legacyCtx = {
      ...passthroughCtx,
      principal: ctx.principal as unknown as ToolContext['principal'],
      // EI-18808330244321407: transaction-free tools receive no `tx` key at
      // all. A declared consumer reaches this point only with a real bound tx.
      ...(def.needsWorkspaceTx === true
        ? { tx: workspaceTx as ToolContext['tx'] }
        : {}),
      log: (level, msg, meta) => ctx.log(`[${level}] ${msg}${meta ? ` ${JSON.stringify(meta)}` : ''}`),
      // Thread the RESOLVED payload tier so principal-gated tools that keep a
      // hand-rolled JSON ToolResult (byte-stable contracts — memory:search)
      // can adapt their defaults off ctx.contextTier, same as the role-gated
      // wrapper below (context-trimming-tiers P-024).
      ...((callTier ?? ctx.contextTier) ? { contextTier: callTier ?? ctx.contextTier } : {}),
      // Keep the explicit-vs-ambient distinction available to raw ToolResult
      // handlers. `contextTier` alone cannot tell a caller's `full` override
      // from the default session tier.
      ...(callTier !== undefined ? { payloadTierOverride: callTier } : {}),
    } as ToolContext & {
      contextTier?: string;
      payloadTierOverride?: string;
      telemetrySurface?: string;
    };
    const shimmed = applyHarnessArgAlias(
      rawSchema,
      applyPositionalWriteShim(def.name, rawSchema, stripUndefinedArgKeys(tierlessInput)),
    );
    const validated = await standardValidate(def.args, shimmed);
    // P-016 / D-104 — auto-correct-and-execute, RE-ENCODINGS only. Zero cost on both
    // ordinary paths: a call that validates never reaches the repair, and a tool with no
    // registered re-encodings gets an immediate null back.
    let parsedValue: StandardSchemaV1.InferOutput<TArgs>;
    let corrections: readonly AppliedArgCorrection[] = [];
    if (validated.ok) {
      parsedValue = validated.value;
    } else {
      const repaired = await reencodeAndRevalidate(def.args, rawSchema, def.argReencodings, shimmed);
      if (!repaired) {
        throw makeInvalidInputError(
          def.name,
          validated.issues,
          shimmed,
          rawSchema,
          def.guidance?.argRedirects,
          def.argPreconditions,
        );
      }
      parsedValue = repaired.value;
      corrections = repaired.corrections;
    }
    // Keeps every `parsed.value` reader below untouched.
    const parsed = { value: parsedValue };
    // Takes a PROMISE as readily as a value, and that signature is the whole safety story.
    // Every result producer it wraps here is async, so a synchronous `(r: ToolResult)` form
    // silently spreads a Promise to `{}` — the caller is told their corrected call SUCCEEDED
    // while its entire payload is discarded. Two of the six call sites were written that way
    // and passed a green 52-assertion suite; only the typechecker found the other four, since
    // no test happened to exercise those branches. Accepting the promise makes the mistake
    // unrepresentable rather than leaving six sites each needing an `await` remembered.
    const disclose = async (result: ToolResult | Promise<ToolResult>): Promise<ToolResult> =>
      attachCorrectedDisclosure(await result, corrections);
    const response = await def.handler(parsed.value, legacyCtx);
    const explicitFullRequest = isExplicitFullPayloadRequest(callTier, ctx);
    // A raw ToolResult (MCP content shape) normally passes through untouched —
    // parity with the role-gated wrapper below. EXCEPT: on the agent-facing MCP
    // transport, a single-text-item JSON body whose shape TOON shrinks is
    // transparently re-encoded for the token win (P-002). The narrow guards in
    // `reencodableJsonPayload` keep this off every NON-mcp transport, so the
    // memory:* family + the TUI Memory tab (which read content[0].text as the
    // handler's own JSON over a non-mcp transport) are byte-for-byte unchanged
    // — preserving the contract a past blanket re-encode broke
    // (memory-taxonomy-and-debt-followups P-006).
    if (isHybridToolResponse(response)) {
      const marked = markExplicitFullRawResult(response, explicitFullRequest);
      return disclose(serializeHybridToolResponse(marked, ctx, eligibility, def, readColumns, parsed.value));
    }
    if (response && typeof response === 'object' && Array.isArray((response as ToolResult).content)) {
      const marked = markExplicitFullRawResult(response as ToolResult, explicitFullRequest);
      const reencodable = reencodableJsonPayload(marked, ctx);
      if (reencodable !== undefined) {
        return disclose(
          serializeProjectedResult(
            { data: reencodable, ...(explicitFullRequest ? { explicitFullRequest: true } : {}) },
            ctx,
            eligibility,
            def,
            readColumns,
            parsed.value,
          ),
        );
      }
      return disclose(attachRequestedStructuredContent(marked, ctx, def));
    }
    // Payload-tier shaping (context-trimming-tiers D-004): shape the DATA per
    // the session/call tier before format-aware serialization. Unshaped tools
    // pass through byte-identical.
    const shaped = applyPayloadTier({
      toolName: def.name,
      shape: def.shape,
      response: response as ToolResponse,
      // WI-37843: a tool may opt OUT of routine per-session shaping, in which
      // case the session tier is discarded and an un-overridden call resolves
      // to 'full'. An explicit per-call payloadTier still wins either way.
      tier:
        ctx.requestedStructured === true
          ? 'full'
          : resolvePayloadTier(callTier, ctx.contextTier, {
              ignoreSessionTier: def.ignoreSessionPayloadTier,
            }),
      // A caller-selected full tier is the documented escape hatch out of
      // shaping AND the hard ceiling (WI-5078): it can arrive as a per-call
      // payloadTier:'full', an explicit ctx_tier=full choice, or a structured
      // content request (which also requires schema-valid raw data).
      // The latter must be stamped too, because the downstream result-door
      // sees only serialized metadata and otherwise generically re-projects
      // the raw body (EI-22586965566163070). A ctx-borne
      // `transportCapExempt` consumer (code:run's inner dispatch — the result
      // never reaches an agent's context) gets the same exemption
      // (EI-18719561823587590).
      explicitFullRequest,
      // WI-37843: a tool may raise its OWN hard ceiling (coord:orient, the
      // session-bootstrap read, whose full payload IS the value). Absent ⇒ the
      // shared PAYLOAD_TIER_HARD_CEILING_CHARS, unchanged for every other tool.
      ceilingChars: def.payloadTierCeilingChars,
      args: parsed.value,
      log: (m) => ctx.log(m),
      // EI-20720054720826414: the host's executable raw-dispatch spelling for
      // the recovery `next` — absent ⇒ the generic host-neutral wording.
      rawDispatchTemplate: ctx.rawDispatchTemplate,
    });
    return disclose(serializeProjectedResult(shaped, ctx, eligibility, def, readColumns, parsed.value));
  };

  registerProjectedTool({
    pluginName: 'agent-mcp',
    description: def.description,
    // Where this tool was defined (absolute, captured from the call stack).
    // Null when the stack was unreadable — never guessed.
    sourceFile: sourceFile ?? undefined,
    inputSchema,
    // Keep the complete branch requirements for discovery/introspection while
    // retaining the flattened schema above for strict OpenAI/MCP callers.
    discoveryInputSchema: rawSchema,
    capabilities: [def.capability as never],
    effect: def.effect,
    effectForCall: def.effectForCall as ((args: unknown) => 'read' | 'write') | undefined,
    idempotent: def.idempotent,
    abortCompletionReceipt: def.abortCompletionReceipt as ProjectedTool['abortCompletionReceipt'],
    replaces: def.replaces,
    composition: def.composition,
    profile: def.profile,
    harness: def.harness,
    authorize: def.authorize,
    requireRoles: def.requireRoles,
    public: def.public,
    requires: def.requires,
    // P-062 / EI-2378: thread crossWorkspace into the PROJECTED def. The `def`
    // already carries it (definePrincipalGatedTool L341), but this projection —
    // what the host dispatch + the scoped-superuser clamp read via lookupByMcpName —
    // previously dropped it, so a principal-gated crossWorkspace tool (memory:* etc.)
    // ran on a workspace-scoped tx and failed `workspace_required` from an unscoped
    // ('*') psu session. The role-gated projection already threads it; this restores
    // parity. crossWorkspace tools self-derive workspaceId (never rely on the tx's
    // RLS), so the admin-handle path is behavior-preserving for concrete callers.
    crossWorkspace: def.crossWorkspace,
    // EI-18808330244321407: host transaction retention is explicit opt-in.
    needsWorkspaceTx: def.needsWorkspaceTx,
    // Legacy no-op metadata: projected for compatibility, ignored by hosts.
    skipWorkspaceTx: def.skipWorkspaceTx,
    // EI-19386201256023240: thread skipResultDoor the same way — read by the
    // host's result-door choke point. See ProjectedTool.skipResultDoor.
    skipResultDoor: def.skipResultDoor,
    // WI-37843: thread the per-tool payload-tier ceiling the same way — read
    // where applyPayloadTier is invoked. See ProjectedTool.payloadTierCeilingChars.
    payloadTierCeilingChars: def.payloadTierCeilingChars,
    // WI-37843: and the session-tier opt-out — read where resolvePayloadTier
    // is invoked. See ProjectedTool.ignoreSessionPayloadTier.
    ignoreSessionPayloadTier: def.ignoreSessionPayloadTier,
    outputSchema: def.result,
    outputJsonSchema,
    resultEligibility: eligibility,
    delta: def.delta,
    expose: {
      mcp: { name: def.name },
      http: { path: httpPath, methods: ['POST'] },
      // IPC-eligibility (the typed endpoint_invoke / sys:http allowlist) is
      // opt-in per tool via `expose: { ipc: true }` in defineTool — read off
      // the projected registry by the host's IPC server (Phase E8).
      ...(expose?.ipc ? { ipc: true as const } : {}),
      // Slash exposure (MCP-prompts slash commands) defaults ON when absent;
      // thread the declared value so `false`/overrides survive projection.
      ...(expose?.slash !== undefined ? { slash: expose.slash } : {}),
    },
    fn: projectedFn,
    guidance: def.guidance as never,
  });
}

/**
 * Project a role-gated first-party tool into the registry. Unlike the
 * legacy wrapper, the handler is invoked WITHOUT requiring `principal`
 * or `tx` on the context — gating is the dispatcher's role + quota
 * check.
 *
 * The handler may return either a `ToolResult` (MCP shape) or a
 * `ToolResponse` envelope; this wrapper normalises to `ToolResult` so
 * both transports see the same content[] array.
 */
function registerRoleGatedAsProjected<TArgs extends StandardSchemaV1>(
  def: RoleToolDefinition<TArgs>,
  expose?: ToolExposure,
  sourceFile?: string | null,
): void {
  const httpPath = `/api/agent-tools/${def.name.replaceAll(':', '/')}`;
  const rawSchema = toArgsJsonSchema(def.name, def.args);
  delete (rawSchema as Record<string, unknown>).$schema;
  const inputSchema = flattenForOpenAi(rawSchema);
  const { jsonSchema: outputJsonSchema, eligibility } = computeOutputEligibility(def.result);
  const readColumns = projectReadColumns(outputJsonSchema);
  const projectedFn: ToolFn = async (input, ctx) => {
    // EI-11621: recover a client `__unparsedToolInput` envelope FIRST, so the
    // per-call tier extraction + closed-shape validation see the intended args.
    // Framework-reserved per-call tier override is stripped next — BEFORE
    // validation (context-trimming-tiers D-004; not part of any tool's schema).
    const { input: tierlessInput, callTier } = extractPayloadTier(unwrapUnparsedToolInput(input));
    const shimmed = applyHarnessArgAlias(
      rawSchema,
      applyPositionalWriteShim(def.name, rawSchema, stripUndefinedArgKeys(tierlessInput)),
    );
    const validated = await standardValidate(def.args, shimmed);
    // P-016 / D-104 — auto-correct-and-execute, RE-ENCODINGS only. See the twin in
    // `registerLegacyAsProjected`; both wrappers must carry it, since which one a tool
    // lands in is a registration detail invisible to the caller whose shape it repairs.
    let parsedValue: StandardSchemaV1.InferOutput<TArgs>;
    let corrections: readonly AppliedArgCorrection[] = [];
    if (validated.ok) {
      parsedValue = validated.value;
    } else {
      const repaired = await reencodeAndRevalidate(def.args, rawSchema, def.argReencodings, shimmed);
      if (!repaired) {
        throw makeInvalidInputError(
          def.name,
          validated.issues,
          shimmed,
          rawSchema,
          def.guidance?.argRedirects,
          def.argPreconditions,
        );
      }
      parsedValue = repaired.value;
      corrections = repaired.corrections;
    }
    // Keeps every `parsed.value` reader below untouched.
    const parsed = { value: parsedValue };
    // Takes a PROMISE as readily as a value, and that signature is the whole safety story.
    // Every result producer it wraps here is async, so a synchronous `(r: ToolResult)` form
    // silently spreads a Promise to `{}` — the caller is told their corrected call SUCCEEDED
    // while its entire payload is discarded. Two of the six call sites were written that way
    // and passed a green 52-assertion suite; only the typechecker found the other four, since
    // no test happened to exercise those branches. Accepting the promise makes the mistake
    // unrepresentable rather than leaving six sites each needing an `await` remembered.
    const disclose = async (result: ToolResult | Promise<ToolResult>): Promise<ToolResult> =>
      attachCorrectedDisclosure(await result, corrections);
    // Thread the per-call tier override into the HANDLER's ctx too: tools that
    // must keep a hand-rolled JSON ToolResult (hook-consumed — coord:inbox /
    // coord:plan-events / coord:glance) adapt their DEFAULTS off
    // ctx.contextTier instead of declaring `shape`, and without this overlay a
    // per-call `payloadTier:"full"` would be stripped above and silently
    // ignored by that pattern (context-trimming-tiers P-022).
    const handlerCtx =
      callTier !== undefined
        ? { ...ctx, contextTier: callTier, payloadTierOverride: callTier }
        : ctx;
    const out = await def.handler(parsed.value, handlerCtx);
    const explicitFullRequest = isExplicitFullPayloadRequest(callTier, handlerCtx);

    // Already a ToolResult? The handler self-serialized its content — pass it
    // through untouched (format-aware serialization only applies to handlers
    // that return a ToolResponse envelope with structured `data`). EXCEPT: on
    // the MCP transport, a single-text JSON body whose shape TOON shrinks is
    // re-encoded for the token win (P-002); see `reencodableJsonPayload` — it is
    // a no-op on every non-mcp transport, so verbatim-content consumers are safe.
    if (isHybridToolResponse(out)) {
      const marked = markExplicitFullRawResult(out, explicitFullRequest);
      return disclose(serializeHybridToolResponse(marked, handlerCtx, eligibility, def, readColumns, parsed.value));
    }
    if (out && typeof out === 'object' && Array.isArray((out as ToolResult).content)) {
      const marked = markExplicitFullRawResult(out as ToolResult, explicitFullRequest);
      const reencodable = reencodableJsonPayload(marked, handlerCtx);
      if (reencodable !== undefined) {
        return disclose(
          serializeProjectedResult(
            { data: reencodable, ...(explicitFullRequest ? { explicitFullRequest: true } : {}) },
            handlerCtx,
            eligibility,
            def,
            readColumns,
            parsed.value,
          ),
        );
      }
      return disclose(attachRequestedStructuredContent(marked, handlerCtx, def));
    }

    // Payload-tier shaping (context-trimming-tiers D-004): shape the DATA per
    // the session/call tier before format-aware serialization. Unshaped tools
    // pass through byte-identical.
    const shaped = applyPayloadTier({
      toolName: def.name,
      shape: def.shape,
      response: out as ToolResponse,
      // WI-37843: a tool may opt OUT of routine per-session shaping, in which
      // case the session tier is discarded and an un-overridden call resolves
      // to 'full'. An explicit per-call payloadTier still wins either way.
      tier:
        handlerCtx.requestedStructured === true
          ? 'full'
          : resolvePayloadTier(callTier, handlerCtx.contextTier, {
              ignoreSessionTier: def.ignoreSessionPayloadTier,
            }),
      // A caller-selected full tier is the documented escape hatch out of
      // shaping AND the hard ceiling (WI-5078): it can arrive as a per-call
      // payloadTier:'full', an explicit ctx_tier=full choice, or a structured
      // content request (which also requires schema-valid raw data).
      // The latter must be stamped too, because the downstream result-door
      // sees only serialized metadata and otherwise generically re-projects
      // the raw body (EI-22586965566163070). A ctx-borne
      // `transportCapExempt` consumer (code:run's inner dispatch — the result
      // never reaches an agent's context) gets the same exemption
      // (EI-18719561823587590).
      explicitFullRequest,
      // WI-37843: a tool may raise its OWN hard ceiling (coord:orient, the
      // session-bootstrap read, whose full payload IS the value). Absent ⇒ the
      // shared PAYLOAD_TIER_HARD_CEILING_CHARS, unchanged for every other tool.
      ceilingChars: def.payloadTierCeilingChars,
      args: parsed.value,
      log: (m) => handlerCtx.log(m),
      // EI-20720054720826414: the host's executable raw-dispatch spelling for
      // the recovery `next` — absent ⇒ the generic host-neutral wording.
      rawDispatchTemplate: handlerCtx.rawDispatchTemplate,
    });
    // ToolResponse envelope → format-aware MCP content[] + _meta.
    return disclose(serializeProjectedResult(shaped, handlerCtx, eligibility, def, readColumns, parsed.value));
  };

  registerProjectedTool({
    pluginName: 'agent-mcp',
    description: def.description,
    // Where this tool was defined (absolute, captured from the call stack).
    // Null when the stack was unreadable — never guessed.
    sourceFile: sourceFile ?? undefined,
    inputSchema,
    // Keep the complete branch requirements for discovery/introspection while
    // retaining the flattened schema above for strict OpenAI/MCP callers.
    discoveryInputSchema: rawSchema,
    capabilities: [def.capability as never],
    effect: def.effect,
    effectForCall: def.effectForCall as ((args: unknown) => 'read' | 'write') | undefined,
    idempotent: def.idempotent,
    abortCompletionReceipt: def.abortCompletionReceipt as ProjectedTool['abortCompletionReceipt'],
    replaces: def.replaces,
    composition: def.composition,
    profile: def.profile,
    harness: def.harness,
    outputSchema: def.result,
    outputJsonSchema,
    resultEligibility: eligibility,
    delta: def.delta,
    agentRoles: def.agentRoles,
    rolesQuota: def.rolesQuota,
    requirePrincipal: false,
    authorize: def.authorize,
    requireRoles: def.requireRoles,
    public: def.public,
    requires: def.requires,
    timeoutSec: def.timeoutSec,
    idleTimeoutSec: def.idleTimeoutSec,
    replayBufferSize: def.replayBufferSize,
    crossWorkspace: def.crossWorkspace,
    // EI-18808330244321407: see ProjectedTool.needsWorkspaceTx.
    needsWorkspaceTx: def.needsWorkspaceTx,
    // Legacy no-op metadata: projected for compatibility, ignored by hosts.
    skipWorkspaceTx: def.skipWorkspaceTx,
    // EI-19386201256023240: see ProjectedTool.skipResultDoor.
    skipResultDoor: def.skipResultDoor,
    // WI-37843: see ProjectedTool.payloadTierCeilingChars.
    payloadTierCeilingChars: def.payloadTierCeilingChars,
    // WI-37843: see ProjectedTool.ignoreSessionPayloadTier.
    ignoreSessionPayloadTier: def.ignoreSessionPayloadTier,
    modality: def.modality,
    events: def.events,
    state: def.state,
    expose: {
      mcp: { name: def.name },
      http: { path: httpPath, methods: ['POST'] },
      // IPC-eligibility (the typed endpoint_invoke / sys:http allowlist) is
      // opt-in per tool via `expose: { ipc: true }` in defineTool — read off
      // the projected registry by the host's IPC server (Phase E8).
      ...(expose?.ipc ? { ipc: true as const } : {}),
      // Slash exposure (MCP-prompts slash commands) defaults ON when absent;
      // thread the declared value so `false`/overrides survive projection.
      ...(expose?.slash !== undefined ? { slash: expose.slash } : {}),
    },
    fn: projectedFn,
    guidance: def.guidance as never,
  });
}
