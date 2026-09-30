/**
 * carry-note — the ONE shared "note to my next self" substrate + shape
 * (su-cold-auto-mode-2026-07-03 Phase 1 / P-001; D-004 — the linchpin +
 * precondition for cold-auto).
 *
 * Converges the THREE per-role carry mechanisms that already do this job into a
 * single durable PG store (`harness_shared.carry_notes`, mig 472) and one
 * structured shape:
 *   - the Queen carry-journal  (pot:declare-wake { remember } → setHiveCarryNote)
 *   - the bee checkpoint        (work_items:checkpoint → setWorkItemCheckpoint)
 *   - the su loop carry-note     (the SU AUTO loop's cold-wake anchor, P-002)
 *
 * A COLD wake (fresh-context reset or a recycle — Phase 2) reads its carry-note to
 * reconstruct working state instead of re-reading a grown transcript. Cold-start
 * is only as safe as what this captures, so the substrate lands FIRST and the
 * mechanism (Phase 2) builds on it.
 *
 * SEMANTICS (the shared D-003 contract, formerly duplicated in setHiveCarryNote +
 * setWorkItemCheckpoint): `note` is the current full state — any length (TEXT, no
 * cap), REPLACE-on-write; a blank/omitted/null note CLEARS `note` (the reader
 * re-derives from its floor — graceful degradation). Every non-blank write APPENDS
 * a capped entry to a bounded `journal` ring so the reasoning TRAJECTORY survives
 * a clear (the Queen carry-JOURNAL behavior, generalized to all three). A row with
 * a null note AND an empty journal is deleted. Durable PG, inspectable. LOCAL
 * working state — never federated.
 *
 * SCOPE: a stable, role-discriminated string key so the one store keys every
 * carrier — use the {@link hiveScope} / {@link workItemScope} / {@link loopScope}
 * constructors. Keyed (workspace_id, scope); the workspace_id column carries
 * workspace isolation.
 */
import { createHash } from 'node:crypto';
import { getOrgPg } from '@papercusp/db-org';
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';
import type { Sql, TransactionSql } from 'postgres';
import { boundedOrgTxn } from './pg-bounded-txn';
import { boundedPgReadTxn } from './pg-read-query';
import { concreteWorkspaceIdOrNull, resolveConcreteWorkspaceId } from './workspace-registry';
import {
  PROBE_SCOPE_MARKER_RE,
  describeProbeScope,
  renderProbeScopeMarker,
  stripProbeScopeMarker,
} from './carry-note-probe-scope';
import { notifyAgentOrdersChanged } from './agent-orders-notify';
import { decodeContinuityProbe, encodeContinuityProbe, type ContinuityProbe } from './continuity-probes';
import {
  computeFreshness,
  parseDeclaredDeps,
  type DeclaredDeps,
  type FreshnessResult,
} from './freshness';
import { resolveCurrentTokens } from './freshness/resolvers';
import { stampDeclaredDeps } from './freshness/stamp';

/**
 * First 12 hex chars of sha256(text) — short enough to eyeball, long enough that an
 * accidental collision between two DIFFERENT carry-note bodies is not a real concern.
 * Shared home for the hash BOTH carry-note-backed checkpoint tools (work_items:checkpoint,
 * loop:checkpoint) use so a caller can eyeball-confirm a write without a second read.
 */
export function shortCarryHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12);
}

// ── Scope keys (the convergence axis) ────────────────────────────────────────

/** The Queen's per-workspace carry-note. The workspace_id column disambiguates,
 *  so no workspace suffix is needed. */
export function hiveScope(): string {
  return 'hive';
}

/** A bee's work-item-scoped checkpoint — lives on the item so an evicted bee's
 *  successor inherits it (bee-context-efficiency D-002). */
export function workItemScope(harness: string, workItemId: string): string {
  return `workitem:${harness}:${workItemId}`;
}

/** An su AUTO loop's carry-note, keyed by the owner id the loop wakes (stable
 *  across a fresh-context RESET and a RECYCLE — PAPERCUSP_SID is preserved, P-004). */
export function loopScope(harness: string, ownerId: string): string {
  return `loop:${harness}:${ownerId}`;
}

// ── The structured shape — a "note to my next self" ──────────────────────────

/** An owner-gated / pending-decision COMMITMENT carried as a row, never prose
 *  (compaction-continuity-hardening-2026-07-07 P-006). Prose asks dissolve at a
 *  context boundary; a wall row survives it mechanically — rendered into every
 *  wake and every carry brief until explicitly cleared. */
export interface WallEntry {
  /** Stable identity, independent of wording (P-013) — see {@link carryRowKey}. */
  id?: string;
  /** The pending action / decision, stated concretely ("3 zombie PIDs await owner OK to kill"). */
  claim: string;
  /** A concrete re-check command a successor runs to test whether the wall still stands. */
  recheck?: string;
  /** Epoch ms the wall was first recorded — preserved across rewrites of the same claim. */
  sinceMs?: number;
}

/** A carried CLAIM about external state + the probe that falsifies it
 *  (cold-carry-system-hardening-2026-07-19 P-001/P-010) — the non-owner analog of a
 *  {@link WallEntry}. Root incident: a cold-carried instruction ("expect the hash to
 *  ROLL, count under the new hash") was executed to the letter into a wrong soak
 *  anchor because the note carried the conclusion WITHOUT its verification probe,
 *  while the walls (claim+recheck rows) never misled all night. A check row makes
 *  the probe travel with the claim — and distinguishes VERIFIED (evidence attached)
 *  from PREDICTED (a hypothesis the successor must re-check before relying on). */
export interface CheckEntry {
  /** Stable identity, independent of wording (P-013) — see {@link carryRowKey}. */
  id?: string;
  /** The claim about external state, stated concretely ("post-restart ticks stamp hash b01b01…"). */
  claim: string;
  /** A concrete probe a successor runs to falsify/confirm the claim before relying on it. */
  recheck?: string;
  /** Optional typed, schema-versioned replay probe. `recheck` remains the human
   * explanation; this envelope is data-only and is validated by checkpoint writers. */
  probe?: ContinuityProbe;
  /** Evidence pointer for a VERIFIED claim — what was observed, where ("tick 1944 @02:38Z, pg read").
   *  Absent ⇒ the claim renders as PREDICTED. */
  verified?: string;
  /** Observed context that does NOT affirm the claim (for example, "audit still pending").
   *  It remains visible on a ? PREDICTED row without acquiring verification authority. */
  observed?: string;
  /** Evidence that was supplied as verification but contains a contradiction marker
   *  (for example, "STILL RUNNING"). It renders as CONTESTED, never VERIFIED. */
  contested?: string;
  /** Epoch ms the check was first recorded — preserved across rewrites of the same claim. */
  sinceMs?: number;
}

/** FACTS, not a self-grade (D-004). All fields optional; a plain string is equally
 *  valid (the store is free TEXT). {@link renderCarryNote} produces the canonical
 *  template a cold successor knows how to read. */
export interface CarryNoteFields {
  /** what-I-did — the concrete progress this session/wake made. */
  did?: string;
  /** what's-left — the remaining work, in order. */
  left?: string;
  /** key-insight — the non-obvious thing a cold successor would waste time re-deriving. */
  insight?: string;
  /** next-action — the single concrete next step to take on the next wake. */
  next?: string;
  /** carried CHECKS — external-state claims as {claim, recheck} rows (P-001);
   *  rendered as a `## Checks` section of parseable one-line rows. */
  checks?: CheckEntry[];
  /** open WALLS — owner-gated commitments as rows (P-006); rendered as a `## Walls`
   *  section of parseable one-line rows, carried until explicitly cleared. */
  walls?: WallEntry[];
}

type CarryNoteTextKey = 'did' | 'left' | 'insight' | 'next';

const CARRY_NOTE_SECTIONS: ReadonlyArray<{ key: CarryNoteTextKey; heading: string }> = [
  { key: 'did', heading: 'Did' },
  { key: 'left', heading: 'Left' },
  { key: 'insight', heading: 'Key insight' },
  { key: 'next', heading: 'Next action' },
];

/** The walls section heading (P-006). Rendered LAST so the four narrative sections
 *  keep their positions for existing parsers/extractors. */
export const CARRY_NOTE_WALLS_HEADING = 'Walls';

/** Bound on carried wall rows — a wall set past this is a triage problem, not a note. */
export const CARRY_NOTE_MAX_WALLS = 12;

/** The checks section heading (P-001). Rendered after the narrative sections,
 *  before Walls (walls stay last — the established anchor position). */
export const CARRY_NOTE_CHECKS_HEADING = 'Checks';

/** Bound on carried check rows — same triage rationale as walls. */
export const CARRY_NOTE_MAX_CHECKS = 12;

/**
 * Hard cap on a STORED checkpoint body, in characters (EI-22659954682164298).
 *
 * This is the storage bound `work_items:checkpoint` enforces on the note it
 * persists, NOT a display budget: an append that would overflow it trims the
 * OLDEST content first and leaves a marker at the head of what survives. That
 * asymmetry is why this constant has to be readable from the READ side too.
 * `CARRY_NOTE_MAX_CHECKS` above gives check ROWS a pre-emptive headroom readout
 * (`checkpointChecks {count, cap, remaining}`), so a writer can see saturation
 * BEFORE writing; the body had no counterpart, and its only notice of eviction
 * was written into the body AFTER the content was already gone — a warning that
 * can never be acted on, only mourned.
 *
 * Deliberately NOT named `checkpointChars`: `get-shape.ts` already uses that
 * name (and `checkpointCharsPerRow`) for the per-tier DISPLAY CLIP budget, a
 * different quantity. Collapsing a display budget and a storage cap onto one
 * name is the same class of error this constant exists to close.
 */
export const CHECKPOINT_BODY_CAP_CHARS = 32000;

/**
 * SOFT caps on a carried row's sub-fields (WI-7264). These bound what gets
 * re-injected into EVERY future wake, so they stay tight — but they are enforced by
 * TRUNCATION, not rejection. The schema keeps a much looser hard `.max()` as a
 * sanity backstop; overage between the two is repaired and REPORTED.
 *
 * Why: a zod `.max()` rejects the WHOLE CALL, and these rows travel attached to a
 * ~6KB note. Measured over 6 days of real transcripts, one sub-field a few chars
 * over its cap discarded the entire accompanying note 53 times, costing 364,735
 * argument chars — paid twice, because the agent then rewrote and re-sent the note.
 * Truncating the offending field keeps the re-injection bound exactly where it was
 * while removing the double-write, and is the same repair-don't-refuse choice
 * already made by this file's JSON-string coercion and by
 * `rescueTaggedCarryNoteBlob` (whose comment notes a refusal left a cold wake with
 * no note at all).
 *
 * Truncation is never SILENT: the caller is told what was trimmed. The failure this
 * must not re-create is EI-18723223344390510, where a nested row quietly dropped
 * fields and destroyed a verified check's evidence with no signal.
 */
export const CARRY_ROW_SOFT_CAPS = { claim: 500, recheck: 300, verified: 300, observed: 300, contested: 300 } as const;

/** Soft cap on each narrative field (`did`/`left`/`insight`/`next`), same contract. */
export const CARRY_TEXT_SOFT_CAP = 8000;

/** Multiple of a soft cap at which the schema genuinely rejects. Past this the payload
 *  is not an overrun note, it is a mistake worth failing loudly. */
export const CARRY_CAP_HARD_MULTIPLE = 4;

/** Marker appended to a truncated field so a reader can SEE the cut in the note. */
export const CARRY_TRUNCATION_MARKER = '…[truncated]';

/** One repair applied to an incoming carry-note write, reported back to the caller. */
export type CarryArgRepair = {
  /** Dotted path of the repaired field, e.g. `checks[2].recheck`. */
  field: string;
  kind: 'truncated' | 'renamed' | 'downgraded';
  detail: string;
};

/**
 * Evidence markers that contradict the affirmative meaning of `verified`.
 *
 * A carried ✓ is a license for the next wake to skip its re-check, so a false ✓
 * is materially more dangerous than a false ?. Keep this detector deliberately
 * conservative: downgrade only high-confidence unresolved status phrases. A
 * substring is not enough: verified evidence may measure a negative state (for
 * example `no in-flight checkpoint`, `pending/backlog 0/511`, or a
 * `write-unverified` refusal code) and must remain VERIFIED when that measurement
 * itself is complete.
 */
const VERIFICATION_CONFLICT_PATTERNS: ReadonlyArray<RegExp> = [
  /\bstill\s+running\b/i,
  /\b(?:is|are|was|were|remains?|stays?|currently|still)\s+in[-\s]flight\b/i,
  /\b(?:an?|the|this)\s+in[-\s]flight\s+(?:run|job|deployment|deploy|task|operation|check|test|request|process)\b/i,
  /\b(?:status|state)\s*[:=]\s*(?:pending|outstanding|awaiting|unverified|in[-\s]flight)\b/i,
  /\b(?:is|are|was|were|remains?|stays?|currently|still)\s+(?:pending|outstanding|awaiting|unverified|not\s+verified)\b/i,
  /\b(?:pending|outstanding|awaiting|awaits)\s+(?:the\s+)?(?:final\s+)?(?:verdict|review|approval|response|completion|result|run|job|task|work)\b/i,
  /\bnot\s+(?:yet\s+)?(?:the\s+)?(?:final\s+)?(?:verdict|review|approval|response|completion|result)\b/i,
];

/**
 * A verification disclaimer is a contradiction even when it does not share a
 * subject noun with the claim. The row's `verified` field is the evidence for
 * the WHOLE claim, so phrases such as "B is NOT covered by this run" or "wants
 * a re-check" must not leave the row looking like a complete ✓. Keep this
 * separate from the unresolved-status patterns below: coverage gaps are not a
 * lifecycle state, and a claim can legitimately be *about* a coverage gap.
 */
const VERIFICATION_COVERAGE_DISCLAIMER_PATTERNS: ReadonlyArray<RegExp> = [
  /\b(?:not|does\s+not|did\s+not|isn't|aren't|wasn't|weren't|never)\s+(?:fully\s+)?(?:covered|included|exercised|tested|checked|verified|validated|measured)\b/i,
  /\b(?:uncovered|out[-\s]?of[-\s]?scope)\b/i,
  /\b(?:needs?|wants?|requires?)\s+(?:a\s+)?(?:fresh\s+)?re[-\s]?check\b/i,
];

/**
 * A check whose claim explicitly asserts the coverage limitation is not a
 * false ✓: "the producer tests are not covered by the prior run" can be
 * verified by evidence saying exactly that. This is intentionally narrow so
 * a broad health claim with a disclaimer in its evidence still downgrades.
 */
const CLAIM_EXPLICIT_COVERAGE_LIMIT_RE =
  /\b(?:not|never|uncovered|out[-\s]?of[-\s]?scope|partial(?:ly)?|excluded|excludes)\b[^\n.!?;]{0,120}\b(?:covered|included|exercised|tested|checked|verified|validated|measured|scope)\b|\b(?:needs?|wants?|requires?)\s+(?:a\s+)?(?:fresh\s+)?re[-\s]?check\b/i;

/** Return a coverage disclaimer that makes a complete ✓ unsafe, if any. */
function findVerificationCoverageDisclaimer(
  evidence: string,
  claim: string | null | undefined,
): string | null {
  if (typeof claim === 'string' && CLAIM_EXPLICIT_COVERAGE_LIMIT_RE.test(claim)) return null;
  for (const pattern of VERIFICATION_COVERAGE_DISCLAIMER_PATTERNS) {
    const match = pattern.exec(evidence);
    // `uncovered` is a disclaimer only when it is asserted affirmatively. A
    // completed negative measurement such as `no uncovered lockfiles` (or
    // `zero/none uncovered lockfiles`) proves the opposite and must remain a
    // VERIFIED row; the generic disclaimer matcher cannot infer that itself.
    if (match?.[0] && !isNegatedVerificationConflict(evidence, match)) return match[0];
  }
  return null;
}

/**
 * A registered event-await/watch is intentionally pending until its event fires.
 * Keep that healthy liveness state distinct from unresolved work such as a pending
 * verdict or approval. These patterns are deliberately narrow: the registration
 * and the pending state must occur in the same short evidence clause, so unrelated
 * pending work elsewhere in another sentence still downgrades a VERIFIED row.
 */
const HEALTHY_PENDING_REGISTRATION_PATTERNS: ReadonlyArray<RegExp> = [
  /\bpending\s+(?:an?\s+)?(?:event[-\s]?await|await|watch|subscription)\b[^\n.!?]{0,120}\b(?:registered|registration|armed|active|live)\b/i,
  /\b(?:event[-\s]?await|await|watch|subscription)\b[^\n.!?]{0,120}\b(?:registered|registration|armed|active|live)\b[^\n.!?]{0,120}\b(?:status|state)\s*[:=]\s*pending\b/i,
  /\b(?:status|state)\s*[:=]\s*pending\b[^\n.!?]{0,120}\b(?:event[-\s]?await|await|watch|subscription)\b[^\n.!?]{0,120}\b(?:registered|registration|armed|active|live)\b/i,
  // Subject-position form: the await/watch/subscription itself is what remains
  // pending — "newer await remains pending through 09:21:15Z" is the healthy
  // liveness state of an active registration, not unresolved work
  // (EI-21415991464539447). The registration noun must sit DIRECTLY before the
  // status verb (optionally with an `on`/`for` target), so verb-await prose
  // about genuinely unresolved work ("we await the verdict, which remains
  // pending") never matches: there the direct object separates `await` from the
  // status verb and the pattern refuses the gap.
  /\b(?:events?[-:\s]?await|await|watch|subscription)s?\b(?:\s+(?:on|for)\s+(?:[^\s.!?;,]+\s+){0,3}[^\s.!?;,]+)?\s+(?:remain(?:s|ed)?|stay(?:s|ed)?|is|are|was|were|currently|still)\s+(?:still\s+)?pending\b/i,
];

/**
 * Explicit non-admission language makes a pending rerun/verification a supporting
 * measurement rather than unresolved evidence. Keep this vocabulary narrow: a
 * generic negative word elsewhere must not hide an actually pending verdict.
 */
const NON_ADMISSION_ASSERTION_PATTERN =
  /\b(?:non[-\s]?(?:admitting|admission|admitted)|unadmitted|not\s+(?:yet\s+)?(?:admitting|admitted))\b/i;
const PENDING_MEASUREMENT_SUBJECT_PATTERN =
  /\b(?:re[-\s]?run|rerun|retest|verification|validation|probe|measurement|test|check|sample)\b/i;

/**
 * When a single evidence field reports several predicates, an unresolved marker
 * only contradicts the row whose subject it describes. Keep generic prose and
 * lifecycle vocabulary out of the subject comparison so a sentence such as
 * `checkpoint-correction verified; stable-zero remains unverified` does not
 * downgrade the checkpoint-correction row merely because both predicates share
 * the same evidence field.
 */
const VERIFICATION_RELATION_STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'because',
  'by',
  'claim',
  'check',
  'complete',
  'completed',
  'completion',
  'compaction',
  'currently',
  'done',
  'evidence',
  'exact',
  'final',
  'finished',
  'for',
  'from',
  'green',
  'has',
  'have',
  'healthy',
  'in',
  'inactive',
  'inflight',
  'is',
  'it',
  'job',
  'marker',
  'measurement',
  'never',
  'no',
  'none',
  'not',
  'of',
  'on',
  'or',
  'outstanding',
  'pending',
  'predicate',
  'process',
  'queued',
  'remain',
  'remains',
  'resolved',
  'response',
  'result',
  'review',
  'run',
  'running',
  'sample',
  'snapshot',
  'state',
  'status',
  'still',
  'task',
  'test',
  'that',
  'the',
  'this',
  'to',
  'time',
  'unverified',
  'verified',
  'was',
  'were',
  'while',
  'with',
  'work',
  'yet',
]);

/** Return meaningful subject terms, including the pieces of hyphenated ids. */
function verificationRelationTerms(text: string): Set<string> {
  const terms = new Set<string>();
  const rawTokens = text.toLowerCase().match(/[a-z0-9]+(?:[-_/][a-z0-9]+)*/g) ?? [];
  for (const raw of rawTokens) {
    const forms = [raw, ...raw.split(/[-_/]+/).filter(Boolean)];
    for (const form of forms) {
      if (form.length < 3 || VERIFICATION_RELATION_STOP_WORDS.has(form)) continue;
      terms.add(form);
      if (form.endsWith('ies') && form.length > 4) terms.add(`${form.slice(0, -3)}y`);
      else if (form.endsWith('s') && form.length > 4) terms.add(form.slice(0, -1));
    }
  }
  return terms;
}

/** Return the small predicate clause containing a contradiction marker. */
function verificationEvidenceClause(text: string, match: RegExpExecArray): string {
  let start = 0;
  let end = text.length;
  for (const separator of text.matchAll(/[.!?;,\n]|\b(?:but|while|whereas|although|though|however|and)\b/gi)) {
    const index = separator.index ?? 0;
    if (index < match.index) {
      start = index + separator[0].length;
      continue;
    }
    end = index;
    break;
  }
  return text.slice(start, end);
}

/** Require a claim/evidence subject match when the claim is available. */
function verificationConflictRelatesToClaim(
  text: string,
  match: RegExpExecArray,
  claim: string | null | undefined,
): boolean {
  if (typeof claim !== 'string' || !claim.trim()) return true;
  const claimTerms = verificationRelationTerms(claim);
  if (!claimTerms.size) return true;
  const evidenceTerms = verificationRelationTerms(verificationEvidenceClause(text, match));
  if (!evidenceTerms.size) return true;
  return [...claimTerms].some((term) => evidenceTerms.has(term));
}

/**
 * A conflict marker can be affirmative evidence when the claim itself is about
 * an unresolved lifecycle state. For example, "fresh typechecks remain queued"
 * is verified by evidence that both sessions are "still running and queued";
 * treating the status vocabulary as a contradiction would invert the finding.
 * Keep this allow-list narrow and require an affirmative status phrase in the
 * claim so a claim about a completed/healthy state keeps the fail-safe warning.
 */
const CLAIM_UNRESOLVED_STATUS_PATTERN =
  /\b(?:remain(?:s)?|is|are|was|were|stay(?:s)?|currently|still)\s+(?:blocked|queued|running|pending|outstanding|awaiting|in[-\s]?flight|unverified)\b/i;
const CLAIM_NEGATION_PREFIX =
  /\b(?:not|never|no|without|none|neither|zero|completed?|finished?|done|green|healthy|inactive|clear(?:ed)?|resolved?)\s+(?:[\w./:=()-]+\s+){0,5}$/i;

/** Return true only when the claim positively asserts the same unresolved state. */
function claimAffirmsUnresolvedStatus(claim: string | null | undefined): boolean {
  if (typeof claim !== 'string' || !claim.trim()) return false;
  const match = CLAIM_UNRESOLVED_STATUS_PATTERN.exec(claim);
  if (!match) return false;
  const status = /(?:blocked|queued|running|pending|outstanding|awaiting|in[-\s]?flight|unverified)\b/i.exec(match[0]);
  if (!status) return false;
  const statusOffset = match.index + match[0].indexOf(status[0]);
  const prefix = claim.slice(0, statusOffset);
  if (CLAIM_NEGATION_PREFIX.test(prefix)) return false;
  const clauseEnd = claim.slice(statusOffset + status[0].length).search(/[.!?;]/);
  const suffix = claim.slice(
    statusOffset + status[0].length,
    clauseEnd < 0 ? claim.length : statusOffset + status[0].length + clauseEnd,
  );
  return !/\b(?:not|never|no|without|none|neither|zero|completed?|finished?|done|green|healthy|inactive|clear(?:ed)?|resolved?)\b/i.test(
    suffix,
  );
}

/** Return true when a pending/awaiting marker describes a healthy registration. */
function isHealthyPendingRegistration(text: string, match: RegExpExecArray): boolean {
  if (!/\b(?:pending|awaiting|awaits?)\b/i.test(match[0])) return false;
  return HEALTHY_PENDING_REGISTRATION_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Return true when a pending status is the measurement supporting an explicit
 * non-admission assertion in the same or immediately preceding clause.
 */
function isNegativeAdmissionMeasurement(text: string, match: RegExpExecArray): boolean {
  const before = text.slice(Math.max(0, match.index - 240), match.index);
  const clauses = before
    .split(/[.!?;\n]/)
    .map((clause) => clause.trim())
    .filter(Boolean);
  const currentClause = clauses.at(-1) ?? '';
  const previousClause = clauses.at(-2) ?? '';
  return (
    PENDING_MEASUREMENT_SUBJECT_PATTERN.test(currentClause) &&
    (NON_ADMISSION_ASSERTION_PATTERN.test(currentClause) || NON_ADMISSION_ASSERTION_PATTERN.test(previousClause))
  );
}

/**
 * A status token can be present in a completed NEGATIVE measurement rather than
 * describing an unresolved check. Inspect the short clause before the match and
 * the common boolean/status suffixes after it before downgrading the evidence.
 */
function isNegatedVerificationConflict(text: string, match: RegExpExecArray): boolean {
  if (isNegativeAdmissionMeasurement(text, match)) return true;

  const before = text.slice(Math.max(0, match.index - 120), match.index);
  const boundary = Math.max(...['.', '!', '?', ';', '\n'].map((mark) => before.lastIndexOf(mark)));
  const clause = before.slice(boundary + 1).trim();
  if (/\b(?:no|not|never|without|none|neither|zero)(?:\s+[\w./:=()-]+){0,6}$/i.test(clause)) {
    return true;
  }

  const after = text.slice(match.index + match[0].length);
  return /^\s*(?:=|:)\s*(?:false|0|null|none|inactive|no)\b/i.test(after);
}

/**
 * A transition note can mention the state it just left without claiming that
 * the state is still live. Keep standalone past-tense measurements such as
 * "the exact rerun was pending" conservative, but ignore an explicitly
 * historical parenthetical or the left side of an arrow transition.
 */
function isHistoricalVerificationTransition(text: string, match: RegExpExecArray): boolean {
  const before = text.slice(0, match.index);
  const after = text.slice(match.index + match[0].length);

  const lastOpening = Math.max(before.lastIndexOf('('), before.lastIndexOf('['));
  const lastClosing = Math.max(before.lastIndexOf(')'), before.lastIndexOf(']'));
  if (lastOpening > lastClosing && /^(?:was|were)\b/i.test(match[0])) return true;

  const arrow = after.match(/^[^.!?;\n]{0,160}(?:->|→)/);
  if (!arrow) return false;
  const arrowInMatch = /(?:->|→)/.exec(arrow[0]);
  if (!arrowInMatch) return false;
  const rightSide = after.slice((arrow.index ?? 0) + arrowInMatch.index + arrowInMatch[0].length);
  return !/\b(?:blocked|queued|running|pending|outstanding|awaiting|in[-\s]?flight|unverified)\b/i.test(
    rightSide.split(/[.!?;\n]/, 1)[0] ?? '',
  );
}

/** Return the exact contradiction phrase found in verification evidence, if any. */
export function findVerificationConflict(evidence: string | null | undefined, claim?: string | null): string | null {
  const text = typeof evidence === 'string' ? evidence : '';
  if (!text.trim()) return null;
  const coverageDisclaimer = findVerificationCoverageDisclaimer(text, claim);
  if (coverageDisclaimer) return coverageDisclaimer;
  for (const pattern of VERIFICATION_CONFLICT_PATTERNS) {
    const match = pattern.exec(text);
    if (
      match?.[0] &&
      !isNegatedVerificationConflict(text, match) &&
      !isHistoricalVerificationTransition(text, match) &&
      !isHealthyPendingRegistration(text, match) &&
      !claimAffirmsUnresolvedStatus(claim) &&
      verificationConflictRelatesToClaim(text, match, claim)
    ) {
      return match[0];
    }
  }
  return null;
}

/**
 * Truncate `v` to `cap`, recording a repair. Returns `v` untouched when within cap.
 *
 * EI-22079495152196184: a carried check/wall claim is written as "observation +
 * operative consequence", and the consequence sits at the END ("... do NOT fix
 * here"). The original implementation kept only the PREFIX and cut everything
 * after it, so an overlong claim silently lost exactly the instruction a reader
 * most needs — and the surviving prefix still reads as a complete, plausible
 * sentence, so the loss is invisible without diffing against the original. Keep
 * BOTH ends instead: split the available budget roughly evenly between head and
 * tail, with the marker sitting in the middle where the cut actually happened.
 * The total emitted length is unchanged (still exactly `cap` once `cap >=
 * CARRY_TRUNCATION_MARKER.length`), so every existing caller/schema length
 * invariant still holds — only the SHAPE of what's kept changes.
 */
export function truncateCarryField(v: string, cap: number, field: string, repairs: CarryArgRepair[]): string {
  if (v.length <= cap) return v;
  const budget = Math.max(0, cap - CARRY_TRUNCATION_MARKER.length);
  const headLen = Math.ceil(budget / 2);
  const tailLen = budget - headLen;
  repairs.push({
    field,
    kind: 'truncated',
    detail:
      `${v.length} chars trimmed to ${cap} (${v.length - cap} over) — kept the first ${headLen} + last ${tailLen} ` +
      `chars around the cut so a trailing clause is not silently dropped; write it shorter to keep the full text`,
  });
  const head = v.slice(0, headLen);
  const tail = tailLen > 0 ? v.slice(v.length - tailLen) : '';
  return head + CARRY_TRUNCATION_MARKER + tail;
}

/**
 * Descriptive keys callers reach for instead of the canonical `claim`, in the
 * order one is chosen when several are present.
 *
 * Re-measured 2026-08-12 over 14 days of REJECTED checkpoint rows (the
 * `checks.N.claim: expected string, received undefined` class): `text` (8 rows),
 * `body` (4) and `summary` (1) sat alongside the already-handled `label` (10)
 * and `name` (2). Every one of them is STRIPPED by the row schema, so without
 * this list the caller's claim text is destroyed and the row then fails
 * validation for the missing field it just lost.
 *
 * `description` joins them for tool-contract-repair-2026-09-05 P-005: it is the
 * same lossless 1:1 synonym for the row's prose as the five above, and it was
 * the key two separate loop:checkpoint filings reached for on a WALLS row
 * (EI-20256358119840421, EI-21123164129476823). Adding it here fixes the
 * checks-row case; `coerceWallRowShape` below is what carries it to walls.
 */
const CARRY_CLAIM_ALIASES = ['label', 'name', 'text', 'body', 'summary', 'description'] as const;

/**
 * Keys callers reach for instead of the canonical row `id`. `key` appeared on 15
 * rejected rows in the same census. Unmapped it is stripped, which silently
 * loses the identity `rowsMode:'merge'` upserts on.
 */
const CARRY_ID_ALIASES = ['key'] as const;

/**
 * Claim aliases admitted ONLY on a row that carries no claim text of its own.
 *
 * `value` earns a place here (tool-contract-repair-2026-09-05 P-005) on two independent
 * filings, one per surface: EI-21270302136437045 on `loop:checkpoint` ("the declared
 * checks schema rejects {key,value}") and an unconditional-key rejection on
 * `work_items:checkpoint` ("checks.0 and checks.1 rejected unrecognized key value"). The
 * caller's shape is the key/value pair `{key, value}` — `key` is already an id alias, so
 * `value` is the only reason the whole write still fails.
 *
 * It is CONDITIONAL, not a seventh entry in CARRY_CLAIM_ALIASES, because it is not a
 * synonym. When a row supplies the canonical `claim` alongside a descriptive alias, the
 * resolver keeps the claim and DELETES the alias — correct for `label`/`text`/`summary`,
 * where the two say the same thing, and destructive for `value`, where `{claim, value}`
 * says two different things and `value` may well be the evidence. Admitting it only on a
 * claimless row makes the repair provably lossless: the `{key, value}` shape both filings
 * describe is accepted, and any row where `value` could mean something else still fails
 * loudly at the strict schema rather than having its data silently dropped. This mirrors
 * the existing `claimlessWithIdentity` fallback — a repair scoped to the one shape where
 * its meaning is unambiguous.
 */
const CARRY_CONDITIONAL_CLAIM_ALIASES = ['value'] as const;

/**
 * Append any conditional claim alias present on a row that has no claim text at all.
 * Shared by the checks and walls coercions so the two cannot drift (they already did once
 * — see coerceWallRowShape's header).
 */
function withConditionalClaimAliases(r: Record<string, unknown>, claimAliases: string[]): string[] {
  if (claimAliases.length || 'claim' in r) return claimAliases;
  return [...claimAliases, ...CARRY_CONDITIONAL_CLAIM_ALIASES.filter((k) => k in r)];
}

/**
 * Repair one incoming `checks`/`walls` row IN THE ARGUMENT SHAPE, before validation.
 *
 * Handles the common wrong shapes agents reach for: `{label/name/text/body/summary,
 * status, evidence}` or `{claim, recheck, status, evidence}` instead of `{claim,
 * recheck, verified}`, the boolean check-result alias `{claim, ok}`, the structured verification `{kind, command, result}`
 * shape (mapped to `{claim, recheck, verified}`), the documented-looking
 * `{claim, probe, verified}` alias where `probe` is intended to mean `recheck`,
 * `key` for `id`, and a row that carries an identity + evidence but no claim text
 * at all, and a BARE-STRING row (the shorthand evidence list — mapped to
 * `{ claim }`, since a string can only be the claim text on every carry surface).
 * Measured across 6 days of transcripts, `evidence` (57×) and `status` (40×) were
 * by far the top rejected undeclared keys; the probe alias is handled here too so
 * a caller's concrete falsification command is not discarded at the schema boundary.
 *
 * `verified` semantics are preserved exactly: it is an EVIDENCE STRING whose mere
 * presence renders the row VERIFIED, and whose absence renders it PREDICTED. So a
 * row carrying real evidence maps to that evidence; a row whose `status` says it was
 * NOT verified maps to no `verified` at all, rather than inventing one.
 */
export function coerceCarryRowShape(row: unknown, path: string, repairs: CarryArgRepair[]): unknown {
  // EI-21268881673610011: callers send each row as a BARE STRING — the shorthand
  // evidence list (`checks: ["suite green", "sha matches"]`). On every carry
  // surface a bare string can only BE the claim text, so map it to `{ claim }`
  // rather than letting Zod reject the whole write with "expected object,
  // received string". Parity: loop:checkpoint already accepted string rows via
  // its own compact-input normalizer while work_items:checkpoint rejected them —
  // an identical payload was ok:true on one carry surface and invalid_args on
  // the other, the exact class this file's strict-schema comments document.
  // Whitespace-only still routes through so the schema's own `claim.min(1)`
  // names the real problem; non-string scalars keep passing through unchanged.
  if (typeof row === 'string') {
    repairs.push({
      field: path,
      kind: 'renamed',
      detail: 'a bare-string row is accepted as its claim text; mapped to `{ claim }`',
    });
    return { claim: row };
  }
  if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
  const r = { ...(row as Record<string, unknown>) };
  // EI-21311156936925867: callers also send a structured verification row as
  // `{kind, command, result}`. That shape is semantically the same as this
  // carry surface's `{claim, recheck, verified}` contract: `kind` identifies
  // the asserted check, `command` is the falsification probe, and `result` is
  // the evidence string. Restrict this repair to checks rows; `kind` is not a
  // claim alias for owner-gated walls, and a wall's `result` must not become a
  // checks-only `verified` field by accident.
  const isChecksRow = path.startsWith('checks[');
  const hasKind = isChecksRow && 'kind' in r;
  const hasCommand = isChecksRow && 'command' in r;
  const hasResult = isChecksRow && 'result' in r;
  const claimAliases = withConditionalClaimAliases(r, [...CARRY_CLAIM_ALIASES.filter((k) => k in r)]);
  const idAliases = CARRY_ID_ALIASES.filter((k) => k in r);
  const hasStatus = 'status' in r;
  const hasEvidence = 'evidence' in r;
  // Completion records call the same evidence string `testResult`. Checks use
  // `verified` canonically, but accepting this completion-style spelling keeps a
  // caller's measured result lossless at the checkpoint boundary (EI-22575327388783364).
  const hasTestResult = isChecksRow && 'testResult' in r;
  // `probe` historically meant the human recheck command. WI-42290 adds a
  // canonical OBJECT at the same key, so only the legacy string remains an
  // alias; a typed object must pass through untouched to the row schema.
  const hasProbe = typeof r.probe === 'string';
  // EI-21828094173087688: callers commonly use the boolean result vocabulary
  // `{ claim, ok }`. `ok` is a compatibility alias for the boolean form of
  // `verified`; it must be removed before the strict row schema sees the value.
  // Non-boolean values remain invalid so a typo cannot be silently accepted.
  const booleanOk = isChecksRow && typeof r.ok === 'boolean' ? r.ok : undefined;
  // A row with an identity but no claim text is repairable too (see the
  // claim-from-id fallback below), so it must not short-circuit out here.
  const claimlessWithIdentity = !('claim' in r) && ('id' in r || idAliases.length > 0);
  if (
    !claimAliases.length &&
    !idAliases.length &&
    !hasStatus &&
    !hasEvidence &&
    !hasProbe &&
    !hasKind &&
    !hasCommand &&
    !hasResult &&
    !hasTestResult &&
    !claimlessWithIdentity &&
    typeof r.verified !== 'boolean' &&
    booleanOk === undefined
  ) {
    return row;
  }

  if (hasKind || hasCommand || hasResult) {
    // Canonical fields always win when a caller sends both shapes. Remove the
    // aliases either way so strict Zod validation cannot reject the otherwise
    // recoverable row over undeclared keys.
    const hadClaim = 'claim' in r;
    const hadRecheck = 'recheck' in r;
    const hadVerified = 'verified' in r;
    const kind = r.kind;
    const command = r.command;
    const result = r.result;
    if (hasKind) delete r.kind;
    if (hasCommand) delete r.command;
    if (hasResult) delete r.result;
    if (hasKind && !hadClaim) r.claim = kind;
    if (hasCommand && !hadRecheck) r.recheck = command;
    if (hasResult && !hadVerified) r.verified = result;
    for (const field of ['kind', 'command', 'result'] as const) {
      if (!(field in row)) continue;
      const canonical = field === 'kind' ? 'claim' : field === 'command' ? 'recheck' : 'verified';
      const kept = field === 'kind' ? hadClaim : field === 'command' ? hadRecheck : hadVerified;
      repairs.push({
        field: `${path}.${field}`,
        kind: 'renamed',
        detail:
          `the structured \`${field}\` key is accepted as an alias for \`${canonical}\`; ` +
          (kept ? `the canonical \`${canonical}\` value was kept` : `the value was mapped to \`${canonical}\``),
      });
    }
  }

  if (hasTestResult) {
    // `verified` is canonical. When both spellings are supplied, preserve the
    // explicit canonical value while still removing the compatibility key before
    // strict validation; otherwise map the completion evidence losslessly.
    const testResult = r.testResult;
    const hadCanonicalVerified = 'verified' in r;
    delete r.testResult;
    if (!hadCanonicalVerified) r.verified = testResult;
    repairs.push({
      field: `${path}.testResult`,
      kind: 'renamed',
      detail:
        'completion-style `testResult` is accepted as an alias for `verified`; ' +
        (hadCanonicalVerified ? 'the canonical verified value was kept' : 'the value was mapped to `verified`'),
    });
  }

  if (claimAliases.length) {
    // `claim` is canonical. When a caller supplies both the canonical field and
    // one of these descriptive aliases, preserve the explicit claim and only
    // remove the undeclared aliases before strict schema validation. If neither
    // is canonical, the first alias in CARRY_CLAIM_ALIASES order wins.
    const alias = claimAliases[0];
    const aliasValue = r[alias];
    const hadCanonicalClaim = 'claim' in r;
    for (const k of claimAliases) delete r[k];
    if (!hadCanonicalClaim) r.claim = aliasValue;
    repairs.push({
      field: `${path}.${alias}`,
      kind: 'renamed',
      detail:
        `the descriptive \`${alias}\` key is accepted as an alias for \`claim\`; ` +
        (hadCanonicalClaim ? 'the canonical claim value was kept' : 'the alias value was mapped to claim'),
    });
    for (const dropped of claimAliases.slice(1)) {
      repairs.push({
        field: `${path}.${dropped}`,
        kind: 'renamed',
        detail: `the undeclared \`${dropped}\` alias was removed; \`${alias}\` was selected when no canonical claim was supplied`,
      });
    }
  }

  if (idAliases.length) {
    // Same contract one field over: without this the alias is STRIPPED by the
    // row schema, silently losing the identity that rowsMode:'merge' upserts on
    // and that lets a claim be re-worded without orphaning its evidence.
    const alias = idAliases[0];
    const aliasValue = r[alias];
    const hadCanonicalId = 'id' in r;
    for (const k of idAliases) delete r[k];
    if (!hadCanonicalId) r.id = aliasValue;
    repairs.push({
      field: `${path}.${alias}`,
      kind: 'renamed',
      detail:
        `the \`${alias}\` key is accepted as an alias for the row \`id\`; ` +
        (hadCanonicalId ? 'the canonical id was kept' : 'the alias value was mapped to id'),
    });
  }

  if (hasProbe) {
    // `recheck` is the canonical field, but `probe` is the natural/documented
    // synonym callers use for the command that tests a carried claim. Preserve
    // an explicitly supplied canonical value when both are present, while always
    // removing the legacy string alias before strict schema validation. A
    // typed probe object is canonical and never reaches this branch.
    const probe = r.probe;
    const hadRecheck = 'recheck' in r;
    delete r.probe;
    if (!hadRecheck) r.recheck = probe;
    repairs.push({
      field: `${path}.probe`,
      kind: 'renamed',
      detail:
        'the documented `probe` key is accepted as an alias for `recheck`; ' +
        (hadRecheck ? 'the canonical recheck value was kept' : 'the probe value was mapped to recheck'),
    });
  }

  if (booleanOk !== undefined) {
    // Canonical `verified` wins when both vocabularies are supplied, except that
    // an explicit `ok:false` is an authoritative negative verdict: affirmative
    // canonical evidence cannot remain in the VERIFIED slot and render as `✓`.
    // Move that evidence losslessly to `contested` so the failed verdict stays
    // visible instead of silently discarding the only explanation.
    const hadCanonicalVerified = 'verified' in r;
    const canonicalVerified = r.verified;
    delete r.ok;
    if (!hadCanonicalVerified) r.verified = booleanOk;
    else if (!booleanOk && typeof canonicalVerified === 'string' && canonicalVerified.trim()) {
      delete r.verified;
      r.contested = canonicalVerified;
      repairs.push({
        field: `${path}.verified`,
        kind: 'downgraded',
        detail:
          `explicit boolean \`ok:false\` is authoritative; canonical verified evidence was moved losslessly to ` +
          `\`contested\` so the failed verdict cannot render as \`✓\`: ${canonicalVerified}`,
      });
    }
    repairs.push({
      field: `${path}.ok`,
      kind: 'renamed',
      detail:
        `boolean \`ok:${booleanOk}\` is accepted as a compatibility alias for \`verified\`; ` +
        (hadCanonicalVerified
          ? 'the canonical verified value was kept'
          : 'the value was normalized through the verified evidence semantics'),
    });
  }

  const evidence = typeof r.evidence === 'string' ? r.evidence.trim() : '';
  const status = typeof r.status === 'string' ? r.status.trim() : '';
  // Only these read as an affirmative verification; anything else (predicted,
  // pending, unknown, false, …) must stay PREDICTED rather than be upgraded.
  const statusVerified = /^(verified|true|pass(ed)?|confirmed|done|ok|✓)$/i.test(status);
  const statusContested = /^(contested|fail(?:ed|ure)?|false|error|red|⚠)$/i.test(status);
  const booleanVerified = typeof r.verified === 'boolean' ? r.verified : undefined;

  if (booleanVerified !== undefined) {
    // A boolean was never storable — it is the flag-vs-evidence confusion. `true`
    // keeps real evidence that came with it; `false` is simply PREDICTED, even if a
    // contradictory/stray evidence field is also present. The explicit boolean is
    // the caller's verdict, so a malformed companion field must not override it.
    const was = r.verified;
    delete r.verified;
    if (was && evidence && booleanOk !== false) r.verified = evidence;
    repairs.push({
      field: `${path}.verified`,
      kind: 'renamed',
      detail: `boolean ${was} is not storable — \`verified\` is the evidence STRING itself; ${
        r.verified ? 'used the accompanying evidence' : 'row kept as PREDICTED'
      }`,
    });
  }

  if (hasEvidence || hasStatus) {
    delete r.status;
    delete r.evidence;
    // When a boolean was supplied, it is authoritative: only `true` with a real
    // evidence string above can become VERIFIED. Without the boolean compatibility
    // shape, preserve `{status, evidence}` losslessly in the authority slot named by
    // the status. A non-verifying status keeps its evidence as observed CONTEXT; it
    // must never become `verified` merely because the evidence string is non-empty.
    if (
      r.verified === undefined &&
      r.observed === undefined &&
      r.contested === undefined &&
      booleanVerified === undefined &&
      booleanOk === undefined
    ) {
      if (evidence && statusContested) r.contested = evidence;
      else if (evidence && status && !statusVerified) r.observed = evidence;
      else if (evidence) r.verified = evidence;
      else if (statusVerified) r.verified = status;
    }
    const mappedEvidenceSlot =
      r.contested !== undefined
        ? 'contested'
        : r.verified !== undefined
          ? 'verified'
          : r.observed !== undefined
            ? 'observed'
            : null;
    repairs.push({
      field: path,
      kind: 'renamed',
      detail:
        `{${[hasStatus && 'status', hasEvidence && 'evidence'].filter(Boolean).join(', ')}} is not this tool's row shape — ` +
        (mappedEvidenceSlot
          ? `evidence preserved in \`${mappedEvidenceSlot}\``
          : 'kept as PREDICTED') +
        '; pass {claim, recheck, verified|observed|contested} directly next time',
    });
  }

  // LAST RESORT — a row that named itself but never stated its claim (measured:
  // 9 rejected rows shaped `{id|key, status, evidence}`). `claim` is the one
  // required field, so without this the row fails validation and takes the WHOLE
  // note down with it: did/left/insight/next and every sibling row are discarded
  // over one under-specified entry, leaving a cold wake with no note at all.
  // Falling back to the identity is the reciprocal of the id field's own
  // documented rule ("omitted ⇒ identity is the claim text"), and it is reported,
  // never silent — the row renders degraded rather than vanishing.
  if (typeof r.claim !== 'string' || !r.claim.trim()) {
    const identity = typeof r.id === 'string' ? r.id.trim() : '';
    if (identity) {
      r.claim = identity;
      repairs.push({
        field: `${path}.claim`,
        kind: 'renamed',
        detail:
          `no claim text was supplied — the row id \`${identity}\` was used as the claim so the note still writes; ` +
          'state the claim concretely in `claim` next time',
      });
    }
  }
  return r;
}

/**
 * Repair one incoming `walls` row IN THE ARGUMENT SHAPE — the claim/id ALIAS half
 * of `coerceCarryRowShape`, and deliberately nothing else.
 *
 * tool-contract-repair-2026-09-05 P-005. `walls` rows accept only
 * `{claim, id, recheck}`, and loop:checkpoint's walls preprocessor is
 * `normalizeCompactRowInput` alone — so a wall written as `{description, …}` or
 * `{key, …}` is `invalid_args`, while the byte-identical key on a CHECKS row is
 * accepted losslessly. Three filings hit exactly that asymmetry
 * (EI-20256358119840421, EI-21123164129476823, EI-22387774231617463); the claim
 * text is then STRIPPED by the row schema and the row fails validation for the
 * very field it just lost, which is the same destruction CARRY_CLAIM_ALIASES
 * exists to prevent one field over.
 *
 * WHY NOT just call `coerceCarryRowShape` here: WI-7264 decided, on measured
 * volume, that walls must NOT get the `{status, evidence}` coercion, because a
 * wall has no `verified` field and there is nowhere lossless to put `evidence` —
 * mapping it would DROP the caller's data (EI-18723223344390510). That decision
 * stands untouched: this function maps ONLY the two lossless 1:1 renames, so a
 * wall carrying `status`/`evidence`/`kind` keeps failing loudly exactly as before.
 * `kind` in particular is excluded on purpose — `coerceCarryRowShape` already
 * documents that `kind` is not a claim alias for owner-gated walls.
 */
export function coerceWallRowShape(row: unknown, path: string, repairs: CarryArgRepair[]): unknown {
  if (typeof row === 'string' || !row || typeof row !== 'object' || Array.isArray(row)) return row;
  const r = { ...(row as Record<string, unknown>) };
  const claimAliases = withConditionalClaimAliases(r, [...CARRY_CLAIM_ALIASES.filter((k) => k in r)]);
  const idAliases = CARRY_ID_ALIASES.filter((k) => k in r);
  if (!claimAliases.length && !idAliases.length) return row;

  if (claimAliases.length) {
    const alias = claimAliases[0];
    const aliasValue = r[alias];
    const hadCanonicalClaim = 'claim' in r;
    for (const k of claimAliases) delete r[k];
    if (!hadCanonicalClaim) r.claim = aliasValue;
    repairs.push({
      field: `${path}.${alias}`,
      kind: 'renamed',
      detail:
        `the descriptive \`${alias}\` key is accepted as an alias for \`claim\`; ` +
        (hadCanonicalClaim ? 'the canonical claim value was kept' : 'the alias value was mapped to claim'),
    });
    for (const dropped of claimAliases.slice(1)) {
      repairs.push({
        field: `${path}.${dropped}`,
        kind: 'renamed',
        detail: `the undeclared \`${dropped}\` alias was removed; \`${alias}\` was selected when no canonical claim was supplied`,
      });
    }
  }

  if (idAliases.length) {
    const alias = idAliases[0];
    const aliasValue = r[alias];
    const hadCanonicalId = 'id' in r;
    for (const k of idAliases) delete r[k];
    if (!hadCanonicalId) r.id = aliasValue;
    repairs.push({
      field: `${path}.${alias}`,
      kind: 'renamed',
      detail:
        `the \`${alias}\` key is accepted as an alias for the row \`id\`; ` +
        (hadCanonicalId ? 'the canonical id was kept' : 'the alias value was mapped to id'),
    });
  }

  return r;
}

/**
 * Accept the flattened executable-probe envelope that callers naturally construct
 * from a check row, e.g. `{ claim, kind: 'tool', tool, args, schemaRevision, expect }`,
 * lifting it into the canonical nested `{ probe: { kind, tool, args, schemaRevision,
 * expect } }` shape before the strict row schema sees it.
 *
 * EI-21631530729522909 (work_items:checkpoint) / EI-21922421392042550
 * (loop:checkpoint — this constant had no flattened-probe compat at all, so the
 * IDENTICAL flattened shape that works on one carry surface was `invalid_args` on
 * the other): SHARED so both checkpoint tools stay in lockstep — a future probe
 * field added to one surface and not the other is exactly this bug recurring.
 *
 * `coerceCarryRowShape` also treats `kind` as the legacy structured-check claim
 * alias, so this lift must run FIRST and only for a COMPLETE executable envelope.
 * Incomplete rows and ordinary `{kind, command, result}` rows keep their existing
 * validation/compatibility behavior; a nested `probe` object is canonical and
 * always wins its own field values. The lifted fields are removed from the row so
 * the strict row schema cannot retain a second, ambiguous copy of them.
 *
 * EI-21674755057848047 / EI-21929976122322931 / EI-21926988610689807: a nested
 * `probe` used to bypass this normalizer ENTIRELY, so the FLATTENED envelope
 * `{kind:'tool', tool, args, schemaRevision, expect}` was accepted while the
 * canonical-looking `probe:{tool, args, schemaRevision, expect}` — identical but
 * for the discriminator the sibling path INFERS — was refused with a raw zod
 * "Invalid discriminator value". Callers on both surfaces reacted by dropping
 * `checks` altogether, which is why this cost EVIDENCE and not just a retry.
 * A nested probe now gets the same inference, under {@link inferNestedProbeKind}.
 */
export function normalizeFlattenedContinuityProbeRow(row: unknown): unknown {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
  const source = row as Record<string, unknown>;
  if (source.probe !== undefined) return inferNestedProbeKind(row, source);

  const kind = source.kind;
  const targetKey = kind === 'tool' ? 'tool' : kind === 'state-cell' ? 'cell' : null;
  if (!targetKey) return row;

  // These are the required fields for both discriminated probe variants;
  // `args`, `projection`, and `as` are optional on their respective shapes.
  const requiredKeys = [targetKey, 'schemaRevision', 'expect'];
  if (!requiredKeys.every((key) => Object.prototype.hasOwnProperty.call(source, key))) return row;

  const lifted = { kind } as Record<string, unknown>;
  const probeKeys =
    kind === 'tool'
      ? ['tool', 'args', 'projection', 'schemaRevision', 'expect']
      : ['cell', 'as', 'schemaRevision', 'expect'];
  const normalized = { ...source };
  for (const key of probeKeys) {
    if (!Object.prototype.hasOwnProperty.call(normalized, key)) continue;
    lifted[key] = normalized[key];
    delete normalized[key];
  }
  delete normalized.kind;
  normalized.probe = lifted;
  return normalized;
}

/**
 * Supply the `kind` discriminator for a nested `probe` that omitted it, but ONLY
 * when the row itself makes the answer unambiguous: `tool` means `kind:'tool'`,
 * `cell` means `kind:'state-cell'`. This is the same repair the flattened path
 * above already performs, extended to the canonical nested shape so the two
 * spellings of one probe stop disagreeing.
 *
 * Deliberately NARROW — three cases are left for the strict schema to refuse,
 * because each would otherwise persist a probe the caller did not describe:
 *
 *  - `kind` already present: never overridden, even when it contradicts the
 *    sibling fields. A caller who states a discriminator must get the error for
 *    the probe they WROTE, not silent promotion to a different variant.
 *  - BOTH `tool` and `cell`: genuinely ambiguous, so inference would be a guess.
 *  - NEITHER: there is nothing to execute. `probe:{expect}` is not an
 *    under-specified probe, it is a claim with no probe — the row wants
 *    `recheck` (the human explanation) and no `probe` at all.
 */
function inferNestedProbeKind(row: unknown, source: Record<string, unknown>): unknown {
  const probe = source.probe;
  if (!probe || typeof probe !== 'object' || Array.isArray(probe)) return row;

  const nested = probe as Record<string, unknown>;
  const hasKind = Object.prototype.hasOwnProperty.call(nested, 'kind');
  const hasTool = Object.prototype.hasOwnProperty.call(nested, 'tool');
  const hasCell = Object.prototype.hasOwnProperty.call(nested, 'cell');
  // Equal means both or neither: ambiguous, or nothing to run. Refuse either way.
  const canInferKind = !hasKind && hasTool !== hasCell;
  const hasNestedRevision = Object.prototype.hasOwnProperty.call(nested, 'schemaRevision');
  const hasLegacyRevision = Object.prototype.hasOwnProperty.call(source, 'schemaRevision');
  // EI-21989135403192173: callers that already used the nested `probe` envelope
  // still sometimes put the revision on the surrounding check row. Move that
  // legacy field into the probe before continuityProbeSchema validates it; this
  // is lossless because the surrounding field is only the compatibility spelling
  // and the probe is the canonical owner. Do not repair ambiguous/no-op probes —
  // their rejection should still name the missing/ambiguous executable target.
  const canLiftLegacyRevision = !hasNestedRevision && hasLegacyRevision && (hasKind || canInferKind);
  if (!canInferKind && !canLiftLegacyRevision) return row;

  const normalized = { ...source };
  const normalizedProbe: Record<string, unknown> = {
    ...(canInferKind ? { kind: hasTool ? 'tool' : 'state-cell' } : {}),
    ...nested,
  };
  if (canLiftLegacyRevision) {
    normalizedProbe.schemaRevision = source.schemaRevision;
    delete normalized.schemaRevision;
  }
  return { ...normalized, probe: normalizedProbe };
}

/** Fixed legend rendered under the `## Checks` heading so a cold successor reads the
 *  rows correctly with zero prior knowledge. Starts with `_` so line-parsers skip it. */
export const CARRY_NOTE_CHECKS_LEGEND =
  '_✓ = VERIFIED (evidence attached) · ⚠ = CONTESTED (evidence contradicts verification; re-check now) · ' +
  '? = PREDICTED (observed context may be attached) — run the re-check before relying on it · ' +
  '[scope: …] = ALL the probe observed; a claim quantified beyond it is NOT verified by it_';

/** Max length of a row `id`. Long enough to be descriptive (`gate-green-at-tip`),
 *  short enough that the rendered `[#…]` prefix never dominates the row. */
export const CARRY_ROW_ID_MAX = 40;

/** The charset an `id` round-trips through {@link renderCheckLine} / {@link parseCheckLine}
 *  intact: no whitespace and no `]`, so the `[#…]` anchor can never swallow claim text. */
const CARRY_ROW_ID_ALLOWED = /[^A-Za-z0-9._:-]+/g;

/** Sanitize a caller-supplied row id to the round-trippable charset, or null when
 *  nothing survives. Repair-don't-refuse, like every other coercion in this file: an
 *  id with a space becomes `my-id`, never a rejected write that discards the note. */
export function sanitizeCarryRowId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw
    .trim()
    .replace(CARRY_ROW_ID_ALLOWED, '-')
    .replace(/^-+|-+$/g, '');
  if (!cleaned) return null;
  return cleaned.slice(0, CARRY_ROW_ID_MAX).toLowerCase();
}

/**
 * The IDENTITY of a carried row (P-013), used for EVERY identity decision — dedup,
 * inheritance of recheck/verified/sinceMs, merge-upsert, and drop-detection.
 *
 * `id` when present, else the trimmed claim text. The two namespaces are TAGGED
 * apart so a row whose claim text happens to equal another row's id can never
 * collide with it.
 *
 * Why an id at all: keying identity on the claim TEXT means re-wording a claim makes
 * it a different row — it loses its inherited evidence and `sinceMs`, and reads to
 * the drop-report as a carried claim that vanished. An id makes identity independent
 * of wording, which is what lets a caller tighten a claim in place.
 */
export function carryRowKey(row: { id?: string; claim?: string }): string {
  const id = sanitizeCarryRowId(row.id);
  return id ? `id:${id}` : `claim:${(row.claim ?? '').trim()}`;
}

/**
 * Resolve the prior row for an incoming entry. A stable id is authoritative once
 * it exists, but an id can be introduced after a note was already carrying an
 * id-less row. In that one migration shape, match the new keyed entry to the
 * legacy row by its unchanged claim so evidence/age are promoted instead of
 * duplicated. Never match an id-less entry to a keyed prior row: the two
 * namespaces are intentionally distinct once both sides have an identity.
 */
function priorRowForIncoming<T extends { id?: string; claim: string }>(
  entry: { id?: string; claim?: string },
  prior: ReadonlyArray<T>,
  priorByKey: ReadonlyMap<string, T>,
): T | undefined {
  const exact = priorByKey.get(carryRowKey(entry));
  if (exact) return exact;

  if (!sanitizeCarryRowId(entry.id)) return undefined;
  const claim = (entry.claim ?? '').trim();
  if (!claim) return undefined;
  return prior.find((candidate) => !sanitizeCarryRowId(candidate.id) && candidate.claim.trim() === claim);
}

/**
 * P-025 (review-system-rework-reduction-2026-09-23) — does `ref` name this carried row?
 * A ref is the row's stable id (bare, `#id` or `[#id]`, exactly as the note renders it)
 * or its exact trimmed claim text. Claim text is accepted because most carried rows
 * have no id: requiring one would leave exactly the rows this exists for unreachable.
 */
function carryRowMatchesRef(row: { id?: string; claim: string }, ref: string): boolean {
  const trimmed = ref.trim();
  if (!trimmed) return false;
  const id = sanitizeCarryRowId(row.id);
  const refAsId = trimmed.replace(/^\[?#/, '').replace(/\]$/, '');
  return (id !== null && id === refAsId) || row.claim.trim() === trimmed;
}

/** A stable id for a row that is being edited by `replaces` and has none. Derived from
 *  the claim it replaces so the same edit mints the same id; suffixed on collision. */
function mintCarryRowId(claim: string, taken: ReadonlySet<string>): string {
  const base = `r-${createHash('sha256').update(claim.trim(), 'utf8').digest('hex').slice(0, 8)}`;
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}

/**
 * P-025 — resolve one-row edit (`replaces`) and retire (`retire`) references against the
 * carried set BEFORE the merge runs.
 *
 * Why: measured 2026-09-23, 1,675 `checkpoint_merge_would_evict_rows` refusals in 7 days.
 * An id-less carried row is keyed by its claim text, so re-wording it is a NET ADDITION
 * and at the cap it evicts the carried tail; the only recovery was re-sending all 12 rows.
 *
 * How: a supplied row carrying `replaces` is bound to its target by giving BOTH the same
 * stable id — the caller's id, else the target's id, else a minted one — after which the
 * existing id-keyed upsert edits it in place, inherits its evidence and age, and leaves
 * every other row untouched. The minted id stays on the row, so the next edit can key on
 * it directly. `retire` removes the named rows from the carried set; they are returned
 * as retired rather than dropped, because a named retirement is not an unintended loss.
 * A ref that names no carried row is returned in `unmatched`, never silently ignored.
 */
export function resolveCarryRowRefs<
  W extends { id?: string; claim: string; replaces?: string },
  C extends { id?: string; claim: string; replaces?: string },
  PW extends { id?: string; claim: string },
  PC extends { id?: string; claim: string },
>(opts: {
  priorWalls: ReadonlyArray<PW>;
  priorChecks: ReadonlyArray<PC>;
  walls?: ReadonlyArray<W>;
  checks?: ReadonlyArray<C>;
  retire?: ReadonlyArray<string>;
}): {
  priorWalls: PW[];
  priorChecks: PC[];
  walls?: Array<Omit<W, 'replaces'>>;
  checks?: Array<Omit<C, 'replaces'>>;
  retiredWalls: string[];
  retiredChecks: string[];
  unmatched: string[];
} {
  const unmatched: string[] = [];
  const retire = (opts.retire ?? []).map((r) => r.trim()).filter(Boolean);
  const retiredWalls: string[] = [];
  const retiredChecks: string[] = [];
  const keep = <P extends { id?: string; claim: string }>(rows: ReadonlyArray<P>, retired: string[]): P[] =>
    rows.filter((row) => {
      if (!retire.some((ref) => carryRowMatchesRef(row, ref))) return true;
      retired.push(row.claim.trim());
      return false;
    });
  const priorWalls = keep(opts.priorWalls, retiredWalls);
  const priorChecks = keep(opts.priorChecks, retiredChecks);

  const taken = new Set<string>();
  for (const row of [...opts.priorWalls, ...opts.priorChecks, ...(opts.walls ?? []), ...(opts.checks ?? [])]) {
    const id = sanitizeCarryRowId(row.id);
    if (id) taken.add(id);
  }
  const bind = <S extends { id?: string; claim: string; replaces?: string }, P extends { id?: string; claim: string }>(
    supplied: ReadonlyArray<S> | undefined,
    prior: P[],
  ): Array<Omit<S, 'replaces'>> | undefined => {
    if (supplied === undefined) return undefined;
    const bound = new Set<number>();
    return supplied.map((row) => {
      const { replaces, ...rest } = row;
      if (replaces === undefined || !replaces.trim()) return rest;
      const index = prior.findIndex((p, i) => !bound.has(i) && carryRowMatchesRef(p, replaces));
      if (index < 0) {
        unmatched.push(replaces.trim());
        return rest;
      }
      bound.add(index);
      const target = prior[index]!;
      const id = sanitizeCarryRowId(rest.id) ?? sanitizeCarryRowId(target.id) ?? mintCarryRowId(target.claim, taken);
      taken.add(id);
      prior[index] = { ...target, id };
      return { ...rest, id };
    });
  };
  const walls = bind(opts.walls, priorWalls);
  const checks = bind(opts.checks, priorChecks);
  for (const ref of retire) {
    const hit = [...opts.priorWalls, ...opts.priorChecks].some((row) => carryRowMatchesRef(row, ref));
    if (!hit) unmatched.push(ref);
  }
  return { priorWalls, priorChecks, walls, checks, retiredWalls, retiredChecks, unmatched };
}

/** One wall as a parseable single line: `- [#id] <claim> — re-check: <cmd> (since <ISO>)`.
 *  The `[#…]` prefix, " — re-check: " and trailing " (since …)" markers are the
 *  round-trip anchors. */
export function renderWallLine(w: WallEntry): string {
  const recheck = (w.recheck ?? '').trim();
  const id = sanitizeCarryRowId(w.id);
  const since = w.sinceMs != null && Number.isFinite(w.sinceMs) ? ` (since ${new Date(w.sinceMs).toISOString()})` : '';
  return `- ${id ? `[#${id}] ` : ''}${w.claim.trim()}${recheck ? ` — re-check: ${recheck}` : ''}${since}`;
}

/** Parse one walls-section line back into a {@link WallEntry}; null for a
 *  non-row line (blank, prose, malformed). */
export function parseWallLine(line: string): WallEntry | null {
  const m =
    /^-\s+(?:\[#([A-Za-z0-9._:-]{1,40})\]\s+)?(.+?)(?:\s+—\s+re-check:\s+(.+?))?(?:\s+\(since\s+([^)]+)\))?\s*$/.exec(
      line,
    );
  if (!m) return null;
  const claim = (m[2] ?? '').trim();
  if (!claim) return null;
  const out: WallEntry = { claim };
  const id = sanitizeCarryRowId(m[1]);
  if (id) out.id = id;
  const recheck = (m[3] ?? '').trim();
  if (recheck) out.recheck = recheck;
  if (m[4]) {
    const t = Date.parse(m[4]);
    if (Number.isFinite(t)) out.sinceMs = t;
  }
  return out;
}

/** One check as a parseable single line: `- ✓|? [scope: …] <claim> — re-check: <cmd> — evidence: <ptr> (since <ISO>)`.
 *  `✓` = verified (evidence follows), `?` = predicted. The marker, " — re-check: ",
 *  " — evidence: " and trailing " (since …)" are the round-trip anchors.
 *
 *  EI-18741016606334594: when the recheck declares a bound about ITSELF
 *  (`--since '60 min ago'`, `tail -3`, `limit 20`), that bound renders inline
 *  next to the badge. A `✓` is a licence to skip re-checking, so the one place a
 *  reader ever reconsiders it is where the badge is read — and a claim
 *  quantified over more than its probe saw is invisible until the two sit side
 *  by side. The marker is DERIVED from `recheck`, never stored: nothing is added
 *  to {@link CheckEntry}, a re-render always reflects the CURRENT recheck, and
 *  {@link parseCheckLine} strips it so the round-trip stays byte-stable instead
 *  of growing the claim by one marker per wake. */
export function renderCheckLine(c: CheckEntry): string {
  const recheck = (c.recheck ?? '').trim();
  const verified = (c.verified ?? '').trim();
  const observed = (c.observed ?? '').trim();
  const contested = (c.contested ?? '').trim();
  const conflict = findVerificationConflict(verified, c.claim);
  const evidence = contested || verified || observed;
  const marker = contested || conflict ? '⚠' : verified ? '✓' : '?';
  const id = sanitizeCarryRowId(c.id);
  const scope = describeProbeScope(recheck);
  const probe = c.probe ? encodeContinuityProbe(c.probe) : '';
  const since = c.sinceMs != null && Number.isFinite(c.sinceMs) ? ` (since ${new Date(c.sinceMs).toISOString()})` : '';
  return `- ${marker} ${scope ? `${renderProbeScopeMarker(scope)} ` : ''}${
    id ? `[#${id}] ` : ''
  }${stripProbeScopeMarker(c.claim.trim())}${recheck ? ` — re-check: ${recheck}` : ''}${
    probe ? ` — probe: ${probe}` : ''
  }${evidence ? ` — evidence: ${evidence}` : ''}${since}`;
}

/**
 * The checks-row grammar, assembled from {@link PROBE_SCOPE_MARKER_RE} so the
 * strip pattern is LITERALLY the render pattern rather than a hand-copied twin.
 *
 * Order matters and mirrors {@link renderCheckLine} exactly: badge, scope marker,
 * `[#id]`, claim. The scope group is non-capturing — the marker is derived from
 * `recheck`, so parsing discards it and the next render re-derives it. Writing
 * this grammar out a second time by hand is the drift shape this file already
 * pays for elsewhere; there is one source, and both directions read it.
 */
const CHECK_LINE_RE = new RegExp(
  `^-\\s+(?:([✓?⚠])\\s+)?(?:${PROBE_SCOPE_MARKER_RE.source}\\s+)?(?:\\[#([A-Za-z0-9._:-]{1,40})\\]\\s+)?(.+?)` +
    `(?:\\s+—\\s+re-check:\\s+(.+?))?(?:\\s+—\\s+probe:\\s+([A-Za-z0-9_-]+))?` +
    `(?:\\s+—\\s+evidence:\\s+(.+?))?(?:\\s+\\(since\\s+([^)]+)\\))?\\s*$`,
);

/** WI-41774: a work-item flight record renders its telemetry as
 *  `- at=<ts> tool=<verb> status=… duration_ms=… error_code=… args_keys=[…]
 *  args_key_digest=<hex>`, which satisfies {@link CHECK_LINE_RE} — it only
 *  requires a leading `- `. Such a line is NOT a claim and must never become a
 *  carry row. The shape is PINNED to the real emitter by a test that formats an
 *  actual record and asserts every one of its lines is refused here, so a change
 *  to `formatWorkItemFlightRecord` fails loudly instead of silently re-opening
 *  this hole. Matched against the parsed CLAIM (markers already stripped). */
const FLIGHT_RECORD_TELEMETRY_CLAIM_RE = /^at=\S.*\btool=\S.*\bargs_key_digest=[0-9a-f]+$/;

/** Parse one checks-section line back into a {@link CheckEntry}; null for a
 *  non-row line (blank, the legend, prose, malformed). Review fold #6: the ✓|?
 *  marker is OPTIONAL on parse — an agent hand-writing a row in walls syntax
 *  (`- claim — re-check: cmd`) parses as PREDICTED instead of being silently
 *  dropped on round-trip. */
export function parseCheckLine(line: string): CheckEntry | null {
  const m = CHECK_LINE_RE.exec(line);
  if (!m) return null;
  // EI-18741016606334594: the `[scope: …]` marker is DERIVED at render time from
  // `recheck`, so it is discarded here rather than captured. Stripping it is what
  // keeps render→parse→render byte-stable; a marker absorbed into the claim would
  // grow the claim by one marker on every wake.
  const claim = stripProbeScopeMarker((m[3] ?? '').trim());
  if (!claim) return null;
  // WI-41774: refuse flight-record telemetry. Once such a line parses as a claim
  // it is re-rendered as a canonical check row, LOSING the ⟦…⟧ wrapper that let
  // mergeWorkItemFlightRecord bound it — after which nothing can ever identify it
  // again and it multiplies on every write (measured: 252 rows on one item, 1,237
  // across the workspace, crowding out 1,026 real claims). Refusing the shape here
  // is both the recurrence guard and the migration: rows already absorbed drain on
  // each note's next write, so no data backfill is needed.
  if (FLIGHT_RECORD_TELEMETRY_CLAIM_RE.test(claim)) return null;
  const out: CheckEntry = { claim };
  const id = sanitizeCarryRowId(m[2]);
  if (id) out.id = id;
  const recheck = (m[4] ?? '').trim();
  if (recheck) out.recheck = recheck;
  const probe = decodeContinuityProbe((m[5] ?? '').trim());
  if (probe) out.probe = probe;
  const evidence = (m[6] ?? '').trim();
  if (evidence) {
    // The rendered marker is the authority tier. In particular, `?` evidence is
    // deliberately context ABOUT an unverified claim and commonly says "pending"
    // or "stale"; running the contradiction detector first would misclassify that
    // expected context as CONTESTED and destroy the observed round-trip. Only a
    // purported ✓ needs the safety downgrade when its evidence contradicts it.
    if (m[1] === '?') out.observed = evidence;
    else if (m[1] === '⚠' || findVerificationConflict(evidence, claim)) out.contested = evidence;
    else out.verified = evidence;
  }
  if (m[7]) {
    const t = Date.parse(m[7]);
    if (Number.isFinite(t)) out.sinceMs = t;
  }
  return out;
}

/** Render structured fields into the canonical carry-note template (the shared
 *  SHAPE). Blank/omitted sections are skipped; returns '' when nothing is set (⇒ a
 *  clear when passed to {@link setCarryNote}). Checks render after the narrative
 *  sections; walls render last as parseable rows. */
export function renderCarryNote(fields: CarryNoteFields): string {
  const sections = CARRY_NOTE_SECTIONS.map(({ key, heading }) => {
    const v = (fields[key] ?? '').trim();
    return v.length > 0 ? `## ${heading}\n${v}` : null;
  }).filter((s): s is string => s !== null);
  const checks = (fields.checks ?? []).filter((c) => (c.claim ?? '').trim().length > 0);
  if (checks.length > 0) {
    sections.push(
      `## ${CARRY_NOTE_CHECKS_HEADING}\n${CARRY_NOTE_CHECKS_LEGEND}\n${checks.map(renderCheckLine).join('\n')}`,
    );
  }
  const walls = (fields.walls ?? []).filter((w) => (w.claim ?? '').trim().length > 0);
  if (walls.length > 0) {
    sections.push(`## ${CARRY_NOTE_WALLS_HEADING}\n${walls.map(renderWallLine).join('\n')}`);
  }
  return sections.join('\n\n');
}

/** Best-effort parse of a canonical carry-note (as produced by {@link renderCarryNote})
 *  back into fields — for inspection / loop:status rendering (P-008). A note with no
 *  recognized `## <Heading>` markers yields {} (the caller keeps the raw text). */
export function parseCarryNote(text: string): CarryNoteFields {
  const fields: CarryNoteFields = {};
  const byHeading = new Map<string, CarryNoteTextKey | 'walls' | 'checks'>(
    CARRY_NOTE_SECTIONS.map((s) => [s.heading.toLowerCase(), s.key] as const),
  );
  byHeading.set(CARRY_NOTE_WALLS_HEADING.toLowerCase(), 'walls');
  byHeading.set(CARRY_NOTE_CHECKS_HEADING.toLowerCase(), 'checks');
  // Split on lines that are exactly a known "## Heading".
  const lines = (text ?? '').split('\n');
  let cur: CarryNoteTextKey | 'walls' | 'checks' | null = null;
  let buf: string[] = [];
  const flush = () => {
    if (cur === 'walls') {
      const walls = buf.map(parseWallLine).filter((w): w is WallEntry => w !== null);
      if (walls.length) fields.walls = walls;
    } else if (cur === 'checks') {
      const checks = buf.map(parseCheckLine).filter((c): c is CheckEntry => c !== null);
      if (checks.length) fields.checks = checks;
    } else if (cur) {
      const body = buf.join('\n').trim();
      if (body) fields[cur] = body;
    }
    buf = [];
  };
  for (const line of lines) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    const key = m ? byHeading.get(m[1].toLowerCase()) : undefined;
    if (key) {
      flush();
      cur = key;
    } else if (cur) {
      buf.push(line);
    }
  }
  flush();
  return fields;
}

// ── Rescue-by-parse of a tag-serialized structured write (EI-18833865002636933) ──
//
// This module never RENDERS an XML tag shape — `renderCarryNote` emits `## Heading`
// sections and nothing else. The vocabulary below exists ONLY to recognize a caller
// mistake seen live: an agent serialized its ENTIRE structured write as one tagged
// string into `did`, so the note reached the next cold wake as a single `## Did`
// section containing literal `</did><left>…<checks>[…]` text — demoting typed `checks`
// rows to inert JSON prose and losing the ✓/? badges that tell a successor which claims
// still need re-probing. The carry-note is a cold wake's ONLY continuity.
//
// We RESCUE rather than reject, following this surface's established precedent for
// "right content, wrong shape" (loop/checkpoint.ts's `checks` z.preprocess parses a
// JSON-string array instead of refusing the write). Refusing would have produced a
// FOURTH consecutive failed checkpoint in the live incident and possibly no note at all.

/** Sibling tags whose CLOSE form, alongside a literal `</did>`, completes the
 *  malformed-write signature. Deliberately strict: notes routinely quote code, JSX and
 *  shell, so a bare `<` — or a lone `</did>` — must never trigger a rewrite. */
const CARRY_NOTE_RESCUE_SIGNATURE = /<\/(?:left|insight|next|checks|walls)>/;

function taggedSection(text: string, tag: string): string | undefined {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text);
  const v = (m?.[1] ?? '').trim();
  return v.length > 0 ? v : undefined;
}

/** Recover row entries from a rescued `<checks>`/`<walls>` block, which an agent may
 *  have written either as a JSON array or as already-rendered rows. Anything else
 *  yields no rows — a malformed block degrades to "no rows", never a failed rescue. */
function taggedRows<T>(raw: string | undefined, parseLine: (line: string) => T | null): T[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const rows = parsed.filter(
        (r): r is T =>
          !!r &&
          typeof r === 'object' &&
          typeof (r as { claim?: unknown }).claim === 'string' &&
          (r as { claim: string }).claim.trim().length > 0,
      );
      if (rows.length > 0) return rows;
    }
  } catch {
    /* not JSON — fall through to the rendered-row form */
  }
  return raw
    .split('\n')
    .map(parseLine)
    .filter((r): r is T => r !== null);
}

/**
 * Recognize a `did` value that is really a whole structured note serialized as one
 * XML-tagged string, and split it back into typed {@link CarryNoteFields}.
 *
 * Returns `null` — meaning "store this verbatim, it is ordinary prose" — unless the
 * FULL signature is present: a literal `</did>` close tag AND at least one sibling
 * close tag. Both halves are required precisely because carry-notes quote code so
 * often; an over-eager matcher would silently mangle honest notes, which is a strictly
 * worse failure than the one being fixed.
 */
export function rescueTaggedCarryNoteBlob(blob: string | null | undefined): CarryNoteFields | null {
  const text = blob ?? '';
  const close = text.indexOf('</did>');
  if (close < 0 || !CARRY_NOTE_RESCUE_SIGNATURE.test(text)) return null;

  const fields: CarryNoteFields = {};
  const did = text
    .slice(0, close)
    .replace(/^\s*<did>/, '')
    .trim();
  if (did) fields.did = did;
  // NB: tag name ≠ heading name — CARRY_NOTE_SECTIONS maps insight → 'Key insight'
  // and next → 'Next action'. Drive off the KEYS here, never the headings.
  for (const { key } of CARRY_NOTE_SECTIONS) {
    if (key === 'did') continue;
    const v = taggedSection(text, key);
    if (v) fields[key] = v;
  }
  const checks = taggedRows(taggedSection(text, 'checks'), parseCheckLine);
  if (checks.length > 0) fields.checks = checks;
  const walls = taggedRows(taggedSection(text, 'walls'), parseWallLine);
  if (walls.length > 0) fields.walls = walls;
  return fields;
}

/** Sibling sections whose CLOSE tag literally appears in a blob passed to
 *  {@link rescueTaggedCarryNoteBlob} — independent of whether the open+close PAIR
 *  actually parsed into a stored value. EI-21918217118634060: the rescue previously
 *  reported "stored correctly" whenever it ran at all, even when a sibling's close
 *  tag was present but its content never made it into `rescued` (an unmatched open
 *  tag, a tag quoted only once inside prose, a nesting the extractor could not
 *  isolate). Diffing this against `Object.keys(rescued)` is what lets the caller
 *  distinguish "nothing else was ever there" from "something was there and got
 *  silently dropped" — the exact distinction the false-success report was missing. */
export function detectCarryNoteRescueSignals(blob: string | null | undefined): CarryNoteTextKey[] {
  const text = blob ?? '';
  return CARRY_NOTE_SECTIONS.filter(({ key }) => key !== 'did' && text.includes(`</${key}>`)).map(({ key }) => key);
}

/** Shared row-section splitter: strip one `## <heading>` section of parseable rows
 *  out of a note, returning the remaining body + the parsed rows. Non-row lines
 *  inside the section (legend, prose) are dropped with it. */
function splitCarryNoteSection<T>(
  note: string | null | undefined,
  heading: string,
  parseLine: (line: string) => T | null,
): { body: string; rows: T[] } {
  const text = (note ?? '').trim();
  if (!text) return { body: '', rows: [] };
  const headingRe = new RegExp(`^##\\s+${heading}\\s*$`, 'i');
  const lines = text.split('\n');
  const bodyLines: string[] = [];
  const rows: T[] = [];
  let inSection = false;
  let sectionTail = false;
  for (const line of lines) {
    if (headingRe.test(line)) {
      inSection = true;
      sectionTail = false;
      continue;
    }
    if (inSection && /^##\s+/.test(line)) inSection = false; // a later section ends the block
    if (inSection) {
      // Generated row sections are rendered last, but callers sometimes append a
      // plain-text disposition to the raw note. Once a parsed row is followed by
      // a blank delimiter and non-row text, that text is a narrative tail, not a
      // malformed row. Keeping it in the body lets the canonical re-render place
      // it before the generated section instead of silently discarding it.
      if (sectionTail) {
        bodyLines.push(line);
        continue;
      }
      const r = parseLine(line);
      if (r !== null) rows.push(r);
      else if (rows.length > 0 && line.trim() === '') sectionTail = true;
      continue; // non-row lines inside the section are dropped with it
    }
    bodyLines.push(line);
  }
  return { body: bodyLines.join('\n').trim(), rows };
}

/** Split a note into its walls rows and everything else (the `## Walls` section
 *  removed). The wake renderer needs walls SEPARATE from the truncatable note body
 *  (a wall clipped off the end of a capped note is a dissolved commitment), and the
 *  carry-forward merge needs the body without them. */
export function splitCarryNoteWalls(note: string | null | undefined): { body: string; walls: WallEntry[] } {
  const { body, rows } = splitCarryNoteSection(note, CARRY_NOTE_WALLS_HEADING, parseWallLine);
  return { body, walls: rows };
}

/** Split a note into its checks rows and everything else (the `## Checks` section
 *  removed) — the P-001 analog of {@link splitCarryNoteWalls}. */
export function splitCarryNoteChecks(note: string | null | undefined): { body: string; checks: CheckEntry[] } {
  const { body, rows } = splitCarryNoteSection(note, CARRY_NOTE_CHECKS_HEADING, parseCheckLine);
  return { body, checks: rows };
}

/** Re-attach a walls set to a note body (any existing `## Walls` in `body` is
 *  replaced). An empty walls set yields the bare body; a blank body with walls
 *  yields a walls-only note — commitments survive a careless note clear. */
export function withCarryNoteWalls(body: string, walls: WallEntry[]): string {
  const { body: stripped } = splitCarryNoteWalls(body);
  const kept = walls.filter((w) => (w.claim ?? '').trim().length > 0);
  if (kept.length === 0) return stripped;
  const section = `## ${CARRY_NOTE_WALLS_HEADING}\n${kept.map(renderWallLine).join('\n')}`;
  return stripped ? `${stripped}\n\n${section}` : section;
}

/** Normalize an incoming walls write against the prior set: trim + drop blank
 *  claims, dedup by claim, preserve the ORIGINAL sinceMs for a claim that already
 *  stood (age is evidence — a rewrite must not reset it), stamp `nowMs` on new
 *  ones, cap at {@link CARRY_NOTE_MAX_WALLS}. */
export function normalizeWallEntries(
  entries: ReadonlyArray<{ id?: string; claim: string; recheck?: string; sinceMs?: number }>,
  prior: ReadonlyArray<WallEntry>,
  nowMs: number = Date.now(),
): WallEntry[] {
  const priorByKey = new Map(prior.map((w) => [carryRowKey(w), w] as const));
  const seen = new Set<string>();
  const out: WallEntry[] = [];
  for (const e of entries) {
    const claim = (e.claim ?? '').trim();
    const key = carryRowKey(e);
    if (!claim || seen.has(key)) continue;
    seen.add(key);
    const existing = priorRowForIncoming(e, prior, priorByKey);
    const id = sanitizeCarryRowId(e.id) ?? existing?.id;
    const recheck = (e.recheck ?? existing?.recheck ?? '').trim();
    out.push({
      ...(id ? { id } : {}),
      claim,
      ...(recheck ? { recheck } : {}),
      sinceMs: e.sinceMs ?? existing?.sinceMs ?? nowMs,
    });
    if (out.length >= CARRY_NOTE_MAX_WALLS) break;
  }
  return out;
}

/** Re-attach a checks set to a note body (any existing `## Checks` in `body` is
 *  replaced; the legend is always re-rendered). An empty checks set yields the bare
 *  body. Note: unlike walls, checks sit BEFORE any `## Walls` section so walls keep
 *  their established last-position anchor. */
export function withCarryNoteChecks(body: string, checks: CheckEntry[]): string {
  const { body: strippedAll, walls } = splitCarryNoteWalls(splitCarryNoteChecks(body).body);
  // WI-41774: the render path is DELIBERATELY uncapped — do not "fix" this by
  // slicing to CARRY_NOTE_MAX_CHECKS. An over-cap legacy note must keep its tail so
  // that patching a keyed row cannot silently evict rows nobody mentioned (P-013:
  // a loss made VISIBLE is not yet a loss AVOIDED); carry-note.test.ts pins that.
  // The runaway this bug was filed for is fixed at ADMISSION instead — parseCheckLine
  // refuses flight-record telemetry — because the growth came from junk being
  // admitted as claims, not from the absence of a render cap. A cap here would
  // destroy real carried rows to contain junk that should never have parsed.
  const kept = checks.filter((c) => (c.claim ?? '').trim().length > 0);
  const parts: string[] = [];
  if (strippedAll) parts.push(strippedAll);
  if (kept.length > 0) {
    parts.push(`## ${CARRY_NOTE_CHECKS_HEADING}\n${CARRY_NOTE_CHECKS_LEGEND}\n${kept.map(renderCheckLine).join('\n')}`);
  }
  if (walls.length > 0) {
    parts.push(`## ${CARRY_NOTE_WALLS_HEADING}\n${walls.map(renderWallLine).join('\n')}`);
  }
  return parts.join('\n\n');
}

/** Normalize an incoming checks write against the prior set — same contract as
 *  {@link normalizeWallEntries}: trim + drop blank claims, dedup by claim, preserve
 *  the ORIGINAL sinceMs for a claim that already stood, inherit recheck/verified
 *  from the prior row when omitted (a re-write must not silently drop evidence),
 *  stamp `nowMs` on new ones, cap at {@link CARRY_NOTE_MAX_CHECKS}. */
export function normalizeCheckEntries(
  entries: ReadonlyArray<{
    id?: string;
    claim: string;
    recheck?: string;
    verified?: string;
    observed?: string;
    contested?: string;
    probe?: ContinuityProbe;
    sinceMs?: number;
  }>,
  prior: ReadonlyArray<CheckEntry>,
  nowMs: number = Date.now(),
): CheckEntry[] {
  const priorByKey = new Map(prior.map((c) => [carryRowKey(c), c] as const));
  const seen = new Set<string>();
  const out: CheckEntry[] = [];
  for (const e of entries) {
    const claim = (e.claim ?? '').trim();
    // WI-42008: structured `checks` writes bypass parseCheckLine, so enforce the
    // same telemetry refusal at this admission boundary as well.
    if (FLIGHT_RECORD_TELEMETRY_CLAIM_RE.test(claim)) continue;
    const key = carryRowKey(e);
    if (!claim || seen.has(key)) continue;
    seen.add(key);
    const existing = priorRowForIncoming(e, prior, priorByKey);
    const id = sanitizeCarryRowId(e.id) ?? existing?.id;
    const recheck = (e.recheck ?? existing?.recheck ?? '').trim();
    const probe = e.probe ?? existing?.probe;
    // An explicit evidence field is an update, including an empty string that
    // deliberately clears inherited evidence. Exactly one authority slot survives:
    // verified (✓), contested (⚠), or observed (? context without verification).
    let verified = (e.verified !== undefined ? e.verified : (existing?.verified ?? '')).trim();
    let contested = (
      e.contested !== undefined
        ? e.contested
        : e.verified !== undefined || e.observed !== undefined
          ? ''
          : (existing?.contested ?? '')
    ).trim();
    let observed = (
      e.observed !== undefined
        ? e.observed
        : e.verified !== undefined || e.contested !== undefined
          ? ''
          : (existing?.observed ?? '')
    ).trim();
    if (e.contested !== undefined) {
      verified = '';
      observed = '';
    }
    if (e.observed !== undefined) {
      verified = '';
      contested = '';
    }
    if (e.verified !== undefined) observed = '';
    const conflict = findVerificationConflict(verified, claim);
    if (conflict) {
      contested = verified;
      verified = '';
      observed = '';
    }
    // Review fold #5: evidence never goes stale SILENTLY — stamp the verification
    // instant into the evidence text when it is NEWLY supplied (inherited evidence
    // keeps its original stamp), so a ✓ observed 20 wakes ago visibly carries its
    // age instead of rendering with fresh-evidence authority.
    const suppliedEvidence = (e.verified ?? e.contested ?? e.observed ?? '').trim();
    const existingEvidence = (existing?.verified ?? existing?.contested ?? existing?.observed ?? '').trim();
    const newlySupplied = Boolean(suppliedEvidence) && suppliedEvidence !== existingEvidence;
    if (newlySupplied && verified && !/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(verified)) {
      verified = `${verified} @${new Date(nowMs).toISOString()}`;
    }
    if (newlySupplied && contested && !/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(contested)) {
      contested = `${contested} @${new Date(nowMs).toISOString()}`;
    }
    if (newlySupplied && observed && !/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(observed)) {
      observed = `${observed} @${new Date(nowMs).toISOString()}`;
    }
    out.push({
      ...(id ? { id } : {}),
      claim,
      ...(recheck ? { recheck } : {}),
      ...(probe ? { probe } : {}),
      ...(contested ? { contested } : {}),
      ...(verified ? { verified } : {}),
      ...(observed ? { observed } : {}),
      sinceMs: e.sinceMs ?? existing?.sinceMs ?? nowMs,
    });
    if (out.length >= CARRY_NOTE_MAX_CHECKS) break;
  }
  return out;
}

/**
 * Patch only rows that already exist in a carried note, preserving the prior
 * order and row count even when the note predates today's row cap. A normal
 * merge intentionally normalizes the whole union and therefore cannot safely
 * refresh a selected row in a legacy over-cap note: the cap would evict the
 * unmentioned tail. Returning null when any supplied row is new keeps callers'
 * existing additive overflow policy unchanged for true upserts.
 *
 * Stable ids are authoritative, with the same narrow id-introduction migration
 * that the normalizer uses: an id-bearing row may match an id-less prior row
 * when its claim is unchanged. The returned array is a new array, but prior row
 * objects that were not selected are retained as-is.
 */
export function patchExistingCheckEntries(
  entries: ReadonlyArray<{
    id?: string;
    claim: string;
    recheck?: string;
    verified?: string;
    observed?: string;
    contested?: string;
    probe?: ContinuityProbe;
    sinceMs?: number;
  }>,
  prior: ReadonlyArray<CheckEntry>,
  nowMs: number = Date.now(),
): CheckEntry[] | null {
  if (entries.length === 0) return [...prior];

  const priorByKey = new Map(prior.map((c) => [carryRowKey(c), c] as const));
  const updates = new Map<CheckEntry, CheckEntry>();
  const seen = new Set<string>();
  for (const entry of entries) {
    const claim = (entry.claim ?? '').trim();
    const key = carryRowKey(entry);
    if (!claim || seen.has(key)) continue;
    seen.add(key);

    const existing = priorRowForIncoming(entry, prior, priorByKey);
    if (!existing) return null;
    const updated = normalizeCheckEntries([entry], [existing], nowMs)[0];
    if (updated) updates.set(existing, updated);
  }

  return prior.map((row) => updates.get(row) ?? row);
}

/**
 * WI-6813: the walls+checks merge, extracted PURE so it can run INSIDE
 * {@link setCarryNoteWithPrior}'s locked transaction (via its `transform` seam)
 * instead of as a caller-side read → merge → write. That caller-side shape has a
 * genuine race: between the prior read and the write, a concurrent writer on the
 * same scope can land, and the merge then silently clobbers their rows.
 *
 * Semantics — IDENTICAL for both row kinds, deliberately: an EXPLICIT arg wins
 * outright (its `[]` is the only true clear) → else the raw note's own rendered
 * section wins → else the PRIOR rows carry forward, across rewrites AND across a
 * note clear. A rows-only write likewise carries the prior narrative body forward.
 *
 * ⚠ THE CLEAR BEHAVIOUR IS A DELIBERATE DIVERGENCE from work_items:checkpoint —
 * do not harmonise them. A LOOP's rows SURVIVE a note clear (the note persists as
 * walls/checks-only and renders every wake until explicitly `[]`-ed); WORK-ITEM
 * rows are WIPED on clear, so `work_items:complete`'s terminal cleanup cannot
 * resurrect a checks-only checkpoint on a closed item. Both are intentional and
 * tested on their own side. Copying the work-item rule here would silently drop
 * owner-gated WALLS — precisely the failure walls exist to prevent.
 *
 * EI-19463731740128181: an EXPLICIT list REPLACES — {@link normalizeCheckEntries}
 * and {@link normalizeWallEntries} iterate the INCOMING rows only, using `prior`
 * solely to inherit recheck/verified/sinceMs onto claims that reappear. A carried
 * claim the caller leaves out is therefore DROPPED. That is defensible as semantics
 * (it is the only way to retire a stale row) but it was SILENT here: the reply
 * reported a post-merge COUNT and nothing else, so adding one row to a carried set —
 * the single most natural use of the parameter, and what the `checksLint` advisory
 * actively tells you to do — destroyed the rest behind an `ok: true`. `droppedWalls`
 * / `droppedChecks` make the loss VISIBLE so it is never inferable only by diffing a
 * count you would have had to record beforehand. Mirrors the `checksDropped` report
 * work_items:checkpoint landed for the identical defect (EI-19460631385508515).
 *
 * P-013 (fleet-lead-instrumentation-audit-2026-08-09): making the loss visible was
 * necessary but NOT sufficient — the report lands AFTER the write, so the rows are
 * already gone by the time you read it. Two additions make the loss AVOIDABLE:
 *
 *  1. `mode: 'merge'` (the default at both checkpoint tool boundaries) — supplied rows upsert onto the carried set; unmentioned rows
 *     survive. The natural "add one row to my carried set" write stops being
 *     destructive. Explicit `replace` remains the only way to retire a row.
 *  2. A row `id` — identity independent of WORDING (see {@link carryRowKey}). Without
 *     it, tightening a claim's phrasing makes it a NEW row: it loses the evidence and
 *     `sinceMs` it had inherited, and the old wording reads to the drop-report as a
 *     carried claim that vanished. Both were observed live, twice.
 */
export function mergeCarryRows(opts: {
  /** The AUTHORITATIVE prior note. Inside a `transform` this is the locked row's. */
  priorNote: string | null | undefined;
  /** The note this write proposes (rendered structured fields, or the raw string). */
  baseNote: string | null | undefined;
  /** An EXPLICIT walls arg — `[]` clears; `undefined` defers to the note/prior.
   *  P-025: a row's `replaces` names the carried row it edits (see {@link resolveCarryRowRefs}). */
  walls?: ReadonlyArray<{ id?: string; claim: string; recheck?: string; sinceMs?: number; replaces?: string }>;
  /** An EXPLICIT checks arg — `[]` clears; `undefined` defers to the note/prior. */
  checks?: ReadonlyArray<{
    id?: string;
    replaces?: string;
    claim: string;
    recheck?: string;
    verified?: string;
    observed?: string;
    contested?: string;
    probe?: ContinuityProbe;
    sinceMs?: number;
  }>;
  /** Whether this call writes a narrative at all (structured fields or a raw note). */
  hasNoteWrite: boolean;
  /**
   * Structured narrative fields supplied by the caller. An omitted property is
   * inherited under `mode:'merge'`; an explicit empty string clears that section.
   * This metadata is separate from `baseNote` because renderCarryNote intentionally
   * omits blank sections, so the rendered string cannot distinguish those two cases.
   */
  narrativeFields?: Pick<CarryNoteFields, 'did' | 'left' | 'insight' | 'next'>;
  /**
   * P-013 — how a supplied row list combines with the carried set.
   *
   * ⚠ THIS FUNCTION DEFAULTS TO `'replace'`. The merge default is a property of the
   * TOOL BOUNDARY, not of this helper: `loop:checkpoint` and `work_items:checkpoint`
   * each resolve `rowsMode ?? 'merge'` from their own args and pass the result down
   * EXPLICITLY. Defaulting here as well would apply that default twice — which is
   * exactly how it regressed once already: the boundaries kept behaving correctly (so
   * no live symptom appeared) while every direct caller silently lost replace
   * semantics, and with them the whole EI-19463731740128181 drop report, since a merge
   * drops nothing by construction. Callers that want merge must ASK for it.
   *
   * `'replace'` (default): the supplied list REPLACES the carried set. Rows the caller
   * left out are dropped — and named in `droppedWalls`/`droppedChecks`. The only way
   * to retire a row, and the only mode under which `[]` clears.
   *
   * `'merge'`: supplied rows UPSERT onto the carried set by {@link carryRowKey} —
   * carried rows the caller did not mention SURVIVE. Turns "add one row" from a
   * destructive write into an additive one. Under merge a `[]` list is a NO-OP, not
   * a clear: clearing requires `'replace'`, so a clear is always deliberate.
   *
   * That survival holds UP TO THE ROW CAP, and not past it (EI-21229591144264047). If
   * the union overflows, supplied rows win and the carried rows that yield are reported
   * in `droppedWalls`/`droppedChecks` — merge is non-destructive while it fits, not
   * unconditionally, and any doc that says otherwise is describing the fitting case only.
   * See {@link upsertOntoPrior} for which carried row yields: evidence-bearing rows sink
   * last, so a ? PREDICTED row is evicted before a ✓ VERIFIED one.
   */
  mode?: 'replace' | 'merge';
  /**
   * P-025 — carried rows to RETIRE in this same write, named by `[#id]` or exact claim,
   * across walls and checks. Valid under either mode, so dropping one row no longer
   * requires a full `'replace'` re-send. Retired rows are reported in
   * `retiredWalls`/`retiredChecks`, NOT in `droppedWalls`/`droppedChecks`.
   */
  retire?: ReadonlyArray<string>;
  nowMs?: number;
}): {
  note: string;
  narrativeBody: string;
  walls: WallEntry[];
  checks: CheckEntry[];
  /** P-025 — prior WALL claims removed because the caller named them in `retire`. */
  retiredWalls: string[];
  /** P-025 — prior CHECK claims removed because the caller named them in `retire`. */
  retiredChecks: string[];
  /** P-025 — `replaces`/`retire` refs that named no carried row. A `replaces` row whose
   *  ref is unmatched is treated as the new row it then is. */
  unmatchedRowRefs: string[];
  /** Prior WALL claims this write did not carry forward (see the EI-19463731740128181
   *  note above). Empty when nothing was lost — including the carry-forward path,
   *  where `undefined` preserves every prior row by construction. */
  droppedWalls: string[];
  /** Prior CHECK claims this write did not carry forward. Same contract as
   *  {@link droppedWalls}. */
  droppedChecks: string[];
  /**
   * P-013 — SUPPLIED rows that did not make it into the stored set, i.e. the row cap
   * cut them. The mirror image of `droppedChecks`/`droppedWalls`, which report rows
   * lost from the PRIOR set and therefore cannot see this: a caller who sends 13 rows
   * into a 12-row cap silently loses the 13th.
   *
   * Pre-existing (the cap always worked this way). On `mode:'merge'`, overflow is
   * ordered supplied-first, so the carried tail is evicted and these arrays normally
   * remain empty; they still report supplied rows that overflow a merge with no prior
   * rows (or any other path where a supplied row itself cannot fit).
   */
  overflowWalls: string[];
  /** Supplied CHECK claims the row cap cut. Same contract as {@link overflowWalls}. */
  overflowChecks: string[];
} {
  const storedWallParts = splitCarryNoteWalls(opts.priorNote ?? null);
  const storedCheckParts = splitCarryNoteChecks(storedWallParts.body);
  // P-025: bind `replaces` rows to their targets and remove `retire`d rows up front, so
  // everything below sees an ordinary id-keyed upsert against the remaining carried set.
  const refs = resolveCarryRowRefs({
    priorWalls: storedWallParts.walls,
    priorChecks: storedCheckParts.checks,
    walls: opts.walls,
    checks: opts.checks,
    retire: opts.retire,
  });
  opts = { ...opts, walls: refs.walls, checks: refs.checks };
  const priorParts = { ...storedWallParts, walls: refs.priorWalls };
  const priorCheckParts = { ...storedCheckParts, checks: refs.priorChecks };
  const rawParts = splitCarryNoteWalls(opts.baseNote ?? '');
  const rawCheckParts = splitCarryNoteChecks(rawParts.body);
  const merging = opts.mode === 'merge';
  /** What the CALLER actually offered this write, before the merge pre-pass folds the
   *  prior set in — the only list against which "your row did not fit" is decidable. */
  const suppliedWalls = opts.walls ?? (rawParts.walls.length > 0 ? rawParts.walls : undefined);
  const suppliedChecks = opts.checks ?? (rawCheckParts.checks.length > 0 ? rawCheckParts.checks : undefined);
  const patchedChecks =
    merging && suppliedChecks !== undefined && suppliedChecks.length > 0
      ? patchExistingCheckEntries(suppliedChecks, priorCheckParts.checks, opts.nowMs)
      : null;
  const walls =
    opts.walls !== undefined
      ? normalizeWallEntries(
          upsertOntoPrior(opts.walls, priorParts.walls, merging, CARRY_NOTE_MAX_WALLS),
          priorParts.walls,
          opts.nowMs,
        )
      : rawParts.walls.length > 0
        ? normalizeWallEntries(
            upsertOntoPrior(rawParts.walls, priorParts.walls, merging, CARRY_NOTE_MAX_WALLS),
            priorParts.walls,
            opts.nowMs,
          )
        : priorParts.walls;
  const checks =
    patchedChecks !== null
      ? patchedChecks
      : opts.checks !== undefined
        ? normalizeCheckEntries(
            upsertOntoPrior(opts.checks, priorCheckParts.checks, merging, CARRY_NOTE_MAX_CHECKS),
            priorCheckParts.checks,
            opts.nowMs,
          )
        : rawCheckParts.checks.length > 0
          ? normalizeCheckEntries(
              upsertOntoPrior(rawCheckParts.checks, priorCheckParts.checks, merging, CARRY_NOTE_MAX_CHECKS),
              priorCheckParts.checks,
              opts.nowMs,
            )
          : priorCheckParts.checks;
  const priorNarrative = parseCarryNote(priorCheckParts.body);
  const narrativeBody =
    opts.hasNoteWrite && merging && opts.narrativeFields
      ? renderCarryNote({
          did: opts.narrativeFields.did !== undefined ? opts.narrativeFields.did : priorNarrative.did,
          left: opts.narrativeFields.left !== undefined ? opts.narrativeFields.left : priorNarrative.left,
          insight: opts.narrativeFields.insight !== undefined ? opts.narrativeFields.insight : priorNarrative.insight,
          next: opts.narrativeFields.next !== undefined ? opts.narrativeFields.next : priorNarrative.next,
        })
      : opts.hasNoteWrite
        ? rawCheckParts.body
        : priorCheckParts.body;
  return {
    note: withCarryNoteWalls(withCarryNoteChecks(narrativeBody, checks), walls),
    narrativeBody,
    walls,
    checks,
    droppedWalls: droppedClaims(priorParts.walls, walls),
    droppedChecks: droppedClaims(priorCheckParts.checks, checks),
    overflowWalls: suppliedWalls ? droppedClaims(suppliedWalls, walls) : [],
    overflowChecks: suppliedChecks ? droppedClaims(suppliedChecks, checks) : [],
    retiredWalls: refs.retiredWalls,
    retiredChecks: refs.retiredChecks,
    unmatchedRowRefs: refs.unmatched,
  };
}

/**
 * P-013 merge pre-pass: expand a supplied row list to include the carried rows it did
 * not mention, so the normalizer downstream is unchanged — it still sees ONE incoming
 * list and applies dedup, inheritance and the cap exactly once.
 *
 * Order is deliberate: an upserted row keeps its PRIOR position and genuinely-new rows
 * append, so a merge does not reshuffle a note the author reads every wake. Under
 * `replace` (or an empty prior) this is the identity function.
 *
 * Note the cap still applies afterwards. When the merge union fits, the existing
 * carried-first order is preserved so ordinary notes do not reshuffle. When the union
 * overflows the cap, supplied rows move first so normalization evicts the carried tail
 * rather than the row the caller just supplied; that eviction surfaces through the
 * ordinary `droppedChecks` report.
 *
 * WHICH carried row yields is decided by EVIDENCE, not position (EI-21229591144264047).
 * The supplied-beats-carried rule above says nothing about ordering *within* the yielding
 * remainder, and leaving it positional meant a ✓ VERIFIED row could be evicted while a
 * ? PREDICTED one survived purely by sitting earlier in the note — losing the expensive
 * half of the pair. {@link evidenceFirst} sinks the PREDICTED rows to the tail so the cap
 * cuts the cheapest-to-reproduce rows first.
 *
 * ⚠ REACH LIMIT of that rule (EI-21514029457263901). Supplied rows are placed FIRST, so
 * `evidenceFirst` only decides anything while the supplied list leaves seats for carried
 * rows to compete for. Once the supplied list ALONE meets `maxRows`, every unmatched
 * carried row is evicted regardless of evidence — which is precisely the write that loses
 * the most rows at once. Do not restate the evidence rule as an unconditional guarantee;
 * `carry-note.test.ts` "evidence ordering STOPS PROTECTING once the supplied list alone
 * fills the cap" pins this so the prose cannot drift back.
 */
function upsertOntoPrior<T extends { id?: string; claim: string }>(
  supplied: ReadonlyArray<T>,
  prior: ReadonlyArray<{ id?: string; claim: string; verified?: string; observed?: string; contested?: string }>,
  merging: boolean,
  maxRows: number,
): ReadonlyArray<T | { id?: string; claim: string }> {
  if (!merging || prior.length === 0) return supplied;
  const suppliedByKey = new Map(supplied.map((r) => [carryRowKey(r), r] as const));
  const priorByKey = new Map(prior.map((r) => [carryRowKey(r), r] as const));
  /**
   * A caller may add ids to an existing note in order to make future rewrites
   * wording-independent. Treat that as an in-place migration when the claim is
   * unchanged, rather than as a second row in the merge union. This is deliberately
   * narrower than changing carryRowKey itself: an id and a claim remain separate
   * namespaces once both rows are explicitly keyed.
   */
  const suppliedToPriorKey = new Map<string, string>();
  const suppliedForPrior = new Map<string, T>();
  const matchedPriorKeys = new Set<string>();
  for (const row of supplied) {
    const suppliedKey = carryRowKey(row);
    if (suppliedToPriorKey.has(suppliedKey)) continue;

    let priorKey = priorByKey.has(suppliedKey) ? suppliedKey : undefined;
    if (!priorKey && sanitizeCarryRowId(row.id)) {
      const claim = row.claim.trim();
      const legacy = claim
        ? prior.find(
            (candidate) =>
              !sanitizeCarryRowId(candidate.id) &&
              !matchedPriorKeys.has(carryRowKey(candidate)) &&
              candidate.claim.trim() === claim,
          )
        : undefined;
      priorKey = legacy ? carryRowKey(legacy) : undefined;
    }

    if (priorKey && !matchedPriorKeys.has(priorKey)) {
      suppliedToPriorKey.set(suppliedKey, priorKey);
      suppliedForPrior.set(priorKey, suppliedByKey.get(suppliedKey)!);
      matchedPriorKeys.add(priorKey);
    }
  }

  const unionKeys = new Set(prior.map(carryRowKey));
  for (const suppliedKey of suppliedByKey.keys()) {
    if (!suppliedToPriorKey.has(suppliedKey)) unionKeys.add(suppliedKey);
  }

  // Preserve the established carried-first order while the union fits. Once the cap
  // would evict a row, prefer the caller's supplied rows and let the carried tail yield.
  // This is intentionally conditional: reordering every additive write would make
  // otherwise stable carry notes churn on every wake.
  if (unionKeys.size > maxRows) {
    const yielding = prior.filter((p) => !suppliedForPrior.has(carryRowKey(p)));
    return [...supplied, ...evidenceFirst(yielding)];
  }

  const out: Array<T | { id?: string; claim: string }> = [];
  const used = new Set<string>();
  for (const p of prior) {
    const key = carryRowKey(p);
    const replacement = suppliedForPrior.get(key);
    if (replacement) used.add(carryRowKey(replacement));
    out.push(replacement ?? p);
  }
  for (const s of supplied) {
    if (!used.has(carryRowKey(s))) out.push(s);
  }
  return out;
}

/** Does this carried row carry an OBSERVATION — ✓ VERIFIED, ⚠ CONTESTED, or useful
 *  non-authoritative context on a ? PREDICTED row — as opposed to a bare hypothesis?
 *  Deliberately the same `verified ?? contested ?? observed`
 *  evidence test {@link normalizeCheckEntries} already uses when deciding whether to stamp
 *  a row's evidence, so "has evidence" cannot come to mean two different things in one file.
 *
 *  A {@link WallEntry} has NEITHER field, so every wall reads as evidence-less and
 *  {@link evidenceFirst} is the identity for walls — wall order is unchanged by this rule. */
function carriesEvidence(row: { verified?: string; observed?: string; contested?: string }): boolean {
  return Boolean((row.verified ?? row.contested ?? row.observed ?? '').trim());
}

/** R-6(a) (acceptance-machinery-seam-fixes-2026-09-16): a PROHIBITION — "do not X",
 *  "never Y", "must not Z", a ⛔ rail — is the row whose loss is least recoverable,
 *  and it is precisely the row that carries no evidence, because a prohibition is not
 *  an observation: there is nothing to attach. Ranking purely on evidence therefore
 *  cuts the safety rails FIRST and keeps the reproducible measurements, which is
 *  backwards — a measurement can be re-run, while a successor who never reads the rail
 *  simply re-does the thing it forbade.
 *
 *  Deliberately over-inclusive: a descriptive "never" ("this branch never fires") is
 *  matched too. That asymmetry is the point — a false positive costs one retained row
 *  at the cap, a false negative costs the rail itself. */
const CARRY_PROHIBITION_RE = /⛔|\b(?:do not|do NOT|don'?t|never|must not|mustn'?t|under no circumstances)\b/i;

export function isProhibitionShaped(row: { claim?: string }): boolean {
  return CARRY_PROHIBITION_RE.test((row.claim ?? '').trim());
}

/** Stable partition putting rows that must survive the cap ahead of the rest, so a
 *  downstream cap that cuts from the tail cuts the cheapest-to-reproduce rows first.
 *  Two rows qualify: one that CARRIES EVIDENCE (expensive to re-derive) and one that
 *  is PROHIBITION-SHAPED (unrecoverable once dropped — see {@link isProhibitionShaped}).
 *  Stable WITHIN each tier: two rows of equal rank keep their established relative
 *  order, so this reorders a note only when the cap was about to destroy something
 *  it should not. */
export function evidenceFirst<
  T extends { verified?: string; observed?: string; contested?: string; claim?: string },
>(rows: ReadonlyArray<T>): T[] {
  const retained: T[] = [];
  const predicted: T[] = [];
  for (const row of rows) (carriesEvidence(row) || isProhibitionShaped(row) ? retained : predicted).push(row);
  return [...retained, ...predicted];
}

/** Prior claims absent from the surviving set, compared on the SAME {@link carryRowKey}
 *  the normalizers dedup by — so a row that merely changed its recheck/evidence, was
 *  re-passed with surrounding whitespace, (P-013) was RE-WORDED under a stable `id`, or
 *  was just promoted from an id-less legacy row never reads as dropped. The reported
 *  string is still the human-readable claim, since that is what a caller needs to
 *  re-send. Blank prior claims are ignored: they can never be re-passed (the normalizers
 *  skip them), so counting them would report a permanent phantom loss on every write. */
function droppedClaims(
  prior: ReadonlyArray<{ id?: string; claim: string }>,
  kept: ReadonlyArray<{ id?: string; claim: string }>,
): string[] {
  const keptKeys = new Set(kept.map((r) => carryRowKey(r)));
  const promotedLegacyClaims = new Set(kept.filter((r) => sanitizeCarryRowId(r.id)).map((r) => (r.claim ?? '').trim()));
  return prior
    .filter(
      (r) =>
        (r.claim ?? '').trim().length > 0 &&
        !keptKeys.has(carryRowKey(r)) &&
        (Boolean(sanitizeCarryRowId(r.id)) || !promotedLegacyClaims.has((r.claim ?? '').trim())),
    )
    .map((r) => (r.claim ?? '').trim());
}

// ── External-state-claim lint (P-009) ────────────────────────────────────────

const CLAIM_ASSERTION_RE = /\b(MUST|expects?|alarm if|will\s+(?:roll|change|move|land)|anchor(?:ed)?\s+on)\b/i;
/**
 * EI-20137618267685442: process/file handles are external state too, but the
 * motivating carry prose did not use one of CLAIM_ASSERTION_RE's verbs (it
 * said "the log is /tmp/..." and then treated an absent marker as permission
 * to re-run). Keep this deliberately narrow: only familiar durable handle
 * shapes plus a lifecycle/action word enter the advisory, so ordinary paths
 * in narrative prose remain quiet.
 */
const PROCESS_HANDLE_RE: ReadonlyArray<RegExp> = [
  /(?:^|[\s`"'(])\/(?:tmp|var\/tmp|run|var\/run|home)\/[^\s`"',;)]+/i,
  /\b(?:pid|process\s+id)\s*[:=#]?\s*\d+\b/i,
  /\bbash[_ -]?id\s*[:=#]?\s*[A-Za-z0-9._:-]+\b/i,
];
const PROCESS_HANDLE_ACTION_RE =
  /\b(?:absent|missing|not\s+found|dead|stale|alive|running|finished|complete|completion|marker|grep|poll|await|re-?run|relaunch|start|run|wait)\b/i;

function hasProcessHandleClaim(line: string): boolean {
  return PROCESS_HANDLE_RE.some((pattern) => pattern.test(line)) && PROCESS_HANDLE_ACTION_RE.test(line);
}

function processHandleTokens(line: string): string[] {
  const tokens: string[] = [];
  for (const pattern of PROCESS_HANDLE_RE) {
    const matches = line.match(pattern) ?? [];
    for (const match of matches) {
      const token = match.trim().replace(/^[`"'(]+/, '');
      if (token) tokens.push(token);
    }
  }
  return tokens;
}
const CLAIM_TOKEN_RES: ReadonlyArray<RegExp> = [
  // content-hash / sha-like: ≥8 hex with at least one letter (review fold #4 — this
  // fleet habitually quotes 10-char short-shas; the letter requirement keeps plain
  // numbers like "12345678" from reading as hashes).
  /\b(?=[0-9a-f]*[a-f])[0-9a-f]{8,40}\b/gi,
  // task-manager/types.ts newTaskId(): 9-char base-36 time prefix + 10-char
  // base-36 random suffix. These durable handles are the only stable identity a
  // cold successor has for capability:bash / PTY work, so an exact task id in a
  // check row is a stronger coverage anchor than similar surrounding prose. Require
  // both a digit and a letter so an ordinary 19-letter word is not promoted to an id.
  /\b(?=[0-9a-z]{19}\b)(?=[0-9a-z]*\d)(?=[0-9a-z]*[a-z])[0-9a-z]{19}\b/g,
  /\b(?:WI|EI|F)-\d+\b/g, // work-item / insight ids
  /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/g, // ISO timestamps
];

/** Stable row ids are explicit probe anchors. Keep their extraction tied to the
 * rendered `[#id]` grammar so arbitrary hyphenated prose is not treated as a
 * check key by accident. */
const PROBE_ROW_ID_RE = /\[#([A-Za-z0-9._:-]{1,40})\]/g;

/** Review fold #1: external-state NOUNS. The motivating incident line — "expect the
 *  hash to ROLL, count under the new hash" — carries an assertion verb but NO concrete
 *  token, so a token-only lint skips its own root incident. A noun names the external
 *  state being asserted about; coverage then means a check/wall row mentions the same
 *  noun. */
const CLAIM_NOUN_RE = /\b(hash|sha|generation|watermark|anchor|floor|denominator|tick)\b/gi;

/** Advisory lint (cold-carry-system-hardening-2026-07-19 P-009): find prose lines that
 *  ASSERT external state — assertion verb + a distinctive token (hash, WI/EI id, ISO
 *  instant) OR an external-state noun — where NONE of those appear in any check/wall
 *  row. Such a line is a carried claim with no probe — the exact shape of the
 *  phantom-re-anchor incident ("expect the hash to ROLL" with no tick_at-vs-restart
 *  check). Returns the flagged lines (clipped, max 3); never blocks a write. */
export function lintUncheckedExternalClaims(prose: string, probeText: string): string[] {
  const flagged: string[] = [];
  const probes = probeText.toLowerCase();
  // EI-21494640395547961 — word set for the semantic-coverage limb below, built once
  // per call; the per-line loop reuses it.
  const probeWordSet = new Set((probeText ?? '').toLowerCase().match(/[a-z0-9][a-z0-9._:/-]*/g));
  const probeIdPatterns = [...(probeText ?? '').matchAll(PROBE_ROW_ID_RE)].map((m) => {
    const id = (m[1] ?? '').toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:^|[^a-z0-9._:-])${id}(?:$|[^a-z0-9._:-])`, 'i');
  });
  for (const rawLine of (prose ?? '').split('\n')) {
    const line = rawLine.trim();
    const processHandleClaim = hasProcessHandleClaim(line);
    if (!line || (!CLAIM_ASSERTION_RE.test(line) && !processHandleClaim)) continue;
    const coveredByRowId = probeIdPatterns.some((pattern) => pattern.test(line));
    const tokens: string[] = [];
    for (const re of CLAIM_TOKEN_RES) {
      re.lastIndex = 0;
      for (const m of line.matchAll(re)) tokens.push(m[0]);
    }
    if (tokens.length === 0) {
      // #1: no concrete token — fall back to external-state nouns.
      CLAIM_NOUN_RE.lastIndex = 0;
      for (const m of line.matchAll(CLAIM_NOUN_RE)) tokens.push(m[0]);
    }
    // Handle-shaped claims need their own coverage anchor. A path/PID/
    // bash_id is the identity a successor can re-check; without it, a marker
    // assertion can silently refer to a different run after a respawn.
    if (processHandleClaim) tokens.push(...processHandleTokens(line));
    if (tokens.length === 0) continue;
    // EI-21494640395547961: exact-substring coverage misses a check row that carries
    // the SAME concern in different words ("generation identity through its terminal
    // boundary" ↔ a row about protecting qualified paths through terminal), which
    // flagged generic verification rules behind ok:true writes twice in one session.
    // Word-overlap limb: when most of the line's words appear anywhere in the
    // checks/walls text, some row already carries this concern. Advisory lint, fail-
    // generous: a rare missed advisory costs less than a recurring false positive.
    // Very short lines stay on the exact paths above — overlap is too weak a signal.
    const lineWords = (line.toLowerCase().match(/[a-z0-9][a-z0-9._:/-]*/g) ?? []).filter((w) => w.length >= 3);
    const coveredByOverlap =
      lineWords.length >= 6 && lineWords.filter((w) => probeWordSet.has(w)).length / lineWords.length >= 0.4;
    const covered = coveredByRowId || tokens.some((t) => probes.includes(t.toLowerCase())) || coveredByOverlap;
    if (!covered) {
      flagged.push(line.length > 160 ? `${line.slice(0, 157)}…` : line);
      if (flagged.length >= 3) break;
    }
  }
  return flagged;
}

/** R-6(b) (acceptance-machinery-seam-fixes-2026-09-16): a carry surface that names a
 *  scratch artifact by a RELATIVE path — `scratchpad/p012-eval.json`, `./scratchpad/x` —
 *  is unresolvable to the one reader it was written for. The session scratchpad lives
 *  OUTSIDE the repo at an absolute, PER-SESSION path, so the same relative string
 *  resolves to nothing from the repo root and, after a respawn, to a different session's
 *  directory. The artifact is right there on disk and the successor re-derives it anyway,
 *  which is the whole cost this lint exists to avoid.
 *
 *  Deliberately does NOT match an ALREADY-absolute reference (`/tmp/.../scratchpad/x` —
 *  the `scratchpad/` there is preceded by `/`) nor the in-tree `.papercusp/scratch/`,
 *  which is repo-relative and therefore resolvable by anyone.
 *
 *  Returns the offending references (deduped, clipped, max 3); never blocks a write. */
const RELATIVE_SCRATCH_RE = /(?:(?<=^)|(?<=[\s"'`([<]))(?:\.\/)?scratchpad\/[^\s"'`)\]>,;]+/gm;

export function lintRelativeScratchPaths(prose: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const match of (prose ?? '').matchAll(RELATIVE_SCRATCH_RE)) {
    const ref = match[0];
    if (seen.has(ref)) continue;
    seen.add(ref);
    found.push(ref.length > 120 ? `${ref.slice(0, 117)}…` : ref);
    if (found.length >= 3) break;
  }
  return found;
}

/** The advisory both checkpoint surfaces emit for {@link lintRelativeScratchPaths}, so
 *  the loop and work-item carry surfaces cannot drift into saying different things. */
export const RELATIVE_SCRATCH_ADVISORY =
  'scratch_path_lint: this note points at a scratch artifact by a RELATIVE path. The session ' +
  'scratchpad is an ABSOLUTE, per-session directory outside the repo, so this reference resolves ' +
  'to nothing from the repo root and to a DIFFERENT directory after a respawn — your successor ' +
  'will re-derive the artifact that is already sitting on disk. Rewrite it as the absolute session ' +
  'scratchpad path, or move the artifact under the in-tree `.papercusp/scratch/` (gitignored, ' +
  'repo-relative, resolvable by any reader) and cite it repo-relative. Advisory only; the write was kept.';

/**
 * Carry-note commands are read as instructions by the next wake, but their
 * preconditions can be false by the time that wake arrives. Keep the detector
 * deliberately narrow: these are the known singleton/shared-infrastructure
 * mutators where repeating an otherwise plausible imperative can replace an
 * in-flight run, restart a shared host, or mutate the shared tree.
 */
const SINGLETON_MUTATING_TARGETS = [
  'release:checkpoint-run',
  'release:deploy',
  'release:cut',
  'git-sync:run',
  'dev:restart',
  'db:migrate',
  'plans:arm-schedule',
  'loop:arm',
  'fleet:launch-on-plan',
  'fleet:take-leadership',
  'systemctl',
  'git push',
  'git reset',
  'git clean',
  'git checkout',
] as const;

/** Locate a complete mutator token, not a prefix of a lifecycle event key. */
function findSingletonTargetAt(line: string, target: string): number {
  const lowerLine = line.toLowerCase();
  const lowerTarget = target.toLowerCase();
  const isTargetWordChar = (value: string | undefined): boolean =>
    value !== undefined && /[a-z0-9_.:/-]/i.test(value);
  let from = 0;
  while (from < lowerLine.length) {
    const at = lowerLine.indexOf(lowerTarget, from);
    if (at < 0) return -1;
    const before = lowerLine[at - 1];
    const after = lowerLine[at + lowerTarget.length];
    if (!isTargetWordChar(before) && !isTargetWordChar(after)) return at;
    from = at + 1;
  }
  return -1;
}

const SINGLETON_ACTION_VERBS =
  /\b(fire|run|execute|invoke|start|restart|stop|trigger|launch|deploy|migrate|arm|push|reset|clean|checkout)\b/gi;
const NEGATED_SINGLETON_ACTION_RE =
  /\b(?:do\s+not|don't|never|avoid|refuse\s+to)\b[^.!?\n]{0,120}\b(?:fire|run|execute|invoke|start|restart|stop|trigger|launch|deploy|migrate|arm|push|reset|clean|checkout|systemctl|git)\b/i;
const RUNNABLE_RECHECK_COMMAND_RE =
  /(?:\b[a-z][\w-]*:[a-z][\w-]*\b|(?:^|[\s`([{])(?:systemctl|git|npm|pnpm|yarn|node|npx|tsx|ps|pgrep|curl|wget|rg|grep|find|sed|awk|jq|psql|sqlite3|docker|kubectl|launchctl|test|stat|ls|cat|bash|sh)\b|\|\||&&|[|;<>])/i;

export interface ImperativeActionLintMatch {
  line: string;
  target: string;
}

function targetNeedles(target: string): string[] {
  const parts = target
    .toLowerCase()
    .split(/[:\s_-]+/)
    .filter((part) => part.length >= 4);
  return [...new Set([target.toLowerCase(), ...parts])];
}

function hasRunnableCorrespondingCheck(
  target: string,
  checks: ReadonlyArray<{ claim: string; recheck?: string }>,
): boolean {
  const needles = targetNeedles(target);
  return checks.some((check) => {
    const recheck = (check.recheck ?? '').trim();
    if (!recheck || !RUNNABLE_RECHECK_COMMAND_RE.test(recheck)) return false;
    const body = `${check.claim ?? ''} ${recheck}`.toLowerCase();
    return needles.some((needle) => body.includes(needle));
  });
}

/**
 * Advisory lint for the dangerous subset of imperative carry-note prose.
 *
 * A matching `checks` row must name the same mutator (or a distinctive part of
 * its name) and carry a runnable `recheck`; a conclusion-only row, a wall, or a
 * prose instruction does not clear the warning. The write remains fail-open.
 */
export function lintUncheckedImperativeActions(
  prose: string,
  checks: ReadonlyArray<{ claim: string; recheck?: string }>,
): ImperativeActionLintMatch[] {
  const flagged: ImperativeActionLintMatch[] = [];
  for (const rawLine of (prose ?? '').split('\n')) {
    const line = rawLine.trim();
    if (!line || NEGATED_SINGLETON_ACTION_RE.test(line)) continue;
    for (const target of SINGLETON_MUTATING_TARGETS) {
      const targetAt = findSingletonTargetAt(line, target);
      if (targetAt < 0) continue;

      SINGLETON_ACTION_VERBS.lastIndex = 0;
      const actionWords = [...line.matchAll(SINGLETON_ACTION_VERBS)];
      const targetEnd = targetAt + target.length;
      const hasNearbyImperative = actionWords.some((match) => {
        const at = match.index ?? -1;
        const end = at + match[0].length;
        // Target names can contain an action-looking word (`launch` in
        // `fleet:launch-on-plan`, `push` in `git push`). That token names the
        // mutator; it is not an instruction to invoke it.
        const overlapsTarget = at < targetEnd && end > targetAt;
        return at >= 0 && !overlapsTarget && Math.abs(at - targetAt) <= 120;
      });
      if (!hasNearbyImperative) continue;
      if (hasRunnableCorrespondingCheck(target, checks)) continue;

      flagged.push({
        line: line.length > 240 ? `${line.slice(0, 237)}…` : line,
        target,
      });
      break;
    }
    if (flagged.length >= 3) break;
  }
  return flagged;
}

// ── The journal ring (lifted verbatim from hive/wake.ts — the Queen's L1a
//    trajectory ring, now the shared default; wake.ts re-exports these) ────────

/** Carry-journal ring bounds (L1a): entries kept, per-note chars, total chars. */
export const CARRY_JOURNAL_MAX_ENTRIES = 15;
export const CARRY_JOURNAL_NOTE_MAX_CHARS = 600;
export const CARRY_JOURNAL_TOTAL_MAX_CHARS = 6_000;

/**
 * The fields that identify the work-item subject of a checkpoint. Keep this
 * list explicit and ordered: JSON object insertion order is not a structural
 * identity contract, while a journal entry must remain comparable after the
 * work-item row is rewritten or re-projected.
 */
export const WORK_ITEM_SUBJECT_FINGERPRINT_VERSION = 1 as const;
export const WORK_ITEM_SUBJECT_FIELDS = [
  'id',
  'harness',
  'kind',
  'title',
  'summary',
  'state',
] as const;

export interface WorkItemSubject {
  id: string;
  harness: string | null;
  kind: string;
  title: string;
  summary: string;
  state: string;
}

/** Versioned metadata stored on newly appended work-item checkpoint entries. */
export interface WorkItemSubjectFingerprint {
  version: typeof WORK_ITEM_SUBJECT_FINGERPRINT_VERSION;
  sha256: string;
}

export type WorkItemSubjectFingerprintStatus = 'current' | 'mismatch' | 'unknown';

export interface WorkItemSubjectFingerprintComparison {
  status: WorkItemSubjectFingerprintStatus;
  current?: WorkItemSubjectFingerprint;
  stored?: WorkItemSubjectFingerprint;
}

/** Compute a stable structural SHA-256 over the canonical subject fields. */
export function computeWorkItemSubjectFingerprint(subject: WorkItemSubject): WorkItemSubjectFingerprint {
  const structural = WORK_ITEM_SUBJECT_FIELDS.map((field) => [field, subject[field] ?? null]);
  return {
    version: WORK_ITEM_SUBJECT_FINGERPRINT_VERSION,
    sha256: createHash('sha256').update(JSON.stringify(structural), 'utf8').digest('hex'),
  };
}

/** Back-compat-friendly short name for callers that describe this as a subject fingerprint. */
export const workItemSubjectFingerprint = computeWorkItemSubjectFingerprint;

/** Accept only the current metadata shape; legacy journal entries remain unknown. */
export function normalizeWorkItemSubjectFingerprint(value: unknown): WorkItemSubjectFingerprint | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as { version?: unknown; sha256?: unknown };
  if (
    candidate.version !== WORK_ITEM_SUBJECT_FINGERPRINT_VERSION ||
    typeof candidate.sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/i.test(candidate.sha256)
  ) return undefined;
  return { version: WORK_ITEM_SUBJECT_FINGERPRINT_VERSION, sha256: candidate.sha256.toLowerCase() };
}

/** Compare the newest journal metadata with the current authoritative subject. */
export function compareWorkItemSubjectFingerprint(
  subject: WorkItemSubject | null | undefined,
  storedValue: unknown,
): WorkItemSubjectFingerprintComparison {
  const current = subject ? computeWorkItemSubjectFingerprint(subject) : undefined;
  const stored = normalizeWorkItemSubjectFingerprint(storedValue);
  if (!current || !stored) return { status: 'unknown', ...(current ? { current } : {}), ...(stored ? { stored } : {}) };
  return {
    status: stored.sha256 === current.sha256 ? 'current' : 'mismatch',
    current,
    stored,
  };
}

export interface CarryJournalEntry {
  at: number;
  note: string;
  /** Position of the latest authored update in the current, hash-bound note. */
  latestUpdate?: { noteHash: string; offset: number; length: number };
  /** Subject identity captured when this entry was written; absent on legacy entries. */
  subjectFingerprint?: WorkItemSubjectFingerprint;
}

export function readCarryLatestUpdate(note: string, value: unknown):
  { status: 'available' | 'unknown'; text: string | null } | undefined {
  if (value == null) return undefined;
  const span = value as { noteHash?: unknown; offset?: unknown; length?: unknown };
  if (span.noteHash !== shortCarryHash(note) || !Number.isSafeInteger(span.offset)
    || !Number.isSafeInteger(span.length) || (span.offset as number) < 0 || (span.length as number) <= 0
    || (span.offset as number) + (span.length as number) > note.length) {
    return { status: 'unknown', text: null };
  }
  return { status: 'available', text: note.slice(span.offset as number, (span.offset as number) + (span.length as number)) };
}

/** Normalize a `journal` jsonb column read from PG. Depending on the pg client's
 *  type-parser config, a jsonb column comes back either already-parsed (a JS
 *  array) or as the raw JSON text — accept both, and any other shape degrades to
 *  an empty ring rather than spreading a string into characters. */
function normalizeJournal(v: unknown): CarryJournalEntry[] {
  if (!v) return [];
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? (parsed as CarryJournalEntry[]) : [];
    } catch {
      return [];
    }
  }
  return Array.isArray(v) ? (v as CarryJournalEntry[]) : [];
}

/**
 * PURE (L1a): append a note to a carry-journal ring, enforcing all three bounds
 * (entry count, per-note chars, total chars — oldest dropped first). A blank note
 * appends nothing (returns the input unchanged).
 */
export function appendCarryJournal(
  journal: ReadonlyArray<CarryJournalEntry> | undefined,
  note: string,
  at: number,
  subject?: WorkItemSubject | WorkItemSubjectFingerprint,
): CarryJournalEntry[] {
  const trimmed = note.trim();
  const cur = [...(journal ?? [])];
  if (!trimmed) return cur;
  const subjectFingerprint = subject
    ? ('sha256' in subject ? normalizeWorkItemSubjectFingerprint(subject) : computeWorkItemSubjectFingerprint(subject))
    : undefined;
  cur.push({
    at,
    note: trimmed.slice(0, CARRY_JOURNAL_NOTE_MAX_CHARS),
    ...(subjectFingerprint ? { subjectFingerprint } : {}),
  });
  while (cur.length > CARRY_JOURNAL_MAX_ENTRIES) cur.shift();
  let total = cur.reduce((n, e) => n + e.note.length, 0);
  while (total > CARRY_JOURNAL_TOTAL_MAX_CHARS && cur.length > 1) {
    const dropped = cur.shift();
    total -= dropped ? dropped.note.length : 0;
  }
  return cur;
}

// ── The durable store ────────────────────────────────────────────────────────

export interface CarryNoteRef {
  scope: string;
  /** Defaults to the active workspace (the owner install). */
  workspaceId?: string;
}

function resolveRef(ref: CarryNoteRef | string): { ws: string; scope: string } {
  const scope = typeof ref === 'string' ? ref : ref.scope;
  // WI-3648 (same bug class as EI-8824/EI-3409/WI-892): canonicalize through
  // resolveConcreteWorkspaceId, not a bare `?? activeWorkspaceId()`. A bare
  // fallback only fires on null/undefined — it lets a TRUTHY '*' (the
  // unscoped-superuser read-scoping wildcard, e.g. carry-brief.ts's
  // readHeldWorkItems → getWorkItemCheckpoint passing ctx.workspaceId straight
  // through) win outright, so a superuser session's checkpoint READ keyed
  // under the literal workspace_id='*' while EI-8824 already made every WRITE
  // (work_items:checkpoint) resolve to the concrete activeWorkspaceId() — the
  // write/read mismatch silently orphaned the checkpoint (observed live: a
  // 01:47Z write reported ok, but a ~01:49Z post-compaction read returned the
  // stale pre-EI-8824 '*'-keyed row instead). Canonicalizing HERE, in the one
  // shared resolveRef both setCarryNote and getCarryNote funnel through, closes
  // the gap for every current AND future caller — not just the write path.
  const ws = resolveConcreteWorkspaceId(typeof ref === 'string' ? undefined : ref.workspaceId);
  if (!ws) throw new Error('carry-note — no active workspace to scope the carry-note to');
  if (!scope) throw new Error('carry-note — a scope is required');
  return { ws, scope };
}

/**
 * Write (or clear) a carry-note. D-003 semantics: a non-blank string REPLACES
 * `note`; blank/null/undefined CLEARS `note`. Returns the stored note (trimmed)
 * or null when cleared. Read-modify-writes in one transaction.
 *
 * Journaling (default ON — the Queen/loop trajectory ring): a non-blank write
 * APPENDS a capped entry to the `journal` ring so the reasoning trajectory
 * survives a clear (a cleared note keeps its row while the journal is non-empty).
 * Pass `{ journal: false }` for a pure note (the bee checkpoint) — no ring, and a
 * clear DELETES the row (graceful degradation: the next read re-derives from the
 * floor). A scope always uses the same journaling mode.
 */
export async function setCarryNote(
  ref: CarryNoteRef | string,
  note: string | null | undefined,
  opts?: { journal?: boolean; workItem?: WorkItemSubject },
): Promise<string | null> {
  return (await setCarryNoteWithPrior(ref, note, opts)).stored;
}

/** The prior note's length alongside the write result — EI-9325: the row is
 *  already locked + read (for the journal ring) inside {@link setCarryNoteWithPrior}'s
 *  transaction, so surfacing the PRIOR note's length here is free (no extra
 *  round-trip). Lets a caller warn (never block) on a suspicious shrink — a
 *  replace-on-write dramatically shorter than what was there before usually means
 *  an accidental placeholder/truncated paste, not an intentional rewrite. */
export interface SetCarryNoteResult {
  stored: string | null;
  /** chars in the PRIOR note before this write replaced it (0 if none existed). */
  priorLength: number;
  /** EI-18140632570924965: present when a caller-supplied `guard` blocked this
   *  write — the write did NOT happen (no DELETE/INSERT ran); `stored` echoes the
   *  UNCHANGED prior note instead of the would-be new one. */
  blockedReason?: string;
  /** P-007/D-013: the raw `deps` payload this write REPLACED, so a caller can tell
   *  what the previous note declared without a second read. `null` when the prior
   *  note declared nothing. */
  priorDeps?: unknown;
  /**
   * EI-19470389781357111: per-dependency complaints from stamping `dependsOn` —
   * invalid tags, and refs that would not resolve and were therefore DROPPED rather
   * than stamped. Present only when a stamping adapter ran and had something to say.
   *
   * Surfacing these matters more than it looks: a dropped dep is invisible in the
   * stored payload, so a note whose whole declaration failed stores `null` and reads
   * back as `undeclared` — indistinguishable from never having declared anything.
   * This is the only channel that tells the author their refs were wrong.
   */
  depsWarnings?: string[];
  /** Optimistic-CAS details when an expected content hash did not match the
   *  row locked by this write. The row is unchanged. */
  conflict?: {
    expectedHash: string | null;
    currentHash: string | null;
  };
  /**
   * The caller entered the write before a newer writer committed, then waited
   * on that row's lock. The write was discarded so an older in-flight
   * checkpoint cannot overwrite the newer carry-note.
   */
  staleWrite?: {
    writeStartedAtMs: number;
    currentUpdatedAtMs: number;
  };
}

/** Same semantics as {@link setCarryNote}, plus the prior note's length (EI-9325) —
 *  free, since the row is already SELECTed FOR UPDATE to build the journal ring.
 *
 *  EI-18140632570924965: an optional `guard` runs INSIDE the same locked
 *  transaction, given the prior note + its length, and may return a block reason
 *  to abort the write entirely (no DELETE/INSERT) instead of a race-prone
 *  read-then-decide-then-write pattern at the caller. Absent for the overwhelming
 *  common case — every existing caller is unaffected. */
export async function setCarryNoteWithPrior(
  ref: CarryNoteRef | string,
  note: string | null | undefined,
  opts?: {
    journal?: boolean;
    /** Authoritative work-item subject to bind to the newly appended journal entry. */
    workItem?: WorkItemSubject;
    /** Work-item continuation focus; undefined preserves a prior valid focus on metadata-only writes. */
    latestUpdate?: string;
    guard?: (priorNote: string | null, priorLength: number) => string | null;
    /**
     * P-007/D-013 declared-dependency freshness stamps for the note being written.
     * Tri-state on purpose:
     *   `undefined` ⇒ PRESERVE whatever the row already declared (so a plain
     *      re-write or an append does not silently drop a declaration and with it
     *      the note's only non-guessed freshness signal);
     *   `null`      ⇒ CLEAR the declaration (explicitly undeclared);
     *   an object   ⇒ REPLACE it.
     * The caller resolves + stamps the tokens; this layer only persists them.
     */
    deps?: unknown;
    /**
     * EI-19298690705878336: MERGE the incoming note against the prior one before it
     * is journaled and stored — the seam that lets a caller carry `## Checks` /
     * `## Walls` rows forward so a plain replace cannot silently drop a claim's
     * verification probe.
     *
     * Why here rather than in the caller: the caller would have to read the note,
     * merge, then write — a read-then-write with a genuine race against a
     * concurrent writer on the same scope. This row is ALREADY `SELECT ... FOR
     * UPDATE`ed a few lines above, so a merge performed here is atomic with the
     * write and costs no extra round-trip.
     *
     * Runs AFTER `guard`, so a blocked write never transforms. Returning
     * null/blank still means CLEAR, exactly as passing a blank `note` does.
     */
    transform?: (priorNote: string | null, note: string | null | undefined) => string | null | undefined;
    /**
     * Optimistic-CAS baseline for a replace/patch. `undefined` keeps the legacy
     * unconditional write contract; `null` asserts that no note existed. The
     * comparison runs after SELECT FOR UPDATE and before guard/transform, so a
     * stale cold successor cannot overwrite a newer carry-note.
     */
    expectedHash?: string | null;
    /** Internal: use the bounded admin-pool transaction for su loop writes. */
    bounded?: boolean;
  },
): Promise<SetCarryNoteResult> {
  const journalEnabled = opts?.journal ?? true;
  const { ws, scope } = resolveRef(ref);
  const { sql } = getOrgPg();
  // Capture the admission watermark BEFORE waiting for the row lock. A stale
  // caller can be queued behind a newer writer; using the post-lock time here
  // would make that stale transaction look newer and let it overwrite the
  // committed checkpoint (EI-21398038788348858).
  const now = Date.now();
  const depsSpecified = opts !== undefined && 'deps' in opts;
  // Both postgres-js `sql.begin` and boundedOrgTxn supply callable SQL handles,
  // but they expose different structural types (`TransactionSql` vs `Sql`).
  // Accept the union so this one write body can be used by either transaction path.
  const write = async (tx: Sql | TransactionSql): Promise<SetCarryNoteResult> => {
    const rows = await tx<
      {
        journal: unknown;
        note: string | null;
        deps: unknown;
        updated_ts: string | number | null;
      }[]
    >`
      SELECT journal, note, deps, updated_ts FROM harness_shared.carry_notes
       WHERE workspace_id = ${ws} AND scope = ${scope} FOR UPDATE`;
    const prevJournal = normalizeJournal(rows[0]?.journal);
    const priorNote = rows[0]?.note ?? null;
    const priorDeps = rows[0]?.deps ?? null;
    const priorLength = (priorNote ?? '').length;
    if (opts?.expectedHash !== undefined) {
      const currentHash = priorNote === null ? null : shortCarryHash(priorNote);
      const expectedHash = typeof opts.expectedHash === 'string' ? opts.expectedHash.toLowerCase() : opts.expectedHash;
      if (currentHash !== expectedHash) {
        return {
          stored: priorNote,
          priorLength,
          blockedReason: 'expected_hash_mismatch',
          conflict: { expectedHash: expectedHash ?? null, currentHash },
          priorDeps,
        };
      }
    }
    const currentUpdatedAtMs = rows[0]?.updated_ts == null ? NaN : Number(rows[0].updated_ts);
    // Equal millisecond watermarks are possible because updated_ts is epoch-ms
    // precision. Treat equality as stale too: an older writer queued behind a
    // newer commit must not overwrite that checkpoint merely because both
    // admitted in the same millisecond.
    if (Number.isFinite(currentUpdatedAtMs) && currentUpdatedAtMs >= now) {
      return {
        stored: priorNote,
        priorLength,
        blockedReason: 'stale_write_older_than_current',
        priorDeps,
        staleWrite: { writeStartedAtMs: now, currentUpdatedAtMs },
      };
    }
    if (opts?.guard) {
      const blockedReason = opts.guard(priorNote, priorLength);
      if (blockedReason) return { stored: priorNote, priorLength, blockedReason, priorDeps };
    }
    // The merge seam (see `transform`). Deliberately AFTER the guard — a blocked
    // write must not transform — and BEFORE journaling, so the ring records what was
    // actually stored rather than the caller's pre-merge draft.
    const effectiveNote = opts?.transform ? opts.transform(priorNote, note) : note;
    const trimmed = (effectiveNote ?? '').trim();
    // journaling ON: append (blank ⇒ unchanged ring); OFF: never keep a ring.
    const journal = journalEnabled ? appendCarryJournal(prevJournal, trimmed, now, opts?.workItem) : [];
    const noteCol = trimmed.length > 0 ? trimmed : null;
    if (journalEnabled && noteCol !== null && opts && 'latestUpdate' in opts) {
      const latest = opts.latestUpdate === undefined
        ? readCarryLatestUpdate(priorNote ?? '', prevJournal.at(-1)?.latestUpdate)?.text
        : opts.latestUpdate.trim();
      const offset = latest ? noteCol.indexOf(latest) : -1;
      journal[journal.length - 1].latestUpdate = {
        noteHash: shortCarryHash(noteCol), offset, length: offset >= 0 ? latest!.length : 0,
      };
    }
    // Unspecified ⇒ carry the prior declaration forward (see the `deps` opt doc).
    const depsCol = depsSpecified ? (opts?.deps ?? null) : priorDeps;

    if (noteCol === null && journal.length === 0) {
      // Nothing to store (cleared with no surviving journal) — delete the row.
      await tx`DELETE FROM harness_shared.carry_notes WHERE workspace_id = ${ws} AND scope = ${scope}`;
      return { stored: null, priorLength, priorDeps };
    }
    // jsonb bound as ${json}::text::jsonb — sql.json() throws on the org pool
    // (agent-insights/postgres-js-jsonb-binding).
    // P-007/R-06 (migration 1118): a real body write pins `body_ts` to now and RESETS
    // `attested_count`. `updated_ts` keeps meaning "row last touched", so an unchanged
    // attestation (attestCarryNoteUnchanged, below) can bump updated_ts while leaving
    // body_ts alone — and the gap between the two is the attested age that makes the
    // attestation chain boundable. Resetting the count here is what makes the bound a
    // per-body budget rather than a lifetime one: every genuine flush earns a fresh
    // allowance, which is the behaviour that rewards writing over attesting.
    await tx`
      INSERT INTO harness_shared.carry_notes (workspace_id, scope, note, journal, updated_ts, deps,
                                              body_ts, attested_count)
      VALUES (${ws}, ${scope}, ${noteCol}, ${JSON.stringify(journal)}::text::jsonb, ${now},
              ${depsCol === null ? null : JSON.stringify(depsCol)}::text::jsonb,
              ${now}, 0)
      ON CONFLICT (workspace_id, scope) DO UPDATE
        SET note = EXCLUDED.note, journal = EXCLUDED.journal, updated_ts = EXCLUDED.updated_ts,
            deps = EXCLUDED.deps, body_ts = EXCLUDED.body_ts, attested_count = 0`;
    return { stored: noteCol, priorLength, priorDeps };
  };
  // loop:checkpoint is a cold-loop continuity write. It must fail fast under
  // admin-pool/row-lock contention so the MCP transport does not time out while
  // the successor loses its only durable carry anchor. Work-item checkpoints
  // retain their existing transaction policy and use the unbounded branch here.
  const result = opts?.bounded
    // `sql` above is getOrgPg().sql, not an injected backend. Let boundedOrgTxn
    // resolve that same pool itself so its acquire ticket is tagged org-admin.
    // Passing it as `client` hid queue/held measurements on a timeout.
    ? await boundedOrgTxn(write, { acquireTimeoutMs: 8_000 })
    : await sql.begin(write);
  return result as SetCarryNoteResult;
}

// ── Unchanged attestation (fleet-friction-remediation-2026-08-21 P-007 / R-06) ──
//
// The flush gate holds a compaction boundary when a held item's checkpoint is older
// than STALE_CHECKPOINT_WARN_MS. When the in-flight state genuinely has NOT moved, the
// only escape today is rewriting the body — pure prose churn on the one tool an agent
// calls precisely because it is out of context. An attestation is the cheap escape:
// it says "this body is still current", refreshes freshness, and touches no text.
//
// R-06 also requires that an attestation "must not be able to conceal changed state".
// That cannot be established by asking the agent nicely, so it is enforced structurally
// by three independent guards. TWO live here (they are properties of the stored note);
// the THIRD — positive evidence that the SUBJECT moved — is scope-specific and lives in
// the caller (see attestWorkItemCheckpointUnchanged, which compares the work-item row's
// own updated_ts against body_ts).
//
//   G1 CONTENT BINDING. `contentHash` must equal the stored body's hash, so an
//      attestation is always about a body the agent has actually read. An agent that
//      cannot produce the hash has not seen what it is attesting to, and a body some
//      other writer replaced fails the check instead of being silently re-blessed.
//   G3 BOUNDED CHAIN. An attestation extends freshness; it may never do so
//      indefinitely. Both a consecutive-count ceiling and an absolute body-age ceiling
//      apply, and a real write resets the count. This is the decisive property: however
//      the other guards are argued with, a stale body cannot outlive the age ceiling,
//      so an attestation can at worst DEFER a flush, never replace one.

/** Consecutive unchanged attestations allowed before a real body write is required. */
export const CARRY_NOTE_ATTESTATION_MAX_CHAIN = 3;

/** A body older than this can never be attested, whatever the chain count says. The
 *  backstop that makes "cannot conceal changed state" true by construction rather than
 *  by the agent's good faith. */
export const CARRY_NOTE_ATTESTATION_MAX_BODY_AGE_MS = 2 * 60 * 60_000;

export type CarryNoteAttestationRefusal =
  /** Nothing stored — a missing checkpoint is never attestable, only writable. */
  | 'attestation_no_checkpoint'
  /** G1: the supplied hash does not match the stored body. */
  | 'attestation_hash_mismatch'
  /** G3: chain count or absolute body age exhausted; write a real checkpoint. */
  | 'attestation_exhausted';

export interface CarryNoteAttestationResult {
  ok: boolean;
  refusedReason?: CarryNoteAttestationRefusal;
  /** Hash of what is ACTUALLY stored — returned on a mismatch so the caller can see
   *  what it should have attested to, rather than guessing at the divergence. */
  currentHash: string | null;
  /** Attestations against the current body, INCLUDING this one when ok. */
  attestedCount: number;
  /** Age of the stored BODY (not the row) at evaluation time. */
  bodyAgeMs: number | null;
  /** Attestations still available against this body before a real write is required. */
  remainingAttestations: number;
}

/**
 * Refresh a carry-note's freshness WITHOUT touching its text (P-007/R-06).
 *
 * Bumps `updated_ts` and increments `attested_count`; `note`, `journal` and `deps` are
 * left byte-identical, and `body_ts` stays pinned to the last real write. Refuses per
 * the guards documented above rather than degrading — an attestation that cannot be
 * honoured must send the caller to a real write, never quietly pass.
 */
export async function attestCarryNoteUnchanged(
  ref: CarryNoteRef | string,
  opts: {
    contentHash: string;
    nowMs?: number;
    maxChain?: number;
    maxBodyAgeMs?: number;
    sql?: Sql;
    /** Use the bounded admin-pool transaction so lock/statement contention is typed and retryable. */
    bounded?: boolean;
  },
): Promise<CarryNoteAttestationResult> {
  const { ws, scope } = resolveRef(ref);
  const now = opts.nowMs ?? Date.now();
  const maxChain = opts.maxChain ?? CARRY_NOTE_ATTESTATION_MAX_CHAIN;
  const maxBodyAgeMs = opts.maxBodyAgeMs ?? CARRY_NOTE_ATTESTATION_MAX_BODY_AGE_MS;
  const sql = opts.sql ?? getOrgPg().sql;
  const refuse = (
    refusedReason: CarryNoteAttestationRefusal,
    over: Partial<CarryNoteAttestationResult> = {},
  ): CarryNoteAttestationResult => ({
    ok: false,
    refusedReason,
    currentHash: null,
    attestedCount: 0,
    bodyAgeMs: null,
    remainingAttestations: 0,
    ...over,
  });

  const attest = async (tx: Sql | TransactionSql): Promise<CarryNoteAttestationResult> => {
    // FOR UPDATE: the read and the increment must be one atomic step, or two
    // concurrent attestations both observe the same count and the chain ceiling —
    // the guard that makes the bound real — silently admits one extra each time.
    const rows = await tx<
      Array<{ note: string | null; updated_ts: string | number; body_ts: string | number | null; attested_count: number }>
    >`
      SELECT note, updated_ts, body_ts, attested_count
        FROM harness_shared.carry_notes
       WHERE workspace_id = ${ws} AND scope = ${scope}
       FOR UPDATE`;
    const row = rows[0];
    const storedNote = row?.note ?? null;
    if (!row || storedNote === null || storedNote.trim().length === 0) {
      return refuse('attestation_no_checkpoint');
    }
    const currentHash = shortCarryHash(storedNote);
    if (currentHash !== opts.contentHash.trim().toLowerCase()) {
      return refuse('attestation_hash_mismatch', { currentHash });
    }
    // A NULL body_ts is a pre-1118 row the backfill did not reach; its last touch WAS
    // its last body write, so updated_ts is the correct historical answer. Reading it
    // as 0 instead would make every such row look infinitely old and refuse forever.
    const bodyTs = row.body_ts == null ? Number(row.updated_ts) : Number(row.body_ts);
    const bodyAgeMs = Number.isFinite(bodyTs) ? Math.max(0, now - bodyTs) : null;
    const attestedCount = Number(row.attested_count) || 0;
    if (attestedCount >= maxChain || bodyAgeMs === null || bodyAgeMs > maxBodyAgeMs) {
      return refuse('attestation_exhausted', {
        currentHash,
        attestedCount,
        bodyAgeMs,
        remainingAttestations: 0,
      });
    }
    const nextCount = attestedCount + 1;
    // Only the two freshness columns move. Naming them explicitly (rather than a
    // whole-row upsert) is what guarantees the body cannot be rewritten by this path.
    await tx`
      UPDATE harness_shared.carry_notes
         SET updated_ts = ${now}, attested_count = ${nextCount}
       WHERE workspace_id = ${ws} AND scope = ${scope}`;
    return {
      ok: true,
      currentHash,
      attestedCount: nextCount,
      bodyAgeMs,
      remainingAttestations: Math.max(0, maxChain - nextCount),
    };
  };
  // Work-item attestations run at an interactive compaction boundary: a row lock
  // must become a typed retryable result before the MCP transport gives up. Keep
  // the historical unbounded default for the shared substrate's existing callers;
  // callers that need the interactive guarantee opt in explicitly.
  const result = opts.bounded
    ? await boundedOrgTxn(attest, { ...(opts.sql ? { client: opts.sql } : {}), acquireTimeoutMs: 8_000 })
    : await sql.begin(attest);
  return result as CarryNoteAttestationResult;
}

/** Read the current carry-note (the full `note` column), or null when none/cleared. */
export async function getCarryNote(ref: CarryNoteRef | string): Promise<string | null> {
  let ws: string, scope: string;
  try {
    ({ ws, scope } = resolveRef(ref));
  } catch {
    return null;
  }
  const rows = await boundedPgReadTxn<{ note: string | null }[]>(
    (tx) => tx`
    SELECT note FROM harness_shared.carry_notes
     WHERE workspace_id = ${ws} AND scope = ${scope} LIMIT 1`,
  );
  const note = (rows[0]?.note ?? '').trim();
  return note.length > 0 ? note : null;
}

/** Read the carry-journal ring, NEWEST FIRST (the Queen brief renderer's input,
 *  generalized). Empty array when none. */
export async function getCarryJournal(ref: CarryNoteRef | string): Promise<CarryJournalEntry[]> {
  let ws: string, scope: string;
  try {
    ({ ws, scope } = resolveRef(ref));
  } catch {
    return [];
  }
  const rows = await boundedPgReadTxn<{ journal: unknown }[]>(
    (tx) => tx`
    SELECT journal FROM harness_shared.carry_notes
     WHERE workspace_id = ${ws} AND scope = ${scope} LIMIT 1`,
  );
  return [...normalizeJournal(rows[0]?.journal)].reverse();
}

// ── su-loop carry-note (P-002) — the SU AUTO loop's cold-wake anchor ──────────
//
// The su loop's slice of the substrate. Keyed by the owner id the loop wakes
// (loopScope), which is STABLE across a fresh-context RESET and a RECYCLE
// (PAPERCUSP_SID preserved — P-004), so a cold wake reads the SAME carry-note the
// warm session left. Journaling ON (like the Queen): the loop's recent trajectory
// (did/left/insight/next across wakes) survives, which a cold successor reads.
//
// The Phase-2 psu-host RESET-CONTEXT (P-004) captures the compaction summary the
// agent ALREADY writes at a clean turn-boundary into this note (no new agent
// behavior, P-002) and re-injects it as the cold session's opening context.

export interface LoopCarryNoteRef {
  harness: string;
  /** The coord ownerId the loop wakes (loop:arm target_owner_id). */
  ownerId: string;
  /** IGNORED for the loop scope since 2026-07-03 (kept for call-site compat): the
   *  loop carry-note is PINNED to the coord workspace — see loopCarryWs(). */
  workspaceId?: string;
}

/**
 * The ONE workspace the loop carry-note lives in — pinned to the coord workspace,
 * because the loop's whole lifecycle (arm → routine fire → wake delivery → cold
 * decision) rides the coord/events subsystem, which is itself pinned to
 * DEFAULT_COORD_WORKSPACE (events/await/store.ts `eventsWs`). Before this pin the
 * PRODUCER (loop:checkpoint, keyed by the MCP caller's ctx.workspaceId, e.g.
 * 'papercusp-workspace') and the CONSUMER (the wake executor, keyed by the
 * delivery row's ws = 'default') addressed DIFFERENT rows for the same scope —
 * the anchor was never found and every cold wake fail-safed to WARM (the
 * 2026-07-03 live-test bug, round 2). The scope string (loop:<harness>:<ownerId>)
 * is globally unique (ownerId is a session uuid), so a single pinned namespace
 * cannot collide across workspaces.
 */
function loopCarryWs(): string {
  return DEFAULT_COORD_WORKSPACE;
}

/** Write (or clear) an su AUTO loop's carry-note. Delegates to the shared
 *  substrate under {@link loopScope}, PINNED to the coord workspace (see
 *  {@link loopCarryWs}) so the producer and the wake-executor consumer address
 *  the same row no matter which host/ctx they run under. */
export async function setLoopCarryNote(ref: LoopCarryNoteRef, note: string | null | undefined): Promise<string | null> {
  const stored = await setCarryNote({ scope: loopScope(ref.harness, ref.ownerId), workspaceId: loopCarryWs() }, note);
  // The carry row is already durable. Orders-panel invalidation is a best-effort
  // derived-read push and must not extend the write's response deadline when the
  // sync bus or its PG notify path is degraded (EI-21390376601596579).
  void notifyAgentOrdersChanged(ref.ownerId).catch(() => {});
  return stored;
}

/** {@link setLoopCarryNote} with access to the PRIOR note — the write path a caller
 *  needs when its note must be MERGED against what is already stored (the P-006
 *  walls / P-001 checks rows) rather than plainly replacing it.
 *
 *  WI-6813: pass `transform` (with {@link mergeCarryRows}) and the merge runs inside
 *  the row's `SELECT ... FOR UPDATE` transaction — atomic with the write, one fewer
 *  round-trip, and it CANNOT clobber a concurrent writer on the same scope the way a
 *  caller-side read → merge → write can. Pinned to the same coord workspace as
 *  {@link setLoopCarryNote} so producer and wake-executor address the same row. */
export async function setLoopCarryNoteWithPrior(
  ref: LoopCarryNoteRef,
  note: string | null | undefined,
  opts?: Parameters<typeof setCarryNoteWithPrior>[2] & {
    /**
     * EI-19470389781357111: P-007/D-013 declared dependencies as `kind:ref` tags.
     * Tri-state, matching the substrate: `undefined` ⇒ preserve the existing
     * declaration, `[]`/`null` ⇒ clear it, a non-empty list ⇒ resolve each to a
     * version token and stamp it. This adapter does the stamping (the same shared
     * {@link stampDeclaredDeps} contract the work-item checkpoint uses) and hands
     * the substrate the resolved `deps` payload it persists verbatim.
     */
    dependsOn?: readonly string[] | null;
    /**
     * The workspace to RESOLVE `work-item:`/`plan:` refs against — the caller's real
     * workspace, NOT the pinned {@link loopCarryWs} the row lives in. See
     * {@link getLoopCarryNoteFreshness} for why conflating the two silently reduces
     * the loop note to `file:`-only dependencies.
     */
    depsResolveWorkspaceId?: string | null;
  },
): Promise<SetCarryNoteResult> {
  const { dependsOn, depsResolveWorkspaceId, ...substrateOpts } = opts ?? {};
  const depsSpecified = opts !== undefined && 'dependsOn' in opts;
  let stampWarnings: string[] | undefined;
  let depsOpt: { deps?: unknown } = {};
  if (depsSpecified) {
    // `concreteWorkspaceIdOrNull`, NOT `resolveConcreteWorkspaceId`: the latter falls
    // back to the process-global `activeWorkspaceId()`, so it NEVER returns null and
    // the refusal below would be unreachable — the exact dead-guard this shipped with.
    const ws = concreteWorkspaceIdOrNull(depsResolveWorkspaceId);
    // Without a concrete resolution workspace, `work-item:`/`plan:` refs would resolve
    // under a GUESSED namespace — silently answering about another tenant's rows, or
    // dropping every such dep so a partial `file:`-only set reads as a complete
    // declaration. Refuse to stamp instead: `undeclared` routes the reader to the age
    // heuristics honestly.
    const stamped = ws
      ? await stampDeclaredDeps({
          declared: dependsOn ?? [],
          priorDeps: () => getLoopCarryNoteDeps(ref),
          workspaceId: ws,
          harness: ref.harness,
        })
      : {
          payload: null,
          recomputed: false,
          warnings:
            (dependsOn ?? []).length > 0
              ? ['dependsOn could not be stamped — no concrete workspace was resolvable for this session']
              : [],
        };
    depsOpt = { deps: stamped.payload };
    if (stamped.warnings.length > 0) stampWarnings = stamped.warnings;
  }
  const result = await setCarryNoteWithPrior(
    { scope: loopScope(ref.harness, ref.ownerId), workspaceId: loopCarryWs() },
    note,
    { ...substrateOpts, ...depsOpt, bounded: true },
  );
  if (stampWarnings) result.depsWarnings = stampWarnings;
  // WI-6974: the loop carry-note (note + walls + checks) is Orders-panel content,
  // and this ref carries the ownerId the panel is keyed by — so the push is exact.
  // A `guard`-BLOCKED write wrote nothing, so it must not push: `blockedReason` is
  // the producer-side signal a carry_notes row trigger could not have seen.
  // The durable write has committed before this point. Keep the derived Orders
  // invalidation detached so a stalled sync bus cannot turn a successful carry
  // write into an MCP request timeout (EI-21390376601596579).
  if (!result.blockedReason) void notifyAgentOrdersChanged(ref.ownerId).catch(() => {});
  return result;
}

/** Read an su AUTO loop's current carry-note (the full note), or null when none.
 *  Resolves the NEWEST row for the scope across ALL workspaces. The pinned coord
 *  workspace is only a tie-breaker, not a precedence rule: a stale pinned row
 *  must not mask a newer row written by a not-yet-redeployed host still using the
 *  old ctx-workspace keying (host-version skew is real: the :3070 release,
 *  bg-host, and psu sessions restart at different times). */
export async function getLoopCarryNote(ref: LoopCarryNoteRef): Promise<string | null> {
  const scope = loopScope(ref.harness, ref.ownerId);
  try {
    const rows = await boundedPgReadTxn<{ note: string | null }[]>(
      (tx) => tx`
      SELECT note FROM harness_shared.carry_notes
       WHERE scope = ${scope} AND note IS NOT NULL
       ORDER BY updated_ts DESC, (workspace_id = ${loopCarryWs()}) DESC LIMIT 1`,
    );
    const note = (rows[0]?.note ?? '').trim();
    return note.length > 0 ? note : null;
  } catch {
    return null;
  }
}

/** A loop carry-note plus its write instant — the staleness input the wake
 *  renderer needs (compaction-continuity-hardening-2026-07-07 P-002): a note is
 *  only trustworthy relative to WHEN it was written, so the fire path reads both
 *  in one query instead of the note alone. */
export interface LoopCarryNoteWithMeta {
  note: string | null;
  /** Epoch ms of the note's last write (carry_notes.updated_ts), null when no note. */
  updatedAtMs: number | null;
  /**
   * True when the carry-note store could not be read. Optional for compatibility
   * with older injected readers; the canonical reader always sets it so a
   * failed read cannot be mistaken for a confirmed-empty note.
   */
  readFailed?: boolean;
}

/** Read an su AUTO loop's carry-note WITH its write instant. The newest row for
 *  the scope wins across all workspaces; the pinned coord workspace only breaks
 *  equal-timestamp ties. Keeping this ordering newest-first is critical when a
 *  stale pinned row and a newer host-skew fallback row coexist. */
export async function getLoopCarryNoteWithMeta(ref: LoopCarryNoteRef): Promise<LoopCarryNoteWithMeta> {
  const scope = loopScope(ref.harness, ref.ownerId);
  try {
    const rows = await boundedPgReadTxn<{ note: string | null; updated_ts: string | number | null }[]>(
      (tx) => tx`
      SELECT note, updated_ts FROM harness_shared.carry_notes
       WHERE scope = ${scope} AND note IS NOT NULL
       ORDER BY updated_ts DESC, (workspace_id = ${loopCarryWs()}) DESC LIMIT 1`,
    );
    const note = (rows[0]?.note ?? '').trim();
    if (note.length === 0) return { note: null, updatedAtMs: null, readFailed: false };
    const ts = rows[0]?.updated_ts == null ? NaN : Number(rows[0].updated_ts);
    return { note, updatedAtMs: Number.isFinite(ts) ? ts : null, readFailed: false };
  } catch {
    // Keep an unavailable store distinct from a successful read that found no
    // note. Consumers use this to avoid asserting that a checkpoint is absent
    // (or prompting an overwrite) when the row may simply be unreadable.
    return { note: null, updatedAtMs: null, readFailed: true };
  }
}

/**
 * EI-19470389781357111: the loop carry-note's DECLARED dependencies, or null when
 * it declared none.
 *
 * Mirrors {@link getWorkItemCheckpointDeps} in contract, but NOT in its row lookup,
 * and the difference is load-bearing: the loop note resolves the NEWEST row for the
 * scope across ALL workspaces with the pinned coord workspace as a tie-break only
 * (host-version skew is real — see {@link getLoopCarryNote}). Reading deps from the
 * pinned row alone could return the stamps of a row that is NOT the note the reader
 * was just handed, i.e. a freshness verdict about a different note.
 *
 * A BLANK note is treated as undeclared even when the row survives: with the journal
 * ring on, clearing a note keeps its row, and the surviving row still carries the
 * cleared note's `deps`. Reporting those would hand a verdict for a note that no
 * longer exists — strictly worse than falling back to the time heuristics.
 */
export async function getLoopCarryNoteDeps(ref: LoopCarryNoteRef): Promise<DeclaredDeps | null> {
  const scope = loopScope(ref.harness, ref.ownerId);
  try {
    const rows = await boundedPgReadTxn<{ deps: unknown; note: string | null }[]>(
      (tx) => tx`
      SELECT deps, note FROM harness_shared.carry_notes
       WHERE scope = ${scope} AND note IS NOT NULL
       ORDER BY updated_ts DESC, (workspace_id = ${loopCarryWs()}) DESC LIMIT 1`,
    );
    if (!(rows[0]?.note ?? '').trim()) return null;
    return parseDeclaredDeps(rows[0]?.deps);
  } catch {
    return null;
  }
}

/**
 * The READ side of the loop note's freshness axis: resolve its declared
 * dependencies against the world NOW and return the verdict. `undefined` ⇒ nothing
 * was declared, and the caller falls back to the age heuristics (D-013's precedence
 * rule: a declared verdict OVERRIDES them; they remain the fallback).
 *
 * ⚠ `resolveWorkspaceId` is the CALLER's real workspace and is NOT
 * {@link loopCarryWs}. The loop ROW is pinned to the coord workspace, but
 * `work-item:` and `plan:` refs resolve under a strict `workspace_id` filter, so
 * resolving them against the pinned 'default' namespace would find nothing and drop
 * every such dep as unresolvable — leaving a loop note able to declare only `file:`
 * deps, silently. Row workspace and resolution workspace are different questions
 * here; only the work-item surface gets to conflate them.
 */
export async function getLoopCarryNoteFreshness(
  ref: LoopCarryNoteRef,
  resolveWorkspaceId: string | null | undefined,
): Promise<FreshnessResult | undefined> {
  const deps = await getLoopCarryNoteDeps(ref);
  if (!deps) return undefined;
  // `concreteWorkspaceIdOrNull`, NOT `resolveConcreteWorkspaceId` — see the write side.
  // The resolver's ambient fallback would make this guard unreachable and answer the
  // freshness question under whatever workspace the sidecar happens to be pinned to.
  const ws = concreteWorkspaceIdOrNull(resolveWorkspaceId);
  if (!ws) return undefined;
  const tokens = await resolveCurrentTokens(
    deps.stamps.map((s) => s.dep),
    { workspaceId: ws, harness: ref.harness },
  );
  return computeFreshness({ deps, currentTokens: tokens });
}

/** Every harness under which this owner ALREADY holds a non-empty loop carry-note,
 *  newest-written first.
 *
 *  EI-21510951589801937: `loop:checkpoint` resolves its scope from the armed routine
 *  → explicit arg → session brief → session context → home hive. After a `loop:end`
 *  the routine is deliberately NOT a fallback (an ended loop's install_slug can
 *  strand a note in the wrong store), so a superuser session carrying only the '*'
 *  wildcard sentinel and no home hive has nothing left to resolve — and a plain
 *  carry-note refresh fails `no_harness` even though that owner's note is sitting in
 *  exactly one place. Where an owner's notes ALREADY live is the one piece of scope
 *  evidence that survives the loop ending, so it is the right last-resort signal.
 *
 *  Returns EVERY candidate instead of picking one, because picking is only safe when
 *  there is exactly one: measured on this box, 155 of 2,930 note-holding owners have
 *  notes under up to 4 harnesses, and silently taking the newest would resume a cold
 *  wake from another hive's note — the exact stranding the "inactive routine is not a
 *  fallback" rule above exists to prevent. The caller decides; ambiguity is reported,
 *  never guessed.
 *
 *  Reads across ALL workspaces, matching {@link getLoopCarryNote}: a note written by
 *  a host on the other side of a redeploy is still this owner's note. */
export async function listLoopCarryNoteHarnesses(ownerId: string): Promise<string[]> {
  return (await listLoopCarryNoteScopes(ownerId)).map((row) => row.harness);
}

/** One owner's loop carry-note scopes WITH each one's write instant, newest first.
 *
 *  The timestamp half is what {@link listLoopCarryNoteHarnesses} throws away, and it
 *  is the only thing that can answer the question that matters on a READ: is the scope
 *  we just resolved the owner's NEWEST note, or is a fresher one sitting in a hive
 *  nobody is going to look in? WI-1826126 measured that gap costing 2h38m of skipped
 *  continuity on a cold wake — the wake resolved a real scope, read it successfully,
 *  and never learned that a note written 2h38m later existed one scope over.
 *
 *  Deliberately NOT a picker. Same reasoning as the harness list it backs: silently
 *  preferring the newest row would resume a cold wake from another hive's note, which
 *  is the stranding the "an inactive routine is not a fallback" rule exists to prevent.
 *  This reports; the caller decides.
 *
 *  The `max(updated_ts)` is already computed by the ordering the previous query used,
 *  so surfacing it costs nothing extra — no second query, no extra round-trip. */
export async function listLoopCarryNoteScopes(
  ownerId: string,
): Promise<{ harness: string; updatedAtMs: number | null }[]> {
  const owner = ownerId.trim();
  if (!owner) return [];
  const prefix = 'loop:';
  const suffix = `:${owner}`;
  // An ownerId is an opaque identifier, so escape LIKE's metacharacters (default
  // escape char is backslash) — a '%' or '_' in one must never widen the match to a
  // DIFFERENT owner's scopes. The JS filter below is the authority regardless.
  const pattern = `${prefix}%${suffix.replace(/([\\%_])/g, '\\$1')}`;
  try {
    const rows = await boundedPgReadTxn<{ scope: string | null; updated_ts: string | number | null }[]>(
      (tx) => tx`
      SELECT scope, max(updated_ts) AS updated_ts FROM harness_shared.carry_notes
       WHERE scope LIKE ${pattern}
         AND note IS NOT NULL AND btrim(note) <> ''
       GROUP BY scope
       ORDER BY max(updated_ts) DESC`,
    );
    const seen = new Set<string>();
    const out: { harness: string; updatedAtMs: number | null }[] = [];
    for (const row of rows) {
      const scope = row.scope ?? '';
      if (!scope.startsWith(prefix) || !scope.endsWith(suffix)) continue;
      const harness = scope.slice(prefix.length, scope.length - suffix.length);
      // loopScope() joins on ':', so a slug containing one cannot round-trip — such a
      // scope is malformed or foreign, not a hive a note can be re-addressed to.
      if (!harness || harness.includes(':') || seen.has(harness)) continue;
      seen.add(harness);
      const ts = row.updated_ts == null ? NaN : Number(row.updated_ts);
      out.push({ harness, updatedAtMs: Number.isFinite(ts) ? ts : null });
    }
    return out;
  } catch {
    return [];
  }
}

/** Read an su AUTO loop's carry-JOURNAL (newest first) — its recent trajectory.
 *  Resolves the newest row across all workspaces; the pinned coord workspace is
 *  only a tie-breaker, matching {@link getLoopCarryNote}. */
export async function getLoopCarryJournal(ref: LoopCarryNoteRef): Promise<CarryJournalEntry[]> {
  const scope = loopScope(ref.harness, ref.ownerId);
  try {
    const rows = await boundedPgReadTxn<{ journal: unknown }[]>(
      (tx) => tx`
      SELECT journal FROM harness_shared.carry_notes
       WHERE scope = ${scope}
       ORDER BY updated_ts DESC, (workspace_id = ${loopCarryWs()}) DESC LIMIT 1`,
    );
    return [...normalizeJournal(rows[0]?.journal)].reverse();
  } catch {
    return [];
  }
}
