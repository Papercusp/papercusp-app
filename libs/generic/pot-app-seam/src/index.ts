/**
 * @papercusp/pot-app-seam
 *
 * The one typed seam between deterministic app code and the judgment plane.
 * An app bootstraps the pots it needs, submits agent work as DECLARED blueprint
 * operations (the public `blueprint:*` contract), follows each durable handle
 * through status/result/events/cancel, and lets judged output into its own
 * state ONLY through the app's parse gate. The package is framework-agnostic and
 * imports no Papercusp operator internals; the host supplies the adapters.
 *
 * There is deliberately no direct plan-run or work-item enqueue here: an app
 * that needs multi-step agent work declares an operation whose target is a plan
 * template, and the operator owns instantiation, dispatch and settlement.
 */

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export interface PotSpec {
  readonly slug: string;
  readonly title?: string;
  readonly blueprint?: string;
  readonly templateId?: string;
  readonly metadata?: JsonObject;
}

export interface BootstrapPotsInput {
  readonly pots: readonly PotSpec[];
  /** Idempotency marker name in the host store. Defaults to a stable hash. */
  readonly marker?: string;
}

export interface BootstrapPotResult {
  readonly slug: string;
  readonly created: boolean;
  readonly ref?: string;
}

export interface BootstrapPotsResult {
  readonly marker: string;
  readonly fingerprint: string;
  readonly skipped: boolean;
  readonly pots: readonly BootstrapPotResult[];
}

export interface AppExecutionTarget {
  readonly appHarnessSlug: string;
  readonly agentName: string;
}

/**
 * The legacy plan-run request shape. Kept ONLY as the input of
 * {@link operationDraftFromPlanRun}, the migration bridge for an app moving a
 * former plan launch onto a declared operation. The seam cannot launch it.
 */
export interface PlanRunDraft<TInput extends JsonObject = JsonObject> {
  readonly templateSlug: string;
  readonly input: TInput;
  /** Immutable source/event identity retained on the operation input. */
  readonly provenance: JsonObject;
  readonly execution: AppExecutionTarget;
  /** Stable replay key; becomes the operation request key. */
  readonly dedupeKey?: string;
}

export type BlueprintOperationTarget =
  | { readonly kind: 'work-item'; readonly id: string }
  | { readonly kind: 'plan'; readonly runId: number; readonly instanceSlug: string };

/** The durable handle returned by the public `blueprint:submit` contract. */
export interface BlueprintOperationHandle {
  readonly workspaceId: string;
  readonly harnessSlug: string;
  readonly receiptId: number;
  readonly operationId: string;
  readonly specificationRevision: string;
  readonly target: BlueprintOperationTarget;
}

export interface BlueprintOperationStatus {
  readonly handle: BlueprintOperationHandle;
  readonly phase: 'accepted' | 'dispatched' | 'waiting' | 'terminal';
  readonly outcome: 'succeeded' | 'unverified' | 'failed' | 'cancelled' | 'dropped' | null;
  readonly items: readonly { readonly id: string; readonly state: string; readonly assignee: string | null }[];
  readonly planRun: { readonly status: string; readonly outcome: string | null } | null;
  readonly cancellationRequested: boolean;
  readonly wait: { readonly name: string; readonly token: string } | null;
}

export type BlueprintOperationResult<TOutput = unknown> =
  | { readonly state: 'pending'; readonly status: BlueprintOperationStatus }
  | {
      readonly state: 'failed' | 'cancelled' | 'dropped' | 'unavailable';
      readonly status: BlueprintOperationStatus;
      readonly reason: string;
    }
  | {
      readonly state: 'ready';
      readonly status: BlueprintOperationStatus;
      readonly output: TOutput;
      readonly evidenceRef: string;
      readonly acceptanceEvidenceRef?: string;
    };

/**
 * One canonical lifecycle event (`blueprint:events`). `kind` is one of
 * work-item | plan-run | cancel | signal | wait | resume; the remaining fields
 * depend on it. Events are observational: an app decides from `result`, never
 * from an event that merely says a work item reached a state.
 */
export interface BlueprintOperationEvent {
  readonly kind: string;
  readonly cursor: string;
  readonly at: string;
  readonly [field: string]: unknown;
}

export interface BlueprintOperationEventsPage {
  readonly status: BlueprintOperationStatus;
  readonly events: readonly BlueprintOperationEvent[];
  /** Pass back as `cursor` to resume after the last event of this page. */
  readonly cursor: string;
  readonly hasMore: boolean;
}

export interface BlueprintOperationEventsOptions {
  readonly cursor?: string;
  readonly limit?: number;
}

export interface BlueprintOperationCancelInput {
  /** Idempotency key for the cancel itself; a replay returns the same receipt. */
  readonly requestKey: string;
  readonly reason: string;
}

/**
 * A durably accepted cancel. Acceptance is not settlement: `handled` is always
 * false at return and `effected` may still be false — read status/result for
 * the terminal `cancelled` outcome.
 */
export interface BlueprintOperationCancelReceipt {
  readonly eventId: string;
  readonly replayed: boolean;
  readonly accepted: true;
  readonly wakeQueued: boolean;
  readonly handled: false;
  readonly effected: boolean;
}

export interface BlueprintOperationDraft<TInput extends JsonObject = JsonObject> {
  readonly harnessSlug: string;
  readonly operationId: string;
  /** Stable replay identity. Reusing it with different input must be refused by the host. */
  readonly requestKey: string;
  readonly input: TInput;
  readonly title?: string;
  readonly summary?: string;
}

/** The app's own parse gate: the ONLY route by which judged output enters app state. */
export type OperationOutputParser<TOutput> = (output: unknown) => TOutput | Promise<TOutput>;

export interface IngestEvent {
  readonly id: string;
  readonly payload: unknown;
}

export interface IngestCursor {
  readonly eventId: string;
}

export interface IngestSubscription {
  /** Resolves when the source drains or rejects if the loop fails without an onError handler. */
  readonly done: Promise<void>;
  stop(): Promise<void> | void;
}

export interface StartIngestLoopInput<TParsed> {
  readonly source: AsyncIterable<IngestEvent>;
  readonly parse: (event: IngestEvent) => Promise<TParsed> | TParsed;
  readonly store: (parsed: TParsed, cursor: IngestCursor) => Promise<void> | void;
  readonly onError?: (error: unknown, event: IngestEvent) => Promise<void> | void;
  readonly signal?: AbortSignal;
}

/** Host adapters for the public `blueprint:*` operation lifecycle. */
export interface BlueprintOperationHost {
  /** blueprint:submit — same request key + same input replays one handle. */
  submitBlueprintOperation(
    draft: BlueprintOperationDraft,
  ): Promise<BlueprintOperationHandle> | BlueprintOperationHandle;
  /** blueprint:status */
  readBlueprintOperationStatus(
    handle: BlueprintOperationHandle,
  ): Promise<BlueprintOperationStatus> | BlueprintOperationStatus;
  /** blueprint:result — only state=ready may carry output. */
  readBlueprintOperationResult(
    handle: BlueprintOperationHandle,
  ): Promise<BlueprintOperationResult> | BlueprintOperationResult;
  /** blueprint:events */
  readBlueprintOperationEvents(
    handle: BlueprintOperationHandle,
    options: BlueprintOperationEventsOptions,
  ): Promise<BlueprintOperationEventsPage> | BlueprintOperationEventsPage;
  /** blueprint:cancel */
  cancelBlueprintOperation(
    handle: BlueprintOperationHandle,
    input: BlueprintOperationCancelInput,
  ): Promise<BlueprintOperationCancelReceipt> | BlueprintOperationCancelReceipt;
}

export interface PotAppSeamHost extends BlueprintOperationHost {
  readBootstrapMarker(marker: string): Promise<string | null> | string | null;
  writeBootstrapMarker(marker: string, fingerprint: string): Promise<void> | void;
  ensurePot(spec: PotSpec): Promise<BootstrapPotResult> | BootstrapPotResult;
}

export interface PotAppSeam {
  bootstrapPots(input: BootstrapPotsInput): Promise<BootstrapPotsResult>;
  submitOperations(
    operations: readonly BlueprintOperationDraft[],
  ): Promise<readonly BlueprintOperationHandle[]>;
  operationStatus(handle: BlueprintOperationHandle): Promise<BlueprintOperationStatus>;
  /**
   * Read the result. A `ready` output is returned ONLY after it passes `parse`
   * (the app's existing parse gate); a parse failure throws and nothing of the
   * unparsed output reaches the caller.
   */
  operationResult<TOutput>(
    handle: BlueprintOperationHandle,
    parse: OperationOutputParser<TOutput>,
  ): Promise<BlueprintOperationResult<TOutput>>;
  operationEvents(
    handle: BlueprintOperationHandle,
    options?: BlueprintOperationEventsOptions,
  ): Promise<BlueprintOperationEventsPage>;
  cancelOperation(
    handle: BlueprintOperationHandle,
    input: BlueprintOperationCancelInput,
  ): Promise<BlueprintOperationCancelReceipt>;
  startIngestLoop<TParsed>(input: StartIngestLoopInput<TParsed>): IngestSubscription;
}

/** The public tool names the operator projects for the operation lifecycle. */
export const BLUEPRINT_OPERATION_TOOL_NAMES = {
  submit: 'blueprint:submit',
  status: 'blueprint:status',
  result: 'blueprint:result',
  events: 'blueprint:events',
  cancel: 'blueprint:cancel',
  signal: 'blueprint:signal',
  resume: 'blueprint:resume',
} as const;

/** The operator's request-key bound (`blueprint:submit` / `blueprint:cancel`). */
export const MAX_REQUEST_KEY_LENGTH = 200;

/** Raised when a ready output fails the app's parse gate. */
export class OperationOutputRejectedError extends Error {
  constructor(
    readonly handle: BlueprintOperationHandle,
    readonly parseError: unknown,
  ) {
    super(
      `blueprint operation ${handle.harnessSlug}#${handle.operationId} (receipt ${handle.receiptId}) ` +
        `output rejected by the app parse gate: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
    );
    this.name = 'OperationOutputRejectedError';
  }
}

function assertNonEmpty(value: string, label: string): void {
  if (value.trim().length === 0) throw new Error(`${label} must be non-empty`);
}

function stableJson(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableJson(v)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`;
}

function fingerprintPots(pots: readonly PotSpec[]): string {
  const normalized = pots
    .map((h) => ({
      slug: h.slug,
      title: h.title ?? '',
      blueprint: h.blueprint ?? '',
      templateId: h.templateId ?? '',
      metadata: h.metadata ?? {},
    }))
    .sort((a, b) => a.slug.localeCompare(b.slug));
  return stableJson(normalized);
}

function defaultMarker(pots: readonly PotSpec[]): string {
  return `pot-app-seam:${pots.map((h) => h.slug).sort().join('+')}`;
}

function sameOperationHandle(left: BlueprintOperationHandle, right: BlueprintOperationHandle): boolean {
  return left.workspaceId === right.workspaceId &&
    left.harnessSlug === right.harnessSlug &&
    left.receiptId === right.receiptId &&
    left.operationId === right.operationId &&
    left.specificationRevision === right.specificationRevision &&
    stableJson(left.target as unknown as JsonValue) === stableJson(right.target as unknown as JsonValue);
}

/**
 * Derive a request key from the DOMAIN identity of the thing the operation acts
 * on (e.g. mailbox + thread, calendar + event instance) — never from a clock or
 * a random id, so a re-delivered trigger or a double click replays the same
 * durable operation instead of creating a second one. Parts are
 * percent-encoded, so a `:` inside a part cannot collide with the separator.
 */
export function deriveRequestKey(operationId: string, ...domainParts: readonly string[]): string {
  assertNonEmpty(operationId, 'operationId');
  if (domainParts.length === 0) throw new Error('deriveRequestKey requires at least one domain part');
  domainParts.forEach((part, i) => assertNonEmpty(part, `domain part ${i}`));
  const key = [operationId, ...domainParts].map((part) => encodeURIComponent(part)).join(':');
  if (key.length > MAX_REQUEST_KEY_LENGTH) {
    throw new Error(`request key is ${key.length} chars; the operator bound is ${MAX_REQUEST_KEY_LENGTH}`);
  }
  return key;
}

/**
 * Migration bridge for an app moving one former plan launch onto a declared
 * operation. The operation must target the same plan template; the template
 * remains the owner of its DAG and execution contract.
 */
export function operationDraftFromPlanRun<TInput extends JsonObject>(
  draft: PlanRunDraft<TInput>,
  operationId: string,
): BlueprintOperationDraft<JsonObject> {
  assertNonEmpty(operationId, 'operationId');
  if (!draft.dedupeKey?.trim()) {
    throw new Error('legacy plan run migration requires dedupeKey so replay identity is preserved');
  }
  if (Object.prototype.hasOwnProperty.call(draft.input, 'provenance')) {
    throw new Error('legacy plan input uses reserved provenance field');
  }
  return {
    harnessSlug: draft.execution.appHarnessSlug,
    operationId,
    requestKey: draft.dedupeKey,
    input: { ...draft.input, provenance: draft.provenance },
  };
}

/** Calls one public tool by name. Must THROW on a refusal (an MCP isError / non-200). */
export type BlueprintToolInvoke = (toolName: string, args: Record<string, unknown>) => Promise<unknown>;

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${what} returned a non-object result`);
  }
  return value as Record<string, unknown>;
}

function requireFields(value: unknown, what: string, fields: readonly string[]): Record<string, unknown> {
  const record = asRecord(value, what);
  const missing = fields.filter((f) => !(f in record));
  if (missing.length > 0) throw new Error(`${what} result is missing ${missing.join(', ')}`);
  return record;
}

/**
 * Host adapter over any transport that can call the projected public tools
 * (MCP JSON-RPC, the HTTP agent-tools route, an in-process dispatcher). It
 * performs shape checks only; contract enforcement stays in the operator.
 */
export function blueprintOperationHostFromInvoker(invoke: BlueprintToolInvoke): BlueprintOperationHost {
  const T = BLUEPRINT_OPERATION_TOOL_NAMES;
  const statusFields = ['handle', 'phase', 'outcome', 'items', 'planRun', 'cancellationRequested', 'wait'];
  return {
    async submitBlueprintOperation(draft) {
      const out = requireFields(await invoke(T.submit, {
        harness: draft.harnessSlug,
        operationId: draft.operationId,
        requestKey: draft.requestKey,
        input: draft.input,
        ...(draft.title === undefined ? {} : { title: draft.title }),
        ...(draft.summary === undefined ? {} : { summary: draft.summary }),
      }), T.submit, ['handle']);
      return requireFields(out.handle, T.submit, ['workspaceId', 'harnessSlug', 'receiptId', 'operationId',
        'specificationRevision', 'target']) as unknown as BlueprintOperationHandle;
    },
    async readBlueprintOperationStatus(handle) {
      return requireFields(await invoke(T.status, { handle }), T.status, statusFields) as unknown as
        BlueprintOperationStatus;
    },
    async readBlueprintOperationResult(handle) {
      return requireFields(await invoke(T.result, { handle }), T.result, ['state', 'status']) as unknown as
        BlueprintOperationResult;
    },
    async readBlueprintOperationEvents(handle, options) {
      return requireFields(await invoke(T.events, {
        handle,
        ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
        ...(options.limit === undefined ? {} : { limit: options.limit }),
      }), T.events, ['status', 'events', 'cursor', 'hasMore']) as unknown as BlueprintOperationEventsPage;
    },
    async cancelBlueprintOperation(handle, input) {
      return requireFields(await invoke(T.cancel, { handle, requestKey: input.requestKey, reason: input.reason }),
        T.cancel, ['eventId', 'replayed', 'accepted', 'wakeQueued', 'handled', 'effected']) as unknown as
        BlueprintOperationCancelReceipt;
    },
  };
}

export function createPotAppSeam(host: PotAppSeamHost): PotAppSeam {
  const checkHandle = (returned: BlueprintOperationHandle, asked: BlueprintOperationHandle, what: string) => {
    if (!sameOperationHandle(returned, asked)) {
      throw new Error(`blueprint operation ${what} returned a different durable handle`);
    }
  };
  return {
    async bootstrapPots(input) {
      if (input.pots.length === 0) throw new Error('bootstrapPots requires at least one pot');
      for (const pot of input.pots) assertNonEmpty(pot.slug, 'pot.slug');

      const fingerprint = fingerprintPots(input.pots);
      const marker = input.marker ?? defaultMarker(input.pots);
      const existing = await host.readBootstrapMarker(marker);
      if (existing === fingerprint) {
        return { marker, fingerprint, skipped: true, pots: [] };
      }

      const pots: BootstrapPotResult[] = [];
      for (const pot of input.pots) pots.push(await host.ensurePot(pot));
      await host.writeBootstrapMarker(marker, fingerprint);
      return { marker, fingerprint, skipped: false, pots };
    },

    async submitOperations(operations) {
      const out: BlueprintOperationHandle[] = [];
      for (const operation of operations) {
        assertNonEmpty(operation.harnessSlug, 'operation.harnessSlug');
        assertNonEmpty(operation.operationId, 'operation.operationId');
        assertNonEmpty(operation.requestKey, 'operation.requestKey');
        if (operation.requestKey.length > MAX_REQUEST_KEY_LENGTH) {
          throw new Error(`operation.requestKey exceeds ${MAX_REQUEST_KEY_LENGTH} chars`);
        }
        const handle = await host.submitBlueprintOperation(operation);
        if (handle.harnessSlug !== operation.harnessSlug || handle.operationId !== operation.operationId) {
          throw new Error(
            `operation handle ${handle.harnessSlug}#${handle.operationId} does not match ` +
              `${operation.harnessSlug}#${operation.operationId}`,
          );
        }
        out.push(handle);
      }
      return out;
    },

    async operationStatus(handle) {
      const status = await host.readBlueprintOperationStatus(handle);
      checkHandle(status.handle, handle, 'status');
      return status;
    },

    async operationResult<TOutput>(handle: BlueprintOperationHandle, parse: OperationOutputParser<TOutput>) {
      if (typeof parse !== 'function') throw new Error('operationResult requires the app parse gate');
      const result = await host.readBlueprintOperationResult(handle);
      checkHandle(result.status.handle, handle, 'result');
      if (result.state !== 'ready') {
        if (Object.prototype.hasOwnProperty.call(result, 'output')) {
          throw new Error(`blueprint operation ${result.state} result must not carry output`);
        }
        return result;
      }
      let output: TOutput;
      try {
        output = await parse(result.output);
      } catch (error) {
        throw new OperationOutputRejectedError(handle, error);
      }
      return { ...result, output };
    },

    async operationEvents(handle, options = {}) {
      if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100)) {
        throw new Error('operationEvents limit must be an integer 1..100');
      }
      const page = await host.readBlueprintOperationEvents(handle, options);
      checkHandle(page.status.handle, handle, 'events');
      return page;
    },

    async cancelOperation(handle, input) {
      assertNonEmpty(input.requestKey, 'cancel.requestKey');
      assertNonEmpty(input.reason, 'cancel.reason');
      if (input.requestKey.length > MAX_REQUEST_KEY_LENGTH) {
        throw new Error(`cancel.requestKey exceeds ${MAX_REQUEST_KEY_LENGTH} chars`);
      }
      const receipt = await host.cancelBlueprintOperation(handle, input);
      if (receipt.accepted !== true) throw new Error('blueprint operation cancel was not accepted');
      return receipt;
    },

    startIngestLoop(input) {
      let stopped = false;
      const stop = () => {
        stopped = true;
      };
      const run = async () => {
        for await (const event of input.source) {
          if (stopped || input.signal?.aborted) break;
          try {
            const parsed = await input.parse(event);
            await input.store(parsed, { eventId: event.id });
          } catch (error) {
            if (input.onError) await input.onError(error, event);
            else throw error;
          }
        }
      };
      const running = run();
      return {
        done: running,
        async stop() {
          stop();
          await running.catch(() => {});
        },
      };
    },
  };
}

export function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
