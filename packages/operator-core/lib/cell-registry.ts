/**
 * cell-registry.ts — the agent state-plane CELL REGISTRY and its registration gate.
 *
 * Plan: unified-agent-state-plane-2026-07-27 (P-003). The contract it enforces is
 * that plan's D-038 (six axes), refined by D-039 (how P-003 enforces them).
 *
 * WHAT A CELL IS. A named piece of agent-readable state with exactly ONE resolver.
 * Storage does NOT move (D-004): each resolver reads its existing store. The point
 * is to unify the read/subscribe CONTRACT, not to merge 28 tables. An agent reads a
 * cell at the moment of acting instead of trusting a value someone transcribed forty
 * minutes ago — cells are justified by RE-DERIVABILITY, not by being better-formatted
 * than prose (D-032; the presentation question was tested and settled nothing, D-034).
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * WHY REGISTRATION IS A GATE AND NOT A FORM
 *
 * D-016/P-017: a rule whose only enforcement is documentation is not a rule. Every
 * axis below that CAN be checked mechanically IS checked here, at registration, and
 * a violation is a hard refusal. The axes are not advice to resolver authors; they
 * are preconditions of being in this map at all.
 *
 * The failure mode this exists to prevent is specific and has a measured base rate:
 * `predicate_watches` is shipped, correct in principle, and has NEVER been adopted
 * (0 rows, all tenants, 2026-07-27). D-010 therefore makes the adoption gate a
 * PRECONDITION of this registry shipping, not a follow-up — see
 * `scripts/check-no-bespoke-state-read.mjs` (`npm run lint:no-bespoke-state-read`).
 * A registry nobody registers into is surface #29 and strictly worse than today.
 *
 * ⚠ The validator below is deliberately domain-free (it knows about assessments and
 * three-valued verdicts, not about git or systemd). If a second consumer appears it
 * should be lifted to `libs/generic/*` behind a configure*() seam per the repo's
 * generic-first rule; it lives here for now because it has exactly one consumer.
 * ────────────────────────────────────────────────────────────────────────────── */

/**
 * D-038 axis 2's enumerated unknown comes from `cell-contract.ts`, which declares
 * itself THE CANONICAL HOME and forbids re-declaring a local copy. Re-exported here
 * so a cell author needs one import, not two — a re-export is a lens, not a second
 * derivation, which is the same distinction axis 5 draws one level up at the resolver.
 */
export {
  cellUnknown,
  formatCellUnknown,
  CELL_UNKNOWN_CODES,
  type CellUnknown,
  type CellUnknownCode,
} from './cell-contract';

/**
 * The same list again, as a VALUE this module can read at validation time. The
 * re-export above serves cell authors; this serves `validateCellSpec`, which must
 * reject an assessment code that collides with the unknown vocabulary (D-008).
 */
import { CELL_UNKNOWN_CODES } from './cell-contract';
import { measurednessStructuralViolations } from './cell-measuredness';

/**
 * D-038 axis 3 — caller-relativity is DECLARED, never inferred.
 *
 * Inference is not merely unreliable, it is wrong in the confident direction: an
 * inferring registry inspecting `dev:listening_ports` would find no caller parameter
 * and conclude `global`. It is in fact relative to the caller's uid — relativity the
 * resolver cannot see and the caller cannot pass. Hence `ambient` as a first-class
 * kind, and hence `global` being something you SAY rather than something you omit.
 */
export type CallerRelativity =
  /** The same for every caller. A stated decision, not an absent field. */
  | { kind: 'global' }
  /** Relative to an explicit argument — e.g. git answers per-path natively. */
  | { kind: 'parameter'; param: string }
  /** Relative to something the caller never passes — e.g. the caller's uid. */
  | { kind: 'ambient'; source: string };

/** One entry of an assessment's closed code map. Both fields are required and
 *  non-empty — see `CellAssessmentSpec.codes` for why `meaning` alone is not enough. */
export interface CellAssessmentCode {
  /** What this code says about the subject, in one sentence. */
  meaning: string;
  /** What a caller may safely DO under this code. An ACTION, not a reassurance. */
  safeAction: string;
}

/**
 * D-008 — WHAT THE VALUE MEANS, as a closed enum a program can branch on.
 *
 * The counterpart to `headline`: that field says WHERE the raw measurement is, this
 * says how to READ it. They are separate stable properties on purpose (D-003) — the
 * raw value keeps its existing type for predicates, thresholds, fact dependency
 * digests and auditing, and collapsing the two into a number-or-enum union would
 * break every caller that genuinely consumes telemetry in order to serve the ones
 * that want semantics.
 *
 * ⚠ THERE IS DELIBERATELY NO `kills`, NO `measurement`, AND NO NEGATIVE-INFERENCE
 * FIELD ANYWHERE IN THIS CONTRACT (D-004/D-006). The predecessor contract asserted a
 * NEGATIVE — "here is the reading this kills" — which is unactionable on its own: the
 * caller learns what not to conclude and is left to invent what to do instead. An
 * assessment states the positive: a code, what it MEANS, and the action that is SAFE
 * under it. That asymmetry is why the two were never aliased or auto-translated, and
 * why nothing here reconstructs a negative claim from a positive one.
 */
export interface CellAssessmentSpec {
  /**
   * The ONE path in this cell's own resolver payload carrying the enum code.
   *
   * Same-payload by construction (D-004, axis 5): the assessment is a LENS on the
   * derivation already in hand, never a second dispatch. A cell whose semantics
   * needed another call would be two cells.
   */
  path: string;
  /**
   * The CLOSED map — every code this cell can emit → what it means and what is safe
   * to do under it.
   *
   * CLOSED is load-bearing. An undeclared code found on a payload can only ever
   * downgrade the read to `unavailable`; it is never passed through. That is what
   * lets generic registry code TRANSPORT domain meaning without ever DERIVING it —
   * the registry never learns what a gate verdict is, it only carries what the
   * owning resolver declared.
   *
   * `safeAction` is required beside `meaning` because meaning alone reproduces the
   * exact defect this contract was written against: a reason a human can read and a
   * program cannot act on.
   */
  codes: Readonly<Record<string, CellAssessmentCode>>;
  /**
   * The same-payload paths that SUBSTANTIATE the code. Non-empty and distinct.
   *
   * An INDEPENDENT measurement belongs here when it carries real information (D-004):
   * kept as evidence FOR a positive reading, never rewritten into a negative claim
   * about what the value is not.
   */
  evidence: readonly string[];
  /**
   * main-green-status-visible-2026-09-03 P-012 — THE MEASURED-NESS PAIRING.
   *
   * "Measured empty" must never render as "nothing failing". For every hoisted path
   * (the headline, an evidence path, the unknownHoist) whose value is a COUNT or a
   * LIST, name the SAME-PAYLOAD path that says whether it was measured. Key = the
   * count/list path; value = its flag path. The flag path MUST itself be hoisted, so
   * the pair travels together through every surface that carries the value.
   *
   * The flag keeps its own semantics — a boolean `measured`, a `provenance` enum, an
   * `unavailable` reason, a `nonTestLegsMeasured` state are all legal — and the
   * generic reader carries it beside the value without interpreting it. What is
   * enforced (cell-measuredness.ts, guarded against the LIVE payload in
   * cell-assessment-reality.test.ts) is that no count or list is ever hoisted alone,
   * that every flag is hoisted, and that a flag is never itself a count.
   *
   * Omit only when the cell hoists no counts or lists; the guard decides that from the
   * payload's types, not from this field's absence.
   */
  measuredBy?: Readonly<Record<string, string>>;
}

/** D-038 axis 4 — no cell may be registered on FIXTURE evidence alone. A fixture
 *  cannot catch a resolver that is fresh, correctly-versioned and confidently wrong
 *  (the `realGit` class), so registration demands a live-exercise attestation. */
export interface CellProvenance {
  /** How the value is obtained (e.g. 'git rev-list against the live repo'). */
  obtainedBy: string;
  /** Was the resolver exercised against REALITY, not only fixtures? */
  liveExercised: boolean;
  /** Pointer to that exercise — what was run, and what it showed. */
  evidence: string;
}

/**
 * P-019 (a) — WHO may read this cell. REQUIRED at registration; there is no default.
 *
 * ⚠ THE DISTINCTION THAT MOTIVATES A SEPARATE CONCEPT. `agent_facts.audience_scope`
 * already exists and looks like the obvious thing to reuse — but it is DELIVERY
 * RELEVANCE, NOT SECRECY. Its own tool text says so: an audience-scoped fact folds
 * only into that fleet's orients, yet `facts:list` still shows it to everyone.
 * Reusing those semantics for cells would be a leak BY CONSTRUCTION, which is
 * exactly the hazard P-019 (c) names for P-013's presence expansion: an
 * out-of-audience caller would simply read the value through a different lens.
 *
 * So visibility is enforced on the READ path (see `canReadCell`), and it gates
 * EXISTENCE as well as value — a cell a reader may not see reads as absent rather
 * than as forbidden, so the narrow cells cannot be enumerated by a stranger.
 *
 * The vocabulary is REUSED, not invented: it mirrors `agent_facts.scope`'s CHECK
 * constraint (workspace | role | owner | harness | work_item) and its companion
 * rule that everything except `workspace` requires a ref.
 */
export type CellVisibility =
  /** Every agent in the workspace. A stated decision, not an absent field. */
  | { kind: 'workspace' }
  | { kind: 'harness'; ref: string }
  | { kind: 'role'; ref: string }
  | { kind: 'owner'; ref: string }
  | { kind: 'work_item'; ref: string };

/**
 * P-019 (b) — may this cell cross hives? REQUIRED; no default.
 * Mirrors `agent_facts.shareable` (+ `source_hive` / `fed_ts` for the transport).
 */
export type CellFederation =
  /** Never leaves this hive. */
  | { kind: 'local' }
  /** May federate. Only legal for workspace-visible cells — see the rule below. */
  | { kind: 'shareable' };

/**
 * P-009 / D-013 — DOES ANYTHING ACTUALLY CARRY A SHAREABLE CELL? Today: no.
 *
 * MEASURED 2026-08-21, not assumed. Across `packages/`, `apps/` and `libs/`,
 * `CellSpec.federation` is referenced in exactly two non-test places: its type
 * declaration above, and the validator below. No transport, serializer, projection
 * or cross-hive path reads it. A real row-federation transport DOES exist in this
 * repo (fed_ts + watermarks + LWW over coord_event_log / shared_presence /
 * agent_facts, migration 150), but it carries ROWS, and a cell is not a row — it is
 * a resolver-COMPUTED, host-local reading.
 *
 * ⚠ Do not be fooled by `shared-pot-loop/federated-cell-setup.ts`: "cell" there means
 * a simulated hive in the composition rig, not a state-plane cell. It is a test-rig
 * DDL helper, not a transport.
 *
 * SO THE VARIANT FAILS CLOSED. Left merely declarable, `{ kind: 'shareable' }` would
 * be accepted and then do NOTHING — silently, with no error and no warning. That is
 * precisely the "declaration with no mechanism" P-009 exists to kill, and it is worse
 * than a missing feature because it reads as a working one.
 *
 * WHY NOT JUST BUILD THE TRANSPORT: a foreign hive's `gate.greenCheckpoint.verdict` or
 * `host.memoryPressure` is not merely stale there, it is MEANINGLESS — it answers
 * about a different machine. Federating cells needs authority/staleness semantics that
 * zero declared demand justifies (all 10 registered cells are `local`).
 *
 * THIS CONSTANT IS THE ONE SWITCH. Wire a transport that genuinely consumes
 * `spec.federation`, flip this to `true`, and the whole path — including the
 * shareable+narrow-visibility cross-rule below, which is deliberately KEPT rather
 * than deleted — comes back to life unchanged.
 */
export const CELL_FEDERATION_TRANSPORT_AVAILABLE = false;

/**
 * P-021 — THE MATERIALITY THRESHOLD. Declared at REGISTRATION, and OPTIONAL:
 * absence means "every change is material", which is today's behaviour and stays
 * the default. You declare this only for a cell whose raw value churns faster
 * than the question it answers.
 *
 * ── WHAT IT IS FOR (D-018 A.2, gated by D-044) ───────────────────────────────
 *
 * D-044 draws the line this field sits on: coupling decides RELEVANCE, surprisal
 * decides WHETHER SOMETHING IS WORTH AN INTERRUPT. A pull surface needs no
 * surprisal gate — the caller asked. What needs one is everything that arrives
 * UNASKED: a wake, and the staleness verdict that rides along on every orient.
 *
 * The concrete case that motivated it, measured rather than imagined:
 * `gate.greenCheckpoint.candidate` declares `changeInCandidate.judgingSha`, which
 * follows the staging tip — 335 commits in 24h on this fleet. But the question
 * the cell exists to answer is "is the gate judging MY change", and that answer
 * (`judgingContainsPath`) moves only when YOUR file lands. So 335 daily version
 * bumps carry ~2 bits of news for their subject, and every one of them re-renders
 * a stale-verdict paragraph into every fold that carries a fact resting on it.
 *
 * That is the item's own rule — "push what changed the SENDER's own model;
 * everything else stays pull" — expressed as a registration field.
 *
 * ── WHY A PATH AND NOT A THRESHOLD DSL ───────────────────────────────────────
 *
 * The obvious alternative is a reduction rule (`{ kind:'threshold', at: 1 }`, so
 * `consecutiveReds` 0→1 is a flip and 1→2 is a bump). It is REFUSED, on this
 * registry's own precedent: `cell-registrations.ts` records twice that when a
 * declaration cannot state something honestly, the fix belongs in the RESOLVER,
 * not the declaration. A registry computing `reds >= 1` would be the registry
 * DERIVING a verdict — which is exactly what axis 5 forbids one level up. If the
 * material question is "is the gate red", the resolver should answer it, and this
 * field should then name that answer.
 *
 * So materiality is a LENS, not a computation: a second dot-path into the SAME
 * resolver result, extracted from the SAME dispatch (see `readCell`). It adds no
 * resolver call, no second derivation, and nothing this file has to interpret.
 *
 * ── ⚠ SUPPRESSION IS INVISIBLE BY CONSTRUCTION, SO IT CARRIES ITS REASON ─────
 *
 * Every other field here fails LOUDLY when it is wrong. This one fails SILENTLY
 * and in the confident direction: a cell that names the wrong material path stops
 * telling agents about real changes, and nothing surfaces to say so. `why` is
 * therefore REQUIRED — a reader who is told "3 changes were not raised" must be
 * able to check the claim that they did not matter. Suppression that cannot be
 * audited is not a threshold, it is a blind spot.
 */
export interface CellMateriality {
  /**
   * Dot-path into the SAME resolver result whose change is the MATERIAL one.
   * Must differ from `changeSignal.path` — naming the same path declares a no-op,
   * which is the default and should be expressed by omitting the field.
   */
  path: string;
  /** Why THIS is the material question, and what the raw path's churn is. */
  why: string;
}

/**
 * WI-36259 — the per-read provenance of a cell's headline. See `CellSpec.headlineSource`.
 */
export interface CellHeadlineSource {
  /**
   * Dot-path into the SAME resolver result holding this read's source label.
   * Must differ from `changeSignal.path`: a "source" that IS the value carries no
   * information — the same emptiness `assessment-is-headline` rejects, one field over.
   */
  path: string;
  /**
   * The source values that count as a DIRECT OBSERVATION. Anything else — and ABSENCE —
   * is treated as an inference, so this fails SAFE: an unrecognised or missing label can
   * only ever downgrade trust, never manufacture it.
   */
  authoritative: string[];
  /** What the untrusted reading actually degrades to, in one line, for the caller. */
  why: string;
}

/**
 * P-006 — A POINTER FROM ONE CELL TO ANOTHER. See `CellSpec.pointers`.
 *
 * ⚠ THE ABSENT FIELDS ARE THE DESIGN. There is no `field`, no `measurement`, no
 * `kills` — so a pointer is STRUCTURALLY INCAPABLE of carrying a claim about this
 * cell's reading, which is what D-014 forbids. It carries no value and makes no claim about this
 * cell's headline; it says only "the question you are about to ask next is
 * answered THERE". A reader who ignores it loses nothing but a hop.
 */
export interface CellPointer {
  /**
   * The cell id this points AT. NOT resolved at registration — a pointer between two
   * cells declared in the same module would then depend on their declaration order,
   * and the natural order (a general cell before the specific one it points to) is
   * exactly the one that would fail. It is resolved per-READ instead, where an
   * unresolvable target is reported as drift rather than silently dropped.
   */
  cell: string;
  /** WHEN a reader of THIS cell should follow it — the condition, not a description. */
  when: string;
  /** WHAT they get there that this cell does not answer. */
  answers: string;
}

/**
 * An additional agent-facing door that projects this cell's volatile value.
 *
 * `changeSignal` remains the ONE canonical resolver used by state:read and
 * state:subscribe. A door projection is delivery metadata only: it lets
 * `stampStatePlane` discover the same value when another existing tool already
 * carries it, without minting an alias cell or maintaining a hand-written map in
 * that tool.
 */
export interface CellDoorProjection {
  tool: string;
  path: string;
}

/** A caller, for the audience check. Deliberately small: everything here is
 *  already known at dispatch, so the check costs no lookup. */
export interface CellReader {
  ownerId: string;
  roles?: string[];
  harnessSlug?: string;
  workItems?: string[];
}

export interface CellSpec {
  /** Dotted id, e.g. `git.pipelinePosition`. Unique across the registry. */
  cell: string;
  /** Who owns the resolver — an agent id or a plan slug. */
  owner: string;
  /** Field path of the headline value this cell answers with. */
  headline: string;
  /**
   * D-008 — WHAT THE VALUE MEANS. REQUIRED, and nullable (P-006/D-016).
   *
   * REQUIRED TO DECIDE, not required to HAVE. An assessment names a path into a
   * RESOLVER RESULT, so only a `poll` cell can carry one — an event-signalled cell has
   * no dispatch to produce that payload and the validator rejects a declaration it
   * could never satisfy. Making the field plainly required would therefore force every
   * event cell to declare exactly what registration then refuses, i.e. delete the event
   * variant as a side effect of a field change.
   *
   * So the two legal answers are stated, never omitted — the same move
   * {@link CallerRelativity} makes with `global`:
   *   • poll cell  → a real {@link CellAssessmentSpec}. `null` is `assessment-missing`.
   *   • event cell → `null`. A non-null one is `assessment-on-event-cell`.
   *
   * ⚠ Do NOT restore the `?`. Optional meant "discretionary", which is what let a
   * value-bearing cell ship with no semantics at all; `| null` means "you must decide,
   * and one of the two answers is unavailable to you". Re-weakening it to silence a
   * strand reintroduces precisely what requiring it prevents.
   */
  assessment: CellAssessmentSpec | null;
  /** Axis 2 — can the verdict be unknown? If so the rules below bind. */
  nullable: boolean;
  /**
   * Axis 2 as refined by D-039 — HOISTING. In-band is necessary but NOT sufficient:
   * a per-row qualifier a caller can skip past is how the defect survives contact
   * with a hurried consumer. Required when `nullable`: a RESULT-level field (a count
   * or an affected-subject list) that a caller who never reads the per-row qualifier
   * still cannot miss. Modelled on `unitsUnknown[]` and `ownerHidden`.
   */
  unknownHoist?: string;
  /**
   * Axis 2, the OTHER branch — WHY THE VERDICT IS TOTAL. Required when `nullable`
   * is false (EI-18773925664381842).
   *
   * Without this the gate was HONESTY-GATED and rewarded the weaker cell: declaring
   * `nullable: true` cost you an `unknownHoist`, while `nullable: false` passed
   * unconditionally, with no hoist and no evidence. So the author who ADMITTED their
   * value can be unknown did strictly more work than the one who did not — the
   * incentive gradient pointed at exactly the defect axis 2 exists to prevent, and a
   * cell whose headline silently conflates "not reached" with "could not measure"
   * could ship wearing the contract's badge.
   *
   * The trap is that `nullable: false` is often LITERALLY TRUE OF THE TYPE — an
   * author need not be lying to declare it. `git.pipelinePosition`'s
   * `positions.deployed` was a bare `boolean` while `refContains` still turned a
   * failed git read into `false`. Type totality is therefore NOT the question this
   * field asks. The question is whether the RESOLVER can fail into a default: say why
   * the headline is genuinely two-valued — "the resolver returns a value or throws;
   * there is no read that can fail into a default" — not merely why its TypeScript
   * type has no `null`.
   *
   * This is not machine-verifiable and does not pretend to be. It is the same standard
   * axis 4 already holds `provenance.evidence` to: it converts a costless default into
   * a claim someone had to write down and a reviewer can challenge.
   */
  whyTotal?: string;
  /** Axis 3. */
  callerRelativity: CallerRelativity;
  /** Axis 4. */
  provenance: CellProvenance;
  /**
   * P-008 / D-012 — the date this cell entered the registry, `YYYY-MM-DD` (UTC).
   *
   * The TENURE rule is the counterpart to the admission rule ("a read with 0 calls
   * is never promoted"), and it cannot be evaluated without this. Zero reads means
   * two OPPOSITE things depending on age — a dormant cell nobody wants, or a cell
   * registered last week that has not had time to be adopted — and telemetry cannot
   * tell them apart, because a cell that was never read leaves no first-seen row to
   * date it from. Measured instance: P-008 names `testing.census.population` and
   * `testing.coverage.floor` as its first subjects; both were registered 2026-08-18,
   * so on a 14-day window 11 of those days PREDATE THEIR EXISTENCE. Read literally,
   * the rule's first act would be to recommend cutting two three-day-old cells.
   *
   * OPTIONAL in the type, MANDATORY in the registry (asserted by
   * `cell-tenure.test.ts`). Optional only to avoid stranding the 10+ test fixtures
   * that construct a CellSpec; it is NOT optional for a real registration. Absence
   * is fail-CLOSED, never fail-quiet: it yields the `tenure-unknown` verdict, so a
   * forgotten field can only ever SUPPRESS a cut, never cause one.
   */
  registeredOn?: string;
  /**
   * Axis 5 — ONE derivation, many lenses. Exactly one resolver; surfaces may PROJECT
   * or subset it and may NEVER re-derive it. Generalises
   * `presence-derivation-unification-2026-07-17` #D-001, whose enforcement model is
   * `agent-tools/coordination/liveness-parity.test.ts`.
   */
  resolver: string;
  /** P-019 (a) — REQUIRED. `{ kind: 'workspace' }` is a valid answer; omission is not. */
  visibility: CellVisibility;
  /** P-019 (b) — REQUIRED. */
  federation: CellFederation;
  /** How a subscriber learns it changed. `poll` rides predicate_watches (P-004 is
   *  wiring, not a build); do NOT add a second subscription mechanism. */
  changeSignal: { kind: 'poll'; tool: string; path: string } | { kind: 'event'; key: string };
  /**
   * Additional doors whose payloads project this same cell-backed value. These
   * never participate in reads or subscriptions; they exist only so the door can
   * emit a registry-derived re-read handle beside the value it already returns.
   */
  doorProjections?: readonly CellDoorProjection[];
  /** P-021 — OPTIONAL. Omitted ⇒ every change is material (today's behaviour). */
  materiality?: CellMateriality;
  /**
   * WI-36259 — OPTIONAL. THE RUNTIME COMPANION TO AXIS 4.
   *
   * `provenance` above is STATIC: how the cell was BUILT and evidenced, fixed at
   * registration. This is PER-READ: where THIS read's headline came from, when a resolver
   * can reach the same value by paths of different trust. Both are needed and neither
   * substitutes for the other — a cell can be impeccably evidenced at registration and
   * still hand you an inference on any given call.
   *
   * Declared as a path off the SAME payload, exactly like `unknownHoist` and
   * `materiality` — never a second dispatch (axis 5).
   *
   * `authoritative` lists the values that count as a DIRECT OBSERVATION; anything else,
   * including absence, is an inference. That list is what makes the read BRANCHABLE: the
   * consumer gets a boolean instead of having to know each resolver's private enum, which
   * is the whole complaint cell-contract.ts was written about (a reason reported as prose
   * a human can read and a program cannot branch on).
   *
   * Justified by TWO shipped instances, not speculative generality:
   * `checkpointRunInFlight.candidateSource` ('retriage-marker' authoritative vs 'run-probe'
   * inferred) and `checkpointRunInFlight.activeSource` ('run-lock' / 'process-authority'
   * authoritative vs absent).
   */
  headlineSource?: CellHeadlineSource;
  /**
   * P-006 — OPTIONAL. WHERE TO GO NEXT, for the question this cell does NOT answer.
   *
   * Every other field here makes THIS cell's answer harder to misread. This one
   * addresses a different failure entirely: a reader who gets a correct answer, has
   * a correct follow-up question, and never learns the cell that answers it exists.
   * Discovery is not a property of any single cell's contract, so no amount of rigour
   * on `gate.greenCheckpoint.verdict` could surface `gate.greenCheckpoint.ownership`
   * to the agent reading a red gate. Measured: the ownership block ships in
   * `dev:pipeline_position`, but a caller who reached the verdict through
   * `state:read` — which is what this repo's own guidance tells them to do before
   * acting on a gate value — saw no trace of it.
   *
   * A POINTER MAKES NO CLAIM ABOUT THIS CELL'S READING (D-014). `CellPointer` has no
   * field/measurement/kills by construction, so this cannot become the per-block
   * side-claim the plan's P-005 assumed and the contract rejects — the discipline that
   * outlived the retired axis-1 contract. Ownership keeps its own cell, its own headline
   * and its own independent check; this only makes it reachable.
   *
   * Targets are resolved PER-READ, not at registration — see `CellPointer.cell`.
   */
  pointers?: CellPointer[];
  /** Human-readable result shape. */
  shape: string;
  /**
   * Axis 6 — OPTIONAL. Only a cell with a genuine total stage order declares this.
   * ABSENCE MEANS "THIS CELL HAS NO OPINION", NEVER "CLEAR" — forcing it on orderless
   * cells makes them report null/null, which readers take as "nothing to do",
   * manufacturing false all-clears by construction at fleet scale.
   */
  ordered?: { stages: string[] };
}

export interface CellRejection {
  cell: string;
  /** A D-038 axis number, or a P-019 dimension. The two are labelled differently on
   *  purpose: `visibility`/`federation` are NOT contract axes, they are the access
   *  model P-019 added, and blurring them would misrepresent D-038 as having eight. */
  axis:
    /** ⚠ THE GAP AT 1 IS DELIBERATE — DO NOT RENUMBER. Axis 1 was the falsifier, which
     *  P-006 removed; `assessment` REPLACES it (D-006) but is named rather than
     *  numbered, for the reason the comment on that member gives. Sliding 2–5 down to
     *  close the gap would silently re-point every D-038 axis citation in this repo's
     *  docs, plans and decisions at the wrong rule. */
    | 2
    | 3
    | 4
    | 5
    | 'visibility'
    | 'federation'
    | 'doorProjections'
    | 'materiality'
    | 'headlineSource'
    | 'pointers'
    /** D-008. Named, not numbered, for the same reason `visibility`/`federation` are:
     *  the assessment is not a sixth D-038 axis, it is the contract that REPLACES
     *  axis 1 (D-006). Numbering it would misrepresent D-038 as having grown one. */
    | 'assessment';
  rule: string;
  detail: string;
}

/** Normalise for the containment checks — a field that merely re-cases or
 *  re-punctuates the headline is still the headline. */
function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * THE REGISTRATION GATE. Returns every reason a spec may not be registered; an empty
 * array means it may. Pure and total — never throws, so a caller can report ALL
 * violations at once rather than making an author fix them one per run.
 */
export function validateCellSpec(spec: CellSpec): CellRejection[] {
  const out: CellRejection[] = [];
  const reject = (axis: CellRejection['axis'], rule: string, detail: string) =>
    out.push({ cell: spec.cell, axis, rule, detail });

  const headline = norm(spec.headline);

  // ── Axis 2 — three-valued, and the unknown must be enumerated AND hoisted.
  if (spec.nullable && !spec.unknownHoist?.trim()) {
    reject(2, 'unknown-not-hoisted', 'a nullable verdict needs `unknownHoist`: a RESULT-level field a caller who never reads the per-row qualifier still cannot miss. Per-row-only is how the defect survives a hurried consumer.');
  }
  if (!spec.nullable && spec.unknownHoist) {
    reject(2, 'hoist-without-nullable', '`unknownHoist` declared but the verdict is not nullable — one of the two is wrong.');
  }
  // main-green-status-visible-2026-09-03 P-012 — the measured-ness pairing is STRUCTURAL,
  // so a malformed one is refused at registration rather than discovered by a reader.
  // Whether a hoisted count LACKS a pairing needs the live payload and is the P-012 guard
  // in cell-assessment-reality.test.ts; this is the half decidable from the spec alone.
  for (const v of measurednessStructuralViolations(spec)) reject(2, `measured-by-${v.kind}`, v.detail);
  // EI-18773925664381842 — the branch that used to cost NOTHING. `nullable: false`
  // passed unconditionally, so the honest author (nullable + a hoist) did strictly
  // more work than one who declared totality they had not checked. Attesting is the
  // same standard axis 4 holds `provenance.evidence` to: not machine-checkable, but
  // written down and therefore challengeable in review.
  if (!spec.nullable && !spec.whyTotal?.trim()) {
    reject(2, 'total-not-attested', 'a non-nullable verdict needs `whyTotal`: why the headline is genuinely two-valued. State why the RESOLVER cannot fail into a default (\"returns a value or throws\") — not that the TypeScript type lacks `null`, which was true of `positions.deployed` while a failed git read still became `false`.');
  }
  if (spec.nullable && spec.whyTotal) {
    reject(2, 'total-attested-on-nullable', '`whyTotal` declared on a nullable verdict — it attests the verdict CANNOT be unknown, which contradicts `nullable: true`. One of the two is wrong.');
  }

  // ── Axis 3 — declared, never inferred; `global` is said, not omitted.
  const rel = spec.callerRelativity;
  if (!rel || typeof (rel as { kind?: unknown }).kind !== 'string') {
    reject(3, 'relativity-undeclared', 'callerRelativity is REQUIRED. `{ kind: "global" }` is a valid answer; omission is not — inference concludes `global` for ambient cells, which is wrong in the confident direction.');
  } else if (rel.kind === 'parameter' && !rel.param.trim()) {
    reject(3, 'relativity-parameter-unnamed', 'callerRelativity.kind="parameter" must name the `param`.');
  } else if (rel.kind === 'ambient' && !rel.source.trim()) {
    reject(3, 'relativity-ambient-unnamed', 'callerRelativity.kind="ambient" must name the `source` the caller cannot pass (e.g. "caller uid").');
  }

  // ── Axis 4 — no registration on fixture evidence alone.
  if (!spec.provenance?.liveExercised) {
    reject(4, 'fixture-evidence-only', 'provenance.liveExercised must be true: no cell may be registered on fixture evidence alone. Fixtures cannot catch a fresh, correctly-versioned, confidently-wrong resolver.');
  }
  if (!spec.provenance?.evidence?.trim()) {
    reject(4, 'provenance-unevidenced', 'provenance.evidence must point at the live exercise — what was run and what it showed.');
  }

  // ── Axis 5 — exactly one resolver.
  if (!spec.resolver?.trim()) {
    reject(5, 'no-resolver', 'a cell must name exactly ONE resolver; surfaces may project or subset it, never re-derive it.');
  }

  // ── P-019 (a) — visibility is DECLARED, never defaulted.
  const vis = spec.visibility;
  const VIS_KINDS = ['workspace', 'harness', 'role', 'owner', 'work_item'];
  if (!vis || typeof (vis as { kind?: unknown }).kind !== 'string' || !VIS_KINDS.includes(vis.kind)) {
    reject('visibility', 'visibility-undeclared', `visibility is REQUIRED and must be one of ${VIS_KINDS.join(' | ')}. \`{ kind: "workspace" }\` is a valid answer; omission is not — a defaulted audience is how a field dies (D-016), and for an access field the default fails OPEN.`);
  } else if (vis.kind !== 'workspace' && !vis.ref?.trim()) {
    reject('visibility', 'visibility-ref-missing', `visibility.kind="${vis.kind}" must name a \`ref\`. Mirrors agent_facts' own rule that every scope except 'workspace' requires a scope_ref.`);
  }

  // ── P-019 (b) — federation, and the one cross-rule that matters.
  const fed = spec.federation;
  if (!fed || (fed.kind !== 'local' && fed.kind !== 'shareable')) {
    reject('federation', 'federation-undeclared', 'federation is REQUIRED: `{ kind: "local" }` (never leaves this hive) or `{ kind: "shareable" }`.');
  } else if (fed.kind === 'shareable' && vis?.kind && vis.kind !== 'workspace') {
    reject('federation', 'shareable-narrow-visibility', `a \`shareable\` cell must be workspace-visible; this one is "${vis.kind}"-scoped. A ref like an owner id, role or work-item does NOT resolve in a foreign hive, so the receiving side can neither evaluate nor honour the audience — it either fails open (a leak) or fails closed (silently invisible). Both are wrong answers, so the combination is refused rather than guessed.`);
  }

  // ── P-009 / D-013 — a declaration with no mechanism is contract theater.
  //
  // Deliberately an INDEPENDENT `if`, not another `else if` on the chain above: this
  // function's contract is to return EVERY reason a spec may not be registered (see
  // its doc — "so a caller can report ALL violations at once"), and `reject` pushes
  // rather than throws. A shareable+owner-scoped spec is wrong on BOTH counts and
  // should be told both, not made to fix them one run at a time.
  if (fed?.kind === 'shareable' && !CELL_FEDERATION_TRANSPORT_AVAILABLE) {
    reject('federation', 'shareable-no-transport', `\`shareable\` is declarable but NOTHING TRANSPORTS IT. Measured 2026-08-21: \`CellSpec.federation\` is read in exactly two non-test places — its type declaration and this validator — so a shareable cell would federate to nobody, silently and with no error. That is worse than an unsupported feature because it reads as a working one. Declare \`{ kind: 'local' }\`; if you genuinely need cross-hive cells, wire a transport that CONSUMES spec.federation and flip CELL_FEDERATION_TRANSPORT_AVAILABLE in cell-registry.ts (see plan state-plane-interest-and-hardening-2026-08-21 D-013). Note a cell is not a row: the fed_ts/LWW transport federates ROWS, and a cell is a resolver-computed host-local reading.`);
  }

  // ── P-017 — ADDITIONAL DOOR PROJECTIONS. Delivery aliases, never resolvers.
  const doorProjections = spec.doorProjections;
  if (doorProjections !== undefined) {
    if (!Array.isArray(doorProjections)) {
      reject(
        'doorProjections',
        'door-projections-not-a-list',
        '`doorProjections` must be a list. Omit it when no additional door carries this value.',
      );
    } else if (spec.changeSignal?.kind !== 'poll') {
      reject(
        'doorProjections',
        'door-projections-on-event-cell',
        'an event-signalled cell has no poll resolver for state:read, so an alternate door cannot honestly emit a re-read handle for it.',
      );
    } else {
      const seen = new Set([`${spec.changeSignal.tool}\u0000${spec.changeSignal.path}`]);
      for (const projection of doorProjections) {
        const tool = projection?.tool?.trim();
        const path = projection?.path?.trim();
        if (!tool || !path) {
          reject(
            'doorProjections',
            'door-projection-incomplete',
            'every door projection must name a non-empty `tool` and `path`.',
          );
          continue;
        }
        const key = `${tool}\u0000${path}`;
        if (seen.has(key)) {
          reject(
            'doorProjections',
            'door-projection-duplicate',
            `door projection "${tool}" → "${path}" duplicates the canonical changeSignal or another projection.`,
          );
          continue;
        }
        seen.add(key);
      }
    }
  }

  // ── P-021 — MATERIALITY. Optional, but a declared one must be able to do work.
  const mat = spec.materiality;
  if (mat !== undefined) {
    if (!mat.path?.trim()) {
      reject('materiality', 'materiality-path-missing', 'materiality must name a `path` — the field in the SAME resolver result whose change is the material one. Omit the whole field to mean "every change is material".');
    }
    if (!mat.why?.trim()) {
      reject(
        'materiality',
        'materiality-unjustified',
        'materiality must state `why`. Every other field here fails loudly when wrong; this one SUPPRESSES — it fails silently and in the confident direction, so a reader told "N changes were not raised" must be able to check the claim that they did not matter.',
      );
    }
    if (spec.changeSignal?.kind !== 'poll') {
      reject(
        'materiality',
        'materiality-on-event-cell',
        'materiality names a path into a RESOLVER RESULT, and an event-signalled cell has no resolver to produce one. Gate the push at the emitter instead.',
      );
    } else if (mat.path?.trim() && norm(mat.path) === norm(spec.changeSignal.path)) {
      reject(
        'materiality',
        'materiality-is-changesignal-path',
        `materiality.path "${mat.path}" IS changeSignal.path — that declares "every change is material", which is already the default. Omit the field, or name the COARSER answer the cell actually exists to give.`,
      );
    }
  }

  // ── WI-36259 — HEADLINE SOURCE. Optional, but a declared one must be able to do work.
  const src = spec.headlineSource;
  if (src !== undefined) {
    if (!src.path?.trim()) {
      reject('headlineSource', 'headline-source-path-missing', 'headlineSource must name a `path` — the field in the SAME resolver result carrying this read\'s source label. Omit the whole field to mean "this cell reaches its headline exactly one way".');
    }
    if (!Array.isArray(src.authoritative) || src.authoritative.length === 0) {
      reject(
        'headlineSource',
        'headline-source-no-authoritative-values',
        'headlineSource must list at least one `authoritative` value. An empty list makes EVERY reading an inference, so the field can only ever downgrade and never distinguishes anything — declaring it then costs a payload field and tells the caller nothing.',
      );
    }
    if (!src.why?.trim()) {
      reject(
        'headlineSource',
        'headline-source-unjustified',
        'headlineSource must state `why` — what the untrusted reading DEGRADES TO. "This value is less trustworthy" is unactionable; "on a cron run the probe falls back to the checkout\'s live HEAD" tells the caller what to do instead.',
      );
    }
    if (spec.changeSignal?.kind !== 'poll') {
      reject(
        'headlineSource',
        'headline-source-on-event-cell',
        'headlineSource names a path into a RESOLVER RESULT, and an event-signalled cell has no resolver to produce one. Carry the provenance in the event payload instead.',
      );
    } else if (src.path?.trim() && norm(src.path) === norm(spec.changeSignal.path)) {
      reject(
        'headlineSource',
        'headline-source-is-changesignal-path',
        `headlineSource.path "${src.path}" IS changeSignal.path — a value cannot be its own provenance. This is the same emptiness \`assessment-is-headline\` rejects, in a second field: it looks like corroboration and carries no information.`,
      );
    }
  }

  // ── D-008 — THE ASSESSMENT. REQUIRED AND NULLABLE (P-006/D-016). `null` is the event
  // cell's legal answer and a real spec is the poll cell's; omission is not a third
  // option. The `?? null` is the runtime backstop for a caller who reached here from
  // untyped JS — it folds an omitted field into the SAME branch as an explicit null so
  // it is judged, never waved through.
  //
  // ⚠ The requirement is keyed on NOT-event rather than on IS-poll, deliberately. A cell
  // whose `changeSignal` is missing or malformed must fall into "needs semantics", not
  // out of it: keying on `=== 'poll'` would let a broken discriminator silently exempt a
  // value-bearing cell from the one field that says what its value MEANS.
  const assessment = spec.assessment ?? null;
  if (assessment === null) {
    if (spec.changeSignal?.kind !== 'event') {
      reject(
        'assessment',
        'assessment-missing',
        'a value-bearing cell must declare an `assessment` — what its value MEANS as a closed enum, and what is SAFE to do under each code. `null` is reserved for event-signalled cells, which have no resolver payload to read a code out of. Without one this cell ships a number with no stated semantics, and every caller invents its own reading — the defect this contract exists to remove.',
      );
    }
  } else {
    const apath = typeof assessment.path === 'string' ? assessment.path.trim() : '';
    if (!apath) {
      reject(
        'assessment',
        'assessment-path-missing',
        'assessment must declare `path` — the ONE resolver-output path carrying the enum code. Without it there is nothing to read, and a declared-but-unreadable assessment is worse than none: it advertises semantics the read can never deliver.',
      );
    }

    // ── LINEAGE. An assessment names a path into a RESOLVER RESULT, and an
    // event-signalled cell has no resolver to produce one — so the declaration could
    // never be satisfied at read time. Identical rule, identical reason, to
    // `headline-source-on-event-cell` above.
    if (spec.changeSignal?.kind !== 'poll') {
      reject(
        'assessment',
        'assessment-on-event-cell',
        'assessment names a path into a RESOLVER RESULT, but this cell is event-signalled and has no resolver to produce one. Carry the assessment in the event payload instead.',
      );
    }

    // ── DISTINCTNESS. An assessment that IS the headline is the headline wearing a
    // hat. This is the CANONICAL statement of an emptiness `headline-source-is-
    // changesignal-path` and `pointer-is-self` each reject in their own field. `norm` is
    // used here (not an exact match) precisely because a re-cased or re-punctuated
    // restatement of the headline is the case worth catching.
    if (apath && norm(apath) === headline) {
      reject(
        'assessment',
        'assessment-is-headline',
        `assessment.path "${assessment.path}" IS the headline value. An assessment exists to say what the raw measurement MEANS; re-projecting the measurement itself adds a field and no information.`,
      );
    }

    // ── THE CLOSED CODE MAP.
    const codes = assessment.codes as unknown;
    const codeKeys =
      codes !== null && typeof codes === 'object' && !Array.isArray(codes) ? Object.keys(codes) : null;
    if (codeKeys === null) {
      reject(
        'assessment',
        'assessment-codes-not-a-map',
        '`codes` must be a map from enum code to `{ meaning, safeAction }`.',
      );
    } else if (codeKeys.length === 0) {
      reject(
        'assessment',
        'assessment-codes-empty',
        '`codes` is empty. A closed map with nothing in it can never resolve, so every read of this cell would downgrade to `unavailable` — the cell would ship a semantics channel that is broken by construction.',
      );
    } else {
      const seenCodes = new Set<string>();
      const codeMap = codes as Record<string, CellAssessmentCode | undefined>;
      for (const key of codeKeys) {
        const code = key.trim();
        if (!code) {
          reject('assessment', 'assessment-code-blank', 'a code key is empty or whitespace. An unnameable code cannot be branched on.');
          continue;
        }
        if (seenCodes.has(norm(code))) {
          reject(
            'assessment',
            'assessment-code-duplicate',
            `code "${code}" is declared twice (after normalisation). Two spellings of one code split its meaning across entries, and a reader gets whichever one the object literal happened to keep.`,
          );
        }
        seenCodes.add(norm(code));
        // D-008 — read HEALTH and domain MEANING are different vocabularies. A cell
        // answering `resolver-failed` as a domain code would let an apparatus failure
        // masquerade as a measured finding about the subject.
        if ((CELL_UNKNOWN_CODES as readonly string[]).includes(code)) {
          reject(
            'assessment',
            'assessment-code-collides-with-unknown',
            `code "${code}" is a CellUnknownCode. Read-health and domain meaning are separate vocabularies: reusing one here would make "the apparatus failed" indistinguishable from a verdict ABOUT the subject, which is the confusion the in-band unknown exists to prevent.`,
          );
        }
        const entry = codeMap[key];
        if (!entry?.meaning?.trim() || !entry?.safeAction?.trim()) {
          reject(
            'assessment',
            'assessment-code-incomplete',
            `code "${code}" needs both \`meaning\` (what it says about the subject) and \`safeAction\` (what a caller may safely DO under it). Meaning alone is a reason a human can read and a program cannot act on — the exact defect this contract replaces.`,
          );
        }
      }
    }

    // ── EVIDENCE — what SUBSTANTIATES the code, in the same payload.
    const evidence = assessment.evidence as unknown;
    if (!Array.isArray(evidence)) {
      reject('assessment', 'assessment-evidence-not-a-list', '`evidence` must be a list of paths in this cell\'s own resolver payload.');
    } else if (evidence.length === 0) {
      reject(
        'assessment',
        'assessment-evidence-empty',
        '`evidence` is empty. An assessment with nothing behind it is an assertion wearing the contract\'s badge — the same emptiness `assessment-is-headline` rejects, one field over.',
      );
    } else {
      const seenEvidence = new Set<string>();
      for (const raw of evidence) {
        const p = typeof raw === 'string' ? raw.trim() : '';
        if (!p) {
          reject('assessment', 'assessment-evidence-blank', 'an evidence entry is empty or is not a string path.');
          continue;
        }
        if (seenEvidence.has(norm(p))) {
          reject('assessment', 'assessment-evidence-duplicate', `evidence path "${p}" is declared twice. A fact cited twice is not corroborated twice.`);
        }
        seenEvidence.add(norm(p));
        if (apath && norm(p) === norm(apath)) {
          reject(
            'assessment',
            'assessment-evidence-is-assessment-path',
            `evidence path "${p}" IS assessment.path. A code cannot be its own evidence: it looks like corroboration and carries no information.`,
          );
        }
      }
    }
  }

  // ── P-006 — POINTERS. Optional, and deliberately the THINNEST gate in this function.
  //
  // Every check below is a SHAPE check answerable from the spec alone. Target existence
  // is NOT checked here on purpose (see `CellPointer.cell`): a same-module pointer would
  // then be order-dependent, and the order authors naturally write — the general cell
  // first, the specific one it points at second — is the one that would fail. A pointer
  // whose target is unregistered surfaces at READ time as drift, where it is a live fact
  // rather than a load-order artifact.
  const pointers = spec.pointers;
  if (pointers !== undefined) {
    if (!Array.isArray(pointers)) {
      reject('pointers', 'pointers-not-a-list', '`pointers` must be a list. Omit the field entirely to mean "this cell points nowhere".');
    } else {
      const seen = new Set<string>();
      for (const p of pointers) {
        const target = p?.cell?.trim();
        if (!target) {
          reject('pointers', 'pointer-target-missing', 'every pointer must name the `cell` it points at.');
          continue;
        }
        if (norm(target) === norm(spec.cell)) {
          reject(
            'pointers',
            'pointer-to-self',
            `pointer target "${target}" IS this cell. A pointer exists to reach an answer this cell does not give; pointing at itself is the same emptiness \`assessment-is-headline\` rejects, in a third field.`,
          );
        }
        if (seen.has(norm(target))) {
          reject('pointers', 'pointer-duplicate-target', `"${target}" is pointed at twice. Two reasons to follow one pointer belong in ONE \`when\`, or the second is noise.`);
        }
        seen.add(norm(target));
        if (!p.when?.trim()) {
          reject(
            'pointers',
            'pointer-when-missing',
            `pointer to "${target}" must state \`when\` — the CONDITION under which to follow it. An unconditional pointer is read on every healthy call, which is how a signal becomes noise a reader learns to skip (the same rule \`formatCellHoist\` spends prose only on a non-empty channel for).`,
          );
        }
        if (!p.answers?.trim()) {
          reject(
            'pointers',
            'pointer-answers-missing',
            `pointer to "${target}" must state \`answers\` — WHAT is over there. "See also X" costs the reader a full dispatch to discover whether X was worth it; naming the question lets them decide before paying.`,
          );
        }
      }
    }
  }

  return out;
}

/**
 * The role a cross-harness operator/superuser session presents as `ctx.role`.
 * Verified against the live ledger rather than assumed: every `harnessSlug:'*'`
 * caller in a 24h window carried exactly this role (P-005, 2026-08-21).
 */
const OPERATOR_ROLE = 'operator';

/**
 * True for the canonical "all harnesses / operator scope" sentinel.
 *
 * ⚠ DELIBERATELY DUPLICATED, NOT IMPORTED. The canonical definition is
 * `HARNESS_ALL` / `isAllHarnessSentinel()` in `agent-tools/_harness-scope.ts`, but
 * this module is dependency-free ON PURPOSE (it has no imports at all), and that
 * one reaches `@papercusp/agent-mcp` — an import edge from this primitive into the
 * MCP layer invites a cycle at the seam the registry is loaded through.
 *
 * The duplication is pinned instead of trusted: `cell-registry-harness-sentinel.test.ts`
 * imports BOTH and asserts they agree on every input, so a change to the canonical
 * predicate fails there rather than silently splitting the access check away from
 * the scope resolver.
 */
function isOperatorScopeSentinel(v: string | null | undefined): boolean {
  const s = v?.trim().toLowerCase();
  return s === '*' || s === 'all';
}

/**
 * P-019 — THE AUDIENCE CHECK. Pure (spec, reader) -> boolean.
 *
 * Gates EXISTENCE as well as value: callers below treat "not readable" as "absent",
 * so a stranger cannot enumerate narrow cells or infer one from a refusal.
 */
export function canReadCell(spec: CellSpec, reader: CellReader): boolean {
  // Fail CLOSED on a missing spec/reader rather than throwing. A throwing access
  // check is one `catch` away from being read as "allow", and the callers here are
  // exactly the kind of surface that wraps reads in a try/catch.
  if (!spec || !reader) return false;
  const v = spec.visibility;
  switch (v?.kind) {
    case 'workspace':
      return true;
    case 'owner':
      return reader.ownerId === v.ref;
    case 'role':
      return (reader.roles ?? []).includes(v.ref);
    case 'harness':
      // A reader scoped to a CONCRETE harness must match exactly. That is what keeps
      // EI-20709429494940822 honest: an agent working on `sidestage` must not read
      // Papercusp's pipeline cells and misread them as its own pipeline.
      //
      // But an OPERATOR-SCOPE reader presents the `'*'` sentinel rather than a slug,
      // and a bare `===` compares that sentinel as if it were a literal harness name —
      // so the scope meaning "every harness" matched NONE of them. Measured 2026-08-21
      // (P-005): 418 distinct agents / 358,755 calls in 24h run as role `operator` with
      // harnessSlug `'*'`, and for every one of them all six pipeline cells read as
      // `absent` — while `dev:pipeline_position` served them the SAME values ungated,
      // and `stampStatePlane`'s `collect()` (which shares this check) silently dropped
      // its whole `plane` handle block. No secrecy was gained; only the re-read
      // discipline the state plane exists to provide was lost, for the exact population
      // CLAUDE.md points at these cells.
      //
      // BOTH conditions are required, and neither alone is safe:
      //   • the sentinel alone would fail OPEN — `http-projection` assigns `'*'` via a
      //     bare `if (!spawnCtx.harnessSlug)` fallback, so it means "unset", not
      //     "operator" (three call-site comments claim otherwise; the code does not).
      //     That is precisely the defaulted-audience failure D-016 names.
      //   • the role alone would re-open EI-20709429494940822 — `operator` sessions
      //     also run scoped to sidestage / scout-runtime / engineering, and those have
      //     a competing pipeline of their own to confuse this one with.
      // An operator-scope reader has declared no competing harness, so there is no
      // "their own pipeline" for it to misread this as.
      return (
        reader.harnessSlug === v.ref ||
        (isOperatorScopeSentinel(reader.harnessSlug) && (reader.roles ?? []).includes(OPERATOR_ROLE))
      );
    case 'work_item':
      return (reader.workItems ?? []).includes(v.ref);
    default:
      // An unregistrable spec should never reach here, but if it does, fail CLOSED.
      return false;
  }
}

/** Registered cells, keyed by id. Registration is ONE call — that cheapness is a
 *  D-010 precondition, not a nicety: if registering a cell is not measurably cheaper
 *  than minting a tool, adoption fails and the registry should not ship. */
const CELLS = new Map<string, CellSpec>();

export class CellRegistrationError extends Error {
  constructor(readonly rejections: CellRejection[]) {
    super(
      `cell "${rejections[0]?.cell}" refused by the D-038 contract:\n` +
        rejections
          .map((r) => `  · ${typeof r.axis === 'number' ? `axis ${r.axis}` : r.axis} [${r.rule}] ${r.detail}`)
          .join('\n'),
    );
    this.name = 'CellRegistrationError';
  }
}

/** Register a cell. THROWS on any contract violation — a refused cell is absent, not
 *  present-and-suspect, because a registered cell reads as system truth and that
 *  raises the cost of a wrong one above what prose ever had. */
export function registerCell(spec: CellSpec): CellSpec {
  const rejections = validateCellSpec(spec);
  if (rejections.length > 0) throw new CellRegistrationError(rejections);
  const existing = CELLS.get(spec.cell);
  if (existing && existing.resolver !== spec.resolver) {
    throw new CellRegistrationError([
      {
        cell: spec.cell,
        axis: 5,
        rule: 'duplicate-resolver',
        detail: `"${spec.cell}" is already registered with resolver "${existing.resolver}". One derivation, many lenses — project the existing cell instead of re-deriving it.`,
      },
    ]);
  }
  /**
   * D-008 — PRODUCER PATHS ARE UNIQUE WITHIN A SHARED PAYLOAD.
   *
   * Several cells legitimately share ONE resolver (axis 5: one derivation, many
   * lenses) — `gitPipelinePosition()` backs five. Sharing the resolver means sharing
   * the PAYLOAD, so two such cells declaring the same `assessment.path` are reading
   * the same field and calling it two different verdicts: whichever registers second
   * silently inherits the first one's assessment. This is why D-008 fixes distinct
   * producer paths (`assessments.gateVerdict`, `assessments.deployedSha`, …) for
   * shared payloads and reserves the bare `assessment` for single-purpose resolvers.
   *
   * Checked HERE rather than in `validateCellSpec` because it is the one assessment
   * rule that is not answerable from a single spec — it is a property of the
   * registry, exactly like `duplicate-resolver` above.
   *
   * ⚠ EXACT comparison, deliberately, where the in-spec distinctness checks use
   * `norm`. There the point is to catch a re-punctuated restatement of the headline;
   * here a false positive would REFUSE a legitimate registration and block P-004, and
   * `norm` collapses genuinely different paths (`a.gateVerdict` / `a.gate.verdict`)
   * onto each other.
   */
  if (spec.assessment) {
    const path = spec.assessment.path?.trim();
    if (path) {
      for (const other of CELLS.values()) {
        if (other.cell === spec.cell) continue;
        if (other.resolver !== spec.resolver) continue;
        if (other.assessment?.path?.trim() !== path) continue;
        throw new CellRegistrationError([
          {
            cell: spec.cell,
            axis: 'assessment',
            rule: 'assessment-path-collides-in-shared-payload',
            detail: `assessment.path "${path}" is already claimed by "${other.cell}", which shares this cell's resolver "${spec.resolver}" and therefore its payload. Two cells reading one field as two different verdicts means one of them is reporting the other's assessment. Give each a distinct producer path (D-008: \`assessments.<cell>\`).`,
          },
        ]);
      }
    }
  }

  CELLS.set(spec.cell, spec);
  return spec;
}

/**
 * Read a cell's spec AS a specific reader. P-019: a cell the reader may not see
 * comes back `undefined` — indistinguishable from one that does not exist, so a
 * refusal cannot be used to probe for narrow cells.
 *
 * The reader argument is REQUIRED rather than optional on purpose. An optional
 * audience is a defaulted audience, and a defaulted access check fails OPEN — the
 * precise failure D-016 calls out ("a default is how a field dies") applied to the
 * one field class where the default is also a vulnerability.
 */
export function getCell(cell: string, reader: CellReader): CellSpec | undefined {
  const spec = CELLS.get(cell);
  if (!spec) return undefined;
  return canReadCell(spec, reader) ? spec : undefined;
}

/** Every cell THIS reader may see, sorted. Narrow cells are omitted, not marked. */
export function listCells(reader: CellReader): CellSpec[] {
  return [...CELLS.values()]
    .filter((s) => canReadCell(s, reader))
    .sort((a, b) => a.cell.localeCompare(b.cell));
}

/**
 * UNCHECKED registry introspection — no audience filtering. Named loudly because
 * every call site is a potential P-019 bypass: use it for admin/inventory surfaces
 * that legitimately enumerate the registry itself, NEVER to serve an agent a value.
 * P-013's presence expansion must use `listCells(reader)`, not this.
 */
export function listCellsUnchecked(): CellSpec[] {
  return [...CELLS.values()].sort((a, b) => a.cell.localeCompare(b.cell));
}

/** UNCHECKED single read — same caveat as `listCellsUnchecked`. */
export function getCellUnchecked(cell: string): CellSpec | undefined {
  return CELLS.get(cell);
}

/** Test seam — drops every registration. */
export function __resetCellRegistryForTests(): void {
  CELLS.clear();
}
