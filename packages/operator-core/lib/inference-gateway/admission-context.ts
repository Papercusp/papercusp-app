/**
 * Gateway → resource-governor admission mapping.
 *
 * The gateway has several wire protocols and legacy executors, but they all
 * cross one admission contract.  This adapter keeps protocol facts (provider,
 * account, model, stream mode, pin and transport) in structured metadata while
 * the canonical Governor owns identity, priority, deadline, demand, receipts,
 * and parent lineage.  It is intentionally policy-free: the existing gateway
 * queue remains the compatibility execution authority until the durable driver
 * migration items replace it.
 */
import type {
  AdmissionClass,
  AdmissionContext,
  AdmissionMetadataValue,
  AdmissionOutcome,
  AdmissionRelease,
  AdmissionRequest,
  Governor,
  ResourceDemand,
} from '../resource-governor/admission';
import type {
  GatewayAccountPinMode,
  GatewayLaneDescriptor,
  GatewayProviderId,
  GatewayTransportId,
} from './provider-adapters';

export const GATEWAY_ADMISSION_CONTEXT_SCHEMA_VERSION = 'gateway-admission-context-v1' as const;

/** Request surfaces that can be classified before protocol execution. */
export type GatewayAdmissionKind =
  | 'claude'
  | 'codex'
  | 'local'
  | 'local-backend'
  | 'maintenance'
  | 'control'
  | 'health'
  | 'metadata';

/** Canonical resource-governor class map. Provider facts remain in metadata. */
export const GATEWAY_ADMISSION_CLASS_MAP: Readonly<Record<GatewayAdmissionKind, AdmissionClass>> = Object.freeze({
  claude: 'inference',
  codex: 'inference',
  local: 'inference',
  'local-backend': 'inference',
  maintenance: 'control',
  control: 'control',
  health: 'control',
  metadata: 'control',
});

/** Short aliases for callers that prefer a provider-oriented vocabulary. */
export const GATEWAY_ADMISSION_CLASSES = Object.freeze({
  claude: GATEWAY_ADMISSION_CLASS_MAP.claude,
  codex: GATEWAY_ADMISSION_CLASS_MAP.codex,
  localBackend: GATEWAY_ADMISSION_CLASS_MAP['local-backend'],
  maintenance: GATEWAY_ADMISSION_CLASS_MAP.maintenance,
  control: GATEWAY_ADMISSION_CLASS_MAP.control,
}) as {
  readonly claude: AdmissionClass;
  readonly codex: AdmissionClass;
  readonly localBackend: AdmissionClass;
  readonly maintenance: AdmissionClass;
  readonly control: AdmissionClass;
};

/** Registry-owned bypass keys. Callers must use one of these; Governor rejects unknown keys. */
export const GATEWAY_ADMISSION_BYPASS_KEYS = Object.freeze({
  healthz: 'gateway.healthz',
  stats: 'gateway.stats',
  stalls: 'gateway.admin.stalls',
  route: 'gateway.admin.route',
  ownerReport: 'gateway.admin.owner-report',
  config: 'gateway.admin.config',
  readmit: 'gateway.admin.readmit',
  clampMode: 'gateway.admin.clamp-mode',
  reload: 'gateway.admin.reload',
  localBackends: 'gateway.admin.local-backends',
  egressMode: 'gateway.admin.egress-mode',
  ownerPin: 'gateway.admin.owner-pin',
  ownerPins: 'gateway.admin.owner-pins',
  models: 'gateway.models',
  backendContext: 'gateway.maintenance.backend-context',
  flagAttest: 'gateway.flags.attest',
  notFound: 'gateway.not-found',
} as const);

export type GatewayAdmissionBypassKey =
  (typeof GATEWAY_ADMISSION_BYPASS_KEYS)[keyof typeof GATEWAY_ADMISSION_BYPASS_KEYS];

/** The set passed to the default Governor; exported for tests and launch wiring. */
export const GATEWAY_ADMISSION_BYPASS_REGISTRY: ReadonlySet<string> = new Set(
  Object.values(GATEWAY_ADMISSION_BYPASS_KEYS),
);

export type GatewayAdmissionProvider = Extract<GatewayProviderId, 'claude' | 'codex'> | 'local';

export interface GatewayAdmissionFacts {
  readonly schemaVersion: typeof GATEWAY_ADMISSION_CONTEXT_SCHEMA_VERSION;
  readonly kind: GatewayAdmissionKind;
  readonly provider: GatewayAdmissionProvider;
  readonly lane: string | null;
  readonly accountId: string | null;
  readonly model: string | null;
  readonly ownerId: string | null;
  readonly streaming: boolean | null;
  readonly pinMode: GatewayAccountPinMode;
  readonly transport: GatewayTransportId | null;
}

/** Canonical context plus the typed gateway facts decoded from metadata. */
export interface GatewayAdmissionContext extends AdmissionContext {
  readonly gateway: GatewayAdmissionFacts;
}

export interface GatewayAdmissionRequestInput {
  readonly kind: GatewayAdmissionKind;
  readonly provider?: GatewayAdmissionProvider;
  readonly lane?: string | null;
  readonly accountId?: string | null;
  readonly model?: string | null;
  readonly ownerId?: string | null;
  readonly streaming?: boolean | null;
  readonly pinMode?: GatewayAccountPinMode;
  readonly transport?: GatewayTransportId | null;
  readonly priority?: number;
  readonly deadlineAtMs?: number;
  readonly idempotencyKey: string;
  readonly demand?: ResourceDemand;
  readonly payloadRef?: string;
  readonly parent?: AdmissionContext | null;
  readonly bypassKey?: GatewayAdmissionBypassKey;
  readonly metadata?: Readonly<Record<string, AdmissionMetadataValue>>;
}

export interface GatewayAdmissionGovernor {
  admit(input: AdmissionRequest): Promise<AdmissionOutcome>;
  release(context: AdmissionContext, actualDemand?: ResourceDemand): Promise<AdmissionRelease>;
}

export interface GatewayAdmissionLease {
  readonly request: AdmissionRequest;
  readonly outcome: AdmissionOutcome;
  readonly context: GatewayAdmissionContext;
  release(actualDemand?: ResourceDemand): Promise<AdmissionRelease>;
}

function textOrNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function providerForKind(kind: GatewayAdmissionKind): GatewayAdmissionProvider {
  switch (kind) {
    case 'codex':
      return 'codex';
    case 'local':
    case 'local-backend':
      return 'local';
    case 'claude':
    case 'maintenance':
    case 'control':
    case 'health':
    case 'metadata':
      return 'claude';
  }
}

/** Resolve a kind (including aliases) to the canonical resource class. */
export function gatewayAdmissionClassFor(kind: GatewayAdmissionKind): AdmissionClass {
  return GATEWAY_ADMISSION_CLASS_MAP[kind];
}

/** Alias retained for callers that describe this operation as a mapping. */
export const mapGatewayAdmissionClass = gatewayAdmissionClassFor;

function defaultDemand(kind: GatewayAdmissionKind): ResourceDemand | undefined {
  switch (kind) {
    case 'claude':
    case 'codex':
    case 'maintenance':
      return { providerRequests: 1 };
    case 'local':
    case 'local-backend':
      return { cpuWeight: 1 };
    default:
      return undefined;
  }
}

/** Build the canonical AdmissionRequest without making a capacity decision. */
export function toGatewayAdmissionRequest(input: GatewayAdmissionRequestInput): AdmissionRequest {
  const kind = input.kind;
  const provider = input.provider ?? providerForKind(kind);
  const accountId = textOrNull(input.accountId);
  const model = textOrNull(input.model);
  const ownerId = textOrNull(input.ownerId);
  const lane = textOrNull(input.lane);
  const pinMode = input.pinMode ?? 'none';
  const transport = input.transport ?? null;
  const metadata: Record<string, AdmissionMetadataValue> = {
    ...(input.metadata ?? {}),
    'gateway.schemaVersion': GATEWAY_ADMISSION_CONTEXT_SCHEMA_VERSION,
    'gateway.kind': kind,
    'gateway.provider': provider,
    'gateway.lane': lane,
    'gateway.accountId': accountId,
    'gateway.model': model,
    'gateway.ownerId': ownerId,
    'gateway.streaming': input.streaming ?? null,
    'gateway.pinMode': pinMode,
    'gateway.transport': transport,
  };
  const request: AdmissionRequest = {
    idempotencyKey: input.idempotencyKey,
    admissionClass: gatewayAdmissionClassFor(kind),
    ...(input.priority === undefined ? {} : { priority: input.priority }),
    ...(input.deadlineAtMs === undefined ? {} : { deadlineAtMs: input.deadlineAtMs }),
    demand: input.demand ?? defaultDemand(kind),
    ...(input.payloadRef === undefined ? {} : { payloadRef: input.payloadRef }),
    ...(input.parent ? { parent: input.parent } : {}),
    ...(input.bypassKey ? { bypassKey: input.bypassKey } : {}),
    metadata: Object.freeze(metadata),
  };
  return Object.freeze(request);
}

function gatewayFactsFromInput(input: GatewayAdmissionRequestInput): GatewayAdmissionFacts {
  return Object.freeze({
    schemaVersion: GATEWAY_ADMISSION_CONTEXT_SCHEMA_VERSION,
    kind: input.kind,
    provider: input.provider ?? providerForKind(input.kind),
    lane: textOrNull(input.lane),
    accountId: textOrNull(input.accountId),
    model: textOrNull(input.model),
    ownerId: textOrNull(input.ownerId),
    streaming: input.streaming ?? null,
    pinMode: input.pinMode ?? 'none',
    transport: input.transport ?? null,
  });
}

/** Attach typed gateway facts to the generic context without changing its wire contract. */
export function gatewayContextFromAdmission(
  context: AdmissionContext,
  input: GatewayAdmissionRequestInput,
): GatewayAdmissionContext {
  return Object.freeze({ ...context, gateway: gatewayFactsFromInput(input) });
}

/** Admit one gateway request through the canonical Governor and expose exact release. */
export async function admitGatewayRequest(
  governor: GatewayAdmissionGovernor,
  input: GatewayAdmissionRequestInput,
): Promise<GatewayAdmissionLease> {
  const request = toGatewayAdmissionRequest(input);
  const outcome = await governor.admit(request);
  const context = gatewayContextFromAdmission(outcome.context, input);
  let released = false;
  return {
    request,
    outcome,
    context,
    async release(actualDemand?: ResourceDemand): Promise<AdmissionRelease> {
      if (released) return { requestId: context.requestId, released: false };
      const result = await governor.release(context, actualDemand ?? input.demand);
      if (result.released) released = true;
      return result;
    },
  };
}

/** Convenience wrapper used by compatibility executors and tests. */
export async function withGatewayAdmission<T>(
  governor: GatewayAdmissionGovernor,
  input: GatewayAdmissionRequestInput,
  run: (context: GatewayAdmissionContext, outcome: AdmissionOutcome) => Promise<T> | T,
): Promise<T> {
  const lease = await admitGatewayRequest(governor, input);
  try {
    return await run(lease.context, lease.outcome);
  } finally {
    await lease.release();
  }
}

/** Derive a request input from the already-validated static lane registry. */
export function gatewayAdmissionInputForLane(input: {
  readonly lane: GatewayLaneDescriptor;
  readonly idempotencyKey: string;
  readonly ownerId?: string | null;
  readonly accountId?: string | null;
  readonly model?: string | null;
  readonly streaming?: boolean | null;
  readonly pinMode?: GatewayAccountPinMode;
  readonly transport?: GatewayTransportId | null;
  readonly priority?: number;
  readonly deadlineAtMs?: number;
  readonly payloadRef?: string;
  readonly parent?: AdmissionContext | null;
}): GatewayAdmissionRequestInput {
  const kind: GatewayAdmissionKind = input.lane.admissionProfile;
  return {
    kind,
    provider: kind === 'local' ? 'local' : kind,
    lane: input.lane.id,
    idempotencyKey: input.idempotencyKey,
    ownerId: input.ownerId,
    accountId: input.accountId,
    model: input.model,
    streaming: input.streaming,
    pinMode: input.pinMode,
    transport: input.transport,
    priority: input.priority,
    deadlineAtMs: input.deadlineAtMs,
    payloadRef: input.payloadRef,
    parent: input.parent,
  };
}

/**
 * Classify metadata/control endpoints. Returning null means the request is a
 * resource-consuming lane and must use the normal admission path.
 */
export function gatewayAdmissionBypassKeyForRequest(
  method: string | undefined,
  rawUrl: string | undefined,
): GatewayAdmissionBypassKey | null {
  const verb = (method ?? '').toUpperCase();
  const path = (rawUrl ?? '/').split('?', 1)[0] || '/';
  if (verb === 'GET' && path === '/healthz') return GATEWAY_ADMISSION_BYPASS_KEYS.healthz;
  if (verb === 'GET' && (path === '/stats' || path === '/admin/stats')) return GATEWAY_ADMISSION_BYPASS_KEYS.stats;
  if (verb === 'GET' && path === '/admin/stalls') return GATEWAY_ADMISSION_BYPASS_KEYS.stalls;
  if (verb === 'GET' && path === '/admin/route') return GATEWAY_ADMISSION_BYPASS_KEYS.route;
  if (verb === 'GET' && path === '/admin/owner-report') return GATEWAY_ADMISSION_BYPASS_KEYS.ownerReport;
  if (verb === 'GET' && path === '/admin/config') return GATEWAY_ADMISSION_BYPASS_KEYS.config;
  if (verb === 'POST' && path === '/admin/readmit') return GATEWAY_ADMISSION_BYPASS_KEYS.readmit;
  if (verb === 'POST' && path === '/admin/clamp-mode') return GATEWAY_ADMISSION_BYPASS_KEYS.clampMode;
  if (verb === 'POST' && path === '/admin/reload') return GATEWAY_ADMISSION_BYPASS_KEYS.reload;
  if (verb === 'GET' && path === '/admin/local-backends') return GATEWAY_ADMISSION_BYPASS_KEYS.localBackends;
  if ((verb === 'GET' || verb === 'POST') && path === '/admin/egress-mode')
    return GATEWAY_ADMISSION_BYPASS_KEYS.egressMode;
  if (verb === 'POST' && path === '/admin/owner-pin') return GATEWAY_ADMISSION_BYPASS_KEYS.ownerPin;
  if (verb === 'GET' && path === '/admin/owner-pins') return GATEWAY_ADMISSION_BYPASS_KEYS.ownerPins;
  if (verb === 'GET' && path === '/v1/models') return GATEWAY_ADMISSION_BYPASS_KEYS.models;
  if (verb === 'GET' && path === '/maintenance/backend-context') return GATEWAY_ADMISSION_BYPASS_KEYS.backendContext;
  if (verb === 'GET' && path === '/internal/flags-attest') return GATEWAY_ADMISSION_BYPASS_KEYS.flagAttest;
  if (!path.startsWith('/v1/') && path !== '/maintenance/summarize') return GATEWAY_ADMISSION_BYPASS_KEYS.notFound;
  return null;
}

/** Alias using the shorter name used by request routers. */
export const gatewayBypassKeyForRequest = gatewayAdmissionBypassKeyForRequest;

/** Map a registered bypass key to the corresponding non-resident request kind. */
export function gatewayAdmissionKindForBypassKey(key: GatewayAdmissionBypassKey): GatewayAdmissionKind {
  if (key === GATEWAY_ADMISSION_BYPASS_KEYS.healthz) return 'health';
  if (
    key === GATEWAY_ADMISSION_BYPASS_KEYS.models ||
    key === GATEWAY_ADMISSION_BYPASS_KEYS.backendContext ||
    key === GATEWAY_ADMISSION_BYPASS_KEYS.flagAttest
  ) {
    return 'metadata';
  }
  return 'control';
}
