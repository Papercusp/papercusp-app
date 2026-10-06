/**
 * premises-claim-port.ts — surface the load-bearing PREMISES a work-item's own
 * text rests on at CLAIM time (false-premise-in-prescriptive-artifacts-2026-08-02
 * P-001).
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────
 *
 * A work-item body is a PRESCRIPTIVE artifact: it tells a claimant what to
 * build. Its prescription usually rests on a premise about the codebase — and
 * that premise is stated in the author's own confident voice, indistinguishable
 * from a checked fact. A claimant reads the prescription and builds. If the
 * premise was false, the work is wasted before the first line is written, and
 * nothing in the artifact said the premise was ever unverified.
 *
 * Root incident (WI-7042, the item this plan was filed from): the body asserted
 * "there is no exported read helper for `harness_shared.p2p_work_offers`" and
 * prescribed writing a new PG read module on it. FALSE — `offer-store.ts`
 * exports `getWorkOffer` + `listOffers`. The premise came from grepping
 * `projections/work-offers.ts`, the receive/apply leg. The error was SCOPE OF
 * INFERENCE, not method: a real search, over the wrong scope, reported as an
 * absolute absence. Catching it deleted the prescribed module before it was
 * written.
 *
 * ── WHY ABSENCE CLAIMS SPECIFICALLY ─────────────────────────────────────────
 *
 * The asymmetry is what makes this cheap. An absence claim ("there is no X") is
 * EXPENSIVE to act on — you build X — and CHEAP to falsify — one search. No
 * other premise shape has that ratio, which is why this port keys on absence
 * rather than trying to detect wrong premises in general.
 *
 * ── WHY THE CLAIM EVENT IS THE PRODUCER ─────────────────────────────────────
 *
 * The predecessor plan's D-001 (agent-epistemics-2026-08-02) retired a drafted
 * dispute detector that fired ZERO times in 14 days, and recorded the rule: key
 * onto a substrate whose producer ALREADY EXISTS. The claim event is one — it
 * fires on every claim, at exactly the moment before the cost is paid, and it
 * already carries sibling hints (the checkpoint hint, the prior-work hint, the
 * memory recall, the plan-decisions brief) attached at this same seam.
 *
 * Crucially this needs NO new authoring behaviour. WI-7042's author BELIEVED the
 * premise; a "declare your premises" field would have been filled in with the
 * false premise stated just as confidently, or left empty. So the premises are
 * DERIVED from the text the author already wrote. A declared premise (below)
 * still wins where present — but nothing depends on anyone declaring one.
 *
 * ── MEASURED, NOT ASSUMED (D-001 of this plan) ──────────────────────────────
 *
 * The governing decision says a prescriptive artifact must VERIFY its
 * prescription before emitting it. This module is itself such an artifact, so
 * the detector was measured against the real corpus before being wired in
 * (harness `papercusp`, 31,090 work-item bodies, 2026-08-02):
 *
 *   - 1,442 bodies (4.6%) carry an absence-shaped claim — it fires on roughly
 *     1 claim in 22, not on everything. A detector that fires on most claims is
 *     noise, and this one measurably does not.
 *   - 1,431 of those 1,442 are in SUBSTANTIAL bodies (>200 chars), i.e. the
 *     class concentrates in real prescriptions rather than one-line stubs.
 *   - Hand-read precision sample of substantial recent hits: the dominant FALSE
 *     POSITIVE is an absence phrase inside QUOTED TOOL OUTPUT — WI-7132's only
 *     hit is entirely within a backticked `column "payload" does not exist`
 *     error string. That single measurement is why {@link stripNonProse} exists
 *     and runs first; without it the detector would fire hardest on pasted
 *     error messages, which are evidence, not premises.
 *
 * ── D-001 COMPLIANCE ────────────────────────────────────────────────────────
 *
 * (a) A refutation REPLACES the prescription, never annotates it. A DECLARED
 *     premise carrying evidence (`verified`) REPLACES the derived row for the
 *     same claim rather than sitting beside it — "here is a premise, and also
 *     it might be wrong" invites acting on it anyway.
 * (b) FAIL OPEN on every uncertainty. Every failure path returns null: this is
 *     decoration on a claim, never a new way for a claim to fail, and never a
 *     block. Ambiguity yields silence, not a false alarm.
 * (c) NAME THE REAL ANSWER, not just the refusal. Each derived premise carries
 *     a concrete `recheck` naming the SCOPE the search must cover — because
 *     scope of inference, not method, is the measured failure mode.
 */
import { type CheckEntry, renderCheckLine } from './carry-note';
import { planSlugOfWorkItem } from './scheduler/claim-spec-match';
import type { WorkItem } from './work-items';
import { ANY_FAMILY_TERMINAL_STATES } from './work-item-dispatch-states';
import { detectBodyRefs, type HydratableRef } from './agent-tools/coordination/ref-hydrate';
import { getPlanRow } from './agent-tools/plans/source';
import { parsePlan } from './agent-tools/plans/parser';

/** Where a premise was found. A plan-item premise governs every work-item
 *  promoted from it, so it is worth naming separately from the item's own body. */
/**
 * Where an absence premise was authored.
 *
 * `carry-note` (outage-must-not-be-silent-2026-08-02 P-009) covers the CARRY surfaces —
 * a `loop:checkpoint` note is a prescriptive artifact aimed at the author's OWN next wake
 * (and at a cold successor, whose only memory it is), so it has the same
 * confident-voice-indistinguishable-from-checked-fact problem as a work-item body, with
 * one extra turn of the screw: nobody else ever reviews it.
 *
 * Measured on this session, 2026-08-03 — the incident that added this source. A wake
 * checkpointed "the ledger is written ... and read by NOBODY" as settled fact. The next
 * wake read it back as fact and shipped ~180 lines on it. A reader existed
 * (`system-health/mcp-proxy-health.ts`), one reverse-grep away, and the shipped duplicate
 * also over-counted by ~18% because it lacked filters the real reader had. Retracted as
 * D-005 of that plan. The claim-time port could not have caught it: no claim event was
 * involved at any point.
 */
export type PremiseSource = 'work-item' | 'plan-item' | 'carry-note';

export interface DerivedPremise extends CheckEntry {
  /** Only 'absence' today — the shape with the payoff asymmetry. Kept explicit so
   *  P-002's absence-specific strictness has something to key on rather than
   *  re-deriving the classification. */
  kind: 'absence';
  source: PremiseSource;
}

export interface ClaimTimePremisesBrief {
  /** Rows in the shared {@link CheckEntry} shape — the SAME primitive
   *  work_items:checkpoint / loop:checkpoint already carry, so a claimant reads
   *  one row format everywhere. */
  premises: CheckEntry[];
  /** Pre-rendered `✓`/`?` lines (renderCheckLine), so a caller inlines them
   *  without re-deriving the badge convention. */
  rendered: string[];
  total: number;
  unverified: number;
  /** The leading directive. Frames the item as a HYPOTHESIS — see D-001 (a). */
  note: string;
}

/** Bound on premises attached to a claim payload — past a handful this is a
 *  poorly-scoped item, not a brief worth growing. */
const MAX_PREMISES = 4;
/** Bound on a single rendered claim sentence. */
const CLAIM_CHARS = 220;

/**
 * EI-18733326519945478 — the high-precision sibling of the absence-premise detector.
 *
 * The first proposed dispatch guard ("item is older than seven days") matched 17,205 of
 * 26,920 open rows (64%); the second ("cites any terminal item") matched 5,140 aged rows
 * (30%). Both are warnings agents would learn to ignore. The actual incident was narrower:
 * EI-10203 cited WI-4329, whose own terminal evidence explicitly says the premise was wrong.
 *
 * Measured against the live papercusp corpus on 2026-08-13, this semantic matched 13 of
 * 26,927 open items (0.048%). The age gate changed none of the matches, so age is not used as
 * a proxy: the referenced item's terminal evidence is the signal. These phrases are the
 * observed completion vocabulary, deliberately NOT a generic "terminal" check.
 */
export const INVALIDATED_PREMISE_COMPLETION_RE =
  /\b(?:wrong[- ]premise|invalid premise|false[- ]premise|falsified premise|premise (?:was |is )?(?:false|falsified))\b/i;

/** Bound claim-time reference IO. `detectBodyRefs` is the same parser coord hydration uses. */
export const MAX_PREMISE_CITATION_REFS = 8;

export type PremiseCitationProbe = (
  id: string,
) => Promise<Pick<WorkItem, 'id' | 'state' | 'terminalCompletionRef'> | null>;

const defaultPremiseCitationProbe: PremiseCitationProbe = async (id) => {
  // Dynamic for the same reason the claim surfaces dynamically import THIS module:
  // claim decoration must not pull the work-items store back through a static cycle.
  const { getWorkItem } = await import('./work-items');
  return getWorkItem(id);
};

function completionExcerpt(text: string, max = 150): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

/**
 * Resolve work-item ids cited in a prescriptive body and turn only explicit
 * wrong/false-premise terminal evidence into claim-time rechecks.
 *
 * Fail-soft by construction: an unresolved ref, non-terminal row, ordinary completion, or
 * probe failure emits nothing. A citation may be DISCUSSING the invalidation rather than
 * depending on it, so the result is an advisory recheck, never a refusal or an accusation.
 */
export async function invalidatedPremiseCitationChecks(
  text: string | null | undefined,
  opts: { selfId?: string | null; probe?: PremiseCitationProbe; max?: number } = {},
): Promise<CheckEntry[]> {
  const body = (text ?? '').trim();
  if (!body) return [];

  const requestedMax = opts.max ?? MAX_PREMISE_CITATION_REFS;
  const maxRefs = Number.isFinite(requestedMax) ? Math.max(0, Math.floor(requestedMax)) : MAX_PREMISE_CITATION_REFS;
  if (maxRefs === 0) return [];

  let ids: string[];
  try {
    // A body's own id is common provenance, not a dependency. Parse one spare ref
    // when self-filtering so it cannot consume the bounded probe budget and hide the
    // first real citation (the EI-10203 -> WI-4329 incident shape).
    ids = detectBodyRefs(body, maxRefs + (opts.selfId ? 1 : 0))
      .filter((ref): ref is Extract<HydratableRef, { kind: 'work-item' }> => ref.kind === 'work-item')
      .map((ref) => ref.id)
      .filter((id) => id.toUpperCase() !== (opts.selfId ?? '').toUpperCase())
      .slice(0, maxRefs);
  } catch {
    return [];
  }
  if (ids.length === 0) return [];

  const probe = opts.probe ?? defaultPremiseCitationProbe;
  const rows = await Promise.all(
    ids.map(async (id): Promise<CheckEntry | null> => {
      try {
        const cited = await probe(id);
        const evidence = cited?.terminalCompletionRef?.trim() ?? '';
        if (
          !cited ||
          !ANY_FAMILY_TERMINAL_STATES.includes(cited.state) ||
          !INVALIDATED_PREMISE_COMPLETION_RE.test(evidence)
        ) {
          return null;
        }
        return {
          claim:
            `${cited.id} is ${cited.state}; its terminal evidence explicitly says its premise was invalid: ` +
            `"${completionExcerpt(evidence)}"`,
          recheck:
            `Re-read ${cited.id}'s terminal evidence before building. This item may already be documenting that ` +
            `invalidation; if so, confirm the proposed work no longer depends on it. Otherwise correct or drop ` +
            `this item before implementation.`,
        };
      } catch {
        return null;
      }
    }),
  );
  return rows.filter((row): row is CheckEntry => row !== null);
}

/**
 * Strip the spans of a body that are QUOTED MATERIAL rather than the author's
 * own assertions: fenced code blocks and inline code spans.
 *
 * ⚠ THIS IS THE MEASURED FALSE-POSITIVE FIX, not a stylistic nicety. In the
 * precision sample, the single clearest false positive (WI-7132) matched
 * entirely inside a backticked error message — `column "payload" does not
 * exist`. A pasted error string is EVIDENCE the author gathered; treating it as
 * the author's own absence claim inverts its meaning and would make the
 * detector fire hardest on the best-evidenced items.
 *
 * Replaces with spaces rather than deleting so sentence boundaries survive and a
 * stripped span cannot glue two unrelated clauses into a phantom match.
 */
export function stripNonProse(text: string): string {
  return (text ?? '')
    .replace(/```[\s\S]*?```/g, (m) => ' '.repeat(m.length))
    .replace(/`[^`\n]*`/g, (m) => ' '.repeat(m.length));
}

/**
 * P-014 — recover the ORIGINAL text of a span the detector matched in redacted prose.
 *
 * Detection deliberately runs over {@link stripNonProse}'d text so a PASTED error
 * string is never read as the author's own assertion. But the lint then QUOTED that
 * redacted text back, so backticked identifiers had been blanked out of the sentence
 * it echoed — producing the incoherent `"note there is NO column and NO top-level —
 * the id column is )"` this fixes, complete with a recheck telling the reader to grep
 * for that string. Stripping is right for DECIDING; it is wrong for QUOTING.
 *
 * Safe because the redaction is LENGTH-PRESERVING, so one offset pair indexes both
 * strings — and self-checked, not assumed: re-redacting the recovered span must
 * reproduce the redacted span. Should a future strip rule stop preserving length,
 * this silently falls back to today's behaviour instead of quoting a mis-sliced
 * sentence, which is the one outcome worse than the bug.
 */
function originalSpan(original: string, redacted: string, start: number, end: number): string {
  const redactedSpan = redacted.slice(start, end);
  const raw = original.slice(start, end);
  return stripNonProse(raw) === redactedSpan ? raw : redactedSpan;
}

/** Trim a matched sentence to a bounded, readable claim. */
function clampClaim(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > CLAIM_CHARS ? `${t.slice(0, CLAIM_CHARS - 1)}…` : t;
}

/**
 * The absence patterns. Each captures the SUBJECT of the absence, so the
 * generated `recheck` can name what to search for instead of saying "verify
 * this" — D-001 (c).
 *
 * Bounded character classes throughout (no nested quantifiers over `.*`) so a
 * pathological body cannot cause catastrophic backtracking on the claim path.
 */
const ABSENCE_PATTERNS: ReadonlyArray<{ re: RegExp; subject: (m: RegExpMatchArray) => string }> = [
  { re: /\bthere (?:is|are|was|were) no ([^.;\n]{3,120})/gi, subject: (m) => m[1] },
  { re: /\bno such ([^.;\n]{3,120})/gi, subject: (m) => m[1] },
  { re: /\b([A-Za-z_][\w.$:/-]{1,60}) (?:does|do|did) not exist\b/gi, subject: (m) => m[1] },
  {
    re: /\bnothing (?:currently |ever )?(?:reads|writes|calls|uses|consumes|handles) ([^.;\n]{3,120})/gi,
    subject: (m) => m[1],
  },
  { re: /\b(?:we|it|they) (?:currently )?(?:lacks?|ha(?:s|ve) no) ([^.;\n]{3,120})/gi, subject: (m) => m[1] },
];

/**
 * Ordinary English has a second `no <noun phrase>` shape that is NOT an
 * absence claim: "there is no excuse for waiting" is an argument about
 * effort, not a claim that a repository object named "excuse for waiting"
 * is missing. These constructions are deliberately enumerated rather than
 * treating every abstract noun as rhetoric — a genuine claim such as "there
 * is no reader for it" has no identifier either, but is exactly what this
 * lint must retain.
 *
 * Keep this list high-precision and construction-based. The subject has
 * already been normalized by `detectAbsencePremises`, so the expressions can
 * describe the words immediately following `no` without parsing a whole
 * sentence or guessing whether an abstract noun is important.
 */
const RHETORICAL_ABSENCE_SUBJECT = /^(?:(?:[a-z-]+\s+)?(?:excuse|reason)\s+(?:for|to)\b|(?:any\s+)?need\s+(?:for|to)\b|(?:any\s+)?point\s+in\b|(?:any\s+)?sense\s+in\b|(?:a\s+)?coincidence\s+required\b|(?:a\s+)?justification\s+for\b)/i;

/**
 * A bounded verdict about LIVE execution state is also not a missing durable
 * surface. "There is no stall to remediate" describes the current process leg;
 * telling its author to grep the repository for `stall to remediate` is a category
 * error. Keep this exact-subject shaped so real surface claims such as "there is no
 * stall detector for affected tasks" still reach the absence guard.
 */
const LIVE_STATE_ABSENCE_SUBJECT =
  /^(?:(?:current|live|active|remaining|new|runtime|process|observed|visible)\s+)*(?:stall|blocker|failure|error|regression|issue|problem|incident)(?:\s+(?:left\s+)?to\s+(?:remediate|fix|clear|resolve|investigate|handle))?$/i;

function isNonSurfaceAbsenceSubject(subject: string): boolean {
  const normalized = subject.trim();
  return RHETORICAL_ABSENCE_SUBJECT.test(normalized) || LIVE_STATE_ABSENCE_SUBJECT.test(normalized);
}

/**
 * A repository search is the right falsifier only when the matched span contains
 * a concrete artifact: a symbol, path, tool name, work-item id, error code, or
 * similar durable identifier. It is the wrong probe for prose about a transient
 * VCS/runtime condition such as "broken intermediate to bank" — searching for
 * that sentence can only return noise (or a guaranteed zero), and therefore
 * cannot establish anything about the world.
 *
 * Keep the extraction separate from absence classification. The detector should
 * still flag a state-shaped absence; this helper only decides whether a useful
 * search command can be synthesized. If no artifact can be extracted, the caller
 * gets honest observation guidance instead of a fabricated grep target.
 */
const SEARCHABLE_ARTIFACT_PATTERNS: ReadonlyArray<RegExp> = [
  /\b(?:WI|EI|F|P)-\d+\b/gi,
  /(?:^|[\s`"'(])((?:\/[\w./-]+|(?:[\w.-]+\/)+[\w./-]+|[\w.-]+\.(?:ts|tsx|js|mjs|cjs|json|sql|md|yaml|yml)(?::\d+)?))/gi,
  /(?<![A-Za-z0-9_$])([A-Za-z_$][\w$]*(?:(?:\.|::|->|:)[A-Za-z_$][\w$.-]*)+)(?![A-Za-z0-9_$])/g,
  /--[\w-]+/g,
  /\b[a-z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*\b/g,
  /\b(?=[0-9a-f]*[a-f])[0-9a-f]{8,40}\b/gi,
  /\b(?:ERR_[A-Z0-9_]+|E[A-Z]{2,}[A-Z0-9_]*|SQLSTATE)\b/g,
];

function extractSearchableArtifact(subject: string, claim: string): string | null {
  const normalized = `${subject} ${claim}`.replace(/\s+/g, ' ').trim();
  if (!normalized) return null;
  // Inline code is an explicit author-selected artifact even when the absence
  // matcher shortened its subject at a dot (`harness_shared.work_items`).
  // Prefer the first compact code span so a column name such as `severity` is
  // not displaced by the longer natural-language subject around it.
  for (const match of normalized.matchAll(/`([^`\n]{1,120})`/g)) {
    const artifact = (match[1] ?? '').trim();
    if (artifact.length >= 3 && !/\s/.test(artifact)) return artifact;
  }
  for (const pattern of SEARCHABLE_ARTIFACT_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of normalized.matchAll(pattern)) {
      const artifact = (match[1] ?? match[0] ?? '')
        .replace(/^[`"'(]+|[`"'),.;:]+$/g, '')
        .trim();
      if (artifact.length >= 3) return artifact;
    }
  }
  return null;
}

const OBSERVATION_RECHECK =
  'State what would falsify this claim and how you would observe it; name the runtime, temporal, or external-state probe that can answer it.';

/** The concrete probe attached to a derived premise. */
function recheckFor(subject: string, claim: string): string {
  const scopeRule =
    'across the WHOLE repo (not the one file that suggested it), then state the scope you searched — ' +
    'an absence found in one module is not an absence.';
  const artifact = extractSearchableArtifact(subject, claim);
  return artifact ? `Search for "${artifact}" ${scopeRule}` : OBSERVATION_RECHECK;
}

/**
 * EI-19399570274386816: is the `.` at `i` a SENTENCE end, or just a dot inside a token?
 *
 * `lastIndexOf('.')` treated every dot as a boundary, so a claim sentence citing a file
 * — the overwhelmingly common case in this corpus — got sliced mid-token. Measured: the
 * sentence "…`isCheckpointRunLockHeldCheap` (release-checkpoint-launch.ts:648) IS the
 * single authoritative source I claimed did not exist" was emitted as the claim
 * `"ts:648) IS the single authoritative both-origins source I claimed did not exist"`,
 * which begins mid-token and reads as garbage. A rendered claim nobody can parse is worse
 * than no claim: it looks like output and carries no meaning.
 *
 * A real terminator is followed by whitespace or end-of-text; `foo.ts`, `1.5` and
 * `release-checkpoint-launch.ts:648` all have a non-space next character.
 */
function isSentenceDot(text: string, i: number): boolean {
  // Skip any run of CLOSING markup that legitimately follows a terminator — `exist.**`,
  // `(…).`, `"…".`, `exist.)`. Measured over 4000 real bodies: without this the span
  // over-extends past a markdown bold-close and swallows the following sentence, which is
  // the same unreadable-claim defect in the other direction.
  let j = i + 1;
  while (
    j < text.length &&
    (text[j] === '*' ||
      text[j] === ')' ||
      text[j] === ']' ||
      text[j] === '"' ||
      text[j] === "'" ||
      text[j] === '`' ||
      text[j] === '_')
  ) {
    j++;
  }
  const next = text[j];
  return next === undefined || /\s/.test(next);
}

/**
 * The bounds of the sentence containing an offset.
 *
 * Split out from {@link sentenceAt} for P-014: the boundary scan must run over the
 * REDACTED prose (where a `.` or `;` inside a code span cannot masquerade as a
 * sentence end), while the text that gets QUOTED must be the original. Because
 * {@link stripNonProse} redacts to EQUAL LENGTH, one offset pair indexes both.
 */
function sentenceBoundsAt(text: string, index: number): { start: number; end: number } {
  let start = -1;
  for (let i = Math.min(index, text.length) - 1; i >= 0; i--) {
    const c = text[i];
    if (c === '\n' || c === ';' || (c === '.' && isSentenceDot(text, i))) {
      start = i;
      break;
    }
  }
  let end = text.length;
  for (let i = index; i < text.length; i++) {
    const c = text[i];
    if (c === '\n' || c === ';' || (c === '.' && isSentenceDot(text, i))) {
      end = i;
      break;
    }
  }
  return { start: start + 1, end };
}

/** The sentence containing an offset — the unit a human reads as "the claim". */
function sentenceAt(text: string, index: number): string {
  let start = -1;
  for (let i = Math.min(index, text.length) - 1; i >= 0; i--) {
    const c = text[i];
    if (c === '\n' || c === ';' || (c === '.' && isSentenceDot(text, i))) {
      start = i;
      break;
    }
  }
  let end = text.length;
  for (let i = index; i < text.length; i++) {
    const c = text[i];
    if (c === '\n' || c === ';' || (c === '.' && isSentenceDot(text, i))) {
      end = i;
      break;
    }
  }
  return text.slice(start + 1, end);
}

/**
 * EI-19399570274386816 — POLARITY. These patterns match a surface string, not a
 * proposition, so a sentence RETRACTING an absence claim ("X IS the source I claimed did
 * not exist") is indistinguishable from asserting one. That misfires on precisely the
 * write this guard exists to cause: the author who ran the search, found the thing, and is
 * documenting the correction. Rewarding that with a warning is how an advisory guard loses
 * the credibility it needs for its real catches — the same erosion argued in
 * EI-19388269294151851.
 *
 * Two high-precision suppressions, deliberately NOT a general negation parser:
 *
 * 1. REPORTED SPEECH AS SUBJECT. `<verb> did not exist` captures the verb, so
 *    "…I claimed did not exist" yields the subject "claimed" — and then a recheck telling
 *    the reader to grep the repo for "claimed", a term that names nothing. A reporting verb
 *    is never the name of an absent thing, so the match is always a report OF a claim
 *    rather than a claim. Zero false-negative risk: no genuine absence claim has a
 *    past-tense reporting verb as its subject.
 */
const REPORTED_SPEECH = new Set([
  'claimed',
  'said',
  'filed',
  'thought',
  'assumed',
  'asserted',
  'believed',
  'wrote',
  'argued',
  'reported',
  'stated',
  'concluded',
  'suspected',
]);

/**
 * 2. EXPLICIT SELF-RETRACTION in the same sentence. Kept deliberately TIGHT — every marker
 *    here is about the author's own prior claim being WRONG, so none can plausibly
 *    co-occur with a live absence claim. Notably absent: "already exists" / "does exist",
 *    which read like retraction markers but legitimately share a sentence with a real
 *    absence ("the table already exists but there is no reader for it") — including them
 *    would trade this false positive for a false negative on a genuine claim.
 */
const SELF_RETRACTION =
  /\b(?:i (?:was|am) (?:wrong|mistaken)|retract(?:s|ed|ing|ion)?|falsified|premise (?:is|was) (?:false|wrong)|(?:absence|absent)\s+claim[^.;\n]{0,120}\b(?:is|was)\s+(?:false|wrong)|turned out to exist)\b/i;

/** A first-person reporting frame just before the hit — "I claimed there is no X". */
const REPORTING_FRAME =
  /\b(?:i|we) (?:claimed|said|filed|thought|assumed|asserted|believed|wrote|reported)\b[^.;\n]{0,40}$/i;

/**
 * 3. HYPOTHETICAL MOOD — a falsification criterion is not an assertion.
 *
 * This corpus has a structured falsifier convention ("- Falsified if: <what would disprove
 * this>"), and an absence phrase inside one is CONDITIONAL by construction: "…meaning the
 * problem does not exist as described" states what WOULD be true if the probe came back a
 * certain way. Flagging it asks the author to go verify a hypothesis they explicitly
 * labelled as one.
 *
 * Measured over 4000 real bodies: 4 of the 7 total suppressions from this change were
 * exactly this shape. They were already being caught, but only INCIDENTALLY — the literal
 * word "Falsified" happens to appear in SELF_RETRACTION above, so relabelling the field
 * "Disproved if" would have quietly restored every false positive. Same mood, stated
 * explicitly, so the suppression survives a rename and reads as intentional.
 */
const HYPOTHETICAL_FRAME =
  /(?:^|\n)\s*(?:[-*+]\s*)?(?:\*\*)?\s*(?:falsifi(?:ed|es|able)|disprove[dn]?|refuted|invalidated)\b[^\n]{0,20}\bif\b/i;

/**
 * An absence phrase directly introduced as an `if`/`when`/`unless` condition is
 * not itself an assertion that the absent thing is missing. Keep this prefix
 * check tight: a separate main-clause claim such as "If X happens, there is no
 * reader" still reaches the advisory.
 */
const DIRECT_CONDITIONAL_ABSENCE_PREFIX = /\b(?:if|when|unless)\s*$/i;

/**
 * Derive absence premises from an artifact's own text. PURE and exported for
 * tests — the measurement above is only meaningful if the thing measured is the
 * thing that ships.
 *
 * Returns [] for blank/short text and for text whose absence phrases live
 * entirely inside quoted spans (fail open — silence, never a guess).
 */
export function detectAbsencePremises(text: string, source: PremiseSource): DerivedPremise[] {
  const prose = stripNonProse(text ?? '');
  if (prose.trim().length < 20) return [];
  const out: DerivedPremise[] = [];
  const seen = new Set<string>();
  for (const { re, subject } of ABSENCE_PATTERNS) {
    re.lastIndex = 0;
    for (const m of prose.matchAll(re)) {
      const redactedSubject = subject(m) ?? '';
      const subj = redactedSubject.replace(/\s+/g, ' ').trim();
      // A subject that was ENTIRELY code redacts to blanks — still skipped, deliberately:
      // P-014 restores code to the QUOTE, it does not make code detectable as a claim.
      if (!subj) continue;
      // EI-19406990448803963 / EI-21433992362008863: a rhetorical `no <noun
      // phrase>` construction or a bounded live-state verdict is not a missing
      // code referent. Do this after code redaction but before building the claim
      // so the false-positive cannot leak into either the rendered claim or its
      // recheck.
      if (isNonSurfaceAbsenceSubject(subj)) continue;
      // EI-19399570274386816 (1): "…I claimed did not exist" captures the verb, not a
      // subject — a report OF a claim, not a claim.
      if (REPORTED_SPEECH.has(subj.toLowerCase())) continue;
      const bounds = sentenceBoundsAt(prose, m.index ?? 0);
      const claim = clampClaim(originalSpan(text ?? '', prose, bounds.start, bounds.end));
      if (!claim) continue;
      // P-014: the recheck names the subject to grep for, so it needs the identifier the
      // author actually wrote, not its redacted husk. The group sits at a known offset
      // inside the match; `lastIndexOf` because two patterns capture a TRAILING group.
      // Backticks are markdown delimiters, not part of what you would search for.
      const subjOffset = m.index != null ? m[0].lastIndexOf(redactedSubject) : -1;
      const subjForRecheck =
        subjOffset >= 0 && m.index != null
          ? originalSpan(text ?? '', prose, m.index + subjOffset, m.index + subjOffset + redactedSubject.length)
              .replace(/`/g, '')
              .replace(/\s+/g, ' ')
              .trim() || subj
          : subj;
      // EI-19399570274386816 (2): the sentence retracts an absence rather than asserting
      // one, or reports one the author already attributed to their past self.
      if (SELF_RETRACTION.test(claim)) continue;
      if (REPORTING_FRAME.test(prose.slice(Math.max(0, (m.index ?? 0) - 60), m.index ?? 0))) continue;
      // EI-19399570274386816 (3): the hit sits inside a "Falsified if:" criterion — a
      // stated hypothesis, not a claim. Scoped to the hit's OWN line: a wider lookback let
      // one falsifier label silence genuine claims in the bullets that followed it.
      const hitAt = m.index ?? 0;
      if (DIRECT_CONDITIONAL_ABSENCE_PREFIX.test(prose.slice(bounds.start, hitAt))) continue;
      const lineStart = prose.lastIndexOf('\n', Math.max(0, hitAt - 1)) + 1;
      if (HYPOTHETICAL_FRAME.test(`\n${prose.slice(lineStart, hitAt)}`)) continue;
      const key = claim.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        kind: 'absence',
        source,
        claim,
        // D-001 (c): name the SCOPE requirement, not just "verify this". Scope of
        // inference — a real search over too narrow a scope — is the measured
        // failure mode, so a recheck that omits its scope reproduces the bug.
        recheck: recheckFor(subjForRecheck, claim),
      });
      if (out.length >= MAX_PREMISES) return out;
    }
  }
  return out;
}

/**
 * Keep the absence classification in {@link detectAbsencePremises}, while giving
 * every prescriptive write surface the same answer to the separate question:
 * "did the artifact already carry a probe for this claim?"
 *
 * The word-overlap rule is intentionally the one first shipped by
 * `loop:checkpoint` (outage-must-not-be-silent P-009). Exact substring matching
 * re-flags a parked check as soon as prose and check-row wording differ by a
 * rendering prefix or rewrap; duplicating the rule at each producer lets those
 * thresholds drift. `probeText` is rendered evidence/check prose, never the
 * narrative itself.
 */
export function uncoveredAbsencePremises(
  text: string,
  source: PremiseSource,
  probeText: string = '',
): Array<{ claim: string; recheck?: string }> {
  const probeWords = new Set(probeText.toLowerCase().match(/[a-z0-9_.:/-]{4,}/g) ?? []);
  const covered = (claim: string): boolean => {
    const words = claim.toLowerCase().match(/[a-z0-9_.:/-]{4,}/g) ?? [];
    if (words.length === 0) return false;
    const hits = words.filter((word) => probeWords.has(word)).length;
    return hits / words.length >= 0.6;
  };

  return detectAbsencePremises(text, source)
    .filter((premise) => !covered(premise.claim))
    .map((premise) => ({ claim: premise.claim, recheck: premise.recheck }));
}

/** Declared premises stored on the artifact, in the shared CheckEntry shape. */
function readDeclaredPremises(payload: unknown): CheckEntry[] {
  const p = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
  const raw = p.premises;
  if (!Array.isArray(raw)) return [];
  const out: CheckEntry[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const row = r as Record<string, unknown>;
    const claim = typeof row.claim === 'string' ? row.claim.trim() : '';
    if (!claim) continue;
    out.push({
      claim: clampClaim(claim),
      ...(typeof row.recheck === 'string' && row.recheck.trim() ? { recheck: row.recheck.trim() } : {}),
      ...(typeof row.verified === 'string' && row.verified.trim() ? { verified: row.verified.trim() } : {}),
    });
    if (out.length >= MAX_PREMISES) break;
  }
  return out;
}

/**
 * Does this evidence/probe text NAME THE SCOPE it searched?
 * (false-premise-in-prescriptive-artifacts-2026-08-02 P-002.)
 *
 * ── WHY ABSENCE CLAIMS GET A STRICTER BAR THAN EVERY OTHER PREMISE ──────────
 *
 * For a normal premise, "I checked" is adequate evidence. For an ABSENCE claim
 * it is not, and WI-7042 is the proof: that premise WAS checked. A real search
 * ran and returned nothing. It searched `projections/work-offers.ts` — the
 * receive/apply leg — and the helper lived in `offer-store.ts`. The method was
 * sound; the SCOPE was wrong, and a scope-less "verified: I grepped for it"
 * would have silenced exactly the warning that catches this.
 *
 * So an absence premise is only VERIFIED when its evidence says WHERE it looked.
 * A negative result is a statement about a search boundary, never about the
 * world — which is what makes "I checked" and "it does not exist" different
 * claims, and why only this premise kind takes the stricter test.
 *
 * Fails OPEN in the safe direction (D-001 b): unrecognized phrasing reads as
 * "no scope named", which merely keeps a warning the claimant can dismiss in
 * one read. The opposite default would silence a warning on evidence that never
 * established the absence — a silent false negative, and the expensive one.
 *
 * PURE and exported for tests.
 */
export function evidenceNamesScope(text: string): boolean {
  const t = (text ?? '').toLowerCase();
  if (!t.trim()) return false;
  return [
    /\b(whole|entire|full)\s+(repo|repository|tree|codebase|monorepo)\b/,
    /\brepo[- ]wide\b/,
    /\bacross\s+(the\s+)?(repo|repository|tree|codebase|monorepo|packages|libs|apps)\b/,
    /\bevery\s+(file|module|package|workspace|call ?site)\b/,
    /\ball\s+(call ?sites|packages|workspaces|of\s+(packages|libs|apps))\b/,
    /\b(grep|rg|ripgrep|gitnexus)\b[^.\n]{0,60}\b(packages|libs|apps|-r|--include|repo|tree)\b/,
    /\bsearched\b[^.\n]{0,60}\b(repo|tree|codebase|packages|libs|apps|everywhere)\b/,
  ].some((re) => re.test(t));
}

/** Is a declared claim itself absence-shaped? Reuses the ONE detector so the
 *  declared and derived paths cannot drift on what counts as an absence claim. */
function isAbsenceClaim(claim: string): boolean {
  return detectAbsencePremises(claim, 'work-item').length > 0;
}

/**
 * P-002: downgrade a DECLARED ABSENCE premise whose evidence names no scope.
 *
 * D-001 (a) — REPLACE, don't annotate. A `✓ VERIFIED` badge sitting next to a
 * footnote saying the evidence is inadequate would be read as a ✓; so the badge
 * is REMOVED (the row renders `? PREDICTED`) and the recheck states what is
 * actually missing. The original evidence is preserved inside the recheck text
 * rather than deleted — it is a real observation, just not a sufficient one.
 */
function enforceAbsenceScope(rows: CheckEntry[]): CheckEntry[] {
  return rows.map((row) => {
    const verified = (row.verified ?? '').trim();
    if (!verified || !isAbsenceClaim(row.claim)) return row;
    if (evidenceNamesScope(`${verified} ${row.recheck ?? ''}`)) return row;
    const { verified: _dropped, ...rest } = row;
    return {
      ...rest,
      recheck:
        `SCOPE NOT NAMED — this absence claim reports evidence ("${verified.slice(0, 90)}") that does not say WHERE it ` +
        `looked, so it does not establish an absence. Re-state it naming the scope searched (whole repo, not one module): ` +
        `a negative result describes a search boundary, not the world. WI-7042's premise WAS checked — over the wrong leg.`,
    };
  });
}

/** Loose overlap test between a declared claim and a derived one. Deliberately
 *  cheap: this only decides whether a declared row REPLACES a derived row, and
 *  the fail-open direction (keeping both) is merely redundant, not wrong. */
function overlaps(a: string, b: string): boolean {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  if (x.includes(y) || y.includes(x)) return true;
  const xs = new Set(x.split(' ').filter((w) => w.length > 4));
  const ys = y.split(' ').filter((w) => w.length > 4);
  if (xs.size === 0 || ys.length === 0) return false;
  const shared = ys.filter((w) => xs.has(w)).length;
  return shared >= 3 && shared / Math.min(xs.size, ys.length) >= 0.6;
}

/**
 * Combine declared + derived premises into the claim-time brief.
 *
 * D-001 (a) — a DECLARED premise carrying evidence REPLACES the derived row it
 * overlaps, rather than annotating it. Stating "this rests on X, and also X may
 * be wrong" next to each other invites acting on X anyway; an author who
 * actually checked the premise should silence the warning, and only that.
 * A declared premise WITHOUT evidence does not replace anything — it is the same
 * unverified assertion the derived row already caught.
 *
 * PURE and exported for tests.
 */
export function buildPremisesBrief(
  declaredRaw: CheckEntry[],
  derived: DerivedPremise[],
  additional: CheckEntry[] = [],
): ClaimTimePremisesBrief | null {
  // P-002 runs FIRST: a declared absence premise whose evidence names no scope is
  // downgraded to PREDICTED here, so it can neither render a ✓ nor silence the
  // derived row below. Ordering is the whole point — enforcing after the replace
  // would let scope-less evidence delete the warning on its way past.
  const declared = enforceAbsenceScope(declaredRaw);
  const verifiedDeclared = declared.filter((d) => (d.verified ?? '').trim().length > 0);
  const keptDerived = derived.filter((row) => !verifiedDeclared.some((d) => overlaps(d.claim, row.claim)));
  const premises: CheckEntry[] = [
    ...declared,
    ...keptDerived.map(({ claim, recheck }) => ({ claim, recheck })),
    ...additional,
  ].slice(0, MAX_PREMISES);
  if (premises.length === 0) return null;
  const unverified = premises.filter((p) => (p.verified ?? '').trim().length === 0).length;
  if (unverified === 0) return null; // nothing to warn about — stay silent (D-001 b).
  return {
    premises,
    rendered: premises.map(renderCheckLine),
    total: premises.length,
    unverified,
    note:
      `This item's text PRESCRIBES an approach that rests on ${unverified} UNVERIFIED premise(s) — ` +
      `treat the item as a HYPOTHESIS, not a spec, and run the re-check BEFORE building. ` +
      (additional.length > 0
        ? `At least one cited item's own terminal evidence explicitly INVALIDATED its premise; the current ` +
          `item may already discuss that correction, but must not silently keep depending on it. `
        : '') +
      (derived.length > 0 || declared.some((row) => isAbsenceClaim(row.claim))
        ? `Absence claims ("there is no X") are the expensive shape: acting on one means building X, while ` +
          `falsifying one costs a single search — and the measured failure is SCOPE OF INFERENCE, a real ` +
          `search over too narrow a scope reported as an absolute absence (WI-7042 prescribed a PG module ` +
          `that already existed). `
        : '') +
      `If a premise turns out false, fix the ITEM before building.`,
  };
}

/**
 * The port. Resolves declared + derived premises for a just-claimed work-item,
 * scanning BOTH the item's own body and — when the item came from a plan — the
 * plan-item text that governs it.
 *
 * Fail-soft by contract, like every sibling claim port: a lookup miss, an
 * unresolved plan slug, or a parse error degrades to `null`. Returns `null`
 * (silent) for the common case of an item with no absence-shaped premise.
 */
export async function getClaimTimePremises(opts: {
  workItem: Pick<WorkItem, 'payload'> & { id?: string | null; title?: string | null; summary?: string | null };
  harness?: string | null;
  workspaceId?: string | null;
  /** Test/consumer injection. Omit in production to use the canonical getWorkItem resolver. */
  citedWorkItemProbe?: PremiseCitationProbe;
}): Promise<ClaimTimePremisesBrief | null> {
  try {
    const wi = opts.workItem;
    const body = `${wi.title ?? ''}\n${wi.summary ?? ''}`;
    const derived: DerivedPremise[] = detectAbsencePremises(body, 'work-item');
    const invalidatedCitationsPromise = invalidatedPremiseCitationChecks(body, {
      selfId: wi.id,
      probe: opts.citedWorkItemProbe,
    });

    // The plan-item half of P-001: a premise in the plan item's text governs
    // every work-item promoted from it, and is the artifact a claimant is least
    // likely to re-read. Best-effort — a plan miss must never cost the item's
    // own premises.
    if (derived.length < MAX_PREMISES) {
      try {
        const planSlug = planSlugOfWorkItem(wi as WorkItem);
        const itemId = planItemIdOf(wi.payload);
        if (planSlug && itemId) {
          const row = await getPlanRow(planSlug, {
            ...(opts.harness ? { harnessSlug: opts.harness } : {}),
            ...(opts.workspaceId ? { workspaceId: opts.workspaceId } : {}),
          });
          if (row) {
            const item = parsePlan(row.content).items.find((i) => i.id === itemId);
            if (item?.text) derived.push(...detectAbsencePremises(item.text, 'plan-item'));
          }
        }
      } catch {
        /* fail open — the item's own premises still stand */
      }
    }

    const invalidatedCitations = await invalidatedCitationsPromise;
    return buildPremisesBrief(readDeclaredPremises(wi.payload), derived.slice(0, MAX_PREMISES), invalidatedCitations);
  } catch {
    return null;
  }
}

/** The plan item id a work-item was promoted from, if any. */
function planItemIdOf(payload: unknown): string | null {
  const p = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
  const planItem =
    p.plan_item && typeof p.plan_item === 'object'
      ? (p.plan_item as Record<string, unknown>)
      : p.planItem && typeof p.planItem === 'object'
        ? (p.planItem as Record<string, unknown>)
        : {};
  for (const k of ['item_id', 'itemId', 'id']) {
    const v = planItem[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}
