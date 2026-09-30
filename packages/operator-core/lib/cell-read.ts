/**
 * cell-read.ts — reading a cell's VALUE (unified-agent-state-plane-2026-07-27 P-004,
 * per D-058).
 *
 * ── WHY THIS MODULE EXISTS ───────────────────────────────────────────────────
 *
 * `cell-registry.ts` stores CONTRACTS, not values. `getCell(cell, reader)` returns a
 * `CellSpec` whose `resolver` is a STRING NAME and whose `changeSignal` is
 * `{ kind:'poll', tool, path }` — a POINTER to where the value lives, not the value.
 * Nothing in the registry can invoke anything, and that is deliberate: the registry is
 * domain-free by construction (see its header), so dragging the operator's tool
 * dispatcher into it would be the wrong dependency.
 *
 * So the value read is this module: it composes the registry (which decides IF you may
 * read) with the read-only dispatcher (which decides WHETHER THE RESOLVER WILL ANSWER
 * YOU). It is the only place those two are composed, and every consumer in D-055's
 * enrichment map goes through it.
 *
 * ── ⚠ THE TWO-GATE PROBLEM THIS MODULE EXISTS TO RENDER HONESTLY (D-058) ─────
 *
 * Reading a cell's value passes TWO INDEPENDENT access gates:
 *
 *   1. `canReadCell(spec, reader)` — P-019, on the cell SPEC, keyed on `visibility`
 *      (workspace | harness | role | owner | work_item).
 *   2. the resolver TOOL's ROLE GATE — enforced on every dispatch
 *      (`dispatchReadOnlyTool` bypasses only { capability, quota }).
 *
 * THEY CAN DISAGREE, IN EITHER DIRECTION. A reader can pass a workspace-visible cell's
 * audience check and still be refused by the resolver tool's role gate.
 *
 * That disagreement must NOT collapse to "absent" and must NOT surface as an error:
 *
 *   • ABSENT would be a LIE. `absent` is reserved for "this cell does not exist for
 *     you", and a reader who passed `canReadCell` is entitled to know that it does.
 *     Reporting absent here would also corrupt the one signal `absent` carries.
 *   • AN ERROR would be a category mistake and would break every consumer, because
 *     P-026 requires the projection be TOTAL — an enrichment must never be able to
 *     fail the operation it decorates.
 *
 * So it is an in-band, ENUMERATED unknown (`cell-contract.ts`), which is exactly the
 * mechanism axis 2 already provides. This is the SECOND time this plan has hit the
 * two-access-model composition problem — D-056 found it between the goal (a cell) and
 * the assumptions (facts) — which is why it is handled structurally here rather than
 * case-by-case at each consumer.
 *
 * ── WHY NO FIFTH UNKNOWN CODE ────────────────────────────────────────────────
 *
 * `cell-contract.ts` states that adding a code is a CONTRACT CHANGE, because every
 * caller's branch set changes with it. An access refusal is not a new kind of answer:
 * its correct caller response is `not-measured`'s stated lever verbatim — "ask for it,
 * not retry the same call" (here: obtain the role, or ask a peer who holds it). So it
 * maps onto the existing code, with `detail` carrying the specifics. Mapping is
 * recorded in `UNKNOWN_FOR_DISPATCH_CODE` below so it is auditable rather than folded
 * into an if-chain.
 */

import { cellUnknown, formatCellUnknown, type CellUnknown } from './cell-contract';
import {
  getCell,
  type CellAssessmentSpec,
  type CellHeadlineSource,
  type CellPointer,
  type CellReader,
  type CellSpec,
} from './cell-registry';
/**
 * The TOTAL own-key path walk, shared with the door stamper rather than re-implemented
 * here. `state-plane-stamp` imports only `cell-registry`, so this direction adds no
 * cycle — and reusing it keeps ONE definition of "did this path actually arrive" for
 * the whole cell system, which is the question every lens in this file turns on.
 */
import { pathExists } from './state-plane-stamp';
import {
  dispatchReadOnlyTool,
  isAccessDenialCode,
  ReadOnlyDispatchError,
  type ReadOnlyDispatchEnv,
  valueAtPath,
} from './events/await/predicate-watch';

/**
 * The outcome of a cell value read. Three-valued by construction (D-038 axis 2), and
 * the three are NOT interchangeable — each implies a different caller response:
 *
 *   • `value`   — the measurement succeeded. Act on it.
 *   • `unknown` — the cell EXISTS FOR YOU but produced no value. Branch on
 *                 `unknown.code`; the lever differs per code.
 *   • `absent`  — the cell does not exist for you: unregistered, OR registered but
 *                 outside your audience. INDISTINGUISHABLE BY DESIGN (P-019) so a
 *                 refusal cannot be used as a probe oracle to enumerate narrow cells.
 */
export type CellRead =
  | {
      status: 'value';
      cell: string;
      value: unknown;
      headline: string;
      resolver: string;
      /**
       * Axis 6 — the optional total order declared by the cell. This is metadata
       * about the value, not a second resolver result, so project it from the
       * registered spec alongside the other read lenses. Omitted means the cell
       * deliberately has no ordering opinion; never manufacture an empty order.
       */
      ordered?: { stages: string[] };
      /**
       * P-021 — the MATERIAL answer, present only when the spec declares
       * `materiality` AND that path resolved in this same result.
       *
       * ⚠ EXTRACTED FROM THE DISPATCH THAT ALREADY HAPPENED — never a second
       * call. That is axis 5 applied to materiality: the material answer is a
       * LENS on the one derivation, so declaring it costs no resolver work and
       * cannot drift from the value it qualifies.
       *
       * ABSENT when the declared path is not in the result. That case is a
       * registration drift, and callers must treat it as "cannot compare
       * materially" and fall back to the LOUD reading — never as "nothing
       * material changed", which is the silent-suppression failure the
       * `materiality.why` rule exists to keep auditable.
       */
      material?: { path: string; value: unknown };
      /**
       * WI-36259 — WHERE THIS READ'S HEADLINE CAME FROM, present only when the spec
       * declares `headlineSource`. The runtime companion to the spec's STATIC
       * `provenance`: that one says how the cell was evidenced at registration, this one
       * says whether the value in YOUR HAND is an observation or an inference.
       *
       * Read `authoritative`, not `value` — it is the branchable form, so a consumer does
       * not have to learn each resolver's private source enum. It is false whenever the
       * label is missing, unrecognised, or non-authoritative, so this can only ever
       * downgrade trust and never manufacture it.
       */
      source?: CellSourceRead;
      /**
       * D-008 — WHAT THE VALUE MEANS. Present exactly when the spec declares a non-null
       * `assessment`, which since P-006 is EVERY value-bearing cell: the field is
       * required on `CellSpec` and only an event-signalled cell may answer `null`
       * (D-016), because it has no resolver payload to read a code out of.
       *
       * ⚠ ABSENT HERE MEANS "EVENT-SIGNALLED CELL", NEVER "NOTHING TO REPORT". A cell
       * that could not assess says so INSIDE the field — `status:'unavailable'` — so a
       * consumer must not read an absent `assessment` as an all-clear. That collapse
       * is the same one `ordered` documents ("absence means no opinion, never clear").
       */
      assessment?: CellAssessmentRead;
      /**
       * Axis 2 — WHY this headline is genuinely total. Present exactly when the
       * spec declares `whyTotal`, which registration permits only on a
       * non-nullable cell. This is the caller-visible twin of `unknownHoist`:
       * nullable cells carry the measured unknown channel; total cells carry the
       * author's attestation that their resolver cannot fail into a default.
       */
      totality?: { why: string };
      /**
       * D-039 — THE HOIST. Present exactly when the spec declares `unknownHoist`,
       * which the registry allows only on a `nullable` cell (axis 2). Carries the
       * RESULT-LEVEL unknown channel the resolver already emits — `positionsUnknown[]`,
       * `verdictUnknown[]`, `goalUnknown` — so `value: null` is never handed to a
       * caller with the reason stripped off.
       *
       * ⚠ EMITTED WHETHER OR NOT THE HEADLINE IS NULL, and that is the point rather
       * than an oversight. The hoist is RESULT-level, not headline-level: a
       * `git.pipelinePosition` read can answer `positions.deployed = true` while
       * `positionsUnknown` names `inMain` as never measured. Gating the hoist on a
       * null headline would drop exactly that case — an unknown leg hiding behind a
       * known one, which is the shape of the defect D-039 exists to surface.
       */
      unknownHoist?: CellHoist;
      /** P-006 — see `CellPointerRead`. Present exactly when the spec declares pointers. */
      pointers?: CellPointerRead[];
    }
  | {
      status: 'unknown';
      cell: string;
      unknown: CellUnknown;
      /**
       * P-006 — CARRIED ON AN UNKNOWN TOO, which is the case that most needs it rather
       * than an afterthought. A pointer is a property of the SPEC, not of the payload,
       * so it survives a resolver that produced nothing — and the cell it names has its
       * OWN resolver. A reader whose `gate.greenCheckpoint.verdict` read just failed can
       * still learn who owns the incident, because `readGateOwnership()` is a different
       * apparatus that has not necessarily failed with it.
       */
      pointers?: CellPointerRead[];
    }
  /**
   * ⚠ NO `pointers` HERE, deliberately. `absent` means "unregistered OR outside your
   * audience", held indistinguishable by P-019 so a refusal cannot be probed as an
   * oracle. Attaching this cell's pointers to that refusal would name its neighbours
   * to a reader who may not see the cell itself — turning the one result that is
   * carefully uninformative into an enumeration surface.
   */
  | { status: 'absent'; cell: string };

/**
 * The hoisted result-level unknown channel, named so a consumer can branch on it
 * without reading the registry to learn what to look for.
 *
 * `key` is the declared field name (`spec.unknownHoist`) — carried rather than
 * spliced in as a dynamic top-level key, because a caller that must first consult
 * the spec to know which key to read is the "hurried consumer" D-039's rule is
 * written against. A fixed field is what a caller cannot miss.
 *
 * `drifted` distinguishes the two ways this channel can be quiet, which demand
 * OPPOSITE responses and are indistinguishable without it:
 *
 *   • absent flag, `value: []` / `null` — the resolver MEASURED and has nothing to
 *     report. A real negative result, and the one worth trusting: a hoist that fired
 *     on the healthy path is one agents learn to ignore.
 *   • `drifted: true` — the declared key was NOT in the resolver's result at all.
 *     The channel is broken, not silent. This is the failure that produced this
 *     field (the hoist was declared on six cells, enforced at registration, and
 *     emitted by nothing), so it is reported LOUDLY rather than omitted.
 */
/**
 * P-006 — a resolved pointer to the cell that answers the reader's NEXT question.
 * See `CellSpec.pointers` for the declaration side.
 *
 * `when`/`answers` are carried straight from the spec (never re-derived), for the same
 * reason `CellAssessmentRead` carries its declared `meaning`/`safeAction`: a reader
 * should not have to go read the registry to know whether following the pointer is
 * worth a dispatch.
 *
 * ⚠ THE UNRESOLVED CASE IS DELIBERATELY *NOT* SPLIT, and this reverses the first draft
 * of this file — recording the reversal because the reasoning that produced it is the
 * kind that looks airtight from inside.
 *
 * The draft resolved the target through `getCellUnchecked` + `canReadCell` and reported
 * two flags: `drifted` (in no registry — a declaration defect) and `hidden` (registered
 * but outside YOUR audience — real, go ask a peer). That genuinely IS more useful, and
 * it is exactly the `CellHoist.drifted` lesson applied one level out. It is also a
 * P-019 violation: those two states are the SAME two `absent` holds indistinguishable
 * for the cell being read, and splitting them here re-opens the enumeration oracle that
 * closes there — a narrow cell's EXISTENCE becomes observable to a reader who may not
 * see it, just by reading whatever ordinary cell points at it. `cell-access-parity`'s
 * LEG C caught it.
 *
 * The mitigating argument — that the target is author-declared, not caller-chosen, so
 * there is no probe — is true and still not worth taking: it makes the leak's size a
 * function of what future authors declare, which is not a property this file controls.
 * So the target is resolved through the CHECKED accessor and the two collapse into one
 * `unresolved`, whose prose names BOTH possibilities exactly as `absent`'s does. The
 * cost is one wasted hop for a reader whose peer could have answered; the alternative
 * cost was a disclosure channel that grows silently.
 */
export interface CellPointerRead {
  /** The cell id to read next. */
  cell: string;
  /** The CONDITION under which to follow it (`CellPointer.when`). */
  when: string;
  /** WHAT is answered over there (`CellPointer.answers`). */
  answers: string;
  /**
   * True ⇒ the target did not resolve FOR YOU: unregistered, OR registered and outside
   * your audience. Held indistinguishable on purpose (P-019) — see this interface's doc.
   */
  unresolved?: true;
}

/**
 * WI-36259 — the projected per-read provenance of a cell's headline.
 * See `CellSpec.headlineSource` for the declaration side.
 */
export interface CellSourceRead {
  /** The declared path this label was read from. */
  path: string;
  /** The label the resolver attached, or null when it attached none / a non-string. */
  value: string | null;
  /** THE BRANCHABLE ANSWER: was this headline a direct observation? Fails safe to false. */
  authoritative: boolean;
  /** What the non-authoritative reading degrades to — carried from the spec, for the caller. */
  why: string;
}

export interface CellHoist {
  key: string;
  value: unknown;
  /** True ⇒ the declared key sits below an explicit null parent in the resolver result.
   *  This is a measured nullable absence, not a missing key or registration drift. */
  nullTerminated?: true;
  /** True ⇒ the declared key was absent from the resolver result: registration
   *  drift, NOT a measured silence. `value` is null and means nothing. */
  drifted?: true;
  /** True ⇒ the declared key was absent, but the PAYLOAD ITSELF declares it was
   *  truncated by its door, so the absence is UNATTRIBUTABLE — see
   *  {@link payloadTruncatedByDoor}. Mutually exclusive with `drifted`. */
  truncatedByDoor?: true;
  /** The re-read that would return the untruncated payload, carried straight from the
   *  door's own `projection.fullRead` — the lever, so the reader never has to guess it. */
  fullRead?: unknown;
}

/**
 * D-008 — ONE declared evidence path, delivered with the code it substantiates.
 *
 * Carries the same MISSING ≠ NULL split as `CellHoist`, for the
 * same reason and by the same own-key walk: a resolver that MEASURED and found null
 * and a path that never arrived demand opposite responses, and collapsing them is the
 * defect this whole plan exists to close.
 */
export interface CellAssessmentEvidence {
  /** The declared path, carried so a caller need not consult the registry to read `value`. */
  path: string;
  /** The value AT that path in this SAME resolver payload — never a second dispatch. */
  value: unknown;
  /** True ⇒ the path sits below an explicit null parent: a measured nullable absence,
   *  not a missing key or registration drift. */
  nullTerminated?: true;
  /** True ⇒ the path was absent from the payload: registration or resolver drift. */
  drifted?: true;
  /** True ⇒ absent, but the payload declares ITSELF truncated, so the absence is
   *  UNATTRIBUTABLE. Mutually exclusive with `drifted`. */
  truncatedByDoor?: true;
  /**
   * main-green-status-visible-2026-09-03 P-012 — THE MEASURED-NESS FLAG, CARRIED WITH
   * THE VALUE. Present exactly when the spec pairs this path in
   * `assessment.measuredBy`, and resolved off the SAME payload. A count or a list never
   * reaches a caller alone: `failingLegs: []` arrives as `[]` + `whyNot.measured =
   * false`, and the caller who reads only the value still cannot miss that it was
   * carried rather than measured. The flag keeps its own semantics (boolean, enum,
   * reason-or-null); nothing here interprets it. `drifted` ⇒ the flag path did not
   * arrive, which is registration drift on the PAIRING and is reported as such.
   */
  measuredBy?: { path: string; value: unknown; nullTerminated?: true; drifted?: true };
}

/**
 * D-008 — THE DECISION-READY HALF OF A CELL READ: what the raw value MEANS and what
 * is safe to do about it.
 *
 * Two branches, and the split is the contract's central safety property: generic
 * code can TRANSPORT a domain code but can never INVENT one. Every failure — an
 * undeclared code, an absent assessment path, an absent evidence path, a
 * door-truncated payload — converges on `unavailable`. There is no third branch and
 * no partial-credit code, because the one thing worse than "I cannot assess this" is
 * a plausible enum nobody measured.
 *
 * ⚠ `safeAction` IS PRESENT ON BOTH BRANCHES, and that is deliberate rather than an
 * oversight in the unavailable case. A caller who learns only that the assessment
 * failed is exactly the hurried consumer this registry's axis-2 rule is written
 * against — they have a raw value in hand and no stated reason not to act on it. The
 * unavailable branch therefore still answers "what may I safely do", and its answer
 * is the conservative one.
 */
export type CellAssessmentRead =
  | {
      status: 'resolved';
      /** The declared assessment path this code was read from. */
      path: string;
      /** The code, guaranteed to be one of the spec's declared keys. */
      code: string;
      /** The declared `meaning` for that code — carried, never re-derived. */
      meaning: string;
      /** The declared `safeAction` for that code. */
      safeAction: string;
      /** Every declared evidence path, resolved off the same payload. */
      evidence: CellAssessmentEvidence[];
    }
  | {
      status: 'unavailable';
      path: string;
      /** ALWAYS null. Present as an explicit null rather than omitted so a consumer
       *  reading `assessment.code` gets a falsy value instead of `undefined` on a
       *  branch it forgot to check. */
      code: null;
      /** ALWAYS null, for the same reason as `code`. */
      meaning: null;
      /** The conservative action — see the type doc above for why this survives here. */
      safeAction: string;
      /** Carried even here: WHICH evidence arrived is often the diagnosis. */
      evidence: CellAssessmentEvidence[];
      /** WHY it is unavailable, in the existing in-band vocabulary (D-008: read health
       *  uses `CellUnknown`, never a domain enum). */
      unknown: CellUnknown;
      /** True ⇒ the payload declared itself door-truncated, so the assessment did not
       *  survive transit rather than never being measured. */
      truncatedByDoor?: true;
      /** The re-read that returns the untruncated payload. */
      fullRead?: unknown;
    };

/**
 * The `safeAction` handed back when no code resolved.
 *
 * Stated once, here, rather than composed per call site: this is the sentence a
 * caller acts on in the exact situation where the read has least to tell them, and a
 * variant of it drifting into "could not assess" — a fact, not an action — is how the
 * branch would quietly stop being useful.
 */
const ASSESSMENT_UNAVAILABLE_SAFE_ACTION =
  'Do not act on this cell as though it carried a verdict: no assessment resolved, so the raw value is UNINTERPRETED — not benign. Read the evidence below, or re-read the cell, before treating the value as decision input.';

/**
 * Render a value compactly enough to sit in a summary line or a wake turn without
 * becoming it.
 *
 * Shared rather than copied (D-014): D-008 requires pull, push and subscription
 * consumers to project the SAME read contract, and a value that renders one way in
 * `state:read` and another way in a delivery-time fold is that contract already broken.
 */
export function briefCellValue(value: unknown, max = 120): string {
  let s: string;
  try {
    s = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    s = String(value);
  }
  if (s === undefined) s = String(value);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * One declared evidence path, with MISSING and TRUNCATED kept loud and distinct from a
 * measured null — the same three-way split `CellAssessmentEvidence` encodes, carried
 * into prose so a reader who never inspects the payload still cannot conflate them.
 */
function assessmentEvidenceNote(e: CellAssessmentEvidence): string {
  if (e.truncatedByDoor) {
    return `${e.path} = TRUNCATED IN TRANSIT (unattributable — re-read for the full payload)`;
  }
  if (e.drifted) {
    return `${e.path} = ABSENT from the resolver result (registration drift, NOT a measured null)`;
  }
  // P-012: a paired count/list is never printed bare — its flag is printed in the same
  // breath, so the prose surface cannot render "[]" as "nothing failing" either.
  const flag =
    e.measuredBy === undefined
      ? ''
      : e.measuredBy.drifted
        ? ` (⚠ measured-ness flag ${e.measuredBy.path} ABSENT — pairing drift; do not read this value as measured)`
        : ` (measured-ness: ${e.measuredBy.path} = ${briefCellValue(e.measuredBy.value, 80)})`;
  return `${e.path} = ${briefCellValue(e.value)}${flag}`;
}

/**
 * P-005 / D-014 — THE DECISION-READY HALF, RENDERED FIRST.
 *
 * ⚠ THE CODE IS TRANSPORTED, NEVER RE-DERIVED (D-012 ruling 2). `code`, `meaning` and
 * `safeAction` are read straight off the resolved branch. Recomputing any of them from
 * `evidence` would be the "enrich a consumer surface" move that ruling forbids, and it
 * would be silently WRONG in the ordinary case rather than merely impure: a door-bounded
 * payload legitimately drops evidence fields, while the code — computed inside the
 * resolver before any door — survives. Evidence EXPLAINS a verdict here; it never
 * produces one.
 *
 * ⚠ NOT QUIET ON THE HEALTHY PATH, unlike `formatCellHoist` and the source caveat, and
 * D-014 records why the asymmetry stops here. Those two QUALIFY a headline the reader
 * already holds, so saying nothing when nothing is wrong costs nothing. This IS the
 * answer. Printing it only when it is MISSING would mean semantics are visible solely in
 * their absence — which teaches exactly the habit this plan exists to remove: read the
 * number, infer the meaning yourself. A `healthy` code is not the string "normal"; it is
 * a measured verdict from a closed vocabulary, and it carries a safeAction.
 */
export function formatCellAssessment(a: CellAssessmentRead, cell: string): string {
  const evidence = a.evidence.length === 0 ? null : a.evidence.map(assessmentEvidenceNote).join('; ');
  if (a.status === 'resolved') {
    return [
      `ASSESSMENT ${a.code} — ${a.meaning}`,
      `safe action: ${a.safeAction}`,
      ...(evidence === null ? [] : [`evidence: ${evidence}`]),
    ].join(' · ');
  }
  return [
    `⚠ UNINTERPRETED: no assessment resolved for ${cell} — ${formatCellUnknown(a.unknown)}${
      a.truncatedByDoor ? ' (the payload declared ITSELF truncated, so the absence is unattributable)' : ''
    } ${a.safeAction}`,
    ...(evidence === null ? [] : [`evidence: ${evidence}`]),
    // The door's own escape hatch outlived the retired axis-1 contract it was first
    // built for: when the payload truncated itself, the ONE useful next move is the
    // untruncated re-read.
    ...(a.fullRead === undefined ? [] : [`full read: ${briefCellValue(a.fullRead, 240)}`]),
  ].join(' · ');
}

/**
 * The SAME assessment as an indented block, for a wake turn — P-005 requires
 * `cell-wake-fold` to render the identical delivery-time contract. Same fields, same
 * loudness, same transported code; only the line shape differs, which is precisely why
 * both shapes are built here instead of once per call site.
 */
export function cellAssessmentLines(a: CellAssessmentRead, indent = '  '): string[] {
  const lines: string[] =
    a.status === 'resolved'
      ? [`${indent}assessment · ${a.code} — ${a.meaning}`, `${indent}  safe action · ${a.safeAction}`]
      : [
          `${indent}⚠ assessment · UNINTERPRETED — ${formatCellUnknown(a.unknown)}${
            a.truncatedByDoor ? ' (payload declared ITSELF truncated; unattributable)' : ''
          }`,
          `${indent}  safe action · ${a.safeAction}`,
          ...(a.fullRead === undefined ? [] : [`${indent}  full read · ${briefCellValue(a.fullRead, 240)}`]),
        ];
  for (const e of a.evidence) lines.push(`${indent}  evidence · ${assessmentEvidenceNote(e)}`);
  return lines;
}

/**
 * Render a hoist for a prose surface, or `null` when it has nothing to say.
 * Mirrors `formatCellUnknown` — `key`/`value` tell a program what to do, this tells
 * a reader why, and neither replaces the other.
 *
 * ⚠ RETURNS NULL ON A MEASURED SILENCE, deliberately. An empty `verdictUnknown: []`
 * means the resolver looked and found nothing unknown, and announcing that on every
 * healthy read is how a warning becomes noise a reader learns to skip — which would
 * cost exactly the case the hoist exists for. Prose is spent only when the channel
 * has something.
 */
export function formatCellHoist(h: CellHoist): string | null {
  /**
   * WI-38266 — checked BEFORE `drifted`, and the order is the whole point: these two
   * absences look identical on the payload and demand OPPOSITE actions. Drift sends you
   * to fix a resolver; truncation sends you to re-read it. Getting this backwards is what
   * made the old prose accuse a blameless resolver of a registration defect.
   */
  if (h.truncatedByDoor) {
    return (
      `⚠ this cell's result-level unknown channel "${h.key}" did not arrive, but its resolver's response declares ` +
      `ITSELF truncated — so the absence is UNATTRIBUTABLE: it may have been dropped in transit to fit a response ` +
      `budget rather than never measured. Do NOT read this as a resolver defect, and do NOT read the null as a ` +
      `clean measurement. Re-read the untruncated payload` +
      (h.fullRead === undefined ? '' : ` via ${JSON.stringify(h.fullRead)}`) +
      ` to get the real qualifier.`
    );
  }
  if (h.drifted) {
    return `⚠ this cell declares the result-level unknown channel "${h.key}", but its resolver did not emit it. The reason a null value carries is MISSING, not empty — treat a null here as unexplained, and read this as a registration defect in the resolver rather than a clean measurement.`;
  }
  if (h.value === null || h.value === undefined) return null;
  if (Array.isArray(h.value) && h.value.length === 0) return null;
  /**
   * ⚠ "QUALIFIES", NOT "IS UNKNOWN". A loud hoist carries the REASON the headline is
   * not a positive verdict, and that reason is itself MEASURED — `goalUnknown:
   * "nothing-held"` is a fact about an agent that holds nothing, not a failure to
   * look. Calling it "unknown rather than measured" (this line's first draft, caught
   * on the live read) would be confidently wrong about the most ordinary case there
   * is — the same misdiagnosis the flattened `goalRef` headline was chosen to avoid.
   */
  return `⚠ "${h.key}" is not empty — this answer carries a QUALIFIER you should read before acting on the headline: ${JSON.stringify(h.value)}.`;
}

/**
 * P-006 — render pointers for a prose surface, or `null` when there are none.
 *
 * ⚠ UNCONDITIONAL BY CONSTRUCTION, and this is a stated limitation rather than an
 * oversight. `CellPointer.when` is ADVISORY PROSE — the reader self-gates on it; nothing
 * evaluates it. Gating emission would need a predicate over the payload, and this file's
 * own materiality doc-block already settled that question in the opposite direction
 * ("until it exposes one, that cell correctly stays un-gated rather than gaining a
 * threshold DSL"). A pointer is also the one channel where firing on the healthy path is
 * survivable: it is short, it carries its own condition, and — unlike a hoist — it makes
 * no claim about the headline, so a reader who skips it has lost nothing but a hop.
 *
 * That is exactly why `when` is REQUIRED at registration. The condition cannot gate the
 * channel, so it has to be legible IN the line, or an agent reading a healthy gate is
 * told to go look at ownership for no reason.
 */
export function formatCellPointers(pointers: CellPointerRead[]): string | null {
  if (pointers.length === 0) return null;
  return pointers
    .map((p) =>
      p.unresolved
        ? `⚠ this cell points at "${p.cell}", which does not resolve FOR YOU — it may not exist, or it may be outside your audience; these are deliberately indistinguishable (P-019). It would have answered ${p.answers}. Ask a peer who may hold that audience; do NOT reconstruct the value from another surface.`
        : `↪ next, ${p.when}: read \`state:read { cell: '${p.cell}' }\` — ${p.answers}`,
    )
    .join(' · ');
}

/**
 * Dispatcher error code → unknown code. Explicit and total-by-fallback rather than an
 * if-chain, so the classification is readable in one place and testable directly.
 *
 * ACCESS refusals (`role_not_allowed`, `missing_role`, `capability_denied`, …) →
 * `not-measured`: the resolver was never allowed to look, and the lever is to obtain
 * access, not to retry. EVERYTHING ELSE (a timeout, a handler error, an unreachable
 * dependency) → `resolver-failed`: retry-or-escalate.
 */
export function unknownForDispatchError(err: ReadOnlyDispatchError): CellUnknown {
  if (isAccessDenialCode(err.code)) {
    return cellUnknown(
      'not-measured',
      `the resolver refused this reader (${err.code}) — you may see this cell but not read through its resolver. ` +
        'Obtain the role the resolver requires, or ask a peer who holds it; retrying this call unchanged will not help.',
    );
  }
  if (err.code === 'not_read_only' || err.code === 'unknown_tool') {
    return cellUnknown(
      'resolver-failed',
      `this cell's resolver is not usable as a read (${err.code}: ${err.message}). This is a REGISTRATION defect, ` +
        'not a transient failure — the cell should not have registered with this resolver.',
    );
  }
  return cellUnknown('resolver-failed', err.message);
}

/**
 * Detect whether a resolver payload looks like an ERROR/sentinel result rather than a
 * real one — checks the conventional `error` and `data.error` string fields a
 * read-only tool uses to report "I could not answer" without throwing (dispatch stays
 * total; see `readCell`'s own no-throw contract). Not exhaustive — a resolver may
 * error-shape differently — but these two cover the case that actually misdiagnosed
 * (EI-18790908999972569 / D-067 defect 2): a `global`-relativity cell dispatches `{}`,
 * and the tool opens with `if (!args.path && !args.sha) return { data: { error: … } }`.
 * Returning the message (not just a boolean) lets the caller quote the resolver's own
 * diagnosis instead of asserting a cause it never measured.
 */
function errorShapeMessage(payload: unknown): string | undefined {
  if (payload === null || typeof payload !== 'object') return undefined;
  const obj = payload as Record<string, unknown>;
  if (typeof obj.error === 'string') return obj.error;
  const data = obj.data;
  if (data !== null && typeof data === 'object') {
    const err = (data as Record<string, unknown>).error;
    if (typeof err === 'string') return err;
  }
  return undefined;
}

/** The dispatch env a cell read runs under. Every field is already known at the call
 *  site (identity + request context), so resolving one costs no lookup. */
export interface CellReadEnv {
  workspaceId: string;
  harnessSlug: string | null;
  /** The role the resolver dispatch runs under — the SECOND gate. Never widened. */
  role: string;
  /** Host-supplied wearer authority for identity templates; absent for legacy internal reads. */
  callerContext?: ReadOnlyDispatchEnv['callerContext'];
  signal?: AbortSignal;
}

/**
 * WI-6488 — the bound `readCell`'s own header always claimed but never had. Overridable
 * for tests / an unusually slow resolver (e.g. a `git rev-list` over a large history);
 * defaults to the same order of magnitude as the sync resolver's own
 * `PAPERCUSP_SYNC_RESOLVER_TIMEOUT_MS` (10s) so a hung resolver on a hot path (a lock
 * acquire, a claim, a presence read) cannot wedge its caller forever.
 *
 * Deliberately the NARROWEST of the three fix directions the bug report weighed: it
 * bounds `readCell`'s own WAIT on the dispatch, not the dispatch itself — this does NOT
 * cancel the underlying resolver call (this caller does not supply the optional
 * AbortSignal accepted by `dispatchReadOnlyTool`), so a resolver that leaks a lock or a
 * connection on its own is still a bug worth fixing separately. What this closes is
 * the specific failure this module documents: a caller on a hot path — a lock acquire,
 * a claim, a presence read — waiting on `readCell` forever because ITS resolver hung.
 *
 * (`bounded-timeout.ts`'s `withBoundedTimeout` was considered and deliberately NOT
 * reused here — it unconditionally `console.warn`s and swallows every rejection into a
 * generic degraded result, which is right for its own independent-fan-out-reads use case
 * but wrong for gate 2: a resolver rejection here is an ordinary, already-classified
 * outcome — e.g. an access-denial `ReadOnlyDispatchError` — that must keep its typed
 * `.code` and must not log. Only the deadline is novel, so only the deadline is raced in
 * by hand, immediately below.)
 */
export const CELL_READ_TIMEOUT_MS = Number(process.env.PAPERCUSP_CELL_READ_TIMEOUT_MS) || 10_000;

/**
 * Read one cell's value AS a specific reader.
 *
 * TOTAL — never throws, and (WI-6488) never waits past CELL_READ_TIMEOUT_MS either.
 * Every consumer of this is on a hot path (a lock acquire, a claim, a presence read),
 * and P-026 rule (f) makes that a requirement rather than a courtesy: an enrichment
 * that can throw — or hang — is an enrichment that can fail the operation it decorates.
 * A resolver that never settles now produces a `resolver-failed` unknown instead of
 * wedging its caller forever; see CELL_READ_TIMEOUT_MS's doc comment for the bound's
 * scope (it stops readCell WAITING, it does not cancel the resolver dispatch).
 *
 * @param subject the value for a `callerRelativity: { kind:'parameter' }` cell — i.e.
 *   WHAT the cell is being read about (an ownerId for the goal cell, a path for the
 *   pipeline cell). It is NOT an identity override: the audience check always runs
 *   against `reader`, so passing a subject can never widen what you may see.
 */
export async function readCell(
  cell: string,
  reader: CellReader,
  env: CellReadEnv,
  subject?: string,
): Promise<CellRead> {
  const read = await readCellValue(cell, reader, env, subject);

  /**
   * P-006 — ATTACH POINTERS IN EXACTLY ONE PLACE.
   *
   * `readCellValue` has eight return sites across three status shapes; decorating each
   * would make "does this path carry pointers" a per-branch accident, and the branch
   * most likely to be forgotten is the rarest one — a resolver failure — which is
   * precisely where the pointer is worth most. Wrapping means a new return site inside
   * inherits this rather than opting into it.
   *
   * `absent` is skipped by the union's own shape (see its doc comment): pointers must
   * not turn a deliberately-uninformative refusal into an enumeration surface.
   */
  if (read.status === 'absent') return read;
  // The CHECKED accessor, though a non-absent result already proves this reader passed
  // the audience gate: `readCellValue` opens with the same call and returns `absent`
  // when it misses. Using the unchecked one here would be a bypass that happens to be
  // safe today — and `cell-access-parity` LEG C is right to refuse that distinction.
  const pointers = getCell(cell, reader)?.pointers;
  if (!pointers?.length) return read;
  return { ...read, pointers: pointers.map((p) => resolvePointer(p, reader)) };
}

/**
 * P-006 — resolve one declared pointer AGAINST THIS READER.
 *
 * Reads the registry only; never dispatches. The pointer says where to go, and the
 * caller decides whether to pay for the hop — resolving the target's VALUE here would
 * turn one read into an unbounded fan-out and re-derive a cell this one does not own.
 *
 * `getCell` is the CHECKED accessor: it returns undefined for an unregistered cell AND
 * for one outside `reader`'s audience, without saying which. That merge is the point,
 * not a limitation — see `CellPointerRead`.
 */
function resolvePointer(p: CellPointer, reader: CellReader): CellPointerRead {
  const base = { cell: p.cell, when: p.when, answers: p.answers };
  return getCell(p.cell, reader) ? base : { ...base, unresolved: true };
}

async function readCellValue(
  cell: string,
  reader: CellReader,
  env: CellReadEnv,
  subject?: string,
): Promise<CellRead> {
  // GATE 1 — audience. Unreadable is indistinguishable from unregistered (P-019), so a
  // stranger cannot enumerate narrow cells by probing for a different refusal.
  const spec = getCell(cell, reader);
  if (!spec) return { status: 'absent', cell };

  // An event-signalled cell names no tool to call, so there is nothing for a
  // synchronous read to invoke. NOT `not-applicable`: the question applies perfectly
  // well, the cell simply exposes no poll resolver — and the lever (give it one) is
  // exactly `not-measured`'s "ask for it".
  if (spec.changeSignal.kind !== 'poll') {
    return {
      status: 'unknown',
      cell,
      unknown: cellUnknown(
        'not-measured',
        `this cell is event-signalled (key "${spec.changeSignal.key}") and exposes no poll resolver, so it cannot be ` +
          'read synchronously. Subscribe to it with state:subscribe instead.',
      ),
    };
  }

  // Axis 3 — a parameter-relative cell cannot be read without its subject. More INPUT
  // is the lever, which is `insufficient-data` exactly; the detail names the parameter
  // so the caller does not have to go read the spec to find out what is missing.
  const args = argsForRelativity(spec, subject);
  if (args === MISSING_SUBJECT) {
    return {
      status: 'unknown',
      cell,
      unknown: cellUnknown(
        'insufficient-data',
        `this cell is relative to "${(spec.callerRelativity as { param: string }).param}" and no subject was supplied — ` +
          `pass it (state:read { cell, as }) to say WHAT you are asking about.`,
      ),
    };
  }

  // GATE 2 — the resolver tool's own role gate, enforced on the dispatch.
  //
  // ⚠ RACED AGAINST A DEADLINE (WI-6488) — this module's own header claims TOTAL, but
  // "never throws" and "always terminates" are different properties, and only the first
  // held before this fix. A resolver that never settles must not make readCell never
  // settle either, on consumers this module itself names as hot paths (a lock acquire, a
  // claim, a presence read). See CELL_READ_TIMEOUT_MS above for why this bounds the WAIT
  // rather than cancelling the dispatch.
  //
  // NOT `bounded-timeout.ts`'s `withBoundedTimeout`: that helper unconditionally
  // console.warns and swallows EVERY rejection into a generic "degraded" result — right
  // for its own fan-out-of-independent-reads use case, wrong here, where a resolver
  // rejection (e.g. an access-denial `ReadOnlyDispatchError`) is an ORDINARY, already-
  // handled outcome of this gate that must keep its typed `.code` for classification
  // below and must NOT log. Only the deadline is novel here, so only the deadline is
  // raced in by hand.
  const timedOut = Symbol('cell-read:dispatch-timed-out');
  let payload: unknown;
  try {
    const dispatch = dispatchReadOnlyTool(spec.changeSignal.tool, args, {
      workspaceId: env.workspaceId,
      harnessSlug: env.harnessSlug,
      role: env.role,
      onBehalfOf: reader.ownerId,
      spawnId: CELL_READ_SPAWN_ID,
      ...(env.callerContext ? { callerContext: env.callerContext } : {}),
      ...(env.signal ? { signal: env.signal } : {}),
    });
    // A dispatch that loses the race can still reject LATER, after we've already
    // returned via the timeout branch below — and nothing else will be listening for
    // that rejection at that point. Swallow it here so a slow-then-failing resolver
    // cannot surface as an unhandled promise rejection (bounded-timeout.ts documents
    // the identical hazard for its own race).
    dispatch.catch(() => {});
    const raced = await Promise.race([
      dispatch,
      new Promise<typeof timedOut>((resolve) => {
        const timer = setTimeout(() => resolve(timedOut), CELL_READ_TIMEOUT_MS);
        // Never keep the process alive on this timer alone (a lingering dispatch we no
        // longer wait for must not stop the operator from exiting).
        timer.unref?.();
      }),
    ]);
    if (raced === timedOut) {
      // The resolver WAS allowed to look — it just did not finish in time. That is
      // `resolver-failed` by this module's own mapping table (line ~199), never
      // `not-measured`: the caller's lever is retry-or-escalate, not "obtain access".
      return {
        status: 'unknown',
        cell,
        unknown: cellUnknown(
          'resolver-failed',
          `the resolver ("${spec.changeSignal.tool}") did not respond within ${CELL_READ_TIMEOUT_MS}ms. ` +
            'readCell stopped waiting on it (WI-6488) — this bounds the CALLER, not the resolver: the ' +
            'dispatch may still be running in the background, and may well be about to succeed. ' +
            `⚠ CALL THE RESOLVER'S OWN TOOL DIRECTLY ("${spec.changeSignal.tool}") — it is not subject ` +
            'to this bound and usually answers with the same values. Do that before concluding anything ' +
            'about the resolver. EI-21544761852770720: five consecutive readings of this message across ' +
            'two cells were read as a wedged resolver; the direct call then returned a full payload ' +
            'seconds later. A slow resolver and a hung one are indistinguishable FROM THIS MESSAGE, so ' +
            'it must not name a cause. If the direct call also fails to return, THEN you have evidence ' +
            'of a genuine hang worth investigating.',
        ),
      };
    }
    payload = raced;
  } catch (err) {
    if (err instanceof ReadOnlyDispatchError || (err as Error)?.name === 'ReadOnlyDispatchError') {
      return { status: 'unknown', cell, unknown: unknownForDispatchError(err as ReadOnlyDispatchError) };
    }
    // Anything the dispatcher did not classify. Still an unknown, never a throw.
    return {
      status: 'unknown',
      cell,
      unknown: cellUnknown('resolver-failed', err instanceof Error ? err.message : String(err)),
    };
  }

  /**
   * ⚠ THE PROJECTION IS INSIDE A GUARD, and the guard is not decorative — it closes a
   * real hole in this module's own no-throw contract (found by P-007's totality fuzz,
   * agent-state-plane-verification-2026-07-27).
   *
   * The `try` above wraps only the DISPATCH. Everything below it walks the resolver's
   * PAYLOAD — `valueAtPath` for the headline, again for the material lens, and
   * `hoistFrom` for the hoist — and a payload is not obliged to be walkable. A getter
   * that throws, a Proxy whose trap rejects, a lazily-computed field that blows up on
   * first access: each makes `valueAtPath` throw, and before this guard that throw
   * escaped `readCell` entirely.
   *
   * Which is the exact failure P-026 rule (f) exists to forbid, in the module that
   * documents it. The consumers named in this function's own header — a lock acquire, a
   * claim, a presence read — would have taken the exception on a hot path, so the
   * enrichment could fail the operation it decorates.
   *
   * `resolver-failed` is the right code by this module's own mapping table: the resolver
   * ANSWERED but produced something unusable, and the lever is retry-or-escalate rather
   * than "supply more input". The detail says it is a resolver defect rather than a
   * transient, matching how `not_read_only` is already reported.
   */
  try {
    const found = pathExists(payload, spec.changeSignal.path, { reportNullTermination: true });
    const nullTerminated = spec.nullable && found.nullTerminatedAt !== undefined;
    const value = nullTerminated ? null : found.value;
    // The resolver answered but the declared path is not present. `value === undefined`
    // has (at least) two causes with DIFFERENT fixes, and conflating them misdiagnoses
    // the common one: a resolver that never produced a result at all (it returned an
    // error/sentinel payload, e.g. because a `global` cell dispatched `{}` and the tool
    // requires an arg) looks byte-identical here to a genuinely stale declared path. The
    // first is a resolver/args problem; the second is a cell-registration problem — and
    // "the declared path has drifted" actively misdirects an author auditing the former
    // (D-067 defect 2 / EI-18790908999972569: three correct paths were blamed for a
    // one-line arg-wiring bug in the resolver's own error branch).
    if (value === undefined && !nullTerminated) {
      const errorMessage = errorShapeMessage(payload);
      if (errorMessage !== undefined) {
        return {
          status: 'unknown',
          cell,
          unknown: cellUnknown(
            'insufficient-data',
            `the resolver returned an error instead of a result: "${errorMessage}" — the declared path was not evaluated, ` +
              `so this is not path drift; check the resolver or the args this cell's callerRelativity dispatches ` +
              `(dispatched: ${JSON.stringify(args)}).`,
          ),
        };
      }
      // The resolver worked (no error shape) and the declared path is genuinely absent.
      // This is NOT `resolver-failed` (the resolver worked) and NOT a value (there is
      // none) — the read partly succeeded and cannot support a verdict, which is
      // `insufficient-data`.
      return {
        status: 'unknown',
        cell,
        unknown: cellUnknown(
          'insufficient-data',
          `the resolver answered but "${spec.changeSignal.path}" was absent from its result — the cell's declared path and ` +
            "its resolver's shape have drifted apart.",
        ),
      };
    }

    // P-021 — the material lens, off the SAME payload. `undefined` means the
    // declared path is not in this result (registration drift): we omit `material`
    // rather than reporting it as unchanged, so the caller falls back to LOUD.
    const materialPath = spec.materiality?.path;
    const materialValue = materialPath === undefined ? undefined : valueAtPath(payload, materialPath);

    return {
      status: 'value',
      cell,
      value,
      headline: spec.headline,
      resolver: spec.resolver,
      ...(spec.ordered === undefined ? {} : { ordered: { stages: [...spec.ordered.stages] } }),
      ...(spec.whyTotal === undefined ? {} : { totality: { why: spec.whyTotal } }),
      // D-008/D-016 — omitted ONLY for an event-signalled cell, the one case allowed to
      // declare `assessment: null` (it has no resolver payload to read a code out of).
      // Every value-bearing cell always carries the field, reporting `unavailable`
      // rather than vanishing when it cannot assess.
      //
      // ⚠ The nullish test is load-bearing, not stylistic. This read `=== undefined`
      // until P-006 widened the field from optional to `CellAssessmentSpec | null`; a
      // strict-undefined check survives that widening GRAMMATICALLY while silently
      // changing meaning — it stops matching an explicit null and hands `assessmentFrom`
      // a null spec to path into. D-016 names this as the only shape the widening breaks.
      ...(spec.assessment == null ? {} : { assessment: assessmentFrom(payload, spec.assessment) }),
      ...(spec.unknownHoist === undefined ? {} : { unknownHoist: hoistFrom(payload, spec.unknownHoist) }),
      ...(materialPath !== undefined && materialValue !== undefined
        ? { material: { path: materialPath, value: materialValue } }
        : {}),
      ...(spec.headlineSource === undefined ? {} : { source: sourceFrom(payload, spec.headlineSource) }),
    };
  } catch (err) {
    return {
      status: 'unknown',
      cell,
      unknown: cellUnknown(
        'resolver-failed',
        `this cell's resolver answered, but its result could not be read: ${
          err instanceof Error ? err.message : String(err)
        }. Projecting the declared path threw, so the payload is not a plain result (a throwing getter, a Proxy ` +
          "trap, a lazily-computed field). This is a defect in the resolver's RESULT, not a transient failure.",
      ),
    };
  }
}

/**
 * D-039 — lift the resolver's result-level unknown channel out of the payload the
 * dispatch ALREADY returned. Off the same payload, exactly as `material` is: axis 5
 * (one derivation, many lenses) forbids a second call, and a hoist that cost an extra
 * dispatch would be a hoist authors quietly stop declaring.
 *
 * ⚠ THE `drifted` BRANCH IS THE WHOLE REASON THIS FUNCTION IS NOT A ONE-LINER, and it
 * is deliberately the OPPOSITE of `material`'s missing-path rule. `material` OMITS on
 * drift, so a caller falls back to the loud reading and nothing is lost. Omitting here
 * would reproduce the defect this fixes byte for byte: a nullable cell answering
 * `value: null` with no reason attached, silently, forever. So a declared-but-absent
 * hoist is REPORTED — the read still succeeds (P-026: an enrichment may never fail its
 * caller), and the caller is told the channel is broken rather than empty.
 */
/**
 * WI-38266 — DID THE DOOR EAT IT? A payload that self-declares truncation makes every
 * missing path UNATTRIBUTABLE, and blaming the resolver for it is a false verdict.
 *
 * The bug this closes, measured end-to-end on `deploy.3070.sha`: `gitPipelinePosition()`
 * emitted BOTH declared paths correctly, each carrying an enumerated `not-applicable`
 * reason ("No path was given (sha-only probe), so no serving process can be identified").
 * `dev:pipeline_position` then bounded its own response to fit
 * `PIPELINE_POSITION_RESPONSE_BUDGET_CHARS`, dropping both — and because `readCell`
 * dispatches the TOOL, it walked the SHAPED payload and reported `drifted: true`, whose
 * prose tells the agent to read it "as a registration defect in the resolver". So a
 * correct, fully-explained measurement was rendered as a code bug in a blameless resolver,
 * and `serving.startedSinceCodeChange` — the independent check CLAUDE.md names as the ONLY
 * way to separate "deployed sha X" from "the process is EXECUTING X" — silently stopped
 * arriving.
 *
 * ⚠ WHY TRUNCATION ALONE DECIDES THIS, and NOT a lookup in `omittedFields`. That list is
 * computed against ONE shaping tier, so it under-reports precisely when the shaping was
 * most aggressive (`serving` was dropped from the live payload WITHOUT appearing in it).
 * Trusting the list would reintroduce the same false-confidence bug one level down: a
 * field missing from BOTH the payload and the omission report would read as resolver
 * drift again. The honest rule is the weaker, sound one — once a payload says it was
 * truncated, this module can no longer attribute ANY absence, and says so.
 *
 * Deliberately NOT a `status: 'unknown'` for the whole read: the HEADLINE usually
 * survives (doors shape the periphery first), and refusing a value we actually hold would
 * trade a false blame for a false blackout. The read stays, carrying an honest qualifier.
 */
function payloadTruncatedByDoor(payload: unknown): { truncated: boolean; fullRead?: unknown } {
  const projection = valueAtPath(payload, 'projection');
  if (!projection || typeof projection !== 'object') return { truncated: false };
  const p = projection as Record<string, unknown>;
  if (p.truncated !== true) return { truncated: false };
  return { truncated: true, ...(p.fullRead === undefined ? {} : { fullRead: p.fullRead }) };
}

function hoistFrom(payload: unknown, key: string): CellHoist {
  const found = pathExists(payload, key, { reportNullTermination: true });
  if (found.exists && found.value !== undefined) return { key, value: found.value };
  if (found.nullTerminatedAt !== undefined) return { key, value: null, nullTerminated: true };
  const door = payloadTruncatedByDoor(payload);
  if (door.truncated) {
    return { key, value: null, truncatedByDoor: true, ...(door.fullRead === undefined ? {} : { fullRead: door.fullRead }) };
  }
  return { key, value: null, drifted: true };
}

/**
 * WI-36259 — project the per-read provenance of the headline, off the SAME payload (axis 5:
 * never a second dispatch), exactly as `material` and the hoist are.
 *
 * ⚠ NOTE WHICH WAY THE MISSING-PATH CASE FALLS, because the two neighbours above resolve it
 * OPPOSITELY and both are right for their own field. `material` OMITS on drift (the caller
 * falls back to the LOUD reading — safe). `hoistFrom` REPORTS the drift (omitting would
 * restore the silent-null defect it exists to kill). Here the safe direction is a THIRD
 * one: report the read, with `authoritative: false`. Absence must never be able to
 * manufacture trust, so an unrecognised label, a drifted path and a resolver that simply
 * did not attribute this value all converge on "treat it as an inference" — the same answer
 * the caller would reach if the field had never been declared.
 */
function sourceFrom(payload: unknown, spec: CellHeadlineSource): CellSourceRead {
  const raw = valueAtPath(payload, spec.path);
  const value = typeof raw === 'string' ? raw : null;
  return {
    path: spec.path,
    value,
    authoritative: value !== null && spec.authoritative.includes(value),
    why: spec.why,
  };
}

/**
 * D-008 — THE ASSESSMENT LENS, off the SAME payload (axis 5, exactly like `material`,
 * `hoistFrom` and `sourceFrom` above: one derivation, many lenses).
 *
 * ⚠ THE ONE INVARIANT WORTH STATING PLAINLY: this function can only ever TRANSPORT a
 * domain code the owning resolver emitted AND the spec declared. It has no path that
 * synthesises, defaults, coerces or infers one. Every way of failing — a missing
 * path, a non-string, an undeclared code, missing evidence, a truncated payload —
 * lands on `unavailable`. That is what lets a generic registry carry domain meaning
 * without ever learning any domain: the registry cannot be wrong about what a gate
 * verdict means, because it never forms an opinion about one.
 *
 * ⚠ USES THE SHARED `pathExists` FROM `state-plane-stamp`, and it must stay that way.
 * Own-key existence, not `valueAtPath`: `valueAtPath` collapses a legitimately-NULL
 * intermediate segment and a MISSING key to the same `undefined`, and those two demand
 * opposite responses here. The shared copy is additionally TOTAL — a throwing getter or
 * a hostile proxy reports as missing rather than propagating out to the caller's catch
 * and blacking out an otherwise-good read. This file once carried its own non-total
 * variant of the same walk; P-006 deleted it with the field it served, so there is no
 * second implementation left to drift from this one.
 */
function assessmentFrom(payload: unknown, spec: CellAssessmentSpec): CellAssessmentRead {
  const path = spec.path;
  const door = payloadTruncatedByDoor(payload);

  /**
   * Evidence is resolved FIRST and carried on BOTH branches: when an assessment comes
   * back unavailable, which evidence did or did not arrive is usually the diagnosis,
   * and dropping it on the failure path would withhold the payload precisely when the
   * reader has least else to go on.
   */
  const pairs = spec.measuredBy ?? {};
  const evidence: CellAssessmentEvidence[] = spec.evidence.map((p) => {
    const r = pathExists(payload, p, { reportNullTermination: true });
    const base: CellAssessmentEvidence = r.exists
      ? { path: p, value: r.value }
      : r.nullTerminatedAt !== undefined
        ? { path: p, value: null, nullTerminated: true as const }
      : door.truncated
        ? { path: p, value: null, truncatedByDoor: true as const }
        : { path: p, value: null, drifted: true as const };
    // P-012: the paired measured-ness flag rides WITH the value, off the same payload.
    const flag = pairs[p];
    if (flag === undefined) return base;
    const f = pathExists(payload, flag, { reportNullTermination: true });
    return {
      ...base,
      measuredBy: f.exists
        ? { path: flag, value: f.value }
        : f.nullTerminatedAt !== undefined
          ? { path: flag, value: null, nullTerminated: true as const }
          : { path: flag, value: null, drifted: true as const },
    };
  });

  const unavailable = (unknown: CellUnknown): CellAssessmentRead => ({
    status: 'unavailable',
    path,
    code: null,
    meaning: null,
    safeAction: ASSESSMENT_UNAVAILABLE_SAFE_ACTION,
    evidence,
    unknown,
    ...(door.truncated ? { truncatedByDoor: true as const } : {}),
    ...(door.truncated && door.fullRead !== undefined ? { fullRead: door.fullRead } : {}),
  });

  const found = pathExists(payload, path, { reportNullTermination: true });

  if (!found.exists) {
    if (found.nullTerminatedAt !== undefined) {
      return unavailable(
        cellUnknown(
          'insufficient-data',
          `this cell's assessment path "${path}" sits below an explicit null parent at "${found.nullTerminatedAt}" — ` +
            'the nullable headline may be a measured null, but the resolver emitted no assessment code for that absent subject.',
        ),
      );
    }
    // WI-38266's split, one field over: DRIFT sends the reader to fix a resolver,
    // TRUNCATION sends them to re-read it. Reporting either as the other blames a
    // blameless resolver or hides a real one.
    return unavailable(
      door.truncated
        ? cellUnknown(
            'not-measured',
            `this cell's assessment path "${path}" did not arrive, but the resolver's response declares ITSELF truncated — so the absence is UNATTRIBUTABLE: it may have been dropped to fit a response budget rather than never measured. Re-read via the door's \`fullRead\` before concluding anything about the subject.`,
          )
        : cellUnknown(
            'insufficient-data',
            `this cell's declared assessment path "${path}" was absent from its resolver's result — the declaration and the resolver's shape have drifted apart. This is a defect in the cell's registration or in its resolver, NOT a finding about the subject.`,
          ),
    );
  }

  const raw = found.value;
  if (typeof raw !== 'string' || raw.trim() === '') {
    return unavailable(
      cellUnknown(
        'insufficient-data',
        `this cell's assessment path "${path}" resolved to ${
          raw === null ? 'null' : typeof raw
        }, not a code string. An assessment is a closed enum; a non-string cannot be one, and coercing it here would invent a verdict the resolver never emitted.`,
      ),
    );
  }

  const declared = Object.prototype.hasOwnProperty.call(spec.codes, raw) ? spec.codes[raw] : undefined;
  if (!declared) {
    /**
     * THE CASE THIS CONTRACT EXISTS FOR. The resolver emitted a code the spec does not
     * declare — a new verdict shipped without its meaning, or a typo. Passing it
     * through would hand the caller an enum with no `meaning` and no `safeAction`,
     * which is precisely the un-actionable prose verdict the assessment replaced. The
     * code is NAMED in the detail so the drift is diagnosable, and refused as a value.
     */
    return unavailable(
      cellUnknown(
        'insufficient-data',
        `this cell's resolver emitted assessment code "${raw}", which its registration does not declare (declared: ${
          Object.keys(spec.codes).join(', ') || 'none'
        }). An undeclared code has no stated meaning and no safe action, so it is refused rather than passed through — the resolver and the registration have drifted apart.`,
      ),
    );
  }

  /**
   * ⚠ EVIDENCE FAILURE DOWNGRADES A RESOLVED CODE (D-008: "an undeclared code, absent
   * assessment/evidence path, or door truncation can only downgrade to unavailable").
   *
   * Reported AFTER the code checks so the detail can name the code that was withheld —
   * which is what makes this diagnosable rather than merely conservative. Evidence is
   * what makes a code trustworthy; a verdict whose declared substantiation did not
   * arrive is an unverified claim, and shipping it as `resolved` would let the branch
   * a caller trusts most be the one carrying the least support.
   */
  const missingEvidence = evidence.filter((e) => e.drifted || e.truncatedByDoor);
  if (missingEvidence.length > 0) {
    const truncated = missingEvidence.some((e) => e.truncatedByDoor);
    return unavailable(
      cellUnknown(
        truncated ? 'not-measured' : 'insufficient-data',
        `this cell assessed "${raw}", but ${missingEvidence.length} of its ${
          evidence.length
        } declared evidence path(s) did not arrive (${missingEvidence.map((e) => e.path).join(', ')})${
          truncated
            ? " — and the resolver's response declares ITSELF truncated, so the absence is UNATTRIBUTABLE. Re-read via `fullRead`"
            : ' — the declaration and the resolver have drifted apart'
        }. The code is withheld rather than served unsubstantiated.`,
      ),
    );
  }

  return {
    status: 'resolved',
    path,
    code: raw,
    meaning: declared.meaning,
    safeAction: declared.safeAction,
    evidence,
  };
}

/**
 * WI-38266 — the `spawnId` `readCell` dispatches under, exported so a door can recognise
 * the MACHINE consumer and skip the response shaping it applies for agents.
 *
 * Shared rather than re-typed at each door on purpose: a door matching a stale literal
 * would silently go back to serving `readCell` a truncated payload, and the symptom
 * (a cell blaming its own resolver) points nowhere near the typo. `cell-read-door-
 * shaping.test.ts` pins this constant against the doors that honour it.
 *
 * Why the cell reader is exempt at all: a response budget exists to protect an AGENT's
 * context window. `readCell` walks two or three declared paths and re-serialises only
 * those, so the budget buys it nothing and costs it the ability to tell a measured null
 * from a field that never survived transit.
 */
export const CELL_READ_SPAWN_ID = 'cell-read';

/** Sentinel for "this cell needs a subject and none was given" — distinct from the
 *  legitimate empty-args case, which a plain `{}` would collide with. */
const MISSING_SUBJECT = Symbol('missing-subject');

/**
 * Build the resolver's args from the cell's declared caller-relativity (axis 3).
 *
 *  • `global`    — the same for every caller: no subject, no args.
 *  • `ambient`   — relative to something the caller never passes (its uid, its
 *                  identity). The RESOLVER reads it from context; a subject supplied
 *                  here is ignored rather than injected, because injecting it would
 *                  silently turn an ambient cell into a parameter one and let a caller
 *                  redirect a read that was supposed to be about itself.
 *  • `parameter` — REQUIRES the subject, passed under the declared param name.
 */
function argsForRelativity(spec: CellSpec, subject?: string): Record<string, unknown> | typeof MISSING_SUBJECT {
  const rel = spec.callerRelativity;
  if (rel.kind === 'parameter') {
    if (subject === undefined || subject.trim() === '') return MISSING_SUBJECT;
    return { [rel.param]: subject };
  }
  return {};
}
