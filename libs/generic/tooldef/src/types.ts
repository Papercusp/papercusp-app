/**
 * Core types for the Agent MCP server.
 */

import type { RolesQuota, ToolResult } from './wire';
import type { ArgReencoding } from './reencode-args';
import type { AgentRole } from './host-types';
import type { z, ZodTypeAny } from 'zod';
import type { StandardSchemaV1 } from './standard-schema';
import type {
  AbortCompletionReceiptResolver,
  EventsSchema,
  ResultDoorSkipReason,
  UnifiedToolContext,
  UserEvents,
} from './tool-projection';
import type { Authorizer } from './authz';
import type { ToolRequireSpec } from './requires';
import type { DeltaCapability } from './delta-protocol';
import type { SeeAlso } from './see-also';
import type { DenominatorSpec } from './denominator';
import type {
  OpenCardSnapshot as WireOpenCardSnapshot,
  ReportBlock,
} from '@papercusp/chat-protocol';

/** A Papercusp capability tier per spec/capabilities §10.6.1. */
export type CapabilityTier = 'low' | 'medium' | 'high';

/**
 * Principal kinds — who the caller is.
 *
 * Resolved Phase 3b 2026-05-20 (principal-rfc-2026-05-20.md). The plan
 * extended the original `'harness' | 'system' | 'pi'` triad with four
 * new kinds covering webapp users, mobile clients, external services,
 * and the legacy loopback-only trust path.
 */
export type PrincipalKind =
  | 'harness'   // sealed harness spawn URL (orchestrator-minted)
  | 'system'    // operator self-issued (e.g. background sweepers, superuser shell)
  | 'pi'        // shell-launched agent, bearer file
  | 'user'      // cookie-bearing browser session
  | 'device'    // JWT-bearing paired device (phone, CLI, kiosk, …)
  | 'service'   // bearer-token external integration (future webapp services)
  | 'loopback'; // host header is local; no token (legacy desktop-only gate)

/**
 * How the principal was authenticated. Orthogonal to `PrincipalKind` —
 * a `'service'` principal might be `'bearer-token'` OR `'jwt'`; a
 * `'user'` principal might be `'cookie-session'` today and `'jwt'`
 * later (Phase 8). Keeping these separate lets `kind` describe *who*
 * and `authMethod` describe *how we know*.
 */
export type PrincipalAuthMethod =
  | 'bearer-token'     // ~/.papercusp/superuser-token or external bearer
  | 'cookie-session'   // browser cookie
  | 'jwt'              // mobile JWT, future webapp tokens
  | 'spawn-url'        // HMAC-signed orchestrator URL
  | 'host-loopback'    // Host header is local; no token (legacy)
  | 'process-internal'; // in-process call (e.g. background sweeper)

/**
 * Trust ladder. Middleware reads this without having to know the full
 * method × kind matrix.
 *   - `'trusted'`               — process-internal, sealed spawn URL,
 *                                 bearer file with verified hash.
 *   - `'verified'`              — JWT signature checked, cookie session
 *                                 validated against PG.
 *   - `'unverified-loopback'`   — host header only; rejected when running
 *                                 on a network-reachable host (Phase 8
 *                                 bans these at boot when bindHost ≠
 *                                 127.0.0.1).
 */
export type PrincipalTrust = 'trusted' | 'verified' | 'unverified-loopback';

/** Resolved caller identity. */
export interface Principal<TKind extends string = PrincipalKind> {
  /** Who the caller is. Generic so a host can widen the kind union (RFC tooldef-auth Phase 2); defaults to the built-in `PrincipalKind`. */
  kind: TKind;
  /** e.g. `"system:operator"`, `"pi:abc123"`, `"harness-foo"`, user id, mobile deviceId. */
  slug: string;
  /** Workspace the call is scoped to. No global principals. */
  workspaceId: string;
  /** How the principal was authenticated. Set by the per-transport resolver. */
  authMethod: PrincipalAuthMethod;
  /**
   * Trust level. The single thing middleware reads when deciding whether
   * to allow a host-protected operation. See `PrincipalTrust`.
   */
  trust: PrincipalTrust;
  /** Granted capability strings (e.g. `tasks:read`). Freeform; namespacing convention only. */
  capabilities: ReadonlySet<string>;
  /**
   * RBAC roles the caller holds (e.g. `'staff'`, `'admin'`) — RFC tooldef-auth Phase 2.
   * A DISTINCT axis from `kind` (how the caller authenticated), from `capabilities`
   * (OAuth-scope-like grants), and from agent `tool.roles` (the orchestration allowlist
   * checked against `ctx.role`). This is what the declarative require-role gate checks —
   * the typed replacement for ad-hoc `requireAdminKey`/`requireStaff` checks. Optional +
   * freeform; the host's principal resolver populates it.
   */
  roles?: ReadonlySet<string>;
  /** Optional human-readable label for logging. Not load-bearing. */
  label?: string;
}

/**
 * Auth-gate requirements applied to a resolved `Principal`. Used by both
 * `requirePrincipal()` (the host-side resolver) and `defineTool`/
 * `defineTool` (the endpoint primitive's `auth` field).
 *
 * Lives in `@papercusp/agent-mcp` rather than `apps/operator/lib/auth` so
 * the endpoint primitive can reference it without creating an
 * app→package dependency inversion. `apps/operator/lib/auth/require-
 * principal.ts` re-exports.
 */
export interface PrincipalRequirements {
  /** Allowed trust levels. Empty/undefined = any. */
  trust?: ReadonlyArray<PrincipalTrust>;
  /** Allowed kinds. Empty/undefined = any. */
  kind?: ReadonlyArray<PrincipalKind>;
  /** Required capabilities. The principal needs all of them (or '*'). */
  capabilities?: ReadonlyArray<string>;
  /**
   * Where a bearer-style credential may be read from. Default `['header']`
   * (`Authorization: Bearer`). A route whose caller cannot set headers —
   * e.g. a polling fetcher — opts into `['query']` to also accept the
   * token from `?token=`. General: applies to any kind, not device-only.
   * Query-string tokens leak into access logs, so this is opt-in per
   * route and never a silent global fallback.
   */
  tokenIn?: ReadonlyArray<'header' | 'query'>;
}

/**
 * Endpoint auth stance. `'public'` opts out of `requirePrincipal()`
 * (used for webhooks, OAuth callbacks, pair endpoints). `'loopback'`
 * also takes no principal but declares the route local-only — the host's
 * dispatch chokepoint rejects requests whose Host is not a loopback
 * address (enforcement lives host-side; this type is the contract).
 * Otherwise a `PrincipalRequirements` object gates the call.
 */
export type RouteAuth = 'public' | 'loopback' | PrincipalRequirements;

/* ─── Route projection (Phase E6, endpoint-unification-2026-05-21) ─────
 *
 * The route-shaped projection of the endpoint system. `defineTool`
 * (below / in `define-tool.ts`) accepts EITHER a tool-shaped definition
 * (→ MCP agent catalog + HTTP catch-all) OR a route-shaped one (→ a
 * plain Hono route, NOT in the agent catalog). These types describe the
 * route shape.
 *
 * They live here, in `@papercusp/agent-mcp`, so the package's
 * `defineTool` can accept a route without an app→package dependency
 * inversion. The Hono-coupled mounting (`registerRoute`, `route-stack`)
 * stays in `apps/operator/lib/endpoint-route/` — a route is *declared*
 * with the package primitive and *mounted* by the host.
 */

export type RouteMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS';

/**
 * Per-call context handed to a route handler. Host-neutral: `req` and
 * the return value are Web-standard `Request`/`Response`. `params`
 * carries the path parameters (`:slug`) that aren't in the URL.
 */
export interface RouteContext<TInput = undefined> {
  /** Resolved principal, or null when `auth: 'public'`. */
  principal: Principal | null;
  /** Parsed + validated input when an `input` schema was declared; else undefined. */
  input: TInput;
  /** Path parameters (`/harness/:slug` → `{ slug }`). */
  params: Record<string, string>;
  /**
   * The transport's socket peer address, when the host adapter exposes one.
   * This is deliberately not derived from caller-controlled forwarding
   * headers; handlers that need client identity should use this value.
   */
  peerAddress?: string | null;
  /** Telemetry-bound logger. */
  log: (level: 'info' | 'warn' | 'error', msg: string, meta?: Record<string, unknown>) => void;
  /** Abort signal — fires at `timeoutSec`. Handlers racing I/O should pass it through. */
  signal: AbortSignal;
}

/**
 * A route-shaped endpoint definition. Produced by `defineTool` when it
 * is handed a route-shaped input (discriminated by the `method` field);
 * mounted onto the Hono app by `registerRoute` in the host.
 */
export interface RouteDefinition<TInputSchema extends ZodTypeAny | undefined = undefined> {
  method: RouteMethod;
  /**
   * Hono path. The Hono app's `.basePath('/api')` is implicit, so
   * `'/desktop/version'` serves at `/api/desktop/version`. Dynamic
   * segments use Hono syntax: `:slug`, `:path{.+}`.
   */
  path: string;
  /** Auth stance — required, see `RouteAuth`. */
  auth: RouteAuth;
  /**
   * Optional Zod input schema. POST/PUT/PATCH parse from the JSON body;
   * GET/DELETE parse from the query string. Absent → the handler gets
   * `ctx.input === undefined` and reads `req` directly (freeform routes:
   * file-serving, SSE).
   */
  input?: TInputSchema;
  /**
   * Wall-clock timeout. Default 30s. A wedged handler aborts.
   * `null` disables the watchdog entirely — for long-lived routes
   * (SSE / streaming transports) whose handler legitimately outlives any
   * fixed budget; a 30s default there kills healthy streams (EI-110).
   */
  timeoutSec?: number | null;
  /**
   * Telemetry sample rate, 0..1. Default 1 (record every call). High-
   * frequency polled routes set this < 1; 0 = never record.
   */
  sampleRate?: number;
  /**
   * Cross-origin reachability. `registerRoute` mounts the CORS middleware
   * (OPTIONS preflight + headers) for `cors`-enabled routes. Orthogonal
   * to auth — a cross-origin route still declares its own `auth` (and, if
   * it admits paired devices, `kind: ['device']`). `true` uses the default
   * cross-origin allowlist (paired-device + tauri + localhost origins);
   * pass `{ origins }` to override.
   */
  cors?: boolean | { origins: readonly string[] };
  /** The handler. Web-standard in, Web-standard out. */
  handler: (
    req: Request,
    ctx: RouteContext<TInputSchema extends ZodTypeAny ? z.infer<TInputSchema> : undefined>,
  ) => Response | Promise<Response>;
}

/**
 * Per-call request context.
 *
 * Generic over `Tx`, the host-supplied transaction/storage handle (plan
 * P-010 / D-009). Defaults to `any` so the framework stays storage-agnostic
 * and existing consumers that read `ctx.tx.<whatever>()` keep compiling; a
 * host that wants type-safe storage re-exports `ToolContext<MyClient>` (e.g.
 * a workspace-scoped SQL client) and gets a checked `ctx.tx`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface ToolContext<Tx = any> extends Partial<Omit<UnifiedToolContext, 'principal' | 'tx' | 'log'>> {
  principal: Principal;
  /**
   * Host-supplied transaction handle. In Papercusp this is a workspace-scoped
   * SQL client with the `app.workspace_id` GUC set. The framework never
   * touches it — `Tx` defaults to `any` (storage-agnostic) and the host
   * narrows it by binding the type parameter.
   */
  tx: Tx;
  /** Logger bound to the tool name + principal. */
  log: (level: 'info' | 'warn' | 'error', msg: string, meta?: Record<string, unknown>) => void;
  /**
   * The explicit per-call `payloadTier` override, when supplied by the
   * caller. This is distinct from any ambient/session tier.
   */
  payloadTierOverride?: import('./payload-tier').PayloadTier;
  /**
   * Host-provided parsed dispatch projection for source-aware reads. Kept
   * opaque in the storage-agnostic tooldef layer; hosts may use it to push a
   * caller-selected field projection into a read query.
   */
  sourceProjection?: unknown;
  /**
   * Calling agent role, when the transport carries one (EI-10358). Threaded
   * through from the outer `UnifiedToolContext.role` by
   * `registerLegacyAsProjected`'s `legacyCtx` — NOT resolved from `principal`,
   * which for every su session collapses to the single shared
   * `system:superuser` principal and so cannot answer "who wrote this".
   * Absent on transports/callers that never set it (pre-existing rows, a
   * bare HTTP call with no spawn context).
   */
  role?: AgentRole;
  /**
   * Per-session/per-launch caller id, when the transport carries one
   * (EI-10358) — mirrors `UnifiedToolContext.uiClientId` (an su session's
   * PAPERCUSP_SID, or a spawned agent's `?client=`). Same threading + same
   * "may be absent" caveat as `role` above.
   */
  uiClientId?: string | null;
}

/**
 * mcp-ui UIResource — interactive UI fragment a tool can return alongside
 * its data. Spec: https://github.com/idosal/mcp-ui. Shape mirrors
 * `@mcp-ui/server`'s `UIResource` so it round-trips through the MCP
 * transport without rewriting.
 */
export interface UIResourceContent {
  type: 'resource';
  resource: {
    uri: string;
    mimeType: string;
    text?: string;
    blob?: string;
    _meta?: Record<string, unknown>;
  };
  annotations?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

/** Standard envelope for any tool response. */
export interface ToolResponse<T = unknown> {
  data: T;
  /** True when one or more sources were unavailable; partial result still useful. */
  degraded?: boolean;
  degradedReasons?: string[];
  /**
   * Set by payload-tier shaping (payload-tier.ts) when `data` was REPLACED by a
   * bounded/forced projection — i.e. `data` is NOT the tool's full original
   * output; some content was omitted upstream, before this response ever
   * reaches serialization. Mirrors (a subset of) the `_projection` metadata
   * embedded in `data` itself so a downstream consumer that only sees `_meta`
   * (the per-result door, result-door.ts) can tell — WITHOUT parsing the
   * serialized body — that whatever it captures is already-lossy, so it must
   * not claim to hold/spill the "full" result (EI-13918).
   */
  payloadProjection?: {
    truncated: true;
    tier: 'trimmed' | 'standard' | 'full';
    forced: boolean;
    originalChars: number;
    returnedChars: number;
    omittedCount: number;
  };
  /**
   * Set by payload-tier shaping (payload-tier.ts) when an EXPLICIT per-call
   * `payloadTier:'full'` (or an equivalent transport-cap exemption) skipped
   * both the tool's own tier shaper AND the hard-ceiling force-shape — i.e.
   * `data` is the tool's true raw, unshaped output, never trimmed by a
   * domain-aware shaper. Mirrors `payloadProjection` above so a downstream
   * consumer that only sees `_meta` (the per-result door, result-door.ts) can
   * tell the caller deliberately opted out of shaping, WITHOUT parsing the
   * serialized body. This is what lets the door choose "spill the full body
   * and point at it" over "silently re-project it with a generic, field-blind
   * walk that can leave LESS inline than a plain 'trimmed' call would have"
   * (EI-22167228731928620).
   */
  explicitFullRequest?: boolean;
  /** Pagination cursor (for list tools that support it). */
  nextCursor?: string;
  /**
   * Optional mcp-ui UI fragments returned alongside the JSON `data`.
   * The HTTP MCP transport pushes these into the tool result's `content`
   * array; clients with a UIResource renderer (Oracle dock, Claude
   * Desktop, Cline, …) display them inline. Null/empty for tools that
   * only return data.
   */
  uiResources?: UIResourceContent[];
}

/**
 * Per-tool guidance for the role's system prompt. Lives next to the tool
 * (single source of truth) and is projected into the prompt for every
 * role that's allowed to call it. Cross-tool patterns and workflows live
 * in `<role>.tools.md`; this slot is for the per-tool answer to:
 *   "When should the agent reach for me, when should it reach for a
 *    sibling instead, and what should it pair me with?"
 *
 * All fields are optional in v1. CI sync flips `when` to required after
 * the catalog-wide backfill lands.
 */
export interface ToolGuidance {
  /**
   * Primary trigger — "When user asks 'X' or 'Y'", or "When you need to
   * Z". 1-2 lines. The MOST important field; aim to populate this first.
   */
  when?: string;
  /**
   * Disambiguation — "NOT for X; use `<other_tool>` instead". 1-2 lines.
   * Populate when there's a sibling tool the model might confuse with
   * this one (e.g. `harness:status` vs `harness_health` vs
   * `escalations_get` all surface "what's going on with X").
   */
  notWhen?: string;
  /**
   * Pairing hint — "Chain after `<tool_a>` to get the id, then call
   * me", or "Pair with `*_get` to drill down". Only when relevant.
   */
  chaining?: string;
  /**
   * EI-10882 — the RESPONSE shape, in one line, as the caller will actually
   * read it (top-level keys, the row shape of any array, and any field whose
   * name lies about its meaning).
   *
   * Arg schemas are published; return shapes were NOT. To write a `code:run`
   * batch over a tool you must know its response shape, and the only way to
   * learn it was to call the tool once and JSON.stringify the result — one
   * guaranteed wasted round-trip per tool, per agent, forever. In the agent-DX
   * audit (2026-07-13) that single gap caused most of a session's wasted calls:
   * `sessions:search` hits were mapped as `x.session_id` / `x.text` (really
   * `results[].provenance.session_id` / `.excerpt`), and `work_items:get` as
   * `w.state` (really `results[0].workItem.state`, with `checkpoint` a SIBLING
   * of `workItem`). Both returned `ok:true` with every field empty.
   *
   * This is a DOC string, deliberately not a schema: it cannot change
   * serialization (unlike declaring `result`, which switches the response
   * through the column encoder), and is surfaced verbatim by `tools:find` /
   * `agent_tools:list` so an agent reads the shape BEFORE calling. Prefer it on
   * any tool an agent is likely to batch over.
   *
   * ⚠ It is a COMPANION to `result`, not a substitute for it. Prose describing a
   * response SHAPE is a second, unverifiable type system that drifts from the
   * handler silently, so `returns` should INTERPRET a registered result (when a
   * field is absent vs null, which branch sets what) while `result` defines the
   * shape. Consumers may enforce that pairing — Papercusp does, at
   * `lint:guidance-returns-schema` and in
   * `guidance-output-schema-live-guard.test.ts` — so adding `returns` alone to a
   * tool that registers no `result` is the one edit to avoid. This note is here
   * because it is the surface an EDITOR of an existing tool actually reads
   * (EI-22189589517637049).
   */
  returns?: string;
  /**
   * Result-aware cross-link pointers to the adjacent lens / sibling tool /
   * history door for THIS tool's output. Distinct from `chaining`: `chaining`
   * is catalog-time/static (rendered into the DESCRIPTION at selection time,
   * answers "what to call next"); `seeAlso` is result-time/dynamic — a function
   * `(result, args, ctx) => Array<{ tool, reason?, selector? }>` computed from
   * the ACTUAL result so it fills in real counts + the exact selector and
   * self-gates (return `[]` to emit nothing). A static array is allowed for
   * simple cases. The dispatch layer renders it uniformly into every transport
   * envelope (structured `_meta._seeAlso` + a one-line "See also:" text block).
   * See presence-coord-unification-2026-07-01 D-003.
   */
  seeAlso?: SeeAlso;
  /**
   * Base-rate stamp — what this result MATCHED, against the population it was
   * drawn from. Declare it on any tool that returns a filtered slice of a set
   * it can count.
   *
   * WHY (EI-19375528138828761): every read is a filtered one, and nothing
   * supplies the denominator, so a cluster gets reasoned forward from without
   * anyone testing whether it is remarkable. Same shape as `seeAlso` — usually
   * a function `(result, args, ctx) => { matched, population, of?, window? }`
   * computed from the ACTUAL result, self-gating (return `null` to emit
   * nothing), rendered uniformly into every transport envelope
   * (`_meta._denominator` + a one-line "Denominator:" text block).
   *
   * A tool that cannot count its source set sets `population: 'unknown'` —
   * which RENDERS, loudly. Do not omit the stamp to mean that: absence reads
   * as "this is the whole set", which is the exact misreading this prevents.
   */
  denominator?: DenominatorSpec;
  /**
   * Rejected-key → "that lives in ANOTHER TOOL" redirect, surfaced in the
   * `invalid_args` unrecognized-key message. Map an arg name this tool does
   * NOT accept to the tool that does accept it.
   *
   * WHY (EI-20281509195248260): `unknownArgHint` could only correct a key two
   * ways — relocate it to a NESTED field of this same tool, or edit-distance
   * it to a near-miss name. A key whose real home is a DIFFERENT TOOL matches
   * neither, so the caller got only "this tool accepts ONLY: …", whose honest
   * reading is "that capability does not exist here" — and, one inference
   * later, "that capability does not exist". Measured cost: passing `tags` to
   * `work_items:update` produced exactly that, and the belief "nothing writes
   * `tags`" was filed 9x in 19h (see work_items/tag.ts's header) plus
   * EI-18669607533031012, which additionally proposed building two NEW durable
   * surfaces to solve a problem `work_items:tag` already solved.
   *
   * This is the same defect the nested-relocation hint fixes, one level out:
   * there the rejection hid WHERE the key lives, here it hides WHICH TOOL owns
   * it. An authored redirect outranks both guesses at render time, because a
   * human/agent statement of fact should beat a string-distance heuristic.
   *
   * Deliberately NOT rendered into the tool description (`describeFromGuidance`
   * reads only when/notWhen/chaining), so it costs zero prompt weight and is
   * paid for only on the failure path that needs it.
   *
   * Verification note: `unknownArgHint` accepts either the eagerly projected
   * JSON-Schema form or the source validator (`tool.args`) and normalizes the latter
   * through the active `toJsonSchema` adapter. Structured corrective calls still
   * require the registry-backed `packages/operator-core/lib/prompt-assembly.test.ts`
   * (a bare scratch import has no projected target registry to resolve).
   *
   * Example: `{ tags: 'work_items:tag { id, topic } — the ONLY writer for the
   * claim-spec-visible tags field' }`
   */
  argRedirects?: Record<string, string | ToolGuidanceCorrectiveCall | ToolGuidanceDrop>;
  /**
   * Per-role override. Set ONLY the fields that differ from the base
   * guidance; shallowly merged at projection time. Use sparingly — most
   * tools share guidance across roles.
   *
   * Example: `harness:list` is used by operator as "show me my work"
   * and by worker as "find the chunk I'm assigned to" — same tool,
   * different framing.
   */
  byRole?: Partial<Record<AgentRole, Partial<Omit<ToolGuidance, 'byRole'>>>>;
}

/**
 * A cross-tool invalid-input remedy whose executable shape is registry-owned.
 * `tool` and `args` are validated together before prompt/error rendering; `note`
 * remains authored workflow semantics and is never parsed as a call.
 */
export interface ToolGuidanceCorrectiveCall {
  tool: string;
  args: Record<string, unknown>;
  note?: string;
}

/**
 * An authored invalid-input remedy for a key with no replacement destination.
 * This explicit shape keeps a prose drop instruction from being misread as a
 * cross-tool redirect by the failure-path renderer.
 */
export interface ToolGuidanceDrop {
  drop: true;
  note: string;
}

/**
 * Structural tool-invocation event — the value an `emits` rule's `when` /
 * `render` reads (coord-lifecycle-automation-2026-06-04 D-002). Defined here,
 * minimal + domain-free, so the generic `tooldef` lib never depends on the
 * operator-core event-reaction engine. It is structurally assignable to the
 * engine's richer `ToolInvocationEvent` (event-reaction-system-2026-06-04), so
 * the desugar layer passes it through without a cast.
 */
export interface ToolEventLike {
  /** The trigger tool's MCP name (e.g. `'work_items:complete'`). */
  tool: string;
  /** The (already-validated) args the trigger was invoked with. */
  args: Record<string, unknown>;
  /** The trigger's result envelope. */
  result: { ok: boolean; data?: unknown; error?: unknown };
  /** Invocation context — the fields a `when`/`render` commonly reads. Structural/open. */
  ctx: {
    uiClientId?: string | null;
    harnessSlug?: string | null;
    workspaceId?: string | null;
    role?: string | null;
    runId?: string | null;
    spawnId?: string | null;
    [key: string]: unknown;
  };
  /** Cause-chain for loop protection — set by the engine, not the author. */
  cause?: { depth: number; chain: string[]; ruleId?: string };
}

/**
 * One INTRINSIC emission a tool always performs as part of its contract
 * (coord-lifecycle-automation-2026-06-04 D-002). `emits: [ToolEmitSpec, …]` on
 * a `defineTool` is co-location SUGAR that the operator-core desugar
 * (`emitsEntryToRule`) registers as an event-reaction rule — one engine, two
 * authoring forms (the rules file for contextual reactions; `emits:` for
 * intrinsic lifecycle emissions). It is NEVER a parallel dispatch path: the
 * field carries no execution, only the `(on=this tool, when, fire, args)`
 * descriptor the engine runs.
 *
 * (D-002 names the field's target the "surface"; it desugars to the reaction
 * rule's `fire` — the tool the emission invokes, e.g. `coord:emit`.)
 */
export interface ToolEmitSpec {
  /**
   * The reaction tool to fire — its MCP name, e.g. `'coord:emit'`. Desugars to
   * `ReactionRule.fire`. The reaction runs through the NORMAL dispatcher
   * (auth-gated, quota'd, audited), exactly like any other tool call.
   */
  fire: string;
  /**
   * Condition over the invocation event. Omitted ⇒ fires whenever the trigger
   * matches (subject to `onlyOnSuccess`). Desugars to `ReactionRule.when`.
   */
  when?: (event: ToolEventLike) => boolean;
  /**
   * Derive the fired tool's args from the event. Desugars to
   * `ReactionRule.args`. Keep it PURE — no I/O; the engine owns dispatch.
   */
  render: (event: ToolEventLike) => Record<string, unknown>;
  /** Only fire when the trigger SUCCEEDED. Default true. */
  onlyOnSuccess?: boolean;
  /**
   * Reaction execution mode — `'durable'` (DBOS-queued, off the hot path,
   * default) or `'sync'` (in-process await; only when the trigger needs the
   * value). Desugars to `ReactionRule.mode`.
   */
  mode?: 'durable' | 'sync';
  /**
   * Optional explicit id suffix for the generated rule. Defaults to the
   * entry's index in the `emits` array; the full rule id is
   * `emits:<toolName>#<id>`.
   */
  id?: string;
}

/** Tool definition produced by `defineTool`. */
export interface ToolDefinition<TArgs extends StandardSchemaV1 = StandardSchemaV1> {
  /** Tool name, e.g. `"tasks:list"`. Defaults to file-path-derived. */
  name: string;
  /** Resource-authorization hook (RFC tooldef-auth Phase 1b) — see `Authorizer`. */
  authorize?: Authorizer<StandardSchemaV1.InferOutput<TArgs>, UnifiedToolContext, UnifiedToolContext['principal']>;
  /** RBAC role requirement (RFC tooldef-auth Phase 2): caller's `principal.roles` must include one of these (any-of). See `ProjectedTool.requireRoles`. */
  requireRoles?: readonly string[];
  /** Opt out of default-deny (RFC tooldef-auth Phase 3): a tool that intentionally needs no auth gate (the `[AllowAnonymous]` equivalent). See `ProjectedTool.public`. */
  public?: boolean;
  /** TSDoc-derived description for MCP `tools/list`. */
  description: string;
  /** Capability gate (e.g. `"tasks:read"`). One per tool. */
  capability: string;
  /**
   * Read/write effect (code-execution-tool-orchestration B-CX-PRE). 'write' = the tool
   * MUTATES state; 'read' = side-effect-free. When omitted, `defineTool` infers it from the
   * capability suffix (`:write`/`:admin`/`:delete`/`:manage` ⇒ 'write', else 'read'); set
   * explicitly to override. Threaded onto `ProjectedTool`; consumed by the code-execution
   * sandbox's dry-run/confirm gate (a read-only tool needs no gate).
   */
  effect?: 'read' | 'write';
  /**
   * Optional argument-sensitive effect classifier for union-shaped tools. The
   * static effect remains the safe fallback when this classifier is absent or
   * cannot classify a call.
   */
  effectForCall?: (args: StandardSchemaV1.InferOutput<TArgs>) => 'read' | 'write';
  /** Idempotent-completion opt-in (backend-reliability-100pct-2026-07-03 W6/P-007): when
   *  true, a handler that COMPLETED but whose `ctx.signal` had already aborted (the
   *  wall-clock/idle timeout fired mid-handler under load) surfaces its completed result as
   *  success instead of a spurious `timeout`. Safe ONLY when re-applying (or surfacing a
   *  completed apply of) the write can never double-effect — e.g. `plans:set-status` sets a
   *  status token to a fixed value. Default (absent/false) keeps the abort authoritative.
   *  Threaded onto `ProjectedTool`; read ONLY by the dispatch abort-race branch. */
  idempotent?: boolean;
  /** Attempt-specific completed-write proof; see `ProjectedTool.abortCompletionReceipt`. */
  abortCompletionReceipt?: AbortCompletionReceiptResolver<StandardSchemaV1.InferOutput<TArgs>>;
  /**
   * Canonical tool names this COMPOSITE tool bundles (tool-call-batching-wrappers
   * P-010). A composite collapses a hot fixed multi-step flow into one call (e.g.
   * coord:orient replaces fleet:assignments + work_items:list + coord:inbox + …).
   * Omitted for primitives. Drives `composition` + the agent_tools:list / prompt-
   * catalog back-pointer that points each bundled primitive at this composite.
   */
  replaces?: readonly string[];
  /** Derived at defineTool time: 'composite' when `replaces` is non-empty, else 'primitive'. */
  composition?: 'primitive' | 'composite';
  /** Tier looked up from the capability per §10.6.1's table. */
  tier: CapabilityTier;
  /** Argument schema (any Standard Schema validator). Runtime validation + JSON-schema source. */
  args: TArgs;
  /**
   * Optional schema for the `ToolResponse.data` this tool returns (D-003). The
   * mirror of `args` on the output side — a single declaration that powers
   * three things: (1) token-efficient FORMAT ELIGIBILITY (which compact formats
   * the result can be rendered in — see `@papercusp/result-encoding`'s
   * `analyzeSchema`), (2) MCP `outputSchema` advertisement + `structuredContent`,
   * and (3) runtime output validation. Resolved from `result`/`output` on the
   * input. Optional — tools without it still get the TOON runtime auto-encoder.
   */
  result?: StandardSchemaV1;
  /**
   * Opt into framework freshness negotiation (agent-tool-delta-protocol-2026-06-22,
   * D-001/D-002). Declare a `revision` source and the framework answers an
   * `_meta.delta` request with `not_modified` when the view is unchanged (else
   * `full`), via a stateless opaque cursor — no per-tool `args` schema change
   * (control rides the MCP `_meta` ENVELOPE). Semantic added/updated/removed
   * deltas are a separate endpoint layer (Lane E) NOT enabled by this field.
   */
  delta?: DeltaCapability<StandardSchemaV1.InferOutput<TArgs>, UnifiedToolContext>;
  /**
   * Implementation. PREFER returning a `ToolResponse` envelope (`{ data }`)
   * — it gets format-aware serialization. A raw `ToolResult` (MCP content
   * shape) is also accepted and passes through untouched (parity with the
   * role-gated wrapper; the memory:* family + the TUI Memory tab depend on
   * it — memory-taxonomy-and-debt-followups P-006).
   */
  handler: (args: StandardSchemaV1.InferOutput<TArgs>, ctx: ToolContext) => Promise<ToolResponse | ToolResult>;
  /**
   * Optional per-tool guidance for the role's system prompt.
   * Projected into the prompt assembly by `assembleRolePrompt`.
   * See `ToolGuidance` for shape.
   */
  guidance?: ToolGuidance;
  /**
   * Optional payload-tier shapers (context-trimming-tiers D-004): per-tier
   * projections of the response `data` for trimmed/standard sessions.
   * Resolution falls back trimmed → standard → full. Normal-size unshaped
   * responses remain byte-identical; oversized default-tier results receive
   * a loud generic bounded projection. See `payload-tier.ts`.
   */
  shape?: import('./payload-tier').PayloadShapers;
  /** See `ToolDefinitionInput.profile`. */
  profile?: 'engineer' | 'all';
  /** See `ToolDefinitionInput.papercusp`. */
  harness?: 'required' | 'optional' | 'none';
  /** Intrinsic lifecycle emissions — see `ToolEmitSpec`. Desugared to event rules at load. */
  emits?: readonly ToolEmitSpec[];
  /** Declarative preconditions — see `ToolRequireSpec`. Evaluated by the dispatcher's `preconditions` step. */
  requires?: readonly ToolRequireSpec[];
  /**
   * Cross-workspace opt-out for PRINCIPAL-gated tools — see
   * `RoleToolDefinition.crossWorkspace` for the full rationale. A
   * principal-gated tool whose data genuinely spans workspaces (e.g. the
   * memory store, which lives in shared tables scoped by user-id / harness-slug,
   * not by workspace) sets `crossWorkspace: true` so an UNSCOPED superuser
   * session (`workspaceId '*'`) is handed the admin (rolbypassrls) handle + a
   * synthesized principal instead of failing `workspace_required`. Absent/false
   * ⇒ workspace-isolated (the default). Threaded onto `ProjectedTool` by
   * `registerLegacyAsProjected` and read by the host dispatch's crossWorkspace branch.
   */
  crossWorkspace?: boolean;
  /** See `RoleToolDefinitionInput.needsWorkspaceTx` — same opt-in, principal-gated side. */
  needsWorkspaceTx?: boolean;
  /**
   * @deprecated The dispatcher is transaction-free by default. This legacy
   * opt-out is retained only so older plugins remain source-compatible; hosts
   * must not use it to decide whether a handler receives `ctx.tx`.
   */
  skipWorkspaceTx?: boolean;
  /** See `RoleToolDefinition.skipResultDoor` (EI-19386201256023240) — same opt-out, principal-gated side. */
  skipResultDoor?: ResultDoorSkipReason;
  /** See `RoleToolDefinition.payloadTierCeilingChars` (WI-37843) — same override, principal-gated side. */
  payloadTierCeilingChars?: number;
  /** See `RoleToolDefinition.ignoreSessionPayloadTier` (WI-37843) — same opt-out, principal-gated side. */
  ignoreSessionPayloadTier?: boolean;
  /** See `RoleToolDefinition.argReencodings` (P-016 / D-104) — same surface, principal-gated side. */
  argReencodings?: readonly ArgReencoding[];
  /** See `RoleToolDefinition.argPreconditions` (EI-19486111655110215) — same surface, principal-gated side. */
  argPreconditions?: (rawInput: unknown) => readonly string[];
}

/** Input shape for `defineTool` — same as ToolDefinition minus derived fields. */
export interface ToolDefinitionInput<TArgs extends StandardSchemaV1 = StandardSchemaV1> {
  /** Optional explicit name; defaults to file-path-derived. */
  name?: string;
  /** Resource-authorization hook (RFC tooldef-auth Phase 1b) — see `Authorizer`. */
  authorize?: Authorizer<StandardSchemaV1.InferOutput<TArgs>, UnifiedToolContext, UnifiedToolContext['principal']>;
  /** RBAC role requirement (RFC tooldef-auth Phase 2): caller's `principal.roles` must include one of these (any-of). See `ProjectedTool.requireRoles`. */
  requireRoles?: readonly string[];
  /** Opt out of default-deny (RFC tooldef-auth Phase 3): a tool that intentionally needs no auth gate (the `[AllowAnonymous]` equivalent). See `ProjectedTool.public`. */
  public?: boolean;
  /** Optional explicit description; defaults to caller's TSDoc. */
  description?: string;
  capability: string;
  /** Read/write effect (B-CX-PRE); inferred from the capability suffix when omitted. See ToolDefinition.effect. */
  effect?: 'read' | 'write';
  /** Optional argument-sensitive effect classifier; see ToolDefinition.effectForCall. */
  effectForCall?: (args: StandardSchemaV1.InferOutput<TArgs>) => 'read' | 'write';
  /** Idempotent-completion opt-in (backend-reliability-100pct-2026-07-03 W6/P-007): when
   *  true, a handler that COMPLETED but whose `ctx.signal` had already aborted (the
   *  wall-clock/idle timeout fired mid-handler under load) surfaces its completed result as
   *  success instead of a spurious `timeout`. Safe ONLY when re-applying (or surfacing a
   *  completed apply of) the write can never double-effect — e.g. `plans:set-status` sets a
   *  status token to a fixed value. Default (absent/false) keeps the abort authoritative.
   *  Threaded onto `ProjectedTool`; read ONLY by the dispatch abort-race branch. */
  idempotent?: boolean;
  /** Attempt-specific completed-write proof; see `ProjectedTool.abortCompletionReceipt`. */
  abortCompletionReceipt?: AbortCompletionReceiptResolver<StandardSchemaV1.InferOutput<TArgs>>;
  /** Canonical tool names this composite tool bundles (e.g. coord:orient replaces fleet:assignments + work_items:list + coord:inbox). Omitted for primitives. See ToolDefinition.replaces. */
  replaces?: readonly string[];
  args: TArgs;
  /** See `ToolDefinition.handler` — ToolResponse preferred; a raw ToolResult passes through untouched. */
  handler: (args: StandardSchemaV1.InferOutput<TArgs>, ctx: ToolContext) => Promise<ToolResponse | ToolResult>;
  /** See `ToolGuidance`. */
  guidance?: ToolGuidance;
  /**
   * Optional payload-tier shapers (context-trimming-tiers D-004): per-tier
   * projections of the response `data` for trimmed/standard sessions.
   * Resolution falls back trimmed → standard → full. Normal-size unshaped
   * responses remain byte-identical; oversized default-tier results receive
   * a loud generic bounded projection. See `payload-tier.ts`.
   */
  shape?: import('./payload-tier').PayloadShapers;
  /* ─── Unified-primitive forward-compat fields (Phase E1, no behavior change) ─────
   * These accept the future `defineTool`-collapsed shape without changing
   * runtime behavior. Phase E2 wires them into dispatch. Phase E1 just makes
   * sure callsites adopting the new shape compile.
   *
   * Plan: apps/operator/docs/plans/endpoint-unification-2026-05-21.md
   */
  /**
   * Auth gate. When set, overrides the legacy single-capability gate
   * (`capability`) with a full `PrincipalRequirements`. `'public'` opts
   * out of `requirePrincipal()`. Phase E2 makes this load-bearing; in
   * E1 it is accepted but not yet read by the dispatcher.
   */
  auth?: RouteAuth;
  /**
   * Alias for `args`. The unified primitive prefers `input` (matches
   * `defineTool`'s field name + the body/query duality). When both are
   * set, `args` wins (back-compat). New callsites should use `input`.
   */
  input?: TArgs;
  /**
   * Optional output-`data` schema (D-003). Declaring it unlocks token-efficient
   * format eligibility (CSV where the shape proves flat-scalar-array), MCP
   * `outputSchema` advertisement, and runtime output validation. `output` is an
   * accepted alias; when both are set `result` wins. Omit and the result still
   * gets the lossless TOON runtime auto-encoder — declaring a schema only
   * UPGRADES eligibility, it is never required.
   */
  result?: StandardSchemaV1;
  /** Alias for `result`. */
  output?: StandardSchemaV1;
  /**
   * Opt into framework freshness negotiation — see `ToolDefinition.delta`
   * (agent-tool-delta-protocol-2026-06-22, D-001/D-002). Endpoints declare a
   * `revision` source; the framework handles cursor + `not_modified` plumbing.
   */
  delta?: DeltaCapability<StandardSchemaV1.InferOutput<TArgs>, UnifiedToolContext>;
  /**
   * Telemetry sample rate, 0..1. Default 1 (record every call). High-
   * frequency tools set this < 1 so `tool_invocations` doesn't flood.
   * Phase E2 wires this into the telemetry sink.
   */
  sampleRate?: number;
  /**
   * Explicit exposure override. When absent, `defineTool` auto-derives
   * MCP name from filename + HTTP path `/api/agent-tools/<group>/<verb>`.
   * Setting `expose` here lets a tool declare arbitrary path/methods,
   * or expose itself over IPC.
   */
  expose?: import('./tool-projection').ToolExposure;
  /**
   * Profile gate. `'engineer'` = Group A (Papercusp-only, hidden from
   * power-engineer sessions). Omit / `'all'` = visible to every profile.
   * See `ProjectedTool.profile` and omp-profile-system-2026-05-24 plan.
   */
  profile?: 'engineer' | 'all';
  /**
   * Harness-scope requirement. `'required'` makes the dispatcher return a
   * uniform `harness_required` error when `ctx.harnessSlug` is absent or
   * `'*'` — for CTX-ONLY tools (no slug arg). Tools that take an explicit
   * slug self-resolve; leave them `'optional'` (default) or `'none'`.
   * See `ProjectedTool.papercusp` (su-prompt-audit-fixes P-020 / D-007).
   */
  harness?: 'required' | 'optional' | 'none';
  /**
   * Intrinsic lifecycle emissions (coord-lifecycle-automation D-002). Each
   * entry desugars to an event-reaction rule registered at load — co-location
   * sugar for "this tool always emits X", never a parallel dispatch path.
   * See `ToolEmitSpec`.
   */
  emits?: readonly ToolEmitSpec[];
  /**
   * Declarative preconditions (autoloop-pot-operator-rebuild D-006) — the
   * preInvoke mirror of `emits:`. Each entry must HOLD (a MatchMap over
   * `{ tool, args, ctx, state }`) for the call to proceed; on failure it
   * rejects (`{ error }`) or auto-corrects (`{ fire, then: 'retry' }`).
   * Evaluated by the dispatcher's `preconditions` step (after `authorize`).
   * NEVER use for safety invariants (D-007) — see `ToolRequireSpec`.
   */
  requires?: readonly ToolRequireSpec[];
  /** See `ToolDefinition.crossWorkspace`. Set on a principal-gated tool that
   * legitimately spans workspaces (e.g. the user-/harness-scoped memory store)
   * so it runs from an unscoped superuser session instead of `workspace_required`. */
  crossWorkspace?: boolean;
  /** See `RoleToolDefinitionInput.needsWorkspaceTx` — same opt-in, principal-gated side. */
  needsWorkspaceTx?: boolean;
  /** @deprecated Transaction-free is now the default; use `needsWorkspaceTx` only when the handler reads `ctx.tx`. */
  skipWorkspaceTx?: boolean;
  /** See `RoleToolDefinitionInput.skipResultDoor` (EI-19386201256023240) — same opt-out, principal-gated side. */
  skipResultDoor?: ResultDoorSkipReason;
  /** See `RoleToolDefinition.payloadTierCeilingChars` (WI-37843) — same override, principal-gated side. */
  payloadTierCeilingChars?: number;
  /** See `RoleToolDefinition.ignoreSessionPayloadTier` (WI-37843) — same opt-out, principal-gated side. */
  ignoreSessionPayloadTier?: boolean;
  /** See `RoleToolDefinition.argReencodings` (P-016 / D-104) — same surface, principal-gated side. */
  argReencodings?: readonly ArgReencoding[];
  /** See `RoleToolDefinition.argPreconditions` (EI-19486111655110215) — same surface, principal-gated side. */
  argPreconditions?: (rawInput: unknown) => readonly string[];
}

/**
 * Role-gated first-party tool definition.
 *
 * Same registry as principal-gated `defineTool`, different gate. Used for
 * first-party operator behavior that spawned agents must be able to call
 * (operator scan, harness phases, voice config, …) — those callers have
 * a URL spawn-context but no bearer token, so principal+capability gating
 * doesn't apply.
 *
 * Keep first-party tools in `packages/agent-mcp/src/tools/<group>/<verb>.ts`
 * even when role-gated; do NOT shape-shift them into a fake "operator-core"
 * plugin (that would mix removable third-party plugins with core papercusp
 * code in the catalog forever).
 */
export interface RoleToolDefinition<
  TArgs extends StandardSchemaV1 = StandardSchemaV1,
  TEvents extends EventsSchema = EventsSchema,
> {
  name: string;
  /** Resource-authorization hook (RFC tooldef-auth Phase 1b) — see `Authorizer`. */
  authorize?: Authorizer<StandardSchemaV1.InferOutput<TArgs>, UnifiedToolContext, UnifiedToolContext['principal']>;
  /** RBAC role requirement (RFC tooldef-auth Phase 2): caller's `principal.roles` must include one of these (any-of). See `ProjectedTool.requireRoles`. */
  requireRoles?: readonly string[];
  /** Opt out of default-deny (RFC tooldef-auth Phase 3): a tool that intentionally needs no auth gate (the `[AllowAnonymous]` equivalent). See `ProjectedTool.public`. */
  public?: boolean;
  description: string;
  /** Capability string for tier classification + descriptive listings. Not enforced. */
  capability: string;
  /** Read/write effect (B-CX-PRE); inferred from the capability suffix when omitted. See ToolDefinition.effect. */
  effect?: 'read' | 'write';
  /** Optional argument-sensitive effect classifier; see ToolDefinition.effectForCall. */
  effectForCall?: (args: StandardSchemaV1.InferOutput<TArgs>) => 'read' | 'write';
  /** Idempotent-completion opt-in (backend-reliability-100pct-2026-07-03 W6/P-007): when
   *  true, a handler that COMPLETED but whose `ctx.signal` had already aborted (the
   *  wall-clock/idle timeout fired mid-handler under load) surfaces its completed result as
   *  success instead of a spurious `timeout`. Safe ONLY when re-applying (or surfacing a
   *  completed apply of) the write can never double-effect — e.g. `plans:set-status` sets a
   *  status token to a fixed value. Default (absent/false) keeps the abort authoritative.
   *  Threaded onto `ProjectedTool`; read ONLY by the dispatch abort-race branch. */
  idempotent?: boolean;
  /** Attempt-specific completed-write proof; see `ProjectedTool.abortCompletionReceipt`. */
  abortCompletionReceipt?: AbortCompletionReceiptResolver<StandardSchemaV1.InferOutput<TArgs>>;
  /** Canonical tool names this composite tool bundles. Omitted for primitives. See ToolDefinition.replaces. */
  replaces?: readonly string[];
  /** Derived at defineTool time: 'composite' when `replaces` is non-empty, else 'primitive'. */
  composition?: 'primitive' | 'composite';
  tier: CapabilityTier;
  /**
   * Visibility profile gate. 'engineer' = engineer-only surfaces (hidden +
   * rejected for the 'all' profile); 'all'/undefined = visible everywhere.
   * Read by registerRoleGatedAsProjected → the projection profile filter.
   */
  profile?: 'engineer' | 'all';
  /** See `ToolDefinitionInput.papercusp`. */
  harness?: 'required' | 'optional' | 'none';
  /** Marker — read by the projection wrapper to skip the principal check. */
  requirePrincipal: false;
  /** Allowed agent roles. Empty/undefined means any role. */
  agentRoles?: AgentRole[];
  /** Per-role quota windows. Roles without an entry are unlimited. */
  rolesQuota?: Partial<Record<AgentRole, RolesQuota>>;
  /** Per-call wall-clock timeout, default 60s. */
  timeoutSec?: number;
  /** Idle timeout — abort if no event emitted for this many seconds. See ProjectedTool.idleTimeoutSec. */
  idleTimeoutSec?: number;
  /**
   * Replay ring-buffer size, 0/undefined to disable (default).
   * When set, the dispatcher keeps the last N emitted events for the
   * call so a client reconnecting with `Last-Event-ID + X-Papercusp-Run-Id`
   * can pick up where it left off. Buffer evicted FIFO when full
   * (warn log fires); buffer survives 5 minutes past stream-end.
   * Per-tool sizing should target 1.5× p99 event_count from production
   * telemetry (Phase 4 T2.2 — see plan).
   */
  replayBufferSize?: number;
  /**
   * Cross-workspace opt-out (P-062 Phase 4). When the HTTP host runs tools
   * inside a workspace-scoped (RLS-subject) transaction by default, a tool
   * that genuinely spans workspaces sets `crossWorkspace: true` so the host
   * gives it the admin (rolbypassrls) handle instead. Absent/false ⇒ the
   * tool is workspace-isolated. Set this ONLY for tools that legitimately
   * read/write outside the caller's own workspace (e.g. listing every
   * workspace, cross-workspace aggregation) — it disables RLS isolation for
   * that tool. Read by the host's `runScoped` seam off `ProjectedTool`.
   */
  crossWorkspace?: boolean;
  /**
   * EI-18808330244321407: opt in to a workspace transaction for the tool's
   * handler. Transaction-free is the default: the host may use a short-lived
   * transaction to synthesize `ctx.principal`, but commits it before invoking
   * the handler. This prevents the ~98% of tools that never query `ctx.tx` from
   * pinning an idle Postgres transaction for their entire wall-clock runtime.
   *
   * Set `needsWorkspaceTx: true` exactly when the handler reads `ctx.tx`,
   * directly or through a helper. The dispatcher then binds the workspace RLS
   * transaction (or the admin handle for `crossWorkspace` tools) for the whole
   * handler. An undeclared `ctx.tx` access throws a named structural error, and
   * the Papercusp ESLint rule rejects first-party consumers missing this flag.
   * Absent/false ⇒ no ambient transaction.
   */
  needsWorkspaceTx?: boolean;
  /**
   * @deprecated Transaction-free is now the default. Kept as a no-op projection
   * field for older plugins compiled against the former opt-out contract.
   */
  skipWorkspaceTx?: boolean;
  /**
   * EI-19386201256023240: opt this tool's result out of the per-result "door"
   * (`result-door.ts`'s `applyResultDoor`, P-006 leg C) — the cap that truncates
   * an oversized `content[0].text` and spills the full text to scratch behind a
   * pointer line. The door's OWN header already states the intended rule:
   * "machine-consumed dispatches … are deliberately NOT doored: their consumers
   * parse programmatically and pay no context rent" — but that rule is enforced
   * only STRUCTURALLY, by which dispatch path a call takes (capabilities/invoke,
   * the tools:invoke inner re-dispatch, and TUI plan-item routes never reach the
   * one choke point that calls `applyResultDoor`). A tool reached over the
   * ORDINARY `tools/call` MCP path — as every per-CLI PostToolUse hook calls
   * `activity:report` — hits that choke point exactly like a model-facing call,
   * even though its consumer is a shell hook doing `json.loads(item['text'])`,
   * not a model. A truncated body plus the door's prose footer is invalid JSON,
   * so `json.loads` throws and the hook fails open SILENTLY — converting a
   * context-protection mechanism into a correctness bug for the one tool on the
   * box calling it (measured: 64,326 truncated `activity:report` responses/24h,
   * 87% of all door fires, each dropping that call's coordination fold with no
   * error anywhere).
   *
   * Set this to the REASON the door does not apply — see `ResultDoorSkipReason`,
   * which also governs whether prose may be appended to the body. Absent ⇒
   * today's behavior, byte-identical.
   */
  skipResultDoor?: ResultDoorSkipReason;
  /**
   * Per-tool override of `PAYLOAD_TIER_HARD_CEILING_CHARS` (WI-37843). Absent ⇒
   * the shared 30,000-char ceiling, unchanged.
   *
   * Exempting a tool from the result door is only half an uncapping: the
   * payload-tier hard ceiling runs EARLIER and is strictly worse when it fires,
   * because the omitted content is never serialized at all — the door at least
   * spills what it cuts.
   *
   * ⚠ CORRECTION (2026-08-10, same work-item). An earlier revision of this
   * comment claimed `coord:orient` "was pinned at that ceiling (p99 = 29,908 of
   * 30,000 chars — a clamp signature)". That attribution is WRONG for the
   * sessions that actually matter, and it was inferred from the percentile shape
   * alone rather than from the code. MCP agent sessions carry a `ctx_tier` that
   * mostly resolves to 'trimmed', so for them the TIER SHAPER (step 1) produces
   * the ~24k-char result and this ceiling never fires at all. Raising the
   * ceiling is still correct — it is the safety valve for explicit-'full'
   * callers whose payload exceeds 30k — but on its own it does NOT uncap a
   * trimmed-tier agent. That is what `ignoreSessionPayloadTier` below is for.
   * Kept as a correction rather than deleted: the wrong reading is re-derivable
   * from the same percentile data, so the next agent should meet the refutation.
   *
   * Raise this only for a tool whose full payload is deliberately allowed to be
   * large, and keep the value BELOW the MCP client's own result cap: past that
   * the client rejects the result and dumps it to a file the caller has to page
   * back in — the original coord:orient 59.8KB overflow (WI-2859) this ceiling
   * was introduced to prevent. A raised ceiling is a safety valve, not a target.
   */
  payloadTierCeilingChars?: number;
  /**
   * Opt this tool OUT of routine per-session payload-tier shaping (WI-37843).
   * Absent ⇒ today's behavior, byte-identical.
   *
   * THE PROBLEM THIS SOLVES (the structural class, EI-20109589063689342):
   * agents read 'trimmed' while the operator UI and the test suite read 'full'.
   * A shaped payload is therefore green in CI, correct in the UI, and degraded
   * for every agent — with nothing failing anywhere. `coord:orient` is the
   * worst case: it is the once-per-session bootstrap read, so the shaping lands
   * on the one turn an agent can least afford to be missing context, and the
   * agent cannot know what it did not receive.
   *
   * Set this ONLY for a tool whose whole value IS the full payload. It is not a
   * performance knob, and a tool that merely returns a lot of rows should ship
   * a better shaper instead.
   *
   * TWO THINGS IT DELIBERATELY DOES NOT DO:
   * 1. It does not override an EXPLICIT per-call `payloadTier` — a caller that
   *    asks for 'trimmed' still gets 'trimmed'. Only the ambient session tier
   *    (the thing the caller never chose) is discarded.
   * 2. It does not remove the tool's shapers, and you must NOT delete them when
   *    setting this. They stay declared because the hard ceiling above uses the
   *    smallest one as its degradation path — force-shaping an oversized result
   *    instead of letting the transport reject it (P-012; the 2026-07-01 43k-token
   *    incident). Opting out of ROUTINE shaping while keeping the CEILING valve
   *    is the entire point of splitting these two fields.
   */
  ignoreSessionPayloadTier?: boolean;
  /**
   * P-016 / D-104 — RE-ENCODINGS this tool authorises the dispatcher to apply AND RUN when
   * validation fails, each disclosed in the result as `corrected:[{path,sent,ran,rule}]`.
   *
   * Strictly narrower than `guidance.argRedirects`, which only ADVISES: a redirect is a
   * disambiguation (we picked one candidate key), and D-104 refuses to execute those because
   * "running a guess answers a question the caller did not ask". Only a total, deterministic
   * re-shape with exactly ONE candidate output belongs here — see `reencode-args.ts` for the
   * boundary, the purity contract, and why the decay measurement depends on it.
   */
  argReencodings?: readonly ArgReencoding[];
  /**
   * EI-19486111655110215 — CROSS-PHASE requirements, reported ALONGSIDE a schema failure.
   *
   * Zod already reports every SCHEMA issue at once, so a caller who sends two bad fields
   * learns both in one round-trip. What it cannot see is a requirement enforced in the
   * HANDLER, after the schema has parsed — typically one that is CONDITIONAL on a value
   * knowable only post-parse. `work_items:complete` is the measured case: `assumptions` is
   * required only when the call carries close intent, which can be inferred from
   * `completion.status`, so the check deliberately lives at handler time and the field is
   * `.optional()` in the schema. The two failures therefore occupy different PHASES, and a
   * caller who fixes the schema error is refused a second time for a reason the first
   * refusal already had every input needed to name. Filing agent measured three attempts
   * for one close; note that the item's own suggested fix (non-abort-early zod) could not
   * have worked, because only one of the two failures is a zod issue at all.
   *
   * A tool declares the check here; the dispatcher evaluates it against the RAW input when
   * validation fails and appends each returned line to the refusal. It runs ONLY on the
   * already-failing path, so a valid call pays nothing. It must be PURE and TOTAL: it sees
   * unvalidated input of any shape and must never throw (the dispatcher isolates it anyway,
   * because a diagnostic that masks the real error would be worse than the gap it fills).
   * Return `[]` when nothing further would fail.
   */
  argPreconditions?: (rawInput: unknown) => readonly string[];
  /**
   * Surfaces this tool is meaningful from. Phase 4 T3.1. The prompt-
   * assembly catalog renderer filters by the caller's modality so voice
   * surfaces only see voice-capable tools. Default — when absent — is
   * `['text', 'voice']` (visible everywhere) so legacy tools surface
   * in both catalogs without a code change; opt out via `['text']` or
   * `['voice']` only when the tool genuinely doesn't make sense in
   * the other surface.
   */
  modality?: ReadonlyArray<'text' | 'voice'>;
  args: TArgs;
  /** Typed event channel. See ProjectedTool.events. */
  events?: TEvents;
  /**
   * State channel schema. Tools that publish snapshots via
   * `ctx.publishState` declare the snapshot's Zod shape here; the
   * dispatcher validates each snapshot against it and surfaces the
   * schema on tools/list for clients. Tools without `state` get
   * `ctx.publishState === undefined` and must use `ctx.emit` instead.
   *
   * See ProjectedTool.state.
   */
  state?: StandardSchemaV1;
  /**
   * Optional output-`data` schema (D-003) — see `ToolDefinition.result`. Only
   * meaningful when the handler returns a `ToolResponse` envelope (a raw
   * `ToolResult` is already content-shaped and bypasses format selection).
   */
  result?: StandardSchemaV1;
  /**
   * Opt into framework freshness negotiation — see `ToolDefinition.delta`
   * (agent-tool-delta-protocol-2026-06-22, D-001/D-002).
   */
  delta?: DeltaCapability<StandardSchemaV1.InferOutput<TArgs>, UnifiedToolContext>;
  /**
   * Handler receives the unified context (no principal). May return either
   * a raw `ToolResult` (MCP shape) or a `ToolResponse` envelope; the
   * wrapper adapts both.
   */
  handler: (
    args: StandardSchemaV1.InferOutput<TArgs>,
    ctx: UnifiedToolContext,
  ) => Promise<ToolResult | ToolResponse>;
  /** See `ToolGuidance`. */
  guidance?: ToolGuidance;
  /**
   * Optional payload-tier shapers (context-trimming-tiers D-004): per-tier
   * projections of the response `data` for trimmed/standard sessions.
   * Resolution falls back trimmed → standard → full. Normal-size unshaped
   * responses remain byte-identical; oversized default-tier results receive
   * a loud generic bounded projection. See `payload-tier.ts`.
   */
  shape?: import('./payload-tier').PayloadShapers;
  /** Intrinsic lifecycle emissions — see `ToolEmitSpec`. Desugared to event rules at load. */
  emits?: readonly ToolEmitSpec[];
  /** Declarative preconditions — see `ToolRequireSpec`. Evaluated by the dispatcher's `preconditions` step. */
  requires?: readonly ToolRequireSpec[];
}

/** Input shape for role-gated `defineTool` — same as RoleToolDefinition minus derived fields. */
export interface RoleToolDefinitionInput<
  TArgs extends StandardSchemaV1 = StandardSchemaV1,
  TEvents extends EventsSchema = EventsSchema,
> {
  name?: string;
  /** Resource-authorization hook (RFC tooldef-auth Phase 1b) — see `Authorizer`. */
  authorize?: Authorizer<StandardSchemaV1.InferOutput<TArgs>, UnifiedToolContext, UnifiedToolContext['principal']>;
  /** RBAC role requirement (RFC tooldef-auth Phase 2): caller's `principal.roles` must include one of these (any-of). See `ProjectedTool.requireRoles`. */
  requireRoles?: readonly string[];
  /** Opt out of default-deny (RFC tooldef-auth Phase 3): a tool that intentionally needs no auth gate (the `[AllowAnonymous]` equivalent). See `ProjectedTool.public`. */
  public?: boolean;
  description?: string;
  capability: string;
  /** Read/write effect (B-CX-PRE); inferred from the capability suffix when omitted. See ToolDefinition.effect. */
  effect?: 'read' | 'write';
  /** Optional argument-sensitive effect classifier; see RoleToolDefinition.effectForCall. */
  effectForCall?: (args: StandardSchemaV1.InferOutput<TArgs>) => 'read' | 'write';
  /** Idempotent-completion opt-in (backend-reliability-100pct-2026-07-03 W6/P-007): when
   *  true, a handler that COMPLETED but whose `ctx.signal` had already aborted (the
   *  wall-clock/idle timeout fired mid-handler under load) surfaces its completed result as
   *  success instead of a spurious `timeout`. Safe ONLY when re-applying (or surfacing a
   *  completed apply of) the write can never double-effect — e.g. `plans:set-status` sets a
   *  status token to a fixed value. Default (absent/false) keeps the abort authoritative.
   *  Threaded onto `ProjectedTool`; read ONLY by the dispatch abort-race branch. */
  idempotent?: boolean;
  /** Attempt-specific completed-write proof; see `ProjectedTool.abortCompletionReceipt`. */
  abortCompletionReceipt?: AbortCompletionReceiptResolver<StandardSchemaV1.InferOutput<TArgs>>;
  /** Canonical tool names this composite tool bundles. Omitted for primitives. See ToolDefinition.replaces. */
  replaces?: readonly string[];
  /** Visibility profile gate — see RoleToolDefinition.profile. */
  profile?: 'engineer' | 'all';
  /** Harness-scope requirement — see `ToolDefinitionInput.papercusp`. */
  harness?: 'required' | 'optional' | 'none';
  requirePrincipal: false;
  agentRoles?: AgentRole[];
  rolesQuota?: Partial<Record<AgentRole, RolesQuota>>;
  timeoutSec?: number;
  /** See RoleToolDefinition.idleTimeoutSec. */
  idleTimeoutSec?: number;
  /** See RoleToolDefinition.replayBufferSize. */
  replayBufferSize?: number;
  /** See RoleToolDefinition.crossWorkspace. */
  crossWorkspace?: boolean;
  /** See RoleToolDefinition.needsWorkspaceTx (EI-18808330244321407). */
  needsWorkspaceTx?: boolean;
  /** @deprecated Transaction-free is now the default; use `needsWorkspaceTx` for a real consumer. */
  skipWorkspaceTx?: boolean;
  /** See RoleToolDefinition.skipResultDoor (EI-19386201256023240). */
  skipResultDoor?: ResultDoorSkipReason;
  /** See RoleToolDefinition.payloadTierCeilingChars (WI-37843). */
  payloadTierCeilingChars?: number;
  /** See RoleToolDefinition.ignoreSessionPayloadTier (WI-37843). */
  ignoreSessionPayloadTier?: boolean;
  /** See `RoleToolDefinition.argReencodings` (P-016 / D-104). */
  argReencodings?: readonly ArgReencoding[];
  /** See `RoleToolDefinition.argPreconditions` (EI-19486111655110215). */
  argPreconditions?: (rawInput: unknown) => readonly string[];
  /** See RoleToolDefinition.modality. */
  modality?: ReadonlyArray<'text' | 'voice'>;
  /** See RoleToolDefinition.state. */
  state?: StandardSchemaV1;
  args: TArgs;
  /**
   * Typed event channel — Zod schemas keyed by event name. The
   * `UserEvents` guard rejects reserved names at compile time.
   * Reserved names: 'done' | 'progress' | 'heartbeat' | 'result'.
   */
  events?: UserEvents<TEvents>;
  handler: (
    args: StandardSchemaV1.InferOutput<TArgs>,
    ctx: UnifiedToolContext,
  ) => Promise<ToolResult | ToolResponse>;
  /** See `ToolGuidance`. */
  guidance?: ToolGuidance;
  /**
   * Optional payload-tier shapers (context-trimming-tiers D-004): per-tier
   * projections of the response `data` for trimmed/standard sessions.
   * Resolution falls back trimmed → standard → full. Normal-size unshaped
   * responses remain byte-identical; oversized default-tier results receive
   * a loud generic bounded projection. See `payload-tier.ts`.
   */
  shape?: import('./payload-tier').PayloadShapers;
  /* ─── Unified-primitive forward-compat fields (Phase E1) — see ToolDefinitionInput. */
  /** See `ToolDefinitionInput.auth`. Phase E2 wiring. */
  auth?: RouteAuth;
  /** Alias for `args`. New callsites prefer `input`. */
  input?: TArgs;
  /** Telemetry sample rate, 0..1. */
  sampleRate?: number;
  /** Explicit exposure override. See `ToolDefinitionInput.expose`. */
  expose?: import('./tool-projection').ToolExposure;
  /**
   * Optional output-`data` schema (D-003) — see `ToolDefinitionInput.result`.
   * `output` is an accepted alias; when both are set `result` wins.
   */
  result?: StandardSchemaV1;
  /** Alias for `result`. */
  output?: StandardSchemaV1;
  /**
   * Opt into framework freshness negotiation — see `ToolDefinition.delta`
   * (agent-tool-delta-protocol-2026-06-22, D-001/D-002). Endpoints declare a
   * `revision` source; the framework handles cursor + `not_modified` plumbing.
   */
  delta?: DeltaCapability<StandardSchemaV1.InferOutput<TArgs>, UnifiedToolContext>;
  /**
   * Intrinsic lifecycle emissions (coord-lifecycle-automation D-002). Each
   * entry desugars to an event-reaction rule registered at load. See
   * `ToolEmitSpec`.
   */
  emits?: readonly ToolEmitSpec[];
  /**
   * Declarative preconditions (autoloop-pot-operator-rebuild D-006) — the
   * preInvoke mirror of `emits:`. See `ToolRequireSpec` and
   * `ToolDefinitionInput.requires`.
   */
  requires?: readonly ToolRequireSpec[];
}

// ──────────────────────────────────────────────────────────────────────
// Resources (MCP `resources/*`).
//
// Symmetric to tools, but for read-only browsable URIs. A resource is
// either:
//   - concrete: one URI, e.g. `papercusp://workspace/harnesses`
//   - templated: an RFC 6570-style URI with `{var}` segments that the
//     `list` callback expands at runtime, e.g.
//       template `papercusp://harness/{slug}/issues`
//       expanded `papercusp://harness/foo/issues`,
//                `papercusp://harness/bar/issues`, …
// ──────────────────────────────────────────────────────────────────────

export interface ResourceContents {
  uri: string;
  mimeType: string;
  text: string;
}

export interface ResourceListEntry {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

/** Per-call resource read context. Same shape as ToolContext. */
export type ResourceContext = ToolContext;

/** Resource definition produced by `defineResource`. */
export interface ResourceDefinition {
  /** Concrete URI or RFC 6570 template (`{var}` segments). */
  uri: string;
  /** Stable name for `resources/list` UX. */
  name: string;
  description: string;
  /** Default mime, e.g. `application/json`. */
  mimeType: string;
  /** Capability gate; same vocabulary as tools. */
  capability: string;
  /** Tier inferred from capability per §10.6.1. */
  tier: CapabilityTier;
  /**
   * For templated resources: expand the template into concrete URIs
   * for `resources/list`. Omit for concrete (single-URI) resources.
   */
  list?: (ctx: ResourceContext) => Promise<ResourceListEntry[]>;
  /** Read a specific URI matching this resource's template/uri. */
  read: (uri: string, ctx: ResourceContext) => Promise<ResourceContents>;
}

/** Input shape for `defineResource`. */
export interface ResourceDefinitionInput {
  /** Optional explicit name; defaults to file-path-derived. */
  name?: string;
  /** Optional explicit description; defaults to caller's TSDoc. */
  description?: string;
  uri: string;
  mimeType?: string;
  capability: string;
  list?: (ctx: ResourceContext) => Promise<ResourceListEntry[]>;
  read: (uri: string, ctx: ResourceContext) => Promise<ResourceContents>;
}

// ──────────────────────────────────────────────────────────────────────
// Prompts (MCP `prompts/*`).
//
// Discoverable, parameterized prompt templates. Clients call
// `prompts/list` to see what's available, then `prompts/get(name, args)`
// to instantiate one. A prompt renders to an array of role/content
// messages — same shape MCP itself uses for completion requests.
// ──────────────────────────────────────────────────────────────────────

export interface PromptArgumentSchema {
  /** Stable name (used in `prompts/get` arg map). */
  name: string;
  description?: string;
  required?: boolean;
}

export interface PromptMessage {
  role: 'user' | 'assistant' | 'system';
  content: { type: 'text'; text: string };
}

export interface PromptResult {
  description?: string;
  messages: PromptMessage[];
}

/** Per-call prompt render context. Same shape as ToolContext. */
export type PromptContext = ToolContext;

export interface PromptDefinition {
  name: string;
  description: string;
  /**
   * Capability gate. Optional — many prompts are public (no gate).
   * If present, callers without the capability won't see the prompt
   * in `prompts/list` and `prompts/get` will deny.
   */
  capability?: string;
  /** Tier inferred from capability per §10.6.1, or 'low' if no capability. */
  tier: CapabilityTier;
  /** Argument schema as MCP prompts/list expects. */
  arguments?: PromptArgumentSchema[];
  /** Render the prompt with provided arguments. */
  render: (
    args: Record<string, string>,
    ctx: PromptContext,
  ) => Promise<PromptResult>;
}

export type { UIResourceContent as UIResource };

// ──────────────────────────────────────────────────────────────────────
// Cards — interactive prompts a tool can issue mid-run.
//
// Plan: apps/operator/docs/plans/bespoke-card-improvements-2026-05-13.md
//
// `ctx.askUser(spec)` server-side. Cards live on the STATE channel, NOT
// the event ring buffer (H2). Renderer reads schema/UI separately (#3).
// Response actions: submit | decline | cancel (#2 / L4).
// ──────────────────────────────────────────────────────────────────────

/**
 * Visual presentation hint. Voice surfaces consume `fallbackText` (and,
 * for `radio` with `voiceAnswerable === true`, the option set for spoken
 * answering). All other kinds stay announce-only for voice.
 */
export type CardPresentation =
  | { kind: 'radio'; options: CardOption[]; voiceAnswerable?: boolean }
  | { kind: 'checkbox'; options: CardOption[] }
  /**
   * Single-choice, rendered COMPACT (a dropdown) rather than one row per
   * option. Same answer shape as `radio` — the difference is purely how much
   * room the option set is allowed to take.
   *
   * Exists because `radio` is the only single-choice kind and it renders every
   * option as a full-width row: a picker with a dozen options consumes its
   * whole surface. Reported by the owner 2026-07-27 against the chat action
   * bar's rubric picker, which filled the entire chat popup. Prefer this
   * whenever the option set is open-ended or large enough that the caller
   * cannot promise it stays short; keep `radio` for a handful of options that
   * benefit from being visible at a glance.
   *
   * `placeholder` is the trigger's resting text before a choice is made.
   */
  | { kind: 'select'; options: CardOption[]; placeholder?: string }
  | { kind: 'text'; placeholder?: string; multiline?: boolean }
  | { kind: 'date'; min?: string; max?: string }
  | { kind: 'slider'; min: number; max: number; step?: number };

export interface CardOption {
  id: string;
  label: string;
  hint?: string;
  style?: 'default' | 'primary' | 'danger';
}

/** Card specification passed to `ctx.askUser`. */
export interface CardSpec<TSchema extends StandardSchemaV1 = StandardSchemaV1> {
  /** Human-readable prompt. Voice surfaces read this verbatim. */
  prompt: string;
  /** Standard Schema validator for the response payload. Validated server-side before resolving. */
  dataSchema: TSchema;
  /** Optional visual presentation hint. Voice surfaces ignore. */
  presentation?: CardPresentation;
  /** Plain-text fallback for voice / MCP elicitation bridge. */
  fallbackText?: string;
  /** Wall-clock timeout. Rejects with `{action:'cancel'}` if user does not respond. */
  timeoutMs?: number;
  /** Per-run idempotency key. Same key returns cached response within the run. */
  idempotencyKey?: string;
  /** When false, the renderer hides any decline affordance. Default true. */
  allowDecline?: boolean;
  /**
   * Fired synchronously once the card is registered, with the freshly-minted
   * `correlationId` (and the run/workspace it's scoped to). Lets a caller link
   * the live card to an external durable record — e.g. inbox-cards-unification
   * Phase D writes a coord escalation carrying this id so the inbox and the
   * live card resolve each other. Optional; existing callers are unaffected.
   * NOT called on an idempotency-cache hit (no card is registered).
   */
  onCard?: (info: { correlationId: string; runId: string; workspaceId: string }) => void;
  /**
   * Optional structured body block (the shared `ReportBlock` two-tier
   * plan→item shape from `@papercusp/chat-protocol`) rendered between the
   * prompt and the options — the card-system rendering of a `<report>`
   * payload. Copied verbatim onto the wire snapshot.
   * Plan: report-cards-inbox-reconciliation-2026-06-05 (D-001).
   */
  report?: ReportBlock;
}

/**
 * Response from a card.
 *   submit  — user provided a payload matching dataSchema.
 *   decline — user explicitly skipped this card (allowDecline must be ≠ false).
 *   cancel  — run was cancelled OR user dismissed OR timeoutMs fired.
 */
export type CardResponse<TSchema extends StandardSchemaV1 = StandardSchemaV1> =
  | { action: 'submit'; payload: StandardSchemaV1.InferOutput<TSchema> }
  | { action: 'decline'; reason?: string }
  | { action: 'cancel' };

/**
 * The streaming-chat wire event union — re-exported from the shared
 * `@papercusp/chat-protocol` contract so a papercup client and a Scout client
 * speak the same SSE protocol (Phase 6, option A —
 * `scout-convergence-papercup-2026-05-30` D-002). papercup's richer server-side
 * card types stay internal; only the wire contract is shared.
 */
export type { ChatEvent } from '@papercusp/chat-protocol';

/**
 * The wire-serializable form of an open card, included in `state-snapshot`
 * payloads under `openCards[]`. Zod schemas are serialized as JSON Schema.
 *
 * Adopts the shared `@papercusp/chat-protocol` `OpenCardSnapshot` wire contract
 * (Phase 6, option A — D-002/D-003): inherits the shared wire fields, but keeps
 * papercup's richer *discriminated* `CardPresentation` and a *required*
 * `dataSchemaJson` (papercup always serializes the zod schema server-side). The
 * discriminated presentation is a structural subtype of the shared flat one, so
 * this interface stays assignable to the shared wire snapshot — a shared client
 * can parse papercup's card payloads (`_assertOpenCardSnapshotIsWireCompatible`
 * below proves it at compile time; a diff that breaks wire-compat fails here).
 */
export interface OpenCardSnapshot
  extends Omit<WireOpenCardSnapshot, 'presentation' | 'dataSchemaJson'> {
  presentation?: CardPresentation;
  dataSchemaJson: Record<string, unknown>;
}

// Compile-time guarantee: papercup's OpenCardSnapshot satisfies the shared wire
// contract. Errors here mean the card wire types drifted out of compatibility.
// Type-only; zero runtime cost.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _AssertWireCompatible<_T extends WireOpenCardSnapshot> = never;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _assertOpenCardSnapshotIsWireCompatible = _AssertWireCompatible<OpenCardSnapshot>;

export interface PromptDefinitionInput {
  name?: string;
  description?: string;
  capability?: string;
  arguments?: PromptArgumentSchema[];
  render: (
    args: Record<string, string>,
    ctx: PromptContext,
  ) => Promise<PromptResult>;
}
