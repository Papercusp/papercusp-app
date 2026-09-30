/**
 * Normalized, secret-free evidence for one code orchestration execution.
 *
 * This is deliberately an extension of the code-recipes run rail, not another
 * recipe/runtime abstraction. Static calls supply the reusable structure;
 * runtime call records supply truthful dispositions and validated output
 * references. The structural fingerprint excludes backend, outcomes, binding
 * values, ephemeral values, and output-reference identities.
 */
import { createHash } from 'node:crypto';
import {
  checkScript,
  ensureParseCheckReady,
  type OrchestrationCallRecord,
  type OrchestrationOutputReference,
  type ProjectedTool,
} from '@papercusp/tooldef';
import { deriveRecipeAuthority, type RecipeAuthorityRefs } from './recipe-authority';

export const ORCHESTRATION_TRACE_SCHEMA_VERSION = 1 as const;

export type OrchestrationTraceBackend = 'server' | 'client-compat';
export type StableBindingKind = 'workspace' | 'fleet' | 'plan' | 'harness' | 'item' | 'resource';
export type EphemeralValueKind =
  | 'owner-id'
  | 'session-id'
  | 'pty-session-id'
  | 'process-id'
  | 'cursor'
  | 'temp-path'
  | 'local-path';
export type TraceReplayability = 'deterministic' | 'environment-bound' | 'client-bound' | 'session-bound' | 'mixed';

export interface OrchestrationStableBinding {
  parameter: string;
  kind: StableBindingKind;
  /** Stable entity value needed by a later binding/replay phase. Never included in the fingerprint. */
  value: string;
}

export interface OrchestrationEphemeralValue {
  path: string;
  kind: EphemeralValueKind;
}

export interface OrchestrationStaticCall {
  id: string;
  tool: string;
  dynamicArgs: boolean;
  /** Canonical JSON-safe shape. It contains parameter/ephemeral/redaction markers, never raw free-form strings. */
  args: unknown;
  capabilities: string[];
}

export interface OrchestrationRuntimeCall {
  ordinal: number;
  tool: string;
  effect: 'read' | 'write' | 'unknown';
  disposition: OrchestrationCallRecord['disposition'];
  capabilities: string[];
  outputReferences: OrchestrationOutputReference[];
}

export interface NormalizedExecutionTrace {
  schemaVersion: typeof ORCHESTRATION_TRACE_SCHEMA_VERSION;
  backend: OrchestrationTraceBackend;
  requirements: {
    tools: string[];
    capabilities: string[];
    premises: ['host:same'];
  };
  toolGraph: {
    /** Source order. This is intentionally not mislabeled as a dependency edge. */
    staticCalls: OrchestrationStaticCall[];
    /** Actual dispatch order. Parallel settlement order is not inferred as a dependency edge. */
    runtimeCalls: OrchestrationRuntimeCall[];
  };
  stableBindings: OrchestrationStableBinding[];
  ephemeralValues: OrchestrationEphemeralValue[];
  redactedSecretPaths: string[];
  portability: {
    host: 'same';
    replayability: TraceReplayability;
    ephemeralKinds: EphemeralValueKind[];
  };
  structuralFingerprint: string;
}

export interface NormalizeExecutionTraceInput {
  script: string;
  backend?: OrchestrationTraceBackend;
  tools: readonly ProjectedTool[];
  allowed?: ReadonlySet<string>;
  callRecords?: readonly OrchestrationCallRecord[];
}

type BindingRefsKey = keyof RecipeAuthorityRefs;
type JsonMarker = Record<string, string | boolean>;

const BINDING_DIMENSIONS: ReadonlyArray<{
  kind: StableBindingKind;
  refsKey: BindingRefsKey;
}> = [
  { kind: 'workspace', refsKey: 'workspaces' },
  { kind: 'fleet', refsKey: 'fleets' },
  { kind: 'plan', refsKey: 'plans' },
  { kind: 'harness', refsKey: 'harnesses' },
  { kind: 'item', refsKey: 'items' },
  { kind: 'resource', refsKey: 'resources' },
];

const SECRET_KEYS = new Set([
  'apikey',
  'accesskey',
  'secretkey',
  'token',
  'accesstoken',
  'refreshtoken',
  'password',
  'passwd',
  'credential',
  'credentials',
  'authorization',
  'cookie',
  'privatekey',
  'passphrase',
  'clientsecret',
]);
const OWNER_ID = /^su-(?:[0-9a-f]{4,64}|[0-9a-f-]{36})$/i;
const TEMP_PATH_ROOT = /^(?:\/tmp\/|\/var\/tmp\/|\/var\/folders\/|\/run\/|\/dev\/shm\/)/i;
const ABSOLUTE_LOCAL_PATH = /^(?:\/|[A-Za-z]:[\\/])/;

const normalizeKey = (key: string): string => key.replace(/[^a-z0-9]/gi, '').toLowerCase();

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function secretKey(key: string | null): boolean {
  if (!key) return false;
  const normalized = normalizeKey(key);
  return SECRET_KEYS.has(normalized) || normalized.endsWith('apikey') || normalized.endsWith('secret');
}

function ephemeralKind(key: string | null, value: unknown): EphemeralValueKind | null {
  const normalized = key ? normalizeKey(key) : '';
  if (typeof value === 'string') {
    if (OWNER_ID.test(value)) return 'owner-id';
    if (TEMP_PATH_ROOT.test(value)) return 'temp-path';
    if (ABSOLUTE_LOCAL_PATH.test(value) && !value.includes('://')) return 'local-path';
  }
  if (normalized.includes('pty') || normalized === 'bashid') return 'pty-session-id';
  if (normalized === 'session' || normalized.endsWith('sessionid') || normalized === 'sid') return 'session-id';
  if (
    normalized === 'pid' ||
    normalized.endsWith('processid') ||
    normalized === 'jobid' ||
    normalized === 'taskid'
  ) {
    return 'process-id';
  }
  if (normalized.includes('cursor')) return 'cursor';
  if (
    typeof value === 'string' &&
    (normalized === 'cwd' || normalized === 'workdir' || normalized.endsWith('filepath') || normalized === 'path') &&
    !value.includes('://')
  ) {
    return TEMP_PATH_ROOT.test(value) ? 'temp-path' : 'local-path';
  }
  return null;
}

function capabilitiesByTool(tools: readonly ProjectedTool[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const tool of tools) {
    const name = tool.expose?.mcp?.name;
    if (!name) continue;
    out.set(name, [...new Set(tool.capabilities)].sort());
  }
  return out;
}

interface ValueNormalizerState {
  refsByValue: Map<string, StableBindingKind[]>;
  bindingByIdentity: Map<string, OrchestrationStableBinding>;
  bindingCounters: Map<StableBindingKind, number>;
  ephemeral: OrchestrationEphemeralValue[];
  redactedSecretPaths: string[];
}

function createValueNormalizerState(refs: RecipeAuthorityRefs): ValueNormalizerState {
  const refsByValue = new Map<string, StableBindingKind[]>();
  for (const dimension of BINDING_DIMENSIONS) {
    for (const value of refs[dimension.refsKey]) {
      const kinds = refsByValue.get(value) ?? [];
      kinds.push(dimension.kind);
      refsByValue.set(value, kinds);
    }
  }
  return {
    refsByValue,
    bindingByIdentity: new Map(),
    bindingCounters: new Map(),
    ephemeral: [],
    redactedSecretPaths: [],
  };
}

function stableBindingMarker(value: string, state: ValueNormalizerState): JsonMarker | null {
  const kind = state.refsByValue.get(value)?.[0];
  if (!kind) return null;
  const identity = `${kind}\u0000${value}`;
  let binding = state.bindingByIdentity.get(identity);
  if (!binding) {
    const ordinal = (state.bindingCounters.get(kind) ?? 0) + 1;
    state.bindingCounters.set(kind, ordinal);
    binding = { parameter: `${kind}:${ordinal}`, kind, value };
    state.bindingByIdentity.set(identity, binding);
  }
  return { $binding: binding.parameter };
}

function normalizeValue(
  value: unknown,
  state: ValueNormalizerState,
  path: string,
  key: string | null = null,
): unknown {
  if (secretKey(key)) {
    state.redactedSecretPaths.push(path);
    return { $redacted: 'secret' };
  }

  const ephemeral = ephemeralKind(key, value);
  if (ephemeral) {
    state.ephemeral.push({ path, kind: ephemeral });
    return { $ephemeral: ephemeral };
  }

  if (typeof value === 'string') {
    const binding = stableBindingMarker(value, state);
    return binding ?? { $literal: 'string' };
  }
  if (typeof value === 'number') return { $literal: Number.isInteger(value) ? 'integer' : 'number' };
  if (typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) {
    return value.map((entry, index) => normalizeValue(entry, state, `${path}[${index}]`));
  }
  if (isPlainRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const childKey of Object.keys(value).sort()) {
      out[childKey] = normalizeValue(value[childKey], state, `${path}.${childKey}`, childKey);
    }
    return out;
  }
  return { $dynamic: true };
}

function replayabilityFor(
  backend: OrchestrationTraceBackend,
  ephemeralKinds: readonly EphemeralValueKind[],
): TraceReplayability {
  const sessionBound = ephemeralKinds.some((kind) =>
    ['owner-id', 'session-id', 'pty-session-id', 'process-id', 'cursor'].includes(kind),
  );
  const environmentBound = ephemeralKinds.some((kind) => kind === 'temp-path' || kind === 'local-path');
  if ((sessionBound && environmentBound) || (backend === 'client-compat' && (sessionBound || environmentBound))) {
    return 'mixed';
  }
  if (sessionBound) return 'session-bound';
  if (environmentBound) return 'environment-bound';
  if (backend === 'client-compat') return 'client-bound';
  return 'deterministic';
}

function copyOutputReference(reference: OrchestrationOutputReference): OrchestrationOutputReference {
  return {
    uri: reference.uri,
    byteCount: reference.byteCount,
    sha256: reference.sha256,
    ...(reference.expiresAt ? { expiresAt: reference.expiresAt } : {}),
    ...(reference.audience ? { audience: reference.audience } : {}),
  };
}

/** Build the canonical trace and its backend/outcome-independent structural fingerprint. */
export async function normalizeExecutionTrace(
  input: NormalizeExecutionTraceInput,
): Promise<NormalizedExecutionTrace> {
  await ensureParseCheckReady();
  const backend = input.backend ?? 'server';
  const [analysis, authority] = await Promise.all([
    Promise.resolve(checkScript(input.script, input.tools, input.allowed)),
    deriveRecipeAuthority(input.script),
  ]);
  const capabilityMap = capabilitiesByTool(input.tools);
  const state = createValueNormalizerState(authority.refs);

  const staticCalls: OrchestrationStaticCall[] = analysis.calls.map((call, ordinal) => ({
    id: `static:${ordinal}`,
    tool: call.tool,
    dynamicArgs: call.dynamicArgs,
    args: normalizeValue(call.args, state, `staticCalls[${ordinal}].args`),
    capabilities: capabilityMap.get(call.tool) ?? [],
  }));
  const runtimeCalls: OrchestrationRuntimeCall[] = [...(input.callRecords ?? [])]
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((call) => ({
      ordinal: call.ordinal,
      tool: call.tool,
      effect: call.effect,
      disposition: call.disposition,
      capabilities: capabilityMap.get(call.tool) ?? [],
      outputReferences: call.outputReferences.map(copyOutputReference),
    }));

  const toolNames = [...new Set([...staticCalls.map((call) => call.tool), ...runtimeCalls.map((call) => call.tool)])].sort();
  const capabilities = [
    ...new Set([...staticCalls, ...runtimeCalls].flatMap((call) => call.capabilities)),
  ].sort();
  const ephemeralValues = state.ephemeral
    .filter((entry, index, all) => all.findIndex((candidate) => candidate.path === entry.path && candidate.kind === entry.kind) === index)
    .sort((a, b) => a.path.localeCompare(b.path) || a.kind.localeCompare(b.kind));
  const ephemeralKinds = [...new Set(ephemeralValues.map((entry) => entry.kind))].sort() as EphemeralValueKind[];
  const stableBindings = [...state.bindingByIdentity.values()].sort((a, b) => a.parameter.localeCompare(b.parameter));
  const redactedSecretPaths = [...new Set(state.redactedSecretPaths)].sort();

  // Deliberately excludes: backend, dispositions, binding VALUES, reference URI/hash/size,
  // and ephemeral values. Runtime-only tools are sorted because parallel dispatch order is
  // evidence, not structure; the full ordered runtimeCalls remain in the trace above.
  const fingerprintShape = {
    schemaVersion: ORCHESTRATION_TRACE_SCHEMA_VERSION,
    requirements: { tools: toolNames, capabilities, premises: ['host:same'] },
    staticCalls: staticCalls.map((call) => ({
      tool: call.tool,
      dynamicArgs: call.dynamicArgs,
      args: call.args,
      capabilities: call.capabilities,
    })),
    runtimeOnlyTools: [...new Set(runtimeCalls.map((call) => call.tool).filter((tool) => !staticCalls.some((s) => s.tool === tool)))].sort(),
    ephemeralKinds,
    outputReferenceShape: runtimeCalls
      .filter((call) => call.outputReferences.length > 0)
      .map((call) => ({
        tool: call.tool,
        count: call.outputReferences.length,
        audiences: [...new Set(call.outputReferences.map((reference) => reference.audience ?? 'unspecified'))].sort(),
      }))
      .sort((a, b) => a.tool.localeCompare(b.tool)),
  };
  const structuralFingerprint = createHash('sha256').update(JSON.stringify(fingerprintShape)).digest('hex');

  return {
    schemaVersion: ORCHESTRATION_TRACE_SCHEMA_VERSION,
    backend,
    requirements: { tools: toolNames, capabilities, premises: ['host:same'] },
    toolGraph: { staticCalls, runtimeCalls },
    stableBindings,
    ephemeralValues,
    redactedSecretPaths,
    portability: {
      host: 'same',
      replayability: replayabilityFor(backend, ephemeralKinds),
      ephemeralKinds,
    },
    structuralFingerprint,
  };
}
