/**
 * Item-scoped terminal criteria — the `requireDurableChange` half of the completion floor.
 *
 * Plan: `machine-enforced-terminal-criteria-2026-09-05` (source item EI-20191442676357637).
 * Read D-011 before extending this file. The short version of why this module is SMALL:
 *
 * - The rootCause half of the floor is ALREADY LIVE and stronger than this plan first
 *   specified. `complete.ts` requires `completion.rootCauseVerification` for successful
 *   bug/capability-gap closes and REJECTS without it, behind a strict contrastive schema
 *   (`RootCauseVerificationSchema`, coord-lifecycle/records.ts). Do not reimplement it
 *   here — a softer duplicate would be a loosening shipped as a tightening (D-002, D-011).
 * - `requiredProofFloor(clause, classRef)` in ../plans/spec-test-adequacy is CLAUSE-scoped
 *   and cannot be invoked for a close with no spec clause, which is the overwhelming
 *   majority. This module therefore COMPOSES with that evaluator rather than widening its
 *   signature, and deliberately reuses its `AdequacyRatingEntry` / `wouldBlock` / verdict
 *   vocabulary so there is exactly one evidence dialect (D-001, D-009).
 *
 * What remains, and what this module is: the one conjunct with teeth. D-006 measured the
 * four stored closes of EI-20185455308799001 and found that the discriminating case is a
 * close which NAMES a genuine mechanism and changes nothing — attributing remediation to
 * commits that already landed. A contrastive causal record does not catch that, because it
 * can be entirely truthful about a cause the closer did not fix. Narrating a cause is a
 * report, not a fix.
 */
import type { AdequacyRatingEntry } from '../plans/spec-test-adequacy';

export const TERMINAL_CRITERION_KEYS = ['durable-change', 'forbidden-evidence-mode'] as const;
export type TerminalCriterionKey = (typeof TERMINAL_CRITERION_KEYS)[number];

/**
 * Default forbidden evidence-only mode, as folded comparison keys (see {@link dispositionKey}).
 *
 * `already-passing` means "the pre-existing tests were green" — which, for a recurrence
 * defect, is the one observation guaranteed to be true WHILE THE BUG IS LIVE. As the sole
 * stated verification it is therefore not evidence of a fix at all.
 *
 * A parameter rather than a hardcode, for the same reason as
 * {@link DEFAULT_REMEDIATING_KINDS}: widening it owes its own measurement.
 */
export const DEFAULT_FORBIDDEN_EVIDENCE_ONLY_MODES: readonly string[] = ['already-passing'];

/**
 * Kinds whose SUCCESSFUL close implies a durable change should have landed.
 *
 * Deliberately conservative. Measured 2026-09-05 over successful closes since 2026-08-17
 * (n=29,019): task 49.67%, bug 40.49%, change 6.11%, feature 3.68%. `task` is the single
 * largest population and a great many task closes are legitimately zero-code (an audit, a
 * triage sweep, a research answer), so admitting it here by assumption would manufacture
 * failures rather than catch them. Widening this set is a separate decision that owes its
 * own measurement — it is a parameter, not a hardcode, for exactly that reason.
 */
export const DEFAULT_REMEDIATING_KINDS: readonly string[] = ['bug', 'change'];

/**
 * Dispositions that explicitly disclaim remediation. A close carrying one of these is
 * rated `not-applicable`, never `fail`: a wontfix legitimately changes no files, and a
 * floor that refused them would recreate the unsatisfiability class this plan exists to
 * avoid (D-008, D-010, and the live advisory defect EI-22410970761779199).
 */
export const NON_REMEDIATING_TERMINAL_REASONS: readonly string[] = [
  'wontfix',
  'will-not-fix',
  'duplicate',
  'superseded',
  'obsolete',
  'not-reproducible',
  'no-repro',
  'by-design',
  'works-as-intended',
  'invalid',
];

const SUCCESS_STATUSES: ReadonlySet<string> = new Set(['done', 'resolved', 'passed']);

/** Case/underscore-folded comparison key. Mirrors the folding `complete.ts` uses for its own markers. */
function normalizeToken(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase().replaceAll('_', '-') : '';
}

/**
 * Comparison key for a DISPOSITION label, folding away every separator.
 *
 * Deliberately stricter than {@link normalizeToken}. D-007 measured that `verifiedHow` is
 * not a closed enum in practice — real closes carry `unit+integration`, `unit and
 * integration`, and whole paragraphs — so an exact-match set silently no-ops on honest
 * callers, not just evasive ones. `terminal_reason` is free text for the same reason, and
 * this module's own test caught the same bug here: `WONT_FIX` folds to `wont-fix`, which a
 * hyphen-preserving set does not contain. Stripping all non-alphanumerics collapses
 * `wontfix`, `wont-fix`, `WONT_FIX` and `won't fix` onto one key.
 */
function dispositionKey(value: unknown): string {
  return normalizeToken(value).replace(/[^a-z0-9]/g, '');
}

const NON_REMEDIATING_DISPOSITION_KEYS: ReadonlySet<string> = new Set(
  NON_REMEDIATING_TERMINAL_REASONS.map(dispositionKey),
);

/** One server-observed path identity from `treeStamp.contentIdentity`. */
export interface TerminalCriteriaContentIdentity {
  path: string;
  workingTreeBlobSha?: string | null;
  headBlobSha?: string | null;
  /** Server-stamped marker for a caller-declared intentional deletion. */
  deletion?: true;
  /** Why the HEAD side could not be READ. Present ONLY for the unresolvable case. */
  headBlobUnresolvable?: string;
  /** Path owned by no checkout (an evidence artifact, not a code change). */
  outOfRepoArtifact?: true;
}

export interface TerminalCriteriaTreeStamp {
  contentIdentity?: readonly TerminalCriteriaContentIdentity[];
}

export interface TerminalCriteriaInput {
  /** The mapped work-item kind (`item_kind`), as `getWorkItem` returns it. */
  itemKind?: string | null;
  /** The terminal status this close is requesting. */
  status: string;
  /** The recorded disposition, when the close declares one. */
  terminalReason?: string | null;
  filesChanged?: readonly string[] | null;
  filesDeleted?: readonly string[] | null;
  /**
   * Server-observed tree stamp. ABSENCE MEANS "NOT OBSERVED" — never "clean", and never
   * "no change landed". The schema is explicit about this and so is this module.
   */
  treeStamp?: TerminalCriteriaTreeStamp | null;
  /** Override for {@link DEFAULT_REMEDIATING_KINDS}; an item-level tightening may widen it. */
  remediatingKinds?: readonly string[];
  /**
   * The close's stated verification mode, verbatim as the caller wrote it.
   *
   * FREE TEXT, not an enum — D-007 measured `unit+integration`, `unit and integration`,
   * `typecheck`, `live` and whole paragraphs in the live population. Never compare it with
   * `===` against a canonical value; see {@link forbiddenEvidenceModeRating}.
   */
  verifiedHow?: string | null;
  /**
   * Modes that may not stand as the SOLE verification, from
   * {@link resolveTerminalCriteria}. Defaults to
   * {@link DEFAULT_FORBIDDEN_EVIDENCE_ONLY_MODES}; pass `[]` to disable the criterion.
   */
  forbiddenEvidenceOnlyModes?: readonly string[];
}

export interface TerminalCriteriaResult {
  /** Whether the floor applies to this close at all. */
  claimsRemediation: boolean;
  ratings: Record<TerminalCriterionKey, AdequacyRatingEntry>;
  /** Criteria rated `fail` or `unknown`, matching spec-test-adequacy's own contract. */
  wouldBlock: TerminalCriterionKey[];
  verdict: 'pass' | 'fail' | 'unknown';
}

/**
 * Does this close CLAIM to have remediated something?
 *
 * Derived from the close's disposition, never from its evidence. Deriving it from the
 * evidence would be circular in exactly the case that matters: the discriminating close in
 * D-006 declared no files, so "declares files ⇒ claims remediation" would have excused it
 * from the only check capable of catching it.
 */
export function claimsRemediation(input: TerminalCriteriaInput): boolean {
  if (!SUCCESS_STATUSES.has(normalizeToken(input.status))) return false;
  const reason = dispositionKey(input.terminalReason);
  if (reason && NON_REMEDIATING_DISPOSITION_KEYS.has(reason)) return false;
  const kinds = input.remediatingKinds ?? DEFAULT_REMEDIATING_KINDS;
  return kinds.map(normalizeToken).includes(normalizeToken(input.itemKind));
}

/** A path identity that proves a durable change actually landed for that path. */
function identityProvesDurableChange(entry: TerminalCriteriaContentIdentity): boolean {
  if (entry.outOfRepoArtifact === true) return false;
  // A deletion is proven only when BOTH sides are null AND the server stamped the marker;
  // absence alone is never read as intent.
  if (entry.deletion === true) return !entry.workingTreeBlobSha && !entry.headBlobSha;
  return Boolean(entry.workingTreeBlobSha) || Boolean(entry.headBlobSha);
}

/**
 * A path whose HEAD side could not be READ. This is a measurement failure, not a closer
 * failure, and the two demand opposite remedies — so it yields `unknown`, never `fail`.
 * Blaming the closer for a resolution bug is the specific defect `headBlobUnresolvable`
 * was added to prevent.
 */
function identityIsUnresolvable(entry: TerminalCriteriaContentIdentity): boolean {
  return Boolean(entry.headBlobUnresolvable) && !entry.workingTreeBlobSha;
}

function durableChangeRating(input: TerminalCriteriaInput, applies: boolean): AdequacyRatingEntry {
  if (!applies) {
    return {
      rating: 'not-applicable',
      evidence:
        `Close does not claim remediation (status=${normalizeToken(input.status) || '<none>'}, ` +
        `kind=${normalizeToken(input.itemKind) || '<none>'}` +
        `${normalizeToken(input.terminalReason) ? `, reason=${normalizeToken(input.terminalReason)}` : ''}). ` +
        'A close that asserts no fix is not required to have landed one.',
    };
  }

  const declaredPaths = (input.filesChanged?.length ?? 0) + (input.filesDeleted?.length ?? 0);
  if (declaredPaths === 0) {
    return {
      rating: 'fail',
      evidence:
        'Close claims remediation but declares no changed or deleted path. Naming a cause is a ' +
        'report, not a fix — a remediating close must point at something that landed.',
      suggestion:
        'Declare the paths this close actually changed in completion.filesChanged (bare ' +
        'repo-relative paths), or close with a non-remediating disposition if nothing landed.',
    };
  }

  const identities = input.treeStamp?.contentIdentity ?? [];
  if (identities.length === 0) {
    return {
      rating: 'unknown',
      evidence:
        `${declaredPaths} path(s) declared, but no server tree stamp was observed. Absence of a ` +
        'stamp means NOT OBSERVED — it is not evidence that the change did or did not land.',
      suggestion: 'Re-run the close where a repository root is resolvable so content identity can be observed.',
    };
  }

  const landed = identities.filter(identityProvesDurableChange);
  if (landed.length > 0) {
    return {
      rating: 'pass',
      evidence:
        `${landed.length} of ${identities.length} declared path(s) resolved to a real Git blob identity ` +
        `(e.g. ${landed[0]?.path}). A durable change landed.`,
    };
  }

  const unresolvable = identities.filter(identityIsUnresolvable);
  if (unresolvable.length > 0) {
    return {
      rating: 'unknown',
      evidence:
        `No declared path resolved, but ${unresolvable.length} could not be READ ` +
        `(e.g. ${unresolvable[0]?.path}: ${unresolvable[0]?.headBlobUnresolvable}). ` +
        'That is a resolution failure, not an absent change.',
      suggestion: 'Resolve the checkout/ref that could not be read, then re-evaluate; do not re-declare the paths.',
    };
  }

  return {
    rating: 'fail',
    evidence:
      `None of ${identities.length} declared path(s) resolved to a Git blob identity, and none was ` +
      'reported unresolvable — the declared content is genuinely absent from the tree.',
    suggestion:
      'Check the declared paths are bare repo-relative paths in the right repository; a repo-qualified ' +
      'prefix fails content identity and is the most common cause.',
  };
}

/**
 * Is the close's ONLY stated verification a mode that may not stand alone? (P-006)
 *
 * The comparison rule is the whole point of this function, and it is measured, not chosen
 * by taste (D-014). Of 851 closes whose `verifiedHow` mentions `already-passing`, **835
 * (98.1%) are the bare token** and the other 16 are each a one-off of the form
 * `already-passing<sep><a second, real verification>` — `already-passing + live database
 * predicate reproduction`, `already-passing; focused unit suite re-run at current HEAD`.
 *
 * So the two obvious strategies both fail, in opposite directions:
 *
 * - **Substring** (`includes(mode)`) rates all 16 qualified closes `fail`. Those are the
 *   closers who did MORE and said so; firing on exactly them teaches that describing extra
 *   verification is punished, and catches nothing the strict rule misses.
 * - **Raw equality** misses `ALREADY_PASSING` / `already passing` / `Already-Passing.` —
 *   this module already shipped that bug once with `WONT_FIX`.
 *
 * The rule that survives both is FOLDED WHOLE-STRING EQUALITY: fold away case and every
 * separator with {@link dispositionKey}, then require the entire folded `verifiedHow` to
 * equal the folded mode. Any substantive text beyond the token means the closer named other
 * verification and the criterion stands down. Measured on that population: catches 835,
 * false positives 0.
 *
 * Note what is deliberately NOT here, and WHY — the two reasons are different, and the
 * first one has now been corrected TWICE, in opposite directions:
 *
 * - Corroboration via `addedTests` is NOT BUILT. Both prior explanations were wrong; the
 *   second is the instructive one, so both are kept.
 *
 *   (1) This comment once claimed the field was "measured empty on all 851" — i.e. the
 *   cross-check would be dead code. FALSE, retracted: the probe behind it read
 *   `_completionEvidence->'verification'->'addedTests'`, NULL on 100% of rows because the
 *   field lands TOP-LEVEL. An empty result there is an artifact of the path, indistinguishable
 *   from a real absence.
 *
 *   (2) That retraction then OVER-corrected, citing "populated on ~65%" and calling the
 *   design question REOPENED. The number is real but answers a different question twice
 *   over: it describes ALL closes, not this criterion's subjects, and it counts KEY-PRESENCE,
 *   not `true`. Corroboration needs `true`, in the population the criterion actually rates —
 *   folded `verifiedHow` = `already-passing`. Measured 2026-09-05, harness papercusp,
 *   non-observation lane, status IN (done,resolved), rows carrying
 *   `payload->'_completionEvidence'`, positive control on `addedTests='true'` PASSED:
 *
 *     population                    closes   key present    `true`
 *     already-passing, all-time      2,112   1,817 (86%)     52 (2.5%)
 *     already-passing, 14d             465     421 (90%)     23 (4.9%)
 *     all closes, all-time          22,417  16,274 (73%)  7,934 (35%)
 *     all closes, 14d               10,841   7,043 (65%)  3,610 (33%)
 *
 *   So the field IS present here — the criterion would not be dead code, and (1) stays
 *   retracted — but it is `true` on 1 in 20 to 1 in 40 of exactly the closes it would
 *   corroborate. Read one way that rescues 2.5%; read the other it indicts 97.5%. Neither is
 *   a usable signal, so the question is NOT reopened. It is settled, for a reason (1) never
 *   gave: not "the field is unpopulated" but "the field is populated and nearly always
 *   `false` where it matters". History: plan `machine-enforced-terminal-criteria-2026-09-05`
 *   D-021 (the retraction) and D-022 (this population correction).
 *
 *   Scope of that measurement, stated rather than implied: it reads
 *   `payload->'_completionEvidence'` only, so `dropped` closes (which write
 *   `terminal_completion_ref`) are excluded by construction — right for a done/resolved
 *   population, but not a whole-system total. The SQL fold reproduces {@link dispositionKey}
 *   (lowercase, strip non-alphanumerics) and is applied WITHOUT the `applies` remediation
 *   gate, so the subset above is a superset of the criterion's real subjects.
 * - A filler-token stoplist for `already passing tests` is not here because no such value
 *   exists: the distribution is bare-token or genuinely qualified, with nothing between.
 *   This second finding is independent of the `addedTests` error above and was not
 *   re-measured during either correction — treat it as unverified rather than confirmed.
 *
 * The general lesson, since this file is where it was learned twice: an empty result is a
 * claim about the INSTRUMENT before it is a claim about the world — run a positive control
 * before recording an absence, especially when the absence is what lets you skip building
 * something. And a NON-empty result is a claim about a POPULATION before it is a claim about
 * yours: a correct number measured over the wrong rows reads exactly like the right answer,
 * and the correction of an error is where that is likeliest, because the relief of having
 * found the bug is what stops you asking which rows you just counted.
 */
function forbiddenEvidenceModeRating(
  input: TerminalCriteriaInput,
  applies: boolean,
): AdequacyRatingEntry {
  if (!applies) {
    return {
      rating: 'not-applicable',
      evidence: 'Close does not claim remediation, so no verification mode is required of it.',
    };
  }

  const forbidden = new Set(
    (input.forbiddenEvidenceOnlyModes ?? DEFAULT_FORBIDDEN_EVIDENCE_ONLY_MODES)
      .map(dispositionKey)
      .filter(Boolean),
  );
  if (forbidden.size === 0) {
    return {
      rating: 'not-applicable',
      evidence: 'No evidence-only mode is forbidden for this close.',
    };
  }

  const stated = dispositionKey(input.verifiedHow);
  if (!stated) {
    // A close that states NO mode cannot have a forbidden one as its sole mode. Whether a
    // mode must be stated at all is a different criterion; rating `fail` here would smuggle
    // that requirement in under this one and manufacture failures across the population.
    return {
      rating: 'not-applicable',
      evidence: 'Close states no verifiedHow, so there is no sole verification mode to test.',
    };
  }

  if (forbidden.has(stated)) {
    return {
      rating: 'fail',
      evidence:
        `Close states verifiedHow='${String(input.verifiedHow).trim()}' and nothing else. ` +
        'That mode may not stand as the sole verification: for a recurrence defect, ' +
        'pre-existing tests being green is the one observation guaranteed to hold WHILE THE ' +
        'BUG IS LIVE, so it cannot distinguish a fix from no fix.',
      suggestion:
        'State what was verified BEYOND the pre-existing suite — a test that fails without ' +
        'the change, a reproduction re-run, or a live probe — and record it in verifiedHow.',
    };
  }

  return {
    rating: 'pass',
    evidence:
      `verifiedHow='${String(input.verifiedHow).trim().slice(0, 120)}' is not a forbidden ` +
      'evidence-only mode.',
  };
}

/**
 * Evaluate the item-scoped terminal criteria for one close.
 *
 * Pure and side-effect free by design: it is the FILTER, and D-003 requires that an unmet
 * criterion downgrade a close to `proposed` while still RECORDING it. This function
 * therefore returns a verdict and never throws or refuses on its own.
 */
export function evaluateTerminalCriteria(input: TerminalCriteriaInput): TerminalCriteriaResult {
  const applies = claimsRemediation(input);
  const ratings: Record<TerminalCriterionKey, AdequacyRatingEntry> = {
    'durable-change': durableChangeRating(input, applies),
    'forbidden-evidence-mode': forbiddenEvidenceModeRating(input, applies),
  };
  const wouldBlock = TERMINAL_CRITERION_KEYS.filter((key) =>
    ['fail', 'unknown'].includes(ratings[key].rating),
  );
  const verdict = wouldBlock.some((key) => ratings[key].rating === 'fail')
    ? 'fail'
    : wouldBlock.length > 0
      ? 'unknown'
      : 'pass';
  return { claimsRemediation: applies, ratings, wouldBlock: [...wouldBlock], verdict };
}

/* -------------------------------------------------------------------------- *
 * Criteria resolution across sources (P-005, per D-002 and D-010).
 * -------------------------------------------------------------------------- */

export type ProofFloor = 'none' | 'l3' | 'l4';

/** Ordering for {@link ProofFloor}. The ONLY place floor strength is ranked. */
const FLOOR_RANK: Readonly<Record<ProofFloor, number>> = { none: 0, l3: 1, l4: 2 };

export type TerminalCriteriaSource = 'class' | 'item' | 'decision';

export interface TerminalCriteriaDeclaration {
  source: TerminalCriteriaSource;
  /** `classRef` | work-item id | `<plan-slug>#D-NNN`. */
  sourceRef: string;
  requireDurableChange?: boolean;
  minProofFloor?: ProofFloor;
  forbiddenEvidenceOnlyModes?: readonly string[];
}

export interface ResolvedTerminalCriteria {
  requireDurableChange: boolean;
  minProofFloor: ProofFloor;
  /** Union of every source's forbidden modes, as folded comparison keys. */
  forbiddenEvidenceOnlyModes: string[];
  /** `sourceRef`s that contributed, in application order. */
  sources: string[];
}

/**
 * Resolve declarations into one effective criteria set.
 *
 * D-002: `effectiveFloor = max(classFloor, itemFloor, decisionFloor)` and the forbidden set
 * is the UNION. Criteria may only ever TIGHTEN. This function is therefore MONOTONIC by
 * construction — adding a declaration can never lower the result — which is the property
 * the tests pin, because it is the whole safety argument for letting an item declare
 * criteria at all. The closer who most wants to skip evidence is exactly the one who would
 * write the override.
 */
export function resolveTerminalCriteria(
  declarations: readonly TerminalCriteriaDeclaration[],
): ResolvedTerminalCriteria {
  const forbidden = new Set<string>();
  let requireDurableChange = false;
  let floorRank = FLOOR_RANK.none;
  const sources: string[] = [];

  for (const declaration of declarations) {
    sources.push(declaration.sourceRef);
    if (declaration.requireDurableChange === true) requireDurableChange = true;
    if (declaration.minProofFloor) {
      floorRank = Math.max(floorRank, FLOOR_RANK[declaration.minProofFloor]);
    }
    for (const mode of declaration.forbiddenEvidenceOnlyModes ?? []) {
      const key = dispositionKey(mode);
      if (key) forbidden.add(key);
    }
  }

  const minProofFloor =
    (Object.keys(FLOOR_RANK) as ProofFloor[]).find((name) => FLOOR_RANK[name] === floorRank) ?? 'none';

  return {
    requireDurableChange,
    minProofFloor,
    forbiddenEvidenceOnlyModes: [...forbidden].sort(),
    sources,
  };
}

/**
 * Write-time guard: refuse a declaration that would LOWER the effective floor.
 *
 * D-002 requires this to be a refusal rather than a silent drop. `resolveTerminalCriteria`
 * already ignores a weakening declaration by taking a max, so the floor is safe either way
 * — but a silently-dropped tightening and a silently-dropped loosening look identical to
 * the caller, and one of those is a typo the author needs to hear about. Returns the
 * refusal reason, or null when the declaration is admissible.
 */
export function refuseLoweringDeclaration(
  candidate: TerminalCriteriaDeclaration,
  baseline: Pick<ResolvedTerminalCriteria, 'requireDurableChange' | 'minProofFloor'>,
): string | null {
  if (candidate.requireDurableChange === false && baseline.requireDurableChange) {
    return (
      `Declaration ${candidate.sourceRef} sets requireDurableChange:false while the effective ` +
      'baseline requires it. Criteria may only tighten (D-002); remove the field to inherit.'
    );
  }
  if (candidate.minProofFloor && FLOOR_RANK[candidate.minProofFloor] < FLOOR_RANK[baseline.minProofFloor]) {
    return (
      `Declaration ${candidate.sourceRef} sets minProofFloor:'${candidate.minProofFloor}' below the ` +
      `effective baseline '${baseline.minProofFloor}'. Criteria may only tighten (D-002); ` +
      'remove the field to inherit the higher floor.'
    );
  }
  return null;
}

export interface CriteriaSourcesInput {
  /** Floor from the plan class, when the item has a bound clause at all. */
  classDeclaration?: TerminalCriteriaDeclaration | null;
  /** Item-level criteria, read from `work_items.payload` (D-010: no dedicated column). */
  itemDeclaration?: TerminalCriteriaDeclaration | null;
  /** Criteria declared by a governing plan Decision. */
  decisionDeclaration?: TerminalCriteriaDeclaration | null;
  /** The item's `source_plan_slug`; absent for ~94.66% of closes. */
  sourcePlanSlug?: string | null;
}

/**
 * Collect the declarations that actually APPLY to one close.
 *
 * D-010's binding rule lives here: with no `source_plan_slug` there is no governing plan,
 * so decision-scope contributes NOTHING — it is dropped rather than rated `unknown` or
 * `fail`. An item with no plan cannot add a plan Decision, so requiring one of it would be
 * an instruction that cannot be followed. That is the EI-22166933881021603 unsatisfiability
 * class, and it reaches the overwhelming majority of closes here, so this is the default
 * path rather than an edge case.
 */
export function collectApplicableDeclarations(input: CriteriaSourcesInput): TerminalCriteriaDeclaration[] {
  const applicable: TerminalCriteriaDeclaration[] = [];
  if (input.classDeclaration) applicable.push(input.classDeclaration);
  if (input.itemDeclaration) applicable.push(input.itemDeclaration);
  if (input.decisionDeclaration && typeof input.sourcePlanSlug === 'string' && input.sourcePlanSlug.trim()) {
    applicable.push(input.decisionDeclaration);
  }
  return applicable;
}

/* -------------------------------------------------------------------------- *
 * Close-time composition (P-007, per D-003 / D-010 / D-015).
 * -------------------------------------------------------------------------- */

/** Key under `work_items.payload` holding an item-level declaration (D-010: no new column). */
export const ITEM_TERMINAL_CRITERIA_PAYLOAD_KEY = 'terminalCriteria';

function readFloor(value: unknown): ProofFloor | undefined {
  const token = normalizeToken(value);
  return token === 'none' || token === 'l3' || token === 'l4' ? token : undefined;
}

/**
 * Read an item-level declaration out of a work-item's free-form `payload`.
 *
 * Defensive by construction: `payload` is written by many callers and is not schema-bound,
 * so every field is validated and anything unrecognised is DROPPED rather than coerced. A
 * malformed declaration must never be able to weaken a close or break one — this is the
 * completion hot path, and D-003 requires a refused close to still be RECORDED.
 */
export function readItemTerminalCriteriaDeclaration(
  payload: unknown,
  sourceRef: string,
): TerminalCriteriaDeclaration | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const raw = (payload as Record<string, unknown>)[ITEM_TERMINAL_CRITERIA_PAYLOAD_KEY];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;

  const declaration: TerminalCriteriaDeclaration = { source: 'item', sourceRef };
  if (typeof record.requireDurableChange === 'boolean') {
    declaration.requireDurableChange = record.requireDurableChange;
  }
  const floor = readFloor(record.minProofFloor);
  if (floor) declaration.minProofFloor = floor;
  if (Array.isArray(record.forbiddenEvidenceOnlyModes)) {
    const modes = record.forbiddenEvidenceOnlyModes.filter(
      (mode): mode is string => typeof mode === 'string' && mode.trim().length > 0,
    );
    if (modes.length > 0) declaration.forbiddenEvidenceOnlyModes = modes;
  }

  const declaredSomething =
    declaration.requireDurableChange !== undefined ||
    declaration.minProofFloor !== undefined ||
    declaration.forbiddenEvidenceOnlyModes !== undefined;
  return declaredSomething ? declaration : null;
}

export interface TerminalCriteriaCloseInput
  extends Omit<TerminalCriteriaInput, 'forbiddenEvidenceOnlyModes' | 'remediatingKinds'> {
  /** The work-item row's `payload`, verbatim — the item declaration is read out of it (D-010). */
  payload?: unknown;
  /** Reference used to attribute an item-level declaration (normally the work-item id). */
  itemRef?: string;
  /** The item's `source_plan_slug`; gates decision-scope per D-010. */
  sourcePlanSlug?: string | null;
  classDeclaration?: TerminalCriteriaDeclaration | null;
  decisionDeclaration?: TerminalCriteriaDeclaration | null;
}

export interface TerminalCriteriaCloseOutcome {
  result: TerminalCriteriaResult;
  resolved: ResolvedTerminalCriteria;
  /**
   * Whether this close should be DOWNGRADED to `proposed`.
   *
   * D-015: `fail` only — never `unknown`. An `unknown` rating is a MEASUREMENT failure (no
   * tree stamp observed, a path that could not be read), and this module says so in its own
   * rating comments: blaming the closer for a resolution bug is the defect
   * `headBlobUnresolvable` exists to prevent. It also matches the sibling gate in
   * `complete.ts`, whose claims-falsification downgrade is deliberately silent on anything
   * the server could not decide, because absence of judgement is never judged-clean — and,
   * symmetrically, never judged dirty.
   */
  downgrade: boolean;
  /** Every criterion rated `fail`, in {@link TERMINAL_CRITERION_KEYS} order. */
  unmet: TerminalCriterionKey[];
  /**
   * The subset of {@link unmet} that actually forces the downgrade (D-016). The difference
   * is advisory: a criterion can be unmet and reported without changing authority, so a
   * reader must never infer the downgrade cause from `unmet` alone.
   */
  downgrading: TerminalCriterionKey[];
  /** Caller-facing sentence naming every unmet criterion; undefined when none is unmet. */
  warning?: string;
  /** A dropped item declaration that would have LOWERED the effective floor (D-002). */
  refusedDeclaration?: string;
}

/**
 * Evaluate one close against its resolved terminal criteria.
 *
 * Composition order is D-009's: collect the declarations that APPLY (D-010 drops
 * decision-scope for the ~94.66% of items with no `source_plan_slug`), resolve them
 * monotonically, then rate. Pure and total — it returns a verdict and never throws, so the
 * caller can treat an unmet criterion as a downgrade rather than a lost completion record.
 *
 * Which resolved fields are LOAD-BEARING here, stated plainly so no reader assumes more:
 * `forbiddenEvidenceOnlyModes` feeds the forbidden-mode criterion, and
 * `requireDurableChange` forces the durable-change criterion onto a kind outside
 * {@link DEFAULT_REMEDIATING_KINDS} (the only way a declaration can widen it). `minProofFloor`
 * resolves and is REPORTED but has NO consumer yet — no criterion reads a proof floor. It is
 * surfaced rather than silently dropped so a later criterion can consume it; treating it as
 * enforced today would be a claim this code does not honour.
 */
export function evaluateCloseTerminalCriteria(
  input: TerminalCriteriaCloseInput,
): TerminalCriteriaCloseOutcome {
  const itemRef = input.itemRef?.trim() || 'item';
  const itemDeclaration = readItemTerminalCriteriaDeclaration(input.payload, itemRef);

  // Resolve the baseline WITHOUT the item declaration first, so a lowering item-level
  // override is reported rather than silently ignored (D-002: resolve already takes a max,
  // but a silently-dropped tightening and a silently-dropped loosening look identical).
  const baseline = resolveTerminalCriteria(
    collectApplicableDeclarations({
      classDeclaration: input.classDeclaration,
      decisionDeclaration: input.decisionDeclaration,
      sourcePlanSlug: input.sourcePlanSlug,
    }),
  );
  const refusedDeclaration = itemDeclaration
    ? refuseLoweringDeclaration(itemDeclaration, baseline)
    : null;

  const declared = resolveTerminalCriteria(
    collectApplicableDeclarations({
      classDeclaration: input.classDeclaration,
      itemDeclaration: refusedDeclaration ? null : itemDeclaration,
      decisionDeclaration: input.decisionDeclaration,
      sourcePlanSlug: input.sourcePlanSlug,
    }),
  );

  // Seed the DEFAULT set into the union rather than letting a declaration replace it.
  // `evaluateTerminalCriteria` falls back to DEFAULT_FORBIDDEN_EVIDENCE_ONLY_MODES only when
  // the field is ABSENT, so passing the declared set alone would mean an item that declares
  // one EXTRA forbidden mode silently DROPS `already-passing` — a loosening delivered as a
  // tightening, which is precisely what D-002 forbids and what the closer most motivated to
  // write an override would get for free. Seeding also makes `forbiddenEvidenceOnlyModes: []`
  // unable to disable the criterion at composition scope, which is the correct reading of
  // "criteria may only ever tighten". (Caught by this module's own union test, not by review.)
  //
  // `resolved` carries the EFFECTIVE set, not the declared one: reporting a narrower set than
  // the one actually enforced would make every downgrade explanation subtly wrong about why.
  const resolved: ResolvedTerminalCriteria = {
    ...declared,
    forbiddenEvidenceOnlyModes: [
      ...new Set(
        [...DEFAULT_FORBIDDEN_EVIDENCE_ONLY_MODES, ...declared.forbiddenEvidenceOnlyModes].map(dispositionKey),
      ),
    ].sort(),
  };

  const remediatingKinds = resolved.requireDurableChange
    ? [...DEFAULT_REMEDIATING_KINDS, normalizeToken(input.itemKind)].filter(Boolean)
    : DEFAULT_REMEDIATING_KINDS;

  const result = evaluateTerminalCriteria({
    itemKind: input.itemKind,
    status: input.status,
    terminalReason: input.terminalReason,
    filesChanged: input.filesChanged,
    filesDeleted: input.filesDeleted,
    treeStamp: input.treeStamp,
    verifiedHow: input.verifiedHow,
    remediatingKinds,
    forbiddenEvidenceOnlyModes: resolved.forbiddenEvidenceOnlyModes,
  });

  const unmet = TERMINAL_CRITERION_KEYS.filter((key) => result.ratings[key].rating === 'fail');
  // D-016: which unmet criteria actually DOWNGRADE, measured rather than assumed. Over the
  // 10,320 committed bug/change closes since 2026-08-17, `durable-change` fails on 4,969 —
  // 48.1%, half of every defect close in the system — while `forbidden-evidence-mode` fails
  // on 633 (6.1%), of which 74 landed code and are invisible to every other check. A close
  // can legitimately remediate and declare no path (a config or environment fix, a fix that
  // landed in a submodule, a duplicate found late), which is the same reason this module
  // already refuses to admit `task` into DEFAULT_REMEDIATING_KINDS by assumption. So
  // durable-change WARNS by default and downgrades only where a class or item declaration
  // opts in with `requireDurableChange` — which is what that field is for, and what makes it
  // load-bearing rather than decorative.
  const downgrading = unmet.filter(
    (key) => key !== 'durable-change' || resolved.requireDurableChange,
  );
  const warning =
    unmet.length > 0
      ? `${unmet.length} terminal criteri${unmet.length === 1 ? 'on' : 'a'} unmet: ` +
        unmet
          .map((key) => {
            const entry = result.ratings[key];
            return `${key} — ${entry.evidence}${entry.suggestion ? ` Fix: ${entry.suggestion}` : ''}`;
          })
          .join(' | ') +
        (resolved.sources.length > 0 ? ` (criteria from ${resolved.sources.join(', ')})` : '') +
        (downgrading.length > 0
          ? '. The completion is RECORDED either way; only its authority is downgraded.'
          : '. Advisory only — this did NOT change the completion authority.')
      : undefined;

  return {
    result,
    resolved,
    downgrade: downgrading.length > 0,
    unmet: [...unmet],
    downgrading: [...downgrading],
    ...(warning ? { warning } : {}),
    ...(refusedDeclaration ? { refusedDeclaration } : {}),
  };
}
