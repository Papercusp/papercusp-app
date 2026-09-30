/**
 * The COMPLETION-AUTHORITY axis for work-items.
 *
 * Plan: agent-protocol-authority-semantics-2026-07-26, P-003.
 * Schema: `harness_shared.work_items.authority` (migration 677), exposed on both family
 * views. Writers land in P-004; nothing in this module has a caller yet.
 *
 * The COLUMN is `authority` but the API surface is `completionAuthority` — a deliberate
 * split, not an oversight. Renaming the column was attempted (678) and is not possible:
 * `harness_features_consolidated` has 2,485 dependent views, and renaming a column a view
 * exposes needs DROP + CREATE of that view. CREATE OR REPLACE can only APPEND a trailing
 * column, which is how 677 landed safely and why 678 could not. See D-009 — on this
 * schema, a column exposed through the consolidated views is effectively rename-proof.
 *
 * ── NOT THE OTHER `authority` (D-009) ────────────────────────────────────────
 * `authority` is already a load-bearing axis in this system, and it means something
 * else. Plan items carry `authority: 'system' | 'owner'` (libs/generic/plan-parser)
 * meaning WHO IS AUTHORIZED TO ACT, where `owner` always derives needsHuman. This
 * module is about HOW TRUSTWORTHY A TERMINAL CLAIM IS.
 *
 * The two are easy to conflate because both carry a human-attention value — `owner`
 * there, `pending_human` here — so the tempting inference is that they are one axis.
 * They are not: `pending_human` says a COMPLETION cannot be settled without the owner;
 * `authority: owner` says the WORK may not be done without the owner. An item can be
 * `authority: system` (any agent may do it) and still land `pending_human` (this
 * particular close needs ratification), and vice versa.
 *
 * Sibling modules make the same distinction elsewhere and are also not this:
 * `work-item-claim-authority.ts` (who owns a claim) and
 * `work-item-replica-authority.ts` (which replica is canonical).
 *
 * ── THE PROBLEM ──────────────────────────────────────────────────────────────
 * A terminal state conflates two orthogonal facts:
 *
 *   LIFECYCLE  "this item left the queue"                   → `status`
 *   AUTHORITY  "the claim that it is finished is trustworthy" → this module
 *
 * Sharing one column makes an evidence-free assertion indistinguishable from a
 * verified one, so the only available remedy was an audit that RE-OPENED bare
 * assertions after the fact. D-003 rejects that shape: verify-after-the-fact is a
 * correction layer over a value that can be wrong. Splitting the axis means an
 * unverified assertion never reaches the authoritative state to begin with.
 *
 * Measured before the split (P-002): 65.6% of 14,663 terminal rows carried no
 * structured verification evidence, and every one read as "done" to burn-down.
 *
 * ── WHY THIS IS CODE AND NOT A MARKDOWN TABLE ────────────────────────────────
 * D-004 holds that load-bearing behavioural commitments belong in the harness, not
 * in prose — and D-006 records the sharpest instance of the failure it describes:
 * `work_items:set_state` carries "completionRef is REQUIRED alongside a terminal
 * state" only inside a Zod `.describe()` string, while the field itself is
 * `.optional()`. The rule reads as enforced and is not.
 *
 * A state table describing this axis in a doc would have exactly that defect. So the
 * table below is the executable one: {@link COMPLETION_AUTHORITY_TRANSITIONS} is the sole
 * definition, {@link canTransition} is how callers ask, and the unit tests assert the
 * table's own invariants. Prose that disagrees with this file is wrong by construction.
 */

import type { CompletionVerificationEvidence } from './coord-lifecycle/records';

/**
 * How trustworthy a terminal claim is — orthogonal to lifecycle state.
 *
 * `proposed`      A completion was ASSERTED but carries no sufficient structured
 *                 evidence. Lifecycle-terminal, authority-unsettled. Does NOT count
 *                 toward burn-down. Stays owned by its closer, surfaced by nag and
 *                 never re-queued into the claimable pool (D-007).
 *
 * `committed`     Asserted WITH sufficient evidence — `verifiedHow` plus at least one
 *                 of `testsRun` / `testResult` (see {@link isSufficientEvidence}).
 *                 Counts toward burn-down. The normal path for a good close.
 *
 * `validated`     RESERVED. A `committed` claim additionally corroborated by a signal
 *                 INDEPENDENT of its closer — a green run located in the test-run
 *                 ledger, a cited commit that provably exists, an owner ratification.
 *                 Counts toward burn-down. **No writer ships in this phase**; see the
 *                 honesty note on {@link COMPLETION_AUTHORITY_TRANSITIONS}.
 *
 * `pending_human` The claim cannot be settled by agent or machine and awaits owner
 *                 ratification. Does NOT count toward burn-down.
 *
 * `invalid`       A previously-recorded terminal claim was CONTRADICTED: the item was
 *                 reopened, the fix did not hold, or a superseding item replaced it.
 *                 Retains the fact that a bad close happened — information a reopen
 *                 destroys today.
 *
 * `null` is NOT a sixth value. It is the absence of a judgement, and it means one of
 * exactly two things, disambiguated by the row's lifecycle state:
 *
 *   non-terminal + null → the item is open; it owes no claim yet.
 *   terminal     + null → a LEGACY close made under the pre-authority contract.
 *                         Counts toward burn-down; never nagged, reopened, or
 *                         reclassified. This is D-005 expressed structurally rather
 *                         than as a policy someone has to remember.
 */
export type WorkItemCompletionAuthority = 'proposed' | 'validated' | 'committed' | 'pending_human' | 'invalid';

export const WORK_ITEM_COMPLETION_AUTHORITIES: readonly WorkItemCompletionAuthority[] = [
  'proposed',
  'validated',
  'committed',
  'pending_human',
  'invalid',
] as const;

export function isWorkItemCompletionAuthority(v: unknown): v is WorkItemCompletionAuthority {
  return typeof v === 'string' && (WORK_ITEM_COMPLETION_AUTHORITIES as readonly string[]).includes(v);
}

/**
 * Which principal class is entitled to make a given transition.
 *
 * `gate`          the completion gate at close time (`work_items:complete`, and after
 *                 P-005 `work_items:set_state`) — the only actor that can mint an
 *                 authority from nothing.
 * `system`        an audited internal bypass identity (reaper, watchdog, hygiene pass).
 *                 Per D-006 these are NOT a hole to close: they are 5 enumerated call
 *                 sites with a maintained identity list
 *                 (KNOWN_SYSTEM_COMPLETION_BYPASS_IDENTITIES, completion-audit.ts).
 *                 A system close lands `committed`, never `proposed` — `proposed`
 *                 means "an agent owes evidence", and nagging a reaper is pure noise.
 * `owner`         owner or fleet-leader ratification.
 * `corroboration` an independent confirmation source. RESERVED — see below.
 */
export type CompletionAuthorityActor = 'gate' | 'system' | 'owner' | 'corroboration';

/** The `from` side of a transition; `null` = no judgement recorded yet. */
export type CompletionAuthorityFrom = WorkItemCompletionAuthority | null;

export interface CompletionAuthorityTransition {
  from: CompletionAuthorityFrom;
  to: WorkItemCompletionAuthority;
  /** Principal classes permitted to make this transition. */
  by: readonly CompletionAuthorityActor[];
  /** Why this edge exists — the condition under which it fires. */
  when: string;
}

/**
 * THE STATE TABLE. Every legal transition, exhaustively.
 *
 * Read it as a lattice with one entry point and one sink:
 *
 *      (null) ──gate/system──> committed ──corroboration──> validated
 *         │                        │                            │
 *         ├──gate──> proposed ─────┤                            │
 *         │             │          │                            │
 *         ├──gate──> pending_human ┤                            │
 *         │             │          │                            │
 *         └─────────────┴──────────┴──> invalid <───────────────┘
 *                                          │
 *                       (re-close) ────────┘
 *
 * Deliberate NON-edges, each a design choice rather than an omission:
 *
 *  · `committed → pending_human` is ABSENT. An owner who disputes a committed close is
 *    contradicting it, not deferring it: the honest edge is `committed → invalid`,
 *    followed by a fresh close. Allowing the softer edge would let a disputed close sit
 *    in a state that still reads as "awaiting paperwork" rather than "was wrong".
 *
 *  · `pending_human → proposed` is ABSENT. An owner asked to ratify either does
 *    (`committed`) or does not (`invalid`). Bouncing it back to `proposed` would make
 *    the owner's non-answer look like the closer's omission.
 *
 *  · Nothing returns to `null`. The absence of a judgement is not a state you can
 *    re-enter — once the system has an opinion about a close, erasing it would
 *    manufacture a legacy row, and legacy rows are exempt from nagging (D-005). That
 *    exemption must not be reachable by a live code path.
 *
 * ── ON `validated` SHIPPING WITHOUT A WRITER ─────────────────────────────────
 * Every other value is minted by the gate at close time. `validated` needs a
 * corroboration source that does not exist yet, so no `corroboration` edge has a caller
 * in this phase. It is declared now so the migration's CHECK constraint does not need
 * rewriting later — but a value nothing can produce is dead surface, and dead surface
 * that sits in an enum acquires imaginary meaning. Its first writer is a P-013
 * deliverable; if P-013 does not land one, the honest move is to DROP it from the enum
 * and the constraint, not to leave it as decoration.
 */
export const COMPLETION_AUTHORITY_TRANSITIONS: readonly CompletionAuthorityTransition[] = [
  // ── entry: the gate mints an authority at close time ───────────────────────
  {
    from: null,
    to: 'committed',
    by: ['gate', 'system'],
    when: 'a terminal close carrying sufficient evidence, or an audited system close',
  },
  {
    from: null,
    to: 'proposed',
    by: ['gate'],
    when: 'a terminal close whose evidence is absent, partial, or below the minimum',
  },
  {
    from: null,
    to: 'pending_human',
    by: ['gate', 'owner'],
    when: 'a close on an owner-authority surface that only the owner can settle',
  },

  // ── the closer settles their own debt ──────────────────────────────────────
  {
    from: 'proposed',
    to: 'committed',
    by: ['gate'],
    when: 'the closer re-completes the item supplying the evidence that was missing',
  },
  {
    from: 'proposed',
    to: 'pending_human',
    by: ['owner'],
    when: 'an under-evidenced close is escalated for owner ratification',
  },

  // ── the owner rules ────────────────────────────────────────────────────────
  {
    from: 'pending_human',
    to: 'committed',
    by: ['owner'],
    when: 'the owner ratifies the completion',
  },
  {
    from: 'pending_human',
    to: 'invalid',
    by: ['owner'],
    when: 'the owner rejects the completion',
  },

  // ── corroboration (RESERVED — no caller in this phase) ─────────────────────
  {
    from: 'committed',
    to: 'validated',
    by: ['corroboration'],
    when: 'an independent signal confirms the claim (test-run ledger, cited commit, ratification)',
  },

  // ── contradiction: any settled claim can turn out to be wrong ──────────────
  {
    from: 'proposed',
    to: 'invalid',
    by: ['gate', 'system', 'owner'],
    when: 'the item is reopened or the claim is otherwise contradicted',
  },
  {
    from: 'committed',
    to: 'invalid',
    by: ['gate', 'system', 'owner'],
    when: 'the item is reopened, the fix did not hold, or a superseding item replaced it',
  },
  {
    from: 'validated',
    to: 'invalid',
    by: ['gate', 'system', 'owner'],
    when: 'even a corroborated claim can be contradicted by later evidence',
  },

  // ── re-close after a contradiction ─────────────────────────────────────────
  {
    from: 'invalid',
    to: 'committed',
    by: ['gate', 'system'],
    when: 'the item is closed again, this time with sufficient evidence',
  },
  {
    from: 'invalid',
    to: 'proposed',
    by: ['gate'],
    when: 'the item is closed again without sufficient evidence',
  },
  {
    from: 'invalid',
    to: 'pending_human',
    by: ['gate', 'owner'],
    when: 'the re-close needs owner ratification',
  },
] as const;

/** Is this transition legal, and (optionally) legal for this actor? */
export function canTransition(from: CompletionAuthorityFrom, to: WorkItemCompletionAuthority, by?: CompletionAuthorityActor): boolean {
  const edge = COMPLETION_AUTHORITY_TRANSITIONS.find((t) => t.from === from && t.to === to);
  if (!edge) return false;
  return by === undefined || edge.by.includes(by);
}

/** Every authority reachable from `from` (optionally, by this actor). */
export function transitionsFrom(from: CompletionAuthorityFrom, by?: CompletionAuthorityActor): readonly WorkItemCompletionAuthority[] {
  return COMPLETION_AUTHORITY_TRANSITIONS.filter((t) => t.from === from && (by === undefined || t.by.includes(by))).map(
    (t) => t.to,
  );
}

/**
 * Does a terminal row count toward burn-down, claimable-drain, and "done" in a leader
 * brief?
 *
 * The two authoritative values count. `null` on a TERMINAL row counts because it is a
 * legacy close (D-005) — the single most consequential line in this module, since
 * getting it wrong retroactively deletes ~9,600 rows of completion history.
 *
 * Callers must pass whether the row's lifecycle state is terminal; this module does not
 * know the per-family terminal sets (feature: passed|deprecated, issue: resolved|closed).
 */
export function countsTowardBurnDown(
  authority: CompletionAuthorityFrom,
  isTerminal: boolean,
  isAbandoned = false,
): boolean {
  if (!isTerminal) return false;
  // Dropped/deprecated/closed outcomes settle the lifecycle without claiming code landed.
  // They are outside the causal Git receipt contract, so an incidental authority value must
  // never make them wait on git-sync.
  if (isAbandoned) return true;
  if (authority === null) return true; // legacy pre-authority close — D-005
  return authority === 'committed' || authority === 'validated';
}

/**
 * Shared delivery-settlement predicate. Lifecycle terminality removes an item
 * from the claim queue; this answers whether downstream consumers may rely on
 * the close. Null remains the legacy compatibility case.
 */
export function isCompletionSettled(
  authority: CompletionAuthorityFrom,
  isTerminal: boolean,
  isAbandoned = false,
): boolean {
  return countsTowardBurnDown(authority, isTerminal, isAbandoned);
}

/**
 * Is a terminal row a LEGACY close — made before the authority contract existed, and
 * therefore exempt from nagging, reopening, and reclassification (D-005)?
 */
export function isLegacyClose(authority: CompletionAuthorityFrom, isTerminal: boolean): boolean {
  return isTerminal && authority === null;
}

/**
 * EI-21574559473613348 — reconcile the authority a close COMPUTED in-process with the one
 * the database actually STORED, and report the stored one.
 *
 * ── WHY THESE CAN DISAGREE ─────────────────────────────────────────────────────
 * Migration 972 installs a BEFORE trigger,
 * `harness_shared.downgrade_unproven_committed_close()`, which re-applies the
 * content-identity floor in SQL. That placement is deliberate: it holds the floor BELOW
 * the deploy boundary, so a frozen release build serving older code cannot mint stronger
 * authority than current source permits. When it fires it rewrites 'committed' to
 * 'proposed' and RAISEs a WARNING — which reaches the Postgres log and nobody else.
 *
 * So a close could be told 'committed' by the tool and stored as 'proposed' in the same
 * write, with nothing surfacing the contradiction. Agents then truthfully relayed the
 * response value and were wrong about the durable record; that is how this was found.
 *
 * `persisted` must come from a read taken AFTER the write (both of complete.ts's write
 * paths re-read the row through the issue view), or this reconciliation is meaningless.
 * The computed value is the fallback ONLY for a writer that stamps no authority at all,
 * so legacy/system paths are unchanged.
 */
export function reconcileStampedAuthority(input: {
  /** did this call actually stamp a close? (terminal state reached, no state error) */
  stamped: boolean;
  /** authority on the row re-read AFTER the write — the post-trigger truth */
  persisted: CompletionAuthorityFrom;
  /** authority this process computed before the write */
  computed: CompletionAuthorityFrom;
  /** the pre-floor evidence judgement, used to attribute a DB-side downgrade */
  authorityByEvidence: string;
  /** how many paths the completion declared in `filesChanged` */
  declaredFilesCount: number;
  /** did the in-process floor already downgrade this close? */
  inProcessContentIdentityMissing: boolean;
}): {
  stampedAuthority: CompletionAuthorityFrom;
  contentIdentityDowngrade: boolean;
  divergedFromComputed: boolean;
} {
  if (!input.stamped) {
    return { stampedAuthority: null, contentIdentityDowngrade: false, divergedFromComputed: false };
  }
  const stampedAuthority = input.persisted ?? input.computed;
  // The floor can be applied in EITHER place, and the remedy text is identical, so
  // attribute off the OUTCOME rather than the site. Keyed only to the in-process flag, a
  // DB-side downgrade fell through to generic "supply evidence" advice, which names
  // fields the caller already sent and can never clear the downgrade.
  const contentIdentityDowngrade =
    input.inProcessContentIdentityMissing ||
    (stampedAuthority === 'proposed' &&
      input.authorityByEvidence === 'committed' &&
      input.declaredFilesCount > 0);
  return {
    stampedAuthority,
    contentIdentityDowngrade,
    divergedFromComputed: input.persisted !== null && input.persisted !== input.computed,
  };
}

/**
 * The minimum evidence bar for `committed`.
 *
 * `verifiedHow` PLUS at least one of `testsRun` / `testResult`. Both halves are load-
 * bearing:
 *
 *  · `verifiedHow` alone is a label. "unit" with nothing behind it asserts a category,
 *    not a verification.
 *  · `testsRun`/`testResult` alone is prose with no claim about what KIND of check it
 *    was, which is precisely what a leader audit cannot triage in bulk.
 *
 * P-002 measured why the partial case must be rejected explicitly rather than assumed
 * away: 4.2% of evidence-bearing rows already carry a `_completionEvidence` object with
 * NO `verifiedHow` at all. An "is the object present?" test passes every one of them.
 * `filesChanged` and `addedTests` are deliberately NOT sufficient — both describe what
 * changed, neither asserts that anything was checked.
 *
 * EI-18685043434033870 adds ONE necessary condition on top, and it is the converse of
 * that last sentence rather than a contradiction of it: `addedTests` still cannot SUPPLY
 * sufficiency, but when it is `true` it makes `filesChanged` REQUIRED. "I added or changed
 * tests" and "I will not say which file" cannot both be true, so the pair is refutable on
 * the face of the record — no prose heuristic, no guess about what the summary meant.
 *
 * Why only this one condition, when the owner's ask was a path in general ([owner 2026-07-26]
 * "entirely true, but unverifiable until I asked for a path"): a path is NOT required
 * unconditionally, because many honest closes change no files — `already-passing`
 * verifications, investigations, duplicates. Measured over 24h of papercusp closes
 * (2026-08-13, 2,236 `committed`): 1,437 carried no path, but 555 of those were
 * `verifiedHow: 'already-passing'`, i.e. correctly pathless. Requiring a path from them
 * would not produce evidence, it would produce FABRICATED evidence — the failure
 * EI-20093150500083378 already measured, where 8 of 12 declared paths did not exist.
 *
 * The `addedTests` condition is calibrated instead of blunt: of 593 `addedTests: true`
 * closes in that window, 577 ALREADY cited a path. So this codifies what good closes
 * already do and refuses only the ~16/day self-contradictory ones. (The blunter rule —
 * requiring a path from every `unit`/`integration` close — would have reclassified 530/day
 * and is deliberately NOT applied here; that is a policy call with real burn-down blast
 * radius, not a coherence check.)
 */
export type InsufficientEvidenceReason =
  | 'no-evidence'
  | 'no-verified-how'
  | 'no-test-run-or-result'
  | 'added-tests-without-path'
  | 'no-requirement-disposition'
  | 'test-result-contradicted-by-run'
  | 'requirement-disposition-unfaithful'
  | 'completion-claim-falsified'
  | 'files-changed-never-existed'
  | 'files-changed-untouched'
  | 'residue-unowned';

/**
 * Impurely-derived findings about a completion, computed by the CALLER and handed in.
 *
 * P-001 (design-to-code-coverage-seam-2026-09-02) needs the grade to depend on whether
 * `filesChanged` resolves against the real tree — a question no pure function can answer.
 * Rather than make {@link insufficientEvidenceReason} async and impure (which would break
 * every caller AND forfeit the computed-once property this module's shape exists to
 * guarantee), the impure work stays at the call site and its VERDICT arrives here.
 *
 * Every field is optional and absence means "not judged", never "judged clean" — so a
 * caller that cannot run the probe, or chooses not to, gets exactly today's behaviour.
 * That is what keeps this fail-open by construction rather than by remembering to be.
 */
export interface CompletionEvidenceFindings {
  /**
   * Declared `filesChanged` paths proven NEVER to have existed in this tree — absent from
   * disk AND unknown to git history.
   *
   * D-016: this is deliberately NOT "paths that do not exist". Non-existence has three
   * causes and only one is a defect — the file was FABRICATED, the file was DELETED by
   * this very change, or the question is unjudgeable (glob, submodule, no repo root, fs
   * error). Grading on bare absence would penalise honest refactor and cleanup closes
   * hardest, which is why `unresolvedPathsInCompletion` (complete.ts) is warn-only by
   * design and stays that way. Git history is the discriminator that separates cause 1
   * from cause 2, and only cause 1 belongs here.
   */
  filesChangedNeverExisted?: readonly string[];

  /**
   * Declared `filesChanged` paths that are REAL BUT UNTOUCHED — the file exists in this
   * tree, the working tree is clean at it, and its last commit predates the work window.
   *
   * P-005 / D-016: once `filesChangedNeverExisted` makes an invented path cost a grade,
   * the cheapest way to satisfy that check is to name a real file you did not touch. This
   * is the next rung — D-016 calls P-005 the "strictly stronger successor" — and the two
   * fields are DISJOINT BY CONSTRUCTION: that one judges only paths absent from disk,
   * this one only paths present on it, so one defect can never be graded twice.
   *
   * Resolution lives in `agent-tools/work_items/untouched-paths.ts`. Its load-bearing
   * safety property is the WORKING-TREE check: this repo shares one checkout swept by
   * git-sync on a schedule, so at close time an honest edit is usually still uncommitted
   * and its git history still predates the item. Git history alone would therefore accuse
   * exactly the agent who did the work — which is why the sibling detector
   * `preExistingChangedPathsInCompletion` is, and stays, warn-only. A path is cleared by
   * EITHER proof of work: a dirty working tree, or a commit inside the window. Submodule
   * paths, unknown history, an unreadable tree and any throw are all silence. Absence
   * means "not judged", never "judged clean".
   */
  filesChangedUntouched?: readonly { path: string; lastCommitAt: string }[];

  /**
   * Declared `verification.claims` that were RE-EVALUATED against the source and found
   * FALSE — e.g. a close asserting `'coord:dispatch'` is an element of
   * `CORE_MCP_TOOL_NAMES` when the array does not contain it.
   *
   * EI-22175397357614106: every other check in this module is a presence test, so a close
   * whose evidence is present, well-formed and WRONG grades `committed`. This is the
   * falsity half. It is the one finding here that the CLOSER opted into — the claim is
   * caller-declared — which is exactly why it carries no risk of unchecked testimony: a
   * declared claim is re-derived from the tree, never believed.
   *
   * Carries only claims whose verdict was `falsified`. An `unevaluatable` claim (source
   * unreadable, container renamed, membership hidden behind a spread) is deliberately NOT
   * included: absence means "not judged", never "judged clean", and a detector that
   * punished undecidability would fire hardest on honest closes touching moving code.
   */
  claimsFalsified?: readonly { claim: string; reason: string }[];

  /**
   * The closing agent's own most recent `testing:run` went RED in the `test_runs` ledger,
   * so the declared `testsRun`/`testResult` is contradicted by a ledgered verdict.
   *
   * P-002 / D-017: today any non-empty test string satisfies the gate, so the literal
   * `"3 failed"` earns `committed` — the check reads that a field is PRESENT, never that
   * it says anything true. This field carries the falsifiable half: a run group id and the
   * files that failed in it, so the refusal can CITE the run rather than assert a verdict.
   *
   * Resolution lives in `agent-tools/work_items/test-result-binding.ts` and is generous by
   * construction — only the agent's most recent run is judged (fixing a red and re-running
   * green is normal good work), a window resolving to more than one run group is refused
   * outright (that is the concurrent-peer case, and no column says which group is ours),
   * and only `fail`/`error` count. Absence means "not judged", never "judged clean".
   */
  testRunContradictedByLedger?: {
    runGroupId: string;
    failingFiles: readonly string[];
    filesInRun: number;
  };

  /**
   * The close's requirement-by-requirement disposition is absent where the close's own
   * fields demand one, or is present and unfaithful to the ask it claims to answer.
   *
   * P-021 / D-014: layer A's answer to under-delivery. `kind:'unfaithful'` names entries
   * whose quote is not a literal span of the originating body (paraphrase is where silent
   * narrowing hides), whose `implemented` cites no path that resolves, or whose `deferred`
   * names no filed follow-up. `kind:'absent'` fires ONLY on the self-contradictory
   * population — a close that declares deferred work while saying nothing about which
   * part of the ask was left — because demanding a disposition from every code-shaped
   * close would reclassify 2,053 closes/week and is a policy call, not a coherence check
   * (D-019; the same line this module already draws at the 530/day rule above).
   *
   * Resolution lives in `agent-tools/work_items/requirement-disposition.ts` and is
   * generous by construction: no source text, a body too thin to state a requirement, no
   * resolvable repo root, an unjudgeable citation, or any throw all yield silence.
   * Absence means "not judged", never "judged clean".
   *
   * Note the ONE narrative field this consults — `deferred` — only ever DEMOTES. The
   * invariant that narrative fields never participate in authority exists to stop them
   * PROMOTING an evidence-free close to `committed`; reading one to demand more evidence
   * respects that purpose rather than bending it.
   */
  requirementDispositionShortfall?: {
    kind: 'absent' | 'unfaithful';
    notQuotedFromSource: readonly string[];
    implementedWithoutResolvingCitation: readonly string[];
    deferredWithoutFollowUp: readonly string[];
  };

  /**
   * Follow-up refs this close cites that are still OPEN with NO assignee.
   *
   * D-041 (R-18): filing is not disposing. `work_items:create` without `assign_to` leaves
   * an item unclaimed, so a close that files its residue that way and cites the id in
   * `deferred`, `coverage.residue`, `requirementDisposition[].followUp` or its summary has
   * handed the work to nobody (measured 6/6 in S35). Resolution is
   * `unownedResidueRefs` (coord-lifecycle/records.ts): a summary-only ref counts only when
   * this closer filed it during the work, and an unreadable store or an unresolved id is
   * silence. Like `deferred` above, this only ever DEMOTES.
   */
  residueUnowned?: readonly string[];
}

/**
 * WHY the evidence falls short, or `undefined` when it does not.
 *
 * This exists because the remedy differs per reason, and a caller told the WRONG remedy is
 * worse off than one told nothing: an agent refused for `added-tests-without-path` already
 * HAS `verifiedHow` and `testsRun`, so the generic "supply verifiedHow plus testsRun"
 * advice sends them to re-submit the exact fields they already sent — a refusal loop whose
 * instructions can never resolve it.
 *
 * {@link isSufficientEvidence} delegates here so the verdict and its explanation are
 * computed once. A separate "why" function that re-derived the conditions could disagree
 * with the gate it explains, which is the failure this shape rules out structurally.
 */
export function insufficientEvidenceReason(
  evidence: CompletionVerificationEvidence | null | undefined,
  findings?: CompletionEvidenceFindings,
): InsufficientEvidenceReason | undefined {
  if (!evidence) return 'no-evidence';
  if (!evidence.verifiedHow) return 'no-verified-how';
  if (!evidence.testsRun?.trim() && !evidence.testResult?.trim()) return 'no-test-run-or-result';
  // A close that claims it added/changed tests must say WHERE. Note this reads the
  // declared paths only — whether they EXIST is a separate detector (complete.ts,
  // EI-20093150500083378); this one refuses the record that names none at all.
  if (evidence.addedTests === true && !evidence.filesChanged?.some((f) => f.trim())) {
    return 'added-tests-without-path';
  }
  // P-021 / D-014. LAST of the missing-field checks: the four above name a field the close
  // omitted about ITSELF, whose remedy is one line. This one names a missing account of the
  // ASK, whose remedy is to re-read the originating body and enumerate it — more work, so a
  // close failing both should hear the cheaper repair first.
  //
  // Reaching this line means the caller ran the probe AND the close contradicts itself:
  // it declared deferred work while saying nothing about which part of the ask was left.
  // Every other shape (no deferred work, a body too thin to quote, a close naming no files,
  // any throw) leaves the field undefined and falls through — see D-019 for why this is
  // deliberately not demanded of every code-shaped close.
  if (findings?.requirementDispositionShortfall?.kind === 'absent') {
    return 'no-requirement-disposition';
  }
  // P-002 / D-017. FIRST of the three present-and-wrong checks, deliberately: a red test run
  // means the WORK is not finished, while a fabricated path means the RECORD is wrong about
  // finished work. A close failing both should hear the blocking one first — "your own last
  // test run failed" is what has to change before the close is legitimate at all, and being
  // told to fix a path list instead would send the agent to repair the smaller problem.
  //
  // Reaching this line means the caller ran the ledger probe AND it resolved a run group
  // with a red row in it. Every ambiguity upstream (no run, a stale run, a window spanning
  // two groups, an unstamped row, any throw) leaves the field undefined and falls through.
  if (findings?.testRunContradictedByLedger?.failingFiles?.length) {
    return 'test-result-contradicted-by-run';
  }
  // P-021 / D-014. Between the two: a red run means the WORK is unfinished (blocking), a
  // fabricated path means the RECORD is wrong about the files. This one sits between them
  // because it means the record is wrong about the ASK — more serious than a mis-stated
  // file list, less blocking than a suite that does not pass.
  if (findings?.requirementDispositionShortfall?.kind === 'unfaithful') {
    return 'requirement-disposition-unfaithful';
  }
  // P-001 / D-016. LAST deliberately: the checks above name a MISSING field, whose
  // remedy is "supply it". This one names a field that is present and wrong, whose remedy
  // is "correct it" — so a close failing both should hear about the missing field first,
  // because supplying it is the cheaper and more basic repair.
  //
  // Reaching this line means the caller ran the probe AND it returned a confident verdict.
  // An unrun or unjudgeable probe leaves `findings` (or the field) undefined and falls
  // through to `undefined` below — today's grade, unchanged.
  // EI-22175397357614106. Placed BEFORE the fabricated-path check and after the red-run
  // one, following the same ordering rationale as its neighbours: a red suite means the
  // WORK is unfinished (blocks harder), while a falsified claim and a fabricated path both
  // mean the RECORD is wrong. Of those two, a false claim about what the code DOES is the
  // more serious — it is the substantive assertion a reader would act on, and the measured
  // instance propagated three items downstream into an armed falsifier — whereas a wrong
  // path list misdescribes where the work landed.
  //
  // Reaching this line means claims were DECLARED and at least one was re-evaluated against
  // the source and found false. No declared claims, an unreadable source, a renamed
  // container, or any throw leaves the field undefined and falls through to today's grade.
  if (findings?.claimsFalsified?.length) return 'completion-claim-falsified';
  if (findings?.filesChangedNeverExisted?.length) return 'files-changed-never-existed';
  // P-005 / D-016. LAST, below its own predecessor. The two are disjoint populations (absent
  // from disk vs present on it), so this ordering almost never arbitrates a real tie — but
  // where it could, "this path never existed" is the more concrete defect and the cheaper
  // repair, so it should be heard first. This one is also the weaker claim of the pair: it
  // says a real file was named without being changed, which a closer may need git history to
  // check, whereas a fabricated path is self-evident once pointed at.
  //
  // Reaching this line means the caller ran the probe AND it cleared the path by neither
  // proof of work — the tree is clean at it and no commit touched it inside the window. A
  // dirty tree, a commit in the window, a submodule path, unknown history, an unreadable
  // tree, or any throw leaves the field undefined and falls through to today's grade.
  if (findings?.filesChangedUntouched?.length) return 'files-changed-untouched';
  // D-041 (R-18). LAST: every check above judges the work or the record of it, while this one
  // judges what the close leaves behind, and its repair (assign the follow-up) is the cheapest.
  if (findings?.residueUnowned?.length) return 'residue-unowned';
  return undefined;
}

export function isSufficientEvidence(
  evidence: CompletionVerificationEvidence | null | undefined,
  findings?: CompletionEvidenceFindings,
): boolean {
  return insufficientEvidenceReason(evidence, findings) === undefined;
}

/**
 * The authority a gate-driven close lands in, given its evidence. The single decision
 * P-004 wires into `work_items:complete` and `work_items:set_state`.
 *
 * Note what this does NOT do: it never returns `pending_human` (that is an owner-surface
 * property of the ITEM, not of its evidence) and never returns `invalid` (a
 * contradiction is a separate event, not a completion outcome).
 */
export function authorityForCompletion(
  evidence: CompletionVerificationEvidence | null | undefined,
  findings?: CompletionEvidenceFindings,
): Extract<WorkItemCompletionAuthority, 'committed' | 'proposed'> {
  return isSufficientEvidence(evidence, findings) ? 'committed' : 'proposed';
}
