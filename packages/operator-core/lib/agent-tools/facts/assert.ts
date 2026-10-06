/**
 * facts:assert — upsert a standing fact: a deterministic, scoped CONCLUSION
 * that will be folded VERBATIM into every relevant future brief / dossier /
 * orient until it expires or is retracted. Every ordinary write must declare
 * a lifetime; conventions, typed safety slots, and confidence tiers have their
 * documented lifetime rules, and there is no silent ordinary 7-day default.
 * (queen-memory-hybrid-2026-07-02 L1b; D-001: harness/work_item scopes optional).
 *
 * THE LINE vs the other memory surfaces (put facts HERE, not there):
 *   facts  = deterministic delivery of a scoped conclusion ("WI-1439 is
 *            owner-residue — exclude from frontier").
 *   mem0   = fuzzy semantic background (may or may not surface).
 *   coord  = ephemeral status. checkpoint = task progress. insights doc =
 *            long-form how-it-works.
 */
import { z } from 'zod';
import { InvalidInputError } from '@papercusp/tooldef';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import {
  assertFact,
  resolveFactScopeRef,
  validateFactScopeRefShape,
  clampFactBody,
  FACT_SCOPES,
  FACT_BODY_MAX_CHARS,
  FACT_RECHECK_FIELD_MAX_CHARS,
  FACT_RECHECK_EXEC_MAX_SCOPE_TAGS,
  FACT_CONFIDENCE_LEVELS,
  CONVENTION_ENFORCEMENT_TIERS,
  FACT_MAX_DEPENDENCIES,
  FACT_MAX_SUPERSEDES,
  FACTS_PER_SCOPE_CAP,
  DEAD_END_KEY_PREFIX,
  WALL_KEY_PREFIX,
  GUARD_RAIL_KEY_PREFIX,
  FACT_VOLATILE_MAX_TTL_SEC,
  validateFactLifetime,
  type AgentFact,
  type FactDependency,
  type FactSourceProvenance,
} from '../../agent-facts/store';
import { isAssumptionFact, factVersions } from '../../agent-facts/store';
import { assessKeyContest, type KeyContestAssessment } from '../../facts/contested-key';
import { resolveScopeRefAlias } from './scope-ctx';
import {
  buildSafetySlotIntentWarning,
  detectSafetySlotKeyIntent,
} from './safety-slot-key-intent';
import { detectUndeliverableGuardRail } from './undeliverable-guard-rail';
import { detectWallPlanStateGap, readWalledItemStatusesPg } from './wall-plan-state';
import { activeWorkspaceId } from '../../workspace-registry';
import { resolveConcreteHarnessSlug } from '../_harness-scope';
import {
  carryProvenanceFields,
  ownerAttributionEnforcement,
  stampCarrySurfaceProvenance,
} from '../../carry-surface-provenance-stamp';
import { noteAssumptionAsserted } from '../../agent-state-stamp';
import { neutralizeToolCallTags } from '../../text-safety';
import { factAbsenceHint, factMeasurementHint } from '../../fact-measurement-detector';
import { getCell, type CellReader } from '../../cell-registry';
import { cellReaderFromCtx } from '../cell-reader-ctx';
import {
  suggestDependsOnCells,
  type DependsOnSuggestion,
  type DetectOptions,
} from '../../cell-transcription-detector';
import { resolveCellTranscriptionCommits } from '../../git-commit-resolver';
import { boundedOrgTxn } from '../../pg-bounded-txn';
import { acquireWithContentionRetry } from '../locks/contention-retry';
import {
  evaluateFrozenLineageCarryText,
  frozenLineageCarryViolationPayload,
} from '../../release/frozen-lineage-execution-policy';
import { resolveHomeGateVerdictTarget } from '../../release/gate-verdict-target';

const FACT_LIFETIME_CALL_CONSTRAINT =
  "Declare exactly one lifetime: ordinary facts, including verified conclusions, require ttlSec; omit it only for kind:'convention', wall:/dead-end:/guard-rail: keys, or confidence:'provisional'|'suspected'. permanent:true is allowed only for conventions/typed keys; never combine it with ttlSec or a volatile measurement.";

/**
 * EI-10952: the disclosure for a truncated body. Returns undefined on the clean
 * case (no field on the response) — same warn-only shape as provenanceLint.
 *
 * PURE (unit-tested without PG): compares what the caller SENT against what the
 * store actually PERSISTED, so it reports the real stored/dropped counts rather
 * than re-deriving the clamp and hoping the two agree.
 */
/** Cap on the verbatim dropped-tail echoed back in the disclosure (P-004). */
const TRUNCATION_TAIL_ECHO_CHARS = 240;

/** Cap the prior owner's body echoed in a cross-author overwrite receipt. */
export const OVERWROTE_AUTHOR_EXCERPT_CHARS = 240;

export interface OverwroteAuthorDisclosure {
  /** The owner who authored the version this write replaced. */
  ownerId: string;
  /** The prior version's last-update timestamp. */
  updatedAt: string;
  /** A bounded preview of the prior body, so the writer can recognize the loss. */
  bodyExcerpt: string;
  /** Actionable warning, intentionally loud because the write is still allowed. */
  note: string;
}

const FACT_RECHECK_SCHEMA = z
  .object({
    probe: z
      .string()
      .min(1)
      .max(FACT_RECHECK_FIELD_MAX_CHARS)
      .describe('The concrete query/tool/measurement a future reader can run to verify the fact again.'),
    falsifier: z
      .string()
      .min(1)
      .max(FACT_RECHECK_FIELD_MAX_CHARS)
      .describe('The concrete result or observation that means this fact is false and must be retracted or corrected.'),
    exec: z
      .object({
        command: z.string().min(1).max(FACT_RECHECK_FIELD_MAX_CHARS),
        expectExitCode: z.number().int().min(0).max(255),
        stdoutIncludes: z.string().min(1).max(FACT_RECHECK_FIELD_MAX_CHARS).optional(),
        scope: z.array(z.string()).min(1).max(FACT_RECHECK_EXEC_MAX_SCOPE_TAGS),
      })
      .strict()
      .optional()
      .describe(
        'Optional executable form of probe for a guard rail: a bash command whose exit code (and stdout literal) means the fact HOLDS. Harness preflights whose scope tags overlap `scope` (e.g. ["p505"]) run it and fail fast when it breaks.',
      ),
  })
  .strict()
  .optional()
  .describe(
    `P-010: paired re-verification contract. Supply BOTH probe and falsifier (max ${FACT_RECHECK_FIELD_MAX_CHARS} chars each). The pair folds verbatim beside the fact so a future reader knows how to test it and what result disproves it. Omission remains compatible but the success receipt warns loudly that the fact has no recheck contract.`,
  );

/**
 * `AgentFact` exposes snapshot metadata under `measurement`, while the write
 * boundary historically accepted its two scalar members as top-level fields.
 * Keep the output-shaped form callable as a compatibility alias and normalize
 * it to the canonical flat fields before reaching the store.
 */
const FACT_MEASUREMENT_SCHEMA = z
  .object({
    subjectVolatile: z.literal(true).describe('The sampled subject may still be changing.'),
    measuredAt: z
      .string()
      .min(1)
      .max(80)
      .describe('ISO timestamp at which the moving subject was sampled.'),
  })
  .strict()
  .optional()
  .describe(
    'Compatibility input alias for the persisted/read `measurement` object. It is normalized to the canonical top-level subjectVolatile/measuredAt fields; if both forms are supplied, their values must agree.',
  );

export function normalizeMeasurementInput(input: {
  measurement?: { subjectVolatile: true; measuredAt: string };
  subjectVolatile?: boolean;
  measuredAt?: string;
}): { subjectVolatile?: boolean; measuredAt?: string } {
  const measurement = input.measurement;
  if (measurement) {
    if (input.subjectVolatile !== undefined && input.subjectVolatile !== measurement.subjectVolatile) {
      throw new InvalidInputError(
        'facts:assert — measurement.subjectVolatile conflicts with top-level subjectVolatile; supply one value or make them agree',
      );
    }
    if (input.measuredAt !== undefined && input.measuredAt.trim() !== measurement.measuredAt.trim()) {
      throw new InvalidInputError(
        'facts:assert — measurement.measuredAt conflicts with top-level measuredAt; supply one timestamp or make them agree',
      );
    }
  }
  return {
    ...(input.subjectVolatile !== undefined || measurement
      ? { subjectVolatile: input.subjectVolatile ?? measurement?.subjectVolatile }
      : {}),
    ...(input.measuredAt !== undefined || measurement
      ? { measuredAt: input.measuredAt ?? measurement?.measuredAt }
      : {}),
  };
}

/** Compatibility is intentional, silence is not: teach an ordinary fact's
 * writer that TTL/retraction are its only freshness controls when no executable
 * recheck pair was supplied. An undecidable already requires settledBy, so its
 * mandatory exit probe covers the same question without a duplicate warning. */
export function recheckReceiptField(fact: Pick<AgentFact, 'recheck' | 'kind'>): {
  recheckMissing?: { note: string; required: string[] };
} {
  if (fact.recheck || fact.kind === 'undecidable') return {};
  return {
    recheckMissing: {
      note: '⚠ RECHECK CONTRACT MISSING — this fact will keep folding as standing context until expiry/retraction, but it carries no repeatable probe and no concrete falsifier. Re-assert the SAME key with recheck:{ probe, falsifier }; probe says exactly how to verify it again, falsifier says which result means it is false and must be retracted or corrected.',
      required: ['probe', 'falsifier'],
    },
  };
}

/**
 * Build the warn-only receipt for replacing a different author's current fact.
 *
 * PURE: the handler supplies the exact predecessor identified by supersedesId,
 * so this never guesses from an older version in the chain. Same-author
 * re-asserts stay silent, preserving the quiet common path.
 */
export function overwroteAuthorField(input: {
  prior?: Pick<AgentFact, 'createdBy' | 'updatedAt' | 'body'>;
  asserter: string;
  key: string;
}): OverwroteAuthorDisclosure | undefined {
  const prior = input.prior;
  if (!prior || !prior.createdBy || prior.createdBy === input.asserter) return undefined;
  const body = prior.body.trim();
  const bodyExcerpt =
    body.length > OVERWROTE_AUTHOR_EXCERPT_CHARS
      ? `${body.slice(0, OVERWROTE_AUTHOR_EXCERPT_CHARS - 1)}…`
      : body;
  return {
    ownerId: prior.createdBy,
    updatedAt: prior.updatedAt,
    bodyExcerpt: bodyExcerpt || '(empty body)',
    note:
      `⚠ CROSS-AUTHOR OVERWRITE — this write replaced ${prior.createdBy}'s fact for key "${input.key}". ` +
      `The prior body is included only as a bounded excerpt; if that fact was still valid, recover it ` +
      `from facts:list/history or re-assert it before proceeding.`,
  };
}

type DependsOnInput = string | { cell: string; as?: string };

export interface IncompleteDependsOnSuggestion {
  /** The cell the body transcribed but the accept payload could not safely add. */
  cell: string;
  /** The subject parameter a caller must supply before this dependency is executable. */
  required: string;
  /** Why this entry was withheld from the accept-ready payload. */
  reason: 'caller-relative-subject-required' | 'cell-contract-unavailable';
}

export interface DependsOnSuggestionField {
  suggested: DependsOnSuggestion[];
  /** Present only when every newly suggested dependency in this field is executable. */
  accept?: { dependsOn: DependsOnInput[] };
  /** Present when one or more suggestions need caller input before they can be accepted. */
  incomplete?: IncompleteDependsOnSuggestion[];
  note: string;
}

/**
 * The exported suggestion helper is also exercised as a pure function in unit tests,
 * where there is no dispatch identity. Keep that path fail-closed: an empty reader can
 * see only workspace cells. The live handler always passes the reader built from its
 * actual identity/context, so a suggested narrow cell is treated as unavailable rather
 * than inspected through the unchecked registry.
 */
const EMPTY_CELL_READER: CellReader = { ownerId: '' };

function dependencyAcceptance(cell: string, reader: CellReader = EMPTY_CELL_READER):
  | { acceptReady: true }
  | { acceptReady: false; required: string; reason: IncompleteDependsOnSuggestion['reason'] } {
  const spec = getCell(cell, reader);
  if (!spec) {
    return {
      acceptReady: false,
      required: 'the cell subject',
      reason: 'cell-contract-unavailable',
    };
  }
  if (spec.callerRelativity.kind === 'global') return { acceptReady: true };
  if (spec.callerRelativity.kind === 'parameter') {
    return {
      acceptReady: false,
      required: spec.callerRelativity.param,
      reason: 'caller-relative-subject-required',
    };
  }
  return {
    acceptReady: false,
    required: `ambient ${spec.callerRelativity.source}`,
    reason: 'caller-relative-subject-required',
  };
}

/**
 * P-007 — the OTHER half of the dependency-disclosure story.
 *
 * `dependencyWarning` in the handler reports declared dependencies that could not be
 * anchored. THIS reports the dependency the body's own text suggests the caller MEANT to
 * declare and did not: a fact stating a live value with no `dependsOn` is never marked
 * stale when that value changes, so it keeps folding into orients as standing context
 * long after it stopped being true.
 *
 * SUGGESTION-ONLY, by spec ("attach-mode only after measured precision"): nothing is
 * attached and nothing is refused. A wrong auto-attached dependency is strictly worse
 * than none — it would report this fact fresh or stale on an unrelated subject's account
 * — so attach-mode waits until precision has been measured in production.
 *
 * Exported (like {@link truncationField}) so the SHAPE is testable without a database:
 * the pure matcher is proven next door in cell-transcription-detector.test.ts, and a
 * matcher that works while this wiring emits nothing is exactly the gap that discipline
 * exists to close.
 *
 * Fail-soft, matching every other advisory in this handler: an advisory that can fail a
 * write is a worse trade than the friction it prevents. `suggestDependsOnCells` is pure
 * and returns [] rather than throwing, but it is wrapped anyway so a future edit to it
 * can never turn facts:assert into an outage.
 */
export function dependsOnSuggestionField(
  body: string,
  declaredDependencies: readonly DependsOnInput[],
  reader: CellReader = EMPTY_CELL_READER,
  options: DetectOptions = {},
): DependsOnSuggestionField | null {
  const declaredCells = declaredDependencies.map((dependency) =>
    typeof dependency === 'string' ? dependency : dependency.cell,
  );
  let suggested: DependsOnSuggestion[] = [];
  try {
    suggested = suggestDependsOnCells(body, declaredCells, options);
  } catch {
    return null;
  }
  if (suggested.length === 0) return null;

  const acceptReady = suggested.filter((suggestion) => dependencyAcceptance(suggestion.cell, reader).acceptReady);
  const incomplete = suggested.flatMap((suggestion) => {
    const acceptance = dependencyAcceptance(suggestion.cell, reader);
    return acceptance.acceptReady
      ? []
      : [{ cell: suggestion.cell, required: acceptance.required, reason: acceptance.reason }];
  });
  const acceptedDependencies = declaredDependencies
    .map((dependency) =>
      typeof dependency === 'string'
        ? dependency.trim()
        : {
            cell: dependency.cell.trim(),
            ...(dependency.as !== undefined ? { as: dependency.as } : {}),
          },
    )
    .filter((dependency) => (typeof dependency === 'string' ? dependency.length > 0 : dependency.cell.length > 0));

  return {
    suggested,
    // Accept-in-one-call: hand back the exact argument to re-send, already merged with
    // whatever the caller declared, so acting on this costs a copy rather than a trip to
    // the schema docs and a manual union the caller can get wrong. Caller-relative
    // suggestions are deliberately withheld: a bare cell id would be accepted by the
    // schema but can never produce a comparison anchor without its subject.
    ...(acceptReady.length > 0
      ? { accept: { dependsOn: [...acceptedDependencies, ...acceptReady.map((s) => s.cell)] } }
      : {}),
    ...(incomplete.length > 0 ? { incomplete } : {}),
    note:
      `This fact's body states ${suggested.length} value(s) a registered CELL answers authoritatively, but the ` +
      'fact does not depend on those cells — so nothing will ever mark it stale when they change, and it will ' +
      'keep folding into orients as standing context long after it stopped being true. ' +
      (incomplete.length > 0
        ? `The ${incomplete.length} incomplete suggestion(s) require caller input before they can be added; `
        : '') +
      (acceptReady.length > 0 ? 'Re-assert with the `accept.dependsOn` above to arm staleness detection. ' : '') +
      'NOTHING was attached or changed by this suggestion; ' +
      'if you are deliberately recording HISTORICAL state, ignore it.',
  };
}

/** The facts receipt uses the same bounded commit verification as coord hints. */
export async function dependsOnSuggestionFieldResolvingCommits(
  body: string,
  declaredDependencies: readonly DependsOnInput[],
  reader: CellReader = EMPTY_CELL_READER,
  resolve?: Parameters<typeof resolveCellTranscriptionCommits>[1],
): Promise<DependsOnSuggestionField | null> {
  const options = await resolveCellTranscriptionCommits(body, resolve);
  return dependsOnSuggestionField(body, declaredDependencies, reader, options);
}

export function truncationField(
  rawBody: string,
  storedBody: string,
): { storedChars: number; droppedChars: number; droppedTail?: string; note: string } | undefined {
  const raw = rawBody.trim();
  if (raw.length <= storedBody.length) return undefined;
  // P-004 (cold-carry-system-hardening-2026-07-19): recover the dropped TAIL and echo
  // it verbatim, so the caller can immediately re-assert a tighter body without
  // reconstructing what was lost. The stored body is always <marker-stripped prefix
  // of raw> + a clip marker (' […]' at a boundary, or '…' on the hard-cut fallback).
  const prefix = storedBody.endsWith(' […]')
    ? storedBody.slice(0, -' […]'.length)
    : storedBody.endsWith('…')
      ? storedBody.slice(0, -1)
      : storedBody;
  const tail = raw.startsWith(prefix) ? raw.slice(prefix.length).trim() : '';
  const clippedTail =
    tail.length > TRUNCATION_TAIL_ECHO_CHARS ? `${tail.slice(0, TRUNCATION_TAIL_ECHO_CHARS - 1)}…` : tail;
  return {
    storedChars: storedBody.length,
    droppedChars: raw.length - storedBody.length,
    ...(clippedTail ? { droppedTail: clippedTail } : {}),
    note:
      `CLIPPED to the ${FACT_BODY_MAX_CHARS}-char cap — the write was KEPT (a fact is never lost to a length ` +
      `error). The clip lands on a sentence/word boundary when one exists (marker ' […]'); droppedTail echoes ` +
      `what was cut, verbatim. Facts fold VERBATIM into every future orient as BINDING context, so verify the ` +
      `stored body still says what you mean — front-load the operative clause — and re-assert the SAME key ` +
      `tighter if not (facts are conclusions, not documents; detail belongs on the work-item / insight).`,
  };
}

/**
 * P-015 (deterministic-context-carry) — the DEAD-END fact slot. A tried-and-
 * failed approach recorded as ordinary prose ("the FS-watch route didn't work")
 * reads as narrative and gets re-tried by successors; typed as a dead-end slot
 * it is machine-greppable (key LIKE 'dead-end:%') and renders unmistakably in
 * every fold. Deliberately encoded in the key + body (no schema change): every
 * existing delivery surface (orient/brief/dossier fact folds) renders it
 * correctly with zero renderer changes.
 */
// The key prefix is owned by the agent-facts store (single source shared with the
// P-006 dead-end matcher's read filter, foldDeadEndFacts) — re-exported here so the
// slot's write-side helpers + existing importers keep their `./assert` import path.
export { DEAD_END_KEY_PREFIX };
export const DEAD_END_BODY_PREFIX = '⛔ DEAD END — do not retry: ';

/** PURE: normalize a slot:'dead-end' assert's key/body onto the slot encoding.
 *  Idempotent — an already-prefixed key/body is left alone (a re-assert of the
 *  same fact must hit the same upsert key and not stack markers). */
export function normalizeDeadEndSlot(key: string, body: string): { key: string; body: string } {
  const k = key.toLowerCase().startsWith(DEAD_END_KEY_PREFIX) ? key : `${DEAD_END_KEY_PREFIX}${key}`;
  const b = body.startsWith(DEAD_END_BODY_PREFIX) ? body : `${DEAD_END_BODY_PREFIX}${body}`;
  return { key: k, body: b };
}

/**
 * owner-wall-ttl-lapse-hardening-2026-07-26 (EI-18669544162414270): the
 * WALL fact slot — an owner-gated blocker recorded as a standing fact so it
 * is machine-greppable (`key LIKE 'wall:%'`) and renders unmistakably (⚠) in
 * every fold, instead of reading as an ordinary conclusion that quietly
 * times out. Re-exported for the same reason DEAD_END_KEY_PREFIX is.
 */
export { WALL_KEY_PREFIX };
export const WALL_BODY_PREFIX = '⚠ WALL (owner-gated) — absence ≠ resolved: ';

/** PURE: normalize a slot:'wall' assert's key/body onto the slot encoding.
 *  Idempotent, same shape as {@link normalizeDeadEndSlot}. */
export function normalizeWallSlot(key: string, body: string): { key: string; body: string } {
  const k = key.toLowerCase().startsWith(WALL_KEY_PREFIX) ? key : `${WALL_KEY_PREFIX}${key}`;
  const b = body.startsWith(WALL_BODY_PREFIX) ? body : `${WALL_BODY_PREFIX}${body}`;
  return { key: k, body: b };
}

/**
 * EI-21154276512983646 — the GUARD-RAIL fact slot. A settled do-not-repeat
 * instruction is deterministic safety context, so it must remain recognizable
 * and survive ordinary fact-cap churn. Encoding it in key + body keeps every
 * existing fold surface correct without a schema migration.
 */
export { GUARD_RAIL_KEY_PREFIX };
export const GUARD_RAIL_BODY_PREFIX = '🛡️ GUARD RAIL — do not repeat: ';

/** PURE: normalize a slot:'guard-rail' assert's key/body onto its durable
 *  machine-greppable encoding. Idempotent so re-asserting the same ruling hits
 *  the same key rather than stacking markers. */
export function normalizeGuardRailSlot(key: string, body: string): { key: string; body: string } {
  const k = key.toLowerCase().startsWith(GUARD_RAIL_KEY_PREFIX) ? key : `${GUARD_RAIL_KEY_PREFIX}${key}`;
  const b = body.startsWith(GUARD_RAIL_BODY_PREFIX) ? body : `${GUARD_RAIL_BODY_PREFIX}${body}`;
  return { key: k, body: b };
}

type FactSafetySlot = 'dead-end' | 'wall' | 'guard-rail';

/** Normalize the exact body that the store will size, including safety-slot
 * prefixes and tool-call neutralization. Shared by schema preflight and the
 * handler so a caller cannot pass validation and then discover a different
 * length contract at the write boundary. */
function normalizeFactInput(
  key: string,
  body: string,
  slot?: FactSafetySlot,
): { key: string; body: string; authoredBody: string } {
  const safeBody = neutralizeToolCallTags(body);
  const normalized = slot === 'dead-end'
    ? normalizeDeadEndSlot(key, safeBody)
    : slot === 'wall'
      ? normalizeWallSlot(key, safeBody)
      : slot === 'guard-rail'
        ? normalizeGuardRailSlot(key, safeBody)
        : { key, body: safeBody };
  return { ...normalized, authoredBody: safeBody };
}

/** The actionable pre-write refusal shared by args validation and the handler's
 * defense-in-depth check. */
function truncationRefusal(body: string): string | undefined {
  const preview = truncationField(body, clampFactBody(body));
  if (!preview) return undefined;
  // EI-20190692981938411: the refusal used to report `preview.droppedChars` as the
  // amount "over the cap", which is a DIFFERENT quantity and left each retry a guess
  // (measured live: 3 round-trips for one write). Two numbers were collapsed into one:
  //   overage            = bodyChars - cap — the true excess, and so the SMALLEST cut
  //                        that fits (cutting exactly this lands the body ON the cap);
  //   preview.droppedChars = what a CLIP would actually discard, which is larger
  //                        whenever clampFactBody backs up to a sentence/word boundary
  //                        rather than hard-cutting. Measured: a body 7 chars over the
  //                        1200 cap reported "54 char(s) over" — a 47-char misstatement.
  // Both are worth saying, but only the first answers "how much do I cut?". The caller
  // also cannot derive either from their side, because the cap is applied AFTER slot
  // normalization — hence stating the measured length explicitly rather than expecting
  // them to measure the string they sent.
  const bodyChars = body.trim().length;
  const overage = bodyChars - FACT_BODY_MAX_CHARS;
  // Only claim the clip discards MORE than the overage when it actually does — on a
  // pathological single-sentence body the clamp hard-cuts and the two coincide.
  const clipNote =
    preview.droppedChars > overage
      ? `Clipping instead would discard ${preview.droppedChars} char(s) — more than the overage, because the ` +
        `clip backs up to a sentence/word boundary — silently dropping`
      : `Clipping instead would discard ${preview.droppedChars} char(s), silently dropping`;
  return (
    `facts:assert — body is ${bodyChars} chars measured after normalization, ${overage} over the ` +
    `${FACT_BODY_MAX_CHARS}-char cap: CUT AT LEAST ${overage} CHARS and it fits. No write happened. ` +
    `${clipNote} this operative tail: "${preview.droppedTail ?? '(tail unavailable)'}". ` +
    `Either shorten the body to front-load the operative clause within ${FACT_BODY_MAX_CHARS} chars, or ` +
    `re-call with acceptTruncation:true to force the clipped write through anyway.`
  );
}

export default defineTool({
  name: 'facts:assert',
  capability: 'coord:write',
  description:
    `Upsert a STANDING FACT by key; scoped conclusions fold VERBATIM into future briefs/orients until expiry or retraction. Bodies over ${FACT_BODY_MAX_CHARS} chars are refused unless acceptTruncation:true; the 4000-char schema limit is transport headroom. ⚠ Declare a lifetime: ttlSec for CURRENT CODE/STATE (forces re-check), kind:'convention' for permanent rules, or a wall:/dead-end:/guard-rail: slot or provisional/suspected confidence. Re-asserting refreshes body + TTL. At the cap, the lowest-ranked fact is evicted unless it belongs to another author and is verified; typed slots and conventions use no cap seat.`,
  guidance: {
    when:
      'A durable CONCLUSION that should shape future turns — yours or your role\'s: "X is owner-residue, exclude it", "this harness\'s tests need Docker". Scope as narrowly as true: workspace (global), role, owner, harness, or work_item.',
    notWhen:
      `Ephemeral status (coord), in-flight progress (work_items:checkpoint), long-form docs (agent-insights), or fuzzy recall (memory:remember). Body cap ${FACT_BODY_MAX_CHARS} chars; per-scope cap ${FACTS_PER_SCOPE_CAP}. A fact is not a live measurement: never pin a changing count/status — store the invariant conclusion plus where to remeasure. A moving sample needs measuredAt (subjectVolatile, ≤15-min SNAPSHOT); label history as historical.`,
    chaining:
      'facts:list { scope } for what stands (re-assert refreshes, never duplicates); dryRun:true before a saturated write; facts:retract the moment one stops being true — a stale fact folded verbatim is worse than none.',
    seeAlso: ['facts:retract', 'facts:list', 'memory:remember (fuzzy background instead)'],
  },
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  modality: ['text'],
  // The handler performs async provenance/dependency work before its multi-query
  // assertFact write. Do not let the dispatcher hold an ambient workspace txn
  // across those awaits; the write owns a bounded admin-pool transaction below.
  skipWorkspaceTx: true,
  args: (() => {
    // Keep the modality relationship representable in the published JSON
    // Schema. A single object with both fields optional makes compact tool
    // callers believe `settledBy` is valid for every kind, even though the
    // store correctly rejects it outside `undecidable` (EI-20194111544678291).
    const base = {
    scope: z.enum(FACT_SCOPES).describe('workspace (global, no ref) | role | owner | harness | work_item'),
    scopeRef: z.string().max(120).optional().describe('Required for every scope except workspace: role name / ownerId / harness slug / WI id.'),
    scope_ref: z.string().max(120).optional().describe('Alias for scopeRef (EI-7371) — prefer scopeRef; accepted so a snake_case call still resolves the ref instead of silently dropping it.'),
    ref: z.string().max(120).optional().describe('Alias for scopeRef (EI-7371) — prefer scopeRef.'),
    harness: z
      .string()
      .max(120)
      .optional()
      .describe(
        'Alias for scopeRef when scope:"harness" (EI-7371) — prefer scopeRef. For shareable:true, also pass a concrete harness here when the caller context is not already harness-scoped.',
      ),
    key: z.string().min(1).max(120).describe('Stable slug — upsert + retract target (e.g. "wi-1439-owner-residue").'),
    supersedes: z
      .array(z.string().min(1).max(120))
      .max(FACT_MAX_SUPERSEDES)
      .optional()
      .describe(
        `Retire up to ${FACT_MAX_SUPERSEDES} overlapping sibling fact keys in the SAME workspace/scope/ref while asserting this replacement. Keys are trimmed and deduplicated; the asserted key itself is refused because same-key corrections already append a version. Only CURRENT local matches are soft-retracted, atomically with this write, and the receipt reports the keys actually retired. Missing, wrong-scope, and already-retired keys are unchanged and omitted from that receipt.`,
      ),
    // Transport ceiling 4000 ≫ the stored cap: the store TRUNCATES to FACT_BODY_MAX_CHARS
    // (code-run-self-state-adoption-2026-07-03 P-007 — the hard zod reject cost the WHOLE
    // write 7×/14d; truncate-not-reject preserves the fact, '…' makes it visible).
    // EI-18670525043445474: the 4000 here is TRANSPORT headroom only. It is NOT the
    // effective cap and it is deliberately NOT tightened to FACT_BODY_MAX_CHARS: the
    // body must reach the handler for truncationRefusal() to MEASURE the overage and
    // preview the exact tail that would be cut. A zod .max(FACT_BODY_MAX_CHARS) here
    // would trade that for a generic "too big" and lose the acceptTruncation escape.
    //
    // ⚠ EI-20352525205864881: this block and the description below used to say an
    // over-cap write was "accepted-and-clipped rather than rejected-and-lost" and
    // "silently dropped … only visible after the fact". That stopped being true at
    // EI-18685042986450096, which moved the cap to a REFUSAL BEFORE THE WRITE (see
    // the acceptTruncation check further down) — but neither string was updated, so
    // for weeks the tool description every agent reads promised the OPPOSITE of the
    // behaviour. A caller who believed it neither shortened the body nor passed
    // acceptTruncation, and was refused: measured 2026-09-05, over-cap body was the
    // single largest facts:assert failure family (497 of 994 invalid_input calls in
    // 9 days). Prose that misdescribes enforcement AT SYMPTOM TIME is the same class
    // cap-prose-drift.test.ts exists for; body-cap-prose-matches-behaviour.test.ts
    // is the guard that keeps these two strings honest about refuse-vs-clip.
    //
    // The REAL cap a caller must size against is FACT_BODY_MAX_CHARS (1200 as of
    // EI-18681984560352579 / migration 664, raised from 500 — the old cap was
    // silently amputating the operative clause of real conclusions).
    body: z
      .string()
      .min(1)
      .max(4000)
      .describe(
        `REFUSED ABOVE ${FACT_BODY_MAX_CHARS} CHARS — size your write to this, not the 4000 schema ceiling (4000 is transport headroom only, so the refusal can measure your exact overage and preview the tail that would be cut). An over-cap body is NOT silently clipped: NO WRITE HAPPENS and the error names how many chars to cut — either shorten it, or re-call with acceptTruncation:true to force the clipped write through. Front-load the operative clause; write tight, not documents.`,
      ),
    sourceRef: z.string().max(200).optional().describe('Anchor that proved it. A TYPED ref — msg:<id>, wi:<id>/WI-/EI- id, session_turn:<source>:<session>:<idx>, or "owner-turn" (the human turn you are answering) — is PLATFORM-VERIFIED at assert time and folds with the verified verbatim quote; anything else (plan slug, prose) stays a plain anchor.'),
    slot: z
      .enum(['dead-end', 'wall', 'guard-rail'])
      .optional()
      .describe(
        "Typed slot. 'dead-end' (P-015) = a tried-and-failed approach, recorded so successors never re-try it: the key is normalized under 'dead-end:' and the body rendered with the ⛔ DEAD END marker in every future fold; TTL defaults to 90d, not permanent (D-002 — a dead-end is a claim about CURRENT code and is the row most likely to be quietly invalidated by a later fix, so it is re-affirmed rather than standing forever). 'wall' (owner-wall-ttl-lapse-hardening) = an OWNER-GATED blocker whose absence must never be read as resolved: the key is normalized under 'wall:' and the body rendered with the ⚠ WALL marker; TTL defaults to 90d and stays FINITE on purpose — the lapse is what the watchdog fires on (still overridable via ttlSec, capped at 90d) and an unretracted lapse is escalated LOUDLY by the wall-lapse watchdog rather than silently vanishing from folds. 'guard-rail' (EI-21154276512983646) = a settled do-not-repeat instruction: the key is normalized under 'guard-rail:' and the body rendered with the 🛡️ GUARD RAIL marker; it is exempt from cap eviction, included in monitor never-drop folds, and PERMANENT by default (D-002 — a guard-rail is a standing decision rather than a claim about current code, which is what earns it permanence where 'dead-end' gets 90d). State the approach AND why it failed / the condition and what remediates it; pair with sourceRef to anchor the evidence.",
      ),
    audienceScope: z.string().max(160).optional().describe('Restrict WHO receives this fact in folds (v1 grammar: "fleet:<slug>") — it then folds ONLY into orients of that fleet\'s members. Omit = every reader of the scope. Orthogonal to `scope` (what the fact is about). facts:list still shows it to everyone (delivery relevance, not secrecy).'),
    confidence: z
      .enum(FACT_CONFIDENCE_LEVELS)
      .optional()
      .describe(
        "Evidence strength (WI-6052): 'verified' (you confirmed it directly / it's replicated), 'provisional' (a single run / one data point — plausible but unreplicated), or 'suspected' (a hunch / a peer's hedge relayed second-hand). Omit = legacy/unset and renders unbadged; an ordinary write still needs an explicit ttlSec or another documented lifetime rule. When no ttlSec is supplied, 'provisional'/'suspected' provides a short TTL so a hedge can't quietly calcify into settled fact. Never write a peer's provisional evidence at higher confidence than they stated it.",
      ),
    subjectVolatile: z
      .boolean()
      .optional()
      .describe(
        'Mark the asserted values as a snapshot of a subject that may still be changing. The ONE hard refusal in this group: when true, measuredAt is required (never defaulted to now() — that would stamp a sample of unknown age as fresh). Supplying measuredAt alone is accepted and the store infers subjectVolatile:true. The fold renders a SNAPSHOT marker, and the TTL is CLAMPED to 15 minutes rather than refused.',
      ),
    measurement: FACT_MEASUREMENT_SCHEMA,
    measuredAt: z
      .string()
      .max(80)
      .optional()
      .describe(
        'ISO timestamp at which a snapshot was sampled. Required with subjectVolatile:true; supplying measuredAt alone is accepted and the store infers subjectVolatile:true, the SNAPSHOT marker, and the 15-minute TTL. Omit it for durable invariant conclusions.',
      ),
    dependsOn: z
      .array(
        z.union([
          z.string().min(1).max(200),
          z.object({
            cell: z.string().min(1).max(200),
            as: z
              .string()
              .max(200)
              .optional()
              .describe('The SUBJECT, for a cell whose callerRelativity is "parameter" — same meaning as state:read { as }.'),
          }),
        ]),
      )
      .max(FACT_MAX_DEPENDENCIES)
      .optional()
      .describe(
        `P-008: the CELL ids this fact rests on (max ${FACT_MAX_DEPENDENCIES}) — either a bare id ("deploy.3070.sha") or { cell, as } when the cell is caller-relative ({ cell: "git.pipelinePosition", as: "packages/operator-core/lib/x.ts" }). Each is READ AND DIGESTED NOW, so a later reader is told mechanically that "the cell you relied on changed from X to Y" instead of guessing from the fact's age. This is what makes an assumption auto-invalidate (D-007) — without it, an assumption is just a conclusion with a weaker badge. A cell that cannot be read is recorded as such and never later reported fresh; it never blocks the write. Run state:read { } to see the cells you may declare.`,
      ),
    claim: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        'P-008: an optional TYPED restatement of what this fact asserts, e.g. { subject: "cell:gate.greenCheckpoint.verdict", assertion: "unrelated-to-my-change" }. `body` stays the prose humans read. ⚠ NOTHING READS THIS TODAY — the contradiction detector it was built for was retired (WI-6545 / D-103) after 3 of 2,217 facts ever carried a claim. Stored faithfully if you pass it; omit it unless you have your own reason.',
      ),
    enforcement: z
      .object({
        tier: z.enum(CONVENTION_ENFORCEMENT_TIERS),
        floor: z.number().optional(),
        reviewBy: z.string().max(40).optional(),
      })
      .optional()
      .describe(
        "P-018: HOW this convention is enforced (kind:'convention' only) — 'structural' (impossible to do wrong; no agent decision involved), 'gate' (refused at a chokepoint), or 'detector' (measured, never silently tolerated). gate/detector REQUIRE floor (a rate in (0,1]) + reviewBy: D-016 — \"a detector without a floor is prose exhortation in a costume\". 'structural' takes neither. There is deliberately no 'prompt' tier: a convention carried only by documentation omits this and reads as untiered.",
      ),
    ttlSec: z
      .number()
      .int()
      .positive()
      .max(90 * 24 * 3600)
      .optional()
      .describe(
        `TTL seconds (max 90d). ⚠ THERE IS NO DEFAULT: every assert must declare a lifetime, and a call ` +
          `that declares none is REFUSED (the old silent 7d default was removed — it was being applied to ` +
          `facts nobody had chosen a lifetime for, which then expired unread). Pass this for a bounded fact, ` +
          `or permanent:true for a standing one. You do NOT need either if the fact already implies a ` +
          `lifetime: kind:'convention' is permanent on its own, a wall:/dead-end:/guard-rail: slot carries its ` +
          `own durable default, and confidence:'provisional'|'suspected' already means a short TTL. ` +
          `⚠ CONDITIONAL MAX: a volatile fact's ttlSec is CLAMPED, never refused (D-011) — anything over ` +
          `${FACT_VOLATILE_MAX_TTL_SEC}s (15 minutes) is shortened to it and disclosed back as ttlClampedFrom.`,
      ),
    permanent: z
      .boolean()
      .optional()
      .describe(
        `Declare this fact PERMANENT (no expiry) — the semantic alternative to ttlSec, and the way to say ` +
          `"this should never lapse" without inventing a large number. ACCEPTED ONLY for a fact that is exempt ` +
          `from the per-scope cap: kind:'convention', or a key under '${WALL_KEY_PREFIX}' / ` +
          `'${DEAD_END_KEY_PREFIX}' / '${GUARD_RAIL_KEY_PREFIX}'. Everywhere else it is REFUSED, and that is ` +
          `deliberate rather than a restriction to work around: eviction ranks by remaining-TTL FRACTION ` +
          `descending, so an unbounded row inside the ranked population is the LEAST evictable row there — it ` +
          `would never expire AND would crowd out live observations, turning "my fact expired" into the much ` +
          `quieter "my fact was evicted immediately". Choose by WHAT THE ROW IS, not by how durable it feels: ` +
          `a standing rule or decision is kind:'convention' and permanent by that fact alone; a finding about ` +
          `current code SHOULD expire, so give it a ttlSec and a recheck. Refused for a volatile measurement — ` +
          `a snapshot of a moving subject is never a standing fact.`,
      ),
    dryRun: z
      .boolean()
      .optional()
      .describe(
        'Compute what this assert WOULD cost and write NOTHING: which fact the per-scope cap would evict ' +
          '(key, owner, confidence, remaining TTL), where your row would land in the victim ranking, and ' +
          'whether the key you are replacing already exists. Use it before asserting into a scope you know ' +
          'is busy, and before RESTORING an evicted fact — a restore is itself a write and can displace a ' +
          'third party. Ordinary at-cap writes are refused before write when the predicted victim is another author\'s ' +
          'verified fact; conventions and typed safety slots take no cap seat. FORECAST, NOT A RESERVATION: a peer ' +
          'asserting first changes the victim.',
      ),
    acceptTruncation: z
      .boolean()
      .optional()
      .describe(
        `Explicit opt-in to force the write through when body exceeds the ${FACT_BODY_MAX_CHARS}-char cap. WITHOUT this, an ` +
          `over-cap body is REFUSED (no write happens) — the error names the overage and previews the exact tail that would be ` +
          `cut, so you can re-write it tight instead of losing it silently (EI-18685042986450096: the old truncate-and-report-` +
          `after behavior dropped the operative clause of a fact 3x, once removing a rule's verdict sentence entirely). Pass ` +
          `true only when you deliberately want the clipped write to land anyway (P-007: a write is never rejected outright — ` +
          `this is the one way to still get the old lossy-but-never-lost behavior).`,
      ),
    };
    const kindDescription =
      "P-008: the claim MODALITY — 'conclusion' (a settled finding), 'assumption' (provisional; pair it with dependsOn so it goes stale on its own terms), 'convention' (normative: \"we do X here\"), or 'undecidable' (NOT determinable from the available evidence — recorded so peers STOP RE-DERIVING it; REQUIRES settledBy). This is NOT `scope`: scope says who the fact is ABOUT, kind says what kind of claim it is. Omit = not declared (never rewritten to 'conclusion' — a modality nobody stated is not one).";
    const settledByDescription =
      "P-002: what evidence WOULD settle this question. REQUIRED for kind:'undecidable', and REFUSED on any other kind (on a settled claim it has no referent). Name a concrete probe — a query, a tool, a measurement — not \"more investigation\". The rule mirrors the required insteadRead on refuseAnswer(): an UNKNOWN with no stated exit does not stop re-derivation, it INVITES it, because the next reader cannot distinguish \"nobody COULD determine this\" from \"nobody has tried lately\" and the cheapest way to tell them apart is to try again — which is the exact cost this modality exists to eliminate.";
    const shareableDescription =
      'OPT-IN federation egress (F0-2): true = this fact may leave the pot over the substrate. A shareable fact MUST have a resolvable federation harness: pass a concrete `harness` for workspace, role, owner, or work_item scopes, or pass `scope:"harness"` with its canonical `scopeRef`. Omit or set false to keep the fact pot-private.';
    /**
     * EI-22064465906366039 — ONE flat object, with the two couplings enforced by
     * targeted refinements instead of a 3x2 `z.union`.
     *
     * The previous shape crossed the federation route (explicit harness |
     * scope:'harness' | private) with the modality (undecidable | declared) into
     * SIX union branches. Zod reports an `invalid_union` by concatenating EVERY
     * branch's issues, so a call with ONE mistake was answered with six, and they
     * contradicted each other. Measured on this item, before this change:
     *
     *   { kind:'undecidable' } with no settledBy  ->  6 complaints, including
     *     `kind :: Invalid option: expected one of "conclusion"|"assumption"|
     *     "convention"` — telling the caller its CORRECT kind was wrong —
     *     alongside `harness required`, `shareable: expected true`, and
     *     `scope: expected "harness"`, none of which the call needed.
     *   { kind:'conclusion', settledBy } ->  `kind: expected "undecidable"` AND
     *     `settledBy: expected never` in the SAME message: two instructions that
     *     cannot both be satisfied.
     *
     * That is the reported mechanism — an agent obeys the dump, adds harness +
     * shareable:true + settledBy + kind:'undecidable', and lands in the next
     * rejection. facts:assert carried 26.4% invalid_input, worst of any
     * high-volume verb.
     *
     * The union's stated rationale (the comment above `base`) was to keep the
     * kind<->settledBy coupling visible in the published JSON Schema. It never
     * delivered that: the projection FLATTENS the branches and emits
     * `kind: { const: 'undecidable' }` — advertising the one modality as the only
     * legal one, which is its own reported bug (EI-21968656043579751). The
     * coupling is now carried accurately by the conditional discovery hints
     * shipped for EI-21578427141957934, so the union's only justification is
     * already served by a mechanism that actually works.
     *
     * ACCEPTANCE IS UNCHANGED. These refinements reproduce the union's accept set
     * exactly — including that shareable:true is satisfied by an explicit
     * `harness` or by scope:'harness' + `scopeRef`, but NOT by the `ref` /
     * `scope_ref` aliases (the old `explicitHarnessScope` branch keyed on
     * `scopeRef` alone). That alias gap is pre-existing and deliberately left
     * alone here rather than silently widened: this change is about the message.
     */
    const flatArgs = z.object({
      ...base,
      recheck: FACT_RECHECK_SCHEMA,
      kind: z
        .enum(['conclusion', 'assumption', 'convention', 'undecidable'])
        .optional()
        .describe(kindDescription),
      settledBy: z.string().min(1).max(500).optional().describe(settledByDescription),
      shareable: z.boolean().optional().describe(shareableDescription),
    });

    /**
     * WI-10005668 — `value` is the one wrong spelling of `body` callers reach for
     * overwhelmingly (measured 2026-10-02: 32 refusals / 14 distinct owners in 24h on
     * `facts:assert`, the same contract shape as the `memory:remember`/`work_items:*`
     * families). The refusal was a dead end for them, so accept it as an ALIAS: when the
     * caller supplied a string `value` and NO `body`, treat the string as the body.
     *
     * Deliberately narrow: only `value` (not `claim`, 8 refusals/5 owners — too ambiguous
     * with the claim/evidence vocabulary elsewhere), only a string, and never when `body`
     * is present — so a call that names both still reaches the strict-object refusal for the
     * stray key instead of silently choosing one. A `z.preprocess` wrapper is transparent to
     * the published JSON Schema (the alias is NOT advertised — the canonical field is still
     * `body`, so the tool prompt does not grow), and it adds no `ctx.addIssue`, so it cannot
     * mask sibling field issues the way an issue-raising preprocess does.
     */
    const foldValueAliasIntoBody = (data: unknown): unknown => {
      if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
      const record = data as Record<string, unknown>;
      if (typeof record.value !== 'string' || record.body !== undefined) return data;
      const { value, ...rest } = record;
      return { ...rest, body: value };
    };

    return z
      .preprocess(
        foldValueAliasIntoBody,
        flatArgs
      .superRefine((value, ctx) => {
        if (!value || typeof value !== 'object') return;
        const v = value as {
          kind?: unknown;
          settledBy?: unknown;
          shareable?: unknown;
          scope?: unknown;
          scopeRef?: unknown;
          harness?: unknown;
        };
        const nonEmpty = (x: unknown): boolean => typeof x === 'string' && x.trim() !== '';

        // Modality coupling. Each violation names the ONE field to change and the
        // repair, and never contradicts a field the caller already got right.
        if (v.kind === 'undecidable' && !nonEmpty(v.settledBy)) {
          ctx.addIssue({
            code: 'custom',
            path: ['settledBy'],
            message:
              "facts:assert — kind:'undecidable' requires settledBy: name the concrete probe/query/measurement that WOULD settle this question. " +
              'An UNKNOWN with no stated exit invites the next reader to re-derive it, which is the cost this modality exists to remove. ' +
              "Supply settledBy, or drop kind:'undecidable' if the claim is actually settled.",
          });
        }
        if (v.kind !== 'undecidable' && v.settledBy !== undefined) {
          ctx.addIssue({
            code: 'custom',
            path: ['settledBy'],
            message:
              `facts:assert — settledBy is only valid with kind:'undecidable'; on a settled claim it has no referent` +
              `${v.kind === undefined ? ' (you declared no kind, which is treated as settled)' : ` (you declared kind:'${String(v.kind)}')`}. ` +
              "Either remove settledBy, or set kind:'undecidable' if this really is not determinable from the available evidence.",
          });
        }

        // Federation coupling — only ever raised when the caller actually opted in.
        if (v.shareable === true && !nonEmpty(v.harness) && !(v.scope === 'harness' && nonEmpty(v.scopeRef))) {
          ctx.addIssue({
            code: 'custom',
            path: ['harness'],
            message:
              'facts:assert — shareable:true needs a resolvable federation harness. Pass a concrete `harness` (any scope), ' +
              "or use scope:'harness' with its canonical `scopeRef`. Omit `shareable` to keep the fact pot-private — " +
              'that is the default and is almost always what you want.',
          });
        }
      })
      /**
       * EI-21949855462339968 — PUBLISH THE CONTRACT, do not let callers discover it by rejection.
       *
       * D-011 normalized two of the three volatile rules into repairs (measuredAt alone INFERS
       * subjectVolatile; an over-cap ttlSec is CLAMPED and disclosed). Exactly ONE hard refusal
       * survived — subjectVolatile:true without measuredAt — and it lived only in the store, past
       * the schema. Two consequences, both measured on this item:
       *
       *   1. `assertTool.args.safeParse({ subjectVolatile: true })` ACCEPTED an argument set that
       *      the write then refused, so the schema was not the contract.
       *   2. `dryRun:true` — whose entire job is "compute what this assert WOULD cost" — ran its
       *      forecast on that unvalidated input and answered `ok:true, wrote:false`, a FALSE GREEN
       *      for a write that cannot succeed. A caller doing the responsible thing (preview first)
       *      was told to proceed and then refused anyway.
       *
       * Enforcing it HERE fixes both at once: args validation runs before the handler, so the
       * forecast path can no longer be reached with input the write would reject. The message is
       * kept identical to the store's so whichever layer refuses teaches the same thing.
       *
       * `measurement` is the compatibility alias for the same pair, so a caller who supplies the
       * timestamp only through it is satisfied and must not be refused.
       */
      .superRefine((value, ctx) => {
        if (!value || typeof value !== 'object') return;
        const candidate = value as {
          key?: unknown;
          body?: unknown;
          slot?: unknown;
          acceptTruncation?: unknown;
          kind?: 'conclusion' | 'assumption' | 'convention' | 'undecidable';
          confidence?: (typeof FACT_CONFIDENCE_LEVELS)[number];
          ttlSec?: number;
          permanent?: boolean;
          subjectVolatile?: unknown;
          measuredAt?: unknown;
          measurement?: { measuredAt?: unknown } | null;
        };
        if (
          typeof candidate.key === 'string' &&
          typeof candidate.body === 'string' &&
          candidate.acceptTruncation !== true
        ) {
          const slot =
            candidate.slot === 'dead-end' || candidate.slot === 'wall' || candidate.slot === 'guard-rail'
              ? candidate.slot
              : undefined;
          const refusal = truncationRefusal(normalizeFactInput(candidate.key, candidate.body, slot).body);
          if (refusal) {
            ctx.addIssue({ code: 'custom', path: ['body'], message: refusal });
          }
        }
        const flat = typeof candidate.measuredAt === 'string' ? candidate.measuredAt.trim() : '';
        const aliased =
          candidate.measurement && typeof candidate.measurement.measuredAt === 'string'
            ? candidate.measurement.measuredAt.trim()
            : '';
        const hasMeasuredAt = Boolean(flat || aliased);
        if (candidate.subjectVolatile === true && !hasMeasuredAt) {
          ctx.addIssue({
            code: 'custom',
            path: ['measuredAt'],
            message:
              'facts:assert — subjectVolatile:true requires measuredAt (the ISO timestamp of the sample). ' +
              'It is NOT defaulted to now(): that would stamp a sample of unknown age as fresh, which is ' +
              'the exact misreading measuredAt exists to prevent.',
          });
          // Match the store's ordering: the missing timestamp is the actionable
          // refusal, so do not add a second lifetime complaint for the same call.
          return;
        }

        // Keep schema preflight and the store's write boundary on the same lifetime
        // contract. The store infers a volatile subject from either measuredAt spelling,
        // and slot:'…' normalizes the key before validation; mirror both here so safeParse
        // and dryRun cannot report a false green for a write that assertFact will refuse.
        const normalizedKey =
          typeof candidate.key === 'string' && typeof candidate.body === 'string'
            ? normalizeFactInput(
                candidate.key,
                candidate.body,
                candidate.slot === 'dead-end' || candidate.slot === 'wall' || candidate.slot === 'guard-rail'
                  ? candidate.slot
                  : undefined,
              ).key
            : '';
        const lifetimeError = validateFactLifetime({
          key: normalizedKey,
          kind: candidate.kind,
          ttlSec: candidate.ttlSec,
          permanent: candidate.permanent,
          confidence: candidate.confidence,
          subjectVolatile: candidate.subjectVolatile === true || hasMeasuredAt,
        });
        if (lifetimeError) {
          const path = lifetimeError.includes('permanent:true') ? ['permanent'] : ['ttlSec'];
          ctx.addIssue({ code: 'custom', path, message: lifetimeError });
        }
      })
      .meta({ 'x-papercusp-call-constraint': FACT_LIFETIME_CALL_CONSTRAINT }),
      );
  })(),
  async handler(args, ctx) {
    const { resolveAgentIdentity, deriveAgentRole } = await import('../coordination/identity');
    const identity = resolveAgentIdentity(ctx);
    const concreteHarnessSlug = resolveConcreteHarnessSlug(args.harness, ctx);
    const normalizedMeasurement = normalizeMeasurementInput(args);
    // EI-7517: default an OMITTED scopeRef from the caller's context for the
    // self-scoped cases (owner = me, harness = this harness, role = my role), so
    // the common "assert a fact about just myself" doesn't error on a missing
    // ref the tool can infer. An explicit scopeRef always wins.
    const aliasedScopeRef = resolveScopeRefAlias(args.scope, args);
    const scopeRef = resolveFactScopeRef(args.scope, aliasedScopeRef, {
      ownerId: identity.ownerId,
      harnessSlug: concreteHarnessSlug,
      role: deriveAgentRole(identity),
    });
    // Keep dryRun's forecast on the same validated input as the real write.
    // `ref`/`scopeRef` aliases are resolved above, so validate the final
    // selector before any preview work can return a false green.
    const scopeRefShapeErr = validateFactScopeRefShape(args.scope, scopeRef);
    if (scopeRefShapeErr) throw new InvalidInputError(`facts:assert — ${scopeRefShapeErr}`);
    // F1-1 federation identity: a SHAREABLE fact must carry the hive-home slug
    // (mig 461 harness_slug) or the capture routes nowhere and peers reject the
    // wire row. Resolved only when federating (a registry read per assert is
    // not worth paying for hive-private facts).
    // EI-20339866359446342: an explicit harness-scoped fact already names the
    // federation context in its normalized `scopeRef`. The old call ignored it
    // and consulted only ctx.harnessSlug, so an SU/operator call with
    // `{ scope:'harness', scopeRef:'papercusp', shareable:true }` was rejected
    // as unroutable despite carrying the exact slug the resolver needs. Reuse
    // the normalized ref (which also folds the documented `harness` alias) for
    // harness-scoped facts; other scopes still derive federation identity from
    // the caller's concrete harness context.
    const federationHarnessSlug = args.scope === 'harness' ? scopeRef : concreteHarnessSlug;
    const potHomeSlug =
      args.shareable === true
        ? await (await import('../../agent-facts/store')).resolveFactFederationSlug(federationHarnessSlug)
        : null;
    if (args.shareable === true && !potHomeSlug) {
      throw new InvalidInputError(
        'facts:assert — a shareable fact requires a resolvable federation scope; pass a harness-scoped context ' +
          'or omit shareable to keep the fact private. A shareable fact without harness_slug would be captured ' +
          'and fail in substrate_outbox.',
      );
    }
    // P-007: a TYPED sourceRef (msg:/wi:/session_turn:/owner-turn) is platform-verified at
    // assert time — the stamp travels with the fact and folds render the
    // verified quote with zero extra reads. Fail-soft: stamping never blocks
    // the assert (the resolver degrades internally; this catch is the belt).
    let sourceProvenance: FactSourceProvenance | null = null;
    if (args.sourceRef) {
      try {
        const { resolveFactSourceProvenance } = await import('./source-provenance-resolve');
        sourceProvenance = await resolveFactSourceProvenance(identity, args.sourceRef);
      } catch {
        sourceProvenance = null;
      }
    }
    // P-015 dead-end / owner-wall-ttl-lapse-hardening wall / EI-21154276512983646
    // guard-rail slots: normalize key/body onto the slot encoding (idempotent).
    // EI-19972486772917172: a fact's `body` (and `settledBy`, for kind:'undecidable')
    // fold VERBATIM into every future orient — the exact hazard text-safety.ts was
    // built to defuse for work-item/issue titles+bodies (EI-9262/EI-9267: a fabricated
    // `</invoke><invoke name="work_items:claim">…` tail read by a later agent as a live
    // continuation of ITS OWN tool-call stream). That defusing was applied only at
    // `createIssue` (issues-engineer.ts) — facts:assert, the highest-stakes consumer
    // BECAUSE of the verbatim-into-every-orient property (and because a malformed
    // client-side tool-call serialization has now been observed leaking literal
    // `<parameter name="…">…</invoke>`-shaped text into `body`), had no such guard.
    // Neutralize (cosmetic full-width `＜` swap, non-destructive, idempotent — never
    // drops or truncates content) rather than refuse: P-007's "never lose a write
    // outright" applies here exactly as it does to the truncation path below.
    const safeSettledBy = neutralizeToolCallTags(args.settledBy);
    // recheck.exec is EXECUTED by harness preflights and never folded into a prompt, so it
    // passes through byte-exact — the swap would corrupt a shell command.
    const safeRecheck = args.recheck
      ? {
          probe: neutralizeToolCallTags(args.recheck.probe),
          falsifier: neutralizeToolCallTags(args.recheck.falsifier),
          ...(args.recheck.exec ? { exec: args.recheck.exec } : {}),
        }
      : null;
    const normalizedInput = normalizeFactInput(args.key, args.body, args.slot);
    const slotted = { key: normalizedInput.key, body: normalizedInput.body };
    // frozen-candidate-carry-and-launch-fail-closed P-002: a standing fact is
    // injected verbatim into every future orient, so persisting a positive
    // instruction to recut the judged candidate from a moving source is already
    // an authority change. Refuse it before the bounded store transaction (and
    // before any eviction/version append) while a live frozen marker exists.
    const frozenCarryVerdict = evaluateFrozenLineageCarryText({
      surface: 'fact',
      text: slotted.body,
      target: resolveHomeGateVerdictTarget(),
    });
    if (!frozenCarryVerdict.allowed) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(frozenLineageCarryViolationPayload(frozenCarryVerdict)),
          },
        ],
        isError: true,
      };
    }
    // WI-2142026: a caller who spells the slot intent into the KEY ITSELF
    // (`wall-unified-web-portal-blocked-on-byoc-gates`) instead of passing
    // `slot:` receives NONE of the slot's protection — the cap exemption, the
    // long TTL and the never-drop folds are every one of them keyed on the
    // normalized prefix the branch above produces, and that branch only runs on
    // an explicit `slot`. Measured 2026-09-02: both such keys in the workspace
    // scope had been cap-evicted, one of them that hour while carrying a live
    // owner-gated blocker.
    //
    // Detected HERE because this is the last point where the caller's ORIGINAL
    // key and their `slot` argument are both still in scope — downstream only
    // the normalized `slotted.key` survives, and by then the near-miss is
    // indistinguishable from an ordinary key. Reported on the receipt, never
    // auto-corrected: rewriting the key would move the upsert target, so the
    // caller's next re-assert would fork a second fact and orphan this one.
    const slotIntent = detectSafetySlotKeyIntent(args.key, args.slot ?? null);
    const slotIntentWarning = slotIntent ? buildSafetySlotIntentWarning(slotIntent) : null;
    // EI-21228381584914967: a never-drop fact ABOUT the agent-mcp response transport
    // cannot reach a session whose transport is failing — both fact-delivery paths
    // (the coord:orient fold and the turn-start orientation fold) ride that same
    // response envelope. The write still succeeds (it reaches every healthy session
    // and is the durable record); the author is told that the operative instruction
    // also has to go in the launch context, which is assembled before any tool call.
    // Advisory and fail-soft, like every other lint on this receipt.
    const undeliverableGuardRail = detectUndeliverableGuardRail(
      args.slot ?? null,
      slotted.key,
      slotted.body,
    );
    // P-016 / EI-212678: classify BEFORE persistence. A response-only lint can
    // be dropped by the caller while the fact is then folded as clean authority.
    // A verified owner-turn source is the sole exception; all other owner prose
    // is retained but downgraded to suspected with a loud source stamp.
    const preWriteStamp = await stampCarrySurfaceProvenance(slotted.body, identity.ownerId);
    const ownerEnforcement = ownerAttributionEnforcement(slotted.body, preWriteStamp);
    const verifiedOwnerSource = sourceProvenance?.kind === 'owner-turn' && sourceProvenance.verified;
    const enforceUnverifiedOwner = ownerEnforcement.unverified && !verifiedOwnerSource;
    if (enforceUnverifiedOwner) {
      sourceProvenance = {
        kind: 'owner-turn',
        verified: false,
        error: 'owner_attribution_unverified',
        verifiedAt: new Date().toISOString(),
      };
    }
    // EI-20191817484694278: a durable fact can carry a moving count/status and
    // age into a confident lie. Detect the shape at the write boundary so the
    // author can tighten it immediately; this is advisory and fail-soft.
    const measurementWarning = factMeasurementHint(slotted.body);
    // EI-20307375669832848: the measurement scan above is number-anchored, so an
    // absence written in words ("no membership exists", "was never touched") is
    // structurally invisible to it. Absence is the claim most worth expiring —
    // it is read as "already checked" and suppresses the next check — so it gets
    // its own advisory on the same fail-soft write-boundary channel.
    // Scan the neutralized caller-authored text. Safety-slot prefixes are
    // serialized storage boilerplate, not claims the author made; in
    // particular, "do not repeat" must not turn nearby positive result prose
    // into an absence warning. Persist the normalized slot body unchanged.
    const absenceWarning = factAbsenceHint(normalizedInput.authoredBody);
    // EI-18685042986450096 (owner-flagged): the old behavior wrote the
    // clipped body UNCONDITIONALLY and only disclosed the loss AFTER the write
    // (truncationField below) — silently dropping the OPERATIVE clause 3x,
    // once removing a discriminator rule's verdict sentence entirely. A fact
    // folds VERBATIM as binding context, so an unnoticed truncation is not a
    // clipped note, it is a wrong instruction presented as complete. REFUSE
    // BEFORE the write (name the overage, preview the exact tail that would be
    // cut) unless the caller explicitly accepts the loss via acceptTruncation —
    // preserving P-007's "never lose a write outright" invariant (the caller
    // always has a path forward: shorten it, or explicitly opt in) while
    // closing the "silent after-the-fact" gap this item is about.
    if (args.acceptTruncation !== true) {
      const refusal = truncationRefusal(slotted.body);
      if (refusal) throw new InvalidInputError(refusal);
    }
    // P-003 / WI-2141838 — the slot TTL defaults MOVED INTO THE STORE, keyed on the
    // key PREFIX rather than on this tool's `slot` argument. The line here used to read
    // `args.ttlSec ?? (args.slot === 'wall' ? WALL_DEFAULT_TTL_SEC : undefined)`, which
    // gave the long TTL to the wall slot ALONE — a dead-end: or guard-rail: fact fell to
    // the legacy ordinary 7d lifetime, lapsed out of folds, and became reaper-eligible. That is exactly
    // the defect WI-2141838 documented at this file:line. Keying on the PREFIX instead
    // also covers a caller who writes a `wall:` key without passing slot:'wall', which
    // this line could never see, and puts the rule where every writer passes through.
    //
    // (This declaration was restored 2026-07-26 by WI-5989 after being deleted while its
    // use survived — a ReferenceError on EVERY assert. It is removed here WITH its use,
    // and the WALL_DEFAULT_TTL_SEC import that becomes unused goes with it.)
    const ttlSec = args.ttlSec;
    // P-008 (b): resolve the declared cell dependencies to DIGESTS now, so a
    // later read can answer "did what this rests on change?" mechanically
    // (D-007/D-012) rather than by eyeballing the fact's age. Fail-soft in two
    // layers: captureFactDependencies already records a per-cell unknown for a
    // cell it cannot read, and this catch covers the registry/dispatcher being
    // unavailable wholesale. Losing the DECLARATION is bad; losing the FACT
    // because a resolver was down would be worse, and is the failure mode this
    // table's write path has been hardened against twice already.
    let dependsOn: FactDependency[] = [];
    const declaredCells = (args.dependsOn ?? []).map((d) => (typeof d === 'string' ? d : d.cell));
    const { reader: cellReader } = cellReaderFromCtx(identity, ctx);
    if (declaredCells.length > 0) {
      try {
        const { captureFactDependencies } = await import('./dependency-staleness');
        const { env } = cellReaderFromCtx(identity, ctx);
        // A caller-relative cell needs its SUBJECT, or the read comes back
        // `insufficient-data` and the dependency can never be compared.
        const subjects: Record<string, string> = {};
        for (const d of args.dependsOn ?? []) {
          if (typeof d !== 'string' && d.as) subjects[d.cell] = d.as;
        }
        dependsOn = await captureFactDependencies(declaredCells, cellReader, env, subjects);
      } catch {
        dependsOn = [];
      }
    }
    // assertFact appends a version and may evict at the per-scope cap, so the
    // whole multi-query write must share one bounded transaction. Retry that
    // complete unit on transient PG contention; retrying individual statements
    // could leave a partial append/eviction behind.
    const factInput = {
      scope: args.scope,
      scopeRef: scopeRef ?? null,
      key: slotted.key,
      body: slotted.body,
      ...(args.supersedes ? { supersedes: args.supersedes } : {}),
      sourceRef: enforceUnverifiedOwner ? args.sourceRef ?? 'owner-turn' : args.sourceRef ?? null,
      audienceScope: args.audienceScope ?? null,
      sourceProvenance,
      confidence: enforceUnverifiedOwner ? 'suspected' : args.confidence ?? null,
      subjectVolatile: normalizedMeasurement.subjectVolatile === true,
      measuredAt: normalizedMeasurement.measuredAt ?? null,
      kind: args.kind ?? null,
      settledBy: safeSettledBy ?? null,
      ...(safeRecheck ? { recheck: safeRecheck } : {}),
      ...(dependsOn.length > 0 ? { dependsOn } : {}),
      ...(args.claim ? { claim: args.claim } : {}),
      // P-018: validated inside assertFact (validateConventionEnforcement), not
      // here — the D-016 floor rule has to bind every writer, not just this tool.
      ...(args.enforcement ? { enforcement: args.enforcement } : {}),
      ttlSec,
      // P-001/P-002: validated inside assertFact (validateFactLifetime), not here —
      // the rule has to bind every writer, not just this tool. Same reasoning as
      // enforcement above.
      ...(args.permanent !== undefined ? { permanent: args.permanent } : {}),
      createdBy: identity.ownerId,
      // P-012 / D-006: a writer holding a restricted disclosure stores a sealed stub.
      writerOwnerId: identity.ownerId,
      ...(args.shareable !== undefined ? { shareable: args.shareable } : {}),
      ...(potHomeSlug ? { potHomeSlug } : {}),
    };
    // EI-20515478467800187: the eviction cap's look-before-you-leap surface.
    // The BODY cap has refused-before-write + preview since EI-18685042986450096
    // (above); the EVICTION cap disclosed its victim only in the receipt of the
    // write that had already destroyed them. dryRun closes that asymmetry
    // WITHOUT making eviction refuse by default: workspace scope runs
    // permanently at cap, so a default refusal would stop every ordinary assert
    // and train agents to pass the override reflexively — ceremony, not a guard.
    if (args.dryRun === true) {
      const { previewFactCapImpact } = await import('../../agent-facts/store');
      const preview = await previewFactCapImpact(factInput);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              dryRun: true,
              wrote: false,
              ...preview,
            }),
          },
        ],
      };
    }
    const fact = await acquireWithContentionRetry(() =>
      boundedOrgTxn((tx) => assertFact(factInput, tx)),
    );
    // WI-10005685: a wall: fact that names a plan item does not bind placement —
    // goal placement obligations, launch admission and claims read plan STATE.
    // Name every cited item still marked placeable, with the write that binds it.
    // Fail-soft: a read error leaves the receipt without the field.
    const wallPlanState = slotted.key.startsWith('wall:')
      ? await detectWallPlanStateGap(
          slotted.key,
          slotted.body,
          identity.workspaceId?.trim() || activeWorkspaceId(),
          readWalledItemStatusesPg,
        )
      : null;
    // P-009 / D-011: an ASSUMPTION advances this agent's assumption watermark,
    // which every subsequent tool call is stamped with. `fact.id` is the
    // append-versioned row id P-008(a) made immutable — that immutability is
    // precisely what lets ONE monotonic id name a SET ("every live assumption of
    // mine at or below this id"), so no assumption-set table is needed.
    //
    // Only an ASSUMPTION moves it: a conclusion or a convention is not something
    // the agent is provisionally taking as true, and folding those in would make
    // the watermark mean "any fact I wrote", which no reader wants.
    //
    // ⚠ Via `isAssumptionFact`, NOT a hand-rolled `kind === 'assumption'`. P-008
    // shipped the assumption as `confidence:'suspected'` + `dependsOn` BEFORE
    // migration 690 added the `kind` discriminator, and `kind` is still declared
    // on a small minority of rows (D-083 §2) — so a kind-only test silently
    // misses every legacy-form assumption while passing every fixture that sets
    // the new field. One predicate decides what an assumption is (D-087 R2); a
    // second copy here would be free to drift from it.
    //
    // ⚠ The predicate now lives in `agent-facts/store.ts`. WI-6545 / D-103 retired
    // P-011's detector, which used to be its home — this watermark is its
    // surviving caller, and the reason it was not retired alongside.
    if (isAssumptionFact({ kind: args.kind ?? null, confidence: args.confidence ?? null })) {
      noteAssumptionAsserted(identity.ownerId, fact.id ?? null);
    }
    // WI-3801 lint + P-014 turn-ref verification/origin stamp — warn-only,
    // no fields on the common clean case.
    const provenanceFields = await carryProvenanceFields(slotted.body, identity.ownerId, {
      precomputedStamp: preWriteStamp,
    });
    // EI-10952: a body over the cap is TRUNCATED, not rejected (P-007 — the hard
    // reject cost 7 whole facts in 14d, so truncate-not-reject stays). But the
    // caller was never TOLD: the response was a clean `ok:true` and the fact
    // shipped cut mid-sentence. Facts fold VERBATIM into every future orient and
    // are BINDING context, so a silently-truncated fact is not a clipped note —
    // it is a mid-sentence INSTRUCTION presented as complete, to every future
    // agent, until someone retracts it. Keep the write; stop calling it clean.
    const truncation = truncationField(slotted.body, fact.body);
    // EI-22164571843016048: the provenance quote is captured server-side from
    // the owner's turn and then folded VERBATIM to every reader, so a turn that
    // also contained a pasted credential would BROADCAST it. The quote is now
    // scanned and redacted before persisting — but a silent redaction is its
    // own defect: a redacted quote and a source with nothing quotable render
    // identically, so the caller is told which one happened. Same
    // disclose-don't-silently-alter discipline as `truncated` above.
    const sourceQuoteRedacted = fact.sourceProvenance?.quoteRedacted === true
      ? {
          note:
            'The verified source quote carried a CREDENTIAL-SHAPED value and was replaced with a redaction ' +
            'marker before it was stored. The fact itself, its source ref and its verified flag are unaffected — ' +
            'only the quoted snippet was withheld, because a fact folds verbatim into every reader\'s context. ' +
            'If the source turn really did contain a secret, rotate it: this redaction stops the BROADCAST, it ' +
            'does not un-paste the credential.',
        }
      : undefined;
    // P-008 (b): the same disclosure discipline, for dependencies. A cell the
    // caller DECLARED but that could not be read is stored honestly (it will
    // read `undeterminable` forever, never `fresh`) — but a silent `ok:true`
    // would let the agent believe it had armed auto-invalidation when it had
    // not. That is exactly the "silent after-the-fact" gap
    // EI-18685042986450096 closed for truncation, so it is closed here too,
    // warn-only: no field at all on the clean case.
    const unresolvedDeps = fact.dependsOn.filter((d) => !d.digest);
    const droppedDeps = declaredCells.filter((c) => !fact.dependsOn.some((d) => d.cell === c.trim()));
    // Coordination already verifies SHA-shaped tokens against the integration
    // tree. Reuse its bounded, fail-soft resolver so message/artifact IDs cannot
    // become Git dependencies merely because nearby prose says "live".
    const dependsOnSuggestion = await dependsOnSuggestionFieldResolvingCommits(slotted.body, args.dependsOn ?? [], cellReader);
    const dependencyWarning =
      unresolvedDeps.length > 0 || droppedDeps.length > 0
        ? {
            ...(unresolvedDeps.length > 0
              ? {
                  unresolved: unresolvedDeps.map((d) => ({ cell: d.cell, reason: d.unknown })),
                }
              : {}),
            ...(droppedDeps.length > 0 ? { dropped: droppedDeps } : {}),
            note:
              'These declared dependencies carry NO comparison anchor, so this fact can never be reported fresh or stale ' +
              'on their account — only `undeterminable`. `absent` = no such cell for you (a typo, or outside your ' +
              'audience). `insufficient-data` usually means the cell is CALLER-RELATIVE and you passed a bare id — ' +
              'declare it as { cell, as: "<subject>" } instead. Run state:read { } for the cells you may read and ' +
              'their callerRelativity.',
          }
        : null;
    // ⚠ The D-087 R5 `detectorVisibility` warning that stood here is GONE, removed
    // by WI-6545 / D-103 along with the detector it advertised. It told an asserting
    // agent that a claimless assumption was invisible to `facts:conflicts`; with that
    // detector retired the warning pointed at nothing, and a warning that names a
    // surface which no longer exists is worse than no warning — it sends the reader
    // looking for a tool to satisfy. Do not reinstate it without a detector to name.
    //
    // P-006 / D-001 — the dispute detector, which DOES have a detector to name, and
    // deliberately does NOT repeat the mistake above. It keys on the version chain this
    // very write produces (no `claim` field, no opt-in, no cooperation needed), and it
    // costs NOTHING on the common path: a first assert has no `supersedesId`, so the
    // chain is never read. Only a re-assert pays — ~10% of writes on the measured data.
    //
    // Fail-soft by construction: an advisory that could fail a write would be a strictly
    // worse trade than the friction it prevents.
    let keyContested: KeyContestAssessment | null = null;
    let overwroteAuthor: OverwroteAuthorDisclosure | undefined;
    if (fact.supersedesId != null) {
      try {
        const versions = await factVersions({
          scope: args.scope,
          scopeRef: scopeRef ?? null,
          key: slotted.key,
          limit: 8,
        });
        // P-008(a): use the exact predecessor pointer for authorship disclosure.
        // Do not infer from the newest remaining row if history has been pruned or
        // a concurrent write changes the chain before this read completes.
        overwroteAuthor = overwroteAuthorField({
          prior: versions.find((v) => v.id === fact.supersedesId),
          asserter: identity.ownerId,
          key: slotted.key,
        });
        keyContested = assessKeyContest({
          // Exclude the row THIS call just wrote — the assessment is about the ground the
          // asserter is walking over, not about their own footprint.
          chain: versions.filter((v) => v.id !== fact.id).map((v) => ({
            id: v.id,
            createdBy: v.createdBy,
            body: v.body,
            kind: v.kind,
            settledBy: v.settledBy ?? null,
            updatedAt: v.updatedAt,
          })),
          asserter: identity.ownerId,
          assertedKind: args.kind ?? null,
        });
      } catch {
        keyContested = null;
      }
    }
    // WI-7298: an assert that pushed a peer's still-valid fact out of a saturated
    // scope reported success IDENTICALLY to one that displaced nothing. WI-6935 (b)
    // made eviction distinguishable after the fact (`evicted_at IS NOT NULL`), but
    // only to a forensic reader running SQL — the writer, the one party positioned
    // to react, was never told.
    //
    // Stripped off the nested `fact` so the wire shape of a fact stays exactly an
    // AgentFact: the eviction report is a property of the WRITE, not of the fact.
    const { evicted: evictedFacts, survival, retiredKeys, ...factForWire } = fact;
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            fact: factForWire,
            ...(retiredKeys?.length
              ? {
                  retired: {
                    keys: retiredKeys,
                    note:
                      `These ${retiredKeys.length} CURRENT local sibling fact(s) were soft-retracted in the ` +
                      `same transaction as this assert with reason "superseded by ${fact.key}". Their history remains ` +
                      'available through facts:list history; missing, wrong-scope, and already-retired requested keys were unchanged.',
                  },
                }
              : {}),
            ...(evictedFacts?.length
              ? {
                  evicted: {
                    facts: evictedFacts,
                    note:
                      `Seating this write EVICTED the fact(s) above: this scope is AT its ` +
                      `${FACTS_PER_SCOPE_CAP}-fact cap. They will never be FOLDED again — ` +
                      `evicted by the cap, not expired and not retracted by their author. Your ` +
                      `next assert into this scope will cost another one. THE BODY IS NOT ` +
                      `DESTROYED: eviction is a soft-delete (it stamps evicted_at). Each ` +
                      `entry above carries a bodyExcerpt so you can judge whether it ` +
                      `mattered without a second call; where bodyTruncated is true, the ` +
                      `FULL text is still readable via ` +
                      `facts:list { scope, key, versions:true, full:true } — and re-assert ` +
                      `it if it does still matter. ` +
                      `Ranking: victims are chosen by confidence tier first ('verified' safest), ` +
                      `then by the REMAINING FRACTION of the author's declared TTL. That ` +
                      `fraction is scale-invariant, so TTL LENGTH is not what puts a fact at ` +
                      `risk: a short-TTL fact just written ranks among the SAFEST and only ` +
                      `yields as it approaches its own expiry.`,
                  },
                }
              : {}),
            ...(overwroteAuthor ? { overwroteAuthor } : {}),
            // EI-19451909636567773: the receipt above reports the fact you
            // DESTROYED. This one reports whether YOUR OWN write is going to
            // survive — the half the writer can actually act on, and the half
            // that was withheld. Only present on an at-cap write (see
            // FactSurvival), and only ALARMING when nextVictim is true, so the
            // common case stays a single quiet line.
            ...(survival
              ? {
                  survival: {
                    ...survival,
                    note: survival.nextVictim
                      ? `⚠ THIS FACT IS NEXT. It ranked LAST (${survival.rank} of ` +
                        `${survival.liveCount}) in this scope, so the next assert here by ANY ` +
                        `agent evicts it — regardless of the future expiresAt above. ` +
                        `A LONGER TTL WILL NOT SAVE IT (EI-19483432832662150): ranking is by the ` +
                        `remaining SHARE of the TTL you declared, and a fresh write already scores ` +
                        `~1.0, the maximum that key can produce` +
                        (survival.survivingFractionFloor !== null
                          ? `, against ${survival.survivingFractionFloor.toFixed(2)} for the fact ` +
                            `just above yours. So something other than TTL put you last — most ` +
                            `likely a lower \`confidence\` tier than the incumbents. `
                          : `. So something other than TTL put you last — most likely a lower ` +
                            `\`confidence\` tier than the incumbents. `) +
                        `Write it somewhere durable instead (a work-item checkpoint / an ` +
                        `agent-insights doc) — a fact you assume is standing but that was evicted ` +
                        `fails SILENTLY: it just stops appearing in folds.`
                      : `This fact ranks ${survival.rank} of ${survival.liveCount} in this ` +
                        `at-cap scope (1 = safest); it survives until ${survival.liveCount - survival.rank} ` +
                        `more fact(s) outrank it.`,
                  },
                }
              : {}),
            ...(truncation ? { truncated: truncation } : {}),
            ...(sourceQuoteRedacted ? { sourceQuoteRedacted } : {}),
            ...(slotIntentWarning ? { slotIntentWarning } : {}),
            ...(wallPlanState ? { wallPlanState } : {}),
            ...(undeliverableGuardRail ? { undeliverableGuardRail } : {}),
            ...(dependencyWarning ? { dependenciesUnresolved: dependencyWarning } : {}),
            ...(dependsOnSuggestion ? { dependsOnSuggestion } : {}),
            ...recheckReceiptField(fact),
            ...(measurementWarning ? { measurementWarning } : {}),
            ...(absenceWarning ? { absenceWarning } : {}),
            ...(fact.measurement?.subjectVolatile
              ? {
                  snapshotWarning: {
                    note:
                      'This fact is a SNAPSHOT of a subject that may still be changing. The fold marks it explicitly; ' +
                      `its TTL is bounded to ${FACT_VOLATILE_MAX_TTL_SEC} seconds (15 minutes). Re-measure before acting.`,
                    measuredAt: fact.measurement.measuredAt,
                  },
                }
              : {}),
            ...(keyContested ? { keyContested } : {}),
            ...provenanceFields,
          }),
        },
      ],
    };
  },
});
