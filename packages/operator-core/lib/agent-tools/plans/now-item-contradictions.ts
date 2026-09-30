import type { ParsedPlan } from './parser';

export interface NowItemContradiction {
  id: string;
  status: 'done' | 'dropped';
  mention: string;
}

/**
 * An exhaustive Now/Next claim named a closed list of remaining items but
 * omitted one or more non-terminal structured items.  This is the inverse of
 * `NowItemContradiction`: the mentioned item may itself be open, but the word
 * "only" (or an equivalent suffix) makes the list read as complete.
 */
export interface NowItemOmission {
  omitted: string[];
  listed: string[];
  mention: string;
}

type TerminalStatus = NowItemContradiction['status'];

const PLAN_ITEM_REF_RE = /\bP-\d{3,}\b/g;
// A range names a span of plan items, not an individual item's status. Keep
// the terminal-item guard from treating each endpoint in a compact range
// (e.g. `P-092–P-100`) as a current-work claim.
const PLAN_ITEM_RANGE_RE =
  /\bP-\d{3,}\s*(?:[-–—]|\.{2,}|\b(?:to|through|thru)\b)\s*P-\d{3,}\b/gi;
// EI-21900747713795768: a plan slug immediately preceding a P-NNN mention
// scopes that id to a DIFFERENTLY-NAMED plan explicitly — e.g. "Audited
// under pui-tui-ship-drive-2026-08-30 P-001" is a citation of THAT plan's
// P-001, never this one's, however this plan's own item numbering happens
// to line up (nearly always, since every plan starts at P-001). Every plan
// slug in this system carries a trailing -YYYY-MM-DD suffix (plans:new
// auto-appends the creation date), which makes this a reliable,
// low-false-positive signal — ordinary prose essentially never produces a
// multi-segment kebab-case token ending in a full date immediately before
// a plan-item id.
const PLAN_SLUG_PREFIX_RE = /\b([a-z][a-z0-9]*(?:-[a-z0-9]+)*-\d{4}-\d{2}-\d{2})\s+$/i;
// EI-21920559821120577 (partial): the exemption vocabulary was missing three
// past-tense completion verbs this codebase uses constantly — `landed` above
// all (CLAUDE.md itself says "the fixes land ON TOP of it", "a fix already
// landed"). "P-001 landed; pick up P-002" is the single most common shape a
// Now block takes, and it was being reported as a contradiction, which on the
// WRITE path is a hard refusal of a correct sentence.
//
// Deliberately PAST-TENSE ONLY. `land`/`merge`/`resolve` are excluded: an
// imperative "land P-001" is exactly the direction-at-finished-work this guard
// exists to catch, so adding the bare stems would defeat it. That asymmetry is
// pinned by paired tests in __tests__/now-item-contradictions.test.ts.
//
// This is the narrow half of EI-21920559821120577. The filer's wider proposal
// — flag only PENDING-marked mentions, or downgrade the write refusal to an
// advisory — remains open, and is a design call with a live counter-argument
// (EI-21363981314860302 records the same guard catching a genuinely stale
// claim). Widening the exemption set can only reduce false refusals, so it is
// safe to take separately; the redesign is not.
const NOW_CLOSED_RE =
  /\b(?:done|complete(?:d)?|closed|shipped|dropped|finished|terminal|accepted|landed|merged|resolved)\b|\bno\s+longer\s+(?:active|open|pending|in\s+progress)\b/i;
// A terminal item may also be reported through quantitative test evidence,
// e.g. "P-013 passed 113/113 focused tests plus 9/9 migrated-Postgres tests".
// Keep this narrower than the bare past-tense verb: "P-013 passed to the
// worker" is historical routing, not completion, while an imperative
// "pass P-013" must remain a contradiction.
const NOW_PASSED_TEST_EVIDENCE_RE =
  /\bpassed\s+(?:(?:\d+\s*\/\s*\d+|\d+)\s+)?(?:[\w-]+\s+){0,4}(?:tests?|checks?|cases?|verifications?|validations?)\b|\b(?:tests?|checks?|cases?|verifications?|validations?)\b[^.!?;:\n]{0,80}\bpassed\b/i;
// A terminal item's status can be followed by an explanation that contains
// future/negative vocabulary: `P-001 is DROPPED and will never report` is an
// affirmative status assertion, not a direction to revisit P-001. Keep this
// anchored immediately after the id so `P-001 is done; revisit P-001` still
// reaches the later action-oriented occurrence.
const NOW_TERMINAL_STATUS_ASSERTION_RE =
  /^\s*(?:is|was|were|has\s+been|have\s+been|remains?)\s+(?:already\s+)?(?:done|complete(?:d)?|closed|shipped|dropped|finished|terminal|accepted|landed|merged|resolved)\b/i;
// A completion assertion can be followed by a neutral, possessive citation of
// the item's evidence or metadata, e.g. "P-005 IS DONE; of P-005's 5 specs
// only M-004 is item-specific". The occurrence-based guard below must not
// mistake that citation for a second live-work claim.
const NOW_EXPLICIT_TERMINAL_STATUS_RE =
  /\b(P-\d{3,})\s+(?:is|was|were|has\s+been|have\s+been|remains?)\s+(?:already\s+)?(?:done|complete(?:d)?|closed|shipped|dropped|finished|terminal|accepted|landed|merged|resolved)\b/gi;
// Completed items are often cited through a measured/reporting result rather
// than a status verb. This deliberately accepts only a narrow, past-tense
// reporting vocabulary; future/imperative forms such as `will measure` and
// `measure P-005` remain contradictions.
const NOW_PAST_TENSE_REPORT_RE =
  /^\s*(?:(?:was|were)\s+)?(?:measured|observed|recorded|reported|found|calculated|quantified|audited|validated|verified|documented|identified|confirmed|showed|demonstrated|tested|extracted|implemented|addressed|repaired|corrected)\b/i;
const NOW_NEGATED_OR_FUTURE_RE =
  /\b(?:not|never|still|yet|will|would|should|must|need(?:s)?(?:\s+to)?|to)\b/i;
// EI-21987261152536728: P-002's completion can be narrated as a resulting
// derived state rather than with a terminal-status verb, e.g. "P-002 made the
// `## Now` next-pointer DERIVED at read time". Keep this separate from the
// broad closure vocabulary so ordinary "made ... stale/failed" prose remains
// guarded, and require the same affirmative, non-future window checks below.
const NOW_DERIVATION_COMPLETION_RE =
  /\bmade\s+(?:the\s+)?[^.!?;:\n]{0,120}\bderived\b/i;
// EI-22023442425397379: a terminal item can appear in the plan's historical
// launch/promotion explanation, e.g. "the plan lacked promoted P-002 execution
// metadata". This describes why an exact-plan launch path was unused; it does
// not direct current or future work at P-002. Keep the grammar past-tense and
// metadata-specific so present/future/action wording remains guarded.
const NOW_PROMOTION_PROVENANCE_REFERENCE_RE =
  /\b(?:the|this|that)\s+plan\s+lacked\s+(?:promoted\s+)?P-\d{3,}\s+(?:execution|launch|promotion)\s+(?:metadata|record|provenance)\b/i;
// Staging is the implementation/acceptance plane; a terminal item can be
// truthfully complete there before its commit reaches main/deployed. Keep the
// exemption tied to affirmative completion grammar and explicit release-plane
// absence so an item that is itself negated, future, or action-oriented still
// trips the contradiction guard.
const NOW_STAGING_COMPLETION_RE =
  /\b(?:is|was|has\s+been|have\s+been)\s+(?:already\s+)?(?:fully\s+)?(?:done|complete(?:d)?|closed|shipped|finished|terminal|accepted|landed|merged|resolved)\s+(?:on|in)\s+staging\b/i;
const NOW_RELEASE_PLANE_ABSENCE_RE =
  /\b(?:but|and|while|although)?\s*(?:not|absent|missing|unavailable)\b[^.!?;:\n]{0,100}\b(?:main|deployed|production|release)\b/i;
const NOW_HISTORICAL_RE =
  /\b(?:histor(?:y|ical)|prior|previous(?:ly)?|earlier|former(?:ly)?|legacy|archived?|record(?:ed)?)\b/i;
// A Now sentence may describe the old state of several terminal items in one
// semicolon-delimited clause and resolve that group in the next clause, e.g.
// "P-003 and P-005 were ... with ZERO coverage; both are now extracted and
// tested." The regular clause-local closure checks above intentionally cannot
// see across that semicolon. Keep this detector narrow: it requires historical
// or incomplete-state wording, a collective subject in the following clause,
// and an affirmative present completion phrase. Future/negated forms are
// excluded so "both will now be fixed" and "both are not now fixed" remain
// contradictions.
const NOW_RETROSPECTIVE_STATE_RE =
  /\b(?:was|were|had|previous(?:ly)?|earlier|former(?:ly)?|zero|no|stale|untested|uncovered|inlined?|missing|lacked|without)\b/i;
const NOW_AFFIRMATIVE_RESOLUTION_RE =
  /\b(?:now|already)\s+(?:(?:is|are)\s+)?(?!being\b)(?:fully\s+)?(?:fixed|covered|tested|extracted|implemented|addressed|resolved|corrected|repaired|closed|complete(?:d)?|shipped|merged|landed|validated|verified)\b|\b(?:is|are|has\s+been|have\s+been)\s+(?:now\s+|already\s+)?(?!being\b)(?:fully\s+)?(?:fixed|covered|tested|extracted|implemented|addressed|resolved|corrected|repaired|closed|complete(?:d)?|shipped|merged|landed|validated|verified)\b/i;
// A slash-separated P-NNN group can be a technical field prefix rather than
// a list of plan items, e.g. "P-003/P-004 blobShas went stale". Treat this as
// neutral artifact history only when every item in the group is terminal and
// the field is described with an unambiguously past/status construction. A
// direct instruction such as "refresh P-003/P-004 blobShas" does not match.
const NOW_METADATA_REFERENCE_RE =
  /(?:\bP-\d{3,}\s*\/\s*)+\bP-\d{3,}\b\s+(?:blob\s*shas?|commit\s*shas?|sha(?:s)?|hash(?:es)?|citation(?:s)?|reference(?:s)?|links?)\b/i;
const NOW_METADATA_STATUS_RE =
  /\b(?:went|became|turned|grew|was|were|is|are|remained?|became)\s+(?:now\s+)?(?:stale|outdated|invalid|incorrect|wrong|missing|unavailable)\b/i;
const NOW_ACTION_RE =
  /\b(?:address|audit|claim|close|complete|continue|finish|fix|handle|implement|investigate|pick(?:\s+up)?|reopen|repair|revisit|review|resume|retry|run|start|validate|verify|work)\b/i;
const NOW_ACTIVE_RE = /\b(?:active|assigned|in\s+progress|ongoing|open|pending|underway)\b/i;
const NOW_TERMINAL_REFERENCE_LIVE_RE =
  /\b(?:remaining|unfinished|incomplete|outstanding|left|work|task|action|next|todo|blocked)\b/i;
const NOW_NEUTRAL_POSSESSIVE_REFERENCE_RE = /^\s*['’]s\b/i;
// A terminal item can be named in an explicit negative guard, e.g. `do not
// reopen completed Phone or P-002`. That mention describes what must NOT be
// resumed, rather than presenting P-002 as current/future work. Keep the
// exemption occurrence- and clause-local; a later action in the same clause
// must still make the terminal mention contradictory.
const NOW_NEGATIVE_REOPEN_GUARD_RE = /\b(?:do|does|did)\s+not\s+reopen\b/i;
const NOW_CROSS_LEDGER_REF_BEFORE_RE = /\bWI-\d+\s*\/\s*$/i;
const NOW_CROSS_LEDGER_REF_AFTER_RE = /^\s*\/\s*WI-\d+\b/i;
// EI-22299775069357894: a decision can cite a terminal plan item as neutral
// historical/definitional evidence, e.g. "D-022 records P-012's
// stack-mutation primitive". Keep this narrowly tied to a decision id followed
// by the present-tense records verb; action, future, negated, or active-status
// wording around the reference must still be reported.
const NOW_DECISION_REFERENCE_RE = /\bD-\d{3,}\s+records?\s+$/i;
// EI-21901034855868849: a terminal item can be named while its remaining
// evidence is deliberately handed to another work-item, e.g. "P-014's
// measurement residue is owned by WI-1311290, not dropped" or "P-014's
// measurement residue carries forward under WI-1311290". These are neutral
// references to carried residue, not directions to resume the terminal item.
// Keep the exemption tied to an explicit WI handoff; generic "residue remains"
// prose must still be checked as a possible current-work contradiction.
const NOW_RESIDUE_REFERENCE_RE =
  /\bresidue\b[^.!?;:\n]{0,100}\b(?:owned\s+by\s+WI-\d+|carries\s+forward\s+under\s+WI-\d+|is\s+carried\s+forward\s+under\s+WI-\d+)\b/i;

// Exhaustive-list wording is intentionally narrow. These are the shapes that
// have caused real successor drops: "only P-002 remains", "P-002 only"
// (usually followed by a qualifier such as "and it is blocked"), and
// "remaining work is P-002 retirement and P-003 acceptance". The first two
// forms keep a strict comma/and-separated list grammar; the remaining-work
// form captures the rest of its sentence and extracts every plan-item
// reference so ordinary descriptors after each id do not make a later item
// look omitted. The sentence boundary keeps unrelated later prose from
// satisfying the claim.
const NOW_ITEM_LIST = String.raw`(?:P-\d{3,}(?:\s*(?:,|\/|and|&)\s*)?)+`;
const NOW_ONLY_PREFIX_RE = new RegExp(
  String.raw`\bonly\s+(${NOW_ITEM_LIST})\s+(?:remain(?:s|ing)?|left|outstanding|actionable|todo)\b`,
  'gi',
);
// Anchor the terse "P-002 only" shape to the sentence start. Without the
// anchor, neutral scope prose such as "the tests cover P-002 only" would be
// misread as a claim that P-002 is the plan's sole remaining item.
const NOW_ONLY_SUFFIX_RE = new RegExp(String.raw`^\s*(${NOW_ITEM_LIST})\s+only\b`, 'gi');
const NOW_REMAINING_CLAUSE_RE = new RegExp(
  String.raw`\b(?:remaining|outstanding|unfinished|incomplete|open)\s+(?:items?|lanes?|work)\s*(?:are|is|:)\s*([^.!?\n]+)`,
  'gi',
);

function idsFromList(text: string): string[] {
  return [...text.matchAll(/\bP-\d{3,}\b/g)].map((match) => match[0]);
}

function hasAffirmativeResolution(text: string): boolean {
  for (const match of text.matchAll(new RegExp(NOW_AFFIRMATIVE_RESOLUTION_RE.source, 'gi'))) {
    const prefix = text.slice(0, match.index ?? 0).slice(-120);
    if (!NOW_NEGATED_OR_FUTURE_RE.test(prefix)) return true;
  }
  return false;
}

function isStagingOnlyCompletion(text: string): boolean {
  return NOW_STAGING_COMPLETION_RE.test(text) && NOW_RELEASE_PLANE_ABSENCE_RE.test(text);
}

function hasNegativeReopenGuard(before: string, after: string): boolean {
  for (const match of before.matchAll(new RegExp(NOW_NEGATIVE_REOPEN_GUARD_RE.source, 'gi'))) {
    const guardTail = before.slice((match.index ?? 0) + match[0].length);
    if (
      !NOW_ACTION_RE.test(guardTail) &&
      !NOW_NEGATED_OR_FUTURE_RE.test(guardTail) &&
      !NOW_ACTION_RE.test(after) &&
      !NOW_ACTIVE_RE.test(after) &&
      !NOW_NEGATED_OR_FUTURE_RE.test(after)
    ) {
      return true;
    }
  }
  return false;
}

function hasNeutralResidueReference(before: string, after: string): boolean {
  const match = NOW_RESIDUE_REFERENCE_RE.exec(after);
  if (!match) return false;

  const matchEnd = (match.index ?? 0) + match[0].length;
  const trailing = after.slice(matchEnd);
  // "not dropped" in the reported shape qualifies the residue handoff, not
  // the terminal item itself. Only forgive that exact trailing qualifier;
  // any additional negation/future/active/action wording remains guarded.
  const notDroppedQualifier = /^\s*(?:,\s*)?not\s+dropped\b/i;
  const neutralTrailing = notDroppedQualifier.test(trailing)
    ? trailing.replace(notDroppedQualifier, '')
    : trailing;
  const surrounding = `${before}${after.slice(0, match.index ?? 0)}${neutralTrailing}`;

  return (
    !NOW_ACTION_RE.test(surrounding) &&
    !NOW_NEGATED_OR_FUTURE_RE.test(surrounding) &&
    !NOW_ACTIVE_RE.test(surrounding)
  );
}

function isPlanItemRangeReference(text: string, start: number, end: number): boolean {
  for (const match of text.matchAll(PLAN_ITEM_RANGE_RE)) {
    const rangeStart = match.index ?? -1;
    const rangeEnd = rangeStart + match[0].length;
    if (rangeStart <= start && end <= rangeEnd) return true;
  }
  return false;
}

function affirmativelyClosedIds(nowText: string): Set<string> {
  const closed = new Set<string>();
  for (const match of nowText.matchAll(NOW_EXPLICIT_TERMINAL_STATUS_RE)) {
    const end = (match.index ?? 0) + match[0].length;
    const boundaries = [
      nowText.indexOf(';', end),
      nowText.indexOf('.', end),
      nowText.indexOf('!', end),
      nowText.indexOf('?', end),
      nowText.indexOf('\n', end),
      nowText.indexOf(':', end),
    ].filter((position) => position !== -1);
    const clauseEnd = boundaries.length > 0 ? Math.min(...boundaries) : nowText.length;
    if (!NOW_NEGATED_OR_FUTURE_RE.test(nowText.slice(end, clauseEnd))) {
      closed.add(match[1]);
    }
  }
  return closed;
}

function isNeutralPossessiveReference(
  id: string,
  explicitlyClosedIds: Set<string>,
  before: string,
  after: string,
): boolean {
  if (!explicitlyClosedIds.has(id) || !/\bof\s*$/i.test(before) || !NOW_NEUTRAL_POSSESSIVE_REFERENCE_RE.test(after)) {
    return false;
  }
  const surrounding = `${before.slice(-120)}${after}`;
  return (
    !NOW_ACTION_RE.test(surrounding) &&
    !NOW_ACTIVE_RE.test(surrounding) &&
    !NOW_NEGATED_OR_FUTURE_RE.test(surrounding) &&
    !NOW_TERMINAL_REFERENCE_LIVE_RE.test(after)
  );
}

function isInsideQuotedFragment(text: string, start: number, end: number): boolean {
  let quote: '"' | "'" | '`' | null = null;
  const isWord = (char: string | undefined) => Boolean(char && /[A-Za-z0-9_]/.test(char));

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    // Do not treat possessives/contractions (for example, `P-001's`) as
    // quote delimiters while scanning attributed prose.
    if (char === "'" && isWord(text[index - 1]) && isWord(text[index + 1])) continue;
    if (char === '"' || char === "'" || char === '`') {
      if (quote === null) quote = char;
      else if (quote === char) quote = null;
    }
    if (index === start) return quote !== null && end <= text.length;
  }
  return false;
}

/**
 * PURE: find terminal plan items that the cold-resume Now block still presents
 * as current/future work. Explicit completion prose ("P-001 is done") is
 * allowed, while an action-oriented mention ("finish P-001", "claim P-001")
 * is contradictory. The check is occurrence-based so a Now block may both
 * record an item's completion and accidentally direct a second pass over it.
 */
export function detectNowItemContradictions(
  parsed: Pick<ParsedPlan, 'now' | 'items' | 'slug'>,
): NowItemContradiction[] {
  if (!parsed.now) return [];

  const nowText = `${parsed.now.state}\n${parsed.now.next}`;
  const terminalItems = new Map<string, TerminalStatus>();
  for (const item of parsed.items) {
    if (item.storedStatus === 'done' || item.storedStatus === 'dropped') {
      terminalItems.set(item.id, item.storedStatus);
    }
  }
  if (terminalItems.size === 0) return [];

  const contradictions: NowItemContradiction[] = [];
  const explicitlyClosedIds = affirmativelyClosedIds(nowText);
  for (const match of nowText.matchAll(PLAN_ITEM_REF_RE)) {
    const id = match[0];
    const status = terminalItems.get(id);
    if (!status) continue;

    const start = match.index ?? 0;
    const end = start + id.length;
    if (isPlanItemRangeReference(nowText, start, end)) continue;
    // A Now may quote an item's stale trigger text while explaining why the
    // trigger is no longer applicable. The quoted id is not a claim about the
    // current plan item and must not poison the actual status assertion that
    // follows it.
    if (isInsideQuotedFragment(nowText, start, end)) continue;
    // Keep the window local to a sentence/clause. This makes a completion note
    // for one item unable to excuse a later action over another item.
    const leftBoundary = Math.max(
      nowText.lastIndexOf('\n', start - 1),
      nowText.lastIndexOf('.', start - 1),
      nowText.lastIndexOf('!', start - 1),
      nowText.lastIndexOf('?', start - 1),
      nowText.lastIndexOf(';', start - 1),
      nowText.lastIndexOf(':', start - 1),
    );
    const rightBoundaries = [
      nowText.indexOf('\n', end),
      nowText.indexOf('.', end),
      nowText.indexOf('!', end),
      nowText.indexOf('?', end),
      nowText.indexOf(';', end),
      nowText.indexOf(':', end),
    ].filter((position) => position !== -1);
    const rightBoundary = rightBoundaries.length > 0 ? Math.min(...rightBoundaries) : nowText.length;
    const clauseStart = leftBoundary + 1;
    const clause = nowText.slice(clauseStart, rightBoundary);
    const refOffset = start - clauseStart;
    const before = clause.slice(0, refOffset);
    const after = clause.slice(refOffset + id.length);
    const closeAfter =
      (NOW_CLOSED_RE.test(after) || NOW_PASSED_TEST_EVIDENCE_RE.test(after)) &&
      !NOW_NEGATED_OR_FUTURE_RE.test(after);
    const explicitTerminalStatus = NOW_TERMINAL_STATUS_ASSERTION_RE.test(after);
    const pastTenseReport = NOW_PAST_TENSE_REPORT_RE.test(after);
    const derivationCompletionAfter =
      NOW_DERIVATION_COMPLETION_RE.test(after) && !NOW_NEGATED_OR_FUTURE_RE.test(after);
    const closeBefore =
      (NOW_CLOSED_RE.test(before) || NOW_PASSED_TEST_EVIDENCE_RE.test(before)) &&
      !NOW_NEGATED_OR_FUTURE_RE.test(before.slice(-120));
    const stagingOnlyCompletion = isStagingOnlyCompletion(after);
    const clauseItemIds = [...clause.matchAll(PLAN_ITEM_REF_RE)].map((itemMatch) => itemMatch[0]);
    const sentenceEndCandidates = [
      nowText.indexOf('.', rightBoundary + 1),
      nowText.indexOf('!', rightBoundary + 1),
      nowText.indexOf('?', rightBoundary + 1),
      nowText.indexOf('\n', rightBoundary + 1),
    ].filter((position) => position !== -1);
    const sentenceEnd = sentenceEndCandidates.length > 0 ? Math.min(...sentenceEndCandidates) : nowText.length;
    const followingClause = nowText.slice(rightBoundary + 1, sentenceEnd);
    const collectiveResolution =
      /\b(?:both|all|these|those|they)\b/i.test(followingClause) &&
      hasAffirmativeResolution(followingClause);
    const retrospectiveResolution =
      rightBoundary < sentenceEnd &&
      nowText[rightBoundary] === ';' &&
      clauseItemIds.length > 0 &&
      clauseItemIds.every((itemId) => terminalItems.has(itemId)) &&
      NOW_RETROSPECTIVE_STATE_RE.test(clause) &&
      !NOW_NEGATED_OR_FUTURE_RE.test(clause) &&
      collectiveResolution;
    const neutralMetadataReference =
      clauseItemIds.length >= 2 &&
      clauseItemIds.every((itemId) => terminalItems.has(itemId)) &&
      NOW_METADATA_REFERENCE_RE.test(clause) &&
      NOW_METADATA_STATUS_RE.test(clause) &&
      !NOW_ACTION_RE.test(clause);
    // A terminal ID may also appear in a compact historical ledger reference,
    // e.g. `Historical promotion record: P-047–P-052/WI-41306–WI-41311`.
    // That is completion context, not a direction to revisit the item. Keep
    // action-oriented historical prose guarded: `Historical note: revisit
    // P-047` must still be rejected as a current-work contradiction.
    const historicalContext = `${nowText.slice(Math.max(0, clauseStart - 120), clauseStart)}${before}`;
    const historicalReference =
      NOW_HISTORICAL_RE.test(historicalContext) &&
      !NOW_ACTION_RE.test(before.slice(-120)) &&
      !NOW_ACTION_RE.test(after) &&
      !NOW_NEGATED_OR_FUTURE_RE.test(after);
    // Cross-ledger pairs such as `WI-41755/P-006 under D-081` identify the
    // implementation lineage. A neutral mapping remains useful after the plan
    // item closes while verification of the wider affected radius continues;
    // it is not itself an instruction to redo P-006. Keep this exemption
    // evidence-based and narrow: explicit action/future/active wording still
    // means the terminal item is being presented as current work.
    const crossLedgerReference =
      (NOW_CROSS_LEDGER_REF_BEFORE_RE.test(before) || NOW_CROSS_LEDGER_REF_AFTER_RE.test(after)) &&
      !NOW_ACTION_RE.test(historicalContext.slice(-120)) &&
      !NOW_ACTION_RE.test(after) &&
      !NOW_NEGATED_OR_FUTURE_RE.test(historicalContext.slice(-120)) &&
      !NOW_NEGATED_OR_FUTURE_RE.test(after) &&
      !NOW_ACTIVE_RE.test(historicalContext.slice(-120)) &&
      !NOW_ACTIVE_RE.test(after);
    // A decision reference such as `D-022 records P-012's primitive` is
    // evidence about a completed item, not a direction to revisit it. The
    // surrounding guards preserve the detector's safety boundary for
    // `Revisit D-022 records P-012` and `D-022 records P-012 as pending`.
    const neutralDecisionReference =
      NOW_DECISION_REFERENCE_RE.test(before) &&
      !NOW_ACTION_RE.test(before) &&
      !NOW_ACTION_RE.test(after) &&
      !NOW_NEGATED_OR_FUTURE_RE.test(before) &&
      !NOW_NEGATED_OR_FUTURE_RE.test(after) &&
      !NOW_ACTIVE_RE.test(before) &&
      !NOW_ACTIVE_RE.test(after);
    const neutralResidueReference = hasNeutralResidueReference(before, after);
    const neutralPossessiveReference = isNeutralPossessiveReference(
      id,
      explicitlyClosedIds,
      before,
      after,
    );
    const neutralPromotionProvenanceReference =
      NOW_PROMOTION_PROVENANCE_REFERENCE_RE.test(clause) &&
      !NOW_ACTION_RE.test(before) &&
      !NOW_ACTION_RE.test(after) &&
      !NOW_NEGATED_OR_FUTURE_RE.test(before) &&
      !NOW_NEGATED_OR_FUTURE_RE.test(after) &&
      !NOW_ACTIVE_RE.test(before) &&
      !NOW_ACTIVE_RE.test(after);
    const negativeReopenGuard = hasNegativeReopenGuard(before, after);
    // An explicit "<other-plan-slug> P-NNN" citation scopes the id to that
    // OTHER plan, never this one — see PLAN_SLUG_PREFIX_RE above. Tense/action
    // wording after the id is irrelevant here: the id itself does not name an
    // item of THIS plan, so there is nothing for this plan's terminal-status
    // map to contradict.
    const precedingSlugMatch = PLAN_SLUG_PREFIX_RE.exec(before);
    const explicitForeignPlanReference =
      precedingSlugMatch !== null && precedingSlugMatch[1].toLowerCase() !== parsed.slug.toLowerCase();
    if (
      closeAfter ||
      explicitTerminalStatus ||
      pastTenseReport ||
      derivationCompletionAfter ||
      closeBefore ||
      stagingOnlyCompletion ||
      historicalReference ||
      crossLedgerReference ||
      neutralDecisionReference ||
      neutralResidueReference ||
      neutralPossessiveReference ||
      neutralPromotionProvenanceReference ||
      negativeReopenGuard ||
      explicitForeignPlanReference ||
      retrospectiveResolution ||
      neutralMetadataReference
    )
      continue;

    contradictions.push({
      id,
      status,
      mention: clause.trim().slice(0, 180),
    });
  }
  return contradictions.filter((entry, index) => contradictions.findIndex((candidate) => candidate.id === entry.id) === index);
}

/**
 * PURE: find Now/Next sentences that make an exhaustive claim about the
 * remaining plan items while omitting a non-terminal structured item.  The
 * omission guard is deliberately separate from the terminal-item guard above:
 * a sentence can be truthful about the item it names and still be dangerously
 * incomplete about the plan as a whole.
 */
export function detectNowItemOmissions(
  parsed: Pick<ParsedPlan, 'now' | 'items'>,
): NowItemOmission[] {
  if (!parsed.now) return [];

  const nowText = `${parsed.now.state}\n${parsed.now.next}`;
  const nonTerminal = new Set(
    parsed.items
      .filter((item) => item.storedStatus !== 'done' && item.storedStatus !== 'dropped')
      .map((item) => item.id),
  );
  if (nonTerminal.size === 0) return [];

  const omissions: NowItemOmission[] = [];
  // The sentence/clause ending at each boundary is the smallest context in
  // which an exhaustive list can be interpreted. A missing final boundary is
  // handled by appending the text length below.
  let sentenceStart = 0;
  const sentenceEnds = [...nowText.matchAll(/[.!?\n]/g)].map((match) => match.index! + 1);
  sentenceEnds.push(nowText.length);
  for (const sentenceEnd of sentenceEnds) {
    const sentence = nowText.slice(sentenceStart, sentenceEnd);
    const matches = [
      ...sentence.matchAll(NOW_ONLY_PREFIX_RE),
      ...sentence.matchAll(NOW_ONLY_SUFFIX_RE),
      ...sentence.matchAll(NOW_REMAINING_CLAUSE_RE),
    ];
    for (const match of matches) {
      const listed = idsFromList(match[1] ?? '');
      if (listed.length === 0) continue;
      const omitted = [...nonTerminal].filter((id) => !listed.includes(id));
      if (omitted.length === 0) continue;
      omissions.push({
        omitted,
        listed: [...new Set(listed)],
        mention: sentence.trim().slice(0, 240),
      });
    }
    sentenceStart = sentenceEnd;
  }
  return omissions.filter(
    (entry, index) =>
      omissions.findIndex(
        (candidate) =>
          candidate.omitted.join(',') === entry.omitted.join(',') &&
          candidate.listed.join(',') === entry.listed.join(','),
      ) === index,
  );
}
