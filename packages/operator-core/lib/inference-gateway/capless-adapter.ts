/**
 * Inference-gateway adapter for the capless resource-governor controller.
 *
 * The HTTP gateway has provider/protocol facts while the controller speaks in
 * generic admission classes and resource demand.  This module is the typed
 * seam between those two worlds.  It also owns the small durable envelope used
 * to carry controller feedback across gateway restarts.  The envelope contains
 * desired/effective *state* and expiring evidence; it never stores a configured
 * maximum.
 */

import {
  CaplessAdaptiveController,
  CAPLESS_CONTROLLER_STATE_SCHEMA_VERSION,
  type CaplessControllerOptions,
  type CaplessControllerState,
  type CaplessControllerDecision,
  type ControllerClassSample,
} from '../resource-governor/controller';
import type { HealthVerdict } from '../resource-governor/health-analysis';
import { readSharedSnapshot, writeSharedSnapshot } from '../derived-reads/shared-snapshot';
import {
  gatewayAdmissionClassFor,
  toGatewayAdmissionRequest,
  type GatewayAdmissionKind,
  type GatewayAdmissionRequestInput,
} from './admission-context';

export const CAPLESS_GATEWAY_ADAPTER_SCHEMA_VERSION = 'inference-gateway-capless-adapter-v1' as const;
export const CAPLESS_GATEWAY_STATE_SNAPSHOT_VERSION = 1;
export const CAPLESS_GATEWAY_STATE_SNAPSHOT_KEY = 'inference-gateway.capless-controller';

/** Durable state envelope. `legacySeed` is compatibility metadata, not a cap. */
export interface CaplessGatewayAdapterState {
  readonly schemaVersion: typeof CAPLESS_GATEWAY_ADAPTER_SCHEMA_VERSION;
  readonly controller: CaplessControllerState;
  readonly legacySeed?: {
    readonly window: number;
    readonly seededAtMs: number;
    readonly expiresAtMs: number;
  };
}

/** Minimal async persistence seam; production uses the shared snapshot store. */
export interface CaplessGatewayStateStore {
  load(key: string): Promise<CaplessGatewayAdapterState | null>;
  save(key: string, state: CaplessGatewayAdapterState): Promise<void>;
}

/** Shared Postgres snapshot implementation used by long-lived gateway hosts. */
export class SharedSnapshotCaplessGatewayStateStore implements CaplessGatewayStateStore {
  constructor(
    private readonly workspaceId: string,
    private readonly maxAgeMs = Number.POSITIVE_INFINITY,
  ) {}

  async load(key: string): Promise<CaplessGatewayAdapterState | null> {
    const row = await readSharedSnapshot<CaplessGatewayAdapterState>(
      key,
      this.workspaceId,
      CAPLESS_GATEWAY_STATE_SNAPSHOT_VERSION,
      this.maxAgeMs,
    );
    return row?.payload ?? null;
  }

  save(key: string, state: CaplessGatewayAdapterState): Promise<void> {
    return writeSharedSnapshot(key, this.workspaceId, state, CAPLESS_GATEWAY_STATE_SNAPSHOT_VERSION);
  }
}

/** Deterministic store useful for unit tests and single-process development hosts. */
export class InMemoryCaplessGatewayStateStore implements CaplessGatewayStateStore {
  readonly #rows = new Map<string, CaplessGatewayAdapterState>();

  async load(key: string): Promise<CaplessGatewayAdapterState | null> {
    return this.#rows.get(key) ?? null;
  }

  async save(key: string, state: CaplessGatewayAdapterState): Promise<void> {
    this.#rows.set(key, state);
  }
}

export interface CaplessGatewayEvaluationInput {
  readonly verdict: HealthVerdict;
  /** Generic samples are useful for non-HTTP callers and test fixtures. */
  readonly classes?: readonly ControllerClassSample[];
  /** Gateway requests are converted to canonical class/demand samples. */
  readonly requests?: readonly GatewayAdmissionRequestInput[];
  readonly atMs?: number;
}

export interface CaplessGatewayAdapterOptions
  extends Omit<CaplessControllerOptions, 'state' | 'initialWindow'> {
  readonly controller?: CaplessAdaptiveController;
  readonly stateStore?: CaplessGatewayStateStore;
  readonly stateKey?: string;
  /** One-time compatibility seed. It is persisted only as expiring metadata. */
  readonly legacyInitialWindow?: number;
  readonly legacySeedTtlMs?: number;
  /** Alias retained for callers migrating from controller construction options. */
  readonly initialWindow?: number;
  readonly now?: () => number;
}

function finitePositive(value: number | undefined): number | null {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : null;
}

function normalizedSeed(options: CaplessGatewayAdapterOptions): number | undefined {
  const value = finitePositive(options.legacyInitialWindow ?? options.initialWindow);
  return value === null ? undefined : Math.floor(value);
}

function gatewaySamples(requests: readonly GatewayAdmissionRequestInput[]): ControllerClassSample[] {
  return requests.map((input) => {
    const request = toGatewayAdmissionRequest(input);
    return {
      admissionClass: request.admissionClass,
      inFlight: 1,
      demand: request.demand,
    };
  });
}

/** Convert one gateway kind to the controller's canonical class. */
export function gatewayControllerClass(kind: GatewayAdmissionKind) {
  return gatewayAdmissionClassFor(kind);
}

/**
 * Stateful, durable adapter around `CaplessAdaptiveController`.
 *
 * Hydration is asynchronous because the canonical state store is shared.  All
 * evaluation methods await `ready`, so a cold gateway never makes a decision
 * from its compatibility seed before persisted feedback has been considered.
 */
export class CaplessGatewayAdmissionAdapter {
  readonly controller: CaplessAdaptiveController;
  readonly stateKey: string;
  readonly #store: CaplessGatewayStateStore | undefined;
  readonly #now: () => number;
  readonly #legacySeedWindow: number | undefined;
  readonly #legacySeedTtlMs: number;
  readonly #ready: Promise<void>;
  #legacySeed: CaplessGatewayAdapterState['legacySeed'] | undefined;
  #latest: CaplessControllerDecision | null = null;
  #writeTail: Promise<void> = Promise.resolve();

  constructor(options: CaplessGatewayAdapterOptions = {}) {
    this.#now = options.now ?? (() => Date.now());
    this.#store = options.stateStore;
    this.stateKey = options.stateKey?.trim() || CAPLESS_GATEWAY_STATE_SNAPSHOT_KEY;
    this.#legacySeedWindow = normalizedSeed(options);
    this.#legacySeedTtlMs = Math.max(1, Math.floor(options.legacySeedTtlMs ?? 30 * 60_000));
    const controllerOptions: CaplessControllerOptions = {
      ...options,
      ...(this.#legacySeedWindow === undefined ? {} : { initialWindow: this.#legacySeedWindow }),
    };
    delete (controllerOptions as { controller?: CaplessAdaptiveController }).controller;
    delete (controllerOptions as { stateStore?: CaplessGatewayStateStore }).stateStore;
    delete (controllerOptions as { stateKey?: string }).stateKey;
    delete (controllerOptions as { legacyInitialWindow?: number }).legacyInitialWindow;
    delete (controllerOptions as { legacySeedTtlMs?: number }).legacySeedTtlMs;
    delete (controllerOptions as { now?: () => number }).now;
    this.controller = options.controller ?? new CaplessAdaptiveController(controllerOptions);
    this.#ready = this.#hydrate();
  }

  /** Resolves after the persisted controller state (if any) has been loaded. */
  ready(): Promise<void> {
    return this.#ready;
  }

  async #hydrate(): Promise<void> {
    if (!this.#store) {
      if (this.#legacySeedWindow !== undefined) {
        const seededAtMs = this.#now();
        this.#legacySeed = {
          window: this.#legacySeedWindow,
          seededAtMs,
          expiresAtMs: seededAtMs + this.#legacySeedTtlMs,
        };
      }
      return;
    }
    const persisted = await this.#store.load(this.stateKey);
    if (persisted?.schemaVersion !== CAPLESS_GATEWAY_ADAPTER_SCHEMA_VERSION) {
      if (this.#legacySeedWindow !== undefined) {
        const seededAtMs = this.#now();
        this.#legacySeed = {
          window: this.#legacySeedWindow,
          seededAtMs,
          expiresAtMs: seededAtMs + this.#legacySeedTtlMs,
        };
      }
      return;
    }
    if (persisted.controller?.schemaVersion === CAPLESS_CONTROLLER_STATE_SCHEMA_VERSION) {
      this.controller.restore(persisted.controller);
    }
    const seed = persisted.legacySeed;
    if (
      seed &&
      Number.isFinite(seed.window) &&
      seed.window > 0 &&
      Number.isFinite(seed.seededAtMs) &&
      Number.isFinite(seed.expiresAtMs) &&
      seed.expiresAtMs > this.#now()
    ) {
      this.#legacySeed = Object.freeze({ ...seed });
    }
  }

  /** Evaluate one health tick and durably publish the resulting feedback state. */
  async step(input: CaplessGatewayEvaluationInput): Promise<CaplessControllerDecision> {
    await this.#ready;
    const classes = [
      ...(input.classes ?? []),
      ...(input.requests ? gatewaySamples(input.requests) : []),
    ];
    const decision = this.controller.step({ verdict: input.verdict, classes, atMs: input.atMs });
    this.#latest = decision;
    await this.persist(input.atMs ?? decision.evaluatedAtMs);
    return decision;
  }

  /** Alias that reads naturally at gateway health-publisher call sites. */
  evaluate(input: CaplessGatewayEvaluationInput): Promise<CaplessControllerDecision> {
    return this.step(input);
  }

  /** Latest in-process decision, or null before the first evaluated health tick. */
  get latest(): CaplessControllerDecision | null {
    return this.#latest;
  }

  /** Return a class decision from the latest tick without inventing a capacity value. */
  decisionFor(admissionClass: string): CaplessControllerDecision['classes'][number] | null {
    return this.#latest?.classes.find((item) => item.admissionClass === admissionClass) ?? null;
  }

  /** Snapshot suitable for status/read-model consumers and tests. */
  state(atMs = this.#now()): CaplessGatewayAdapterState {
    const now = Number.isFinite(atMs) ? Math.max(0, Math.floor(atMs)) : this.#now();
    const seed = this.#legacySeed && this.#legacySeed.expiresAtMs > now ? this.#legacySeed : undefined;
    return Object.freeze({
      schemaVersion: CAPLESS_GATEWAY_ADAPTER_SCHEMA_VERSION,
      controller: this.controller.snapshot(now),
      ...(seed ? { legacySeed: seed } : {}),
    });
  }

  /** Persist in order so concurrent health ticks cannot overwrite newer state. */
  async persist(atMs = this.#now()): Promise<void> {
    if (!this.#store) return;
    if (this.#legacySeed && this.#legacySeed.expiresAtMs <= atMs) this.#legacySeed = undefined;
    const state = this.state(atMs);
    const write = this.#writeTail.then(() => this.#store!.save(this.stateKey, state));
    this.#writeTail = write.catch(() => undefined);
    await write;
  }
}
