/**
 * recurrence-escalation.ts — repeated pain becomes pressure
 * (learning-system-audit-improvements-2026-06-09 P-053 + the P-052 cross-scope half).
 *
 * Before this, a friction signature recurring over and over was just N rows the
 * digest counted — nothing changed because of the repetition. Three rules, run
 * on the triage cadence:
 *
 *   - **escalate-severity** (P-053): a signature seen ≥3 times whose newest OPEN
 *     item is still minor/nit gets bumped to major — recurrence IS severity
 *     evidence, and it un-stars the item from the per-source minor starvation.
 *   - **route-gym** (P-053): a recurring PROCESS-class item not already routed
 *     to the gym gets re-triaged decision='gym' — chronic process friction earns
 *     the positive A/B rail (D-003), not another round of recurrence-decay.
 *   - **suggest-promotion** (P-052 lite): a signature recurring across ≥2 DISTINCT
 *     scopes (operator + a harness, or two harnesses) files one kind=change
 *     capture proposing a shared lesson (insight/memory) — cross-Hive pain is
 *     exactly what belongs in the shared knowledge layer — AND stages one
 *     knowledge-pack item CANDIDATE (consume-edges P-032 / brief B-11): a draft
 *     row in lib/knowledge-packs/candidates the OWNER reviews in the Learnings
 *     view; adoption materializes it into the fleet-lessons pack, never a hive
 *     pool. Identity-file/curator promotion (the full P-052) stays future work.
 *
 * Pure planner + thin glue (the standard seam split). All actions are capped and
 * idempotent: severity bumps stop at major, gym routing skips already-routed,
 * promotion captures dedup via the normal search-first capture core, candidate
 * staging dedups structurally (UNIQUE per signature) + caps the pending queue.
 *
 * ## The population this reads is IMPROVEMENTS ONLY — deliberately (D-005)
 *
 * `defaultDeps.readItems` is `readImprovementItems`, and there is no
 * `readObservationItems` here BY DESIGN. Read that as a boundary, not as blindness:
 * this module's three rules are all WORK/TRIAGE-lane mutations (a severity bump, a
 * re-triage to `gym`, a capture filed into the improvement queue), and D-005 holds
 * that observation rows are a TIME SERIES which must never enter the work/triage
 * pipeline — `status='open'` on that lane does not mean unfinished work. Pushing
 * observations in here would re-run the 806-row bulk-close mistake D-028 records,
 * one severity bump at a time.
 *
 * **The observation lane already HAS a recurrence mechanism — a different one.**
 * Scout's corpus digest unions observations into its FRICTION lane
 * (`scout/corpus-digest-deps.ts` `friction()` returns
 * `[...improvements, ...observations, ...recurringImprovements, ...recurringObservations]`,
 * the last two fetched by id off the OCCURRENCE LEDGER precisely so high-flow rows
 * are not lost to a recency window — EI-20587312505064997). `scout/corpus-digest.ts`
 * `recurringFriction` then clusters that union into `category:'recurring-friction'`
 * meta-patterns carrying `wi:<id>` refs, which ground routed ideas
 * (`scout_routed_ideas.addresses_pattern_refs`) and ship; `observation-consumption.ts`
 * stamps what was read and `scout/observation-impact-leg.ts` shows the filer the
 * observation → pattern → idea → shipped arc.
 *
 * So "a recurring observation can never escalate, route, or promote" is FALSE — it
 * does all three, through Scout, not through here. Do not "fix" the asymmetry by
 * wiring `readObservationItems` into `deps.readItems`: that both violates D-005 and
 * duplicates clustering Scout already does. This paragraph exists because the
 * asymmetry was twice read as a defect and filed as a bug (WI-10002069, dropped
 * 2026-09-20 with this measurement); the boundary is pinned by
 * `observation-lane-identity.test.ts`.
 */

import { updateIssue, commentIssue } from '../../issues-engineer';
import { coordScopeWorkspace } from '../../agent-tools/coordination/log';
import {
  readRecurringInstanceEvidence,
  type RecurringInstanceEvidenceArgs,
  type RecurringInstanceEvidenceRow,
} from '../../issue-occurrence-ledger';
import type { ImprovementCandidate, ImprovementSeverity } from './policy';
import {
  readImprovementItems,
  projectImprovementItemsForBoundedRead,
  type ReadImprovementOpts,
} from './read-items';
import { signatureRecurrence, type SignatureRecurrence } from './digest';
import { classifyIdeaType } from './triage';
import { applyTriageDecision, type ApplyTriageInput, type ApplyTriageResult } from './triage-core';
import { captureImprovement, type CaptureImprovementInput, type CaptureImprovementResult } from './capture-core';
import {
  stageKnowledgePackCandidate,
  type StageCandidateInput,
  type StageCandidateResult,
} from '../../knowledge-packs/candidates';

export const RECURRENCE_ESCALATION_THRESHOLD = 3;

/** Actions produced per run when the caller does not say. */
export const DEFAULT_MAX_ACTIONS = 10;

// ── Instance-evidence severity PROPOSALS (EI-23768242440859949) ─────────────────────
//
// The signature path above learns from "N separate filings of one friction". It is blind
// to the other recurrence channel: ONE canonical item that keeps being re-reported (dedup /
// coalesce rows in `work_item_occurrences`). Its severity stays at the filer's n=1
// impression however many independent reporters hit it.
//
// This channel PROPOSES, it does not apply. Measured 2026-10-01 over the 232–233 open
// minor/nit items: the lifetime gate (≥3 rows ∧ ≥2 reporters) passed ~182 (~80%) and even
// a 7-day window passed ~105, because most of the corpus is watchdog-fed and "still firing"
// is the common case. A silent bulk apply would flip ~100 items to `major` at once — the
// severity-inflation failure the idea itself warns about. So: a ranked slate, capped per
// tick, one audited comment per item carrying the evidence, idempotent by marker comment.
// A human (or a later reviewed policy) makes the actual re-grade.
//
// NOT YET FALSIFIED: the idea's backfill ("does prior recurrence predict later manual
// re-grades / slow assignment?") could not be run — no severity-change history exists, and
// among 71 recent assigned items only 7 had ≥2 prior ledger rows. The proposal comments are
// the ledger that makes that test runnable; do not promote this to auto-apply without it.
export const INSTANCE_EVIDENCE_WINDOW_DAYS = 7;
export const INSTANCE_EVIDENCE_MIN_ROWS = 3;
export const INSTANCE_EVIDENCE_MIN_REPORTERS = 2;
/** Proposals posted per run — a bound on tick fan-out, not a statement about the population. */
export const INSTANCE_EVIDENCE_MAX_PROPOSALS = 5;
/** Body prefix of the audited proposal comment; the reader excludes items already carrying one. */
export const INSTANCE_EVIDENCE_MARKER = 'recurrence-evidence:';

/**
 * Hydration budget for phase 2, in member rows. Groups are taken whole-or-not-at-all
 * (the loop BREAKS rather than truncating), because a partially hydrated group would
 * make `sig.count` under-report — and that count is both the ≥3 threshold test and the
 * number quoted to the owner in "recurred N×".
 *
 * Declared BEFORE {@link RECURRING_SIGNATURE_SCAN_CAP} because that cap is derived
 * from this one; `const` is in the temporal dead zone until initialised, so the
 * ordering here is load-bearing, not cosmetic.
 */
export const RECURRING_MEMBER_HYDRATION_CAP = 2000;

/**
 * WI-1216687 — the two-phase read that makes the recurrence population a SET.
 *
 * Before this, `runRecurrenceEscalation` read `{ windowPerScope: true }` with no
 * `limit`, which `read-items.ts` defaults to 500 — the newest 500 rows PER SCOPE.
 * Measured 2026-08-30: `harness:papercusp` holds 26,608 of the 27,464 improvement
 * rows (96.9%) and its newest 500 reach back just 14.1 HOURS, against a corpus
 * spanning ~87 days. So a signature had to recur 3× inside one 14h window to be
 * counted at all, and every scope small enough to be fully covered was also too
 * small to recur. Same defect class as WI-4532's `watchdogKeyed`: a caller that
 * wants a SET and reads the newest N gets a RECENCY WINDOW.
 *
 * Raising the cap cannot fix it (the corpus grows ~1k rows/day), and reading the
 * whole corpus into memory is not an option either — measured on the live topic
 * corpus, 27,505 rows are title 2,782 kB · body 23 MB · payload 39 MB = 64 MB.
 *
 * The split: a signature is derived from the TITLE ALONE (`dedupSignature`), so
 * phase 1 censuses the whole corpus reading only cheap columns (~5 MB, no body, no
 * payload); phase 2 then hydrates FULL candidates for the members of the recurring
 * signatures only — a few hundred rows — and hands them to the unchanged planner.
 * Bodies and payload are therefore present wherever a decision actually reads them
 * (`classifyIdeaType` hays over `title + body`; `alreadyGym` reads the payload-derived
 * `ideaLifecycle`), so no classification silently drifts.
 */
/**
 * Slate-size safety bound — DERIVED from the real cost bound, never tuned by hand.
 *
 * {@link RECURRING_MEMBER_HYDRATION_CAP} is what actually bounds phase-2 cost, and it
 * bounds it correctly: by ACCUMULATED members, whole-group-at-a-time. A second, fixed
 * cap on the number of SIGNATURES is redundant with it — and because the slate is
 * ordered `count desc`, it is the redundant one that excludes PERMANENTLY. A group
 * below the cut is never hydrated, so it never enters the idempotence rotation that
 * drains the `maxActions` budget (severity bumps stop at major, gym routing skips
 * already-routed) — not on this run, and not on any future run either.
 *
 * Measured on `harness:papercusp`'s observation lane, 2026-09-06: 243 actionable
 * signatures (≥3 members, ≥1 open) holding 1,408 members in total, against this
 * 2,000-member budget. The whole actionable population FITS. The fixed cap of 50 was
 * discarding 193 of those 243 (79.4%) and raising the effective threshold from the
 * documented 3 to 7 — the count held by the 50th-ranked group — while saving nothing:
 * the top 50 spent just 597 of the 2,000 members, leaving the real bound 70% idle.
 *
 * That is the same cap the partition note above was written against, and this is the
 * assumption it closes on: "where actionable signatures alone exceed the cap they lose
 * their slot, which costs only the re-emitted `suggest-promotion` that capture dedup
 * was discarding anyway." True for the 49 actionable signatures measured then; false
 * at 243, where what is lost is 193 groups that are never hydrated at all. The bound
 * was not wrong — it was OUTGROWN, ~5× in three weeks. Deriving it is what stops it
 * being outgrown a third time.
 *
 * CEIL-divided by the threshold, because ≥3 members is the smallest qualifying group
 * and we need the smallest cap for which `cap × threshold ≥ budget` — i.e. a slate
 * that can always hold enough minimum-size groups to exhaust the member budget. Floor
 * is the tempting operator and is wrong by exactly one group: ⌊2000/3⌋ = 666 admits
 * 1,998 members, so the signature cap would still cut two members before the budget
 * did. The guard test asserts this product relation rather than the number, so the
 * off-by-one cannot come back.
 */
export const RECURRING_SIGNATURE_SCAN_CAP = Math.ceil(
  RECURRING_MEMBER_HYDRATION_CAP / RECURRENCE_ESCALATION_THRESHOLD,
);

/** Phase-1 output: everything decidable from cheap columns alone. */
export interface RecurringSignatureSlate {
  signature: string;
  count: number;
  /** Member ids, newest-first (the order `signatureRecurrence` emits). */
  memberIds: string[];
}

/**
 * Pure phase-1: which signatures clear the recurrence threshold — ACTIONABLE first,
 * then richest.
 *
 * EI-21889809467644493: this used to be a bare `.slice(0, CAP)` over
 * `signatureRecurrence`'s `count desc` ordering, justified as "keeps the strongest
 * evidence rather than an arbitrary slice". Count-desc IS strongest-evidence-first,
 * and that is precisely what turned the cap into a permanent ranking FLOOR: the
 * highest-count signatures are machine-authored templated filings that recur in the
 * hundreds ("Hive papercusp: fleet saturated with work still queued" ×357), so a
 * human- or agent-authored friction recurring 3–14× was outranked forever. Measured
 * on the live topic corpus: 414 signatures cleared the ≥3 threshold, the 50th-ranked
 * had 15 members, and 364 of 414 (87.9%) could therefore never be hydrated at all.
 * The DOCUMENTED threshold was 3; the EFFECTIVE one was ~15 and drifted upward as
 * the machine-authored clusters grew.
 *
 * The cap is not the whole story: 41 of those 50 slots were held by signatures whose
 * members are ALL terminal. Such a signature can never produce an `escalate-severity`
 * or `route-gym` action (both need `newestOpenUnclaimed`), yet it still emits a
 * `suggest-promotion` every tick — see the EI-9170 note on the capture below, which
 * records that the planner "has no memory of 'already suggested'". Those re-emissions
 * are deduped away at capture time, so the run spends its `maxActions` budget
 * producing nothing while real work waits below the cut.
 *
 * So: partition by actionability BEFORE the cap, preserving `count desc` inside each
 * group (a stable partition, not a re-sort). Measured effect on the topic corpus —
 * all 49 signatures with an open member become reachable and the effective threshold
 * returns to the documented 3.
 *
 * Fully-resolved signatures are DEPRIORITISED, not dropped: they still take any slots
 * the actionable ones leave. Where actionable signatures alone exceed the cap they
 * lose their slot, which costs only the re-emitted `suggest-promotion` that capture
 * dedup was discarding anyway.
 */
export function selectRecurringSignatures(
  all: ImprovementCandidate[],
  opts: PlanEscalationOpts = {},
): RecurringSignatureSlate[] {
  const threshold = opts.threshold ?? RECURRENCE_ESCALATION_THRESHOLD;
  const clearing = signatureRecurrence(all).filter((s) => s.count >= threshold);
  const actionable = clearing.filter((s) => s.openCount > 0);
  const exhausted = clearing.filter((s) => s.openCount === 0);
  return [...actionable, ...exhausted]
    .slice(0, RECURRING_SIGNATURE_SCAN_CAP)
    .map((s) => ({ signature: s.signature, count: s.count, memberIds: [...s.ids] }));
}

/** Cap on the draft-lesson body staged with a candidate (owner edits anyway). */
export const CANDIDATE_DRAFT_MAX_CHARS = 700;

export type EscalationAction =
  | { kind: 'escalate-severity'; id: string; from: ImprovementSeverity; to: 'major'; signature: string; count: number }
  | { kind: 'route-gym'; id: string; signature: string; count: number; reason: string }
  | {
      kind: 'suggest-promotion';
      signature: string;
      scopes: string[];
      count: number;
      sampleTitle: string;
      /** Member item ids, newest-first — candidate provenance (P-032). */
      sourceItemIds: string[];
      /** Draft lesson body for the staged candidate (newest member's body, capped). */
      draftText: string;
    };

export interface PlanEscalationOpts {
  threshold?: number;
  maxActions?: number;
}

function newestOpenUnclaimed(members: ImprovementCandidate[]): ImprovementCandidate | undefined {
  return members
    .filter((m) => (m.state ?? 'open') === 'open' && !m.assignee)
    .sort((a, b) => Date.parse(b.createdAt ?? '0') - Date.parse(a.createdAt ?? '0'))[0];
}

/** Pure: which recurring signatures warrant action? `all` spans all states. */
export function planRecurrenceEscalation(
  all: ImprovementCandidate[],
  opts: PlanEscalationOpts = {},
): EscalationAction[] {
  const threshold = opts.threshold ?? RECURRENCE_ESCALATION_THRESHOLD;
  const maxActions = opts.maxActions ?? DEFAULT_MAX_ACTIONS;
  if (maxActions <= 0) return [];

  const byId = new Map(all.map((c) => [c.id, c]));
  const recurring: SignatureRecurrence[] = signatureRecurrence(all).filter((s) => s.count >= threshold);
  const actions: EscalationAction[] = [];

  for (const sig of recurring) {
    if (actions.length >= maxActions) break;
    const members = sig.ids.map((id) => byId.get(id)).filter((c): c is ImprovementCandidate => !!c);
    const target = newestOpenUnclaimed(members);

    // P-052 lite: cross-scope recurrence → propose a shared lesson (once per sig).
    const scopes = [...new Set(members.map((m) => m.scope))];
    if (scopes.length >= 2 && members[0]) {
      const newestBody = members.find((m) => m.body?.trim())?.body?.trim();
      const draft = newestBody ?? members[0].title;
      actions.push({
        kind: 'suggest-promotion',
        signature: sig.signature,
        scopes,
        count: sig.count,
        sampleTitle: members[0].title,
        sourceItemIds: members.map((m) => m.id),
        draftText:
          draft.length > CANDIDATE_DRAFT_MAX_CHARS ? `${draft.slice(0, CANDIDATE_DRAFT_MAX_CHARS - 1)}…` : draft,
      });
    }

    if (!target) continue;

    const sev = target.severity ?? 'minor';
    if (sev === 'minor' || sev === 'nit') {
      actions.push({
        kind: 'escalate-severity',
        id: target.id,
        from: sev,
        to: 'major',
        signature: sig.signature,
        count: sig.count,
      });
    }

    // D-005 taxonomy (consume-edges P-021): the gym-A/B-able class is
    // 'process-prompt' — the gym can A/B a prompt variant, not a code bug
    // (chronic code-bugs get the severity escalation above instead).
    const ideaType = classifyIdeaType(target).type;
    const alreadyGym = target.ideaLifecycle?.triageDecision === 'gym';
    const triageable =
      !target.ideaLifecycle ||
      ['open', 'triaged', 'recurred'].includes(target.ideaLifecycle.state);
    if (ideaType === 'process-prompt' && !alreadyGym && triageable && actions.length < maxActions) {
      actions.push({
        kind: 'route-gym',
        id: target.id,
        signature: sig.signature,
        count: sig.count,
        reason: `friction signature recurred ${sig.count}× — chronic process pain earns gym A/B verification (P-053/D-003)`,
      });
    }
  }
  return actions.slice(0, maxActions);
}

export interface PlanInstanceEvidenceOpts {
  windowDays?: number;
  minRows?: number;
  minReporters?: number;
  maxProposals?: number;
}

/** A severity PROPOSAL — carries the evidence, mutates nothing. */
export interface SeverityProposal {
  kind: 'propose-severity';
  id: string;
  from: 'minor' | 'nit';
  to: 'major';
  rows: number;
  reporters: number;
  windowDays: number;
  firstAt: string;
  lastAt: string;
}

/**
 * Pure: rank the reader's slate and cap it. The gate is re-applied here even though the
 * reader already filters on it — the reader is an injectable seam, and a proposal that
 * claims "≥N reports from ≥M reporters" must be provably true of the row it describes.
 * Ranking is reporters DESC (independent corroboration beats volume — one chatty watchdog
 * can inflate `rows` alone), then rows DESC, then id for a stable order.
 */
export function planInstanceEvidenceProposals(
  slate: readonly RecurringInstanceEvidenceRow[],
  opts: PlanInstanceEvidenceOpts = {},
): SeverityProposal[] {
  const windowDays = opts.windowDays ?? INSTANCE_EVIDENCE_WINDOW_DAYS;
  const minRows = opts.minRows ?? INSTANCE_EVIDENCE_MIN_ROWS;
  const minReporters = opts.minReporters ?? INSTANCE_EVIDENCE_MIN_REPORTERS;
  const maxProposals = opts.maxProposals ?? INSTANCE_EVIDENCE_MAX_PROPOSALS;
  if (maxProposals <= 0) return [];
  const seen = new Set<string>();
  return slate
    .filter((r) => (r.severity === 'minor' || r.severity === 'nit') && r.rows >= minRows && r.reporters >= minReporters)
    .filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)))
    .sort((a, b) => b.reporters - a.reporters || b.rows - a.rows || a.id.localeCompare(b.id))
    .slice(0, maxProposals)
    .map((r) => ({
      kind: 'propose-severity' as const,
      id: r.id,
      from: r.severity,
      to: 'major' as const,
      rows: r.rows,
      reporters: r.reporters,
      windowDays,
      firstAt: r.firstAt,
      lastAt: r.lastAt,
    }));
}

/** The audited comment body. Starts with {@link INSTANCE_EVIDENCE_MARKER} — that prefix IS the idempotence key. */
export function renderSeverityProposalComment(p: SeverityProposal): string {
  return (
    `${INSTANCE_EVIDENCE_MARKER} proposed severity ${p.from}→${p.to} (NOT applied). ` +
    `${p.rows} reports from ${p.reporters} distinct reporters between ${p.firstAt} and ${p.lastAt} ` +
    `(last ${p.windowDays}d window). Severity is written once from the filer's n=1 impression; ` +
    `this is the cross-instance view. Re-grade with work_items:update { severity } if the ` +
    `recurrence is real impact, or ignore it if this is a known-benign flap — the proposal does not re-post.`
  );
}

export interface EscalationResult {
  escalated: number;
  gymRouted: number;
  promotionsSuggested: number;
  /** Instance-evidence severity proposals posted this run (comment only — severity untouched). */
  severityProposed: number;
  /** Knowledge-pack candidates staged for owner review (P-032 — fleet→pack edge). */
  candidatesStaged: number;
}

/** Injectable dependency seam (unit tests run without PG). */
export interface EscalationDeps {
  readItems: (opts?: ReadImprovementOpts) => Promise<ImprovementCandidate[]>;
  /**
   * Phase-1 whole-corpus census (WI-1216687). The seam reads unbounded and lets only
   * a caller-declared bounded projection back out, which is exactly the shape here:
   * tens of thousands of rows in, at most {@link RECURRING_SIGNATURE_SCAN_CAP}
   * signatures out.
   */
  scanCorpus: (
    opts: ReadImprovementOpts,
    projection: {
      maxRows: number;
      project: (items: readonly ImprovementCandidate[]) => RecurringSignatureSlate[];
    },
  ) => Promise<RecurringSignatureSlate[]>;
  updateIssue: (id: string, patch: { severity: 'major'; by: string }) => Promise<unknown>;
  commentIssue: (id: string, body: string, authorId?: string) => Promise<unknown>;
  applyTriage: (input: ApplyTriageInput) => Promise<ApplyTriageResult>;
  capture: (input: CaptureImprovementInput) => Promise<CaptureImprovementResult>;
  stageCandidate: (input: StageCandidateInput) => Promise<StageCandidateResult>;
  /** Occurrence-ledger slate for the instance-evidence proposals (EI-23768242440859949). */
  readInstanceEvidence: (
    q: Omit<RecurringInstanceEvidenceArgs, 'workspaceId'>,
  ) => Promise<RecurringInstanceEvidenceRow[]>;
}

const defaultDeps: EscalationDeps = {
  readItems: (opts) => readImprovementItems(opts),
  scanCorpus: (opts, projection) => projectImprovementItemsForBoundedRead(opts, projection),
  updateIssue: (id, patch) => updateIssue(id, patch),
  commentIssue,
  applyTriage: applyTriageDecision,
  capture: captureImprovement,
  stageCandidate: stageKnowledgePackCandidate,
  readInstanceEvidence: (q) => readRecurringInstanceEvidence({ workspaceId: coordScopeWorkspace(), ...q }),
};

export async function runRecurrenceEscalation(
  opts: PlanEscalationOpts = {},
  deps: EscalationDeps = defaultDeps,
): Promise<EscalationResult> {
  const maxActions = opts.maxActions ?? DEFAULT_MAX_ACTIONS;

  // PHASE 1 (WI-1216687) — census the WHOLE corpus on cheap columns. `body` is dead
  // weight here (64 MB vs ~5 MB measured), and so is the bulk of `payload` — but NOT
  // all of it: a signature is derived from the title alone ONLY for a keyless row.
  // `recurrenceGroupKey` prefers the stable `payload.watchdogKey`, so the census asks
  // for that one field back (`includeWatchdogKey`, a rebuilt one-key object — it does
  // not re-read the 39 MB column). Dropping payload wholesale here left
  // `candidate.watchdogKey` undefined for every row, which is not a type error and so
  // silently made the census count repeats on free-prose titles alone: 155 groups
  // reached the threshold where the key finds 538 (measured 2026-09-06).
  // This replaces the old `{ windowPerScope: true }` read, whose
  // undeclared `limit ?? 500` made the population the newest ~14h rather than a set.
  // WI-9454's concern — that a busy scope must not crowd small ones out of the
  // window — is subsumed rather than dropped: there is no window left to crowd.
  const slate = await deps.scanCorpus(
    { includeBody: false, includePayload: false, includeWatchdogKey: true },
    {
      maxRows: RECURRING_SIGNATURE_SCAN_CAP,
      project: (items) => selectRecurringSignatures([...items], opts),
    },
  );

  // PHASE 2 — hydrate FULL candidates (body + payload) for the members of those
  // signatures only, so the unchanged planner sees exactly the fields it always saw:
  // `classifyIdeaType` hays over `title + body`, `alreadyGym` reads the
  // payload-derived `ideaLifecycle`. Groups are all-or-nothing so `count` stays exact.
  const memberIds: string[] = [];
  for (const sig of slate) {
    if (memberIds.length + sig.memberIds.length > RECURRING_MEMBER_HYDRATION_CAP) break;
    memberIds.push(...sig.memberIds);
  }
  const all = memberIds.length
    ? await deps.readItems({ issueIds: memberIds, limit: memberIds.length })
    : [];
  const actions = planRecurrenceEscalation(all, { ...opts, maxActions });
  const result: EscalationResult = {
    escalated: 0,
    gymRouted: 0,
    promotionsSuggested: 0,
    severityProposed: 0,
    candidatesStaged: 0,
  };

  for (const a of actions) {
    if (a.kind === 'escalate-severity') {
      await deps.updateIssue(a.id, { severity: 'major', by: 'recurrence-escalation' });
      await deps.commentIssue(
        a.id,
        `⇧ Severity escalated ${a.from}→major: this friction signature recurred ${a.count}× (P-053 — recurrence is severity evidence).`,
        'recurrence-escalation',
      );
      result.escalated += 1;
    } else if (a.kind === 'route-gym') {
      const r = await deps.applyTriage({
        id: a.id,
        decision: 'gym',
        reason: a.reason,
        by: 'recurrence-escalation',
        comment: true,
      });
      if (r.ok) result.gymRouted += 1;
    } else {
      const r = await deps.capture({
        title: `Cross-harness recurring friction — promote a shared lesson: ${a.sampleTitle}`,
        kind: 'change',
        severity: 'minor',
        body:
          `The friction signature \`${a.signature}\` recurred ${a.count}× across ${a.scopes.length} scopes ` +
          `(${a.scopes.join(', ')}). Cross-Hive pain belongs in the shared knowledge layer: write an ` +
          `agent-insights runbook or a harness-scoped memory:remember covering it, then resolve this item ` +
          `(P-052 — cross-harness lesson promotion).`,
        subTopic: 'lesson-promotion',
        sourceRole: 'system',
        // NOT 'open' (EI-9170): planRecurrenceEscalation re-emits this action EVERY
        // tick the signature is still recurring across ≥2 scopes — it has no memory
        // of "already suggested," so the capture's own dedup is the only thing that
        // makes repeated re-emission idempotent (per the stageCandidate comment
        // below). dedupScope:'open' is the watchdog's regression-reopen semantic (a
        // RESOLVED dup means the bug came back, so re-file) — wrong here: resolving
        // this capture means the lesson was promoted, not that the friction stopped
        // recurring, so a resolved dup must keep blocking or the exact same
        // proposal re-files every tick forever (observed: EI-9057→9111→9167 and
        // EI-9058→9112→9168, identical titles, ~hourly). Default (omitted ⇒ 'all')
        // blocks on ANY prior state match, open or resolved.
      });
      if (r.created) result.promotionsSuggested += 1;

      // P-032 (B-11): the same cross-scope recurrence also stages ONE
      // knowledge-pack candidate for the owner's review queue. Best-effort —
      // a staging failure (PG blip) must never abort the escalation pass;
      // the planner re-emits the action next tick and the structural dedup
      // makes the retry safe.
      try {
        const staged = await deps.stageCandidate({
          signature: a.signature,
          title: a.sampleTitle,
          draftText: a.draftText,
          scopes: a.scopes,
          recurrenceCount: a.count,
          sourceItemIds: a.sourceItemIds,
        });
        if (staged.staged) result.candidatesStaged += 1;
      } catch (e) {
        console.warn(
          '[recurrence-escalation] candidate staging failed:',
          e instanceof Error ? e.message : e,
        );
      }
    }
  }

  // PHASE 3 (EI-23768242440859949) — instance-evidence severity PROPOSALS. Best-effort and
  // isolated: a ledger-read or comment failure must never abort the escalation pass above,
  // and a failed comment is simply re-proposed next tick (the reader's NOT EXISTS marker
  // check is what makes a landed one never repeat). Severity is NEVER written here.
  try {
    const slate = await deps.readInstanceEvidence({
      windowDays: INSTANCE_EVIDENCE_WINDOW_DAYS,
      minRows: INSTANCE_EVIDENCE_MIN_ROWS,
      minReporters: INSTANCE_EVIDENCE_MIN_REPORTERS,
      // Over-fetch the SQL slate relative to the post cap so the planner's own re-check of
      // the gate cannot starve the run by discarding rows from a slate that was exactly N.
      limit: INSTANCE_EVIDENCE_MAX_PROPOSALS * 4,
      proposedMarker: INSTANCE_EVIDENCE_MARKER,
    });
    for (const p of planInstanceEvidenceProposals(slate)) {
      try {
        const posted = await deps.commentIssue(p.id, renderSeverityProposalComment(p), 'recurrence-escalation');
        if (posted) result.severityProposed += 1;
      } catch (e) {
        console.warn(
          `[recurrence-escalation] severity proposal for ${p.id} failed:`,
          e instanceof Error ? e.message : e,
        );
      }
    }
  } catch (e) {
    console.warn(
      '[recurrence-escalation] instance-evidence read failed:',
      e instanceof Error ? e.message : e,
    );
  }
  return result;
}
