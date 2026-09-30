/** Scoped typed client for the shared operation contract. The PostgreSQL port
 * is used internally; the projected port reaches the same service through the
 * public `blueprint:*` defineTool surface (P-017). */
import type { Sql } from 'postgres';
import {
  cancelBlueprintOperation,
  getBlueprintOperationEvents,
  getBlueprintOperationResult,
  getBlueprintOperationStatus,
  resumeBlueprintOperation,
  signalBlueprintOperation,
  submitBlueprintOperation,
  type BlueprintOperationHandle,
  type BlueprintOperationInputReceipt,
  type BlueprintOperationResult,
  type BlueprintOperationStatus,
  type SubmitBlueprintOperationInput,
} from './operation-service';
import {
  BLUEPRINT_OPERATION_TOOLS,
  BlueprintOperationCancelReceiptSchema,
  BlueprintOperationEventsPageSchema,
  BlueprintOperationInputReceiptSchema,
  BlueprintOperationResultSchema,
  BlueprintOperationStatusSchema,
  SubmitResultSchema,
} from './operation-contract';

export interface BlueprintOperationPort {
  submit(input: SubmitBlueprintOperationInput): Promise<BlueprintOperationHandle>;
  status(handle: BlueprintOperationHandle, callerId: string): Promise<BlueprintOperationStatus>;
  result(handle: BlueprintOperationHandle, callerId: string): Promise<BlueprintOperationResult>;
  events(handle: BlueprintOperationHandle, callerId: string, options?: { cursor?: string; limit?: number }):
    ReturnType<typeof getBlueprintOperationEvents>;
  cancel(handle: BlueprintOperationHandle, callerId: string, input: { requestKey: string; reason: string }):
    Promise<BlueprintOperationInputReceipt & { effected: boolean }>;
  signal(handle: BlueprintOperationHandle, callerId: string,
    input: { channel: string; payload: unknown; requestKey: string }): Promise<BlueprintOperationInputReceipt>;
  resume(handle: BlueprintOperationHandle, callerId: string,
    input: { token: string; response: unknown; requestKey: string }): Promise<BlueprintOperationInputReceipt>;
}

export function createPgBlueprintOperationPort(sql: Sql): BlueprintOperationPort {
  return {
    submit: (input) => submitBlueprintOperation(sql, input),
    status: (handle, callerId) => getBlueprintOperationStatus(sql, handle, callerId),
    result: (handle, callerId) => getBlueprintOperationResult(sql, handle, callerId),
    events: (handle, callerId, options) => getBlueprintOperationEvents(sql, handle, callerId, options),
    cancel: (handle, callerId, input) => cancelBlueprintOperation(sql, handle, callerId, input),
    signal: (handle, callerId, input) => signalBlueprintOperation(sql, handle, callerId, input),
    resume: (handle, callerId, input) => resumeBlueprintOperation(sql, handle, callerId, input),
  };
}

/** Invoke one projected tool and return its decoded structured result; a
 * refused call must throw. MCP and /api/agent-tools adapters both satisfy it. */
export type ProjectedToolInvoke = (toolName: string, args: Record<string, unknown>) => Promise<unknown>;

/** The same port over the public `blueprint:*` tools (P-017). Caller identity
 * and workspace come from the transport's authenticated scope, so the port's
 * `callerId` / submission `workspaceId` / `callerId` arguments are not sent:
 * the client's scope check on the returned handle detects a mismatch. Every
 * result is parsed by the shared contract, so transport drift fails loudly. */
export function createProjectedBlueprintOperationPort(invoke: ProjectedToolInvoke): BlueprintOperationPort {
  const call = async <T>(verb: keyof typeof BLUEPRINT_OPERATION_TOOLS, args: Record<string, unknown>,
    schema: { parse(value: unknown): unknown }): Promise<T> =>
    schema.parse(await invoke(BLUEPRINT_OPERATION_TOOLS[verb], args)) as T;
  return {
    submit: async (input) => (await call<{ handle: BlueprintOperationHandle }>('submit', {
      harness: input.harnessSlug, operationId: input.operationId, requestKey: input.requestKey,
      input: input.input,
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.summary === undefined ? {} : { summary: input.summary }),
    }, SubmitResultSchema)).handle,
    status: (handle) => call('status', { handle }, BlueprintOperationStatusSchema),
    result: (handle) => call('result', { handle }, BlueprintOperationResultSchema),
    events: (handle, _callerId, options) => call('events', {
      handle,
      ...(options?.cursor === undefined ? {} : { cursor: options.cursor }),
      ...(options?.limit === undefined ? {} : { limit: options.limit }),
    }, BlueprintOperationEventsPageSchema),
    cancel: (handle, _callerId, input) => call('cancel', { handle, ...input }, BlueprintOperationCancelReceiptSchema),
    signal: (handle, _callerId, input) => call('signal', { handle, ...input }, BlueprintOperationInputReceiptSchema),
    resume: (handle, _callerId, input) => call('resume', { handle, ...input }, BlueprintOperationInputReceiptSchema),
  };
}

export type TypedBlueprintOperationHandle<K extends string> = BlueprintOperationHandle & { operationId: K };
export type TypedBlueprintOperationResult<T> =
  | Exclude<BlueprintOperationResult, { state: 'ready' }>
  | (Extract<BlueprintOperationResult, { state: 'ready' }> & { output: T });

type OperationTypeMap = Record<string, {
  input: Record<string, unknown>;
  output: unknown;
  signals: Record<string, unknown>;
}>;

/** One client instance is bound to a principal and concrete workspace/harness.
 * A caller cannot reuse a handle from another scope through this client. */
export class BlueprintOperationClient<Operations extends OperationTypeMap> {
  constructor(
    private readonly port: BlueprintOperationPort,
    private readonly scope: { workspaceId: string; harnessSlug: string; callerId: string },
  ) {
    if (!scope.workspaceId.trim() || !scope.harnessSlug.trim() || !scope.callerId.trim()) {
      throw new Error('blueprint operation client requires workspace, harness and caller');
    }
  }

  private checkHandle<K extends keyof Operations & string>(handle: TypedBlueprintOperationHandle<K>): void {
    if (handle.workspaceId !== this.scope.workspaceId || handle.harnessSlug !== this.scope.harnessSlug) {
      throw new Error('blueprint operation handle is outside this client scope');
    }
  }

  async submit<K extends keyof Operations & string>(input: {
    operationId: K;
    input: Operations[K]['input'];
    requestKey: string;
    title?: string;
    summary?: string;
  }): Promise<TypedBlueprintOperationHandle<K>> {
    const handle = await this.port.submit({ ...this.scope, ...input });
    if (handle.workspaceId !== this.scope.workspaceId || handle.harnessSlug !== this.scope.harnessSlug ||
        handle.operationId !== input.operationId) {
      throw new Error('blueprint operation port returned a handle outside the requested operation scope');
    }
    return handle as TypedBlueprintOperationHandle<K>;
  }

  status<K extends keyof Operations & string>(handle: TypedBlueprintOperationHandle<K>): Promise<BlueprintOperationStatus> {
    this.checkHandle(handle);
    return this.port.status(handle, this.scope.callerId);
  }

  async result<K extends keyof Operations & string>(
    handle: TypedBlueprintOperationHandle<K>,
  ): Promise<TypedBlueprintOperationResult<Operations[K]['output']>> {
    this.checkHandle(handle);
    return await this.port.result(handle, this.scope.callerId) as TypedBlueprintOperationResult<Operations[K]['output']>;
  }

  events<K extends keyof Operations & string>(
    handle: TypedBlueprintOperationHandle<K>, options?: { cursor?: string; limit?: number },
  ): ReturnType<BlueprintOperationPort['events']> {
    this.checkHandle(handle);
    return this.port.events(handle, this.scope.callerId, options);
  }

  cancel<K extends keyof Operations & string>(
    handle: TypedBlueprintOperationHandle<K>, input: { requestKey: string; reason: string },
  ): ReturnType<BlueprintOperationPort['cancel']> {
    this.checkHandle(handle);
    return this.port.cancel(handle, this.scope.callerId, input);
  }

  signal<K extends keyof Operations & string, Channel extends keyof Operations[K]['signals'] & string>(
    handle: TypedBlueprintOperationHandle<K>,
    input: { channel: Channel; payload: Operations[K]['signals'][Channel]; requestKey: string },
  ): ReturnType<BlueprintOperationPort['signal']> {
    this.checkHandle(handle);
    return this.port.signal(handle, this.scope.callerId, input);
  }

  /** The wait token identifies the declared response schema at runtime; callers
   * cannot infer that schema from an opaque token, so the service validates it. */
  resume<K extends keyof Operations & string>(
    handle: TypedBlueprintOperationHandle<K>, input: { token: string; response: unknown; requestKey: string },
  ): ReturnType<BlueprintOperationPort['resume']> {
    this.checkHandle(handle);
    return this.port.resume(handle, this.scope.callerId, input);
  }
}
