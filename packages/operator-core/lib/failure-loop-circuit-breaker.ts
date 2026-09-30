/**
 * A cheap, process-local circuit breaker for repeated failed tool calls.
 *
 * EI-6139: the shared dispatcher sees the settled result that client hooks do
 * not. Keep only privacy-preserving structural state here (owner, tool,
 * argument SHAPE, and error CLASS); raw arguments and error messages never
 * enter the detector or its pending hint.
 *
 * State is per detector session + tool. A successful call or a changed argument/error
 * shape resets that tool's streak, while unrelated tools do not interrupt it.
 * This lets three failed retries separated by ordinary investigation calls
 * trip the breaker without combining unrelated failures.
 */

import { createHash } from 'node:crypto';
import type { DispatchProjectedResult } from '@papercusp/agent-mcp';
import { pinModuleState } from '@papercusp/module-singleton';

export const FAILURE_LOOP_THRESHOLD = 3;
export const FAILURE_LOOP_WINDOW_MS = 10 * 60_000;
export const FAILURE_LOOP_DEBOUNCE_MS = 30 * 60_000;
export const FAILURE_LOOP_PENDING_TTL_MS = 30 * 60_000;

const MAX_OWNER_TOOL_STATES = 4_096;
const MAX_SHAPE_DEPTH = 6;
const MAX_OBJECT_KEYS = 64;
const MAX_ARRAY_SAMPLES = 32;

export interface FailureLoopHint {
  ownerId: string;
  toolName: string;
  argsShape: string;
  errorClass: string;
  count: number;
  detectedAt: number;
  kind?: 'failure' | 'repetition';
  category?: 'schema' | 'test' | 'status';
}

interface FailureState {
  argsShape: string;
  errorClass: string;
  failuresAt: number[];
  lastSeenAt: number;
  lastHintAt: number | null;
}

const { statesByOwner, pendingByOwner } = pinModuleState('@papercusp/operator-core.failure-loop', () => ({
  statesByOwner: new Map<string, Map<string, FailureState>>(),
  pendingByOwner: new Map<string, FailureLoopHint>(),
}));

const STATUS_TOOLS = new Set(['testing:run-status', 'testing:runs', 'loop:status', 'release:deploy', 'work_items:get']);
const VOLATILE_FIELDS = new Set(['durationMs', 'elapsedMs', 'latencyMs', 'checkpointAgeMs', 'lastActiveSecAgo',
  'observedAt', 'measuredAt', '_dataPlaneMayBeDegraded', '_projection', 'read']);

/** Hash complete bounded values; never store arguments, outputs, secrets or clipped prefixes. */
function valueFingerprint(value: unknown, omitVolatile: boolean): string | null {
  try {
    const normalize = (v: unknown, depth: number): unknown => {
      if (depth > 20) throw new Error('depth');
      if (Array.isArray(v)) return v.map(x => normalize(x, depth + 1));
      if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v)
        .filter(([key]) => !omitVolatile || !VOLATILE_FIELDS.has(key)).sort(([a], [b]) => a.localeCompare(b))
        .map(([key, nested]) => [key, normalize(nested, depth + 1)]));
      return v;
    };
    const encoded = JSON.stringify(normalize(value, 0));
    if (!encoded || encoded.length > 65_536) return null;
    return createHash('sha256').update(encoded).digest('hex');
  } catch { return null; }
}

function repetitionSignature(input: Parameters<typeof observeFailureLoop>[0]) {
  const args = input.args as Record<string, unknown> | null;
  const category = input.toolName === 'tools:find' || input.toolName === 'agent_tools:list' ? 'schema' as const
    : input.toolName === 'testing:run' ? 'test' as const
    : STATUS_TOOLS.has(input.toolName) && (input.toolName !== 'release:deploy' || args?.op === 'status') ? 'status' as const : null;
  if (!category || typeof args?.recheckReason === 'string') return null;
  const toolResult = input.result.result as { data?: unknown; content?: Array<{ type: string; text?: string }> } | undefined;
  let data = toolResult?.data as Record<string, unknown> | undefined;
  if (!data || typeof data !== 'object') {
    for (const block of toolResult?.content ?? []) {
      if (block.type !== 'text' || !block.text) continue;
      try {
        const parsed = JSON.parse(block.text);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) { data = parsed; break; }
      } catch { /* Unstructured output cannot prove equivalence. */ }
    }
  }
  if (!data || data._partial === true || data.state === 'incomplete' ||
    (data._projection as { truncated?: boolean } | undefined)?.truncated) return null;
  let comparable: unknown = data;
  if (category === 'test') {
    const fingerprint = (data.evidenceBundle as { verificationFingerprint?: unknown } | undefined)?.verificationFingerprint;
    if (typeof fingerprint !== 'string') return null;
    comparable = { fingerprint, passed: data.passed, failed: data.failed, skipped: data.skipped, byFile: data.byFile, error: data.error };
  }
  const argsHash = valueFingerprint(input.args, false);
  const resultHash = valueFingerprint(comparable, true);
  return argsHash && resultHash ? { category, fingerprint: `${argsHash}:${resultHash}` } : null;
}

/**
 * Canonical, bounded argument SHAPE — values are deliberately absent.
 *
 * The hash prevents dynamic object keys from leaking through a diagnostic
 * hint while retaining stable equality across object insertion order. Arrays
 * preserve only their element-type set and cardinality class, not contents.
 */
export function argumentShapeFingerprint(args: unknown): string {
  const shape = describeShape(args, 0, new Set<object>());
  return createHash('sha256').update(shape).digest('hex').slice(0, 16);
}

function describeShape(value: unknown, depth: number, seen: Set<object>): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  const primitive = typeof value;
  if (primitive !== 'object') return primitive;
  if (depth >= MAX_SHAPE_DEPTH) return 'object:depth-limit';

  const object = value as object;
  if (seen.has(object)) return 'object:cycle';
  seen.add(object);
  try {
    if (Array.isArray(value)) {
      const samples = value.slice(0, MAX_ARRAY_SAMPLES).map((item) => describeShape(item, depth + 1, seen));
      const unique = [...new Set(samples)].sort();
      const cardinality = value.length === 0 ? 'empty' : value.length === 1 ? 'one' : 'many';
      return `array:${cardinality}<${unique.join('|')}${value.length > MAX_ARRAY_SAMPLES ? '|…' : ''}>`;
    }

    const record = value as Record<string, unknown>;
    const allKeys = Object.keys(record).sort();
    const keys = allKeys.slice(0, MAX_OBJECT_KEYS);
    const fields = keys.map((key) => `${JSON.stringify(key)}:${describeShape(record[key], depth + 1, seen)}`);
    if (allKeys.length > MAX_OBJECT_KEYS) fields.push('…:truncated');
    return `{${fields.join(',')}}`;
  } finally {
    seen.delete(object);
  }
}

/**
 * Normalize the same two failure families the telemetry writer records:
 * dispatcher errors (`result.error.code`) and handler refusals
 * (`ToolResult.isError`). The refusal-code field order mirrors
 * dispatch-stack.ts's telemetry writer; absent structured detail remains the
 * honest class `refused`, never a guess from prose.
 */
export function failureClassOf(result: DispatchProjectedResult): string | null {
  if (!result.ok) return `dispatch:${boundedClass(result.error?.code ?? 'error')}`;
  const toolResult = result.result;
  if (!toolResult?.isError) return null;

  const firstContent = toolResult.content?.[0];
  const text = firstContent?.type === 'text' ? firstContent.text : undefined;
  if (typeof text === 'string' && text.length > 0) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === 'object') {
        const fields = parsed as Record<string, unknown>;
        const code = [fields.error, fields.reason, fields.code, fields.errorCode].find(
          (candidate): candidate is string => typeof candidate === 'string' && candidate.trim().length > 0,
        );
        if (code) return `refused:${boundedClass(code)}`;
      }
    } catch {
      // Plain-text refusals are still a real class; do not infer from prose.
    }
  }
  return 'refused';
}

function boundedClass(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, '_').slice(0, 80) || 'error';
}

export function observeFailureLoop(input: {
  ownerId: string;
  /** Private per-session key used only for detector state; never exposed in the hint. */
  detectorSessionKey?: string | null;
  toolName: string;
  args: unknown;
  result: DispatchProjectedResult;
  now?: number;
}): FailureLoopHint | null {
  const ownerId = input.ownerId.trim();
  const toolName = input.toolName.trim();
  if (!ownerId || !toolName) return null;

  const now = input.now ?? Date.now();
  const stateKey = input.detectorSessionKey?.trim() || ownerId;
  pruneState(now);
  const failureClass = failureClassOf(input.result);
  const repetition = failureClass === null ? repetitionSignature(input) : null;
  const errorClass = failureClass ?? (repetition ? `unchanged-result:${repetition.category}` : null);
  const ownerStates = statesByOwner.get(stateKey);

  // A clean call proves this tool/owner streak has ended. A pending advisory
  // for the same tool is stale too: the agent already found a working call.
  if (!errorClass) {
    ownerStates?.delete(toolName);
    if (ownerStates?.size === 0) statesByOwner.delete(stateKey);
    if (pendingByOwner.get(stateKey)?.toolName === toolName) pendingByOwner.delete(stateKey);
    return null;
  }

  const argsShape = repetition?.fingerprint ?? argumentShapeFingerprint(input.args);
  const byTool = ownerStates ?? new Map<string, FailureState>();
  if (!ownerStates) statesByOwner.set(stateKey, byTool);
  const prior = byTool.get(toolName);
  const sameSignal =
    prior &&
    prior.argsShape === argsShape &&
    prior.errorClass === errorClass &&
    now - prior.lastSeenAt <= FAILURE_LOOP_WINDOW_MS;
  const state: FailureState = sameSignal
    ? prior
    : {
        argsShape,
        errorClass,
        failuresAt: [],
        lastSeenAt: now,
        lastHintAt: null,
      };

  if (!sameSignal && pendingByOwner.get(stateKey)?.toolName === toolName) pendingByOwner.delete(stateKey);

  state.failuresAt = state.failuresAt.filter((at) => now - at <= FAILURE_LOOP_WINDOW_MS);
  state.failuresAt.push(now);
  state.lastSeenAt = now;
  byTool.set(toolName, state);

  if (state.failuresAt.length < FAILURE_LOOP_THRESHOLD) return null;
  if (state.lastHintAt !== null && now - state.lastHintAt < FAILURE_LOOP_DEBOUNCE_MS) return null;

  state.lastHintAt = now;
  const hint: FailureLoopHint = {
    ownerId,
    toolName,
    argsShape,
    errorClass,
    count: state.failuresAt.length,
    detectedAt: now,
    ...(repetition ? { kind: 'repetition' as const, category: repetition.category } : {}),
  };
  // One mid-turn response can carry one actionable interruption. Prefer the
  // freshest signal when several tools cross the threshold in one batch.
  pendingByOwner.set(stateKey, hint);
  return hint;
}

/** Drain-once bridge from the settled dispatcher to PostToolBatch context. */
export function takePendingFailureLoopHint(detectorSessionKey: string, now: number = Date.now()): FailureLoopHint | null {
  const stateKey = detectorSessionKey.trim();
  if (!stateKey) return null;
  const hint = pendingByOwner.get(stateKey) ?? null;
  if (!hint) return null;
  pendingByOwner.delete(stateKey);
  return now - hint.detectedAt <= FAILURE_LOOP_PENDING_TTL_MS ? hint : null;
}

function pruneState(now: number): void {
  let total = 0;
  for (const [owner, byTool] of statesByOwner) {
    for (const [tool, state] of byTool) {
      if (now - state.lastSeenAt > FAILURE_LOOP_DEBOUNCE_MS + FAILURE_LOOP_WINDOW_MS) {
        byTool.delete(tool);
      }
    }
    if (byTool.size === 0) statesByOwner.delete(owner);
    else total += byTool.size;
  }
  for (const [owner, hint] of pendingByOwner) {
    if (now - hint.detectedAt > FAILURE_LOOP_PENDING_TTL_MS) pendingByOwner.delete(owner);
  }
  if (total <= MAX_OWNER_TOOL_STATES) return;

  // Defensive cap only; the normal TTL path is the policy. Evict oldest state
  // first so a hostile owner/tool cardinality burst cannot grow the host.
  const ordered = [...statesByOwner.entries()]
    .flatMap(([owner, byTool]) => [...byTool.entries()].map(([tool, state]) => ({ owner, tool, at: state.lastSeenAt })))
    .sort((a, b) => a.at - b.at);
  for (const entry of ordered.slice(0, total - MAX_OWNER_TOOL_STATES)) {
    const byTool = statesByOwner.get(entry.owner);
    byTool?.delete(entry.tool);
    if (byTool?.size === 0) statesByOwner.delete(entry.owner);
  }
}

export function __resetFailureLoopCircuitBreakerForTests(): void {
  statesByOwner.clear();
  pendingByOwner.clear();
}
