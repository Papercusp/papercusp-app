import type { AccountPool } from './provider-contracts';
import { CODEX_ORIGINATOR, CODEX_OPENAI_BETA } from './codex-oauth-proxy';

export type GatewayProviderId = 'claude' | 'codex' | 'omp';
export type GatewayProviderProtocol = 'anthropic' | 'openai-compatible' | 'unsupported' | 'multi';

/** The launcher/runtime making a request. This is NOT the wire protocol. */
export type GatewayClientBackend = 'claude' | 'codex' | 'omp';
/** Protocol spoken on the gateway boundary. */
export type GatewayWireProtocol = 'anthropic-messages' | 'openai-responses' | 'openai-chat';
/** Concrete upstream service selected after protocol classification. */
export type GatewayUpstreamRoute = 'anthropic-api' | 'openai-api' | 'chatgpt-codex' | 'local-registry';
/** Credential + I/O mechanism for one attempt. */
export type GatewayTransportId = 'bearer-http' | 'oauth-http' | 'cli-exec' | 'local-http';
/** Internal contract: the caller cannot accept a silently removed output limit. */
export const REQUIRE_OUTPUT_TOKEN_LIMIT_HEADER = 'x-papercusp-require-output-token-limit';
/** Existing gateway handlers used as the first strangler executors. These are
 * static, compiled bindings — never runtime plugin names. */
export type GatewayLegacyExecutorId =
  | 'proxy'
  | 'proxyOpenAi'
  | 'serveCodexOAuthProxy'
  | 'serveCodexCliBridge'
  | 'proxyLocal';
// P-008 / D-028: `GatewayLegacyEntryExecutorId` — the union of handlers still ENTERED through
// the strangler bridge — is DELETED along with the bridge. It shrank to empty when the last
// lane re-homed (P-011 / D-027).
//
// `GatewayLegacyExecutorId` above deliberately SURVIVES and stays wide: a transport strategy
// names the handler that serves it (local-http -> proxyLocal), which is a different question
// from how a lane is ENTERED — and only the entry half was scaffolding.
export type GatewayRateLimitDialect = 'anthropic-unified' | 'codex-windows' | 'none';
export type GatewayCachePolicyId = 'anthropic-cache-control' | 'openai-prompt-cache' | 'none';
export type GatewayModelCatalogPolicy = 'upstream' | 'gateway-static' | 'local-registry';
export type GatewayRetryPolicyId = 'account-failover' | 'local-backend-failover' | 'none';

export interface GatewayTransportDescriptor {
  id: GatewayTransportId;
  auth: 'bearer' | 'oauth' | 'cli-home' | 'none';
  upstreams: readonly GatewayUpstreamRoute[];
  streaming: boolean;
  nonStreaming: boolean;
  /** Absent means unverified, so a required output limit fails closed. */
  enforcesOutputTokenLimit?: boolean;
  /** Legacy handler that currently realizes this strategy while P-010 moves
   * shared invariants into the request kernel one at a time. */
  legacyExecutor: GatewayLegacyExecutorId;
  /** A degraded compatibility/rollback transport, never the preferred happy path. */
  degraded?: boolean;
}

export interface GatewayLaneCapabilities {
  streaming: boolean;
  nonStreaming: boolean;
  accountPinning: 'hard-soft' | 'none';
  modelDiscovery: GatewayModelCatalogPolicy;
}

export interface GatewayLaneDescriptor {
  id: 'anthropic-messages' | 'openai-responses' | 'local-openai-chat';
  label: string;
  // P-008 / D-028: `legacyEntryExecutor` is GONE. It named the handler a lane was entered
  // through by the strangler bridge; every lane now takes its admission at its own entry
  // (P-011 / D-027), so there is no bridge and nothing to declare. A transport strategy still
  // keeps its own `legacyExecutor` below — that says which handler serves the transport, a
  // different question from how a lane is entered, and only the latter was scaffolding.
  clients: readonly GatewayClientBackend[];
  protocol: GatewayWireProtocol;
  upstreams: readonly GatewayUpstreamRoute[];
  transports: readonly GatewayTransportDescriptor[];
  capabilities: GatewayLaneCapabilities;
  accountPool: AccountPool | null;
  upstreamBase: string | null;
  admissionProfile: 'claude' | 'codex' | 'local';
  retryPolicy: GatewayRetryPolicyId;
  rateLimitDialect: GatewayRateLimitDialect;
  cachePolicy: GatewayCachePolicyId;
  observability: {
    lane: string;
    provider: 'anthropic' | 'openai' | 'local';
  };
  match: {
    pathPrefixes: readonly string[];
    ambiguousPaths?: readonly string[];
  };
  /** Live out-of-pool transport count (currently ChatGPT subscription homes). */
  extraAccountCount?: () => number;
  unavailableMessage: string | null;
}

export interface GatewayLaneRegistry {
  anthropicMessages: GatewayLaneDescriptor;
  openaiResponses: GatewayLaneDescriptor;
  localOpenAiChat: GatewayLaneDescriptor;
}

export type GatewayAccountPinMode = 'hard' | 'soft' | 'none';

export interface GatewayLaneCapabilityRequest {
  client: GatewayClientBackend;
  protocol: GatewayWireProtocol;
  upstream: GatewayUpstreamRoute;
  transport: GatewayTransportId;
  auth: GatewayTransportDescriptor['auth'];
  streaming: boolean;
  modelDiscovery: GatewayModelCatalogPolicy;
  retryPolicy: GatewayRetryPolicyId;
  accountPin: GatewayAccountPinMode;
  requireOutputTokenLimit?: boolean;
}

export interface GatewayLaneConformanceCase extends GatewayLaneCapabilityRequest {
  id: string;
  lane: GatewayLaneDescriptor;
}

export interface GatewayProviderAdapter {
  id: GatewayProviderId;
  label: string;
  protocol: GatewayProviderProtocol;
  upstreamBase: string | null;
  pool: AccountPool | null;
  /** Live count of accounts served OUTSIDE the bearer `pool` — the codex CLI-bridge
   *  (ChatGPT-subscription) accounts (codex-cli-bridge.ts). A getter, not a snapshot,
   *  so a pool hot-reload applies to the next diagnostics read. Counted toward
   *  `configured` in gatewayProviderStatuses (WI-3068: an all-CLI codex deployment has
   *  `pool: null` BY DESIGN and used to read as "not configured"). */
  cliAccountCount?: () => number;
  unavailableMessage: string | null;
  /** Typed execution lane. OMP deliberately delegates to an existing protocol lane. */
  lane: GatewayLaneDescriptor;
}

export interface GatewayProviderAdapters {
  claude: GatewayProviderAdapter;
  codex: GatewayProviderAdapter;
  omp: GatewayProviderAdapter;
}

export interface GatewayProviderStatus {
  id: GatewayProviderId;
  label: string;
  protocol: GatewayProviderProtocol;
  configured: boolean;
  /** Out-of-pool CLI-bridge accounts currently serving this provider (codex ChatGPT-subscription). */
  cliAccountCount: number;
  upstreamBase: string | null;
  unavailableMessage: string | null;
  laneId: GatewayLaneDescriptor['id'];
}

type GatewayRequestHeaders = Record<string, string | string[] | undefined>;

const ACCOUNT_HEADER = 'x-papercusp-account';

export function makeGatewayLaneRegistry(opts: {
  claudePool: AccountPool;
  codexPool?: AccountPool | null;
  codexCliAccountCount?: () => number;
  anthropicUpstreamBase: string;
  openaiUpstreamBase: string;
}): GatewayLaneRegistry {
  return {
    anthropicMessages: {
      id: 'anthropic-messages',
      // P-011 / D-027: entered directly through `withDurableGatewayAdmission` + `proxy`, whose
      // entry takes this lane's admission slot before anything else it does.
      label: 'Anthropic Messages',
      clients: ['claude', 'omp'],
      protocol: 'anthropic-messages',
      upstreams: ['anthropic-api'],
      transports: [
        {
          id: 'oauth-http',
          auth: 'oauth',
          upstreams: ['anthropic-api'],
          streaming: true,
          nonStreaming: true,
          legacyExecutor: 'proxy',
        },
      ],
      capabilities: {
        streaming: true,
        nonStreaming: true,
        accountPinning: 'hard-soft',
        modelDiscovery: 'upstream',
      },
      accountPool: opts.claudePool,
      upstreamBase: opts.anthropicUpstreamBase,
      admissionProfile: 'claude',
      retryPolicy: 'account-failover',
      rateLimitDialect: 'anthropic-unified',
      cachePolicy: 'anthropic-cache-control',
      observability: { lane: 'anthropic-messages', provider: 'anthropic' },
      match: { pathPrefixes: ['/v1/messages', '/v1/count_tokens'], ambiguousPaths: ['/v1/models'] },
      unavailableMessage: null,
    },
    openaiResponses: {
      id: 'openai-responses',
      // P-011 / D-027: entered directly through `withDurableGatewayAdmission` + `proxyOpenAi`
      // on BOTH paths this one descriptor serves — the provider path and the `/v1/models`
      // bypass (D-023), which passes a pass-through admission so it stays unqueued.
      label: 'OpenAI Responses',
      clients: ['codex', 'omp'],
      protocol: 'openai-responses',
      upstreams: ['openai-api', 'chatgpt-codex'],
      transports: [
        {
          id: 'bearer-http',
          auth: 'bearer',
          upstreams: ['openai-api'],
          streaming: true,
          nonStreaming: true,
          legacyExecutor: 'proxyOpenAi',
          enforcesOutputTokenLimit: true,
        },
        {
          id: 'oauth-http',
          auth: 'oauth',
          upstreams: ['chatgpt-codex'],
          streaming: true,
          nonStreaming: true,
          legacyExecutor: 'serveCodexOAuthProxy',
        },
        {
          id: 'cli-exec',
          auth: 'cli-home',
          upstreams: ['chatgpt-codex'],
          streaming: false,
          nonStreaming: true,
          legacyExecutor: 'serveCodexCliBridge',
          degraded: true,
        },
      ],
      capabilities: {
        streaming: true,
        nonStreaming: true,
        accountPinning: 'hard-soft',
        modelDiscovery: 'gateway-static',
      },
      accountPool: opts.codexPool ?? null,
      upstreamBase: opts.openaiUpstreamBase,
      admissionProfile: 'codex',
      retryPolicy: 'account-failover',
      rateLimitDialect: 'codex-windows',
      cachePolicy: 'openai-prompt-cache',
      observability: { lane: 'openai-responses', provider: 'openai' },
      match: { pathPrefixes: ['/v1/responses'], ambiguousPaths: ['/v1/models'] },
      extraAccountCount: opts.codexCliAccountCount,
      unavailableMessage: 'inference-gateway: no Codex account pool configured',
    },
    localOpenAiChat: {
      id: 'local-openai-chat',
      // P-011 / D-022: the FIRST lane off the strangler bridge. Entered directly through
      // `withDurableGatewayAdmission` + `proxyLocal`, whose durable crossing is this lane's
      // only real admission — it has no queue of its own.
      label: 'Local OpenAI-compatible chat/completions',
      clients: ['omp'],
      protocol: 'openai-chat',
      upstreams: ['local-registry'],
      transports: [
        {
          id: 'local-http',
          auth: 'none',
          upstreams: ['local-registry'],
          streaming: true,
          nonStreaming: true,
          legacyExecutor: 'proxyLocal',
        },
      ],
      capabilities: {
        streaming: true,
        nonStreaming: true,
        accountPinning: 'none',
        modelDiscovery: 'local-registry',
      },
      accountPool: null,
      upstreamBase: null,
      admissionProfile: 'local',
      retryPolicy: 'local-backend-failover',
      rateLimitDialect: 'none',
      cachePolicy: 'none',
      observability: { lane: 'local-openai-chat', provider: 'local' },
      match: { pathPrefixes: ['/v1/chat/completions', '/v1/completions'] },
      unavailableMessage: 'inference-gateway: no reachable local backend',
    },
  };
}

// P-008 / D-028: `legacyEntryRouteForGatewayLane` — which resolved a lane's strangler entry to
// a declared transport — is DELETED with the bridge that called it (P-011 / D-027 re-homed the
// last lane). `legacyExecutorForGatewayTransport` below is NOT scaffolding and stays: it
// answers which handler serves a chosen TRANSPORT, which the Codex lane still asks at runtime.

/** Resolve a concrete transport/auth strategy to its existing handler. */
export function legacyExecutorForGatewayTransport(
  lane: GatewayLaneDescriptor,
  transport: GatewayTransportId,
): GatewayLegacyExecutorId {
  const strategy = lane.transports.find((candidate) => candidate.id === transport);
  if (!strategy) {
    throw new Error(`inference-gateway: lane '${lane.id}' does not support transport '${transport}'`);
  }
  return strategy.legacyExecutor;
}

function capabilityFailure(
  lane: GatewayLaneDescriptor,
  code: string,
  detail: string,
): never {
  throw new Error(`inference-gateway: lane '${lane.id}' capability rejected [${code}]: ${detail}`);
}

/**
 * Validate one complete backend/protocol/upstream/transport request against a
 * compiled lane. Every mismatch fails closed; this function never substitutes a
 * different transport, auth mode, retry class, or pin policy.
 */
export function assertGatewayLaneCapability(
  lane: GatewayLaneDescriptor,
  request: GatewayLaneCapabilityRequest,
): GatewayTransportDescriptor {
  if (!lane.clients.includes(request.client)) {
    capabilityFailure(lane, 'client-backend', `client '${request.client}' is not registered`);
  }
  if (request.protocol !== lane.protocol) {
    capabilityFailure(lane, 'wire-protocol', `protocol '${request.protocol}' does not match '${lane.protocol}'`);
  }
  const transport = lane.transports.find((candidate) => candidate.id === request.transport);
  if (!transport) {
    capabilityFailure(lane, 'transport', `transport '${request.transport}' is not registered`);
  }
  if (transport.auth !== request.auth) {
    capabilityFailure(
      lane,
      'auth-mode',
      `transport '${transport.id}' requires '${transport.auth}', not '${request.auth}'`,
    );
  }
  if (request.requireOutputTokenLimit && transport.enforcesOutputTokenLimit !== true) {
    capabilityFailure(lane, 'output-token-limit', `transport '${transport.id}' cannot enforce an output token limit`);
  }
  if (!transport.upstreams.includes(request.upstream)) {
    capabilityFailure(
      lane,
      'upstream-route',
      `transport '${transport.id}' cannot route to '${request.upstream}'`,
    );
  }
  if (request.streaming ? !transport.streaming : !transport.nonStreaming) {
    capabilityFailure(
      lane,
      'stream-mode',
      `transport '${transport.id}' does not support ${request.streaming ? 'streaming' : 'non-streaming'}`,
    );
  }
  if (request.modelDiscovery !== lane.capabilities.modelDiscovery) {
    capabilityFailure(
      lane,
      'model-discovery',
      `requested '${request.modelDiscovery}', lane declares '${lane.capabilities.modelDiscovery}'`,
    );
  }
  if (request.retryPolicy !== lane.retryPolicy) {
    capabilityFailure(
      lane,
      'retry-policy',
      `requested '${request.retryPolicy}', lane declares '${lane.retryPolicy}'`,
    );
  }
  if (request.accountPin !== 'none' && lane.capabilities.accountPinning === 'none') {
    capabilityFailure(lane, 'account-pin', `lane does not support '${request.accountPin}' pins`);
  }
  return transport;
}

/** Generate the exhaustive conformance surface from the registry itself. */
export function gatewayLaneConformanceMatrix(
  registry: GatewayLaneRegistry,
): GatewayLaneConformanceCase[] {
  const rows: GatewayLaneConformanceCase[] = [];
  for (const lane of Object.values(registry)) {
    const pins: GatewayAccountPinMode[] =
      lane.capabilities.accountPinning === 'none' ? ['none'] : ['hard', 'soft', 'none'];
    for (const client of lane.clients) {
      for (const transport of lane.transports) {
        const streamModes = [
          ...(transport.streaming ? [true] : []),
          ...(transport.nonStreaming ? [false] : []),
        ];
        for (const upstream of transport.upstreams) {
          for (const streaming of streamModes) {
            for (const accountPin of pins) {
              const row: GatewayLaneConformanceCase = {
                id: [
                  lane.id,
                  client,
                  transport.id,
                  upstream,
                  streaming ? 'stream' : 'nonstream',
                  accountPin,
                ].join(':'),
                lane,
                client,
                protocol: lane.protocol,
                upstream,
                transport: transport.id,
                auth: transport.auth,
                streaming,
                modelDiscovery: lane.capabilities.modelDiscovery,
                retryPolicy: lane.retryPolicy,
                accountPin,
              };
              assertGatewayLaneCapability(lane, row);
              rows.push(row);
            }
          }
        }
      }
    }
  }
  return rows;
}

export function makeGatewayProviderAdapters(opts: {
  claudePool: AccountPool;
  codexPool?: AccountPool | null;
  /** Live count of codex CLI-bridge accounts served OUTSIDE the bearer pool (WI-3068). */
  codexCliAccountCount?: () => number;
  anthropicUpstreamBase: string;
  openaiUpstreamBase: string;
}): GatewayProviderAdapters {
  const lanes = makeGatewayLaneRegistry(opts);
  return {
    claude: {
      id: 'claude',
      label: 'Claude / Anthropic',
      protocol: 'anthropic',
      upstreamBase: opts.anthropicUpstreamBase,
      pool: opts.claudePool,
      unavailableMessage: null,
      lane: lanes.anthropicMessages,
    },
    codex: {
      id: 'codex',
      label: 'Codex / OpenAI-compatible',
      protocol: 'openai-compatible',
      upstreamBase: opts.openaiUpstreamBase,
      pool: opts.codexPool ?? null,
      cliAccountCount: opts.codexCliAccountCount,
      // FALLBACK text for a request that finds no serving account at request time (bearer
      // pool absent AND the CLI-bridge list empty). Whether codex is ACTUALLY unavailable is
      // decided per-read in gatewayProviderStatuses — a bearer-pool-less gateway whose codex
      // accounts are all CLI-bridge is fully configured (WI-3068 false negative).
      unavailableMessage: 'inference-gateway: no Codex account pool configured',
      lane: lanes.openaiResponses,
    },
    // OMP (pi) is multi-provider and routes by REUSING the existing adapters
    // rather than owning a bespoke protocol. This row is the DIAGNOSTICS view of
    // the ANTHROPIC delegation only — the gateway dispatches by request PATH
    // (providerForGatewayRequest), never by this entry, and an OMP SESSION's
    // provider is not decided here at all.
    //
    // ⚠ Do NOT read `pool`/`upstreamBase`/`lane` below as "OMP is always Claude-pinned"
    // — they are a representative default, not a routing target. OpenAI-account-pinned
    // OMP is IMPLEMENTED, not a follow-up: `ompGatewayModelFromSpec`
    // (orchestrator/omp-gateway-config.ts:78) resolves an `openai`/`openai-codex`
    // selector to { gatewayProvider:'openai', accountProvider:'codex' }; spawn-env.ts:307
    // adopts that accountProvider and :354 filters the pool to an account of that
    // provider; the models.yml then targets the /v1 root with `api: openai-responses`
    // (omp-gateway-config.ts:34-35, :127). Pinned by omp-models-config.test.ts:41 and :97.
    // `label`/`protocol` DO reflect this (protocol:'multi'); `gatewayProviderStatuses`
    // also reports `configured` as claude-OR-codex, since an OMP session can be served
    // by either even when the other pool is absent (EI-21891944321682303).
    omp: {
      id: 'omp',
      label: 'OMP (multi-provider — routes to Claude or Codex per session model spec)',
      protocol: 'multi',
      upstreamBase: opts.anthropicUpstreamBase,
      pool: opts.claudePool,
      unavailableMessage: null,
      lane: lanes.anthropicMessages,
    },
  };
}

export function providerForGatewayPath(path: string, adapters: GatewayProviderAdapters): GatewayProviderAdapter {
  return path.startsWith('/v1/responses') ? adapters.codex : adapters.claude;
}

function headerValue(headers: GatewayRequestHeaders, name: string): string | null {
  const raw = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(raw)) return raw[0]?.trim() || null;
  return raw?.trim() || null;
}

export function providerForGatewayRequest(
  path: string,
  headers: GatewayRequestHeaders,
  adapters: GatewayProviderAdapters,
  /** Extra codex account ids OUTSIDE the bearer pool — the ChatGPT-subscription
   *  CLI accounts (codex-cli-bridge.ts) — so a `/v1/models` probe pinned to one
   *  still routes to the codex adapter. */
  isExtraCodexAccount?: (accountId: string) => boolean,
): GatewayProviderAdapter {
  const pathProvider = providerForGatewayPath(path, adapters);
  if (pathProvider.id === 'codex') return pathProvider;

  // Codex's OpenAI-compatible provider probes `/v1/models` before a turn. The
  // shared gateway also supports Anthropic `/v1/models`, so route by the pinned
  // account when one is present instead of globally stealing the path.
  if (path.startsWith('/v1/models')) {
    const pinnedAccount = headerValue(headers, ACCOUNT_HEADER);
    if (pinnedAccount && (adapters.codex.pool?.select?.(pinnedAccount) || isExtraCodexAccount?.(pinnedAccount))) {
      return adapters.codex;
    }
    // WI-3651: an UNPINNED codex request (WI-3645 auto-routing, no x-papercusp-account) still
    // self-identifies via the headers the codex CLI stamps on every request (codex-oauth-proxy.ts:
    // `originator: codex_cli_rs`, `OpenAI-Beta: responses=experimental`). Without this, an unpinned
    // `/v1/models` probe fell through to the Claude adapter, which answers with Claude's catalog
    // shape ({ data: [{ id: 'claude-...' }] }) -- missing the `models` field codex expects -- so
    // codex logged a noisy "failed to refresh available models" ERROR once per auto session and
    // fell back to its baked-in model list. Pure header sniffing, no pool lookup: cheap, and safe
    // even for an all-CLI codex deployment (no bearer pool at all).
    const originator = headerValue(headers, 'originator');
    const openaiBeta = headerValue(headers, 'openai-beta');
    if (originator === CODEX_ORIGINATOR || openaiBeta === CODEX_OPENAI_BETA) {
      return adapters.codex;
    }
  }

  return pathProvider;
}

export function gatewayProviderStatuses(adapters: GatewayProviderAdapters): GatewayProviderStatus[] {
  const statusFor = (adapter: GatewayProviderAdapter, configuredOverride?: boolean): GatewayProviderStatus => {
    const cliAccountCount = adapter.cliAccountCount?.() ?? 0;
    // Configured = the provider can actually serve: a bearer pool OR out-of-pool CLI-bridge
    // accounts. Codex ChatGPT-subscription accounts have NO API bearer (they are deliberately
    // filtered out of the bearer pool — launch.ts buildBearerEntries), so `pool !== null`
    // alone reported a working all-CLI codex deployment as unconfigured (WI-3068).
    const configured =
      configuredOverride ?? ((adapter.pool !== null || cliAccountCount > 0) && adapter.upstreamBase !== null);
    return {
      id: adapter.id,
      label: adapter.label,
      protocol: adapter.protocol,
      configured,
      cliAccountCount,
      upstreamBase: adapter.upstreamBase,
      unavailableMessage: configured ? null : adapter.unavailableMessage,
      laneId: adapter.lane.id,
    };
  };
  const claude = statusFor(adapters.claude);
  const codex = statusFor(adapters.codex);
  // OMP delegates PER-SESSION to whichever of these two the model spec resolves to (see the
  // comment on `omp:` in makeGatewayProviderAdapters), so it is servable whenever EITHER
  // backing provider is configured — not only when the Claude pool this row's diagnostics
  // fields default to happens to be present (EI-21891944321682303).
  const omp = statusFor(adapters.omp, claude.configured || codex.configured);
  return [claude, codex, omp];
}
