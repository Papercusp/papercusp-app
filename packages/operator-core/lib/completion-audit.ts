/**
 * completion-audit — the completion-integrity predicates both work-item families
 * share, plus the write-path helpers that stamp a terminal transition.
 *
 * ## What this module is, AFTER P-006
 *
 * It is deliberately NO LONGER the "was this actually verified?" sweep. That question
 * is now answered at WRITE time by the `authority` column (P-003/P-004): an
 * evidence-less close lands `authority:'proposed'`, is excluded from burn-down, stays
 * owned by its closer, and the closer is told so in the response to the call that did
 * it. D-003 deleted the after-the-fact bareness audit rather than extending it —
 * a verify-later layer over a value that can no longer be wrong is dead weight, and
 * keeping it invites the band-aid pattern back.
 *
 * ## Why the historical bug is still worth knowing (EI-10867)
 *
 * The deleted `no-evidence` audit had keyed on `terminal_completion_ref IS NULL` — but
 * that column is not evidence, it is the gate's OWN bookkeeping, non-null BY
 * CONSTRUCTION for anything closed through the sanctioned path. Measured on the live
 * store: of 5,979 terminal rows carrying a completion ref, 4,119 (69%) had NO
 * structured verification evidence, and the audit reported every one as clean. A
 * leader ran it, saw an empty list, and concluded the fleet's completions were sound.
 * The root cause was a write/read split-brain — the WRITERS agreed on
 * `payload._completionEvidence` while the READER keyed on a different column, and
 * nothing forced them to agree.
 *
 * That failure mode is the reason for this module's standing discipline, which
 * outlives the audit it was written for: **any key, actor identity, or marker that a
 * write path stamps and a read path tests is declared HERE, once, and imported by
 * both** — never re-typed as a bare string at either end. See
 * {@link KNOWN_SYSTEM_COMPLETION_BYPASS_IDENTITIES} and
 * {@link RECONCILER_SYSTEM_ACTOR}, both of which are written by one module and read by
 * another precisely under that rule.
 */

import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, resolve as resolvePath } from 'node:path';

import { getOrgPg } from '@papercusp/db-org';
import { hasValidGitEntry } from './agent-tools/locks/valid-git-entry';
import { analyzeImageBlankness } from '@papercusp/image-blankness';
import { TERMINAL_COMPLETION_EVIDENCE_KEY, type CompletionVerificationEvidence } from './coord-lifecycle/records';
import { COMPLETION_CLAIM_RECHECK_KEY, COMPLETION_CLAIM_RECHECK_REGRESSED } from './completion-claim-recheck';
import { ANY_FAMILY_TERMINAL_STATES } from './work-item-dispatch-states';
import {
  authorityForCompletion,
  type CompletionEvidenceFindings,
  type WorkItemCompletionAuthority,
} from './work-item-completion-authority';
import { isTransportOnlyIdentity } from './agent-tools/coordination/identity';

type OrgSql = ReturnType<typeof getOrgPg>['sql'];

/**
 * The completion-integrity audits.
 *
 * ## `no-evidence` is GONE (P-006 / D-003 / D-012)
 *
 * The bareness audit — "terminal, but no structured verification evidence" — was
 * DELETED, not extended. P-004 made evidence structurally required: an evidence-less
 * close now lands `authority:'proposed'`, stays out of burn-down, stays owned by its
 * closer, and `work_items:complete` WARNS the closer in the response to the very call
 * that did it. There is no longer a wrong value to sweep for after the fact, which is
 * the whole of D-003 [owner 2026-07-11: *"lets just make sure its right the first
 * time so that it doesn't need to get 're-verified' to begin with"*]. Its EI-13424
 * false-positive softener (`looksLikeCitedProseEvidence`) went with it — keeping an
 * error-correction layer for a deleted predicate is the band-aid pattern inverted.
 *
 * D-012 is why the buckets BELOW survived that deletion: each fires on a row that
 * PASSES P-004's gate, so D-003's "nothing left to re-verify" reasoning does not
 * reach them. They are not a bareness audit wearing a different name.
 *
 *  - `no-completion-record` — terminal with `terminal_completion_ref IS NULL` AND
 *    `authority IS NULL`: a bare `set_state` close that bypassed the completion path
 *    altogether (this was the OLD `no-evidence` predicate). Rarer, and mostly pre-gate
 *    legacy rows — but a real and separate defect, so it keeps its own name instead of
 *    being silently dropped.
 *
 *    The `authority IS NULL` conjunct is P-004
 *    (agent-protocol-authority-semantics-2026-07-26). `work_items:complete` used to
 *    auto-fill `terminal_completion_ref` from `completion.summary` on every close; P-004
 *    DELETED that auto-fill and stamps an authority judgement instead. So from P-004
 *    onward a perfectly well-formed completion has a NULL ref, and a ref-only predicate
 *    would have flagged EVERY new close as "bypassed the completion path" — turning this
 *    audit into a fleet-wide false-alarm generator against exactly the rows that went
 *    through the gate most rigorously. A row carrying an authority judgement HAS a
 *    completion record, by definition: the judgement is what the gate produced.
 *
 *  - `no-completion-record-suspicious` (EI-18676290701611705) — the ACTIONABLE subset
 *    of `no-completion-record`: a bare-ref terminal row credited to someone who is NOT
 *    one of the small, audited `skipCompletionGate` system identities. A NULL ref is
 *    EXPECTED and benign for those five (the whole design point — see each bypass
 *    site's own doc comment); by construction, every OTHER caller already went through
 *    the completion-integrity gate, which REJECTS an empty completionRef on a terminal
 *    transition. So this combination — terminal, no ref, NOT a recognized system bypass
 *    — should be structurally impossible. Its existence (EI-18673480587329034: a MAJOR,
 *    human-verified bug closed by a real agent with both `completion` and
 *    `terminal_completion_ref` empty, and no matching bypass identity) means an
 *    undiscovered write path slipped past the gate — this audit is how a leader finds
 *    the NEXT one instead of hand-verifying source for every plain `no-completion-record`
 *    hit (most of which are the benign, expected system dedup flips).
 *
 *    **Scoped to `origin = 'local'` (EI-18821460229478708).** A row's own local write
 *    path is the ONLY thing this bucket can investigate — this install's `setIssueState`
 *    / `setWorkItemState`, not a REMOTE peer's. A federated (`origin = 'remote'`) row
 *    with the same bare shape says nothing about a local write path skipping the gate;
 *    it says its ORIGIN pot's local completion columns did not survive federation
 *    (its own concern, covered by `federated-column-completeness.integration.test.ts`,
 *    never by this per-close audit). Measured live on this install (2026-08-02): 7,461
 *    of 9,135 raw hits (82%) were `origin = 'remote'` — overwhelmingly residue from the
 *    authority/ref federation gap mig 708 (EI-18785839681430807) fixed going FORWARD
 *    but did not backfill, plus rows still arriving from any peer pot that has not yet
 *    picked up that migration. Counting them here sent a leader after a bug that either
 *    was never local, or was already fixed a week earlier (EI-18821460229478708's own
 *    filing history). They remain visible, un-hidden, under the sibling
 *    `no-completion-record-federated` bucket below — never silently dropped, just
 *    correctly labeled as not-this-install's-write-path.
 *
 *  - `no-completion-record-federated` (EI-18821460229478708) — the FEDERATED sibling of
 *    `no-completion-record-suspicious`: same bare shape (no ref, no authority, not a
 *    recognized system bypass identity) but `origin = 'remote'`. Deliberately its own
 *    NON-actionable bucket rather than folded into `no-completion-record` (which would
 *    hide the count) or left inside `-suspicious` (which would keep sending
 *    investigators after another pot's write path, or its own already-fixed history).
 *    A hit here is diagnostic ONLY about federation transport / the origin pot's own
 *    completion integrity — never about this install.
 *
 *  - `geometry-unverified` (WI-5891, the P-014/WI-5874 audit follow-up) — a terminal row
 *    whose `filesChanged` touches a layout-bearing file ({@link touchesLayoutBearingFiles}:
 *    `*.css`/`*.tsx`/`*.jsx`) while `verifiedHow` is `'unit'` or ABSENT. This is the
 *    detection-only sibling of {@link isBackedLiveDroveUiClaim}'s hard completion-boundary
 *    reject: WI-5874/P-001 shipped a real, visible WebKitGTK layout regression closed
 *    with `verifiedHow:'live-drove-ui'` citing only two vitest runs and no screenshot —
 *    structure-passing, pixel-failing. This bucket names that exact shape so a leader
 *    audit (`work_items:list { audit: 'geometry-unverified' }`) surfaces it going
 *    forward. P-004's gate does NOT close this: `verifiedHow:'unit'` plus
 *    `testResult:'42/42'` satisfies it completely and is exactly this bucket.
 *
 *  - `intermittent-underevidenced` (EI-18716652701919665) — a terminal row whose title is
 *    classified intermittent/flaky/racy ({@link looksLikeIntermittentClassification}) AND
 *    carries STRUCTURED completion evidence (so it passes P-004's gate outright) AND
 *    that evidence states neither a failure rate/root-cause nor cites a deterministic
 *    regression test ({@link hasIntermittentFailureRateEvidence}). This is an EVIDENCE-SHAPE
 *    defect, not a bareness one: WI-5673 (live-federation-gate content-matrix) closed with a
 *    fully structured, honest completion — `verifiedHow:'integration'`, testResult "2
 *    consecutive runs, 10/10 both times" — and would pass P-004's evidence gate cleanly.
 *    It then reopened 5 days later, now failing 4/4 with a wider blast radius. For a bug whose
 *    own title says "intermittently", N consecutive passes is a SAMPLE that cannot falsify
 *    "we happened to sample the passing branch N times" unless a per-run failure rate (or an
 *    actual root cause + deterministic repro test) is stated. This bucket names that gap so a
 *    leader audit (`work_items:list { audit: 'intermittent-underevidenced' }`) surfaces it,
 *    the same way `geometry-unverified` surfaces an evidence-shape mismatch for layout bugs.
 *
 *  - `reconciler-sourced` (EI-18677799334390930) — a terminal row credited to
 *    {@link RECONCILER_SYSTEM_ACTOR}. D-012 RESCUED this rule out of the deleted
 *    `no-evidence` branch, where it had been riding as an unrelated second clause; it is a
 *    RENAME, not a new audit. `plan-items/reconcile-linked-work-items.ts` terminal-closes a
 *    work-item by MIRRORING its linked plan-item's status, calling `setWorkItemState` with
 *    `completionAuthority:'proposed'` and NO completionRef. That is deliberate: a synthetic
 *    ref reads as genuine prose evidence, so manufacturing one would dress an unverified
 *    mirror up as an evidenced close (pinned by that module's integration tests). Such a row
 *    is by construction never independently verified — the failure mode is a mis-flipped plan
 *    item silently marking a live defect "fixed". Flagged on the ACTOR, not on an evidence
 *    key, so a future caller adding a well-meaning evidence stamp to that write path cannot
 *    defeat it.
 *
 *    ⚠ EI-20405552992224051 corrected this paragraph, which had INVERTED both halves of the
 *    write it describes: it claimed a "SYNTHETIC completionRef and no `authority` stamp", and
 *    concluded the row was "invisible to `no-completion-record` (it HAS a ref) and untouched
 *    by P-004 (no authority)". Both flipped when the structural fix this text called "filed,
 *    not built here" actually landed (2026-08-12) — the ref went away and the authority
 *    arrived, so the row now carries the opposite signature to the one documented. Read the
 *    write site before reasoning from any description of it, including this one.
 *
 *  - `claim-since-falsified` (WI-2142447) — a terminal row whose declared
 *    `verification.claims` HELD when the close was written and has since been FALSIFIED by
 *    the code moving underneath it. Every other bucket here judges the close as written;
 *    this one judges whether it is still true, which is the only thing that protects a
 *    reader who finds the close weeks later and acts on it.
 *
 *    ⚠ THE PREDICATE READS A RECORDED OBSERVATION, NEVER AN INFERENCE — and it must, because
 *    the finding is not SQL-decidable at all. Deciding it means re-parsing source files and
 *    re-evaluating an AST claim, which no `WHERE` clause can express; and the finding is a
 *    TRANSITION (`holds` then, `falsified` now), which even a perfect view of the current
 *    tree cannot distinguish from a claim that was already false at close and was already
 *    graded for it. So `completion-claim-recheck-action.ts` performs the comparison in
 *    process, against the close-time baseline persisted on `_completionEvidence.claimVerdicts`,
 *    and STAMPS its verdict onto the row; this predicate selects that stamp. Naming the bucket
 *    after a judgement its own predicate could not make is precisely the shape this module's
 *    header exists to warn about — an audit that cannot return the row it is named for.
 *
 *    A row that has never been swept therefore does not match, which is correct: never-checked
 *    and checked-clean are different states, and only the sweep may collapse one into the other.
 */
export const COMPLETION_AUDITS = [
  'no-completion-record',
  'no-completion-record-suspicious',
  'no-completion-record-federated',
  'geometry-unverified',
  'intermittent-underevidenced',
  'reconciler-sourced',
  'claim-since-falsified',
] as const;
export type CompletionAudit = (typeof COMPLETION_AUDITS)[number];

/**
 * How stale a release must be before `worked-then-abandoned` will name the row.
 *
 * 21 days, not a tunable: the bucket is an enum value with no parameters, and a
 * caller-chosen floor would let the same query answer "3 items" or "700" with nothing
 * in the result saying which question was asked. Measured on this install 2026-08-30
 * over open, non-observation rows: 2,043 had been worked-then-released at all, 721 more
 * than 7 days ago, 406 more than 21. The 7-day figure still contains ordinary in-flight
 * churn (an agent releasing to a peer, a lane handoff resumed next day); by 21 days a
 * release that was going to be picked back up already has been.
 */
export const WORKED_THEN_ABANDONED_STALE_DAYS = 21;

/**
 * Audits over OPEN rows — the lifecycle siblings of {@link COMPLETION_AUDITS}.
 *
 * Every bucket above judges a CLOSE and is meaningless on an open row (an open item has
 * no completion to be missing). This set is the mirror image: it judges rows that are
 * still open, and is meaningless on a terminal one. They are separate constants rather
 * than one flat list because the difference is not cosmetic — it decides which state
 * clause the query must apply, which is exactly what {@link auditWhereSql} exists to
 * derive rather than let each call site re-type (see its doc for the silent-empty-result
 * failure that motivated it).
 *
 *  - `worked-then-abandoned` (EI-19320339017813143) — a NON-terminal row that was
 *    claimed, worked, and RELEASED (`last_released_by IS NOT NULL`) more than
 *    {@link WORKED_THEN_ABANDONED_STALE_DAYS} days ago, and has sat open ever since.
 *
 *    The defect it names: `work_items:release` is the correct verb for "I am stopping
 *    work on this", and after confirming an item needs no change, "I am stopping work"
 *    feels accurate — but the item is DONE, and releasing it returns it to the backlog
 *    as unclaimed work. The next agent to scan the queue re-derives the same conclusion
 *    and releases it again. WI-5623 sat `open` + `critical` for 6 days after being
 *    verified fixed, with the evidence sitting unread in its checkpoint; three items
 *    from a single 2026-08-01 retrospective cluster (EI-19278588744322125,
 *    EI-19278589690487622, EI-19278590581840106) each sat open ~1 month after the work
 *    they asked for had shipped, each with prior holders who released without recording
 *    why. Closing all three needed no code — only someone reading the record.
 *
 *    ⚠ THIS IS A DETECTOR, NEVER A SWEEP, AND THE PREDICATE IS NOT A CLAIM THAT THE
 *    WORK IS DONE. "Released and untouched for three weeks" is a fact about the
 *    LIFECYCLE COLUMNS and nothing more; the reasons include already-delivered, but also
 *    genuinely-hard, deprioritized, and blocked-on-something-external. Every one of the
 *    406 live matches would have to be adjudicated by reading it, which is precisely
 *    what the three closes above cost. Do not build a closer on this — see
 *    {@link ./stranded-checkpoint-scan}, whose module header records the same rule
 *    reached from measurement (its checkpoint classifier ran at ~43% precision over an
 *    overlapping population, with false positives including a note that opened
 *    "⛔ DO NOT CLOSE").
 *
 *    RELATIONSHIP TO `work_items:stranded` — complementary, not a rival. That scan
 *    INNER JOINs `harness_shared.carry_notes` and asks a CONTENT question: does this
 *    open item's checkpoint DECLARE the work finished? This bucket asks a COLUMN
 *    question: was this item worked and then abandoned? Measured on the 406 live
 *    matches: 195 also carry a checkpoint (so the stranded scan can at least see them,
 *    if its classifier fires) and 211 carry NONE AT ALL — structurally unreachable by
 *    that join, and the population where the record is most damaged, because the holder
 *    left nothing behind to read. Neither surface subsumes the other and neither should
 *    grow into the other: keep this predicate on `work_items` columns only (it is
 *    evaluated inside eleven list/count queries) and keep checkpoint-content judgement
 *    in the module that owns the classifier.
 */
export const OPEN_WORK_ITEM_AUDITS = ['worked-then-abandoned'] as const;
export type OpenWorkItemAudit = (typeof OPEN_WORK_ITEM_AUDITS)[number];

/** Every value the `audit` filter accepts, across both state scopes. */
export const WORK_ITEM_AUDITS = [...COMPLETION_AUDITS, ...OPEN_WORK_ITEM_AUDITS] as const;
export type WorkItemAudit = (typeof WORK_ITEM_AUDITS)[number];

/**
 * Which state scope a bucket is defined over. Derived from set membership — never a
 * second hand-maintained list, so adding a bucket to {@link OPEN_WORK_ITEM_AUDITS} is
 * the whole of registering its scope.
 */
export function auditStateScope(audit: WorkItemAudit): 'terminal' | 'open' {
  return (OPEN_WORK_ITEM_AUDITS as readonly string[]).includes(audit) ? 'open' : 'terminal';
}

/**
 * The exact `terminal_owner` identities that intentionally close without a completion ref
 * or authority — kept here, beside the predicate that reads them, so the two can never
 * drift apart (the module's own discipline for `_completionEvidence` applied to this key
 * too). This includes explicit `skipCompletionGate` call sites and raw-SQL/system
 * reconciliation writers whose terminal rows are expected to carry no completion evidence:
 *  - 'watchdog-auto-close' (harness/improvements/auto-close.ts)
 *  - 'improvement-hygiene' (harness/improvements/hygiene.ts)
 *  - 'watchdog-orphan-superseded' (harness/improvements/orphaned-dispatch.ts)
 *  - 'hive-bee-exit' (fleet/bee-completion-reconcile.ts)
 *  - 'autonomy-revert' (autonomy/tripwire/revert-executor.ts)
 *  - 'system:work-item-admission-promoter' (work-items-admission-promoter.ts raw-SQL
 *    duplicate merge)
 *  - 'improvement-promotion-reconciler' (harness/improvements/capture-core.ts)
 */
export const KNOWN_SYSTEM_COMPLETION_BYPASS_IDENTITIES: readonly string[] = [
  'watchdog-auto-close',
  'improvement-hygiene',
  'watchdog-orphan-superseded',
  'hive-bee-exit',
  'autonomy-revert',
  // P-009 silent-intake-central-resolution-2026-09-01 (audit R6): the
  // episode-scoped-operational-reconcile system action's `setIssueState(...,
  // { skipCompletionGate: true })` closes via this exact `by` identity — see
  // harness/routines/episode-scoped-operational-reconcile-action.ts.
  'episode-scoped-operational-reconcile',
  // Intentional duplicate terminalization writers that do not pass through the
  // completion gate and therefore cannot carry completion ref/authority evidence.
  'system:work-item-admission-promoter',
  'improvement-promotion-reconciler',
];

/**
 * EI-18677799334390930: the `by` identity `plan-items/reconcile-linked-work-items.ts`
 * stamps when it terminal-closes a work-item by MIRRORING its linked plan-item's
 * done/dropped status (NOT `skipCompletionGate` — it satisfies the ordinary completion
 * gate with its `completionAuthority:'proposed'` stamp, carrying no completionRef at all;
 * EI-20405552992224051 corrected this from "by+completionRef gate with a synthetic ref",
 * which described the pre-2026-08-12 writer). Declared here, in the module that owns
 * the audit predicate, and imported by the reconciler — never re-typed as a bare
 * string in either place — so the write and the read can't drift apart (the exact
 * discipline this module's header describes for `_completionEvidence`).
 *
 * A reconcile-sourced close is BY CONSTRUCTION never independently verified: it only
 * ever mirrors an ADJACENT plan item's terminal status onto this work-item, which is
 * exactly how a mis-flip (the wrong plan item flipped `done`) silently marks a live
 * defect "fixed" with a completionRef that reads as genuine prose (see the module doc
 * above + `auditPredicateSql`'s `reconciler-sourced` branch, which flags this actor on
 * identity alone, regardless of whether a `_completionEvidence` key is ever added).
 */
export const RECONCILER_SYSTEM_ACTOR = 'system:plan-item-reconcile' as const;

/**
 * Automation identities that close through the ORDINARY completion gate — they supply a
 * `completionRef` and never pass `skipCompletionGate`, so
 * {@link KNOWN_SYSTEM_COMPLETION_BYPASS_IDENTITIES} (whose whole definition is that bypass)
 * cannot name them, and neither {@link SYSTEM_OWNER_PREFIXES} convention covers them either.
 *
 * They were invisible until something asked a question that depended on the answer.
 * Measured 2026-09-02 over 7 days in `papercusp-workspace`: `structural-error-verifier`
 * closed 397 work-items and every one classified `agent` — the exact misfiling the
 * `watchdog-green-resolve` note above says a membership-only test would produce, reappearing
 * because the membership list is keyed on a bypass these callers do not use.
 *
 * Registration is PINNED, not remembered: `completion-audit-system-closers.test.ts` scans
 * the tree for terminal-close call sites whose `by` is a bare string literal and fails when
 * one classifies `agent`. That is what makes the list a derived-truth rung-2 pin rather than
 * the hand-maintained "grep the repo to keep this exhaustive" instruction above — which is
 * the instruction that had already silently failed twice by the time it was checked.
 */
export const KNOWN_SYSTEM_GATED_CLOSER_IDENTITIES: readonly string[] = [
  // harness/structural-error-verifier.ts:256 — resolves issues whose structural error cleared.
  'structural-error-verifier',
  // harness/routines/tsc-red-sweep.ts:490 — resolves tsc-red filings once the type error is gone.
  'tsc-red-cleared-resolve',
];

/**
 * Which KIND of actor a `terminal_owner` names. Used to attribute a burn-down delta
 * (work_items:burn_down `deltaBy`) so a harness-wide close count is never read as one
 * fleet's output — the misread that reported ~30 closes/hour to an owner when the
 * fleet's real figure was ~6.6 (EI-19313376980892266).
 *
 * `system` is deliberately decided STRUCTURALLY (prefix) as well as by the known
 * identity constants, because the automation identities are declared in four different
 * modules and one of them — `watchdog-green-resolve` — is a bare string literal with no
 * constant at all (`harness/improvements/auto-close.ts`). A membership-only test would
 * therefore misfile it as an agent: measured 2026-08-03, that single identity closed 42
 * items in 30 days, all of which a prefix-blind classifier would have credited to agents.
 *
 * The classification is TOTAL and the buckets are MUTUALLY EXCLUSIVE — unlike the claim
 * `excluded` buckets, which overlap by construction. That makes the resulting counts a
 * true partition, which `deltaBy` asserts.
 */
export type TerminalOwnerClass = 'system' | 'agent' | 'unattributed';

/** Automation identity prefixes. `system:` is the routine/action convention; `watchdog-`
 *  is the improvements-watchdog convention (auto-close, green-resolve, orphan-superseded). */
const SYSTEM_OWNER_PREFIXES = ['system:', 'watchdog-'] as const;

/**
 * Classify a `terminal_owner` value. A null/blank owner is `unattributed` — NOT
 * `system`: "nobody recorded who closed this" and "automation closed this" are
 * different facts, and collapsing them would hide the mass-unattributed-close
 * signature that EI-18820653360383242 exists to keep visible.
 */
export function classifyTerminalOwner(owner: string | null | undefined): TerminalOwnerClass {
  const id = owner?.trim();
  if (!id) return 'unattributed';
  if (SYSTEM_OWNER_PREFIXES.some((p) => id.startsWith(p))) return 'system';
  if (id === RECONCILER_SYSTEM_ACTOR) return 'system';
  if (KNOWN_SYSTEM_COMPLETION_BYPASS_IDENTITIES.includes(id)) return 'system';
  if (KNOWN_SYSTEM_GATED_CLOSER_IDENTITIES.includes(id)) return 'system';
  return 'agent';
}

/**
 * The authority a terminal write should stamp when its caller judged nothing — or `null`
 * to leave today's behaviour untouched.
 *
 * ── WHAT THIS CLOSES (design-to-code-coverage-seam-2026-09-02 P-003) ────────────────
 * The completion gate is satisfied by EITHER a `completionRef` or a `completionAuthority`
 * (P-004), so a close supplying only a ref passes without any evidence ever being judged,
 * and the writer stores `authority = NULL`. `countsTowardBurnDown` reads a NULL terminal
 * authority as a LEGACY close and COUNTS it (D-005) — an exemption whose stated scope is
 * closes "made before the authority contract existed".
 *
 * Applied to a close being made TODAY, by a live agent, under that contract, the exemption
 * is simply false — and it inverts the incentive it was written to protect: an evidence-FREE
 * ref close counts toward burn-down, while an evidence-bearing but weak close lands
 * `proposed` and does not. Judging the ref path with the same function removes that
 * inversion. This is a coherence check on D-005's own definition, not the blanket policy
 * call D-019 declined: it demands no new field from anybody, and changes only what a close
 * that already declared nothing is CALLED.
 *
 * ── WHAT IT DELIBERATELY LEAVES ALONE ───────────────────────────────────────────────
 * Every guard here is a case where a stamp would assert a judgement nobody made:
 *  - a caller that supplied its own authority has already judged (never re-judge it);
 *  - `skipCompletionGate` paths are "not completions at all" — restore, watchdog sweeps,
 *    reconcile — so they carry no evidence to grade and keep their legacy NULL;
 *  - a `force` ref-only correction must preserve the authority a real close already earned;
 *  - a SYSTEM identity closes on outcomes with no code evidence in principle ("replication
 *    recovered", "duplicate collapse"). Measured 2026-09-02, grading those would manufacture
 *    ~1,600 meaningless `proposed` rows a week, which is the opposite of the point — and it
 *    is why {@link KNOWN_SYSTEM_GATED_CLOSER_IDENTITIES} had to exist before this could be
 *    correct at all;
 *  - a TRANSPORT-ONLY identity has no live agent behind it (see `isTransportOnlyIdentity`),
 *    so there is nobody whose evidence this would be.
 *
 * `findings` is the impure half {@link authorityForCompletion} accepts and is normally
 * absent here by construction: the caller that HAS findings (`work_items:complete`) is
 * exactly the caller that supplies its own authority and returns at the first guard.
 * Absence means "not judged", never "judged clean" — the same fail-open contract as
 * {@link CompletionEvidenceFindings} itself.
 */
export function derivedTerminalCompletionAuthority(input: {
  /** Is the state being written terminal for this row's family? */
  isTerminal: boolean;
  /** The closing identity (`by`) this write stamps as `terminal_owner`. */
  by: string | null | undefined;
  skipCompletionGate?: boolean;
  /** The authority the caller judged for itself, if any. */
  suppliedAuthority?: WorkItemCompletionAuthority | null;
  /** True when this write must preserve the stored completion record (a `force` ref-only correction). */
  preserveExistingRecord?: boolean;
  evidence?: CompletionVerificationEvidence | null;
  findings?: CompletionEvidenceFindings;
}): WorkItemCompletionAuthority | null {
  if (input.suppliedAuthority) return null;
  if (!input.isTerminal) return null;
  if (input.skipCompletionGate) return null;
  if (input.preserveExistingRecord) return null;
  const by = input.by?.trim();
  if (!by) return null;
  if (isTransportOnlyIdentity(by)) return null;
  if (classifyTerminalOwner(by) !== 'agent') return null;
  return authorityForCompletion(input.evidence, input.findings);
}

/**
 * WI-5891 — layout/geometry-bearing file extensions for the `geometry-unverified`
 * audit bucket. A `.css` file is unambiguously layout-bearing; `.tsx`/`.jsx` are
 * included too because `filesChanged` carries only PATHS (no diff content to check
 * for an actual `className`/`style` edit more precisely) — deliberately biased
 * toward flagging a touched component file rather than missing a real geometry
 * change. An audit DETECTION bucket is cheap to over-flag (a wasted read) but
 * expensive to under-flag (a shipped pixel regression), so this heuristic leans
 * deliberately toward flagging.
 */
const LAYOUT_BEARING_FILE_RE = /\.(?:css|tsx|jsx)$/i;

/** Pure — does this changed-file list touch a layout/geometry-bearing file? */
export function touchesLayoutBearingFiles(filesChanged: readonly string[] | null | undefined): boolean {
  if (!filesChanged?.length) return false;
  return filesChanged.some((f) => LAYOUT_BEARING_FILE_RE.test(f.trim()));
}

/** `verifiedHow` values that count as a genuine pixel/behavior check for a layout-bearing
 *  change. Everything else (`'unit'`, or the field absent) leaves the change's actual
 *  geometry unverified — the `geometry-unverified` audit fires exactly on that gap. */
const GEOMETRY_VERIFIED_HOW_VALUES = ['integration', 'live-drove-ui', 'manual', 'already-passing'] as const;

/** The `geometry-unverified` WHERE fragment, parameterized on the two jsonb-path
 *  expressions the two callers below alias differently (unaliased vs `ei.`). */
function geometryUnverifiedWhereSql(sql: OrgSql, filesChangedExpr: unknown, verifiedHowExpr: unknown) {
  return sql`(
    EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(COALESCE(${filesChangedExpr as string}, '[]'::jsonb)) AS f
       WHERE f ~* '\\.(css|tsx|jsx)$'
    )
    AND NOT (COALESCE(${verifiedHowExpr as string}, '') = ANY(${GEOMETRY_VERIFIED_HOW_VALUES as unknown as string[]}))
  )`;
}

/**
 * EI-18716652701919665 — title patterns that classify a work-item as a known-intermittent
 * bug. Word-bounded so e.g. "flaky" doesn't also match inside an unrelated word.
 */
const INTERMITTENT_TITLE_RE = /\b(?:intermittent(?:ly)?|flaky|flake|racy|race condition|nondeterministic|non-deterministic)\b/i;

/** Pure — does this title (or other short classification text) mark the underlying bug as
 *  intermittent/flaky/racy? Used by both the SQL bucket and any JS-side caller. */
export function looksLikeIntermittentClassification(title: string | null | undefined): boolean {
  if (!title) return false;
  return INTERMITTENT_TITLE_RE.test(title);
}

/**
 * EI-18716652701919665 — phrases that count as REAL evidence for an intermittent bug: a
 * stated failure rate/percentage, an explicit reference to having measured flakiness, or
 * language indicating an actual root cause + deterministic regression test were found
 * (which makes the bug no longer merely "sampled passing," but understood and pinned).
 * Deliberately narrow/textual, same bias as {@link touchesLayoutBearingFiles}: cheap to
 * over-flag (a wasted read) but expensive to under-flag (a still-flaky bug closed again on
 * another lucky streak).
 */
const INTERMITTENT_EVIDENCE_RE =
  /(\d+(?:\.\d+)?\s*%|failure rate|flake rate|flakiness|historically|root cause|regression test|deterministic repro|observed[^\n]{0,40}fail)/i;

/** Pure — does this completion evidence text (testResult/testsRun) state a failure rate or
 *  root cause, rather than just reporting a streak of consecutive passes? */
export function hasIntermittentFailureRateEvidence(text: string | null | undefined): boolean {
  if (!text) return false;
  return INTERMITTENT_EVIDENCE_RE.test(text);
}

// Postgres ARE equivalents of the two JS regexes above — kept textually parallel so the SQL
// bucket and the pure JS helpers can't silently diverge; `\y` is Postgres's word-boundary atom.
const INTERMITTENT_TITLE_SQL_RE =
  '\\y(intermittent(ly)?|flaky|flake|racy|race condition|nondeterministic|non-deterministic)\\y';
const INTERMITTENT_EVIDENCE_SQL_RE =
  '(\\d+(\\.\\d+)?\\s*%|failure rate|flake rate|flakiness|historically|root cause|regression test|deterministic repro|observed.{0,40}fail)';

/** The `intermittent-underevidenced` WHERE fragment, parameterized on the title + the two
 *  evidence-text jsonb-path expressions the two callers below alias differently (unaliased
 *  vs `ei.`). Only fires when structured evidence EXISTS (testResult/testsRun non-NULL) but
 *  is the wrong SHAPE — a row with no evidence at all never reaches `committed` in the
 *  first place (P-004), so there is no bareness case for this bucket to cover. */
function intermittentUnderevidencedWhereSql(sql: OrgSql, titleExpr: unknown, testResultExpr: unknown, testsRunExpr: unknown) {
  return sql`(
    ${titleExpr as string} ~* ${INTERMITTENT_TITLE_SQL_RE}
    AND (${testResultExpr as string} IS NOT NULL OR ${testsRunExpr as string} IS NOT NULL)
    AND NOT (
      COALESCE(${testResultExpr as string}, '') ~* ${INTERMITTENT_EVIDENCE_SQL_RE}
      OR COALESCE(${testsRunExpr as string}, '') ~* ${INTERMITTENT_EVIDENCE_SQL_RE}
    )
  )`;
}

/**
 * P-013 — the completion-AUTHORITY filter value: one of the judgements P-004 stamps, or
 * `'unjudged'` for a close that carries none (`authority IS NULL`).
 */
export type CompletionAuthorityFilter = WorkItemCompletionAuthority | 'unjudged';

/**
 * The completion-authority WHERE fragment, `alias`-qualified when the caller joins.
 *
 * Centralized for the SAME reason {@link auditPredicateSql} is (EI-10867): this predicate
 * is repeated across five call sites — listWorkItems/countWorkItems (feature family) and
 * listIssues/countIssues/countIssuesByState (issue family, two of them alias-qualified) —
 * and a hand-pasted copy in any one of them is how a read and its own COUNT companion
 * silently start answering different questions. One definition, five callers.
 *
 * Callers AND this with their own terminal-state predicate; the two families spell the
 * state column differently (`status` vs `state`), which is why that half stays outside.
 * Terminal-scoping is NOT optional: an open row has `authority` NULL by construction, so
 * an unscoped `'unjudged'` query returns the whole open backlog and reads as mass
 * under-evidencing instead of a measurement of closes.
 */
export function completionAuthorityPredicateSql(
  sql: OrgSql,
  authority: CompletionAuthorityFilter,
  alias?: string,
) {
  // `unknown` first, exactly as the sibling *WhereSql helpers above type their expression
  // params: sql.unsafe() returns a PendingQuery, and the `as string` the tagged-template
  // interpolation needs is not a legal direct conversion from it.
  const col: unknown = alias ? sql.unsafe(`${alias}.authority`) : sql.unsafe('authority');
  return authority === 'unjudged'
    ? sql`${col as string} IS NULL`
    : sql`${col as string} = ${authority}`;
}

/**
 * The `completionAuthority` filter's accepted values, as a literal tuple for `z.enum`.
 *
 * `satisfies` proves every entry is a legal {@link CompletionAuthorityFilter} at compile
 * time while preserving the literal types z.enum needs. It cannot prove EXHAUSTIVENESS
 * (a newly-added authority silently missing here would still compile), so
 * completion-audit.test.ts asserts this list covers WORK_ITEM_COMPLETION_AUTHORITIES —
 * a new authority that is not filterable fails there rather than becoming a value the
 * store can hold but no reader can select.
 */
export const COMPLETION_AUTHORITY_FILTERS = [
  'proposed',
  'validated',
  'committed',
  'pending_human',
  'invalid',
  'unjudged',
] as const satisfies readonly CompletionAuthorityFilter[];

/**
 * The audit's WHERE fragment. Callers AND it with their own terminal-state predicate
 * (the two families spell their state column differently — `status` vs `state`).
 */
export function auditPredicateSql(sql: OrgSql, audit: WorkItemAudit) {
  if (audit === 'worked-then-abandoned') {
    return sql`last_released_by IS NOT NULL AND last_released_at IS NOT NULL AND last_released_at < now() - make_interval(days => ${WORKED_THEN_ABANDONED_STALE_DAYS})`;
  }
  if (audit === 'no-completion-record') return sql`terminal_completion_ref IS NULL AND authority IS NULL`;
  if (audit === 'no-completion-record-suspicious') {
    // EI-18821460229478708: origin='local' ONLY — see this bucket's module-header doc for
    // why a federated row's bare shape is never evidence about THIS install's write paths.
    return sql`terminal_completion_ref IS NULL AND authority IS NULL AND origin = 'local' AND (terminal_owner IS NULL OR NOT (terminal_owner = ANY(${KNOWN_SYSTEM_COMPLETION_BYPASS_IDENTITIES as string[]})))`;
  }
  if (audit === 'no-completion-record-federated') {
    // EI-18821460229478708: the non-actionable federated sibling — same shape, origin='remote'.
    return sql`terminal_completion_ref IS NULL AND authority IS NULL AND origin = 'remote' AND (terminal_owner IS NULL OR NOT (terminal_owner = ANY(${KNOWN_SYSTEM_COMPLETION_BYPASS_IDENTITIES as string[]})))`;
  }
  if (audit === 'geometry-unverified') {
    return geometryUnverifiedWhereSql(
      sql,
      sql.unsafe(`payload->'${TERMINAL_COMPLETION_EVIDENCE_KEY}'->'filesChanged'`),
      sql.unsafe(`payload->'${TERMINAL_COMPLETION_EVIDENCE_KEY}'->>'verifiedHow'`),
    );
  }
  if (audit === 'intermittent-underevidenced') {
    return intermittentUnderevidencedWhereSql(
      sql,
      sql.unsafe('title'),
      sql.unsafe(`payload->'${TERMINAL_COMPLETION_EVIDENCE_KEY}'->>'testResult'`),
      sql.unsafe(`payload->'${TERMINAL_COMPLETION_EVIDENCE_KEY}'->>'testsRun'`),
    );
  }
  if (audit === 'claim-since-falsified') {
    // WI-2142447: selects the sweep's own STAMP, not a re-derivation of it. See this
    // bucket's module-header paragraph for why the finding is not SQL-decidable.
    return sql`${sql.unsafe(`payload->'${COMPLETION_CLAIM_RECHECK_KEY}'->>'verdict'`)} = ${COMPLETION_CLAIM_RECHECK_REGRESSED}`;
  }
  // 'reconciler-sourced' (EI-18677799334390930, rescued by D-012 from the deleted
  // `no-evidence` branch). Keyed on the ACTOR alone — never on an evidence key — so a
  // future caller adding a well-meaning but misleading evidence stamp to the reconcile
  // write path cannot silently defeat it.
  return sql`terminal_owner = ${RECONCILER_SYSTEM_ACTOR}`;
}

/** Same fragment, for a query that aliases the table (e.g. `ei.payload`). */
export function auditPredicateSqlFor(sql: OrgSql, audit: WorkItemAudit, alias: string) {
  const col = sql.unsafe(`${alias}.payload`);
  const ref = sql.unsafe(`${alias}.terminal_completion_ref`);
  const owner = sql.unsafe(`${alias}.terminal_owner`);
  const authority = sql.unsafe(`${alias}.authority`);
  const origin = sql.unsafe(`${alias}.origin`);
  if (audit === 'worked-then-abandoned') {
    const releasedBy = sql.unsafe(`${alias}.last_released_by`);
    const releasedAt = sql.unsafe(`${alias}.last_released_at`);
    return sql`${releasedBy} IS NOT NULL AND ${releasedAt} IS NOT NULL AND ${releasedAt} < now() - make_interval(days => ${WORKED_THEN_ABANDONED_STALE_DAYS})`;
  }
  if (audit === 'no-completion-record') return sql`${ref} IS NULL AND ${authority} IS NULL`;
  if (audit === 'no-completion-record-suspicious') {
    // EI-18821460229478708: origin='local' ONLY — see auditPredicateSql's sibling branch.
    return sql`${ref} IS NULL AND ${authority} IS NULL AND ${origin} = 'local' AND (${owner} IS NULL OR NOT (${owner} = ANY(${KNOWN_SYSTEM_COMPLETION_BYPASS_IDENTITIES as string[]})))`;
  }
  if (audit === 'no-completion-record-federated') {
    return sql`${ref} IS NULL AND ${authority} IS NULL AND ${origin} = 'remote' AND (${owner} IS NULL OR NOT (${owner} = ANY(${KNOWN_SYSTEM_COMPLETION_BYPASS_IDENTITIES as string[]})))`;
  }
  if (audit === 'geometry-unverified') {
    return geometryUnverifiedWhereSql(
      sql,
      sql.unsafe(`${alias}.payload->'${TERMINAL_COMPLETION_EVIDENCE_KEY}'->'filesChanged'`),
      sql.unsafe(`${alias}.payload->'${TERMINAL_COMPLETION_EVIDENCE_KEY}'->>'verifiedHow'`),
    );
  }
  if (audit === 'intermittent-underevidenced') {
    return intermittentUnderevidencedWhereSql(
      sql,
      sql.unsafe(`${alias}.title`),
      sql.unsafe(`${alias}.payload->'${TERMINAL_COMPLETION_EVIDENCE_KEY}'->>'testResult'`),
      sql.unsafe(`${alias}.payload->'${TERMINAL_COMPLETION_EVIDENCE_KEY}'->>'testsRun'`),
    );
  }
  if (audit === 'claim-since-falsified') {
    // Same stamp-reading rule as auditPredicateSql above, aliased.
    return sql`${sql.unsafe(`${alias}.payload->'${COMPLETION_CLAIM_RECHECK_KEY}'->>'verdict'`)} = ${COMPLETION_CLAIM_RECHECK_REGRESSED}`;
  }
  // 'reconciler-sourced': same actor-keyed rule as auditPredicateSql above.
  return sql`${owner} = ${RECONCILER_SYSTEM_ACTOR}`;
}

/**
 * The COMPLETE `audit` WHERE fragment — state scope AND bucket predicate together.
 *
 * WHY THIS EXISTS, AND WHY CALL SITES MUST NOT HAND-ROLL THE STATE CLAUSE. Until
 * EI-19320339017813143 the state scope was not part of the audit's definition at all: it
 * was re-typed as a literal `state = ANY(<TERMINAL>) AND <predicate>` at ELEVEN separate
 * call sites across `work-items.ts` (list + count) and `issues-engineer.ts` (nine list /
 * count / aliased variants). That worked only while every bucket happened to share one
 * scope. The first bucket defined over OPEN rows turns it into a silent-wrong-answer
 * generator: each un-migrated site would AND a terminal-only clause onto an
 * open-only predicate and return ZERO ROWS, forever, with no error — an audit that
 * reports "nothing to see" is indistinguishable from an audit that is clean, and this
 * module's header exists because that exact confusion (EI-10867) once told a leader the
 * fleet's completions were sound while 69% of them carried no evidence.
 *
 * So the scope travels WITH the bucket, derived from {@link auditStateScope}, and the
 * only correct way to apply an `audit` filter is to call this. A caller passes its own
 * dialect — the state COLUMN name and that family's terminal-state list, which genuinely
 * differ (`status`/`TERMINAL_WORK_ITEM_STATES` vs `state`/`ISSUE_TERMINAL_STATES`) — and
 * nothing else.
 *
 * A NULL state counts as NON-terminal. `NOT (state = ANY(...))` is NULL for a NULL
 * state, which would silently drop such a row from an open-scope audit; a malformed row
 * missing its own state is exactly the kind this should surface, never hide.
 *
 * ⚠ AN OPEN SCOPE NEGATES THE CROSS-FAMILY UNION, NOT THE CALLER'S `terminalStates`.
 * The two scopes fail in OPPOSITE directions, so they cannot share one state list:
 *
 *   - TERMINAL scope asks "is this row closed?" — it uses the caller's own family list,
 *     which is what preserves every existing bucket's behaviour exactly.
 *   - OPEN scope asks "is this row NOT closed?" — and a terminal list that is too NARROW
 *     silently reclassifies closed rows as open. A false negative here hides a row; a
 *     false positive puts finished work in front of a reader as if it were abandoned.
 *
 * That is not hypothetical. `ISSUE_TERMINAL_STATES` is `resolved/closed/deprecated/done`
 * and omits `dropped`, while the cross-family union includes it. Measured live
 * 2026-08-30 before this was fixed: negating the issue-family list returned 645 rows, of
 * which **263 were in state `dropped`** — deliberately closed work, 41% of the result,
 * and the single largest category. A reader would have been handed a "these look
 * abandoned" list whose plurality had already been decided. So the open branch negates
 * {@link ANY_FAMILY_TERMINAL_STATES}: a row in a state that is terminal in EITHER family
 * is closed, whichever view the query happens to read it through.
 */
export function auditWhereSql(
  sql: OrgSql,
  audit: WorkItemAudit,
  opts: { stateColumn: string; terminalStates: readonly string[]; alias?: string },
) {
  const state = sql.unsafe(opts.alias ? `${opts.alias}.${opts.stateColumn}` : opts.stateColumn);
  const predicate = opts.alias
    ? auditPredicateSqlFor(sql, audit, opts.alias)
    : auditPredicateSql(sql, audit);
  if (auditStateScope(audit) === 'open') {
    const closed = ANY_FAMILY_TERMINAL_STATES as string[];
    return sql`((${state} IS NULL OR NOT (${state} = ANY(${closed}::text[]))) AND ${predicate})`;
  }
  return sql`(${state} = ANY(${opts.terminalStates as string[]}::text[]) AND ${predicate})`;
}

/**
 * WI-5891 — the COMPLETION-BOUNDARY hard gate the fleet leader's P-014 audit asked
 * for, as the enforceable half of the WI-5874/P-001 incident: `verifiedHow:
 * 'live-drove-ui'` was claimed while citing only two vitest runs, with no screenshot
 * artifact anywhere on the host — unit tests verify STRUCTURE, and this bug was
 * structure-passing, pixel-failing. A doc paragraph asking agents to remember to
 * screenshot next time does not bind (proven the same hour it was written); this
 * does, because `work_items:complete` calls it before it lets a close land.
 *
 * Unlike every other check in this module (and everything else in
 * `work_items:complete`, EI-24's "record-and-warn, never hard-reject" discipline),
 * THIS one is a genuine reject: a `live-drove-ui` claim that cites nothing real is
 * refused, not just flagged. That is a deliberate, narrow exception — scoped to
 * exactly one closed enum value making one specific, checkable factual claim ("I
 * drove the running UI"), not a general tightening of the completion contract.
 *
 * "Cites something real" is checked against the free-text fields an agent naturally
 * writes an artifact reference into (`testsRun`, `testResult`) and `filesChanged` (a
 * screenshot saved alongside the change) — see {@link citesScreenshotArtifact} for the
 * patterns. Pure + synchronous so the gate and its own unit test can never drift.
 */
/**
 * The `tauri-agent-tools` subcommands whose recorded invocation counts as a real artifact
 * citation. EXPORTED as the single source of truth so `/internal/docs/testing/agent-e2e`
 * can be asserted in sync with this gate (EI-19425652963178450): an agent plans its drive
 * from that doc but only meets this predicate at CLOSE time, by which point an isolated
 * shell has been torn down — so a doc that names a subcommand this list does not accept
 * (or omits one it does) costs a second full boot to discover. `eval` is deliberately
 * ABSENT: it returns a value and exits 0 whether or not the assertion held, so an `eval`
 * transcript is not falsifiable evidence.
 */
export const LIVE_DROVE_UI_EVIDENCE_SUBCOMMANDS = ['capture', 'screenshot', 'check'] as const;

const SCREENSHOT_ARTIFACT_PATTERNS: readonly RegExp[] = [
  // An image artifact path — a screenshot/capture output file.
  // PPM is the canonical raw-pixel output of the vmctl desktop verifier.  The
  // artifact inspector deliberately fails open for formats it cannot decode, so
  // recognizing this path here preserves the evidence instead of rejecting a
  // genuine capture at the text gate.
  /[\w./-]+\.(?:png|jpe?g|webp|gif|ppm)\b/i,
  // A tauri-agent-tools invocation recorded in the run — built FROM the exported list
  // above so the accepted set cannot drift from what the doc (and its guard test) claim.
  // e.g. "tauri-agent-tools capture -o /tmp/fail-route" (it takes a DIRECTORY via
  // `-o`/`--output`; there is no `--out` — verified against `tauri-agent-tools help capture`).
  new RegExp(String.raw`\btauri-agent-tools\b[^\n]{0,80}\b(?:${LIVE_DROVE_UI_EVIDENCE_SUBCOMMANDS.join('|')})\b`, 'i'),
  // A bare "screenshot"/"capture" mention paired with an image path in the same clause.
  /\b(?:screenshot|capture)\b[^\n]{0,80}\.(?:png|jpe?g|webp|gif|ppm)\b/i,
];

/** Does this piece of completion text cite a real screenshot/capture artifact? */
export function citesScreenshotArtifact(text: string | null | undefined): boolean {
  if (!text) return false;
  const t = text.trim();
  if (!t) return false;
  return SCREENSHOT_ARTIFACT_PATTERNS.some((re) => re.test(t));
}

/**
 * Is a `verifiedHow: 'live-drove-ui'` claim BACKED by a real artifact citation?
 * Returns `true` (nothing to enforce) for every OTHER `verifiedHow` value, including
 * absent — this gate is scoped narrowly to the one enum member making the specific
 * factual claim "I drove the running UI and looked at it".
 *
 * This is the TEXT-level half of the gate and is deliberately kept as-is: it asks only
 * whether an artifact was cited at all. Whether that artifact is REAL is
 * {@link verifyLiveDroveUiArtifacts}, which is what `work_items:complete` calls.
 */
export function isBackedLiveDroveUiClaim(evidence: CompletionVerificationEvidence | null | undefined): boolean {
  if (!evidence || evidence.verifiedHow !== 'live-drove-ui') return true;
  if (citesScreenshotArtifact(evidence.summary)) return true;
  if (citesScreenshotArtifact(evidence.testsRun)) return true;
  if (citesScreenshotArtifact(evidence.testResult)) return true;
  if (evidence.filesChanged?.some((f) => citesScreenshotArtifact(f))) return true;
  // EI-18855312333744373: a deployed URL + HTTP status (e.g. `https://x.com/about ->
  // 200`) is just as real a citation as a screenshot path — a web-deploy verification
  // naturally has no image file to name at all. citesWebProbeEvidence is defined below
  // in this module as a `function` declaration, so it is hoisted and safe to call here.
  if (citesWebProbeEvidence(evidence)) return true;
  // EI-20411096292493737: a recorded browser-driver run against an http(s) target is the
  // web counterpart of `tauri-agent-tools check` — it asserts, so it could have failed.
  // Defined below as a `function` declaration, hoisted, same as citesWebProbeEvidence.
  if (citesBrowserDriveEvidence(evidence)) return true;
  return false;
}

/**
 * EI-20096763429995249 — is a `verifiedHow: 'live-service'` claim backed by
 * evidence from a real running process/service rather than by a test suite wearing
 * a stronger label?
 *
 * The two required facts may be split across `testsRun` and `testResult` because
 * callers naturally put the command in one and its observations in the other:
 *
 *  1. a concrete service/unit/process identity; and
 *  2. a falsifiable runtime observation (`MainPID`, `NRestarts`, `ActiveState`, or
 *     an HTTP response status).
 *
 * Summary prose and `filesChanged` deliberately do not count. They cannot show what
 * runtime check ran or what it observed, and accepting them would make the label as
 * unauditable as the `integration` label this one was introduced to distinguish.
 * Returns true for every other `verifiedHow` value so callers can compose this with
 * the existing label-specific guards without changing their scope.
 */
export function isBackedLiveServiceClaim(
  evidence: CompletionVerificationEvidence | null | undefined,
): boolean {
  if (!evidence || evidence.verifiedHow !== 'live-service') return true;

  const runtimeEvidence = [evidence.testsRun, evidence.testResult]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join('\n');
  if (!runtimeEvidence) return false;

  const namesConcreteService = [
    // Canonical systemd unit identity, including templated units.
    /\b[\w@.-]+\.service\b/i,
    // Other supervisors/process managers still need a named runtime target.
    /\b(?:service|systemd\s+unit|unit|daemon|process)\s+(?:named\s+)?[`'"]?[\w@./:-]{2,}/i,
    /\b(?:service|unit|daemon|process)\s*[:=]\s*[`'"]?[\w@./:-]{2,}/i,
  ].some((pattern) => pattern.test(runtimeEvidence));

  const citesFalsifiableObservation = [
    /\bMainPID\s*(?:=|:)\s*\d+\b/i,
    /\bNRestarts\s*(?:=|:)\s*\d+\b/i,
    /\bActiveState\s*(?:=|:)\s*(?:active|inactive|failed|activating|deactivating)\b/i,
    /\bHTTP(?:\/\d(?:\.\d)?)?(?:\s+status)?\s*(?:=|:)?\s*[1-5]\d{2}\b/i,
    // curl's documented `-w "%{http_code}"` idiom naturally produces
    // `http_status=200` / `http_code=200`; the general HTTP alternatives above
    // allow whitespace before `status`, but cannot consume this suffix separator.
    /\bHTTP[_-](?:status|code)\s*(?:=|:)\s*[1-5]\d{2}\b/i,
    /\b(?:GET|HEAD|POST|PUT|PATCH|DELETE)\s+\S+[^\n]{0,80}(?:->|→|returned|status)\s*[1-5]\d{2}\b/i,
    /https?:\/\/\S+[^\n]{0,80}(?:->|→|returned|status)\s*[1-5]\d{2}\b/i,
  ].some((pattern) => pattern.test(runtimeEvidence));

  return namesConcreteService && citesFalsifiableObservation;
}

/**
 * EI-18797014705631713 — the hole the text-level gate above left open, and the reason
 * it is not enough on its own.
 *
 * `tauri-agent-tools screenshot` writes a valid PNG, prints its path and exits 0 even
 * when the window it grabbed never painted — a known trap on this box, which
 * `verify-tauri-headless.sh` already warns about at launch ("no real GPU GL detected —
 * screenshots will be blank"). So the strongest-looking evidence type is the easiest
 * one to produce accidentally: an agent runs the capture, never opens the file, cites
 * the path, and the close is ACCEPTED having verified no pixels whatsoever. That is
 * precisely the failure WI-5891 was built to stop, now carrying a paper trail that
 * looks rigorous. The reporter only escaped it by opening the image by hand; nothing
 * required that. Scanning this host found 4 such captures already on disk — including
 * a 91KB, 1280x800 file (`/tmp/wi6352-attached-to-pill-resolves.png`) that is nothing
 * but a dark gradient, which is also why file SIZE cannot stand in for this check.
 *
 * Two citation kinds, judged differently — the distinction the reporter drew, and the
 * right one:
 *
 *  - An ASSERTION-BEARING invocation (`tauri-agent-tools check --eval …`) states a
 *    proposition and exits non-zero when it is false. It is falsifiable on its face, so
 *    it needs no artifact on disk. This is the cheaper AND stronger path, and the
 *    rejection text points at it.
 *  - A bare IMAGE PATH asserts nothing. `screenshot` and `capture` both fall here —
 *    neither can fail — so the file itself has to be produced and inspected.
 *
 * Fail-open everywhere the evidence is merely unclear: an unreadable file, a format the
 * detector does not decode, a bare filename with no directory that resolves nowhere.
 * A close is refused ONLY when every cited artifact is confidently bad — decoded and
 * empty, or a real path that is not on disk. The cost of a wrong rejection is a blocked
 * close on work that was genuinely done, so the burden sits on this function to be sure.
 */
export type CitedArtifactStatus =
  /** Decoded, carries rendered pixels — real evidence. */
  | 'content'
  /** Decoded, carries nothing — the window did not paint. */
  | 'blank'
  /** A path with a directory in it that is not on disk. */
  | 'missing'
  /** A bare filename that resolved nowhere — location unknowable, not a confident miss. */
  | 'unresolvable'
  /** On disk but unreadable, oversized, or not a format the detector decodes. */
  | 'unjudged';

export interface CitedArtifact {
  /** The path exactly as it appeared in the completion text. */
  cited: string;
  /** Absolute path it resolved to, when one could be formed. */
  resolved: string | null;
  status: CitedArtifactStatus;
  /** Human-readable detail — the blankness reason, or why it could not be judged. */
  detail?: string;
  /**
   * EI-18822892068318552: every base a RELATIVE citation was tried against, absolute.
   * Populated only when the citation was relative (an absolute path has exactly one
   * candidate and needs no explaining). Carried so a `missing` verdict can SAY where it
   * looked instead of asserting a flat non-existence the reporter can disprove in one `ls`.
   */
  basesTried?: string[];
}

export interface LiveDroveUiArtifactVerdict {
  /** May this close land? */
  ok: boolean;
  /** What carried it (or would have): a falsifiable assertion, or a real image. */
  basis: 'not-applicable' | 'assertion' | 'url' | 'image' | 'none';
  /** Populated only when `ok` is false — the rejection text, ready to show. */
  reason?: string;
  artifacts: CitedArtifact[];
}

/** Anything past this is not worth reading into memory to judge blankness. */
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;

/**
 * `tauri-agent-tools check` is the only subcommand that ASSERTS something — it takes an
 * `--eval`/`--text` proposition and exits non-zero when it does not hold. `screenshot`
 * and `capture` produce output and always succeed, so citing them proves only that a
 * command ran.
 */
const ASSERTION_BEARING_PATTERN = /\btauri-agent-tools\b[^\n]{0,80}\bcheck\b/i;

// Match a path TOKEN, not merely its ASCII suffix. Playwright keeps Unicode from
// test titles in result-directory names (for example `...-×/test-failed-1.png`);
// `\w` stops at that character and used to turn the real relative citation into
// `/test-failed-1.png`. Whitespace/quotes delimit tokens, while the small ASCII
// wrapper set keeps prose such as `--output=/tmp/shot.png` and `(/tmp/shot.png)`
// compatible with the pre-existing extraction shape.
const IMAGE_PATH_PATTERN = /[^\s"'`<>=()\[\]{},;:]+?\.(?:png|jpe?g|webp|gif|ppm)\b/giu;

/** An HTTP status code immediately following a citation, e.g. `-> 200` or `200 OK`. */
const HTTP_STATUS_AFTER_PATTERN = /^\s*(?:->|→)?\s*\d{3}\b/;

/**
 * EI-18855312333744373 — is this citation a URL PATH from an HTTP probe transcript,
 * rather than a filesystem path? `/me.jpg -> 200 (121,060 B)` is exactly what a
 * `verdict`/curl probe against a deployed site prints, and it is honest, real
 * `live-drove-ui` evidence — but read as a bare token it looks identical to a
 * filesystem citation, and stat()ing it locally will always report "does not exist"
 * because it was never a local path.
 *
 * Deliberately narrow (adjacency, not "the whole line/field mentions a URL somewhere"
 * — that reading is too coarse: `"...reference shot at https://example.com/x.png and
 * /tmp/real.png"` cites a URL and a genuine local path in the SAME line, and a
 * whole-line heuristic would wrongly launder the local one too). Two signals, either
 * is enough, both scoped to right where the citation itself sits:
 *  - the match itself begins at the `//` of a URL scheme (pre-existing check: catches
 *    `https://x.com/a.png` resolving as `x.com/a.png`);
 *  - the citation is immediately followed by an HTTP status code (`-> 200`, `200 OK`)
 *    — the signature of a probe RESULT line, e.g. `` `/me.jpg` -> 200 (121,060 B) ``.
 */
function isUrlProbeCitation(source: string, matchText: string, matchIndex: number): boolean {
  // `/` is a path character, so a URL match STARTS at the `//` of its scheme rather
  // than after it — hence both checks (pre-existing: catches `https://x.com/a.png`).
  const before = source.slice(Math.max(0, matchIndex - 3), matchIndex);
  if (matchText.startsWith('//') || before.includes('//')) return true;

  const after = source.slice(matchIndex + matchText.length, matchIndex + matchText.length + 12);
  return HTTP_STATUS_AFTER_PATTERN.test(after);
}

/**
 * Every image path cited anywhere in the evidence, de-duplicated, order preserved.
 *
 * A URL — or a bare path that is part of the same HTTP-probe transcript as one — is
 * skipped rather than resolved: `https://example.com/a.png` would otherwise match as
 * `example.com/a.png`, resolve to a local path that is obviously not there, and be
 * reported as a confidently-missing artifact. It is not missing — it was never local.
 * Same principle as everywhere else here: only condemn what we can actually judge.
 * See {@link isUrlProbeCitation}.
 */
export function citedImagePaths(evidence: CompletionVerificationEvidence | null | undefined): string[] {
  if (!evidence) return [];
  const found = new Set<string>();
  const sources = [evidence.summary, evidence.testsRun, evidence.testResult, ...(evidence.filesChanged ?? [])];
  for (const source of sources) {
    if (!source) continue;
    for (const match of source.matchAll(IMAGE_PATH_PATTERN)) {
      const index = match.index ?? 0;
      if (isUrlProbeCitation(source, match[0], index)) continue;
      found.add(match[0]);
    }
  }
  return [...found];
}

/** Does the evidence cite an invocation that could have failed? */
export function citesAssertionBearingRun(evidence: CompletionVerificationEvidence | null | undefined): boolean {
  if (!evidence) return false;
  return [evidence.summary, evidence.testsRun, evidence.testResult, ...(evidence.filesChanged ?? [])].some(
    (text) => !!text && ASSERTION_BEARING_PATTERN.test(text),
  );
}

/**
 * A deployed URL paired with an HTTP status code — e.g. `` https://papercusp.com/about
 * -> 200 `` or `` `/me.jpg` -> 200 (121,060 B) `` — is falsifiable live-UI evidence in
 * its own right: the status could have come back 404/500, so citing it proves a real
 * request against the running deployment returned something, not merely that a
 * command ran. This is the web-deploy equivalent of {@link citesAssertionBearingRun}
 * (EI-18855312333744373).
 *
 * Scoped to text that names an actual `http(s)://` URL somewhere — a bare
 * `/me.jpg -> 200` with no URL anywhere in the evidence is ambiguous enough (it could
 * be an unrelated status-shaped number) that it is left to the image-path checks below
 * instead of being accepted outright here.
 */
const WEB_PROBE_STATUS_PATTERN = /(?:https?:\/\/\S+|`?[\w./~-]+\.\w+`?)\s*(?:->|→)?\s*\b[1-5]\d{2}\b/i;

export function citesWebProbeEvidence(evidence: CompletionVerificationEvidence | null | undefined): boolean {
  if (!evidence) return false;
  return [evidence.summary, evidence.testsRun, evidence.testResult, ...(evidence.filesChanged ?? [])].some(
    (text) => !!text && /https?:\/\//i.test(text) && WEB_PROBE_STATUS_PATTERN.test(text),
  );
}

/**
 * EI-20411096292493737 — the WEB-target counterpart of `tauri-agent-tools check`.
 *
 * A recorded browser-driver run (`npx playwright test e2e/x.spec.ts`, `verdict check …`)
 * is falsifiable for exactly the reason {@link citesAssertionBearingRun} accepts `check`
 * and rejects `screenshot`/`capture`: it ASSERTS, so it exits non-zero when the assertion
 * does not hold. Citing one proves a real browser drove a real target and the assertions
 * held — which is the whole factual content of the `live-drove-ui` label.
 *
 * WHY THIS EXISTS AT ALL. Before it, the accepted-artifact set was Tauri-shaped, so an
 * agent who genuinely drove a deployed WEB app had no truthful label: the gate's own
 * message offered `'unit'` (false — a real browser ran), `'integration'` (false — no
 * integration harness) and `'manual'` (false — nothing was hand-driven). A taxonomy whose
 * only reachable labels are all wrong does not produce rejections; it produces quietly
 * mislabelled `verifiedHow` values, corrupting the exact ledger the gate exists to
 * protect. The filer's own words: "the taxonomy hole rewards mislabelling."
 *
 * DELIBERATELY NOT A WEAKENING. Both halves are required, in the same evidence:
 *  - a driver INVOCATION — the run subcommand must IMMEDIATELY follow the driver name,
 *    so `npx playwright test e2e/x.spec.ts` matches while the ordinary prose sentences
 *    that name the tool ("we use Playwright for e2e", "a 13-check Playwright suite") do
 *    not. A wider window was tried first and is wrong: `playwright` is a common word in
 *    completion narrative, unlike the `tauri-agent-tools` binary, so a loose match would
 *    accept any close that merely MENTIONS the tool; and
 *  - an `http(s)://` target, so a driver run against a local fixture — which asserts
 *    structure, not a live deployment — is not silently upgraded to a live-drive claim.
 * A `screenshot`-only browser run still has to cite its image, exactly as before.
 */
const BROWSER_DRIVE_RUN_PATTERN = /\b(?:playwright|puppeteer|verdict)\b\s+(?:test|check|run|e2e|spec)\b/i;

export function citesBrowserDriveEvidence(
  evidence: CompletionVerificationEvidence | null | undefined,
): boolean {
  if (!evidence) return false;
  const texts = [
    evidence.summary,
    evidence.testsRun,
    evidence.testResult,
    ...(evidence.filesChanged ?? []),
  ].filter((text): text is string => !!text);
  if (!texts.some((text) => BROWSER_DRIVE_RUN_PATTERN.test(text))) return false;
  return texts.some((text) => /https?:\/\//i.test(text));
}

/**
 * EI-18822892068318552 — why a relative citation gets MORE than one candidate base.
 *
 * Agents write paths the way this repo writes paths: repo-relative
 * (`.papercusp-artifacts/wi6443-experiments.png`). The operator process's cwd is NOT
 * the repo root, so resolving against `process.cwd()` alone reported a real, correct,
 * already-inspected capture as "does not exist". That is the worst possible false
 * negative for this particular gate: the flat non-existence claim reads as "your capture
 * silently failed" (sending the reporter to re-run a ~2min harness boot for a file that
 * was already right there), and the CHEAPEST way to make the error go away is to
 * downgrade `verifiedHow` to `'manual'` — the exact under-claiming the gate exists to
 * prevent. A guard whose easiest escape is weakening your own evidence is mis-calibrated.
 *
 * Order matters and is deliberate: cwd FIRST, so nothing that resolved before resolves
 * differently now, then the explicit environment pointers and git-root walk —
 *  - `PAPERCUSP_REPO_ROOT`, the explicit pointer console-launcher stamps on every spawned
 *    agent (EI-10938) and therefore the most authoritative when present;
 *  - `PAPERCUSP_INTEGRATION_ROOT`, the operator/release pipeline's explicit pointer to
 *    the canonical staging tree when the process itself runs from a release checkout;
 *  - a git-root walk up from cwd, via the shared {@link hasValidGitEntry} (WI-4722: a
 *    stray empty `.git` must not pass), for hosts/processes that carry no such env.
 *
 * Widening the search can only turn a `missing` into a real judgement — it never
 * condemns something it previously accepted.
 */
export function artifactResolutionBases(cwd: string): string[] {
  const bases: string[] = [resolvePath(cwd)];
  const add = (dir: string | null | undefined): void => {
    if (!dir || !dir.trim()) return;
    const abs = resolvePath(dir.trim());
    if (!bases.includes(abs)) bases.push(abs);
  };

  add(process.env.PAPERCUSP_REPO_ROOT);
  add(process.env.PAPERCUSP_INTEGRATION_ROOT);

  let dir = resolvePath(cwd);
  for (let i = 0; i < 16; i += 1) {
    if (hasValidGitEntry(dir)) {
      add(dir);
      break;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return bases;
}

async function inspectCitedArtifact(cited: string, cwd: string): Promise<CitedArtifact> {
  // `~/shot.png` is a perfectly ordinary way to write a path down; expanding it here is
  // the difference between judging the real file and condemning a path that never existed.
  const expanded = cited.startsWith('~/') ? resolvePath(homedir(), cited.slice(2)) : cited;
  const hasDirectory = expanded.includes('/');
  if (!isAbsolute(expanded) && !hasDirectory) {
    return { cited, resolved: null, status: 'unresolvable', detail: 'bare filename — no directory to resolve against' };
  }

  // An absolute citation has exactly one candidate; a relative one is tried against each
  // base in turn (see artifactResolutionBases) and the FIRST that holds a regular file wins.
  const absolute = isAbsolute(expanded);
  const bases = absolute ? [] : artifactResolutionBases(cwd);
  const candidates = absolute ? [expanded] : bases.map((base) => resolvePath(base, expanded));
  const basesTried = absolute ? undefined : bases;

  let resolved: string | null = null;
  let size = 0;
  let sawNonFile = false;
  for (const candidate of candidates) {
    try {
      const info = await stat(candidate);
      if (!info.isFile()) {
        sawNonFile = true;
        continue;
      }
      resolved = candidate;
      size = info.size;
      break;
    } catch {
      // keep looking — a miss under one base says nothing about the others
    }
  }

  if (!resolved) {
    // Report the first candidate as `resolved` so existing readers still get a concrete
    // path, and let `basesTried` carry the rest.
    const shown = candidates[0] ?? null;
    if (sawNonFile) return { cited, resolved: shown, status: 'unjudged', detail: 'not a regular file', basesTried };
    return { cited, resolved: shown, status: 'missing', detail: 'no such file on this host', basesTried };
  }

  if (size === 0) {
    return { cited, resolved, status: 'blank', detail: 'the capture wrote an empty (0-byte) file' };
  }
  if (size > MAX_ARTIFACT_BYTES) {
    return { cited, resolved, status: 'unjudged', detail: `too large to inspect (${size} bytes)` };
  }

  let bytes: Buffer;
  try {
    bytes = await readFile(resolved);
  } catch (e) {
    return { cited, resolved, status: 'unjudged', detail: `unreadable: ${(e as Error).message}` };
  }

  const report = analyzeImageBlankness(new Uint8Array(bytes));
  if (report.verdict === 'blank') return { cited, resolved, status: 'blank', detail: report.reason };
  if (report.verdict === 'has-content') return { cited, resolved, status: 'content', detail: report.reason };
  return { cited, resolved, status: 'unjudged', detail: report.reason };
}

/**
 * The artifact half of the `live-drove-ui` gate — see the block comment above for what
 * it refuses and, more importantly, what it deliberately lets through.
 */
export async function verifyLiveDroveUiArtifacts(
  evidence: CompletionVerificationEvidence | null | undefined,
  opts: { cwd?: string } = {},
): Promise<LiveDroveUiArtifactVerdict> {
  if (!evidence || evidence.verifiedHow !== 'live-drove-ui') {
    return { ok: true, basis: 'not-applicable', artifacts: [] };
  }
  // A falsifiable run stands on its own: it had to assert something to exit 0.
  if (citesAssertionBearingRun(evidence)) return { ok: true, basis: 'assertion', artifacts: [] };
  // Same logic, web-deploy shaped: a URL + HTTP status is falsifiable too (EI-18855312333744373).
  if (citesWebProbeEvidence(evidence)) return { ok: true, basis: 'url', artifacts: [] };
  // Same logic again, browser-driver shaped: an asserting run against a live URL could
  // have exited non-zero, so it stands on its own with no image to inspect
  // (EI-20411096292493737). Reported as `assertion` because that is what it is.
  if (citesBrowserDriveEvidence(evidence)) return { ok: true, basis: 'assertion', artifacts: [] };

  const paths = citedImagePaths(evidence);
  if (paths.length === 0) {
    // Reachable in a way worth naming precisely: the text gate is satisfied by the mere
    // words "tauri-agent-tools screenshot", so a run cited WITHOUT its output path lands
    // here. Nothing was falsified and nothing can be inspected, so the citation is empty.
    return {
      ok: false,
      basis: 'none',
      artifacts: [],
      reason:
        'it names a `screenshot`/`capture` run but no image path, and neither of those commands ' +
        'can fail — so nothing in this completion could have come out false',
    };
  }

  const cwd = opts.cwd ?? process.cwd();
  const artifacts = await Promise.all(paths.map((p) => inspectCitedArtifact(p, cwd)));

  // Any single artifact that is real (or that we cannot confidently condemn) carries it.
  if (artifacts.some((a) => a.status !== 'blank' && a.status !== 'missing')) {
    return { ok: true, basis: 'image', artifacts };
  }

  const blank = artifacts.filter((a) => a.status === 'blank');
  const missing = artifacts.filter((a) => a.status === 'missing');
  const parts: string[] = [];
  if (blank.length > 0) {
    parts.push(
      `${blank.length === 1 ? 'the cited capture is BLANK' : `all ${blank.length} cited captures are BLANK`}: ` +
        blank.map((a) => `${a.cited} — ${a.detail}`).join('; '),
    );
  }
  if (missing.length > 0) {
    // EI-18822892068318552: say WHERE we looked. A bare "does not exist" about a file the
    // reporter can `ls` in one command reads as a flat contradiction, so the honest
    // response to it is to distrust the gate (or to downgrade verifiedHow to silence it).
    // Naming the bases turns it into something diagnosable in the same breath.
    const where = missing
      .map((a) => {
        const bases = a.basesTried ?? [];
        if (bases.length === 0) return a.cited;
        return `${a.cited} (looked under ${bases.join(' and ')})`;
      })
      .join(', ');
    parts.push(
      `${missing.length === 1 ? 'the cited artifact does not exist' : `none of the ${missing.length} cited artifacts exist`}: ${where}`,
    );
  }
  return { ok: false, basis: 'image', artifacts, reason: parts.join(' — and ') };
}

/**
 * EI-18676290701611705 — the synthetic `terminal_completion_ref` ANY `skipCompletionGate`
 * bypass stamps when the caller supplied none. `skipCompletionGate` exists for a small,
 * TRUSTED set of non-completion transitions (watchdog auto-close, hygiene sweep,
 * orphaned-dispatch reconciliation, a tripwire revert, a bee-exit reconcile) that must
 * NOT claim a genuine completion — by design they call `setWorkItemState`/`setIssueState`
 * with `completionRef` omitted. Before this, that meant the column was written NULL, so
 * the `no-completion-record` audit (`terminal_completion_ref IS NULL`) could fire on a
 * MAJOR, human-filed bug that closed through one of these paths, with nothing left to
 * distinguish "a sanctioned system bypass" from "a bare assertion no one investigated" —
 * exactly the ambiguity a DRAIN leader hit on EI-18673480587329034 (a real, verified fix,
 * closed with both `completion` and `terminal_completion_ref` empty).
 *
 * This is deliberately NOT prose evidence — it names the bypass + the closing actor + a
 * timestamp, so the audit can never again find a bare-NULL ref for a sanctioned system
 * write, while a reader can still tell at a glance "system bypass, not a real fix"
 * rather than mistaking it for genuine verification.
 */
export function skipGateCompletionRef(by: string | null | undefined): string {
  return (
    `[SYSTEM-BYPASS] non-completion state transition by '${by ?? 'unknown'}' at ${new Date().toISOString()}` +
    ' (skipCompletionGate — not a genuine completion; see work-item-completion-integrity-2026-07-01 WI-1403)'
  );
}

/**
 * Resolve the completionRef to actually WRITE for a terminal transition: the caller's own
 * ref when non-empty, else — ONLY when `skipCompletionGate` is set — the synthetic marker
 * above, so a sanctioned bypass never leaves the column truly empty. Returns the input
 * unchanged (including null/undefined) when the gate is NOT bypassed, matching the existing
 * `completionRef ?? null` write shape exactly for every caller that already enforces the
 * completion-integrity gate before calling this.
 */
export function resolveTerminalCompletionRef(
  completionRef: string | null | undefined,
  opts: { skipCompletionGate?: boolean; by?: string | null },
): string | null | undefined {
  if (completionRef && completionRef.trim()) return completionRef;
  if (opts.skipCompletionGate) return skipGateCompletionRef(opts.by);
  return completionRef;
}
