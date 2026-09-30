/**
 * Shared model-facing output envelope (orchestration-runtime-unification P-006).
 *
 * The summary is authored by the executing script/tool. This module validates
 * the authored value; it NEVER derives, rewrites, or mechanically truncates a
 * summary. Oversized material belongs behind a typed reference.
 *
 * Content is deliberately an open registry-backed discriminated union. A lane
 * adds a new kind with module augmentation in its own file. The exhaustive
 * switch in accountOutputContentItem is the compile-time accounting gate: a new
 * kind cannot silently inherit a permissive byte-cost default.
 */

export const OUTPUT_ENVELOPE_SCHEMA_VERSION = 'papercusp.output-envelope/v1' as const;
/** D-023: smallest 250-character bucket containing every benchmark gold summary. */
export const DEFAULT_OUTPUT_SUMMARY_BUDGET_CHARS = 1_250;

export type OutputAudience = 'owner' | 'workspace' | 'public';

/** Generic durable reference. Media/artifact-specific fields belong to their
 * own content-item variants, not this core type (D-019/D-021). */
export interface OutputReferenceContentItem {
  kind: 'reference';
  uri: string;
  preview: string;
  byteCount: number;
  sha256: string;
  expiresAt?: string;
  ownerId?: string;
  audience?: OutputAudience;
}

export const OUTPUT_EVIDENCE_CLASSES = [
  'work-item',
  'event',
  'fleet',
  'capacity',
  'account',
  'release',
] as const;
export type OutputEvidenceClass = (typeof OUTPUT_EVIDENCE_CLASSES)[number];

/** A directly addressable view into one payload that the result door stored
 * once. Several evidence references may share a URI; `evidenceClass` selects
 * the relevant JSON values through capability:read without duplicating bytes. */
export interface OutputEvidenceReferenceContentItem extends Omit<OutputReferenceContentItem, 'kind'> {
  kind: 'evidence-reference';
  evidenceClass: OutputEvidenceClass;
}

/**
 * Explicit replay state produced by a managed script. The next invocation may pass `values`
 * back as its bindings, so store/load parity never depends on process-local or session-local
 * memory that disappears across a cold carry.
 */
export interface OutputReplayStateContentItem {
  kind: 'replay-state';
  values: Readonly<Record<string, unknown>>;
}

/** Open extension seam. Extend this interface from a lane-owned module. */
export interface OutputContentItemMap {
  reference: OutputReferenceContentItem;
  evidenceReference: OutputEvidenceReferenceContentItem;
  replayState: OutputReplayStateContentItem;
}

export type OutputContentItem = OutputContentItemMap[keyof OutputContentItemMap];

export interface OutputExecutionMetrics {
  durationMs?: number;
  toolCalls?: number;
  startedAt?: string;
  finishedAt?: string;
  [metric: string]: string | number | boolean | undefined;
}

export interface OutputEnvelopeError {
  code: string;
  message: string;
  retryable?: boolean;
}

/**
 * Why a result is not the whole answer — and, separately, WHETHER THE MISSING
 * BYTES STILL EXIST. Those are two different facts, and a caller acts on them
 * in opposite ways, so they get two different fields:
 *
 *  - `omittedItems` — items that were NEVER SERIALIZED. Unrecoverable: nothing
 *    downstream can page them back, and their absence here is not evidence
 *    they do not exist. The exit is a narrower re-call / `payloadTier:'full'`.
 *  - `spilledItems` — items RELOCATED WHOLE to the reference in `content`.
 *    Nothing was lost; the exit is to page that reference.
 *
 * Keeping one word for both is not a naming quibble — it is a measured defect
 * source. The result-door spill path reported its relocated blocks under
 * `omittedItems`, and readers reasonably concluded data had been lost:
 * EI-21954450841272611 (reported the underlying field as "not safely
 * available" when it was sitting in the spill), plus EI-21733745031882912 and
 * EI-21573289806322713 — three tools, three sessions, one vocabulary. Each was
 * closed at its own call site while the shared wording kept generating the
 * next one. Never describe a recoverable spill with `omittedItems`.
 */
export interface OutputEnvelopeIncomplete {
  reason: string;
  /** Items never serialized — UNRECOVERABLE. Omit it when nothing was truly dropped. */
  omittedItems?: number;
  /** Items relocated intact into the reference in `content` — recoverable by paging it. */
  spilledItems?: number;
  /** True when every byte of the original result is recoverable from `content`. */
  recoverable?: boolean;
  /** What the caller should actually do about it. */
  note?: string;
}

export type OutputEnvelopeState = 'complete' | 'incomplete' | 'error';

export interface OutputEnvelope {
  schemaVersion: typeof OUTPUT_ENVELOPE_SCHEMA_VERSION;
  /** Always authored upstream. The runtime never auto-summarizes. */
  summary: string;
  summaryProvenance: 'authored';
  content: readonly OutputContentItem[];
  state: OutputEnvelopeState;
  incomplete?: OutputEnvelopeIncomplete;
  error?: OutputEnvelopeError;
  metrics: Readonly<OutputExecutionMetrics>;
  accounting: {
    summaryChars: number;
    summaryBytes: number;
    contentBytes: number;
    totalBytes: number;
    summaryBudgetChars: number;
  };
}

export interface BuildOutputEnvelopeInput {
  summary: string;
  content?: readonly OutputContentItem[];
  state?: OutputEnvelopeState;
  incomplete?: OutputEnvelopeIncomplete;
  error?: OutputEnvelopeError;
  metrics?: OutputExecutionMetrics;
}

type UnaccountedOutputContentKind = Exclude<OutputContentItem['kind'], 'reference' | 'evidence-reference' | 'replay-state'>;
const ACCOUNTING_IS_EXHAUSTIVE: [UnaccountedOutputContentKind] extends [never] ? true : never = true;

function assertNever(value: unknown): never {
  throw new Error(`unaccounted output content kind: ${String((value as { kind?: unknown }).kind)}`);
}

/**
 * Inline wire cost for one content item. There is intentionally no default
 * branch: module augmentation that adds a content kind makes this switch fail
 * typecheck until that kind receives an explicit accounting case.
 */
export function accountOutputContentItem(item: OutputContentItem): number {
  // This seemingly-unused constant is the augmentation tripwire: when another
  // module adds a union kind but this function has no case, its type changes
  // from `true` to `never` and this module fails typecheck.
  void ACCOUNTING_IS_EXHAUSTIVE;
  switch (item.kind) {
    case 'reference':
    case 'evidence-reference':
    case 'replay-state':
      return Buffer.byteLength(JSON.stringify(item), 'utf8');
  }
  return assertNever(item);
}

function requireReference(item: OutputReferenceContentItem | OutputEvidenceReferenceContentItem): void {
  if (!item.uri.trim()) throw new TypeError('output reference uri must be non-empty');
  if (!Number.isSafeInteger(item.byteCount) || item.byteCount < 0) {
    throw new TypeError('output reference byteCount must be a non-negative safe integer');
  }
  if (!/^[0-9a-f]{64}$/i.test(item.sha256)) {
    throw new TypeError('output reference sha256 must be 64 hexadecimal characters');
  }
}

function requireJsonValue(value: unknown, path: string, seen: Set<object>): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${path} must be a finite number`);
    return;
  }
  if (typeof value !== 'object') throw new TypeError(`${path} contains non-JSON ${typeof value}`);
  if (seen.has(value)) throw new TypeError(`${path} contains a cycle`);
  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, index)) {
        throw new TypeError(`${path}[${index}] is a sparse array slot`);
      }
      requireJsonValue(value[index], `${path}[${index}]`, seen);
    }
    seen.delete(value);
    return;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new TypeError(`${path} must be a plain JSON object`);
  }
  for (const [key, child] of Object.entries(value)) {
    requireJsonValue(child, `${path}.${key}`, seen);
  }
  if (Object.keys(value).length !== Reflect.ownKeys(value).length) {
    throw new TypeError(`${path} contains non-enumerable or symbol properties`);
  }
  seen.delete(value);
}

function requireReplayState(item: OutputReplayStateContentItem): void {
  if (typeof item.values !== 'object' || item.values === null || Array.isArray(item.values)) {
    throw new TypeError('replay-state values must be a plain JSON object');
  }
  requireJsonValue(item.values, 'replay-state.values', new Set());
}

/** Validate and construct an envelope without inventing summary prose. */
export function buildOutputEnvelope(
  input: BuildOutputEnvelopeInput,
  policy: { summaryBudgetChars: number } = {
    summaryBudgetChars: DEFAULT_OUTPUT_SUMMARY_BUDGET_CHARS,
  },
): OutputEnvelope {
  if (!Number.isSafeInteger(policy.summaryBudgetChars) || policy.summaryBudgetChars < 0) {
    throw new TypeError('summaryBudgetChars must be a non-negative safe integer');
  }
  if (input.summary.length > policy.summaryBudgetChars) {
    throw new RangeError(
      `authored summary is ${input.summary.length} chars; budget is ${policy.summaryBudgetChars}`,
    );
  }

  const state = input.state ?? 'complete';
  if (state === 'error' && !input.error) throw new TypeError('error state requires error detail');
  if (state === 'incomplete' && !input.incomplete) {
    throw new TypeError('incomplete state requires incomplete detail');
  }
  if (state !== 'error' && input.error) throw new TypeError('error detail requires error state');
  if (state !== 'incomplete' && input.incomplete) {
    throw new TypeError('incomplete detail requires incomplete state');
  }

  const content = [...(input.content ?? [])];
  for (const item of content) {
    switch (item.kind) {
      case 'reference':
      case 'evidence-reference':
        requireReference(item);
        continue;
      case 'replay-state':
        requireReplayState(item);
        continue;
    }
    assertNever(item);
  }
  const summaryBytes = Buffer.byteLength(input.summary, 'utf8');
  const contentBytes = content.reduce((sum, item) => sum + accountOutputContentItem(item), 0);

  return {
    schemaVersion: OUTPUT_ENVELOPE_SCHEMA_VERSION,
    summary: input.summary,
    summaryProvenance: 'authored',
    content,
    state,
    ...(input.incomplete ? { incomplete: { ...input.incomplete } } : {}),
    ...(input.error ? { error: { ...input.error } } : {}),
    metrics: { ...(input.metrics ?? {}) },
    accounting: {
      summaryChars: input.summary.length,
      summaryBytes,
      contentBytes,
      totalBytes: summaryBytes + contentBytes,
      summaryBudgetChars: policy.summaryBudgetChars,
    },
  };
}
