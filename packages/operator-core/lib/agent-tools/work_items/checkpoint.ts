/**
 * work_items:checkpoint — the bee's work-item-scoped CHECKPOINT / carry-note write
 * (bee-context-efficiency-2026-06-14 Phase 3 / P-010·P-011·P-012; D-002, D-003).
 *
 * The bee translation of the Queen's self-authored carry-note: a bee writes a
 * compressed snapshot of its in-flight state at a task boundary / on graceful evict.
 * The NEXT invocation on the SAME work-item re-injects it in the spawn/wake-hydration
 * volatile tail (`### Carry-note (your last checkpoint)`, P-011) — so a re-woken bee OR
 * a SUCCESSOR bee after eviction resumes from the checkpoint instead of a cold start.
 * This is what lets fresh-context warm-inject (D-001) drop the grown transcript without
 * losing continuity: the transcript will NOT carry; the checkpoint is the continuity.
 *
 * setHiveCarryNote semantics (D-003): replace-on-write; omitted/null ⇒ CLEARED
 * at the store layer (the next invocation re-derives from the dossier alone —
 * graceful degradation). The tool layer requires an explicit clear so a metadata-
 * only/read-like call cannot erase a live checkpoint by omission.
 * EI-21020695928840897: a blank string is rejected unless `confirmClear:true`
 * because shell/result extraction mistakes commonly produce `""`; callers can use
 * `checkpoint:null` or `clear:true` for an unambiguous clear.
 * WORK-ITEM-scoped (D-002): the note lives on the item, so a successor inherits it.
 *
 * Bulk by default (bulk-endpoint-standardization-2026-06-21): checkpoint ONE item inline
 * ({ id, checkpoint?, harness? }) or MANY (items:[{ id, checkpoint?, harness? }]) →
 * { ok, results:[{ ok, id, harness, cleared, length, contentHash, by | error }], counts }.
 * Each item resolves its own harness; one unresolvable item never fails the rest.
 *
 * EI-9036: `append: true` is an opt-in mode for the common "just add a short addendum
 * to my detailed checkpoint" case. Replace-on-write is the default and stays the
 * default — a caller who forgets `append` gets EXACTLY today's behavior, no surprise
 * either direction. With `append: true`, the tool reads the CURRENT stored checkpoint
 * first (via the same reader path a future pickup uses) and joins the new text onto it
 * with a `---` separator, instead of overwriting it — so an incremental progress note
 * can never silently discard a detailed prior record. Still bounded to the 32000-char
 * cap: if the join would exceed it, the superseded tail of the prior content is
 * trimmed (with a visible `[older checkpoint content truncated]` marker) so the
 * oldest baseline and newest addendum stay visible whenever they fit. `append: true`
 * unions supplied check rows by default; an explicit `rowsMode:'replace'` still
 * replaces the check-row set while append controls only the body.
 * with a blank/omitted checkpoint text is rejected
 * (append + clear is a contradiction) unless `checks` is supplied as an additive,
 * body-preserving patch.
 *
 * EI-8987: `contentHash` is a short sha256 (first 12 hex chars) of the STORED text —
 * computed from what the store actually persisted (the same trimmed string
 * setWorkItemCheckpoint returns), not from the caller's input — so a paranoid caller
 * can round-trip-verify a write landed byte-for-byte in the SAME call, no second
 * work_items:get read needed. Null when cleared (nothing was stored). This is a
 * defense-in-depth addition on top of EI-8824 (the actual silent-loss bug, already
 * fixed) and EI-8885 (checkpointAgeMs on work_items:get) — belt-and-suspenders so a
 * FUTURE silent-loss bug class is caught at write time, not discovered post-compaction.
 *
 * EI-9325: a plain replace-on-write (not append, not a clear) that shrinks a
 * substantial prior checkpoint by more than half gets a non-blocking `shrinkWarning`
 * on the result — the caller-side footgun this was filed against is a rewrite that
 * INTENDED to preserve prior content verbatim (e.g. prepending a new section by hand)
 * but instead wrote a placeholder/marker line, silently truncating a detailed
 * checkpoint with no built-in signal that data was lost. Uses
 * `setWorkItemCheckpointWithPrior`, which surfaces the prior length for FREE (the row
 * is already SELECTed FOR UPDATE inside the write transaction to build the journal
 * ring) — no extra round-trip, so the existing "plain replace never pre-reads"
 * contract (see the append-mode tests) is unaffected.
 *
 * EI-18140632570924965: EI-9325's shrinkWarning was WARN-ONLY — it still executed
 * the destructive write in the same call. Confirmed live: a plain replace on WI-4487
 * (a 19,348-char / 5-day / 4-agent forensic record) silently collapsed it to 739
 * chars; only the shrinkWarning in the response let the caller notice and restore
 * from a prior Read. Fix: the SAME shrink condition now BLOCKS the write by default
 * (`shrink_blocked`, no data touched — the guard runs inside
 * setWorkItemCheckpointWithPrior's locked transaction, before the DELETE/INSERT) —
 * pass `append: true` to join instead (the item's own convention here — every real
 * checkpoint on a long-running ticket already separates dated sections with `---`),
 * or `confirmShrink: true` when a genuine replace is intended. The blocked result
 * carries both recovery shapes as structured data, so a successor does not have
 * to infer the retry from prose after a context boundary.
 *
 * EI-20232176364474286: a concise plain refresh that trips that guard is retried
 * once as an additive append. The retry's transform runs under the store lock, so
 * it preserves the current prior even if another writer changed it between the
 * refusal and retry; `confirmShrink:true` remains the explicit destructive path.
 *
 * EI-18132462898750489: NO ownership guard existed — any agent could checkpoint (or
 * CLEAR) an item it does not hold, silently overwriting the actual assignee's
 * in-flight state. Confirmed live: a fleet member (su-2e534e59) that had only READ
 * WI-5557 via work_items:get (assignee su-a7d08fd3, a different live agent) called
 * this tool on it anyway; the write succeeded with no signal that the caller wasn't
 * the holder. Believing the silent success proved ownership, that agent then told
 * its OWN compaction summary "Currently holding WI-5557" — a false directive that
 * would have caused its successor to edit the item concurrently with its real
 * holder had the successor not independently re-verified via coord:orient. The
 * checkpoint text itself shows this had already happened at least once before
 * ("a prior holder's detailed design got lost when overwritten by a meta-checkpoint").
 * Fix: refuse the write per-item when the item has an assignee and it is not the
 * caller (`not_holder`) — this is the exploitable surface (the item's own
 * `taken_by`/`assignee` column is the authoritative holder signal); an unassigned
 * item (about to be claimed) or one already assigned to the caller still writes
 * normally. A caller that wants to leave a note on an item it doesn't hold has
 * work_items:comment for that.
 *
 * EI-18665443723911343: the single-shorthand `append`/`confirmShrink` booleans
 * intermittently rejected a caller's `true`/`false` with "expected boolean, received
 * string", while the byte-identical value sent through `items:[{ ... }]` parsed fine
 * on the same session, minutes apart — a rejected write on the exact surface whose job
 * is surviving a context boundary. Fix: `looseBoolean()` preprocesses the two literal
 * strings `"true"`/`"false"` to their boolean value ahead of the zod boolean check, on
 * both the shorthand and the `items[]` fields, so the two paths accept identical input.
 * Deliberately NOT `z.coerce.boolean()` — that coerces via `Boolean(x)`, which would
 * turn the string `"false"` into `true`.
 *
 * WI-7190: `append: true` used to arm NO shrink guard at all — the one mode whose
 * whole contract is "never lose the existing text" was the mode with no shrink
 * protection. Confirmed live: a caller's append pre-read (the `getWorkItemCheckpoint`
 * call above, used only to build the joined text) came back empty on a resolvable
 * item while a real 10,671-char checkpoint existed — the join then had nothing to
 * join onto, `checkpointToStore` collapsed to just the addendum, and the write
 * silently REPLACED the prior checkpoint while still returning
 * `ok:true, verified:true`. Fix: the append path now ALSO arms a guard — run inside
 * the SAME locked write transaction as `setWorkItemCheckpointWithPrior`'s own prior
 * read — that compares what the tool's separate pre-read saw against the
 * AUTHORITATIVE prior read at write time. If the pre-read came back
 * null/empty/errored while the authoritative prior is substantial (>500 chars), the
 * write is refused (`append_base_unreadable`) instead of silently degrading to a
 * replace. `confirmShrink: true` still forces it through (same escape hatch as the
 * plain-replace guard), for a caller that genuinely wants to reset the checkpoint.
 *
 * EI-19447043119380534: `{ id, checks }` with `checkpoint` OMITTED used to DESTROY the
 * body — it rendered a note consisting only of the `## Checks` section and returned
 * ok:true. Confirmed live (9376 → 1562 chars) and reproduced in test: the plan and the
 * file-by-file record were gone, and with `checks: []` the note collapsed to null
 * outright. The shape was uniquely bad because the two adjacent fields had OPPOSITE
 * omission defaults (an omitted `checks` PRESERVES, by its own documented contract)
 * and because the >50% shrink guard structurally could not fire: `isPlainReplace`
 * requires a non-empty replacement body, so the guard armed for the DELIBERATE case
 * and skipped the ACCIDENTAL one. Fix: an omitted `checkpoint` alongside `checks` is a
 * checks-only PATCH that carries the stored body forward (read inside the store's
 * locked transaction, so a concurrent writer cannot interleave). A dependency-only
 * PATCH (`dependsOn` supplied while `checkpoint` is omitted) uses the same
 * body-preserving path, so correcting freshness metadata never requires re-sending
 * — and accidentally shrinking — the narrative checkpoint. An explicit clear stays
 * reachable via `checkpoint: null`/`clear:true`; a bare `{ id }` is rejected because
 * omission is indistinguishable from a read-like call. The terminal cleanup contract
 * is unaffected because work_items:complete calls the store directly with `null`.
 */
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { DbCallDeadlineError } from '@papercusp/db-org';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { WORK_ITEM_LIFECYCLE_ROLES } from '../coordination/roles';
import {
  setWorkItemCheckpointWithPrior,
  getWorkItemCheckpoint,
  attestWorkItemCheckpointUnchanged,
} from '../../work-item-checkpoint';
import { OrgTxnTimeoutError } from '../../pg-bounded-txn';
import { dependsOnSpec } from '../../freshness/tool-schema';
import { resolveCurrentTokens } from '../../freshness/resolvers';
import { markFeatureProgress, markIssueProgress, isClaimHoldParked, isSelfOwnerRecord } from '../../work-items';
import { lookupWorkItem } from './_lookup';
import { deriveRepoPathsFromText } from './_derive-paths';
import { unresolvedRefsInBody, unresolvedRefsWarning } from './unresolved-refs';
import { unresolvedPlanDecisionRefs } from '../coordination/decision-ref-advisory';
import {
  carryRowTextSchema,
  CARRY_ROW_ID_SCHEMA,
  CARRY_ROW_REPLACES_SCHEMA,
} from '../_carry-row-id';
import { detectPauseDeclaration, pauseNotEnforcedWarning } from '../../carry-note-pause-declaration';
import { runBulk, bulkContent } from '../_bulk';
import { resolveConcreteWorkspaceId } from '../../workspace-registry';
import {
  carryProvenanceFields,
  expandCurrentTurnSentinel,
  hasCurrentTurnSentinel,
  markUnverifiedOwnerAttribution,
  normalizeUnverifiedOwnerAttributionMarkers,
  ownerAttributionEnforcement,
  retainedDirectiveMatches,
  retainedProvenanceText,
  stampCarrySurfaceProvenance,
} from '../../carry-surface-provenance-stamp';
import { resolveCurrentTurnStamp } from '../../turn-provenance/turn-ref';
import { hasPotentialActionClaim, readSuccessfulActionInvocations } from '../../carry-surface-action-proof';
import {
  CARRY_CAP_HARD_MULTIPLE,
  CARRY_NOTE_MAX_CHECKS,
  CARRY_ROW_SOFT_CAPS,
  carryRowKey,
  coerceCarryRowShape,
  type CarryArgRepair,
  evidenceFirst,
  FALSIFIER_MISSING_NOTE,
  checksMissingFalsifier,
  RELATIVE_SCRATCH_ADVISORY,
  normalizeCheckEntries,
  normalizeFlattenedContinuityProbeRow,
  patchExistingCheckEntries,
  resolveCarryRowRefs,
  renderCheckLine,
  renderCarryNote,
  sanitizeCarryRowId,
  splitCarryNoteChecks,
  splitCarryNoteWalls,
  truncateCarryField,
  withCarryNoteChecks,
  withCarryNoteWalls,
  CHECKPOINT_BODY_CAP_CHARS,
  type WorkItemSubject,
} from '../../carry-note';
import { filterTrackedRelativeScratchPaths } from '../checkpoint-relative-scratch';
import { detectScopeOverreach } from '../../carry-note-probe-scope';
import { describeUnreadRun } from '../../carry-note-unread-run';
import { uncoveredAbsencePremises } from '../../premises-claim-port';
import { postLearnedAtLevel, describeCaptureGaps } from '../../effort-thread';
import {
  evaluateFrozenLineageCarryText,
  frozenLineageCarryViolationPayload,
} from '../../release/frozen-lineage-execution-policy';
import { resolveHomeGateVerdictTarget } from '../../release/gate-verdict-target';
import { LIMITS } from '../limits';

/**
 * D-010: the note length below which the capture advisory stays SILENT.
 *
 * 400 chars is about a paragraph. Below it a checkpoint is a progress ping ("suite
 * green, moving to P-004"), which has no root cause to omit — nagging it would make
 * the advisory noise, and an advisory nobody reads is the exact D-004 failure mode
 * this is trying to fix rather than reproduce.
 */
const CAPTURE_ADVISORY_MIN_CHARS = 400;
import { continuityPredicateSchema, continuityProbeSchema } from '../../continuity-probes';

/** First 12 hex chars of sha256(text) — short enough to eyeball, long enough that an
 *  accidental collision between two DIFFERENT checkpoint bodies is not a real concern. */
function shortHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12);
}

/**
 * EI-22386514939689944: checkpoint prose is the successor's entry point, but
 * repo-relative paths written there were previously never checked. Reuse the
 * same file resolver as `dependsOn` and report only explicit `null` tokens:
 * missing map entries mean the resolver could not make a judgment and stay
 * silent. This is advisory and fail-open because prose may intentionally name
 * planned, deleted, or sibling-checkout files.
 */
async function unresolvedProsePathsInCheckpoint(
  checkpoint: string | null,
  ctx: { workspaceId: string; harness: string | null },
): Promise<{ flagged: true; paths: string[]; note: string } | undefined> {
  if (!checkpoint) return undefined;

  try {
    // Check only narrative prose. A `## Checks` recheck may quote a path as the
    // probe itself; that is already structured evidence, not an unverified
    // handover path.
    const body = splitCarryNoteChecks(checkpoint).body;
    const paths = deriveRepoPathsFromText(body);
    if (paths.length === 0) return undefined;

    const deps = paths.map((path) => `file:${path}`);
    const tokens = await resolveCurrentTokens(deps, ctx, { allowDirectories: true });
    const missing = paths.filter((path) => tokens.get(`file:${path}`) === null);
    if (missing.length === 0) return undefined;

    const noun = missing.length === 1 ? 'path' : 'paths';
    return {
      flagged: true,
      paths: missing,
      note:
        `prose_path_lint: checkpoint prose names ${missing.length} repo-relative ${noun} that could not be ` +
        `resolved in the item's harness: ${missing.join(', ')}. This is advisory only and did not block the ` +
        'write; the path may be planned, deleted, or in a sibling checkout. Verify the canonical spelling before ' +
        'treating the handover as evidence that the surface is absent.',
    };
  } catch {
    // A resolver or extractor failure is "cannot judge", never evidence that a
    // path is wrong. The checkpoint itself must remain durable.
    return undefined;
  }
}

/** Count the rows an additive checks write needs before normalization applies its cap. */
function appendChecksOverflowCount(
  priorNote: string | null,
  suppliedChecks: ReadonlyArray<{ id?: string; claim: string; replaces?: string }> | undefined,
): number {
  if (suppliedChecks === undefined) return 0;
  const refs = resolveCarryRowRefs({
    priorWalls: [],
    priorChecks: splitCarryNoteChecks(priorNote).checks,
    checks: suppliedChecks,
  });
  const priorChecks = refs.priorChecks;
  const resolvedChecks = refs.checks ?? [];
  // A legacy note may exceed today's cap. Updating only rows that already exist
  // is an in-place patch, not an overflowing union, so preserve the full legacy
  // evidence instead of refusing the refresh or normalizing away its tail.
  if (resolvedChecks.length > 0 && patchExistingCheckEntries(resolvedChecks, priorChecks) !== null) return 0;
  const unionKeys = new Set(
    [...resolvedChecks, ...priorChecks]
      .filter((row) => (row.claim ?? '').trim().length > 0)
      .map((row) => carryRowKey(row)),
  );
  return Math.max(0, unionKeys.size - CARRY_NOTE_MAX_CHECKS);
}

/**
 * How many rows a stored note carries beyond today's row cap — i.e. how much LEGACY
 * over-cap state it holds, independently of anything the current caller supplied.
 *
 * EI-21534719386975911: this is the discriminator that separates the two situations the
 * additive overflow guard used to conflate. A write can overflow the cap because the
 * CALLER is adding rows to a note that still fits (the case the guard was built for), or
 * because the STORED note already exceeded the cap before the call was made — 57 of the
 * 859 checks-bearing carry-notes in this workspace did, the worst holding 62 rows.
 * Against such a note EVERY non-empty additive write overflows, so the guard refused
 * permanently and no caller-side change could clear it. That is a data problem wearing a
 * validation error's clothes, which is why it was filed repeatedly and "fixed" six times
 * by rewording the refusal.
 */
function priorChecksOverCapCount(priorNote: string | null): number {
  const priorChecks = splitCarryNoteChecks(priorNote).checks.filter((row) => (row.claim ?? '').trim().length > 0);
  return Math.max(0, priorChecks.length - CARRY_NOTE_MAX_CHECKS);
}

/**
 * Order the CARRIED rows of an additive union so that, if the cap bites, it cuts the
 * cheapest-to-reproduce rows first: a `? PREDICTED` hypothesis yields before a
 * `✓ VERIFIED` row whose evidence someone paid to obtain.
 *
 * Applied ONLY when the union actually overflows. `evidenceFirst` is stable within each
 * tier, but reordering a note that fits would reshuffle rows for no benefit — the same
 * fits-vs-overflows split `upsertOntoPrior` already makes on the carry-note write path.
 * This is the checkpoint-tool half of that established rule, reached now that an
 * over-cap prior normalizes on write instead of refusing (EI-21534719386975911).
 */
function orderCarriedForUnion<
  T extends { id?: string; claim: string; verified?: string; observed?: string; contested?: string },
>(
  supplied: ReadonlyArray<{ id?: string; claim: string }>,
  prior: ReadonlyArray<T>,
): ReadonlyArray<T> {
  const unionKeys = new Set(
    [...supplied, ...prior].filter((row) => (row.claim ?? '').trim().length > 0).map((row) => carryRowKey(row)),
  );
  return unionKeys.size > CARRY_NOTE_MAX_CHECKS ? evidenceFirst(prior) : prior;
}

type AppendChecksOverflowRow = {
  id?: string;
  claim: string;
  recheck?: string;
  falsifier?: string;
  verified?: string;
  observed?: string;
  contested?: string;
  sinceMs?: number;
};

type AppendBodyOverflowDiagnostics = {
  carriedProseChars: number;
  carriedCheckRowChars: number;
  submittedAppendChars: number;
  remainingCapacityChars: number;
};

/**
 * Keep the append-body refusal honest about WHICH bytes consume the cap.
 * `priorLength` is the whole stored carry note; it is not the check-row
 * section's length. The checks-section delta includes its heading/legend and
 * canonical separators, matching the bytes the renderer must preserve.
 */
function appendBodyOverflowDiagnostics(
  priorNote: string | null,
  priorLength: number,
  submittedAppend: string,
): AppendBodyOverflowDiagnostics {
  const carriedProse = splitCarryNoteChecks(priorNote).body;
  const carriedCheckRowChars = Math.max(0, priorLength - carriedProse.length);
  return {
    carriedProseChars: carriedProse.length,
    carriedCheckRowChars,
    submittedAppendChars: submittedAppend.trim().length,
    remainingCapacityChars: Math.max(0, CHECKPOINT_CAP - priorLength),
  };
}

/**
 * Merge an additive checks write without evicting carried rows.
 *
 * A body-bearing checkpoint write must not be rejected merely because its optional
 * checks cannot all fit, and it must not buy space by deleting predecessor evidence.
 * Existing rows are still updated in place; genuinely new rows use only vacant slots.
 * The remainder is returned verbatim enough for the response to say what did not land.
 */
function mergeChecksPreservingCarried(
  prior: ReadonlyArray<AppendChecksOverflowRow>,
  supplied: ReadonlyArray<AppendChecksOverflowRow>,
  nowMs: number = Date.now(),
): { merged: AppendChecksOverflowRow[]; notRetained: AppendChecksOverflowRow[] } {
  let merged = [...prior];
  const notRetained: AppendChecksOverflowRow[] = [];

  for (const row of supplied) {
    const patched = patchExistingCheckEntries([row], merged, nowMs);
    if (patched !== null) {
      merged = patched;
      continue;
    }
    if (merged.length >= CARRY_NOTE_MAX_CHECKS) {
      notRetained.push(row);
      continue;
    }
    merged = normalizeCheckEntries([...merged, row], merged, nowMs);
  }

  return { merged, notRetained };
}

/**
 * Make enough room for a concise append body when a legacy note's carried checks
 * already consume the whole checkpoint cap.
 *
 * The normal append path trims superseded prior narrative bytes from the tail, which
 * preserves the old baseline and the new addendum. That cannot help when the CHECKS
 * section alone is over-cap:
 * there is no room left for any body, so appendBodyPreservationGuard would refuse
 * the write and strand progress indefinitely. Legacy rows predate today's field and
 * row caps, so bound their fields first, then evict the cheapest-to-reproduce rows
 * from the tail until the submitted body fits. Callers are told about any row loss
 * through the existing checksDropped channel, and the transform never drops a row
 * merely because a normal within-cap append needs old narrative trimming.
 */
function fitChecksForAppendBody(
  body: string,
  checks: ReadonlyArray<AppendChecksOverflowRow>,
): {
  merged: AppendChecksOverflowRow[];
  dropped: AppendChecksOverflowRow[];
  truncatedFields: number;
} {
  const repairs: CarryArgRepair[] = [];
  const bounded = checks.map((row, i) => {
    const out = { ...row };
    out.claim = truncateCarryField(out.claim, CARRY_ROW_SOFT_CAPS.claim, `carriedChecks[${i}].claim`, repairs);
    if (typeof out.recheck === 'string') {
      out.recheck = truncateCarryField(
        out.recheck,
        CARRY_ROW_SOFT_CAPS.recheck,
        `carriedChecks[${i}].recheck`,
        repairs,
      );
    }
    if (typeof out.falsifier === 'string') {
      out.falsifier = truncateCarryField(
        out.falsifier,
        CARRY_ROW_SOFT_CAPS.falsifier,
        `carriedChecks[${i}].falsifier`,
        repairs,
      );
    }
    if (typeof out.verified === 'string') {
      out.verified = truncateCarryField(
        out.verified,
        CARRY_ROW_SOFT_CAPS.verified,
        `carriedChecks[${i}].verified`,
        repairs,
      );
    }
    if (typeof out.observed === 'string') {
      out.observed = truncateCarryField(
        out.observed,
        CARRY_ROW_SOFT_CAPS.observed,
        `carriedChecks[${i}].observed`,
        repairs,
      );
    }
    if (typeof out.contested === 'string') {
      out.contested = truncateCarryField(
        out.contested,
        CARRY_ROW_SOFT_CAPS.contested,
        `carriedChecks[${i}].contested`,
        repairs,
      );
    }
    return out;
  });

  let merged = bounded;
  if (withCarryNoteChecks(body, merged).length <= CHECKPOINT_CAP) {
    return { merged, dropped: [], truncatedFields: repairs.length };
  }

  // Put evidence-bearing rows first only when the cap actually bites; stable
  // ordering within each tier keeps ordinary notes from churning.
  merged = evidenceFirst(merged);
  const dropped: AppendChecksOverflowRow[] = [];
  while (merged.length > 0 && withCarryNoteChecks(body, merged).length > CHECKPOINT_CAP) {
    dropped.push(merged.pop()!);
  }

  return { merged, dropped: dropped.reverse(), truncatedFields: repairs.length };
}

/**
 * Return the exact PRIOR check rows that the additive normalizer would evict.
 *
 * This deliberately mirrors the transform rather than deriving victims from the
 * overflow count: `carryRowKey` is identity, supplied rows are ordered first when
 * the union overflows, and `normalizeCheckEntries` applies the same telemetry and
 * cap rules as the eventual write. The prior note is read by the store under its
 * lock before this guard runs, so the result describes the row set the refused
 * write actually would have changed.
 *
 * The result is bounded for legacy notes that predate the current row cap. Normal
 * notes can evict at most the carried tail; the bound keeps an unexpectedly large
 * legacy note from turning a refusal into an unbounded response.
 */
function appendChecksOverflowRows(
  priorNote: string | null,
  suppliedChecks: ReadonlyArray<{
    id?: string;
    claim: string;
    replaces?: string;
    recheck?: string;
    falsifier?: string;
    sampleAdequate?: boolean;
    verified?: string;
    observed?: string;
    contested?: string;
    sinceMs?: number;
  }>,
): AppendChecksOverflowRow[] {
  if (suppliedChecks.length === 0) return [];
  const refs = resolveCarryRowRefs({
    priorWalls: [],
    priorChecks: splitCarryNoteChecks(priorNote).checks,
    checks: suppliedChecks,
  });
  const priorChecks = refs.priorChecks;
  const resolvedChecks = refs.checks ?? [];

  // An all-existing keyed refresh is patched in place and deliberately preserves
  // over-cap legacy rows, so it cannot produce an additive-cap eviction.
  if (patchExistingCheckEntries(resolvedChecks, priorChecks) !== null) return [];

  const merged = normalizeCheckEntries([...resolvedChecks, ...priorChecks], priorChecks);
  const keptKeys = new Set(merged.map((row) => carryRowKey(row)));
  const evicted = priorChecks.filter((row) => row.claim.trim().length > 0 && !keptKeys.has(carryRowKey(row)));

  return evicted.slice(0, CARRY_NOTE_MAX_CHECKS * CARRY_CAP_HARD_MULTIPLE).map((row) => {
    const id = sanitizeCarryRowId(row.id);
    const recheck = row.recheck?.trim();
    const falsifier = row.falsifier?.trim();
    const verified = row.verified?.trim();
    const observed = row.observed?.trim();
    const contested = row.contested?.trim();
    return {
      ...(id ? { id } : {}),
      claim: row.claim.trim(),
      ...(recheck ? { recheck } : {}),
      ...(falsifier ? { falsifier } : {}),
      ...(verified ? { verified } : {}),
      ...(observed ? { observed } : {}),
      ...(contested ? { contested } : {}),
      ...(row.sinceMs !== undefined && Number.isFinite(row.sinceMs) ? { sinceMs: row.sinceMs } : {}),
    };
  });
}

/**
 * EI-18665443723911343: the single-shorthand `append`/`confirmShrink` booleans were
 * observed rejecting a caller-supplied `true`/`false` STRING ("expected boolean,
 * received string") on the exact same tool call shape that accepts a real boolean —
 * while the identical value sent through `items:[{ ... }]` parsed fine. Rather than
 * chase the intermittent string-vs-boolean arrival (client/transport serialization,
 * outside this tool's control) at its source, make the shorthand booleans tolerant of
 * their own literal string form: a plain `z.coerce.boolean()` is NOT safe here (JS
 * `Boolean("false")` is `true` — it would silently invert a caller's explicit
 * `"false"`), so this preprocesses ONLY the exact strings `"true"`/`"false"` to their
 * boolean value and leaves every other input (including a real boolean, or a typo'd
 * string) to fail the normal boolean check untouched.
 */
function looseBoolean() {
  return z.preprocess((v) => {
    if (v === 'true') return true;
    if (v === 'false') return false;
    return v;
  }, z.boolean().optional());
}

/** WI-42106: an unconfirmed replace computed, under the store lock, that it
 * would retire carried check rows. Throwing from the transform aborts the
 * transaction before the new carry-note can be stored. */
class ReplaceWouldDropError extends Error {
  constructor(readonly droppedChecks: string[], readonly retireIdsRequired = false) {
    super('checkpoint_replace_would_drop_rows');
  }
}

/** EI-21923095696933477: `retireIds` opt-in — the caller names exactly which
 * carried rows they intend to retire, so an unlisted stored row can never be
 * dropped by omission (unlike a blind `confirmRetire:true`, which retires
 * whatever the store computes with no cross-check against what the caller
 * actually saw). Thrown from the transform, same as ReplaceWouldDropError,
 * when the supplied set disagrees — in either direction — with what a plain
 * `rowsMode:'replace'` write would actually drop. */
class RetireIdsMismatchError extends Error {
  constructor(
    readonly requested: string[],
    readonly actual: string[],
  ) {
    super('checkpoint_retire_ids_mismatch');
  }
}

type FrozenCarryViolationPayload = NonNullable<ReturnType<typeof frozenLineageCarryViolationPayload>>;

/** Thrown from the store's locked transform so the transaction aborts before a
 * final merged checkpoint can preserve an unsafe moving-tip instruction. */
class FrozenCarryCheckpointError extends Error {
  constructor(readonly payload: FrozenCarryViolationPayload) {
    super(payload.error);
  }
}

function frozenWorkItemCarryViolation(text: string | null | undefined): FrozenCarryViolationPayload | null {
  if (!text?.trim()) return null;
  return frozenLineageCarryViolationPayload(
    evaluateFrozenLineageCarryText({
      surface: 'work-item-checkpoint',
      text,
      target: resolveHomeGateVerdictTarget(),
    }),
  );
}

function enforceFrozenWorkItemCarry<T extends string | null | undefined>(text: T, suppliedText?: string): T {
  // `text` may be the locked merge of this write with an older checkpoint. Only
  // the bytes supplied by this call are executable authority; inherited history
  // can contain a legacy directive that the caller is trying to document or retire.
  const violation = frozenWorkItemCarryViolation(suppliedText ?? text);
  if (violation) throw new FrozenCarryCheckpointError(violation);
  return text;
}

/**
 * Hard cap on a stored checkpoint (matches the `checkpoint` arg's max).
 *
 * EI-22659954682164298: now sourced from `carry-note.ts` rather than duplicated
 * here, so the READ side (`work_items:get`'s `checkpointBody`) reports headroom
 * against the same number this writer enforces. A second literal would have let
 * the two drift silently, and the reader's whole job is to be trusted.
 */
const CHECKPOINT_CAP = CHECKPOINT_BODY_CAP_CHARS;
const TRUNCATION_MARKER = '…[older checkpoint content truncated]…\n';

/**
 * Normalize the structured carry-note shape accepted by loop:checkpoint when it
 * arrives in work_items:checkpoint's historical `checkpoint` field. This stays a
 * narrow compatibility envelope: only the four canonical narrative fields and
 * loop:checkpoint's documented aliases are accepted, and strict validation keeps
 * an unrelated object from being silently rendered with data dropped.
 */
const structuredCheckpointSchema = z
  .object({
    did: z.string().max(CHECKPOINT_CAP).optional(),
    left: z.string().max(CHECKPOINT_CAP).optional(),
    insight: z.string().max(CHECKPOINT_CAP).optional(),
    next: z.string().max(CHECKPOINT_CAP).optional(),
    keyInsight: z.string().max(CHECKPOINT_CAP).optional(),
    nextAction: z.string().max(CHECKPOINT_CAP).optional(),
    goal: z.string().max(CHECKPOINT_CAP).optional(),
  })
  .strict();

function normalizeStructuredCheckpoint(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;

  const parsed = structuredCheckpointSchema.safeParse(value);
  if (!parsed.success) return value;

  return renderCarryNote({
    did: parsed.data.did,
    left: parsed.data.left,
    insight: parsed.data.insight ?? parsed.data.keyInsight,
    next: parsed.data.next ?? parsed.data.nextAction ?? parsed.data.goal,
  });
}

/** Shared by the single shorthand and each items[] entry. */
function checkpointBodySpec(): z.ZodType<string | null | undefined> {
  // Keep the structured compatibility shape visible in the published JSON schema.
  // A preprocess around only the normalized string hides its input type from Zod's
  // schema emitter, so MCP rejects the documented object before this normalizer runs.
  return z.preprocess(
    normalizeStructuredCheckpoint,
    z.union([z.string().max(CHECKPOINT_CAP), structuredCheckpointSchema]).nullish(),
  ) as z.ZodType<string | null | undefined>;
}

/**
 * EI-22930559578035772: keep one identity for the compatibility body schema.
 *
 * The shorthand and `items[]` shapes expose the same input contract. Building
 * the preprocess/union twice made Zod serialize the structured carry-note
 * compatibility object twice, adding ~10KB to the published tool schema. A
 * stable metadata id lets Zod place this shared schema in `$defs` and emit a
 * `$ref` at each use while preserving the parser's preprocess behavior.
 */
const checkpointBodySchema = checkpointBodySpec().meta({ id: 'work-items-checkpoint-body-v1' });

/**
 * EI-23125773053698900: `loop:checkpoint` and `work_items:checkpoint` deliberately
 * share the structured carry vocabulary, but only the loop tool accepted that
 * vocabulary at the top level. A caller reusing its already-valid loop payload
 * therefore failed before the work-item handler ran, even when it also supplied a
 * canonical `checkpoint` string. Keep these as compatibility inputs for the SINGLE
 * shorthand: `checkpoint` wins, then `note`, then the structured fields. `workItem`
 * aliases `id` and a disagreement is rejected rather than redirecting the write.
 */
const rootCarryAliasField = z.string().max(CHECKPOINT_CAP).nullish();

/**
 * WI-10005640: `items[]` entries take the SAME carry vocabulary as the single
 * shorthand. Measured 2026-10-02: ~40 `items.N: Unrecognized keys: "did","left",
 * "insight","next"` refusals/48h across ~15 owners — the natural batch shape is
 * the loop carry-note shape, and rejecting it at the entry level made callers
 * discover the `checkpoint:{…}` nesting by failing. Folded per entry with the SAME
 * `checkpointFromRootAliases` as the root (explicit `checkpoint` wins). One
 * `$defs` id keeps the published argSchema (PINNED shrink-only) from growing 7×.
 */
// No `.describe`: compact delivery INLINES $refs (schema-ref-inline.ts), so a description
// here is paid 7x there (+558 B measured). The entry's `checkpoint` description documents it.
const itemCarryAliasField = rootCarryAliasField.meta({ id: 'work-items-checkpoint-carry-alias-v1' });

function checkpointFromRootAliases(args: {
  checkpoint?: string | null;
  note?: string | null;
  did?: string | null;
  left?: string | null;
  insight?: string | null;
  next?: string | null;
  keyInsight?: string | null;
  nextAction?: string | null;
  goal?: string | null;
}): string | null | undefined {
  if (args.checkpoint !== undefined) return args.checkpoint;
  if (args.note !== undefined) return args.note;
  if (
    [args.did, args.left, args.insight, args.next, args.keyInsight, args.nextAction, args.goal].every(
      (value) => value === undefined || value === null,
    )
  ) {
    return undefined;
  }
  return renderCarryNote({
    did: args.did ?? undefined,
    left: args.left ?? undefined,
    insight: args.insight ?? args.keyInsight ?? undefined,
    next: args.next ?? args.nextAction ?? args.goal ?? undefined,
  });
}

/**
 * EI-23074991388482969: some transports materialize an omitted optional string as
 * an empty string. `contentHash` is ignored for ordinary writes and is already
 * checked as missing by the attestation branch, so a blank value must follow the
 * omitted path instead of failing the hash-length validation before the handler.
 * Preserve the minimum length requirement for actual hashes.
 */
function contentHashSpec() {
  return z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().min(6).max(64).optional(),
  );
}

/**
 * P-013 compatibility: `rowsMode` controls only supplied check rows. The
 * default is merge so a subset update cannot silently retire carried rows;
 * explicit `replace` remains the retirement path. `merge` makes an additive
 * check update without also appending the body.
 */
function rowsModeSpec() {
  return z
    .enum(['replace', 'merge'])
    .optional()
    .describe(
      'P-013: how supplied `checks` rows are applied. `merge` (default) unions ' +
        'supplied rows onto the carried set, so an incremental check update cannot drop unmentioned rows. `merge` + ' +
        '`checks:[]` is a no-op; use explicit `replace` + `checks:[]` to clear rows. This controls CHECK ROWS only, ' +
        "and `retireIds` is rejected unless `rowsMode:'replace'` is explicit — it is never silently ignored on a merge. " +
        "never the checkpoint body. With `append:true` + `rowsMode:'replace'`, row retirement requires exact `retireIds`, " +
        "even with `confirmRetire:true`. A full authoritative body+rows replacement is `append:false, rowsMode:'replace', " +
        'confirmShrink:true, confirmRetire:true`. Without confirmShrink, a >50% body shrink is auto-preserved and its ' +
        'checks become additive; without confirmRetire, omitted carried checks are refused before write. Prefer ' +
        '`retireIds` over a blind `confirmRetire:true` when your view of the carried set may be an excerpt.',
    );
}

/**
 * EI-21923095696933477: an opt-in, STRONGER alternative to `confirmRetire`. A
 * caller whose view of the carried set is an excerpt (a post-compaction carry
 * document renders only a bounded prefix) can pass `confirmRetire:true` and
 * retire rows it never actually read — the incident this exists to prevent
 * lost the only record of where a credential came from this way. Naming
 * exactly which carried rows to retire makes that structurally impossible:
 * the write refuses, before anything is stored and regardless of
 * `confirmRetire`, unless this set EXACTLY matches what the replace would
 * actually drop — naming both a dropped row the caller missed and a supplied
 * id that would not actually have dropped (a stale snapshot).
 */
function retireIdsSpec() {
  return z
    .array(z.string().min(1))
    .max(CARRY_NOTE_MAX_CHECKS * 2)
    .optional()
    .describe(
      "rowsMode:'replace' safety, STRONGER than `confirmRetire` alone (EI-21923095696933477): name exactly the " +
        'carried row `id`s (or claim text for a row with no `id` — the same identity `carryRowKey` uses) you intend ' +
        'to retire. The write refuses — even with confirmRetire:true — unless this set EXACTLY matches what would ' +
        'actually be dropped, naming both any row you missed and any name that would not have dropped, so an ' +
        'unlisted stored row can never be dropped by omission. Use this instead of a blind confirmRetire:true ' +
        "whenever your view of the carried set may be an excerpt (e.g. a post-compaction carry document) rather " +
        'than the full stored list — call work_items:get first for the complete set, or send `rowsMode:"replace"` ' +
        'with neither `confirmRetire` nor `retireIds` to see the full drop list in a refusal before committing to one.',
    )
    .meta({
      'x-papercusp-call-constraint':
        "Requires effective `rowsMode:'replace'`; an `items[]` entry overrides the root setting, and omitted `rowsMode` defaults to `'merge'`.",
    });
}

/** EI-9036: join an addendum onto the prior checkpoint text, bounded to CHECKPOINT_CAP.
 * When the join overflows, retain the oldest prefix of the prior note and the newest
 * addendum, trimming only the superseded prior tail when the addendum fits. If the
 * addendum itself is too large to fit alongside the marker, retain its newest suffix
 * because the helper cannot preserve both complete inputs within the hard cap. */
function joinCheckpoint(prior: string | null, addendum: string): string {
  const separator = prior && prior.length > 0 ? '\n\n---\n' : '';
  const joined = prior && prior.length > 0 ? `${prior}${separator}${addendum}` : addendum;
  if (joined.length <= CHECKPOINT_CAP) return joined;

  // Keep the two semantically valuable ends of the append: the oldest baseline
  // (the beginning of the prior note) and the newest progress (the end of the
  // addendum). Prefer preserving the complete addendum whenever it fits, then use
  // the remaining budget for the prior prefix. The marker stands in for the
  // superseded middle/tail bytes and keeps the loss visible to the successor.
  const contentBudget = Math.max(CHECKPOINT_CAP - TRUNCATION_MARKER.length - separator.length, 0);
  const addendumLength = Math.min(addendum.length, contentBudget);
  const priorLength = Math.min(prior?.length ?? 0, contentBudget - addendumLength);
  const retainedPrior = prior ? prior.slice(0, priorLength) : '';
  const retainedAddendum = addendum.slice(addendum.length - addendumLength);
  return `${retainedPrior}${TRUNCATION_MARKER}${separator}${retainedAddendum}`;
}

/**
 * EI-21472322403787688: the AUTO-preservation retry's join — newest-FIRST.
 *
 * When a concise deliberate replacement trips the >50% shrink guard, the
 * automatic retry preserves the prior history instead of executing the loss.
 * Joining it old-first (`PRIOR --- NEW`) buried the caller's fresh note at the
 * TAIL while `storedHead` — and every head-reading consumer (cold-wake
 * excerpts, recovery folds) — showed the superseded prior: the current
 * authority was structurally the LEAST visible bytes of the note. Explicit
 * `append:true` keeps its chronological old-first contract ({@link joinCheckpoint});
 * only this system transform flips, because its purpose is precisely "history
 * preserved BELOW, present authoritative ABOVE". No cap logic here by design:
 * the shared render-cap branch owns trimming, direction-conditioned on
 * `shouldAppendRefresh`.
 */
function joinCheckpointNewestFirst(freshBody: string, priorBody: string | null): string {
  return priorBody && priorBody.length > 0 ? `${freshBody}\n\n---\n${priorBody}` : freshBody;
}

// P-007/D-013: the declared-dependency arg, shared by the single shorthand and
// `items[]` — and, since EI-19470389781357111, by `loop:checkpoint` too. The spec
// lives in `freshness/tool-schema` so the supported-kinds list has ONE author (the
// resolver registry) rather than a prose copy per tool.

/**
 * EI-19298690705878336: the verified-vs-asserted marking, reused from the SAME
 * `carry-note` machinery `loop:checkpoint` already exposes — deliberately not a
 * second, drifting notion of what a carried claim is.
 *
 * The gap this closes: a work-item checkpoint could carry a confident factual
 * claim with no way to mark whether it had been VERIFIED or merely predicted, and
 * the checkpoint re-injects on every subsequent invocation of the item in the
 * author's own voice. A wrong claim therefore reads as better-established on each
 * re-read rather than more suspect. Root incident: an assertion about a plan
 * item's scope survived FIVE consecutive wakes, was restated each time, and was
 * refuted by a single query nobody ran because nothing said it was unverified.
 *
 * That surface matters more here than on the loop note: a loop note is read by the
 * author's own next wake, whereas a work-item checkpoint is what an unrelated
 * SUCCESSOR inherits — the reader least able to tell an asserted claim from a
 * checked one.
 */
// normalizeFlattenedContinuityProbeRow (EI-21631530729522909) now lives in
// ../../carry-note, SHARED with loop:checkpoint (EI-21922421392042550) — see
// its docstring there for why this must not be a second, drifting copy.

function checksSpec() {
  return z
    .preprocess(
      // EI-20225599906531988: callers commonly send the compatibility shape
      // `{ claim, recheck, verified: true|false }`. Normalize it before Zod sees the
      // row so the whole checkpoint is not rejected; `true` only becomes VERIFIED
      // when an accompanying evidence string exists, while false/evidence-free true
      // remain PREDICTED. This is the same lossless repair used by loop:checkpoint.
      (v) =>
        Array.isArray(v)
          ? v.map((row, i) => coerceCarryRowShape(normalizeFlattenedContinuityProbeRow(row), `checks[${i}]`, []))
          : v,
      z
        .array(
          z.object({
            // EI-19400299440742193: these are SANITY BACKSTOPS, not the real limits. The
            // real caps (CARRY_ROW_SOFT_CAPS) are enforced by TRUNCATION in the handler.
            // A zod `.max()` rejects the WHOLE CALL, so a `recheck` a few chars over 300
            // used to discard the entire accompanying multi-KB checkpoint and the agent
            // re-sent it — the bytes paid twice, and, worse, an item could be left with NO
            // durable state at the moment its session ended. Measured over a 6-day window:
            // 6 of the 9 schema rejections on this tool were exactly this, 32,967 chars.
            // Same fix as WI-7264 landed for loop:checkpoint, reusing its helpers.
            //
            // P-013 parity: `id` is the SAME schema loop:checkpoint's rows use (see
            // ../_carry-row-id). The storage/merge/render layer below already keyed
            // rows by it (`carryRowKey`), so only this strict schema was rejecting it
            // — the same payload was valid on one carry surface and `invalid_args` on
            // the other, which is also what made coerceCarryRowShape's key -> id
            // repair inert here.
            id: CARRY_ROW_ID_SCHEMA,
            // P-025: re-word an id-less carried check as a one-row keyed update at the
            // cap. Shared with loop:checkpoint so both carry surfaces accept the same
            // [#id] or exact-claim reference and preserve the target's evidence/age.
            replaces: CARRY_ROW_REPLACES_SCHEMA,
            claim: carryRowTextSchema(CARRY_ROW_SOFT_CAPS.claim, 'The claim about external state, stated concretely.', {
              min: 1,
            }),
            // `sinceMs` is stamped and preserved by the shared carry-note normalizer. Keep it
            // in the published row schema as well as the internal type so clients can submit
            // an explicit age anchor without being rejected before that normalizer runs.
            sinceMs: z
              .number()
              .finite()
              .optional()
              .describe('Optional epoch-millisecond timestamp for when this claim began standing.'),
            recheck: carryRowTextSchema(
              CARRY_ROW_SOFT_CAPS.recheck,
              'The concrete probe that would falsify the claim.',
            ).optional(),
            // EI-23771449112267271: same contract as loop:checkpoint's `falsifier` /
            // `sampleAdequate` (and facts:assert `falsifier`). Persisted / write-time only
            // respectively; the SHARED normalizer in ../../carry-note owns both semantics.
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
              'The EVIDENCE STRING (what you actually observed). For compatibility, boolean `true`/`false` ' +
                'is normalized before validation: `true` without evidence and `false` both remain ? PREDICTED. ' +
                'Presence of an evidence string renders the row ✓ VERIFIED; omission renders ? PREDICTED, ' +
                'telling a successor to run `recheck` before relying on the claim.',
            ).optional(),
            observed: carryRowTextSchema(
              CARRY_ROW_SOFT_CAPS.observed,
              'Observed context that does not affirm the claim. It renders on a ? PREDICTED row so the context survives without acquiring verification authority.',
            ).optional(),
            // EI-22575327388783364: completion records call this evidence field
            // `testResult`. Publish the compatibility spelling because clients may
            // validate the nested row before the shared preprocessor maps it to
            // canonical `verified`.
            testResult: carryRowTextSchema(
              CARRY_ROW_SOFT_CAPS.verified,
              'Compatibility alias for completion-style `testResult`; normalized to the canonical `verified` evidence string before storage. Prefer `verified`.',
            ).optional(),
            ok: z
              .boolean()
              .optional()
              .describe(
                'Compatibility alias for boolean check results: `{ ok: true|false }` is normalized to the `verified` evidence slot before storage. ' +
                  'A bare true or false remains PREDICTED; pair true with `evidence` to render VERIFIED. Prefer the canonical `verified` evidence string.',
              ),
            // EI-21234745917984459 — the SAME class as the `id` gap above, one field over.
            // `contested` was already supported end to end: CARRY_ROW_SOFT_CAPS.contested
            // exists, normalizeCheckEntries (imported from ../../carry-note, the SAME
            // normalizer loop:checkpoint uses) already reads `verified ?? contested` and
            // re-emits it, and the renderer already prints ⚠ CONTESTED. ONLY this strict
            // schema rejected it, so the identical payload was valid on one carry surface
            // and `invalid_args` on the other — and the caller's only route to the
            // CONTESTED tier here was to smuggle a magic phrase ("STILL RUNNING") through
            // `verified` and rely on findVerificationConflict's auto-downgrade, which is
            // implicit where the sibling is explicit.
            contested: carryRowTextSchema(
              CARRY_ROW_SOFT_CAPS.contested,
              'Evidence that was supplied as verification but contradicts it (for example, "STILL RUNNING"). ' +
                'Rendered with ⚠ CONTESTED and never upgraded to VERIFIED; re-check before relying on the claim.',
            ).optional(),
            probe: continuityProbeSchema
              .optional()
              .describe(
                'Optional schema-versioned, read-only executable probe. Validated against the live tool/cell contract before any checkpoint bytes persist; use `schemaRevision:"live"` as a writer-only shorthand for the current target revision; persisted probes retain the concrete revision; `recheck` remains the human explanation.',
              ),
            // EI-21631530729522909: the preprocessor above lifts these
            // flattened executable-probe fields into `probe`. They must still
            // be present in the published row schema because some clients
            // validate the manifest before invoking the server-side parser.
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
        .max(CARRY_NOTE_MAX_CHECKS),
    )
    .optional()
    .describe(
      'Carried CHECKS — claims about EXTERNAL state paired with the probe that falsifies them, rendered as a ' +
        '`## Checks` section every time this checkpoint is re-injected. Put hash/id/timestamp/state expectations ' +
        'HERE rather than in checkpoint prose, so the probe travels with the claim and a successor can tell an ' +
        'ASSERTED claim from a VERIFIED one. Carry-forward semantics: OMITTED preserves the existing rows (a ' +
        "plain rewrite never silently drops them) and [] clears them. With `append: true` or `rowsMode:'merge'` a supplied list is " +
        `UNIONED onto the carried set (supplied wins on matching claim text), but capped at ` +
        `${CARRY_NOTE_MAX_CHECKS}: an unconfirmed checks-only overflow refuses atomically before it can drop rows; ` +
        '`confirmRetire:true` explicitly permits the cap eviction and reports the dropped carried rows. A body-bearing ' +
        'append/merge still stores the body and every carried row, admits supplied rows only into vacant slots, and ' +
        'returns `checksNotRetained`/`checksNotRetainedRows` for supplied rows that did not fit. Retire stale rows with ' +
        'a plain replace first, or append without `checks` to leave the carried set untouched. ' +
        "WITHOUT append, `rowsMode:'merge'` (the default) unions the supplied list with the carried set; use explicit " +
        "`rowsMode:'replace'` to send the FULL set you want stored, because any stored claim you leave out is DROPPED — " +
        'that is how you RETIRE a stale check. A supplied ' +
        "row whose claim text matches a stored one inherits that row's recheck/verified/contested/sinceMs when " +
        'you omit them, so re-sending a claim never loses its evidence. Supplying `verified` clears an inherited ' +
        '`contested` and vice versa — they are two renderings of ONE evidence slot, not independent fields — and ' +
        'under merge, use `replaces` with the carried row id or exact old claim to re-word an id-less row at the cap ' +
        'without treating it as a new addition. Unmatched refs are reported and treated as additions. ' +
        'evidence that contradicts itself (for example "STILL RUNNING") is auto-downgraded to ⚠ CONTESTED rather ' +
        'than rendering as ✓ VERIFIED. Rows dropped come back as `checksDropped`; additive-cap refusals also include the exact stored rows as `checksDroppedRows` with sanitized ids. A bare string row is accepted as shorthand for `{ claim: <that string> }`.',
    );
}

/** EI-22930559578035772: the checks/probe compatibility tree is shared by the
 * shorthand and `items[]` forms so the published schema carries it once. */
const checksSchema = checksSpec().meta({ id: 'work-items-checks-v1' });

/**
 * P-017 (effort-scoped-continuity-2026-09-02, D-007/D-009): the durable half of a
 * checkpoint, posted to a THREAD in the same round-trip.
 *
 * A checkpoint is PRIVATE working state on a replace-on-write row. A lesson worth
 * outliving this item's next holder belongs on an append-only, multi-author,
 * attributed, federated surface — the object's own thread. One optional field means
 * curation stays with the agent that holds the context, at zero extra round-trip.
 *
 * ⚠ THIS IS NOT A PROMOTION FIELD (D-009 deleted that). Nothing is copied or lifted
 * between levels. The writer names the level the insight actually belongs to and it is
 * written there once; a plan read includes it because a plan's history contains its own
 * posts. Do not add a corrective for mis-levelled notes — D-009 leaves that open
 * deliberately, and a mis-levelled note still reads at its own level and still rolls up.
 */
function learnedSpec() {
  return z
    .string()
    .max(4000)
    .optional()
    .describe(
      'a durable lesson to post on the effort thread in this same call — the part of your note a future ' +
        'claimant needs. Defaults to this work-item; pass learnedLevel to attach it where it belongs.',
    );
}

function learnedLevelSpec() {
  return z
    .enum(['work_item', 'plan', 'goal'])
    .optional()
    .describe(
      "which level `learned` belongs to — write at the level you are working at. Default 'work_item' " +
        '(the level 94% of items have); a level this item lacks falls back to the most specific one it has.',
    );
}

const itemSpec = z.object({
  id: z.string().min(1).describe('the work-item id to checkpoint'),
  /** The compressed in-flight state. Null ⇒ CLEAR the checkpoint.
   *  Omission is allowed only alongside `checks`, `dependsOn`, `learned`, or
   *  `learnedLevel`, which are metadata-only patches that preserve the stored body
   *  (EI-19447043119380534, EI-20232161144151845), or alongside `clear:true`.
   *  Blank strings require
   *  confirmClear:true (EI-21020695928840897). */
  checkpoint: checkpointBodySchema.describe(
    'compressed in-flight state; null or clear:true ⇒ clear; omission requires `checks`, `dependsOn`, `learned`, or `learnedLevel` as a metadata-only patch; blank string requires confirmClear:true; accepts the structured { did, left, insight, next } carry-note shape and loop aliases',
  ),
  did: itemCarryAliasField,
  left: itemCarryAliasField,
  insight: itemCarryAliasField,
  next: itemCarryAliasField,
  clear: looseBoolean().describe(
    'explicitly clear the checkpoint body. Equivalent to checkpoint:null and rejected with a non-blank checkpoint.',
  ),
  confirmClear: looseBoolean().describe(
    'EI-21020695928840897: authorize a blank-string checkpoint clear. Without this, checkpoint:"" (or whitespace-only text) is rejected before the store is touched.',
  ),
  harness: z
    .string()
    .max(80)
    .optional()
    .describe('per-item harness (else the batch `harness` default / ctx / item lookup)'),
  append: looseBoolean().describe(
      'EI-9036: append `checkpoint` onto the EXISTING stored checkpoint (joined with `---`) instead of replacing it; ' +
      'supplied `checks` are UNIONED onto the carried set (EI-19944669306930709; `rowsMode:\'replace\'` replaces check rows only). ' +
      'No `checkpoint` + `checks` = additive body-preserving patch; otherwise a non-blank `checkpoint` is required ' +
      '(append + clear is rejected). Bounded to the 32000-char cap (superseded prior tail is trimmed first). ' +
      `Checks beyond the ${CARRY_NOTE_MAX_CHECKS}-row cap are reported; an unconfirmed checks-only overflow refuses, \`confirmRetire:true\` permits it.`,
  ),
  confirmShrink: looseBoolean().describe(
    'EI-18140632570924965: a plain replace (no append) that would shrink a substantial prior checkpoint by ' +
      'more than half is auto-preserved BENEATH your note (newest-first — your text stays the visible head). ' +
      'Pass true to confirm a destructive replacement.',
  ),
  rowsMode: rowsModeSpec(),
  confirmRetire: looseBoolean().describe(
    "rowsMode:'replace' safety (WI-42106) and merge-cap consent (EI-22489206594122743): if supplied checks would RETIRE carried rows, or a merge would evict carried rows at the cap, refuse before writing unless true. The refusal names every affected claim.",
  ),
  retireIds: retireIdsSpec(),
  dependsOn: dependsOnSpec(),
  checks: checksSchema,
  learned: learnedSpec(),
  learnedLevel: learnedLevelSpec(),
  unchanged: looseBoolean().describe(
    'P-007/R-06: ATTEST the stored checkpoint is still current instead of rewriting it (refreshes freshness, ' +
      'body byte-identical). REQUIRES `contentHash` (from a prior write\'s result or work_items:get); mutually ' +
      'exclusive with checkpoint/clear/append/checks/dependsOn. BOUNDED: refuses with attestation_hash_mismatch, ' +
      'attestation_state_changed (item row moved after the body) or attestation_exhausted (chain/age budget spent) ' +
      '— then write a real checkpoint; a genuine write resets the budget.',
  ),
  contentHash: contentHashSpec().describe(
      'The stored checkpoint hash you are attesting to (the `contentHash` a prior write returned). Required with ' +
        '`unchanged:true` and ignored otherwise. Binds the attestation to a body you have actually read, so a ' +
        'checkpoint someone else replaced fails the check instead of being silently re-blessed.',
    ),
});

// EI-21035020852712365: a terminal work-item is no longer an active work lane.
// Keep the legacy spellings here because work_items:get may expose an older alias
// on rows written before the unified lifecycle state was introduced.
const TERMINAL_WORK_ITEM_STATES = new Set(['passed', 'deprecated', 'resolved', 'closed', 'done', 'dropped']);

export default defineTool({
  name: 'work_items:checkpoint',
  profile: 'engineer',
  description:
    'Write or clear work-item checkpoints. ' +
    'Single: `{ id, checkpoint? }`; many: `items:[{ id, checkpoint?, harness? }]`. ' +
    'Checkpoints preserve successor continuity across task boundaries; replace-on-write by default, `append:true` joins prior text. ' +
    // EI-20218215840085630: this clause used to read "block suspicious shrink",
    // which has been false since EI-20232176364474286 taught the tool to RETRY a
    // refused plain shrink as a safe append. The accurate statement lived only in
    // `guidance.returns`, which is NOT delivered in the schema a caller loads — so
    // the one surface every caller does get asserted the opposite of the behavior,
    // exactly at the context boundary where a concise checkpoint is written. Worse
    // than a stale doc: "blocked" plus the full-replacement recipe below invites a
    // pre-emptive `confirmShrink:true`, which DISCARDS the prior history the retry
    // would have preserved. State the behavior positively instead.
    'Writes verify-read; a big shrink keeps prior under your note; peer-held/terminal-item writes are refused while explicit clears remain allowed. ' +
    // P-011: the `absenceLint` sentence that used to sit here was a verbatim
    // duplicate of the `guidance.returns` line below, and `returns` is NOT counted
    // against the 1500-char prompt budget while `description` is. Dropping the copy
    // cleared a 15-char overage at zero cost to the reader — response documentation
    // belongs in `returns`, demand-loaded via tools:find rather than baked into
    // every system prompt (the WI-9334 move).
    '`rowsMode:"merge"` adds check rows while replacing the body; `"replace"` retires rows. ' +
    'Full body+rows replacement requires `append:false, rowsMode:"replace", confirmShrink:true, confirmRetire:true`.',
  guidance: {
    when:
      'At a task boundary or on graceful eviction, before you finish/yield: persist what a successor needs — ' +
      'done, left, approach, gotchas. A digest, not a transcript. Declare `dependsOn` for freshness. ' +
      'Unmeasured claims use `checks:[{claim,recheck}]` (? PREDICTED without `verified`). ' +
      '`checks[].probe` requires a target: `{kind:\'tool\',tool:\'<read-only>\',args:{...},schemaRevision:\'live\',expect:{...}}` or ' +
      '`{kind:\'state-cell\',cell:\'<cell>\',schemaRevision:\'<revision>\',expect:{...}}`; `args` defaults to `{}`. ' +
      '`probe:{expect:...}` has no target—omit it and use `recheck`.',
    notWhen:
      'Not mid-task scratch, file/tool output, or an edit channel: use `work_items:update`; peer notes use ' +
      '`work_items:comment`. `assumptions` belongs to `work_items:complete`/`set_state`. For a peer item, claim or comment.',
    chaining:
      'Before `work_items:complete`/yield; clear with `checkpoint:null` or `clear:true`. ' +
      'Also a liveness pulse during long local-only work.',
    returns:
      'Returns { ok, results:[{ ok, id, harness, cleared, length, contentHash, verified, storedHead, by | error }], counts }. ' +
      'A body that asserts a missing surface without a matching stored check returns `absenceLint { flagged, claims }`; the write is kept. ' +
      'Repo-relative paths named in checkpoint prose are resolved through the same file resolver as `dependsOn`; explicit null tokens return `prosePathLint { flagged, paths, note }`, advisory only. ' +
      'A body reporting a run you LAUNCHED BUT HAVE NOT READ (in-flight wording plus a log/bash_id reference) while storing no check rows ' +
      'returns `unreadRunLint { flagged, note, signals }` — pass `checks:[{ claim, recheck }]` and OMIT `verified` so the row renders ' +
      '? PREDICTED and your successor re-measures instead of trusting the prose; any stored check row suppresses it. Advisory, never a refusal. ' +
      'Every write is verify-read: a suspicious shrink is retried as a safe append, a disagreeing append is BLOCKED, ' +
      'and every refusal carries `errorCode` + recovery args. ' +
      'A non-clear write to a terminal item is refused with `errorCode:"terminal_item"`; reopen it explicitly with ' +
      '`work_items:set_state { id, state:"open", force:true }`, then claim it before resuming work. ' +
      'A blocked write carries `errorCode` (`shrink_blocked` / `append_base_unreadable`) plus structured `recovery` args: ' +
      '`append:true` to preserve prior content (also the form for a concise successor addendum to a detailed prior note), ' +
      'or `append:false, rowsMode:"replace", confirmShrink:true, confirmRetire:true` for an intentional full body+rows replacement. ' +
      'A verify-read miss is `checkpoint_verify_failed`. ' +
      'EI-21923095696933477: retiring rows off a carry-document EXCERPT rather than a fresh work_items:get read? ' +
      'Prefer `retireIds` over a blind `confirmRetire:true` — name exactly which carried row ids/claims to drop; ' +
      'the write refuses (`checkpoint_retire_ids_mismatch`, naming both directions of the mismatch) unless that ' +
      'set exactly matches what the replace would actually drop, so an unlisted stored row can never be dropped by omission.',
  },
  capability: 'work_items:write',
  requirePrincipal: false,
  agentRoles: [...WORK_ITEM_LIFECYCLE_ROLES],
  // EI-20193605443762570: this handler owns its DB scopes through its
  // work-item/checkpoint accessors and never reads ctx.tx. Avoid retaining the
  // ambient workspace transaction across those awaits under fleet load.
  skipWorkspaceTx: true,
  args: z
    .object({
      id: z.string().min(1).optional().describe('single shorthand: the work-item id (use with `checkpoint`)'),
      /** The compressed in-flight state. Null ⇒ CLEAR the checkpoint.
       *  Omission is allowed only alongside `checks`, `dependsOn`, `learned`, or
       *  `learnedLevel`, which are metadata-only patches that preserve the stored body
       *  (EI-19447043119380534, EI-20232161144151845), or alongside `clear:true`.
       *  Blank strings require
       *  confirmClear:true (EI-21020695928840897). */
      checkpoint: checkpointBodySchema.describe(
        'single shorthand: compressed in-flight state; null or clear:true ⇒ clear; omission requires `checks`, `dependsOn`, `learned`, or `learnedLevel` as a metadata-only patch; blank string requires confirmClear:true; accepts the structured { did, left, insight, next } carry-note shape and loop aliases',
      ),
      note: z
        .string()
        .max(CHECKPOINT_CAP)
        .nullish()
        .describe('loop:checkpoint compatibility alias for the single shorthand checkpoint; explicit checkpoint wins.'),
      did: rootCarryAliasField.describe('loop:checkpoint compatibility field for the single shorthand checkpoint.'),
      left: rootCarryAliasField.describe('loop:checkpoint compatibility field for the single shorthand checkpoint.'),
      insight: rootCarryAliasField.describe('loop:checkpoint compatibility field for the single shorthand checkpoint.'),
      next: rootCarryAliasField.describe('loop:checkpoint compatibility field for the single shorthand checkpoint.'),
      keyInsight: rootCarryAliasField.describe('compatibility alias for insight; explicit insight wins.'),
      nextAction: rootCarryAliasField.describe('compatibility alias for next; explicit next wins.'),
      goal: rootCarryAliasField.describe('compatibility alias for next; explicit next and nextAction win.'),
      workItem: z
        .string()
        .min(1)
        .max(120)
        .optional()
        .describe('loop:checkpoint compatibility alias for id; when both are set they must identify the same item.'),
      clear: looseBoolean().describe(
        'single shorthand default for `clear`; explicitly clear the checkpoint body (equivalent to checkpoint:null).',
      ),
      confirmClear: looseBoolean().describe(
        'single shorthand default for `confirmClear`; authorize checkpoint:"" or whitespace-only text as an intentional clear.',
      ),
      items: z
        .array(itemSpec)
        .min(1)
        .max(100)
        .optional()
        .describe('checkpoint many work-items at once — each { id, checkpoint?, harness?, append? }'),
      harness: z.string().max(80).optional().describe('default harness for the inline id / items that omit one'),
      append: looseBoolean().describe(
        'single shorthand default for `append` (EI-9036): join `checkpoint` onto the existing stored checkpoint ' +
          'instead of replacing it, and UNION supplied `checks` onto the carried set instead of replacing them ' +
          '(EI-19944669306930709). With `checks` and no `checkpoint`, this is an additive checks-only patch. ' +
          "With explicit `rowsMode:'replace'`, any appended-body write that retires checks requires exact `retireIds`, even with `confirmRetire:true`. " +
          'Also the default applied to any `items[]` entry that omits its own `append`.',
      ),
      confirmShrink: looseBoolean().describe(
        'single shorthand default for `confirmShrink` (EI-18140632570924965), also the items[] default.',
      ),
      rowsMode: rowsModeSpec().describe(
        'single shorthand default for `rowsMode`; also the items[] default. This controls CHECK ROWS only, not the body. ' +
          "`merge` unions supplied checks without appending the body. With `append:true` + `rowsMode:'replace'`, " +
          '`retireIds` are required for any retired row; `confirmRetire:true` alone is not sufficient. A complete body+rows replacement is ' +
          "append:false, rowsMode:'replace', confirmShrink:true, confirmRetire:true.",
      ),
      confirmRetire: looseBoolean().describe(
        "single shorthand default for `confirmRetire`; also the items[] default. For non-append rowsMode:'replace', it authorizes retiring carried checks. With append:true + rowsMode:'replace', exact retireIds are required instead.",
      ),
      retireIds: retireIdsSpec().describe(
        "single shorthand default for `retireIds`; also the items[] default. A STRONGER, opt-in alternative to " +
          "`confirmRetire` (EI-21923095696933477): name exactly the carried row ids/claims a rowsMode:'replace' " +
          'should retire, and the write refuses on any mismatch instead of trusting a blind confirmRetire:true.',
      ),
      checks: checksSchema,
      dependsOn: dependsOnSpec(),
      learned: learnedSpec(),
      learnedLevel: learnedLevelSpec(),
      // P-007/R-06. These MUST exist on the single shorthand, not only on the items[]
      // entry: the whole point of an attestation is the one-item call an agent makes
      // at a compaction boundary, and this object is `.strict()`, so declaring them
      // only on the batch shape makes the documented `{ id, unchanged, contentHash }`
      // call fail Zod validation before the tool body ever runs — a feature that reads
      // as shipped and is unreachable.
      unchanged: looseBoolean().describe(
        'single shorthand default for `unchanged`; also the items[] default. ATTEST that the stored checkpoint ' +
          'is still current instead of rewriting it. Requires `contentHash`. Do not send `checkpoint`, ' +
          '`did`/`left`/`insight`/`next`, `clear`, `append`, `checks`, or `dependsOn` with `unchanged:true`; ' +
          'omit `unchanged` when writing a new body. Conflicting fields return `attestation_conflicting_args`.',
      ),
      contentHash: contentHashSpec().describe(
        'single shorthand default for `contentHash`; also the items[] default. Required with `unchanged`.',
      ),
    })
    .refine((a) => (a.items?.length ?? 0) > 0 || Boolean(a.id) || Boolean(a.workItem), {
      message: 'pass { id, checkpoint? } (workItem aliases id) for one, or items:[{ id, checkpoint? }] for many',
    })
    .refine((a) => !a.id || !a.workItem || a.id.trim().toUpperCase() === a.workItem.trim().toUpperCase(), {
      message: 'id and workItem identify different work-items; pass one identity or make them match',
      path: ['workItem'],
    })
    .refine(
      (a) =>
        !a.items?.length ||
        [a.note, a.did, a.left, a.insight, a.next, a.keyInsight, a.nextAction, a.goal, a.workItem].every(
          (value) => value === undefined,
        ),
      {
        message:
          'root-level loop carry aliases apply only to the single shorthand; with items[] put checkpoint (or did/left/insight/next) on each entry',
        path: ['items'],
      },
    ),
  result: z
    .object({
      ok: z.boolean().optional(),
      results: z.array(z.unknown()).optional(),
      counts: z.unknown().optional(),
    })
    .passthrough(),
  async handler(args, ctx) {
    const ident = resolveAgentIdentity(ctx);
    const c = ctx as { harnessSlug?: string | null; workspaceId?: string | null; spawnId?: string | null };
    const inlineCheckpoint = checkpointFromRootAliases(args);
    const items = args.items?.length
      ? // WI-10005640: fold each entry's own carry aliases (explicit `checkpoint` wins).
        args.items.map((entry) => ({ ...entry, checkpoint: checkpointFromRootAliases(entry) }))
      : [
          {
            id: (args.id ?? args.workItem) as string,
            checkpoint: inlineCheckpoint,
            clear: args.clear,
            confirmClear: args.confirmClear,
            harness: args.harness,
            append: args.append,
            confirmShrink: args.confirmShrink,
            rowsMode: args.rowsMode,
            confirmRetire: args.confirmRetire,
            retireIds: args.retireIds,
            checks: args.checks,
            dependsOn: args.dependsOn,
            learned: args.learned,
            learnedLevel: args.learnedLevel,
            // P-007/R-06: declaring these on the schema is not enough — the shorthand
            // is normalized into a one-entry items[] here, and a field missing from
            // this projection is silently dropped, so the call falls through to the
            // ordinary write path and refuses with `checkpoint_required`. That reads
            // like "you forgot the checkpoint text", which is the opposite of what an
            // attestation is asking for.
            unchanged: args.unchanged,
            contentHash: args.contentHash,
          },
        ];
    const env = await runBulk(
      items,
      async (it) => {
        // `checkpointBodySpec` accepts the structured compatibility object as an
        // input shape, then its preprocess normalizes a valid object to the stored
        // string before this handler runs. `defineTool` types handler arguments from
        // the schema input (so the object union remains visible here); narrow to the
        // parser's output contract before applying string operations below. Invalid
        // structured objects cannot reach the handler because the post-preprocess
        // union rejects them.
        const suppliedCheckpoint = it.checkpoint as string | null | undefined;
        const wantsClear = it.clear ?? args.clear ?? false;
        const wantsConfirmClear = it.confirmClear ?? args.confirmClear ?? false;
        const wantsAppend = it.append ?? args.append ?? false;
        const rawSuppliedChecks = it.checks ?? args.checks;
        const rowsMode = it.rowsMode ?? args.rowsMode ?? 'merge';
        const wantsRetireIds = it.retireIds ?? args.retireIds;
        // EI-23618780798277092: `retireIds` only has meaning for an explicit
        // replace. The default merge path does not retire rows, so accepting this
        // combination would acknowledge the request while silently ignoring the
        // named retirements and leaving the caller's replacement rows at the cap.
        // Reject before lookup/store work so the contradictory shape is visibly
        // actionable and cannot be mistaken for a successful checkpoint write.
        if (it.unchanged !== true && wantsRetireIds !== undefined && rowsMode !== 'replace') {
          return {
            ok: false as const,
            id: it.id,
            error: 'checkpoint_retire_ids_requires_replace',
            errorCode: 'checkpoint_retire_ids_requires_replace',
            retryable: true,
            rowsMode,
            retireIdsRequested: wantsRetireIds,
            message:
              "`retireIds` is only valid with explicit `rowsMode:'replace'`; this call used `rowsMode:'" +
              rowsMode +
              "'`. NOTHING was written. Use `rowsMode:'replace'` to retire the named rows, or omit `retireIds` for an additive merge.",
          };
        }
        // P-017: `learned`/`learnedLevel` are append-only effort-thread metadata,
        // not replacement checkpoint content. A learned-only call must therefore
        // take the same body-preserving route as checks/dependsOn; otherwise the
        // omission guard rejects the call before the lesson can be posted, and the
        // underlying store's omitted-body semantics would be unsafe if it did not.
        const suppliedLearned = it.learned ?? args.learned;
        const suppliedLearnedLevel = it.learnedLevel ?? args.learnedLevel;
        const hasLearnedMetadata = suppliedLearned !== undefined || suppliedLearnedLevel !== undefined;
        // P-007: `dependsOn` is tri-state at the store (undefined ⇒ preserve the
        // existing declaration, [] ⇒ clear, list ⇒ re-stamp), so only forward the
        // key when the caller actually supplied one.
        const declaredDeps = it.dependsOn ?? args.dependsOn;
        if (wantsClear && typeof suppliedCheckpoint === 'string' && suppliedCheckpoint.trim().length > 0) {
          return {
            ok: false as const,
            id: it.id,
            error:
              'clear_with_checkpoint — clear:true contradicts a non-blank `checkpoint`; send the body or clear it, not both.',
            errorCode: 'clear_with_checkpoint',
          };
        }
        if (
          !wantsClear &&
          typeof suppliedCheckpoint === 'string' &&
          suppliedCheckpoint.trim().length === 0 &&
          !wantsConfirmClear
        ) {
          return {
            ok: false as const,
            id: it.id,
            error:
              'empty_checkpoint_requires_confirmation — checkpoint:"" (including whitespace-only text) is not accepted as an implicit clear because extraction mistakes commonly produce an empty string. Use checkpoint:null or clear:true, or retry with confirmClear:true.',
            errorCode: 'empty_checkpoint_requires_confirmation',
            retryable: true,
            recovery: {
              clear: {
                args: { checkpoint: null },
                description: 'Clear unambiguously without relying on an empty extracted string.',
              },
              confirm: {
                args: { checkpoint: suppliedCheckpoint, confirmClear: true },
                description: 'Confirm that this exact blank-string clear is intentional.',
              },
            },
          };
        }
        // EI-220412: the underlying checkpoint store treats an omitted body like an
        // explicit clear. At the tool boundary that is unsafe: a caller sending only
        // `{ id }` can be a read-like probe or a schema-shape mistake, and must not
        // erase a live successor note. Preserve the intentional metadata-only PATCH
        // forms (`checks`/`dependsOn`) and the explicit clear flag; reject every other
        // body-less call before even reading or touching the item.
        // P-007/R-06: an ATTESTATION is body-less BY CONSTRUCTION — that is the whole
        // feature — so it must be exempt here or it never reaches its own branch below
        // and refuses with `checkpoint_required`, which reads as "you forgot the text"
        // to the one caller who deliberately sent none. This is the SECOND place the
        // same shape bites (the first was the single-shorthand projection): a guard
        // written to catch an omitted body cannot tell a mistake from a new intent
        // unless the new intent is named in it.
        if (
          it.unchanged !== true &&
          !wantsClear &&
          suppliedCheckpoint === undefined &&
          !wantsAppend &&
          rawSuppliedChecks === undefined &&
          declaredDeps === undefined &&
          !hasLearnedMetadata
        ) {
          return {
            ok: false as const,
            id: it.id,
            error:
              'checkpoint_required — checkpoint body was omitted. Use checkpoint:null or clear:true to clear intentionally, or supply checks/dependsOn/learned/learnedLevel for a metadata-only patch.',
            errorCode: 'checkpoint_required',
            retryable: true,
            recovery: {
              clear: {
                args: { checkpoint: null },
                description: 'Clear the checkpoint explicitly instead of relying on omission.',
              },
            },
          };
        }
        const checkpoint = wantsClear ? null : suppliedCheckpoint;
        // EI-8805: KEY the checkpoint by the ITEM's OWN harness so the write agrees
        // with the read (work_items:get keys by the resolved item.harness). A
        // harness-null item — an issue-family EI filed from an unscoped su session —
        // must NOT be keyed under the session's harness ('*' or a scoped slug): the
        // read looks it up under the item's own null harness, and the mismatch
        // silently loses the checkpoint. The caller's arg/ctx harness is only a
        // disambiguation HINT for a feature id that repeats across harnesses; the '*'
        // wildcard is not a real harness filter.
        const hint = it.harness ?? args.harness ?? c.harnessSlug ?? undefined;
        const hintHarness = hint && hint !== '*' ? hint : undefined;
        // WI-6746: this pre-read IS the ownership guard below — setWorkItemCheckpoint has
        // no assignee check. Swallowing it to null (the old `.catch(() => null)`) meant a PG
        // fault skipped `not_holder` entirely and the write landed on whatever item it was
        // aimed at, overwriting a peer's in-flight state — the exact corruption
        // EI-18132462898750489 added the guard to stop, and it failed open precisely when
        // the database was unhealthy. Fail CLOSED: unreadable is not unowned.
        const lookup = await lookupWorkItem(it.id, hintHarness);
        if (lookup.status === 'unreadable') {
          return {
            ok: false as const,
            id: it.id,
            error:
              `work_item_unreadable — could not read '${it.id}' to verify you hold it (${lookup.error}). ` +
              "Refusing the checkpoint write rather than risk silently overwriting the real holder's in-flight state. " +
              'This is a READ FAILURE, not a missing item and not a harness-resolution problem — retry, and if it ' +
              'persists check database health (dev:pg_health). Your checkpoint text was NOT saved.',
          };
        }
        const item = lookup.status === 'found' ? lookup.item : null;
        if (!item && !hintHarness) {
          return {
            ok: false as const,
            id: it.id,
            error: `could not resolve a harness for work_item '${it.id}' — pass { harness }`,
          };
        }
        // EI-18132462898750489: refuse a checkpoint write/clear on an item ASSIGNED to
        // someone else. Before this guard the write silently succeeded for anyone, which
        // both corrupted the real holder's in-flight state and gave the writer a false
        // "I must hold this, my checkpoint write succeeded" signal — the confirmed root
        // cause of a false "currently holding" directive surviving into a compaction
        // summary. An unassigned item (assignee null/undefined — about to be claimed, or
        // an older row shape) or one already assigned to the caller is unaffected.
        // EI-21921431863111143: `item.assignee` may be a TRUNCATED prefix of the
        // caller's own ownerId (an upstream dispatch-write bug), which a strict `!==`
        // misreads as a different, live peer — deadlocking the item against its own
        // holder (checkpoint refuses, and work_items:claim's re-claim refuses too).
        // isSelfOwnerRecord treats that prefix the same as an exact match.
        if (item && item.assignee && !isSelfOwnerRecord(item.assignee, ident.ownerId)) {
          return {
            ok: false as const,
            id: it.id,
            error:
              `not_holder — work_item '${it.id}' is assigned to ${item.assignee}, not you (${ident.ownerId}). ` +
              "Checkpointing an item you do not hold would silently overwrite its real holder's in-flight state. " +
              'Leave a note instead with work_items:comment, or work_items:claim it first if you are taking it over.',
          };
        }
        // The item's own harness is authoritative (null for a harness-null item — the
        // store canonicalizes it). Fall back to the hint only when the item can't be
        // resolved (e.g. a not-yet-persisted id).
        const harness: string | null = item ? (item.harness ?? null) : (hintHarness ?? null);
        const workspaceId = resolveConcreteWorkspaceId(c.workspaceId);
        // EI-9036: append:true joins onto the EXISTING checkpoint instead of replacing
        // it — the fix for the "meant to add a short addendum, silently wiped the
        // detailed prior note" trap. append + a blank/omitted checkpoint remains a
        // contradiction (append has nothing to append, and blank normally means
        // CLEAR), except when checks are supplied: that is an additive checks-only
        // patch and must preserve the narrative body.
        const wantsConfirmRetire = it.confirmRetire ?? args.confirmRetire ?? false;
        const isChecksOnlyPatch = checkpoint === undefined && rawSuppliedChecks !== undefined;
        if (wantsAppend && !(checkpoint && checkpoint.length > 0) && !isChecksOnlyPatch) {
          return {
            ok: false as const,
            id: it.id,
            error:
              'append:true requires a non-blank `checkpoint` — append has nothing to append, and blank normally means clear (contradiction).',
          };
        }
        // EI-20232161144151845: dependency stamps are metadata about the stored
        // checkpoint. Callers correcting a dependency must not re-send a shorter
        // transcript just to update that metadata — doing so either risks a
        // shrink_blocked refusal or tempts them to confirm a destructive rewrite.
        // Omitted checkpoint is therefore a dependency-only PATCH, just like the
        // checks-only PATCH below; explicit null/clear:true remains a deliberate clear.
        const isDependencyOnlyPatch = checkpoint === undefined && declaredDeps !== undefined && !wantsAppend;
        const isLearnedMetadataPatch = checkpoint === undefined && hasLearnedMetadata && !wantsAppend;
        const hasCheckpointBody = typeof checkpoint === 'string' && checkpoint.trim().length > 0;
        const hasMetadataPatch =
          checkpoint === undefined &&
          (rawSuppliedChecks !== undefined || declaredDeps !== undefined || hasLearnedMetadata);
        const hasChecksWithExplicitClear =
          typeof checkpoint === 'string' &&
          checkpoint.trim().length === 0 &&
          (rawSuppliedChecks?.length ?? 0) > 0;
        const isActiveCheckpointWrite = hasCheckpointBody || hasMetadataPatch || hasChecksWithExplicitClear;
        // EI-21035020852712365: a terminal item with no live claim can look like an
        // ordinary unassigned item, so the ownership guard above used to let a
        // successor write substantive corrective work onto a row that already read
        // done/dropped. That made the work invisible to claim/lifecycle monitoring:
        // the item stayed terminal and unassigned while a live session edited it.
        // Refuse active writes rather than implicitly reopening and discarding the
        // terminal completion. Explicit clears remain valid for finish cleanup.
        if (
          item &&
          TERMINAL_WORK_ITEM_STATES.has(
            String(item.state ?? '')
              .trim()
              .toLowerCase(),
          ) &&
          isActiveCheckpointWrite
        ) {
          return {
            ok: false as const,
            id: it.id,
            error:
              `terminal_item — work_item '${it.id}' is already terminal ('${item.state}'); ` +
              'non-clear checkpoint writes are refused. Reopen it explicitly with ' +
              "work_items:set_state { id, state: 'open', force: true }, then claim it before resuming work.",
            errorCode: 'terminal_item',
            recovery: {
              reopen: {
                args: { state: 'open', force: true },
                description:
                  'Reopen the terminal item explicitly, then claim it before writing active checkpoint state.',
              },
            },
          };
        }
        // P-007/R-06: the UNCHANGED ATTESTATION branch. Deliberately placed HERE —
        // after the not_holder and terminal_item guards, before any write path — so an
        // attestation is subject to exactly the same authority checks as a real write
        // and can never be a cheaper door into someone else's item.
        if (it.unchanged === true) {
          const contentHash = (it.contentHash ?? '').trim();
          const conflicting = (
            [
              ['checkpoint', it.checkpoint !== undefined],
              ['clear', it.clear === true],
              ['append', it.append === true],
              ['checks', it.checks !== undefined],
              ['retireIds', it.retireIds !== undefined],
              ['dependsOn', it.dependsOn !== undefined],
            ] as const
          )
            .filter(([, present]) => present)
            .map(([name]) => name);
          if (conflicting.length > 0) {
            return {
              ok: false as const,
              id: it.id,
              error:
                `attestation_conflicting_args — \`unchanged:true\` attests that the STORED body is still current, ` +
                `so it writes no text; ${conflicting.join(', ')} would change it. Send the attestation alone, or ` +
                'drop `unchanged` and write the checkpoint you actually mean.',
              errorCode: 'attestation_conflicting_args',
            };
          }
          if (contentHash.length === 0) {
            return {
              ok: false as const,
              id: it.id,
              error:
                'attestation_hash_required — `unchanged:true` requires `contentHash`, the hash of the stored ' +
                'checkpoint you are attesting to. Without it the attestation would be about a body you have not ' +
                "read. Get it from a prior write's `contentHash`, or from work_items:get { id }.",
              errorCode: 'attestation_hash_required',
            };
          }
          let att;
          try {
            att = await attestWorkItemCheckpointUnchanged(
              { harness, workItemId: it.id, workspaceId },
              { contentHash },
            );
          } catch (error) {
            // The work-item adapter uses a bounded transaction for the atomic
            // attestation. Convert both PostgreSQL contention and acquisition
            // deadline failures into the same per-item retryable result as a
            // normal checkpoint write, so a lock wait cannot escape runBulk and
            // become an opaque MCP transport timeout.
            if (error instanceof OrgTxnTimeoutError || error instanceof DbCallDeadlineError) {
              const pgCode = error instanceof OrgTxnTimeoutError ? error.pgCode : undefined;
              return {
                ok: false as const,
                id: it.id,
                error: 'timeout',
                errorCode: 'timeout',
                retryable: true,
                ...(pgCode ? { pgCode } : {}),
                message:
                  `work_items:checkpoint attestation hit transient database contention: ${error.message}. ` +
                  'Checkpoint body was NOT changed; retry shortly.',
              };
            }
            throw error;
          }
          if (att.ok) {
            return {
              ok: true as const,
              id: it.id,
              harness,
              attested: true as const,
              contentHash: att.currentHash,
              attestedCount: att.attestedCount,
              remainingAttestations: att.remainingAttestations,
              bodyAgeMinutes: att.bodyAgeMs === null ? null : Math.round(att.bodyAgeMs / 60_000),
              note:
                `Checkpoint freshness refreshed; body unchanged. ${att.remainingAttestations} attestation(s) ` +
                'left against this body — a real checkpoint write resets the budget.',
            };
          }
          // Every refusal names the remedy, because the whole point of this branch is
          // to stop an agent bouncing at a boundary without knowing what to do next.
          const remedy: Record<string, string> = {
            attestation_no_checkpoint:
              'Nothing is stored for this item, so there is nothing to attest — write a real checkpoint: ' +
              'work_items:checkpoint { id, checkpoint }.',
            attestation_hash_mismatch:
              `The stored checkpoint is ${att.currentHash ?? 'unreadable'}, not ${contentHash} — it changed under ` +
              'you. Re-read it (work_items:get { id }) and either attest the current hash or write a real checkpoint.',
            attestation_state_changed:
              'The work-item row itself moved after this checkpoint body was written, so "unchanged" is not true ' +
              'of it. Write a real checkpoint covering what changed.',
            attestation_exhausted:
              'The attestation budget for this body is spent (chain limit or maximum body age reached). An ' +
              'attestation can defer a flush, never replace one — write a real checkpoint now.',
          };
          const reason = att.refusedReason ?? 'attestation_no_checkpoint';
          return {
            ok: false as const,
            id: it.id,
            error: `${reason} — ${remedy[reason] ?? 'Write a real checkpoint.'}`,
            errorCode: reason,
            storedContentHash: att.currentHash,
            attestedCount: att.attestedCount,
            bodyAgeMinutes: att.bodyAgeMs === null ? null : Math.round(att.bodyAgeMs / 60_000),
          };
        }
        let checkpointToStore = checkpoint;
        // WI-7190: this pre-read is a SEPARATE call (getWorkItemCheckpoint) from the
        // authoritative prior the write transaction reads a few lines below (inside
        // setWorkItemCheckpointWithPrior's own SELECT ... FOR UPDATE). Track what it
        // saw — `appendPriorRaw` (null/failed vs. real content) — so the guard below
        // can catch the two paths disagreeing BEFORE the write commits, instead of
        // silently joining onto nothing and clobbering a real prior checkpoint while
        // still reporting ok:true/verified:true.
        let appendPriorRaw: string | null = null;
        let appendPreReadFailed = false;
        // EI-20283744332352340: the guard below must key off "a join was ATTEMPTED",
        // not off `wantsAppend`. A checks-only patch (`append:true` + `checks`, no
        // `checkpoint` — the documented body-preserving shape carved out at :536)
        // performs no pre-read and no join at all: `checkpointToStore` stays
        // undefined and the body is preserved by the store's own transform, which
        // reads the authoritative prior inside the locked transaction. Testing
        // `wantsAppend` there fired on a null that only means "never attempted",
        // refusing every checks-only patch against a >500-char checkpoint — and its
        // recovery block then offered `confirmShrink:true`, pointing the caller at
        // the destructive replace this guard exists to prevent.
        // Holds the addendum being joined (and narrows it to `string` for the join
        // below); `null` IS the "no join attempted" signal the guard reads.
        const joinAddendum = wantsAppend && checkpoint ? checkpoint : null;
        const didAttemptJoin = joinAddendum !== null;
        // EI-22624970955266330: what `appendBodyPreservationGuard` must compare against is
        // the addendum AS STORED, not as submitted. `checkpointToStore` is rewritten below
        // by write-time transforms (the `[turn:self]` sentinel expansion at minimum), so a
        // guard that tests `storedTail.endsWith(rawSubmission)` fails an identity check it
        // was never meant to police. Track the transformed addendum here and keep it in
        // step with every transform applied to `checkpointToStore`.
        let joinAddendumStored = joinAddendum;
        if (joinAddendum !== null) {
          try {
            appendPriorRaw = await getWorkItemCheckpoint({ harness, workItemId: it.id, workspaceId });
          } catch {
            appendPriorRaw = null;
            appendPreReadFailed = true;
          }
          // EI-19298690705878336: strip any rendered `## Checks` section out of the
          // prior BEFORE joining. That section runs to the end of the document (there
          // is no following heading to bound it), so appending after it would bury the
          // addendum INSIDE the section — where the re-render then drops it as an
          // unparseable row. Caught by test: the addendum vanished entirely.
          // The rows are NOT lost by stripping here: the transform below recovers them
          // from the stored prior note, which the store reads inside its own locked
          // transaction.
          // Walls are rendered as the final section. Joining after a trailing Walls
          // section makes the addendum look like wall-section content, so the parser
          // drops it as an unparseable wall row and the body-preservation guard reports
          // a false `append_body_overflow`. Remove both structured sections before the
          // join, then reattach walls after the new body; the locked transform below
          // reattaches checks in their canonical before-walls position.
          const { body: priorBody, walls: priorWalls } = splitCarryNoteWalls(
            appendPriorRaw !== null ? splitCarryNoteChecks(appendPriorRaw).body : null,
          );
          checkpointToStore = withCarryNoteWalls(joinCheckpoint(priorBody, joinAddendum), priorWalls);
        }
        // EI-8824: c.workspaceId is '*' for an unscoped superuser session (the
        // read-scoping wildcard) — passing it straight through as `?? undefined`
        // let the truthy '*' win and persisted the checkpoint under a literal
        // workspace_id='*' row that no concrete-workspace read (work_items:get's
        // getWorkItemCheckpoint, which never resolves to '*') can ever see. Same
        // bug class as EI-3409/WI-892; resolveConcreteWorkspaceId is the fix.
        //
        // EI-9325: a PLAIN replace (not append, not a clear) is the shrink-risk case
        // this footgun report described — the caller means to paste the FULL prior
        // content verbatim (e.g. prepending a new section by hand) and instead writes
        // a placeholder/marker line, silently truncating a detailed checkpoint. Use
        // the *WithPrior variant ONLY on that path: it costs no extra round-trip (the
        // row is already SELECTed FOR UPDATE inside the same write transaction to
        // build the journal ring) and gives us the prior length for free to warn on.
        // append mode already reads + folds the prior text explicitly above, so it
        // can't hit this failure mode; a clear has no "shrink" to warn about either.
        // EI-18140632570924965: a plain replace (not append, not a clear) that
        // would shrink a substantial prior checkpoint by more than half is BLOCKED
        // by default — the same threshold EI-9325's shrinkWarning already used to
        // WARN, now enforced as a guard. Confirmed live: a caller relying on the
        // warn-only nudge still executed the destructive write before noticing it.
        // `confirmShrink:true` opts back into the old warn-only behavior for a
        // genuinely intentional replace. The guard runs INSIDE the store's locked
        // transaction (see setCarryNoteWithPrior) — no separate read-then-write
        // race between the check and the write.
        const wantsConfirmShrink = it.confirmShrink ?? args.confirmShrink ?? false;
        let priorLength: number | null = null;
        let stored: string | null;
        let blockedReason: string | undefined;
        const depsOpt = declaredDeps !== undefined ? { dependsOn: declaredDeps } : {};
        // Both branches go through setWorkItemCheckpointWithPrior — the plain
        // setWorkItemCheckpoint is only a wrapper over it, so unifying costs nothing
        // and lets the shrink guard, the prior length AND the P-007 dependency
        // stamping apply on the append/clear paths too.
        let isPlainReplace = !wantsAppend && !!checkpointToStore && checkpointToStore.length > 0;
        let newLength = checkpointToStore?.length ?? 0;
        // EI-20232176364474286: keep the guard as the first no-loss tripwire. Only
        // after it refuses a plain >50% shrink do we enable this flag for the one
        // retry below, where the transform appends under the locked prior row.
        let preservePriorOnShrink = false;
        let autoAppendedRefresh = false;
        // EI-19298690705878336: `checks` rows are rendered INTO the stored note, so a
        // write must MERGE them against the prior note rather than replace it — and
        // that merge has to happen inside the store's locked transaction, or a
        // concurrent writer on the same item can interleave between our read and our
        // write. Hence the `transform` seam rather than a read-then-write here.
        // EI-19400299440742193: enforce the SOFT row caps by TRUNCATION, here, after the
        // schema's backstop let the call through. The cap's job is to bound what
        // re-injects into every future pickup of this item — truncation does that just
        // as well as rejection did, without discarding the whole checkpoint. Every trim
        // is REPORTED below: a cut the caller cannot see is the EI-18723223344390510
        // failure mode, where a row was quietly reshaped and a verified check's evidence
        // was destroyed with no signal.
        const repairs: CarryArgRepair[] = [];
        const suppliedChecks = rawSuppliedChecks?.map((row, i) => {
          const out = { ...row };
          out.claim = truncateCarryField(out.claim, CARRY_ROW_SOFT_CAPS.claim, `checks[${i}].claim`, repairs);
          if (typeof out.recheck === 'string')
            out.recheck = truncateCarryField(out.recheck, CARRY_ROW_SOFT_CAPS.recheck, `checks[${i}].recheck`, repairs);
          if (typeof out.falsifier === 'string')
            out.falsifier = truncateCarryField(
              out.falsifier,
              CARRY_ROW_SOFT_CAPS.falsifier,
              `checks[${i}].falsifier`,
              repairs,
            );
          if (typeof out.verified === 'string')
            out.verified = truncateCarryField(
              out.verified,
              CARRY_ROW_SOFT_CAPS.verified,
              `checks[${i}].verified`,
              repairs,
            );
          if (typeof out.observed === 'string')
            out.observed = truncateCarryField(
              out.observed,
              CARRY_ROW_SOFT_CAPS.observed,
              `checks[${i}].observed`,
              repairs,
            );
          return out;
        });
        // P-014: provenanceLint describes only bytes supplied by THIS write. The
        // stored checkpoint may also carry old checks/body bytes through the locked
        // transform below; those are separated at the response boundary as
        // retainedProvenance instead of being misreported as current activity.
        let currentProvenanceText = (() => {
          const submittedBody = splitCarryNoteChecks(checkpoint ?? '').body;
          return suppliedChecks !== undefined ? withCarryNoteChecks(submittedBody, suppliedChecks) : submittedBody;
        })();
        // P-016 / EI-212678: persist the caveat, not only the response warning.
        // Compute against exactly the bytes supplied by this call, then prefix the
        // stored narrative when owner authority is not mechanically established.
        const successfulActions =
          hasPotentialActionClaim(currentProvenanceText)
            ? await readSuccessfulActionInvocations({
                workspaceId,
                spawnId: c.spawnId,
                coordOwnerId: ident.ownerId,
              })
            : undefined;
        // EI-19425644478222007: expand `[turn:self]` / `[turn:current]` into this write's
        // REAL anchor (see carry-surface-provenance-stamp for why a sentinel beats making
        // the agent guess a timestamp it is never told). Ordered BEFORE the stamp so the
        // lint sees a verifiable ref and the checkpoint is STORED with an anchor that
        // resolves. Both texts are expanded: `currentProvenanceText` is what the lint
        // reads, `checkpointToStore` is what persists. Cheap pre-check keeps the extra
        // transcript read off every write that does not use a sentinel; an unresolvable
        // turn leaves the sentinel verbatim and still lint-flagged.
        const sentinelTurn =
          hasCurrentTurnSentinel(currentProvenanceText) || hasCurrentTurnSentinel(checkpointToStore)
            ? await resolveCurrentTurnStamp(ident.ownerId).catch(() => null)
            : null;
        if (sentinelTurn) {
          checkpointToStore = expandCurrentTurnSentinel(checkpointToStore, sentinelTurn);
          currentProvenanceText =
            expandCurrentTurnSentinel(currentProvenanceText, sentinelTurn) ?? currentProvenanceText;
          // Keep the append guard's comparison target in step with the stored bytes.
          // Without this the sentinel is expanded in `checkpointToStore` but not in the
          // submitted addendum, so the guard's endsWith() is false for reasons that have
          // nothing to do with the cap — and every append containing `[turn:self]` is
          // refused as `append_body_overflow`. That fires on exactly the writers who
          // FOLLOW the provenance lint's instruction to use the sentinel.
          joinAddendumStored =
            expandCurrentTurnSentinel(joinAddendumStored, sentinelTurn) ?? joinAddendumStored;
        }
        const preWriteStamp = await stampCarrySurfaceProvenance(currentProvenanceText, ident.ownerId, {
          successfulActions,
        });
        const ownerEnforcement = ownerAttributionEnforcement(currentProvenanceText, preWriteStamp);
        if (ownerEnforcement.unverified) {
          checkpointToStore = markUnverifiedOwnerAttribution(checkpointToStore);
          currentProvenanceText = markUnverifiedOwnerAttribution(currentProvenanceText) ?? currentProvenanceText;
        }
        // Reject caller-authored authority before entering the checkpoint store.
        // The locked transform rechecks these same supplied bytes after composing
        // the final note, but deliberately does not reinterpret inherited history
        // as a new instruction.
        const directFrozenCarryViolation = frozenWorkItemCarryViolation(currentProvenanceText);
        if (directFrozenCarryViolation) {
          return { ...directFrozenCarryViolation, id: it.id };
        }
        isPlainReplace = !wantsAppend && !!checkpointToStore && checkpointToStore.length > 0;
        newLength = checkpointToStore?.length ?? 0;
        const isClear = !(checkpointToStore && checkpointToStore.length > 0);
        // EI-19447043119380534: `checks` supplied while `checkpoint` is ENTIRELY OMITTED
        // (undefined — NOT an explicit null/'' clear) is a checks-only PATCH: carry the
        // stored body forward instead of rendering a body-less note. Confirmed live: a
        // 9376-char checkpoint became 1562 chars of bare `## Checks`, ok:true, with the
        // plan and the file-by-file record gone.
        //
        // Two properties made this the worst possible shape. Within ONE call an omitted
        // `checks` PRESERVES (documented) while an omitted `checkpoint` DESTROYED — the
        // safe-to-omit and catastrophic-to-omit fields sat adjacent with opposite
        // defaults. And the >50% shrink guard could never fire here: `isPlainReplace`
        // requires a non-empty replacement body, which this path by definition lacks, so
        // the guard armed for the DELIBERATE case (an explicitly-provided shorter body)
        // and skipped the ACCIDENTAL one.
        //
        // `checkpoint` is `.nullish()`, so undefined (omitted) is distinguishable from an
        // explicit null — a real clear stays reachable via { checkpoint: null } / clear:true,
        // while a bare { id } is rejected above. work_items:complete's terminal cleanup
        // calls the store directly, so its explicit null clear contract is unchanged.
        // `append:true` makes this body-less metadata patch additive too: supplied
        // checks are UNIONED rather than replacing the carried set.
        const isBodyPreservingPatch = isChecksOnlyPatch || isDependencyOnlyPatch || isLearnedMetadataPatch;
        // `rowsMode:'merge'` is additive for a body write and for the checks-only
        // patch shape. An explicit clear remains a true clear, preserving the
        // work_items:complete cleanup contract.
        const additiveRowsMode = rowsMode === 'merge' && (isChecksOnlyPatch || !isClear);
        // `append` governs the BODY. An explicit rowsMode:'replace' remains authoritative
        // for CHECK ROWS, so callers can append a narrative update while retiring the
        // exact carried rows named by retireIds. Previously `wantsAppend` unconditionally
        // made this true, neutralizing rowsMode:'replace' and reporting that no rows would
        // drop (EI-23151788119236015).
        const additiveChecks = rowsMode === 'replace' ? false : wantsAppend || additiveRowsMode;
        // A CLEAR wipes the checks too, UNLESS the caller supplied some in the same
        // call. This is a DELIBERATE divergence from loop:checkpoint, where checks
        // survive a note clear: work_items:complete clears the checkpoint as terminal
        // cleanup, and rows surviving that would resurrect a checks-only checkpoint on
        // an already-closed item.
        // EI-19460631385508515: a SUPPLIED `checks` list REPLACES the stored set —
        // normalizeCheckEntries iterates only the incoming rows and uses the prior set
        // solely to inherit recheck/verified/sinceMs onto claims that reappear. A stored
        // claim the caller leaves out is therefore DROPPED, silently. That is defensible
        // as semantics (it is the only way to retire a stale check) but it was documented
        // as "a list merges by claim text", which promises a UNION — so an agent updating
        // ONE row to mark it verified would lose the others and the reply's `checks` count
        // (read off the stored note) was the only trace. The doc now says REPLACES; this
        // captures what went missing so the loss is VISIBLE in the result rather than
        // inferable only by diffing a count you would have to have recorded beforehand.
        let droppedCheckClaims: string[] = [];
        let unmatchedCheckRefs: string[] = [];
        let suppliedChecksNotRetained: AppendChecksOverflowRow[] = [];
        let preserveCarriedChecksOnOverflow = false;
        const checksTransform =
          suppliedChecks !== undefined || !isClear || isDependencyOnlyPatch || isLearnedMetadataPatch
            ? (priorNote: string | null, incoming: string | null | undefined) => {
                const priorSplit = splitCarryNoteChecks(priorNote);
                const originalPrior = priorSplit.checks;
                // P-025: resolve a one-row reword against the authoritative locked
                // prior before capacity checks/upsert. The resolver promotes an
                // id-less target to a stable id so its evidence and age survive.
                const resolvedRefs = resolveCarryRowRefs({
                  priorWalls: [],
                  priorChecks: originalPrior,
                  checks: suppliedChecks,
                });
                const prior = resolvedRefs.priorChecks;
                const resolvedSuppliedChecks = resolvedRefs.checks;
                unmatchedCheckRefs = resolvedRefs.unmatched;
                // `incoming` may carry its OWN rendered `## Checks` — append mode folds
                // the whole prior note in, section and all — so strip it before
                // re-attaching or the note ends up with two Checks sections.
                const { body: incomingBody } = splitCarryNoteChecks(incoming ?? '');
                // EI-19447043119380534: on a checks-only patch the caller supplied no body
                // at all, so the STORED one is the body — read authoritatively here, inside
                // the store's locked transaction, so a concurrent writer cannot interleave.
                const shouldAppendRefresh =
                  preservePriorOnShrink &&
                  isPlainReplace &&
                  priorNote !== null &&
                  priorNote.length > 500 &&
                  newLength < priorNote.length * 0.5 &&
                  incomingBody.length > 0;
                let body = isBodyPreservingPatch
                  ? priorSplit.body
                  : shouldAppendRefresh
                    ? joinCheckpointNewestFirst(incomingBody, priorSplit.body)
                    : incomingBody;
                body = normalizeUnverifiedOwnerAttributionMarkers(body) ?? body;
                if (ownerEnforcement.unverified) body = markUnverifiedOwnerAttribution(body) ?? body;
                if (shouldAppendRefresh) autoAppendedRefresh = true;
                const patchedExistingChecks =
                  (additiveChecks || (preservePriorOnShrink && rowsMode !== 'replace')) &&
                  resolvedSuppliedChecks !== undefined &&
                  resolvedSuppliedChecks.length > 0
                    ? patchExistingCheckEntries(resolvedSuppliedChecks, prior, Date.now())
                    : null;
                // EI-19944669306930709: under `append: true` the supplied rows are
                // UNIONED onto the carried set instead of replacing it. `append` is an
                // explicit declaration that this write is ADDITIVE, and it governed only
                // the body — so "append a progress note, and record the one claim I just
                // verified", the single most natural incremental write, destroyed every
                // other carried check. Reported twice in one session ~25min apart by an
                // agent who had already READ the replace-semantics warning: the rule was
                // known and did not help, because `append: true` in the same call frames
                // the whole invocation as additive and `checks` reads as one more field
                // of it.
                //
                // EI-19460631385508515 made that loss VISIBLE (`checksDropped`). Visible
                // is not prevented: the report is after-the-fact, rides on an `ok: true`,
                // and recovery means re-sending the full set verbatim — where any claim
                // whose text you retype slightly differently loses its inherited
                // recheck/verified and silently becomes a new, unevidenced row. Under an
                // explicitly additive write there is nothing to trade off, so prevent it.
                //
                // Order matters: supplied FIRST. normalizeCheckEntries dedups by claim
                // text (first occurrence wins) and caps at CARRY_NOTE_MAX_CHECKS, so a
                // re-sent claim updates in place rather than duplicating, and if the cap
                // bites it is the carried tail that yields — never the row the caller
                // just told us mattered. A carried row passed through inherits from
                // itself, so its evidence and original sinceMs survive untouched.
                //
                // PLAIN (non-append) replace keeps its retire-stale-check semantics. The
                // automatic concise-refresh retry is the exception: that retry is
                // explicitly additive, so it carries the prior rows forward. Retiring a
                // row while appending remains two calls, by design.
                // EI-21851633473920728: `preservePriorOnShrink` exists to protect the
                // BODY-shrink retry from silently evicting rows it never intended to
                // touch — it must not also override an EXPLICIT `rowsMode:'replace'`.
                // A caller who asked to retire stale rows and got a shrink-triggered
                // retry is entitled to the SAME replace semantics (and the same
                // ReplaceWouldDropError guard) the first attempt would have given them;
                // silently downgrading to additive/merge here is what produced a
                // self-contradicting `ok:true` with every supplied row reported as
                // `checksNotRetained` while the stale carried rows were kept as `checks`.
                const checksAdditiveOnThisWrite = additiveChecks || (preservePriorOnShrink && rowsMode !== 'replace');
                const effectiveChecks =
                  resolvedSuppliedChecks === undefined
                    ? undefined
                      : checksAdditiveOnThisWrite
                      ? [...resolvedSuppliedChecks, ...orderCarriedForUnion(resolvedSuppliedChecks, prior)]
                      : resolvedSuppliedChecks;
                // An empty additive list is a true no-op, including for legacy notes
                // that exceed today's cap. Do not run the carried rows back through
                // normalizeCheckEntries, or the recovery would succeed only after
                // silently evicting the very rows it promised to preserve.
                const preserveEmptyAdditiveChecks = additiveChecks && suppliedChecks?.length === 0;
                const preservedOverflow =
                  preserveCarriedChecksOnOverflow && resolvedSuppliedChecks !== undefined
                    ? mergeChecksPreservingCarried(prior, resolvedSuppliedChecks)
                    : null;
                if (preservedOverflow) suppliedChecksNotRetained = preservedOverflow.notRetained;
                let merged = preservedOverflow
                  ? preservedOverflow.merged
                  : patchedExistingChecks !== null
                    ? patchedExistingChecks
                    : effectiveChecks !== undefined
                      ? preserveEmptyAdditiveChecks
                        ? prior
                        : normalizeCheckEntries(effectiveChecks, prior)
                      : prior;
                // EI-22392265719579261: a legacy note can fit the row-count cap while
                // its carried fields still consume the entire byte cap. In that state
                // the normal body trim has no room to retain a concise append, so fit
                // the carried checks against the submitted addendum first. This is
                // deliberately scoped to the over-cap append case; ordinary appends
                // continue preserving every carried row byte-for-byte.
                if (
                  didAttemptJoin &&
                  joinAddendum &&
                  withCarryNoteChecks(joinAddendum, merged).length > CHECKPOINT_CAP
                ) {
                  const fitted = fitChecksForAppendBody(joinAddendum, merged);
                  if (fitted.truncatedFields > 0 || fitted.dropped.length > 0) {
                    merged = fitted.merged;
                    legacyChecksNormalization.truncatedFields = Math.max(
                      legacyChecksNormalization.truncatedFields,
                      fitted.truncatedFields,
                    );
                    legacyChecksNormalization.droppedRows = Math.max(
                      legacyChecksNormalization.droppedRows,
                      fitted.dropped.length,
                    );
                  }
                }
                // Recomputed on every transform invocation (the store may retry it under
                // its lock) so the last run — the one whose result is stored — wins.
                // Drop detection must use the same stable identity as the merge and
                // normalizer. Comparing claim text here misreports an id-keyed
                // rewording as a lost predecessor, even though the row was replaced
                // in place and retained its slot/evidence.
                const keptCheckKeys = new Set(merged.map((c) => carryRowKey(c)));
                const droppedRows = originalPrior.filter((c, i) => {
                  const resolvedPrior = prior[i] ?? c;
                  return c.claim.trim().length > 0 && !keptCheckKeys.has(carryRowKey(resolvedPrior));
                });
                droppedCheckClaims = droppedRows.map((c) => c.claim.trim());
                // EI-21923095696933477: retireIds is a STRONGER, opt-in check — the
                // caller names exactly which rows they intend to retire, so an
                // unlisted stored row can never be dropped by omission. It gates
                // INDEPENDENTLY of confirmRetire (naming the set is itself the
                // informed consent) and refuses in EITHER mismatch direction: a
                // real drop the caller didn't name, or a named id that would not
                // actually have dropped (a stale snapshot of the carried set).
                if (rowsMode === 'replace' && wantsRetireIds !== undefined) {
                  // Caller-facing identity: exactly what the docs promise (a
                  // row's `id`, else its raw claim text) — NOT carryRowKey's
                  // internal `id:`/`claim:`-prefixed dedup key, which the
                  // caller has no way to know to reproduce.
                  const retireIdentity = (c: { id?: string; claim?: string }) =>
                    sanitizeCarryRowId(c.id) ?? (c.claim ?? '').trim();
                  const droppedKeys = new Set(droppedRows.map((c) => retireIdentity(c)));
                  // EI-22385255026192781: the STORED side is sanitized (above), but the
                  // caller's strings were not — and the only place an agent ever SEES a
                  // row id is the rendered `[#id]` anchor, whose '#' sanitizeCarryRowId
                  // strips (it is outside CARRY_ROW_ID_ALLOWED). So copying the id from
                  // the note you just read produced `#foo` vs a stored `foo` and refused
                  // on a difference the renderer itself introduced. Normalize a requested
                  // key ONLY when its sanitized form matches a real dropped identity:
                  // a retireIds entry may equally be raw CLAIM TEXT, which must survive
                  // untouched, and a genuinely wrong id must still mismatch.
                  const requestedKeys = new Set(
                    wantsRetireIds.map((k) => {
                      if (droppedKeys.has(k)) return k;
                      const asId = sanitizeCarryRowId(k);
                      return asId && droppedKeys.has(asId) ? asId : k;
                    }),
                  );
                  const setsMatch =
                    droppedKeys.size === requestedKeys.size && [...droppedKeys].every((k) => requestedKeys.has(k));
                  if (!setsMatch) {
                    throw new RetireIdsMismatchError([...requestedKeys], [...droppedKeys]);
                  }
                } else if (rowsMode === 'replace' && wantsAppend && droppedCheckClaims.length > 0) {
                  throw new ReplaceWouldDropError(droppedCheckClaims, true);
                } else if (rowsMode === 'replace' && !wantsConfirmRetire && droppedCheckClaims.length > 0) {
                  throw new ReplaceWouldDropError(droppedCheckClaims);
                }
                if (merged.length === 0)
                  return enforceFrozenWorkItemCarry(body.length > 0 ? body : null, currentProvenanceText);
                const rendered = withCarryNoteChecks(body, merged);
                if (rendered.length <= CHECKPOINT_CAP)
                  return enforceFrozenWorkItemCarry(rendered, currentProvenanceText);
                // Over cap: trim the BODY and re-attach, so the checks — bounded to
                // CARRY_NOTE_MAX_CHECKS rows — are never the part that gets cut.
                // EI-21472322403787688: trim DIRECTION follows the body's ordering.
                // Old-first bodies (explicit append / historical shape) cut from the
                // front — the oldest bytes. The newest-first AUTO-preserved refresh
                // cuts from the END instead: what must never be trimmed is the fresh
                // authority sitting at the head.
                const overflow = rendered.length - CHECKPOINT_CAP + TRUNCATION_MARKER.length;
                const keepBody = Math.max(body.length - overflow, 0);
                const trimmedBody = shouldAppendRefresh
                  ? body.slice(0, keepBody) + TRUNCATION_MARKER
                  : TRUNCATION_MARKER + body.slice(Math.min(overflow, body.length));
                return enforceFrozenWorkItemCarry(withCarryNoteChecks(trimmedBody, merged), currentProvenanceText);
              }
            : undefined;
        /**
         * EI-21228214077347799: the shrink guard and the checks-overflow guard protect
         * INDEPENDENT axes — the first the BODY being replaced, the second the check ROWS
         * being unioned — and the default `rowsMode:'merge'` WITH a body is BOTH at once
         * (the body replaces, so `isPlainReplace`; the rows union, so `additiveChecks`).
         * Chaining them as `isPlainReplace ? shrink : additiveChecks ? overflow : undefined`
         * handed the single guard slot to the shrink guard, which knows nothing about rows,
         * so the overflow guard never ran on the most common write shape in the tool and the
         * transform evicted the carried tail exactly as the pre-WI-7190 append path did —
         * silently, still returning ok:true, and trading ✓ VERIFIED carried rows for
         * ? PREDICTED supplied ones.
         *
         * Compose instead: every APPLICABLE guard runs and the first refusal wins, so
         * neither axis can mask the other. Order is deliberate — the two no-loss guards are
         * checked BEFORE the shrink guard, because a shrink refusal is retried below
         * (EI-20232176364474286) while a row-loss refusal must be terminal.
         */
        type CheckpointGuard = (priorNote: string | null, priorLength: number) => string | null;
        const composeGuards = (...guards: Array<CheckpointGuard | null>): CheckpointGuard | undefined => {
          const active = guards.filter((g): g is CheckpointGuard => g !== null);
          if (active.length === 0) return undefined;
          return (priorNote, priorLen) => {
            for (const guard of active) {
              const refusal = guard(priorNote, priorLen);
              if (refusal) return refusal;
            }
            return null;
          };
        };
        const shrinkGuard: CheckpointGuard | null =
          isPlainReplace && !wantsConfirmShrink
            ? (_priorNote, priorLen) =>
                priorLen > 500 && newLength < priorLen * 0.5
                  ? `plain replace would shrink the checkpoint from ${priorLen} to ${newLength} chars (>50% loss). ` +
                    'Pass { append: true } to join onto the existing checkpoint instead, or { confirmShrink: true } ' +
                    'if this replace is intentional.'
                  : null
            : null;
        const appendBaseGuard: CheckpointGuard | null =
          additiveChecks && !wantsConfirmShrink
            ? // WI-7190: `append:true` used to arm NO guard at all — "the one mode whose
              // whole contract is 'never lose the existing text' was the mode with no
              // shrink protection." Confirmed live: the tool's own pre-read
              // (getWorkItemCheckpoint, above) came back empty on a resolvable item while
              // a 10,671-char checkpoint genuinely existed — the join then had nothing to
              // join onto, so `checkpointToStore` was just the addendum, and the write
              // silently REPLACED the real checkpoint while still returning
              // ok:true/verified:true. `_priorNote`/`priorLen` here are the AUTHORITATIVE
              // prior — read inside this same locked transaction, independent of the
              // tool's separate pre-read above — so disagreement between the two is
              // exactly the failure signature: the write path resolves the item, the
              // (different) read path used to build the join does not.
              (_priorNote, priorLen) =>
                didAttemptJoin && priorLen > 500 && (appendPriorRaw === null || appendPriorRaw.length === 0)
                  ? `append_base_unreadable — the append pre-read returned ${appendPreReadFailed ? 'an error' : 'nothing'} ` +
                    `while the current checkpoint is ${priorLen} chars (read authoritatively at write time, inside ` +
                    'the same locked transaction as this write). Appending now would silently REPLACE it instead of ' +
                    'joining — refusing the write rather than losing it. Retry (a transient read/key mismatch is the ' +
                    'likely cause), pass { harness } explicitly, or pass { confirmShrink: true } to force the replace ' +
                    'if that is actually intended.'
                  : null
            : null;
        /**
         * EI-21282889275455257: checks are rendered INTO the checkpoint body. A
         * checks-only patch promises to preserve that body, but the transform below
         * used to front-trim it when the newly-rendered checks pushed the note over
         * CHECKPOINT_CAP. Refuse that metadata patch before the transform can evict
         * narrative bytes; callers can retry without checks or deliberately opt into
         * the destructive path with confirmShrink:true.
         */
        const bodyPreservationGuard: CheckpointGuard | null =
          !wantsConfirmShrink && isBodyPreservingPatch && (suppliedChecks?.length ?? 0) > 0
            ? (priorNote) => {
                const priorSplit = splitCarryNoteChecks(priorNote);
                const priorChecks = priorSplit.checks;
                const effectiveChecks = additiveChecks ? [...(suppliedChecks ?? []), ...priorChecks] : suppliedChecks;
                const patchedExistingChecks =
                  additiveChecks && (suppliedChecks?.length ?? 0) > 0
                    ? patchExistingCheckEntries(suppliedChecks ?? [], priorChecks)
                    : null;
                const merged = patchedExistingChecks ?? normalizeCheckEntries(effectiveChecks ?? [], priorChecks);
                const rendered = withCarryNoteChecks(priorSplit.body, merged);
                return rendered.length > CHECKPOINT_CAP
                  ? `checks_body_overflow — this body-preserving checks patch would render ${rendered.length} chars, exceeding the ${CHECKPOINT_CAP}-char checkpoint cap and evicting the oldest narrative content. Refusing the write; retry without checks or shorten the checks before retrying, or pass { confirmShrink: true } only if that loss is intentional.`
                  : null;
              }
            : null;
        /**
         * EI-21399238191579954: legacy notes can carry more check bytes than the
         * current cap permits. The append transform preserves those rows, then
         * front-trims the narrative body to make room; when the rows alone consume
         * the cap, that trim removes the submitted addendum entirely while the
         * write still returns `verified:true`. Re-run the exact transform under the
         * same locked prior and refuse unless the submitted body remains intact.
         */
        const appendBodyPreservationGuard: CheckpointGuard | null =
          !wantsConfirmShrink && didAttemptJoin && joinAddendumStored
            ? (priorNote, priorLen) => {
                const candidate = checksTransform?.(priorNote, checkpointToStore);
                const candidateBody = candidate
                  ? splitCarryNoteWalls(splitCarryNoteChecks(candidate).body).body.trim()
                  : '';
                const submitted = joinAddendumStored.trim();
                if (candidateBody.endsWith(submitted)) return null;

                // EI-22624970955266330: `priorLen` is the CARRIED NOTE's length, not
                // check-row bytes. Naming it "carried check rows" sent callers to
                // retire rows on items that had ZERO rows (measured: an item reporting
                // checkpointChecks {count: 0} was told 9,747 characters of rows were in
                // the way). Report each cap contributor separately so callers can
                // choose a recovery from measurements rather than a mislabeled total.
                appendBodyOverflowDetails = appendBodyOverflowDiagnostics(priorNote, priorLen, submitted);
                return (
                  `append_body_overflow — carried prose occupies ${appendBodyOverflowDetails.carriedProseChars} ` +
                  `chars; carried check rows occupy ${appendBodyOverflowDetails.carriedCheckRowChars} chars; ` +
                  `the submitted append occupies ${appendBodyOverflowDetails.submittedAppendChars} chars; ` +
                  `remaining capacity before this append is ${appendBodyOverflowDetails.remainingCapacityChars} ` +
                  `of the ${CHECKPOINT_CAP}-character checkpoint cap. ` +
                  // EI-22072152340717849: keep the remedy explicit about which content
                  // each choice sacrifices. This guard never evicts a carried check row.
                  'Refusing the write rather than reporting success with the new progress note silently dropped. ' +
                  'No carried check row is evicted by this refusal, or would be by proceeding past it — this guard ' +
                  'concerns the append body only. Two ways forward, with different costs: ' +
                  '(1) SAFE — first retire specific stale rows in a separate, non-append write ' +
                  '({ rowsMode: "replace", retireIds: [...] } naming exactly what to drop, or ' +
                  '`confirmRetire: true`), which frees cap room without touching this note, then retry this append; ' +
                  '(2) pass { confirmShrink: true } to THIS append — it keeps every carried check row intact but ' +
                  'silently trims or entirely drops the append body you are submitting now, so use it only when ' +
                  'losing this new note (never the checks) is acceptable.'
                );
              }
            : null;
        /**
         * Armed independently of `isPlainReplace` — that is the EI-21228214077347799 fix.
         * It also covers the shrink-retry below: that retry sets `preservePriorOnShrink`,
         * which makes the checks additive (see `effectiveChecks`), so the same closure —
         * reading both flags at call time, inside the store's lock — is what stops the
         * retry from evicting the rows the first attempt refused to lose.
         */
        let appendChecksOverflowDiagnostics: AppendChecksOverflowRow[] = [];
        let appendBodyOverflowDetails: AppendBodyOverflowDiagnostics | undefined;
        /** Set by the overflow guard when it absorbs a legacy over-cap prior instead of
         *  refusing (EI-21534719386975911), so the reply can name the real cause of the
         *  eviction rather than reporting it as an ordinary caller-caused cap cut.
         *
         *  A mutated CONST holder rather than a reassigned `let`: the guard runs inside a
         *  closure the store invokes under its lock, which control-flow analysis cannot
         *  see, so a `let … | null = null` narrows to `never` at the read below and the
         *  branch fails to compile. `0` means "no legacy excess absorbed". */
        const legacyOverCapNormalization = { legacyExcess: 0 };
        const legacyChecksNormalization = { truncatedFields: 0, droppedRows: 0 };
        const overflowGuard: CheckpointGuard | null =
          !wantsConfirmShrink && suppliedChecks !== undefined
            ? (_priorNote) => {
                // An explicitly empty list is the documented additive no-op for both
                // recovery shapes. It must not reject a legacy note that already carries
                // more rows than the current cap; there are no supplied rows to evict.
                if (suppliedChecks.length === 0) return null;
                // EI-21851633473920728: an explicit rowsMode:'replace' must not be
                // pulled into additive/preserve-carried handling just because the
                // body-shrink retry set `preservePriorOnShrink` — see the matching
                // note on `checksAdditiveOnThisWrite` above.
                if (!(additiveChecks || (preservePriorOnShrink && rowsMode !== 'replace'))) return null;
                const refs = resolveCarryRowRefs({
                  priorWalls: [],
                  priorChecks: splitCarryNoteChecks(_priorNote).checks,
                  checks: suppliedChecks,
                });
                unmatchedCheckRefs = refs.unmatched;
                const overflowCount = appendChecksOverflowCount(_priorNote, suppliedChecks);
                if (overflowCount === 0) return null;
                /**
                 * EI-21534719386975911 — NORMALIZE ON WRITE, do not refuse forever.
                 *
                 * The refusal below exists to stop a caller's own rows from evicting
                 * carried ones: it hands back a real remedy ("retire stale rows first,
                 * then append"), which only works while the stored note still FITS. When
                 * the note is ALREADY over cap, that remedy is unreachable — the full set
                 * cannot be re-sent, since `checks` is capped at CARRY_NOTE_MAX_CHECKS and
                 * a larger list is rejected as invalid_input — so the guard turned a
                 * legacy data condition into a permanently unwritable checkpoint. Measured
                 * here: 57 notes in this workspace, every additive write against them
                 * refused, the same bug re-filed each time a different agent inherited one.
                 *
                 * So absorb it: trim to the cap and PROCEED. The transform already unions
                 * supplied-first and normalizes, `orderCarriedForUnion` makes the tail it
                 * cuts the PREDICTED rows, and the eviction is reported through the
                 * ordinary `checksDropped` channel rather than being silent. Each poisoned
                 * note self-heals the next time anyone touches it — no migration, and no
                 * way back to the refuse-forever state.
                 *
                 * The guard keeps its original job intact for a within-cap prior, which is
                 * the whole distinction: refuse CALLER-caused eviction, absorb LEGACY
                 * over-cap state.
                 */
                const legacyExcess = priorChecksOverCapCount(_priorNote);
                if (legacyExcess > 0) {
                  legacyOverCapNormalization.legacyExcess = legacyExcess;
                  return null;
                }
                // EI-22489206594122743: `confirmRetire:true` is the explicit one-call
                // consent for the same merge-cap eviction that `loop:checkpoint` already
                // permits. Without this escape, the checks-only branch below refused the
                // write unconditionally, so the documented confirmation had no effect
                // even though the transform could safely report the exact carried rows
                // it evicted. Keep the default refusal for an unconfirmed additive write.
                if (wantsConfirmRetire) return null;
                // EI-21602661222231785: the body is the primary checkpoint payload;
                // optional check capacity must not strand it. For body-bearing writes,
                // proceed atomically while the transform preserves every carried row,
                // updates matching supplied rows in place, and admits new rows only into
                // vacant slots. The response explicitly names supplied rows that did not
                // fit. Checks-only patches retain the refusal contract: their sole payload
                // is the metadata that overflowed, so reporting success would be false.
                if (hasCheckpointBody) {
                  preserveCarriedChecksOnOverflow = true;
                  return null;
                }
                appendChecksOverflowDiagnostics = appendChecksOverflowRows(_priorNote, suppliedChecks);
                return (
                  `append_checks_overflow — the supplied checks would union to more than the ${CARRY_NOTE_MAX_CHECKS}-row cap ` +
                  `(${overflowCount} carried row(s) would be evicted). Refusing the additive write before it changes ` +
                  `the checkpoint. Retire stale rows with a plain replace first, or retry ${wantsAppend ? 'this append' : "rowsMode:'merge'"} without \`checks\` ` +
                  '(or with `checks: []`) to preserve the carried set.'
                );
              }
            : null;
        // EI-21851633473920728: shared so the shrink-retry below (which now honours an
        // explicit rowsMode:'replace' instead of silently downgrading it to additive)
        // reports the SAME refusal shape as the first attempt, rather than letting the
        // error escape the retry uncaught.
        const replaceWouldDropResponse = (error: ReplaceWouldDropError) => ({
          ok: false as const,
          id: it.id,
          error: 'checkpoint_replace_would_drop_rows',
          errorCode: 'checkpoint_replace_would_drop_rows',
          retryable: true,
          checksDropped: error.droppedChecks,
          ...(error.retireIdsRequired ? { retireIdsRequired: true } : {}),
          message:
            error.retireIdsRequired
              ? "append:true with rowsMode:'replace' would RETIRE the carried checks named above. confirmRetire:true " +
                'is not sufficient for this combination — NOTHING was written. Retry with `retireIds` naming exactly ' +
                'the rows above, or omit rowsMode to preserve the carried checks.'
              : "rowsMode:'replace' would RETIRE the carried checks named above and confirmRetire was not true — " +
                'NOTHING was written. Re-send the FULL current set under replace with confirmRetire:true, or name ' +
                'exactly the rows above in `retireIds` for a mismatch-checked retirement, or omit ' +
                'rowsMode entirely (merge is the default and preserves unmentioned rows up to the cap).',
        });
        // EI-21923095696933477: the retireIds sibling of replaceWouldDropResponse —
        // reports what was requested vs what would actually drop so the caller can
        // resend a corrected set without a second blind guess.
        const retireIdsMismatchResponse = (error: RetireIdsMismatchError) => {
          const sameIdUpdateHint =
            error.actual.length === 0 && error.requested.length > 0
              ? ' No rows would be retired; a carried row with the same id as a replacement is kept in place. ' +
                'Omit `retireIds` for an in-place update.'
              : '';
          return {
            ok: false as const,
            id: it.id,
            error: 'checkpoint_retire_ids_mismatch',
            errorCode: 'checkpoint_retire_ids_mismatch',
            retryable: true,
            retireIdsRequested: error.requested,
            retireIdsActual: error.actual,
            message:
              'retireIds did not exactly match the rows this replace would actually drop — NOTHING was written. ' +
              `Requested: ${error.requested.length ? error.requested.join(', ') : '(none)'}. ` +
              `Would actually drop: ${error.actual.length ? error.actual.join(', ') : '(none)'}. ` +
              sameIdUpdateHint +
              'Re-send retireIds naming exactly the rows in "Would actually drop", or omit retireIds and use ' +
              'confirmRetire:true instead.',
          };
        };
        // EI-21864672058763701 / EI-21864782390076614: setWorkItemCheckpointWithPrior
        // now runs its write under boundedOrgTxn (acquireTimeoutMs 8_000), so a stall
        // under admin-pool/row-lock contention throws a typed OrgTxnTimeoutError FAST
        // instead of hanging until the client-side MCP transport times out with an
        // ambiguous "commit status unknown". Surface it as a clean, retryable result —
        // the same shape scorecards:list already uses for the identical error class —
        // rather than letting it escape as a raw thrown error from inside runBulk.
        const timeoutResponse = (error: OrgTxnTimeoutError | DbCallDeadlineError) => ({
          ok: false as const,
          id: it.id,
          error: 'timeout',
          errorCode: 'timeout',
          retryable: true,
          ...(error instanceof OrgTxnTimeoutError ? { pgCode: error.pgCode } : {}),
          message:
            `work_items:checkpoint write could not acquire or complete its bounded transaction: ${error.message}. ` +
            'Your checkpoint text was NOT saved — nothing committed, no ambiguity. Retry shortly.',
        });
        let res;
        try {
          res = await setWorkItemCheckpointWithPrior({ harness, workItemId: it.id, workspaceId }, checkpointToStore, {
            ...(typeof (joinAddendumStored ?? checkpointToStore) === 'string'
              ? { latestUpdate: (joinAddendumStored ?? checkpointToStore)! } : {}),
            ...(item ? { workItem: item as WorkItemSubject } : {}),
            // P-012 / D-006: a writer holding a restricted disclosure stores a sealed stub.
            writerOwnerId: ident.ownerId,
            ...(checksTransform ? { transform: checksTransform } : {}),
            guard: composeGuards(
              appendBaseGuard,
              bodyPreservationGuard,
              overflowGuard,
              appendBodyPreservationGuard,
              shrinkGuard,
            ),
            ...depsOpt,
          });
        } catch (error) {
          if (error instanceof FrozenCarryCheckpointError) return { ...error.payload, id: it.id };
          if (error instanceof RetireIdsMismatchError) return retireIdsMismatchResponse(error);
          if (error instanceof ReplaceWouldDropError) return replaceWouldDropResponse(error);
          if (error instanceof OrgTxnTimeoutError || error instanceof DbCallDeadlineError) return timeoutResponse(error);
          throw error;
        }
        // EI-20232176364474286: retain the existing guard's no-loss behavior, but do
        // not strand a normal concise progress refresh on a manual retry. A blocked
        // plain shrink is retried once WITHOUT the shrink guard and the transform above
        // appends it under the current locked prior. Other blockers remain refusals.
        //
        // EI-21228214077347799: "without the shrink guard" is not "without any guard".
        // Setting `preservePriorOnShrink` makes the checks additive, so retrying with no
        // guard at all re-opened the very row eviction the first attempt was refusing —
        // the retry became a second door to the same loss. Re-arm the overflow guard;
        // only the shrink guard is dropped, which is the whole point of the retry. The
        // append-base guard is deliberately NOT re-armed: reaching this branch requires
        // `isPlainReplace`, hence no append, so it could never fire here anyway — and
        // arming an inert guard would break the invariant that this retry runs unguarded
        // except where a real loss is possible.
        //
        // EI-21851633473920728: an explicit rowsMode:'replace' keeps its replace
        // semantics through this retry (see `checksAdditiveOnThisWrite` above), so a
        // retry whose supplied rows would retire carried ones — without confirmRetire —
        // must still be able to REFUSE, exactly like the first attempt. Left uncaught,
        // that refusal would escape as an unhandled rejection instead of the same
        // `checkpoint_replace_would_drop_rows` response the first attempt returns.
        if (res.blockedReason?.includes('plain replace would shrink') && isPlainReplace && !wantsConfirmShrink) {
          preservePriorOnShrink = true;
          try {
            res = await setWorkItemCheckpointWithPrior(
              { harness, workItemId: it.id, workspaceId },
              checkpointToStore,
              {
                ...(typeof checkpointToStore === 'string' ? { latestUpdate: checkpointToStore } : {}),
                ...(item ? { workItem: item as WorkItemSubject } : {}),
                ...(checksTransform ? { transform: checksTransform } : {}),
                writerOwnerId: ident.ownerId,
                guard: composeGuards(bodyPreservationGuard, overflowGuard),
                ...depsOpt,
              },
            );
          } catch (error) {
            if (error instanceof FrozenCarryCheckpointError) return { ...error.payload, id: it.id };
            if (error instanceof RetireIdsMismatchError) return retireIdsMismatchResponse(error);
          if (error instanceof ReplaceWouldDropError) return replaceWouldDropResponse(error);
            if (error instanceof OrgTxnTimeoutError || error instanceof DbCallDeadlineError) return timeoutResponse(error);
            throw error;
          }
        }
        stored = res.stored;
        priorLength = res.priorLength;
        blockedReason = res.blockedReason;
        const depsWarnings = res.depsWarnings;
        const depsStamped = res.depsStamped;
        const depsRecomputed = res.recomputed;
        if (blockedReason) {
          // WI-7190: the append guard's reason already carries its own leading error
          // code (`append_base_unreadable — …`) — don't relabel it `shrink_blocked`,
          // it isn't a shrink, it's the append's pre-read disagreeing with the
          // authoritative prior. Anything WITHOUT its own code (the plain-replace
          // guard's message, or a caller-supplied reason in a test double) keeps the
          // original `shrink_blocked — ` prefix unchanged.
          const hasOwnCode = /^[a-z][a-z0-9_]*\s+—\s/.test(blockedReason);
          const errorCode = hasOwnCode ? blockedReason.split(' — ', 1)[0] : 'shrink_blocked';
          const bodyRecoveryArg =
            typeof checkpoint === 'string' && checkpoint.length > 0 ? { checkpoint } : {};
          return {
            ok: false as const,
            id: it.id,
            error: hasOwnCode ? blockedReason : `shrink_blocked — ${blockedReason}`,
            errorCode,
            // EI-20185430154274838: the guard is correct, but an error string alone
            // makes the normal successor-note recovery shape discoverable only after
            // a failed call and a second read of prose. Keep both choices explicit:
            // append preserves the detailed prior; confirmShrink is the deliberate
            // full-replacement escape hatch. `append:false` is included on replace
            // because this option also serves append_base_unreadable failures.
            // Preserve the caller's original body in the retry args. The guarded
            // write did not change the stored checkpoint, so replaying that original
            // body without checks is the actionable body-only recovery. Omitting it
            // would turn an append with a fresh finding into a checks-only no-op and
            // silently discard the finding when the caller follows the structured
            // recipe.
            recovery: {
              append: {
                args:
                  errorCode === 'append_checks_overflow'
                    ? additiveRowsMode && !wantsAppend
                      ? { ...bodyRecoveryArg, rowsMode: 'merge', checks: [] }
                      : { ...bodyRecoveryArg, append: true, checks: [] }
                    : errorCode === 'checks_body_overflow'
                      ? { checks: [] }
                      : { append: true },
                description:
                  errorCode === 'append_checks_overflow'
                    ? 'Retry as an additive body-only append (omit checks or pass checks: []) after separately retiring stale rows if needed.'
                    : errorCode === 'checks_body_overflow'
                      ? 'Retry without checks to preserve the narrative body, or shorten the checks before retrying the metadata patch.'
                      : 'Join this submitted checkpoint onto the existing note and preserve its prior content.',
              },
              replace: {
                args: { append: false, confirmShrink: true },
                description: 'Replace the prior note only when this checkpoint contains the complete intended body.',
              },
            },
            ...(errorCode === 'append_checks_overflow' && appendChecksOverflowDiagnostics.length > 0
              ? {
                  // Keep `checksDropped` as the established human-readable string
                  // list. `checksDroppedRows` is the structured recovery diagnostic:
                  // it carries the exact stored row (including the parser's stable,
                  // sanitized id) instead of forcing a caller to reconstruct one
                  // from a possibly reworded claim.
                  checksDropped: appendChecksOverflowDiagnostics.map((row) =>
                    row.claim.length > 300 ? `${row.claim.slice(0, 300)}…` : row.claim,
                  ),
                  checksDroppedRows: appendChecksOverflowDiagnostics,
              }
              : {}),
            ...(unmatchedCheckRefs.length > 0
              ? {
                  unmatchedRowRefs: unmatchedCheckRefs,
                  unmatchedRowRefsNote:
                    'These `replaces` refs named no carried check row (match is by [#id] or EXACT claim text). ' +
                    'An unmatched row was treated as a new addition and was not written because this additive ' +
                    'write would exceed the checks cap.',
                }
              : {}),
            ...(errorCode === 'append_body_overflow' && appendBodyOverflowDetails
              ? { appendBodyOverflowDiagnostics: appendBodyOverflowDetails }
              : {}),
          };
        }
        // agent-activity-liveness-truth P-001 (D-001/D-004): a non-clear checkpoint write
        // is REAL item-scoped progress — credit it so the item reads as `progressing`, not
        // `stalled`. Fire-and-forget + fail-soft (each swallows errors and no-ops on the
        // wrong family / a holderless row) so a progress bump never breaks the checkpoint
        // write. WI-3006: markFeatureProgress only matches feature-family rows and
        // markIssueProgress only matches issue-family (bug/change/task) rows — item_kind is
        // mutually exclusive between them, so firing both unconditionally is a harmless
        // no-op on whichever one doesn't apply (no need to look up the item's kind first).
        if (stored !== null) {
          void markFeatureProgress(harness ?? '', it.id);
          void markIssueProgress(it.id);
        }
        // P-003 (fleet-deltas-leader-primitives-2026-07-10): TRUE read-after-write
        // through the SAME path a future reader uses (getWorkItemCheckpoint, same
        // canonicalized ref). contentHash-of-the-returned-string (EI-8987) proves the
        // store ECHOED the write, but not that a future READ resolves the row — and
        // the real silent-loss class (WI-3549 / EI-8805 / EI-8824 / EI-9013) was
        // precisely write/read KEY divergence. A verify miss fails THIS item loudly
        // at write time instead of being discovered post-compaction.
        let readBack: string | null = null;
        let readBackError: unknown;
        let readBackFailed = false;
        if (stored !== null) {
          try {
            readBack = await getWorkItemCheckpoint({ harness, workItemId: it.id, workspaceId });
          } catch (error) {
            // EI-22707338795824591: the write transaction has already COMMITTED by
            // the time this verifier runs. Collapsing a reader exception to `null`
            // made transient DB contention indistinguishable from a genuine key miss,
            // then told callers to retry the WRITE. That is destructive guidance for
            // append:true: replaying the call can append the same update twice. Keep
            // verifier unavailability distinct and point recovery at a read-only get.
            readBackError = error;
            readBackFailed = true;
          }
          const verifyRecovery = {
            verify: {
              tool: 'work_items:get',
              args: {
                id: it.id,
                ...(harness ? { harness } : {}),
                detail: true,
                threadLimit: 0,
              },
              expectedContentHash: shortHash(stored),
              description:
                'Read the already-committed checkpoint without replaying this write, then compare checkpointContentHash with expectedContentHash.',
            },
          };
          if (readBackFailed) {
            const verifierMessage = readBackError instanceof Error ? readBackError.message : String(readBackError);
            return {
              ok: false as const,
              id: it.id,
              error:
                `checkpoint_verify_unavailable — the checkpoint write committed, but the verifier read failed ` +
                `(${verifierMessage}). Do NOT retry this write: append:true could duplicate the submitted update. ` +
                'Use recovery.verify to confirm the committed checkpoint through the reader path.',
              errorCode: 'checkpoint_verify_unavailable',
              retryable: false,
              writeCommitted: true,
              storedLength: stored.length,
              storedContentHash: shortHash(stored),
              recovery: verifyRecovery,
            };
          }
          if (readBack !== stored) {
            return {
              ok: false as const,
              id: it.id,
              error:
                `checkpoint_verify_failed — the write did not read back via the reader path ` +
                `(stored ${stored.length} chars, read back ${readBack === null ? 'null' : `${readBack.length} chars`}). ` +
                'The write committed, but its visibility is not verified. Do NOT retry this write: append:true could ' +
                'duplicate the submitted update. Use recovery.verify to inspect the committed checkpoint.',
              errorCode: 'checkpoint_verify_failed',
              retryable: false,
              writeCommitted: true,
              storedLength: stored.length,
              storedContentHash: shortHash(stored),
              readBackContentHash: readBack === null ? null : shortHash(readBack),
              recovery: verifyRecovery,
            };
          }
        }
        // EI-22386514939689944: the checkpoint body is the successor's source
        // of truth for what landed. Reuse the `dependsOn` file resolver against
        // paths found in narrative prose, after verify-read proves the bytes
        // that will be handed over. Explicit null tokens are advisory only;
        // resolver failures stay fail-open inside the helper.
        const prosePathLint =
          stored !== null ? await unresolvedProsePathsInCheckpoint(stored, { workspaceId, harness }) : undefined;
        // ── P-017: the durable half, posted to the effort thread in this same call ──
        // Deliberately AFTER the read-back verify, and fail-soft: the checkpoint is the
        // thing a successor cannot do without, so a thread that refuses a post must
        // never fail the checkpoint that accompanied it. The result says what happened
        // rather than swallowing it.
        const learnedText = (it.learned ?? args.learned ?? '').trim();
        let learnedResult: Awaited<ReturnType<typeof postLearnedAtLevel>> | null = null;
        if (learnedText) {
          learnedResult = await postLearnedAtLevel({
            workItemId: it.id,
            level: it.learnedLevel ?? args.learnedLevel,
            text: learnedText,
            harness,
            authorId: ident.ownerId,
            workspaceId,
          }).catch(() => null);
        }
        // ── D-010: run the READER'S extractor at WRITE time and hand back what it
        // found. No gate, no rejection, no new required args — the writer's inability
        // to SEE the gap is the actual mechanism, and an agent re-reading its own note
        // finds it clear because it still holds the context the note depends on.
        //
        // Fires only on a SUBSTANTIAL note. A two-line progress refresh has no root
        // cause to omit, and an advisory that fires on every write is one nobody reads
        // — which is the D-004 failure this is trying to avoid, not repeat.
        const captureAdvisory =
          stored !== null && stored.length >= CAPTURE_ADVISORY_MIN_CHARS ? describeCaptureGaps(stored) : null;
        // ── EI-19908952124502298: the same dangling-ref advisory `comment`/`complete`/
        // `update` already carry, extended to the checkpoint writer. A checkpoint is the
        // single surface a cold successor trusts WITHOUT re-checking, so a phantom
        // EI-/WI- id here is the most expensive place for one to land — and the writer
        // is exactly who cannot see it, because the id was minted in the same step that
        // cited it.
        //
        // ADVISORY, never a gate: `unresolvedRefsInBody` returns undefined when it
        // cannot judge, and the checkpoint is the thing a successor cannot do without,
        // so a ref probe that fails must never fail the write that carried it. The
        // proposal's blocking PreToolUse hook was deliberately NOT built — it would sit
        // on one client's edit path while ptool/MCP/API write straight past it, and
        // ref resolution here is workspace-scoped and fail-soft, so a false "does not
        // exist" would block a legitimate federated ref.
        const unresolvedRefs = stored !== null ? await unresolvedRefsInBody(stored, { known: [it.id] }) : undefined;
        const unresolvedRefsWarningText = unresolvedRefs ? unresolvedRefsWarning(it.id, unresolvedRefs.missing) : undefined;
        // EI-22995965169175295: inspect the FINAL stored carry-note so qualified
        // decision refs retained from earlier compaction hops are covered too.
        // Bare D-NNN stays unknown because decision ids are plan-local. The
        // advisory is strictly fail-open and never changes checkpoint success.
        const decisionRefAdvisory =
          stored !== null
            ? await unresolvedPlanDecisionRefs(stored, {
                workspaceId,
                harnessSlug: harness,
              }).catch(() => undefined)
            : undefined;
        return {
          ok: true as const,
          id: it.id,
          harness,
          cleared: stored === null,
          length: stored?.length ?? 0,
          contentHash: stored !== null ? shortHash(stored) : null,
          ...(learnedResult
            ? {
                learned: {
                  posted: learnedResult.posted,
                  level: learnedResult.level,
                  ref: learnedResult.ref,
                  ...(learnedResult.fellBack
                    ? {
                        note: `this item has no ${learnedResult.requestedLevel} ancestor — the lesson was written at ${learnedResult.level} instead (nothing was dropped)`,
                      }
                    : {}),
                  ...(learnedResult.skipped ? { skipped: learnedResult.skipped } : {}),
                },
              }
            : {}),
          ...(captureAdvisory?.note ? { captureAdvisory: captureAdvisory.note } : {}),
          ...(unresolvedRefsWarningText ? { unresolvedRefsWarning: unresolvedRefsWarningText } : {}),
          ...(decisionRefAdvisory ? { decisionRefAdvisory } : {}),
          ...(prosePathLint ? { prosePathLint } : {}),
          /** P-003: verified = the stored text READ BACK byte-identically via the reader
           *  path (null on a clear — nothing to verify). */
          verified: stored !== null ? (true as const) : null,
          /** P-003: first 80 chars of what was stored — eyeball-check without a re-read. */
          storedHead: stored !== null ? stored.slice(0, 80) : null,
          /**
           * EI-19298690705878336: how many `## Checks` rows the stored note ended up
           * carrying. Read back off `stored` rather than counting the caller's input, so
           * it reflects what the store actually WROTE instead of what was passed in.
           * EI-19460631385508515: note this is NOT evidence of a union — a supplied list
           * REPLACES the set, so this can legitimately come back LOWER than the count you
           * had stored. `checksDropped` below names what went missing.
           *
           * EI-20004424625703051: it can come back lower on an APPEND too, for the other
           * reason — the union overflowed the CARRY_NOTE_MAX_CHECKS cap and the carried
           * tail was evicted. So a count below what you stored does not by itself tell
           * you which of the two happened; read `checksDroppedNote`, which now says.
          */
          checks: stored !== null ? splitCarryNoteChecks(stored).checks.length : 0,
          ...(legacyChecksNormalization.truncatedFields > 0 || legacyChecksNormalization.droppedRows > 0
            ? {
                legacyChecksNormalization: {
                  truncatedFields: legacyChecksNormalization.truncatedFields,
                  droppedRows: legacyChecksNormalization.droppedRows,
                  note:
                    'Legacy carried check rows were bounded only because their serialized section left no room ' +
                    'for the submitted append body. The append body was preserved; any yielded rows are listed in ' +
                    '`checksDropped`.',
                },
              }
            : {}),
          /**
           * EI-18741016606334594: `✓VERIFIED` rows whose claim is quantified beyond what
           * their own recheck can observe. Read off the STORED note (like `checks` above)
           * rather than the caller's input, so it reports what a successor will actually
           * be re-injected with. Advisory + fail-open; absent when nothing was flagged,
           * so the common result shape is unchanged. Same rationale as the loop:checkpoint
           * leg: a work-item checkpoint is re-injected into whoever picks the item up
           * next, and an over-broad ✓ is read there as settled fact.
           */
          ...(() => {
            try {
              if (stored === null) return {};
              const rows = detectScopeOverreach(splitCarryNoteChecks(stored).checks);
              return rows.length > 0
                ? {
                    scopeLint: {
                      flagged: true as const,
                      note:
                        'scope_lint: a ✓VERIFIED row claims MORE than its own re-check can observe. The badge ' +
                        'is what the next holder reads INSTEAD of re-checking. Narrow the claim to what the ' +
                        'probe saw, or widen the probe and re-run it. Advisory only; the write was kept.',
                      rows,
                    },
                  }
                : {};
            } catch {
              return {};
            }
          })(),
          /**
           * R-6(b) (acceptance-machinery-seam-fixes-2026-09-16): a relative
           * `scratchpad/...` reference in the stored note is unresolvable to the next
           * holder — the session scratchpad is absolute and per-session. Read off the
           * STORED note, like its siblings, so it reports what a successor is actually
           * re-injected with. Advisory + fail-open.
           */
          ...await (async () => {
            try {
              if (stored === null) return {};
              const refs = await filterTrackedRelativeScratchPaths(splitCarryNoteChecks(stored).body, {
                workspaceId,
                harness,
              });
              return refs.length > 0
                ? { scratchPathLint: { flagged: true as const, note: RELATIVE_SCRATCH_ADVISORY, refs } }
                : {};
            } catch {
              return {};
            }
          })(),
          /**
           * WI-7238: the work-item-scoped checkpoint is the sibling of
           * loop:checkpoint's carry note: a future holder receives this prose as its
           * continuity authority. Flag only absence assertions supplied by THIS call,
           * and suppress them when the final stored check rows already carry a matching
           * falsifier. Advisory + fail-open; the write is never lost to a lint fault.
           */
          ...(() => {
            try {
              if (stored === null || typeof checkpoint !== 'string' || !checkpoint.trim()) return {};
              const submittedBody = splitCarryNoteChecks(checkpoint).body;
              const probeText = splitCarryNoteChecks(stored).checks.map(renderCheckLine).join('\n');
              const claims = uncoveredAbsencePremises(submittedBody, 'carry-note', probeText);
              return claims.length > 0
                ? {
                    absenceLint: {
                      flagged: true as const,
                      note:
                        'absence_lint: this checkpoint asserts that something DOES NOT EXIST. The next holder ' +
                        'will receive it as continuity authority, so run each recheck now. If it holds, park the ' +
                        'claim and evidence in checks:[{ claim, recheck, verified }]; if it does not, correct the ' +
                        'checkpoint before handoff. Advisory only; the write was kept.',
                      claims,
                    },
                  }
                : {};
            } catch {
              return {};
            }
          })(),
          /**
           * EI-23771449112267271: warn-only — a ✓ row WRITTEN IN THIS CALL with no falsifier
           * (same contract as facts:assert `recheckMissing` and loop:checkpoint's
           * `falsifierMissing`). Scoped to the SUPPLIED rows so legacy carried rows never nag;
           * `sampleAdequate:false` rows are already downgraded to ? and are skipped by the helper.
           */
          ...(() => {
            try {
              const missing = checksMissingFalsifier(suppliedChecks ?? []);
              return missing.length > 0
                ? { falsifierMissing: { flagged: true as const, note: FALSIFIER_MISSING_NOTE, rows: missing } }
                : {};
            } catch {
              return {};
            }
          })(),
          /**
           * EI-19455262557905604: `checks` carries the VERIFIED-vs-PREDICTED
           * distinction and has done since 2026-08-02 — but 8.8% of the 10,475
           * work-item carry-notes here use it, and only 6.75% of the last 14 days',
           * so adoption is not rising. The field is not missing; it is INVISIBLE at
           * the moment it is actionable (an su read this very tool 40h after it
           * shipped, concluded the distinction did not exist, and filed to build it).
           *
           * So surface it exactly where D-098 surfaced `loop:arm`'s `blockedOn`: at
           * the one write whose prose is a PREDICTION wearing measurement's clothes —
           * a run the writer says is still in flight, with the output living in a log
           * they have not read, and no check row to mark it unverified. Measured
           * firing rate 132/10,475 = 1.26%, which is what keeps it readable rather
           * than the every-write advisory D-004 warns about.
           *
           * Advisory + fail-open, like its siblings above; the write is never lost to
           * a lint fault, and absent when nothing was flagged so the common result
           * shape is unchanged.
           */
          ...(() => {
            try {
              if (stored === null || typeof checkpoint !== 'string' || !checkpoint.trim()) return {};
              const submittedBody = splitCarryNoteChecks(checkpoint).body;
              const advisory = describeUnreadRun(submittedBody, splitCarryNoteChecks(stored).checks.length);
              return advisory ? { unreadRunLint: advisory } : {};
            } catch {
              return {};
            }
          })(),
          /**
           * EI-19460631385508515: stored check claims this write DROPPED — present only
           * when a supplied `checks` list omitted rows that were already stored, so an
           * unaffected result's shape is unchanged (same convention as `repairs`). The
           * write SUCCEEDS either way; this reports a loss, never a refusal. Claims are
           * truncated for the reply — they identify WHICH row went, they are not a
           * restore payload.
           *
           * EI-20004424625703051: there are TWO distinct causes and they need DIFFERENT
           * remedies, so the note branches. A plain write drops because a supplied list
           * REPLACES. An APPEND write unioned correctly and then overflowed the
           * CARRY_NOTE_MAX_CHECKS cap, which evicts the CARRIED tail (supplied rows are
           * ordered first in `effectiveChecks`). Emitting the replace text on an append
           * is not a cosmetic slip: it names a cause that did not occur, and its remedy
           * ("re-send the FULL set") is UNACHIEVABLE there, because the full set is by
           * definition over the cap and `checks` is `.max(CARRY_NOTE_MAX_CHECKS)` — the
           * call is rejected as invalid_input. Measured: a caller followed that text to
           * the conclusion that append-union was broken and filed it as a union bug,
           * when the union had worked and the cap was the whole mechanism.
           */
          ...(droppedCheckClaims.length
            ? {
                checksDropped: droppedCheckClaims.map((c) => (c.length > 300 ? `${c.slice(0, 300)}…` : c)),
                checksDroppedNote:
                  legacyChecksNormalization.truncatedFields > 0 || legacyChecksNormalization.droppedRows > 0
                    ? `LEGACY BYTE NORMALIZATION, not a replace and not your mistake: the carried checks were ` +
                      `bounded to preserve the submitted append body. ${legacyChecksNormalization.truncatedFields} ` +
                      `carried field(s) were shortened and ${droppedCheckClaims.length} carried row(s) yielded; ` +
                      `the append body was retained and the yielded claims are listed above.`
                    : legacyOverCapNormalization.legacyExcess > 0
                    ? `LEGACY CAP NORMALIZATION, not a replace and not your mistake: this checkpoint was already ` +
                      `carrying ${legacyOverCapNormalization.legacyExcess} row(s) MORE than the ${CARRY_NOTE_MAX_CHECKS}-row cap before ` +
                      `your write — a pre-existing state that used to make every additive write to this note refuse ` +
                      `permanently (EI-21534719386975911). The write was accepted and the note normalized to the cap ` +
                      `instead: your ${suppliedChecks?.length ?? 0} row(s) were kept first, and ${droppedCheckClaims.length} carried row(s) ` +
                      `yielded — ? PREDICTED rows before ✓ VERIFIED ones, so the evidence-bearing rows survived. This ` +
                      `is a ONE-TIME normalization of this note; it now fits, and subsequent writes evict nothing. ` +
                      `The claims are listed above — re-send any that still matter.`
                    : additiveChecks
                      ? `CAP EVICTION, not a replace: ${wantsAppend ? '`append`' : "`rowsMode:'merge'`"} UNIONED your ${suppliedChecks?.length ?? 0} row(s) onto ` +
                        `the stored set, the union exceeded the ${CARRY_NOTE_MAX_CHECKS}-row cap, and ` +
                        `${droppedCheckClaims.length} CARRIED row(s) were evicted from the tail (supplied rows are kept ` +
                        `first). Re-sending the full set CANNOT fix this — that set is over the cap and would be ` +
                        `rejected as invalid_input. To keep them: RETIRE rows you no longer need in a separate plain ` +
                        `write (no \`append\`, send only the survivors), then append; or pass no \`checks\` at all to ` +
                        `leave the stored rows untouched.`
                      : `a supplied \`checks\` list REPLACES the stored set — ${droppedCheckClaims.length} stored ` +
                        `claim(s) were not in this write and are now gone. Re-send the FULL set you want carried ` +
                        `(a re-sent claim inherits its prior recheck/verified), or pass no \`checks\` at all to leave ` +
                        `the stored rows untouched.`,
              }
            : {}),
          ...(unmatchedCheckRefs.length > 0
            ? {
                unmatchedRowRefs: unmatchedCheckRefs,
                unmatchedRowRefsNote:
                  'These `replaces` refs named no carried check row (match is by [#id] or EXACT claim text). ' +
                  'An unmatched row was treated as a new addition.',
              }
            : {}),
          ...(suppliedChecksNotRetained.length > 0
            ? {
                checksNotRetained: suppliedChecksNotRetained.map((row) =>
                  row.claim.length > 300 ? `${row.claim.slice(0, 300)}…` : row.claim,
                ),
                checksNotRetainedRows: suppliedChecksNotRetained.map((row) => {
                  const id = sanitizeCarryRowId(row.id);
                  return {
                    ...(id ? { id } : {}),
                    claim: row.claim.trim(),
                    ...(row.recheck?.trim() ? { recheck: row.recheck.trim() } : {}),
                    ...(row.falsifier?.trim() ? { falsifier: row.falsifier.trim() } : {}),
                    ...(row.verified?.trim() ? { verified: row.verified.trim() } : {}),
                    ...(row.contested?.trim() ? { contested: row.contested.trim() } : {}),
                  };
                }),
                checksNotRetainedNote:
                  `BODY PRESERVED: the checkpoint body and all carried checks were stored atomically, but ` +
                  `${suppliedChecksNotRetained.length} supplied check row(s) could not fit within the ` +
                  `${CARRY_NOTE_MAX_CHECKS}-row cap. Existing supplied rows were updated in place and new rows used ` +
                  'only vacant slots; the rows named above were not stored. Retire stale rows explicitly before ' +
                  're-sending any that still matter.',
              }
            : {}),
          /**
           * EI-19400299440742193: every soft-cap TRIM this write applied, so a caller
           * can see exactly what was shortened. Absent entirely when nothing was
           * trimmed (the common case), so an unaffected result's shape is unchanged.
           * The write SUCCEEDS either way — this reports a repair, never a refusal.
           */
          ...(repairs.length ? { repairs } : {}),
          // EI-20232176364474286: the shrink guard refused the first plain write,
          // then the safe locked retry preserved the prior as an append. Surface the
          // mode so callers do not mistake the returned history for a replacement.
          ...(autoAppendedRefresh
            ? (() => {
                const base =
                  'the concise replacement would have shrunk a substantial checkpoint, so the prior history was preserved ' +
                  'BENEATH your note (newest-first): your text is the storedHead that cold-wake excerpts surface, and the ' +
                  'superseded detail sits after the --- separator. Pass confirmShrink:true only when discarding that history is intentional.';
                /**
                 * EI-20745229385305334: this preserve-by-default is INVERTED for the one case
                 * where the shrink was deliberate — a checkpoint that RETRACTS its own prior
                 * conclusion. A correction is systematically SHORTER than the investigation
                 * that produced it, so the guard fires hardest exactly when appending is most
                 * harmful, and the stored note ends up asserting both the new finding and the
                 * directive it was withdrawing.
                 *
                 * Both halves of that reading were already computed on this same call —
                 * `autoAppended` here and the lint over the preserved bytes below — but they
                 * were emitted as separate keys, so the joined reading was never the default
                 * one. The measured miss (WI-39655) is that the preserved directive surfaced
                 * only as a generic `provenanceLint` tagging nit, which reads as a style
                 * nudge rather than "you just resurrected an instruction you were retracting".
                 * Joining them changes no behaviour and adds no durable surface; it just
                 * reports the two facts in the same breath, where they mean something.
                 */
                const resurrected = retainedDirectiveMatches(stored, currentProvenanceText);
                if (resurrected.length === 0) {
                  return { autoAppended: true as const, autoAppendedNote: base };
                }
                // Name at most two lines inline to keep the note readable; the structured
                // field below carries every match for a caller that wants them all.
                const quoted = resurrected
                  .slice(0, 2)
                  .map((m) => `"${m.line}"`)
                  .join('; ');
                return {
                  autoAppended: true as const,
                  autoAppendedNote:
                    `${base} ⚠ THE PRESERVED TEXT CARRIES ${resurrected.length} STANDING DIRECTIVE(S) — ${quoted}` +
                    `${resurrected.length > 2 ? ` (+${resurrected.length - 2} more)` : ''}. If THIS write RETRACTS ` +
                    'or supersedes that instruction, the stored checkpoint now asserts BOTH your note and the ' +
                    'directive you meant to withdraw — and a successor cannot tell which is live, because the stale ' +
                    'one is phrased as an order while your retraction is phrased as a report. Re-send with ' +
                    'confirmShrink:true to replace it outright.',
                  autoAppendedRetainedDirectives: resurrected,
                };
              })()
            : {}),
          by: ident.ownerId,
          // P-007/D-013: what the freshness axis recorded for this write. Absent
          // entirely when the caller declared nothing (the common case today), so
          // an undeclared checkpoint's result shape is unchanged.
          ...(depsStamped !== undefined ? { depsStamped } : {}),
          ...(depsRecomputed
            ? {
                recomputed: true as const,
                recomputedNote:
                  'the checkpoint this replaced had already gone stale (a declared dependency had moved), so ' +
                  'readers are told this note was rebuilt after its world changed rather than being continuously valid.',
              }
            : {}),
          ...(depsWarnings
            ? {
                depsWarnings,
                depsWarningNote:
                  'these declared dependencies were NOT stamped — a dependency that cannot resolve would look ' +
                  'declared but could never invalidate, so it is dropped rather than silently kept. Fix the ref ' +
                  'and re-declare.',
              }
            : {}),
          // WI-3801 lint + P-014 turn-ref verification/origin stamp — warn-only,
          // absent (no fields) on the overwhelming common clean case. Lint the
          // submitted text separately from final stored bytes so inherited history
          // is visible under `retainedProvenance`, not `provenanceLint`.
          ...(stored !== null
            ? await carryProvenanceFields(currentProvenanceText, ident.ownerId, {
                retainedText: retainedProvenanceText(stored, currentProvenanceText),
                precomputedStamp: preWriteStamp,
                successfulActions,
              })
            : {}),
          // EI-9325: warn-only nudge — a plain replace-on-write that shrank the
          // checkpoint by more than half, off a substantial prior checkpoint, usually
          // means an accidental placeholder/truncated paste rather than an
          // intentional rewrite. Never blocks; undefined on every clean write
          // (the overwhelming common case) or when there's nothing suspicious to flag.
          ...(stored !== null && priorLength !== null && priorLength > 500 && stored.length < priorLength * 0.5
            ? {
                shrinkWarning:
                  `This write is ${stored.length} chars, down from ${priorLength} chars previously stored. ` +
                  `If you meant to PRESERVE the prior content (e.g. prepending a new section), verify you pasted ` +
                  `it verbatim rather than a placeholder/marker — a large shrink like this usually means accidental ` +
                  `truncation (EI-9325). If the shrink is intentional, ignore this.`,
              }
            : {}),
          // EI-19395730805289668: this note DECLARES an owner pause, but the item carries no
          // claim hold — so the pause is prose the claim path cannot read, and
          // scheduler:get_next will keep serving the item (measured 2026-08-03T02:05Z).
          //
          // Warn-only, and deliberately NOT an auto-hold: two corpus items sat open-and-
          // "paused" for weeks on SITUATIONAL directives that had long expired, so silently
          // converting prose into an enforced hold would have made those worse. The author is
          // the only one who knows which case they are in, and they know it right now.
          //
          // No extra read: `item` is already loaded above (the not_holder guard). A null item
          // (unresolvable id) or one already held stays SILENT — an unknown hold state must
          // not be reported as an absent one, or this nags the authors who did it correctly.
          ...(stored !== null && item && !isClaimHoldParked(item.payload)
            ? (() => {
                const declared = detectPauseDeclaration(stored);
                return declared ? { pauseNotEnforcedWarning: pauseNotEnforcedWarning(declared) } : {};
              })()
            : {}),
          ...(rowsMode !== 'replace' ? { rowsMode } : {}),
          ...(rowsMode === 'merge' && additiveRowsMode && rawSuppliedChecks?.length === 0
            ? {
                rowsModeNote:
                  "rowsMode:'merge' (the default) treats an empty `checks` list as a NO-OP — carried rows are untouched. Use " +
                  "rowsMode:'replace' with checks:[] to clear them.",
              }
            : {}),
        };
      },
      { keyOf: (it) => ({ id: it.id }) },
    );
    return bulkContent(env);
  },
});
