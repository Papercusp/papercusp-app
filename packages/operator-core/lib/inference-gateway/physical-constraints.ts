/**
 * Live physical-constraint adapters for the inference gateway (P-003).
 *
 * The gateway has a deliberately heterogeneous set of evidence writers: provider
 * response headers, provider outcomes, egress/proxy counters, local-engine probes,
 * the durable database writer, and the resource-governor health stream.  Before this
 * adapter each caller had to interpret those values independently.  That made two
 * particularly dangerous inferences easy to make:
 *
 *   1. a missing/old reading looked like a healthy zero; and
 *   2. a local policy number (queue depth, configured slots, CPU/RAM) looked like a
 *      physical contract imposed by an upstream service.
 *
 * This module is the small, pure seam between those writers and the capless
 * controller.  It normalises observations into one typed shape, carries freshness
 * and provenance on every row, and attributes failures to the narrowest evidenced
 * scope (account, proxy, backend, or pool).  It does not admit, reject, or cap work.
 * A consumer may pass the resulting frame to RollingHealthAnalyzer/CaplessAdaptiveController;
 * no value in this file is an admission ceiling by itself.
 */

import {
  classify429Shape,
  classifyColdRest429,
  parseRateReset,
  parseUnified7dWindow,
  parseUnifiedWindow,
  type ColdRest429Cause,
  type Gateway429Shape,
} from './gateway';
import { parseCodexRateLimitHeaders } from './codex-oauth-proxy';
import { parseProviderReset } from './provider-reset';
import type { LocalBackend, LocalBackendHealth, LocalBackendPool } from './local-backend-pool';
import type { DbHealthSnapshot } from './db-health';
import {
  LIVE_HEALTH_SIGNAL_SPECS,
  liveHealthWindow,
  measuredLiveHealthReading,
  staleLiveHealthReading,
  unknownLiveHealthReading,
  type LiveHealthReading,
  type LiveHealthSignalKey,
  type LiveHealthSnapshot,
} from '../resource-governor/live-health';
import {
  RollingHealthAnalyzer,
  type HealthAnalysisFrame,
  type HealthVerdict,
} from '../resource-governor/health-analysis';

export const GATEWAY_PHYSICAL_CONSTRAINT_SCHEMA_VERSION = 'inference-gateway-physical-constraints-v1' as const;

/** A reading is useful only for this long unless its writer supplies a shorter horizon. */
export const DEFAULT_PHYSICAL_CONSTRAINT_FRESH_FOR_MS = 30_000;
export const PROVIDER_CONSTRAINT_FRESH_FOR_MS = 30_000;
export const TRANSPORT_CONSTRAINT_FRESH_FOR_MS = 30_000;
export const BACKEND_CONSTRAINT_FRESH_FOR_MS = 15_000;
export const OPERATIONAL_CONSTRAINT_FRESH_FOR_MS = 30_000;

/** Values that can be safely compared by a constraint consumer. */
export type PhysicalConstraintValue = number | boolean;
export type PhysicalConstraintState = 'measured' | 'unknown' | 'stale';
export type PhysicalConstraintProvider = 'anthropic' | 'openai' | 'codex' | 'local';
export type PhysicalConstraintSource =
  | 'provider'
  | 'gateway-transport'
  | 'local-backend'
  | 'database'
  | 'sidecar'
  | 'memory'
  | 'service'
  | 'queue'
  | 'governor'
  | 'monitor';
export type PhysicalConstraintBinding =
  | 'external-physical-contract'
  | 'transient-feedback'
  | 'local-policy'
  | 'context-only'
  | 'unknown';
export type PhysicalConstraintCausalRole = 'cause' | 'outcome' | 'context';
export type PhysicalConstraintUnit =
  | 'boolean'
  | 'fraction'
  | 'percent'
  | 'epoch-ms'
  | 'milliseconds'
  | 'count'
  | 'slots'
  | 'bytes'
  | 'bytes-per-second'
  | 'requests-per-second'
  | 'unknown';

export type PhysicalConstraintKey =
  | 'provider.utilization'
  | 'provider.reset'
  | 'provider.rateLimit'
  | 'provider.overload'
  | 'provider.stall'
  | 'provider.error'
  | 'transport.proxyReachability'
  | 'transport.proxyFailureRate'
  | 'transport.stall'
  | 'transport.slotLeak'
  | 'backend.health'
  | 'backend.slots'
  | 'backend.context'
  | 'backend.inFlight'
  | 'backend.policySlots'
  | 'database.health'
  | 'database.waitP95Ms'
  | 'service.health'
  | 'service.waitP95Ms'
  | 'queue.health'
  | 'queue.writerLatencyP95Ms'
  | 'queue.writerFailureRate'
  | 'queue.depth'
  | 'governor.health'
  | 'governor.admissionLatencyP95Ms'
  | 'governor.decisionLatencyP95Ms'
  | 'governor.persistLatencyP95Ms'
  | 'memory.pressure'
  | 'memory.workingSetBytes'
  | 'cpu.pressure'
  | 'gateway.policy';

export type PhysicalConstraintKind =
  | 'provider-window'
  | 'provider-outcome'
  | 'transport-outcome'
  | 'backend-health'
  | 'backend-slots'
  | 'backend-context'
  | 'database-health'
  | 'service-health'
  | 'queue-health'
  | 'governor-health'
  | 'host-context'
  | 'gateway-policy';

export type ProviderWindow = '5h' | '7d' | 'requests' | 'tokens' | 'unknown';

export interface PhysicalConstraintScope {
  readonly provider?: PhysicalConstraintProvider;
  readonly accountId?: string;
  readonly proxyId?: string;
  readonly backendId?: string;
  readonly lane?: string;
  readonly model?: string;
}

export interface PhysicalConstraintFreshness {
  readonly state: PhysicalConstraintState;
  readonly ageMs: number | null;
  readonly validUntilMs: number | null;
}

/**
 * Canonical writer output.  `constraint` means the measured value represents
 * pressure at this instant; it is intentionally separate from `value` so a
 * measured reset timestamp or a measured queue depth cannot accidentally be
 * interpreted as a contraction signal.
 */
export interface PhysicalConstraintObservation {
  readonly id: string;
  readonly key: PhysicalConstraintKey;
  readonly kind: PhysicalConstraintKind;
  readonly source: PhysicalConstraintSource;
  readonly sourceId: string;
  readonly scope: PhysicalConstraintScope;
  readonly window?: ProviderWindow;
  readonly state: PhysicalConstraintState;
  readonly value: PhysicalConstraintValue | null;
  readonly unit: PhysicalConstraintUnit;
  readonly constraint: boolean;
  readonly binding: PhysicalConstraintBinding;
  readonly causalRole: PhysicalConstraintCausalRole;
  readonly actionable: boolean;
  readonly confidence: number;
  readonly observedAtMs: number;
  readonly collectedAtMs: number;
  readonly expiresAtMs: number | null;
  readonly lastMeasuredAtMs: number | null;
  readonly freshness: PhysicalConstraintFreshness;
  readonly reason: string | null;
  readonly evidence: readonly string[];
  /** Existing resource-governor signal, when this row can feed its analyzer. */
  readonly healthSignal?: LiveHealthSignalKey;
}

export interface GatewayCausalAttribution {
  readonly scope:
    | 'account'
    | 'proxy'
    | 'provider'
    | 'pool'
    | 'backend'
    | 'database'
    | 'service'
    | 'queue'
    | 'governor'
    | 'local-policy'
    | 'unknown';
  readonly subjectId: string | null;
  readonly provider?: PhysicalConstraintProvider;
  readonly externalPhysicalContract: boolean;
  readonly actionable: boolean;
  readonly confidence: number;
  readonly reason: string;
  readonly evidence: readonly string[];
}

export interface PhysicalConstraintVerdict {
  readonly schemaVersion: typeof GATEWAY_PHYSICAL_CONSTRAINT_SCHEMA_VERSION;
  readonly evaluatedAtMs: number;
  readonly state: 'healthy' | 'constrained' | 'unknown' | 'stale';
  readonly constrained: boolean;
  readonly actionable: boolean;
  readonly observations: readonly PhysicalConstraintObservation[];
  readonly attributions: readonly GatewayCausalAttribution[];
  readonly actionableResources: readonly PhysicalConstraintSource[];
  readonly reasons: readonly string[];
}

export interface GatewayPhysicalConstraintSnapshot extends PhysicalConstraintVerdict {
  readonly verdict: PhysicalConstraintVerdict;
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function nonNegative(value: unknown): number | undefined {
  return finite(value) && value >= 0 ? value : undefined;
}

function clampConfidence(value: number | undefined): number {
  if (!finite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function scopeValue(scope: PhysicalConstraintScope): string {
  return [scope.provider, scope.accountId, scope.proxyId, scope.backendId, scope.lane, scope.model]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join('/');
}

function observationId(
  key: PhysicalConstraintKey,
  scope: PhysicalConstraintScope,
  window: ProviderWindow | undefined,
  sourceId: string,
): string {
  // Writer identity is part of the key.  Two provider accounts (or two
  // processes publishing the same queue metric) must not collapse into one row
  // merely because their metric names and scopes happen to match.
  return `${key}:${window ?? ''}:${scopeValue(scope) || 'global'}:${sourceId}`;
}

function normaliseScope(scope: PhysicalConstraintScope | undefined): PhysicalConstraintScope {
  if (!scope) return Object.freeze({});
  const out: PhysicalConstraintScope = {
    ...(text(scope.provider) ? { provider: scope.provider } : {}),
    ...(text(scope.accountId) ? { accountId: scope.accountId } : {}),
    ...(text(scope.proxyId) ? { proxyId: scope.proxyId } : {}),
    ...(text(scope.backendId) ? { backendId: scope.backendId } : {}),
    ...(text(scope.lane) ? { lane: scope.lane } : {}),
    ...(text(scope.model) ? { model: scope.model } : {}),
  };
  return Object.freeze(out);
}

interface ObservationArgs {
  key: PhysicalConstraintKey;
  kind: PhysicalConstraintKind;
  source: PhysicalConstraintSource;
  sourceId?: string;
  scope?: PhysicalConstraintScope;
  window?: ProviderWindow;
  state?: PhysicalConstraintState;
  value?: PhysicalConstraintValue | null;
  unit: PhysicalConstraintUnit;
  constraint?: boolean;
  binding?: PhysicalConstraintBinding;
  causalRole?: PhysicalConstraintCausalRole;
  actionable?: boolean;
  confidence?: number;
  observedAtMs?: number;
  collectedAtMs?: number;
  freshForMs?: number;
  reason?: string | null;
  evidence?: readonly string[];
  healthSignal?: LiveHealthSignalKey;
}

/** Build one observation and apply the freshness contract at collection time. */
function makeObservation(args: ObservationArgs, nowMs: number): PhysicalConstraintObservation {
  const collectedAtMs = finite(args.collectedAtMs) ? args.collectedAtMs : nowMs;
  const observedAtMs = finite(args.observedAtMs) ? args.observedAtMs : collectedAtMs;
  const requestedFreshForMs = args.freshForMs ?? DEFAULT_PHYSICAL_CONSTRAINT_FRESH_FOR_MS;
  const freshForMs =
    finite(requestedFreshForMs) && requestedFreshForMs > 0
      ? Math.max(1, Math.floor(requestedFreshForMs))
      : DEFAULT_PHYSICAL_CONSTRAINT_FRESH_FOR_MS;
  // Freshness is evaluated against the caller's current clock, not against an
  // optional collection timestamp.  A delayed reader must not revive an old
  // header by passing a stale `collectedAtMs`.
  const ageMs = Math.max(0, nowMs - observedAtMs);
  const expiresAtMs = observedAtMs + freshForMs;
  let state: PhysicalConstraintState =
    args.state ?? (args.value === null || args.value === undefined ? 'unknown' : 'measured');
  let value: PhysicalConstraintValue | null = args.value ?? null;
  let reason = args.reason ?? null;
  let confidence = clampConfidence(args.confidence ?? (state === 'unknown' ? 0 : 1));
  let lastMeasuredAtMs: number | null = state === 'unknown' ? null : observedAtMs;

  if (state === 'measured' && (value === null || (typeof value === 'number' && !finite(value)))) {
    state = 'unknown';
    value = null;
    reason = reason ?? 'missing-or-non-finite-observation';
    confidence = 0;
    lastMeasuredAtMs = null;
  }
  if (state === 'measured' && ageMs > freshForMs) {
    state = 'stale';
    value = null;
    reason = reason ?? 'freshness-window-expired';
    confidence = Math.min(confidence, 0.25);
    lastMeasuredAtMs = observedAtMs;
  }
  if (state !== 'measured') value = null;
  if (state === 'unknown') {
    confidence = 0;
    lastMeasuredAtMs = null;
  }
  const binding = args.binding ?? 'unknown';
  const constraint = args.constraint === true;
  const actionable =
    args.actionable === true &&
    state === 'measured' &&
    constraint &&
    binding === 'external-physical-contract' &&
    confidence > 0;
  const scope = normaliseScope(args.scope);
  const sourceId = text(args.sourceId) ?? `${args.source}:unidentified`;
  const freshness: PhysicalConstraintFreshness = Object.freeze({
    state,
    ageMs: state === 'unknown' ? null : ageMs,
    validUntilMs: state === 'unknown' ? null : expiresAtMs,
  });
  return Object.freeze({
    id: observationId(args.key, scope, args.window, sourceId),
    key: args.key,
    kind: args.kind,
    source: args.source,
    sourceId,
    scope,
    ...(args.window ? { window: args.window } : {}),
    state,
    value,
    unit: args.unit,
    constraint,
    binding,
    causalRole: args.causalRole ?? (constraint ? 'cause' : 'context'),
    actionable,
    confidence,
    observedAtMs,
    collectedAtMs,
    expiresAtMs: state === 'unknown' ? null : expiresAtMs,
    lastMeasuredAtMs,
    freshness,
    reason,
    evidence: Object.freeze([...(args.evidence ?? [])]),
    ...(args.healthSignal ? { healthSignal: args.healthSignal } : {}),
  });
}

/** Re-evaluate a previously collected row without changing its writer timestamp. */
export function refreshPhysicalConstraint(
  observation: PhysicalConstraintObservation,
  nowMs: number,
): PhysicalConstraintObservation {
  if (observation.state !== 'measured' || observation.expiresAtMs === null || nowMs <= observation.expiresAtMs) {
    return observation;
  }
  return makeObservation(
    {
      key: observation.key,
      kind: observation.kind,
      source: observation.source,
      sourceId: observation.sourceId,
      scope: observation.scope,
      window: observation.window,
      state: 'stale',
      value: null,
      unit: observation.unit,
      constraint: observation.constraint,
      binding: observation.binding,
      causalRole: observation.causalRole,
      actionable: false,
      confidence: observation.confidence,
      observedAtMs: observation.observedAtMs,
      collectedAtMs: nowMs,
      freshForMs: Math.max(1, observation.expiresAtMs - observation.observedAtMs),
      reason: 'freshness-window-expired',
      evidence: observation.evidence,
      healthSignal: observation.healthSignal,
    },
    nowMs,
  );
}

export function isFreshPhysicalConstraint(observation: PhysicalConstraintObservation, nowMs: number): boolean {
  return refreshPhysicalConstraint(observation, nowMs).state === 'measured';
}

/** True only for a fresh, measured external pressure row that may drive control. */
export function canContractFromPhysicalConstraint(observation: PhysicalConstraintObservation, nowMs: number): boolean {
  const fresh = refreshPhysicalConstraint(observation, nowMs);
  return (
    fresh.state === 'measured' && fresh.constraint && fresh.actionable && fresh.binding === 'external-physical-contract'
  );
}

export const isExternalPhysicalConstraint = canContractFromPhysicalConstraint;

function headerObject(
  input: Headers | Readonly<Record<string, string | string[] | undefined>>,
): Record<string, string | undefined> {
  if (typeof Headers !== 'undefined' && input instanceof Headers) {
    const out: Record<string, string | undefined> = {};
    input.forEach((value, key) => {
      out[key.toLowerCase()] = value;
    });
    return out;
  }
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(input)) {
    out[key.toLowerCase()] = Array.isArray(value) ? value.at(-1) : value;
  }
  return out;
}

function headerNumber(headers: Record<string, string | undefined>, ...names: string[]): number | undefined {
  for (const name of names) {
    const raw = headers[name.toLowerCase()];
    if (raw === undefined || raw.trim() === '') continue;
    const value = Number(raw);
    if (finite(value)) return value;
  }
  return undefined;
}

export { parseProviderReset };

function parseCodexReset(raw: string | undefined, nowMs: number): number | undefined {
  const value = raw?.trim();
  // Codex's zero reset is an inactive-window sentinel (unlike a generic
  // provider's zero-second retry, which is a valid immediate boundary).
  if (!value || /^0+(?:\.0+)?(?:s|m|h|d)?$/i.test(value)) return undefined;
  return parseProviderReset(value, nowMs);
}

export interface ProviderHeaderAdapterInput {
  readonly provider: Exclude<PhysicalConstraintProvider, 'local'>;
  readonly accountId?: string | null;
  readonly proxyId?: string | null;
  readonly lane?: string | null;
  readonly model?: string | null;
  readonly headers: Headers | Readonly<Record<string, string | string[] | undefined>>;
  readonly observedAtMs?: number;
  readonly collectedAtMs?: number;
  readonly nowMs?: number;
  readonly sourceId?: string;
  readonly freshForMs?: number;
}

export interface ProviderWindowReading {
  readonly provider: Exclude<PhysicalConstraintProvider, 'local'>;
  readonly accountId: string | null;
  readonly window: ProviderWindow;
  readonly utilization: number | null;
  readonly resetAtMs: number | null;
  readonly state: PhysicalConstraintState;
  readonly observedAtMs: number;
  readonly validUntilMs: number | null;
}

export interface ProviderHeaderAdapterResult {
  readonly schemaVersion: typeof GATEWAY_PHYSICAL_CONSTRAINT_SCHEMA_VERSION;
  readonly provider: Exclude<PhysicalConstraintProvider, 'local'>;
  readonly accountId: string | null;
  readonly windows: readonly ProviderWindowReading[];
  readonly observations: readonly PhysicalConstraintObservation[];
}

interface ParsedProviderWindow {
  window: ProviderWindow;
  utilization?: number;
  resetAtMs?: number;
  evidence: string[];
}

function parsedWindowsForProvider(
  provider: Exclude<PhysicalConstraintProvider, 'local'>,
  headers: Record<string, string | undefined>,
  nowMs: number,
): ParsedProviderWindow[] {
  const out: ParsedProviderWindow[] = [];
  if (provider === 'anthropic') {
    const five = parseUnifiedWindow(headers);
    const seven = parseUnified7dWindow(headers);
    if (five.utilization !== undefined || five.windowResetAt !== undefined) {
      out.push({
        window: '5h',
        ...(five.utilization !== undefined ? { utilization: five.utilization } : {}),
        ...(five.windowResetAt !== undefined ? { resetAtMs: five.windowResetAt } : {}),
        evidence: ['anthropic-ratelimit-unified-5h-*'],
      });
    }
    if (seven.utilization7d !== undefined || seven.windowResetAt7d !== undefined) {
      out.push({
        window: '7d',
        ...(seven.utilization7d !== undefined ? { utilization: seven.utilization7d } : {}),
        ...(seven.windowResetAt7d !== undefined ? { resetAtMs: seven.windowResetAt7d } : {}),
        evidence: ['anthropic-ratelimit-unified-7d-*'],
      });
    }
    // A response can carry only retry-after. Keep it as a reset observation,
    // but do not manufacture a utilization value from it.
    if (out.length === 0) {
      const parsed = parseRateReset(headers, nowMs);
      if (parsed.resetAt !== undefined || parsed.retryAfterMs !== undefined) {
        out.push({
          window: 'unknown',
          ...(parsed.resetAt !== undefined
            ? { resetAtMs: parsed.resetAt }
            : parsed.retryAfterMs !== undefined
              ? { resetAtMs: nowMs + parsed.retryAfterMs }
              : {}),
          evidence: ['retry-after-or-provider-reset'],
        });
      }
    }
  } else if (provider === 'codex') {
    const codex = parseCodexRateLimitHeaders(headers, nowMs);
    if (codex.utilization !== undefined || codex.windowResetAt !== undefined) {
      out.push({
        window: '5h',
        ...(codex.utilization !== undefined ? { utilization: codex.utilization } : {}),
        ...(codex.windowResetAt !== undefined ? { resetAtMs: codex.windowResetAt } : {}),
        evidence: ['x-codex-*-used-percent', 'x-codex-*-reset-*'],
      });
    }
    if (codex.utilization7d !== undefined || codex.windowResetAt7d !== undefined) {
      out.push({
        window: '7d',
        ...(codex.utilization7d !== undefined ? { utilization: codex.utilization7d } : {}),
        ...(codex.windowResetAt7d !== undefined ? { resetAtMs: codex.windowResetAt7d } : {}),
        evidence: ['x-codex-*-used-percent', 'x-codex-*-reset-*'],
      });
    }
    // A backend may emit a reset without a used-percent value while a window is
    // warming.  Preserve that external timestamp as an observed (but
    // utilization-unknown) window instead of dropping the only evidence.
    const seenWindows = new Set(out.map((row) => row.window));
    for (const prefix of ['x-codex-primary', 'x-codex-secondary'] as const) {
      const minutes = headerNumber(headers, `${prefix}-window-minutes`);
      const resetLiterals = [headers[`${prefix}-reset-at`], headers[`${prefix}-reset-after-seconds`]];
      // Codex uses a zero reset/window pair to mean that the slot is inactive.
      // Do not turn that sentinel into a measured reset-at-now row merely
      // because the generic parser quite correctly accepts a zero duration.
      const resetAt = resetLiterals
        .map((raw) => parseCodexReset(raw, nowMs))
        .find((value): value is number => value !== undefined);
      if (resetAt === undefined) continue;
      const window: ProviderWindow =
        finite(minutes) && minutes > 0 && minutes <= 720 ? '5h' : finite(minutes) && minutes > 720 ? '7d' : 'unknown';
      if (seenWindows.has(window)) continue;
      seenWindows.add(window);
      out.push({ window, resetAtMs: resetAt, evidence: ['x-codex-*-reset-*'] });
    }
  } else {
    const requestLimit = headerNumber(headers, 'x-ratelimit-limit-requests', 'x-ratelimit-limit-request');
    const requestRemaining = headerNumber(headers, 'x-ratelimit-remaining-requests', 'x-ratelimit-remaining-request');
    const requestReset = parseProviderReset(
      headers['x-ratelimit-reset-requests'] ?? headers['x-ratelimit-reset'],
      nowMs,
    );
    if (requestLimit !== undefined || requestRemaining !== undefined || requestReset !== undefined) {
      const utilization =
        requestLimit !== undefined && requestLimit > 0 && requestRemaining !== undefined
          ? Math.max(0, Math.min(1, 1 - requestRemaining / requestLimit))
          : undefined;
      out.push({
        window: 'requests',
        ...(utilization !== undefined ? { utilization } : {}),
        ...(requestReset !== undefined ? { resetAtMs: requestReset } : {}),
        evidence: ['x-ratelimit-limit/remaining/reset-requests'],
      });
    }
    const tokenLimit = headerNumber(headers, 'x-ratelimit-limit-tokens');
    const tokenRemaining = headerNumber(headers, 'x-ratelimit-remaining-tokens');
    const tokenReset = parseProviderReset(headers['x-ratelimit-reset-tokens'], nowMs);
    if (tokenLimit !== undefined || tokenRemaining !== undefined || tokenReset !== undefined) {
      const utilization =
        tokenLimit !== undefined && tokenLimit > 0 && tokenRemaining !== undefined
          ? Math.max(0, Math.min(1, 1 - tokenRemaining / tokenLimit))
          : undefined;
      out.push({
        window: 'tokens',
        ...(utilization !== undefined ? { utilization } : {}),
        ...(tokenReset !== undefined ? { resetAtMs: tokenReset } : {}),
        evidence: ['x-ratelimit-limit/remaining/reset-tokens'],
      });
    }
  }
  return out;
}

function providerHasWindowReset(
  provider: Exclude<PhysicalConstraintProvider, 'local'>,
  headers: Record<string, string | undefined>,
  nowMs: number,
): boolean {
  if (Object.keys(parseRateReset(headers, nowMs)).length > 0) return true;
  if (provider === 'codex') {
    return [
      'x-codex-primary-reset-at',
      'x-codex-primary-reset-after-seconds',
      'x-codex-secondary-reset-at',
      'x-codex-secondary-reset-after-seconds',
    ].some((name) => parseCodexReset(headers[name], nowMs) !== undefined);
  }
  if (provider === 'openai') {
    return ['x-ratelimit-reset-requests', 'x-ratelimit-reset-tokens', 'x-ratelimit-reset'].some(
      (name) => parseProviderReset(headers[name], nowMs) !== undefined,
    );
  }
  return false;
}

/**
 * Adapt provider response headers.  A missing header is represented by an
 * explicit unknown row; a header older than `freshForMs` is stale.  Neither is
 * converted to utilization 0 or a synthetic reset.
 */
export function adaptProviderHeaders(input: ProviderHeaderAdapterInput): ProviderHeaderAdapterResult {
  const nowMs = input.nowMs ?? Date.now();
  const headers = headerObject(input.headers);
  const parsed = parsedWindowsForProvider(input.provider, headers, nowMs);
  const windows = parsed.length > 0 ? parsed : [{ window: 'unknown' as const, evidence: ['provider-headers-absent'] }];
  const scope: PhysicalConstraintScope = {
    provider: input.provider,
    ...(text(input.accountId) ? { accountId: input.accountId! } : {}),
    ...(text(input.proxyId) ? { proxyId: input.proxyId! } : {}),
    ...(text(input.lane) ? { lane: input.lane! } : {}),
    ...(text(input.model) ? { model: input.model! } : {}),
  };
  const observations: PhysicalConstraintObservation[] = [];
  const windowReadings: ProviderWindowReading[] = [];
  for (const row of windows) {
    const utilization = row.utilization;
    const utilObservation = makeObservation(
      {
        key: 'provider.utilization',
        kind: 'provider-window',
        source: 'provider',
        sourceId: input.sourceId ?? `provider:${input.provider}:${input.accountId ?? 'pool'}`,
        scope,
        window: row.window,
        value: utilization ?? null,
        unit: 'fraction',
        // A utilization value at/over the provider's own window is a measured
        // external contract.  It is not a local cap and has no effect while stale.
        constraint: utilization !== undefined && utilization >= 0.97,
        binding: 'external-physical-contract',
        causalRole: 'cause',
        actionable: utilization !== undefined && utilization >= 0.97,
        confidence: utilization === undefined ? 0 : 1,
        observedAtMs: input.observedAtMs,
        collectedAtMs: input.collectedAtMs,
        freshForMs: input.freshForMs ?? PROVIDER_CONSTRAINT_FRESH_FOR_MS,
        reason: utilization === undefined ? 'provider-utilization-header-absent' : null,
        evidence: row.evidence,
      },
      nowMs,
    );
    observations.push(utilObservation);
    const resetObservation = makeObservation(
      {
        key: 'provider.reset',
        kind: 'provider-window',
        source: 'provider',
        sourceId: input.sourceId ?? `provider:${input.provider}:${input.accountId ?? 'pool'}`,
        scope,
        window: row.window,
        value: row.resetAtMs ?? null,
        unit: 'epoch-ms',
        constraint: false,
        binding: 'external-physical-contract',
        causalRole: 'context',
        actionable: false,
        confidence: row.resetAtMs === undefined ? 0 : 1,
        observedAtMs: input.observedAtMs,
        collectedAtMs: input.collectedAtMs,
        freshForMs: input.freshForMs ?? PROVIDER_CONSTRAINT_FRESH_FOR_MS,
        reason: row.resetAtMs === undefined ? 'provider-reset-header-absent' : null,
        evidence: row.evidence,
      },
      nowMs,
    );
    observations.push(resetObservation);
    const windowState: PhysicalConstraintState =
      utilObservation.state === 'stale' || resetObservation.state === 'stale'
        ? 'stale'
        : utilObservation.state === 'measured' || resetObservation.state === 'measured'
          ? 'measured'
          : 'unknown';
    const validUntilCandidates = [utilObservation.expiresAtMs, resetObservation.expiresAtMs].filter(
      (value): value is number => value !== null,
    );
    windowReadings.push(
      Object.freeze({
        provider: input.provider,
        accountId: text(input.accountId) ?? null,
        window: row.window,
        utilization:
          utilObservation.state === 'measured' && typeof utilObservation.value === 'number'
            ? utilObservation.value
            : null,
        resetAtMs:
          resetObservation.state === 'measured' && typeof resetObservation.value === 'number'
            ? resetObservation.value
            : null,
        state: windowState,
        observedAtMs: utilObservation.observedAtMs,
        validUntilMs: validUntilCandidates.length > 0 ? Math.min(...validUntilCandidates) : null,
      }),
    );
  }
  return Object.freeze({
    schemaVersion: GATEWAY_PHYSICAL_CONSTRAINT_SCHEMA_VERSION,
    provider: input.provider,
    accountId: text(input.accountId) ?? null,
    windows: Object.freeze(windowReadings),
    observations: Object.freeze(observations),
  });
}

/** Array-shaped convenience for callers that only need observations. */
export function providerHeaderObservations(
  input: ProviderHeaderAdapterInput,
): readonly PhysicalConstraintObservation[] {
  return adaptProviderHeaders(input).observations;
}

export interface ProviderPoolContext {
  readonly accountIds?: readonly string[];
  readonly healthyAccountIds?: readonly string[];
  readonly failedAccountIds?: readonly string[];
  readonly proxyIds?: readonly string[];
  readonly allAccountsFailed?: boolean;
}

export interface ProviderOutcomeInput {
  readonly provider: Exclude<PhysicalConstraintProvider, 'local'>;
  readonly accountId?: string | null;
  readonly proxyId?: string | null;
  readonly lane?: string | null;
  readonly model?: string | null;
  readonly status?: number;
  readonly outcome?: 'success' | 'rate-limit' | 'overload' | 'stall' | 'transport-error' | 'error';
  readonly error?: unknown;
  readonly headers?: Headers | Readonly<Record<string, string | string[] | undefined>>;
  readonly origin?: 'upstream' | 'gateway';
  readonly synthetic?: boolean;
  readonly usageCap?: boolean;
  readonly bareBurst?: boolean;
  readonly poolWide?: boolean;
  readonly xShouldRetry?: boolean;
  readonly msSinceReadmit?: number;
  readonly pool?: ProviderPoolContext;
  readonly observedAtMs?: number;
  readonly collectedAtMs?: number;
  readonly nowMs?: number;
  readonly sourceId?: string;
  readonly freshForMs?: number;
}

export interface ProviderOutcomeAdapterResult {
  readonly schemaVersion: typeof GATEWAY_PHYSICAL_CONSTRAINT_SCHEMA_VERSION;
  readonly shape: Gateway429Shape | null;
  readonly coldRestCause: ColdRest429Cause | null;
  readonly attribution: GatewayCausalAttribution;
  readonly observations: readonly PhysicalConstraintObservation[];
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return String((error as { message?: unknown } | null)?.message ?? error ?? '');
  } catch {
    return '';
  }
}

function isStallOutcome(input: ProviderOutcomeInput): boolean {
  if (input.outcome === 'stall' || input.outcome === 'transport-error') return true;
  return /stall|timeout|timed out|econn|enet|socket|premature|aborted|reset/i.test(errorText(input.error));
}

function poolWideFromContext(input: ProviderOutcomeInput): boolean {
  if (input.poolWide === true || input.pool?.allAccountsFailed === true) return true;
  const ids = input.pool?.accountIds ?? [];
  const healthy = new Set(input.pool?.healthyAccountIds ?? []);
  // An account list by itself is not evidence that every account failed.  Only
  // an explicitly supplied healthy-account snapshot (including an empty one)
  // can establish pool-wide pressure.
  if (input.pool?.healthyAccountIds !== undefined && ids.length > 1 && healthy.size === 0) return true;
  const failed = new Set(input.pool?.failedAccountIds ?? []);
  return ids.length > 1 && ids.every((id) => failed.has(id));
}

function outcomeKind(input: ProviderOutcomeInput): 'success' | 'rate-limit' | 'overload' | 'stall' | 'error' {
  if (input.synthetic || input.origin === 'gateway') {
    if (input.status === 429) return 'rate-limit';
    if (input.outcome === 'transport-error') return 'stall';
    return input.outcome ?? 'error';
  }
  if (input.outcome) return input.outcome === 'transport-error' ? 'stall' : input.outcome;
  if (input.status !== undefined) {
    if (input.status >= 200 && input.status < 400) return 'success';
    if (input.status === 429) return 'rate-limit';
    if (input.status === 529) return 'overload';
  }
  if (isStallOutcome(input)) return 'stall';
  return 'error';
}

/**
 * Attribute one provider outcome.  The order is deliberate: a synthetic gateway
 * response is local policy, a transport failure with a proxy is a proxy fault, a
 * 529 is provider/pool overload, and only then do we use account/window evidence
 * for a 429.  This prevents a single bad account from shrinking a healthy pool.
 */
export function attributeProviderOutcome(input: ProviderOutcomeInput): GatewayCausalAttribution {
  const kind = outcomeKind(input);
  const provider = input.provider;
  const accountId = text(input.accountId) ?? null;
  const proxyId = text(input.proxyId) ?? null;
  const headers = input.headers ? headerObject(input.headers) : {};
  const nowMs = input.nowMs ?? Date.now();
  const hasWindowReset = providerHasWindowReset(input.provider, headers, nowMs);
  const utilization = parseUnifiedWindow(headers).utilization;
  const shape =
    input.status === 429
      ? classify429Shape({
          status: 429,
          isUsageCap: input.usageCap === true || /usage|limit|capacity/i.test(errorText(input.error)),
          bare:
            input.bareBurst === true || (input.bareBurst !== false && !hasWindowReset && input.xShouldRetry !== false),
          hasWindowReset,
          unifiedRejected: utilization !== undefined && utilization >= 0.97,
        })
      : null;
  const coldRestCause =
    shape && input.status === 429 && input.msSinceReadmit !== undefined
      ? classifyColdRest429({
          shape,
          msSinceReadmit: input.msSinceReadmit,
          windowMs: 120_000,
          utilization5h: utilization,
          highUtil: 0.8,
        })
      : null;
  if (input.synthetic || input.origin === 'gateway') {
    return Object.freeze({
      scope: 'local-policy',
      subjectId: null,
      provider,
      externalPhysicalContract: false,
      actionable: false,
      confidence: 1,
      reason: 'gateway-generated response reflects local policy, not provider pressure',
      evidence: ['gateway-origin-or-synthetic-outcome'],
    });
  }
  if (kind === 'stall' && proxyId) {
    return Object.freeze({
      scope: 'proxy',
      subjectId: proxyId,
      provider,
      externalPhysicalContract: true,
      actionable: true,
      confidence: 0.95,
      reason: 'transport stalled on one identified egress/proxy route',
      evidence: ['transport-stall', `proxy:${proxyId}`],
    });
  }
  if (kind === 'stall') {
    return Object.freeze({
      scope: 'provider',
      subjectId: null,
      provider,
      externalPhysicalContract: true,
      actionable: true,
      confidence: 0.7,
      reason: 'transport/provider stall observed without an identified proxy',
      evidence: ['transport-stall', 'proxy-unidentified'],
    });
  }
  if (kind === 'overload') {
    return Object.freeze({
      scope: poolWideFromContext(input) ? 'pool' : 'provider',
      subjectId: null,
      provider,
      externalPhysicalContract: true,
      actionable: true,
      confidence: 0.95,
      reason: '529 is an upstream server-overload response, not an account quota signal',
      evidence: ['upstream-status:529'],
    });
  }
  if (kind === 'rate-limit') {
    if (coldRestCause === 'edge-not-account' && proxyId) {
      return Object.freeze({
        scope: 'proxy',
        subjectId: proxyId,
        provider,
        externalPhysicalContract: true,
        actionable: true,
        confidence: 0.9,
        reason: 'bare 429 persisted immediately after a cold rest with account headroom; edge/proxy is implicated',
        evidence: ['bare-burst-429', 'cold-rest', 'low-account-utilization', `proxy:${proxyId}`],
      });
    }
    if (poolWideFromContext(input)) {
      return Object.freeze({
        scope: 'pool',
        subjectId: null,
        provider,
        externalPhysicalContract: true,
        actionable: true,
        confidence: 0.9,
        reason: 'all observed provider accounts failed the same rate-limit outcome',
        evidence: ['upstream-status:429', 'pool-wide-account-failure'],
      });
    }
    if (
      accountId &&
      (shape === 'usage-cap' || shape === 'rate-window' || shape === 'unified-5h-rejected' || !input.pool)
    ) {
      return Object.freeze({
        scope: 'account',
        subjectId: accountId,
        provider,
        externalPhysicalContract: true,
        actionable: true,
        confidence: shape === 'unclassified' ? 0.65 : 0.95,
        reason: 'rate-limit evidence is scoped to one provider account',
        evidence: ['upstream-status:429', `account:${accountId}`, ...(shape ? [`shape:${shape}`] : [])],
      });
    }
    if (proxyId && shape === 'bare-burst') {
      return Object.freeze({
        scope: 'proxy',
        subjectId: proxyId,
        provider,
        externalPhysicalContract: true,
        actionable: true,
        confidence: 0.75,
        reason: 'bare burst-throttle has no account-window evidence and is tied to one proxy',
        evidence: ['bare-burst-429', `proxy:${proxyId}`],
      });
    }
    return Object.freeze({
      scope: accountId ? 'account' : 'provider',
      subjectId: accountId,
      provider,
      externalPhysicalContract: true,
      actionable: !!accountId,
      confidence: accountId ? 0.6 : 0.5,
      reason: accountId ? 'account identified but pool context is incomplete' : 'rate-limit account scope is unknown',
      evidence: ['upstream-status:429', ...(accountId ? [`account:${accountId}`] : ['account-unidentified'])],
    });
  }
  if (kind === 'success') {
    return Object.freeze({
      scope: accountId ? 'account' : 'provider',
      subjectId: accountId,
      provider,
      externalPhysicalContract: true,
      actionable: false,
      confidence: 1,
      reason: 'successful upstream outcome is healthy evidence, not pressure',
      evidence: ['upstream-success'],
    });
  }
  return Object.freeze({
    scope: accountId ? 'account' : 'unknown',
    subjectId: accountId,
    provider,
    externalPhysicalContract: true,
    actionable: false,
    confidence: 0,
    reason: 'provider failure could not be classified from the supplied evidence',
    evidence: ['outcome-unclassified'],
  });
}

/** Adapt one status/error outcome into a freshness-aware constraint row. */
export function adaptProviderOutcome(input: ProviderOutcomeInput): ProviderOutcomeAdapterResult {
  const nowMs = input.nowMs ?? Date.now();
  const kind = outcomeKind(input);
  const attribution = attributeProviderOutcome(input);
  const headers = input.headers ? headerObject(input.headers) : {};
  const shape =
    input.status === 429
      ? classify429Shape({
          status: 429,
          isUsageCap: input.usageCap === true || /usage|limit|capacity/i.test(errorText(input.error)),
          bare:
            input.bareBurst === true ||
            (input.bareBurst !== false &&
              !providerHasWindowReset(input.provider, headers, nowMs) &&
              input.xShouldRetry !== false),
          hasWindowReset: providerHasWindowReset(input.provider, headers, nowMs),
          unifiedRejected: (parseUnifiedWindow(headers).utilization ?? 0) >= 0.97,
        })
      : null;
  const coldRestCause =
    shape && input.msSinceReadmit !== undefined
      ? classifyColdRest429({
          shape,
          msSinceReadmit: input.msSinceReadmit,
          windowMs: 120_000,
          utilization5h: parseUnifiedWindow(headers).utilization,
          highUtil: 0.8,
        })
      : null;
  const scope: PhysicalConstraintScope = {
    provider: input.provider,
    ...(text(input.accountId) ? { accountId: input.accountId! } : {}),
    ...(text(input.proxyId) ? { proxyId: input.proxyId! } : {}),
    ...(text(input.lane) ? { lane: input.lane! } : {}),
    ...(text(input.model) ? { model: input.model! } : {}),
  };
  const synthetic = input.synthetic === true || input.origin === 'gateway';
  let key: PhysicalConstraintKey;
  let source: PhysicalConstraintSource;
  let kindName: PhysicalConstraintKind;
  let unit: PhysicalConstraintUnit = 'boolean';
  let healthSignal: LiveHealthSignalKey | undefined;
  switch (kind) {
    case 'rate-limit':
      key = synthetic ? 'gateway.policy' : 'provider.rateLimit';
      source = synthetic ? 'gateway-transport' : 'provider';
      kindName = synthetic ? 'gateway-policy' : 'provider-outcome';
      healthSignal = synthetic ? undefined : 'provider.rateLimited';
      break;
    case 'overload':
      key = 'provider.overload';
      source = 'provider';
      kindName = 'provider-outcome';
      break;
    case 'stall':
      key = input.proxyId ? 'transport.stall' : 'provider.stall';
      source = input.proxyId ? 'gateway-transport' : 'provider';
      kindName = input.proxyId ? 'transport-outcome' : 'provider-outcome';
      break;
    case 'success':
      key = 'provider.error';
      source = 'provider';
      kindName = 'provider-outcome';
      break;
    default:
      key = 'provider.error';
      source = 'provider';
      kindName = 'provider-outcome';
      break;
  }
  const observation = makeObservation(
    {
      key,
      kind: kindName,
      source,
      sourceId: input.sourceId ?? `${source}:${input.provider}:${input.accountId ?? 'pool'}`,
      scope,
      state: input.outcome || input.status !== undefined || input.error ? 'measured' : 'unknown',
      value: kind === 'success' ? false : kind === 'error' ? null : true,
      unit,
      constraint: kind !== 'success' && kind !== 'error',
      binding: synthetic
        ? 'local-policy'
        : kind === 'success'
          ? 'external-physical-contract'
          : 'external-physical-contract',
      causalRole: kind === 'success' ? 'context' : 'outcome',
      actionable: attribution.actionable,
      confidence: attribution.confidence,
      observedAtMs: input.observedAtMs,
      collectedAtMs: input.collectedAtMs,
      freshForMs:
        input.freshForMs ??
        (source === 'gateway-transport' ? TRANSPORT_CONSTRAINT_FRESH_FOR_MS : PROVIDER_CONSTRAINT_FRESH_FOR_MS),
      reason: kind === 'error' ? attribution.reason : null,
      evidence: [...(input.status !== undefined ? [`upstream-status:${input.status}`] : []), ...attribution.evidence],
      healthSignal,
    },
    nowMs,
  );
  const observations = input.headers
    ? [
        ...adaptProviderHeaders({
          provider: input.provider,
          accountId: input.accountId,
          proxyId: input.proxyId,
          lane: input.lane,
          model: input.model,
          headers: input.headers,
          observedAtMs: input.observedAtMs,
          collectedAtMs: input.collectedAtMs,
          nowMs,
          sourceId: input.sourceId,
          freshForMs: input.freshForMs,
        }).observations,
        observation,
      ]
    : [observation];
  return Object.freeze({
    schemaVersion: GATEWAY_PHYSICAL_CONSTRAINT_SCHEMA_VERSION,
    shape,
    coldRestCause,
    attribution,
    observations: Object.freeze(observations),
  });
}

export const adaptGatewayOutcome = adaptProviderOutcome;

export interface GatewayTransportStats {
  readonly totalRequests?: number;
  readonly upstreamErrors?: number;
  readonly upstream429?: number;
  readonly queued429?: number;
  readonly shed429?: number;
  readonly shedAllThrottled?: number;
  readonly stallsRecorded?: number;
  readonly slotReconcileMismatch?: number;
  readonly egressProxyHealth?: {
    readonly totalProxyEntries?: number;
    readonly reachableProxyEntries?: number;
    readonly allDown?: boolean;
    readonly configured?: boolean;
  };
  readonly egressFailRateByAccount?: Readonly<Record<string, number>>;
  readonly edgeThrottleByAccount?: Readonly<
    Record<string, { edgeThrottled?: boolean; cooledIpCount?: number; cooldownUntil?: number }>
  >;
  readonly unified?: {
    utilization?: number;
    observedAt?: number;
    staleAsOfMs?: number;
    resetAt?: number;
    rejectedActuallyEnforced?: boolean;
  };
  readonly db?: Pick<
    DbHealthSnapshot,
    'ok' | 'observed' | 'connectionLevel' | 'lastError' | 'lastOkAt' | 'lastFailureAt'
  >;
}

export interface GatewayTransportAdapterInput {
  readonly stats: GatewayTransportStats;
  readonly prior?: GatewayTransportStats;
  readonly observedAtMs?: number;
  readonly collectedAtMs?: number;
  readonly nowMs?: number;
  readonly sourceId?: string;
  readonly provider?: Exclude<PhysicalConstraintProvider, 'local'>;
  readonly freshForMs?: number;
}

function counterDelta(current: number | undefined, prior: number | undefined): number | null {
  // Gateway counters are monotonic, non-negative totals.  Treat a reset,
  // negative sample, or non-finite value as an unknown delta rather than
  // manufacturing a positive event from corrupt telemetry.
  const currentValue = nonNegative(current);
  const priorValue = nonNegative(prior);
  if (currentValue === undefined || priorValue === undefined || currentValue < priorValue) return null;
  return currentValue - priorValue;
}

/**
 * Adapt cumulative gateway counters.  A first sample is explicitly unknown for
 * delta-derived outcomes: zero is not evidence that no stall/429 occurred.
 */
export function adaptGatewayTransport(input: GatewayTransportAdapterInput): readonly PhysicalConstraintObservation[] {
  const nowMs = input.nowMs ?? Date.now();
  const stats = input.stats;
  const prior = input.prior;
  const sourceId = input.sourceId ?? 'gateway-transport:stats';
  const out: PhysicalConstraintObservation[] = [];
  const deltaRows: Array<{
    key: PhysicalConstraintKey;
    field: keyof GatewayTransportStats;
    source: PhysicalConstraintSource;
    kind: PhysicalConstraintKind;
    evidence: string;
    healthSignal?: LiveHealthSignalKey;
  }> = [
    {
      key: 'transport.stall',
      field: 'upstreamErrors',
      source: 'gateway-transport',
      kind: 'transport-outcome',
      evidence: 'upstream-error-counter',
    },
    {
      key: 'provider.rateLimit',
      field: 'upstream429',
      source: 'provider',
      kind: 'provider-outcome',
      evidence: 'upstream-429-counter',
      healthSignal: 'provider.rateLimited',
    },
    {
      key: 'gateway.policy',
      field: 'shed429',
      source: 'gateway-transport',
      kind: 'gateway-policy',
      evidence: 'gateway-shed-429-counter',
    },
    {
      key: 'transport.stall',
      field: 'stallsRecorded',
      source: 'gateway-transport',
      kind: 'transport-outcome',
      evidence: 'stall-event-counter',
    },
  ];
  for (const row of deltaRows) {
    const delta = counterDelta(stats[row.field] as number | undefined, prior?.[row.field] as number | undefined);
    out.push(
      makeObservation(
        {
          key: row.key,
          kind: row.kind,
          source: row.source,
          sourceId: `${sourceId}:${row.field}`,
          scope: { ...(input.provider ? { provider: input.provider } : {}) },
          state: delta === null ? 'unknown' : 'measured',
          value: delta === null ? null : delta,
          unit: 'count',
          constraint: delta !== null && delta > 0,
          binding: row.key === 'gateway.policy' ? 'local-policy' : 'external-physical-contract',
          causalRole: 'outcome',
          actionable: delta !== null && delta > 0 && row.key !== 'gateway.policy',
          confidence: delta === null ? 0 : 1,
          observedAtMs: input.observedAtMs,
          collectedAtMs: input.collectedAtMs,
          freshForMs: input.freshForMs ?? TRANSPORT_CONSTRAINT_FRESH_FOR_MS,
          reason: delta === null ? 'counter-delta-needs-prior-sample' : null,
          evidence: [row.evidence],
          healthSignal: row.healthSignal,
        },
        nowMs,
      ),
    );
  }
  const proxy = stats.egressProxyHealth;
  const proxyCountsValid =
    proxy?.configured === true &&
    nonNegative(proxy.totalProxyEntries) !== undefined &&
    nonNegative(proxy.reachableProxyEntries) !== undefined &&
    proxy.reachableProxyEntries! <= proxy.totalProxyEntries!;
  if (proxyCountsValid) {
    const total = nonNegative(proxy!.totalProxyEntries)!;
    const reachable = nonNegative(proxy!.reachableProxyEntries)!;
    out.push(
      makeObservation(
        {
          key: 'transport.proxyReachability',
          kind: 'transport-outcome',
          source: 'gateway-transport',
          sourceId,
          value: reachable > 0,
          unit: 'boolean',
          constraint: reachable === 0 && total > 0,
          binding: 'external-physical-contract',
          causalRole: 'cause',
          actionable: reachable === 0 && total > 0,
          observedAtMs: input.observedAtMs,
          collectedAtMs: input.collectedAtMs,
          freshForMs: input.freshForMs ?? TRANSPORT_CONSTRAINT_FRESH_FOR_MS,
          evidence: [`proxy-reachability:${reachable}/${total}`],
        },
        nowMs,
      ),
    );
  } else {
    // No configured proxy path is not healthy proxy evidence.  It remains unknown.
    out.push(
      makeObservation(
        {
          key: 'transport.proxyReachability',
          kind: 'transport-outcome',
          source: 'gateway-transport',
          sourceId,
          state: 'unknown',
          value: null,
          unit: 'boolean',
          constraint: false,
          binding: 'external-physical-contract',
          actionable: false,
          reason:
            proxy?.configured === false
              ? 'proxy-egress-not-configured'
              : proxy?.configured === true
                ? 'proxy-reachability-invalid-or-unobserved'
                : 'proxy-reachability-unobserved',
          evidence: ['proxy-population-not-judged'],
        },
        nowMs,
      ),
    );
  }
  for (const [accountId, rate] of Object.entries(stats.egressFailRateByAccount ?? {})) {
    const valid = finite(rate) && rate >= 0 && rate <= 1;
    out.push(
      makeObservation(
        {
          key: 'transport.proxyFailureRate',
          kind: 'transport-outcome',
          source: 'gateway-transport',
          sourceId,
          scope: { accountId },
          state: valid ? 'measured' : 'unknown',
          value: valid ? rate : null,
          unit: 'fraction',
          constraint: valid && rate > 0.5,
          binding: 'external-physical-contract',
          causalRole: 'cause',
          actionable: valid && rate > 0.5,
          confidence: valid ? 1 : 0,
          observedAtMs: input.observedAtMs,
          collectedAtMs: input.collectedAtMs,
          freshForMs: input.freshForMs ?? TRANSPORT_CONSTRAINT_FRESH_FOR_MS,
          reason: valid ? null : 'proxy-failure-rate-invalid',
          evidence: ['egress-failures/attempts'],
        },
        nowMs,
      ),
    );
  }
  // The edge-throttle map is already scoped to an account by the gateway's
  // routing writer.  Preserve that narrow scope instead of turning a single
  // cooled IP into pool-wide provider pressure.
  for (const [accountId, edge] of Object.entries(stats.edgeThrottleByAccount ?? {})) {
    const edgeThrottled = edge.edgeThrottled === true;
    out.push(
      makeObservation(
        {
          key: 'transport.proxyFailureRate',
          kind: 'transport-outcome',
          source: 'gateway-transport',
          sourceId: `${sourceId}:edge:${accountId}`,
          scope: { accountId },
          state: 'measured',
          value: edgeThrottled ? 1 : 0,
          unit: 'fraction',
          constraint: edgeThrottled,
          binding: 'external-physical-contract',
          causalRole: 'cause',
          actionable: edgeThrottled,
          confidence: 1,
          observedAtMs: input.observedAtMs,
          collectedAtMs: input.collectedAtMs,
          freshForMs: input.freshForMs ?? TRANSPORT_CONSTRAINT_FRESH_FOR_MS,
          evidence: [
            'edge-throttle-by-account',
            ...(finite(edge.cooledIpCount) ? [`cooled-ip-count:${edge.cooledIpCount}`] : []),
          ],
        },
        nowMs,
      ),
    );
  }
  if (finite(stats.slotReconcileMismatch) && stats.slotReconcileMismatch > 0) {
    out.push(
      makeObservation(
        {
          key: 'transport.slotLeak',
          kind: 'gateway-policy',
          source: 'gateway-transport',
          sourceId,
          value: stats.slotReconcileMismatch,
          unit: 'count',
          constraint: true,
          binding: 'local-policy',
          causalRole: 'outcome',
          actionable: false,
          evidence: ['slot-reconcile-mismatch'],
        },
        nowMs,
      ),
    );
  }
  if (stats.unified) {
    const observedAt = stats.unified.observedAt;
    const util = stats.unified.utilization;
    const validUtilization = nonNegative(util) !== undefined;
    const validObservedAt = finite(observedAt);
    out.push(
      makeObservation(
        {
          key: 'provider.utilization',
          kind: 'provider-window',
          source: 'provider',
          sourceId,
          scope: { ...(input.provider ? { provider: input.provider } : {}) },
          window: '5h',
          state: !validObservedAt || !validUtilization ? 'unknown' : 'measured',
          value: !validObservedAt || !validUtilization ? null : util,
          unit: 'fraction',
          constraint: validUtilization && util! >= 0.97 && stats.unified.rejectedActuallyEnforced === true,
          binding: 'external-physical-contract',
          causalRole: 'cause',
          actionable: validUtilization && util! >= 0.97 && stats.unified.rejectedActuallyEnforced === true,
          observedAtMs: observedAt,
          collectedAtMs: nowMs,
          freshForMs: input.freshForMs ?? PROVIDER_CONSTRAINT_FRESH_FOR_MS,
          reason: !validObservedAt
            ? 'unified-reading-observation-time-absent'
            : !validUtilization
              ? 'unified-reading-utilization-invalid'
              : null,
          evidence: ['gateway-stats.unified'],
        },
        nowMs,
      ),
    );
  }
  if (stats.db) {
    // `ok:true, observed:false` is the DB writer's boot sentinel.  Do not let
    // that sentinel become measured healthy evidence in the adapter.  Older
    // deploy-skew stats may omit `observed`; timestamps are the conservative
    // fallback for deciding whether any DB outcome exists.
    const dbObserved =
      stats.db.observed === true ||
      (stats.db.observed === undefined && (stats.db.lastOkAt !== null || stats.db.lastFailureAt !== null));
    out.push(
      ...adaptOperationalHealth({
        nowMs,
        database: {
          ok: dbObserved ? stats.db.ok : undefined,
          observedAtMs: stats.db.lastFailureAt ?? stats.db.lastOkAt ?? undefined,
          writerId: `${sourceId}:db`,
        },
      }),
    );
  }
  return Object.freeze(out);
}

export const adaptGatewayTransportStats = adaptGatewayTransport;

export interface LocalBackendEngineTelemetry {
  readonly reported?: boolean;
  readonly authoritative?: boolean;
  readonly totalSlots?: number | null;
  readonly freeSlots?: number | null;
  readonly contextTokens?: number | null;
  readonly observedAtMs?: number;
  readonly source?: string;
}

export interface LocalBackendTelemetryInput {
  readonly backend: Pick<LocalBackend, 'id' | 'kind' | 'enabled' | 'maxConcurrent'> | LocalBackend;
  readonly model?: string | null;
  readonly inFlight?: number;
  readonly health?: LocalBackendHealth | null;
  readonly engine?: LocalBackendEngineTelemetry | null;
  readonly observedAtMs?: number;
  readonly collectedAtMs?: number;
  readonly nowMs?: number;
  readonly sourceId?: string;
  readonly freshForMs?: number;
}

/**
 * Adapt one local backend.  `maxConcurrent` is retained as local policy only;
 * it becomes a physical constraint only when the backend engine reports slots
 * (for example llama-server `/props`) with an observation timestamp.
 */
export function adaptLocalBackendTelemetry(
  input: LocalBackendTelemetryInput,
): readonly PhysicalConstraintObservation[] {
  const nowMs = input.nowMs ?? Date.now();
  const backend = input.backend;
  const sourceId = input.sourceId ?? `local-backend:${backend.id}`;
  const observedAt = input.observedAtMs ?? input.health?.lastCheckedAt ?? input.engine?.observedAtMs;
  const out: PhysicalConstraintObservation[] = [];
  const health = input.health;
  out.push(
    makeObservation(
      {
        key: 'backend.health',
        kind: 'backend-health',
        source: 'local-backend',
        sourceId,
        scope: { backendId: backend.id },
        state: health && typeof health.healthy === 'boolean' ? 'measured' : 'unknown',
        value: health && typeof health.healthy === 'boolean' ? health.healthy : null,
        unit: 'boolean',
        constraint: health?.healthy === false,
        binding: 'external-physical-contract',
        causalRole: 'cause',
        actionable: health?.healthy === false,
        confidence: health ? 1 : 0,
        observedAtMs: observedAt,
        collectedAtMs: input.collectedAtMs,
        freshForMs: input.freshForMs ?? BACKEND_CONSTRAINT_FRESH_FOR_MS,
        reason: health ? health.error : 'backend-health-unobserved',
        evidence: health ? [`health-check:${health.lastCheckedAt}`] : ['backend-health-missing'],
      },
      nowMs,
    ),
  );
  const engine = input.engine;
  // Supplying an engine telemetry object is itself an assertion that the
  // reading came from the engine.  Callers may explicitly mark it `reported:
  // false` while a probe is unavailable; never infer physics from the registry
  // `maxConcurrent` value alone.
  const engineAuthoritative =
    engine !== null &&
    engine !== undefined &&
    engine.reported !== false &&
    (engine.reported === true ||
      engine.authoritative === true ||
      finite(engine.totalSlots) ||
      finite(engine.freeSlots) ||
      finite(engine.contextTokens) ||
      text(engine.source) !== undefined);
  if (engineAuthoritative) {
    const freeSlots = nonNegative(engine?.freeSlots);
    const contextTokens = nonNegative(engine?.contextTokens);
    out.push(
      makeObservation(
        {
          key: 'backend.slots',
          kind: 'backend-slots',
          source: 'local-backend',
          sourceId,
          scope: { backendId: backend.id, ...(text(input.model) ? { model: input.model! } : {}) },
          state: freeSlots !== undefined ? 'measured' : 'unknown',
          value: freeSlots ?? null,
          unit: 'slots',
          constraint: freeSlots !== undefined && freeSlots <= 0,
          binding: 'external-physical-contract',
          causalRole: 'cause',
          actionable: freeSlots !== undefined && freeSlots <= 0,
          confidence: freeSlots !== undefined ? 1 : 0,
          observedAtMs: engine?.observedAtMs ?? observedAt,
          collectedAtMs: input.collectedAtMs,
          freshForMs: input.freshForMs ?? BACKEND_CONSTRAINT_FRESH_FOR_MS,
          reason: freeSlots !== undefined ? null : 'engine-free-slots-invalid-or-unobserved',
          evidence: [engine?.source ?? 'engine-reported-slots'],
        },
        nowMs,
      ),
    );
    out.push(
      makeObservation(
        {
          key: 'backend.context',
          kind: 'backend-context',
          source: 'local-backend',
          sourceId,
          scope: { backendId: backend.id, ...(text(input.model) ? { model: input.model! } : {}) },
          state: contextTokens !== undefined ? 'measured' : 'unknown',
          value: contextTokens ?? null,
          unit: 'count',
          constraint: false,
          binding: 'external-physical-contract',
          causalRole: 'context',
          actionable: false,
          confidence: contextTokens !== undefined ? 1 : 0,
          observedAtMs: engine?.observedAtMs ?? observedAt,
          collectedAtMs: input.collectedAtMs,
          freshForMs: input.freshForMs ?? BACKEND_CONSTRAINT_FRESH_FOR_MS,
          reason: contextTokens !== undefined ? null : 'engine-context-invalid-or-unobserved',
          evidence: [engine?.source ?? 'engine-reported-context'],
        },
        nowMs,
      ),
    );
  } else {
    // Keep the physical dimension explicit and unknown.  Falling back to the
    // registered maxConcurrent here would turn local policy into fake physics.
    out.push(
      makeObservation(
        {
          key: 'backend.slots',
          kind: 'backend-slots',
          source: 'local-backend',
          sourceId,
          scope: { backendId: backend.id },
          state: 'unknown',
          value: null,
          unit: 'slots',
          constraint: false,
          binding: 'external-physical-contract',
          actionable: false,
          reason: 'engine-slot-contract-unobserved',
          evidence: ['configured-maxConcurrent-is-local-policy'],
        },
        nowMs,
      ),
    );
  }
  const inFlight = nonNegative(input.inFlight);
  if (inFlight !== undefined) {
    out.push(
      makeObservation(
        {
          key: 'backend.inFlight',
          kind: 'backend-slots',
          source: 'local-backend',
          sourceId,
          scope: { backendId: backend.id },
          value: inFlight,
          unit: 'count',
          constraint: false,
          binding: 'context-only',
          causalRole: 'context',
          actionable: false,
          observedAtMs: input.observedAtMs,
          collectedAtMs: input.collectedAtMs,
          freshForMs: input.freshForMs ?? BACKEND_CONSTRAINT_FRESH_FOR_MS,
          evidence: ['local-pool-inFlight'],
        },
        nowMs,
      ),
    );
  }
  // Expose the configured value for diagnostics, but mark it unmistakably as
  // policy so a controller cannot contract on it as physical evidence.
  out.push(
    makeObservation(
      {
        key: 'backend.policySlots',
        kind: 'gateway-policy',
        source: 'local-backend',
        sourceId,
        scope: { backendId: backend.id },
        value: nonNegative(backend.maxConcurrent) ?? null,
        unit: 'slots',
        constraint: false,
        binding: 'local-policy',
        causalRole: 'context',
        actionable: false,
        confidence: nonNegative(backend.maxConcurrent) !== undefined ? 1 : 0,
        observedAtMs: input.observedAtMs,
        collectedAtMs: input.collectedAtMs,
        freshForMs: input.freshForMs ?? BACKEND_CONSTRAINT_FRESH_FOR_MS,
        reason:
          nonNegative(backend.maxConcurrent) !== undefined
            ? 'registered-maxConcurrent-is-policy-not-engine-contract'
            : 'registered-maxConcurrent-invalid-policy-value',
        evidence: ['local-backend-registry'],
      },
      nowMs,
    ),
  );
  return Object.freeze(out);
}

export const adaptLocalBackendHealth = adaptLocalBackendTelemetry;

/** Read the process-local pool without mutating selection/counters. */
export function adaptLocalBackendPool(
  pool: LocalBackendPool,
  options: {
    readonly nowMs?: number;
    readonly collectedAtMs?: number;
    readonly sourceId?: string;
    readonly engineTelemetry?:
      | Readonly<Record<string, LocalBackendEngineTelemetry>>
      | ((backend: LocalBackend) => LocalBackendEngineTelemetry | null | undefined);
    readonly freshForMs?: number;
  } = {},
): readonly PhysicalConstraintObservation[] {
  const nowMs = options.nowMs ?? Date.now();
  const health = pool.health();
  const observations: PhysicalConstraintObservation[] = [];
  for (const backend of pool.entries()) {
    const engine =
      typeof options.engineTelemetry === 'function'
        ? options.engineTelemetry(backend)
        : options.engineTelemetry?.[backend.id];
    observations.push(
      ...adaptLocalBackendTelemetry({
        backend,
        inFlight: pool.inFlight(backend.id),
        health: health.get(backend.id) ?? null,
        engine,
        nowMs,
        collectedAtMs: options.collectedAtMs,
        sourceId: options.sourceId ?? `local-backend:${backend.id}`,
        freshForMs: options.freshForMs,
      }),
    );
  }
  return Object.freeze(observations);
}

export interface OperationalHealthInput {
  readonly database?: {
    readonly snapshot?: DbHealthSnapshot | null;
    readonly ok?: boolean;
    readonly observedAtMs?: number;
    readonly waitP95Ms?: number | null;
    readonly writerId?: string;
  };
  readonly service?: {
    readonly ok?: boolean;
    readonly observedAtMs?: number;
    readonly waitP95Ms?: number | null;
    readonly writerId?: string;
  };
  readonly queue?: {
    readonly ok?: boolean;
    readonly observedAtMs?: number;
    readonly writerLatencyP95Ms?: number | null;
    readonly writerFailureRate?: number | null;
    readonly depth?: number | null;
    readonly writerId?: string;
  };
  readonly governor?: {
    readonly ok?: boolean;
    readonly observedAtMs?: number;
    readonly admissionLatencyP95Ms?: number | null;
    readonly decisionLatencyP95Ms?: number | null;
    readonly persistLatencyP95Ms?: number | null;
    readonly writerId?: string;
  };
  readonly liveHealth?: LiveHealthSnapshot | null;
  readonly nowMs?: number;
  readonly collectedAtMs?: number;
  readonly freshForMs?: number;
}

function operationalRow(
  source: PhysicalConstraintSource,
  key: PhysicalConstraintKey,
  kind: PhysicalConstraintKind,
  value: PhysicalConstraintValue | null | undefined,
  input: {
    observedAtMs?: number;
    writerId?: string;
    ok?: boolean;
    reason?: string;
    healthSignal?: LiveHealthSignalKey;
  },
  nowMs: number,
  freshForMs: number,
  unit: PhysicalConstraintUnit,
  constraintWhen: (value: PhysicalConstraintValue | null | undefined, ok: boolean | undefined) => boolean,
  binding: PhysicalConstraintBinding = 'transient-feedback',
): PhysicalConstraintObservation {
  // Operational writers publish non-negative durations/rates/counters.  A
  // negative numeric sample is malformed telemetry, not a healthy zero.
  const suppliedValue = value !== null && value !== undefined;
  const hasValue = suppliedValue && (typeof value !== 'number' || nonNegative(value) !== undefined);
  const invalidValueReason = suppliedValue && !hasValue ? 'operational-reading-invalid-value' : undefined;
  const state: PhysicalConstraintState = hasValue || input.ok !== undefined ? 'measured' : 'unknown';
  return makeObservation(
    {
      key,
      kind,
      source,
      sourceId: input.writerId ?? `${source}:unidentified`,
      state,
      value: hasValue ? value! : null,
      unit,
      constraint: constraintWhen(hasValue ? value! : null, input.ok),
      binding,
      causalRole: constraintWhen(hasValue ? value! : null, input.ok) ? 'cause' : 'context',
      actionable: constraintWhen(hasValue ? value! : null, input.ok) && binding === 'external-physical-contract',
      confidence: state === 'measured' ? 1 : 0,
      observedAtMs: input.observedAtMs,
      collectedAtMs: nowMs,
      freshForMs,
      reason:
        invalidValueReason ??
        (hasValue || input.ok !== undefined ? null : (input.reason ?? 'operational-reading-unobserved')),
      evidence: [source],
      healthSignal: input.healthSignal,
    },
    nowMs,
  );
}

/** Adapt DB/service/queue/governor writers while keeping queue depth and host metrics contextual. */
export function adaptOperationalHealth(input: OperationalHealthInput): readonly PhysicalConstraintObservation[] {
  const nowMs = input.nowMs ?? Date.now();
  const freshForMs = input.freshForMs ?? OPERATIONAL_CONSTRAINT_FRESH_FOR_MS;
  const out: PhysicalConstraintObservation[] = [];
  const db = input.database;
  if (db) {
    const snapshot = db.snapshot;
    const observedAt = db.observedAtMs ?? snapshot?.lastFailureAt ?? snapshot?.lastOkAt ?? undefined;
    // DbHealthSnapshot intentionally reports `ok:true` before its first
    // observation.  That sentinel is not healthy evidence for this adapter.
    const observed = snapshot?.observed !== false;
    const ok = observed ? (db.ok ?? snapshot?.ok) : undefined;
    out.push(
      operationalRow(
        'database',
        'database.health',
        'database-health',
        ok === undefined ? null : ok,
        {
          observedAtMs: observedAt,
          writerId: db.writerId ?? 'database:health',
          ok,
          reason: snapshot?.observed === false ? 'database-writer-has-no-observation' : undefined,
        },
        nowMs,
        freshForMs,
        'boolean',
        (_value, healthy) => healthy === false,
        'external-physical-contract',
      ),
    );
    out.push(
      operationalRow(
        'database',
        'database.waitP95Ms',
        'database-health',
        db.waitP95Ms,
        {
          observedAtMs: observedAt,
          writerId: db.writerId ?? 'database:health',
          reason: 'database-wait-p95-unobserved',
          healthSignal: 'database.waitP95Ms',
        },
        nowMs,
        freshForMs,
        'milliseconds',
        () => false,
      ),
    );
  }
  const service = input.service;
  if (service) {
    out.push(
      operationalRow(
        'service',
        'service.health',
        'service-health',
        service.ok,
        {
          observedAtMs: service.observedAtMs,
          writerId: service.writerId ?? 'service:health',
          ok: service.ok,
        },
        nowMs,
        freshForMs,
        'boolean',
        (_value, healthy) => healthy === false,
        'external-physical-contract',
      ),
    );
    out.push(
      operationalRow(
        'service',
        'service.waitP95Ms',
        'service-health',
        service.waitP95Ms,
        {
          observedAtMs: service.observedAtMs,
          writerId: service.writerId ?? 'service:health',
          healthSignal: 'service.waitP95Ms',
        },
        nowMs,
        freshForMs,
        'milliseconds',
        () => false,
      ),
    );
  }
  const queue = input.queue;
  if (queue) {
    out.push(
      operationalRow(
        'queue',
        'queue.health',
        'queue-health',
        queue.ok,
        {
          observedAtMs: queue.observedAtMs,
          writerId: queue.writerId ?? 'queue:health',
          ok: queue.ok,
        },
        nowMs,
        freshForMs,
        'boolean',
        (_value, healthy) => healthy === false,
        'external-physical-contract',
      ),
    );
    out.push(
      operationalRow(
        'queue',
        'queue.writerLatencyP95Ms',
        'queue-health',
        queue.writerLatencyP95Ms,
        {
          observedAtMs: queue.observedAtMs,
          writerId: queue.writerId ?? 'queue:health',
          healthSignal: 'queue.writerLatencyP95Ms',
        },
        nowMs,
        freshForMs,
        'milliseconds',
        () => false,
      ),
    );
    out.push(
      operationalRow(
        'queue',
        'queue.writerFailureRate',
        'queue-health',
        queue.writerFailureRate,
        {
          observedAtMs: queue.observedAtMs,
          writerId: queue.writerId ?? 'queue:health',
          healthSignal: 'queue.writerFailureRate',
        },
        nowMs,
        freshForMs,
        'percent',
        (value) => typeof value === 'number' && value > 0,
      ),
    );
    // Queue depth is intentionally context-only.  It cannot contract admission
    // without a service-objective breach and causal evidence from a writer.
    out.push(
      operationalRow(
        'queue',
        'queue.depth',
        'queue-health',
        queue.depth,
        {
          observedAtMs: queue.observedAtMs,
          writerId: queue.writerId ?? 'queue:health',
        },
        nowMs,
        freshForMs,
        'count',
        () => false,
        'context-only',
      ),
    );
  }
  const governor = input.governor;
  if (governor) {
    out.push(
      operationalRow(
        'governor',
        'governor.health',
        'governor-health',
        governor.ok,
        {
          observedAtMs: governor.observedAtMs,
          writerId: governor.writerId ?? 'governor:health',
          ok: governor.ok,
        },
        nowMs,
        freshForMs,
        'boolean',
        (_value, healthy) => healthy === false,
        'transient-feedback',
      ),
    );
    for (const [key, value, healthSignal] of [
      ['governor.admissionLatencyP95Ms', governor.admissionLatencyP95Ms, 'governor.admissionLatencyP95Ms'],
      ['governor.decisionLatencyP95Ms', governor.decisionLatencyP95Ms, 'governor.decisionLatencyP95Ms'],
      ['governor.persistLatencyP95Ms', governor.persistLatencyP95Ms, 'governor.persistLatencyP95Ms'],
    ] as const) {
      out.push(
        operationalRow(
          'governor',
          key,
          'governor-health',
          value,
          {
            observedAtMs: governor.observedAtMs,
            writerId: governor.writerId ?? 'governor:health',
            healthSignal,
          },
          nowMs,
          freshForMs,
          'milliseconds',
          () => false,
        ),
      );
    }
  }
  if (input.liveHealth) out.push(...adaptLiveHealthSnapshot(input.liveHealth, nowMs));
  return Object.freeze(out);
}

const LIVE_HEALTH_TO_CONSTRAINT: Partial<
  Record<
    LiveHealthSignalKey,
    {
      key: PhysicalConstraintKey;
      source: PhysicalConstraintSource;
      kind: PhysicalConstraintKind;
      binding: PhysicalConstraintBinding;
      healthSignal?: LiveHealthSignalKey;
    }
  >
> = Object.freeze({
  'provider.waitP95Ms': {
    key: 'provider.error',
    source: 'provider',
    kind: 'provider-outcome',
    binding: 'external-physical-contract',
    healthSignal: 'provider.waitP95Ms',
  },
  'provider.rateLimited': {
    key: 'provider.rateLimit',
    source: 'provider',
    kind: 'provider-outcome',
    binding: 'external-physical-contract',
    healthSignal: 'provider.rateLimited',
  },
  'database.waitP95Ms': {
    key: 'database.waitP95Ms',
    source: 'database',
    kind: 'database-health',
    binding: 'external-physical-contract',
    healthSignal: 'database.waitP95Ms',
  },
  'service.waitP95Ms': {
    key: 'service.waitP95Ms',
    source: 'service',
    kind: 'service-health',
    binding: 'external-physical-contract',
    healthSignal: 'service.waitP95Ms',
  },
  'queue.writerLatencyP95Ms': {
    key: 'queue.writerLatencyP95Ms',
    source: 'queue',
    kind: 'queue-health',
    binding: 'external-physical-contract',
    healthSignal: 'queue.writerLatencyP95Ms',
  },
  'queue.writerFailureRate': {
    key: 'queue.writerFailureRate',
    source: 'queue',
    kind: 'queue-health',
    binding: 'external-physical-contract',
    healthSignal: 'queue.writerFailureRate',
  },
  'queue.oldestAgeMs': {
    key: 'queue.depth',
    source: 'queue',
    kind: 'queue-health',
    binding: 'context-only',
    healthSignal: 'queue.oldestAgeMs',
  },
  'queue.arrivalRate': {
    key: 'queue.depth',
    source: 'queue',
    kind: 'queue-health',
    binding: 'context-only',
    healthSignal: 'queue.arrivalRate',
  },
  'governor.admissionLatencyP95Ms': {
    key: 'governor.admissionLatencyP95Ms',
    source: 'governor',
    kind: 'governor-health',
    binding: 'transient-feedback',
    healthSignal: 'governor.admissionLatencyP95Ms',
  },
  'governor.decisionLatencyP95Ms': {
    key: 'governor.decisionLatencyP95Ms',
    source: 'governor',
    kind: 'governor-health',
    binding: 'transient-feedback',
    healthSignal: 'governor.decisionLatencyP95Ms',
  },
  'governor.persistLatencyP95Ms': {
    key: 'governor.persistLatencyP95Ms',
    source: 'governor',
    kind: 'governor-health',
    binding: 'transient-feedback',
    healthSignal: 'governor.persistLatencyP95Ms',
  },
  'memory.hostUsedBytes': {
    key: 'memory.workingSetBytes',
    source: 'memory',
    kind: 'host-context',
    binding: 'context-only',
  },
  'memory.workingSetBytes': {
    key: 'memory.workingSetBytes',
    source: 'memory',
    kind: 'host-context',
    binding: 'context-only',
  },
  'cpu.hostUtilizationPct': { key: 'cpu.pressure', source: 'monitor', kind: 'host-context', binding: 'context-only' },
  'cpu.processUtilizationPct': {
    key: 'cpu.pressure',
    source: 'monitor',
    kind: 'host-context',
    binding: 'context-only',
  },
});

function physicalUnitForLiveHealth(unit: LiveHealthReading['unit']): PhysicalConstraintUnit {
  // Keep the unit from the canonical live-health contract.  In particular,
  // queue arrival rate is requests/second; silently coercing every non-byte,
  // non-boolean value to milliseconds makes a typed observation lie.
  switch (unit) {
    case 'boolean':
      return 'boolean';
    case 'bytes':
      return 'bytes';
    case 'bytes-per-second':
      return 'bytes-per-second';
    case 'milliseconds':
      return 'milliseconds';
    case 'percent':
      return 'percent';
    case 'requests-per-second':
      return 'requests-per-second';
    default:
      return 'unknown';
  }
}

/** Preserve the live-health writer's measured/unknown/stale state verbatim. */
export function adaptLiveHealthSnapshot(
  snapshot: LiveHealthSnapshot,
  nowMs = Date.now(),
): readonly PhysicalConstraintObservation[] {
  const out: PhysicalConstraintObservation[] = [];
  const readings: Array<[LiveHealthSignalKey, LiveHealthReading]> = [];
  const signalKeys = new Set<LiveHealthSignalKey>([
    ...(Object.keys(snapshot.signals ?? {}) as LiveHealthSignalKey[]),
    ...(Object.keys(snapshot.observations ?? {}) as LiveHealthSignalKey[]),
  ]);
  for (const rawKey of signalKeys) {
    const scoped = Object.values(snapshot.observations?.[rawKey] ?? {});
    // Prefer writer-scoped observations so two providers/processes remain
    // attributable.  The compact signal is only a fallback for old snapshots
    // that predate the observations map.
    if (scoped.length > 0) {
      for (const reading of scoped) readings.push([rawKey, reading]);
    } else {
      const reading = snapshot.signals[rawKey];
      if (reading) readings.push([rawKey, reading]);
    }
  }
  for (const [rawKey, reading] of readings) {
    const mapping = LIVE_HEALTH_TO_CONSTRAINT[rawKey];
    if (!mapping) continue;
    const spec = LIVE_HEALTH_SIGNAL_SPECS[rawKey];
    const isBoolean = spec.unit === 'boolean';
    const value =
      reading.state === 'measured' &&
      (isBoolean ? typeof reading.value === 'boolean' : typeof reading.value === 'number')
        ? reading.value
        : null;
    out.push(
      makeObservation(
        {
          key: mapping.key,
          kind: mapping.kind,
          source: mapping.source,
          sourceId: reading.writerId,
          state: reading.state,
          value,
          unit: physicalUnitForLiveHealth(spec.unit),
          constraint: mapping.binding !== 'context-only' && rawKey === 'provider.rateLimited' && value === true,
          binding: mapping.binding,
          causalRole: mapping.binding === 'context-only' ? 'context' : 'cause',
          actionable:
            mapping.binding === 'external-physical-contract' && rawKey === 'provider.rateLimited' && value === true,
          confidence: reading.confidence,
          observedAtMs: reading.observedAtMs,
          collectedAtMs: nowMs,
          freshForMs: spec.freshForMs,
          reason: reading.reason,
          evidence: [`live-health:${rawKey}`, `writer:${reading.writerId}`],
          healthSignal: mapping.healthSignal,
        },
        nowMs,
      ),
    );
  }
  return Object.freeze(out);
}

export interface GatewayPhysicalConstraintInput {
  readonly providerHeaders?: readonly ProviderHeaderAdapterInput[];
  readonly providerOutcomes?: readonly ProviderOutcomeInput[];
  readonly transport?: GatewayTransportAdapterInput;
  readonly localBackends?: readonly LocalBackendTelemetryInput[];
  readonly localBackendPool?: LocalBackendPool;
  readonly localBackendPoolOptions?: Parameters<typeof adaptLocalBackendPool>[1];
  readonly operational?: OperationalHealthInput;
  readonly liveHealth?: LiveHealthSnapshot | null;
  readonly nowMs?: number;
}

function dedupeObservations(observations: readonly PhysicalConstraintObservation[]): PhysicalConstraintObservation[] {
  const byId = new Map<string, PhysicalConstraintObservation>();
  for (const observation of observations) {
    const current = byId.get(observation.id);
    if (!current) {
      byId.set(observation.id, observation);
      continue;
    }
    // Prefer fresh measured evidence, then the newest collection.  An unknown
    // row can never overwrite a measured row merely because it was emitted later.
    const rank = (row: PhysicalConstraintObservation): number =>
      (row.state === 'measured' ? 3 : row.state === 'stale' ? 2 : 1) * 1_000_000_000 + row.collectedAtMs;
    if (rank(observation) >= rank(current)) byId.set(observation.id, observation);
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function verdictForObservations(
  observations: readonly PhysicalConstraintObservation[],
  attributions: readonly GatewayCausalAttribution[],
  nowMs: number,
): PhysicalConstraintVerdict {
  const refreshed = observations.map((row) => refreshPhysicalConstraint(row, nowMs));
  const actionable = refreshed.filter((row) => row.actionable && row.state === 'measured');
  // `constraint` is the physical verdict; `actionable` is deliberately
  // narrower because an otherwise real pressure signal may lack enough scope
  // to target a single account/proxy.  Keep those concepts separate so an
  // unscoped upstream 429 is still reported as constrained rather than
  // reassuringly healthy.
  const physicalConstraints = refreshed.filter(
    (row) => row.state === 'measured' && row.constraint && row.binding === 'external-physical-contract',
  );
  // Context-only readings (CPU/RAM/queue depth) and local policy rows are
  // useful diagnostics, but their presence is not proof that physical health
  // has been measured.  Exclude context-only rows from the overall health state
  // so an otherwise silent writer remains unknown rather than reassuringly
  // healthy.
  const measured = refreshed.filter(
    (row) => row.state === 'measured' && row.binding !== 'context-only' && row.binding !== 'local-policy',
  );
  const stale = refreshed.filter(
    (row) => row.state === 'stale' && row.binding !== 'context-only' && row.binding !== 'local-policy',
  );
  const constrained = physicalConstraints.length > 0;
  let state: PhysicalConstraintVerdict['state'];
  if (constrained) state = 'constrained';
  else if (measured.length > 0) state = 'healthy';
  else if (stale.length > 0) state = 'stale';
  else state = 'unknown';
  const resources = [...new Set(actionable.map((row) => row.source))].sort() as PhysicalConstraintSource[];
  const reasons = constrained
    ? physicalConstraints.map((row) => `${row.id}: ${row.reason ?? 'fresh external constraint'}`)
    : state === 'healthy'
      ? ['fresh observations contain no actionable external constraint']
      : state === 'stale'
        ? ['all available observations are stale; refresh before changing admission']
        : ['no measured physical evidence is available'];
  return Object.freeze({
    schemaVersion: GATEWAY_PHYSICAL_CONSTRAINT_SCHEMA_VERSION,
    evaluatedAtMs: nowMs,
    state,
    constrained,
    actionable: actionable.length > 0,
    observations: Object.freeze(refreshed),
    attributions: Object.freeze([...attributions]),
    actionableResources: Object.freeze(resources),
    reasons: Object.freeze(reasons),
  });
}

/** Collect every gateway writer into one typed, freshness-aware verdict. */
export function collectGatewayPhysicalConstraints(
  input: GatewayPhysicalConstraintInput,
): GatewayPhysicalConstraintSnapshot {
  const nowMs = input.nowMs ?? input.operational?.nowMs ?? Date.now();
  const observations: PhysicalConstraintObservation[] = [];
  const attributions: GatewayCausalAttribution[] = [];
  for (const headers of input.providerHeaders ?? [])
    observations.push(...adaptProviderHeaders({ ...headers, nowMs }).observations);
  for (const outcome of input.providerOutcomes ?? []) {
    const adapted = adaptProviderOutcome({ ...outcome, nowMs });
    observations.push(...adapted.observations);
    attributions.push(adapted.attribution);
  }
  if (input.transport) observations.push(...adaptGatewayTransport({ ...input.transport, nowMs }));
  for (const backend of input.localBackends ?? [])
    observations.push(...adaptLocalBackendTelemetry({ ...backend, nowMs }));
  if (input.localBackendPool)
    observations.push(...adaptLocalBackendPool(input.localBackendPool, { ...input.localBackendPoolOptions, nowMs }));
  if (input.operational)
    observations.push(
      ...adaptOperationalHealth({ ...input.operational, nowMs }).filter(
        (row) => row.source !== 'monitor' || !input.liveHealth,
      ),
    );
  if (input.liveHealth && !input.operational?.liveHealth)
    observations.push(...adaptLiveHealthSnapshot(input.liveHealth, nowMs));
  const verdict = verdictForObservations(dedupeObservations(observations), attributions, nowMs);
  return Object.freeze({ ...verdict, verdict });
}

export const adaptGatewayPhysicalConstraints = collectGatewayPhysicalConstraints;
export const evaluatePhysicalConstraints = (
  observations: readonly PhysicalConstraintObservation[],
  attributions: readonly GatewayCausalAttribution[] = [],
  nowMs = Date.now(),
): PhysicalConstraintVerdict => verdictForObservations(observations, attributions, nowMs);

const CONSTRAINT_TO_HEALTH_SIGNAL: Partial<Record<PhysicalConstraintKey, LiveHealthSignalKey>> = Object.freeze({
  'provider.rateLimit': 'provider.rateLimited',
  'provider.error': 'provider.waitP95Ms',
  'database.waitP95Ms': 'database.waitP95Ms',
  'service.waitP95Ms': 'service.waitP95Ms',
  'queue.writerLatencyP95Ms': 'queue.writerLatencyP95Ms',
  'queue.writerFailureRate': 'queue.writerFailureRate',
  'governor.admissionLatencyP95Ms': 'governor.admissionLatencyP95Ms',
  'governor.decisionLatencyP95Ms': 'governor.decisionLatencyP95Ms',
  'governor.persistLatencyP95Ms': 'governor.persistLatencyP95Ms',
});

function liveReadingFromConstraint(
  row: PhysicalConstraintObservation,
  signal: LiveHealthSignalKey,
  nowMs: number,
): LiveHealthReading {
  const spec = LIVE_HEALTH_SIGNAL_SPECS[signal];
  const window = liveHealthWindow(spec.windowKind, row.observedAtMs, row.collectedAtMs);
  if (row.state === 'unknown') {
    return unknownLiveHealthReading({
      key: signal,
      writerId: row.sourceId,
      observedAtMs: row.observedAtMs,
      collectedAtMs: nowMs,
      window,
      reason: row.reason ?? 'constraint-observation-unknown',
    });
  }
  if (row.state === 'stale') {
    const staleValue =
      spec.unit === 'boolean'
        ? typeof row.value === 'boolean'
          ? row.value
          : false
        : typeof row.value === 'number' && finite(row.value)
          ? row.value
          : 0;
    const measured = measuredLiveHealthReading({
      key: signal,
      value: staleValue,
      writerId: row.sourceId,
      observedAtMs: row.observedAtMs,
      collectedAtMs: row.collectedAtMs,
      window,
      confidence: row.confidence,
    });
    return staleLiveHealthReading(signal, measured, nowMs, row.reason ?? 'freshness-window-expired');
  }
  let value: number | boolean;
  if (spec.unit === 'boolean') value = typeof row.value === 'boolean' ? row.value : false;
  else if (typeof row.value === 'number' && finite(row.value)) value = row.value;
  else {
    return unknownLiveHealthReading({
      key: signal,
      writerId: row.sourceId,
      observedAtMs: row.observedAtMs,
      collectedAtMs: nowMs,
      window,
      reason: 'constraint-value-unit-mismatch',
    });
  }
  return measuredLiveHealthReading({
    key: signal,
    value,
    writerId: row.sourceId,
    observedAtMs: row.observedAtMs,
    collectedAtMs: row.collectedAtMs,
    window,
    confidence: row.confidence,
  });
}

/** Convert adapter rows to the canonical analyzer frame without inventing missing signals. */
export function physicalConstraintsToHealthFrame(
  observations: readonly PhysicalConstraintObservation[],
  scopeId: string,
  atMs = Date.now(),
): HealthAnalysisFrame {
  const signals: Partial<Record<LiveHealthSignalKey, LiveHealthReading>> = {};
  for (const row of observations) {
    const signal = row.healthSignal ?? CONSTRAINT_TO_HEALTH_SIGNAL[row.key];
    if (!signal) continue;
    const current = signals[signal];
    if (current && current.observedAtMs > row.observedAtMs) continue;
    signals[signal] = liveReadingFromConstraint(row, signal, atMs);
  }
  return Object.freeze({ scopeId, atMs, signals: Object.freeze(signals) });
}

export interface GatewayPhysicalHealthEvaluation {
  readonly physical: GatewayPhysicalConstraintSnapshot;
  readonly frame: HealthAnalysisFrame;
  readonly health: HealthVerdict;
}

/** One convenience composition for callers that want both physical and governor verdicts. */
export function evaluateGatewayPhysicalHealth(
  input: GatewayPhysicalConstraintInput,
  scopeId = 'inference-gateway',
  analyzer = new RollingHealthAnalyzer(),
): GatewayPhysicalHealthEvaluation {
  const physical = collectGatewayPhysicalConstraints(input);
  const frame = physicalConstraintsToHealthFrame(physical.observations, scopeId, physical.evaluatedAtMs);
  return Object.freeze({ physical, frame, health: analyzer.evaluate(frame) });
}

// Short aliases used by callers that describe this layer as an adapter rather
// than a constraint collector.
export const adaptProviderHeadersToConstraints = adaptProviderHeaders;
export const adaptProviderOutcomeToConstraints = adaptProviderOutcome;
export const adaptLocalBackendToConstraints = adaptLocalBackendTelemetry;
export const adaptOperationalHealthToConstraints = adaptOperationalHealth;
export const collectPhysicalConstraints = collectGatewayPhysicalConstraints;
