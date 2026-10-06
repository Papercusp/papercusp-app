/**
 * code-execution-tool-orchestration B-CX-2A — the orchestration COMPOSITION.
 *
 * Ties the B-CX-1A pieces together into the one call the `code:run` agent tool makes:
 *   1. PARSE-CHECK the script against the allowed tool set (fast-fail on disallowed refs).
 *   2. Build the facade over `realDispatch(ctx, deps)` — the REAL dispatcher pipeline —
 *      wrapped by the DRY-RUN/CONFIRM gate: in dryRun, `effect:'write'` calls (the B-CX-PRE
 *      marker) are RECORDED, not executed, so an agent/operator can preview every mutation
 *      before committing; reads run normally. Non-dryRun runs everything.
 *   3. Run the script (node:vm), returning ONLY its summary.
 *
 * Lives in tooldef (not operator-core) so it's e2e-testable against the real dispatcher with
 * fixture tools + a fixture ctx; the `code:run` defineTool is a thin wrapper over this.
 *
 * Known MVP gap (documented): inner calls enforce the dispatcher's role + capability gates (from
 * ctx) but not the host capability-ENVELOPE port unless the caller threads it via `deps`. The
 * facade whitelist (`allowed`) + the dryRun gate are the layers present; threading the host
 * envelope port into `deps` is a hardening follow-up.
 */
import type { ProjectedTool, UnifiedToolContext } from '../tool-projection';
import type { DispatchProjectedDeps } from '../dispatch-types';
import { buildToolFacade, type FacadeDispatch } from './tool-facade';
import { realDispatch, isPreExecutionFailure, ToolDispatchError } from './dispatch-binding';
import {
  DEFAULT_TIMEOUT_SETTLEMENT_GRACE_MS,
  runOrchestrationScript,
  type FieldMiss,
  type OrchestrationInputs,
  type SleepCap,
} from './run-script';
import { checkScript, ensureParseCheckReady, type StaticToolCall } from './parse-check';

/**
 * Per-inner-call context-rebinding hook (WI-1411). By default every call the
 * script makes reuses the SAME fixed `ctx` passed to `runToolOrchestration` —
 * fine for an ordinary concrete-workspace caller (its ctx is already bound
 * correctly for the whole batch) but WRONG for a caller whose effective
 * per-call binding can differ from call to call (e.g. an unscoped superuser
 * passing a per-call `{ workspace: 'X' }` arg — the EI-30 "hop without
 * re-auth" convention a direct MCP dispatch honors via
 * `effectiveDispatchWorkspace`/`withWorkspace`/ALS, but which a single fixed
 * `ctx` can never express). `next(callCtx)` performs the actual dispatch with
 * whatever context the wrapper decides is correct for THIS call.
 */
export type DispatchNext = (callCtx: UnifiedToolContext, callArgs?: unknown) => Promise<unknown>;
export type WrapDispatch = (
  tool: ProjectedTool,
  toolName: string,
  args: unknown,
  ctx: UnifiedToolContext,
  next: DispatchNext,
) => Promise<unknown>;

export interface OrchestrateOptions {
  ctx: UnifiedToolContext;
  deps: DispatchProjectedDeps;
  /** Candidate tools (typically the full projected registry). */
  tools: readonly ProjectedTool[];
  /** Optional whitelist (full MCP names) — the agent's envelope. Absent ⇒ all `tools`. */
  allowed?: ReadonlySet<string>;
  /** When true, `effect:'write'` calls are recorded, not executed. Default false. */
  dryRun?: boolean;
  /** Wall-clock budget. Default = run-script's 30s. */
  timeoutMs?: number;
  /** Bounded grace for host dispatches to settle after the script wall-clock budget expires. */
  timeoutGraceMs?: number;
  /**
   * Optional per-call context-rebinding hook (WI-1411) — see `WrapDispatch`.
   * Absent ⇒ every call in the batch dispatches under the fixed `ctx`
   * (pre-WI-1411 behavior), which stays correct for any caller whose binding
   * doesn't vary per call.
   */
  wrapDispatch?: WrapDispatch;
  /** Optional JSON-only runtime inputs, exposed inside the VM as deeply frozen `inputs`. */
  inputs?: OrchestrationInputs;
  /**
   * Server-computed SHA-256 of the complete outer `code:run` argument object.
   * When present, a settled-read proof is returned only after the runtime
   * evidence passes every fail-closed check. The generic runtime never hashes
   * or accepts a proof supplied by the script.
   */
  requestHash?: string;
}

/**
 * Derive the idempotency key for one nested dispatch in a keyed code:run.
 *
 * The transport key identifies the whole orchestration request, but forwarding
 * it unchanged to every child makes child-level idempotency consumers (for
 * example coord:send) treat distinct writes as retries of the same write. The
 * dispatch ordinal is allocated synchronously before the first await, so it is
 * unique within a run and stable when the same keyed run is retried.
 */
function nestedIdempotencyKey(ctx: UnifiedToolContext, ordinal: number): string | undefined {
  const outer = ctx.idempotencyKey?.trim();
  return outer ? `code-run:nested:${outer}:${ordinal}` : undefined;
}

export interface PlannedMutation {
  tool: string;
  args: unknown;
}

export type WriteAttemptDisposition =
  | 'in_flight'
  | 'settled'
  /** The write-class tool ran in its own preview/dry-run mode and did not apply state. */
  | 'preview'
  | 'semantic_rejected'
  | 'rejected'
  | 'uncertain';

/**
 * Runtime disposition of one committing write call. Unlike `plannedMutations` (which records
 * only that dispatch started), this remains honest when the vm times out while a host-side tool
 * promise is still pending. `index` is the zero-based dispatch order, so a sequential caller can
 * resume from an exact prefix without echoing sensitive/full call args into the result.
 */
export interface WriteAttempt {
  index: number;
  tool: string;
  disposition: WriteAttemptDisposition;
}

/**
 * A validated durable-output identity observed on an inner result. The preview
 * and owner fields from the model-facing reference envelope are deliberately
 * absent: a trace needs identity/integrity, not another copy of potentially
 * sensitive display text or an invocation-ephemeral owner id.
 */
export interface OrchestrationOutputReference {
  uri: string;
  byteCount: number;
  sha256: string;
  expiresAt?: string;
  audience?: 'owner' | 'workspace' | 'public';
}

export type OrchestrationCallDisposition =
  | 'planned'
  | 'in_flight'
  | 'settled'
  /** The write-class tool ran in its own preview/dry-run mode and did not apply state. */
  | 'preview'
  | 'semantic_rejected'
  | 'rejected'
  | 'uncertain';

/**
 * Secret-free runtime evidence for one inner call. Arguments and results never
 * enter this record. The operator-side P-013 normalizer combines these records
 * with checkScript's static argument view before anything is persisted.
 */
export interface OrchestrationCallRecord {
  ordinal: number;
  tool: string;
  effect: 'read' | 'write' | 'unknown';
  disposition: OrchestrationCallDisposition;
  outputReferences: OrchestrationOutputReference[];
}

/**
 * Secret-free correlation for a host dispatch that did not settle during the timeout grace
 * window. The dispatch stack's callId is the same value sent to the host's start and telemetry
 * hooks, so a caller can inspect or reconcile exactly this call without guessing from tool name
 * or session identity. This is intentionally separate from callRecords: settled/rejected call
 * records keep their existing shape, while only genuinely detached calls need a callId.
 */
export interface DetachedOrchestrationCall {
  callId: string;
  tool: string;
  effect: OrchestrationCallRecord['effect'];
  ordinal: number;
  disposition: OrchestrationCallDisposition;
}

/**
 * Runtime-owned safety evidence for one orchestration run. This is deliberately
 * outside the script-authored summary: a script cannot prove its own authority
 * invariants by returning `authorityUnchanged: true`.
 *
 * The server runtime cannot observe prompts injected into a native client while
 * this call is in flight. Reporting that boundary explicitly is safer than
 * manufacturing an `unchanged` verdict from the absence of a server signal.
 */
export interface OrchestrationRuntimeObservations {
  authorizationObservationCount: number;
  authorityWideningDetected: boolean;
  midTurnPromptInjectionObservability: 'not-observable';
}

/** A statically ordered write that the script never reached after an earlier throw. */
export interface NotDispatchedWrite {
  tool: string;
  /** Explicitly false: this write never crossed the dispatcher boundary. */
  executed: false;
}

/**
 * A write-effect call whose result reported `ok: false` WITHOUT throwing (EI-7669) — the
 * dispatch itself succeeded (realDispatch only throws on a dispatch-level failure), but the
 * tool's own business-logic result carries a semantic rejection (e.g. work_items:set_state's
 * completion-integrity check). A script that doesn't inspect every result (the common case —
 * `Promise.allSettled` counts a resolved-but-ok:false call the same as a real success) would
 * otherwise silently treat this as an executed mutation. Empty in dryRun (nothing executed).
 */
export interface FailedMutation {
  tool: string;
  args: unknown;
  result: unknown;
}

/** EI-10951: a write-effect call that THREW — recorded with why, so the caller can tell a
 *  provably-never-landed rejection from an honestly-uncertain one. */
export interface ThrownMutation {
  tool: string;
  args: unknown;
  error: string;
}

/** A child call that failed semantically or threw, regardless of read/write effect. */
export interface ChildFailure {
  tool: string;
  kind: 'semantic' | 'rejected' | 'uncertain';
  result?: unknown;
  error?: string;
}

/**
 * P-027: media a script explicitly elects to return to the model. This is deliberately
 * narrower than an arbitrary inner ToolResult: only image/audio data blocks are eligible,
 * and they cross the outer transport only when the FINAL script result uses the
 * `{ summary, media }` contract. Intermediate tool results never populate this array.
 */
export type CodeRunMediaContent =
  | { type: 'image'; data: string; mimeType: string; _meta?: Record<string, unknown> }
  | { type: 'audio'; data: string; mimeType: string };

export interface OrchestrateResult {
  ok: boolean;
  /** The script's returned summary (what re-enters the model's context). */
  summary?: unknown;
  /** Validated image/audio blocks from an explicit final `{ summary, media }` result. */
  media?: CodeRunMediaContent[];
  /** Explicit store/load state, suitable for replay as the next invocation's bindings.values. */
  state?: OrchestrationInputs;
  logs: string[];
  error?: string;
  /** Set when the parse-check failed. */
  unknownRefs?: string[];
  dryRun: boolean;
  /** P-012 (census double-count): how many times the script actually ENTERED the host
   *  dispatcher — reads and writes alike, throwing calls included, dryRun-skipped writes
   *  and unknown-ref stub rejections excluded. Equals the number of inner
   *  tool_invocations rows this run produced, which is what a wrapper tool needs to
   *  mark its own row as a dispatch wrapper only when inner rows actually exist.
   *  Optional so pre-existing hand-built fixture results are unaffected;
   *  runToolOrchestration's own return always populates it. */
  dispatchCount?: number;
  /** Exact UTF-8 bytes of every child result that settled and entered the script
   *  runtime. Thrown dispatches have no result body and therefore add zero. */
  intermediateBytes?: number;
  /** On a script timeout, bounded values from read-only children that settled before
   *  the host returned. These recover results an awaited sibling (for example one
   *  slow branch of Promise.all) would otherwise hide when the worker is terminated. */
  timeoutSettledReadRecovery?: TimeoutSettledReadRecovery;
  /** Independent runtime evidence; never derived from the script's return value. */
  runtimeObservations: OrchestrationRuntimeObservations;
  /** Write-effect calls the script made (recorded in dryRun, observed otherwise).
   *  NOTE: recorded at DISPATCH time, so this includes calls that then threw — subtract
   *  `rejectedMutations` + `uncertainMutations` for the set that actually landed. */
  plannedMutations: PlannedMutation[];
  /** Runtime disposition for every non-dry-run write dispatch, in dispatch order. A timeout may
   * return entries as `in_flight`; those are UNKNOWN, not landed, until the caller verifies them. */
  writeAttempts?: WriteAttempt[];
  /** EI-10951: write-effect calls the dispatcher REJECTED before the handler ran (bad args,
   *  a denied gate). These provably wrote NOTHING — safe to fix and re-run. */
  rejectedMutations?: ThrownMutation[];
  /** EI-10951: write-effect calls that threw for some OTHER reason (a handler error, a
   *  timeout mid-flight). These MAY have partially landed — the honestly-uncertain set, and
   *  the only one that still warrants a "verify before you re-run" warning. */
  uncertainMutations?: ThrownMutation[];
  /** Write-effect calls that resolved with a top-level `ok: false` result (EI-7669). Always
   *  empty (or absent, on a hand-built fixture result predating this field) under dryRun
   *  (nothing executed yet) — runToolOrchestration's own return always populates it. Optional
   *  so pre-existing test fixtures constructing an OrchestrateResult literal don't all need
   *  updating; shapeMutationEcho defaults a missing value to `[]`. */
  okFalseMutations?: FailedMutation[];
  /** Every failed child call, including reads. This is the aggregate truth surface used by
   * wrappers/telemetry; mutation-specific arrays above remain the recovery/safety surface. */
  childFailures?: ChildFailure[];
  /**
   * EI-7784: true when `okFalseMutations` is non-empty — the script itself ran to completion
   * (`ok` stays whatever `run.ok` says: did the SCRIPT throw/timeout), but at least one
   * write-effect call silently rejected without throwing. `ok` alone cannot carry this (it is
   * ALREADY a meaningful, independent signal — "did the script itself complete" — that several
   * existing callers branch on, e.g. `code:run`'s own recipe-capture gate and `recipes:run`'s
   * per-item `ok`), so this is a SEPARATE flag rather than overloading `ok`'s existing meaning.
   * A caller that checks only `ok` (not this flag) is exactly the gap that let three real
   * incidents (EI-7763, EI-7778, WI-3042's assignee:null drop) look like clean successes. Optional
   * (defaults absent/false-ish) so pre-existing hand-built fixture results are unaffected;
   * runToolOrchestration's own return always populates it. */
  partial?: boolean;
  /**
   * P-020: write-effect tools the script ORDERED but that never dispatched at all, because
   * an earlier throw unwound the vm before reaching them. Present only on a failed run, and
   * only when non-empty. Distinct from every other mutation array here: those are recorded
   * at dispatch, so a call that never dispatched appears in NONE of them — this is the only
   * surface that can tell an author their trailing `work_items:checkpoint` never happened.
   * Provable set only (see `detectStrandedWrites`): a tool that ran at least once is omitted.
   */
  strandedWrites?: string[];
  /**
   * P-020 compatibility companion to `strandedWrites`. The legacy string list is useful for
   * concise human output but does not carry a disposition in its shape. This field makes the
   * recovery fact machine-readable: every listed write has `executed:false` because it never
   * dispatched at all. It is present only when `strandedWrites` is present.
   */
  notDispatchedWrites?: NotDispatchedWrite[];
  /**
   * EI-19301148486657755: reads of fields that do not exist on a tool result — the author asked
   * for `count` on a result whose key is `claimableCount`. Present only when non-empty.
   *
   * This is the FIELD-name counterpart of `unknownRefs` (wrong TOOL name). Both exist for the same
   * reason: the protection has to fire without the agent having predicted the mistake, because the
   * failure is silent — `undefined` reads as a legitimate absence, and the `?? null` fallbacks that
   * keep summaries bounded then launder it into a confident value.
   */
  fieldMisses?: FieldMiss[];
  /**
   * EI-19324793244855883: `sleep(ms)` calls the script made that asked for longer than the
   * sandbox's cap and were silently clamped. Present only when non-empty — see {@link SleepCap}.
   */
  sleepCaps?: SleepCap[];
  /**
   * Internal P-013 capture evidence. code:run and recipes:run remove this field
   * from their model-facing payloads after persisting the normalized trace.
   */
  callRecords?: OrchestrationCallRecord[];
  /** Host dispatches still unresolved after the bounded timeout settlement grace. */
  detachedCalls?: DetachedOrchestrationCall[];
  /** Internal server-owned evidence; code:run carries it in MCP `_meta` and strips it from text. */
  replayProof?: CodeRunSettledReadReplayProof;
}

/** Hard limits on read bodies returned as recovery data after a script timeout. */
export const TIMEOUT_SETTLED_READ_RECOVERY_MAX_BYTES = 24 * 1024;
export const TIMEOUT_SETTLED_READ_RECOVERY_MAX_CALLS = 20;

export interface TimeoutSettledReadRecovery {
  /** Settled read-only children, in original dispatch order. */
  calls: Array<{ ordinal: number; tool: string; result: unknown }>;
  /** All successful read-only child results observed before the outer handler returned. */
  totalSettledReadCount: number;
  /** Settled read results omitted because a body was not JSON-serializable or a cap was reached. */
  omittedReadCount: number;
  /** UTF-8 bytes in the included serialized result bodies. */
  includedBytes: number;
  maxBytes: number;
  maxCalls: number;
}

/**
 * Runtime-owned evidence that one completed code:run made only settled reads.
 *
 * This is deliberately a small, transport-safe proof rather than a copy of
 * callRecords. It contains no arguments, results, output previews, or caller
 * identity. A consumer may use it only after checking that the request body it
 * is about to retry hashes to `requestHash`.
 */
export const CODE_RUN_REPLAY_PROOF_META_KEY = 'codeRunReplayProof' as const;
export const CODE_RUN_REPLAY_PROOF_SCHEMA_VERSION = 1 as const;

export interface CodeRunSettledReadReplayProof {
  schemaVersion: typeof CODE_RUN_REPLAY_PROOF_SCHEMA_VERSION;
  kind: 'settled-read';
  tool: 'code:run';
  requestHash: string;
  callCount: number;
}

export interface DeriveCodeRunSettledReadReplayProofInput {
  /** SHA-256 of the complete code:run MCP argument object, computed by the server. */
  requestHash: string;
  /** The static parser's calls for this exact script. */
  staticCalls: readonly StaticToolCall[];
  /** Recovered AST syntax errors are not sufficient evidence for a proof. */
  hasParseErrors?: boolean;
  /** Unknown/dynamic facade references are never proofable. */
  unknownRefs?: readonly string[];
  /** Whether the script itself completed. */
  runOk: boolean;
  /** Preview runs are excluded even when their visible calls are reads. */
  dryRun: boolean;
  callRecords?: readonly OrchestrationCallRecord[];
}

/**
 * Derive the only replay proof code:run may expose.
 *
 * The static and runtime lists must have the same cardinality and source order:
 * this intentionally rejects loops, dynamic calls, parse recovery, and any
 * runtime-only call because those shapes cannot establish an exact settled body
 * from the bounded evidence available here. A proof generated after a lost
 * request is impossible by construction: this function runs only on the
 * completed server result and the request hash is supplied by that handler.
 */
export function deriveCodeRunSettledReadReplayProof(
  input: DeriveCodeRunSettledReadReplayProofInput,
): CodeRunSettledReadReplayProof | undefined {
  const requestHash = input.requestHash.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(requestHash)) return undefined;
  if (!input.runOk || input.dryRun || input.hasParseErrors || input.unknownRefs?.length) return undefined;

  const staticCalls = input.staticCalls;
  const runtimeCalls = [...(input.callRecords ?? [])].sort((a, b) => a.ordinal - b.ordinal);
  if (staticCalls.length === 0 || runtimeCalls.length !== staticCalls.length) return undefined;

  for (let index = 0; index < staticCalls.length; index += 1) {
    const staticCall = staticCalls[index];
    const runtimeCall = runtimeCalls[index];
    if (
      staticCall.dynamicArgs ||
      staticCall.tool.length === 0 ||
      runtimeCall.ordinal !== index ||
      runtimeCall.tool !== staticCall.tool ||
      runtimeCall.effect !== 'read' ||
      runtimeCall.disposition !== 'settled'
    ) {
      return undefined;
    }
  }

  return {
    schemaVersion: CODE_RUN_REPLAY_PROOF_SCHEMA_VERSION,
    kind: 'settled-read',
    tool: 'code:run',
    requestHash,
    callCount: runtimeCalls.length,
  };
}

interface ActiveOrchestrationCall {
  callRecord: OrchestrationCallRecord;
  settled: Promise<void>;
  resolveSettled: () => void;
  callId?: string;
}

interface StoredTimeoutSettledRead {
  ordinal: number;
  tool: string;
  serializedResult: string;
  bytes: number;
}

function setContainsAll<T>(superset: ReadonlySet<T> | undefined, subset: ReadonlySet<T> | undefined): boolean {
  if (!subset || subset.size === 0) return true;
  if (!superset) return false;
  for (const value of subset) if (!superset.has(value)) return false;
  return true;
}

/** True only when the actual inner-dispatch context has a grant the outer caller lacked. */
function authorityWidened(
  outer: UnifiedToolContext,
  inner: UnifiedToolContext,
): boolean {
  if (inner.isSuperuser === true && outer.isSuperuser !== true) return true;
  if (inner.role !== outer.role) return true;

  const outerPrincipal = outer.principal;
  const innerPrincipal = inner.principal;
  if (!innerPrincipal) return false;
  if (!outerPrincipal) return true;
  if (innerPrincipal.slug !== outerPrincipal.slug) return true;
  if (!setContainsAll(outerPrincipal.capabilities, innerPrincipal.capabilities)) return true;
  if (!setContainsAll(outerPrincipal.roles, innerPrincipal.roles)) return true;
  return false;
}

/**
 * P-020 (fleet-leadership-continuity-and-actuation-2026-08-01) — name the writes that
 * NEVER RAN, not just the ones that failed.
 *
 * A thrown call aborts the vm script, so every `tools.ns.verb(...)` written AFTER it in
 * source order never dispatches at all. Those calls are invisible to every existing
 * recovery surface — `plannedMutations`/`rejected`/`uncertain` are all recorded AT
 * DISPATCH, and an unreached line never dispatched. So the result could say "1 call was
 * rejected, nothing was written" while silently omitting that the script had also ordered
 * a `work_items:checkpoint` that never happened. The agent reads "nothing written, safe to
 * re-run", fixes the typo'd read... and the continuity write it thought it had made is gone.
 *
 * EI-18717906460509995 already recognised this shape and added ORDERING_HINT — but that is a
 * MITIGATION ("write your durable calls first"), not a report: it tells the author how to
 * avoid the trap next time and still never says which write was stranded THIS time. This is
 * the missing read-side half.
 *
 * Sound by construction — it reports only the provable set. `checkScript` already resolves
 * every statically-visible facade reference to its canonical `ns:verb` (it runs anyway, for
 * `unknownRefs`), so this reuses that parse rather than adding a second, drifting one. A
 * write-effect tool named in the script with ZERO dispatches provably never ran. A tool that
 * dispatched at least once is deliberately NOT reported: inside a loop or a branch it may
 * have run some iterations and not others, and no static count can tell which — claiming
 * otherwise would be the same cry-wolf failure EI-10951 fixed in the warning next door.
 * Dynamic dispatch (`tools.call(someVar)`) is likewise invisible to the static parse and
 * simply not claimed.
 *
 * Source order is preserved so the report reads as the script does.
 *
 * PURE — unit-tested without a vm, PG, or a live dispatcher.
 */
export type ResolvedToolEffect = 'read' | 'write' | 'unknown';

/**
 * Resolve a projected tool's effect for one facade call. A classifier is
 * advisory metadata: malformed output or a thrown classifier must not turn a
 * safe static write into an executable dry-run call.
 */
export function resolveToolEffect(
  tool: Pick<ProjectedTool, 'effect' | 'effectForCall'>,
  args: unknown,
): ResolvedToolEffect {
  const fallback: ResolvedToolEffect =
    tool.effect === 'read' || tool.effect === 'write' ? tool.effect : 'unknown';
  if (typeof tool.effectForCall !== 'function') return fallback;
  try {
    const resolved = tool.effectForCall(args);
    return resolved === 'read' || resolved === 'write' ? resolved : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Resolve the effect of a facade call, including the dynamic target behind
 * `tools:invoke`. The meta-tool is registered as a read because it is a
 * delegator, but a code-run dry-run must gate the write it would delegate.
 *
 * A valid target that is absent from the projected catalog (or whose effect is
 * unknown) is treated as a write. The dispatcher may reject that target later,
 * but executing an unclassifiable delegated call during a dry-run would be an
 * unsafe fail-open. Malformed invoke args cannot reach a target and retain the
 * wrapper's static effect so normal schema validation remains observable.
 */
function resolveFacadeToolEffect(
  tool: Pick<ProjectedTool, 'effect' | 'effectForCall'>,
  toolName: string,
  args: unknown,
  tools: readonly ProjectedTool[],
): ResolvedToolEffect {
  const effect = resolveToolEffect(tool, args);
  if (toolName !== 'tools:invoke' || !isPlainRecord(args) || typeof args.name !== 'string') {
    return effect;
  }

  const nestedName = args.name.trim();
  const nestedTool = tools.find((candidate) => candidate.expose?.mcp?.name === nestedName);
  if (!nestedTool) return 'write';
  return resolveToolEffect(nestedTool, args.args ?? {}) === 'read' ? 'read' : 'write';
}

export function detectStrandedWrites(
  staticCalls: readonly StaticToolCall[],
  tools: readonly ProjectedTool[],
  dispatchedToolNames: readonly string[],
): string[] {
  // `expose.mcp.name` is the canonical projected name — the SAME accessor buildToolFacade and
  // facadeToolNames use, and the one `checkScript` resolves its `calls` against. A ProjectedTool
  // has no top-level `.name`; reading one yields `undefined` for every tool, which silently
  // empties this set and makes the whole detector a no-op that still passes any unit test whose
  // fixture invents the field. (It did exactly that until an end-to-end run caught it.)
  const toolsByName = new Map(
    tools
      .map((tool) => [tool.expose?.mcp?.name, tool] as const)
      .filter((entry): entry is readonly [string, ProjectedTool] => typeof entry[0] === 'string'),
  );
  const dispatched = new Set(dispatchedToolNames);
  const stranded: string[] = [];
  const seen = new Set<string>();
  for (const call of staticCalls) {
    const name = call.tool;
    const tool = toolsByName.get(name);
    if (!tool || resolveToolEffect(tool, call.args) !== 'write') continue; // reads are re-runnable; only writes strand
    if (dispatched.has(name)) continue; // ran at least once — cannot prove anything about the rest
    if (seen.has(name)) continue;
    seen.add(name);
    stranded.push(name);
  }
  return stranded;
}

/** True when `value` is a plain object carrying a top-level `ok: false` — the tool's own
 *  reported semantic failure, as distinct from a dispatch-level throw (already handled by
 *  realDispatch before the result ever reaches here). */
function isOkFalseResult(value: unknown): value is { ok: false; [key: string]: unknown } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'ok' in (value as Record<string, unknown>) &&
    (value as { ok?: unknown }).ok === false
  );
}

/**
 * A read-only `capability:bash` pipeline may deliberately end its producer with SIGPIPE when
 * an early consumer such as `head` has already received enough output. Bash reports that signal
 * as exit code 141, so the command's own `{ ok: false }` remains useful to the script but must not
 * make the otherwise observational orchestration partial. Keep this exact to the dynamically
 * resolved read effect and tool name: ordinary read failures and mutation-class bash calls still
 * need the semantic-failure signal.
 */
function isExpectedReadOnlyBashSigpipe(
  toolName: string,
  effect: ResolvedToolEffect,
  value: unknown,
): boolean {
  return toolName === 'capability:bash' && effect === 'read' && isOkFalseResult(value) && value.exit_code === 141;
}

/**
 * `systemctl status` uses exit code 3 to report that a known unit is inactive or
 * failed. That is the state being queried, not a failure to execute the read-only
 * diagnostic. Keep this exception narrower than the SIGPIPE case: only a
 * read-classified capability:bash call whose command contains a direct systemctl
 * status segment may use exit 3 as data.
 */
function isExpectedReadOnlySystemctlStatus(
  toolName: string,
  effect: ResolvedToolEffect,
  args: unknown,
  value: unknown,
): boolean {
  if (
    toolName !== 'capability:bash' ||
    effect !== 'read' ||
    !isOkFalseResult(value) ||
    value.status !== 'failed' ||
    value.exit_code !== 3 ||
    typeof args !== 'object' ||
    args === null
  ) {
    return false;
  }
  const command = (args as { command?: unknown; cmd?: unknown }).command ?? (args as { cmd?: unknown }).cmd;
  if (typeof command !== 'string') return false;
  return command.split(/\s*(?:&&|\|\||\||;|\n)\s*/).some((segment) =>
    /^(?:timeout\s+\S+\s+)?systemctl(?:\s+--?[A-Za-z0-9][A-Za-z0-9_=-]*)*\s+status(?:\s|$)/.test(segment.trim()),
  );
}

/**
 * `ps --ppid <numeric-pid>` returns exit 1 for a parent with no children. The
 * capability layer normalizes the real command, but keep the orchestration
 * semantic-failure guard aligned for replay/fixture results that still carry
 * the raw empty probe outcome. It is intentionally limited to a read effect,
 * empty output, numeric parent, and an optional simple awk field printer.
 */
function isExpectedReadOnlyPsPpidEmpty(
  toolName: string,
  effect: ResolvedToolEffect,
  args: unknown,
  value: unknown,
): boolean {
  if (
    toolName !== 'capability:bash' ||
    effect !== 'read' ||
    !isOkFalseResult(value) ||
    value.status !== 'failed' ||
    value.exit_code !== 1 ||
    typeof value.output !== 'string' ||
    value.output.trim() !== '' ||
    typeof args !== 'object' ||
    args === null
  ) {
    return false;
  }
  const commandValue = (args as { command?: unknown; cmd?: unknown }).command ?? (args as { cmd?: unknown }).cmd;
  if (typeof commandValue !== 'string' || /[;&<>\n\r]/.test(commandValue) || commandValue.includes('||')) return false;
  const segments = commandValue.split(/\s*\|\s*/);
  if (segments.length < 1 || segments.length > 2) return false;
  const first = segments[0]!.trim();
  const firstTokens = (first.match(/(?:"[^"]*"|'[^']*'|\S+)/g) ?? []).map((token) =>
    token.length >= 2 && ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'")))
      ? token.slice(1, -1)
      : token,
  );
  const commandBase = (token: string): string => token.slice(token.lastIndexOf('/') + 1).toLowerCase();
  if (commandBase(firstTokens[0] ?? '') !== 'ps') return false;
  const ppidIndex = firstTokens.indexOf('--ppid');
  const numericPpid =
    (ppidIndex >= 0 && /^\d+$/.test(firstTokens[ppidIndex + 1] ?? '')) ||
    firstTokens.some((token) => /^--ppid=\d+$/.test(token));
  if (!numericPpid) return false;
  if (segments.length === 1) return true;
  const awk = segments[1]!.trim();
  const field = String.raw`(?:\$\d+|[A-Za-z_][A-Za-z0-9_]*)`;
  return new RegExp(
    String.raw`^(?:\S+\/)?awk\s+['"]?\{\s*print(?:\s+${field}(?:\s*,\s*${field})*)?\s*\}['"]?$`,
  ).test(awk);
}

/**
 * True when `value` is a BULK-shaped envelope (`{ ok: true, results: [...], counts: { failed } }`
 * — the keyed-array bulk contract, `_bulk.ts`'s `runBulk`/`bulkContent`) reporting at least one
 * per-item failure WHILE STILL CLAIMING `ok: true`.
 *
 * HISTORY: that combination used to be the house contract's OWN design — the top-level `ok` was
 * hard-coded `true` ("the batch ran"; `counts.failed` was where per-item truth lived), so
 * `isOkFalseResult` alone could never catch a partial bulk failure (EI-18664105352441219:
 * `plans:add-item` against a non-existent plan returned
 * `{ ok:true, results:[{ ok:false, error:'not_found' }], counts:{ ok:0, failed:1 } }`, and a
 * batched script's own mutation tally read it as a landed write — `code:run` reported
 * `mutations:{ count:1 }` for a write that never happened).
 *
 * ⚠ NO LONGER THE CONTRACT: EI-23737206446729041 made `runBulk` DERIVE the envelope's `ok` from
 * its items (`ok: failed === 0`), so a runBulk producer can no longer emit `ok:true` alongside
 * `failed > 0` — and a partial bulk failure is now caught by the `isOkFalseResult` branch of the
 * call site below, which is what preserves the EI-18664105352441219 guarantee.
 *
 * This predicate therefore no longer fires for house bulk tools, and is DELIBERATELY RETAINED as
 * defense in depth: the orchestrator sees whatever a tool actually returns, including a
 * hand-rolled or non-`runBulk` envelope, and this is the only thing that still catches the shape
 * if one reappears. Defense behind the contract, not a restatement of it — do not "simplify" it
 * away on the grounds that it is unreachable, and do not read it as evidence that a bulk
 * envelope's `ok` is still hard-coded.
 */
function isBulkPartialFailure(
  value: unknown,
): value is { ok: true; results: Array<{ ok: boolean; [k: string]: unknown }>; counts: { failed: number } } {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.ok !== true || !Array.isArray(v.results)) return false;
  const counts = v.counts;
  if (typeof counts !== 'object' || counts === null) return false;
  const failed = (counts as Record<string, unknown>).failed;
  return typeof failed === 'number' && failed > 0;
}

/**
 * A write-class tool can be dispatched by a non-dry-run orchestration while asking the tool
 * itself for a preview (for example a rubrics amend with dryRun:true or a work-items complete
 * preflight with validateOnly:true). The outer orchestration dry-run gate cannot see that intent:
 * it only knows the tool's registry effect. Keep the check deliberately top-level and exact, and
 * accept returned markers as a compatibility fallback for tools that normalize the flag.
 */
function isChildPreview(args: unknown, result: unknown): boolean {
  const hasPreviewMarker = (value: unknown): boolean => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    // work_items:complete accepts validateOnly but returns validationOnly.
    return record.dryRun === true || record.validateOnly === true || record.validationOnly === true;
  };
  return hasPreviewMarker(args) || hasPreviewMarker(result);
}

const OUTPUT_REFERENCE_SHA_RE = /^[0-9a-f]{64}$/i;
const OUTPUT_REFERENCE_AUDIENCES = new Set(['owner', 'workspace', 'public']);

/**
 * Copy only the integrity-bearing subset of a typed P-006 reference. Reject
 * credential-bearing/query URIs and malformed metadata rather than letting a
 * result-shaped object smuggle arbitrary text into a persisted execution trace.
 */
function safeOutputReference(value: unknown): OrchestrationOutputReference | null {
  if (!isPlainRecord(value) || value.kind !== 'reference') return null;
  const { uri, byteCount, sha256, expiresAt, audience } = value;
  if (
    typeof uri !== 'string' ||
    uri.length === 0 ||
    uri.length > 2_048 ||
    typeof byteCount !== 'number' ||
    !Number.isSafeInteger(byteCount) ||
    byteCount < 0 ||
    typeof sha256 !== 'string' ||
    !OUTPUT_REFERENCE_SHA_RE.test(sha256)
  ) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return null;
  }
  if (
    (parsed.protocol !== 'papercusp:' && parsed.protocol !== 'https:') ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    return null;
  }
  if (expiresAt !== undefined && (typeof expiresAt !== 'string' || !Number.isFinite(Date.parse(expiresAt)))) {
    return null;
  }
  if (audience !== undefined && (typeof audience !== 'string' || !OUTPUT_REFERENCE_AUDIENCES.has(audience))) {
    return null;
  }
  return {
    uri,
    byteCount,
    sha256: sha256.toLowerCase(),
    ...(typeof expiresAt === 'string' ? { expiresAt } : {}),
    ...(audience === 'owner' || audience === 'workspace' || audience === 'public' ? { audience } : {}),
  };
}

/** Bounded recursive scan: inner tool results are arbitrary transport values. */
function extractOutputReferences(value: unknown): OrchestrationOutputReference[] {
  const found: OrchestrationOutputReference[] = [];
  const seenObjects = new Set<object>();
  const seenRefs = new Set<string>();
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let visited = 0;
  while (pending.length > 0 && visited < 2_000 && found.length < 32) {
    const current = pending.pop()!;
    visited += 1;
    if (typeof current.value !== 'object' || current.value === null || current.depth > 16) continue;
    if (seenObjects.has(current.value)) continue;
    seenObjects.add(current.value);
    const reference = safeOutputReference(current.value);
    if (reference) {
      const key = `${reference.uri}\u0000${reference.sha256}`;
      if (!seenRefs.has(key)) {
        seenRefs.add(key);
        found.push(reference);
      }
      continue;
    }
    if (Array.isArray(current.value)) {
      for (let index = current.value.length - 1; index >= 0; index -= 1) {
        pending.push({ value: current.value[index], depth: current.depth + 1 });
      }
      continue;
    }
    for (const child of Object.values(current.value as Record<string, unknown>)) {
      pending.push({ value: child, depth: current.depth + 1 });
    }
  }
  return found;
}

const STRICT_BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const MEDIA_MIME_RE = /^(image|audio)\/[A-Za-z0-9][A-Za-z0-9.+_-]*$/;
const GENERATED_IMAGE_DATA_URL_RE = /^data:(image\/[A-Za-z0-9][A-Za-z0-9.+_-]*);base64,(.+)$/;

interface ParsedFinalResult {
  summary: unknown;
  media?: CodeRunMediaContent[];
  error?: string;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function validateMediaItem(value: unknown, index: number): CodeRunMediaContent | string {
  if (!isPlainRecord(value)) return `media[${index}] must be an object`;
  const type = value.type;
  if (type !== 'image' && type !== 'audio') {
    return `media[${index}].type must be "image" or "audio"`;
  }
  if (typeof value.data !== 'string' || value.data.length === 0 || !STRICT_BASE64_RE.test(value.data)) {
    return `media[${index}].data must be non-empty canonical base64`;
  }
  if (typeof value.mimeType !== 'string' || !MEDIA_MIME_RE.test(value.mimeType)) {
    return `media[${index}].mimeType must be a concrete image/* or audio/* MIME type`;
  }
  if (!value.mimeType.startsWith(`${type}/`)) {
    return `media[${index}].mimeType must match its ${type} content type`;
  }
  // Copy only the validated MCP fields: arbitrary sibling properties from script data must not
  // hitch a ride around the authored summary/result-door contract.
  return { type, data: value.data, mimeType: value.mimeType };
}

function validateGeneratedImages(
  values: readonly unknown[] | undefined,
): { media: CodeRunMediaContent[]; error?: string } {
  const media: CodeRunMediaContent[] = [];
  for (let index = 0; index < (values?.length ?? 0); index += 1) {
    const value = values![index];
    if (!isPlainRecord(value)) {
      return { media: [], error: `invalid_generated_image: generatedImages[${index}] must be an object` };
    }
    if (typeof value.image_url !== 'string') {
      return { media: [], error: `invalid_generated_image: generatedImages[${index}].image_url must be a data URL` };
    }
    const match = GENERATED_IMAGE_DATA_URL_RE.exec(value.image_url);
    if (!match || !STRICT_BASE64_RE.test(match[2]!)) {
      return {
        media: [],
        error: `invalid_generated_image: generatedImages[${index}].image_url must be a canonical base64 image data URL`,
      };
    }
    if (
      value.output_hint !== undefined &&
      (typeof value.output_hint !== 'string' || value.output_hint.length > 2_000)
    ) {
      return {
        media: [],
        error: `invalid_generated_image: generatedImages[${index}].output_hint must be a string of at most 2000 characters`,
      };
    }
    media.push({
      type: 'image',
      data: match[2]!,
      mimeType: match[1]!,
      ...(value.output_hint === undefined ? {} : { _meta: { output_hint: value.output_hint } }),
    });
  }
  return { media };
}

/**
 * Interpret the opt-in final media contract without changing legacy summaries. An ordinary
 * returned object — including `{ summary: ... }` — remains byte-for-byte the script summary;
 * only the presence of `media` activates the envelope and therefore requires `summary` too.
 */
function parseFinalResult(value: unknown): ParsedFinalResult {
  if (!isPlainRecord(value) || !Object.prototype.hasOwnProperty.call(value, 'media')) {
    return { summary: value };
  }
  const summary = value.summary;
  if (!Object.prototype.hasOwnProperty.call(value, 'summary')) {
    return {
      summary: undefined,
      error: 'invalid_media_result: an explicit media result must include a summary field',
    };
  }
  if (!Array.isArray(value.media)) {
    return { summary, error: 'invalid_media_result: media must be an array' };
  }
  const media: CodeRunMediaContent[] = [];
  for (let index = 0; index < value.media.length; index += 1) {
    const item = validateMediaItem(value.media[index], index);
    if (typeof item === 'string') {
      return { summary, error: `invalid_media_result: ${item}` };
    }
    media.push(item);
  }
  return { summary, media };
}

export async function runToolOrchestration(
  script: string,
  opts: OrchestrateOptions,
): Promise<OrchestrateResult> {
  const { ctx, deps, tools, allowed, dryRun = false, timeoutMs, wrapDispatch } = opts;
  // The worker timeout in runOrchestrationScript kills only the script worker. Host-side tool
  // handlers can still be awaiting their own work after that point, so give every inner dispatch
  // a signal owned by this orchestration and abort it when the worker deadline fires. Without
  // this boundary a long foreground capability:bash keeps running after code:run returned with
  // no bash_id/resumable handle, and a retry can duplicate the command (EI-20282336542235171).
  const orchestrationAbort = new AbortController();
  const abortFromParent = (): void => {
    if (!orchestrationAbort.signal.aborted) orchestrationAbort.abort();
  };
  // `signal` is DECLARED required on UnifiedToolContext, but callers into the stack routinely omit
  // it — which is why the sibling boundary in dispatch-stack.ts guards it the same way rather than
  // trusting the type. Reading it unguarded here threw a TypeError before any work ran (WI-38330).
  if (ctx.signal?.aborted) abortFromParent();
  else ctx.signal?.addEventListener('abort', abortFromParent, { once: true });
  const dispatchCtx: UnifiedToolContext = { ...ctx, signal: orchestrationAbort.signal };
  const plannedMutations: PlannedMutation[] = [];
  const writeAttempts: WriteAttempt[] = [];
  const okFalseMutations: FailedMutation[] = [];
  const childFailures: ChildFailure[] = [];
  // EI-10951: a write that THREW never landed (rejected) or may have (uncertain) — but it
  // certainly was not "already executed", which is what we used to tell the caller.
  const rejectedMutations: ThrownMutation[] = [];
  const uncertainMutations: ThrownMutation[] = [];
  const callRecords: OrchestrationCallRecord[] = [];
  const dispatchedToolNames: string[] = [];
  let authorizationObservationCount = 0;
  let authorityWideningDetected = false;
  let dispatchCount = 0;
  let intermediateBytes = 0;
  const timeoutSettledReads: StoredTimeoutSettledRead[] = [];
  let timeoutSettledReadCount = 0;
  let timeoutSettledReadOmittedCount = 0;
  let timeoutSettledReadBytes = 0;
  const activeCalls = new Set<ActiveOrchestrationCall>();
  let timeoutTriggered = false;
  /** Frozen at the end of the bounded grace, before later handler microtasks can remove calls. */
  let detachedCallsSnapshot: ActiveOrchestrationCall[] | undefined;
  let timeoutBoundaryTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * Abort every dispatch observed at the script deadline, then wait for the cooperative ones to
   * run their normal settlement/telemetry paths. run-script bounds this hook with its grace
   * window; anything still in activeCalls when it returns is explicit detached evidence.
   */
  const settleOnTimeout = async (): Promise<void> => {
    timeoutTriggered = true;
    const pending = Array.from(activeCalls);
    abortFromParent();
    const graceMs = Number.isFinite(opts.timeoutGraceMs)
      ? Math.max(0, opts.timeoutGraceMs as number)
      : DEFAULT_TIMEOUT_SETTLEMENT_GRACE_MS;
    const allSettled = Promise.allSettled(pending.map((call) => call.settled)).then(() => true);
    const graceBoundary = new Promise<boolean>((resolve) => {
      timeoutBoundaryTimer = setTimeout(() => {
        timeoutBoundaryTimer = undefined;
        // This is the authoritative detached census. Do not derive it later from activeCalls:
        // a non-cooperative handler can settle between this boundary and result assembly.
        detachedCallsSnapshot = Array.from(activeCalls);
        resolve(false);
      }, graceMs);
    });
    const settledWithinGrace = await Promise.race([allSettled, graceBoundary]);
    if (settledWithinGrace && timeoutBoundaryTimer) {
      clearTimeout(timeoutBoundaryTimer);
      timeoutBoundaryTimer = undefined;
    }
  };

  await ensureParseCheckReady(); // lazy-load the TS compiler before the static parse-check (kept out of the eager client bundle)
  const check = checkScript(script, tools, allowed);
  // F8 (autonomous-loop-hardening / H2): an unknown tool ref no longer NUKES the whole run before
  // it starts (which forced a full re-run of the good calls too). We still surface `unknownRefs`
  // (→ advisory facadeHelp so the agent fixes the name), but we RUN the script — binding each
  // unknown ref to a stub that REJECTS only when CALLED. So the good calls execute and the author
  // can isolate the bad one (Promise.allSettled / try-catch) instead of re-running the whole batch,
  // and a bad ref in an unreached branch is a no-op. The `allowed` whitelist is still the security
  // boundary — a stub grants NO reach; it only turns a cryptic "cannot read undefined" into a clear
  // per-call error.
  const unknownRefs = check.ok ? undefined : check.unknownRefs;

  const dispatch: FacadeDispatch = async (tool, name, args) => {
    // D-009: after an abort (the caller's deadline, detach or supersession, or this run's own
    // timeout) no new host work begins — including a call the worker posted just before it was
    // terminated. Refused before the dispatcher is entered, so it provably wrote nothing.
    if (orchestrationAbort.signal.aborted) {
      throw new ToolDispatchError(name, 'orchestration_aborted', 'the orchestration was cancelled before this call started');
    }
    const effect = resolveFacadeToolEffect(tool, name, args, tools);
    const callRecord: OrchestrationCallRecord = {
      ordinal: callRecords.length,
      tool: name,
      effect,
      disposition: 'in_flight',
      outputReferences: [],
    };
    callRecords.push(callRecord);
    let writeAttempt: WriteAttempt | undefined;
    if (effect === 'write') {
      plannedMutations.push({ tool: name, args });
      if (dryRun) {
        callRecord.disposition = 'planned';
        return { ok: true, dryRun: true, wouldCall: name, args };
      }
      writeAttempt = {
        index: writeAttempts.length,
        tool: name,
        disposition: 'in_flight',
      };
      writeAttempts.push(writeAttempt);
    }
    let resolveSettled!: () => void;
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    const activeCall: ActiveOrchestrationCall = {
      callRecord,
      settled,
      resolveSettled,
    };
    activeCalls.add(activeCall);
    // Each runDispatchStack invocation creates its own callId before the first await. A
    // per-call wrapper preserves that exact start event and lets the timeout path associate the
    // id with this call record without heuristic matching on tool name or session context.
    const callDeps: DispatchProjectedDeps = {
      ...deps,
      onDispatchStart: (event) => {
        activeCall.callId = event.callId;
        deps.onDispatchStart?.(event);
      },
    };
    dispatchedToolNames.push(name);
    // Counted at the same point the host's dispatcher is entered (a throw below still
    // reached it), so this equals the number of inner telemetry rows the run produced —
    // what lets a wrapper tool (code:run / recipes:run) mark its own row as a dispatch
    // wrapper only when inner rows actually exist (census double-count, P-012).
    dispatchCount += 1;
    const childIdempotencyKey = nestedIdempotencyKey(ctx, callRecord.ordinal);
    const call: DispatchNext = (callCtx, callArgs = args) => {
      // Observe the exact context that enters the real dispatcher, after any
      // per-call workspace/principal rebinding. This is the runtime-owned
      // authorization entry; the script cannot forge or suppress it.
      authorizationObservationCount += 1;
      authorityWideningDetected ||= authorityWidened(ctx, callCtx);
      // Keep the outer transport key on the wrapper input, but scope it to this
      // child before dispatch. This preserves whole-run replay while preventing
      // two distinct nested writes from sharing one child idempotency identity.
      const childCtx = childIdempotencyKey
        ? { ...callCtx, idempotencyKey: childIdempotencyKey }
        : callCtx;
      return realDispatch(childCtx, callDeps)(tool, name, callArgs);
    };
    try {
      const result = await (wrapDispatch
        ? wrapDispatch(tool, name, args, dispatchCtx, call)
        : call(dispatchCtx));
      // P-008: measure the exact serialized payload the script receives. Tool
      // results are JSON transport values; keep telemetry fail-soft if a custom
      // in-process fixture returns a non-serializable object.
      let serializedResult: string | undefined;
      let serializedResultBytes: number | undefined;
      try {
        serializedResult = JSON.stringify(result);
        if (serializedResult !== undefined) {
          serializedResultBytes = new TextEncoder().encode(serializedResult).byteLength;
          intermediateBytes += serializedResultBytes;
        }
      } catch {
        // Telemetry must never turn a settled child call into a failed run.
      }
      if (effect === 'read') {
        timeoutSettledReadCount += 1;
        if (
          serializedResult !== undefined &&
          serializedResultBytes !== undefined &&
          timeoutSettledReads.length < TIMEOUT_SETTLED_READ_RECOVERY_MAX_CALLS &&
          timeoutSettledReadBytes + serializedResultBytes <= TIMEOUT_SETTLED_READ_RECOVERY_MAX_BYTES
        ) {
          timeoutSettledReads.push({
            ordinal: callRecord.ordinal,
            tool: name,
            serializedResult,
            bytes: serializedResultBytes,
          });
          timeoutSettledReadBytes += serializedResultBytes;
        } else {
          timeoutSettledReadOmittedCount += 1;
        }
      }
      callRecord.outputReferences = extractOutputReferences(result);
      // EI-7669: realDispatch only throws on a dispatch-level failure — a tool that dispatched fine
      // but reports its OWN semantic rejection (ok: false in its result body, e.g. a completion-
      // integrity check) resolves normally here. Tally those so a batched script that doesn't check
      // every result still gets visibility instead of silently counting the write as executed.
      if (
        (!isExpectedReadOnlyBashSigpipe(name, effect, result) &&
          !isExpectedReadOnlySystemctlStatus(name, effect, args, result) &&
          !isExpectedReadOnlyPsPpidEmpty(name, effect, args, result) &&
          isOkFalseResult(result)) ||
        isBulkPartialFailure(result)
      ) {
        callRecord.disposition = 'semantic_rejected';
        childFailures.push({ tool: name, kind: 'semantic', result });
        if (effect === 'write') {
          if (writeAttempt) writeAttempt.disposition = 'semantic_rejected';
          okFalseMutations.push({ tool: name, args, result });
        }
      } else if (writeAttempt) {
        const preview = isChildPreview(args, result);
        writeAttempt.disposition = preview ? 'preview' : 'settled';
        callRecord.disposition = preview ? 'preview' : 'settled';
      } else {
        callRecord.disposition = 'settled';
      }
      return result;
    } catch (err) {
      // EI-10951: a write-effect call that THREW was still being counted as "already
      // executed", so a typo'd argument produced a scary — and false — "N writes already
      // landed, do NOT re-run" warning. Record WHY it threw: a pre-execution rejection
      // (bad args, a denied gate) provably wrote nothing and is safe to re-run, while any
      // other throw stays UNKNOWN and keeps the loud warning it deserves.
      const preExecution = isPreExecutionFailure(err);
      callRecord.disposition = preExecution ? 'rejected' : 'uncertain';
      childFailures.push({
        tool: name,
        kind: preExecution ? 'rejected' : 'uncertain',
        error: err instanceof Error ? err.message : String(err),
      });
      if (effect === 'write') {
        if (writeAttempt) writeAttempt.disposition = preExecution ? 'rejected' : 'uncertain';
        (preExecution ? rejectedMutations : uncertainMutations).push({
          tool: name,
          args,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      throw err;
    } finally {
      activeCalls.delete(activeCall);
      resolveSettled();
    }
  };

  const facade = buildToolFacade(tools, dispatch, allowed, unknownRefs);
  const run = await runOrchestrationScript(script, facade, {
    ...(timeoutMs ? { timeoutMs } : {}),
    ...(opts.timeoutGraceMs !== undefined ? { timeoutGraceMs: opts.timeoutGraceMs } : {}),
    onTimeout: settleOnTimeout,
    // The caller's abort terminates the worker too; aborting in-flight handlers alone would let
    // the script keep posting calls until its own timeout.
    ...(ctx.signal ? { signal: ctx.signal } : {}),
    ...(opts.inputs ? { inputs: opts.inputs } : {}),
    ...(ctx.emit ? { emit: (name, data) => ctx.emit(name, data) } : {}),
  });
  ctx.signal?.removeEventListener('abort', abortFromParent);
  // run-script owns the public grace timer. If its timer and our census timer have the same
  // deadline, its result promise can win the event-loop race by one turn; yield once so the
  // census callback gets a chance to freeze the exact boundary before falling back to live state.
  if (timeoutTriggered && detachedCallsSnapshot === undefined && timeoutBoundaryTimer) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    detachedCallsSnapshot ??= Array.from(activeCalls);
  }
  if (timeoutBoundaryTimer) {
    clearTimeout(timeoutBoundaryTimer);
    timeoutBoundaryTimer = undefined;
  }
  // P-020: only meaningful when the script ABORTED — a run that completed reached every line
  // it was going to, so an undispatched write there was a branch not taken, not a stranding.
  // A parse-recovered AST is advisory only: TypeScript may surface calls from syntax-invalid
  // source that the VM never compiled, so those calls were not ordered by an executable script.
  const strandedWrites = run.ok || check.hasParseErrors
    ? []
    : detectStrandedWrites(check.calls, tools, dispatchedToolNames);
  const notDispatchedWrites: NotDispatchedWrite[] = strandedWrites.map((tool) => ({
    tool,
    executed: false,
  }));
  const detachedCalls: DetachedOrchestrationCall[] = timeoutTriggered
    ? (detachedCallsSnapshot ?? Array.from(activeCalls))
        .filter((call): call is ActiveOrchestrationCall & { callId: string } => typeof call.callId === 'string')
        .map((call) => ({
          callId: call.callId,
          tool: call.callRecord.tool,
          effect: call.callRecord.effect,
          ordinal: call.callRecord.ordinal,
          disposition: call.callRecord.disposition,
        }))
    : [];
  const timeoutSettledReadRecovery: TimeoutSettledReadRecovery | undefined =
    timeoutTriggered && timeoutSettledReadCount > 0
      ? {
          calls: timeoutSettledReads
            .sort((a, b) => a.ordinal - b.ordinal)
            .map(({ ordinal, tool, serializedResult }) => ({
              ordinal,
              tool,
              result: JSON.parse(serializedResult) as unknown,
            })),
          totalSettledReadCount: timeoutSettledReadCount,
          omittedReadCount: timeoutSettledReadOmittedCount,
          includedBytes: timeoutSettledReadBytes,
          maxBytes: TIMEOUT_SETTLED_READ_RECOVERY_MAX_BYTES,
          maxCalls: TIMEOUT_SETTLED_READ_RECOVERY_MAX_CALLS,
        }
      : undefined;
  const finalResult = run.ok ? parseFinalResult(run.result) : { summary: run.result };
  const generated = validateGeneratedImages(run.generatedImages);
  const media = [...(finalResult.media ?? []), ...generated.media];
  const effectiveOk = run.ok && !finalResult.error && !generated.error;
  const replayProof = opts.requestHash
    ? deriveCodeRunSettledReadReplayProof({
        requestHash: opts.requestHash,
        staticCalls: check.calls,
        hasParseErrors: check.hasParseErrors,
        unknownRefs,
        runOk: effectiveOk,
        dryRun,
        callRecords,
      })
    : undefined;
  return {
    ok: effectiveOk,
    summary: finalResult.summary,
    ...(media.length ? { media } : {}),
    ...(run.state ? { state: run.state } : {}),
    logs: run.logs,
    error: finalResult.error ?? generated.error ?? run.error,
    ...(unknownRefs && unknownRefs.length ? { unknownRefs } : {}),
    dryRun,
    dispatchCount,
    intermediateBytes,
    runtimeObservations: {
      authorizationObservationCount,
      authorityWideningDetected,
      midTurnPromptInjectionObservability: 'not-observable',
    },
    plannedMutations,
    ...(!dryRun && writeAttempts.length
      ? { writeAttempts: writeAttempts.map((attempt) => ({ ...attempt })) }
      : {}),
    okFalseMutations,
    childFailures,
    ...(rejectedMutations.length ? { rejectedMutations } : {}),
    ...(uncertainMutations.length ? { uncertainMutations } : {}),
    ...(strandedWrites.length ? { strandedWrites } : {}),
    ...(notDispatchedWrites.length ? { notDispatchedWrites } : {}),
    ...(detachedCalls.length ? { detachedCalls } : {}),
    ...(timeoutSettledReadRecovery ? { timeoutSettledReadRecovery } : {}),
    ...(replayProof ? { replayProof } : {}),
    ...(run.fieldMisses?.length ? { fieldMisses: run.fieldMisses } : {}),
    ...(run.sleepCaps?.length ? { sleepCaps: run.sleepCaps } : {}),
    callRecords: callRecords.map((record) => ({
      ...record,
      outputReferences: record.outputReferences.map((reference) => ({ ...reference })),
    })),
    // EI-7784: surfaced independent of `ok` — see the field doc above.
    partial: effectiveOk && childFailures.length > 0,
  };
}
