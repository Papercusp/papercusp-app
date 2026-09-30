/**
 * NAMED RESULT VIEWS — schema-stable recovery capsules with projection receipts.
 *
 * Plan: named-result-views-schema-stable-recovery-capsules-with-proj-2026-08-14 (P-001).
 *
 * WHY THIS EXISTS, stated against the two things that already work:
 *
 *  - Free-form `projection: { pick: [...] }` reduces ANY result, but the caller
 *    must re-type the field paths every time and nothing guarantees the same
 *    paths still mean the same thing next week. That is fine for an ad-hoc
 *    reduction and useless as a RECOVERY CAPSULE, which by definition is read
 *    by a successor who was not present when the paths were chosen.
 *  - `payloadTier` ('trimmed' | 'full') is coarse and lossy-by-shape: it decides
 *    how much, never exactly which fields.
 *
 * A named view is the missing third thing: a STABLE NAME that resolves to a
 * VERSIONED field-selection plus a byte budget, and reports back which version
 * applied. A cold successor asks for the name; the receipt tells it precisely
 * what it got. That is the whole mechanism.
 *
 * ADDITIVE BY CONSTRUCTION: when no view is named, nothing in this file runs and
 * behavior is byte-identical to today. It cannot regress an existing caller.
 *
 * REUSE: selection is delegated to `applyPick` — the same code path free-form
 * `pick` uses. This module owns the NAME -> (fields, budget, version) table and
 * the receipt; it deliberately implements no selection logic of its own, so a
 * fix to pick semantics is inherited here for free.
 */

import { applyPick } from './apply';
import type { ProjectionSpec } from './types';

/** The dispatch-level argument that names a view. Sibling of `PROJECTION_ARG`. */
export const VIEW_ARG = 'view' as const;

export interface NamedViewDef {
  /**
   * Bumped whenever `fields` or `budgetChars` changes. The receipt reports the
   * version that APPLIED, which is what makes a capsule schema-stable: a
   * successor comparing two capsules can tell "same name, different shape"
   * from "same name, same shape" without diffing the payloads.
   */
  version: number;
  /** Pick paths, in `applyPick` notation (`results[].id`, `gate.stalled`). */
  fields: string[];
  /**
   * Hard ceiling on the DELIVERED capsule text, in UTF-8 BYTES (the name is
   * historical; the unit is bytes — see the receipt's field docs). Enforced
   * AFTER selection at the capsule stage, and RE-enforced at the delivery seam
   * so the in-band receipt footer cannot push `content[0].text` past it
   * (capsule + footer ≤ budgetChars). Sized well under the result-door's own
   * cap so a capsule is not itself the thing that trips a spill.
   */
  budgetChars: number;
  /** One line: what this capsule is FOR. Surfaced when a name misses. */
  purpose: string;
}

/**
 * The registry: tool -> view name -> definition.
 *
 * Seeding discipline: every path below was read off a REAL result payload from
 * the tool named, not inferred from its schema. A view whose paths do not match
 * the live shape is worse than no view, because `applyPick` reports unmatched
 * paths in `notes` and the capsule silently comes back near-empty — so the
 * `named-views.test.ts` shape guard pins each seeded view against a recorded
 * sample of its tool's actual output.
 */
export const NAMED_VIEWS: Readonly<Record<string, Readonly<Record<string, NamedViewDef>>>> =
  Object.freeze({
    'dev:pipeline_position': Object.freeze({
      verdict: Object.freeze({
        version: 1,
        purpose:
          'Is my change live, and if not the ONE lever — the three fields that answer it, without the position ticks.',
        budgetChars: 900,
        fields: [
          'blockedOn',
          'nextAction',
          'summary',
          'positions.committedLocal',
          'positions.onStaging',
          'positions.inMain',
          'positions.deployed',
        ],
      }),
      gate: Object.freeze({
        version: 1,
        purpose: 'Gate health only: is it stalled, how red, and is it judging MY change.',
        budgetChars: 700,
        fields: [
          'gate.stalled',
          'gate.consecutiveReds',
          'gate.verdictStale',
          'gate.verdictStaleReasonCode',
          'gate.ownership.workItem',
          'gate.ownership.claimState',
          'changeInCandidate.judgingContainsPath',
          'changeInCandidate.missingReason',
        ],
      }),
    }),

    'coord:orient': Object.freeze({
      'recovery-critical': Object.freeze({
        version: 2,
        purpose:
          'Cold-successor capsule: authoritative control/loop/checkpoint recovery, effective mission, and Codex lock mode.',
        budgetChars: 4800,
        fields: [
          'self',
          'recovery',
          'instructionPrecedence.schemaVersion',
          'instructionPrecedence.watermark',
          'instructionPrecedence.effectiveMission',
          'codexLocks',
        ],
      }),
      monitor: Object.freeze({
        version: 3,
        purpose:
          'Lean live monitor: loop wake source, assignment/liveness summary, inbox pressure, and current lock generation.',
        budgetChars: 2800,
        fields: [
          'self',
          'recovery.loop',
          'me.summary',
          'me.agents[].agentId',
          'me.agents[].alive',
          'me.agents[].sessionState',
          'me.agents[].selfWake',
          'me.agents[].verdict',
          'me.agents[].claims[].id',
          'me.agents[].claims[].status',
          'me.agents[].doing.id',
          'me.agents[].doing.status',
          'me.agents[].isSelf',
          'inbox.summary',
          'codexLocks.lockMode',
          'codexLocks.generation',
        ],
      }),
    }),

    'work_items:get': Object.freeze({
      'recovery-critical': Object.freeze({
        version: 1,
        purpose:
          'Cold-successor item capsule: identity/state, live holder agreement, complete checkpoint, and checkpoint freshness.',
        budgetChars: 5400,
        fields: [
          'ok',
          'results[].ok',
          'results[].id',
          'results[].workItem.state',
          'results[].workItem.title',
          'results[].workItem.assignee',
          'results[].workItem.harness',
          'results[].holder',
          'results[].checkpoint',
          'results[].checkpointAgeMs',
          'results[].checkpointUpdatedAtMs',
          'counts',
        ],
      }),
      monitor: Object.freeze({
        version: 1,
        purpose:
          'Item monitor without checkpoint prose: state, assignee, holder agreement, progress time, and checkpoint age.',
        budgetChars: 1400,
        fields: [
          'ok',
          'results[].ok',
          'results[].id',
          'results[].workItem.state',
          'results[].workItem.assignee',
          'results[].workItem.lastProgressAt',
          'results[].workItem.updatedAt',
          'results[].holder',
          'results[].checkpointAgeMs',
          'results[].checkpointUpdatedAtMs',
          'counts',
        ],
      }),
      capsule: Object.freeze({
        version: 1,
        purpose:
          'Recovery capsule for a cold successor picking up an item: identity, state, holder, and the checkpoint.',
        budgetChars: 2400,
        fields: [
          'results[].id',
          'results[].workItem.state',
          'results[].workItem.title',
          'results[].workItem.assignee',
          'results[].workItem.harness',
          'results[].checkpoint',
        ],
      }),
      roster: Object.freeze({
        version: 1,
        purpose: 'Many items at a glance: id + state + assignee, nothing else.',
        budgetChars: 1200,
        fields: [
          'results[].id',
          'results[].workItem.state',
          'results[].workItem.assignee',
          'counts',
        ],
      }),
    }),

    'plans:get': Object.freeze({
      capsule: Object.freeze({
        version: 1,
        purpose:
          'Is this plan live, and what does it say to do now — frontmatter status (the authority) plus the Now block.',
        budgetChars: 1800,
        fields: [
          'results[].slug',
          'results[].frontmatter.status',
          'results[].frontmatter.title',
          'results[].now.state',
          'results[].now.next',
          'results[].counts',
        ],
      }),
    }),
  });

/** What a view resolution produced. */
export type ViewResolution =
  | {
      ok: true;
      tool: string;
      name: string;
      def: NamedViewDef;
      /** The selection, expressed as the ordinary projection spec `applyPick` takes. */
      spec: ProjectionSpec;
    }
  | {
      ok: false;
      /** Machine-readable reason, for callers that branch. */
      code: 'unknown_view' | 'no_views_for_tool' | 'malformed_view';
      /** Loud, self-correcting message. NEVER silently falls back to a full payload. */
      error: string;
      /** Every valid name for this tool, so the miss costs one round trip, not a guess. */
      validNames: string[];
    };

/** All view names registered for a tool (empty when the tool has none). */
export function viewNamesFor(tool: string): string[] {
  const forTool = NAMED_VIEWS[tool];
  return forTool ? Object.keys(forTool).sort() : [];
}

/**
 * Resolve `name` against `tool`.
 *
 * FAIL-CLOSED, deliberately: an unknown view name is the caller's bug and is
 * knowable without running anything. Falling back to the unprojected payload
 * would hand a caller who asked for a 900-char capsule the full result they
 * explicitly did not agree to pay for — the same reasoning that makes a
 * malformed `projection` fail closed at the dispatch layer.
 */
export function resolveNamedView(tool: string, name: unknown): ViewResolution {
  const validNames = viewNamesFor(tool);

  if (typeof name !== 'string' || name.trim() === '') {
    return {
      ok: false,
      code: 'malformed_view',
      error:
        `view_invalid: \`${VIEW_ARG}\` must be a non-empty string naming a registered view. ` +
        (validNames.length
          ? `Valid names for ${tool}: ${validNames.join(', ')}.`
          : `${tool} has no registered views.`),
      validNames,
    };
  }

  const forTool = NAMED_VIEWS[tool];
  if (!forTool || validNames.length === 0) {
    return {
      ok: false,
      code: 'no_views_for_tool',
      error:
        `view_unknown: ${tool} has no registered named views. ` +
        `Use \`projection: { pick: [...] }\` for an ad-hoc reduction instead.`,
      validNames,
    };
  }

  const def = forTool[name];
  if (!def) {
    return {
      ok: false,
      code: 'unknown_view',
      error:
        `view_unknown: ${tool} has no view named "${name}". ` +
        `Valid names: ${validNames.map((n) => `${n} (${forTool[n]!.purpose})`).join(' · ')}.`,
      validNames,
    };
  }

  return { ok: true, tool, name, def, spec: { pick: [...def.fields] } };
}

/** The receipt emitted alongside a view-projected payload. */
export interface NamedViewReceipt {
  /** The stable registry name the caller requested. */
  view: string;
  version: number;
  /** True when the selection ran. */
  applied: boolean;
  /** The exact field set the version declares — what the successor actually got. */
  fields: string[];
  /** Hard capsule ceiling, in UTF-8 BYTES (the wire unit — not UTF-16 code units). */
  budgetChars: number;
  /** Serialized size BEFORE the view selected any fields, in UTF-8 bytes. */
  sourceChars: number;
  /**
   * Rendered size of the CAPSULE text after selection and any budget
   * enforcement, in UTF-8 bytes. The delivery seam's guarantee is on the SUM:
   * capsule + '\n' + in-band footer ≤ budgetChars, so at that seam
   * returnedChars alone reads under this number by at least the footer.
   */
  returnedChars: number;
  /**
   * Set only when the budget actually bound. Carries the pre-enforcement size,
   * so a trimmed capsule can never be mistaken for one that simply fit.
   */
  budgetEnforced?: true;
  charsBeforeBudget?: number;
  /** Declared paths that matched nothing — fail-open is only honest if it is loud. */
  unmatchedFields?: string[];
}

/** Marker appended when the byte budget trims a capsule. Never silent. */
export const VIEW_BUDGET_MARKER = '\n…[view budget reached — capsule trimmed]';

export interface AppliedNamedView {
  /** The rendered capsule text. */
  text: string;
  receipt: NamedViewReceipt;
}

const UTF8_ENCODER = new TextEncoder();

/**
 * UTF-8 byte length — the budget's unit. `String.length` counts UTF-16 code
 * units, which under-counts every non-ASCII character (an `é` is 1 unit but
 * 2 bytes; an emoji 2 units but 4 bytes), so a unit-counted ceiling can let a
 * multibyte capsule exceed the declared byte budget ~3× while the receipt
 * reads under it (D-001's R2 non-ASCII remainder).
 */
function utf8ByteLength(text: string): number {
  return UTF8_ENCODER.encode(text).length;
}

/**
 * Truncate to at most `maxBytes` UTF-8 bytes WITHOUT splitting a multibyte
 * sequence. A naive `String.slice` cuts in UTF-16 code units and can split a
 * surrogate pair, emitting a lone surrogate (invalid UTF-8) into the capsule.
 * Cutting on an encoded-byte boundary and backing off any continuation bytes
 * (0b10xxxxxx) guarantees the result is well-formed: a surrogate pair encodes
 * as one 4-byte sequence, so it is either kept whole or dropped whole.
 */
function truncateToUtf8Bytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  const bytes = UTF8_ENCODER.encode(text);
  if (bytes.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return new TextDecoder().decode(bytes.subarray(0, end));
}

function serializedChars(value: unknown): number {
  try {
    return utf8ByteLength(JSON.stringify(value) ?? String(value));
  } catch {
    return 0;
  }
}

function namedViewReceipt(
  resolved: Extract<ViewResolution, { ok: true }>,
  applied: boolean,
  sourceChars: number,
  returnedChars: number,
): NamedViewReceipt {
  return {
    view: resolved.name,
    version: resolved.def.version,
    applied,
    fields: [...resolved.def.fields],
    budgetChars: resolved.def.budgetChars,
    sourceChars,
    returnedChars,
  };
}

/**
 * Apply a resolved view to a parsed result body: select, render, then enforce
 * the byte budget.
 *
 * Order matters and is the Design's: selection first (so the budget is spent on
 * fields the caller asked for, not on whatever happened to sort first), budget
 * second (so the declared ceiling is a real guarantee rather than a hope).
 */
export function applyNamedView(
  body: unknown,
  resolved: Extract<ViewResolution, { ok: true }>,
  sourceChars = serializedChars(body),
): AppliedNamedView {
  const { def } = resolved;
  const { picked, unmatched } = applyPick(body, def.fields);

  let text: string;
  try {
    text = JSON.stringify(picked, null, 2) ?? String(picked);
  } catch {
    // A body that will not serialize is not a reason to fail the call; report
    // it as an unapplied view and let the caller see the ordinary payload.
    return {
      text: '',
      receipt: namedViewReceipt(resolved, false, sourceChars, sourceChars),
    };
  }

  const textBytes = utf8ByteLength(text);
  const receipt = namedViewReceipt(resolved, true, sourceChars, textBytes);
  if (unmatched.length) receipt.unmatchedFields = [...unmatched];

  if (textBytes > def.budgetChars) {
    const keep = Math.max(0, def.budgetChars - utf8ByteLength(VIEW_BUDGET_MARKER));
    text = truncateToUtf8Bytes(text, keep) + VIEW_BUDGET_MARKER;
    receipt.budgetEnforced = true;
    receipt.charsBeforeBudget = textBytes;
    receipt.returnedChars = utf8ByteLength(text);
  }

  return { text, receipt };
}

/**
 * Minimal structural shape of a dispatch result this module touches. Kept
 * local (rather than importing the transport's McpCallResult) so this module
 * stays usable from a plain unit test with no transport in scope.
 */
export interface ViewableResult {
  content: ReadonlyArray<{ type?: string; text?: string } | Record<string, unknown>>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

/**
 * Take the reserved `view` argument off a dispatch args object.
 *
 * For tools with a registered named-result-view table, the view name is a
 * DISPATCH-level control, so it must be stripped before the tool's own schema
 * validation runs — every tool schema is additionalProperties:false, so an
 * unstripped key is rejected as unknown by the entire catalog. Exactly the
 * reservation `projection` already has.
 *
 * A tool may also legitimately own a semantic `view` argument (for example
 * `coord:roster { view: 'claims' }`). Only registered named-result-view tools
 * may claim that key at the dispatch layer; all other tools receive it
 * untouched. This keeps the result-view control from shadowing tool schemas.
 *
 * BOTH dispatch paths (direct tools/call and the nested tools:invoke) call this
 * one function. That is deliberate: the previous generation of this seam was
 * two hand-mirrored copies, and the nested one silently fell behind.
 */
export type TakeNamedViewResult =
  | { kind: 'none'; args: Record<string, unknown> }
  | { kind: 'error'; error: string; validNames: string[] }
  | { kind: 'view'; args: Record<string, unknown>; resolved: Extract<ViewResolution, { ok: true }> };

export function takeNamedViewFromArgs(
  args: Record<string, unknown> | undefined,
  toolName: string,
): TakeNamedViewResult {
  const source = args && typeof args === 'object' ? args : {};
  if (!(VIEW_ARG in source)) return { kind: 'none', args: source };

  // `view` is also a valid semantic argument on coordination readers such as
  // coord:roster. Reserve it for the named-result-view protocol only when the
  // target tool actually has registered result views; otherwise let the
  // target schema/handler consume it normally.
  if (viewNamesFor(toolName).length === 0) return { kind: 'none', args: source };

  const resolution = resolveNamedView(toolName, source[VIEW_ARG]);
  if (!resolution.ok) {
    return { kind: 'error', error: resolution.error, validNames: resolution.validNames };
  }
  const { [VIEW_ARG]: _stripped, ...rest } = source;
  return { kind: 'view', args: rest, resolved: resolution };
}

function firstTextIndex(content: ViewableResult['content']): number {
  return content.findIndex(
    (it) =>
      !!it &&
      typeof it === 'object' &&
      (it as { type?: unknown }).type === 'text' &&
      typeof (it as { text?: unknown }).text === 'string',
  );
}

function attachNamedViewReceipt<T extends ViewableResult>(
  result: T,
  receipt: NamedViewReceipt,
  textIndex: number,
  bodyText?: string,
): T {
  const footer = describeNamedView(receipt);
  const content = [...result.content];
  if (textIndex >= 0) {
    const original = content[textIndex] as Record<string, unknown>;
    const originalText = (original.text as string | undefined) ?? '';
    content[textIndex] = {
      ...original,
      type: 'text' as const,
      text: `${bodyText ?? originalText}\n${footer}`,
    };
  } else {
    // A caller asked for a view but the result had no text body to select.
    // Add the receipt in-band so `_meta`-blind clients can still distinguish
    // "ignored" from "applied" rather than silently receiving a no-op.
    content.push({ type: 'text' as const, text: footer });
  }
  return {
    ...result,
    content,
    _meta: { ...result._meta, namedView: receipt },
  };
}

/**
 * DELIVERY-BUDGET enforcement: the delivered unit is `capsule + '\n' + footer`
 * — the footer lands in the SAME `content[0].text` the caller pays for, so the
 * declared budget must bound the SUM, not just the capsule. (Pre-fix, the
 * footer was appended AFTER budget enforcement, so a capsule trimmed to
 * exactly the budget was delivered ~a footer's worth OVER it — even for pure
 * ASCII.) Enforced by re-trimming the capsule AFTER the footer is rendered.
 *
 * The footer restates receipt numbers, so trimming changes the footer's own
 * length; trimming only ever shrinks `returnedChars` (and setting
 * `budgetEnforced` grows the footer exactly once), so the loop converges —
 * 2 passes in practice, 4 as a hard bound. Floor: a budget too small to hold
 * even the marker + footer delivers just those two; no registered view
 * (budgets ≥ 700) is anywhere near that floor.
 */
function enforceDeliveredBudget(text: string, receipt: NamedViewReceipt): string {
  for (let pass = 0; pass < 4; pass += 1) {
    const footer = describeNamedView(receipt);
    const deliveredBytes = utf8ByteLength(text) + 1 + utf8ByteLength(footer);
    if (deliveredBytes <= receipt.budgetChars) break;
    const keep = Math.max(
      0,
      receipt.budgetChars - utf8ByteLength(footer) - 1 - utf8ByteLength(VIEW_BUDGET_MARKER),
    );
    if (!receipt.budgetEnforced) {
      receipt.budgetEnforced = true;
      receipt.charsBeforeBudget = utf8ByteLength(text);
    }
    // Strip a marker a prior (capsule-stage) trim already appended, so the
    // re-trim cannot leave a partial marker mid-capsule and never stacks two.
    const base = text.endsWith(VIEW_BUDGET_MARKER)
      ? text.slice(0, -VIEW_BUDGET_MARKER.length)
      : text;
    text = truncateToUtf8Bytes(base, keep) + VIEW_BUDGET_MARKER;
    receipt.returnedChars = utf8ByteLength(text);
  }
  return text;
}

/**
 * Apply a resolved view to a dispatched result: select, enforce the budget
 * (including the delivered capsule + footer sum), attach the receipt to
 * `_meta.namedView`, and append the in-band footer.
 *
 * FAIL-SOFT, like every other stage at this seam: a body that will not parse or
 * an error envelope keeps its ORIGINAL payload. It still receives an
 * `applied:false` receipt, because R3 requires callers to distinguish "the view
 * was ignored" from "the view applied". An unknown view name already fails
 * closed earlier, at resolution, which is where a caller bug belongs.
 */
export function applyNamedViewToResult<T extends ViewableResult>(
  result: T,
  resolved: Extract<ViewResolution, { ok: true }>,
): T {
  try {
    const idx = firstTextIndex(result.content);
    const raw = idx >= 0 ? (result.content[idx] as { text: string }).text : '';

    // An error envelope is not a result being reduced. Preserve it whole, but
    // make the requested view's no-op explicit in both receipt channels.
    // Receipt sizes are UTF-8 bytes everywhere — `raw.length` would count
    // UTF-16 code units here, the exact unit bug the budget fix removed.
    const rawBytes = utf8ByteLength(raw);

    if (result.isError) {
      return attachNamedViewReceipt(
        result,
        namedViewReceipt(resolved, false, rawBytes, rawBytes),
        idx,
      );
    }
    if (idx < 0) {
      return attachNamedViewReceipt(result, namedViewReceipt(resolved, false, 0, 0), idx);
    }

    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return attachNamedViewReceipt(
        result,
        namedViewReceipt(resolved, false, rawBytes, rawBytes),
        idx,
      );
    }

    const { text, receipt } = applyNamedView(body, resolved, rawBytes);
    if (!receipt.applied) {
      return attachNamedViewReceipt(result, receipt, idx, undefined);
    }
    const bounded = enforceDeliveredBudget(text, receipt);
    return attachNamedViewReceipt(result, receipt, idx, bounded);
  } catch {
    // Preserve fail-soft behavior even for an unexpected presentation error,
    // but never lose the R3 receipt: metadata-only is still distinguishable
    // from a silently ignored view for clients that inspect the envelope.
    return {
      ...result,
      _meta: {
        ...result._meta,
        namedView: namedViewReceipt(resolved, false, 0, 0),
      },
    };
  }
}

/**
 * One in-band line describing what the caller got. The receipt lives in
 * `_meta.namedView`, but `_meta` is not what an agent reads — the footer is the
 * copy that actually reaches it, the same reasoning the projection stage uses.
 */
export function describeNamedView(receipt: NamedViewReceipt): string {
  if (!receipt.applied) {
    return `ⓘ view "${receipt.view}" v${receipt.version} did NOT apply — the full result is shown.`;
  }
  const parts = [
    `ⓘ view "${receipt.view}" v${receipt.version} applied — ${receipt.fields.length} field(s), ` +
      `${receipt.sourceChars}→${receipt.returnedChars}/${receipt.budgetChars} chars`,
  ];
  if (receipt.budgetEnforced) {
    parts.push(`TRIMMED at the byte budget (was ${receipt.charsBeforeBudget})`);
  }
  if (receipt.unmatchedFields?.length) {
    parts.push(`matched nothing: ${receipt.unmatchedFields.join(', ')}`);
  }
  return `${parts.join(' · ')}.`;
}
