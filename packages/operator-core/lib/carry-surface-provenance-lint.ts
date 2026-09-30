/**
 * carry-surface-provenance-lint — write-time nudge for UNTAGGED owner-attributed
 * imperatives on a carry-surface write (WI-3801, deferred item 3 of EI-9091's fix;
 * items 1/2/4 landed in apps/operator/prompts/papercusp-compaction.base.md's
 * "Directive provenance" section).
 *
 * WHY: EI-9091 root-caused (traced end-to-end on WI-3532) that carry surfaces
 * (work_items:checkpoint, facts:assert, loop:checkpoint, session:request-compaction
 * focus/continueNote) store directives as bare imperatives with no source
 * attribution, so repeated re-summarization drifts an agent's own note-to-self
 * ("do NOT resolve WI-3532 until the UI pass is done") into "the owner said X" —
 * manufacturing a directive (or worse, a PERMISSION) the owner never gave. The doc
 * fix (papercusp-compaction.base.md) instructs agents to tag every directive with
 * its source: `[owner:<name> <date>]` · `[self-imposed]` · `[peer:<sid>]` ·
 * `[inferred]`. THIS module is the tooling backstop: a best-effort, WARN-ONLY
 * heuristic that flags a carry-surface write containing an owner-attributed
 * imperative phrase with NO adjacent source tag, so the writing agent gets a
 * nudge (verify via sessions:search, or tag it) at the moment of write — not
 * seven compactions later when the drift has already compounded.
 *
 * DELIBERATELY WARN, NEVER BLOCK: a false positive on a write-time gate for the
 * exact tool an agent calls to persist critical continuity state (often near a
 * compaction/context limit) would be worse than the drift this catches — a
 * blocked checkpoint write strands MORE state than an untagged one. Every
 * consumer surfaces the result as an advisory field in its response, never a
 * rejected write.
 */

/** The tagged-source forms the "Directive provenance" convention recognizes.
 *  The owner alternative accepts the same near-miss separator shapes as
 *  {@link OWNER_TAG_RE} (defined below) — kept as a literal here rather than an
 *  interpolated reference so this declaration doesn't have to move below its
 *  dependency; the two are asserted in sync by the module's own tests.
 *
 *  `[system-derived:fleet-control]` is reserved for a typed fleet-control cue:
 *  its imperative is a live registry fact, not an owner or agent directive. Keep
 *  the namespace explicit so a generic machine-written sentence cannot silently
 *  clear this lint. */
const SOURCE_TAG_RE =
  /\[(?:\bowner\b\s*[:=\-]?\s*[^\]]+|self-imposed|peer:[^\]]+|inferred|system-derived:fleet-control)\]/i;

/** P-014 (deterministic-context-carry): a turn ref `[turn:<session>@<ts>]` is the
 *  VERIFIABLE anchor for a directive — the stamper (carry-surface-provenance-stamp)
 *  resolves it against the writer's own transcript and classifies the referenced
 *  turn owner-vs-agent mechanically. A line carrying one is never lint-flagged.
 *
 *  Session ids on the wire can carry a client namespace (`codex:<uuid>` or
 *  `claude:<uuid>`), while older refs contain only the hexadecimal prefix. Keep
 *  this recognizer in step with turn-ref.ts so a valid Codex/Claude anchor is not
 *  mistaken for an unverified action claim (EI-21165235642497045). */
const TURN_REF_LINE_RE = /\[turn:[A-Za-z0-9][A-Za-z0-9:_-]{3,79}@[0-9T:.+Z-]{10,40}\]/i;

/**
 * EI-19988211953593959: the separator between the `owner` keyword and the tag's
 * content, matched permissively — colon (the documented form) plus the near-miss
 * shapes an agent actually types under compaction pressure (space, `=`, `-`). Every
 * detector below (detection, backtick-quoting, placeholder, mention-context) is
 * anchored on this SAME fragment so a near-miss shape is SEEN by the whole module —
 * at worst downgraded to `possible-owner-tag-mention` — instead of being invisible
 * to detection, quoting, AND mention-context alike (the prior colon-only anchor made
 * the gap module-wide, per this ticket). `\bowner\b` (not a bare `owner`) so this
 * never matches inside an unrelated word like "ownership".
 */
const OWNER_TAG_SEP = '\\bowner\\b\\s*[:=\\-]?\\s*';

/** A hand-written owner tag with NO turn ref. P-014 retires these as evidence:
 *  the tag asserts, a turn ref proves — and the WI-3532 drift showed asserted
 *  tags survive compaction hops while their truth decays. Warn-only, like all
 *  of this module. Widened (EI-19988211953593959) to see colon/space/equals/dash
 *  separator shapes, not just the literal colon — see {@link OWNER_TAG_SEP}. */
const OWNER_TAG_RE = new RegExp(`\\[\\s*${OWNER_TAG_SEP}[^\\]]+\\]`, 'i');

/**
 * EI-18672153930631150: `OWNER_TAG_RE` matches the literal token `[owner:` with
 * no regard for whether the surrounding text is USING the tag (attributing a
 * real directive) or MENTIONING it (documenting/comparing the convention's own
 * syntax — exactly what a doc, a test fixture, or a checkpoint ABOUT this lint
 * has to write). Two tiers of cheap, line-scoped anchors recover that
 * distinction without touching the tag-detection regex itself (which must
 * keep matching every real tag, including ones this module has never seen
 * before):
 *
 *  DEFINITE quoting — a backtick-fenced `` `[owner:...]` `` — never flags at
 *  all. This repo's actual convention is written BARE in prose (per root
 *  CLAUDE.md's own worked example), never as inline code, so a backtick-
 *  wrapped occurrence is how you quote a syntax you are talking ABOUT, not
 *  how you invoke it. (Only same-line inline-code is handled; a multi-line
 *  fenced ``` block is out of scope for this line-scoped scanner.)
 *
 *  AMBIGUOUS mention — downgraded to `possible-owner-tag-mention` (kept
 *  VISIBLE, per the filed suggestion, but out of the loud `manual-owner-tag`
 *  category so that category stays rare and keeps its meaning) — when either:
 *   - PLACEHOLDER content: a real use always names an actual owner (e.g.
 *     `[owner:Jane 2026-07-14]`); a mention illustrating the *form* almost
 *     always uses a generic stand-in (`[owner:Name]`, `[owner:<name>]`,
 *     `[owner:foo]`, `[owner:...]`), or
 *   - MENTION-CONTEXT words within a short window before the tag (`form`,
 *     `convention`, `pattern`, `syntax`, `example`, `e.g.`, `->`) — the
 *     grammatical company a citation of the syntax keeps, per the filed
 *     repro ("the detector matches the bracket form [owner:Name] ...").
 *
 * A tag naming a real owner with no such context — e.g.
 * `[owner:jane 2026-07-10]` — is untouched and still flags `manual-owner-tag`
 * exactly as before.
 */
// EI-18762822878138952: the repo's own documented tag SHAPE — e.g. `[owner:<name> <date>]`,
// written out verbatim in root CLAUDE.md's "Directive provenance" convention and reused by
// every agent that documents/implements it — chains TWO placeholder tokens ("<name>" then
// "<date>") separated by whitespace. The single-alternative form below only ever matched ONE
// token before the closing bracket, so that exact canonical example fell through to the loud
// `manual-owner-tag` category instead of being recognized as a placeholder mention. Allow one
// or more whitespace-separated placeholder tokens (each still restricted to the same known
// stand-ins) so a chained placeholder still reads as a placeholder, not a real attribution.
const OWNER_TAG_PLACEHOLDER_TOKEN = '(?:name|someone|tbd|foo|bar|x|<[^>]+>|\\.{3}|…)';
// EI-19988211953593959: anchored on the same OWNER_TAG_SEP fragment as OWNER_TAG_RE
// (colon/space/equals/dash) so a placeholder written in a near-miss shape — e.g.
// `[owner Name]` — still downgrades to possible-owner-tag-mention instead of being
// invisible to every tier the way it was under the colon-only anchor.
const OWNER_TAG_PLACEHOLDER_RE = new RegExp(
  `\\[\\s*${OWNER_TAG_SEP}${OWNER_TAG_PLACEHOLDER_TOKEN}(?:\\s+${OWNER_TAG_PLACEHOLDER_TOKEN})*\\s*\\]`,
  'i',
);
const BACKTICK_WRAPPED_OWNER_TAG_RE = new RegExp(`\`\\[\\s*${OWNER_TAG_SEP}[^\\]]*\\]\``, 'i');
const OWNER_TAG_MENTION_CONTEXT_RE = new RegExp(
  `(?:\\bforms?\\b|\\bconvention\\b|\\bpatterns?\\b|\\bsyntax\\b|\\bexamples?\\b|\\be\\.g\\.,?|->)[^[]{0,30}\\[\\s*\\bowner\\b`,
  'i',
);

/**
 * EI-19461711239876849: the module flagged `manual-owner-tag` on a line whose whole
 * purpose was to REFUSE an owner attribution and downgrade it — i.e. it penalised the
 * exact correction the convention exists to elicit. An agent that learns "writing
 * [owner:…] trips a lint" is nudged toward silently DROPPING an unverifiable
 * attribution rather than documenting that it is unverifiable, which re-creates the
 * WI-3532 telephone game from the other end.
 *
 * A withdrawal is recognized CONJUNCTIVELY — both halves required:
 *   1. a DOWNGRADE tag ([self-imposed] · [peer:…] · [inferred]) on the line, which a
 *      correctly-retracted attribution always carries (it must say what the source
 *      actually was), and
 *   2. an explicit NEGATION of owner authority nearby — "NOT as [owner:…]", "NOT an
 *      owner directive", "not a quoted owner turn", "could not verify it against an
 *      owner turn", "NOT anchored to an OWNER-stamped turn".
 *
 * The conjunction is what makes it safe, and it is MEASURED, not assumed. Corpus:
 * the 251 distinct carry-surface lines in this workspace's stored history
 * (harness_shared.carry_notes + agent_facts) carrying an owner-authority shape, of
 * which 222 flagged `manual-owner-tag` before this rule:
 *   - this rule reclassifies 17, and all 17 are genuine retractions / self-
 *     attributions ("[self-imposed gate — not an owner directive]", the PROVENANCE
 *     CORRECTION blocks the convention asks for);
 *   - every real ASSERTED owner attribution still flags.
 *
 * ⚠ The filed suggestion — "skip when a [peer:]/[self-imposed]/[inferred] tag appears
 * in the same sentence" — was measured against that corpus and REJECTED. The downgrade
 * tag ALONE suppresses 22, and 4 of the 5 extra are REAL owner attributions it would
 * silently launder: a verbatim relayed ask ("relayed VERBATIM by [peer:…] … treat as
 * owner-sourced: [owner:…]"), a dated pause directive, a plan reactivation, and an
 * owner DEMAND for GUI verification. Negation ALONE is worse in the other direction
 * (34). Requiring BOTH is what separates a retraction from an assertion that merely
 * happens to cite a peer alongside it — which is exactly what a relay looks like.
 */
const OWNER_TAG_DOWNGRADE_TAG_RE = /\[(?:self-imposed|peer:|inferred)\b[^\]]*\]/i;
/** An owner-AUTHORITY reference: the bracket tag, or "owner" as an authority noun. */
const OWNER_AUTHORITY_REF =
  '(?:\\[owner:|\\bowner(?:[-\\s](?:directive|mandate|turn|tag|stamped|sourced|typed|authoriz\\w*)\\b|\\b))';
/** A negator governing an owner-authority reference within one clause (no sentence
 *  boundary crossed, short window) — "NOT as [owner:…]", "NOT an owner directive". */
const NEGATED_OWNER_AUTHORITY_RE = new RegExp(
  `(?:\\bnot\\b|\\bnever\\b|n't\\b|\\bcannot\\b)[^.!?\\n]{0,40}?${OWNER_AUTHORITY_REF}`,
  'i',
);

/**
 * WI-42142 — the LINE-SCOPED predicate "does this line assert OWNER AUTHORITY at
 * all?", exported for a consumer that has RESOLVED the line's `[turn:…]` ref and
 * needs to ask the second half of a question this module's sync scan structurally
 * cannot: not *is the claim anchored?* but *is the anchor's turn actually the
 * owner?*
 *
 * WHY IT MUST BE SEPARATE: {@link lintCarrySurfaceProvenance} SKIPS any line
 * carrying a `[turn:…]` ref (TURN_REF_LINE_RE) — a ref is treated as mechanically
 * verifiable, so such a line never reaches a detector at all. That exemption is
 * exactly what `stable-candidate-related-gate-2026-08-23#D-085` rode in on: it
 * cited `[turn:codex:01a03d76-…@2026-08-26T09:46:32.215Z]` for "Owner-directed
 * ordering", and the cited turn is a SELF-COMPACTION note in a session with zero
 * human turns. The sync lint flagged nothing — correctly, by its own contract —
 * and the asserted hold then froze a release gate for days. Only the RESOLVED
 * verdict can falsify such an anchor, and a consumer holding that verdict still
 * needs to know the line was claiming owner authority in the first place.
 *
 * Deliberately BROADER than the assertion detectors above — it matches the bare
 * noun `owner` via {@link OWNER_AUTHORITY_REF}'s final alternative, so it also sees
 * shapes no detector here matches ("Owner-directed ordering", "the owner
 * checkpoint records…"). That breadth is safe ONLY because it is used in
 * CONJUNCTION with a resolved-and-falsified turn verdict: the narrowing is carried
 * by the evidence, not by the phrase match. Do not reuse it as a standalone
 * detector — on its own it would fire on any sentence containing the word.
 */
const OWNER_AUTHORITY_LINE_RE = new RegExp(OWNER_AUTHORITY_REF, 'i');

export function assertsOwnerAuthority(line: string | null | undefined): boolean {
  if (!line) return false;
  return OWNER_AUTHORITY_LINE_RE.test(line);
}

/**
 * A line that RETRACTS an owner attribution rather than asserting one. Applies to both
 * the bracket tag and the `owner directive|mandate` noun phrase — a retraction is
 * written in whichever form the thing being retracted used.
 */
function isProvenanceWithdrawal(line: string): boolean {
  return OWNER_TAG_DOWNGRADE_TAG_RE.test(line) && NEGATED_OWNER_AUTHORITY_RE.test(line);
}

/** Definite quoting of the tag's syntax — never flag, not even as a mention. */
function isOwnerTagQuotedForm(line: string): boolean {
  return BACKTICK_WRAPPED_OWNER_TAG_RE.test(line);
}

/** Ambiguous — likely documenting/comparing the form, not attributing. */
function isOwnerTagPossibleMention(line: string): boolean {
  return OWNER_TAG_PLACEHOLDER_RE.test(line) || OWNER_TAG_MENTION_CONTEXT_RE.test(line);
}

/**
 * EI-21918777703977266: a bare `[owner:…]` tag asserting that a DIALOG
 * (an AskUserQuestion) was answered is a sharper, independently-reproduced
 * failure shape than a generic owner-attribution tag — a session can die
 * (auth expiry, crash) with the dialog still open, and a LATER carry-note can
 * mis-describe that as "the owner answered", which then hardens into an
 * owner directive over further compaction hops with no owner turn anywhere
 * in the chain to falsify it. Recognized by naming the tool whose answer is
 * being claimed (`AskUserQuestion`) or by "answered a/an/the dialog"
 * phrasing — deliberately NOT by any specific tag-subtype WORD (e.g. a
 * literal `dialog` token right after the owner separator), because that
 * word would itself be indistinguishable from a captured PERSON NAME to
 * check-no-owner-name-tags.mjs's `[owner:<name>]` scanner (WI-4419) — this
 * detector must never introduce a NEW `[owner:<word>]` shape of its own.
 */
const DIALOG_ANSWER_CLAIM_RE = /\bAskUserQuestion\b|\banswered\s+(?:a|an|the)\s+dialog\b/i;

/** Whether an owner-tag line specifically claims a DIALOG (AskUserQuestion) answer. */
function isDialogAnswerClaim(line: string): boolean {
  return DIALOG_ANSWER_CLAIM_RE.test(line);
}

/** Phrases that attribute a claim/imperative to the owner, or a bare "do not X
 *  until Y" gate/permission imperative — the two shapes EI-9091 found drifting
 *  (a block AND a permission can both be manufactured the same way). Kept to a
 *  short, high-precision set on purpose: a broad/fuzzy match would nudge on
 *  ordinary prose and train agents to ignore the warning. */
const OWNER_ATTRIBUTION_RE =
  /\b(?:the )?owner\s+(?:said|says|wants|needs|requires|required|approved|approves|told me|instructed|directed|asked|demands|set an? (?:explicit )?gate|gave permission)\b/i;

/** EI-23902378389781007: this describes the classifier's counterexample
 * ("an agent asserting the owner said it"); it does not attribute a directive
 * to the current writer.
 */
const OWNER_ATTRIBUTION_REPORTED_AGENT_MENTION_RE =
  /\b(?:a|an|the)\s+agent\s+asserting\s+(?:that\s+)?the\s+owner\s+(?:said|says|wants|needs|requires|required|approved|approves|told me|instructed|directed|asked|demands)\s+(?:it|this|that)\b/i;

function isOwnerAttributionReportedAgentMention(line: string): boolean {
  return OWNER_ATTRIBUTION_REPORTED_AGENT_MENTION_RE.test(line);
}

/**
 * EI-22787623747935751: OWNER_ATTRIBUTION_RE can begin at the `owner` suffix of
 * a peer-owned domain role — "Gate owner asked for ..." — and misclassify that
 * role's report as an attribution to the interactive human owner. Keep this
 * exclusion explicit and narrow: these are the role prefixes used for agent-owned
 * coordination artifacts, while an unqualified "the owner asked ..." remains loud.
 */
const PEER_ROLE_OWNER_PREFIX_RE = /\b(?:gate|fleet|plan|peer|work[-\s]?item)\s*$/i;

function isPeerRoleOwnerAttribution(line: string, match: RegExpExecArray): boolean {
  return match.index !== undefined && PEER_ROLE_OWNER_PREFIX_RE.test(line.slice(0, match.index));
}

/**
 * EI-21459558956325262 / WI-41690: OWNER_ATTRIBUTION_RE requires the literal token
 * `owner` IMMEDIATELY FOLLOWED BY a verb, so it only ever sees ACTIVE voice with the
 * generic noun — "the owner approved this". Two forms that assert exactly the same
 * authority slip past it, and both occur in the live corpus:
 *
 *   PASSIVE VOICE — "Approved by the owner", "DEFERRED by owner (D-004)". Here `owner`
 *   is followed by end-of-clause, never a verb. Passive is the natural register for a
 *   status line, which is precisely what a plan's `## Now` **State:** field is.
 *
 *   A PERSONAL NAME — "Approved by owner". Humans refer to a human by name, so the token
 *   `owner` never appears at all.
 *
 * Measured before writing this (running the linter over seven phrasings): the existing
 * regex caught 1 of 5 attribution forms. The motivating incident —
 * `llm-agent-evaluation-measurement-integrity-2026-08-25` opening its Now block with
 * "Approved by owner for direct AUTO implementation by this session", an agent-authored
 * line that no owner turn supports and that a later session quoted back as authority —
 * used a missed form. Wiring a new carry surface to the linter without this would have
 * shipped a guard blind to its own motivating case.
 *
 * PRECISION, which the block above rightly insists on. Calibrated against the real
 * corpus rather than guessed: this pattern flags 6 of 1,380 plan Now blocks (0.4%),
 * and those 6 are the true positives an independent census already identified. Two
 * rules keep it there — the attributed target must be either the literal `owner` or a
 * CAPITALISED token (a personal name), which alone excludes ordinary lowercase prose
 * like "approved by the release script"; and a denylist removes the capitalised
 * NON-HUMAN actors that legitimately approve things around here.
 */
const OWNER_ATTRIBUTION_PASSIVE_RE =
  /\b(?:approved|approves|deferred|defers|directed|directs|ratified|ratifies|authorized|authorizes|authorised|authorises|mandated|mandates|instructed|instructs|signed[-\s]off)\s+by\s+(?:the\s+)?([A-Za-z][\w'’-]*)/i;

/** Capitalised things that are NOT the owner but do approve/defer work here. */
const NON_HUMAN_ATTRIBUTION_TARGETS = new Set([
  'ci', 'cd', 'github', 'gitlab', 'postgres', 'papercusp', 'claude', 'codex', 'vitest',
  'jest', 'dbos', 'tauri', 'scheduler', 'gate', 'runner', 'operator', 'host', 'watchdog',
  'reaper', 'router', 'linter', 'release', 'checkpoint', 'pipeline', 'script', 'bot',
  'agent', 'fleet', 'leader', 'peer', 'reviewer', 'grader', 'consult', 'system', 'policy',
  'default', 'design', 'contract', 'mug', 'kettle', 'scout', 'blender', 'overwatch',
  'decision',
]);

/**
 * A passive-voice or name-based owner attribution — the forms OWNER_ATTRIBUTION_RE
 * structurally cannot see. Returns false for non-human approvers and for lowercase
 * common nouns, which is what holds the false-positive rate at the measured 0.4%.
 */
function isPassiveOwnerAttribution(line: string): boolean {
  const m = OWNER_ATTRIBUTION_PASSIVE_RE.exec(line);
  const target = m?.[1];
  if (!target) return false;
  if (NON_HUMAN_ATTRIBUTION_TARGETS.has(target.toLowerCase())) return false;
  // Either the generic owner noun, or something that looks like a personal name.
  return target.toLowerCase() === 'owner' || /^[A-Z]/.test(target);
}
/**
 * EI-19393929983792049: a bare NOUN-PHRASE attribution — "owner directive 1: …",
 * "Directive 2 (…): …" re-emitted from a loop goal, "owner mandate: …" — asserts the
 * exact same authority as a hand-written `[owner:…]` tag or an `OWNER_ATTRIBUTION_RE`
 * verb phrase, but slips past BOTH: it names no verb from that list ("directive" is a
 * noun, not "directed"), and it carries no `[owner:` bracket at all. Measured live: the
 * filer's own self-compaction turn wrote "start owner directive 1: the READ-ONLY P-011
 * audit … Directive 2 … comes after" — an AGENT-authored line asserting owner authority
 * that neither existing detector catches, so it re-emitted from every subsequent loop
 * wake with no nudge to tag or verify it. This convention ("owner directive <date>: …")
 * is also the repo's own standard citation form for a REAL owner directive (see e.g.
 * agent-insights/p2p-not-a-v1-target.md, RELEASE-RUNBOOK.md) — so flagging it here is
 * not a new restriction on real usage, it is applying P-014's existing rule (a manual
 * attribution asserts, only a turn ref proves) to a form the rule already covers in
 * spirit but the regex never matched syntactically.
 */
const OWNER_DIRECTIVE_NOUN_RE = /\bowner\s+(?:directive|mandate)s?\b/i;

/**
 * EI-22454606387399213: a provenance preamble can explicitly DENY owner
 * authority — "these constraints are NOT owner directives" — without carrying
 * one of the per-constraint downgrade tags that {@link isProvenanceWithdrawal}
 * requires. Treat only the copular denial as a disclaimer. A looser
 * "not ... owner directive" exemption would also hide real references such as
 * "do not ignore owner directive #9".
 *
 * This predicate only suppresses the noun-phrase attribution leg below. The
 * line still reaches the bare-gate-imperative detector, so a mixed line such as
 * "this is not an owner directive; do not deploy" remains actionable.
 */
const NEGATED_OWNER_DIRECTIVE_DISCLAIMER_RE =
  /\b(?:is|are|was|were)\s+(?:explicitly\s+)?(?:not|never)\s+(?:an?\s+)?owner\s+(?:directive|mandate)s?\b/i;

function isNegatedOwnerDirectiveDisclaimer(line: string): boolean {
  return NEGATED_OWNER_DIRECTIVE_DISCLAIMER_RE.test(line);
}

/**
 * A loop goal can refer to an already-recorded owner order as an object to execute,
 * rather than attributing the goal's own prose to the owner. Keep this exemption
 * deliberately structural: it requires an execution/honoring verb and a numeric
 * order id, so an unanchored assertion such as "owner directive 1: hold the deploy"
 * still trips the noun-phrase guard above. Allow the state adjective used in carry
 * prose ("honoring open owner directive #10") while keeping the durable order id as
 * the provenance-bearing reference; the goal is only saying which recorded order to
 * run (EI-21580390681737108, EI-21585358821019986).
 */
const RECORDED_OWNER_DIRECTIVE_EXECUTION_RE =
  /\b(?:execute|follow|carry\s+out|apply|honou?r(?:ing|ed)?)\s+(?:(?:the|an?)\s+)?(?:(?:open|current|existing|recorded)\s+)?owner\s+(?:directive|mandate)\s+(?:(?:order)\s+)?#?\d+\b/i;

function isRecordedOwnerDirectiveExecution(line: string): boolean {
  return RECORDED_OWNER_DIRECTIVE_EXECUTION_RE.test(line);
}

/**
 * EI-20234090473445932: a status/evidence sentence can mention a recorded owner
 * directive without asserting that the current writer received owner authority.
 * Keep this exclusion narrow: a numbered directive whose state is being reported,
 * or an explicitly checked/listed directive, is factual runtime evidence. An
 * imperative citation such as "owner directive 1: hold the deploy" still falls
 * through to OWNER_DIRECTIVE_NOUN_RE and remains a manual-owner-tag warning.
 */
const OWNER_DIRECTIVE_STATUS_REFERENCE_RE =
  /\b(?:owner\s+(?:directive|mandate)s?\s+#?\d+\s+(?:is|are|was|were|remains?|stays?|has\s+been|have\s+been)\s+(?:open|closed|pending|acknowledged|declined|resolved|completed|recorded)|(?:the\s+)?(?:open|closed|pending|current|existing|recorded)\s+owner\s+(?:directive|mandate)s?\b(?=[^.\n]*(?:is|are|was|were|remains?|stays?|checked|listed|returned|acknowledged|declined|resolved|completed|recorded|status|orders:list|tools:invoke)\b))/i;

function isOwnerDirectiveStatusReference(line: string): boolean {
  return OWNER_DIRECTIVE_STATUS_REFERENCE_RE.test(line);
}

/** Mirrors OWNER_TAG_MENTION_CONTEXT_RE's mention-vs-use distinction for the bracket
 *  tag, generalized to the noun phrase: a nearby word that reads as DOCUMENTING the
 *  convention ("never manufacture an owner directive", "the term owner directive")
 *  rather than ASSERTING one. Kept in the same short, high-precision spirit as the
 *  rest of this module — this repo's own compaction-strategy prose uses exactly this
 *  shape ("manufactures owner directives", "a claimed owner directive") when an agent
 *  quotes it into a carry note, and that quoting must not misread as a real claim. */
const OWNER_DIRECTIVE_MENTION_CONTEXT_RE =
  /(?:\bforms?\b|\bconventions?\b|\bpatterns?\b|\bsyntax\b|\bexamples?\b|\be\.g\.,?|->|\bmanufactur\w*|\bfabricat\w*|\bmint(?:ed|ing|s)?\b|\bcoin(?:ed|ing|s)?\b|\bthe\s+terms?\b|\bthe\s+phrases?\b|\bthe\s+notion\b|\bthe\s+concept\b|\bcall(?:ed|ing|s)?\b|\bclaimed\b)[^.\n]{0,40}\bowner\s+(?:directive|mandate)s?\b/i;

const BACKTICK_WRAPPED_OWNER_DIRECTIVE_RE = /`[^`\n]*\bowner\s+(?:directive|mandate)s?\b[^`\n]*`/i;

/** EI-23902378389781007: the noun matcher also sees quoted section anchors and code
 * field labels. Those are names being discussed, not owner-attributed directives:
 * a Markdown section heading is an identifier, while an identifier assignment such
 * as CarryBrief.directives = OWNER directives names a field concept. Keep these
 * structural exemptions narrow so the live directive forms below still lint.
 */
/** Diagnostic labels name a detector/control rather than a live instruction. */
const OWNER_DIRECTIVE_CLASSIFIER_LABEL_RE =
  /\bowner\s+(?:directive|mandate)s?\s+(?:control|test|fixture|matcher|detector|classification|label|pattern|case)\b/i;
const OWNER_DIRECTIVE_CLASSIFICATION_EXPLANATION_RE =
  /\bhow\b[^.\n]{0,60}\bbecomes?\s+(?:an?\s+)?owner\s+(?:directive|mandate)s?\b/i;

function isOwnerDirectiveNounClassifierMeta(line: string): boolean {
  return (
    OWNER_DIRECTIVE_CLASSIFIER_LABEL_RE.test(line) ||
    OWNER_DIRECTIVE_CLASSIFICATION_EXPLANATION_RE.test(line)
  );
}

const OWNER_DIRECTIVE_MARKDOWN_HEADING_MENTION_RE =
  /(?:^\s{0,3}#{1,6}\s*owner\s+(?:directive|mandate)s?\b|["']\s*#{1,6}\s*owner\s+(?:directive|mandate)s?\b[^"'\n]*["'])/i;
const OWNER_DIRECTIVE_FIELD_LABEL_RE =
  /\x60?\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+\x60?\s*=\s*OWNER\s+(?:directive|mandate)s?\b/;

/** Definite quoting — never flag, mirrors {@link isOwnerTagQuotedForm}. */
function isOwnerDirectiveNounQuotedForm(line: string): boolean {
  return (
    BACKTICK_WRAPPED_OWNER_DIRECTIVE_RE.test(line) ||
    OWNER_DIRECTIVE_MARKDOWN_HEADING_MENTION_RE.test(line)
  );
}

/** A code identifier assigned a capitalized provenance concept is a field label. */
function isOwnerDirectiveNounFieldLabel(line: string): boolean {
  return OWNER_DIRECTIVE_FIELD_LABEL_RE.test(line);
}

/** Ambiguous — likely documenting/comparing the convention, not asserting a directive. */
function isOwnerDirectiveNounPossibleMention(line: string): boolean {
  return OWNER_DIRECTIVE_MENTION_CONTEXT_RE.test(line);
}

/**
 * A "do not X until Y" match, but ONLY when it reads as an IMPERATIVE — no
 * expressed subject, the grammatical hallmark of a command — rather than a
 * DECLARATIVE description of some OTHER subject's behavior ("they do not
 * reorder until their lanes ship" is a measurement, not a directive). The
 * negative lookbehind requires "do not" NOT be immediately preceded (past any
 * intervening whitespace) by an alphanumeric character, i.e. by a word acting
 * as an explicit subject: a genuine imperative always opens a sentence/clause
 * (preceded only by punctuation, a list marker, a quote, or nothing at all).
 * EI-16031: found false-positiving on plain technical prose describing a
 * third party's ("they"/"it"/a system noun's) behavior with zero owner
 * attribution — the false alarm trains agents to dismiss the real ones.
 */
const BARE_GATE_IMPERATIVE_RE = /(?<![A-Za-z0-9]\s*)\bdo not\b.{0,80}\buntil\b/i;
const INLINE_CODE_SEGMENT_RE = /`([^`\n]*)`/g;

/**
 * A writer-backed gate status can be followed by a reader-safety instruction
 * without asserting owner authority. In particular, an inconclusive checkpoint
 * notification may be classified as a TIMEOUT (not a verdict), then explained
 * with "do not ... until release:trace ...". That interpretation is factual
 * evidence, not an unverified owner imperative; keep the exemption tied to the
 * known gate/status markers and the explicit timeout-vs-verdict classification
 * so ordinary bare gates remain loud (EI-21306957457076433).
 */
const FACTUAL_GATE_STATUS_RE = /\b(?:green-checkpoint:inconclusive|events:status|release:trace)\b/i;
const FACTUAL_TIMEOUT_CLASSIFICATION_RE =
  /\b(?:was|is|were|are|returned|reported|classified|marked)\s+(?:a\s+)?(?:TIMEOUT|TIMED[ -]OUT)\b[^.;\n]{0,80}\bnot\s+(?:a|an|the)\s+verdict\b[^.\n]{0,40}(?:[;.!?])\s*do not\b/i;

function isFactualTimeoutClassification(line: string): boolean {
  return FACTUAL_GATE_STATUS_RE.test(line) && FACTUAL_TIMEOUT_CLASSIFICATION_RE.test(line);
}

/**
 * EI-22739052265201730: a pause-transition carry note may tell the successor to
 * keep the loop parked until a RESUMPTION is owner-verified. This is a reader-
 * safety condition, not an assertion that the current writer received an owner
 * directive: the condition explicitly requires a later verification event.
 *
 * Keep the exemption narrow to the loop's two pause-boundary actions (`re-arm`
 * and `pull`) plus the explicit owner-verified resume condition. A generic
 * `do not X until Y` gate, including a deployment gate or an owner-approval
 * claim, must continue through the provenance nudge.
 */
const OWNER_VERIFIED_PAUSE_TRANSITION_GATE_RE =
  /\bdo\s+not\b[^.;\n]{0,100}\b(?:re-?arm|pull)\b[^.;\n]{0,100}\buntil\s+(?:an?\s+)?owner[-\s]verified\s+(?:resume|resumption)\s+(?:directive|cue|signal)\b/i;

function isOwnerVerifiedPauseTransitionGate(line: string): boolean {
  return OWNER_VERIFIED_PAUSE_TRANSITION_GATE_RE.test(line);
}

// EI-20246140574201628: a backtick-quoted gate is a cited phrase, not a new directive.
function isBareGateInsideInlineCode(line: string, match: RegExpExecArray): boolean {
  for (const segmentMatch of line.matchAll(INLINE_CODE_SEGMENT_RE)) {
    const segmentStart = (segmentMatch.index ?? 0) + 1;
    const segmentEnd = segmentStart + segmentMatch[1].length;
    if (match.index >= segmentStart && match.index + match[0].length <= segmentEnd) return true;
  }
  return false;
}

/**
 * EI-18226077402946717: a narrated cross-agent / cross-item COORDINATION side-effect
 * stated as already DONE — a communication/handoff or evidence-posting verb in PAST
 * tense (a claim of having performed it, NOT a plan to: a plan uses the base form
 * "post"/"message"/"comment" and is intentionally NOT matched) followed within a short
 * window by a COORDINATION TARGET (a work-item id, a peer session id, a post id, or a
 * named fleet role). This is the exact shape that, when fabricated, silently drops a
 * handoff: a WI-5137 checkpoint claimed "Posted full evidence to WI-5672 (posts
 * 53500-53501) ... Messaged fleet leader su-bce40c51 directly" — NEITHER left any
 * trace in the systems it named, and a successor (or the fleet leader via leader-brief)
 * trusting the narrated action believed evidence was shared / a peer notified when
 * neither occurred. Deliberately NARROW (a comm/post verb AND a coordination target)
 * so ordinary in-file progress prose ("refactored X", "added a test", "committed the
 * fix", "posted the results") never matches — the module's high-precision discipline
 * (a fuzzy match would nudge on routine prose and train agents to ignore the warning).
 * Cleared ONLY by a [turn:<session>@<ts>] ref (the whole line is skipped above): the
 * ONE valid completion anchor is the turn where the action's tool call actually
 * returned ok — the filer's recommendation, made mechanical.
 */
const UNVERIFIED_ACTION_CLAIM_RE =
  /\b(?:posted|messaged|commented|notified|pinged|dispatched|replied|escalated|sent|handed(?:\s+it)?\s+off|reached\s+out|wrote\s+to)\b[^\n]{0,60}?(?:\b(?:WI|EI|F)-\d|\bsu-[0-9a-f]{4}|\bposts?\s*\d|\bfleet\s+leader\b|\bthe\s+leader\b|\bthe\s+queen\b|\bthe\s+fleet\b|\bpeer\b|\bmsg[\s-])/i;

/**
 * A future/conditional verification plan can mention a past-tense action without
 * claiming that the writer performed it. For example, "Verify whether the subject
 * handed off ... WI-40537" is a question for the next wake, not a completed handoff
 * report. Keep this exemption tied to the same clause as `whether`/`if`; a direct
 * "I handed off ..." claim must continue to trip the action lint.
 */
const CONDITIONAL_ACTION_CLAUSE_RE = /\b(?:whether|if)\b[^.!?;\n]{0,120}$/i;

function isConditionalActionMention(line: string, match: RegExpExecArray): boolean {
  if (match.index === undefined) return false;
  const prefix = line.slice(0, match.index);
  const lastClauseBoundary = Math.max(
    prefix.lastIndexOf('.'),
    prefix.lastIndexOf('!'),
    prefix.lastIndexOf('?'),
    prefix.lastIndexOf(';'),
  );
  return CONDITIONAL_ACTION_CLAUSE_RE.test(prefix.slice(lastClauseBoundary + 1));
}

/**
 * P-014 (fleet-lead-instrumentation-audit-2026-08-09) — the THIRD-PARTY actor test.
 *
 * {@link UNVERIFIED_ACTION_CLAIM_RE} matches a comm verb plus a coordination target and
 * has no notion of WHO ACTED, so it cannot tell "I messaged the leader" from
 * "su-6dc49b99 replied about WI-37162". The first is the claim the lint exists to
 * police — the author asserting a side-effect only they could have produced. The second
 * is the author RECORDING A PEER'S REPORT, which is exactly the attribution discipline
 * this module asks for everywhere else; flagging it punishes compliance, and a lint that
 * fires on the correct behaviour is how a leg that catches a real class gets ignored.
 *
 * Matched against the text PRECEDING the verb on the same line, so the actor must sit
 * immediately before it (modulo a short closed set of adverbs/auxiliaries). A line that
 * OPENS with the verb — "Messaged fleet leader su-bce40c51 directly", the motivating
 * WI-5137 fabrication — has an implicit first-person subject and is still flagged.
 */
const THIRD_PARTY_ACTOR_RE =
  /\b(?:su-[0-9a-f]{4,}|they|he|she|a\s+peer|the\s+peer|another\s+agent|the\s+(?:fleet\s+)?leader|the\s+queen|the\s+owner)\b(?:\s+(?:has|had|have|just|already|then|also|apparently|reportedly|since))*\s+$/i;

/** Whether the matched action verb's own subject is someone OTHER than the author. */
function isPeerReportedAction(line: string): boolean {
  const m = UNVERIFIED_ACTION_CLAIM_RE.exec(line);
  if (!m || m.index === undefined) return false;
  return THIRD_PARTY_ACTOR_RE.test(line.slice(0, m.index));
}

/**
 * An explicit PROVENANCE-block header. An agent complies with the nudge by writing a block
 * like `PROVENANCE: the 'do not widen X until Y' constraint above is [self-imposed] by …` —
 * which necessarily RESTATES the imperative it is attributing so the reader knows WHICH one.
 * That restatement would otherwise re-trip BARE_GATE_IMPERATIVE_RE on the very line carrying
 * the attribution, so compliance could never clear the flag and the act of complying ADDED a
 * violation (EI-10994). When a write carries such an explicit block AND a source tag, we treat
 * its bare gate imperatives as attributed and stop nudging them. Owner-attribution phrases
 * (`the owner said X`) stay LINE-scoped and are never suppressed this way — a factual
 * owner-claim must not be laundered by an unrelated tagged block.
 */
/**
 * EI-19448526819046979 — the CAUSAL-MECHANISM claim class.
 *
 * WHY: every leg above polices WHO ORDERED something. This one polices a different
 * laundering path, traced end-to-end the day it was filed. A root-cause HYPOTHESIS
 * about what a named artifact does is compressed into a carry-note one-liner ("the
 * pc-heavy admission gate refuses a read-only pgrep on command TEXT"), rides N cold
 * wakes shedding its hedging (a carry-note has no room for "I think", and each re-read
 * resolves ambiguity toward the confident reading), and is then FILED as a bug with a
 * title, a severity and a named mechanism. FILING IS THE LAUNDERING STEP: a hedged note
 * is cheap and self-limiting; a filed work-item directs a peer's labour. In the
 * motivating incident the mechanism was invented — the named file contained ZERO
 * matches for the thing it was said to match on — and it cost a peer a full
 * investigation cycle before they challenged the premise.
 *
 * The affordance already existed and simply was not used: loop:checkpoint's `checks`
 * carries {claim, recheck, verified}, and `[inferred]` is already a {@link SOURCE_TAG_RE}
 * form. The filer's own note: "the affordance is not missing so much as unenforced at
 * the door where it matters."
 *
 * PRECISION — this module's standing rule is that a lint which fires on the correct
 * behaviour is how a leg that catches a real class gets ignored. So a match requires
 * ALL THREE of a behavioural verb, an explicit causal binder, and a NAMED artifact;
 * ordinary carry prose ("finished the refactor because the tests were red") names no
 * artifact and does not trip it. A line is cleared OUTRIGHT by an evidence marker or a
 * source tag — the compliant write is never punished — and a HEDGED claim is downgraded
 * rather than accused, exactly as 'peer-reported-action' downgrades correct attribution.
 */
/** DEFECT-shaped verbs only. Measured against 21,631 real carry-note lines, the neutral
 *  reporting verbs (returns / reports / matches / treats) carried ordinary status prose —
 *  "release:trace reports committedLocal=true" — and produced almost every false firing. */
const MECHANISM_VERB_RE =
  /\b(?:refuses?|rejects?|blocks?|drops?|ignores?|strips?|overwrites?|clobbers?|swallows?|truncates?|evicts?|reaps?|kills?|fails?|breaks?|skips?|silently\s+\w+|mis(?:reads?|reports?|matches?|handles?))\b/i;

/** An explicit CAUSAL binder. Bare "on" is excluded (it is overwhelmingly locative —
 *  "on WI-1234", "on the fleet"); only its mechanism-bearing form is accepted. */
const MECHANISM_BINDER_RE =
  /\b(?:because|due\s+to|owing\s+to|by\s+\w+ing)\b|\bon\s+(?:\w+\s+)?(?:text|name|string|pattern|argv|content|substring)\b/i;

/** A NAMED artifact: a backticked token, a tool verb (`group:verb`), a source path, or
 *  one of the closed set of machinery nouns a root-cause claim actually names.
 *
 *  The tool-verb branch requires >=3 LOWERCASE chars either side of the colon. A looser
 *  \w+:\w form matched clock times ("03:06Z") and every event key in a status line, which
 *  measured as the single largest false-firing source on real carry notes. The generic
 *  nouns (routine / pipeline / daemon / tool / verb) are likewise excluded: they are
 *  ordinary vocabulary here, not evidence that a specific artifact is being named. */
const MECHANISM_ARTIFACT_RE =
  /`[^`]+`|\b[a-z][a-z_]{2,}:[a-z][a-z_-]{2,}\b|\b[\w./-]+\.(?:ts|tsx|mjs|js|sh|sql)\b|\b(?:gate|lint|hook|guard|sweep|watchdog|reaper|router|resolver|matcher|parser|scheduler|governor)\b/i;

/** Honest hedging — the claim is offered AS a hypothesis. Downgraded, never silenced:
 *  hedging is what erodes across cold wakes, so the writer still gets the nudge to move
 *  it into `checks` with a probe attached. */
const MECHANISM_HEDGE_RE =
  /\b(?:likely|probably|possibly|apparently|presumably|seems?|appears?|suspect(?:ed)?|hypothesis|guess(?:ing)?|may\s+be|might\s+be|could\s+be|i\s+think|unverified|unconfirmed|untested|assum(?:e|ed|ing)|inferred?)\b/i;

/** The claim already travels with its probe or its result — compliance, cleared outright.
 *
 *  The backticked-command branch requires the command word to be followed by WHITESPACE,
 *  i.e. an actual invocation with arguments. Matching the bare word instead read a
 *  backticked ARTIFACT NAME as a probe — `git-sync` contains `git`, and a `\b` matches at
 *  the hyphen — silently clearing the very claims this leg exists to catch. Caught by the
 *  'backticked artifact' case in the sibling test before it shipped; keep the \s+.
 *
 *  A `file.ts:535` or `:41-49` citation also counts: naming the line you read IS the
 *  probe. Treating it otherwise flagged the most carefully-sourced notes in the measured
 *  corpus — the precise inversion this leg exists to avoid. */
const MECHANISM_EVIDENCE_RE =
  /\b(?:measured|verified|confirms?|confirmed|reproduced|re-?check(?:ed)?|positive\s+control|exit\s+code|observed|surfaced)\b|`[^`]*\b(?:grep|rg|git|npm|psql|sed|awk|node)\s+[^`]*`|\b[\w./-]+\.(?:ts|tsx|mjs|js|sh|sql):\d+|:\d+-\d+\b/i;

/** A question or a verification PLAN mentions a mechanism without asserting it — the
 *  same mention-vs-use split {@link isConditionalActionMention} makes for actions. */
const MECHANISM_QUESTION_RE =
  /\b(?:whether|why\s+does|does\s+the|verify|confirm\s+that|check\s+whether|find\s+out)\b/i;

/** Classify a line's causal-mechanism claim, or null when it makes none. */
function classifyMechanismClaim(
  line: string,
): 'unverified-mechanism-claim' | 'hedged-mechanism-claim' | null {
  if (!MECHANISM_VERB_RE.test(line)) return null;
  if (!MECHANISM_BINDER_RE.test(line)) return null;
  if (!MECHANISM_ARTIFACT_RE.test(line)) return null;
  if (MECHANISM_QUESTION_RE.test(line)) return null;
  if (MECHANISM_EVIDENCE_RE.test(line)) return null;
  if (SOURCE_TAG_RE.test(line)) return null;
  return MECHANISM_HEDGE_RE.test(line) ? 'hedged-mechanism-claim' : 'unverified-mechanism-claim';
}

/**
 * acceptance-runtime-plane-not-main-2026-09-23 P-005 — an UNPROBED dependency on the
 * release plane (main / :3070 / a deploy).
 *
 * The psu-pty plan's "needs main before R-3 can be graded" rode ~5 cold-wake carry notes
 * with no probe attached. The code in question ran in bg-host, which a deploy never
 * touches; one `dev:pipeline_position` read (servingRuntimes) would have killed the premise
 * on the first wake. A carried dependency on the release plane is exactly the kind of
 * claim that must travel WITH its probe, because "it is not on main yet" stays true for
 * hours while being irrelevant.
 *
 * Cleared by: a probe on the same line (re-check / pipeline_position / servingRuntimes /
 * state:read / measured …), a source tag, a hedge, a question — or ANY checks row in the
 * same write that probes the release plane (the write "attaches a checks probe").
 */
const DEPLOY_DEPENDENCY_RE =
  /\b(?:wait(?:ing|s)?\s+(?:on|for)|blocked\s+(?:on|by)|needs?|requires?|depends?\s+on|until|pending|gated\s+on|can'?t\s+\w+\s+(?:until|before|without))\b[^.\n]{0,50}?(?:\bgreen[- ]main\b|\bmain\b|:3070\b|\brelease:deployed\b|\bdeploy(?:ed|ment|s)?\b|\bthe\s+release\b)/i;

/** A probe of the release plane, on the line itself or on a checks row. */
const RELEASE_PLANE_PROBE_RE =
  /\bre-?check(?:ed)?\b|pipeline_position|servingRuntimes|state:read|\bprobe[ds]?\b|\/api\/health|\bmeasured\b|\bverified\b|\bconfirmed\b/i;

const RELEASE_PLANE_TARGET_RE = /\bgreen[- ]main\b|\bmain\b|:3070\b|\brelease:deployed\b|\bdeploy(?:ed|ment|s)?\b/i;

function classifyDeployDependency(line: string): 'unprobed-deploy-dependency' | null {
  if (!DEPLOY_DEPENDENCY_RE.test(line)) return null;
  if (RELEASE_PLANE_PROBE_RE.test(line)) return null;
  if (MECHANISM_QUESTION_RE.test(line)) return null;
  if (MECHANISM_HEDGE_RE.test(line)) return null;
  if (SOURCE_TAG_RE.test(line)) return null;
  // "does NOT need main" / "not blocked on the deploy" is the corrected premise, not the claim.
  if (/\b(?:not|no\s+longer|never|doesn'?t|don'?t|isn'?t|without)\b[^.\n]{0,30}?\b(?:wait|block|need|require|depend|gated)/i.test(line)) {
    return null;
  }
  return 'unprobed-deploy-dependency';
}

const PROVENANCE_BLOCK_MARKER_RE = /\bprovenance\b/i;

export interface ProvenanceLintMatch {
  /** The offending line, trimmed and capped for display (never the full body). */
  line: string;
  /** Which heuristic matched. 'quote-mismatch' is added asynchronously by
   *  carry-surface-provenance-stamp.ts (EI-12890): a `[turn:…]` ref resolves
   *  to a real, owner-typed turn, but the QUOTE attached to it does not
   *  appear in that turn's actual text — the exact guard-defeat where a
   *  resolvable ref reads as sufficient evidence but the claim was fabricated
   *  by splicing/paraphrasing. This module's own sync scan cannot detect it
   *  (that needs the transcript read the stamp already does); it exists here
   *  purely so the mismatch shows up in the SAME `flagged`/`matches` shape a
   *  consumer already checks, instead of a separate field nobody reads.
   *  'possible-owner-tag-mention' (EI-18672153930631150) is the DOWNGRADED
   *  sibling of 'manual-owner-tag': a `[owner:...]`-shaped token that reads as
   *  documentation/comparison of the tag convention itself (a placeholder name,
   *  a backtick-quoted form, or "form"/"convention"/"e.g." nearby) rather than
   *  an actual attribution — still surfaced (never silently dropped), but out
   *  of the loud category so that category keeps its high-precision meaning.
   *  'peer-reported-action' (P-014) is the same downgrade applied to the ACTOR
   *  rather than the tag: the comm verb's subject is a THIRD PARTY, so the line
   *  records a peer's action as a peer's action — attribution done right, not an
   *  unprovable claim about the author's own side-effects. Still second-hand and
   *  still surfaced; just not accused.
   *  'unverified-dialog-answer-claim' (EI-21918777703977266) is the SHARPER
   *  sibling of 'manual-owner-tag' for the one subtype independently
   *  reproduced as a real drift incident: a bare owner tag specifically
   *  claiming a DIALOG (AskUserQuestion) was answered. Never downgraded —
   *  it is louder than the generic tag, not softer. */
  kind:
    | 'owner-attribution'
    | 'bare-gate-imperative'
    | 'peer-reported-action'
    | 'manual-owner-tag'
    | 'unverified-dialog-answer-claim'
    | 'possible-owner-tag-mention'
    | 'quote-mismatch'
    | 'unresolved-turn-ref'
    | 'unverified-action-claim'
    | 'unverified-mechanism-claim'
    | 'hedged-mechanism-claim'
    | 'unprobed-deploy-dependency';
}

export interface ProvenanceLintResult {
  flagged: boolean;
  matches: ProvenanceLintMatch[];
}

const MAX_MATCH_LINES = 5;
const MATCH_LINE_CAP = 200;

/**
 * Scan `text` line-by-line for an owner-attributed imperative with no source tag
 * ON THAT SAME LINE. Line-scoped (not whole-body) deliberately: a tag elsewhere in
 * a long checkpoint must not mask an untagged imperative on a different line.
 * Pure, synchronous, side-effect-free — safe to call inline on every write.
 */
export function lintCarrySurfaceProvenance(text: string | null | undefined): ProvenanceLintResult {
  if (!text) return { flagged: false, matches: [] };
  const lines = text.split('\n');
  // EI-10994: an explicit, source-tagged PROVENANCE block means the writer HAS attributed
  // their gate imperatives, so complying with the nudge must CLEAR it — not add a second
  // violation on the block's own restatement of the imperative. Suppress bare-gate-imperative
  // matches for the whole write when such a block is present. Owner-attribution stays
  // line-scoped (below): an affirmative "the owner said X" is a factual claim a tagged block
  // must not launder, so it is still flagged per line.
  const hasTaggedProvenanceBlock =
    SOURCE_TAG_RE.test(text) && lines.some((l) => PROVENANCE_BLOCK_MARKER_RE.test(l));
  // P-005 (acceptance-runtime-plane): a checks row in this write that probes the release
  // plane attaches the probe to every release-plane dependency the write carries.
  const hasReleasePlaneProbe = lines.some(
    (l) => RELEASE_PLANE_TARGET_RE.test(l) && RELEASE_PLANE_PROBE_RE.test(l),
  );
  const matches: ProvenanceLintMatch[] = [];
  for (const rawLine of lines) {
    if (matches.length >= MAX_MATCH_LINES) break;
    const line = rawLine.trim();
    if (!line) continue;
    if (TURN_REF_LINE_RE.test(line)) continue; // turn-ref'd — mechanically verifiable (P-014):
    //   the ONE valid anchor for BOTH a directive AND a completed-action claim.
    // EI-18226077402946717: a narrated coordination side-effect stated as DONE with a
    // coordination target and no turn ref. Runs INDEPENDENTLY of the directive
    // source-tag chain below (a [self-imposed]/[peer:]/[inferred] tag attributes the
    // DIRECTIVE that ordered the action — it does not prove the action happened), so a
    // line can carry both a directive match and this one. Guarded against the cap.
    const actionClaim = UNVERIFIED_ACTION_CLAIM_RE.exec(line);
    if (actionClaim && !isConditionalActionMention(line, actionClaim)) {
      // P-014: same mention-vs-use split the owner-tag legs already make, applied to the
      // ACTOR. A peer's action recorded as a peer's action is attribution done right, so
      // it is DOWNGRADED rather than silenced — a reader still sees it is second-hand and
      // unverified, without being told they claimed something they cannot prove.
      matches.push({
        line: line.slice(0, MATCH_LINE_CAP),
        kind: isPeerReportedAction(line) ? 'peer-reported-action' : 'unverified-action-claim',
      });
      if (matches.length >= MAX_MATCH_LINES) continue;
    }
    // EI-19448526819046979: an asserted CAUSAL MECHANISM about a named artifact, carrying
    // no probe. Runs INDEPENDENTLY of the directive/action legs (a source tag attributes
    // the DIRECTIVE that ordered work; it says nothing about whether a mechanism claim was
    // ever measured), so a line can carry both this and a directive match. Capped like the
    // rest.
    const mechanismClaim = classifyMechanismClaim(line);
    if (mechanismClaim) {
      matches.push({ line: line.slice(0, MATCH_LINE_CAP), kind: mechanismClaim });
      if (matches.length >= MAX_MATCH_LINES) continue;
    }
    // P-005: an unprobed dependency on main/:3070/a deploy. Independent of every other leg.
    if (!hasReleasePlaneProbe) {
      const deployDependency = classifyDeployDependency(line);
      if (deployDependency) {
        matches.push({ line: line.slice(0, MATCH_LINE_CAP), kind: deployDependency });
        if (matches.length >= MAX_MATCH_LINES) continue;
      }
    }
    if (OWNER_TAG_RE.test(line)) {
      // EI-18672153930631150: a `[owner:...]`-shaped token that reads as
      // documentation of the convention, not an attribution, should not be
      // treated as an asserted directive.
      if (isOwnerTagQuotedForm(line)) continue; // definite quoting — never flag
      // EI-19461711239876849: a line RETRACTING an owner attribution is the compliance
      // this convention asks for, not a violation of it — never nudge it.
      if (isProvenanceWithdrawal(line)) continue;
      if (isOwnerTagPossibleMention(line)) {
        matches.push({ line: line.slice(0, MATCH_LINE_CAP), kind: 'possible-owner-tag-mention' });
        continue;
      }
      // P-014: a bare [owner:…] tag no longer clears the line — it asserts an
      // owner directive without a verifiable anchor. Nudge for a [turn:…] ref.
      // EI-21918777703977266: a tag specifically claiming a DIALOG (AskUserQuestion)
      // answer gets the sharper, incident-specific note — this exact shape has
      // already manufactured a false owner directive from a session that died
      // with the dialog still open.
      matches.push({
        line: line.slice(0, MATCH_LINE_CAP),
        kind: isDialogAnswerClaim(line) ? 'unverified-dialog-answer-claim' : 'manual-owner-tag',
      });
      continue;
    }
    if (SOURCE_TAG_RE.test(line)) continue; // [self-imposed]/[peer:]/[inferred] — not owner-authority
    const ownerAttributionMatch = OWNER_ATTRIBUTION_RE.exec(line);
    if (
      (ownerAttributionMatch &&
        !isPeerRoleOwnerAttribution(line, ownerAttributionMatch) &&
        !isOwnerAttributionReportedAgentMention(line)) ||
      isPassiveOwnerAttribution(line)
    ) {
      matches.push({ line: line.slice(0, MATCH_LINE_CAP), kind: 'owner-attribution' });
      continue;
    }
    if (OWNER_DIRECTIVE_NOUN_RE.test(line) && !isNegatedOwnerDirectiveDisclaimer(line)) {
      // EI-21580390681737108: `Execute owner directive order 10` names a recorded
      // directive as the object of an execution command. It is not an owner-attributed
      // assertion, so do not reject a loop goal that uses this durable reference.
      if (isRecordedOwnerDirectiveExecution(line)) continue;
      // EI-20234090473445932: factual status/runtime evidence about a recorded
      // directive is not an assertion of owner authority by the current writer.
      if (isOwnerDirectiveStatusReference(line)) continue;
      // EI-19393929983792049: same mention-vs-use split as the bracket tag above,
      // generalized to the noun phrase.
      if (isOwnerDirectiveNounQuotedForm(line)) continue; // definite quoting — never flag
      if (isOwnerDirectiveNounFieldLabel(line)) continue; // code field name, not attribution
      if (isOwnerDirectiveNounClassifierMeta(line)) continue; // documented detector category
      // EI-19461711239876849: same retraction carve-out as the bracket tag above — the
      // noun form is what a retraction of a noun-form assertion ("this is [self-imposed],
      // NOT an owner directive") is necessarily written in.
      if (isProvenanceWithdrawal(line)) continue;
      if (isOwnerDirectiveNounPossibleMention(line)) {
        matches.push({ line: line.slice(0, MATCH_LINE_CAP), kind: 'possible-owner-tag-mention' });
        continue;
      }
      // Same treatment as a bare [owner:…] tag: it asserts owner authority with no
      // verifiable anchor, so it gets the SAME kind (and the SAME P-005 owner-typed-
      // turn auto-verify path when the line's own date matches today's turn).
      matches.push({ line: line.slice(0, MATCH_LINE_CAP), kind: 'manual-owner-tag' });
      continue;
    }
    const bareGateMatch = BARE_GATE_IMPERATIVE_RE.exec(line);
    if (
      !hasTaggedProvenanceBlock &&
      bareGateMatch &&
      !isBareGateInsideInlineCode(line, bareGateMatch) &&
      !isFactualTimeoutClassification(line) &&
      !isOwnerVerifiedPauseTransitionGate(line)
    ) {
      matches.push({ line: line.slice(0, MATCH_LINE_CAP), kind: 'bare-gate-imperative' });
    }
  }
  return { flagged: matches.length > 0, matches };
}

/** The source instruction that keeps agents from constructing a plausible-looking
 *  ref out of a wake-pump nonce or an adjacent timestamp. */
export const TURN_REF_SOURCE_GUIDANCE =
  'For an already-recorded turn, copy the exact `turnProvenance.writtenDuring.ref` value from a recent tool response; ' +
  'do NOT construct a ref from a wake-pump nonce or any adjacent-looking timestamp.';

/** The advisory note a consumer tool folds into its response when flagged. */
export const PROVENANCE_LINT_NOTE =
  'provenance_lint: this carry-surface write contains an owner-attributed directive and/or a claimed COMPLETED ' +
  'action (e.g. "posted evidence to WI-####", "messaged the fleet leader su-…") with no verifiable turn ref. ' +
  'Anchor each to the turn where it ACTUALLY happened with [turn:<session>@<iso-ts>] (the system verifies it ' +
  'against your own transcript and stamps owner-vs-agent origin — P-014). For the turn you are writing FROM, ' +
  'write the sentinel [turn:self] and the platform expands it to the real ref at write time — do NOT hand-guess ' +
  'a timestamp: no field in any wake, orient, or tool result states your current turn ts, so the adjacent-looking ' +
  `ones are all subtly wrong and store an anchor that resolves to nothing (EI-19425644478222007). ${TURN_REF_SOURCE_GUIDANCE} ` +
  'A hand-written [owner:…] tag alone ' +
  'asserts but does not prove. A checkpoint that NARRATES an action ("I did X") is only valid AFTER X\'s tool ' +
  'call returned ok in the SAME turn — a specific artifact id (post/msg/WI ref) is NOT proof it happened ' +
  '(they can be fabricated, EI-18226077402946717), so a downstream reader must independently verify it, never ' +
  'trust it as evidence-of-action. Non-owner sources still tag [self-imposed] · [peer:<sid>] · [inferred]. ' +
  "Verify a remembered directive or action via sessions:search { session:'self', mode:'verbatim' }. " +
  'See WI-3532 / EI-9091 / EI-18226077402946717.';

/**
 * EI-21918777703977266: the sharper note for a bare `[owner:…]` tag that claims a
 * DIALOG (AskUserQuestion) was answered. Unlike the generic directive-anchoring
 * advice above, this names the exact reproduced failure — a session dying (auth
 * expiry / crash) with the dialog still open, then a later carry-note describing
 * that as an owner answer — because a reader who has seen the generic note fail
 * to prevent this exact incident needs the sharper, cited version, not a repeat
 * of the same words that already got waved off as a formatting nag.
 */
export const PROVENANCE_LINT_DIALOG_NOTE =
  'provenance_lint: this line claims the OWNER answered a DIALOG (AskUserQuestion) with a bare [owner:…] tag and ' +
  'no verifiable turn ref. This exact shape has already manufactured a false owner directive (EI-21918777703977266): ' +
  'a session died with the dialog still unanswered, and a LATER carry-note asserted it had been answered — ' +
  're-tagging the claim (without verifying it) is what let it survive further compaction hops undetected. Before ' +
  "restating this, verify with sessions:search { session:'self', mode:'verbatim', query:'<the claimed answer text>' } " +
  "that a REAL owner-typed turn (provenance verdict 'owner-typed' or 'owner-dialog', never 'agent-injected') " +
  `actually answered it. If verified, ${TURN_REF_SOURCE_GUIDANCE} If NOT, write "UNANSWERED DIALOG: ` +
  '<question>" instead of an owner tag. See WI-3532 / EI-9091 / EI-21918777703977266.';

/**
 * The kinds that are SURFACED but not ACCUSED — a mention of the tag convention rather
 * than an attribution, or an action attributed to a peer rather than claimed as one's
 * own. Kept as data (not a boolean on each match) so the note selection below cannot
 * disagree with the kind a consumer reads.
 */
const DOWNGRADED_KINDS: ReadonlySet<ProvenanceLintMatch['kind']> = new Set([
  'possible-owner-tag-mention',
  'peer-reported-action',
  // EI-19448526819046979: a HEDGED mechanism claim is the author offering a hypothesis AS a
  // hypothesis — the discipline this module asks for. Surfaced (the hedge is exactly what
  // erodes across cold wakes) but never in the loud category.
  'hedged-mechanism-claim',
]);

/** The mechanism-claim class ({@link classifyMechanismClaim}), loud and downgraded alike. */
const MECHANISM_KINDS: ReadonlySet<ProvenanceLintMatch['kind']> = new Set([
  'unverified-mechanism-claim',
  'hedged-mechanism-claim',
]);

/** P-005 (acceptance-runtime-plane): the release-plane dependency class. */
const DEPLOY_DEPENDENCY_KINDS: ReadonlySet<ProvenanceLintMatch['kind']> = new Set(['unprobed-deploy-dependency']);

export const PROVENANCE_LINT_DEPLOY_DEPENDENCY_NOTE =
  'provenance_lint: this carry-surface write says work is waiting on / blocked by main, :3070 or a deploy, with ' +
  'no probe attached. "Not on main yet" stays TRUE for hours while being IRRELEVANT: most code on this box also ' +
  'runs on runtimes a deploy never touches (bg-host, the staging operator, psu pty hosts), and acceptance is ' +
  'measured where the code runs. Attach the probe — loop:checkpoint checks:[{ claim, recheck: "dev:pipeline_position ' +
  '{ path } → servingRuntimes" }] — or re-read servingRuntimes now: if the runtime your bar is about already ' +
  'contains the change, the dependency is false and the wait should be dropped. (acceptance-runtime-plane-not-main-2026-09-23)';

/**
 * EI-20745229385305334 — the kinds that read as a STANDING INSTRUCTION rather than as
 * narrative: an imperative a successor will ACT ON, not merely believe. Kept here beside
 * the other kind sets so exactly one place owns "which kinds are directives"; a second
 * copy in a consuming tool is the drift this file's own classification exists to prevent.
 *
 * The distinction is what makes preserve-by-default asymmetric. Stale prose is merely
 * noise, but a stale imperative is OBEYED — and it reads more urgently than the prose that
 * retracted it, because it is phrased as an order and the retraction is phrased as a
 * report. Only the two instruction-shaped kinds qualify: a mechanism claim or a tag
 * mention is something a reader may wrongly believe, never something they execute.
 */
const DIRECTIVE_KINDS: ReadonlySet<ProvenanceLintMatch['kind']> = new Set([
  'bare-gate-imperative',
  'owner-attribution',
]);

/**
 * The directive-class matches among `matches` — the subset whose survival past a
 * retraction is actionably harmful rather than untidy. Returns `[]` for the clean case
 * (and for a lint result that flagged only non-directive kinds), so a caller can treat a
 * non-empty result as "an instruction is present here".
 */
export function directiveMatches(
  matches: readonly ProvenanceLintMatch[] | null | undefined,
): ProvenanceLintMatch[] {
  return (matches ?? []).filter((m) => DIRECTIVE_KINDS.has(m.kind));
}

/**
 * EI-19448526819046979 — the note for a write whose matches are ALL mechanism-class. The
 * main note is about anchoring a DIRECTIVE or a completed ACTION to a turn ref, which is
 * the wrong remedy here: nothing was ordered and nothing was done, a cause was GUESSED.
 */
export const PROVENANCE_LINT_MECHANISM_NOTE =
  'provenance_lint: this carry-surface write asserts a CAUSAL MECHANISM about a named artifact ' +
  '(e.g. "the X gate refuses Y by matching Z") carrying no probe, hedge or source tag. A ' +
  'root-cause hypothesis compressed into a carry-note sheds its hedging across cold wakes and ' +
  'arrives reading like an observation — and FILING is the laundering step, because a filed ' +
  'work-item has a title, a severity and an assignee, so it directs a peer\'s labour. Either ' +
  "(a) carry it in loop:checkpoint's `checks` as {claim, recheck} so the probe travels with the " +
  'claim, (b) tag it [inferred] until re-probed, or (c) record the OBSERVATION you actually made ' +
  'rather than the mechanism you inferred — the observation is true and leads to the real cause; ' +
  'the mechanism is the part that gets invented. See EI-19448526819046979.';

/**
 * P-014 — the note for a write whose matches are ALL downgraded. The main note opens
 * with "contains an owner-attributed directive and/or a claimed COMPLETED action … with
 * no verifiable turn ref", which is simply FALSE of such a write, and being told to
 * anchor a peer's reported action to a turn of your own is impossible advice. A lint
 * that misdescribes the compliant case is how the whole leg gets tuned out.
 */
export const PROVENANCE_LINT_DOWNGRADED_NOTE =
  'provenance_lint (FYI — nothing to fix): every match on this write is a DOWNGRADED kind. Either a ' +
  '[owner:…]-shaped token used to DESCRIBE the convention rather than to attribute a directive, or an ' +
  'action whose subject is a PEER ("su-… replied about WI-…") — i.e. a peer\'s claim recorded AS a ' +
  "peer's claim, which is the attribution discipline this lint asks for, not a violation of it. Surfaced " +
  'so a reader treats the line as second-hand and unverified; no [turn:…] ref of your own is required (and ' +
  'for a peer\'s action you could not supply one). See the `matches[].kind` for which line is which.';

/** Convenience: build the `{ flagged, note?, matches? }` shape every consumer
 *  tool folds into its JSON response — `undefined` fields when clean, so a clean
 *  write's response shape is unchanged (no `provenanceLint: { flagged: false }`
 *  noise on the overwhelming common case). */
export function provenanceLintField(text: string | null | undefined):
  | { flagged: true; note: string; matches: ProvenanceLintMatch[] }
  | undefined {
  const result = lintCarrySurfaceProvenance(text);
  if (!result.flagged) return undefined;
  // EI-21918777703977266: the sharper, incident-specific dialog note takes priority
  // over both other notes whenever it applies — it is the LOUDEST kind (never
  // downgraded), so its presence alone means "not clean" regardless of what else
  // matched, and its specificity is exactly the point of adding it.
  const hasDialogClaim = result.matches.some((m) => m.kind === 'unverified-dialog-answer-claim');
  if (hasDialogClaim) {
    return { flagged: true, note: PROVENANCE_LINT_DIALOG_NOTE, matches: result.matches };
  }
  // A single LOUD match makes the write accusable, so the softer note applies only when
  // EVERY match is downgraded — never let one real violation ride in under the FYI.
  // EI-19448526819046979: the mechanism note applies only when EVERY match is
  // mechanism-class. A mixed write (a real directive/action violation alongside a
  // mechanism claim) falls through to the existing selection unchanged, so this leg
  // cannot mask a louder, older class.
  if (result.matches.length > 0 && result.matches.every((m) => MECHANISM_KINDS.has(m.kind))) {
    return { flagged: true, note: PROVENANCE_LINT_MECHANISM_NOTE, matches: result.matches };
  }
  // P-005: same all-of-one-class rule — a mixed write keeps the louder, older note.
  if (result.matches.length > 0 && result.matches.every((m) => DEPLOY_DEPENDENCY_KINDS.has(m.kind))) {
    return { flagged: true, note: PROVENANCE_LINT_DEPLOY_DEPENDENCY_NOTE, matches: result.matches };
  }
  const allDowngraded = result.matches.every((m) => DOWNGRADED_KINDS.has(m.kind));
  return {
    flagged: true,
    note: allDowngraded ? PROVENANCE_LINT_DOWNGRADED_NOTE : PROVENANCE_LINT_NOTE,
    matches: result.matches,
  };
}
