import { z } from 'zod';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { getOrgPg } from '@papercusp/db-org';
import { maybeEmptyMappingHint, EMPTY_MAPPING_METADATA_KEY } from '../../empty-mapping-hint';
import { DISPATCH_WRAPPER_METADATA_KEY } from '../sessions/automatic-tool-names';
import { dispatchWrapperMarkEnabled } from '../../telemetry-dispatch-wrapper';
import {
  defineTool,
  listAllProjectedTools,
  runToolOrchestration,
  roleScopedToolNames,
  generateToolFacadeTypes,
  listFacadeNamespaces,
  nearestByLevenshtein,
  AGENT_ROLES,
  type UnifiedToolContext,
} from '@papercusp/agent-mcp';
import {
  CODE_RUN_REPLAY_PROOF_META_KEY,
  DEFAULT_SCRIPT_TIMEOUT_MS,
  type FieldMiss,
  type ToolResult,
} from '@papercusp/tooldef';
import { PROJECTED_DEPS } from '../../projected-tool-deps';
import { resolveConcreteHarnessSlug } from '../_harness-scope';
import {
  FOREGROUND_TIMEOUT_CEILING_MS,
  clampForegroundTimeoutMs,
  foregroundClampDisclosure,
} from '../capability/foreground-transport-cap';
import { captureRecipe, type RecipeCaptureDisposition } from './capture-recipe';
import type { SimilarRecipe } from '../../code-recipes-search';
import { deriveRecipeAuthority, recipeRevision } from '../../recipe-authority';
import { bindCurrentCallerDispatch } from '../orchestration/current-caller-dispatch';
import { recordRecipeRun } from '../../code-recipes-store';
import { withBoundedTimeout, type BoundedTimeoutResult } from '../../bounded-timeout';
import {
  normalizeExecutionTrace,
  type NormalizedExecutionTrace,
} from '../../orchestration-trace';
import type {
  CapabilityManifestV1,
  JsonValue,
  RecipeBindingSchemaV1,
} from '../../recipe-contract';
import { ORCHESTRATION_RECURSION_EXCLUSIONS } from '../orchestration/contract-preflight';
import { validateRecipeScriptAgainstCatalog } from '../recipes/recipe-schema-validation';
import { canonicalJson } from '../../authority/authority-rpc-envelope';

export type CodeRunCaptureMode = 'auto' | 'never';

/** SHA-256 of the complete, validated outer code:run argument body. */
export function codeRunRequestHash(args: unknown): string {
  return createHash('sha256').update(canonicalJson(args), 'utf8').digest('hex');
}

const CODE_RUN_CAPTURE_MODE = Symbol('papercusp.code-run.capture-mode');
const CODE_RUN_CONTRACT = Symbol('papercusp.code-run.contract');

export interface CodeRunContract {
  inputs: Record<string, JsonValue | { resourceRef: string; revision?: string }>;
  bindingSchema?: RecipeBindingSchemaV1;
  capabilityManifest: CapabilityManifestV1;
  tags?: string[];
}

/**
 * Internal adapter seam for orchestrate:run. The public code:run contract keeps
 * mandatory capture, while the orchestration facade can honor its explicit
 * capture.mode:"never" policy without copying the code:run execution path.
 */
export function withCodeRunCaptureMode(ctx: UnifiedToolContext, mode: CodeRunCaptureMode): UnifiedToolContext {
  const captureCtx: UnifiedToolContext & {
    [CODE_RUN_CAPTURE_MODE]: CodeRunCaptureMode;
  } = { ...ctx, [CODE_RUN_CAPTURE_MODE]: mode };
  return captureCtx;
}

function codeRunCaptureMode(ctx: UnifiedToolContext): CodeRunCaptureMode {
  return (
    (ctx as UnifiedToolContext & { [CODE_RUN_CAPTURE_MODE]?: CodeRunCaptureMode })[CODE_RUN_CAPTURE_MODE] ?? 'auto'
  );
}

/** Internal-only typed-input/capture metadata for orchestrate:run. */
export function withCodeRunContract(ctx: UnifiedToolContext, contract: CodeRunContract): UnifiedToolContext {
  return { ...ctx, [CODE_RUN_CONTRACT]: contract } as UnifiedToolContext;
}

function codeRunContract(ctx: UnifiedToolContext): CodeRunContract | undefined {
  return (ctx as UnifiedToolContext & { [CODE_RUN_CONTRACT]?: CodeRunContract })[CODE_RUN_CONTRACT];
}

/**
 * Bound best-effort work performed after the orchestration worker returns.
 *
 * `code:run` is a foreground tool: the worker itself is clamped below the MCP transport
 * deadline, but trace normalization, recipe capture, and trace-only recording run on the host
 * after that worker settles. Every one of those legs can touch the database or lazy-load code,
 * so a slow leg must not consume the serialization headroom that makes the foreground response
 * safe. The deadline is absolute (shared by every leg), rather than a fresh timeout per leg.
 * `withBoundedTimeout` deliberately leaves late best-effort work running; it only prevents that
 * work from holding the response open.
 */
export async function withCodeRunResponseBudget<T>(
  work: () => Promise<T>,
  opts: { deadlineAtMs: number; fallback: T; label?: string },
): Promise<BoundedTimeoutResult<T>> {
  const remainingMs = opts.deadlineAtMs - Date.now();
  if (remainingMs <= 0) {
    return {
      value: opts.fallback,
      degraded: true,
      reason: 'timeout',
      elapsedMs: 0,
    };
  }
  // Resolve the thunk on a microtask so a synchronous adapter failure follows the same
  // best-effort/error path as an async rejection instead of escaping before the race is set up.
  return withBoundedTimeout(() => Promise.resolve().then(work), {
    fallback: opts.fallback,
    timeoutMs: remainingMs,
    ...(opts.label ? { label: opts.label } : {}),
  });
}

// Compatibility export for the focused branch tests and any internal callers
// that predate the shared P-005 name. There is only one implementation.
export { bindCurrentCallerDispatch as bindInnerDispatch } from '../orchestration/current-caller-dispatch';

/**
 * `code:run` — execute a multi-step tool-orchestration SCRIPT in one call
 * (code-execution-tool-orchestration B-CX-2A).
 *
 * The script calls the agent's allowed tools as `tools.<ns>.<verb>(args)` (verbs camelCased:
 * `coord:wake-queue` → `tools.coord.wakeQueue`) or `tools.call('ns:verb', args)`, with real
 * control flow (loops / conditionals / retries / filtering). It runs in a vm sandbox; only the
 * script's RETURNED value re-enters your context — intermediate tool results stay in the runtime.
 * This collapses tool flows that would otherwise require multiple MODEL inference turns into ONE
 * `code:run` call and keeps intermediate payloads out of model context. Several independent direct
 * calls emitted together in one assistant response are already one inference turn; raw RPC count is
 * not the cost metric.
 *
 * SAFETY: the sandbox exposes only tools your role may call (the whitelist IS the boundary). Set
 * `dryRun: true` to PREVIEW mutations — `effect:'write'` tool calls are recorded (returned in
 * `plannedMutations`) but NOT executed; reads still run. Re-run without `dryRun` to commit.
 */
export default defineTool({
  name: 'code:run',
  description:
    'Run a multi-step tool-orchestration JS script in one call with tools.ns.verb(args). Only the ' +
    'returned summary/media re-enters context; intermediate results stay in the runtime. Wrong ' +
    'names return typed signatures; dryRun:true previews write effects. Tool-name mapping is ' +
    'colon-to-dot: only the namespace/verb separator `:` becomes `.`, while `_` stays inside each segment ' +
    '(work_items:get → tools.work_items.get or tools.workItems.get; ' +
    '`tools:invoke` → tools.tools.invoke).',
  guidance: {
    when:
      'MANY tool calls with control flow — loop/branch/filter, fan-out reads, retry-until: ' +
      'orchestrate them in ONE call. Pass title+description so the ' +
      'run saves as a reusable RECIPE other agents in your hive can find.',
    notWhen:
      'A single call; a few independent calls in one turn; a step needing YOUR judgment mid-flow ' +
      '— call tools directly. OR importing repo modules/a DB client directly: only ' +
      'tools.ns.verb(args) is exposed (no require/process/import) — use capability:bash + npx tsx.',
    chaining:
      'script → code:run { dryRun:true } → inspect plannedMutations → code:run. A correct tool ' +
      "name with a WRONG field mapping fails SILENTLY (ok:true, blank rows) — check the tool's " +
      '`returns` (tools:find), or return one raw result before mapping a batch. ORDERING: a ' +
      'rejected/thrown call aborts every LATER call in the same script — put durable writes ' +
      '(checkpoint, facts:assert) FIRST, never last.',
    seeAlso: [
      'code:tools (typed signatures for a namespace — optional pre-check)',
      'recipes:run (run a saved composed recipe instead)',
    ],
  },
  // Role-gated tools gate on agentRoles (not capability); capability sets the outer authorization
  // requirement while effect preserves the write/dry-run contract. The wrapper itself uses the
  // read-only facade capability so evidence-only roles (notably judge) can orchestrate the tools
  // they already have; every inner call still runs through its own capability/role/envelope gates.
  capability: 'agent_tools:read',
  effect: 'write',
  requirePrincipal: false,
  // EI-20191260319468035: the orchestration handler itself never reads ctx.tx. Holding the
  // host's workspace transaction open around the whole script made a write through an inner
  // tool invisible to the next dev:pg_query call, which intentionally reads on a separate
  // lossless connection. The inner dispatcher establishes one short transaction per scoped
  // tool call instead, so each committed write is visible to the next call and a long script
  // cannot retain an idle transaction for its whole runtime.
  skipWorkspaceTx: true,
  // ALL ROLES (owner directive 2026-06-25): code:run is open to every built-in role — not just
  // SU_ROLES + bee, which was the prior gate. Rationale: the grant is privilege-PRESERVING. The
  // facade is role-scoped (handler below: `roleScopedToolNames(all, ctx.role, …)`), so a role's
  // script can ONLY call tools that role may ALREADY call, and every inner call re-routes through
  // the real dispatcher (PROJECTED_DEPS → capability-envelope + quota + authz gating). Widening the
  // role gate therefore grants NO new reach — it just lets EVERY role collapse its own multi-call
  // flows into one round-trip (the token-frugality win that was inert for the high-repeat-call roles
  // worker/validator/reviewer/… while they were excluded here). A deployment that confines a role
  // away from capability:bash via a blueprint envelope still denies code:run at that envelope.
  // AGENT_ROLES is the complete built-in role universe; keep the companion tools (code:tools,
  // recipes:run/search/list/get) and CODE_RUN_CAPABLE_ROLES (the batch-nudge audience) in lockstep.
  agentRoles: [...AGENT_ROLES],
  args: z.object({
    script: z
      .string()
      .min(1)
      .max(20_000)
      .describe(
        'Plain JavaScript body only (TypeScript annotations such as `: any` are not supported). Call tools via `await tools.ns.verb(args)`; `return` a compact summary. ' +
          'On script timeout, `timeoutSettledReadRecovery.calls` returns settled read-only child results, capped at 24 KiB/20 calls; ' +
          'check `omittedReadCount`, and never assume a slow Promise.all sibling returned to the script. Write results are never included in timeout recovery. ' +
          'No ambient `exec`/shell helper exists -- `tools` exposes ONLY `tools.ns.verb(args)` calls; ' +
          'to run a shell command, call `tools.capability.bash({ command })` like any other tool. ' +
          'Nested tool calls return their typed result root, not an MCP `content`/`text` envelope: for example, ' +
          'read `result.output`, `result.exit_code`, and `result.status` from capability:bash; do not read `result.content[0].text`. ' +
          'To emit final media, return exactly `{ summary, media: [{ type: "image"|"audio", data: "<base64>", mimeType }] }`; ' +
          'media from intermediate tool calls is never emitted implicitly. ' +
          'Compatibility helpers are ambient: `notify(value)` and `yield_control()` stream through the current transport; ' +
          '`generatedImage({ image_url: "data:image/...;base64,...", output_hint? })` appends a validated image; ' +
          '`store(key, value)` / `load(key)` use explicit replay state seeded from bindings/inputs and returned with the result -- never hidden session memory. ' +
          'No setTimeout or setInterval usage -- neither is ambient in this sandbox -- use `await sleep(ms)` for a ' +
          'short bounded delay (e.g. write-then-reverify) instead. sleep() caps at 10s and returns the ' +
          'actual ms waited -- use that (not ms) when measuring a window, e.g. a rate over a delta. ' +
          "A shell-command STRING passed to `tools.capability.bash({ command })` needs JS escaping too: write " +
          "`tr '\\\\0' ' ' </proc/self/cmdline` " +
          '(two backslashes in the script source); a single `\\0` JS escape becomes a NUL and is rejected before bash runs. ' +
          "Literal shell backslashes need the same JS escaping: use String.raw for the script or double each backslash in a JS string, e.g. `find /tmp \\\\( -name '*.unlikely-no-match' \\\\)`; a single `\\(` becomes `(` before bash runs, breaking grouped predicates. " +
          "Shell parameter expansion needs the same template-layer escape: inside a JavaScript template literal, write `\\${f##*/}` (or avoid the expansion) so the JavaScript compiler does not treat the shell `${f##*/}` as its own template expression; otherwise code:run returns `compile_error` before bash is dispatched. " +
          'Multiline shell commands need the JavaScript string layer too: use a backtick template literal for `command` when it contains literal newlines, or escape each line break as `\\n`; a literal newline inside a single/double-quoted string causes `compile_error` before bash dispatch. ' +
          'Regex literals containing path slashes are another string layer: an extra backslash before `/` can close the literal early and yield `compile_error: Invalid regular expression flags`; prefer `String.includes(...)` or `new RegExp("...")` when composing scripts through another string layer. ' +
          'Generated data needs the same JS layer: do not interpolate `JSON.stringify(ids)` into a JavaScript double-quoted command literal. ' +
          'Nested tools.capability.bash searches: apostrophe regexes break single-quoted arguments; use rg -F, -e per pattern, or quoted stdin/file. ' +
          'The JSON quotes can close that outer string and cause `compile_error` before bash is dispatched; keep the serialized value in a script variable and concatenate it into the command at runtime (or pass it through quoted stdin, a heredoc, or an argument).',
      ),
    title: z
      .string()
      .max(120)
      .optional()
      .describe(
        'Short title for the reusable RECIPE saved on a successful run — make it discoverable ' +
          'by other agents (e.g. "triage stale work-items"). Optional: a fallback is derived ' +
          'from the script when omitted.',
      ),
    description: z
      .string()
      .max(2_000)
      .optional()
      .describe(
        'One/two lines on what this recipe does + when to reuse it. Optional: derived from the ' +
          'tool-set when omitted.',
      ),
    dryRun: z
      .boolean()
      .optional()
      .describe('Preview: record effect:write tool calls without executing them (reads still run).'),
    timeoutSec: z
      .number()
      .int()
      .min(1)
      .max(FOREGROUND_TIMEOUT_CEILING_MS / 1000)
      .optional()
      .describe(
        `Wall-clock budget (default ${DEFAULT_SCRIPT_TIMEOUT_MS / 1000}s). EFFECTIVE CEILING IS ` +
          `${FOREGROUND_TIMEOUT_CEILING_MS / 1000}s. EI-9239: code:run has no run_in_background — ` +
          `every call is foreground, and the papercusp-su MCP transport hard-caps a foreground call ` +
          `at ~55s. Values above ${FOREGROUND_TIMEOUT_CEILING_MS / 1000}s are rejected by the input ` +
          `schema; the runtime clamp remains a defense for internal callers that bypass transport ` +
          `validation. For work that genuinely needs longer, split it into multiple code:run calls ` +
          `or fall back to individual tool calls.`,
      ),
  }),
  async handler(args, ctx) {
    const runStartedAtMs = Date.now();
    // Keep the whole foreground handler below the transport ceiling, including all best-effort
    // host-side work after the orchestration worker returns. The worker's own timeout is only one
    // leg of this response budget; it must not be followed by an unbounded trace/capture tail.
    const responseDeadlineAtMs = runStartedAtMs + FOREGROUND_TIMEOUT_CEILING_MS;
    const script = args.script;
    // The proof is about this exact validated request body. Compute it at the
    // server boundary; neither the script nor a caller-supplied result field
    // can choose the hash.
    const requestHash = codeRunRequestHash(args);

    // EI-21570021207351896 / EI-21569537333182760: keep the requested and the EFFECTIVE budget as
    // separate values. The clamp below is unchanged — what was missing is that nothing downstream
    // could tell the two apart, so a run that died at the ceiling reported a deadline the caller
    // never set. Do NOT collapse these back into one expression: the pair is what makes the
    // disclosure possible.
    const requestedTimeoutMs = args.timeoutSec ? args.timeoutSec * 1000 : undefined;
    const effectiveTimeoutMs =
      requestedTimeoutMs !== undefined ? clampForegroundTimeoutMs(requestedTimeoutMs) : undefined;

    const all = listAllProjectedTools();
    // Scope the facade to tools this agent's role may call (mirrors the dispatcher role-allowlist);
    // exclude code:run itself so a script cannot recursively nest code-mode.
    const allowed = roleScopedToolNames(all, ctx.role, ORCHESTRATION_RECURSION_EXCLUSIONS);
    const contract = codeRunContract(ctx);

    // EI-19449316000499177: PRE-VALIDATE statically-known tool args BEFORE anything dispatches.
    //
    // code:run runs its calls in order, so an argument the tool does not accept is caught at
    // EXECUTION time — call #1 is rejected and every later write is reported as `strandedWrites`
    // and never runs, even though the offending key sat literally in the script the whole time and
    // nothing had to execute to know it was wrong. Measured twice on 2026-08-03:
    // `improvements.capture({ harness })` (→ "Did you mean `scope`") stranded plans:set-status +
    // plans:set-now, then `plans.setStatus({ itemId })` (→ "Did you mean `item`") stranded
    // plans:set-now again.
    //
    // REUSE, not a parallel validator: `validateRecipeScriptAgainstCatalog` already does exactly
    // this (static AST → statically-resolved calls with literal args → checked against the live
    // `inputSchema`) and already gates orchestrate:run and recipes:run via inspectScriptContract.
    // It was simply never wired to code:run.
    //
    // FAIL CLOSED ONLY ON `unknown-key`, deliberately. That class is decided by
    // `additionalProperties:false`, which is precisely what a strict zod object rejects at
    // dispatch — so a flagged key is one the real dispatcher WILL refuse, and refusing here is
    // strictly better than refusing three calls later with writes stranded behind it. The other
    // classes compare a literal against the PUBLISHED schema, which a tool may legitimately widen:
    // ~22 arg schemas use `z.coerce` so the same field accepts a numeric MCP arg AND a string, so
    // a `type` complaint against one of those is a false positive. On the fleet's
    // highest-traffic script tool a false refusal is far more expensive than a missed hint, so
    // those stay non-blocking and are left to the dispatcher exactly as before. Both of the item's
    // measured cases are `unknown-key`, so the narrow class covers the reported failure in full.
    //
    // Dynamic arguments are never inspected (the validator skips `dynamicArgs`), so a computed
    // argument object behaves exactly as it did before this check existed.
    // Preflight is part of the same foreground request. A slow catalog read must not
    // spend the entire transport window before the worker's own clock even starts.
    const preflight = await withCodeRunResponseBudget(
      () => validateRecipeScriptAgainstCatalog(script, all, allowed),
      { deadlineAtMs: responseDeadlineAtMs - 1_000, fallback: null, label: 'argument preflight' },
    );
    if (preflight.degraded || !preflight.value) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          ok: false,
          error: preflight.reason === 'error'
            ? `script_preflight_error: ${preflight.errorMessage ?? 'unknown error'}`
            : 'script_timeout during argument preflight',
          executed: false,
          dispatchCount: 0, partial: false,
        }) }],
      } as unknown as ToolResult;
    }
    const argPreflight = preflight.value;
    const blockingArgIssues = argPreflight.issues.filter((issue) => issue.kind === 'unknown-key');
    if (blockingArgIssues.length > 0) {
      const acceptedKeysFor = (toolName: string): string[] => {
        const schema = all.find((t) => t.expose?.mcp?.name === toolName)?.inputSchema as
          | { properties?: Record<string, unknown> }
          | undefined;
        return Object.keys(schema?.properties ?? {}).sort();
      };
      const refusals = blockingArgIssues.map((issue) => {
        // `message` is `args.<key> is not accepted by the current tool schema`.
        const rejectedKey = issue.message.split(' ')[0]?.split('.').slice(1).join('.') ?? '';
        const accepted = acceptedKeysFor(issue.tool);
        const didYouMean = rejectedKey ? nearestByLevenshtein(rejectedKey, accepted, { k: 2 }) : [];
        return {
          tool: issue.tool,
          rejectedArg: rejectedKey || undefined,
          message: issue.message,
          didYouMean: didYouMean.length ? didYouMean : undefined,
          accepts: accepted,
        };
      });
      const headline = refusals
        .map((r) => {
          const suggestion = r.didYouMean?.length ? ` — did you mean \`${r.didYouMean[0]}\`?` : '';
          return `${r.tool} does not accept \`${r.rejectedArg ?? '?'}\`${suggestion}`;
        })
        .join('; ');
      ctx.metadata?.({
        effectiveStatus: 'error',
        codeRunArgPreflight: 'refused',
        codeRunArgPreflightIssueCount: blockingArgIssues.length,
      });
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              error: 'script_invalid',
              executed: false,
              dispatchCount: 0,
              argPreflight: { refused: true, refusals },
              note:
                `NOTHING RAN — this script was refused BEFORE dispatch because ${refusals.length} ` +
                `call(s) pass an argument the tool's own schema does not accept: ${headline}. ` +
                `No write executed and nothing is stranded, so fix the argument name(s) and re-run ` +
                `the whole script as-is. Each entry's \`accepts\` lists that tool's real argument ` +
                `keys. Only statically-literal arguments are checked; computed ones are untouched.`,
            }),
          },
        ],
      } as unknown as ToolResult;
    }

    // The worker timeout starts when it is launched, after preflight. Bound it by
    // the *remaining* absolute response window, leaving a second for shaping.
    const remainingWorkerMs = responseDeadlineAtMs - Date.now() - 1_000;
    if (remainingWorkerMs <= 0) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          ok: false, error: 'script_timeout before execution', executed: false,
          dispatchCount: 0, partial: false,
        }) }],
      } as unknown as ToolResult;
    }
    const workerTimeoutMs = Math.min(
      effectiveTimeoutMs ?? DEFAULT_SCRIPT_TIMEOUT_MS,
      remainingWorkerMs,
    );
    const result = await runToolOrchestration(script, {
      ctx,
      // Thread the host's REAL dispatch deps (B-CX-DEPS): inner tool calls route through
      // the same dispatcher pipeline as any MCP `tools/call` — so they are recordInvocation-
      // logged (visible to spend/quota, not invisible), quota-counted, capability-envelope-
      // gated, postInvoke/event-reaction-observed, and authz-audited — not just role-allowlisted.
      // Same singleton the in-process re-dispatch path (events/dispatch-reaction.ts) uses.
      deps: PROJECTED_DEPS,
      tools: all,
      allowed,
      dryRun: args.dryRun ?? false,
      // EI-9239: clamp below the ~55s MCP transport cap (mirrors capability:inspect's identical
      // EI-6073 fix) so a script_timeout fires cleanly here instead of the caller getting an
      // opaque transport-level request_timeout after the script's own budget was never reached.
      timeoutMs: workerTimeoutMs,
      wrapDispatch: bindCurrentCallerDispatch,
      requestHash,
      ...(contract ? { inputs: contract.inputs } : {}),
    });

    // EI-21570021207351896 / EI-21569537333182760: DISCLOSE the clamp on the envelope the caller
    // actually reads. Both items were filed because `timeoutSec: 120` produced a bare
    // `script_timeout after 50000ms` — the requested budget appears nowhere, so the only available
    // reading was that the documented 1..120 range is untrue. The schema description already
    // explained the clamp, but a description is not on the failure the agent is holding.
    //
    // Narrowly gated on purpose: only when the caller SUPPLIED a budget, only when the clamp
    // actually lowered it, and only on the timeout error itself. A run that was never clamped, or
    // that failed for any other reason, is untouched — a timeout notice on a non-timeout failure
    // is the false-hint bug that `foregroundTimeoutHint` is careful to avoid.
    if (!result.ok && requestedTimeoutMs !== undefined && effectiveTimeoutMs !== undefined) {
      const clampDisclosure = foregroundClampDisclosure(requestedTimeoutMs, effectiveTimeoutMs);
      if (clampDisclosure && typeof result.error === 'string' && result.error.startsWith('script_timeout')) {
        (result as { error?: string }).error = `${result.error}${clampDisclosure}`;
      }
    }
    if (
      !result.ok && workerTimeoutMs < (effectiveTimeoutMs ?? DEFAULT_SCRIPT_TIMEOUT_MS) &&
      typeof result.error === 'string' && result.error.startsWith('script_timeout')
    ) {
      (result as { error?: string }).error =
        `${result.error} — worker budget was reduced to ${workerTimeoutMs}ms because argument preflight ` +
        'used part of this call\'s shared foreground response deadline';
    }

    // P-013: capture the execution evidence BEFORE shaping the model-facing
    // payload. callRecords are internal dispatch evidence; the normalized trace
    // keeps the safe subset and the raw records never cross the result door.
    let executionTrace: NormalizedExecutionTrace | null = null;
    const runPostprocessing = <T>(label: string, work: () => Promise<T>, fallback: T) =>
      withCodeRunResponseBudget(work, {
        deadlineAtMs: responseDeadlineAtMs,
        fallback,
        label: `code:run ${label}`,
      });
    const traceNormalization = await runPostprocessing(
      'trace normalization',
      () =>
        normalizeExecutionTrace({
          script,
          backend: 'server',
          tools: all,
          allowed,
          callRecords: result.callRecords,
        }),
      null,
    );
    if (!traceNormalization.degraded) {
      executionTrace = traceNormalization.value;
    } else if (traceNormalization.reason === 'error') {
      ctx.log(`code:run trace normalization failed (swallowed): ${traceNormalization.errorMessage ?? 'unknown error'}`);
    } else {
      ctx.log('code:run trace normalization skipped: response budget exhausted');
    }

    // CAPTURE + DEDUP (code-recipes-2026-06-21 P-003/P-004): every SUCCESSFUL, non-dry-run
    // code:run is saved as a reusable recipe (D-012), and the capture path ALSO returns the
    // top prior recipes that already do something similar (semantic + structural dedup, D-003).
    // Best-effort — wrapped so it can NEVER break the run (a dry-run is a preview, not an
    // execution, so it captures nothing). The await keeps the recipe durable before we return,
    // but maybeCaptureRecipe swallows every failure internally.
    //
    // similarRecipes is ADVISORY/SOFT: the run STILL ran + STILL captured. It tells the agent
    // "recipes X/Y already do this — next time recipes:run(X) instead of re-authoring".
    let similarRecipes: SimilarRecipe[] = [];
    let recipeCapture: CodeRunRecipeCapture | null = null;
    // Don't SAVE a recipe that references an unknown tool (F8): the run may have limped through by
    // isolating the bad ref, but a captured recipe with a known-bad name is a poor thing to reuse.
    // EI-7669: also don't save one where a write-effect call reported ok:false — a "successful"
    // recipe that includes a known-rejected mutation is a poor thing to reuse verbatim.
    // WI-40896 fault 2: ALSO refuse capture when the script's authority cannot be
    // resolved. recipes:run rejects such a recipe with authority_unresolved every
    // time, and that refusal is permanent — capturing it anyway mints a recipe that
    // can never run, then lets it accrue run/success counts that certify it.
    if (codeRunCaptureMode(ctx) !== 'never' && !(args.dryRun ?? false) && isRecipeCaptureEligible(result, all)) {
      const authority = await runPostprocessing(
        'recipe authority check',
        () => isRecipeCaptureAuthorityEligible(args.script),
        false,
      );
      if (authority.value && !authority.degraded) {
        const capture = await runPostprocessing(
          'recipe capture',
          () => maybeCaptureRecipe(args, ctx, all, allowed, executionTrace, contract),
          null,
        );
        recipeCapture = capture.value;
        similarRecipes = recipeCapture?.similarRecipes ?? [];
        if (capture.degraded) {
          ctx.log(
            capture.reason === 'error'
              ? `code:run recipe capture failed (swallowed): ${capture.errorMessage ?? 'unknown error'}`
              : 'code:run recipe capture skipped: response budget exhausted',
          );
        }
      } else if (authority.degraded) {
        ctx.log(
          authority.reason === 'error'
            ? `code:run recipe authority check failed (swallowed): ${authority.errorMessage ?? 'unknown error'}`
            : 'code:run recipe authority check skipped: response budget exhausted',
        );
      } else {
        // Logged, not silent: this is the one capture-skip reason that is invisible
        // in the result (the run itself succeeded), so without this line a missing
        // recipe looks like a capture bug rather than a deliberate refusal.
        ctx.log('code:run recipe capture skipped: authority unresolved (recipes:run would permanently refuse this script)');
      }
    }
    // Failed, dry-run, capture-disabled, and capture-failed scripts still get a
    // durable trace row. A successful capture already recorded this same trace
    // against its recipe, so do not emit a duplicate execution row.
    if (executionTrace && !recipeCapture) {
      const traceRecord = await runPostprocessing(
        'trace-only recording',
        () => maybeRecordTraceOnly(ctx, executionTrace as NormalizedExecutionTrace, Boolean(result.ok)),
        undefined,
      );
      if (traceRecord.degraded) {
        ctx.log(
          traceRecord.reason === 'error'
            ? `code:run trace record failed (swallowed): ${traceRecord.errorMessage ?? 'unknown error'}`
            : 'code:run trace record skipped: response budget exhausted',
        );
      }
    }

    // P-007 (agent-tooling-token-efficiency): cut the discovery ritual. The old flow demanded a
    // code:tools {} → code:tools { namespaces } pre-call before you could safely author a script.
    // Instead, on a parse-check failure (the script referenced a tool not in your facade — a typo'd
    // verb or wrong namespace) hand back the typed signatures for the namespaces it touched IN THIS
    // SAME RESULT, so you fix the name + re-run rather than paying a separate code:tools round-trip.
    // dryRun safety is untouched: write-effect mutations still require the dryRun preview as before.
    // Surface the self-service fix whenever the script referenced an unknown tool — even if the run
    // limped through by isolating it (F8): the agent still wants the correct name for next time.
    const facadeHelp = result.unknownRefs?.length ? buildFacadeHelp(result.unknownRefs, all, allowed) : undefined;

    // EI-19301148486657755: the FIELD-name counterpart of facadeHelp above. A wrong TOOL name
    // already hands back typed signatures; a wrong FIELD name was silent, because `undefined` is
    // indistinguishable from a legitimately-absent value and the `?? null` / `?? 0` fallbacks
    // agents write to keep summaries bounded launder it into a confident number. Live case: a
    // monitor script read `claimable.count` (real key: `claimableCount`), reported "0 claimable"
    // against a queue of 1,397, and nearly stood down a 10-agent fleet.
    //
    // Stated as a correction rather than a dump: the miss only exists because the author was
    // ALREADY wrong, so the useful payload is "you read X, the keys are Y".
    const fieldMissHelp = shapeFieldMissHelp(result.fieldMisses);

    // EI-19324793244855883: sleep(ms) silently clamped a requested delay to the sandbox cap, so a
    // script measuring a rate/share over a requested window divided by the number it ASKED for,
    // not the number it got — a wrong denominator with no error. Surface every clamp loudly here,
    // the same "correction, not a dump" shape as fieldMissHelp above.
    const sleepCapHelp = result.sleepCaps?.length
      ? [
          `⚠ ${result.sleepCaps.length} sleep() call(s) asked for longer than this sandbox's cap and were silently ` +
            `shortened — if you're measuring a window (a rate, a share, a delta), you divided by the REQUESTED ` +
            `ms, not the ACTUAL ms you got. sleep() now resolves with the actual ms waited — use ` +
            `\`const actual = await sleep(n)\` to self-correct next time:`,
          ...result.sleepCaps.map((s) => `  • requested ${s.requestedMs}ms, actually waited ${s.actualMs}ms`),
        ].join('\n')
      : undefined;

    // WI-1377: keep the full plannedMutations echo ONLY under dryRun (the mutation preview the
    // agent inspects before committing). On a REAL run the writes already executed, so echoing
    // every call's full args back is pure waste that overflows the 100k result cap on a large
    // batch (e.g. 600+ set_priority calls) — even when the script's own `summary` is tiny — and
    // forces the agent to split one logical write across many code:run calls. shapeMutationEcho
    // swaps it for a compact { count, byTool } summary on a committing run.
    // WI-7061: annotate AFTER shapeMutationEcho, never inside it — that function returns early
    // when the script planned no mutations, which is exactly the read-only case whose failed
    // child call had no naming signal at all.
    // D-019/P-027: media is an MCP content-item variant, not part of P-006's JSON envelope.
    // Keep it out of the serialized text payload (which would duplicate the base64 and charge
    // context twice); append only the orchestrator's validated final blocks below.
    const {
      media,
      callRecords: traceOnlyCallRecords,
      replayProof,
      ...resultForPayload
    } = result;
    void traceOnlyCallRecords;
    const shownResult = shapeCodeRunSummary(
      shapeCodeRunLogs(
        annotateChildFailureWarning(
          shapeMutationEcho(annotatePublicCodeRunStatus(resultForPayload)),
        ),
      ),
    );

    const similarRecipePayload = similarRecipes.length > 0 ? shapeCodeRunSimilarRecipes(similarRecipes) : {};
    const payload =
      similarRecipes.length > 0 || facadeHelp || fieldMissHelp || sleepCapHelp
        ? {
            ...shownResult,
            ...similarRecipePayload,
            ...(facadeHelp ? { facadeHelp } : {}),
            ...(fieldMissHelp ? { fieldMissHelp } : {}),
            ...(sleepCapHelp ? { sleepCapHelp } : {}),
          }
        : shownResult;

    // EI-10892 (fleet telemetry half). The MCP handler already tells THIS agent, in
    // THIS response, when its script returned `ok:true` with every field blank — a
    // mis-mapped response shape. But an advisory only the caller sees cannot be
    // counted, so the dominant waste mode in the system stayed invisible fleet-wide:
    // the tool-efficiency panel grades hard failures (limit-rejections), code:run
    // adoption, and orient-dedup — every one of which reports HEALTHY while a fleet
    // burns round-trips on ok-but-empty results. You cannot fix what you cannot see.
    //
    // So stamp the detection into tool_invocations.metadata_json, the general-purpose
    // per-invocation metadata column that already exists (memory:search stamps its hit
    // `count` through this same ctx.metadata seam — no migration, no new table). The
    // empty-result-rate read/grade module aggregates it into a 4th panel axis.
    //
    // Detected HERE rather than reusing the handler's result because this is the one
    // place the payload is still a live object — the handler has to JSON.parse its own
    // response text to see it, and it cannot reach ctx.metadata (it never records the
    // invocation; the dispatch layer does). Same pure detector, same input, so the two
    // call sites cannot disagree.
    const invocationMetadata: Record<string, unknown> = {};
    try {
      const body = (payload as { summary?: unknown }).summary ?? payload;
      // toolsUsed only enriches the agent-facing message text, which the stamp does
      // not use — so pass none, exactly as the handler does.
      const hint = maybeEmptyMappingHint(body, []);
      if (hint) {
        invocationMetadata[EMPTY_MAPPING_METADATA_KEY] = {
          rows: hint.rows,
          blankRows: hint.blankRows,
        };
      }
    } catch {
      // Telemetry is never allowed to fail a run that otherwise succeeded.
    }

    const childFailureRefs = [
      ...new Set([...(result.childFailures ?? []).map((failure) => failure.tool), ...(result.unknownRefs ?? [])]),
    ];
    const childFailureCount =
      (result.childFailures?.length ?? 0) + (!result.ok && childFailureRefs.length === 0 ? 1 : 0);
    // P-008: one telemetry vocabulary for every orchestration run. These are
    // measured at the last pre-door point; result-door backfills the two
    // output fields when it later projects/spills the response.
    invocationMetadata.backend = 'server';
    invocationMetadata.toolCalls = 1 + (result.dispatchCount ?? 0);
    invocationMetadata.intermediateBytes = result.intermediateBytes ?? 0;
    invocationMetadata.returnedContextBytes = codeRunReturnedContextBytes(payload, media);
    invocationMetadata.spilledBytes = 0;
    invocationMetadata.durationMs = Math.max(0, Date.now() - runStartedAtMs);
    invocationMetadata.failureClass = codeRunFailureClass(result);
    invocationMetadata.recipeCapture = recipeCapture ? 'captured' : 'not-captured';
    invocationMetadata.recipeReuse = recipeCapture?.disposition !== undefined && recipeCapture.disposition !== 'created';
    invocationMetadata.recipeCacheHit = recipeCapture?.disposition === 'exact-fingerprint-reuse';
    invocationMetadata.recipeCandidateCount = similarRecipes.length;
    if (recipeCapture) {
      invocationMetadata.recipeId = recipeCapture.id;
      invocationMetadata.recipeRevision = recipeCapture.revision;
      invocationMetadata.recipeCaptureDisposition = recipeCapture.disposition;
    }
    invocationMetadata.effectiveStatus = !result.ok
      ? 'error'
      : result.partial || childFailureCount > 0
        ? 'partial'
        : 'ok';
    invocationMetadata.childFailureCount = childFailureCount;
    if (childFailureRefs.length > 0) invocationMetadata.childFailureRefs = childFailureRefs;
    // P-012 (census double-count): each inner dispatch wrote its OWN telemetry row, so
    // when the script dispatched anything this row is wrapper overhead — mark it so
    // tool_name censuses exclude it by default. A zero-dispatch run (pure compute) is
    // NOT a wrapper occurrence and stays countable, which is why this keys off the
    // orchestrator's dispatchCount rather than the tool name.
    const wrapperMark =
      (result.dispatchCount ?? 0) > 0
        ? await runPostprocessing('dispatch wrapper marker', () => dispatchWrapperMarkEnabled(), false)
        : null;
    if ((result.dispatchCount ?? 0) > 0 && wrapperMark?.value) {
      invocationMetadata[DISPATCH_WRAPPER_METADATA_KEY] = true;
      invocationMetadata.dispatchedToolCalls = result.dispatchCount;
    }
    ctx.metadata?.(invocationMetadata);

    const existingMeta = (result as OrchestrationRunResult & { _meta?: Record<string, unknown> })._meta;
    const responseMeta = {
      ...(existingMeta ?? {}),
      ...(replayProof ? { [CODE_RUN_REPLAY_PROOF_META_KEY]: replayProof } : {}),
    };

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(payload) }, ...(media ?? [])],
      ...(Object.keys(responseMeta).length > 0 ? { _meta: responseMeta } : {}),
    } as unknown as ToolResult;
  },
});

type OrchestrationRunResult = Awaited<ReturnType<typeof runToolOrchestration>>;

type RecipeCaptureTool = {
  effect?: string;
  expose?: { mcp?: { name?: string } };
};

/**
 * Recipe capture may proceed after a read-only semantic diagnostic: the script itself ran to
 * completion and the recipe remains useful for the next invocation. Write-effect semantic
 * rejections, thrown children, and unknown references remain capture blockers because they make
 * replay unsafe or leave the script's behavior unverified.
 */
export function isRecipeCaptureEligible(
  result: Pick<OrchestrationRunResult, 'ok' | 'unknownRefs' | 'childFailures'>,
  tools: readonly RecipeCaptureTool[],
): boolean {
  if (!result.ok || result.unknownRefs?.length) return false;

  const readTools = new Set(
    tools
      .filter((tool) => tool.effect === 'read')
      .map((tool) => tool.expose?.mcp?.name)
      .filter((name): name is string => typeof name === 'string'),
  );
  return (result.childFailures ?? []).every((failure) => failure.kind === 'semantic' && readTools.has(failure.tool));
}

/**
 * WI-40896 fault 2: capture must not certify what execution permanently refuses.
 *
 * `isRecipeCaptureEligible` above asks "did this RUN go well enough to reuse?" and
 * never consults authority — so a script whose authority cannot be resolved (an
 * opaque `dev:pg_query`, a dynamically-dispatched `tools:invoke`) was captured as a
 * reusable recipe and then accumulated run/success counts, even though `recipes:run`
 * refuses it with `authority_unresolved` EVERY time. That refusal is documented as
 * PERMANENT — "no proof, nested or top-level, can ever fix it" — so those success
 * counts certify a recipe that can never be run once (EI-20480783262024773 is a
 * reported instance: a saved recipe that recipes:run permanently refuses).
 *
 * This is deliberately a SEPARATE predicate rather than a clause inside
 * `isRecipeCaptureEligible`: that one is sync, never receives the script, and is
 * covered by tests that should keep passing unchanged. Authority derivation is
 * async, so the gate belongs at the async capture site.
 *
 * FAILS CLOSED if derivation THROWS, because the invariant being restored is
 * "capture agrees with execution", and execution also fails closed there. Skipping
 * capture is safe — the run still returns normally and records a trace-only row.
 *
 * Note what this does NOT do: a syntactically broken script does not throw and is
 * not reported unresolved (it parses to zero tool calls, so nothing is unprovable)
 * — it comes back resolvable. That is correct here, because such a script's run
 * fails and `isRecipeCaptureEligible`'s `result.ok` check already rejects it
 * upstream. This predicate answers only "can this script's authority be proven?",
 * never "did this script work?" — keep the two questions separate.
 */
export async function isRecipeCaptureAuthorityEligible(script: string): Promise<boolean> {
  try {
    return !(await deriveRecipeAuthority(script)).unresolved;
  } catch {
    return false;
  }
}

interface CodeRunRecipeCapture {
  id: string;
  revision: string;
  disposition: RecipeCaptureDisposition;
  similarRecipes: SimilarRecipe[];
}

/** Exact context-bearing bytes before the shared result door runs. Text is
 * already the serialized authored payload; media contributes its base64 data,
 * matching result-door's source-byte accounting without logging content. */
export function codeRunReturnedContextBytes(
  payload: unknown,
  media: ReadonlyArray<{ data?: unknown }> | undefined,
): number {
  let bytes = Buffer.byteLength(JSON.stringify(payload) ?? '', 'utf8');
  for (const item of media ?? []) {
    if (typeof item.data === 'string') bytes += Buffer.byteLength(item.data, 'utf8');
  }
  return bytes;
}

export function codeRunFailureClass(result: {
  ok: boolean;
  partial?: boolean;
  error?: string;
  childFailures?: Array<{ kind: string }>;
}): string | null {
  if (result.ok && !result.partial && !result.childFailures?.length) return null;
  if (result.partial || result.childFailures?.length) {
    const kinds = new Set(result.childFailures?.map((failure) => failure.kind) ?? []);
    if (kinds.has('uncertain')) return 'child-uncertain';
    if (kinds.has('rejected')) return 'child-rejected';
    return 'child-semantic';
  }
  const error = result.error ?? '';
  if (/timeout/i.test(error)) return 'timeout';
  if (error.startsWith('invalid_media_result:')) return 'invalid-output';
  return 'script-error';
}

const DRY_RUN_MUTATION_PREVIEW_CHAR_BUDGET = 20_000;
const DRY_RUN_MUTATION_SAMPLE_LIMIT = 12;
const DRY_RUN_MUTATION_SAMPLE_PER_TOOL_LIMIT = 3;
const CODE_RUN_LOG_LINE_LIMIT = 80;
const CODE_RUN_LOG_LINE_CHAR_BUDGET = 1_000;
/**
 * The result-door budget is shared by the whole code:run response, including the script's
 * summary. Keep the advisory recipe fold at the same small default as coord:orient. The exact
 * authority proof remains available in runArgs; description/toolsUsed and the duplicate top-level
 * authority are discovery metadata that recipes:get / recipes:run do not need here.
 */
const CODE_RUN_SIMILAR_RECIPE_LIMIT = 3;
const CODE_RUN_RECIPE_TITLE_CAP = 120;

export function shapeCodeRunSimilarRecipes(recipes: readonly SimilarRecipe[]): {
  similarRecipes: Array<{
    id: string;
    title: string;
    runCount: number;
    similarity: number;
    authorityRefs: SimilarRecipe['authorityRefs'];
    runArgs: SimilarRecipe['runArgs'];
  }>;
  similarRecipesTruncated?: {
    shown: number;
    truncatedByLimit: true;
    limit: number;
    more: string;
  };
} {
  const shown = recipes.slice(0, CODE_RUN_SIMILAR_RECIPE_LIMIT).map((recipe) => ({
    id: recipe.id,
    title:
      recipe.title.length > CODE_RUN_RECIPE_TITLE_CAP
        ? `${recipe.title.slice(0, CODE_RUN_RECIPE_TITLE_CAP - 1)}…`
        : recipe.title,
    runCount: recipe.runCount,
    similarity: recipe.similarity,
    authorityRefs: recipe.authorityRefs,
    runArgs: recipe.runArgs,
  }));

  return {
    similarRecipes: shown,
    ...(recipes.length > shown.length
      ? {
          similarRecipesTruncated: {
            shown: shown.length,
            truncatedByLimit: true as const,
            limit: CODE_RUN_SIMILAR_RECIPE_LIMIT,
            more: 'recipes:search { query, limit } for more matches; recipes:get { id } for a full recipe',
          },
        }
      : {}),
  };
}

const ANSI_OSC_PATTERN = /\x1B\][\s\S]*?(?:\x07|\x1B\\)/g;
const ANSI_CSI_PATTERN = /\x1B\[[0-?]*[ -/]*[@-~]/g;
const ANSI_SINGLE_PATTERN = /\x1B[@-Z\\-_]|\x9B[0-?]*[ -/]*[@-~]/g;
const CONTROL_PATTERN = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g;

interface CodeRunLogsNotice {
  rawCount: number;
  shownCount: number;
  adjacentDuplicatesCollapsed: number;
  sanitizedLines: number;
  truncatedLines: number;
  droppedAfterLimit: number;
  note: string;
}

/**
 * WI-3127: the code:run sandbox does not expose require/process, so a script cannot shell out
 * with execSync. It can still write arbitrary console text, and that text is serialized back in
 * the agent-facing `logs` field. Shape that side channel here: strip terminal/control noise and
 * bound repetitive or oversized logs. The script's returned summary is bounded separately by
 * `shapeCodeRunSummary` below.
 */
// The constraint is `{ logs?: unknown }` — exactly what this function reads — and NOT
// `Record<string, unknown>`. Since runToolOrchestration moved to @papercusp/tooldef, its
// return is the declared interface `OrchestrateResult`, and a plain interface has no index
// signature, so it is not assignable to Record<string, unknown> even though every field is
// known. Demanding the record here therefore rejected the one caller that matters
// (shapeMutationEcho's union) with TS2345. Constrain to the shape actually used.
export function shapeCodeRunLogs<T extends { logs?: unknown }>(
  result: T,
): T | (T & { logs: string[]; logsNotice: CodeRunLogsNotice }) {
  const logs = result.logs;
  if (!Array.isArray(logs)) return result;

  let sanitizedLines = 0;
  let truncatedLines = 0;
  let adjacentDuplicatesCollapsed = 0;
  const normalized = logs.map((entry) => {
    const raw = typeof entry === 'string' ? entry : String(entry);
    const sanitized = sanitizeCodeRunLogLine(raw);
    if (sanitized !== raw) sanitizedLines++;
    if (sanitized.length <= CODE_RUN_LOG_LINE_CHAR_BUDGET) return sanitized;
    truncatedLines++;
    return (
      sanitized.slice(0, CODE_RUN_LOG_LINE_CHAR_BUDGET) +
      `... [truncated ${sanitized.length - CODE_RUN_LOG_LINE_CHAR_BUDGET} chars]`
    );
  });

  const deduped: string[] = [];
  let previous: string | undefined;
  let repeatCount = 0;
  const flush = () => {
    if (previous === undefined) return;
    deduped.push(previous);
    if (repeatCount > 1) {
      const collapsed = repeatCount - 1;
      adjacentDuplicatesCollapsed += collapsed;
      deduped.push(`[previous code:run log line repeated ${collapsed} more time${collapsed === 1 ? '' : 's'}]`);
    }
  };
  for (const line of normalized) {
    if (line === previous) {
      repeatCount++;
      continue;
    }
    flush();
    previous = line;
    repeatCount = 1;
  }
  flush();

  const limited = deduped.slice(0, CODE_RUN_LOG_LINE_LIMIT);
  const droppedAfterLimit = Math.max(0, deduped.length - limited.length);
  if (sanitizedLines === 0 && truncatedLines === 0 && adjacentDuplicatesCollapsed === 0 && droppedAfterLimit === 0) {
    return result;
  }

  return {
    ...result,
    logs: limited,
    logsNotice: {
      rawCount: logs.length,
      shownCount: limited.length,
      adjacentDuplicatesCollapsed,
      sanitizedLines,
      truncatedLines,
      droppedAfterLimit,
      note: 'code:run logs were shaped to keep terminal noise bounded; the script return value in `summary` is unchanged',
    },
  };
}

function sanitizeCodeRunLogLine(raw: string): string {
  return raw
    .replace(ANSI_OSC_PATTERN, '')
    .replace(ANSI_CSI_PATTERN, '')
    .replace(ANSI_SINGLE_PATTERN, '')
    .replace(/[\r\n]+/g, ' ')
    .replace(CONTROL_PATTERN, '');
}

/**
 * EI-21163938645109933 / EI-21164455886001541: both were filed as "false field-miss flags", but
 * the flags were TRUE — the fields really were absent. What was wrong is that a MISSPELLED field
 * and a probe of a legitimately-OPTIONAL field were reported with the same warning, so the signal
 * this detector exists for (a silent undefined from a typo) arrived buried in unactionable noise.
 * Split them: a read that resembles an available key is a correction worth acting on; one that
 * resembles nothing on the shape is almost always an optional field that is simply not set here,
 * and the useful advice there is to branch on PRESENCE rather than on a falsy value — which is
 * exactly the trap in `if (!q.ok)` against a result whose success shape omits `ok` entirely.
 * Misses carrying no `likely` (produced before the classification existed) render as corrections.
 */
export function shapeFieldMissHelp(misses: readonly FieldMiss[] | undefined): string | undefined {
  if (!misses?.length) return undefined;

  const optional = misses.filter((m) => m.likely === 'optional-field');
  const corrections = misses.filter((m) => m.likely !== 'optional-field');
  const lines: string[] = [];

  if (corrections.length) {
    lines.push(
      `⚠ ${corrections.length} read(s) of a field the tool result does NOT have — the value you got was undefined, ` +
        `which a \`?? null\` / \`?? 0\` fallback turns into a real-looking value. Check these before trusting the summary:`,
    );
    for (const m of corrections) {
      const suggestion = m.didYouMean ? ` — did you mean \`${m.didYouMean}\`?` : '';
      lines.push(
        `  • ${m.tool} → read \`${m.read}\` on ${m.path}${suggestion}, which has: ${m.available.join(', ') || '(no keys)'}`,
      );
    }
  }

  if (optional.length) {
    lines.push(
      `ℹ ${optional.length} read(s) of a field absent from this result shape and close to none of its keys — usually an ` +
        `OPTIONAL field that is simply not set here. Branch on presence (\`'k' in r\`), not on a falsy value: a shape that ` +
        `omits the key on success makes \`if (!r.k)\` treat every success as a failure.`,
    );
    for (const m of optional) {
      lines.push(
        `  • ${m.tool} → read \`${m.read}\` on ${m.path}, which has: ${m.available.join(', ') || '(no keys)'}`,
      );
    }
  }

  return lines.join('\n');
}

export const CODE_RUN_SUMMARY_CHAR_BUDGET = 3_500;
const CODE_RUN_SUMMARY_PROJECTION_STEPS = [
  { arrayLimit: 8, stringChars: 360, maxDepth: 4 },
  { arrayLimit: 4, stringChars: 220, maxDepth: 3 },
  { arrayLimit: 2, stringChars: 120, maxDepth: 2 },
] as const;
const CODE_RUN_SUMMARY_FALLBACK_STRING_CHARS = 80;
const CODE_RUN_SUMMARY_PATH_LIMIT = 16;

// EI-22572881407380085: release:trace is a deliberately wide diagnostic envelope. A common
// code:run summary is `Promise.all([...release:trace])`, where every row carries a distinct target
// SHA plus authoritative gate/parity/next-verb fields. The generic depth/array ladder can spend
// its whole budget on the first rows' incidental detail and drop the later identities. Keep a
// compact, path-independent identity projection for that specific row shape; ordinary arrays keep
// their historical prefix behavior.
const CODE_RUN_RELEASE_TRACE_ROW_KEYS = [
  'ok',
  'generatedAtMs',
  'target',
  'gate',
  'greenPin',
  'deploy',
  'testedDeployedParity',
  'nextVerb',
  'constraints',
  'awaits',
  'staleWake',
  'resync',
  'repairQueue',
  'repairQueueRead',
  'trace',
  'summary',
  'error',
  'subject',
  'harnessMismatch',
  'plane',
] as const;
const CODE_RUN_RELEASE_TRACE_TARGET_KEYS = ['path', 'sha'] as const;
const CODE_RUN_RELEASE_TRACE_GATE_KEYS = [
  'state',
  'status',
  'authoritative',
  'consecutiveReds',
  'failingTests',
  'failingTestsMeasured',
  'failingTestsCarriedForward',
  'recordedVerdict',
  'observedCandidate',
  'fixCommitContainment',
  'inconclusive',
  'redOwner',
  'checkpointRunInFlight',
] as const;
const CODE_RUN_RELEASE_TRACE_NEXT_VERB_KEYS = ['name', 'args', 'reason'] as const;
const CODE_RUN_RELEASE_TRACE_MIN_ROWS = 3;

export interface CodeRunSummaryNotice {
  truncated: true;
  originalChars: number;
  returnedChars: number;
  arraysTruncated: number;
  stringsTruncated: number;
  valuesTruncated: number;
  omittedItems: number;
  paths: string[];
  note: string;
}

interface CodeRunSummaryProjectionStats {
  arraysTruncated: number;
  stringsTruncated: number;
  valuesTruncated: number;
  omittedItems: number;
  paths: string[];
}

interface CodeRunSummaryProjectionOptions {
  arrayLimit: number;
  stringChars: number;
  maxDepth: number;
}

function codeRunSummarySerializedChars(value: unknown): number {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === 'string' ? serialized.length : 0;
  } catch {
    return String(value).length;
  }
}

function isCodeRunSummaryRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCodeRunSummaryScalar(value: unknown): boolean {
  return value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string';
}

function codeRunSummaryOmittedValue(): Record<string, string> {
  return { __truncated: 'nested value omitted; see summaryNotice.paths' };
}

// EI-22796173621053064: bounded evidence/result arrays must retain the lines that explain a
// failure. Their usual shape is a long PASS prefix followed by a FAIL/result/verdict suffix, so
// a plain prefix slice can make a failed run look healthy. Keep this selector path-scoped: other
// arrays remain byte-for-byte prefix projections, while diagnostic arrays get a few high-signal
// entries and then fill the remaining slots from the original prefix.
const CODE_RUN_SUMMARY_SIGNAL_ARRAY_PATH = /(?:^|\.)evidence(?:\.|$)|(?:^|\.)(?:result|results|failure|failures|verdict|diagnostic|diagnostics)(?:\.|$)/i;
const CODE_RUN_SUMMARY_FAILURE_MARKER =
  /(?:^|[^a-z0-9])(?:fail(?:ed|ure)?|error|exception|fatal|blocked|timeout|timed[-_ ]?out|non[-_ ]?zero)(?:$|[^a-z0-9])|(?:^|[^a-z0-9])(?:ok|success)\s*[:=]\s*false\b/i;
const CODE_RUN_SUMMARY_RESULT_MARKER =
  /(?:^|[^a-z0-9])(?:verdict|result|overall|outcome)(?:$|[^a-z0-9])|(?:^|[^a-z0-9])(?:exit(?:ed)?|status)\s*[:=]\s*(?:[1-9]|fail|error)\b/i;

function codeRunSummaryEntryText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!isCodeRunSummaryRecord(value)) return '';

  const signalFields = ['text', 'message', 'error', 'failure', 'result', 'verdict', 'status', 'state', 'output'];
  return signalFields
    .map((key) => value[key])
    .filter((entry): entry is string => typeof entry === 'string')
    .join(' ');
}

function codeRunSummaryEntryPriority(value: unknown): number {
  const text = codeRunSummaryEntryText(value);
  if (!text) return 0;

  let priority = 0;
  if (CODE_RUN_SUMMARY_FAILURE_MARKER.test(text)) priority += 3;
  if (CODE_RUN_SUMMARY_RESULT_MARKER.test(text)) priority += 4;
  return priority;
}

function codeRunSummaryArrayIndices(value: unknown[], path: string, limit: number): number[] {
  const prefix = Array.from({ length: Math.min(value.length, limit) }, (_, index) => index);
  if (value.length <= limit || !CODE_RUN_SUMMARY_SIGNAL_ARRAY_PATH.test(path)) return prefix;

  const prioritized = value
    .map((entry, index) => ({ index, priority: codeRunSummaryEntryPriority(entry) }))
    .filter(({ priority }) => priority > 0)
    .sort((left, right) => right.priority - left.priority || left.index - right.index)
    .slice(0, limit)
    .map(({ index }) => index);
  if (prioritized.length === 0) return prefix;

  const selected = new Set(prioritized);
  for (const index of prefix) {
    if (selected.size >= limit) break;
    selected.add(index);
  }
  return [...selected].sort((left, right) => left - right);
}

function codeRunReleaseTraceRow(value: unknown): Record<string, unknown> | undefined {
  if (!isCodeRunSummaryRecord(value)) return undefined;
  const target = value.target;
  const isTargeted = isCodeRunSummaryRecord(target) && typeof target.sha === 'string';
  if (!isTargeted) return undefined;

  // The normal release:trace result has `gate`; its bounded timeout response has `error`.
  // Accept both so a mixed Promise.all still keeps every target identity visible.
  if (!isCodeRunSummaryRecord(value.gate) && !isCodeRunSummaryRecord(value.error)) return undefined;
  return value;
}

function projectCodeRunReleaseTraceObject(
  value: Record<string, unknown>,
  keys: readonly string[],
  path: string,
  options: CodeRunSummaryProjectionOptions,
  stats: CodeRunSummaryProjectionStats,
): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  const keep = new Set(keys);
  for (const key of keys) {
    if (!(key in value)) continue;
    projected[key] = projectCodeRunSummaryValue(
      value[key],
      `${path}.${key}`,
      0,
      {
        ...options,
        // One bounded nested object per selected authority is enough to retain its identity and
        // scalar verdicts without allowing one verbose reason/await list to crowd out later rows.
        maxDepth: Math.min(options.maxDepth, 2),
        arrayLimit: Math.max(options.arrayLimit, CODE_RUN_RELEASE_TRACE_MIN_ROWS),
      },
      stats,
    );
  }
  const omitted = Object.keys(value).filter((key) => !keep.has(key));
  if (omitted.length > 0) {
    stats.valuesTruncated += omitted.length;
    stats.omittedItems += omitted.length;
    noteCodeRunSummaryPath(stats, path);
  }
  return projected;
}

function projectCodeRunReleaseTraceRow(
  value: Record<string, unknown>,
  path: string,
  options: CodeRunSummaryProjectionOptions,
  stats: CodeRunSummaryProjectionStats,
): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  const keep: ReadonlySet<string> = new Set(CODE_RUN_RELEASE_TRACE_ROW_KEYS);
  for (const key of CODE_RUN_RELEASE_TRACE_ROW_KEYS) {
    if (!(key in value)) continue;
    const entry = value[key];
    if (key === 'target' && isCodeRunSummaryRecord(entry)) {
      projected[key] = projectCodeRunReleaseTraceObject(
        entry,
        CODE_RUN_RELEASE_TRACE_TARGET_KEYS,
        `${path}.${key}`,
        options,
        stats,
      );
    } else if (key === 'gate' && isCodeRunSummaryRecord(entry)) {
      projected[key] = projectCodeRunReleaseTraceObject(
        entry,
        CODE_RUN_RELEASE_TRACE_GATE_KEYS,
        `${path}.${key}`,
        options,
        stats,
      );
    } else if (key === 'nextVerb' && isCodeRunSummaryRecord(entry)) {
      projected[key] = projectCodeRunReleaseTraceObject(
        entry,
        CODE_RUN_RELEASE_TRACE_NEXT_VERB_KEYS,
        `${path}.${key}`,
        options,
        stats,
      );
    } else {
      projected[key] = projectCodeRunSummaryValue(
        entry,
        `${path}.${key}`,
        0,
        {
          ...options,
          maxDepth: Math.min(options.maxDepth, 2),
          arrayLimit: Math.max(options.arrayLimit, CODE_RUN_RELEASE_TRACE_MIN_ROWS),
        },
        stats,
      );
    }
  }
  const omitted = Object.keys(value).filter((key) => !keep.has(key));
  if (omitted.length > 0) {
    stats.valuesTruncated += omitted.length;
    stats.omittedItems += omitted.length;
    noteCodeRunSummaryPath(stats, path);
  }
  return projected;
}

function projectCodeRunReleaseTraceArray(
  value: unknown[],
  path: string,
  options: CodeRunSummaryProjectionOptions,
  stats: CodeRunSummaryProjectionStats,
): unknown[] | undefined {
  const rows = value.map(codeRunReleaseTraceRow);
  if (value.length === 0 || rows.some((row) => row === undefined)) return undefined;

  // Keep at least three rows: the reported triage flow compares frozen, observed, and repair
  // heads, and the third row is exactly the one the generic array rung used to discard.
  const limit = Math.max(options.arrayLimit, CODE_RUN_RELEASE_TRACE_MIN_ROWS);
  const indices = codeRunSummaryArrayIndices(value, path, limit);
  const projected = indices.map((index) =>
    projectCodeRunReleaseTraceRow(rows[index] as Record<string, unknown>, `${path}[${index}]`, options, stats),
  );
  if (value.length > limit) {
    stats.arraysTruncated++;
    stats.omittedItems += value.length - limit;
    noteCodeRunSummaryPath(stats, path);
  }
  return projected;
}

function noteCodeRunSummaryPath(stats: CodeRunSummaryProjectionStats, path: string): void {
  if (stats.paths.length < CODE_RUN_SUMMARY_PATH_LIMIT && !stats.paths.includes(path)) {
    stats.paths.push(path);
  }
}

/**
 * EI-21254588525256811: head-only clipping destroys the one property a caller who wrote
 * `checkpoint.slice(-5000)` was relying on — that the END of the value survives. Keeping both ends
 * costs the same bytes and is strictly more informative, so clip out of the MIDDLE once there is
 * enough room for two useful segments; below that the elision marker would dominate, so the
 * historical head-only form is kept.
 */
const CODE_RUN_SUMMARY_ELISION_MIN_CHARS = 240;

function clipCodeRunSummaryString(
  value: string,
  path: string,
  maxChars: number,
  stats: CodeRunSummaryProjectionStats,
): string {
  if (value.length <= maxChars) return value;
  stats.stringsTruncated++;
  stats.omittedItems += value.length - maxChars;
  noteCodeRunSummaryPath(stats, path);

  if (maxChars >= CODE_RUN_SUMMARY_ELISION_MIN_CHARS) {
    // Size the kept span against the WIDEST marker this value could produce, so the result is
    // guaranteed to fit `maxChars` without a second pass over a marker whose digit count depends
    // on the very number it reports.
    const keep = maxChars - `… [truncated ${value.length} chars] …`.length;
    if (keep >= 2) {
      const head = Math.ceil(keep / 2);
      const tail = keep - head;
      const marker = `… [truncated ${value.length - keep} chars] …`;
      return value.slice(0, head) + marker + (tail > 0 ? value.slice(value.length - tail) : '');
    }
  }

  const suffix = `… [truncated ${value.length - maxChars} chars]`;
  if (suffix.length >= maxChars) return value.slice(0, maxChars);
  return value.slice(0, maxChars - suffix.length) + suffix;
}

// EI-21238514286678666: a raw MCP tool result is commonly nested under a code:run
// summary row as `{ content: [{ type: 'text', text: '...' }] }`. When the summary
// needs the more aggressive projection rung, that envelope lands exactly at the
// depth boundary and the old projector replaced it with `{}`. In particular,
// capability:inspect's background launch handles live inside the text block, so
// dropping the envelope makes a successfully-started job impossible to reattach.
const CODE_RUN_SUMMARY_HANDLE_KEYS = new Set(['bash_id', 'task_id']);
const CODE_RUN_SUMMARY_HANDLE_CONTEXT_KEYS = new Set(['ok', 'status', 'state', 'reason', 'error']);

function projectCodeRunSummaryTextContent(
  value: unknown,
  path: string,
  options: CodeRunSummaryProjectionOptions,
  stats: CodeRunSummaryProjectionStats,
): unknown[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const indices = codeRunSummaryArrayIndices(value, path, options.arrayLimit);
  const projected: unknown[] = [];
  let hasText = false;
  for (const index of indices) {
    const entry = value[index];
    if (!isCodeRunSummaryRecord(entry) || typeof entry.text !== 'string') continue;
    hasText = true;
    const text = clipCodeRunSummaryString(entry.text, `${path}[${index}].text`, options.stringChars, stats);
    const item: Record<string, unknown> = { text };
    if (typeof entry.type === 'string') item.type = entry.type;
    projected.push(item);
  }
  if (!hasText) return undefined;
  if (value.length > options.arrayLimit) {
    stats.arraysTruncated++;
    stats.omittedItems += value.length - options.arrayLimit;
    noteCodeRunSummaryPath(stats, path);
  }
  return projected;
}

function projectCodeRunSummaryDepthBoundary(
  value: unknown,
  path: string,
  options: CodeRunSummaryProjectionOptions,
  stats: CodeRunSummaryProjectionStats,
): unknown | undefined {
  if (Array.isArray(value)) {
    return projectCodeRunSummaryBoundaryArray(value, path, options, stats);
  }
  if (!isCodeRunSummaryRecord(value)) return undefined;

  const projected: Record<string, unknown> = {};
  let omittedFields = 0;
  for (const [key, entry] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key;
    // EI-21382842145185659: ordinary nested records (for example rows returned by
    // dev:pg_query) are DATA, not MCP launch handles. The old handle-context
    // whitelist kept only `status`, so a large row batch silently changed from
    // `{ id, invoked_at, tool_name, status, ... }` to `{ status }`. Preserve every
    // scalar field at the boundary, while still clipping strings and leaving nested
    // values to the specialized `content` handling below.
    if (isCodeRunSummaryScalar(entry)) {
      projected[key] =
        typeof entry === 'string'
          ? clipCodeRunSummaryString(entry, childPath, options.stringChars, stats)
          : entry;
      continue;
    }

    // A depth-boundary record still needs to expose bounded prefixes of ordinary
    // nested arrays. Returning [] for a non-empty array makes a pending collection
    // look like a complete empty result (EI-21972587349695167). Keep non-array
    // records omitted here: the aggressive boundary intentionally preserves only
    // scalar fields (and array prefixes), which keeps nested payloads bounded.
    if (Array.isArray(entry)) {
      const boundaryProjection = projectCodeRunSummaryDepthBoundary(entry, childPath, options, stats);
      if (boundaryProjection !== undefined) projected[key] = boundaryProjection;
      else omittedFields++;
    } else {
      omittedFields++;
    }
  }
  if (omittedFields > 0) {
    projected.__truncated = 'nested value omitted; see summaryNotice.paths';
    stats.valuesTruncated += omittedFields;
    stats.omittedItems += omittedFields;
    noteCodeRunSummaryPath(stats, path);
  }
  return projected;
}

/**
 * Keep a truthful one-level prefix for every array that reaches a depth boundary.
 * `projectCodeRunSummaryTextContent` is deliberately specialized for MCP text
 * envelopes, but using it as the only array shape test turned ordinary arrays into
 * `[]` whenever their entries were not `{ text: string }` (EI-21972587349695167).
 */
function projectCodeRunSummaryBoundaryArray(
  value: unknown[],
  path: string,
  options: CodeRunSummaryProjectionOptions,
  stats: CodeRunSummaryProjectionStats,
): unknown[] {
  const content = projectCodeRunSummaryTextContent(value, path, options, stats);
  if (content !== undefined) {
    stats.valuesTruncated++;
    stats.omittedItems++;
    noteCodeRunSummaryPath(stats, path);
    return content;
  }

  // An actually empty array is already an unambiguous, complete value.
  if (value.length === 0) return [];

  const projected: unknown[] = [];
  const indices = codeRunSummaryArrayIndices(value, path, options.arrayLimit);
  for (const index of indices) {
    const entry = value[index];
    const entryPath = `${path}[${index}]`;
    if (isCodeRunSummaryScalar(entry)) {
      projected.push(
        typeof entry === 'string' ? clipCodeRunSummaryString(entry, entryPath, options.stringChars, stats) : entry,
      );
      continue;
    }

    const boundaryProjection = projectCodeRunSummaryDepthBoundary(entry, entryPath, options, stats);
    if (boundaryProjection !== undefined) {
      projected.push(boundaryProjection);
      continue;
    }

    // Preserve the fact that this array had an element even when that element's
    // shape contains no boundary-safe scalar fields. The notice/path remains the
    // authoritative disclosure of what was omitted.
    projected.push(Array.isArray(entry) ? [null] : codeRunSummaryOmittedValue());
    stats.valuesTruncated++;
    stats.omittedItems++;
    noteCodeRunSummaryPath(stats, entryPath);
  }
  if (value.length > options.arrayLimit) {
    stats.arraysTruncated++;
    stats.omittedItems += value.length - options.arrayLimit;
    noteCodeRunSummaryPath(stats, path);
  }
  return projected;
}

function projectCodeRunSummaryValue(
  value: unknown,
  path: string,
  depth: number,
  options: CodeRunSummaryProjectionOptions,
  stats: CodeRunSummaryProjectionStats,
): unknown {
  if (typeof value === 'string') {
    return clipCodeRunSummaryString(value, path, options.stringChars, stats);
  }
  if (isCodeRunSummaryScalar(value)) return value;

  if (Array.isArray(value)) {
    const releaseTraceProjection = projectCodeRunReleaseTraceArray(value, path, options, stats);
    if (releaseTraceProjection !== undefined) return releaseTraceProjection;
  }

  if (depth >= options.maxDepth) {
    const boundaryProjection = projectCodeRunSummaryDepthBoundary(value, path, options, stats);
    if (boundaryProjection !== undefined) return boundaryProjection;
    stats.valuesTruncated++;
    stats.omittedItems++;
    noteCodeRunSummaryPath(stats, path);
    return Array.isArray(value) ? [codeRunSummaryOmittedValue()] : codeRunSummaryOmittedValue();
  }

  if (Array.isArray(value)) {
    const shown = codeRunSummaryArrayIndices(value, path, options.arrayLimit).map((index) =>
      projectCodeRunSummaryValue(value[index], `${path}[${index}]`, depth + 1, options, stats),
    );
    if (value.length > options.arrayLimit) {
      stats.arraysTruncated++;
      stats.omittedItems += value.length - options.arrayLimit;
      noteCodeRunSummaryPath(stats, path);
    }
    return shown;
  }

  if (isCodeRunSummaryRecord(value)) {
    const projected: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      projected[key] = projectCodeRunSummaryValue(entry, path ? `${path}.${key}` : key, depth + 1, options, stats);
    }
    return projected;
  }

  return String(value);
}

function minimalCodeRunSummaryProjection(
  value: unknown,
  budget: number,
  stats: CodeRunSummaryProjectionStats,
): unknown {
  if (typeof value === 'string') {
    return clipCodeRunSummaryString(value, 'summary', Math.max(1, budget - 32), stats);
  }
  if (isCodeRunSummaryScalar(value)) return value;
  if (Array.isArray(value)) {
    // EI-21267600739763524: this used to `return []` — TOTAL data loss for a summary that is a
    // top-level array (the natural shape of a grep-context or row-scan result). Worse than
    // truncation: the caller got an EMPTY result whose own summaryNotice reported
    // `omittedItems: 0`, actively denying that anything had been cut. Keep a bounded prefix so
    // the caller still sees the shape of their data, and COUNT what did not fit.
    const projected: unknown[] = [];
    const entryStats: CodeRunSummaryProjectionStats[] = [];
    const entryOptions: CodeRunSummaryProjectionOptions = {
      arrayLimit: 1,
      stringChars: CODE_RUN_SUMMARY_FALLBACK_STRING_CHARS,
      maxDepth: 1,
    };
    for (const entry of value) {
      // Trial-project into scratch stats: an entry that does not fit is discarded, and its
      // truncation counters must not leak into the disclosure for entries we actually kept.
      const scratch = newCodeRunSummaryProjectionStats();
      const candidate = projectCodeRunSummaryValue(entry, `summary[${projected.length}]`, 0, entryOptions, scratch);
      if (codeRunSummarySerializedChars([...projected, candidate]) > budget) break;
      projected.push(candidate);
      entryStats.push(scratch);
    }
    const dropped = value.length - projected.length;
    if (dropped > 0) {
      stats.arraysTruncated++;
      stats.omittedItems += dropped;
      noteCodeRunSummaryPath(stats, 'summary');
    }
    // Keep the baseline prefix, then spend spare budget growing strings inside its retained
    // entries. This preserves array breadth while avoiding the fixed 80-character cap when it
    // would leave useful output space unused.
    for (let index = 0; index < projected.length; index++) {
      if (
        entryStats[index]?.stringsTruncated === 0 ||
        codeRunSummarySerializedChars(projected) >= budget * 0.9
      ) {
        continue;
      }
      const grown = growCodeRunSummaryToBudget(
        value[index],
        entryOptions,
        budget,
        `summary[${index}]`,
        (candidate) => projected.map((entry, entryIndex) => (entryIndex === index ? candidate : entry)),
      );
      if (grown) {
        projected[index] = grown.value;
        entryStats[index] = grown.stats;
      }
    }
    for (const scratch of entryStats) mergeCodeRunSummaryStats(stats, scratch);
    return projected;
  }
  if (!isCodeRunSummaryRecord(value)) return String(value);

  const projected: Record<string, unknown> = {};
  const retainedEntries: Array<{ key: string; value: unknown; stats: CodeRunSummaryProjectionStats }> = [];
  const entries = Object.entries(value);
  // Keep scalar marker fields first in the last-resort shape. These are the values a monitor
  // uses to interpret the bounded nested collection (markerCount, lineCount, etc.).
  for (const [key, entry] of entries.filter(([, candidate]) => isCodeRunSummaryScalar(candidate))) {
    const candidate =
      typeof entry === 'string'
        ? clipCodeRunSummaryString(entry, `summary.${key}`, CODE_RUN_SUMMARY_FALLBACK_STRING_CHARS, stats)
        : entry;
    const withCandidate = { ...projected, [key]: candidate };
    if (codeRunSummarySerializedChars(withCandidate) <= budget) {
      projected[key] = candidate;
    } else {
      stats.omittedItems++;
      noteCodeRunSummaryPath(stats, `summary.${key}`);
    }
  }
  for (const [key, entry] of entries.filter(([, candidate]) => !isCodeRunSummaryScalar(candidate))) {
    const scratch = newCodeRunSummaryProjectionStats();
    const entryOptions: CodeRunSummaryProjectionOptions = {
      arrayLimit: 1,
      stringChars: CODE_RUN_SUMMARY_FALLBACK_STRING_CHARS,
      maxDepth: 1,
    };
    const candidate = projectCodeRunSummaryValue(
      entry,
      `summary.${key}`,
      0,
      entryOptions,
      scratch,
    );
    const withCandidate = { ...projected, [key]: candidate };
    if (codeRunSummarySerializedChars(withCandidate) <= budget) {
      projected[key] = candidate;
      retainedEntries.push({ key, value: entry, stats: scratch });
    } else {
      stats.valuesTruncated++;
      stats.omittedItems++;
      noteCodeRunSummaryPath(stats, `summary.${key}`);
    }
  }
  // Preserve the minimal projection's field selection and ordering, then grow strings only in
  // fields that survived that selection. The remaining budget is measured against the whole
  // summary, so the last-resort shape uses its space without displacing retained marker fields.
  for (const retained of retainedEntries) {
    if (
      retained.stats.stringsTruncated === 0 ||
      codeRunSummarySerializedChars(projected) >= budget * 0.9
    ) {
      continue;
    }
    const grown = growCodeRunSummaryToBudget(
      retained.value,
      {
        arrayLimit: 1,
        stringChars: CODE_RUN_SUMMARY_FALLBACK_STRING_CHARS,
        maxDepth: 1,
      },
      budget,
      `summary.${retained.key}`,
      (candidate) => ({ ...projected, [retained.key]: candidate }),
    );
    if (grown) {
      projected[retained.key] = grown.value;
      retained.stats = grown.stats;
    }
  }
  for (const retained of retainedEntries) mergeCodeRunSummaryStats(stats, retained.stats);
  return projected;
}

function newCodeRunSummaryProjectionStats(): CodeRunSummaryProjectionStats {
  return { arraysTruncated: 0, stringsTruncated: 0, valuesTruncated: 0, omittedItems: 0, paths: [] };
}

/** Fold a trial projection's disclosure counters into the surviving ones once it is kept. */
function mergeCodeRunSummaryStats(
  target: CodeRunSummaryProjectionStats,
  source: CodeRunSummaryProjectionStats,
): void {
  target.arraysTruncated += source.arraysTruncated;
  target.stringsTruncated += source.stringsTruncated;
  target.valuesTruncated += source.valuesTruncated;
  target.omittedItems += source.omittedItems;
  for (const path of source.paths) noteCodeRunSummaryPath(target, path);
}

/**
 * EI-21254588525256811: the ladder below stops at the FIRST rung that fits, and its `stringChars`
 * rungs (360/220/120) are absolute constants with no relationship to CODE_RUN_SUMMARY_CHAR_BUDGET.
 * So a summary whose bytes are dominated by strings was returned at ~11% of the budget it was
 * entitled to: a caller who had ALREADY bounded the value themselves (`checkpoint.slice(-5000)`)
 * had that deliberate reduction silently re-cut to 360 chars, defeating the point of bounding it.
 *
 * Spend the budget: keep the fitting rung's array/depth decisions and grow `stringChars` to the
 * largest value that still fits. Serialized size is monotone in `stringChars` (a larger cap only
 * ever keeps more of each string), so a binary search finds that maximum in ~log2(budget) probes,
 * and only a candidate measured to fit is ever returned.
 */
function growCodeRunSummaryToBudget(
  summary: unknown,
  options: CodeRunSummaryProjectionOptions,
  budget: number,
  path = 'summary',
  wrapCandidate: (candidate: unknown) => unknown = (candidate) => candidate,
): { value: unknown; stats: CodeRunSummaryProjectionStats } | undefined {
  let best: { value: unknown; stats: CodeRunSummaryProjectionStats } | undefined;
  let low = options.stringChars + 1;
  let high = budget;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const stats = newCodeRunSummaryProjectionStats();
    const candidate = projectCodeRunSummaryValue(summary, path, 0, { ...options, stringChars: mid }, stats);
    if (codeRunSummarySerializedChars(wrapCandidate(candidate)) <= budget) {
      best = { value: candidate, stats };
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return best;
}

/**
 * EI-20981474230843769: bound the arbitrary value returned by a code:run script before the
 * generic result door sees it. A marker monitor commonly returns scalar counters alongside a
 * nested `lines` array; keep those counters, cap nested arrays/strings, and disclose every cut.
 * The identity fast path is intentional: summaries already below the budget remain
 * byte-identical to the historical code:run response.
 */
// `shapeMutationEcho` intentionally projects large dry-run results to a plain
// `Record<string, unknown>`. Keep that legacy projection in the accepted input
// shape so the result-door shaping chain remains type-safe after the projection.
export function shapeCodeRunSummary<T extends { summary?: unknown } | Record<string, unknown>>(
  result: T,
): T | (T & { summaryNotice: CodeRunSummaryNotice }) {
  const summary = result.summary;
  if (summary === undefined) return result;

  const originalChars = codeRunSummarySerializedChars(summary);
  if (originalChars <= CODE_RUN_SUMMARY_CHAR_BUDGET) return result;

  let projected: unknown;
  let stats = newCodeRunSummaryProjectionStats();
  for (const options of CODE_RUN_SUMMARY_PROJECTION_STEPS) {
    const candidateStats = newCodeRunSummaryProjectionStats();
    const candidate = projectCodeRunSummaryValue(summary, 'summary', 0, options, candidateStats);
    const candidateChars = codeRunSummarySerializedChars(candidate);
    if (candidateChars <= CODE_RUN_SUMMARY_CHAR_BUDGET) {
      // The search costs ~log2(budget) additional projections, so only pay for it when there is
      // headroom worth reclaiming. A candidate already near the budget has nothing to gain.
      const grown =
        candidateChars < CODE_RUN_SUMMARY_CHAR_BUDGET * 0.9
          ? growCodeRunSummaryToBudget(summary, options, CODE_RUN_SUMMARY_CHAR_BUDGET)
          : undefined;
      projected = grown?.value ?? candidate;
      stats = grown?.stats ?? candidateStats;
      break;
    }
  }

  if (projected === undefined) {
    stats = newCodeRunSummaryProjectionStats();
    projected = minimalCodeRunSummaryProjection(summary, CODE_RUN_SUMMARY_CHAR_BUDGET, stats);
  }

  const returnedChars = codeRunSummarySerializedChars(projected);
  return {
    ...result,
    summary: projected,
    summaryNotice: {
      truncated: true,
      originalChars,
      returnedChars,
      arraysTruncated: stats.arraysTruncated,
      stringsTruncated: stats.stringsTruncated,
      valuesTruncated: stats.valuesTruncated,
      omittedItems: stats.omittedItems,
      paths: stats.paths,
      note: 'code:run summary was bounded before transport; scalar marker fields are preserved where possible and nested arrays/strings are explicitly truncated',
    },
  };
}

/**
 * WI-1377 / WI-1410: shape the mutation echo for the agent-facing result envelope. The full
 * `plannedMutations` array (every effect:write call's tool + FULL args) is the decision-useful
 * PREVIEW under dryRun — until it gets so large that the preview itself overflows/truncates and is
 * no longer reviewable. On a REAL (committing) run those calls already executed, so echoing their
 * args back is pure waste. So: an empty array stays unchanged; a committing run with ≥1 write drops
 * `plannedMutations` for a compact `{ count, byTool }` summary; a dryRun keeps the full preview only
 * while it is still bounded, then swaps to a summarized dry-run preview with per-tool counts and a
 * representative sample.
 */
/**
 * EI-10951 — the honest failure warning.
 *
 * `plannedMutations` is recorded at DISPATCH time, so it includes calls that then threw.
 * The old warning counted all of them as "already executed", which made the most common
 * failure mode in practice — a script whose last call had a bad argument — report:
 *
 *     "1 write-effect call(s) already executed before this failure … do NOT blindly
 *      re-run; check what actually landed, to avoid a double-write."
 *
 * Nothing had landed. The agent then burned a round-trip verifying a write that never
 * happened (observed twice in one session, 2026-07-13). Worse, a warning that is wrong
 * on the common case trains agents to skip it on the rare case it is RIGHT — a real
 * partially-applied batch, which is precisely what it exists to catch.
 *
 * So classify honestly, and say only what is true:
 *   landed    — dispatched and returned without throwing. These DID take effect.
 *   rejected  — the dispatcher refused them before the handler ran (bad args, denied
 *               gate). These provably wrote NOTHING; re-running is safe.
 *   uncertain — threw for any other reason (handler error, timeout mid-flight). These
 *               MAY have landed, and are the ONLY set that still earns the loud warning.
 *
 * PURE — unit-tested without PG or a live dispatcher.
 */
// EI-18717906460509995: a write-effect call that throws (rejected OR uncertain) aborts the
// REST of the script — any tool.ns.verb(...) written after it in source order never dispatches
// at all (it isn't merely unexecuted-but-recorded; it's invisible to plannedMutations/rejected/
// uncertain, because the vm script itself unwound before reaching that line). The durable write
// most worth protecting (a checkpoint, a fact) is also the one an agent is likeliest to author
// LAST in a batch (state the outcome, then persist it) — exactly backwards from safe. Surface the
// mitigation the moment a rejection actually strands something, not just in the tool's static
// guidance text (which a script author only reads before their FIRST batch, not their next one).
const ORDERING_HINT =
  'Ordering tip: a rejected/thrown call aborts every call written AFTER it in the same script — ' +
  'nothing past that line even dispatches. Put durable/continuity writes (work_items:checkpoint, ' +
  "loop:checkpoint, facts:assert) FIRST in a batch so a later call's failure can never strand them.";

/**
 * P-020: the writes that never ran. Rendered from `strandedWrites` (computed at the
 * orchestrate seam, where the static parse and the dispatch record are both in hand).
 *
 * This is the half the existing warnings structurally cannot cover: every other mutation
 * array is recorded AT DISPATCH, so a call the vm never reached appears in none of them and
 * the result reads as "nothing was written" — true, and dangerously incomplete when what
 * went unwritten was the checkpoint the agent believed it had just persisted.
 */
function strandedWriteWarning(stranded: readonly string[]): Record<string, string> {
  if (stranded.length === 0) return {};
  return {
    strandedWriteWarning:
      `${stranded.length} write-effect call(s) in this script NEVER DISPATCHED (${stranded.join(', ')}) — ` +
      'the script aborted before reaching them, so they are missing from every mutation list above ' +
      '(those record calls at dispatch). Nothing about them was written. If any was a durable ' +
      'continuity write (work_items:checkpoint, loop:checkpoint, facts:assert), that state does NOT ' +
      `exist — re-issue it. ${ORDERING_HINT}`,
  };
}

export function buildFailureWarning(
  planned: readonly { tool: string }[],
  rejected: readonly { tool: string }[],
  uncertain: readonly { tool: string }[],
  stranded: readonly string[] = [],
  inFlight: readonly { tool: string }[] = [],
): Record<string, string> {
  const countBy = (ms: readonly { tool: string }[]): Record<string, number> => {
    const by: Record<string, number> = {};
    for (const m of ms) by[m.tool] = (by[m.tool] ?? 0) + 1;
    return by;
  };
  const render = (by: Record<string, number>): string =>
    Object.entries(by)
      .filter(([, n]) => n > 0)
      .map(([t, n]) => `${t}×${n}`)
      .join(', ');
  const tally = (ms: readonly { tool: string }[]): string => render(countBy(ms));

  // What actually LANDED = dispatched, minus everything that threw. (Subtract per-tool, so
  // the tally names the tools that really took effect — not the one that was rejected.)
  const landedBy = countBy(planned);
  for (const m of [...rejected, ...uncertain, ...inFlight]) {
    if (landedBy[m.tool]) landedBy[m.tool] -= 1;
  }
  const landedCount = Math.max(planned.length - rejected.length - uncertain.length - inFlight.length, 0);

  // Nothing took effect and nothing is in doubt: say so plainly. This is the case the old
  // warning got backwards, and the case an agent hits most.
  if (landedCount === 0 && uncertain.length === 0) {
    // P-020: `rejected.length === 0` here is the script's most common abort — a READ threw
    // (an arg typo), so no write ever dispatched. That returned a bare `{}`: no warning at
    // all, even when the script had ordered writes that were silently skipped. The stranded
    // report is the only signal in that case, so it must survive this early return.
    if (rejected.length === 0) return strandedWriteWarning(stranded);
    return {
      warning:
        `${rejected.length} write-effect call(s) were REJECTED before execution (${tally(rejected)}) — ` +
        'the dispatcher refused them (bad args / denied gate), so NOTHING was written. ' +
        'No double-write risk: fix the call and re-run the script. ' +
        ORDERING_HINT,
      ...strandedWriteWarning(stranded),
    };
  }

  // Wording preserved from the original warning (WI-1377/EI-7174) for the case whose
  // semantics are UNCHANGED — a write that really did land still says exactly what it
  // always said. Only the false-alarm case (nothing landed) gets new text.
  const parts: string[] = [];
  if (landedCount > 0) {
    parts.push(`${landedCount} write-effect call(s) already executed before this failure (${render(landedBy)})`);
  }
  if (uncertain.length > 0) {
    parts.push(`${uncertain.length} threw mid-flight and MAY have landed (${tally(uncertain)})`);
  }
  if (inFlight.length > 0) {
    parts.push(`${inFlight.length} still IN FLIGHT when the script returned (${tally(inFlight)}) and may settle later`);
  }
  const suffix =
    rejected.length > 0
      ? ` (${rejected.length} further call(s) were rejected before execution and wrote nothing.)`
      : '';
  return {
    warning:
      `${parts.join('; ')} — do NOT blindly re-run the whole script; check what actually ` +
      `landed before retrying, to avoid a double-write.${suffix}` +
      (rejected.length > 0 || uncertain.length > 0 ? ` ${ORDERING_HINT}` : ''),
    ...strandedWriteWarning(stranded),
  };
}

/**
 * WI-7061: name a READ-effect child call that reported its own `ok:false`.
 *
 * EI-7669/EI-7784 closed this for WRITE-effect calls, but only for those: orchestrate.ts fills
 * `okFalseMutations` under `if (tool.effect === 'write')`, and the prose warning built from it
 * lives inside `shapeMutationEcho`, which early-returns on `plannedMutations.length === 0`. So a
 * script that made no writes — or that made writes and ALSO consumed a failed read — handed the
 * caller `ok:true` + `partial:true` and nothing saying WHAT failed.
 *
 * Detection was never the gap: orchestrate.ts already pushes every semantically-failed child
 * (read or write) into `childFailures` and derives `partial` from it. The missing piece was the
 * human-readable pointer, which is what agents actually read. A failed READ is its own hazard,
 * distinct from a failed write: the script very likely branched on it, or folded it into a
 * summary, so the returned value can be confidently wrong rather than merely incomplete.
 *
 * Deliberately COMPLEMENTARY to `okFalseWarning`, never overlapping — a write already named
 * there is skipped here, so the two fields never say the same thing twice, and the remediation
 * each implies stays distinct (a write asks "did it land?", a read asks "did I reason on junk?").
 * Thrown children are skipped too: `buildFailureWarning` owns those, with double-write semantics
 * this must not contradict (a `rejected` call provably wrote nothing).
 *
 * Applied at the call site, AFTER shapeMutationEcho, precisely so the mutation-echo early return
 * cannot suppress it.
 */
export function annotateChildFailureWarning<T extends OrchestrationRunResult | Record<string, unknown>>(
  result: T,
): T | Record<string, unknown> {
  const childFailures = (result as { childFailures?: unknown }).childFailures;
  if (!Array.isArray(childFailures) || childFailures.length === 0) return result;

  const namedByOkFalse = new Set(
    (
      ((result as { okFalseMutations?: unknown }).okFalseMutations as ReadonlyArray<{ tool?: unknown }> | undefined) ??
      []
    )
      .map((m) => (typeof m?.tool === 'string' ? m.tool : undefined))
      .filter((t): t is string => t !== undefined),
  );

  const unnamed = Array.from(
    new Set(
      (childFailures as ReadonlyArray<{ tool?: unknown; kind?: unknown }>)
        // 'semantic' only — a thrown child belongs to buildFailureWarning, not here.
        .filter((f) => f?.kind === 'semantic')
        .map((f) => (typeof f?.tool === 'string' ? f.tool : undefined))
        .filter((t): t is string => t !== undefined)
        .filter((t) => !namedByOkFalse.has(t)),
    ),
  );
  if (unnamed.length === 0) return result;

  return {
    ...result,
    childFailureWarning:
      `${unnamed.length} read-effect call(s) dispatched without throwing but reported ok:false in ` +
      `their own result: ${unnamed.join(', ')}. The script still ran to completion, so \`ok\` is ` +
      'true — but any value derived from these calls may be wrong, not merely missing. Check ' +
      '`childFailures` for each result before trusting this summary.',
  };
}

/**
 * Project child WRITE failures onto the public code:run status.
 *
 * `runToolOrchestration.ok` intentionally answers a narrower question: whether the script
 * itself completed. That keeps existing orchestration callers able to distinguish a script
 * error from a script that completed with a diagnostic. The agent-facing code:run envelope,
 * however, is commonly branched on as the success of the whole batch. Leaving `ok:true` there
 * when a write was rejected (either before dispatch or by its own `{ ok:false }` result) lets a
 * confirmation in the same batch claim an action that did not happen.
 *
 * Read-only semantic failures stay advisory: they remain `ok:true` with `partial:true` and the
 * existing `childFailureWarning`, because no write was falsely reported as successful.
 */
export function annotatePublicCodeRunStatus<T extends OrchestrationRunResult | Record<string, unknown>>(
  result: T,
): T | Record<string, unknown> {
  const rejectedMutations = (result as { rejectedMutations?: unknown }).rejectedMutations;
  const okFalseMutations = (result as { okFalseMutations?: unknown }).okFalseMutations;
  const rejectedCount = Array.isArray(rejectedMutations) ? rejectedMutations.length : 0;
  const okFalseCount = Array.isArray(okFalseMutations) ? okFalseMutations.length : 0;
  if (rejectedCount === 0 && okFalseCount === 0) return result;

  const failureKinds = [
    ...(rejectedCount > 0 ? [`${rejectedCount} write-effect call(s) rejected before execution`] : []),
    ...(okFalseCount > 0 ? [`${okFalseCount} write-effect call(s) returned ok:false`] : []),
  ];
  const existingError = (result as { error?: unknown }).error;
  return {
    ...result,
    ok: false,
    ...(typeof existingError === 'string' && existingError.length > 0
      ? { error: existingError }
      : {
          error:
            `code:run completed with child write failure: ${failureKinds.join('; ')}. ` +
            'Inspect rejectedMutations/okFalseMutations before retrying the batch.',
        }),
  };
}

// Same TS2345 class as shapeCodeRunLogs above, and the last link in the chain still demanding the
// full interface. `annotatePublicCodeRunStatus` widens to `T | Record<string, unknown>` (a plain
// interface has no index signature, so the record arm is not assignable to OrchestrateResult), and
// the call site feeds exactly that union straight into this function. Accept the union its callers
// actually produce — matching annotatePublicCodeRunStatus/annotateChildFailureWarning — then narrow
// once, so the body below keeps its concrete field types instead of degrading to `unknown`.
export function shapeMutationEcho<T extends OrchestrationRunResult | Record<string, unknown>>(
  result: T,
): T | OrchestrationRunResult | Record<string, unknown> {
  const run = result as OrchestrationRunResult;
  // Defensive, and load-bearing now that the record arm is accepted: a widened result (or a
  // hand-built fixture) can omit plannedMutations entirely, where `.length` would have thrown.
  if (!Array.isArray(run.plannedMutations) || run.plannedMutations.length === 0) return result;
  if (run.dryRun) {
    const serialized = JSON.stringify(run.plannedMutations);
    if (serialized.length <= DRY_RUN_MUTATION_PREVIEW_CHAR_BUDGET) return result;

    const { plannedMutations, ...rest } = run;
    const byTool: Record<string, number> = {};
    const samplesPerTool: Record<string, number> = {};
    const sample: typeof plannedMutations = [];
    for (const m of plannedMutations) {
      byTool[m.tool] = (byTool[m.tool] ?? 0) + 1;
      if (sample.length >= DRY_RUN_MUTATION_SAMPLE_LIMIT) continue;
      const toolSamples = samplesPerTool[m.tool] ?? 0;
      if (toolSamples >= DRY_RUN_MUTATION_SAMPLE_PER_TOOL_LIMIT) continue;
      sample.push(m);
      samplesPerTool[m.tool] = toolSamples + 1;
    }

    return {
      ...rest,
      mutations: {
        dryRunPreview: true,
        count: plannedMutations.length,
        byTool,
        sample,
        sampleOmittedCount: plannedMutations.length - sample.length,
        note: 'dryRun preview summarized to keep the result bounded and reviewable; sample shows a few representative writes per tool',
      },
    };
  }

  const { plannedMutations, writeAttempts, okFalseMutations, rejectedMutations, uncertainMutations, ...rest } = run;
  // Defensive: fixture results built by hand (tests predating this field) omit it entirely.
  const okFalseMutationsList = okFalseMutations ?? [];
  const rejected = rejectedMutations ?? [];
  const uncertain = uncertainMutations ?? [];
  const attempts = writeAttempts ?? [];
  const settledAttempts = attempts.filter((a) => a.disposition === 'settled');
  const previewAttempts = attempts.filter((a) => a.disposition === 'preview');
  const previewByTool: Record<string, number> = {};
  for (const attempt of previewAttempts) previewByTool[attempt.tool] = (previewByTool[attempt.tool] ?? 0) + 1;
  const inFlightAttempts = attempts.filter((a) => a.disposition === 'in_flight');
  const semanticRejectedAttempts = attempts.filter((a) => a.disposition === 'semantic_rejected');
  // EI-10951: `mutations.count` must count what LANDED, not what was dispatched — a
  // rejected call wrote nothing and reporting it as a mutation is the same lie as the
  // warning below. (A throw mid-flight stays counted: it may well have landed.)
  const landedByTool: Record<string, number> = {};
  const landedSource = attempts.length > 0 ? settledAttempts : plannedMutations;
  for (const m of landedSource) landedByTool[m.tool] = (landedByTool[m.tool] ?? 0) + 1;
  if (attempts.length === 0) {
    for (const m of rejected) {
      const n = (landedByTool[m.tool] ?? 0) - 1;
      if (n > 0) landedByTool[m.tool] = n;
      else delete landedByTool[m.tool];
    }
  }
  const landedCount =
    attempts.length > 0 ? settledAttempts.length : Math.max(plannedMutations.length - rejected.length, 0);
  const settledPrefixCount = attempts.findIndex((a) => a.disposition !== 'settled');
  const dispositionIndexes =
    attempts.length > 0
      ? Object.fromEntries(
            ['settled', 'preview', 'in_flight', 'semantic_rejected', 'rejected', 'uncertain']
            .map((disposition) => [
              disposition,
              attempts.filter((a) => a.disposition === disposition).map((a) => a.index),
            ])
            .filter(([, indexes]) => (indexes as number[]).length > 0),
        )
      : undefined;
  return {
    ...rest,
    mutations: {
      count: landedCount,
      byTool: landedByTool,
      ...(rejected.length > 0 ? { rejectedCount: rejected.length, rejected } : {}),
      ...(attempts.length > 0
        ? {
            attemptedCount: attempts.length,
            settledPrefixCount: settledPrefixCount === -1 ? attempts.length : settledPrefixCount,
            dispositions: dispositionIndexes,
            ...(previewAttempts.length > 0
              ? {
                  previewCount: previewAttempts.length,
                  previewByTool,
                }
              : {}),
            ...(inFlightAttempts.length > 0 ? { inFlightCount: inFlightAttempts.length } : {}),
            ...(semanticRejectedAttempts.length > 0 ? { semanticRejectedCount: semanticRejectedAttempts.length } : {}),
          }
        : {}),
      note:
        attempts.length > 0
          ? 'count includes only write calls that settled successfully before code:run returned; disposition indexes are zero-based dispatch order and in_flight calls require verification before retry'
          : 'effect:write calls executed; per-call args omitted to keep the result bounded — re-run with dryRun:true to preview them',
    },
    // EI-7174: a script_timeout (or any other ok:false — a thrown error, a worker crash) does
    // NOT undo write-effect calls the script already dispatched before the failure — dispatch()
    // invokes the REAL tool immediately for every effect:write call, timeout or not. An agent
    // that only reads `error` and retries the whole script on a `ok:false` risks a double-write
    // (double-claim, double-post, …) for every mutation that already landed. Surface it at the
    // SAME top level as `error` — not just buried in `mutations.note` — so it can't be missed.
    //
    // EI-10951: but say something TRUE. This used to count every DISPATCHED write as
    // "already executed", including the one the dispatcher rejected on its args — so the
    // single most common failure (a typo'd argument) produced a false "1 write already
    // landed, do NOT re-run" and sent the agent to verify a write that never happened.
    // A safety warning that cries wolf on the common case gets ignored in the rare case it
    // is right. Now: `landed` = dispatched and did not throw; `rejected` = provably wrote
    // nothing (safe to re-run); `uncertain` = threw mid-flight and MAY have landed — the
    // only set that still earns the loud double-write warning.
    ...(!run.ok
      ? buildFailureWarning(
          attempts.length > 0
            ? attempts.filter(
                (attempt) => attempt.disposition !== 'semantic_rejected' && attempt.disposition !== 'preview',
              )
            : plannedMutations,
          rejected,
          uncertain,
          run.strandedWrites ?? [],
          inFlightAttempts,
        )
      : {}),
    // EI-7669: a write-effect call can dispatch fine (no throw) yet report its OWN `ok:false`
    // (e.g. work_items:set_state's completion-integrity check). Nothing in `result.ok` / `error`
    // reflects this — the SCRIPT still ran to a normal finish — so a batched script that doesn't
    // inspect every individual result silently miscounts the outcome. Surface it unconditionally
    // (independent of result.ok) so it can't be missed the way a bare `Promise.allSettled` count
    // would miss it. Do not infer zero effects from `ok:false`: a child such as capability:bash
    // may report a later command failure after earlier operations already caused side effects.
    // Defensive `?? []`: fixture results built by hand (tests predating this field) omit it — never
    // let an older/partial result object throw here instead of just showing no okFalse warning.
    ...(okFalseMutationsList.length > 0
      ? {
          // EI-7784: `partial: true` is ALSO on the result's top level (a structured signal a
          // caller can branch on programmatically) — this warning is the human-readable pointer
          // to it, not the only place it's surfaced.
          okFalseWarning:
            `${okFalseMutationsList.length} write-effect call(s) dispatched without throwing but reported ` +
            `ok:false in their own result: ${okFalseMutationsList.map((m) => m.tool).join(', ')}. ` +
            'Their effects may be partial or absent. Check okFalseMutations for details and verify ' +
            'their effects before retrying; do not assume success or that the whole call did nothing. ' +
            '`partial: true` is set on this result for exactly this reason — check it, not just `ok`.',
          okFalseMutations: okFalseMutationsList,
        }
      : {}),
  };
}

/** Cap on how many "closest namespace" suggestions buildFacadeHelp surfaces (EI-7677). */
const FACADE_HELP_NAMESPACE_SUGGESTIONS = 3;

/**
 * Cap on how many closest-VERB full signatures buildFacadeHelp renders per referenced namespace
 * (EI-23783922587988483). A namespace with at most 2× this many verbs is still rendered whole —
 * see the threshold comment in buildFacadeHelp for the measurement behind that factor.
 *
 * Deliberately the SAME 3 as FACADE_HELP_NAMESPACE_SUGGESTIONS: this is the "did you mean" set for
 * a mistyped verb, and the sibling branch already settled that 3 candidates beat both 1 (too easy
 * to miss the intended verb) and a dump. It is also what keeps the reply INSIDE the per-result
 * budget: measured against the 30 heaviest real schemas, a cap of 6 still rendered 10,952 chars of
 * signatures (the closest verbs are not the average ones), which spills exactly like the bug being
 * fixed. Exported so the tests pin the contract instead of re-encoding the number.
 */
export const FACADE_HELP_VERB_SIGNATURES = 3;

/**
 * P-007: turn a parse-check failure into a self-service fix. From the unknown `ns.verb` (or
 * `ns:verb`) refs the script used, render the typed `tools.ns.verb(args)` signatures for the
 * CLOSEST VERBS in the namespaces that DO exist in the caller's facade (fix a verb/arg typo), and
 * — only when a referenced namespace doesn't exist at all — surface the closest-matching known
 * namespaces so the agent can pick the right one. Same scoping/generators as code:tools, so the
 * agent never needs to call code:tools first.
 *
 * EI-7677: this used to spill the ENTIRE allowed namespace index (every ns × verb — observed
 * ~15k tokens for a superuser's full facade) whenever a script referenced even ONE unknown
 * namespace (a typo'd `tools.workItems` vs `tools.workitems`) — a single-line typo could blow a
 * session's context budget (one leader session hit 157%). Bounded now: rank every known
 * namespace by edit distance to the (first) unknown ref via the same `nearestByLevenshtein`
 * helper `fuzzyEnum` already uses for arg-value typos, and surface only the top
 * `FACADE_HELP_NAMESPACE_SUGGESTIONS` — with an explicit pointer to `code:tools {}` for the rare
 * case the agent genuinely needs to browse the full catalog.
 *
 * EI-23783922587988483: EI-7677 bounded only the unknown-NAMESPACE branch. The unknown-VERB
 * branch — a KNOWN namespace with one mistyped verb, which is the far more common shape — kept
 * rendering every verb's full signature for that whole namespace: measured 67,864 chars for one
 * bad `work_items` ref, which overflows the per-result cap, spills to a scratch file, and costs
 * MORE context than the failed call would have. Both branches are bounded the same way now, via
 * the same helper: the closest `FACADE_HELP_VERB_SIGNATURES` verbs get full signatures, and the
 * namespace's COMPLETE verb list rides along by NAME in `namespaces`, so the bound never HIDES a
 * verb — it only defers that verb's arg TYPES to `code:tools { namespaces:[…] }`.
 */
export function buildFacadeHelp(
  unknownRefs: readonly string[],
  all: ReturnType<typeof listAllProjectedTools>,
  allowed: ReadonlySet<string>,
): { note: string; signatures?: string; namespaces?: ReturnType<typeof listFacadeNamespaces> } {
  const index = listFacadeNamespaces(all, allowed);
  const known = new Set(index.map((e) => e.ns));
  const byNs = new Map(index.map((e) => [e.ns, e]));

  // `buildToolFacade` exposes the canonical camel namespace plus raw and snake aliases.
  // Parse-check reports the spelling the script used, so `tools.work_items.missing()` used
  // to look like an unknown namespace here even though it correctly resolved to the existing
  // `workItems` bucket at runtime. Build the same alias map from the namespace index so every
  // facade spelling receives the typed signatures for its real namespace.
  const namespaceAliases = new Map<string, string>();
  for (const entry of index) {
    namespaceAliases.set(entry.ns, entry.ns);
    for (const toolName of entry.toolNames) {
      const ci = toolName.indexOf(':');
      const di = toolName.indexOf('.');
      const sep = ci > 0 ? ci : di;
      if (sep <= 0) continue;
      const rawNs = toolName.slice(0, sep);
      namespaceAliases.set(rawNs, entry.ns);
      namespaceAliases.set(rawNs.replace(/-/g, '_'), entry.ns);
      namespaceAliases.set(
        rawNs.replace(/[-_]+([a-z0-9])/gi, (_m, c: string) => c.toUpperCase()),
        entry.ns,
      );
    }
  }

  const referencedNs = new Set<string>();
  /** ns → the unknown VERB spellings the script used there (EI-23783922587988483 ranks against these). */
  const referencedVerbs = new Map<string, Set<string>>();
  for (const ref of unknownRefs) {
    const ci = ref.indexOf(':');
    const di = ref.indexOf('.');
    const sep = ci >= 0 ? ci : di; // tools.call('ns:verb') → colon; tools.ns.verb → dot
    const rawNs = sep > 0 ? ref.slice(0, sep) : ref;
    const ns = namespaceAliases.get(rawNs) ?? rawNs;
    referencedNs.add(ns);
    const verb = sep > 0 ? ref.slice(sep + 1) : '';
    if (verb) {
      const bucket = referencedVerbs.get(ns) ?? new Set<string>();
      bucket.add(verb);
      referencedVerbs.set(ns, bucket);
    }
  }

  const present = [...referencedNs].filter((ns) => known.has(ns));
  const missing = [...referencedNs].filter((ns) => !known.has(ns));
  // EI-23783922587988483: render FULL signatures only for the verbs closest to the ones the script
  // actually typed. Rendering the whole namespace measured 67,864 chars for one bad `work_items`
  // ref — it overflows the per-result cap and spills, costing more context than the failed call.
  // Ranking is on a flattened spelling so a snake_case ref ranks against camelCase verbs.
  const flatten = (s: string) => s.replace(/[^a-z0-9]/gi, '').toLowerCase();
  const signatureNames: string[] = [];
  const partiallyRendered: string[] = [];
  for (const ns of present) {
    const entry = byNs.get(ns);
    if (!entry) continue;
    const typed = [...(referencedVerbs.get(ns) ?? [])];
    // A bare `tools.ns` ref has no verb to rank against, and a small namespace is already cheap —
    // both keep rendering whole, which is what every pre-EI-23783922587988483 caller expects.
    // The threshold is 2× the cap because bounding is NOT free: the complete verb-name index built
    // below costs bytes back, so an 8-verb namespace bounded to 6 measured only a 48% net win.
    // Bound only where it clearly pays — the namespace that produced the 67,864-char dump is far
    // larger than this threshold, and a marginal namespace is better rendered whole.
    if (!typed.length || entry.verbs.length <= FACADE_HELP_VERB_SIGNATURES * 2) {
      signatureNames.push(...entry.toolNames);
      continue;
    }
    partiallyRendered.push(ns);
    const byFlat = new Map(entry.verbs.map((v, i) => [flatten(v), i]));
    const picked = new Set<number>();
    for (const verb of typed) {
      for (const close of nearestByLevenshtein(flatten(verb), [...byFlat.keys()], {
        k: FACADE_HELP_VERB_SIGNATURES,
        maxRatio: 1,
      })) {
        const i = byFlat.get(close);
        if (i !== undefined) picked.add(i);
      }
    }
    for (const i of [...picked].slice(0, FACADE_HELP_VERB_SIGNATURES)) {
      signatureNames.push(entry.toolNames[i]!);
    }
  }
  const signatures = signatureNames.length
    ? generateToolFacadeTypes(all, { allowed, names: signatureNames })
    : undefined;

  // Rank every known namespace by closeness to each missing ref; keep only the closest
  // FACADE_HELP_NAMESPACE_SUGGESTIONS overall (maxRatio:1 ⇒ always returns the top-k rather than
  // an empty set on a wildly-wrong name — a few "not quite it" suggestions still beat nothing).
  const indexEntries: ReturnType<typeof listFacadeNamespaces> = [];
  if (missing.length && known.size) {
    const suggested = new Set<string>();
    for (const m of missing) {
      for (const s of nearestByLevenshtein(m, [...known], { k: FACADE_HELP_NAMESPACE_SUGGESTIONS, maxRatio: 1 })) {
        suggested.add(s);
      }
    }
    indexEntries.push(
      ...[...suggested]
        .slice(0, FACADE_HELP_NAMESPACE_SUGGESTIONS)
        .map((ns) => byNs.get(ns)!)
        .sort((a, b) => a.ns.localeCompare(b.ns)),
    );
  }
  // A partially-rendered namespace contributes its COMPLETE verb list by name, so the signature
  // bound above never HIDES a verb — it only defers that verb's arg TYPES to code:tools.
  for (const ns of partiallyRendered) {
    const entry = byNs.get(ns);
    if (entry && !indexEntries.some((e) => e.ns === ns)) indexEntries.push(entry);
  }
  const namespaces = indexEntries.length ? indexEntries : undefined;

  const note =
    'code:run accepts a script directly — no code:tools pre-call required. These refs were not in ' +
    'your allowed facade; fix the tools.ns.verb name/args and re-run. ' +
    (signatures
      ? partiallyRendered.length
        ? 'Typed signatures for the verbs CLOSEST to the ones you named are in `signatures` — not ' +
          `the whole of ${partiallyRendered.join(', ')}, which would cost more context than the ` +
          'failed call did. Every verb in those namespaces is listed by NAME in `namespaces`; for ' +
          `their full arg types call code:tools { namespaces: ${JSON.stringify(partiallyRendered)} }. `
        : 'Typed signatures for the namespaces you referenced are in `signatures`. '
      : '') +
    (missing.length
      ? `Unknown namespace(s): ${missing.join(', ')} — the closest matches (with their verbs) are in ` +
        '`namespaces`; if none fit, call code:tools {} for the full catalog.'
      : '');

  return {
    note,
    ...(signatures ? { signatures } : {}),
    ...(namespaces ? { namespaces } : {}),
  };
}

/**
 * Resolve the capture deps (PG handle, embedder, hive resolver) + the acting
 * agent's identity from ctx, then upsert the recipe + run dedup. `getOrgPg` is
 * now a module-level import (WI-1411 needs it eagerly for `bindInnerDispatch`),
 * so only the embedder/hive-federation imports stay lazy; every step is
 * best-effort (captureRecipe itself try/catches).
 *
 * Returns the top similar PRIOR recipes (P-004 dedup) so the caller can surface
 * them SOFT in the code:run result. Returns [] on any wiring failure — capture +
 * dedup must NEVER break the run.
 */
async function maybeCaptureRecipe(
  args: { script: string; title?: string; description?: string },
  ctx: UnifiedToolContext,
  tools: ReturnType<typeof listAllProjectedTools>,
  allowed: ReadonlySet<string>,
  executionTrace: NormalizedExecutionTrace | null,
  contract?: CodeRunContract,
): Promise<CodeRunRecipeCapture | null> {
  try {
    const workspaceId = ctx.workspaceId;
    if (!workspaceId) return null; // no workspace ⇒ nothing to scope a recipe to

    const { buildQueryEmbedderResolved, interactiveEmbedAcquireBudgetMs } = await import('../search/embedder');
    const { resolveProseProfileSelection } = await import('../../search/prose-vector-dims');
    const { potHomeSlugForHarness } = await import('../../hive-federation');
    const { resolveAgentIdentity } = await import('../coordination/identity');

    let ownerId: string | null = null;
    try {
      ownerId = resolveAgentIdentity(ctx).ownerId;
    } catch {
      ownerId = null; // unattributable ctx (e.g. a test/in-process call) — still capture
    }

    const resolved = await buildQueryEmbedderResolved({ acquireBudgetMs: interactiveEmbedAcquireBudgetMs() }).catch(() => null);
    const profile = resolved ? resolveProseProfileSelection(resolved.mode, resolved.profile) : null;

    const captured = await captureRecipe(
      {
        sql: getOrgPg().sql,
        embed: async (text) => resolved && profile
          ? { vector: await resolved.embed(text), mode: resolved.mode, profile }
          : null,
        resolveHive: potHomeSlugForHarness,
        log: (msg) => ctx.log(msg),
      },
      {
        script: args.script,
        workspaceId,
        harness: ctx.harnessSlug ?? null,
        ownerId,
        role: ctx.role ?? null,
        title: args.title,
        description: args.description,
        ...(contract?.bindingSchema ? { bindingSchema: contract.bindingSchema } : {}),
        ...(contract ? { capabilityManifest: contract.capabilityManifest } : {}),
        ...(contract?.tags ? { tags: contract.tags } : {}),
        tools,
        allowed,
        executionTrace,
      },
    );
    return captured
      ? {
          id: captured.row.id,
          revision: recipeRevision(captured.row.script, captured.row.updatedAt, captured.row),
          disposition: captured.disposition,
          similarRecipes: captured.similarRecipes,
        }
      : null;
  } catch (err) {
    ctx.log(`code:run recipe capture wiring failed (swallowed): ${(err as Error)?.message ?? String(err)}`);
    return null;
  }
}

/** Persist a script execution that has no durable recipe row to attach to. */
async function maybeRecordTraceOnly(
  ctx: UnifiedToolContext,
  executionTrace: NormalizedExecutionTrace,
  success: boolean,
): Promise<void> {
  try {
    const workspaceId = ctx.workspaceId;
    if (!workspaceId) return;
    const { resolveLearningPotSlug } = await import('../../learning/pot-scope');
    const { resolveAgentIdentity } = await import('../coordination/identity');
    let ownerId: string | null = null;
    try {
      ownerId = resolveAgentIdentity(ctx).ownerId;
    } catch {
      ownerId = null;
    }
    const potSlug = await resolveLearningPotSlug({
      workspaceId,
      harnessSlug: resolveConcreteHarnessSlug(undefined, ctx),
    });
    await recordRecipeRun(getOrgPg().sql, {
      recipeId: null,
      workspaceId,
      potSlug,
      agentOwner: ownerId,
      agentRole: ctx.role ?? null,
      success,
      reused: false,
      executionTrace,
      countTowardRecipe: false,
    });
  } catch (err) {
    ctx.log(`code:run trace record failed (swallowed): ${(err as Error)?.message ?? String(err)}`);
  }
}
