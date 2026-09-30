/**
 * flag-comment-lint — parses the FLAGS block's own doc comments in types.ts and
 * cross-checks each entry's declared default ("DEFAULT ON" / "DEFAULT OFF") against
 * its actual DARK_FLAGS membership (EI-9826, leader-directed class-fix).
 *
 * WHY THIS EXISTS: the exact same bug shape recurred 8+ times in this file's history
 * (WATCHDOG_AUTO_CLOSE, SUBSTRATE_LOG_SNAPSHOT, SUBSTRATE_SIDECAR, RECLAIM_STALLED,
 * PSU_END_USER, PLAN_PART_FEDERATION, GIT_SYNC_DERIVED_ATTRIBUTION, DOC_STEWARD, and
 * the WI-3855 sweep of 16 more) — a flag's OWN code comment says "DEFAULT OFF / dark"
 * while the flag is silently missing from DARK_FLAGS, so `FLAG_DEFAULTS` (which is
 * `!DARK_FLAGS.has(key)`) derives it live default-ON with zero owner ratification.
 * Nothing caught the disagreement at commit time. This module IS that catch.
 *
 * PARSING APPROACH — this is a lint over free-form prose comments, not a formal
 * grammar, so it is deliberately CONSERVATIVE: high precision over recall. It skips
 * (never asserts on) any entry it cannot classify with confidence, rather than
 * guessing and risking a false-positive CI failure on a legitimately fine entry. Real
 * mismatches it DOES find are exactly what a human reviewer would call a mismatch
 * reading the same text — the three normalization steps below just remove textual
 * noise a naive substring search would trip on:
 *
 *   1. QUOTED SPANS ARE STRIPPED. The established repo convention (every corrected
 *      WI-3855-class entry) is to narrate the OLD, WRONG claim inside literal double
 *      quotes when explaining the fix, e.g.:
 *        DEFAULT ON (WI-3855: this comment's own "DEFAULT OFF ... KNOWN_DARK_FLAGS"
 *        was never actually added to the DARK_FLAGS map, so ... it derived live
 *        default-ON) ...
 *      Without stripping the quoted span, a naive scan sees BOTH "DEFAULT ON" and
 *      "DEFAULT OFF" in the same block and can't tell which is the current claim.
 *      Quote-stripping removes the historical narrative, leaving only the entry's
 *      OWN current, unquoted declaration.
 *
 *   2. THE "alpha (flags-)default-on (policy)" BOILERPLATE IS STRIPPED. Many
 *      DELIBERATE-dark entries explain themselves by contrast with the repo-wide
 *      alpha policy, e.g. "DEFAULT OFF — DELIBERATE, NOT the alpha flags-default-on
 *      policy". The hyphenated phrase "default-on" inside that boilerplate is a
 *      reference to the GENERAL policy's name, not a claim about THIS flag, but it
 *      matches a naive `DEFAULT[\s-]+ON` scan and creates a false ambiguity.
 *
 *   3. AN ENTRY WHOSE (normalized) COMMENT STILL CONTAINS **BOTH** AN UNQUOTED
 *      "DEFAULT ON" AND AN UNQUOTED "DEFAULT OFF" IS SKIPPED, not asserted on. This
 *      happens legitimately when one comment block explains two related flags
 *      together (e.g. a flag's comment references a sibling flag's own default).
 *      Precision over recall: an unresolvable case is left to human review instead of
 *      being force-classified.
 *
 *   4. DARKNESS IS CLAIMED IN **TWO** ESTABLISHED FORMS IN THIS FILE, AND BOTH COUNT
 *      (WI-6045). The obvious one is the literal declaration "DEFAULT OFF". The other
 *      is a bare membership assertion — "Listed in KNOWN_DARK_FLAGS" — used by entries
 *      that describe the gate in prose instead of declaring a default, e.g.
 *        ... it ships dark until both dogfood machines updated; owner flips after a
 *        2-machine verify. Listed in KNOWN_DARK_FLAGS (cutover).
 *      Recognising only the first form left a real blind spot: PRESENCE_GOSSIP carried
 *      exactly that text with NO literal "DEFAULT OFF", so it classified as null and
 *      the lint never looked at it — while the flag had in fact been graduated OUT of
 *      DARK_FLAGS (2026-07-16) and was live default-ON. The comment, not the code, was
 *      the stale side; but the guard is supposed to ASK the question either way, and it
 *      silently skipped it. Note the asymmetry that keeps this precise: a membership
 *      claim is only ever evidence of 'off' — the absence of one implies nothing, so
 *      there is no corresponding "claims light" form to add here.
 *
 *   5. THE **REVERSED** DECLARATION COUNTS TOO — state first, "(default)" after
 *      (P-010 follow-up, 2026-07-26). Steps 1-4 all assume the declaration reads
 *      "DEFAULT OFF"; but the file also uses the natural-English inversion, e.g.
 *        LAZY_SUBSTRATE_BOOT: "... OFF (default): boot is byte-identical to today
 *        (eager all-harness boot). DARK + STAGED-ON-:3170-FIRST because a wrong
 *        eviction silently stops a harness syncing → fleet data divergence ..."
 *      `DEFAULT[\s-]+OFF` requires "DEFAULT" to come FIRST, so it did not match; no
 *      other form matched either, so the entry classified as null and the guard
 *      SKIPPED it — while the flag was in fact absent from DARK_FLAGS and deriving
 *      live default-ON, in direct contradiction of its own "DARK + STAGED" text, for
 *      a feature whose stated failure mode is fleet data divergence. Exactly the
 *      PRESENCE_GOSSIP blind spot of step 4, one phrasing later: the guard is meant
 *      to ASK the question, and a comment's word order should not decide whether it
 *      gets asked. Also folds in the verb form ("defaults to OFF") and a colon after
 *      DEFAULT ("DEFAULT: OFF"), which the original `[\s-]+` character class missed.
 *
 *   6. A "SHIPS DARK" NARRATIVE CLAIM COUNTS TOO (EI-18886519654229938 /
 *      EI-19360358881224651, 2026-08-02) — the fifth AND sixth real recurrences of
 *      this exact bug class, found live in THIS repo's own types.ts, neither caught
 *      by any of steps 1-5: LEARNING_SLO_SENSORS and GRADUATION_TRACKER each said
 *      "…so it ships dark until the plan's P-001 arming gate closes" with no literal
 *      "DEFAULT OFF", no "listed in DARK_FLAGS", and no reversed/verb form anywhere
 *      in the comment — five established forms, zero matches, silently skipped both.
 *      "ship(s) dark" is now its own claim-of-darkness form, EXCLUDING the common
 *      negated idiom "finished work never ships dark" (used by several genuinely
 *      default-ON entries to explain why they are correctly ON, not why they are
 *      dark) via a `never|not|no|n't` guard within 30 chars before the phrase.
 */

export interface FlagCommentEntry {
  /** The FLAGS object key, e.g. "WATCHDOG_AUTO_CLOSE". */
  key: string;
  /** The flag's string value, e.g. "papercusp-watchdog-auto-close". */
  value: string;
  /** The comment block immediately above the entry's `KEY: "value",` line, with the
   *  `//` prefix + indentation stripped from each line and re-joined with spaces (so
   *  a claim word-wrapped across two comment lines is still one contiguous phrase). */
  comment: string;
}

/** Declarative default the entry's OWN comment claims — 'on' | 'off' | null (no
 *  confident unambiguous claim found — the entry is skipped by the checker). */
export type ClaimedDefault = 'on' | 'off' | null;

const FLAGS_BLOCK_START_RE = /^export const FLAGS = \{\s*$/m;
const FLAGS_BLOCK_END_RE = /^\} as const;\s*$/m;
const KEY_LINE_RE = /^\s*([A-Z0-9_]+):\s*"([^"]+)",?\s*$/;

/**
 * Parse every `KEY: "value",` entry inside `export const FLAGS = { ... } as const;`
 * out of the raw types.ts SOURCE TEXT, pairing each with its own preceding comment
 * block. Throws if the FLAGS block markers aren't found (a structural change to
 * types.ts this lint would need updating for — fail loud, not silently skip everything).
 */
export function parseFlagEntries(source: string): FlagCommentEntry[] {
  const lines = source.split('\n');
  const startIdx = lines.findIndex((l) => FLAGS_BLOCK_START_RE.test(l));
  if (startIdx === -1) {
    throw new Error('flag-comment-lint: could not find "export const FLAGS = {" — has types.ts changed shape?');
  }
  let endIdx = -1;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (FLAGS_BLOCK_END_RE.test(lines[i])) {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) {
    throw new Error('flag-comment-lint: could not find the FLAGS block\'s closing "} as const;"');
  }

  const entries: FlagCommentEntry[] = [];
  let commentBuf: string[] = [];
  for (let i = startIdx + 1; i < endIdx; i++) {
    const line = lines[i];
    const m = line.match(KEY_LINE_RE);
    if (m) {
      entries.push({ key: m[1], value: m[2], comment: commentBuf.join(' ') });
      commentBuf = [];
    } else {
      const stripped = line.replace(/^\s*\/\/\s?/, '').trim();
      if (stripped) commentBuf.push(stripped);
    }
  }
  return entries;
}

/**
 * Parse the `[FLAGS.KEY, { case: ..., reason: ... }]` entries out of the DARK_FLAGS
 * map literal's raw source text, returning the set of dark-registered FLAGS keys.
 * A textual re-derivation (deliberately independent of importing the live `DARK_FLAGS`
 * export) so this lint can be exercised against an arbitrary fixture source string in
 * tests, not only the real module.
 */
export function extractDarkFlagKeys(source: string): Set<string> {
  const darkStart = source.indexOf('export const DARK_FLAGS');
  if (darkStart === -1) return new Set();
  const rest = source.slice(darkStart);
  const mapMatch = rest.match(/new Map<[^>]*>\(\[([\s\S]*?)\n\s*\]\);/);
  const body = mapMatch ? mapMatch[1] : rest;
  return new Set(
    [...body.matchAll(/\[\s*FLAGS\.([A-Z0-9_]+)\s*,/g)].map((m) => m[1]),
  );
}

/** Strips quoted narrative spans + the "alpha (flags-)default-on (policy)" boilerplate
 *  (see the module doc's normalization steps 1-2) from a comment block. */
function normalize(comment: string): string {
  let s = comment.replace(/"[^"]*"/g, ' ');
  s = s.replace(/alpha[\s-]+(?:flags[\s-]+)?default[\s-]+on(?:\s+policy)?/gi, ' ');
  return s;
}

const DEFAULT_OFF_RE = /\bDEFAULT[\s:-]+OFF\b/i;
const DEFAULT_ON_RE = /\bDEFAULT[\s:-]+ON\b/i;

/** The THIRD established form (module doc, normalization step 5): the REVERSED
 *  declaration — the state first, "(default)" after — e.g. "OFF (default): boot is
 *  byte-identical to today". Anchored on a literal closing "(default)" so it cannot
 *  swallow the very common "flip OFF via /admin/features … Default ON (derived
 *  FLAG_DEFAULTS)" shape, where the parenthetical says something else entirely. */
const REVERSED_OFF_RE = /\bOFF\s*\((?:the\s+)?default\)/i;
const REVERSED_ON_RE = /\bON\s*\((?:the\s+)?default\)/i;

/** Same claim in verb form — "defaults to OFF". */
const DEFAULTS_TO_OFF_RE = /\bdefaults?\s+to\s+OFF\b/i;
const DEFAULTS_TO_ON_RE = /\bdefaults?\s+to\s+ON\b/i;

/** The second claim-of-darkness form (module doc, normalization step 4): a present-tense
 *  assertion of DARK_FLAGS membership, e.g. "Listed in KNOWN_DARK_FLAGS (cutover)".
 *
 *  Deliberately anchored on "listed in" rather than a bare mention of DARK_FLAGS, because
 *  the repo's OWN correction convention narrates the map in the NEGATIVE while explaining a
 *  past fix — "…was never actually added to the DARK_FLAGS map, so P-011 derived it live
 *  default-ON". That narration is frequently UNQUOTED (so `normalize()`'s quote-stripping
 *  does not remove it) and appears in entries that are correctly default-ON. A looser
 *  pattern would flip every one of those to a false 'off' claim and red the build on
 *  entries that are entirely fine. */
const LISTED_DARK_RE = /\blisted in\s+(?:the\s+)?(?:KNOWN_)?DARK_FLAGS\b/i;

/**
 * The SIXTH established form (module doc step 6, EI-18886519654229938 /
 * EI-19360358881224651 — the fifth AND sixth recurrences of this exact bug class,
 * found live in the SAME file): a "ships dark" / "ship dark" narrative claim, most
 * often as "…so it ships dark until the plan's P-001 arming gate closes". This is
 * the phrasing LEARNING_SLO_SENSORS and GRADUATION_TRACKER both used — neither
 * "DEFAULT OFF" nor "listed in DARK_FLAGS" nor either reversed/verb form appears in
 * that phrasing at all, so all five prior forms silently skipped both entries
 * (classified null) despite the mismatch being exactly the class this file exists
 * to catch. "ship(s) dark" is the load-bearing phrase; anchoring on it alone
 * (rather than requiring "until … gate" too) covers the bare form seen elsewhere in
 * this file ("OFF = the Class-C loops ship dark").
 *
 * MUST exclude the common repo-wide alpha-policy idiom "finished work never ships
 * dark" (INBOX_DURABLE_ESCALATIONS, EPHEMERAL_CADENCE, and others use this exact
 * phrase to explain why THEY are correctly default-ON) — that is a negated general
 * principle, not a claim that THIS flag itself currently ships dark. Without the
 * negation guard, every entry citing that idiom as its OWN justification for being
 * ON would flip to a bogus 'off' claim.
 */
const DARK_SHIP_RE = /\bships?\s+dark\b/i;
const NEGATED_DARK_SHIP_RE = /\b(?:never|not|no|n't)\b[^.\n]{0,30}\bships?\s+dark\b/i;

/** The entry's own claimed default, per the module doc's conservative parsing rules.
 *  Returns null (unclassifiable / ambiguous — skip, never assert) when the normalized
 *  comment claims both 'on' and 'off', or neither. */
export function claimedDefault(entry: FlagCommentEntry): ClaimedDefault {
  const normalized = normalize(entry.comment);
  // Any established form counts as claiming a default; see module doc steps 4-6.
  const hasOff =
    DEFAULT_OFF_RE.test(normalized) ||
    LISTED_DARK_RE.test(normalized) ||
    REVERSED_OFF_RE.test(normalized) ||
    DEFAULTS_TO_OFF_RE.test(normalized) ||
    (DARK_SHIP_RE.test(normalized) && !NEGATED_DARK_SHIP_RE.test(normalized));
  const hasOn =
    DEFAULT_ON_RE.test(normalized) ||
    REVERSED_ON_RE.test(normalized) ||
    DEFAULTS_TO_ON_RE.test(normalized);
  if (hasOff === hasOn) return null; // both or neither ⇒ unclassifiable, skip
  return hasOff ? 'off' : 'on';
}

export type MismatchKind = 'claims-dark-but-not-listed' | 'claims-light-but-listed-dark';

export type BranchEffect = 'narrows' | 'widens' | 'unknown';

/** Evidence carried with a mismatch so readers do not have to re-derive the risk direction. */
export interface FlagMismatchEvidence {
  /** What the comment says the ON branch does. */
  onEffect: BranchEffect;
  /** What the comment says the OFF branch does. */
  offEffect: BranchEffect;
  /** True when the comment says the flag changes the data partition being read/written. */
  partitionSwing: boolean;
  /** Short comment excerpts containing the directional claim. */
  directionalExcerpts: string[];
  /** Short comment excerpts naming partitions, counts, or write dates. */
  partitionExcerpts: string[];
}

export interface FlagCommentMismatch {
  key: string;
  value: string;
  kind: MismatchKind;
  evidence: FlagMismatchEvidence;
}

const ON_NARROWS_RE = /\bon\b[^.\n]{0,180}\b(?:narrows?|clamps?|restricts?|denies?|prevents?|guards?|scopes?|safer|fail[- ]closed)\b/i;
const ON_WIDENS_RE = /\bon\b[^.\n]{0,180}\b(?:widens?|broadens?|allows?|relaxes?|unrestricted|removes?[^.\n]{0,60}(?:check|guard|clamp|limit))\b/i;
const OFF_NARROWS_RE = /\boff\b[^.\n]{0,180}\b(?:narrows?|clamps?|restricts?|denies?|prevents?|guards?|scopes?|safer|fail[- ]closed)\b/i;
const OFF_WIDENS_RE = /\boff\b[^.\n]{0,180}\b(?:widens?|broadens?|allows?|relaxes?|unrestricted|removes?[^.\n]{0,60}(?:check|guard|clamp|limit))\b/i;
const PARTITION_RE = /\bpartition\b|\bworkspace\b[^.\n]{0,80}\b(?:rows?|corpus|writes?)\b|\blegacy\b[^.\n]{0,80}\b(?:default|partition|rows?)\b/i;

function commentExcerpts(comment: string, predicate: (line: string) => boolean): string[] {
  return comment
    .split(/(?<=[.!?])\s+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && predicate(line))
    .map((line) => (line.length > 240 ? `${line.slice(0, 237)}…` : line));
}

function effectFor(comment: string, on: boolean): BranchEffect {
  // The declaration ("DEFAULT OFF") is not an OFF-branch description; remove it
  // before looking for branch-local verbs so it cannot borrow a later ON/OFF phrase.
  const branchComment = comment.replace(/\bDEFAULT[\s-]+(?:ON|OFF)\b/gi, ' ');
  const re = on ? { narrow: ON_NARROWS_RE, wide: ON_WIDENS_RE } : { narrow: OFF_NARROWS_RE, wide: OFF_WIDENS_RE };
  const excerpts = commentExcerpts(branchComment, (line) => re.narrow.test(line) || re.wide.test(line));
  const narrows = excerpts.some((line) => re.narrow.test(line));
  const widens = excerpts.some((line) => re.wide.test(line));
  return narrows === widens ? 'unknown' : narrows ? 'narrows' : 'widens';
}

/** Derive the operational evidence already present in a flag's own comment. */
export function deriveMismatchEvidence(comment: string): FlagMismatchEvidence {
  const directionalExcerpts = commentExcerpts(comment, (line) =>
    /\b(?:on|off)\b/i.test(line) && /\b(?:narrow|clamp|restrict|deny|prevent|guard|scope|safe|widen|broad|allow|relax|unrestricted|remove)/i.test(line),
  );
  const partitionExcerpts = commentExcerpts(comment, (line) => PARTITION_RE.test(line) && /\b(?:on|off|rows?|partition|default|legacy|live|write)/i.test(line));
  return {
    onEffect: effectFor(comment, true),
    offEffect: effectFor(comment, false),
    partitionSwing: partitionExcerpts.length > 0,
    directionalExcerpts,
    partitionExcerpts,
  };
}

/**
 * The core check: for every FLAGS entry with a confident, unambiguous claimed
 * default, assert it agrees with `darkKeys` membership. Returns every disagreement
 * found, in FLAGS declaration order — the caller (a test) decides how to react
 * (fail outright on a fixture; diff against a documented pending-allowlist on the
 * real tree).
 */
export function findMismatches(entries: FlagCommentEntry[], darkKeys: ReadonlySet<string>): FlagCommentMismatch[] {
  const out: FlagCommentMismatch[] = [];
  for (const entry of entries) {
    const claim = claimedDefault(entry);
    if (claim === null) continue;
    const inDark = darkKeys.has(entry.key);
    if (claim === 'off' && !inDark) {
      out.push({ key: entry.key, value: entry.value, kind: 'claims-dark-but-not-listed', evidence: deriveMismatchEvidence(entry.comment) });
    } else if (claim === 'on' && inDark) {
      out.push({ key: entry.key, value: entry.value, kind: 'claims-light-but-listed-dark', evidence: deriveMismatchEvidence(entry.comment) });
    }
  }
  return out;
}
