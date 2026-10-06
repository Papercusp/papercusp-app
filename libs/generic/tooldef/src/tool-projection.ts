/**
 * Tool projection registry — the function-as-truth abstraction.
 *
 * A "projected tool" is a typed async function plus a manifest entry
 * declaring how that function should be exposed:
 *
 *   - `expose.http`: framework auto-mounts at the declared path.
 *   - `expose.mcp`:  framework auto-registers as an MCP tool.
 *
 * Both projections call the same function. Capability + role + quota
 * gates run identically. Tests target the function with a mock ctx;
 * neither transport needs to be running.
 *
 * This module is the registry + lookup APIs. Transport adapters
 * (the dynamic HTTP catch-all route, the MCP `tools/list` + `tools/call`
 * handlers) consume this registry to do their work.
 *
 * Spec: apps/operator/docs/plugin-mcp-host-design.md.
 */

import { type ZodTypeAny } from 'zod';
import type {
  EmitCallback,
  ProgressCallback,
  RolesQuota,
  ToolResult,
} from './wire';
import type { AgentRole, Capability, PluginSpawn } from './host-types';
import type { BundledDefinitionSite } from './bundle-definition-site';
import type { PayloadShapers } from './payload-tier';
import type {
  KernelBoundary,
  KernelContextState,
  KernelEnforcementResult,
  KernelExecutionRevision,
  KernelOwnershipRequirement,
} from './kernel-enforcement';

/**
 * WHY a tool's result skips the per-result door (`applyResultDoor`). This is a
 * REASON, not a boolean, because the two legitimate cases want OPPOSITE
 * treatment of the one other thing that appends prose to a result body — the
 * store-identity-suspect annotation (`annotateStoreIdentitySuspectResult`).
 *
 * It was a boolean until WI-37843, and the host read `!skipResultDoor` to decide
 * whether prose was safe. That conflation meant the only way to exempt a large
 * MODEL-FACING result from the door was to also silence its "this `not_found`
 * may be a correct answer from the WRONG database" warning — on `coord:orient`,
 * the session-bootstrap read, that is precisely the warning you least want
 * dropped. Keying the prose decision off the reason lets each case get what it
 * needs, and forces every future author to state which case they are in.
 *
 *   - `'programmatic-caller'` — the documented/near-exclusive consumer is a
 *     program that `json.loads`s the raw body (a shell hook, not a model). A
 *     door-truncated body plus a prose footer is invalid JSON, so that parse
 *     throws and the caller fails open SILENTLY. Such a tool must receive NO
 *     appended prose from anything, door or otherwise — machine-readable `_meta`
 *     only (EI-19386201256023240).
 *   - `'oversize-by-design'` — a MODEL-FACING tool whose full payload is
 *     deliberately allowed to exceed the per-result budget because the payload
 *     IS the value (a once-per-session bootstrap read, where truncation costs
 *     more in follow-up round-trips than the bytes cost in context). Prose still
 *     applies: a model reads this body, so warnings must reach it.
 *
 * Do NOT reach for `'oversize-by-design'` to dodge an ordinary large response —
 * the door's spill-to-scratch + pointer remains correct for anything whose size
 * is incidental rather than the point. Absent ⇒ the door applies as normal.
 */
export type ResultDoorSkipReason = 'programmatic-caller' | 'oversize-by-design';
import { pinModuleState } from '@papercusp/module-singleton';
import { fnv1a64BytesHex } from './fnv1a64';
import { DEFAULT_RESOLVE_PARAMS, resolveToolName } from './resolve-name';
import type { MatchParams } from './resolve-name-match';
import { toJsonSchema } from './schema-adapter';
import type { StandardSchemaV1 } from './standard-schema';
import type { Authorizer } from './authz';
import type { EligibilityResult } from '@papercusp/result-encoding';
import type { DeltaCapability } from './delta-protocol';
import type { Principal } from './types';

/* ─── Event schema types ─────────────────────────────────────────────── */

/** Schema for a tool's typed event channel. Keys are wire-level event names. */
export type EventsSchema = Record<string, ZodTypeAny>;

/**
 * Reserved event names — names the framework emits internally OR has
 * semantics around. Tools declaring an `events` schema must not use
 * these as keys. The TS-level guard `UserEvents<T>` enforces this at
 * compile time on `defineTool`'s generic parameter.
 *
 * - `done`: framework auto-emits when the handler returns successfully.
 * - `progress`: emitted via `ctx.progress` (the alias); reserved so
 *   tools don't redefine its payload shape.
 * - `heartbeat`: @papercusp/sse emits this every 15s to keep the
 *   connection alive; never a tool event.
 * - `result`: legacy pre-2026-05-12 terminal-event name; reserved for
 *   collision avoidance even though the framework no longer emits it.
 *
 * `error` is intentionally NOT reserved — the framework auto-emits it
 * on handler throw, but tools may also emit it mid-stream for non-fatal
 * errors (dual-mode; canonical example is runAgentChat's mid-stream
 * 'error' yields). See ToolContext.emit doc for the contract.
 */
export type ReservedEventNames = 'done' | 'heartbeat' | 'result' | 'chunk' | 'card';

/** Compile-time guard: a user-declared events schema cannot contain reserved names. */
export type UserEvents<T extends EventsSchema> = T & { [K in ReservedEventNames]?: never };

/**
 * Runtime list of reserved event names. The compile-time `UserEvents<T>`
 * guard rejects them in TS, but the projection registry also checks at
 * register time so plugins (which can bypass the TS layer via JSON
 * manifests) get a loud failure. Phase 4 T2.3.
 */
export const RESERVED_EVENT_NAMES: readonly ReservedEventNames[] = [
  // Truly framework-only events. Tools MUST NOT redeclare them.
  'done',       // dispatcher emits at successful completion with ToolResult.content
  'heartbeat',  // transport pings to keep idle connections alive
  'result',     // MCP-shaped result envelope on the wire
  'chunk',      // framework-emitted binary-stream chunks for tools with largeOutput:true
  'card',       // framework-emitted card payloads (ctx.askUser flow — bespoke-card-improvements H1).
                // Cards ride the STATE channel, not the event channel; reserving the name here
                // prevents a plugin from declaring events:{card} and intercepting other tools'
                // askUser flow on the wire.
  // NOTE: 'error' and 'progress' are NOT reserved.
  // 'progress' is documented as user-emittable via ctx.progress(pct, msg) sugar,
  // which itself routes through ctx.emit('progress', ...). Tools declare a
  // schema for it so the wire kind is inferred (dev:ipc_echo does this).
  // 'error' is dispatcher auto-emit on uncaught handler throws AND tools
  // actively emit it mid-stream for non-fatal errors (architect:chat,
  // brainstorm:chat and historical streaming tools declare it).
  // Reserving either would break production tools at register time.
] as const;

/**
 * How an event's payload is encoded on the SSE wire:
 *  - `'string'`: the payload IS a string; emit as `data: <text>\n` (multi-line `data:`
 *    when text contains newlines, joined back by parseSseStream per SSE spec).
 *    Use for token streams (LLM deltas, log lines) where the event payload
 *    has no inherent structure and JSON-wrapping is overhead.
 *  - `'json'`: emit as `data: <JSON.stringify(payload)>\n`. Use for everything
 *    structured (suggestions, tool_calls, progress payloads).
 *
 * Inferred from the declared Zod schema at tool registration:
 *  - `z.string()` schemas → 'string'
 *  - everything else → 'json'
 *
 * The MCP transport always JSON-serializes (JSON-RPC carries strings as
 * JSON-quoted strings inside notifications/papercusp/event); the
 * classification only affects the HTTP/SSE wire shape.
 */
/**
 * On-wire encoding for a single event name.
 *
 * - `'string'` — payload is the raw text of the event (no JSON wrapping).
 *   Picked when the event schema is `z.string()`. SSE `data:` line, IPC
 *   EVENT_JSON frame with the string as the `data` field.
 * - `'json'` — payload is `JSON.stringify(data)`. The default for object
 *   / number / array event schemas.
 * - `'binary'` — payload is raw bytes (Uint8Array). On SSE this falls
 *   back to base64 + a `content-encoding: base64` header (not currently
 *   implemented; would be a separate addition). On the IPC transport,
 *   this triggers an EVENT_BIN self-describing frame. Picked when the
 *   event schema is `z.instanceof(Uint8Array)`.
 *
 * See `apps/operator/content/docs/endpoint-system/transports.mdx`
 * § "Schema-inferred wire format".
 */
export type EventWireKind = 'string' | 'json' | 'binary';

/**
 * Inspect a Zod schema and decide whether the wire payload for events
 * of that shape should be raw text (`'string'`) or JSON-encoded (`'json'`).
 *
 * Cheap one-time call per declared event at register time; result is
 * cached on the tool entry so emit-time has no schema-introspection cost.
 */
export function classifyEventWire(schema: ZodTypeAny): EventWireKind {
  // Binary check: detect `z.instanceof(Uint8Array)` by probing the
  // schema with a real Uint8Array. Different Zod versions represent instanceof
  // differently (_def.type: 'custom' in v4, ZodEffects in v3), so we probe
  // structurally instead of relying on _def inspection. The probe is cheap
  // (one parse) and runs once per declared event at register time.
  try {
    const probe = schema.safeParse(new Uint8Array(0));
    const rejectsObject = !schema.safeParse({}).success;
    if (probe.success && rejectsObject) return 'binary';
  } catch {
    /* fall through to JSON */
  }

  try {
    // Pluggable schema→JSON-Schema (P-021); same path as inputSchema serialization.
    const json = toJsonSchema(schema) as { type?: string };
    return json.type === 'string' ? 'string' : 'json';
  } catch {
    // Schema rejected json conversion; default to JSON on the wire so
    // the dispatcher never produces an under-defined string fallback.
    return 'json';
  }
}

/**
 * Wire-kind-aware sink dispatch — the single source of truth for
 * "given a ctx.emit(name, data) and a tool's declared events schema,
 * how does that land on the SSE wire?"
 *
 * Used by:
 *   - HTTP transport adapter (`handleHttpToolRequestStreaming`).
 *   - Route shims that bypass the HTTP transport and call
 *     `dispatchProjectedToolStream` themselves (architect/brainstorm
 *     in `apps/operator/app/api/_hono/harness.ts`, operator-scan /
 *     operator-converse).
 *
 * Centralizing here prevents the wire-format-drift class of bug:
 *   - z.string() events going through JSON.stringify (round-2 silent
 *     mis-encoding for tools added new z.string() events post-pilot).
 *   - z.instanceof(Uint8Array) → JSON.stringify producing
 *     `{"0":..., "1":..., ...}` corruption (round-5 HTTP, round-6 MCP).
 *
 * Mirrored emit-shape per transport:
 *   - HTTP/SSE (this helper):           z.string() → sink.eventRaw raw text
 *                                       z.instanceof(Uint8Array) → sink.eventRaw base64
 *                                       else → sink.event JSON
 *   - MCP (notifications/papercusp/event in [transport]/route.ts):
 *                                       Uint8Array → {$papercuspBinary, encoding, data}
 *                                       else → params.data
 *   - IPC (server.ts):                  string event kind: EVENT_JSON with data as string
 *                                       binary: EVENT_BIN raw bytes
 *                                       else: EVENT_JSON JSON
 *
 * The shape of the SSE sink interface is the @papercusp/sse SseSink; we
 * don't import the type here to keep this file dependency-free, so
 * we declare a structural minimum: `eventRaw(name, string)` for raw-text
 * payloads and `event(name, value)` for JSON-encoded ones.
 */
export interface MinimalEventSink {
  event(name: string, value: unknown): void;
  eventRaw(name: string, value: string): void;
}

/**
 * Self-describing binary envelope. Same shape as the MCP transport's
 * notifications/papercusp/event params.data field for binary events.
 * Cross-transport unification (audit item 14) — consumers can use one
 * decoder regardless of wire format.
 */
export interface PapercuspBinaryEnvelope {
  $papercuspBinary: true;
  encoding: 'base64';
  /** Base64-encoded payload bytes. */
  data: string;
}

export function isPapercuspBinaryEnvelope(v: unknown): v is PapercuspBinaryEnvelope {
  return (
    typeof v === 'object' &&
    v !== null &&
    (v as { $papercuspBinary?: unknown }).$papercuspBinary === true &&
    typeof (v as { data?: unknown }).data === 'string'
  );
}

export function emitToSseSink(
  sink: MinimalEventSink,
  tool: Pick<ProjectedTool, 'eventWireKinds'>,
  name: string,
  data: unknown,
): void {
  const kind = tool.eventWireKinds?.[name];
  if (kind === 'string') {
    sink.eventRaw(name, typeof data === 'string' ? data : String(data));
  } else if (kind === 'binary' && data instanceof Uint8Array) {
    // Emit the same self-describing envelope as the MCP transport
    // (notifications/papercusp/event params.data). Consumers see a
    // uniform shape regardless of wire; HTTP consumer detects via
    // isPapercuspBinaryEnvelope. Slightly more bytes than raw base64
    // (~35-byte envelope tax) but consumers don't need out-of-band
    // schema info to know it's binary.
    const envelope: PapercuspBinaryEnvelope = {
      $papercuspBinary: true,
      encoding: 'base64',
      data: Buffer.from(data).toString('base64'),
    };
    sink.event(name, envelope);
  } else {
    sink.event(name, data);
  }
}

/* ─── Unified context ────────────────────────────────────────────────── */

/**
 * The single context passed to every projected tool function — same shape
 * regardless of which transport invoked it. Fields are populated by the
 * relevant transport adapter:
 *
 *   - HTTP transport (built-in tools, in-process callers): populates
 *     `principal`, `tx`, `log`. Spawn fields are populated only if the
 *     caller sent the X-Papercusp-* headers (e.g. orchestrator-spawned
 *     OMP via the bridge).
 *
 *   - MCP transport (agent calls): populates `workspaceId`, `harnessSlug`,
 *     `role`, `featureId`, `chunkId`, `runId`, `spawnId`, `parentSpawnId`,
 *     `progress`, `spawn`, `secret`, `signal`. Built-in fields like
 *     `principal`/`tx` are populated when the bearer also resolves to one.
 *
 * Tool functions opt into whichever fields they need. The framework
 * doesn't care which transport triggered the call.
 */

/**
 * Per-gate bypass signals (plan P-014 / D-006). The dispatcher's role,
 * capability, and quota gates each skip enforcement when the matching flag is
 * true. This is the engine's *neutral* representation of "this caller is
 * privileged" — it deliberately knows nothing about *why* (superuser,
 * power-user, admin, …). The host's principal/auth layer decides the mapping
 * and sets `ctx.gateBypass`; the engine never infers it. Absent ⇒ no bypass
 * (fail-closed: every gate enforces).
 */
export interface GateBypass {
  /** Skip the role-allowlist gate. */
  role?: boolean;
  /** Skip the capability gate. */
  capability?: boolean;
  /** Skip the quota gate. */
  quota?: boolean;
  /**
   * Skip the harness-required gate. NOT set by Papercusp's superuser/
   * power-user mapping — a harness:'required' tool genuinely can't function
   * without a harness, so the gate fails closed even for privileged callers
   * (the point is to return the uniform "harness required" hint, not to push
   * the failure into the handler). Present as an explicit per-call escape hatch.
   */
  harness?: boolean;
  /**
   * Skip the resource-`authorize` gate (RFC tooldef-auth D-F). Default OFF and, unlike
   * the bypasses above, it is NOT implied by them — resource ownership is a *separate*
   * decision a host opts out of explicitly, per call (a host that maps superuser onto
   * `{role,capability,quota}` still runs `authorize` unless it ALSO sets this). When set,
   * the dispatcher does not run the tool's `authorize` hook — BUT it still emits an
   * `AuthAuditEvent` recording the bypass (an *audited* break-glass, never a silent
   * super-admin; break-glass best practice = "policy-governed + mandatorily logged").
   */
  policy?: boolean;
}

export interface RequestOriginMetadata {
  /** Transport adapter that observed the request, e.g. "mcp". */
  transport: string;
  /** Host-observed physical binding; separate from protocol/format policy. */
  connection?: 'http' | 'uds';
  /** URL pathname only; query params are whitelisted separately below. */
  path?: string;
  /** Non-secret request query params useful for attribution/debugging. */
  query?: Record<string, string>;
  /** Non-secret request headers useful for attribution/debugging. */
  headers?: Record<string, string>;
  /**
   * Host-classified native-session presentation. Fingerprints preserve the
   * carrier without retaining its raw value. A bound pair proves caller/row
   * consistency, not possession or physical actor identity.
   */
  nativeSession?: {
    carrier: 'header:x-papercusp-native-session' | 'query:native_session';
    valueFingerprint: string;
    binding: 'bound' | 'unbound';
    candidateAdvSessionId: number | null;
  };
}

export interface UnifiedToolContext {
  /** Tool-bound logger. Always populated. */
  log: (msg: string) => void;
  /**
   * The session's payload tier (context-trimming-tiers D-004) — wired by the
   * host from its transport (e.g. an MCP URL `ctx_tier=` param). Read at
   * serialize time to pick a tool's `shape.trimmed`/`shape.standard`
   * projection; absent ⇒ 'full' (the unshaped response). A per-call
   * `payloadTier` arg outranks it.
   */
  contextTier?: import('./payload-tier').PayloadTier;
  /**
   * The per-call `payloadTier` override, when the caller supplied one.
   * Unlike `contextTier`, absence means that no call-level override was
   * requested. Raw `ToolResult` handlers use this distinction because the
   * framework's generic payload shaper does not run for self-serialized
   * results.
   */
  payloadTierOverride?: import('./payload-tier').PayloadTier;
  /**
   * Host-provided parsed dispatch projection for source-aware reads. The
   * generic tooldef package keeps this opaque because projection syntax is
   * host-owned; a transport may thread it to a handler that can push a
   * caller-selected field projection into its storage query. It is metadata,
   * never a validated tool argument.
   */
  sourceProjection?: unknown;
  /**
   * True when this call's result does NOT cross the agent-facing transport and
   * therefore must not be force-shaped by `applyPayloadTier`'s hard ceiling
   * (EI-18719561823587590). Set by an IN-PROCESS consumer that reads the data
   * programmatically — today, `code:run`'s inner dispatch, whose intermediate
   * results exist only for the script's own control flow (`.length`,
   * `.filter()`, a completeness check) and never enter anyone's context.
   *
   * ⚠ The hard ceiling ignores the resolved tier entirely, so clearing
   * `contextTier` (or resolving to 'full') is NOT sufficient to get the true
   * full payload — that only skips STEP 1 tier shaping. This flag is what skips
   * STEP 2. Losing that distinction is the whole bug: a `code:run` script's
   * `.find()` searched a silently row-truncated subset, and its "not found" was
   * indistinguishable from real absence.
   *
   * Only ever set it for a consumer that genuinely does not serialize the result
   * to an agent — an over-cap payload on the MCP transport is a hard failure,
   * not a large message.
   */
  transportCapExempt?: boolean;
  /**
   * EI-20720054720826414: how THIS host spells a raw-args dispatch that can carry
   * the framework-reserved `payloadTier` arg — e.g. papercusp's
   * `tools:invoke { name:'{tool}', args:{ …original args, payloadTier:'full' } }`
   * (`{tool}` is substituted with the tool name at render time). The bounded-
   * payload door's recovery `next` used to end at "route these args through your
   * host's raw-args dispatch path" — a description of an instruction, not an
   * instruction — leaving the caller to guess the working spelling at exactly
   * the moment they had just lost a field. Absent ⇒ the generic host-neutral
   * wording, unchanged; set once where the host builds its tool context.
   */
  rawDispatchTemplate?: string;
  /**
   * True when this call is an INNER dispatch from a `code:run` script, i.e. the
   * result is consumed as a JS VALUE (`result.output`) rather than read as text
   * by a model.
   *
   * EI-20066912585022608: a handler that hand-rolls a human-readable text
   * `ToolResult` (a header line + rendered output) is correct for the agent-facing
   * MCP transport and WRONG for code-mode — `unwrapToolResult` finds no JSON to
   * parse and hands the script a raw STRING, so the property access the author
   * naturally writes resolves to `undefined` in silence. `capability:bash` showed
   * the sharpest form: its BACKGROUND branch returns JSON (a real object) while
   * its FOREGROUND branch returns rendered text, so the same call expression
   * changes shape with an argument.
   *
   * A handler in that position reads this flag and attaches `structuredContent`
   * (which `unwrapToolResult` prefers) with the same data its text body renders.
   * Gate on it rather than attaching unconditionally: duplicating the payload for
   * DIRECT callers would double the wire bytes of a tool nobody asked to be
   * machine-readable. Prefer field names that state what the value actually is —
   * the script's own field-miss tracker (run-script.ts) corrects a wrong guess by
   * listing the real keys, but only if the value is an object at all.
   */
  codeMode?: boolean;
  /** Dispatcher-generated id for this exact handler call; safe as an idempotency key. */
  dispatchCallId?: string;
  /** True when this handler was reached through ctx.dispatchTool rather than a top-level call. */
  indirectDispatch?: boolean;
  /** Aborts on per-tool timeout, parent cancellation, or shutdown. */
  signal: AbortSignal;

  /**
   * Optional host-selected execution seat for the P-041 kernel port.  A
   * transport may set this explicitly (for example `reaction` or
   * `indirect-dispatch`); the generic dispatcher otherwise uses `dispatch`.
   * `dispatchBoundary` is a compatibility alias for early adapters.
   */
  kernelBoundary?: KernelBoundary;
  dispatchBoundary?: KernelBoundary;
  /** Resource/claim ownership evidence resolved by the host for this call. */
  kernelOwnership?: KernelOwnershipRequirement;
  /** Optional host snapshot used by the operator adapter's policy resolver. */
  kernelState?: KernelContextState;
  /** Revision the caller asks the boundary to use, if one was selected. */
  requestedExecutionRevision?: KernelExecutionRevision | null;
  /** Revision the host has already applied before this call began. */
  appliedExecutionRevision?: KernelExecutionRevision | null;
  /**
   * Actual revision stamped by the dispatcher after final enforcement.  This
   * is absent on the original context and is populated on `handlerCtx`; it is
   * never a desired/prepared-only value.
   */
  executionRevision?: KernelExecutionRevision | null;
  /** Last normalized kernel decision visible to the handler/telemetry. */
  kernelEnforcement?: KernelEnforcementResult | null;
  /** Preflight decision paired with `kernelEnforcement` on handler contexts. */
  kernelPreflight?: KernelEnforcementResult | null;
  /**
   * Stream progress events. Thin alias over `emit('progress', { progress, total, message? })`.
   * Tools using the standard pct/msg shape should prefer this; tools
   * emitting richer typed events should use `emit` directly.
   * No-op when transport doesn't support streaming.
   */
  progress: ProgressCallback;
  /**
   * Emit a typed named event. The active transport adapter decides what
   * happens:
   *   - HTTP/SSE → `event: <name>\ndata: <JSON(data)>` via @papercusp/sse.
   *   - MCP → `notifications/papercusp/event` with `{ event: name, data }`.
   *   - In-process (`fnStream`) → next value of the async iterator.
   *   - Non-streaming HTTP → no-op.
   *
   * Reserved names: 'done' | 'progress' | 'heartbeat' | 'result'. The
   * framework emits 'done' automatically when the handler returns and
   * 'error' automatically when it throws. Handlers may also emit 'error'
   * mid-stream for non-fatal errors (dual-mode by design — preserves
   * runAgentChat's non-terminal error event semantics).
   *
   * Always populated; transport adapter installs the right impl.
   */
  emit: EmitCallback;

  /**
   * Expand the caller's LIVE tool surface at runtime — activate additional
   * tools by name for THIS session. The transport adds the names to the
   * session's mutable allowlist and, if the client negotiated
   * `tools.listChanged`, fires `notifications/tools/list_changed` so the
   * client re-fetches `tools/list` and can call the surfaced tools.
   *
   * The server-side half of the "small seed + expand on demand" model: a
   * session launched with a trimmed listing seed (e.g. an MCP `?tools=` core
   * set) calls this — typically via a discovery tool like `tools:find` — to
   * surface the long tail on intent, WITHOUT paying the full-catalog token
   * cost up front. Returns true iff the surface actually grew (something new
   * was added), so the caller can tell whether a re-fetch will be triggered.
   *
   * No-op returning false on transports without a mutable per-session surface
   * (in-process / non-MCP) or a session that was never seeded (a full-catalog
   * session already has everything). Optional — reference as
   * `ctx.activateTools?.(names)`.
   */
  activateTools?: (toolNames: readonly string[]) => boolean;

  /**
   * Dispatch ANOTHER tool by name server-side and return its result — the
   * engine behind a `tools:invoke { name, args }` meta-tool. The target runs
   * under THIS caller's context (same principal / tx / privilege), so it is
   * gated EXACTLY as a direct call would be — a router, not a privilege bypass.
   *
   * The universal reachability escape hatch: a client that never sees the long
   * tail in its own tool list (a small seed on a client that doesn't act on
   * `tools/list_changed`) can still reach any tool by routing the call through
   * the meta-tool — no client-side registry growth required. Complements the
   * dynamic surface: `tools:find` returns the target's name+schema, then this
   * calls it.
   *
   * Optional — present only on transports with a server-side dispatcher (MCP).
   * Reference as `ctx.dispatchTool?.(name, args)`.
   */
  dispatchTool?: (
    toolName: string,
    toolArgs?: unknown,
  ) => Promise<{
    content: ReadonlyArray<unknown>;
    isError?: boolean;
    _meta?: Record<string, unknown>;
    structuredContent?: unknown;
  }>;

  /* ── Auth / db (typically built-in tools) ─────────────────────────── */
  /**
   * Auth principal resolved by the transport. The legacy identity fields stay
   * required for compatibility with in-process callers; transport adapters
   * should populate the provenance fields from the canonical Principal record.
   * Null when caller is anonymous.
   */
  principal?:
    | (Pick<Principal, 'slug' | 'workspaceId' | 'capabilities'> &
        Partial<Pick<Principal, 'kind' | 'authMethod' | 'trust' | 'roles' | 'label' | 'allowedTools'>>)
    | null;
  /**
   * Transaction-bound Sql client with `app.workspace_id` GUC set. Built-in
   * tools rely on this; plugin tools may use it. Null when call wasn't
   * wrapped in `withWorkspace`.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx?: any;

  /**
   * Per-gate bypass signals — the engine's neutral "this caller is
   * privileged" input (plan P-014). The role/capability/quota gates read
   * THIS, not the `isSuperuser`/`isPowerUser` fields below. The host maps its
   * auth tiers onto it (Papercusp: `@papercusp/agent-mcp`'s `papercuspGateBypass`).
   * Absent ⇒ every gate enforces (fail-closed).
   */
  gateBypass?: GateBypass;

  /**
   * True when the call entered through the superuser endpoint
   * (loopback + bearer-token auth — see apps/operator/lib/superuser-token.ts
   * and apps/operator/content/docs/endpoint-system/superuser-mode.mdx).
   *
   * Host metadata only — the dispatcher no longer reads this for gating
   * (P-014 moved the bypass decision to `gateBypass`, set by the host). Still
   * consumed by profile resolution + host code (agent_tools:list, docs
   * adapters). The transport that sets this also sets `gateBypass`.
   */
  isSuperuser?: boolean;

  /**
   * True when the call entered through the `?power_user=1` endpoint
   * (loopback + a workspace-scoped HMAC access token — see
   * apps/operator/lib/power-user-token.ts and
   * apps/operator/docs/plans/omp-power-user-bundle-2026-05-20.md §4.1).
   *
   * Host metadata only (see `isSuperuser`). The Papercusp bypass mapping
   * (`papercuspGateBypass`) encodes the tier distinction the engine used to
   * hardcode: superuser bypasses quota, power-user does NOT — workspace
   * quotas apply to end users. The quota window is keyed on the stable auth
   * session (`uiClientId`), not the per-request `runId`.
   */
  isPowerUser?: boolean;
  /**
   * A stable party the run-windowed quota accumulates on, for a caller that
   * mints a fresh `runId` per dispatch yet must be charged as one party — the
   * same problem `isPowerUser` solves for the per-request MCP run. When set,
   * the quota window is `subject:<quotaSubject>` with the `perRun` ceiling;
   * `runId` still groups telemetry per dispatch.
   */
  quotaSubject?: string;
  /**
   * Active caller profile. Governs which tools appear in `tools/list`
   * and which `tools/call` invocations are accepted.
   *
   * - `'power'`    — power-engineer-on-any-harness. Only Group B + C
   *                  tools (`ProjectedTool.profile` omitted or `'all'`).
   *                  Group A (`profile: 'engineer'`) is hidden + rejected.
   * - `'engineer'` — Papercusp engineer/operator. All tools visible.
   *
   * Resolution order (highest wins):
   *   1. `isPowerUser` (power-user token) → always `'power'`.
   *   2. `isSuperuser` + `?profile=power` URL param → `'power'` (SU testing).
   *   3. Default → `'engineer'`.
   *
   * See: apps/operator/docs/plans/omp-profile-system-2026-05-24.md
   */
  profile?: 'engineer' | 'power';

  /**
   * Which transport adapter built this context. Recorded on the
   * `tool_invocations.transport` column so /dev → Sessions / Telemetry
   * can filter by transport.
   *
   * Set by transport adapters (HTTP, MCP, IPC). Left undefined for
   * in-process / shim callers that build a ctx directly without going
   * through an adapter — `recordInvocation` writes null in that case.
   */
  transport?: 'http' | 'mcp' | 'ipc' | 'in_process';

  /**
   * Sanitized transport request provenance. Adapters populate only non-secret
   * headers/query params, then recordInvocation persists it in
   * `tool_invocations.metadata_json.requestOrigin` so unattributed loopback
   * calls can be traced to their client surface without storing auth material.
   */
  requestOrigin?: RequestOriginMetadata;

  /**
   * Validated request-level idempotency key supplied by the transport. Hosts
   * may use it to make downstream side effects stable across a retry of the
   * same request; absent for calls that did not opt into idempotency.
   */
  idempotencyKey?: string;

  /**
   * Client-negotiated result format (token-efficient-tool-result-formats D-005).
   * The RAW request token from the transport — `?format=`/`Accept` on HTTP,
   * `_meta.format` or `?format=` on MCP — parsed by the result serializer via
   * `parseFormatRequest` (`json|toon|csv|tsv|md|compact` + MIME types). The
   * format is set by the CLIENT PROCESS, never authored by the model. Absent ⇒
   * the serializer uses the transport default (MCP → compact, else JSON). On an
   * unsupported request the serializer falls back gracefully and labels it.
   */
  requestedFormat?: string;

  /**
   * Opt-in for MCP `structuredContent` (P-010) — set by the transport from
   * `?structured=1` / `_meta.structured`. When true, a result with a declared
   * output schema also carries the lossless structured `data` alongside the
   * compact text. OFF by default so the model never pays for both at once.
   */
  requestedStructured?: boolean;

  /**
   * Client-negotiated freshness request (agent-tool-delta-protocol-2026-06-22,
   * D-001). The RAW token from the transport — `_meta.delta` or `?delta=` on MCP
   * (`"<mode>"` / `"<mode>~<cursor>"`, parsed by `parseDeltaRequest`). Like
   * `requestedFormat`, it is set by the CLIENT/HARNESS process, never the model:
   * the harness owns cursor storage + base-presence tracking and only asks for
   * `not_modified` when it can prove the matching base is still in context.
   * Absent ⇒ no negotiation (serve full, as today). Consumed by the result
   * serializer when the tool declared a `delta` capability.
   */
  requestedDelta?: string;

  /* ── Spawn context (typically agent-driven calls) ─────────────────── */
  workspaceId?: string;
  harnessSlug?: string;
  projectDir?: string;
  stateDir?: string;
  role?: AgentRole;
  featureId?: string | null;
  chunkId?: string | null;
  runId?: string;
  /**
   * Explicit proof that this caller has an interactive card responder.
   * Workspace/run identity alone is not sufficient: headless, MCP, and
   * non-chat in-process calls may also carry both fields but have nowhere to
   * render or answer a card. Transport adapters for interactive chat surfaces
   * set this to true; absent means card prompting is unavailable.
   */
  interactiveCardCapability?: true;
  spawnId?: string;
  parentSpawnId?: string | null;
  /**
   * True when the transport VERIFIED a signed per-spawn URL's signature for
   * this context (never set for unsigned / soft-allowed spawn URLs). Hosts
   * may key identity attribution on it for spawn callers that carry no
   * explicit client/owner id — e.g. attribute to the stable harness rather
   * than the per-call spawn id.
   */
  sigVerifiedSpawn?: boolean;

  /**
   * Set by the event-reaction system on a ctx it builds for a REACTION call
   * (a tool fired automatically by a rule). Absent on ordinary
   * agent/user-originated calls. Carries the cause-chain so the loop guard
   * (event-reaction-system D-005) can cap depth + detect cycles on the NEXT
   * post-invocation, and so telemetry can audit "why did this fire?"
   * (D-010). The dispatcher itself never reads this — it is host metadata
   * the host's `postInvoke` interprets.
   */
  reactionCause?: {
    /** Depth in the reaction cascade. An agent call is 0; its direct reactions are 1. */
    depth: number;
    /** Rule ids fired so far in this chain (cycle detection). */
    chain: string[];
    /** The rule that fired THIS call. */
    ruleId: string;
    /** The runId of the original (agent) trigger that rooted the chain. */
    rootRunId?: string | null;
  };

  /**
   * When the agent was spawned from a browser tab (chat surfaces), the
   * tab's UI client_id is passed through here so `ui:*` tools default
   * to it. Null/undefined for headless spawns and CLI callers.
   */
  uiClientId?: string | null;

  /**
   * Database row id of this caller's adv_sessions launch, set only when the
   * MCP host verified the native CLI session is bound to that row. The operator
   * kernel uses it to read this caller's launch authority rather than another
   * active row owned by the same coordination identity.
   */
  advSessionId?: number;

  /**
   * Private stable session key for process-local failure-loop detector state.
   * It is deliberately separate from the public coordination identity exposed
   * by `resolveAgentIdentity` and is never rendered in failure hints.
   */
  failureLoopSessionKey?: string | null;

  /**
   * Recall-telemetry surface label for a sub-call folded by a COMPOUND tool
   * (`inProcessCall(ctx, { telemetrySurface })`). It lets the folded tool
   * self-identify its entry point — coord:orient's `memory:search` fold records
   * under `'orient'` rather than blending into generic `'search'` — so
   * per-entry-point recall quality is measurable. Telemetry only: never affects
   * what a tool returns, and never agent-settable (ctx-borne, not a tool arg).
   *
   * DECLARED here on purpose (WI-4549): it was previously carried only as a cast
   * (`ctx as { telemetrySurface?: string }`), so the principal-gated legacy shim's
   * hand-rolled ctx silently dropped it with no type error — orient recorded ZERO
   * rows for weeks. A ctx-borne field that no type describes is a field the next
   * ctx rebuild will eat.
   */
  telemetrySurface?: string;

  /**
   * The CLI backend the CALLING agent runs under — `'omp' | 'claude' | 'codex'`. The launcher
   * stamps it onto the session's MCP URL (`?agent=`) and the transport folds it here. It is the
   * CURRENT process's backend (a resume/handoff is a fresh launch that re-stamps), so a tool can
   * default a spawned agent's backend to the caller's own instead of a hardcoded guess (e.g.
   * fleet:launch-on-plan). Undefined for callers whose launcher didn't stamp it. Provenance/
   * defaulting hint only, never a security boundary.
   */
  callerAgent?: string | null;
  /**
   * The model the calling agent was launched on (`?model=` on the MCP URL), resolved by the
   * launcher (explicit `--model` or the backend default). Paired with `callerAgent` so a tool can
   * inherit the caller's model when it inherits the backend. Undefined when unstamped.
   */
  callerModel?: string | null;

  /**
   * The plan-run conversation that this call belongs to, when the
   * caller is an agent launched from a plan (`plans:launch` —
   * plan-agent-launch-2026-05-21). It is the `runAgentChat` session id
   * minted by the plan-agent runner and carried on the MCP endpoint
   * URL as `?plan_run=<uuid>`; the MCP transport folds that param
   * here. `plans:*` write verbs read it (via `resolvePlanSessionRef`)
   * so a revision made by a launched agent is attributed to its run.
   *
   * Null/undefined for every other caller — an SU engineer session, a
   * browser `/admin/plans` edit, an orchestrator spawn. It is a
   * provenance label only, never a security boundary (like
   * `uiClientId`).
   */
  planRunSessionId?: string | null;

  /* ── Capability-gated helpers ─────────────────────────────────────── */
  spawn?: PluginSpawn;
  secret?: (name: string) => Promise<string | null>;

  /**
   * Mid-run interactive prompt — opens a card on the STATE channel
   * and resolves when the user submits/declines/cancels (or the
   * timeoutMs fires).
   *
   * Plan: apps/operator/docs/plans/bespoke-card-improvements-2026-05-13.md §4
   *
   * Returns:
   *   {action:'submit',  payload}   — user picked, Zod-validated against spec.dataSchema
   *   {action:'decline', reason?}   — user explicitly declined (allowDecline≠false)
   *   {action:'cancel'}             — run cancelled, workspace switched, or timeout
   *
   * Cards live on the STATE channel — they are NOT in the event ring
   * buffer, so reconnect-after-answer does NOT re-prompt (H2 from review).
   *
   * Available when the transport supports it (HTTP/SSE, IPC, in-process).
   * Falls back to immediate {action:'cancel'} when the transport has
   * no client to ask (e.g. non-streaming HTTP).
   */
  askUser?: AskUserCallback;

  /**
   * Publish the tool's current state snapshot to the state channel.
   *
   * Plan: apps/operator/docs/plans/bespoke-card-improvements-2026-05-13.md §5
   *
   * The snapshot is validated against the tool's `state` schema and
   * replaces the run's current snapshot. Clients reconnecting receive
   * the latest snapshot — never event history (that's the whole point
   * of being on the state channel).
   *
   * v1: snapshot-only. Passing anything other than a full snapshot
   * throws. v1.1 will accept JSON-Patch arrays for delta updates
   * once we measure full-snapshot perf on real tools.
   *
   * Throws if the tool has no `state` schema declared, or if the
   * snapshot fails Zod validation.
   *
   * Installed by the dispatcher when (a) ctx has workspaceId + runId
   * and (b) the tool declared a `state` schema at register time.
   * Tools should check `if (ctx.publishState)` before calling.
   */
  publishState?: PublishStateCallback;

  /**
   * Attach per-call structured metadata for telemetry. The dispatcher
   * captures whatever payload the handler set MOST RECENTLY before the
   * call ends and persists it into `harness_shared.tool_invocations
   * .metadata_json` (added by migration 068).
   *
   * Used for shape-specific telemetry that doesn't fit the fixed
   * columns — e.g. docs:get emits `{ requested, found, truncated,
   * sliced }`, search:* emits `{ result_count, ranker }`. Lets
   * Phase-2 trigger predicates query specific JSONB paths without
   * adding new columns per tool.
   *
   * Best-effort: implementations that haven't run the migration
   * (older operator versions, IPC dev sandboxes) drop the payload
   * silently. Tools should NOT rely on this for correctness — only
   * for telemetry.
   *
   * Always installed by the dispatcher (no opt-out).
   */
  metadata?: (data: Record<string, unknown>) => void;
}

/** ctx.publishState — snapshot-only in v1. */
export type PublishStateCallback = (snapshot: unknown) => void;

/**
 * `ctx.askUser(spec)` — mid-run interactive prompt. Returns a `CardResponse`
 * shaped per the discriminated union in `./types`.
 */
export type AskUserCallback = <TSchema extends StandardSchemaV1>(
  spec: import('./types').CardSpec<TSchema>,
) => Promise<import('./types').CardResponse<TSchema>>;

/** A tool function — one shape for every transport. */
export type ToolFn<TInput = unknown> = (
  input: TInput,
  ctx: UnifiedToolContext,
) => Promise<ToolResult>;

/* ─── Manifest declarations ──────────────────────────────────────────── */

export interface ToolExposureHttp {
  /** Path the catch-all HTTP route serves; e.g. '/api/plugins/repomix/pack'. */
  path: string;
  /** Allowed methods. Default: ['POST']. */
  methods?: ReadonlyArray<'POST' | 'GET' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS'>;
  /**
   * Single-method sugar. Equivalent to `methods: [method]`. Accepted alongside
   * `methods` for ergonomics — the route-shaped callsites prefer the singular
   * form (mirrors the now-collapsed `defineTool({ method })` shape). When both
   * are set, `methods` wins.
   *
   * Phase E1 (endpoint-unification-2026-05-21).
   */
  method?: 'POST' | 'GET' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS';
}

export interface ToolExposureMcp {
  /** MCP tool name; must use dotted naming (e.g. 'repomix.pack'). */
  name: string;
  /**
   * If true, the tool may emit progress events via `ctx.progress(...)`.
   * The MCP transport translates them to `notifications/progress` events.
   * No effect on the HTTP transport (which uses SSE differently).
   */
  streaming?: boolean;
  /**
   * If true, the tool may produce an output too large to inline; result
   * shaping should write to `<stateDir>/scratch/<...>` and return `{ path }`.
   * Hint to the framework's content-shaper, not enforced.
   */
  largeOutput?: boolean;
}

/**
 * Slash-exposure overrides (slash-exposure-tool-catalog-2026-06-12). The
 * slash surface projects an MCP-exposed tool onto the MCP **prompts**
 * primitive so agent clients (Claude Code, …) surface it as a slash
 * command. Unlike `http`/`mcp` this is NOT a dispatch transport — the
 * rendered prompt instructs the agent, and the agent's tool call rides the
 * session's existing MCP transport (D-001 on the plan).
 */
export interface ToolExposureSlash {
  /**
   * Override the prompt's name SUFFIX. The full prompt name is always
   * `tool:<name>`; default `<name>` = the tool's `expose.mcp.name`.
   */
  name?: string;
  /** Override the slash listing's description. Default: `guidance.when` ?? `description`. */
  description?: string;
  /**
   * Restrict which top-level input fields surface as MCP prompt arguments.
   * Default: every top-level scalar (string/number/integer/boolean/enum)
   * property of the input schema. Non-scalar fields never become prompt
   * arguments — the rendered instruction has the agent elicit them (D-004).
   */
  args?: readonly string[];
}

/** Per-tool exposure config — at least one of `http`/`mcp`/`ipc` must be set. */
export interface ToolExposure {
  http?: ToolExposureHttp;
  mcp?: ToolExposureMcp;
  /**
   * Mark this endpoint as IPC-eligible. When `true`, the endpoint-IPC
   * adapter exposes it over the UDS framing (in-process + Rust callers).
   * Default false — IPC opt-in mirrors HTTP/MCP opt-in. Phase E8.
   */
  ipc?: true;
  /**
   * Slash-command exposure via MCP prompts. DEFAULT ON for every
   * MCP-exposed tool (owner-ratified D-003, slash-exposure-tool-catalog-
   * 2026-06-12): absent/`true` ⇒ projected; `false` ⇒ hidden from the
   * slash surface; an object ⇒ projected with overrides.
   */
  slash?: boolean | ToolExposureSlash;
}

/**
 * A mutation-specific receipt evaluated only when the dispatch signal aborted
 * after the handler returned. Unlike the static `idempotent` marker, this is
 * evidence about this exact attempt and its returned effect identity.
 */
export interface AbortCompletionReceipt {
  status: 'recorded' | 'not-recorded' | 'recovery-incomplete';
  /** Durable identity of the effect this attempt recorded, when known. */
  effectRef?: string;
  /** Stable explanation for a no-effect or incomplete-recovery outcome. */
  reason?: string;
  /** Explicit recovery failures; empty/absent when recovery was complete. */
  failures?: readonly string[];
}

export interface AbortCompletionContext {
  /** Dispatcher-owned identity for this exact attempt. */
  callId: string;
  toolName: string;
}

export type AbortCompletionReceiptResolver<TArgs = unknown> = (
  args: TArgs,
  result: ToolResult,
  context: AbortCompletionContext,
) => AbortCompletionReceipt | null | undefined;

/**
 * One entry in the projection registry. Combines the function (truth)
 * with manifest metadata (gates + exposure).
 */
export interface ProjectedTool {
  /** Owning plugin name. Built-in tools use 'agent-mcp' or similar. */
  pluginName: string;
  /** One-line description shown in tool listings. */
  description: string;
  /**
   * Absolute path of the file that called `defineTool` for this tool, captured
   * from the call stack at registration time (see `captureDefinitionSite`).
   * Absent when the stack was unreadable, or for registrations that do not come
   * through `defineTool` (JSON-manifest plugin tools have no defining module).
   *
   * Deliberately ABSOLUTE and host-agnostic: this lib cannot know what a "repo
   * root" is. A host that wants a repo-relative path resolves it against its own
   * root — see `toolSchemaStaleness` in operator-core, which uses it to answer
   * "is the schema this process is serving older than the tree?".
   */
  sourceFile?: string;
  /**
   * Set INSTEAD of `sourceFile` when the tool was defined inside a bundle that also
   * inlines this library: every frame reports the same file, so the file cannot name
   * the defining module, but the frames' LINES can. A host that can read the bundle
   * resolves it with `definingModuleOfBundledSite` (P-002 / EI-25176539351759672).
   */
  bundledDefinitionSite?: BundledDefinitionSite;
  /**
   * OpenAI/MCP-safe JSON Schema for tool input. Validated before invocation
   * and advertised to strict function-calling clients. Built-in `defineTool`
   * registrations flatten root unions here because those clients reject a
   * top-level `oneOf`/`anyOf`.
   */
  inputSchema: Record<string, unknown>;
  /**
   * Full JSON Schema for discovery/introspection surfaces. This preserves
   * branch-specific requirements that `inputSchema` must relax for strict
   * function-calling clients (for example, a union requiring `path` OR
   * `sha`). Plugin registrations may omit it when they only provide a JSON
   * Schema surface.
   */
  discoveryInputSchema?: Record<string, unknown>;
  /**
   * Capabilities required to invoke. The dispatcher checks these against
   * the calling principal's grants (built-in path) AND against the
   * plugin's manifest-declared `capabilities` (plugin path). Empty array
   * means no capability gate.
   */
  capabilities: Capability[];
  /**
   * Read/write effect (code-execution-tool-orchestration B-CX-PRE). 'write' = the tool
   * mutates state; 'read' = side-effect-free. Inferred from the capability suffix at
   * `defineTool` time (overridable per tool). Read by the code-execution sandbox to decide
   * whether a tool call needs a dry-run/confirm gate (read-only ⇒ no gate). Optional for
   * back-compat; absent ⇒ unknown (the gate may default-deny a mutating call).
   */
  effect?: 'read' | 'write';
  /**
   * Optional argument-sensitive effect classifier. Orchestration callers
   * resolve this once per facade call and fall back to effect when it returns
   * an invalid value or throws.
   */
  effectForCall?: (args: unknown) => 'read' | 'write';
  /**
   * Idempotent-completion opt-in (backend-reliability-100pct-2026-07-03 W6 / P-007). When
   * `true`, a handler that RAN TO COMPLETION but whose `ctx.signal` had already aborted
   * (the wall-clock/idle timeout fired mid-handler under load) surfaces its COMPLETED
   * result as success instead of a spurious `timeout` error. Safe ONLY for a tool whose
   * effect is idempotent — re-applying (or surfacing a completed apply of) the write can
   * never double-effect or corrupt state (e.g. `plans:set-status` sets a status token to a
   * fixed value; re-applying is a no-op). Default (absent/false) preserves the conservative
   * behaviour: a completed non-low-tier mutation past the deadline still reports `timeout`
   * (the abort stays authoritative). This turns the 280 `plans:set-status` false-timeouts —
   * writes that COMMITTED but returned a `timeout` because wall-clock beat the deadline —
   * into honest successes, so the agent never re-dispatches a write that already landed.
   * ONLY the dispatch abort-race branch reads this; it is inert on the happy path.
   */
  idempotent?: boolean;
  /**
   * Attempt-specific alternative to `idempotent`. When a handler returns after
   * its signal aborted, the resolver may prove that this exact attempt either
   * recorded a named effect or recorded nothing. `recovery-incomplete`, a
   * missing receipt, or a thrown resolver fails closed to the timeout path.
   */
  abortCompletionReceipt?: AbortCompletionReceiptResolver;
  /**
   * Canonical tool names this COMPOSITE tool bundles (tool-call-batching-wrappers
   * P-010). Empty/undefined ⇒ a primitive. Read by agent_tools:list (the queryable
   * composition tag) and prompt-assembly's renderToolsCatalog (the bounded
   * back-pointer that points each bundled primitive at this composite).
   */
  replaces?: readonly string[];
  /** Composition tag derived from `replaces` at defineTool time: 'composite' when
   *  `replaces` is non-empty, else 'primitive'. Queryable via agent_tools:list. */
  composition?: 'primitive' | 'composite';
  /**
   * Allowed agent roles. Empty/undefined means any role can call. Used
   * primarily by the MCP transport (agent calls); HTTP callers gate via
   * principal capabilities instead.
   */
  agentRoles?: AgentRole[];
  /** Per-role quota windows. Roles without an entry are unlimited. */
  rolesQuota?: Partial<Record<AgentRole, RolesQuota>>;
  /**
   * Whether the tool's handler requires an authenticated principal. Role-gated
   * tools set this to false; the MCP host uses it to avoid synthesizing a
   * principal when a privileged caller can already pass the role/capability
   * gates and the handler has opted out of its ambient workspace transaction.
   */
  requirePrincipal?: boolean;
  /**
   * Resource-authorization hook (RFC tooldef-auth Phase 1b). When set, the dispatcher
   * runs it after the coarse gates and before the handler — fail-closed, audited, and
   * bypassable only via `GateBypass.policy`. Unset = no resource gate (the legacy
   * default; default-deny is RFC Phase 3). See `Authorizer`.
   */
  authorize?: Authorizer<unknown, UnifiedToolContext, UnifiedToolContext['principal']>;
  /**
   * RBAC role requirement (RFC tooldef-auth Phase 2). The caller's `principal.roles`
   * must include at least ONE of these (any-of). Checked by the dispatcher's
   * `role-requirement` gate — fail-closed (denied when there is no principal), audited,
   * and bypassed by `GateBypass.role` (a superuser passes RBAC role gates too). Distinct
   * from `roles` above, which is the AGENT-orchestration allowlist checked against
   * `ctx.role`. The declarative, typed replacement for ad-hoc `requireAdminKey` /
   * `requireStaff`-style checks.
   */
  requireRoles?: readonly string[];
  /**
   * Opt out of default-deny (RFC tooldef-auth Phase 3). When the host enables
   * `deps.defaultDeny`, a tool that declares NO gate (no capabilities, roles,
   * requireRoles, or authorize) is denied as `ungated` UNLESS it sets `public: true` —
   * the explicit "this tool intentionally needs no auth" marker (the `[AllowAnonymous]`
   * equivalent). Default-deny is NOT bypassable: an ungated tool is a declaration gap
   * regardless of caller, so the fix is to declare a gate or mark it public.
   */
  public?: boolean;
  /**
   * Declarative preconditions (autoloop-pot-operator-rebuild D-006) — the
   * preInvoke mirror of `emits:`. Evaluated by the dispatcher's
   * `preconditions` step (after `authorize`, before `timeout`): each spec's
   * condition must hold over `{ tool, args, ctx, state }` or the call rejects
   * (`precondition_failed`) / auto-corrects (`{ fire, then: 'retry' }` via
   * `deps.firePrecondition`). Functional preconditions ONLY — safety
   * invariants stay imperative code (D-007). See `ToolRequireSpec`.
   */
  requires?: readonly import('./requires').ToolRequireSpec[];
  /** Per-call wall-clock timeout, default 60s. */
  timeoutSec?: number;
  /**
   * Idle timeout — abort if no event has been emitted for this many
   * seconds. Augments `timeoutSec` (the wall-clock cap). 0 or undefined
   * disables idle-watchdog. Default off. Useful for streaming tools that
   * spawn child processes — wedged children stop emitting; this catches
   * them sooner than the wall-clock cap.
   */
  idleTimeoutSec?: number;
  /**
   * Per-call replay ring-buffer size. When > 0, the dispatcher keeps
   * the last N emitted events keyed on (workspaceId, toolName, runId)
   * for ~5 min past stream-end. A reconnecting client sending
   * `Last-Event-ID` + `X-Papercusp-Run-Id` headers gets the buffered
   * tail replayed before the cold sink continues. Eviction is FIFO
   * with a one-line warn log per evicted event. Phase 4 T2.2.
   *
   * Disconnect semantics: tool ABORTS on disconnect; replay serves
   * only the pre-disconnect buffer (model "(b)" in the plan). See
   * phase-4-endpoint-system-2026-05-12.md § T2.2 for the rationale.
   */
  replayBufferSize?: number;
  /**
   * Cross-workspace opt-out (P-062 Phase 4). Read by the HTTP host's
   * `runScoped` scoping seam: when true the tool runs on the admin
   * (rolbypassrls) handle rather than a workspace-scoped RLS transaction,
   * so it can read/write across workspaces. Absent/false ⇒ workspace-
   * isolated (the default). See RoleToolDefinition.crossWorkspace.
   */
  crossWorkspace?: boolean;
  /**
   * EI-18808330244321407: explicit opt-in for a handler that reads `ctx.tx`.
   * Absent/false means the handler is transaction-free; the host may still use
   * a short transaction for principal synthesis and commit it before dispatch.
   */
  needsWorkspaceTx?: boolean;
  /** @deprecated Transaction-free is now the default; retained for legacy plugin compatibility only. */
  skipWorkspaceTx?: boolean;
  /**
   * EI-19386201256023240: read by the HTTP host's `tools/call` result path —
   * when set, this tool's result SKIPS the per-result "door" (`result-door.ts`'s
   * `applyResultDoor`) entirely, even when the serialized text exceeds the
   * budget. The value is the REASON, which additionally decides whether prose
   * may be appended to the body at all — see `ResultDoorSkipReason` for why that
   * must not collapse back into a boolean (WI-37843).
   */
  skipResultDoor?: ResultDoorSkipReason;
  /**
   * WI-37843: per-tool override of the payload-tier hard ceiling, read where
   * `applyPayloadTier` is invoked. See `RoleToolDefinition.payloadTierCeilingChars`.
   */
  payloadTierCeilingChars?: number;
  /**
   * WI-37843: this tool opts out of routine per-session tier shaping, read
   * where `resolvePayloadTier` is invoked. Its shapers stay declared and still
   * serve as the hard-ceiling degradation path.
   * See `RoleToolDefinition.ignoreSessionPayloadTier`.
   */
  ignoreSessionPayloadTier?: boolean;
  /**
   * Surfaces this tool is meaningful from. Phase 4 T3.1. The prompt-
   * assembly catalog renderer filters by the caller's modality so
   * voice surfaces only see voice-capable tools. Absent → callers
   * treat it as "both surfaces" so legacy tools surface in either
   * catalog without an explicit opt-in. Use ['text'] or ['voice']
   * when a tool genuinely doesn't make sense in the other surface
   * (e.g. chat:ask_choice renders clickable buttons that are
   * invisible to a voice user).
   */
  modality?: ReadonlyArray<'text' | 'voice'>;
  /**
   * Profile gate. Controls which caller profile sees this tool in
   * `tools/list` and can invoke it via `tools/call`.
   *
   * - `'engineer'` — Papercusp-engineer/operator profile only. Hidden
   *   from `?profile=power` (power-engineer-on-any-harness) sessions.
   *   Group A tools (harness:*, operator:*, features:*, etc.) carry
   *   this tag. Default for new tools if uncertain.
   * - `'all'` (or omitted) — visible to every profile. Group B + C.
   *
   * Absent / undefined → treated as `'all'` for backward compatibility:
   * existing tools with no profile field remain visible until explicitly
   * tagged. New tools should always set this field.
   *
   * See: apps/operator/docs/plans/omp-profile-system-2026-05-24.md
   */
  profile?: 'engineer' | 'all';
  /**
   * Harness-scope requirement (su-prompt-audit-fixes P-020 / D-007).
   *
   * - `'required'` — the tool needs a resolved harness in `ctx.harnessSlug`
   *   (a non-wildcard slug). The dispatcher's `harness-check` step returns a
   *   uniform `harness_required` error when it's absent or `'*'`, replacing
   *   the per-handler grab-bag (harness_not_registered / require-slug /
   *   primary-fallback / stub). Intended for CTX-ONLY tools (no slug arg);
   *   tools that accept an explicit slug self-resolve and stay `'optional'`.
   * - `'optional'` (or absent) — no gate; the handler resolves a harness
   *   from an arg and/or `ctx.harnessSlug` as it sees fit. Default.
   * - `'none'` — the tool is harness-agnostic. Informational; no gate.
   *
   * The gate fails closed even for superuser/power callers (it's a functional
   * requirement, not a permission) — see `GateBypass.papercusp`.
   */
  harness?: 'required' | 'optional' | 'none';
  /**
   * State-shaped tool schema (bespoke-card-improvements #1 / T4.3).
   *
   * When set, the tool is on the STATE channel: it publishes its
   * current snapshot via `ctx.publishState(snapshot)`, and clients
   * reconnecting receive the latest snapshot rather than an event-
   * history replay. State-shaped tools opt OUT of the replay ring
   * buffer (M5 — declared at register time, no per-call branch).
   *
   * Reconnect semantics fall out for free: state outlives any single
   * connection while the run is open (5-min retention after run-end).
   * This is what absorbs the original T4.3 "long-lived disconnected"
   * design — declare a state schema and reconnect-resilience is
   * automatic.
   *
   * v1 ships SNAPSHOT-ONLY publishState. JSON Patch deltas are
   * deferred to v1.1 once we measure snapshot-only perf on real tools.
   *
   * Any Standard Schema validator (P-020); the snapshot is validated via
   * `~standard.validate` at `ctx.publishState` time.
   */
  state?: StandardSchemaV1;
  /**
   * Output-`data` schema (token-efficient-tool-result-formats D-003). The raw
   * Standard-Schema validator a tool declared for its `ToolResponse.data`.
   * Source for runtime output validation + `structuredContent`. Absent when the
   * tool declared none (it still gets the TOON runtime auto-encoder).
   */
  outputSchema?: StandardSchemaV1;
  /**
   * JSON-Schema projection of `outputSchema`, computed once at register time.
   * Advertised as MCP `outputSchema` in `tools/list` (P-010); also the input to
   * the eligibility walk below.
   */
  outputJsonSchema?: Record<string, unknown>;
  /**
   * Precomputed format eligibility for the output `data` shape (D-004): the set
   * of formats the result can be rendered in + the best compact default. Read
   * by the result serializer on every call and advertised in `tools/list`.
   * Absent ⇒ no output schema ⇒ the serializer uses the runtime auto-encoder.
   */
  resultEligibility?: EligibilityResult;
  /**
   * Tool-result freshness capability. Transport clients that own a cursor/base
   * cache (or a safe proxy that reconstructs a full result for generic clients)
   * read this registry metadata to decide whether they can negotiate `_meta.delta`
   * without a brittle per-tool side table.
   */
  delta?: DeltaCapability;
  /**
   * Typed event channel — Zod schemas keyed by event name. Surfaced
   * via tools/list as JSON-Schema for client discovery. No runtime
   * validation of outgoing events (trusted code path). Undefined for
   * tools that don't stream typed events; they may still call
   * `ctx.progress` (the alias) which goes through the 'progress' wire
   * event reserved for that purpose.
   *
   * Plugins declaring this on their JSON manifest go through
   * `eventsJsonSchema` below — the plugin loader populates that
   * field after validating the JSON-Schema subset (T3.2).
   */
  events?: EventsSchema;
  /**
   * Plugin-side event schemas declared as raw JSON-Schema. Used by
   * plugin tools that ship their `papercusp.json` manifest with an
   * `events` block. The plugin loader validates against the
   * supported subset (`packages/agent-mcp/src/plugin-events.ts`),
   * classifies wire kinds, and populates this field alongside the
   * computed `eventWireKinds`. Built-in tools (via `defineTool`)
   * use `events` (Zod) above; the two fields are mutually exclusive.
   * Phase 4 T3.2.
   */
  eventsJsonSchema?: Record<string, Record<string, unknown>>;
  /**
   * Per-event wire classification — `'string'` for z.string() schemas
   * (raw text on SSE), `'json'` for everything else. Computed once at
   * register time from `events` OR `eventsJsonSchema`; cached so
   * emit-time is constant-cost. Absent when neither is declared.
   */
  eventWireKinds?: Record<string, EventWireKind>;
  /** Where to project this function — at least one of http/mcp required. */
  expose: ToolExposure;
  /** The function. Source of truth. */
  fn: ToolFn;
  /**
   * Per-tool guidance for system-prompt assembly + `agent_tools:list`
   * introspection. Plumbed from `defineTool({ guidance })` (or the
   * plugin SDK's same slot). See `ToolGuidance` in types.ts.
   *
   * Shape mirrors `ToolGuidance` but without a `byRole` type-import to
   * keep this module free of role-enum imports. Plumbed-through opaque.
   * `seeAlso` (result-aware cross-links) is read at dispatch time — see
   * `applySeeAlso` in `./see-also`.
   */
  guidance?: {
    when?: string;
    notWhen?: string;
    chaining?: string;
    /**
     * Free-text description of the tool's RESPONSE shape (EI-10882), e.g.
     * "{ results: [{ id, title }], count }". Surfaced by `tools:find` and — since
     * EI-13298 — by `code:tools` / `code:run`'s facade signatures, so a script author
     * sees the real response shape instead of guessing keys. Was already plumbed
     * through at runtime via `defineTool({ guidance })` before this field existed on
     * this type (callers used to `as { returns?: string }` cast it); declared here now
     * so every consumer gets it typed, not just the one that cast around the gap.
     */
    returns?: string;
    /** Authored rejected-key → canonical field/tool correction map. */
    argRedirects?: Record<string, ProjectedToolArgRedirect>;
    seeAlso?: import('./see-also').SeeAlso;
    /**
     * Base-rate stamp (EI-19375528138828761) — resolved from the ACTUAL result
     * at dispatch and rendered uniformly (`_meta._denominator` + a one-line
     * "Denominator:" block), so a filtered slice is never read as a census.
     * Applied by `applyDenominator` in `./denominator`.
     */
    denominator?: import('./denominator').DenominatorSpec;
    byRole?: Record<string, { when?: string; notWhen?: string; chaining?: string }>;
  };
}

export interface ProjectedToolCorrectiveCall {
  tool: string;
  args: Record<string, unknown>;
  note?: string;
}

/** Authored invalid-input remedy for a key with no replacement destination. */
export interface ProjectedToolDrop {
  drop: true;
  note: string;
}

export type ProjectedToolArgRedirect =
  | string
  | ProjectedToolCorrectiveCall
  | ProjectedToolDrop;

export interface ValidatedProjectedToolCorrectiveCall extends ProjectedToolCorrectiveCall {
  rejectedArg: string;
  source: typeof PROJECTED_TOOL_REGISTRY_SOURCE;
  registryRevision: string;
  rendered: string;
}

/* ─── Registry ───────────────────────────────────────────────────────── */

// Pinned through `pinModuleState` so multiple module instances (Next standalone +
// Turbopack chunking sometimes resolves @papercusp/agent-mcp into more
// than one CJS instance — e.g. one for app routes, one for plugin-loader's
// dynamic import) share a single registry. Without this, plugin-loader's
// `registerProjectedTool(...)` writes to instance A's Map while
// `/api/plugins/tools` reads instance B's Map, and plugin tools appear to
// register but are never reachable. Bug regressed twice before this
// comment landed; please don't switch back without solving the
// module-instance-singleton story first.
//
// This was a hand-rolled `globalThis[key]` pair until EI-19479108855357092. The
// correctness story is unchanged — the primitive pins to the same one-per-realm
// slot — but a hand-rolled key is invisible to `listModuleDuplications()`, so a
// re-split here used to be undiscoverable centrally. Do NOT reintroduce the
// hand-rolled form: `npm run lint:no-hand-rolled-module-pin` fails on it.
interface RegistryStore {
  REGISTRY: Map<string, ProjectedTool>;
  BY_MCP_NAME: Map<string, ProjectedTool>;
  BY_HTTP_PATH: Map<string, ProjectedTool>;
  /**
   * EI-20803112372029993 — declared payload shapers, by tool name.
   *
   * `shape` is closed over by the dispatch handler and never reaches
   * `ProjectedTool` (it holds functions; the projection is serialized into
   * prompts and catalogs). Without a registry there is no way to ASK the
   * catalog "which tools rebuild their rows at the trimmed tier", so the
   * contract check could only ever run against a hand-typed list of tools —
   * which rots exactly like the allowlists it exists to police.
   *
   * Rides the registry store that is already pinned to globalThis rather than
   * adding a second pin (a new hand-rolled one would fail
   * `lint:no-hand-rolled-module-pin`, and a split here would under-report).
   */
  SHAPERS: Map<string, { shape: PayloadShapers; returns?: string }>;
  /** Mutation epoch + cached executable-contract revision (shared across module instances). */
  CONTRACT_EPOCH?: number;
  CONTRACT_REVISION_CACHE?: { epoch: number; revision: string };
}
const __PAPERCUSP_PROJECTED_TOOL_REGISTRY = '__papercuspProjectedToolRegistry';
const REGISTRY_STORE = pinModuleState<RegistryStore>(
  __PAPERCUSP_PROJECTED_TOOL_REGISTRY,
  () => ({
    REGISTRY: new Map<string, ProjectedTool>(),
    BY_MCP_NAME: new Map<string, ProjectedTool>(),
    BY_HTTP_PATH: new Map<string, ProjectedTool>(),
    SHAPERS: new Map<string, { shape: PayloadShapers; returns?: string }>(),
    CONTRACT_EPOCH: 0,
  }),
);
const REGISTRY = REGISTRY_STORE.REGISTRY;
const BY_MCP_NAME = REGISTRY_STORE.BY_MCP_NAME;
const BY_HTTP_PATH = REGISTRY_STORE.BY_HTTP_PATH;
// A store pinned before this field existed has no SHAPERS map (an older module
// record can win the pin race above and seed the slot without it). Backfill
// rather than letting `.set` throw on undefined — an absent map must degrade to
// "nothing recorded", never to a crash at import time.
const SHAPERS = (REGISTRY_STORE.SHAPERS ??= new Map<
  string,
  { shape: PayloadShapers; returns?: string }
>());

function invalidateProjectedToolContract(): void {
  REGISTRY_STORE.CONTRACT_EPOCH = (REGISTRY_STORE.CONTRACT_EPOCH ?? 0) + 1;
  REGISTRY_STORE.CONTRACT_REVISION_CACHE = undefined;
}

/**
 * Record a tool's declared payload shapers. Called by `defineTool`; the shapers
 * are otherwise unreachable from the catalog (see `RegistryStore.SHAPERS`).
 */
export function recordToolShapers(
  name: string,
  shape: PayloadShapers | undefined,
  returns?: string,
): void {
  if (!shape) return;
  SHAPERS.set(name, { shape, returns });
}

/** Every tool that declared payload shapers, with its `guidance.returns` prose. */
export function listDeclaredToolShapers(): ReadonlyArray<{
  name: string;
  shape: PayloadShapers;
  returns?: string;
}> {
  return [...SHAPERS.entries()].map(([name, v]) => ({ name, ...v }));
}

/** Stable unique key for a tool entry. */
function entryKey(tool: ProjectedTool): string {
  // Prefer mcp.name; fall back to http.path; last resort plugin/<idx>.
  if (tool.expose.mcp?.name) return `mcp:${tool.expose.mcp.name}`;
  if (tool.expose.http?.path) return `http:${tool.expose.http.path}`;
  return `${tool.pluginName}:?`;
}

export class ToolRegistrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolRegistrationError';
  }
}

/**
 * Structural fingerprint of a projected tool — stable across a re-import of
 * the SAME source (HMR / double-import re-eval produces a fresh object that
 * is structurally identical), but distinct for two genuinely different
 * tools. Used to tell a benign re-registration from a silent name-collision
 * between different tools.
 *
 * Why this exists (EI-14): the same-name guards below only fired when the
 * `pluginName` differed. Every built-in `defineTool` tool registers under
 * one synthetic plugin (`agent-mcp`), so two STRUCTURALLY-DIFFERENT built-ins
 * that shared an MCP name slipped past the cross-plugin check and the later
 * import silently replaced the earlier one (`BY_MCP_NAME.set`) with no error.
 * That dropped a real tool on the floor with zero signal: it's how
 * coordination-ops' bare `coord:ask` shadowed coordination-conversations'
 * knowledge-first `coord:ask` in prod while every role prompt still described
 * the knowledge-first one. Comparing this signature lets a same-namespace
 * duplicate-name bug fail loud instead of silently dropping a tool.
 */
function projectedToolSignature(tool: ProjectedTool): string {
  return JSON.stringify({
    description: tool.description ?? '',
    capabilities: [...(tool.capabilities ?? [])].sort(),
    inputSchema: tool.inputSchema ?? null,
    discoveryInputSchema: tool.discoveryInputSchema ?? null,
  });
}

/**
 * Fail loud when `prior` and `tool` claim the same name/path within ONE
 * plugin namespace but are structurally different tools (EI-14). A
 * structurally-identical re-registration (HMR / double-import) is the
 * benign case and returns silently so the caller replaces as before.
 */
function assertNotShadowingCollision(
  kind: 'MCP tool name' | 'HTTP path',
  key: string,
  prior: ProjectedTool,
  tool: ProjectedTool,
): void {
  if (prior === tool) return;
  if (projectedToolSignature(prior) === projectedToolSignature(tool)) return;
  throw new ToolRegistrationError(
    `${kind} "${key}" registered twice within plugin "${tool.pluginName}" by two DIFFERENT tools — ` +
      `the second silently shadows the first (last import wins), so a real tool would vanish with no error. ` +
      `Rename one: two distinct tools cannot share a name. ` +
      `prior description: ${JSON.stringify((prior.description ?? '').slice(0, 100))}; ` +
      `new description: ${JSON.stringify((tool.description ?? '').slice(0, 100))}.`,
  );
}

/**
 * Register a projected tool. Validates the manifest:
 *   - At least one of `expose.http` / `expose.mcp` must be set.
 *   - `expose.mcp.name` must use dotted naming and be unique across the
 *     registry.
 *   - `expose.http.path` must be unique across the registry.
 */
export function registerProjectedTool(tool: ProjectedTool): void {
  if (!tool.expose.http && !tool.expose.mcp) {
    throw new ToolRegistrationError(
      `tool from plugin "${tool.pluginName}" must declare at least one of expose.http / expose.mcp`,
    );
  }
  // Reject reserved event names at register time. The compile-time
  // UserEvents<T> guard catches them in TS for built-ins, but plugins
  // bypass TS via JSON manifests — this is the runtime backstop.
  // Phase 4 T2.3 (built-ins) + T3.2 (plugin manifests).
  const declaredEventNames: string[] = [
    ...(tool.events ? Object.keys(tool.events) : []),
    ...(tool.eventsJsonSchema ? Object.keys(tool.eventsJsonSchema) : []),
  ];
  for (const name of declaredEventNames) {
    if (RESERVED_EVENT_NAMES.includes(name as ReservedEventNames)) {
      throw new ToolRegistrationError(
        `tool "${tool.expose.mcp?.name ?? tool.expose.http?.path}" declared the reserved event name "${name}". ` +
          `Reserved names (auto-emitted by the framework): ${RESERVED_EVENT_NAMES.join(', ')}.` +
          (name === 'chunk' ? ' Declare `largeOutput: true` instead and return outputRef from the handler.' : ''),
      );
    }
  }
  // Reject conflicting declarations — a tool must use ONE of the two
  // event-schema forms, not both.
  if (tool.events && tool.eventsJsonSchema) {
    throw new ToolRegistrationError(
      `tool "${tool.expose.mcp?.name ?? tool.expose.http?.path}" declared both \`events\` (Zod) AND \`eventsJsonSchema\` (plugin JSON). Use one — built-ins via defineTool use Zod; plugin manifests use JSON-Schema.`,
    );
  }
  // Pre-classify event wire kinds so emit-time is constant-cost.
  // Caller might set eventWireKinds explicitly (some tests do, and
  // the plugin loader does after running validateAndClassifyPluginEvents);
  // only compute when absent.
  if (tool.events && !tool.eventWireKinds) {
    const kinds: Record<string, EventWireKind> = {};
    for (const [name, schema] of Object.entries(tool.events)) {
      kinds[name] = classifyEventWire(schema);
    }
    tool.eventWireKinds = kinds;
  }
  if (tool.expose.mcp) {
    const name = tool.expose.mcp.name;
    // Require a namespace separator (dot or colon) to prevent collisions
    // with bare names. Both conventions in use:
    //   - dotted (plugin tools, our preference): 'repomix.pack'
    //   - colon (built-in agent-mcp tools): 'tasks:list', 'audit:list'
    if (!name || (!name.includes('.') && !name.includes(':'))) {
      throw new ToolRegistrationError(
        `MCP tool name "${name}" must include a namespace separator ("." or ":") — e.g. "${tool.pluginName.replace(/^@.*\//, '')}.verb"`,
      );
    }
    const prior = BY_MCP_NAME.get(name);
    if (prior && prior.pluginName !== tool.pluginName) {
      throw new ToolRegistrationError(
        `MCP tool name "${name}" claimed by plugins "${prior.pluginName}" and "${tool.pluginName}"`,
      );
    }
    if (prior) assertNotShadowingCollision('MCP tool name', name, prior, tool);
    BY_MCP_NAME.set(name, tool);
  }
  if (tool.expose.http) {
    const p = tool.expose.http.path;
    if (!p.startsWith('/')) {
      throw new ToolRegistrationError(`HTTP path "${p}" must start with "/"`);
    }
    const prior = BY_HTTP_PATH.get(p);
    if (prior && prior.pluginName !== tool.pluginName) {
      throw new ToolRegistrationError(
        `HTTP path "${p}" claimed by plugins "${prior.pluginName}" and "${tool.pluginName}"`,
      );
    }
    if (prior) assertNotShadowingCollision('HTTP path', p, prior, tool);
    BY_HTTP_PATH.set(p, tool);
  }
  REGISTRY.set(entryKey(tool), tool);
  invalidateProjectedToolContract();
}

/**
 * Remove all entries for a plugin from the registry. Used by the host's
 * `/api/plugins/host/refresh` flow so re-discovery can re-register without
 * tripping the cross-plugin name-collision guard against its own prior
 * entries.
 */
export function unregisterProjectedToolsForPlugin(pluginName: string): number {
  let removed = 0;
  for (const [k, t] of Array.from(REGISTRY.entries())) {
    if (t.pluginName === pluginName) {
      // EI-20803112372029993: drop the plugin's declared shapers too, and do it
      // HERE — the entry is gone from REGISTRY by the end of this loop, so a
      // later pass over it would find nothing and silently leak. Tool names are
      // unique across the registry, so deleting by name cannot reach a core tool;
      // leaving them behind would let the contract check report a violation
      // against a tool that is no longer loaded.
      if (t.expose.mcp?.name) SHAPERS.delete(t.expose.mcp.name);
      REGISTRY.delete(k);
      removed++;
    }
  }
  for (const [k, t] of Array.from(BY_MCP_NAME.entries())) {
    if (t.pluginName === pluginName) BY_MCP_NAME.delete(k);
  }
  for (const [k, t] of Array.from(BY_HTTP_PATH.entries())) {
    if (t.pluginName === pluginName) BY_HTTP_PATH.delete(k);
  }
  if (removed > 0) invalidateProjectedToolContract();
  return removed;
}

/** Look up by MCP name (e.g. 'repomix.pack') — EXACT match only. */
export function lookupByMcpName(name: string): ProjectedTool | undefined {
  return BY_MCP_NAME.get(name);
}

/**
 * Normalize an MCP tool name for TOLERANT resolution: strip a client's
 * `mcp__<server>__` advertisement wrapper, then collapse every separator
 * (`:` `_` `.` `-`) to one. So the canonical registered name
 * (`curation:state-of-pot`), the underscore/group_verb form
 * (`curation_state-of-pot`), and the fully client-mangled form
 * (`mcp__papercusp-su__curation_state-of-pot`) all reduce to ONE key.
 *
 * This is the single source of truth for tool-name normalization — operator-
 * core's unknown-tool suggestion path aliases to it, so a SUGGESTED name and a
 * RESOLVED name can never disagree (the drift that would make "did you mean X?"
 * point at a name that then fails to resolve).
 */
export function normalizeMcpName(name: string): string {
  return name
    .toLowerCase()
    .replace(/^mcp__[^_]+(?:[^_]|_(?!_))*__/, '') // mcp__<server>__<tool> → <tool>
    .replace(/[:_.\-]+/g, ':');
}

/**
 * Resolve an MCP tool name TOLERANTLY (WI-3930). Exact registered name first —
 * the fast, unchanged path that every canonical (colon-form) call takes. Only
 * on an exact miss does it fall back to a NORMALIZED match, which accepts the
 * underscore/group_verb and fully-mangled forms an agent naturally copies from
 * its own advertised tool list (`mcp__papercusp-su__curation_state-of-pot`) or
 * from a hook/error string. The docs tell agents to fall back to
 * `tools:invoke { name }` with the colon-form name; this makes that fallback
 * also accept the other two forms, so a single paste resolves instead of
 * costing a wasted unknown-tool round-trip.
 *
 * The normalized fallback resolves ONLY when it is UNAMBIGUOUS — exactly one
 * registered tool normalizes to the requested key. If two do (a real name
 * collision under separator-folding), it returns undefined so the caller
 * surfaces the honest unknown-tool / disambiguation path rather than silently
 * guessing one. A genuine typo (`curatoin:state-of-pot`) normalizes to a key no
 * tool matches → undefined, exactly as before.
 */
export function resolveMcpName(name: string): ProjectedTool | undefined {
  const exact = BY_MCP_NAME.get(name);
  if (exact) return exact;
  const norm = normalizeMcpName(name);
  if (!norm) return undefined;
  let hit: ProjectedTool | undefined;
  for (const [registered, tool] of BY_MCP_NAME) {
    if (normalizeMcpName(registered) === norm) {
      if (hit && hit !== tool) return undefined; // ambiguous → don't guess
      hit = tool;
    }
  }
  return hit;
}

/** How {@link resolveMcpNameTagged} found (or failed to find) a tool. */
export type McpNameResolution =
  /** the registered name, verbatim */
  | 'exact'
  /** case / separator / `mcp__<server>__` fold — a formatting difference only (D-004) */
  | 'canonical'
  /** typo recovery (D-005/D-006) — the caller MUST annotate this on its reply (D-008) */
  | 'fuzzy';

export interface ResolveMcpNameOptions {
  /**
   * D-009: which registered tools this caller can actually dispatch. The fuzzy stage only
   * proposes / resolves to tools this returns true for, so a "did you mean" never points at a
   * tool the caller is not allowed to see. Defaults to every registered tool.
   */
  readonly visible?: (tool: ProjectedTool) => boolean;
  /** D-007: capability tier of a registered name; `'high'` is never fuzzy-resolved. */
  readonly tierOf?: (mcpName: string) => string | undefined;
  /**
   * D-007: extra never-fuzzy predicate. Defaults to "the tool declares `effect: 'write'`" —
   * catalog tiers are capability-based (a `flags:set` can be `medium`), so tier alone would let
   * a typo dispatch a mutation. Pass `() => false` to opt out.
   */
  readonly neverFuzzy?: (tool: ProjectedTool) => boolean;
  /** Calibrated `{ T, M }`; defaults to {@link DEFAULT_RESOLVE_PARAMS}. */
  readonly params?: MatchParams;
}

export interface ResolvedMcpName {
  /** The tool to dispatch. Absent on a miss, an ambiguity, or a withheld (blocked) fuzzy hit. */
  readonly tool?: ProjectedTool;
  /** How `tool` was found; absent when nothing resolved. */
  readonly via?: McpNameResolution;
  /** The name the caller sent, verbatim — what a `via:'fuzzy'` annotation reports as "you sent". */
  readonly input: string;
  /** The canonical registered name that was resolved to (or, when blocked, the closest one). */
  readonly resolvedName?: string;
  /** Raw edit count for a fuzzy hit; 0 for exact/canonical. */
  readonly distance?: number;
  /** >=2 plausible tools too close to call — never guess. */
  readonly ambiguous?: boolean;
  /** The single best fuzzy hit was withheld by the D-007 gate. */
  readonly blocked?: boolean;
  /** "Did you mean" material (canonical names), best first. Empty when nothing is close. */
  readonly alternatives: readonly string[];
}

/**
 * Tolerant lookup with TYPO recovery (plan fuzzy-tool-name-resolution-2026-07-02, P-005).
 *
 * The tagged sibling of {@link resolveMcpName}, NOT a change to it: `resolveMcpName` stays
 * canonical-only because several callers (identity-grants port, sibling-arg owner lookup,
 * source-file lookup) derive AUTHORITY or attribution from the resolved tool and must never
 * act on a guess. A dispatch seam that wants typo recovery calls this instead, and is then
 * obliged to surface `via:'fuzzy'` to its caller (D-008 — that is P-006).
 *
 * Stages, miss-path only (D-003): exact registered name → canonical fold (unambiguous only,
 * exactly as `resolveMcpName`) → fuzzy over the caller-visible candidate set. An ambiguous
 * canonical fold is returned as ambiguous and NEVER falls through to fuzzy.
 */
export function resolveMcpNameTagged(name: string, opts: ResolveMcpNameOptions = {}): ResolvedMcpName {
  const exact = BY_MCP_NAME.get(name);
  if (exact && (opts.visible?.(exact) ?? true)) {
    return { tool: exact, via: 'exact', input: name, resolvedName: name, distance: 0, alternatives: [name] };
  }
  const visible = (t: ProjectedTool): boolean => opts.visible?.(t) ?? true;
  const norm = normalizeMcpName(name);
  if (!norm) return { input: name, alternatives: [] };

  // Stage 1 — canonical fold (identical semantics to resolveMcpName, over the visible set).
  let hit: { name: string; tool: ProjectedTool } | undefined;
  let ambiguous = false;
  for (const [registered, tool] of BY_MCP_NAME) {
    if (!visible(tool)) continue;
    if (normalizeMcpName(registered) === norm) {
      if (hit && hit.tool !== tool) ambiguous = true;
      else hit = { name: registered, tool };
    }
  }
  if (ambiguous) return { input: name, ambiguous: true, alternatives: [], };
  if (hit) {
    return { tool: hit.tool, via: 'canonical', input: name, resolvedName: hit.name, distance: 0, alternatives: [hit.name] };
  }

  // Stage 2 — fuzzy over the visible candidate set.
  const byName = new Map<string, ProjectedTool>();
  for (const [registered, tool] of BY_MCP_NAME) if (visible(tool)) byName.set(registered, tool);
  const neverFuzzy = opts.neverFuzzy ?? ((t: ProjectedTool) => t.effect === 'write');
  const r = resolveToolName(name, Array.from(byName.keys()), {
    ...(opts.params ?? DEFAULT_RESOLVE_PARAMS),
    tierOf: opts.tierOf,
    neverFuzzy: (n) => {
      const t = byName.get(n);
      return t !== undefined && neverFuzzy(t);
    },
  });
  const resolvedName = r.match ?? r.alternatives[0];
  if (r.match) {
    const tool = byName.get(r.match);
    if (tool) {
      return {
        tool,
        via: r.via === 'canonical' ? 'canonical' : 'fuzzy',
        input: name,
        resolvedName: r.match,
        distance: r.distance,
        alternatives: r.alternatives,
      };
    }
  }
  return {
    input: name,
    ...(resolvedName !== undefined ? { resolvedName } : {}),
    ...(r.distance !== undefined ? { distance: r.distance } : {}),
    ...(r.ambiguous ? { ambiguous: true } : {}),
    ...(r.blocked ? { blocked: true } : {}),
    alternatives: r.alternatives,
  };
}

/** Look up by HTTP path (e.g. '/api/plugins/repomix/pack'). */
export function lookupByHttpPath(path: string): ProjectedTool | undefined {
  return BY_HTTP_PATH.get(path);
}

/** Snapshot of all registered projected tools. */
export function listAllProjectedTools(): readonly ProjectedTool[] {
  return Array.from(REGISTRY.values());
}

/**
 * The absolute file that defined `toolName` (its MCP-exposed name, e.g.
 * `improvements:capture`), or `null` when the tool is unknown, was registered
 * without a readable call stack, or has no defining module at all.
 *
 * Three-valued by omission on purpose: `null` means UNKNOWN, never "this tool
 * has no source". A caller that treats a null as a negative verdict would turn
 * an unreadable stack into a confident claim about the code — the same
 * absence-reads-as-positive failure `candidate-contains.ts` is built to avoid.
 */
export function projectedToolSourceFile(toolName: string): string | null {
  // Tolerant on purpose: a caller reporting a tool failure copies whatever
  // spelling it saw — the canonical colon form from the docs, the underscore
  // form, or its client's fully-mangled `mcp__<server>__<verb>` id. resolveMcpName
  // accepts all three and returns undefined rather than guessing when a
  // normalized name is ambiguous.
  return resolveMcpName(toolName)?.sourceFile ?? null;
}

/**
 * The bundled definition site of `toolName` — the frames' positions in the one file
 * a bundle put both this library and the tool into — or `null` when the tool is
 * unknown or was not defined inside a bundle. Same tolerant name resolution as
 * {@link projectedToolSourceFile}; a host resolves the site to a module path.
 */
export function projectedToolBundledDefinitionSite(toolName: string): BundledDefinitionSite | null {
  return resolveMcpName(toolName)?.bundledDefinitionSite ?? null;
}

/**
 * Stable content revision for the executable MCP contract.
 *
 * The registry is the authority for names, accepted argument shapes, and
 * client/role visibility. Every agent-facing projection carries this same
 * revision so callers can detect guidance produced from a different contract.
 * Registration order is deliberately excluded; executable content is not.
 */
export const PROJECTED_TOOL_REGISTRY_SOURCE = 'projected-tool-registry' as const;

export function projectedToolRegistryRevision(
  tools?: readonly Pick<
    ProjectedTool,
    | 'expose'
    | 'description'
    | 'inputSchema'
    | 'discoveryInputSchema'
    | 'outputJsonSchema'
    | 'agentRoles'
    | 'profile'
    | 'modality'
    | 'guidance'
  >[],
): string {
  if (!tools) {
    const epoch = REGISTRY_STORE.CONTRACT_EPOCH ?? 0;
    const cached = REGISTRY_STORE.CONTRACT_REVISION_CACHE;
    if (cached?.epoch === epoch) return cached.revision;
    const revision = projectedToolRegistryRevision(listAllProjectedTools());
    REGISTRY_STORE.CONTRACT_REVISION_CACHE = { epoch, revision };
    return revision;
  }
  const canonical = (value: unknown): string => {
    if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    const row = value as Record<string, unknown>;
    return `{${Object.keys(row)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(row[key])}`)
      .join(',')}}`;
  };
  const contracts = tools
    .flatMap((tool) => {
      const name = tool.expose.mcp?.name;
      if (!name) return [];
      return [{
        name,
        description: tool.description,
        inputSchema: tool.discoveryInputSchema ?? tool.inputSchema,
        outputJsonSchema: tool.outputJsonSchema ?? null,
        agentRoles: [...(tool.agentRoles ?? [])].sort(),
        profile: tool.profile ?? 'all',
        modality: [...(tool.modality ?? ['text', 'voice'])].sort(),
        guidance: {
          when: tool.guidance?.when ?? null,
          notWhen: tool.guidance?.notWhen ?? null,
          chaining: tool.guidance?.chaining ?? null,
          returns: tool.guidance?.returns ?? null,
          argRedirects: tool.guidance?.argRedirects ?? {},
          byRole: tool.guidance?.byRole ?? {},
          // Function-form result links are runtime-only truth and cannot be
          // serialized into a stable catalog revision. Static links can and
          // should invalidate every cached guidance projection when changed.
          seeAlso: typeof tool.guidance?.seeAlso === 'function'
            ? 'runtime-resolved'
            : tool.guidance?.seeAlso ?? null,
        },
      }];
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  // Deterministic drift watermark, not a security primitive. FNV-1a avoids
  // making this generic registry module Node-crypto-specific; the shared
  // 16-bit-limb implementation is bit-exact with the former per-byte BigInt
  // loop, which was a main-thread hot spot (WI-10003260).
  return `projected-tool-registry-v1:${fnv1a64BytesHex(new TextEncoder().encode(canonical(contracts)))}`;
}

export interface ProjectedToolAvailability {
  role?: AgentRole;
  profile?: 'engineer' | 'power';
  modality?: 'text' | 'voice';
}

export interface ProjectedToolCallContract {
  source: typeof PROJECTED_TOOL_REGISTRY_SOURCE;
  revision: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  returns:
    | { source: 'registered-output-schema'; outputJsonSchema: Record<string, unknown> }
    | { source: 'authored-tool-guidance'; description: string }
    | { source: 'undeclared' };
  aliases: Record<string, { target: string; provenance: 'authored-tool-guidance' }>;
}

export class ProjectedToolContractError extends Error {
  override readonly name = 'ProjectedToolContractError';
}

function availabilityProblem(tool: ProjectedTool, context: ProjectedToolAvailability): string | null {
  if (context.role && tool.agentRoles && !tool.agentRoles.includes(context.role)) {
    return `role ${context.role} is not admitted`;
  }
  if (context.profile === 'power' && tool.profile === 'engineer') return 'power profile is not admitted';
  if (context.modality && !(tool.modality ?? ['text', 'voice']).includes(context.modality)) {
    return `modality ${context.modality} is not admitted`;
  }
  return null;
}

/**
 * Is this tool REGISTERED and admitted under `context` — asked WITHOUT throwing.
 *
 * The distinction this exists to draw: a redirect pointing at a tool that does not
 * exist is a registry defect and must fail render/CI loudly, but a tool that merely
 * is not admitted to the CURRENT role/profile/modality is an ordinary scoping fact.
 * A renderer that walks a role-independent tool list needs to tell those apart, and
 * `projectedToolCallContract` deliberately cannot — it throws for both.
 *
 * Returns false for an absent tool too, so a caller that wants the loud failure keeps
 * using the throwing form; this is only for "should I render this extra?" decisions.
 */
export function projectedToolAdmitted(
  name: string,
  context: ProjectedToolAvailability = {},
): boolean {
  const tool = lookupByMcpName(name);
  if (!tool?.expose.mcp) return false;
  return availabilityProblem(tool, context) === null;
}

/** Resolve one exact, currently callable registry contract or fail render/CI loudly. */
export function projectedToolCallContract(
  name: string,
  context: ProjectedToolAvailability = {},
): ProjectedToolCallContract {
  const tool = lookupByMcpName(name);
  if (!tool?.expose.mcp) throw new ProjectedToolContractError(`tool contract unavailable: ${name}`);
  const unavailable = availabilityProblem(tool, context);
  if (unavailable) throw new ProjectedToolContractError(`tool contract unavailable: ${name} (${unavailable})`);
  return {
    source: PROJECTED_TOOL_REGISTRY_SOURCE,
    revision: projectedToolRegistryRevision(),
    name,
    description: tool.description,
    inputSchema: tool.discoveryInputSchema ?? tool.inputSchema,
    returns: tool.outputJsonSchema
      ? { source: 'registered-output-schema', outputJsonSchema: tool.outputJsonSchema }
      : tool.guidance?.returns?.trim()
        ? { source: 'authored-tool-guidance', description: tool.guidance.returns.trim() }
        : { source: 'undeclared' },
    aliases: Object.fromEntries(
      Object.entries(tool.guidance?.argRedirects ?? {})
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
        .map(([key, target]) => [
        key,
        { target, provenance: 'authored-tool-guidance' as const },
        ]),
    ),
  };
}

type ContractSchema = Record<string, unknown>;

function contractProblems(schema: ContractSchema, value: unknown, path = '$'): string[] {
  const alternatives = Array.isArray(schema.anyOf)
    ? schema.anyOf
    : Array.isArray(schema.oneOf)
      ? schema.oneOf
      : null;
  if (alternatives) {
    const attempts = alternatives
      .filter((branch): branch is ContractSchema => !!branch && typeof branch === 'object' && !Array.isArray(branch))
      .map((branch) => contractProblems(branch, value, path));
    if (attempts.some((problems) => problems.length === 0)) return [];
    return attempts.sort((a, b) => a.length - b.length)[0] ?? [`${path}: no declared schema branch matched`];
  }
  if (Array.isArray(schema.allOf)) {
    return schema.allOf.flatMap((branch) =>
      branch && typeof branch === 'object' && !Array.isArray(branch)
        ? contractProblems(branch as ContractSchema, value, path)
        : [],
    );
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => Object.is(candidate, value))) {
    return [`${path}: ${JSON.stringify(value)} is not one of ${schema.enum.map(String).join('|')}`];
  }
  if ('const' in schema && !Object.is(schema.const, value)) return [`${path}: expected ${JSON.stringify(schema.const)}`];
  if (schema.type === 'object' || schema.properties) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [`${path}: expected object`];
    const row = value as Record<string, unknown>;
    const properties = schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)
      ? schema.properties as Record<string, unknown>
      : {};
    const problems: string[] = [];
    for (const key of Array.isArray(schema.required) ? schema.required : []) {
      if (typeof key === 'string' && !(key in row)) problems.push(`${path}.${key}: required`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(row)) if (!(key in properties)) problems.push(`${path}.${key}: undeclared key`);
    }
    for (const [key, child] of Object.entries(properties)) {
      if (!(key in row) || !child || typeof child !== 'object' || Array.isArray(child)) continue;
      problems.push(...contractProblems(child as ContractSchema, row[key], `${path}.${key}`));
    }
    return problems;
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) return [`${path}: expected array`];
    const item = schema.items;
    return item && typeof item === 'object' && !Array.isArray(item)
      ? value.flatMap((entry, index) => contractProblems(item as ContractSchema, entry, `${path}[${index}]`))
      : [];
  }
  if (schema.type === 'string' && typeof value !== 'string') return [`${path}: expected string`];
  if ((schema.type === 'number' || schema.type === 'integer') && typeof value !== 'number') return [`${path}: expected ${schema.type}`];
  if (schema.type === 'boolean' && typeof value !== 'boolean') return [`${path}: expected boolean`];
  if (schema.type === 'null' && value !== null) return [`${path}: expected null`];
  return [];
}

/** Validate a prompt/example call against the same accepted schema used for discovery. */
export function assertProjectedToolCallContract(
  name: string,
  args: unknown,
  context: ProjectedToolAvailability = {},
): ProjectedToolCallContract {
  const contract = projectedToolCallContract(name, context);
  const problems = contractProblems(contract.inputSchema, args);
  if (problems.length > 0) throw new ProjectedToolContractError(`invalid generated call for ${name}: ${problems.join('; ')}`);
  return contract;
}

/** Render an exact example only after registry/schema/admission conformance succeeds. */
export function renderProjectedToolCall(
  name: string,
  args: unknown,
  context: ProjectedToolAvailability = {},
): string {
  assertProjectedToolCallContract(name, args, context);
  return `${name} ${JSON.stringify(args)}`;
}

/** Return whether an authored redirect explicitly tells the caller to drop its key. */
export function isProjectedToolDrop(value: unknown): value is ProjectedToolDrop {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (value as { drop?: unknown }).drop === true
  );
}

/** Validate and render every structured rejected-arg remedy on one source tool. */
export function projectedToolCorrectiveCalls(
  name: string,
  context: ProjectedToolAvailability = {},
): ValidatedProjectedToolCorrectiveCall[] {
  projectedToolCallContract(name, context);
  const tool = lookupByMcpName(name)!;
  return Object.entries(tool.guidance?.argRedirects ?? {}).flatMap(([rejectedArg, redirect]) => {
    if (typeof redirect === 'string') return [];
    if (isProjectedToolDrop(redirect)) {
      if (typeof redirect.note !== 'string' || redirect.note.trim().length === 0) {
        throw new ProjectedToolContractError(
          `invalid drop redirect for ${name}.${rejectedArg}: note must be non-empty`,
        );
      }
      return [];
    }
    // A remedy this context cannot CALL is not offered to it (EI-22188204415833751). An
    // all-profile tool may legitimately redirect into a narrower one — coord:presence's
    // `fleet` -> fleet:assignments (profile:'engineer') — which is correct guidance for the
    // profiles that DO admit the target. Resolving it under a profile the TARGET rejects must
    // therefore NARROW this list, not fail the rail: _guidance-adapter.ts converts any throw
    // from here into `return []`, so one such redirect deletes the ENTIRE ~835-page guidance
    // corpus rather than omitting one entry, which red-pinned the fleet green-checkpoint gate.
    //
    // ONLY availability is skipped, and only when the target genuinely resolves. An unknown
    // target tool, a missing required key, a bad enum, or an undeclared key still throws — that
    // is the rail that caught the dev:restart enum placeholder (WI-2142574), and the tests at
    // 'fails structured corrective-call conformance on missing tools, required keys, enums, and
    // undeclared keys' hold it in place.
    const redirectTarget = lookupByMcpName(redirect.tool);
    if (redirectTarget?.expose.mcp && availabilityProblem(redirectTarget, context)) return [];
    const rendered = renderProjectedToolCall(redirect.tool, redirect.args, context);
    return [{
      rejectedArg,
      tool: redirect.tool,
      args: redirect.args,
      ...(redirect.note ? { note: redirect.note } : {}),
      source: PROJECTED_TOOL_REGISTRY_SOURCE,
      registryRevision: projectedToolRegistryRevision(),
      rendered,
    }];
  });
}

export interface ProjectedToolGuidanceConformance {
  source: typeof PROJECTED_TOOL_REGISTRY_SOURCE;
  registryRevision: string;
  toolsChecked: number;
  correctiveCallsChecked: number;
}

/**
 * CI/render rail for executable guidance. Every remedy OFFERED to a context must
 * satisfy the target's current required/enum/closed-object schema.
 *
 * Note the scope of "offered": a redirect whose TARGET is not admitted in a context is
 * withheld from that context rather than failing the rail (see projectedToolCorrectiveCalls),
 * so an all-profile tool may redirect into a narrower one without deleting the corpus. The
 * schema half is unconditional — an offered remedy that cannot validate is still fatal.
 */
export function assertProjectedToolGuidanceConformance(): ProjectedToolGuidanceConformance {
  let toolsChecked = 0;
  let correctiveCallsChecked = 0;
  for (const tool of listAllProjectedTools()) {
    const name = tool.expose.mcp?.name;
    if (!name) continue;
    const hasStructured = Object.values(tool.guidance?.argRedirects ?? {}).some(
      (redirect) => typeof redirect === 'object' && redirect !== null,
    );
    if (!hasStructured) continue;
    toolsChecked += 1;
    const roles: Array<AgentRole | undefined> = tool.agentRoles?.length ? [...tool.agentRoles] : [undefined];
    const profiles: Array<'engineer' | 'power'> = tool.profile === 'engineer'
      ? ['engineer']
      : ['engineer', 'power'];
    const modalities: Array<'text' | 'voice'> = [...(tool.modality ?? ['text', 'voice'])];
    for (const role of roles) {
      for (const profile of profiles) {
        for (const modality of modalities) {
          correctiveCallsChecked += projectedToolCorrectiveCalls(name, { role, profile, modality }).length;
        }
      }
    }
  }
  return {
    source: PROJECTED_TOOL_REGISTRY_SOURCE,
    registryRevision: projectedToolRegistryRevision(),
    toolsChecked,
    correctiveCallsChecked,
  };
}

/**
 * True if a tool declares ANY auth gate — a capability, an agent-role allowlist, an RBAC
 * role requirement, or an `authorize` hook. The single predicate behind both the
 * default-deny dispatch gate and `listUngatedProjectedTools` (RFC tooldef-auth Phase 3),
 * so the enforcement and the migration aid can't drift.
 */
export function toolDeclaresGate(
  tool: Pick<ProjectedTool, 'capabilities' | 'agentRoles' | 'requireRoles' | 'authorize'>,
): boolean {
  return (
    tool.capabilities.length > 0 ||
    (tool.agentRoles?.length ?? 0) > 0 ||
    (tool.requireRoles?.length ?? 0) > 0 ||
    !!tool.authorize
  );
}

/**
 * Tools that would be denied once `deps.defaultDeny` is flipped on: they declare no gate
 * and are not marked `public`. The migration aid for RFC tooldef-auth Phase 3 (§8 D1) —
 * run it (with the full tool registry loaded) BEFORE enabling default-deny, triage each
 * (declare a gate or mark `public`), then flip. Empty result = safe to flip.
 */
export function listUngatedProjectedTools(): readonly ProjectedTool[] {
  return Array.from(REGISTRY.values()).filter((t) => !t.public && !toolDeclaresGate(t));
}

/**
 * MCP-protocol tool listings, optionally filtered by calling role.
 * Returns only tools with `expose.mcp` set; tools that are HTTP-only are
 * invisible to the agent.
 *
 * The `events` field surfaces the tool's typed event vocabulary as
 * JSON-Schema entries — discoverable by any MCP client. This is the
 * Papercusp MCP extension that lets clients render typed event streams
 * (deltas, suggestions, etc.) without out-of-band knowledge of each
 * tool. Standard MCP clients that don't know about this field simply
 * ignore it.
 */
export interface McpToolListing {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /**
   * JSON-Schema for the tool's result `data` (MCP `outputSchema`, P-010).
   * Spec-aligned advertisement; present only when the tool declared an output
   * schema. Clients can validate `structuredContent` against it.
   */
  outputSchema?: Record<string, unknown>;
  /**
   * The token-efficient formats this tool's result can be rendered in
   * (token-efficient-tool-result-formats P-010 / D-005). A Papercusp extension
   * so a client knows which `_meta.format` values it may negotiate; absent ⇒
   * `['json']` (the always-available default). Also mirrored onto `_meta`
   * (`papercusp/resultFormats`) because the MCP SDK strips unknown TOP-LEVEL
   * tool fields during validation — `_meta` is the spec's passthrough slot, so
   * that copy is the one that actually reaches a strict client.
   */
  resultFormats?: ReadonlyArray<'json' | 'toon' | 'csv' | 'tsv' | 'md'>;
  /**
   * MCP `_meta` passthrough — survives strict SDK validation (unlike unknown
   * top-level fields). Carries `papercusp/resultFormats` (the capability set).
   */
  _meta?: Record<string, unknown>;
  /** Map of event-name → JSON-Schema. Absent when the tool declares no events. */
  events?: Record<string, Record<string, unknown>>;
  /**
   * Surfaces this tool is meaningful from. Absent → callers treat
   * it as `['text', 'voice']` so legacy tools surface in either
   * catalog. Phase 4 T3.1; clients can filter by their caller
   * modality.
   */
  modality?: ReadonlyArray<'text' | 'voice'>;
}

/**
 * Memoise the JSON-Schema serialization per ProjectedTool reference.
 * Same `events` object identity means same serialized output, so the
 * weak-keyed cache avoids re-running `z.toJSONSchema` on every
 * `tools/list` call.
 */
const EVENTS_JSON_CACHE = new WeakMap<EventsSchema, Record<string, Record<string, unknown>>>();

function serializeEventsSchema(events: EventsSchema): Record<string, Record<string, unknown>> {
  const cached = EVENTS_JSON_CACHE.get(events);
  if (cached) return cached;
  const out: Record<string, Record<string, unknown>> = {};
  for (const [name, schema] of Object.entries(events)) {
    const kind = classifyEventWire(schema);
    if (kind === 'binary') {
      // z.toJSONSchema throws on z.instanceof(Uint8Array) ("Custom types
      // cannot be represented in JSON Schema"). Surface binary events
      // explicitly so MCP clients can decode the EVENT_BIN wire frame.
      out[name] = {
        type: 'string',
        contentEncoding: 'base64',
        description: 'Binary payload — base64 over JSON transports; raw bytes over IPC EVENT_BIN.',
      };
      continue;
    }
    try {
      // Pluggable schema→JSON-Schema (P-021); default adapter is Zod 4's
      // toJSONSchema (zod-to-json-schema@3 returned empty schemas on zod 4).
      const json = toJsonSchema(schema);
      // Drop $schema — MCP clients don't need it and it's noise in tools/list.
      delete json.$schema;
      out[name] = json;
    } catch {
      // Any other unrepresentable schema (custom check, lazy refs to
      // self, etc.) → emit a permissive placeholder so tools/list never
      // 500s. The tool still works; clients just lose the typed view.
      out[name] = { description: 'Schema not representable in JSON Schema.' };
    }
  }
  EVENTS_JSON_CACHE.set(events, out);
  return out;
}

function isObjectTypedBranch(branch: unknown): boolean {
  return (
    branch !== null &&
    typeof branch === 'object' &&
    !Array.isArray(branch) &&
    (branch as Record<string, unknown>).type === 'object'
  );
}

/**
 * The MCP `outputSchema` for a tool's registered output JSON schema, or
 * `undefined` when its instances are not guaranteed to be JSON objects (the
 * spec requires `structuredContent` to be an object, and the SDK rejects a
 * tools/list whose outputSchema is not object-typed).
 *
 * An object-rooted schema passes through unchanged. A type-less root
 * `anyOf`/`oneOf` whose EVERY branch is object-typed — a union of object
 * results such as a `state`-discriminated union — always validates to an
 * object, so `type: 'object'` is hoisted onto the root. That is a pure
 * narrowing: every branch is preserved, nothing is merged or relaxed (unlike
 * `flattenForOpenAi`). Array/scalar roots, `$ref` branches and unions with any
 * non-object branch stay unadvertised, exactly as before.
 */
export function mcpObjectOutputSchema(
  schema: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!schema) return undefined;
  if (schema.type === 'object') return schema;
  if (schema.type !== undefined) return undefined;
  for (const key of ['anyOf', 'oneOf'] as const) {
    const branches = schema[key];
    if (Array.isArray(branches) && branches.length > 0 && branches.every(isObjectTypedBranch)) {
      return { type: 'object', ...schema };
    }
  }
  return undefined;
}

export function listMcpProjections(role?: AgentRole, profile?: 'engineer' | 'power'): McpToolListing[] {
  const out: McpToolListing[] = [];
  const registryRevision = projectedToolRegistryRevision();
  for (const tool of REGISTRY.values()) {
    if (!tool.expose.mcp) continue;
    if (role && tool.agentRoles && !tool.agentRoles.includes(role)) continue;
    // Profile gate: tools tagged `profile: 'engineer'` are hidden from
    // power-profile callers. Untagged tools (undefined / 'all') are visible
    // to everyone — backward-compatible for tools not yet tagged.
    // eslint-disable-next-line no-console
    if (profile === 'power' && tool.profile === 'engineer') continue;
    const listing: McpToolListing = {
      name: tool.expose.mcp.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      _meta: {
        'papercusp/toolRegistryRevision': registryRevision,
        'papercusp/toolRegistrySource': PROJECTED_TOOL_REGISTRY_SOURCE,
      },
    };
    // Advertise the output schema + negotiable formats when the tool declared
    // an output schema (P-010). Tools without one still get the runtime
    // auto-encoder; they just don't advertise a capability set.
    //
    // MCP `outputSchema` describes `structuredContent`, which the spec requires
    // to be a JSON OBJECT — so a strict client (the MCP SDK) rejects a tools/list
    // whose outputSchema is array/scalar-rooted. Our list tools return bare
    // arrays, so we only emit the spec-standard `outputSchema` for object-rooted
    // shapes; the array/list case advertises capability via the `resultFormats`
    // extension below (which the SDK tolerates as an unknown field).
    const outputSchema = mcpObjectOutputSchema(tool.outputJsonSchema);
    if (outputSchema) listing.outputSchema = outputSchema;
    if (tool.resultEligibility) {
      const formats = [...tool.resultEligibility.capabilities] as McpToolListing['resultFormats'];
      listing.resultFormats = formats;
      // Mirror onto `_meta` — the spec passthrough slot — so it survives the
      // strict MCP SDK tools/list validation that strips unknown top-level fields.
      listing._meta = { ...(listing._meta ?? {}), 'papercusp/resultFormats': formats };
    }
    if (tool.events && Object.keys(tool.events).length > 0) {
      listing.events = serializeEventsSchema(tool.events);
    } else if (tool.eventsJsonSchema && Object.keys(tool.eventsJsonSchema).length > 0) {
      // Plugin tools (T3.2): the JSON-Schema is the source of truth;
      // no conversion needed.
      listing.events = tool.eventsJsonSchema;
    }
    if (tool.modality && tool.modality.length > 0) {
      listing.modality = tool.modality;
    }
    out.push(listing);
  }
  return out;
}

/** Test-only — flushes the registry between tests. */
export function _resetProjectionRegistryForTests(): void {
  REGISTRY.clear();
  BY_MCP_NAME.clear();
  BY_HTTP_PATH.clear();
  invalidateProjectedToolContract();
  SHAPERS.clear();
}
