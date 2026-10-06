/**
 * tools:invoke — call ANY tool in the ~550-tool catalog by name, without it
 * being in your loaded tool list (dynamic-tool-surface-2026-07-01, D-003).
 *
 * The universal reachability escape hatch that complements `tools:find`. On a
 * small-seed session, `tools:find("<intent>")` returns the target tool's exact
 * name + arg schema; `tools:invoke({ name, args })` then CALLS it — routed
 * server-side through the same dispatcher a direct call uses, so it is gated
 * EXACTLY as a direct call (same role-allowlist, quota, profile, privilege). It
 * is a router, NOT a privilege bypass.
 *
 * Why it exists even though the dynamic surface (tools/list_changed) already
 * expands OMP's list: a client that does NOT act on the notification never sees
 * the surfaced tool in its own registry, so it can't call it directly. Routing
 * through this one always-present meta-tool reaches the whole catalog regardless
 * — the reachability guarantee for Codex and any future client. Also handy for a
 * one-off call to an obscure tool without growing your working surface.
 */
import { z } from 'zod';
import { defineTool, AGENT_ROLES, resolveMcpName } from '@papercusp/agent-mcp';
import { DISPATCH_WRAPPER_METADATA_KEY } from '../sessions/automatic-tool-names';
import { dispatchWrapperMarkEnabled } from '../../telemetry-dispatch-wrapper';
import { decodeToolsInvokeArgs } from './invoke-args';

type NestedOutcome = {
  effectiveStatus: 'ok' | 'partial' | 'error' | 'vacuous';
  childFailureCount: number;
};

type NestedToolResult = {
  content?: ReadonlyArray<unknown>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
  structuredContent?: unknown;
};

type NestedRefusal = {
  code: string | null;
  message: string | null;
  details: unknown;
};

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function firstNonBlankString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== 'string' || value.trim().length === 0) continue;
    return value.trim();
  }
  return null;
}

function jsonValue(text: string): unknown | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function jsonText(value: unknown): string | null {
  try {
    const text = JSON.stringify(value);
    return typeof text === 'string' ? text : null;
  } catch {
    return null;
  }
}

function nestedTextContent(result: NestedToolResult): string[] {
  return (result.content ?? [])
    .flatMap((item) => {
      if (!item || typeof item !== 'object' || (item as { type?: unknown }).type !== 'text') return [];
      const text = (item as { text?: unknown }).text;
      return typeof text === 'string' && text.trim().length > 0 ? [text.trim()] : [];
    });
}

function refusalFields(payload: unknown): NestedRefusal {
  const record = recordValue(payload);
  if (!record) return { code: null, message: null, details: payload };
  const error = recordValue(record.error);
  const code = firstNonBlankString(
    error?.code,
    typeof record.error === 'string' ? record.error : undefined,
    record.code,
    record.errorCode,
    record.reason,
  );
  const message = firstNonBlankString(
    error?.message,
    error?.errorMessage,
    error?.detail,
    record.message,
    record.errorMessage,
    record.detail,
  );
  return {
    code,
    message,
    // Preserve the caller-facing details field when one exists; the complete
    // structured refusal is retained separately on NestedToolRefusalError.
    details: error?.details ?? record.details ?? payload,
  };
}

function nestedRefusal(result: NestedToolResult): NestedRefusal {
  const texts = nestedTextContent(result);
  const rawText = texts.join('\n');
  const candidates: unknown[] = [];
  if (result.structuredContent !== undefined) candidates.push(result.structuredContent);
  for (const text of texts) {
    const parsed = jsonValue(text);
    if (parsed !== undefined) candidates.push(parsed);
  }

  let code: string | null = null;
  let structuredMessage: string | null = null;
  let details: unknown = undefined;
  for (const candidate of candidates) {
    const fields = refusalFields(candidate);
    if (!code && fields.code) code = fields.code;
    if (!structuredMessage && fields.message) structuredMessage = fields.message;
    if (details === undefined && fields.details !== undefined) details = fields.details;
  }

  if (!code && rawText) {
    const prefix = rawText.match(/^([A-Za-z][A-Za-z0-9_.-]*):\s*(.*)$/s);
    if (prefix?.[1]) code = prefix[1];
  }
  if (details === undefined) details = rawText || result.structuredContent;

  // Keep the nested content verbatim when possible: this is where plain MCP
  // refusals carry their code and actionable detail. If structured content has
  // the code but the compact text does not, prefix it so the outer handler_error
  // still exposes the machine-readable refusal to callers that only read text.
  let message = rawText || structuredMessage || jsonText(result.structuredContent);
  if (message && code && !message.includes(code)) message = `${code}: ${message}`;
  return { code, message, details };
}

/**
 * The nested dispatcher resolves MCP refusals as values. The invoke wrapper
 * must reject them locally so callers' ordinary try/catch probes see a refusal,
 * while retaining the nested code/details that would otherwise be flattened to
 * an opaque outer handler_error.
 */
export class NestedToolRefusalError extends Error {
  override readonly name = 'NestedToolRefusalError';

  constructor(
    readonly toolName: string,
    readonly code: string | null,
    readonly details: unknown,
    readonly nestedResult: NestedToolResult,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Envelope keys that NAME a measured population (EI-20460134627396216).
 *
 * A zero is only reportable against one of these. A body carrying no population
 * key measured nothing IN PARTICULAR — an action result, a scalar read — and is
 * never called vacuous, because "empty" would then mean "I found no field I
 * recognized", which is a statement about this list and not about the call
 * (workspace fact `guard-rail:absence-needs-its-population`).
 */
const POPULATION_KEYS = ['items', 'results', 'rows', 'matches', 'hits', 'entries'] as const;

/** How many populations a body declared, and how many of those came back empty. */
function readPopulations(record: Record<string, unknown>): { declared: number; empty: number } {
  let declared = 0;
  let empty = 0;
  for (const key of POPULATION_KEYS) {
    const value = record[key];
    if (!Array.isArray(value)) continue;
    declared += 1;
    if (value.length === 0) empty += 1;
  }
  // A batch envelope declares its population as counts{ok,failed} rather than an
  // array. Both must be present and finite, or this is not a batch envelope.
  const counts = record.counts;
  if (counts && typeof counts === 'object') {
    const ok = Number((counts as Record<string, unknown>).ok ?? Number.NaN);
    const failed = Number((counts as Record<string, unknown>).failed ?? Number.NaN);
    if (Number.isFinite(ok) && Number.isFinite(failed)) {
      declared += 1;
      if (ok === 0 && failed === 0) empty += 1;
    }
  }
  return { declared, empty };
}

function decodedResultBodies(result: {
  content?: ReadonlyArray<unknown>;
  structuredContent?: unknown;
}): unknown[] {
  const bodies: unknown[] = [];
  if (result.structuredContent !== undefined) bodies.push(result.structuredContent);
  for (const item of result.content ?? []) {
    if (!item || typeof item !== 'object' || (item as { type?: unknown }).type !== 'text') continue;
    const text = (item as { text?: unknown }).text;
    if (typeof text !== 'string') continue;
    try {
      bodies.push(JSON.parse(text));
    } catch {
      // Non-JSON encodings still carry isError; semantic JSON is the additive path here.
    }
  }
  return bodies;
}

export function summarizeNestedToolOutcome(result: {
  content?: ReadonlyArray<unknown>;
  isError?: boolean;
  structuredContent?: unknown;
}): NestedOutcome {
  if (result.isError) return { effectiveStatus: 'error', childFailureCount: 1 };
  let failures = 0;
  let successes = 0;
  let declaredPopulations = 0;
  let emptyPopulations = 0;
  for (const body of decodedResultBodies(result)) {
    if (!body || typeof body !== 'object') continue;
    const record = body as Record<string, unknown>;
    if (record.ok === false) failures += 1;
    else if (record.ok === true) successes += 1;
    if (record.partial === true) failures += 1;
    const counts = record.counts;
    if (counts && typeof counts === 'object') {
      const failed = Number((counts as Record<string, unknown>).failed ?? 0);
      const ok = Number((counts as Record<string, unknown>).ok ?? 0);
      if (Number.isFinite(failed) && failed > 0) failures += failed;
      if (Number.isFinite(ok) && ok > 0) successes += ok;
    }
    const population = readPopulations(record);
    declaredPopulations += population.declared;
    emptyPopulations += population.empty;
  }
  if (failures === 0) {
    // A call that failed at nothing but MEASURED nothing is not the same result as
    // one that measured something, and until now both recorded a clean `ok`. Only
    // a body that declared a population can be called empty, and every declared
    // population must be empty — one non-empty population means work was done.
    const vacuous = declaredPopulations > 0 && emptyPopulations === declaredPopulations;
    return { effectiveStatus: vacuous ? 'vacuous' : 'ok', childFailureCount: 0 };
  }
  return {
    effectiveStatus: successes > 0 ? 'partial' : 'error',
    childFailureCount: failures,
  };
}

export default defineTool({
  name: 'tools:invoke',
  // The MCP host races nested dispatch against the target's effective MCP
  // deadline; the projected dispatcher also owns the target's timeout signal.
  // Keep this wrapper outside the longest known target MCP deadline. scorecards:emit
  // declares 900s; the 60s margin lets its result settle before this watchdog can abort.
  // This avoids turning a successfully-completed target
  // into the misleading "handler returned but signal had aborted" timeout
  // (EI-9242).
  timeoutSec: 960,
  description:
    'Call ANY tool in the full ~550-tool catalog by name, even one not in your loaded tool list. ' +
    // ⚠ THIS SENTENCE IS DELIBERATELY A HARD RAIL, AND MUST STAY ONE (D-047).
    // `summaryGuidanceDescription` keeps "one lead sentence plus every hard rail",
    // and `isSafetyClause` recognises a rail ONLY by a ⛔/🚨/⚠ glyph or an ALL-CAPS
    // imperative. Spelled as ordinary prose it was dropped from the compact tier —
    // and measured over the S25 A/B, two compact runs then passed the UNDERSCORED
    // display spelling (`work_items__list`; `sanitizeToolName` maps ':' → '__'),
    // reached no tool at all, and reported "no open work items found". Re-running
    // the same arm with this contract delivered produced ZERO such calls in 12 runs.
    // Keep this rail under the retained compact rail cap so it ships intact at the
    // compact tier where the wrong display spelling caused actual failures.
    '⚠ Use colon tool names (flags:set); NEVER underscored display names. Args go in `args`. The call is ' +
    'dispatched server-side and gated exactly as a direct call would be. Pair with tools:find: ' +
    'tools:find("<intent>") to get the name + arg schema, then tools:invoke({ name, args }) to run it. ' +
    'Use this when a tool you need is not in your loaded set and your client has not surfaced it directly.',
  guidance: {
    when:
      'You know (or just discovered via tools:find) the exact name of a tool that is NOT in your loaded ' +
      'set and you want to call it once — the universal way to reach the long tail of the catalog.',
    notWhen:
      'When the tool IS already in your loaded set / core spine — call it directly (lower overhead, ' +
      'the model constructs the call natively). This meta-tool adds a layer of indirection; prefer a ' +
      'direct call whenever the tool is reachable.',
    chaining:
      'tools:find("<intent>") → take the top hit\'s name + argSchema → tools:invoke({ name, args: {…} }).',
    seeAlso: [
      'tools:find (discover a tool by intent — returns names + schemas, and activates them where supported)',
    ],
  },
  capability: 'agent_tools:read',
  // The capability is the read-only facade (as for code:run), but the call can
  // reach ANY write, capability:bash included. Inferred from the capability it
  // was 'read', so tools/list advertised readOnlyHint:true, the MCP host skipped
  // its idempotency-replay store, and an annotation-keyed approval policy could
  // wave a shell command through (D-021). Per call it is the target's own effect.
  effect: 'write',
  effectForCall(raw) {
    const call = raw && typeof raw === 'object' ? raw as { name?: unknown; args?: unknown } : {};
    const name = typeof call.name === 'string' ? call.name.trim() : '';
    const target = name && name !== 'tools:invoke' ? resolveMcpName(name) : undefined;
    if (!target) return 'write';
    try {
      const dynamic = target.effectForCall?.(decodeToolsInvokeArgs(call.args ?? {}));
      if (dynamic === 'read' || dynamic === 'write') return dynamic;
    } catch {
      return 'write';
    }
    return target.effect === 'read' ? 'read' : 'write';
  },
  requirePrincipal: false,
  // EI-18803497769946984: this handler is a PURE DELEGATOR — it never touches
  // `ctx.tx`, it just awaits `ctx.dispatchTool(...)`. Without this flag it holds a
  // workspace transaction open for the ENTIRE inner tool's runtime, so dispatching
  // any slow target (build:typecheck, release:deploy, testing:run) leaves that tx
  // IDLE past idle_in_transaction_session_timeout (60s here). Postgres then kills the
  // backend, PgBouncer reports "server conn crashed?", and the caller sees a bare
  // `write CONNECTION_CLOSED 127.0.0.1:6432` at ~60s — an error that reads as an infra
  // outage but is really this ambient tx timing out.
  //
  // ⚠ This is WHY fixing only the inner tool was not enough. release:deploy and
  // capability:bash already carry skipWorkspaceTx, yet tools:invoke→<them> kept
  // failing at ~60s, because the OUTER delegator still held its own tx (each incident
  // killed a PAIR of backends from one process — outer + inner). Measured: 33 of 33
  // ~60s handler_error kills in the trailing 7d were tools:invoke.
  skipWorkspaceTx: true,
  agentRoles: [...AGENT_ROLES],
  args: z.object({
    /** Exact MCP tool name in colon form, e.g. "flags:set". */
    name: z.string().min(1).max(120),
    // EI-6681 / EI-15360: some MCP clients intermittently stringify a
    // moderately-long/complex nested `args` object before it reaches this schema
    // (root cause client-side — this server's own dispatch path never stringifies
    // it; see the endpoint-system docs). A preprocess step tolerates that: a STRING
    // value is JSON.parsed before the record check, so a client-side serialization
    // quirk degrades to a normal call instead of a client-facing "expected record,
    // received string" failure with no actionable next step.
    //
    // EI-15360: for a DEEPLY-NESTED payload (e.g. scheduler:set_claim_spec's ~10-level
    // boolean filter tree) some clients DOUBLE-encode — the value arrives as the JSON
    // of a JSON string. A single JSON.parse then yields a *string*, which still fails
    // z.record with the exact same "expected record, received string" error. Un-string
    // ITERATIVELY (bounded, so a pathological input can't loop) so a double-/multi-
    // encoded object is recovered too. We only un-string the TOP-LEVEL args value —
    // never nested values — so a target tool's legitimate string arg (a title, body,
    // or a JSON-blob-as-string) is left untouched. A non-JSON string still fails
    // naturally (parse throws → the last string reaches the record check).
    /** The target tool's arguments object (its own schema). Defaults to {}. */
    args: z
      .preprocess(decodeToolsInvokeArgs, z.record(z.string(), z.unknown()))
      .optional(),
  }),
  async handler(args, ctx) {
    const name = args.name.trim();
    // Guard the obvious foot-gun: routing tools:invoke through itself.
    if (name === 'tools:invoke') {
      return {
        isError: true,
        content: [{ type: 'text' as const, text: 'invalid_target: tools:invoke cannot invoke itself' }],
      };
    }
    if (!ctx.dispatchTool) {
      return {
        isError: true,
        content: [{
          type: 'text' as const,
          text: 'unsupported_transport: tools:invoke requires a server-side dispatcher (MCP transport)',
        }],
      };
    }
    const targetArgs = args.args ?? {};
    const dispatchArgs =
      ctx.codeMode && !('payloadTier' in targetArgs)
        ? { ...targetArgs, payloadTier: 'full' }
        : targetArgs;
    const result = await ctx.dispatchTool(name, dispatchArgs);
    const outcome = summarizeNestedToolOutcome(result);
    // P-012 (census double-count): the inner dispatch above wrote its OWN telemetry
    // row, so this row is the wrapper overhead — mark it so tool_name censuses
    // exclude it by default. Set only after dispatchTool settled: a throw before
    // dispatch (unknown tool) leaves this row unmarked, erring toward counting.
    // ctx.metadata is overwrite-not-merge, so the mark rides the one existing call.
    const wrapperMark = (await dispatchWrapperMarkEnabled())
      ? { [DISPATCH_WRAPPER_METADATA_KEY]: true, dispatchedTool: name }
      : {};
    ctx.metadata?.({
      ...outcome,
      ...(outcome.childFailureCount > 0 ? { childFailureRefs: [name] } : {}),
      ...wrapperMark,
    });
    if (result.isError) {
      const refusal = nestedRefusal(result);
      throw new NestedToolRefusalError(
        name,
        refusal.code,
        refusal.details,
        result,
        refusal.message ?? `nested tool "${name}" returned isError=true`,
      );
    }
    // dispatchTool returns an MCP-shaped result already ({ content, isError?, _meta?, structuredContent? }).
    return result as unknown as { content: Array<{ type: 'text'; text: string }>; isError?: boolean };
  },
});
