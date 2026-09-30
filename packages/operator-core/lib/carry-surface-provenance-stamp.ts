/**
 * carry-surface-provenance-stamp — the SYSTEM-side origin stamp for
 * carry-surface writes (deterministic-context-carry-2026-07-14 P-014).
 *
 * The lint (./carry-surface-provenance-lint.ts) is the pure, write-time nudge;
 * THIS module is the mechanical verification layer on top:
 *
 *   1. every [turn:<session>@<ts>] ref in the write is resolved against the
 *      WRITER's own transcript and the referenced turn classified owner-typed /
 *      agent-injected / machine-surface from what was recorded (the durable
 *      ⟦turn-origin:…⟧ envelope — turn-provenance/turn-ref.ts);
 *   2. the write itself is stamped with the CURRENT turn's classification —
 *      "written during an owner-typed turn" vs "written during a loop-fire" is
 *      recorded by the system, not asserted by the agent. A checkpoint claiming
 *      an owner directive while every driving turn was machine-injected is now
 *      visible mechanically (the WI-3532 class).
 *
 * WARN/STAMP-ONLY, fail-soft, bounded: like the lint, this must never block or
 * slow a carry write (often issued near a context limit) — any IO failure or
 * timeout degrades to the pure lint result. Enforcement is P-016's job.
 */

import { withBoundedTimeout } from './bounded-timeout';
import {
  assertsOwnerAuthority,
  directiveMatches,
  provenanceLintField,
  type ProvenanceLintMatch,
} from './carry-surface-provenance-lint';
import {
  ownerQuestionSlotField,
  type TypedSlotLintMatch,
} from './carry-surface-typed-slots';
import { gateClaimCarryLint, type GateClaimCarryLint } from './release/gate-claim-carry-lint';
import {
  suppressProvenActionClaims,
  type SuccessfulActionInvocation,
} from './carry-surface-action-proof';
import {
  parseTurnRefs,
  resolveCurrentTurnStamp,
  verifyTurnRefs,
  type CurrentTurnStamp,
  type RecordedTurnVerdict,
  type TurnRefVerdict,
} from './turn-provenance/turn-ref';

/** IO budget for the transcript reads — a stamp is advisory; the write is not. */
export const STAMP_IO_BUDGET_MS = 3_000;

/** EI-12890: shown when a [turn:…] ref resolved to a real turn but the quote
 *  attached to it does not appear in that turn's actual recorded text. */
export const QUOTE_MISMATCH_NOTE =
  'provenance_lint: a [turn:<session>@<ts>] ref resolved to a REAL recorded turn, but the quoted claim next to ' +
  'it does NOT appear in that turn\'s actual text — a resolvable ref is necessary but not sufficient; the words ' +
  'must match too. This is the exact fabrication shape from EI-12890 (a compaction summary fused two unrelated ' +
  'turns into one stronger directive and re-stamped it at the wrong turn). Re-read the cited turn verbatim ' +
  "(sessions:search { mode:'verbatim' } or dev:claude_session) before treating the claim as authorized.";

/** Advisory note for an anchor whose lookup did not produce a real turn.
 *  `checked:false` means the session/transcript could not be inspected, not that
 *  the ref is absent; the warning must make that distinction explicit. */
export const UNRESOLVED_TURN_REF_NOTE =
  'provenance_lint: this carry-surface write includes a [turn:<session>@<ts>] anchor that did not resolve to a ' +
  'recorded turn. This is ADVISORY and the write succeeded. `found:false` with `checked:false` means the referenced ' +
  'session/transcript could not be checked; even `checked:true` only means the searched transcript had no matching ' +
  'timestamp — neither state proves the claimed action or directive never happened. For the turn you are writing ' +
  'from, copy the exact `turnProvenance.writtenDuring.ref` from a recent tool response or write `[turn:self]`; do ' +
  'NOT construct a ref from the wake-pump nonce or an adjacent-looking timestamp.';

export interface CarryProvenanceStamp {
  /** The pure lint result (unchanged shape) — absent when clean. */
  lint?: { flagged: true; note: string; matches: ProvenanceLintMatch[] };
  /** P-015 typed-slot lint: owner-blocking-question prose with no [ask:…]
   *  record ref — absent when clean. */
  slotLint?: { flagged: true; note: string; matches: TypedSlotLintMatch[] };
  /** Verdicts for every [turn:…] ref the write carried — absent when none. */
  refs?: TurnRefVerdict[];
  /** The system's classification of the turn this write happened during. */
  writtenDuring?: CurrentTurnStamp;
  /** P-005 (cold-carry-system-hardening-2026-07-19): count of hand-written
   *  [owner:…] tags auto-verified because THIS write happened during an
   *  owner-typed interactive turn — the platform just witnessed the owner
   *  speaking, so the tag is evidence-backed rather than asserted. The
   *  `writtenDuring.ref` is the ready-to-copy [turn:…] anchor for them. */
  ownerTagsAutoVerified?: number;
}

/**
 * EI-12890 guard-defeat fix: a resolvable [turn:…] ref exempts its line from
 * the sync lint (TURN_REF_LINE_RE, carry-surface-provenance-lint.ts) on the
 * assumption it is "mechanically verifiable" — but a ref resolving to a REAL
 * turn whose text does not contain the quote attached to it is exactly the
 * fabricated-citation shape that defeated the guard live (a compaction summary
 * fused two unrelated turns into one stronger directive and re-stamped it at
 * the wrong turn's timestamp). Fold any such mismatch into `lint` so it
 * surfaces in the SAME flagged/matches shape a consumer already checks,
 * instead of requiring a separate turnProvenance.refs[].quoteMatch read that
 * nothing currently makes anyone perform. The one expected mismatch is a
 * `[turn:self]` ref expanded to THIS write's machine-injected turn: that ref
 * resolves to the loop wake prompt, while the quote describes the work being
 * written in response to it. Suppress only that exact same-turn,
 * agent-injected verdict; a cross-turn machine ref and every owner-turn ref
 * remain EI-12890 mismatches. Pure — no IO — so it's unit-testable without a
 * transcript fixture; `verified` is `[]` whenever ownerId was absent or the
 * transcript legs were skipped/timed out.
 */
export function mergeQuoteMismatchesIntoLint(
  lint: { flagged: true; note: string; matches: ProvenanceLintMatch[] } | undefined,
  verified: TurnRefVerdict[],
  currentTurn: CurrentTurnStamp | null = null,
): { flagged: true; note: string; matches: ProvenanceLintMatch[] } | undefined {
  const quoteMismatches: ProvenanceLintMatch[] = verified
    .filter(
      (v) =>
        v.found &&
        v.quote &&
        v.quoteMatch === false &&
        !(
          currentTurn?.verdict === 'agent-injected' &&
          v.verdict === 'agent-injected' &&
          v.ref === currentTurn.ref &&
          v.origin === currentTurn.origin
        ),
    )
    .map((v) => ({
      line: `${v.ref}: claimed "${v.quote}" — NOT found in the referenced turn's actual text (snippet: ${v.snippet ?? ''})`.slice(0, 400),
      kind: 'quote-mismatch' as const,
    }));
  if (!lint && !quoteMismatches.length) return undefined;
  return {
    flagged: true,
    note: quoteMismatches.length ? QUOTE_MISMATCH_NOTE : lint!.note,
    matches: [...(lint?.matches ?? []), ...quoteMismatches],
  };
}

/**
 * Fold unresolved ref verdicts into the same flagged/matches surface consumers
 * already read for provenance warnings. This is deliberately fail-soft:
 * verification state is preserved verbatim in `turnProvenance.refs[]`, while
 * this extra match only makes the unresolved anchor visible at write time.
 */
export function mergeUnresolvedTurnRefsIntoLint(
  lint: { flagged: true; note: string; matches: ProvenanceLintMatch[] } | undefined,
  text: string | null | undefined,
  verified: readonly TurnRefVerdict[],
): { flagged: true; note: string; matches: ProvenanceLintMatch[] } | undefined {
  const unresolved = verified.filter((v) => !v.found);
  if (unresolved.length === 0) return lint;

  const matches = unresolved.map((v) => {
    const sourceLine =
      (text ?? '')
        .split('\n')
        .map((line) => line.trim())
        .find((line) => line.includes(v.ref)) ?? v.ref;
    const status = v.checked
      ? 'the referenced transcript was checked but no turn matched this timestamp'
      : 'the referenced session/transcript could not be checked';
    return {
      line: `${sourceLine} — ${status} (found:false; checked:${v.checked})`.slice(0, 400),
      kind: 'unresolved-turn-ref' as const,
    };
  });

  const note =
    lint === undefined
      ? UNRESOLVED_TURN_REF_NOTE
      : lint.note.includes(UNRESOLVED_TURN_REF_NOTE)
        ? lint.note
        : `${lint.note} ${UNRESOLVED_TURN_REF_NOTE}`;
  return { flagged: true, note, matches: [...(lint?.matches ?? []), ...matches] };
}

/**
 * The verdicts that mean the referenced turn really was the HUMAN OWNER speaking.
 * Kept as data, and as a SET of all three owner-ish members, because the obvious
 * hand-written test — `verdict !== 'owner-typed'` — silently misclassifies a
 * cross-session-proven `owner-turn` and an `owner-dialog` answer as agent speech.
 */
export const OWNER_TURN_VERDICTS: ReadonlySet<RecordedTurnVerdict> = new Set([
  'owner-typed',
  'owner-turn',
  'owner-dialog',
]);

/** One line that claims owner authority on an anchor whose turn is NOT the owner. */
export interface FalsifiedOwnerAnchor {
  /** The offending line, trimmed and capped for display. */
  line: string;
  /** The `[turn:…]` ref, exactly as written. */
  ref: string;
  /** What the referenced turn actually was. */
  verdict: RecordedTurnVerdict;
  origin: string | null;
  /** Head of the referenced turn's real text, so the reader sees what was said. */
  snippet: string | null;
}

const FALSIFIED_LINE_CAP = 240;

/**
 * WI-42142 — the FALSIFIED OWNER ANCHOR: a line that asserts owner authority and
 * cites a `[turn:…]` ref which RESOLVED to a turn the system classified as NOT the
 * owner (a self-compaction note, a loop fire, a wake pump).
 *
 * This is the gap between the two existing legs, and it is the one that cost real
 * time. The sync lint ({@link lintCarrySurfaceProvenance}) treats ANY `[turn:…]`
 * ref as sufficient and skips the line entirely, so it flags nothing.
 * {@link mergeQuoteMismatchesIntoLint} then checks whether the attached QUOTE
 * matches the turn's text — but only when a quote was attached, and it says nothing
 * about WHO spoke. So a citation with no quote, pointing at a machine turn, passes
 * both. `stable-candidate-related-gate-2026-08-23#D-085` is that shape verbatim:
 * "Owner-directed ordering. … records the exact source turn as
 * [turn:codex:01a03d76-…@2026-08-26T09:46:32.215Z]" — a real, resolvable turn that
 * is `self-compaction` in a session containing zero human turns. The asserted hold
 * was then treated as owner authority by every downstream lane.
 *
 * PURE — the caller supplies verdicts already resolved by
 * {@link stampCarrySurfaceProvenance}, so this is unit-testable with hand-built
 * fixtures and adds no IO of its own.
 *
 * CONSERVATIVE BY CONSTRUCTION, which is what makes it safe to ENFORCE rather than
 * merely warn (the rest of this module is warn-only, deliberately):
 *   - it needs a verdict that was actually `found` AND `checked` — an unreachable
 *     transcript, a timed-out stamp, or a ref outside the owner's isolation chain
 *     yields nothing, so a failed lookup can never manufacture a refusal;
 *   - the owner-authority claim and the falsified ref must be on the SAME LINE,
 *     mirroring this module's line-scoping everywhere else, so an unrelated turn
 *     citation elsewhere in a long body cannot collide with the word "owner";
 *   - `owner-turn` and `owner-dialog` count as the owner (see
 *     {@link OWNER_TURN_VERDICTS}).
 *
 * Measured blast radius before wiring it: across every papercusp plan, exactly
 * FIVE decision-body lines carry a `[turn:…]` ref at all (2 plans), against 483
 * lines carrying a bare `[owner:…]`-shaped tag with no anchor. So this predicate
 * asks a question of ~5 historical lines, while the naive alternative — porting
 * loop:arm's `manual-owner-tag` refusal onto plan decisions — would have refused
 * 432 of those 483 across 139 plans AND still waved D-085 straight through, since
 * its line carries an anchor.
 */
export function falsifiedOwnerAnchors(
  text: string | null | undefined,
  verdicts: readonly TurnRefVerdict[],
): FalsifiedOwnerAnchor[] {
  if (!text || verdicts.length === 0) return [];
  const falsified = verdicts.filter(
    (v) => v.found && v.checked && v.verdict !== null && !OWNER_TURN_VERDICTS.has(v.verdict),
  );
  if (falsified.length === 0) return [];
  const out: FalsifiedOwnerAnchor[] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || !assertsOwnerAuthority(line)) continue;
    for (const v of falsified) {
      if (!line.includes(v.ref)) continue;
      out.push({
        line: line.slice(0, FALSIFIED_LINE_CAP),
        ref: v.ref,
        verdict: v.verdict as RecordedTurnVerdict,
        origin: v.origin,
        snippet: v.snippet,
      });
    }
  }
  return out;
}

/** The refusal text a consumer returns when {@link falsifiedOwnerAnchors} fires. */
export const FALSIFIED_OWNER_ANCHOR_NOTE =
  'falsified_owner_anchor: this write claims OWNER authority on a line whose [turn:<session>@<ts>] anchor ' +
  'resolved to a turn the system classified as NOT the owner (a self-compaction note, a loop fire, a wake ' +
  'pump). A resolvable ref is necessary but not sufficient — the cited turn has to be the human actually ' +
  'speaking. Re-read the turn verbatim (sessions:search { session:\'self\', mode:\'verbatim\' }), then either ' +
  'cite the real owner turn, or record the directive under its true source: [self-imposed] · [peer:<sid>] · ' +
  '[inferred]. A self-imposed constraint recorded honestly is worth more than an owner tag that cannot survive ' +
  'being checked. IF THIS LINE ASSERTS NO OWNER AUTHORITY and merely happens to contain the word "owner" beside ' +
  'an unrelated turn citation, that is a false positive of a deliberately broad conjunction: put the citation on ' +
  'its own line and the write proceeds. See stable-candidate-related-gate-2026-08-23#D-085 / #D-086 / #D-089.';

/** P-016 (EI-212678): the owner-authority vocabulary shared by every
 * carry-surface writer. These matches were historically response-only warnings,
 * so a later carry fold could lose the caveat entirely.
 *
 * A bare `do not ... until ...` gate is intentionally NOT in this set. The
 * synchronous lint surfaces it as a potentially unsafe imperative, but its
 * wording carries no claim that the human owner issued it. Treating that
 * warning as owner evidence fabricated `sourceRef:'owner-turn'` and silently
 * downgraded caller confidence on ordinary self/peer/system guidance.
 */
export const OWNER_AUTHORITY_LINT_KINDS: ReadonlySet<ProvenanceLintMatch['kind']> = new Set([
  'owner-attribution',
  'manual-owner-tag',
  'unverified-dialog-answer-claim',
]);

export const UNVERIFIED_OWNER_ATTRIBUTION_MARKER =
  '⚠ UNVERIFIED OWNER ATTRIBUTION — owner-authority prose was persisted without a verified owner turn; ' +
  'treat it as agent-authored until re-checked.';

export interface OwnerAttributionEnforcement {
  unverified: boolean;
  matches: ProvenanceLintMatch[];
  falsifiedAnchors: FalsifiedOwnerAnchor[];
  /** Owner-authority lines whose refs did not yield a matching owner verdict. */
  unresolvedAnchorLines: string[];
}

/** Determine whether owner-authority prose is safe to persist as authority.
 * Sync-lint matches are unverified by definition. Turn-ref'd lines bypass that
 * lint, so a resolved non-owner turn on the same line is explicitly falsified. */
export function ownerAttributionEnforcement(
  text: string | null | undefined,
  stamp: Pick<CarryProvenanceStamp, 'lint' | 'refs'> | null | undefined,
): OwnerAttributionEnforcement {
  const matches = (stamp?.lint?.matches ?? []).filter((m) => OWNER_AUTHORITY_LINT_KINDS.has(m.kind));
  const falsifiedAnchors = falsifiedOwnerAnchors(text, stamp?.refs ?? []);
  const verdicts = stamp?.refs ?? [];
  const unresolvedAnchorLines = (text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => {
      if (!assertsOwnerAuthority(line)) return false;
      const refs = parseTurnRefs(line);
      if (refs.length === 0) return false; // the sync lint owns unanchored lines
      return !refs.some((ref) =>
        verdicts.some(
          (v) =>
            v.ref === ref.raw &&
            v.found &&
            v.checked &&
            v.verdict !== null &&
            OWNER_TURN_VERDICTS.has(v.verdict) &&
            v.quoteMatch !== false,
        ),
      );
    })
    .map((line) => line.slice(0, FALSIFIED_LINE_CAP));
  return {
    unverified: matches.length > 0 || unresolvedAnchorLines.length > 0,
    matches,
    falsifiedAnchors,
    unresolvedAnchorLines,
  };
}

/** Prefix an idempotent marker onto persisted narrative text. */
export function markUnverifiedOwnerAttribution(text: string | null | undefined): string | null | undefined {
  if (text == null || !text.trim()) return text;
  if (text.includes(UNVERIFIED_OWNER_ATTRIBUTION_MARKER)) return text;
  return `${UNVERIFIED_OWNER_ATTRIBUTION_MARKER}\n${text}`;
}

/**
 * EI-19425644478222007: the ref the lint demands is a value the agent is never given.
 * `provenanceLint` requires `[turn:<session>@<iso-ts>]`, but nothing in the wake
 * payload, `coord:orient`, or any tool result states "the ISO timestamp of the turn
 * you are currently in" — so the ref gets GUESSED, and every adjacent-looking
 * timestamp is subtly wrong. Measured twice in one session, 2026-08-03:
 * `coord:orient`'s `provenance.observedAt` (09:46:29Z vs the real turn's
 * 09:46:06.524Z) and the loop-fire wake's own apparent time (09:58:36.030Z vs
 * 09:57:34.823Z). Both plausible, both adjacent, both `found:false`.
 *
 * The failure is quiet in the direction that matters: the write SUCCEEDS
 * (`ok:true`), the lint still flags, and the stored note now carries a ref that
 * resolves to nothing — an anchor that LOOKS like evidence and is not. That is
 * precisely the class the lint exists to prevent (EI-18226077402946717: a specific
 * artifact id is not proof), reproduced by the lint's own remedy.
 *
 * So stop requiring the agent to know the value. `[turn:self]` (or `[turn:current]`)
 * is the one provenance claim an agent can always make honestly — "this happened in
 * the turn I am writing from" — and the platform already resolves that exact value
 * on this same write path (`writtenDuring.ref`, from `resolveCurrentTurnStamp`).
 *
 * Expanding at WRITE time is deliberately preferred over merely surfacing the ref for
 * the agent to copy (the originally-suggested fix): a copied ref is correct only for
 * the turn it was read in, so it silently goes stale on the next wake of a loop, and
 * a response-size shaper may evict the field that carried it — reintroducing the guess
 * exactly when the payload is busiest. A sentinel cannot be stale, mistyped, or evicted.
 *
 * FAIL-SOFT IN THE SAFE DIRECTION: with no resolvable current turn (transcript
 * unreachable, no ownerId, or the stamp's IO budget degraded) the sentinel is left
 * VERBATIM. It deliberately does not match `TURN_REF_LINE_RE`, so the lint still flags
 * the line as unanchored — an honest miss, never a fabricated anchor.
 */
export const CURRENT_TURN_SENTINEL_RE = /\[turn:(?:self|current)\]/gi;

/**
 * PURE. Replace every `[turn:self]` / `[turn:current]` with this write's real anchor.
 * Returns `text` unchanged when the current turn could not be resolved.
 */
export function expandCurrentTurnSentinel(
  text: string | null | undefined,
  writtenDuring: CurrentTurnStamp | null,
): string | null | undefined {
  if (text == null || !writtenDuring?.ref) return text;
  return text.replace(CURRENT_TURN_SENTINEL_RE, writtenDuring.ref);
}

/**
 * Cheap pre-check so a write carrying no sentinel never pays for a transcript read.
 *
 * Uses its own NON-global literal on purpose: `.test()` on a `/g` regex advances
 * `lastIndex` and would make consecutive calls alternate true/false.
 */
export function hasCurrentTurnSentinel(text: string | null | undefined): boolean {
  return typeof text === 'string' && /\[turn:(?:self|current)\]/i.test(text);
}

/**
 * P-005 (cold-carry-system-hardening-2026-07-19), PURE: a hand-written [owner:…] tag
 * is unproven in general (P-014) — but when THIS write happens during an owner-typed
 * interactive turn, the platform has just witnessed the owner speaking: auto-verify
 * those tags instead of flagging them (`writtenDuring.ref` is their ready-to-copy
 * anchor). Nudging an agent for tagging a directive the owner gave seconds ago
 * teaches it to ignore the lint — the observed 2026-07-19 failure mode. Writes
 * during machine-injected turns keep the full nudge; owner-attribution phrases and
 * bare gate imperatives are never auto-cleared this way.
 */
export function applyOwnerTurnAutoVerify(
  lint: CarryProvenanceStamp['lint'],
  writtenDuring: CurrentTurnStamp | null,
): { lint: CarryProvenanceStamp['lint']; ownerTagsAutoVerified: number } {
  if (writtenDuring?.verdict !== 'owner-typed' || !lint) return { lint, ownerTagsAutoVerified: 0 };
  // Review fold #3 (manufactured-provenance guard): the current owner turn verifies
  // ONLY a tag citing a directive from TODAY'S contact — an [owner:… 2026-07-16] tag
  // written during a 2026-07-19 owner turn cites a directive this turn does NOT
  // contain, and auto-clearing it would upgrade an asserted tag to proof-grade
  // evidence pointing at the wrong turn (the exact failure class this module
  // exists to prevent). Constraint: the tag's line must carry the current turn's
  // YYYY-MM-DD (parsed from writtenDuring.ref). No parseable turn date ⇒ verify
  // nothing (conservative).
  const turnDate = /@(\d{4}-\d{2}-\d{2})/.exec(writtenDuring.ref)?.[1] ?? null;
  if (!turnDate) return { lint, ownerTagsAutoVerified: 0 };
  const kept = lint.matches.filter((m) => m.kind !== 'manual-owner-tag' || !m.line.includes(turnDate));
  const dropped = lint.matches.length - kept.length;
  return {
    lint: kept.length > 0 ? { ...lint, matches: kept } : undefined,
    ownerTagsAutoVerified: dropped,
  };
}

/**
 * Build the full stamp for one carry-surface write. Returns undefined when
 * there is nothing to say (clean lint, no refs, transcript unreachable) so the
 * common clean case adds no response field — same contract as the lint alone.
 */
export async function stampCarrySurfaceProvenance(
  text: string | null | undefined,
  ownerId: string | null | undefined,
  options: { successfulActions?: readonly SuccessfulActionInvocation[] | null } = {},
): Promise<CarryProvenanceStamp | undefined> {
  const lint = suppressProvenActionClaims(provenanceLintField(text), options.successfulActions);
  const slotLint = ownerQuestionSlotField(text);
  const refs = parseTurnRefs(text);

  // No directive shapes, no untyped questions, no refs → nothing to verify or
  // stamp. The writtenDuring stamp only matters alongside directive-ish
  // content; keeping the clean case field-free is deliberate (response-size
  // discipline).
  if (!lint && !slotLint && refs.length === 0) return undefined;

  let verified: TurnRefVerdict[] = [];
  let writtenDuring: CurrentTurnStamp | null = null;
  if (ownerId) {
    const { value } = await withBoundedTimeout(
      Promise.all([
        verifyTurnRefs(ownerId, refs, { scope: 'cross-session' }),
        resolveCurrentTurnStamp(ownerId),
      ]),
      {
        fallback: [[], null] as [TurnRefVerdict[], CurrentTurnStamp | null],
        timeoutMs: STAMP_IO_BUDGET_MS,
        label: 'carry-provenance-stamp',
      },
    );
    [verified, writtenDuring] = value;
  }

  // EI-22197373539314485: a ref the writer actually supplied must ALWAYS
  // surface an entry in the stamp — never silently vanish. `verified` can come
  // back shorter than `refs` (empty, in practice) in two honest-failure cases
  // that are NOT "no refs to report": `ownerId` was falsy so the whole IO leg
  // was skipped, or `withBoundedTimeout` degraded (a timeout, or an uncaught
  // rejection from either transcript read) and returned its `[[], null]`
  // fallback. Before this backfill, either case collapsed `stamp.refs` to
  // `undefined` — and when the write carried no lint/slotLint either, the
  // ENTIRE stamp vanished, `writtenDuring` included, so a supplied
  // `[turn:…]` anchor read back with NO turnProvenance block at all. That is
  // worse than an honest miss: a reader sees nothing to distrust. Backfill any
  // ref `verified` didn't return a verdict for with an unresolved,
  // `checked:false` miss — the same "we couldn't check" shape
  // `verifyTurnRefs` itself already uses for a genuinely-unresolvable ref — so
  // `found:false` (checked) and "never checked" stay distinguishable, and
  // `turnProvenance.refs[]` always has one entry per anchor the write carried.
  const verifiedByRef = new Map(verified.map((v) => [v.ref, v] as const));
  const completeRefs: TurnRefVerdict[] = refs.map(
    (r) =>
      verifiedByRef.get(r.raw) ?? {
        ref: r.raw,
        found: false,
        verdict: null,
        origin: null,
        snippet: null,
        quote: r.quote ?? null,
        quoteMatch: null,
        checked: false,
      },
  );

  const { lint: effectiveLint, ownerTagsAutoVerified } = applyOwnerTurnAutoVerify(lint, writtenDuring);

  const stamp: CarryProvenanceStamp = {};
  const quoteMergedLint = mergeQuoteMismatchesIntoLint(effectiveLint, completeRefs, writtenDuring);
  const mergedLint = mergeUnresolvedTurnRefsIntoLint(quoteMergedLint, text, completeRefs);
  if (mergedLint) stamp.lint = mergedLint;
  if (slotLint) stamp.slotLint = slotLint;
  if (completeRefs.length) stamp.refs = completeRefs;
  if (writtenDuring) stamp.writtenDuring = writtenDuring;
  if (ownerTagsAutoVerified > 0) stamp.ownerTagsAutoVerified = ownerTagsAutoVerified;
  return Object.keys(stamp).length ? stamp : undefined;
}

/** The optional second input to {@link carryProvenanceFields}. `retainedText` is
 *  the exact portion of the final carry value that was inherited from an older
 *  value, rather than supplied by this write. It is intentionally lint-only:
 *  retained bytes cannot be attributed to the current turn. */
export interface CarryProvenanceFieldsOptions {
  retainedText?: string | null;
  /** Successful same-turn coordination calls that can prove first-person action claims. */
  successfulActions?: readonly SuccessfulActionInvocation[] | null;
  /** A stamp computed before persistence so enforcement and the response share one verdict. */
  precomputedStamp?: CarryProvenanceStamp;
}

/**
 * Return the lines in `storedText` that are not represented by the text the
 * current writer supplied. Carry rows acquire a generated `(since …)` suffix
 * while they are normalized, so compare a suffix-stripped key rather than raw
 * bytes; otherwise every newly supplied row would be reported a second time as
 * retained history.
 */
export function retainedProvenanceText(
  storedText: string | null | undefined,
  suppliedText: string | null | undefined,
): string | undefined {
  if (!storedText?.trim()) return undefined;
  const suppliedLines = new Set(
    (suppliedText ?? '')
      .split('\n')
      .map((line) => line.trim().replace(/\s+\(since\s+[^)]+\)\s*$/, ''))
      .filter(Boolean),
  );
  const retained = storedText
    .split('\n')
    .filter((line) => !suppliedLines.has(line.trim().replace(/\s+\(since\s+[^)]+\)\s*$/, '')))
    .join('\n')
    .trim();
  return retained || undefined;
}

/**
 * EI-20745229385305334 — the STANDING DIRECTIVES a write is about to carry forward out of
 * text it did not itself supply. Composes the two steps {@link carryProvenanceFields}
 * already performs for `retainedProvenance` (isolate the inherited bytes, lint them) and
 * keeps only the instruction-shaped kinds, so a caller that PRESERVES history can ask the
 * one question the separate signals never answered together: *does the text I am about to
 * keep tell my successor to do something?*
 *
 * Pure, synchronous and fail-soft — safe to call inline on a write path that is often
 * issued near a context limit. `[]` for every clean case, so a caller can branch on
 * non-empty alone.
 */
export function retainedDirectiveMatches(
  storedText: string | null | undefined,
  suppliedText: string | null | undefined,
): ProvenanceLintMatch[] {
  try {
    return directiveMatches(provenanceLintField(retainedProvenanceText(storedText, suppliedText))?.matches);
  } catch {
    return [];
  }
}

/** Ready-to-spread response fields: `provenanceLint` keeps its pre-P-014 shape
 *  (consumer/response compat), `retainedProvenance` reports lint found only in
 *  inherited bytes, and `turnProvenance` carries the new mechanical stamp. All
 *  are absent on the common clean case. */
export interface CarryProvenanceFields {
  provenanceLint?: NonNullable<CarryProvenanceStamp['lint']>;
  /** Lint-only history: never carries current-turn refs or writtenDuring. */
  retainedProvenance?: NonNullable<CarryProvenanceStamp['lint']>;
  /** P-015: owner-blocking-question prose that should be a coord:ask-owner
   *  record cited as [ask:<conversation_id>]. */
  typedSlotLint?: NonNullable<CarryProvenanceStamp['slotLint']>;
  turnProvenance?: {
    refs?: TurnRefVerdict[];
    writtenDuring?: CurrentTurnStamp;
    /** P-005: [owner:…] tags auto-verified by the owner-typed current turn. */
    ownerTagsAutoVerified?: number;
  };
  /**
   * P-007 (frozen-candidate-compliance-enforcement-2026-08-30): this text asserts GATE
   * PROGRESS while a repair queue is frozen. Sibling of `provenanceLint` and here for the
   * same reason — both catch a claim that a successor would otherwise inherit as fact.
   */
  gateClaimLint?: GateClaimCarryLint;
}

export async function carryProvenanceFields(
  text: string | null | undefined,
  ownerId: string | null | undefined,
  options: CarryProvenanceFieldsOptions = {},
): Promise<CarryProvenanceFields> {
  const stamp =
    options.precomputedStamp ??
    (await stampCarrySurfaceProvenance(text, ownerId, {
      successfulActions: options.successfulActions,
    }));
  const retainedProvenance = options.retainedText ? provenanceLintField(options.retainedText) : undefined;
  // P-007: silent unless a repair queue is actually frozen, so this costs one failed marker
  // read in the ordinary case and never depends on the stamp having produced anything.
  const gateClaimLint = gateClaimCarryLint(text);
  if (!stamp && !retainedProvenance && !gateClaimLint) return {};
  const out: CarryProvenanceFields = {};
  if (gateClaimLint) out.gateClaimLint = gateClaimLint;
  if (stamp?.lint) out.provenanceLint = stamp.lint;
  if (retainedProvenance) out.retainedProvenance = retainedProvenance;
  if (stamp?.slotLint) out.typedSlotLint = stamp.slotLint;
  if (stamp?.refs || stamp?.writtenDuring || stamp?.ownerTagsAutoVerified) {
    out.turnProvenance = {
      ...(stamp?.refs ? { refs: stamp.refs } : {}),
      ...(stamp?.writtenDuring ? { writtenDuring: stamp.writtenDuring } : {}),
      ...(stamp?.ownerTagsAutoVerified ? { ownerTagsAutoVerified: stamp.ownerTagsAutoVerified } : {}),
    };
  }
  return out;
}
