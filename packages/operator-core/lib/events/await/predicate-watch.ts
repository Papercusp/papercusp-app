/**
 * Predicate watches — engine-side "wake me when <tool result crosses a threshold>"
 * (fleet-deltas-leader-primitives-2026-07-10 P-008; table: migration 541).
 *
 * The registration surface is `watch:create { predicate, interval_sec }`. The engine
 * polls a READ-ONLY projected tool every interval under THE REGISTRANT'S ROLE
 * ENVELOPE (the role gate is enforced on every poll — gateBypass covers only
 * capability + quota), extracts a dot-path from the result, compares it with an op
 * against a stored operand, and on a false→true EDGE fires the paired await row via
 * `emitAwaitedEvent({ key: 'predicate:<id>' })` — so floors, coalescing, once
 * semantics, timeout-wake and delivery all reuse the existing wake machinery for
 * free. Kills the polling-vigil pattern (a leader burning wake turns re-reading a
 * watermark).
 *
 * Lifecycle is self-cleaning: rows deactivate on fire (once), on 5 consecutive poll
 * errors (with a predicateError emit so the waiter wakes instead of dangling), and
 * by GC when the paired event_awaits registration dies (cancelled / consumed /
 * timed out / TTL-lapsed) — events:cancel needs no coupling to this table.
 *
 * Poll claiming is stamp-based (`last_polled_at = now()` inside FOR UPDATE SKIP
 * LOCKED) so the multiple hosts that run this poller (dev shell, :3170, :3070)
 * never double-poll a row in the same window.
 *
 * fleet-reliability-verification-2026-07-10 P-004: `findMatchingActivePredicateWatch`
 * adds registration-time DEDUPE — a second caller registering the identical
 * predicate joins the existing row's poller instead of starting a second one (the
 * exact repro this closes: two agents each independently polling the same watermark
 * SQL ~12+ times during the 2026-07-09/10 night shift).
 */

import { getOrgPg, withWorkspace } from '@papercusp/db-org';
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';
import { managedSetInterval } from '@papercusp/scheduled-registry';
import { lookupByMcpName, dispatchProjectedTool, type UnifiedToolContext } from '@papercusp/agent-mcp';
import { PROJECTED_DEPS } from '../../projected-tool-deps';
import { emitAwaitedEvent } from './engine';
import { listCellsUnchecked, canReadCell } from '../../cell-registry';
import { assertLifecycleBinding, withLifecycleBindingProvenance } from './store';
import type { LifecycleBinding } from './types';

/* eslint-disable @typescript-eslint/no-explicit-any */

const POLL_TICK_MS = 10_000;
const POLL_BATCH_LIMIT = 20;
/** After this many consecutive poll errors the row deactivates AND emits a
 *  predicateError payload on its key, so the waiter wakes instead of dangling. */
export const PREDICATE_MAX_CONSECUTIVE_ERRORS = 5;

export const PREDICATE_OPS = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'exists', 'contains', 'changed'] as const;
export type PredicateOp = (typeof PREDICATE_OPS)[number];

/**
 * The prior observation a BASELINE-RELATIVE op (`changed`) compares against.
 *
 * `established` is NOT `value !== null`: the `last_value` column is null both when
 * a row has never been polled AND when it was polled and legitimately observed
 * null. Only `last_eval` distinguishes them (it is null exclusively before the
 * first evaluation), so that is what the caller must derive this from. Collapsing
 * the two would make a never-polled row indistinguishable from one whose baseline
 * really is null — and `changed` would then fire on its very first observation,
 * which is the false all-clear this whole module is built to refuse.
 */
export interface PredicateBaseline {
  /** Has ANY evaluation been recorded for this row yet? (`row.lastEval !== null`) */
  established: boolean;
  /** The value recorded by that evaluation (`row.lastValue`); meaningless unless established. */
  value: unknown;
}

export interface PredicateWatchRow {
  id: string;
  workspaceId: string;
  ownerId: string;
  role: string;
  harnessSlug: string | null;
  eventKey: string;
  tool: string;
  args: Record<string, unknown>;
  path: string;
  op: PredicateOp;
  value: unknown;
  intervalSec: number;
  once: boolean;
  lastEval: boolean | null;
  lastValue: unknown;
  lastPolledAt: string | null;
  lastError: string | null;
  consecutiveErrors: number;
  active: boolean;
  createdAt: string;
  boundTo: LifecycleBinding | null;
}

function log(msg: string): void {
  console.error(`[predicate-watch] ${msg}`);
}

/** jsonb arrives parsed OR as text depending on the postgres-js client config
 *  (the repo's known sql.json quirk) — tolerate both. */
/**
 * Read a `jsonb` column back into a JS value.
 *
 * ⚠ THE DRIVER HAS ALREADY PARSED IT — RE-PARSING IS THE BUG THIS COMMENT EXISTS TO
 * PREVENT A RETURN OF (found by P-005's end-to-end,
 * agent-state-plane-verification-2026-07-27).
 *
 * `postgres` decodes `jsonb` for us: an object arrives as an object, a number as a
 * number, and A JSON STRING ARRIVES AS A BARE JS STRING. The previous implementation
 * saw `typeof v === 'string'` and ran `JSON.parse` on it a second time, which is wrong
 * in two different directions and silent in both:
 *
 *   • a string that is NOT valid JSON — every sha, path, ref, owner id and cell name
 *     we actually store — threw and was swallowed into `null`;
 *   • a string that IS valid JSON was silently RETYPED: `"123"` came back as the
 *     number 123, `"true"` as a boolean, `"null"` as null.
 *
 * The operand round-trip is what made it dangerous rather than merely lossy. With
 * `value` nulled, `comparePredicate(observed, 'eq', null)` can never match — so
 * `state:subscribe { on:{ op:'eq', value:'<sha>' } }` never fires, forever, silently.
 * And `'ne'` inverts it into the worse failure: `!absent && !deepEq(observed, null)` is
 * TRUE on the very first poll that observes anything, so "wake me when the deployed sha
 * CHANGES" fired IMMEDIATELY and told the agent a deploy had landed that had not. That
 * is precisely the false all-clear `comparePredicate`'s own absent-evidence rule was
 * written to refuse — reached through the OPERAND instead of through the path.
 *
 * It survived because every pre-existing test used a NUMBER or a BOOLEAN operand, and
 * those take the `return v as T` branch that was always correct.
 */
function parseJsonb<T>(v: unknown): T | null {
  return v == null ? null : (v as T);
}

function mapRow(r: any): PredicateWatchRow {
  return {
    id: String(r.id),
    workspaceId: r.workspace_id,
    ownerId: r.owner_id,
    role: r.role,
    harnessSlug: r.harness_slug ?? null,
    eventKey: r.event_key,
    tool: r.tool,
    args: parseJsonb<Record<string, unknown>>(r.args) ?? {},
    path: r.path,
    op: r.op as PredicateOp,
    value: parseJsonb(r.value),
    intervalSec: Number(r.interval_sec),
    once: Boolean(r.once),
    lastEval: r.last_eval == null ? null : Boolean(r.last_eval),
    lastValue: parseJsonb(r.last_value),
    lastPolledAt: r.last_polled_at ? new Date(r.last_polled_at).toISOString() : null,
    lastError: r.last_error ?? null,
    consecutiveErrors: Number(r.consecutive_errors ?? 0),
    active: Boolean(r.active),
    createdAt: new Date(r.created_at).toISOString(),
    boundTo: parseJsonb<LifecycleBinding>(r.bound_to),
  };
}

/* ── Pure helpers (unit-tested) ────────────────────────────────────────────── */

/** Dot-path extraction: `counts.open`, `rows.0.status`. Array indices are plain
 *  numeric segments. Missing anywhere along the path ⇒ undefined. */
export function valueAtPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const seg of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

function deepEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/** A Git SHA may be abbreviated, but comparing a short prefix to a full SHA as
 * though they were unrelated values turns `ne` into an instant false-positive.
 * Keep this guard deliberately narrow: both values must look like hexadecimal
 * SHA tokens, and one must be a strict prefix of the other. */
const HEX_SHA_TOKEN = /^[0-9a-f]{7,64}$/i;

export interface PredicateShaShapeMismatch {
  observedWidth: number;
  operandWidth: number;
}

export function predicateShaShapeMismatch(observed: unknown, operand: unknown): PredicateShaShapeMismatch | null {
  if (typeof observed !== 'string' || typeof operand !== 'string') return null;
  const observedSha = observed.trim();
  const operandSha = operand.trim();
  if (!HEX_SHA_TOKEN.test(observedSha) || !HEX_SHA_TOKEN.test(operandSha)) return null;
  if (observedSha.length === operandSha.length) return null;

  const short = observedSha.length < operandSha.length ? observedSha : operandSha;
  const long = observedSha.length < operandSha.length ? operandSha : observedSha;
  if (!long.toLowerCase().startsWith(short.toLowerCase())) return null;
  return { observedWidth: observedSha.length, operandWidth: operandSha.length };
}

export function predicateShaShapeMismatchMessage(mismatch: PredicateShaShapeMismatch): string {
  return `predicate_shape_mismatch: observed hex SHA is ${mismatch.observedWidth} characters but the operand is ${mismatch.operandWidth} characters; they are strict-prefix forms. Supply the same SHA width before registering this predicate.`;
}

/** Evaluate `observed <op> value`. Numeric ops coerce both sides via Number()
 *  and are false on non-finite operands (never throw on a shape surprise).
 *
 *  ⚠ ABSENT EVIDENCE MUST NEVER SATISFY A PREDICATE. A watch fires a WAKE, so a
 *  spurious true is not a vague answer — it is a false all-clear that resumes an
 *  agent on a condition that was never established. Every op is therefore false
 *  on an absent observation unless absence is what you explicitly asked about:
 *
 *    - `exists`  — the explicit way to ask "is there a value at all".
 *    - `eq` with `value: null` — the explicit way to ask "is it UNKNOWN".
 *    - `gt/gte/lt/lte` — already false via the non-finite guard.
 *    - `contains` — already false on a non-string/non-array.
 *    - `ne`      — see below.
 *
 *  `ne` is the one that bit: it is the natural way to write a readiness wait
 *  ("wake me when `blocked` is no longer true"), and a bare `!deepEq` made BOTH
 *  `null` (a 3-valued cell reporting UNKNOWN) and `undefined` (a MISSPELLED
 *  path) compare not-equal, so the watch fired immediately and the caller could
 *  not tell that wake from a real one. A typo'd path was a guaranteed instant
 *  false wake. This is the same defect class as `systemctl is-active` printing
 *  `inactive` for a unit that does not exist — see systemd-service-probe.ts.
 *  To wait for "definitely not X", the observation must BE something.
 *
 *  ── `changed` IS BASELINE-RELATIVE, AND THAT IS WHY IT EXISTS ───────────────
 *
 *  Every other op compares the observation to an OPERAND the caller supplied.
 *  `changed` compares it to the PREVIOUS OBSERVATION (`baseline`), so the caller
 *  supplies no operand at all. That difference is the point (P-004): expressing
 *  "wake me when this moves" with `ne` requires transcribing the value's current
 *  reading into the subscription, which (a) is the transcription anti-pattern the
 *  state plane exists to remove and (b) races — if the value moves between the
 *  read and the subscribe, the watch is armed against a stale operand and never
 *  fires. A measurement of 300 state:subscribe calls found 23 of the 50 failures
 *  were agents reaching for this operator; it was the largest single class.
 *
 *  It obeys the absent-evidence rule twice over, and both guards are load-bearing:
 *    - NO BASELINE ⇒ false. Before the first evaluation there is nothing to have
 *      changed FROM. Without this, `changed` fires on its own registration eval —
 *      an instant false wake, the precise defect `ne` was fixed for above.
 *    - ABSENT OBSERVATION ⇒ false. A value that became unreadable is a loss of
 *      evidence, not an observed change. (A baseline that WAS null and is now a
 *      real value does fire: the observation is present, and "it appeared" is a
 *      genuine change.)
 *
 *  Because it is evaluated per poll against the immediately preceding poll, a
 *  `once:false` watch fires on EVERY change rather than latching after the first.
 *  A value that departs and returns between two polls (A→B→A) is not observed as
 *  changed — inherent to polling, not to this op. */
export function comparePredicate(
  observed: unknown,
  op: PredicateOp,
  value: unknown,
  baseline?: PredicateBaseline,
): boolean {
  const absent = observed === undefined || observed === null;
  // A short/full SHA pair is not evidence of inequality. Refuse to manufacture
  // a true `ne` result here even for callers that use this pure helper directly;
  // evalPredicateWatch adds the registration-time, width-naming error. `exists`
  // and `changed` have no operand domain, so they are intentionally exempt.
  if (op !== 'exists' && op !== 'changed' && predicateShaShapeMismatch(observed, value)) return false;
  switch (op) {
    case 'exists':
      return !absent;
    case 'changed':
      if (!baseline?.established) return false;
      return !absent && !deepEq(observed, baseline.value);
    case 'eq':
      return deepEq(observed, value);
    case 'ne':
      // Absence establishes nothing, so it can never satisfy "is not X".
      // Ask about absence with `exists`, or about UNKNOWN with `eq value:null`.
      return !absent && !deepEq(observed, value);
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const a = Number(observed);
      const b = Number(value);
      if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
      if (op === 'gt') return a > b;
      if (op === 'gte') return a >= b;
      if (op === 'lt') return a < b;
      return a <= b;
    }
    case 'contains': {
      if (typeof observed === 'string') return observed.includes(String(value));
      if (Array.isArray(observed)) return observed.some((el) => deepEq(el, value));
      return false;
    }
  }
}

/** Pull the comparable payload out of a ToolResult: structuredContent when present,
 *  else a tolerant JSON.parse of the first text content block (raw string if it
 *  isn't JSON). */
export function extractToolPayload(result: unknown): unknown {
  const r = result as { structuredContent?: unknown; content?: Array<{ type?: string; text?: string }> } | null;
  if (r == null) return null;
  if (r.structuredContent !== undefined) return r.structuredContent;
  const text = r.content?.[0]?.text;
  if (typeof text === 'string') {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return r;
}

/**
 * Resolver results stay inside the process and are reduced to one registered path
 * before anything reaches an agent. They therefore need both payload-tier bypasses:
 * the resolved tier prevents ordinary shaping, while `transportCapExempt` prevents
 * the 30KB transport ceiling from force-applying a smallest-tier projection first.
 */
export const INTERNAL_MACHINE_DISPATCH_PAYLOAD_CONTEXT = {
  contextTier: 'full',
  payloadTierOverride: 'full',
  transportCapExempt: true,
} as const;

/* ── Store ─────────────────────────────────────────────────────────────────── */

export async function registerPredicateWatch(input: {
  /** Pre-generated id — the caller registers the await on `predicate:<id>` FIRST
   *  (GC safety: a row must never exist without its paired await). */
  id: string;
  workspaceId: string;
  ownerId: string;
  /** The registrant's role — every poll dispatches under THIS role with the role
   *  gate enforced. */
  role: string;
  harnessSlug?: string | null;
  eventKey: string;
  tool: string;
  args?: Record<string, unknown>;
  path: string;
  op: PredicateOp;
  value?: unknown;
  intervalSec?: number;
  once?: boolean;
  /** Lifecycle owner for auto/suggested-armed rows. Manual watches omit it. */
  boundTo?: LifecycleBinding | null;
}): Promise<PredicateWatchRow> {
  const { sql } = getOrgPg();
  const rows = input.boundTo
    ? await sql`
        INSERT INTO harness_shared.predicate_watches
          (id, workspace_id, owner_id, role, harness_slug, event_key, tool, args, path, op, value,
           interval_sec, once, last_polled_at, bound_to)
        VALUES
          (${input.id}, ${input.workspaceId}, ${input.ownerId}, ${input.role},
           ${input.harnessSlug ?? null}, ${input.eventKey}, ${input.tool},
           ${JSON.stringify(input.args ?? {})}::text::jsonb, ${input.path}, ${input.op},
           ${input.value === undefined ? null : JSON.stringify(input.value)}::text::jsonb,
           ${input.intervalSec ?? 60}, ${input.once ?? true}, now(),
           ${JSON.stringify(assertLifecycleBinding(input.boundTo))}::text::jsonb)
        RETURNING *
      `
    : await sql`
        INSERT INTO harness_shared.predicate_watches
          (id, workspace_id, owner_id, role, harness_slug, event_key, tool, args, path, op, value,
           interval_sec, once, last_polled_at)
        VALUES
          (${input.id}, ${input.workspaceId}, ${input.ownerId}, ${input.role},
           ${input.harnessSlug ?? null}, ${input.eventKey}, ${input.tool},
           ${JSON.stringify(input.args ?? {})}::text::jsonb, ${input.path}, ${input.op},
           ${input.value === undefined ? null : JSON.stringify(input.value)}::text::jsonb,
           ${input.intervalSec ?? 60}, ${input.once ?? true}, now())
        RETURNING *
      `;
  return mapRow(rows[0]);
}

export async function getPredicateWatch(id: string): Promise<PredicateWatchRow | null> {
  const { sql } = getOrgPg();
  const rows = await sql`SELECT * FROM harness_shared.predicate_watches WHERE id = ${id}`;
  return rows.length > 0 ? mapRow(rows[0]) : null;
}

/**
 * EI-8998 dedup (fleet-reliability-verification-2026-07-10 P-004): find an ACTIVE row
 * already polling the IDENTICAL predicate — same authority scope (workspace/role/
 * harness, since a poll dispatches under the REGISTRANT's role envelope and must
 * never silently borrow a different registrant's authority) and the same poll target
 * + cardinality (tool/args/path/op/value/interval_sec/once). jsonb equality is
 * structural (key order doesn't matter), so `args`/`value` compare correctly without
 * a canonicalization step.
 *
 * Best-effort, not a hard DB constraint: two registrations racing within the same
 * tick can still each insert a row (no unique index backs this), but the motivating
 * repro — two agents independently registering the same watermark predicate minutes
 * apart during a vigil — collapses to ONE polled row. The caller (watch:create) is
 * responsible for attaching the new subscriber's `event_awaits` row to the MATCH's
 * `eventKey` instead of calling `registerPredicateWatch` again.
 */
export async function findMatchingActivePredicateWatch(input: {
  workspaceId: string;
  role: string;
  harnessSlug?: string | null;
  tool: string;
  args?: Record<string, unknown>;
  path: string;
  op: PredicateOp;
  value?: unknown;
  intervalSec?: number;
  once?: boolean;
}): Promise<PredicateWatchRow | null> {
  const { sql } = getOrgPg();
  const rows = await sql`
    SELECT * FROM harness_shared.predicate_watches
     WHERE active
       AND workspace_id = ${input.workspaceId}
       AND role = ${input.role}
       AND harness_slug IS NOT DISTINCT FROM ${input.harnessSlug ?? null}
       AND tool = ${input.tool}
       AND args = ${JSON.stringify(input.args ?? {})}::text::jsonb
       AND path = ${input.path}
       AND op = ${input.op}
       AND value IS NOT DISTINCT FROM ${input.value === undefined ? null : JSON.stringify(input.value)}::text::jsonb
       AND interval_sec = ${input.intervalSec ?? 60}
       AND once = ${input.once ?? true}
     ORDER BY created_at ASC
     LIMIT 1
  `;
  return rows.length > 0 ? mapRow(rows[0]) : null;
}

/** Claim-by-stamp the due rows (active + past their interval), FOR UPDATE SKIP
 *  LOCKED so concurrent host pollers split the set instead of double-polling. */
export async function claimDuePredicateWatches(limit = POLL_BATCH_LIMIT): Promise<PredicateWatchRow[]> {
  const { sql } = getOrgPg();
  const rows = await sql`
    UPDATE harness_shared.predicate_watches
       SET last_polled_at = now()
     WHERE id IN (
       SELECT id FROM harness_shared.predicate_watches
        WHERE active
          AND (last_polled_at IS NULL OR last_polled_at < now() - make_interval(secs => interval_sec))
        ORDER BY last_polled_at ASC NULLS FIRST
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
     )
    RETURNING *
  `;
  return rows.map(mapRow);
}

/** Deactivate rows whose paired await registration is gone. A once-await is live
 *  while unfired+uncancelled; a standing await is live while uncancelled and
 *  unexpired (standing fires never set fired_at — they match without consuming). */
export async function gcOrphanedPredicateWatches(): Promise<number> {
  const { sql } = getOrgPg();
  const rows = await sql`
    UPDATE harness_shared.predicate_watches pw
       SET active = false,
           last_error = coalesce(pw.last_error, 'gc: paired event_awaits registration gone (cancelled/consumed/expired)')
     WHERE pw.active
       AND NOT EXISTS (
         SELECT 1 FROM harness_shared.event_awaits ea
          WHERE ea.workspace_id = ${DEFAULT_COORD_WORKSPACE}
            AND ea.event_key = pw.event_key
            AND ea.cancelled_at IS NULL
            AND ((ea.once = true AND ea.fired_at IS NULL)
              OR (ea.once = false AND (ea.expires_ts IS NULL OR ea.expires_ts > now())))
       )
    RETURNING pw.id
  `;
  return rows.length;
}

async function recordPredicateEval(
  id: string,
  input: { lastEval: boolean; lastValue: unknown; deactivate: boolean },
): Promise<void> {
  const { sql } = getOrgPg();
  await sql`
    UPDATE harness_shared.predicate_watches
       SET last_eval = ${input.lastEval},
           last_value = ${input.lastValue === undefined ? null : JSON.stringify(input.lastValue)}::text::jsonb,
           last_polled_at = now(),
           last_error = NULL,
           consecutive_errors = 0,
           active = active AND NOT ${input.deactivate}
     WHERE id = ${id}
  `;
}

async function recordPredicateError(id: string, message: string, deactivate: boolean): Promise<void> {
  const { sql } = getOrgPg();
  await sql`
    UPDATE harness_shared.predicate_watches
       SET last_error = ${message.slice(0, 2000)},
           last_polled_at = now(),
           consecutive_errors = consecutive_errors + 1,
           active = active AND NOT ${deactivate}
     WHERE id = ${id}
  `;
}

/* ── Dispatch (the role-enveloped poll) ────────────────────────────────────── */

export type PredicateDispatchFn = (row: PredicateWatchRow) => Promise<unknown>;

let dispatchOverride: PredicateDispatchFn | null = null;

/** Test seam: replace the projected-tool dispatch with a fake (null restores). */
export function configurePredicateDispatch(fn: PredicateDispatchFn | null): void {
  dispatchOverride = fn;
}

/**
 * The role envelope a read-only tool dispatch runs under. Deliberately small: every
 * field is already known at both call sites, so resolving one costs no lookup.
 */
/**
 * A read-only dispatch that did not produce a value, carrying the dispatcher's OWN
 * error code rather than a flattened string.
 *
 * `message` is deliberately `"<code>: <message>"` — byte-identical to what the
 * predicate poller recorded before this was extracted, so `last_error` rows and the
 * 5-consecutive-errors deactivation are unchanged. The `code` is the ADDITION: the
 * cell read has to distinguish "you may not read through this resolver" from "the
 * measurement failed", and those demand opposite caller responses. Flattening a
 * branchable code into prose is precisely the defect `cell-contract.ts` exists to
 * prevent — preserved for a human reader, destroyed for a program.
 */
export class ReadOnlyDispatchError extends Error {
  override readonly name = 'ReadOnlyDispatchError';
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Dispatcher codes that mean THE CALLER MAY NOT READ THROUGH THIS TOOL, as opposed to
 * the measurement having been attempted and failed. Enumerated from
 * `DispatchProjectedErrorCode`'s access family (dispatch-stack.ts) rather than matched
 * on message text.
 *
 * The distinction is load-bearing for a cell read (D-058): an access refusal is NOT
 * retryable by this caller — the lever is to obtain the role, or to ask a peer who has
 * it — whereas a resolver failure is retry-or-escalate. Reporting one as the other
 * sends the reader down the wrong path.
 */
const ACCESS_DENIED_CODES = new Set([
  'role_not_allowed',
  'missing_role',
  'missing_capability',
  'capability_denied',
  'authorization_denied',
  'unauthorized',
  'ungated',
]);

/** True when a failed read-only dispatch was refused for ACCESS, not measurement. */
export function isAccessDenialCode(code: string): boolean {
  return ACCESS_DENIED_CODES.has(code);
}

export interface ReadOnlyDispatchEnv {
  workspaceId: string;
  harnessSlug: string | null;
  /** The role the call runs under. NOT bypassed — see `dispatchReadOnlyTool`. */
  role: string;
  /** Who the dispatch is on behalf of. Audit only (the principal slug). */
  onBehalfOf: string;
  /** `tool_invocations.spawn_id` for the audit row — names the calling subsystem. */
  spawnId: string;
  /** Optional caller-owned cancellation. The dispatch remains unbounded when omitted. */
  signal?: AbortSignal;
  /** An interactive wearer supplies their real authority. Unlike internal watches,
   * this path keeps capability, quota and kernel gates enabled. */
  callerContext?: UnifiedToolContext;
}

/**
 * ONE dispatch of a READ-ONLY projected tool under a caller's role envelope.
 *
 * Extracted from `dispatchPredicateTool` (unified-agent-state-plane-2026-07-27 P-004 /
 * D-058) so the synchronous cell read (`cell-read.ts` → `state:read`) and the poller
 * share ONE derivation rather than two dispatches that can drift on the security
 * properties below. That is D-038 axis 5 applied to the dispatch itself: the poller is
 * now a lens on this, not a second implementation.
 *
 * TWO PROPERTIES ARE LOAD-BEARING AND MUST NOT BE RELAXED BY EITHER CALLER:
 *
 *  1. READ-ONLY. A tool whose `effect` is anything but `read` is REFUSED. A cell
 *     resolver is a measurement; if reading a cell could mutate, "read it at the
 *     moment of acting" — the whole justification for cells — would be unsafe advice.
 *  2. THE ROLE GATE IS ENFORCED. `gateBypass` covers ONLY { capability, quota }; the
 *     call runs under the SUPPLIED role, so a role that loses access to the tool stops
 *     being able to read through it. This is a SECOND access gate, independent of
 *     `canReadCell` — the two can disagree, and D-058 requires that disagreement be
 *     rendered as an enumerated unknown rather than swallowed.
 *
 * Audited via tool_invocations like every dispatch. Throws on refusal or failure; the
 * caller decides whether that is an error or an unknown. A caller may supply `signal`
 * to cancel cooperative projected tools, but this shared primitive deliberately does
 * not impose one universal deadline: a synchronous cell read and a background
 * predicate poll have different latency budgets.
 */
export async function dispatchReadOnlyTool(
  tool: string,
  args: Record<string, unknown>,
  env: ReadOnlyDispatchEnv,
): Promise<unknown> {
  const projected = lookupByMcpName(tool);
  if (!projected) throw new ReadOnlyDispatchError('unknown_tool', `unknown tool "${tool}"`);
  if (projected.effect !== 'read') {
    throw new ReadOnlyDispatchError(
      'not_read_only',
      `tool "${tool}" is not read-only (effect=${projected.effect ?? 'unset'})`,
    );
  }
  const caller = env.callerContext;
  if (caller && (!caller.principal || caller.workspaceId !== env.workspaceId ||
      caller.principal.workspaceId !== env.workspaceId || caller.role !== env.role ||
      (caller.harnessSlug ?? null) !== env.harnessSlug)) {
    throw new ReadOnlyDispatchError('capability_denied', 'cell reader authority does not match its dispatch scope');
  }
  if (env.signal?.aborted || caller?.signal.aborted) {
    throw new ReadOnlyDispatchError('dispatch_failed', 'cell read was cancelled before dispatch');
  }
  const result = await withWorkspace(env.workspaceId, async (tx) => {
    if (caller) {
      // Never inherit an internal caller's bypass flags, nor replace the wearer
      // with a system principal. The normal dispatcher rechecks live authority.
      const ctx: UnifiedToolContext = {
        ...caller,
        ...INTERNAL_MACHINE_DISPATCH_PAYLOAD_CONTEXT,
        gateBypass: undefined,
        isSuperuser: false,
        signal: env.signal ?? caller.signal,
        tx,
      };
      return dispatchProjectedTool(projected, tool, args, ctx, PROJECTED_DEPS);
    }
    const ctx: UnifiedToolContext = {
      workspaceId: env.workspaceId,
      harnessSlug: env.harnessSlug ?? '*',
      role: env.role,
      featureId: null,
      chunkId: null,
      runId: globalThis.crypto.randomUUID(),
      spawnId: env.spawnId,
      parentSpawnId: null,
      uiClientId: null,
      isSuperuser: false,
      gateBypass: { capability: true, quota: true },
      profile: 'engineer',
      transport: 'in_process',
      // Cells and predicate watches are MACHINE consumers: they project one
      // registered path after dispatch. Session-tier shaping before that
      // projection can omit the very path they declared and manufacture an
      // `insufficient-data` result from a healthy resolver. Keep the internal
      // payload lossless; only the cell/watch result reaches the caller.
      ...INTERNAL_MACHINE_DISPATCH_PAYLOAD_CONTEXT,
      log: () => {},
      progress: () => {},
      emit: () => {},
      signal: env.signal ?? new AbortController().signal,
      principal: {
        slug: `system:${env.spawnId}:${env.onBehalfOf}`,
        workspaceId: env.workspaceId,
        capabilities: new Set(['*']),
      },
      tx,
    };
    return dispatchProjectedTool(projected, tool, args, ctx, PROJECTED_DEPS);
  });
  if (!result.ok) {
    // Message text is UNCHANGED from before the extraction, so predicate_watches'
    // `last_error` + the consecutive-error deactivation behave identically; the `code`
    // is carried alongside rather than in place of it.
    throw new ReadOnlyDispatchError(
      result.error?.code ?? 'dispatch_failed',
      result.error ? `${result.error.code}: ${result.error.message}` : 'dispatch failed',
    );
  }
  return extractToolPayload(result.result);
}

/**
 * WI-7060 — a background predicate resolver gets substantially more time than the
 * synchronous cell-read hot path, but it must not wedge the serial poller forever.
 * The env override accommodates legitimately slow read-only tools (for example a
 * large-history `git rev-list`) without weakening the termination guarantee.
 */
export const PREDICATE_DISPATCH_TIMEOUT_MS = Math.max(
  1,
  Number(process.env.PAPERCUSP_PREDICATE_DISPATCH_TIMEOUT_MS) || 60_000,
);

/**
 * Race one predicate dispatch against its caller-specific deadline. On expiry, abort
 * the signal so cooperative projected tools can release their own resources; the
 * race still rejects promptly when a tool ignores cancellation. The late work has an
 * attached rejection handler so a post-timeout failure cannot become unhandled.
 */
export async function withPredicateDispatchTimeout<T>(
  dispatch: (signal: AbortSignal) => Promise<T>,
  opts: { tool: string; timeoutMs?: number },
): Promise<T> {
  const timeoutMs = Math.max(1, opts.timeoutMs ?? PREDICATE_DISPATCH_TIMEOUT_MS);
  const controller = new AbortController();
  const work = Promise.resolve().then(() => dispatch(controller.signal));
  work.catch(() => {});

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new ReadOnlyDispatchError(
        'dispatch_timeout',
        `predicate resolver ("${opts.tool}") did not respond within ${timeoutMs}ms`,
      );
      // Settle the race with the stable typed error before abort listeners can reject
      // the underlying work with their own implementation-specific AbortError.
      reject(error);
      controller.abort(error);
    }, timeoutMs);
  });

  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** One bounded poll of the row's tool — a LENS on `dispatchReadOnlyTool`, not a second dispatch. */
export async function dispatchPredicateTool(
  row: PredicateWatchRow,
  timeoutMs = PREDICATE_DISPATCH_TIMEOUT_MS,
): Promise<unknown> {
  return withPredicateDispatchTimeout(
    (signal) => {
      // Keep the test seam INSIDE the deadline. A fake that never settles must prove
      // the canonical wrapper terminates rather than bypassing the very guard it tests.
      if (dispatchOverride) return dispatchOverride(row);
      return dispatchReadOnlyTool(row.tool, row.args, {
        workspaceId: row.workspaceId,
        harnessSlug: row.harnessSlug,
        role: row.role,
        onBehalfOf: row.ownerId,
        spawnId: 'predicate-watch',
        signal,
      });
    },
    { tool: row.tool, timeoutMs },
  );
}

/* ── POLL-TICK DISPATCH DEDUPE (P-012) ──────────────────────────────────────────
 * Registration dedupe (`findMatchingActivePredicateWatch`) already merges a second
 * caller onto an existing row — but only when path, op, value, interval AND once all
 * match too. Two agents watching the SAME cell for DIFFERENT thresholds are therefore
 * two rows, and each costs its own resolver dispatch every tick. That is the cost that
 * scales with fleet size once auto-arm fans a profile out across members (P-014), and
 * the read is the expensive half — the compare downstream of it is free.
 *
 * So the dispatch is shared across rows that agree on everything the READ depends on,
 * and only the compare stays per-row.
 *
 * ── WHY THE KEY IS WIDER THAN THE PLAN ITEM'S WORDING ─────────────────────────
 * P-012 says "(tool, canonical args hash)". That is NOT sufficient, and grouping on it
 * alone would be a privilege leak: `dispatchReadOnlyTool` runs under the row's role
 * envelope and ENFORCES the role gate as a second, independent access check (see its
 * contract — gateBypass covers only capability + quota). Two rows with identical
 * tool+args but different roles can legitimately get different outcomes: a value for
 * one, an access refusal for the other. Sharing across them would hand a denied watcher
 * a payload fetched under someone else's authority.
 *
 * The identity dimensions are exactly the ones `dispatchPredicateTool` reads off the
 * row: workspaceId, harnessSlug, role. `onBehalfOf` (ownerId) and `spawnId` do NOT
 * belong in the key — they are audit-only and cannot change the result.
 *
 * This is not a new security judgement. `findMatchingActivePredicateWatch` already
 * merges rows ACROSS OWNERS on (workspace, role, harness, tool, args), so the system
 * has already ratified that tuple as safe to share; this reuses it verbatim, minus the
 * downstream compare fields.
 *
 * ⚠ ONE DISCLOSED COST: N shared watchers produce ONE `tool_invocations` audit row,
 * attributed to the group's representative ownerId. Audit VOLUME therefore stops being
 * a proxy for watcher count — which is the point (that volume is the waste being
 * removed), but anything counting reads per agent from tool_invocations must read
 * `deduped` off the tick result instead of assuming one row per watcher.
 * ────────────────────────────────────────────────────────────────────────────── */

/** Field separator for the group key: a NUL, which cannot occur in a postgres text
 *  column, so no value can forge a field boundary by containing the delimiter. */
const GROUP_KEY_SEP = '\x00';

/** Recursively key-sort so args differing only in key ORDER share a group. Mirrors the
 *  jsonb equality that `findMatchingActivePredicateWatch` compares args with. */
function canonicalizeForKey(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeForKey);
  if (value && typeof value === 'object') {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) out[k] = canonicalizeForKey(src[k]);
    return out;
  }
  return value;
}

/** Monotonic source of never-colliding keys for the fail-safe branch below. */
let ungroupableSeq = 0;

/**
 * Canonical, order-insensitive key for a row's args.
 *
 * FAILS SAFE: if the args cannot be serialized (a cycle, a BigInt), this returns a
 * UNIQUE key so the row groups with nothing. Returning a shared sentinel instead would
 * silently pool rows whose args were never actually compared — a wrong shared read,
 * which is far worse than a missed optimisation.
 */
export function canonicalArgsKey(args: Record<string, unknown> | null | undefined): string {
  try {
    return JSON.stringify(canonicalizeForKey(args ?? {})) ?? `${GROUP_KEY_SEP}ungroupable:${++ungroupableSeq}`;
  } catch {
    return `${GROUP_KEY_SEP}ungroupable:${++ungroupableSeq}`;
  }
}

/**
 * The key rows must agree on to share ONE resolver dispatch in a tick: every input
 * `dispatchPredicateTool` actually uses, and nothing else.
 */
export function predicateDispatchGroupKey(row: PredicateWatchRow): string {
  return [
    row.workspaceId,
    row.harnessSlug ?? `${GROUP_KEY_SEP}null`,
    row.role,
    row.tool,
    canonicalArgsKey(row.args),
  ].join(GROUP_KEY_SEP);
}

/** A dispatch result shared by every row in one group — success, or the failure each
 *  row must then take through its OWN error accounting. */
export type PredicateDispatchOutcome =
  | { readonly ok: true; readonly payload: unknown }
  | { readonly ok: false; readonly error: unknown };

/* ── Eval + poller ─────────────────────────────────────────────────────────── */

export interface PredicateEvalResult {
  fired: boolean;
  matched: boolean;
  observed?: unknown;
  error?: string;
  deactivated: boolean;
}

/**
 * P-001 of state-plane-interest-and-hardening-2026-08-21 — the fire payload's
 * PLANE HANDLE. The wake was the one delivery surface in the state plane that
 * handed an agent a volatile value ({ observed }) without the cell that
 * re-answers it, at exactly the moment the agent is most likely to act on that
 * snapshot (it was woken BECAUSE of it). This derives the `reread` handle the
 * way state-plane-stamp derives door stamps: from the REGISTRY, never a stored
 * copy (D-038 axis 5 — a stored cell id would drift on a rename and keep
 * emitting a stale handle).
 *
 * Match: the poll-signalled cell whose changeSignal (tool, path) — or declared
 * materiality path, or declared ASSESSMENT path — equals this row's. All three
 * are subscribable targets (`state:subscribe`'s `target`), so all three must
 * derive the handle: a watch is registered against ONE concrete path, and a
 * target this function does not recognise silently loses its re-read handle at
 * exactly the wake this function exists to make re-readable. The assessment arm
 * matters most, because P-005 made assessment the DEFAULT target for an
 * operand-free subscription on an assessed cell — so omitting it would have
 * stripped the handle from the now-common case, not an exotic one. The
 * registration-time dedupe in the stamp module treats two cells declaring one
 * path as a registry defect; first match is deterministic here for the same reason.
 *
 * AUDIENCE (P-019): the handle is checked against the ROW'S OWN identity
 * (ownerId/role/harness) — a hand-rolled watch:create on the same (tool, path)
 * by a caller outside the cell's audience must not learn the cell exists, so
 * out-of-audience derives NO handle rather than leaking a name. A state:subscribe
 * registrant passed getCell() at registration, so their handle always derives.
 *
 * TOTAL — never throws, never blocks a fire: any failure (unregistered cells,
 * a missing subject for a caller-relative cell) degrades to `undefined`, i.e.
 * the pre-P-001 payload shape. An incomplete handle is worse than none
 * (state-plane-stamp's `unreadable` rule; here omission is the fail-safe).
 */
export function deriveCellReread(row: {
  tool: string;
  path: string;
  args: unknown;
  ownerId: string;
  role: string;
  harnessSlug: string | null;
}): { tool: 'state:read'; args: { cell: string; as?: string } } | undefined {
  try {
    const spec = listCellsUnchecked().find(
      (c) =>
        c.changeSignal.kind === 'poll' &&
        c.changeSignal.tool === row.tool &&
        (c.changeSignal.path === row.path ||
          c.materiality?.path === row.path ||
          c.assessment?.path === row.path),
    );
    if (!spec) return undefined;
    if (
      !canReadCell(spec, {
        ownerId: row.ownerId,
        roles: row.role ? [row.role] : [],
        harnessSlug: row.harnessSlug ?? undefined,
      })
    ) {
      return undefined;
    }
    const rel = spec.callerRelativity;
    if (rel.kind === 'parameter') {
      const subject = (row.args as Record<string, unknown> | null)?.[rel.param];
      if (typeof subject !== 'string' || subject.trim().length === 0) return undefined;
      return { tool: 'state:read', args: { cell: spec.cell, as: subject } };
    }
    return { tool: 'state:read', args: { cell: spec.cell } };
  } catch {
    return undefined;
  }
}

/**
 * One evaluation of one row: dispatch → extract → compare → EDGE-fire (matched
 * while last_eval was not true) the paired await via emitAwaitedEvent. `once`
 * rows deactivate on fire. Errors accumulate; the Nth consecutive one
 * deactivates AND emits a predicateError payload so the waiter wakes.
 */
export async function evalPredicateWatch(
  row: PredicateWatchRow,
  /**
   * A dispatch outcome already obtained for this row's GROUP (P-012). Omitted ⇒ the row
   * dispatches for itself, byte-for-byte as before.
   *
   * A shared FAILURE is deliberately re-thrown into this row's own catch rather than
   * short-circuited: every row must accrue its OWN consecutive-error count and reach its
   * own deactivation threshold. Collapsing that would let one row's error history
   * deactivate another agent's watch.
   */
  shared?: PredicateDispatchOutcome,
): Promise<PredicateEvalResult> {
  const dispatch = dispatchPredicateTool;
  try {
    if (shared && !shared.ok) throw shared.error;
    const payload = shared ? shared.payload : await dispatch(row);
    const observed = valueAtPath(payload, row.path);
    const shaShapeMismatch =
      row.op !== 'exists' && row.op !== 'changed' ? predicateShaShapeMismatch(observed, row.value) : null;
    if (shaShapeMismatch) throw new Error(predicateShaShapeMismatchMessage(shaShapeMismatch));
    // `lastEval !== null` is the ONLY honest "has this row ever been evaluated"
    // signal — `lastValue` is null for both a never-polled row and one that
    // observed null. See PredicateBaseline.
    const matched = comparePredicate(observed, row.op, row.value, {
      established: row.lastEval !== null,
      value: row.lastValue,
    });
    const edge = matched && row.lastEval !== true;
    const deactivate = edge && row.once;
    if (edge) {
      const reread = deriveCellReread(row);
      // A `changed` fire has no operand to report — what the reader needs is the
      // value it changed FROM, which is exactly the baseline it was compared to.
      // Reporting `value: null` there (the column's resting state for this op)
      // would read as "compared against null", which is not what happened.
      const isChanged = row.op === 'changed';
      await emitAwaitedEvent({
        key: row.eventKey,
        payload: withLifecycleBindingProvenance(
          {
            observed,
            predicate: {
              tool: row.tool,
              path: row.path,
              op: row.op,
              ...(isChanged ? { changedFrom: row.lastValue } : { value: row.value }),
            },
            // P-001: `observed` is FIRE-TIME and goes stale across the fire→delivery
            // lag (a parked session boots, a respawn queues). The handle re-answers it
            // from the same resolver at the moment of acting. Omitted when no
            // registered cell matches or the reader is out of its audience.
            ...(reread ? { reread } : {}),
          },
          row.boundTo,
        ),
        summary: `predicate matched: ${row.tool} ${row.path} ${row.op}${
          isChanged
            ? ` from ${String(JSON.stringify(row.lastValue)).slice(0, 200)}`
            : row.value === undefined
              ? ''
              : ` ${JSON.stringify(row.value)}`
        } (observed ${String(JSON.stringify(observed)).slice(0, 200)})`,
        source: `predicate-watch:${row.ownerId}`,
      });
    }
    await recordPredicateEval(row.id, { lastEval: matched, lastValue: observed, deactivate });
    return { fired: edge, matched, observed, deactivated: deactivate };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const deactivate = row.consecutiveErrors + 1 >= PREDICATE_MAX_CONSECUTIVE_ERRORS;
    await recordPredicateError(row.id, msg, deactivate);
    if (deactivate) {
      // The waiter must wake, not dangle — fire the key with an error payload.
      await emitAwaitedEvent({
        key: row.eventKey,
        payload: withLifecycleBindingProvenance(
          {
            predicateError: msg.slice(0, 500),
            predicate: { tool: row.tool, path: row.path, op: row.op, value: row.value },
          },
          row.boundTo,
        ),
        summary: `predicate watch DEACTIVATED after ${row.consecutiveErrors + 1} consecutive errors: ${msg.slice(0, 200)}`,
        source: `predicate-watch:${row.ownerId}`,
      });
    }
    return { fired: deactivate, matched: false, error: msg, deactivated: deactivate };
  }
}

/**
 * One poller tick: GC orphans, claim the due batch, then evaluate serially — but with
 * ONE resolver dispatch per `predicateDispatchGroupKey`, not one per row (P-012).
 *
 * `dispatches` and `deduped` are reported because the saving is otherwise invisible:
 * with dedupe working, `tool_invocations` no longer carries one read per watcher, so a
 * count taken from there would UNDER-report watchers rather than show the win.
 *
 * A single-row group takes the untouched path — it calls `evalPredicateWatch(row)` with
 * no shared outcome, so behaviour is identical to before this change unless two rows
 * genuinely agree on the whole dispatch identity. That keeps the blast radius of the
 * optimisation to exactly the case it targets, including for the `dispatchOverride`
 * test seam.
 */
export async function pollDuePredicateWatches(): Promise<{
  polled: number;
  fired: number;
  gc: number;
  /** Resolver dispatches actually issued this tick. */
  dispatches: number;
  /** Dispatches AVOIDED by sharing (polled − dispatches, for rows that grouped). */
  deduped: number;
}> {
  const gc = await gcOrphanedPredicateWatches();
  const due = await claimDuePredicateWatches();

  const groups = new Map<string, PredicateWatchRow[]>();
  for (const row of due) {
    const key = predicateDispatchGroupKey(row);
    const existing = groups.get(key);
    if (existing) existing.push(row);
    else groups.set(key, [row]);
  }

  const dispatch = dispatchPredicateTool;
  let fired = 0;
  let dispatches = 0;
  let deduped = 0;

  for (const rows of groups.values()) {
    const first = rows[0];
    if (!first) continue;

    if (rows.length === 1) {
      dispatches++;
      const r = await evalPredicateWatch(first);
      if (r.fired) fired++;
      continue;
    }

    // One read for the whole group. A throw here is CAPTURED, never propagated: each
    // row still has to record its own error and its own deactivation.
    let shared: PredicateDispatchOutcome;
    dispatches++;
    try {
      shared = { ok: true, payload: await dispatch(first) };
    } catch (error) {
      shared = { ok: false, error };
    }
    deduped += rows.length - 1;

    for (const row of rows) {
      const r = await evalPredicateWatch(row, shared);
      if (r.fired) fired++;
    }
  }

  return { polled: due.length, fired, gc, dispatches, deduped };
}

type Globals = typeof globalThis & { __papercuspPredicateWatchPollerStarted?: boolean };

/** Idempotent lazy start (mirrors startAwaitSweeper) — called at registration and
 *  from the agent-tools boot path so active rows survive a host restart. */
export function startPredicateWatchPoller(): void {
  const g = globalThis as Globals;
  if (g.__papercuspPredicateWatchPollerStarted) return;
  g.__papercuspPredicateWatchPollerStarted = true;
  managedSetInterval(
    'predicate-watch-poller',
    POLL_TICK_MS,
    () => {
      void pollDuePredicateWatches().catch((e) => log(`poll tick failed: ${e instanceof Error ? e.message : e}`));
    },
    { category: 'global-sweep' },
  );
}
