/**
 * message-fields.ts — the authored message fields, as ONE schema.
 *
 * unified-agent-state-plane-2026-07-27 P-032 / D-064, unfrozen by **D-070**
 * [owner 2026-07-27]: *"I WANT TO ADD ALL THE MESSAGE FIELDS WE DECIDED ON.
 * REVERT THIS DECISION. WE NEED TO EXPERIMENT"*.
 *
 * ⚠ THE SPLIT IS THE DELIVERABLE, NOT THE CONTAINER (D-064). The array is the
 * cheap half; the envelope/section boundary is the half that is a CORRECTNESS
 * claim rather than a modelling preference, and it is enforced here rather than
 * documented:
 *
 *   ENVELOPE (one per message)          why it cannot vary per section
 *   ────────────────────────────────    ───────────────────────────────────────
 *   expects, blocking                   a scheduler acts on a message as a UNIT;
 *                                       "simultaneously blocking and not" is not
 *                                       a state anything can act on
 *   why                                 a goal REF (D-011), not prose — one
 *                                       message serves one goal
 *   basedOn (D-064's `evidence`,        auto-derived trace of what the sender
 *   renamed by D-084 — the old name     READ; a property of the SESSION, not of
 *   collides with P-010's live          a paragraph (D-002/D-011)
 *   evidence BAND on the same
 *   envelope key)
 *
 *   PER-SECTION — all four AUTHORED, and they genuinely vary between the parts
 *   of one message: premises, forYouBecause, youMayNotKnow, couldNotDetermine.
 *
 * Putting an envelope field on a section (or vice versa) is REFUSED, not
 * coerced. A silent coercion here would produce exactly the message a scheduler
 * cannot act on, which is the failure D-064 exists to prevent.
 *
 * MEASUREMENT, not a gate (D-069 §3, which SURVIVES D-070 and now carries more
 * weight because it is the only remaining check on this layer): judge these
 * fields by their VALUES, never their fill rate. P-029 is the precedent — a
 * field that was 100% populated with a third of it a mechanism string. A
 * per-section schema will look healthy (every field set, zero nulls) while
 * carrying nothing, and the null count cannot detect it.
 */

import { z } from 'zod';
import {
  boundValue,
  type AppliedArgCorrection,
  type ArgReencoding,
} from '@papercusp/tooldef';
// TYPE-ONLY, and it must stay that way: `couplings.ts` opens a PG handle at
// module scope, and this module is imported by every message-shaped surface.
import type { DerivedCouplingRelation } from '../../coord/couplings';
// EI-22369606583733422: the length cap is enforced in send.ts but was only
// discoverable from the REJECTION. Import the constant (a true leaf module —
// that is why it was factored out) so the schema below states the real number
// and cannot drift from the value the refusal enforces.
import { COORD_SEND_MAX_CHUNK_PARTS, DEFAULT_INBOX_BODY_CAP } from './tools/inbox-content-bounds';

// ─────────────────────────────────────────────────────────────────────────────
// premises — what I or someone else ASSERTED (D-041's rename of `restsOn`)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * D-026's admissible ref kinds, and the governing rule:
 *
 *   > **Any ref may be cited. The ref KIND determines whether it can go stale.**
 *
 * A non-invalidatable ref (an insight, an external doc) is still worth
 * declaring — it tells the receiver what the sender was reasoning from — it
 * simply cannot trigger automatic staleness. DEGRADE GRACEFULLY, NEVER EXCLUDE:
 * an unrecognised ref is classified `opaque`, not rejected.
 */
export type PremiseRefKind =
  | 'fact' // fact:owner:<id>:<key>@v<N> — conclusion / assumption / convention
  | 'plan-decision' // <plan-slug>#D-NNN — a claim, not the container plan
  | 'plan-item' // <plan-slug>#P-NNN — the item, not the container plan
  | 'work-item-completion' // WI-NNNN#completion — the CLAIM, not the item
  | 'work-item' // WI-NNNN / wi:WI-NNNN / WI-NNNN#<other> — EXISTENCE ONLY
  | 'peer-message' // msg:<msg_id>
  | 'owner-directive' // owner-turn:<ref>
  | 'doc' // /internal/docs/... — declarable, not invalidatable
  | 'opaque'; // unrecognised — cite it anyway, never stale

/** Which kinds can go stale. `doc`/`opaque` are declarable but never invalidatable. */
const INVALIDATABLE_KINDS: ReadonlySet<PremiseRefKind> = new Set<PremiseRefKind>([
  'fact',
  'plan-decision',
  'plan-item',
  'work-item-completion',
  'work-item',
  'peer-message',
  'owner-directive',
]);

/**
 * `WI-6502#completion` — the COMPLETION CLAIM (D-026 correction 2). The only
 * shape that may ever resolve to `broken`, because it is the only one that
 * asserts something capable of being false at send time.
 */
const WORK_ITEM_COMPLETION_RE = /^(?:wi:)?(?:WI|EI)-\d+#completion$/i;

/**
 * `WI-6560` · `wi:EI-18834967602055309` · `WI-6502#checkpoint` — a work item
 * cited as ITSELF. The `wi:` prefix is not invented here: it is the ref form
 * `isClaimIdentifyingRef` (improvements/checkpoint-harvest.ts) already uses.
 */
const WORK_ITEM_RE = /^(?:wi:)?(?:WI|EI)-\d+(?:#[^\s#]+)?$/i;

export interface ClassifiedPremise {
  /** The ref exactly as the sender cited it — never rewritten. */
  ref: string;
  kind: PremiseRefKind;
  /** D-026's governing rule, precomputed so no reader re-derives it. */
  invalidatable: boolean;
}

/**
 * Classify one premise ref by SHAPE. Total function — every string classifies,
 * because D-026 forbids excluding a citation for being unrecognised.
 *
 * ⚠ WHAT WIDENING THIS IS AND IS NOT FOR (D-090 [owner 2026-08-01] lens).
 * A wider classifier verifies more citations ON THE RECIPIENT'S BEHALF — its
 * whole yield is catching a MISTYPED id before the reader chases it. It must
 * never become a statement about what a sender may assert, or about which
 * citations are worth more. `opaque` is not a demerit and a checkable ref is
 * not a better one: per D-090's R2 the vocabulary may not be narrowed toward
 * the computable, and the same reasoning binds here. Two of the twelve refs
 * measured live on 2026-08-01 are irreducibly prose ("dev:pg_query GROUP BY
 * kind over …") and stay `opaque` — that is the design, not a gap to close.
 *
 * ⚠ `work-item` IS NOT A WEAKER `work-item-completion` — it is a DIFFERENT
 * CLAIM, and conflating them would break D-026 correction 2. Citing
 * `WI-6199#completion` asserts the item COMPLETED; citing `WI-6199` asserts
 * only that it EXISTS. So the bare form is verified to exactly the extent it
 * claims (existence ⇒ `holds` / `unresolvable`) and can NEVER resolve to
 * `broken` — the silent upgrade of a container into an invalidatable
 * completion assertion is precisely what D-026 forbids, and separating the
 * kinds is what keeps that impossible rather than merely discouraged.
 *
 * Counting the bare form also serves the owner's own convention: plan items
 * are cross-referenced by their globally-unique work-item id [owner 2026-07-27],
 * and until now that exact recommended form classified `opaque`.
 *
 * Order matters, and now in two ways:
 *   - PREFIX forms (`fact:`, `owner-turn:`, `msg:`, `/internal/docs/`) are
 *     tested first, so a prefixed ref never falls through to an ANCHOR arm.
 *     `/internal/docs/` moved up for that reason: with it last, a docs path
 *     carrying a `#D-001` anchor classified `plan-decision`.
 *   - `#completion` is tested before the general work-item shape, so the
 *     completion CLAIM keeps its own kind.
 */
export function classifyPremiseRef(ref: string): ClassifiedPremise {
  const trimmed = ref.trim();
  let kind: PremiseRefKind = 'opaque';
  if (/^fact:/.test(trimmed)) kind = 'fact';
  else if (/^owner-turn:/.test(trimmed)) kind = 'owner-directive';
  else if (/^msg:/.test(trimmed)) kind = 'peer-message';
  else if (trimmed.startsWith('/internal/docs/')) kind = 'doc';
  else if (WORK_ITEM_COMPLETION_RE.test(trimmed)) kind = 'work-item-completion';
  else if (WORK_ITEM_RE.test(trimmed)) kind = 'work-item';
  // `\d+`, not `\d{3,}`: the old bound was STRICTER than `parsePlanDecisionRef`
  // (`^D-\d+$`), so a two-digit `#D-90` classified `opaque` and never reached
  // the parser that would have handled it fine. A classifier narrower than its
  // own parser is a false negative with no upside.
  else if (/#D-\d+$/.test(trimmed)) kind = 'plan-decision';
  else if (/#P-\d+$/.test(trimmed)) kind = 'plan-item';
  return { ref: trimmed, kind, invalidatable: INVALIDATABLE_KINDS.has(kind) };
}

// `premisesArg` is defined further down, beside `youMayNotKnowArg` / `couldNotDetermineArg`:
// it needs `shapeTaughtArray` and `SHAPE_REFUSAL_TAIL`, and the three section fields now share
// one refusal style, so they are kept together rather than split across the file.

// ─────────────────────────────────────────────────────────────────────────────
// forYouBecause — the sender's model of why THIS recipient is being told (D-021)
//
// ⚠ WHAT THIS FIELD IS FOR, stated first because everything below is machinery
// and machinery is what gets optimised (D-090 [owner 2026-08-01]): it exists so
// agents can hold a THEORY OF MIND for each other. The sender says who it thinks
// the recipient IS to this message — and that model is the payload. The typing,
// the divergence check and the stamp are ways to LEARN about the model; they are
// not what makes it valuable, and no measurement result may be used to prune the
// vocabulary down to what a graph can verify. A sender's model that turns out to
// be WRONG is a working signal, not a defect — the same reasoning `youMayNotKnow`
// already states about its authored entries ("valuable precisely because they can
// be WRONG"). Optimising this field for checkability would leave it saying only
// what the system already knows.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * D-043: the vocabulary is the coupling vocabulary D-017 already computes for
 * presence, PLUS `'other'`.
 *
 * `'other'` is not a convenience. D-021 promised the field was "overridable when
 * the true reason is non-structural" and left that escape with no target — so a
 * sender with a genuinely non-structural reason had to pick the nearest-fitting
 * coupling, which is WORSE than prose: a mis-declared relation then falsely
 * agrees or falsely diverges with the computed graph, corrupting the exact
 * signal the field is justified on.
 */
export const FOR_YOU_BECAUSE_RELATIONS = [
  'holds-a-lock-on',
  'owns',
  'is-blocked-on',
  'awaits',
  'same-fleet',
  'other',
] as const;

export type ForYouBecauseRelation = (typeof FOR_YOU_BECAUSE_RELATIONS)[number];

export interface ForYouBecause {
  relation: ForYouBecauseRelation;
  /** What the relation is ABOUT (a file, a work-item, a fleet slug, …). */
  ref?: string;
  /** The prose half. REQUIRED when relation is 'other' (D-043 ruling 1). */
  note?: string;
}

/**
 * How ONE asserted relation may be compared against the computed coupling graph
 * (D-087). Data, not branches, so `participatesInCouplingDivergence` and
 * `couplingDivergenceVerdict` cannot drift apart.
 *
 * `absenceIsInformative` is the half that is easy to get wrong. The computed
 * graph only contains edges where BOTH agents participate (a SHARED lock, a
 * SHARED awaited key), while an assertion is one-sided ("YOU hold a lock on X").
 * So for those relations a computed hit confirms, but a computed miss says
 * nothing — the recipient may well hold a lock the sender does not. Scoring that
 * miss as divergence would manufacture disagreement out of the sender simply not
 * being on the same file.
 */
const COUPLING_DIVERGENCE_RULES: Record<
  ForYouBecauseRelation,
  { confirmedBy: readonly DerivedCouplingRelation[]; absenceIsInformative: boolean }
> = {
  // NO COMPUTED COUNTERPART, as of 2026-08-09 — same shape as `owns` below, and read it the
  // same way: uncomputable is not lesser. This entry USED to be
  // `{ confirmedBy: ['same-fleet'], absenceIsInformative: true }` on the reasoning that the
  // relation was "genuinely two-sided". That was true only while the DERIVATION emitted a
  // `same-fleet` edge — which D-054 had already cut as a coupling relation (set membership,
  // O(n²) in fleet size, redundant with the `fleetSlug` the base payload carries anyway).
  // Removing that emitter without touching this rule would have been the expensive half-fix:
  // `confirmedBy` could never be satisfied again, so `absenceIsInformative: true` would have
  // scored EVERY correctly-asserted `same-fleet` as a divergence — manufacturing disagreement
  // out of a signal we ourselves stopped computing, and reporting it as a sender-accuracy
  // problem. The ASSERTED relation stays valid: a sender may still say "I'm telling you
  // because we're in the same fleet". It simply is not diffable, exactly like `owns`.
  'same-fleet': { confirmedBy: [], absenceIsInformative: false },
  // Two-sided, but DIRECTION-INSENSITIVE: the graph splits blocked-by into
  // `blocks-me` / `blocked-by-me` because they mean opposite things to a reader,
  // while the asserted vocabulary has one token. Comparing against one direction
  // would score every correctly-asserted other-direction message as divergent.
  'is-blocked-on': { confirmedBy: ['blocks-me', 'blocked-by-me'], absenceIsInformative: true },
  // One-sided (see above). `confirmedBy` stays EXACTLY `holds-a-lock-on` — the
  // standing rule is that a merely-adjacent signal is never accepted as
  // confirmation, because quietly widening a token to mean "near enough" is how a
  // diff starts agreeing with itself. This used to be enforced against
  // `shared-file` (a DECLARED working-file is not a LOCK), which D-093 retired;
  // the rule outlives its example and binds the next relation that looks close.
  'holds-a-lock-on': { confirmedBy: ['holds-a-lock-on'], absenceIsInformative: false },
  awaits: { confirmedBy: ['awaits'], absenceIsInformative: false },
  // NO COMPUTED COUNTERPART — and read that as the field WORKING, not as a hole.
  // `owns` is 53% of live asserted uses (27/51 measured 2026-08-01): ownership is
  // a WORK-ITEM fact, not a coupling edge, so the derivation has no ownership
  // signal and adding one would not be a coupling. That majority is the whole
  // point (D-090): the most common reason one agent tells another something is a
  // relation NO graph knows, which is precisely why the sender has to say it.
  // A metric that compared it would report the most common relation as permanent
  // disagreement; that is a fact about the metric, never about the relation.
  owns: { confirmedBy: [], absenceIsInformative: false },
  // D-043 ruling 2 — the non-structural escape hatch, and the same reading:
  // uncomputable is not lesser.
  other: { confirmedBy: [], absenceIsInformative: false },
};

/**
 * D-043 ruling 2, the load-bearing half: **`'other'` is excluded from the
 * asserted-vs-computed divergence check BY CONSTRUCTION** — not scored as
 * agreement, not scored as divergence, simply not compared. An `'other'` that
 * participated in the diff would reintroduce the false-agreement failure it
 * exists to prevent.
 *
 * Exported so the P-013 divergence metric cannot forget to apply it: the rule
 * lives here, next to the enum, rather than in whichever consumer remembers.
 *
 * ⚠ NECESSARY, NOT SUFFICIENT (D-087). This answers "could this assertion ever
 * be compared", not "did it agree" — and it now also excludes `owns`, which
 * D-043 could not have known: the computed vocabulary it would be diffed against
 * did not exist yet, so nothing revealed that the most common asserted relation
 * has no counterpart in it. Use {@link couplingDivergenceVerdict} to score.
 *
 * ⚠⚠ `false` HERE IS NOT A QUALITY JUDGMENT, and misreading it is the one way to
 * destroy this field (D-090 [owner 2026-08-01]). `forYouBecause` exists so agents
 * can hold a THEORY OF MIND for each other — the sender's model of why THIS
 * recipient needs to know. The diff is a way to LEARN about that model, never the
 * source of its value. So "does not participate in the diff" must never be read
 * as "carries less", and this predicate must never become a filter on what a
 * sender may assert. Narrowing the vocabulary to the computable relations would
 * leave the field able to say only what the graph already knows — which is to say,
 * nothing worth sending.
 */
export function participatesInCouplingDivergence(f: ForYouBecause): boolean {
  return COUPLING_DIVERGENCE_RULES[f.relation].confirmedBy.length > 0;
}

/**
 * THREE-VALUED, deliberately: an assertion the graph cannot speak to is
 * `'not-comparable'`, never a quiet `'agrees'` and never a `'diverges'`.
 *
 * A two-valued diff has to fold "the graph disagrees" together with "the graph
 * has nothing to say", and the second dominates the first here — most asserted
 * relations are one-sided or uncomputable. Collapsing them yields a number that
 * measures the vocabulary mismatch rather than sender accuracy, which is worse
 * than no metric: it looks like a finding.
 *
 * @param computed the derived relations between sender and recipient AT SEND
 *        TIME (`CoupledPeer.derivedRelations`). It cannot be reconstructed later
 *        — locks release, awaits fire — so a retrospective pass over the message
 *        log can only ever score `'not-comparable'`.
 */
export type CouplingDivergenceVerdict = 'agrees' | 'diverges' | 'not-comparable';

export function couplingDivergenceVerdict(
  asserted: ForYouBecause,
  computed: readonly DerivedCouplingRelation[],
): CouplingDivergenceVerdict {
  const rule = COUPLING_DIVERGENCE_RULES[asserted.relation];
  if (!rule) return 'not-comparable';
  if (rule.confirmedBy.some((r) => computed.includes(r))) return 'agrees';
  return rule.absenceIsInformative ? 'diverges' : 'not-comparable';
}

const forYouBecauseArg = z
  .object({
    relation: z.enum(FOR_YOU_BECAUSE_RELATIONS),
    ref: z.string().min(1).optional(),
    note: z.string().min(1).optional(),
  })
  .optional()
  .describe(
    "PER-SECTION. Why THIS recipient is being told, STRUCTURED so it can be diffed against the " +
      'computed coupling graph (a prose string cannot be). relation: holds-a-lock-on | owns | ' +
      "is-blocked-on | awaits | same-fleet | other. `note` is REQUIRED with 'other' (the " +
      "non-structural escape hatch), and 'other' is excluded from the divergence check.",
  );

/**
 * `blockedOn` — EI-21548894457555139. What this section is WAITING ON, structured so the
 * reader can ACT on it instead of re-deriving it from prose.
 *
 * The originating incident was a leader unable to tell whether a member was working or
 * idle. The member knew perfectly well what it was doing; the channel between them had
 * no shape for saying so. "still running the tests" is unactionable — a leader cannot
 * check it, cannot tell a live run from a wedged one, and cannot find the log. A
 * `taskId` is actionable: `processes:list` shows whether it is alive and `logs:read` /
 * the log path shows whether it is advancing.
 *
 * Structured for the same reason `forYouBecause` is: a prose blocker cannot be diffed
 * against live state, so it can never be shown to have gone stale.
 *
 * ⚠ `ref` IS REQUIRED (coord-derived-fields-2026-08-31 D-003 [owner 2026-08-31]:
 * "anything that is a blocker is an important thing, agents might want to await
 * on it being unblocked … they can only do that if it is a real thing not just
 * prose"). A blocker that is a real ref is AWAITABLE — a work-item ref maps to
 * the machine `work-item:done:<id>` event key, an event ref IS an await key —
 * and diffable at read ("cleared since send"), which is the whole value of the
 * field. Prose can do neither, so prose-only entries are refused, not stored:
 *   · kind event | work-item | agent | owner → `ref` required
 *   · kind process → `taskId` (or `logPath`) required — the actionable handle
 *   · kind other → `note` required (the D-043 escape hatch; excluded from diff)
 * Enforced in the section superRefine below, where the refusal teaches the
 * grammar. Historical rows written before this rule stay readable — readers
 * tolerate a missing ref; only NEW writes are gated.
 */
const blockedOnArg = z
  .object({
    kind: z.enum(['process', 'event', 'work-item', 'agent', 'owner', 'other']),
    /** The blocker's identity in its own namespace: an event key (events:catalog),
     *  a WI-/EI-/F- work-item id, an ownerId, or for kind:'owner' the id of the
     *  needs-human item / escalation the owner must act on. REQUIRED for every
     *  kind except 'process' (which takes `taskId`) and 'other' (note-only escape). */
    ref: z.string().min(1).optional(),
    /** kind:'process' — the durable task id. THE actionable handle: processes:list / processes:kill. */
    taskId: z.string().min(1).optional(),
    /** kind:'process' — where the run is writing, so a reader can judge progress rather than guess. */
    logPath: z.string().min(1).optional(),
    /** ISO-8601. Lets a reader compute how long this has been blocked without asking. */
    startedAt: z.string().min(1).optional(),
    note: z.string().min(1).optional(),
  })
  .optional()
  .describe(
    'PER-SECTION. What this section is WAITING ON, structured so the reader can act on it — ' +
      'check it, diff it against live state, or events:await its clearing — rather than re-derive ' +
      'it from prose. kind: process | event | work-item | agent | owner | other. `ref` is REQUIRED ' +
      "for event (the events:catalog key) | work-item (WI-/EI-/F- id — a reader can await " +
      "`work-item:done:<id>`) | agent (ownerId) | owner (the needs-human/escalation id). For " +
      "kind:'process' give `taskId` (processes:list / logs:read can then check it) and/or " +
      "`logPath` — a process blocker with neither is unactionable and refused. `note` is REQUIRED " +
      "with 'other' (the escape hatch for a genuinely un-referenceable blocker; excluded from the " +
      "staleness diff). `startedAt` (ISO-8601) lets the reader age the block without asking.",
  );

// ─────────────────────────────────────────────────────────────────────────────
// youMayNotKnow / couldNotDetermine — D-024's split of the old `asymmetry`
// ─────────────────────────────────────────────────────────────────────────────

/**
 * D-024 split these because their halves differ on EVERY axis that matters:
 * origin (part-computed vs authored-only), enforcement, whether being wrong is
 * even the axis, and what the receiver does with it. One field whose entries
 * have different provenance and different meanings is a field that gets filled
 * inconsistently and read wrong.
 *
 * ⚠ Withdrawn once by an agent (D-034) on an unratified cost projection and
 * REINSTATED by the owner (D-040); frozen again by D-069 §1 and REINSTATED
 * again by the owner (D-070). Do not withdraw it a third time without the owner.
 */
export interface YouMayNotKnowEntry {
  ref: string;
  /**
   * 'computed' = the evidence-minus-your-watermark diff (free, exact, covers
   * tracked state). 'authored' = the sender's model of the receiver — valuable
   * PRECISELY because it can be wrong (D-021).
   *
   * ── FALSIFIABLE SEMANTICS (P-011), under D-090 ──────────────────────────────
   *
   * The two values are NOT symmetric, and the asymmetry is the semantics:
   *
   * • `authored` asserts something about the SENDER'S MODEL of the recipient.
   *   It has NO check and must never acquire one. Its being wrong is the payload,
   *   not a defect (D-021, and D-090 for the same reason on `forYouBecause`).
   *
   * • `computed` asserts something about a MECHANISM — that this ref came out of
   *   the evidence-minus-watermark diff. A claim that cites a mechanism can be
   *   wrong ABOUT THE MECHANISM, which is a different axis from "the sender's
   *   model was off". THE CHECK: at send time the recipient's read watermark
   *   (`harness_shared.coord_watermarks`) must NOT already cover `ref` — if they
   *   had demonstrably already read it, the diff could not have produced it, so
   *   the entry is FALSE. That is the falsifiable check for this field.
   *
   * ⚠ THE HOLE, named plainly (it does not close): nothing verifies that a sender
   * labelling an entry `computed` actually ran a diff. The check above is
   * ONE-SIDED — it can REFUTE a `computed` claim, never CONFIRM one. So
   * `computed` is a self-declared authority claim with one-sided falsifiability;
   * treat a passing entry as "not refuted", never as "verified".
   *
   * ⚠ WHY THIS MUST STAY AN AGGREGATE READ (D-090 R3, applied to this field —
   * reason it through before proposing enforcement): `computed` is the ONLY value
   * that can be caught wrong. Attach any per-agent consequence to being caught —
   * a warning, a nag, a score, a refusal — and the dominant strategy is to label
   * everything `authored`, where nothing can ever be held against you. The
   * enforcement would erase the very distinction the field exists to draw, and
   * the exact-diff entries (the free, reliable ones) would be the first to go.
   * The measurement would destroy what it measures. Aggregate reads only.
   *
   * And per D-088's standing condition: a refuted entry is a data-quality signal
   * about provenance labelling. It is NOT a licence to act, and not evidence
   * about the SENDER — verification is never authorisation.
   */
  provenance: 'computed' | 'authored';
}

/** Authored only — no system can know you TRIED and failed to establish something. */
export interface CouldNotDetermineEntry {
  what: string;
  note?: string;
}

/**
 * ─── WHY A WRONG SHAPE IS REFUSED WITH PROSE, AND NOT ACCEPTED AS SUGAR ──────
 *
 * The obvious "fix" for these two fields — admit a bare string and normalise it
 * to `{ ref, provenance: 'authored' }` / `{ what }` — is the ONE change that must
 * not happen here, and it is the change every agent who trips over the shape
 * proposes (six open filings as of 2026-08-10, three of them MAJOR).
 *
 * It is the same mechanism the owner banned for `body` (2026-07-28, interactive:
 * *"WE SHOULD NOT ALLOW JUST A STRING I WANT TO ENFORCE THE STRUCTURE THAT IS THE
 * WHOLE POINT OF IT"*), and the measurement behind that ban transfers verbatim:
 * while a free-text alternative sat beside the structured form, the structured
 * form was used ONCE in 5,642 messages. Sugar here would drive `provenance` to
 * ~100% 'authored' — the value that can never be refuted — collapsing the
 * computed/authored split that the owner has personally reinstated TWICE (D-040,
 * D-070) after agents withdrew it. The field would keep its name and lose its
 * meaning, which is worse than the papercut it cures.
 *
 * So the SHAPE stays strict and only the REFUSAL improves: name the member shape
 * in the FIRST error the way BODY_MUST_BE_ARRAY_MESSAGE does, instead of making
 * the caller discover it one zod layer per round-trip. Measured cost of the old
 * behaviour, live 2026-08-10: three consecutive rejections on one message —
 * `{...}` → "expected array, received object"; `["..."]` → "expected object,
 * received string"; `[{ text }]` → ".0.ref: expected string, received undefined".
 * Each was correct and each disclosed exactly one layer, so there was no way to
 * converge in fewer than three calls. The escape everyone then takes — fold the
 * content into `text` as prose — silently defeats the field, which is why the
 * error, not the schema, is the thing to fix.
 */
const SHAPE_REFUSAL_TAIL =
  ' This field is a CITATION, not prose: if what you want to say is a sentence, it belongs in ' +
  "the section's `text`. It is deliberately NOT sugar-coated to accept a bare string — a " +
  'free-text alternative beside a structured field is how the structure dies (the owner banned ' +
  'exactly that for `body`; see the note above this message in message-fields.ts).';

export const YOU_MAY_NOT_KNOW_SHAPE_MESSAGE =
  '`youMayNotKnow` must be an ARRAY of `{ ref, provenance }` OBJECTS — not a string, and not an ' +
  'array of strings. Write: youMayNotKnow: [{ ref: "WI-1234", provenance: "authored" }]. `ref` is ' +
  'WHAT you are pointing them at (a work-item id, `fact:owner:<id>:<key>@v<N>`, a doc path, a ' +
  '`msg:<id>`); `provenance` is exactly one of "computed" (the ref came out of the ' +
  'evidence-minus-their-watermark diff) or "authored" (it is YOUR model of what they lack). Label ' +
  'a GUESS "authored" — "computed" claims a mechanism produced it and is refutable against the ' +
  'recipient\'s read watermark.' +
  SHAPE_REFUSAL_TAIL;

export const COULD_NOT_DETERMINE_SHAPE_MESSAGE =
  '`couldNotDetermine` must be an ARRAY of `{ what, note? }` OBJECTS — not a string, and not an ' +
  'array of strings. Write: couldNotDetermine: [{ what: "<the thing you tried to establish and ' +
  'could not>" }], with an optional `note` for detail. It is AUTHORED ONLY: no system can derive ' +
  'that you tried and failed, so if you do not write it the receiver cannot tell "unknown" from ' +
  '"not asked".' +
  SHAPE_REFUSAL_TAIL;

/** Rendered when the array is well-shaped but too long — `maxItems: 20` in a raw schema dump has
 *  been misread as a 20-CHARACTER limit, so the count is spelled out in words. */
const tooManyEntriesMessage = (field: string, max: number, got: number) =>
  `\`${field}\` accepts at most ${max} ENTRIES (you sent ${got}). That is a limit on the NUMBER ` +
  `of entries in the array, not on the length of any string inside them.`;

/**
 * Refuse a wrong shape with a message that TEACHES the right one, while publishing only
 * the strict array schema. The `unknown()` guard sees every runtime value and emits the
 * actionable refusal; the `pipe()` output is what Zod publishes as JSON Schema. This
 * deliberately avoids a union whose string/unknown-array catch-alls would advertise
 * invalid alternatives to callers.
 */
function shapeTaughtArray<E>(
  field: string,
  entry: z.ZodType<E>,
  message: string,
  max = 20,
  min = 0,
  forwardMemberIssues = false,
): z.ZodType<E[]> {
  const guard = z
    .unknown()
    .superRefine((value, ctx) => {
      if (typeof value === 'string' || !Array.isArray(value)) {
        ctx.addIssue({ code: 'custom', message });
        return;
      }
      if (value.length < min) {
        ctx.addIssue({ code: 'custom', message });
        return;
      }
      if (value.length > max) {
        ctx.addIssue({ code: 'custom', message: tooManyEntriesMessage(field, max, value.length) });
        return;
      }
      if (!forwardMemberIssues) {
        if (value.every((member) => entry.safeParse(member).success)) return;
        ctx.addIssue({ code: 'custom', message });
        return;
      }
      for (const [index, member] of value.entries()) {
        const parsed = entry.safeParse(member);
        if (!parsed.success) {
          for (const issue of parsed.error.issues) {
            ctx.addIssue({ ...issue, path: [index, ...issue.path] });
          }
        }
      }
    });

  // `.pipe()` is intentional. A trailing `.transform()` makes the output impossible to
  // represent in JSON Schema, while this pipeline publishes the strict array/member shape
  // and still preserves the guard's custom refusal for malformed runtime values.
  const array = min > 0 ? z.array(entry).min(min) : z.array(entry);
  return guard.pipe(array.max(max));
}

const youMayNotKnowEntrySchema = z.object({
  ref: z.string().min(1),
  provenance: z.enum(['computed', 'authored']),
});

const couldNotDetermineEntrySchema = z.object({
  what: z.string().min(1),
  note: z.string().min(1).optional(),
});

/**
 * `premises` is the THIRD section field whose shape has to be taught, and the one most likely
 * to be got wrong, because the section's OTHER structured field is an object: `forYouBecause`
 * is `{ relation, ref?, note? }`, so `premises: [{ ref: "WI-1234" }]` is the natural
 * generalization — and it is wrong. Premises entries are BARE REF STRINGS.
 *
 * Measured 2026-08-10 (EI-20088434414057337 and four sibling filings): the object form returned
 * `Invalid input: expected string, received object` and the bare-string form returned
 * `expected array, received string` — both true, neither actionable, and both on the first
 * field an agent tends to reach for. Its two siblings were given taught refusals; this one was
 * not, so it stayed the entry point to the same round-trip loop.
 */
export const PREMISES_SHAPE_MESSAGE =
  '`premises` must be an ARRAY of REF STRINGS — not a string, and not an array of objects. ' +
  'Write: premises: ["WI-1234#completion", "my-plan#D-007"]. Note the difference from the ' +
  "section's `forYouBecause`, which IS an object — that asymmetry is the usual cause of this " +
  'error. Cite refs: `fact:owner:<id>:<key>@v<N>` · `<plan-slug>#D-NNN` · `WI-NNNN#completion` ' +
  '(the completion CLAIM, not the item) · `msg:<msg_id>` · `owner-turn:<ref>` · ' +
  '`/internal/docs/...`.' +
  SHAPE_REFUSAL_TAIL;

const premisesArg = shapeTaughtArray('premises', z.string().min(1), PREMISES_SHAPE_MESSAGE)
  // ⚠ `.optional()` is REQUIRED and is not part of shapeTaughtArray — omitting it makes the
  // field MANDATORY on every section, which fails a plain `{ text }` with a bare
  // "Invalid input". Its two siblings chain it for the same reason.
  .optional()
  .describe(
    'PER-SECTION. What this section RESTS ON — claims someone ASSERTED (D-041). An ARRAY OF REF ' +
      'STRINGS (not objects — `forYouBecause` is the object one). Cite refs: ' +
      '`fact:owner:<id>:<key>@v<N>` · `<plan-slug>#D-NNN` · `WI-NNNN#completion` (the completion ' +
      'CLAIM, not the item) · `msg:<msg_id>` · `owner-turn:<ref>` · `/internal/docs/...`. Any ref ' +
      'may be cited; the ref KIND decides whether it can go stale (a doc is declarable, never ' +
      'invalidatable). Distinct from `basedOn`, which is what you READ and is auto-derived.',
  );

/** Identifies the rule in every `corrected:[…]` disclosure it produces. */
export const PREMISES_REENCODING_RULE = 'premises.unwrap-ref-objects';

/** Bounded so a pathological nesting cannot make a repair path expensive. */
const PREMISES_WALK_MAX_DEPTH = 6;

/** Every member is an object carrying ONLY a non-empty string `ref` — no sibling metadata may be discarded. */
function isRefObjectArray(value: unknown): value is Array<Record<string, unknown>> {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((member) => {
      if (!member || typeof member !== 'object' || Array.isArray(member)) return false;
      const record = member as Record<string, unknown>;
      const keys = Object.keys(record);
      return (
        keys.length === 1 &&
        keys[0] === 'ref' &&
        typeof record.ref === 'string' &&
        record.ref.trim().length > 0
      );
    })
  );
}

/**
 * P-016 / D-107 — auto-run `premises: [{ ref: "WI-1" }] -> ["WI-1"]`.
 *
 * WHY THIS ONE, AND WHY IT IS NOT THE BANNED CHANGE. Measured 2026-09-02 over 7d of
 * `tool_invocations`, wrong-shape `premises` is 1,211 rejections across 555 agents — 68% of
 * ALL coord:send rejections — and 99.8% of them send exactly this shape, with >=98% of members
 * carrying only a string `ref`. The comment above says why they do it: the section's OTHER
 * structured field, `forYouBecause`, IS an object, so `premises: [{ ref }]` is the natural
 * generalization. Unwrapping is total, deterministic, has exactly ONE candidate output, and
 * the output is literally the string the caller already supplied — D-104 RE-ENCODING, so it
 * may run.
 *
 * It is the OPPOSITE of the change banned at the top of this file. That ban forbids accepting
 * a bare STRING in place of structure (prose replacing citations; `provenance` collapsing to
 * an invented 'authored'). Here the caller sent MORE structure than declared and we unwrap to
 * the declared scalar: nothing is invented, no free-text alternative appears, and a citation
 * stays a citation. The rule intentionally refuses objects with sibling metadata: even though
 * `ref` is readable, executing that correction would lose caller-supplied meaning.
 * `SHAPE_REFUSAL_TAIL`'s promise that this is "not sugar-coated to accept a bare string" is
 * untouched — see the cases this rule deliberately does NOT repair.
 *
 * WHY AUTO-CORRECT RATHER THAN A BETTER MESSAGE — the question D-104 makes you answer before
 * promoting anything to this tier. This field ALREADY GOT the better message:
 * `PREMISES_SHAPE_MESSAGE` was added 2026-08-10 for precisely this error and diagnoses the
 * cause exactly. Measured after it shipped: still 1,211 refusals, still 555 agents, still one
 * shape. A taught refusal was tried here and is insufficient at scale, which is the evidence
 * D-104 requires — not an assumption that teaching would not have worked.
 *
 * TWO CASES IT MUST NOT TOUCH (D-107 rulings 2 and 4):
 *   - a BARE STRING premise stays refused. All 3 observed are prose, and coercing prose into a
 *     ref manufactures a citation the caller never made — the exact free-text hazard the owner
 *     banned, and the one failure mode here that would corrupt data rather than waste a call.
 *   - a member with NO `ref` (34 observed, 1.7%) stays refused: choosing which of its keys is
 *     the ref is DISAMBIGUATION, which D-104 assigns to refuse-and-teach.
 *   - a member with sibling metadata stays refused: dropping a caller-supplied key is lossy,
 *     even when `ref` itself is unambiguous.
 * All three fall out of `isRefObjectArray` returning false, so the ordinary taught refusal
 * renders unchanged.
 *
 * PURE BY CONTRACT. Rebuilds only the objects along a changed path and returns the original
 * node by identity otherwise, so `tool_invocations.args_json` keeps the shape the caller
 * actually sent. That ledger is the decay instrument D-104's endgame clause depends on — see
 * `reencode-args.ts` for why that is worth more than a bespoke correction log.
 */
export const PREMISES_REF_OBJECT_REENCODING: ArgReencoding = {
  rule: PREMISES_REENCODING_RULE,
  reencode: (input) => {
    const corrections: AppliedArgCorrection[] = [];

    const walk = (node: unknown, path: string, depth: number): unknown => {
      if (depth > PREMISES_WALK_MAX_DEPTH || !node || typeof node !== 'object') return node;
      const join = (segment: string | number) => (path ? `${path}.${segment}` : String(segment));

      if (Array.isArray(node)) {
        let changed = false;
        const next = node.map((item, index) => {
          const rewritten = walk(item, join(index), depth + 1);
          if (rewritten !== item) changed = true;
          return rewritten;
        });
        return changed ? next : node;
      }

      let changed = false;
      const next: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        const childPath = join(key);
        if (key === 'premises' && isRefObjectArray(value)) {
          const refs = value.map((member) => member.ref as string);
          corrections.push({
            path: childPath,
            sent: boundValue(value),
            ran: boundValue(refs),
            rule: PREMISES_REENCODING_RULE,
          });
          next[key] = refs;
          changed = true;
          continue;
        }
        const rewritten = walk(value, childPath, depth + 1);
        if (rewritten !== value) changed = true;
        next[key] = rewritten;
      }
      return changed ? next : node;
    };

    const rewritten = walk(input, '', 0);
    if (corrections.length === 0) return null;
    return { input: rewritten, corrections };
  },
};

const youMayNotKnowArg = shapeTaughtArray(
  'youMayNotKnow',
  youMayNotKnowEntrySchema,
  YOU_MAY_NOT_KNOW_SHAPE_MESSAGE,
)
  .optional()
  .describe(
    'PER-SECTION. Information I have that you may lack, as an ARRAY of { ref, provenance } ' +
      "OBJECTS — e.g. [{ ref: \"WI-1234\", provenance: \"authored\" }]. A bare string is REFUSED. " +
      "'computed' entries are the evidence-minus-your-watermark diff; 'authored' entries are my " +
      'model of you and are valuable precisely because they can be WRONG. Label a GUESS `authored`, ' +
      'never `computed` — `computed` claims the diff produced it and is refutable against the ' +
      "recipient's read watermark; `authored` is never checked, so guessing costs you nothing. " +
      'Not the same field as ' +
      '`couldNotDetermine` (D-024) — this one is a gap in YOUR knowledge, that one is a failed attempt of MINE.',
  );

const couldNotDetermineArg = shapeTaughtArray(
  'couldNotDetermine',
  couldNotDetermineEntrySchema,
  COULD_NOT_DETERMINE_SHAPE_MESSAGE,
)
  .optional()
  .describe(
    'PER-SECTION, AUTHORED ONLY. What I TRIED to establish and FAILED to — so you read the ' +
      'question as OPEN rather than answered, as an ARRAY of { what, note? } OBJECTS — e.g. ' +
      '[{ what: "whether the next candidate carries the fix" }]. A bare string is REFUSED. ' +
      'No system can derive this; if you do not write it, ' +
      'the receiver cannot distinguish "unknown" from "not asked".',
  );

/**
 * P-012 / D-106 — clarification as a first-class act, made NON-BLOCKING.
 *
 * WHY THIS IS A FIELD AND NOT A VERB. A clarification VERB already exists
 * (`coord:ask` → a `question` conversation) and is empirically dead: measured
 * 2026-08-02 over 30d, `coord:ask` took 6 calls against `coord:send`'s 3512
 * (~1:84), and over 60d 32 of 42 question conversations (76%) were never
 * answered. A fifth verb on that surface would be deader than the fourth, so
 * clarification rides the surface agents actually use — the one that already
 * carries a reply OBLIGATION (unanswered-directed: a directed message outranks
 * the recipient's own work) rather than the one that orphans.
 *
 * WHY BOTH HALVES ARE REQUIRED. Asking costs a round-trip of unbounded latency;
 * proceeding on an assumption costs nothing now — so a rational agent declines
 * to ask, which is exactly what 1:84 shows. Pairing the question with the
 * assumption the sender proceeds on ANYWAY collapses that cost to zero: the
 * sender never waits, and the answer CORRECTS rather than unblocks. `assuming`
 * is what makes this cheap enough to actually get used, so it is mandatory —
 * an ask with no stated fallback is the blocking round-trip this replaces.
 *
 * It is also the load-bearing half of the value-of-information test: an agent
 * that cannot name the assumption it would proceed on has not yet identified a
 * decision, and therefore has nothing worth a peer's turn.
 *
 * DESCRIPTIVE ONLY (P-009's boundary): a clarification request must never drive
 * a state transition or be dispatched on. Per D-088, typing it makes
 * VERIFICATION mechanical, never COMPLIANCE — verification is never authorisation.
 */
const clarifyArg = z
  .array(
    z.object({
      question: z.string().min(1),
      assuming: z.string().min(1),
    }),
  )
  .max(10)
  .optional()
  .describe(
    'PER-SECTION. A question you need answered, PAIRED with the assumption you are proceeding ' +
      'on meanwhile: { question, assuming }. NON-BLOCKING by construction — you do not wait, and ' +
      'the answer CORRECTS you rather than unblocking you. `assuming` is REQUIRED: if you cannot ' +
      'name the fallback you will act on regardless, you have not identified a decision worth a ' +
      "peer's turn. Ask only what a QUERY cannot answer (locks:list, fleet:assignments, " +
      'work_items:get) and where being wrong is expensive or irreversible. Descriptive only — ' +
      'never dispatched on.',
  );

// ─────────────────────────────────────────────────────────────────────────────
// why / evidence — ENVELOPE-scoped
// ─────────────────────────────────────────────────────────────────────────────

/** D-011: a goal REF, never prose — so the receiver can query the goal's LIVE state. */
export interface MessageWhy {
  goalRef: string;
  note?: string;
}

const whyArg = z
  .object({
    goalRef: z.string().min(1),
    note: z.string().min(1).optional(),
  })
  .optional()
  .describe(
    'ENVELOPE (one per message — one message serves one goal). WHY you are sending this, as a ' +
      'goal REF not prose (D-011), so the receiver can query the goal\'s LIVE state instead of ' +
      'trusting your snapshot of it. Shape: { goalRef: "<goal ref>", note?: "<optional prose>" }. ' +
      '`note` carries any prose.',
  );

/**
 * ENVELOPE. What the sender READ — refs, versioned (D-041).
 *
 * ⚠ AUTO-DERIVED, NEVER AUTHORED. It is deliberately NOT a caller argument:
 * D-002's never-author economics and D-011 both put this on the session, and
 * D-064 records that asking a sender to author it per-section contradicts both.
 * `deriveBasedOn` (based-on.ts) is the seam that fills it, off the invocation
 * log; when it has nothing to say the field is OMITTED, which is honest — an
 * empty trace is not a false one.
 *
 * ── WHY `basedOn` AND NOT `evidence` (D-084 R1) ──────────────────────────────
 *
 * D-064 called this field `evidence`. That name is ALREADY TAKEN, on this exact
 * object: `extra` keys are flattened onto the coord envelope (messages.ts), and
 * P-010's evidence BAND rides `env.evidence` (`EVIDENCE_FIELD`,
 * relay-provenance.ts) — stamped by coord:escalate and read on every rendered
 * coord line. Two different questions ("how do you know?" — a closed band → a
 * derived confidence — versus "what did you read?"), one key: an array here
 * reads as a MALFORMED band, so the two would silently displace each other and
 * a message could never carry both.
 *
 * So it takes D-011's own name for it: *"`basedOn` (sender's information
 * provenance) is likewise auto-derived from recent reads, not authored"*.
 * D-064's ruling — envelope-scoped, auto-derived, one per message — is
 * untouched; its own text says the envelope/section boundary is the load-bearing
 * part, "not the array".
 */
export interface BasedOnEntry {
  /** `kind:ref` in the dependency-tag grammar (`work-item:` · `plan:` · `file:`). */
  ref: string;
  /** The tool call the sender read it through. */
  via: string;
  /** ISO timestamp of that read. */
  readAt: string;
  /**
   * The ref's version token AS OF THE SEND — never as of the read (D-084 R4).
   * A change inside the read→send gap is invisible to it, so it must not be
   * called `version`: that would claim to be the value the sender saw.
   */
  versionAtSend?: string;
}

const blockingArg = z
  .boolean({
    error:
      'blocking must be the BOOLEAN `true` or `false`, not explanatory text. Put the explanation in ' +
      '`body` section text and a checkable blocker in `body[].blockedOn`.',
  })
  .optional()
  .describe(
    'ENVELOPE. Optional BOOLEAN flag: pass the literal `true` or `false`. Is the SENDER blocked until ' +
      'this is dealt with? A scheduler acts on a message as a UNIT, which is why this cannot vary per ' +
      'section. Distinct from `expects`: `expects` is what you want BACK, `blocking` is what it costs ' +
      'you to wait for it. Do not put explanatory prose in this field; put the explanation in `body` ' +
      'section text and a checkable blocker in `body[].blockedOn`.',
  );

// ─────────────────────────────────────────────────────────────────────────────
// The section, and the envelope/section boundary ENFORCED
// ─────────────────────────────────────────────────────────────────────────────

/** P-012 / D-106: a question PAIRED with the assumption the sender acts on meanwhile. */
export interface ClarifyEntry {
  question: string;
  /** REQUIRED — the fallback the sender proceeds on. Absent ⇒ a blocking ask. */
  assuming: string;
}

export interface MessageSection {
  text: string;
  premises?: string[];
  forYouBecause?: ForYouBecause;
  youMayNotKnow?: YouMayNotKnowEntry[];
  couldNotDetermine?: CouldNotDetermineEntry[];
  clarify?: ClarifyEntry[];
}

/** The four field names that may NEVER appear on a section (D-064's split;
 *  `evidence` renamed `basedOn` by D-084 — see {@link BasedOnEntry}). */
export const ENVELOPE_ONLY_FIELDS = ['expects', 'blocking', 'why', 'basedOn'] as const;

/** The five that may never appear on the envelope. */
export const SECTION_ONLY_FIELDS = [
  'premises',
  'forYouBecause',
  'youMayNotKnow',
  'couldNotDetermine',
  'clarify',
  'blockedOn',
] as const;

/**
 * Every section needs readable text, even when it also carries structured metadata.
 * Keep one message for missing, wrong-typed, and empty values so a caller learns the
 * section shape in one round-trip instead of chasing zod's low-level type/minimum errors.
 */
export const SECTION_TEXT_MESSAGE =
  '`text` is REQUIRED on every body section and must be a non-empty STRING. Write: ' +
  'body: [{ text: "<what the recipient should read>" }]. Every section needs its own ' +
  'readable text, even when it also carries `couldNotDetermine`, `blockedOn`, or another ' +
  'structured field; put the explanation in `text` rather than sending a section that ' +
  'contains only metadata.';

const sectionTextArg = z
  .string({ error: SECTION_TEXT_MESSAGE })
  .min(1, { error: SECTION_TEXT_MESSAGE })
  .describe(
    'REQUIRED on every body section. A non-empty string containing what the recipient should read; ' +
      'structured fields such as `couldNotDetermine` or `blockedOn` add metadata but do not replace it.',
  );

export const messageSectionSchema = z
  .object({
    text: sectionTextArg,
    premises: premisesArg,
    forYouBecause: forYouBecauseArg,
    youMayNotKnow: youMayNotKnowArg,
    couldNotDetermine: couldNotDetermineArg,
    clarify: clarifyArg,
    blockedOn: blockedOnArg,
  })
  .strict()
  .superRefine((section, ctx) => {
    // EI-21548894457555139 — same principle as the forYouBecause rule below: an escape
    // that carries no explanation is a silent opt-out.
    if (section.blockedOn?.kind === 'other' && !section.blockedOn.note) {
      ctx.addIssue({
        code: 'custom',
        path: ['blockedOn', 'note'],
        message:
          "blockedOn.kind:'other' REQUIRES a `note`. 'other' is the escape hatch for a blocker " +
          'that fits none of the structured kinds, so without the note it says only "blocked", ' +
          'which is what the structured field exists to improve on.',
      });
    }
    // A process blocker with no handle is prose wearing a schema. The whole value of
    // kind:'process' is that the reader can CHECK it — processes:list on the taskId, or
    // the log path for progress. Naming neither leaves them exactly where they were:
    // unable to tell a live run from a wedged one, which is the incident this field
    // comes from.
    if (section.blockedOn?.kind === 'process' && !section.blockedOn.taskId && !section.blockedOn.logPath) {
      ctx.addIssue({
        code: 'custom',
        path: ['blockedOn', 'taskId'],
        message:
          "blockedOn.kind:'process' REQUIRES `taskId` and/or `logPath`. Without one the reader " +
          'cannot check whether the process is alive or advancing, which is the only reason to ' +
          'send a structured process blocker instead of a sentence. capability:bash returns the ' +
          'durable task_id; processes:list resolves it.',
      });
    }
    // coord-derived-fields-2026-08-31 D-003 [owner 2026-08-31]: a blocker must be a
    // REAL REF, not prose — a real ref is awaitable (a work-item ref maps to the
    // machine `work-item:done:<id>` event key; an event ref IS an await key) and
    // diffable at read ("cleared since send"). A kind naming a referenceable thing
    // with no ref carries neither affordance, so it is refused with the grammar.
    if (
      section.blockedOn &&
      ['event', 'work-item', 'agent', 'owner'].includes(section.blockedOn.kind) &&
      !section.blockedOn.ref
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['blockedOn', 'ref'],
        message:
          `blockedOn.kind:'${section.blockedOn.kind}' REQUIRES \`ref\` — the blocker's identity in ` +
          'its own namespace, so a reader can check it, diff it against live state, or ' +
          'events:await its clearing. Grammar: event → the events:catalog key · work-item → the ' +
          'WI-/EI-/F- id (awaitable as `work-item:done:<id>`) · agent → the ownerId · owner → the ' +
          "needs-human item / escalation id the owner must act on. A blocker that fits no " +
          "namespace is kind:'other' with a `note` (excluded from the staleness diff).",
      });
    }
    // D-043 ruling 1 — an escape that carries no explanation is a silent opt-out.
    if (section.forYouBecause?.relation === 'other' && !section.forYouBecause.note) {
      ctx.addIssue({
        code: 'custom',
        path: ['forYouBecause', 'note'],
        message:
          "forYouBecause.relation:'other' REQUIRES a `note` (D-043). 'other' is the escape hatch " +
          'for a genuinely non-structural reason, and it is excluded from the asserted-vs-computed ' +
          'divergence check — so without the note it carries no information at all.',
      });
    }
  });

/**
 * THE STRING BODY IS REFUSED (owner directive 2026-07-28, interactive: *"WE SHOULD NOT
 * ALLOW JUST A STRING I WANT TO ENFORCE THE STRUCTURE THAT IS THE WHOLE POINT OF IT"*).
 *
 * D-064 originally admitted a plain string as "the n=1 case". Measured 30h after the
 * format shipped: 5,642 messages, and the sectioned form was used ONCE — by the owner's
 * admin GUI, never by an agent. The string branch was not a convenience, it was the whole
 * traffic; an optional structure next to a free-text alternative is the same "a default is
 * how a field dies" mechanism D-016 names, and here the default was the entire format.
 *
 * So the runtime guard catches the string and refuses it with a message that teaches the
 * shape — a bare `z.array(...)` would emit zod's "expected array, received string",
 * which tells an agent what it did wrong but not what to do instead. The published side
 * of the guard is a strict array pipeline, so schema-first callers never see the refused
 * string as an alternative. The refusal is the tier-2 GATE this behaviour never had;
 * per D-016 the prompt was never going to be one.
 */
// EI-19407756530556168: hoisted out of the superRefine below so send.ts's cross-field
// preprocess can raise the IDENTICAL message. zod v4's `z.preprocess` is a two-stage
// PIPE (transform -> object schema) that ABORTS the second stage entirely the moment the
// first stage (the preprocess transform) calls `ctx.addIssue` — see handlePipeResult in
// zod/v4/core/schemas.js ("prevent further checks"). So whenever send.ts's preprocess
// ALSO needs to report a cross-field issue (missing `expects`, missing `summary`, the
// structured-body gate, forYouBecause), this field's own superRefine below NEVER RUNS —
// its issue is silently dropped, not merely deprioritized. A caller who submits a
// malformed (string) body alongside any OTHER violation only ever discovered the shape
// problem on a LATER round-trip, after fixing the other one first. send.ts duplicates
// this exact check inside its preprocess (same message, so no visible difference) so the
// two issues always surface together.
export const BODY_MUST_BE_ARRAY_MESSAGE =
  '`body` must be an ARRAY of sections — a plain string is no longer accepted. Wrap what you ' +
  'wrote: body: [{ text: "<your text>" }]. That minimum is always valid, and it puts the five ' +
  'authored fields one keystroke away, which is the point: `premises` (the claims this part ' +
  'rests on, so a reader can re-check your footing), `forYouBecause` (why THIS recipient is ' +
  'getting it), `youMayNotKnow` (something you hold that they likely lack), `couldNotDetermine` ' +
  '(what you could NOT establish — silence there reads as confidence you do not have), ' +
  '`clarify` (a question PAIRED with the assumption you are proceeding on meanwhile — you ' +
  'never wait, the answer corrects you). Split ' +
  'into SEVERAL sections when parts of your message have different dispositions, so a firm ' +
  'finding and an unverified guess are not delivered as if they were the same thing. The ' +
  'ENVELOPE fields (expects, blocking, why, basedOn) stay on the message and are refused on a ' +
  'section.';

export const messageBodyArg = shapeTaughtArray(
  'body',
  messageSectionSchema,
  BODY_MUST_BE_ARRAY_MESSAGE,
  20,
  1,
  true,
)
  .optional()
  .describe(
    'The message body: an ARRAY of sections. A plain string is REFUSED — the minimum is ' +
      '[{ text: "..." }]. Use SEVERAL sections when the parts of your message have different ' +
      'dispositions — a concession, an experimental result, an explicitly-undetermined claim — ' +
      'each with its own `premises` (an ARRAY OF REF STRINGS, e.g. `premises: ["WI-1234#completion"]`, ' +
      'not objects), `forYouBecause`, `youMayNotKnow`, `couldNotDetermine`, ' +
      '`youMayNotKnow: [{ ref: "WI-1234", provenance: "authored" }]`, or ' +
      '`couldNotDetermine: [{ what: "the thing you tried to establish", note: "optional detail" }]`, ' +
      '`clarify`. The ENVELOPE fields (expects, blocking, why, basedOn) stay on the message and ' +
      'are refused on a section. LENGTH: a body over ' +
      `${DEFAULT_INBOX_BODY_CAP} characters (what one inbox read shows) is delivered in full as up to ${COORD_SEND_MAX_CHUNK_PARTS} ordered parts; ` +
      'only the final part carries `expects` and the wake. Longer is REFUSED: put it on `work_items:comment` or `coord:message-agent`, then send a short pointer.',
  )
  .meta({
    // EI-23318249512516833: the same body schema is used by the single-message
    // envelope and every `items[]` entry. A stable registry id makes Zod emit one
    // `$defs` entry plus refs instead of serializing this large nested contract twice.
    id: 'coord-send-body-v1',
    // Discovery must retain this conditional, aggregate bound when it drops
    // verbose descriptions. A maxLength on body/text would falsely impose an
    // unconditional or per-section cap. The send validator uses this same
    // receiver-derived constant; its parity test covers both sides of the bound.
    'x-papercusp-call-constraint':
      `body text joined with "\\n\\n" must fit ${COORD_SEND_MAX_CHUNK_PARTS} parts of <=${DEFAULT_INBOX_BODY_CAP} characters`,
  });

export {
  premisesArg,
  forYouBecauseArg,
  youMayNotKnowArg,
  couldNotDetermineArg,
  clarifyArg,
  whyArg,
  blockingArg,
};

/**
 * Normalise `body` to sections. A string becomes the one-element array D-064
 * names as the n=1 case, so every downstream reader sees ONE shape.
 */
export function toSections(body: string | MessageSection[] | undefined): MessageSection[] {
  if (body === undefined) return [];
  if (typeof body === 'string') return body.length ? [{ text: body }] : [];
  return body;
}

/**
 * Flatten sections back to the plain text `env.body` every existing reader
 * (coord:inbox, coord:read, the [coord+N] injection, coord:thread, the pui pane)
 * already renders. The STRUCTURE rides the envelope alongside it — this is the
 * text projection, not the storage.
 */
export function sectionsToText(sections: MessageSection[]): string {
  return sections.map((s) => s.text).join('\n\n');
}

export class EnvelopeFieldOnSectionError extends Error {
  readonly code = 'coord_envelope_field_on_section';
  constructor(field: string, index: number) {
    super(
      `body[${index}].${field} is an ENVELOPE field, not a section field (D-064). ` +
        `Move it to the top level of the message. \`expects\`/\`blocking\` cannot vary per section ` +
        `because a scheduler acts on a message as a UNIT; \`why\` is one goal ref per message; ` +
        `\`basedOn\` is auto-derived from the session, not authored per paragraph.`,
    );
    this.name = 'EnvelopeFieldOnSectionError';
  }
}

/**
 * Enforce the boundary BEFORE the message is persisted. `.strict()` on the
 * section schema already rejects unknown keys; this converts the specific
 * envelope-field case into a typed refusal that TEACHES the split instead of
 * emitting a generic "unrecognized key".
 */
export function assertEnvelopeSectionSplit(sections: unknown[]): void {
  sections.forEach((section, i) => {
    if (!section || typeof section !== 'object') return;
    for (const field of ENVELOPE_ONLY_FIELDS) {
      if (field in (section as Record<string, unknown>)) {
        throw new EnvelopeFieldOnSectionError(field, i);
      }
    }
  });
}

/**
 * Render the AUTHORED fields as a compact injection suffix — the half that makes
 * them real. A field stamped on an envelope that no receiver ever sees cannot be
 * judged by its VALUES, and D-070 leaves that judgement as the only check on
 * this layer.
 *
 * ⚠ D-072: a field marked in `fieldProvenance` was DERIVED by a non-agent
 * sender's wrapper, not authored. It is deliberately NOT rendered here —
 * presenting a GUI-derived default as the sender's model of you would be
 * precisely the false signal the provenance stamp exists to prevent.
 *
 * Terse by construction: injection lines share a ~200-char cap with the message
 * itself, so this reports COUNTS for the list-valued fields and spells out only
 * `couldNotDetermine`, which is the one that changes what the receiver does
 * (it marks a question OPEN rather than answered).
 */
export function renderAuthoredFieldsSuffix(env: Record<string, unknown>): string {
  const parts = authoredFieldParts(env);
  return parts.length ? ` ⟨${parts.join(' · ')}⟩` : '';
}

/**
 * The compact parts, unwrapped — so the terse marker has exactly ONE derivation.
 *
 * The `[coord+N]` injection wraps these in `⟨…⟩` ({@link renderAuthoredFieldsSuffix});
 * the LIST reader surfaces (coord:inbox / coord:catch-up / coord:feed) join them into a
 * one-line `authored` field per row. Those surfaces deliberately do NOT carry the full
 * {@link projectAuthoredFields} projection: each already budgets its rows hard (~15KB of
 * body across an inbox read, per-row body/summary excerpting on the feed), and attaching
 * a full per-section block to every row is how a list surface starts overflowing the
 * agent result cap. The compact marker says WHAT a message carries; `coord:read <msg_id>`
 * (or coord:thread) is the surface that shows it in full.
 */
/**
 * Character budget for spelled-out `youMayNotKnow` refs on the `[coord+N]` line.
 * Sized to match the existing `couldNotDetermine` allowance (120) so the two
 * in-band payloads are symmetric and the worst-case suffix stays bounded — the
 * marker is deliberately compact, and the fix for a starved read path is to
 * deliver the ACTIONABLE part, not to lift the cap.
 */
export const YMNK_MARKER_BUDGET_CHARS = 120;

/**
 * Budget for the `forYouBecause` NOTE on the `[coord+N]` line.
 *
 * WHY THE NOTE SHIPS IN-BAND AT ALL (D-090, owner-ruled): `forYouBecause` exists
 * so a sender can state its model of who the RECIPIENT is to this message — that
 * model IS the payload. The line used to carry only the relation ENUM, which for
 * `relation:'other'` is literally zero information: `∵ other` says a model was
 * authored and withholds all of it. D-043 makes a note MANDATORY on `other`
 * precisely because the enum cannot carry the meaning there, so dropping the note
 * discarded the one field the schema guarantees is present and load-bearing.
 * Measured: `other` was 109 of 659 relations in 7d — ~1 in 6 markers delivered
 * nothing a reader could use.
 */
export const FYB_NOTE_BUDGET_CHARS = 90;

/**
 * Budget for spelled-out `premises` refs. Smaller than youMayNotKnow's: a premise
 * ref is a short pointer (`WI-1#completion`, `x#D-001`) and a reader re-checking
 * footing needs the ids, not prose.
 */
export const PREMISE_MARKER_BUDGET_CHARS = 90;

/**
 * The SHARED cap across every marker fragment on the `[coord+N]` line. This is
 * the constraint the original count-only rendering existed to respect, now
 * enforced in one place instead of implied by each field staying small.
 */
export const AUTHORED_MARKER_TOTAL_BUDGET_CHARS = 200;

/** One marker fragment plus the degraded form to fall back to under budget pressure. */
export interface MarkerPart {
  /** The spelled-out fragment — what a reader can act on WITHOUT a second call. */
  full: string;
  /** The degraded (usually counted) form. Omit when counting would be worse than silence. */
  short?: string;
  /** Lower is served first when the shared budget is tight. */
  priority: number;
}

/**
 * Join short authored strings into ONE bounded marker fragment, dropping the
 * overflow into a `(+N)` count.
 *
 * Extracted because three fields need exactly this and each hand-rolled version
 * is a chance to reintroduce the bug the extraction exists to kill: a marker that
 * silently shows a COUNT instead of the content, forcing a `coord:read` that
 * fires ~15 times a week against ~1,600 sends. A count is the correct FALLBACK
 * only when nothing fits at all — never the default.
 */
export function boundedMarkerList(refs: readonly string[], budgetChars: number): {
  shown: string[];
  withheld: number;
} {
  const shown: string[] = [];
  let budget = budgetChars;
  for (const raw of refs) {
    const ref = String(raw ?? '').trim();
    if (!ref) continue;
    if (budget <= 0) break;
    // A single over-long ref is TRUNCATED, not dropped: a truncated pointer is
    // still a pointer, and dropping it silently is exactly the count-only
    // failure mode.
    const piece = ref.length > budget ? `${ref.slice(0, Math.max(1, budget - 1))}…` : ref;
    shown.push(piece);
    budget -= piece.length + 2; // + '; ' separator
  }
  return { shown, withheld: Math.max(0, refs.filter((r) => String(r ?? '').trim()).length - shown.length) };
}

export function authoredFieldParts(env: Record<string, unknown>): string[] {
  const raw = env.sections;
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const derived = (env.fieldProvenance ?? {}) as Record<string, unknown>;
  const sections = raw as MessageSection[];

  const parts: MarkerPart[] = [];

  if (env.blocking === true && !derived.blocking) parts.push({ full: 'BLOCKING', priority: 1 });

  // `⊨`, NOT `⊢`: the injection line already uses `⊢` for the P-010 evidence
  // BAND, and these are different claims — premises are what the sender asserted
  // this rests on, the band is how well-evidenced the line is. One glyph for both
  // would recreate exactly the near-synonym confusion D-041 renamed to fix.
  // Premises are SHOWN, not counted, for the same reason as youMayNotKnow below:
  // `⊨ 4 premises` tells a reader that footing was declared and withholds what it
  // rests on, so re-checking it — the entire point of declaring a premise —
  // required a second call. The single-premise case already spelled it out; this
  // just stops treating "more than one" as a reason to say less.
  const premises = sections.flatMap((s) => s.premises ?? []);
  if (premises.length && !derived.premises) {
    const { shown, withheld } = boundedMarkerList(premises, PREMISE_MARKER_BUDGET_CHARS);
    parts.push({
      full:
        shown.length > 0
          ? `⊨ ${shown.join('; ')}${withheld > 0 ? ` (+${withheld})` : ''}`
          : `⊨ ${premises.length} premises`,
      short: `⊨ ${premises.length} premise${premises.length === 1 ? '' : 's'}`,
      priority: 6,
    });
  }

  if (!derived.forYouBecause) {
    const fyb = sections.map((s) => s.forYouBecause).find(Boolean);
    if (fyb) {
      // THE NOTE IS THE FIELD (D-090). The relation enum classifies the sender's
      // model; the note IS the model. Delivering only the enum was the read-side
      // half of "the write half shipped and the read half did not".
      const note = String(fyb.note ?? '').trim();
      const shownNote =
        note.length > FYB_NOTE_BUDGET_CHARS
          ? `${note.slice(0, FYB_NOTE_BUDGET_CHARS - 1)}…`
          : note;
      const stem = `∵ ${fyb.relation}${fyb.ref ? ` ${fyb.ref}` : ''}`;
      parts.push({
        full: `${stem}${shownNote ? ` — ${shownNote}` : ''}`,
        // Degrades to the relation alone — except on `other`, where the enum
        // carries no meaning at all (D-043 makes the note mandatory there
        // precisely for that reason), so the note IS the short form.
        short: fyb.relation === 'other' ? `${stem}${shownNote ? ` — ${shownNote}` : ''}` : stem,
        priority: 4,
      });
    }
  }

  // SPELLED OUT, not counted — the same reasoning `couldNotDetermine` already
  // gets below, applied to the field that needed it just as much.
  //
  // WHY THIS CHANGED (coordination-spec-adoption-2026-08-03, Phase 5). A COUNT of
  // things you do not know is not information: `⚠ 3 you-may-not-know` tells a
  // reader that three refs exist and nothing about whether any of them matters,
  // so the only way to act on it was a second `coord:read` call — which fired 15
  // times in a week against 1,611 sends. The refs ARE the payload and they are
  // short, so withholding them bought a few characters and cost the field its
  // entire read path. Measured: senders fill this field (274 entries in 7d) and
  // readers essentially never open it.
  //
  // AUTHORED FIRST, deliberately. An `authored` entry is the sender's MODEL of
  // what the recipient lacks — the theory-of-mind half, valuable precisely
  // because it can be wrong and be corrected (D-024/D-040). A `computed` entry is
  // the mechanical evidence-minus-watermark diff, which the reader can re-derive.
  // When the budget forces a choice, deliver the one they cannot reconstruct.
  const ymnk = sections.flatMap((s) => s.youMayNotKnow ?? []);
  if (ymnk.length && !derived.youMayNotKnow) {
    const ordered = [
      ...ymnk.filter((e) => e.provenance === 'authored'),
      ...ymnk.filter((e) => e.provenance !== 'authored'),
    ];
    const { shown, withheld } = boundedMarkerList(
      ordered.map((e) => String(e.ref ?? '')),
      YMNK_MARKER_BUDGET_CHARS,
    );
    parts.push({
      full:
        shown.length > 0
          ? `⚠ you may not know: ${shown.join('; ')}${withheld > 0 ? ` (+${withheld})` : ''}`
          : `⚠ ${ymnk.length} you-may-not-know`,
      short: `⚠ ${ymnk.length} you-may-not-know`,
      priority: 5,
    });
  }

  // Spelled out, not counted: this is the one that tells the receiver a question
  // is OPEN rather than answered, which is a different action.
  const cnd = sections.flatMap((s) => s.couldNotDetermine ?? []);
  if (cnd.length && !derived.couldNotDetermine) {
    parts.push({
      full: `? undetermined: ${cnd.map((c) => c.what).join('; ').slice(0, 120)}`,
      short: `? ${cnd.length} undetermined`,
      priority: 3,
    });
  }

  // P-012 / D-106: SPELLED OUT, and it carries the ASSUMPTION, not just the
  // question. A counted "1 clarification" would be worse than nothing here — the
  // recipient's whole reason to answer is that the sender is ALREADY ACTING on a
  // stated fallback, so the cost of staying silent is a peer proceeding on a
  // possibly-wrong assumption. Hiding `assuming` would hide exactly that stake.
  const clr = sections.flatMap((s) => s.clarify ?? []);
  if (clr.length && !derived.clarify) {
    parts.push({
      full: `?? ${clr.map((c) => `${c.question} (assuming: ${c.assuming})`).join('; ').slice(0, 160)}`,
      // NO `short` on purpose: per the reasoning above, a counted "1
      // clarification" is worse than nothing, so this fragment is all-or-nothing
      // and its high priority keeps it in.
      priority: 2,
    });
  }

  return allocateMarkerBudget(parts);
}

/**
 * Fit the marker fragments into ONE shared line budget, degrading a fragment to
 * its count form rather than dropping it.
 *
 * WHY THIS EXISTS. The `[coord+N]` line shares a ~200-char cap across ALL parts,
 * and the original code respected it the only way a per-field renderer can — by
 * counting ("⊨ 3 premises"). Spelling fields out field-by-field silently blew
 * that cap: four spelled-out fields worst-case is >400 chars, i.e. every fragment
 * gets longer and the READER's line gets truncated somewhere arbitrary. That is
 * strictly worse than counting, because a mid-word truncation loses content
 * without telling anyone it did.
 *
 * So the budget is allocated ONCE, by what most changes a reader's next action:
 *   1. BLOCKING            — a handful of chars, and it outranks everything
 *   2. ?? clarify          — a question whose sender is ALREADY acting on a stated assumption
 *   3. ? undetermined      — an OPEN question
 *   4. ∵ forYouBecause     — why THIS recipient
 *   5. ⚠ you may not know  — refs they likely lack
 *   6. ⊨ premises          — footing to re-check
 * Emission ORDER is unchanged (the visual line looks the same); only which
 * fragments get their full form under pressure is decided here.
 */
export function allocateMarkerBudget(
  parts: readonly MarkerPart[],
  totalBudget: number = AUTHORED_MARKER_TOTAL_BUDGET_CHARS,
): string[] {
  const byPriority = [...parts].sort((a, b) => a.priority - b.priority);
  const chosen = new Map<MarkerPart, string>();
  let budget = totalBudget;

  // Pass 1: everything gets at least its SHORT form, in priority order. A
  // fragment that cannot fit even short is dropped — but only after every
  // higher-priority fragment has been served.
  for (const p of byPriority) {
    const short = p.short ?? p.full;
    if (short.length + 3 <= budget) {
      chosen.set(p, short);
      budget -= short.length + 3; // + ' · ' separator
    }
  }
  // Pass 2: upgrade to the FULL form where the delta still fits, again by
  // priority — so the field that most changes a reader's action is the one that
  // gets spelled out when there is only room for one.
  for (const p of byPriority) {
    const cur = chosen.get(p);
    if (cur === undefined || cur === p.full) continue;
    const delta = p.full.length - cur.length;
    if (delta <= budget) {
      chosen.set(p, p.full);
      budget -= delta;
    }
  }

  // Emission order = declaration order, NOT priority order.
  return parts.filter((p) => chosen.has(p)).map((p) => chosen.get(p)!);
}

/**
 * The one-line `authored` marker a LIST row carries, or `undefined` when the message
 * authored nothing (so an ordinary send grows no new field). See
 * {@link authoredFieldParts} for why the list surfaces take the marker rather than the
 * full projection.
 */
export function authoredFieldsMarker(envelope: unknown): string | undefined {
  if (!envelope || typeof envelope !== 'object') return undefined;
  const parts = authoredFieldParts(envelope as Record<string, unknown>);
  return parts.length ? parts.join(' · ') : undefined;
}

/**
 * One section as a READER sees it: the authored fields, plus the premises already
 * classified (D-026) so no reader re-derives the staleness rule.
 */
export interface ProjectedSection {
  text: string;
  premises?: ClassifiedPremise[];
  forYouBecause?: ForYouBecause;
  youMayNotKnow?: YouMayNotKnowEntry[];
  couldNotDetermine?: CouldNotDetermineEntry[];
  clarify?: ClarifyEntry[];
}

/**
 * What a reader surface shows for the authored message fields. Mirrors D-064's
 * split exactly — envelope fields once, section fields per section — so the shape
 * itself teaches the rule rather than leaving it to prose.
 */
export interface AuthoredFieldsProjection {
  /** ENVELOPE (one per message). */
  expects?: string;
  blocking?: boolean;
  why?: MessageWhy;
  basedOn?: BasedOnEntry[];
  /** PER-SECTION (authored, genuinely varying between the parts of one message). */
  sections?: ProjectedSection[];
  /**
   * D-072: the fields whose values were DERIVED (owner-GUI defaults, machine
   * stamps) rather than authored by the sender. Carried explicitly because a
   * reader — and any adoption measurement — must be able to EXCLUDE them; an
   * unstamped default silently inflates exactly the numbers this plan is judged
   * on, which is the P-029 failure mechanised.
   */
  derivedFields?: string[];
}

/**
 * Project the authored fields off a stored envelope's `extra` into the shape above.
 *
 * WHY A SHARED HELPER: `coord:read`, `coord:thread` and the pui pane each returned
 * the flattened `body` string (or, for the pane, a hard field WHITELIST that dropped
 * `extra` entirely), so the structure a sender authored was invisible at every
 * surface that exists to inspect a message. Three hand-rolled unpackings of
 * `extra.sections` + `extra.premisesClassified` would be three chances to drift from
 * D-064's split — the near-synonym failure D-041 renamed to fix, multiplied by the
 * number of readers.
 *
 * Returns `undefined` when the message carries nothing authored, so a plain-string
 * message renders exactly as it does today.
 *
 * ⚠ PASS THE ENVELOPE ITSELF — **NOT** `envelope.extra`. There is no `extra` key on a
 * stored envelope and there never was: `sendCoordMessage` FLATTENS the caller's `extra`
 * onto the envelope (`env[k] = v`, messages.ts), so the authored fields land at the TOP
 * LEVEL of `coord_event_log.body` (`body->'sections'`, not `body->'extra'->'sections'`).
 * Measured 2026-08-02: of 14,705 messages in 7d, 88 carry top-level `sections` and
 * **0 carry an `extra` key at all**.
 *
 * This parameter was previously NAMED `extra`, and that name alone was enough to sink
 * the whole feature: all three call sites wired for P-033 (e) — coord:read, coord:thread
 * and the pui sync-resolver — dutifully passed `.extra`, i.e. `undefined`, so every one
 * of them returned `undefined` on every message and the authored structure was invisible
 * at every surface built to show it. The unit tests passed throughout, because they feed
 * `stampMessageFields(...)` output directly (the correct flattened shape) — so the
 * function was right, the tests were right, and only the argument was wrong. Renamed to
 * `envelope` so the next caller cannot make the same reading.
 */
export function projectAuthoredFields(envelope: unknown): AuthoredFieldsProjection | undefined {
  if (!envelope || typeof envelope !== 'object') return undefined;
  const e = envelope as Record<string, unknown>;

  const rawSections = Array.isArray(e.sections) ? (e.sections as MessageSection[]) : undefined;
  // Aligned BY INDEX with `sections` (that is how the send path stamps it).
  const classified = Array.isArray(e.premisesClassified)
    ? (e.premisesClassified as ClassifiedPremise[][])
    : undefined;

  const out: AuthoredFieldsProjection = {};

  if (typeof e.expects === 'string') out.expects = e.expects;
  if (typeof e.blocking === 'boolean') out.blocking = e.blocking;
  if (e.why && typeof e.why === 'object') out.why = e.why as MessageWhy;
  if (Array.isArray(e.basedOn) && e.basedOn.length) out.basedOn = e.basedOn as BasedOnEntry[];

  if (rawSections?.length) {
    const projected = rawSections.map((s, i): ProjectedSection => {
      const section: ProjectedSection = { text: s.text };
      // Prefer the send-time classification; fall back to classifying here so a
      // message stamped before `premisesClassified` existed still reads correctly
      // (D-026: a citation is never dropped for being unrecognised).
      const premises = classified?.[i] ?? (s.premises ?? []).map(classifyPremiseRef);
      if (premises.length) section.premises = premises;
      if (s.forYouBecause) section.forYouBecause = s.forYouBecause;
      if (s.youMayNotKnow?.length) section.youMayNotKnow = s.youMayNotKnow;
      if (s.couldNotDetermine?.length) section.couldNotDetermine = s.couldNotDetermine;
      if (s.clarify?.length) section.clarify = s.clarify;
      return section;
    });
    // Only surface sections that carry something beyond their text — an n=1
    // plain-string send must not grow a section block it never authored.
    if (
      projected.some(
        (s) => s.premises || s.forYouBecause || s.youMayNotKnow || s.couldNotDetermine || s.clarify,
      ) ||
      projected.length > 1
    ) {
      out.sections = projected;
    }
  }

  const provenance = e.fieldProvenance;
  if (provenance && typeof provenance === 'object') {
    const derived = Object.keys(provenance as Record<string, unknown>);
    if (derived.length) out.derivedFields = derived;
  }

  return Object.keys(out).length ? out : undefined;
}

/** Everything the send path stamps onto the envelope for these fields. */
export interface StampedMessageFields {
  sections?: MessageSection[];
  premisesClassified?: ClassifiedPremise[][];
  why?: MessageWhy;
  blocking?: boolean;
  basedOn?: BasedOnEntry[];
}

/**
 * Build the envelope stamp. Classification happens at SEND time (like the
 * `dependsOn` digests in P-008 (b)) so a reader never re-derives D-026's
 * staleness rule and cannot drift from it.
 */
export function stampMessageFields(input: {
  body?: string | MessageSection[];
  why?: MessageWhy;
  blocking?: boolean;
  basedOn?: BasedOnEntry[];
}): StampedMessageFields {
  const sections = toSections(input.body);
  const authored = sections.some(
    (s) =>
      s.premises?.length ||
      s.forYouBecause ||
      s.youMayNotKnow?.length ||
      s.couldNotDetermine?.length ||
      s.clarify?.length,
  );
  const stamp: StampedMessageFields = {};
  // Only stamp sections when they CARRY something — a plain-string send stays
  // byte-identical on the wire, so the n=1 case costs nothing.
  if (authored || sections.length > 1) {
    stamp.sections = sections;
    stamp.premisesClassified = sections.map((s) => (s.premises ?? []).map(classifyPremiseRef));
  }
  if (input.why) stamp.why = input.why;
  if (input.blocking !== undefined) stamp.blocking = input.blocking;
  // Omitted when empty, never stamped as `[]`: "I read nothing traceable" and
  // "the derivation found nothing" are indistinguishable to a reader, and only
  // one of them would be true.
  if (input.basedOn?.length) stamp.basedOn = input.basedOn;
  return stamp;
}
