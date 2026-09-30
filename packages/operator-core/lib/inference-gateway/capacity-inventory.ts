/**
 * Capless inference-gateway writer inventory (capless-inference-gateway-2026-08-28, P-001).
 *
 * This is deliberately a small, typed census of the places that can currently make a
 * gateway throughput number look like capacity.  The inventory is not a second governor
 * and it does not decide whether a value is safe at runtime.  It records the writer,
 * units, live effect, disposition, and the deletion/recurrence proof that the migration
 * must carry.  Keeping the evidence next to the writer list prevents a new constant or
 * derived clamp from arriving without an owner and a removal plan.
 */

export const INFERENCE_GATEWAY_CAPACITY_INVENTORY_SCHEMA_VERSION =
  'inference-gateway-capacity-inventory-v1' as const;

export type CapacityWriterDisposition =
  | 'remove'
  | 'transient-feedback'
  | 'explicit-control-recovery-bypass'
  | 'semantic-protocol-safety'
  | 'measured-external-physical-contract';

export type CapacityWriterDimension =
  | 'claude-admission'
  | 'codex-admission'
  | 'local-backend'
  | 'provider'
  | 'queue'
  | 'priority'
  | 'resource-profile'
  | 'deployment'
  | 'status';

export type CapacityWriterSourceKind = 'code' | 'deployment' | 'status-reader';

export interface InferenceGatewayCapacityWriter {
  readonly id: string;
  /** Repository-relative path of the exact production writer. */
  readonly file: string;
  /** Symbol or route/field that owns the write. */
  readonly symbol: string;
  /** A source fragment that must remain present while this row is live. */
  readonly sourceAnchor: string;
  readonly sourceKind: CapacityWriterSourceKind;
  readonly dimensions: readonly CapacityWriterDimension[];
  /** Unit/scale of the value (for example, requests, slots, milliseconds, or a fraction). */
  readonly units: string;
  /** Runtime owner responsible for changing or deleting the writer. */
  readonly owner: string;
  /** What the writer does today, including whether it binds admission or only reports it. */
  readonly liveEffect: string;
  /** The observed literal/formula, or null when the writer is a projection/reader. */
  readonly currentValue: number | string | null;
  readonly disposition: CapacityWriterDisposition;
  /** Plan item / release target that removes or reclassifies the writer. */
  readonly deletionTarget: string;
  /** Test or guard that must remain green after the writer is migrated. */
  readonly recurrenceTest: string;
  /** Durable source that should replace a local ceiling or seed. */
  readonly durableSource: string;
  /** Signal that explains how the value is measured/freshened. */
  readonly telemetry: string;
  /** Request/queue/status context in which the number is consumed. */
  readonly contextPath: string;
  /** Optional fan-out or consumer note. */
  readonly fanOut?: string;
}

function writer(
  row: Omit<InferenceGatewayCapacityWriter, 'dimensions'> & {
    dimensions: readonly CapacityWriterDimension[];
  },
): InferenceGatewayCapacityWriter {
  return Object.freeze({ ...row, dimensions: Object.freeze([...row.dimensions]) });
}

const GATEWAY = 'packages/operator-core/lib/inference-gateway/gateway.ts';
const LIFECYCLE = 'packages/operator-core/lib/inference-gateway/provider-admission-lifecycle.ts';
const LAUNCH = 'packages/operator-core/lib/inference-gateway/launch.ts';
const SIDECAR = 'packages/operator-core/lib/inference-gateway/sidecar-main.ts';
const PRIORITY = 'libs/papercusp-shared/src/resilience/priority-admission.ts';
const AIMD = 'libs/papercusp-shared/src/resilience/aimd-concurrency.ts';
const REGISTRY = 'libs/papercusp-shared/src/agent/governor-registry.ts';
const RATE_LIMIT = 'packages/operator-core/lib/rate-limit-config.ts';
const PROFILE = 'libs/generic/resource-profile/src/index.ts';

/**
 * Exact production writer census.  Rows intentionally include reporting readers: a
 * number that is correctly computed but reported without its binding term is still a
 * capacity bug (D-009).
 */
export const INFERENCE_GATEWAY_CAPACITY_INVENTORY: readonly InferenceGatewayCapacityWriter[] = Object.freeze([
  // P-010 REMOVED four gateway/launch writers — `DEFAULT_CONCURRENCY = 24` (both the
  // gateway copy and launch.ts's mirror), `CODEX_ADMISSION_SLOTS_PER_ACCOUNT = 4`, and
  // the `accountScaledCodexConcurrency` derivation — when Claude and Codex collapsed
  // onto one capless ProviderAdmissionLifecycle. The census tracks LIVE writers, so a
  // deleted writer has no row; their recurrence guard is CAPACITY_WRITER_SYMBOL_PATTERN,
  // which matches *CONCURRENCY* and SLOTS_PER_ACCOUNT, so re-declaring any of them in
  // scope is reported as an unclassified writer and reds this file's census test.
  writer({
    id: 'gateway-aimd-floor',
    file: GATEWAY,
    symbol: 'DEFAULT_AIMD_FLOOR',
    sourceAnchor: 'const DEFAULT_AIMD_FLOOR =',
    sourceKind: 'code',
    dimensions: ['claude-admission', 'codex-admission'],
    units: 'requests in flight',
    owner: 'inference-gateway AIMD adapter',
    liveEffect: 'Prevents learned admission from contracting below a fixed four-request floor.',
    currentValue: 4,
    disposition: 'remove',
    deletionTarget: 'P-005/P-009: expiring controller feedback with no baked productive-capacity floor',
    recurrenceTest: 'capacity-inventory.test.ts source-anchor + unclassified-writer guard',
    durableSource: 'CaplessAdaptiveController minimum/protection state with causal expiry',
    telemetry: 'aimd effective/floor/decrease snapshots and health verdict generation',
    contextPath: 'AimdConcurrencyController construction for Claude and Codex queues',
  }),
  writer({
    id: 'gateway-aimd-decrease-threshold',
    file: GATEWAY,
    symbol: 'DEFAULT_AIMD_DECREASE_THRESHOLD',
    sourceAnchor: 'const DEFAULT_AIMD_DECREASE_THRESHOLD =',
    sourceKind: 'code',
    dimensions: ['claude-admission', 'codex-admission'],
    units: 'net throttle events',
    owner: 'inference-gateway AIMD adapter',
    liveEffect: 'Controls when transient throttle feedback trips a multiplicative contraction.',
    currentValue: 6,
    disposition: 'transient-feedback',
    deletionTarget: 'P-005: move tuning into versioned controller feedback state',
    recurrenceTest: 'capacity-inventory.test.ts source-anchor + AIMD controller tests',
    durableSource: 'health verdicts and scoped contraction feedback',
    telemetry: '429/throttle event stream, controller generation, contraction expiry',
    contextPath: 'AimdConcurrencyController.recordThrottle',
  }),
  writer({
    id: 'gateway-aimd-increase-every',
    file: GATEWAY,
    symbol: 'DEFAULT_AIMD_INCREASE_EVERY',
    sourceAnchor: 'const DEFAULT_AIMD_INCREASE_EVERY =',
    sourceKind: 'code',
    dimensions: ['claude-admission', 'codex-admission'],
    units: 'clean responses per increase',
    owner: 'inference-gateway AIMD adapter',
    liveEffect: 'Controls additive recovery toward the configured cap.',
    currentValue: 8,
    disposition: 'transient-feedback',
    deletionTarget: 'P-005: move recovery cadence into controller feedback state',
    recurrenceTest: 'capacity-inventory.test.ts source-anchor + AIMD controller tests',
    durableSource: 'fresh successful outcome feedback with recovery generation',
    telemetry: 'clean streak/increase count and health freshness',
    contextPath: 'AimdConcurrencyController.recordSuccess',
  }),
  writer({
    id: 'gateway-serviceable-per-account',
    file: GATEWAY,
    symbol: 'PER_ACCOUNT_ADMISSION',
    sourceAnchor: 'const PER_ACCOUNT_ADMISSION =',
    sourceKind: 'code',
    dimensions: ['claude-admission', 'codex-admission'],
    units: 'requests per serviceable account',
    owner: 'inference-gateway serviceability clamp',
    liveEffect: 'Multiplies an in-memory serviceable-account count into a live admission recommendation.',
    currentValue: 4,
    disposition: 'remove',
    deletionTarget: 'P-007: serviceability is routing/causal evidence, not a capacity formula',
    recurrenceTest: 'capacity-inventory.test.ts source-anchor + capless expansion tests',
    durableSource: 'per-class controller state learned from outcomes',
    telemetry: 'serviceability count with observation time and pool generation',
    // P-015 anchor repair: the old value named `applyAdmissionCap`, which exists NOWHERE in the
    // tree (it was deleted with the clamp application path). A dangling anchor is how the next
    // reader concludes the clamp still binds; the real consumer chain is diagnostics-only.
    contextPath: 'serviceableAdmissionCapFn → refreshServiceableDiagnostics → GET /stats clamp.recommendation',
  }),
  writer({
    id: 'gateway-serviceable-minimum',
    file: GATEWAY,
    symbol: 'MIN_SERVICEABLE_ADMISSION',
    sourceAnchor: 'const MIN_SERVICEABLE_ADMISSION =',
    sourceKind: 'code',
    dimensions: ['claude-admission', 'codex-admission'],
    units: 'requests in flight',
    owner: 'inference-gateway serviceability clamp',
    liveEffect: 'Forces a fixed minimum admission even when no serviceable account is observed.',
    currentValue: 2,
    disposition: 'remove',
    deletionTarget: 'P-007: replace with explicit control/recovery bypass and measured feedback',
    recurrenceTest: 'capacity-inventory.test.ts source-anchor + zero-serviceability fixtures',
    durableSource: 'durable queue plus registered control/recovery class',
    telemetry: 'unknown/stale serviceability state, never a synthetic minimum',
    contextPath: 'serviceableAdmissionCapFn',
  }),
  writer({
    id: 'gateway-serviceable-clamp-application',
    file: LIFECYCLE,
    symbol: 'ProviderAdmissionLifecycle#apply',
    sourceAnchor: 'const window = Math.max(this.#minimumWindow, Math.floor(lane.window));',
    sourceKind: 'code',
    dimensions: ['claude-admission', 'codex-admission'],
    units: 'requests in flight',
    owner: 'inference-gateway admission application',
    liveEffect:
      'Applies each lane\'s learned window to its queue, floored at the configured minimum. P-010 replaced the two per-provider apply-closures with this one; the serviceable recommendation is diagnostic only and no longer participates.',
    currentValue: 'max(minimumWindow, learned lane window)',
    disposition: 'remove',
    deletionTarget: 'P-007: remove derived serviceable hard clamp; retain attribution only',
    recurrenceTest: 'capacity-inventory.test.ts source-anchor + admission-ceiling fixtures',
    durableSource: 'CaplessAdaptiveController per-class effective window',
    telemetry: 'binding term, recommendation, applied value, and freshness in status',
    contextPath: 'AIMD onChange / serviceable timer → queue.setMaxConcurrent',
  }),
  writer({
    id: 'gateway-serviceable-clamp-tick',
    file: GATEWAY,
    symbol: 'SERVICEABLE_CLAMP_TICK_MS',
    sourceAnchor: 'const SERVICEABLE_CLAMP_TICK_MS =',
    sourceKind: 'code',
    dimensions: ['claude-admission', 'codex-admission'],
    units: 'milliseconds between observations',
    owner: 'inference-gateway serviceability observer',
    liveEffect: 'Re-applies the serviceability recommendation while AIMD is unchanged.',
    currentValue: 2000,
    disposition: 'transient-feedback',
    deletionTarget: 'P-003/P-007: replace timer-driven clamp with paced live observation',
    recurrenceTest: 'capacity-inventory.test.ts source-anchor + observer lifecycle tests',
    durableSource: 'fresh pool/governor observations with explicit generation',
    telemetry: 'serviceability reading age and pool reload generation',
    contextPath: 'serviceableClampTimer',
  }),
  writer({
    id: 'gateway-max-queued',
    file: GATEWAY,
    symbol: 'DEFAULT_MAX_QUEUED',
    sourceAnchor: 'const DEFAULT_MAX_QUEUED =',
    sourceKind: 'code',
    dimensions: ['queue'],
    units: 'queued requests',
    owner: 'inference-gateway queue adapter',
    liveEffect: 'Turns a saturated in-memory PriorityAdmissionQueue into a QueueFullError/load-shed 429.',
    currentValue: 256,
    disposition: 'remove',
    deletionTarget: 'P-006: durable queue/receipt admission; resident depth no longer rejects accepted work',
    recurrenceTest: 'capacity-inventory.test.ts source-anchor + durable queue conformance tests',
    durableSource: 'resource-governor durable queue, payload references, and receipts',
    telemetry: 'durable queue depth/age with bounded payload residency',
    contextPath: 'PriorityAdmissionQueue.run → QueueFullError',
  }),
  writer({
    id: 'gateway-loadshed-retry-after',
    file: GATEWAY,
    symbol: 'LOADSHED_RETRY_AFTER_SEC',
    sourceAnchor: 'const LOADSHED_RETRY_AFTER_SEC = 5',
    sourceKind: 'code',
    dimensions: ['queue'],
    units: 'seconds',
    owner: 'inference-gateway HTTP protocol adapter',
    liveEffect: 'Supplies a retry hint on the legacy load-shed response; it does not represent provider capacity.',
    currentValue: 5,
    disposition: 'semantic-protocol-safety',
    deletionTarget: 'P-006/P-014: retain only if the protocol needs a retry hint after durable acceptance semantics',
    recurrenceTest: 'capacity-inventory.test.ts source-anchor + HTTP retry contract tests',
    durableSource: 'receipt status/retry-after policy with explicit reason',
    telemetry: 'response status, retry reason, and receipt state',
    contextPath: 'QueueFullError catch in the HTTP request handler',
  }),
  writer({
    id: 'gateway-priority-absorb-factors',
    file: GATEWAY,
    symbol: 'absorbTierFactor',
    sourceAnchor: 'function absorbTierFactor(tier: number | undefined): number',
    sourceKind: 'code',
    dimensions: ['priority'],
    units: 'dimensionless wait multiplier',
    owner: 'inference-gateway priority scheduler',
    liveEffect: 'Varies transient retry patience by priority tier, affecting ordering but not physical capacity.',
    currentValue: 'tier-dependent factors (1.5/1.25/1/0.6)',
    disposition: 'transient-feedback',
    deletionTarget: 'P-008: replace tier-specific capacity behavior with weighted fair scheduling and aging',
    recurrenceTest: 'capacity-inventory.test.ts source-anchor + priority fairness tests',
    durableSource: 'registered priority/service objective policy',
    telemetry: 'tier, wait age, and admitted receipt outcome',
    contextPath: 'retry/absorb path before provider re-acquisition',
  }),
  writer({
    id: 'capacity-probe-concurrency',
    file: 'packages/operator-core/lib/inference-gateway/capacity-probe.ts',
    symbol: 'PROBE_CONCURRENCY',
    sourceAnchor: 'const PROBE_CONCURRENCY =',
    sourceKind: 'code',
    dimensions: ['provider'],
    units: 'accounts probed concurrently',
    owner: 'inference-gateway capacity probe',
    liveEffect: 'Bounds simultaneous upstream probe requests during an evidence sweep; it does not bound productive inference admission.',
    currentValue: 3,
    disposition: 'transient-feedback',
    deletionTarget: 'P-003/P-009: pace observations from probe health and external response, not a productive-capacity cap',
    recurrenceTest: 'capacity-inventory.test.ts source-anchor + probe deadline tests',
    durableSource: 'probe sweep receipts and upstream response evidence',
    telemetry: 'probe concurrency, account id, status, and observation timestamp',
    contextPath: 'probeCapacityForAccounts → probeAccountCapacity',
  }),
  writer({
    id: 'gateway-stats-writer',
    file: GATEWAY,
    symbol: 'stats',
    sourceAnchor: 'function stats(): GatewayStats',
    sourceKind: 'status-reader',
    dimensions: ['status'],
    units: 'mixed; each field declares its own unit',
    owner: 'inference-gateway observability',
    liveEffect: 'Publishes admission, queue, AIMD, serviceability, and provider numbers consumed by operators.',
    currentValue: null,
    disposition: 'transient-feedback',
    deletionTarget: 'P-013: every field names writer, units, binding term, generation, and freshness',
    recurrenceTest: 'capacity-inventory.test.ts status-anchor guard',
    durableSource: 'live controller/pool snapshots and durable state history',
    telemetry: 'stats snapshot timestamp, controller generation, and observation ages',
    contextPath: 'GET /stats, /healthz, and admin endpoints',
  }),
  writer({
    id: 'gateway-admin-config-writer',
    file: GATEWAY,
    symbol: 'GET /admin/config',
    sourceAnchor: "requestPath === '/admin/config'",
    sourceKind: 'status-reader',
    dimensions: ['status', 'deployment'],
    units: 'mixed; structured JSON fields',
    owner: 'inference-gateway admin surface',
    liveEffect: 'Reports configured/effective admission and the term currently binding it.',
    currentValue: null,
    disposition: 'transient-feedback',
    deletionTarget: 'P-013: preserve honest readback while removing cap fields',
    recurrenceTest: 'capacity-inventory.test.ts admin-config anchor guard',
    durableSource: 'controller state and deployment configuration provenance',
    telemetry: 'admissionCeiling boundBy, clamp recommendation/applied, and freshness',
    contextPath: 'gateway:status → GET /admin/config',
  }),
  writer({
    id: 'launch-default-reserve-fraction',
    file: LAUNCH,
    symbol: 'DEFAULT_T1_RESERVE_FRAC',
    sourceAnchor: 'export const DEFAULT_T1_RESERVE_FRAC = 0.15',
    sourceKind: 'code',
    dimensions: ['priority'],
    units: 'fraction of admission slots',
    owner: 'inference-gateway launch priority-tier resolver',
    liveEffect: 'Derives a fixed tier-1 reserve and indirectly caps lower-priority work.',
    currentValue: 0.15,
    disposition: 'remove',
    deletionTarget: 'P-008: weighted fair scheduling; no permanently idle reserve',
    recurrenceTest: 'capacity-inventory.test.ts source-anchor + fairness/borrowing tests',
    durableSource: 'priority service objectives and observed demand',
    telemetry: 'tier demand, wait age, and borrowed idle slots',
    contextPath: 'resolvePriorityTiers → defaultTierCaps',
  }),
  writer({
    id: 'provider-admission-initial-window',
    file: LIFECYCLE,
    symbol: 'INITIAL_PROVIDER_ADMISSION_WINDOW',
    sourceAnchor: 'export const INITIAL_PROVIDER_ADMISSION_WINDOW =',
    sourceKind: 'code',
    dimensions: ['claude-admission', 'codex-admission'],
    units: 'requests in flight',
    owner: 'inference-gateway provider admission lifecycle',
    liveEffect:
      'Sets where a COLD provider lane opens when no bootstrap seed is supplied. It is initial state, not a ceiling (D-002): the lane grows past it under clean traffic and is never clamped to it, and it is shared by every lane so no provider carries its own arithmetic.',
    currentValue: 8,
    disposition: 'transient-feedback',
    deletionTarget:
      'Retain only while a cold lane needs a starting position; it decays into learned state on the first expansions and durable controller state supersedes it across restarts.',
    recurrenceTest: 'provider-admission-lifecycle.test.ts seed-is-not-a-ceiling falsifier + capacity-inventory.test.ts source-anchor',
    durableSource: 'per-lane learned admission window from observed provider outcomes',
    telemetry: 'ProviderAdmissionLifecycle snapshot: window, observedPeak, pressure, contractions, expansions',
    contextPath: 'createInferenceGateway → ProviderAdmissionLifecycle → PriorityAdmissionQueue',
    fanOut: 'every provider lane (Claude and Codex) equally',
  }),
  writer({
    id: 'launch-priority-tier-defaults',
    file: LAUNCH,
    symbol: 'resolvePriorityTiers',
    sourceAnchor: 'const { caps, reserve } = defaultTierCaps(poolSlots, tiers, frac)',
    sourceKind: 'code',
    dimensions: ['priority'],
    units: 'slots per tier / slots reserved',
    owner: 'inference-gateway launch priority-tier resolver',
    liveEffect: 'Creates per-tier caps and a reserve from the pool size.',
    currentValue: 'derived tier caps + reserve',
    disposition: 'remove',
    deletionTarget: 'P-008: fair scheduler with work-conserving borrowing',
    recurrenceTest: 'capacity-inventory.test.ts source-anchor + tier fairness tests',
    durableSource: 'priority policy and durable service objectives',
    telemetry: 'tier queue/in-flight/wait distributions',
    contextPath: 'GATEWAY_PRIORITY_TIERS flag → resolvePriorityTiers',
  }),
  // P-010 REMOVED the `sidecar-concurrency-environment` writer: sidecar-main.ts no
  // longer reads PAPERCUSP_GATEWAY_CONCURRENCY at all, so the production sidecar
  // passes no admission seed and the env cannot reinstate a cap on restart.
  //
  // P-012 then finished the deployment sweep on the systemd unit. The row below is
  // KEPT rather than deleted, and deliberately so: what P-012 had to remove was the
  // actionable capacity CLAIM (`# Optional: PAPERCUSP_GATEWAY_CONCURRENCY=24` reads as
  // a supported knob with a recommended value of 24). Bare deletion would remove the
  // claim but leave NOTHING preventing a future deployer from re-adding it. Re-pointing
  // this row at the tombstone keeps the anchor guard policing that file, so a
  // reinstated ceiling is caught by a failing test rather than shipped silently.
  writer({
    id: 'systemd-concurrency-environment',
    file: 'apps/operator/scripts/systemd/papercup-inference-gateway.service',
    symbol: 'PAPERCUSP_GATEWAY_CONCURRENCY environment',
    sourceAnchor: '# RETIRED: PAPERCUSP_GATEWAY_CONCURRENCY is read by nothing',
    sourceKind: 'deployment',
    dimensions: ['deployment', 'claude-admission'],
    units: 'requests in flight',
    owner: 'systemd gateway unit',
    liveEffect:
      'NONE. P-010 stopped sidecar-main.ts reading the variable; P-012 replaced the unit file\'s "Optional: ...=24" suggestion with a tombstone that names no number and forbids reinstating one. The row survives as a RECURRENCE GUARD on the deployment file, not as a live writer, and startGatewayService now logs a loud warning if the variable is present in any deployment path\'s environment.',
    currentValue: 'none (tombstoned in the unit file; read by nothing on any path)',
    disposition: 'remove',
    deletionTarget: 'P-012 (done): mention deleted; the row now guards against recurrence',
    recurrenceTest: 'capacity-inventory.test.ts deployment-anchor guard + retired-capacity-env.test.ts',
    durableSource: 'controller state and deployment provenance',
    telemetry: 'startGatewayService retired-env warning plus gateway /admin/config readback',
    contextPath: 'systemd ExecStart → sidecar-main',
  }),
  writer({
    id: 'priority-admission-max-queued',
    file: PRIORITY,
    symbol: 'PriorityAdmissionQueue.maxQueued',
    sourceAnchor: 'private readonly maxQueued: number;',
    sourceKind: 'code',
    dimensions: ['queue'],
    units: 'queued tasks',
    owner: 'shared PriorityAdmissionQueue',
    liveEffect: 'Rejects a full resident queue with QueueFullError.',
    currentValue: 'constructor maxQueued option',
    disposition: 'remove',
    deletionTarget: 'P-006: durable queue replaces resident queue depth as acceptance authority',
    recurrenceTest: 'capacity-inventory.test.ts source-anchor + queue persistence tests',
    durableSource: 'durable receipt queue and payload references',
    telemetry: 'durable queue depth/age and persistence health',
    contextPath: 'PriorityAdmissionQueue.run',
  }),
  writer({
    id: 'priority-admission-tier-caps',
    file: PRIORITY,
    symbol: 'PriorityAdmissionQueue.tierCaps',
    sourceAnchor: 'private readonly tierCaps: Map<number, number> | null;',
    sourceKind: 'code',
    dimensions: ['priority'],
    units: 'requests in flight per tier',
    owner: 'shared PriorityAdmissionQueue',
    liveEffect: 'Applies per-tier in-flight caps before selecting a waiter.',
    currentValue: 'tiers.caps',
    disposition: 'remove',
    deletionTarget: 'P-008: priority ordering/fair share without hard tier ceilings',
    recurrenceTest: 'capacity-inventory.test.ts source-anchor + work-conserving tier tests',
    durableSource: 'priority scheduler state and service objectives',
    telemetry: 'tier demand, wait age, and borrow decisions',
    contextPath: 'PriorityAdmissionQueue.canAdmit / drain',
  }),
  writer({
    id: 'priority-admission-tier1-reserve',
    file: PRIORITY,
    symbol: 'PriorityAdmissionQueue.tier1Reserve',
    sourceAnchor: 'private tier1Reserve = 0;',
    sourceKind: 'code',
    dimensions: ['priority'],
    units: 'reserved slots',
    owner: 'shared PriorityAdmissionQueue',
    liveEffect: 'Holds slots open for tier 1 and can leave productive capacity idle.',
    currentValue: 'tiers.tier1Reserve',
    disposition: 'remove',
    deletionTarget: 'P-008: weighted fair scheduling with explicit control bypasses',
    recurrenceTest: 'capacity-inventory.test.ts source-anchor + idle-slot borrowing tests',
    durableSource: 'registered control/recovery class and service objectives',
    telemetry: 'tier waiters and actual borrowed idle slots',
    contextPath: 'PriorityAdmissionQueue.canAdmit / setMaxConcurrent',
  }),
  writer({
    id: 'priority-admission-default-tier-caps',
    file: PRIORITY,
    symbol: 'defaultTierCaps',
    sourceAnchor: 'export function defaultTierCaps(',
    sourceKind: 'code',
    dimensions: ['priority'],
    units: 'slots per tier',
    owner: 'shared priority policy',
    liveEffect: 'Derives fixed per-tier shares from a pool slot count.',
    currentValue: 'poolSlots/reserve fraction formula',
    disposition: 'remove',
    deletionTarget: 'P-008: no capacity formula derived from pool size',
    recurrenceTest: 'capacity-inventory.test.ts source-anchor + tier expansion tests',
    durableSource: 'scheduler policy and observed demand',
    telemetry: 'tier service/wait objectives',
    contextPath: 'launch.resolvePriorityTiers',
  }),
  writer({
    id: 'aimd-controller-cap-floor',
    file: AIMD,
    symbol: 'AimdConcurrencyController.cap/floor',
    sourceAnchor: 'private readonly cap: number;',
    sourceKind: 'code',
    dimensions: ['claude-admission', 'codex-admission'],
    units: 'requests in flight',
    owner: 'shared AimdConcurrencyController',
    liveEffect: 'Treats cap as an additive-increase ceiling and floor as a permanent lower bound.',
    currentValue: 'constructor cap/floor options',
    disposition: 'remove',
    deletionTarget: 'P-005: adapt the shared controller to unbounded desired windows and expiring feedback',
    recurrenceTest: 'capacity-inventory.test.ts source-anchor + controller expansion tests',
    durableSource: 'CaplessAdaptiveController state',
    telemetry: 'controller generation, health evidence, and expiry',
    contextPath: 'recordThrottle/recordSuccess → queue.setMaxConcurrent',
  }),
  writer({
    id: 'governor-default-floors',
    file: REGISTRY,
    symbol: 'DEFAULT_FLOORS',
    sourceAnchor: 'const DEFAULT_FLOORS:',
    sourceKind: 'code',
    dimensions: ['provider'],
    units: 'requests in flight and requests/minute',
    owner: 'shared provider governor registry',
    liveEffect: 'Seeds every provider/model bucket with maxConcurrent=3 and (for cloud providers) rpm=45.',
    currentValue: '{ anthropic: { maxConcurrent: 3, rpm: 45 }, openai: { maxConcurrent: 3, rpm: 45 } }',
    disposition: 'remove',
    deletionTarget: 'P-009: headers and measured provider outcomes are the only physical contract',
    recurrenceTest: 'capacity-inventory.test.ts source-anchor + provider feedback fixtures',
    durableSource: 'provider header observations with freshness/expiry',
    telemetry: 'rate-limit headers, penalties, account/model key, and observation age',
    contextPath: 'governorForBackend → RateLimitGovernor',
  }),
  writer({
    id: 'governor-global-cap',
    file: REGISTRY,
    symbol: 'globalCap',
    sourceAnchor: 'let globalCap = Infinity;',
    sourceKind: 'code',
    dimensions: ['provider', 'claude-admission', 'codex-admission'],
    units: 'requests in flight across buckets',
    owner: 'shared governor global gate',
    liveEffect: 'Installs the fleet-wide maxSimultaneousAgents ceiling above provider buckets.',
    currentValue: 'Infinity until a live config is applied; finite thereafter',
    disposition: 'remove',
    deletionTarget: 'P-009: global rate gate becomes measured feedback, not a productive-capacity maximum',
    recurrenceTest: 'capacity-inventory.test.ts source-anchor + cross-bucket expansion tests',
    durableSource: 'resource-governor class state and durable receipts',
    telemetry: 'global in-flight, effective window, and controller generation',
    contextPath: 'globalGate.tryAcquire → every RateLimitGovernor bucket',
  }),
  writer({
    id: 'governor-global-floor',
    file: REGISTRY,
    symbol: 'DEFAULT_GLOBAL_FLOOR',
    sourceAnchor: 'const DEFAULT_GLOBAL_FLOOR =',
    sourceKind: 'code',
    dimensions: ['provider', 'claude-admission', 'codex-admission'],
    units: 'requests in flight',
    owner: 'shared governor global gate',
    liveEffect: 'Prevents the global AIMD effective window from falling below a fixed floor.',
    currentValue: 1,
    disposition: 'remove',
    deletionTarget: 'P-009: retain only explicit control/recovery protection and expiring causal feedback',
    recurrenceTest: 'capacity-inventory.test.ts source-anchor + recovery tests',
    durableSource: 'controller protection class and health evidence',
    telemetry: 'floor provenance, health severity, and expiry',
    contextPath: 'globalGate.notePenalty / setGlobalConcurrencyFloor',
  }),
  writer({
    id: 'governor-global-aimd-decrease',
    file: REGISTRY,
    symbol: 'DEFAULT_AIMD_DECREASE_FACTOR',
    sourceAnchor: 'const DEFAULT_AIMD_DECREASE_FACTOR =',
    sourceKind: 'code',
    dimensions: ['provider', 'claude-admission', 'codex-admission'],
    units: 'dimensionless multiplicative factor',
    owner: 'shared governor global gate',
    liveEffect: 'Seeds the multiplicative decrease applied to the global AIMD effective window on an observed contraction, down to the global floor.',
    currentValue: 0.5,
    disposition: 'transient-feedback',
    deletionTarget: 'P-009: retain as an expiring, causally-scoped contraction rather than a productive-capacity maximum',
    recurrenceTest: 'capacity-inventory.test.ts source-anchor + global gate AIMD tests',
    durableSource: 'observed global contraction evidence with expiry',
    telemetry: 'effective window, decrease factor, and controller generation',
    contextPath: 'createGlobalConcurrencyGate → aimdEff = max(globalFloor, floor(aimdEff * aimdDecreaseFactor)); tunable via setAimdTuning, reset by resetAimdTuning',
  }),
  writer({
    id: 'governor-rpm-aimd-decrease',
    file: 'libs/papercusp-shared/src/resilience/governor.ts',
    symbol: 'RPM_AIMD_DECREASE',
    sourceAnchor: 'const RPM_AIMD_DECREASE =',
    sourceKind: 'code',
    dimensions: ['provider'],
    units: 'dimensionless multiplicative factor',
    owner: 'shared provider rate governor',
    liveEffect: 'Reduces the learned per-account RPM pace after a measured transient rate throttle.',
    currentValue: 0.5,
    disposition: 'transient-feedback',
    deletionTarget: 'P-003/P-009: retain as expiring, provider-scoped feedback rather than a ceiling',
    recurrenceTest: 'capacity-inventory.test.ts source-anchor + governor AIMD tests',
    durableSource: 'provider rate headers/429 evidence with expiry',
    telemetry: 'rpm factor, anchor time, penalty source, and account/model key',
    contextPath: 'RateLimitGovernor.penalize → effectiveRpm',
  }),
  writer({
    id: 'governor-rpm-aimd-min-factor',
    file: 'libs/papercusp-shared/src/resilience/governor.ts',
    symbol: 'RPM_AIMD_MIN_FACTOR',
    sourceAnchor: 'const RPM_AIMD_MIN_FACTOR =',
    sourceKind: 'code',
    dimensions: ['provider'],
    units: 'dimensionless factor',
    owner: 'shared provider rate governor',
    liveEffect: 'Sets the lower edge of the temporary learned RPM factor after throttling.',
    currentValue: 0.1,
    disposition: 'transient-feedback',
    deletionTarget: 'P-003/P-009: make the lower edge an expiring, evidence-backed policy',
    recurrenceTest: 'capacity-inventory.test.ts source-anchor + governor recovery tests',
    durableSource: 'provider rate observations and recovery timestamps',
    telemetry: 'factor, expiry/recovery age, and causal penalty scope',
    contextPath: 'effectiveRpmFactor / RateLimitGovernor.penalize',
  }),
  writer({
    id: 'governor-rpm-aimd-recovery',
    file: 'libs/papercusp-shared/src/resilience/governor.ts',
    symbol: 'RPM_AIMD_RECOVER_MS',
    sourceAnchor: 'const RPM_AIMD_RECOVER_MS =',
    sourceKind: 'code',
    dimensions: ['provider'],
    units: 'milliseconds',
    owner: 'shared provider rate governor',
    liveEffect: 'Controls how quickly a learned RPM contraction recovers toward the observed floor.',
    currentValue: 300000,
    disposition: 'transient-feedback',
    deletionTarget: 'P-003/P-009: preserve recovery freshness without a permanent cap',
    recurrenceTest: 'capacity-inventory.test.ts source-anchor + governor recovery tests',
    durableSource: 'provider response observations and recovery state',
    telemetry: 'factor anchor, elapsed recovery time, and provider/model scope',
    contextPath: 'effectiveRpmFactor → effectiveRpm → decideRate',
  }),
  // P-009 REMOVED the `rate-limit-maximum-ceiling` writer (RATE_LIMIT_MAX_CEILING = 64). The census
  // tracks LIVE writers, so a deleted writer has no row — its recurrence guard is now
  // CAPACITY_WRITER_SYMBOL_PATTERN, which names RATE_LIMIT_MAX_CEILING explicitly: re-declaring it
  // anywhere in scope is reported as an unclassified-writer and reds this file's census test.
  writer({
    id: 'rate-limit-provider-override-bounds',
    file: RATE_LIMIT,
    symbol: 'clampProviderFloors',
    sourceAnchor: 'const mc = optInt(raw.maxConcurrent, 1, RATE_LIMIT_SANITY_BOUND);',
    sourceKind: 'code',
    dimensions: ['provider'],
    units: 'requests in flight and requests/minute',
    owner: 'operator provider-floor config surface',
    liveEffect:
      'Rejects absurd/non-numeric provider floor override INPUT before it reaches the governors. P-009 retired the baked 256 productive ceiling; the surviving RATE_LIMIT_SANITY_BOUND is an input-validity bound, not a capacity verdict, and a floor override is a cold-start seed the AIMD may probe above without limit.',
    currentValue: 'maxConcurrent 1..100000; rpm 1..100000 (sanity bound, not a productive-capacity maximum)',
    disposition: 'semantic-protocol-safety',
    deletionTarget: 'P-009 retired the 256 productive ceiling; retain only while the config surface needs an input-validity bound',
    recurrenceTest: 'capacity-inventory.test.ts source-anchor + provider override tests',
    durableSource: 'provider contract observations and paced probing',
    telemetry: 'override provenance, header freshness, and causal penalty scope',
    contextPath: 'operator_rate_limit_config → setProviderFloorOverride',
  }),
  writer({
    id: 'rate-limit-resource-profile-seed',
    file: RATE_LIMIT,
    symbol: 'DEFAULT_RATE_LIMIT_CONFIG.maxSimultaneousAgents',
    sourceAnchor: 'return getResourceProfile().maxSimultaneousAgents;',
    sourceKind: 'code',
    dimensions: ['resource-profile', 'claude-admission', 'codex-admission'],
    units: 'agent starts / requests in flight',
    owner: 'operator rate-limit config adapter',
    liveEffect: 'Seeds the gateway-adjacent fleet cap from a host profile when no persisted value exists.',
    currentValue: 'resource profile derived value',
    disposition: 'remove',
    deletionTarget: 'P-004/P-009: compatibility seed may not become a gateway ceiling',
    recurrenceTest: 'capacity-inventory.test.ts source-anchor + profile-seed migration tests',
    durableSource: 'controller bootstrap state with explicit expiry/provenance',
    telemetry: 'profile signals, seed timestamp, and persisted override state',
    contextPath: 'DEFAULT_RATE_LIMIT_CONFIG getter → clampRateLimitConfig',
  }),
  writer({
    id: 'resource-profile-agent-cap',
    file: PROFILE,
    symbol: 'deriveResourceProfile.maxSimultaneousAgents',
    sourceAnchor: 'const maxSimultaneousAgents = clamp(',
    sourceKind: 'code',
    dimensions: ['resource-profile'],
    units: 'agents',
    owner: 'generic resource-profile adapter',
    liveEffect: 'Derives a host-scaled value with a 1..16 clamp that is consumed as a fleet/gateway seed.',
    currentValue: 'clamp(derived agents, 1, 16)',
    disposition: 'remove',
    deletionTarget: 'P-004/P-009: stop treating host profile output as productive gateway capacity',
    recurrenceTest: 'capacity-inventory.test.ts source-anchor + profile consumer tests',
    durableSource: 'host observations as attribution/telemetry only; controller feedback for admission',
    telemetry: 'cores/RAM/power signal provenance and freshness',
    contextPath: 'getResourceProfile → DEFAULT_RATE_LIMIT_CONFIG',
  }),
  writer({
    id: 'local-backend-max-concurrent',
    file: 'packages/operator-core/lib/inference-gateway/local-backend-pool.ts',
    symbol: 'LocalBackend.maxConcurrent',
    sourceAnchor: 'maxConcurrent: number;',
    sourceKind: 'code',
    dimensions: ['local-backend'],
    units: 'requests in flight per backend',
    owner: 'local-backend pool/router',
    liveEffect: 'Retains the registry maxConcurrent field as policy/diagnostic metadata; runtime routing uses fresh engine capacity when available.',
    currentValue: 'durable registry maxConcurrent',
    disposition: 'measured-external-physical-contract',
    deletionTarget: 'P-003/P-011: retain only engine-reported physical slots/context with evidence',
    recurrenceTest: 'capacity-inventory.test.ts source-anchor + local backend physical-contract tests',
    durableSource: 'backend health/engine telemetry and explicit model-hardware contract',
    telemetry: 'live slots, health, latency, engine response, and observation age',
    contextPath: 'createLocalBackendPool.select / saturatedFor',
    fanOut: 'llama-server, vllm, and ollama registrations',
  }),
  writer({
    id: 'local-backend-provisioner-slots',
    file: 'packages/operator-core/lib/provisioner/provision.ts',
    symbol: 'gatewayRegisterInput.maxConcurrent',
    sourceAnchor: 'maxConcurrent: entry.serve.parallelSlots,',
    sourceKind: 'deployment',
    dimensions: ['local-backend', 'deployment'],
    units: 'engine parallel slots',
    owner: 'local backend provisioner/catalog adapter',
    liveEffect: 'Copies a catalog parallel-slot recommendation into the gateway registry.',
    currentValue: 'entry.serve.parallelSlots',
    disposition: 'measured-external-physical-contract',
    deletionTarget: 'P-011: require explicit engine/model/hardware evidence for physical slots',
    recurrenceTest: 'capacity-inventory.test.ts source-anchor + provisioner contract tests',
    durableSource: 'engine-reported slot/context contract and hardware evidence',
    telemetry: 'catalog provenance, health probe, and runtime engine response',
    contextPath: 'provision → registerLocalBackend → local-backend-pool',
  }),
  writer({
    id: 'spawn-readiness-max-queued-reader',
    file: 'packages/operator-core/lib/inference-gateway/spawn-readiness.ts',
    symbol: 'fetchGatewayReadinessSignals.admissionMaxQueued',
    sourceAnchor: "admissionMaxQueued: typeof s.maxQueued === 'number' ? s.maxQueued : 0,",
    sourceKind: 'status-reader',
    dimensions: ['queue', 'status'],
    units: 'queued requests',
    owner: 'spawn-readiness adapter',
    liveEffect: 'Uses the gateway queue cap to defer new spawns; a missing value is currently coerced to zero.',
    currentValue: 'gateway stats maxQueued or 0 fallback',
    disposition: 'semantic-protocol-safety',
    deletionTarget: 'P-006/P-013: attach spawn decisions to durable receipts and preserve unknown/stale',
    recurrenceTest: 'capacity-inventory.test.ts source-anchor + readiness unknown-state tests',
    durableSource: 'durable admission status and explicit unknown/stale signal',
    telemetry: 'gateway generation, queue age, and readiness observation time',
    contextPath: 'fetchGatewayReadinessSignals → decideSpawnAdmission',
  }),
  writer({
    id: 'gateway-status-tool-reader',
    file: 'packages/operator-core/lib/agent-tools/gateway/gateway.ts',
    symbol: 'gatewayStatusTool',
    sourceAnchor: "name: 'gateway:status'",
    sourceKind: 'status-reader',
    dimensions: ['status'],
    units: 'mixed; structured JSON fields',
    owner: 'gateway:status tool',
    liveEffect: 'Surfaces admission, tier, AIMD, pool, and binding-term values to operators.',
    currentValue: null,
    disposition: 'transient-feedback',
    deletionTarget: 'P-013: preserve writer/units/freshness explanations in the read model',
    recurrenceTest: 'capacity-inventory.test.ts status-reader anchor guard',
    durableSource: 'gateway /admin/config and controller snapshots',
    telemetry: 'reachable flag, generation, freshness, and boundBy explanation',
    contextPath: 'gateway:status → /admin/config',
  }),
  writer({
    id: 'gateway-wedge-status-reader',
    file: 'packages/operator-core/lib/inference-gateway/gateway-wedge.ts',
    symbol: 'gateway wedge metric normalization',
    sourceAnchor: 'const maxConcurrent = n(stats.admission?.maxConcurrent',
    sourceKind: 'status-reader',
    dimensions: ['status'],
    units: 'requests in flight',
    owner: 'gateway wedge detector',
    liveEffect: 'Interprets the reported admission max as a saturation/wedge ceiling.',
    currentValue: null,
    disposition: 'transient-feedback',
    deletionTarget: 'P-013: classify reported values by binding term and freshness',
    recurrenceTest: 'capacity-inventory.test.ts status-reader anchor guard',
    durableSource: 'live controller and durable queue state',
    telemetry: 'stats age, queue age, and controller generation',
    contextPath: 'gateway-wedge normalizeGatewayStats / evaluateGatewayWedge',
  }),
  writer({
    id: 'system-health-gateway-status-reader',
    file: 'packages/operator-core/lib/system-health/compute.ts',
    symbol: 'gateway health projection',
    sourceAnchor: 'gateway!.queueDepth',
    sourceKind: 'status-reader',
    dimensions: ['status', 'queue'],
    units: 'queued requests / requests in flight',
    owner: 'system-health gateway projection',
    liveEffect: 'Builds health messages from gateway queue depth and maxConcurrent.',
    currentValue: null,
    disposition: 'transient-feedback',
    deletionTarget: 'P-013: report the exact writer and binding physical evidence',
    recurrenceTest: 'capacity-inventory.test.ts status-reader anchor guard',
    durableSource: 'gateway stats/controller snapshots',
    telemetry: 'sample timestamp, queue age, and freshness status',
    contextPath: 'computeSystemHealth → gateway health tile/alert',
  }),
]);

/**
 * P-004 compatibility/deletion contract.
 *
 * P-001 describes the current writers. This second declarative layer says how
 * each writer is migrated: legacy input is observed once, the operator gets an
 * honest warning/readback, a focused release removes or reclassifies the
 * binding, and rollback turns enforcement off without putting a numeric ceiling
 * back. Keeping this contract next to the writer census gives P-012/P-015 one
 * source of truth instead of release-specific checklists.
 */
export const INFERENCE_GATEWAY_CAPACITY_COMPATIBILITY_SCHEMA_VERSION =
  'inference-gateway-capacity-compatibility-v1' as const;

/** Compatibility alias used by migration tooling and older plan notes. */
export const INFERENCE_GATEWAY_COMPATIBILITY_MATRIX_SCHEMA_VERSION =
  INFERENCE_GATEWAY_CAPACITY_COMPATIBILITY_SCHEMA_VERSION;

/**
 * `remove-after-gate` is the ONLY non-terminal disposition: it names a gate that has not run
 * yet.  Every other member is terminal — the migration question for that family is settled —
 * and P-015 requires a terminal disposition to carry `dispositionEvidence`.
 */
export type CapacityCompatibilityDisposition =
  | 'remove-after-gate'
  | 'removed'
  | 'feedback-only'
  | 'readback-only'
  | 'retain-semantic-safety'
  | 'retain-measured-physical-contract';

/** Dispositions whose migration question is settled; only these may close a plan (P-015). */
export const TERMINAL_CAPACITY_COMPATIBILITY_DISPOSITIONS: ReadonlySet<CapacityCompatibilityDisposition> =
  new Set<CapacityCompatibilityDisposition>([
    'removed',
    'feedback-only',
    'readback-only',
    'retain-semantic-safety',
    'retain-measured-physical-contract',
  ]);

/**
 * What a terminal disposition actually claims.  `deleted` means the binding writer is gone from
 * the tree; `non-capacity` means the writer is still live but was MEASURED not to bind productive
 * admission.  The two are checked against `writerIds`, so the claim cannot drift from the census.
 */
export type CapacityDispositionVerdict = 'deleted' | 'non-capacity';

/**
 * Attestation for a terminal disposition (the derived-truth ladder's rung 3: a claim about
 * runtime state paired with the probe that falsifies it).  A disposition is a statement about
 * live behaviour that no static check can prove, so it is recorded WITH its measurement and its
 * recheck rather than asserted as prose — an undated "this no longer binds" is precisely the
 * hand-maintained metadata this inventory exists to eliminate.
 */
export interface CapacityDispositionEvidence {
  readonly verdict: CapacityDispositionVerdict;
  /** UTC date of the measurement that settled the verdict, `YYYY-MM-DD`. */
  readonly measuredAt: string;
  /** What was observed — source trace and/or live values, including the numbers. */
  readonly measurement: string;
  /** The concrete probe that would FALSIFY this verdict. */
  readonly recheck: string;
  /** A stated condition under which the verdict does not hold (for example, a non-default path). */
  readonly caveat?: string;
}

export type CapacityCompatibilityConsumerKind = 'docs' | 'runbook' | 'api' | 'state' | 'test';

export interface CapacityCompatibilityConsumer {
  readonly kind: CapacityCompatibilityConsumerKind;
  /** Repository-relative path, optionally followed by a symbol. */
  readonly path: string;
}

export interface InferenceGatewayCapacityCompatibilityGroup {
  /** Stable family id, for example gateway-concurrency. */
  readonly id: string;
  /** Human-readable legacy field family covered by this row. */
  readonly field: string;
  /** Every legacy spelling/config key covered by this family. */
  readonly legacyFields: readonly string[];
  /** Alias retained for callers that call these keys rather than fields. */
  readonly legacyKeys: readonly string[];
  /** P-001 writer ids covered by this family. */
  readonly writerIds: readonly string[];
  /** How observe-only mode carries the old value without enforcing it. */
  readonly observeOnlyMigration: string;
  /** Warning and readback contract, including unknown/stale handling. */
  readonly warningReadback: string;
  /** Focused release/gate after which the binding writer is removed or reclassified. */
  readonly removalRelease: string;
  /** Rollback procedure for this family. */
  readonly rollbackBehavior: string;
  /** Machine-checkable guard for D-010. */
  readonly rollbackNeverReinstatesNumericCap: boolean;
  /** Historical values that rollback must never restore as a productive cap. */
  readonly rollbackForbiddenValues: readonly number[];
  /** Exact docs and runbooks that must be updated/read by the migration. */
  readonly docsRunbookConsumers: readonly string[];
  /** API/route/tool surfaces that expose or consume the field. */
  readonly apiConsumers: readonly string[];
  /** Durable/read-model state surfaces carrying the field or its replacement. */
  readonly stateConsumers: readonly string[];
  /** Unified consumer list for generic migration/reporting clients. */
  readonly consumers: readonly CapacityCompatibilityConsumer[];
  readonly disposition: CapacityCompatibilityDisposition;
  /** Required for every TERMINAL disposition (P-015). Absent only while `remove-after-gate`. */
  readonly dispositionEvidence?: CapacityDispositionEvidence;
}

/** One flattened row per exact P-001 writer, suitable for lint/report joins. */
export interface InferenceGatewayCapacityCompatibility extends InferenceGatewayCapacityCompatibilityGroup {
  readonly groupId: string;
  readonly writerId: string;
}

const INFERENCE_GATEWAY_LEGACY_CAP_VALUES: readonly number[] = Object.freeze([24, 3, 4, 45, 64, 256]);
export const INFERENCE_GATEWAY_CAPACITY_ROLLBACK_FORBIDDEN_VALUES = INFERENCE_GATEWAY_LEGACY_CAP_VALUES;

const COMPATIBILITY_MATRIX_DOC =
  'apps/operator-docs/src/content/docs/agent-insights/inference-gateway-compatibility-deletion-matrix-runbook.mdx';
const CAPACITY_RULE_DOC =
  'apps/operator-docs/src/content/docs/agent-insights/operational-capacity-is-feedback-not-a-hard-coded-cap.mdx';
const ADMISSION_LOOP_DOC =
  'apps/operator-docs/src/content/docs/agent-insights/gateway-admission-control-loop.mdx';
const COMPATIBILITY_TEST =
  'packages/operator-core/lib/inference-gateway/capacity-compatibility.test.ts';

function rollbackCompatibilityText(field: string): string {
  return (
    'Rollback ' +
    field +
    ' to observe-only; preserve durable queue/receipts, state history, and telemetry, ' +
    'and never reinstate a numeric productive-capacity ceiling.'
  );
}

function compatibilityGroup(
  row: Omit<
    InferenceGatewayCapacityCompatibilityGroup,
    'legacyKeys' | 'rollbackNeverReinstatesNumericCap' | 'rollbackForbiddenValues' | 'consumers'
  >,
): InferenceGatewayCapacityCompatibilityGroup {
  const docs = Object.freeze([...row.docsRunbookConsumers]);
  const api = Object.freeze([...row.apiConsumers]);
  const state = Object.freeze([...row.stateConsumers]);
  const consumers = Object.freeze([
    ...docs.map((path): CapacityCompatibilityConsumer => ({
      kind: path.endsWith('-runbook.mdx') ? 'runbook' : 'docs',
      path,
    })),
    ...api.map((path): CapacityCompatibilityConsumer => ({ kind: 'api', path })),
    ...state.map((path): CapacityCompatibilityConsumer => ({ kind: 'state', path })),
    { kind: 'test' as const, path: COMPATIBILITY_TEST },
  ]);
  return Object.freeze({
    ...row,
    legacyFields: Object.freeze([...row.legacyFields]),
    legacyKeys: Object.freeze([...row.legacyFields]),
    writerIds: Object.freeze([...row.writerIds]),
    docsRunbookConsumers: docs,
    apiConsumers: api,
    stateConsumers: state,
    rollbackNeverReinstatesNumericCap: true,
    rollbackForbiddenValues: INFERENCE_GATEWAY_LEGACY_CAP_VALUES,
    consumers,
    ...(row.dispositionEvidence
      ? { dispositionEvidence: Object.freeze({ ...row.dispositionEvidence }) }
      : {}),
  });
}

/**
 * Family-level matrix. The values are prose contracts rather than executable
 * defaults: P-004 specifies the migration, while P-005 through P-015 implement
 * and gate each release.
 */
export const INFERENCE_GATEWAY_CAPACITY_COMPATIBILITY_GROUPS: readonly InferenceGatewayCapacityCompatibilityGroup[] =
  Object.freeze([
    compatibilityGroup({
      id: 'gateway-concurrency',
      field: 'PAPERCUSP_GATEWAY_CONCURRENCY / Claude default',
      legacyFields: ['PAPERCUSP_GATEWAY_CONCURRENCY', 'DEFAULT_CONCURRENCY', 'GatewayServiceOptions.concurrency'],
      // P-010 deleted the gateway/launch/sidecar writers in this group. Only the
      // systemd unit's inert MENTION of the variable still exists; the group is kept
      // (not deleted) so the legacy field names stay discoverable to a migrating
      // deployment even though nothing reads them any more.
      writerIds: ['systemd-concurrency-environment'],
      observeOnlyMigration:
        'Read the environment, launch option, and legacy seed once as compatibility metadata with source and timestamp; initialize controller desired state only and never pass it as maxConcurrent.',
      warningReadback:
        'Warn when the legacy value is present, invalid, or stale. Stats and gateway:status show the raw value, provenance, controller desired/effective window, and boundBy=none or a measured external contract.',
      removalRelease: 'P-010/P-012 focused parity gate: delete the env/default binding from gateway, launch, sidecar, and systemd.',
      rollbackBehavior: rollbackCompatibilityText('Claude gateway concurrency'),
      docsRunbookConsumers: [COMPATIBILITY_MATRIX_DOC, CAPACITY_RULE_DOC],
      apiConsumers: [
        'packages/operator-core/lib/inference-gateway/gateway.ts :: createInferenceGateway',
        'packages/operator-core/lib/inference-gateway/launch.ts :: startGatewayService',
        'packages/operator-core/lib/inference-gateway/sidecar-main.ts :: runGatewaySidecarMain',
        'GET /stats and GET /admin/config',
      ],
      stateConsumers: [
        'packages/operator-core/lib/resource-governor/controller.ts',
        'packages/operator-core/lib/inference-gateway/admission-ceiling.ts',
        'packages/operator-core/lib/inference-gateway/observability.ts',
        'packages/operator-core/lib/fleet-rate-status.ts',
      ],
      disposition: 'readback-only',
      dispositionEvidence: {
        verdict: 'non-capacity',
        measuredAt: '2026-08-30',
        measurement:
          'P-010 deleted every read of PAPERCUSP_GATEWAY_CONCURRENCY on the gateway/launch/sidecar path; what survives is the systemd unit Environment= line and one sidecar-main.ts comment, and a present value is warned on through RETIRED_CAPACITY_ENV_VARS. Live GET /stats 2026-08-30T00:17Z: aimd.effective = aimd.cap = 503 against aimd.floor = 4, reached by 495 recorded increases and 0 decreases — the live window is learned from outcomes and was never seeded to the legacy 24.',
        recheck:
          'grep -rn PAPERCUSP_GATEWAY_CONCURRENCY packages libs apps --include=*.ts must return comments and the retired-env table only; retired-capacity-env.test.ts asserts the warn-on-present readback. A /stats.aimd.cap that stops moving at a configured value would falsify.',
      },
    }),
    compatibilityGroup({
      id: 'provider-admission-seed',
      field: 'Cold-lane admission seed (post-P-010 replacement for every retired provider ceiling)',
      legacyFields: ['DEFAULT_CONCURRENCY', 'CODEX_ADMISSION_SLOTS_PER_ACCOUNT', 'accountScaledCodexConcurrency'],
      writerIds: ['provider-admission-initial-window'],
      observeOnlyMigration:
        'Read any supplied bootstrap value once as INITIAL STATE for every provider lane equally, never as a per-provider size and never as maxConcurrent. A restored durable controller window supersedes it; an absent seed simply starts the lane at the shared default.',
      warningReadback:
        'Stats and gateway:status publish the live per-lane window, the lane high-water mark, contraction/expansion counts, and the fact that boundBy=none — so a reader can never mistake the seed for a ceiling it is being held to.',
      removalRelease:
        'P-010 shipped this seed as the replacement for every retired provider ceiling. It is initial state, not a cap, so it has no deletion gate of its own — durable controller state is what removes its relevance, and P-012 removes the deployment inputs that still supply one.',
      rollbackBehavior: rollbackCompatibilityText('provider admission seed'),
      docsRunbookConsumers: [COMPATIBILITY_MATRIX_DOC, CAPACITY_RULE_DOC],
      apiConsumers: [
        'packages/operator-core/lib/inference-gateway/provider-admission-lifecycle.ts :: ProviderAdmissionLifecycle',
        'packages/operator-core/lib/inference-gateway/gateway.ts :: createInferenceGateway',
        'GET /stats :: aimd, codexAimd, concurrencyCap',
      ],
      stateConsumers: [
        'packages/operator-core/lib/resource-governor/controller.ts',
        'packages/operator-core/lib/inference-gateway/capless-adapter.ts',
        'packages/operator-core/lib/inference-gateway/observability.ts',
      ],
      disposition: 'feedback-only',
      dispositionEvidence: {
        verdict: 'non-capacity',
        measuredAt: '2026-08-30',
        measurement:
          'INITIAL_PROVIDER_ADMISSION_WINDOW = 8 is the only bootstrap number left and it is applied identically to both lanes. Live GET /stats 2026-08-30T00:17Z, 8h13m uptime and 27,329 requests: the Claude window is 503 and the Codex window 231, both learned upward (aimd.increases 495, codexAimd.increases 2,287) — 63x and 29x the seed. A seed acting as a ceiling could not be exceeded at all, let alone by that margin.',
        recheck:
          'curl /stats: aimd.effective or codexAimd.effective sitting at 8 (or at a supplied opts.concurrency) while pressure is 0 would falsify. In source, the seed reaching setMaxConcurrent as a maximum rather than an initial window would falsify.',
      },
    }),
    compatibilityGroup({
      id: 'gateway-codex-concurrency',
      field: 'PAPERCUSP_GATEWAY_CODEX_CONCURRENCY / Codex account scaling',
      legacyFields: [
        'PAPERCUSP_GATEWAY_CODEX_CONCURRENCY',
        'CODEX_ADMISSION_SLOTS_PER_ACCOUNT',
        'accountScaledCodexConcurrency',
        'GatewayServiceOptions.codexConcurrency',
      ],
      // P-010 COMPLETED this group's removal: every Codex-specific capacity writer is
      // deleted, so the group has no live writers left. It is retained as the migration
      // RECORD (its legacy field names are what a deployer greps for), not as pending work.
      writerIds: [],
      observeOnlyMigration:
        'Record the Codex override and account-count calculation as a bootstrap observation with account-pool generation; seed desired state once without deriving a maximum from account count.',
      warningReadback:
        'Warn on an override or a missing account pool and report account count, raw calculation, controller desired/effective window, generation, and freshness. Unknown account evidence stays unknown.',
      removalRelease: 'P-010 focused provider parity gate: delete the override and account-scaled ceiling; retain provider/account observations as feedback.',
      rollbackBehavior: rollbackCompatibilityText('Codex gateway concurrency'),
      docsRunbookConsumers: [COMPATIBILITY_MATRIX_DOC, CAPACITY_RULE_DOC],
      apiConsumers: [
        'packages/operator-core/lib/inference-gateway/gateway.ts :: accountScaledCodexConcurrency',
        'packages/operator-core/lib/inference-gateway/launch.ts :: codexConcurrency',
        'GET /stats :: codexAdmission',
      ],
      stateConsumers: [
        'packages/operator-core/lib/inference-gateway/observability.ts :: codex admission snapshot',
        'packages/operator-core/lib/inference-gateway/admission-context.ts',
        'packages/operator-core/lib/agent-tools/gateway/gateway.ts :: gateway:status',
      ],
      disposition: 'removed',
      dispositionEvidence: {
        verdict: 'deleted',
        measuredAt: '2026-08-30',
        measurement:
          'Every Codex-specific capacity writer is deleted: writerIds is empty, readCodexConcurrencyOverride no longer exists (only a gateway.ts comment names it), and CODEX_ADMISSION_SLOTS_PER_ACCOUNT is gone. Live GET /stats 2026-08-30T00:17Z: codexAdmission.maxConcurrent = 231 with 39 running — the Codex lane rides the same shared capless window as Claude rather than an account-scaled ceiling.',
        recheck:
          'grep -rn "readCodexConcurrencyOverride|CODEX_ADMISSION_SLOTS_PER_ACCOUNT|accountScaledCodexConcurrency" packages libs --include=*.ts must find no declaration; CAPACITY_WRITER_SYMBOL_PATTERN reds the census test if any of them is re-declared in scope.',
      },
    }),
    compatibilityGroup({
      id: 'gateway-max-queued',
      field: 'MAX_QUEUED / resident queue depth',
      legacyFields: ['PAPERCUSP_GATEWAY_MAX_QUEUED', 'DEFAULT_MAX_QUEUED', 'PriorityAdmissionQueue.maxQueued'],
      writerIds: ['gateway-max-queued', 'priority-admission-max-queued'],
      observeOnlyMigration:
        'Keep the legacy queue-depth value only as a readback annotation while accepted requests move to the durable receipt queue; resident depth is not an admission rejection authority.',
      warningReadback:
        'Warn if a caller would have hit the legacy QueueFullError path. Expose durable queue depth/age, persistence health, and the old value as non-binding metadata; missing depth is unknown, never safe zero.',
      removalRelease: 'P-006/P-014 focused durable-queue gate: remove resident maxQueued rejection and load-shed coupling.',
      rollbackBehavior: rollbackCompatibilityText('resident queue depth'),
      docsRunbookConsumers: [COMPATIBILITY_MATRIX_DOC, CAPACITY_RULE_DOC],
      apiConsumers: [
        'packages/operator-core/lib/inference-gateway/gateway.ts :: PriorityAdmissionQueue.run',
        'GET /stats :: maxQueued and queue depth',
        'GET /admin/config :: queue policy readback',
      ],
      stateConsumers: [
        'packages/operator-core/lib/resource-governor/queue.ts :: durable receipt queue',
        'packages/operator-core/lib/inference-gateway/observability.ts',
        'packages/operator-core/lib/system-health/compute.ts',
      ],
      disposition: 'retain-semantic-safety',
      dispositionEvidence: {
        verdict: 'non-capacity',
        measuredAt: '2026-08-30',
        measurement:
          'gateway.ts resolves the queue bound as `deps.maxQueued ?? (payloadSpool ? 0 : DEFAULT_MAX_QUEUED)`, and 0 is PriorityAdmissionQueue\'s uncapped sentinel (its shed test is `maxQueued > 0 && …`). Live GET /stats 2026-08-30T00:17Z with the durable payload spool active: maxQueued = 0 and shed429 = 0 across 27,329 requests — not one request has been refused for resident queue depth.',
        recheck:
          'curl /stats and read maxQueued + shed429: a non-zero maxQueued, or any shed429 growth, with the spool active would falsify. admission-loadshed-retirement.test.ts pins the sentinel behaviour.',
        caveat:
          'Retirement is conditional on the durable payload spool. With NO spool the resident queue still bounds at `PAPERCUSP_GATEWAY_MAX_QUEUED || 256`, and an explicit deps.maxQueued still wins. That bound is retained deliberately and is why this row is semantic-safety rather than removed: it protects process memory for requests that have nowhere durable to spill, and it never bounds the admission window itself.',
      },
    }),
    compatibilityGroup({
      id: 'serviceable-admission',
      field: 'per-account and minimum serviceable admission',
      legacyFields: [
        'PAPERCUSP_GATEWAY_PER_ACCOUNT_ADMISSION',
        'PAPERCUSP_GATEWAY_MIN_ADMISSION',
        'SERVICEABLE_CLAMP_ON',
        'SERVICEABLE_CLAMP_TICK_MS',
        'serviceableAdmissionCapFn',
      ],
      writerIds: [
        'gateway-serviceable-per-account',
        'gateway-serviceable-minimum',
        'gateway-serviceable-clamp-application',
        'gateway-serviceable-clamp-tick',
      ],
      observeOnlyMigration:
        'Observe serviceable account count, multiplier, minimum, and timer cadence with pool generation; publish the recommendation but do not multiply serviceability into a hard admission cap.',
      warningReadback:
        'Warn when serviceability is unknown, stale, or zero and show recommendation versus applied window, clamp mode, observation age, and causal source. Unknown never becomes the minimum floor.',
      removalRelease: 'P-007 focused serviceability/causal gate: remove the derived clamp and timer-driven application; retain routing evidence.',
      rollbackBehavior: rollbackCompatibilityText('serviceability admission'),
      docsRunbookConsumers: [COMPATIBILITY_MATRIX_DOC, CAPACITY_RULE_DOC, ADMISSION_LOOP_DOC],
      apiConsumers: [
        'packages/operator-core/lib/inference-gateway/gateway.ts :: POST /admin/clamp-mode',
        'GET /stats :: serviceableAccounts and clamp recommendation/applied',
        'packages/operator-core/lib/agent-tools/gateway/gateway.ts :: gateway:status',
      ],
      stateConsumers: [
        'packages/operator-core/lib/inference-gateway/admission-ceiling.ts',
        'packages/operator-core/lib/inference-gateway/observability.ts',
        'packages/operator-core/lib/inference-gateway/account-failover.ts',
      ],
      disposition: 'readback-only',
      dispositionEvidence: {
        verdict: 'non-capacity',
        measuredAt: '2026-08-30',
        measurement:
          'serviceableAdmissionCapFn has exactly one consumer, refreshServiceableDiagnostics → lastServiceableRecommendation → GET /stats clamp.recommendation and a mode-change log; serviceableClampTimer is hard-undefined, so nothing applies the value on a timer. Live GET /stats 2026-08-30T00:17Z: clamp = { mode:"off", recommendation:28, applied:503, overridden:true, serviceableAccounts:7 } — applied admission is 18x the recommendation, so the serviceability arithmetic reports and does not bind.',
        recheck:
          'curl /stats and compare clamp.applied against clamp.recommendation: applied falling to the recommendation, or clamp.mode leaving "off", would falsify. In source, any assignment of serviceableClampTimer or any path feeding the recommendation into setMaxConcurrent would falsify.',
      },
    }),
    compatibilityGroup({
      id: 'aimd-floor-and-tuning',
      field: 'AIMD cap, floor, and response-curve tuning',
      legacyFields: [
        'PAPERCUSP_GATEWAY_AIMD_FLOOR',
        'DEFAULT_AIMD_FLOOR',
        'DEFAULT_AIMD_DECREASE_THRESHOLD',
        'DEFAULT_AIMD_INCREASE_EVERY',
        'AimdConcurrencyController.cap',
        'AimdConcurrencyController.floor',
      ],
      writerIds: [
        'gateway-aimd-floor',
        'gateway-aimd-decrease-threshold',
        'gateway-aimd-increase-every',
        'aimd-controller-cap-floor',
      ],
      observeOnlyMigration:
        'Record legacy AIMD floor/cap and threshold settings as controller bootstrap metadata. Healthy success probes upward without a configured ceiling; contractions are scoped, causal, and expiring.',
      warningReadback:
        'Warn when a legacy floor or cap is binding and report effective/desired windows, decrease reason, recovery streak, generation, and expiry. A stale contraction is shown as stale.',
      removalRelease: 'P-005/P-009 controller gate: move thresholds and recovery policy into durable CaplessAdaptiveController feedback state.',
      rollbackBehavior: rollbackCompatibilityText('AIMD tuning'),
      docsRunbookConsumers: [COMPATIBILITY_MATRIX_DOC, CAPACITY_RULE_DOC],
      apiConsumers: [
        'packages/operator-core/lib/inference-gateway/gateway.ts :: AimdConcurrencyController',
        'GET /stats :: aimd effective/floor/decreases',
        'GET /admin/config :: admissionCeiling',
      ],
      stateConsumers: [
        'packages/operator-core/lib/resource-governor/controller.ts',
        'packages/operator-core/lib/resource-governor/state-snapshot.ts',
        'packages/operator-core/lib/inference-gateway/admission-ceiling.ts',
      ],
      disposition: 'feedback-only',
      dispositionEvidence: {
        verdict: 'non-capacity',
        measuredAt: '2026-08-30',
        measurement:
          'What survives of the AIMD family is a FLOOR and response-curve tuning, never a ceiling. Live GET /stats 2026-08-30T00:17Z: aimd = { effective: 503, cap: 503, floor: 4, increases: 495, decreases: 0 } and codexAimd = { effective: 231, cap: 1318, floor: 4, increases: 2287, decreases: 7 }. Each cap is the controller\'s own learned high-water mark, not a configured bound — the Codex cap sits at 1318 while its live window is 231, so the cap is demonstrably not what holds that lane. The only configured term in either lane is the floor of 4.',
        recheck:
          'curl /stats: an aimd.cap that stops advancing at a value that appears in the source (24, 45, 64, 256) across hundreds of clean increases, or an effective window clamped below cap while pressure is 0, would falsify.',
      },
    }),
    compatibilityGroup({
      id: 'priority-reserve-and-map',
      field: 'priority tier caps, reserve, map, and absorb factors',
      legacyFields: [
        'GATEWAY_PRIORITY_TIERS',
        'GATEWAY_PRIORITY_MAP',
        'GATEWAY_T1_RESERVE_FRAC',
        'tierCaps',
        'tier1Reserve',
        'defaultTierCaps',
        'absorbTierFactor',
      ],
      writerIds: [
        'gateway-priority-absorb-factors',
        'launch-default-reserve-fraction',
        'launch-priority-tier-defaults',
        'priority-admission-tier-caps',
        'priority-admission-tier1-reserve',
        'priority-admission-default-tier-caps',
      ],
      observeOnlyMigration:
        'Keep role/tier labels, ordering, aging, and service-objective observations, but treat reserve and tier caps as annotations. Idle productive slots remain borrowable by eligible work.',
      warningReadback:
        'Warn when a tier cap or reserve would deny otherwise healthy work. Readback includes tier, wait age, borrowed idle slots, and scheduler generation; a tier share is never physical capacity.',
      removalRelease: 'P-008 fairness gate: replace hard tier caps/reserve with weighted fair scheduling, aging, and explicit control/recovery bypasses.',
      rollbackBehavior: rollbackCompatibilityText('priority scheduling'),
      docsRunbookConsumers: [COMPATIBILITY_MATRIX_DOC, CAPACITY_RULE_DOC, ADMISSION_LOOP_DOC],
      apiConsumers: [
        'packages/operator-core/lib/inference-gateway/launch.ts :: resolvePriorityTiers',
        'GET /stats :: priorityTiers.byTier and tier1Reserve',
        'packages/operator-core/lib/agent-tools/gateway/gateway.ts :: gateway:status',
      ],
      stateConsumers: [
        'libs/papercusp-shared/src/resilience/priority-admission.ts',
        'packages/operator-core/lib/inference-gateway/observability.ts',
        'packages/operator-core/lib/system-health/compute.ts',
      ],
      disposition: 'retain-semantic-safety',
      dispositionEvidence: {
        verdict: 'non-capacity',
        measuredAt: '2026-08-30',
        measurement:
          'The per-tier share stopped being a hard ceiling in WI-4541 (priority-admission.ts records the relaxation: a tier at its share BORROWS an idle slot unless an outranking tier is waiting). Live GET /stats 2026-08-30T00:17Z: Claude tier 2 ran inFlight 377 against a stated share of 6 — 63x — with nothing refused, which is only possible because the share does not cap. The one live bound is the tier-1 reserve, a deliberate un-starving guarantee for the interactive lane under D-007 (priority is work-conserving scheduling, not capacity): it partitions a 503-slot pool, it does not bound it, and tier 1 may use the whole pool.',
        recheck:
          'curl /stats and read admission.tier1Reserve / admission.maxConcurrent — it must track GATEWAY_T1_RESERVE_FRAC (0.15). A byTier entry whose inFlight is pinned at its stated share while the pool has idle slots and no higher tier is queued would falsify the borrowing claim.',
        caveat:
          'Measured at 0.2505 (Claude 126/503) and 0.2511 (Codex 58/231) BEFORE the P-015 fix, not the intended 0.15: the queue re-derived its reserve fraction as reserve/maxConcurrent at construction, where ceil(8 * 0.15) / 8 = 0.25 inflated it permanently. P-015 makes the configured fraction authoritative; the corrected ratio only appears live after the next gateway construction, and is pinned meanwhile by priority-admission.test.ts.',
      },
    }),
    compatibilityGroup({
      id: 'provider-governor-floors',
      field: 'provider governor defaults and global rate gate',
      legacyFields: [
        'DEFAULT_FLOORS',
        'globalCap',
        'globalFloor',
        'DEFAULT_AIMD_DECREASE_FACTOR',
        'RPM_AIMD_DECREASE',
        'RPM_AIMD_MIN_FACTOR',
        'RPM_AIMD_RECOVER_MS',
      ],
      writerIds: [
        'governor-default-floors',
        'governor-global-cap',
        'governor-global-floor',
        // `governor-global-aimd-decrease` (DEFAULT_AIMD_DECREASE_FACTOR) belongs here for the
        // same reason `governor-global-floor` does: it is a baked constant of the GLOBAL
        // concurrency gate, not of the per-provider RPM ladder that the `rpm-` writers cover.
        // It was registered in the inventory without being added to any group, which left the
        // matrix one row short of the inventory — the exact hole the length + group-contract
        // assertions in capacity-compatibility.test.ts exist to catch.
        'governor-global-aimd-decrease',
        'governor-rpm-aimd-decrease',
        'governor-rpm-aimd-min-factor',
        'governor-rpm-aimd-recovery',
      ],
      observeOnlyMigration:
        'Treat provider maxConcurrent/rpm and global gate values as cold-start observations only. Fresh provider headers, usage windows, and outcomes feed scoped feedback; absent headers trigger paced probing.',
      warningReadback:
        'Warn when a baked provider floor/global cap is the binding term and show provider, account/model key, header source, observation age, penalty scope, and expiry. Missing headers remain unknown.',
      removalRelease: 'P-009 provider-governor gate: delete baked productive floors/caps and retain only fresh, provider-scoped feedback.',
      rollbackBehavior: rollbackCompatibilityText('provider governor floors'),
      docsRunbookConsumers: [COMPATIBILITY_MATRIX_DOC, CAPACITY_RULE_DOC],
      apiConsumers: [
        'libs/papercusp-shared/src/agent/governor-registry.ts :: governorForBackend',
        'packages/operator-core/lib/rate-limit-config.ts :: applyCached',
        'GET /stats :: provider and global admission',
      ],
      stateConsumers: [
        'libs/papercusp-shared/src/resilience/governor.ts',
        'packages/operator-core/lib/resource-governor/controller.ts',
        'packages/operator-core/lib/fleet-rate-status.ts',
      ],
      disposition: 'feedback-only',
      dispositionEvidence: {
        verdict: 'non-capacity',
        measuredAt: '2026-08-30',
        measurement:
          'The global gate is uncapped by construction: governor-registry initialises globalCap = Infinity and globalFloor = 1, and the window probes upward whenever aimdEff < globalCap. The baked numbers that remain are cold-start FLOORS (DEFAULT_FLOORS.anthropic = { maxConcurrent: 3, rpm: 45 }) which a provider header supersedes through the recordResponse auto-tune. Live GET /stats 2026-08-30T00:17Z: every account reports rpmFactor 1.0 (no contraction in force) and gateway in-flight admission is 503 — two orders of magnitude above the 3-slot cold floor, so that floor is not the binding term.',
        recheck:
          'curl /stats and read smoothing.byAccount[*].rpmFactor and effRpm; read the governor global gate for a FINITE cap. A finite globalCap, or an effRpm held below a header-advertised limit, would falsify.',
        caveat:
          'Measured honestly: on accounts where no provider response has yet supplied an rpm header, the anthropic bucket still paces at the baked cold-start 45 rpm (effectivePaceMs 1334). That is a floor awaiting evidence rather than a ceiling — nothing clamps a higher header-learned value down to it — but it does mean those accounts are paced by a configured number, and only a header-bearing response replaces it.',
      },
    }),
    compatibilityGroup({
      id: 'operator-rate-limit',
      field: 'operator rate-limit cap and provider override bounds',
      legacyFields: ['RATE_LIMIT_MAX_CEILING', 'ProviderFloorConfig.maxConcurrent', 'ProviderFloorConfig.rpm', 'clampProviderFloors'],
      // 'rate-limit-maximum-ceiling' left this list when P-009 deleted the writer itself; the legacy
      // field name is retained above so the compatibility contract for the removed cap survives.
      writerIds: ['rate-limit-provider-override-bounds'],
      observeOnlyMigration:
        'Accept persisted operator settings for compatibility, record raw value and provenance, and pass them to the controller as non-binding intent; do not clamp healthy desired state to local bounds.',
      warningReadback:
        'Warn when a persisted cap or provider override is present, invalid, or stale. The rate-limit route names writer, units, binding term, and freshness and reports unknown rather than a fabricated safe value.',
      removalRelease: 'P-009/P-012 config gate: remove local maximum/override bounds after route and deployment parity is verified.',
      rollbackBehavior: rollbackCompatibilityText('operator rate-limit settings'),
      docsRunbookConsumers: [COMPATIBILITY_MATRIX_DOC, CAPACITY_RULE_DOC],
      apiConsumers: [
        'packages/operator-core/lib/endpoint-route/routes/operator/rate-limit-config.ts',
        'packages/operator-core/lib/rate-limit-config.ts :: clampRateLimitConfig',
        'operator:rate_limit_config and config:list-overrides',
      ],
      stateConsumers: [
        'packages/operator-core/lib/operator-state-pg.ts :: operator_rate_limit_config',
        'packages/operator-core/lib/fleet-rate-status.ts',
        'packages/operator-core/lib/agent-tools/gateway/gateway.ts :: gateway:status',
      ],
      disposition: 'readback-only',
      dispositionEvidence: {
        verdict: 'non-capacity',
        measuredAt: '2026-08-30',
        measurement:
          'P-009 deleted the baked 256 provider-override ceiling; clampProviderFloors carries that record and the only surviving bound is RATE_LIMIT_SANITY_BOUND = 100_000, which validates an operator-supplied number rather than sizing productive admission. Live GET /stats 2026-08-30T00:17Z: gateway admission is 503 — three orders of magnitude below the sanity bound, so it cannot be the binding term.',
        recheck:
          'grep -n RATE_LIMIT_MAX_CEILING packages/operator-core/lib/rate-limit-config.ts must find no live ceiling. Any code path clamping a healthy desired window down to a persisted operator maximum would falsify.',
      },
    }),
    compatibilityGroup({
      id: 'resource-profile-limits',
      field: 'resource-profile gateway-facing limits',
      legacyFields: [
        'ResourceProfile.maxSimultaneousAgents',
        'DEFAULT_RATE_LIMIT_CONFIG.maxSimultaneousAgents',
        'ResourceProfile.dbosQueueConcurrency',
        'ResourceProfile.pgPoolMax',
        'ResourceProfile.httpWorkers',
        'ResourceProfile.processCount',
      ],
      writerIds: ['rate-limit-resource-profile-seed', 'resource-profile-agent-cap'],
      observeOnlyMigration:
        'Retain host-profile outputs as attribution and bootstrap telemetry with signal provenance. A profile value may seed desired state once, but host formulas never become a gateway productive-capacity ceiling.',
      warningReadback:
        'Warn when a profile-derived value binds gateway admission and show cores, memory signal, host class, profile generation, seed age, and controller desired/effective state. Unknown host signals remain unknown.',
      removalRelease: 'P-004/P-009/P-012 profile gate: detach gateway admission from profile maxima while preserving profile telemetry for placement and diagnostics.',
      rollbackBehavior: rollbackCompatibilityText('resource-profile gateway limits'),
      docsRunbookConsumers: [COMPATIBILITY_MATRIX_DOC, CAPACITY_RULE_DOC],
      apiConsumers: [
        'packages/operator-core/lib/rate-limit-config.ts :: DEFAULT_RATE_LIMIT_CONFIG',
        'libs/generic/resource-profile/src/index.ts :: deriveResourceProfile',
        'GET /admin/config :: profile provenance',
      ],
      stateConsumers: [
        'packages/operator-core/lib/resource-profile.ts',
        'packages/operator-core/lib/fleet-rate-status.ts',
        'packages/operator-core/lib/resource-governor/state-snapshot.ts',
      ],
      disposition: 'feedback-only',
      dispositionEvidence: {
        verdict: 'non-capacity',
        measuredAt: '2026-08-30',
        measurement:
          'rate-limit-config.ts states plainly that maxSimultaneousAgents is the fleet-wide cap on concurrently-running agent SPAWNS, and P-009 added maxSimultaneousAgentsSource ("user" | "seed") to record whether an operator actually chose it. It is clamped only to [1, RATE_LIMIT_SANITY_BOUND]. For THIS matrix\'s subject — gateway admission — the profile values are attribution and one-time bootstrap telemetry: live GET /stats 2026-08-30T00:17Z shows admission at 503, derived by the controller from outcomes, with no profile term in the chain.',
        recheck:
          'Trace any host-profile field into setMaxConcurrent or the AIMD window: a profile-derived value reaching gateway admission would falsify. Live, an admission window that tracks a host formula instead of aimd increases/decreases would falsify.',
        caveat:
          'This row is NOT a deletion candidate. maxSimultaneousAgents is a real fleet-spawn control that an operator owns; removing it would delete a live placement bound in a different subsystem, not a gateway cap. The disposition says only that it does not bind gateway admission.',
      },
    }),
    compatibilityGroup({
      id: 'local-backend-physical-slots',
      field: 'local-backend maxConcurrent and provisioned parallel slots',
      legacyFields: ['LocalBackend.maxConcurrent', 'entry.serve.parallelSlots'],
      writerIds: ['local-backend-max-concurrent', 'local-backend-provisioner-slots'],
      observeOnlyMigration:
        'Read registered maxConcurrent and catalog parallelSlots as candidate physical-contract observations. Keep them only when the engine reports matching live slots/context and attach model/hardware evidence.',
      warningReadback:
        'Warn when a registered value has no fresh engine/health evidence or is used as gateway policy. Readback names backend id, engine response, observation age, and whether the term is measured physical or merely configured.',
      removalRelease: 'P-011 local-backend gate: remove duplicate gateway/client policy caps; retain an engine-required partition only as an evidenced physical contract.',
      rollbackBehavior: rollbackCompatibilityText('local-backend physical-slot policy'),
      docsRunbookConsumers: [COMPATIBILITY_MATRIX_DOC, CAPACITY_RULE_DOC],
      apiConsumers: [
        'packages/operator-core/lib/inference-gateway/local-backend-pool.ts :: select',
        'packages/operator-core/lib/inference-gateway/local-backend-store.ts :: registerLocalBackend',
        'packages/operator-core/lib/agent-tools/gateway/local-backends.ts',
      ],
      stateConsumers: [
        'packages/operator-core/lib/inference-gateway/physical-constraints.ts',
        'packages/operator-core/lib/inference-gateway/local-backend-pool.ts',
        'packages/operator-core/lib/inference-gateway/observability.ts',
      ],
      disposition: 'retain-measured-physical-contract',
      dispositionEvidence: {
        verdict: 'non-capacity',
        measuredAt: '2026-08-30',
        measurement:
          'The one registered backend on this deployment is ornith-llamaserver (kind llama-server, on-demand) with max_concurrent = 2 in harness_shared.local_backends, and its llama-server unit provisions exactly 2 parallel slots x 90112 ctx. The registered number therefore equals the engine\'s own partition rather than a gateway policy choice — which is precisely what makes it a measured physical contract and not a cap.',
        recheck:
          'Compare harness_shared.local_backends.max_concurrent against the engine unit\'s provisioned --parallel slots: a registered value ABOVE the engine partition, or one applied to a backend whose engine reports no slot count, would falsify. physical-constraints.ts holds the retention rule.',
        caveat:
          'This row is evidenced per BACKEND, not once for the family. A newly registered backend carries no evidence until its engine reports matching slots, and until then its maxConcurrent is a configured number wearing a physical label.',
      },
    }),
    compatibilityGroup({
      id: 'load-shed-retry-after',
      field: 'load-shed retry-after protocol hint',
      legacyFields: ['LOADSHED_RETRY_AFTER_SEC'],
      writerIds: ['gateway-loadshed-retry-after'],
      observeOnlyMigration:
        'Keep the retry-after number only as protocol metadata while durable acceptance returns a receipt; it never claims to measure provider or gateway capacity.',
      warningReadback:
        'Warn when the hint is emitted for a capacity condition and include actual receipt state/reason. Missing retry information is explicit, never a zero-second safe retry.',
      removalRelease: 'P-006/P-014 protocol gate: retain only if the client contract still needs a retry hint after durable receipt semantics.',
      rollbackBehavior: rollbackCompatibilityText('load-shed protocol hint'),
      docsRunbookConsumers: [COMPATIBILITY_MATRIX_DOC, CAPACITY_RULE_DOC],
      apiConsumers: [
        'packages/operator-core/lib/inference-gateway/gateway.ts :: QueueFullError handler',
        'Anthropic/OpenAI-compatible HTTP response retry-after header',
      ],
      stateConsumers: [
        'packages/operator-core/lib/resource-governor/queue.ts :: QueueReceipt',
        'packages/operator-core/lib/inference-gateway/request-stage-telemetry.ts',
        'packages/operator-core/lib/inference-gateway/observability.ts',
      ],
      disposition: 'retain-semantic-safety',
      dispositionEvidence: {
        verdict: 'non-capacity',
        measuredAt: '2026-08-30',
        measurement:
          'The retry-after hint is emitted only on the QueueFullError path, and that path is unreached on the spooled deployment: live GET /stats 2026-08-30T00:17Z reports shed429 = 0 across 27,329 requests with maxQueued = 0. The number is an HTTP protocol courtesy for a client that was refused, and it never enters an admission decision.',
        recheck:
          'curl /stats: any growth in shed429 means the path is live again — inspect whether the emitted hint claims to measure capacity. In source, the hint reaching setMaxConcurrent or the AIMD window would falsify.',
      },
    }),
    compatibilityGroup({
      id: 'probe-concurrency',
      field: 'provider capacity-probe concurrency',
      legacyFields: ['PROBE_CONCURRENCY'],
      writerIds: ['capacity-probe-concurrency'],
      observeOnlyMigration:
        'Retain probe parallelism as observation-sweep pacing with per-account receipts; it cannot bound productive inference admission.',
      warningReadback:
        'Warn when probe evidence is stale or incomplete and report probe count, account, status, timestamp, and external response. No probe result becomes a capacity ceiling.',
      removalRelease: 'P-003/P-009 evidence gate: move probe pacing to fresh provider health/contracts and keep it separate from productive admission.',
      rollbackBehavior: rollbackCompatibilityText('provider observation pacing'),
      docsRunbookConsumers: [COMPATIBILITY_MATRIX_DOC, CAPACITY_RULE_DOC],
      apiConsumers: [
        'packages/operator-core/lib/inference-gateway/capacity-probe.ts :: probeCapacityForAccounts',
        'GET /stats :: provider observation freshness',
      ],
      stateConsumers: [
        'packages/operator-core/lib/inference-gateway/physical-constraints.ts',
        'packages/operator-core/lib/inference-gateway/observability.ts',
        'packages/operator-core/lib/resource-governor/state-snapshot.ts',
      ],
      disposition: 'feedback-only',
      dispositionEvidence: {
        verdict: 'non-capacity',
        measuredAt: '2026-08-30',
        measurement:
          'Probe parallelism paces an observation sweep on its own timer, structurally separate from productive admission. Live GET /stats 2026-08-30T00:17Z: proactiveEgressProbe = { enabled: true, intervalMs: 45000, circuitOpens: 0 } while 416 productive requests were in flight — the probe budget and the admission window are different numbers moving independently.',
        recheck:
          'curl /stats: a productive in-flight count that tracks the probe concurrency, or a probe result feeding setMaxConcurrent, would falsify. capacity-probe.test.ts pins the separation.',
      },
    }),
    compatibilityGroup({
      id: 'status-and-readiness',
      field: 'gateway UI/API/state capacity readbacks',
      legacyFields: [
        'stats.admission.maxConcurrent',
        'stats.maxQueued',
        'stats.clamp.recommendation',
        'stats.clamp.applied',
        'stats.priorityTiers',
        'gateway:status',
        'admissionMaxQueued',
        'gateway!.queueDepth',
      ],
      writerIds: [
        'gateway-stats-writer',
        'gateway-admin-config-writer',
        'spawn-readiness-max-queued-reader',
        'gateway-status-tool-reader',
        'gateway-wedge-status-reader',
        'system-health-gateway-status-reader',
      ],
      observeOnlyMigration:
        'Keep read models live, annotating every legacy field with exact writer, unit, binding term, generation, observation time, and expiry. Readers never enforce a cap merely because a field exists.',
      warningReadback:
        'Warn on missing, stale, or unknown values and preserve that state verbatim. UI/API/alerts distinguish desired, effective, recommendation, applied, queue, and measured physical values instead of collapsing them to zero or safe.',
      removalRelease: 'P-013 canonical-state gate: update gateway:status, readiness, wedge, health, and runbooks to the one writer-traceable read model.',
      rollbackBehavior: rollbackCompatibilityText('capacity readback'),
      docsRunbookConsumers: [COMPATIBILITY_MATRIX_DOC, CAPACITY_RULE_DOC, ADMISSION_LOOP_DOC],
      apiConsumers: [
        'packages/operator-core/lib/inference-gateway/gateway.ts :: stats and /admin/config',
        'packages/operator-core/lib/agent-tools/gateway/gateway.ts :: gateway:status',
        'packages/operator-core/lib/inference-gateway/spawn-readiness.ts :: fetchGatewayReadinessSignals',
        'packages/operator-core/lib/inference-gateway/gateway-wedge.ts :: normalizeGatewayStats',
      ],
      stateConsumers: [
        'packages/operator-core/lib/inference-gateway/observability.ts',
        'packages/operator-core/lib/inference-gateway/admission-ceiling.ts',
        'packages/operator-core/lib/system-health/compute.ts',
        'packages/operator-core/lib/resource-governor/state-snapshot.ts',
      ],
      disposition: 'readback-only',
      dispositionEvidence: {
        verdict: 'non-capacity',
        measuredAt: '2026-08-30',
        measurement:
          'Every capacity number the status surfaces publish now travels with its binding term, which is what makes them readbacks rather than authorities. Live GET /stats 2026-08-30T00:17Z: clamp publishes recommendation 28 NEXT TO applied 503 and overridden true, so a reader cannot mistake the recommendation for what is in force; aimd publishes effective, cap and floor together; admission publishes maxConcurrent beside running, queued and tier1Reserve.',
        recheck:
          'curl /stats: a capacity figure published without its binding term (a bare recommendation, a cap with no effective, a tier share with no in-flight) would falsify. D-009 is the rule; observability.test.ts pins the shape.',
      },
    }),
  ]);

function flattenCompatibilityGroup(
  group: InferenceGatewayCapacityCompatibilityGroup,
  writerId: string,
): InferenceGatewayCapacityCompatibility {
  return Object.freeze({
    ...group,
    id: writerId,
    groupId: group.id,
    writerId,
    writerIds: Object.freeze([writerId]),
  });
}

/** One row for every exact writer in P-001, with its family policy expanded inline. */
export const INFERENCE_GATEWAY_CAPACITY_COMPATIBILITY_MATRIX: readonly InferenceGatewayCapacityCompatibility[] =
  Object.freeze(
    INFERENCE_GATEWAY_CAPACITY_COMPATIBILITY_GROUPS.flatMap((group) =>
      group.writerIds.map((writerId) => flattenCompatibilityGroup(group, writerId)),
    ),
  );

/** Short aliases used by P-004/P-012 migration and reporting consumers. */
export const INFERENCE_GATEWAY_COMPATIBILITY_MATRIX = INFERENCE_GATEWAY_CAPACITY_COMPATIBILITY_MATRIX;
export const CAPACITY_COMPATIBILITY_MATRIX = INFERENCE_GATEWAY_CAPACITY_COMPATIBILITY_MATRIX;

export const INFERENCE_GATEWAY_CAPACITY_COMPATIBILITY_FIELDS: readonly string[] = Object.freeze(
  INFERENCE_GATEWAY_CAPACITY_COMPATIBILITY_GROUPS.map((group) => group.field),
);

/** Return the migration contract for one exact P-001 writer. */
export function compatibilityForInferenceGatewayWriter(
  writerId: string,
): InferenceGatewayCapacityCompatibility | undefined {
  return INFERENCE_GATEWAY_CAPACITY_COMPATIBILITY_MATRIX.find((row) => row.writerId === writerId);
}

/**
 * Validate the P-004 matrix against the P-001 census. This is independent of
 * the source scanner: an anchor can be present while a release contract is
 * missing, and that omission must fail before rollout.
 */
export function validateInferenceGatewayCapacityCompatibilityMatrix(
  rows: readonly InferenceGatewayCapacityCompatibility[] = INFERENCE_GATEWAY_CAPACITY_COMPATIBILITY_MATRIX,
  inventory: readonly InferenceGatewayCapacityWriter[] = INFERENCE_GATEWAY_CAPACITY_INVENTORY,
): string[] {
  const findings: string[] = [];
  const inventoryIds = new Set(inventory.map((row) => row.id));
  const seen = new Set<string>();
  const covered = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.id)) findings.push('duplicate-compatibility:' + row.id);
    seen.add(row.id);
    if (!inventoryIds.has(row.writerId)) findings.push('compatibility-unknown-writer:' + row.writerId);
    covered.add(row.writerId);
    const required: Array<keyof InferenceGatewayCapacityCompatibility> = [
      'id',
      'groupId',
      'writerId',
      'field',
      'observeOnlyMigration',
      'warningReadback',
      'removalRelease',
      'rollbackBehavior',
    ];
    for (const field of required) {
      const value = row[field];
      if (typeof value !== 'string' || value.trim().length === 0) {
        findings.push('compatibility-missing:' + row.id + ':' + field);
      }
    }
    for (const [name, values] of [
      ['legacyFields', row.legacyFields],
      ['legacyKeys', row.legacyKeys],
      ['writerIds', row.writerIds],
      ['docsRunbookConsumers', row.docsRunbookConsumers],
      ['apiConsumers', row.apiConsumers],
      ['stateConsumers', row.stateConsumers],
      ['consumers', row.consumers],
    ] as const) {
      if (!Array.isArray(values) || values.length === 0 || values.some((value) => String(value).trim().length === 0)) {
        findings.push('compatibility-missing:' + row.id + ':' + name);
      }
    }
    if (row.rollbackNeverReinstatesNumericCap !== true) {
      findings.push('compatibility-rollback-cap-allowed:' + row.id);
    }
    if (!/never|without|observe-only/i.test(row.rollbackBehavior)) {
      findings.push('compatibility-rollback-not-observe-only:' + row.id);
    }
    if (!/^P-\d{3}/.test(row.removalRelease)) {
      findings.push('compatibility-removal-target:' + row.id);
    }
    if (!row.docsRunbookConsumers.some((path) => path.endsWith('.mdx') || path.endsWith('.md'))) {
      findings.push('compatibility-doc-consumer:' + row.id);
    }
    if (!row.consumers.some((consumer) => consumer.kind === 'test' && consumer.path === COMPATIBILITY_TEST)) {
      findings.push('compatibility-test-consumer:' + row.id);
    }
  }
  for (const row of inventory) {
    if (!covered.has(row.id)) findings.push('compatibility-uncovered-writer:' + row.id);
  }
  // A group whose writers are all DELETED flattens to zero rows, so the per-writer loop above
  // never sees it — the exact case that most needs checking. Fold the group-level contract in
  // whenever we are validating the real matrix, so no caller has to remember to ask for it.
  if (rows === INFERENCE_GATEWAY_CAPACITY_COMPATIBILITY_MATRIX) {
    findings.push(...validateInferenceGatewayCapacityCompatibilityGroups());
  }
  return findings;
}

/**
 * Group-level contract (P-015): a disposition is terminal or it names a pending gate, and a
 * terminal one must carry evidence whose verdict agrees with the census.
 *
 * This is separate from the per-writer validator above because it must also see groups with NO
 * live writers — `gateway-codex-concurrency` flattens to zero rows precisely BECAUSE P-010
 * deleted every writer in it, and a contract that stops checking a family at the moment it is
 * emptied is checking the wrong thing.
 */
export function validateInferenceGatewayCapacityCompatibilityGroups(
  groups: readonly InferenceGatewayCapacityCompatibilityGroup[] = INFERENCE_GATEWAY_CAPACITY_COMPATIBILITY_GROUPS,
): string[] {
  const findings: string[] = [];
  for (const group of groups) {
    const terminal = TERMINAL_CAPACITY_COMPATIBILITY_DISPOSITIONS.has(group.disposition);
    const evidence = group.dispositionEvidence;
    if (!terminal) {
      // `remove-after-gate` means "a gate is still pending". P-015 ran the last of them, so a row
      // still parked here is either unfinished work or a new writer that was filed and forgotten.
      findings.push('compatibility-non-terminal:' + group.id);
      if (evidence) findings.push('compatibility-evidence-on-pending:' + group.id);
      continue;
    }
    if (!evidence) {
      findings.push('compatibility-evidence-missing:' + group.id);
      continue;
    }
    for (const field of ['measurement', 'recheck'] as const) {
      if (typeof evidence[field] !== 'string' || evidence[field].trim().length === 0) {
        findings.push('compatibility-evidence-field:' + group.id + ':' + field);
      }
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(evidence.measuredAt ?? '')) {
      findings.push('compatibility-evidence-date:' + group.id);
    }
    // The verdict is cross-checked against the census rather than believed: "deleted" is only
    // true when no live writer remains, and "non-capacity" is a claim ABOUT a live writer.
    if (evidence.verdict === 'deleted') {
      if (group.writerIds.length > 0) findings.push('compatibility-evidence-verdict-deleted-has-writers:' + group.id);
      if (group.disposition !== 'removed') findings.push('compatibility-evidence-verdict-deleted-not-removed:' + group.id);
    } else if (evidence.verdict === 'non-capacity') {
      if (group.writerIds.length === 0) findings.push('compatibility-evidence-verdict-live-has-no-writers:' + group.id);
      if (group.disposition === 'removed') findings.push('compatibility-evidence-verdict-live-marked-removed:' + group.id);
    } else {
      findings.push('compatibility-evidence-verdict:' + group.id);
    }
  }
  return findings;
}

/** Alias for migration callers that use the shorter validator name. */
export const validateCapacityCompatibilityMatrix = validateInferenceGatewayCapacityCompatibilityMatrix;

/** Backward/short-name aliases for callers that use the census vocabulary. */
export const INFERENCE_GATEWAY_WRITER_INVENTORY = INFERENCE_GATEWAY_CAPACITY_INVENTORY;
export const CAPACITY_WRITER_INVENTORY = INFERENCE_GATEWAY_CAPACITY_INVENTORY;
export type CapacityWriter = InferenceGatewayCapacityWriter;

export const INFERENCE_GATEWAY_CAPACITY_INVENTORY_FILES: readonly string[] = Object.freeze(
  [...new Set(INFERENCE_GATEWAY_CAPACITY_INVENTORY.map((row) => row.file))],
);

const DISPOSITIONS = new Set<CapacityWriterDisposition>([
  'remove',
  'transient-feedback',
  'explicit-control-recovery-bypass',
  'semantic-protocol-safety',
  'measured-external-physical-contract',
]);

/** Validate the manifest itself before any source scan uses it. */
export function validateInferenceGatewayCapacityInventory(
  rows: readonly InferenceGatewayCapacityWriter[] = INFERENCE_GATEWAY_CAPACITY_INVENTORY,
): string[] {
  const findings: string[] = [];
  const ids = new Set<string>();
  const writers = new Set<string>();
  for (const row of rows) {
    if (ids.has(row.id)) findings.push(`duplicate-inventory:${row.id}`);
    ids.add(row.id);
    const writerKey = `${row.file}::${row.symbol}`;
    if (writers.has(writerKey)) findings.push(`duplicate-writer:${writerKey}`);
    writers.add(writerKey);
    const required: Array<keyof InferenceGatewayCapacityWriter> = [
      'id',
      'file',
      'symbol',
      'sourceAnchor',
      'sourceKind',
      'units',
      'owner',
      'liveEffect',
      'deletionTarget',
      'recurrenceTest',
      'durableSource',
      'telemetry',
      'contextPath',
    ];
    for (const field of required) {
      const value = row[field];
      if (typeof value !== 'string' || value.trim().length === 0) {
        findings.push(`inventory-missing:${row.id}:${field}`);
      }
    }
    if (!Array.isArray(row.dimensions) || row.dimensions.length === 0) {
      findings.push(`inventory-missing:${row.id}:dimensions`);
    }
    if (row.currentValue === undefined) findings.push(`inventory-missing:${row.id}:currentValue`);
    if (!DISPOSITIONS.has(row.disposition)) findings.push(`inventory-disposition:${row.id}`);
    if (row.disposition === 'remove' && !/P-\d{3}/.test(row.deletionTarget)) {
      findings.push(`inventory-removal-target:${row.id}`);
    }
    if (row.sourceAnchor.trim().length < 8) findings.push(`inventory-anchor-too-short:${row.id}`);
    if (row.disposition === 'measured-external-physical-contract' && !/evidence|measured|contract|telemetry/i.test(`${row.liveEffect} ${row.durableSource} ${row.telemetry}`)) {
      findings.push(`inventory-external-evidence:${row.id}`);
    }
  }
  return findings;
}

/** Remove comments and quoted literals while preserving line breaks for diagnostics. */
function executableSource(source: string): string {
  let out = '';
  let state: 'code' | 'line' | 'block' | 'single' | 'double' | 'template' = 'code';
  let escaped = false;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];
    if (state === 'line') {
      if (ch === '\n') {
        state = 'code';
        out += '\n';
      } else out += ' ';
      continue;
    }
    if (state === 'block') {
      if (ch === '*' && next === '/') {
        out += '  ';
        i += 1;
        state = 'code';
      } else {
        out += ch === '\n' ? '\n' : ' ';
      }
      continue;
    }
    if (state === 'single' || state === 'double' || state === 'template') {
      if (escaped) {
        out += ch === '\n' ? '\n' : ' ';
        escaped = false;
      } else if (ch === '\\') {
        out += ' ';
        escaped = true;
      } else if ((state === 'single' && ch === "'") || (state === 'double' && ch === '"') || (state === 'template' && ch === '`')) {
        out += ' ';
        state = 'code';
      } else {
        out += ch === '\n' ? '\n' : ' ';
      }
      continue;
    }
    if (ch === '/' && next === '/') {
      out += '  ';
      i += 1;
      state = 'line';
    } else if (ch === '/' && next === '*') {
      out += '  ';
      i += 1;
      state = 'block';
    } else if (ch === "'") {
      out += ' ';
      state = 'single';
    } else if (ch === '"') {
      out += ' ';
      state = 'double';
    } else if (ch === '`') {
      out += ' ';
      state = 'template';
    } else {
      out += ch;
    }
  }
  return out;
}

/** Names whose numeric declarations can create a gateway capacity ceiling or seed. */
export const CAPACITY_WRITER_SYMBOL_PATTERN =
  /^(?:[A-Z][A-Z0-9_]*(?:CONCURRENCY|MAX_QUEUED|MAX_CONCURRENT|SLOTS_PER_ACCOUNT|AIMD|SERVICEABLE|ADMISSION|TIER1_RESERVE|RATE_LIMIT_MAX_CEILING|FLOOR)[A-Z0-9_]*|DEFAULT_FLOORS)$/;

/**
 * Find named numeric capacity declarations in a source file.  This intentionally stays
 * conservative: protocol timeouts and unrelated collection bounds are not capacity
 * writers, while a new named concurrency/queue/floor/reserve declaration is surfaced.
 */
export function findInferenceGatewayCapacityDeclarations(source: string): Array<{ symbol: string; line: number }> {
  const code = executableSource(source);
  const declarations: Array<{ symbol: string; line: number }> = [];
  const declaration = /\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]+)?=\s*([^;\n]*\b\d+(?:\.\d+)?\b[^;\n]*)/g;
  for (const match of code.matchAll(declaration)) {
    const symbol = match[1];
    if (!CAPACITY_WRITER_SYMBOL_PATTERN.test(symbol)) continue;
    // A capacity writer declares a NUMBER. A schema-version or key string that merely
    // CONTAINS a digit ('…-v1') is not one, and flagging it produces an unclassifiable
    // finding an author can only silence by renaming — which is how a guard teaches
    // people to work around it. Matches this file's own stated contract: "protocol
    // timeouts and unrelated collection bounds are not capacity writers".
    if (/^\s*(['"`])/.test(match[2] ?? '')) continue;
    const line = code.slice(0, match.index ?? 0).split('\n').length;
    declarations.push({ symbol, line });
  }
  return declarations;
}

export interface CapacityInventorySourceFile {
  readonly path: string;
  readonly source: string;
}

export interface ScanInferenceGatewayCapacityOptions {
  readonly rows?: readonly InferenceGatewayCapacityWriter[];
  /** Prefixes to scan for newly declared named writers. Omit to use the production scope. */
  readonly scopePrefixes?: readonly string[];
  /** Skip the source-declaration scan while doing a narrow anchor-only check. */
  readonly declarations?: boolean;
}

export const INFERENCE_GATEWAY_CAPACITY_SCOPE_PREFIXES: readonly string[] = Object.freeze([
  'packages/operator-core/lib/inference-gateway/',
  'packages/operator-core/lib/rate-limit-config.ts',
  'packages/operator-core/lib/resource-profile.ts',
  'packages/operator-core/lib/agent-tools/gateway/',
  'packages/operator-core/lib/fleet/capacity-dispatch.ts',
  'packages/operator-core/lib/provisioner/provision.ts',
  'packages/operator-core/lib/system-health/compute.ts',
  'libs/papercusp-shared/src/resilience/',
  'libs/papercusp-shared/src/agent/governor-registry.ts',
  'libs/generic/resource-profile/src/index.ts',
  'apps/operator/scripts/systemd/papercup-inference-gateway.service',
]);

function inScope(path: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => path === prefix || path.startsWith(prefix));
}

function isCapacityInventorySourceFileList(
  files: readonly CapacityInventorySourceFile[] | ReadonlyMap<string, string>,
): files is readonly CapacityInventorySourceFile[] {
  return Array.isArray(files);
}

/**
 * Verify every row against its exact source anchor and detect a new named numeric
 * capacity declaration that has no row.  The function accepts synthetic sources so
 * the recurrence guard can prove its negative path without mutating the shared tree.
 */
export function scanInferenceGatewayCapacityInventory(
  files: readonly CapacityInventorySourceFile[] | ReadonlyMap<string, string>,
  options: ScanInferenceGatewayCapacityOptions = {},
): string[] {
  const rows = options.rows ?? INFERENCE_GATEWAY_CAPACITY_INVENTORY;
  const sourceMap = new Map<string, string>();
  if (isCapacityInventorySourceFileList(files)) {
    for (const file of files) sourceMap.set(file.path, file.source);
  } else {
    for (const [path, source] of files) sourceMap.set(path, source);
  }
  const findings = [...validateInferenceGatewayCapacityInventory(rows)];
  const byWriter = new Set(rows.map((row) => `${row.file}::${row.symbol}`));
  for (const row of rows) {
    const source = sourceMap.get(row.file);
    if (source === undefined) {
      findings.push(`writer-source-missing:${row.id}:${row.file}`);
    } else if (!source.includes(row.sourceAnchor)) {
      findings.push(`writer-anchor-missing:${row.id}:${row.file}:${row.symbol}`);
    }
  }
  if (options.declarations === false) return findings;
  const prefixes = options.scopePrefixes ?? INFERENCE_GATEWAY_CAPACITY_SCOPE_PREFIXES;
  for (const [path, source] of sourceMap) {
    if (!inScope(path, prefixes) || /(?:^|\/)(?:dist|node_modules)\//.test(path) || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path)) continue;
    for (const declaration of findInferenceGatewayCapacityDeclarations(source)) {
      if (!byWriter.has(`${path}::${declaration.symbol}`)) {
        findings.push(`unclassified-writer:${path}:${declaration.symbol}:${declaration.line}`);
      }
    }
  }
  return findings;
}

/** Short aliases used by source-census tests and downstream migration items. */
export const validateCapacityInventory = validateInferenceGatewayCapacityInventory;
export const scanCapacityInventory = scanInferenceGatewayCapacityInventory;
