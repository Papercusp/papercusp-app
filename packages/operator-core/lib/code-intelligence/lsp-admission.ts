/** Daemon-side class admission. Transport and capability interpretation stay outside this module. */
import { createHash } from 'node:crypto';
import { pinModuleState } from '@papercusp/module-singleton';
import { CaplessAdaptiveController, type CaplessControllerOptions } from '../resource-governor/controller';
import { RollingHealthAnalyzer, type HealthVerdict } from '../resource-governor/health-analysis';
import type { LiveHealthReading } from '../resource-governor/live-health';
import type { CodeIntelAnswer, CodeIntelIntent } from './contracts';
import type { LspQueryEvent } from './lsp-query-evidence';

export interface LspAdmissionContext {
  readonly workspaceId: string;
  readonly requestId: string;
  readonly language: string;
  readonly projectRoot: string;
  readonly op: string;
  readonly actor?: string;
  readonly priority?: number;
  readonly deadlineAtMs: number;
  readonly signal?: AbortSignal;
  /** Caller-facing query label; the cost identity may be hashed and is not display text. */
  readonly query?: string;
  /** Stable cursor/symbol identity, supplied at the resolved dispatch seam. */
  readonly queryKey?: string;
  /** Evidence-backed cost classification; unknown is never assumed cheap. */
  readonly symbolCost?: 'index-hit' | 'scan' | 'unknown';
  /** Request-bound observer; queued work must never inherit the drainer's identity. */
  readonly observe?: (event: LspQueryEvent) => void;
}

export interface LspAdmissionReceipt {
  start(): Promise<void>;
  finish(): Promise<void>;
  cancel(reason: string): Promise<void>;
}

export interface LspAdmissionOptions {
  readonly now?: () => number;
  readonly controller?: CaplessControllerOptions;
  /** Persist pressure waiters before allowing them to execute. A failed write refuses the request. */
  readonly enqueue: (context: LspAdmissionContext, classKey: string) => Promise<LspAdmissionReceipt>;
  readonly agingIntervalMs?: number;
  /** Cost observation policy, never a productive capacity ceiling. */
  readonly indexHitMaxMs?: number;
  readonly costObservationTtlMs?: number;
}

export class LspAdmissionError extends Error {
  constructor(readonly code: 'deadline' | 'cancelled' | 'persistence', message: string) {
    super(message);
    this.name = 'LspAdmissionError';
  }
}

interface Waiter {
  readonly context: LspAdmissionContext;
  readonly classKey: string;
  readonly enqueuedAt: number;
  readonly sequence: number;
  readonly abort: AbortController;
  readonly task: (signal: AbortSignal) => Promise<unknown>;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
  cleanup(): void;
  ready: boolean;
  started: boolean;
  abandoned: boolean;
  receipt?: LspAdmissionReceipt;
  serviceStartedAt?: number;
}

interface ClassLane {
  inFlight: number;
  readonly served: Map<string, number>;
  readonly health: RollingHealthAnalyzer;
  lastVerdict?: HealthVerdict;
}

function healthyResult(value: unknown): boolean {
  if (!value || typeof value !== 'object' || !('freshness' in value)) return true;
  const answer = value as CodeIntelAnswer;
  return answer.freshness?.health === 'healthy' && !answer.error;
}

export function lspAdmissionClass(context: LspAdmissionContext): string {
  // A server is shared; methods and measured symbol costs do not share a FIFO or window.
  return JSON.stringify([context.language, context.projectRoot, context.op, context.symbolCost ?? 'unknown']);
}

const HEALTH_VERSION: HealthVerdict['schemaVersion'] = 'resource-governor-health-analysis-v1';
function neutralVerdict(scopeId: string, atMs: number, healthy = false): HealthVerdict {
  return {
    schemaVersion: HEALTH_VERSION, scopeId, evaluatedAtMs: atMs,
    state: healthy ? 'healthy' : 'unknown', severity: 'none', actionable: false,
    evidence: [], attributions: [], actionableResources: [], ignoredCapacitySignals: [], reasons: [],
  };
}

export class LspAdmissionController {
  readonly #now: () => number;
  readonly #enqueue: LspAdmissionOptions['enqueue'];
  readonly #agingIntervalMs: number;
  readonly #controller: CaplessAdaptiveController;
  readonly #indexHitMaxMs: number;
  readonly #costObservationTtlMs: number;
  readonly #costs = new Map<string, { cost: NonNullable<LspAdmissionContext['symbolCost']>; durationMs: number; observedAtMs: number }>();
  readonly #settlementFailures = new Map<string, { error: string; action: () => Promise<void> }>();
  readonly #lanes = new Map<string, ClassLane>();
  readonly #waiters: Waiter[] = [];
  #probeTimer?: ReturnType<typeof setTimeout>;
  #settlementTimer?: ReturnType<typeof setTimeout>;
  #sequence = 0;

  constructor(options: LspAdmissionOptions) {
    this.#now = options.now ?? Date.now;
    this.#enqueue = options.enqueue;
    // Ordering policy, not a queue or productive-capacity maximum.
    this.#agingIntervalMs = options.agingIntervalMs ?? 1_000;
    if (!Number.isFinite(this.#agingIntervalMs) || this.#agingIntervalMs <= 0) {
      throw new Error('agingIntervalMs must be positive');
    }
    this.#controller = new CaplessAdaptiveController(options.controller);
    this.#indexHitMaxMs = options.indexHitMaxMs ?? 25;
    this.#costObservationTtlMs = options.costObservationTtlMs ?? 60_000;
    if (!Number.isFinite(this.#indexHitMaxMs) || this.#indexHitMaxMs < 0 ||
        !Number.isFinite(this.#costObservationTtlMs) || this.#costObservationTtlMs <= 0) {
      throw new Error('LSP cost observation policy must be finite and positive');
    }
  }

  #lane(key: string): ClassLane {
    let lane = this.#lanes.get(key);
    if (!lane) {
      lane = { inFlight: 0, served: new Map(), health: new RollingHealthAnalyzer({
        objectives: [{ id: 'lsp-wire-service', signal: 'service.waitP95Ms', resource: 'service',
          warningRatio: 2, criticalRatio: 5, minimumAbsoluteIncrease: 25,
          description: 'Measured service time in this method and cost lane compared with its own healthy history.' }],
        commitHealthyFrames: false,
      }) };
      this.#lanes.set(key, lane);
      this.#controller.step({ verdict: neutralVerdict(key, this.#now()), classes: [{ admissionClass: key, inFlight: 0 }] });
    }
    return lane;
  }

  /** Only the measured, attributable class is contracted; expiry remains governor-owned. */
  observeHealth(classKey: string, verdict: HealthVerdict): void {
    // A host/global verdict is not evidence about a particular LSP class.
    if (verdict.scopeId !== classKey || !Number.isFinite(verdict.evaluatedAtMs) ||
        verdict.evaluatedAtMs > this.#now() || this.#now() - verdict.evaluatedAtMs > 30_000) return;
    const lane = this.#lane(classKey);
    lane.lastVerdict = verdict;
    this.#controller.step({ verdict, classes: [{
      admissionClass: classKey, inFlight: Math.max(1, lane.inFlight),
      resourceWeights: Object.fromEntries(verdict.actionableResources.map(resource => [resource, 1])),
    }] });
    this.#drain();
  }

  #costKey(context: LspAdmissionContext): string | undefined {
    return context.queryKey ? JSON.stringify([context.language, context.projectRoot, context.op, context.queryKey]) : undefined;
  }

  #expireCosts(): void {
    const atMs = this.#now();
    for (const [key, observation] of this.#costs) {
      if (atMs - observation.observedAtMs >= this.#costObservationTtlMs) this.#costs.delete(key);
    }
  }

  classify(context: LspAdmissionContext): LspAdmissionContext {
    this.#expireCosts();
    const key = this.#costKey(context);
    return { ...context, symbolCost: context.symbolCost ?? (key ? this.#costs.get(key)?.cost : undefined) ?? 'unknown' };
  }

  #observeService(waiter: Waiter, healthy: boolean, atMs = this.#now()): void {
    if (waiter.serviceStartedAt === undefined) return;
    const durationMs = Math.max(0, atMs - waiter.serviceStartedAt);
    const key = this.#costKey(waiter.context);
    if (key && healthy) this.#costs.set(key, {
      cost: durationMs <= this.#indexHitMaxMs ? 'index-hit' : 'scan', durationMs, observedAtMs: atMs,
    });
    else if (key) this.#costs.delete(key);
    const lane = this.#lane(waiter.classKey);
    const reading: LiveHealthReading = {
      state: 'measured', value: durationMs, unit: 'milliseconds', writerId: waiter.classKey,
      observedAtMs: atMs, collectedAtMs: atMs,
      window: { kind: 'delta', durationMs, startedAtMs: waiter.serviceStartedAt, endedAtMs: atMs },
      confidence: 1, reason: null, lastMeasuredAtMs: atMs,
    };
    const frame = { scopeId: waiter.classKey, atMs, signals: { 'service.waitP95Ms': reading } };
    const verdict = lane.health.evaluate(frame);
    // A failed/refused answer never supplies an upward probe or healthy baseline.
    if (healthy && verdict.state !== 'degraded') lane.health.primeHealthy(frame);
    this.observeHealth(waiter.classKey, healthy && verdict.state === 'warming'
      ? neutralVerdict(waiter.classKey, atMs, true)
      : !healthy && verdict.state !== 'degraded' ? neutralVerdict(waiter.classKey, atMs) : verdict);
  }

  async #settle(waiter: Waiter, action: () => Promise<void>): Promise<void> {
    try { await action(); this.#settlementFailures.delete(waiter.context.requestId); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#settlementFailures.set(waiter.context.requestId, { error: message, action });
      this.#scheduleSettlementRecovery();
      throw new LspAdmissionError('persistence', `LSP receipt settlement failed: ${message}`);
    }
  }

  #scheduleSettlementRecovery(): void {
    if (this.#settlementTimer || !this.#settlementFailures.size) return;
    // Governed receipts permit serialized retries after transport failures. Keep
    // the exact terminal action until it succeeds, including late cancellations
    // whose caller has already left; the durable queue remains authoritative.
    this.#settlementTimer = setTimeout(() => {
      void Promise.all([...this.#settlementFailures].map(async ([requestId, pending]) => {
        try {
          await pending.action();
          if (this.#settlementFailures.get(requestId) === pending) this.#settlementFailures.delete(requestId);
        } catch (error) {
          pending.error = error instanceof Error ? error.message : String(error);
        }
      })).finally(() => {
        this.#settlementTimer = undefined;
        this.#scheduleSettlementRecovery();
      });
    }, 1_000);
    this.#settlementTimer.unref?.();
  }

  snapshot() {
    this.#expireCosts();
    const atMs = this.#now();
    const windows = this.#controller.snapshot(atMs);
    const queued = this.#waiters.filter(w => !w.started && !w.abandoned).length;
    const inFlight = [...this.#lanes.values()].reduce((sum, lane) => sum + lane.inFlight, 0);
    return {
      generation: windows.generation, sampledAtMs: atMs,
      assessment: this.#settlementFailures.size ? 'settlement-failed' : queued ? 'pressure' : inFlight ? 'active' : 'idle',
      queued, inFlight,
      measured: true, settlementFailures: [...this.#settlementFailures].map(([requestId, pending]) => ({ requestId, error: pending.error })),
      costObservations: this.#costs.size,
      classes: windows.classes.map(item => {
        const queued = this.#waiters.filter(waiter => waiter.classKey === item.admissionClass && !waiter.started && !waiter.abandoned);
        return {
          classKey: item.admissionClass, desiredWindow: item.desiredWindow,
          effectiveWindow: item.effectiveWindow, inFlight: this.#lanes.get(item.admissionClass)?.inFlight ?? 0,
          queued: queued.length, oldestWaitMs: queued.length ? atMs - Math.min(...queued.map(w => w.enqueuedAt)) : 0,
          pendingPersistence: queued.filter(waiter => !waiter.ready).length,
          feedback: item.feedback, health: this.#lanes.get(item.admissionClass)?.lastVerdict ?? null,
        };
      }),
    };
  }

  run<T>(context: LspAdmissionContext, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (!context.workspaceId || !context.requestId || !context.language || !context.projectRoot || !context.op ||
        !Number.isFinite(context.deadlineAtMs) || !Number.isFinite(context.priority ?? 0)) {
      return Promise.reject(new Error('LSP admission needs resolved identity, finite priority, and caller deadline'));
    }
    if (context.signal?.aborted) return Promise.reject(new LspAdmissionError('cancelled', 'LSP request cancelled before admission'));
    if (context.deadlineAtMs <= this.#now()) return Promise.reject(new LspAdmissionError('deadline', 'LSP request deadline elapsed before admission'));
    context = this.classify(context);
    const classKey = lspAdmissionClass(context);
    context.observe?.({ phase: 'admission-queued', atMs: this.#now(), classKey });
    this.#lane(classKey);
    return new Promise<T>((resolve, reject) => {
      const waiter: Waiter = {
        context, classKey, enqueuedAt: this.#now(), sequence: this.#sequence++, abort: new AbortController(),
        task, resolve: value => resolve(value as T), reject, ready: true, started: false, abandoned: false,
        cleanup: () => {},
      };
      const abandon = (code: 'deadline' | 'cancelled') => {
        if (waiter.abandoned) return;
        waiter.abandoned = true;
        const error = new LspAdmissionError(code, `LSP request ${code === 'deadline' ? 'deadline elapsed' : 'cancelled'}`);
        waiter.abort.abort(error);
        waiter.cleanup();
        reject(error);
        if (!waiter.started) {
          this.#remove(waiter);
          if (waiter.receipt) void this.#settle(waiter, () => waiter.receipt!.cancel(error.message)).catch(() => undefined);
          this.#drain();
        }
        else this.#observeService(waiter, false);
        // An ignored cancellation is still running on the wire. Do not release its slot/receipt early.
      };
      const onAbort = () => abandon('cancelled');
      let timer: ReturnType<typeof setTimeout>;
      const scheduleDeadline = () => {
        const remainingMs = context.deadlineAtMs - this.#now();
        if (remainingMs <= 0) { abandon('deadline'); return; }
        // Node truncates delays beyond its signed 32-bit range to 1ms. Chunk
        // the timer and re-check the absolute deadline instead of expiring early.
        timer = setTimeout(scheduleDeadline, Math.min(2_147_483_647, Math.max(1, Math.ceil(remainingMs))));
      };
      waiter.cleanup = () => { clearTimeout(timer); context.signal?.removeEventListener('abort', onAbort); };
      context.signal?.addEventListener('abort', onAbort, { once: true });
      scheduleDeadline();
      this.#waiters.push(waiter);
      // A synchronous reservation prevents two callers from spending the same class credit.
      this.#drain();
      if (waiter.started) return;
      waiter.ready = false;
      void this.#enqueue(context, classKey).then(async receipt => {
        waiter.receipt = receipt;
        if (waiter.abandoned) { await this.#settle(waiter, () => receipt.cancel('LSP caller abandoned during queue persistence')); return; }
        waiter.ready = true;
        this.#drain();
      }).catch(error => {
        this.#remove(waiter);
        waiter.cleanup();
        waiter.abandoned = true;
        reject(new LspAdmissionError('persistence', `LSP queue receipt failed: ${error instanceof Error ? error.message : String(error)}`));
      });
    });
  }

  #remove(waiter: Waiter): void {
    const index = this.#waiters.indexOf(waiter);
    if (index >= 0) this.#waiters.splice(index, 1);
  }

  #drain(): void {
    clearTimeout(this.#probeTimer);
    this.#probeTimer = undefined;
    const atMs = this.#now();
    const windows = this.#controller.snapshot(atMs);
    for (const window of windows.classes) {
      const lane = this.#lane(window.admissionClass);
      while (lane.inFlight < (this.#controller.snapshot(this.#now()).classes.find(c => c.admissionClass === window.admissionClass)?.effectiveWindow ?? window.desiredWindow)) {
        const candidates = this.#waiters.filter(w => w.ready && !w.started && !w.abandoned && w.classKey === window.admissionClass);
        // Aging protects batch work. Least-served actor wins ties before arrival order.
        candidates.sort((a, b) => {
          const score = (w: Waiter) => (w.context.priority ?? 0) + Math.floor((atMs - w.enqueuedAt) / this.#agingIntervalMs);
          return score(b) - score(a) ||
            (lane.served.get(a.context.actor ?? 'anonymous') ?? 0) - (lane.served.get(b.context.actor ?? 'anonymous') ?? 0) ||
            a.sequence - b.sequence;
        });
        const waiter = candidates[0];
        if (!waiter) break;
        if (waiter.context.deadlineAtMs <= atMs) {
          this.#remove(waiter); waiter.cleanup(); waiter.abandoned = true;
          waiter.reject(new LspAdmissionError('deadline', 'LSP request deadline elapsed in queue'));
          if (waiter.receipt) void this.#settle(waiter, () => waiter.receipt!.cancel('LSP queue deadline elapsed')).catch(() => undefined);
          continue;
        }
        waiter.started = true;
        this.#remove(waiter);
        lane.inFlight++;
        const actor = waiter.context.actor ?? 'anonymous';
        lane.served.set(actor, (lane.served.get(actor) ?? 0) + 1);
        void this.#execute(waiter, lane);
      }
    }
    const nextProbe = this.#controller.snapshot(this.#now()).classes
      .filter(c => c.pauseUntilMs > this.#now() && this.#waiters.some(w => w.classKey === c.admissionClass))
      .map(c => c.pauseUntilMs);
    if (nextProbe.length) {
      this.#probeTimer = setTimeout(() => this.#drain(), Math.min(2_147_483_647, Math.max(1, Math.min(...nextProbe) - this.#now())));
      this.#probeTimer.unref?.();
    }
  }

  async #execute(waiter: Waiter, lane: ClassLane): Promise<void> {
    try {
      await waiter.receipt?.start();
      waiter.context.observe?.({ phase: 'admission-start', atMs: this.#now(), classKey: waiter.classKey });
      if (waiter.abandoned) { await this.#settle(waiter, async () => { await waiter.receipt?.cancel('LSP caller abandoned before execution'); }); return; }
      waiter.serviceStartedAt = this.#now();
      waiter.context.observe?.({ phase: 'service-start', atMs: waiter.serviceStartedAt, classKey: waiter.classKey });
      const result = await waiter.task(waiter.abort.signal);
      const serviceEndedAt = this.#now();
      waiter.context.observe?.({ phase: 'service-end', atMs: serviceEndedAt, classKey: waiter.classKey });
      if (waiter.abandoned) await this.#settle(waiter, async () => { await waiter.receipt?.cancel('LSP caller abandoned during execution'); });
      else {
        await this.#settle(waiter, async () => { await waiter.receipt?.finish(); });
        waiter.resolve(result);
        this.#observeService(waiter, healthyResult(result), serviceEndedAt);
      }
    } catch (error) {
      this.#observeService(waiter, false);
      try { await this.#settle(waiter, async () => { await waiter.receipt?.cancel(`LSP execution failed: ${error instanceof Error ? error.message : String(error)}`); }); }
      catch (settlementError) { if (!waiter.abandoned) waiter.reject(settlementError); }
      if (!waiter.abandoned) waiter.reject(error);
    } finally {
      waiter.cleanup();
      lane.inFlight--;
      // Retain service debt only for agents still contending in this busy period.
      const activeActors = new Set(this.#waiters.filter(w => w.classKey === waiter.classKey).map(w => w.context.actor ?? 'anonymous'));
      if (lane.inFlight === 0) for (const actor of lane.served.keys()) if (!activeActors.has(actor)) lane.served.delete(actor);
      this.#drain();
    }
  }
}

export type LspAdmissionSnapshot = ReturnType<LspAdmissionController['snapshot']>;

async function persistWaiter(context: LspAdmissionContext, classKey: string): Promise<LspAdmissionReceipt> {
  const { governedExecutionRuntime, beginGovernedExecution } = await import('../resource-governor/execution');
  const deps = governedExecutionRuntime(context.workspaceId, 'lsp-query');
  const request = {
    idempotencyKey: `lsp:${createHash('sha256').update(JSON.stringify([context.workspaceId, context.requestId])).digest('hex')}`,
    admissionClass: classKey, priority: context.priority, deadlineAtMs: context.deadlineAtMs,
    metadata: { actor: context.actor ?? 'anonymous', language: context.language, projectRoot: context.projectRoot, op: context.op },
    payloadRef: context.queryKey,
  };
  const outcome = await deps.governor.admit(request);
  if (outcome.kind !== 'queued') throw new Error('LSP pressure wait requires a durable queued receipt');
  const receiptId = outcome.receipt.receiptId;
  context.observe?.({ phase: 'durable-enqueued', atMs: Date.now(), classKey, receiptId });
  let execution: Awaited<ReturnType<typeof beginGovernedExecution>> | undefined;
  return {
    async start() {
      execution = await beginGovernedExecution(request, { owner: context.actor ?? 'system:lsp-daemon' }, deps);
      context.observe?.({ phase: 'durable-running', atMs: Date.now(), classKey, receiptId });
    },
    async finish() {
      const confirmed = execution ? await execution.finish() : false;
      context.observe?.({ phase: 'durable-settled', atMs: Date.now(), classKey, receiptId, confirmed });
    },
    async cancel(reason) {
      const confirmed = execution ? await execution.cancel(reason) : (await deps.governor.cancel(request.idempotencyKey, reason)).cancelled;
      context.observe?.({ phase: 'durable-cancelled', atMs: Date.now(), classKey, receiptId, confirmed });
    },
  };
}

const shared = pinModuleState('papercusp.lsp-admission', () => ({ controllers: new Map<string, LspAdmissionController>() }));
export function lspAdmissionController(workspaceId: string): LspAdmissionController {
  let controller = shared.controllers.get(workspaceId);
  if (!controller) { controller = new LspAdmissionController({ enqueue: persistWaiter }); shared.controllers.set(workspaceId, controller); }
  return controller;
}

const INTENTS: Readonly<Record<string, CodeIntelIntent>> = {
  symbol: 'definition', references: 'references', implementations: 'implementations', diagnostics: 'diagnostics',
  workspace_symbols: 'symbol-search', refactor_preview: 'rename-preview', health: 'diagnostics',
};
export async function runLspAdmission(context: LspAdmissionContext, task: (signal: AbortSignal) => Promise<CodeIntelAnswer>): Promise<CodeIntelAnswer> {
  const startedAt = Date.now();
  try { return await lspAdmissionController(context.workspaceId).run(context, task); }
  catch (error) {
    return {
      backend: 'lsp-adapter', intent: INTENTS[context.op] ?? 'diagnostics', query: context.query ?? context.op,
      sites: [], truncation: { truncated: false, totalAvailable: null, continuation: null },
      freshness: { health: 'degraded', indexedAt: null, staleVsDisk: null, indexedCommit: null },
      latencyMs: Date.now() - startedAt,
      error: `LSP admission ${error instanceof LspAdmissionError ? error.code : 'failed'}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
