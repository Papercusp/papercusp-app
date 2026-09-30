/**
 * EI-19362441037986499 — WHAT SHOULD HAPPEN when a completion record arrives for a work-item
 * that is ALREADY terminal and the caller asked for no state change.
 *
 * A LEAF MODULE ON PURPOSE. The writer that acts on this decision
 * (`attachCompletionEvidenceToSettledItem` in work-items.ts) reads and writes Postgres, and
 * work-items.ts is mocked wholesale by the tool tests around it — so a decision living there
 * is only reachable through a database or a spy. The decision is the part with the subtle
 * reasoning, so it lives where it can be exercised directly, with no mocks and no PG.
 *
 * The BACKGROUND, because the shape is not self-evident: before this existed, a record-only
 * `work_items:complete` (no top-level `state`) on a row some watchdog had already auto-resolved
 * persisted NOTHING and warned NOTHING while returning ok:true with the completion echoed
 * back — evidence was written to no column, no thread post, no `updated_ts` bump. Three
 * individually-deliberate things lined up: `completion.status:'done'` can never infer a close
 * (it is the schema default), evidence is persisted only inside the branch that writes state,
 * and the "your item is not closed" warning is suppressed whenever the final state IS
 * terminal. So the agent with the most thorough evidence produced the row that read as least
 * accountable.
 */
import { isSufficientEvidence, type WorkItemCompletionAuthority } from './work-item-completion-authority';
import type { CompletionVerificationEvidence } from './coord-lifecycle/records';

export interface SettledCompletionEvidenceInput {
  /** The principal recording this completion. */
  by: string;
  terminalOwner: string | null;
  terminalCompletionRef: string | null;
  completionAuthority: WorkItemCompletionAuthority | null;
  /** The authority already computed for this call's completion record. */
  incomingCompletionAuthority: WorkItemCompletionAuthority | null | undefined;
  /**
   * The second-terminal-close writer also protects legacy owner-only records. The record-only
   * writer leaves this undefined so its existing ref-or-authority definition remains intact.
   */
  storedRecordPresent?: boolean;
  /** The completion evidence already stored on the row. */
  storedEvidence: CompletionVerificationEvidence | null | undefined;
  /** The completion evidence this call carries. */
  incomingEvidence: CompletionVerificationEvidence | null | undefined;
}

export interface SettledCompletionEvidenceDecision {
  /**
   * `recorded` — nothing was being protected, so this record becomes the row's completion
   *              record. `upgraded` — a peer's record was there and this one is strictly
   *              richer: it becomes authoritative and theirs is archived as an attestation.
   *              `attested` — a peer's record stands; this one is filed beside it.
   */
  outcome: 'recorded' | 'upgraded' | 'attested';
  /** Whether the caller's record should be INSTALLED on the row (true for the first two). */
  install: boolean;
  existingSufficient: boolean;
  incomingSufficient: boolean;
  /** Why a foreign record was superseded; null for recorded/attested outcomes. */
  upgradeBasis: 'evidence' | 'authority' | null;
}

/**
 * PURE. The whole decision, so it is falsifiable without a database.
 *
 * WHAT THIS DELIBERATELY DOES NOT DECIDE — read before "improving" it:
 *
 *  · The evidence bar is `isSufficientEvidence`, the SAME helper the state-write path uses,
 *    and it is deliberately neither restated nor re-tuned here. That bar has moved once
 *    already; a local copy of its rules would have quietly become a false description of the
 *    check it claimed to describe.
 *  · A TIE ATTESTS. Two equally-sufficient records with equal authority leave the FIRST
 *    standing, because the property being defended is "a second write must not destroy the
 *    first", not "the newest wins". The one deliberate authority tie-break is a coherent
 *    committed/validated record over proposed/invalid: the content-identity gate already made
 *    that judgement, and ignoring it would strand a clean committed record behind a dirty
 *    proposed one merely because both supplied otherwise-sufficient test fields.
 *  · A row carrying NO completion record at all (neither a completion ref nor an authority —
 *    the shape every `watchdog-auto-close` row has) gets the incoming record INSTALLED, which
 *    is exactly what the state-write path already does in that case. Nothing is being
 *    protected, so this path is not made stricter than the one beside it for no stated reason.
 */
export function classifySettledCompletionEvidence(
  input: SettledCompletionEvidenceInput,
): SettledCompletionEvidenceDecision {
  // The same two signals the second-terminal-close reshape keys on: a credited owner, PLUS a
  // ref-or-authority meaning "someone recorded a real completion here". Both must hold, and
  // the closer must be someone else, before there is a record worth defending. Keying on the
  // OWNER rather than on "would evidence be overwritten" is load-bearing: measured over the
  // 27 cross-owner second closes that motivated the original guard, the evidence-loss reading
  // covered 12 and MISSED the 15 worst — the ones that ended up mis-attributed, crediting the
  // second closer while still carrying the first closer's verification, which reads as a
  // clean well-evidenced close and passes every check we have.
  const hasStoredRecord = input.storedRecordPresent ?? Boolean(input.terminalCompletionRef || input.completionAuthority);
  const foreignRecord = hasStoredRecord && Boolean(input.terminalOwner) && input.by !== input.terminalOwner;
  const existingSufficient = isSufficientEvidence(input.storedEvidence);
  const incomingSufficient = isSufficientEvidence(input.incomingEvidence);
  if (!foreignRecord) {
    return { outcome: 'recorded', install: true, existingSufficient, incomingSufficient, upgradeBasis: null };
  }
  const evidenceUpgrade = incomingSufficient && !existingSufficient;
  const incomingAuthorityIsAuthoritative =
    input.incomingCompletionAuthority === 'committed' || input.incomingCompletionAuthority === 'validated';
  const storedAuthorityIsReplaceable = input.completionAuthority === 'proposed' || input.completionAuthority === 'invalid';
  // Authority may break only a SUFFICIENT-evidence tie. An incoherent `committed` label must
  // never make an insufficient record authoritative; the evidence bar remains the first gate.
  const authorityUpgrade =
    existingSufficient && incomingSufficient && incomingAuthorityIsAuthoritative && storedAuthorityIsReplaceable;
  const upgradeBasis = evidenceUpgrade ? 'evidence' : authorityUpgrade ? 'authority' : null;
  return {
    outcome: upgradeBasis ? 'upgraded' : 'attested',
    install: upgradeBasis !== null,
    existingSufficient,
    incomingSufficient,
    upgradeBasis,
  };
}
