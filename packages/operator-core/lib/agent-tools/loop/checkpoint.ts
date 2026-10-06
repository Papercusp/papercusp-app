/**
 * loop:checkpoint — the su AUTO loop's CARRY-NOTE write (su-cold-auto-mode-2026-07-03
 * P-002 PRODUCER; the enabled→functional linchpin). The loop analog of
 * work_items:checkpoint: an su loop writes a compressed "note to my next self" that a
 * COLD wake (reset / recycle) reconstructs its working state from, instead of a grown
 * transcript. Keyed by the ownerId the loop wakes (loopScope) — STABLE across a
 * fresh-context RESET and a RECYCLE (PAPERCUSP_SID preserved, P-004), so the cold
 * successor reads the SAME note this warm turn left.
 *
 * WHY THIS EXISTS: without a producer, setLoopCarryNote has no caller, so a cold loop
 * has no anchor and decideColdWake's P-006 guard keeps it WARM forever. This tool is
 * what makes loop:arm{carry:'cold'} actually go cold — the missing half of P-002/P-004
 * (P-002 delivered the substrate; this writes it).
 *
 * SHAPE (the shared D-004 contract): pass the structured fields { did, left, insight,
 * next } (with `goal` accepted as an alias for `next`, and the historical
 * `keyInsight`/`nextAction` spellings accepted as compatibility aliases; rendered to
 * renderCarryNote's canonical `## Heading` template a cold successor
 * knows how to read) OR a raw { note } string (with historical { checkpoint } accepted
 * as a compatibility alias). Replace-on-write; a blank/null note (or all-blank fields)
 * CLEARS. Journaling ON (the loop trajectory ring, like the Queen) —
 * recent wakes' notes survive a clear so a cold successor still sees the trajectory.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { withPgContentionRetry } from '@papercusp/coordination/event-log';
import { DbCallDeadlineError } from '@papercusp/db-org';
import { resolveAgentIdentity, resolveSelfLiteral } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { resolvePotHomeSlug } from '../../pot/wake';
import { carryRowTextSchema, CARRY_ROW_ID_SCHEMA, CARRY_ROW_REPLACES_SCHEMA } from '../_carry-row-id';
import { dependsOnSpec } from '../../freshness/tool-schema';
import {
  lintUncheckedExternalClaims,
  lintUncheckedImperativeActions,
  RELATIVE_SCRATCH_ADVISORY,
  mergeCarryRows,
  parseCarryNote,
  renderCarryNote,
  renderCheckLine,
  renderWallLine,
  setLoopCarryNoteWithPrior,
  getLoopCarryNoteWithMeta,
  getLoopCarryNoteFreshness,
  listLoopCarryNoteHarnesses,
  listLoopCarryNoteScopes,
  shortCarryHash,
  CARRY_NOTE_MAX_CHECKS,
  CARRY_NOTE_MAX_WALLS,
  rescueTaggedCarryNoteBlob,
  detectCarryNoteRescueSignals,
  CARRY_ROW_SOFT_CAPS,
  FALSIFIER_MISSING_NOTE,
  checksMissingFalsifier,
  CARRY_TEXT_SOFT_CAP,
  CARRY_CAP_HARD_MULTIPLE,
  CARRY_ROW_ID_MAX,
  coerceCarryRowShape,
  coerceWallRowShape,
  normalizeFlattenedContinuityProbeRow,
  findVerificationConflict,
  sanitizeCarryRowId,
  truncateCarryField,
  splitCarryNoteChecks,
  splitCarryNoteWalls,
  withCarryNoteChecks,
  withCarryNoteWalls,
  type CarryArgRepair,
} from '../../carry-note';
import { filterTrackedRelativeScratchPaths } from '../checkpoint-relative-scratch';
import { getOrgPg } from '@papercusp/db-org';
import { getLoopStatus } from '../../harness/routines/loop';
import { getSessionBrief } from '../../session-brief';
import { HARVESTED_FIRST_LINE_RULE } from '../../harness/improvements/observation-title-guidance';
import { modeImpliesAutonomy } from '../../modes/registry';
import { getPresence } from '../coordination/presence';
import { readInbox } from '../coordination/messages';
import { readWatermark, pickUnreadCursor } from '../coordination/watermarks';
import {
  type ActiveLoopRewakeBlockedReason,
  continuationGateFromReads,
  countPendingInterrupts,
  readFleetWindDownLoopEndAuthorization,
} from '../coordination/tools/continuation-gate';
import { CONTEXT_GAUGE_CRITICAL_PCT, contextUsagePct } from '../coordination/tools/inbox-context-usage';
import { COORD_READ_TOOL_NAMES } from '../coordination/inbox-read-freshness';
import {
  carryProvenanceFields,
  expandCurrentTurnSentinel,
  hasCurrentTurnSentinel,
  markUnverifiedOwnerAttribution,
  ownerAttributionEnforcement,
  retainedProvenanceText,
  stampCarrySurfaceProvenance,
} from '../../carry-surface-provenance-stamp';
import { uncoveredAbsencePremises } from '../../premises-claim-port';
import { detectScopeOverreach } from '../../carry-note-probe-scope';
import { unresolvedPlanDecisionRefs } from '../coordination/decision-ref-advisory';
import { withBoundedTimeout } from '../../bounded-timeout';
import type { FleetZeroWorkersVerdict } from '../../fleet/fleet-zero-workers-guard';
import { OrgTxnTimeoutError } from '../../pg-bounded-txn';
import { listVerifiedWaitTakeoversForSubscribers } from '../../events/await/store';
import { resolveCurrentTurnStamp } from '../../turn-provenance/turn-ref';
import { continuityPredicateSchema, continuityProbeSchema } from '../../continuity-probes';
import { postLearnedAtLevel } from '../../effort-thread';
import { LIMITS } from '../limits';
import {
  evaluateFrozenLineageCarryText,
  frozenLineageCarryViolationPayload,
} from '../../release/frozen-lineage-execution-policy';
import { resolveHomeGateVerdictTarget } from '../../release/gate-verdict-target';

/** The continuation hint is advisory; it must never consume the checkpoint
 * tool's 60s transport budget when coordination reads are degraded. */
export const CONTINUATION_READ_BUDGET_MS = 5_000;

// A bounded carry write can spend up to its 8s lock/acquisition budget plus the
// best-effort contention diagnosis. One 100ms retry stays well inside the MCP
// transport budget while covering the common brief lock race; longer contention
// still returns the existing structured retryable timeout.
export const LOOP_CHECKPOINT_CONTENTION_BACKOFFS_MS = [100] as const;

/**
 * EI-21503907176334936 — a `rowsMode:'replace'` write computed, INSIDE the locked
 * transform, that it would retire carried rows the caller did not explicitly confirm.
 * Thrown BEFORE anything is stored so the loss is avoidable, not merely visible after
 * the fact — the exact gap P-013 left open ("the report lands AFTER the write"). The
 * handler converts this into a typed retryable refusal naming every row that would
 * have been dropped; the transaction rolls back, so the carry-note is untouched.
 */
class ReplaceWouldDropError extends Error {
  constructor(
    readonly droppedWalls: string[],
    readonly droppedChecks: string[],
  ) {
    super('checkpoint_replace_would_drop_rows');
  }
}

type FrozenCarryViolationPayload = NonNullable<ReturnType<typeof frozenLineageCarryViolationPayload>>;

/** Abort the locked carry-note transform before an unsafe final merge commits. */
class FrozenCarryCheckpointError extends Error {
  constructor(readonly payload: FrozenCarryViolationPayload) {
    super(payload.error);
  }
}

function frozenLoopCarryViolation(text: string | null | undefined): FrozenCarryViolationPayload | null {
  if (!text?.trim()) return null;
  return frozenLineageCarryViolationPayload(
    evaluateFrozenLineageCarryText({
      surface: 'loop-checkpoint',
      text,
      target: resolveHomeGateVerdictTarget(),
    }),
  );
}

function enforceFrozenLoopCarry<T extends string | null | undefined>(text: T, suppliedText?: string): T {
  // `text` may be the locked merge of this write with an older carry note. Only
  // the bytes supplied by this call are executable authority; inherited history
  // can contain a legacy directive that the caller is trying to document or retire.
  const violation = frozenLoopCarryViolation(suppliedText ?? text);
  if (violation) throw new FrozenCarryCheckpointError(violation);
  return text;
}

/* A merge whose union exceeds the durable row cap still must not commit a partial ROW
 * set — but it is no longer signalled by throwing. EI-22377179869127416 showed that
 * aborting the transaction to protect the rows also discarded the narrative, so the
 * refusal is now recorded in `captured.mergeRefused` and the narrative commits with the
 * carried rows untouched. See the refusal site inside the transform for the reasoning. */

/**
 * Count check rows that were already beyond today's durable cap before this
 * write. Legacy notes can predate the cap (or have been written by an older
 * normalizer), so an additive write against one of them must be allowed to
 * normalize the stored set instead of refusing forever: the caller cannot
 * re-send the full over-cap set through the current input schema.
 */
function priorChecksOverCapCount(priorNote: string | null | undefined): number {
  const priorChecks = splitCarryNoteChecks(priorNote ?? null).checks.filter(
    (row) => (row.claim ?? '').trim().length > 0,
  );
  return Math.max(0, priorChecks.length - CARRY_NOTE_MAX_CHECKS);
}

// The continuation-guarantee classifier lives in the leaf module ./next-wake so loop:status
// can report the SAME verdict without importing this whole tool (P-013). Re-exported here
// because checkpoint's tests and callers have always imported it from this module.
export {
  classifyLoopNextWake,
  lastLoopFireParked,
  loopGuaranteesNextWake,
  type LoopNextWakeInput,
  type LoopNextWakeVerdict,
} from './next-wake';
import { classifyLoopNextWake } from './next-wake';

/** P-013 — the optional stable row identity, shared by the walls and checks schemas
 *  (their contract is deliberately identical) AND by work_items:checkpoint's checks
 *  rows, which is why it lives in ../_carry-row-id rather than here: the two tools'
 *  schemas were copies once, and they drifted. See that module for the bound rationale. */

/**
 * Normalize the compact row shorthand accepted by walls and checks. A row
 * string is losslessly the claim itself, while a JSON-encoded array supports
 * stale manifest-pinned clients that serialized the whole field. Object rows
 * stay untouched so genuinely undeclared fields still fail the strict schema
 * instead of being silently dropped.
 */
function normalizeCompactRowInput(value: unknown): unknown {
  let rows: unknown = value;
  if (typeof rows === 'string') {
    const trimmed = rows.trim();
    if (!trimmed) return [];
    try {
      rows = JSON.parse(trimmed);
    } catch {
      rows = [rows];
    }
    // A JSON string is still a compact one-row shorthand, not an array.
    if (typeof rows === 'string') rows = [rows];
  }
  return Array.isArray(rows) ? rows.map((row) => (typeof row === 'string' ? { claim: row } : row)) : rows;
}

function normalizeWallInput(value: unknown): unknown {
  const rows = normalizeCompactRowInput(value);
  // tool-contract-repair-2026-09-05 P-005: run the claim/id ALIAS half of the row
  // coercion on walls too, so `{description, …}` / `{key, …}` are the same lossless
  // renames here that they already are on a checks row (EI-20256358119840421,
  // EI-21123164129476823, EI-22387774231617463). `coerceWallRowShape` deliberately
  // omits the `{status, evidence}` coercion WI-7264 excluded from walls, so an
  // unmappable wall shape still fails loudly rather than silently dropping data.
  return Array.isArray(rows) ? rows.map((row, i) => coerceWallRowShape(row, `walls[${i}]`, [])) : rows;
}

// Keep already-schema-valid boolean-result rows intact through the Zod boundary.
// `coerceCarryRowShape` normally runs in this preprocessor so undeclared
// compatibility aliases can be repaired before strict validation, but that
// eagerly consumes the `ok` alias and its repair details. The handler runs the
// same coercion again with its response-scoped repair list, so an explicit
// `ok:false` paired with canonical `verified` evidence can be downgraded and
// reported instead of becoming an unobservable preprocessor rewrite.
const CHECK_ROW_SCHEMA_KEYS = new Set([
  'claim',
  'id',
  'recheck',
  'verified',
  'observed',
  'ok',
  'contested',
  'probe',
  'kind',
  'command',
  'result',
  'tool',
  'args',
  'projection',
  'schemaRevision',
  'expect',
  'cell',
  'as',
]);

function canDeferCheckRowCoercion(row: unknown): boolean {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return false;
  const source = row as Record<string, unknown>;
  return (
    typeof source.ok === 'boolean' &&
    typeof source.verified === 'string' &&
    Object.keys(source).every((key) => CHECK_ROW_SCHEMA_KEYS.has(key))
  );
}

/**
 * P-007 (fleet-member-dx-improvements-2026-07-10, EI-9035): the owner's most
 * recent coord:inbox / coord:orient invocation (ISO), or null. The continuation
 * gate's unread-inbox leg previously keyed ONLY off the turn-END watermark
 * (`messages_since_ts`) — a session that never settled one has an empty
 * watermark, so the gate reported "inbox not evaluated" FOREVER, even seconds
 * after the agent literally read its inbox in the same turn. An inbox/orient
 * READ is evaluation: credit it as the unread cursor. Both name forms matched
 * (colon registry name + underscore transport variant). Best-effort: any
 * failure returns null (the gate then fails safe toward settling, as before).
 */
/** P-007 pure cursor pick — the LATER of the turn-END settle watermark and the
 *  owner's last inbox READ; either alone counts; neither ⇒ null (the gate then
 *  blocks, fail-safe toward settling).
 *
 *  MOVED to ../coordination/watermarks (unread-count-truthfulness-2026-07-27
 *  P-002): the Sessions-dossier unread badge needs the identical rule, and two
 *  copies of "what counts as read" would drift. Re-exported here because this
 *  is where it was published from. */
export { pickUnreadCursor };

export async function lastInboxReadAt(ownerId: string): Promise<string | null> {
  try {
    const { sql } = getOrgPg();
    const rows = await sql<{ invoked_at: string | Date }[]>`
      SELECT invoked_at
        FROM harness_shared.tool_invocations
       WHERE coord_owner_id = ${ownerId}
         AND tool_name = ANY(${[...COORD_READ_TOOL_NAMES]})
       ORDER BY invoked_at DESC
       LIMIT 1
    `;
    const v = rows[0]?.invoked_at;
    if (!v) return null;
    const d = v instanceof Date ? v : new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  } catch {
    return null;
  }
}

/**
 * EI-21949862791784103: one carry field of an object-shaped `checkpoint` alias. Callers
 * bleed the sibling `work_items:checkpoint` spelling across in BOTH its shapes — the
 * string half has aliased `note` since 2026-08-24, but the STRUCTURED half failed zod
 * with "Expected string, received object", an error that never names did/left/insight/
 * next, so the agent reshapes by trial. 13 reports over 6 days.
 */
const CARRY_ALIAS_FIELD = z
  .string()
  .max(CARRY_TEXT_SOFT_CAP * CARRY_CAP_HARD_MULTIPLE)
  .optional();

const EXECUTABLE_PROBE_SHAPE =
  "Executable `probe` shape (choose ONE target): `{ kind:'tool', tool:'<direct read-only tool>', args:{...}, schemaRevision:'live', expect:{ path:'$.state', op:'eq', value:'green' } }` or `{ kind:'state-cell', cell:'<registered cell>', as:'<reader>', schemaRevision:'<revision>', expect:{ path:'$.state', op:'eq', value:'green' } }`. " +
  '`kind`, the matching target (`tool` or `cell`), `schemaRevision`, and `expect` are required; `args` defaults to `{}` for tool probes. ' +
  '`probe:{ expect:... }` has no executable target — omit `probe` and put the human command in `recheck`.';

export default defineTool({
  name: 'loop:checkpoint',
  profile: 'engineer',
  description:
    'Read/write/clear COLD loop carry-note; carry mode belongs to loop:arm (`carry:\'cold\'|\'warm\'`); loop:checkpoint does not accept a `carry` argument. Read {read:true, ownerId?, harness?}; write {did,left,insight,next}, {note}, or {checkpoint}; blank/null clears. ' +
    "Default rowsMode:'merge' preserves rows; rowsMode:'replace' retires rows (empty list with replace clears). `confirmShrink` is accepted by `work_items:checkpoint` only; use `confirmRetire` here. Probe rows: kind:'tool' or kind:'state-cell', args, schemaRevision.",
  guidance: {
    when:
      "COLD: save facts; pair with work_items:checkpoint; carry mode belongs to loop:arm, not loop:checkpoint — do not retry a rejected `carry` argument here. Add same-line [turn:<session>@<iso-ts>] refs; never invent a ref. Mark [self-imposed], [peer:<sid>], or [inferred]. Default merge mode preserves them; rowsMode:'replace' retires rows. Probe rows: kind:'tool' or kind:'state-cell', args, schemaRevision. Before `session:request-compaction`, if `next` names an immediately runnable action, execute it or a bounded progress read; writing this checkpoint alone is not post-note progress. `cold-successor-no-progress` refuses compaction; scheduled loop fire/compaction is the narrow boundary exception.",
    notWhen: "WARM (carry:'warm', default) use live transcript; work_items:checkpoint for state.",
    chaining:
      'Retune: read loop:status, then ' +
      "then loop:arm { intervalSec: <number>, goal: <string>, carry: 'cold'|'warm' }; intervalSec and goal are required even when only carry changes.",
    seeAlso: [
      "loop:arm (arm the loop; carry:'cold' opts into the cold lifecycle)",
      'loop:status (inspect the loop, incl. carry mode)',
      'work_items:checkpoint (the work-item-scoped analog)',
    ],
  },
  capability: 'routines:write',
  // EI-20228649300818575: this handler writes through the carry-note store and
  // performs its own bounded coordination reads. Do not hold the ambient org-app
  // workspace transaction while it waits on those independent scopes; under pool
  // starvation that outer acquisition can deadlock the mandatory continuity write.
  skipWorkspaceTx: true,
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      read: z
        .boolean()
        .optional()
        .describe('Read the current carry-note and metadata without writing; use with ownerId?/harness? only.'),
      note: z
        .string()
        .max(32000)
        .nullish()
        .describe('Raw carry-note text; blank/null ⇒ clear. Ignored when any of did/left/insight/next is set.'),
      checkpoint: z
        .union([
          z.string().max(32000),
          // Strict + non-empty on purpose: an unrecognized object shape must be REFUSED
          // loudly, never composed into an empty note — that would be a carry-note CLEAR
          // wearing an alias costume, the silent-loss failure this tool guards elsewhere.
          z
            .object({
              did: CARRY_ALIAS_FIELD,
              left: CARRY_ALIAS_FIELD,
              insight: CARRY_ALIAS_FIELD,
              next: CARRY_ALIAS_FIELD,
              goal: CARRY_ALIAS_FIELD,
              keyInsight: CARRY_ALIAS_FIELD,
              nextAction: CARRY_ALIAS_FIELD,
            })
            .strict()
            .refine((o) => Object.values(o).some((v) => v !== undefined), {
              message:
                'an object `checkpoint` must set at least one of did/left/insight/next (goal, keyInsight, nextAction alias them)',
            }),
        ])
        .nullish()
        .describe('Compatibility alias: a string aliases `note`, an object aliases { did, left, insight, next }. Prefer the canonical form. Blank/null ⇒ clear; `note` and top-level fields win.'),
      // WI-7264: the `.max()` here is a SANITY BACKSTOP, not the real limit. The real
      // limit is CARRY_TEXT_SOFT_CAP, applied by TRUNCATION in the handler and reported
      // back as `repairs`. A hard reject discards the whole multi-KB note over one long
      // field and the agent just re-sends it — measured as 7.7% of this tool's argument
      // bytes, spent twice. Keep the advertised guidance at the soft cap.
      did: z
        .string()
        .max(CARRY_TEXT_SOFT_CAP * CARRY_CAP_HARD_MULTIPLE)
        .nullish()
        .describe('What this wake accomplished (concrete progress).'),
      left: z
        .string()
        .max(CARRY_TEXT_SOFT_CAP * CARRY_CAP_HARD_MULTIPLE)
        .nullish()
        .describe('What remains, in order.'),
      insight: z
        .string()
        .max(CARRY_TEXT_SOFT_CAP * CARRY_CAP_HARD_MULTIPLE)
        .nullish()
        // observation-and-recall-surface-honesty-2026-08-16 P-001: this field is the
        // turn-end reflection path — checkpoint-harvest's boundInsight() takes its FIRST
        // LINE verbatim as the filed observation's title, which is the only thing
        // recurrence matching ever sees. Saying "titles should be identifiers" is
        // unactionable here unless it also says which line becomes the title.
        .describe(`The non-obvious thing a cold successor would waste time re-deriving. ${HARVESTED_FIRST_LINE_RULE}`),
      next: z
        .string()
        .max(CARRY_TEXT_SOFT_CAP * CARRY_CAP_HARD_MULTIPLE)
        .nullish()
        .describe('The single concrete next action for the next wake.'),
      keyInsight: z
        .string()
        .max(CARRY_TEXT_SOFT_CAP * CARRY_CAP_HARD_MULTIPLE)
        .nullish()
        .describe('Compatibility alias for `insight`; explicit `insight` wins when both are supplied.'),
      nextAction: z
        .string()
        .max(CARRY_TEXT_SOFT_CAP * CARRY_CAP_HARD_MULTIPLE)
        .nullish()
        .describe('Compatibility alias for `next`; explicit `next` wins when both are supplied.'),
      goal: z
        .string()
        .max(CARRY_TEXT_SOFT_CAP * CARRY_CAP_HARD_MULTIPLE)
        .nullish()
        .describe(
          'Compatibility alias for `next`, for callers mirroring loop:arm { goal }. Explicit `next` wins when both are supplied.',
        ),
      // EI-21600742704531274: callers that share a loop:arm/work-item payload
      // may include the associated work-item id when refreshing the loop note.
      // It is compatibility metadata only: loop scope remains keyed by the
      // authoritative ownerId + harness pair, so accepting it must not redirect
      // or otherwise alter the carry-note write.
      //
      // EI-21719647580242620: `.nullish()`, not `.optional()`, and the same applies to
      // every optional carry-content field above. The whole point of these fields is to
      // tolerate a payload SHARED with loop:arm — and an explicit `null` is exactly the
      // shape a shared payload takes for a slot that has no value, so `.optional()`
      // refused the case the field exists to serve.
      //
      // Widening the schema alone was NOT sufficient, which is worth stating because it
      // looks sufficient: most consumers do coalesce (`args.workItem?.trim()`,
      // `(args.learned ?? '').trim()`, `detectCarryNoteRescueSignals(string|null|…)`), but
      // TWO readers did not, and both are repaired with this change — the `carry` builder,
      // which used to pass `args` through raw when no `checkpoint` alias was present, and
      // the object `.refine()`, whose `!== undefined` counted a null as a write. Do NOT
      // "simplify" either back: a `.transform()` here is not an option either, since an
      // unrepresentable JSON Schema breaks tools/list for the entire catalog.
      workItem: z
        .string()
        .max(120)
        .nullish()
        .describe(
          'Compatibility metadata for an associated work-item id; accepted but does not change loop scope (ownerId remains authoritative). Also the anchor `learned` writes from. Explicit null is treated as omission.',
        ),
      /**
       * P-017 (effort-scoped-continuity-2026-09-02, D-003/D-007/D-009).
       *
       * This is the field D-003 argued for, on the corpus that motivated it: the loop
       * carry-note scope holds the richest record of what agents actually learn —
       * measured 2026-09-02, 4,795 rows carrying 29,377 journal entries and 12.5MB of
       * note text — and it is STRUCTURALLY PRIVATE, keyed `loop:<harness>:<ownerId>`,
       * so no other agent can address it. Not by policy; by key.
       *
       * D-003 rejected bulk-mining that corpus into a shared log, because most of a
       * loop journal is one-wake bookkeeping whose value expires with the wake, and
       * copying it wholesale would bury the fraction that matters. The agent writing
       * the note is the only party that knows which part is durable. So: one optional
       * field, written in the SAME call, with curation left where the judgement is.
       */
      learned: z
        .string()
        .max(4000)
        .nullish()
        .describe(
          'a durable lesson to post on the effort thread in this same call — the part of this private loop note ' +
            'a future agent needs. Requires `workItem` as the anchor; use learnedLevel to attach it at that ' +
            "item's plan or goal instead.",
        ),
      learnedLevel: z
        .enum(['work_item', 'plan', 'goal'])
        .optional()
        .describe(
          "which level `learned` belongs to — write at the level you are working at. Default 'work_item'; a level " +
            'the anchor item lacks falls back to the most specific one it has.',
        ),
      // WI-7264: walls deliberately get the cap RELAXATION but NOT the `{status,
      // evidence}` shape coercion that `checks` gets. A wall has no `verified` field,
      // so there is no lossless place to put an `evidence` string — coercing it would
      // have to DROP the caller's data, which is the silent-loss failure
      // (EI-18723223344390510) this whole change exists to avoid re-creating. An
      // unmappable wall shape keeps failing loudly, and the data says that is fine:
      // the `{status, evidence}` volume is a checks-row phenomenon (97 calls in 6 days
      // vs 2 for walls).
      walls: z
        .preprocess(
          normalizeWallInput,
          z
            .array(
              z.object({
                claim: carryRowTextSchema(
                  CARRY_ROW_SOFT_CAPS.claim,
                  'The pending owner-gated action/decision, stated concretely.',
                  { min: 1 },
                ),
                id: CARRY_ROW_ID_SCHEMA,
                replaces: CARRY_ROW_REPLACES_SCHEMA,
                recheck: carryRowTextSchema(
                  CARRY_ROW_SOFT_CAPS.recheck,
                  'A concrete command a successor runs to re-check it.',
                ).optional(),
                // tool-contract-repair-2026-09-05 P-005, mirroring EI-21575304064818009
                // on the checks row: `normalizeWallInput` maps these losslessly, but a
                // client that validates this published row schema BEFORE the server-side
                // preprocessor runs would still report invalid_args — which is what turns
                // a working compatibility path back into the filed rejection.
                description: carryRowTextSchema(
                  CARRY_ROW_SOFT_CAPS.claim,
                  'Compatibility alias for `claim`; prefer `claim`.',
                ).optional(),
                key: CARRY_ROW_ID_SCHEMA,
              }),
            )
            .max(CARRY_NOTE_MAX_WALLS * CARRY_CAP_HARD_MULTIPLE),
        )
        .optional()
        .describe(
          'Open WALLS (owner-gated commitments) as rows — rendered into EVERY wake + carry brief until cleared. ' +
            "Compact claim strings are accepted (`walls: ['owner approval']`) and mapped losslessly to `{ claim }`; " +
            'a JSON-encoded array is accepted for stale wire manifests. ' +
            'OMITTED ⇒ existing walls CARRY FORWARD (a rewrite or note-clear never drops them); a supplied list ' +
            "REPLACES (the default is rowsMode:'merge', which upserts instead), so pass the full current set (dropped ones come " +
            'back as `wallsDropped`) only when retiring rows; [] clears under replace.',
        ),
      checks: z
        .preprocess(
          // EI-302-class wire coercion (proven live the night this shipped): a session
          // whose manifest-pinned schema predates this field sends the array as a JSON
          // STRING — parse it instead of rejecting the write. Compact claim strings
          // are the same lossless shorthand as walls. Non-array JSON values remain
          // invalid; ordinary strings are treated as the scalar shorthand.
          (v) => {
            const rows = normalizeCompactRowInput(v);
            // WI-7264: repair the wrong-but-obvious row SHAPE rather than rejecting the
            // whole note over it. `{claim, recheck, status, evidence}` is what agents
            // actually reach for — `evidence` (57×) and `status` (40×) were the top two
            // rejected undeclared keys across 6 days of transcripts, and this field's own
            // description already warns against that shape, so documenting it has not
            // worked. The coercion is data-PRESERVING (evidence becomes `verified`, so the
            // row still renders VERIFIED), which is what separates it from
            // EI-18723223344390510 — the bug where a nested row silently DROPPED those
            // keys and destroyed the evidence. Silent here means "nothing was lost", not
            // "nothing happened"; truncation, which does lose bytes, is reported instead.
            // EI-21922421392042550: also lift the flattened executable-probe envelope
            // (`{claim, kind:'tool', tool, args, schemaRevision, expect}`) — the SAME
            // compat shape work_items:checkpoint accepts, which this surface rejected
            // outright as `checks[0].tool is unrecognized` until this fix.
            return Array.isArray(rows)
              ? rows.map((row, i) => {
                  const normalized = normalizeFlattenedContinuityProbeRow(row);
                  return canDeferCheckRowCoercion(normalized)
                    ? normalized
                    : coerceCarryRowShape(normalized, `checks[${i}]`, []);
                })
              : rows;
          },
          z
            .array(
              z.object({
                claim: carryRowTextSchema(CARRY_ROW_SOFT_CAPS.claim, 'The external-state claim, stated concretely.', {
                  min: 1,
                }),
                id: CARRY_ROW_ID_SCHEMA,
                replaces: CARRY_ROW_REPLACES_SCHEMA,
                recheck: carryRowTextSchema(
                  CARRY_ROW_SOFT_CAPS.recheck,
                  'Concrete probe to run before relying on the claim.',
                ).optional(),
                falsifier: carryRowTextSchema(
                  CARRY_ROW_SOFT_CAPS.falsifier,
                  'Result that would mean this claim is FALSE (as facts:assert `falsifier`). A probe says how to look; this says what refutes it.',
                ).optional(),
                sampleAdequate: z
                  .boolean()
                  .optional()
                  .describe('`false` = probed, but the sample could not discriminate the claim from its negation; renders ? not ✓.'),
                verified: carryRowTextSchema(
                  CARRY_ROW_SOFT_CAPS.verified,
                  'The EVIDENCE STRING itself (max 300 chars) — e.g. "Verified 15:14Z: 30/30 passed, tree clean". ' +
                    'NOT a boolean (`true`/`false` is rejected) and NOT `{status, evidence}` — this ONE string field ' +
                    'carries both the verified/PREDICTED flag and its justification: presence of `verified` (however ' +
                    'short) renders the row VERIFIED; omitting it entirely renders PREDICTED. There is no separate ' +
                    'boolean flag to set.',
                ).optional(),
                observed: carryRowTextSchema(
                  CARRY_ROW_SOFT_CAPS.observed,
                  'Observed context that does not affirm the claim. It renders on a ? PREDICTED row so the context survives without acquiring verification authority.',
                ).optional(),
                ok: z
                  .boolean()
                  .optional()
                  .describe(
                    'Compatibility alias for boolean check results: `{ ok: true|false }` is normalized to the `verified` evidence slot before storage. ' +
                      'A bare true or false remains PREDICTED; pair true with `evidence` to render VERIFIED. Prefer the canonical `verified` evidence string.',
                  ),
                contested: carryRowTextSchema(
                  CARRY_ROW_SOFT_CAPS.contested,
                  'Evidence that was supplied as verification but contradicts the claim (for example, a green claim ' +
                    'with "STILL RUNNING"). Rendered with ⚠ CONTESTED and never upgraded to VERIFIED; re-check before ' +
                    'relying on the claim.',
                ).optional(),
                probe: continuityProbeSchema
                  .optional()
                  .describe(
                    'Optional schema-versioned, read-only executable probe. ' +
                      EXECUTABLE_PROBE_SHAPE +
                      ' Validated against the live tool/cell contract before any checkpoint bytes persist; `recheck` remains the human explanation.',
                  ),
                // EI-21575304064818009: expose the structured verification
                // vocabulary that coerceCarryRowShape already accepts. The
                // preprocessor maps these aliases to claim/recheck/verified,
                // but a live client validates against this nested JSON schema
                // before the preprocessor runs. Omitting them therefore turns
                // a lossless compatibility path into invalid_args.
                kind: carryRowTextSchema(
                  CARRY_ROW_SOFT_CAPS.claim,
                  'Compatibility alias for `claim` in structured verification rows; prefer `claim`.',
                ).optional(),
                command: carryRowTextSchema(
                  CARRY_ROW_SOFT_CAPS.recheck,
                  'Compatibility alias for `recheck` in structured verification rows; prefer `recheck`.',
                ).optional(),
                // Same manifest-validation reason as `kind`/`command`/`result` above:
                // `description` is a CARRY_CLAIM_ALIASES entry the preprocessor maps to
                // `claim`, so it must be published or a client-side validator rejects
                // the payload the server would have accepted.
                description: carryRowTextSchema(
                  CARRY_ROW_SOFT_CAPS.claim,
                  'Compatibility alias for `claim`; prefer `claim`.',
                ).optional(),
                result: carryRowTextSchema(
                  CARRY_ROW_SOFT_CAPS.verified,
                  'Compatibility alias for `verified` in structured verification rows; prefer `verified`.',
                ).optional(),
                // EI-22575327388783364: keep loop:checkpoint's published row
                // schema in parity with the shared checks coercion and the
                // work_items:checkpoint surface.
                testResult: carryRowTextSchema(
                  CARRY_ROW_SOFT_CAPS.verified,
                  'Compatibility alias for completion-style `testResult`; normalized to the canonical `verified` evidence string before storage. Prefer `verified`.',
                ).optional(),
                // EI-21922421392042550: the preprocessor above lifts these flattened
                // executable-probe fields into `probe` (normalizeFlattenedContinuityProbeRow,
                // shared with work_items:checkpoint). They must still be present in the
                // published row schema because some clients validate the manifest before
                // invoking the server-side parser.
                tool: z.string().min(1).max(LIMITS.IDENT).optional().describe('Compatibility field for a flattened tool probe.'),
                args: z
                  .record(z.string(), z.unknown())
                  .optional()
                  .describe('Compatibility field for flattened tool-probe arguments.'),
                projection: z.unknown().optional().describe('Compatibility field for a flattened tool-probe projection.'),
                schemaRevision: z
                  .string()
                  .min(1)
                  .max(160)
                  .optional()
                  .describe('Compatibility field for a flattened probe revision.'),
                expect: continuityPredicateSchema
                  .optional()
                  .describe('Compatibility field for a flattened probe predicate.'),
                cell: z
                  .string()
                  .min(1)
                  .max(120)
                  .optional()
                  .describe('Compatibility field for a flattened state-cell probe.'),
                as: z
                  .string()
                  .min(1)
                  .max(200)
                  .optional()
                  .describe('Compatibility field for a flattened state-cell reader.'),
              }),
            )
            .max(CARRY_NOTE_MAX_CHECKS * CARRY_CAP_HARD_MULTIPLE),
        )
        .optional()
        .describe(
          'Carried CHECKS — claims about EXTERNAL STATE as {claim, recheck, verified?, contested?} rows (compact claim strings ' +
            'are accepted and mapped to {claim}; the non-owner analog ' +
            'of walls; renders a ## Checks section every wake). `verified` is a STRING (evidence, ≤300 chars), never ' +
            'a boolean — a claim OMITTING `verified` renders PREDICTED, a successor must run its recheck before ' +
            'relying on it. If its evidence contains STILL RUNNING, pending, outstanding, in-flight, unverified, or ' +
            'awaiting while the claim asserts a completed/healthy state, the writer downgrades it to `contested` and ' +
            'reports the repair; when the claim itself asserts that unresolved state, the evidence remains VERIFIED. ' +
            'Use `contested` to force an explicit warning; contested rows render ⚠ and require a re-check. ' +
            'Put hash/id/timestamp expectations HERE, never in Left prose. Same carry-forward ' +
            'semantics as walls: OMITTED ⇒ carried; a supplied list REPLACES, so re-send the FULL set you want ' +
            "kept (dropped claims come back as `checksDropped`). The default rowsMode:'merge' preserves omitted rows " +
            'up to the row cap — on overflow the write REFUSES (naming the rows that would be evicted) unless ' +
            "confirmRetire:true is also set, in which case supplied rows win and evicted rows are named in " +
            '`checksDropped`; PREDICTED yields before VERIFIED only while seats remain, so supplying ≥ the cap ' +
            "evicts EVERY unmatched carried row; pass rowsMode:'replace' + confirmRetire:true to retire them " +
            'explicitly instead; [] clears under replace.',
        ),
      dependsOn: dependsOnSpec('carry-note'),
      rowsMode: z
        .enum(['replace', 'merge'])
        .optional()
        .describe(
          "How a supplied walls/checks list combines with the carried set. 'merge' (default) — rows UPSERT by `id` " +
            '(else by exact claim text) and unmentioned rows SURVIVE, so adding/updating ONE row needs only that ' +
            'row — but only UP TO THE ROW CAP: merge is non-destructive while the union fits, not unconditionally. ' +
            'If the union would OVERFLOW the cap, the write is REFUSED (naming every carried row that would be ' +
            "evicted in `checksDropped`/`wallsDropped`) unless `confirmRetire:true` is also set, in which case " +
            'supplied rows win and PREDICTED rows yield before VERIFIED ones — a supplied list that alone fills ' +
            "the cap evicts every carried row, evidence or not. 'replace' makes the list the new set; to retire " +
            "or edit ONE row use `retireIds` or a row's `replaces` instead of a full resend. Under 'merge' a [] " +
            'list is a no-op, never a clear.',
        ),
      retireIds: z
        .array(z.string().min(1).max(CARRY_ROW_SOFT_CAPS.claim * CARRY_CAP_HARD_MULTIPLE))
        .max((CARRY_NOTE_MAX_WALLS + CARRY_NOTE_MAX_CHECKS) * CARRY_CAP_HARD_MULTIPLE)
        .optional()
        .describe(
          'Retire carried walls/checks by [#id] or exact claim in this same write, under either rowsMode — no ' +
            'full resend. Reported as `wallsRetired`/`checksRetired`; unmatched refs as `unmatchedRowRefs`.',
        ),
      confirmRetire: z
        .boolean()
        .optional()
        .describe(
          "Confirms a deliberate row retirement. Under rowsMode:'replace' (EI-21503907176334936): when the " +
            'supplied lists would RETIRE carried rows, the write is REFUSED before anything is stored unless this ' +
            'is true — the refusal names every row that would have been dropped. Under rowsMode:\'merge\' ' +
            '(EI-21849813048365808): when the union would exceed the durable row cap, the write is likewise ' +
            'REFUSED (naming every row the cap would evict) unless this is true, in which case the cap\'s own ' +
            'PREDICTED-before-VERIFIED eviction proceeds in this same call — a one-call alternative to a separate ' +
            "rowsMode:'replace' resend. Set it only for a deliberate retirement/eviction (or a deliberate [] clear " +
            "under replace); an ordinary merge that fits under the cap never needs it.",
        ),
      expectedHash: z
        .string()
        .regex(/^[0-9a-f]{12}$/i)
        .nullable()
        .optional()
        .describe(
          'Optional optimistic-CAS baseline: the 12-character contentHash returned by the last loop:checkpoint/read. ' +
            'Use null to assert that no note existed; on mismatch the write is refused and the current hash is returned.',
        ),
      monitorDelta: z
        .boolean()
        .optional()
        .describe(
          'MONITOR loops only (loop:arm { mode:"monitor" }): did this wake observe a real DELTA in the watched ' +
            'predicate? true RESETS the consecutive no-delta budget; omitted or false counts as a QUIET wake and ' +
            'decrements it, so a monitor whose budget runs out is stood down by the engine even if you never call ' +
            'loop:end. Ignored on a work loop.',
        ),
      ownerId: z
        .string()
        .max(120)
        .optional()
        .describe('The loop owner id (default: your own resolved identity). Mirrors loop:arm/end/status.'),
      harness: z
        .string()
        .max(120)
        .optional()
        .describe(
          'Harness the loop is scoped under (default: your session harness / home pot). Honoured on a READ — the way to reach a note stranded in another scope. On a WRITE an armed loop routine outranks it, so the note lands where the next cold wake reads; the reply then reports `explicitHarnessIgnored`.',
        ),
    })
    .refine(
      (a) => {
        // EI-21719647580242620: the carry-content fields are `.nullish()`, and for them an
        // explicit null means OMITTED. A bare `!== undefined` would therefore count
        // `{ left: null }` as a write, admit it, and compose a note out of nothing — a
        // carry-note CLEAR wearing a write's costume, the exact silent-loss this guard
        // exists to refuse. `note` and `checkpoint` are deliberately NOT in this set: for
        // those two a null is the DOCUMENTED explicit clear, so it must still count.
        const set = (v: unknown) => v !== undefined && v !== null;
        return (
          a.read === true ||
          a.note !== undefined ||
          a.checkpoint !== undefined ||
          set(a.did) ||
          set(a.left) ||
          set(a.insight) ||
          set(a.next) ||
          set(a.keyInsight) ||
          set(a.nextAction) ||
          set(a.goal) ||
          a.walls !== undefined ||
          a.checks !== undefined
        );
      },
      {
        // P-004: `monitorDelta` is deliberately NOT a write on its own. It RIDES a
        // checkpoint (D-002 §3 — "a delta checkpoint … resets the budget"), and the
        // monitor wake contract already requires one, so admitting it alone would only
        // create a call whose note-composition inputs are all absent — i.e. a carry-note
        // CLEAR wearing a budget-reset costume.
        message:
          'pass { did, left, insight, next } (any; goal aliases next), { note } (or compatibility alias { checkpoint }), { walls }, or { checks } — nothing to write (monitorDelta rides a checkpoint; it is not a write by itself)',
      },
    ),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    // Keep the documented `self` selector aligned with loop:arm/end/status. A
    // literal ownerId of "self" would otherwise create/read a shadow carry-note
    // that the caller's loop never consumes (EI-23090548123254420).
    const ownerId = resolveSelfLiteral(args.ownerId, identity.ownerId) ?? identity.ownerId;
    // WI-2148: the carry-note scope key MUST match what the cold-wake READER resolves —
    // and the reader gets `harness` from the ColdLoopMarker the FIRE stamped on the wake
    // payload, which is the ARMED ROUTINE's fixed `install_slug` (loop.ts's getLoopStatus),
    // NOT the checkpointing session's own ctx.harnessSlug. Those two can legitimately
    // differ wake-to-wake for the SAME loop (observed live: wakes 1-3 wrote
    // 'loop:*:<owner>', wake-4 wrote 'loop:papercusp:<owner>' because ctx.harnessSlug
    // resolved differently across wakes) — writing under the session's transient harness
    // instead of the routine's fixed one creates a SECOND, stale-diverging carry_notes row;
    // a cold reset that resolves the note by the routine's install_slug then reads whichever
    // row is stale. The ACTIVE routine is authoritative whenever it exists: an explicit
    // project-scoped harness can be a transient caller scope and must not create a
    // successfully verified note that the cold reader cannot see. An ended routine is not
    // evidence for a new checkpoint's scope, so explicit harness / durable session brief /
    // session-context/home are fallbacks when no active routine exists (e.g. a checkpoint
    // written before the first loop:arm).
    // EI-7734: the no-active-routine fallback is routed through resolvePotHomeSlug
    // (not a raw `??` chain) so its '*'-skip logic runs — every superuser/operator
    // session sets ctx.harnessSlug='*' (the wildcard sentinel), which would otherwise
    // win this chain outright and scope the carry-note under the literal '*' namespace.
    const requestedHarness = args.harness?.trim();
    const explicitHarness =
      requestedHarness && requestedHarness !== '*' && requestedHarness.toLowerCase() !== 'all'
        ? resolvePotHomeSlug(requestedHarness, undefined)
        : null;
    const hasConcreteContextHarness = (value?: string | null): boolean => {
      const trimmed = value?.trim().toLowerCase();
      return Boolean(trimmed && trimmed !== '*' && trimmed !== 'all');
    };
    const contextHarness = hasConcreteContextHarness(ctx.harnessSlug)
      ? resolvePotHomeSlug(undefined, ctx.harnessSlug)
      : null;

    // An ACTIVE routine is the cold reader's authority: loop-fire stamps its fixed
    // install_slug into the wake marker, so a checkpoint for that loop must use the
    // same scope even when a stale session brief points elsewhere. An inactive
    // routine is NOT a fallback: it may be an ended loop left behind by a previous
    // session or harness, and using its install_slug can strand a delayed
    // reconciliation checkpoint in the wrong carry-note store. Preserve
    // EI-211835's wildcard transport behavior by consulting the durable session
    // scope before the normal session-context/home fallback.
    // EI-22166372050218668: WI-2148's fail-open contract (below) is deliberate and stays
    // untouched — a checkpoint write must never block on a getLoopStatus hiccup. But
    // fail-open was previously SILENT: a caller whose probe failed got byte-identical
    // `ok:true` whether or not the resolved scope actually matched the armed routine, so
    // a session whose loop lived under a DIFFERENT harness than its current ctx.harnessSlug
    // (observed live: loop armed under 'sb-devboard-hive', session context drifted to
    // 'papercusp') could silently checkpoint into the wrong store for the rest of its life
    // with zero signal on either side — the writer saw `ok:true`, the cold reader saw a
    // well-formed but frozen note. Track whether the probe itself failed (vs. genuinely
    // resolved "no active routine") so the response below can say so out loud.
    let routineProbeFailed = false;
    const armedRoutine = await getLoopStatus(ownerId).catch((e) => {
      routineProbeFailed = true;
      console.warn(
        '[loop:checkpoint] getLoopStatus probe failed while resolving carry-note scope (fail-open, WI-2148):',
        e as Error,
      );
      return null;
    });
    const activeRoutine = armedRoutine?.active === true;
    const activeRoutineHarness = activeRoutine ? armedRoutine.harnessSlug : null;
    // Only meaningful when the probe failure could actually have changed the outcome: a
    // request that already named an explicit harness (a read, or read-only diagnostics)
    // is not silently misrouted by this — the caller's own argument still resolves it.
    const routineProbeFailureIsSilent = routineProbeFailed && !explicitHarness;
    // An active routine already carries the cold reader's authoritative install scope, so
    // do not spend a second database read on the durable session brief. When no routine,
    // explicit harness, or concrete session context is available, the brief is only a
    // best-effort fallback: keep its raw PG read inside the same bounded budget as the
    // continuation reads so a degraded operator cannot hold loop:checkpoint until the
    // transport's 120-second connection timeout (EI-21371395040636011).
    const sessionBriefRead =
      !activeRoutine && !explicitHarness && !contextHarness
        ? await withBoundedTimeout(() => getSessionBrief({ ownerId }), {
            fallback: null,
            timeoutMs: CONTINUATION_READ_BUDGET_MS,
            label: 'loop:checkpoint session-scope read',
          })
        : null;
    const sessionBrief = sessionBriefRead?.value ?? null;
    const briefHarness = hasConcreteContextHarness(sessionBrief?.harnessSlug)
      ? resolvePotHomeSlug(sessionBrief!.harnessSlug, undefined)
      : null;
    // WI-1826126: on a READ the explicit `harness` argument WINS; on a write it does
    // not, and that asymmetry is the whole point.
    //
    // A WRITE must land where the cold reader will look, so the armed routine keeps
    // precedence: honouring an explicit override there would put the note in a store
    // the next wake never reads — the exact stranding the rules above prevent.
    //
    // A READ cannot strand anything. It is also the ONLY way to reach a note that is
    // already stranded, which is why the previous ordering made such a note
    // unrecoverable through this tool at all: an agent that correctly diagnosed the
    // split and passed the right harness got the OTHER scope's note back, with the
    // resolved harness echoed as if the argument had been honoured. Recovering the
    // real note took raw SQL against harness_shared.carry_notes.
    const isReadRequest = args.read === true;
    // Recorded so a write can SAY it discarded the argument instead of silently
    // echoing a harness the caller did not ask for.
    const explicitHarnessOverriddenByRoutine =
      !isReadRequest && Boolean(explicitHarness) && Boolean(activeRoutineHarness) && explicitHarness !== activeRoutineHarness;
    let harness =
      (isReadRequest ? (explicitHarness ?? activeRoutineHarness) : (activeRoutineHarness ?? explicitHarness)) ??
      briefHarness ??
      contextHarness ??
      resolvePotHomeSlug(undefined, ctx.harnessSlug);
    // EI-21510951589801937: every signal above is a property of the LIVE session, so a
    // session that has just run loop:end (no active routine) while carrying only the '*'
    // wildcard sentinel and no home hive resolves NOTHING — and an ordinary carry-note
    // refresh fails, even though this owner's note sits in exactly one store that
    // coord:orient recovery had just reported back to them. Fall back to where the
    // owner's notes ALREADY live: the one scope signal that outlives the loop ending.
    //
    // Placed LAST deliberately. It can only turn a hard `no_harness` failure into a
    // write; it can never redirect a scope some stronger signal already resolved, so it
    // cannot reintroduce the wrong-store stranding the rules above exist to prevent.
    let inferredScopeFrom: 'carry-note' | null = null;
    let ambiguousCandidates: string[] = [];
    if (!harness) {
      const candidates =
        (
          await withBoundedTimeout(() => listLoopCarryNoteHarnesses(ownerId), {
            fallback: [] as string[],
            timeoutMs: CONTINUATION_READ_BUDGET_MS,
            label: 'loop:checkpoint carry-note scope inference',
          })
        ).value ?? [];
      // Exactly one, or nothing. Two candidate stores are a coin flip over which cold
      // wake reads the note back, and a note written into the wrong one is strictly
      // worse than a refusal the caller can fix with a single argument.
      if (candidates.length === 1) {
        harness = candidates[0];
        inferredScopeFrom = 'carry-note';
      } else if (candidates.length > 1) {
        ambiguousCandidates = candidates;
      }
    }
    if (!harness) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              error: 'no_harness',
              // The ambiguous case must NOT reuse the plain refusal's message: the
              // caller's remedy differs ("pick one of these" vs "you have no scope at
              // all"), and a shared reason string would make a test of this branch pass
              // with the branch deleted.
              ...(ambiguousCandidates.length > 1
                ? {
                    candidates: ambiguousCandidates,
                    message:
                      `Pass \`harness\` — your session is not scoped to a harness, and you hold loop ` +
                      `carry-notes under ${ambiguousCandidates.length} harnesses ` +
                      `(${ambiguousCandidates.join(', ')}), so which one this note belongs to cannot be ` +
                      `inferred. Pass the one you mean.`,
                  }
                : {
                    message:
                      'Pass `harness` — your session is not scoped to a harness and no home hive is set, so the loop carry-note has nowhere to live.',
                  }),
            }),
          },
        ],
        isError: true,
      };
    }

    const workspaceId = ctx.workspaceId ?? ctx.principal?.workspaceId ?? undefined;
    if (args.read === true) {
      const current = await getLoopCarryNoteWithMeta({ harness, ownerId, workspaceId });
      // A null note is meaningful only after the carry-note reader successfully
      // answered. The canonical reader returns `readFailed:true` when the store
      // could not be queried; collapsing that sentinel into the normal empty-note
      // envelope (`ok:true`, `note:null`, `length:0`) makes a transient data-plane
      // failure indistinguishable from a confirmed clear and invites a successor
      // to overwrite continuity that may still exist. Keep this read fail-closed
      // and explicit, while preserving the write path's existing fail-open policy.
      if (current.readFailed === true) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: false,
                read: true,
                error: 'carry_note_read_failed',
                message:
                  'The carry-note store could not be read, so note:null is NOT a confirmed empty note. Retry the read after the data plane recovers; no carry-note content was changed.',
                harness,
                ownerId,
                readFailed: true,
              }),
            },
          ],
          isError: true,
        };
      }
      const note = current.note;
      // WI-1826126: resolving a scope successfully is NOT evidence that it holds this
      // owner's newest note. carry_notes is keyed `loop:<harness>:<ownerId>`, so one
      // owner can hold several divergent notes — measured on this box, 155 of 2,930
      // note-holding owners hold them under up to 4 harnesses. Before this check the
      // only consumer of that fact was the `no_harness` fallback below, which runs
      // exclusively when resolution FAILS; a resolution that succeeded onto the older
      // scope compared against nothing. Measured cost: a cold wake read a 13:19Z note
      // while a 15:57Z note sat one scope over, skipping 2h38m of continuity and very
      // nearly repeating settled work.
      //
      // REPORT, NEVER SWITCH — the same rule the harness list itself follows. Silently
      // preferring the newest row would resume a cold wake from another hive's note,
      // which is the stranding the resolution rules above exist to prevent. So this
      // states the discrepancy and hands over the call that reaches the other note.
      const otherScopes =
        (
          await withBoundedTimeout(() => listLoopCarryNoteScopes(ownerId), {
            fallback: [] as { harness: string; updatedAtMs: number | null }[],
            timeoutMs: CONTINUATION_READ_BUDGET_MS,
            label: 'loop:checkpoint cross-harness staleness check',
          })
        ).value ?? [];
      // A null updatedAtMs here means THIS scope holds no note at all, so any other
      // scope holding one is strictly more informative than the empty result we are
      // about to return — that case must report too, not just the older-note case.
      const newerElsewhere = otherScopes
        .filter(
          (row) =>
            row.harness !== harness &&
            row.updatedAtMs != null &&
            (current.updatedAtMs == null || row.updatedAtMs > current.updatedAtMs),
        )
        .map((row) => ({ harness: row.harness, updatedAtMs: row.updatedAtMs }));
      // EI-19470389781357111: the DECLARED-dependency verdict. `updatedAtMs` above is
      // the only staleness signal this read had, and age is a proxy for the question
      // that actually matters — has anything the note depends on CHANGED? — which it
      // answers wrongly in both directions: it calls an untouched 3h-old note stale,
      // and it cannot see a peer's edit at all. That blind spot is worst precisely
      // here, because a cold wake's carry-note is its ONLY continuity surface.
      //
      // Fail-soft to undefined: a freshness read that errors must be indistinguishable
      // from "nothing declared" at the call site (both fall back to the age heuristic),
      // and must never cost the caller the note itself.
      const freshness = note
        ? await getLoopCarryNoteFreshness({ harness, ownerId, workspaceId }, workspaceId).catch(() => undefined)
        : undefined;
      // EI-22415684247504410: the published read contract promises the carried
      // walls/checks, not just note metadata. Parse rows from the exact stored note
      // before returning so callers can enumerate the full set before choosing a
      // destructive rowsMode:'replace' write.
      const { walls } = splitCarryNoteWalls(note);
      const { checks } = splitCarryNoteChecks(note);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              read: true,
              harness,
              ...(newerElsewhere.length > 0
                ? {
                    newerNoteElsewhere: newerElsewhere,
                    staleScopeWarning:
                      `⚠ This is NOT your newest carry-note. You hold a MORE RECENTLY WRITTEN loop ` +
                      `carry-note under ${newerElsewhere.length === 1 ? 'another harness' : `${newerElsewhere.length} other harnesses`}: ` +
                      `${newerElsewhere.map((row) => `${row.harness} (${row.updatedAtMs == null ? 'unknown' : new Date(row.updatedAtMs).toISOString()})`).join(', ')}. ` +
                      `${current.updatedAtMs == null ? 'This scope holds no note at all.' : `The note returned here was written ${new Date(current.updatedAtMs).toISOString()}.`} ` +
                      `Read the newer one with loop:checkpoint { read:true, harness:'${newerElsewhere[0].harness}' } — on a READ the explicit harness argument is honoured. ` +
                      `Nothing is switched for you: a write still lands in the scope the armed routine resolves, so re-address it deliberately.`,
                  }
                : {}),
              // Say so when the scope was INFERRED rather than resolved from the
              // session: a silently inferred store is exactly what makes a
              // wrong-scope note expensive to diagnose later.
              ...(inferredScopeFrom ? { scopeInferredFrom: inferredScopeFrom } : {}),
              // EI-22166372050218668: this read could not confirm the armed routine's
              // real scope either (getLoopStatus failed and no explicit `harness` argument
              // was given to fall back on), so `harness` above came from session/context
              // fallback rather than a verified routine match — say so rather than let a
              // clean-looking `ok:true` read imply the scope was confirmed.
              ...(routineProbeFailureIsSilent
                ? {
                    routineProbeFailed: {
                      resolvedTo: harness,
                      why: 'The armed-loop scope probe (getLoopStatus) failed, so this harness could not be confirmed against the actually-armed routine and was resolved from session/context fallback instead. If a cold wake reads a stale-looking note, re-check with loop:status and pass an explicit `harness` here to be sure.',
                    },
                  }
                : {}),
              ownerId,
              note,
              contentHash: note === null ? null : shortCarryHash(note),
              updatedAtMs: current.updatedAtMs,
              length: note?.length ?? 0,
              walls,
              checks,
              // Present only when the note DECLARED dependencies. Absent ⇒ undeclared
              // ⇒ `updatedAtMs` is all you have, so judge the note by its age and know
              // that a peer's edit is invisible to that judgement.
              ...(freshness ? { freshness } : {}),
            }),
          },
        ],
      };
    }

    // P-005 / D-030 (7): a fleet-leader monitor cannot record a quiet wake (no
    // monitorDelta) while the fleet it leads has zero productive workers. Bounded and
    // fail-OPEN: an unmeasured fleet is allowed with a warning, never refused on a guess.
    let fleetZeroWorkersWarning: string | undefined;
    if (workspaceId && args.monitorDelta !== true) {
      const guard = await withBoundedTimeout(
        async () =>
          (await import('../../fleet/fleet-zero-workers-guard')).checkFleetZeroWorkers({
            workspaceId,
            ownerId,
            monitorDelta: false,
          }),
        {
          fallback: { action: 'allow' } as FleetZeroWorkersVerdict,
          timeoutMs: 3_000,
          label: 'loop:checkpoint fleet_zero_workers',
        },
      );
      // `value` can be absent only under a test double of withBoundedTimeout; the real
      // helper returns the work's verdict or the fallback. Absent is read as allow, the
      // same way the other bounded reads in this handler treat a missing value.
      const verdict: FleetZeroWorkersVerdict | undefined = guard.value;
      if (guard.degraded) {
        fleetZeroWorkersWarning = `fleet_zero_workers not checked (${guard.reason ?? 'error'}); the checkpoint was allowed.`;
      } else if (verdict?.action === 'refuse') {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: false,
                error: 'fleet_zero_workers',
                message: verdict.message,
                fleet: verdict.fleetSlug,
                repairs: verdict.repairs,
                harness,
                ownerId,
              }),
            },
          ],
          isError: true,
        };
      } else {
        fleetZeroWorkersWarning = verdict?.warning;
      }
    }

    // EI-18833865002636933 — rescue-by-parse of a MALFORMED structured write. Seen live:
    // an agent serialized its whole note as one XML-tagged string into `did`, so the cold
    // wake got a single `## Did` section with literal `</did><left>…<checks>[…]` text in
    // it — typed checks rows demoted to inert JSON prose, ✓/? badges gone, and NOTHING
    // saying it had happened. Same philosophy as the `checks` z.preprocess above: the
    // caller sent the right CONTENT in the wrong SHAPE, so parse it rather than refuse
    // (refusing would have made this the FOURTH consecutive failed checkpoint that turn,
    // leaving the cold wake with no note at all).
    //
    // Gated on siblings being ABSENT: a well-formed call that merely QUOTES `</did>` in
    // its prose has left/insight/next set, so it is never touched. rescueTaggedCarryNote-
    // Blob applies the second half of the guard (the full close-tag signature).
    // EI-21949862791784103: fold an object-shaped `checkpoint` alias into the canonical
    // carry fields BEFORE anything reads them, so every downstream path (blob rescue,
    // render, truncation, provenance lint, clear) sees exactly one shape. Explicit
    // top-level fields win over the alias, matching how `note` wins over `checkpoint`.
    const checkpointObject =
      args.checkpoint !== null && typeof args.checkpoint === 'object' ? args.checkpoint : undefined;
    // Narrow directly off the value: `checkpointObject ? … : args.checkpoint` leaves the
    // object in the inferred type, because TS cannot correlate the two expressions.
    const checkpointNote =
      typeof args.checkpoint === 'string' || args.checkpoint === null ? args.checkpoint : undefined;
    // EI-21719647580242620: ALWAYS build the normalized shape — never pass `args` through
    // raw. These fields are `.nullish()`, so a caller sharing a loop:arm payload may send an
    // explicit `null`, and every reader below means OMITTED by that: the rescue guard's
    // `=== undefined` tests, the render, the truncation loop. The old `: args` shortcut
    // leaked a raw null into the render for `did` and `left` — the only two fields with no
    // downstream alias `??` to launder it — so `{ did:'x', left:null }` rendered
    // `"left":null`, and a null `left` ALSO silently disabled the tagged-blob rescue by
    // failing its `carry.left === undefined` precondition. `??` collapses null and undefined
    // to the same absent value for all seven, which is the whole contract.
    const carry = {
      did: args.did ?? checkpointObject?.did,
      left: args.left ?? checkpointObject?.left,
      insight: args.insight ?? checkpointObject?.insight,
      next: args.next ?? checkpointObject?.next,
      keyInsight: args.keyInsight ?? checkpointObject?.keyInsight,
      nextAction: args.nextAction ?? checkpointObject?.nextAction,
      goal: args.goal ?? checkpointObject?.goal,
    };
    const rescued =
      carry.did !== undefined &&
      carry.left === undefined &&
      carry.insight === undefined &&
      carry.next === undefined &&
      carry.keyInsight === undefined &&
      carry.nextAction === undefined
        ? rescueTaggedCarryNoteBlob(carry.did)
        : null;
    const fields = rescued
      ? { did: rescued.did, left: rescued.left, insight: rescued.insight, next: rescued.next }
      : {
          did: carry.did,
          left: carry.left,
          insight: carry.insight ?? carry.keyInsight,
          next: carry.next ?? carry.nextAction ?? carry.goal,
        };

    // WI-7264: enforce the SOFT caps by truncation, here, after the schema's backstop
    // let the call through. The cap's job is to bound what re-injects into every future
    // wake — truncation does that just as well as rejection did, without discarding the
    // whole note (and the agent's next wake with it). Every trim is REPORTED: a cut that
    // the caller cannot see is the EI-18723223344390510 failure mode, where a row was
    // quietly reshaped and a verified check's evidence was destroyed with no signal.
    const repairs: CarryArgRepair[] = [];
    for (const key of ['did', 'left', 'insight', 'next'] as const) {
      const v = fields[key];
      if (typeof v === 'string') fields[key] = truncateCarryField(v, CARRY_TEXT_SOFT_CAP, key, repairs);
    }
    const capRows = <
      T extends {
        id?: string;
        claim: string;
        recheck?: string;
        falsifier?: string;
        verified?: string;
        observed?: string;
        contested?: string;
      },
    >(
      rows: T[] | undefined,
      label: string,
    ): T[] | undefined =>
      rows?.map((row, i) => {
        const out = { ...(coerceCarryRowShape(row, `${label}[${i}]`, repairs) as T) };
        if (typeof out.id === 'string') {
          const originalId = out.id;
          const normalizedId = sanitizeCarryRowId(originalId);
          if (normalizedId !== originalId) {
            const overStoredLimit = originalId.length > CARRY_ROW_ID_MAX;
            repairs.push({
              field: `${label}[${i}].id`,
              kind: overStoredLimit ? 'truncated' : 'renamed',
              detail: overStoredLimit
                ? `${originalId.length} chars normalized to ${normalizedId?.length ?? 0} chars (stored ids max ${CARRY_ROW_ID_MAX}) — write it shorter to preserve the full identity`
                : `id normalized to ${normalizedId ?? 'no stable id'} — use only letters, numbers, ., _, :, and - to keep the merge identity stable`,
            });
          }
          if (normalizedId) out.id = normalizedId;
          else delete out.id;
        }
        out.claim = truncateCarryField(out.claim, CARRY_ROW_SOFT_CAPS.claim, `${label}[${i}].claim`, repairs);
        if (typeof out.recheck === 'string')
          out.recheck = truncateCarryField(out.recheck, CARRY_ROW_SOFT_CAPS.recheck, `${label}[${i}].recheck`, repairs);
        if (typeof out.falsifier === 'string')
          out.falsifier = truncateCarryField(
            out.falsifier,
            CARRY_ROW_SOFT_CAPS.falsifier,
            `${label}[${i}].falsifier`,
            repairs,
          );
        // A ✓ is an affirmative claim. If its evidence contradicts that claim,
        // preserve the exact evidence but store it as contested so neither the
        // carry note nor a wake can present it as settled. Do this BEFORE capping
        // the evidence: a conflict marker near the tail must not be truncated away
        // and accidentally restore a false ✓.
        if (typeof out.verified === 'string') {
          const conflict = findVerificationConflict(out.verified, out.claim);
          if (conflict) {
            out.contested = out.verified;
            delete out.verified;
            repairs.push({
              field: `${label}[${i}].verified`,
              kind: 'downgraded',
              detail: `verification evidence contains contradiction marker "${conflict}" — stored as contested evidence; re-check before relying on this claim`,
            });
          }
        }
        if (typeof out.verified === 'string')
          out.verified = truncateCarryField(
            out.verified,
            CARRY_ROW_SOFT_CAPS.verified,
            `${label}[${i}].verified`,
            repairs,
          );
        if (typeof out.observed === 'string')
          out.observed = truncateCarryField(
            out.observed,
            CARRY_ROW_SOFT_CAPS.observed,
            `${label}[${i}].observed`,
            repairs,
          );
        if (typeof out.contested === 'string')
          out.contested = truncateCarryField(
            out.contested,
            CARRY_ROW_SOFT_CAPS.contested,
            `${label}[${i}].contested`,
            repairs,
          );
        return out;
      });
    const hasStructured =
      fields.did !== undefined ||
      fields.left !== undefined ||
      fields.insight !== undefined ||
      fields.next !== undefined;
    // Structured fields win over a raw note (renderCarryNote skips blank sections, so an
    // all-blank structured write renders '' ⇒ a clear). Otherwise write the raw note
    // verbatim. `checkpoint` is the historical generic carry-note spelling used by
    // work_items:checkpoint callers; normalize it at the boundary so every downstream
    // path (row merge, provenance lint, verify-read, and clear) keeps canonical loop
    // semantics. An explicitly supplied `note` wins even when it is null.
    const rawNote = args.note !== undefined ? args.note : checkpointNote;
    const baseNote = hasStructured ? renderCarryNote(fields) : rawNote;

    // P-006 walls merge — commitments are cleared EXPLICITLY, never incidentally:
    //   explicit `walls` wins (its [] is the only true clear); a raw note's own
    //   `## Walls` rows win next; otherwise the PRIOR walls carry forward — across
    //   rewrites AND across a note clear (the note then survives as walls-only).
    //   A walls-only write likewise carries the prior note body forward.
    // A rescued blob's own rows slot in where the explicit arg would have gone — an
    // EXPLICIT `walls`/`checks` arg still wins outright (including its `[]` clear).
    const effectiveWalls = capRows(args.walls ?? rescued?.walls, 'walls');
    const effectiveChecks = capRows(args.checks ?? rescued?.checks, 'checks');
    const hasNoteWrite = hasStructured || rawNote !== undefined;
    // P-014: lint only what this call supplied as current provenance. Rows and
    // narrative inherited by mergeCarryRows remain in the stored note, but are
    // reported separately as retainedProvenance rather than as fresh activity.
    // EI-19425644478222007: resolve `[turn:self]` / `[turn:current]` into this write's
    // REAL anchor before anything reads the text. Order is load-bearing: expanding
    // BEFORE stampCarrySurfaceProvenance means the lint sees a verifiable ref (rather
    // than flagging the sentinel as an unanchored action claim) and verifyTurnRefs
    // resolves it against the transcript, so the note is STORED with an anchor that
    // actually resolves. Gated on a cheap substring test — a write carrying no sentinel
    // pays no extra transcript read. Fail-soft: an unresolvable current turn leaves the
    // sentinel verbatim, which the lint still flags (an honest miss, never a fake ref).
    const sentinelTurn = hasCurrentTurnSentinel(baseNote)
      ? await resolveCurrentTurnStamp(ownerId).catch(() => null)
      : null;
    const anchoredBaseNote = expandCurrentTurnSentinel(baseNote, sentinelTurn);
    let currentProvenanceText = (() => {
      let text = anchoredBaseNote ?? '';
      if (effectiveChecks !== undefined) {
        text = withCarryNoteChecks(splitCarryNoteChecks(text).body, effectiveChecks);
      }
      if (effectiveWalls !== undefined) {
        text = withCarryNoteWalls(splitCarryNoteWalls(text).body, effectiveWalls);
      }
      return text;
    })();
    // P-016 / EI-212678: persist owner-attribution caveats in the carry note so
    // a later cold wake cannot mistake the response-only lint for authority.
    const preWriteStamp = await stampCarrySurfaceProvenance(currentProvenanceText, ownerId);
    const ownerEnforcement = ownerAttributionEnforcement(currentProvenanceText, preWriteStamp);
    const enforcedBaseNote = ownerEnforcement.unverified
      ? markUnverifiedOwnerAttribution(anchoredBaseNote)
      : anchoredBaseNote;
    if (ownerEnforcement.unverified) {
      currentProvenanceText = markUnverifiedOwnerAttribution(currentProvenanceText) ?? currentProvenanceText;
    }
    // Refuse the caller-authored portion before touching the carry-note store.
    // The locked transform rechecks these same supplied bytes after composing
    // the final note, but deliberately does not reinterpret inherited history
    // as a new instruction.
    const directFrozenCarryViolation = frozenLoopCarryViolation(currentProvenanceText);
    if (directFrozenCarryViolation) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ ...directFrozenCarryViolation, harness, ownerId }),
          },
        ],
        isError: true,
      };
    }
    // P-013: replace stays the DEFAULT — it is the only way to retire a stale row, and
    // silently switching every existing caller to merge would make a clear impossible.
    const rowsMode = args.rowsMode ?? 'merge';

    // WI-6813: the walls/checks merge runs INSIDE the row's locked transaction (the
    // `transform` seam), not out here. The caller-side read → merge → write it
    // replaces had a real race — a concurrent writer on this scope landing between
    // the prior read and the write was silently clobbered, which for WALLS means
    // dropping an owner-gated commitment.
    //
    // The transform's own output is CAPTURED (via a holder object, so the assignment
    // survives control-flow narrowing) rather than re-merged out here: the advisory
    // lint and the reported counts then describe EXACTLY what was stored, instead of
    // a second merge against a staler prior that could disagree with it.
    const captured: {
      merged?: ReturnType<typeof mergeCarryRows>;
      mergeRefused?: { droppedWalls: string[]; droppedChecks: string[] };
    } = {};
    // A legacy note may already carry more checks than today's cap. The
    // transform records that fact from its authoritative locked prior so the
    // response can explain why the normalization was allowed, rather than
    // blaming the current caller for a pre-existing condition.
    const legacyOverCapNormalization = { checks: 0 };
    let stored: string | null;
    try {
      const writeResult = await withPgContentionRetry(
        () =>
          setLoopCarryNoteWithPrior(
            { harness, ownerId, workspaceId: workspaceId ?? undefined },
            enforcedBaseNote,
            {
          ...(args.expectedHash !== undefined ? { expectedHash: args.expectedHash } : {}),
          // EI-19470389781357111: tri-state, so the key is present ONLY when the
          // caller actually passed it — omitting it preserves the prior declaration
          // rather than clearing it, which is what keeps a plain narrative re-write
          // from silently discarding the note's only non-guessed freshness signal.
          ...(args.dependsOn !== undefined
            ? { dependsOn: args.dependsOn, depsResolveWorkspaceId: workspaceId }
            : {}),
          transform: (priorNote) => {
            const priorNarrative = parseCarryNote(priorNote ?? '');
            const hasOmittedPriorNarrativeField = (['did', 'left', 'insight', 'next'] as const).some(
              (key) => priorNarrative[key] !== undefined && fields[key] === undefined,
            );
            const merged = mergeCarryRows({
              priorNote,
              baseNote: enforcedBaseNote,
              walls: effectiveWalls,
              checks: effectiveChecks,
              hasNoteWrite,
              narrativeFields: hasStructured && hasOmittedPriorNarrativeField ? fields : undefined,
              mode: rowsMode,
              retire: args.retireIds,
            });
            captured.merged = merged;
            const legacyChecksOverCap = priorChecksOverCapCount(priorNote);
            // EI-21503907176334936: under replace, retirement must be CONFIRMED, not
            // merely reported afterwards. A monitor loop that re-sends its whole note
            // each wake from a stale view was silently retiring carried walls/checks
            // behind an ok:true. Refuse here — inside the locked txn, so nothing is
            // written — unless the caller asked for the retirement explicitly.
            if (
              rowsMode === 'replace' &&
              args.confirmRetire !== true &&
              (merged.droppedWalls.length > 0 || merged.droppedChecks.length > 0)
            ) {
              throw new ReplaceWouldDropError(merged.droppedWalls, merged.droppedChecks);
            }
            if (rowsMode === 'merge' && (merged.droppedWalls.length > 0 || merged.droppedChecks.length > 0)) {
              // EI-21579012309480346: a pre-existing over-cap check set cannot
              // be repaired by the caller's advertised "re-send the full set"
              // remedy — the current schema rejects that set before it reaches
              // this transform. Let mergeCarryRows normalize that legacy state
              // once, retaining supplied rows first and evidence-bearing carried
              // rows before predicted ones. Keep the ordinary within-cap refusal
              // (and all wall refusals) intact so a caller cannot use this escape
              // to silently evict a healthy carried set.
              const normalizingLegacyChecks = legacyChecksOverCap > 0 && merged.droppedChecks.length > 0;
              if (normalizingLegacyChecks) legacyOverCapNormalization.checks = legacyChecksOverCap;
              // EI-21849813048365808: a caller doing a routine merge refresh near the cap
              // (e.g. a monitor loop re-stating its no-delta checks each wake) hit this
              // refusal on every single write once the carried set filled up, and the
              // only advertised fix was a two-step dance — a plain rowsMode:'replace'
              // resend of the FULL current set to retire rows, then retry the merge.
              // Give confirmRetire:true the SAME meaning it already has under
              // rowsMode:'replace': an explicit, one-call opt-in to let the row cap's
              // own PREDICTED-before-VERIFIED yielding (computed above by
              // mergeCarryRows/upsertOntoPrior) actually commit instead of refusing.
              // The DEFAULT (confirmRetire omitted/false) is completely unchanged: a
              // merge overflow still refuses and names every row it would have
              // evicted, so an ordinary additive write is exactly as safe as before.
              if (args.confirmRetire !== true && (merged.droppedWalls.length > 0 || !normalizingLegacyChecks)) {
                // EI-22377179869127416: the ROW CAP and the NARRATIVE are two separate
                // commitments, and only the rows are in conflict here. Refusing the whole
                // write took the did/left/insight/next prose down with it — the note this
                // file elsewhere calls "the cold successor's only durable anchor" — so an
                // ordinary additive checkpoint at a full cap left that successor waking on
                // a STALE note. Losing the narrative is strictly worse than not adding a
                // row: the caller still HOLDS the rows it just tried to write and can retry
                // them, while the narrative is exactly what a dying session cannot re-send.
                //
                // So persist the narrative with the carried rows UNTOUCHED, and still refuse
                // the ROW write loudly below (same error code, same retryable contract, same
                // named rows) — nothing about the row conflict becomes silent, and the two
                // prior escapes (confirmRetire here, or a confirmed replace) are unchanged.
                captured.mergeRefused = {
                  droppedWalls: merged.droppedWalls,
                  droppedChecks: merged.droppedChecks,
                };
                // Reverse the composition order mergeCarryRows uses on the way out
                // (withCarryNoteWalls(withCarryNoteChecks(body, checks), walls)) so the
                // carried rows are recovered exactly as stored. Deliberately NOT re-derived
                // from `enforcedBaseNote`: that string already carries this write's supplied
                // rows, so re-merging it would re-trigger the very overflow being refused.
                const priorWallParts = splitCarryNoteWalls(priorNote ?? '');
                const priorCheckParts = splitCarryNoteChecks(priorWallParts.body);
                return enforceFrozenLoopCarry(
                  withCarryNoteWalls(
                    withCarryNoteChecks(merged.narrativeBody, priorCheckParts.checks),
                    priorWallParts.walls,
                  ),
                  currentProvenanceText,
                );
              }
            }
            return enforceFrozenLoopCarry(merged.note, currentProvenanceText);
              },
            },
          ),
        { backoffsMs: LOOP_CHECKPOINT_CONTENTION_BACKOFFS_MS },
      );
      ({ stored } = writeResult);
      if (writeResult.conflict) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: false,
                error: 'checkpoint_conflict',
                retryable: false,
                harness,
                ownerId,
                expectedHash: writeResult.conflict.expectedHash,
                currentHash: writeResult.conflict.currentHash,
                message:
                  'The carry-note changed after the supplied contentHash was read; no note was written. ' +
                  'Re-read the current carry-note and retry with its contentHash, or reconcile before writing.',
              }),
            },
          ],
          isError: true,
        };
      }
      // The store can accept an older writer before a newer checkpoint commits,
      // then reject that writer after it waits on the row lock. `stored` echoes
      // the newer note in this case, so proceeding to verify-read would make the
      // discarded write look successful. Surface the rejection before any
      // post-write reads and make the current hash available for a retry.
      if (writeResult.staleWrite) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: false,
                error: 'checkpoint_stale_write',
                retryable: true,
                harness,
                ownerId,
                blockedReason: writeResult.blockedReason ?? 'stale_write_older_than_current',
                staleWrite: writeResult.staleWrite,
                currentHash: stored === null ? null : shortCarryHash(stored),
                message:
                  'This checkpoint started before a newer carry-note committed and was discarded; no note was written. ' +
                  'Re-read the current carry-note and retry if this checkpoint is still current.',
              }),
            },
          ],
          isError: true,
        };
      }
      // EI-22377179869127416: the row write was refused but the NARRATIVE committed
      // above, so a cold successor now reads this turn's note instead of a stale one.
      // Reported only after conflict/staleWrite are ruled out — those two mean nothing
      // was written at all, and claiming narrativePersisted there would be a lie.
      if (captured.mergeRefused) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: false,
                error: 'checkpoint_merge_would_evict_rows',
                retryable: true,
                harness,
                ownerId,
                narrativePersisted: true,
                currentHash: stored === null ? null : shortCarryHash(stored),
                wallsDropped: captured.mergeRefused.droppedWalls,
                checksDropped: captured.mergeRefused.droppedChecks,
                message:
                  'YOUR NARRATIVE WAS SAVED; only the ROW write was refused. ' +
                  "rowsMode:'merge' would exceed the durable row cap and evict the carried rows named above, so the " +
                  'carried rows were left exactly as they were and your supplied rows were NOT added. The ' +
                  'did/left/insight/next note DID commit, so a cold successor reads this turn, not a stale one. ' +
                  'To land the rows too: retry with confirmRetire:true to let the cap\'s own PREDICTED-before-VERIFIED ' +
                  'eviction proceed (the rows above are exactly what would go, and carried rows yield evidence-last). ' +
                  "If you were RE-WORDING a carried row, retry with that row only plus `replaces: '<its [#id] or " +
                  "exact old claim>'` — an edit is not an addition. To make room for a genuinely new row, retry " +
                  "with `retireIds: ['<[#id] or exact claim>']` for the row(s) you no longer need. Neither needs a " +
                  'full resend.',
              }),
            },
          ],
          isError: true,
        };
      }
    } catch (error) {
      if (error instanceof FrozenCarryCheckpointError) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ ...error.payload, harness, ownerId }),
            },
          ],
          isError: true,
        };
      }
      // EI-21503907176334936: the confirmed-retirement refusal — thrown by the
      // transform BEFORE any store write, so nothing was committed. Surface the
      // exact drop set so one retry can fix it (full re-send, merge default, or
      // explicit confirmRetire:true).
      if (error instanceof ReplaceWouldDropError) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: false,
                error: 'checkpoint_replace_would_drop_rows',
                retryable: true,
                harness,
                ownerId,
                wallsDropped: error.droppedWalls,
                checksDropped: error.droppedChecks,
                message:
                  "rowsMode:'replace' would RETIRE the carried rows named above and confirmRetire was not true — " +
                  'NOTHING was written. Re-send the FULL current set under replace with confirmRetire:true, or omit ' +
                  'rowsMode entirely (merge is the default and preserves unmentioned rows up to the cap).',
              }),
            },
          ],
          isError: true,
        };
      }
      // The loop carry-note is the cold successor's only durable anchor. A
      // transient lock wait or admin-pool acquisition deadline must be visible
      // as a retryable result, not bubble into an MCP transport timeout.
      if (error instanceof OrgTxnTimeoutError || error instanceof DbCallDeadlineError) {
        const pgCode = error instanceof OrgTxnTimeoutError ? error.pgCode : undefined;
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: false,
                error: 'timeout',
                retryable: true,
                ...(pgCode ? { pgCode } : {}),
                message:
                  `loop:checkpoint carry-note write hit transient database contention: ${error.message}. ` +
                  'No carry-note was committed; retry now.',
              }),
            },
          ],
        };
      }
      throw error;
    }

    // WI-7124 (mirrors the work_items:checkpoint P-003 verify-read precedent,
    // fleet-deltas-leader-primitives-2026-07-10): prove the write is visible through
    // the SAME path a COLD-WAKE reader resolves it by — not merely that the store
    // echoed back what we asked it to write. This carry-note has a DOCUMENTED,
    // real historical failure of exactly this shape (WI-2148, see the `harness`
    // resolution above): the write-side scope key (a session's transient
    // ctx.harnessSlug) can diverge from the read-side key (the armed routine's fixed
    // install_slug), silently creating a SECOND, stale-diverging carry_notes row that
    // the next cold wake never sees — "written" from the caller's point of view, but
    // invisible to the reader that actually matters. Catch that class LOUDLY at write
    // time, before the slower advisory reads below, instead of discovering it only
    // when a cold wake resumes from a stale/absent note (WI-7124's whole complaint).
    let verifyError: string | null = null;
    let verified: true | null = null;
    let contentHash: string | null = null;
    if (stored !== null) {
      const verifyRead = await getLoopCarryNoteWithMeta({ harness, ownerId, workspaceId }).catch(() => ({
        note: null,
        updatedAtMs: null,
      }));
      if (verifyRead.note !== stored) {
        verifyError =
          `checkpoint_verify_failed — the write did not read back via the reader path a cold wake ` +
          `uses (stored ${stored.length} chars, read back ${
            verifyRead.note === null ? 'null' : `${verifyRead.note.length} chars`
          }). A cold wake of this loop would NOT see this note. Retry, or pass { harness } explicitly ` +
          `if your session's scope may differ from the armed routine's (WI-2148).`;
      } else {
        verified = true;
        contentHash = shortCarryHash(stored);
      }
    }
    if (verifyError) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ ok: false, error: verifyError, harness, ownerId }),
          },
        ],
        isError: true,
      };
    }

    // EI-22995965169175295: a cold successor treats the FINAL stored note as its
    // continuity authority, including retained history from earlier compaction
    // hops. Advise on qualified plan-decision refs there, rather than only on the
    // submitted fragment; bare D-NNN remains intentionally unknown because ids are
    // allocated per plan. This is decoration on a successful checkpoint and is
    // fail-open even if the advisory's resolver itself regresses.
    const decisionRefAdvisory =
      stored !== null
        ? (
            await withBoundedTimeout(
              () =>
                unresolvedPlanDecisionRefs(stored, {
                  workspaceId,
                  harnessSlug: harness,
                }),
              {
                fallback: undefined,
                timeoutMs: CONTINUATION_READ_BUDGET_MS,
                label: 'loop:checkpoint decision-ref advisory',
              },
            )
          ).value
        : undefined;

    // Unreachable today (this tool passes no `guard`, and only a blocked guard skips
    // the transform) — but a missing capture must never silently read as "no rows".
    const {
      walls,
      checks,
      narrativeBody,
      droppedWalls,
      droppedChecks,
      overflowWalls,
      overflowChecks,
      retiredWalls,
      retiredChecks,
      unmatchedRowRefs,
    } =
      captured.merged ??
      mergeCarryRows({
        priorNote: null,
        baseNote: enforcedBaseNote,
        walls: effectiveWalls,
        checks: effectiveChecks,
        hasNoteWrite,
        narrativeFields: hasStructured ? fields : undefined,
        mode: rowsMode,
        retire: args.retireIds,
      });

    // P-009: advisory lint — an external-state ASSERTION in the narrative prose whose
    // distinctive tokens (hash / WI-EI id / ISO instant) appear in NO check/wall row is
    // a carried claim with no probe (the phantom-re-anchor shape). Never blocks.
    const probeText = [...checks.map(renderCheckLine), ...walls.map(renderWallLine)].join('\n');
    const uncheckedClaims = hasNoteWrite ? lintUncheckedExternalClaims(narrativeBody, probeText) : [];
    // EI-23771449112267271: warn-only — a ✓ row WRITTEN IN THIS CALL with no falsifier (same contract
    // as facts:assert `recheckMissing`). Scoped to supplied rows so legacy carried rows never nag.
    const falsifierMissingRows = checksMissingFalsifier(effectiveChecks ?? []);

    // R-6(b): a relative `scratchpad/...` reference is unresolvable to the next wake —
    // the session scratchpad is absolute and per-session, so the successor re-derives an
    // artifact that is already on disk. Advisory + fail-open, like every sibling here.
    const relativeScratchRefs = hasNoteWrite
      ? await filterTrackedRelativeScratchPaths(narrativeBody, { workspaceId, harness })
      : [];

    // EI-20079511619330371: a carry-note's `left`/`next` is read as an
    // instruction at wake time, even though its singleton/shared-state
    // precondition may have changed after this write. Keep the warning
    // advisory and only clear it with a matching checks row carrying a
    // runnable recheck; a conclusion in prose (or a wall) is insufficient.
    const imperativeActions = (() => {
      if (!hasNoteWrite) return [];
      try {
        // The production renderer emits canonical headings, but the handler's
        // routing tests intentionally replace it with a sentinel. Prefer the
        // original structured fields when this write supplied them; parse the
        // merged body for raw canonical notes and carried-forward text.
        const parsed = parseCarryNote(narrativeBody);
        const source = hasStructured ? fields : parsed;
        return lintUncheckedImperativeActions(
          [source.left, source.next].filter((value): value is string => Boolean(value?.trim())).join('\n'),
          checks,
        );
      } catch {
        return []; // advisory lint must never cost the checkpoint write
      }
    })();

    // outage-must-not-be-silent-2026-08-02 P-009: the ABSENCE-claim leg of the same lint.
    //
    // The lint above keys on a distinctive TOKEN (hash / WI-EI id / ISO instant) or an
    // external-state noun. An absence claim — "nothing reads X", "there is no exported
    // helper for Y" — carries NEITHER, so it passes straight through, which is exactly how
    // the motivating incident happened.
    //
    // This reuses `detectAbsencePremises` rather than adding a second detector: it is the
    // one already measured against 31,090 real bodies (fires on ~1 claim in 22, not on
    // everything) and it already strips fenced/inline code so a PASTED error string like
    // `column "payload" does not exist` is read as evidence the author GATHERED, never as
    // their own assertion. A second opinion here would be a second bug — the D-005 lesson.
    //
    // Why this surface: the claim-time port fires on a work-item/plan-item at CLAIM. A
    // carry-note never passes a claim event, yet it is re-injected into the author's next
    // wake — and is a COLD successor's only memory — with nothing marking a guess as a
    // guess. Absence claims are uniquely worth catching because the payoff is asymmetric:
    // expensive to act on (you build the thing), cheap to falsify (one reverse-grep).
    //
    // Suppressed when the claim's own subject already appears in a checks[]/walls[] probe —
    // an author who parked the falsifier has done the thing this lint asks for.
    // Advisory + fail-open, like every other leg here: never blocks the write.
    const absenceClaims = (() => {
      if (!hasNoteWrite) return [];
      try {
        // Coverage is judged by the shared WORD-OVERLAP helper. Keeping the threshold
        // beside the shared detector prevents loop:checkpoint and its work-item sibling
        // from silently diverging on what counts as a parked falsifier.
        return uncoveredAbsencePremises(narrativeBody, 'carry-note', probeText);
      } catch {
        return []; // a lint must never cost the agent the checkpoint it asked for
      }
    })();

    // EI-18741016606334594: the SCOPE leg. Both lints above ask whether a claim has a
    // probe at all. This one asks whether the probe it has can actually see what the
    // claim asserts — a `✓` row whose claim is quantified ("no X", "never", "every")
    // while its own recheck declares a narrow bound (`--since '60 min ago'`, `tail -3`).
    // The badge is a licence to skip re-checking, so an over-broad one does not decay
    // across cold wakes; it hardens, and the successor inherits it as settled fact.
    //
    // Measured against the real corpus before wiring in (D-001, agent-epistemics):
    // 4,074 rows across 618 notes with a `## Checks` section (2026-08-13) — it flags
    // 31 (0.8% of rows, 1.1% of ✓ rows), and the prescriptive-row exclusion is what
    // keeps it there. Advisory + fail-open, like its siblings.
    const scopeOverreach = (() => {
      try {
        return detectScopeOverreach(checks);
      } catch {
        return [];
      }
    })();

    // P-020 (su-ideate-learning-substrate): checkpoint-HARVEST. The carry-note `insight`
    // is exactly the "non-obvious thing a future agent would re-derive" the observation
    // lane wants — auto-file it as a lane:observation with ZERO new workflow (D-016/D-017).
    // Fire-and-forget + fully fail-open: a harvest miss must NEVER slow or break the
    // checkpoint write (the same discipline as the SSE-invalidate in capture-core). The
    // leg self-coalesces the verbatim carry-note that persists across consecutive wakes.
    // Reads `fields.insight`, not `args.insight`: a RESCUED insight is a real insight and
    // must still reach the observation lane (EI-18833865002636933).
    if (fields.insight && fields.insight.trim()) {
      const insightText = fields.insight;
      const harvestHarness = harness !== '*' ? harness : undefined;
      void (async () => {
        try {
          const filedByRole = (await getPresence(ownerId).catch(() => null))?.agentRole ?? undefined;
          const { harvestInsight } = await import('../../harness/improvements/checkpoint-harvest');
          await harvestInsight({
            insight: insightText,
            createdBy: ownerId,
            source: 'loop-checkpoint',
            ref: 'loop:checkpoint',
            ...(filedByRole ? { filedByRole } : {}),
            ...(harvestHarness ? { harness: harvestHarness, sourceHive: harvestHarness } : {}),
          });
        } catch {
          /* fail-open: harvest never affects the checkpoint the agent asked for */
        }
      })();
    }

    // flush-to-proceed-stretch-discipline-2026-07-04 P-005: piggyback the CONTINUATION-GATE
    // read on the checkpoint the agent already writes at a unit boundary, so settle-vs-continue
    // is a one-call read (not a separate orient). Two mechanical legs: context headroom (from
    // the cached presence row) and any unread inbox since the last settle. Best-effort — a read
    // failure omits the leg (which the gate treats as blocking ⇒ it recommends settling, never a
    // false "continue"). An unresolvable inbox cursor also stays null (blocking) rather than
    // counting all history as unread.
    // ── P-004 MONITOR DELTA (anti-babysitting-monitor-enforcement-2026-08-25, D-002 §3) ──
    // Stamp the delta marker for the fire that is currently settling. An explicit `false`
    // deliberately writes NOTHING: omission and false are the same "no delta" verdict, and
    // the reconciler already treats an absent/stale marker as quiet — so there is no state
    // for a false to record, and writing one would only invite a reader to think it means
    // something different from omission.
    //
    // Best-effort by design: a failed stamp must never fail the carry-note write the agent
    // actually came here for. The worst case is one quiet wake counted against a monitor
    // that did move, and the next reported delta resets the budget in full.
    let monitorDeltaRoutinesStamped: number | null = null;
    if (args.monitorDelta === true && workspaceId) {
      try {
        const [{ recordMonitorDelta }, { getOrgPg }] = await Promise.all([
          import('../../harness/routines/monitor-standdown'),
          import('@papercusp/db-org'),
        ]);
        monitorDeltaRoutinesStamped = await recordMonitorDelta(getOrgPg().sql, { ownerId, workspaceId });
      } catch (e) {
        monitorDeltaRoutinesStamped = null;
        console.warn(
          `[loop:checkpoint] monitorDelta stamp failed for '${ownerId}': ${e instanceof Error ? e.message : e}`,
        );
      }
    }

    const continuationRead = await withBoundedTimeout(
      async () => {
        const pres = await getPresence(ownerId).catch(() => null);
        // P-006 (cold-carry-system-hardening-2026-07-19): derive context usage from the
        // transcript's CURRENT state (WI-4154's live read — the same fix inbox.ts already
        // carries), with the presence cache only as fallback. The gate previously read
        // ONLY presence.contextTokens, which is null/stale for psu sessions — so every
        // checkpoint closed on "context usage unknown" even seconds after a fresh turn
        // (observed on every single wake of 2026-07-19). Best-effort: null keeps the
        // old fail-safe-toward-settling behavior.
        const liveTokens = await (async () => {
          try {
            const { currentContextTokensForOwner } = await import('../../compaction-usage');
            return await currentContextTokensForOwner(ownerId);
          } catch {
            return null;
          }
        })();
        // Same P-006 gap on the denominator: presence.compactionLimit is null for the
        // same sessions — derive the model-spec default (the compliance-watchdog's own
        // fallback chain) so a live token read isn't wasted on a null limit.
        const derivedLimit = await (async () => {
          if (pres?.compactionLimit != null) return pres.compactionLimit;
          try {
            const [{ resolveModelSpecForOwner }, { defaultCompactionLimitForSpec }] = await Promise.all([
              import('../../compaction-usage'),
              import('../../agent-config-constants'),
            ]);
            return defaultCompactionLimitForSpec(await resolveModelSpecForOwner(ownerId));
          } catch {
            return null;
          }
        })();
        let unreadInbox: number | null = null;
        try {
          const wm = await readWatermark(ownerId);
          // messages_since_ts advances at turn-END, so this counts messages addressed to you
          // that arrived since your last settle. filterInbox (inside readInbox) drops own +
          // notify-kind rows; countPendingInterrupts then drops system machinery — categorized
          // broadcasts, `auto` lifecycle chatter, intent declares — because WI-4179 showed the
          // raw count reads a watchdog burst (16 identical severe-event-resolved rows in one
          // 300ms window) as "16 unread ⇒ pending owner input" and closes the gate while
          // coord:inbox/orient show nothing pending.
          // P-007 (fleet-member-dx, EI-9035): ALSO credit the owner's last coord:inbox/
          // coord:orient READ — use the LATER of the two cursors. A never-settled session
          // ('' watermark) that just read its inbox no longer gets a false, permanent
          // "inbox not evaluated"; and a mid-turn read after the last settle correctly
          // narrows "unread" to what arrived AFTER that read. Neither cursor available ⇒
          // stays null (blocking — fail safe toward settling, unchanged).
          const readTs = await lastInboxReadAt(ownerId);
          const sinceTs = pickUnreadCursor(wm?.messages_since_ts, readTs);
          if (sinceTs) {
            const unread = await readInbox(ownerId, { since_ts: sinceTs, excludeOwn: true });
            unreadInbox = countPendingInterrupts(unread);
          }
        } catch {
          unreadInbox = null;
        }
        // Re-wake guarantee (turn-end-tracking.isRewakeGuaranteed): is ending
        // THIS turn safe, or would an autonomous session silently halt? A CLOSED
        // gate that says "settle" is FALSE COMFORT when no re-wake exists — it
        // must escalate to self-compact / arm-a-wake. Excludes the always-armed
        // coord:inbox-wake keepalive (liveness, not a deliberate wake for this
        // work). Best-effort; unknown ⇒ null → base guidance (non-breaking).
        let rewakeGuaranteed: boolean | null = null;
        let activeInboxWakeAwait: boolean | null = null;
        let nextWakeFresh: boolean | null = null;
        let activeLoopIntervalSec: number | null = null;
        let activeLoopGoal: string | null = null;
        let activeLoopRewakeBlockedReason: ActiveLoopRewakeBlockedReason | null = null;
        try {
          const [{ isRewakeGuaranteed }, { listActiveAwaits, INBOX_WAKE_KEY_PREFIX }, { getModes }] = await Promise.all(
            [import('../../turn-end-tracking'), import('../../events/await/store'), import('../../modes/store')],
          );
          const [loop, awaits, modes] = await Promise.all([
            getLoopStatus(ownerId).catch(() => null),
            listActiveAwaits(ownerId).catch(() => []),
            workspaceId ? getModes(workspaceId, ownerId).catch(() => []) : Promise.resolve([]),
          ]);
          activeLoopIntervalSec = loop?.active ? loop.intervalSec : null;
          activeLoopGoal = loop?.active ? loop.goal : null;
          const currentTurn = await resolveCurrentTurnStamp(ownerId).catch(() => null);
          const loopWake = classifyLoopNextWake(loop);
          activeLoopRewakeBlockedReason =
            loop?.active && !loopWake.guaranteed && loopWake.reason !== 'no-active-loop' ? loopWake.reason : null;
          activeInboxWakeAwait = awaits.some((a) => a.eventKey.startsWith(INBOX_WAKE_KEY_PREFIX));
          const activeNonInboxAwaitCount = awaits.filter((a) => !a.eventKey.startsWith(INBOX_WAKE_KEY_PREFIX)).length;
          rewakeGuaranteed = isRewakeGuaranteed({
            autonomousModeActive: modes.some((m) => modeImpliesAutonomy(m.mode)),
            machineTurn: currentTurn?.verdict === 'agent-injected' || currentTurn?.verdict === 'machine-surface',
            loopActive: loopWake.guaranteed,
            activeAwaitCount: activeNonInboxAwaitCount,
          });
          // A loop can guarantee another turn without guaranteeing a fresh
          // context. A deliberate await can wake the same session before a cold
          // loop fires, so cold carry proves freshness only when it is the sole
          // non-inbox wake source; otherwise the next wake's freshness is unknown.
          nextWakeFresh = loopWake.guaranteed
            ? loop?.carry === 'cold'
              ? activeNonInboxAwaitCount === 0
                ? true
                : null
              : false
            : null;
        } catch {
          rewakeGuaranteed = null;
          nextWakeFresh = null;
        }
        // Can this session actually SELF-COMPACT? (EI-20209826138488049.) When the
        // gate has no guaranteed re-wake it recommends a recovery mechanism, and
        // recommending self-compaction to a session with no psu-pty host sent it to
        // spend its LAST turn on a call that can only return no_live_pty_host. Read
        // the SAME predicate session:request-compaction evaluates — not a correlated
        // proxy — so advice and refusal cannot disagree. Best-effort; unknown ⇒ null.
        let selfCompactionAvailable: boolean | null = null;
        try {
          const { selfCompactionAvailability } = await import('../../events/await/psu-pty-discovery');
          selfCompactionAvailable = selfCompactionAvailability(ownerId).available;
        } catch {
          selfCompactionAvailable = null;
        }
        let fleetWindDownLoopEndAuthorized: boolean | null = null;
        const contextPct = contextUsagePct(liveTokens ?? pres?.contextTokens, derivedLimit);
        const authorizationWorkspaceId = workspaceId ?? identity.workspaceId;
        if (
          contextPct != null &&
          contextPct >= CONTEXT_GAUGE_CRITICAL_PCT &&
          selfCompactionAvailable === false &&
          authorizationWorkspaceId
        ) {
          fleetWindDownLoopEndAuthorized = await readFleetWindDownLoopEndAuthorization({
            ownerId,
            workspaceId: authorizationWorkspaceId,
          });
        }
        return continuationGateFromReads({
          contextTokens: liveTokens ?? pres?.contextTokens,
          compactionLimit: derivedLimit,
          unreadInbox,
          rewakeGuaranteed,
          activeInboxWakeAwait,
          nextWakeFresh,
          selfCompactionAvailable,
          fleetWindDownLoopEndAuthorized,
          // Keep the continuation remedy executable for an already-active loop.
          // The gate can retune a warm loop to cold without making the agent
          // rediscover its cadence and goal through a second status read.
          activeLoopIntervalSec,
          activeLoopGoal,
          activeLoopRewakeBlockedReason,
        });
      },
      {
        fallback: undefined,
        timeoutMs: CONTINUATION_READ_BUDGET_MS,
        label: 'loop:checkpoint continuation reads',
      },
    );
    const continuation = continuationRead.value;
    // P-005: the wake payload that carried a verified-timeout diagnosis is
    // ephemeral, while timeout_verification on event_awaits is durable. Return
    // the latest authoritative stalled/absent evidence on the checkpoint write
    // the owner already performs, including the concrete wake/takeover remedy.
    const verifiedWaitTakeovers = await withBoundedTimeout(listVerifiedWaitTakeoversForSubscribers([ownerId]), {
      fallback: [],
      timeoutMs: CONTINUATION_READ_BUDGET_MS,
      label: 'loop:checkpoint verified-wait takeovers',
    });
    const verifiedWaitTakeoverRows = verifiedWaitTakeovers.value ?? [];

    // WI-3801 lint + P-014 turn-ref verification/origin stamp — both warn-only,
    // absent (no fields) on a clean/cleared write. The final stored note is used
    // only to derive inherited lines; current lint receives submitted bytes.
    const provenanceFields =
      stored !== null
            ? await carryProvenanceFields(currentProvenanceText, ownerId, {
                retainedText: retainedProvenanceText(stored, currentProvenanceText),
                precomputedStamp: preWriteStamp,
          })
        : {};
    // P-017: the durable half of this private note, posted to the effort thread in the
    // same round-trip. Fail-soft and AFTER the carry-note verify — the loop's own carry
    // is what a cold wake cannot do without, so a refused thread post must never take
    // it down. `workItem` is required as the anchor because the loop scope itself is
    // keyed by ownerId and carries no object identity to attach a shared note to.
    const learnedText = (args.learned ?? '').trim();
    let learnedResult: Awaited<ReturnType<typeof postLearnedAtLevel>> | null = null;
    let learnedSkippedNoAnchor = false;
    if (learnedText) {
      if (!args.workItem?.trim()) learnedSkippedNoAnchor = true;
      else
        learnedResult = await postLearnedAtLevel({
          workItemId: args.workItem.trim(),
          level: args.learnedLevel,
          text: learnedText,
          harness,
          authorId: ownerId,
        }).catch(() => null);
    }
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            harness,
            ...(learnedResult
              ? {
                  learned: {
                    posted: learnedResult.posted,
                    level: learnedResult.level,
                    ref: learnedResult.ref,
                    ...(learnedResult.fellBack
                      ? {
                          note: `the anchor item has no ${learnedResult.requestedLevel} ancestor — the lesson was written at ${learnedResult.level} instead (nothing was dropped)`,
                        }
                      : {}),
                    ...(learnedResult.skipped ? { skipped: learnedResult.skipped } : {}),
                  },
                }
              : {}),
            ...(learnedSkippedNoAnchor
              ? {
                  learned: {
                    posted: false,
                    skipped: 'no-anchor',
                    note: 'a loop note is keyed by ownerId and has no object to attach a shared lesson to — pass `workItem` (the item this loop is driving) and the lesson lands on its thread.',
                  },
                }
              : {}),
            // EI-21510951589801937: when the scope came from the owner's existing
            // carry-note rather than from the session, say so — the write succeeded,
            // but the caller should know which store it landed in.
            ...(inferredScopeFrom ? { scopeInferredFrom: inferredScopeFrom } : {}),
            /** WI-1826126: the caller passed `harness` and the ARMED ROUTINE outranked it.
             *  That precedence is deliberate for a write — the note must land where the
             *  cold reader will look — but echoing only the resolved harness made the
             *  discarded argument invisible, so a caller trying to re-address a stranded
             *  note believed it had succeeded. Name both, and say where a read can go. */
            ...(explicitHarnessOverriddenByRoutine
              ? {
                  explicitHarnessIgnored: {
                    requested: explicitHarness,
                    wroteTo: harness,
                    why: 'An armed loop routine outranks the `harness` argument on a WRITE, so the note lands where the next cold wake will read it. This is not overridable; to READ the other scope, pass the same argument to loop:checkpoint { read:true, harness } — reads honour it.',
                  },
                }
              : {}),
            // EI-22166372050218668: WI-2148's fail-open write (never blocked by a
            // getLoopStatus hiccup) previously left this SILENT — the write reported the
            // same bare `ok:true` whether `harness` above was CONFIRMED against the armed
            // routine or merely fell back to session/context because the confirming probe
            // failed. A session whose loop lives under a different harness than its
            // current ctx.harnessSlug could checkpoint into the wrong store indefinitely
            // with no signal on either side. Say so on the write result itself, right where
            // the caller (or a successor re-reading this tool_invocations row) can see it —
            // never gated behind a separate loop:status call the caller has to think to make.
            ...(routineProbeFailureIsSilent
              ? {
                  routineProbeFailed: {
                    wroteTo: harness,
                    why: 'The armed-loop scope probe (getLoopStatus) failed, so this write could NOT confirm which harness the loop is actually armed under and fell back to session/context scope instead (fail-open, per WI-2148 — a checkpoint write is never blocked by this). If the loop is really armed elsewhere, this note is stranded: call loop:status to check loop.harnessSlug, and if it disagrees with `harness` above, re-checkpoint with an explicit `harness` matching it.',
                  },
                }
              : {}),
            ownerId,
            cleared: stored === null,
            length: stored?.length ?? 0,
            /** WI-7124: the write READ BACK byte-identically via the SAME path a cold
             *  wake uses (null on a clear — nothing to verify; a mismatch never reaches
             *  here — it returns checkpoint_verify_failed above instead). */
            verified,
            /** First 12 hex chars of sha256(stored) — eyeball-check without a re-read. */
            contentHash,
            walls: walls.length,
            checks: checks.length,
            /** P-004: report whether a `monitorDelta:true` actually reached a monitor loop.
             *  0 means the caller has no active monitor routine (so nothing was reset) —
             *  a silent `ok:true` there would read as "budget reset" when it was not. */
            ...(args.monitorDelta === true
              ? { monitorDelta: { recorded: monitorDeltaRoutinesStamped, requested: true } }
              : {}),
            /** P-005 / D-030 (7): the zero-workers guard could not measure, so it allowed. */
            ...(fleetZeroWorkersWarning ? { fleetZeroWorkersWarning } : {}),
            ...(verifiedWaitTakeoverRows.length > 0 ? { verifiedWaitTakeovers: verifiedWaitTakeoverRows } : {}),
            /** P-013: which row semantics this write actually ran under, so a caller
             *  never has to infer it from the counts. Present only when it was NOT the
             *  default, keeping the common reply shape unchanged. */
            ...(rowsMode !== 'replace' ? { rowsMode } : {}),
            /** P-013: under merge, `[]` deliberately means "change nothing" rather than
             *  "clear" — a clear must be explicit. Say so, or the caller reads a silent
             *  no-op as a clear that failed. */
            ...(rowsMode === 'merge' && (args.walls?.length === 0 || args.checks?.length === 0)
              ? {
                  rowsModeNote:
                    "rowsMode:'merge' treats an empty list as a NO-OP, not a clear — the carried rows are " +
                    "untouched. To clear, re-send with rowsMode:'replace' and [].",
                }
              : {}),
            /**
             * EI-19463731740128181: a supplied list REPLACES, so carried rows the caller
             * left out are GONE. The reply used to carry only these post-merge COUNTS —
             * which reveal a loss ONLY to a caller who recorded the prior count first, so
             * in practice the loss was silent behind `ok: true`. Adding one row to a
             * carried set is the most natural use of the parameter (and exactly what the
             * `checksLint` advisory below tells you to do), which is what made this bite.
             * Absent entirely when nothing was lost, so the common result shape is
             * unchanged. Claims are truncated: they identify WHICH row went, they are not
             * a restore payload. Mirrors work_items:checkpoint's `checksDropped`.
             */
            ...(droppedChecks.length
              ? {
                  checksDropped: droppedChecks.map((c) => (c.length > 300 ? `${c.slice(0, 300)}…` : c)),
                  checksDroppedNote:
                    rowsMode === 'merge'
                      ? legacyOverCapNormalization.checks > 0
                        ? `LEGACY CAP NORMALIZATION, not a caller-caused overflow: the carried note already held ` +
                          `${legacyOverCapNormalization.checks} row(s) MORE than the ${CARRY_NOTE_MAX_CHECKS}-row cap ` +
                          `before this merge. The write normalized that legacy state to the cap, keeping supplied ` +
                          `rows first and evidence-bearing carried rows before predicted rows. This was legacy state, ` +
                          `not your mistake. Future additive writes that would exceed the cap are refused; retire ` +
                          `stale rows explicitly with rowsMode:'replace' and confirmRetire:true.`
                        : `CAP EVICTION, confirmed via confirmRetire:true: rowsMode:'merge' UNIONED your ` +
                          `${effectiveChecks?.length ?? 0} row(s) onto the carried set, the union exceeded the ` +
                          `${CARRY_NOTE_MAX_CHECKS}-row cap, and ${droppedChecks.length} CARRIED row(s) were ` +
                          `evicted from the tail (supplied rows are kept first, PREDICTED rows yield before ` +
                          `VERIFIED ones). This is the actual eviction computed for this confirmed write; an earlier ` +
                          `refusal with different supplied rows or carried state may name a different drop set. To ` +
                          `avoid future evictions: retire rows you no longer need in a separate plain write ` +
                          `(rowsMode:'replace'), or pass no \`checks\` at all to leave the stored rows untouched.`
                      : `a supplied \`checks\` list REPLACES the carried set — ${droppedChecks.length} carried ` +
                        `claim(s) were not in this write and are now gone. To restore: re-send them (a re-sent claim ` +
                        `inherits its prior recheck/verified). To AVOID this next time, pass rowsMode:'merge' — ` +
                        `unmentioned rows then survive and you send only the rows you are changing; give a row an ` +
                        `\`id\` if you expect to re-word its claim.`,
                }
              : {}),
            // P-025: rows the caller retired BY NAME (`retireIds`) — deliberate, so
            // reported apart from the unintended-loss `checksDropped`/`wallsDropped`.
            ...(retiredChecks.length ? { checksRetired: retiredChecks.map((c) => (c.length > 300 ? `${c.slice(0, 300)}…` : c)) } : {}),
            ...(retiredWalls.length ? { wallsRetired: retiredWalls.map((c) => (c.length > 300 ? `${c.slice(0, 300)}…` : c)) } : {}),
            ...(unmatchedRowRefs.length
              ? {
                  unmatchedRowRefs: unmatchedRowRefs.map((c) => (c.length > 300 ? `${c.slice(0, 300)}…` : c)),
                  unmatchedRowRefsNote:
                    'These `replaces`/`retireIds` refs named no carried row (match is by [#id] or EXACT claim ' +
                    'text). An unmatched `replaces` row was written as a new row; an unmatched retire removed nothing.',
                }
              : {}),
            /** Same contract for WALLS — and a dropped wall is worse than a dropped check:
             *  it is an owner-gated commitment, so losing one silently un-blocks work the
             *  owner never released. */
            ...(droppedWalls.length
              ? {
                  wallsDropped: droppedWalls.map((c) => (c.length > 300 ? `${c.slice(0, 300)}…` : c)),
                  wallsDroppedNote:
                    rowsMode === 'merge'
                      ? `CAP EVICTION, confirmed via confirmRetire:true: rowsMode:'merge' UNIONED your ` +
                        `${effectiveWalls?.length ?? 0} row(s) onto the carried set, the union exceeded the ` +
                        `${CARRY_NOTE_MAX_WALLS}-row cap, and ${droppedWalls.length} CARRIED owner-gated ` +
                        `commitment(s) were evicted from the tail (supplied rows are kept first). This is the actual ` +
                        `eviction computed for this confirmed write; an earlier refusal with different supplied rows ` +
                        `or carried state may name a different drop set. To avoid future evictions: retire ` +
                        `rows you no longer need in a separate plain write (rowsMode:'replace'), or pass no ` +
                        '`walls` at all to leave the stored rows untouched.'
                      : `a supplied \`walls\` list REPLACES the carried set — ${droppedWalls.length} carried ` +
                        `owner-gated commitment(s) were not in this write and are now gone. Re-send the FULL set, ` +
                        `pass no \`walls\` at all, or use rowsMode:'merge' so unmentioned rows survive.`,
                }
              : {}),
            /**
             * P-013: rows YOU supplied that the row cap cut. `checksDropped` above can
             * only see rows lost from the CARRIED set, so without this a 13th row sent
             * into a 12-row cap disappears behind `ok: true` — the same silence, one
             * step over. Absent when nothing overflowed.
             */
            ...(overflowChecks.length || overflowWalls.length
              ? {
                  ...(overflowChecks.length
                    ? { checksOverflowed: overflowChecks.map((c) => (c.length > 300 ? `${c.slice(0, 300)}…` : c)) }
                    : {}),
                  ...(overflowWalls.length
                    ? { wallsOverflowed: overflowWalls.map((c) => (c.length > 300 ? `${c.slice(0, 300)}…` : c)) }
                    : {}),
                  overflowNote:
                    `the row cap (${CARRY_NOTE_MAX_CHECKS} checks / ${CARRY_NOTE_MAX_WALLS} walls) cut ` +
                    `${overflowChecks.length + overflowWalls.length} row(s) YOU supplied — they were NOT stored. ` +
                    `Retire a carried row first (re-send the set you want under rowsMode:'replace'), ` +
                    `then add the new one.`,
                }
              : {}),
            /** WI-7264: fields trimmed to their soft cap so the write could SUCCEED instead
             *  of the whole note being rejected over one long field. Omitted when nothing
             *  was trimmed. Same never-silently-degrade contract as `rescued` below: the
             *  bytes really were cut, so the caller has to be told. */
            ...(repairs.length ? { repairs } : {}),
            // EI-18833865002636933: NEVER rescue silently. The original defect was that a
            // mangled note reached the cold wake looking like sloppy authoring, with
            // nothing saying it had been degraded — so a rescue must announce itself and
            // teach the correct call shape.
            // EI-21918217118634060: NEVER claim "stored correctly" for a sibling section
            // whose closing tag was PRESENT in the blob but which failed to parse into
            // `rescued` — that is a silently-dropped write wearing a success envelope,
            // strictly worse than an honest failure because the caller stops checking.
            ...(rescued
              ? (() => {
                  const recovered = Object.keys(rescued);
                  const signaled = detectCarryNoteRescueSignals(args.did);
                  const dropped = signaled.filter((key) => !(key in rescued));
                  return {
                    rescued: {
                      from: 'tagged-blob',
                      recovered,
                      ...(dropped.length > 0 ? { droppedSections: dropped } : {}),
                      note:
                        dropped.length === 0
                          ? 'Your `did` was a whole structured note serialized as one XML-tagged string; it was ' +
                            'PARSED back into sections + typed rows and stored correctly. Pass { did, left, ' +
                            'insight, next, checks } as SEPARATE arguments — do not emit section tags inside a ' +
                            'field value.'
                          : `Your \`did\` looked like a whole structured note serialized as one XML-tagged ` +
                            `string, but only [${recovered.join(', ')}] parsed cleanly. A closing tag for ` +
                            `[${dropped.join(', ')}] was present yet did NOT extract — those section(s) were ` +
                            'NOT stored: any prior content is unchanged, and whatever you meant to write there ' +
                            'remains buried as literal tagged text inside the stored `did`. Re-send { did, left, ' +
                            'insight, next, checks } as SEPARATE, well-formed arguments so nothing is silently ' +
                            'dropped.',
                    },
                  };
                })()
              : {}),
            ...(uncheckedClaims.length > 0
              ? {
                  checksLint: {
                    flagged: true,
                    note:
                      'checks_lint: prose line(s) assert external state (hash / id / instant) with NO matching ' +
                      'checks[]/walls[] probe — a carried claim without its check is the phantom-re-anchor shape. ' +
                      'Move each into checks:[{ claim, recheck, verified? }] so the probe travels with the claim. ' +
                      'Advisory only; the write was kept.',
                    lines: uncheckedClaims,
                  },
                }
              : {}),
            ...(falsifierMissingRows.length > 0
              ? { falsifierMissing: { flagged: true, note: FALSIFIER_MISSING_NOTE, rows: falsifierMissingRows } }
              : {}),
            ...(absenceClaims.length > 0
              ? {
                  absenceLint: {
                    flagged: true,
                    note:
                      'absence_lint: this note asserts that something DOES NOT EXIST. That claim class is the ' +
                      'single most repeated diagnostic error in this codebase, it is expensive to act on (you ' +
                      'build the missing thing) and cheap to falsify (one reverse-grep), and your next wake — or ' +
                      'a cold successor, for whom this note is the ONLY memory — will read it as established ' +
                      'fact. Run each recheck NOW. If it holds, move it into checks:[{ claim, recheck, verified }] ' +
                      'so the evidence travels with the claim; if it does not, fix the note before it is inherited. ' +
                      'Search for the thing you say is ABSENT (who reads/calls/imports it), not just the thing you ' +
                      'say ignores it — an absence proved by one grep in one file is not proved. Advisory only; ' +
                      'the write was kept.',
                    claims: absenceClaims,
                  },
                }
              : {}),
            ...(scopeOverreach.length > 0
              ? {
                  scopeLint: {
                    flagged: true,
                    note:
                      'scope_lint: a ✓VERIFIED row claims MORE than its own re-check can observe — the claim is ' +
                      'quantified (no / never / every / all / today) while the probe declares a narrow bound. The ' +
                      '✓ badge is what a cold successor reads INSTEAD of re-checking, and a re-rendered row does ' +
                      'not decay — it hardens into settled fact. Either NARROW the claim to what the probe saw, ' +
                      'or WIDEN the probe and re-run it. Advisory only; the write was kept.',
                    rows: scopeOverreach,
                  },
                }
              : {}),
            ...(relativeScratchRefs.length > 0
              ? {
                  scratchPathLint: {
                    flagged: true,
                    note: RELATIVE_SCRATCH_ADVISORY,
                    refs: relativeScratchRefs,
                  },
                }
              : {}),
            ...(imperativeActions.length > 0
              ? {
                  imperativeLint: {
                    flagged: true,
                    note:
                      'imperative_lint: this carry-note instructs the next wake to invoke a singleton/shared-state ' +
                      'mutator whose precondition may be stale by wake time. Park the PRECONDITION as a runnable ' +
                      'checks:[{ claim, recheck }] row naming the same action; do not carry only the conclusion. ' +
                      'Advisory only; the write was kept.',
                    matches: imperativeActions,
                  },
                }
              : {}),
            ...(decisionRefAdvisory ? { decisionRefAdvisory } : {}),
            ...(continuation ? { continuation } : {}),
            ...provenanceFields,
          }),
        },
      ],
    };
  },
});
